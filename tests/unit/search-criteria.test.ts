import { describe, expect, it } from 'vitest';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import { analyzeHttpRequest, foldValue } from '../../src/functional/http-structure.js';
import type { NetworkObservation } from '../../src/functional/model.js';
import {
  analyzeRecording,
  redactJournal,
  type BusinessObservation,
} from '../../src/recording/analysis/recording-analysis.js';
import type { RawRecordedEvent } from '../../src/recording/model.js';

/**
 * LES CRITÈRES DE RECHERCHE MÉTIER, reconnus à la STRUCTURE de la requête — jamais à un nom de champ,
 * d'endpoint ou de clé connu. Les noms des fixtures sont volontairement différents d'un test à
 * l'autre (et d'une application réelle) : aucun n'est connu du moteur.
 */
const SALT = 'search-salt';
const digest = (value: string): string => valueDigest(value, SALT);
const folded = (value: string): string => valueDigest(foldValue(value), SALT);

function journey() {
  const events: RawRecordedEvent[] = [];
  const network: NetworkObservation[] = [];
  let sequence = 0;
  const event = (
    type: RawRecordedEvent['type'],
    at: number,
    label: string,
    value?: string,
  ): RawRecordedEvent => {
    sequence += 1;
    const entry: RawRecordedEvent = {
      id: `r${String(sequence)}`,
      sequence,
      type,
      at,
      url: 'http://app.test/workbench',
      element: {
        tag: 'input',
        role: type === 'click' ? 'button' : 'textbox',
        name: label,
        label,
      } as NonNullable<RawRecordedEvent['element']>,
      ...(value !== undefined
        ? {
            value: {
              empty: false,
              length: value.length,
              shape: 'text' as const,
              digest: digest(value),
              foldedDigest: folded(value),
            },
          }
        : {}),
    };
    events.push(entry);
    return entry;
  };
  const request = (options: {
    method?: string;
    url: string;
    body?: unknown;
    startedAt: number;
    endedAt?: number;
    windows?: string[];
    listSize?: number;
    newIdentity?: boolean;
  }): NetworkObservation => {
    const entry: NetworkObservation = {
      id: `n${String(network.length + 1)}`,
      method: options.method ?? 'POST',
      path: new URL(options.url, 'http://app.test').pathname,
      resourceType: 'fetch',
      startedAt: options.startedAt,
      request: analyzeHttpRequest({ url: options.url, body: options.body, salt: SALT }),
      openWindows: options.windows ?? [],
      ...(options.endedAt !== undefined
        ? {
            endedAt: options.endedAt,
            durationMs: options.endedAt - options.startedAt,
            status: 200,
            response: {
              ...(options.listSize !== undefined ? { listSize: options.listSize } : {}),
              ...(options.newIdentity ? { newIdentity: true } : {}),
            },
          }
        : {}),
    };
    network.push(entry);
    return entry;
  };
  return { events, network, event, request };
}

/** La forme de l'exemple réel (groupe logique imbriqué sous le même nom, drapeau dans le critère, tri à part,
 * pagination + contexte + option dans l'URL), avec d'autres noms. */
const referenceBody = (value: string) => ({
  rule: {
    join: 'AND',
    rule: [{ isCustom: true, prop: 'partnerTitle', op: 'CONTAINS', val: value }],
  },
  ordering: { prop: 'item-title', direction: 'asc' },
});
const REFERENCE_URL = '/api/workbench/items/_query?pageNo=0&pageSz=100&ownerRef=zx9081&withAssigned=true';

const searchOf = (business: readonly BusinessObservation[], id: string): BusinessObservation | undefined =>
  business.find((entry) => entry.networkId === id);

