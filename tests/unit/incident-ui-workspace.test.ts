import { afterEach, describe, expect, it, vi } from 'vitest';
import { QaCrawlerError, type QaCrawlerClient } from '../../src/sdk/core/client.js';
import type { ProjectDetail } from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import type { Incident, SourceFileView } from '../../src/sdk/core/incident-contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { emptyEditorUi } from '../../src/sdk/ui/dashboard-editor.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import {
  IncidentsController,
  INCIDENT_POLL_MS,
  type IncidentsHost,
} from '../../src/sdk/ui/dashboard-incidents-controller.js';
import { emptyIncidentsUi, type IncidentsUi } from '../../src/sdk/ui/dashboard-incidents.js';
import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import {
  renderDashboard,
  type DashboardRoute,
  type DashboardState,
} from '../../src/sdk/ui/dashboard-view.js';
import { demoIncident, demoReport, demoSource, demoSourceTree } from '../../src/sdk/ui/incident-demo.js';
import { edgeId, stepId } from '../../src/sdk/ui/incident-links.js';
import { PREFS_KEY, type PrefsStorage } from '../../src/sdk/ui/incident-split.js';
import {
  DEMO_DISABLED_ACTIONS,
  emptyWorkspaceUi,
  mainTabsOf,
  neededSources,
  renderContextPanel,
  STAGE_TABS,
  subTabsOf,
  tabsOf,
  VIEW_ROUTES,
  viewOf,
  WORKSPACE_TABS,
  workspaceCtx,
  type WorkspaceUi,
} from '../../src/sdk/ui/incident-workspace.js';

/**
 * L'ESPACE D'INVESTIGATION ASSEMBLÉ : les onglets et la progression, le panneau contextuel selon la
 * nature de la sélection, la sélection synchronisée (graphe, chronologie, code), la lecture du code
 * (arborescence une fois, fichiers en cache, refus 403), le suivi qui ne redessine que sur une révision
 * nouvelle, et la démonstration (aucun appel au serveur, actions désactivées avec leur raison). Les
 * données sont celles, réelles, de l'investigation de la fixture (le jeu de démonstration), rendues
 * « réelles » ici par un autre identifiant.
 */
const t = dashboardStrings('fr');
const REQUEST = 'rep_1:req-3-1';
const SERVICE_FILE = 'src/main/java/org/example/catalog/books/CatalogBookService.java';

/** Les données de la fixture, comme un incident du serveur (identifiant et projet réels). */
const real = (over: Partial<Incident> = {}): Incident => ({
  ...demoIncident(),
  id: 'inc_realincident1',
  projectId: 'prj_books',
  title: 'Erreur 500 à la création d’un livre',
  ...over,
});

const project = {
  id: 'prj_books',
  name: 'Catalogue',
  environments: [],
  scenarios: [],
} as unknown as ProjectDetail;

const role = (name: 'READER' | 'ANALYST' | 'PILOT') => ({
  me: {
    id: 'm',
    name: 'N',
    kind: 'MEMBER' as const,
    role: name,
    rights: [...ROLE_RIGHTS[name]],
    mode: 'named' as const,
  },
});

const page = (tab: (typeof WORKSPACE_TABS)[number] = 'overview', incidentId = 'inc_realincident1') =>
  ({ view: 'incident', projectId: 'prj_books', incidentId, tab }) as const;

const stateOf = (
  route: DashboardRoute,
  inc: Partial<IncidentsUi> = {},
  extra: Partial<DashboardState> = {},
) =>
  ({
    t,
    phase: 'ready',
    route,
    days: 7,
    showArchived: false,
    launch: { kind: 'REPLAY', environmentId: '', scenarios: [], busy: false },
    projectId: 'prj_books',
    menuOpen: false,
    checks: {},
    cancellation: true,
    picked: [],
    severity: 'ALL',
    project,
    req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
    signIn: false,
    access: emptyAccessUi(),
    recs: emptyRecordingsUi(),
    lib: emptyLibraryUi(),
    tst: emptyTestsUi(),
    ed: emptyEditorUi(),
    inc: { ...emptyIncidentsUi(), ...inc },
    ...extra,
  }) as DashboardState;

const fakeRoot = { querySelector: () => null, activeElement: null } as unknown as ShadowRoot;
const element = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement;

/** Un client dont chaque route d'incident est un espion ; une route non fournie échoue (et se voit). */
function apiOf(incidents: Partial<QaCrawlerClient['incidents']>) {
  const calls: string[] = [];
  const proxy = new Proxy(incidents, {
    get(target, name: string) {
      calls.push(name);
      const value = (target as Record<string, unknown>)[name];
      return value ?? (() => Promise.reject(new Error(`unexpected call ${name}`)));
    },
  });
  return { api: { incidents: proxy } as unknown as QaCrawlerClient, calls };
}

function setup(
  state: DashboardState,
  incidents: Partial<QaCrawlerClient['incidents']> = {},
  storage?: PrefsStorage,
) {
  const { api, calls } = apiOf(incidents);
  let paints = 0;
  const host = {
    ...(storage ? { storage: () => storage } : {}),
    root: fakeRoot,
    api: () => api,
    paint: () => {
      paints += 1;
    },
    navigate: (route: DashboardRoute) => {
      controller.leave(route);
      state.route = route;
    },
    refresh: () => Promise.resolve(),
  };
  Object.defineProperty(host, 'state', { get: () => state });
  const controller = new IncidentsController(host as unknown as IncidentsHost);
  return { controller, api, calls, paints: () => paints };
}

const wsOf = (incident: Incident, over: Partial<WorkspaceUi> = {}): WorkspaceUi => ({
  ...emptyWorkspaceUi(incident.id),
  ...over,
});

const panelOf = (incident: Incident, ws: WorkspaceUi): string => {
  const ctx = workspaceCtx(incident, ws, 'fr', () => true);
  return renderContextPanel(ctx, ctx, ws);
};

