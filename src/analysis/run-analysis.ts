import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowRunReport, FlowStepReport } from '../model/flow-run.js';
import type { Severity } from '../model/issue.js';

/**
 * RUN ANALYSIS : le centre d'analyse d'un run, construit AU-DESSUS des moteurs existants.
 *
 *   RUN → OBSERVATIONS → COMPRÉHENSION FONCTIONNELLE → DIVERGENCE → CAUSE → HYPOTHÈSES →
 *   RÉCUPÉRATION → VÉRIFICATION DE L'EFFET → DÉRIVE → COUVERTURE → CONNAISSANCE → VERDICT
 *
 * Tout vient de l'ExplorationResult : les étapes des flows (effets, synchronisation, cibles,
 * réseau, données), la divergence et la récupération de chaque étape (WorkflowHealer), le moteur
 * cognitif (hypothèses, checkpoints, échecs compris, couverture, objectif bloqué), l'intelligence
 * fonctionnelle, l'audit du conseiller d'intelligence, la régression et la mémoire. Cette couche ne
 * recalcule AUCUNE décision : elle relie, résume, explique et rend un verdict par des règles
 * explicites. Aucune valeur saisie, aucun secret : ce que les moteurs ont déjà jugé publiable.
 */
export type RunVerdict =
  /** La preuve métier est faite (donnée créée, retrouvée, ouverte), sans récupération ni étape douteuse. */
  | 'PROVEN'
  /** Tous les flows ont réussi tels quels ; aucune preuve métier n'était à faire. */
  | 'PASSED'
  /** Réussi grâce à une récupération confirmée par la suite du parcours. */
  | 'PASSED_WITH_RECOVERY'
  /** Réussi techniquement, mais un effet n'a pas été vérifié (ou une attente enregistrée est douteuse). */
  | 'PASSED_UNVERIFIED'
  /** Le parcours a divergé et aucune récupération sûre ne l'a ramené à son objectif. */
  | 'DIVERGED'
  /** Arrêté par la politique de sécurité, les droits ou la session : jamais contourné. */
  | 'BLOCKED'
  /** Rien ne permet de conclure (flow sans étape jugée, divergence sans cause, ambiguïté). */
  | 'INCONCLUSIVE'
  /** Exploration autonome seulement : le verdict est celui des anomalies. */
  | 'EXPLORED';

export interface RunSummary {
  mission: string;
  mode: string;
  startedAt: string;
  durationMs: number;
  headline: string;
  flows: { total: number; passed: number; failed: number; blocked: number };
  steps: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    manual: number;
    /** Exécutées sans effet vérifié (NOT_VERIFIED, EXPECTATION_SUSPECT, deferred). */
    unverified: number;
  };
  recoveries: { attempted: number; succeeded: number; failed: number };
  divergences: number;
  issuesBySeverity: Record<Severity, number>;
  mutations: { executed: number; autonomous: number; flows: number };
  businessProof?: { proven: number; partial: number; notProven: number };
  intelligence?: { calls: number; accepted: number; assistedRecoveries: number };
}

export interface ExecutionTimelineEntry {
  flow: string;
  step: number;
  description: string;
  status: FlowStepReport['status'];
  durationMs: number;
  stateId?: string;
  effect?: string;
  transition?: string;
  /** Comment la cible a été trouvée (RECORDED, HEALED, FUNCTIONAL…), quand l'étape l'a rapporté. */
  target?: string;
  requests: number;
  writes: number;
  errors: number;
  testData: string[];
  /** La récupération tentée à cette étape, et son issue. */
  recovery?: string;
  reason?: string;
}

export interface ExecutionTimeline {
  entries: ExecutionTimelineEntry[];
}

export interface FunctionalTimeline {
  goal?: string;
  functionalState?: string;
  missingChain?: string;
  currentPlan?: string;
  checkpoints: SemanticCheckpointAnalysis[];
  /** L'avancement de l'objectif action par action (avant → après). */
  progress: { source: string; before: number; after: number }[];
  businessProofs: { flow: string; status: string; key?: string }[];
  workflows: string[];
}

export interface FirstDivergenceAnalysis {
  flow: string;
  step: number;
  description: string;
  /** L'étape où l'échec a été rapporté, quand la divergence est en amont. */
  symptomStep?: number;
  lastConfirmedStep?: number;
  kind: string;
  expected: string[];
  observed: string[];
  reason: string;
  rootBeforeSymptom: boolean;
  technicalSymptom?: string;
  /** Des requêtes en erreur AVANT la divergence (un refus d'écriture, par exemple) : un signal, pas une cause prouvée. */
  earlierNetworkErrors: string[];
}

export interface RootCauseAnalysis {
  flow: string;
  step: number;
  category: string;
  confidence: number;
  functional?: { category: string; confidence: number };
  candidates: { category: string; confidence: number }[];
  evidence: { source: string; detail: string }[];
  missingPrerequisites: string[];
  recoverable: boolean;
  /** FailureUnderstanding : la classe de l'échec et sa chaîne causale (déjà vu ?). */
  failureClass?: string;
  chain?: {
    symptom: string;
    firstDivergence?: string;
    probableCause: string;
    knownRecovery?: string;
    occurrences: number;
  };
  /** L'objectif bloqué : préconditions manquantes, raisons, actions candidates. */
  blockedGoal?: {
    goal: string;
    state: string;
    missingPreconditions: string[];
    blockingReasons: string[];
    candidateActions: string[];
    confidence: number;
  };
}

export interface HypothesisAnalysis {
  id: string;
  proposition: string;
  type: string;
  origin: string;
  status: string;
  confidence: number;
  evidenceFor: number;
  evidenceAgainst: number;
  runtimeConfirmed: boolean;
  /** Elle explique la divergence (même catégorie, même cible) ou en est l'alternative proposée. */
  relatedToDivergence: boolean;
  contradiction?: { why: string; alternatives: string[]; investigation: string };
}

export interface RecoveryAttemptAnalysis {
  flow: string;
  step: number;
  originalTarget: string;
  divergenceCategory: string;
  goal: string;
  planStatus: string;
  candidates: number;
  rejected: { signature: string; reason: string }[];
  selected?: { signature: string; source: string; reasons: string[] };
  outcome: {
    status: string;
    path: string[];
    attempts: number;
    confirmedCategory?: string;
    reasons: string[];
  };
  /** L'étape suivante a réussi après la récupération : la confirmation forte. */
  verified?: boolean;
  aiAssisted: boolean;
}

export interface RecoveryAnalysis {
  attempts: RecoveryAttemptAnalysis[];
  succeeded: number;
  failed: number;
  /** Récupérations apprises (RECOVERY_KNOWLEDGE_LEARNED) et chemins déjà connus réutilisés. */
  learned: number;
  historyReused: number;
}

