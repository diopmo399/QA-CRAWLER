import { describe, expect, it } from 'vitest';
import { identifiersOf, pathIdentifierOf } from '../../src/forms/state/form-knowledge-observer.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import type { FunctionalExchange } from '../../src/functional/model.js';
import {
  detectBusinessEvents,
  entityHintsOf,
  resolveEntity,
} from '../../src/recording/business/business-event-detector.js';
import { buildBusinessFlow } from '../../src/recording/business/business-flow.js';
import { LlmBusinessAnalyzer } from '../../src/recording/business/business-semantic-analyzer.js';
import { EntityMemory } from '../../src/recording/business/entity-memory.js';
import { statusOf } from '../../src/recording/business/model.js';
import type { RawRecordedEvent, RecordedState, SemanticRecordedAction } from '../../src/recording/model.js';

const SALT = 'unit-salt';
const digest = (value: string): string => valueDigest(value, SALT);

let counter = 0;
const action = (
  type: SemanticRecordedAction['type'],
  label: string,
  extra: Partial<SemanticRecordedAction> = {},
): SemanticRecordedAction => {
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
    ...extra,
  };
};
const post = (path: string, id?: string, status = 201): FunctionalExchange => ({
  method: 'POST',
  path,
  status,
  ...(id
    ? { identifiers: [{ field: 'id', digest: digest(id), value: id, source: 'response' as const }] }
    : {}),
});
const state = (id: string, extra: Partial<RecordedState> = {}): RecordedState => ({
  id,
  stateId: id,
  label: id,
  route: '/',
  url: 'http://app.test/',
  title: 'Demandes',
  headings: [],
  alerts: [],
  invalidFields: 0,
  dialogs: [],
  controls: [],
  ...extra,
});
const fillRaw = (rawId: string, value: string): RawRecordedEvent => ({
  id: rawId,
  sequence: 0,
  type: 'input',
  at: 0,
  url: '',
  value: { empty: false, length: value.length, shape: 'number', digest: digest(value) },
});

/** Créer (POST /api/demandes → 12345) → rechercher 12345 → ouvrir « Demande 12345 ». */
function journey(api = '/api/demandes', id: string | undefined = '12345') {
  const open = action('CLICK', 'Nouvelle demande');
  const name = action('FILL', 'Nom');
  const create = action('CLICK', 'Créer', { network: [post(api, id)], stateAfter: 'o1' });
  const toSearch = action('CLICK', 'Rechercher une demande');
  const fill = action('FILL', 'Numéro de demande');
  const run = action('CLICK', 'Rechercher', {
    network: [{ method: 'GET', path: '/api/demandes', status: 200 }],
  });
  const result = action('CLICK', 'Demande 12345 — Martin', {
    navigation: {
      routes: ['/demandes/12345'],
      navigationIds: [],
      confidence: 'HIGH',
      score: 1,
      reasons: [],
      provenance: 'RUNTIME_OBSERVED',
    },
  });
  const actions = [open, name, create, toSearch, fill, run, result];
  const rawEvents = [fillRaw(fill.rawEventIds[0] ?? '', '12345')];
  const states = [state('o1', { alerts: ['Demande 12345 créée'] })];
  return { actions, rawEvents, states, ids: { open, name, create, toSearch, fill, run, result } };
}

describe('Network identifiers (never a secret, only identifier-shaped values in clear)', () => {
  it('keeps the id fields of a write response, with a salted digest; never a token', () => {
    const found = identifiersOf(
      { id: 12345, token: 'abc.def', data: { reference: 'DEM-2026-001' }, secretKey: 'x' },
      SALT,
    );
    expect(found.map((entry) => entry.field)).toEqual(['id', 'data.reference']);
    expect(found[0]).toMatchObject({ value: '12345', digest: digest('12345'), source: 'response' });
    expect(JSON.stringify(found)).not.toMatch(/abc\.def|secretKey/);
  });

  it('reads the identifier of an API path (/api/demandes/12345), never a collection', () => {
    expect(pathIdentifierOf('/api/demandes/12345', SALT)).toMatchObject({ value: '12345', source: 'path' });
    expect(pathIdentifierOf('/api/demandes', SALT)).toBeUndefined();
  });
});