const serviceView = (): SourceFileView => {
  const view = demoSource('catalog', SERVICE_FILE);
  if (!view) throw new Error('fixture file expected');
  return view;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('investigation workspace — tabs and progress', () => {
  it('seven main tabs on one row, their sub-tabs with counts; the fifteen legacy view keys keep working, Reproduction › Exécution / Preuves added', () => {
    const incident = real();
    const ctx = workspaceCtx(incident, wsOf(incident), 'fr', () => true);
    const main = mainTabsOf(ctx);
    expect(main.map((tab) => tab.key)).toEqual([
      'overview',
      'timeline',
      'traceability',
      'code',
      'diagnosis',
      'trigger',
      'report',
    ]);
    expect(main.map((tab) => tab.label)).toEqual([
      'Vue d’ensemble',
      'Reproduction',
      'Traçabilité',
      'Code',
      'Diagnostic',
      'Déclencheurs',
      'Rapport',
    ]);
    expect(main.find((tab) => tab.key === 'timeline')?.count).toBe(
      incident.investigation.reproductions.length,
    );
    expect(subTabsOf(ctx, 'overview').map((tab) => tab.label)).toEqual([
      'Résumé',
      'Périmètre',
      'Environnement',
    ]);
    expect(subTabsOf(ctx, 'overview').find((tab) => tab.key === 'scope')?.count).toBe(1);
    expect(subTabsOf(ctx, 'timeline').map((tab) => tab.key)).toEqual(['run', 'evidence', 'events', 'logs']);
    expect(subTabsOf(ctx, 'timeline').map((tab) => tab.label)).toEqual([
      'Exécution',
      'Preuves',
      'Chronologie',
      'Journaux',
    ]);
    const reference = incident.investigation.reproductions.find((run) => run.status === 'COMPLETED');
    expect(subTabsOf(ctx, 'timeline').find((tab) => tab.key === 'evidence')?.count).toBe(
      (reference?.requests.length ?? 0) + (reference?.evidence.length ?? 0),
    );
    expect(subTabsOf(ctx, 'timeline').find((tab) => tab.key === 'events')?.count).toBe(
      incident.investigation.timeline?.length,
    );
    expect(subTabsOf(ctx, 'traceability').map((tab) => tab.label)).toEqual([
      'Full Stack',
      'Frontend',
      'BFF',
      'Backend',
      'HTTP',
    ]);
    expect(subTabsOf(ctx, 'code')).toEqual([]);
    expect(subTabsOf(ctx, 'diagnosis').map((tab) => tab.key)).toEqual([
      'diagnosis',
      'hypotheses',
      'experiments',
      'ai',
    ]);
    expect(subTabsOf(ctx, 'trigger').map((tab) => tab.key)).toEqual([
      'brief',
      'discovery',
      'explorer',
      'live',
      'chronology',
      'matrix',
      'minimal',
      'angular',
      'causes',
      'proposal',
    ]);
    expect(subTabsOf(ctx, 'report').map((tab) => tab.key)).toEqual(['report', 'regression']);
    // Les quinze clés historiques (et `code`) restent des clés de vue : chacune désigne (onglet, sous-onglet).
    expect(tabsOf(ctx).map((tab) => tab.key)).toEqual([...WORKSPACE_TABS]);
    expect(VIEW_ROUTES).toEqual({
      overview: { tab: 'overview', sub: 'summary' },
      scope: { tab: 'overview', sub: 'scope' },
      environment: { tab: 'overview', sub: 'environment' },
      run: { tab: 'timeline', sub: 'run' },
      evidence: { tab: 'timeline', sub: 'evidence' },
      timeline: { tab: 'timeline', sub: 'events' },
      logs: { tab: 'timeline', sub: 'logs' },
      traceability: { tab: 'traceability', sub: 'fullstack' },
      requests: { tab: 'traceability', sub: 'http' },
      frontend: { tab: 'traceability', sub: 'frontend' },
      bff: { tab: 'traceability', sub: 'bff' },
      backend: { tab: 'traceability', sub: 'backend' },
      hypotheses: { tab: 'diagnosis', sub: 'hypotheses' },
      experiments: { tab: 'diagnosis', sub: 'experiments' },
      diagnosis: { tab: 'diagnosis', sub: 'diagnosis' },
      ai: { tab: 'diagnosis', sub: 'ai' },
      tbrief: { tab: 'trigger', sub: 'brief' },
      tdiscovery: { tab: 'trigger', sub: 'discovery' },
      texplorer: { tab: 'trigger', sub: 'explorer' },
      tlive: { tab: 'trigger', sub: 'live' },
      tevents: { tab: 'trigger', sub: 'chronology' },
      tmatrix: { tab: 'trigger', sub: 'matrix' },
      tminimal: { tab: 'trigger', sub: 'minimal' },
      tangular: { tab: 'trigger', sub: 'angular' },
      tcauses: { tab: 'trigger', sub: 'causes' },
      tproposal: { tab: 'trigger', sub: 'proposal' },
      report: { tab: 'report', sub: 'report' },
      regression: { tab: 'report', sub: 'regression' },
      code: { tab: 'code' },
    });
    for (const key of WORKSPACE_TABS) {
      const route = VIEW_ROUTES[key];
      expect(viewOf(route.tab, route.sub), key).toBe(key);
    }
    expect(viewOf('traceability')).toBe('traceability');
    expect(viewOf('report', 'unknown')).toBe('report');
    expect(STAGE_TABS).toMatchObject({
      description: 'overview',
      scope: 'scope',
      environment: 'environment',
      reproduction: 'run',
      evidence: 'evidence',
      code: 'code',
      traceability: 'traceability',
      diagnosis: 'diagnosis',
      regression: 'regression',
    });
    for (const tab of Object.values(STAGE_TABS)) expect(WORKSPACE_TABS).toContain(tab);
  });

  it('a stage, a main tab, a sub-tab and a legacy key change the route; arrows rove; a main tab reopens its last sub-tab', () => {
    const incident = real();
    const state = stateOf(page('overview'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, { capabilities: () => new Promise(() => undefined) });
    controller.click('ws-ux-stage', element({ stage: 'traceability' }));
    expect(state.route).toMatchObject({ view: 'incident', tab: 'traceability' });
    controller.click('ws-ux-stage', element({ stage: 'code' }));
    expect(state.route).toMatchObject({ tab: 'code' });
    // Une clé historique (lien, progression) : la vue exacte.
    controller.click('ws-ux-tab', element({ tab: 'environment' }));
    expect(state.route).toMatchObject({ tab: 'environment' });
    // Flèches sur les onglets principaux : de « Vue d'ensemble » à « Reproduction » (son premier
    // sous-onglet, « Exécution »), Fin : « Rapport ».
    const key = (name: string, dataset: Record<string, string>): boolean =>
      controller.keydown({
        key: name,
        target: element(dataset),
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent);
    expect(key('ArrowRight', { action: 'ws-ux-tab', tab: 'overview' })).toBe(true);
    expect(state.route).toMatchObject({ tab: 'run' });
    // Les clés historiques de la reproduction : la chronologie et les journaux.
    // (`timeline` est aussi le nom de l'onglet principal : un clic rouvre son dernier sous-onglet ; la route
    // `timeline` désigne toujours la chronologie.)
    controller.workspace.selectTab('timeline', false);
    expect(state.route).toMatchObject({ tab: 'timeline' });
    expect(VIEW_ROUTES.timeline).toEqual({ tab: 'timeline', sub: 'events' });
    controller.click('ws-ux-tab', element({ tab: 'logs' }));
    expect(state.route).toMatchObject({ tab: 'logs' });
    controller.click('ws-ux-stage', element({ stage: 'evidence' }));
    expect(state.route).toMatchObject({ tab: 'evidence' });
    controller.click('ws-ux-stage', element({ stage: 'reproduction' }));
    expect(state.route).toMatchObject({ tab: 'run' });
    key('End', { action: 'ws-ux-tab', tab: 'timeline' });
    expect(state.route).toMatchObject({ tab: 'report' });
    // Flèches sur les sous-onglets : « Rapport » → « Non-régression ».
    expect(key('ArrowRight', { action: 'ws-ux-sub', sub: 'report' })).toBe(true);
    expect(state.route).toMatchObject({ tab: 'regression' });
    controller.click('ws-ux-sub', element({ sub: 'report' }));
    expect(state.route).toMatchObject({ tab: 'report' });
    // Un onglet principal rouvre le dernier sous-onglet ouvert de cet onglet.
    controller.click('ws-ux-tab', element({ tab: 'overview' }));
    expect(state.route).toMatchObject({ tab: 'environment' });
    controller.click('ws-ux-tab', element({ tab: 'traceability' }));
    expect(state.route).toMatchObject({ tab: 'traceability' });
    controller.click('ws-ux-sub', element({ sub: 'http' }));
    expect(state.route).toMatchObject({ tab: 'requests' });
    controller.click('ws-ux-tab', element({ tab: 'diagnosis' }));
    controller.click('ws-ux-tab', element({ tab: 'traceability' }));
    expect(state.route).toMatchObject({ tab: 'requests' });
    expect(state.inc?.ws.subs).toMatchObject({ overview: 'environment', traceability: 'http' });
  });
});

describe('investigation workspace — context panel by selection kind', () => {
  const incident = real();
  const graph = incident.investigation.graph;
  if (!graph) throw new Error('graph expected');
  const serviceNode = graph.nodes.find((node) => node.kind === 'BACKEND_SERVICE');
  const edge = graph.edges[0];
  if (!serviceNode || !edge) throw new Error('fixture graph expected');

  it('nothing selected: an invitation to select', () => {
    expect(panelOf(incident, wsOf(incident))).toContain(
      'Sélectionnez un nœud ou une relation du graphe pour voir ses preuves.',
    );
  });

  it('node and edge: the graph detail; a node from the code shows its excerpt once the file is read', () => {
    const selection = { kind: 'node' as const, id: serviceNode.id };
    const loading = panelOf(incident, wsOf(incident, { selection }));
    expect(loading).toContain('id="ws-graph-detail-h">CatalogBookService.register</h3>');
    expect(loading).toContain('Lecture du fichier…');
    const read = panelOf(
      incident,
      wsOf(incident, {
        selection,
        sources: { [`catalog:${SERVICE_FILE}`]: { view: serviceView(), revision: incident.revision } },
      }),
    );
    expect(read).toContain('class="ws-code-ex"');
    expect(read).toContain('CatalogBookService.java:18');
    const relation = panelOf(
      incident,
      wsOf(incident, { selection: { kind: 'edge', id: edgeId(edge.from, edge.to) } }),
    );
    expect(relation).toContain('class="ws-graph-detail"');
    expect(relation).toContain(edge.reason);
  });

  it('request: its timing, correlation, masked bodies and linked graph nodes', () => {
    const html = panelOf(incident, wsOf(incident, { selection: { kind: 'request', id: REQUEST } }));
    expect(html).toContain('class="ws-timeline-detail"');
    expect(html).toContain('NullPointerException');
    expect(html).toContain('CatalogBookService.register');
  });

  it('step: the frontend trace of the step; hypothesis and experiment: their detail', () => {
    expect(
      panelOf(incident, wsOf(incident, { selection: { kind: 'step', id: stepId('rep_1', 3) } })),
    ).toContain('Traçabilité de l’étape 3');
    const hypothesis = incident.investigation.hypotheses[0];
    const experiment = incident.investigation.experiments.find(
      (entry) => entry.kind === 'COMPARE_WITH_PASSING',
    );
    if (!hypothesis || !experiment) throw new Error('fixture expected');
    expect(
      panelOf(incident, wsOf(incident, { selection: { kind: 'hypothesis', id: hypothesis.id } })),
    ).toContain('class="ws-dx-detail"');
    expect(
      panelOf(incident, wsOf(incident, { selection: { kind: 'experiment', id: experiment.id } })),
    ).toContain(experiment.evidence[0]?.summary ?? '?');
  });

  it('evidence: its summary; a screenshot is shown once read (or its loading, refusal, error)', () => {
    const page = panelOf(
      incident,
      wsOf(incident, { selection: { kind: 'evidence', id: 'rep_1:ev-page-1' } }),
    );
    expect(page).toContain('page /books/new après l&#39;étape 1');
    const selection = { kind: 'evidence' as const, id: 'rep_1:ev-screenshot-3' };
    const key = 'rep_1|screenshots/002-creer-un-livre-sans-editeur-step-3-failed.png';
    expect(panelOf(incident, wsOf(incident, { selection }))).toContain('Chargement de la capture');
    expect(
      panelOf(
        incident,
        wsOf(incident, { selection, shots: { [key]: { dataUrl: 'data:image/png;base64,AAAA' } } }),
      ),
    ).toContain('<img src="data:image/png;base64,AAAA"');
    expect(panelOf(incident, wsOf(incident, { selection, shots: { [key]: { state: 'denied' } } }))).toContain(
      'Votre rôle ne permet pas de voir les captures d’écran.',
    );
    expect(
      panelOf(incident, wsOf(incident, { selection, shots: { [key]: { state: { error: 'gone' } } } })),
    ).toContain('data-action="ws-shot-reload"');
  });

  it('event: its evidence and its request; symbol and file: the code excerpt', () => {
    const event = incident.investigation.timeline?.find((entry) => entry.requestId === REQUEST);
    if (!event) throw new Error('timeline event expected');
    const html = panelOf(incident, wsOf(incident, { selection: { kind: 'event', id: event.id } }));
    expect(html).toContain('Requête reliée');
    expect(html).toContain('class="ws-timeline-detail"');
    const symbolId = serviceNode.symbolId ?? '';
    const symbol = panelOf(
      incident,
      wsOf(incident, {
        selection: { kind: 'symbol', id: symbolId },
        sources: { [`catalog:${SERVICE_FILE}`]: { view: serviceView(), revision: incident.revision } },
      }),
    );
    expect(symbol).toContain('<h3 class="ws-ctx-h">CatalogBookService.register</h3>');
    expect(symbol).toContain('class="ws-code-ex"');
    const file = panelOf(
      incident,
      wsOf(incident, {
        selection: { kind: 'file', id: `catalog:${SERVICE_FILE}` },
        sources: { [`catalog:${SERVICE_FILE}`]: { view: serviceView(), revision: incident.revision } },
      }),
    );
    expect(file).toContain('class="ws-code-ex"');
  });
});

describe('investigation workspace — synchronized selection and code', () => {
  it('selecting the failing request highlights its graph nodes, opens its code and reads the file once', async () => {
    const incident = real();
    const source = vi.fn(() => Promise.resolve(serviceView()));
    const sourceTree = vi.fn(() => Promise.resolve(demoSourceTree()));
    const state = stateOf(page('requests'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, { source, sourceTree });
    controller.click('ws-select', element({ kind: 'request', ref: REQUEST }));
    const ws = state.inc?.ws;
    expect(ws?.selection).toEqual({ kind: 'request', id: REQUEST });
    // Le code de la sélection est montré dans l'éditeur (onglet de fichier actif), ancré sur la sélection.
    expect(ws?.code.tabs[ws.code.active ?? 0]?.anchor).toBe(`request:${REQUEST}`);
    await vi.waitFor(() => {
      expect(Object.values(state.inc?.ws.sources ?? {}).some((entry) => entry.view)).toBe(true);
    });
    expect(sourceTree).toHaveBeenCalledTimes(1);
    const html = renderDashboard(state);
    // Le graphe (vue Full Stack) met en évidence les nœuds reliés à la requête ; le reste est atténué.
    const graphView = renderDashboard({ ...state, route: page('traceability') });
    expect(graphView).toMatch(/class="ws-graph-node ws-gk-request[^"]*ws-related"/);
    expect(graphView).toMatch(/class="ws-graph-node ws-gk-backend_service[^"]*ws-(related|dimmed)"/);
    expect(html).toContain(
      'data-kind="request" data-ref="rep_1:req-3-1" data-ws-state="selected" aria-pressed="true"',
    );
    expect(html).toContain('Code relié');
    // La chronologie peut se restreindre à ce qui est relié.
    controller.click('ws-ux-tab', element({ tab: 'timeline' }));
    controller.change({
      dataset: { action: 'ws-timeline-related' },
      value: 'on',
    } as unknown as HTMLInputElement);
    expect(state.inc?.ws.timeline.onlyRelated).toBe(true);
    // Le même fichier n'est pas relu (cache), même en changeant d'onglet.
    controller.click('ws-ux-tab', element({ tab: 'backend' }));
    await vi.waitFor(() => {
      expect(Object.values(state.inc?.ws.sources ?? {}).every((entry) => entry.view)).toBe(true);
    });
    const calls = source.mock.calls.length;
    controller.click('ws-ux-tab', element({ tab: 'requests' }));
    controller.click('ws-ux-tab', element({ tab: 'backend' }));
    await Promise.resolve();
    expect(source.mock.calls.length).toBe(calls);
    // Un second clic sur l'élément sélectionné vide la sélection ; Échap aussi.
    controller.click('ws-select', element({ kind: 'request', ref: REQUEST }));
    expect(state.inc?.ws.selection).toBeUndefined();
    controller.click(
      'ws-select',
      element({ kind: 'node', ref: incident.investigation.graph?.nodes[1]?.id ?? '' }),
    );
    expect(state.inc?.ws.selection?.kind).toBe('node');
    expect(
      controller.keydown({
        key: 'Escape',
        target: element({}),
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent),
    ).toBe(true);
    expect(state.inc?.ws.selection).toBeUndefined();
  });

  it('a code link opens the file in the editor (Code tab from a document tab); a new revision reads the file again', async () => {
    const incident = real();
    const source = vi.fn(() => Promise.resolve(serviceView()));
    const state = stateOf(page('hypotheses'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, { source, sourceTree: () => Promise.resolve(demoSourceTree()) });
    controller.click('ws-code', element({ app: 'catalog', file: SERVICE_FILE, line: '18' }));
    // D'un onglet de document, l'onglet Code s'ouvre ; sur Traçabilité, l'éditeur est déjà là.
    expect(state.route).toMatchObject({ tab: 'code' });
    controller.click('ws-ux-sub', element({ sub: 'x' }));
    controller.click('ws-ux-tab', element({ tab: 'requests' }));
    controller.click('ws-code', element({ app: 'catalog', file: SERVICE_FILE, line: '18' }));
    expect(state.route).toMatchObject({ tab: 'requests' });
    expect(state.inc?.ws.code.tabs[state.inc.ws.code.active ?? 0]).toMatchObject({
      applicationId: 'catalog',
      file: SERVICE_FILE,
      line: 18,
    });
    await vi.waitFor(() => {
      expect(source).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(state.inc?.ws.sources[`catalog:${SERVICE_FILE}`]?.view).toBeDefined();
    });
    expect(renderDashboard(state)).toContain('ws-code-target');
    // L'incident relu (révision nouvelle) : les lignes signalées sont recalculées par le serveur.
    controller.receive({ ...incident, revision: incident.revision + 1 });
    controller.workspace.ensure();
    expect(source).toHaveBeenCalledTimes(2);
    // Pendant la relecture, le fichier déjà lu reste affiché.
    expect(state.inc?.ws.sources[`catalog:${SERVICE_FILE}`]?.view).toBeDefined();
  });

  it('a 403 on the scope tree shows the access refused, without content nor retry', async () => {
    const incident = real();
    const sourceTree = vi.fn(() =>
      Promise.reject(new QaCrawlerError({ error: 'forbidden', status: 403, code: 'FORBIDDEN' })),
    );
    const state = stateOf(page('backend'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, { sourceTree, source: () => new Promise(() => undefined) });
    controller.workspace.ensure();
    await vi.waitFor(() => {
      expect(state.inc?.ws.treeState).toBe('denied');
    });
    const html = renderDashboard(state);
    expect(html).toContain('Votre rôle ne permet pas de lire le code du périmètre.');
    expect(html).not.toContain('data-action="ws-code-reload"');
  });

  it('a reader sees the investigation without any action button', () => {
    const incident = real();
    const html = renderDashboard(
      stateOf(page('hypotheses'), { incident, ws: wsOf(incident) }, role('READER')),
    );
    for (const action of ['inc-reproduce', 'inc-cancel', 'ws-dx-analyze', 'ws-dx-plan', 'ws-dx-diagnose'])
      expect(html).not.toContain(`data-action="${action}"`);
    expect(html).toContain('Lecture seule');
  });
});

describe('investigation workspace — layout and announcements (QA review)', () => {
  const panes = (html: string): string[] =>
    [...html.matchAll(/<section class="ws-pane[^"]*" id="ws-pane-(\w+)"/g)].map((match) => match[1] ?? '');
  const shell = (tab: (typeof WORKSPACE_TABS)[number], over: Partial<WorkspaceUi> = {}) => {
    const incident = real();
    return renderDashboard(stateOf(page(tab), { incident, ws: wsOf(incident, over) }));
  };

  it('traceability views: graph (or trace, or requests) | details above, files | code | evidence below, with splitters', () => {
    for (const tab of ['traceability', 'frontend', 'bff', 'backend', 'requests'] as const) {
      const html = shell(tab);
      expect(panes(html), tab).toEqual(['primary', 'details', 'tree', 'editor', 'evidence']);
      expect(html, tab).toContain('data-ws-layout="trace"');
      for (const splitter of ['top-bottom', 'primary-details', 'tree-editor', 'editor-evidence'])
        expect(html, `${tab} ${splitter}`).toContain(`data-ws-splitter="${splitter}"`);
      expect(html, tab).toMatch(/role="separator" tabindex="0" aria-orientation="horizontal"/);
      expect(html, tab).toContain(`id="ws-ux-sub-${VIEW_ROUTES[tab].sub ?? ''}" data-action="ws-ux-sub"`);
      expect(html, tab).toContain(
        `role="tabpanel" aria-labelledby="ws-ux-sub-${VIEW_ROUTES[tab].sub ?? ''}"`,
      );
    }
    expect(shell('traceability')).toContain('class="ws-graph ws-graph-compact');
    expect(shell('bff')).toContain('data-focus="BFF"');
    expect(shell('backend')).toContain('data-focus="BACKEND"');
    expect(shell('frontend')).toContain('Traçabilité frontend');
    expect(shell('requests')).toContain(
      '<h2 class="ws-pane-t" id="ws-pane-primary-t" title="Requêtes HTTP">',
    );
    // L'alternative textuelle du graphe (toutes les relations) reste dans les détails, repliée.
    expect(shell('traceability')).toContain('data-ws-details="relations"');
  });

  it('Code tab: the same split, the top zone collapsed to its bars by default (and restorable); no sub-tab bar', () => {
    const html = shell('code');
    expect(panes(html)).toEqual(['primary', 'details', 'tree', 'editor', 'evidence']);
    expect(html).toContain('data-ws-layout="code"');
    expect(html).toMatch(
      /id="ws-pane-primary" data-ws-pane="primary" data-ws-zone="primary" data-mode="min"/,
    );
    expect(html).toMatch(
      /id="ws-pane-details" data-ws-pane="details" data-ws-zone="details" data-mode="min"/,
    );
    expect(html).toContain('ws-zone-collapsed');
    expect(html).toContain('data-pane="primary" data-op="restore" data-layout="code"');
    expect(html).not.toContain('data-action="ws-ux-sub"');
    expect(html).toContain('role="tabpanel" aria-labelledby="ws-ux-tab-code"');
    const open = shell('code', { split: { ...emptyWorkspaceUi().split, codeTop: true } });
    expect(open).toMatch(
      /id="ws-pane-primary" data-ws-pane="primary" data-ws-zone="primary" data-mode="normal"/,
    );
  });

  it('document views: content | details, resizable; every main tab is reachable on one row', () => {
    for (const tab of ['overview', 'timeline', 'logs', 'hypotheses', 'experiments'] as const) {
      const html = shell(tab);
      expect(panes(html), tab).toEqual(['content', 'details']);
      expect(html, tab).toContain('data-ws-splitter="content-details"');
      expect(html, tab).toContain(`data-view="${tab}"`);
      expect(html.match(/data-action="ws-ux-tab"/g), tab).toHaveLength(7);
    }
    // Les écrans pleine largeur : le panneau des détails n'apparaît qu'avec une sélection.
    for (const tab of [
      'scope',
      'environment',
      'run',
      'evidence',
      'diagnosis',
      'report',
      'regression',
    ] as const) {
      const html = shell(tab);
      expect(panes(html), tab).toEqual(['content']);
      expect(html, tab).not.toContain('data-ws-splitter="content-details"');
      expect(html, tab).toContain(`data-view="${tab}"`);
      const incident = real();
      const request = incident.investigation.reproductions.flatMap((run) => run.requests)[0];
      const selected = shell(tab, { selection: { kind: 'request', id: request?.id ?? '' } });
      expect(panes(selected), `${tab} with a selection`).toEqual(['content', 'details']);
    }
  });

  it('a maximized pane fills the workspace alone; a hidden pane is listed to be shown again', () => {
    const base = emptyWorkspaceUi().split;
    const maxed = shell('traceability', { split: { ...base, maximized: 'editor' } });
    expect(panes(maxed)).toEqual(['editor']);
    expect(maxed).toContain('ws-split-maxed');
    expect(maxed).toContain('data-pane="editor" data-op="restore"');
    const hidden = shell('traceability', { split: { ...base, panes: { evidence: 'hidden' } } });
    expect(panes(hidden)).toEqual(['primary', 'details', 'tree', 'editor']);
    expect(hidden).toContain('data-action="ws-pane" data-pane="evidence" data-op="show"');
    expect(hidden).toContain('Panneaux masqués');
  });

  it('the header is one compact row with a « Détails » disclosure; the progress is a thin row that unfolds', () => {
    const closed = shell('overview');
    expect(closed).toContain('data-action="ws-ux-details" aria-expanded="false" title=');
    expect(closed).not.toContain('id="ws-ux-head-more"');
    expect(closed).toContain('data-action="ws-ux-stepper" aria-expanded="false"');
    expect(closed).not.toContain('<ol id="ws-ux-steps">');
    const open = shell('overview', { headOpen: true, stepperOpen: true });
    expect(open).toContain('id="ws-ux-head-more"');
    expect(open).toContain('<ol id="ws-ux-steps">');
    expect(open.match(/data-action="ws-ux-stage" data-stage="[a-z]+"/g)?.length).toBeGreaterThanOrEqual(10);
    expect(shell('overview', { compact: true })).toContain('class="ws-root ws-compact"');
  });

  it('the files to read: the selection, then the open editor tabs on Traçabilité and Code', () => {
    const incident = real();
    const ws = wsOf(incident, { selection: { kind: 'request', id: REQUEST } });
    const ctx = workspaceCtx(incident, ws, 'fr', () => true);
    const onDocument = neededSources(ctx, ws, 'hypotheses');
    expect(onDocument.length).toBeLessThanOrEqual(1);
    ws.code = { ...ws.code, tabs: [{ applicationId: 'catalog', file: SERVICE_FILE, anchor: '' }], active: 0 };
    const onTrace = neededSources(ctx, ws, 'traceability');
    expect(onTrace.map((entry) => entry.file)).toContain(SERVICE_FILE);
    expect(new Set(onTrace.map((entry) => `${entry.applicationId}:${entry.file}`)).size).toBe(onTrace.length);
  });

  it('the duration of a reproduction step is labelled « Durée », not « Statut »', () => {
    const incident = real();
    const bare = { ...incident, investigation: { ...incident.investigation, frontendTrace: undefined } };
    const html = panelOf(bare, wsOf(bare, { selection: { kind: 'step', id: stepId('rep_1', 3) } }));
    expect(html).toMatch(/<dt>Durée<\/dt><dd>\d+ ms<\/dd>/);
    expect(html).not.toMatch(/<dt>Statut<\/dt><dd>\d+ ms<\/dd>/);
  });

  it('a verification finished while following, or a file not read, is told in the messages zone', async () => {
    const incident = real();
    const experiment = incident.investigation.experiments[0];
    if (!experiment) throw new Error('experiment expected');
    const running = real({
      revision: 20,
      investigation: { ...incident.investigation, experiments: [{ ...experiment, status: 'RUNNING' }] },
    });
    const state = stateOf(page('experiments'), { incident: running, ws: wsOf(running) });
    const source = vi.fn(() =>
      Promise.reject(new QaCrawlerError({ error: 'boom', status: 500, code: 'INTERNAL' })),
    );
    const { controller } = setup(state, { source, sourceTree: () => Promise.resolve(demoSourceTree()) });
    controller.receive(
      real({
        revision: 21,
        investigation: { ...incident.investigation, experiments: [{ ...experiment, status: 'DONE' }] },
      }),
    );
    expect(state.inc?.notice).toBe('Vérification : Terminée.');
    // Une révision qui ne termine aucune vérification ne dit rien de nouveau.
    state.inc = { ...emptyIncidentsUi(), ...state.inc, notice: undefined };
    controller.receive({ ...(state.inc.incident ?? incident), revision: 22 });
    expect(state.inc.notice).toBeUndefined();
    controller.click('ws-code', element({ app: 'catalog', file: SERVICE_FILE, line: '18' }));
    await vi.waitFor(() => {
      expect(state.inc?.notice).toBe(`Fichier ${SERVICE_FILE} non lu : boom`);
    });
  });

  it('the permanent live zone takes the message text only when it changes, never on a repaint with the same text nor on the first paint', async () => {
    vi.useFakeTimers();
    const incident = real();
    const state = stateOf(page('overview'), { incident, ws: wsOf(incident) });
    // La zone live permanente (créée une fois par le Dashboard) et le message affiché (redessiné).
    const live = { textContent: '' };
    let writes = 0;
    const zone = {
      get textContent() {
        return live.textContent;
      },
      set textContent(value: string) {
        writes += 1;
        live.textContent = value;
      },
    };
    let shown: { textContent: string } | null = { textContent: 'Ancien message' };
    const root = {
      activeElement: null,
      querySelector: (selector: string) =>
        selector === '.inc-live' ? zone : selector === '.inc-msg' ? shown : null,
      querySelectorAll: () => [],
    } as unknown as ShadowRoot;
    const host = {
      root,
      api: () => undefined,
      paint: () => undefined,
      navigate: () => undefined,
      refresh: () => Promise.resolve(),
    };
    Object.defineProperty(host, 'state', { get: () => state });
    const controller = new IncidentsController(host as unknown as IncidentsHost);
    // Premier dessin : un message plus ancien que la page n'est pas dit.
    controller.afterPaint();
    expect(writes).toBe(0);
    shown = { textContent: ' Reproduction terminée : Reproduit. ' };
    controller.afterPaint();
    expect(live.textContent).toBe('Reproduction terminée : Reproduit.');
    expect(writes).toBe(1);
    // Suivi, sélection, disposition : le même texte redessiné n'est jamais réécrit (aucune réinsertion).
    for (let k = 0; k < 7; k += 1) {
      shown = { textContent: 'Reproduction terminée : Reproduit.' };
      controller.afterPaint();
    }
    expect(writes).toBe(1);
    // Le texte annoncé quitte la zone live après un moment ; le message affiché reste, sans nouvelle annonce.
    await vi.advanceTimersByTimeAsync(9000);
    expect(live.textContent).toBe('');
    controller.afterPaint();
    expect(writes).toBe(2);
    // Plus de message : la zone se vide ; un nouveau message est dit.
    shown = null;
    controller.afterPaint();
    shown = { textContent: 'Vérification planifiée.' };
    controller.afterPaint();
    expect(live.textContent).toBe('Vérification planifiée.');
    vi.useRealTimers();
  });
});

/** Un stockage de préférences en mémoire. */
function memoryStorage(initial?: unknown): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(initial === undefined ? [] : [[PREFS_KEY, JSON.stringify(initial)]]);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/** Un élément du graphe (sa sélection vient du graphe) ou de l'éditeur (`closest` répond). */
const inside = (dataset: Record<string, string>, selector: string): HTMLElement =>
  ({
    dataset,
    closest: (wanted: string) => (wanted === selector ? {} : null),
  }) as unknown as HTMLElement;

const keyOn = (target: HTMLElement, key: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key, target, preventDefault: vi.fn(), shiftKey: false, ...extra }) as unknown as KeyboardEvent;

describe('investigation workspace — layout controller', () => {
  it('pane operations; Escape first restores a maximized pane, then clears the selection', () => {
    const incident = real();
    const state = stateOf(page('traceability'), {
      incident,
      ws: wsOf(incident, { selection: { kind: 'request', id: REQUEST } }),
    });
    const { controller, paints } = setup(state, {
      source: () => new Promise(() => undefined),
      sourceTree: () => new Promise(() => undefined),
    });
    const before = paints();
    controller.click('ws-pane', element({ pane: 'editor', op: 'max' }));
    expect(state.inc?.ws.split.maximized).toBe('editor');
    expect(paints()).toBeGreaterThan(before);
    expect(controller.keydown(keyOn(element({}), 'Escape'))).toBe(true);
    expect(state.inc?.ws.split.maximized).toBeUndefined();
    expect(state.inc?.ws.selection).toBeDefined();
    controller.click('ws-pane', element({ pane: 'evidence', op: 'hide' }));
    expect(state.inc?.ws.split.panes.evidence).toBe('hidden');
    controller.click('ws-pane', element({ pane: 'evidence', op: 'show' }));
    expect(state.inc?.ws.split.panes.evidence).toBeUndefined();
    // L'arborescence réduite par son panneau : l'explorateur suit ; et inversement.
    controller.click('ws-pane', element({ pane: 'tree', op: 'min' }));
    expect(state.inc?.ws.code.treeCollapsed).toBe(true);
    controller.click('ws-code-tree-toggle', element({}));
    expect(state.inc?.ws.code.treeCollapsed).toBe(false);
    expect(state.inc?.ws.split.panes.tree).toBeUndefined();
    controller.click('ws-pane-focus', element({ pane: 'details' }));
    expect(state.inc?.ws.split.mobilePane).toBe('details');
    // Un clic seul sur un séparateur ne change rien.
    const split = state.inc?.ws.split;
    expect(controller.click('ws-split', element({ wsSplitter: 'primary-details' }))).toBe(true);
    expect(state.inc?.ws.split).toBe(split);
    expect(controller.keydown(keyOn(element({}), 'Escape'))).toBe(true);
    expect(state.inc?.ws.selection).toBeUndefined();
  });

  it('a splitter moves with the keyboard (bounded by the pixel minimums of the zone); Enter collapses its first pane', () => {
    const incident = real();
    const state = stateOf(page('timeline'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state);
    const splitter = {
      dataset: { action: 'ws-split', wsSplitter: 'content-details' },
      parentElement: { getBoundingClientRect: () => ({ width: 1000, height: 600 }) },
    } as unknown as HTMLElement;
    expect(controller.keydown(keyOn(splitter, 'ArrowLeft'))).toBe(true);
    expect(state.inc?.ws.split.sizes['content-details']).toBeCloseTo(0.66);
    controller.keydown(keyOn(splitter, 'ArrowLeft', { shiftKey: true }));
    expect(state.inc?.ws.split.sizes['content-details']).toBeCloseTo(0.56);
    controller.keydown(keyOn(splitter, 'Home'));
    expect(state.inc?.ws.split.sizes['content-details']).toBe(0.36);
    controller.keydown(keyOn(splitter, 'End'));
    expect(state.inc?.ws.split.sizes['content-details']).toBe(0.74);
    controller.keydown(keyOn(splitter, 'Enter'));
    expect(state.inc?.ws.split.panes.content).toBe('min');
    expect(controller.keydown(keyOn(splitter, 'x'))).toBe(false);
    controller.click('ws-split-reset', element({}));
    expect(state.inc?.ws.split.panes).toEqual({});
  });

  it('header « Détails », progress and compact mode toggle; preferences load on open and are saved (debounced)', () => {
    vi.useFakeTimers();
    const incident = real();
    const storage = memoryStorage({
      tab: 'traceability',
      subs: { traceability: 'http' },
      compact: true,
      sizes: { 'primary-details': 0.6 },
      panes: { evidence: 'min' },
    });
    const state = stateOf({ view: 'incident', projectId: 'prj_books', incidentId: incident.id }, {});
    const { controller } = setup(state, {}, storage);
    controller.receive(incident, false);
    // L'investigation s'ouvre sur le dernier onglet utilisé, avec la disposition retenue.
    expect(state.route).toMatchObject({ tab: 'requests' });
    const ws = state.inc?.ws;
    expect(ws?.compact).toBe(true);
    expect(ws?.split.sizes['primary-details']).toBe(0.6);
    expect(ws?.split.panes.evidence).toBe('min');
    controller.click('ws-ux-details', element({}));
    expect(state.inc?.ws.headOpen).toBe(true);
    controller.click('ws-ux-stepper', element({}));
    expect(state.inc?.ws.stepperOpen).toBe(true);
    controller.click('ws-ux-compact', element({}));
    expect(state.inc?.ws.compact).toBe(false);
    expect(JSON.parse(storage.data.get(PREFS_KEY) ?? '{}')).toMatchObject({ compact: true });
    vi.advanceTimersByTime(400);
    expect(JSON.parse(storage.data.get(PREFS_KEY) ?? '{}')).toMatchObject({
      tab: 'traceability',
      subs: { traceability: 'http' },
      compact: false,
      stepper: true,
      sizes: { 'primary-details': 0.6 },
      panes: { evidence: 'min' },
    });
    // Un stockage qui refuse tout : la page fonctionne sans.
    const refusing: PrefsStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const other = stateOf(page('overview'), {});
    const second = setup(other, {}, refusing);
    second.controller.receive(incident, false);
    second.controller.click('ws-ux-compact', element({}));
    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
    expect(other.inc?.ws.compact).toBe(true);
  });

  it('a selection in the graph reveals its code in the editor and reopens a collapsed details pane', () => {
    const incident = real();
    const state = stateOf(page('traceability'), {
      incident,
      ws: wsOf(incident, { split: { ...emptyWorkspaceUi().split, panes: { details: 'min' } } }),
    });
    const { controller } = setup(state, {
      source: () => new Promise(() => undefined),
      sourceTree: () => new Promise(() => undefined),
    });
    controller.click('ws-select', inside({ kind: 'request', ref: REQUEST }, '[data-ws-graph]'));
    const ws = state.inc?.ws;
    expect(ws?.split.panes.details).toBeUndefined();
    expect(ws?.code.tabs.length).toBeGreaterThan(0);
    // Hors du graphe, un panneau réduit le reste.
    const other = stateOf(page('traceability'), {
      incident,
      ws: wsOf(incident, { split: { ...emptyWorkspaceUi().split, panes: { details: 'min' } } }),
    });
    setup(other, { source: () => new Promise(() => undefined) }).controller.click(
      'ws-select',
      element({ kind: 'request', ref: REQUEST }),
    );
    expect(other.inc?.ws.split.panes.details).toBe('min');
  });

  it('entering a layer view with no open file shows the start file of the layer in the editor', () => {
    const incident = real();
    const state = stateOf(page('overview'), { incident, ws: wsOf(incident, { tree: demoSourceTree() }) });
    const { controller } = setup(state, { source: () => new Promise(() => undefined) });
    controller.click('ws-ux-tab', element({ tab: 'backend' }));
    const code = state.inc?.ws.code;
    expect(code?.tabs[code.active ?? 0]?.applicationId).toBe('catalog');
  });

  it('editor keys: Ctrl/Cmd+G opens « Aller à la ligne », Escape closes it; find field typed and Enter moves on', () => {
    const incident = real();
    const state = stateOf(page('code'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, {
      source: () => new Promise(() => undefined),
      sourceTree: () => new Promise(() => undefined),
    });
    const inEditor = inside({}, '[data-ws-pane="editor"]');
    expect(controller.keydown(keyOn(inEditor, 'g', { ctrlKey: true }))).toBe(true);
    expect(state.inc?.ws.code.gotoOpen).toBe(true);
    // Hors de l'éditeur, Ctrl+G est laissé au navigateur.
    expect(controller.keydown(keyOn(element({}), 'g', { ctrlKey: true }))).toBe(false);
    controller.input({ dataset: { wsField: 'code-goto' }, value: '12' } as unknown as HTMLInputElement);
    expect(state.inc?.ws.code.gotoDraft).toBe('12');
    expect(controller.keydown(keyOn(element({ wsField: 'code-goto' }), 'Escape'))).toBe(true);
    expect(state.inc?.ws.code.gotoOpen).toBe(false);
    controller.keydown(keyOn(inEditor, 'G', { metaKey: true }));
    expect(state.inc?.ws.code.gotoOpen).toBe(true);
    controller.input({ dataset: { wsField: 'code-find' }, value: 'create' } as unknown as HTMLInputElement);
    expect(state.inc?.ws.code.find).toBe('create');
    expect(controller.keydown(keyOn(element({ wsField: 'code-find' }), 'Enter'))).toBe(true);
    expect(controller.keydown(keyOn(element({ wsField: 'code-find' }), 'Enter', { shiftKey: true }))).toBe(
      true,
    );
  });
});

describe('investigation workspace — polling', () => {
  it('re-reads every 1.5 s while reproducing, repaints only on a new revision, stops on leaving', async () => {
    vi.useFakeTimers();
    const running = real({ state: 'REPRODUCING', revision: 7 });
    const answers = [running, running, real({ state: 'REPRODUCED', revision: 8 })];
    const get = vi.fn(() => Promise.resolve(answers.shift() ?? running));
    const state = stateOf(page('overview'));
    const { controller, api, paints } = setup(state, { get });
    await controller.load(api, state.route, () => true);
    expect(controller.polling).toBe(true);
    const before = paints();
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS);
    // Même révision : rien n'est redessiné (zoom, défilement, focus restent), le suivi continue.
    expect(get).toHaveBeenCalledTimes(2);
    expect(paints()).toBe(before);
    expect(controller.polling).toBe(true);
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS);
    expect(get).toHaveBeenCalledTimes(3);
    expect(paints()).toBe(before + 1);
    expect(state.inc?.incident?.revision).toBe(8);
    expect(controller.polling).toBe(false);

    // Une expérience en cours est suivie aussi ; quitter la page arrête le suivi.
    const experiment = running.investigation.experiments[0];
    if (!experiment) throw new Error('experiment expected');
    const busy = real({
      revision: 9,
      investigation: { ...running.investigation, experiments: [{ ...experiment, status: 'RUNNING' }] },
    });
    const again = vi.fn(() => Promise.resolve(busy));
    const state2 = stateOf(page('experiments'));
    const second = setup(state2, { get: again });
    await second.controller.load(second.api, state2.route, () => true);
    expect(second.controller.polling).toBe(true);
    second.controller.leave({ view: 'incidents', projectId: 'prj_books' });
    state2.route = { view: 'incidents', projectId: 'prj_books' };
    expect(second.controller.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS * 3);
    expect(again).toHaveBeenCalledTimes(1);
  });
});

describe('investigation workspace — demonstration', () => {
  it('opens without any server call; tree, files and report come from the demo module', async () => {
    const state = stateOf(page('backend', 'demo'));
    const { controller, api, calls } = setup(state);
    await controller.load(api, state.route, () => true);
    expect(calls).toEqual([]);
    const ws = state.inc?.ws;
    expect(ws?.demo).toBe(true);
    expect(state.inc?.incident?.projectId).toBe('demo');
    expect(ws?.tree?.applications.map((entry) => entry.applicationId)).toEqual(['front', 'bff', 'catalog']);
    expect(Object.values(ws?.sources ?? {}).some((entry) => entry.view)).toBe(true);
    expect(controller.polling).toBe(false);
    controller.click('ws-ux-tab', element({ tab: 'report' }));
    expect(state.inc?.ws.report?.limitations[0]).toContain('Données de démonstration');
    // Sélectionner une capture d'écran : rien n'est demandé, la capture n'est pas incluse.
    controller.click('ws-select', element({ kind: 'evidence', ref: 'rep_1:ev-screenshot-3' }));
    expect(calls).toEqual([]);
    expect(renderDashboard(state)).toContain(
      'La capture d’écran n’est pas incluse dans les données de démonstration.',
    );
  });

  it('every action that would change the incident is disabled with its reason, and refused if sent', async () => {
    const state = stateOf(page('overview', 'demo'), {}, role('PILOT'));
    const { controller, api, calls } = setup(state);
    await controller.load(api, state.route, () => true);
    const tabs = [
      'overview',
      'traceability',
      'code',
      'scope',
      'environment',
      'hypotheses',
      'experiments',
      'diagnosis',
      'report',
      'regression',
    ] as const;
    for (const tab of tabs) {
      state.route = page(tab, 'demo');
      const html = renderDashboard(state);
      expect(html).toContain('<p class="ws-demo" role="note"><b>Données de démonstration</b>');
      expect(html).toContain('id="ws-demo-why"');
      // Le bandeau est dit une fois (en-tête), jamais répété dans les panneaux.
      expect(html.match(/class="ws-demo"/g), tab).toHaveLength(1);
      for (const action of DEMO_DISABLED_ACTIONS)
        for (const match of html.matchAll(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`, 'g')))
          expect(match[0], `${tab}: ${action}`).toMatch(
            /^<button disabled title="Données de démonstration : action indisponible" aria-describedby="ws-demo-why"/,
          );
      for (const match of html.matchAll(/<button[^>]*type="submit"[^>]*>/g))
        expect(match[0], `${tab}: submit`).toMatch(/^<button disabled /);
    }
    // La cause de la démonstration reste « probable », jamais présentée comme confirmée.
    state.route = page('diagnosis', 'demo');
    const diagnosis = renderDashboard(state);
    expect(diagnosis).toContain('Cause probable');
    expect(diagnosis).not.toContain('Cause racine confirmée');
    // Même envoyées, les opérations ne partent pas.
    controller.click('ws-dx-analyze', element({}));
    controller.click('inc-reproduce', element({}));
    controller.click('ws-dx-regression', element({ op: 'run' }));
    controller.click('ws-ux-target-save', element({}));
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(state.inc?.notice).toBe('Données de démonstration : action indisponible');
  });

  it('the incidents list and the investigations list open the demonstration', async () => {
    const list = vi.fn(() => Promise.resolve([]));
    const state = stateOf({ view: 'investigations', projectId: 'prj_books' });
    const { controller, api } = setup(state, { list });
    await controller.load(api, state.route, () => true);
    const html = renderDashboard(state);
    expect(html).toContain('<h1>Investigations</h1>');
    expect(html).toContain('Aucune investigation pour l’instant');
    expect(html).toContain('data-action="inc-demo"');
    controller.click('inc-demo', element({}));
    expect(state.route).toEqual({ view: 'incident', projectId: 'prj_books', incidentId: 'demo' });
    const incidents = renderDashboard(stateOf({ view: 'incidents', projectId: 'prj_books' }, { list: [] }));
    expect(incidents).toContain('Voir la démonstration');
  });

  it('the investigations list shows the progress of each incident that is no longer a draft', async () => {
    const incident = real();
    const list = vi.fn(() =>
      Promise.resolve([
        {
          id: incident.id,
          title: incident.title,
          severity: incident.severity,
          state: incident.state,
          target: 'LOCAL' as const,
          createdAt: incident.createdAt,
          updatedAt: incident.updatedAt,
          diagnosis: 'PROBABLE' as const,
        },
        {
          id: 'inc_draft0000001',
          title: 'Brouillon',
          severity: 'LOW' as const,
          state: 'DRAFT' as const,
          target: 'LOCAL' as const,
          createdAt: incident.createdAt,
          updatedAt: incident.updatedAt,
        },
      ]),
    );
    const get = vi.fn(() => Promise.resolve(incident));
    const state = stateOf({ view: 'investigations', projectId: 'prj_books' });
    const { controller, api } = setup(state, { list, get });
    await controller.load(api, state.route, () => true);
    expect(get).toHaveBeenCalledTimes(1);
    const html = renderDashboard(state);
    expect(html).toContain(`data-action="inc-open" data-incident="${incident.id}"`);
    expect(html).not.toContain('inc_draft0000001');
    expect(html).toMatch(/aria-label="\d+ étape\(s\) sur 10"/);
  });
});

describe('investigation workspace — layout review fixes (focus, tablet, menus)', () => {
  /** Une racine qui note chaque élément focalisé ; `extra` : des éléments précis (activeElement, .main…). */
  function focusRoot(found: Record<string, unknown> = {}, active: unknown = null) {
    const focused: string[] = [];
    const root = {
      get activeElement() {
        return active;
      },
      querySelector: (selector: string) =>
        selector in found
          ? found[selector]
          : ['.inc-live', '.inc-msg', '.main', '.ws-root'].includes(selector)
            ? null
            : { focus: () => focused.push(selector), closest: () => null, disabled: false },
      querySelectorAll: () => [],
    } as unknown as ShadowRoot;
    return { root, focused };
  }

  function setupOn(state: DashboardState, root: ShadowRoot, storage?: PrefsStorage) {
    const host = {
      ...(storage ? { storage: () => storage } : {}),
      root,
      api: () => apiOf({}).api,
      paint: () => undefined,
      navigate: (route: DashboardRoute) => {
        state.route = route;
      },
      refresh: () => Promise.resolve(),
    };
    Object.defineProperty(host, 'state', { get: () => state });
    return new IncidentsController(host as unknown as IncidentsHost);
  }

  it('an experiment with side effects asks for approval with the focus on « Annuler », never on the danger button', () => {
    const incident = real();
    const experiment = incident.investigation.experiments[0];
    expect(experiment).toBeDefined();
    const state = stateOf(page('experiments'), { incident, ws: wsOf(incident) }, role('PILOT'));
    const { root, focused } = focusRoot();
    const controller = setupOn(state, root);
    controller.click('ws-dx-run', element({ experiment: experiment?.id ?? '', approval: 'required' }));
    expect(state.inc?.ws.dx.approving).toBe(experiment?.id);
    expect(focused).toEqual(['[data-action="ws-dx-approve-cancel"]']);
  });

  it('collapsing the tree from the explorer moves the focus to the pane button that reopens it, and back', () => {
    const incident = real();
    const state = stateOf(page('code'), { incident, ws: wsOf(incident) });
    const { root, focused } = focusRoot();
    const controller = setupOn(state, root);
    controller.click('ws-code-tree-toggle', element({}));
    expect(state.inc?.ws.split.panes.tree).toBe('min');
    expect(focused.at(-1)).toBe('[data-ws-pane="tree"] .ws-pane-ops [data-op="restore"]');
    controller.click('ws-code-tree-toggle', element({}));
    expect(state.inc?.ws.split.panes.tree).toBeUndefined();
    expect(focused.at(-1)).toBe('[data-ws-pane="tree"] [data-action="ws-code-tree-toggle"]');
  });

  it('a focus left in a hidden pane body goes to the restore button of that pane', () => {
    const incident = real();
    const state = stateOf(page('code'), { incident, ws: wsOf(incident) });
    const lost = {
      closest: (selector: string) =>
        selector === '[hidden]' ? {} : selector === '[data-ws-pane]' ? { dataset: { wsPane: 'tree' } } : null,
    };
    const { root, focused } = focusRoot({}, lost);
    setupOn(state, root).afterFocus();
    expect(focused).toEqual(['[data-ws-pane="tree"] .ws-pane-ops [data-op="restore"]']);
    // Un focus visible n'est pas déplacé.
    const shown = focusRoot({}, { closest: () => null });
    setupOn(state, shown.root).afterFocus();
    expect(shown.focused).toEqual([]);
  });

  it('Escape closes an open menu (« Couches ») first, focus on its summary, before anything else', () => {
    const incident = real();
    const state = stateOf(page('traceability'), {
      incident,
      ws: wsOf(incident, { selection: { kind: 'request', id: REQUEST } }),
    });
    const controller = setupOn(state, focusRoot().root);
    const summary = { focus: vi.fn() };
    const menu = { open: true, querySelector: () => summary };
    const target = {
      dataset: {},
      closest: (selector: string) => (selector === 'details[data-ws-menu][open]' ? menu : null),
    } as unknown as HTMLElement;
    expect(controller.keydown(keyOn(target, 'Escape'))).toBe(true);
    expect(menu.open).toBe(false);
    expect(summary.focus).toHaveBeenCalled();
    expect(state.inc?.ws.selection).toBeDefined();
  });

  it('on a tablet (720 to 900 px of workspace) the tree opens collapsed, a choice not saved until the person touches it', () => {
    vi.useFakeTimers();
    const incident = real();
    const storage = memoryStorage({ compact: false });
    const state = stateOf({ view: 'incident', projectId: 'prj_books', incidentId: incident.id }, {});
    const { root } = focusRoot({ '.main': { clientWidth: 800 } });
    const controller = setupOn(state, root, storage);
    controller.receive(incident, false);
    expect(state.inc?.ws.split.panes.tree).toBe('min');
    expect(state.inc?.ws.code.treeCollapsed).toBe(true);
    controller.click('ws-ux-compact', element({}));
    vi.advanceTimersByTime(400);
    const saved = JSON.parse(storage.data.get(PREFS_KEY) ?? '{}') as {
      panes?: object;
      treeCollapsed?: boolean;
    };
    expect(saved.treeCollapsed).toBe(false);
    expect(saved.panes).toEqual({});
    // La personne rouvre l'arborescence puis la réduit : ce choix-là est retenu.
    controller.click('ws-code-tree-toggle', element({}));
    controller.click('ws-code-tree-toggle', element({}));
    vi.advanceTimersByTime(400);
    expect(JSON.parse(storage.data.get(PREFS_KEY) ?? '{}')).toMatchObject({
      treeCollapsed: true,
      panes: { tree: 'min' },
    });
    // Sur un ordinateur (espace de 1 136 px), l'arborescence s'ouvre dépliée.
    const wide = stateOf({ view: 'incident', projectId: 'prj_books', incidentId: incident.id }, {});
    setupOn(wide, focusRoot({ '.main': { clientWidth: 1152 } }).root, memoryStorage()).receive(
      incident,
      false,
    );
    expect(wide.inc?.ws.split.panes.tree).toBeUndefined();
  });
});

describe('investigation workspace — mockup wiring (reproduction, connectivity, exports, attachments)', () => {
  /** Une racine qui garde des éléments précis (compteur, ancre de téléchargement) et note les focus. */
  function wiredRoot(ticking: { dataset: Record<string, string>; textContent: string }[] = []) {
    const focused: string[] = [];
    const clicks: string[] = [];
    const root = {
      activeElement: null,
      querySelector: (selector: string) =>
        selector === '.ws-root' ? {} : selector.includes('data-ws-ticking') ? (ticking[0] ?? null) : null,
      querySelectorAll: (selector: string) => (selector.includes('data-ws-ticking') ? ticking : []),
      appendChild: () => undefined,
      ownerDocument: {
        createElement: () => {
          const anchor = {
            href: '',
            download: '',
            click: () => clicks.push(anchor.download),
            remove: () => undefined,
          };
          return anchor;
        },
      },
    };
    return { root: root as unknown as ShadowRoot, focused, clicks };
  }

  function wired(
    state: DashboardState,
    incidents: Partial<QaCrawlerClient['incidents']> = {},
    options: { root?: ShadowRoot; environments?: Partial<QaCrawlerClient['environments']> } = {},
  ) {
    const calls: string[] = [];
    const spy = <T extends object>(target: Partial<T>): T =>
      new Proxy(target, {
        get(object, name: string) {
          calls.push(name);
          const value = (object as Record<string, unknown>)[name];
          return value ?? (() => Promise.reject(new Error(`unexpected call ${name}`)));
        },
      }) as T;
    const api = {
      incidents: spy(incidents),
      environments: spy(options.environments ?? {}),
    } as unknown as QaCrawlerClient;
    let paints = 0;
    const host = {
      root: options.root ?? fakeRoot,
      api: () => api,
      paint: () => {
        paints += 1;
      },
      navigate: (route: DashboardRoute) => {
        state.route = route;
      },
      refresh: () => Promise.resolve(),
    };
    Object.defineProperty(host, 'state', { get: () => state });
    const controller = new IncidentsController(host as unknown as IncidentsHost);
    return { controller, api, calls, paints: () => paints };
  }

  /** L'incident pendant une reproduction : la dernière du scénario est RUNNING avec son suivi en direct. */
  function reproducing(updatedAt: string, steps = 1): Incident {
    const base = real();
    const reference = base.investigation.reproductions[0];
    if (!reference) throw new Error('reproduction expected');
    const live = {
      ...reference,
      id: 'rep_live',
      status: 'RUNNING' as const,
      reproduced: null,
      startedAt: '2026-01-15T10:00:00.000Z',
      actions: [],
      requests: [],
      evidence: [],
      live: {
        total: 4,
        current: steps,
        updatedAt,
        steps: Array.from({ length: steps }, (_, at) => ({
          index: at + 1,
          kind: 'fill',
          description: `étape ${String(at + 1)}`,
          status: at + 1 === steps ? ('RUNNING' as const) : ('PASSED' as const),
          startedAt: '2026-01-15T10:00:01.000Z',
          ...(at + 1 === steps ? {} : { durationMs: 700 }),
        })),
      },
    };
    return real({
      state: 'REPRODUCING',
      revision: 30,
      investigation: { ...base.investigation, reproductions: [...base.investigation.reproductions, live] },
    });
  }

  it('a new live snapshot at the same revision repaints the run screen; an identical one does not', async () => {
    vi.useFakeTimers();
    const answers = [
      reproducing('2026-01-15T10:00:01.500Z', 1),
      reproducing('2026-01-15T10:00:02.500Z', 2),
      reproducing('2026-01-15T10:00:02.500Z', 2),
    ];
    const get = vi.fn(() => Promise.resolve(answers.shift() ?? reproducing('2026-01-15T10:00:02.500Z', 2)));
    const state = stateOf(page('run'));
    const { controller, api, paints } = wired(state, { get });
    await controller.load(api, state.route, () => true);
    expect(controller.polling).toBe(true);
    const before = paints();
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS);
    // Même révision, étape 2 commencée : redessiné.
    expect(paints()).toBe(before + 1);
    expect(state.inc?.incident?.investigation.reproductions.at(-1)?.live?.steps).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS);
    expect(paints()).toBe(before + 1);
    const html = renderDashboard(state);
    expect(html).toContain('data-ws-ticking="true"');
    expect(html).toContain('data-action="ws-repro-stop"');
    controller.leave({ view: 'incidents', projectId: 'prj_books' });
  });

  it('the elapsed counter is written every second without a repaint, and stops with no ticking element', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:01:05.000Z'));
    const counter = {
      dataset: { wsElapsedFrom: '2026-01-15T10:00:00.000Z', wsTicking: 'true' },
      textContent: '',
    };
    const ticking = [counter];
    const { root } = wiredRoot(ticking);
    const state = stateOf(page('run'), {
      incident: reproducing('2026-01-15T10:00:01.000Z'),
      ws: wsOf(real()),
    });
    const { controller, paints } = wired(state, {}, { root });
    controller.workspace.afterPaint();
    expect(controller.workspace.ticking).toBe(true);
    const before = paints();
    await vi.advanceTimersByTimeAsync(1000);
    expect(counter.textContent).toBe('00:01:06');
    await vi.advanceTimersByTimeAsync(2000);
    expect(counter.textContent).toBe('00:01:08');
    expect(paints()).toBe(before);
    ticking.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.workspace.ticking).toBe(false);
  });

  it('« Tester la connectivité » checks each known URL through the server and shows each result', async () => {
    const incident = real();
    const check = vi.fn(() =>
      Promise.resolve({
        ok: true,
        issues: [],
        secrets: {},
        url: { format: { ok: true }, reachable: { ok: true, status: 200, durationMs: 12 } },
      }),
    );
    const environments = [
      { id: 'env_demo', name: 'Recette', kind: 'TEST', baseUrl: 'http://localhost:4200' },
    ] as unknown as ProjectDetail['environments'];
    const state = stateOf(
      page('environment'),
      { incident, ws: wsOf(incident) },
      { project: { ...project, environments } },
    );
    const { controller } = wired(state, {}, { environments: { check } });
    controller.click('ws-ux-check', element({}));
    await vi.waitFor(() => {
      expect(state.inc?.ws.ux.checking).toBe(false);
    });
    expect(check).toHaveBeenCalledWith(
      'prj_books',
      { name: 'Recette', kind: 'TEST', baseUrl: 'http://localhost:4200' },
      { reach: true, selfId: 'env_demo' },
    );
    expect(state.inc?.ws.ux.connectivity?.environment).toMatchObject({
      url: 'http://localhost:4200',
      reachable: true,
      status: 200,
      durationMs: 12,
    });
    // L'environnement est passé à l'écran (encadré « Configuration sélectionnée ») au dessin suivant.
    controller.beforePaint();
    expect(state.inc?.ws.environment).toMatchObject({ id: 'env_demo', baseUrl: 'http://localhost:4200' });
    expect(renderDashboard(state)).toContain('http://localhost:4200');

    // Rien à tester (aucun environnement, aucune URL d'application) : la raison, sans appel.
    const bare = stateOf(page('environment'), { incident, ws: wsOf(incident) });
    const empty = wired(bare, {}, { environments: { check } });
    empty.controller.click('ws-ux-check', element({}));
    expect(bare.inc?.ws.ux.checkError).toContain('Aucune URL à tester');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('« Exporter » reads the report in the chosen format and sections and downloads it; 501 makes PDF unavailable', async () => {
    const incident = real();
    const { root, clicks } = wiredRoot();
    const report = vi.fn(
      (_p: string, _i: string, options?: { format?: string; sections?: readonly string[] }) =>
        options?.format === undefined
          ? Promise.resolve(demoReport())
          : options.format === 'pdf'
            ? Promise.reject(
                new QaCrawlerError({
                  status: 501,
                  code: 'PDF_UNAVAILABLE',
                  error: 'no headless browser on the server',
                }),
              )
            : Promise.resolve({ html: '<!doctype html><title>r</title>' }),
    );
    const state = stateOf(page('report'), { incident, ws: wsOf(incident) });
    const { controller } = wired(state, { report } as unknown as Partial<QaCrawlerClient['incidents']>, {
      root,
    });
    controller.click('ws-dx-export', element({ format: 'html', sections: 'summary,diagnosis,unknown' }));
    await vi.waitFor(() => {
      expect(clicks).toEqual([`incident-${incident.id}.html`]);
    });
    expect(report).toHaveBeenCalledWith('prj_books', incident.id, {
      format: 'html',
      sections: ['summary', 'diagnosis'],
    });
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    controller.click('ws-dx-export', element({ format: 'pdf', sections: 'summary' }));
    await vi.waitFor(() => {
      expect(state.inc?.ws.reportState.pdfUnavailable).toContain('no headless browser');
    });
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(clicks).toHaveLength(1);
    expect(state.inc?.ws.dx.errors.export).toBeUndefined();
    const html = renderDashboard(state);
    expect(html).toMatch(/data-format="pdf"[^>]*disabled/);
    // Un format inconnu ou aucune section : rien n'est demandé.
    controller.click('ws-dx-export', element({ format: 'docx', sections: 'summary' }));
    controller.click('ws-dx-export', element({ format: 'json', sections: '' }));
    expect(report.mock.calls.filter((call) => call[2]?.format !== undefined)).toHaveLength(2);
  });

  it('« Exécuter la vérification » runs the checked runnable verifications one by one; refused in the demo', async () => {
    const base = real();
    const experiment = base.investigation.experiments[0];
    if (!experiment) throw new Error('experiment expected');
    const planned = [
      { ...experiment, id: 'exp_a', status: 'PROPOSED' as const, sideEffects: false },
      { ...experiment, id: 'exp_b', status: 'PROPOSED' as const, sideEffects: false },
    ];
    const incident = real({ investigation: { ...base.investigation, experiments: planned } });
    const runExperiment = vi.fn((_p: string, _i: string, id: string) =>
      Promise.resolve(
        real({
          investigation: {
            ...incident.investigation,
            experiments: planned.map((entry) =>
              entry.id === id ? { ...entry, status: 'DONE' as const } : entry,
            ),
          },
        }),
      ),
    );
    const state = stateOf(page('diagnosis'), {
      incident,
      ws: wsOf(incident, { dx: { ...emptyWorkspaceUi().dx, checked: ['exp_a', 'exp_b'] } }),
    });
    const { controller } = wired(state, { runExperiment });
    controller.click('ws-dx-run-selected', element({ experiments: 'exp_a,exp_b,exp_unknown' }));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
      expect(runExperiment).toHaveBeenCalledTimes(2);
    });
    expect(runExperiment.mock.calls.map((call) => call[2])).toEqual(['exp_a', 'exp_b']);
    expect(state.inc?.ws.dx.checked).toEqual([]);
    expect(state.inc?.notice).toContain('2 vérification(s) exécutée(s)');

    const demo = stateOf(page('diagnosis', 'demo'));
    const second = wired(demo, { runExperiment });
    await second.controller.load(second.api, demo.route, () => true);
    second.controller.click('ws-dx-run-selected', element({ experiments: 'exp_a' }));
    expect(runExperiment).toHaveBeenCalledTimes(2);
  });

  it('the Playwright spec is read on its tab; a 400 is shown as unavailable with the server message', async () => {
    const incident = real();
    const regressionSpec = vi
      .fn()
      .mockRejectedValueOnce(
        new QaCrawlerError({ status: 400, code: 'INVALID', error: 'the target environment has no base URL' }),
      )
      .mockResolvedValueOnce({ language: 'typescript', code: "test('x', async () => {});\n" });
    const state = stateOf(page('regression'), { incident, ws: wsOf(incident) });
    const { controller, calls } = wired(state, { regressionSpec });
    controller.workspace.ensure();
    expect(calls).not.toContain('regressionSpec');
    controller.click('ws-dx-reg-tab', element({ tab: 'spec' }));
    await vi.waitFor(() => {
      expect(state.inc?.ws.regressionSpec).toEqual({ unavailable: 'the target environment has no base URL' });
    });
    expect(renderDashboard(state)).toContain('the target environment has no base URL');
    controller.click('ws-dx-reg-spec', element({}));
    await vi.waitFor(() => {
      expect(state.inc?.ws.regressionSpec?.code).toContain("test('x'");
    });
    // « Validé » seulement pour une proposition ACCEPTED (ici PROPOSED).
    expect(renderDashboard(state)).not.toContain('>Validé<');
  });

  it('« Reproduire », « Arrêter » (confirmed in the page) and the run tabs go through the server and the reducer', async () => {
    const incident = real({ state: 'REPRODUCED' });
    const reproduce = vi.fn(() => Promise.resolve(reproducing('2026-01-15T10:00:01.000Z')));
    const cancel = vi.fn(() => Promise.resolve(real({ state: 'CANCELLED' })));
    const state = stateOf(page('run'), { incident, ws: wsOf(incident) });
    const { controller } = wired(state, { reproduce, cancel, get: () => new Promise(() => undefined) });
    controller.click('ws-repro-start', element({}));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(reproduce).toHaveBeenCalledTimes(1);
    expect(state.inc?.incident?.state).toBe('REPRODUCING');
    controller.click('ws-repro-stop', element({}));
    expect(state.inc?.ws.repro.confirmStop).toBe(true);
    expect(renderDashboard(state)).toContain('data-action="ws-repro-stop-yes"');
    // Échap referme la confirmation.
    controller.keydown({
      key: 'Escape',
      target: element({}),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(state.inc?.ws.repro.confirmStop).toBe(false);
    controller.click('ws-repro-stop', element({}));
    controller.click('ws-repro-stop-yes', element({}));
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(state.inc?.ws.repro.confirmStop).toBe(false);
    // Les onglets du bas : clic et flèches (groupe run).
    controller.click('ws-repro-tab', element({ tab: 'http', group: 'run' }));
    expect(state.inc?.ws.repro.runTab).toBe('http');
    controller.keydown({
      key: 'Home',
      target: element({ action: 'ws-repro-tab', group: 'run', tab: 'http' }),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(state.inc?.ws.repro.runTab).toBe('shots');
    // « Voir les preuves associées » : la requête sélectionnée, Reproduction › Preuves ouvert.
    controller.click('ws-repro-ev-show', element({ kind: 'request', ref: REQUEST }));
    expect(state.route).toMatchObject({ tab: 'evidence' });
    expect(state.inc?.ws.selection).toEqual({ kind: 'request', id: REQUEST });
    expect(state.inc?.ws.repro.evidenceTab).toBe('http');
  });

  it('the graph layout follows « Disposition » and is kept in the preferences', () => {
    const incident = real();
    const saved: Record<string, string> = {};
    const storage: PrefsStorage = {
      getItem: (key) => saved[key] ?? null,
      setItem: (key, value) => {
        saved[key] = value;
      },
    };
    vi.useFakeTimers();
    const state = stateOf(page('traceability'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, {}, storage);
    controller.change({
      dataset: { action: 'ws-graph-layout' },
      value: 'lanes',
    } as unknown as HTMLSelectElement);
    expect(state.inc?.ws.graph.layout).toBe('lanes');
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(saved[PREFS_KEY] ?? '{}')).toMatchObject({ graphLayout: 'lanes' });
    // Une autre investigation repart avec la disposition retenue.
    const next = stateOf(page('traceability', 'inc_other00000001'));
    const second = setup(next, {}, storage);
    second.controller.receive(real({ id: 'inc_other00000001' }), false);
    expect(next.inc?.ws.graph.layout).toBe('lanes');
  });

  it('attachments: the preview reads the content, removal is confirmed in the page, adding sorts the files', async () => {
    const attachments = [
      {
        id: 'att_1',
        name: 'capture.png',
        type: 'image/png' as const,
        bytes: 241,
        addedAt: '2026-01-15T09:00:00.000Z',
        addedBy: 'ana',
      },
    ];
    const incident = real({ attachments });
    const attachment = vi.fn(() =>
      Promise.resolve({
        id: 'att_1',
        type: 'image/png' as const,
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      }),
    );
    const removeAttachment = vi.fn(() => Promise.resolve(real({ attachments: [] })));
    const addAttachment = vi.fn(() => Promise.resolve(real({ attachments })));
    const state = stateOf(page('overview'), { incident, ws: wsOf(incident) });
    const { controller } = wired(state, { attachment, removeAttachment, addAttachment });
    expect(renderDashboard(state)).toContain('Pièces jointes (1)');
    controller.click('ws-att-open', element({ ref: 'att_1' }));
    await vi.waitFor(() => {
      expect(state.inc?.ws.att.content.att_1?.dataUrl).toContain('data:image/png');
    });
    expect(renderDashboard(state)).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
    controller.click('ws-att-remove', element({ ref: 'att_1' }));
    expect(renderDashboard(state)).toContain('data-action="ws-att-remove-yes" data-ref="att_1"');
    controller.click('ws-att-remove-yes', element({ ref: 'att_1' }));
    await vi.waitFor(() => {
      expect(removeAttachment).toHaveBeenCalledWith('prj_books', incident.id, 'att_1');
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(state.inc?.ws.att.open).toBeUndefined();
    // L'ajout : un fichier refusé (type), un fichier envoyé.
    const file = (name: string, type: string, text: string) => ({
      name,
      type,
      size: text.length,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
    });
    const input = {
      dataset: { action: 'ws-att-add' },
      value: 'x',
      files: [
        file('notes.txt', 'text/plain', 'bonjour'),
        file('outil.exe', 'application/x-msdownload', 'MZ'),
      ],
    };
    controller.change(input as unknown as HTMLInputElement);
    await vi.waitFor(() => {
      expect(addAttachment).toHaveBeenCalledWith('prj_books', incident.id, {
        name: 'notes.txt',
        type: 'text/plain',
        dataBase64: btoa('bonjour'),
      });
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(input.value).toBe('');
    expect(state.inc?.ws.att.rejected).toEqual([{ name: 'outil.exe', reason: 'type' }]);
  });
});
