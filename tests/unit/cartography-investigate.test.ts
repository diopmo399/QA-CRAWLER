import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CartographyConfig,
  CartographyModel,
  Investigation,
  MapEdge,
  MapLayer,
} from '../../src/sdk/core/cartography.js';
import { buildIndex, type MapIndex } from '../../src/cartography/explorer.js';
import {
  applyAdvice,
  expandInvestigation,
  flowOf,
  investigate,
  InvestigationStaleError,
  natureOf,
} from '../../src/cartography/investigate.js';
import { runScan } from '../../src/cartography/scan.js';
import { writeLargeStoreProject } from '../fixtures/investigation-project.js';

/**
 * LE MOTEUR D'INVESTIGATION. Sur la fixture cartography-trace (écran à onglets, store à validation puis
 * dispatch, backend à service partagé, JPA/EntityManager/JDBC), sur cartography-config (profils qui
 * divergent) et sur un projet synthétique écrit à la volée (store de 300 propriétés, sujet sans consommateur,
 * deux services qui s'appellent l'un l'autre). Chaque cas vérifie aussi l'absence de lien inventé.
 */
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
const scan = async (root: string, sources: readonly (readonly [string, MapLayer])[], maxFiles?: number) =>
  (
    await runScan({
      incremental: false,
      allowedRoots: [root],
      config: configOf(root, sources),
      ...(maxFiles ? { limits: { maxFiles, maxFileBytes: 512 * 1024, maxDurationMs: 60_000 } } : {}),
    })
  ).model;
const TRACE = path.resolve('tests/fixtures/cartography-trace');
const FB = [
  ['front', 'FRONTEND'],
  ['backend', 'BACKEND'],
] as const;
const PAGE = 'CommandesPageComponent';
const BUTTON = (name: string) => `BUTTON:front:${PAGE}#button:${name}`;

let trace: CartographyModel;
let index: MapIndex;
let large: CartographyModel;
let largeIndex: MapIndex;
let largeRoot: string;
const names = (inv: Investigation | undefined, ids: readonly string[]): string[] =>
  ids.map((id) => inv?.nodes.find((n) => n.id === id)?.name ?? id);
const kinds = (inv: Investigation | undefined, ids: readonly string[]): string[] =>
  ids.map((id) => inv?.nodes.find((n) => n.id === id)?.kind ?? '?');

beforeAll(async () => {
  trace = await scan(TRACE, FB);
  index = buildIndex(trace);
  largeRoot = await writeLargeStoreProject();
  large = await scan(largeRoot, FB);
  largeIndex = buildIndex(large);
}, 120_000);

afterAll(async () => {
  await rm(largeRoot, { recursive: true, force: true });
});

describe('relations: nature and flow', () => {
  it('a structural link is never a cause; « A depends on B » flows from B to A', () => {
    const byId = index.nodes;
    const of = (kind: string, from: string, to: string): MapEdge | undefined =>
      trace.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
    const trigger = of('TRIGGERS', BUTTON('valider'), `METHOD:front:${PAGE}#valider`);
    expect(trigger && natureOf(trigger, byId)).toBe('CAUSAL');
    const bound = trace.edges.find((e) => e.kind === 'CALLS' && byId.get(e.from)?.kind === 'COMPONENT');
    expect(bound && natureOf(bound, byId)).toBe('STRUCTURE');
    const derived = of('DEPENDS_ON', 'STREAM:front:CommandeStore.etat$', 'STREAM:front:CommandeStore.etat');
    expect(derived && natureOf(derived, byId)).toBe('DATA');
    expect(derived && flowOf(derived, 'DATA')).toEqual([
      'STREAM:front:CommandeStore.etat',
      'STREAM:front:CommandeStore.etat$',
    ]);
    const shown = trace.edges.find((e) => e.kind === 'VISIBLE_WHEN');
    expect(shown && natureOf(shown, byId)).toBe('CONTROL');
    expect(shown && flowOf(shown, 'CONTROL')).toEqual([shown?.to, shown?.from]);
    const served = trace.edges.find((e) => e.kind === 'DEPENDS_ON' && byId.get(e.from)?.kind === 'API');
    expect(served && natureOf(served, byId)).toBe('CAUSAL');
  });
});

