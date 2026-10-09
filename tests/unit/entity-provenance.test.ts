import { describe, expect, it } from 'vitest';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import type { FunctionalExchange } from '../../src/functional/model.js';
import { detectBusinessEvents } from '../../src/recording/business/business-event-detector.js';
import { buildBusinessFlow } from '../../src/recording/business/business-flow.js';
import { LlmBusinessAnalyzer } from '../../src/recording/business/business-semantic-analyzer.js';
import { trackEntities, type TrackedEntity } from '../../src/recording/business/entity-tracker.js';
import { PROVENANCE_WEIGHTS } from '../../src/recording/business/provenance-resolver.js';
import { collectionOf, identityInPath } from '../../src/recording/business/signals.js';
import type { RawRecordedEvent, RecordedState, SemanticRecordedAction } from '../../src/recording/model.js';

/**
 * LA PROVENANCE DES ENTITÉS, avec une entité fictive et générique (« item ») : aucune règle ne
 * connaît le domaine. Les mêmes parcours sont rejoués avec d'autres noms de ressource.
 */
const SALT = 'provenance-salt';
const digest = (value: string): string => valueDigest(value, SALT);

interface Built {
  actions: SemanticRecordedAction[];
  rawEvents: RawRecordedEvent[];
  states: RecordedState[];
}