export interface IntelligenceRunAnalysis {
  mode: string;
  provider: string;
  available?: boolean;
  unavailableReason?: string;
  calls: number;
  proposals: number;
  accepted: number;
  rejected: number;
  runtimeConfirmed: number;
  runtimeContradicted: number;
  aiAssistedRecoveries: number;
  fallbacks: number;
  /** NONE : aucune proposition retenue · ADVISORY : des propositions, aucune décisive · DECISIVE : une récupération ou une résolution assistée. */
  contribution: 'NONE' | 'ADVISORY' | 'DECISIVE';
  hypothesesProposed: number;
}

export interface TestDataAnalysis {
  flows: {
    flow: string;
    entries: { key: string; strategy: string; generator?: string; producedAt?: number; uses: number }[];
    proof?: { status: string; key?: string; missing: string[] };
  }[];
}

export interface NetworkAnalysis {
  requests: number;
  writes: number;
  errors: number;
  byStatusClass: Record<string, number>;
  failures: { flow: string; step: number; method: string; path: string; status?: number; failure?: string }[];
  slowest: { flow: string; step: number; method: string; path: string; durationMs: number }[];
  blockedWrites: number;
}

export interface WorkflowDriftAnalysis {
  flows: {
    flow: string;
    detected: boolean;
    classification: string;
    result: string;
    facts?: Record<string, number>;
    explanation: string[];
    suggestedFiles: string[];
    comparison?: { verdict: string; changes: number; durationDeltaMs: number };
  }[];
  regression?: { changes: number; disappeared: number; anomalies: Record<string, number> };
}

export interface FunctionalCoverageAnalysis {
  covered: string[];
  gaps: string[];
  functional?: {
    workflows: { total: number; verified: number; failed: number };
    transitions: { total: number; confirmed: number; contradicted: number };
    invariants: { total: number; confirmed: number; violated: number };
    sideEffects: { total: number; confirmed: number; missing: number };
    goals: Record<string, number>;
  };
}

export interface KnowledgeAnalysis {
  evidence: number;
  hypotheses: number;
  confirmed: number;
  contradicted: number;
  confirmedRelations: string[];
  recoveriesLearned: number;
  historical?: { transitions: number; levels: Record<string, number>; aged: number };
  runs?: number;
}

export interface FailureAnalysis {
  flow?: string;
  step: string;
  class: string;
  reason: string;
  expected?: string;
  observed?: string;
  firstDivergence?: string;
}

export interface SemanticCheckpointAnalysis {
  id: string;
  status: string;
}

export interface RunRecommendation {
  kind: 'FLOW_UPDATE' | 'TEST_DATA' | 'COVERAGE' | 'STEP_FIX' | 'INVESTIGATE' | 'KNOWLEDGE' | 'SAFETY';
  message: string;
  origin: string;
  flow?: string;
  step?: number;
}

export type ExplainabilityStage =
  | 'INTENT'
  | 'OBSERVED'
  | 'DIVERGENCE'
  | 'ROOT_CAUSE'
  | 'HYPOTHESES'
  | 'RECOVERY'
  | 'VERIFICATION'
  | 'CONTINUATION'
  | 'DRIFT'
  | 'COVERAGE'
  | 'LEARNING'
  | 'INTELLIGENCE'
  | 'VERDICT';

export interface ExplainabilitySummary {
  /** La chaîne causale, dans l'ordre du modèle ; chaque maillon cite ses preuves. */
  chain: { stage: ExplainabilityStage; text: string; evidence: string[] }[];
  verdictReasons: string[];
}

export interface RunAnalysis {
  runId: string;
  status: RunVerdict;
  summary: RunSummary;
  executionTimeline: ExecutionTimeline;
  functionalTimeline: FunctionalTimeline;
  firstDivergence?: FirstDivergenceAnalysis;
  rootCause?: RootCauseAnalysis;
  hypotheses: HypothesisAnalysis[];
  recovery?: RecoveryAnalysis;
  intelligence?: IntelligenceRunAnalysis;
  testData?: TestDataAnalysis;
  networkAnalysis?: NetworkAnalysis;
  workflowDrift?: WorkflowDriftAnalysis;
  functionalCoverage?: FunctionalCoverageAnalysis;
  knowledge?: KnowledgeAnalysis;
  failures: FailureAnalysis[];
  checkpoints: SemanticCheckpointAnalysis[];
  recommendations: RunRecommendation[];
  explainability: ExplainabilitySummary;
}

const RECOVERED = new Set(['GOAL_REACHED', 'GOAL_ALREADY_REACHED']);
const BLOCKING_CATEGORIES = new Set(['AUTH_CONTEXT_DIVERGENCE', 'PERMISSION_DENIED', 'SESSION_EXPIRED']);

function targetHow(step: FlowStepReport): string | undefined {
  if (step.targetResolution) {
    const trace = step.targetResolution;
    if (trace.status === 'TARGET_HEALED') return 'HEALED';
    if (trace.outcome === 'CONTEXTUAL_MATCH') return 'CONTEXTUAL';
    return trace.status === 'TARGET_FUNCTIONALLY_EQUIVALENT' ? 'FUNCTIONAL' : trace.status;
  }
  if (step.effect?.healed) return 'HEALED';
  if (step.synchronization?.reacquired) return 'REACQUIRED';
  if (step.resolution) return `SEMANTIC ${step.resolution.status}`;
  if (step.effect?.locator) return 'RECORDED';
  return undefined;
}

/**
 * Une étape réussie dont l'effet reste douteux : attente enregistrée suspecte, effet différé, ou
 * attentes jamais vérifiées. Un NOT_VERIFIED sans attente (flow écrit à la main) n'est pas un doute.
 */
function isUnverified(step: FlowStepReport): boolean {
  if (step.status !== 'PASSED') return false;
  if (step.recordingModelDivergence !== undefined) return true;
  const effect = step.effect;
  if (!effect) return false;
  if (effect.status === 'EXPECTATION_SUSPECT' || effect.deferred === true) return true;
  return effect.status === 'NOT_VERIFIED' && effect.expected.length > 0;
}

function earlierNetworkErrors(flow: FlowRunReport | undefined, before: number): string[] {
  return (flow?.steps ?? [])
    .filter((step) => step.index < before)
    .flatMap((step) =>
      (step.network?.requests ?? [])
        .filter((request) => (request.status ?? 0) >= 400 || request.failure !== undefined)
        .map(
          (request) =>
            `${request.method} ${request.path} → ${request.failure ?? String(request.status ?? '')} at step ${String(step.index)}`,
        ),
    );
}

function executionTimeline(flows: readonly FlowRunReport[]): ExecutionTimeline {
  return {
    entries: flows.flatMap((flow) =>
      flow.steps.map((step) => ({
        flow: flow.name,
        step: step.index,
        description: step.description,
        status: step.status,
        durationMs: step.durationMs,
        ...(step.stateId ? { stateId: step.stateId } : {}),
        ...(step.effect ? { effect: step.effect.status } : {}),
        ...(step.synchronization ? { transition: step.synchronization.transition } : {}),
        ...(targetHow(step) ? { target: targetHow(step) ?? '' } : {}),
        requests: step.network?.requests.length ?? 0,
        writes: step.network?.writes ?? 0,
        errors: step.network?.errors ?? 0,
        testData: step.testData ?? [],
        ...(step.recovery ? { recovery: step.recovery.outcome.status } : {}),
        ...(step.reason ? { reason: step.reason } : {}),
      })),
    ),
  };
}

