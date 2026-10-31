import { describe, expect, it } from 'vitest';
import type {
  GraphEdge,
  GraphNode,
  Incident,
  InvestigationGraph,
  ReproductionRun,
  SourceLocation,
} from '../../src/sdk/core/incident-contracts.js';
import {
  displayStatus,
  emptyGraphUi,
  fitScale,
  errorPath,
  graphKeyAction,
  graphLayout2,
  graphScalePercent,
  graphViewBox,
  groupOf,
  INCIDENT_GRAPH_CSS,
  NODE_H,
  READABLE_GRAPH_SCALE,
  reduceGraph,
  renderGraph,
  renderGraphDetail,
  renderRelationsTable,
  truncate,
  visibleGraph,
  type GraphUi,
} from '../../src/sdk/ui/incident-graph.js';
import { edgeId, workspaceLinks, type WorkspaceSelection } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type Lang } from '../../src/sdk/ui/incident-parts.js';
import { esc } from '../../src/sdk/ui/view.js';

/**
 * LE GRAPHE FULL-STACK de l'espace d'investigation, sur l'incident fictif du catalogue : POST /api/books →
 * 500, BFF (BookController, BookService, CatalogClient), appel HTTP vers le backend (CatalogBookController,
 * CatalogBookService), dépôt PublisherRepository, NullPointerException nommée par la réponse. Disposition
 * déterministe, chemin d'erreur, zoom et déplacement purs, couches masquées, sélection, détail, tableau.
 */
const at = '2026-10-30T09:00:00.000Z';
const FRONT = 'frontend/src/books';
const BFF = 'src/main/java/org/example/bff/books';
const CATALOG = 'src/main/java/org/example/catalog/books';

const src = (
  applicationId: string,
  layer: SourceLocation['layer'],
  file: string,
  line: number,
  name: string,
): SourceLocation => ({ applicationId, layer, file, line, symbolId: `${applicationId}:${file}#${name}` });

function codeNode(
  kind: GraphNode['kind'],
  layer: 'FRONTEND' | 'BFF' | 'BACKEND',
  applicationId: string,
  file: string,
  name: string,
  line: number,
  label = name,
): GraphNode {
  const source = src(applicationId, layer, file, line, name);
  return {
    id: `code:${source.symbolId ?? ''}`,
    kind,
    label,
    layer,
    evidence: [source.symbolId ?? ''],
    symbolId: source.symbolId,
    file,
    line,
    source,
  };
}

const N = {
  incident: { id: 'incident:inc_1', kind: 'INCIDENT', label: 'Erreur 500', layer: 'UNKNOWN', evidence: [] },
  scenario: {
    id: 'scenario:creer-livre',
    kind: 'SCENARIO',
    label: 'creer-livre',
    layer: 'UNKNOWN',
    evidence: ['rep_1'],
  },
  action: {
    id: 'action:rep_1:3',
    kind: 'ACTION',
    label: '3. click "Enregistrer"',
    layer: 'FRONTEND',
    evidence: ['rep_1:ev-action-3', 'rep_1:req-3-1'],
  },
  request: {
    id: 'request:rep_1:req-3-1',
    kind: 'REQUEST',
    label: 'POST /api/books → 500',
    layer: 'NETWORK',
    evidence: ['rep_1:req-3-1'],
  },
  drafts: {
    id: 'request:rep_1:req-3-2',
    kind: 'REQUEST',
    label: 'DELETE /api/drafts/7 → 404',
    layer: 'NETWORK',
    evidence: ['rep_1:req-3-2'],
  },
  front: codeNode('FRONTEND_CODE', 'FRONTEND', 'front', `${FRONT}/books-api.ts`, 'createBook', 8),
  controller: codeNode(
    'BFF_ENDPOINT',
    'BFF',
    'bff',
    `${BFF}/BookController.java`,
    'BookController.create',
    24,
    'POST /api/books (BookController.create)',
  ),
  service: codeNode('BFF_SERVICE', 'BFF', 'bff', `${BFF}/BookService.java`, 'BookService.create', 19),
  client: codeNode('BFF_SERVICE', 'BFF', 'bff', `${BFF}/CatalogClient.java`, 'CatalogClient.register', 27),
  outgoing: {
    id: `outgoing:bff:${BFF}/CatalogClient.java#CatalogClient.register:28`,
    kind: 'BACKEND_CALL',
    label: 'POST /catalog/books',
    layer: 'BFF',
    evidence: [`bff:${BFF}/CatalogClient.java#CatalogClient.register`],
    symbolId: `bff:${BFF}/CatalogClient.java#CatalogClient.register`,
    file: `${BFF}/CatalogClient.java`,
    line: 28,
    source: src('bff', 'BFF', `${BFF}/CatalogClient.java`, 28, 'CatalogClient.register'),
  },
  thrown: {
    ...codeNode('EXCEPTION', 'BFF', 'bff', `${BFF}/CatalogClient.java`, 'CatalogUnavailableException', 33),
    id: `exception:code:bff:${BFF}/CatalogClient.java#CatalogUnavailableException`,
  },
  catalogController: codeNode(
    'BACKEND_ENDPOINT',
    'BACKEND',
    'catalog',
    `${CATALOG}/CatalogBookController.java`,
    'CatalogBookController.register',
    22,
    'POST /catalog/books (CatalogBookController.register)',
  ),
  catalogService: codeNode(
    'BACKEND_SERVICE',
    'BACKEND',
    'catalog',
    `${CATALOG}/CatalogBookService.java`,
    'CatalogBookService.register',
    31,
  ),
  repository: codeNode(
    'REPOSITORY',
    'BACKEND',
    'catalog',
    `${CATALOG}/PublisherRepository.java`,
    'PublisherRepository',
    6,
    'PublisherRepository · Publisher · table publishers',
  ),
  npe: {
    id: 'exception:observed:rep_1:req-3-1:NullPointerException',
    kind: 'EXCEPTION',
    label: 'java.lang.NullPointerException',
    layer: 'BACKEND',
    evidence: ['rep_1:req-3-1'],
  },
  missing: {
    id: 'unknown:rep_1:req-3-2:endpoint',
    kind: 'BFF_ENDPOINT',
    label: '? DELETE /api/drafts/7',
    layer: 'UNKNOWN',
    evidence: ['rep_1:req-3-2'],
  },
} satisfies Record<string, GraphNode>;

const e = (
  from: GraphNode,
  to: GraphNode | string,
  status: GraphEdge['status'],
  reason: string,
  evidence: string[] = [],
): GraphEdge => ({ from: from.id, to: typeof to === 'string' ? to : to.id, status, reason, evidence });

