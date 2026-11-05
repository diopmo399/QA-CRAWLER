import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  CartographyConfig,
  CartographyModel,
  Feature,
  FieldConcept,
  MapEdge,
  MapNode,
} from '../../src/sdk/core/cartography.js';
import { computeCoverage, proposeLinks, type ScenarioInput } from '../../src/cartography/coverage.js';
import {
  buildIndex,
  featureFields,
  fieldSheet,
  neighbours,
  queryConcepts,
  queryFeatures,
  type CoverageContext,
  type MapIndex,
} from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * L'exploration progressive sur le graphe réel du mini-projet, puis sur un volume synthétique : chaque
 * requête est bornée (une page, une fonctionnalité, un champ), aucune ne renvoie le graphe entier.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography');
const config: CartographyConfig = {
  schema: 1,
  sources: (
    [
      ['front', 'FRONTEND'],
      ['bff', 'BFF'],
      ['backend', 'BACKEND'],
      ['contracts', 'API'],
    ] as const
  ).map(([id, layer]) => ({ id, name: id, layer, path: path.join(FIXTURE, id), include: [], enabled: true })),
};
const scenario: ScenarioInput = {
  name: 'Create a request',
  file: 'create.yaml',
  flow: {
    name: 'Create a request',
    startAt: '/requests/new',
    steps: [
      { fill: { label: 'Company name', value: 'x' } },
      { expect: { response: { method: 'POST', url: '/api/requests', status: 201 } } },
    ],
  },
};

let index: MapIndex;
let cov: CoverageContext;
const COMPANY = 'FIELD:front:RequestCreateComponent#form.companyName';

beforeAll(async () => {
  const { model } = await runScan({ config, allowedRoots: [FIXTURE], incremental: false });
  index = buildIndex(model);
  const links = proposeLinks(model, [scenario]);
  const result = computeCoverage(model, links, new Map(), [], [scenario]);
  cov = {
    links,
    coverage: new Map(result.coverage.map((c) => [c.feature, c])),
    issues: result.issues,
    lastRuns: new Map(),
    decisions: [],
  };
});

