import { normalize } from '../flows/action-effect-verifier.js';
import type {
  DivergenceAnalysis,
  Evidence,
  FunctionalGoal,
  RecoveryAction,
  RecoveryBudgets,
  RecoveryCandidate,
  RecoveryCandidateSource,
  RecoveryPlan,
  RecoveryScoreFactors,
  RejectedCandidate,
  SafetyClass,
  ScreenControl,
  WorkflowActionContext,
} from './model.js';
import { labelSimilarity, RECOVERY_ROLES, REVEALING_ROLES, round } from './similarity.js';

/** Une récupération apprise, pondérée (âge, version, échecs) : un CANDIDAT, jamais une vérité. */
export interface HistoricalRecovery {
  actions: RecoveryAction[];
  /** 0..1 après vieillissement et contexte. */
  weight: number;
  successes: number;
  failures: number;
  detail: string;
}

export interface SafetyJudgement {
  risk: SafetyClass;
  allowed: boolean;
  reason: string;
}

export interface PlannerInput {
  analysis: DivergenceAnalysis;
  context: WorkflowActionContext;
  goal: FunctionalGoal;
  original: { label: string; role?: string };
  controls: readonly ScreenControl[];
  /** Contrôles apparus après l'étape précédente : souvent la prochaine chose à faire. */
  recentlyAppeared?: ReadonlySet<string>;
  history?: readonly HistoricalRecovery[];
  /** Le code source relie-t-il ce contrôle aux champs de l'objectif ? (suggère, ne prouve pas) */
  staticEvidence?: (control: ScreenControl) => Evidence | undefined;
  /** Le graphe des dépendances de champs relie-t-il ce contrôle aux champs de l'objectif ? */
  dependencyEvidence?: (control: ScreenControl) => Evidence | undefined;
  /** La SafetyPolicy : passage obligé, jamais contourné par un score. */
  judge: (control: ScreenControl, kind: RecoveryAction['kind']) => SafetyJudgement;
  budgets: Pick<RecoveryBudgets, 'maxCandidates'>;
  /** stop : deux candidats trop proches → AMBIGUOUS ; experiment : essayer le moins coûteux (SAFE). */
  onAmbiguity: 'stop' | 'experiment';
  /** Signatures à ne jamais proposer (cibles des étapes précédentes, déjà essayées). */
  exclude?: ReadonlySet<string>;
  synonyms?: (term: string) => readonly string[];
}

export function actionSignature(action: RecoveryAction): string {
  return `${action.kind} ${action.role}:${action.name.toLowerCase()}`;
}

export function pathSignature(actions: readonly RecoveryAction[]): string {
  return actions.map(actionSignature).join(' → ');
}

/** La même clé que les effets observés (controlsOf) : « button:company interview ». */
export function controlKey(control: Pick<ScreenControl, 'role' | 'name'>): string {
  return `${control.role}:${normalize(control.name)}`;
}

/**
 * RECOVERY SCORE, au même endroit pour tous les candidats :
 *
 *   + similarité sémantique + progression attendue + effet attendu + contexte du parcours
 *   + preuve statique + succès historique + preuve runtime
 *   − risque − ambiguïté − instabilité − coût
 *
 * Le score ORDONNE les candidats ; il n'autorise rien (SafetyPolicy) et ne prouve rien
 * (seul l'objectif vérifié au runtime confirme).
 */
export function scoreRecoveryCandidate(factors: RecoveryScoreFactors): number {
  const score =
    0.35 * factors.semanticSimilarity +
    0.15 * factors.goalProgress +
    0.1 * factors.expectedEffectMatch +
    0.15 * factors.workflowContextMatch +
    0.15 * factors.staticEvidence +
    0.3 * factors.historicalSuccess +
    0.1 * factors.runtimeEvidence -
    factors.safetyRisk -
    factors.ambiguityPenalty -
    factors.instabilityPenalty -
    0.05 * Math.max(0, factors.actionCost - 1);
  return round(Math.max(0, Math.min(1, score)));
}

const RISK_PENALTY: Record<SafetyClass, number> = { SAFE: 0, UNKNOWN: 0.5, MUTATION: 1, DANGEROUS: 1 };