function catalogueGraph(): InvestigationGraph {
  return {
    nodes: Object.values(N).map((node) => ({ ...node, evidence: [...node.evidence] })),
    edges: [
      e(N.incident, N.scenario, 'OBSERVED', 'la reproduction rep_1 a montré le symptôme', ['rep_1']),
      e(N.scenario, N.action, 'OBSERVED', 'étape 3 exécutée', ['rep_1:ev-action-3']),
      e(N.action, N.request, 'OBSERVED', 'envoyée pendant la fenêtre réseau de l’étape 3', ['rep_1:req-3-1']),
      e(N.action, N.drafts, 'OBSERVED', 'envoyée pendant la fenêtre réseau de l’étape 3', ['rep_1:req-3-2']),
      e(N.front, N.request, 'STATICALLY_RESOLVED', `${FRONT}/books-api.ts:9 appelle POST /api/books`, [
        N.front.symbolId ?? '',
        'rep_1:req-3-1',
      ]),
      e(N.request, N.controller, 'STATICALLY_RESOLVED', 'POST /api/books (bff) correspond', [
        'rep_1:req-3-1',
      ]),
      e(N.controller, N.service, 'STATICALLY_RESOLVED', 'BookController.java:25 bookService.create(request)'),
      e(N.service, N.client, 'STATICALLY_RESOLVED', 'BookService.java:21 catalogClient.register(body)'),
      e(N.client, N.outgoing, 'INFERRED', 'CatalogClient.java:28 envoie une requête HTTP (INFERRED)'),
      e(N.client, N.thrown, 'STATICALLY_RESOLVED', 'CatalogClient.java:33 lève CatalogUnavailableException'),
      e(N.outgoing, N.catalogController, 'INFERRED', 'URL de base lue via @Value ; le corps cite ce chemin', [
        'rep_1:req-3-1',
      ]),
      e(N.catalogController, N.catalogService, 'STATICALLY_RESOLVED', 'service.register(body)'),
      e(N.catalogService, N.repository, 'INFERRED', 'publisherRepository.findById(…)'),
      e(N.request, N.npe, 'OBSERVED', 'le corps de la réponse (500) nomme java.lang.NullPointerException', [
        'rep_1:req-3-1',
      ]),
      e(N.catalogService, N.npe, 'INFERRED', 'déréférence CatalogBook.getPublisher().getName()', [
        'rep_1:req-3-1',
      ]),
      e(
        N.drafts,
        N.missing,
        'UNKNOWN',
        'aucun endpoint du code BFF/backend inspecté ne sert DELETE /api/drafts/7',
        ['rep_1:req-3-2'],
      ),
    ],
  };
}

function reproductionOf(requests?: ReproductionRun['requests']): ReproductionRun {
  return {
    id: 'rep_1',
    startedAt: at,
    status: 'COMPLETED',
    target: 'LOCAL',
    scenario: 'creer-livre',
    reproduced: true,
    actions: [
      {
        index: 3,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        durationMs: 800,
        requestIds: ['rep_1:req-3-1', 'rep_1:req-3-2'],
      },
    ],
    requests: requests ?? [
      {
        id: 'rep_1:req-3-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 500,
        durationMs: 80,
        resourceType: 'fetch',
        step: 3,
        correlation: 'OBSERVED',
      },
      {
        id: 'rep_1:req-3-2',
        method: 'DELETE',
        url: '/api/drafts/7',
        path: '/api/drafts/7',
        status: 404,
        durationMs: 12,
        resourceType: 'fetch',
        step: 3,
        correlation: 'OBSERVED',
      },
    ],
    evidence: [
      {
        id: 'rep_1:ev-action-3',
        kind: 'ACTION',
        summary: 'étape 3',
        source: { reproduction: 'rep_1', step: 3 },
      },
    ],
    screenshots: [],
  };
}

function incidentOf(graph: InvestigationGraph | null = catalogueGraph(), run = reproductionOf()): Incident {
  return {
    id: 'inc_1',
    projectId: 'prj_books',
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après Enregistrer, une erreur HTTP 500 apparaît.',
    observed: 'erreur HTTP 500',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'creer-livre',
    execution: { target: 'LOCAL' },
    scope: {
      mode: 'GUIDED',
      applications: [],
      scenarios: ['creer-livre'],
      steps: [],
      endpoints: [],
      depth: 3,
      allowedHosts: [],
      logRoots: [],
      allowedCommands: [],
      permissions: {
        readSources: true,
        navigate: true,
        httpRequests: 'NONE',
        runTests: 'NONE',
        localCommands: false,
        readLogs: false,
        openshift: 'NONE',
        sideEffects: false,
      },
      limits: { maxFiles: 10, maxFileBytes: 1000, maxDurationMs: 1000, maxRequests: 10, maxExperiments: 1 },
      extensions: [],
    },
    state: 'REPRODUCED',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: 'analyste',
    history: [],
    investigation: { reproductions: [run], hypotheses: [], experiments: [], ...(graph ? { graph } : {}) },
  };
}

function ctxOf(
  options: { incident?: Incident; selection?: WorkspaceSelection; lang?: Lang } = {},
): ReturnType<typeof workspaceContext> {
  const incident = options.incident ?? incidentOf();
  return workspaceContext({
    incident,
    lang: options.lang ?? 'fr',
    ...(options.selection ? { selection: options.selection } : {}),
    links: workspaceLinks(incident),
    demo: false,
    can: () => true,
  });
}

/** Le `<g>` d'un nœud ou d'une relation dans le SVG (balise ouvrante). */
const tagOf = (html: string, kind: 'node' | 'edge', ref: string): string => {
  const marker = `data-kind="${kind}" data-ref="${esc(ref)}"`;
  const index = html.indexOf(marker);
  if (index < 0) return '';
  const start = html.lastIndexOf('<g ', index);
  return html.slice(start, html.indexOf('>', index) + 1);
};
const svgOf = (html: string): string => html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));

/** La liste des mots proscrits, écrite à l'envers pour ne pas les citer dans le dépôt. */
const FORBIDDEN = new RegExp(
  [
    'b\\?sehc]aâ[t',
    'uqilppa',
    'rtlif',
    'esirpertne',
    'tnemengiesner',
    'sussecorp',
    'nioseb',
    'elbasnopser',
    'reilucitrap',
    'relliesnoc',
    'e]eé[nnodrooc',
    'uorrev',
    'essiac',
    ')noi!?(tisnart',
    'b\\iuob\\',
    'elaicos nosiar',
    'elbalbmes',
    'reitém élc',
  ]
    .map((word) => Array.from(word).reverse().join(''))
    .join('|'),
  'i',
);

