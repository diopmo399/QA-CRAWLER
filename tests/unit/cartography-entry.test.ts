import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel, MapEdge } from '../../src/sdk/core/cartography.js';
import { analyzeRxjs } from '../../src/cartography/analyze-rxjs.js';
import { parseTemplate } from '../../src/cartography/analyze-template.js';
import { buildIndex, featureDetail, type CoverageContext } from '../../src/cartography/explorer.js';
import type { SourceFacts, UiLink } from '../../src/cartography/facts.js';
import { ANALYZERS, runScan } from '../../src/cartography/scan.js';
import { loadTypeScript } from '../../src/static-analysis/typescript-loader.js';

/**
 * DES ÉLÉMENTS DE L'INTERFACE JUSQU'AUX API : alias locaux (simples, en chaîne, réaffectés, méthode détachée,
 * retour de méthode, paramètre typé), actions fabriquées par des fonctions (simple, générique, imbriquée,
 * à plusieurs retours), méthode générique à plusieurs appels HTTP, validation RxJS suivie de dispatch
 * (filter + switchMap, plusieurs dispatch, chaîne jamais souscrite), et points d'entrée du gabarit (boutons,
 * lien, input submit, sortie d'un composant enfant, onglet généré, composant partagé, gestionnaire dynamique).
 * Le critère : deux boutons qui appellent la même méthode générique atteignent chacun leur seul endpoint.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-entry');
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
const front = () => facts.find((f) => f.sourceId === 'front')?.ui;
const links = (): UiLink[] => front()?.links ?? [];
const from = (id: string): UiLink[] => links().filter((l) => l.from === id);
/** Le lien vers une version contextuelle d'une méthode (`ReqApi#execute⟨…⟩`) dont le contexte cite `value`. */
const toContext = (source: string, method: string, value: string): UiLink | undefined =>
  from(source).find((l) => l.to.startsWith(`${method}⟨`) && (l.context ?? '').includes(value));
const diagnostics = () => front()?.diagnostics ?? [];
const B = (slug: string) => `BUTTON:front:ReqComponent#button:${slug}`;
/** Les endpoints du BFF atteints depuis un nœud (déclenchement et appels, liens non UNKNOWN). */
const endpointsFrom = (start: string): string[] => {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift() ?? '';
    for (const e of model.edges)
      if (
        e.from === cur &&
        (e.kind === 'CALLS' || e.kind === 'TRIGGERS') &&
        e.confidence !== 'UNKNOWN' &&
        !seen.has(e.to)
      ) {
        seen.add(e.to);
        queue.push(e.to);
      }
  }
  return [...seen]
    .filter((id) => id.startsWith('API:bff:'))
    .map((id) => id.slice('API:bff:'.length))
    .sort();
};
const edge = (kind: MapEdge['kind'], a: string, b: string) =>
  model.edges.find((e) => e.kind === kind && e.from === a && e.to === b);

beforeAll(async () => {
  ({ model, facts } = await runScan({
    config: configFor(FIXTURE),
    allowedRoots: [FIXTURE],
    incremental: false,
  }));
});

describe('local aliases', () => {
  it('1 — a simple alias (const s = this.api) is followed', () => {
    const l = toContext('ReqStore#aliasSimple', 'ReqApi#execute', 'VALIDER');
    expect(l?.confidence).toBe('CONFIRMED');
    expect(l?.reason).toContain('par l’alias s');
  });

  it('2 — an alias of an alias is followed to the same object', () => {
    expect(toContext('ReqStore#aliasChain', 'ReqApi#execute', 'ENREGISTRER')?.reason).toContain(
      'par l’alias b',
    );
  });

  it('3 — a reassigned alias keeps both targets as possible, with a diagnostic', () => {
    const out = from('ReqStore#aliasReassigned');
    expect(out.map((l) => l.to).sort()).toEqual(['AuditApi#ping', 'ReqApi#ping']);
    expect(out.every((l) => l.confidence === 'PROBABLE' && l.reason.includes('2 cibles possibles'))).toBe(
      true,
    );
    expect(
      diagnostics().some((d) => d.code === 'ALIAS_AMBIGUOUS' && d.at === 'ReqStore#aliasReassigned'),
    ).toBe(true);
  });

  it('4 — a method detached from its object (const { execute } = this.api) is never shown as certain', () => {
    const l = toContext('ReqStore#detached', 'ReqApi#execute', 'VALIDER');
    expect(l?.confidence).toBe('PROBABLE');
    expect(l?.reason).toContain('this n’est pas garanti');
  });

  it('a method result (this.getApi()) and a typed parameter (api: ReqApi) are resolved', () => {
    expect(from('ReqStore#viaGetter').map((l) => l.to)).toContain('ReqApi#ping');
    expect(from('ReqStore#viaParam').map((l) => l.to)).toEqual(['ReqApi#ping']);
  });
});

