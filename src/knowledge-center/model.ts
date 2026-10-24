/**
 * KNOWLEDGE CENTER — le modèle unifié de présentation. Chaque connaissance que QA-CRAWLER garde
 * (persistance, base de connaissances fichier, connaissance fonctionnelle, règles) est montrée sous
 * une même forme, SANS être copiée ailleurs : l'identifiant est dérivé de la clé réelle, les preuves
 * sont les compteurs réels, la fiabilité est calculée (reliability.ts), jamais stockée ni inventée.
 */

export const KNOWLEDGE_TYPES = [
  'TRANSITION',
  'ACTION',
  'API',
  'PERFORMANCE',
  'HINT',
  'RECOVERY',
  'TARGET_RESOLUTION',
  'HYPOTHESIS',
  'INVARIANT',
  'FUNCTIONAL',
  'LEARNED_WORKFLOW',
  'LEARNED_STATE',
  'LEARNED_TRANSITION',
  'FIELD_MAPPING',
  'INTENT_DECISION',
  'INTENT_PATTERN',
  'RULE',
  'EVOLUTION',
  'ANOMALY',
  'FLOW_MEMORY',
  'FLOW_RUN',
] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

/** D'où la ligne est lue (le lieu réel, jamais une copie). */
export type KnowledgeSource = 'PERSISTENCE' | 'KNOWLEDGE_FILE' | 'FUNCTIONAL_FILE' | 'RULES_FILE';

/** Comment la connaissance a été acquise, d'après ce que la ligne dit d'elle-même. */
export const KNOWLEDGE_ORIGINS = [
  'EXPLORATION',
  'REPLAY',
  'RECORDING',
  'HUMAN',
  'NETWORK_LEARNING',
  'STATIC_ANALYSIS',
  'ANALYSIS',
  'UNKNOWN',
] as const;
export type KnowledgeOrigin = (typeof KNOWLEDGE_ORIGINS)[number];

/**
 * Fiabilité CALCULÉE à partir des preuves (voir reliability.ts, formules documentées) :
 * - OBSERVED      vue, pas (ou pas assez) exécutée ;
 * - CONFIRMED     exécutée assez de fois, presque toujours avec succès ;
 * - FRAGILE       exécutée, avec une part d'échecs qui compte ;
 * - CONTRADICTED  contredite par des preuves (échecs majoritaires, contradictions ≥ confirmations) ;
 * - STALE         plus revue depuis longtemps (obsolète tant qu'un run ne la revoit pas) ;
 * - HYPOTHESIS    produite par une analyse, jamais confirmée par une exécution ;
 * - UNVERIFIED    aucune preuve exploitable.
 */
export const RELIABILITY_STATUSES = [
  'OBSERVED',
  'CONFIRMED',
  'FRAGILE',
  'CONTRADICTED',
  'STALE',
  'HYPOTHESIS',
  'UNVERIFIED',
] as const;
export type ReliabilityStatus = (typeof RELIABILITY_STATUSES)[number];

export interface KnowledgeEvidence {
  /** Fois où la connaissance a été vue (transition, action). */
  seen?: number;
  successes?: number;
  failures?: number;
  blocked?: number;
  /** Confirmations / contradictions explicites (fonctionnel, règles, hypothèses). */
  confirmations?: number;
  contradictions?: number;
  /** Les runs qui l'ont produite ou confirmée, quand la ligne les connaît. */
  runIds?: string[];
}

export interface Reliability {
  status: ReliabilityStatus;
  /** Pourquoi (une ligne par règle appliquée), montré tel quel. */
  reasons: string[];
}

/** Une décision humaine du registre de revue (review-ledger.ts). Elle ne change rien au moteur. */
export interface ReviewDecision {
  status: 'VALIDATED' | 'INVALIDATED';
  note?: string;
  at: string;
  /** Nombre de décisions prises sur cette connaissance (contrôle des modifications concurrentes). */
  version: number;
}

