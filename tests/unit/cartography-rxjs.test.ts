import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel, MapEdge } from '../../src/sdk/core/cartography.js';
import { analyzeRxjs } from '../../src/cartography/analyze-rxjs.js';
import { buildIndex, type CoverageContext } from '../../src/cartography/explorer.js';
import type { SourceFacts } from '../../src/cartography/facts.js';
import { computeImpact, diffModels } from '../../src/cartography/impact.js';
import { ANALYZERS, runScan } from '../../src/cartography/scan.js';
import { elementSheet } from '../../src/cartography/structure.js';
import { loadTypeScript } from '../../src/static-analysis/typescript-loader.js';

/**
 * LES STORES ET FLUX RXJS MAISON : une vraie lecture (AST TypeScript) d'un frontal Angular dont l'état vit
 * dans des Subjects sans convention de nommage ni NgRx, relié à un BFF Spring. Sont vérifiés : la chaîne de
 * déclenchement (bouton → méthode → store → Subject → pipeline switchMap → façade → service → client HTTP
 * maison → BFF), la vue alimentation (condition → flux combineLatest → flux du store → réponse → propriété
 * du DTO du BFF), @Output, HttpClient.request(), et les cas négatifs (flux jamais souscrit, Observable perdu,
 * cycle, classe absente, correspondance ambiguë) avec leur diagnostic. Puis le scan incrémental (faits d'une
 * autre version d'analyseur relus) et l'impact d'une modification de store.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-rxjs');
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
let model: CartographyModel;
let facts: SourceFacts[];
const edge = (kind: MapEdge['kind'], from: string, to: string): MapEdge | undefined =>
  model.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
const ui = () => facts.find((f) => f.sourceId === 'front')?.ui;

beforeAll(async () => {
  ({ model, facts } = await runScan({
    config: configFor(FIXTURE),
    allowedRoots: [FIXTURE],
    incremental: false,
  }));
});

describe('custom RxJS stores, detected by behaviour', () => {
  it('a class keeping state in Subjects is a store, whatever its name; a relay without state is a service', () => {
    const roles = new Map((ui()?.symbols ?? []).map((s) => [s.id, s.role]));
    expect(roles.get('ActivationContext#activate')).toBe('STORE');
    expect(roles.get('UserContext.permissions$')).toBe('STORE');
    expect(roles.get('ActivationFacade#activate')).toBe('SERVICE');
    const result = ui()?.symbols?.find((s) => s.id === 'ActivationContext.result$');
    expect(result?.stream).toMatchObject({ kind: 'DERIVED', consumed: 'SUBSCRIBED' });
    expect(result?.stream?.operators).toEqual(expect.arrayContaining(['filter', 'switchMap']));
    expect(result?.stream?.filters).toEqual(['(id) => !!id']);
    const requests = ui()?.symbols?.find((s) => s.id === 'ActivationContext.requests');
    expect(requests?.stream).toMatchObject({ kind: 'SUBJECT', type: 'Subject' });
    expect(ui()?.symbols?.find((s) => s.id === 'ActivationContext.state')?.stream?.type).toBe(
      'BehaviorSubject',
    );
  });

  it('trigger chain: button → component → store → Subject → switchMap pipeline → facade → service → custom client → BFF', () => {
    const feature = model.features.find((f) => f.name === 'Activation');
    const labels = feature?.chain.map((s) => s.label) ?? [];
    const order = [
      'Action ActivationComponent.activate()',
      'Store ActivationContext.activate()',
      'Flux ActivationContext.requests',
      'Flux ActivationContext.result$ (filter, switchMap)',
      'Service ActivationFacade.activate()',
      'POST {base}/api/activation',
    ].map((label) => labels.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(labels).toContain('POST /api/activation (ActivationController.activate)');
    // Chaque lien porte sa preuve (fichier, ligne) et sa justification.
    const emit = edge(
      'CALLS',
      'METHOD:front:ActivationContext#activate',
      'STREAM:front:ActivationContext.requests',
    );
    expect(emit?.confidence).toBe('CONFIRMED');
    expect(emit?.evidence[0]).toMatchObject({ file: 'src/app/activation/activation-context.ts' });
    expect(emit?.evidence[0]?.line).toBeGreaterThan(0);
    const pipe = edge(
      'CALLS',
      'STREAM:front:ActivationContext.result$',
      'METHOD:front:ActivationFacade#activate',
    );
    expect(pipe?.reason).toMatch(
      /switchMap → ActivationFacade\.activate\(\).*souscrit par ActivationContext#constructor/,
    );
    // Le client HTTP maison reçoit l'URL : l'appel est celui du service, avec l'URL fournie.
    const call = ui()?.calls.find((c) => c.id === 'ActivationService#activate');
    expect(call).toMatchObject({ method: 'POST', path: '{base}/api/activation', via: 'ApiClient#post' });
    expect(ui()?.calls.some((c) => c.id === 'ApiClient#post')).toBe(false);
    // L'adresse de base vient de la configuration : le lien au BFF est probable (fin du chemin), et dit pourquoi.
    const toBff = model.edges.find(
      (e) =>
        e.from === 'METHOD:front:ActivationService#activate' &&
        e.kind === 'CALLS' &&
        model.nodes.find((n) => n.id === e.to)?.kind === 'API',
    );
    expect(toBff?.confidence).toBe('PROBABLE');
    expect(toBff?.reason).toMatch(/adresse de base non résolue/);
  });

  it('the button sheet follows the handler through the store to the HTTP call and the BFF endpoint', () => {
    const sheet = elementSheet(buildIndex(model), cov, 'BUTTON:front:ActivationComponent#button:activer');
    const action = sheet?.actions[0];
    expect(action?.triggers.map((n) => n.name)).toContain('ActivationService.activate');
    expect(action?.via?.map((n) => n.name)).toEqual(
      expect.arrayContaining([
        'ActivationComponent.activate',
        'ActivationContext.activate',
        'ActivationContext.result$',
      ]),
    );
    expect(action?.endpoints.map((n) => n.name)).toContain('POST /api/activation');
    // La condition suit les flux jusqu'à la réponse du BFF, sans inventer de méthode qui la calcule.
    const condition = sheet?.conditions[0];
    expect(condition?.chain.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        'STREAM:front:ActivationContext.status$',
        'FIELD:bff:ActivationStatusDto.status',
      ]),
    );
    expect(condition?.status).toBe('UNKNOWN');
    expect(condition?.undetermined).toMatch(/flux RxJS jusqu’à la réponse/);
  });

  it('HttpClient.request(), @Output of a child and the lifecycle are followed', () => {
    expect(ui()?.calls.find((c) => c.id === 'ActivationService#status')).toMatchObject({
      method: 'GET',
      path: '/api/activation/status',
    });
    expect(
      edge('CALLS', 'METHOD:front:ConfirmComponent#confirm', 'METHOD:front:ActivationComponent#onConfirm')
        ?.reason,
    ).toMatch(/@Output confirmed/);
    expect(
      edge('CALLS', 'COMPONENT:front:ActivationComponent', 'METHOD:front:ActivationComponent#ngOnInit')
        ?.confidence,
    ).toBe('CONFIRMED');
  });

  it('data view: condition → combineLatest stream → store streams → response → BFF DTO property', () => {
    const condition = 'CONDITION:front:ActivationComponent#button:activer:visible';
    expect(edge('CONTROLLED_BY', condition, 'STREAM:front:ActivationComponent.canActivate$')).toBeDefined();
    expect(
      edge(
        'DEPENDS_ON',
        'STREAM:front:ActivationComponent.canActivate$',
        'STREAM:front:UserContext.permissions$',
      ),
    ).toBeDefined();
    expect(
      edge(
        'DEPENDS_ON',
        'STREAM:front:ActivationComponent.canActivate$',
        'STREAM:front:ActivationContext.status$',
      ),
    ).toBeDefined();
    expect(
      edge('DEPENDS_ON', 'STREAM:front:ActivationContext.state', 'METHOD:front:ActivationService#status')
        ?.reason,
    ).toMatch(/réponse/);
    const field = edge(
      'CONTROLLED_BY',
      'STREAM:front:ActivationContext.allowed$',
      'FIELD:bff:ActivationStatusDto.canActivate',
    );
    expect(field?.confidence).toBe('PROBABLE');
    expect(field?.reason).toMatch(/canActivate/);
    // Une dépendance de visibilité n'est pas un déclenchement : aucun appel ne part de la condition.
    expect(model.edges.some((e) => e.from === condition && e.kind === 'CALLS')).toBe(false);
  });
});

describe('negative cases: nothing is invented, each break is explained', () => {
  it('a stream never subscribed, a lost Observable, a cycle and a missing class: no link, an exact diagnostic', () => {
    const diagnostics = ui()?.diagnostics ?? [];
    const by = (from: string) => diagnostics.find((d) => d.from === from);
    expect(by('ActivationComponent#fireOrphan')).toMatchObject({
      code: 'STREAM_NOT_SUBSCRIBED',
      at: 'OrphanStore.never$',
    });
    expect(by('ActivationComponent#forget')).toMatchObject({ code: 'OBSERVABLE_NOT_SUBSCRIBED' });
    expect(by('ActivationComponent#loop')?.message).toMatch(
      /CycleA\.ping\(\) → CycleB\.pong\(\) → CycleA\.ping\(\)/,
    );
    expect(by('ActivationComponent#old')).toMatchObject({ code: 'SERVICE_NOT_FOUND' });
    expect(
      edge('CALLS', 'STREAM:front:OrphanStore.never$', 'METHOD:front:ActivationService#status')?.confidence,
    ).toBe('UNKNOWN');
    expect(ui()?.symbols?.find((s) => s.id === 'OrphanStore.never$')?.stream?.consumed).toBe('NONE');
    const feature = model.features.find((f) => f.name === 'Activation');
    expect(feature?.diagnostics?.length).toBe(4);
    expect(feature?.diagnostics).toContain(
      'ActivationComponent.old() — LegacyGateway.send() : la classe LegacyGateway n’est pas dans les sources analysées',
    );
    expect(feature?.chain.some((s) => s.label.includes('OrphanStore'))).toBe(false);
  });

  it('an ambiguous HTTP correspondence is not linked, and says why', () => {
    const items = model.nodes.find((n) => n.id === 'METHOD:front:ActivationService#items');
    expect(items?.detail.match).toMatch(/correspondance ambiguë : 2 endpoints/);
    expect(model.edges.some((e) => e.from === items?.id && e.kind === 'CALLS')).toBe(false);
  });
});

describe('the analyser on its own', () => {
  const read = (p: string, text: string) => ({ path: p, text, hash: '', bytes: text.length });

  it('mergeMap, a store reading another store, an async consumer, a call in a property, an unresolved URL', async () => {
    const ts = await loadTypeScript();
    if (!ts) throw new Error('typescript is required by the cartography');
    const rx = analyzeRxjs(
      ts,
      [
        read(
          'cart.ts',
          `@Injectable() export class SessionStore {
  private readonly user = new BehaviorSubject<string>('');
  readonly user$ = this.user.asObservable();
}
@Injectable() export class CartStore {
  private readonly add = new Subject<string>();
  readonly added$ = this.add.pipe(withLatestFrom(this.session.user$), mergeMap(([id, user]) => this.api.add(id, user)));
  constructor(private session: SessionStore, private api: CartApi) {}
  push(id: string) { this.add.next(id); }
}
@Injectable() export class CartApi {
  constructor(private http: HttpClient, private settings: Settings) {}
  readonly data$ = this.http.get('/api/data');
  add(id: string, user: string) { return this.http.post('/api/cart', { id, user }); }
  load = (id: string) => this.http.get(this.settings.endpoint(id));
}
@Injectable() export class ActivationStore {
  constructor(private api: CartApi) {}
  run() { return this.api.add('a', 'b'); }
}
@Component({ selector: 'app-cart', template: '<p>{{ cart.added$ | async }}</p><button (click)="buy()">Buy</button>' })
export class CartComponent {
  readonly data = toSignal(this.api.data$);
  constructor(public cart: CartStore, private api: CartApi) {}
  buy() { this.cart.push('1'); }
}`,
        ),
      ],
      new Map(),
    );
    const link = (kind: string, from: string, to: string) =>
      rx.links.find((l) => l.kind === kind && l.from === from && l.to === to);
    expect(link('EMIT', 'CartStore#push', 'CartStore.add')?.confidence).toBe('CONFIRMED');
    const pipe = link('PIPE', 'CartStore.added$', 'CartApi#add');
    expect(pipe?.confidence).toBe('PROBABLE');
    expect(pipe?.reason).toMatch(/mergeMap.*pipe async/);
    expect(link('DERIVES', 'CartStore.added$', 'SessionStore.user$')).toBeDefined();
    const symbols = rx.symbols;
    expect(symbols.find((s) => s.id === 'SessionStore.user$')?.role).toBe('STORE');
    // Nommé « Store » sans état RxJS : un service, pas un store.
    expect(symbols.find((s) => s.id === 'ActivationStore#run')?.role).toBe('SERVICE');
    expect(rx.calls.find((c) => c.id === 'CartApi#add')).toMatchObject({ method: 'POST', path: '/api/cart' });
    // L'appel fait dans la propriété est souscrit par toSignal.
    expect(rx.calls.find((c) => c.id === 'CartApi#data$')).toMatchObject({
      method: 'GET',
      path: '/api/data',
    });
    expect(link('PIPE', 'CartApi.data$', 'CartApi#data$')?.confidence).toBe('CONFIRMED');
    // Une URL lue à l'exécution : l'expression est gardée, la raison dite ; rien n'est relié.
    const dynamic = rx.calls.find((c) => c.id === 'CartApi#load');
    expect(dynamic?.path).toBeUndefined();
    expect(dynamic?.expression).toBe('this.settings.endpoint(id)');
    expect(dynamic?.unresolved).toMatch(/dynamiquement/);
  });
});

describe('incremental scans and impact', () => {
  let copy: string;
  afterAll(async () => {
    await rm(copy, { recursive: true, force: true });
  });

  it('facts from another analyser version are read again; facts of the current version are reused', async () => {
    copy = await mkdtemp(path.join(tmpdir(), 'carto-rx-'));
    await cp(FIXTURE, copy, { recursive: true });
    const first = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    expect(first.facts.every((f) => f.analyzer === ANALYZERS)).toBe(true);
    const reused = await runScan({
      config: configFor(copy),
      allowedRoots: [copy],
      incremental: true,
      previous: { facts: first.facts, sources: first.model.scan.sources },
    });
    expect(reused.model.scan.sources.map((s) => s.state)).toEqual(['REUSED', 'REUSED']);
    // Les faits d'un scan d'avant (sans version) : la source inchangée est relue, les relations apparaissent.
    const old = first.facts.map(({ analyzer: _analyzer, ...f }) => ({
      ...f,
      ui: f.ui ? { ...f.ui, links: [] } : undefined,
    }));
    const again = await runScan({
      config: configFor(copy),
      allowedRoots: [copy],
      incremental: true,
      previous: { facts: old, sources: first.model.scan.sources },
    });
    expect(again.model.scan.sources.map((s) => s.state)).toEqual(['SCANNED', 'SCANNED']);
    expect(again.facts.find((f) => f.sourceId === 'front')?.ui?.links?.length).toBeGreaterThan(0);
  });

  it('a change in a store pipeline reaches the feature that triggers it', async () => {
    const before = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const store = path.join(copy, 'front/src/app/activation/activation-context.ts');
    await writeFile(store, (await readFile(store, 'utf8')).replace('    filter((id) => !!id),\n', ''));
    const after = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const changes = diffModels(before.model, after.model);
    expect(changes.find((c) => c.node === 'STREAM:front:ActivationContext.result$')?.change).toBe('CHANGED');
    const report = computeImpact(before.model, after.model, []);
    expect(report.features.map((f) => f.name)).toContain('Activation');
  });
});
