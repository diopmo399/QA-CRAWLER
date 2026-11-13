import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIndex, traceOf, type MapIndex } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';
import type { CartographyConfig, CartographyModel, MapEdge } from '../../src/sdk/core/cartography.js';

/**
 * LE MOTEUR DE RECONSTRUCTION DES FLUX, sur de petits exemples (tests/fixtures/flow-engine) : un dossier par
 * construction. Rien n'est exécuté : le code des exemples est seulement lu. Chaque cas dit ce qu'un point
 * d'entrée doit atteindre ET ce qu'il ne doit jamais atteindre (faux liens).
 */
const FIXTURE = path.resolve('tests/fixtures/flow-engine');
const configFor = (root: string): CartographyConfig => ({
  schema: 1,
  sources: [
    {
      id: 'front',
      name: 'front',
      layer: 'FRONTEND',
      path: path.join(root, 'front'),
      include: [],
      enabled: true,
    },
  ],
});
const scan = (root: string) => runScan({ config: configFor(root), allowedRoots: [root], incremental: false });

let model: CartographyModel;
let index: MapIndex;
let scanMs = 0;

const short = (id: string): string => id.split(':').slice(2).join(':');
const methodId = (name: string): string =>
  model.nodes.find((n) => n.kind === 'METHOD' && short(n.id) === name)?.id ?? '';
const down = (entry: string, of: MapIndex = index): string[] => {
  const id = of.model.nodes.find((n) => n.kind === 'METHOD' && short(n.id) === entry)?.id;
  expect(id, entry).toBeDefined();
  const trace = traceOf(of, id ?? '', { direction: 'DOWN' });
  expect(trace?.truncated ?? false).toBe(false);
  return (trace?.nodes ?? []).map((n) => short(n.id));
};
const edgesFrom = (from: string): MapEdge[] => model.edges.filter((e) => short(e.from) === from);
const edge = (from: string, to: string): MapEdge | undefined =>
  model.edges.find((e) => short(e.from) === from && short(e.to) === to);
const diagnostics = (owner: string): string[] => {
  const node = model.nodes.find((n) => short(n.id) === owner);
  const list = node?.detail.diagnostics;
  return Array.isArray(list) ? list.map(String) : [];
};

beforeAll(async () => {
  const started = performance.now();
  ({ model } = await scan(FIXTURE));
  scanMs = performance.now() - started;
  index = buildIndex(model);
});

describe('1 — store alias', () => {
  it('`const currentStore = this.store; currentStore.dispatch(…)` finds the store and the right branch', () => {
    const path1 = down('AliasComponent#save');
    expect(path1).toContain("AliasStore#dispatch⟨type='SAVE'⟩");
    expect(path1).toContain('AliasApi#save');
    expect(path1).not.toContain('AliasApi#list');
    expect(path1).not.toContain('AliasApi#remove');
  });
});

describe('2 — indirect dispatch', () => {
  it.each(['viaCallback', 'viaBind', 'viaHelper', 'viaReference'])(
    '%s reaches the SAVE branch only',
    (name) => {
      const reached = down(`IndirectComponent#${name}`);
      expect(reached).toContain('IndirectApi#save');
      expect(reached).not.toContain('IndirectApi#list');
      expect(reached).not.toContain('IndirectApi#remove');
    },
  );

  it('a helper function that receives the store: the call is the method’s, the helper is named', () => {
    const link = edgesFrom('IndirectComponent#viaHelper').find((e) => /dispatch/.test(e.to));
    expect(link?.confidence).toBe('CONFIRMED');
    expect(link?.reason).toContain('par la fonction emitOn()');
  });

  it('a method reference: confirmed when the receiver calls its parameter, only probable when it stores it', () => {
    const called = edge('IndirectComponent#viaReference', 'IndirectComponent#doSave');
    expect(called?.confidence).toBe('CONFIRMED');
    expect(called?.reason).toContain('référence passée à runNow(), qui l’appelle');
    const stored = edge('IndirectComponent#viaStored', 'IndirectComponent#doSave');
    expect(stored?.confidence).toBe('PROBABLE');
    expect(stored?.reason).toContain('exécutée seulement si keep() l’appelle');
  });

  it('negative: a value passed as an argument is not a call, and raises no false diagnostic', () => {
    expect(edgesFrom('IndirectComponent#viaValue').map((e) => short(e.to))).toEqual([
      'IndirectComponent#note',
    ]);
    // Le seul diagnostic est la fin de chaîne de note() ; rien sur une « méthode title introuvable ».
    expect(diagnostics('IndirectComponent#viaValue').join(' ')).not.toMatch(/title|introuvable/);
    expect(model.nodes.some((node) => short(node.id) === 'IndirectComponent#title')).toBe(false);
  });
});

