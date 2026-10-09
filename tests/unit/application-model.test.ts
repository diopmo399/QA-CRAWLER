import { describe, expect, it } from 'vitest';
import { recordsOf } from '../../src/forms/state/form-knowledge-observer.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import type { FunctionalExchange } from '../../src/functional/model.js';
import { buildApplicationModel } from '../../src/recording/application/application-model.js';
import { inferOutcomes } from '../../src/recording/outcomes.js';
import type { ApplicationInteractionModel } from '../../src/recording/application/model.js';
import { detectBusinessEvents } from '../../src/recording/business/business-event-detector.js';
import type { EntityEvidence } from '../../src/recording/business/entity-evidence.js';
import {
  classifyEntity,
  CLASSIFICATION_WEIGHTS,
  technicalCategoryOf,
} from '../../src/recording/business/entity-classifier.js';
import {
  identifierTokens,
  identityInPath,
  isIdSegment,
  isListRead,
} from '../../src/recording/business/signals.js';
import type { RawRecordedEvent, RecordedState, SemanticRecordedAction } from '../../src/recording/model.js';

/**
 * L'APPLICATION INTERACTION MODEL avec une application fictive et générique : un shell, une liste de
 * tasks servie par un « BFF », des micro-frontends (éléments personnalisés, iframe, routes de SPA)
 * et des « items ». Aucune règle ne connaît ces noms.
 */
const SALT = 'application-salt';
const digest = (value: string): string => valueDigest(value, SALT);
const ORIGIN = 'http://app.test';

interface StateSpec {
  url: string;
  hosts?: string[];
  frames?: string[];
  statuses?: string[];
  headings?: string[];
}
interface ClickSpec {
  to?: StateSpec;
  network?: FunctionalExchange[];
  href?: string;
  text?: string;
  row?: string;
  rowKey?: { column: string; value: string }[];
  routes?: string[];
}

function app(start: StateSpec) {
  const actions: SemanticRecordedAction[] = [];
  const rawEvents: RawRecordedEvent[] = [];
  const states: RecordedState[] = [];
  let counter = 0;
  const state = (spec: StateSpec): string => {
    const id = `o${String(states.length + 1)}`;
    states.push({
      id,
      stateId: id,
      label: id,
      route: new URL(spec.url, ORIGIN).pathname,
      url: new URL(spec.url, ORIGIN).href,
      title: 'App',
      headings: spec.headings ?? [],
      alerts: [],
      ...(spec.statuses ? { statuses: spec.statuses } : {}),
      ...(spec.hosts ? { hosts: spec.hosts } : {}),
      ...(spec.frames ? { frames: spec.frames } : {}),
      invalidFields: 0,
      dialogs: [],
      controls: [],
    });
    return id;
  };
  const initialStateId = state(start);
  let currentState = initialStateId;
  const base = (type: SemanticRecordedAction['type'], label: string): SemanticRecordedAction => {
    counter += 1;
    return {
      id: `a${String(counter)}`,
      type,
      rawEventIds: [`r${String(counter)}`],
      at: counter * 1000,
      url: states.find((entry) => entry.id === currentState)?.url ?? ORIGIN,
      target: {
        target: { strategy: 'label', value: label },
        quality: 'SEMANTIC',
        label,
        alternatives: [],
        ambiguous: false,
        named: true,
        reasons: [],
      },
      network: [],
      provenance: 'HUMAN_RECORDED',
      confidence: 1,
      evidence: [],
      stateBefore: currentState,
    };
  };
  return {
    click(label: string, spec: ClickSpec = {}): SemanticRecordedAction {
      const action = base('CLICK', label);
      action.network = spec.network ?? [];
      const routes = spec.routes ?? (spec.to ? [new URL(spec.to.url, ORIGIN).pathname] : []);
      const fromRoute = states.find((entry) => entry.id === currentState)?.route;
      if (routes.length && routes[0] !== fromRoute)
        action.navigation = {
          routes,
          navigationIds: [],
          confidence: 'HIGH',
          score: 1,
          reasons: [],
          provenance: 'RUNTIME_OBSERVED',
        };
      if (spec.to) currentState = state(spec.to);
      action.stateAfter = currentState;
      rawEvents.push({
        id: action.rawEventIds[0] ?? '',
        sequence: counter,
        type: 'click',
        at: action.at,
        url: action.url,
        element: {
          tag: spec.href ? 'a' : 'button',
          role: spec.href ? 'link' : 'button',
          name: label,
          text: spec.text ?? label,
          ...(spec.href ? { href: spec.href } : {}),
          ...(spec.row ? { row: spec.row } : {}),
          ...(spec.rowKey ? { rowKey: spec.rowKey } : {}),
        } as NonNullable<RawRecordedEvent['element']>,
      });
      actions.push(action);
      return action;
    },
    fill(label: string, value: string, shape: 'number' | 'code' | 'text' = 'text'): SemanticRecordedAction {
      const action = base('FILL', label);
      action.stateAfter = currentState;
      rawEvents.push({
        id: action.rawEventIds[0] ?? '',
        sequence: counter,
        type: 'input',
        at: action.at,
        url: action.url,
        value: {
          empty: false,
          length: value.length,
          shape,
          ...(/\d/.test(value) ? { hasDigit: true } : {}),
          digest: digest(value),
        },
      });
      actions.push(action);
      return action;
    },
    build(decisions?: ReadonlyMap<string, string>): ApplicationInteractionModel {
      const detection = detectBusinessEvents({ actions, states, rawEvents, digest, initialStateId });
      return buildApplicationModel({
        actions,
        states,
        rawEvents,
        entities: detection.entities,
        entityEvidence: detection.evidence,
        initialStateId,
        digest,
        ...(decisions ? { relationshipDecisions: decisions } : {}),
      });
    },
    actions,
    states,
  };
}

