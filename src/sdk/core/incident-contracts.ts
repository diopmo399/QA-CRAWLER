import type { AiInvestigationState, HypothesisOrigin, InvestigationMemory } from './incident-ai-contracts.js';
import type {
  ScopeResourceKind,
  ScopeResourceStatus,
  SilentFailureKind,
  TriggerInvestigationState,
} from './incident-trigger-contracts.js';

/**
 * INCIDENT RECONSTRUCTION — le contrat commun. Un incident fonctionnel déclaré (« après Enregistrer,
 * l'application affiche une erreur HTTP 500 ») est délimité (périmètre), reproduit avec le moteur
 * Playwright, observé (actions, requêtes, réponses, erreurs), relié au code (frontend, BFF Java,
 * backend Spring Boot), puis diagnostiqué à partir de preuves : hypothèses, vérifications, cause
 * racine confirmée ou diagnostic inconclusif, rapport et test de non-régression proposé.
 *
 * Toute relation porte son statut : OBSERVED (vue pendant l'exécution), STATICALLY_RESOLVED (lue dans
 * le code, sans ambiguïté), INFERRED (déduite, à vérifier), UNKNOWN. Un parcours lu dans le code n'est
 * jamais présenté comme une trace d'exécution.
 */

// ── Énumérations ─────────────────────────────────────────────────────────────────────────────

