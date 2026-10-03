/**
 * WORKFLOW SELF-HEALING — le modèle.
 *
 *   « Le bouton X est introuvable »   →   « Que devait accomplir X ? Qu'exige la suite du
 *   parcours ? Pourquoi n'y sommes-nous pas ? Quelle action SÛRE y mène ? L'objectif est-il
 *   atteint ? Le parcours d'origine peut-il continuer ? »
 *
 * RECOVER THE INTENT, NOT JUST THE LOCATOR. Le runtime confirme toujours ; l'historique et
 * le code source suggèrent seulement ; la SafetyPolicy a toujours le dernier mot.
 */

import type { FlowTarget } from '../config/flow-schema.js';
import type { ExpectedTargetAnalysis } from './expected-target.js';

export const DIVERGENCE_CATEGORIES = [
  'TARGET_MOVED',
  'TARGET_RENAMED',
  'TARGET_REPLACED',
  'TARGET_NOT_RENDERED',
  'TARGET_DISABLED',
  'TARGET_HIDDEN',
  'PARENT_SECTION_CLOSED',
  'WRONG_TAB_SELECTED',
  'WRONG_WORKFLOW_STATE',
  'PREREQUISITE_MISSING',
  'ASYNC_DATA_NOT_READY',
  'NETWORK_DEPENDENCY_NOT_READY',
  'OVERLAY_BLOCKING',
  'LOCATOR_STALE',
  'ROUTE_CHANGED',
  'COMPONENT_RESTRUCTURED',
  'AUTH_STATE_CHANGED',
  'ROLE_PERMISSION_CHANGED',
  'BUSINESS_RULE_CHANGED',
  'APPLICATION_BEHAVIOR_CHANGED',
  'RECORDED_FLOW_OBSOLETE',
  'EXPECTED_EFFECT_CHANGED',
  'AMBIGUOUS_UI',
  'UNKNOWN_DIVERGENCE',
] as const;
export type DivergenceCategory = (typeof DIVERGENCE_CATEGORIES)[number];

/** D'où vient une preuve. STATIC et HISTORY suggèrent ; seul RUNTIME confirme. */
export type EvidenceSource =
  'RUNTIME' | 'NETWORK' | 'CONTEXT' | 'RECORDING' | 'STATIC' | 'HISTORY' | 'DEPENDENCY' | 'SAFETY';

export interface Evidence {
  source: EvidenceSource;
  /** Texte court en anglais, jamais une valeur saisie. */
  detail: string;
  /** Contribution signée au score (+ pour, − contre). */
  weight?: number;
}

/** Ce que l'échec a été, techniquement (le SYMPTÔME). */
export type DivergenceSymptom =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_MISMATCH'
  | 'TARGET_DISABLED'
  | 'NO_EFFECT'
  | 'WRONG_EFFECT'
  | 'MUTATION_AMBIGUOUS'
  | 'EXECUTION_ERROR';

/** Un contrôle visible (ou présent mais masqué) à l'écran : ce que l'analyse et le planificateur voient. */
export interface ScreenControl {
  role: string;
  name: string;
  tag?: string;
  visible: boolean;
  disabled: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  inNavigation?: boolean;
  /** Champ de saisie (textbox, combobox…) : jamais une action de récupération. */
  field?: boolean;
  /** Le composant (statique) qui affiche le contrôle, s'il est connu. */
  component?: string;
}

export interface FunctionalState {
  route: string;
  /** Contrôles visibles (rôle:nom), 30 au plus : une description, jamais des valeurs. */
  controls: string[];
  selectedTabs?: string[];
}

export interface RootCauseCandidate {
  category: DivergenceCategory;
  /** 0..1 — une hypothèse faible n'est jamais présentée comme une certitude. */
  confidence: number;
  evidence: Evidence[];
}

export interface WorkflowPrerequisite {
  label: string;
  kind: 'CONTROL' | 'FIELD' | 'STEP';
  reason: string;
}

