import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import { analyzeHttpRequest, foldValue } from '../../src/functional/http-structure.js';
import type { ExchangeRecord, NetworkObservation } from '../../src/functional/model.js';
import { FunctionalKnowledgeStore } from '../../src/knowledge/functional-knowledge-store.js';
import {
  analyzeRecording,
  redactJournal,
  type RecordingAnalysis,
} from '../../src/recording/analysis/recording-analysis.js';
import type { RawRecordedEvent } from '../../src/recording/model.js';

/**
 * L'ANALYSE MÉTIER DES REQUÊTES HTTP (un seul moteur, en direct et après l'arrêt). Les noms de
 * champs et les formats sont volontairement variés : aucun n'est connu du moteur.
 */
const SALT = 'http-salt';
const digest = (value: string): string => valueDigest(value, SALT);
const folded = (value: string): string => valueDigest(foldValue(value), SALT);

/** Un parcours : des événements utilisateur et un journal réseau, avec une horloge en ms. */
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
    status?: number;
    windows?: string[];
    listSize?: number;
    records?: Record<string, string>[];
    newIdentity?: boolean;
  }): NetworkObservation => {
    const entry: NetworkObservation = {
      id: `n${String(network.length + 1)}`,
      method: options.method ?? 'GET',
      path: new URL(options.url, 'http://app.test').pathname,
      resourceType: 'fetch',
      startedAt: options.startedAt,
      request: analyzeHttpRequest({ url: options.url, body: options.body, salt: SALT }),
      openWindows: options.windows ?? [],
      ...(options.endedAt !== undefined
        ? {
            endedAt: options.endedAt,
            durationMs: options.endedAt - options.startedAt,
            status: options.status ?? 200,
            response: {
              ...(options.listSize !== undefined ? { listSize: options.listSize } : {}),
              ...(options.records ? { records: records(options.records) } : {}),
              ...(options.newIdentity ? { newIdentity: true } : {}),
            },
          }
        : {}),
    };
    network.push(entry);
    return entry;
  };
  return {
    events,
    network,
    event,
    request,
    analyze: (mode: 'LIVE' | 'CONSOLIDATED' = 'CONSOLIDATED', previous?: RecordingAnalysis) =>
      analyzeRecording({ mode, events, network, ...(previous ? { previous } : {}) }),
  };
}

function records(rows: Record<string, string>[]): ExchangeRecord[] {
  return rows.map((row, index) => ({
    index,
    identifiers: [],
    attributes: Object.entries(row).map(([field, value]) => ({
      field,
      digest: digest(value),
      folded: folded(value),
    })),
  }));
}