describe('3 — a subscription installed in ngOnInit', () => {
  it('installation, emission, callback, condition and dispatch are five distinct relations', () => {
    // Installation : ngOnInit s'abonne, une fois.
    const install = edge('InitComponent#ngOnInit', 'InitStore.validation$');
    expect(install?.kind).toBe('READS');
    expect(install?.reason).toContain('installe un abonnement');
    expect(install?.detail?.async ?? '').toContain('installation');
    // Émission : seul VALIDATE pousse une valeur.
    expect(edge("InitStore#dispatch⟨type='VALIDATE'⟩", 'InitStore.validation')?.reason).toContain('émet');
    // Exécution du rappel, sous sa condition.
    const callback = edge('InitStore.validation$', 'InitComponent#submit');
    expect(callback?.reason).toContain('à chaque émission');
    expect(callback?.detail?.condition).toBe('result.valid');
    // Dispatch déclenché par submit.
    expect(edge('InitComponent#submit', "InitStore#dispatch⟨type='SAVE'⟩")).toBeDefined();
    // ngOnInit n'appelle pas submit directement : l'installation ne prouve aucune émission.
    expect(edge('InitComponent#ngOnInit', 'InitComponent#submit')).toBeUndefined();
  });

  it('the journey goes from the action that emits to the call, through the callback', () => {
    const reached = down('InitComponent#validate');
    for (const step of [
      'InitStore.validation',
      'InitStore.validation$',
      'InitComponent#submit',
      'InitApi#save',
    ])
      expect(reached).toContain(step);
    expect(reached).not.toContain('InitApi#list');
  });
});

describe('4 — dispatch after a validation', () => {
  it('several dispatches in one method keep their own condition and their asynchronous step', () => {
    const save = edgesFrom('CheckedComponent#send').find((e) => /SAVE/.test(e.to));
    const reject = edgesFrom('CheckedComponent#send').find((e) => /REJECT/.test(e.to));
    expect(save?.detail?.condition).toContain('ok');
    expect(reject?.detail?.condition).toContain('non (ok)');
    for (const e of [save, reject]) expect(e?.detail?.async ?? '').toContain('subscribe');
    const reached = down('CheckedComponent#send');
    expect(reached).toContain('CheckedApi#save');
    expect(reached).toContain('CheckedApi#remove');
    expect(reached).not.toContain('CheckedApi#list');
  });
});

describe('5 — filter after map, and an effect that triggers another', () => {
  it('a map that copies the action keeps its type: the filter that follows still selects', () => {
    const reached = down('MappedComponent#save');
    expect(reached).toContain("MappedStore.actions⟨type='SAVE'⟩");
    expect(reached).toContain('MappedApi#save');
    expect(reached).not.toContain('MappedApi#list');
    expect(reached).not.toContain('MappedApi#remove');
  });

  it('an emission made inside a pipe is an emission: LOAD loads, then REJECT removes', () => {
    expect(edge('MappedStore.loaded$', "MappedStore.actions⟨type='REJECT'⟩")?.reason).toContain('émet sur');
    const reached = down('MappedComponent#reload');
    expect(reached).toContain('MappedApi#list');
    expect(reached).toContain('MappedApi#remove');
    expect(reached).not.toContain('MappedApi#save');
  });

  it('negative: an action that no pipe accepts reaches no call', () => {
    const reached = down('MappedComponent#validate');
    expect(reached.filter((id) => id.startsWith('MappedApi#'))).toEqual([]);
  });
});

describe('6 — the predicate lives in a function, a method or a home-made operator', () => {
  it.each([
    ['save', 'save', ['list', 'remove']],
    ['reload', 'list', ['save', 'remove']],
    ['reject', 'remove', ['save', 'list']],
  ] as const)('%s reaches %s only', (entry, expected, never) => {
    const reached = down(`NamedComponent#${entry}`);
    expect(reached).toContain(`NamedApi#${expected}`);
    for (const other of never) expect(reached).not.toContain(`NamedApi#${other}`);
  });
});

