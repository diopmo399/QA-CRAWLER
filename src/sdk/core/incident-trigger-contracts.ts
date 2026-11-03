import type {
  ExperimentKind,
  Hypothesis,
  HypothesisStatus,
  Layer,
  RelationStatus,
} from './incident-contracts.js';

/**
 * DÉCOUVERTE AUTOMATIQUE DES CONDITIONS DÉCLENCHANTES — le contrat commun (SDK, serveur, Dashboard).
 *
 * L'utilisateur décrit un incident dans une zone fonctionnelle connue sans en connaître le déclencheur ;
 * QA-CRAWLER interprète la description, découvre le périmètre, explore les actions, données, états et temps,
 * détecte un blocage fonctionnel silencieux, reproduit, minimise, analyse le code Angular et vérifie des
 * hypothèses. Chaque information porte sa source : une déclaration de l'utilisateur n'est jamais une preuve.
 */

export const INFORMATION_SOURCES = [
  'USER_REPORTED',
  'AI_INFERRED',
  'STATICALLY_RESOLVED',
  'RUNTIME_OBSERVED',
  'EXPERIMENT_VERIFIED',
] as const;
export type InformationSource = (typeof INFORMATION_SOURCES)[number];

export interface SourcedText {
  text: string;
  source: InformationSource;
}

/** La description structurée d'un incident (interprète de langage naturel, français ou anglais). */
export interface IncidentBrief {
  language: 'fr' | 'en';
  rawText: string;
  application?: SourcedText;
  functionalArea?: SourcedText;
  businessAction?: SourcedText;
  symptoms: SourcedText[];
  expected?: SourcedText;
  observed?: SourcedText;
  knownConditions: SourcedText[];
  unknownConditions: SourcedText[];
  businessImpact?: SourcedText;
  dataLoss?: SourcedText;
  environment: SourcedText[];
  /** Les catégories de défaillance que la description suggère (jamais des preuves). */
  suspectedFailures: SilentFailureKind[];
  /** Mots-clés de la zone, pour la découverte du périmètre. */
  keywords: string[];
  interpretedAt: string;
}

// ── Découverte du périmètre ───────────────────────────────────────────────────────────────────

export const SCOPE_RESOURCE_KINDS = [
  'ROUTE',
  'PAGE',
  'SCENARIO',
  'COMPONENT',
  'TEMPLATE',
  'FORM',
  'SERVICE',
  'API',
  'BFF',
  'BACKEND',
  'REPOSITORY',
  'DEPENDENCY',
] as const;
export type ScopeResourceKind = (typeof SCOPE_RESOURCE_KINDS)[number];

export const SCOPE_RESOURCE_STATUSES = [
  'DISCOVERED',
  'PROPOSED',
  'AUTHORIZED',
  'DENIED',
  'INACCESSIBLE',
] as const;
export type ScopeResourceStatus = (typeof SCOPE_RESOURCE_STATUSES)[number];

export interface ScopeResource {
  id: string;
  kind: ScopeResourceKind;
  label: string;
  /** Chemin, route, nom de scénario, identifiant de symbole… */
  ref: string;
  applicationId?: string;
  status: ScopeResourceStatus;
  /** Comment la ressource a été trouvée (texte, analyse statique, scénario, navigation, réseau, trace). */
  foundBy: ('TEXT' | 'STATIC' | 'SCENARIO' | 'NAVIGATION' | 'NETWORK' | 'TRACE' | 'AI')[];
  /** Pourquoi elle est pertinente (mots-clés touchés) ; score 0 à 1. */
  relevance: number;
  reason?: string;
  /** Le refus ou l'inaccessibilité, lisible. */
  detail?: string;
}

export interface ScopeGraph {
  resources: ScopeResource[];
  edges: { from: string; to: string; kind: 'ROUTES_TO' | 'RENDERS' | 'USES' | 'CALLS' | 'SERVES' }[];
  discoveredAt: string;
}

// ── Modèle Angular ────────────────────────────────────────────────────────────────────────────

export const ANGULAR_NODE_KINDS = [
  'TEMPLATE',
  'BINDING',
  'COMPONENT',
  'HANDLER',
  'FORM',
  'CONTROL',
  'VALIDATOR',
  'SERVICE',
  'STREAM',
  'SIGNAL',
  'HTTP_CALL',
  'INTERCEPTOR',
  'ERROR_HANDLER',
  'GUARD',
  'RESOLVER',
  'DIRECTIVE',
  'LIFECYCLE',
  'API',
] as const;
export type AngularNodeKind = (typeof ANGULAR_NODE_KINDS)[number];

