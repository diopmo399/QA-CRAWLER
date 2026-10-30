import path from 'node:path';
import type { ExplorationListener } from '../../explorer/flow-explorer.js';
import type { EngineLogEntry } from '../../logging/engine-log.js';
import type { FlowStepReport } from '../../model/flow-run.js';
import type { RunErrorKind, RunLogCategory, RunLogLevel, RunLogStatus } from '../core/contracts.js';
import { stepLabel, stepReason } from './explorations.js';
import type { RunLogInput } from './run-events.js';

/**
 * LES SOURCES DU JOURNAL D'UNE EXÉCUTION : ce que chaque outil dit réellement, traduit dans le contrat
 * commun (RunLogEvent). Rien n'est déduit d'un événement absent : une étape sans fin rapportée reste
 * « en cours », une action sans confirmation reste « exécutée ».
 *
 *   - le moteur (YAML, Gherkin) : ses écouteurs (début et fin d'étape, écrans, anomalies) et son journal
 *     structuré (EngineLogEntry), reçu en direct ;
 *   - le Dry Run : ses événements (intentions cherchées, trouvées, manquantes) ;
 *   - Playwright Test : un reporter qui écrit chaque étape du runner (avec sa ligne) sur la sortie ;
 *   - Java : la sortie de Maven (tests commencés, terminés) et le journal du pilote Playwright
 *     (`DEBUG=pw:api` : attente d'un élément, élément trouvé, geste fait, vérification).
 */

type Emit = (event: RunLogInput) => void;

// ── Les repères « step N » du code généré ──────────────────────────────────────────────────────

/**
 * Les étapes du code généré (Playwright, Java) : le générateur écrit `// step N` avant les lignes d'une
 * étape. Rend, pour une ligne, l'étape dont elle fait partie (undefined avant la première).
 */
export function stepOfLine(source: string): (line: number) => number | undefined {
  const lines = source.split('\n');
  const marks: { line: number; step: number }[] = [];
  lines.forEach((text, index) => {
    const match = /^\s*\/\/\s*step\s+(\d+)\b/i.exec(text);
    if (match?.[1]) marks.push({ line: index + 1, step: Number(match[1]) });
  });
  return (line) => {
    const mark = marks.filter((entry) => entry.line <= line).at(-1);
    if (!mark) return undefined;
    // Une étape s'arrête au repère suivant, ou à la fin de sa méthode (accolade fermante peu indentée).
    for (let index = mark.line; index < line; index += 1)
      if (/^\s{0,2}\}/.test(lines[index] ?? '')) return undefined;
    return mark.step;
  };
}

/**
 * Les variables d'environnement citées par des fichiers joués (mission, flow, code généré) : leurs
 * valeurs sont masquées dans le journal du run, quelles qu'elles soient.
 */
export function referencedEnvNames(texts: readonly string[]): string[] {
  const names = new Set<string>();
  const patterns = [
    /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    /\benv:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
    /\b(QA_REPRO_[A-Za-z0-9_]+)/g,
  ];
  for (const text of texts)
    for (const pattern of patterns)
      for (const match of text.matchAll(pattern)) if (match[1]) names.add(match[1]);
  return [...names];
}

/** Les valeurs de ces variables dans l'environnement du run (les courtes ne sont pas masquées : trop d'homonymes). */
export function secretValues(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const value = env[name];
    return typeof value === 'string' && value.length >= 4 ? [value] : [];
  });
}

// ── Le moteur ────────────────────────────────────────────────────────────────────────────────

const LEVEL_OF: Record<EngineLogEntry['level'], RunLogLevel> = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
  TRACE: 'DEBUG',
};

/** Les lignes du journal du moteur déjà dites par un écouteur (étapes, flows, anomalies). */
const HANDLED = new Set(['FLOW_STARTED', 'FLOW_STEP', 'FLOW_FINISHED', 'ISSUE_RAISED']);

/** La famille d'une ligne du journal du moteur, d'après son type. */
export function engineCategory(event: string): RunLogCategory {
  if (/^NAVIGATION_|^BROWSER_INTERACTION$|^AUTHENTICATED$/.test(event)) return 'BROWSER';
  if (
    /^(ORACLE_VERDICT|BUSINESS_ASSERTION|INVARIANT|DATA_INCONSISTENCY|INTENT_MATCHED|INTENT_MISMATCH|ASSERTION)/.test(
      event,
    )
  )
    return 'ASSERTION';
  if (
    /^(ACTION_|SEMANTIC_RESOLUTION|TARGET_|RECOVERY_|GOAL_RECOVERY|ROOT_CAUSE|AI_TARGET|REPLAY_|FLOW_DRIFT|STEP_)/.test(
      event,
    )
  )
    return 'ACTION';
  return 'ENGINE';
}