describe('HTTP structure analyzer (generic: no field name, endpoint or format is known)', () => {
  it('1 — GET with parameters: typed values, pagination, an implicit criterion candidate; values masked', () => {
    const structure = analyzeHttpRequest({
      url: '/api/catalog?q=Blue%20Lamp&pg=2&per=50&withStock=true',
      salt: SALT,
    });
    expect(structure.pagination).toMatchObject({
      index: { path: '?pg', value: 2 },
      size: { path: '?per', value: 50 },
    });
    expect(structure.options.map((leaf) => leaf.path)).toEqual(['?withStock']);
    expect(structure.criteria).toEqual([
      expect.objectContaining({
        property: 'q',
        form: 'IMPLICIT',
        value: expect.objectContaining({ masked: 'VALUE' }) as unknown,
      }),
    ]);
    expect(JSON.stringify(structure)).not.toContain('Blue');
  });

  it('2 + 3 + 4 — POST JSON: nested logical groups (AND / OR), property / operator / value triples, full JSON paths', () => {
    const structure = analyzeHttpRequest({
      url: '/api/work/query',
      salt: SALT,
      body: {
        filter: {
          op: 'AND',
          items: [
            { field: 'orgTitle', cmp: 'CONTAINS', v: 'Acme Holdings' },
            {
              op: 'OR',
              items: [
                { field: 'stateCode', cmp: 'EQUALS', v: 'OPEN' },
                { field: 'stateCode', cmp: 'EQUALS', v: 'NEW' },
              ],
            },
          ],
        },
      },
    });
    expect(structure.groups).toEqual([
      expect.objectContaining({ path: 'filter', operator: 'AND', childrenPath: 'filter.items', children: 2 }),
      expect.objectContaining({ path: 'filter.items[1]', operator: 'OR', parent: 'filter' }),
    ]);
    expect(
      structure.criteria.map((criterion) => [
        criterion.property,
        criterion.operator,
        criterion.valuePath,
        criterion.group,
      ]),
    ).toEqual([
      ['orgTitle', 'CONTAINS', 'filter.items[0].v', 'filter'],
      ['stateCode', 'EQUALS', 'filter.items[1].items[0].v', 'filter.items[1]'],
      ['stateCode', 'EQUALS', 'filter.items[1].items[1].v', 'filter.items[1]'],
    ]);
    // Le texte cherché est masqué ; un code d'état reste lisible (un jeton de structure).
    expect(structure.criteria[0]?.value).toMatchObject({ masked: 'VALUE', type: 'string' });
    expect(structure.criteria[1]?.value.clear).toBe('OPEN');
    expect(JSON.stringify(structure)).not.toContain('Acme');
  });

  it('5 + 16 — pagination and sorting with other conventions (snake_case, other words, other nesting)', () => {
    const structure = analyzeHttpRequest({
      url: '/v2/records/_lookup',
      salt: SALT,
      body: {
        where: { mode: 'or', rules: [{ column: 'org_title', test: 'like', operand: 'acme' }] },
        order_by: [{ column: 'created_at', way: 'desc' }],
        paging: { from: 40, count: 20 },
      },
    });
    expect(structure.groups[0]).toMatchObject({ operator: 'OR', childrenPath: 'where.rules' });
    expect(structure.criteria[0]).toMatchObject({
      property: 'org_title',
      operator: 'like',
      form: 'STRUCTURE',
    });
    expect(structure.sort).toEqual([
      { path: 'order_by[0]', property: 'created_at', propertyPath: 'order_by[0].column', direction: 'desc' },
    ]);
    expect(structure.pagination).toMatchObject({ index: { value: 40 }, size: { value: 20 } });
  });

  it('13 — sensitive data: secret keys never read, typed values only as digests, a typed CAPITALS name re-masked', () => {
    const run = journey();
    const typed = run.event('input', 1000, 'Organisation', 'ACME');
    run.event('click', 1200, 'Search');
    run.request({
      method: 'POST',
      url: '/api/org/find?accessToken=abc',
      body: { password: 'hunter2', criteria: { name: 'ACME' } },
      startedAt: 1250,
      endedAt: 1300,
      windows: ['r2'],
      listSize: 0,
    });
    const leaves = run.network[0]?.request?.leaves ?? [];
    expect(leaves.find((leaf) => leaf.path === 'password')?.value).toEqual({
      type: 'string',
      masked: 'SENSITIVE_KEY',
    });
    expect(leaves.find((leaf) => leaf.path === '?accessToken')?.value.masked).toBe('SENSITIVE_KEY');
    expect(JSON.stringify(run.network)).not.toContain('hunter2');
    // « ACME » a la forme d'un code : lisible dans la structure… mais c'est une SAISIE.
    expect(leaves.find((leaf) => leaf.path === 'criteria.name')?.value.clear).toBe('ACME');
    const written = redactJournal(run.network, run.events);
    expect(JSON.stringify(written)).not.toContain('ACME');
    expect(written[0]?.request?.leaves.find((leaf) => leaf.path === 'criteria.name')?.value.masked).toBe(
      'USER_INPUT',
    );
    expect(JSON.stringify(run.analyze())).not.toContain('ACME');
    expect(typed.value?.digest).toBeDefined();
  });
});

