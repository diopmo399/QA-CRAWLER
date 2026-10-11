import { stringify } from 'yaml';
import type { FlowStep } from '../config/flow-schema.js';
import type { FlowRunReport, FlowStepReport } from '../model/flow-run.js';
import { literalEnvName, stepYaml, testDataKeysOf, type FlowDefinition } from './flow-steps.js';
import type { Finding, RunAnomaly } from './model.js';

/**
 * REPRODUCTION PLANNER : d'une anomalie à un chemin de reproduction MINIMAL, puis à un artefact
 * de reproduction (un flow YAML autonome) que l'on peut rejouer et juger.
 *
 * Ce qui existait : le chemin d'écrans d'une anomalie (AnomalyRecord.reproductionPath), les flows
 * imposés et leurs étapes, les données de test par étape. Ce qui est nouveau : la réduction d'un
 * flow au minimum qui mène à l'étape fautive (navigation qui change l'écran, saisies du même
 * formulaire, étapes qui produisent les données citées, l'étape fautive), le flow YAML généré (le
 * flow d'origine n'est jamais modifié) et le jugement d'un rejeu :
 *
 *   REPRODUCED             la même étape échoue de la même façon ;
 *   PARTIALLY_REPRODUCED   le rejeu échoue, mais ailleurs ou autrement ;
 *   NOT_REPRODUCED         le rejeu passe ;
 *   ENVIRONMENT_DEPENDENT  le rejeu échoue sur un signal d'environnement (réseau, 5xx, session) ;
 *   INSUFFICIENT_EVIDENCE  l'anomalie n'est rattachée à aucune étape rejouable.
 *
 * Reproduire, c'est reproduire un COMPORTEMENT FONCTIONNEL, pas une image.
 */

export type ReproductionStatus =
  | 'REPRODUCED'
  | 'NOT_REPRODUCED'
  | 'PARTIALLY_REPRODUCED'
  | 'ENVIRONMENT_DEPENDENT'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NOT_VERIFIED';

export interface MinimalReproductionPath {
  flow: string;
  /** Les index (1..n) des étapes gardées, dans l'ordre. */
  steps: number[];
  /** Pourquoi chaque étape est gardée. */
  reasons: Record<number, string>;
  dropped: number;
  /** L'étape fautive dans le flow d'origine. */
  failingStep: number;
}

export interface BugReproductionArtifact {
  anomalyId: string;
  category: string;
  symptom: string;
  status: ReproductionStatus;
  path?: MinimalReproductionPath;
  /** Le flow YAML autonome (texte), prêt à coller dans une mission. */
  flowYaml?: string;
  /** Clés des données de test citées (jamais des valeurs). */
  testDataKeys: string[];
  expected: string[];
  observed: string[];
  evidence: string[];
  reason?: string;
}

export interface ReproductionAnalysis {
  artifacts: BugReproductionArtifact[];
  summary: Record<ReproductionStatus, number>;
  findings: Finding[];
}

const STATUSES: ReproductionStatus[] = [
  'REPRODUCED',
  'NOT_REPRODUCED',
  'PARTIALLY_REPRODUCED',
  'ENVIRONMENT_DEPENDENT',
  'INSUFFICIENT_EVIDENCE',
  'NOT_VERIFIED',
];
const INPUT_KINDS = new Set(['fill', 'select', 'check', 'uncheck', 'dragAndDrop']);

