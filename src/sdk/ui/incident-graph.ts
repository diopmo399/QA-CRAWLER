import type {
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  HttpExchange,
  InvestigationGraph,
  Layer,
  RelationStatus,
  ReproductionRun,
  SourceLocation,
} from '../core/incident-contracts.js';
import { incidentReproduction } from '../core/incident-contracts.js';
import { edgeId } from './incident-links.js';
import {
  evidenceChips,
  panelState,
  partsText,
  relationBadge,
  relationLegend,
  selectable,
  selectionClass,
  sourceLink,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { esc } from './view.js';

/**
 * LE GRAPHE FULL-STACK DE L'ESPACE D'INVESTIGATION : Frontend → HTTP → BFF Java → HTTP → Backend Spring
 * Boot → dépôts de données, en colonnes. Chaque relation garde son statut (trait plein, tirets,
 * pointillés, comme la légende) ; un parcours lu dans le code n'est jamais présenté comme une trace
 * d'exécution, et aucune durée n'est affichée pour un nœud du code (seules les requêtes observées en ont).
 *
 * La vue (zoom, décalage, couches affichées, chemin d'erreur) vit dans `GraphUi` : un redessin complet la
 * conserve. Les interactions passent par des `data-action` (`ws-graph-…`) traitées par `reduceGraph`, et
 * la sélection par `ws-select` (nœuds et relations), partagée avec les autres vues.
 */

// ── Couches et colonnes ──────────────────────────────────────────────────────────────────────

/** Les couches que l'on peut masquer (« Afficher : »). Le contexte et les requêtes restent visibles. */
export const GRAPH_GROUPS = ['FRONTEND', 'BFF', 'BACKEND', 'DATA'] as const;
export type GraphGroup = (typeof GRAPH_GROUPS)[number];
export type NodeGroup = GraphGroup | 'CONTEXT' | 'HTTP';

const byLayer = (layer: Layer, fallback: NodeGroup): NodeGroup =>
  layer === 'FRONTEND'
    ? 'FRONTEND'
    : layer === 'BFF'
      ? 'BFF'
      : layer === 'BACKEND'
        ? 'BACKEND'
        : layer === 'DATABASE'
          ? 'DATA'
          : fallback;

/** Le groupe d'un nœud : sa couche d'affichage. */
export function groupOf(node: Pick<GraphNode, 'kind' | 'layer'>): NodeGroup {
  switch (node.kind) {
    case 'INCIDENT':
    case 'SCENARIO':
      return 'CONTEXT';
    case 'ACTION':
    case 'FRONTEND_CODE':
      return 'FRONTEND';
    case 'REQUEST':
      return 'HTTP';
    case 'BFF_ENDPOINT':
    case 'BFF_SERVICE':
      return 'BFF';
    case 'BACKEND_ENDPOINT':
    case 'BACKEND_SERVICE':
      return 'BACKEND';
    case 'REPOSITORY':
      return 'DATA';
    case 'BACKEND_CALL':
      return byLayer(node.layer, 'BFF');
    case 'EXCEPTION':
      return byLayer(node.layer, 'HTTP');
  }
}

/**
 * La colonne : 0 incident et scénario, 1 actions, 2 code frontend, 3 requêtes HTTP, 4-5 BFF (endpoints,
 * services), 6 appels HTTP sortants, 7-8 backend (endpoints, services), 9 données. Une exception se place
 * juste après le code de sa couche ; une exception sans couche connue, près de la requête qui la nomme.
 */
export function columnOf(node: Pick<GraphNode, 'kind' | 'layer'>): number {
  switch (node.kind) {
    case 'INCIDENT':
    case 'SCENARIO':
      return 0;
    case 'ACTION':
      return 1;
    case 'FRONTEND_CODE':
      return 2;
    case 'REQUEST':
      return 3;
    case 'BFF_ENDPOINT':
      return 4;
    case 'BFF_SERVICE':
      return 5;
    case 'BACKEND_CALL':
      return 6;
    case 'BACKEND_ENDPOINT':
      return 7;
    case 'BACKEND_SERVICE':
      return 8;
    case 'REPOSITORY':
      return 9;
    case 'EXCEPTION':
      return node.layer === 'BFF' ? 6 : node.layer === 'BACKEND' || node.layer === 'DATABASE' ? 9 : 3;
  }
}

type BandKey = 'context' | 'frontend' | 'http' | 'bff' | 'backend' | 'data';
const BANDS: { from: number; to: number; key: BandKey }[] = [
  { from: 0, to: 0, key: 'context' },
  { from: 1, to: 2, key: 'frontend' },
  { from: 3, to: 3, key: 'http' },
  { from: 4, to: 5, key: 'bff' },
  { from: 6, to: 6, key: 'http' },
  { from: 7, to: 8, key: 'backend' },
  { from: 9, to: 9, key: 'data' },
];

const CODE_KINDS: ReadonlySet<GraphNodeKind> = new Set<GraphNodeKind>([
  'FRONTEND_CODE',
  'BFF_ENDPOINT',
  'BFF_SERVICE',
  'BACKEND_CALL',
  'BACKEND_ENDPOINT',
  'BACKEND_SERVICE',
  'REPOSITORY',
]);

/** Un nœud lu dans le code (et non une action, une requête ou une exception nommée par une réponse). */
export function isCodeNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  return CODE_KINDS.has(node.kind) || (node.kind === 'EXCEPTION' && node.symbolId !== undefined);
}

/**
 * Le statut affiché d'une relation. Deux éléments du code ne sont jamais reliés par une observation : une
 * telle relation (donnée incohérente) s'affiche « lue dans le code ».
 */
export function displayStatus(edge: GraphEdge, nodes: ReadonlyMap<string, GraphNode>): RelationStatus {
  if (edge.status === 'OBSERVED' && isCodeNode(nodes.get(edge.from)) && isCodeNode(nodes.get(edge.to)))
    return 'STATICALLY_RESOLVED';
  return edge.status;
}

/** Le graphe sans les couches masquées : leurs nœuds et toutes les relations qui les touchent. */
export function visibleGraph(graph: InvestigationGraph, hidden: readonly GraphGroup[]): InvestigationGraph {
  if (hidden.length === 0) return graph;
  const masked = new Set<NodeGroup>(hidden);
  const removed = new Set(graph.nodes.filter((node) => masked.has(groupOf(node))).map((node) => node.id));
  return {
    nodes: graph.nodes.filter((node) => !removed.has(node.id)),
    edges: graph.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
  };
}

// ── Disposition ──────────────────────────────────────────────────────────────────────────────

export const NODE_W = 176;
export const NODE_H = 46;
const COL_W = 216;
const ROW_H = 62;
const PAD = 16;
const TOP = 44;
/** Le cadre a au moins cette proportion (hauteur / largeur) : zoomer agrandit, sans écraser la vue. */
const FRAME_RATIO = 0.3;
/**
 * L'échelle lisible minimale (pixels affichés par unité du graphe) : les libellés de 12 unités y font au
 * moins 10 px. La vue ajustée ne descend jamais en dessous : le cadre défile plutôt que de rétrécir.
 */
export const READABLE_GRAPH_SCALE = 0.85;
/** La largeur visée (px) par la vue ajustée d'un petit graphe : jamais au-delà de 100 %. */
const FIT_TARGET_PX = 960;

/**
 * L'échelle réelle de la vue ajustée (zoom 1) : le graphe tient dans FIT_TARGET_PX quand c'est possible,
 * sans dépasser 100 % (1 unité par pixel) ni descendre sous l'échelle lisible.
 */
export function fitScale(width: number): number {
  if (!(width > 0)) return 1;
  return Math.min(1, Math.max(READABLE_GRAPH_SCALE, FIT_TARGET_PX / width));
}

export interface LaidNode {
  node: GraphNode;
  x: number;
  y: number;
  column: number;
  group: NodeGroup;
}

export interface LaidEdge {
  edge: GraphEdge;
  /** La clé de sélection (`from->to`). */
  id: string;
  /** Le statut affiché (voir displayStatus). */
  status: RelationStatus;
  d: string;
}

export interface GraphLayout2 {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
  bands: { key: BandKey; x: number; width: number }[];
  /** Les relations dont une extrémité manque au graphe : listées dans le tableau, jamais dessinées vers le vide. */
  dangling: number;
}

const num = (value: number): string => String(Math.round(value * 10) / 10);