const BROWSER_ISSUES = new Set(['CONSOLE', 'PAGE_ERROR', 'PAGE_CRASH', 'BROWSER_INTERACTION', 'NAVIGATION']);
const NETWORK_ISSUES = new Set(['HTTP', 'REQUEST_FAILED', 'BROKEN_LINK', 'CONTRACT', 'WRITE_BLOCKED']);
const ASSERTION_ISSUES = new Set([
  'BUSINESS_ASSERTION',
  'INVARIANT',
  'FUNCTIONAL',
  'DATA_CONSISTENCY',
  'REGRESSION',
  'UI_ERROR',
]);

/** Une étape en échec : sa famille, d'après ce que le moteur en dit (statut, cible, genre d'étape). */
export function stepErrorKind(
  step: Pick<FlowStepReport, 'status' | 'kind' | 'reason' | 'suggestions' | 'onScreen' | 'effect'>,
): RunErrorKind {
  if (step.status === 'BLOCKED') return 'POLICY';
  const reason = step.reason ?? '';
  if (/page crash|target (page|closed)|browser has been closed|net::ERR_|ERR_[A-Z_]+/i.test(reason))
    return 'BROWSER';
  if (
    (step.suggestions?.length ?? 0) > 0 ||
    (step.onScreen?.length ?? 0) > 0 ||
    step.effect?.status === 'TARGET_MISMATCH' ||
    /not found|no element|could not (find|resolve)|ambiguous|strict mode|resolved to \d+ elements|introuvable/i.test(
      reason,
    )
  )
    return 'SELECTOR';
  if (step.kind === 'expect' || /expect|assert/i.test(reason)) return 'ASSERTION';
  return 'SCENARIO';
}

/** Ce qu'une étape terminée est devenue : le statut de l'opération, tel que le moteur le dit. */
export function stepStatus(
  step: Pick<FlowStepReport, 'status' | 'kind' | 'reason' | 'effect'>,
): RunLogStatus {
  switch (step.status) {
    case 'PASSED':
      // EXECUTED ≠ CONFIRMED : sans effet confirmé, l'action est seulement exécutée.
      return step.effect?.status === 'CONFIRMED' || step.kind === 'expect' ? 'CONFIRMED' : 'EXECUTED';
    case 'FAILED':
      return 'FAILED';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'MANUAL':
      return 'SKIPPED';
    default:
      // Sautée parce que le flow s'était arrêté (ou une limite atteinte) : jamais exécutée.
      return /^(flow stopped|step \d+|mission limit|start page|cancel)/i.test(step.reason ?? '')
        ? 'NOT_RUN'
        : 'SKIPPED';
  }
}

export interface EngineSourceOptions {
  emit: Emit;
  format: 'yaml' | 'gherkin';
  /** Le fichier joué (chemin sous generated/). */
  file: string;
  /** YAML : la ligne de chaque étape (position → ligne), lue dans le fichier joué. */
  stepLines?: ReadonlyMap<number, number>;
  /** Le dossier du rapport (les captures y sont rangées). */
  reportsDir: string;
  source?: string;
}

/**
 * L'écouteur du moteur et le lecteur de son journal, pour une exécution : les événements d'une étape
 * portent sa position (et sa ligne) entre son début et sa fin, tels que le moteur les annonce.
 */
