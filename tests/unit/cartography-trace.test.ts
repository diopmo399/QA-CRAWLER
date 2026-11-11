import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  CartographyConfig,
  CartographyModel,
  MapCorrelation,
  MapEdge,
  MapLayer,
} from '../../src/sdk/core/cartography.js';
import { buildIndex, traceOf, type MapIndex } from '../../src/cartography/explorer.js';
import { classifyQuery } from '../../src/cartography/data-access.js';
import { runScan } from '../../src/cartography/scan.js';
import { sourceConstants } from '../../src/incident/code/index.js';

/**
 * TRAÇABILITÉ DE BOUT EN BOUT. La fixture cartography-trace : un écran Angular (onglets imbriqués et
 * conditionnels, un signal local, un appel jamais souscrit), un store RxJS dont la validation asynchrone
 * enchaîne deux dispatch sous condition, un backend Spring (interface de routes à import statique, contrôleur
 * qui l'implémente, constantes d'une autre classe, service partagé par plusieurs endpoints, dépôt JPA avec
 * @Query, EntityManager et JDBC). Les cas déjà couverts par d'autres fixtures (store maison, client généré,
 * BFF, contrats, profils) y sont relus sous l'angle du parcours. Rien n'est exécuté.
 */
const fixture = (name: string): string => path.resolve('tests/fixtures', name);
const configOf = (root: string, sources: readonly (readonly [string, MapLayer])[]): CartographyConfig => ({
  schema: 1,
  sources: sources.map(([id, layer]) => ({
    id,
    name: id,
    layer,
    path: path.join(root, id),
    include: [],
    enabled: true,
  })),
});
const TRACE = fixture('cartography-trace');
const traceSources = [
  ['front', 'FRONTEND'],
  ['backend', 'BACKEND'],
] as const;
const scanOf = async (root: string, sources: readonly (readonly [string, MapLayer])[]) =>
  (await runScan({ incremental: false, allowedRoots: [root], config: configOf(root, sources) })).model;

let trace: CartographyModel;
let contract: CartographyModel;
let config: CartographyModel;
let rxjs: CartographyModel;
let index: MapIndex;

const PAGE = 'CommandesPageComponent';
const java = (file: string, member: string): string =>
  `METHOD:backend:src/main/java/com/ex/commandes/${file}.java#${file.split('/').pop() ?? ''}.${member}`;
const edgeOf = (model: CartographyModel, kind: string, from: string, to: string): MapEdge | undefined =>
  model.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
const corr = (model: CartographyModel, from: string): MapCorrelation | undefined =>
  model.correlations?.find((c) => c.from === from);
const codes = (c?: MapCorrelation): string[] => c?.causes.map((x) => x.code) ?? [];
const down = (id: string, options: Parameters<typeof traceOf>[2] = {}) =>
  traceOf(index, id, { direction: 'DOWN', ...options });
const ids = (t: { nodes: { id: string }[] } | undefined): string[] => t?.nodes.map((n) => n.id) ?? [];

beforeAll(async () => {
  trace = await scanOf(TRACE, traceSources);
  index = buildIndex(trace);
  contract = await scanOf(fixture('cartography-contract'), [
    ['front', 'FRONTEND'],
    ['bff', 'BFF'],
    ['backend', 'BACKEND'],
    ['contracts', 'API'],
  ]);
  config = await scanOf(fixture('cartography-config'), [
    ['front', 'FRONTEND'],
    ['passerelle', 'OTHER'],
    ['bff', 'BFF'],
    ['backend', 'BACKEND'],
    ['archives', 'BACKEND'],
    ['referentiel', 'BACKEND'],
  ]);
  rxjs = await scanOf(fixture('cartography-rxjs'), [
    ['front', 'FRONTEND'],
    ['bff', 'BFF'],
  ]);
}, 120_000);

