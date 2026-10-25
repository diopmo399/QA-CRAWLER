/**
 * LES CONTRATS DU SDK : ce que l'hôte, le client navigateur et le serveur QA-CRAWLER échangent.
 * Ce fichier ne dépend de rien (ni Node, ni DOM) : il est lu par le navigateur comme par le serveur.
 *
 * Un brouillon de projet (ProjectDraft) ne porte jamais de secret : seulement des NOMS de variables
 * d'environnement, que le serveur lit lui-même. Les compteurs d'une exploration viennent des
 * événements du moteur ; aucun pourcentage global, aucune durée restante ne sont calculés.
 */

export const SDK_API_VERSION = 1;

/** `salesforce` : une application Salesforce Lightning (profil de plateforme du moteur). */
export const FRAMEWORKS = ['angular', 'react', 'vue', 'salesforce', 'other'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const AUTH_TYPES = ['none', 'form', 'http', 'sso'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** Les noms de variables d'environnement acceptés : jamais une valeur. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export interface ProjectStepDraft {
  name: string;
  description?: string;
  /** L'adresse de départ : origine + chemin (http ou https). */
  targetUrl: string;
  framework: Framework;
  /** Angular : dossier du code source sur le serveur (seulement si le serveur l'autorise). */
  sourceRoot?: string;
}

export type AuthDraft =
  | { type: 'none' }
  | {
      type: 'form';
      loginUrl: string;
      usernameSelector: string;
      passwordSelector: string;
      submitSelector: string;
      usernameEnv: string;
      passwordEnv: string;
      successUrlContains?: string;
      successSelector?: string;
    }
  | { type: 'http'; usernameEnv: string; passwordEnv: string; origin?: string }
  | {
      type: 'sso';
      identityProviderOrigin: string;
      usernameSelector: string;
      passwordSelector: string;
      submitSelector: string;
      nextSelector?: string;
      usernameEnv: string;
      passwordEnv: string;
      successUrlContains?: string;
    };

export interface EnvironmentStepDraft {
  viewport: { width: number; height: number };
  locale?: string;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  auth: AuthDraft;
}

export interface ExplorationStepDraft {
  maxStates: number;
  maxActions: number;
  maxDurationMinutes: number;
  maxDepth: number;
  allowedHosts: string[];
  ignoredPaths: string[];
  checks: {
    /** Erreurs de la page : console et exceptions JavaScript. */
    pageErrors: boolean;
    /** Réponses 4xx/5xx, requêtes en échec, liens cassés. */
    network: boolean;
    screenshots: boolean;
  };
}

/** Le projet tel que l'assistant le construit, étape par étape. */
export interface ProjectDraft {
  project: ProjectStepDraft;
  environment: EnvironmentStepDraft;
  exploration: ExplorationStepDraft;
}

export type DraftStep = 'project' | 'environment' | 'exploration';

/** Une remarque du serveur sur un brouillon, rattachée à l'étape et au champ en cause. */
export interface DraftIssue {
  step: DraftStep;
  field?: string;
  message: string;
}

export interface ValidationReport {
  /** Vrai quand aucun problème bloquant : le projet peut être créé et lancé. */
  ok: boolean;
  blocking: DraftIssue[];
  warnings: DraftIssue[];
  /** Les variables d'environnement citées par le brouillon et leur présence côté serveur. */
  environment: Record<string, boolean>;
  /** Le fichier de projet qui serait écrit (qa-crawler.config.yaml), quand le brouillon est valide. */
  projectFile?: string;
}

export interface UrlCheck {
  format: { ok: boolean; message?: string };
  /** Absent quand le format est invalide (aucune requête n'est faite). */
  reachable?: { ok: boolean; status?: number; durationMs: number; message?: string };
}

export interface Capabilities {
  apiVersion: number;
  engineVersion: string;
  /** Le moteur ne pilote que Chromium. */
  browsers: ['chromium'];
  frameworks: readonly Framework[];
  authTypes: readonly AuthType[];
  /** Les valeurs par défaut du moteur, pour pré-remplir l'assistant. */
  defaults: ProjectDraft;
  /** Le serveur accepte-t-il un dossier de code source (analyse statique Angular) ? */
  staticAnalysis: boolean;
  /** Le moteur ne sait pas arrêter une exploration en cours : l'annulation n'existe pas. */
  cancellation: false;
  /**
   * Les capacités au-delà de la création de projet, chacune branchée sur le module du moteur qui la
   * réalise. `recordings` ouvre un Chromium visible sur la machine du serveur : un humain y joue le
   * parcours.
   */
  extensions: Record<ExtensionName, boolean>;
}

export const EXTENSION_NAMES = [
  'recordings',
  'groups',
  'graph',
  'assertions',
  'generation',
  'reports',
  'data',
] as const;
export type ExtensionName = (typeof EXTENSION_NAMES)[number];

export interface Project {
  id: string;
  name: string;
  description?: string;
  framework: Framework;
  targetUrl: string;
  createdAt: string;
  status: 'PROJECT_CREATED';
}

/**
 * Le cycle de vie d'une exploration. CANCELLED est réservé : le moteur n'a pas d'arrêt à la
 * demande aujourd'hui, aucun état ne mène là.
 */
export const EXPLORATION_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ExplorationStatus = (typeof EXPLORATION_STATUSES)[number];

export const SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ExplorationBudget {
  maxStates: number;
  maxActions: number;
  maxDurationMinutes: number;
  maxDepth: number;
}

/** Les compteurs, tels que les événements du moteur les ont fait avancer. */
export interface ExplorationCounters {
  states: number;
  transitions: number;
  actions: number;
  blocked: number;
  issues: Record<Severity, number>;
}

export type ExplorationEvent =
  | { seq: number; at: string; type: 'status'; status: ExplorationStatus; message?: string }
  | { seq: number; at: string; type: 'authenticated'; message: string }
  | { seq: number; at: string; type: 'state'; stateId: string; label: string; route: string; title: string }
  | {
      seq: number;
      at: string;
      type: 'transition';
      from: string;
      to: string;
      action: string;
      changed: boolean;
    }
  | { seq: number; at: string; type: 'blocked'; stateId: string; action: string; reason: string }
  | {
      seq: number;
      at: string;
      type: 'issue';
      severity: Severity;
      issueType: string;
      message: string;
      route?: string;
    }
  | { seq: number; at: string; type: 'phase'; phase: string }
  | { seq: number; at: string; type: 'completed'; summary: ExplorationSummary }
  | { seq: number; at: string; type: 'failed'; error: string };

export type ExplorationEventType = ExplorationEvent['type'];

export interface ExplorationSnapshot {
  id: string;
  projectId: string;
  status: ExplorationStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** L'heure du serveur au moment de la réponse : la durée écoulée se calcule sans dépendre de l'horloge du client. */
  serverTime: string;
  budget: ExplorationBudget;
  counters: ExplorationCounters;
  error?: string;
  /** Le numéro du dernier événement émis. */
  lastSeq: number;
}

export type StopReason =
  | 'exhausted'
  | 'flows-only'
  | 'max-states'
  | 'max-actions'
  | 'max-duration'
  | 'engine-stop'
  | 'unreachable-start';

export interface ExplorationIssue {
  id: string;
  severity: Severity;
  type: string;
  message: string;
  pageUrl: string;
}

export const REPORT_KINDS = ['html', 'json', 'flowGraphHtml', 'overviewHtml'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Le résultat d'une exploration terminée : les chiffres du moteur (ExplorationResult), rien d'estimé. */
export interface ExplorationSummary {
  stopReason: StopReason;
  passed: boolean;
  durationMs: number;
  stats: {
    states: number;
    transitions: number;
    actionsExecuted: number;
    actionsBlocked: number;
    issuesBySeverity: Record<Severity, number>;
  };
  issues: ExplorationIssue[];
  /** Les rapports écrits par le moteur (nom de fichier dans le dossier de l'exploration). */
  reports: Partial<Record<ReportKind, string>>;
}

// ── Enregistrements, assertions, groupes, génération, graphe, rapports ─────────────────────────

/**
 * Le cycle de vie d'un enregistrement : un humain joue le parcours dans le Chromium ouvert par le
 * serveur (RECORDING), l'arrête depuis la barre de l'application ou par l'API, puis le moteur construit
 * le flow (PROCESSING) jusqu'à COMPLETED ou FAILED. STORED : lu sur disque (écrit avant le démarrage
 * du serveur, ou par la CLI).
 */
export const RECORDING_STATUSES = ['RECORDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'STORED'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

/** Un nom d'enregistrement tel que le moteur l'écrit (`recordings/<nom>/`). */
export const RECORDING_NAME_PATTERN = /^[a-z0-9#][a-z0-9#-]{0,79}$/;

export interface RecordingSummary {
  name: string;
  /** Les étapes du flow généré. */
  steps: number;
  /** Comment la session s'est arrêtée (barre de l'application, API, fermeture…), absent si lu sur disque. */
  stopReason?: string;
  /**
   * Le rejeu de validation (REPLAY_CONFIRMED, REPLAY_FAILED, NOT_VALIDATED) quand la session a tourné
   * sur ce serveur ; absent pour un enregistrement lu sur disque, qui ne le conserve pas.
   */
  replay?: string;
  proposals: { total: number; pending: number; inFlow: number };
  groups: number;
  /** Les fichiers écrits dans le dossier de l'enregistrement. */
  files: string[];
  warnings: string[];
}

export interface RecordingSnapshot {
  name: string;
  projectId: string;
  status: RecordingStatus;
  startedAt?: string;
  serverTime: string;
  lastSeq: number;
  summary?: RecordingSummary;
  error?: string;
}

/** Ce que le moteur signale pendant un enregistrement (événements du recorder, phases après l'arrêt). */
export type RecordingStreamEvent = { seq: number; at: string } & (
  | { type: 'status'; status: RecordingStatus }
  | { type: 'recorder'; event: string; message: string }
  | { type: 'phase'; phase: string }
  | { type: 'completed'; summary: RecordingSummary }
  | { type: 'failed'; error: string }
);

export interface FlowView {
  name: string;
  startAt: string;
  steps: { id: string; kind: string; description: string; groupId?: string }[];
  yaml?: string;
  feature?: string;
}

export type ProposalDecisionType = 'ACCEPT' | 'REJECT' | 'DISABLE' | 'RESET' | 'MODIFY';

export interface AssertionProposalView {
  id: string;
  origin: string;
  category: string;
  description: string;
  why: string;
  verificationMethod: 'UI_EXPECT' | 'BUSINESS_ASSERTION' | 'REPORT_ONLY';
  evidence: string[];
  limits: string[];
  confidence: number;
  needsConfirmation: boolean;
  recommended: boolean;
  status: string;
  /** Dans le flow : acceptée, modifiée, ou recommandée sans décision. */
  inFlow: boolean;
  afterStepId?: string;
  decidedAt?: string;
  note?: string;
  conflictsWith?: string[];
  /** L'étape `expect` du flow qui porte cette vérification (UI_EXPECT dans le flow). */
  stepId?: string;
  /** Le résultat au dernier rejeu ; `NOT_EXECUTED` quand aucun rejeu ne l'a vérifiée. */
  verdict: AssertionVerdict;
}

/**
 * LE VERDICT D'UNE ASSERTION, tel que le SDK le publie. Il vient toujours d'une exécution :
 *   VERIFIED_PASS   vérifiée et conforme (preuve observée)
 *   VERIFIED_FAIL   vérifiée et non conforme
 *   BLOCKED         non jouée : la politique de sécurité ou une étape précédente l'a empêchée
 *   INCONCLUSIVE    jouée sans preuve suffisante pour conclure
 *   NOT_EXECUTED    aucune exécution ne l'a vérifiée (jamais rejouée, ou ajoutée depuis)
 */
export const ASSERTION_VERDICTS = [
  'VERIFIED_PASS',
  'VERIFIED_FAIL',
  'BLOCKED',
  'INCONCLUSIVE',
  'NOT_EXECUTED',
] as const;
export type AssertionVerdictStatus = (typeof ASSERTION_VERDICTS)[number];

export interface AssertionVerdict {
  status: AssertionVerdictStatus;
  /** Qui a conclu : le rejeu de l'étape `expect`, ou le moteur d'assertions métier. */
  source?: 'REPLAY_STEP' | 'QUALITY_ENGINE';
  /** Le statut tel que le moteur l'a écrit (MATCHED, FAIL, UNVERIFIABLE…). */
  engineStatus?: string;
  reasons: string[];
  observed?: string;
  /** Les identifiants des preuves du moteur. */
  evidence?: string[];
  at?: string;
  /** Le flow a changé depuis cette exécution. */
  stale?: boolean;
}

export interface ProposalDecisionInput {
  decision: ProposalDecisionType;
  description?: string;
  mandatory?: boolean;
  criticality?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  note?: string;
}

export interface GroupViewDto {
  id: string;
  name: string;
  description?: string;
  stepIds: string[];
  positions: number[];
  collapsed?: boolean;
  startAt: string;
  checks: string[];
  assertionIds: string[];
  runnableAlone: { ok: boolean; missing: string[] };
  /** Ses entrées (données produites ailleurs) et ses sorties (données citées ailleurs). */
  data?: {
    inputs: { key: string; producerStepId?: string; producerGroupId?: string }[];
    outputs: { key: string; consumerStepIds: string[] }[];
  };
}

/**
 * Le résultat d'une étape au dernier rejeu du flow, tel que le moteur l'a écrit (dry run) :
 * retrouvée et jouée (`MATCHED`), vérification différente, plusieurs candidats, refusée par la
 * SafetyPolicy, introuvable, non vérifiée.
 */
export const STEP_REPLAY_OUTCOMES = [
  'MATCHED',
  'ASSERTION_MISMATCH',
  'AMBIGUOUS',
  'BLOCKED_BY_POLICY',
  'NOT_FOUND',
  'NOT_VERIFIED',
] as const;
export type StepReplayOutcome = (typeof STEP_REPLAY_OUTCOMES)[number];

export interface StudioStep {
  id: string;
  /** Position 1…n dans le flow tel qu'écrit. */
  position: number;
  kind: string;
  description: string;
  groupId?: string;
  /** Les clés de données de test citées et produites (jamais une valeur). */
  consumes: string[];
  produces: string[];
  /** Absent : l'étape n'a pas été rejouée (aucun rejeu, ou étape ajoutée depuis). */
  replay?: { outcome: StepReplayOutcome; reasons: string[] };
}

/** Une donnée produite par une étape et citée par une autre. */
export interface StudioDependency {
  from: string;
  to: string;
  key: string;
}

/** Une étape qui cite une donnée avant l'étape qui la produit. */
export interface StudioViolation {
  stepId: string;
  key: string;
  producerStepId: string;
  message: string;
}

/** La vue du Flow Studio : le flow, ses groupes, ses dépendances, et le dernier rejeu s'il existe. */
export interface FlowStudioView {
  name: string;
  startAt: string;
  steps: StudioStep[];
  groups: GroupViewDto[];
  dependencies: StudioDependency[];
  violations: StudioViolation[];
  replay?: {
    /** Le statut du dry run (FULLY_MATCHED…). */
    status: string;
    at: string;
    /** Le flow a été modifié après ce rejeu : les résultats peuvent ne plus correspondre. */
    stale: boolean;
  };
}

/** D'où vient la valeur d'une saisie : gardée, générée à chaque rejeu, ou reprise d'une étape antérieure. */
export const DATA_SOURCES = ['FIXED', 'GENERATED', 'REFERENCE'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

export interface DataStepRef {
  stepId: string;
  /** Position parmi les étapes d'action (1…n). */
  position: number;
  label: string;
}

/** Une donnée du parcours : qui la produit, qui la saisit à nouveau ou la cite. Jamais un secret. */
export interface DataVariableView {
  key: string;
  /** RECORDED_LITERAL, GENERATE_AT_REPLAY, REFERENCE, TEMPLATE… (le mot du moteur). */
  strategy: string;
  generator?: string;
  producedBy?: DataStepRef;
  usedBy: (DataStepRef & { how: 'INPUT' | 'CITATION' })[];
}

/** La source de la valeur d'une saisie et ce qu'on peut y lier. */
export interface DataInputView extends DataStepRef {
  source: DataSource | 'SENSITIVE';
  key?: string;
  generator?: string;
  reference?: string;
  /** La valeur enregistrée quand elle est gardée en clair (jamais un secret). */
  recordedValue?: string;
  /** Les données produites AVANT cette saisie : les seules réutilisables. */
  options: (DataStepRef & { key: string; strategy: string })[];
  /** Choisie par un humain (registre des décisions), et non par la détection automatique. */
  manual: boolean;
}

/** Une donnée citée qu'aucune étape ne produit et que le jeu de données ne contient pas. */
export interface MissingDataView {
  key: string;
  stepIds: string[];
  message: string;
}

export interface TestDataView {
  variables: DataVariableView[];
  inputs: DataInputView[];
  missing: MissingDataView[];
  generators: readonly string[];
}

export interface DataBindingInput {
  stepId: string;
  source: DataSource;
  /** GENERATED : le nom de la variable ; REFERENCE : la donnée reprise. */
  variable?: string;
  generator?: string;
  /** FIXED : la valeur (par défaut, celle de l'enregistrement). */
  value?: string;
}

export interface DataBindingResult {
  decision: {
    id: string;
    stepId: string;
    source: DataSource;
    variable: string;
    previousKey?: string;
    at: string;
  };
  data: TestDataView;
}

export type GroupCommandInput =
  | { op: 'create'; name: string; description?: string; stepIds?: string[] }
  | { op: 'rename'; groupId: string; name: string }
  | { op: 'describe'; groupId: string; description: string }
  | { op: 'assign'; groupId: string; stepIds: string[] }
  | { op: 'detach'; stepIds: string[] }
  | { op: 'move-step'; stepId: string; direction: 'up' | 'down' }
  | { op: 'reorder-steps'; groupId: string; stepIds: string[] }
  | { op: 'move-group'; groupId: string; direction: 'up' | 'down' }
  | { op: 'collapse'; groupId: string; collapsed: boolean }
  | { op: 'delete'; groupId: string; keepSteps?: boolean };

export interface GroupEditResult {
  groups: GroupViewDto[];
  warnings: string[];
}

export const GENERATION_FORMATS = ['yaml', 'gherkin', 'playwright', 'java'] as const;
export type GenerationFormatName = (typeof GENERATION_FORMATS)[number];

export interface GenerationInput {
  formats: GenerationFormatName[];
  groupIds?: string[];
  /** Générer malgré une entrée produite hors des groupes choisis. */
  force?: boolean;
}

export interface GeneratedFileView {
  format: GenerationFormatName;
  /** Chemin relatif au dossier `generated/` de l'enregistrement. */
  path: string;
  /** GENERATED, STATICALLY_VALIDATED, NOT_VALIDATED… : jamais « exécuté » ici. */
  status: string;
  validation?: { method: string; ok: boolean; messages: string[] };
  assertions: { id: string; description: string; support: 'NATIVE' | 'REPLAY_ONLY'; status: string }[];
  limits: string[];
  content: string;
}

export interface GenerationResult {
  files: GeneratedFileView[];
  warnings: string[];
}

export interface GraphView {
  rootId?: string;
  nodes: { id: string; label: string; route: string; title: string; depth: number }[];
  edges: {
    from: string;
    to: string;
    action: string;
    type: string;
    classification?: string;
    result: string;
    reason?: string;
  }[];
}

export type ReportEntryKind = 'exploration' | 'recording';

export interface ReportEntry {
  kind: ReportEntryKind;
  /** Le dossier : `run-…` pour une exploration, le nom pour un enregistrement. */
  name: string;
  createdAt: string;
  /** Exploration : écrans, actions, anomalies, raison d'arrêt (lus dans result.json). */
  exploration?: { states: number; actions: number; issues: number; stopReason: string };
  /** Enregistrement : étapes du flow. */
  recording?: { steps: number };
  hasGraph: boolean;
}

/** Un lien de courte durée vers les rapports (les fichiers HTML ne peuvent pas porter d'en-tête d'autorisation). */
export interface ReportLink {
  url: string;
  expiresAt: string;
}

export interface ErrorBody {
  error: string;
  status: number;
  code: string;
  details?: string[];
  issues?: DraftIssue[];
}

/** Les événements DOM émis par l'assistant (bubbles + composed). */
export const WIZARD_EVENTS = {
  projectCreated: 'qa-project-created',
  explorationStarted: 'qa-exploration-started',
  explorationProgress: 'qa-exploration-progress',
  explorationCompleted: 'qa-exploration-completed',
  explorationFailed: 'qa-exploration-failed',
  error: 'qa-error',
} as const;

/** Les événements DOM du Flow Studio (bubbles, composed). */
export const STUDIO_EVENTS = {
  /** `detail: { stepIds, groupId? }` : la sélection a changé. */
  selection: 'qa-studio-selection',
  /** `detail: { command, warnings }` : le moteur a accepté une commande de groupe. */
  changed: 'qa-studio-changed',
  /** `detail: { command, message, violations }` : le moteur a refusé une commande (rien n'a changé). */
  refused: 'qa-studio-refused',
  error: 'qa-error',
} as const;