function edgePath(a: LaidNode, b: LaidNode): string {
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  if (a.x === b.x) {
    const x = a.x + NODE_W;
    const bulge = 36 + Math.min(60, Math.abs(y2 - y1) / 4);
    return `M${num(x)},${num(y1)} C${num(x + bulge)},${num(y1)} ${num(x + bulge)},${num(y2)} ${num(x + 1)},${num(y2)}`;
  }
  if (b.x > a.x) {
    const x1 = a.x + NODE_W;
    const x2 = b.x - 1;
    const mid = (x1 + x2) / 2;
    return `M${num(x1)},${num(y1)} C${num(mid)},${num(y1)} ${num(mid)},${num(y2)} ${num(x2)},${num(y2)}`;
  }
  const x1 = a.x;
  const x2 = b.x + NODE_W + 1;
  return `M${num(x1)},${num(y1)} C${num(x1 - 48)},${num(y1 + 64)} ${num(x2 + 48)},${num(y2 + 64)} ${num(x2)},${num(y2)}`;
}

/**
 * La disposition en couches, déterministe : une colonne par genre (colonnes vides retirées) ; dans une
 * colonne, les nœuds suivent la hauteur moyenne de leurs prédécesseurs déjà placés (moins de croisements),
 * puis l'ordre du graphe ; un nœud s'aligne sur ses prédécesseurs quand la place est libre.
 */
export function graphLayout2(graph: InvestigationGraph): GraphLayout2 {
  const columns = new Map<number, { node: GraphNode; index: number }[]>();
  graph.nodes.forEach((node, index) => {
    const column = columnOf(node);
    const list = columns.get(column) ?? [];
    list.push({ node, index });
    columns.set(column, list);
  });
  const present = [...columns.keys()].sort((a, b) => a - b);
  const slotOf = new Map(present.map((column, slot) => [column, slot]));
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }
  const placed = new Map<string, LaidNode>();
  for (const column of present) {
    const slot = slotOf.get(column) ?? 0;
    const entries = (columns.get(column) ?? []).map((entry) => {
      const ys = (incoming.get(entry.node.id) ?? [])
        .map((from) => placed.get(from))
        .filter((laid): laid is LaidNode => laid !== undefined && laid.column < column)
        .map((laid) => laid.y);
      const bary = ys.length > 0 ? ys.reduce((sum, y) => sum + y, 0) / ys.length : undefined;
      return { ...entry, bary };
    });
    entries.sort(
      (a, b) =>
        (a.bary ?? Number.POSITIVE_INFINITY) - (b.bary ?? Number.POSITIVE_INFINITY) || a.index - b.index,
    );
    let next = TOP;
    for (const entry of entries) {
      const y = Math.round(Math.max(next, entry.bary ?? next));
      next = y + ROW_H;
      placed.set(entry.node.id, {
        node: entry.node,
        x: PAD + slot * COL_W,
        y,
        column,
        group: groupOf(entry.node),
      });
    }
  }
  const nodes = graph.nodes.map((node) => placed.get(node.id)).filter((n): n is LaidNode => n !== undefined);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  let dangling = 0;
  const edges: LaidEdge[] = [];
  for (const edge of graph.edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (!a || !b) {
      dangling += 1;
      continue;
    }
    if (a === b) continue;
    edges.push({
      edge,
      id: edgeId(edge.from, edge.to),
      status: displayStatus(edge, byId),
      d: edgePath(a, b),
    });
  }
  const bands: GraphLayout2['bands'] = [];
  for (const band of BANDS) {
    const slots = present
      .filter((column) => column >= band.from && column <= band.to)
      .map((column) => slotOf.get(column) ?? 0);
    if (slots.length === 0) continue;
    const first = Math.min(...slots);
    const last = Math.max(...slots);
    bands.push({ key: band.key, x: PAD + first * COL_W - 8, width: (last - first) * COL_W + NODE_W + 16 });
  }
  const bottom = Math.max(TOP + NODE_H, ...nodes.map((laid) => laid.y + NODE_H));
  return {
    width: PAD * 2 + Math.max(0, present.length - 1) * COL_W + NODE_W,
    height: bottom + PAD + 8,
    nodes,
    edges,
    bands,
    dangling,
  };
}

// ── Chemin d'erreur ──────────────────────────────────────────────────────────────────────────

export interface ErrorPath {
  /** Les requêtes en échec de la reproduction (ids d'HttpExchange) d'où part le chemin. */
  requests: string[];
  /** Les nœuds du chemin, de la requête vers l'exception (ou le nœud backend le plus profond). */
  nodes: string[];
  /** Les relations du chemin (clés `from->to`). */
  edges: string[];
}

const LAYER_DEPTH: Partial<Record<Layer, number>> = { FRONTEND: 1, BFF: 2, BACKEND: 3, DATABASE: 4 };

/** Une requête en échec : statut 5xx, ou échec réseau. */
export const isFailing = (request: HttpExchange): boolean =>
  (request.status ?? 0) >= 500 || request.failure !== undefined;

/**
 * LE CHEMIN D'ERREUR : depuis chaque requête en échec de la reproduction, le plus long chemin (relations
 * connues, cycles ignorés) vers la cible la plus parlante — une exception, de préférence nommée par une
 * réponse observée, dans la couche la plus profonde — sinon vers le nœud le plus profond. Un calcul sur le
 * graphe : ses maillons lus dans le code restent des relations statiques, pas une trace d'exécution.
 */
export function errorPath(graph: InvestigationGraph, reproduction: ReproductionRun | undefined): ErrorPath {
  const result: ErrorPath = { requests: [], nodes: [], edges: [] };
  if (!reproduction) return result;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const observedTargets = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.status === 'OBSERVED') observedTargets.add(edge.to);
    if (edge.status === 'UNKNOWN' || !byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to)
      continue;
    const list = outgoing.get(edge.from) ?? [];
    if (!list.includes(edge.to)) list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();
  for (const request of reproduction.requests.filter(isFailing)) {
    const start = graph.nodes.find(
      (node) =>
        node.kind === 'REQUEST' &&
        (node.id === `request:${request.id}` || node.evidence.includes(request.id)),
    );
    if (!start) continue;
    result.requests.push(request.id);
    // Ordre topologique depuis la requête (les relations qui reviennent sur la pile sont ignorées).
    const state = new Map<string, 1 | 2>();
    const order: string[] = [];
    const forward = new Map<string, string[]>();
    const visit = (id: string): void => {
      state.set(id, 1);
      const kept: string[] = [];
      for (const to of outgoing.get(id) ?? []) {
        const seen = state.get(to);
        if (seen === 1) continue;
        kept.push(to);
        if (seen === undefined) visit(to);
      }
      forward.set(id, kept);
      state.set(id, 2);
      order.push(id);
    };
    visit(start.id);
    order.reverse();
    const dist = new Map<string, number>([[start.id, 0]]);
    const parent = new Map<string, string>();
    for (const id of order) {
      const base = dist.get(id);
      if (base === undefined) continue;
      for (const to of forward.get(id) ?? [])
        if ((dist.get(to) ?? -1) < base + 1) {
          dist.set(to, base + 1);
          parent.set(to, id);
        }
    }
    const score = (id: string): number[] => {
      const node = byId.get(id);
      return [
        node?.kind === 'EXCEPTION' ? 1 : 0,
        node?.kind === 'EXCEPTION' && observedTargets.has(id) ? 1 : 0,
        node ? (LAYER_DEPTH[node.layer] ?? 0) : 0,
        dist.get(id) ?? 0,
      ];
    };
    const better = (a: number[], b: number[]): boolean => {
      for (let index = 0; index < a.length; index += 1) {
        const left = a[index] ?? 0;
        const right = b[index] ?? 0;
        if (left !== right) return left > right;
      }
      return false;
    };
    let target: string | undefined;
    for (const node of graph.nodes) {
      if (node.id === start.id || !dist.has(node.id)) continue;
      if (target === undefined || better(score(node.id), score(target))) target = node.id;
    }
    const chain = [target ?? start.id];
    for (let current = parent.get(chain[0] ?? ''); current !== undefined; current = parent.get(current))
      chain.unshift(current);
    chain.forEach((id, index) => {
      if (!nodeSet.has(id)) {
        nodeSet.add(id);
        result.nodes.push(id);
      }
      const previous = index > 0 ? chain[index - 1] : undefined;
      if (previous === undefined) return;
      const key = edgeId(previous, id);
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        result.edges.push(key);
      }
    });
  }
  return result;
}

