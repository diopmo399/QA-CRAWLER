import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowRunReport, FlowStepReport } from '../model/flow-run.js';
import type { Issue, IssueType } from '../model/issue.js';
import { filterHeaders } from '../observers/network-trace-recorder.js';
import { redactText, redactUrl } from '../security/redactor.js';
import type {
  ActionEvidence,
  Evidence,
  EvidenceKind,
  ExecutionTarget,
  HttpExchange,
  ReproductionRun,
} from './model.js';

/**
 * LES PREUVES d'une reproduction : ce que le moteur a réellement vu (étapes, requêtes de chaque
 * fenêtre d'action, erreurs console et JavaScript, assertions, pages, captures, trace), masqué.
 * Rien n'est déduit ici, sauf le rattachement d'une requête à une étape par l'horodatage (INFERRED).
 */

/** Les types d'anomalies devenus des preuves (les requêtes en erreur deviennent des échanges). */
const ISSUE_EVIDENCE: Partial<Record<IssueType, EvidenceKind>> = {
  CONSOLE: 'CONSOLE',
  PAGE_ERROR: 'JS_ERROR',
  PAGE_CRASH: 'JS_ERROR',
  UI_ERROR: 'PAGE',
  BUSINESS_ASSERTION: 'ASSERTION',
  FUNCTIONAL: 'ASSERTION',
  DATA_CONSISTENCY: 'ASSERTION',
  FORM_VALIDATION: 'ASSERTION',
  NAVIGATION: 'PAGE',
};

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url.replace(/[?#].*$/, '');
  }
};

/** Un texte de preuve : masqué, sur une ligne quand c'est un résumé. */
const clean = (text: string): string => redactText(text);

/**
 * Les en-têtes d'une requête d'étape (network.captureBodies) : déjà réduits à la liste blanche par le moteur, ils repassent
 * par la liste blanche (un result.json ancien ou modifié n'apporte jamais un en-tête d'authentification).
 */
function headersOf<K extends 'requestHeaders' | 'responseHeaders'>(
  key: K,
  headers: Record<string, string> | undefined,
): Partial<Record<K, Record<string, string>>> {
  const kept = filterHeaders(headers);
  return kept ? ({ [key]: kept } as Partial<Record<K, Record<string, string>>>) : {};
}