export function engineSource(options: EngineSourceOptions): {
  listener: ExplorationListener;
  onLog: (entry: EngineLogEntry) => void;
  onPhase: (label: string) => void;
} {
  const source = options.source ?? 'engine';
  let current: { flow: string; step: number; line?: number } | undefined;
  let scenario: string | undefined;
  const where = (): Pick<RunLogInput, 'scenario' | 'step' | 'line' | 'file'> => ({
    file: options.file,
    ...(scenario ? { scenario } : {}),
    ...(current ? { step: current.step } : {}),
    ...(current?.line !== undefined ? { line: current.line } : {}),
  });
  const lineOf = (index: number, sourceLine?: number): number | undefined =>
    options.format === 'gherkin' ? sourceLine : options.stepLines?.get(index);
  const relativeShot = (file: string | undefined): string | undefined => {
    if (!file) return undefined;
    const relative = path.relative(path.resolve(options.reportsDir), path.resolve(file));
    return relative.startsWith('..') || path.isAbsolute(relative)
      ? undefined
      : relative.split(path.sep).join('/');
  };
  const listener: ExplorationListener = {
    onAuthenticated: (description) => {
      options.emit({
        level: 'INFO',
        category: 'BROWSER',
        type: 'AUTHENTICATED',
        source,
        message: description,
        ...where(),
      });
    },
    onState: (context, isNew) => {
      if (!isNew) return;
      options.emit({
        level: 'INFO',
        category: 'BROWSER',
        type: 'PAGE_OPENED',
        source,
        message: `${context.stateLabel} (${context.route})`,
        data: { route: context.route, title: context.title },
        ...where(),
      });
    },
    onFlowStart: (flow) => {
      scenario = flow.name;
      options.emit({
        level: 'INFO',
        category: 'ENGINE',
        type: 'SCENARIO_STARTED',
        status: 'RUNNING',
        source,
        message: `scenario "${flow.name}" started (${String(flow.steps.length)} step(s))`,
        ...where(),
      });
    },
    onFlowStepStart: (flow, step) => {
      const line = lineOf(step.index, step.sourceLine);
      current = { flow: flow.name, step: step.index, ...(line !== undefined ? { line } : {}) };
      options.emit({
        level: 'INFO',
        category: 'ACTION',
        type: 'STEP_STARTED',
        status: 'RUNNING',
        source,
        message: `step ${String(step.index)}: ${stepLabel({ kind: step.kind, description: step.description })}`,
        data: { kind: step.kind, ...(step.optional ? { optional: true } : {}) },
        ...where(),
      });
    },
    onFlowStep: (flow, step) => {
      const line = lineOf(step.index, flow.steps[step.index - 1]?.sourceLine);
      const at = {
        file: options.file,
        scenario: flow.name,
        step: step.index,
        ...(line !== undefined ? { line } : {}),
      };
      const status = stepStatus(step);
      const failed = status === 'FAILED' || status === 'BLOCKED';
      const reason = stepReason(step);
      const screenshot = relativeShot(step.screenshot);
      // Les requêtes de l'étape (chemin masqué, jamais un corps ni un en-tête), relevées par l'observateur réseau.
      for (const request of step.network?.requests ?? [])
        options.emit({
          level: request.failure || (request.status ?? 0) >= 400 ? 'WARN' : 'DEBUG',
          category: 'NETWORK',
          type: 'HTTP_REQUEST',
          source,
          message: `${request.method} ${request.path} → ${request.failure ?? (request.status !== undefined ? String(request.status) : 'no response')}`,
          ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
          data: {
            method: request.method,
            path: request.path,
            resourceType: request.resourceType,
            ...(request.status !== undefined ? { status: request.status } : {}),
          },
          ...at,
        });
      if (step.effect?.healed)
        options.emit({
          level: 'WARN',
          category: 'ACTION',
          type: 'REPAIR_SUGGESTED',
          status: 'REQUESTED',
          source,
          message: `the recorded locator did not work; the run used another one: ${step.effect.healed.from} → ${step.effect.healed.to} (a suggestion: the scenario file is not changed)`,
          ...at,
        });
      if (step.recovery)
        options.emit({
          level: step.recovery.outcome.status === 'GOAL_REACHED' ? 'WARN' : 'ERROR',
          category: 'ACTION',
          type: 'RECOVERY',
          status:
            step.recovery.outcome.status === 'GOAL_REACHED'
              ? step.recovery.nextActionVerified
                ? 'CONFIRMED'
                : 'EXECUTED'
              : 'FAILED',
          source,
          message: `recovery of "${step.recovery.originalTarget}": ${step.recovery.outcome.status}${step.recovery.selected ? ` with ${step.recovery.selected.signature}` : ''}${step.recovery.nextActionVerified ? ' · next step verified' : ''} (applied to this run only)`,
          ...at,
        });
      options.emit({
        level: failed
          ? 'ERROR'
          : status === 'EXECUTED' && step.effect && step.effect.status !== 'NOT_REQUIRED'
            ? 'WARN'
            : status === 'SKIPPED' || status === 'NOT_RUN'
              ? 'WARN'
              : 'INFO',
        category: step.kind === 'expect' ? 'ASSERTION' : 'ACTION',
        type: 'STEP_FINISHED',
        status,
        source,
        message: `step ${String(step.index)} ${step.status}: ${stepLabel(step)}${reason ? ` · ${reason}` : ''}${status === 'EXECUTED' && step.effect ? ` · effect ${step.effect.status}` : ''}`,
        durationMs: step.durationMs,
        ...(failed ? { errorKind: stepErrorKind(step) } : {}),
        ...(screenshot ? { evidence: { screenshot } } : {}),
        data: {
          kind: step.kind,
          ...(step.effect ? { execution: step.effect.execution, effect: step.effect.status } : {}),
          ...(step.effect?.locator ? { locator: step.effect.locator } : {}),
          ...(step.effect?.targetMatch ? { targetMatch: step.effect.targetMatch.verdict } : {}),
          ...(failed && step.suggestions?.length
            ? { suggestions: step.suggestions.slice(0, 3).join(' | ') }
            : {}),
          ...(failed && step.onScreen?.length ? { onScreen: step.onScreen.slice(0, 10).join(', ') } : {}),
        },
        ...at,
      });
      if (current?.step === step.index) current = undefined;
    },
    onFlowEnd: (report) => {
      options.emit({
        level: report.status === 'PASSED' ? 'INFO' : 'ERROR',
        category: 'ENGINE',
        type: 'SCENARIO_FINISHED',
        status: report.status === 'PASSED' ? 'CONFIRMED' : report.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED',
        source,
        message: `scenario "${report.name}" ${report.status} (${String(report.steps.length)} step(s))`,
        durationMs: report.durationMs,
        file: options.file,
        scenario: report.name,
      });
      scenario = undefined;
      current = undefined;
    },
    onIssue: (issue, isNew) => {
      if (!isNew) return;
      const category: RunLogCategory = BROWSER_ISSUES.has(issue.type)
        ? 'BROWSER'
        : NETWORK_ISSUES.has(issue.type)
          ? 'NETWORK'
          : ASSERTION_ISSUES.has(issue.type)
            ? 'ASSERTION'
            : 'ENGINE';
      options.emit({
        level:
          issue.severity === 'CRITICAL' || issue.severity === 'ERROR'
            ? 'ERROR'
            : issue.severity === 'WARNING'
              ? 'WARN'
              : 'INFO',
        category,
        type: `ISSUE_${issue.type}`,
        source,
        message: issue.message,
        ...(category === 'BROWSER' ? { errorKind: 'BROWSER' as const } : {}),
        data: { severity: issue.severity, issueType: issue.type },
        ...where(),
      });
    },
  };
  return {
    listener,
    onLog: (entry) => {
      if (HANDLED.has(entry.event)) return;
      options.emit({
        at: entry.at,
        level: LEVEL_OF[entry.level],
        category: engineCategory(entry.event),
        type: entry.event,
        source,
        message: entry.message,
        ...(entry.data ? { data: entry.data } : {}),
        ...where(),
      });
    },
    onPhase: (label) => {
      options.emit({ level: 'INFO', category: 'ENGINE', type: 'PHASE', source, message: label });
    },
  };
}

