import { EVIDENCE_TRUST, type EvidenceType } from '../cognitive/evidence.js';
import type { FunctionalExchange } from '../functional/model.js';
import type { RememberedIntentDecision } from '../knowledge/functional-knowledge-store.js';
import {
  DETAILS_KEYWORDS,
  FILTER_KEYWORDS,
  normalizeText,
  PAGINATION_KEYWORDS,
  SEARCH_KEYWORDS,
  STEP_KEYWORDS,
  SUBMIT_KEYWORDS,
} from '../policies/keywords.js';
import { technicalCategoryOf } from '../recording/business/entity-classifier.js';
import type { LifecycleKind } from '../recording/business/entity-tracker.js';
import {
  collectionOf,
  hasPathId,
  identityInPath,
  queryEvidenceOf,
  routePattern,
  WRITE,
} from '../recording/business/signals.js';
import type { RecordedState, SemanticRecordedAction } from '../recording/model.js';
import {
  type FunctionalOperation,
  type IntentContext,
  type IntentEvidence,
  type IntentEvidenceType,
  type UiIntent,
} from './model.js';

/**
 * INTENT EVIDENCE ENGINE : rassemble, pour UNE action, tout ce qui peut dire son intention, et le
 * type (DOM, ARIA, contexte structurel, actions voisines, effets observés, réseau, cycle de vie des
 * entités, décision humaine, historique, contrat). Chaque preuve dit QUELS candidats elle soutient
 * (« ui:SEARCH », « op:SEARCH », « op:SEARCH:item ») et lesquels elle contredit ; le résolveur
 * combine. Aucune valeur saisie n'entre ici : des libellés, des rôles, des formes de requête.
 */

/** Une étape du cycle de vie d'une entité attribuée à cette action (business/entity-tracker). */
export interface ActionLifecycle {
  entityType: string;
  kind: LifecycleKind;
  confidence: number;
  /** L'entité a été prouvée comme créée pendant l'enregistrement. */
  createdDuringRecording?: boolean;
}

/** Un indice appris d'enregistrements précédents (bibliothèque d'intentions). */
export interface IntentHistoryHint {
  /** La clé observée (libellé normalisé + forme d'API). */
  key: string;
  intent: string;
  /** Combien de fois cette association a été confirmée. */
  confirmations: number;
}

/** Ce qu'un contrat OpenAPI dit d'une requête (operationId, résumé) : une suggestion. */
export interface ContractHint {
  operationId?: string;
  summary?: string;
}

export interface IntentEvidenceInput {
  action: SemanticRecordedAction;
  previous: readonly SemanticRecordedAction[];
  next: readonly SemanticRecordedAction[];
  stateBefore?: RecordedState;
  stateAfter?: RecordedState;
  lifecycle?: readonly ActionLifecycle[];
  decisions?: readonly RememberedIntentDecision[];
  history?: readonly IntentHistoryHint[];
  contract?: (exchange: FunctionalExchange) => ContractHint | undefined;
}

export interface CollectedIntentEvidence {
  evidence: IntentEvidence[];
  context: IntentContext;
  /** L'entité la plus probable (cycle de vie, réseau, route), si l'application la nomme. */
  entity?: string;
}

const UI = (intent: UiIntent): string => `ui:${intent}`;
const OP = (operation: FunctionalOperation, entity?: string): string =>
  entity ? `op:${operation}:${entity}` : `op:${operation}`;

