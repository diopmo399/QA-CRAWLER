/**
 * LES CONTRATS DU SDK : ce que l'hôte, le client navigateur et le serveur QA-CRAWLER échangent.
 * Ce fichier ne dépend de rien (ni Node, ni DOM) : il est lu par le navigateur comme par le serveur.
 *
 * Un brouillon de projet (ProjectDraft) ne porte jamais de secret : seulement des NOMS de variables
 * d'environnement, que le serveur lit lui-même. Les compteurs d'une exploration viennent des
 * événements du moteur ; aucun pourcentage global, aucune durée restante ne sont calculés.
 * Les exigences échangées par l'API sont décrites dans requirements-contracts.ts.
 */

import type {
  CanonicalEntity,
  ConnectorDescription,
  DuplicateStatus,
  ImportStatus,
  ItemDecision,
  LinkEnd,
  LinkType,
  SourceKind,
  TraceabilityLink,
} from './requirements-contracts.js';

export type * from './requirements-contracts.js';

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
  /**
   * Une exploration ou un rejeu s'annule (`explorations.cancel`) : en file, elle n'est jamais lancée ;
   * en cours, le moteur s'arrête à la prochaine vérification de ses limites et écrit son rapport.
   */
  cancellation: boolean;
  /**
   * La politique de sécurité commune à toute exécution : les risques toujours bloqués (suppression,
   * paiement, envoi…), quel que soit l'environnement. Ajouté à la v1 : absent d'un serveur plus ancien.
   */
  safety?: { blocked: string[] };
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
  // La plateforme : cycle de vie des projets, environnements, scénarios, exécutions, vue d'ensemble.
  'lifecycle',
  'environments',
  'scenarios',
  'executions',
  'overview',
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
  /** Un flow imposé de la mission commence (`start`) ou se termine (`end`, avec son statut). */
  | {
      seq: number;
      at: string;
      type: 'flow';
      flow: string;
      phase: 'start' | 'end';
      status?: string;
      durationMs?: number;
      steps?: number;
    }
  /**
   * Une étape d'un flow imposé, jouée par le moteur : PASSED, FAILED, BLOCKED, SKIPPED ou MANUAL. Le
   * libellé ne porte jamais la valeur saisie (une étape `fill` est décrite par sa cible seulement).
   */
  | {
      seq: number;
      at: string;
      type: 'flow-step';
      flow: string;
      index: number;
      kind: string;
      label: string;
      status: string;
      durationMs: number;
      reason?: string;
    }
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
  /** EXPLORATION (exploration autonome) ou REPLAY (rejeu des scénarios) ; absent : EXPLORATION. */
  kind?: ExecutionKind;
  /** Le dossier du run sous `qa-reports/` (`run-…`) : la clé de l'exécution une fois terminée. */
  run?: string;
}

export type StopReason =
  | 'exhausted'
  | 'flows-only'
  | 'max-states'
  | 'max-actions'
  | 'max-duration'
  | 'engine-stop'
  | 'unreachable-start'
  | 'cancelled';

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

/**
 * UN GESTE ENREGISTRÉ, en direct : sa phrase (« Cliquer sur "Valider" »), la page, son statut de
 * validation dit en mots simples, et, quand la cible est ambiguë, les éléments qui correspondent. Jamais
 * une valeur saisie : une saisie se dit « Saisir dans "Titre" ».
 */
export interface LiveStepView {
  id: string;
  index: number;
  kind: string;
  description: string;
  detail?: string;
  page: string;
  /** PENDING, CONFIRMED, AMBIGUOUS, FAILED, UNVERIFIED… */
  status: string;
  statusText: string;
  candidates?: { index: number; label: string; original: boolean }[];
  resolution?: 'RESOLVED' | 'IGNORED' | 'CORRECTED';
}

/** La timeline en direct d'un enregistrement : les gestes, la pause, les vérifications posées. */
export interface LiveTimelineView {
  paused: boolean;
  steps: LiveStepView[];
  checkpoints: string[];
}

/** Les commandes d'un enregistrement en cours (les boutons de la barre d'enregistrement). */
export const RECORDING_CONTROLS = ['pause', 'resume', 'undo', 'checkpoint', 'resolve', 'ignore'] as const;
export type RecordingControl = (typeof RECORDING_CONTROLS)[number];

