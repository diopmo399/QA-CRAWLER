import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel, MapEdge } from '../../src/sdk/core/cartography.js';
import { analyzeRxjs, RXJS_ANALYZER } from '../../src/cartography/analyze-rxjs.js';
import type { SourceFacts, UiLink } from '../../src/cartography/facts.js';
import { computeImpact } from '../../src/cartography/impact.js';
import { ANALYZERS, runScan } from '../../src/cartography/scan.js';
import { loadTypeScript } from '../../src/static-analysis/typescript-loader.js';

/**
 * LE PARCOURS RECONSTRUIT PAR CONTEXTE : un store générique (`dispatch(action, payload)` qui choisit son
 * traitement par switch), appelé avec des valeurs connues ou non, des validations synchrones et asynchrones
 * (await, subscribe, forkJoin), un Subject entre deux stores, un service qui orchestre, un retour anticipé, un
 * dispatch conditionnel qui en déclenche un autre, une recherche annulable (switchMap, takeUntil) jamais
 * souscrite, un Observable perdu. Vérifié : chaque action n'atteint que ses branches, chaque lien dit sa
 * condition, ce qu'il attend et d'où viennent ses données ; ce qui n'est pas déterminable reste probable et dit
 * pourquoi ; l'impact suit les mêmes chemins.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-flow');
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
let model: CartographyModel;
let facts: SourceFacts[];
const links = (): UiLink[] => facts.find((f) => f.sourceId === 'front')?.ui?.links ?? [];
const link = (from: string, to: string): UiLink | undefined =>
  links().find((l) => l.from === from && l.to === to);
const from = (id: string): UiLink[] => links().filter((l) => l.from === id);
const SUBMIT = 'OrderStore#dispatch⟨OrderAction.Submit⟩';
const CANCEL = 'OrderStore#dispatch⟨OrderAction.Cancel⟩';
const ARCHIVE = 'OrderStore#dispatch⟨OrderAction.Archive⟩';
/** Les endpoints du BFF atteints depuis une méthode du composant (liens non UNKNOWN). */
const endpointsOf = (method: string): string[] => {
  const start = `METHOD:front:OrderComponent#${method}`;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift() ?? '';
    for (const e of model.edges)
      if (e.from === cur && e.kind === 'CALLS' && e.confidence !== 'UNKNOWN' && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
  }
  return [...seen]
    .filter((id) => id.startsWith('API:bff:'))
    .map((id) => id.slice('API:bff:'.length))
    .sort();
};

beforeAll(async () => {
  ({ model, facts } = await runScan({
    config: configFor(FIXTURE),
    allowedRoots: [FIXTURE],
    incremental: false,
  }));
});