function firstDivergenceOf(result: ExplorationResult): FirstDivergenceAnalysis | undefined {
  // D'abord la divergence FONCTIONNELLE du moteur cognitif (la cause, pas le symptôme) ; sinon celle du flow.
  const functional = result.cognitive?.divergences[0];
  if (functional) {
    const d = functional.divergence;
    const flow = result.flows.find((candidate) => candidate.name === functional.flow);
    const step = flow?.steps.find((candidate) => candidate.index === d.step);
    return {
      flow: functional.flow,
      step: d.step,
      description: d.description,
      ...(d.lastFailedStep !== undefined && d.lastFailedStep !== d.step
        ? { symptomStep: d.lastFailedStep }
        : {}),
      ...(d.lastConfirmedStep !== undefined ? { lastConfirmedStep: d.lastConfirmedStep } : {}),
      kind: d.kind,
      expected: d.expected,
      observed: d.observed,
      reason: d.reason,
      rootBeforeSymptom: d.rootBeforeSymptom,
      ...(step?.recovery?.divergence.technicalSymptom
        ? { technicalSymptom: step.recovery.divergence.technicalSymptom }
        : {}),
      earlierNetworkErrors: earlierNetworkErrors(flow, d.step),
    };
  }
  for (const flow of result.flows) {
    const d = flow.divergence;
    if (!d) continue;
    const step = flow.steps.find((candidate) => candidate.index === d.stepIndex);
    return {
      flow: flow.name,
      step: d.stepIndex,
      description: d.description,
      ...(d.symptomStep !== undefined ? { symptomStep: d.symptomStep } : {}),
      ...(d.lastConfirmedStep !== undefined ? { lastConfirmedStep: d.lastConfirmedStep } : {}),
      kind: step?.effect?.status ?? 'STEP_FAILED',
      expected: step?.effect?.expected ?? [],
      observed: step?.effect?.observed ?? [],
      reason: d.reason,
      rootBeforeSymptom: d.symptomStep !== undefined,
      ...(step?.recovery?.divergence.technicalSymptom
        ? { technicalSymptom: step.recovery.divergence.technicalSymptom }
        : {}),
      earlierNetworkErrors: earlierNetworkErrors(flow, d.stepIndex),
    };
  }
  // Aucune divergence analysée par les moteurs : la première étape échouée, telle quelle.
  for (const flow of result.flows) {
    const failed = flow.steps.find((step) => step.status === 'FAILED');
    if (!failed) continue;
    return {
      flow: flow.name,
      step: failed.index,
      description: failed.description,
      kind: failed.effect?.status ?? 'STEP_FAILED',
      expected: failed.effect?.expected ?? [],
      observed: failed.effect?.observed ?? [],
      reason: failed.reason ?? failed.status,
      rootBeforeSymptom: false,
      earlierNetworkErrors: earlierNetworkErrors(flow, failed.index),
    };
  }
  return undefined;
}

function rootCauseOf(
  result: ExplorationResult,
  divergence: FirstDivergenceAnalysis | undefined,
): RootCauseAnalysis | undefined {
  // La récupération de l'étape divergente porte l'analyse de la cause (DivergenceAnalyzer) ; sinon la
  // première récupération du run, sinon la cause probable notée par le flow.
  const withRecovery = result.flows.flatMap((flow) =>
    flow.steps.filter((step) => step.recovery).map((step) => ({ flow, step })),
  );
  const at =
    withRecovery.find(
      (entry) =>
        divergence &&
        entry.flow.name === divergence.flow &&
        (entry.step.index === divergence.step || entry.step.index === divergence.symptomStep),
    ) ?? withRecovery[0];
  const understanding = result.cognitive?.failures[0];
  const blocked = result.cognitive?.blockedGoal;
  const blockedGoal =
    blocked && blocked.state === 'BLOCKED'
      ? {
          goal: blocked.goal,
          state: blocked.state,
          missingPreconditions: blocked.missingPreconditions,
          blockingReasons: blocked.blockingReasons,
          candidateActions: blocked.candidateActions,
          confidence: blocked.confidence,
        }
      : undefined;
  // Un refus de requête AVANT la divergence : une preuve réseau ajoutée à la cause, jamais la cause elle-même.
  const networkSignals = (divergence?.earlierNetworkErrors ?? []).map((detail) => ({
    source: 'NETWORK',
    detail,
  }));
  if (at?.step.recovery) {
    const analysis = at.step.recovery.divergence;
    return {
      flow: at.flow.name,
      step: at.step.index,
      category: analysis.category,
      confidence: analysis.confidence,
      ...(analysis.functionalRootCause
        ? {
            functional: {
              category: analysis.functionalRootCause.category,
              confidence: analysis.functionalRootCause.confidence,
            },
          }
        : {}),
      candidates: analysis.possibleCauses.map((cause) => ({
        category: cause.category,
        confidence: cause.confidence,
      })),
      evidence: [
        ...analysis.evidence.map((evidence) => ({ source: evidence.source, detail: evidence.detail })),
        ...networkSignals,
      ],
      missingPrerequisites: (analysis.missingPrerequisites ?? []).map(
        (item) => `${item.label} (${item.reason})`,
      ),
      recoverable: analysis.recoverable,
      ...(understanding ? { failureClass: understanding.class } : {}),
      ...(blockedGoal ? { blockedGoal } : {}),
    };
  }
  const flow = result.flows.find((candidate) => candidate.divergence?.probableCause);
  // Sans divergence ni échec, un objectif « bloqué » du moteur cognitif n'est pas une cause : rien à expliquer.
  if (!divergence && !understanding && !flow) return undefined;
  if (flow?.divergence?.probableCause || understanding || blockedGoal) {
    const cause = flow?.divergence?.probableCause;
    return {
      flow: flow?.name ?? divergence?.flow ?? result.flows[0]?.name ?? '',
      step: flow?.divergence?.stepIndex ?? divergence?.step ?? 0,
      category: cause?.category ?? understanding?.class ?? 'UNKNOWN',
      confidence: cause?.confidence ?? 0,
      candidates: cause ? [{ category: cause.category, confidence: cause.confidence }] : [],
      evidence: networkSignals,
      missingPrerequisites: [],
      recoverable: !cause || !BLOCKING_CATEGORIES.has(cause.category),
      ...(understanding ? { failureClass: understanding.class } : {}),
      ...(blockedGoal ? { blockedGoal } : {}),
    };
  }
  // Aucune cause analysée : un refus de requête AVANT la divergence est le meilleur signal disponible.
  if (divergence && divergence.earlierNetworkErrors.length > 0)
    return {
      flow: divergence.flow,
      step: divergence.step,
      category: 'REJECTED_REQUEST',
      confidence: 0.5,
      candidates: [],
      evidence: divergence.earlierNetworkErrors.map((detail) => ({ source: 'NETWORK', detail })),
      missingPrerequisites: [],
      recoverable: false,
    };
  return undefined;
}

