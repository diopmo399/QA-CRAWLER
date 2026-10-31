import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { redactText } from '../security/redactor.js';
import type { GuardedFiles } from './guarded-fs.js';
import type { ExecutionEnvironmentAdapter, LogSource } from './environments.js';
import { EnvironmentError } from './environments.js';
import type {
  CodeIndex,
  Evidence,
  EvidenceKind,
  Experiment,
  ExperimentKind,
  HttpExchange,
  Incident,
  PolicyDecision,
  PolicyOperation,
  ReproductionRun,
  ScopeApplication,
} from './model.js';
import type { ScopePolicy } from './scope-policy.js';

/**
 * EXPERIMENT RUNNER : les vérifications d'une hypothèse. Chaque vérification déclare ses opérations,
 * qui passent d'abord par le Scope Policy Engine (refus : statut REFUSED, décisions consignées, rien
 * n'est exécuté). Les effets de bord exigent une approbation explicite ET `permissions.sideEffects`.
 * Le budget `limits.maxExperiments` n'est consommé que par une vérification réellement lancée.
 * Les résultats sont des preuves (EXPERIMENT, LOG_LINE, CODE), masquées ; aucune valeur de champ
 * n'est recopiée (seulement sa présence et son genre).
 */

export interface ExperimentContext {
  incident: Incident;
  policy: ScopePolicy;
  adapter: ExecutionEnvironmentAdapter;
  files: GuardedFiles;
  code?: CodeIndex;
  replay: (scenario: string) => Promise<ReproductionRun>;
  signal: AbortSignal;
  actor: string;
  now: () => Date;
}

type Params = Experiment['params'];

const DEFAULT_DESCRIPTIONS: Record<ExperimentKind, string> = {
  REPLAY: 'Rejouer le scénario et vérifier que le symptôme se reproduit',
  COMPARE_REQUESTS: 'Comparer les requêtes de deux reproductions sur le même endpoint',
  COMPARE_RESPONSES: 'Comparer les réponses de deux reproductions sur le même endpoint',
  UNIT_TEST: 'Lancer un test unitaire du dépôt',
  INTEGRATION_TEST: "Lancer un test d'intégration du dépôt",
  INSPECT_LOGS: 'Chercher les traces de l’erreur dans les journaux',
  CHECK_VALIDATION: "Vérifier la validation d'un champ dans le code",
  COMPARE_WITH_PASSING: 'Rejouer un scénario qui réussit et le comparer à la reproduction en échec',
};

/** Une vérification planifiée : jamais exécutée ici. */
export function planExperiment(
  input: { kind: ExperimentKind; params: Params; hypothesisId?: string; description?: string },
  now: Date,
): Experiment {
  const sideEffects = input.kind === 'INTEGRATION_TEST' || input.params.sideEffects === true;
  return {
    // Horodaté (tri) puis aléatoire.
    id: `exp_${now.getTime().toString(36)}${randomBytes(6).toString('base64url')}`,
    kind: input.kind,
    ...(input.hypothesisId ? { hypothesisId: input.hypothesisId } : {}),
    description: input.description ?? DEFAULT_DESCRIPTIONS[input.kind],
    params: { ...input.params },
    status: sideEffects ? 'APPROVAL_REQUIRED' : 'PROPOSED',
    sideEffects,
    decisions: [],
    evidence: [],
  };
}

// ── Paramètres ──────────────────────────────────────────────────────────────────────────────

function str(params: Params, key: string): string | undefined {
  const value = params[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

function strs(params: Params, key: string): string[] | undefined {
  const value = params[key];
  if (Array.isArray(value)) return value.filter((entry) => entry.trim() !== '');
  if (typeof value === 'string' && value.trim())
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  return undefined;
}

function num(params: Params, key: string): number | undefined {
  const value = params[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Une erreur de paramètres : la vérification finit en ERROR, rien n'est exécuté. */
class ParamsError extends Error {}

function application(incident: Incident, params: Params, layers?: string[]): ScopeApplication {
  const id = str(params, 'applicationId');
  const apps = incident.scope.applications;
  if (id) {
    const app = apps.find((entry) => entry.id === id);
    if (!app) throw new ParamsError(`application ${id} is not in the scope`);
    return app;
  }
  const candidates = layers ? apps.filter((entry) => layers.includes(entry.layer)) : apps;
  if (candidates.length === 1 && candidates[0]) return candidates[0];
  throw new ParamsError('params.applicationId is required (several or no applications in the scope)');
}

/** Un chemin relatif au dépôt de l'application (ou absolu), sans remontée. */
function repositoryPath(incident: Incident, params: Params, value: string): string {
  if (path.isAbsolute(value)) return path.normalize(value);
  if (value.split(/[\\/]/).includes('..')) throw new ParamsError(`${value}: '..' is not allowed`);
  return path.join(application(incident, params).repository.root, value);
}

// ── Échanges HTTP ───────────────────────────────────────────────────────────────────────────

/** Chemin comparable : sans hôte ni requête, identifiants et gabarits remplacés par {}. */
export function comparablePath(value: string): string {
  let pathname = value;
  try {
    pathname = new URL(value, 'http://placeholder.invalid').pathname;
  } catch {
    pathname = value.split(/[?#]/)[0] ?? value;
  }
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      /^\{[^}]*\}$|^:\w+$|^\$\{[^}]*\}$|^\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        segment,
      )
        ? '{}'
        : segment,
    );
  return `/${segments.join('/')}`;
}

function parseEndpoint(value: string | undefined): { method: string; path: string } | undefined {
  if (!value) return undefined;
  const match = /^([A-Za-z]+)\s+(\S+)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new ParamsError(`endpoint "${value}" must look like "POST /api/books"`);
  return { method: match[1].toUpperCase(), path: comparablePath(match[2]) };
}

function sameEndpoint(exchange: HttpExchange, endpoint: { method: string; path: string }): boolean {
  return (
    exchange.method.toUpperCase() === endpoint.method &&
    comparablePath(exchange.path || exchange.url) === endpoint.path
  );
}

const isFailure = (exchange: HttpExchange): boolean =>
  (exchange.status ?? 0) >= 400 || Boolean(exchange.failure);

/** L'échange visé : celui de l'endpoint (en échec de préférence), sinon la première erreur 5xx/4xx. */
function pickExchange(
  run: ReproductionRun,
  endpoint?: { method: string; path: string },
): HttpExchange | undefined {
  if (endpoint) {
    const matching = run.requests.filter((exchange) => sameEndpoint(exchange, endpoint));
    return matching.find(isFailure) ?? matching[0];
  }
  return (
    run.requests.find((exchange) => (exchange.status ?? 0) >= 500) ??
    run.requests.find((exchange) => (exchange.status ?? 0) >= 400) ??
    run.requests.find((exchange) => Boolean(exchange.failure))
  );
}

function endpointOf(exchange: HttpExchange): { method: string; path: string } {
  return { method: exchange.method.toUpperCase(), path: comparablePath(exchange.path || exchange.url) };
}

/** Les feuilles d'un JSON (chemins « a.b », « items[0].c »), jusqu'à une profondeur raisonnable. */
export function flattenJson(text: string | undefined): Map<string, unknown> | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const leaves = new Map<string, unknown>();
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth < 8 && node !== null && typeof node === 'object') {
      const entries = Array.isArray(node)
        ? node.map((child, index) => [`${prefix}[${String(index)}]`, child] as const)
        : Object.entries(node).map(([key, child]) => [prefix ? `${prefix}.${key}` : key, child] as const);
      if (entries.length === 0) leaves.set(prefix || '$', node);
      for (const [key, child] of entries) walk(child, key, depth + 1);
      return;
    }
    leaves.set(prefix || '$', node);
  };
  walk(value, '', 0);
  return leaves;
}

