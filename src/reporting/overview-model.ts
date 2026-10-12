/**
 * VUE D'ENSEMBLE — le modèle de la page reports/overview.html.
 *
 * Tout est dérivé du résultat du run (aucune donnée inventée) : un flow imposé devient un parcours
 * (nœuds + réutilisations de données), une timeline d'actions, des indicateurs et la lignée de ses
 * données de test. Pur et testable sans navigateur ; le rendu HTML est dans overview-html-reporter.ts.
 */
import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowRunReport, FlowStatus, FlowStepReport } from '../model/flow-run.js';

/**
 * Le ton d'une étape, du plus grave au plus doux :
 * - failed : FAILED / BLOCKED ;
 * - warning : PASSED avec un doute (effet non confirmé, cible guérie, récupération, confiance basse) ;
 * - unknown : PASSED, mais l'intention fonctionnelle n'a pas été interprétée (UNKNOWN / AMBIGUOUS) ;
 * - valid : PASSED et rien à redire ;
 * - skipped / manual : pas exécutée par le robot.
 */
export type OverviewTone = 'valid' | 'warning' | 'failed' | 'unknown' | 'skipped' | 'manual';

/** L'intention fonctionnelle d'une étape telle que le rejeu l'a vue. */
export type OverviewIntentStatus = 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNKNOWN' | 'NONE';

export interface OverviewStep {
  index: number;
  kind: string;
  /** Le geste ou l'étape métier (Navigation, Input, Search, Open…). */
  title: string;
  /** Ce sur quoi il porte (« Company name », « /companies »). */
  subtitle: string;
  description: string;
  status: FlowStatus;
  tone: OverviewTone;
  /** Raisons du ton warning / failed (lisibles, jamais une valeur saisie). */
  notes: string[];
  intent: { status: OverviewIntentStatus; name?: string; confidence?: number };
  /** Clés de données de test produites par cette étape (première saisie). */
  generates: string[];
  /** Clés de données de test produites plus tôt et réutilisées ici. */
  reuses: string[];
  /** L'étape où le rejeu s'est arrêté (flow non PASSED). */
  current: boolean;
  /** Heure de début estimée (ISO) : début du flow + durées des étapes précédentes. */
  startedAt: string;
  durationMs: number;
  /** Écritures HTTP déclenchées (« POST /companies 201 »). */
  writes: string[];
  requests: number;
  interpretation?: string;
  reason?: string;
  healed?: { from: string; to: string };
  confidence?: number;
  screenshot?: string;
}

/** Une réutilisation de donnée : de l'étape qui la produit vers une étape qui la reprend. */
export interface OverviewLink {
  key: string;
  from: number;
  to: number;
  how: 'INPUT' | 'CITATION';
}

export interface OverviewDataUse {
  step: number;
  description: string;
  role: 'SOURCE' | 'REUSE' | 'CITATION';
}

export interface OverviewDataEntry {
  key: string;
  strategy: string;
  generator?: string;
  sensitive: boolean;
  /** Seulement une valeur GÉNÉRÉE par le crawler (le rapport n'en porte jamais d'autre). */
  value?: string;
  producedAt?: number;
  uses: OverviewDataUse[];
}

export interface OverviewKpis {
  actions: number;
  validated: number;
  /** Intention CONFIRMED / PROBABLE. */
  interpreted: number;
  /** Intention UNKNOWN / AMBIGUOUS / absente. */
  notInterpreted: number;
  /** Aucune étape ne porte d'intention (flow écrit à la main, rejeu par intention désactivé). */
  intentAvailable: boolean;
  warnings: number;
  failed: number;
  durationMs: number;
  /** Durée de chaque étape, dans l'ordre (sparkline). */
  durations: number[];
}

export interface OverviewFlow {
  name: string;
  description?: string;
  status: FlowStatus;
  startedAt: string;
  durationMs: number;
  kpis: OverviewKpis;
  steps: OverviewStep[];
  links: OverviewLink[];
  data: OverviewDataEntry[];
  businessProof?: { status: string; key?: string };
  confidence?: number;
  drift?: string;
  divergence?: { step: number; reason: string };
}

export interface OverviewModel {
  mission: string;
  mode: string;
  runId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  baseUrl: string;
  startUrl: string;
  issues: number;
  version?: string;
  node?: string;
  ai?: string;
  flows: OverviewFlow[];
  /** Run sans flow imposé : l'exploration autonome résumée. */
  exploration: {
    states: number;
    actionsExecuted: number;
    actionsSucceeded: number;
    actionsFailed: number;
    actionsBlocked: number;
  };
}

