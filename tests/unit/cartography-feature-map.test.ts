import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FEATURE_CATEGORIES,
  FEATURE_GROUP_CARDS,
  FEATURE_LANES,
  type CartographyConfig,
  type CartographyModel,
  type Feature,
  type FeatureMap,
  type MapEdge,
  type MapEdgeKind,
  type MapNode,
} from '../../src/sdk/core/cartography.js';
import { buildIndex, type CoverageContext, type MapIndex } from '../../src/cartography/explorer.js';
import { featureMap } from '../../src/cartography/feature-map.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * La carte d'une fonctionnalité (Parcours & Graphe) : quatre couloirs dans un ordre fixe, des groupes par
 * nature, toutes les relations gardées et comptées exactement (faisceaux), des lacunes dites avec leur cause.
 * D'abord sur le scan réel des mini-projets de test, puis sur des volumes synthétiques (0 à 10 000 relations).
 */
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};

async function scanned(fixture: string, dirs: [string, 'FRONTEND' | 'BFF' | 'BACKEND'][]): Promise<MapIndex> {
  const root = path.resolve('tests/fixtures', fixture);
  const config: CartographyConfig = {
    schema: 1,
    sources: dirs.map(([id, layer]) => ({
      id,
      name: id,
      layer,
      path: path.join(root, id),
      include: [],
      enabled: true,
    })),
  };
  const { model } = await runScan({ config, allowedRoots: [root], incremental: false });
  return buildIndex(model);
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** Les invariants de toute carte : rien de perdu, rien de compté deux fois. */
function checkCounts(map: FeatureMap): void {
  expect(sum(Object.values(map.categories))).toBe(map.relationCount);
  expect(sum(Object.values(map.statuses))).toBe(map.relationCount);
  expect(sum(map.bundles.map((b) => b.count))).toBe(map.relationCount);
  for (const b of map.bundles) expect(sum(Object.values(b.statuses))).toBe(b.count);
  expect(map.lanes.map((l) => l.lane)).toEqual([...FEATURE_LANES]);
  expect(sum(map.lanes.flatMap((l) => l.groups.map((g) => g.count)))).toBe(map.itemCount);
}

describe('carte d’une fonctionnalité sur le scan réel (front, BFF, backend)', () => {
  let index: MapIndex;
  let map: FeatureMap;
  beforeAll(async () => {
    index = await scanned('cartography-conditions', [
      ['front', 'FRONTEND'],
      ['bff', 'BFF'],
      ['backend', 'BACKEND'],
    ]);
    const feature = index.model.features.find((f) => f.name === 'Request create');
    expect(feature).toBeDefined();
    const found = featureMap(index, cov, feature?.id ?? '');
    expect(found).toBeDefined();
    map = found as FeatureMap;
  }, 120_000);

  it('range les éléments Angular → BFF → Backend → API externe, la persistance JPA dans le backend', () => {
    checkCounts(map);
    expect(map.lanes.map((l) => [l.lane, l.present])).toEqual([
      ['FRONTEND', true],
      ['BFF', true],
      ['BACKEND', true],
      ['EXTERNAL', true],
    ]);
    const lanesOf = map.items.map((i) => FEATURE_LANES.indexOf(i.lane));
    expect(lanesOf).toEqual([...lanesOf].sort((a, b) => a - b));
    const groups = (lane: string) => map.lanes.find((l) => l.lane === lane)?.groups.map((g) => g.group) ?? [];
    expect(groups('FRONTEND')).toEqual(expect.arrayContaining(['PAGE', 'COMPONENT', 'BUTTON', 'CONDITION']));
    expect(groups('BFF')).toEqual(expect.arrayContaining(['CONTROLLER', 'ENDPOINT']));
    expect(groups('BACKEND')).toEqual(expect.arrayContaining(['RULE', 'REPOSITORY', 'ENTITY']));
    for (const item of map.items.filter((i) => i.group === 'ENTITY' || i.group === 'REPOSITORY')) {
      expect(item.lane).toBe('BACKEND');
      expect(item.persistence).toBe(true);
    }
    expect(map.categories.PERSISTENCE).toBeGreaterThan(0);
  });

  it('ne met dans le couloir externe que le service tiers établi par le scan', () => {
    const external = map.items.filter((i) => i.lane === 'EXTERNAL');
    expect(external.map((i) => i.group).sort()).toEqual(['EXTERNAL_CALL', 'EXTERNAL_SERVICE']);
    expect(external.every((i) => i.id.startsWith('EXT:'))).toBe(true);
    // Aucun endpoint interne n'est rangé comme API externe.
    expect(map.items.filter((i) => i.group === 'ENDPOINT').every((i) => i.lane !== 'EXTERNAL')).toBe(true);
    expect(map.categories.EXTERNAL).toBe(1);
    expect(map.gaps.some((g) => g.code === 'UNCLASSIFIED_CALL')).toBe(false);
  });

  it('relie la condition du bouton à la règle backend démontrée, et dit qu’aucun store n’est atteint', () => {
    expect(map.conditions).toHaveLength(1);
    expect(map.conditions[0]?.element.name).toBe('Validate');
    expect(map.conditions[0]?.decision).toBe('ValidationEligibilityService.canValidate');
    const noStore = map.gaps.find((g) => g.code === 'NO_STORE');
    expect(noStore?.lane).toBe('FRONTEND');
    expect(map.lanes[0]?.groups.some((g) => g.group === 'STORE')).toBe(false);
  });

  it('restreint et pagine le tableau sans changer les compteurs ni les faisceaux', () => {
    const id = map.feature.id;
    const byCategory = featureMap(index, cov, id, { category: 'CONDITION' });
    expect(byCategory?.relations.total).toBe(map.categories.CONDITION);
    expect(byCategory?.relationCount).toBe(map.relationCount);
    expect(byCategory?.bundles).toEqual(map.bundles);
    const page2 = featureMap(index, cov, id, { size: 10, page: 2 });
    expect(page2?.relations.items).toHaveLength(10);
    expect(page2?.relations.page).toBe(2);
    const beyond = featureMap(index, cov, id, { size: 10, page: 999 });
    expect(beyond?.relations.page).toBe(Math.ceil(map.relationCount / 10));
    const refuse = map.items.find((i) => i.kind === 'BUTTON' && i.name === 'Refuse');
    const focused = featureMap(index, cov, id, { item: refuse?.id ?? '' });
    expect(focused?.relations.total).toBe(refuse?.links);
    expect(focused?.relations.items.every((r) => r.from === refuse?.id || r.to === refuse?.id)).toBe(true);
    const searched = featureMap(index, cov, id, { q: 'partner' });
    expect(searched?.relations.total).toBeGreaterThan(0);
    expect(featureMap(index, cov, 'FEATURE:unknown')).toBeUndefined();
  });

  it('donne à chaque relation sa preuve quand le scan en a une', () => {
    const all = featureMap(index, cov, map.feature.id, { size: 100 });
    const rows = all?.relations.items ?? [];
    expect(rows).toHaveLength(map.relationCount);
    expect(rows.filter((r) => r.evidence).length).toBeGreaterThan(rows.length / 2);
    for (const r of rows) expect(FEATURE_CATEGORIES).toContain(r.category);
  });
});

describe('carte d’une fonctionnalité sans backend, avec stores et appel non classé', () => {
  let map: FeatureMap;
  beforeAll(async () => {
    const index = await scanned('cartography-rxjs', [
      ['front', 'FRONTEND'],
      ['bff', 'BFF'],
    ]);
    const feature = index.model.features.find((f) => f.name === 'Activation');
    map = featureMap(index, cov, feature?.id ?? '') as FeatureMap;
  }, 120_000);

  it('range les stores dans le couloir Angular et ne crée aucun passage backend', () => {
    checkCounts(map);
    const stores = map.items.filter((i) => i.group === 'STORE');
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((i) => i.lane === 'FRONTEND')).toBe(true);
    expect(map.lanes.find((l) => l.lane === 'BACKEND')?.present).toBe(false);
    expect(map.gaps.find((g) => g.code === 'LANE_NO_SOURCE')?.lane).toBe('BACKEND');
  });

  it('liste l’appel sortant non classé comme lacune, jamais comme API externe', () => {
    expect(map.lanes.find((l) => l.lane === 'EXTERNAL')?.present).toBe(false);
    expect(map.gaps.find((g) => g.code === 'UNCLASSIFIED_CALL')?.items.length).toBeGreaterThan(0);
    expect(map.gaps.some((g) => g.code === 'BROKEN_CORRELATION')).toBe(true);
    expect(map.gaps.some((g) => g.code === 'CHAIN_BREAK')).toBe(true);
  });
});