/** Le genre d'une valeur, jamais la valeur : « absent », « vide », « nombre »… */
export function describeValue(value: unknown, present: boolean): string {
  if (!present) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (value === '') return 'chaîne vide';
    if (value.includes('[REDACTED]')) return 'masqué';
    return 'chaîne';
  }
  if (typeof value === 'number') return 'nombre';
  if (typeof value === 'boolean') return 'booléen';
  if (Array.isArray(value)) return value.length ? 'tableau' : 'tableau vide';
  return typeof value === 'object' ? 'objet vide' : typeof value;
}

const lacks = (value: unknown, present: boolean): boolean => !present || value === null || value === '';

interface FieldDiff {
  field: string;
  left: string;
  right: string;
  change: 'MISSING_LEFT' | 'MISSING_RIGHT' | 'DIFFERENT';
}

function diffBodies(left: Map<string, unknown>, right: Map<string, unknown>): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const inLeft = left.has(field);
    const inRight = right.has(field);
    const l = left.get(field);
    const r = right.get(field);
    const leftLacks = lacks(l, inLeft);
    const rightLacks = lacks(r, inRight);
    let change: FieldDiff['change'] | undefined;
    if (leftLacks && !rightLacks) change = 'MISSING_LEFT';
    else if (rightLacks && !leftLacks) change = 'MISSING_RIGHT';
    else if (inLeft !== inRight || describeValue(l, inLeft) !== describeValue(r, inRight))
      change = 'DIFFERENT';
    if (change)
      diffs.push({ field, left: describeValue(l, inLeft), right: describeValue(r, inRight), change });
  }
  return diffs;
}

const fieldMatches = (key: string, field: string): boolean =>
  key === field || key.endsWith(`.${field}`) || key.replace(/\[\d+\]/g, '') === field;

/** Le message d'une réponse (message, error, exceptions nommées), masqué et court. */
export function responseMessage(body: string | undefined): { message?: string; exceptions: string[] } {
  if (!body) return { exceptions: [] };
  const exceptions = [...new Set(body.match(/\b(?:[a-z]\w*\.)*[A-Z]\w*(?:Exception|Error)\b/g) ?? [])];
  const leaves = flattenJson(body);
  const raw =
    (leaves?.get('message') as string | undefined) ??
    (leaves?.get('error') as string | undefined) ??
    (leaves ? undefined : body);
  const message = typeof raw === 'string' ? redactText(raw).slice(0, 300) : undefined;
  return { ...(message ? { message } : {}), exceptions };
}

// ── Preuves ─────────────────────────────────────────────────────────────────────────────────

class EvidenceSink {
  readonly items: Evidence[] = [];
  constructor(
    private readonly experiment: Experiment,
    private readonly now: () => Date,
  ) {}

  add(
    kind: EvidenceKind,
    summary: string,
    extra: Partial<Pick<Evidence, 'data'>> & { source?: Evidence['source'] } = {},
  ): Evidence {
    const evidence: Evidence = {
      id: `${this.experiment.id}:ev${String(this.items.length + 1)}`,
      kind,
      at: this.now().toISOString(),
      summary: redactText(summary),
      source: { experiment: this.experiment.id, ...(extra.source ?? {}) },
      ...(extra.data ? { data: extra.data } : {}),
    };
    this.items.push(evidence);
    return evidence;
  }
}

interface KindResult {
  outcome: NonNullable<Experiment['outcome']>;
  summary: string;
  status?: 'DONE' | 'ERROR';
}

// ── Opérations déclarées (vérifiées avant toute exécution) ──────────────────────────────────

interface Plan {
  operations: PolicyOperation[];
  /** Les sources de journaux (INSPECT_LOGS). */
  logSources?: LogSource[];
  test?: Extract<PolicyOperation, { kind: 'RUN_TEST' }>;
  file?: string;
}

function latestReproduction(incident: Incident, reproduced?: boolean): ReproductionRun | undefined {
  // Les rejeux du scénario de l'incident d'abord : ceux d'une vérification (scénario qui réussit) viennent à côté.
  const all = incident.investigation.reproductions;
  const own = all.filter((run) => run.scenario === incident.scenario);
  const runs = own.length > 0 ? own : all;
  const candidates = reproduced === undefined ? runs : runs.filter((run) => run.reproduced === reproduced);
  return candidates.at(-1);
}

function navigationOperations(incident: Incident, params: Params): PolicyOperation[] {
  const baseUrl = str(params, 'baseUrl') ?? latestReproduction(incident)?.baseUrl;
  return baseUrl ? [{ kind: 'NAVIGATE', url: baseUrl }] : [];
}

const MAVEN = new Set(['mvn', './mvnw', 'mvnw', 'gradle', './gradlew']);

function testOperation(
  incident: Incident,
  experiment: Experiment,
): Extract<PolicyOperation, { kind: 'RUN_TEST' }> {
  const params = experiment.params;
  const app = application(incident, params);
  const module = str(params, 'module') ?? str(params, 'cwd');
  const cwd = module
    ? repositoryPath(incident, { ...params, applicationId: app.id }, module)
    : app.repository.root;
  const command = str(params, 'command') ?? (app.layer === 'FRONTEND' ? 'npm' : 'mvn');
  const test = str(params, 'test');
  const args =
    strs(params, 'args') ??
    (MAVEN.has(command)
      ? command.includes('gradle')
        ? ['test', ...(test ? ['--tests', test] : [])]
        : ['-B', 'test', ...(test ? [`-Dtest=${test}`] : [])]
      : command === 'npx'
        ? ['vitest', 'run', ...(test ? [test] : [])]
        : ['test', ...(test ? ['--', test] : [])]);
  return {
    kind: 'RUN_TEST',
    level: experiment.kind === 'INTEGRATION_TEST' ? 'INTEGRATION' : 'UNIT',
    command,
    args,
    cwd,
  };
}

