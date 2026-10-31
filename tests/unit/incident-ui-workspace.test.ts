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
import { demoIncident, demoSource, demoSourceTree } from '../../src/sdk/ui/incident-demo.js';
import { edgeId, stepId } from '../../src/sdk/ui/incident-links.js';
import {
  DEMO_DISABLED_ACTIONS,
  emptyWorkspaceUi,
  renderContextPanel,
  STAGE_TABS,
  tabsOf,
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

function setup(state: DashboardState, incidents: Partial<QaCrawlerClient['incidents']> = {}) {
  const { api, calls } = apiOf(incidents);
  let paints = 0;
  const host = {
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
  it('fifteen tabs in the order of the investigation, with counts; each stage opens its tab', () => {
    const incident = real();
    const ctx = workspaceCtx(incident, wsOf(incident), 'fr', () => true);
    const tabs = tabsOf(ctx);
    expect(tabs.map((tab) => tab.key)).toEqual([...WORKSPACE_TABS]);
    expect(tabs.map((tab) => tab.label)).toEqual([
      'Vue d’ensemble',
      'Périmètre',
      'Environnement',
      'Chronologie',
      'Traçabilité',
      'Requêtes HTTP',
      'Frontend',
      'BFF',
      'Backend',
      'Journaux',
      'Hypothèses',
      'Expériences',
      'Diagnostic',
      'Rapport',
      'Non-régression',
    ]);
    expect(tabs.find((tab) => tab.key === 'timeline')?.count).toBe(incident.investigation.timeline?.length);
    expect(tabs.find((tab) => tab.key === 'scope')?.count).toBe(1);
    expect(STAGE_TABS).toMatchObject({
      description: 'overview',
      scope: 'scope',
      environment: 'environment',
      traceability: 'traceability',
      diagnosis: 'diagnosis',
      regression: 'regression',
    });
    for (const tab of Object.values(STAGE_TABS)) expect(WORKSPACE_TABS).toContain(tab);
  });

  it('a stage of the progress and a tab change the route on the spot, arrows rove between tabs', () => {
    const incident = real();
    const state = stateOf(page('overview'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, { capabilities: () => new Promise(() => undefined) });
    controller.click('ws-ux-stage', element({ stage: 'traceability' }));
    expect(state.route).toMatchObject({ view: 'incident', tab: 'traceability' });
    controller.click('ws-ux-tab', element({ tab: 'environment' }));
    expect(state.route).toMatchObject({ tab: 'environment' });
    const event = {
      key: 'ArrowRight',
      target: element({ action: 'ws-ux-tab', tab: 'environment' }),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    expect(controller.keydown(event)).toBe(true);
    expect(state.route).toMatchObject({ tab: 'timeline' });
    controller.keydown({
      key: 'End',
      target: element({ action: 'ws-ux-tab', tab: 'timeline' }),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(state.route).toMatchObject({ tab: 'regression' });
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
    // Le code de la sélection est ouvert dans l'onglet de sa couche, ancré sur la sélection.
    expect(ws?.code.open[0]?.anchor).toBe(`request:${REQUEST}`);
    await vi.waitFor(() => {
      expect(Object.values(state.inc?.ws.sources ?? {}).some((entry) => entry.view)).toBe(true);
    });
    expect(sourceTree).toHaveBeenCalledTimes(1);
    const html = renderDashboard(state);
    // Le graphe met en évidence les nœuds reliés à la requête ; le reste est atténué.
    expect(html).toMatch(/class="ws-graph-node ws-gk-request[^"]*ws-related"/);
    expect(html).toMatch(/class="ws-graph-node ws-gk-backend_service[^"]*ws-(related|dimmed)"/);
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

  it('a code link opens the file in the explorer of its layer; a new revision reads the file again', async () => {
    const incident = real();
    const source = vi.fn(() => Promise.resolve(serviceView()));
    const state = stateOf(page('requests'), { incident, ws: wsOf(incident) });
    const { controller } = setup(state, { source, sourceTree: () => Promise.resolve(demoSourceTree()) });
    controller.click('ws-code', element({ app: 'catalog', file: SERVICE_FILE, line: '18' }));
    expect(state.route).toMatchObject({ tab: 'backend' });
    expect(state.inc?.ws.code.open[0]).toMatchObject({
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
    expect(renderDashboard(state)).toContain('ws-code-sel');
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
  const zones = (html: string): string[] =>
    [...html.matchAll(/data-ws-zone="(main|graph|aside)"/g)].map((match) => match[1] ?? '');

  it('the graph band comes first (full width), below the content on code and form tabs, absent on Traçabilité', () => {
    const incident = real();
    const shell = (tab: (typeof WORKSPACE_TABS)[number]) =>
      renderDashboard(stateOf(page(tab), { incident, ws: wsOf(incident) }));
    const requests = shell('requests');
    expect(zones(requests)).toEqual(['graph', 'main', 'aside']);
    expect(requests).toMatch(/class="ws-ux-shell"/);
    for (const tab of ['frontend', 'bff', 'backend', 'scope', 'environment'] as const) {
      const html = shell(tab);
      expect(zones(html), tab).toEqual(['main', 'graph', 'aside']);
      expect(html, tab).toContain('class="ws-ux-shell ws-wide"');
    }
    const traceability = shell('traceability');
    expect(traceability).toContain('class="ws-ux-shell ws-nograph"');
    expect(zones(traceability)).toEqual(['main', 'aside']);
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

  it('the messages zone speaks once per new text, never on a repaint with the same text nor on the first paint', async () => {
    vi.useFakeTimers();
    const incident = real();
    const state = stateOf(page('overview'), { incident, ws: wsOf(incident) });
    let replaced = 0;
    const live = {
      textContent: 'Ancien message',
      isConnected: true,
      childNodes: [] as Node[],
      setAttribute: vi.fn(),
      replaceChildren: () => {
        replaced += 1;
      },
    };
    const root = {
      activeElement: null,
      querySelector: (selector: string) =>
        selector === '.inc-live' ? live : selector === '.ws-root' ? {} : null,
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
    controller.workspace.afterPaint();
    await vi.advanceTimersByTimeAsync(500);
    expect(replaced).toBe(0);
    expect(live.setAttribute).toHaveBeenCalledWith('aria-atomic', 'true');
    live.textContent = 'Reproduction terminée : Reproduit.';
    controller.workspace.afterPaint();
    await vi.advanceTimersByTimeAsync(500);
    expect(replaced).toBe(1);
    // Suivi, sélection, zoom : le même texte redessiné n'est pas répété.
    controller.workspace.afterPaint();
    controller.workspace.afterPaint();
    await vi.advanceTimersByTimeAsync(500);
    expect(replaced).toBe(1);
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
          updatedAt: incident.updatedAt,
          diagnosis: 'PROBABLE' as const,
        },
        {
          id: 'inc_draft0000001',
          title: 'Brouillon',
          severity: 'LOW' as const,
          state: 'DRAFT' as const,
          target: 'LOCAL' as const,
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