// ── Playwright Test ─────────────────────────────────────────────────────────────────────────

/** Le préfixe des lignes du reporter dans la sortie du runner. */
export const REPORTER_PREFIX = '\u001eQA-EVENT ';
export const REPORTER_FILE = 'qa-crawler-events-reporter.mjs';
export const RUN_CONFIG_FILE = 'qa-crawler-run.config.ts';

/**
 * Le reporter de Playwright Test posé dans la copie de l'exécution : chaque étape du runner (avec sa
 * ligne), chaque test, chaque erreur, une ligne JSON préfixée sur la sortie. Les valeurs des gestes de
 * saisie ne sont pas écrites (le titre d'un `fill` cite la valeur : il est réduit au verbe et à la cible).
 */
export const REPORTER_SOURCE = `// Written by QA-CRAWLER for this run: the steps of the Playwright Test runner, as JSON lines.
const PREFIX = ${JSON.stringify(REPORTER_PREFIX)};
const out = (event) => process.stdout.write(PREFIX + JSON.stringify({ at: new Date().toISOString(), ...event }) + '\\n');
const where = (location) => (location ? { file: String(location.file).split(/[\\\\/]/).pop(), line: location.line } : {});
const VALUE_TITLE = /^(Fill|Type|Press sequentially|Press|Select option|Set input files|Check|Uncheck)\\b\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\[[^\\]]*\\])?\\s*/;
const title = (text) => {
  const match = VALUE_TITLE.exec(text);
  return match ? match[1] + ' ' + text.slice(match[0].length) : text;
};
const name = (test) => test.titlePath().filter(Boolean).slice(-2).join(' › ');
export default class QaCrawlerEvents {
  printsToStdio() { return false; }
  onBegin(_config, suite) { out({ type: 'begin', tests: suite.allTests().length }); }
  onTestBegin(test) { out({ type: 'test-begin', test: name(test), ...where(test.location) }); }
  onStepBegin(test, _result, step) { out({ type: 'step-begin', test: name(test), category: step.category, title: title(step.title), ...where(step.location) }); }
  onStepEnd(test, _result, step) { out({ type: 'step-end', test: name(test), category: step.category, title: title(step.title), durationMs: step.duration, ...(step.error ? { error: String(step.error.message || '').split('\\n')[0] } : {}), ...where(step.location) }); }
  onTestEnd(test, result) { out({ type: 'test-end', test: name(test), status: result.status, durationMs: result.duration, errors: result.errors.map((error) => ({ message: String(error.message || '').split('\\n').slice(0, 3).join(' '), ...where(error.location) })) }); }
  onError(error) { out({ type: 'error', message: String(error.message || '').split('\\n')[0], ...where(error.location) }); }
  onEnd(result) { out({ type: 'end', status: result.status }); }
}
`;