function logSources(incident: Incident, params: Params, now: Date): LogSource[] {
  const file = str(params, 'path');
  if (file) return [{ path: repositoryPath(incident, params, file) }];
  const app = str(params, 'applicationId')
    ? application(incident, params)
    : (incident.scope.applications.find((entry) => entry.openshift) ??
      incident.scope.applications.find((entry) => entry.logFiles?.length));
  const namespace = str(params, 'namespace') ?? app?.openshift?.namespace;
  const selector = str(params, 'selector') ?? app?.openshift?.selector;
  if (namespace && selector) {
    const window = logWindow(incident, params);
    const since =
      num(params, 'sinceSeconds') ??
      (window.from !== undefined ? Math.ceil((now.getTime() - window.from) / 1000) + 60 : undefined);
    const container = str(params, 'container');
    const tail = num(params, 'tail');
    return [
      {
        openshift: {
          namespace,
          selector,
          ...(container ? { container } : {}),
          ...(tail !== undefined ? { tail } : {}),
          ...(since !== undefined && since > 0 ? { sinceSeconds: since } : {}),
        },
      },
    ];
  }
  if (app?.logFiles?.length)
    return app.logFiles.map((entry) => ({
      path: path.isAbsolute(entry) ? entry : path.join(app.repository.root, entry),
    }));
  throw new ParamsError('INSPECT_LOGS needs params.path, an OpenShift selector or application logFiles');
}

function prepare(experiment: Experiment, incident: Incident, now: Date): Plan {
  const params = experiment.params;
  switch (experiment.kind) {
    case 'REPLAY':
    case 'COMPARE_WITH_PASSING':
      return { operations: navigationOperations(incident, params) };
    case 'COMPARE_REQUESTS':
    case 'COMPARE_RESPONSES':
      return { operations: [] };
    case 'UNIT_TEST':
    case 'INTEGRATION_TEST': {
      const test = testOperation(incident, experiment);
      return { operations: [test], test };
    }
    case 'INSPECT_LOGS': {
      const sources = logSources(incident, params, now);
      return {
        operations: sources.map((source) =>
          'path' in source
            ? { kind: 'READ_LOG', path: source.path }
            : { kind: 'OPENSHIFT', verb: 'logs', resource: 'pods', namespace: source.openshift.namespace },
        ),
        logSources: sources,
      };
    }
    case 'CHECK_VALIDATION': {
      const file = str(params, 'file');
      if (!file) throw new ParamsError('CHECK_VALIDATION needs params.file');
      const absolute = repositoryPath(incident, params, file);
      const app = str(params, 'applicationId') ? application(incident, params) : undefined;
      return {
        operations: [{ kind: 'READ_FILE', path: absolute, ...(app ? { applicationId: app.id } : {}) }],
        file: absolute,
      };
    }
  }
}

// ── Exécution ───────────────────────────────────────────────────────────────────────────────

const PRODUCTION_LIKE = /prod|preprod|pre-prod|staging|recette|uat|live/i;
const NON_PRODUCTION = /^(local|dev|development|test|testing|ci|sandbox|ephemeral|integration|qa)$/i;

function denialOf(error: unknown): PolicyDecision | undefined {
  if (error instanceof Error && 'decision' in error) {
    const decision = (error as { decision?: unknown }).decision;
    if (decision && typeof decision === 'object' && 'allowed' in decision) return decision as PolicyDecision;
  }
  return undefined;
}

/** Les refus d'environnement (rien n'a été exécuté). */
const ENV_REFUSALS = new Set([
  'ENV_ARO_MOUNT',
  'ENV_ARO_CONFIG',
  'ENV_SHELL',
  'ENV_OPENSHIFT_NOT_CONFIGURED',
  'ENV_OC_ARGS',
]);

class CancelledError extends Error {}
class TimeoutError extends Error {}

/** Un signal qui s'arrête avec celui du contexte ou à la limite de durée du périmètre. */
function boundedSignal(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let expired = false;
  const onAbort = (): void => {
    controller.abort();
  };
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
    timedOut: () => expired,
  };
}

/** Attend une promesse, sauf arrêt (annulation ou limite de durée). */
function guarded<T>(promise: Promise<T>, bounded: ReturnType<typeof boundedSignal>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      reject(bounded.timedOut() ? new TimeoutError('time limit reached') : new CancelledError('cancelled'));
    };
    if (bounded.signal.aborted) {
      stop();
      return;
    }
    bounded.signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => {
      bounded.signal.removeEventListener('abort', stop);
    });
  });
}

/**
 * Exécute une vérification. Refus (REFUSED, rien d'exécuté) : décision du périmètre, effets de bord
 * non approuvés, test d'intégration sur un environnement de production ou de nature inconnue en LOCAL,
 * budget épuisé. Les erreurs (paramètres, outil absent) donnent ERROR ; l'arrêt donne CANCELLED.
 */
export async function runExperiment(
  experiment: Experiment,
  context: ExperimentContext,
  options: { approvedBy?: string } = {},
): Promise<Experiment> {
  const { incident, policy } = context;
  const startedAt = context.now().toISOString();
  const base: Experiment = {
    ...experiment,
    params: { ...experiment.params },
    sideEffects:
      experiment.sideEffects ||
      experiment.kind === 'INTEGRATION_TEST' ||
      experiment.params.sideEffects === true,
    decisions: [],
    evidence: [],
    startedAt,
  };
  delete base.outcome;
  delete base.summary;
  delete base.finishedAt;
  delete base.approvedBy;
  const finish = (patch: Partial<Experiment>): Experiment => ({
    ...base,
    ...patch,
    finishedAt: context.now().toISOString(),
  });
  const refuse = (reason: string, decisions: PolicyDecision[]): Experiment =>
    finish({ status: 'REFUSED', decisions, summary: redactText(reason), evidence: [] });

  // 1. Les opérations déclarées, vérifiées avant toute exécution.
  let plan: Plan;
  try {
    plan = prepare(base, incident, context.now());
  } catch (error) {
    if (error instanceof ParamsError) return finish({ status: 'ERROR', summary: error.message });
    throw error;
  }
  const decisions: PolicyDecision[] = [];
  for (const operation of plan.operations) decisions.push(await policy.check(operation));
  const denied = decisions.filter((decision) => !decision.allowed);
  if (denied.length)
    return refuse(`refus du périmètre : ${denied.map((decision) => decision.reason).join(' ; ')}`, decisions);

  // 2. Effets de bord : approbation explicite et permission du périmètre.
  if (base.sideEffects) {
    if (!options.approvedBy) return refuse('les effets de bord exigent une approbation explicite', decisions);
    if (!incident.scope.permissions.sideEffects)
      return refuse(
        'les effets de bord ne sont pas autorisés par le périmètre (permissions.sideEffects)',
        decisions,
      );
  }

  // 3. Test d'intégration : jamais contre une production, nature déclarée en LOCAL.
  if (base.kind === 'INTEGRATION_TEST') {
    const kind = str(base.params, 'environmentKind');
    if (kind && PRODUCTION_LIKE.test(kind) && !NON_PRODUCTION.test(kind))
      return refuse(`test d'intégration refusé sur un environnement ${kind}`, decisions);
    if (incident.execution.target === 'LOCAL' && !(kind && NON_PRODUCTION.test(kind)))
      return refuse(
        "un test d'intégration en LOCAL exige params.environmentKind désignant un environnement hors production (LOCAL, DEV, TEST, CI…)",
        decisions,
      );
  }

  // 4. Budget des vérifications.
  if (!policy.consume('experiment'))
    return refuse(
      `budget des vérifications épuisé (limits.maxExperiments = ${String(incident.scope.limits.maxExperiments)})`,
      decisions,
    );

  if (options.approvedBy) base.approvedBy = options.approvedBy;
  const sink = new EvidenceSink(base, context.now);
  const bounded = boundedSignal(context.signal, Math.max(1, incident.scope.limits.maxDurationMs));
  try {
    const result = await guarded(execute(base, plan, context, sink, bounded.signal), bounded);
    return finish({
      status: result.status ?? 'DONE',
      decisions,
      evidence: sink.items,
      summary: redactText(result.summary),
      ...(result.status === 'ERROR' ? {} : { outcome: result.outcome }),
    });
  } catch (error) {
    const decision = denialOf(error);
    if (decision) return refuse(`refus du périmètre : ${decision.reason}`, [...decisions, decision]);
    if (error instanceof EnvironmentError && ENV_REFUSALS.has(error.rule))
      return finish({
        status: 'REFUSED',
        decisions,
        evidence: sink.items,
        summary: redactText(error.message),
      });
    if (error instanceof CancelledError || context.signal.aborted)
      return finish({ status: 'CANCELLED', decisions, evidence: sink.items, summary: 'annulée' });
    if (error instanceof TimeoutError)
      return finish({
        status: 'ERROR',
        decisions,
        evidence: sink.items,
        summary: `limite de durée atteinte (limits.maxDurationMs = ${String(incident.scope.limits.maxDurationMs)})`,
      });
    if (error instanceof ParamsError || error instanceof EnvironmentError || error instanceof Error)
      return finish({ status: 'ERROR', decisions, evidence: sink.items, summary: redactText(error.message) });
    throw error;
  } finally {
    bounded.dispose();
  }
}

