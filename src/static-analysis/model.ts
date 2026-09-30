/**
 * ANALYSE STATIQUE : le code de l'application (TypeScript / JavaScript, gabarits HTML)
 * comme source de connaissance SUPPLÉMENTAIRE. Elle fournit des PREUVES, des
 * HYPOTHÈSES et des CANDIDATS, jamais une vérité d'exécution :
 *
 *   STATIC_DISCOVERED  ≠  RUNTIME_CONFIRMED
 *
 * Seule l'exploration réelle (Playwright) confirme qu'un chemin est utilisable ou
 * qu'un champ est bien celui qu'on croit. Le code n'est jamais exécuté : il est lu
 * (AST du compilateur TypeScript), jamais évalué, importé ni requis.
 */

/** Version de l'analyseur : un changement invalide le cache. */
export const STATIC_ANALYZER_VERSION = '1.0.0';

export type StaticFramework = 'ANGULAR' | 'REACT' | 'VUE' | 'GENERIC' | 'UNKNOWN';

/** SOURCE : le dépôt de l'application ; BUNDLE : les scripts chargés par le navigateur. */
export type StaticAnalysisMode = 'SOURCE' | 'BUNDLE';

/** Ce que l'analyse a pu établir. */
export type StaticCoverage = 'FULL' | 'PARTIAL' | 'LIMITED' | 'UNAVAILABLE';

/** Une connaissance statique n'est vraie à l'exécution qu'une fois confirmée par Playwright. */
export type StaticTruth = 'STATIC_DISCOVERED' | 'RUNTIME_CONFIRMED' | 'RUNTIME_REJECTED';

/** Où a été trouvé un fait : fichier (relatif à la racine analysée) et ligne. */
export interface SourceLocation {
  file: string;
  line: number;
}

export interface StaticRouteNode {
  /** Chemin complet reconstruit (/administration/users). */
  path: string;
  /** Segment tel qu'écrit dans sa route (users). */
  segment: string;
  component?: string;
  redirectTo?: string;
  /** loadChildren / loadComponent : module ou composant chargé à la demande. */
  lazy?: string;
  guards: string[];
  /** Paramètres du chemin (:id). */
  parameters: string[];
  parent?: string;
  truth: StaticTruth;
  location: SourceLocation;
}

export interface StaticComponentNode {
  name: string;
  selector?: string;
  /** Gabarit relié (templateUrl), ou « inline ». */
  template?: string;
  /** Services injectés (constructeur ou inject()) : nom de propriété → classe. */
  injected: Record<string, string>;
  location: SourceLocation;
}

export type StaticValidatorKind =
  'required' | 'email' | 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'requiredTrue';

export interface StaticValidator {
  kind: StaticValidatorKind;
  value?: string | number;
}

export interface StaticFormNode {
  /** composant#propriété (CreateUserComponent#form). */
  id: string;
  component: string;
  property: string;
  controls: string[];
  location: SourceLocation;
}