describe('Search criteria — structural extraction (no known field name)', () => {
  it('the reference shape: one criterion (property · operator · value · AND), the sort apart, the rest technical', () => {
    const structure = analyzeHttpRequest({
      url: REFERENCE_URL,
      body: referenceBody('Alexandre'),
      salt: SALT,
    });
    expect(structure.groups).toEqual([
      expect.objectContaining({ path: 'rule', operator: 'AND', childrenPath: 'rule.rule' }),
    ]);
    expect(structure.criteria.filter((criterion) => criterion.form === 'STRUCTURE')).toEqual([
      expect.objectContaining({
        property: 'partnerTitle',
        propertyPath: 'rule.rule[0].prop',
        operator: 'CONTAINS',
        valuePath: 'rule.rule[0].val',
        group: 'rule',
        flags: ['rule.rule[0].isCustom'],
      }),
    ]);
    // La valeur comparée est la chaîne, jamais le drapeau booléen ; elle est masquée.
    const [criterion] = structure.criteria;
    expect(criterion?.value).toMatchObject({ type: 'string', masked: 'VALUE' });
    expect(criterion?.value.clear).toBeUndefined();
    // Le tri : un nom (même en kebab-case) et une direction, sans opérateur — jamais un critère.
    expect(structure.sort).toEqual([
      { path: 'ordering', property: 'item-title', propertyPath: 'ordering.prop', direction: 'asc' },
    ]);
    expect(structure.criteria.map((entry) => entry.property)).not.toContain('item-title');
    expect(structure.pagination).toMatchObject({
      index: { path: '?pageNo', value: 0 },
      size: { path: '?pageSz', value: 100 },
    });
    expect(structure.options.map((option) => option.path)).toEqual(['?withAssigned']);
  });

  it('three different conventions are read as the same criterion', () => {
    const shapes = [
      { field: 'companyName', operator: 'contains', value: 'Alexandre' },
      { property: 'companyName', comparison: 'LIKE', searchValue: 'Alexandre' },
      { criteria: [{ attribute: 'companyName', operation: 'CONTAINS', input: 'Alexandre' }] },
    ];
    const read = shapes.map((body) => analyzeHttpRequest({ url: '/s', body, salt: SALT }).criteria);
    for (const criteria of read) {
      expect(criteria).toHaveLength(1);
      expect(criteria[0]).toMatchObject({ property: 'companyName', form: 'STRUCTURE' });
      expect(criteria[0]?.value.digest).toBe(digest('Alexandre'));
    }
    expect(read.map((criteria) => criteria[0]?.operator)).toEqual(['contains', 'LIKE', 'CONTAINS']);
  });

  it('a data object with a code in capitals is not a criterion; a sort written as { name: "DESC" } is a sort', () => {
    const data = analyzeHttpRequest({ url: '/x', body: { kind: 'PARTNER', label: 'acme' }, salt: SALT });
    expect(data.criteria.filter((criterion) => criterion.form === 'STRUCTURE')).toEqual([]);
    const sorted = analyzeHttpRequest({ url: '/x', body: { orderBy: { createdOn: 'DESC' } }, salt: SALT });
    expect(sorted.sort).toEqual([expect.objectContaining({ property: 'createdOn', direction: 'DESC' })]);
    expect(sorted.criteria).toEqual([]);
  });
});