async function execute(
  experiment: Experiment,
  plan: Plan,
  context: ExperimentContext,
  sink: EvidenceSink,
  signal: AbortSignal,
): Promise<KindResult> {
  switch (experiment.kind) {
    case 'REPLAY':
      return replayKind(experiment, context, sink);
    case 'COMPARE_REQUESTS':
    case 'COMPARE_RESPONSES':
      return compareKind(experiment, context, sink);
    case 'COMPARE_WITH_PASSING':
      return compareWithPassingKind(experiment, context, sink);
    case 'UNIT_TEST':
    case 'INTEGRATION_TEST':
      if (!plan.test) throw new ParamsError('no test operation');
      return testKind(experiment, plan.test, context, sink, signal);
    case 'INSPECT_LOGS':
      return logsKind(experiment, plan.logSources ?? [], context, sink, signal);
    case 'CHECK_VALIDATION':
      if (!plan.file) throw new ParamsError('no file');
      return validationKind(experiment, plan.file, context, sink);
  }
}

// ── REPLAY ──────────────────────────────────────────────────────────────────────────────────

function statuses(run: ReproductionRun): string {
  const errors = run.requests.filter(isFailure);
  return errors.length
    ? errors
        .slice(0, 5)
        .map(
          (exchange) =>
            `${exchange.method} ${exchange.path} → ${exchange.status !== undefined ? String(exchange.status) : (exchange.failure ?? 'échec')}`,
        )
        .join(', ')
    : 'aucune requête en erreur';
}

async function replayKind(
  experiment: Experiment,
  context: ExperimentContext,
  sink: EvidenceSink,
): Promise<KindResult> {
  const scenario = str(experiment.params, 'scenario') ?? context.incident.scenario;
  if (!scenario) throw new ParamsError('REPLAY needs params.scenario or an incident scenario');
  const run = await context.replay(scenario);
  sink.add('EXPERIMENT', `Rejeu de « ${scenario} » : ${run.status}, ${statuses(run)}`, {
    source: { reproduction: run.id, ...(run.run ? { run: run.run } : {}) },
    data: {
      reproduction: run.id,
      status: run.status,
      reproduced: run.reproduced,
      ...(run.symptomMatch ? { symptomMatch: run.symptomMatch } : {}),
      ...(run.error ? { error: redactText(run.error) } : {}),
    },
  });
  if (run.reproduced === true)
    return {
      outcome: 'SUPPORTS',
      summary: `symptôme de nouveau reproduit (${run.id}) : ${run.symptomMatch ?? statuses(run)}`,
    };
  if (run.reproduced === false)
    return {
      outcome: 'REFUTES',
      summary: `symptôme non reproduit (${run.id}) : ${run.symptomMatch ?? statuses(run)}`,
    };
  return {
    outcome: 'NEUTRAL',
    summary: `le rejeu n'a pas abouti (${run.id})${run.error ? ` : ${run.error}` : ''}`,
  };
}

// ── COMPARE_REQUESTS / COMPARE_RESPONSES / COMPARE_WITH_PASSING ─────────────────────────────

interface Comparison {
  endpoint: { method: string; path: string };
  failing: { run: ReproductionRun; exchange?: HttpExchange };
  other: { run: ReproductionRun; exchange?: HttpExchange };
  fields?: FieldDiff[];
}

function compareRuns(
  left: ReproductionRun,
  right: ReproductionRun,
  params: Params,
  sink: EvidenceSink,
): Comparison {
  const explicit = parseEndpoint(str(params, 'endpoint'));
  const leftPick = pickExchange(left, explicit);
  const rightPick = pickExchange(right, explicit);
  const endpoint =
    explicit ?? (leftPick ? endpointOf(leftPick) : rightPick ? endpointOf(rightPick) : undefined);
  if (!endpoint)
    throw new ParamsError('no failing request to compare: give params.endpoint ("POST /api/books")');
  const leftExchange = explicit ? leftPick : pickExchange(left, endpoint);
  const rightExchange = pickExchange(right, endpoint);
  // Le côté en échec : celui dont la réponse est une erreur (la gauche par convention).
  const swap = leftExchange && rightExchange && !isFailure(leftExchange) && isFailure(rightExchange);
  const failing = swap ? { run: right, exchange: rightExchange } : { run: left, exchange: leftExchange };
  const other = swap ? { run: left, exchange: leftExchange } : { run: right, exchange: rightExchange };
  const label = `${endpoint.method} ${endpoint.path}`;
  const statusText = (exchange?: HttpExchange): string =>
    exchange
      ? exchange.status !== undefined
        ? String(exchange.status)
        : (exchange.failure ?? 'sans réponse')
      : 'absent';
  sink.add(
    'EXPERIMENT',
    `${label} : ${statusText(failing.exchange)} (${failing.run.id}) / ${statusText(other.exchange)} (${other.run.id})`,
    {
      data: {
        endpoint: label,
        failing: {
          reproduction: failing.run.id,
          ...(failing.exchange
            ? { request: failing.exchange.id, status: failing.exchange.status ?? null }
            : {}),
        },
        other: {
          reproduction: other.run.id,
          ...(other.exchange ? { request: other.exchange.id, status: other.exchange.status ?? null } : {}),
        },
      },
    },
  );
  const comparison: Comparison = { endpoint, failing, other };
  const failingBody = flattenJson(failing.exchange?.requestBody);
  const otherBody = flattenJson(other.exchange?.requestBody);
  if (failingBody && otherBody) {
    comparison.fields = diffBodies(failingBody, otherBody);
    for (const diff of comparison.fields.slice(0, 20))
      sink.add(
        'EXPERIMENT',
        `Champ ${diff.field} : ${diff.left} (${failing.run.id}) / ${diff.right} (${other.run.id})`,
        {
          data: { field: diff.field, failing: diff.left, other: diff.right, change: diff.change },
        },
      );
    if (!comparison.fields.length)
      sink.add('EXPERIMENT', `Corps de requête identiques (clés et genres des valeurs) pour ${label}`);
  }
  return comparison;
}

