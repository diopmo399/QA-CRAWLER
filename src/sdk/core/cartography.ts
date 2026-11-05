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
export interface MapSource {
  id: string;
  name: string;
  layer: MapLayer;
  /** Chemin absolu, sous l'une des racines autorisées par le serveur (`allowedSourceRoots`). */
  path: string;
  /** Sous-dossiers analysés (relatifs à `path`) ; vide : tout le dossier. */
  include: string[];
  enabled: boolean;
}

export interface CartographyConfig {
  schema: 1;
  sources: MapSource[];
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

export interface SourceScan {
  sourceId: string;
  name: string;
  layer: MapLayer;
  state: 'SCANNED' | 'PARTIAL' | 'FAILED' | 'DENIED' | 'DISABLED' | 'REUSED';
  technologies: TechnologyStatus[];
  files: number;
  /** Fichiers laissés de côté (limites, taille, secrets), comptés. */
  skipped: number;
  secretsExcluded: number;
  revision?: string;
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
  edges: number;
  errors: string[];
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
}

export interface ImpactReport {
  from: string;
  to: string;
  changes: MapChange[];
  features: { feature: string; name: string; confidence: 'CONFIRMED' | 'PROBABLE'; via: string[] }[];
  scenarios: { scenario: string; confidence: 'CONFIRMED' | 'PROBABLE'; features: string[]; reason: string }[];
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
  nodes: Pick<MapNode, 'id' | 'kind' | 'layer' | 'name' | 'label'>[];
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
