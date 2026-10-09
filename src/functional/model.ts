import { valueDigest } from '../forms/state/value-digest.js';
import type { SemanticEvidence, SourceLocation } from '../static-analysis/model.js';
import type { RuleCondition, RuleEffect } from '../static-analysis/rules/rule-model.js';

/**
 * INTELLIGENCE FONCTIONNELLE : ce que l'application FAIT, au-delà de ses écrans —
 * états métier et leurs transitions, workflows, invariants, effets secondaires,
 * chemins d'erreur, contrats observés, et les OBJECTIFS DE TEST qui en découlent.
 *
 *   Static suggests. History guides. Runtime confirms. Safety decides.
 *
 * Les conditions et effets réutilisent ceux du RuleGraph (RuleCondition, RuleEffect) ;
 * les preuves, SemanticEvidence. Rien n'est vrai au runtime sans observation.
 */

/** D'où vient une connaissance. */
export type KnowledgeOrigin =
  | 'STATIC_SOURCE'
  | 'SOURCE_MAP'
  | 'OPENAPI'
  | 'DOM'
  | 'NETWORK'
  | 'RUNTIME'
  | 'HISTORICAL'
  | 'GHERKIN'
  | 'FLOW_YAML';

export type KnowledgeStatus =
  'STATIC_DISCOVERED' | 'RUNTIME_OBSERVED' | 'RUNTIME_CONFIRMED' | 'RUNTIME_CONTRADICTED' | 'INCONCLUSIVE';

// ------------------------------------------------------------------ états métier

/** Un état du cycle de vie d'une entité (≠ un état d'écran du FlowGraph). */
export interface BusinessState {
  entityType: string;
  state: string;
  evidence: SemanticEvidence[];
  confidence: number;
  /** Vu à l'écran pendant ce run (badge, statut affiché). */
  observed: boolean;
}

export interface BusinessTransition {
  /** ENTITY:FROM>TO:trigger — stable. */
  id: string;
  entityType: string;
  /** « * » : état de départ inconnu (le code écrit l'état d'arrivée sans garde lisible). */
  from: string;
  to: string;
  /** Le verbe qui la déclenche (approve), et le libellé du bouton quand il est connu (Approve). */
  trigger?: string;
  triggerLabel?: string;
  /** L'appel d'API qui l'écrit (PATCH /api/registrations/{param}). */
  api?: string;
  preconditions?: RuleCondition[];
  postconditions?: RuleEffect[];
  evidence: SemanticEvidence[];
  status: KnowledgeStatus;
  /** Vue lors d'un run précédent (jamais une preuve pour ce run). */
  historical?: boolean;
  observations?: string[];
}

/** Une transition que l'application n'offre pas (bouton absent ou désactivé, refus attendu). */
export interface ForbiddenTransition {
  entityType: string;
  from: string;
  trigger: string;
  reason: string;
  evidence: SemanticEvidence[];
  status: 'STATIC_DISCOVERED' | 'RUNTIME_CONFIRMED';
}

export interface BusinessStateMachine {
  entityType: string;
  /** Le champ qui porte l'état (status). */
  stateField: string;
  states: BusinessState[];
  transitions: BusinessTransition[];
  forbidden: ForbiddenTransition[];
  evidence: SemanticEvidence[];
}

// ------------------------------------------------------------------ workflows

export type WorkflowStatus =
  'DISCOVERED' | 'PARTIALLY_VERIFIED' | 'VERIFIED' | 'FAILED' | 'INCONCLUSIVE' | 'BLOCKED_BY_POLICY';

export interface FunctionalStep {
  kind: 'NAVIGATE' | 'FILL' | 'CLICK' | 'API' | 'OBSERVE';
  description: string;
}

export interface FunctionalOutcome {
  kind: 'API' | 'STATE_CHANGE' | 'UI' | 'NAVIGATION' | 'ENTITY' | 'MESSAGE';
  description: string;
}

export interface FunctionalCondition {
  description: string;
  condition?: RuleCondition;
}