function reproductionById(incident: Incident, id: string | undefined, role: string): ReproductionRun {
  if (!id) throw new ParamsError(`params.${role} (a reproduction id) is required`);
  const run = incident.investigation.reproductions.find((entry) => entry.id === id);
  if (!run) throw new ParamsError(`reproduction ${id} not found`);
  return run;
}

/** L'attente sur un champ manquant côté échec. */
function missingFieldOutcome(comparison: Comparison, field: string): KindResult | undefined {
  const failingBody = flattenJson(comparison.failing.exchange?.requestBody);
  const otherBody = flattenJson(comparison.other.exchange?.requestBody);
  if (!failingBody)
    return {
      outcome: 'NEUTRAL',
      summary: `pas de corps de requête JSON côté échec pour vérifier ${field}`,
    };
  const pick = (body: Map<string, unknown>): { present: boolean; value: unknown } => {
    const key = [...body.keys()].find((entry) => fieldMatches(entry, field));
    return key === undefined ? { present: false, value: undefined } : { present: true, value: body.get(key) };
  };
  const failingField = pick(failingBody);
  const failingLacks = lacks(failingField.value, failingField.present);
  const otherField = otherBody ? pick(otherBody) : undefined;
  const otherHas = otherField ? !lacks(otherField.value, otherField.present) : undefined;
  const failingDesc = describeValue(failingField.value, failingField.present);
  if (!failingLacks)
    return { outcome: 'REFUTES', summary: `${field} est présent dans la requête en échec (${failingDesc})` };
  if (otherHas === false)
    return { outcome: 'NEUTRAL', summary: `${field} manque dans les deux requêtes (${failingDesc})` };
  return {
    outcome: 'SUPPORTS',
    summary: `${field} manque dans la requête en échec (${failingDesc})${otherField ? ` et est présent dans l'autre (${describeValue(otherField.value, otherField.present)})` : ''}`,
  };
}

function messageOutcome(comparison: Comparison, params: Params, sink: EvidenceSink): KindResult | undefined {
  const failing = responseMessage(comparison.failing.exchange?.responseBody);
  const other = responseMessage(comparison.other.exchange?.responseBody);
  if (failing.message || failing.exceptions.length)
    sink.add(
      'EXPERIMENT',
      `Réponse en échec : ${failing.message ?? ''}${failing.exceptions.length ? ` [${failing.exceptions.join(', ')}]` : ''}`,
      {
        source: { reproduction: comparison.failing.run.id },
        data: { ...(failing.message ? { message: failing.message } : {}), exceptions: failing.exceptions },
      },
    );
  if (other.message || other.exceptions.length)
    sink.add(
      'EXPERIMENT',
      `Autre réponse : ${other.message ?? ''}${other.exceptions.length ? ` [${other.exceptions.join(', ')}]` : ''}`,
      {
        source: { reproduction: comparison.other.run.id },
        data: { ...(other.message ? { message: other.message } : {}), exceptions: other.exceptions },
      },
    );
  const expected = str(params, 'expectMessage');
  if (expected) {
    const body = comparison.failing.exchange?.responseBody;
    if (!body) return { outcome: 'NEUTRAL', summary: 'pas de corps de réponse côté échec' };
    return body.toLowerCase().includes(expected.toLowerCase())
      ? { outcome: 'SUPPORTS', summary: `la réponse en échec mentionne « ${expected} »` }
      : { outcome: 'REFUTES', summary: `la réponse en échec ne mentionne pas « ${expected} »` };
  }
  const expectedStatus = num(params, 'expectStatus');
  if (expectedStatus !== undefined) {
    const status = comparison.failing.exchange?.status;
    if (status === undefined) return { outcome: 'NEUTRAL', summary: 'pas de statut côté échec' };
    return status === expectedStatus
      ? { outcome: 'SUPPORTS', summary: `statut en échec : ${String(status)}` }
      : {
          outcome: 'REFUTES',
          summary: `statut en échec : ${String(status)}, et non ${String(expectedStatus)}`,
        };
  }
  return undefined;
}

function compareKind(experiment: Experiment, context: ExperimentContext, sink: EvidenceSink): KindResult {
  const params = experiment.params;
  const left = reproductionById(context.incident, str(params, 'left'), 'left');
  const right = reproductionById(context.incident, str(params, 'right'), 'right');
  const comparison = compareRuns(left, right, params, sink);
  return comparisonOutcome(experiment.kind, comparison, params, sink);
}

function comparisonOutcome(
  kind: ExperimentKind,
  comparison: Comparison,
  params: Params,
  sink: EvidenceSink,
): KindResult {
  const { failing, other } = comparison;
  if (!failing.exchange || !other.exchange)
    return {
      outcome: 'NEUTRAL',
      summary: `${comparison.endpoint.method} ${comparison.endpoint.path} introuvable dans ${!failing.exchange ? failing.run.id : other.run.id}`,
    };
  const byMessage = messageOutcome(comparison, params, sink);
  const field = str(params, 'expectMissingField') ?? str(params, 'field');
  if (field && kind !== 'COMPARE_RESPONSES') {
    const result = missingFieldOutcome(comparison, field);
    if (result) return result;
  }
  if (byMessage) return byMessage;
  const statusDiffers = isFailure(failing.exchange) !== isFailure(other.exchange);
  const label = `${comparison.endpoint.method} ${comparison.endpoint.path}`;
  if (kind === 'COMPARE_RESPONSES') {
    if (!statusDiffers)
      return { outcome: 'NEUTRAL', summary: `${label} : les deux réponses ont le même résultat` };
    return {
      outcome: 'SUPPORTS',
      summary: `${label} : les réponses diffèrent (${String(failing.exchange.status ?? 'aucun statut')} contre ${String(other.exchange.status ?? 'aucun statut')})`,
    };
  }
  if (!comparison.fields)
    return { outcome: 'NEUTRAL', summary: `${label} : corps de requête indisponibles en JSON` };
  const differences = comparison.fields.map((diff) => `${diff.field} (${diff.left} / ${diff.right})`);
  if (!statusDiffers)
    return {
      outcome: 'NEUTRAL',
      summary: `${label} : même résultat des deux côtés${differences.length ? ` ; différences : ${differences.join(', ')}` : ''}`,
    };
  if (!differences.length)
    return {
      outcome: 'REFUTES',
      summary: `${label} : corps de requête identiques mais résultats différents`,
    };
  return {
    outcome: 'SUPPORTS',
    summary: `${label} : la requête en échec diffère sur ${differences.join(', ')}`,
  };
}