function hypothesesOf(
  result: ExplorationResult,
  divergence: FirstDivergenceAnalysis | undefined,
): HypothesisAnalysis[] {
  const cognitive = result.cognitive;
  if (!cognitive) return [];
  const contradicted = new Map(cognitive.contradictedAnalysis.map((entry) => [entry.id, entry]));
  const needle = divergence ? `${divergence.description} ${divergence.reason}`.toLowerCase() : '';
  return cognitive.hypothesisDetails.map((detail) => {
    const words = detail.description
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3);
    const related = divergence !== undefined && words.some((word) => needle.includes(word));
    const analysis = contradicted.get(detail.id);
    return {
      id: detail.id,
      proposition: detail.description,
      type: detail.type,
      origin: detail.origin,
      status: detail.status,
      confidence: detail.confidence,
      evidenceFor: detail.supportingEvidence.length,
      evidenceAgainst: detail.contradictingEvidence.length,
      runtimeConfirmed: detail.runtimeConfirmed,
      relatedToDivergence: related,
      ...(analysis
        ? {
            contradiction: {
              why: analysis.why,
              alternatives: analysis.alternatives,
              investigation: analysis.investigation,
            },
          }
        : {}),
    };
  });
}

function recoveryOf(result: ExplorationResult): RecoveryAnalysis | undefined {
  const attempts: RecoveryAttemptAnalysis[] = result.flows.flatMap((flow) =>
    flow.steps
      .filter((step) => step.recovery)
      .map((step) => {
        const recovery = step.recovery;
        if (!recovery) throw new Error('unreachable');
        return {
          flow: flow.name,
          step: step.index,
          originalTarget: recovery.originalTarget,
          divergenceCategory: recovery.divergence.category,
          goal: recovery.goal.id,
          planStatus: recovery.plan.status,
          candidates: recovery.plan.candidates.length,
          rejected: recovery.plan.rejected.map((entry) => ({
            signature: entry.signature,
            reason: entry.reason,
          })),
          ...(recovery.selected
            ? {
                selected: {
                  signature: recovery.selected.signature,
                  source: recovery.selected.source,
                  reasons: recovery.selected.reasons,
                },
              }
            : {}),
          outcome: {
            status: recovery.outcome.status,
            path: recovery.outcome.path.map((action) => `${action.kind} "${action.name}"`),
            attempts: recovery.outcome.attempts.length,
            ...(recovery.outcome.confirmedCategory
              ? { confirmedCategory: recovery.outcome.confirmedCategory }
              : {}),
            reasons: recovery.outcome.reasons,
          },
          ...(recovery.nextActionVerified !== undefined ? { verified: recovery.nextActionVerified } : {}),
          aiAssisted:
            recovery.selected?.source === 'AI_PROPOSAL' || recovery.outcome.pathSource === 'AI_PROPOSAL',
        };
      }),
  );
  if (attempts.length === 0) return undefined;
  const succeeded = attempts.filter((attempt) => RECOVERED.has(attempt.outcome.status)).length;
  return {
    attempts,
    succeeded,
    failed: attempts.length - succeeded,
    learned: result.cognitive?.recoveredPlans.length ?? 0,
    historyReused: attempts.filter((attempt) => attempt.selected?.source === 'HISTORY').length,
  };
}

function intelligenceOf(result: ExplorationResult): IntelligenceRunAnalysis | undefined {
  const ai = result.ai;
  if (!ai) return undefined;
  const hypothesesProposed = (result.cognitive?.hypothesisDetails ?? []).filter(
    (detail) => detail.origin === 'AI_PROPOSAL',
  ).length;
  const decisive = ai.aiAssistedRecoveries > 0 || ai.runtimeConfirmed > 0;
  return {
    mode: ai.mode,
    provider: ai.provider,
    ...(ai.available !== undefined ? { available: ai.available } : {}),
    ...(ai.unavailableReason ? { unavailableReason: ai.unavailableReason } : {}),
    calls: ai.calls,
    proposals: ai.proposals,
    accepted: ai.accepted,
    rejected: ai.rejected,
    runtimeConfirmed: ai.runtimeConfirmed,
    runtimeContradicted: ai.runtimeContradicted,
    aiAssistedRecoveries: ai.aiAssistedRecoveries,
    fallbacks: ai.fallbacks,
    contribution: decisive ? 'DECISIVE' : ai.accepted > 0 || hypothesesProposed > 0 ? 'ADVISORY' : 'NONE',
    hypothesesProposed,
  };
}

function testDataOf(flows: readonly FlowRunReport[]): TestDataAnalysis | undefined {
  const entries = flows
    .filter((flow) => (flow.testDataReport?.entries.length ?? 0) > 0 || flow.businessProof)
    .map((flow) => ({
      flow: flow.name,
      entries: (flow.testDataReport?.entries ?? []).map((entry) => ({
        key: entry.key,
        strategy: entry.strategy,
        ...(entry.generator ? { generator: entry.generator } : {}),
        ...(entry.producedAt !== undefined ? { producedAt: entry.producedAt } : {}),
        uses: entry.usedBy.length,
      })),
      ...(flow.businessProof && flow.businessProof.status !== 'NOT_APPLICABLE'
        ? {
            proof: {
              status: flow.businessProof.status,
              ...(flow.businessProof.key ? { key: flow.businessProof.key } : {}),
              missing: flow.businessProof.missing,
            },
          }
        : {}),
    }));
  return entries.length > 0 ? { flows: entries } : undefined;
}

function networkOf(result: ExplorationResult): NetworkAnalysis | undefined {
  const all = result.flows.flatMap((flow) =>
    flow.steps.flatMap((step) =>
      (step.network?.requests ?? []).map((request) => ({ flow: flow.name, step: step.index, request })),
    ),
  );
  if (all.length === 0) return undefined;
  const byStatusClass: Record<string, number> = {};
  for (const { request } of all) {
    const key = request.failure
      ? 'failed'
      : request.status !== undefined
        ? `${String(Math.floor(request.status / 100))}xx`
        : 'pending';
    byStatusClass[key] = (byStatusClass[key] ?? 0) + 1;
  }
  return {
    requests: all.length,
    writes: all.filter(({ request }) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)).length,
    errors: all.filter(({ request }) => (request.status ?? 0) >= 400 || request.failure).length,
    byStatusClass,
    failures: all
      .filter(({ request }) => (request.status ?? 0) >= 400 || request.failure)
      .map(({ flow, step, request }) => ({
        flow,
        step,
        method: request.method,
        path: request.path,
        ...(request.status !== undefined ? { status: request.status } : {}),
        ...(request.failure ? { failure: request.failure } : {}),
      })),
    slowest: [...all]
      .filter(({ request }) => request.durationMs !== undefined)
      .sort((a, b) => (b.request.durationMs ?? 0) - (a.request.durationMs ?? 0))
      .slice(0, 5)
      .map(({ flow, step, request }) => ({
        flow,
        step,
        method: request.method,
        path: request.path,
        durationMs: request.durationMs ?? 0,
      })),
    blockedWrites: result.blockedWrites?.length ?? 0,
  };
}