/** Le chemin d'une capture relatif au dossier du run, quand elle y est. */
function relativeToRun(file: string, runDir: string | undefined): string {
  if (!runDir) return file.split(path.sep).join('/');
  const absolute = path.resolve(file);
  const root = path.resolve(runDir);
  const relative = path.relative(root, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    return relative.split(path.sep).join('/');
  return file.split(path.sep).join('/');
}

/** Le flow du scénario : celui qui porte son nom, sinon le premier du run. */
function scenarioFlow(result: ExplorationResult, scenario: string): FlowRunReport | undefined {
  return result.flows.find((flow) => flow.name === scenario) ?? result.flows[0];
}

interface StepWindow {
  index: number;
  start: number;
  end: number;
}

/**
 * Les fenêtres des étapes, estimées depuis le début du flow et les durées (les étapes s'exécutent
 * l'une après l'autre) ; l'heure réelle d'une requête capturée la corrige quand elle est plus tôt.
 */
function stepWindows(flow: FlowRunReport): StepWindow[] {
  let cursor = Date.parse(flow.startedAt);
  if (Number.isNaN(cursor)) return [];
  return flow.steps.map((step) => {
    const starts = (step.network?.requests ?? [])
      .map((request) => (request.startedAt ? Date.parse(request.startedAt) : Number.NaN))
      .filter((value) => !Number.isNaN(value));
    const start = Math.min(cursor, ...starts);
    const end = Math.max(cursor + step.durationMs, ...starts);
    cursor += step.durationMs;
    return { index: step.index, start, end };
  });
}

function stepAt(windows: readonly StepWindow[], at: string | undefined): number | undefined {
  if (!at) return undefined;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return undefined;
  return windows.find((window) => time >= window.start && time <= window.end)?.index;
}

function actionOf(
  step: FlowStepReport,
  startedAt: string | undefined,
  requestIds: string[],
  runDir?: string,
): ActionEvidence {
  return {
    index: step.index,
    kind: step.kind,
    description: clean(step.description),
    status: step.status,
    ...(step.url ? { url: redactUrl(step.url) } : {}),
    ...(startedAt ? { startedAt } : {}),
    durationMs: step.durationMs,
    ...(step.reason ? { reason: clean(step.reason) } : {}),
    ...(step.screenshot ? { screenshot: relativeToRun(step.screenshot, runDir) } : {}),
    requestIds,
  };
}

export function reproductionFromResult(input: {
  id: string;
  scenario: string;
  target: ExecutionTarget;
  environmentId?: string;
  baseUrl?: string;
  run?: string;
  runDir?: string;
  startedAt: string;
  finishedAt?: string;
  result: ExplorationResult | undefined;
  observed: string;
}): ReproductionRun {
  const { id, result, runDir } = input;
  const base: ReproductionRun = {
    id,
    startedAt: input.startedAt,
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    status: result ? 'COMPLETED' : 'FAILED',
    target: input.target,
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    ...(input.baseUrl ? { baseUrl: redactUrl(input.baseUrl) } : {}),
    scenario: input.scenario,
    ...(input.run ? { run: input.run } : {}),
    reproduced: null,
    actions: [],
    requests: [],
    evidence: [],
    screenshots: [],
  };
  const trace = runDir && existsSync(path.join(runDir, 'trace.zip')) ? 'trace.zip' : undefined;
  if (trace) base.trace = trace;
  if (!result) {
    base.error = "l'exécution n'a produit aucun résultat";
    base.symptomMatch = "aucun résultat : le symptôme n'a pas pu être comparé";
    return base;
  }

  const flow = scenarioFlow(result, input.scenario);
  const windows = flow ? stepWindows(flow) : [];
  const evidence: Evidence[] = [];
  const requests: HttpExchange[] = [];
  const screenshots = new Set<string>();
  const evidenceId = (suffix: string): string => `${id}:ev-${suffix}`;

  // Étapes → actions, leurs requêtes (OBSERVED) et leurs preuves.
  const seenPages = new Set<string>();
  for (const step of flow?.steps ?? []) {
    const window = windows.find((item) => item.index === step.index);
    const startedAt = window ? new Date(window.start).toISOString() : undefined;
    const requestIds: string[] = [];
    (step.network?.requests ?? []).forEach((request, position) => {
      const requestId = `${id}:req-${String(step.index)}-${String(position + 1)}`;
      requestIds.push(requestId);
      requests.push({
        id: requestId,
        method: request.method.toUpperCase(),
        url: clean(request.path),
        path: clean(request.path),
        ...(request.status !== undefined ? { status: request.status } : {}),
        ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
        ...(request.failure ? { failure: clean(request.failure) } : {}),
        resourceType: request.resourceType,
        ...(request.startedAt ? { startedAt: request.startedAt } : {}),
        step: step.index,
        correlation: 'OBSERVED',
        ...(request.requestBody !== undefined ? { requestBody: clean(request.requestBody) } : {}),
        ...(request.responseBody !== undefined ? { responseBody: clean(request.responseBody) } : {}),
        ...headersOf('requestHeaders', request.requestHeaders),
        ...headersOf('responseHeaders', request.responseHeaders),
      });
    });
    const action = actionOf(step, startedAt, requestIds, runDir);
    base.actions.push(action);
    evidence.push({
      id: evidenceId(`action-${String(step.index)}`),
      kind: 'ACTION',
      ...(startedAt ? { at: startedAt } : {}),
      summary: `étape ${String(step.index)} ${action.description} : ${step.status}${action.reason ? ` (${action.reason})` : ''}`,
      source: { reproduction: id, ...(input.run ? { run: input.run } : {}), step: step.index },
      data: {
        kind: step.kind,
        status: step.status,
        durationMs: step.durationMs,
        requests: requestIds.length,
      },
    });
    if ((step.status === 'FAILED' || step.status === 'BLOCKED') && step.kind === 'expect')
      evidence.push({
        id: evidenceId(`assertion-${String(step.index)}`),
        kind: 'ASSERTION',
        ...(startedAt ? { at: startedAt } : {}),
        summary: `attente non satisfaite à l'étape ${String(step.index)} : ${action.description}${action.reason ? ` — ${action.reason}` : ''}`,
        source: { reproduction: id, ...(input.run ? { run: input.run } : {}), step: step.index },
      });
    if (action.url && !seenPages.has(action.url)) {
      seenPages.add(action.url);
      evidence.push({
        id: evidenceId(`page-${String(seenPages.size)}`),
        kind: 'PAGE',
        ...(startedAt ? { at: startedAt } : {}),
        summary: `page ${pathOf(action.url)} après l'étape ${String(step.index)}`,
        source: { reproduction: id, ...(input.run ? { run: input.run } : {}), step: step.index },
        data: { url: action.url },
      });
    }
    if (action.screenshot) {
      screenshots.add(action.screenshot);
      evidence.push({
        id: evidenceId(`screenshot-${String(step.index)}`),
        kind: 'SCREENSHOT',
        ...(startedAt ? { at: startedAt } : {}),
        summary: `capture d'écran après l'étape ${String(step.index)}`,
        source: {
          reproduction: id,
          ...(input.run ? { run: input.run } : {}),
          step: step.index,
          file: action.screenshot,
        },
      });
    }
  }

  // Anomalies du run : requêtes en erreur non rattachées à une étape, erreurs console et JavaScript…
  const issues = [...result.issues].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  let extra = 0;
  for (const issue of issues) {
    const step = stepAt(windows, issue.timestamp);
    if ((issue.type === 'HTTP' || issue.type === 'REQUEST_FAILED') && issue.requestUrl) {
      const requestPath = pathOf(redactUrl(issue.requestUrl));
      const method = (issue.method ?? 'GET').toUpperCase();
      const known = requests.some(
        (request) =>
          request.path === requestPath &&
          request.method === method &&
          (issue.status === undefined || request.status === issue.status),
      );
      if (known) continue;
      extra += 1;
      requests.push({
        id: `${id}:req-x-${String(extra)}`,
        method,
        url: redactUrl(issue.requestUrl),
        path: requestPath,
        ...(issue.status !== undefined ? { status: issue.status } : {}),
        ...(issue.type === 'REQUEST_FAILED' ? { failure: clean(issue.message) } : {}),
        resourceType: issue.details?.extra?.resourceType ?? 'unknown',
        startedAt: issue.timestamp,
        ...(step !== undefined ? { step } : {}),
        correlation: step !== undefined ? 'INFERRED' : 'UNKNOWN',
      });
      continue;
    }
    const kind = ISSUE_EVIDENCE[issue.type];
    if (!kind) continue;
    evidence.push(issueEvidence(issue, kind, id, input.run, step, runDir));
    if (issue.screenshot) screenshots.add(relativeToRun(issue.screenshot, runDir));
  }
  for (const action of base.actions)
    action.requestIds.push(
      ...requests
        .filter((request) => request.correlation === 'INFERRED' && request.step === action.index)
        .map((request) => request.id),
    );

  if (trace)
    evidence.push({
      id: evidenceId('trace'),
      kind: 'TRACE',
      summary: "Trace Playwright de l'exécution (captures d'écran, instantanés du DOM, réseau)",
      source: { reproduction: id, ...(input.run ? { run: input.run } : {}), file: trace },
    });

  base.requests = requests;
  base.evidence = evidence;
  base.screenshots = [...screenshots];
  const symptom = symptomMatch(input.observed, base);
  base.reproduced = symptom.reproduced;
  base.symptomMatch = symptom.match;
  return base;
}

function issueEvidence(
  issue: Issue,
  kind: EvidenceKind,
  reproduction: string,
  run: string | undefined,
  step: number | undefined,
  runDir: string | undefined,
): Evidence {
  const details = issue.details;
  return {
    id: `${reproduction}:ev-issue-${issue.id}`,
    kind,
    at: issue.timestamp,
    summary: `${issue.type} : ${clean(issue.message)}`,
    source: {
      reproduction,
      ...(run ? { run } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(issue.screenshot ? { file: relativeToRun(issue.screenshot, runDir) } : {}),
    },
    data: {
      issueId: issue.id,
      type: issue.type,
      severity: issue.severity,
      page: redactUrl(issue.pageUrl),
      occurrences: issue.occurrences,
      ...(step !== undefined ? { correlation: 'INFERRED' } : {}),
      ...(details?.name ? { name: details.name } : {}),
      ...(details?.source ? { sourceUrl: redactUrl(details.source.url), line: details.source.line } : {}),
      ...(details?.stack ? { stack: details.stack.slice(0, 10).map(clean) } : {}),
    },
  };
}

// ── Le symptôme ──────────────────────────────────────────────────────────────────────────────

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Les statuts HTTP cités (« HTTP 500 », « erreur 500 », « 5xx », « 404 ») : un code ou une classe. */
export function statusesIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(
    /\b(?:http|erreur|error|statut|status|code|r[eé]ponse|response)\s*(?:http\s*)?:?\s*([1-5][0-9]{2}|[1-5]xx)\b/gi,
  ))
    if (match[1]) found.add(match[1].toLowerCase());
  for (const match of text.matchAll(/\b([45][0-9]{2}|[45]xx)\b/gi))
    if (match[1]) found.add(match[1].toLowerCase());
  return [...found];
}

