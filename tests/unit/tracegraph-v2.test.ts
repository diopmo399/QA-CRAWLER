import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartographyModel, MapEdge } from '../../src/sdk/core/cartography.js';
import {
  buildIndex,
  traceOf,
  unresolvedOf,
  type CoverageContext,
  type MapIndex,
} from '../../src/cartography/explorer.js';
import { unresolvedTab } from '../../src/sdk/ui/dashboard-cartography-unresolved.js';
import { featureMap } from '../../src/cartography/feature-map.js';
import { runScan } from '../../src/cartography/scan.js';
import type { SourceFacts } from '../../src/cartography/facts.js';
import { ClassIdentity, importBindingsOf } from '../../src/static-analysis/class-identity.js';

/**
 * TRACEGRAPH V2 — non-régression des pertes de liens et des parcours mélangés constatés par l'audit
 * (docs/audits/tracegraph-baseline.md), sur la fixture tests/fixtures/tracegraph :
 *   - deux composants homonymes (`ListComponent` dans admin/list et catalog/list), importés sous alias ;
 *   - un store maison (dispatch aiguillé par type, Subject d'actions partagé et filtré, BehaviorSubject) ;
 *   - un composant qui installe deux abonnements dans ngOnInit ;
 *   - une route vers un composant absent de la source.
 * Chaque cas vérifie les liens attendus ET ceux qui ne doivent pas apparaître. Rien n'est exécuté.
 */
const ROOT = path.resolve('tests/fixtures/tracegraph');
const config = {
  schema: 1 as const,
  sources: [
    {
      id: 'front',
      name: 'front',
      layer: 'FRONTEND' as const,
      path: path.join(ROOT, 'front'),
      include: [],
      enabled: true,
    },
  ],
};
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const M = (id: string): string => `METHOD:front:${id}`;
const S = (id: string): string => `STREAM:front:${id}`;
const ADMIN = 'ListComponent(admin/list)';
const CATALOG = 'ListComponent(catalog/list)';

let model: CartographyModel;
let facts: SourceFacts[];
let index: MapIndex;
const edge = (kind: string, from: string, to: string): MapEdge | undefined =>
  model.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
const down = (id: string): string[] =>
  traceOf(index, id, { direction: 'DOWN' })?.nodes.map((n) => n.id) ?? [];
const up = (id: string): string[] => traceOf(index, id, { direction: 'UP' })?.nodes.map((n) => n.id) ?? [];

beforeAll(async () => {
  ({ model, facts } = await runScan({ incremental: false, allowedRoots: [ROOT], config }));
  index = buildIndex(model);
});

describe('identité des classes', () => {
  it('deux composants homonymes sont gardés tous les deux, chacun avec ses propres liens', () => {
    const components = model.nodes.filter((n) => n.kind === 'COMPONENT').map((n) => n.id);
    expect(components).toEqual(
      expect.arrayContaining([`COMPONENT:front:${ADMIN}`, `COMPONENT:front:${CATALOG}`]),
    );
    expect(edge('CALLS', M(`${ADMIN}#refresh`), M('AdminService#load'))?.confidence).toBe('CONFIRMED');
    expect(edge('CALLS', M(`${CATALOG}#refresh`), M('CatalogService#load'))?.confidence).toBe('CONFIRMED');
    // Jamais croisés : chaque composant n'appelle que le service de son dossier.
    expect(edge('CALLS', M(`${ADMIN}#refresh`), M('CatalogService#load'))).toBeUndefined();
    expect(edge('CALLS', M(`${CATALOG}#refresh`), M('AdminService#load'))).toBeUndefined();
    expect(model.scan.sources[0]?.errors.join('\n')).not.toContain('declared twice');
  });

  it('une route qui importe son composant sous un alias le désigne bien', () => {
    expect(edge('DISPLAYS', 'ROUTE:front:/admin', `COMPONENT:front:${ADMIN}`)?.confidence).toBe('CONFIRMED');
    expect(edge('DISPLAYS', 'ROUTE:front:/catalog', `COMPONENT:front:${CATALOG}`)?.confidence).toBe(
      'CONFIRMED',
    );
    const features = new Map(model.features.map((f) => [f.id, f.nodes.length]));
    expect(features.get('FEATURE:ROUTE:front:/admin')).toBeGreaterThan(1);
    expect(features.get('FEATURE:ROUTE:front:/catalog')).toBeGreaterThan(1);
  });

  it('ClassIdentity : le plus court suffixe de dossiers, les alias, et une référence ambiguë non attribuée', () => {
    const identity = new ClassIdentity([
      { path: 'a/x/list.ts', text: 'export class List {}' },
      { path: 'b/x/list.ts', text: 'export class List {}' },
      { path: 'c/use.ts', text: "import { List as L } from '../a/x/list';\nexport class Use {}" },
      { path: 'c/other.ts', text: '// class List in a comment\nexport class Other {}' },
    ]);
    expect(identity.key('a/x/list.ts', 'List')).toBe('List(a/x)');
    expect(identity.key('b/x/list.ts', 'List')).toBe('List(b/x)');
    expect(identity.resolve('c/use.ts', 'L')).toBe('List(a/x)');
    expect(identity.resolve('c/other.ts', 'List')).toBeUndefined();
    expect(identity.duplicates()).toEqual(['List']);
    expect(
      importBindingsOf('c/u.ts', "import { A, B as C, type D } from './m';", new Set(['c/m.ts'])).get('C'),
    ).toEqual({ name: 'B', specifier: './m', file: 'c/m.ts' });
  });
});