export interface FunctionalWorkflow {
  /** CREATE:USER, APPROVE:REGISTRATION — signature sémantique stable. */
  id: string;
  intent: string;
  entityType?: string;
  preconditions: FunctionalCondition[];
  steps: FunctionalStep[];
  expectedOutcomes: FunctionalOutcome[];
  evidence: SemanticEvidence[];
  status: WorkflowStatus;
  /** L'appel d'API qui le réalise. */
  api?: string;
  /** Libellé du bouton qui le déclenche, quand il est connu. */
  triggerLabel?: string;
  /** D'où vient le workflow : le code, appris du réseau pendant ce run, ou d'un run précédent. */
  origin?: 'STATIC' | 'RUNTIME_LEARNED' | 'HISTORICAL';
  /** Littéraux du corps écrits par le code ({ status: 'APPROVED' }) : distinguent les workflows d'une même API. */
  requestLiterals?: Record<string, string | number | boolean>;
  observations?: string[];
}

// ------------------------------------------------------------------ invariants

export type InvariantScope = 'FIELD' | 'FORM' | 'ENTITY' | 'WORKFLOW' | 'API' | 'GLOBAL';

export interface InvariantAssertion {
  kind: 'COMPARISON' | 'STATE' | 'DERIVED' | 'REQUIRED_WHEN';
  /** « paidAmount + amount <= totalAmount » */
  text: string;
  left?: string;
  operator?: string;
  right?: string;
  /** Champs ou propriétés concernés (index des invariants impactés). */
  fields: string[];
}

export type InvariantStatus =
  'STATIC_DISCOVERED' | 'RUNTIME_CONFIRMED' | 'RUNTIME_VIOLATED' | 'NOT_VERIFIED' | 'INCONCLUSIVE';

export interface ApplicationInvariant {
  id: string;
  scope: InvariantScope;
  entityType?: string;
  conditions?: RuleCondition[];
  assertion: InvariantAssertion;
  evidence: SemanticEvidence[];
  confidence: number;
  status: InvariantStatus;
  /** Règle (RuleGraph) ou transition dont il vient. */
  ruleId?: string;
  transitionId?: string;
  observations?: string[];
}

// ------------------------------------------------------------------ effets secondaires

export type SideEffectCategory =
  'API' | 'STATE_CHANGE' | 'UI' | 'NAVIGATION' | 'ENTITY' | 'NOTIFICATION' | 'CACHE' | 'OTHER';
export type SideEffectStatus =
  'EXPECTED' | 'OBSERVED' | 'CONFIRMED' | 'MISSING' | 'UNEXPECTED' | 'INCONCLUSIVE';

export interface ActionSideEffect {
  /** approve, CREATE:USER */
  actionIntent: string;
  category: SideEffectCategory;
  /** « status → APPROVED », « PATCH /api/registrations/{param} », « Approve unavailable » */
  expectedEffect: string;
  evidence: SemanticEvidence[];
  status: SideEffectStatus;
  observations?: string[];
}

// ------------------------------------------------------------------ chemins d'erreur

export type ErrorClass =
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_VALIDATION'
  | 'TECHNICAL'
  | 'OTHER';

export interface ErrorPath {
  id: string;
  /** Le workflow ou l'appel concerné (CREATE:USER, POST /api/users). */
  operation: string;
  httpStatus?: number;
  errorClass: ErrorClass;
  /** Code d'erreur métier (EMAIL_ALREADY_EXISTS), jamais un message libre de l'API. */
  businessCode?: string;
  /** Le champ marqué en erreur, le message affiché (texte de l'interface). */
  uiTarget?: string;
  uiMessage?: string;
  uiResult: 'FIELD_ERROR' | 'MESSAGE' | 'FIELD_ERROR_AND_MESSAGE' | 'NONE' | 'UNKNOWN';
  evidence: SemanticEvidence[];
  status: 'STATIC_DISCOVERED' | 'RUNTIME_OBSERVED' | 'RUNTIME_CONFIRMED';
}