/** Un petit constructeur de parcours : chaque geste devient une action enregistrée (et son événement brut). */
function journey(): Built & {
  click: (label: string, extra?: Step) => SemanticRecordedAction;
  fill: (label: string, value: string, shape?: 'number' | 'code' | 'text') => SemanticRecordedAction;
  navigate: (route: string, reason: string, network?: FunctionalExchange[]) => SemanticRecordedAction;
  state: (extra: Partial<RecordedState>) => string;
} {
  const built: Built = { actions: [], rawEvents: [], states: [] };
  let counter = 0;
  const base = (type: SemanticRecordedAction['type'], label: string): SemanticRecordedAction => {
    counter += 1;
    return {
      id: `a${String(counter)}`,
      type,
      rawEventIds: [`r${String(counter)}`],
      at: counter * 1000,
      url: 'http://app.test/',
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
    };
  };
  const state = (extra: Partial<RecordedState>): string => {
    const id = `o${String(built.states.length + 1)}`;
    built.states.push({
      id,
      stateId: id,
      label: id,
      route: '/',
      url: 'http://app.test/',
      title: 'App',
      headings: [],
      alerts: [],
      invalidFields: 0,
      dialogs: [],
      controls: [],
      ...extra,
    });
    return id;
  };
  return {
    ...built,
    state,
    click: (label, extra = {}) => {
      const action = base('CLICK', label);
      if (extra.routes)
        action.navigation = {
          routes: extra.routes,
          navigationIds: [],
          confidence: 'HIGH',
          score: 1,
          reasons: [],
          provenance: 'RUNTIME_OBSERVED',
        };
      action.network = extra.network ?? [];
      if (extra.after) action.stateAfter = state(extra.after);
      built.rawEvents.push({
        id: action.rawEventIds[0] ?? '',
        sequence: counter,
        type: 'click',
        at: action.at,
        url: action.url,
        element: {
          tag: 'a',
          role: 'link',
          name: label,
          text: label,
          ...(extra.href ? { href: extra.href } : {}),
        } as NonNullable<RawRecordedEvent['element']>,
      });
      built.actions.push(action);
      return action;
    },
    fill: (label, value, shape = 'number') => {
      const action = base('FILL', label);
      built.rawEvents.push({
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
      built.actions.push(action);
      return action;
    },
    navigate: (route, reason, network = []) => {
      const action = base('NAVIGATE', route);
      action.route = route;
      action.gotoReason = reason;
      action.network = network;
      delete action.target;
      built.actions.push(action);
      return action;
    },
  };
}

interface Step {
  routes?: string[];
  network?: FunctionalExchange[];
  href?: string;
  after?: Partial<RecordedState>;
}

const get = (path: string, status = 200): FunctionalExchange => {
  const found = identityInPath(path);
  return {
    method: 'GET',
    path,
    status,
    ...(found
      ? {
          identifiers: [
            { field: '(path)', digest: digest(found.value), value: found.value, source: 'path' as const },
          ],
        }
      : {}),
  };
};
const post = (path: string, id: string, status = 201): FunctionalExchange => ({
  method: 'POST',
  path,
  status,
  identifiers: [{ field: 'id', digest: digest(id), value: id, source: 'response' }],
});
const put = (path: string): FunctionalExchange => ({ ...get(path), method: 'PUT' });

const track = (built: Built, initialStateId?: string): TrackedEntity[] =>
  trackEntities({
    actions: built.actions,
    rawEvents: built.rawEvents,
    states: built.states,
    digest,
    ...(initialStateId ? { initialStateId } : {}),
  }).entities;
const lifecycle = (entity: TrackedEntity | undefined): string[] =>
  (entity?.lifecycle ?? []).map((step) => step.kind);

/** CAS A : une entité EXISTANTE recherchée puis ouverte — jamais créée. */
function searchAndOpen(resource: string, id: string) {
  const app = journey();
  app.click(`Search ${resource}s`, { routes: [`/${resource}s/search`] });
  app.fill('Number', id);
  app.click('Search', { network: [{ method: 'GET', path: `/api/${resource}s?q=${id}`, status: 200 }] });
  app.click(`${resource} ${id} — Martin`, {
    href: `/${resource}s/${id}`,
    routes: [`/${resource}s/${id}`],
    network: [get(`/api/${resource}s/${id}`)],
  });
  return app;
}

/** CAS B : une création (POST sur la collection → nouvel identifiant). */
function create(app: ReturnType<typeof journey>, resource: string, id: string): void {
  app.click(`New ${resource}`, { routes: [`/${resource}s/new`] });
  app.fill('Name', 'Alex', 'text');
  app.click('Create', {
    network: [post(`/api/${resource}s`, id)],
    routes: [`/${resource}s/${id}`],
    after: { statuses: [`${resource} ${id} created`] },
  });
}

describe('Generic structure (no domain is known)', () => {
  it('reads an identity and its resource from any URL shape', () => {
    expect(identityInPath('/api/v2/orders/CMD-2026-00125/edit')).toEqual({
      value: 'CMD-2026-00125',
      resource: 'order',
    });
    expect(identityInPath('/tickets/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({
      resource: 'ticket',
    });
    expect(identityInPath('/items/new')).toBeUndefined();
    expect(collectionOf('/api/v1/factures')).toBe('facture');
  });
});

describe('Entity provenance (deterministic, generic)', () => {
  it('CAS A — an existing item searched then opened is DISCOVERED_DURING_RECORDING, never CREATED', () => {
    const entities = track(searchAndOpen('item', '123'));
    const item = entities.find((entity) => entity.identity.value === '123');
    expect(item).toMatchObject({ key: 'entity:item:123', type: 'item' });
    expect(item?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(item?.provenance.rules).toEqual(
      expect.arrayContaining(['R3 search is not a creation', 'R7 first sighting is not a creation']),
    );
    expect(item?.provenance.evidence).toEqual(
      expect.arrayContaining(['USER_INPUT', 'RESULT_SELECTED', 'DETAIL_VIEW', 'READ_RESPONSE']),
    );
    expect(lifecycle(item)).toEqual(['SEARCH', 'OPEN']);
    // La saisie et le clic sur le résultat sont la MÊME entité (empreinte de la saisie = identité affichée).
    expect(entities).toHaveLength(1);
    expect(entities.some((entity) => entity.provenance.classification === 'CREATED_DURING_RECORDING')).toBe(
      false,
    );
    // L'identité de la première observation n'est pas une création.
    expect(item?.firstSeen.evidence).toBe('USER_INPUT');
  });

  it('CAS B — a creation (create action + POST + 201 + new id) is CREATED_DURING_RECORDING with a derived confidence', () => {
    const app = journey();
    create(app, 'item', '456');
    const [item] = track(app);
    expect(item).toMatchObject({
      key: 'entity:item:456',
      identity: { value: '456', source: 'NETWORK_RESPONSE' },
    });
    expect(item?.provenance).toMatchObject({
      classification: 'CREATED_DURING_RECORDING',
      rules: ['R1 explicit creation', 'R2 converging creation evidence'],
    });
    // 0,55 (id de la réponse) + 0,2 (POST) + 0,1 (« Create ») + 0,1 (201) + 0,05 (page de l'entité), plafonné à 0,99.
    const w = PROVENANCE_WEIGHTS;
    expect(item?.provenance.confidence).toBe(
      Math.min(
        0.99,
        w.creation.NETWORK_RESPONSE + w.writeRequest + w.createAction + w.successResponse + w.detailView,
      ),
    );
    expect(lifecycle(item)).toEqual(['CREATE']);
  });

  it('CAS C — create 456, search 456, open 456: one identity all along, CREATE → SEARCH → OPEN', () => {
    const app = journey();
    create(app, 'item', '456');
    app.click('Search items', { routes: ['/items/search'] });
    app.fill('Number', '456');
    app.click('Search', { network: [{ method: 'GET', path: '/api/items?q=456', status: 200 }] });
    app.click('item 456', { href: '/items/456', routes: ['/items/456'], network: [get('/api/items/456')] });
    const entities = track(app);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.provenance.classification).toBe('CREATED_DURING_RECORDING');
    expect(lifecycle(entities[0])).toEqual(['CREATE', 'SEARCH', 'OPEN']);
    expect(entities[0]?.key).toBe('entity:item:456');
  });

  it('CAS D — a URL typed directly (/items/123 → GET 200) is DISCOVERED, not created', () => {
    const app = journey();
    app.navigate('/items/123', 'DIRECT_URL_ENTRY', [get('/api/items/123')]);
    const [item] = track(app);
    expect(item?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(item?.provenance.rules).toContain('R4 direct navigation / read is not a creation');
    expect(lifecycle(item)).toEqual(['OPEN']);
  });

  it('CAS D bis — shown on the STARTING screen: CONFIRMED_EXISTING (the only proof of prior existence)', () => {
    const app = journey();
    const start = app.state({ url: 'http://app.test/items/123', route: '/items/:id' });
    app.click('Edit');
    const [item] = track(app, start);
    expect(item?.provenance).toMatchObject({
      classification: 'CONFIRMED_EXISTING',
      evidence: ['INITIAL_STATE'],
    });
  });

  it('CAS E — opening an item from a list is not a creation', () => {
    const app = journey();
    app.click('Items', { routes: ['/items'] });
    app.click('item 123 — Martin', { href: '/items/123', routes: ['/items/123'] });
    const [item] = track(app);
    expect(item?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(item?.provenance.rules).toContain('R5 opening from a list is not a creation');
  });

  it('CAS F — a typed identifier alone stays UNKNOWN (nothing is decided yet)', () => {
    const app = journey();
    app.fill('Number', '123');
    const [item] = track(app);
    expect(item?.provenance).toMatchObject({
      classification: 'UNKNOWN',
      rules: ['R6 typed identifier', 'R9 insufficient evidence'],
    });
    // La saisie n'est jamais écrite : seule son empreinte est connue.
    expect(item?.identity.value).toBeUndefined();
    expect(item?.identity.digest).toBe(digest('123'));
  });

  it('CAS G — opened BEFORE a creation that returns the same id: AMBIGUOUS, contradictions kept', () => {
    const app = journey();
    app.click('item 123', { href: '/items/123', routes: ['/items/123'], network: [get('/api/items/123')] });
    app.click('New item', { routes: ['/items/new'] });
    app.click('Create', { network: [post('/api/items', '123')] });
    const [item] = track(app);
    expect(item?.provenance.classification).toBe('AMBIGUOUS');
    expect(item?.provenance.candidates).toEqual(['CREATED_DURING_RECORDING', 'DISCOVERED_DURING_RECORDING']);
    expect(item?.provenance.contradictions?.join(' ')).toMatch(/observed before its creation/);
  });

  it('CAS H — the same value in two resources is two entities; a bare typed 123 is not linked to either', () => {
    const app = journey();
    app.click('order 123', { href: '/orders/123', routes: ['/orders/123'] });
    app.click('customer 123', { href: '/customers/123', routes: ['/customers/123'] });
    app.click('Search', { routes: ['/search'] });
    app.fill('Number', '123');
    const entities = track(app);
    const keys = entities.map((entity) => entity.key);
    expect(keys).toEqual(expect.arrayContaining(['entity:order:123', 'entity:customer:123']));
    const typed = entities.find((entity) => entity.resources.length === 0);
    expect(typed?.provenance.classification).toBe('UNKNOWN');
    expect(typed?.linkCandidates?.sort()).toEqual(['entity:customer:123', 'entity:order:123']);
  });

  it('search → open → update → save: one entity, lifecycle SEARCH → OPEN → UPDATE → SAVE', () => {
    const app = searchAndOpen('item', '123');
    app.fill('Description', 'A new text', 'text');
    app.click('Save', { network: [put('/api/items/123')] });
    const [item] = track(app);
    expect(lifecycle(item)).toEqual(['SEARCH', 'OPEN', 'UPDATE', 'SAVE']);
    expect(item?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
  });

  it('without any network (SPA, opaque API): the screen alone separates CREATE from SEARCH → OPEN', () => {
    const app = journey();
    app.click('New item');
    app.fill('Name', 'Alex', 'text');
    app.click('Create', { after: { statuses: ['Item ITM-0042 created'] } });
    app.click('Search');
    app.fill('Reference', 'ITM-0042', 'code');
    app.click('Find');
    app.click('Item ITM-0042', { after: { headings: ['Item ITM-0042'] } });
    app.click('Search');
    app.fill('Reference', 'ITM-0007', 'code');
    app.click('Find');
    app.click('Item ITM-0007', { after: { headings: ['Item ITM-0007'] } });
    const entities = track(app);
    const created = entities.find((entity) => entity.identity.value === 'ITM-0042');
    const found = entities.find((entity) => entity.identity.value === 'ITM-0007');
    expect(created?.provenance.classification).toBe('CREATED_DURING_RECORDING');
    expect(lifecycle(created)).toEqual(['CREATE', 'SEARCH', 'OPEN']);
    expect(found?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(lifecycle(found)).toEqual(['SEARCH', 'OPEN']);
  });

  it('a « Save » on an item already displayed (with a success message) is a SAVE, never a creation', () => {
    const app = searchAndOpen('item', '123');
    app.click('Save', { after: { statuses: ['item 123 saved'] } });
    const [item] = track(app);
    expect(item?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(lifecycle(item)).toEqual(['SEARCH', 'OPEN', 'SAVE']);
  });

  it.each(['ticket', 'commande', 'facture', 'client', 'produit'])(
    'the same rules hold for « %s » (no rule names a domain)',
    (resource) => {
      const discovered = track(searchAndOpen(resource, '777'))[0];
      expect(discovered?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
      const app = journey();
      create(app, resource, '888');
      expect(track(app)[0]?.provenance.classification).toBe('CREATED_DURING_RECORDING');
      expect(track(app)[0]?.type).toBe(resource);
    },
  );

  it('an AI may only CHOOSE among the candidates of an ambiguity, capped, contradictions kept', () => {
    const app = journey();
    app.click('item 123', { href: '/items/123', routes: ['/items/123'] });
    app.click('Create', { network: [post('/api/items', '123')] });
    const run = (proposal: 'CREATED_DURING_RECORDING' | 'CONFIRMED_EXISTING') =>
      trackEntities({
        actions: app.actions,
        rawEvents: app.rawEvents,
        states: app.states,
        digest,
        proposals: new Map([['entity:item:123', proposal]]),
      }).entities[0]?.provenance;
    expect(run('CREATED_DURING_RECORDING')).toMatchObject({
      classification: 'CREATED_DURING_RECORDING',
      confidence: PROVENANCE_WEIGHTS.aiCap,
      analyzer: 'AI_PROPOSAL',
    });
    expect(run('CREATED_DURING_RECORDING')?.contradictions?.length).toBeGreaterThan(0);
    // Hors des candidats observés : ignorée.
    expect(run('CONFIRMED_EXISTING')).toMatchObject({
      classification: 'AMBIGUOUS',
      analyzer: 'DETERMINISTIC',
    });
  });
});

describe('Business events and flow carry the provenance', () => {
  const detect = (built: Built) =>
    detectBusinessEvents({
      actions: built.actions,
      rawEvents: built.rawEvents,
      states: built.states,
      digest,
    });

  it('SEARCH → OPEN of an existing item: business steps, provenance DISCOVERED, no creation, no $created', () => {
    const detection = detect(searchAndOpen('item', '123'));
    const model = buildBusinessFlow('find-item', detection);
    expect(model.steps.map((step) => step.action)).toEqual(['search', 'open']);
    expect(model.steps.every((step) => step.provenance === 'DISCOVERED_DURING_RECORDING')).toBe(true);
    expect(model.steps.every((step) => step.entityKey === 'entity:item:123')).toBe(true);
    expect(detection.events.some((event) => event.type === 'ENTITY_CREATED')).toBe(false);
    expect(detection.memory.all).toHaveLength(0);
    expect(model.entities).toEqual([
      expect.objectContaining({
        key: 'entity:item:123',
        references: [],
        provenance: expect.objectContaining({ classification: 'DISCOVERED_DURING_RECORDING' }) as unknown,
        lifecycle: [expect.objectContaining({ kind: 'SEARCH' }), expect.objectContaining({ kind: 'OPEN' })],
      }),
    ]);
  });

  it('CREATE → SEARCH → OPEN: one entity key all along, $created only for the proven creation', () => {
    const app = journey();
    create(app, 'item', '456');
    app.click('Search items', { routes: ['/items/search'] });
    app.fill('Number', '456');
    app.click('Search', { network: [{ method: 'GET', path: '/api/items?q=456', status: 200 }] });
    app.click('item 456', { href: '/items/456', routes: ['/items/456'], network: [get('/api/items/456')] });
    const model = buildBusinessFlow('create-find', detect(app));
    expect(model.steps.map((step) => step.action)).toEqual(['create', 'search', 'open']);
    expect(new Set(model.steps.map((step) => step.entityKey))).toEqual(new Set(['entity:item:456']));
    expect(model.steps[0]).toMatchObject({
      provenance: 'CREATED_DURING_RECORDING',
      outputs: { id: '$created.item.id' },
    });
    expect(model.steps[1]?.reference).toBe('$created.item.id');
  });

  it('« Save » with a success message on a displayed item is never ENTITY_CREATED', () => {
    const app = searchAndOpen('item', '123');
    app.click('Save', { after: { statuses: ['item 123 saved'] } });
    const detection = detect(app);
    expect(detection.events.some((event) => event.type === 'ENTITY_CREATED')).toBe(false);
    expect(detection.events.at(-1)).toMatchObject({
      entityKey: 'entity:item:123',
      provenance: 'DISCOVERED_DURING_RECORDING',
    });
    expect(detection.memory.all).toHaveLength(0);
  });

  it('contradictory evidence: the creation event is AMBIGUOUS, never a $created reference', () => {
    const app = journey();
    app.click('item 123', { href: '/items/123', routes: ['/items/123'], network: [get('/api/items/123')] });
    app.click('New item', { routes: ['/items/new'] });
    app.click('Create', { network: [post('/api/items', '123')] });
    const detection = detect(app);
    const created = detection.events.find((event) => event.type === 'ENTITY_CREATED');
    expect(created).toMatchObject({ status: 'AMBIGUOUS', provenance: 'AMBIGUOUS' });
    expect(created?.evidence.context.join(' ')).toMatch(/observed before its creation/);
    expect(detection.memory.all).toHaveLength(0);
  });

  it('the optional AI chooses a provenance among the candidates only; the analyzer revalidates', async () => {
    const app = journey();
    app.click('item 123', { href: '/items/123', routes: ['/items/123'] });
    app.click('Create item', { network: [post('/api/items', '123')] });
    const asked: string[][] = [];
    const analyzer = new LlmBusinessAnalyzer(({ topic, candidates }) => {
      if (topic === 'provenance') asked.push([...candidates]);
      return Promise.resolve(topic === 'provenance' ? 'CREATED_DURING_RECORDING' : undefined);
    });
    const detection = await analyzer.analyze({
      actions: app.actions,
      rawEvents: app.rawEvents,
      states: app.states,
      digest,
    });
    expect(asked).toEqual([['CREATED_DURING_RECORDING', 'DISCOVERED_DURING_RECORDING']]);
    expect(detection.entities[0]?.provenance).toMatchObject({
      classification: 'CREATED_DURING_RECORDING',
      analyzer: 'AI_PROPOSAL',
      confidence: PROVENANCE_WEIGHTS.aiCap,
    });
    // Une réponse hors des candidats est ignorée.
    const refused = await new LlmBusinessAnalyzer(() => Promise.resolve('CONFIRMED_EXISTING')).analyze({
      actions: app.actions,
      rawEvents: app.rawEvents,
      states: app.states,
      digest,
    });
    expect(refused.entities[0]?.provenance.classification).toBe('AMBIGUOUS');
  });
});