describe('progressive exploration on the reference project', () => {
  it('level 1: features are paged, searched, filtered and sorted on the server', () => {
    const first = queryFeatures(index, cov, { size: 2 });
    expect(first.total).toBe(4);
    expect(first.items).toHaveLength(2);
    const second = queryFeatures(index, cov, { size: 2, page: 2 });
    expect(second.items.map((r) => r.name)).not.toEqual(first.items.map((r) => r.name));
    expect(queryFeatures(index, cov, { q: 'edit' }).items.map((r) => r.name)).toEqual(['Request edit']);
    expect(queryFeatures(index, cov, { module: 'companies' }).items.map((r) => r.name)).toEqual([
      'Company form',
    ]);
    const byFields = queryFeatures(index, cov, { sort: 'fields' }).items;
    expect(byFields[0]?.name).toBe('Request create');
    const create = byFields[0];
    expect(create?.scenarios).toBe(1);
    expect(create?.reuse).toBeGreaterThan(0);
    // Une page hors limites revient à la dernière ; une taille hors limites est bornée.
    expect(queryFeatures(index, cov, { page: 99, size: 3 }).page).toBe(2);
    expect(queryFeatures(index, cov, { size: 10_000 }).size).toBe(100);
  });

  it('level 2: only the fields of one feature, one row per data concept', () => {
    const create = queryFeatures(index, cov, { q: 'Request create' }).items[0]?.id ?? '';
    const page = featureFields(index, cov, create, { size: 50 });
    const company = page?.items.find((r) => r.id === COMPANY);
    expect(company).toMatchObject({
      label: 'Company name',
      reuse: 3,
      status: 'PROBABLE',
      tested: 'ASSOCIATED',
    });
    expect(company?.layers).toEqual(
      expect.arrayContaining(['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE']),
    );
    // Le champ de l'autre écran n'est pas une ligne de plus : il appartient au même concept.
    expect(page?.items.some((r) => r.id === 'FIELD:front:RequestEditComponent#form.companyName')).toBe(false);
    expect(featureFields(index, cov, create, { q: 'email' })?.items.map((r) => r.label)).toEqual([
      'Contact email',
    ]);
    expect(featureFields(index, cov, create, { size: 2 })?.items).toHaveLength(2);
    expect(featureFields(index, cov, 'FEATURE:missing', {})).toBeUndefined();
  });

  it('level 3: the sheet of one field, with its bounded subgraph, sequence, reuse, scenarios and impact', () => {
    const sheet = fieldSheet(index, cov, COMPANY);
    expect(sheet?.concept.name).toBe('Company name');
    expect(sheet?.graph.truncated).toBe(false);
    expect(sheet?.graph.nodes.length).toBeLessThanOrEqual(60);
    expect(sheet?.graph.nodes.some((n) => n.id === 'COLUMN:backend:Request.organizationName')).toBe(true);
    // La séquence suit les couches : le premier lien part du frontal.
    expect(index.nodes.get(sheet?.sequence[0]?.from ?? '')?.layer).toBe('FRONTEND');
    expect(sheet?.reuse.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Request create', 'Request edit']),
    );
    // Homonyme : même nom, autre concept, jamais fusionné.
    expect(sheet?.concept.homonyms.map((h) => h.id)).toContain(
      'CONCEPT:FIELD:front:CompanyFormComponent#form.companyName',
    );
    expect(sheet?.scenarios).toEqual([
      expect.objectContaining({
        scenario: 'Create a request',
        origin: 'INFERRED',
        associated: true,
        executed: false,
        verified: false,
      }),
    ]);
    expect(sheet?.coverage).toMatchObject({ numerator: 1, denominator: 3, percent: 33 });
    const impact = sheet?.impact;
    expect(impact?.demonstrated.features.map((f) => f.name)).toContain('Request create');
    expect(impact?.demonstrated.components).toContain('RequestCreateComponent');
    expect(impact?.demonstrated.dtos).toEqual(
      expect.arrayContaining(['CreateRequest', 'CreateRequestDto', 'BackendRequestBody']),
    );
    // L'adresse du backend n'est que probable : la table est un impact potentiel, pas démontré.
    expect(impact?.demonstrated.tables).toEqual([]);
    expect(impact?.potential.tables).toContain('REQUEST.ORGANIZATION_NAME');
    expect(impact?.depth).toBeGreaterThan(2);
    expect(impact?.files.length).toBeGreaterThan(3);
    // Une limite basse coupe l'exploration et le dit.
    const small = fieldSheet(index, cov, COMPANY, { limit: 5 });
    expect(small?.graph.nodes).toHaveLength(5);
    expect(small?.graph.truncated).toBe(true);
    const around = neighbours(index, COMPANY, { depth: 1, limit: 3 });
    expect(around?.nodes.length).toBeLessThanOrEqual(3);
    expect(fieldSheet(index, cov, 'FIELD:none')).toBeUndefined();
  });

  it('concepts are searched by screen, API, table or scenario', () => {
    const byApi = queryConcepts(index, cov, { q: 'post /api/requests' }).items.map((c) => c.id);
    expect(byApi).toContain('CONCEPT:FIELD:front:RequestCreateComponent#form.companyName');
    expect(byApi).not.toContain('CONCEPT:FIELD:front:CompanyFormComponent#form.companyName');
    const byTable = queryConcepts(index, cov, { q: 'organization_name' }).items.map((c) => c.id);
    expect(byTable).toContain('CONCEPT:FIELD:front:RequestCreateComponent#form.companyName');
    const byScenario = queryConcepts(index, cov, { q: 'create a request' }).items.map((c) => c.id);
    expect(byScenario).toContain('CONCEPT:FIELD:front:RequestCreateComponent#form.companyName');
  });
});