describe('incident graph — layout', () => {
  it('lays out Frontend → HTTP → BFF → HTTP → Backend → data in columns, deterministically', () => {
    const graph = catalogueGraph();
    const first = graphLayout2(graph);
    expect(graphLayout2(catalogueGraph())).toEqual(first);
    const x = (id: string) => first.nodes.find((laid) => laid.node.id === id)?.x ?? -1;
    const order = [
      N.incident.id,
      N.action.id,
      N.front.id,
      N.request.id,
      N.controller.id,
      N.service.id,
      N.outgoing.id,
      N.catalogController.id,
      N.catalogService.id,
      N.repository.id,
    ].map(x);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    expect(first.bands.map((band) => band.key)).toEqual([
      'context',
      'frontend',
      'http',
      'bff',
      'http',
      'backend',
      'data',
    ]);
    // Exceptions : après le code de leur couche ; l'exception observée (backend) avec les données.
    expect(x(N.thrown.id)).toBe(x(N.outgoing.id));
    expect(x(N.npe.id)).toBe(x(N.repository.id));
    // Aucun chevauchement dans une colonne.
    const byColumn = new Map<number, number[]>();
    for (const laid of first.nodes) byColumn.set(laid.x, [...(byColumn.get(laid.x) ?? []), laid.y]);
    for (const ys of byColumn.values()) {
      const sorted = [...ys].sort((a, b) => a - b);
      sorted.slice(1).forEach((y, index) => {
        expect(y - (sorted[index] ?? 0)).toBeGreaterThanOrEqual(NODE_H);
      });
    }
    expect(first.edges).toHaveLength(graph.edges.length);
    expect(first.dangling).toBe(0);
    expect(first.edges.every((laid) => laid.d.startsWith('M'))).toBe(true);
  });

  it('removes empty columns and counts relations towards a missing node', () => {
    const layout = graphLayout2({
      nodes: [N.incident, N.request],
      edges: [
        e(N.incident, N.request, 'OBSERVED', 'vue', ['rep_1:req-3-1']),
        e(N.request, 'code:absent', 'UNKNOWN', '?'),
      ],
    });
    expect(new Set(layout.nodes.map((laid) => laid.x)).size).toBe(2);
    expect(layout.width).toBeLessThan(500);
    expect(layout.dangling).toBe(1);
    expect(layout.bands.map((band) => band.key)).toEqual(['context', 'http']);
  });

  it('groups nodes by display layer', () => {
    expect(groupOf(N.request)).toBe('HTTP');
    expect(groupOf(N.outgoing)).toBe('BFF');
    expect(groupOf(N.repository)).toBe('DATA');
    expect(groupOf(N.npe)).toBe('BACKEND');
    expect(groupOf(N.missing)).toBe('BFF');
    expect(groupOf({ kind: 'EXCEPTION', layer: 'UNKNOWN' })).toBe('HTTP');
  });

  it('never shows an OBSERVED relation between two code nodes', () => {
    const graph = catalogueGraph();
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const forged = e(N.controller, N.service, 'OBSERVED', 'donnée incohérente');
    expect(displayStatus(forged, nodes)).toBe('STATICALLY_RESOLVED');
    expect(displayStatus(e(N.request, N.npe, 'OBSERVED', 'corps'), nodes)).toBe('OBSERVED');
    expect(displayStatus(e(N.action, N.request, 'OBSERVED', 'fenêtre'), nodes)).toBe('OBSERVED');
    const tampered = catalogueGraph();
    tampered.edges = tampered.edges.map((item) =>
      item.from === N.controller.id && item.to === N.service.id ? { ...item, status: 'OBSERVED' } : item,
    );
    const layout = graphLayout2(tampered);
    const codeToCode = layout.edges.filter(
      (laid) => laid.edge.from.startsWith('code:') && laid.edge.to.startsWith('code:'),
    );
    expect(codeToCode.length).toBeGreaterThan(3);
    expect(codeToCode.every((laid) => laid.status !== 'OBSERVED')).toBe(true);
    const ctx = ctxOf({
      incident: incidentOf(tampered),
      selection: { kind: 'edge', id: edgeId(N.controller.id, N.service.id) },
    });
    const html = renderGraph(ctx, emptyGraphUi());
    expect(tagOf(html, 'edge', edgeId(N.controller.id, N.service.id))).toContain('ws-ge-statically_resolved');
    expect(renderGraphDetail(ctx)).toContain('enregistrée comme observée');
    // 5 relations observées dans les données d'origine : la relation falsifiée n'en ajoute pas une sixième.
    expect(renderRelationsTable(ctx).match(/ws-rel ws-rel-observed/g)).toHaveLength(5);
  });
});