export interface KnowledgeItem {
  /** Identifiant stable : dérivé de (source, type, application, environnement, clé réelle). */
  id: string;
  type: KnowledgeType;
  source: KnowledgeSource;
  origin: KnowledgeOrigin;
  application: string;
  environment?: string;
  /** Une ligne lisible. */
  title: string;
  description?: string;
  /** La clé réelle dans son stockage (signatures, identifiant…). */
  key: string;
  /** Les données réelles de la ligne (jamais une valeur saisie ni un secret : le stockage n'en contient pas). */
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  /** Version de l'application (commit, appVersion) de la dernière observation, si la ligne la porte. */
  appVersion?: string;
  evidence: KnowledgeEvidence;
  reliability: Reliability;
  review?: ReviewDecision;
  /** Chemin du fichier ou nom de la table d'où la ligne vient. */
  location: string;
}

export interface ApplicationSummary {
  /** L'identifiant tel que la persistance le connaît (`application@environment`). */
  id: string;
  application: string;
  environment?: string;
  /** D'où vient la connaissance de cette application. */
  sources: KnowledgeSource[];
  /** La mission courante désigne cette application. */
  current: boolean;
}

/** Un indicateur : une valeur réelle, ou « non disponible » avec la raison. */
export type Metric =
  { value: number | string; formula: string } | { unavailable: true; reason: string; formula?: string };

export interface OverviewDto {
  application: ApplicationSummary;
  memory: MemoryStateDto;
  metrics: Record<string, Metric>;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  activity: {
    recent: ActivityEntry[];
    runs: RunSummary[];
    transitions: ActivityEntry[];
    reused: ActivityEntry[];
    resolutionFailures: ActivityEntry[];
    persistenceErrors: Metric;
    attention: ActivityEntry[];
  };
}

export interface ActivityEntry {
  id?: string;
  at?: string;
  type: string;
  title: string;
  detail?: string;
  status?: string;
}

export interface RunSummary {
  id: string;
  missionName: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  statesCount: number;
  actionsCount: number;
  transitionsCount: number;
  anomaliesCount: number;
  environment?: string;
  branch?: string;
  commitSha?: string;
  crawlerVersion?: string;
}

/** L'état de la mémoire tel que la configuration effective le dit. Jamais modifié par le dashboard. */
export interface MemoryStateDto {
  mode: 'legacy' | 'isolated' | 'current-run' | 'historical';
  memoryEnabled: boolean | undefined;
  historicalKnowledge: boolean;
  preload: { maxStates: number; maxTransitions: number };
  knowledgeFile?: string;
  knowledgeFileEnabled: boolean;
  persistence: PersistenceStateDto;
}

export interface PersistenceStateDto {
  enabled: boolean;
  status: 'DISABLED' | 'CONNECTED' | 'FALLBACK' | 'UNAVAILABLE';
  configured?: { provider: string; database?: string };
  actual?: { provider: string; database?: string; location?: string };
  reason?: string;
  latencyMs?: number;
  schemaVersion?: number;
  /** Le nombre d'enregistrements par table, quand le provider sait les compter. */
  counts?: Record<string, number>;
  health?: { status: string; latencyMs?: number; detail?: string; checkedAt: string };
  /** Les providers que cette version implémente réellement. */
  providers: { kind: string; label: string; available: boolean; note?: string }[];
  lastWriteAt?: string;
  lastBackupAt?: string;
  lastRestoreAt?: string;
  recentErrors: { at: string; operation: string; message: string }[];
  readOnly: boolean;
}

