import type { FlowConfig, FlowStep } from '../config/flow-schema.js';
import type { EvidenceReference, EvidenceType } from './evidence.js';
import {
  holds,
  type CandidateAction,
  type ConditionContext,
  type GoalGraph,
  type GoalNode,
} from './goal-graph.js';

// ------------------------------------------------------------------ checkpoints

export type CheckpointStatus = 'NOT_REACHED' | 'PARTIAL' | 'CONFIRMED' | 'CONTRADICTED';

export interface EvidenceRequirement {
  /** Signaux indépendants exigés (un faits DOM par champ, l'envoi…) : jamais l'URL seule. */
  minSignals: number;
  types: EvidenceType[];
}

/** SEMANTIC CHECKPOINT : un état MÉTIER important (COMPANY_INFORMATION_COMPLETE, REQUEST_READY…). */
export interface SemanticCheckpoint {
  id: string;
  /** Les conditions du graphe d'objectifs qui le composent. */
  predicates: string[];
  evidenceRequirements: EvidenceRequirement[];
  status: CheckpointStatus;
  evidence: EvidenceReference[];
  reachedAt?: string;
}

/** Les checkpoints d'un graphe d'objectifs : chaque objectif (phase complète, prêt, terminé). */
export function checkpointsOf(graph: GoalGraph): SemanticCheckpoint[] {
  return graph.nodes
    .filter((node) => node.kind === 'GOAL' || node.kind === 'MISSION')
    .map((node) => ({
      id: node.id,
      predicates: [node.id, ...node.requires],
      evidenceRequirements: [
        { minSignals: Math.max(1, Math.min(2, node.requires.length)), types: ['DOM', 'RUNTIME', 'NETWORK'] },
      ],
      status: 'NOT_REACHED' as const,
      evidence: [],
    }));
}

/**
 * CHECKPOINTS > URL : un checkpoint est CONFIRMÉ quand ses conditions sont vraies ET que
 * suffisamment de signaux d'écran indépendants le montrent ; une interface restructurée
 * qui atteint le même état métier atteint le même checkpoint. Un checkpoint confirmé puis
 * démenti par l'écran devient CONTRADICTED (jamais effacé en silence).
 */
export function evaluateCheckpoint(
  checkpoint: SemanticCheckpoint,
  graph: GoalGraph,
  context: ConditionContext,
  now: string,
): SemanticCheckpoint {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const results = checkpoint.predicates.map((id) => {
    const node = byId.get(id);
    return node ? holds(node, context) : undefined;
  });
  const [self] = results;
  const signals = (context.situation?.evidence ?? []).filter((reference) =>
    checkpoint.evidenceRequirements.some((requirement) => requirement.types.includes(reference.type)),
  );
  // Signaux indépendants : chaque sous-condition vérifiée à l'écran (un champ valide, la section
  // visible…) compte, et au moins une preuve observée doit exister — l'URL seule ne compte pas.
  const independent = results.slice(1).filter((value) => value === true).length + (self === true ? 1 : 0);
  const enough =
    signals.length > 0 &&
    checkpoint.evidenceRequirements.every((requirement) => independent >= requirement.minSignals);
  let status: CheckpointStatus;
  if (self === true && enough) status = 'CONFIRMED';
  else if (
    checkpoint.status === 'CONFIRMED' &&
    self === false &&
    results.slice(1).some((value) => value === false)
  )
    status = 'CONTRADICTED';
  else if (results.some((value) => value === true)) status = 'PARTIAL';
  else status = checkpoint.status === 'CONFIRMED' ? 'CONFIRMED' : 'NOT_REACHED';
  return {
    ...checkpoint,
    status,
    evidence: status === 'CONFIRMED' ? signals.slice(0, 8) : checkpoint.evidence,
    ...(status === 'CONFIRMED' && !checkpoint.reachedAt ? { reachedAt: now } : {}),
  };
}

// ------------------------------------------------------------------ plans

export type PlanKind = 'RECORDED_PLAN' | 'CURRENT_PLAN' | 'RECOVERED_PLAN' | 'SUGGESTED_PLAN';