describe('Angular → endpoints', () => {
  it('1 — a direct HttpClient call reaches its endpoint; an ambiguous one is a break with its diagnostic', () => {
    const rx = buildIndex(rxjs);
    const ok = corr(rxjs, 'METHOD:front:ActivationService#status');
    expect(ok).toMatchObject({ status: 'CONFIRMED', target: 'API:bff:GET /api/activation/status' });
    expect(ids(traceOf(rx, ok?.from ?? '', { direction: 'DOWN' }))).toContain(ok?.target);
    const ambiguous = corr(rxjs, 'METHOD:front:ActivationService#items');
    expect(ambiguous?.target).toBeUndefined();
    expect(codes(ambiguous)).toContain('AMBIGUOUS');
    const t = traceOf(rx, ambiguous?.from ?? '', { direction: 'DOWN' });
    expect(t?.breaks.map((b) => [b.status, b.diagnostic?.start])).toEqual([
      ['UNDEMONSTRATED', ambiguous?.from],
    ]);
  });

  it('2 — a custom RxJS store carries the call of its service; a probable link is never confirmed', () => {
    const ix = buildIndex(contract);
    expect(
      edgeOf(
        contract,
        'CALLS',
        'METHOD:front:DemandeStore#valider',
        'METHOD:front:DemandesService#validerDemande',
      ),
    ).toBeDefined();
    const t = traceOf(ix, 'METHOD:front:DemandeStore#valider', { direction: 'DOWN' });
    expect(ids(t)).toContain('API:bff:POST /demandes/{demandeId}/validation');
    expect(t?.breaks.find((b) => b.node === 'METHOD:front:DemandesService#validerDemande')?.status).toBe(
      'PROBABLE',
    );
  });

  it('3 — an async validation then two dispatches: each after the result, under the read condition', () => {
    for (const action of ['ENREGISTRER', 'RAFRAICHIR']) {
      const e = edgeOf(
        trace,
        'CALLS',
        'METHOD:front:CommandeStore#validerEtEnregistrer',
        `METHOD:front:CommandeStore#dispatch⟨'${action}'⟩`,
      );
      expect(e?.confidence).toBe('CONFIRMED');
      expect(e?.detail?.condition).toBe('this.etat.value.valide');
      expect(e?.detail?.async).toBeDefined();
    }
    // Négatif : chaque dispatch n'emprunte que sa branche.
    expect(
      edgeOf(
        trace,
        'CALLS',
        "METHOD:front:CommandeStore#dispatch⟨'ENREGISTRER'⟩",
        'METHOD:front:CommandeApiService#lire',
      ),
    ).toBeUndefined();
    expect(
      edgeOf(
        trace,
        'CALLS',
        "METHOD:front:CommandeStore#dispatch⟨'RAFRAICHIR'⟩",
        'METHOD:front:CommandeApiService#creer',
      ),
    ).toBeUndefined();
  });

  it('4 — a dispatch without a known action keeps every branch probable, with its condition', () => {
    const creer = edgeOf(
      trace,
      'CALLS',
      'METHOD:front:CommandeStore#dispatch',
      'METHOD:front:CommandeApiService#creer',
    );
    expect(creer).toMatchObject({ confidence: 'PROBABLE', detail: { condition: "action = 'ENREGISTRER'" } });
    const lire = edgeOf(
      trace,
      'CALLS',
      'METHOD:front:CommandeStore#dispatch',
      'METHOD:front:CommandeApiService#lire',
    );
    expect(lire?.confidence).toBe('PROBABLE');
  });

  it('5 — nested tabs under a condition: upstream reaches the tab, the tab group and the screen', () => {
    const container = `CONTAINER:front:${PAGE}#container:onglets-confirmation-details`;
    const condition = `${container}:visible`.replace('CONTAINER:', 'CONDITION:');
    expect(edgeOf(trace, 'VISIBLE_WHEN', container, condition)?.reason).toContain(
      '(etat$ | async)?.enregistree',
    );
    const up = traceOf(index, container, { direction: 'UP' });
    const names = up?.nodes.map((n) => n.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining(['Saisie', 'Onglets : Saisie, Statistiques', PAGE, '/commandes']),
    );
    // Le flux qui pilote la condition est en AMONT du conteneur (il le rend visible) ; l'aval du conteneur ne
    // remonte jamais vers lui (une provenance n'est pas une étape d'exécution).
    expect(ids(up)).toEqual(expect.arrayContaining([condition, `STREAM:front:${PAGE}.etat$`]));
    expect(ids(down(container))).not.toContain(`STREAM:front:${PAGE}.etat$`);
  });

  it('6 — a button triggers its handler and the service the handler calls, down to the data read', () => {
    const button = `BUTTON:front:${PAGE}#button:compter`;
    expect(edgeOf(trace, 'TRIGGERS', button, 'METHOD:front:CommandeApiService#total')?.confidence).toBe(
      'CONFIRMED',
    );
    const t = down(button);
    expect(ids(t)).toEqual(
      expect.arrayContaining(['API:backend:GET /api/v1/stats/total', 'ENTITY:backend:Commande']),
    );
    expect(ids(t)).not.toContain('ENTITY:backend:table:commandes_archives');
    expect(t?.breaks).toEqual([]);
  });

  it('7 — a custom HTTP wrapper: the call is read through it; with no endpoint the break says what was sought', () => {
    const c = corr(contract, 'METHOD:front:HistoriqueService#archiver');
    expect(c?.status).toBe('UNDEMONSTRATED');
    expect(codes(c)).toContain('NO_ENDPOINT');
    expect(c?.diagnostic?.sought).toContain('POST /api/demandes/{param}/archive');
    expect(c?.diagnostic?.suggestions.length).toBeGreaterThan(0);
  });

  it('8 — a generated TypeScript client: probable link to the BFF operation, never confirmed', () => {
    const c = corr(contract, 'METHOD:front:DemandesService#validerDemande');
    expect(c).toMatchObject({ status: 'PROBABLE', target: 'API:bff:POST /demandes/{demandeId}/validation' });
    expect(c?.diagnostic?.lastDemonstrated).toBeDefined();
  });
});