describe('conservation des liens', () => {
  it('une relation non raccordable est gardée, consultable, avec sa cause et sa preuve', () => {
    const legacy = model.unresolved?.find((u) => u.from === 'ROUTE:front:/legacy');
    expect(legacy).toMatchObject({
      kind: 'DISPLAYS',
      to: 'COMPONENT:front:LegacyComponent',
      state: 'UNRESOLVED',
      cause: 'TARGET_MISSING',
    });
    expect(legacy?.evidence[0]).toMatchObject({ file: 'src/app/app.routes.ts' });
    // Le compteur du scan dit la même chose : rien n'est perdu sans être compté.
    expect(model.scan.unattached?.DISPLAYS).toBe(1);
    // Une relation non résolue n'est jamais un lien du parcours.
    expect(model.edges.some((e) => e.to === 'COMPONENT:front:LegacyComponent')).toBe(false);
    expect(model.nodes.some((n) => n.id === 'ROUTE:front:/legacy')).toBe(true);
  });
});

describe('liens non résolus : API et onglet du Dashboard', () => {
  it('la liste est filtrable par cause, type et texte, et compte toutes les relations', () => {
    const all = unresolvedOf(index);
    expect(all.total).toBe(model.unresolved?.length);
    expect(all.byCause.TARGET_MISSING).toBeGreaterThanOrEqual(1);
    expect(all.uncounted).toBe(0);
    expect(
      unresolvedOf(index, { status: 'TARGET_MISSING', type: 'DISPLAYS' }).items.map((u) => u.from),
    ).toContain('ROUTE:front:/legacy');
    expect(unresolvedOf(index, { q: 'legacy' }).total).toBe(1);
    expect(unresolvedOf(index, { status: 'SELF' }).total).toBe(0);
  });

  it('l’onglet dit la cause, la raison et la preuve, et échappe le texte', () => {
    const page = unresolvedOf(index);
    const html = unresolvedTab(
      { unresolved: page, uPage: 1, uCause: '', uQuery: '' },
      {
        locale: 'fr',
        evidence: (e) => `<a>${e.file ?? ''}:${String(e.line ?? '')}</a>`,
        pager: () => '',
        spinner: () => '…',
        loading: false,
        paneError: (e) => e,
      },
    );
    expect(html).toContain('Liens non résolus');
    expect(html).toContain('Cible absente des sources');
    expect(html).toContain('/legacy');
    expect(html).toContain('src/app/app.routes.ts:12');
    const empty = unresolvedTab(
      { unresolved: { ...page, items: [], total: 0 }, uPage: 1, uCause: 'SELF', uQuery: '<b>' },
      {
        locale: 'en',
        evidence: () => '',
        pager: () => '',
        spinner: () => '',
        loading: false,
        paneError: (e) => e,
      },
    );
    expect(empty).toContain('No unresolved link for these criteria.');
    expect(empty).not.toContain('<b>');
  });
});