/** Une fonctionnalité synthétique : `n` relations entre services SPA et services backend. */
function synthetic(n: number): CartographyModel {
  const evidence = [
    { kind: 'STATIC_CODE' as const, sourceId: 's', file: 'f.ts', line: 1, confidence: 'CONFIRMED' as const },
  ];
  const node = (id: string, layer: 'FRONTEND' | 'BACKEND', name: string): MapNode => ({
    id,
    kind: 'SERVICE',
    layer,
    name,
    detail: { role: 'SERVICE' },
    signature: '',
    evidence,
  });
  const kinds: MapEdgeKind[] = ['CALLS', 'SENDS', 'DEPENDS_ON'];
  const nodes: MapNode[] = [node('SERVICE:f:Lonely', 'FRONTEND', 'Lonely')];
  const edges: MapEdge[] = [];
  for (let i = 0; i < n; i += 1) {
    const from = `SERVICE:f:F${String(i)}`;
    const to = `SERVICE:b:B${String(i)}`;
    nodes.push(node(from, 'FRONTEND', `F${String(i).padStart(5, '0')}`));
    nodes.push(node(to, 'BACKEND', `B${String(i).padStart(5, '0')}`));
    edges.push({
      id: `E${String(i)}`,
      from,
      to,
      kind: kinds[i % 3] ?? 'CALLS',
      confidence: i % 5 === 0 ? 'PROBABLE' : 'CONFIRMED',
      reason: 'r',
      evidence,
    });
  }
  const feature: Feature = {
    id: 'FEATURE:big',
    name: 'Big',
    proposedName: '',
    module: 'm',
    status: 'CANDIDATE',
    layers: ['FRONTEND', 'BACKEND'],
    nodes: nodes.map((x) => x.id),
    fields: [],
    chain: [],
    basis: '',
    evidence: [],
    reach: {},
  };
  return {
    schema: 1,
    scan: {
      id: 'scan-synthetic',
      schema: 1,
      startedAt: '2026-11-07T00:00:00Z',
      state: 'COMPLETED',
      incremental: false,
      sources: [],
      counts: {},
      edges: edges.length,
      errors: [],
    },
    nodes,
    edges,
    features: [feature],
    concepts: [],
    issues: [],
  };
}