export interface DivergenceAnalysis {
  actionId: string;
  stepIndex: number;
  symptom: DivergenceSymptom;
  category: DivergenceCategory;
  confidence: number;
  evidence: Evidence[];
  expectedState?: FunctionalState;
  observedState?: FunctionalState;
  missingPrerequisites?: WorkflowPrerequisite[];
  possibleCauses: RootCauseCandidate[];
  /** La PREMIÈRE divergence fonctionnelle (peut précéder l'étape qui a échoué). */
  rootStepIndex: number;
  /** Le symptôme TECHNIQUE tel que rapporté (TARGET_FINGERPRINT_MISMATCH…) : jamais la cause. */
  technicalSymptom?: string;
  /** La cible attendue comprise (présence, section parente, préconditions). */
  expectedTarget?: ExpectedTargetAnalysis;
  /** La cause FONCTIONNELLE la plus probable (précondition, section, état du parcours). */
  functionalRootCause?: RootCauseCandidate;
  /**
   * Faux : la cause interdit toute récupération (droits, session, comportement de l'application) :
   * on ne contourne ni une autorisation, ni une régression.
   */
  recoverable: boolean;
}

/** Une étape du parcours, vue par son sens (jamais par sa valeur saisie). */
export interface SemanticAction {
  index: number;
  kind: 'click' | 'check' | 'uncheck' | 'fill' | 'select' | 'goto' | 'expect' | 'other';
  label: string;
  role?: string;
  /** Le libellé est celui d'un champ (fill/select/check) : une exigence pour la suite. */
  field?: boolean;
  /** La cible enregistrée (pour vérifier un champ sans nom accessible : css, test id). */
  target?: FlowTarget;
}

export interface BusinessIntent {
  /** OPEN_COMPANY_INFORMATION, SELECT_EUR, ENTER_COMPANY_NAME… */
  name: string;
  confidence: IntentConfidence;
  sources: string[];
}

export type IntentConfidence = 'CONFIRMED' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNRESOLVED';

export interface WorkflowActionContext {
  previousActions: SemanticAction[];
  currentAction: SemanticAction;
  nextActions: SemanticAction[];
  /** Effets appris à l'enregistrement (appears/disappears/route/request), en texte. */
  expectedEffects: string[];
  businessIntent?: BusinessIntent;
  requiredFutureControls: SemanticAction[];
  requiredFutureFields: SemanticAction[];
  currentFunctionalState?: FunctionalState;
}

export type GoalPredicateKind =
  'VISIBLE_CONTROL' | 'VISIBLE_FIELD' | 'CONTROL_AVAILABLE' | 'ROUTE' | 'ABSENT_CONTROL';

export interface GoalPredicate {
  kind: GoalPredicateKind;
  /** role:nom pour un contrôle, libellé pour un champ, modèle de route. */
  value: string;
  role?: string;
  /** Vient d'où : effet appris, étape suivante, effet de route… */
  source: string;
  /**
   * Le localisateur enregistré de la cible : un champ sans nom accessible (css #valueInput) se
   * vérifie par lui, jamais par un « libellé » qui serait un sélecteur.
   */
  target?: FlowTarget;
}

export type GoalSource = 'EXPECTED_EFFECTS' | 'NEXT_ACTIONS' | 'ACTION_LABEL' | 'STATIC' | 'HISTORY';

export interface FunctionalGoal {
  /** COMPANY_INFORMATION_AVAILABLE */
  id: string;
  predicates: GoalPredicate[];
  confidence: number;
  level: IntentConfidence;
  source: GoalSource[];
}

export interface GoalProgress {
  goal: string;
  /** 0..1 */
  progress: number;
  status: 'REACHED' | 'PARTIAL' | 'NOT_REACHED';
  satisfied: string[];
  missing: string[];
}

/** Une action de récupération : jamais une saisie, jamais une action qui écrit. */
export interface RecoveryAction {
  kind: 'click' | 'check';
  role: string;
  name: string;
}

export type RecoveryCandidateSource =
  | 'CURRENT_UI'
  | 'STATIC_ANALYSIS'
  | 'HISTORY'
  | 'DEPENDENCY_GRAPH'
  | 'FLOW_GRAPH'
  | 'BUSINESS_RULE'
  /** Une proposition du conseiller d'intelligence, validée, autorisée et confirmée au runtime. */
  | 'AI_PROPOSAL'
  /** Une action du parcours humain qui révélait la cible (précondition à rétablir). */
  | 'HUMAN_JOURNEY';