describe('BFF, contracts, configuration', () => {
  it('9 + 14 — the BFF calls the Backend through a generated Java client; two contract versions keep it probable', () => {
    const c = contract.correlations?.find((x) => x.from.endsWith('DecisionGateway.transmettre'));
    expect(c).toMatchObject({ status: 'PROBABLE', target: 'API:backend:POST /decisions' });
    expect(c?.steps.slice(0, 2).map((s) => s.kind)).toEqual(['OUTGOING', 'GENERATION']);
    expect(codes(c)).toContain('CONTRACT_VERSION_UNKNOWN');
  });

  it('12 — an OpenAPI operation without generated code: the endpoint is deduced, never confirmed', () => {
    const c = corr(contract, 'METHOD:front:DemandesService#lireDemande');
    expect(c?.status).toBe('PROBABLE');
    expect(codes(c)).toContain('GENERATED_INTERFACE_ABSENT');
  });

  it('13 — a contract operation nothing implements, and a call no contract describes: both said, no link', () => {
    const unimplemented = corr(contract, 'METHOD:front:HistoriqueService#rapport');
    expect(unimplemented?.status).toBe('UNDEMONSTRATED');
    expect(codes(unimplemented)).toContain('CONTRACT_NOT_IMPLEMENTED');
    // L'appel est décrit par l'opération du contrat, mais aucun endpoint servi ne lui est relié.
    expect(unimplemented?.target).toBe('API:contracts:GET /rapports/{id}');
    const served = contract.edges.filter(
      (e) => e.from === unimplemented?.from && e.kind === 'CALLS' && /^API:(bff|backend):/.test(e.to),
    );
    expect(served).toEqual([]);
  });

  it('15 — several Spring profiles: one outcome per variant, never merged with the default', () => {
    const front = corr(config, 'METHOD:front:DossiersService#lire');
    expect(front?.status).toBe('CONFIRMED');
    expect(front?.variants?.map((v) => [v.variant, v.status])).toEqual(
      expect.arrayContaining([
        ['recette', 'UNDEMONSTRATED'],
        ['production', 'UNDEMONSTRATED'],
      ]),
    );
    expect(codes(front)).toContain('ENVIRONMENT_INCONSISTENT');
  });

  it('negative — the same operation exposed by two services is not linked to the wrong one', () => {
    const proven = config.correlations?.find((c) => c.from.endsWith('BackendClient.dossier'));
    const ambiguous = config.correlations?.find((c) => c.from.endsWith('PartenaireClient.dossier'));
    expect(proven).toMatchObject({ status: 'CONFIRMED', target: 'API:backend:GET /api/dossiers/{id}' });
    expect(ambiguous?.status).toBe('UNDEMONSTRATED');
    expect(ambiguous?.target).toBeUndefined();
  });
});