const DOUBTFUL_EFFECTS = new Set([
  'NO_EFFECT',
  'WRONG_EFFECT',
  'AMBIGUOUS',
  'TARGET_MISMATCH',
  'EXPECTATION_SUSPECT',
]);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Le modèle de la vue d'ensemble pour tout le run (un flow par entrée). */
export function buildOverviewModel(result: ExplorationResult): OverviewModel {
  return {
    mission: result.mission,
    mode: result.mode,
    ...(result.runId ? { runId: result.runId } : {}),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    baseUrl: result.target.baseUrl,
    startUrl: result.target.startUrl,
    issues: result.issues.length,
    ...(result.tool ? { version: result.tool.coreVersion, node: result.tool.node } : {}),
    ...(result.ai
      ? { ai: result.ai.model ? `${result.ai.provider} · ${result.ai.model}` : result.ai.provider }
      : {}),
    flows: result.flows.map(buildOverviewFlow),
    exploration: {
      states: result.stats.states,
      actionsExecuted: result.stats.actionsExecuted,
      actionsSucceeded: result.stats.actionsSucceeded,
      actionsFailed: result.stats.actionsFailed,
      actionsBlocked: result.stats.actionsBlocked,
    },
  };
}

export function buildOverviewFlow(flow: FlowRunReport): OverviewFlow {
  const entries = flow.testDataReport?.entries ?? [];
  const producedBy = new Map<number, string[]>();
  const links: OverviewLink[] = [];
  for (const entry of entries) {
    if (entry.producedAt === undefined) continue;
    producedBy.set(entry.producedAt, [...(producedBy.get(entry.producedAt) ?? []), entry.key]);
    for (const use of entry.usedBy) {
      if (use.step === entry.producedAt) continue;
      links.push({ key: entry.key, from: entry.producedAt, to: use.step, how: use.how });
    }
  }
  links.sort((a, b) => a.from - b.from || a.to - b.to || a.key.localeCompare(b.key));

  const proof = flow.businessProof;
  const stage = new Map<number, string>();
  if (proof?.creation) stage.set(proof.creation.step, 'Create');
  if (proof?.search) stage.set(proof.search.step, 'Search');
  if (proof?.open) stage.set(proof.open.step, 'Open');

  const stopped = flow.status === 'PASSED' ? undefined : stoppedAt(flow);
  const flowStart = Date.parse(flow.startedAt);
  let offset = 0;
  const steps = flow.steps.map((step): OverviewStep => {
    const startedAt = Number.isFinite(flowStart)
      ? new Date(flowStart + offset).toISOString()
      : flow.startedAt;
    offset += step.durationMs;
    const reuses = [...new Set(links.filter((link) => link.to === step.index).map((link) => link.key))];
    return buildStep(step, {
      startedAt,
      generates: producedBy.get(step.index) ?? [],
      reuses,
      current: stopped === step.index,
      stage: stage.get(step.index),
    });
  });

  const actions = steps.filter((step) => step.tone !== 'manual');
  const withIntent = actions.filter((step) => step.intent.status !== 'NONE');
  const interpreted = actions.filter(
    (step) => step.intent.status === 'CONFIRMED' || step.intent.status === 'PROBABLE',
  ).length;
  const description = new Map(steps.map((step) => [step.index, step.description]));

  return {
    name: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
    status: flow.status,
    startedAt: flow.startedAt,
    durationMs: flow.durationMs,
    kpis: {
      actions: actions.length,
      validated: actions.filter((step) => step.status === 'PASSED').length,
      interpreted,
      notInterpreted: actions.length - interpreted,
      intentAvailable: withIntent.length > 0,
      warnings: steps.filter((step) => step.tone === 'warning').length,
      failed: steps.filter((step) => step.tone === 'failed').length,
      durationMs: flow.durationMs,
      durations: steps.map((step) => step.durationMs),
    },
    steps,
    links,
    data: entries.map((entry) => ({
      key: entry.key,
      strategy: entry.strategy,
      ...(entry.generator ? { generator: entry.generator } : {}),
      sensitive: entry.sensitive,
      ...(entry.value !== undefined && !entry.sensitive ? { value: entry.value } : {}),
      ...(entry.producedAt !== undefined ? { producedAt: entry.producedAt } : {}),
      uses: entry.usedBy.map((use) => ({
        step: use.step,
        description: description.get(use.step) ?? '',
        role:
          use.step === entry.producedAt ? 'SOURCE' : use.how === 'CITATION' ? 'CITATION' : ('REUSE' as const),
      })),
    })),
    ...(proof && proof.status !== 'NOT_APPLICABLE'
      ? { businessProof: { status: proof.status, ...(proof.key ? { key: proof.key } : {}) } }
      : {}),
    ...(flow.replay ? { confidence: flow.replay.overallConfidence } : {}),
    ...(flow.drift?.detected ? { drift: flow.drift.classification } : {}),
    ...(flow.divergence
      ? { divergence: { step: flow.divergence.stepIndex, reason: flow.divergence.reason } }
      : {}),
  };
}

