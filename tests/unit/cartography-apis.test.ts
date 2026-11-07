import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  CartographyConfig,
  CartographyModel,
  MapDecision,
  MapNode,
} from '../../src/sdk/core/cartography.js';
import { applyApiDecisions, buildApis, humanizeClass, maskUrl } from '../../src/cartography/apis.js';
import { applyDecisions } from '../../src/cartography/decisions.js';
import { apiSheet, buildIndex, queryApis, type CoverageContext } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * Le catalogue des API sur le scan réel du mini-projet : une API interne par contrôleur servi, une API
 * externe par hôte lu dans la configuration, un appel à URL dynamique « à classifier » ; des identifiants
 * stables, un renommage métier qui ne touche pas au code, des comptes calculés sur les seules données.
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
const EXTERNAL = 'API:EXTERNAL:https://api.partner.example';
const REQUESTS = 'API:INTERNAL:backend:RequestController';
const empty: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
let model: CartographyModel;

beforeAll(async () => {
  model = (await runScan({ config, allowedRoots: [FIXTURE], incremental: false })).model;
});

describe('classification of the APIs from evidence', () => {
  it('one internal API per serving controller, one external per host, the dynamic call to classify', () => {
    const apis = model.apis ?? [];
    expect(apis.map((a) => [a.scope, a.technicalName]).sort()).toEqual([
      ['EXTERNAL', 'PartnerVerificationClient'],
      ['INTERNAL', 'CompanyBffController'],
      ['INTERNAL', 'CompanyController'],
      ['INTERNAL', 'RequestBffController'],
      ['INTERNAL', 'RequestController'],
      ['UNCLASSIFIED', 'PartnerVerificationClient'],
    ]);
    const requests = apis.find((a) => a.id === REQUESTS);
    expect(requests?.owner).toBe('BACKEND');
    expect(requests?.endpoints.map((e) => `${e.method ?? ''} ${e.path ?? ''}`)).toEqual([
      'POST /requests',
      'GET /requests/{id}',
      'PUT /requests/{id}',
      'POST /requests/{id}/validate',
    ]);
    // Le contrat réel et ce qu'il déclare de lui-même ; aucun lien de documentation n'y est inventé.
    expect(requests?.contract).toMatchObject({
      file: 'openapi.yaml',
      version: '1.0.0',
      format: 'OpenAPI 3.0.3',
    });
    expect(requests?.contract?.documentation).toBeUndefined();
    // Les appels qui arrivent du BFF, avec leur confiance (adresse lue dans la configuration).
    expect(requests?.calls.map((c) => c.layer)).toEqual(['BFF', 'BFF', 'BFF']);
    // Deux contrôleurs « Company » (BFF et Backend) : deux API, jamais fusionnées sur le nom.
    expect(apis.filter((a) => a.technicalName.startsWith('Company')).map((a) => a.id)).toHaveLength(2);
  });

  it('the external API: host and configuration key, masked base URL, exchanged fields both ways', () => {
    const partner = model.apis?.find((a) => a.id === EXTERNAL);
    expect(partner).toMatchObject({
      scope: 'EXTERNAL',
      provider: 'api.partner.example',
      baseUrl: 'https://api.partner.example',
      properties: ['partner.url'],
      clients: ['RestTemplate'],
      status: 'DETECTED',
      confidence: 'PROBABLE',
    });
    expect(partner?.endpoints.map((e) => `${e.method ?? ''} ${e.path ?? ''}`)).toEqual([
      'POST /v1/companies/verify',
    ]);
    expect(partner?.fields.map((f) => `${f.direction}:${f.container}.${f.name}`)).toEqual([
      'OUT:VerificationRequest.companyName',
      'IN:VerificationResult.companyId',
      'IN:VerificationResult.status',
      'IN:VerificationResult.errorCode',
    ]);
    expect(partner?.evidence[0]).toMatchObject({
      file: 'src/main/java/test/backend/PartnerVerificationClient.java',
      line: 21,
    });
  });

  it('an address computed at run time is « to classify », with the reason, never guessed', () => {
    const unknown = model.apis?.find((a) => a.scope === 'UNCLASSIFIED');
    expect(unknown?.status).toBe('TO_CLASSIFY');
    expect(unknown?.confidence).toBe('UNKNOWN');
    expect(unknown?.baseUrl).toBeUndefined();
    expect(unknown?.reasons[0]).toContain('calculée à l’exécution');
  });

  it('identifiers are stable from one scan to the next', async () => {
    const again = (await runScan({ config, allowedRoots: [FIXTURE], incremental: false })).model;
    expect((again.apis ?? []).map((a) => a.id).sort()).toEqual((model.apis ?? []).map((a) => a.id).sort());
  });

  it('sensitive parts of an address are masked; class names give readable proposals', () => {
    expect(maskUrl('https://user:secret@api.example/v1?api_key=abc&page=2&token=t')).toBe(
      'https://api.example/v1?api_key=***&page=2&token=***',
    );
    expect(humanizeClass('PartnerVerificationClient')).toBe('Partner Verification');
    expect(humanizeClass('RequestBffController')).toBe('Request');
  });
});