describe('call context: a generic store method follows only the branches chosen by the value passed', () => {
  it('Cancel reaches the cancel branch only; the other branches are pruned, not merged', () => {
    expect(link('OrderComponent#cancel', CANCEL)).toMatchObject({
      confidence: 'CONFIRMED',
      context: 'OrderAction.Cancel',
    });
    expect(from(CANCEL).map((l) => l.to)).toEqual(['OrderApi#cancel']);
    expect(endpointsOf('cancel')).toEqual(['POST /api/orders/{id}/cancel']);
    const clone = facts.find((f) => f.sourceId === 'front')?.ui?.symbols?.find((s) => s.id === CANCEL);
    expect(clone).toMatchObject({
      of: 'OrderStore#dispatch',
      context: 'OrderAction.Cancel',
      branches: { kept: 1, pruned: 4, unknown: 0 },
    });
  });

  it('an action carried in an object ({ type: … }) selects the branch through its field', () => {
    const reduce = 'OrderStore#reduce⟨type=OrderAction.Cancel⟩';
    expect(link('OrderComponent#close', reduce)?.confidence).toBe('CONFIRMED');
    expect(from(reduce).map((l) => l.to)).toEqual(['OrderApi#cancel']);
    expect(endpointsOf('close')).toEqual(['POST /api/orders/{id}/cancel']);
  });

  it('F: Submit, then Archive only if the response says so — the nested dispatch is its own context', () => {
    expect(
      from(SUBMIT)
        .map((l) => l.to)
        .sort(),
    ).toEqual(['OrderApi#submit', ARCHIVE]);
    expect(link(SUBMIT, ARCHIVE)).toMatchObject({
      condition: 'r.ok',
      async: 'à chaque réponse de this.api.submit(payload) (subscribe)',
      data: 'r = résultat de this.api.submit(payload)',
    });
    expect(
      from(ARCHIVE)
        .filter((l) => l.kind === 'CALL')
        .map((l) => l.to),
    ).toEqual(['OrderApi#archive']);
    expect(endpointsOf('save')).toEqual([
      'POST /api/orders',
      'POST /api/orders/validate',
      'POST /api/orders/{id}/archive',
    ]);
  });

  it('an unresolved action keeps every branch, as possible only, and says why', () => {
    expect(link('OrderComponent#run', 'OrderStore#dispatch')?.context).toBeUndefined();
    const generic = from('OrderStore#dispatch').filter((l) => l.to.startsWith('OrderApi#'));
    expect(generic.map((l) => l.to).sort()).toEqual([
      'OrderApi#archive',
      'OrderApi#cancel',
      'OrderApi#refresh',
      'OrderApi#submit',
    ]);
    expect(
      generic.every(
        (l) => l.confidence === 'PROBABLE' && l.reason.includes('branche choisie par la valeur de action'),
      ),
    ).toBe(true);
    const diagnostics = facts.find((f) => f.sourceId === 'front')?.ui?.diagnostics ?? [];
    expect(diagnostics.find((d) => d.from === 'OrderComponent#run')).toMatchObject({
      code: 'CONTEXT_UNRESOLVED',
    });
    expect(
      diagnostics.some((d) => d.code === 'CONTEXT_UNRESOLVED' && d.from === 'OrderComponent#cancel'),
    ).toBe(false);
  });
});

describe('control flow, asynchronous continuations and data provenance', () => {
  it('C: an awaited validation, then a dispatch only if it is valid', () => {
    expect(link('OrderComponent#save', SUBMIT)).toMatchObject({
      confidence: 'CONFIRMED',
      condition: 'ok',
      async: 'après await this.validation.validate(this.form)',
    });
  });

  it('A + G: a failed validation stops the journey; its result becomes the payload of the dispatch', () => {
    expect(link('ValidationStore#validateThenSubmit', SUBMIT)).toMatchObject({
      condition: 'valid',
      async: 'à chaque réponse de this.validate(form) (subscribe)',
      data: 'payload ← { form, valid } (valid = résultat de this.validate(form))',
    });
  });

  it('B: a result published in a Subject is consumed by another store, through filter()', () => {
    const l = link('ValidationStore.result$', SUBMIT);
    expect(l).toMatchObject({ kind: 'PIPE', confidence: 'CONFIRMED', condition: 'filter((r) => r.valid)' });
  });

  it('D + E: a coordinating service combines two validations (forkJoin) before the dispatch', () => {
    expect(link('OrderFlow#submitChecked', 'ValidationStore#validate')?.confidence).toBe('CONFIRMED');
    expect(link('OrderFlow#submitChecked', 'OrderApi#check')?.confidence).toBe('CONFIRMED');
    const l = link('OrderFlow#submitChecked', SUBMIT);
    expect(l?.condition).toBe('valid && allowed');
    expect(l?.async).toContain('forkJoin([this.validation.validate(form), this.api.check()])');
  });

  it('H: a search replaced by every new query (switchMap) and stopped by takeUntil is said so — and never run unsubscribed', () => {
    const l = link('OrderFlow.results$', 'OrderApi#search');
    expect(l?.confidence).toBe('UNKNOWN');
    expect(l?.async).toContain('une nouvelle émission annule le traitement en cours');
    expect(l?.async).toContain('takeUntil');
  });

  it('negatives: a lost Observable runs nothing; a conditional call is never shown as certain to run', () => {
    expect(link('OrderComponent#preview', 'OrderApi#submit')?.confidence).toBe('UNKNOWN');
    const diagnostics = facts.find((f) => f.sourceId === 'front')?.ui?.diagnostics ?? [];
    expect(
      diagnostics.some((d) => d.from === 'OrderComponent#preview' && d.code === 'OBSERVABLE_NOT_SUBSCRIBED'),
    ).toBe(true);
    // Une condition présente dans le code est toujours portée par le lien.
    expect(link('OrderComponent#save', SUBMIT)?.condition).toBeDefined();
  });
});