function driftOf(result: ExplorationResult): WorkflowDriftAnalysis | undefined {
  const flows = result.flows
    .filter((flow) => flow.drift || flow.comparison)
    .map((flow) => ({
      flow: flow.name,
      detected: flow.drift?.detected ?? false,
      classification: flow.drift?.classification ?? 'NO_DRIFT',
      result: flow.drift?.result ?? flow.status,
      ...(flow.drift ? { facts: { ...flow.drift.facts } } : {}),
      explanation: flow.drift?.explanation ?? [],
      suggestedFiles: flow.drift?.suggestedFiles ?? [],
      ...(flow.comparison
        ? {
            comparison: {
              verdict: flow.comparison.verdict,
              changes: flow.comparison.changes.length,
              durationDeltaMs: flow.comparison.durationDeltaMs,
            },
          }
        : {}),
    }));
  const regression = result.regression;
  if (flows.length === 0 && !regression?.evolution && !regression?.anomalies) return undefined;
  return {
    flows,
    ...(regression?.evolution || regression?.anomalies
      ? {
          regression: {
            changes: regression.evolution?.changes.length ?? 0,
            disappeared: regression.evolution?.disappeared ?? 0,
            anomalies: { ...(regression.anomalies?.counts ?? {}) },
          },
        }
      : {}),
  };
}

function coverageOf(result: ExplorationResult): FunctionalCoverageAnalysis | undefined {
  const cognitive = result.cognitive;
  const functional = result.functional?.coverage;
  if (!cognitive && !functional) return undefined;
  return {
    covered: cognitive?.coverage ?? [],
    gaps: cognitive?.coverageGaps ?? [],
    ...(functional
      ? {
          functional: {
            workflows: functional.workflows,
            transitions: functional.transitions,
            invariants: functional.invariants,
            sideEffects: functional.sideEffects,
            goals: { ...functional.goals },
          },
        }
      : {}),
  };
}

function knowledgeOf(result: ExplorationResult): KnowledgeAnalysis | undefined {
  const cognitive = result.cognitive;
  const historical = result.intelligence?.historicalKnowledge;
  if (!cognitive && !historical) return undefined;
  return {
    evidence: cognitive?.knowledge.evidence ?? 0,
    hypotheses: cognitive?.knowledge.hypotheses ?? 0,
    confirmed: cognitive?.knowledge.confirmed ?? 0,
    contradicted: cognitive?.knowledge.contradicted ?? 0,
    confirmedRelations: cognitive?.confirmedRelations ?? [],
    recoveriesLearned: cognitive?.recoveredPlans.length ?? 0,
    ...(historical
      ? {
          historical: {
            transitions: historical.transitions,
            levels: { ...historical.levels },
            aged: historical.aged,
          },
        }
      : {}),
    ...(result.intelligence?.knowledge ? { runs: result.intelligence.knowledge.runs } : {}),
  };
}

function failuresOf(result: ExplorationResult): FailureAnalysis[] {
  const understood = (result.cognitive?.failures ?? []).map((failure) => ({
    step: failure.step,
    class: failure.class,
    reason: failure.reason,
    ...(failure.context?.expected ? { expected: failure.context.expected } : {}),
    ...(failure.context ? { observed: failure.context.observed } : {}),
    ...(failure.context?.firstDivergence ? { firstDivergence: failure.context.firstDivergence } : {}),
  }));
  if (understood.length > 0) return understood;
  return result.flows.flatMap((flow) =>
    flow.steps
      .filter((step) => step.status === 'FAILED' || step.status === 'BLOCKED')
      .map((step) => ({
        flow: flow.name,
        step: `step ${String(step.index)} "${step.description}"`,
        class: step.status === 'BLOCKED' ? 'BLOCKED_BY_POLICY' : (step.effect?.status ?? 'STEP_FAILED'),
        reason: step.reason ?? step.status,
      })),
  );
}

function recommendationsOf(
  result: ExplorationResult,
  analysis: Pick<RunAnalysis, 'rootCause' | 'recovery'>,
): RunRecommendation[] {
  const items: RunRecommendation[] = [];
  for (const flow of result.flows) {
    if (flow.drift?.flowUpdateSuggested)
      items.push({
        kind: 'FLOW_UPDATE',
        message: `${flow.name}: ${flow.drift.classification} — review ${flow.drift.suggestedFiles?.join(', ') ?? 'the suggested flow'} (the original flow is never rewritten)`,
        origin: 'FlowDrift',
        flow: flow.name,
      });
    for (const suggestion of flow.testDataSuggestions ?? [])
      items.push({ kind: 'TEST_DATA', message: suggestion, origin: 'RuntimeLearning', flow: flow.name });
    if (
      flow.businessProof &&
      (flow.businessProof.status === 'PARTIAL' || flow.businessProof.status === 'NOT_PROVEN')
    )
      items.push({
        kind: 'INVESTIGATE',
        message: `${flow.name}: business proof ${flow.businessProof.status} — ${flow.businessProof.missing.join('; ') || 'see the proof'}`,
        origin: 'BusinessProof',
        flow: flow.name,
      });
    for (const step of flow.steps) {
      for (const suggestion of step.suggestions ?? [])
        items.push({
          kind: 'STEP_FIX',
          message: `${flow.name} step ${String(step.index)}: ${suggestion}`,
          origin: 'TargetSuggester',
          flow: flow.name,
          step: step.index,
        });
      if (step.effect?.healed)
        items.push({
          kind: 'FLOW_UPDATE',
          message: `${flow.name} step ${String(step.index)}: locator healed ${step.effect.healed.from} → ${step.effect.healed.to} (a suggestion, never a rewrite)`,
          origin: 'LocatorHealing',
          flow: flow.name,
          step: step.index,
        });
      if (step.recordingModelDivergence)
        items.push({
          kind: 'FLOW_UPDATE',
          message: `${flow.name} step ${String(step.index)}: recorded expectations ${step.recordingModelDivergence.suspectEffects.join(', ')} describe a later step — re-record or trim them`,
          origin: 'WrongEffectAnalyzer',
          flow: flow.name,
          step: step.index,
        });
      if (step.status === 'BLOCKED')
        items.push({
          kind: 'SAFETY',
          message: `${flow.name} step ${String(step.index)}: ${step.reason ?? 'blocked by the safety policy'}`,
          origin: 'SafetyPolicy',
          flow: flow.name,
          step: step.index,
        });
    }
  }
  for (const gap of result.cognitive?.coverageGaps ?? [])
    items.push({ kind: 'COVERAGE', message: gap, origin: 'FunctionalCoverage' });
  for (const analysisEntry of result.cognitive?.contradictedAnalysis ?? [])
    if (analysisEntry.needsAnalysis || analysisEntry.investigation !== 'none')
      items.push({
        kind: 'INVESTIGATE',
        message: `${analysisEntry.description}: ${analysisEntry.why}${analysisEntry.investigation !== 'none' ? ` — ${analysisEntry.investigation}` : ''}`,
        origin: 'HypothesisEngine',
      });
  if (analysis.rootCause && !analysis.rootCause.recoverable)
    items.push({
      kind: 'INVESTIGATE',
      message: `root cause ${analysis.rootCause.category} is not recoverable by the crawler (rights, session or application behaviour): check it by hand`,
      origin: 'DivergenceAnalyzer',
      flow: analysis.rootCause.flow,
      step: analysis.rootCause.step,
    });
  if (analysis.recovery && analysis.recovery.succeeded > 0)
    items.push({
      kind: 'KNOWLEDGE',
      message: `${String(analysis.recovery.succeeded)} recovery(ies) confirmed by the next step: kept in the knowledge base, re-verified at every run`,
      origin: 'RecoveryMemory',
    });
  return items;
}