describe('Action ↔ request correlation (confidence, candidates, independent requests)', () => {
  it('6 — one action triggers several requests: one correlation, all requests linked', () => {
    const run = journey();
    run.event('click', 1000, 'Open');
    run.request({ url: '/api/a', startedAt: 1100, endedAt: 1200, windows: ['r1'] });
    run.request({ url: '/api/b', startedAt: 1150, endedAt: 1400, windows: ['r1'] });
    const analysis = run.analyze();
    expect(analysis.correlations).toEqual([
      expect.objectContaining({
        actionId: 'r1',
        networkIds: ['n1', 'n2'],
        kind: 'TRIGGERED',
        state: 'VALIDATED',
      }),
    ]);
  });

  it('7 — independent requests close in time: polling stays independent; a far request is not linked', () => {
    const run = journey();
    run.event('click', 5000, 'Save');
    for (const at of [1000, 3000, 5100, 7000, 9000])
      run.request({ url: '/api/notifications/count', startedAt: at, endedAt: at + 30 });
    run.request({ url: '/api/later', startedAt: 20_000, endedAt: 20_050 });
    const analysis = run.analyze();
    expect(analysis.correlations).toEqual([]);
    expect(analysis.independent.filter((entry) => /periodic/.test(entry.reason))).toHaveLength(5);
    expect(analysis.independent.find((entry) => entry.networkId === 'n6')?.reason).toMatch(
      /after the last action/,
    );
  });

  it('7b — a polling tick inside a gesture window stays independent; a weaker request never makes the trigger ambiguous', () => {
    const run = journey();
    run.event('click', 4000, 'Run');
    run.event('click', 4600, 'Refresh');
    // Le tick de 5200 tombe dans la fenêtre de « Refresh » : la régularité de la série l'emporte.
    for (const at of [1600, 2800, 4000, 5200])
      run.request({
        url: '/api/heartbeat',
        startedAt: at,
        endedAt: at + 20,
        ...(at === 5200 ? { windows: ['r2'] } : {}),
      });
    run.request({
      method: 'POST',
      url: '/api/records/lookup',
      body: { where: { field: 'label', cmp: 'EQ', arg: 'x' } },
      startedAt: 4620,
      endedAt: 4700,
      windows: ['r2'],
      listSize: 1,
    });
    // Une requête plus tardive, hors de la fenêtre : un lien faible, jamais une preuve du déclenchement.
    run.request({ url: '/api/side', startedAt: 5300, endedAt: 5320 });
    const analysis = run.analyze();
    expect(analysis.independent.filter((entry) => /periodic/.test(entry.reason))).toHaveLength(4);
    const refresh = analysis.correlations.find((entry) => entry.actionId === 'r2');
    expect(refresh).toMatchObject({ kind: 'TRIGGERED', state: 'VALIDATED' });
    expect(refresh?.secondary).toEqual(['n6']);
    expect(refresh?.evidence.join(' ')).toMatch(/secondary/);
  });

  it('8 — a delayed response stays linked by its start; while pending it is only PROVISIONAL', () => {
    const run = journey();
    run.event('click', 1000, 'Run');
    const slow = run.request({
      method: 'POST',
      url: '/api/report',
      body: { range: 'MONTH' },
      startedAt: 1080,
      windows: ['r1'],
    });
    const live = run.analyze('LIVE');
    expect(live.correlations[0]).toMatchObject({ actionId: 'r1', state: 'INFERRED' });
    expect(live.correlations[0]?.evidence).toContain('a response is still pending');
    expect(live.business[0]?.state).toBe('PROVISIONAL');
    slow.endedAt = 9000;
    slow.status = 200;
    slow.response = {};
    expect(run.analyze().correlations[0]).toMatchObject({ actionId: 'r1', state: 'VALIDATED' });
  });

  it('two actions equally close: an AMBIGUOUS candidate link, never a confirmed one', () => {
    const run = journey();
    run.event('click', 1000, 'A');
    run.event('click', 1010, 'B');
    run.request({ url: '/api/x', startedAt: 1250, endedAt: 1300 });
    const analysis = run.analyze();
    expect(analysis.correlations[0]).toMatchObject({
      kind: 'AMBIGUOUS',
      state: 'PROVISIONAL',
      candidates: ['r1'],
    });
    expect(analysis.inconsistencies.map((entry) => entry.kind)).toContain('AMBIGUOUS_CORRELATION');
  });
});