/** Le vocabulaire des libellés : chaque famille soutient des intentions d'interface. */
const LABEL_FAMILIES: readonly {
  words: readonly string[];
  supports: UiIntent[];
  contradicts?: UiIntent[];
}[] = [
  { words: SEARCH_KEYWORDS, supports: ['SEARCH'], contradicts: ['SAVE', 'CANCEL', 'BACK'] },
  { words: FILTER_KEYWORDS, supports: ['FILTER', 'SORT'] },
  {
    words: PAGINATION_KEYWORDS.filter((word) => !STEP_KEYWORDS.includes(word as never)),
    supports: ['PAGINATE'],
  },
  { words: ['next', 'next step', 'continue', 'suivant', 'etape suivante', 'continuer'], supports: ['NEXT'] },
  {
    words: ['previous', 'back', 'precedent', 'etape precedente', 'retour'],
    supports: ['BACK'],
    contradicts: ['SUBMIT', 'SAVE'],
  },
  {
    words: ['save', 'enregistrer', 'sauvegarder', 'sauver', 'update', 'mettre a jour'],
    supports: ['SAVE'],
    contradicts: ['SEARCH', 'CANCEL'],
  },
  {
    words: SUBMIT_KEYWORDS.filter(
      (word) => !['save', 'enregistrer', 'sauvegarder', 'add', 'ajouter', 'create', 'creer'].includes(word),
    ),
    supports: ['SUBMIT', 'CONFIRM'],
    contradicts: ['CANCEL', 'SEARCH'],
  },
  { words: ['add', 'new', 'create', 'ajouter', 'nouveau', 'nouvelle', 'nouvel', 'creer'], supports: ['ADD'] },
  {
    words: ['delete', 'remove', 'supprimer', 'retirer', 'effacer'],
    supports: ['REMOVE'],
    contradicts: ['SAVE', 'SEARCH'],
  },
  { words: ['edit', 'modify', 'modifier', 'editer'], supports: ['EDIT'] },
  {
    words: ['cancel', 'close', 'annuler', 'fermer', 'abandonner'],
    supports: ['CANCEL', 'CLOSE_DIALOG'],
    contradicts: ['SUBMIT', 'SAVE'],
  },
  { words: ['ok', 'yes', 'confirm', 'confirmer', 'accept', 'accepter'], supports: ['CONFIRM'] },
  { words: DETAILS_KEYWORDS, supports: ['OPEN_ITEM', 'OPEN_SECTION'] },
  { words: ['login', 'log in', 'sign in', 'se connecter', 'connexion', 'connecter'], supports: ['LOGIN'] },
  { words: ['logout', 'log out', 'sign out', 'se deconnecter', 'deconnexion'], supports: ['LOGOUT'] },
  { words: ['menu', 'options', 'actions', 'more actions', 'plus d actions'], supports: ['OPEN_MENU'] },
];

/** Les opérations métier que suggère une intention d'interface (jamais une certitude). */
export const UI_TO_OPERATION: Partial<Record<UiIntent, FunctionalOperation>> = {
  SEARCH: 'SEARCH',
  FILTER: 'FILTER',
  SAVE: 'SAVE',
  SUBMIT: 'SUBMIT',
  ADD: 'CREATE',
  REMOVE: 'DELETE',
  EDIT: 'UPDATE',
  OPEN_ITEM: 'OPEN',
  SELECT_ITEM: 'SELECT',
  LOGIN: 'AUTHENTICATE',
  LOGOUT: 'AUTHENTICATE',
  NAVIGATE: 'NAVIGATE',
};

const LIFECYCLE_OPERATION: Partial<Record<LifecycleKind, FunctionalOperation>> = {
  CREATE: 'CREATE',
  SEARCH: 'SEARCH',
  RETRIEVE: 'SEARCH',
  OPEN: 'OPEN',
  UPDATE: 'UPDATE',
  SAVE: 'SAVE',
  DELETE: 'DELETE',
};

const FIELD_ACTIONS = new Set<SemanticRecordedAction['type']>([
  'FILL',
  'SELECT',
  'CHECK',
  'UNCHECK',
  'UPLOAD',
]);

function wordsOf(text: string): Set<string> {
  const normalized = normalizeText(text);
  const words = new Set(normalized.split(' ').filter(Boolean));
  words.add(normalized);
  // Les bigrammes (« next step », « log in »).
  const parts = normalized.split(' ');
  for (let index = 0; index + 1 < parts.length; index += 1)
    words.add(`${parts[index] ?? ''} ${parts[index + 1] ?? ''}`);
  return words;
}