describe('Search criteria — interpretation, UI correlation, two dimensions', () => {
  const recordReference = (path = REFERENCE_URL) => {
    const run = journey();
    run.event('input', 1000, 'Company name', 'Alexandre');
    const click = run.event('click', 1500, 'Search');
    run.request({
      url: path,
      body: referenceBody('Alexandre'),
      startedAt: 1520,
      endedAt: 1700,
      windows: [click.id],
      listSize: 3,
    });
    return run;
  };

  it('SEARCH: the typed field is tied to the API property; the rest is pagination, option, context; the value is dynamic', () => {
    const run = recordReference();
    const analysis = analyzeRecording({
      mode: 'CONSOLIDATED',
      events: run.events,
      network: run.network,
      testDataKeys: new Map([['r1', 'company.name']]),
    });
    const search = searchOf(analysis.business, 'n1');
    expect(search).toMatchObject({ operation: 'SEARCH', actionIds: ['r2'], state: 'VALIDATED' });
    expect(search?.searchCriteria).toEqual([
      expect.objectContaining({
        propertyName: 'partnerTitle',
        propertyPath: 'rule.rule[0].prop',
        operator: 'CONTAINS',
        valueType: 'string',
        logicalGroup: { path: 'rule', operator: 'AND' },
        sourceRequest: 'n1',
        sourceJsonPath: 'rule.rule[0].val',
        ui: { label: 'Company name', actionId: 'r1', screen: '/workbench', match: 'EXACT' },
        testData: { key: 'company.name', reference: '${testData.company.name}' },
        state: 'VALIDATED',
      }),
    ]);
    // Le libellé de l'interface et le nom technique sont deux noms d'une même donnée : jamais supposés égaux.
    expect(search?.searchCriteria[0]?.evidence.join(' ')).toMatch(/different names for one datum/);
    const roles = Object.fromEntries(
      (search?.parameters ?? []).map((parameter) => [parameter.path, parameter.role]),
    );
    expect(roles).toEqual({
      '?pageNo': 'PAGINATION',
      '?pageSz': 'PAGINATION',
      'ordering.prop': 'SORT',
      'rule.rule[0].isCustom': 'CRITERION_FLAG',
      '?withAssigned': 'OPTION',
      '?ownerRef': 'CONTEXT',
    });
    expect(search?.searchCriteria.map((criterion) => criterion.propertyName)).not.toContain('ownerRef');
    expect(search?.interpretation).toBe(
      'search where partnerTitle CONTAINS the value typed in "Company name" (${testData.company.name}), sorted by item-title ASC',
    );
    // Le mapping champ ↔ propriété (déjà existant) le confirme.
    expect(analysis.fieldMappings[0]).toMatchObject({ uiLabel: 'Company name', property: 'partnerTitle' });
    // Jamais la valeur en clair dans l'analyse.
    expect(JSON.stringify(analysis)).not.toContain('Alexandre');
  });

  it('a technical-looking path keeps its technical classification, but the filter structure still says SEARCH', () => {
    const run = recordReference('/bff/config/items/_query?pageNo=0&pageSz=100');
    const search = searchOf(
      analyzeRecording({ mode: 'CONSOLIDATED', events: run.events, network: run.network }).business,
      'n1',
    );
    expect(search?.operation).toBe('SEARCH');
    expect(search?.technical).toMatchObject({ category: 'CONFIGURATION' });
    expect(search?.evidence.join(' ')).toMatch(/technical classification kept apart/);
    expect(search?.searchCriteria).toHaveLength(1);
  });

  it('a token request (no filter structure) stays TECHNICAL: never a search, never a creation', () => {
    const run = journey();
    const click = run.event('click', 100, 'Sign in');
    run.request({
      url: '/oauth2/token',
      body: { grant_type: 'authorization_code' },
      startedAt: 120,
      endedAt: 200,
      windows: [click.id],
    });
    const [entry] = analyzeRecording({
      mode: 'CONSOLIDATED',
      events: run.events,
      network: run.network,
    }).business;
    expect(entry?.operation).toBe('TECHNICAL');
    expect(entry?.searchCriteria).toEqual([]);
  });

  it('a search answered with a non-collection body is still a SEARCH (the structure decides), never a creation', () => {
    const run = journey();
    run.event('input', 1000, 'Company name', 'Alexandre');
    const click = run.event('click', 1500, 'Search');
    run.request({
      url: '/q',
      body: referenceBody('Alexandre'),
      startedAt: 1510,
      endedAt: 1600,
      windows: [click.id],
    });
    const [entry] = analyzeRecording({
      mode: 'CONSOLIDATED',
      events: run.events,
      network: run.network,
    }).business;
    expect(entry?.operation).toBe('SEARCH');
    expect(entry?.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('property and value both look like names: the typed value decides which one is the value', () => {
    const run = journey();
    run.event('input', 1000, 'Status', 'pending');
    const click = run.event('click', 1500, 'Search');
    // « pending » est saisi : c'est la valeur, même placé en premier.
    run.request({
      url: '/q',
      body: { left: 'pending', cmp: 'EQ', right: 'state' },
      startedAt: 1510,
      endedAt: 1600,
      windows: [click.id],
      listSize: 1,
    });
    const analysis = analyzeRecording({ mode: 'CONSOLIDATED', events: run.events, network: run.network });
    const [criterion] = analysis.business[0]?.searchCriteria ?? [];
    expect(criterion).toMatchObject({ propertyName: 'state', sourceJsonPath: 'left', propertyPath: 'right' });
    expect(criterion?.ui?.label).toBe('Status');
    // Le journal écrit ne garde jamais la saisie en clair, même portée « comme un nom ».
    expect(JSON.stringify(redactJournal(run.network, run.events))).not.toContain('pending');
  });

  it('a free value in the URL that no typed input explains is context, not a criterion; a typed one is a criterion', () => {
    const run = journey();
    run.event('input', 1000, 'Keyword', 'lamp shade');
    const click = run.event('click', 1500, 'Go');
    run.request({
      method: 'GET',
      url: '/catalog?term=lamp%20shade&tenant=ab-91x7&page=0&size=20',
      startedAt: 1510,
      endedAt: 1600,
      windows: [click.id],
      listSize: 4,
    });
    const [entry] = analyzeRecording({
      mode: 'CONSOLIDATED',
      events: run.events,
      network: run.network,
    }).business;
    expect(entry?.operation).toBe('SEARCH');
    expect(entry?.searchCriteria.map((criterion) => [criterion.propertyName, criterion.ui?.label])).toEqual([
      ['term', 'Keyword'],
    ]);
    expect(entry?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '?tenant', role: 'CONTEXT' })]),
    );
  });

  it('CREATE → SEARCH: the criterion carries the created datum (a proposed relation, from evidence)', () => {
    const run = journey();
    run.event('input', 500, 'Company name', 'Alexandre');
    const save = run.event('click', 800, 'Save');
    run.request({
      url: '/api/partners',
      body: { title: 'Alexandre' },
      startedAt: 820,
      endedAt: 900,
      windows: [save.id],
      newIdentity: true,
    });
    run.event('input', 1000, 'Company name', 'Alexandre');
    const click = run.event('click', 1500, 'Search');
    run.request({
      url: REFERENCE_URL,
      body: referenceBody('Alexandre'),
      startedAt: 1520,
      endedAt: 1700,
      windows: [click.id],
      listSize: 1,
    });
    const analysis = analyzeRecording({ mode: 'CONSOLIDATED', events: run.events, network: run.network });
    const search = searchOf(analysis.business, 'n2');
    expect(search?.relations.map((relation) => relation.type)).toContain('SEARCH_AFTER_CREATE');
    expect(search?.searchCriteria[0]?.fromCreation).toEqual({ businessId: 'b:n1', match: 'EXACT' });
    expect(search?.searchCriteria[0]?.ui?.actionId).toBe('r3');
  });

  it('live (response pending) the criteria are PROVISIONAL; after the stop they are consolidated, with a traced revision', () => {
    const run = journey();
    run.event('input', 1000, 'Company name', 'Alexandre');
    const click = run.event('click', 1500, 'Search');
    const pending = run.request({
      url: REFERENCE_URL,
      body: referenceBody('Alexandre'),
      startedAt: 1520,
      windows: [click.id],
    });
    const live = analyzeRecording({ mode: 'LIVE', events: run.events, network: run.network });
    expect(live.business[0]).toMatchObject({ operation: 'SEARCH', state: 'PROVISIONAL' });
    expect(live.business[0]?.searchCriteria[0]).toMatchObject({
      state: 'PROVISIONAL',
      ui: { label: 'Company name' },
    });
    Object.assign(pending, { endedAt: 1700, durationMs: 180, status: 200, response: { listSize: 2 } });
    const consolidated = analyzeRecording({
      mode: 'CONSOLIDATED',
      events: run.events,
      network: run.network,
      previous: live,
    });
    expect(consolidated.business[0]?.searchCriteria[0]?.state).toBe('VALIDATED');
    expect(consolidated.revisions.map((revision) => `${revision.from} → ${revision.to}`)).toContain(
      'SEARCH PROVISIONAL → SEARCH VALIDATED',
    );
  });
});