function verdictOf(
  result: ExplorationResult,
  parts: Pick<RunAnalysis, 'rootCause' | 'recovery' | 'firstDivergence'>,
): { status: RunVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const flows = result.flows;
  if (flows.length === 0) {
    reasons.push(
      'no imposed flow: the verdict is the one of the anomalies found by the autonomous exploration',
    );
    return { status: 'EXPLORED', reasons };
  }
  const steps = flows.flatMap((flow) => flow.steps);
  const blocked =
    flows.some((flow) => flow.status === 'BLOCKED') || steps.some((step) => step.status === 'BLOCKED');
  const blockingCause =
    parts.rootCause && !parts.rootCause.recoverable && BLOCKING_CATEGORIES.has(parts.rootCause.category);
  if (blocked || blockingCause) {
    reasons.push(
      blockingCause
        ? `root cause ${parts.rootCause?.category ?? ''} (rights, session): never bypassed`
        : 'a step was refused by the safety policy (allow: MUTATION / DANGEROUS missing, or blocked by the mission)',
    );
    return { status: 'BLOCKED', reasons };
  }
  const failed = flows.filter((flow) => flow.status === 'FAILED');
  if (failed.length > 0) {
    const inconclusive =
      failed.every((flow) => flow.drift?.result === 'INCONCLUSIVE') ||
      (failed.length > 0 && !parts.firstDivergence && !parts.rootCause);
    if (inconclusive && !parts.firstDivergence) {
      reasons.push(`${String(failed.length)} flow(s) failed without an identified divergence nor cause`);
      return { status: 'INCONCLUSIVE', reasons };
    }
    reasons.push(
      `${String(failed.length)} flow(s) failed: ${parts.firstDivergence ? `first divergence at step ${String(parts.firstDivergence.step)} (${parts.firstDivergence.kind})` : 'see the steps'}${parts.rootCause ? ` · probable cause ${parts.rootCause.category} (${String(parts.rootCause.confidence)})` : ''}${parts.recovery ? ` · ${String(parts.recovery.failed)} recovery(ies) failed` : ' · no safe recovery attempted'}`,
    );
    return { status: 'DIVERGED', reasons };
  }
  const recovered = parts.recovery && parts.recovery.succeeded > 0;
  const healed = steps.some(
    (step) => step.effect?.healed || step.targetResolution?.status === 'TARGET_HEALED',
  );
  const unverified = steps.filter(isUnverified);
  const doubt =
    unverified.length > 0
      ? `${String(unverified.length)} step(s) executed without a verified effect: ${unverified
          .slice(0, 3)
          .map(
            (step) =>
              `step ${String(step.index)} (${step.effect?.status ?? 'RECORDED_EXPECTATION_CONTAMINATED'})`,
          )
          .join(', ')}`
      : undefined;
  if (recovered || healed) {
    reasons.push(
      recovered
        ? `${String(parts.recovery?.succeeded ?? 0)} goal recovery(ies) confirmed by the next step${healed ? ', and a locator healed' : ''}`
        : 'a locator was healed (the recorded one no longer matched): the flow passed through the healed target',
    );
    return { status: 'PASSED_WITH_RECOVERY', reasons };
  }
  const proofs = flows.map((flow) => flow.businessProof?.status).filter((status) => status !== undefined);
  const proven = proofs.filter((status) => status === 'PROVEN').length;
  const applicable = proofs.filter((status) => status !== 'NOT_APPLICABLE').length;
  if (applicable > 0 && proven === applicable) {
    // La preuve par les données l'emporte sur un effet d'écran non vérifié : le doute est noté, pas le verdict.
    reasons.push(
      `every flow passed as recorded and the business proof is made (${String(proven)} CREATE → SEARCH → OPEN proven)`,
    );
    if (doubt) reasons.push(`${doubt} — the data proof outweighs it`);
    return { status: 'PROVEN', reasons };
  }
  if (doubt) {
    reasons.push(doubt);
    return { status: 'PASSED_UNVERIFIED', reasons };
  }
  if (applicable > 0) {
    reasons.push(
      `every flow passed, but the business proof is ${proofs.filter((status) => status !== 'PROVEN' && status !== 'NOT_APPLICABLE').join(', ')}: the goal is not proven by the data`,
    );
    return { status: 'INCONCLUSIVE', reasons };
  }
  reasons.push(
    'every flow passed as recorded, every verified effect confirmed; no business proof was applicable',
  );
  return { status: 'PASSED', reasons };
}

function headlineOf(status: RunVerdict, summary: Omit<RunSummary, 'headline'>): string {
  const flows = `${String(summary.flows.passed)}/${String(summary.flows.total)} flow(s) passed`;
  switch (status) {
    case 'PROVEN':
      return `Goal proven: ${flows}, the created data was found and opened.`;
    case 'PASSED':
      return `Passed: ${flows}, every verified effect confirmed.`;
    case 'PASSED_WITH_RECOVERY':
      return `Passed with recovery: ${flows}, ${String(summary.recoveries.succeeded)} recovery(ies) confirmed.`;
    case 'PASSED_UNVERIFIED':
      return `Passed technically, ${String(summary.steps.unverified)} step(s) without a verified effect.`;
    case 'DIVERGED':
      return `Diverged: ${String(summary.flows.failed)} flow(s) failed, ${String(summary.divergences)} divergence(s), ${String(summary.recoveries.failed)} recovery(ies) failed.`;
    case 'BLOCKED':
      return `Blocked: ${String(summary.flows.blocked + summary.steps.blocked)} refusal(s) by the safety policy, the rights or the session.`;
    case 'INCONCLUSIVE':
      return `Inconclusive: ${flows}, the functional goal could not be judged.`;
    case 'EXPLORED':
      return `Autonomous exploration: ${String(summary.issuesBySeverity.CRITICAL + summary.issuesBySeverity.ERROR)} blocking issue(s).`;
  }
}