describe('actions made by functions', () => {
  it('5 — a simple factory (makeValidationAction) gives the action type', () => {
    expect(toContext('ReqStore#aliasSimple', 'ReqApi#execute', 'VALIDER')).toBeDefined();
  });

  it('6 + 7 — a generic factory calling another one (makeSaveAction<T> → createAction) gives ENREGISTRER', () => {
    expect(toContext('ReqComponent#onSaved', 'ReqStore#dispatch', 'ENREGISTRER')?.confidence).toBe(
      'CONFIRMED',
    );
  });

  it('8 — an action built from a dynamic value, or by a factory with two returns, keeps every branch and says why', () => {
    expect(from('ReqStore#dispatch').map((l) => l.to)).toEqual(['ReqApi#execute']);
    const d = diagnostics().find((x) => x.code === 'ACTION_FACTORY_UNRESOLVED');
    expect(d?.message).toContain('pickAction()');
    expect(d?.message).toContain('2 retours possibles');
  });

  it('negative: a parameter that only fills the payload is not a deciding value (no false diagnostic)', () => {
    expect(diagnostics().some((x) => x.from === 'ReqComponent#quick')).toBe(false);
  });
});

describe('generic methods with several HTTP branches', () => {
  it('9 — one call per branch; each context reaches only its own', () => {
    const calls = (front()?.calls ?? [])
      .filter((c) => c.id.startsWith('ReqApi#execute@'))
      .map((c) => `${c.method} ${c.path ?? ''}`);
    expect(calls).toEqual([
      'POST /api/req/validation',
      'POST /api/req/enregistrement',
      'GET /api/req/inconnue',
    ]);
    const validate = from('ReqApi#execute').find((l) => l.to.endsWith('@L13'));
    expect(validate?.confidence).toBe('PROBABLE');
    const ctx = links().filter(
      (l) => l.from.startsWith('ReqApi#execute⟨') && l.to.startsWith('ReqApi#execute@'),
    );
    for (const l of ctx) expect(l.to.endsWith(l.from.includes('VALIDER') ? '@L13' : '@L16')).toBe(true);
  });

  it('10 — in the generic method, branches stay possible with their condition', () => {
    const generic = from('ReqApi#execute');
    expect(generic.every((l) => l.confidence === 'PROBABLE')).toBe(true);
    expect(generic.find((l) => l.to.endsWith('@L18'))?.condition).toBe(
      'non (action.type === ENREGISTRER) et non (action.type === VALIDER)',
    );
  });

  it('acceptance — two buttons calling the same generic method reach their own endpoint only', () => {
    expect(endpointsFrom(B('lancer-la-validation'))).toEqual(['POST /api/req/validation']);
    expect(endpointsFrom(B('lancer-l-enregistrement'))).toEqual(['POST /api/req/enregistrement']);
  });
});

describe('asynchronous dependencies', () => {
  it('11 + 14 — a dispatch that depends on a valid emission, cancellable by switchMap', () => {
    const l = toContext('ValidationStore#validateThenSave', 'ReqStore#dispatchObs', 'ENREGISTRER');
    expect(l).toMatchObject({ confidence: 'CONFIRMED', timing: 'AFTER_RESULT', cancellable: true });
    expect(l?.condition).toBe('filter((result) => result.valid)');
    expect(l?.async).toContain('une nouvelle émission annule le traitement en cours');
  });

  it('12 — several dispatches after one validation, each in its own context, fed by its result', () => {
    const v = toContext('ValidationStore#validateAndDispatchBoth', 'ReqStore#dispatch', 'VALIDER');
    const s = toContext('ValidationStore#validateAndDispatchBoth', 'ReqStore#dispatch', 'ENREGISTRER');
    expect(v?.timing).toBe('AFTER_RESULT');
    expect(s?.timing).toBe('AFTER_RESULT');
    expect(v?.data).toContain('result = résultat de this.validate(data)');
  });

  it('13 — a chain never subscribed: the continuation is not demonstrated', () => {
    const l = from('ValidationStore#lost').find((x) => x.to.startsWith('ReqStore#dispatchObs'));
    expect(l?.confidence).toBe('UNKNOWN');
    expect(
      diagnostics().some((d) => d.code === 'ASYNC_NOT_DEMONSTRATED' && d.at === 'ValidationStore#lost'),
    ).toBe(true);
  });
});