describe('incident graph — error path', () => {
  it('follows the failing request through the BFF and the backend down to the observed exception', () => {
    const path = errorPath(catalogueGraph(), reproductionOf());
    expect(path.requests).toEqual(['rep_1:req-3-1']);
    expect(path.nodes).toEqual([
      N.request.id,
      N.controller.id,
      N.service.id,
      N.client.id,
      N.outgoing.id,
      N.catalogController.id,
      N.catalogService.id,
      N.npe.id,
    ]);
    expect(path.edges[0]).toBe(edgeId(N.request.id, N.controller.id));
    expect(path.edges.at(-1)).toBe(edgeId(N.catalogService.id, N.npe.id));
    expect(path.edges).toHaveLength(path.nodes.length - 1);
    // La 404 n'est pas une requête en échec ; la relation UNKNOWN n'est jamais suivie.
    expect(path.nodes).not.toContain(N.drafts.id);
    expect(path.nodes).not.toContain(N.missing.id);
  });

  it('stops at the deepest backend node without exception, survives cycles, and needs a failing request', () => {
    const graph = catalogueGraph();
    graph.nodes = graph.nodes.filter((node) => node.kind !== 'EXCEPTION');
    graph.edges.push(e(N.catalogService, N.catalogController, 'STATICALLY_RESOLVED', 'rappel récursif'));
    const path = errorPath(graph, reproductionOf());
    expect(path.nodes.at(-1)).toBe(N.repository.id);
    expect(errorPath(catalogueGraph(), undefined)).toEqual({ requests: [], nodes: [], edges: [] });
    const fine = reproductionOf([
      {
        id: 'rep_1:req-3-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 201,
        resourceType: 'fetch',
        correlation: 'OBSERVED',
      },
    ]);
    expect(errorPath(catalogueGraph(), fine).nodes).toEqual([]);
    const network = reproductionOf([
      {
        id: 'rep_1:req-3-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        failure: 'net::ERR_CONNECTION_REFUSED',
        resourceType: 'fetch',
        correlation: 'OBSERVED',
      },
    ]);
    expect(errorPath(catalogueGraph(), network).nodes.at(-1)).toBe(N.npe.id);
  });

  it('draws the error path thicker and says what it is', () => {
    const html = renderGraph(ctxOf(), { ...emptyGraphUi(), errorPath: true });
    expect(html).toContain('ws-graph-errmode');
    expect(tagOf(html, 'edge', edgeId(N.request.id, N.controller.id))).toContain('ws-graph-onpath');
    expect(tagOf(html, 'edge', edgeId(N.catalogService.id, N.npe.id))).toContain('ws-graph-onpath');
    expect(tagOf(html, 'edge', edgeId(N.request.id, N.npe.id))).not.toContain('ws-graph-onpath');
    expect(tagOf(html, 'node', N.npe.id)).toContain('ws-graph-onpath');
    expect(html).toContain(
      'Chemin d’erreur : de « POST /api/books → 500 » à « java.lang.NullPointerException »',
    );
    expect(html).toContain('relations statiques');
    expect(html).toMatch(/data-action="ws-graph-errors" aria-pressed="true"/);
    const none = renderGraph(ctxOf({ incident: incidentOf(catalogueGraph(), reproductionOf([])) }), {
      ...emptyGraphUi(),
      errorPath: true,
    });
    expect(none).toContain('Aucune requête en échec');
    expect(renderGraph(ctxOf(), emptyGraphUi())).not.toContain('ws-graph-onpath');
  });
});

describe('incident graph — view reducer', () => {
  const size = { w: '2000', h: '1000' };

  it('zooms with the buttons and the wheel, within bounds', () => {
    const ui = emptyGraphUi();
    const zoomIn = reduceGraph(ui, 'ws-graph-zoom', { dir: 'in' });
    expect(zoomIn?.zoom).toBeCloseTo(1.25);
    expect(reduceGraph(ui, 'ws-graph-zoom', { dir: 'out' })?.zoom).toBeCloseTo(0.8);
    expect(reduceGraph(ui, 'ws-graph-zoom', { delta: '-100' })?.zoom).toBeGreaterThan(1);
    expect(reduceGraph(ui, 'ws-graph-zoom', { delta: '100' })?.zoom).toBeLessThan(1);
    let state: GraphUi = ui;
    for (let index = 0; index < 20; index += 1)
      state = reduceGraph(state, 'ws-graph-zoom', { dir: 'in' }) ?? state;
    expect(state.zoom).toBe(4);
    for (let index = 0; index < 40; index += 1)
      state = reduceGraph(state, 'ws-graph-zoom', { dir: 'out' }) ?? state;
    expect(state.zoom).toBe(0.5);
    expect(reduceGraph(state, 'ws-graph-zoom', { dir: 'out' })).toBe(state);
    expect(reduceGraph(ui, 'ws-graph-zoom', { delta: 'abc' })).toBe(ui);
  });

  it('keeps the point under the pointer in place when zooming at it', () => {
    const layout = { width: 2000, height: 1000 };
    const ui = emptyGraphUi();
    const before = graphViewBox(layout, ui);
    const pointX = before.x + 0.8 * before.width;
    const pointY = before.y + 0.25 * before.height;
    const next = reduceGraph(ui, 'ws-graph-zoom', { dir: 'in', fx: '0.8', fy: '0.25', ...size });
    if (!next) throw new Error('not handled');
    const after = graphViewBox(layout, next);
    expect(after.x + 0.8 * after.width).toBeCloseTo(pointX, 5);
    expect(after.y + 0.25 * after.height).toBeCloseTo(pointY, 5);
    expect(after.width).toBeCloseTo(before.width / 1.25, 5);
  });

  it('pans by content displacement, scaled by the zoom and bounded by the graph', () => {
    const ui: GraphUi = { ...emptyGraphUi(), zoom: 2 };
    const moved = reduceGraph(ui, 'ws-graph-pan', { dx: '100', dy: '-40' });
    expect(moved).toMatchObject({ offsetX: -50, offsetY: 20 });
    expect(reduceGraph(ui, 'ws-graph-pan', {})).toBe(ui);
    const far = reduceGraph(emptyGraphUi(), 'ws-graph-pan', { dx: '-99999', dy: '99999', ...size });
    expect(far).toMatchObject({ offsetX: 1000, offsetY: -500 });
    const view = graphViewBox({ width: 2000, height: 1000 }, { zoom: 1, offsetX: 50, offsetY: 0 });
    expect(view.x).toBeCloseTo(50);
    expect(graphViewBox({ width: 2000, height: 1000 }, { zoom: 2, offsetX: 0, offsetY: 0 }).width).toBe(1000);
    // Le cadre garde au moins 30 % de sa largeur en hauteur : zoomer agrandit sans écraser la vue.
    expect(graphViewBox({ width: 2000, height: 200 }, emptyGraphUi()).height).toBe(600);
  });

  it('fits, resets, toggles layers and the error path; ignores other actions', () => {
    const ui: GraphUi = { zoom: 2.5, offsetX: 30, offsetY: -12, hidden: ['BFF'], errorPath: true };
    expect(reduceGraph(ui, 'ws-graph-fit', {})).toEqual({ ...ui, zoom: 1, offsetX: 0, offsetY: 0 });
    expect(reduceGraph(ui, 'ws-graph-reset', {})).toEqual(emptyGraphUi());
    expect(reduceGraph(ui, 'ws-graph-layer', { layer: 'BFF' })?.hidden).toEqual([]);
    expect(reduceGraph(ui, 'ws-graph-layer', { layer: 'DATA' })?.hidden).toEqual(['BFF', 'DATA']);
    expect(reduceGraph(ui, 'ws-graph-layer', { layer: 'FRONTEND' })?.hidden).toEqual(['FRONTEND', 'BFF']);
    expect(reduceGraph(ui, 'ws-graph-layer', { layer: 'NOPE' })).toBe(ui);
    expect(reduceGraph(ui, 'ws-graph-errors', {})?.errorPath).toBe(false);
    expect(reduceGraph(ui, 'ws-select', { kind: 'node' })).toBeUndefined();
    expect(reduceGraph(ui, 'inc-tab', {})).toBeUndefined();
  });

  it('maps keyboard keys to the same pure actions', () => {
    expect(graphKeyAction('ArrowLeft')).toEqual({ action: 'ws-graph-pan', dataset: { dx: '60', dy: '0' } });
    expect(graphKeyAction('ArrowDown')).toEqual({ action: 'ws-graph-pan', dataset: { dx: '0', dy: '-60' } });
    expect(graphKeyAction('+')?.dataset).toEqual({ dir: 'in' });
    expect(graphKeyAction('-')?.dataset).toEqual({ dir: 'out' });
    expect(graphKeyAction('0')?.action).toBe('ws-graph-fit');
    expect(graphKeyAction('Enter')).toBeUndefined();
    const key = graphKeyAction('ArrowRight');
    expect(key && reduceGraph(emptyGraphUi(), key.action, key.dataset)?.offsetX).toBe(60);
  });

  it('keeps the view across a full repaint: the viewBox comes from the state', () => {
    const ui: GraphUi = { ...emptyGraphUi(), zoom: 2, offsetX: 40 };
    const html = renderGraph(ctxOf(), ui);
    const layout = graphLayout2(catalogueGraph());
    const view = graphViewBox(layout, ui);
    const round = (n: number) => String(Math.round(n * 10) / 10);
    expect(html).toContain(
      `viewBox="${round(view.x)} ${round(view.y)} ${round(view.width)} ${round(view.height)}"`,
    );
    // L'indicateur dit l'échelle réelle (pixels par unité du graphe), pas le facteur de zoom.
    expect(html).toContain(`>${String(Math.round(fitScale(layout.width) * 200))} %</span>`);
    expect(renderGraph(ctxOf(), ui)).toBe(html);
  });
});

