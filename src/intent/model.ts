import type { EvidenceType } from '../cognitive/evidence.js';

/**
 * FUNCTIONAL INTENT — « element + contexte + action humaine + état → intention fonctionnelle ».
 *
 * Trois niveaux, toujours gardés ensemble et à côté de l'action brute (jamais à sa place) :
 *
 *   PHYSIQUE      ce que la main a fait            CLICK, FILL, SELECT, CHECK…
 *   UI            ce que l'interface a fait        OPEN_DIALOG, SELECT_TAB, SEARCH, SAVE, NEXT…
 *   FONCTIONNEL   ce que le métier a fait          opération × entité : SEARCH × item → SEARCH_ITEM
 *
 * L'intention fonctionnelle est un COUPLE opération × entité, jamais un nom métier codé en dur : les
 * entités viennent de ce que l'application montre (ressources d'API, routes, libellés), le vocabulaire
 * des opérations est le seul fixe. Une intention porte ses PREUVES, sa confiance, ses CANDIDATS
 * concurrents et son statut : un 0,51 n'est jamais « SEARCH », c'est AMBIGUOUS avec deux candidats.
 */
export const PHYSICAL_ACTIONS = [
  'CLICK',
  'FILL',
  'CLEAR',
  'SELECT',
  'CHECK',
  'UNCHECK',
  'SUBMIT',
  'NAVIGATE',
  'UPLOAD',
  'DRAG_AND_DROP',
  'CONFIRM',
  'CANCEL',
] as const;
export type PhysicalAction = (typeof PHYSICAL_ACTIONS)[number];

export const UI_INTENTS = [
  'OPEN_SECTION',
  'CLOSE_SECTION',
  'OPEN_MENU',
  'SELECT_TAB',
  'OPEN_DIALOG',
  'CLOSE_DIALOG',
  'CONFIRM',
  'CANCEL',
  'SEARCH',
  'FILTER',
  'SORT',
  'PAGINATE',
  'ADD',
  'REMOVE',
  'EDIT',
  'SAVE',
  'SUBMIT',
  'NEXT',
  'BACK',
  'SELECT_ITEM',
  'DESELECT_ITEM',
  'OPEN_ITEM',
  'ENTER_VALUE',
  'CHOOSE_OPTION',
  'TOGGLE',
  'NAVIGATE',
  'UPLOAD',
  'MOVE_ITEM',
  'LOGIN',
  'LOGOUT',
] as const;
export type UiIntent = (typeof UI_INTENTS)[number];

/** Les opérations métier : le seul vocabulaire fixe du niveau 3 (l'entité vient de l'application). */
export const FUNCTIONAL_OPERATIONS = [
  'CREATE',
  'SEARCH',
  'FILTER',
  'OPEN',
  'SELECT',
  'UPDATE',
  'SAVE',
  'SUBMIT',
  'DELETE',
  'TRANSITION',
  'NAVIGATE',
  'AUTHENTICATE',
] as const;
export type FunctionalOperation = (typeof FUNCTIONAL_OPERATIONS)[number];

/** L'entité générique quand l'application n'en nomme aucune (SEARCH_ENTITY). */
export const GENERIC_ENTITY = 'ENTITY';

export const INTENT_EVIDENCE_TYPES = [
  'LABEL',
  'ROLE',
  'INPUT_TYPE',
  'FORM_CONTEXT',
  'SECTION',
  'DIALOG',
  'TAB',
  'ROW',
  'ROUTE',
  'PREVIOUS_ACTION',
  'NEXT_ACTION',
  'FILLED_CRITERIA',
  'EFFECT_APPEARS',
  'EFFECT_DISAPPEARS',
  'EFFECT_ROUTE',
  'EFFECT_ROWS',
  'EFFECT_SELECTION',
  'EFFECT_DIALOG',
  'NETWORK_READ',
  'NETWORK_WRITE',
  'NETWORK_LIST',
  'NETWORK_STATE',
  'OPENAPI_OPERATION',
  'STATIC_SOURCE',
  'BUSINESS_LIFECYCLE',
  'BUSINESS_TRANSITION',
  'TEST_DATA',
  'HUMAN_DECISION',
  'HISTORY',
  'SAFETY_CLASSIFICATION',
] as const;
export type IntentEvidenceType = (typeof INTENT_EVIDENCE_TYPES)[number];

/** Une preuve d'intention : ce qui a été vu, d'où, avec quel poids (jamais une valeur saisie). */
export interface IntentEvidence {
  id: string;
  type: IntentEvidenceType;
  /** Le genre de preuve du moteur cognitif (plafond de confiance par type). */
  trust: EvidenceType;
  /** Texte court, en anglais, sans valeur saisie : « label "Search" », « GET /api/items → list ». */
  summary: string;
  /** Poids effectif (0..1) après le plafond de son type. */
  weight: number;
  /** Les candidats que cette preuve SOUTIENT (ui ou operation[:entity]). */
  supports: string[];
  /** Les candidats que cette preuve CONTREDIT. */
  contradicts?: string[];
}

export interface IntentCandidate {
  /** SEARCH_ITEM, OPEN_DIALOG… la clé lisible du candidat. */
  name: string;
  ui?: UiIntent;
  operation?: FunctionalOperation;
  entity?: string;
  confidence: number;
  /** Les preuves pour (ids). */
  evidenceIds: string[];
  /** Les preuves contre (ids). */
  contradictedBy: string[];
  explanation: string;
}

export type IntentStatus = 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNKNOWN';

