import type {
  ExperimentKind,
  Layer,
  PolicyOperation,
  ProposedVerification,
  ScopeExtensionKind,
} from './incident-contracts.js';

/**
 * L'INVESTIGATION ASSISTÉE PAR L'IA : le contrat partagé entre le moteur, le serveur et le navigateur.
 *
 * Trois modes. DETERMINISTIC (défaut) : aucun appel à un modèle, rien de ce module ne tourne. AI_ASSISTED :
 * un passage d'agents en lecture, qui proposent (hypothèses, vérifications, explications). AI_AGENTIC : une
 * boucle bornée qui planifie, inspecte le code autorisé, propose et réévalue d'après les résultats.
 *
 * Règles de vérité : une hypothèse d'origine IA est marquée `origin: 'AI'`, naît PROPOSED, porte une confiance
 * indicative plafonnée, et ne devient jamais CONFIRMED sur décision du modèle — seul le validateur de cause
 * racine déterministe (deux vérifications de nature différente, dont une dynamique, aucune contraire) le peut.
 * Chaque constat cite des identifiants de preuves, de requêtes, de symboles ou de fichiers qui existent ; une
 * référence inconnue est rejetée. Les outils des agents passent tous par le Scope Policy Engine ; une demande du
 * modèle n'est jamais une autorisation.
 */
export const AI_INVESTIGATION_MODES = ['DETERMINISTIC', 'AI_ASSISTED', 'AI_AGENTIC'] as const;
export type AiInvestigationMode = (typeof AI_INVESTIGATION_MODES)[number];

/** D'où vient une hypothèse : d'une règle du moteur, ou d'un agent IA. */
export const HYPOTHESIS_ORIGINS = ['RULE', 'AI'] as const;
export type HypothesisOrigin = (typeof HYPOTHESIS_ORIGINS)[number];

/** Les agents de l'orchestrateur, dans l'ordre logique d'un run. */
export const AI_AGENTS = [
  'PLANNER',
  'EVIDENCE_ANALYSIS',
  'FRONTEND',
  'BFF',
  'BACKEND',
  'CROSS_LAYER',
  'HYPOTHESIS',
  'VERIFICATION_PLANNING',
  'SYNTHESIS',
  'ASSISTANT',
  'CONTRADICTION_HUNTER',
  'STRATEGY',
  'EXPERIMENT_GENERATION',
] as const;
export type AiAgentName = (typeof AI_AGENTS)[number];

export const AI_AGENT_STATUSES = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'SKIPPED',
  'APPROVAL_REQUIRED',
  'CANCELLED',
] as const;
export type AiAgentStatus = (typeof AI_AGENT_STATUSES)[number];