/** La configuration de l'exécution : celle du projet généré (éventuellement modifiée), plus le reporter. */
/** La configuration du run : celle générée, plus le reporter ; dans un navigateur visible, le ralenti. */
export function runConfigSource(visible?: { slowMoMs: number }): string {
  const slow =
    visible && visible.slowMoMs > 0
      ? `, use: { ...base.use, launchOptions: { ...base.use?.launchOptions, slowMo: ${String(visible.slowMoMs)} } }`
      : '';
  return `// Written by QA-CRAWLER for this run: the generated configuration, plus the events reporter.
import base from './playwright.config';
const reporters = Array.isArray(base.reporter) ? base.reporter : base.reporter ? [[base.reporter]] : [];
export default { ...base, reporter: [...reporters, ['./${REPORTER_FILE}']]${slow} };
`;
}

interface ReporterLine {
  at?: string;
  type: string;
  test?: string;
  category?: string;
  title?: string;
  file?: string;
  line?: number;
  durationMs?: number;
  error?: string;
  status?: string;
  tests?: number;
  message?: string;
  errors?: { message: string; file?: string; line?: number }[];
}

/**
 * Lit la sortie de Playwright Test : les lignes du reporter deviennent des événements (étapes du test
 * avec leur ligne et l'étape du flow d'origine), les autres restent la sortie brute de l'outil.
 */