describe('investigation from a user event', () => {
  it('complete journey: every branch reaches its end, conditions kept, no other user action crossed', () => {
    const inv = investigate(index, { start: BUTTON('valider'), direction: 'DOWN' });
    expect(inv?.state).toBe('COMPLETE');
    const persistence = inv?.paths.filter((p) => p.end === 'PERSISTENCE') ?? [];
    // Plusieurs branches et plusieurs appels d'API, jamais fusionnés.
    const apis = new Set(persistence.flatMap((p) => p.nodes.filter((id) => id.startsWith('API:'))));
    expect([...apis].sort()).toEqual([
      'API:backend:GET /api/v1/commandes/{id}',
      'API:backend:POST /api/v1/commandes',
      'API:backend:POST /api/v1/commandes/validation',
    ]);
    expect(persistence.every((p) => p.status === 'COMPLETE' && p.confidence === 'CONFIRMED')).toBe(true);
    const enregistrer = persistence.find((p) => p.nodes.includes('API:backend:POST /api/v1/commandes'));
    expect(enregistrer?.conditions).toContain('this.etat.value.valide');
    // L'état mis à jour révèle les onglets (fin locale) ; leurs boutons demandent une autre action.
    expect(
      inv?.paths.some(
        (p) => p.end === 'LOCAL' && names(inv, p.nodes).at(-1) === 'Onglets : Confirmation, Détails',
      ),
    ).toBe(true);
    for (const p of inv?.paths ?? []) expect(kinds(inv, p.nodes.slice(1))).not.toContain('BUTTON');
    expect(inv?.nodes.map((n) => n.id)).not.toContain(`METHOD:front:${PAGE}#basculerDetails`);
    // Une donnée dérivée n'est pas une cause : l'état du store ne « déclenche » pas l'appel de création.
    for (const p of inv?.paths ?? []) {
      const at = p.nodes.indexOf('STREAM:front:CommandeStore.etat');
      expect(at < 0 || p.nodes[at + 1] !== 'METHOD:front:CommandeApiService#creer').toBe(true);
    }
  });

  it('unsubscribed Observable: the branch stops, its exact cause is said, nothing past it is confirmed', () => {
    const inv = investigate(index, { start: BUTTON('supprimer'), direction: 'DOWN' });
    expect(inv?.state).toBe('PARTIAL');
    expect(inv?.breaks.map((b) => b.code)).toContain('OBSERVABLE_NOT_SUBSCRIBED');
    expect(inv?.frontier.map((f) => f.reason)).toContain('UNDEMONSTRATED');
    expect(inv?.nodes.some((n) => n.layer === 'BACKEND')).toBe(false);
    expect(
      inv?.hypotheses.some(
        (h) => h.status === 'CANDIDATE' && h.candidates.includes('METHOD:front:CommandeApiService#supprimer'),
      ),
    ).toBe(true);
  });

  it('explore this branch: the undemonstrated step is followed, marked unknown, never confirmed', () => {
    const inv = investigate(index, { start: BUTTON('supprimer'), direction: 'DOWN' });
    const next = inv && expandInvestigation(index, inv, `METHOD:front:${PAGE}#supprimer`);
    expect(next?.expansions).toEqual([`METHOD:front:${PAGE}#supprimer`]);
    const path = next?.paths.find((p) => p.nodes.includes('METHOD:front:CommandeApiService#supprimer'));
    expect(path).toMatchObject({ status: 'BROKEN', confidence: 'UNKNOWN' });
    expect(next?.breaks.map((b) => b.code)).toEqual(expect.arrayContaining(['METHOD_MISMATCH']));
    // Ce qui était validé est repris tel quel ; aucune recherche n'est refaite.
    const keys = next?.attempts.map((a) => `${a.strategy}|${a.at}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    expect(next?.trail[BUTTON('supprimer')]).toEqual(inv?.trail[BUTTON('supprimer')]);
  });

  it('a budget reached keeps the results and a frontier; resuming from it goes further', () => {
    const small = investigate(index, { start: BUTTON('valider'), direction: 'DOWN', budget: { nodes: 4 } });
    expect(small?.state).toBe('PARTIAL');
    expect(small?.metrics.visited).toBe(5);
    const cut = small?.frontier.find((f) => f.reason === 'BUDGET');
    expect(cut).toBeDefined();
    expect(small?.paths.some((p) => p.status === 'PARTIAL' && p.end === 'FRONTIER')).toBe(true);
    const more = small && cut && expandInvestigation(index, small, cut.node, { nodes: 400 });
    expect(more?.metrics.visited).toBeGreaterThan(small?.metrics.visited ?? 0);
    expect(more?.frontier.some((f) => f.node === cut?.node && f.reason === 'BUDGET')).toBe(false);
    for (const id of Object.keys(small?.trail ?? {})) expect(more?.trail[id]).toBeDefined();
    // Une branche qui n'est pas sur la frontière ne se reprend pas.
    expect(small && expandInvestigation(index, small, 'ENTITY:backend:Commande')).toBeUndefined();
  });

  it('a resumption on another scan is refused: the earlier proof no longer holds', async () => {
    const inv = investigate(index, { start: BUTTON('valider'), direction: 'DOWN', budget: { nodes: 3 } });
    const other = buildIndex(await scan(TRACE, FB));
    const node = inv?.frontier[0]?.node ?? '';
    expect(() => inv && expandInvestigation(other, inv, node)).toThrow(InvestigationStaleError);
  });
});

describe('reverse investigation and evidence rules', () => {
  it('from a table up to the user events that can reach it — and only those', () => {
    const inv = investigate(index, {
      start: 'ENTITY:backend:Commande',
      direction: 'UP',
      goal: 'ENTRY_POINTS',
    });
    const entries = new Set(inv?.paths.filter((p) => p.end === 'ENTRY').map((p) => p.nodes.at(-1)));
    expect(entries.has('ROUTE:front:/commandes')).toBe(true);
    const buttons = new Set(inv?.paths.flatMap((p) => p.nodes.filter((id) => id.startsWith('BUTTON:'))));
    expect([...buttons].sort()).toEqual([BUTTON('compter'), BUTTON('valider')]);
    // Le DELETE JDBC n'écrit pas cette table ; une méthode n'est pas appelée par sa classe.
    expect(inv?.nodes.map((n) => n.id)).not.toContain(
      'METHOD:backend:src/main/java/com/ex/commandes/service/CommandeService.java#CommandeService.purger',
    );
    expect(inv?.paths.some((p) => kinds(inv, p.nodes).includes('SERVICE'))).toBe(false);
    // La méthode générique est appelée par ses versions contextualisées : pas de fausse rupture.
    expect(inv?.breaks.some((b) => b.at === 'METHOD:front:CommandeStore#dispatch')).toBe(false);
    expect(inv?.attempts.some((a) => a.strategy === 'CALLERS' && a.outcome === 'RESOLVED')).toBe(true);
    // Une méthode qu'aucun appelant n'atteint est une rupture dite, pas un point d'entrée.
    expect(inv?.breaks.find((b) => b.code === 'NO_CALLER')?.at).toBe(
      'METHOD:backend:src/main/java/com/ex/commandes/data/CommandeRepository.java#CommandeRepository.parStatut',
    );
  });

  it('contradictory evidence: an outcome that differs by profile is a contradictory hypothesis', async () => {
    const root = path.resolve('tests/fixtures/cartography-config');
    const model = await scan(root, [
      ['front', 'FRONTEND'],
      ['passerelle', 'OTHER'],
      ['bff', 'BFF'],
      ['backend', 'BACKEND'],
      ['archives', 'BACKEND'],
      ['referentiel', 'BACKEND'],
    ]);
    const inv = investigate(buildIndex(model), {
      start: 'METHOD:front:DossiersService#lire',
      direction: 'DOWN',
    });
    const h = inv?.hypotheses.find((x) => x.status === 'CONTRADICTORY');
    expect(h?.evidence).toEqual(expect.arrayContaining(['défaut : CONFIRMED', 'recette : UNDEMONSTRATED']));
  });

  it('a source read in part: the investigation stays partial and says why', async () => {
    const model = await scan(TRACE, FB, 5);
    const inv = investigate(buildIndex(model), {
      start: 'METHOD:front:CommandeApiService#valider',
      direction: 'DOWN',
    });
    expect(inv?.state).toBe('PARTIAL');
    expect(inv?.limitations.some((l) => l.includes('lue en partie'))).toBe(true);
    expect(inv?.breaks.map((b) => b.code)).toEqual(expect.arrayContaining(['SOURCE_PARTIAL']));
  });

  it('an advisor never confirms alone: a lead is supported only by a demonstrated relation', () => {
    const inv = investigate(index, { start: BUTTON('valider'), direction: 'DOWN' });
    const advised =
      inv &&
      applyAdvice(index, inv, [
        {
          at: `METHOD:front:${PAGE}#valider`,
          claim: 'appelle le store',
          candidates: ['METHOD:front:CommandeStore#validerEtEnregistrer'],
        },
        {
          at: `METHOD:front:${PAGE}#valider`,
          claim: 'écrit la table',
          candidates: ['ENTITY:backend:Commande'],
        },
      ]);
    expect(advised?.hypotheses.filter((h) => h.source === 'ADVISOR').map((h) => h.status)).toEqual([
      'SUPPORTED',
      'CANDIDATE',
    ]);
    expect(advised?.edges).toEqual(inv?.edges);
  });

  it('deterministic: the same request on the same scan gives the same result', () => {
    const strip = (x: Investigation | undefined) =>
      x && { ...x, metrics: { ...x.metrics, ms: 0, heapKb: 0 }, updatedAt: '', createdAt: '' };
    const a = investigate(index, { start: BUTTON('valider'), direction: 'BOTH' }, { id: 'inv-a' });
    const b = investigate(index, { start: BUTTON('valider'), direction: 'BOTH' }, { id: 'inv-a' });
    expect(strip(a)).toEqual(strip(b));
    expect(investigate(index, { start: 'METHOD:front:nope' })).toBeUndefined();
  });
});