export interface PlannedAction {
  kind: CandidateAction['kind'] | 'goto' | 'expect' | 'other';
  label: string;
  role?: string;
  /** L'objectif ou la précondition que l'action réalise. */
  intent: string;
  source: CandidateAction['source'] | 'RECORDED' | 'RECOVERY';
  /** Ce que l'action doit produire (effets appris, condition visée). */
  expectedEffects: string[];
  writes?: boolean;
  /** Index de l'étape du flow d'origine (plan enregistré, plan réparé). */
  originalIndex?: number;
}

export interface AlternativePlan {
  intent: string;
  candidates: { label: string; source: string; confidence: number; reason: string }[];
}

export interface ExecutionPlan {
  kind: PlanKind;
  mission: string;
  goal: string;
  steps: PlannedAction[];
  checkpoints: string[];
  confidence: number;
  /** Ce sur quoi le plan repose sans l'avoir prouvé (hypothèses non confirmées). */
  assumptions: { hypothesis: string; status: string; confidence: number }[];
  alternatives: AlternativePlan[];
}

const label = (step: Extract<FlowStep, { target: unknown }>): string =>
  step.target.name ?? step.target.value ?? '';

/** RECORDED_PLAN : le parcours démontré, tel quel — un plan CONNU, pas le seul possible. */
export function recordedPlan(
  flow: Pick<FlowConfig, 'name' | 'steps'>,
  mission: string,
  goal: string,
): ExecutionPlan {
  const steps: PlannedAction[] = flow.steps.map((step, index) =>
    'target' in step
      ? {
          kind: step.kind === 'fill' || step.kind === 'select' || step.kind === 'check' ? step.kind : 'click',
          label: label(step),
          ...(step.target.role ? { role: step.target.role } : {}),
          intent: `step ${String(index + 1)}`,
          source: 'RECORDED' as const,
          expectedEffects: 'effects' in step && step.effects?.appears ? [...step.effects.appears] : [],
          ...(step.allow.some((allowed) => allowed === 'MUTATION' || allowed === 'DANGEROUS')
            ? { writes: true }
            : {}),
          originalIndex: index,
        }
      : {
          kind:
            step.kind === 'goto'
              ? ('goto' as const)
              : step.kind === 'expect'
                ? ('expect' as const)
                : ('other' as const),
          label: step.kind === 'goto' ? step.url : step.kind,
          intent: `step ${String(index + 1)}`,
          source: 'RECORDED' as const,
          expectedEffects: [],
          originalIndex: index,
        },
  );
  return {
    kind: 'RECORDED_PLAN',
    mission,
    goal,
    steps,
    checkpoints: [],
    confidence: 0.9,
    assumptions: [],
    alternatives: [],
  };
}

const SOURCE_RANK: Record<CandidateAction['source'], number> = { HUMAN_FLOW: 3, MODEL: 2, CAUSAL: 1 };

/**
 * PLAN ENGINE : état fonctionnel + objectif + préconditions → un PLAN, des conditions les
 * plus profondes jusqu'à l'objectif. Chaque étape dit ce qu'elle réalise et ce qu'elle doit
 * produire ; les hypothèses non confirmées sur lesquelles il repose sont listées (assumptions),
 * et les autres candidats restent visibles (alternatives). Le plan n'exécute rien.
 */
export function planGoal(
  graph: GoalGraph,
  goalId: string,
  context: ConditionContext,
  maxDepth = 8,
): ExecutionPlan {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ordered: GoalNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const node = byId.get(id);
    if (!node || seen.has(id) || depth > maxDepth) return;
    seen.add(id);
    if (holds(node, context) === true) return;
    for (const child of node.requires) visit(child, depth + 1);
    ordered.push(node);
  };
  visit(goalId, 0);
  const steps: PlannedAction[] = [];
  const assumptions: ExecutionPlan['assumptions'] = [];
  const alternatives: AlternativePlan[] = [];
  let confidence = 1;
  for (const node of ordered) {
    const ranked = [...node.achievedBy].sort(
      (a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || b.confidence - a.confidence,
    );
    const [best, ...others] = ranked;
    if (!best) continue;
    steps.push({
      kind: best.kind,
      label: best.label,
      ...(best.role ? { role: best.role } : {}),
      intent: node.id,
      source: best.source,
      expectedEffects: [node.label],
      ...(best.writes ? { writes: true } : {}),
    });
    confidence *= best.confidence;
    if (best.hypothesis && best.hypothesis.status !== 'RUNTIME_CONFIRMED')
      assumptions.push({
        hypothesis: best.hypothesis.id,
        status: best.hypothesis.status,
        confidence: best.hypothesis.confidence,
      });
    if (others.length > 0)
      alternatives.push({
        intent: node.id,
        candidates: others.map((candidate) => ({
          label: candidate.label,
          source: candidate.source,
          confidence: candidate.confidence,
          reason: candidate.hypothesis
            ? `${candidate.hypothesis.status} hypothesis ${candidate.hypothesis.id}`
            : `${candidate.source} candidate`,
        })),
      });
  }
  return {
    kind: 'CURRENT_PLAN',
    mission: graph.mission ?? goalId,
    goal: goalId,
    steps,
    checkpoints: ordered
      .filter((node) => node.kind === 'GOAL' || node.kind === 'MISSION')
      .map((node) => node.id),
    confidence: Math.round(confidence * 1000) / 1000,
    assumptions,
    alternatives,
  };
}