// ── État local et actions ────────────────────────────────────────────────────────────────────

/**
 * La vue du graphe. `zoom` : 1 = la vue ajustée (tout le graphe, à l'échelle réelle `fitScale`, jamais
 * sous l'échelle lisible : le cadre défile) ; au-dessus, un agrandissement dans le même cadre ; en
 * dessous, une vue d'ensemble réduite (cadre plus petit, libellés trop petits pour être lus). L'échelle
 * réelle affichée vaut `fitScale(largeur) × zoom` (100 % = 1 unité du graphe par pixel).
 * `offsetX` / `offsetY` : le décalage du centre du viewBox par rapport au centre du graphe, en unités du
 * graphe — une vue qui survit au redessin et à l'arrivée de nouveaux nœuds.
 */
export interface GraphUi {
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** Les couches masquées (« Afficher : »). */
  hidden: GraphGroup[];
  /** Mettre en évidence le chemin d'erreur. */
  errorPath: boolean;
}

export const emptyGraphUi = (): GraphUi => ({
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  hidden: [],
  errorPath: false,
});

export const MIN_GRAPH_ZOOM = 0.5;
export const MAX_GRAPH_ZOOM = 4;
const ZOOM_STEP = 1.25;
/** Le pas d'un déplacement au clavier, en unités du graphe à 100 %. */
export const PAN_STEP = 60;

const clampZoom = (zoom: number): number => Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, zoom));
/** Le grossissement du viewBox : sous la vue ajustée, c'est le cadre qui rétrécit, pas le viewBox. */
const magnification = (zoom: number): number => Math.max(1, clampZoom(zoom));
const finite = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const clampOffset = (value: number, extent: number | undefined): number =>
  extent === undefined || extent <= 0 ? value : Math.min(extent / 2, Math.max(-extent / 2, value));

/**
 * Les actions du graphe (pures) :
 * - `ws-graph-zoom` : `data-dir="in|out"`, ou `data-delta` (deltaY de la molette) ; avec `data-fx` /
 *   `data-fy` (position du pointeur, 0 à 1 dans le cadre) et `data-w` / `data-h` (largeur et hauteur du
 *   graphe, posées sur le cadre et les boutons), le point sous le pointeur ne bouge pas ;
 * - `ws-graph-pan` : `data-dx` / `data-dy`, le déplacement du contenu en unités du cadre (le contrôleur
 *   convertit les pixels : × data-w / largeur affichée du SVG) ; borné par `data-w` / `data-h` ;
 * - `ws-graph-fit` (vue ajustée, zoom 1), `ws-graph-reset` (vue, couches et chemin d'erreur d'origine) ;
 * - `ws-graph-layer` : `data-layer` (FRONTEND, BFF, BACKEND, DATA) affiché ou masqué ;
 * - `ws-graph-errors` : le chemin d'erreur, mis en évidence ou non.
 */
export function reduceGraph(
  ui: GraphUi,
  action: string,
  dataset: Record<string, string | undefined>,
): GraphUi | undefined {
  const w = finite(dataset.w);
  const h = finite(dataset.h);
  switch (action) {
    case 'ws-graph-zoom': {
      const delta = finite(dataset.delta);
      const factor =
        dataset.dir === 'in'
          ? ZOOM_STEP
          : dataset.dir === 'out'
            ? 1 / ZOOM_STEP
            : delta !== undefined
              ? Math.exp(-delta * 0.0015)
              : 1;
      const zoom = clampZoom(ui.zoom * factor);
      if (zoom === ui.zoom) return ui;
      const fx = finite(dataset.fx);
      const fy = finite(dataset.fy);
      // Le point sous le pointeur reste en place : le centre glisse de (f − ½) × (largeur avant − après).
      const shift = (f: number | undefined, extent: number | undefined): number =>
        f === undefined || extent === undefined
          ? 0
          : (f - 0.5) * extent * (1 / magnification(ui.zoom) - 1 / magnification(zoom));
      const frameH = w !== undefined && h !== undefined ? Math.max(h, w * FRAME_RATIO) : undefined;
      return {
        ...ui,
        zoom,
        offsetX: clampOffset(ui.offsetX + shift(fx, w), w),
        offsetY: clampOffset(ui.offsetY + shift(fy, frameH), h),
      };
    }
    case 'ws-graph-pan': {
      const dx = finite(dataset.dx) ?? 0;
      const dy = finite(dataset.dy) ?? 0;
      if (dx === 0 && dy === 0) return ui;
      return {
        ...ui,
        offsetX: clampOffset(ui.offsetX - dx / magnification(ui.zoom), w),
        offsetY: clampOffset(ui.offsetY - dy / magnification(ui.zoom), h),
      };
    }
    case 'ws-graph-fit':
      return { ...ui, zoom: 1, offsetX: 0, offsetY: 0 };
    case 'ws-graph-reset':
      return emptyGraphUi();
    case 'ws-graph-layer': {
      const layer = GRAPH_GROUPS.find((group) => group === dataset.layer);
      if (!layer) return ui;
      const hidden = ui.hidden.includes(layer)
        ? ui.hidden.filter((group) => group !== layer)
        : GRAPH_GROUPS.filter((group) => group === layer || ui.hidden.includes(group));
      return { ...ui, hidden };
    }
    case 'ws-graph-errors':
      return { ...ui, errorPath: !ui.errorPath };
    default:
      return undefined;
  }
}

/**
 * Les touches du cadre du graphe → l'action à transmettre à reduceGraph : flèches (déplacer), + / −
 * (zoomer), 0 (tout voir). Rien pour les autres touches (Entrée et Espace sélectionnent le nœud focalisé).
 */
export function graphKeyAction(
  key: string,
): { action: string; dataset: Record<string, string | undefined> } | undefined {
  const pan = (dx: number, dy: number) => ({
    action: 'ws-graph-pan',
    dataset: { dx: String(dx), dy: String(dy) },
  });
  switch (key) {
    case 'ArrowLeft':
      return pan(PAN_STEP, 0);
    case 'ArrowRight':
      return pan(-PAN_STEP, 0);
    case 'ArrowUp':
      return pan(0, PAN_STEP);
    case 'ArrowDown':
      return pan(0, -PAN_STEP);
    case '+':
    case '=':
      return { action: 'ws-graph-zoom', dataset: { dir: 'in' } };
    case '-':
      return { action: 'ws-graph-zoom', dataset: { dir: 'out' } };
    case '0':
      return { action: 'ws-graph-fit', dataset: {} };
    default:
      return undefined;
  }
}