export interface SearchQuery {
  text?: string;
  type?: KnowledgeType;
  status?: ReliabilityStatus;
  origin?: KnowledgeOrigin;
  source?: KnowledgeSource;
  review?: 'VALIDATED' | 'INVALIDATED' | 'NONE';
  sort?: 'updatedAt' | 'createdAt' | 'title' | 'type' | 'status' | 'evidence';
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface FlowsDto {
  runs: RunSummary[];
  /** Les flows connus : enregistrés (recordings) et rejoués (mémoire des flows). */
  flows: FlowSummary[];
  states: StateSummary[];
  transitions: TransitionSummary[];
}

export interface FlowSummary {
  name: string;
  source: 'RECORDING' | 'FLOW_RUN_MEMORY';
  steps: number;
  /** Les runs qui l'ont rejoué (mémoire des flows). */
  lastRun?: { runId: string; at: string; status: string; durationMs: number };
  location?: string;
  produces: string[];
  consumes: string[];
  /** La route de départ de l'enregistrement. */
  startAt?: string;
}

export interface StateSummary {
  signature: string;
  routes: string[];
  titles: string[];
  /** Transitions observées depuis cet écran (connaissance historique). */
  outgoing: number;
  incoming: number;
  lastSeenAt?: string;
}

export interface TransitionSummary {
  id: string;
  from: string;
  action: string;
  to: string;
  seen: number;
  successes: number;
  failures: number;
  blocked: number;
  status: ReliabilityStatus;
  lastSeenAt: string;
}

export interface GraphDto {
  nodes: { id: string; label: string; kind: 'state' | 'none'; outgoing: number; incoming: number }[];
  edges: { id: string; from: string; to: string; label: string; status: ReliabilityStatus; seen: number }[];
  truncated: boolean;
}

export interface VariableDto {
  key: string;
  flow: string;
  strategy: string;
  generator?: string;
  sensitive: boolean;
  /** La valeur enregistrée, quand elle n'est pas sensible et que le jeu la garde en clair. */
  value?: string;
  producedBy?: { stepId: string; stepIndex: number; label: string };
  usedBy: { stepId: string; stepIndex: number; label: string; how: 'INPUT' | 'CITATION' }[];
  /** Correspondances champ ↔ propriété validées pour ce libellé (connaissance fonctionnelle). */
  mappings: {
    uiLabel: string;
    property: string;
    jsonPath: string;
    api: string;
    operation: string;
    transformation: string;
    confirmations: number;
  }[];
  /** Le choix humain (liaison explicite) s'il y en a un. */
  humanBinding?: { source: string; variable: string; at: string };
  issues: VariableIssue[];
}

export interface VariableIssue {
  kind: 'NEVER_CONSUMED' | 'NO_PRODUCER' | 'AMBIGUOUS_MAPPING' | 'STATIC_REUSED' | 'BROKEN_DEPENDENCY';
  message: string;
}

export interface VariablesDto {
  variables: VariableDto[];
  flows: string[];
  issues: Record<string, number>;
  unavailable?: string;
}

export interface QualityDto {
  byStatus: Record<string, number>;
  categories: {
    status: ReliabilityStatus;
    label: string;
    definition: string;
    items: KnowledgeItem[];
    total: number;
  }[];
  signals: { kind: string; title: string; items: KnowledgeItem[]; total: number; definition: string }[];
}

export interface HistoryDto {
  entries: LedgerEntry[];
  learning: ActivityEntry[];
  total: number;
}

/** Une opération du registre (ajout seul). */
export interface LedgerEntry {
  id: string;
  at: string;
  operation: 'VALIDATE' | 'INVALIDATE' | 'RESET' | 'EXPORT' | 'IMPORT' | 'BACKUP' | 'RESTORE';
  application?: string;
  itemId?: string;
  itemTitle?: string;
  /** Les décisions prises sur la connaissance, avant et après. */
  before?: ReviewDecision;
  after?: ReviewDecision;
  reason?: string;
  runId?: string;
  origin: 'KNOWLEDGE_CENTER';
  details?: Record<string, unknown>;
  /** Une opération partiellement échouée dit ce qui a échoué. */
  errors?: string[];
}

export const KNOWLEDGE_EXPORT_FORMAT = 'qa-crawler-knowledge-export';
export const KNOWLEDGE_EXPORT_VERSION = 1;