describe('volumes synthétiques : 0, 10, 100, 1 000 et 10 000 relations, catégorie « Tout »', () => {
  for (const n of [0, 10, 100, 1_000, 10_000]) {
    it(`${String(n)} relations : comptes exacts, faisceaux agrégés, réponse bornée`, () => {
      const index = buildIndex(synthetic(n));
      const started = performance.now();
      const map = featureMap(index, cov, 'FEATURE:big') as FeatureMap;
      const ms = performance.now() - started;
      checkCounts(map);
      expect(map.relationCount).toBe(n);
      expect(map.itemCount).toBe(2 * n + 1);
      expect(map.categories.CALLS).toBe(Math.ceil(n / 3));
      expect(map.categories.DATA).toBe(Math.max(0, Math.ceil((n - 1) / 3)));
      expect(map.categories.DEPENDS).toBe(Math.floor(n / 3));
      expect(map.statuses.PROBABLE).toBe(Math.ceil(n / 5));
      // « Tout » : un faisceau par catégorie entre deux groupes, jamais une ligne par relation.
      expect(map.bundles.length).toBe(Math.min(n, 3));
      // Les cartes renvoyées sont bornées par groupe ; les autres restent comptées.
      const spa = map.lanes[0]?.groups.find((g) => g.group === 'SPA_SERVICE');
      expect(spa?.count).toBe(n + 1);
      expect(spa?.shown).toBe(Math.min(n + 1, FEATURE_GROUP_CARDS));
      expect(map.items.length).toBeLessThanOrEqual(2 * FEATURE_GROUP_CARDS);
      // Le tableau : une page, toutes les relations comptées.
      expect(map.relations.total).toBe(n);
      expect(map.relations.items).toHaveLength(Math.min(n, 25));
      // L'élément sans relation est signalé, sans cause inventée.
      const isolated = map.gaps.find((g) => g.code === 'ISOLATED');
      expect(isolated?.detail).toContain('1 élément');
      expect(isolated?.items[0]).toContain('Lonely');
      expect(JSON.stringify(map).length).toBeLessThan(200_000);
      // Borne large (machines de CI lentes).
      expect(ms).toBeLessThan(5_000);
    });
  }

  it('garde la carte de l’élément demandé même au-delà de la limite par groupe', () => {
    const index = buildIndex(synthetic(1_000));
    const last = 'SERVICE:f:F999';
    const map = featureMap(index, cov, 'FEATURE:big', { item: last }) as FeatureMap;
    expect(map.items.some((i) => i.id === last)).toBe(true);
    expect(map.relations.total).toBe(1);
    expect(map.relations.items[0]?.from).toBe(last);
  });
});