describe('graph, features and impact', () => {
  it('graph edges carry the execution context; a context node is named by its arguments', () => {
    const edge = model.edges.find(
      (e: MapEdge) => e.from === 'METHOD:front:OrderComponent#save' && e.to === `METHOD:front:${SUBMIT}`,
    );
    expect(edge?.detail).toMatchObject({ condition: 'ok', context: 'OrderAction.Submit' });
    const node = model.nodes.find((n) => n.id === `METHOD:front:${SUBMIT}`);
    expect(node?.name).toBe('OrderStore.dispatch(OrderAction.Submit)');
    expect(node?.detail).toMatchObject({
      of: 'METHOD:front:OrderStore#dispatch',
      branchesKept: 2,
      branchesPruned: 3,
    });
    const chain = model.features.find((f) => f.name === 'Order')?.chain.map((s) => s.label) ?? [];
    expect(chain).toContain('Store OrderStore.dispatch(OrderAction.Submit)');
  });

  it('the analyser version changed: older facts are read again', () => {
    expect(Number(/^rxjs-(\d+)$/.exec(RXJS_ANALYZER)?.[1])).toBeGreaterThanOrEqual(2);
    expect(ANALYZERS).toContain(RXJS_ANALYZER);
  });
});

describe('impact follows the reconstructed paths', () => {
  let copy: string;
  afterAll(async () => {
    await rm(copy, { recursive: true, force: true });
  });

  it('a changed cancel endpoint touches Cancel and Close for sure, Run as possible, never Save', async () => {
    copy = await mkdtemp(path.join(tmpdir(), 'carto-flow-'));
    await cp(FIXTURE, copy, { recursive: true });
    const before = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const api = path.join(copy, 'front/src/app/order/order-api.service.ts');
    await writeFile(api, (await readFile(api, 'utf8')).replace('}/cancel`', '}/cancellation`'));
    const after = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const report = computeImpact(before.model, after.model, []);
    expect(report.changes.find((c) => c.node === 'METHOD:front:OrderApi#cancel')?.change).toBe('CHANGED');
    const touched = (report.actions ?? []).filter((a) => a.element === 'METHOD:front:OrderApi#cancel');
    if (!touched.length) throw new Error(JSON.stringify(report.actions?.map((a) => [a.name, a.element])));
    const byName = new Map(touched.map((a) => [a.name, a]));
    expect(byName.get('Annuler')?.confidence).toBe('CONFIRMED');
    expect(byName.get('Annuler')?.path.at(-1)).toBe(touched[0]?.elementName);
    expect(byName.get('Fermer')?.confidence).toBe('CONFIRMED');
    expect(byName.get('Exécuter')?.confidence).toBe('PROBABLE');
    expect(byName.has('Enregistrer')).toBe(false);
  });
});