/** Une lecture (GET) servie par le « BFF » : ses enregistrements réduits à leurs identifiants. */
const read = (path: string, body: unknown): FunctionalExchange => {
  const found = identityInPath(path);
  return {
    method: 'GET',
    path,
    status: 200,
    ...(found
      ? {
          identifiers: [
            { field: '(path)', digest: digest(found.value), value: found.value, source: 'path' as const },
          ],
        }
      : {}),
    records: recordsOf(body, SALT),
  };
};
const create = (path: string, field: string, value: string): FunctionalExchange => ({
  method: 'POST',
  path,
  status: 201,
  identifiers: [{ field, digest: digest(value), value, source: 'response' }],
});
const put = (path: string): FunctionalExchange => ({ ...read(path, {}), method: 'PUT', records: [] });

const SHELL = 'app-shell';
const TASKS = { url: '/tasks', hosts: [SHELL, 'task-list'] };
const kinds = (model: ApplicationInteractionModel): string[] =>
  model.businessActions.map((action) => action.kind);
const subsequence = (all: readonly string[], wanted: readonly string[]): boolean => {
  let cursor = 0;
  for (const kind of all) if (kind === wanted[cursor]) cursor += 1;
  return cursor === wanted.length;
};

describe('Read responses: identifier records (a BFF list), never a body', () => {
  it('keeps the identifiers of each record (taskId ≠ businessKey), never a token or an API key', () => {
    const records = recordsOf(
      { items: [{ taskId: 456, businessKey: 'ABC123', label: 'free text', apiKey: 'k', token: 't' }] },
      SALT,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.container).toBe('items');
    expect(records[0]?.identifiers.map((id) => id.field)).toEqual(['taskId', 'businessKey']);
    expect(JSON.stringify(records)).not.toMatch(/free text|"k"|"t"/);
  });
});