function explainabilityOf(
  result: ExplorationResult,
  analysis: Omit<RunAnalysis, 'explainability'>,
): ExplainabilitySummary {
  const chain: ExplainabilitySummary['chain'] = [];
  const flows = result.flows;
  const goal = analysis.functionalTimeline.goal ?? result.cognitive?.mission;
  chain.push({
    stage: 'INTENT',
    text:
      flows.length > 0
        ? `${String(flows.length)} imposed flow(s) to run as recorded${goal ? `, goal ${goal}` : ''}${analysis.testData ? `, with ${String(analysis.testData.flows.reduce((sum, flow) => sum + flow.entries.length, 0))} test datum(s) resolved for this run` : ''}.`
        : `autonomous exploration of ${result.target.baseUrl}${goal ? `, goal ${goal}` : ''}.`,
    evidence: flows.map((flow) => `${flow.name}: ${String(flow.steps.length)} step(s)`),
  });
  const s = analysis.summary;
  chain.push({
    stage: 'OBSERVED',
    text: `${String(s.steps.passed)}/${String(s.steps.total)} step(s) passed, ${String(s.steps.failed)} failed, ${String(s.steps.blocked)} blocked, ${String(s.steps.unverified)} without a verified effect; ${String(s.mutations.executed)} write(s)${analysis.networkAnalysis ? `, ${String(analysis.networkAnalysis.requests)} request(s) (${String(analysis.networkAnalysis.errors)} error(s))` : ''}.`,
    evidence: analysis.functionalTimeline.checkpoints
      .filter((checkpoint) => checkpoint.status === 'CONFIRMED')
      .map((checkpoint) => `checkpoint ${checkpoint.id} confirmed`),
  });
  if (analysis.firstDivergence) {
    const d = analysis.firstDivergence;
    chain.push({
      stage: 'DIVERGENCE',
      text: `first divergence at ${d.flow} step ${String(d.step)} (${d.kind}): ${d.reason}${d.symptomStep !== undefined ? ` — reported at step ${String(d.symptomStep)}, the root is earlier` : ''}.`,
      evidence: [
        ...d.expected.map((item) => `expected ${item}`),
        ...d.observed.map((item) => `observed ${item}`),
        ...(d.technicalSymptom ? [`technical symptom ${d.technicalSymptom}`] : []),
        ...d.earlierNetworkErrors.map((item) => `earlier request error: ${item}`),
      ],
    });
  } else
    chain.push({
      stage: 'DIVERGENCE',
      text: 'no divergence: the journey produced the expected effects.',
      evidence: [],
    });
  if (analysis.rootCause) {
    const cause = analysis.rootCause;
    chain.push({
      stage: 'ROOT_CAUSE',
      text: `probable cause ${cause.category} (confidence ${String(cause.confidence)})${cause.functional ? `, functional cause ${cause.functional.category}` : ''}${cause.failureClass ? `, failure class ${cause.failureClass}` : ''}${cause.recoverable ? '' : ' — not recoverable by the crawler'}.`,
      evidence: [
        ...cause.evidence.map((evidence) => `${evidence.source}: ${evidence.detail}`),
        ...cause.missingPrerequisites.map((item) => `missing prerequisite ${item}`),
        ...(cause.blockedGoal ? cause.blockedGoal.blockingReasons : []),
      ],
    });
  }
  const related = analysis.hypotheses.filter((hypothesis) => hypothesis.relatedToDivergence);
  if (analysis.hypotheses.length > 0)
    chain.push({
      stage: 'HYPOTHESES',
      text: `${String(analysis.hypotheses.length)} hypothesis(es)${related.length > 0 ? `, ${String(related.length)} about the divergence` : ''}: ${Object.entries(
        analysis.hypotheses.reduce<Record<string, number>>(
          (counts, hypothesis) => ({ ...counts, [hypothesis.status]: (counts[hypothesis.status] ?? 0) + 1 }),
          {},
        ),
      )
        .map(([status, count]) => `${String(count)} ${status}`)
        .join(', ')}.`,
      evidence: (related.length > 0 ? related : analysis.hypotheses)
        .slice(0, 5)
        .map(
          (hypothesis) =>
            `${hypothesis.id} ${hypothesis.status} (${String(hypothesis.confidence)}): ${hypothesis.proposition} — ${String(hypothesis.evidenceFor)} for / ${String(hypothesis.evidenceAgainst)} against`,
        ),
    });
  if (analysis.recovery) {
    const r = analysis.recovery;
    chain.push({
      stage: 'RECOVERY',
      text: `${String(r.attempts.length)} recovery attempt(s): ${String(r.succeeded)} reached the goal, ${String(r.failed)} did not${r.attempts.some((attempt) => attempt.aiAssisted) ? ' (one assisted by the intelligence advisor, validated and confirmed at runtime)' : ''}.`,
      evidence: r.attempts.map(
        (attempt) =>
          `${attempt.flow} step ${String(attempt.step)}: ${attempt.selected ? `chose ${attempt.selected.signature} from ${attempt.selected.source} because ${attempt.selected.reasons.join('; ')}` : `plan ${attempt.planStatus}, ${String(attempt.candidates)} candidate(s), ${String(attempt.rejected.length)} rejected`} → ${attempt.outcome.status}`,
      ),
    });
    chain.push({
      stage: 'VERIFICATION',
      text: r.attempts.some((attempt) => attempt.verified === true)
        ? 'the next step of the journey passed after the recovery: the strong confirmation.'
        : r.succeeded > 0
          ? 'the goal was reached but the next step did not confirm it yet.'
          : 'nothing to verify: no recovery reached its goal.',
      evidence: r.attempts
        .filter((attempt) => attempt.outcome.confirmedCategory)
        .map(
          (attempt) => `confirmed ${attempt.outcome.confirmedCategory ?? ''} at step ${String(attempt.step)}`,
        ),
    });
  } else if (analysis.firstDivergence)
    chain.push({
      stage: 'RECOVERY',
      text: 'no safe recovery was attempted (no candidate, or the cause forbids it).',
      evidence: [],
    });
  if (flows.length > 0) {
    const after = analysis.firstDivergence
      ? flows
          .filter((flow) => flow.name === analysis.firstDivergence?.flow)
          .flatMap((flow) => flow.steps.filter((step) => step.index > (analysis.firstDivergence?.step ?? 0)))
      : [];
    chain.push({
      stage: 'CONTINUATION',
      text: analysis.firstDivergence
        ? `after the divergence: ${String(after.filter((step) => step.status === 'PASSED').length)} step(s) passed, ${String(after.filter((step) => step.status === 'SKIPPED').length)} skipped, ${String(after.filter((step) => step.status === 'FAILED').length)} failed.`
        : 'the journey continued to its end.',
      evidence: [],
    });
  }
  if (analysis.workflowDrift)
    chain.push({
      stage: 'DRIFT',
      text: analysis.workflowDrift.flows.some((flow) => flow.detected)
        ? `drift detected: ${analysis.workflowDrift.flows
            .filter((flow) => flow.detected)
            .map((flow) => `${flow.flow} ${flow.classification}`)
            .join(', ')}.`
        : `no drift${analysis.workflowDrift.flows.some((flow) => flow.comparison) ? `; compared with the previous run: ${analysis.workflowDrift.flows.map((flow) => `${flow.flow} ${flow.comparison?.verdict ?? ''}`).join(', ')}` : ''}.`,
      evidence: analysis.workflowDrift.flows.flatMap((flow) => flow.explanation),
    });
  if (analysis.functionalCoverage)
    chain.push({
      stage: 'COVERAGE',
      text: `${String(analysis.functionalCoverage.covered.length)} covered item(s), ${String(analysis.functionalCoverage.gaps.length)} gap(s).`,
      evidence: analysis.functionalCoverage.gaps.slice(0, 5),
    });
  if (analysis.knowledge)
    chain.push({
      stage: 'LEARNING',
      text: `${String(analysis.knowledge.evidence)} evidence(s), ${String(analysis.knowledge.confirmed)} hypothesis(es) confirmed, ${String(analysis.knowledge.contradicted)} contradicted, ${String(analysis.knowledge.recoveriesLearned)} recovery(ies) learned.`,
      evidence: analysis.knowledge.confirmedRelations.slice(0, 5),
    });
  if (analysis.intelligence)
    chain.push({
      stage: 'INTELLIGENCE',
      text: `intelligence advisor ${analysis.intelligence.mode}: ${String(analysis.intelligence.calls)} call(s), ${String(analysis.intelligence.accepted)} proposal(s) accepted, ${String(analysis.intelligence.runtimeConfirmed)} confirmed at runtime — contribution ${analysis.intelligence.contribution}.`,
      evidence: analysis.intelligence.unavailableReason ? [analysis.intelligence.unavailableReason] : [],
    });
  chain.push({ stage: 'VERDICT', text: analysis.summary.headline, evidence: [] });
  return { chain, verdictReasons: [] };
}