export function playwrightOutput(options: {
  emit: Emit;
  /** Le fichier du test (chemin sous generated/) et son contenu (repères « step N »). */
  file: string;
  source: string;
  /** La sortie brute de l'outil (sans les lignes du reporter ni du pilote, valeurs de saisie retirées). */
  output?: (text: string) => void;
}): { write: (chunk: string) => void; end: () => void } {
  const stepOf = stepOfLine(options.source);
  const base = path.basename(options.file);
  let buffer = '';
  const at = (
    line: number | undefined,
    file: string | undefined,
  ): Pick<RunLogInput, 'file' | 'line' | 'step'> => {
    if (line === undefined || file !== base) return {};
    const step = stepOf(line);
    return { file: options.file, line, ...(step !== undefined ? { step } : {}) };
  };
  const handle = (event: ReporterLine): void => {
    const common = {
      source: 'playwright-test',
      ...(event.at ? { at: event.at } : {}),
      ...(event.test ? { scenario: event.test } : {}),
    };
    switch (event.type) {
      case 'begin':
        options.emit({
          ...common,
          level: 'INFO',
          category: 'ENGINE',
          type: 'RUNNER_STARTED',
          message: `Playwright Test: ${String(event.tests ?? 0)} test(s)`,
        });
        return;
      case 'test-begin':
        options.emit({
          ...common,
          level: 'INFO',
          category: 'ENGINE',
          type: 'TEST_STARTED',
          status: 'RUNNING',
          message: `test "${event.test ?? ''}" started`,
          ...at(event.line, event.file),
        });
        return;
      case 'step-begin':
      case 'step-end': {
        const visible =
          event.category === 'pw:api' || event.category === 'expect' || event.category === 'test.step';
        const where = at(event.line, event.file);
        // Les étapes internes (fixtures, hooks, lancement du navigateur) : du détail, sans ligne du test.
        const level: RunLogLevel = event.error
          ? 'ERROR'
          : visible && where.line !== undefined
            ? 'INFO'
            : 'DEBUG';
        const assertion = event.category === 'expect';
        const begin = event.type === 'step-begin';
        options.emit({
          ...common,
          level: begin && level === 'INFO' ? 'INFO' : level,
          category: assertion ? 'ASSERTION' : visible ? 'ACTION' : 'ENGINE',
          // Les étapes internes du runner (fixtures, hooks, navigateur) ont leur propre type.
          type: !visible
            ? begin
              ? 'RUNNER_STEP_STARTED'
              : 'RUNNER_STEP_FINISHED'
            : begin
              ? assertion
                ? 'ASSERTION_STARTED'
                : 'ACTION_STARTED'
              : assertion
                ? 'ASSERTION_FINISHED'
                : 'ACTION_FINISHED',
          // Playwright rend la main quand le geste est fait (ou la vérification passée) : « exécuté » / « confirmé ».
          status: begin ? 'RUNNING' : event.error ? 'FAILED' : assertion ? 'CONFIRMED' : 'EXECUTED',
          message: `${event.title ?? ''}${event.error ? ` · ${event.error}` : ''}`,
          ...(event.durationMs !== undefined && !begin ? { durationMs: event.durationMs } : {}),
          ...(event.error
            ? {
                errorKind: assertion
                  ? ('ASSERTION' as const)
                  : /locator|waiting for|resolved to|strict mode/i.test(event.error)
                    ? ('SELECTOR' as const)
                    : ('SCENARIO' as const),
              }
            : {}),
          data: { category: event.category ?? '' },
          ...where,
        });
        return;
      }
      case 'test-end': {
        const failed =
          event.status === 'failed' || event.status === 'timedOut' || event.status === 'interrupted';
        const first = event.errors?.[0];
        options.emit({
          ...common,
          level: failed ? 'ERROR' : event.status === 'skipped' ? 'WARN' : 'INFO',
          category: 'ENGINE',
          type: 'TEST_FINISHED',
          status: failed ? 'FAILED' : event.status === 'skipped' ? 'SKIPPED' : 'CONFIRMED',
          message: `test "${event.test ?? ''}" ${event.status ?? ''}${first ? ` · ${first.message}` : ''}`,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(failed
            ? {
                errorKind:
                  event.status === 'timedOut'
                    ? ('SCENARIO' as const)
                    : /expect|toHave|toBe/i.test(first?.message ?? '')
                      ? ('ASSERTION' as const)
                      : /locator|waiting for/i.test(first?.message ?? '')
                        ? ('SELECTOR' as const)
                        : ('SCENARIO' as const),
              }
            : {}),
          ...at(first?.line, first?.file),
        });
        return;
      }
      case 'error':
        options.emit({
          ...common,
          level: 'ERROR',
          category: 'SYSTEM',
          type: 'RUNNER_ERROR',
          status: 'FAILED',
          errorKind: 'INFRASTRUCTURE',
          message: event.message ?? 'Playwright Test error',
          ...at(event.line, event.file),
        });
        return;
      case 'end':
        options.emit({
          ...common,
          level: event.status === 'passed' ? 'INFO' : 'WARN',
          category: 'ENGINE',
          type: 'RUNNER_FINISHED',
          message: `Playwright Test finished: ${event.status ?? ''}`,
        });
        return;
      default:
    }
  };
  const line = (text: string): void => {
    const index = text.indexOf(REPORTER_PREFIX);
    if (index >= 0) {
      try {
        handle(JSON.parse(text.slice(index + REPORTER_PREFIX.length)) as ReporterLine);
        return;
      } catch {
        // une ligne illisible reste de la sortie
      }
    }
    options.output?.(`${driverText(text)}\n`);
    if (text.trim() !== '')
      options.emit({
        level: 'DEBUG',
        category: 'OUTPUT',
        type: 'OUTPUT',
        source: 'playwright-test',
        message: driverText(text),
      });
  };
  return {
    write: (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const text of lines) line(text);
    },
    end: () => {
      if (buffer) line(buffer);
      buffer = '';
    },
  };
}