export const AI_RUN_STATUSES = ['RUNNING', 'DONE', 'PARTIAL', 'FAILED', 'CANCELLED'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

/** Pourquoi un run s'est arrêté. */
export const AI_STOP_REASONS = [
  'GOALS_MET',
  'BUDGET_EXHAUSTED',
  'TIMEOUT',
  'NO_USEFUL_VERIFICATION',
  'CANCELLED',
  'PERMISSION_DENIED',
  'INSUFFICIENT_EVIDENCE',
  'PROVIDER_ERROR',
] as const;
export type AiStopReason = (typeof AI_STOP_REASONS)[number];

/** La nature d'une référence citée par un agent (tout ce qui existe dans l'investigation). */
export const AI_REF_KINDS = [
  'evidence',
  'request',
  'symbol',
  'file',
  'node',
  'edge',
  'hypothesis',
  'experiment',
  'step',
] as const;
export type AiRefKind = (typeof AI_REF_KINDS)[number];

export interface AiRef {
  kind: AiRefKind;
  id: string;
}

/** Un endroit du code cité par un agent : toujours un fichier du périmètre, jamais fabriqué. */
export interface AiSourceLocation {
  applicationId: string;
  file: string;
  line?: number;
  symbol?: string;
}

/** Les budgets d'un run (et leur consommation). */
export interface AiBudget {
  maxIterations: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Plafond de coût estimé (unités du fournisseur, souvent USD) ; 0 = pas de plafond. */
  maxCost: number;
  maxDurationMs: number;
  maxFiles: number;
  maxCommands: number;
  maxExperiments: number;
}

export interface AiUsage {
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  durationMs: number;
  files: number;
  commands: number;
  experiments: number;
}

/** La politique d'envoi des données vers un fournisseur externe. */
export interface AiDataPolicy {
  /** Faux : aucune transmission externe, quel que soit le mode (l'IA est indisponible). */
  allowExternal: boolean;
  sendSourceCode: boolean;
  sendHttpBodies: boolean;
  sendLogs: boolean;
  sendScreenshots: boolean;
  /** Longueur maximale d'un extrait transmis (caractères). */
  maxSnippetChars: number;
}

/** Ce que le serveur sait faire pour cet incident (affiché avant de lancer). */
export interface AiCapabilities {
  /** Le mode configuré par défaut (DETERMINISTIC si rien). */
  defaultMode: AiInvestigationMode;
  /** Les modes réellement disponibles : DETERMINISTIC toujours ; les autres si un fournisseur est configuré et permis. */
  availableModes: AiInvestigationMode[];
  provider?: string;
  model?: string;
  /** La raison pour laquelle l'IA est indisponible (jamais un secret). */
  unavailableReason?: string;
  dataPolicy: AiDataPolicy;
  budget: AiBudget;
}

/** Une étape du plan d'investigation proposé par le Planner et tenu à jour par la boucle. */
export interface AiPlanStep {
  id: string;
  order: number;
  title: string;
  /** L'agent qui s'en charge. */
  agent: AiAgentName;
  status: AiAgentStatus;
  /** Les couches, endpoints ou preuves visés. */
  targets: string[];
  summary?: string;
}

/** Un appel d'outil, tel que tracé (jamais la charge utile complète : seulement l'opération et la décision). */
export interface AiToolCall {
  at: string;
  name: string;
  /** Résumé court de l'argument (chemin, identifiant, requête de recherche tronquée). */
  target: string;
  allowed: boolean;
  /** La règle de politique qui a tranché, quand l'appel est refusé. */
  rule?: string;
  durationMs?: number;
}

export interface AiAgentStep {
  agent: AiAgentName;
  status: AiAgentStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  toolCalls: AiToolCall[];
  usage: AiUsage;
}

/** Une découverte d'un agent : toujours rattachée à des références existantes. */
export interface AiFinding {
  id: string;
  agent: AiAgentName;
  layer: Layer;
  title: string;
  summary: string;
  refs: AiRef[];
  locations: AiSourceLocation[];
  /** Vérifiée par une preuve observée, lue dans le code, ou seulement déduite. */
  basis: 'OBSERVED' | 'STATICALLY_RESOLVED' | 'INFERRED';
  /** Rattachée à une hypothèse (id) quand elle en soutient ou en contredit une. */
  hypothesisId?: string;
}

/** Une relation suggérée par un agent : toujours INFERRED tant qu'une preuve ne l'établit pas. */
export interface AiSuggestedRelation {
  from: string;
  to: string;
  reason: string;
  refs: AiRef[];
}

/** Une vérification proposée par un agent, avant qu'une personne ou la boucle ne la planifie. */
export interface AiExperimentProposal {
  id: string;
  hypothesisId: string;
  kind: ExperimentKind;
  objective: string;
  verification: ProposedVerification;
  resources: string[];
  permissions: string[];
  risks: string[];
  sideEffects: boolean;
  expected: string;
  /** Ce qui confirmerait, ce qui réfuterait. */
  confirmIf: string;
  refuteIf: string;
  /** L'expérience planifiée dans l'incident, quand c'est fait (id d'Experiment). */
  experimentId?: string;
  status: 'PROPOSED' | 'PLANNED' | 'REFUSED' | 'DONE';
  refusal?: string;
}

/** Une extension de périmètre demandée par un agent : PENDING tant qu'une personne ne décide pas. */
export interface AiScopeRequest {
  id: string;
  kind: ScopeExtensionKind;
  target: string;
  applicationId?: string;
  reason: string;
  /** L'extension créée dans l'incident (ScopeExtension.id). */
  extensionId?: string;
}

export interface AiSynthesis {
  /** Résumé argumenté, court, en français. */
  summary: string;
  /** Les hypothèses retenues, par ordre de vraisemblance (ids). */
  ranking: string[];
  /** Ce qui manque pour conclure. */
  missing: string[];
  /** Les vérifications qui départageraient (ids de propositions). */
  decisive: string[];
}

export interface AiInvestigationRun {
  id: string;
  mode: Exclude<AiInvestigationMode, 'DETERMINISTIC'>;
  /** La profondeur demandée (QUICK, STANDARD, DEEP) ; absente : STANDARD. */
  depth?: InvestigationDepth;
  status: AiRunStatus;
  stopReason?: AiStopReason;
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
  provider?: string;
  model?: string;
  budget: AiBudget;
  usage: AiUsage;
  plan: AiPlanStep[];
  steps: AiAgentStep[];
  findings: AiFinding[];
  /** Les hypothèses d'origine IA écrites dans l'incident (ids de Hypothesis). */
  hypothesisIds: string[];
  relations: AiSuggestedRelation[];
  proposals: AiExperimentProposal[];
  scopeRequests: AiScopeRequest[];
  synthesis?: AiSynthesis;
  /** Ce que le run n'a pas pu faire, et pourquoi (politique, budget, données non transmises…). */
  limitations: string[];
  error?: string;
}

export interface AiInvestigationInput {
  mode?: Exclude<AiInvestigationMode, 'DETERMINISTIC'>;
}

/** L'assistant : une question, une réponse qui cite des références existantes. */
export interface AiAssistantQuestion {
  question: string;
}

export interface AiAssistantAnswer {
  id: string;
  askedAt: string;
  askedBy: string;
  question: string;
  answer: string;
  refs: AiRef[];
  locations: AiSourceLocation[];
  /** La réponse n'a pas pu être donnée (IA indisponible, budget, politique) : la raison. */
  unavailable?: string;
  usage?: AiUsage;
}

/** L'état IA d'une investigation. */
export interface AiInvestigationState {
  runs: AiInvestigationRun[];
  answers: AiAssistantAnswer[];
}

export const MAX_AI_RUNS_KEPT = 10;
export const MAX_AI_ANSWERS_KEPT = 30;
export const MAX_AI_FINDINGS = 60;
export const MAX_AI_QUESTION_CHARS = 1000;
/** La confiance indicative d'une hypothèse IA ne dépasse jamais ce plafond tant qu'aucune vérification ne la soutient. */
export const MAX_AI_HYPOTHESIS_CONFIDENCE = 0.7;

// ── Investigation approfondie (DEEP) ─────────────────────────────────────────────────────────

/**
 * LA PROFONDEUR D'INVESTIGATION, indépendante du mode IA. QUICK : reproduction, preuves essentielles, erreurs
 * principales, hypothèses initiales, vérifications directes. STANDARD : analyse des trois couches, corrélation,
 * comparaison des preuves, vérifications ciblées, hypothèses alternatives, rapport argumenté. DEEP : exploration
 * étendue du code autorisé, causes non prévues par les règles, chemins alternatifs, comparaison des scénarios,
 * préconditions de données, changements Git accessibles, défauts de contrat, vérifications répétées, recherche
 * active de contradictions, causes multiples. DEEP demande AI_AGENTIC ; les autres combinaisons sont permises et
 * décrites par `DEPTH_MODES` (jamais supposées).
 */
export const INVESTIGATION_DEPTHS = ['QUICK', 'STANDARD', 'DEEP'] as const;
export type InvestigationDepth = (typeof INVESTIGATION_DEPTHS)[number];

/** Les modes IA permis pour chaque profondeur. */
export const DEPTH_MODES: Record<InvestigationDepth, readonly AiInvestigationMode[]> = {
  QUICK: ['DETERMINISTIC', 'AI_ASSISTED', 'AI_AGENTIC'],
  STANDARD: ['DETERMINISTIC', 'AI_ASSISTED', 'AI_AGENTIC'],
  DEEP: ['AI_AGENTIC'],
};

export const STRATEGY_CATEGORIES = [
  'EVIDENCE',
  'CODE',
  'CONTRACT',
  'DATA',
  'CONFIGURATION',
  'HISTORY',
  'COMPARISON',
  'EXCEPTION',
  'ALTERNATIVE',
  'VERIFICATION',
] as const;
export type StrategyCategory = (typeof STRATEGY_CATEGORIES)[number];

export const STRATEGY_EXECUTION_MODES = ['READ_ONLY', 'SANDBOX', 'APPROVAL_REQUIRED'] as const;
export type StrategyExecutionMode = (typeof STRATEGY_EXECUTION_MODES)[number];

export const STRATEGY_STATUSES = [
  'AVAILABLE',
  'BLOCKED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'NOT_APPLICABLE',
  'SKIPPED',
] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Une stratégie d'investigation : découverte, évaluée, priorisée, tentée une fois (sauf justification). */
export interface InvestigationStrategy {
  id: string;
  name: string;
  category: StrategyCategory;
  applicableLayers: ('FRONTEND' | 'BFF' | 'BACKEND' | 'DATABASE')[];
  /** Préconditions (lisibles) ; celles qui manquent expliquent un statut BLOCKED. */
  prerequisites: string[];
  /** Capacités nécessaires (outils, permissions du périmètre, capacités de l'environnement). */
  requiredCapabilities: string[];
  /** Coût estimé en unités de budget (appels, fichiers) ; jamais un montant inventé. */
  estimatedCost: number;
  estimatedRisk: RiskLevel;
  /** Gain d'information attendu, 0 à 1 : ce que la stratégie peut réduire comme incertitude. */
  expectedInformationGain: number;
  executionMode: StrategyExecutionMode;
  status: StrategyStatus;
  /** Pourquoi elle est bloquée, non applicable, ou sautée. */
  reason?: string;
  /** Les hypothèses qu'elle peut départager. */
  hypothesisIds: string[];
  /** L'agent ou l'expérience qui la met en œuvre. */
  via: { agent?: AiAgentName; experimentKind?: ExperimentKind };
  attempts: number;
  lastAttemptAt?: string;
  /** Ce qu'elle a donné (ids de découvertes, d'expériences). */
  outcomeRefs: AiRef[];
}

export const HYPOTHESIS_RELATION_KINDS = [
  'COMPETES',
  'CONTRIBUTES',
  'IMPLIES',
  'EXCLUDES',
  'REFINES',
] as const;
export type HypothesisRelationKind = (typeof HYPOTHESIS_RELATION_KINDS)[number];

export interface HypothesisRelation {
  from: string;
  to: string;
  kind: HypothesisRelationKind;
  reason: string;
}

/** Le résultat d'une vérification sur une hypothèse, tel que la boucle l'enregistre. */
export interface HypothesisVerificationResult {
  experimentId: string;
  at: string;
  effect: 'SUPPORTS' | 'CONTRADICTS' | 'NEUTRAL';
  summary: string;
  refs: AiRef[];
}

/**
 * L'exploration d'une hypothèse : ce que la mémoire d'investigation garde en plus de `Hypothesis` (qui reste la
 * vérité du moteur). Une hypothèse fortement soutenue n'en supprime jamais une autre.
 */
export interface HypothesisExploration {
  hypothesisId: string;
  origin: HypothesisOrigin;
  /** Ce qu'on ne sait pas encore, et qui compte. */
  unknowns: string[];
  locations: AiSourceLocation[];
  /** Les agents qui y ont contribué. */
  contributors: AiAgentName[];
  verifications: HypothesisVerificationResult[];
  /** Les vérifications possibles non encore faites (ids de propositions). */
  nextProposalIds: string[];
  relations: HypothesisRelation[];
  /** Le rôle que le rapport lui donne, d'après le validateur déterministe et les vérifications. */
  role: 'CONFIRMED_CAUSE' | 'PROBABLE_CAUSE' | 'CONTRIBUTING_FACTOR' | 'REFUTED' | 'UNVERIFIED' | 'UNKNOWN';
}

export const CONTRADICTION_KINDS = [
  'REFUTING_EVIDENCE',
  'INCOMPATIBLE_CODE_PATH',
  'PASSING_SCENARIO',
  'EARLIER_ERROR',
  'ENVIRONMENT_DIFFERENCE',
  'LOG_TRACE_MISMATCH',
  'MISSING_EVIDENCE',
  'ALTERNATIVE_EXPLANATION',
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

/** Une contradiction : ou bien elle cite une preuve, ou bien elle est une question explicitement non résolue. */
export interface AiContradiction {
  id: string;
  hypothesisId: string;
  kind: ContradictionKind;
  summary: string;
  refs: AiRef[];
  /** Vrai quand aucune preuve ne la porte : c'est une question ouverte, jamais un constat. */
  openQuestion: boolean;
  /** La vérification qui la trancherait (id de proposition), quand il y en a une. */
  proposalId?: string;
  status: 'OPEN' | 'RESOLVED_SUPPORTS' | 'RESOLVED_CONTRADICTS' | 'DISMISSED';
  foundBy: AiAgentName;
  at: string;
}

/** Une expérience générée : tout ce qu'elle déclare avant qu'une politique ne la laisse passer. */
export interface GeneratedExperiment extends AiExperimentProposal {
  strategyId?: string;
  /** Les preuves nécessaires pour la mener (ids). */
  requiredEvidence: AiRef[];
  prerequisites: string[];
  /** Les opérations exactes, sous la forme que le Scope Policy Engine évalue. */
  operations: PolicyOperation[];
  estimatedCost: number;
  risk: RiskLevel;
  /** Rejeu différentiel : seulement dans un environnement permis et sans effet de bord déclaré. */
  differential?: { withData: Record<string, string>; withoutData: string[] };
  /** Ce que son résultat a changé sur les hypothèses. */
  impact?: { hypothesisId: string; effect: HypothesisVerificationResult['effect'] }[];
}

export const COVERAGE_DIMENSIONS = [
  'USER_JOURNEY',
  'FRONTEND_EVENTS',
  'HTTP_REQUESTS',
  'BFF_CONTROLLERS',
  'MAPPINGS',
  'BACKEND_SERVICES',
  'REPOSITORIES',
  'DATA_PRECONDITIONS',
  'EXCEPTIONS',
  'CONFIGURATIONS',
  'GIT_CHANGES',
  'COMPARATIVE_SCENARIOS',
  'ALTERNATIVE_HYPOTHESES',
  'EXECUTED_VERIFICATIONS',
] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

export const COVERAGE_STATES = ['EXAMINED', 'PARTIAL', 'NOT_EXAMINED', 'NOT_APPLICABLE', 'BLOCKED'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** La couverture : par dimension, avec son dénominateur explicite ; jamais un pourcentage global. */
export interface CoverageEntry {
  dimension: CoverageDimension;
  state: CoverageState;
  /** Ce qui a été examiné / ce qui existe (dénominateur nommé), quand c'est comptable. */
  examined?: number;
  total?: number;
  denominator?: string;
  reason?: string;
  refs: AiRef[];
}

/** Le budget d'une investigation approfondie : configurable et validé côté serveur, jamais augmenté seul. */
export interface DeepInvestigationBudget extends AiBudget {
  maxConcurrentAgents: number;
  /** Prolongations accordées (chacune par une personne). */
  extensions: { at: string; by: string; added: Partial<AiBudget> }[];
}

export const INVESTIGATION_CONTROLS = [
  'START',
  'PAUSE',
  'RESUME',
  'CANCEL',
  'APPROVE',
  'REFUSE',
  'EXTEND_BUDGET',
] as const;
export type InvestigationControl = (typeof INVESTIGATION_CONTROLS)[number];

export const MEMORY_EVENT_KINDS = [
  'FINDING',
  'HYPOTHESIS',
  'STRATEGY',
  'EXPERIMENT_PROPOSED',
  'EXPERIMENT_APPROVED',
  'EXPERIMENT_REFUSED',
  'EXPERIMENT_RUN',
  'CONTRADICTION',
  'REVISION',
  'CONFIRMATION',
  'REFUTATION',
  'PERMISSION',
  'LIMIT',
  'DECISION',
  'PAUSE',
  'RESUME',
  'CANCEL',
] as const;
export type MemoryEventKind = (typeof MEMORY_EVENT_KINDS)[number];

/** Un événement de la chronologie d'investigation (structuré, jamais une transcription de conversation). */
export interface InvestigationMemoryEvent {
  id: string;
  at: string;
  kind: MemoryEventKind;
  agent?: AiAgentName;
  actor?: string;
  summary: string;
  refs: AiRef[];
  hypothesisId?: string;
  strategyId?: string;
  experimentId?: string;
}

/** Une permission accordée ou refusée : liée à une opération et à des paramètres précis, jamais générale. */
export interface InvestigationPermission {
  id: string;
  at: string;
  by: string;
  experimentId?: string;
  operation: string;
  parameters: Record<string, string>;
  decision: 'APPROVED' | 'REFUSED';
  reason?: string;
}

/**
 * LA MÉMOIRE D'INVESTIGATION : persistante, structurée, liée à l'incident ; ce qu'il faut pour reprendre après
 * une interruption sans refaire une expérience identique.
 */
export interface InvestigationMemory {
  version: 1;
  incidentId: string;
  depth: InvestigationDepth;
  mode: AiInvestigationMode;
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'DONE' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  stopReason?: AiStopReason | 'PAUSED' | 'STRATEGIES_EXHAUSTED' | 'DETERMINISTIC_CONFIRMED';
  startedAt?: string;
  updatedAt: string;
  budget: DeepInvestigationBudget;
  usage: AiUsage;
  strategies: InvestigationStrategy[];
  explorations: HypothesisExploration[];
  contradictions: AiContradiction[];
  experiments: GeneratedExperiment[];
  coverage: CoverageEntry[];
  permissions: InvestigationPermission[];
  timeline: InvestigationMemoryEvent[];
  /** Les limites atteintes, avec les pistes restantes et la prolongation proposée. */
  limits: {
    at: string;
    limit: keyof AiBudget | 'STRATEGIES';
    remaining: string[];
    proposedExtension?: Partial<AiBudget>;
  }[];
  /** Ce qui reste à faire si l'investigation reprend (stratégies disponibles, propositions en attente). */
  remaining: string[];
  /** Le point de reprise : l'itération et l'étape du plan où tout s'est arrêté. */
  resumePoint?: { iteration: number; planStepId?: string };
}

export interface DeepInvestigationInput extends AiInvestigationInput {
  depth?: InvestigationDepth;
  /** Un budget plus petit que la configuration est toujours permis ; plus grand, jamais sans DECIDE. */
  budget?: Partial<AiBudget>;
}

export const MAX_MEMORY_EVENTS = 500;
export const MAX_STRATEGIES = 60;
export const MAX_CONTRADICTIONS = 80;
