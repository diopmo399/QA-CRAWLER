import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CartographyConfig,
  CartographyModel,
  MapEdge,
  StructureItem,
} from '../../src/sdk/core/cartography.js';
import { parseTemplate } from '../../src/cartography/analyze-template.js';
import { buildIndex, type CoverageContext } from '../../src/cartography/explorer.js';
import type { SourceFacts, UiChild, UiElement } from '../../src/cartography/facts.js';
import { computeImpact } from '../../src/cartography/impact.js';
import { ANALYZERS, runScan } from '../../src/cartography/scan.js';
import { elementSheet, structureOf } from '../../src/cartography/structure.js';

/**
 * LES ONGLETS ANGULAR : un écran à onglets Material (statiques, désactivé, conditionnel, imbriqués, générés par
 * *ngFor, chargés à la sélection ou par @defer, sélection pilotée par un store RxJS, onglet routé) relié à un
 * BFF Spring. Sont vérifiés la hiérarchie, les conditions, le chargement différé, les composants affichés (et
 * réutilisés), les appels déclenchés depuis un onglet, la dépendance entre onglets par un store partagé, les
 * préconditions d'accès, l'impact d'une modification, puis les autres bibliothèques (ngbNav, PrimeNG, onglets
 * maison et rôles ARIA, @for, ngComponentOutlet) directement sur le gabarit.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-tabs');
const configFor = (root: string): CartographyConfig => ({
  schema: 1,
  sources: [
    {
      id: 'front',
      name: 'Front',
      layer: 'FRONTEND',
      path: path.join(root, 'front'),
      include: [],
      enabled: true,
    },
    { id: 'bff', name: 'BFF', layer: 'BFF', path: path.join(root, 'bff'), include: [], enabled: true },
  ],
});
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const C = (slug: string) => `CONTAINER:front:DossierComponent#container:${slug}`;
const GROUP = C('onglets-identite-documents-administratio');
let model: CartographyModel;
let facts: SourceFacts[];
const edge = (kind: MapEdge['kind'], from: string, to: string): MapEdge | undefined =>
  model.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
const element = (slug: string): UiElement | undefined =>
  facts
    .find((f) => f.sourceId === 'front')
    ?.ui?.elements?.find((e) => e.id === `DossierComponent#container:${slug}`);
const sheet = (slug: string) => elementSheet(buildIndex(model), cov, C(slug))?.tab;

beforeAll(async () => {
  ({ model, facts } = await runScan({
    config: configFor(FIXTURE),
    allowedRoots: [FIXTURE],
    incremental: false,
  }));
});

describe('tabs read from the template', () => {
  it('static tabs: the group and its tabs, with their labels (attribute or mat-tab-label)', () => {
    expect(element('onglets-identite-documents-administratio')?.tab).toMatchObject({
      role: 'GROUP',
      library: 'material',
    });
    expect(element('identite')?.tab).toMatchObject({ role: 'TAB', label: 'Identité' });
    expect(element('documents')?.tab).toMatchObject({ role: 'TAB', label: 'Documents' });
    for (const slug of ['identite', 'documents', 'administration', 'extratabs'])
      expect(edge('CONTAINS', GROUP, C(slug))?.confidence).toBe('CONFIRMED');
    expect(model.nodes.find((n) => n.id === C('identite'))?.detail.tab).toBe('TAB');
  });

  it('dynamic tabs: *ngFor gives one generated tab, its labels read from the class array', () => {
    expect(element('extratabs')?.tab).toMatchObject({ repeat: 'extraTabs', items: ['Contacts', 'Notes'] });
    expect(sheet('extratabs')?.preconditions).toContain(
      'sélectionner un onglet généré par extraTabs (Contacts, Notes)',
    );
  });

  it('nested tabs: a group inside a tab, reachable through its parent', () => {
    const inner = C('onglets-droits-journal');
    expect(edge('CONTAINS', C('administration'), inner)).toBeDefined();
    expect(edge('CONTAINS', inner, C('droits'))).toBeDefined();
    expect(edge('CONTAINS', inner, C('journal'))).toBeDefined();
    expect(sheet('journal')?.preconditions).toEqual([
      'ouvrir l’écran /dossier',
      'condition d’affichage vraie : users.isAdmin$ | async',
      'sélectionner l’onglet « Administration »',
      'sélectionner l’onglet « Journal »',
      'le contenu n’est instancié qu’à la sélection de l’onglet',
    ]);
  });

  it('conditional tab: *ngIf on a store stream, followed to the store', () => {
    expect(element('administration')?.visibleWhen?.expression).toBe('users.isAdmin$ | async');
    const condition = model.edges.find((e) => e.kind === 'VISIBLE_WHEN' && e.from === C('administration'));
    expect(condition).toBeDefined();
    expect(
      model.edges.some(
        (e) => e.kind === 'CONTROLLED_BY' && e.from === condition?.to && e.to.includes('isAdmin$'),
      ),
    ).toBe(true);
  });

  it('disabled tab: [disabled] is an enabling condition, part of the preconditions', () => {
    expect(element('documents')?.disabledWhen?.expression).toBe('!(dossier.validated$ | async)');
    expect(sheet('documents')?.preconditions).toContain(
      'onglet « Documents » activé : !(dossier.validated$ | async) doit être faux',
    );
  });

  it('lazy tabs: matTabContent (at selection) and @defer, kept on the tab and on the displayed component', () => {
    expect(element('documents')?.tab?.lazy).toBe('TEMPLATE');
    expect(element('journal')?.tab?.lazy).toBe('DEFER');
    expect(edge('CONTAINS', C('documents'), 'COMPONENT:front:DocumentsComponent')?.reason).toContain(
      'instancié à la sélection',
    );
    expect(edge('CONTAINS', C('journal'), 'COMPONENT:front:AuditComponent')?.reason).toContain('@defer');
  });

  it('RxJS-driven selection: [selectedIndex] bound to a store stream, (selectedTabChange) to a handler', () => {
    expect(edge('CONTROLLED_BY', GROUP, 'STREAM:front:TabState.selected$')?.confidence).toBe('CONFIRMED');
    expect(edge('TRIGGERS', GROUP, 'METHOD:front:DossierComponent#onTab')).toBeDefined();
    const group = elementSheet(buildIndex(model), cov, GROUP)?.tab;
    expect(group?.selectedBy.map((s) => s.stream)).toEqual(['TabState.selected$']);
    expect(group?.tabs.map((t) => t.name)).toEqual([
      'Identité',
      'Documents',
      'Administration',
      'extraTabs (Contacts, Notes)',
    ]);
  });
});

describe('what a tab shows and does', () => {
  it('API calls started from a tab: its button (Identité) and its component lifecycle (Documents)', () => {
    const identity = sheet('identite');
    expect(identity?.components.map((c) => c.name)).toEqual(['IdentityFormComponent']);
    expect(identity?.buttons).toBe(1);
    expect(identity?.apis.map((a) => a.name)).toContain('POST /api/dossier/validate');
    expect(identity?.stores).toContain('DossierState');
    expect(sheet('documents')?.apis.map((a) => a.name)).toContain('GET /api/dossier/documents');
  });

  it('route navigation: a mat-tab-link with routerLink is resolved to its child route', () => {
    expect(element('historique')?.tab).toMatchObject({ library: 'route', route: 'history', lazy: 'ROUTE' });
    expect(edge('CONTAINS', C('historique'), 'COMPONENT:front:HistoryComponent')?.reason).toContain(
      '/dossier/history',
    );
    expect(sheet('historique')?.routeUnresolved).toBeUndefined();
    expect(sheet('historique')?.apis.map((a) => a.name)).toContain('GET /api/dossier/history');
  });

  it('reused components: the same component in two tabs is listed with both places', () => {
    const address = model.nodes.find((n) => n.id === 'COMPONENT:front:AddressComponent');
    expect(address?.detail.reusedIn).toEqual([
      'onglet « Droits »',
      'onglet « extraTabs (généré par extraTabs) »',
    ]);
    expect(sheet('droits')?.components[0]?.reusedIn.length).toBe(2);
  });

  it('shared store between tabs: Documents depends on Identité (it writes what Documents reads), never confirmed', () => {
    const dependency = edge('DEPENDS_ON', C('documents'), C('identite'));
    expect(dependency?.confidence).toBe('PROBABLE');
    expect(dependency?.reason).toContain('DossierState.validate');
    expect(sheet('documents')?.dependsOn.map((d) => d.name)).toEqual(['Identité']);
    expect(sheet('identite')?.usedBy.map((d) => d.name)).toEqual(['Documents']);
    // Aucun onglet ne lit ce que l'onglet Droits modifie : pas de dépendance inventée.
    expect(model.edges.filter((e) => e.kind === 'DEPENDS_ON' && e.from.includes('#container:')).length).toBe(
      1,
    );
  });

  it('the page feature reaches the calls made inside its tabs', () => {
    const dossier = model.features.find((f) => f.name === 'Dossier');
    const labels = dossier?.chain.map((s) => s.label) ?? [];
    expect(labels).toContain('Composant DocumentsComponent');
    expect(labels.some((l) => l.startsWith('POST /api/dossier/validate'))).toBe(true);
  });

  it('structure tree: page → group → tab → nested group → tab, without loops', () => {
    const feature = model.features.find((f) => f.name === 'Dossier');
    const structure = structureOf(buildIndex(model), feature?.id);
    const find = (items: readonly StructureItem[], id: string): StructureItem | undefined => {
      for (const item of items) {
        if (item.id === id) return item;
        const inner = find(item.children, id);
        if (inner) return inner;
      }
      return undefined;
    };
    const roots = structure?.roots ?? [];
    expect(find(roots, GROUP)?.tab).toBe('GROUP');
    const admin = find(roots, C('administration'));
    expect(admin?.tab).toBe('TAB');
    expect(find(admin?.children ?? [], C('journal'))?.tab).toBe('TAB');
    let depth = 0;
    const walk = (items: readonly StructureItem[], d: number): void => {
      depth = Math.max(depth, d);
      for (const item of items) walk(item.children, d + 1);
    };
    walk(roots, 1);
    expect(depth).toBeLessThan(14);
  });
});

describe('impact between tabs', () => {
  let copy: string;
  afterAll(async () => {
    await rm(copy, { recursive: true, force: true });
  });

  it('the analyser version changed: facts of an older version are read again', () => {
    expect(Number(/^cartography-(\d+);/.exec(ANALYZERS)?.[1])).toBeGreaterThanOrEqual(3);
    expect(facts.every((f) => f.analyzer === ANALYZERS)).toBe(true);
  });

  it('a changed store is placed in the tabs that trigger it (sure) and in those whose conditions read it (potential)', async () => {
    copy = await mkdtemp(path.join(tmpdir(), 'carto-tabs-'));
    await cp(FIXTURE, copy, { recursive: true });
    const before = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const stores = path.join(copy, 'front/src/app/dossier/stores.ts');
    await writeFile(
      stores,
      (await readFile(stores, 'utf8'))
        .replace(
          "import { BehaviorSubject } from 'rxjs';",
          "import { BehaviorSubject, distinctUntilChanged } from 'rxjs';",
        )
        .replace('this.validated.asObservable()', 'this.validated.pipe(distinctUntilChanged())'),
    );
    const after = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const tabs = computeImpact(before.model, after.model, []).tabs ?? [];
    expect(tabs.every((t) => t.element === 'STREAM:front:DossierState.validated$')).toBe(true);
    const identity = tabs.find((t) => t.tabName === 'Identité');
    expect(identity).toMatchObject({ how: 'TRIGGERS', page: '/dossier', feature: 'Dossier' });
    const documents = tabs.find((t) => t.tabName === 'Documents');
    expect(documents).toMatchObject({ how: 'READS', confidence: 'PROBABLE' });
    expect(tabs.some((t) => t.tabName === 'Droits')).toBe(false);
  });

  it('a changed component of a nested tab names the innermost tab, not its parents', async () => {
    const before = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const audit = path.join(copy, 'front/src/app/dossier/audit.component.ts');
    await writeFile(
      audit,
      (await readFile(audit, 'utf8')).replace(
        '<h2>Journal</h2>',
        '<h2>Journal</h2><button type="button" (click)="refresh()">Actualiser</button>',
      ),
    );
    const after = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const tabs = computeImpact(before.model, after.model, []).tabs ?? [];
    const added = tabs.filter((t) => t.element === 'BUTTON:front:AuditComponent#button:actualiser');
    expect(added.map((t) => [t.tabName, t.how, t.confidence])).toEqual([
      ['Journal', 'CONTAINS', 'CONFIRMED'],
    ]);
  });
});

describe('other tab libraries, read from the template alone', () => {
  const parse = (html: string) => {
    const children: (UiChild & { holder?: UiElement })[] = [];
    const elements = parseTemplate('T', html, 't.html', 0, children);
    return { elements, children, tabs: elements.filter((e) => e.tab) };
  };

  it('ngbNav: items, link labels, lazy ngbNavContent and the bound active id', () => {
    const { tabs, children } = parse(`<ul ngbNav #nav="ngbNav" [(activeId)]="active" class="nav-tabs">
  <li ngbNavItem="profile"><a ngbNavLink>Profil</a>
    <ng-template ngbNavContent><app-profile></app-profile></ng-template></li>
  <li ngbNavItem="security" [disabled]="locked"><a ngbNavLink>Sécurité</a>
    <ng-template ngbNavContent><app-security></app-security></ng-template></li>
</ul>
<div [ngbNavOutlet]="nav"></div>`);
    expect(tabs.map((t) => [t.tab?.role, t.tab?.library, t.tab?.label])).toEqual([
      ['GROUP', 'ngb', undefined],
      ['TAB', 'ngb', 'Profil'],
      ['TAB', 'ngb', 'Sécurité'],
    ]);
    expect(tabs[0]?.tab?.selectedBy?.expression).toBe('active');
    expect(tabs[2]?.disabledWhen?.expression).toBe('locked');
    expect(children.map((c) => [c.tag, c.lazy])).toEqual([
      ['app-profile', 'TEMPLATE'],
      ['app-security', 'TEMPLATE'],
    ]);
  });

  it('PrimeNG: p-tabView / p-tabPanel with header and activeIndex', () => {
    const { tabs } = parse(`<p-tabView [activeIndex]="index">
  <p-tabPanel header="Résumé"><p>Texte</p></p-tabPanel>
  <p-tabPanel header="Détails" *ngIf="ready"><p>Plus</p></p-tabPanel>
</p-tabView>`);
    expect(tabs.map((t) => [t.tab?.role, t.tab?.library, t.tab?.label])).toEqual([
      ['GROUP', 'primeng', undefined],
      ['TAB', 'primeng', 'Résumé'],
      ['TAB', 'primeng', 'Détails'],
    ]);
    expect(tabs[0]?.tab?.selectedBy?.expression).toBe('index');
    expect(tabs[2]?.visibleWhen?.expression).toBe('ready');
  });

  it('custom tabs: a project component (app-tabs/app-tab) and ARIA roles tablist/tabpanel', () => {
    const custom = parse(
      `<app-tabs><app-tab title="Un">A</app-tab><app-tab title="Deux">B</app-tab></app-tabs>`,
    );
    expect(custom.tabs.map((t) => [t.tab?.role, t.tab?.library, t.tab?.label])).toEqual([
      ['GROUP', 'custom', undefined],
      ['TAB', 'custom', 'Un'],
      ['TAB', 'custom', 'Deux'],
    ]);
    const aria = parse(`<div role="tablist"><div role="tabpanel" aria-label="Général">x</div></div>`);
    expect(aria.tabs.map((t) => [t.tab?.role, t.tab?.library])).toEqual([
      ['GROUP', 'custom'],
      ['TAB', 'custom'],
    ]);
  });

  it('@for tabs and a component chosen by ngComponentOutlet', () => {
    const { tabs, children } = parse(`<mat-tab-group>
  @for (s of sections; track s.id) {
    <mat-tab [label]="s.title"><ng-container *ngComponentOutlet="s.view"></ng-container></mat-tab>
  }
</mat-tab-group>`);
    expect(tabs[1]?.tab?.repeat).toBe('sections');
    expect(children.some((c) => c.lazy === 'OUTLET')).toBe(true);
  });

  it('a template without tabs gives no tab', () => {
    expect(parse('<section><h2>Liste</h2><button (click)="go()">Aller</button></section>').tabs).toEqual([]);
  });
});