describe('the analyser on its own', () => {
  const read = (p: string, text: string) => ({ path: p, text, hash: '', bytes: text.length });
  const analyze = async (text: string) => {
    const ts = await loadTypeScript();
    if (!ts) throw new Error('typescript is required by the cartography');
    return analyzeRxjs(ts, [read('flow.ts', text)], new Map());
  };
  const API = `@Injectable() export class Api {
  constructor(private http: HttpClient) {}
  a() { return this.http.get('/a'); }
  b() { return this.http.get('/b'); }
}`;

  it('a string constant, an enum value written as its literal, and instanceof select the same branches', async () => {
    const rx = await analyze(`${API}
export const GO = 'go';
export enum Kind { Go = 'go', Stop = 'stop' }
export class GoEvent {}
export class StopEvent {}
@Injectable() export class Store {
  constructor(private api: Api) {}
  on(kind: string) { if (kind === Kind.Go) { this.api.a().subscribe(); } else { this.api.b().subscribe(); } }
  handle(e: GoEvent | StopEvent) { if (e instanceof StopEvent) this.api.b().subscribe(); else this.api.a().subscribe(); }
}
@Component({ selector: 'x', template: '<button (click)="go()">Go</button>' })
export class Cmp {
  constructor(private store: Store) {}
  go() { this.store.on(GO); this.store.on('stop'); this.store.handle(new StopEvent()); }
}`);
    const out = (id: string) => rx.links.filter((l) => l.from === id).map((l) => l.to);
    expect(out("Store#on⟨'go'⟩")).toEqual(['Api#a']);
    expect(out("Store#on⟨'stop'⟩")).toEqual(['Api#b']);
    // Dans la méthode générique, chaque branche n'est que possible.
    expect(rx.links.filter((l) => l.from === 'Store#on').every((l) => l.confidence === 'PROBABLE')).toBe(
      true,
    );
    expect(out('Store#handle⟨new StopEvent()⟩')).toEqual(['Api#b']);
  });

  it('mutual dispatches end (one context per value), and a long forwarding chain stops at the depth limit', async () => {
    const rx = await analyze(`${API}
@Injectable() export class Loop {
  constructor(private api: Api) {}
  ping(n: number) { switch (n) { case 1: this.ping(2); break; case 2: this.ping(1); this.api.a().subscribe(); break; } }
}
@Injectable() export class Chain {
  constructor(private api: Api) {}
  s1(x: string) { if (x === 'k') this.s2(x); }
  s2(x: string) { if (x === 'k') this.s3(x); }
  s3(x: string) { if (x === 'k') this.s4(x); }
  s4(x: string) { if (x === 'k') this.s5(x); }
  s5(x: string) { if (x === 'k') this.s6(x); }
  s6(x: string) { if (x === 'k') this.api.b().subscribe(); }
}
@Component({ selector: 'x', template: '<button (click)="go()">Go</button>' })
export class Cmp {
  constructor(private loop: Loop, private chain: Chain) {}
  go() { this.loop.ping(1); this.chain.s1('k'); }
}`);
    expect(rx.links.some((l) => l.from === 'Loop#ping⟨1⟩' && l.to === 'Loop#ping⟨2⟩')).toBe(true);
    expect(rx.links.some((l) => l.from === 'Loop#ping⟨2⟩' && l.to === 'Loop#ping⟨1⟩')).toBe(true);
    expect(rx.symbols.filter((s) => s.of === 'Loop#ping').length).toBe(2);
    expect(
      rx.diagnostics.some((d) => d.code === 'LIMIT' && d.message.includes('limite d’analyse contextuelle')),
    ).toBe(true);
    // Au-delà de la limite, l'appel retombe sur la méthode générique : la branche reste possible, jamais perdue.
    expect(rx.links.some((l) => l.to === 'Chain#s5' || l.to === 'Chain#s6')).toBe(true);
  });

  it('two values with the same name are not the same data: no provenance is guessed across methods', async () => {
    const rx = await analyze(`${API}
@Injectable() export class S {
  constructor(private api: Api) {}
  first(payload: string) { this.api.a().subscribe(); }
  second() { const payload = 'x'; this.first(payload); }
}`);
    expect(rx.links.find((l) => l.from === 'S#second' && l.to === 'S#first')?.data).toBeUndefined();
  });
});