export interface GraphView {
  /** Le viewBox (unités du graphe). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Le cadre en unités du graphe (au moins FRAME_RATIO de haut). */
  frameWidth: number;
  frameHeight: number;
  /** L'échelle réelle : pixels affichés par unité du graphe (1 = 100 %). */
  scale: number;
  /** La taille affichée du SVG, en pixels : fixe, le cadre défile quand elle dépasse. */
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * La vue : le viewBox (le cadre divisé par le grossissement, centré et décalé) et la taille affichée du
 * SVG en pixels. Au zoom 1, tout le graphe à l'échelle `fitScale` ; au-dessus, le viewBox se resserre
 * dans un cadre de même taille ; en dessous, le cadre rétrécit (vue d'ensemble réduite). L'échelle réelle
 * vaut donc toujours pixelWidth / width = fitScale × zoom.
 */
export function graphViewBox(
  layout: Pick<GraphLayout2, 'width' | 'height'>,
  ui: Pick<GraphUi, 'zoom' | 'offsetX' | 'offsetY'>,
): GraphView {
  const frameWidth = layout.width;
  const frameHeight = Math.max(layout.height, Math.round(layout.width * FRAME_RATIO));
  const zoom = clampZoom(ui.zoom);
  const fit = fitScale(layout.width);
  const shrink = Math.min(1, zoom);
  const width = frameWidth / magnification(zoom);
  const height = frameHeight / magnification(zoom);
  const cx = layout.width / 2 + clampOffset(ui.offsetX, layout.width);
  const cy = layout.height / 2 + clampOffset(ui.offsetY, layout.height);
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    frameWidth,
    frameHeight,
    scale: fit * zoom,
    pixelWidth: Math.round(frameWidth * fit * shrink),
    pixelHeight: Math.round(frameHeight * fit * shrink),
  };
}

/** L'échelle réelle d'une vue, en pour cent (100 % = 1 unité du graphe par pixel). */
export const graphScalePercent = (view: Pick<GraphView, 'scale'>): number => Math.round(view.scale * 100);

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    title: 'Traçabilité full-stack',
    none: 'Le graphe apparaît après l’analyse du code de l’incident.',
    kinds: {
      INCIDENT: 'Incident',
      SCENARIO: 'Scénario',
      ACTION: 'Action',
      REQUEST: 'Requête HTTP',
      FRONTEND_CODE: 'Code frontend',
      BFF_ENDPOINT: 'Endpoint BFF',
      BFF_SERVICE: 'Code BFF',
      BACKEND_CALL: 'Appel HTTP sortant',
      BACKEND_ENDPOINT: 'Endpoint backend',
      BACKEND_SERVICE: 'Code backend',
      REPOSITORY: 'Accès aux données',
      EXCEPTION: 'Exception',
    } as Record<GraphNodeKind, string>,
    groups: { FRONTEND: 'Frontend', BFF: 'BFF', BACKEND: 'Backend', DATA: 'Données' } as Record<
      GraphGroup,
      string
    >,
    bands: {
      context: 'Incident',
      frontend: 'Frontend',
      http: 'HTTP',
      bff: 'BFF Java',
      backend: 'Backend Spring Boot',
      data: 'Données',
    } as Record<BandKey, string>,
    controls: 'Commandes du graphe',
    zoom: 'Zoom',
    zoomIn: 'Zoom avant',
    zoomOut: 'Zoom arrière',
    fit: 'Ajuster',
    fitHint: (pct: number) =>
      `Vue ajustée : tout le graphe à ${String(pct)} %, jamais sous l’échelle lisible (le cadre défile si nécessaire)`,
    scaleHint: 'Échelle réelle : 100 % = 1 unité du graphe par pixel',
    reduced: (pct: number, min: number) =>
      `Vue d’ensemble réduite (${String(pct)} %) : sous ${String(min)} %, les libellés sont trop petits pour être lus. « Ajuster » ou « + » pour revenir à une échelle lisible.`,
    reset: 'Réinitialiser',
    show: 'Afficher :',
    showLayer: (layer: string, shown: boolean) => `${shown ? 'Masquer' : 'Afficher'} la couche ${layer}`,
    errorPath: 'Chemin d’erreur',
    errorPathHint: 'Mettre en évidence le chemin depuis la requête en échec',
    canvas: 'Graphe full-stack : nœuds et relations',
    help: 'Glisser, barres de défilement ou flèches du clavier pour déplacer, molette ou + / − pour zoomer, 0 pour ajuster. Tab atteint un nœud (le nœud sélectionné, sinon le début du chemin d’erreur), les flèches passent d’un nœud à son voisin, Entrée le sélectionne ; le tableau des relations permet de sélectionner chaque relation au clavier.',
    caption: (nodes: number, edges: number, o: number, s: number, i: number, u: number) =>
      `${String(nodes)} nœud(s), ${String(edges)} relation(s) : ${String(o)} observée(s), ${String(s)} lue(s) dans le code, ${String(i)} déduite(s), ${String(u)} inconnue(s).`,
    staticNote:
      'Seules les relations « Observée » viennent de la reproduction. Les relations lues dans le code ou déduites décrivent ce que le code permet : ce n’est pas une trace d’exécution, et aucune durée n’est mesurée pour le code.',
    pathFound: (from: string, to: string, edges: number, observed: number) =>
      `Chemin d’erreur : de « ${from} » à « ${to} », ${String(edges)} relation(s) dont ${String(observed)} observée(s). Les maillons lus dans le code restent des relations statiques.`,
    pathNone:
      'Aucune requête en échec (statut 5xx ou échec réseau) de la reproduction n’est reliée au graphe.',
    hiddenCount: (count: number) => `${String(count)} nœud(s) masqué(s) par « Afficher : ».`,
    allHidden: 'Toutes les couches sont masquées : choisissez une couche à afficher.',
    dangling: (count: number) =>
      `${String(count)} relation(s) vers un nœud absent du graphe : voir le tableau des relations.`,
    selectHint: 'Sélectionnez un nœud ou une relation du graphe pour voir ses preuves.',
    relation: 'Relation',
    kind: 'Genre',
    layer: 'Couche',
    dataAccess: 'accès aux données (lu dans le code)',
    code: 'Code',
    viewCode: 'Voir le code',
    lines: (line: number, end?: number) =>
      end !== undefined ? `lignes ${String(line)}-${String(end)}` : `ligne ${String(line)}`,
    observed: 'Observé',
    status: 'Statut',
    duration: (ms: number) => `${String(Math.round(ms))} ms`,
    noStatus: 'sans réponse',
    evidence: 'Preuves',
    noEvidence: 'aucune',
    reason: 'Raison',
    from: 'De',
    to: 'Vers',
    relations: 'Relations',
    incoming: 'Entrante',
    outgoingRel: 'Sortante',
    codeNote:
      'Lu dans le code : ce n’est pas une trace d’exécution. Aucune durée n’est mesurée pour un nœud du code.',
    requestNote: 'Vue pendant la reproduction : statut et durée observés.',
    staticEdge: 'Lu dans le code : ce n’est pas une trace d’exécution.',
    inferredCodeEdge: 'Déduite du code, à vérifier : ce n’est pas une trace d’exécution.',
    inferredEdge: 'Déduite (par exemple par l’horodatage), à vérifier.',
    observedEdge: 'Observée pendant la reproduction.',
    unknownEdge: 'Lien non établi : la raison dit ce qui manque.',
    downgraded:
      'Relation entre deux éléments du code enregistrée comme observée : affichée comme lue dans le code.',
    onPath: 'Sur le chemin d’erreur',
    missingNode: (id: string) => `nœud absent (${id})`,
    table: 'Relations du graphe',
    tableEmpty: 'Aucune relation pour l’instant.',
    selectEdge: (from: string, to: string) => `Sélectionner la relation ${from} → ${to}`,
    selectNode: (label: string) => `Sélectionner le nœud ${label}`,
  },
  en: {
    title: 'Full-stack traceability',
    none: 'The graph appears once the incident code has been analysed.',
    kinds: {
      INCIDENT: 'Incident',
      SCENARIO: 'Scenario',
      ACTION: 'Action',
      REQUEST: 'HTTP request',
      FRONTEND_CODE: 'Frontend code',
      BFF_ENDPOINT: 'BFF endpoint',
      BFF_SERVICE: 'BFF code',
      BACKEND_CALL: 'Outgoing HTTP call',
      BACKEND_ENDPOINT: 'Backend endpoint',
      BACKEND_SERVICE: 'Backend code',
      REPOSITORY: 'Data access',
      EXCEPTION: 'Exception',
    } as Record<GraphNodeKind, string>,
    groups: { FRONTEND: 'Frontend', BFF: 'BFF', BACKEND: 'Backend', DATA: 'Data' } as Record<
      GraphGroup,
      string
    >,
    bands: {
      context: 'Incident',
      frontend: 'Frontend',
      http: 'HTTP',
      bff: 'Java BFF',
      backend: 'Spring Boot backend',
      data: 'Data',
    } as Record<BandKey, string>,
    controls: 'Graph controls',
    zoom: 'Zoom',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fit: 'Fit',
    fitHint: (pct: number) =>
      `Fitted view: the whole graph at ${String(pct)}%, never below the readable scale (the frame scrolls when necessary)`,
    scaleHint: 'Actual scale: 100% = 1 graph unit per pixel',
    reduced: (pct: number, min: number) =>
      `Reduced overview (${String(pct)}%): below ${String(min)}%, labels are too small to be read. Use “Fit” or “+” to get back to a readable scale.`,
    reset: 'Reset',
    show: 'Show:',
    showLayer: (layer: string, shown: boolean) => `${shown ? 'Hide' : 'Show'} the ${layer} layer`,
    errorPath: 'Error path',
    errorPathHint: 'Highlight the path starting at the failing request',
    canvas: 'Full-stack graph: nodes and relations',
    help: 'Drag, scroll bars or arrow keys to move, wheel or + / − to zoom, 0 to fit. Tab reaches one node (the selected node, otherwise the start of the error path), the arrow keys move from a node to its neighbour, Enter selects it; the relations table lets you select each relation with the keyboard.',
    caption: (nodes: number, edges: number, o: number, s: number, i: number, u: number) =>
      `${String(nodes)} node(s), ${String(edges)} relation(s): ${String(o)} observed, ${String(s)} read in the code, ${String(i)} inferred, ${String(u)} unknown.`,
    staticNote:
      'Only “Observed” relations come from the reproduction. Relations read in the code or inferred describe what the code allows: this is not an execution trace, and no duration is measured for code.',
    pathFound: (start: string, end: string, edges: number, observed: number) =>
      `Error path: “${start}” to “${end}”, ${String(edges)} relation(s), ${String(observed)} observed. Links read in the code remain static relations.`,
    pathNone:
      'No failing request (5xx status or network failure) of the reproduction is linked to the graph.',
    hiddenCount: (count: number) => `${String(count)} node(s) hidden by “Show:”.`,
    allHidden: 'Every layer is hidden: choose a layer to show.',
    dangling: (count: number) =>
      `${String(count)} relation(s) towards a node missing from the graph: see the relations table.`,
    selectHint: 'Select a node or a relation of the graph to see its evidence.',
    relation: 'Relation',
    kind: 'Kind',
    layer: 'Layer',
    dataAccess: 'data access (read in the code)',
    code: 'Code',
    viewCode: 'View code',
    lines: (line: number, end?: number) =>
      end !== undefined ? `lines ${String(line)}-${String(end)}` : `line ${String(line)}`,
    observed: 'Observed',
    status: 'Status',
    duration: (ms: number) => `${String(Math.round(ms))} ms`,
    noStatus: 'no response',
    evidence: 'Evidence',
    noEvidence: 'none',
    reason: 'Reason',
    from: 'From',
    to: 'To',
    relations: 'Relations',
    incoming: 'Incoming',
    outgoingRel: 'Outgoing',
    codeNote: 'Read in the code: this is not an execution trace. No duration is measured for a code node.',
    requestNote: 'Seen during the reproduction: observed status and duration.',
    staticEdge: 'Read in the code: this is not an execution trace.',
    inferredCodeEdge: 'Inferred from the code, to be checked: this is not an execution trace.',
    inferredEdge: 'Inferred (for instance by timestamp), to be checked.',
    observedEdge: 'Observed during the reproduction.',
    unknownEdge: 'Link not established: the reason says what is missing.',
    downgraded: 'Relation between two code elements recorded as observed: shown as read in the code.',
    onPath: 'On the error path',
    missingNode: (id: string) => `missing node (${id})`,
    table: 'Graph relations',
    tableEmpty: 'No relation yet.',
    selectEdge: (start: string, end: string) => `Select the relation ${start} → ${end}`,
    selectNode: (label: string) => `Select the node ${label}`,
  },
};