/** Les signaux qui disent qu'une contradiction existe entre deux lectures des preuves. */
export interface IntentContradiction {
  id: string;
  summary: string;
  /** Les deux candidats qui s'opposent. */
  between: [string, string];
  /** Les preuves à l'origine de l'opposition. */
  evidenceIds: string[];
}

export interface IntentContext {
  route?: string;
  form?: string;
  section?: string;
  dialog?: string;
  tab?: string;
  row?: string;
  /** L'entité du contexte (ressource de la route ou de l'API), si l'application la nomme. */
  entity?: string;
}

export interface ExpectedIntentEffect {
  kind:
    | 'RESULTS_UPDATED'
    | 'ROWS_CHANGED'
    | 'NETWORK_REQUEST'
    | 'ROUTE_CHANGED'
    | 'DIALOG_OPENED'
    | 'DIALOG_CLOSED'
    | 'CONTROLS_APPEARED'
    | 'CONTROLS_DISAPPEARED'
    | 'SELECTION_CHANGED'
    | 'ENTITY_CREATED'
    | 'ENTITY_STATE_CHANGED';
  detail?: string;
}

/** Comment l'intention a été tranchée : les règles déterministes, un humain, ou l'IA parmi les candidats. */
export type IntentResolutionSource = 'DETERMINISTIC' | 'HUMAN_DECISION' | 'AI_ARBITER';

export interface FunctionalIntent {
  /** L'action (a3…) ou l'étape (s4…) dont c'est l'intention. */
  actionId: string;
  stepId?: string;
  physical: PhysicalAction;
  /** Niveau 2 : l'intention d'interface retenue, s'il y en a une. */
  ui?: UiIntent;
  /** Niveau 3 : opération × entité, s'il y en a une. */
  functional?: { operation: FunctionalOperation; entity: string; name: string };
  /** Le nom lisible retenu : fonctionnel si connu, sinon UI, sinon le physique. */
  name: string;
  subject?: { type?: string; semanticName?: string };
  target?: { role?: string; label?: string };
  context: IntentContext;
  expectedEffects: ExpectedIntentEffect[];
  evidence: IntentEvidence[];
  confidence: number;
  /** Tous les candidats, du meilleur au moins bon (le premier est celui retenu quand il y en a un). */
  alternatives: IntentCandidate[];
  contradictions: IntentContradiction[];
  status: IntentStatus;
  source: IntentResolutionSource;
  explanation: string;
}

/** Ce qui est écrit à côté de l'étape (YAML, rapport) : jamais les preuves entières, jamais une valeur. */
export interface StepIntentAnnotation {
  name: string;
  status: IntentStatus;
  confidence: number;
  ui?: UiIntent;
  operation?: FunctionalOperation;
  entity?: string;
  alternatives?: string[];
  context?: IntentContext;
  expectedEffects?: ExpectedIntentEffect['kind'][];
}

export interface IntentThresholds {
  /** ≥ : CONFIRMED. */
  confirmed: number;
  /** ≥ : PROBABLE (en dessous : AMBIGUOUS s'il y a des candidats, UNKNOWN sinon). */
  probable: number;
  /** Deux candidats dont l'écart est plus petit que cette marge : AMBIGUOUS, quelle que soit la confiance. */
  margin: number;
}

export const DEFAULT_INTENT_THRESHOLDS: IntentThresholds = { confirmed: 0.85, probable: 0.6, margin: 0.12 };

/** La forme générale d'une intention résolue : opération × ENTITY quand elle est fonctionnelle, sinon son nom. */
export function genericOf(intent: Pick<FunctionalIntent, 'name' | 'functional'>): string {
  return intent.functional ? functionalName(intent.functional.operation) : generalize(intent.name);
}

export function annotationOf(intent: FunctionalIntent): StepIntentAnnotation {
  const alternatives = intent.alternatives.slice(1, 4).map((candidate) => candidate.name);
  return {
    name: intent.name,
    status: intent.status,
    confidence: intent.confidence,
    ...(intent.ui ? { ui: intent.ui } : {}),
    ...(intent.functional
      ? { operation: intent.functional.operation, entity: intent.functional.entity }
      : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
    ...(Object.keys(intent.context).length > 0 ? { context: intent.context } : {}),
    ...(intent.expectedEffects.length > 0
      ? { expectedEffects: [...new Set(intent.expectedEffects.map((effect) => effect.kind))] }
      : {}),
  };
}

/** SEARCH × item → SEARCH_ITEM ; sans entité : SEARCH_ENTITY. */
export function functionalName(operation: FunctionalOperation, entity?: string): string {
  return `${operation}_${entityToken(entity)}`;
}

/** « work items » → WORK_ITEM ; vide → ENTITY. Jamais une valeur saisie : seulement un nom de ressource. */
export function entityToken(entity: string | undefined): string {
  const token = (entity ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!token) return GENERIC_ENTITY;
  return token.endsWith('S') && token.length > 3 ? token.slice(0, -1) : token;
}

/**
 * La forme GÉNÉRALISÉE d'une intention : SEARCH_ITEM → SEARCH_ENTITY (la bibliothèque réutilisable).
 * Un nom d'intention d'interface (OPEN_DIALOG) reste tel quel ; pour une intention résolue, préférer
 * `genericOf`, qui lit l'opération structurée (OPEN × item → OPEN_ENTITY, sans confusion de nom).
 */
export function generalize(name: string): string {
  if ((UI_INTENTS as readonly string[]).includes(name)) return name;
  const operation = FUNCTIONAL_OPERATIONS.find((candidate) => name.startsWith(`${candidate}_`));
  return operation ? functionalName(operation) : name;
}