/** Les textes cités entre guillemets (« … », "…", “…”). */
export function quotedTextsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/«\s*([^»]+?)\s*»|"([^"]+)"|“([^”]+)”/g)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (value.length >= 3) found.add(value);
  }
  return [...found];
}

const statusMatches = (expected: string, status: number): boolean =>
  expected.endsWith('xx') ? String(status).startsWith(expected.charAt(0)) : String(status) === expected;

export function symptomMatch(
  observed: string,
  run: Pick<ReproductionRun, 'actions' | 'requests' | 'evidence'>,
): { reproduced: boolean; match: string } {
  const statuses = statusesIn(observed);
  const texts = quotedTextsIn(observed);
  if (statuses.length === 0 && texts.length === 0)
    return {
      reproduced: false,
      match:
        'la description observée ne cite ni statut HTTP ni texte entre guillemets : le symptôme ne peut pas être comparé automatiquement',
    };

  const matched: string[] = [];
  for (const expected of statuses) {
    const hits = run.requests.filter(
      (request) => request.status !== undefined && statusMatches(expected, request.status),
    );
    if (hits.length > 0)
      matched.push(
        `HTTP ${expected} : ${hits
          .slice(0, 3)
          .map(
            (request) =>
              `${request.method} ${request.path} → ${String(request.status)}${request.step !== undefined ? ` (étape ${String(request.step)})` : ''}`,
          )
          .join(', ')}`,
      );
  }
  const haystack = [
    ...run.evidence.map((item) => item.summary),
    ...run.actions.flatMap((action) => [action.reason ?? '']),
    ...run.requests.flatMap((request) => [request.responseBody ?? '', request.failure ?? '']),
  ].map(fold);
  for (const text of texts)
    if (haystack.some((item) => item.includes(fold(text)))) matched.push(`texte « ${text} »`);

  if (matched.length > 0) return { reproduced: true, match: `observé : ${matched.join(' ; ')}` };
  const seen = [
    ...new Set(run.requests.map((request) => request.status).filter((status) => status !== undefined)),
  ].sort((left, right) => left - right);
  const missing = [
    ...statuses.map((status) => `HTTP ${status}`),
    ...texts.map((text) => `texte « ${text} »`),
  ].join(', ');
  return {
    reproduced: false,
    match: `non observé : ${missing}${seen.length > 0 ? ` (statuts vus : ${seen.join(', ')})` : ' (aucun statut HTTP enregistré)'}`,
  };
}

export { incidentReproduction } from './model.js';