export type SafetyClass = 'SAFE' | 'MUTATION' | 'DANGEROUS' | 'UNKNOWN';

/** Les facteurs du score (centralisés dans scoreRecoveryCandidate). */
export interface RecoveryScoreFactors {
  semanticSimilarity: number;
  goalProgress: number;
  expectedEffectMatch: number;
  workflowContextMatch: number;
  staticEvidence: number;
  historicalSuccess: number;
  runtimeEvidence: number;
  safetyRisk: number;
  ambiguityPenalty: number;
  instabilityPenalty: number;
  actionCost: number;
}

export interface RecoveryCandidate {
  /** Signature stable (rôle:nom des actions), pour la mémoire et l'anti-boucle. */
  signature: string;
  actions: RecoveryAction[];
  source: RecoveryCandidateSource;
  confidence: number;
  estimatedCost: number;
  risk: SafetyClass;
  expectedGoalProgress: number;
  evidence: Evidence[];
  score: number;
  factors: RecoveryScoreFactors;
}

export interface RejectedCandidate {
  signature: string;
  risk: SafetyClass;
  reason: string;
}

export type RecoveryPlanStatus = 'PLANNED' | 'NO_SAFE_RECOVERY' | 'AMBIGUOUS' | 'EXECUTED' | 'CONFIRMED';

export interface RecoveryPlan {
  goal: FunctionalGoal;
  candidates: RecoveryCandidate[];
  rejected: RejectedCandidate[];
  selectedCandidate?: RecoveryCandidate;
  status: RecoveryPlanStatus;
  /** Candidats laissés de côté par le budget (maxCandidates). */
  truncated: number;
  reasons: string[];
}

export interface RecoveryBudgets {
  maxRecoveryActions: number;
  maxRecoveryDepth: number;
  maxCandidates: number;
  maxRecoveryDurationMs: number;
  maxSafeExperiments: number;
  /**
   * Pertinence minimale d'un candidat quand la cible est absente fonctionnellement : un contrôle
   * sans lien avec l'objectif ne consomme pas le budget (défaut 0.15).
   */
  minCandidateRelevance?: number;
}

export type AttemptResult =
  'GOAL_REACHED' | 'PARTIAL' | 'UNLOCKED' | 'NO_EFFECT' | 'NOT_FOUND' | 'FAILED' | 'SKIPPED_VISITED';

export interface RecoveryAttempt {
  path: string;
  source: RecoveryCandidateSource;
  result: AttemptResult;
  progress: number;
  restored?: boolean;
  detail?: string;
}

export type GoalRecoveryStatus =
  | 'GOAL_REACHED'
  | 'GOAL_ALREADY_REACHED'
  | 'NO_SAFE_RECOVERY'
  | 'AMBIGUOUS_RECOVERY'
  | 'RECOVERY_BUDGET_EXHAUSTED'
  | 'NOT_ATTEMPTED';

/** Le rôle d'une action dans une récupération confirmée. */
export type RecoveryRole = 'INSERTED_PREREQUISITE' | 'REPLACEMENT';

export interface RecoveryOutcome {
  status: GoalRecoveryStatus;
  /** Les actions exécutées qui ont atteint l'objectif (dans l'ordre). */
  path: (RecoveryAction & { part: RecoveryRole })[];
  pathSource?: RecoveryCandidateSource;
  attempts: RecoveryAttempt[];
  progress?: GoalProgress;
  experiments: number;
  actionsExecuted: number;
  durationMs: number;
  /** Ce qui a été confirmé : TARGET_RENAMED, TARGET_REPLACED, INSERTED_PREREQUISITE… */
  confirmedCategory?: DivergenceCategory;
  reasons: string[];
}