const text = (lang: Lang): (typeof TEXT)['fr'] => TEXT[lang];

/** Un libellé tronqué (le texte complet va dans `<title>` ou `title`). */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

// ── Aides de rendu ───────────────────────────────────────────────────────────────────────────

const requestsOf = (ctx: WorkspaceContext): Map<string, HttpExchange> =>
  new Map(
    ctx.incident.investigation.reproductions.flatMap((run) =>
      run.requests.map((request) => [request.id, request] as const),
    ),
  );

/** L'échange HTTP observé d'un nœud REQUEST. */
function exchangeOf(node: GraphNode, requests: Map<string, HttpExchange>): HttpExchange | undefined {
  if (node.kind !== 'REQUEST') return undefined;
  for (const ref of node.evidence) {
    const found = requests.get(ref);
    if (found) return found;
  }
  return undefined;
}

/** La localisation dans le code d'un nœud : la sienne, sinon celle que l'index de sélection connaît. */
function sourceOfNode(ctx: WorkspaceContext, node: GraphNode): SourceLocation | undefined {
  return node.source ?? ctx.links.sources.get(`node:${node.id}`);
}

const STATUSES: readonly RelationStatus[] = ['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED', 'UNKNOWN'];

function markers(): string {
  return STATUSES.map(
    (status) =>
      `<marker id="ws-g-m-${status.toLowerCase()}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ws-graph-mk ws-ge-${status.toLowerCase()}"/></marker>`,
  ).join('');
}

function nodeMeta(t: (typeof TEXT)['fr'], node: GraphNode, exchange: HttpExchange | undefined): string {
  const kind = t.kinds[node.kind];
  // Seule une requête observée porte une durée ; jamais un nœud du code.
  if (exchange?.durationMs !== undefined) return `${kind} · ${t.duration(exchange.durationMs)}`;
  return kind;
}