describe('fan-out: a node with hundreds of non-causal neighbours', () => {
  it('focused: the cause is followed, data neighbours are capped and left on a resumable frontier; exhaustive: all', () => {
    const node = (id: string, kind: 'METHOD' | 'FIELD' | 'API'): CartographyModel['nodes'][number] => ({
      id,
      kind,
      layer: 'FRONTEND',
      name: id,
      detail: {},
      signature: '',
      evidence: [],
    });
    const edge = (from: string, to: string, kind: 'CALLS' | 'READS'): MapEdge => ({
      id: `${kind}:${from}->${to}`,
      from,
      to,
      kind,
      confidence: 'CONFIRMED',
      reason: 'test',
      evidence: [],
    });
    const fields = Array.from({ length: 300 }, (_, i) => `FIELD:s:f${String(i)}`);
    const model = {
      ...trace,
      scan: { ...trace.scan, sources: [] },
      nodes: [
        node('METHOD:s:m', 'METHOD'),
        node('API:s:GET /x', 'API'),
        ...fields.map((f) => node(f, 'FIELD')),
      ],
      edges: [
        edge('METHOD:s:m', 'API:s:GET /x', 'CALLS'),
        ...fields.map((f) => edge('METHOD:s:m', f, 'READS')),
      ],
      features: [],
      concepts: [],
      issues: [],
      correlations: [],
      apis: [],
    } as CartographyModel;
    const ix = buildIndex(model);
    const focused = investigate(ix, { start: 'METHOD:s:m', direction: 'DOWN' });
    expect(focused?.nodes.map((n) => n.id)).toContain('API:s:GET /x');
    expect(focused?.metrics.visited).toBe(1 + 1 + 12);
    expect(focused?.frontier).toEqual([
      { node: 'METHOD:s:m', reason: 'FAN_OUT', pending: 288, direction: 'DOWN' },
    ]);
    const resumed = focused && expandInvestigation(ix, focused, 'METHOD:s:m');
    expect(resumed?.metrics.visited).toBe(302);
    const exhaustive = investigate(ix, { start: 'METHOD:s:m', direction: 'DOWN', mode: 'EXHAUSTIVE' });
    expect(exhaustive?.metrics.visited).toBe(302);
  });
});

