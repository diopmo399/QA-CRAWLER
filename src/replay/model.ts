/**
 * INTENT-DRIVEN REPLAY — le modèle.
 *
 *   « Rejouer une liste de clics »   →   « Rejouer un OBJECTIF : savoir où le parcours en est
 *   (position fonctionnelle), ce qui est CONFIRMÉ (checkpoints), ce qu'une action EXIGE
 *   (préconditions, dépendances), quelle action SÛRE y mène (planificateur), et avec quelle
 *   CONFIANCE on peut continuer. »
 *
 * Tout ici est pur (testable sans navigateur). Le runtime confirme toujours ; l'historique
 * suggère ; un clic réussi n'est jamais un succès en soi (execution ≠ effect ≠ functional state).
 */

import type { StepFunctionalIntent } from '../config/flow-schema.js';
import type { FunctionalState, GoalPredicate } from '../workflow-healing/model.js';

/** D'où vient un checkpoint fonctionnel. */
export type CheckpointSource =
  'EXPECTED_EFFECTS' | 'FUNCTIONAL_INTENT' | 'EXPECT_STEP' | 'NEXT_ACTION' | 'ROUTE' | 'FLOW_END';

export type CheckpointStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';

/**
 * Un état métier / UI que le parcours doit avoir atteint APRÈS une étape : « résultats affichés »,
 * « formulaire d'édition ouvert ». Un prédicat au moins ; tous vérifiés au runtime.
 */
export interface FunctionalCheckpoint {
  /** CP3_SEARCH_EXECUTED : stable d'un run à l'autre (position + intention). */
  id: string;
  label: string;
  /** L'étape (1..n) après laquelle le checkpoint doit tenir. */
  afterStep: number;
  predicates: CheckpointPredicate[];
  source: CheckpointSource[];
  /** Un checkpoint faible (une seule source heuristique) n'arrête jamais le parcours. */
  strength: 'STRONG' | 'WEAK';
}

export type CheckpointPredicate =
  | GoalPredicate
  | { kind: 'REQUEST'; value: string; source: string }
  | { kind: 'TEXT'; value: string; source: string }
  | { kind: 'ABSENT_ROUTE'; value: string; source: string };

export interface CheckpointResult {
  id: string;
  status: CheckpointStatus;
  /** Prédicats tenus / manquants (texte). */
  satisfied: string[];
  missing: string[];
  /** 0..1 : la part des prédicats tenus. */
  progress: number;
  reasons: string[];
}

/** Ce que l'observation runtime donne à évaluer (jamais une valeur saisie). */
export interface ObservedFunctionalState extends FunctionalState {
  /** Contrôles disponibles ET activés (rôle:nom). */
  enabledControls?: string[];
  /** Champs (libellés) visibles. */
  fields?: string[];
  /** Les requêtes de la fenêtre (« GET /api/items 200 »). */
  requests?: string[];
  /** Un extrait du texte visible (jamais une valeur de champ). */
  text?: string;
  /** Un dialogue ouvert. */
  dialog?: string;
  /** Un overlay bloquant (chargement, modal) : son nom. */
  overlay?: string;
  /** Les champs remplis par le parcours encore tenus / perdus (libellés). */
  filledHeld?: string[];
  filledLost?: string[];
}

export type PreconditionKind =
  | 'TARGET_PRESENT'
  | 'TARGET_ENABLED'
  | 'FIELD_FILLED'
  | 'ROUTE'
  | 'NO_OVERLAY'
  | 'CHECKPOINT'
  | 'DIALOG_OPEN'
  | 'TEST_DATA';

/** Ce qu'une action exige AVANT d'être exécutée (« Can I execute this action? »). */
export interface StepPrecondition {
  kind: PreconditionKind;
  /** Le contrôle, le champ, la route, le checkpoint ou la clé de donnée. */
  value: string;
  /** HARD : non satisfaite, l'action n'est pas exécutée (enforce). SOFT : signalée seulement. */
  severity: 'HARD' | 'SOFT';
  /** L'étape (1..n) qui devait l'établir, si elle est connue. */
  establishedBy?: number;
  reason: string;
}

export interface PreconditionCheck {
  precondition: StepPrecondition;
  satisfied: boolean | undefined;
  detail: string;
}

/** Une dépendance fonctionnelle : l'étape `step` exige que `requires` ait réussi, et pourquoi. */
export interface StepDependency {
  step: number;
  requires: number;
  kind: 'FILLS_FIELD' | 'REVEALS_TARGET' | 'REACHES_ROUTE' | 'OPENS_DIALOG' | 'PRODUCES_DATA' | 'PRECEDES';
  reason: string;
}

/** Pourquoi une précondition n'est pas satisfaite : la chaîne remontée jusqu'à l'étape racine. */
export interface PreconditionExplanation {
  precondition: StepPrecondition;
  /** L'étape la plus en amont qui n'a pas tenu sa part (ou l'étape courante si aucune). */
  rootStep: number;
  /** « SELECT_ITEM requires SEARCH_ITEM (step 3) requires field Name (step 2) ». */
  chain: { step: number; label: string; held: boolean | undefined }[];
  reasons: string[];
}