/** Les raisons lisibles d'un candidat (WHY DID YOU CHOOSE THIS?). */
export function reasonsOf(candidate: RecoveryCandidate): string[] {
  const reasons: string[] = [];
  const f = candidate.factors;
  if (f.semanticSimilarity >= 0.3)
    reasons.push(`+ semantic similarity with the recorded action (${f.semanticSimilarity})`);
  if (f.workflowContextMatch >= 0.3)
    reasons.push(`+ matches what the next steps need (${f.workflowContextMatch})`);
  if (f.expectedEffectMatch > 0) reasons.push('+ appeared after the previous step');
  if (f.staticEvidence > 0) reasons.push('+ static source links it to the goal');
  if (f.historicalSuccess > 0)
    reasons.push(`+ a previous recovery succeeded (weight ${f.historicalSuccess})`);
  if (f.instabilityPenalty > 0) reasons.push(`- previous failures (penalty ${f.instabilityPenalty})`);
  if (f.ambiguityPenalty > 0) reasons.push('- another candidate is as close');
  if (f.actionCost > 1) reasons.push(`- ${String(f.actionCost)} actions`);
  reasons.push(`+ action classified ${candidate.risk}`);
  for (const evidence of candidate.evidence)
    if (evidence.source === 'STATIC' || evidence.source === 'DEPENDENCY' || evidence.source === 'HISTORY')
      reasons.push(`  ${evidence.source.toLowerCase()}: ${evidence.detail}`);
  return reasons;
}

/**
 * RECOVERY PLANNER : des candidats pour atteindre l'objectif fonctionnel, à partir de
 * l'écran courant, de l'historique, du code source et des dépendances de champs.
 * Chaque candidat passe par la SafetyPolicy (un candidat non SAFE est écarté, avec sa raison) ;
 * deux candidats aussi plausibles l'un que l'autre ne sont pas départagés au hasard.
 */