describe('Application Interaction Model (generic: shell, task list, BFF, micro-frontends)', () => {
  it('TEST A — task list → select task → create MFE → create item ABC123 → open: Task → Item, CREATE → OPEN', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', { to: TASKS, network: [read('/bff/tasks', [{ taskId: 456, type: 'NEW' }])] });
    run.click('Task 456 — new item', { to: { url: '/items/new', hosts: [SHELL, 'items-create'] } });
    run.fill('Name', 'Alex');
    run.click('Create', {
      network: [create('/bff/items', 'businessKey', 'ABC123')],
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'], statuses: ['Item ABC123 created'] },
    });
    run.click('Open ABC123', {
      href: '/items/ABC123/view',
      to: { url: '/items/ABC123/view', hosts: [SHELL, 'items-detail'] },
      network: [read('/bff/items/ABC123', { businessKey: 'ABC123' })],
    });
    const model = run.build();

    expect(model.application.shell).toEqual([SHELL]);
    expect(model.workspaces).toHaveLength(1);
    expect(model.workspaces[0]).toMatchObject({
      type: 'TASK_WORKSPACE',
      source: { type: 'NETWORK', path: '/bff/tasks' },
    });
    const task = model.tasks[0];
    expect(task?.primary).toMatchObject({ type: 'TASK_ID', value: '456', field: 'taskId' });
    const item = model.entities.find((entity) => entity.identity.value === 'ABC123');
    expect(item).toMatchObject({
      key: 'entity:item:ABC123',
      provenance: { classification: 'CREATED_DURING_RECORDING' },
    });
    expect(item?.identity).toMatchObject({ type: 'BUSINESS_KEY', field: 'businessKey' });
    expect(item?.classification.classification).toBe('BUSINESS_ENTITY');
    // La task n'est pas une entité : son identifiant n'en fait pas une « entité 456 ».
    expect(model.entities.some((entity) => entity.identity.value === '456')).toBe(false);
    expect(model.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'RESULTS_IN', source: task?.key, target: 'entity:item:ABC123' }),
        expect.objectContaining({ type: 'NAVIGATES_TO', source: task?.key, target: 'host:items-create' }),
        expect.objectContaining({
          type: 'CREATED_BY',
          source: 'entity:item:ABC123',
          target: 'host:items-create',
        }),
      ]),
    );
    expect(subsequence(kinds(model), ['SELECT_TASK', 'SWITCH_CONTEXT', 'CREATE', 'OPEN'])).toBe(true);
    // TEST H : un micro-frontend sans iframe (élément personnalisé) est un contexte, vu tel quel.
    const mfe = model.contexts.find((context) => context.key === 'host:items-create');
    expect(mfe).toMatchObject({ kind: 'HOST', role: 'MICROFRONTEND', name: 'items-create' });
    expect(model.contexts.find((context) => context.key === 'host:task-list')?.role).toBe('WORKSPACE');
    // Chaque action métier pointe vers les actions Playwright d'origine.
    expect(model.businessActions.every((action) => action.actionIds.length > 0)).toBe(true);
  });

  it('TEST B — search ABC123 → open: SEARCH → OPEN, never CREATE, and the result list is not a task list', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', { to: TASKS, network: [read('/bff/tasks', [{ taskId: 456 }])] });
    run.click('Search items', { to: { url: '/items/search', hosts: [SHELL, 'items-search'] } });
    run.fill('Business key', 'ABC123', 'code');
    run.click('Search', { network: [read('/bff/items', { items: [{ id: 99, businessKey: 'ABC123' }] })] });
    run.click('Item ABC123', {
      href: '/items/ABC123',
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
      network: [read('/bff/items/ABC123', { businessKey: 'ABC123' })],
    });
    const model = run.build();
    const item = model.entities.find((entity) => entity.identity.value === 'ABC123');
    expect(item?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(item?.lifecycle).toEqual(['SEARCH', 'OPEN']);
    expect(kinds(model)).not.toContain('CREATE');
    expect(kinds(model)).not.toContain('SELECT_TASK');
    expect(model.tasks).toHaveLength(0);
    expect(subsequence(kinds(model), ['SEARCH', 'OPEN'])).toBe(true);
  });

  it('TEST C — existing task → MFE → update → save: SELECT_TASK → OPEN → UPDATE → SAVE; the task REFERENCES the item', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', {
      to: TASKS,
      network: [read('/bff/tasks', [{ taskId: 457, businessKey: 'ABC123' }])],
    });
    run.click('Task 457 — ABC123', {
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
      network: [read('/bff/items/ABC123', { businessKey: 'ABC123' })],
    });
    run.fill('Description', 'Updated by Martin');
    run.click('Save', { network: [put('/bff/items/ABC123')] });
    const model = run.build();
    expect(subsequence(kinds(model), ['SELECT_TASK', 'OPEN', 'UPDATE', 'SAVE'])).toBe(true);
    const task = model.tasks[0];
    expect(task?.identityCandidates.map((candidate) => candidate.type)).toEqual(['TASK_ID', 'BUSINESS_KEY']);
    const reference = model.relationships.find((relation) => relation.type === 'REFERENCES');
    expect(reference).toMatchObject({ source: task?.key, target: 'entity:item:ABC123', status: 'CONFIRMED' });
    expect(reference?.reason).toMatch(/businessKey = ABC123/);
    expect(model.entities[0]?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(model.workspaces[0]?.source).toMatchObject({
      bffCandidate: { reasons: expect.arrayContaining([expect.stringMatching(/bff/)]) as unknown },
    });
  });

  it('TEST D — create, return to the task list, the BFF lists a task carrying ABC123: CREATE_RESULT → task (different task id)', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('New item', { to: { url: '/items/new', hosts: [SHELL, 'items-create'] } });
    run.fill('Name', 'Alex');
    run.click('Create', {
      network: [create('/bff/items', 'businessKey', 'ABC123')],
      to: { url: '/items/new', hosts: [SHELL, 'items-create'], statuses: ['Item ABC123 created'] },
    });
    run.click('Tasks', {
      to: TASKS,
      network: [read('/bff/tasks', [{ taskId: 900, businessKey: 'ABC123' }, { taskId: 901 }])],
    });
    const model = run.build();
    const result = model.relationships.find((relation) => relation.type === 'CREATE_RESULT');
    expect(result).toMatchObject({ source: 'entity:item:ABC123' });
    expect(result?.target).toMatch(/:900$/);
    expect(result?.reason).toMatch(/task id need not be the same/);
    expect(kinds(model)).toContain('RETRIEVE');
    // Seule la task qui porte la nouvelle identité est déduite (pas 901).
    expect(model.tasks.map((task) => task.primary.value)).toEqual(['900']);
  });

  it('TEST E — the same key in several contexts: one entity, every context and correlation explained by evidence', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', {
      to: TASKS,
      network: [read('/bff/tasks', [{ taskId: 457, businessKey: 'ABC123' }])],
    });
    run.click('Task 457 — ABC123', {
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
      network: [read('/bff/items/ABC123', { businessKey: 'ABC123' })],
    });
    run.click('Orders', { to: { url: '/orders', hosts: [SHELL, 'orders-list'] } });
    run.click('Order ABC123', {
      href: '/orders/ABC123',
      to: { url: '/orders/ABC123', hosts: [SHELL, 'order-detail'] },
    });
    const model = run.build();
    const item = model.entities.find((entity) => entity.key === 'entity:item:ABC123');
    const order = model.entities.find((entity) => entity.key === 'entity:order:ABC123');
    expect(item?.contexts).toEqual(expect.arrayContaining(['host:items-detail']));
    expect(order).toBeDefined();
    const correlation = model.relationships.find((relation) => relation.type === 'CORRELATES_WITH');
    expect(correlation).toMatchObject({ status: 'UNCERTAIN' });
    expect(correlation?.reason).toMatch(/not merged/);
    // Toute relation a des preuves, et chaque preuve existe.
    const ids = new Set(model.evidence.map((entry) => entry.id));
    for (const relation of model.relationships) {
      expect(relation.evidenceIds.length).toBeGreaterThan(0);
      expect(relation.evidenceIds.every((id) => ids.has(id))).toBe(true);
    }
  });

  it('TEST F — no usable network: the technical flow stays, the screen alone gives a cautious interpretation', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', { to: TASKS });
    run.click('Task 456 ABC123', {
      row: 'Task 456 ABC123',
      rowKey: [{ column: 'Key', value: 'ABC123' }],
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
    });
    run.fill('Description', 'Edited');
    run.click('Save', {
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'], statuses: ['Item ABC123 saved'] },
    });
    const model = run.build();
    expect(run.actions).toHaveLength(4);
    expect(model.collections.every((collection) => collection.source.type === 'DOM')).toBe(true);
    expect(model.workspaces[0]).toMatchObject({
      source: { type: 'DOM' },
      confidence: 0.6,
      status: 'DEDUCED',
    });
    expect(kinds(model)).not.toContain('CREATE');
    expect(
      model.entities.find((entity) => entity.identity.value === 'ABC123')?.provenance.classification,
    ).toBe('DISCOVERED_DURING_RECORDING');
  });

  it('TEST G — contradictory information: AMBIGUOUS provenance; a value pointing to two entities stays UNCERTAIN (AI may only choose among them)', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Item ABC123', {
      href: '/items/ABC123',
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
    });
    run.click('Order ABC123', {
      href: '/orders/ABC123',
      to: { url: '/orders/ABC123', hosts: [SHELL, 'order-detail'] },
    });
    run.click('New item', { to: { url: '/items/new', hosts: [SHELL, 'items-create'] } });
    run.click('Create', { network: [create('/bff/items', 'businessKey', 'ABC123')] });
    run.click('Tasks', {
      to: TASKS,
      network: [read('/bff/tasks', [{ taskId: 900, businessKey: 'ABC123' }])],
    });
    run.click('Task 900', { to: { url: '/workbench', hosts: [SHELL, 'task-detail'] } });
    const model = run.build();
    expect(
      model.entities.find((entity) => entity.key === 'entity:item:ABC123')?.provenance.classification,
    ).toBe('AMBIGUOUS');
    const reference = model.relationships.find((relation) => relation.type === 'REFERENCES');
    expect(reference).toMatchObject({ status: 'UNCERTAIN' });
    expect(reference?.candidates?.sort()).toEqual(['entity:item:ABC123', 'entity:order:ABC123']);
    // L'IA choisit parmi les candidats seulement : revalidé, plafonné, marqué.
    const key = `${reference?.source ?? ''}|REFERENCES`;
    const chosen = run
      .build(new Map([[key, 'entity:order:ABC123']]))
      .relationships.find((relation) => relation.type === 'REFERENCES');
    expect(chosen).toMatchObject({ target: 'entity:order:ABC123', analyzer: 'AI_PROPOSAL', confidence: 0.7 });
    const refused = run
      .build(new Map([[key, 'entity:invented:1']]))
      .relationships.find((relation) => relation.type === 'REFERENCES');
    expect(refused).toMatchObject({ status: 'UNCERTAIN', analyzer: 'DETERMINISTIC' });
  });

  it('TEST I — a micro-frontend loaded in an iframe is a FRAME context; selecting the task navigates to it', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', { to: TASKS, network: [read('/bff/tasks', [{ taskId: 456 }])] });
    run.click('Task 456', {
      to: { url: '/tasks', hosts: [SHELL, 'task-list'], frames: [`${ORIGIN}/mfe/create`] },
    });
    const model = run.build();
    const frame = model.contexts.find((context) => context.kind === 'FRAME');
    expect(frame).toMatchObject({ role: 'MICROFRONTEND', frame: `${ORIGIN}/mfe/create` });
    const change = model.businessActions.find(
      (action) => action.kind === 'SWITCH_CONTEXT' && action.subject === frame?.key,
    );
    expect(change?.reason).toMatch(/frame .*mfe\/create loaded/);
    expect(model.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'NAVIGATES_TO', target: frame?.key })]),
    );
  });

  it('TEST J — a SPA without custom elements: route changes (no reload) are the contexts', () => {
    const run = app({ url: '/' });
    run.click('Tasks', {
      to: { url: '/tasks' },
      network: [read('/api/work', [{ id: 456, itemRef: 'ABC123' }])],
    });
    run.click('Task 456', {
      to: { url: '/items/ABC123' },
      network: [read('/api/items/ABC123', { id: 'ABC123' })],
    });
    const model = run.build();
    expect(model.contexts.map((context) => context.key)).toEqual(
      expect.arrayContaining(['route:/tasks', 'route:/items/:id']),
    );
    expect(model.tasks[0]?.identityCandidates.map((candidate) => candidate.type)).toEqual([
      'TASK_ID',
      'REFERENCE',
    ]);
    expect(model.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'REFERENCES', target: 'entity:item:ABC123' })]),
    );
    // Aucun BFF supposé : /api/work ne porte aucun indice de BFF au-delà de ses relations.
    expect(subsequence(kinds(model), ['SELECT_TASK', 'SWITCH_CONTEXT', 'OPEN'])).toBe(true);
  });

  it('no task list in the application: no workspace, no task — the model simply has none', () => {
    const run = app({ url: '/' });
    run.click('Items', { to: { url: '/items' }, network: [read('/api/items', [{ id: 123 }])] });
    run.click('Item 123', {
      href: '/items/123',
      to: { url: '/items/123' },
      network: [read('/api/items/123', { id: 123 })],
    });
    const model = run.build();
    expect(model.workspaces).toHaveLength(0);
    expect(model.tasks).toHaveLength(0);
    expect(model.entities[0]?.lifecycle).toEqual(['OPEN']);
  });
});