describe('7 — several candidate effects', () => {
  it('an unknown action keeps every effect as a candidate, and says why', () => {
    const reached = down('ManyComponent#forward');
    expect(reached).toContain('ManyApi#save');
    expect(reached).toContain('ManyApi#list');
    expect(diagnostics('ManyComponent#forward').join(' ')).toContain('toutes ses branches restent possibles');
  });

  it('the same method called with a known action reaches one effect', () => {
    const reached = down('ManyComponent#save');
    expect(reached).toContain('ManyApi#save');
    expect(reached).not.toContain('ManyApi#list');
  });
});

describe('8 — conditional HTTP calls', () => {
  it('each caller reaches the HTTP call of its own branch, through a literal or a local constant', () => {
    const post = model.nodes.find(
      (n) => short(n.id).startsWith('ModeService#send@') && /POST/.test(JSON.stringify(n)),
    );
    const put = model.nodes.find(
      (n) => short(n.id).startsWith('ModeService#send@') && /PUT/.test(JSON.stringify(n)),
    );
    expect(post).toBeDefined();
    expect(put).toBeDefined();
    const create = down('ModeComponent#create');
    expect(create).toContain(short(post?.id ?? ''));
    expect(create).not.toContain(short(put?.id ?? ''));
    const update = down('ModeComponent#update');
    expect(update).toContain(short(put?.id ?? ''));
    expect(update).not.toContain(short(post?.id ?? ''));
  });
});

describe('9 — the shape of the value through the operators', () => {
  it('a map that rewrites the type decides the filter once and for all (here: never)', () => {
    for (const entry of ['save', 'reload'])
      expect(down(`ShapeComponent#${entry}`)).not.toContain('ShapeApi#list');
  });

  it('a map that loses the object leaves the type unknown: every emission stays a candidate', () => {
    for (const entry of ['save', 'reload'])
      expect(down(`ShapeComponent#${entry}`)).toContain('ShapeApi#remove');
  });

  it('after withLatestFrom the first element of the tuple is the emitted action', () => {
    expect(down('ShapeComponent#save')).toContain('ShapeApi#save');
    expect(down('ShapeComponent#reload')).not.toContain('ShapeApi#save');
  });
});