export function planRecovery(input: PlannerInput): RecoveryPlan {
  const rejected: RejectedCandidate[] = [];
  const candidates: RecoveryCandidate[] = [];
  const reasons: string[] = [];
  const exclude = input.exclude ?? new Set<string>();
  if (!input.analysis.recoverable) {
    return {
      goal: input.goal,
      candidates: [],
      rejected: [],
      status: 'NO_SAFE_RECOVERY',
      truncated: 0,
      reasons: [
        `${input.analysis.category}: no recovery is attempted (never bypass an authorization or hide a regression)`,
      ],
    };
  }
  if (input.goal.predicates.length === 0) {
    return {
      goal: input.goal,
      candidates: [],
      rejected: [],
      status: 'NO_SAFE_RECOVERY',
      truncated: 0,
      reasons: ['no functional goal could be inferred (no learned effect, no next step to make possible)'],
    };
  }
  const goalLabels = input.goal.predicates.map((predicate) => predicate.value.toLowerCase());
  const futureLabels = input.context.requiredFutureFields.map((field) => field.label);
  const opening = input.context.currentAction.kind === 'click';

  // Historique : un chemin appris est un candidat (re-vérifié), jamais une vérité.
  for (const recovery of input.history ?? []) {
    const signature = pathSignature(recovery.actions);
    if (recovery.actions.length === 0 || exclude.has(signature)) continue;
    // L'historique ne contourne pas la SafetyPolicy : chaque action du chemin est rejugée.
    const verdicts = recovery.actions.map((action) =>
      input.judge({ role: action.role, name: action.name, visible: true, disabled: false }, action.kind),
    );
    const refused = verdicts.find((verdict) => !verdict.allowed || verdict.risk !== 'SAFE');
    if (refused) {
      rejected.push({ signature, risk: refused.risk, reason: `history: ${refused.reason}` });
      continue;
    }
    const factors: RecoveryScoreFactors = {
      semanticSimilarity: Math.max(
        ...recovery.actions.map((action) =>
          labelSimilarity(action.name, input.original.label, input.synonyms),
        ),
      ),
      goalProgress: 1,
      expectedEffectMatch: 0,
      workflowContextMatch: 0,
      staticEvidence: 0,
      historicalSuccess: round(recovery.weight),
      runtimeEvidence: 0,
      safetyRisk: 0,
      ambiguityPenalty: 0,
      instabilityPenalty: round(
        recovery.failures > 0 ? (0.3 * recovery.failures) / (recovery.failures + recovery.successes) : 0,
      ),
      actionCost: recovery.actions.length,
    };
    candidates.push(
      candidate(recovery.actions, 'HISTORY', factors, 'SAFE', [
        { source: 'HISTORY', detail: recovery.detail, weight: recovery.weight },
      ]),
    );
  }

  for (const control of input.controls) {
    if (!control.visible || control.disabled || control.field) continue;
    if (!RECOVERY_ROLES.has(control.role) || !control.name) continue;
    if (control.role === 'tab' && control.selected === true) continue;
    if ((control.role === 'checkbox' || control.role === 'radio') && control.checked === true) continue;
    const name = control.name.toLowerCase();
    if (goalLabels.includes(name)) continue; // l'objectif lui-même, pas un chemin vers lui
    const kind: RecoveryAction['kind'] =
      control.role === 'checkbox' || control.role === 'radio' ? 'check' : 'click';
    const action: RecoveryAction = { kind, role: control.role, name: control.name };
    const signature = actionSignature(action);
    if (exclude.has(signature) || exclude.has(controlKey(control))) continue;
    if (candidates.some((existing) => existing.signature === signature)) continue;
    const verdict = input.judge(control, kind);
    if (!verdict.allowed || verdict.risk !== 'SAFE') {
      rejected.push({ signature, risk: verdict.risk, reason: verdict.reason });
      continue;
    }
    const semanticSimilarity = labelSimilarity(control.name, input.original.label, input.synonyms);
    const futureMatch = futureLabels.length
      ? Math.max(...futureLabels.map((label) => labelSimilarity(control.name, label)))
      : 0;
    const roleFit =
      (opening && REVEALING_ROLES.has(control.role) ? 0.2 : 0) +
      (control.expanded === false ? 0.2 : 0) +
      (control.role === 'tab' && control.selected === false ? 0.1 : 0);
    const evidence: Evidence[] = [];
    const statics = input.staticEvidence?.(control);
    if (statics) evidence.push(statics);
    const dependency = input.dependencyEvidence?.(control);
    if (dependency) evidence.push(dependency);
    const appeared = input.recentlyAppeared?.has(controlKey(control)) ?? false;
    const factors: RecoveryScoreFactors = {
      semanticSimilarity,
      goalProgress: semanticSimilarity >= 0.5 ? 0.6 : 0.3,
      expectedEffectMatch: appeared ? 0.5 : 0,
      workflowContextMatch: round(Math.min(1, futureMatch * 0.8 + roleFit)),
      staticEvidence: round(Math.min(1, (statics?.weight ?? 0) + (dependency?.weight ?? 0))),
      historicalSuccess: 0,
      runtimeEvidence: 0,
      safetyRisk: RISK_PENALTY[verdict.risk],
      ambiguityPenalty: 0,
      instabilityPenalty: 0,
      actionCost: 1,
    };
    candidates.push(
      candidate(
        [action],
        statics ? 'STATIC_ANALYSIS' : dependency ? 'DEPENDENCY_GRAPH' : 'CURRENT_UI',
        factors,
        verdict.risk,
        [{ source: 'RUNTIME', detail: `"${control.role}:${control.name}" on screen` }, ...evidence],
      ),
    );
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score || a.estimatedCost - b.estimatedCost || a.signature.localeCompare(b.signature),
  );

  // AMBIGUITY : deux candidats proches, sans preuve qui les départage → ne pas choisir au hasard.
  let ambiguous = false;
  const [first, second] = candidates;
  if (first && second) {
    const decisive = (c: RecoveryCandidate): boolean =>
      c.factors.historicalSuccess > 0 || c.factors.staticEvidence > 0;
    if (
      first.factors.semanticSimilarity >= 0.45 &&
      second.factors.semanticSimilarity >= 0.45 &&
      first.score - second.score < 0.08 &&
      !decisive(first) &&
      !decisive(second)
    ) {
      ambiguous = true;
      for (const tied of [first, second]) {
        tied.factors.ambiguityPenalty = 0.1;
        tied.score = scoreRecoveryCandidate(tied.factors);
        tied.confidence = tied.score;
      }
      reasons.push(
        `"${first.signature}" and "${second.signature}" are equally plausible (${String(first.score)} / ${String(second.score)})`,
      );
    }
  }
  const truncated = Math.max(0, candidates.length - input.budgets.maxCandidates);
  const kept = candidates.slice(0, input.budgets.maxCandidates);
  if (truncated > 0) reasons.push(`${String(truncated)} candidate(s) left out by the budget (maxCandidates)`);
  if (rejected.length > 0)
    reasons.push(`${String(rejected.length)} candidate(s) rejected by the SafetyPolicy`);
  const status =
    kept.length === 0
      ? 'NO_SAFE_RECOVERY'
      : ambiguous && input.onAmbiguity === 'stop'
        ? 'AMBIGUOUS'
        : 'PLANNED';
  return {
    goal: input.goal,
    candidates: kept,
    rejected,
    ...(status === 'PLANNED' && kept[0] ? { selectedCandidate: kept[0] } : {}),
    status,
    truncated,
    reasons,
  };
}

function candidate(
  actions: RecoveryAction[],
  source: RecoveryCandidateSource,
  factors: RecoveryScoreFactors,
  risk: SafetyClass,
  evidence: Evidence[],
): RecoveryCandidate {
  const score = scoreRecoveryCandidate(factors);
  return {
    signature: pathSignature(actions),
    actions,
    source,
    confidence: score,
    estimatedCost: actions.length,
    risk,
    expectedGoalProgress: factors.goalProgress,
    evidence,
    score,
    factors,
  };
}