describe('Business event detector (deterministic)', () => {
  it('TEST 1 — a POST that returns an id after « Créer » is ENTITY_CREATED, CONFIRMED, $created.demande.id', () => {
    const { actions, rawEvents, states, ids } = journey();
    const detection = detectBusinessEvents({ actions, rawEvents, states, digest });
    const created = detection.events.find((event) => event.type === 'ENTITY_CREATED');
    expect(created).toMatchObject({
      entity: 'demande',
      output: '$created.demande.id',
      status: 'CONFIRMED',
      identifier: { value: '12345', source: 'network' },
    });
    // L'action métier regroupe le formulaire : « Nouvelle demande », « Nom », « Créer ».
    expect(created?.actionIds).toEqual([ids.open.id, ids.name.id, ids.create.id]);
  });

  it('TESTS 2–3 — search by the created id is SEARCH_REFERENCE; the result click is OPEN; CREATE → SEARCH → OPEN', () => {
    const { actions, rawEvents, states, ids } = journey();
    const detection = detectBusinessEvents({ actions, rawEvents, states, digest });
    const model = buildBusinessFlow('create-and-find-demande', detection);
    expect(
      model.steps.map(
        (step) => `${step.action} ${step.entity ?? ''} ${step.reference ?? step.outputs?.id ?? ''}`,
      ),
    ).toEqual([
      'create demande $created.demande.id',
      'search demande $created.demande.id',
      'open demande $created.demande.id',
    ]);
    expect(detection.relations.find((relation) => relation.type === 'SEARCH_REFERENCE')).toMatchObject({
      reference: '$created.demande.id',
      match: 'same salted digest',
    });
    expect(model.steps[1]?.actionIds).toEqual([ids.toSearch.id, ids.fill.id, ids.run.id]);
    expect(model.steps[2]?.actionIds).toEqual([ids.result.id]);
  });

  it('a POST alone (no id, no message, no create label) is never a creation fact', () => {
    const lonely = action('CLICK', 'Suivant', { network: [post('/api/demandes', undefined, 200)] });
    const detection = detectBusinessEvents({ actions: [lonely], rawEvents: [], states: [], digest });
    expect(detection.events[0]?.status).toBe('UNKNOWN');
    expect(buildBusinessFlow('x', detection).steps).toHaveLength(0);
    expect(detection.memory.all).toHaveLength(0);
  });

  it('TEST 8 — two entities possible (API « dossiers », screen « demande »): AMBIGUOUS, nothing invented', () => {
    const { actions, rawEvents, states } = journey('/api/dossiers');
    const detection = detectBusinessEvents({ actions, rawEvents, states, digest });
    const created = detection.events.find((event) => event.type === 'ENTITY_CREATED');
    expect(created).toMatchObject({ status: 'AMBIGUOUS', candidates: ['dossier', 'demande'] });
    expect(created?.entity).toBeUndefined();
    // Aucune référence ni aucun nom : la recherche et l'ouverture ne s'appuient sur rien d'inventé.
    expect(detection.memory.all).toHaveLength(0);
    const steps = buildBusinessFlow('x', detection).steps;
    expect(steps.every((step) => step.entity === undefined && step.reference === undefined)).toBe(true);
    // …mais la MÊME identité est suivie (créée, recherchée, ouverte) : ce sont des faits observés.
    expect(steps.map((step) => step.action)).toEqual(['search', 'open']);
    expect(new Set(steps.map((step) => step.entityKey)).size).toBe(1);
    expect(detection.entities[0]?.provenance.classification).toBe('CREATED_DURING_RECORDING');
  });
});

describe('Optional LLM analyzer (chooses among observed candidates, revalidated)', () => {
  it('a choice among the candidates resolves the ambiguity — at most PROBABLE, marked AI_PROPOSAL', async () => {
    const { actions, rawEvents, states } = journey('/api/dossiers');
    const analyzer = new LlmBusinessAnalyzer(() => Promise.resolve('demande'));
    const detection = await analyzer.analyze({ actions, rawEvents, states, digest });
    const created = detection.events.find((event) => event.type === 'ENTITY_CREATED');
    expect(created).toMatchObject({ entity: 'demande', status: 'PROBABLE', analyzer: 'AI_PROPOSAL' });
    expect(created?.confidence).toBeLessThan(0.85);
    expect(buildBusinessFlow('x', detection).steps.map((step) => step.action)).toEqual([
      'create',
      'search',
      'open',
    ]);
  });

  it('an invented entity (not observed) is rejected: the ambiguity stays', async () => {
    const { actions, rawEvents, states } = journey('/api/dossiers');
    const analyzer = new LlmBusinessAnalyzer(() => Promise.resolve('client'));
    const detection = await analyzer.analyze({ actions, rawEvents, states, digest });
    expect(analyzer.consultations[0]).toMatchObject({ answer: 'client', accepted: false });
    expect(detection.events.find((event) => event.type === 'ENTITY_CREATED')?.status).toBe('AMBIGUOUS');
  });

  it('the deterministic analysis never calls the LLM when nothing is ambiguous', async () => {
    const { actions, rawEvents, states } = journey();
    let calls = 0;
    const analyzer = new LlmBusinessAnalyzer(() => {
      calls += 1;
      return Promise.resolve('demande');
    });
    await analyzer.analyze({ actions, rawEvents, states, digest });
    expect(calls).toBe(0);
  });
});

describe('Entity memory, hints and thresholds', () => {
  it('a second creation of the same entity gets its own reference; values match by digest or value', () => {
    const memory = new EntityMemory();
    const first = memory.remember({
      entity: 'demande',
      identifier: { digest: digest('1'), value: '100', source: 'network' },
      status: 'CONFIRMED',
      confidence: 0.9,
      eventId: 'b1',
    });
    const second = memory.remember({
      entity: 'demande',
      identifier: { digest: digest('200'), source: 'network' },
      status: 'PROBABLE',
      confidence: 0.7,
      eventId: 'b2',
    });
    expect([first.reference, second.reference]).toEqual(['$created.demande.id', '$created.demande.id2']);
    expect(memory.match({ digest: digest('200') })[0]?.record.reference).toBe('$created.demande.id2');
    expect(memory.foundIn('Ouvrir la demande #100')[0]?.record.reference).toBe('$created.demande.id');
  });

  it('reads entity names from the screen; a generic API resource never decides alone', () => {
    expect(entityHintsOf('Nouvelle demande')).toEqual(['demande']);
    expect(entityHintsOf('Rechercher un dossier')).toEqual(['dossier']);
    expect(resolveEntity('items', ['demande'])).toMatchObject({ entity: 'demande' });
    expect(resolveEntity('demandes', ['demande'])).toMatchObject({
      entity: 'demande',
      candidates: ['demande'],
    });
    expect(resolveEntity('dossiers', ['demande']).entity).toBeUndefined();
    expect(resolveEntity('items', []).entity).toBeUndefined();
  });

  it('CONFIRMED ≥ 0.85, PROBABLE ≥ 0.60, else UNKNOWN', () => {
    expect([statusOf(0.97), statusOf(0.7), statusOf(0.4)]).toEqual(['CONFIRMED', 'PROBABLE', 'UNKNOWN']);
  });
});