describe('Spring → persistence', () => {
  it('10 — a controller implementing an interface serves the routes the interface declares', () => {
    for (const [route, handler] of [
      ['POST /api/v1/commandes/validation', 'valider'],
      ['POST /api/v1/commandes', 'creer'],
      ['GET /api/v1/commandes/{id}', 'lire'],
    ] as const)
      expect(
        edgeOf(trace, 'DEPENDS_ON', `API:backend:${route}`, java('web/CommandeController', handler)),
      ).toBeDefined();
    expect(corr(trace, 'METHOD:front:CommandeApiService#valider')).toMatchObject({
      status: 'CONFIRMED',
      target: 'API:backend:POST /api/v1/commandes/validation',
    });
  });

  it('11 — constants imported statically or read through another class build the route; unknown ones stay unknown', () => {
    const routes = trace.nodes.filter((n) => n.kind === 'API' && n.layer === 'BACKEND').map((n) => n.name);
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /api/v1/stats/total',
        'DELETE /api/v1/stats/archives',
        'POST /api/v1/commandes',
      ]),
    );
    expect(routes.some((r) => r.includes('{}'))).toBe(false);
    const shared = sourceConstants([
      {
        text: 'package a; public final class R { public static final String A = "/a"; public static final String B = A + "/b"; }',
      },
      { text: 'package c; public class X { static final String C = Inconnue.V + "/c"; }' },
    ]);
    expect(shared.get('a.R.B')).toBe('/a/b');
    expect(shared.has('c.X.C')).toBe(false);
  });

  it('16 — a shared service: each endpoint reaches only the tables its own methods touch', () => {
    const total = down('API:backend:GET /api/v1/stats/total');
    expect(ids(total)).toContain('ENTITY:backend:Commande');
    expect(ids(total)).not.toContain('ENTITY:backend:table:commandes_archives');
    const purge = down('API:backend:DELETE /api/v1/stats/archives');
    expect(ids(purge)).toContain('ENTITY:backend:table:commandes_archives');
    expect(ids(purge)).not.toContain('ENTITY:backend:Commande');
  });

  it('17 — JPA: derived methods, @Query, EntityManager and JDBC are read, written or deleted, with their statement', () => {
    const repo = (m: string) => java('data/CommandeRepository', m);
    const service = (m: string) => java('service/CommandeService', m);
    expect(edgeOf(trace, 'READS', repo('findByClient'), 'ENTITY:backend:Commande')?.confidence).toBe(
      'CONFIRMED',
    );
    expect(edgeOf(trace, 'READS', repo('parStatut'), 'ENTITY:backend:Commande')?.detail).toMatchObject({
      operation: 'SELECT',
      statement: 'select c from Commande c where c.statut = :statut',
    });
    expect(edgeOf(trace, 'WRITES', service('creer'), 'ENTITY:backend:Commande')?.confidence).toBe(
      'CONFIRMED',
    );
    expect(edgeOf(trace, 'READS', service('compter'), 'ENTITY:backend:Commande')?.detail?.operation).toBe(
      'SELECT',
    );
    // Une table qu'aucune entité ne déclare : écrite (DELETE), mais seulement probable.
    const purge = edgeOf(trace, 'WRITES', service('purger'), 'ENTITY:backend:table:commandes_archives');
    expect(purge).toMatchObject({ confidence: 'PROBABLE', detail: { operation: 'DELETE' } });
    expect(classifyQuery('update Commande c set c.statut = :s')).toEqual({
      operation: 'UPDATE',
      targets: ['Commande'],
    });
    expect(classifyQuery('call purge()').operation).toBe('UNKNOWN');
  });

  it('upstream from the entity reaches the screen; downstream from it is empty', () => {
    const up = traceOf(index, 'ENTITY:backend:Commande', { direction: 'UP' });
    expect(ids(up)).toEqual(
      expect.arrayContaining([`BUTTON:front:${PAGE}#button:valider`, `BUTTON:front:${PAGE}#button:compter`]),
    );
    expect(ids(up)).not.toContain(java('service/CommandeService', 'purger'));
    expect(down('ENTITY:backend:Commande')?.nodes.length).toBe(1);
  });
});