// ------------------------------------------------------------------ contrat au runtime

export type ContractMismatchKind =
  | 'FIELD_NOT_SENT'
  | 'UNEXPECTED_FIELD'
  | 'TYPE_MISMATCH'
  | 'REQUIRED_FIELD_MISSING'
  | 'ENUM_MISMATCH'
  | 'NULLABILITY_MISMATCH'
  | 'UNEXPECTED_STATUS_CODE'
  | 'RESPONSE_SCHEMA_MISMATCH';

/** Un écart entre le contrat (OpenAPI), l'intention de l'interface et la requête réelle : jamais un bug par défaut. */
export interface ContractObservation {
  kind: ContractMismatchKind;
  /** CONTRACT_MISMATCH : le contrat peut être obsolète. */
  category: 'CONTRACT_MISMATCH';
  operation: string;
  field?: string;
  detail: string;
  evidence: SemanticEvidence[];
}

// ------------------------------------------------------------------ objectifs de test

export type TestGoalCategory =
  | 'RULE'
  | 'STATE_TRANSITION'
  | 'INVARIANT'
  | 'WORKFLOW'
  | 'SIDE_EFFECT'
  | 'ERROR_PATH'
  | 'CONTRACT'
  | 'PERMISSION';

export type TestGoalStatus =
  'CANDIDATE' | 'PLANNED' | 'RUNNING' | 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'INCONCLUSIVE';

export interface SemanticTarget {
  entityType?: string;
  field?: string;
  /** Le libellé de l'action qui réalise l'objectif (Approve). */
  actionLabel?: string;
  route?: string;
  api?: string;
}

export interface TestGoal {
  /** CATEGORY:signature — dédupliqué. */
  id: string;
  category: TestGoalCategory;
  intent: string;
  target?: SemanticTarget;
  preconditions: FunctionalCondition[];
  expectedOutcomes: FunctionalOutcome[];
  evidence: SemanticEvidence[];
  /** Calculés par goal-scoring.ts (un seul endroit). */
  priority: number;
  estimatedCost: number;
  /** 0 (aucun) … 1 (élevé). */
  risk: number;
  /** Attentes fonctionnelles nouvelles que l'objectif couvrirait. */
  coverageGain: number;
  status: TestGoalStatus;
  /** POURQUOI cet objectif : la connaissance dont il vient. */
  generatedFrom: string;
  /** La connaissance source (id de règle, de transition, d'invariant, de workflow). */
  sourceId: string;
  reason?: string;
  observations?: string[];
}

/** Un fait lu dans le code, pour les preuves. */
export function staticEvidence(
  detail: string,
  location?: SourceLocation,
  confidence = 0.75,
): SemanticEvidence {
  return {
    source: 'STATIC_CODE',
    kind: 'functional',
    value: detail,
    confidence,
    provenance: { ...(location ? { location } : {}), detail },
  };
}

export function runtimeEvidence(detail: string, confidence = 0.9): SemanticEvidence {
  return { source: 'RUNTIME', kind: 'functional', value: detail, confidence, provenance: { detail } };
}

/** registrations → REGISTRATION, Registration → REGISTRATION, RegistrationStatus → REGISTRATION */
export function entityName(text: string): string {
  const base = text
    .replace(/(Status|State|Statut|Etat)$/i, '')
    .replace(/(Service|Component|Controller|Api|Request|Dto|DTO|Model)$/, '');
  const snake = base
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  // Pluriel anglais simple (registrations, users, categories) ; « status » reste « status ».
  if (/IES$/.test(snake)) return snake.replace(/IES$/, 'Y');
  if (/(SS|US)$/.test(snake)) return snake;
  return snake.replace(/S$/, '');
}