describe('incident graph — real scale and readable minimum', () => {
  it('fits a small graph at 100 % at most and a large one never below the readable scale', () => {
    expect(READABLE_GRAPH_SCALE).toBeGreaterThanOrEqual(10 / 12);
    expect(fitScale(600)).toBe(1);
    expect(fitScale(1000)).toBeCloseTo(0.96);
    expect(fitScale(2152)).toBe(READABLE_GRAPH_SCALE);
    expect(fitScale(10_000)).toBe(READABLE_GRAPH_SCALE);
    expect(fitScale(0)).toBe(1);
  });

  it('gives the SVG a fixed pixel size: scale = pixel width / viewBox width = fit × zoom', () => {
    const layout = { width: 2152, height: 500 };
    const fit = graphViewBox(layout, emptyGraphUi());
    expect(fit.scale).toBe(READABLE_GRAPH_SCALE);
    expect(fit.width).toBe(2152);
    expect(fit.pixelWidth).toBe(Math.round(2152 * READABLE_GRAPH_SCALE));
    expect(fit.pixelHeight).toBe(Math.round(Math.max(500, 2152 * 0.3) * READABLE_GRAPH_SCALE));
    expect(graphScalePercent(fit)).toBe(85);
    // Au-dessus de la vue ajustée : le viewBox se resserre, le cadre garde sa taille.
    const zoomed = graphViewBox(layout, { zoom: 2, offsetX: 0, offsetY: 0 });
    expect(zoomed.pixelWidth).toBe(fit.pixelWidth);
    expect(zoomed.width).toBe(1076);
    expect(zoomed.pixelWidth / zoomed.width).toBeCloseTo(zoomed.scale, 2);
    expect(graphScalePercent(zoomed)).toBe(170);
    // En dessous : le cadre rétrécit (vue d'ensemble réduite), le viewBox reste le graphe entier.
    const reduced = graphViewBox(layout, { zoom: 0.5, offsetX: 0, offsetY: 0 });
    expect(reduced.width).toBe(2152);
    expect(reduced.pixelWidth).toBe(Math.round(fit.pixelWidth / 2));
    expect(reduced.pixelWidth / reduced.width).toBeCloseTo(reduced.scale, 2);
    expect(graphScalePercent(reduced)).toBe(43);
  });

  it('pans by the displayed pixels converted to frame units, below the fitted view too', () => {
    // Le contrôleur convertit : dx × data-w / largeur affichée du SVG ; le réducteur divise par le
    // grossissement du viewBox (1 sous la vue ajustée, où c'est le cadre qui rétrécit).
    const reduced: GraphUi = { ...emptyGraphUi(), zoom: 0.5 };
    expect(reduceGraph(reduced, 'ws-graph-pan', { dx: '100', dy: '0' })?.offsetX).toBe(-100);
    expect(
      reduceGraph(reduced, 'ws-graph-zoom', { dir: 'out', fx: '0.9', ...{ w: '2000', h: '1000' } }),
    ).toMatchObject({
      zoom: 0.5,
    });
    const shrink = reduceGraph({ ...emptyGraphUi(), zoom: 0.8 }, 'ws-graph-zoom', {
      dir: 'out',
      fx: '0.9',
      fy: '0.1',
      w: '2000',
      h: '1000',
    });
    // Sous la vue ajustée, le viewBox ne bouge pas : aucun glissement du centre.
    expect(shrink).toMatchObject({ offsetX: 0, offsetY: 0 });
  });

  it('renders the SVG at its pixel size in a scrolling frame, shows the real scale and the reduced-overview note', () => {
    const layout = graphLayout2(catalogueGraph());
    const fit = graphViewBox(layout, emptyGraphUi());
    const html = renderGraph(ctxOf(), emptyGraphUi());
    expect(html).toContain(
      `width="${String(fit.pixelWidth)}" height="${String(fit.pixelHeight)}" style="width:${String(fit.pixelWidth)}px;height:${String(fit.pixelHeight)}px"`,
    );
    expect(html).toContain(`>${String(graphScalePercent(fit))} %</span>`);
    expect(html).toContain('title="Échelle réelle : 100 % = 1 unité du graphe par pixel"');
    expect(html).toContain('class="ws-graph-canvas"');
    expect(html).not.toContain('Vue d’ensemble réduite');
    expect(html).toContain('>Ajuster</button>');
    const small = renderGraph(ctxOf(), { ...emptyGraphUi(), zoom: 0.5 });
    const pct = graphScalePercent(graphViewBox(layout, { zoom: 0.5, offsetX: 0, offsetY: 0 }));
    expect(small).toContain(`Vue d’ensemble réduite (${String(pct)} %) : sous 85 %`);
    expect(renderGraph(ctxOf({ lang: 'en' }), { ...emptyGraphUi(), zoom: 0.5 })).toContain(
      'Reduced overview',
    );
    // Le cadre défile au lieu de rétrécir le SVG ; le focus d'un nœud reste visible à toute échelle.
    expect(INCIDENT_GRAPH_CSS).toContain('.ws-graph-canvas{overflow:auto;');
    expect(INCIDENT_GRAPH_CSS).toMatch(/\.ws-graph-canvas\{[^}]*no-repeat local/);
    expect(INCIDENT_GRAPH_CSS).toMatch(/\.ws-graph-svg\{[^}]*max-width:none/);
    expect(INCIDENT_GRAPH_CSS).not.toMatch(/\.ws-graph-svg\{[^}]*width:100%/);
    expect(INCIDENT_GRAPH_CSS).toMatch(
      /\.ws-graph-node:focus-visible \.ws-graph-ring\{stroke:var\(--qa-color-primary\);stroke-width:2\.5;vector-effect:non-scaling-stroke\}/,
    );
    expect(INCIDENT_GRAPH_CSS).toMatch(
      /\.ws-graph-node:focus-visible \.ws-graph-box\{[^}]*vector-effect:non-scaling-stroke/,
    );
    expect(html).toContain('class="ws-graph-ring"');
  });

  it('has no live region recreated on each repaint (the workspace announces through its own zone)', () => {
    for (const ui of [emptyGraphUi(), { ...emptyGraphUi(), errorPath: true }]) {
      const html = renderGraph(ctxOf(), ui);
      expect(html).not.toContain('aria-live');
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('<output');
    }
    expect(renderGraph(ctxOf(), { ...emptyGraphUi(), errorPath: true })).toContain('ws-graph-pathnote');
  });
});