describe('10 — incomplete path and unknown value', () => {
  it('an unknown action is UNKNOWN, never invented: every branch stays, probable, with the reason', () => {
    const reached = down('LooseComponent#replay');
    for (const call of ['LooseApi#save', 'LooseApi#list', 'LooseApi#remove']) expect(reached).toContain(call);
    for (const e of edgesFrom('LooseStore#dispatch').filter((x) => /LooseApi#/.test(x.to)))
      expect(e.confidence).toBe('PROBABLE');
    expect(diagnostics('LooseComponent#replay').join(' ')).toContain('JSON.parse()');
  });

  it('a service that is not in the sources: no link is invented, the break is kept with its cause', () => {
    expect(edgesFrom('LooseComponent#push')).toEqual([]);
    expect(diagnostics('LooseComponent#push').join(' ')).toContain(
      'RemoteGateway n’est pas dans les sources',
    );
  });
});

describe('11 — cycles', () => {
  it('effects that restart each other form a finite loop; nothing else is reached', () => {
    expect(edge('LoopStore.ping$', "LoopStore.beats⟨type='PONG'⟩")).toBeDefined();
    expect(edge('LoopStore.pong$', "LoopStore.beats⟨type='PING'⟩")).toBeDefined();
    const reached = down('LoopComponent#start');
    expect(reached).toContain('LoopStore.ping$');
    expect(reached).toContain('LoopStore.pong$');
    expect(reached).not.toContain('LoopApi#save');
  });

  it('methods that call each other are followed once', () => {
    const reached = down('LoopComponent#recurse');
    for (const step of ['LoopStore#first', 'LoopStore#second', 'LoopApi#save'])
      expect(reached).toContain(step);
    expect(new Set(reached).size).toBe(reached.length);
  });
});

describe('13 — inheritance and polymorphism', () => {
  it('an inherited method is followed for the concrete class of the receiver', () => {
    const reached = down('PolyComponent#saveDraft');
    expect(reached).toContain("BaseStore#dispatch⟨DraftStore, type='SAVE'⟩");
    expect(reached).toContain('DraftStore#persist');
    // La dépendance `api` est injectée dans la classe de base : l'appel de la sous-classe est lu.
    expect(reached).toContain('PolyApi#save');
    expect(reached).not.toContain('PolyApi#remove');
    expect(reached).not.toContain('PolyApi#list');
  });

  it('an abstract receiver keeps every implementation as a candidate; none is chosen', () => {
    const candidates = edgesFrom("BaseStore#dispatch⟨type='SAVE'⟩").filter((e) => /#persist$/.test(e.to));
    expect(candidates.map((e) => short(e.to)).sort()).toEqual(['DraftStore#persist', 'TrashStore#persist']);
    for (const e of candidates) {
      expect(e.confidence).toBe('PROBABLE');
      expect(e.reason).toContain('une de ses 2 implémentations lues, aucune n’est choisie');
    }
    const reached = down('PolyComponent#saveAny');
    expect(reached).toContain('PolyApi#save');
    expect(reached).toContain('PolyApi#remove');
    expect(reached).not.toContain('PolyApi#list');
  });
});

describe('14 — imports through path aliases and barrel files', () => {
  it('a homonymous class imported through a tsconfig alias is the one the alias designates', () => {
    const reached = down('AdminPanelComponent#open');
    expect(reached).toContain('PanelStore(admin)#load');
    expect(reached).toContain('AdminPanelApi#list');
    expect(reached).not.toContain('PanelStore(catalog)#load');
    expect(reached).not.toContain('CatalogPanelApi#list');
  });

  it('a class renamed by a barrel (`export { A as B } from`) is followed to the file that declares it', () => {
    const reached = down('CatalogPanelComponent#open');
    expect(reached).toContain('PanelStore(catalog)#load');
    expect(reached).toContain('CatalogPanelApi#list');
    expect(reached).not.toContain('AdminPanelApi#list');
  });

  it('two constants of the same name: each call reads the one its import designates (alias, barrel)', () => {
    const pathOf = (name: string): unknown => model.nodes.find((n) => short(n.id) === name)?.detail.path;
    expect(pathOf('AdminPanelApi#list')).toBe('/api/c14/admin');
    expect(pathOf('CatalogPanelApi#list')).toBe('/api/c14/catalog');
  });

  it('negative: an alias that no tsconfig declares chooses neither class, and says so', () => {
    expect(edgesFrom('GhostPanelComponent#open')).toEqual([]);
    expect(diagnostics('GhostPanelComponent#open').join(' ')).toContain(
      'plusieurs classes s’appellent PanelStore',
    );
  });
});

describe('15 — negative and combined gates, values bounded by their written type', () => {
  it('`!==` lets everything pass but the excluded type', () => {
    expect(down('GateComponent#save')).toContain('GateApi#audit');
    expect(down('GateComponent#load')).not.toContain('GateApi#audit');
  });

  it('a conjunction restricts by the term it can read; the negation of a list excludes its members', () => {
    const save = down('GateComponent#save');
    expect(save).toContain('GateStore.urgentSave$');
    expect(save).not.toContain('GateStore.others$');
    const load = down('GateComponent#load');
    expect(load).toContain('GateStore.others$');
    expect(load).not.toContain('GateStore.urgentSave$');
    expect(load).not.toContain('GateApi#save');
  });

  it('an unknown value of a literal union follows each admitted value, as a possibility only', () => {
    const reached = down('GateComponent#forward');
    expect(reached).toContain("GateStore#dispatch⟨type='SAVE'⟩");
    expect(reached).toContain("GateStore#dispatch⟨type='REJECT'⟩");
    expect(reached).toContain('GateApi#audit');
    // LOAD n'est pas admis par le type : le traitement des « autres » n'est jamais atteint.
    expect(reached).not.toContain('GateStore.others$');
    expect(reached).not.toContain('GateApi#list');
    const link = edge('GateComponent#forward', "GateStore#dispatch⟨type='SAVE'⟩");
    expect(link?.confidence).toBe('PROBABLE');
    expect(link?.reason).toContain('le type écrit de action.type n’admet que 2 valeurs');
  });

  it('two members of an enum: the third branch is never followed', () => {
    const reached = down('GateComponent#apply');
    expect(reached).toContain('GateApi#save');
    expect(reached).toContain('GateApi#list');
    expect(reached).not.toContain('GateApi#remove');
  });

  it('a type that fixes the field gives one value, still only probable (a type is not a literal)', () => {
    const link = edge('GateComponent#resend', "GateStore#dispatch⟨type='SAVE'⟩");
    expect(link?.confidence).toBe('PROBABLE');
    expect(link?.reason).toContain('valeur déduite du type écrit');
    expect(down('GateComponent#resend')).not.toContain('GateApi#list');
  });

  it('negative: a type that admits anything excludes nothing, and the break is said', () => {
    const reached = down('GateComponent#replay');
    for (const api of ['GateApi#audit', 'GateApi#save', 'GateApi#list']) expect(reached).toContain(api);
    expect(diagnostics('GateComponent#replay').join(' ')).toContain('n’est pas déterminable statiquement');
  });
});

describe('16 — NgRx: actions, effects, reducers, selectors', () => {
  it('a dispatched action reaches the effect that accepts its creator, and only that one', () => {
    const reached = down('OrderPageComponent#refresh');
    expect(reached).toContain("Store#dispatch⟨type='[Orders] Load'⟩");
    expect(reached).toContain('OrderEffects.load$');
    expect(reached).toContain('OrderApi#list');
    expect(reached).not.toContain('OrderEffects.save$');
    expect(reached).not.toContain('OrderApi#save');
    expect(reached).not.toContain('OrderApi#remove');
  });

  it('the action an effect returns goes back to the store: an effect starts another, then the reducer', () => {
    const reached = down('OrderPageComponent#save');
    expect(reached).toContain('OrderEffects.save$');
    expect(reached).toContain('OrderApi#save');
    // save$ rend loadOrders() : load$ repart, puis son action de succès atteint le réducteur.
    expect(reached).toContain("Store.actions⟨type='[Orders] Load'⟩");
    expect(reached).toContain('OrderEffects.load$');
    expect(reached).toContain("Store.actions⟨type='[Orders] Load Success'⟩");
    expect(reached).toContain('ordersReducer.state');
    expect(reached).not.toContain('OrderApi#remove');
  });

  it('a member of an action group is matched by its generated name; `dispatch: false` returns nothing', () => {
    const reached = down('OrderPageComponent#remove');
    expect(reached).toContain("Store#dispatch⟨type='[Order Page] Remove Order'⟩");
    expect(reached).toContain('OrderEffects.remove$');
    expect(reached).toContain('OrderEffects.audit$');
    expect(reached).toContain('OrderApi#audit');
    // Aucune action ne repart de audit$ (aucun canal du store atteint depuis lui).
    expect(edgesFrom('OrderEffects.audit$').some((e) => /Store\.actions⟨/.test(e.to))).toBe(false);
    expect(edgesFrom('OrderEffects.remove$').some((e) => /Store\.actions⟨/.test(e.to))).toBe(true);
  });

  it('a reducer only receives the types of its `on`', () => {
    const into = model.edges.filter((e) => short(e.to) === 'ordersReducer.state').map((e) => short(e.from));
    expect(into).toContain("Store.actions⟨type='[Orders] Save'⟩");
    expect(into).toContain("Store.actions⟨type='[Orders] Load Success'⟩");
    expect(into).not.toContain("Store.actions⟨type='[Orders] Load'⟩");
    expect(into).not.toContain("Store.actions⟨type='[Order Page] Opened'⟩");
  });

  it('a selector reads the state of the reducer registered under its feature key', () => {
    expect(edge('OrderPageComponent.items$', 'ordersReducer.state')?.confidence).toBe('CONFIRMED');
    expect(edge('OrderPageComponent.busy', 'ordersReducer.state')).toBeDefined();
    // Du bouton à l'écran : l'action enregistrée finit par mettre à jour ce que le composant affiche.
    expect(down('OrderPageComponent#save')).toContain('OrderPageComponent.items$');
  });

  it('negative: an action nobody handles reaches nothing; a selector of an unregistered key reads no reducer', () => {
    const reached = down('OrderPageComponent#open');
    expect(reached.filter((n) => /Effects|Api|Reducer/.test(n))).toEqual([]);
    expect(diagnostics('OrderPageComponent#open').join(' ')).toContain('ni souscrit ni traité');
    expect(edge('OrderPageComponent.ghost$', 'ordersReducer.state')).toBeUndefined();
  });
});

describe('17 — NgRx component store', () => {
  it('calling an effect runs its pipeline: the store subscribes it, nothing is left to the caller', () => {
    const reached = down('TodoComponent#ngOnInit');
    expect(reached).toContain('TodoStore#load');
    expect(reached).toContain('TodoApi#list');
    expect(reached).toContain('TodoStore#setItems');
    expect(reached).not.toContain('TodoApi#remove');
    expect(edge('TodoComponent#ngOnInit', 'TodoStore#load')?.confidence).toBe('CONFIRMED');
    expect(edge('TodoStore#load', 'TodoApi#list')?.confidence).toBe('CONFIRMED');
    expect(diagnostics('TodoComponent#ngOnInit')).toEqual([]);
  });

  it('each effect keeps its own call', () => {
    const reached = down('TodoComponent#remove');
    expect(reached).toContain('TodoApi#remove');
    expect(reached).not.toContain('TodoApi#list');
  });
});

describe('0 — the measure of a scan', () => {
  it('counts the links by confidence and the breaks by cause, without any code', () => {
    const resolution = model.scan.resolution;
    expect(resolution).toBeDefined();
    const links = resolution?.links ?? { CONFIRMED: 0, PROBABLE: 0, UNKNOWN: 0 };
    expect(links.CONFIRMED + links.PROBABLE + links.UNKNOWN).toBe(model.edges.length);
    expect(links.PROBABLE).toBeGreaterThan(0);
    expect(resolution?.diagnostics.CLASS_AMBIGUOUS).toBe(1);
    expect(resolution?.diagnostics.SERVICE_NOT_FOUND).toBe(1);
    expect(resolution?.confirmedRate).toBeCloseTo(links.CONFIRMED / model.edges.length, 3);
    expect(JSON.stringify(resolution)).not.toMatch(/Component|Store|\.ts/);
  });
});

describe('12 — cache and invalidation', () => {
  let work: string;
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('unchanged sources are reused with the same graph; a changed file is read again and the journey follows', async () => {
    work = await mkdtemp(path.join(tmpdir(), 'flow-engine-'));
    await cp(FIXTURE, work, { recursive: true });
    const first = await scan(work);
    const signature = (m: CartographyModel): string =>
      m.edges
        .map((e) => `${e.id}|${e.confidence}`)
        .sort()
        .join('\n');
    const again = await runScan({
      config: configFor(work),
      allowedRoots: [work],
      incremental: true,
      previous: { facts: first.facts, sources: first.model.scan.sources },
    });
    expect(again.model.scan.sources.map((s) => s.state)).toEqual(['REUSED']);
    expect(signature(again.model)).toBe(signature(first.model));

    const file = path.join(work, 'front/src/app/c01/c01.component.ts');
    await writeFile(file, (await readFile(file, 'utf8')).replace("{ type: 'SAVE' }", "{ type: 'LOAD' }"));
    const changed = await runScan({
      config: configFor(work),
      allowedRoots: [work],
      incremental: true,
      previous: { facts: again.facts, sources: again.model.scan.sources },
    });
    expect(changed.model.scan.sources.map((s) => s.state)).toEqual(['SCANNED']);
    const reached = down('AliasComponent#save', buildIndex(changed.model));
    expect(reached).toContain('AliasApi#list');
    expect(reached).not.toContain('AliasApi#save');
  });
});

describe('determinism and bounds', () => {
  it('two scans give the same graph', async () => {
    const other = (await scan(FIXTURE)).model;
    expect(other.edges.map((e) => e.id).sort()).toEqual(model.edges.map((e) => e.id).sort());
  });

  it('no relation is lost, no analysis limit is reached, and the small fixture scans fast', () => {
    expect(model.unresolved ?? []).toEqual([]);
    expect(model.scan.sources.map((s) => s.state)).toEqual(['SCANNED']);
    expect(scanMs).toBeLessThan(15_000);
    expect(methodId('AliasComponent#save')).not.toBe('');
  });
});