// ------------------------------------------------------------------ plan repair

export interface RepairResult {
  status: 'REPAIRED' | 'UNSAFE' | 'NO_REPAIR';
  recovered?: ExecutionPlan;
  suggested?: ExecutionPlan;
  rejected: { label: string; reason: string }[];
  explanation: string[];
}

/**
 * PLAN REPAIR ENGINE : réparer le PLAN, pas seulement l'étape.
 *
 *   A → B → C → D   et l'application exige maintenant   A → B → X → Y → D
 *
 * Le remplacement vient d'une source vérifiable (récupération par objectif confirmée au
 * runtime, relation causale confirmée…) ; chaque action insérée repasse par la SafetyPolicy
 * (un remplacement qui écrirait sans que l'étape d'origine en ait le droit est refusé).
 * Le plan enregistré n'est jamais modifié : RECOVERED_PLAN (ce qui a marché) et
 * SUGGESTED_PLAN (ce qu'on propose de garder) sont des copies.
 */
export function repairPlan(
  recorded: ExecutionPlan,
  repairs: readonly { originalIndex: number; replacement: PlannedAction[]; reason: string }[],
  judge: (action: PlannedAction) => { allowed: boolean; reason: string },
): RepairResult {
  if (repairs.length === 0) return { status: 'NO_REPAIR', rejected: [], explanation: ['nothing to repair'] };
  const rejected: RepairResult['rejected'] = [];
  const explanation: string[] = [];
  const steps: PlannedAction[] = [];
  for (const step of recorded.steps) {
    const repair = repairs.find((candidate) => candidate.originalIndex === step.originalIndex);
    if (!repair) {
      steps.push({ ...step });
      continue;
    }
    for (const action of repair.replacement) {
      // Une écriture n'est permise que si l'étape d'origine pouvait écrire.
      if (action.writes && !step.writes) {
        rejected.push({ label: action.label, reason: 'writes data where the recorded step did not' });
        continue;
      }
      const verdict = judge(action);
      if (!verdict.allowed) rejected.push({ label: action.label, reason: verdict.reason });
      else steps.push({ ...action, originalIndex: step.originalIndex ?? -1, source: 'RECOVERY' });
    }
    explanation.push(
      `step ${String((step.originalIndex ?? 0) + 1)} "${step.label}" → ${repair.replacement.map((action) => `${action.kind} "${action.label}"`).join(' → ')} (${repair.reason})`,
    );
  }
  if (rejected.length > 0)
    return {
      status: 'UNSAFE',
      rejected,
      explanation: [...explanation, 'a replacement action was refused: no repaired plan'],
    };
  const recovered: ExecutionPlan = {
    ...recorded,
    kind: 'RECOVERED_PLAN',
    steps,
    assumptions: [...recorded.assumptions],
  };
  return {
    status: 'REPAIRED',
    recovered,
    suggested: { ...recovered, kind: 'SUGGESTED_PLAN' },
    rejected,
    explanation,
  };
}

/** « click "Tasks" → check "EUR" → click tab "Company" → fill "Company name" » */
export function describePlan(plan: ExecutionPlan): string {
  return plan.steps
    .map((step) => `${step.kind} ${step.role ? `${step.role} ` : ''}"${step.label}"`)
    .join(' → ');
}