describe('local journeys, async and limits', () => {
  it('18 — a fully local journey: the button writes the signal that shows the container, no producer missing', () => {
    const container = `CONTAINER:front:${PAGE}#container:detailsvisibles`;
    const condition = `CONDITION:front:${PAGE}#container:detailsvisibles:visible`;
    const writer = `METHOD:front:${PAGE}#basculerDetails`;
    expect(edgeOf(trace, 'DEPENDS_ON', condition, writer)?.reason).toBe(
      'detailsVisibles est écrit par basculerDetails() (set)',
    );
    expect(String(trace.nodes.find((n) => n.id === condition)?.detail.producers)).toContain(
      'detailsVisibles:DEMONSTRATED',
    );
    expect(JSON.stringify(trace.nodes.find((n) => n.id === condition)?.detail)).not.toContain(
      'PRODUCER_UNRESOLVED',
    );
    // Le bouton déclenche l'écrivain (amont) ; l'écriture du signal rend la condition vraie et affiche le
    // conteneur (aval) : le sens du flux, de la cause vers l'effet.
    expect(ids(traceOf(index, writer, { direction: 'UP' }))).toContain(
      `BUTTON:front:${PAGE}#button:afficher-les-details`,
    );
    expect(ids(down(writer))).toEqual(expect.arrayContaining([condition, container]));
    expect(down(container)?.breaks).toEqual([]);
  });

  it('19 — an Observable created but never subscribed: no step is confirmed past the handler', () => {
    const button = `BUTTON:front:${PAGE}#button:supprimer`;
    expect(
      edgeOf(trace, 'CALLS', `METHOD:front:${PAGE}#supprimer`, 'METHOD:front:CommandeApiService#supprimer')
        ?.confidence,
    ).toBe('UNKNOWN');
    // Le raccourci du bouton ne vaut pas mieux que l'appel lui-même.
    expect(edgeOf(trace, 'TRIGGERS', button, 'METHOD:front:CommandeApiService#supprimer')?.confidence).toBe(
      'UNKNOWN',
    );
    const t = down(button);
    expect(t?.breaks.map((b) => b.status)).toEqual(['UNDEMONSTRATED']);
    expect(t?.nodes.some((n) => n.layer === 'BACKEND')).toBe(false);
  });

  it('20 — a partial read: the missing target is not taken as proof, the limit is said', async () => {
    const { model } = await runScan({
      incremental: false,
      allowedRoots: [TRACE],
      config: configOf(TRACE, traceSources),
      limits: { maxFiles: 5, maxFileBytes: 512 * 1024, maxDurationMs: 60_000 },
    });
    const partial = (model.correlations ?? []).filter((c) => codes(c).includes('SOURCE_PARTIAL'));
    expect(partial.length).toBeGreaterThan(0);
    for (const c of partial) {
      expect(c.status).not.toBe('CONFIRMED');
      expect(c.diagnostic?.limits.length).toBeGreaterThan(0);
    }
  });

  it('the trace is bounded: limit, depth and criteria cut it and say where', () => {
    const start = `BUTTON:front:${PAGE}#button:valider`;
    const small = traceOf(index, start, { direction: 'DOWN', limit: 4 });
    expect(small?.nodes.length).toBe(4);
    expect(small?.truncated).toBe(true);
    expect(small?.frontier.some((f) => f.reason === 'LIMIT')).toBe(true);
    const shallow = traceOf(index, start, { direction: 'DOWN', depth: 1 });
    expect(shallow?.frontier.map((f) => f.reason)).toContain('DEPTH');
    const front = traceOf(index, start, { direction: 'DOWN', layers: ['FRONTEND'] });
    expect(front?.nodes.every((n) => n.layer === 'FRONTEND')).toBe(true);
    expect(front?.frontier.some((f) => f.reason === 'FILTERED')).toBe(true);
    const calls = traceOf(index, start, { direction: 'DOWN', kinds: ['TRIGGERS'] });
    expect(calls?.edges.every((e) => e.kind === 'TRIGGERS')).toBe(true);
    expect(traceOf(index, 'METHOD:front:nope')).toBeUndefined();
    // Complet = amont ∪ aval, sans bifurcation : chaque nœud garde le sens par lequel il est atteint.
    const both = traceOf(index, `METHOD:front:${PAGE}#valider`, { direction: 'BOTH' });
    const levels = Object.values(both?.levels ?? {});
    expect(levels.some((l) => l < 0) && levels.some((l) => l > 0)).toBe(true);
  });

  it('ids and evidence are stable from one scan to the next', async () => {
    const again = await scanOf(TRACE, traceSources);
    const key = (m: CartographyModel) => ({
      nodes: m.nodes.map((n) => n.id).sort(),
      edges: m.edges
        .map(
          (e) =>
            `${e.id}|${e.confidence}|${e.evidence.map((x) => `${x.file ?? ''}:${String(x.line ?? '')}`).join(',')}`,
        )
        .sort(),
      correlations: (m.correlations ?? []).map((c) => `${c.from}|${c.status}|${c.target ?? ''}`).sort(),
    });
    expect(key(again)).toEqual(key(trace));
  });
});
