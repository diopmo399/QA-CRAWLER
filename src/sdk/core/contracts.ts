/**
 * LES CONTRATS DU SDK : ce que l'hôte, le client navigateur et le serveur QA-CRAWLER échangent.
 * Ce fichier ne dépend de rien (ni Node, ni DOM) : il est lu par le navigateur comme par le serveur.
 *
 * Un brouillon de projet (ProjectDraft) ne porte jamais de secret : seulement des NOMS de variables
 * d'environnement, que le serveur lit lui-même. Les compteurs d'une exploration viennent des
 * événements du moteur ; aucun pourcentage global, aucune durée restante ne sont calculés.
 */

export const SDK_API_VERSION = 1;

export const FRAMEWORKS = ['angular', 'react', 'vue', 'other'] as const;
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
  /** Les capacités prévues mais pas encore exposées par le SDK. */
  extensions: Record<ExtensionName, false>;
}

export const EXTENSION_NAMES = [
  'recordings',
  'groups',
  'graph',
  'assertions',
  'generation',
  'reports',
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