describe('Observe first, classify second: technical noise never becomes a business entity', () => {
  const evidence = (url: string, type: EntityEvidence['type'] = 'READ_RESPONSE'): EntityEvidence => ({
    id: 'e1',
    type,
    actionIndex: 0,
    actionId: 'a1',
    rawEventIds: ['r1'],
    identity: { value: 'X', source: 'NETWORK_PATH', confidence: 0.9 },
    details: { url },
    description: url,
  });
  const subject = (value: string, resources: string[] = []) => ({
    identity: { value, source: 'NETWORK_PATH' as const, confidence: 0.9 },
    resources,
    provenance: 'DISCOVERED_DURING_RECORDING' as const,
    lifecycle: ['OPEN'],
  });

  it('identities need a digit: OIDC names, auth routes and component names are names, not identities', () => {
    for (const name of ['openid-configuration', 'auth-redirect', 'oidc-client-app-shell', 'app-task-list'])
      expect(isIdSegment(name)).toBe(false);
    for (const id of [
      '123',
      'ABC123',
      'DEM-2026-001',
      'dem-2026-001',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    ])
      expect(isIdSegment(id)).toBe(true);
    expect(identityInPath('/.well-known/openid-configuration')).toBeUndefined();
    expect(identityInPath('/auth-redirect')).toBeUndefined();
    expect(identifierTokens('oidc-client-app-shell openid-configuration')).toEqual([]);
    expect(identifierTokens('Item ABC123 and DEM-2026-001')).toEqual(['ABC123', 'DEM-2026-001']);
  });

  it('TEST E — OpenID configuration / auth resources are INFRASTRUCTURE_ENTITY, never BUSINESS_ENTITY', () => {
    const discovery = classifyEntity(subject('X'), [evidence('/.well-known/openid-configuration')]);
    expect(discovery).toMatchObject({
      classification: 'INFRASTRUCTURE_ENTITY',
      confidence: CLASSIFICATION_WEIGHTS.infrastructure,
    });
    expect(classifyEntity(subject('C123'), [evidence('/oauth2/clients/C123')]).classification).toBe(
      'INFRASTRUCTURE_ENTITY',
    );
    // Même proposé par l'IA, jamais promu en métier.
    expect(
      classifyEntity(subject('X'), [evidence('/.well-known/openid-configuration')], 'BUSINESS_ENTITY')
        .classification,
    ).toBe('INFRASTRUCTURE_ENTITY');
  });

  it('TEST E (recording) — sign-in noise lands in the Technical Context, outside the business flow', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Sign in', {
      to: { url: '/auth-redirect', hosts: [SHELL] },
      network: [
        read('/.well-known/openid-configuration', {
          issuer: 'https://idp.test',
          jwks_uri: 'https://idp.test/jwks',
        }),
        read('/oidc/client-app-shell/userinfo', { sub: 'abc' }),
        read('/assets/i18n/fr.json', {}),
      ],
    });
    run.click('Tasks', { to: TASKS, network: [read('/bff/tasks', [{ taskId: 456 }])] });
    const model = run.build();
    expect(model.entities).toHaveLength(0);
    const categories = model.technicalContext.items.map((item) => `${item.classification}:${item.category}`);
    expect(categories).toEqual(
      expect.arrayContaining([
        'INFRASTRUCTURE_ENTITY:DISCOVERY',
        'INFRASTRUCTURE_ENTITY:AUTHENTICATION',
        'TECHNICAL_ENTITY:STATIC_RESOURCE',
      ]),
    );
    expect(model.technicalContext.items.every((item) => item.evidenceIds.length > 0)).toBe(true);
    expect(
      model.businessActions.some((action) => /openid|auth-redirect|oidc/.test(action.subject ?? '')),
    ).toBe(false);
  });

  it('TEST F — a component / technical name and configuration-only resources are TECHNICAL_ENTITY', () => {
    expect(classifyEntity(subject('app-task-list'), []).classification).toBe('TECHNICAL_ENTITY');
    expect(classifyEntity(subject('V2'), [evidence('/assets/config/v2-123.json')]).classification).toBe(
      'TECHNICAL_ENTITY',
    );
  });

  it('TEST G — a task is an APPLICATION_ENTITY, linked to (never merged with) the business entity it references', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', {
      to: TASKS,
      network: [read('/bff/tasks', [{ taskId: 457, businessKey: 'ABC123' }])],
    });
    run.click('Task 457 — ABC123', {
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
      network: [read('/bff/items/ABC123', { businessKey: 'ABC123' })],
    });
    const model = run.build();
    expect(model.tasks[0]?.classification).toBe('APPLICATION_ENTITY');
    expect(model.workspaces[0]?.classification).toBe('APPLICATION_ENTITY');
    expect(model.contexts.every((context) => context.classification === 'APPLICATION_CONTEXT')).toBe(true);
    const item = model.entities.find((entity) => entity.key === 'entity:item:ABC123');
    expect(item?.classification.classification).toBe('BUSINESS_ENTITY');
    expect(model.businessContext.entityKeys).toEqual(['entity:item:ABC123']);
    expect(model.entities.some((entity) => entity.identity.value === '457')).toBe(false);
  });

  it('TEST H — insufficient evidence (read on load, no gesture, no write): UNKNOWN, kept, never forced', () => {
    const run = app({ url: '/' });
    run.click('Refresh', { network: [read('/api/items/123', { id: 123 })] });
    const model = run.build();
    const item = model.entities[0];
    expect(item?.classification).toMatchObject({ classification: 'UNKNOWN' });
    expect(item?.classification.confidence).toBeLessThan(CLASSIFICATION_WEIGHTS.threshold);
    expect(model.businessContext.unknownKeys).toEqual([item?.key]);
  });

  it('TESTS I + J — create ABC123 (CREATED_DURING_RECORDING, BUSINESS), then search ABC123 and open: the same business entity', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('New item', { to: { url: '/items/new', hosts: [SHELL, 'items-create'] } });
    run.fill('Name', 'Alex');
    run.click('Create', {
      network: [create('/bff/items', 'businessKey', 'ABC123')],
      to: { url: '/items/new', hosts: [SHELL, 'items-create'], statuses: ['Item ABC123 created'] },
    });
    run.click('Search items', { to: { url: '/items/search', hosts: [SHELL, 'items-search'] } });
    run.fill('Business key', 'ABC123', 'code');
    run.click('Search', { network: [read('/bff/items', { items: [{ id: 99, businessKey: 'ABC123' }] })] });
    run.click('Item ABC123', {
      href: '/items/ABC123',
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
      network: [read('/bff/items/ABC123', { businessKey: 'ABC123' })],
    });
    const model = run.build();
    const items = model.entities.filter((entity) =>
      entity.identityCandidates.some((candidate) => candidate.value === 'ABC123'),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      classification: { classification: 'BUSINESS_ENTITY' },
      provenance: { classification: 'CREATED_DURING_RECORDING' },
      lifecycle: ['CREATE', 'SEARCH', 'OPEN'],
    });
    expect(items[0]?.identity).toMatchObject({ type: 'BUSINESS_KEY', field: 'businessKey' });
    expect(items[0]?.identity.evidenceIds?.length).toBeGreaterThan(0);
  });

  it('recorded, validated and interpreted are three independent states: nothing is dropped', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Help');
    run.click('Tasks', { to: TASKS, network: [read('/bff/tasks', [{ taskId: 456 }])] });
    const model = run.build();
    expect(model.actions).toHaveLength(2);
    expect(model.actions[0]).toMatchObject({
      recorded: true,
      validation: 'UNVERIFIED',
      interpretation: ['UNKNOWN'],
    });
    expect(model.actions[1]?.interpretation).toEqual(['SWITCH_CONTEXT']);
    expect(model.summary.actions).toEqual({ recorded: 2, validated: 0, interpreted: 1, uninterpreted: 1 });
  });
});