export interface AngularNode {
  id: string;
  kind: AngularNodeKind;
  name: string;
  applicationId: string;
  file: string;
  line: number;
  detail?: Record<string, string | number | boolean | string[]>;
}

/** Un lien Template → Component → Handler → Service → RxJS/Promise → HttpClient → Interceptor → API, avec sa provenance. */
export interface AngularLink {
  from: string;
  to: string;
  kind:
    | 'BINDS'
    | 'HANDLES'
    | 'CALLS'
    | 'SUBSCRIBES'
    | 'EMITS'
    | 'VALIDATES'
    | 'INTERCEPTS'
    | 'TARGETS'
    | 'PROVIDES';
  /** STATICALLY_RESOLVED : lu dans le code sans ambiguïté ; INFERRED : déduit (nom, convention) ; UNKNOWN. */
  status: RelationStatus;
  file: string;
  line: number;
  text?: string;
}

/**
 * LA NAVIGATION LUE DANS LE CODE : les routes (redirections, gardes), les liens des templates (`routerLink`,
 * `href` interne) avec leur libellé visible, et les titres des écrans. Elle sert à localiser un écran cible et à
 * trouver un parcours d'accès ; ce sont des indices statiques, vérifiés ensuite dans le navigateur.
 */
export interface AngularNavigation {
  routes: {
    path: string;
    component?: string;
    redirectTo?: string;
    guards: string[];
    file: string;
    line: number;
  }[];
  links: { componentId?: string; file: string; line: number; target: string; label: string }[];
  headings: { componentId: string; file: string; line: number; text: string }[];
}

export interface AngularModel {
  applicationId: string;
  /** Ce que l'application utilise réellement (lu dans le code ; absent : inconnu, jamais supposé). */
  features: {
    standalone?: boolean;
    ngModules?: boolean;
    zoneless?: boolean;
    zoneJs?: boolean;
    signals?: boolean;
    reactiveForms?: boolean;
    templateForms?: boolean;
    onPush?: boolean;
    customErrorHandler?: boolean;
    interceptors?: boolean;
    stateManagement?: string;
  };
  nodes: AngularNode[];
  links: AngularLink[];
  /** La navigation lue dans le code (routes, liens, titres) ; absente d'un modèle plus ancien. */
  navigation?: AngularNavigation;
  /** Fichiers lus, refusés, limites. */
  files: number;
  denied: string[];
  truncated: string[];
}

// ── Preuves navigateur ────────────────────────────────────────────────────────────────────────

export const RUNTIME_EVENT_KINDS = [
  'NAVIGATION',
  'ROUTE',
  'ACTION',
  'REQUEST',
  'RESPONSE',
  'REQUEST_FAILED',
  'CONSOLE',
  'PAGE_ERROR',
  'DIALOG',
  'DOM',
  'SNAPSHOT',
  'LONG_TASK',
  'SCREENSHOT',
  'NOTE',
] as const;
export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