describe('Business operations, field mappings, live → consolidated', () => {
  /** Un parcours de recherche : saisie, clic, POST de critères, liste en réponse. */
  const search = (run: ReturnType<typeof journey>, at: number, typed: string, answered = true) => {
    const fill = run.event('input', at, 'Organisation name', typed);
    const click = run.event('click', at + 200, 'Search');
    const entry = run.request({
      method: 'POST',
      url: '/api/directory/lookup?pageIndex=0&pageSize=25',
      body: { filters: { logic: 'AND', terms: [{ prop: 'displayTitle', op: 'CONTAINS', val: typed }] } },
      startedAt: at + 250,
      windows: [click.id],
      ...(answered ? { endedAt: at + 400, listSize: 1, records: [{ displayTitle: typed }] } : {}),
    });
    return { fill, click, entry };
  };

  it('2 — POST with criteria + a collection served = SEARCH (the method is not the intent)', () => {
    const run = journey();
    search(run, 1000, 'Northwind');
    const business = run.analyze().business[0];
    expect(business).toMatchObject({ operation: 'SEARCH', state: 'VALIDATED' });
    expect(business?.evidence.join(' ')).toMatch(/sent by POST: the method is not the intent/);
    expect(business?.criteria[0]).toMatchObject({ property: 'displayTitle', operator: 'CONTAINS' });
    expect(business?.pagination?.size?.value).toBe(25);
  });

  it('field ↔ property: one exact match INFERRED; observed twice consistently VALIDATED; a different case NORMALIZED', () => {
    const run = journey();
    search(run, 1000, 'Northwind');
    let mapping = run.analyze().fieldMappings[0];
    expect(mapping).toMatchObject({
      uiLabel: 'Organisation name',
      property: 'displayTitle',
      jsonPath: 'filters.terms[].val',
      transformation: 'EXACT',
      state: 'INFERRED',
    });
    search(run, 5000, 'Contoso');
    mapping = run.analyze().fieldMappings[0];
    expect(mapping).toMatchObject({ state: 'VALIDATED', occurrences: ['r1', 'r3'] });
    // L'API reçoit la valeur en minuscules : la même donnée, transformée.
    const other = journey();
    other.event('input', 1000, 'Code', 'AB Corp');
    other.event('click', 1100, 'Go');
    other.request({
      method: 'POST',
      url: '/api/x',
      body: { k: 'ab corp' },
      startedAt: 1150,
      endedAt: 1200,
      windows: ['r2'],
      listSize: 0,
    });
    expect(other.analyze().fieldMappings[0]).toMatchObject({ transformation: 'NORMALIZED', property: 'k' });
  });

  it('a field sent as two different properties: PROVISIONAL with candidates + MAPPING_CONFLICT', () => {
    const run = journey();
    run.event('input', 1000, 'Name', 'Alpha');
    run.event('click', 1100, 'Search');
    run.request({
      method: 'POST',
      url: '/api/a',
      body: { title: 'Alpha' },
      startedAt: 1150,
      endedAt: 1200,
      windows: ['r2'],
      listSize: 1,
    });
    run.event('input', 3000, 'Name', 'Beta');
    run.event('click', 3100, 'Search');
    run.request({
      method: 'POST',
      url: '/api/a',
      body: { label: 'Beta' },
      startedAt: 3150,
      endedAt: 3200,
      windows: ['r4'],
      listSize: 1,
    });
    const analysis = run.analyze();
    expect(analysis.fieldMappings.every((mapping) => mapping.state === 'PROVISIONAL')).toBe(true);
    expect(analysis.inconsistencies.map((entry) => entry.kind)).toContain('MAPPING_CONFLICT');
  });

  it('9 + 10 — live (response pending) then consolidated: the hypothesis is revised with its justification', () => {
    const run = journey();
    const { entry } = search(run, 1000, 'Northwind', false);
    const live = run.analyze('LIVE');
    expect(live.business[0]).toMatchObject({ operation: 'SEARCH', state: 'PROVISIONAL' });
    entry.endedAt = 1500;
    entry.status = 200;
    entry.response = { listSize: 1, records: records([{ displayTitle: 'Northwind' }]) };
    const consolidated = run.analyze('CONSOLIDATED', live);
    expect(consolidated.business[0]).toMatchObject({ operation: 'SEARCH', state: 'VALIDATED' });
    expect(consolidated.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'BUSINESS', from: 'SEARCH PROVISIONAL', to: 'SEARCH VALIDATED' }),
        expect.objectContaining({
          subject: 'CORRELATION',
          from: 'TRIGGERED INFERRED',
          to: 'TRIGGERED VALIDATED',
        }),
      ]),
    );
    expect(consolidated.revisions.every((revision) => revision.reason.length > 0)).toBe(true);
    // Les événements bruts ne sont jamais modifiés par l'analyse.
    expect(run.events[0]?.value?.digest).toBe(digest('Northwind'));
  });

  it('live and consolidated converge when the evidence is the same', () => {
    const run = journey();
    search(run, 1000, 'Northwind');
    search(run, 5000, 'Contoso');
    const live = run.analyze('LIVE');
    const consolidated = run.analyze('CONSOLIDATED', live);
    const comparable = (analysis: RecordingAnalysis) => ({
      correlations: analysis.correlations,
      business: analysis.business,
      fieldMappings: analysis.fieldMappings,
    });
    expect(comparable(consolidated)).toEqual(comparable(live));
    expect(consolidated.revisions).toEqual([]);
  });

  it('11 — without any AI the analysis is complete; an AI proposal only fills an UNKNOWN operation, as a hypothesis', () => {
    const run = journey();
    run.event('click', 1000, 'Do');
    run.request({ method: 'PATCH', url: '/api/thing', startedAt: 1100, windows: ['r1'] });
    search(run, 3000, 'Northwind');
    const plain = run.analyze();
    expect(plain.status).toBe('COMPLETE');
    expect(plain.business.map((entry) => entry.operation)).toEqual(['UNKNOWN', 'SEARCH']);
    const proposed = analyzeRecording({
      mode: 'CONSOLIDATED',
      events: run.events,
      network: run.network,
      operationProposals: new Map([
        ['n1', 'UPDATE'],
        ['n2', 'DELETE'],
      ]),
    });
    expect(proposed.business[0]).toMatchObject({ operation: 'UPDATE', state: 'PROVISIONAL' });
    // Une opération déjà établie ne change jamais sur proposition.
    expect(proposed.business[1]?.operation).toBe('SEARCH');
  });

  it('14 — an error during the analysis: reported, the raw events and the journal untouched', () => {
    const run = journey();
    run.event('click', 1000, 'Go');
    const broken = run.request({ url: '/api/x', startedAt: 1100, endedAt: 1200, windows: ['r1'] });
    const before = JSON.stringify({ events: run.events, network: run.network });
    // Une structure illisible : lire ses critères lève une erreur au milieu de l'analyse.
    Object.defineProperty(broken.request, 'criteria', {
      get: () => {
        throw new Error('unreadable structure');
      },
    });
    const analysis = run.analyze();
    expect(analysis.status).toBe('FAILED');
    expect(analysis.errors[0]).toBeTruthy();
    expect(analysis.summary).toMatchObject({ events: 1, network: 1 });
    expect(analysis.errors[0]).toMatch(/unreadable structure/);
    expect(JSON.stringify({ events: run.events })).toBe(
      JSON.stringify({ events: (JSON.parse(before) as { events: unknown }).events }),
    );
    expect(run.network).toHaveLength(1);
  });

  it('15 — creation then search: criteria carry the created data; results carry it; no result → explained, not a defect', () => {
    const run = journey();
    run.event('input', 1000, 'Organisation name', 'Northwind');
    run.event('click', 1100, 'Save');
    run.request({
      method: 'POST',
      url: '/api/orgs',
      body: { orgName: 'Northwind', region: 'EAST' },
      startedAt: 1150,
      endedAt: 1300,
      windows: ['r2'],
      newIdentity: true,
    });
    search(run, 4000, 'Northwind');
    const analysis = run.analyze();
    const found = analysis.business.find((entry) => entry.operation === 'SEARCH');
    expect(found?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'SEARCH_AFTER_CREATE',
          match: 'EXACT',
          properties: ['displayTitle'],
        }),
        expect.objectContaining({ type: 'RESULT_MATCHES_CREATE' }),
      ]),
    );
    // La même recherche sans résultat, avec un critère de plus : expliquée, jamais un défaut.
    const empty = journey();
    empty.event('click', 1100, 'Save');
    empty.request({
      method: 'POST',
      url: '/api/orgs',
      body: { orgName: 'Northwind' },
      startedAt: 1150,
      endedAt: 1300,
      windows: ['r1'],
      newIdentity: true,
    });
    empty.event('click', 4000, 'Search');
    empty.request({
      method: 'POST',
      url: '/api/orgs/find',
      body: {
        op: 'AND',
        terms: [
          { prop: 'orgName', op: 'EQUALS', val: 'Northwind' },
          { prop: 'ownerRef', op: 'EQUALS', val: 'team-77' },
        ],
      },
      startedAt: 4050,
      endedAt: 4200,
      windows: ['r2'],
      listSize: 0,
    });
    const none = empty.analyze();
    expect(none.inconsistencies.find((entry) => entry.kind === 'NO_RESULT_AFTER_CREATE')?.message).toMatch(
      /not a defect by itself: additional criteria \(ownerRef\)/,
    );
  });

  it('12 — persistence: validated mappings are kept per application; nothing is written when not asked', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-http-knowledge-'));
    const store = new FunctionalKnowledgeStore(dir, { application: 'app-x' });
    await store.load();
    store.rememberFieldMappings([
      {
        key: '/search|Name|filters.terms[].val',
        uiLabel: 'Name',
        property: 'displayTitle',
        jsonPath: 'filters.terms[].val',
        screen: '/search',
        api: 'POST /api/directory/lookup',
        operation: 'SEARCH',
        transformation: 'EXACT',
        recordingSessionId: 'rec-1',
      },
    ]);
    await store.save([]);
    const reloaded = new FunctionalKnowledgeStore(dir, { application: 'app-x' });
    await reloaded.load();
    expect(reloaded.fieldMappings()).toEqual([
      expect.objectContaining({ property: 'displayTitle', confirmations: 1 }),
    ]);
    // Une autre application ne voit pas ces connaissances.
    const other = new FunctionalKnowledgeStore(dir, { application: 'app-y' });
    await other.load();
    expect(other.fieldMappings()).toEqual([]);
    // Le fichier ne contient aucune valeur saisie.
    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
    const text = await readFile(path.join(dir, files[0] ?? ''), 'utf8');
    expect(text).not.toContain('Northwind');
  });
});