/** L'étape où le parcours s'est arrêté : la divergence, sinon la première étape en échec. */
function stoppedAt(flow: FlowRunReport): number | undefined {
  if (flow.divergence) return flow.divergence.stepIndex;
  return flow.steps.find((step) => step.status === 'FAILED' || step.status === 'BLOCKED')?.index;
}

function buildStep(
  step: FlowStepReport,
  context: {
    startedAt: string;
    generates: string[];
    reuses: string[];
    current: boolean;
    stage?: string | undefined;
  },
): OverviewStep {
  const intent = step.replay?.position.currentIntent;
  const intentStatus: OverviewIntentStatus = intent?.status ?? 'NONE';
  const notes = doubts(step);
  const tone: OverviewTone =
    step.status === 'FAILED' || step.status === 'BLOCKED'
      ? 'failed'
      : step.status === 'SKIPPED'
        ? 'skipped'
        : step.status === 'MANUAL'
          ? 'manual'
          : notes.length > 0
            ? 'warning'
            : intentStatus === 'UNKNOWN' || intentStatus === 'AMBIGUOUS'
              ? 'unknown'
              : 'valid';
  const requests = step.network?.requests ?? [];
  return {
    index: step.index,
    kind: step.kind,
    title: context.stage ?? stepTitle(step.kind, intent?.operation),
    subtitle: stepSubtitle(step),
    description: step.description,
    status: step.status,
    tone,
    notes: tone === 'failed' && step.reason ? [step.reason, ...notes] : notes,
    intent: {
      status: intentStatus,
      ...(intent ? { name: intent.name, confidence: intent.confidence } : {}),
    },
    generates: context.generates,
    reuses: context.reuses,
    current: context.current,
    startedAt: context.startedAt,
    durationMs: step.durationMs,
    writes: requests
      .filter((request) => WRITE_METHODS.has(request.method))
      .map((request) => `${request.method} ${request.path}${request.status ? ` ${request.status}` : ''}`),
    requests: requests.length,
    ...(step.interpretation ? { interpretation: step.interpretation } : {}),
    ...(step.reason ? { reason: step.reason } : {}),
    ...(step.effect?.healed ? { healed: step.effect.healed } : {}),
    ...(step.replay ? { confidence: step.replay.confidence.overall } : {}),
    ...(step.screenshot ? { screenshot: step.screenshot } : {}),
  };
}

/** Ce qui rend une étape PASSED douteuse (vide : rien à redire). */
function doubts(step: FlowStepReport): string[] {
  if (step.status !== 'PASSED') return [];
  const notes: string[] = [];
  if (step.effect && DOUBTFUL_EFFECTS.has(step.effect.status)) notes.push(`effect ${step.effect.status}`);
  if (step.effect?.deferred) notes.push('effect deferred');
  if (step.effect?.healed) notes.push('target healed');
  if (step.recovery) notes.push('recovered');
  if (step.recordingModelDivergence) notes.push('recorded expectation contaminated');
  if (step.replay?.verdict.outcome === 'COMMITTED_WITH_DOUBT') notes.push('committed with doubt');
  if (step.replay && !step.replay.confidence.continueSilently) notes.push('low confidence');
  return [...new Set(notes)];
}

const KIND_TITLES: Record<string, string> = {
  goto: 'Navigation',
  click: 'Click',
  check: 'Check',
  uncheck: 'Uncheck',
  fill: 'Input',
  select: 'Select',
  expect: 'Validate',
  screenshot: 'Screenshot',
  manual: 'Manual',
  auto: 'Auto',
  intent: 'Intent',
  dragAndDrop: 'Drag & drop',
};

function stepTitle(kind: string, operation: string | undefined): string {
  if (operation && operation !== 'UNKNOWN') {
    const words = operation
      .toLowerCase()
      .split(/[_\s]+/)
      .filter(Boolean);
    if (words.length > 0)
      return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
  }
  return KIND_TITLES[kind] ?? kind;
}

/** « click button "Save" » → « Save » ; « fill label "Name" = … » → « Name » ; « goto /x » → « /x ». */
export function stepSubtitle(step: Pick<FlowStepReport, 'kind' | 'description'>): string {
  const rest = (
    step.description.startsWith(`${step.kind} `)
      ? step.description.slice(step.kind.length + 1)
      : step.description
  ).replace(/\$\{testData:([^}]+)\}/g, '{$1}');
  if (step.kind === 'goto') return rest;
  if (step.kind === 'expect') return rest.replace(/^url contains /, 'URL ').replace(/"/g, '');
  const quoted = /"([^"]+)"/.exec(rest);
  return quoted?.[1] ?? rest;
}