/** Une ligne de sortie qui porte un repère du reporter (à retirer de la sortie brute affichée). */
export const isReporterLine = (text: string): boolean => text.includes(REPORTER_PREFIX);

// ── Maven et le pilote Playwright Java ──────────────────────────────────────────────────────

/** Les arguments d'un geste de saisie cités par le pilote : jamais affichés. */
const DRIVER_VALUES =
  /\b(fill|type|pressSequentially|press|selectOption|setInputFiles|setChecked|insertText)\((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\)?/g;

/** Une ligne du pilote, sans valeur : les arguments de saisie et les attributs value="…" sont retirés. */
export function driverText(text: string): string {
  return text.replace(DRIVER_VALUES, '$1(…)').replace(/\bvalue=("[^"]*"|'[^']*')/gi, 'value="…"');
}

/**
 * Lit la sortie de `mvn test` avec le journal du pilote Playwright Java : un test commencé (« Running »),
 * ses gestes (attente de l'élément, élément trouvé, geste fait, vérification), sa fin (« Tests run »),
 * et la ligne d'une erreur dans la pile (`File.java:29`) rapportée à l'étape du code généré.
 */
export function mavenOutput(options: {
  emit: Emit;
  /** Le fichier de test principal (chemin sous generated/) et son contenu (repères « step N »). */
  file: string;
  source: string;
  /** La sortie brute de l'outil (sans les lignes du reporter ni du pilote, valeurs de saisie retirées). */
  output?: (text: string) => void;
}): { write: (chunk: string) => void; end: () => void } {
  const stepOf = stepOfLine(options.source);
  const base = path.basename(options.file);
  let buffer = '';
  let test: string | undefined;
  let lastFailure: string | undefined;
  const emit = (event: Omit<RunLogInput, 'source'>): void => {
    options.emit({
      source:
        event.category === 'ACTION' || event.category === 'ASSERTION' || event.category === 'BROWSER'
          ? 'playwright-java'
          : 'maven',
      ...(test ? { scenario: test } : {}),
      ...event,
    });
  };
  const line = (raw: string): void => {
    const text = raw.replace(/\r$/, '');
    const driver = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+pw:api\s(\s*)(.*)$/.exec(text);
    if (driver) {
      const [, at, indent, body = ''] = driver;
      const detail = (indent ?? '').length > 0;
      const message = driverText(body);
      const base = { ...(at ? { at } : {}) };
      if (/^navigating to /.test(message))
        emit({
          ...base,
          level: 'INFO',
          category: 'BROWSER',
          type: 'NAVIGATION_STARTED',
          status: 'RUNNING',
          message,
        });
      else if (/^navigated to /.test(message))
        emit({
          ...base,
          level: 'DEBUG',
          category: 'BROWSER',
          type: 'NAVIGATED',
          status: 'EXECUTED',
          message,
        });
      else if (/^waiting for /.test(message) && !detail)
        emit({
          ...base,
          level: 'INFO',
          category: 'ACTION',
          type: 'TARGET_WAIT',
          status: 'REQUESTED',
          message,
        });
      else if (/^locator resolved to /.test(message))
        emit({
          ...base,
          level: 'INFO',
          category: 'ACTION',
          type: 'TARGET_RESOLVED',
          status: 'CONFIRMED',
          message,
        });
      else if (/^attempting (\w+) action/.test(message))
        emit({
          ...base,
          level: 'INFO',
          category: 'ACTION',
          type: 'ACTION_STARTED',
          status: 'RUNNING',
          message,
        });
      else if (/^(\w+) action done/.test(message))
        emit({
          ...base,
          level: 'INFO',
          category: 'ACTION',
          type: 'ACTION_FINISHED',
          status: 'EXECUTED',
          message,
        });
      else if (/^Assert /.test(message))
        emit({
          ...base,
          level: 'INFO',
          category: 'ASSERTION',
          // Le pilote annonce la vérification, pas sa fin : elle est demandée ; la fin du test dit le reste.
          type: 'ASSERTION_REQUESTED',
          status: 'REQUESTED',
          message,
        });
      else
        emit({ ...base, level: 'DEBUG', category: detail ? 'ACTION' : 'BROWSER', type: 'DRIVER', message });
      return;
    }
    options.output?.(`${driverText(text)}\n`);
    if (text.trim() === '') return;
    const clean = text.replace(/^\[(INFO|WARNING|ERROR)\]\s?/, '');
    // Maven sépare ses blocs par des lignes `[ERROR]` vides : rien à dire, pas d'événement.
    if (clean.trim() === '') return;
    const severity = /^\[ERROR\]/.test(text) ? 'ERROR' : /^\[WARNING\]/.test(text) ? 'WARN' : 'DEBUG';
    const running = /^Running (.+)$/.exec(clean);
    if (running?.[1]) {
      test = running[1];
      emit({
        level: 'INFO',
        category: 'ENGINE',
        type: 'TEST_STARTED',
        status: 'RUNNING',
        message: `test "${test}" started`,
      });
      return;
    }
    const result = /^Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+).*? -- in (.+)$/.exec(
      clean,
    );
    if (result) {
      const [, run, failures, errors, skipped, name] = result;
      const failed = Number(failures) + Number(errors) > 0;
      emit({
        level: failed ? 'ERROR' : 'INFO',
        category: 'ENGINE',
        type: 'TEST_FINISHED',
        status: failed
          ? 'FAILED'
          : Number(skipped) > 0 && Number(skipped) === Number(run)
            ? 'SKIPPED'
            : 'CONFIRMED',
        message: `test "${name ?? ''}": ${String(run)} run, ${String(failures)} failure(s), ${String(errors)} error(s), ${String(skipped)} skipped`,
        ...(failed ? { errorKind: Number(errors) > 0 ? ('SCENARIO' as const) : ('ASSERTION' as const) } : {}),
        scenario: name ?? '',
      });
      test = undefined;
      return;
    }
    // Une erreur d'un test : son message, puis la ligne du fichier généré dans la pile d'appels.
    const failure = /^(\S+\.\S+)\s+--\s+Time elapsed.*<<<\s+(FAILURE|ERROR)!$/.exec(clean);
    if (failure) {
      lastFailure = failure[1];
      return;
    }
    const frame = new RegExp(`\\(${base.replace(/\./g, '\\.')}:(\\d+)\\)`).exec(clean);
    if (frame?.[1] && lastFailure) {
      const lineNumber = Number(frame[1]);
      const step = stepOf(lineNumber);
      emit({
        level: 'ERROR',
        category: 'ENGINE',
        type: 'FAILURE_LOCATED',
        status: 'FAILED',
        message: `the failure of ${lastFailure} is at ${base}:${String(lineNumber)}`,
        file: options.file,
        line: lineNumber,
        ...(step !== undefined ? { step } : {}),
      });
      lastFailure = undefined;
      return;
    }
    if (
      /^(com\.microsoft\.playwright\.|org\.opentest4j\.|java\.lang\.|org\.junit)\S*(Error|Exception|Failed)/.test(
        clean,
      )
    ) {
      emit({
        level: 'ERROR',
        category: /Assertion|opentest4j/.test(clean) ? 'ASSERTION' : 'ACTION',
        type: 'TEST_ERROR',
        status: 'FAILED',
        message: driverText(clean),
        errorKind: /Assertion|opentest4j/.test(clean)
          ? 'ASSERTION'
          : /TimeoutError|waiting for|strict mode/i.test(clean)
            ? 'SELECTOR'
            : 'SCENARIO',
      });
      return;
    }
    if (/^BUILD (SUCCESS|FAILURE)/.test(clean))
      emit({
        level: clean.includes('FAILURE') ? 'ERROR' : 'INFO',
        category: 'ENGINE',
        type: 'BUILD_FINISHED',
        message: clean,
      });
    else if (/COMPILATION ERROR|Could not resolve dependencies|BUILD FAILURE/.test(clean))
      emit({
        level: 'ERROR',
        category: 'SYSTEM',
        type: 'BUILD_ERROR',
        status: 'FAILED',
        errorKind: 'INFRASTRUCTURE',
        message: clean,
      });
    else emit({ level: severity, category: 'OUTPUT', type: 'OUTPUT', message: driverText(clean) });
  };
  return {
    write: (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const text of lines) line(text);
    },
    end: () => {
      if (buffer) line(buffer);
      buffer = '';
    },
  };
}