async function compareWithPassingKind(
  experiment: Experiment,
  context: ExperimentContext,
  sink: EvidenceSink,
): Promise<KindResult> {
  const params = experiment.params;
  const passingScenario = str(params, 'passingScenario');
  if (!passingScenario) throw new ParamsError('COMPARE_WITH_PASSING needs params.passingScenario');
  const failing = str(params, 'failing')
    ? reproductionById(context.incident, str(params, 'failing'), 'failing')
    : latestReproduction(context.incident, true);
  if (!failing) throw new ParamsError('no reproduced failing run to compare with (params.failing)');
  const passing = await context.replay(passingScenario);
  sink.add(
    'EXPERIMENT',
    `Rejeu du scénario qui doit réussir « ${passingScenario} » : ${passing.status}, ${statuses(passing)}`,
    {
      source: { reproduction: passing.id },
      data: { reproduction: passing.id, status: passing.status, reproduced: passing.reproduced },
    },
  );
  const comparison = compareRuns(failing, passing, params, sink);
  const passingExchange =
    comparison.other.run === passing ? comparison.other.exchange : comparison.failing.exchange;
  if (passing.status !== 'COMPLETED' || !passingExchange || isFailure(passingExchange))
    return {
      outcome: 'NEUTRAL',
      summary: `le scénario qui doit réussir n'a pas abouti sur ${comparison.endpoint.method} ${comparison.endpoint.path}`,
    };
  if (comparison.failing.run !== failing)
    return { outcome: 'NEUTRAL', summary: "la reproduction de référence n'échoue pas sur cet endpoint" };
  const field = str(params, 'field') ?? str(params, 'expectMissingField');
  if (field)
    return missingFieldOutcome(comparison, field) ?? { outcome: 'NEUTRAL', summary: 'aucune comparaison' };
  if (!comparison.fields) return { outcome: 'NEUTRAL', summary: 'corps de requête indisponibles en JSON' };
  const missing = comparison.fields.filter((diff) => diff.change === 'MISSING_LEFT');
  if (missing.length)
    return {
      outcome: 'SUPPORTS',
      summary: `l'exécution qui doit réussir aboutit et envoie ${missing.map((diff) => diff.field).join(', ')}, absent de l'exécution en échec`,
    };
  if (!comparison.fields.length)
    return {
      outcome: 'REFUTES',
      summary: "l'exécution qui doit réussir envoie le même corps de requête et aboutit",
    };
  return {
    outcome: 'NEUTRAL',
    summary: `les exécutions diffèrent sur ${comparison.fields.map((diff) => diff.field).join(', ')} sans champ manquant`,
  };
}

// ── UNIT_TEST / INTEGRATION_TEST ────────────────────────────────────────────────────────────

/** Les compteurs d'un rapport de tests (Surefire, Gradle, Vitest, Jest). */
export function testCounts(output: string): { run?: number; failed?: number; passed?: number } | undefined {
  const surefire = [...output.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/g)].at(-1);
  if (surefire) {
    const run = Number(surefire[1]);
    const failed = Number(surefire[2]) + Number(surefire[3]);
    return { run, failed, passed: run - failed };
  }
  const jsLine = [...output.matchAll(/^\s*Tests:?\s+(.*)$/gm)].at(-1)?.[1];
  if (jsLine && /\d+\s+(passed|failed)/.test(jsLine)) {
    const failed = Number(/(\d+)\s+failed/.exec(jsLine)?.[1] ?? 0);
    const passed = Number(/(\d+)\s+passed/.exec(jsLine)?.[1] ?? 0);
    return { run: failed + passed, failed, passed };
  }
  const gradle = /(\d+)\s+tests?\s+completed(?:,\s*(\d+)\s+failed)?/.exec(output);
  if (gradle) {
    const run = Number(gradle[1]);
    const failed = Number(gradle[2] ?? 0);
    return { run, failed, passed: run - failed };
  }
  return undefined;
}

async function testKind(
  experiment: Experiment,
  op: Extract<PolicyOperation, { kind: 'RUN_TEST' }>,
  context: ExperimentContext,
  sink: EvidenceSink,
  signal: AbortSignal,
): Promise<KindResult> {
  const params = experiment.params;
  const limit = context.incident.scope.limits.maxDurationMs;
  const timeoutMs = Math.min(num(params, 'timeoutMs') ?? limit, limit);
  const result = await context.adapter.runTest(context.policy, op, { timeoutMs, signal });
  const command = [op.command, ...op.args].join(' ');
  const counts = testCounts(result.output);
  const patterns = strs(params, 'patterns') ?? [];
  const lines = result.output.split(/\r?\n/);
  const matched = patterns.length
    ? lines
        .filter((line) => patterns.some((pattern) => line.toLowerCase().includes(pattern.toLowerCase())))
        .slice(0, 10)
    : [];
  sink.add(
    'EXPERIMENT',
    `${command} : ${result.timedOut ? 'délai dépassé' : `code ${String(result.code)}`}${counts ? `, ${String(counts.run)} test(s), ${String(counts.failed)} en échec` : ''}`,
    {
      data: {
        command: op.command,
        args: op.args,
        cwd: op.cwd,
        code: result.code,
        timedOut: result.timedOut,
        ...(counts ? { counts } : {}),
        ...(matched.length ? { matched } : {}),
        output: result.output.slice(-4000),
      },
    },
  );
  if (result.timedOut)
    return {
      status: 'ERROR',
      outcome: 'NEUTRAL',
      summary: `${command} : limite de durée atteinte (${String(timeoutMs)} ms)`,
    };
  if (result.code === null)
    return {
      status: 'ERROR',
      outcome: 'NEUTRAL',
      summary: `${command} : lancement impossible (${result.output.split('\n')[0] ?? ''})`,
    };
  const passed = result.code === 0;
  if (!passed && !counts)
    return {
      outcome: 'NEUTRAL',
      summary: `${command} : échec avant tout résultat de test (erreur de build ou de compilation)`,
    };
  const expect = str(params, 'expect') === 'pass' ? 'pass' : 'fail';
  const verdict = passed ? 'réussi' : 'échoué';
  if (expect === 'pass')
    return {
      outcome: passed ? 'SUPPORTS' : 'REFUTES',
      summary: `${command} : ${verdict} (réussite attendue)`,
    };
  if (passed) return { outcome: 'REFUTES', summary: `${command} : réussi (échec attendu)` };
  if (patterns.length && !matched.length)
    return { outcome: 'NEUTRAL', summary: `${command} : échoué, mais pas avec ${patterns.join(', ')}` };
  return {
    outcome: 'SUPPORTS',
    summary: `${command} : échoué comme attendu${matched.length ? ` (${patterns.join(', ')})` : ''}`,
  };
}

// ── INSPECT_LOGS ────────────────────────────────────────────────────────────────────────────

const LINE_TIME = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