/** Ce que le moteur signale pendant un enregistrement (événements du recorder, phases après l'arrêt). */
export type RecordingStreamEvent = { seq: number; at: string } & (
  | { type: 'status'; status: RecordingStatus }
  | { type: 'recorder'; event: string; message: string }
  /** Après l'arrêt : la phase en cours, son rang (1…total) et le détail du moment. */
  | { type: 'phase'; phase: string; step?: number; total?: number; detail?: string }
  /** Seul le dernier état est gardé : un abonné qui arrive le reçoit, jamais tout l'historique. */
  | ({ type: 'timeline' } & LiveTimelineView)
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
  /** L'étape vise un élément : sa cible peut être corrigée. */
  targeted?: boolean;
  /** La cible a été corrigée par un humain (l'original se restaure). */
  corrected?: boolean;
  /** La cible est une ligne de tableau dont les cellules ont été enregistrées (la ligne se redéfinit). */
  row?: boolean;
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

/** Un découpage proposé d'après les étapes métier reconnues : jamais créé sans décision humaine. */
export interface GroupProposalView {
  name: string;
  stepIds: string[];
  /** Numéros (1…n) de la première et de la dernière action. */
  from: number;
  to: number;
  action: string;
  confidence: number;
}

/** Une vérification suggérée : la donnée reçue d'un autre groupe est visible à la fin de celui-ci. */
export interface GroupCheckView {
  groupId: string;
  groupName: string;
  key: string;
  afterStepId: string;
}

/** Le rejeu de validation d'un enregistrement écrit (dry run, mémoire isolée), lancé depuis le SDK. */
export interface RecordingReplayView {
  status: 'NONE' | 'RUNNING' | 'REPLAY_CONFIRMED' | 'REPLAY_FAILED';
  executed?: number;
  total?: number;
  /** Le statut du dry run (FULLY_MATCHED…). */
  dryRunStatus?: string;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Le dernier rejeu écrit sur disque ; stale : le flow a changé depuis. */
  last?: { status: string; at: string; stale: boolean };
}

/** L'intention d'une action enregistrée (créer, rechercher, ouvrir…) : automatique, puis revue par un humain. */
export interface IntentRowView {
  actionId: string;
  kind: string;
  label: string;
  /** L'intention finale : la décision humaine en vigueur, sinon l'interprétation automatique. */
  intent: string;
  /** INFERRED, HUMAN_CORRECTED, HUMAN_CONFIRMED. */
  status: string;
  source: 'HUMAN' | 'SYSTEM';
  confidence?: number;
  original?: string;
  reason?: string;
}

export interface IntentReviewView {
  /** Les intentions qu'un humain peut choisir. */
  choices: string[];
  rows: IntentRowView[];
}

export interface IntentDecisionInput {
  actionId: string;
  type: 'CORRECT' | 'CONFIRM' | 'RESET';
  intent?: string;
  reason?: string;
}

/** La ligne de tableau visée par une étape : sa cible, ses cellules enregistrées, les données citables. */
export interface RowSourceView {
  target: string;
  cells: { column: string; value: string }[];
  /** Les données du jeu de test citables avant l'étape (jamais une donnée sensible). */
  variables: { key: string; value: string }[];
}

/** Une colonne de la ligne et la source de sa valeur au rejeu. */
export interface RowColumnInput {
  column: string;
  source: 'recorded' | 'value' | 'variable' | 'new-variable';
  value?: string;
  key?: string;
  match?: 'exact' | 'contains';
}

/**
 * UNE SESSION DE CORRECTION DE CIBLE : le serveur rejoue les étapes précédentes dans un navigateur
 * ouvert sur sa machine, la page reste tenue devant l'étape, l'humain y désigne l'élément voulu.
 */
export interface CorrectionView {
  stepId: string;
  label: string;
  /**
   * REPLAYING (étapes précédentes), PICKING (désigner l'élément), HELD (page tenue, rien désigné),
   * PICKED (proposition à valider), APPLIED (cible remplacée), RESUMING, RESUMED, UNREACHABLE (le
   * chemin s'est arrêté avant l'étape), FAILED.
   */
  status: string;
  executed: number;
  total: number;
  stoppedAt?: { index: number; label: string; reason: string };
  proposal?: {
    label: string;
    current: string;
    next: string;
    order: string[];
    ambiguous: boolean;
    traits: {
      role: string;
      name?: string;
      label?: string;
      text?: string;
      testId?: string;
      tag: string;
      section?: string;
    };
    rowOptions?: { id: string; row: Record<string, string>; via?: string; match?: string; fixed?: boolean }[];
    rowCells?: { column: string; value: string }[];
    /** Les données du run auxquelles une colonne peut être liée (leurs clés). */
    variables?: string[];
  };
  applied?: { previous: string; next: string };
  /** La reprise du rejeu à l'étape corrigée (même session, mêmes données). */
  resumable?: boolean;
  resume?: {
    status: 'PASSED' | 'FAILED' | 'MANUAL_RECOVERY';
    from: number;
    strategy: string;
    reasons: string[];
  };
  error?: string;
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

/**
 * La couverture d'une exigence, telle que le moteur la calcule (`quality-verification.json`) :
 * NOT_COVERED (aucun flow ne la cite), COVERED_NOT_EXECUTED, VERIFIED_PASS, VERIFIED_FAIL, BLOCKED,
 * INCONCLUSIVE, STALE_EVIDENCE (pas exécutée dans ce run, dernière preuve trop ancienne).
 */
export const COVERAGE_STATUSES = [
  'NOT_COVERED',
  'COVERED_NOT_EXECUTED',
  'VERIFIED_PASS',
  'VERIFIED_FAIL',
  'BLOCKED',
  'INCONCLUSIVE',
  'STALE_EVIDENCE',
] as const;
export type CoverageStatusName = (typeof COVERAGE_STATUSES)[number];

/** Le vocabulaire de l'analyse de régression du moteur (`regression-analysis.json`). */
export const REGRESSION_STATUSES = [
  'NEW_REGRESSION',
  'REGRESSION_PERSISTING',
  'REGRESSION_FIXED',
  'FLAKY_BEHAVIOR',
  'KNOWN_FAILURE',
  'NEW_BEHAVIOR',
  'EXPECTED_CHANGE',
] as const;
export type RegressionStatusName = (typeof REGRESSION_STATUSES)[number];

export interface TraceAssertionView {
  flow: string;
  id: string;
  /** PASS, FAIL, BLOCKED, INCONCLUSIVE, UNVERIFIABLE ou NOT_EXECUTED (moteur d'assertions). */
  status: string;
  mandatory: boolean;
  criticality?: string;
  evidence: string[];
}

export interface RequirementView {
  id: string;
  description: string;
  criticality: string;
  source?: string;
  declared: boolean;
  status: CoverageStatusName;
  flows: string[];
  rules: string[];
  operations: string[];
  assertions: TraceAssertionView[];
  evidence: string[];
  dependsOn: string[];
  reasons: string[];
  lastVerified?: { status: CoverageStatusName; at: string; runId: string };
}

export interface RuleView {
  id: string;
  description: string;
  requirementIds: string[];
  status: CoverageStatusName;
  assertions: TraceAssertionView[];
  conflictsWith: string[];
  reasons: string[];
}

/** La traçabilité d'une exploration : exigences ↔ règles ↔ flows ↔ assertions ↔ preuves. */
export interface TraceabilityView {
  run: string;
  generatedAt: string;
  /** Le verdict métier du run (PASS, FAIL, BLOCKED, INCONCLUSIVE, UNVERIFIABLE, NOT_DECLARED). */
  verdict: string;
  requirements: RequirementView[];
  rules: RuleView[];
  warnings: string[];
  summary: {
    total: number;
    byStatus: Record<CoverageStatusName, number>;
    criticalFailures: string[];
    /** Part des exigences exécutées vérifiées PASS (calculée par le moteur) ; null quand aucune n'a été exécutée. */
    passRate: number | null;
  };
  /** Ce que la vérification ne peut pas affirmer (écrit par le moteur dans chaque rapport). */
  limits: string[];
}

export interface RegressionEntryView {
  status: RegressionStatusName;
  subject: string;
  anomalyId?: string;
  evidence: string[];
  source: 'RUNTIME' | 'HISTORICAL';
}

/** L'analyse de régression d'une exploration, par rapport à l'historique du moteur. */
export interface RegressionView {
  run: string;
  entries: RegressionEntryView[];
  summary: Record<RegressionStatusName, number>;
}

/** Les écarts d'un flow entre deux exécutions (`compareFlowRuns` du moteur). */
export interface FlowComparisonView {
  name: string;
  presence: 'BOTH' | 'ONLY_BASE' | 'ONLY_HEAD';
  baseStatus?: string;
  headStatus?: string;
  /** SAME : même statut, mêmes étapes, aucune dérive notable (seuils du moteur). */
  verdict?: 'SAME' | 'CHANGED';
  durationDeltaMs?: number;
  /** FLOW_STATUS, STEP_STATUS, STEP_SLOWER, STEP_FASTER, TARGET_CHANGED, TARGET_HEALED, EFFECT_CHANGED, STEP_CHANGED, STEP_ADDED, STEP_REMOVED. */
  changes: { kind: string; step?: number; detail: string }[];
}

/** La couverture d'une exigence dans chacune des deux exécutions (absente : pas de traçabilité, ou pas citée). */
export interface RequirementComparisonView {
  id: string;
  description: string;
  criticality: string;
  baseStatus?: CoverageStatusName;
  headStatus?: CoverageStatusName;
  changed: boolean;
}

/** Deux explorations d'un même projet, comparées sans rien rejouer. */
export interface RunComparisonView {
  base: { run: string; at: string };
  head: { run: string; at: string };
  flows: FlowComparisonView[];
  /** Vide quand aucune des deux exécutions n'a de traçabilité (la mission ne déclare pas d'exigence). */
  requirements: RequirementComparisonView[];
  traceability: { base: boolean; head: boolean };
  summary: {
    flows: number;
    changed: number;
    same: number;
    onlyBase: number;
    onlyHead: number;
    /** Flows PASSED dans la base et pas dans la tête. */
    newlyFailing: string[];
    /** Flows non PASSED dans la base et PASSED dans la tête. */
    newlyPassing: string[];
    requirementsChanged: number;
  };
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
/** Les événements DOM du Run Monitor (bubbles + composed). */
export const MONITOR_EVENTS = {
  /** `detail: { state, attempt }` : connecting, live, reconnecting, closed ou lost. */
  connection: 'qa-monitor-connection',
  error: 'qa-error',
} as const;

/** Les événements DOM de la comparaison d'exécutions (bubbles + composed). */
export const RUNS_EVENTS = {
  /** `detail: { base, head }` : les deux exécutions comparées ont changé. */
  selection: 'qa-runs-selection',
  error: 'qa-error',
} as const;

/** Les événements DOM du Dashboard (bubbles, composed). */
export const DASHBOARD_EVENTS = {
  /** `detail: { route }` : la vue affichée a changé (vue d'ensemble, projets, projet, exécution). */
  navigate: 'qa-dashboard-navigate',
  /** `detail: { projectId, exploration }` : un rejeu a été lancé depuis le Dashboard. */
  executionStarted: 'qa-execution-started',
  error: 'qa-error',
} as const;

export const STUDIO_EVENTS = {
  /** `detail: { stepIds, groupId? }` : la sélection a changé. */
  selection: 'qa-studio-selection',
  /** `detail: { command, warnings }` : le moteur a accepté une commande de groupe. */
  changed: 'qa-studio-changed',
  /** `detail: { command, message, violations }` : le moteur a refusé une commande (rien n'a changé). */
  refused: 'qa-studio-refused',
  error: 'qa-error',
} as const;

// ── Plateforme : projets, environnements, scénarios, exécutions, vue d'ensemble ───────────────

/** ACTIVE ; ARCHIVED : gardé sur disque, en lecture seule (aucune exécution), restaurable. */
export const PROJECT_STATES = ['ACTIVE', 'ARCHIVED'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/** Un projet dans une liste : sa fiche et ce qu'il contient, compté sur disque. */
export interface ProjectSummary extends Omit<Project, 'status'> {
  status: Project['status'];
  state: ProjectState;
  updatedAt?: string;
  archivedAt?: string;
  counts: { environments: number; scenarios: number; recordings: number; executions: number };
  /** La dernière exécution terminée (lue dans son result.json), s'il y en a une. */
  lastExecution?: ExecutionRecord;
}

/** Le détail d'un projet : son brouillon (la configuration du moteur), ses environnements, ses scénarios. */
export interface ProjectDetail extends ProjectSummary {
  draft: ProjectDraft;
  environments: Environment[];
  scenarios: ScenarioView[];
}

export const ENVIRONMENT_KINDS = ['DEVELOPMENT', 'TEST', 'CERTIFICATION', 'PREPRODUCTION', 'OTHER'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/**
 * UN ENVIRONNEMENT d'un projet : la cible d'une exécution. Aucun secret : `secretEnv` nomme des
 * variables d'environnement lues sur le serveur, jamais renvoyées ; `variables` sont des valeurs non
 * secrètes (un nom qui ressemble à un secret est refusé) passées au moteur comme `${env:NOM}`.
 */
export interface EnvironmentInput {
  name: string;
  kind: EnvironmentKind;
  baseUrl: string;
  /** Les hôtes que le navigateur peut visiter (safety.allowedHosts) ; vide : l'hôte de baseUrl seul. */
  allowedDomains?: string[];
  variables?: Record<string, string>;
  secretEnv?: string[];
  limits?: { actionTimeoutMs?: number; maxDurationMinutes?: number; maxStates?: number; maxActions?: number };
  /**
   * Les écritures (créer, modifier : actions MUTATION de la SafetyPolicy) permises dans CET
   * environnement, bornées par run. Absent : aucune écriture. Les actions DANGEROUS restent bloquées.
   */
  mutations?: { enabled: boolean; maxPerRun?: number };
}

export interface Environment extends EnvironmentInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** La vérification d'un environnement avant un lancement (format, règles du moteur, variables, URL). */
export interface EnvironmentCheck {
  ok: boolean;
  issues: { field: string; message: string }[];
  /** Les variables secrètes citées et leur présence sur le serveur (jamais leur valeur). */
  secrets: Record<string, boolean>;
  url?: UrlCheck;
}

/** UN SCÉNARIO : un flow du projet (`qa-crawler/flows/`), joué par le rejeu du moteur. */
export interface ScenarioView {
  name: string;
  /** Le fichier, relatif au dossier des flows. */
  file: string;
  format: 'yaml' | 'gherkin';
  /** Étapes du flow (YAML) ; absent pour un .feature (lu par le moteur au lancement). */
  steps?: number;
  /** L'enregistrement d'où il vient, quand le SDK l'a promu. */
  fromRecording?: string;
  description?: string;
  /** Un bloc de la bibliothèque : jamais exécuté seul, rejoué par d'autres scénarios (`run:`). */
  reusable?: boolean;
  /** Les blocs (ou scénarios) que ce scénario rejoue par `run:`, dans l'ordre. */
  uses?: string[];
}

/**
 * UN BLOC DE LA BIBLIOTHÈQUE : un parcours réutilisable (`reusable: true`), rejoué par d'autres
 * scénarios avec une étape `run: <nom>`. Ses données de test suivent quand on l'insère.
 */
export interface LibraryBlockView {
  name: string;
  /** Le fichier, relatif au dossier des flows. */
  file: string;
  steps: number;
  startAt?: string;
  description?: string;
  /** D'où il vient : un scénario, ou un groupe d'un enregistrement. */
  origin?: { kind: 'scenario' | 'recording'; name: string; group?: string };
  /** Les données qu'il saisit ({ testData: clé }) et celles qu'il cite (${testData:clé}). */
  inputs: string[];
  citations: string[];
  /** Les scénarios qui le rejouent. */
  usedBy: string[];
}

export type LibraryAddInput =
  | { from: 'scenario'; scenario: string; name: string; description?: string }
  | { from: 'recording'; recording: string; groupId: string; name: string; description?: string };

/** Un nouveau scénario fait de blocs de la bibliothèque, rejoués dans l'ordre. */
export interface ComposeScenarioInput {
  name: string;
  parts: string[];
  description?: string;
}

/** Le statut du flow d'un scénario dans un run. */
export interface ScenarioRunStatus {
  run: string;
  at: string;
  /** PASSED, FAILED, SKIPPED, BLOCKED… tel que le moteur l'a écrit. */
  status: string;
  durationMs: number;
}

/**
 * La stabilité d'un scénario sur ses derniers runs : ses statuts (du plus récent au plus ancien), les
 * réussites et échecs parmi eux, et ses bascules (PASSED ↔ FAILED entre deux runs consécutifs).
 */
export interface ScenarioHistoryView {
  name: string;
  runs: ScenarioRunStatus[];
  passed: number;
  failed: number;
  flips: number;
}

export const EXECUTION_KINDS = ['EXPLORATION', 'REPLAY'] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/** Lancer une exécution : rejouer des scénarios du projet (tous par défaut) dans un environnement. */
export interface ExecutionStartInput {
  scenarios?: string[];
  environmentId?: string;
}

/**
 * Le verdict d'une exécution, lu dans le résultat du moteur : PASSED (tous les flows joués PASSED),
 * FAILED (au moins un flow non PASSED), NO_FLOW (exploration sans flow), INCOMPLETE (pas de résultat),
 * CANCELLED (annulée à la demande : le moteur s'est arrêté, ce qu'il a joué reste dans le run).
 */
export const EXECUTION_VERDICTS = ['PASSED', 'FAILED', 'NO_FLOW', 'INCOMPLETE', 'CANCELLED'] as const;
export type ExecutionVerdict = (typeof EXECUTION_VERDICTS)[number];

/** Une exécution terminée (un run sur disque) : ce que le SDK en sait sans le recalculer. */
export interface ExecutionRecord {
  run: string;
  projectId: string;
  kind: ExecutionKind;
  createdAt: string;
  verdict: ExecutionVerdict;
  durationMs?: number;
  flows: { total: number; passed: number; failed: number };
  issues: number;
  environment?: { id: string; name: string };
  scenarios?: string[];
}

/** Une étape jouée, telle que le moteur l'a rapportée (libellé sans valeur saisie). */
export interface ExecutionStepView {
  index: number;
  kind: string;
  label: string;
  status: string;
  durationMs: number;
  reason?: string;
  /** La capture de l'étape, relative au dossier du run (servie par un lien de rapport). */
  screenshot?: string;
}

export interface ExecutionFlowView {
  name: string;
  status: string;
  durationMs: number;
  steps: ExecutionStepView[];
  /** La première divergence (la vraie cause, quand le symptôme est plus loin). */
  divergence?: { stepIndex: number; reason: string };
  /** Les assertions métier jouées : leur statut, jamais un succès par défaut. */
  assertions: { id: string; description: string; status: string }[];
  /** Les clés de données de test utilisées (jamais leurs valeurs). */
  testData: string[];
}

export interface ExecutionDetail extends ExecutionRecord {
  stopReason?: StopReason;
  flowsDetail: ExecutionFlowView[];
  issuesList: ExplorationIssue[];
  reports: Partial<Record<ReportKind, string>>;
}

/** Une alerte de la vue d'ensemble : ce qui demande une action, et où. */
export interface OverviewAlert {
  kind: 'EXECUTION_FAILED' | 'CRITICAL_ISSUES' | 'SECRET_MISSING';
  projectId: string;
  projectName: string;
  message: string;
  run?: string;
}

/**
 * LA VUE D'ENSEMBLE, calculée sur disque. Le taux de réussite dit son périmètre : les exécutions de
 * REJEU terminées dans la période (celles dont le moteur a écrit le résultat) ; réussie = verdict PASSED.
 */
export interface OverviewView {
  generatedAt: string;
  period: { days: number; from: string; to: string };
  projects: { active: number; archived: number };
  scenarios: number;
  recordings: number;
  executions: { total: number; byKind: Record<ExecutionKind, number> };
  replays: { finished: number; passed: number; failed: number; passRate?: number; definition: string };
  issues: Record<Severity, number>;
  recent: (ExecutionRecord & { projectName: string })[];
  alerts: OverviewAlert[];
  /** Par jour de la période : rejeux réussis et échoués. */
  trend: { day: string; passed: number; failed: number }[];
}

// ── Exigences ───────────────────────────────────────────────────────────────────────────────

/** Les connecteurs de source : ce qu'ils lisent, leur taille maximale, leurs limites. */
export type RequirementConnectorView = ConnectorDescription & {
  /** FILE : un fichier envoyé au serveur ; CONFLUENCE : une page lue par le serveur. */
  transport: 'FILE' | 'CONFLUENCE';
};

/** Un lot d'importation résumé (liste des imports). */
export interface ImportSummary {
  id: string;
  connector: SourceKind;
  status: ImportStatus;
  createdAt: string;
  updatedAt: string;
  source: { title: string; uri?: string; version?: string };
  completeness: 'COMPLETE' | 'PARTIAL' | 'EMPTY';
  candidates: number;
  /** Candidats qui attendent encore une décision. */
  toDecide: number;
  decided: number;
  published: number;
  byDuplicate: Partial<Record<DuplicateStatus, number>>;
  issues: { errors: number; warnings: number; first?: string };
  missingFromSource: number;
}

/** Une page Confluence à importer : les secrets sont des NOMS de variables lues par le serveur. */
export interface ConfluenceImportInput {
  baseUrl: string;
  page: string;
  variant?: 'cloud' | 'datacenter';
  auth: { userEnv?: string; tokenEnv: string };
  profile?: string;
}

/** Un fichier Word, Excel ou PDF envoyé au serveur (le contenu va dans le corps de la requête). */
export interface FileImportInput {
  connector: 'WORD' | 'EXCEL' | 'PDF';
  name: string;
  data: Uint8Array | ArrayBuffer | Blob;
  profile?: string;
}

export interface RequirementDecisionInput {
  itemId: string;
  decision: Omit<ItemDecision, 'at' | 'by'>;
}

export interface RequirementsPublishResult {
  created: string[];
  updated: string[];
  merged: string[];
  links: string[];
}

/** Le référentiel publié d'un projet. */
export interface RequirementsView {
  entities: CanonicalEntity[];
  links: TraceabilityLink[];
  /** Candidats d'import qui attendent une décision, tous lots confondus. */
  pending: number;
}

export interface LinkAddInput {
  type: LinkType;
  from: LinkEnd;
  to: LinkEnd;
  justification: string[];
}

/** Une extrémité de lien vue depuis une ligne de la matrice. */
export interface MatrixLinkCell {
  linkId: string;
  type: LinkType;
  /** L'autre extrémité. */
  target: LinkEnd;
  /** L'identifiant externe de la cible (REQ-12…) quand c'est un élément du référentiel qui en a un. */
  label?: string;
  validation: TraceabilityLink['validation'];
  freshness: TraceabilityLink['freshness'];
  confidence: TraceabilityLink['confidence'];
}

/** UNE LIGNE DE LA MATRICE DE TRAÇABILITÉ : un élément publié et ses liens, groupés par rôle. */
export interface MatrixRow {
  id: string;
  externalId?: string;
  kind: CanonicalEntity['kind'];
  title: string;
  version: number;
  sources: SourceKind[];
  /** Règles et critères rattachés (HAS_RULE, HAS_CRITERION). */
  children: MatrixLinkCell[];
  /** IMPLEMENTED_BY. */
  implementedBy: MatrixLinkCell[];
  /** TESTED_BY, VERIFIED_BY. */
  verifiedBy: MatrixLinkCell[];
  /** Les autres liens (DEPENDS_ON, DERIVED_FROM, OBSERVED_IN, ou le lien vers le parent). */
  other: MatrixLinkCell[];
}

/** Un ratio expliqué : rien n'est affiché sans son numérateur et son dénominateur. */
export interface Ratio {
  numerator: number;
  denominator: number;
  /** Absent quand le dénominateur est nul. */
  value?: number;
}

/**
 * LES INDICATEURS d'un projet, calculés sur le référentiel et sur les runs du moteur. Les formules et
 * les limites sont dites par l'interface (une par identifiant) ; un indicateur qui demande la
 * corrélation automatique (phase 5) est rendu `available: false`, jamais estimé.
 */
export interface RequirementsIndicators {
  generatedAt: string;
  period: { days: number; from: string; to: string };
  published: { total: number; requirements: number; rules: number; criteria: number };
  coverage: Ratio & { proposedOnly: number };
  recentEvidence: { available: false; reason: 'CORRELATION_NOT_AVAILABLE' };
  replays: Ratio & { cancelled: number; withoutVerdict: number };
  links: Ratio & { confirmed: number; proposed: number; possiblyStale: number; rejected: number };
  gaps: { withoutImplementation: number; withoutTest: number; staleLinks: number; pendingCandidates: number };
}

/** LES TENDANCES par semaine ISO (lundi, UTC), sur un projet ou tous. */
export interface TrendsView {
  generatedAt: string;
  projectId?: string;
  weeks: TrendWeek[];
  /** Les scénarios qui changent le plus souvent de verdict (au moins une bascule), du plus instable au moins instable. */
  unstable: { projectId: string; projectName: string; name: string; flips: number; runs: number }[];
}

export interface TrendWeek {
  /** Année et numéro de semaine ISO (2026-W43). */
  week: string;
  from: string;
  to: string;
  replays: Ratio;
  issues: Record<Severity, number>;
  /** Durée médiane d'un rejeu terminé avec un verdict ; absente sans rejeu. */
  medianReplayMs?: number;
  /** Couverture des exigences par un test à la fin de la semaine ; absente avant le premier élément publié. */
  coverage?: Ratio;
}

// ── Accès : rôles, droits, membres, journal ────────────────────────────────────────────────────

/** Les rôles, du plus restreint au plus large. */
export const ROLES = ['READER', 'ANALYST', 'PILOT', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const RIGHTS = [
  'VIEW',
  'RUN',
  'RUN_WRITES',
  'DECIDE',
  'PUBLISH',
  'MANAGE_ENVIRONMENTS',
  'MANAGE_PROJECTS',
  'MANAGE_ACCESS',
] as const;
export type Right = (typeof RIGHTS)[number];

/**
 * LES DROITS DE CHAQUE RÔLE. Le serveur les vérifie à chaque appel ; l'écran ne fait que masquer ce
 * qui serait refusé (un bouton masqué ne protège rien à lui seul).
 */
export const ROLE_RIGHTS: Record<Role, readonly Right[]> = {
  READER: ['VIEW'],
  ANALYST: ['VIEW', 'RUN', 'DECIDE'],
  PILOT: ['VIEW', 'RUN', 'RUN_WRITES', 'DECIDE', 'PUBLISH'],
  ADMIN: RIGHTS,
};

/** Qui appelle : le jeton du service (administrateur) ou le jeton nominatif d'un membre. */
export interface AccessMe {
  id: string;
  name: string;
  kind: 'SERVICE' | 'MEMBER';
  /** Le rôle dans l'espace ; `projectRole` le remplace dans le projet demandé. */
  role: Role;
  projectRole?: Role;
  /** Les droits effectifs (dans le projet demandé s'il y en a un). */
  rights: Right[];
  /** `single` : un seul jeton de service ; `named` : des jetons nominatifs. */
  mode: 'single' | 'named';
}

export interface MemberView {
  id: string;
  name: string;
  role: Role;
  /** Un rôle propre à un projet, qui remplace celui de l'espace. */
  projects: Record<string, Role>;
  createdAt: string;
  revokedAt?: string;
}

/** Un membre créé : son jeton n'est rendu qu'une fois, ici, et n'est jamais conservé en clair. */
export interface MemberCreated {
  member: MemberView;
  token: string;
}

export const JOURNAL_KINDS = ['RUN', 'REQUIREMENTS', 'CONFIGURATION', 'ACCESS', 'OTHER'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** UNE LIGNE DU JOURNAL : qui, quoi, où, avec quel résultat. Ni corps de requête, ni valeur, ni jeton. */
export interface JournalEntry {
  at: string;
  who: { id: string; name: string };
  role: Role;
  method: string;
  /** L'action, d'après la route (projects.executions, projects.requirements.imports.publish…). */
  action: string;
  kind: JournalKind;
  /** Le chemin appelé, sans la chaîne de requête. */
  path: string;
  projectId?: string;
  status: number;
  outcome: 'OK' | 'DENIED' | 'FAILED';
}