describe('Criteria in the work list: a FILTER, never an entity', () => {
  /** Une liste lue par un POST (des critères dans le corps) : une lecture, pas une création. */
  const search = (path: string, body: unknown): FunctionalExchange => ({
    ...read(path, body),
    method: 'POST',
  });

  it('a name typed in the criteria + a choice + a click that reads the list again (POST): FILTER, then SELECT_TASK', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', {
      to: TASKS,
      network: [
        search('/bff/tasks', [
          { taskId: 456, businessKey: 'ABC111' },
          { taskId: 457, businessKey: 'ABC123' },
        ]),
      ],
    });
    run.click('ui-icon-v4-4-0');
    const name = run.fill('Customer', 'Acme Corp', 'code');
    const kind = run.fill('Kind', 'UPDATE', 'code');
    const narrow = run.click('Apply', {
      network: [search('/bff/tasks', [{ taskId: 457, businessKey: 'ABC123' }])],
    });
    run.click('Task 457 — ABC123', {
      to: { url: '/items/ABC123', hosts: [SHELL, 'items-detail'] },
      network: [read('/bff/items/ABC123', { businessKey: 'ABC123' })],
    });
    const model = run.build();
    expect(subsequence(kinds(model), ['SWITCH_CONTEXT', 'FILTER', 'SELECT_TASK', 'OPEN'])).toBe(true);
    const filter = model.businessActions.find((action) => action.kind === 'FILTER');
    expect(filter).toMatchObject({
      subject: model.workspaces[0]?.key,
      contextKey: 'host:task-list',
      actionIds: [name.id, kind.id, narrow.id],
      status: 'OBSERVED',
    });
    expect(filter?.reason).toMatch(/"Customer", "Kind"/);
    // La liste lue par POST est une lecture : un workspace réseau, jamais une création.
    expect(model.workspaces[0]).toMatchObject({
      collectionKey: 'collection:POST /bff/tasks',
      source: { type: 'NETWORK', path: '/bff/tasks' },
    });
    expect(model.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'RETRIEVED_BY', target: 'api:POST /bff/tasks' }),
      ]),
    );
    expect(kinds(model)).not.toContain('CREATE');
    // Ni le nom saisi, ni le choix, ni l'icône versionnée ne deviennent des entités.
    expect(model.entities.map((entity) => entity.key)).toEqual(['entity:item:ABC123']);
    expect(JSON.stringify(model)).not.toContain('Acme');
  });

  it('no list read again and no rows changed: the criteria stay uninterpreted (UNKNOWN), never a FILTER', () => {
    const run = app({ url: '/', hosts: [SHELL] });
    run.click('Tasks', { to: TASKS, network: [search('/bff/tasks', [{ taskId: 456 }])] });
    run.fill('Customer', 'Acme Corp', 'code');
    run.click('Apply');
    const model = run.build();
    expect(kinds(model)).not.toContain('FILTER');
    expect(model.actions.slice(1).map((view) => view.interpretation)).toEqual([['UNKNOWN'], ['UNKNOWN']]);
  });

  it('typed text and versioned component names are not identities; a sign-in token POST is not a write', () => {
    for (const name of ['ux-icon-v4-4-0', 'ui-icon-v4-4-0', 'button-v2'])
      expect(isIdSegment(name)).toBe(false);
    expect(identifierTokens('ui-icon-v4-4-0 Acme Corp')).toEqual([]);
    expect(
      classifyEntity(
        {
          identity: { value: 'ux-icon-v4-4-0', source: 'VISIBLE_TEXT', confidence: 0.5 },
          resources: [],
          provenance: 'DISCOVERED_DURING_RECORDING',
          lifecycle: ['OPEN'],
        },
        [],
      ).classification,
    ).toBe('TECHNICAL_ENTITY');
    expect(technicalCategoryOf('/auth/oidc/realm-1/protocol/openid-connect/token')?.category).toBe(
      'AUTHENTICATION',
    );
    expect(isListRead({ records: [{ index: 0, identifiers: [] }] })).toBe(true);
    expect(
      isListRead({
        records: [{ index: 0, identifiers: [] }],
        identifiers: [{ source: 'response' }],
      }),
    ).toBe(false);
    expect(isListRead({})).toBe(false);
    // Un nom saisi (sans chiffre) n'est jamais une identité, même en majuscules ; un POST de jeton non plus.
    const run = app({ url: '/', hosts: [SHELL] });
    run.fill('Name', 'ACME CORP', 'code');
    run.click('Sign in', {
      network: [
        {
          method: 'POST',
          path: '/auth/oidc/realm-1/protocol/openid-connect/token',
          status: 200,
          identifiers: [
            { field: 'session_state', digest: digest('S123'), value: 'S123', source: 'response' },
          ],
        },
      ],
    });
    run.click('Apply', { network: [search('/bff/tasks', [{ taskId: 457 }])] });
    const model = run.build();
    expect(model.entities).toEqual([]);
    expect(kinds(model)).not.toContain('CREATE');
    // Ni le jeton ni la liste lue par POST ne sont une intention d'écriture (jamais « CREATE:TOKEN »).
    const outcomes = inferOutcomes(run.actions, run.states, false);
    expect(outcomes.intent.workflow).toBeUndefined();
    expect(
      outcomes.assertions.filter((assertion) => assertion.kind === 'API_OUTCOME' && assertion.selected),
    ).toEqual([]);
  });
});