function logWindow(incident: Incident, params: Params): { from?: number; to?: number } {
  const margin = (num(params, 'marginSeconds') ?? 120) * 1000;
  const since = str(params, 'since');
  const until = str(params, 'until');
  if (since || until)
    return {
      ...(since && Number.isFinite(Date.parse(since)) ? { from: Date.parse(since) } : {}),
      ...(until && Number.isFinite(Date.parse(until)) ? { to: Date.parse(until) } : {}),
    };
  const run = latestReproduction(incident, true) ?? latestReproduction(incident);
  if (!run) return {};
  const from = Date.parse(run.startedAt);
  const to = run.finishedAt ? Date.parse(run.finishedAt) : undefined;
  return {
    ...(Number.isFinite(from) ? { from: from - margin } : {}),
    ...(to !== undefined && Number.isFinite(to) ? { to: to + margin } : {}),
  };
}

/** Les motifs par défaut : les exceptions nommées et les chemins des requêtes en erreur 5xx. */
function defaultPatterns(incident: Incident): string[] {
  const run = latestReproduction(incident, true) ?? latestReproduction(incident);
  const patterns = new Set<string>();
  for (const exchange of run?.requests ?? [])
    if ((exchange.status ?? 0) >= 500) {
      for (const exception of responseMessage(exchange.responseBody).exceptions)
        patterns.add(exception.split('.').at(-1) ?? exception);
    }
  return [...patterns];
}

async function logsKind(
  experiment: Experiment,
  sources: LogSource[],
  context: ExperimentContext,
  sink: EvidenceSink,
  signal: AbortSignal,
): Promise<KindResult> {
  const params = experiment.params;
  const patterns = strs(params, 'patterns') ?? strs(params, 'pattern') ?? defaultPatterns(context.incident);
  if (!patterns.length)
    throw new ParamsError('INSPECT_LOGS needs params.patterns (no exception named in the reproduction)');
  const maxLines = Math.max(1, Math.min(num(params, 'maxLines') ?? 2000, 10_000));
  const window = logWindow(context.incident, params);
  const matches: { line: string; source: string; file?: string; at?: string; pattern: string }[] = [];
  let read = 0;
  let outside = 0;
  for (const source of sources) {
    const label =
      'path' in source ? source.path : `openshift ${source.openshift.namespace} ${source.openshift.selector}`;
    const lines = await context.adapter.readLogs(context.policy, source, { maxLines, signal });
    read += lines.length;
    // Une ligne sans horodatage (pile d'appels) hérite de celui de la ligne précédente.
    let current: number | undefined;
    for (const line of lines) {
      const stamp = LINE_TIME.exec(line)?.[1];
      if (stamp) {
        const parsed = Date.parse(stamp.replace(' ', 'T').replace(',', '.'));
        if (Number.isFinite(parsed)) current = parsed;
      }
      const pattern = patterns.find((entry) => line.toLowerCase().includes(entry.toLowerCase()));
      if (!pattern) continue;
      if (
        current !== undefined &&
        ((window.from !== undefined && current < window.from) ||
          (window.to !== undefined && current > window.to))
      ) {
        outside += 1;
        continue;
      }
      matches.push({
        line,
        source: label,
        pattern,
        ...('path' in source ? { file: source.path } : {}),
        ...(current !== undefined ? { at: new Date(current).toISOString() } : {}),
      });
    }
  }
  for (const match of matches.slice(0, 20))
    sink.add('LOG_LINE', match.line, {
      ...(match.file ? { source: { file: match.file } } : {}),
      data: { source: match.source, pattern: match.pattern, ...(match.at ? { at: match.at } : {}) },
    });
  sink.add(
    'EXPERIMENT',
    `${String(read)} ligne(s) lue(s), ${String(matches.length)} correspondance(s) dans la fenêtre, ${String(outside)} hors fenêtre`,
    {
      data: {
        patterns,
        lines: read,
        matches: matches.length,
        outsideWindow: outside,
        ...(window.from !== undefined ? { from: new Date(window.from).toISOString() } : {}),
        ...(window.to !== undefined ? { to: new Date(window.to).toISOString() } : {}),
      },
    },
  );
  const absent = str(params, 'expect') === 'absent';
  if (matches.length)
    return absent
      ? {
          outcome: 'REFUTES',
          summary: `${patterns.join(', ')} trouvé(s) dans les journaux (${String(matches.length)} ligne(s))`,
        }
      : {
          outcome: 'SUPPORTS',
          summary: `${patterns.join(', ')} trouvé(s) dans les journaux, dans la fenêtre (${String(matches.length)} ligne(s))`,
        };
  return absent
    ? {
        outcome: 'SUPPORTS',
        summary: `${patterns.join(', ')} absent(s) de ${String(read)} ligne(s) de journal`,
      }
    : {
        outcome: 'NEUTRAL',
        summary: `${patterns.join(', ')} introuvable(s) dans ${String(read)} ligne(s) de journal${outside ? ` (${String(outside)} hors fenêtre)` : ''}`,
      };
}

// ── CHECK_VALIDATION ────────────────────────────────────────────────────────────────────────

export const JAVA_VALIDATIONS = [
  'NotNull',
  'NotBlank',
  'NotEmpty',
  'Valid',
  'Size',
  'Pattern',
  'Email',
  'Min',
  'Max',
  'Positive',
  'PositiveOrZero',
  'Negative',
  'NegativeOrZero',
  'DecimalMin',
  'DecimalMax',
  'Digits',
  'Past',
  'PastOrPresent',
  'Future',
  'FutureOrPresent',
  'AssertTrue',
  'AssertFalse',
  'Length',
  'Range',
];

