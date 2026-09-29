/**
 * Ce que le crawler APPREND au fil des runs, statistiquement — distinct du FlowGraph,
 * qui décrit ce qui a été OBSERVÉ. Aucune donnée sensible : ni corps de requête, ni
 * valeur saisie, ni en-tête ; seulement des signatures, des compteurs et des durées.
 */

/** Version du format du fichier ; migrée au chargement quand elle change. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

export interface KnowledgeIdentity {
  application: string;
  environment?: string;
  branch?: string;
  commit?: string;
  appVersion?: string;
  crawlerVersion?: string;
  schemaVersion: number;
}

/** Compteurs d'une action, par signature (type + libellé normalisé + route de l'écran). */
export interface ActionKnowledge {
  actionSignature: string;
  seenCount: number;
  executionCount: number;
  successCount: number;
  failureCount: number;
  blockedCount: number;
  averageDurationMs?: number;
  lastSeenAt?: string;
  lastExecutedAt?: string;
  /** Échecs consécutifs sur la version courante de l'application (remis à zéro quand elle change). */
  failuresOnVersion?: number;
  /** Version (commit, appVersion ou runId) des derniers échecs. */
  failureVersion?: string;
  /** Poids des succès/échecs une fois la décroissance appliquée (observations récentes d'abord). */
  weightedSuccess?: number;
  weightedFailure?: number;
}

/** Où mène une action depuis un écran, d'un run à l'autre. */
export interface TransitionKnowledge {
  fromStateSignature: string;
  actionSignature: string;
  /** Signature d'écran atteint → nombre d'observations. */
  targets: Record<string, number>;
  executionCount: number;
  successCount: number;
  failureCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * Contexte de la dernière observation (environnement, acteur, version, navigateur,
   * classe d'écran) : une connaissance vue dans un autre contexte s'applique moins.
   */
  lastContext?: ObservedKnowledgeContext;
}

/** Contexte d'observation, sans l'application (déjà dans la clé). Toutes les dimensions sont facultatives. */
export interface ObservedKnowledgeContext {
  environment?: string;
  actor?: string;
  version?: string;
  browser?: string;
  viewportClass?: 'mobile' | 'tablet' | 'desktop';
}

/** Statuts HTTP observés d'une opération d'API (méthode + modèle de chemin). Jamais de corps. */
export interface ApiKnowledge {
  operation: string;
  statuses: Record<string, number>;
  durations: number[];
  lastSeenAt: string;
}

/** Durées observées (ms) : chargement d'un écran, exécution d'une action. Les 50 dernières. */
export interface PerformanceKnowledge {
  key: string;
  kind: 'state-load' | 'action' | 'request';
  durations: number[];
  lastSeenAt: string;
}

/** Indice appris : un libellé qui mène d'habitude à un motif. Heuristique historique, jamais une règle de sécurité. */
export interface LearnedHint {
  label: string;
  pattern: string;
  count: number;
  total: number;
}

/** Attente HISTORIQUE (pas métier) : la cible dominante d'une transition. */
export interface HistoricalExpectation {
  target: string;
  share: number;
  observations: number;
  confidence: number;
}

export interface KnowledgeData {
  identity: KnowledgeIdentity;
  updatedAt: string;
  runs: number;
  actions: Record<string, ActionKnowledge>;
  transitions: Record<string, TransitionKnowledge>;
  api: Record<string, ApiKnowledge>;
  performance: Record<string, PerformanceKnowledge>;
  hints: Record<string, LearnedHint>;
}

export interface ActionResultInput {
  actionSignature: string;
  result: 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'SEEN';
  durationMs?: number;
  at?: string;
}

export interface TransitionInput {
  fromStateSignature: string;
  actionSignature: string;
  toStateSignature: string;
  success: boolean;
  at?: string;
}

export interface KnowledgeBase {
  getActionKnowledge(actionSignature: string): ActionKnowledge | undefined;
  getTransitionKnowledge(
    fromStateSignature: string,
    actionSignature: string,
  ): TransitionKnowledge | undefined;
  recordActionResult(input: ActionResultInput): void;
  recordTransition(input: TransitionInput): void;
  /** Statuts d'une opération d'API. */
  recordApiCall(operation: string, status: number, durationMs?: number, at?: string): void;
  getApiKnowledge(operation: string): ApiKnowledge | undefined;
  recordDuration(kind: PerformanceKnowledge['kind'], key: string, durationMs: number, at?: string): void;
  getPerformance(kind: PerformanceKnowledge['kind'], key: string): PerformanceKnowledge | undefined;
  /** Un libellé d'action a mené à un écran qui montre ces motifs. */
  recordOutcomePatterns(label: string, patterns: readonly string[]): void;
  hintFor(label: string): LearnedHint | undefined;
  /** La cible dominante d'une transition, quand l'historique est assez fourni. */
  expectationFor(fromStateSignature: string, actionSignature: string): HistoricalExpectation | undefined;
  /** Signatures d'actions qui ont mené à un écran dont la signature contient ce terme. */
  actionsLeadingTo(predicate: (stateSignature: string) => boolean): string[];
  /** Toutes les transitions connues (lecture seule) : chemins historiques du Dry Run. */
  transitions(): readonly TransitionKnowledge[];
  load(): Promise<void>;
  save(): Promise<void>;
  readonly identity: KnowledgeIdentity;
}