/** Un graphe synthétique : des fonctionnalités, chacune avec ses champs reliés de couche en couche. */
function synthetic(featureCount: number, fieldsPerFeature: number): CartographyModel {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const features: Feature[] = [];
  const concepts: FieldConcept[] = [];
  const evidence = [
    { kind: 'STATIC_CODE' as const, sourceId: 's', file: 'f.ts', line: 1, confidence: 'CONFIRMED' as const },
  ];
  for (let f = 0; f < featureCount; f += 1) {
    const fields: string[] = [];
    for (let k = 0; k < fieldsPerFeature; k += 1) {
      const front = `FIELD:s:F${String(f)}#c${String(k)}`;
      const back = `FIELD:s:D${String(f)}.c${String(k)}`;
      nodes.push(
        {
          id: front,
          kind: 'FIELD',
          layer: 'FRONTEND',
          name: `c${String(k)}`,
          detail: { type: 'text' },
          signature: '',
          evidence,
        },
        {
          id: back,
          kind: 'FIELD',
          layer: 'BACKEND',
          name: `c${String(k)}`,
          detail: { type: 'String' },
          signature: '',
          evidence,
        },
      );
      edges.push({
        id: `SENDS:${front}->${back}`,
        from: front,
        to: back,
        kind: 'SENDS',
        confidence: 'CONFIRMED',
        reason: 'r',
        evidence,
      });
      fields.push(front, back);
      // Un champ sur dix est partagé avec la fonctionnalité suivante (réutilisation).
      const shared = k % 10 === 0 && f + 1 < featureCount;
      concepts.push({
        id: `CONCEPT:${front}`,
        name: `c${String(k)}`,
        fields: [front, back],
        features: shared ? [`FEATURE:${String(f)}`, `FEATURE:${String(f + 1)}`] : [`FEATURE:${String(f)}`],
        layers: ['FRONTEND', 'BACKEND'],
        status: 'CONFIRMED',
        gaps: [],
        homonyms: [],
      });
    }
    features.push({
      id: `FEATURE:${String(f)}`,
      name: `Feature ${String(f).padStart(5, '0')}`,
      proposedName: '',
      module: `m${String(f % 7)}`,
      status: 'CANDIDATE',
      layers: ['FRONTEND', 'BACKEND'],
      nodes: fields,
      fields,
      chain: [],
      basis: '',
      evidence: [],
      reach: Object.fromEntries(fields.map((id) => [id, 'CONFIRMED' as const])),
    });
  }
  return {
    schema: 1,
    scan: {
      id: 'scan-synthetic',
      schema: 1,
      startedAt: '2026-11-05T00:00:00Z',
      state: 'COMPLETED',
      incremental: false,
      sources: [],
      counts: {},
      edges: edges.length,
      errors: [],
    },
    nodes,
    edges,
    features,
    concepts,
    issues: [],
  };
}

describe('progressive exploration on a synthetic volume', () => {
  it('indexes tens of thousands of fields once, then answers each request with a bounded result', () => {
    const model = synthetic(2_000, 20);
    expect(model.nodes).toHaveLength(80_000);
    const started = performance.now();
    const big = buildIndex(model);
    const built = performance.now() - started;
    const empty: CoverageContext = {
      links: [],
      coverage: new Map(),
      issues: [],
      lastRuns: new Map(),
      decisions: [],
    };
    const timed = <T>(run: () => T): { value: T; ms: number } => {
      const start = performance.now();
      const value = run();
      return { value, ms: performance.now() - start };
    };
    const page = timed(() => queryFeatures(big, empty, { q: 'Feature 01', page: 2, size: 20 }));
    expect(page.value.total).toBe(1_000);
    expect(page.value.items).toHaveLength(20);
    const fields = timed(() => featureFields(big, empty, 'FEATURE:1500', { size: 10 }));
    expect(fields.value?.total).toBe(20);
    expect(fields.value?.items).toHaveLength(10);
    const sheet = timed(() => fieldSheet(big, empty, 'FIELD:s:F1500#c0', { limit: 50 }));
    expect(sheet.value?.reuse).toHaveLength(2);
    expect(sheet.value?.graph.nodes.length).toBeLessThanOrEqual(50);
    // Des bornes larges (machines de CI lentes) : l'index est construit une fois, les requêtes restent courtes.
    expect(built).toBeLessThan(10_000);
    expect(page.ms).toBeLessThan(1_000);
    expect(fields.ms).toBeLessThan(200);
    expect(sheet.ms).toBeLessThan(200);
    // Aucune requête ne renvoie plus que sa page.
    expect(JSON.stringify(fields.value).length).toBeLessThan(10_000);
  });
});
