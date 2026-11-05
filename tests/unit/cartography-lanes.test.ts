import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiSheet,
  CartographyConfig,
  MapConfidence,
  MapEdge,
  MapEdgeKind,
  MapLayer,
  MapNode,
  MapNodeKind,
} from '../../src/sdk/core/cartography.js';
import { apiSheet, buildIndex, type CoverageContext } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';
import { idList, readIds } from '../../src/sdk/ui/dashboard-cartography-graph.js';
import { mapStrings } from '../../src/sdk/ui/dashboard-cartography-i18n.js';
import {
  laneLegend,
  laneModel,
  lanesView,
  NO_FILTERS,
  type LaneModel,
} from '../../src/sdk/ui/dashboard-cartography-lanes.js';

/**
 * Le graphe enrichi d'une API, en couloirs : sur le scan réel du mini-projet de test (cinq composants
 * Angular, un BFF, un backend, un partenaire externe, une table), puis sur des cas construits (liens
 * parallèles, cycle, statuts mélangés). Chaque relation dessinée est une relation du scan ; les critères
 * masquent sans rien retirer de la liste exhaustive.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-graph');
const config: CartographyConfig = {
  schema: 1,
  sources: (
    [
      ['front', 'FRONTEND'],
      ['bff', 'BFF'],
      ['backend', 'BACKEND'],
    ] as const
  ).map(([id, layer]) => ({ id, name: id, layer, path: path.join(FIXTURE, id), include: [], enabled: true })),
};
const PARTNER = 'API:EXTERNAL:https://api.partner.example';
const none: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const m = mapStrings('fr');
let sheet: ApiSheet;

beforeAll(async () => {
  const model = (await runScan({ config, allowedRoots: [FIXTURE], incremental: false })).model;
  const found = apiSheet(buildIndex(model), none, PARTNER);
  if (!found) throw new Error('the partner API is not in the catalog');
  sheet = found;
});

const titles = (model: LaneModel, lane: string): string[] =>
  model.lanes.find((l) => l.id === lane)?.cards.map((c) => c.title) ?? [];

describe('the lane graph of the external partner API (real scan)', () => {
  it('lays the layers out as lanes, the external API and the database as distinct branches', () => {
    const model = laneModel(sheet, 'architecture');
    expect(model.lanes.map((l) => l.id)).toEqual(['FRONTEND', 'BFF', 'BACKEND', 'EXTERNAL', 'DATABASE']);
    expect(titles(model, 'FRONTEND')).toEqual(
      expect.arrayContaining([
        'CompanyCreateComponent',
        'CompanyDetailsComponent',
        'CompanyEditComponent',
        'CompanyFormComponent',
        'CompanySearchComponent',
        'CompanyService',
      ]),
    );
    expect(titles(model, 'BFF')).toEqual(
      expect.arrayContaining([
        'POST /api/companies',
        'POST /api/companies/search',
        'PUT /api/companies/current',
        'GET /api/companies/current',
        'CompanyBffService',
        'CompanyDto',
      ]),
    );
    expect(titles(model, 'BACKEND')).toEqual(
      expect.arrayContaining([
        'CompanyService',
        'PartnerVerificationClient',
        'CompanyController',
        'CompanyCommand',
      ]),
    );
    const external = model.lanes.find((l) => l.id === 'EXTERNAL')?.cards ?? [];
    expect(external.map((c) => c.title).sort()).toEqual([
      'GET /v2/partners/company/status',
      'POST /v2/partners/company/verify',
    ]);
    expect(external.every((c) => c.own && c.sub === 'api.partner.example')).toBe(true);
    const table = model.lanes.find((l) => l.id === 'DATABASE')?.cards[0];
    expect(table?.title).toBe('COMPANY');
    expect(table?.members.map((x) => x.text)).toEqual(['ID', 'COMPANY_NAME', 'STATUS', 'VERIFICATION_DATE']);
  });

  it('groups a class with its methods, a component with its fields; homonyms stay apart', () => {
    const model = laneModel(sheet, 'architecture');
    const services = [...model.cards.values()].filter((c) => c.title === 'CompanyService');
    expect(services.map((c) => c.lane).sort()).toEqual(['BACKEND', 'FRONTEND']);
    expect(services.find((c) => c.lane === 'BACKEND')?.members.map((x) => x.text)).toEqual(
      expect.arrayContaining(['createCompany()', 'updateCompany()']),
    );
    const form = [...model.cards.values()].find((c) => c.title === 'CompanyFormComponent');
    const edit = [...model.cards.values()].find((c) => c.title === 'CompanyEditComponent');
    expect(form?.members.map((x) => x.text)).toEqual(['companyName', 'companyId']);
    // Le même nom de champ dans deux composants : deux membres distincts, jamais fusionnés.
    const formName = form?.members.find((x) => x.text === 'companyName')?.id;
    const editName = edit?.members.find((x) => x.text === 'companyName')?.id;
    expect(formName).toBeDefined();
    expect(formName).not.toBe(editName);
  });

  it('aggregates parallel relations into bundles with their counts, colours by nature, status apart', () => {
    const model = laneModel(sheet, 'architecture');
    const bundles = Object.fromEntries(model.bundles.map((b) => [b.key, b]));
    expect(Object.keys(bundles).sort()).toEqual([
      'BACKEND>DATABASE>db',
      'BACKEND>EXTERNAL>external',
      'BFF>BACKEND>flow',
      'FRONTEND>BFF>flow',
    ]);
    expect(bundles['FRONTEND>BFF>flow']?.count).toBe(4);
    expect(bundles['FRONTEND>BFF>flow']?.statuses).toEqual({ CONFIRMED: 4, PROBABLE: 0, UNKNOWN: 0 });
    // Les appels du BFF vers le backend sont reconstruits (URL issue de la configuration) : probables.
    expect(bundles['BFF>BACKEND>flow']?.statuses).toEqual({ CONFIRMED: 0, PROBABLE: 4, UNKNOWN: 0 });
    expect(bundles['BACKEND>EXTERNAL>external']?.count).toBe(2);
    expect(bundles['BACKEND>DATABASE>db']?.count).toBe(4);
  });

  it('draws only relations of the scan (or outgoing calls it established) and lists them all', () => {
    const model = laneModel(sheet, 'architecture');
    const known = new Set(sheet.graph.edges.map((e) => e.id));
    const outbound = new Set(sheet.outbound.map((c) => `EXTCALL:${c.from}>${c.endpoint}`));
    for (const e of [...model.shown, ...model.inner])
      expect(known.has(e.id) || outbound.has(e.id)).toBe(true);
    // Chaque relation de la vue est soit dessinée (faisceau ou lien interne au couloir), soit interne à une carte.
    const internal = model.lanes.flatMap((l) => l.internal.flatMap((link) => link.edges));
    const bundled = model.bundles.flatMap((b) => b.links.flatMap((l) => l.edges));
    expect(bundled.length + internal.length).toBe(model.shown.length);
    expect(model.shown.length + model.inner.length).toBe(model.all.length);
    const legend = laneLegend(m, model);
    expect(legend).toContain(`Total : ${String(model.shown.length)} relations`);
  });

  it('filters hide lanes, natures, statuses and depth without removing anything from the list', () => {
    const all = laneModel(sheet, 'architecture');
    const noBff = laneModel(sheet, 'architecture', { ...NO_FILTERS, lanes: ['BFF'] });
    expect(noBff.lanes.map((l) => l.id)).not.toContain('BFF');
    expect(noBff.bundles.some((b) => b.from === 'BFF' || b.to === 'BFF')).toBe(false);
    expect(noBff.all.length).toBe(all.all.length);
    const confirmed = laneModel(sheet, 'architecture', { ...NO_FILTERS, statuses: ['PROBABLE', 'UNKNOWN'] });
    expect(confirmed.shown.every((e) => e.confidence === 'CONFIRMED')).toBe(true);
    expect(confirmed.bundles.map((b) => b.key)).not.toContain('BFF>BACKEND>flow');
    const near = laneModel(sheet, 'architecture', { ...NO_FILTERS, depth: 1 });
    expect([...near.cards.values()].map((c) => c.title).sort()).toEqual([
      'GET /v2/partners/company/status',
      'POST /v2/partners/company/verify',
      'PartnerVerificationClient',
    ]);
    const noExternal = laneModel(sheet, 'architecture', { ...NO_FILTERS, natures: ['external'] });
    expect(noExternal.bundles.map((b) => b.nature)).not.toContain('external');
  });

  it('the data view shows field flows and the fields exchanged with each external endpoint', () => {
    const model = laneModel(sheet, 'data');
    expect(
      model.shown.every(
        (e) =>
          e.id.startsWith('EXTCALL:') ||
          ['SENDS', 'TRANSFORMS', 'READS', 'WRITES', 'INPUTS', 'DISPLAYS'].includes(e.kind),
      ),
    ).toBe(true);
    const verify = [...model.cards.values()].find((c) => c.title === 'POST /v2/partners/company/verify');
    expect(verify?.members.map((x) => `${x.kind}:${x.text}`)).toEqual([
      'out:companyName',
      'in:verified',
      'in:status',
    ]);
    const status = [...model.cards.values()].find((c) => c.title === 'GET /v2/partners/company/status');
    expect(status?.members.map((x) => `${x.kind}:${x.text}`)).toEqual(['in:verified', 'in:status']);
    expect(model.viewHidden).toBeGreaterThan(0);
  });

  it('renders lanes, cards, bundles with counters and arrow markers; unfolding draws one route per pair', () => {
    const model = laneModel(sheet, 'architecture');
    const options = { m, sheet, model, openCards: new Set<string>(), openBundles: new Set<string>() };
    const view = lanesView(options);
    expect(view.html).not.toContain('NaN');
    expect(view.html.match(/class="ln-lane /g)).toHaveLength(5);
    expect(view.html).toContain('>4 liens<');
    expect(view.html).toContain('marker-end="url(#ln-arrow-external)"');
    expect(view.html).toContain('marker-end="url(#ln-arrow-db)"');
    const folded = (view.html.match(/class="ln-e /g) ?? []).length;
    const unfolded = lanesView({ ...options, openBundles: new Set(['BFF>BACKEND>flow']) });
    expect((unfolded.html.match(/class="ln-e /g) ?? []).length).toBe(folded + 3);
    // Une carte ouverte montre tous ses membres (et grandit).
    const service = [...model.cards.values()].find((c) => c.title === 'CompanyBffService');
    const open = lanesView({ ...options, openCards: new Set([service?.key ?? '']) });
    expect(open.html).toContain('loadCompany()');
    expect(view.html).not.toContain('loadCompany()');
    expect(open.height).toBeGreaterThanOrEqual(view.height);
  });
});

// ── Cas construits ──────────────────────────────────────────────────────────────────────────────

let seq = 0;
const node = (
  id: string,
  kind: MapNodeKind,
  layer: MapLayer,
  name: string,
  detail: MapNode['detail'] = {},
): MapNode => ({
  id,
  kind,
  layer,
  name,
  detail,
  signature: '',
  evidence: [{ kind: 'STATIC_CODE', file: `${name}.java`, line: 1, confidence: 'CONFIRMED' }],
});
const edge = (from: string, to: string, kind: MapEdgeKind, confidence: MapConfidence): MapEdge => ({
  id: `${kind}:${from}>${to}#${String((seq += 1))}`,
  from,
  to,
  kind,
  confidence,
  reason: 'test',
  evidence: [{ kind: 'STATIC_CODE', file: 'x.java', line: 2, confidence }],
});
const built = (nodes: MapNode[], edges: MapEdge[]): ApiSheet => ({
  api: {
    id: 'API:INTERNAL:backend:OrderController',
    name: 'Orders',
    proposedName: 'Orders',
    technicalName: 'OrderController',
    scope: 'INTERNAL',
    consumers: [],
    properties: [],
    clients: [],
    endpoints: [
      {
        id: 'API:backend:POST /orders',
        node: 'API:backend:POST /orders',
        confidence: 'CONFIRMED',
        evidence: [],
      },
    ],
    calls: [],
    fields: [],
    status: 'DETECTED',
    confidence: 'CONFIRMED',
    reasons: [],
    evidence: [],
  },
  features: [],
  scenarios: [],
  path: { nodes: [], edges: [] },
  graph: { nodes, edges, depth: 6, limit: 300, truncated: false },
  outbound: [],
  impact: {
    demonstrated: { features: [], scenarios: [], components: [], dtos: [] },
    potential: { features: [], scenarios: [], components: [], dtos: [] },
  },
  criticality: { level: 'LOW', reason: '' },
  scanId: 'scan-test',
});

describe('lane graphs built for the edge cases', () => {
  const bffA = node('METHOD:bff:A.java#OrderBff.place', 'METHOD', 'BFF', 'OrderBff.place', {
    owner: 'OrderBff',
  });
  const bffB = node('METHOD:bff:A.java#OrderBff.cancel', 'METHOD', 'BFF', 'OrderBff.cancel', {
    owner: 'OrderBff',
  });
  const ep = node('API:backend:POST /orders', 'API', 'BACKEND', 'POST /orders', {
    httpMethod: 'POST',
    path: '/orders',
    handler: 'OrderController.place',
  });
  const back = node('METHOD:backend:B.java#OrderService.notify', 'METHOD', 'BACKEND', 'OrderService.notify', {
    owner: 'OrderService',
  });

  it('parallel relations between the same two cards form one link with its count; mixed statuses are counted apart', () => {
    const sheetBuilt = built(
      [bffA, bffB, ep],
      [edge(bffA.id, ep.id, 'CALLS', 'CONFIRMED'), edge(bffB.id, ep.id, 'CALLS', 'PROBABLE')],
    );
    const model = laneModel(sheetBuilt, 'architecture');
    expect(model.bundles).toHaveLength(1);
    const bundle = model.bundles[0];
    expect(bundle?.links).toHaveLength(1);
    expect(bundle?.count).toBe(2);
    expect(bundle?.statuses).toEqual({ CONFIRMED: 1, PROBABLE: 1, UNKNOWN: 0 });
    expect(bundle?.confidence).toBe('PROBABLE');
    const html = lanesView({
      m,
      sheet: sheetBuilt,
      model,
      openCards: new Set(),
      openBundles: new Set(),
    }).html;
    expect(html).toContain('>2 liens<');
    // Le statut est montré à part (tirets, avertissement), pas par la couleur de la nature.
    expect(html).toContain('st-probable');
    expect(html).toContain('ln-bw');
  });

  it('a cycle between two lanes gives two bundles, the return one routed apart; depth stays finite', () => {
    const sheetBuilt = built(
      [bffA, ep, back],
      [edge(bffA.id, ep.id, 'CALLS', 'CONFIRMED'), edge(back.id, bffA.id, 'CALLS', 'PROBABLE')],
    );
    const model = laneModel(sheetBuilt, 'architecture');
    expect(model.bundles.map((b) => b.key).sort()).toEqual(['BACKEND>BFF>flow', 'BFF>BACKEND>flow']);
    expect([...model.cards.values()].every((c) => Number.isFinite(c.depth))).toBe(true);
    const view = lanesView({ m, sheet: sheetBuilt, model, openCards: new Set(), openBundles: new Set() });
    expect(view.html).not.toContain('NaN');
    expect(view.html.match(/class="ln-e /g)).toHaveLength(2);
  });

  it('relation identifiers with spaces survive the round trip through an attribute', () => {
    const ids = [
      'CALLS:METHOD:front:S#create>API:bff:POST /api/x',
      'EXTCALL:a>API:EXTERNAL:https://h|GET /y',
    ];
    expect(readIds(idList(ids))).toEqual(ids);
    expect(idList(ids)).not.toMatch(/ \/api/);
  });
});