describe('large store, cycles, consumers', () => {
  const start = 'BUTTON:front:GeantPageComponent#button:enregistrer';

  it('a store with 300 properties does not flood the investigation', () => {
    expect(large.nodes.filter((n) => n.kind === 'STREAM').length).toBeGreaterThan(500);
    const inv = investigate(largeIndex, { start, direction: 'DOWN' });
    expect(inv?.metrics.visited).toBeLessThan(30);
    expect(
      inv?.paths.some((p) => p.end === 'PERSISTENCE' && p.nodes.includes('API:backend:POST /api/geant')),
    ).toBe(true);
    // Seules les propriétés que l'action touche apparaissent.
    const streams = inv?.nodes.filter((n) => n.kind === 'STREAM').map((n) => n.name) ?? [];
    expect(streams.every((s) => /\.(p7|p8)\$?$/.test(s) || s.endsWith('GeantPageComponent.p8$'))).toBe(true);
  });

  it('a call cycle between services is detected; its exit to the table stays explored', () => {
    const inv = investigate(largeIndex, { start, direction: 'DOWN' });
    const cycle = inv?.cycles.find((c) => c.nature === 'CALL');
    expect(names(inv, cycle?.nodes ?? [])).toEqual(['PremierService.traiter', 'SecondService.relancer']);
    expect(names(inv, cycle?.exits ?? [])).toContain('geants');
    expect(inv?.paths.some((p) => p.end === 'PERSISTENCE' && names(inv, p.nodes).at(-1) === 'geants')).toBe(
      true,
    );
  });

  it('emitted but never consumed: the break is said; a consumed state is a legitimate local end', () => {
    const forgotten = investigate(largeIndex, {
      start: 'BUTTON:front:GeantPageComponent#button:oublier',
      direction: 'DOWN',
    });
    expect(forgotten?.breaks.map((b) => [b.code, b.at])).toEqual([
      ['SUBJECT_NO_CONSUMER', 'STREAM:front:GeantStore.orphelin'],
    ]);
    const saved = investigate(largeIndex, { start, direction: 'DOWN' });
    expect(
      saved?.paths.some((p) => p.end === 'LOCAL' && p.nodes.at(-1) === 'STREAM:front:GeantPageComponent.p8$'),
    ).toBe(true);
    expect(saved?.breaks.find((b) => b.code === 'SUBJECT_NO_CONSUMER')?.at).toBe(
      'STREAM:front:GeantStore.p7$',
    );
  });
});