function nodeTitle(t: (typeof TEXT)['fr'], node: GraphNode, source: SourceLocation | undefined): string {
  return [t.kinds[node.kind], node.label, source ? `${source.file}:${String(source.line)}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

// ── Rendu du graphe ──────────────────────────────────────────────────────────────────────────

/** Le graphe interactif : commandes (zoom, tout voir, couches, chemin d'erreur), cadre SVG, légende. */
export function renderGraph(ctx: WorkspaceContext, ui: GraphUi): string {
  const t = text(ctx.lang);
  const graph = ctx.incident.investigation.graph;
  if (!graph || graph.nodes.length === 0)
    return `<section class="ws-graph" aria-label="${esc(t.title)}">${panelState(ctx.lang, 'empty', t.none)}${relationLegend(ctx.lang)}</section>`;
  const full = new Map(graph.nodes.map((node) => [node.id, node]));
  const visible = visibleGraph(graph, ui.hidden);
  const layout = graphLayout2(visible);
  const view = graphViewBox(layout, ui);
  const computedPath = errorPath(graph, incidentReproduction(ctx.incident));
  const path = ui.errorPath ? computedPath : undefined;
  const pathNodes = new Set(path?.nodes ?? []);
  const pct = graphScalePercent(view);
  const fitPct = Math.round(fitScale(layout.width) * 100);
  const readablePct = Math.round(READABLE_GRAPH_SCALE * 100);
  // Un seul arrêt de tabulation pour les nœuds (tabindex itinérant) : le nœud sélectionné, sinon le début
  // du chemin d'erreur, sinon le premier nœud ; les flèches mènent ensuite d'un nœud à son voisin.
  const shownIds = new Set(layout.nodes.map((laid) => laid.node.id));
  const selected = ctx.selection;
  const tabStop =
    (selected?.kind === 'node' && shownIds.has(selected.id) ? selected.id : undefined) ??
    computedPath.nodes.find((id) => shownIds.has(id)) ??
    layout.nodes[0]?.node.id;
  const pathEdges = new Set(path?.edges ?? []);
  const requests = requestsOf(ctx);
  const size = `data-w="${num(layout.width)}" data-h="${num(layout.height)}"`;

  const groupButtons = GRAPH_GROUPS.map((group) => {
    const shown = !ui.hidden.includes(group);
    return `<button type="button" class="chip ws-graph-layer ws-gg-${group.toLowerCase()}" data-action="ws-graph-layer" data-layer="${group}" aria-pressed="${String(shown)}" title="${esc(t.showLayer(t.groups[group], shown))}"><span class="ws-graph-dot" aria-hidden="true"></span>${esc(t.groups[group])}</button>`;
  }).join('');
  const toolbar = `<div class="ws-graph-bar" role="group" aria-label="${esc(t.controls)}"><div class="ws-graph-zoom" role="group" aria-label="${esc(t.zoom)}"><button type="button" class="btn small" data-action="ws-graph-zoom" data-dir="out" ${size} aria-label="${esc(t.zoomOut)}" title="${esc(t.zoomOut)}"${ui.zoom <= MIN_GRAPH_ZOOM ? ' disabled' : ''}>−</button><span class="ws-graph-pct" title="${esc(t.scaleHint)}">${String(pct)} %</span><button type="button" class="btn small" data-action="ws-graph-zoom" data-dir="in" ${size} aria-label="${esc(t.zoomIn)}" title="${esc(t.zoomIn)}"${ui.zoom >= MAX_GRAPH_ZOOM ? ' disabled' : ''}>+</button><button type="button" class="btn small" data-action="ws-graph-fit" title="${esc(t.fitHint(fitPct))}">${esc(t.fit)}</button><button type="button" class="btn small" data-action="ws-graph-reset">${esc(t.reset)}</button></div><button type="button" class="chip ws-graph-errbtn" data-action="ws-graph-errors" aria-pressed="${String(ui.errorPath)}" title="${esc(t.errorPathHint)}">${esc(t.errorPath)}</button><div class="ws-graph-layers" role="group" aria-label="${esc(t.show)}"><span class="ws-graph-show" aria-hidden="true">${esc(t.show)}</span>${groupButtons}</div></div>`;

  const notes: string[] = [];
  const hiddenCount = graph.nodes.length - visible.nodes.length;
  if (visible.nodes.length === 0) notes.push(`<p class="note">${esc(t.allHidden)}</p>`);
  else if (view.scale < READABLE_GRAPH_SCALE - 1e-9)
    notes.push(`<p class="note ws-graph-msg ws-graph-reduced">${esc(t.reduced(pct, readablePct))}</p>`);
  else if (hiddenCount > 0) notes.push(`<p class="mu ws-graph-msg">${esc(t.hiddenCount(hiddenCount))}</p>`);
  if (path) {
    const first = path.nodes[0];
    const last = path.nodes.at(-1);
    const observed = graph.edges.filter(
      (edge) => pathEdges.has(edgeId(edge.from, edge.to)) && displayStatus(edge, full) === 'OBSERVED',
    ).length;
    notes.push(
      first !== undefined && last !== undefined && path.edges.length > 0
        ? `<p class="ws-graph-msg ws-graph-pathnote">${esc(t.pathFound(full.get(first)?.label ?? first, full.get(last)?.label ?? last, path.edges.length, observed))}</p>`
        : `<p class="ws-graph-msg mu">${esc(t.pathNone)}</p>`,
    );
  }
  if (layout.dangling > 0) notes.push(`<p class="mu ws-graph-msg">${esc(t.dangling(layout.dangling))}</p>`);

  const bands = layout.bands
    .map(
      (band) =>
        `<rect class="ws-graph-band" x="${num(band.x)}" y="6" width="${num(band.width)}" height="${num(layout.height - 12)}" rx="10"/><text class="ws-graph-band-t" x="${num(band.x + 10)}" y="28">${esc(truncate(t.bands[band.key], Math.floor(band.width / 8)))}</text>`,
    )
    .join('');
  const labelOf = (id: string): string => full.get(id)?.label ?? id;
  const edges = layout.edges
    .map((laid) => {
      const status = laid.status.toLowerCase();
      const onPath = pathEdges.has(laid.id);
      const name = `${labelOf(laid.edge.from)} → ${labelOf(laid.edge.to)}`;
      const cls = [
        'ws-graph-edge',
        `ws-ge-${status}`,
        onPath ? 'ws-graph-onpath' : '',
        selectionClass(ctx, 'edge', laid.id),
      ]
        .filter(Boolean)
        .join(' ');
      return `<g class="${cls}" ${selectable(ctx, 'edge', laid.id)} role="button" tabindex="-1" aria-label="${esc(`${name} : ${partsText(ctx.lang).relations[laid.status]}`)}"><title>${esc(`${name} · ${partsText(ctx.lang).relations[laid.status]} · ${laid.edge.reason}`)}</title><path class="ws-graph-hit" d="${laid.d}"/><path class="ws-graph-line" d="${laid.d}" marker-end="url(#ws-g-m-${status})"/></g>`;
    })
    .join('');
  const nodes = layout.nodes
    .map((laid) => {
      const node = laid.node;
      const exchange = exchangeOf(node, requests);
      const source = sourceOfNode(ctx, node);
      const failing =
        exchange !== undefined && ((exchange.status ?? 0) >= 400 || exchange.failure !== undefined);
      const cls = [
        'ws-graph-node',
        `ws-gk-${node.kind.toLowerCase()}`,
        `ws-gg-${laid.group.toLowerCase()}`,
        node.layer === 'UNKNOWN' && node.kind !== 'INCIDENT' && node.kind !== 'SCENARIO'
          ? 'ws-graph-unknown'
          : '',
        failing || node.kind === 'EXCEPTION' ? 'ws-graph-fail' : '',
        pathNodes.has(node.id) ? 'ws-graph-onpath' : '',
        selectionClass(ctx, 'node', node.id),
      ]
        .filter(Boolean)
        .join(' ');
      return `<g class="${cls}" ${selectable(ctx, 'node', node.id)} role="button" tabindex="${node.id === tabStop ? '0' : '-1'}" aria-label="${esc(`${t.kinds[node.kind]} : ${node.label}`)}" transform="translate(${num(laid.x)},${num(laid.y)})"><title>${esc(nodeTitle(t, node, source))}</title><rect class="ws-graph-ring" x="-5" y="-5" width="${String(NODE_W + 10)}" height="${String(NODE_H + 10)}" rx="12"/><rect class="ws-graph-box" width="${String(NODE_W)}" height="${String(NODE_H)}" rx="8"/><rect class="ws-graph-stripe" width="5" height="${String(NODE_H)}" rx="2"/><text class="ws-graph-kind" x="13" y="17">${esc(truncate(nodeMeta(t, node, exchange), 27))}</text><text class="ws-graph-label" x="13" y="35">${esc(truncate(node.label, 21))}</text></g>`;
    })
    .join('');

  const count = (status: RelationStatus): number =>
    graph.edges.filter((edge) => displayStatus(edge, full) === status).length;
  const caption = t.caption(
    graph.nodes.length,
    graph.edges.length,
    count('OBSERVED'),
    count('STATICALLY_RESOLVED'),
    count('INFERRED'),
    count('UNKNOWN'),
  );
  const svg = `<svg class="ws-graph-svg" viewBox="${num(view.x)} ${num(view.y)} ${num(view.width)} ${num(view.height)}" preserveAspectRatio="xMidYMid meet" width="${String(view.pixelWidth)}" height="${String(view.pixelHeight)}" style="width:${String(view.pixelWidth)}px;height:${String(view.pixelHeight)}px" data-scale="${String(Math.round(view.scale * 1000) / 1000)}" xmlns="http://www.w3.org/2000/svg" focusable="false"><defs>${markers()}</defs><g class="ws-graph-bands" aria-hidden="true">${bands}</g><g class="ws-graph-edges">${edges}</g><g class="ws-graph-nodes">${nodes}</g></svg>`;
  return `<section class="ws-graph${ui.errorPath ? ' ws-graph-errmode' : ''}" aria-label="${esc(t.title)}">${toolbar}${notes.join('')}<figure class="ws-graph-fig"><figcaption id="ws-graph-cap" class="mu">${esc(caption)}</figcaption><div class="ws-graph-canvas" tabindex="0" role="group" aria-label="${esc(t.canvas)}" aria-describedby="ws-graph-cap ws-graph-help" data-ws-graph="canvas" ${size}>${svg}</div><p id="ws-graph-help" class="mu ws-graph-help">${esc(t.help)}</p></figure>${relationLegend(ctx.lang)}<p class="note ws-graph-static">${esc(t.staticNote)}</p></section>`;
}

// ── Détail de la sélection ───────────────────────────────────────────────────────────────────

const row = (term: string, value: string): string => `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;

function codeRow(ctx: WorkspaceContext, source: SourceLocation | undefined): string {
  if (!source) return '';
  const t = text(ctx.lang);
  return row(
    t.code,
    `<code title="${esc(source.file)}">${esc(`${source.file}:${String(source.line)}`)}</code> <small class="mu">${esc(t.lines(source.line, source.endLine))}</small> ${sourceLink(ctx.lang, source, t.viewCode)}`,
  );
}

function evidenceRow(ctx: WorkspaceContext, refs: readonly string[]): string {
  const t = text(ctx.lang);
  return row(
    t.evidence,
    refs.length > 0 ? evidenceChips(ctx, refs, 6) : `<span class="mu">${esc(t.noEvidence)}</span>`,
  );
}

function nodeButton(
  ctx: WorkspaceContext,
  id: string,
  node: GraphNode | undefined,
  max = 40,
  state = true,
): string {
  const t = text(ctx.lang);
  if (!node) return `<span class="mu">${esc(t.missingNode(id))}</span>`;
  return `<button type="button" class="lnk ws-graph-nodebtn ${state ? selectionClass(ctx, 'node', id) : ''}" ${selectable(ctx, 'node', id)} title="${esc(node.label)}" aria-label="${esc(t.selectNode(node.label))}">${esc(truncate(node.label, max))}</button>`;
}

function nodeDetail(ctx: WorkspaceContext, graph: InvestigationGraph, node: GraphNode): string {
  const t = text(ctx.lang);
  const parts = partsText(ctx.lang);
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const exchange = exchangeOf(node, requestsOf(ctx));
  const source = sourceOfNode(ctx, node);
  const code = isCodeNode(node);
  const layer = `${parts.layers[node.layer]}${node.kind === 'REPOSITORY' ? ` · ${t.dataAccess}` : ''}`;
  const observed = exchange
    ? row(
        t.observed,
        esc(
          [
            `${exchange.method.toUpperCase()} ${exchange.path}`,
            exchange.status !== undefined ? String(exchange.status) : (exchange.failure ?? t.noStatus),
            exchange.durationMs !== undefined ? t.duration(exchange.durationMs) : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
        ),
      )
    : '';
  const relations = graph.edges
    .filter((edge) => edge.from === node.id || edge.to === node.id)
    .map((edge) => {
      const out = edge.from === node.id;
      const other = out ? edge.to : edge.from;
      const id = edgeId(edge.from, edge.to);
      const status = displayStatus(edge, byId);
      const otherLabel = byId.get(other)?.label ?? t.missingNode(other);
      return `<li class="${selectionClass(ctx, 'edge', id)}"><button type="button" class="lnk ws-graph-relbtn" ${selectable(ctx, 'edge', id)} title="${esc(edge.reason)}" aria-label="${esc(out ? t.selectEdge(node.label, otherLabel) : t.selectEdge(otherLabel, node.label))}"><span class="mu">${esc(out ? t.outgoingRel : t.incoming)}</span> ${out ? '→' : '←'} ${esc(truncate(otherLabel, 36))}</button>${relationBadge(ctx.lang, status)}</li>`;
    })
    .join('');
  const note = exchange
    ? `<p class="mu ws-graph-dnote">${esc(t.requestNote)}</p>`
    : code
      ? `<p class="note ws-graph-dnote">${esc(t.codeNote)}</p>`
      : '';
  return `<section class="ws-graph-detail" aria-labelledby="ws-graph-detail-h"><p class="ws-graph-eyebrow">${esc(t.kinds[node.kind])} · ${esc(parts.layers[node.layer])}</p><h3 id="ws-graph-detail-h">${esc(node.label)}</h3><dl class="ws-graph-dl">${row(t.kind, esc(t.kinds[node.kind]))}${row(t.layer, esc(layer))}${observed}${codeRow(ctx, source)}${evidenceRow(ctx, node.evidence)}</dl>${note}${relations ? `<h4>${esc(t.relations)}</h4><ul class="ws-graph-rels">${relations}</ul>` : ''}</section>`;
}

function edgeDetail(ctx: WorkspaceContext, graph: InvestigationGraph, edge: GraphEdge): string {
  const t = text(ctx.lang);
  const parts = partsText(ctx.lang);
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  const status = displayStatus(edge, byId);
  const touchesCode = isCodeNode(from) || isCodeNode(to);
  const note =
    status === 'STATICALLY_RESOLVED'
      ? t.staticEdge
      : status === 'INFERRED'
        ? touchesCode
          ? t.inferredCodeEdge
          : t.inferredEdge
        : status === 'OBSERVED'
          ? t.observedEdge
          : t.unknownEdge;
  // Le code d'une relation statique : là où l'appel est écrit (le nœud de départ), sinon l'arrivée.
  const source =
    status === 'OBSERVED'
      ? undefined
      : ((from && isCodeNode(from) ? sourceOfNode(ctx, from) : undefined) ??
        (to && isCodeNode(to) ? sourceOfNode(ctx, to) : undefined));
  const title = `${from?.label ?? edge.from} → ${to?.label ?? edge.to}`;
  return `<section class="ws-graph-detail" aria-labelledby="ws-graph-detail-h"><p class="ws-graph-eyebrow">${esc(t.relation)}</p><h3 id="ws-graph-detail-h">${esc(title)}</h3><dl class="ws-graph-dl">${row(t.from, nodeButton(ctx, edge.from, from))}${row(t.to, nodeButton(ctx, edge.to, to))}${row(t.status, `${relationBadge(ctx.lang, status)} <small class="mu">${esc(parts.relationHints[status])}</small>`)}${row(t.reason, esc(edge.reason))}${codeRow(ctx, source)}${evidenceRow(ctx, edge.evidence)}</dl><p class="${status === 'OBSERVED' ? 'mu' : 'note'} ws-graph-dnote">${esc(note)}</p>${status !== edge.status ? `<p class="note warn ws-graph-dnote">${esc(t.downgraded)}</p>` : ''}</section>`;
}

/**
 * Le détail de la sélection quand elle désigne un nœud ou une relation du graphe : genre, couche,
 * libellé, statut, raison, preuves, lien vers le code. Une invite quand rien n'est sélectionné ; rien
 * (chaîne vide) pour une sélection d'une autre vue.
 */
export function renderGraphDetail(ctx: WorkspaceContext): string {
  const t = text(ctx.lang);
  const graph = ctx.incident.investigation.graph;
  const selection = ctx.selection;
  if (!selection) return panelState(ctx.lang, 'empty', t.selectHint);
  if (!graph) return '';
  if (selection.kind === 'node') {
    const node = graph.nodes.find((item) => item.id === selection.id);
    return node ? nodeDetail(ctx, graph, node) : '';
  }
  if (selection.kind === 'edge') {
    const edge = graph.edges.find((item) => edgeId(item.from, item.to) === selection.id);
    return edge ? edgeDetail(ctx, graph, edge) : '';
  }
  return '';
}

// ── Alternative accessible : le tableau des relations ───────────────────────────────────────

/** Toutes les relations, en tableau compact (libellés tronqués, raison sur deux lignes, preuves courtes). */
export function renderRelationsTable(ctx: WorkspaceContext): string {
  const t = text(ctx.lang);
  const graph = ctx.incident.investigation.graph;
  if (!graph || graph.edges.length === 0) return panelState(ctx.lang, 'empty', t.tableEmpty);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rows = graph.edges
    .map((edge) => {
      const id = edgeId(edge.from, edge.to);
      const status = displayStatus(edge, byId);
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      return `<tr class="${selectionClass(ctx, 'edge', id)}"><td>${nodeButton(ctx, edge.from, from, 34, false)}</td><td>${nodeButton(ctx, edge.to, to, 34, false)}</td><td><button type="button" class="ws-graph-relsel" ${selectable(ctx, 'edge', id)} aria-label="${esc(t.selectEdge(from?.label ?? edge.from, to?.label ?? edge.to))}">${relationBadge(ctx.lang, status)}</button></td><td><span class="ws-graph-reason" title="${esc(edge.reason)}">${esc(edge.reason)}</span></td><td>${edge.evidence.length > 0 ? evidenceChips(ctx, edge.evidence, 3) : '<span class="mu">—</span>'}</td></tr>`;
    })
    .join('');
  return `<div class="tw ws-graph-tw"><table class="tbl ws-graph-tbl"><caption class="sr">${esc(t.table)}</caption><thead><tr><th scope="col">${esc(t.from)}</th><th scope="col">${esc(t.to)}</th><th scope="col">${esc(t.status)}</th><th scope="col">${esc(t.reason)}</th><th scope="col">${esc(t.evidence)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/** Les styles du graphe (jetons du thème : clair et sombre ; motifs de trait par statut, pas la seule couleur). */
export const INCIDENT_GRAPH_CSS = `
.ws-graph{--ws-g-front:var(--qa-color-primary);--ws-g-bff:var(--qa-color-success);--ws-g-back:var(--qa-color-warning);--ws-g-data:color-mix(in srgb,var(--qa-color-success) 45%,var(--qa-color-primary));--ws-g-http:var(--qa-color-muted);display:flex;flex-direction:column;gap:10px;min-width:0}
.ws-graph-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.ws-graph-zoom,.ws-graph-layers{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ws-graph-zoom .btn{align-self:center}
.ws-graph-pct{min-width:52px;text-align:center;font:600 13px var(--qa-font-family-mono);color:var(--qa-color-muted)}
.ws-graph-show{font-size:13px;font-weight:600;color:var(--qa-color-muted)}
.ws-graph-layer{display:inline-flex;align-items:center;gap:6px}
.ws-graph-dot{width:10px;height:10px;border-radius:50%;background:var(--ws-g-http)}
.ws-graph-layer.ws-gg-frontend .ws-graph-dot{background:var(--ws-g-front)}
.ws-graph-layer.ws-gg-bff .ws-graph-dot{background:var(--ws-g-bff)}
.ws-graph-layer.ws-gg-backend .ws-graph-dot{background:var(--ws-g-back)}
.ws-graph-layer.ws-gg-data .ws-graph-dot{background:var(--ws-g-data)}
.ws-graph-layer[aria-pressed="false"]{color:var(--qa-color-muted);text-decoration:line-through}
.ws-graph-layer[aria-pressed="true"] .ws-graph-dot{box-shadow:0 0 0 2px var(--qa-color-surface)}
.ws-graph-errbtn[aria-pressed="true"]{background:var(--qa-color-danger);border-color:var(--qa-color-danger);color:var(--qa-color-surface)}
.ws-graph-msg{margin:0;font-size:13px}
.ws-graph-pathnote{padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--qa-color-danger) 10%,transparent);color:var(--qa-color-text)}
.ws-graph-fig{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.ws-graph-canvas{overflow:auto;max-width:100%;border:1px solid var(--qa-color-border);border-radius:12px;background:linear-gradient(to left,var(--qa-color-background) 40%,transparent) right center/36px 100% no-repeat local,radial-gradient(farthest-side at 100% 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) right center/14px 100% no-repeat scroll,var(--qa-color-background);cursor:grab;touch-action:none}
.ws-graph-canvas:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ws-graph-canvas.panning{cursor:grabbing}
.ws-graph-svg{display:block;flex:none;max-width:none;margin:0 auto;user-select:none}
.ws-graph-reduced{font-size:13px}
.ws-graph-help{margin:0;font-size:12px}
.ws-graph-band{fill:var(--qa-color-surface);stroke:var(--qa-color-border)}
.ws-graph-band-t{font:600 11px var(--qa-font-family);fill:var(--qa-color-muted);letter-spacing:.06em;text-transform:uppercase}
.ws-graph-node{cursor:pointer;outline:none}
.ws-graph-ring{fill:none;stroke:none;pointer-events:none}
.ws-graph-box{fill:var(--qa-color-surface);stroke:var(--qa-color-border-strong);stroke-width:1.5}
.ws-graph-stripe{fill:var(--ws-g-http)}
.ws-graph-node.ws-gg-frontend .ws-graph-box{stroke:var(--ws-g-front)}.ws-graph-node.ws-gg-frontend .ws-graph-stripe{fill:var(--ws-g-front)}
.ws-graph-node.ws-gg-bff .ws-graph-box{stroke:var(--ws-g-bff)}.ws-graph-node.ws-gg-bff .ws-graph-stripe{fill:var(--ws-g-bff)}
.ws-graph-node.ws-gg-backend .ws-graph-box{stroke:var(--ws-g-back)}.ws-graph-node.ws-gg-backend .ws-graph-stripe{fill:var(--ws-g-back)}
.ws-graph-node.ws-gg-data .ws-graph-box{stroke:var(--ws-g-data)}.ws-graph-node.ws-gg-data .ws-graph-stripe{fill:var(--ws-g-data)}
.ws-graph-node.ws-gg-context .ws-graph-stripe{fill:var(--qa-color-text)}
.ws-graph-node.ws-graph-fail .ws-graph-box{stroke:var(--qa-color-danger);fill:color-mix(in srgb,var(--qa-color-danger) 7%,var(--qa-color-surface))}
.ws-graph-node.ws-graph-fail .ws-graph-stripe{fill:var(--qa-color-danger)}
.ws-graph-node.ws-graph-unknown .ws-graph-box{stroke-dasharray:4 3;stroke:var(--qa-color-faint)}
.ws-graph-kind{font:600 10px var(--qa-font-family);fill:var(--qa-color-muted);text-transform:uppercase;letter-spacing:.04em}
.ws-graph-label{font:12px var(--qa-font-family-mono);fill:var(--qa-color-text)}
.ws-graph-node:hover .ws-graph-box{stroke-width:2.5}
.ws-graph-node:focus-visible .ws-graph-box{stroke:var(--qa-color-primary);stroke-width:2.5;stroke-dasharray:none;vector-effect:non-scaling-stroke}
.ws-graph-node:focus-visible .ws-graph-ring{stroke:var(--qa-color-primary);stroke-width:2.5;vector-effect:non-scaling-stroke}
.ws-graph svg .ws-selected,.ws-graph svg .ws-related{outline:none;background:none}
.ws-graph-node.ws-selected .ws-graph-box{stroke:var(--qa-color-primary);stroke-width:3.5}
.ws-graph-node.ws-related .ws-graph-box{fill:color-mix(in srgb,var(--qa-color-primary) 12%,var(--qa-color-surface))}
.ws-graph svg .ws-dimmed{opacity:.3}
.ws-graph svg .ws-graph-onpath.ws-dimmed{opacity:.65}
.ws-graph-edge{cursor:pointer;outline:none}
.ws-graph-hit{fill:none;stroke:transparent;stroke-width:12}
.ws-graph-line{fill:none;stroke-width:2}
.ws-graph-edge.ws-ge-observed .ws-graph-line{stroke:var(--qa-color-primary);stroke-width:2.5}
.ws-graph-edge.ws-ge-statically_resolved .ws-graph-line{stroke:var(--qa-color-success)}
.ws-graph-edge.ws-ge-inferred .ws-graph-line{stroke:var(--qa-color-warning);stroke-dasharray:6 4}
.ws-graph-edge.ws-ge-unknown .ws-graph-line{stroke:var(--qa-color-danger);stroke-dasharray:2 4}
.ws-graph-mk.ws-ge-observed{fill:var(--qa-color-primary)}.ws-graph-mk.ws-ge-statically_resolved{fill:var(--qa-color-success)}.ws-graph-mk.ws-ge-inferred{fill:var(--qa-color-warning)}.ws-graph-mk.ws-ge-unknown{fill:var(--qa-color-danger)}
.ws-graph-edge:hover .ws-graph-line,.ws-graph-edge:focus-visible .ws-graph-line{stroke-width:3.5}
.ws-graph-edge.ws-selected .ws-graph-line{stroke-width:4}
.ws-graph-edge.ws-graph-onpath .ws-graph-line{stroke-width:5}
.ws-graph-node.ws-graph-onpath .ws-graph-box{stroke-width:3.5;stroke:var(--qa-color-danger)}
.ws-graph-errmode .ws-graph-edge:not(.ws-graph-onpath):not(.ws-selected):not(.ws-related){opacity:.35}
.ws-graph-errmode .ws-graph-node:not(.ws-graph-onpath):not(.ws-selected):not(.ws-related){opacity:.6}
.ws-graph-static{font-size:13px}
.ws-graph-detail{display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-graph-detail h3{margin:0;font-size:15px;overflow-wrap:anywhere}
.ws-graph-detail h4{margin:4px 0 0;font-size:13px}
.ws-graph-eyebrow{margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ws-graph-dl{display:grid;grid-template-columns:minmax(80px,max-content) minmax(0,1fr);gap:4px 12px;margin:0}
.ws-graph-dl>div{display:contents}
.ws-graph-dl dt{font-size:12px;color:var(--qa-color-muted);font-weight:600}
.ws-graph-dl dd{margin:0;overflow-wrap:anywhere}
.ws-graph-dnote{font-size:13px}
.ws-graph-rels{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ws-graph-rels li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;justify-content:space-between}
.ws-graph-relbtn,.ws-graph-nodebtn{min-height:32px;overflow-wrap:break-word}
.ws-graph-tbl{min-width:560px;font-size:13px}
.ws-graph-tbl th,.ws-graph-tbl td{padding:4px 8px;vertical-align:top}
.ws-graph-tbl th:nth-child(-n+2),.ws-graph-tbl td:nth-child(-n+2){min-width:148px}
.ws-graph-tbl td:nth-child(4){min-width:18ch}
.ws-graph-tbl .ws-chip{max-width:20ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-graph-tbl .ws-graph-nodebtn{display:inline-block;max-width:28ch;word-break:normal}
.ws-graph-relsel{border:0;background:none;padding:2px 0;cursor:pointer;min-height:28px}
.ws-graph-relsel:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px;border-radius:999px}
.ws-graph-reason{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:30ch;font-size:12px;overflow-wrap:anywhere}
.ws-graph-tbl tr.ws-selected td{background:color-mix(in srgb,var(--qa-color-primary) 10%,transparent)}
.ws-graph-tbl tr.ws-selected{outline:none}
@container (max-width:600px){
  .ws-graph-bar{gap:6px}
  .ws-graph-dl{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){.ws-graph *{transition:none!important}}
`;