/** Ce que le rapport garde de chaque étape récupérée (provenance complète). */
export interface StepRecoveryReport {
  originalActionId: string;
  originalTarget: string;
  originalRole?: string;
  divergence: DivergenceAnalysis;
  context: {
    previous: string[];
    next: string[];
    requiredFields: string[];
    intent?: BusinessIntent;
  };
  goal: FunctionalGoal;
  plan: {
    status: RecoveryPlanStatus;
    candidates: {
      signature: string;
      source: RecoveryCandidateSource;
      score: number;
      risk: SafetyClass;
      reasons: string[];
    }[];
    rejected: RejectedCandidate[];
    truncated: number;
  };
  outcome: RecoveryOutcome;
  selected?: { signature: string; source: RecoveryCandidateSource; reasons: string[]; risk: SafetyClass };
  goalVerification?: GoalProgress;
  /** L'étape suivante du parcours a réussi après la récupération (confirmation forte). */
  nextActionVerified?: boolean;
  applicationVersion?: string;
}

export const REPLAY_RESULTS = [
  'PASS_EXACT',
  'PASS_WITH_LOCATOR_HEALING',
  'PASS_WITH_GOAL_RECOVERY',
  'PASS_WITH_WORKFLOW_DRIFT',
  'FAIL_NO_SAFE_RECOVERY',
  'FAIL_BUSINESS_DIVERGENCE',
  'FAILED',
  'INCONCLUSIVE',
] as const;
export type ReplayResult = (typeof REPLAY_RESULTS)[number];

export type DriftClassification =
  | 'NO_DRIFT'
  | 'MINOR_UI_DRIFT'
  | 'STRUCTURAL_UI_DRIFT'
  | 'WORKFLOW_DRIFT'
  | 'POSSIBLE_BUSINESS_RULE_DRIFT'
  | 'POSSIBLE_REGRESSION'
  | 'INCONCLUSIVE';

/** Les FAITS de la dérive (pas un score opaque). */
export interface FlowDriftFacts {
  totalActions: number;
  exactActions: number;
  locatorHealedActions: number;
  goalRecoveredActions: number;
  insertedRuntimeActions: number;
  obsoleteCandidates: number;
  changedEffects: number;
  ambiguousActions: number;
  unverifiedActions: number;
  renamedTargets: number;
  replacedTargets: number;
}

export interface FlowDriftReport {
  detected: boolean;
  classification: DriftClassification;
  result: ReplayResult;
  facts: FlowDriftFacts;
  explanation: string[];
  /** Fichiers proposés (jamais le flow d'origine) : suggested.flow.yaml, suggested.feature. */
  suggestedFiles?: string[];
  flowUpdateSuggested: boolean;
}

export const HEALING_EVENTS = [
  'DIVERGENCE_ANALYSIS_STARTED',
  'DIVERGENCE_CLASSIFIED',
  'ROOT_CAUSE_CANDIDATE_IDENTIFIED',
  'WORKFLOW_CONTEXT_RESOLVED',
  'FUNCTIONAL_GOAL_INFERRED',
  'RECOVERY_PLAN_CREATED',
  'RECOVERY_CANDIDATE_EVALUATED',
  'RECOVERY_CANDIDATE_REJECTED',
  'GOAL_RECOVERY_STARTED',
  'GOAL_PROGRESS_UPDATED',
  'GOAL_REACHED',
  'GOAL_RECOVERY_FAILED',
  'RECOVERY_KNOWLEDGE_LEARNED',
  'FLOW_DRIFT_DETECTED',
  'PREREQUISITE_DISCOVERED',
  'SUGGESTED_FLOW_UPDATE_CREATED',
  'EXPECTED_TARGET_ANALYZED',
  'TARGET_RESOLUTION',
  'TARGET_RERENDERED',
  'AI_TARGET_RESOLUTION_REQUEST',
  'AI_TARGET_RESOLUTION_PROPOSAL',
  'AI_PROPOSAL_RUNTIME_VALIDATED',
  'AI_PROPOSAL_RUNTIME_REJECTED',
] as const;
export type HealingEvent = (typeof HEALING_EVENTS)[number];

export interface HealingEventRecord {
  at: string;
  event: HealingEvent;
  message: string;
}