describe('incident graph — layers', () => {
  it('hides the nodes of a layer and every relation that touches them', () => {
    const graph = catalogueGraph();
    const visible = visibleGraph(graph, ['BFF']);
    const ids = visible.nodes.map((node) => node.id);
    for (const node of [N.controller, N.service, N.client, N.outgoing, N.thrown, N.missing])
      expect(ids).not.toContain(node.id);
    expect(ids).toContain(N.request.id);
    expect(ids).toContain(N.catalogService.id);
    expect(visible.edges.every((item) => ids.includes(item.from) && ids.includes(item.to))).toBe(true);
    expect(visibleGraph(graph, [])).toBe(graph);
    const data = visibleGraph(graph, ['DATA', 'FRONTEND']);
    expect(data.nodes.map((node) => node.id)).not.toContain(N.repository.id);
    expect(data.nodes.map((node) => node.id)).not.toContain(N.action.id);
    expect(data.nodes.map((node) => node.id)).toContain(N.incident.id);
  });

  it('renders the "Afficher :" chips and hides the restricted layers from the drawing', () => {
    const html = renderGraph(ctxOf(), { ...emptyGraphUi(), hidden: ['BFF'] });
    expect(html).toContain('Afficher :');
    expect(html).toMatch(/data-action="ws-graph-layer" data-layer="BFF" aria-pressed="false"/);
    expect(html).toMatch(/data-action="ws-graph-layer" data-layer="BACKEND" aria-pressed="true"/);
    const svg = svgOf(html);
    expect(tagOf(svg, 'node', N.controller.id)).toBe('');
    expect(tagOf(svg, 'edge', edgeId(N.request.id, N.controller.id))).toBe('');
    expect(tagOf(svg, 'node', N.catalogService.id)).not.toBe('');
    expect(html).toContain('6 nœud(s) masqué(s)');
    expect(svg).not.toContain('BFF Java');
    const all = renderGraph(ctxOf(), { ...emptyGraphUi(), hidden: ['FRONTEND', 'BFF', 'BACKEND', 'DATA'] });
    expect(all).toContain('ws-graph-layer');
    expect(tagOf(svgOf(all), 'node', N.request.id)).not.toBe('');
  });
});