export const SCOPE_MODES = ['MANUAL', 'GUIDED', 'AUTO_WITHIN_SCOPE'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

/** Où QA-CRAWLER et Playwright s'exécutent pour l'investigation (LOCAL par défaut). */
export const EXECUTION_TARGETS = ['LOCAL', 'REMOTE', 'ARO'] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

export const INCIDENT_STATES = [
  'DRAFT',
  'SCOPED',
  'REPRODUCING',
  'REPRODUCED',
  'NOT_REPRODUCED',
  'INVESTIGATING',
  'DIAGNOSED',
  'INCONCLUSIVE',
  'CANCELLED',
  'FAILED',
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** La nature de l'incident, déclarée par la personne (sert au classement, jamais au diagnostic). */
export const INCIDENT_KINDS = ['FUNCTIONAL', 'TECHNICAL', 'PERFORMANCE', 'SECURITY', 'DATA'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** Les groupes de la liste des incidents (onglets « Tous », « Ouverts », « En investigation », …). */
export const INCIDENT_GROUPS = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;
export type IncidentGroup = (typeof INCIDENT_GROUPS)[number];

/** Le groupe d'un état : ouvert (rien n'a encore tourné), en investigation, résolu (diagnostic posé), fermé. */
export function incidentGroup(state: IncidentState): IncidentGroup {
  switch (state) {
    case 'DRAFT':
    case 'SCOPED':
      return 'OPEN';
    case 'REPRODUCING':
    case 'REPRODUCED':
    case 'NOT_REPRODUCED':
    case 'INVESTIGATING':
      return 'INVESTIGATING';
    case 'DIAGNOSED':
    case 'INCONCLUSIVE':
      return 'RESOLVED';
    case 'CANCELLED':
    case 'FAILED':
      return 'CLOSED';
  }
}

/** Les pièces jointes acceptées : captures et textes (journaux, exports), jamais d'exécutable. */
export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'application/json',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** Le nom d'une pièce jointe, après nettoyage (caractères). */
export const MAX_ATTACHMENT_NAME = 120;

/** L'envoi d'une pièce jointe : le contenu en base64 (le type déclaré est vérifié sur les octets). */
export interface IncidentAttachmentInput {
  name: string;
  type: AttachmentType;
  dataBase64: string;
}

/** Le contenu d'une pièce jointe : une image en URL `data:`, un texte masqué (valeurs sensibles). */
export type IncidentAttachmentContent =
  { id: string; type: AttachmentType; dataUrl: string } | { id: string; type: AttachmentType; text: string };

/** L'application touchée, telle que saisie (caractères). */
export const MAX_INCIDENT_APPLICATION = 120;

/** Une pièce jointe de l'incident (le contenu est lu à part, par sa route). */
export interface IncidentAttachment {
  id: string;
  /** Le nom donné par la personne, nettoyé (aucun chemin). */
  name: string;
  type: AttachmentType;
  bytes: number;
  addedAt: string;
  addedBy: string;
}

// ── Scénario d'accès et démonstration ─────────────────────────────────────────────────────────

/**
 * LE SCÉNARIO D'ACCÈS : comment la personne atteint la fonctionnalité où l'incident se produit (texte
 * libre, étapes, enregistrement du module Enregistrements). C'est un POINT
 * D'ENTRÉE de l'investigation, jamais une limite : l'analyse suit les dépendances au-delà, dans les
 * règles du périmètre (extensions approuvées). Aucun secret n'y est gardé : les textes sont masqués.
 */
export const MAX_ACCESS_TEXT = 4000;
export const MAX_ACCESS_FIELD = 600;
export const MAX_ACCESS_STEPS = 40;
export const MAX_ACCESS_STEP = 300;

/** Une étape du parcours, écrite par la personne (texte libre, sans syntaxe imposée). */
export interface AccessStep {
  id: string;
  text: string;
}

/** L'enregistrement du module Enregistrements associé au parcours (par son nom ; ses étapes sont relues à l'analyse). */
export interface AccessRecordingLink {
  name: string;
  linkedAt: string;
  linkedBy: string;
}

export const ACCESS_ACTION_KINDS = [
  'LOGIN',
  'NAVIGATE',
  'OPEN',
  'CREATE',
  'EDIT',
  'DELETE',
  'FILL',
  'SELECT',
  'CLICK',
  'SAVE',
  'SUBMIT',
  'SEARCH',
  'CLOSE',
  'WAIT',
  'OTHER',
] as const;
export type AccessActionKind = (typeof ACCESS_ACTION_KINDS)[number];
export const ACCESS_ELEMENT_KINDS = [
  'MENU',
  'BUTTON',
  'FIELD',
  'TAB',
  'PAGE',
  'LINK',
  'MODAL',
  'LIST',
] as const;
export type AccessElementKind = (typeof ACCESS_ELEMENT_KINDS)[number];

/** Une étape du parcours telle que l'analyse la comprend : action, cible, élément, provenance. */
export interface AccessPathStep {
  index: number;
  text: string;
  /** D'où vient l'étape : le texte libre, les étapes numérotées, ou un enregistrement réel. */
  source: 'TEXT' | 'STEPS' | 'RECORDING';
  action: AccessActionKind;
  target?: string;
  element?: AccessElementKind;
  /** L'étape après laquelle le symptôme apparaît (déduite du texte ; jamais une preuve). */
  critical: boolean;
}

/** Une interprétation incertaine gardée avec sa confiance (zone métier, entité, action critique). */
export interface AccessInterpretation {
  kind: 'AREA' | 'ENTITY' | 'ACTION' | 'TRIGGER';
  value: string;
  confidence: number;
  from: string;
}

/** Une portion de code candidate : trouvée par l'analyse statique et les mots du parcours, jamais confirmée ici. */
export interface AccessCandidate {
  id: string;
  kind: ScopeResourceKind;
  label: string;
  ref: string;
  applicationId?: string;
  /** 0 à 1 : la force du rapprochement avec le parcours. */
  confidence: number;
  /** MATCHED : un mot du parcours touche la ressource ; UNCERTAIN : reliée, ou rapprochement faible. */
  match: 'MATCHED' | 'UNCERTAIN';
  /** Le statut dans le périmètre : DENIED ou INACCESSIBLE demande une extension approuvée. */
  status: ScopeResourceStatus;
  reasons: string[];
  /** Ressource transversale (intercepteur, gestionnaire d'erreurs…) : au-delà de l'écran visible. */
  transversal?: boolean;
}

/** Une piste d'investigation (blocage global, erreur silencieuse…) : à vérifier, jamais une cause présumée. */
export interface AccessLead {
  kind:
    | 'ERROR_HANDLER'
    | 'INTERCEPTOR'
    | 'STREAM'
    | 'LIFECYCLE'
    | 'CHANGE_DETECTION'
    | 'HANDLER'
    | 'HTTP'
    | 'STATE';
  label: string;
  why: string;
  /** Les emplacements du code lu qui portent la piste (fichier:ligne) ; vide : rien trouvé dans le code lu. */
  refs: string[];
}

/** Le résultat de « Analyser le parcours ». */
export interface AccessAnalysis {
  analyzedAt: string;
  analyzedBy: string;
  sources: ('TEXT' | 'STEPS' | 'RECORDING')[];
  path: AccessPathStep[];
  interpretations: AccessInterpretation[];
  elements: { kind: AccessElementKind; label: string }[];
  /** Les comportements anormaux décrits (catégories de défaillance, jamais des preuves). */
  anomalies: SilentFailureKind[];
  conditions: string[];
  keywords: string[];
  candidates: AccessCandidate[];
  leads: AccessLead[];
  /** Ce que l'analyse n'a pas pu faire, dit simplement (enregistrement introuvable, lecture des sources refusée…). */
  limits: string[];
}

/**
 * LE MODE D'ACCÈS : AUTO (l'écran cible et le symptôme suffisent : le moteur cherche le parcours et les
 * conditions), GUIDED (les étapes connues mènent à l'écran, le moteur explore ensuite), DEMO (un
 * enregistrement du module Enregistrements montre le parcours). Aucun n'exige de vidéo.
 */
export const ACCESS_MODES = ['AUTO', 'GUIDED', 'DEMO'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** Un écran candidat pour la cible : route, composant, indices vérifiables, confiance. */
export interface TargetCandidate {
  route: string;
  applicationId: string;
  component?: string;
  componentId?: string;
  file?: string;
  line?: number;
  /** 0 à 1 : fondée sur les indices ; un nom seul ne dépasse jamais 0,45. */
  confidence: number;
  evidence: string[];
  /** Seuls des noms (route, composant) correspondent : jamais une identification certaine. */
  nameOnly: boolean;
  guards: string[];
}

/** Une étape du parcours d'accès : navigation vers une route, ou clic sur un lien relevé dans un template. */
export interface NavigationStep {
  kind: 'NAVIGATE' | 'CLICK';
  /** Le chemin (NAVIGATE) ou la cible « link:Libellé » (CLICK). */
  target: string;
  label: string;
  /** La route atteinte après l'étape. */
  route: string;
  /** D'où vient l'étape : graphe des liens, étape connue, enregistrement, URL directe. */
  source: 'LINKS' | 'GUIDED' | 'RECORDING' | 'DIRECT';
  evidence?: string;
}

/** « Localiser l'écran » : les candidats, l'écran retenu et le parcours d'accès trouvé dans le code. */
export interface TargetLocation {
  locatedAt: string;
  locatedBy: string;
  query: string;
  candidates: TargetCandidate[];
  /** La route retenue (le meilleur candidat, ou celle choisie par la personne). */
  chosen?: string;
  entry: string;
  path: NavigationStep[];
  guards: string[];
  limits: string[];
}

/** « Préparer l'exploration » : le parcours joué dans un vrai navigateur, l'écran atteint et son inventaire. */
export interface TargetPreparation {
  preparedAt: string;
  preparedBy: string;
  route: string;
  reached: boolean;
  finalUrl: string;
  title: string;
  steps: { summary: string; ok: boolean; error?: string }[];
  inventory: {
    buttons: string[];
    fields: string[];
    links: string[];
    selects: string[];
    disabled: string[];
    dialogs: number;
    overlays: number;
    messages: string[];
    loading: boolean;
  };
  /** Les requêtes vues pendant le parcours (méthode et chemin), les erreurs de page et de console. */
  requests: string[];
  errors: string[];
  /** Ce qui empêche d'explorer (page de connexion, garde, route paramétrée, navigation refusée). */
  blockers: string[];
  screenshot?: string;
  durationMs: number;
}

export interface IncidentAccess {
  /** Le point de départ (« page d'accueil après connexion »). */
  start?: string;
  /** L'URL ou la route initiale, si connue. */
  url?: string;
  narrative: string;
  steps: AccessStep[];
  expected?: string;
  observed?: string;
  conditions?: string;
  /** Les données de test nécessaires, décrites sans secret (masquées à l'enregistrement). */
  testData?: string;
  /** Le mode choisi (AUTO par défaut). */
  mode?: AccessMode;
  /** L'écran ou la fonctionnalité cible (« création d'un dossier »). */
  target?: string;
  /** Des indications de navigation, facultatives (« menu Dossiers, puis Nouveau »). */
  hints?: string;
  recording?: AccessRecordingLink;
  analysis?: AccessAnalysis;
  location?: TargetLocation;
  preparation?: TargetPreparation;
  /** Le dernier run du moteur lancé depuis l'écran cible (son suivi est celui des déclencheurs). */
  exploration?: { runId: string; startedAt: string; startedBy: string; route: string };
  updatedAt: string;
  updatedBy: string;
}

/** Ce que la personne envoie pour enregistrer le scénario. */
export interface IncidentAccessInput {
  start?: string;
  url?: string;
  narrative?: string;
  steps?: { id?: string; text: string }[];
  expected?: string;
  observed?: string;
  conditions?: string;
  testData?: string;
  mode?: AccessMode;
  target?: string;
  hints?: string;
  /** Le nom d'un enregistrement du projet ; null le dissocie ; absent : inchangé. */
  recording?: string | null;
}

/** Les sections du rapport, dans l'ordre ; un export peut n'en retenir qu'une partie. */
export const REPORT_SECTIONS = [
  'summary',
  'environment',
  'timeline',
  'requests',
  'graph',
  'code',
  'hypotheses',
  'experiments',
  'diagnosis',
  'regression',
  'ai',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const REPORT_FORMATS = ['json', 'markdown', 'html', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** La profondeur de l'arborescence de périmètre (route scope/tree) et son plafond de dossiers. */
export const SCOPE_TREE_MAX_DEPTH = 4;
export const SCOPE_TREE_DEFAULT_DEPTH = 3;
export const SCOPE_TREE_MAX_NODES = 400;

/** Les bornes de `limits.maxMemoryMb` (Mio). */
export const MIN_MEMORY_MB = 64;
export const MAX_MEMORY_MB = 16_384;

// ── Découverte automatique du périmètre ───────────────────────────────────────────────────────

/**
 * La découverte : les manifestes sont cherchés jusqu'à SCOPE_DISCOVERY_DEPTH niveaux (quatre), l'arborescence
 * des dossiers est lue plus profond (paquets Java) et bornée en nombre ; au plus SCOPE_DISCOVERY_MAX_MANIFESTS lus.
 */
export const SCOPE_DISCOVERY_DEPTH = 4;
export const SCOPE_DISCOVERY_TREE_DEPTH = 9;
export const SCOPE_DISCOVERY_MAX_NODES = 1500;
export const SCOPE_DISCOVERY_MAX_MANIFESTS = 80;

export const DISCOVERY_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type DiscoveryConfidence = (typeof DISCOVERY_CONFIDENCES)[number];

/** D'où vient une application du périmètre : détectée par la découverte automatique, ou saisie. */
export interface ScopeApplicationOrigin {
  kind: 'DISCOVERED' | 'MANUAL';
  at: string;
  /** La racine analysée (découverte) et ce qui a permis la détection. */
  analyzedRoot?: string;
  evidence?: string[];
}

/** Un module ou composant repéré dans une application (un dossier), et les mots de l'incident qu'il touche. */
export interface DiscoveredModule {
  /** Relatif à la racine de l'application. */
  path: string;
  name: string;
  matched?: string[];
}

export interface DiscoveredApplication {
  /** L'application prête pour le périmètre : identifiant unique, nom, couche déduite, racine absolue. */
  application: ScopeApplication;
  /** Relatif à la racine analysée (vide : la racine elle-même). */
  path: string;
  frameworks: string[];
  languages: string[];
  modules: DiscoveredModule[];
  entryPoints: string[];
  /** Les fichiers de configuration repérés (noms seulement, jamais leur contenu). */
  configs: string[];
  /** Les services et dépendances notables (HTTP, JPA, Kafka, clients REST…). */
  services: string[];
  confidence: DiscoveryConfidence;
  /** Ce qui a permis la détection : « fichier : indice ». */
  evidence: string[];
  /** Ce que la découverte n'a pas pu déterminer (à demander). */
  questions: string[];
  /** La pertinence pour l'incident (0 à 1), et pourquoi. */
  relevance: number;
  reasons: string[];
  /** Proposée dans le périmètre initial (cochée d'office). */
  suggested: boolean;
  /** L'identifiant de l'application du périmètre qui a déjà cette racine. */
  alreadyInScope?: string;
}

export interface DiscoveryRelation {
  /** Identifiants d'applications détectées. */
  from: string;
  to: string;
  kind: 'CALLS' | 'USES';
  status: 'STATICALLY_RESOLVED' | 'INFERRED';
  evidence: string;
}

export const DISCOVERY_PROBLEM_CODES = [
  'ROOT_RELATIVE',
  'ROOT_MISSING',
  'ROOT_NOT_DIRECTORY',
  'ROOT_DENIED',
  'READ_SOURCES_DENIED',
  'ENVIRONMENT_CANNOT_LIST',
  'NOTHING_RECOGNIZED',
  'PARTIAL',
] as const;
export type DiscoveryProblemCode = (typeof DISCOVERY_PROBLEM_CODES)[number];

/** Un problème de découverte : ce qui s'est passé, et comment le corriger. */
export interface DiscoveryProblem {
  code: DiscoveryProblemCode;
  message: string;
  hint: string;
}

/** Le résultat de l'analyse automatique d'un dépôt (lecture seule : rien n'est écrit dans l'incident). */
export interface ScopeDiscovery {
  root: string;
  status: 'OK' | 'PARTIAL' | 'FAILED';
  structure: 'SINGLE' | 'MONOREPO' | 'MULTI_APP' | 'UNKNOWN';
  /** Les outils de dépôt reconnus (Nx, pnpm workspaces, Maven multi-module…). */
  tools: string[];
  applications: DiscoveredApplication[];
  relations: DiscoveryRelation[];
  problems: DiscoveryProblem[];
  denied: { path: string; reason: string }[];
  truncated: string[];
  /** Les mots de l'incident retenus pour la pertinence. */
  keywords: string[];
  /** Les manifestes lus (relatifs à la racine), pour la traçabilité. */
  read: string[];
  discoveredAt: string;
  /** La durée réelle de l'analyse, mesurée par le serveur. */
  durationMs: number;
}

/** Un dépôt déjà connu de l'environnement d'investigation, proposé à la réutilisation. */
export interface KnownRepository {
  root: string;
  label: string;
  source: 'PROJECT' | 'SCOPE' | 'INCIDENT';
  incidentId?: string;
}

/** Un dossier du dépôt d'une application, pour choisir le périmètre (lecture seule, profondeur bornée). */
export interface ScopeTreeNode {
  /** Chemin relatif à la racine du dépôt, séparé par « / » (vide : la racine). */
  path: string;
  name: string;
  /** Inclus dans le périmètre (lui-même ou un dossier parent est dans `include`). */
  included: boolean;
  children: ScopeTreeNode[];
  /** Des sous-dossiers existent au-delà de la profondeur lue. */
  truncated?: boolean;
}

export interface ScopeTree {
  applicationId: string;
  root: ScopeTreeNode;
  /** La profondeur lue (1..SCOPE_TREE_MAX_DEPTH). */
  depth?: number;
  /** Le plafond de SCOPE_TREE_MAX_NODES dossiers a été atteint : l'arborescence est partielle. */
  capped?: boolean;
}

export const RELATION_STATUSES = ['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED', 'UNKNOWN'] as const;
export type RelationStatus = (typeof RELATION_STATUSES)[number];

export const HYPOTHESIS_STATUSES = [
  'PROPOSED',
  'INVESTIGATING',
  'SUPPORTED',
  'REFUTED',
  'INCONCLUSIVE',
  'CONFIRMED',
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export const LAYERS = [
  'FRONTEND',
  'BFF',
  'BACKEND',
  'DATABASE',
  'NETWORK',
  'TEST_DATA',
  'ENVIRONMENT',
  'UNKNOWN',
] as const;
export type Layer = (typeof LAYERS)[number];

/** Les couches dont le code peut être inspecté. */
export type CodeLayer = 'FRONTEND' | 'BFF' | 'BACKEND';

// ── Périmètre d'investigation ────────────────────────────────────────────────────────────────

/** Une application du périmètre et son dépôt (chemins absolus résolus sur la machine qui investigue). */
export interface ScopeApplication {
  id: string;
  name: string;
  layer: CodeLayer;
  repository: {
    /** Racine du dépôt (absolue). Aucun fichier hors de cette racine n'est lu. */
    root: string;
    /** Dossiers ou modules inspectés, relatifs à la racine ; vide : toute la racine. */
    include: string[];
    /** Classes Java ciblées (nom simple ou qualifié) ; vide : toutes celles des dossiers inclus. */
    classes?: string[];
  };
  /** L'URL de l'application (BFF, backend) quand elle est appelée directement par une vérification. */
  baseUrl?: string;
  /** Journaux locaux autorisés (chemins relatifs à la racine du dépôt ou absolus sous `logRoots`). */
  logFiles?: string[];
  /** Consultation OpenShift (REMOTE facultatif, ARO) : lecture seule, dans ce namespace. */
  openshift?: { namespace: string; selector: string };
  /** Absente : saisie à la main (fiches écrites avant la découverte automatique). */
  origin?: ScopeApplicationOrigin;
}

export interface ScopePermissions {
  readSources: boolean;
  navigate: boolean;
  /** NONE : aucune requête directe ; READ_ONLY : GET/HEAD seulement ; ALL : avec approbation. */
  httpRequests: 'NONE' | 'READ_ONLY' | 'ALL';
  runTests: 'NONE' | 'UNIT' | 'INTEGRATION';
  localCommands: boolean;
  readLogs: boolean;
  openshift: 'NONE' | 'READ';
  /** Effets de bord (écritures, tests qui modifient des données) : jamais sans approbation explicite. */
  sideEffects: boolean;
  /**
   * Lecture de l'historique Git des dépôts du périmètre (journal, différences), en lecture seule, par le binaire
   * `git` lancé sans interpréteur de commandes ; absent ou faux : refusé. Demande aussi `git` dans `allowedCommands`.
   */
  readGitHistory?: boolean;
}

export interface ResourceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxDurationMs: number;
  maxRequests: number;
  maxExperiments: number;
  /**
   * Mémoire maximale (Mio) du conteneur d'exécution : imposée au Job Kubernetes / OpenShift (ARO) ; en LOCAL
   * et REMOTE, rien ne la fait respecter (l'interface le dit).
   */
  maxMemoryMb?: number;
}

export const SCOPE_EXTENSION_KINDS = [
  'ADD_APPLICATION',
  'ADD_PATH',
  'ADD_CLASS',
  'ADD_ENDPOINT',
  'ADD_HOST',
  'RAISE_DEPTH',
  'ALLOW_SIDE_EFFECTS',
  'ALLOW_COMMAND',
] as const;
export type ScopeExtensionKind = (typeof SCOPE_EXTENSION_KINDS)[number];

/** Une extension du périmètre : demandée (par l'investigation ou une personne), jamais retenue sans approbation. */
export interface ScopeExtension {
  id: string;
  kind: ScopeExtensionKind;
  /** Application concernée, chemin, classe, endpoint (« POST /api/books »), hôte, profondeur, commande. */
  target: string;
  applicationId?: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedAt: string;
  requestedBy: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface InvestigationScope {
  /** GUIDED par défaut : chaque extension demandée attend une approbation. */
  mode: ScopeMode;
  applications: ScopeApplication[];
  /** Scénarios de la bibliothèque concernés (noms). */
  scenarios: string[];
  /** Étapes métier ciblées (index 1-based dans le scénario) ; vide : toutes. */
  steps: number[];
  /** Endpoints ciblés (« POST /api/books », « GET /api/books/{id} ») ; vide : ceux observés. */
  endpoints: string[];
  /** Profondeur d'analyse du code : nombre de sauts depuis l'endpoint observé (1 à 5). */
  depth: number;
  /** Hôtes que Playwright et les vérifications HTTP peuvent joindre (en plus de ceux des applications). */
  allowedHosts: string[];
  /** Racines de journaux autorisées (absolues). */
  logRoots: string[];
  /** Commandes locales autorisées par extension approuvée (nom de l'exécutable : « mvn », « npm »). */
  allowedCommands: string[];
  permissions: ScopePermissions;
  limits: ResourceLimits;
  extensions: ScopeExtension[];
}

// ── Scope Policy Engine ──────────────────────────────────────────────────────────────────────

export type PolicyOperation =
  | { kind: 'READ_FILE'; path: string; applicationId?: string }
  | { kind: 'LIST_DIR'; path: string; applicationId?: string }
  | { kind: 'READ_LOG'; path: string }
  | { kind: 'NAVIGATE'; url: string }
  | { kind: 'HTTP'; method: string; url: string }
  | { kind: 'RUN_TEST'; level: 'UNIT' | 'INTEGRATION'; command: string; args: string[]; cwd: string }
  | { kind: 'COMMAND'; command: string; args: string[]; cwd: string }
  | { kind: 'OPENSHIFT'; verb: string; resource: string; namespace: string };

export interface PolicyDecision {
  allowed: boolean;
  /** Pourquoi : la règle retenue, lisible. */
  reason: string;
  rule: string;
  operation: PolicyOperation;
  /** Le chemin réel (liens symboliques résolus) quand l'opération vise un fichier. */
  resolvedPath?: string;
  /** L'extension de périmètre qui la rendrait possible (mode GUIDED). */
  extension?: Pick<ScopeExtension, 'kind' | 'target' | 'applicationId'>;
}

// ── Environnement d'exécution (LOCAL / REMOTE / ARO) ─────────────────────────────────────────

export interface ExecutionEnvironmentConfig {
  target: ExecutionTarget;
  /** REMOTE : applications distantes ; les dépôts restent locaux et autorisés. */
  remote?: { openshift?: { apiServer?: string; namespace: string; context?: string } };
  /** ARO : QA-CRAWLER dans Azure Red Hat OpenShift (Playwright conteneurisé, ServiceAccount). */
  aro?: {
    namespace: string;
    serviceAccount: string;
    image: string;
    /** Les dépôts tels que montés dans le pod (volume, clone préalable). */
    repositoriesMount: string;
    apiServer?: string;
  };
}

export interface EnvironmentCapabilities {
  target: ExecutionTarget;
  playwright: 'LOCAL_PROCESS' | 'CONTAINER';
  repositories: 'LOCAL' | 'CLUSTER_VOLUME';
  tests: boolean;
  logs: 'FILES' | 'OPENSHIFT' | 'FILES_AND_OPENSHIFT' | 'NONE';
  kubernetesJobs: boolean;
  /**
   * `limits.maxMemoryMb` est imposée : vrai seulement en ARO dans un cluster (elle est écrite dans
   * `resources.limits.memory` du Job d'investigation). LOCAL et REMOTE : faux, rien ne la fait respecter.
   * Absent (serveur plus ancien) : à lire comme faux.
   */
  memoryLimit?: boolean;
  /** Ce qui manque pour que la capacité soit utilisable (outil absent, namespace non configuré…). */
  limitations: string[];
}

// ── Preuves ──────────────────────────────────────────────────────────────────────────────────

export const EVIDENCE_KINDS = [
  'ACTION',
  'PAGE',
  'REQUEST',
  'CONSOLE',
  'JS_ERROR',
  'SCREENSHOT',
  'TRACE',
  'ASSERTION',
  'LOG_LINE',
  'CODE',
  'EXPERIMENT',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Une preuve, toujours masquée (aucun secret, aucun jeton, aucune valeur de champ sensible). */
export interface Evidence {
  id: string;
  kind: EvidenceKind;
  at?: string;
  summary: string;
  source: {
    reproduction?: string;
    run?: string;
    step?: number;
    file?: string;
    line?: number;
    experiment?: string;
  };
  data?: Record<string, unknown>;
}

export interface HttpExchange {
  id: string;
  method: string;
  /** URL masquée (paramètres sensibles retirés). */
  url: string;
  path: string;
  status?: number;
  durationMs?: number;
  failure?: string;
  resourceType: string;
  startedAt?: string;
  /** L'action qui l'a déclenchée (index 1-based de l'étape) quand c'est déterminable. */
  step?: number;
  /** OBSERVED : vue pendant la fenêtre de l'action ; INFERRED : rattachée par l'horodatage ; UNKNOWN. */
  correlation: RelationStatus;
  requestBody?: string;
  /** Corps de réponse masqué et tronqué (erreurs, JSON/texte seulement). */
  responseBody?: string;
  /** En-têtes filtrés (liste blanche : type, longueur, identifiants de corrélation…) ; jamais d'authentification ni de cookie. */
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface ActionEvidence {
  index: number;
  kind: string;
  description: string;
  status: string;
  url?: string;
  startedAt?: string;
  durationMs: number;
  reason?: string;
  screenshot?: string;
  requestIds: string[];
}

export interface ReproductionRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  target: ExecutionTarget;
  environmentId?: string;
  baseUrl?: string;
  scenario: string;
  /** Le run du moteur (dossier run-… des rapports). */
  run?: string;
  /** null : le run n'a pas abouti ; true : le symptôme décrit a été observé. */
  reproduced: boolean | null;
  /** Ce qui a été comparé au symptôme pour décider `reproduced`. */
  symptomMatch?: string;
  actions: ActionEvidence[];
  requests: HttpExchange[];
  /** Erreurs console, erreurs JavaScript, échecs d'assertion, pages : sous forme de preuves. */
  evidence: Evidence[];
  screenshots: string[];
  trace?: string;
  error?: string;
  /**
   * La progression EN DIRECT d'une reproduction RUNNING, tirée des événements du moteur (début et fin de
   * chaque étape). Servie depuis la mémoire du serveur par `incidents.get` (jamais écrite dans le fichier :
   * la révision ne change pas pendant le rejeu) ; absente une fois le run terminé (les `actions` la remplacent)
   * ou si le serveur a redémarré pendant le rejeu.
   */
  live?: ReproductionLive;
}

/** Le statut d'une étape en direct : RUNNING tant que le moteur la joue, puis celui qu'il a rapporté. */
export const LIVE_STEP_STATUSES = ['RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'MANUAL'] as const;
export type LiveStepStatus = (typeof LIVE_STEP_STATUSES)[number];

export interface ReproductionLiveStep {
  /** Position dans le flow (1…). */
  index: number;
  /** Le genre d'étape du moteur (goto, click, fill, expect…). */
  kind: string;
  /** La description du moteur, sans valeur saisie. */
  description: string;
  status: LiveStepStatus;
  /** Quand le moteur a commencé l'étape (absent pour une étape SKIPPED jamais commencée). */
  startedAt?: string;
  /** La durée mesurée par le moteur, à la fin de l'étape seulement. */
  durationMs?: number;
  /** La raison d'un échec ou d'un blocage (jamais pour une saisie). */
  reason?: string;
  /** Une capture écrite par le moteur pour cette étape, relative au dossier du run (incidents.screenshot). */
  screenshot?: string;
}

export interface ReproductionLive {
  /** Le flow en cours de rejeu. */
  flow?: string;
  /** Le nombre d'étapes du flow, annoncé par le moteur au début du flow. */
  total?: number;
  /** Les étapes commencées ou terminées, dans l'ordre ; aucune étape à venir n'est inventée. */
  steps: ReproductionLiveStep[];
  /** L'étape que le moteur joue en ce moment (RUNNING), absente entre deux étapes. */
  current?: number;
  /** Le dernier événement reçu du moteur. */
  updatedAt: string;
  /** La dernière capture écrite pendant le rejeu (relative au dossier du run). */
  latestScreenshot?: string;
}

// ── Code ─────────────────────────────────────────────────────────────────────────────────────

export const CODE_SYMBOL_KINDS = [
  'COMPONENT',
  'EVENT_HANDLER',
  'FUNCTION',
  'HTTP_CLIENT_CALL',
  'VALIDATION',
  'PAYLOAD_TRANSFORM',
  'ERROR_HANDLER',
  'CONTROLLER',
  'ENDPOINT',
  'DTO',
  'SERVICE',
  'MAPPER',
  'HTTP_CLIENT',
  'BACKEND_CALL',
  'REPOSITORY',
  'TRANSACTION',
  'SQL_QUERY',
  'EXCEPTION',
  'EXCEPTION_HANDLER',
] as const;
export type CodeSymbolKind = (typeof CODE_SYMBOL_KINDS)[number];

export interface CodeSymbol {
  /** Stable : `${applicationId}:${file}#${name}` (méthode : `Classe.methode`). */
  id: string;
  applicationId: string;
  layer: CodeLayer;
  kind: CodeSymbolKind;
  name: string;
  /** Relatif à la racine du dépôt, séparateur « / ». */
  file: string;
  line: number;
  /** Le symbole qui le contient (méthode → classe). */
  parent?: string;
  detail?: Record<string, string | number | boolean | string[]>;
}

/** Un endpoint servi (BFF, backend) : méthode et chemin normalisé (« /api/books/{id} »). */
export interface CodeEndpoint {
  applicationId: string;
  layer: CodeLayer;
  method: string;
  path: string;
  /** La méthode du controller. */
  symbolId: string;
}

/** Un appel HTTP sortant lu dans le code (client frontend, client du BFF vers le backend). */
export interface OutgoingHttpCall {
  applicationId: string;
  layer: CodeLayer;
  symbolId: string;
  method?: string;
  /** Le chemin tel qu'écrit (littéral, gabarit « /catalog/books/${id} » normalisé en « /catalog/books/{id} »). */
  path?: string;
  /** STATICALLY_RESOLVED : méthode et chemin littéraux ; INFERRED : reconstruits ; UNKNOWN : dynamiques. */
  status: RelationStatus;
  file: string;
  line: number;
  /** L'origine (« https://hôte:port ») quand l'URL reconstruite en porte une ; jamais d'identifiants. */
  origin?: string;
  /** Le client HTTP qui fait l'appel (RestTemplate, WebClient, RestClient, Feign…). */
  client?: string;
  /** Les clés de configuration lues pour reconstruire l'URL (« partner.url »). */
  properties?: string[];
}

/** Un appel de méthode à méthode lu dans le code. */
export interface CodeCall {
  from: string;
  /** Le symbole appelé quand il est résolu ; absent si inconnu. */
  to?: string;
  /** Le texte de l'appel (« bookService.create(request) »). */
  text: string;
  status: RelationStatus;
  file: string;
  line: number;
}

export interface CodeIndex {
  applications: { id: string; layer: CodeLayer; files: number; skipped: number }[];
  symbols: CodeSymbol[];
  endpoints: CodeEndpoint[];
  outgoing: OutgoingHttpCall[];
  calls: CodeCall[];
  /** Chemins refusés par le Scope Policy Engine pendant l'analyse (avec la raison). */
  denied: { path: string; reason: string }[];
  /** Limites atteintes (fichiers, taille) : l'analyse est partielle et le dit. */
  truncated: string[];
}

// ── Graphe d'investigation ───────────────────────────────────────────────────────────────────

export const GRAPH_NODE_KINDS = [
  'INCIDENT',
  'SCENARIO',
  'ACTION',
  'REQUEST',
  'FRONTEND_CODE',
  'BFF_ENDPOINT',
  'BFF_SERVICE',
  'BACKEND_CALL',
  'BACKEND_ENDPOINT',
  'BACKEND_SERVICE',
  'REPOSITORY',
  'EXCEPTION',
] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  layer: Layer;
  /** Les preuves (ids d'Evidence, de HttpExchange) qui fondent ce nœud. */
  evidence: string[];
  symbolId?: string;
  file?: string;
  line?: number;
  /** La localisation dans le code (application, fichier, lignes) quand le nœud vient du code. */
  source?: SourceLocation;
}

export interface GraphEdge {
  from: string;
  to: string;
  status: RelationStatus;
  /** Pourquoi la relation existe (ou pourquoi elle est inconnue). */
  reason: string;
  evidence: string[];
}

export interface InvestigationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Hypothèses, vérifications, diagnostic ───────────────────────────────────────────────────

export const EXPERIMENT_KINDS = [
  'REPLAY',
  'COMPARE_REQUESTS',
  'COMPARE_RESPONSES',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'INSPECT_LOGS',
  'CHECK_VALIDATION',
  'COMPARE_WITH_PASSING',
] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

export interface ProposedVerification {
  kind: ExperimentKind;
  description: string;
  params: Record<string, string | number | boolean | string[]>;
}

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  suspectedCause: string;
  layer: Layer;
  files: string[];
  /** Preuves favorables : ids de preuves, d'échanges, de symboles, avec le fait qu'elles établissent. */
  supporting: { ref: string; fact: string }[];
  contradicting: { ref: string; fact: string }[];
  /** 0 à 1. Indicative pour une hypothèse d'origine IA, plafonnée tant qu'aucune vérification ne la soutient. */
  confidence: number;
  verifications: ProposedVerification[];
  status: HypothesisStatus;
  /** D'où vient l'hypothèse : une règle du moteur (défaut) ou un agent IA (toujours affichée comme telle). */
  origin?: HypothesisOrigin;
  /** Le run IA qui l'a proposée. */
  aiRunId?: string;
}

export const EXPERIMENT_STATUSES = [
  'PROPOSED',
  'REFUSED',
  'APPROVAL_REQUIRED',
  'RUNNING',
  'DONE',
  'ERROR',
  'CANCELLED',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export interface Experiment {
  id: string;
  kind: ExperimentKind;
  hypothesisId?: string;
  description: string;
  params: Record<string, string | number | boolean | string[]>;
  status: ExperimentStatus;
  /** Effets de bord possibles : approbation explicite et environnement adapté exigés. */
  sideEffects: boolean;
  approvedBy?: string;
  /** Les décisions du Scope Policy Engine pour ses opérations (refus compris). */
  decisions: PolicyDecision[];
  outcome?: 'SUPPORTS' | 'REFUTES' | 'NEUTRAL';
  summary?: string;
  evidence: Evidence[];
  startedAt?: string;
  finishedAt?: string;
}

export interface Diagnosis {
  status: 'CONFIRMED' | 'PROBABLE' | 'INCONCLUSIVE';
  rootCause?: { hypothesisId: string; statement: string; layer: Layer; files: string[] };
  alternatives: { hypothesisId: string; statement: string; confidence: number }[];
  /** Ce qui manque pour conclure (preuve, accès, vérification non autorisée). */
  missing: string[];
  recommendations: string[];
  generatedAt: string;
}

export interface RegressionTestProposal {
  /** Nom du scénario proposé (jamais ajouté à la bibliothèque sans validation). */
  name: string;
  basedOn: string;
  /** Le flow YAML du scénario, au format de la bibliothèque. */
  flowYaml: string;
  expected: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED';
  /** Ajouté à la bibliothèque (après validation) : le fichier. */
  file?: string;
  /** Exécuté : le run et son verdict réels ; absent tant qu'il n'a pas tourné. */
  execution?: { run: string; passed: boolean; at: string };
}

// ── Incident ─────────────────────────────────────────────────────────────────────────────────

export interface IncidentEvent {
  at: string;
  actor: string;
  kind:
    | 'CREATED'
    | 'UPDATED'
    | 'STATE'
    | 'SCOPE'
    | 'EXTENSION_REQUESTED'
    | 'EXTENSION_DECIDED'
    | 'REPRODUCTION'
    | 'CODE'
    | 'GRAPH'
    | 'HYPOTHESES'
    | 'EXPERIMENT'
    | 'DIAGNOSIS'
    | 'REPORT'
    | 'REGRESSION'
    | 'ATTACHMENT'
    | 'AI'
    | 'TRIGGER'
    | 'CANCELLED'
    | 'RESUMED';
  message: string;
}

export interface Investigation {
  reproductions: ReproductionRun[];
  code?: CodeIndex;
  graph?: InvestigationGraph;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  diagnosis?: Diagnosis;
  regression?: RegressionTestProposal;
  /** La traçabilité frontend de la reproduction de l'incident (étape → élément → composant → handler → service → requête). */
  frontendTrace?: FrontendTrace;
  /** La chronologie unifiée (actions, requêtes, réponses, console, erreurs, captures, journaux, vérifications). */
  timeline?: TimelineEvent[];
  /** L'investigation assistée par l'IA : runs et réponses de l'assistant (absent en mode DETERMINISTIC). */
  ai?: AiInvestigationState;
  /** La découverte automatique des conditions déclenchantes (description interprétée, runs). */
  trigger?: TriggerInvestigationState;
}

export interface IncidentInput {
  title: string;
  description: string;
  /** Ce qui est observé (« erreur HTTP 500 après Enregistrer »). */
  observed: string;
  /** Ce qui est attendu (« le livre est créé »). */
  expected: string;
  severity: IncidentSeverity;
  /** L'application touchée, telle que la personne la nomme (« Catalogue »). */
  application?: string;
  kind?: IncidentKind;
  /** Le scénario de la bibliothèque qui mène au symptôme. */
  scenario?: string;
  /** L'environnement cible du projet (SDK) ; à défaut, le premier. */
  environmentId?: string;
  execution?: ExecutionEnvironmentConfig;
  scope?: Partial<InvestigationScope>;
}

export interface Incident {
  id: string;
  projectId: string;
  title: string;
  description: string;
  observed: string;
  expected: string;
  severity: IncidentSeverity;
  application?: string;
  kind?: IncidentKind;
  scenario?: string;
  environmentId?: string;
  execution: ExecutionEnvironmentConfig;
  scope: InvestigationScope;
  attachments?: IncidentAttachment[];
  /** Le scénario d'accès et sa démonstration (point d'entrée de l'investigation). */
  access?: IncidentAccess;
  state: IncidentState;
  /** L'état avant une annulation : la reprise y revient quand c'est possible. */
  cancelledFrom?: IncidentState;
  /** Révision : une modification n'est acceptée que sur la version lue (sinon 409). */
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  history: IncidentEvent[];
  investigation: Investigation;
}

/** Résumé pour la liste. */
export interface IncidentSummary {
  id: string;
  title: string;
  severity: IncidentSeverity;
  state: IncidentState;
  application?: string;
  kind?: IncidentKind;
  scenario?: string;
  target: ExecutionTarget;
  createdAt: string;
  updatedAt: string;
  diagnosis?: Diagnosis['status'];
}

/** Le rapport d'investigation : exporté en JSON (structuré) et en Markdown, affiché dans le Dashboard. */
export interface InvestigationReport {
  version: 1;
  generatedAt: string;
  incident: Pick<
    Incident,
    'id' | 'projectId' | 'title' | 'description' | 'observed' | 'expected' | 'severity' | 'state'
  >;
  environment: { execution: ExecutionEnvironmentConfig; environmentId?: string; baseUrl?: string };
  scope: InvestigationScope;
  scenario?: string;
  /** Le scénario d'accès (texte, étapes, démonstration, enregistrement) et son analyse, quand il existe. */
  access?: IncidentAccess;
  /** La chronologie : actions, requêtes et erreurs de la dernière reproduction, dans l'ordre. */
  timeline: { at?: string; step?: number; kind: string; summary: string; ref: string }[];
  requests: HttpExchange[];
  /** Le code inspecté : fichiers et symboles retenus par le graphe. */
  code: { files: string[]; symbols: CodeSymbol[]; denied: CodeIndex['denied']; truncated: string[] };
  graph?: InvestigationGraph;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  diagnosis?: Diagnosis;
  regression?: RegressionTestProposal;
  /** L'investigation IA (runs, synthèses), quand elle a eu lieu : des propositions, jamais le diagnostic. */
  ai?: AiInvestigationState;
  /** La mémoire de l'investigation approfondie (stratégies, rôles des hypothèses, contradictions, couverture, limites). */
  aiMemory?: InvestigationMemory;
  /** Ce que le rapport ne peut pas affirmer (reproduction absente, analyse partielle…). */
  limitations: string[];
}

/**
 * Un rapport restreint à des sections (`?sections=`) : les clés des sections écartées sont ABSENTES
 * (jamais vides, pour ne pas dire « aucune requête » quand la section n'a simplement pas été demandée).
 * Toujours présents : l'en-tête de l'incident et les limites. `summary` porte description, observé,
 * attendu et scénario ; `environment` porte l'environnement et le périmètre.
 */
export type InvestigationReportPart = Pick<InvestigationReport, 'version' | 'generatedAt' | 'limitations'> & {
  incident: Pick<InvestigationReport['incident'], 'id' | 'projectId' | 'title' | 'severity' | 'state'> &
    Partial<Pick<InvestigationReport['incident'], 'description' | 'observed' | 'expected'>>;
  sections: ReportSection[];
} & Partial<
    Pick<
      InvestigationReport,
      | 'environment'
      | 'scope'
      | 'scenario'
      | 'timeline'
      | 'requests'
      | 'code'
      | 'graph'
      | 'hypotheses'
      | 'experiments'
      | 'diagnosis'
      | 'regression'
    >
  >;

/** Le test Playwright TypeScript généré depuis le flow du test de non-régression proposé (jamais exécuté ici). */
export interface RegressionSpec {
  language: 'typescript';
  fileName: string;
  code: string;
  /** Le flow d'origine (nom du test proposé). */
  flow: string;
  steps: number;
  assertions: number;
  /** L'URL de départ utilisée pour `page.goto`. */
  baseUrl: string;
}

// ── Investigation Workspace : contrats de l'interface ─────────────────────────────────────────

/** Les noms du domaine, tels que l'interface les emploie. */
export type ExecutionEnvironment = ExecutionEnvironmentConfig;
export type TraceNode = GraphNode;
export type TraceEdge = GraphEdge;
export type RootCause = NonNullable<Diagnosis['rootCause']>;
export type RegressionTest = RegressionTestProposal;

/** Un endroit du code : toujours relatif à la racine du dépôt de l'application, dans le périmètre. */
export interface SourceLocation {
  applicationId: string;
  layer: CodeLayer;
  /** Relatif à la racine du dépôt, séparateur « / ». */
  file: string;
  line: number;
  endLine?: number;
  symbolId?: string;
}

export const TIMELINE_KINDS = [
  'ACTION',
  'PAGE',
  'REQUEST',
  'RESPONSE',
  'CONSOLE',
  'JS_ERROR',
  'SCREENSHOT',
  'TRACE',
  'ASSERTION',
  'LOG',
  'EXPERIMENT',
  'STATE',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TIMELINE_STATUSES = ['OK', 'INFO', 'WARNING', 'ERROR'] as const;
export type TimelineStatus = (typeof TIMELINE_STATUSES)[number];

/**
 * UN ÉVÉNEMENT DE LA CHRONOLOGIE. `id` est stable (dérivé de la reproduction et de la preuve) ; `order`
 * classe les événements quand l'heure manque ou est estimée (`estimated`).
 */
export interface TimelineEvent {
  id: string;
  order: number;
  at?: string;
  /** L'heure est reconstruite (début du flow + durées des étapes précédentes), pas mesurée. */
  estimated?: boolean;
  reproduction?: string;
  /** L'étape Playwright (index 1-based). */
  step?: number;
  layer: Layer;
  kind: TimelineKind;
  status: TimelineStatus;
  summary: string;
  /** Les preuves qui fondent l'événement (ids d'Evidence, de HttpExchange). */
  evidence: string[];
  /** L'échange HTTP concerné (REQUEST, RESPONSE). */
  requestId?: string;
  source?: SourceLocation;
}

/** Un maillon de la traçabilité frontend : ce qu'il désigne, d'où il vient, avec quel degré de certitude. */
export interface TraceLink {
  label: string;
  status: RelationStatus;
  /** Pourquoi ce maillon (ou pourquoi il est inconnu). */
  reason: string;
  evidence: string[];
  symbolId?: string;
  source?: SourceLocation;
}

/**
 * UNE ÉTAPE DE LA TRAÇABILITÉ FRONTEND : étape Playwright → action → élément DOM → composant → handler →
 * services TypeScript → clients HTTP → requêtes → réponses → erreur affichée. Ce qui ne s'observe pas sans
 * instrumentation (composant, handler, service) est `INFERRED` ou `UNKNOWN`, jamais `OBSERVED`.
 */
export interface FrontendTraceStep {
  index: number;
  action: {
    kind: string;
    description: string;
    status: string;
    url?: string;
    screenshot?: string;
    evidence: string[];
  };
  element?: TraceLink;
  component?: TraceLink;
  handler?: TraceLink;
  services: TraceLink[];
  httpClients: TraceLink[];
  requests: {
    requestId: string;
    method: string;
    path: string;
    status?: number;
    correlation: RelationStatus;
  }[];
  /** Le message affiché après l'échec (assertion, texte de la page) quand il est observé. */
  displayedError?: TraceLink;
  /** Preuves console et erreurs JavaScript de l'étape. */
  console: string[];
  jsErrors: string[];
}

export interface FrontendTrace {
  reproduction: string;
  steps: FrontendTraceStep[];
  /** Ce que la traçabilité ne peut pas établir (code frontend hors périmètre, étape sans requête…). */
  limitations: string[];
}

/** Un fichier du périmètre, lu en lecture seule pour l'explorateur de code. */
export interface SourceFileView {
  applicationId: string;
  layer: CodeLayer;
  file: string;
  language: 'typescript' | 'java' | 'yaml' | 'xml' | 'text';
  text: string;
  /** Les symboles de l'index de code déclarés dans ce fichier. */
  symbols: CodeSymbol[];
  /** Les lignes à mettre en évidence, et pourquoi (graphe, hypothèses, exceptions, sélection). */
  highlights: {
    line: number;
    endLine?: number;
    kind: 'ERROR' | 'PATH' | 'HYPOTHESIS' | 'SYMBOL';
    reason: string;
    refs: string[];
  }[];
}

/** L'arborescence lisible du périmètre, par application. */
export interface SourceTree {
  applications: {
    applicationId: string;
    name: string;
    layer: CodeLayer;
    files: string[];
    truncated: boolean;
  }[];
  denied: { path: string; reason: string }[];
}

/**
 * LA reproduction de l'incident : le dernier run terminé de SON scénario. Les rejeux d'une vérification
 * (le scénario qui réussit, par exemple) sont gardés à côté, mais ne la remplacent jamais. La même règle
 * pour le serveur (rapport, graphe, hypothèses) et pour l'interface.
 */
export function incidentReproduction(
  incident: Pick<Incident, 'scenario' | 'investigation'>,
): ReproductionRun | undefined {
  const runs = incident.investigation.reproductions.filter((run) => run.status === 'COMPLETED');
  return (
    [...runs].reverse().find((run) => run.scenario === incident.scenario) ??
    (incident.scenario ? undefined : runs.at(-1))
  );
}

export * from './incident-ai-contracts.js';
export * from './incident-trigger-contracts.js';