/** L'entité d'une route d'API : /api/registrations/{param}/payments → REGISTRATION (premier segment nommé). */
export function entityOfRoute(route: string): string | undefined {
  const segments = route
    .split('?')[0]
    ?.split('/')
    .filter(
      (segment) => segment && !/^\{|^:/.test(segment) && !/^(api|v\d+|rest|public|internal)$/i.test(segment),
    );
  const first = segments?.[0];
  return first ? entityName(first) : undefined;
}

/** Verbes de transition, et leurs synonymes (libellés de boutons EN / FR). */
export const TRANSITION_VERBS: Record<string, readonly string[]> = {
  submit: ['submit', 'soumettre', 'send', 'envoyer', 'transmettre'],
  approve: ['approve', 'approuver', 'validate', 'valider', 'accept', 'accepter', 'confirm', 'confirmer'],
  reject: ['reject', 'rejeter', 'refuse', 'refuser', 'decline', 'decliner'],
  cancel: ['cancel', 'annuler', 'revoke', 'revoquer'],
  close: ['close', 'fermer', 'cloturer', 'complete', 'terminer'],
  reopen: ['reopen', 'rouvrir'],
  archive: ['archive', 'archiver'],
  activate: ['activate', 'activer', 'enable'],
  deactivate: ['deactivate', 'desactiver', 'disable', 'suspend', 'suspendre'],
  publish: ['publish', 'publier'],
  pay: ['pay', 'payer'],
};

/** Le verbe canonique d'un nom de méthode ou d'un libellé (« Approuver » → approve). */
export function verbOf(text: string): string | undefined {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const words = normalized.split(/[^a-z]+/).filter(Boolean);
  const camel = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/);
  for (const [verb, synonyms] of Object.entries(TRANSITION_VERBS))
    if (synonyms.some((synonym) => words.includes(synonym) || camel[0] === synonym)) return verb;
  return undefined;
}

// ------------------------------------------------------------------ observations du runtime

/** Forme d'une valeur JSON (jamais la valeur) ; digest : empreinte salée d'une chaîne, pour comparer à une énumération. */
export interface FieldShape {
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  digest?: string;
}

/** Un appel d'API vu pendant une action : méthode, chemin, statut, FORME des corps, code d'erreur métier. */
export interface FunctionalExchange {
  method: string;
  /** Chemin sans requête ni hôte (/api/registrations/12). */
  path: string;
  status?: number;
  requestFields?: Record<string, FieldShape>;
  responseFields?: Record<string, FieldShape>;
  /** EMAIL_ALREADY_EXISTS : un identifiant en capitales lu dans la réponse d'erreur, jamais un message libre. */
  errorCode?: string;
  /**
   * Code d'état métier (PENDING, APPROVED) d'une propriété status / state du corps envoyé
   * et de la réponse : un identifiant de l'application en capitales, jamais une valeur libre.
   */
  requestState?: StateCode;
  responseState?: StateCode;
  /**
   * Les IDENTIFIANTS de l'échange (réponse d'écriture, segment du chemin, en-tête Location) : une
   * empreinte salée — comparable à une saisie — et la valeur seulement si elle a la forme d'un
   * identifiant (nombre, code court), jamais celle d'une clé sensible.
   */
  identifiers?: ExchangeIdentifier[];
  /**
   * Une LECTURE réussie : les enregistrements servis (une liste d'un BFF, un détail), réduits à
   * leurs identifiants. Jamais un corps, jamais une valeur libre.
   */
  records?: ExchangeRecord[];
}

export interface ExchangeRecord {
  /** Sa place dans la liste servie. */
  index: number;
  /** La propriété qui portait la liste (items, data…), si elle était enveloppée. */
  container?: string;
  identifiers: ExchangeIdentifier[];
  state?: StateCode;
}

export interface ExchangeIdentifier {
  /** id, demandeId, data.reference, (path), (location). */
  field: string;
  digest: string;
  value?: string;
  source: 'response' | 'path' | 'location';
}

export interface StateCode {
  field: string;
  code: string;
}