/** Le chemin minimal qui mène à l'étape `failing` (index 1..n) d'un flow. */
export function minimalPath(
  definition: FlowDefinition,
  report: FlowRunReport,
  failing: number,
): MinimalReproductionPath {
  const steps = definition.steps;
  const kept = new Set<number>([failing]);
  const reasons: Record<number, string> = { [failing]: 'the failing step' };
  const stateAt = (index: number): string | undefined =>
    report.steps.find((step) => step.index === index)?.stateId;
  const keep = (index: number, reason: string): void => {
    if (kept.has(index)) return;
    kept.add(index);
    reasons[index] = reason;
  };
  // 1. Les étapes qui changent l'écran avant l'étape fautive (la navigation), et les goto.
  for (let index = 1; index < failing; index += 1) {
    const step = steps[index - 1];
    if (!step) continue;
    if (step.kind === 'goto') keep(index, 'navigation (goto)');
    else if (
      step.kind === 'click' &&
      stateAt(index) !== undefined &&
      stateAt(index) !== stateAt(index - 1) &&
      index > 1
    )
      keep(index, 'navigation (the screen changed)');
    else if (step.kind === 'click' && index === 1 && stateAt(1) !== undefined)
      keep(index, 'first action of the flow');
  }
  // 2. L'action que l'étape fautive vérifie (le dernier clic avant une observation) est toujours gardée.
  const failingStep = steps[failing - 1];
  if (
    failingStep &&
    (failingStep.kind === 'expect' || failingStep.kind === 'screenshot' || failingStep.kind === 'manual')
  )
    for (let index = failing - 1; index >= 1; index -= 1) {
      const step = steps[index - 1];
      if (
        step &&
        !INPUT_KINDS.has(step.kind) &&
        step.kind !== 'expect' &&
        step.kind !== 'screenshot' &&
        step.kind !== 'manual'
      ) {
        keep(index, 'the action the failing step verifies');
        break;
      }
    }
  // 3. Un clic suivi de saisies (il a ouvert un formulaire) est gardé ; les saisies du segment qui mène à une étape gardée aussi.
  for (let index = 1; index < failing; index += 1) {
    const step = steps[index - 1];
    if (!step || step.kind !== 'click') continue;
    const next = steps[index];
    if (next && INPUT_KINDS.has(next.kind)) keep(index, 'opens the form the next inputs fill');
  }
  // L'étape fautive elle-même (un clic « Enregistrer ») soumet les saisies qui la précèdent.
  let segmentHasKept = failingStep !== undefined && !INPUT_KINDS.has(failingStep.kind);
  for (let index = failing - 1; index >= 1; index -= 1) {
    const step = steps[index - 1];
    if (!step) continue;
    if (kept.has(index) && !INPUT_KINDS.has(step.kind)) segmentHasKept = true;
    else if (step.kind === 'click' && !kept.has(index)) segmentHasKept = false;
    else if (INPUT_KINDS.has(step.kind) && (segmentHasKept || index === failing - 1))
      keep(index, 'input of the form submitted by a kept step');
  }
  // 4. Les étapes qui produisent une donnée citée par une étape gardée.
  const citedKeys = new Set(
    testDataKeysOf(
      [...kept].map((index) => steps[index - 1]).filter((step): step is FlowStep => step !== undefined),
    ),
  );
  for (const entry of report.testDataReport?.entries ?? [])
    if (citedKeys.has(entry.key) && entry.producedAt !== undefined && entry.producedAt < failing)
      keep(entry.producedAt, `produces the test data ${entry.key}`);
  const ordered = [...kept].sort((a, b) => a - b);
  return {
    flow: definition.name,
    steps: ordered,
    reasons,
    dropped: failing - ordered.length,
    failingStep: failing,
  };
}

/** Le flow YAML autonome d'un chemin de reproduction (le flow d'origine n'est jamais modifié). */
export function reproductionFlowYaml(
  definition: FlowDefinition,
  path: MinimalReproductionPath,
  anomalyId: string,
): string {
  const steps = path.steps
    .map((index) => definition.steps[index - 1])
    .filter((step): step is FlowStep => step !== undefined);
  const flow = {
    name: `repro-${anomalyId.toLowerCase()}`,
    description: `Minimal reproduction of ${anomalyId} from flow "${definition.name}" (step ${String(path.failingStep)})`,
    ...(definition.startAt ? { startAt: definition.startAt } : {}),
    // Les valeurs littérales de la mission ne sont jamais recopiées : une variable d'environnement par étape.
    steps: steps.map((step, position) =>
      stepYaml(step, literalEnvName(definition.name, path.steps[position] ?? position + 1)),
    ),
  };
  return stringify({ flows: [flow] }, { lineWidth: 0 });
}

function stepReport(report: FlowRunReport, index: number): FlowStepReport | undefined {
  return report.steps.find((step) => step.index === index);
}