/** L'analyse d'un run : relie ce que les moteurs ont produit et rend un verdict fonctionnel. */
export function buildRunAnalysis(result: ExplorationResult): RunAnalysis {
  const flows = result.flows;
  const steps = flows.flatMap((flow) => flow.steps);
  const firstDivergence = firstDivergenceOf(result);
  const rootCause = rootCauseOf(result, firstDivergence);
  const recovery = recoveryOf(result);
  const hypotheses = hypothesesOf(result, firstDivergence);
  const proofs = flows
    .map((flow) => flow.businessProof?.status)
    .filter((status) => status !== undefined && status !== 'NOT_APPLICABLE');
  const verdict = verdictOf(result, { rootCause, recovery, firstDivergence });
  const count = (status: FlowStepReport['status']): number =>
    steps.filter((step) => step.status === status).length;
  const base: Omit<RunSummary, 'headline'> = {
    mission: result.mission,
    mode: result.mode,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    flows: {
      total: flows.length,
      passed: flows.filter((flow) => flow.status === 'PASSED').length,
      failed: flows.filter((flow) => flow.status === 'FAILED').length,
      blocked: flows.filter((flow) => flow.status === 'BLOCKED').length,
    },
    steps: {
      total: steps.length,
      passed: count('PASSED'),
      failed: count('FAILED'),
      blocked: count('BLOCKED'),
      skipped: count('SKIPPED'),
      manual: count('MANUAL'),
      unverified: steps.filter(isUnverified).length,
    },
    recoveries: {
      attempted: recovery?.attempts.length ?? 0,
      succeeded: recovery?.succeeded ?? 0,
      failed: recovery?.failed ?? 0,
    },
    divergences: flows.filter((flow) => flow.divergence).length + (result.cognitive?.divergences.length ?? 0),
    issuesBySeverity: { ...result.stats.issuesBySeverity },
    mutations: {
      executed: result.mutations?.executed ?? 0,
      autonomous: result.mutations?.autonomous ?? 0,
      flows: result.mutations?.flows ?? 0,
    },
    ...(proofs.length > 0
      ? {
          businessProof: {
            proven: proofs.filter((status) => status === 'PROVEN').length,
            partial: proofs.filter((status) => status === 'PARTIAL').length,
            notProven: proofs.filter((status) => status === 'NOT_PROVEN').length,
          },
        }
      : {}),
    ...(result.ai
      ? {
          intelligence: {
            calls: result.ai.calls,
            accepted: result.ai.accepted,
            assistedRecoveries: result.ai.aiAssistedRecoveries,
          },
        }
      : {}),
  };
  const summary: RunSummary = { ...base, headline: headlineOf(verdict.status, base) };
  const cognitive = result.cognitive;
  const functionalTimeline: FunctionalTimeline = {
    ...(cognitive?.goal ? { goal: cognitive.goal } : {}),
    ...(cognitive?.functionalState ? { functionalState: cognitive.functionalState } : {}),
    ...(cognitive?.missingChain ? { missingChain: cognitive.missingChain } : {}),
    ...(cognitive?.currentPlan ? { currentPlan: cognitive.currentPlan } : {}),
    checkpoints: (cognitive?.checkpoints ?? []).map((checkpoint) => ({
      id: checkpoint.id,
      status: checkpoint.status,
    })),
    progress: cognitive?.progressTimeline ?? [],
    businessProofs: flows
      .filter((flow) => flow.businessProof && flow.businessProof.status !== 'NOT_APPLICABLE')
      .map((flow) => ({
        flow: flow.name,
        status: flow.businessProof?.status ?? '',
        ...(flow.businessProof?.key ? { key: flow.businessProof.key } : {}),
      })),
    workflows: (result.functional?.workflows ?? []).map((workflow) => workflow.id),
  };
  const partial: Omit<RunAnalysis, 'explainability'> = {
    runId: result.runId ?? '',
    status: verdict.status,
    summary,
    executionTimeline: executionTimeline(flows),
    functionalTimeline,
    ...(firstDivergence ? { firstDivergence } : {}),
    ...(rootCause ? { rootCause } : {}),
    hypotheses,
    ...(recovery ? { recovery } : {}),
    ...(intelligenceOf(result) ? { intelligence: intelligenceOf(result) } : {}),
    ...(testDataOf(flows) ? { testData: testDataOf(flows) } : {}),
    ...(networkOf(result) ? { networkAnalysis: networkOf(result) } : {}),
    ...(driftOf(result) ? { workflowDrift: driftOf(result) } : {}),
    ...(coverageOf(result) ? { functionalCoverage: coverageOf(result) } : {}),
    ...(knowledgeOf(result) ? { knowledge: knowledgeOf(result) } : {}),
    failures: failuresOf(result),
    checkpoints: functionalTimeline.checkpoints,
    recommendations: recommendationsOf(result, { rootCause, recovery }),
  };
  const explainability = explainabilityOf(result, partial);
  explainability.verdictReasons = verdict.reasons;
  return { ...partial, explainability };
}
