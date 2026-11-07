/**
 * LA CARTOGRAPHIE FONCTIONNELLE D'UN PROJET : ce que le code des couches (frontal, BFF, backend, contrats
 * d'API, persistance) montre des fonctionnalités, de leurs champs et des scénarios qui les vérifient.
 *
 * Tout y est FONDÉ SUR DES PREUVES : chaque nœud et chaque lien porte ses preuves (source, fichier, symbole,
 * ligne, révision Git, type de preuve) et un niveau de confiance. Un lien que le code ne démontre pas reste
 * PROBABLE ou INCONNU, jamais confirmé ; une technologie sans analyseur est dite « connecteur manquant », sans
 * résultat inventé. Aucune valeur de donnée n'est gardée : seulement des métadonnées.
 */

/** Les couches cartographiées. */
export const MAP_LAYERS = ['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE', 'EVENTS', 'OTHER'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/**
 * Les technologies détectables. `supported` : un analyseur existe et est testé ; les autres sont détectées
 * puis signalées « connecteur manquant ».
 */
export const MAP_TECHNOLOGIES = [
  'ANGULAR',
  'REACT',
  'VUE',
  'SPRING',
  'JPA',
  'OPENAPI',
  'NODE',
  'DOTNET',
  'GRAPHQL',
  'SQL',
  'EVENTS',
] as const;
export type MapTechnology = (typeof MAP_TECHNOLOGIES)[number];
export const SUPPORTED_TECHNOLOGIES: readonly MapTechnology[] = ['ANGULAR', 'SPRING', 'JPA', 'OPENAPI'];

/** Une source à analyser : un dossier (un dépôt Git local ou une partie) lu sous une racine autorisée. */
/** Les hébergeurs Git dont QA-CRAWLER sait construire un lien vers un fichier à une révision. */
export const GIT_PROVIDERS = ['GITHUB', 'GITLAB', 'BITBUCKET', 'AZURE_DEVOPS'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export interface MapSource {
  id: string;
  name: string;
  layer: MapLayer;
  /**
   * LOCAL (par défaut, et pour toute source enregistrée avant cette option) : un dossier du serveur.
   * GIT : un dépôt distant que le serveur prépare (clone ou mise à jour) dans son propre dossier de travail.
   */
  kind?: 'LOCAL' | 'GIT';
  /** LOCAL : chemin absolu, sous l'une des racines autorisées par le serveur (`allowedSourceRoots`). GIT : vide. */
  path: string;
  /** Sous-dossiers analysés (relatifs à la racine) ; vide : tout le dossier. */
  include: string[];
  enabled: boolean;
  /** GIT : le dépôt à préparer. LOCAL : facultatif, sert seulement à construire les liens « Voir sur Git ». */
  repoUrl?: string;
  /** L'hébergeur, quand il ne se déduit pas de l'hôte (instance auto-hébergée). */
  provider?: GitProvider;
  /** GIT : la branche suivie (sinon la branche par défaut du dépôt). */
  branch?: string;
  /** GIT : un commit précis (40 caractères hexadécimaux) ; prioritaire sur la branche. */
  commit?: string;
  /** GIT : le NOM de la variable d'environnement du serveur qui porte le jeton (jamais sa valeur). */
  tokenEnv?: string;
}

/**
 * Une racine de métadonnées de dépendances, strictement locale (sous une racine autorisée du serveur) :
 * rangée comme un dépôt Maven (pom, jars de contrats). Jamais de téléchargement.
 */
export interface MetadataRoot {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
}

export interface CartographyConfig {
  schema: 1;
  sources: MapSource[];
  metadata?: MetadataRoot[];
  updatedAt?: string;
}

export type MapConfidence = 'CONFIRMED' | 'PROBABLE' | 'UNKNOWN';

/** D'où vient une preuve. */
export type EvidenceKind = 'STATIC_CODE' | 'TEMPLATE' | 'OPENAPI' | 'SCENARIO_STEP' | 'EXECUTION' | 'MANUAL';

export interface Evidence {
  kind: EvidenceKind;
  sourceId?: string;
  /** Relatif à la racine de la source, séparateur « / ». */
  file?: string;
  line?: number;
  symbol?: string;
  /** La révision Git de la source au moment du scan (commit), si elle est lisible. */
  revision?: string;
  confidence: MapConfidence;
  /** En mots : ce que la preuve établit. */
  detail?: string;
}

export const MAP_NODE_KINDS = [
  'FEATURE',
  'SCREEN',
  'ROUTE',
  'COMPONENT',
  'FIELD',
  'API',
  'DTO',
  'METHOD',
  'SERVICE',
  'EVENT',
  'ENTITY',
  'COLUMN',
  'SCENARIO',
  'EXECUTION',
  /** Un conteneur d'un gabarit (section, bloc conditionnel), un bouton, une condition d'affichage ou d'activation. */
  'CONTAINER',
  'BUTTON',
  'CONDITION',
  /** Un flux RxJS du frontal : Subject/BehaviorSubject d'un store, ou Observable calculé (pipe, combineLatest). */
  'STREAM',
] as const;
export type MapNodeKind = (typeof MAP_NODE_KINDS)[number];

export interface MapNode {
  /** Stable d'un scan à l'autre : sorte, source et symbole. */
  id: string;
  kind: MapNodeKind;
  layer: MapLayer;
  name: string;
  label?: string;
  /** Le conteneur (composant, DTO, entité, opération) d'un champ ou d'une méthode. */
  parent?: string;
  /** Métadonnées (type, obligatoire, validations, méthode HTTP, chemin, table…) — jamais une valeur. */
  detail: Record<string, string | number | boolean | string[]>;
  /** L'empreinte de ce qui compte pour l'impact (type, validations, chemin, propriétés). */
  signature: string;
  evidence: Evidence[];
}

/** Les liens du graphe : affiche, saisit, appelle, transmet, transforme, lit, écrit, réutilise, vérifie, couvre, dépend de. */
export const MAP_EDGE_KINDS = [
  'DISPLAYS',
  'INPUTS',
  'CALLS',
  'SENDS',
  'TRANSFORMS',
  'READS',
  'WRITES',
  'REUSES',
  'VERIFIES',
  'COVERS',
  'DEPENDS_ON',
  /** Structure et comportement : contient, visible si, activé si, piloté par (valeur calculée), déclenche. */
  'CONTAINS',
  'VISIBLE_WHEN',
  'ENABLED_WHEN',
  'CONTROLLED_BY',
  'TRIGGERS',
] as const;
export type MapEdgeKind = (typeof MAP_EDGE_KINDS)[number];

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  kind: MapEdgeKind;
  confidence: MapConfidence;
  /** Pourquoi ce lien (mécanisme, correspondance) ; un lien PROBABLE dit ce qui manque. */
  reason: string;
  evidence: Evidence[];
  /**
   * Le contexte d'exécution démontré par le code (absent des scans d'avant) : conditions qui entourent l'appel,
   * ce qui doit s'être produit avant (réponse attendue, erreur, opérateur), provenance des données transmises,
   * contexte d'appel retenu pour une méthode générique. Une relation conditionnelle ou asynchrone n'est
   * jamais présentée comme exécutée à coup sûr.
   */
  detail?: {
    condition?: string;
    async?: string;
    data?: string;
    context?: string;
    /** DIRECT, AFTER_RESULT, ON_ERROR, ON_COMPLETE, ON_EVENT, DEFERRED, UNDEMONSTRATED. */
    timing?: string;
    concurrent?: boolean;
    cancellable?: boolean;
    /** Accès aux données : SELECT, INSERT, UPDATE, DELETE, ou UNKNOWN (requête illisible). */
    operation?: string;
    /** La requête lue (JPQL, SQL), tronquée. */
    statement?: string;
  };
}

/** Ce qu'une technologie a donné pour une source. */
export interface TechnologyStatus {
  technology: MapTechnology;
  /** Détectée par des signaux déterministes (manifeste, imports, annotations, fichiers). */
  detected: boolean;
  supported: boolean;
  analyzed: boolean;
  /** « connecteur manquant », limite atteinte… */
  note?: string;
}

/**
 * Une dépendance Maven d'une source, telle que résolue pour cette source seule (BFF et Backend résolus à part) :
 * trouvée (dépôt local, cache, dépôt distant autorisé), ou pourquoi elle ne l'est pas. Une dépendance déclarée
 * n'est jamais tenue pour disponible sans avoir été lue.
 */
export interface MavenArtifactStatus {
  /** `groupe:artefact:version` (et `:classifieur` s'il y en a un). */
  coordinates: string;
  scope?: string;
  /** 1 : déclarée par la source ; 2 et plus : apportée par une autre dépendance. */
  depth: number;
  requestedBy?: string;
  state:
    | 'RESOLVED'
    | 'NOT_FOUND'
    | 'OFFLINE'
    | 'DENIED'
    | 'INTEGRITY'
    | 'TOO_LARGE'
    | 'BUDGET'
    | 'NO_VERSION'
    | 'LIBRARY'
    | 'ERROR';
  origin?: 'LOCAL' | 'CACHE' | 'REMOTE';
  /** L'identifiant du dépôt d'où il vient (jamais d'adresse ni d'identifiant de connexion). */
  repository?: string;
  /** L'empreinte SHA-1 du fichier lu (pom ou jar). */
  sha1?: string;
  /** Ce qui a été lu : pom, jar de sources, classes compilées. */
  read?: ('POM' | 'SOURCES_JAR' | 'CLASS')[];
  /** Les types de contrat lus dans cet artefact. */
  types?: string[];
  /** D'autres versions demandées ailleurs dans l'arbre (la plus proche l'emporte, comme Maven). */
  conflicts?: string[];
  note?: string;
}

export interface SourceScan {
  sourceId: string;
  name: string;
  layer: MapLayer;
  state: 'SCANNED' | 'PARTIAL' | 'FAILED' | 'DENIED' | 'DISABLED' | 'REUSED';
  technologies: TechnologyStatus[];
  /** Les dépendances Maven résolues pour retrouver les contrats absents des sources (si la résolution est active). */
  dependencies?: MavenArtifactStatus[];
  /** Les types de contrat cherchés dans les dépendances et introuvables. */
  unresolvedTypes?: string[];
  files: number;
  /** Fichiers laissés de côté (limites, taille, secrets), comptés. */
  skipped: number;
  secretsExcluded: number;
  /** Le commit réellement analysé (vérifié après extraction pour une source GIT). */
  revision?: string;
  /** RESOLVED : révision lue ; UNDETERMINED : dépôt Git mais révision illisible (la cause est dans `errors`) ; NONE : pas un dépôt Git. */
  revisionStatus?: 'RESOLVED' | 'UNDETERMINED' | 'NONE';
  /** Le type de la source au moment du scan, et pour une source GIT ce qui a été demandé. */
  kind?: 'LOCAL' | 'GIT';
  repoUrl?: string;
  provider?: GitProvider;
  branch?: string;
  requestedCommit?: string;
  /** Le dossier de la source dans son dépôt (« front » dans un monodépôt), « / » comme séparateur ; vide : la racine. */
  repoPath?: string;
  /** Empreinte des fichiers lus : inchangée → le scan incrémental reprend le résultat précédent. */
  hash?: string;
  errors: string[];
}

export type ScanState = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

export interface ScanRecord {
  id: string;
  schema: 1;
  startedAt: string;
  finishedAt?: string;
  state: ScanState;
  incremental: boolean;
  sources: SourceScan[];
  counts: Partial<Record<MapNodeKind, number>>;
  /**
   * Les relations lues dans le code mais non raccordées au graphe, par type (absent : aucune) : leur
   * extrémité n'y est pas représentée. Elles ne sont jamais perdues sans être comptées.
   */
  unattached?: Partial<Record<MapEdgeKind, number>>;
  edges: number;
  errors: string[];
  /** Les racines de métadonnées lues (locales, autorisées) : état, fichiers lus, éléments ignorés. */
  metadata?: {
    id: string;
    name: string;
    state: 'READ' | 'DENIED' | 'FAILED' | 'DISABLED';
    files: number;
    notes: string[];
  }[];
}

/** Un maillon de la chaîne d'une fonctionnalité, couche par couche. */
export interface ChainStep {
  layer: MapLayer;
  node: string;
  label: string;
  confidence: MapConfidence;
  /** Une étape manquante : « lien non démontré » et pourquoi. */
  gap?: string;
}

export type FeatureStatus = 'CANDIDATE' | 'CONFIRMED' | 'REJECTED';

export interface Feature {
  id: string;
  name: string;
  /** Le nom proposé par le regroupement (avant un renommage). */
  proposedName: string;
  module?: string;
  status: FeatureStatus;
  layers: MapLayer[];
  /** Les nœuds techniques regroupés (écrans, composants, API, méthodes, entités…). */
  nodes: string[];
  fields: string[];
  chain: ChainStep[];
  /** Les ruptures de chaîne relevées dans les écrans de la fonctionnalité (étape exacte, cause). */
  diagnostics?: string[];
  /** Comment la fonctionnalité a été proposée (un écran et ses appels, une opération d'API seule…). */
  basis: string;
  mergedFrom?: string[];
  evidence: Evidence[];
  /** La confiance avec laquelle chaque nœud est atteint depuis le point de départ (le plus faible lien). */
  reach: Record<string, MapConfidence>;
}

/** Un concept métier : des champs techniques reliés par des liens démontrés (jamais par le seul nom). */
export interface FieldConcept {
  id: string;
  name: string;
  fields: string[];
  features: string[];
  layers: MapLayer[];
  /** CONFIRMED si toute la chaîne est démontrée ; VALIDATED après une validation manuelle. */
  status: MapConfidence | 'VALIDATED';
  /** Les étapes non démontrées (« lien non démontré : … »). */
  gaps: string[];
  /** Des champs de même nom ailleurs, non reliés (homonymes), signalés et non fusionnés. */
  homonyms: string[];
}

export const FIELD_ISSUE_KINDS = [
  'UNUSED',
  'DUPLICATE',
  'TYPE_MISMATCH',
  'VALIDATION_DIVERGENCE',
  'UNTESTED',
] as const;
export type FieldIssueKind = (typeof FIELD_ISSUE_KINDS)[number];

export interface FieldIssue {
  kind: FieldIssueKind;
  fields: string[];
  concept?: string;
  message: string;
}

// ── Corrélation entre couches (appel → contrat → endpoint → appel sortant) ───────────────────────

/**
 * L'état d'une correspondance : CONFIRMED (chaîne de preuves suffisante), PROBABLE (indices cohérents, une
 * étape essentielle reste ambiguë ou déduite), UNDEMONSTRATED (aucune correspondance justifiée), BLOCKED
 * (une source ou une information indispensable manque).
 */
export type CorrelationStatus = 'CONFIRMED' | 'PROBABLE' | 'UNDEMONSTRATED' | 'BLOCKED';

/** Les causes précises d'une correspondance incomplète. */
export const CORRELATION_CAUSES = [
  'CONTRACT_NOT_FOUND',
  'REF_UNRESOLVED',
  'MAVEN_MODULE_MISSING',
  'MAVEN_DEPENDENCY_AMBIGUOUS',
  'CONTRACT_VERSION_UNKNOWN',
  'GENERATED_INTERFACE_ABSENT',
  'PREFIX_UNKNOWN',
  'DYNAMIC_URL',
  'METHOD_MISMATCH',
  'AMBIGUOUS',
  'CONTRACT_NOT_IMPLEMENTED',
  'BACKEND_CALL_UNRESOLVED',
  'NO_ENDPOINT',
  'LAYER_MISSING',
  /** Configuration : options de génération insuffisantes, profil actif inconnu, propriété non résolue… */
  'GENERATION_OPTIONS_INSUFFICIENT',
  'PROFILE_UNKNOWN',
  'PROPERTY_UNRESOLVED',
  'DEPENDENCY_UNAVAILABLE',
  'PROXY_DYNAMIC',
  'GATEWAY_EXTERNAL',
  'DESTINATION_SYMBOLIC',
  'MULTIPLE_DESTINATIONS',
  'ENVIRONMENT_INCONSISTENT',
  /** Une source examinée a été lue en partie (limite de fichiers ou de durée) : l'absence n'est pas prouvée. */
  'SOURCE_PARTIAL',
] as const;
export type CorrelationCause = (typeof CORRELATION_CAUSES)[number];

export interface CorrelationCandidate {
  node: string;
  layer: MapLayer;
  method: string;
  /** Le chemin exposé comparé (préfixes compris). */
  path: string;
  /** Pourquoi il est candidat (indices), et pourquoi il est écarté, s'il l'est. */
  reasons: string[];
  rejected?: string;
}

/** Une étape de la chaîne reconstruite, avec sa preuve (fichier, ligne). */
export interface CorrelationStep {
  kind:
    | 'CALL'
    | 'BASE'
    | 'CONTRACT'
    | 'MODULE'
    | 'GENERATION'
    | 'INTERFACE'
    | 'IMPLEMENTATION'
    | 'ENDPOINT'
    | 'OUTGOING'
    /** Règle du proxy de développement, route d'une passerelle, destination résolue (source atteinte). */
    | 'PROXY'
    | 'GATEWAY'
    | 'DESTINATION';
  label: string;
  node?: string;
  evidence?: Evidence;
}

export interface MapCorrelation {
  /** Le nœud de l'appel (frontal) ou de la méthode qui appelle (BFF). */
  from: string;
  method: string;
  path: string;
  status: CorrelationStatus;
  /** La cible retenue (endpoint servi ou déduit, ou opération du contrat). */
  target?: string;
  /** L'opération du contrat qui décrit la cible, quand elle est établie. */
  contract?: string;
  candidates: CorrelationCandidate[];
  causes: { code: CorrelationCause; message: string }[];
  steps: CorrelationStep[];
  /**
   * Où et pourquoi la traçabilité s'interrompt (lien non confirmé) : point de départ, dernier élément
   * démontré, relation recherchée, sources examinées et manquantes, limites atteintes, pistes de résolution.
   */
  diagnostic?: {
    start: string;
    lastDemonstrated: string;
    sought: string;
    examined: string[];
    missing: string[];
    limits: string[];
    suggestions: string[];
  };
  /**
   * Les variantes (profil Spring, configuration du frontal) dont l'issue diffère du défaut : une liaison
   * peut être confirmée dans l'une et indéterminée dans l'autre ; elles ne sont jamais fusionnées.
   */
  variants?: {
    variant: string;
    path: string;
    /** La chaîne propre à la variante (proxy, passerelle, destination), en clair. */
    chain?: string;
    status: CorrelationStatus;
    target?: string;
    exposed?: string;
    causes: { code: CorrelationCause; message: string }[];
  }[];
}

/**
 * Un contrat d'API lu dans une source. `role` : GENERATOR_INPUT (un plugin de génération le lit :
 * contract-first), PRODUCED_FROM_CODE (le module le produit depuis ses contrôleurs : code-first),
 * UNDETERMINED (aucune preuve de l'un ou de l'autre).
 */
export interface MapContract {
  id: string;
  source: string;
  file: string;
  title?: string;
  version?: string;
  role: 'GENERATOR_INPUT' | 'PRODUCED_FROM_CODE' | 'UNDETERMINED';
  /** Les générations qui le lisent : module, exécution, générateur, serveur ou client. */
  consumers: {
    module: string;
    execution?: string;
    generator?: string;
    side: 'SERVER' | 'CLIENT';
    version?: string;
  }[];
  operations: number;
  unresolved: { ref: string; cause: string }[];
}

/** La comparaison de deux versions d'un même contrat (même titre), opération par opération. */
export interface MapContractDiff {
  title: string;
  from: { contract: string; version?: string };
  to: { contract: string; version?: string };
  identical: boolean;
  removed: string[];
  added: string[];
  changed: { operation: string; what: string }[];
}

export interface MapModule {
  source: string;
  file: string;
  id: string;
  packaging?: string;
  parent?: string;
  dependencies: string[];
  /** Les dépendances indirectes connues par les pom lus (sources, métadonnées locales). */
  indirect?: string[];
  generations: {
    execution?: string;
    plugin: string;
    generator?: string;
    spec?: string;
    apiPackage?: string;
  }[];
  unresolved: string[];
}

/** La cartographie d'un scan : graphe, fonctionnalités, champs et concepts. */
export interface CartographyModel {
  schema: 1;
  scan: ScanRecord;
  nodes: MapNode[];
  edges: MapEdge[];
  features: Feature[];
  concepts: FieldConcept[];
  issues: FieldIssue[];
  /** Le catalogue des API et services (absent d'un scan antérieur à sa découverte : relancer un scan). */
  apis?: ApiService[];
  /** Les correspondances entre couches et leurs causes (absent d'un scan antérieur : relancer un scan). */
  correlations?: MapCorrelation[];
  contracts?: MapContract[];
  contractDiffs?: MapContractDiff[];
  modules?: MapModule[];
  /** Le graphe de configuration : propriétés, profils, modules, générations, proxys, passerelles. */
  configGraph?: MapConfigGraph;
}

/** Les relations du graphe de configuration. */
export const CONFIG_RELATIONS = [
  'DECLARES',
  'REFERENCES',
  'OVERRIDES',
  'ACTIVATES',
  'GENERATES',
  'IMPLEMENTS',
  'CONFIGURES',
  'ROUTES_TO',
  'REWRITES_TO',
  'DEPENDS_ON',
] as const;
export type ConfigRelation = (typeof CONFIG_RELATIONS)[number];

export interface ConfigNode {
  id: string;
  kind:
    | 'SOURCE'
    | 'FILE'
    | 'PROPERTY'
    | 'VARIABLE'
    | 'PROFILE'
    | 'MODULE'
    | 'ARTIFACT'
    | 'GENERATION'
    | 'PACKAGE'
    | 'CONTRACT'
    | 'CLASS'
    | 'CLIENT'
    | 'METHOD'
    | 'PROXY_RULE'
    | 'ROUTE'
    | 'PATH'
    | 'ADDRESS';
  label: string;
  sourceId?: string;
}

/** Une relation : sa provenance (fichier, ligne), sa variante et son niveau de preuve ; jamais de doublon. */
export interface ConfigEdge {
  from: string;
  to: string;
  kind: ConfigRelation;
  sourceId: string;
  /** `default`, un profil Spring ou Maven, une configuration Angular. */
  variant: string;
  confidence: MapConfidence;
  file?: string;
  line?: number;
  /** La valeur ou la règle lue (une valeur sensible est masquée). */
  detail?: string;
}

export interface MapConfigGraph {
  nodes: ConfigNode[];
  edges: ConfigEdge[];
  /** Vrai si la limite de taille a été atteinte (le reste n'est pas montré). */
  truncated?: boolean;
}

// ── API & Services ───────────────────────────────────────────────────────────────────────────────

/**
 * INTERNAL : endpoints HTTP servis par le BFF ou le Backend analysés ; EXTERNAL : service tiers appelé
 * hors du périmètre analysé (hôte lu dans le code ou la configuration) ; UNCLASSIFIED : la cible ne peut
 * pas être établie (URL dynamique, propriété absente) — jamais une supposition silencieuse.
 */
export type ApiScope = 'INTERNAL' | 'EXTERNAL' | 'UNCLASSIFIED';
/** L'état de DÉTECTION (jamais la disponibilité réelle : aucune requête n'est envoyée). */
export type ApiStatus = 'DETECTED' | 'PROBABLE' | 'TO_CLASSIFY' | 'OBSOLETE';

export interface ApiEndpoint {
  /** Stable : le nœud de l'endpoint servi (interne) ou « api|MÉTHODE chemin » (externe). */
  id: string;
  method?: string;
  path?: string;
  /** Le nœud du graphe (endpoint servi) quand il existe. */
  node?: string;
  /** L'opération du contrat qui le décrit (nœud), si elle existe. */
  contract?: string;
  requestType?: string;
  responseType?: string;
  confidence: MapConfidence;
  evidence: Evidence[];
}

/** Un appel vers l'API : qui l'appelle, d'où, par quel client, avec quelle preuve. */
export interface ApiCall {
  /** Le nœud appelant (méthode Java, service du frontal). */
  from: string;
  layer: MapLayer;
  endpoint?: string;
  method?: string;
  path?: string;
  client?: string;
  confidence: MapConfidence;
  /** En mots : comment l'appel a été établi. */
  how: string;
  evidence: Evidence[];
}

/** Un champ échangé : envoyé (OUT, corps de la requête) ou reçu (IN, réponse), vu de l'appelant. */
export interface ApiField {
  name: string;
  type?: string;
  direction: 'OUT' | 'IN';
  required?: boolean;
  /** Le type qui le porte (DTO de requête ou de réponse). */
  container: string;
  node?: string;
  endpoint?: string;
  evidence: Evidence[];
}

export interface ApiContract {
  sourceId: string;
  file: string;
  format: string;
  version?: string;
  title?: string;
  /** Lien de documentation déclaré par le contrat lui-même (jamais deviné). */
  documentation?: string;
  /** Les endpoints de l'API décrits par ce contrat. */
  operations: number;
}

export interface ApiService {
  /** Stable d'un scan à l'autre : périmètre, source, contrôleur ou hôte. */
  id: string;
  name: string;
  proposedName: string;
  technicalName: string;
  scope: ApiScope;
  /** La couche qui sert l'API (interne). */
  owner?: MapLayer;
  /** Les couches qui l'appellent. */
  consumers: MapLayer[];
  /** Le fournisseur : la source analysée (interne) ou l'hôte (externe). */
  provider?: string;
  /** L'adresse de base, masquée (identifiants et paramètres sensibles retirés). */
  baseUrl?: string;
  /** Les clés de configuration qui portent l'adresse (jamais leur valeur secrète). */
  properties: string[];
  clients: string[];
  endpoints: ApiEndpoint[];
  calls: ApiCall[];
  fields: ApiField[];
  contract?: ApiContract;
  status: ApiStatus;
  confidence: MapConfidence;
  /** Pourquoi ce périmètre et ce regroupement (preuves en mots). */
  reasons: string[];
  evidence: Evidence[];
  /** Le périmètre a été fixé par une personne. */
  classifiedByPerson?: boolean;
}

// ── Décisions et associations (manuelles) ──────────────────────────────────────────────────────

export const DECISION_KINDS = [
  'CONFIRM',
  'RENAME',
  'MERGE',
  'REJECT',
  'RESTORE',
  'OUT_OF_SCOPE',
  'IN_SCOPE',
  'VALIDATE_CONCEPT',
  'LINK_SCENARIO',
  'VALIDATE_LINK',
  'REJECT_LINK',
  'UNLINK_SCENARIO',
  /** Un scénario associé à la main à un champ (cible : le nœud du champ), et son retrait. */
  'LINK_FIELD',
  'UNLINK_FIELD',
  /** Une API renommée (nom métier, le code n'est pas touché) ; son périmètre fixé à la main. */
  'RENAME_API',
  'CLASSIFY_API',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface MapDecision {
  id: string;
  at: string;
  by?: string;
  kind: DecisionKind;
  /** Fonctionnalité, concept, ou fonctionnalité d'une association. */
  target: string;
  /** Nouveau nom, fonctionnalités fusionnées, scénario… */
  value?: string;
  /** Une association : chemin positif ou négatif. */
  path?: 'POSITIVE' | 'NEGATIVE';
  /** La révision du scénario au moment de la décision. */
  revision?: string;
  note?: string;
}

// ── Couverture ─────────────────────────────────────────────────────────────────────────────────

/** Le lien d'un scénario à une fonctionnalité : proposé (avec ses preuves), validé, rejeté. */
export interface ScenarioLink {
  scenario: string;
  feature: string;
  origin: 'AUTO' | 'MANUAL';
  status: 'PROPOSED' | 'VALIDATED' | 'REJECTED';
  path: 'POSITIVE' | 'NEGATIVE';
  confidence: MapConfidence;
  reasons: string[];
  evidence: Evidence[];
  /** Les champs de la fonctionnalité que ses étapes saisissent. */
  fields: string[];
}

export type CoverageStatus = 'COVERED' | 'PARTIAL' | 'NOT_COVERED' | 'TO_CONFIRM' | 'OUT_OF_SCOPE';

export interface CoverageCriterion {
  id: 'LINKED' | 'TRAVERSED' | 'ASSERTED' | 'PASSED' | 'CRITICAL_FIELDS' | 'NEGATIVE_PATH';
  label: string;
  /** undefined : non applicable (exclu du dénominateur), avec la raison. */
  met?: boolean;
  detail: string;
}

export interface FeatureCoverage {
  feature: string;
  status: CoverageStatus;
  criteria: CoverageCriterion[];
  met: number;
  applicable: number;
  /** « 3 critères sur 5 » : la formule, lisible. */
  formula: string;
  scenarios: {
    scenario: string;
    link: ScenarioLink['status'];
    origin: ScenarioLink['origin'];
    path: ScenarioLink['path'];
    lastRun?: { run: string; verdict: string; at: string };
    traversed?: boolean;
    assertions: number;
    passed?: boolean;
    /** Une attente de ce scénario portant sur la fonctionnalité a réussi à sa dernière exécution. */
    asserted?: boolean;
  }[];
  /** Champs critiques jamais saisis par un scénario validé. */
  untestedFields: string[];
  recommendations: string[];
}

export interface CoverageSummary {
  counts: Record<CoverageStatus, number>;
  /** Couvertes / (total − hors périmètre) ; les rejetées ne comptent pas ; absent : non calculable. */
  percent?: number;
  numerator: number;
  denominator: number;
  formula: string;
}

// ── Impact ─────────────────────────────────────────────────────────────────────────────────────

export interface MapChange {
  node: string;
  kind: MapNodeKind;
  name: string;
  change: 'ADDED' | 'REMOVED' | 'CHANGED';
  detail: string[];
  /** La source et la couche de l'élément (absentes des rapports d'avant). */
  source?: string;
  layer?: MapLayer;
  /** Les fonctionnalités qui atteignent l'élément par le graphe (chemin démontré ou probable). */
  features?: { id: string; name: string }[];
  /** Une preuve de code de l'élément (dans le scan qui le porte). */
  evidence?: Evidence;
}

/** Une source comparée entre deux scans : un autre commit n'est pas une différence si les fichiers lus sont identiques. */
export interface SourceComparison {
  sourceId: string;
  name: string;
  layer: MapLayer;
  status: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'UNCHANGED' | 'UNDETERMINED';
  from?: { revision?: string; files: number; state: SourceScan['state'] };
  to?: { revision?: string; files: number; state: SourceScan['state'] };
  /** Les éléments du graphe de cette source ajoutés, retirés, modifiés. */
  changes: { added: number; removed: number; changed: number };
  reason: string;
}

export interface ImpactReport {
  from: string;
  to: string;
  /** Les sources des deux scans, comparées (absent des rapports d'avant cette option). */
  sources?: SourceComparison[];
  changes: MapChange[];
  features: { feature: string; name: string; confidence: 'CONFIRMED' | 'PROBABLE'; via: string[] }[];
  scenarios: { scenario: string; confidence: 'CONFIRMED' | 'PROBABLE'; features: string[]; reason: string }[];
  /** Page → onglet → fonctionnalité → élément touché : l'onglet le plus proche qui contient l'élément, le
   * déclenche (confirmé si le chemin l'est) ou en lit la valeur (potentiel). Absent des rapports d'avant. */
  tabs?: {
    page?: string;
    tab: string;
    tabName: string;
    feature?: string;
    element: string;
    elementName: string;
    confidence: 'CONFIRMED' | 'PROBABLE';
    how: 'CONTAINS' | 'TRIGGERS' | 'READS';
  }[];
  /**
   * Les actions de l'interface (bouton, méthode appelée par le gabarit ou le cycle de vie) dont le parcours
   * atteint un élément modifié, avec le chemin de propagation le plus court et les conditions rencontrées.
   * Probable dès qu'un lien du chemin l'est (branche non déterminée, souscription non démontrée…).
   */
  actions?: {
    action: string;
    name: string;
    component?: string;
    element: string;
    elementName: string;
    confidence: 'CONFIRMED' | 'PROBABLE';
    path: string[];
    conditions: string[];
  }[];
}

/** Ce que le tableau de bord lit en une fois. */
export interface CartographyView {
  config: CartographyConfig;
  /** Les racines sous lesquelles une source peut être lue ; vide : aucun scan possible. */
  allowedRoots: string[];
  supported: readonly MapTechnology[];
  scans: ScanRecord[];
  running?: ScanRecord;
  model?: CartographyModel;
  decisions: MapDecision[];
  links: ScenarioLink[];
  coverage: FeatureCoverage[];
  summary: CoverageSummary;
}

/** Une décision envoyée au serveur (l'identifiant, la date, l'auteur et la révision sont posés par lui). */
export type MapDecisionInput = Pick<MapDecision, 'kind' | 'target'> &
  Partial<Pick<MapDecision, 'value' | 'path' | 'note'>>;

/** Quelques lignes du fichier d'une preuve, lues sous la source configurée. */
export interface EvidenceExcerpt {
  source: string;
  file: string;
  line: number;
  /** Le numéro de la première ligne rendue. */
  start: number;
  lines: string[];
  /** Le fichier a changé depuis le scan : la preuve est périmée (la raison est dite). */
  stale?: string;
  /** L'extrait n'a pas pu être lu (fichier absent, révision disparue) : la raison, sans inventer de code. */
  unavailable?: string;
  /** La couche, le scan et la révision dont l'extrait est tiré. */
  layer?: MapLayer;
  scanId?: string;
  revision?: string;
  /** « Voir sur Git » : le fichier chez l'hébergeur, à la révision analysée et à la ligne. */
  gitUrl?: string;
}

// ── Exploration progressive (fonctionnalités → champs → champ) ────────────────────────────────────

/** Une page d'une liste paginée par le serveur. */
export interface MapPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** Les critères d'une liste : recherche, critères par colonne, tri, page. */
export interface MapListQuery {
  q?: string;
  module?: string;
  layer?: string;
  status?: string;
  coverage?: string;
  type?: string;
  /** Les champs d'une fonctionnalité : seulement la ligne de ce concept de données. */
  concept?: string;
  /** Le catalogue des API : INTERNAL, EXTERNAL ou UNCLASSIFIED. */
  scope?: string;
  sort?: string;
  page?: number;
  size?: number;
}

/** Le résumé de l'écran : sans aucun graphe, ce qui s'affiche au premier chargement. */
export interface MapSummary {
  config: CartographyConfig;
  allowedRoots: string[];
  /** Les hôtes Git autorisés pour les sources distantes ; absent : sources distantes désactivées. */
  gitHosts?: string[];
  supported: readonly MapTechnology[];
  scans: ScanRecord[];
  running?: ScanRecord;
  /** Le scan affiché (absent : aucun scan). */
  scan?: ScanRecord;
  /** La configuration a changé depuis ce scan : les données peuvent être obsolètes. */
  stale: boolean;
  kpis: {
    features: number;
    scenarios: number;
    fields: number;
    /** Les concepts de données utilisés par plusieurs fonctionnalités. */
    reuse: number;
    /** Fonctionnalités candidates et associations proposées, en attente d'une décision. */
    toValidate: number;
  };
  coverage: CoverageSummary;
  modules: string[];
  topReuse: { concept: string; name: string; features: number; layers: MapLayer[] }[];
  reuseByFeature: { feature: string; name: string; concepts: number }[];
  traceability: { fieldsLayers: boolean; featureScenarios: boolean; impact: boolean };
  issues: number;
  performance: MapPerformance;
}

/** Ce que le serveur a mesuré : jamais une valeur estimée. */
export interface MapPerformance {
  indexedNodes: number;
  indexedFields: number;
  indexedEdges: number;
  /** Les liens fusionnés parce qu'ils reliaient les mêmes nœuds par le même type (dédupliqués au scan). */
  mergedEvidence: number;
  indexBuildMs?: number;
  cache: { hits: number; misses: number };
  scanAt?: string;
}

export interface FeatureRow {
  id: string;
  name: string;
  module?: string;
  status: Feature['status'];
  layers: MapLayer[];
  /** Les champs de la fonctionnalité, regroupés par concept de données. */
  fields: number;
  scenarios: number;
  /** Ses concepts de données partagés avec d'autres fonctionnalités. */
  reuse: number;
  coverage?: Pick<FeatureCoverage, 'status' | 'met' | 'applicable' | 'formula'> & {
    criteria: Pick<CoverageCriterion, 'id' | 'met' | 'detail'>[];
  };
}

export interface FeatureDetail {
  feature: Omit<Feature, 'nodes' | 'reach' | 'fields'> & { nodeCount: number; fieldCount: number };
  coverage?: FeatureCoverage;
  links: ScenarioLink[];
  related: { id: string; name: string; via: string[] }[];
  /** Les liens entre les nœuds de la fonctionnalité (bornés). */
  edges: MapEdge[];
  /**
   * `tab` : un conteneur qui est un groupe d'onglets (GROUP) ou un onglet (TAB). `negated` : une condition écrite
   * pour bloquer l'élément ([disabled], [hidden], else), vraie quand l'élément est désactivé ou masqué.
   * `unresolved` : un élément interactif dont l'action n'a pas pu être reliée à une méthode (raison).
   */
  nodes: (Pick<MapNode, 'id' | 'kind' | 'layer' | 'name' | 'label'> & {
    tab?: string;
    negated?: true;
    unresolved?: string;
  })[];
  /** La corrélation inter-couches des appels de la fonctionnalité (absente d'un scan antérieur). */
  correlations?: MapCorrelation[];
  truncated: boolean;
}

export type FieldTestState = 'VERIFIED' | 'EXECUTED' | 'ASSOCIATED' | 'NONE';

/** Un champ d'une fonctionnalité : un concept de données, représenté par son champ dans cette fonctionnalité. */
export interface FieldRow {
  id: string;
  concept: string;
  name: string;
  label?: string;
  type?: string;
  layers: MapLayer[];
  /** Les fonctionnalités qui utilisent ce concept. */
  reuse: number;
  status: FieldConcept['status'];
  tested: FieldTestState;
}

export interface ConceptRow {
  id: string;
  name: string;
  status: FieldConcept['status'];
  layers: MapLayer[];
  fields: number;
  features: number;
}

export interface MapSubgraph {
  nodes: MapNode[];
  edges: MapEdge[];
  depth: number;
  limit: number;
  /** La limite de nœuds a coupé l'exploration. */
  truncated: boolean;
}

/** Le sens d'un parcours : vers l'amont (ce qui déclenche, contient ou contrôle), l'aval (ce qui suit jusqu'à la persistance), ou les deux. */
export const TRACE_DIRECTIONS = ['UP', 'DOWN', 'BOTH'] as const;
export type TraceDirection = (typeof TRACE_DIRECTIONS)[number];

/**
 * Le parcours d'un élément, dans un sens, borné en profondeur et en nombre de nœuds. Chaque nœud porte sa
 * distance au départ (négative vers l'amont) ; la frontière liste les nœuds dont la suite n'a pas été
 * parcourue (profondeur ou limite atteinte, ou critères) ; les ruptures sont les appels dont la liaison n'est
 * pas confirmée, avec leur diagnostic. Rien n'est complété : un parcours s'arrête là où les sources s'arrêtent.
 */
export interface MapTrace extends MapSubgraph {
  start: string;
  direction: TraceDirection;
  levels: Record<string, number>;
  frontier: { node: string; reason: 'DEPTH' | 'LIMIT' | 'FILTERED' }[];
  breaks: {
    node: string;
    method: string;
    path: string;
    status: CorrelationStatus;
    causes: { code: CorrelationCause; message: string }[];
    diagnostic?: MapCorrelation['diagnostic'];
  }[];
  /** Les appels sortants (externes ou à classifier) faits depuis un nœud du parcours. */
  outbound: ApiOutbound[];
  /** Les critères retenus (couches, relations) : un parcours filtré le dit. */
  layers?: MapLayer[];
  kinds?: MapEdgeKind[];
  scanId: string;
}

// ── Moteur d'investigation ──────────────────────────────────────────────────────────────────────

/**
 * La nature d'une relation pour une investigation : déclenchement ou appel (CAUSAL), donnée lue, écrite ou
 * transmise (DATA), condition (CONTROL), correspondance de contrat (CONTRACT), composition ou appartenance
 * (STRUCTURE), couverture par les scénarios (COVERAGE, jamais suivie). Une relation structurelle n'est
 * jamais présentée comme une cause.
 */
export const RELATION_NATURES = ['CAUSAL', 'DATA', 'CONTROL', 'CONTRACT', 'STRUCTURE', 'COVERAGE'] as const;
export type RelationNature = (typeof RELATION_NATURES)[number];

/** Ce que l'investigation cherche : le parcours, la persistance, les endpoints, les points d'entrée, les conditions, les données. */
export const INVESTIGATION_GOALS = [
  'JOURNEY',
  'PERSISTENCE',
  'ENDPOINTS',
  'ENTRY_POINTS',
  'CONDITIONS',
  'DATA',
] as const;
export type InvestigationGoal = (typeof INVESTIGATION_GOALS)[number];

/** FOCUSED : priorisée, liens démontrés seulement ; EXHAUSTIVE : toutes les natures, liens non démontrés compris (marqués). */
export type InvestigationMode = 'FOCUSED' | 'EXHAUSTIVE';

export interface InvestigationBudget {
  /** Nœuds visités au plus (toutes branches). */
  nodes: number;
  /** Nœuds au plus par branche (une branche part d'un voisin du point de départ). */
  perBranch: number;
  /** Relations suivies au plus par nature. */
  perNature: number;
  depth: number;
  /** Voisins d'un même nœud suivis au plus pour les natures non causales (un store à cent propriétés n'est pas déplié). */
  fanOut: number;
  timeMs: number;
}

export interface InvestigationRequest {
  start: string;
  goal?: InvestigationGoal;
  direction?: TraceDirection;
  mode?: InvestigationMode;
  budget?: Partial<InvestigationBudget>;
}

/** Une recherche faite à une rupture : sa stratégie, son issue, sa justification ; jamais refaite. */
export interface InvestigationAttempt {
  at: string;
  strategy:
    | 'CORRELATION'
    | 'ANALYZER_DIAGNOSTIC'
    | 'UNDEMONSTRATED_LINK'
    | 'IMPLEMENTATIONS'
    | 'CONSUMERS'
    | 'CALLERS'
    | 'SOURCE_STATE'
    | 'ADVISOR';
  outcome: 'RESOLVED' | 'CANDIDATES' | 'NOTHING';
  detail: string;
  found?: string[];
}

/** Une hypothèse : jamais un fait. Seule une relation démontrée du graphe peut la rendre SUPPORTED. */
export interface InvestigationHypothesis {
  id: string;
  at: string;
  claim: string;
  status: 'CANDIDATE' | 'SUPPORTED' | 'REJECTED' | 'CONTRADICTORY';
  candidates: string[];
  evidence: string[];
  /** ANALYZER : proposée par les analyseurs ; ADVISOR : par une extension (désactivée par défaut), puis vérifiée. */
  source: 'ANALYZER' | 'ADVISOR';
}

/** Où et pourquoi une branche s'arrête sans aboutir, avec ce qui a été cherché et ce qui pourrait la résoudre. */
export interface InvestigationBreak {
  at: string;
  code: string;
  message: string;
  hints: string[];
  resolutions: string[];
}

export interface InvestigationFrontierItem {
  node: string;
  reason: 'BUDGET' | 'BRANCH_BUDGET' | 'NATURE_BUDGET' | 'DEPTH' | 'TIME' | 'FAN_OUT' | 'UNDEMONSTRATED';
  /** Voisins non suivis depuis ce nœud. */
  pending: number;
  direction: 'UP' | 'DOWN';
}

/** Un chemin démontrable (jamais observé : l'analyse statique ne prouve pas une exécution). */
export interface InvestigationPath {
  id: string;
  direction: 'UP' | 'DOWN';
  nodes: string[];
  edges: string[];
  /** COMPLETE : il aboutit (persistance, API externe, fin locale, point d'entrée) ; PARTIAL : frontière ; BROKEN : rupture. */
  status: 'COMPLETE' | 'PARTIAL' | 'BROKEN';
  end: 'PERSISTENCE' | 'EXTERNAL' | 'ENDPOINT' | 'LOCAL' | 'ENTRY' | 'BREAK' | 'FRONTIER' | 'CYCLE';
  confidence: MapConfidence;
  conditions: string[];
}

export interface InvestigationCycle {
  nodes: string[];
  nature: 'CALL' | 'DATA' | 'STATE' | 'STRUCTURE';
  /** Les sorties du cycle (nœuds hors cycle atteints depuis lui) : elles restent explorées. */
  exits: string[];
}

export interface Investigation {
  id: string;
  scanId: string;
  /** Les révisions des sources au moment de l'investigation. */
  revisions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  request: Required<Pick<InvestigationRequest, 'start' | 'goal' | 'direction' | 'mode'>> & {
    budget: InvestigationBudget;
  };
  /** COMPLETE : aucune frontière ni rupture ; PARTIAL : budget, rupture ou source partielle ; STALE : le scan a changé. */
  state: 'COMPLETE' | 'PARTIAL' | 'STALE';
  nodes: MapNode[];
  edges: MapEdge[];
  natures: Record<string, RelationNature>;
  levels: Record<string, number>;
  paths: InvestigationPath[];
  pathsTruncated: boolean;
  breaks: InvestigationBreak[];
  hypotheses: InvestigationHypothesis[];
  attempts: InvestigationAttempt[];
  frontier: InvestigationFrontierItem[];
  cycles: InvestigationCycle[];
  /** Les branches reprises depuis la frontière (« Explorer cette branche »). */
  expansions: string[];
  /** L'état de l'exploration (coût, branche) de chaque nœud visité : une reprise repart de lui sans tout refaire. */
  trail: Record<string, { cost: number; branch: string; causal?: boolean }>;
  /** L'investigation dont celle-ci est la reprise sur un nouveau scan. */
  previous?: string;
  metrics: {
    visited: number;
    useful: number;
    searches: number;
    resolved: number;
    remaining: number;
    ms: number;
    heapKb?: number;
  };
  limitations: string[];
}

export type InvestigationSummary = Pick<
  Investigation,
  'id' | 'scanId' | 'createdAt' | 'updatedAt' | 'state'
> & {
  start: string;
  startName: string;
  goal: InvestigationGoal;
  direction: TraceDirection;
  paths: number;
  breaks: number;
};

export interface FieldScenario {
  scenario: string;
  feature?: string;
  origin: 'INFERRED' | 'MANUAL';
  /** Associé : ses étapes saisissent le champ, ou une personne l'a relié. */
  associated: true;
  /** Exécuté : sa dernière exécution a joué les étapes qui l'atteignent. */
  executed: boolean;
  /** Vérifié par assertion : une attente sur l'appel ou l'écran de la fonctionnalité a réussi. */
  verified: boolean;
  lastRun?: { run: string; verdict: string; at: string };
  reasons: string[];
}

export interface ImpactItems {
  features: { id: string; name: string }[];
  components: string[];
  dtos: string[];
  services: string[];
  endpoints: string[];
  tables: string[];
  scenarios: string[];
}

export interface FieldImpact {
  demonstrated: ImpactItems;
  potential: ImpactItems;
  /** La profondeur d'exploration atteinte (liens suivis depuis le champ). */
  depth: number;
  files: string[];
}

export interface FieldSheet {
  node: MapNode;
  feature?: { id: string; name: string };
  concept: {
    id: string;
    name: string;
    status: FieldConcept['status'];
    layers: MapLayer[];
    gaps: string[];
    homonyms: { id: string; name: string; layers: MapLayer[] }[];
  };
  graph: MapSubgraph;
  /** Le parcours du champ, lien après lien, de sa naissance à sa persistance. */
  sequence: MapEdge[];
  reuse: { id: string; name: string; module?: string; confidence: MapConfidence }[];
  scenarios: FieldScenario[];
  impact: FieldImpact;
  issues: FieldIssue[];
  /** Fonctionnalités du concept dont un scénario associé saisit le champ / fonctionnalités du concept. */
  coverage: { numerator: number; denominator: number; percent?: number; formula: string };
  scanId: string;
}

// ── API & Services : requêtes progressives ───────────────────────────────────────────────────────

export interface ApiRow {
  id: string;
  name: string;
  technicalName: string;
  scope: ApiScope;
  owner?: MapLayer;
  provider?: string;
  status: ApiStatus;
  confidence: MapConfidence;
  endpoints: number;
  /** Le premier endpoint (« POST /api/requests »), pour reconnaître l'API dans la liste. */
  firstEndpoint?: string;
  features: number;
}

export interface ApiCatalog extends MapPage<ApiRow> {
  /** Le scan porte-t-il un catalogue (un scan plus ancien : non). */
  available: boolean;
  counts: { all: number; internal: number; external: number; unclassified: number };
  kpis: {
    apis: number;
    internal: number;
    external: number;
    endpoints: number;
    features: number;
    scenarios: number;
  };
}

export interface ApiFeatureUse {
  id: string;
  name: string;
  module?: string;
  /** Les endpoints utilisés (« POST /companies »). */
  usage: string[];
  confidence: MapConfidence;
  /** Le chemin qui le démontre (nœuds de l'appelant à l'API). */
  via: string[];
}

export interface ApiScenarioUse {
  scenario: string;
  feature: string;
  format?: string;
  associated: boolean;
  executed: boolean;
  verified: boolean;
  lastRun?: { run: string; verdict: string; at?: string };
}

// ── Structure conditionnelle (conteneurs, boutons, conditions, décisions) ───────────────────────────

/** Un élément de l'arbre d'une page : écran, composant, conteneur, champ ou bouton, avec ses conditions. */
export interface StructureItem {
  id: string;
  kind: 'ROUTE' | 'COMPONENT' | 'CONTAINER' | 'FIELD' | 'BUTTON';
  /** Un conteneur qui est un groupe d'onglets ou un onglet. */
  tab?: 'GROUP' | 'TAB';
  name: string;
  sub?: string;
  conditions: { aspect: 'VISIBLE' | 'ENABLED'; expression: string; whenTrue: boolean }[];
  children: StructureItem[];
}

/** Les comptes de la structure du projet (calculés sur le scan). */
export interface StructureKpis {
  pages: number;
  containers: number;
  fields: number;
  buttons: number;
  internalApis: number;
  externalApis: number;
  conditions: number;
}

export interface MapStructure {
  feature?: { id: string; name: string };
  roots: StructureItem[];
  kpis: StructureKpis;
}

/** Une condition d'un élément et la chaîne qui la relie à sa décision Backend (si elle est démontrée). */
export interface ElementCondition {
  id: string;
  aspect: 'VISIBLE' | 'ENABLED';
  expression: string;
  how: string;
  /** L'élément est visible (ou activé) quand l'expression est vraie (sinon : quand elle est fausse). */
  whenTrue: boolean;
  /** Hérité d'un conteneur parent (son nom). */
  inherited?: string;
  /** D'où viennent les membres lus (réponse d'un appel, accesseur, formulaire, entrée, inconnu). */
  sources: { member: string; kind: string }[];
  chain: { nodes: MapNode[]; edges: MapEdge[] };
  decision?: { method: MapNode; loops: number; predicates: string[]; reads: string[] };
  status: MapConfidence;
  /** Pourquoi la décision n'est pas déterminée (quand elle ne l'est pas). */
  undetermined?: string;
}

/** Une action d'un bouton : les appels déclenchés, les endpoints atteints, l'aval (API externes, tables). */
export interface ElementAction {
  handler?: string;
  /** Les appels HTTP du frontal atteints par le gestionnaire (directement ou via stores et flux RxJS). */
  triggers: MapNode[];
  /** Les étapes intermédiaires du frontal, dans l'ordre : méthode du composant, store, flux, service. */
  via?: MapNode[];
  endpoints: MapNode[];
  outbound: ApiOutbound[];
  entities: { name: string; access: 'READ' | 'WRITE' }[];
  status: MapConfidence;
}

export interface ElementSheet {
  element: MapNode;
  ancestors: MapNode[];
  children: MapNode[];
  conditions: ElementCondition[];
  actions: ElementAction[];
  /** Le sous-graphe de l'élément (conditions, chaîne de décision, actions et leur aval), borné. */
  graph: MapSubgraph;
  outbound: ApiOutbound[];
  features: ApiFeatureUse[];
  scenarios: ApiScenarioUse[];
  /** Un onglet ou un groupe d'onglets : son contenu, ses dépendances et ses préconditions démontrées. */
  tab?: TabSheet;
  scanId: string;
  scannedAt?: string;
}

/** Ce qu'un onglet contient et ce dont il dépend, d'après le code. */
export interface TabSheet {
  role: 'GROUP' | 'TAB';
  library: string;
  label?: string;
  lazy?: string;
  repeat?: string;
  items?: string[];
  route?: string;
  routeUnresolved?: string;
  /** Ce que le code montre pour atteindre l'onglet (écran, onglets parents, conditions), dans l'ordre. */
  preconditions: string[];
  /** Le flux du store qui choisit l'onglet actif d'un groupe ([selectedIndex], [activeId]…). */
  selectedBy: { stream: string; reason: string; confidence: MapConfidence }[];
  /** Les onglets dont celui-ci dépend (un store qu'ils modifient), et ceux qui dépendent de lui. */
  dependsOn: { id: string; name: string; reason: string; confidence: MapConfidence }[];
  usedBy: { id: string; name: string; reason: string; confidence: MapConfidence }[];
  /** Les onglets du groupe. */
  tabs: { id: string; name: string }[];
  /** Les composants affichés (avec les autres endroits qui les affichent) ; champs, boutons, appels, stores. */
  components: { id: string; name: string; reusedIn: string[] }[];
  fields: number;
  buttons: number;
  apis: MapNode[];
  stores: string[];
}

export interface ConditionRow {
  id: string;
  element: { id: string; name: string; kind: string };
  component?: string;
  aspect: 'VISIBLE' | 'ENABLED';
  expression: string;
  /** Faux quand l'expression décrit l'inverse (masqué si, désactivé si). */
  whenTrue: boolean;
  sources: { member: string; kind: string }[];
  decision?: string;
  status: MapConfidence;
  undetermined?: string;
}

export interface ActionRow {
  id: string;
  name: string;
  component?: string;
  handler?: string;
  calls: string[];
  endpoints: string[];
  externals: string[];
  entities: string[];
  status: MapConfidence;
}

/** Un appel sortant vers une API hors périmètre (externe ou à classifier), tel que le scan l'a établi. */
export interface ApiOutbound {
  api: string;
  name: string;
  scope: ApiScope;
  /** L'hôte (externe) quand il est établi. */
  provider?: string;
  endpoint: string;
  method?: string;
  path?: string;
  /** Le nœud appelant. */
  from: string;
  client?: string;
  confidence: MapConfidence;
  how: string;
  evidence: Evidence[];
}

export interface ApiSheet {
  api: ApiService;
  features: ApiFeatureUse[];
  scenarios: ApiScenarioUse[];
  /** Le parcours d'intégration démontré : de l'appelant le plus en amont jusqu'à l'API (ordre des couches). */
  path: { nodes: MapNode[]; edges: MapEdge[] };
  /**
   * Le graphe complet de l'API, borné : tout l'amont démontré (appelants jusqu'au frontal), l'aval de ses
   * endpoints (méthodes, persistance) et ce qui y est rattaché (champs, DTO, tables et colonnes).
   */
  graph: MapSubgraph;
  /** Les appels sortants (API externes ou à classifier) faits depuis un nœud de ce graphe, avec leur preuve. */
  outbound: ApiOutbound[];
  impact: {
    demonstrated: { features: string[]; scenarios: string[]; components: string[]; dtos: string[] };
    potential: { features: string[]; scenarios: string[]; components: string[]; dtos: string[] };
  };
  criticality: { level: 'LOW' | 'MEDIUM' | 'HIGH'; reason: string };
  scanId: string;
  scannedAt?: string;
}

// ── La carte d'une fonctionnalité (Parcours & Graphe) ────────────────────────────────────────────────

/** Les couloirs, toujours dans cet ordre : interface, BFF, backend (persistance comprise), API externes. */
export const FEATURE_LANES = ['FRONTEND', 'BFF', 'BACKEND', 'EXTERNAL'] as const;
export type FeatureLane = (typeof FEATURE_LANES)[number];

/** Les groupes d'un couloir (ordre d'affichage). La persistance est un sous-groupe du backend. */
export const FEATURE_GROUPS = [
  'PAGE',
  'COMPONENT',
  'CONTAINER',
  'FIELD',
  'BUTTON',
  'CONDITION',
  'STORE',
  'SPA_SERVICE',
  'MODEL',
  'CONTROLLER',
  'ENDPOINT',
  'CONTRACT',
  'DTO',
  'SERVICE',
  'RULE',
  'CLIENT',
  'METHOD',
  'REPOSITORY',
  'ENTITY',
  'EXTERNAL_SERVICE',
  'EXTERNAL_CALL',
] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

/** Les catégories de relations montrées (dans cet ordre). */
export const FEATURE_CATEGORIES = [
  'CONTAINS',
  'CONDITION',
  'DEPENDS',
  'CALLS',
  'DATA',
  'PERSISTENCE',
  'EXTERNAL',
] as const;
export type FeatureCategory = (typeof FEATURE_CATEGORIES)[number];

/** Les cartes renvoyées au plus par groupe dans la carte d'une fonctionnalité (les plus reliées d'abord). */
export const FEATURE_GROUP_CARDS = 40;

/** Un élément de la fonctionnalité, rangé dans un couloir et un groupe ; `card` réunit les membres d'une classe. */
export interface FeatureMapItem {
  id: string;
  lane: FeatureLane;
  group: FeatureGroup;
  kind: MapNodeKind | 'EXTERNAL';
  name: string;
  label?: string;
  /** Une précision lisible : méthode et chemin d'un endpoint, type d'un champ, table d'une entité… */
  sub?: string;
  /** La carte (classe, DTO, entité, store, service externe) qui réunit cet élément et ses voisins. */
  card: string;
  cardTitle: string;
  /** Nombre de relations de la fonctionnalité qui le touchent. 0 : élément isolé. */
  links: number;
  /** Persistance (sous-groupe Hibernate/JPA du backend). */
  persistence?: boolean;
  evidence?: Evidence;
}

export interface FeatureMapRelation {
  id: string;
  kind: MapEdgeKind | 'EXTERNAL_CALL';
  category: FeatureCategory;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  fromLane: FeatureLane;
  toLane: FeatureLane;
  fromGroup: FeatureGroup;
  toGroup: FeatureGroup;
  status: MapConfidence;
  reason: string;
  evidence?: Evidence;
}

/** Un faisceau : les relations d'une même catégorie entre deux groupes, comptées exactement. */
export interface FeatureMapBundle {
  key: string;
  category: FeatureCategory;
  fromLane: FeatureLane;
  fromGroup: FeatureGroup;
  toLane: FeatureLane;
  toGroup: FeatureGroup;
  count: number;
  statuses: Record<MapConfidence, number>;
}

export interface FeatureTreeNode {
  id: string;
  kind: MapNodeKind;
  name: string;
  children: FeatureTreeNode[];
}

export type FeatureMapGapCode =
  | 'LANE_NO_SOURCE'
  | 'LANE_NOT_REACHED'
  | 'NO_STORE'
  | 'ISOLATED'
  | 'BROKEN_CORRELATION'
  | 'UNCLASSIFIED_CALL'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'SOURCE_PARTIAL'
  | 'CHAIN_BREAK'
  | 'TRUNCATED';

/** Ce que la carte ne démontre pas, avec sa cause (jamais comblé par une supposition). */
export interface FeatureMapGap {
  code: FeatureMapGapCode;
  lane?: FeatureLane;
  /** Les éléments concernés (identifiants ou textes lisibles), bornés. */
  items: string[];
  detail: string;
}

export interface FeatureMap {
  feature: {
    id: string;
    name: string;
    status: FeatureStatus;
    module?: string;
    coverage?: { status: string; met: number; applicable: number };
    scenarios: number;
  };
  /**
   * Les éléments affichés, triés par couloir puis groupe : par groupe, les cartes les plus reliées (au plus
   * `FEATURE_GROUP_CARDS`, plus celle de l'élément demandé) ; les autres restent comptées dans `lanes` et
   * leurs relations dans le tableau.
   */
  items: FeatureMapItem[];
  lanes: {
    lane: FeatureLane;
    present: boolean;
    /** `count` : éléments du groupe ; `cards` : cartes du groupe ; `shown` : cartes renvoyées dans `items`. */
    groups: { group: FeatureGroup; count: number; cards: number; shown: number }[];
  }[];
  /** Le nombre d'éléments de la fonctionnalité, avant la limite de cartes par groupe. */
  itemCount: number;
  /**
   * Avec `query.item` : le parcours de l'élément (ou de la carte) demandé, sur toutes les relations de la
   * fonctionnalité : ce qu'il déclenche en aval et ce qui le contient ou l'appelle en amont, de proche en
   * proche (bouton → méthode → service → endpoint BFF → contrôleur → … → table). Le tableau ne garde alors
   * que les relations de ce parcours ; le reste peut être replié.
   */
  neighbours?: string[];
  tree: FeatureTreeNode[];
  bundles: FeatureMapBundle[];
  categories: Record<FeatureCategory, number>;
  statuses: Record<MapConfidence, number>;
  conditions: ConditionRow[];
  gaps: FeatureMapGap[];
  /** Les relations de la page demandée, selon les critères ; `total` : toutes celles qui y répondent. */
  relations: MapPage<FeatureMapRelation>;
  /** Le nombre de relations de la fonctionnalité, tous critères confondus. */
  relationCount: number;
  truncated: boolean;
  scanId: string;
}

/** Les critères du tableau des relations d'une fonctionnalité. */
export interface FeatureMapQuery {
  category?: FeatureCategory;
  lane?: FeatureLane;
  status?: MapConfidence;
  /** Seulement les relations qui touchent cet élément. */
  item?: string;
  q?: string;
  page?: number;
  size?: number;
}