export function collectIntentEvidence(input: IntentEvidenceInput): CollectedIntentEvidence {
  const { action } = input;
  const evidence: IntentEvidence[] = [];
  const add = (
    type: IntentEvidenceType,
    trust: EvidenceType,
    confidence: number,
    summary: string,
    supports: string[],
    contradicts: string[] = [],
  ): void => {
    const weight = Math.round(Math.max(0, Math.min(1, confidence)) * EVIDENCE_TRUST[trust] * 1000) / 1000;
    evidence.push({
      id: `ie${String(evidence.length + 1)}`,
      type,
      trust,
      summary,
      weight,
      supports,
      ...(contradicts.length > 0 ? { contradicts } : {}),
    });
  };
  const fingerprint = action.target?.fingerprint;
  const label = action.target?.label ?? '';
  const role = fingerprint?.role ?? action.target?.target.role;
  const context: IntentContext = {};
  const routeBefore = input.stateBefore?.route ?? action.preActionRoute;
  if (routeBefore) context.route = routeBefore;
  if (fingerprint?.form) context.form = fingerprint.form;
  if (fingerprint?.section) context.section = fingerprint.section;
  if (fingerprint?.dialog) context.dialog = fingerprint.dialog;
  if (fingerprint?.tab) context.tab = fingerprint.tab;
  if (fingerprint?.row) context.row = fingerprint.row;
  const entities = new Map<string, number>();
  const nameEntity = (entity: string | undefined, weight: number): void => {
    if (!entity) return;
    entities.set(entity, (entities.get(entity) ?? 0) + weight);
  };

  // ---------------------------------------------------------------- 1. ce que dit l'élément lui-même
  if (label && action.target?.named) {
    const words = wordsOf(label);
    for (const family of LABEL_FAMILIES) {
      const hit = family.words.find((word) => words.has(normalizeText(word)));
      if (!hit) continue;
      add(
        'LABEL',
        'ACCESSIBILITY',
        0.7,
        `label "${clip(label)}" says ${family.supports.join('/')}`,
        family.supports.map(UI),
        (family.contradicts ?? []).map(UI),
      );
    }
  }
  if (role) {
    const byRole: Partial<Record<string, UiIntent[]>> = {
      tab: ['SELECT_TAB'],
      menuitem: ['OPEN_MENU', 'NAVIGATE'],
      checkbox: ['SELECT_ITEM', 'TOGGLE'],
      radio: ['CHOOSE_OPTION'],
      switch: ['TOGGLE'],
      link: ['NAVIGATE', 'OPEN_ITEM'],
      combobox: ['CHOOSE_OPTION'],
      listbox: ['CHOOSE_OPTION'],
      option: ['CHOOSE_OPTION'],
      textbox: ['ENTER_VALUE'],
      searchbox: ['ENTER_VALUE', 'SEARCH'],
      row: ['OPEN_ITEM', 'SELECT_ITEM'],
      gridcell: ['OPEN_ITEM', 'SELECT_ITEM'],
    };
    const supports = byRole[role];
    if (supports) add('ROLE', 'ACCESSIBILITY', 0.55, `role ${role}`, supports.map(UI));
  }
  if (fingerprint?.inputType === 'search')
    add('INPUT_TYPE', 'DOM', 0.8, 'input type search', [UI('ENTER_VALUE'), UI('SEARCH')]);
  if (fingerprint?.inputType === 'submit') add('INPUT_TYPE', 'DOM', 0.7, 'input type submit', [UI('SUBMIT')]);

  // ---------------------------------------------------------------- 2. le contexte structurel
  if (fingerprint?.row) {
    add('ROW', 'DOM', 0.6, `inside a row (${clip(fingerprint.row)})`, [UI('OPEN_ITEM'), UI('SELECT_ITEM')]);
    if (action.type === 'CHECK')
      add('ROW', 'DOM', 0.8, 'a checkbox inside a row', [UI('SELECT_ITEM'), OP('SELECT')], [UI('TOGGLE')]);
    if (action.type === 'UNCHECK')
      add('ROW', 'DOM', 0.8, 'a checkbox inside a row, unchecked', [UI('DESELECT_ITEM')], [UI('TOGGLE')]);
  }
  if (fingerprint?.dialog || (input.stateBefore?.dialogs.length ?? 0) > 0) {
    const name = fingerprint?.dialog ?? input.stateBefore?.dialogs[0] ?? '';
    add(
      'DIALOG',
      'DOM',
      0.5,
      `inside the dialog "${clip(name)}"`,
      [UI('CONFIRM'), UI('CANCEL'), UI('CLOSE_DIALOG')],
      [UI('OPEN_DIALOG')],
    );
  }
  if (fingerprint?.form)
    add('FORM_CONTEXT', 'DOM', 0.5, `inside the form "${clip(fingerprint.form)}"`, [
      UI('SUBMIT'),
      UI('SAVE'),
      UI('SEARCH'),
    ]);
  if (fingerprint?.section)
    add(
      'SECTION',
      'DOM',
      0.3,
      `section "${clip(fingerprint.section)}"`,
      sectionSupports(fingerprint.section),
    );
  if (fingerprint?.tab) add('TAB', 'DOM', 0.2, `in tab "${clip(fingerprint.tab)}"`, []);
  const routeResource = routeBefore ? identityInPath(routeBefore)?.resource : undefined;
  if (routeResource) {
    nameEntity(routeResource, 0.3);
    context.entity = routeResource;
  }

  // ---------------------------------------------------------------- 3. les actions voisines
  const sameScreen = (other: SemanticRecordedAction): boolean =>
    other.stateBefore === undefined ||
    action.stateBefore === undefined ||
    other.stateBefore === action.stateBefore;
  const filledBefore = [...input.previous]
    .reverse()
    .filter((other) => FIELD_ACTIONS.has(other.type) && sameScreen(other));
  if (action.type === 'CLICK' || action.type === 'SUBMIT') {
    if (filledBefore.length > 0) {
      const labels = filledBefore
        .map((other) => other.target?.label)
        .filter((text): text is string => !!text)
        .slice(0, 4)
        .map(clip);
      const many = filledBefore.length >= 3;
      add(
        'FILLED_CRITERIA',
        'RUNTIME',
        many ? 0.6 : 0.5,
        `${String(filledBefore.length)} field(s) set just before (${labels.join(', ')})`,
        many
          ? [UI('SUBMIT'), UI('SAVE'), OP('CREATE'), OP('SAVE'), OP('SUBMIT')]
          : [UI('SEARCH'), UI('FILTER'), UI('SUBMIT'), UI('SAVE')],
        [UI('NAVIGATE'), UI('OPEN_MENU'), UI('SELECT_TAB')],
      );
    }
    const previousClick = input.previous.at(-1);
    if (
      previousClick &&
      previousClick.type === 'CLICK' &&
      filledBefore.length === 0 &&
      (input.stateBefore?.dialogs.length ?? 0) === 0
    )
      add(
        'PREVIOUS_ACTION',
        'RUNTIME',
        0.2,
        `follows the click "${clip(previousClick.target?.label ?? '')}"`,
        [],
      );
  }
  const nextFields = takeWhile(input.next, (other) => FIELD_ACTIONS.has(other.type));
  const firstNext = input.next[0];
  if (nextFields.length > 0 && !FIELD_ACTIONS.has(action.type))
    add(
      'NEXT_ACTION',
      'RUNTIME',
      0.55,
      `the next ${String(nextFields.length)} action(s) fill fields that this one made available`,
      [UI('OPEN_DIALOG'), UI('OPEN_SECTION'), UI('EDIT'), UI('ADD'), UI('SELECT_TAB'), UI('NEXT')],
      [UI('SUBMIT'), UI('SAVE'), UI('CANCEL')],
    );
  if (firstNext && (action.type === 'CLICK' || action.type === 'SUBMIT')) {
    const nextRow = firstNext.target?.fingerprint?.row;
    const nextRole = firstNext.target?.fingerprint?.role ?? firstNext.target?.target.role;
    if (nextRow || nextRole === 'row' || nextRole === 'gridcell' || (firstNext.type === 'CHECK' && nextRow))
      add(
        'NEXT_ACTION',
        'RUNTIME',
        0.6,
        `the next action picks an item in a list ("${clip(firstNext.target?.label ?? '')}")`,
        [UI('SEARCH'), UI('FILTER'), OP('SEARCH')],
        [UI('SAVE'), UI('CANCEL')],
      );
    if (firstNext.type === 'CONFIRM' || firstNext.type === 'CANCEL')
      add('NEXT_ACTION', 'RUNTIME', 0.6, `the next action answers a dialog (${firstNext.type})`, [
        UI('OPEN_DIALOG'),
      ]);
  }

  // ---------------------------------------------------------------- 4. les effets observés
  const dialogsBefore = input.stateBefore?.dialogs.length ?? 0;
  const dialogsAfter = input.stateAfter?.dialogs.length ?? dialogsBefore;
  if (dialogsAfter > dialogsBefore)
    add(
      'EFFECT_DIALOG',
      'RUNTIME',
      0.9,
      `a dialog opened ("${clip(input.stateAfter?.dialogs[0] ?? '')}")`,
      [UI('OPEN_DIALOG')],
      [UI('NAVIGATE'), UI('SEARCH')],
    );
  if (dialogsAfter < dialogsBefore)
    add(
      'EFFECT_DIALOG',
      'RUNTIME',
      0.8,
      'the dialog closed',
      [UI('CONFIRM'), UI('CANCEL'), UI('CLOSE_DIALOG')],
      [UI('OPEN_DIALOG')],
    );
  const rowsBefore = input.stateBefore?.tableRows;
  const rowsAfter = input.stateAfter?.tableRows;
  if (
    rowsBefore !== undefined &&
    rowsAfter !== undefined &&
    rowsBefore !== rowsAfter &&
    !FIELD_ACTIONS.has(action.type)
  )
    add(
      'EFFECT_ROWS',
      'RUNTIME',
      0.6,
      `the list changed (${String(rowsBefore)} → ${String(rowsAfter)} rows)`,
      [UI('SEARCH'), UI('FILTER'), UI('PAGINATE'), UI('SORT'), OP('SEARCH')],
      [UI('OPEN_DIALOG'), UI('NAVIGATE')],
    );
  const routeAfter = action.navigation?.routes.at(-1) ?? input.stateAfter?.route;
  if (routeAfter && routeBefore && routeAfter !== routeBefore && action.type !== 'NAVIGATE') {
    const target = identityInPath(routeAfter);
    const idRoute = target !== undefined || hasPathId(routeAfter);
    nameEntity(target?.resource, 0.4);
    add(
      'EFFECT_ROUTE',
      'RUNTIME',
      0.8,
      `the route changed to ${routeAfter.split('?')[0] ?? routeAfter}`,
      idRoute
        ? [UI('OPEN_ITEM'), OP('OPEN', target?.resource), UI('NAVIGATE')]
        : [UI('NAVIGATE'), UI('NEXT'), UI('BACK'), UI('SELECT_TAB')],
      [UI('OPEN_DIALOG'), UI('SELECT_ITEM')],
    );
  }
  const appears = action.expectedEffects?.appears ?? [];
  const disappears = action.expectedEffects?.disappears ?? [];
  if (appears.length > 0 && !FIELD_ACTIONS.has(action.type)) {
    const fields = appears.filter((control) =>
      /^(textbox|combobox|checkbox|radio|searchbox|spinbutton|listbox):/i.test(control),
    ).length;
    add(
      'EFFECT_APPEARS',
      'RUNTIME',
      0.5,
      `${String(appears.length)} control(s) appeared${fields > 0 ? ` (${String(fields)} field(s))` : ''}`,
      fields > 0
        ? [UI('OPEN_SECTION'), UI('OPEN_DIALOG'), UI('EDIT'), UI('ADD')]
        : [UI('OPEN_SECTION'), UI('OPEN_MENU'), UI('SELECT_TAB')],
    );
  }
  if (disappears.length > 0 && appears.length === 0 && !FIELD_ACTIONS.has(action.type))
    add('EFFECT_DISAPPEARS', 'RUNTIME', 0.35, `${String(disappears.length)} control(s) disappeared`, [
      UI('CLOSE_SECTION'),
      UI('REMOVE'),
      UI('CANCEL'),
      UI('SUBMIT'),
    ]);
  if (action.type === 'CHECK' && fingerprint?.expectedState === 'checked')
    add('EFFECT_SELECTION', 'RUNTIME', 0.6, 'the checkbox is now checked', [UI('SELECT_ITEM'), UI('TOGGLE')]);
  if (action.drag)
    add(
      'EFFECT_APPEARS',
      'RUNTIME',
      0.9,
      action.drag.moved ? 'the item moved to the destination' : 'the item was dragged',
      [UI('MOVE_ITEM')],
    );

  // ---------------------------------------------------------------- 5. le réseau
  for (const exchange of action.network) {
    const method = exchange.method.toUpperCase();
    const status = exchange.status;
    const failed = status !== undefined && status >= 400;
    const technical = technicalCategoryOf(`${method} ${exchange.path}`);
    if (technical) {
      const auth = technical.category === 'AUTHENTICATION' || technical.category === 'DISCOVERY';
      add(
        'NETWORK_STATE',
        'NETWORK',
        auth ? 0.7 : 0.2,
        `${method} ${routeOf(exchange.path)} is ${technical.intent}`,
        auth ? [OP('AUTHENTICATE'), UI(technical.intent === 'LOGOUT' ? 'LOGOUT' : 'LOGIN')] : [],
        auth ? [OP('CREATE'), OP('SEARCH')] : [],
      );
      continue;
    }
    const resource = collectionOf(exchange.path);
    const contract = input.contract?.(exchange);
    if (contract) {
      const hinted = contractOperation(contract);
      if (hinted)
        add(
          'OPENAPI_OPERATION',
          'OPENAPI',
          0.6,
          `contract ${contract.operationId ?? contract.summary ?? ''} suggests ${hinted}`,
          [OP(hinted, resource)],
        );
    }
    if (WRITE.has(method)) {
      if (failed) {
        add(
          'NETWORK_WRITE',
          'NETWORK',
          0.5,
          `${method} ${routeOf(exchange.path)} was refused (${String(status)})`,
          [UI('SUBMIT'), UI('SAVE')],
          [UI('SEARCH'), UI('NAVIGATE')],
        );
        continue;
      }
      const item = identityInPath(exchange.path);
      const itemResource = item?.resource ?? resource;
      nameEntity(itemResource, 0.6);
      const stateBefore = exchange.requestState?.code;
      const stateAfter = exchange.responseState?.code;
      const transition = stateAfter !== undefined && stateAfter !== stateBefore;
      if (method === 'DELETE')
        add(
          'NETWORK_WRITE',
          'NETWORK',
          0.9,
          `DELETE ${routeOf(exchange.path)}`,
          [OP('DELETE', itemResource), UI('REMOVE')],
          [OP('CREATE'), OP('SEARCH'), UI('SAVE')],
        );
      else if (method === 'POST' && !item && !hasPathId(exchange.path) && !isQuery(exchange))
        add(
          'NETWORK_WRITE',
          'NETWORK',
          0.8,
          `POST ${routeOf(exchange.path)} created (${String(status ?? '2xx')})`,
          [OP('CREATE', resource), UI('SUBMIT'), UI('SAVE')],
          [OP('SEARCH'), UI('SEARCH'), UI('CANCEL')],
        );
      else if (isQuery(exchange))
        add(
          'NETWORK_LIST',
          'NETWORK',
          0.75,
          `${method} ${routeOf(exchange.path)} answered a collection: a search`,
          [OP('SEARCH', resource), UI('SEARCH'), UI('FILTER')],
          [OP('CREATE'), UI('SAVE')],
        );
      else if (transition)
        add(
          'NETWORK_STATE',
          'NETWORK',
          0.85,
          `${method} ${routeOf(exchange.path)} moved the state to ${stateAfter}`,
          [OP('SUBMIT', itemResource), OP('TRANSITION', itemResource), UI('SUBMIT')],
          [OP('SEARCH'), UI('SEARCH'), OP('CREATE')],
        );
      else if (method === 'POST' && item)
        add(
          'NETWORK_WRITE',
          'NETWORK',
          0.7,
          `POST ${routeOf(exchange.path)} acted on one item`,
          [OP('SUBMIT', itemResource), OP('UPDATE', itemResource), UI('SUBMIT'), UI('CONFIRM')],
          [OP('SEARCH'), UI('SEARCH'), OP('CREATE')],
        );
      else
        add(
          'NETWORK_WRITE',
          'NETWORK',
          0.75,
          `${method} ${routeOf(exchange.path)} updated`,
          [OP('UPDATE', itemResource), OP('SAVE', itemResource), UI('SAVE'), UI('SUBMIT')],
          [OP('SEARCH'), UI('SEARCH'), UI('CANCEL'), OP('CREATE')],
        );
      continue;
    }
    if (failed) continue;
    if (isQuery(exchange)) {
      nameEntity(resource, 0.5);
      const assessment = queryEvidenceOf({
        method,
        ...(status !== undefined ? { status } : {}),
        ...(exchange.records ? { records: exchange.records } : {}),
        ...(exchange.identifiers ? { identifiers: exchange.identifiers } : {}),
      });
      add(
        'NETWORK_LIST',
        'NETWORK',
        Math.max(0.5, assessment.confidence),
        `GET ${routeOf(exchange.path)} answered a collection (${String(exchange.records?.length ?? 0)} record(s))`,
        [OP('SEARCH', resource), UI('SEARCH'), UI('FILTER'), UI('PAGINATE')],
        [OP('CREATE'), UI('SAVE'), UI('CANCEL')],
      );
    } else if (hasPathId(exchange.path) || identityInPath(exchange.path)) {
      const resourceOfItem = identityInPath(exchange.path)?.resource ?? resource;
      nameEntity(resourceOfItem, 0.4);
      add(
        'NETWORK_READ',
        'NETWORK',
        0.6,
        `GET ${routeOf(exchange.path)} read one item`,
        [OP('OPEN', resourceOfItem), UI('OPEN_ITEM')],
        [OP('CREATE')],
      );
    } else
      add('NETWORK_READ', 'NETWORK', 0.25, `GET ${routeOf(exchange.path)}`, [
        UI('NAVIGATE'),
        UI('OPEN_SECTION'),
        UI('SELECT_TAB'),
      ]);
  }

  // ---------------------------------------------------------------- 6. le cycle de vie des entités (couche métier)
  for (const step of input.lifecycle ?? []) {
    const operation = LIFECYCLE_OPERATION[step.kind];
    if (!operation) continue;
    if (operation === 'CREATE' && !step.createdDuringRecording) continue;
    nameEntity(step.entityType === 'unknown' ? undefined : step.entityType, 0.8);
    add(
      'BUSINESS_LIFECYCLE',
      'RUNTIME',
      Math.max(0.5, step.confidence),
      `entity lifecycle: ${step.kind} ${step.entityType}`,
      [
        OP(operation, step.entityType === 'unknown' ? undefined : step.entityType),
        ...(uiOfOperation(operation) ?? []).map(UI),
      ],
      operation === 'SEARCH'
        ? [OP('CREATE'), UI('SAVE')]
        : operation === 'CREATE'
          ? [OP('SEARCH'), UI('SEARCH')]
          : [],
    );
  }

  // ---------------------------------------------------------------- 7. décision humaine et historique
  for (const decision of input.decisions ?? []) {
    if (!matchesDecision(decision, action, routeBefore)) continue;
    const intent = decision.intent;
    const key = intent.startsWith('op:') || intent.startsWith('ui:') ? intent : intentKeyOf(intent);
    add(
      'HUMAN_DECISION',
      'HUMAN_RECORDING',
      decision.status === 'HUMAN_CORRECTED' ? 1 : 0.95,
      `human ${decision.status === 'HUMAN_CORRECTED' ? 'corrected' : 'confirmed'} this element as ${intent} on this screen`,
      [key],
    );
  }
  const historyKey = historyKeyOf(action);
  for (const hint of input.history ?? []) {
    if (hint.key !== historyKey) continue;
    const key =
      hint.intent.startsWith('op:') || hint.intent.startsWith('ui:') ? hint.intent : intentKeyOf(hint.intent);
    add(
      'HISTORY',
      'HISTORICAL',
      Math.min(0.9, 0.4 + hint.confirmations * 0.1),
      `seen ${String(hint.confirmations)} time(s) before as ${hint.intent}`,
      [key],
    );
  }

  // ---------------------------------------------------------------- 8. la classification de sécurité
  if (action.classification === 'MUTATION' && (action.type === 'CLICK' || action.type === 'SUBMIT'))
    add(
      'SAFETY_CLASSIFICATION',
      'RUNTIME',
      0.3,
      'classified MUTATION by the safety policy',
      [UI('SUBMIT'), UI('SAVE')],
      [UI('NAVIGATE'), UI('SELECT_TAB')],
    );
  if (action.classification === 'DANGEROUS')
    add('SAFETY_CLASSIFICATION', 'RUNTIME', 0.4, 'classified DANGEROUS by the safety policy', [
      UI('REMOVE'),
      OP('DELETE'),
    ]);

  const entity = [...entities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (entity && !context.entity) context.entity = entity;
  return { evidence, context, ...(entity ? { entity } : {}) };
}

/**
 * La clé d'une action dans la BIBLIOTHÈQUE D'INTENTIONS : geste + libellé normalisé + forme des
 * requêtes (méthode + gabarit de chemin). Jamais une valeur saisie. La généralisation se fait sur
 * l'intention (SEARCH_ITEM → SEARCH_ENTITY), pas sur la clé.
 */
export function historyKeyOf(action: SemanticRecordedAction): string {
  const label = normalizeText(action.target?.label ?? action.type);
  const shapes = [
    ...new Set(
      action.network.map((exchange) => `${exchange.method.toUpperCase()} ${routePattern(exchange.path, 4)}`),
    ),
  ].sort();
  return `${action.type}|${label}|${shapes.join(',')}`;
}

/** « CREATE_ITEM » → « op:CREATE:item » ; « OPEN_DIALOG » → « ui:OPEN_DIALOG » ; un libellé inconnu reste tel quel. */
export function intentKeyOf(name: string): string {
  const upper = name.toUpperCase();
  const ui = (
    [
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
    ] as const
  ).find((candidate) => candidate === upper);
  if (ui) return `ui:${ui}`;
  const match = /^([A-Z]+)(?:_(.+))?$/.exec(upper);
  if (!match) return name;
  const operation = match[1] ?? '';
  const entity = match[2];
  return entity && entity !== 'ENTITY' ? `op:${operation}:${entity.toLowerCase()}` : `op:${operation}`;
}

export function uiOfOperation(operation: FunctionalOperation): UiIntent[] | undefined {
  const map: Partial<Record<FunctionalOperation, UiIntent[]>> = {
    CREATE: ['SUBMIT', 'SAVE'],
    SEARCH: ['SEARCH'],
    FILTER: ['FILTER'],
    OPEN: ['OPEN_ITEM'],
    SELECT: ['SELECT_ITEM'],
    UPDATE: ['SAVE'],
    SAVE: ['SAVE'],
    SUBMIT: ['SUBMIT'],
    DELETE: ['REMOVE'],
    TRANSITION: ['SUBMIT', 'CONFIRM'],
    NAVIGATE: ['NAVIGATE'],
    AUTHENTICATE: ['LOGIN'],
  };
  return map[operation];
}

function contractOperation(hint: ContractHint): FunctionalOperation | undefined {
  const text = normalizeText(`${hint.operationId ?? ''} ${hint.summary ?? ''}`);
  if (/\b(search|find|list|query|lookup|rechercher|lister)\b/.test(text)) return 'SEARCH';
  if (/\b(create|add|register|creer|ajouter)\b/.test(text)) return 'CREATE';
  if (/\b(delete|remove|supprimer)\b/.test(text)) return 'DELETE';
  if (/\b(update|edit|modify|patch|save|modifier|enregistrer)\b/.test(text)) return 'UPDATE';
  if (/\b(submit|approve|reject|publish|transition|soumettre)\b/.test(text)) return 'TRANSITION';
  if (/\b(get|read|fetch|retrieve|show|detail|afficher)\b/.test(text)) return 'OPEN';
  return undefined;
}

function isQuery(exchange: FunctionalExchange): boolean {
  return queryEvidenceOf({
    method: exchange.method.toUpperCase(),
    ...(exchange.status !== undefined ? { status: exchange.status } : {}),
    ...(exchange.records ? { records: exchange.records } : {}),
    ...(exchange.identifiers ? { identifiers: exchange.identifiers } : {}),
  }).query;
}

function sectionSupports(section: string): string[] {
  const words = wordsOf(section);
  const supports: string[] = [];
  if (SEARCH_KEYWORDS.some((word) => words.has(word))) supports.push(UI('SEARCH'));
  if (FILTER_KEYWORDS.some((word) => words.has(normalizeText(word)))) supports.push(UI('FILTER'));
  return supports;
}

function matchesDecision(
  decision: RememberedIntentDecision,
  action: SemanticRecordedAction,
  route: string | undefined,
): boolean {
  const context = decision.context;
  const label = action.target?.label;
  const samePage =
    !context.page || !route || normalizeText(context.page) === normalizeText(route.split('?')[0] ?? route);
  const sameElement =
    (context.label !== undefined &&
      label !== undefined &&
      normalizeText(context.label) === normalizeText(label)) ||
    (context.element !== undefined &&
      label !== undefined &&
      normalizeText(context.element) === normalizeText(label)) ||
    (context.selector !== undefined && action.target?.target.value === context.selector);
  return samePage && sameElement;
}

function takeWhile<T>(items: readonly T[], predicate: (item: T) => boolean): T[] {
  const taken: T[] = [];
  for (const item of items) {
    if (!predicate(item)) break;
    taken.push(item);
  }
  return taken;
}

function routeOf(path: string): string {
  return (path.split(/[?#]/)[0] ?? path).replace(/^[a-z]+:\/\/[^/]+/i, '');
}

function clip(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