/** Remplace commentaires et littéraux par des espaces (positions et lignes conservées). */
function blankCode(text: string, keepStrings: boolean): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
    } else if (char === '"' || char === "'" || char === '`') {
      let stop = index + 1;
      while (stop < text.length && text[stop] !== char) stop += text[stop] === '\\' ? 2 : 1;
      stop = Math.min(stop + 1, text.length);
      const literal = text.slice(index, stop);
      out += keepStrings
        ? literal
        : char + literal.slice(1, -1).replace(/[^\n]/g, ' ') + (literal.length > 1 ? char : '');
      index = stop;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

/** Retire les annotations (arguments compris, parenthèses équilibrées) d'un fragment de déclaration. */
function withoutAnnotations(segment: string): { rest: string; annotations: string[] } {
  const annotations: string[] = [];
  let rest = '';
  let index = 0;
  while (index < segment.length) {
    const match = /^@([\w.]+)/.exec(segment.slice(index));
    if (!match?.[1]) {
      rest += segment[index] ?? '';
      index += 1;
      continue;
    }
    annotations.push(match[1].split('.').at(-1) ?? match[1]);
    index += match[0].length;
    let cursor = index;
    while (/\s/.test(segment[cursor] ?? '')) cursor += 1;
    if (segment[cursor] === '(') {
      let depth = 0;
      for (; cursor < segment.length; cursor += 1) {
        if (segment[cursor] === '(') depth += 1;
        else if (segment[cursor] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      index = cursor + 1;
    }
    rest += ' ';
  }
  return { rest, annotations };
}

const JAVA_MODIFIERS = /\b(final|private|protected|public|static|transient|volatile)\b/g;
const JAVA_TYPE = /^[\w$.]+(\s*<[\w$\s,.<>?[\]]*>)?(\s*\[\s*\])*$/;

/** Java : les déclarations du champ (composant de record, attribut, paramètre) et leurs annotations. */
export function javaFieldValidations(text: string, field: string): { line: number; annotations: string[] }[] {
  const code = blankCode(text, false);
  const results: { line: number; annotations: string[] }[] = [];
  const name = new RegExp(`(?<![\\w.$])${field.replace(/[^\w$]/g, '')}\\s*(?=[,;)=])`, 'g');
  for (const match of code.matchAll(name)) {
    const start = match.index;
    // Le fragment qui précède jusqu'au délimiteur (hors parenthèses des annotations).
    let depth = 0;
    let cursor = start - 1;
    for (; cursor >= 0; cursor -= 1) {
      const char = code[cursor];
      if (char === ')') depth += 1;
      else if (char === '(') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && (char === ';' || char === '{' || char === '}' || char === ',')) break;
    }
    const { rest, annotations } = withoutAnnotations(code.slice(cursor + 1, start));
    const type = rest.replace(JAVA_MODIFIERS, ' ').trim();
    // Une déclaration : un type seul devant le nom (pas « return x », « a = x », « f(x) »).
    if (!type || /\b(return|new|throw|case|else)\b/.test(type) || !JAVA_TYPE.test(type)) continue;
    results.push({ line: lineAt(text, start), annotations });
  }
  return results;
}

/** L'indice de la parenthèse ou accolade fermante qui répond à celle de `open`. */
function closing(code: string, open: number): number {
  const pair = code[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === pair[0]) depth += 1;
    else if (code[index] === pair[1]) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** TS/JS : les fonctions de validation (validate*, isValid*) et les schémas zod/yup qui vérifient le champ. */
export function tsFieldValidations(text: string, field: string): { line: number; how: string }[] {
  const code = blankCode(text, true);
  const results: { line: number; how: string }[] = [];
  const escaped = field.replace(/[^\w$]/g, '');
  const reference = new RegExp(
    `(\\.\\s*${escaped}\\b|\\[\\s*['"\`]${escaped}['"\`]\\s*\\]|['"\`]${escaped}['"\`]|\\b${escaped}\\s*:)`,
  );
  const head =
    /\b(?:function\s+((?:validate|isValid)\w*)\s*(?:<[^>]*>)?\s*\(|(?:const|let|var)\s+((?:validate|isValid)\w*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b[^(]*)?\(|((?:validate|isValid)\w*)\s*\()/g;
  for (const match of code.matchAll(head)) {
    const name = match[1] ?? match[2] ?? match[3] ?? '';
    // Une méthode (forme 3) ne doit pas être un appel : précédée d'un début de ligne ou de modificateurs.
    if (match[3] !== undefined) {
      const lineStart = code.lastIndexOf('\n', match.index) + 1;
      if (
        !/^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*$/.test(
          code.slice(lineStart, match.index),
        )
      )
        continue;
    }
    const paramsEnd = closing(code, match.index + match[0].length - 1);
    if (paramsEnd < 0) continue;
    // Après les paramètres : un type de retour facultatif, puis « { » ou « => ».
    const after = /^\s*(?::\s*[^{=;]*)?\s*(=>\s*)?(\{)?/.exec(code.slice(paramsEnd + 1));
    if (!after || (!after[1] && !after[2])) continue;
    const bodyStart = paramsEnd + 1 + after[0].length - (after[2] ? 1 : 0);
    const bodyEnd = after[2] ? closing(code, bodyStart) : code.indexOf(';', bodyStart);
    const body = code.slice(bodyStart, bodyEnd < 0 ? code.length : bodyEnd + 1);
    const found = reference.exec(body);
    if (found)
      results.push({ line: lineAt(text, bodyStart + found.index), how: `${name}() vérifie ${field}` });
  }
  const schema = new RegExp(`\\b${escaped}\\s*:\\s*(z|yup|Joi)\\.[^,\\n}]*`, 'g');
  for (const match of code.matchAll(schema)) {
    const rule = match[0];
    if (/\.(optional|nullable|nullish)\(\)/.test(rule) && !/\.(min|nonempty|required)\(/.test(rule)) continue;
    results.push({ line: lineAt(text, match.index), how: `schéma ${rule.trim()}` });
  }
  return results;
}

async function validationKind(
  experiment: Experiment,
  file: string,
  context: ExperimentContext,
  sink: EvidenceSink,
): Promise<KindResult> {
  const params = experiment.params;
  const field = str(params, 'field');
  if (!field) throw new ParamsError('CHECK_VALIDATION needs params.field');
  const text = await context.files.readText(file);
  const expect = str(params, 'expect') === 'present' ? 'present' : 'missing';
  const relative = (() => {
    const app = context.incident.scope.applications.find(
      (entry) => !path.relative(entry.repository.root, file).startsWith('..'),
    );
    return app ? path.relative(app.repository.root, file).split(path.sep).join('/') : file;
  })();
  let present: { line: number; how: string }[];
  let declared: boolean;
  if (/\.java$/i.test(file)) {
    const declarations = javaFieldValidations(text, field);
    declared = declarations.length > 0;
    const allowed = new Set(strs(params, 'annotations') ?? JAVA_VALIDATIONS);
    present = declarations.flatMap((entry) =>
      entry.annotations
        .filter((annotation) => allowed.has(annotation))
        .map((annotation) => ({ line: entry.line, how: `@${annotation}` })),
    );
    for (const entry of declarations)
      sink.add(
        'CODE',
        `${relative}:${String(entry.line)} ${field}${entry.annotations.length ? ` annoté ${entry.annotations.map((a) => `@${a}`).join(' ')}` : ' sans annotation'}`,
        {
          source: { file: relative, line: entry.line },
          data: { field, annotations: entry.annotations },
        },
      );
  } else if (/\.(tsx?|jsx?|mjs|cjs|vue)$/i.test(file)) {
    present = tsFieldValidations(text, field);
    declared = new RegExp(`\\b${field.replace(/[^\w$]/g, '')}\\b`).test(blankCode(text, true));
    for (const entry of present)
      sink.add('CODE', `${relative}:${String(entry.line)} ${entry.how}`, {
        source: { file: relative, line: entry.line },
        data: { field, how: entry.how },
      });
  } else {
    throw new ParamsError(`${path.basename(file)}: unsupported file type for CHECK_VALIDATION`);
  }
  if (!declared) {
    sink.add('CODE', `${relative} : aucune déclaration ni mention de ${field}`, {
      source: { file: relative },
    });
    return { outcome: 'NEUTRAL', summary: `${field} n'est pas déclaré dans ${relative}` };
  }
  const missing = present.length === 0;
  if (missing)
    sink.add('CODE', `${relative} : aucune validation de ${field}`, {
      source: { file: relative },
      data: { field, validations: [] },
    });
  const description = missing
    ? `aucune validation de ${field} dans ${relative}`
    : `${field} validé dans ${relative} (${present.map((entry) => entry.how).join(', ')})`;
  const supports = (expect === 'missing') === missing;
  return { outcome: supports ? 'SUPPORTS' : 'REFUTES', summary: description };
}