/** Les propriétés qui portent un état métier : status, state, statut, etat, stage, lifecycle, …Status. */
export function isStateKey(key: string): boolean {
  return /^(status|state|statut|etat|stage|lifecycle)$/i.test(key) || /(Status|State|Statut)$/.test(key);
}

/** Un code d'état : un identifiant en capitales (PENDING, ECHEC_PARTIEL), jamais une saisie. */
export function isStateCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(value);
}

/** Ce que l'écran montre, réduit à ce que l'intelligence fonctionnelle compare. */
export interface ScreenFacts {
  url: string;
  route?: string;
  /** Titres et extrait visible (états affichés : badges, statuts). */
  text: string;
  buttons: { label: string; enabled: boolean }[];
  alerts: string[];
  /** Contrôles marqués invalides (formControlName ou nom). */
  invalidFields: string[];
  /** Contrôles présents (formControlName ou nom). */
  fields: string[];
  /** Listes déroulantes : le CODE de l'option choisie (jamais une saisie libre). */
  selections: Record<string, string>;
}

/** Une action exécutée, vue par l'intelligence fonctionnelle (avant / après, réseau). */
export interface FunctionalActionObservation {
  actionId: string;
  label: string;
  type: string;
  before?: ScreenFacts;
  after?: ScreenFacts;
  exchanges: FunctionalExchange[];
}

/** Un constat de l'analyse d'une action, lu par le SemanticFunctionalOracle. */
export interface FunctionalFinding {
  code:
    | 'EXPECTED_SIDE_EFFECT_MISSING'
    | 'EXPECTED_STATE_TRANSITION_MISSING'
    | 'EXPECTED_ENTITY_NOT_OBSERVED'
    | 'INVARIANT_VIOLATED'
    | 'CONTRACT_MISMATCH'
    | 'TRANSITION_CONFIRMED'
    | 'SIDE_EFFECT_CONFIRMED';
  message: string;
  /** WARNING : un écart à examiner ; PASS : une attente confirmée. */
  status: 'WARNING' | 'PASS';
}

/** Les verbes HTTP d'écriture → intention CRUD. */
export function crudVerb(httpMethod: string): string {
  const method = httpMethod.toUpperCase();
  return method === 'POST' ? 'CREATE' : method === 'DELETE' ? 'DELETE' : 'UPDATE';
}

/** PATCH /api/registrations/{param} correspond-il à PATCH /api/registrations/12 (base de l'API tolérée) ? */
export function apiMatches(api: string, method: string, path: string): boolean {
  const [apiMethod, template] = api.split(' ');
  if (!template || apiMethod?.toUpperCase() !== method.toUpperCase()) return false;
  const wanted = template.split('?')[0]?.split('/').filter(Boolean) ?? [];
  const actual = path.split('?')[0]?.split('/').filter(Boolean) ?? [];
  if (wanted.length === 0 || actual.length < wanted.length) return false;
  const tail = actual.slice(actual.length - wanted.length);
  return wanted.every((segment, index) => /^[{:]/.test(segment) || segment === tail[index]);
}

/** « Approve », « approve » et « APPROVE » se valent ; les espaces aussi. */
export function sameLabel(a: string, b: string): boolean {
  const normalize = (text: string): string =>
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  return normalize(a) === normalize(b);
}

/**
 * Les littéraux du code ({ status: 'APPROVED' }) correspondent-ils au corps envoyé ?
 * Comparés par empreinte salée : la valeur envoyée n'est jamais lue en clair. Sans
 * empreinte (pas de corps JSON), on ne peut pas distinguer : vrai.
 */
export function literalsMatch(
  literals: Record<string, string | number | boolean> | undefined,
  exchange: FunctionalExchange,
  salt: string | undefined,
): boolean {
  if (!literals || salt === undefined) return true;
  for (const [field, value] of Object.entries(literals)) {
    if (typeof value !== 'string') continue;
    const digest = exchange.requestFields?.[field]?.digest;
    if (digest !== undefined && digest !== valueDigest(value, salt)) return false;
  }
  return true;
}