/** Un contrôle de formulaire (FormControl) et ce que le code en dit. */
export interface StaticFieldNode {
  /** composant#formulaire.contrôle */
  id: string;
  form: string;
  component: string;
  /** Nom du contrôle : la valeur de formControlName dans le gabarit. */
  control: string;
  validators: StaticValidator[];
  /** Le gabarit relie un élément à ce contrôle (formControlName / [formControl]). */
  templateBinding?: { tag: string; inputType?: string; template: string };
  location: SourceLocation;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface StaticApiCallNode {
  /** Service#méthode qui fait l'appel. */
  id: string;
  owner: string;
  method: HttpMethod;
  /** Adresse (modèle) : /api/users ; `${…}` devient {param}. */
  route: string;
  /** Paramètre ou variable passé comme corps. */
  bodyParameter?: string;
  /** Type déclaré du corps (CreateUserRequest), si connu. */
  bodyType?: string;
  responseType?: string;
  location: SourceLocation;
}

export interface StaticDtoNode {
  name: string;
  properties: { name: string; type?: string; optional: boolean }[];
  location: SourceLocation;
}

/** Un lien de navigation vu dans le code : composant → route. */
export interface StaticNavigationEdge {
  fromComponent: string;
  target: string;
  evidence: 'ROUTER_NAVIGATION' | 'ROUTER_LINK' | 'ROUTE_CHILD';
  location: SourceLocation;
}

export type DataFlowStatus = 'RESOLVED' | 'UNRESOLVED_DATA_FLOW';

/** Un contrôle → une propriété d'objet de requête → un DTO → un appel HTTP. */
export interface StaticDataFlow {
  status: DataFlowStatus;
  field?: string;
  /** requête.email */
  requestProperty?: string;
  dtoProperty?: string;
  apiCall?: string;
  reason?: string;
  location: SourceLocation;
}

/** Le graphe statique de l'application. */
export interface StaticApplicationGraph {
  applicationId: string;
  version?: string;
  commit?: string;
  sourceHash: string;
  analyzerVersion: string;
  framework: StaticFramework;
  mode: StaticAnalysisMode;
  coverage: StaticCoverage;
  routes: StaticRouteNode[];
  components: StaticComponentNode[];
  forms: StaticFormNode[];
  fields: StaticFieldNode[];
  apiCalls: StaticApiCallNode[];
  dtos: StaticDtoNode[];
  navigation: StaticNavigationEdge[];
  dataFlows: StaticDataFlow[];
  /** Limites rencontrées (budget, fichiers ignorés, UNRESOLVED_DATA_FLOW…), sans secret. */
  warnings: string[];
  stats: { files: number; bytes: number; durationMs: number };
  generatedAt: string;
}

export const EVIDENCE_SOURCES = [
  'DOM',
  'ACCESSIBILITY',
  'FRAMEWORK',
  'STATIC_CODE',
  'DTO',
  'HTTP',
  'OPENAPI',
  'RUNTIME',
  'HISTORICAL',
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * Une preuve sémantique : ce qu'une source dit d'un élément, et POURQUOI. Jamais
 * « email = true » sans provenance.
 */
export interface SemanticEvidence {
  source: EvidenceSource;
  /** formControlName, data-flow, dto-property, openapi-format, validator… */
  kind: string;
  /** Le nom, le format ou la contrainte que la source donne (jamais une valeur saisie). */
  value: string;
  /** Concept du vocabulaire que ce nom ou ce format signifie (email, phone…). */
  concept?: string;
  confidence: number;
  provenance?: { location?: SourceLocation; detail: string };
}

/** Une arête du graphe de preuves : input → contact → request.email → … */
export interface EvidenceEdge {
  source: string;
  target: string;
  relation:
    'formControlName' | 'assigned-to' | 'dto-property' | 'request-body' | 'openapi-property' | 'validator';
  evidence: EvidenceSource;
  confidence: number;
}

/** La chaîne de provenance d'un champ, de l'élément de l'écran au contrat d'API. */
export interface FieldProvenance {
  /** formControlName du DOM. */
  control: string;
  component: string;
  chain: string[];
  edges: EvidenceEdge[];
  evidence: SemanticEvidence[];
  /** Le concept retenu (email…), s'il y en a un sans conflit bloquant. */
  concept?: string;
  conflicts: SemanticConflict[];
  truth: StaticTruth;
}

export interface SemanticConflict {
  kind: 'SEMANTIC_EVIDENCE_CONFLICT';
  concepts: { concept: string; sources: EvidenceSource[] }[];
  detail: string;
}

/** Ce que l'analyse statique a apporté au run (rapport), sans aucun secret. */
export interface StaticAnalysisSummary {
  /** USED : connaissance chargée ; NOT_NEEDED : jamais demandée (à la demande) ; UNAVAILABLE : échec, le run a continué. */
  status: 'USED' | 'NOT_NEEDED' | 'UNAVAILABLE';
  mode?: StaticAnalysisMode;
  framework?: StaticFramework;
  coverage?: StaticCoverage;
  cache?: 'HIT' | 'MISS' | 'DISABLED';
  files?: number;
  durationMs?: number;
  routes?: number;
  forms?: number;
  fields?: number;
  apiCalls?: number;
  dataFlows?: { resolved: number; unresolved: number };
  /** Champs et routes prouvés par le code ET confirmés par l'exécution. */
  confirmedFields: string[];
  confirmedRoutes: string[];
  warnings: string[];
}