describe('interactive elements of the template', () => {
  const ui = () => front()?.elements ?? [];

  it('16 + 17 — a button with click and a disabled condition', () => {
    expect(edge('TRIGGERS', B('valider'), 'METHOD:front:ReqComponent#validate')?.reason).toBe(
      '(click)="validate()"',
    );
    expect(ui().find((e) => e.id === 'ReqComponent#button:valider')?.disabledWhen?.expression).toBe(
      '!(canValidate$ | async)',
    );
    expect(model.edges.some((e) => e.kind === 'ENABLED_WHEN' && e.from === B('valider'))).toBe(true);
  });

  it('18 — an input type=submit sends the form (ngSubmit)', () => {
    expect(ui().find((e) => e.id === 'ReqComponent#button:envoyer')).toMatchObject({
      tag: 'input',
      event: 'ngSubmit',
      handler: 'submit',
    });
  });

  it('a link with an event is an entry point', () => {
    expect(edge('TRIGGERS', B('lien-rapide'), 'METHOD:front:ReqComponent#quick')).toBeDefined();
  });

  it('19 — a child output (saved) is an entry point, and the child emits to the parent handler', () => {
    expect(ui().find((e) => e.id === 'ReqComponent#button:app-shared-panel-saved')).toMatchObject({
      event: 'saved',
      handler: 'onSaved',
    });
    expect(
      links().some(
        (l) =>
          l.kind === 'OUTPUT' && l.from === 'SharedPanelComponent#save' && l.to === 'ReqComponent#onSaved',
      ),
    ).toBe(true);
  });

  it('20 — a button in a generated tab belongs to that tab', () => {
    expect(ui().find((e) => e.id === 'ReqComponent#button:actualiser')?.parent).toBe(
      'ReqComponent#container:tabs',
    );
  });

  it('21 — a shared component is shown in the tabs that instantiate it, never in the others', () => {
    const tabsOf = model.edges
      .filter((e) => e.kind === 'CONTAINS' && e.to === 'COMPONENT:front:SharedPanelComponent')
      .map((e) => e.from)
      .sort();
    expect(tabsOf).toEqual([
      'CONTAINER:front:ReqComponent#container:historique',
      'CONTAINER:front:ReqComponent#container:pieces',
    ]);
    expect(ui().find((e) => e.id === 'SharedPanelComponent#button:sauver')?.parent).toBe(
      'SharedPanelComponent#container:section',
    );
  });

  it('negative: a dynamic handler is not invented, it is reported', () => {
    expect(model.edges.some((e) => e.kind === 'TRIGGERS' && e.from === B('dynamique'))).toBe(false);
    expect(
      diagnostics().some((d) => d.code === 'UI_DYNAMIC' && d.at === 'ReqComponent#button:dynamique'),
    ).toBe(true);
  });

  it('the feature detail carries tabs, buttons, conditions and what they trigger; technical methods stay entries without a button', () => {
    const feature = model.features.find((f) => f.name === 'Req');
    const detail = featureDetail(buildIndex(model), cov, feature?.id ?? '');
    const ids = new Set(detail?.nodes.map((n) => n.id));
    expect(ids.has(B('lancer-la-validation'))).toBe(true);
    expect(detail?.nodes.find((n) => n.id === 'CONTAINER:front:ReqComponent#container:saisie')?.tab).toBe(
      'TAB',
    );
    expect(detail?.edges.some((e) => e.kind === 'TRIGGERS' && e.to.includes('ReqComponent#run⟨'))).toBe(true);
    expect(detail?.edges.some((e) => e.kind === 'ENABLED_WHEN')).toBe(true);
    // [disabled] bloque l'élément : la condition est marquée comme telle, et l'action non résolue est dite.
    expect(
      detail?.nodes.find((n) => n.id === 'CONDITION:front:ReqComponent#button:valider:enabled')?.negated,
    ).toBe(true);
    expect(detail?.nodes.find((n) => n.id === B('dynamique'))?.unresolved).toContain('handlers[0]()');
    expect(
      model.edges.some((e) => e.kind === 'TRIGGERS' && e.to === 'METHOD:front:ReqComponent#technical'),
    ).toBe(false);
  });

  it('a form sent without a submit button gets its own entry; an element without event is not one', () => {
    const elements = parseTemplate(
      'C',
      '<form (ngSubmit)="save()"><input formControlName="a" /></form><div>texte</div><a routerLink="/x">Aller</a>',
      'c.html',
      0,
    );
    expect(
      elements.filter((e) => e.kind === 'BUTTON').map((e) => [e.name, e.tag, e.event, e.handler]),
    ).toEqual([['Envoi du formulaire', 'form', 'ngSubmit', 'save']]);
  });
});