describe('decisions, queries and sheet', () => {
  const decision = (kind: MapDecision['kind'], target: string, value: string, at: string): MapDecision => ({
    id: `d-${at}`,
    at,
    kind,
    target,
    value,
  });

  it('a business rename keeps the identifier and the code; a classification is said to be manual', () => {
    const decided = applyApiDecisions(model.apis ?? [], [
      decision('RENAME_API', EXTERNAL, 'Company verification', '2026-11-05T01:00:00Z'),
      decision(
        'CLASSIFY_API',
        'API:UNCLASSIFIED:backend:PartnerVerificationClient',
        'EXTERNAL',
        '2026-11-05T01:01:00Z',
      ),
      decision('RENAME_API', 'API:NOPE', 'ignored', '2026-11-05T01:02:00Z'),
    ]);
    const renamed = decided.find((a) => a.id === EXTERNAL);
    expect(renamed?.name).toBe('Company verification');
    expect(renamed?.proposedName).toBe('API Partner Verification (externe)');
    expect(renamed?.technicalName).toBe('PartnerVerificationClient');
    const classified = decided.find((a) => a.id === 'API:UNCLASSIFIED:backend:PartnerVerificationClient');
    expect(classified).toMatchObject({ scope: 'EXTERNAL', classifiedByPerson: true });
    // Rejouées avec les autres décisions, sur le modèle entier.
    expect(
      applyDecisions(model, [decision('RENAME_API', EXTERNAL, 'X', '2026-11-05T02:00:00Z')]).apis?.find(
        (a) => a.id === EXTERNAL,
      )?.name,
    ).toBe('X');
  });

  it('the catalog: counts, scope, search, sort and pages computed on the real data', () => {
    const index = buildIndex(model);
    const all = queryApis(index, empty, { size: 2 });
    expect(all.counts).toEqual({ all: 6, internal: 4, external: 1, unclassified: 1 });
    expect(all.kpis).toMatchObject({ apis: 6, internal: 4, external: 1, endpoints: 11, features: 4 });
    expect(all.items).toHaveLength(2);
    expect(all.total).toBe(6);
    expect(queryApis(index, empty, { scope: 'EXTERNAL' }).items.map((r) => r.id)).toEqual([EXTERNAL]);
    expect(queryApis(index, empty, { q: '/validate' }).items.map((r) => r.id)).toEqual([REQUESTS]);
    expect(queryApis(index, empty, { sort: 'endpoints' }).items[0]?.id).toBe(REQUESTS);
  });

  it('the sheet: the demonstrated path from the screen to the partner, consumers, criticality, impact', () => {
    const sheet = apiSheet(buildIndex(model), empty, EXTERNAL);
    const layers = [...new Set(sheet?.path.nodes.map((n: MapNode) => n.layer))];
    expect(layers).toEqual(['FRONTEND', 'BFF', 'BACKEND']);
    expect(sheet?.path.nodes.at(-1)?.id).toContain('PartnerVerificationClient.verifyCompany');
    // Le passage BFF → Backend repose sur une adresse lue dans la configuration : probable.
    expect(sheet?.path.edges.some((e) => e.confidence === 'PROBABLE')).toBe(true);
    expect(sheet?.features.map((f) => [f.name, f.usage])).toEqual([
      ['Company form', ['POST /v1/companies/verify']],
    ]);
    expect(sheet?.criticality.level).toBe('MEDIUM');
    expect(sheet?.impact.demonstrated.dtos).toEqual(['VerificationRequest', 'VerificationResult']);
    expect(sheet?.graph.nodes.length).toBeLessThanOrEqual(60);
    expect(apiSheet(buildIndex(model), empty, 'API:NOPE')).toBeUndefined();
  });
});

describe('a large catalog', () => {
  it('groups hundreds of multi-endpoint controllers and answers a page quickly', () => {
    const nodes: MapNode[] = [];
    for (let c = 0; c < 400; c += 1)
      for (let e = 0; e < 5; e += 1)
        nodes.push({
          id: `API:svc:GET /c${String(c)}/e${String(e)}`,
          kind: 'API',
          layer: 'BACKEND',
          name: `GET /c${String(c)}/e${String(e)}`,
          detail: {
            httpMethod: 'GET',
            path: `/c${String(c)}/e${String(e)}`,
            handler: `Ctrl${String(c)}Controller.e${String(e)}`,
          },
          signature: '',
          evidence: [
            {
              kind: 'STATIC_CODE',
              sourceId: 'svc',
              file: `C${String(c)}.java`,
              line: e + 1,
              confidence: 'CONFIRMED',
            },
          ],
        });
    const base = { ...model, nodes, edges: [], features: [], concepts: [], issues: [] };
    const started = performance.now();
    const apis = buildApis(base, [{ sourceId: 'svc', layer: 'BACKEND' }]);
    expect(apis).toHaveLength(400);
    expect(apis.every((a) => a.endpoints.length === 5)).toBe(true);
    const index = buildIndex({ ...base, apis });
    const page = queryApis(index, empty, { q: 'ctrl12', size: 20 });
    expect(page.total).toBe(11);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