export type PhaseVerdict = 'SUCCESS' | 'FAILED' | 'NOT_VERIFIED' | 'NOT_REQUIRED' | 'SKIPPED';

/**
 * Le résultat TRANSACTIONNEL d'une étape : exécution → cible → effet → état fonctionnel.
 * { execution: SUCCESS, effect: FAILED, functionalState: UNCHANGED } est un ÉCHEC, quoi que
 * dise Playwright.
 */
export interface ReplayStepVerdict {
  preconditions: 'SATISFIED' | 'UNMET' | 'NOT_CHECKED';
  execution: PhaseVerdict;
  target: 'CORRECT' | 'HEALED' | 'PLANNED' | 'MISMATCH' | 'NOT_FOUND' | 'NOT_VERIFIED';
  effect: PhaseVerdict;
  functionalState: 'SUCCESS' | 'UNCHANGED' | 'DIVERGED' | 'NOT_VERIFIED' | 'NOT_REQUIRED';
  /** COMMITTED : tout tient ; ROLLED_BACK : une phase a échoué (la position ne progresse pas). */
  outcome: 'COMMITTED' | 'COMMITTED_WITH_DOUBT' | 'ROLLED_BACK';
}

/** La confiance du rejeu, par dimension puis combinée. Jamais silencieux sous le seuil. */
export interface ReplayConfidence {
  target: number;
  intent: number;
  preconditions: number;
  effect: number;
  state: number;
  overall: number;
  /** Faux : le rapport et les événements doivent le dire (même si l'étape est PASSED). */
  continueSilently: boolean;
  reasons: string[];
}

export type PlanChoice = 'RECORDED' | 'HISTORICAL' | 'SEMANTIC' | 'NONE';

export interface PlanCandidate {
  role: string;
  name: string;
  source: PlanChoice;
  score: number;
  reasons: string[];
}

/** Ce que le planificateur propose pour une étape : jamais exécuté par lui. */
export interface ReplayPlan {
  goal: string;
  choice: PlanChoice;
  selected?: PlanCandidate;
  candidates: PlanCandidate[];
  /** AMBIGUOUS : deux candidats aussi plausibles — rien n'est choisi arbitrairement. */
  ambiguous: boolean;
  reasons: string[];
}

export interface ReplayDivergence {
  stepIndex: number;
  /** Entre quel checkpoint confirmé et quel checkpoint manquant la divergence se situe. */
  window: { from?: string; to?: string };
  symptom: string;
  /** L'étape racine d'après les préconditions / dépendances (peut précéder stepIndex). */
  rootStep?: number;
  reasons: string[];
}

/** La POSITION FONCTIONNELLE du rejeu : où en est le parcours, et qu'est-ce qui est prouvé. */
export interface ReplayPosition {
  flowId: string;
  /** L'étape en cours (1..n), 0 avant la première. */
  stepIndex: number;
  confirmedCheckpoints: string[];
  currentIntent?: StepFunctionalIntent;
  expectedState?: FunctionalState;
  observedState?: FunctionalState;
  lastConfirmedAction?: number;
  lastConfirmedCheckpoint?: string;
  divergence?: ReplayDivergence;
  /** Le prochain checkpoint attendu. */
  nextCheckpoint?: string;
}

/** Ce que le rapport garde par étape (FlowStepReport.replay). */
export interface ReplayStepReport {
  position: ReplayPosition;
  preconditions: PreconditionCheck[];
  dependencies: StepDependency[];
  explanation?: PreconditionExplanation;
  plan?: ReplayPlan;
  verdict: ReplayStepVerdict;
  confidence: ReplayConfidence;
  checkpoints: CheckpointResult[];
}

/** Ce que le rapport garde par flow (FlowRunReport.replay). */
export interface FlowReplayReport {
  checkpoints: (FunctionalCheckpoint & { result?: CheckpointResult })[];
  dependencies: StepDependency[];
  finalPosition: ReplayPosition;
  divergence?: ReplayDivergence;
  /** Les étapes dont la confiance est sous le seuil (jamais silencieuses). */
  lowConfidenceSteps: number[];
  /** Moyenne des confiances combinées des étapes exécutées. */
  overallConfidence: number;
  /** Les résolutions apprises pendant ce run (original → résolu). */
  learned: string[];
}

export const REPLAY_EVENTS = [
  'REPLAY_POSITION',
  'CHECKPOINT_CONFIRMED',
  'CHECKPOINT_FAILED',
  'CHECKPOINT_INCONCLUSIVE',
  'PRECONDITION_NOT_MET',
  'PRECONDITION_ROOT_LOCATED',
  'REPLAY_PLAN',
  'REPLAY_PLAN_AMBIGUOUS',
  'REPLAY_LOW_CONFIDENCE',
  'REPLAY_STEP_COMMITTED',
  'REPLAY_STEP_ROLLED_BACK',
  'RESOLUTION_LEARNED',
  'RESOLUTION_PROPOSED',
] as const;
export type ReplayEvent = (typeof REPLAY_EVENTS)[number];