describe('parcours contextualisés (store partagé)', () => {
  it('VALIDATE n’exécute pas le chargement : GET /api/orders n’est pas en aval de submit', () => {
    const path = down(M('OrdersComponent#submit'));
    expect(path).toEqual(
      expect.arrayContaining([
        M("OrderStore#dispatch⟨type='VALIDATE'⟩"),
        M('OrderStore#validate'),
        M("OrderStore#dispatch⟨type='SAVE'⟩"),
        // L'émission SAVE arrive sur le canal SAVE du flux d'actions : seuls les traitements qui acceptent
        // ce type (saved$) en partent.
        S("OrderStore.actions⟨type='SAVE'⟩"),
        S('OrderStore.saved$'),
        M('OrderApi#create'),
        M('OrdersComponent#onSaved'),
      ]),
    );
    // Faux liens éliminés : l'état partagé est alimenté par list(), mais submit ne l'appelle jamais.
    expect(path).not.toContain(M('OrderApi#list'));
    expect(path).not.toContain(M('OrderStore#load'));
    expect(path).not.toContain(M("OrderStore#dispatch⟨type='LOAD'⟩"));
  });

  it('LOAD charge, mais n’atteint pas le flux filtré sur SAVE ni l’enregistrement', () => {
    const path = down(M('OrdersComponent#reload'));
    expect(path).toEqual(
      expect.arrayContaining([
        M('OrderStore#load'),
        M('OrderApi#list'),
        S('OrderStore.state'),
        M('OrdersComponent#onState'),
      ]),
    );
    expect(path).not.toContain(S('OrderStore.saved$'));
    expect(path).not.toContain(M('OrderApi#create'));
    expect(path).not.toContain(M('OrderStore#validate'));
  });

  it('la provenance d’un état est en amont : l’état partagé remonte à list(), il n’y mène pas', () => {
    expect(down(S('OrderStore.state'))).not.toContain(M('OrderApi#list'));
    expect(up(S('OrderStore.state'))).toContain(M('OrderApi#list'));
  });

  it('état → condition d’affichage : le rappel mène au conteneur qu’il rend visible', () => {
    const path = down(M('OrdersComponent#onState'));
    expect(path).toEqual(
      expect.arrayContaining([
        'CONDITION:front:OrdersComponent#container:status-invalid:visible',
        'CONTAINER:front:OrdersComponent#container:status-invalid',
      ]),
    );
  });

  it('la carte « Parcours & Graphe » suit le même sens', () => {
    const fm = featureMap(index, cov, 'FEATURE:ROUTE:front:/orders', { item: M('OrdersComponent#submit') });
    const steps = fm?.trace?.down.map((s) => s.id) ?? [];
    expect(steps).toContain(M('OrderApi#create'));
    expect(steps).not.toContain(M('OrderApi#list'));
  });
});

describe('ngOnInit : installation et propagation séparées', () => {
  it('ngOnInit installe deux abonnements ; chaque émission exécute le rappel, pas ngOnInit', () => {
    const install = edge('READS', M('OrdersComponent#ngOnInit'), S('OrderStore.state$'));
    expect(install?.reason).toContain('installe un abonnement');
    expect(install?.detail?.async).toContain('installation');
    expect(edge('READS', M('OrdersComponent#ngOnInit'), S('OrderStore.saved$'))).toBeDefined();
    // La propagation : du flux vers le rappel.
    expect(edge('CALLS', S('OrderStore.state$'), M('OrdersComponent#onState'))).toBeDefined();
    expect(edge('CALLS', S('OrderStore.saved$'), M('OrdersComponent#onSaved'))).toBeDefined();
    // Aucun flux ni dispatch ne « rappelle » ngOnInit.
    expect(model.edges.filter((e) => e.to === M('OrdersComponent#ngOnInit')).map((e) => e.from)).toEqual([
      'COMPONENT:front:OrdersComponent',
    ]);
    expect(down(M('OrdersComponent#submit'))).not.toContain(M('OrdersComponent#ngOnInit'));
  });
});

describe('déterminisme et incrémental', () => {
  const signature = (m: CartographyModel): string =>
    JSON.stringify({
      edges: m.edges.map((e) => `${e.id}|${e.confidence}`).sort(),
      unresolved: (m.unresolved ?? []).map((u) => `${u.id}|${u.cause}`).sort(),
      nodes: m.nodes.map((n) => n.id).sort(),
    });

  it('les mêmes sources donnent le même graphe', async () => {
    const again = await runScan({ incremental: false, allowedRoots: [ROOT], config });
    expect(signature(again.model)).toBe(signature(model));
  });

  it('un scan incrémental sans modification reprend les faits et garde le même graphe', async () => {
    const next = await runScan({
      incremental: true,
      allowedRoots: [ROOT],
      config,
      previous: { facts, sources: model.scan.sources },
    });
    expect(next.model.scan.sources[0]?.state).toBe('REUSED');
    expect(signature(next.model)).toBe(signature(model));
  });

  it('des faits d’une version d’analyseur antérieure ne sont jamais repris', async () => {
    const next = await runScan({
      incremental: true,
      allowedRoots: [ROOT],
      config,
      previous: {
        facts: facts.map((f) => ({ ...f, analyzer: 'cartography-10;rxjs-3' })),
        sources: model.scan.sources,
      },
    });
    expect(next.model.scan.sources[0]?.state).toBe('SCANNED');
  });
});