describe('the analyser on its own', () => {
  const read = (p: string, text: string) => ({ path: p, text, hash: '', bytes: text.length });
  it('a detached arrow-function property keeps its this; a bound method too', async () => {
    const ts = await loadTypeScript();
    if (!ts) throw new Error('typescript is required by the cartography');
    const rx = analyzeRxjs(
      ts,
      [
        read(
          's.ts',
          `@Injectable() export class Api { constructor(private http: HttpClient) {} run = () => this.http.get('/a'); go() { return this.http.get('/b'); } }
@Injectable() export class S {
  constructor(private api: Api) {}
  a() { const { run } = this.api; run().subscribe(); }
  b() { const go = this.api.go.bind(this.api); go().subscribe(); }
}`,
        ),
      ],
      new Map(),
    );
    expect(rx.links.find((l) => l.from === 'S#a' && l.to === 'Api#run')?.confidence).toBe('CONFIRMED');
    expect(rx.links.find((l) => l.from === 'S#b' && l.to === 'Api#go')?.confidence).toBe('CONFIRMED');
  });
});

describe('the nature of each asynchronous dependency', () => {
  const read = (p: string, text: string) => ({ path: p, text, hash: '', bytes: text.length });
  it('error, completion, timer and concurrency are told apart; a plain call stays direct', async () => {
    const ts = await loadTypeScript();
    if (!ts) throw new Error('typescript is required by the cartography');
    const rx = analyzeRxjs(
      ts,
      [
        read(
          's.ts',
          `@Injectable() export class Api { constructor(private http: HttpClient) {} load() { return this.http.get('/a'); } log() { return this.http.post('/log', {}); } }
@Injectable() export class S {
  constructor(private api: Api) {}
  onError() { this.api.load().pipe(catchError(() => this.api.log())).subscribe(); }
  onDone() { this.api.load().pipe(finalize(() => this.api.log().subscribe())).subscribe(); }
  later() { setTimeout(() => this.api.log().subscribe(), 10); }
  many() { this.api.load().pipe(mergeMap(() => this.api.log())).subscribe(); }
  plain() { this.api.log().subscribe(); }
}`,
        ),
      ],
      new Map(),
    );
    const at = (from: string) => rx.links.find((l) => l.from === from && l.to === 'Api#log');
    expect(at('S#onError')?.timing).toBe('ON_ERROR');
    expect(at('S#onDone')?.timing).toBe('ON_COMPLETE');
    expect(at('S#later')?.timing).toBe('DEFERRED');
    expect(at('S#many')).toMatchObject({ timing: 'AFTER_RESULT', concurrent: true });
    expect(at('S#many')?.cancellable).toBeUndefined();
    expect(at('S#plain')?.timing).toBe('DIRECT');
  });
});

describe('23 — incremental scans after an analyser change', () => {
  it('facts written by an older analyser are read again even if the source did not change', async () => {
    const first = await runScan({ config: configFor(FIXTURE), allowedRoots: [FIXTURE], incremental: false });
    expect(first.facts.every((f) => f.analyzer === ANALYZERS)).toBe(true);
    const older = first.facts.map((f) => ({ ...f, analyzer: 'cartography-3;rxjs-2' }));
    const again = await runScan({
      config: configFor(FIXTURE),
      allowedRoots: [FIXTURE],
      incremental: true,
      previous: { facts: older, sources: first.model.scan.sources },
    });
    expect(again.model.scan.sources.map((s) => s.state)).toEqual(['SCANNED', 'SCANNED']);
  });
  afterAll(() => undefined);
});