describe('incident graph — rendering and selection', () => {
  it('renders focusable nodes, selectable edges, arrowheads per status, legend and controls', () => {
    const html = renderGraph(ctxOf(), emptyGraphUi());
    const node = tagOf(html, 'node', N.controller.id);
    expect(node).toContain('role="button"');
    expect(node).toContain('tabindex="-1"');
    expect(node).toContain('data-action="ws-select"');
    expect(node).toContain('aria-label="Endpoint BFF : POST /api/books (BookController.create)"');
    const edge = tagOf(html, 'edge', edgeId(N.client.id, N.outgoing.id));
    expect(edge).toContain('ws-ge-inferred');
    expect(edge).toContain('role="button"');
    expect(html).toContain('marker-end="url(#ws-g-m-inferred)"');
    for (const status of ['observed', 'statically_resolved', 'inferred', 'unknown'])
      expect(html).toContain(`id="ws-g-m-${status}"`);
    expect(html).toContain('class="ws-legend"');
    for (const action of ['ws-graph-zoom', 'ws-graph-fit', 'ws-graph-reset', 'ws-graph-errors'])
      expect(html).toContain(`data-action="${action}"`);
    expect(html).toContain('data-ws-graph="canvas"');
    expect(html).toMatch(/data-w="\d+" data-h="\d+"/);
    expect(html).toContain(
      '16 nœud(s), 16 relation(s) : 5 observée(s), 6 lue(s) dans le code, 4 déduite(s), 1 inconnue(s)',
    );
    // Libellé tronqué dans le nœud, complet dans <title>.
    expect(html).toContain('<title>Endpoint BFF · POST /api/books (BookController.create) · ');
    expect(html).toContain(`>${truncate('POST /api/books (BookController.create)', 21)}</text>`);
    expect(html).toContain('ws-graph-fail');
    expect(html).not.toContain('ws-selected');
    expect(html).not.toContain('ws-dimmed');
  });

  it('shows durations only for observed requests, never for code nodes', () => {
    const svg = svgOf(renderGraph(ctxOf(), emptyGraphUi()));
    expect(tagOf(svg, 'node', N.request.id)).not.toBe('');
    expect(svg).toContain('Requête HTTP · 80 ms');
    expect(svg).toContain('Requête HTTP · 12 ms');
    expect(svg.match(/\d+ ms/g)).toHaveLength(2);
    const detail = renderGraphDetail(ctxOf({ selection: { kind: 'node', id: N.catalogService.id } }));
    expect(detail).not.toMatch(/\d+ ms/);
    expect(detail).toContain('Aucune durée n’est mesurée');
  });

  it('highlights the selection and what is related, and dims the rest', () => {
    const html = renderGraph(ctxOf({ selection: { kind: 'node', id: N.service.id } }), emptyGraphUi());
    expect(tagOf(html, 'node', N.service.id)).toContain('ws-selected');
    expect(tagOf(html, 'node', N.service.id)).toContain('aria-pressed="true"');
    expect(tagOf(html, 'edge', edgeId(N.controller.id, N.service.id))).toContain('ws-related');
    expect(tagOf(html, 'node', N.controller.id)).toContain('ws-related');
    expect(tagOf(html, 'node', N.client.id)).toContain('ws-related');
    expect(tagOf(html, 'node', N.repository.id)).toContain('ws-dimmed');
    expect(tagOf(html, 'node', N.repository.id)).toContain('aria-pressed="false"');
    const byEdge = renderGraph(
      ctxOf({ selection: { kind: 'edge', id: edgeId(N.outgoing.id, N.catalogController.id) } }),
      emptyGraphUi(),
    );
    expect(tagOf(byEdge, 'edge', edgeId(N.outgoing.id, N.catalogController.id))).toContain('ws-selected');
    expect(tagOf(byEdge, 'node', N.outgoing.id)).toContain('ws-related');
    expect(tagOf(byEdge, 'node', N.catalogController.id)).toContain('ws-related');
    expect(tagOf(byEdge, 'node', N.front.id)).toContain('ws-dimmed');
    // Une requête sélectionnée ailleurs (vue Requêtes HTTP) éclaire son nœud.
    const byRequest = renderGraph(
      ctxOf({ selection: { kind: 'request', id: 'rep_1:req-3-1' } }),
      emptyGraphUi(),
    );
    expect(tagOf(byRequest, 'node', N.request.id)).toContain('ws-related');
  });

  it('shows an empty state without graph, and English texts', () => {
    const empty = renderGraph(ctxOf({ incident: incidentOf(null) }), emptyGraphUi());
    expect(empty).toContain('Le graphe apparaît après l’analyse');
    expect(empty).toContain('class="ws-legend"');
    expect(renderRelationsTable(ctxOf({ incident: incidentOf(null) }))).toContain('Aucune relation');
    const en = renderGraph(ctxOf({ lang: 'en' }), { ...emptyGraphUi(), errorPath: true });
    expect(en).toContain('Show:');
    expect(en).toContain('Error path:');
    expect(en).toContain('Spring Boot backend');
    expect(en).not.toContain('Afficher');
  });

  it('escapes every text coming from the data', () => {
    const graph = catalogueGraph();
    const evil = '<img src=x onerror="alert(1)">&\'';
    graph.nodes = graph.nodes.map((node) => (node.id === N.service.id ? { ...node, label: evil } : node));
    graph.edges = graph.edges.map((item) =>
      item.from === N.controller.id && item.to === N.service.id
        ? { ...item, reason: `<b>${evil}</b>` }
        : item,
    );
    const ctx = ctxOf({ incident: incidentOf(graph), selection: { kind: 'node', id: N.service.id } });
    const outputs = [
      renderGraph(ctx, emptyGraphUi()),
      renderGraphDetail(ctx),
      renderRelationsTable(ctx),
      renderGraphDetail(
        ctxOf({
          incident: incidentOf(graph),
          selection: { kind: 'edge', id: edgeId(N.controller.id, N.service.id) },
        }),
      ),
    ];
    for (const html of outputs) {
      expect(html).not.toContain('<img');
      expect(html).not.toContain('onerror="alert');
      expect(html).not.toContain('<b><');
      expect(html).toContain('&lt;img');
    }
  });

  it('uses no forbidden word and only theme tokens for colours', () => {
    expect(['Restreindre', 'transition', 'rapport'].some((word) => FORBIDDEN.test(word))).toBe(false);
    expect(String.fromCharCode(70, 105, 108, 116, 114, 101, 114)).toMatch(FORBIDDEN);
    for (const lang of ['fr', 'en'] as const) {
      const ctx = ctxOf({ lang, selection: { kind: 'node', id: N.controller.id } });
      const html = [
        renderGraph(ctx, { ...emptyGraphUi(), errorPath: true, hidden: ['DATA'] }),
        renderGraphDetail(ctx),
        renderRelationsTable(ctx),
        renderGraphDetail(ctxOf({ lang })),
      ].join('');
      expect(html.replace(/data-[a-z-]+="[^"]*"/g, '')).not.toMatch(FORBIDDEN);
    }
    expect(INCIDENT_GRAPH_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(/i);
    expect(INCIDENT_GRAPH_CSS).toContain('min-width:560px');
    expect(INCIDENT_GRAPH_CSS).toContain('width:100%');
  });
});

describe('incident graph — detail and relations table', () => {
  it('details a code node: kind, layer, file:line, "Voir le code", evidence, relations, static note', () => {
    const html = renderGraphDetail(ctxOf({ selection: { kind: 'node', id: N.controller.id } }));
    expect(html).toContain('Endpoint BFF');
    expect(html).toContain('<dd>BFF</dd>');
    expect(html).toContain(`${BFF}/BookController.java:24`);
    expect(html).toContain('data-action="ws-code"');
    expect(html).toContain('data-app="bff"');
    expect(html).toContain('data-line="24"');
    expect(html).toContain('Voir le code');
    expect(html).toContain('Lu dans le code : ce n’est pas une trace d’exécution');
    expect(html).toContain('class="ws-chips"');
    expect(html).toContain('data-kind="edge"');
    expect(html).toContain('ws-rel-statically_resolved');
    const repository = renderGraphDetail(ctxOf({ selection: { kind: 'node', id: N.repository.id } }));
    expect(repository).toContain('accès aux données');
    expect(repository).toContain('table publishers');
    const endLine = catalogueGraph();
    endLine.nodes = endLine.nodes.map((node) =>
      node.id === N.catalogService.id && node.source
        ? { ...node, source: { ...node.source, endLine: 40 } }
        : node,
    );
    expect(
      renderGraphDetail(
        ctxOf({ incident: incidentOf(endLine), selection: { kind: 'node', id: N.catalogService.id } }),
      ),
    ).toContain('lignes 31-40');
  });

  it('details an observed request with its status and duration, without code note', () => {
    const html = renderGraphDetail(ctxOf({ selection: { kind: 'node', id: N.request.id } }));
    expect(html).toContain('POST /api/books · 500 · 80 ms');
    expect(html).toContain('Vue pendant la reproduction');
    expect(html).not.toContain('Voir le code');
    expect(html).not.toContain('Lu dans le code : ce n’est pas');
  });

  it('details a relation with its status, reason, evidence, code and honest note', () => {
    const fixed = renderGraphDetail(
      ctxOf({ selection: { kind: 'edge', id: edgeId(N.controller.id, N.service.id) } }),
    );
    expect(fixed).toContain('ws-rel-statically_resolved');
    expect(fixed).toContain('BookController.java:25 bookService.create(request)');
    expect(fixed).toContain('Lu dans le code : ce n’est pas une trace d’exécution.');
    expect(fixed).toContain('data-action="ws-code"');
    expect(fixed).toContain('data-line="24"');
    expect(fixed).toContain(`data-kind="node" data-ref="${N.service.id}"`);
    const inferred = renderGraphDetail(
      ctxOf({ selection: { kind: 'edge', id: edgeId(N.catalogService.id, N.npe.id) } }),
    );
    expect(inferred).toContain('ws-rel-inferred');
    expect(inferred).toContain('Déduite du code, à vérifier : ce n’est pas une trace d’exécution.');
    expect(inferred).toContain('data-kind="request" data-ref="rep_1:req-3-1"');
    const observed = renderGraphDetail(
      ctxOf({ selection: { kind: 'edge', id: edgeId(N.request.id, N.npe.id) } }),
    );
    expect(observed).toContain('ws-rel-observed');
    expect(observed).toContain('Observée pendant la reproduction.');
    expect(observed).not.toContain('data-action="ws-code"');
    const unknown = renderGraphDetail(
      ctxOf({ selection: { kind: 'edge', id: edgeId(N.drafts.id, N.missing.id) } }),
    );
    expect(unknown).toContain('ws-rel-unknown');
    expect(unknown).toContain('Lien non établi');
  });

  it('invites to select when nothing is selected, and stays silent for other selections', () => {
    expect(renderGraphDetail(ctxOf())).toContain('Sélectionnez un nœud ou une relation');
    expect(renderGraphDetail(ctxOf({ selection: { kind: 'request', id: 'rep_1:req-3-1' } }))).toBe('');
    expect(renderGraphDetail(ctxOf({ selection: { kind: 'node', id: 'node:absent' } }))).toBe('');
  });

  it('lists every relation in a compact table with selectable rows and short evidence chips', () => {
    const graph = catalogueGraph();
    graph.edges.push({
      ...e(N.catalogService, 'code:absent', 'UNKNOWN', 'cible hors du périmètre'),
      evidence: ['rep_1:req-3-1', 'a:b#One', 'a:b#Two', 'a:b#Three', 'a:b#Four'],
    });
    const ctx = ctxOf({
      incident: incidentOf(graph),
      selection: { kind: 'edge', id: edgeId(N.request.id, N.controller.id) },
    });
    const html = renderRelationsTable(ctx);
    expect(html.startsWith('<div class="tw ws-graph-tw">')).toBe(true);
    expect(html).toContain('<caption class="sr">Relations du graphe</caption>');
    expect(html.match(/<tr class=/g)).toHaveLength(graph.edges.length);
    expect(html).toContain('ws-graph-reason');
    expect(html).toContain('title="cible hors du périmètre"');
    expect(html).toContain('nœud absent (code:absent)');
    expect(html).toContain('+2</span>');
    // Une référence qui ne désigne rien de sélectionnable : une puce non interactive.
    expect(html).toContain('>One</span>');
    expect(html).toContain(
      `aria-label="Sélectionner la relation POST /api/books → 500 → POST /api/books (BookController.create)"`,
    );
    expect(html).toMatch(/<tr class="ws-selected">/);
    for (const status of ['observed', 'statically_resolved', 'inferred', 'unknown'])
      expect(html).toContain(`ws-rel-${status}`);
    // Les colonnes « De » et « Vers » restent lisibles : pas de coupure lettre par lettre, largeur minimale.
    expect(INCIDENT_GRAPH_CSS).toContain(
      '.ws-graph-relbtn,.ws-graph-nodebtn{min-height:32px;overflow-wrap:break-word}',
    );
    expect(INCIDENT_GRAPH_CSS).not.toMatch(/nodebtn[^}]*anywhere/);
    expect(INCIDENT_GRAPH_CSS).toMatch(/\.ws-graph-tbl td:nth-child\(-n\+2\)\{min-width:148px\}/);
    expect(INCIDENT_GRAPH_CSS).toMatch(/\.ws-graph-reason\{[^}]*max-width:30ch/);
  });
});

describe('incident graph — keyboard: a single tab stop among the nodes', () => {
  const stops = (html: string): string[] =>
    [
      ...svgOf(html).matchAll(
        /<g class="ws-graph-node[^"]*" data-action="ws-select" data-kind="node" data-ref="([^"]+)"[^>]*tabindex="0"/g,
      ),
    ].map((match) => match[1] ?? '');

  it('puts tabindex=0 on the start of the error path when nothing is selected, -1 elsewhere', () => {
    const html = renderGraph(ctxOf(), emptyGraphUi());
    const path = errorPath(catalogueGraph(), reproductionOf());
    expect(stops(html)).toEqual([esc(path.nodes[0] ?? '')]);
    expect(svgOf(html).match(/class="ws-graph-node[^>]*tabindex="-1"/g)).toHaveLength(
      catalogueGraph().nodes.length - 1,
    );
    // Les relations restent hors de l'ordre de tabulation (le tableau des relations les sert au clavier).
    expect(svgOf(html)).not.toMatch(/class="ws-graph-edge[^>]*tabindex="0"/);
  });

  it('moves the tab stop to the selected node, and falls back to the first node without an error path', () => {
    const selected = renderGraph(
      ctxOf({ selection: { kind: 'node', id: N.catalogService.id } }),
      emptyGraphUi(),
    );
    expect(stops(selected)).toEqual([esc(N.catalogService.id)]);
    const noRun = renderGraph(
      ctxOf({
        incident: { ...incidentOf(), investigation: { ...incidentOf().investigation, reproductions: [] } },
      }),
      emptyGraphUi(),
    );
    expect(stops(noRun)).toEqual([esc(catalogueGraph().nodes[0]?.id ?? '')]);
    // Un nœud sélectionné mais masqué par « Afficher : » ne garde pas l'arrêt de tabulation.
    const hidden = renderGraph(ctxOf({ selection: { kind: 'node', id: N.controller.id } }), {
      ...emptyGraphUi(),
      hidden: ['BFF'],
    });
    expect(stops(hidden)).toHaveLength(1);
    expect(stops(hidden)).not.toContain(esc(N.controller.id));
  });
});