/** Les artefacts de reproduction des anomalies rattachées à une étape de flow. */
export function planReproductions(
  anomalies: readonly RunAnomaly[],
  definitions: readonly FlowDefinition[],
  reports: readonly FlowRunReport[],
): ReproductionAnalysis {
  const artifacts: BugReproductionArtifact[] = [];
  for (const anomaly of anomalies) {
    if (anomaly.severity === 'INFO') continue;
    const base = {
      anomalyId: anomaly.id,
      category: anomaly.category,
      symptom: anomaly.symptom,
      evidence: anomaly.evidence,
    };
    const definition = definitions.find((entry) => entry.name === anomaly.location.flow);
    const report = reports.find((entry) => entry.name === anomaly.location.flow);
    const failing = anomaly.location.step;
    const step = report && failing !== undefined ? stepReport(report, failing) : undefined;
    if (!definition || !report || failing === undefined || !step) {
      artifacts.push({
        ...base,
        status: 'INSUFFICIENT_EVIDENCE',
        testDataKeys: [],
        expected: [],
        observed: [],
        reason: anomaly.location.flow
          ? 'the step is unknown'
          : 'the anomaly is not attached to a replayable flow step',
      });
      continue;
    }
    const path = minimalPath(definition, report, failing);
    const kept = path.steps
      .map((index) => definition.steps[index - 1])
      .filter((entry): entry is FlowStep => entry !== undefined);
    artifacts.push({
      ...base,
      status: 'NOT_VERIFIED',
      path,
      flowYaml: reproductionFlowYaml(definition, path, anomaly.id),
      testDataKeys: testDataKeysOf(kept),
      expected: step.effect?.expected ?? [],
      observed: [...(step.effect?.observed ?? []), ...(step.reason ? [step.reason] : [])],
    });
  }
  const summary = Object.fromEntries(
    STATUSES.map((status) => [status, artifacts.filter((entry) => entry.status === status).length]),
  ) as Record<ReproductionStatus, number>;
  const findings: Finding[] = artifacts
    .filter((artifact) => artifact.path)
    .map((artifact) => ({
      conclusion: `reproduction path for ${artifact.anomalyId}: ${String(artifact.path?.steps.length ?? 0)} step(s) of ${String(artifact.path?.failingStep ?? 0)}`,
      evidence: Object.entries(artifact.path?.reasons ?? {}).map(
        ([index, reason]) => `step ${index}: ${reason}`,
      ),
      confidence: 0.7,
      source: 'RUNTIME' as const,
    }));
  return { artifacts, summary, findings };
}

/** Juge un rejeu du flow de reproduction : le comportement fonctionnel s'est-il reproduit ? */
export function assessReproduction(
  artifact: BugReproductionArtifact,
  replayed: FlowRunReport,
): ReproductionStatus {
  if (!artifact.path) return 'INSUFFICIENT_EVIDENCE';
  const failingPosition = artifact.path.steps.indexOf(artifact.path.failingStep) + 1;
  const failed = replayed.steps.filter((step) => step.status === 'FAILED' || step.status === 'BLOCKED');
  if (failed.length === 0 && replayed.status === 'PASSED') return 'NOT_REPRODUCED';
  const first = failed[0];
  if (!first) return 'PARTIALLY_REPRODUCED';
  const environmental =
    (first.network?.requests ?? []).some(
      (request) => request.failure !== undefined || (request.status ?? 0) >= 500,
    ) || /session|login|sign-in|timeout|net::|connection/i.test(first.reason ?? '');
  if (first.index === failingPosition) {
    if (environmental && artifact.category !== 'API_FAILURE' && artifact.category !== 'NETWORK_FAILURE')
      return 'ENVIRONMENT_DEPENDENT';
    const sameSymptom =
      artifact.observed.length === 0 ||
      artifact.observed.some(
        (observed) =>
          (first.reason ?? '').includes(observed) || (first.effect?.observed ?? []).includes(observed),
      );
    return sameSymptom ? 'REPRODUCED' : 'PARTIALLY_REPRODUCED';
  }
  return environmental ? 'ENVIRONMENT_DEPENDENT' : 'PARTIALLY_REPRODUCED';
}
