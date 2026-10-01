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

import type { ApplicationRule } from './rules/rule-model.js';
import type { StaticSourceDiscoverySummary, StaticSourceProvenance } from './sources/model.js';

/** Version de l'analyseur : un changement invalide le cache. */
export const STATIC_ANALYZER_VERSION = '1.2.0';

export type StaticFramework = 'ANGULAR' | 'REACT' | 'VUE' | 'GENERIC' | 'UNKNOWN';

/**
 * SOURCE : le dépôt de l'application ; SOURCE_MAP : les sources d'origine publiées par
 * les source maps du déploiement ; HYBRID : le dépôt corrigé par le build déployé ;
 * BUNDLE : les scripts minifiés chargés par le navigateur.
 */
export type StaticAnalysisMode = 'SOURCE' | 'SOURCE_MAP' | 'HYBRID' | 'BUNDLE';

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

/**
 * D'où vient la valeur initiale d'un contrôle, selon le code : un littéral du
 * formulaire (country: ['Canada']), une réponse d'API (patchValue({ email: profile.email })
 * dans le subscribe d'un GET), l'état du composant, un calcul. Jamais la valeur d'un
 * secret (voir sanitize.ts).
 */
export interface StaticValueSource {
  /** composant#formulaire.contrôle, quand le formulaire est connu. */
  field?: string;
  component: string;
  control: string;
  kind: 'INITIALIZER' | 'PATCH_VALUE' | 'SET_VALUE' | 'RESET';
  origin: 'EMPTY' | 'FORM_DEFAULT' | 'STATIC_INITIALIZER' | 'API_RESPONSE' | 'COMPONENT_STATE' | 'DERIVED';
  literal?: string | number | boolean;
  /** profile.country (borné). */
  expression?: string;
  /** Service#méthode dont la réponse alimente la valeur, et son appel HTTP. */
  apiCall?: string;
  apiRoute?: string;
  responseProperty?: string;
  /** Champs d'où la valeur est calculée. */
  inputs?: string[];
  location: SourceLocation;
}

/**
 * Faits du code utiles à l'intelligence fonctionnelle (états métier, workflows,
 * invariants, chemins d'erreur) — lus dans le même passage sur l'AST, jamais exécutés.
 */
export interface StaticFunctionalFacts {
  /** enum / union de littéraux : les états possibles d'une entité, peut-être. */
  enums: { name: string; members: string[]; location: SourceLocation }[];
  /** Écritures HTTP (POST/PUT/PATCH/DELETE), leurs littéraux ({ status: 'APPROVED' }) et qui les appelle. */
  writes: {
    apiCall: string;
    owner: string;
    method: string;
    httpMethod: HttpMethod;
    route: string;
    literals: Record<string, string | number | boolean>;
    callers: { component: string; method: string }[];
    location: SourceLocation;
  }[];
  /** Gardes : « if (paid > total) throw », « if (status !== 'PENDING') return ». */
  guards: {
    owner: string;
    method: string;
    text: string;
    condition?: ApplicationRule['conditions'][number];
    exit: 'THROW' | 'RETURN' | 'ERROR' | 'NONE';
    location: SourceLocation;
  }[];
  /** Gestionnaires d'erreur d'API : statut / code attendu → champ en erreur, message. */
  errorHandlers: {
    owner: string;
    method: string;
    apiRoute?: string;
    status?: number;
    code?: string;
    control?: string;
    message?: string;
    location: SourceLocation;
  }[];
  /** Boutons du gabarit → méthode du composant, et quand ils sont affichés. */
  actions: {
    component: string;
    label: string;
    handler: string;
    conditions: ApplicationRule['conditions'];
    location: SourceLocation;
  }[];
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
  /** Valeurs initiales et affectations des contrôles (absent : analyse d'avant cette version). */
  valueSources?: StaticValueSource[];
  /** Règles candidates découvertes dans le code (STATIC_DISCOVERED jusqu'à preuve du runtime). */
  rules?: ApplicationRule[];
  /** Faits pour l'intelligence fonctionnelle (états, écritures, gardes, erreurs, boutons). */
  functionalFacts?: StaticFunctionalFacts;
  /** Conditions lues mais écartées : aucun effet fonctionnel (NOT_CLASSIFIED_AS_BUSINESS_RULE). */
  technicalConditions?: { component: string; text: string; location: SourceLocation }[];
  /** Limites rencontrées (budget, fichiers ignorés, UNRESOLVED_DATA_FLOW…), sans secret. */
  warnings: string[];
  stats: { files: number; bytes: number; durationMs: number };
  /** D'où vient chaque fichier lu (dépôt, source map, bundle) : chemins et empreintes, jamais le contenu. */
  sources?: StaticSourceProvenance[];
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
  /** D'où vient le code qui le prouve : « SOURCE_MAP main.js.map », « REPOSITORY »… */
  sourceOrigin?: string;
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
  /** D'où sont venues les sources : dépôt, source maps, bundles (jamais leur contenu). */
  discovery?: StaticSourceDiscoverySummary;
}