export interface RuntimeEvent {
  id: string;
  /** Millisecondes depuis le début de l'essai. */
  t: number;
  at: string;
  kind: RuntimeEventKind;
  /** L'action en cours (index dans la séquence) quand il y en a une. */
  action?: number;
  summary: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

/** L'état observable d'un élément interactif (jamais une valeur sensible). */
export interface ElementState {
  key: string;
  role: string;
  name: string;
  enabled: boolean;
  visible: boolean;
  focused?: boolean;
  /** Valeur masquée (champs) ; absente pour les champs sensibles. */
  value?: string;
  invalid?: boolean;
  /** Les options d'une liste (libellés, bornées). */
  options?: string[];
}

export interface UiSnapshot {
  url: string;
  title: string;
  elements: ElementState[];
  overlays: number;
  /** Textes visibles de statut, alertes, chargements (bornés). */
  messages: string[];
  loading: boolean;
}

// ── Actions et séquences ──────────────────────────────────────────────────────────────────────

export const TRIGGER_ACTION_KINDS = [
  'NAVIGATE',
  'BACK',
  'RELOAD',
  'CLICK',
  'FILL',
  'CLEAR',
  'SELECT',
  'CHECK',
  'PRESS',
  'TAB',
  'OPEN_DIALOG',
  'CLOSE_DIALOG',
  'WAIT',
  'REPEAT',
] as const;
export type TriggerActionKind = (typeof TRIGGER_ACTION_KINDS)[number];

export interface TriggerAction {
  kind: TriggerActionKind;
  /** Cible : rôle et nom accessibles (« button:Enregistrer »), libellé de champ, chemin de route. */
  target?: string;
  value?: string;
  /** Les répétitions (REPEAT) ou l'attente (WAIT, ms). */
  count?: number;
  /** Comment l'action a été choisie (stratégie), pour la matrice. */
  origin?: string;
}

/** Ce qu'une action aurait dû produire, établi sur un parcours de référence. */
export interface ReactionSignature {
  request?: { method: string; path: string };
  loading?: boolean;
  validation?: boolean;
  domChange?: boolean;
  navigation?: boolean;
  message?: string;
}

export const REACTION_LEVELS = [
  'CLICKED',
  'DOM_EVENT',
  'HANDLER_RUN',
  'VALIDATION_RUN',
  'SERVICE_CALLED',
  'HTTP_EMITTED',
  'BUSINESS_RESULT',
] as const;
export type ReactionLevel = (typeof REACTION_LEVELS)[number];

export interface ObservedReaction {
  level: ReactionLevel;
  /** OBSERVED : vu ; NOT_OBSERVED : attendu et absent ; UNOBSERVABLE : impossible à voir de l'extérieur. */
  state: 'OBSERVED' | 'NOT_OBSERVED' | 'UNOBSERVABLE';
  detail?: string;
  eventIds: string[];
}

export const SILENT_FAILURE_KINDS = [
  'NO_FUNCTIONAL_REACTION_AFTER_ACTION',
  'GLOBAL_ACTION_FAILURE',
  'EVENT_HANDLER_EXCEPTION',
  'UNHANDLED_PROMISE_REJECTION',
  'FORM_SUBMISSION_NOT_TRIGGERED',
  'VALIDATION_NOT_EXECUTED',
  'HTTP_REQUEST_NOT_EMITTED',
  'UI_STATE_STUCK',
  'POSSIBLE_EVENT_INTERCEPTION',
  'POSSIBLE_CHANGE_DETECTION_FAILURE',
] as const;
export type SilentFailureKind = (typeof SILENT_FAILURE_KINDS)[number];

export interface SilentFailure {
  kind: SilentFailureKind;
  summary: string;
  /** Les événements qui le prouvent (ids), et l'action concernée. */
  eventIds: string[];
  action?: number;
  reactions: ObservedReaction[];
}

export const TRIAL_VERDICTS = [
  'FAILURE_REPRODUCED',
  'FAILURE_NOT_REPRODUCED',
  'INCONCLUSIVE',
  'ENVIRONMENT_FAILURE',
  'TEST_INFRASTRUCTURE_FAILURE',
] as const;
export type TrialVerdict = (typeof TRIAL_VERDICTS)[number];

export const EXPLORATION_STRATEGIES = [
  'REFERENCE',
  'GUIDED',
  'MODEL_BASED',
  'BOUNDARY',
  'PAIRWISE',
  'STATEFUL_SEQUENCE',
  'DIFFERENTIAL',
  'ERROR_GUIDED',
  'CODE_GUIDED',
  'AI_GUIDED',
  'MINIMIZATION',
  'REPETITION',
  'EXPERIMENT',
] as const;
export type ExplorationStrategy = (typeof EXPLORATION_STRATEGIES)[number];

/** Un essai : une séquence jouée dans le navigateur, son oracle et ses preuves. */
export interface TriggerTrial {
  id: string;
  strategy: ExplorationStrategy;
  /** Pourquoi cet essai (facteurs explorés), pour la matrice. */
  factors: Record<string, string>;
  /** Les actions préparatoires, puis la ou les sondes (actions dont la réaction est vérifiée). */
  actions: TriggerAction[];
  probes: number[];
  startedAt: string;
  finishedAt?: string;
  status: 'PLANNED' | 'RUNNING' | 'DONE' | 'ERROR' | 'CANCELLED' | 'SKIPPED';
  verdict?: TrialVerdict;
  /** Pourquoi (l'oracle), lisible. */
  reason?: string;
  failures: SilentFailure[];
  /** La première erreur de page observée (id d'événement) et son résumé. */
  firstError?: { eventId: string; t: number; summary: string; stack?: string };
  events: RuntimeEvent[];
  snapshots: { before?: UiSnapshot; after?: UiSnapshot };
  /** Combien de fois la séquence a été rejouée, et combien de fois elle a reproduit (bugs intermittents). */
  repeats?: { total: number; reproduced: number };
  /** La séquence a-t-elle déjà été jouée (même clé) ? */
  key: string;
  cost: { actions: number; durationMs: number };
  screenshots: string[];
}

// ── Investigation ─────────────────────────────────────────────────────────────────────────────

export const TRIGGER_STATES = [
  'INITIALIZING',
  'DISCOVERING_SCOPE',
  'EXPLORING_TRIGGERS',
  'FAILURE_DETECTED',
  'CONFIRMING_REPRODUCTION',
  'MINIMIZING',
  'ANALYZING_ROOT_CAUSE',
  'VERIFYING_HYPOTHESES',
  'WAITING_FOR_APPROVAL',
  'PAUSED',
  'COMPLETED',
  'INCONCLUSIVE',
  'CANCELLED',
  'FAILED',
] as const;
export type TriggerState = (typeof TRIGGER_STATES)[number];

export const TRIGGER_DEPTHS = ['QUICK', 'STANDARD', 'DEEP'] as const;
export type TriggerDepth = (typeof TRIGGER_DEPTHS)[number];

export interface TriggerBudget {
  maxDurationMs: number;
  maxTrials: number;
  maxActions: number;
  maxRepeats: number;
  maxExperiments: number;
  maxEvents: number;
  maxAiCalls: number;
  /** Navigateurs simultanés (1 par défaut). */
  maxBrowsers: number;
}

export interface TriggerUsage {
  durationMs: number;
  trials: number;
  actions: number;
  repeats: number;
  experiments: number;
  events: number;
  aiCalls: number;
}

/** La condition découverte : un facteur dont la présence change le verdict. */
export interface TriggerCondition {
  id: string;
  description: string;
  /** Les actions ou valeurs qui la réalisent. */
  actions: TriggerAction[];
  /** NECESSARY : sans elle, pas de reproduction ; CONTRIBUTING : augmente la fréquence ; CANDIDATE : corrélée. */
  role: 'NECESSARY' | 'CONTRIBUTING' | 'CANDIDATE' | 'REFUTED';
  /** Essais avec / sans la condition : reproductions / total. */
  withCondition: { reproduced: number; total: number };
  withoutCondition: { reproduced: number; total: number };
  source: InformationSource;
  trialIds: string[];
}

export interface MinimalReproduction {
  actions: TriggerAction[];
  /** Les préconditions indispensables (état, données). */
  preconditions: string[];
  /** Reproductions / rejouages de la séquence minimale. */
  frequency: { reproduced: number; total: number };
  fromTrialId: string;
  reducedFrom: number;
  trialIds: string[];
  /** D'autres séquences minimales existent peut-être : la réduction en a trouvé une. */
  note: string;
}

export interface FirstFailureAnalysis {
  lastFunctionalAction?: { trialId: string; action: number; summary: string };
  lastSuccessfulRequest?: { trialId: string; eventId: string; summary: string };
  lastNavigation?: { trialId: string; eventId: string; summary: string };
  lastStateChange?: { trialId: string; eventId: string; summary: string };
  firstError?: { trialId: string; eventId: string; summary: string; stack?: string; t: number };
  firstFailedAction?: { trialId: string; action: number; summary: string };
  propagation: string[];
  /** Les événements présents seulement dans les parcours défaillants (comparaison avec la référence). */
  onlyInFailing: { summary: string; trialIds: string[] }[];
  note: string;
}

export interface DataLossAnalysis {
  /** Les champs modifiés non enregistrés au moment du blocage (noms, jamais les valeurs sensibles). */
  unsavedFields: string[];
  /** Ce que le code montre : sauvegarde locale, brouillon, garde de navigation (avec provenance). */
  persistenceFound: { summary: string; file?: string; line?: number; source: InformationSource }[];
  /** Le déclencheur du blocage et les facteurs de la perte après F5, distingués. */
  triggerSummary?: string;
  lossFactors: string[];
  note: string;
}

export interface TriggerRunReport {
  generatedAt: string;
  sections: Record<string, string[]>;
}

export interface TriggerRun {
  id: string;
  depth: TriggerDepth;
  state: TriggerState;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  startedBy: string;
  budget: TriggerBudget;
  usage: TriggerUsage;
  brief?: IncidentBrief;
  scope?: ScopeGraph;
  angular?: AngularModel;
  /** Les stratégies tentées, dans l'ordre, et ce qu'elles ont donné. */
  strategies: { strategy: ExplorationStrategy; trials: number; reproduced: number; note?: string }[];
  trials: TriggerTrial[];
  /** La réaction de référence de chaque sonde (parcours qui fonctionne). */
  reference: Record<string, ReactionSignature>;
  conditions: TriggerCondition[];
  minimal?: MinimalReproduction;
  firstFailure?: FirstFailureAnalysis;
  dataLoss?: DataLossAnalysis;
  /** Les hypothèses écrites dans l'incident par ce run (ids). */
  hypothesisIds: string[];
  /** Les vérifications proposées en attente d'une personne (ids d'expériences de l'incident). */
  pendingExperimentIds: string[];
  /** Couverture : facteurs explorés / connus, par dimension (jamais un pourcentage global). */
  coverage: {
    dimension: 'ACTIONS' | 'DATA' | 'STATES' | 'TIMING' | 'SEQUENCES';
    explored: number;
    known: number;
    note?: string;
  }[];
  limitations: string[];
  stopReason?: string;
  error?: string;
  /** Le point d'entrée imposé (écran cible), gardé pour la reprise. */
  entry?: TriggerEntry;
  /** Le point de reprise : la stratégie et l'essai où tout s'est arrêté. */
  resumePoint?: { strategy: ExplorationStrategy; trialIndex: number };
}

export interface TriggerInvestigationInput {
  /** La description en langage naturel ; absente : celle de l'incident. */
  description?: string;
  depth?: TriggerDepth;
  budget?: Partial<TriggerBudget>;
  /** Le nombre de répétitions d'une séquence qui reproduit (bugs intermittents). */
  repeats?: number;
  /** Seuil de fréquence (0 à 1) au-delà duquel une condition est dite nécessaire. */
  confidenceThreshold?: number;
  /**
   * Le point d'entrée imposé (écran cible) : les actions qui y mènent, rejouées avant chaque essai. Absent :
   * la route la plus pertinente de la découverte du périmètre.
   */
  entry?: TriggerEntry;
}

/** Le point d'entrée d'un run : la route visée et le parcours (navigation, clics sur des liens) qui y mène. */
export interface TriggerEntry {
  route: string;
  actions: TriggerAction[];
  source: 'TARGET';
}

export const DEFAULT_TRIGGER_BUDGET: Readonly<Record<TriggerDepth, TriggerBudget>> = Object.freeze({
  QUICK: {
    maxDurationMs: 3 * 60_000,
    maxTrials: 12,
    maxActions: 150,
    maxRepeats: 2,
    maxExperiments: 2,
    maxEvents: 4000,
    maxAiCalls: 0,
    maxBrowsers: 1,
  },
  STANDARD: {
    maxDurationMs: 10 * 60_000,
    maxTrials: 60,
    maxActions: 900,
    maxRepeats: 3,
    maxExperiments: 6,
    maxEvents: 20_000,
    maxAiCalls: 10,
    maxBrowsers: 1,
  },
  DEEP: {
    maxDurationMs: 30 * 60_000,
    maxTrials: 250,
    maxActions: 5000,
    maxRepeats: 10,
    maxExperiments: 20,
    maxEvents: 60_000,
    maxAiCalls: 40,
    maxBrowsers: 1,
  },
});

export const TRIGGER_BUDGET_CAPS: Readonly<TriggerBudget> = Object.freeze({
  maxDurationMs: 4 * 60 * 60_000,
  maxTrials: 2000,
  maxActions: 50_000,
  maxRepeats: 50,
  maxExperiments: 100,
  maxEvents: 500_000,
  maxAiCalls: 500,
  maxBrowsers: 2,
});

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
export const MAX_TRIGGER_RUNS_KEPT = 5;
export const MAX_TRIAL_EVENTS_KEPT = 400;

/** L'état de la découverte dans l'incident (persisté). */
export interface TriggerInvestigationState {
  brief?: IncidentBrief;
  runs: TriggerRun[];
}

export type { ExperimentKind, Hypothesis, HypothesisStatus, Layer };
