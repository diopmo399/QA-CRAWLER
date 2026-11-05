import type {
  Evidence,
  FieldSheet,
  MapConfidence,
  MapEdge,
  MapNode,
  MapSubgraph,
  MapSummary,
} from '../core/cartography.js';
import type { MapStrings } from './dashboard-cartography-i18n.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * LE GRAPHE LISIBLE D'UN CHAMP. Deux vues, toutes deux tirées des seules données du scan :
 * - le PARCOURS PRINCIPAL : les nœuds atteints depuis le champ choisi par des liens de flux (transmission,
 *   mapping, lecture, écriture), regroupés par couche, de gauche à droite ; une couche absente du parcours
 *   n'a pas de carte (aucun chemin n'est inventé pour remplir les colonnes) ;
 * - le GRAPHE COMPLET : le sous-graphe borné renvoyé par le serveur, étendu à la demande, en colonnes par
 *   couche, ordonné pour limiter les croisements.
 * Les liens parallèles (mêmes extrémités) peuvent être regroupés en un trait et leur nombre ; deux champs
 * ne sont jamais réunis sur leur nom.
 */

export const LAYER_FLOW = ['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE', 'EVENTS', 'OTHER'] as const;
const rankOf = (layer: string): number => {
  const index = (LAYER_FLOW as readonly string[]).indexOf(layer);
  return index < 0 ? LAYER_FLOW.length : index;
};
/** Les liens qui portent la donnée elle-même ; les autres (dépendance à un contrat) s'y rattachent. */
const FLOW_KINDS = new Set(['SENDS', 'TRANSFORMS', 'READS', 'WRITES']);
const CONF_RANK: Record<MapConfidence, number> = { UNKNOWN: 0, PROBABLE: 1, CONFIRMED: 2 };
export const weakest = (
  values: readonly MapConfidence[],
  fallback: MapConfidence = 'UNKNOWN',
): MapConfidence =>
  values.length === 0
    ? fallback
    : values.reduce<MapConfidence>((low, c) => (CONF_RANK[c] < CONF_RANK[low] ? c : low), 'CONFIRMED');

export interface PathGroup {
  layer: string;
  /** Les nœuds de la couche sur le parcours, dans l'ordre où le parcours les atteint. */
  nodes: MapNode[];
  /** Le premier nœud atteint : celui que la carte montre. */
  primary: MapNode;
  /** La confiance la plus faible des liens qui arrivent dans cette étape (ou de la preuve du champ). */
  confidence: MapConfidence;
  /** Les relations au départ de cette étape (à l'arrivée, pour la dernière). */
  relations: MapEdge[];
  /** Les dépendances hors flux (contrat d'API) des nœuds de l'étape. */
  contracts: { edge: MapEdge; node?: MapNode }[];
}

export interface PathLink {
  from: number;
  to: number;
  edges: MapEdge[];
  confidence: MapConfidence;
}

export interface MainPath {
  groups: PathGroup[];
  /** Les traits entre deux cartes voisines : les liens qui franchissent cette frontière. */
  links: PathLink[];
  /** Tous les liens du parcours (flux et dépendances), dans l'ordre des couches. */
  edges: MapEdge[];
  nodes: Map<string, MapNode>;
}

/** Le parcours principal du champ : en avant et en arrière depuis lui, par les seuls liens de flux. */
export function mainPath(sheet: FieldSheet, extra?: MapSubgraph): MainPath {
  const nodes = new Map<string, MapNode>();
  for (const node of [...sheet.graph.nodes, ...(extra?.nodes ?? [])]) nodes.set(node.id, node);
  nodes.set(sheet.node.id, sheet.node);
  const flow = sheet.sequence.filter((e) => FLOW_KINDS.has(e.kind));
  const order = new Map<string, number>([[sheet.node.id, 0]]);
  const walk = (forward: boolean): void => {
    const queue = [sheet.node.id];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      for (const edge of flow) {
        const [here, there] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
        if (here !== current || seen.has(there)) continue;
        seen.add(there);
        if (!order.has(there)) order.set(there, order.size);
        queue.push(there);
      }
    }
  };
  walk(true);
  walk(false);
  const onPath = (id: string): boolean => order.has(id);
  const pathEdges = flow.filter((e) => onPath(e.from) && onPath(e.to));
  const attached = sheet.sequence.filter((e) => !FLOW_KINDS.has(e.kind) && (onPath(e.from) || onPath(e.to)));
  const byLayer = new Map<string, MapNode[]>();
  for (const id of [...order.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
    const node = nodes.get(id);
    if (!node) continue;
    byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), node]);
  }
  const layers = [...byLayer.keys()].sort((a, b) => rankOf(a) - rankOf(b));
  const groupOf = new Map<string, number>();
  layers.forEach((layer, index) => {
    for (const node of byLayer.get(layer) ?? []) groupOf.set(node.id, index);
  });
  const groups: PathGroup[] = layers.map((layer, index) => {
    const members = byLayer.get(layer) ?? [];
    const inGroup = (id: string): boolean => groupOf.get(id) === index;
    const incoming = pathEdges.filter((e) => inGroup(e.to));
    const leaving = [...pathEdges, ...attached].filter((e) => inGroup(e.from));
    const contracts = attached
      .filter((e) => inGroup(e.from))
      .map((edge) => ({ edge, ...(nodes.get(edge.to) ? { node: nodes.get(edge.to) } : {}) }));
    return {
      layer,
      nodes: members,
      primary: members[0] ?? sheet.node,
      confidence:
        incoming.length > 0
          ? weakest(incoming.map((e) => e.confidence))
          : (members[0]?.evidence[0]?.confidence ?? 'UNKNOWN'),
      relations: leaving.length > 0 ? leaving : incoming,
      contracts,
    };
  });
  const links: PathLink[] = [];
  for (let i = 0; i + 1 < groups.length; i += 1) {
    const crossing = pathEdges.filter((e) => {
      const a = groupOf.get(e.from) ?? -1;
      const b = groupOf.get(e.to) ?? -1;
      return Math.min(a, b) <= i && Math.max(a, b) > i;
    });
    links.push({
      from: i,
      to: i + 1,
      edges: crossing,
      confidence: weakest(crossing.map((e) => e.confidence)),
    });
  }
  const edges = [...pathEdges, ...attached].sort(
    (a, b) =>
      (groupOf.get(a.from) ?? 99) - (groupOf.get(b.from) ?? 99) ||
      (groupOf.get(a.to) ?? 99) - (groupOf.get(b.to) ?? 99) ||
      a.id.localeCompare(b.id),
  );
  return { groups, links, edges, nodes };
}

/** Un parcours ordonné (de l'appelant le plus en amont vers l'aval) regroupé par couche, pour les cartes. */
export function chainPath(nodes: readonly MapNode[], edges: readonly MapEdge[]): MainPath {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layers: string[] = [];
  const groupNodes = new Map<string, MapNode[]>();
  for (const node of nodes) {
    if (!groupNodes.has(node.layer)) layers.push(node.layer);
    groupNodes.set(node.layer, [...(groupNodes.get(node.layer) ?? []), node]);
  }
  const groupOf = new Map<string, number>();
  layers.forEach((layer, i) => {
    for (const node of groupNodes.get(layer) ?? []) groupOf.set(node.id, i);
  });
  const groups: PathGroup[] = layers.map((layer, i) => {
    const members = groupNodes.get(layer) ?? [];
    const incoming = edges.filter((e) => groupOf.get(e.to) === i);
    const leaving = edges.filter((e) => groupOf.get(e.from) === i);
    return {
      layer,
      // La carte montre le nœud le plus en aval de la couche (celui qui appelle la suivante).
      nodes: [...members].reverse(),
      primary: members.at(-1) ?? members[0] ?? nodes[0] ?? ({} as MapNode),
      confidence: incoming.length ? weakest(incoming.map((e) => e.confidence)) : 'CONFIRMED',
      relations: leaving.length ? leaving : incoming,
      contracts: [],
    };
  });
  const links: PathLink[] = [];
  for (let i = 0; i + 1 < groups.length; i += 1) {
    const crossing = edges.filter((e) => (groupOf.get(e.from) ?? -1) <= i && (groupOf.get(e.to) ?? -1) > i);
    links.push({
      from: i,
      to: i + 1,
      edges: crossing,
      confidence: weakest(crossing.map((e) => e.confidence)),
    });
  }
  return { groups, links, edges: [...edges], nodes: byId };
}

/** Les extrémités et le libellé court d'un nœud : « conteneur · nom ». */
export function nodeText(node: MapNode | undefined, id: string): { container: string; name: string } {
  if (!node) return { container: '', name: id };
  const container = typeof node.detail.container === 'string' ? node.detail.container : (node.parent ?? '');
  if ((node.kind === 'METHOD' || node.kind === 'SERVICE') && !container && node.name.includes('.')) {
    const cut = node.name.lastIndexOf('.');
    return { container: node.name.slice(0, cut), name: `${node.name.slice(cut + 1)}()` };
  }
  if (node.kind === 'COLUMN' && node.name.includes('.')) {
    const [table, ...rest] = node.name.split('.');
    return { container: table ?? container, name: rest.join('.') };
  }
  return { container, name: node.name };
}

/** La technologie réellement détectée dans la source du nœud, pour sa couche (sinon rien). */
export function technologyOf(summary: MapSummary | undefined, node: MapNode): string | undefined {
  const sourceId = node.evidence.find((e) => e.sourceId)?.sourceId;
  const scan = summary?.scan ?? summary?.running;
  const technologies = (scan?.sources.find((s) => s.sourceId === sourceId)?.technologies ?? [])
    .filter((t) => t.supported)
    .map((t) => t.technology as string);
  const preferred: Record<string, string> = {
    FRONTEND: 'ANGULAR',
    BFF: 'SPRING',
    BACKEND: 'SPRING',
    API: 'OPENAPI',
    DATABASE: 'JPA',
  };
  const chosen = technologies.find((t) => t === preferred[node.layer]) ?? technologies[0];
  const names: Record<string, string> = {
    ANGULAR: 'Angular',
    SPRING: 'Spring',
    JPA: 'JPA',
    OPENAPI: 'OpenAPI',
  };
  return chosen ? (names[chosen] ?? chosen) : undefined;
}

const LAYER_ICON: Record<string, string> = {
  FRONTEND: 'monitor',
  BFF: 'code',
  BACKEND: 'gear',
  API: 'requirements',
  DATABASE: 'data',
};

export type GraphSelection = { kind: 'node'; id: string } | { kind: 'edge'; ids: string[] };

/** Ce que l'écran fournit à la vue du graphe (aucune donnée n'est créée ici). */
export interface TraceContext {
  m: MapStrings;
  summary?: MapSummary;
  sheet: FieldSheet;
  expansion?: MapSubgraph;
  mode: 'path' | 'full';
  grouped: boolean;
  zoom: number;
  panX: number;
  panY: number;
  fullscreen: boolean;
  selection?: GraphSelection;
  /** L'étape dont les relations sont listées (compteur cliqué). */
  step?: string;
  relationsOpen: boolean;
  conf: (value: string) => string;
  evidence: (evidence: Evidence | undefined) => string;
  where: (evidence: Evidence | undefined) => string;
  scanVersion: string;
}

const STATUS_MARK: Record<MapConfidence, string> = { CONFIRMED: 'check', PROBABLE: 'alert', UNKNOWN: 'info' };

/** Ce que les cartes d'un parcours demandent (le champ suivi, ou l'API dont on remonte les appelants). */
export interface PathContext {
  m: MapStrings;
  summary?: MapSummary;
  grouped: boolean;
  selection?: GraphSelection;
  step?: string;
  /** Le nœud mis en avant (le champ choisi). */
  focus: string;
}

/** Une carte finale ajoutée après les couches (l'API elle-même, quand elle n'est pas un nœud du graphe). */
export interface TailCard {
  title: string;
  tech?: string;
  icon: string;
  line1: string;
  line2: string;
  confidence: MapConfidence;
  tone: string;
  /** Le lien qui y mène (les appels de la dernière couche), avec sa confiance. */
  link?: MapConfidence;
}

export function pathCards(ctx: PathContext, path: MainPath, tail?: TailCard): string {
  const { m } = ctx;
  if (path.groups.length === 0 && !tail) return `<p class="mu">${esc(m.g.noPath)}</p>`;
  const selectedNode = ctx.selection?.kind === 'node' ? ctx.selection.id : undefined;
  const selectedEdges = ctx.selection?.kind === 'edge' ? new Set(ctx.selection.ids) : undefined;
  const touched = new Set<string>();
  if (selectedNode) {
    touched.add(selectedNode);
    for (const e of path.edges)
      if (e.from === selectedNode || e.to === selectedNode) {
        touched.add(e.from);
        touched.add(e.to);
      }
  }
  if (selectedEdges)
    for (const e of path.edges)
      if (selectedEdges.has(e.id)) {
        touched.add(e.from);
        touched.add(e.to);
      }
  const parts: string[] = [];
  path.groups.forEach((group, index) => {
    const tech = technologyOf(ctx.summary, group.primary);
    const shown = ctx.grouped ? [group.primary] : group.nodes;
    const rows = shown
      .map((node) => {
        const text = nodeText(node, node.id);
        const state = touched.size === 0 ? '' : touched.has(node.id) ? ' hl' : ' dim';
        return `<button class="map-pn${node.id === ctx.focus ? ' focus' : ''}${node.id === selectedNode ? ' sel' : ''}${state}" data-action="map-g-select" data-kind="node" data-id="${esc(node.id)}" title="${esc(`${node.kind} · ${node.id}`)}"><span>${breakable(text.container)}</span><b>${breakable(text.name)}</b></button>`;
      })
      .join('');
    const hidden =
      ctx.grouped && group.nodes.length > 1
        ? `<small class="map-pc-more" title="${esc(
            group.nodes
              .slice(1)
              .map((n) => nodeText(n, n.id))
              .map((t) => `${t.container}.${t.name}`)
              .join('\n'),
          )}">${esc(m.g.more(group.nodes.length - 1))}</small>`
        : '';
    const contracts = group.contracts.length
      ? `<span class="map-pc-ct" title="${esc(group.contracts.map((c) => c.edge.reason).join('\n'))}">${icon('requirements')}<span>${esc(m.g.contract)} : ${breakable(
          group.contracts
            .map((c) => {
              const t = nodeText(c.node, c.edge.to);
              return t.container ? `${t.container}.${t.name}` : t.name;
            })
            .join(', '),
        )}</span></span>`
      : '';
    const tone = group.confidence.toLowerCase();
    const activeStep = ctx.step === group.layer;
    parts.push(
      `<li class="map-pcard l-${esc(group.layer.toLowerCase())}"><div class="map-pc"><span class="map-pc-h">${icon(LAYER_ICON[group.layer] ?? 'cube')}<span><b>${esc(m.g.layerTitle[group.layer] ?? group.layer)}</b>${tech ? `<small>(${esc(tech)})</small>` : ''}</span></span><span class="map-pc-st c-${tone}" title="${esc(m.confidence[group.confidence] ?? group.confidence)}" aria-label="${esc(m.confidence[group.confidence] ?? group.confidence)}">${icon(STATUS_MARK[group.confidence])}</span><span class="map-pc-b">${rows}${hidden}</span>${contracts}</div><button class="map-pcount${activeStep ? ' on' : ''}" data-action="map-rel-step" data-step="${esc(group.layer)}" aria-pressed="${String(activeStep)}" title="${esc(m.g.linksTitle)}">${esc(m.g.links(group.relations.length))}</button></li>`,
    );
    const link = path.links[index];
    if (link) {
      const tone2 = link.edges.length === 0 ? 'unknown' : link.confidence.toLowerCase();
      const lit = selectedEdges ? link.edges.some((e) => selectedEdges.has(e.id)) : false;
      const arrows =
        ctx.grouped || link.edges.length <= 1
          ? `<span class="map-pa c-${tone2}"></span>${ctx.grouped && link.edges.length > 1 ? `<small>×${String(link.edges.length)}</small>` : ''}`
          : link.edges.map((e) => `<span class="map-pa c-${e.confidence.toLowerCase()}"></span>`).join('');
      parts.push(
        `<li class="map-plink${lit ? ' hl' : ''}" aria-hidden="true"><button tabindex="-1" class="map-pl" data-action="map-g-select" data-kind="edge" data-ids="${esc(link.edges.map((e) => e.id).join(' '))}" title="${esc(link.edges.map((e) => `${m.g.relKinds[e.kind] ?? e.kind} · ${m.confidence[e.confidence] ?? e.confidence}`).join('\n'))}">${arrows}</button></li>`,
      );
    }
  });
  if (tail) {
    if (path.groups.length > 0)
      parts.push(
        `<li class="map-plink" aria-hidden="true"><span class="map-pl"><span class="map-pa c-${(tail.link ?? tail.confidence).toLowerCase()}"></span></span></li>`,
      );
    parts.push(
      `<li class="map-pcard l-${esc(tail.tone)}"><div class="map-pc"><span class="map-pc-h">${icon(tail.icon)}<span><b>${esc(tail.title)}</b>${tail.tech ? `<small>(${esc(tail.tech)})</small>` : ''}</span></span><span class="map-pc-st c-${tail.confidence.toLowerCase()}" title="${esc(m.confidence[tail.confidence] ?? tail.confidence)}">${icon(STATUS_MARK[tail.confidence])}</span><span class="map-pc-b"><span class="map-pn"><span>${breakable(tail.line1)}</span><b>${breakable(tail.line2)}</b></span></span></div></li>`,
    );
  }
  const n = path.groups.length + (tail ? 1 : 0);
  const template =
    n > 1 ? `repeat(${String(n - 1)},minmax(112px,1fr) 30px) minmax(112px,1fr)` : 'minmax(112px,220px)';
  const least = n * 112 + Math.max(0, n - 1) * 30;
  return `<ol class="map-path" style="grid-template-columns:${template};min-width:${String(least)}px" aria-label="${esc(m.g.mainPath)}">${parts.join('')}</ol>`;
}

/** Les colonnes du graphe complet, ordonnées par la moyenne des positions des voisins (moins de croisements). */
function columns(graph: MapSubgraph, focus: string): MapNode[][] {
  const layers = [...new Set(graph.nodes.map((n) => n.layer))].sort((a, b) => rankOf(a) - rankOf(b));
  const kindRank = (n: MapNode): number =>
    n.id === focus ? 0 : n.kind === 'FIELD' || n.kind === 'COLUMN' ? 1 : 2;
  const cols = layers.map((layer) =>
    graph.nodes
      .filter((n) => n.layer === layer)
      .sort(
        (a, b) =>
          kindRank(a) - kindRank(b) ||
          a.kind.localeCompare(b.kind) ||
          (a.label ?? a.name).localeCompare(b.label ?? b.name),
      ),
  );
  const neighbours = new Map<string, string[]>();
  for (const e of graph.edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  for (let pass = 0; pass < 2; pass += 1)
    for (let c = 1; c < cols.length; c += 1) {
      const position = new Map<string, number>();
      for (const col of cols.slice(0, c)) col.forEach((n, i) => position.set(n.id, i));
      const score = (n: MapNode): number => {
        const known = (neighbours.get(n.id) ?? [])
          .map((id) => position.get(id))
          .filter((v): v is number => v !== undefined);
        return known.length ? known.reduce((s, v) => s + v, 0) / known.length : Number.MAX_SAFE_INTEGER;
      };
      const current = cols[c] ?? [];
      cols[c] = [...current].sort((a, b) => kindRank(a) - kindRank(b) || score(a) - score(b));
    }
  return cols;
}

/** Le graphe complet en SVG : colonnes par couche, liens courbes de port à port, regroupés ou non. */
export function fullGraphSvg(
  m: MapStrings,
  graph: MapSubgraph,
  focus: string,
  options: { grouped?: boolean; selection?: GraphSelection } = {},
): string {
  const W = 210;
  const H = 50;
  const GX = 70;
  const GY = 16;
  const cols = columns(graph, focus);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, c) => {
    col.forEach((n, row) => pos.set(n.id, { x: 12 + c * (W + GX), y: 34 + row * (H + GY) }));
  });
  const width = Math.max(24 + cols.length * (W + GX) - GX, 240);
  const height = Math.max(...cols.map((col) => 34 + col.length * (H + GY)), 140) + 10;
  const sel = options.selection;
  const selNode = sel?.kind === 'node' ? sel.id : undefined;
  const selEdges = sel?.kind === 'edge' ? new Set(sel.ids) : undefined;
  const near = new Set<string>();
  if (selNode) {
    near.add(selNode);
    for (const e of graph.edges)
      if (e.from === selNode || e.to === selNode) {
        near.add(e.from);
        near.add(e.to);
      }
  }
  if (selEdges)
    for (const e of graph.edges)
      if (selEdges.has(e.id)) {
        near.add(e.from);
        near.add(e.to);
      }
  // Les liens parallèles (mêmes extrémités) : un trait et leur nombre, ou un trait chacun, décalés.
  const bundles = new Map<string, MapEdge[]>();
  for (const e of graph.edges)
    bundles.set(`${e.from}|${e.to}`, [...(bundles.get(`${e.from}|${e.to}`) ?? []), e]);
  const lines: string[] = [];
  for (const bundle of bundles.values()) {
    const first = bundle[0];
    if (!first) continue;
    const a = pos.get(first.from);
    const b = pos.get(first.to);
    if (!a || !b) continue;
    const draw = options.grouped === false ? bundle.map((e) => [e]) : [bundle];
    draw.forEach((edges, k) => {
      const offset = (k - (draw.length - 1) / 2) * 6;
      const x1 = a.x + (b.x >= a.x ? W : 0);
      const x2 = b.x + (b.x >= a.x ? 0 : W);
      const y1 = a.y + H / 2 + offset;
      const y2 = b.y + H / 2 + offset;
      const d =
        a.x === b.x
          ? `M${String(a.x + W)} ${String(y1)} C${String(a.x + W + 44)} ${String(y1)} ${String(b.x + W + 44)} ${String(y2)} ${String(b.x + W)} ${String(y2)}`
          : `M${String(x1)} ${String(y1)} C${String((x1 + x2) / 2)} ${String(y1)} ${String((x1 + x2) / 2)} ${String(y2)} ${String(x2)} ${String(y2)}`;
      const conf = weakest(edges.map((e) => e.confidence));
      const ids = edges.map((e) => e.id);
      const lit = selEdges
        ? ids.some((id) => selEdges.has(id))
        : selNode
          ? edges.some((e) => e.from === selNode || e.to === selNode)
          : false;
      const state = sel ? (lit ? ' hl' : ' dim') : '';
      const title = edges
        .map(
          (e) =>
            `${m.g.relKinds[e.kind] ?? e.kind} · ${m.confidence[e.confidence] ?? e.confidence} · ${e.reason}`,
        )
        .join('\n');
      const label =
        edges.length > 1
          ? `<text class="map-g-cnt" x="${String((x1 + x2) / 2)}" y="${String((y1 + y2) / 2 - 4)}">${esc(m.g.links(edges.length))}</text>`
          : '';
      lines.push(
        `<g class="map-g-eg${state}"><path class="map-g-e c-${conf.toLowerCase()}" d="${d}" marker-end="url(#map-arrow-${conf.toLowerCase()})"/><path class="map-g-hit" d="${d}" data-action="map-g-select" data-kind="edge" data-ids="${esc(ids.join(' '))}"><title>${esc(title)}</title></path>${label}</g>`,
      );
    });
  }
  const heads = cols
    .map((col, c) => {
      const layer = col[0]?.layer ?? '';
      return `<text class="map-g-t" x="${String(12 + c * (W + GX))}" y="20">${esc(m.layers[layer] ?? layer)}</text>`;
    })
    .join('');
  const boxes = graph.nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return '';
      const text = nodeText(n, n.id);
      const field = n.kind === 'FIELD' || n.kind === 'COLUMN';
      const state = sel ? (near.has(n.id) ? ' hl' : ' dim') : '';
      const sub = `${n.kind}${text.container ? ` · ${text.container}` : ''}`;
      return `<g class="map-g-n${n.id === focus ? ' focus' : ''}${n.id === selNode ? ' sel' : ''}${field ? ' field' : ''} l-${esc(n.layer.toLowerCase())}${state}" data-action="map-g-select" data-kind="node" data-id="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(`${n.label ?? n.name} (${sub})`)}"><rect x="${String(p.x)}" y="${String(p.y)}" width="${String(W)}" height="${String(H)}" rx="9"/><text x="${String(p.x + 12)}" y="${String(p.y + 21)}" >${esc(trim(n.label ?? text.name, 28))}</text><text x="${String(p.x + 12)}" y="${String(p.y + 38)}" class="sub">${esc(trim(sub, 34))}</text><title>${esc(`${n.kind} · ${n.id}`)}</title></g>`;
    })
    .join('');
  const marker = (tone: string): string =>
    `<marker id="map-arrow-${tone}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="map-g-m c-${tone}"/></marker>`;
  return `<svg class="map-graph" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${esc(m.g.fullGraph)}"><defs>${marker('confirmed')}${marker('probable')}${marker('unknown')}</defs>${heads}${lines.join('')}${boxes}</svg>`;
}

const trim = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Un identifiant long se coupe aux changements de mot (camelCase, points, soulignés), jamais au hasard. */
export const breakable = (text: string): string =>
  esc(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1<wbr>$2')
    .replace(/([._/])/g, '$1<wbr>');

/** Un chemin de preuve court à lire (début et fichier) ; le chemin entier reste au survol. */
export function shortPath(file: string, line?: number): string {
  const parts = file.split('/');
  const short = parts.length > 3 ? `${parts.slice(0, 2).join('/')}/…/${parts.at(-1) ?? ''}` : file;
  return `${short}${line ? `:${String(line)}` : ''}`;
}

function legend(ctx: TraceContext, edges: readonly MapEdge[]): string {
  const { m } = ctx;
  const count = (c: MapConfidence): number => edges.filter((e) => e.confidence === c).length;
  return `<div class="map-legend2"><span class="lg c-confirmed">${icon('check')}${esc(m.g.legendConfirmed(count('CONFIRMED')))}</span><span class="lg c-probable">${icon('alert')}${esc(m.g.legendProbable(count('PROBABLE')))}</span><span class="lg c-unknown"><i></i>${esc(m.g.legendUnknown(count('UNKNOWN')))}</span><span class="lg flow"><i></i>${esc(m.g.legendFlow)}</span><label class="map-switch" title="${esc(m.g.groupHelp)}"><input type="checkbox" role="switch" data-map="group-parallel" ${ctx.grouped ? 'checked' : ''}><span class="tr" aria-hidden="true"></span>${esc(m.g.groupParallel)} ${icon('info')}</label></div>`;
}

function relationsTable(
  ctx: TraceContext,
  edges: readonly MapEdge[],
  nodes: Map<string, MapNode>,
  scope: string,
): string {
  const { m } = ctx;
  const selected = ctx.selection?.kind === 'edge' ? new Set(ctx.selection.ids) : undefined;
  const label = (id: string): string => {
    const t = nodeText(nodes.get(id), id);
    return t.container ? `${t.container}.${t.name}` : t.name;
  };
  const kindOf = (e: MapEdge): string =>
    e.kind === 'TRANSFORMS' && nodes.get(e.to)?.kind === 'COLUMN' ? 'PERSISTS' : e.kind;
  const rows = edges
    .map((e, i) => {
      const ev = e.evidence.find((x) => x.file) ?? e.evidence[0];
      return `<tr class="${selected?.has(e.id) ? 'sel' : ''}"><td class="num"><button class="lnk" data-action="map-g-select" data-kind="edge" data-ids="${esc(e.id)}" aria-label="${esc(`${m.g.selEdge} ${String(i + 1)}`)}">${String(i + 1)}</button></td><td class="mono" title="${esc(e.from)}">${breakable(label(e.from))}</td><td class="mono" title="${esc(e.to)}">${breakable(label(e.to))}</td><td>${esc(m.g.relKinds[kindOf(e)] ?? m.edgeKinds[e.kind] ?? e.kind)}</td><td>${ctx.conf(e.confidence)}</td><td class="map-rel-ev" title="${esc(`${ev?.file ? `${ev.file}:${String(ev.line ?? '')} · ` : ''}${e.reason}`)}">${ev?.file ? `<code class="map-loc">${breakable(shortPath(ev.file, ev.line))}</code>` : `<small class="mu">${esc(m.g.noEvidenceFile)}</small>`}</td><td>${ctx.evidence(ev)}</td></tr>`;
    })
    .join('');
  const head = `<tr><th class="num">${esc(m.g.colNum)}</th><th>${esc(m.g.colFrom)}</th><th>${esc(m.g.colTo)}</th><th>${esc(m.g.colType)}</th><th>${esc(m.g.colConfidence)}</th><th>${esc(m.g.colEvidence)}</th><th></th></tr>`;
  const reset = scope
    ? `<span class="map-rel-scope">${esc(scope)} <button class="lnk" data-action="map-rel-all">${esc(m.g.showAll)}</button></span>`
    : '';
  return `<details class="map-rel"${ctx.relationsOpen ? ' open' : ''} data-map-rel><summary data-action="map-rel-toggle"><span>${esc(m.g.relations(edges.length))}</span>${reset}</summary><div class="tbl-w"><table class="tbl map-tbl map-rel-t"><colgroup><col style="width:30px"><col><col><col style="width:13%"><col style="width:13%"><col style="width:20%"><col style="width:12%"></colgroup><thead>${head}</thead><tbody>${rows}</tbody></table></div></details>`;
}

function selectionCard(ctx: TraceContext, nodes: Map<string, MapNode>, edges: readonly MapEdge[]): string {
  const { m } = ctx;
  const sel = ctx.selection;
  if (!sel) return '';
  const close = `<button class="btn small ghost icon-only" data-action="map-g-clear" aria-label="${esc(m.g.clearSel)}" title="${esc(m.g.clearSel)}">${icon('close')}</button>`;
  const evidenceList = (list: readonly Evidence[]): string =>
    list.length
      ? `<ul class="map-ev-l">${list
          .slice(0, 5)
          .map(
            (e) =>
              `<li>${e.file ? ctx.where(e) : `<small class="mu">${esc(m.g.noEvidenceFile)}</small>`}${e.symbol ? ` <code class="map-loc">${esc(e.symbol)}</code>` : ''} ${ctx.conf(e.confidence)}${e.detail ? ` <small class="mu">${esc(e.detail)}</small>` : ''} ${ctx.evidence(e)}</li>`,
          )
          .join('')}</ul>`
      : '';
  if (sel.kind === 'node') {
    const node = nodes.get(sel.id);
    if (!node) return '';
    const text = nodeText(node, node.id);
    const type = typeof node.detail.type === 'string' ? node.detail.type : '';
    const open =
      (node.kind === 'FIELD' || node.kind === 'COLUMN') && node.id !== ctx.sheet.node.id
        ? `<button class="btn small" data-action="map-field" data-field="${esc(node.id)}">${icon('eye')}<span>${esc(m.g.openField)}</span></button>`
        : '';
    const expand =
      ctx.mode === 'full'
        ? `<button class="btn small" data-action="map-expand" data-node="${esc(node.id)}">${icon('plus')}<span>${esc(m.g.expandNode)}</span></button>`
        : '';
    return `<section class="map-gsel" aria-label="${esc(m.g.selNode)}"><div class="card-h"><h4>${esc(m.g.selNode)} · <b>${esc(node.label ?? text.name)}</b> <small class="mu">${esc(`${node.kind}${text.container ? ` · ${text.container}` : ''}${type ? ` · ${type}` : ''}`)}</small></h4>${close}</div><p class="mono small mu">${esc(node.id)}</p>${evidenceList(node.evidence)}<div class="map-decide">${open}${expand}</div></section>`;
  }
  const chosen = edges.filter((e) => sel.ids.includes(e.id));
  if (chosen.length === 0) return '';
  const label = (id: string): string => {
    const t = nodeText(nodes.get(id), id);
    return t.container ? `${t.container}.${t.name}` : t.name;
  };
  return `<section class="map-gsel" aria-label="${esc(m.g.selEdge)}"><div class="card-h"><h4>${esc(m.g.selEdge)}${chosen.length > 1 ? ` (${String(chosen.length)})` : ''}</h4>${close}</div>${chosen
    .map(
      (e) =>
        `<div class="map-gsel-e"><p><b class="mono">${esc(label(e.from))}</b> → <b class="mono">${esc(label(e.to))}</b> · ${esc(m.g.relKinds[e.kind] ?? e.kind)} ${ctx.conf(e.confidence)} <small class="mu">${esc(ctx.scanVersion)}</small></p><p class="small"><b>${esc(m.g.justification)} :</b> ${esc(e.reason)}</p>${evidenceList(e.evidence)}</div>`,
    )
    .join('')}</section>`;
}

/** La vue « Traçabilité (vue graphe) » d'un champ : barre d'outils, parcours ou graphe, légende, relations. */
export function traceView(ctx: TraceContext): string {
  const { m, sheet } = ctx;
  const path = mainPath(sheet, ctx.expansion);
  const full: MapSubgraph = ctx.expansion
    ? {
        ...sheet.graph,
        nodes: [...new Map([...sheet.graph.nodes, ...ctx.expansion.nodes].map((n) => [n.id, n])).values()],
        edges: [...new Map([...sheet.graph.edges, ...ctx.expansion.edges].map((e) => [e.id, e])).values()],
        truncated: sheet.graph.truncated || ctx.expansion.truncated,
      }
    : sheet.graph;
  const nodes = new Map([...path.nodes, ...full.nodes.map((n) => [n.id, n] as const)]);
  const viewEdges = ctx.mode === 'path' ? path.edges : full.edges;
  let listed: readonly MapEdge[] = viewEdges;
  let scope = '';
  if (ctx.mode === 'path' && ctx.step) {
    listed = path.groups.find((g) => g.layer === ctx.step)?.relations ?? [];
    scope = m.g.relStep(m.g.layerTitle[ctx.step] ?? ctx.step);
  } else if (ctx.selection?.kind === 'node') {
    const id = ctx.selection.id;
    listed = viewEdges.filter((e) => e.from === id || e.to === id);
    scope = m.g.relSelection;
  }
  const toolbar = `<div class="map-gtools"><div class="map-seg" role="tablist" aria-label="${esc(m.p.centerTabs.trace)}"><button role="tab" data-action="map-g-mode" data-mode="path" aria-selected="${String(ctx.mode === 'path')}">${esc(m.g.mainPath)}</button><button role="tab" data-action="map-g-mode" data-mode="full" aria-selected="${String(ctx.mode === 'full')}">${esc(m.g.fullGraph)}</button></div><span class="map-gbtns"><button class="btn small icon-only" data-action="map-g-full" aria-pressed="${String(ctx.fullscreen)}" aria-label="${esc(ctx.fullscreen ? m.g.exitFullscreen : m.g.fullscreen)}" title="${esc(ctx.fullscreen ? m.g.exitFullscreen : m.g.fullscreen)}">${icon(ctx.fullscreen ? 'minimize' : 'maximize')}</button><button class="btn small icon-only" data-action="map-g-fit" aria-label="${esc(m.g.fit)}" title="${esc(m.g.fit)}">${icon('fit')}</button><button class="btn small icon-only" data-action="map-g-zoom" data-dir="-1" aria-label="${esc(m.g.zoomOut)}" title="${esc(m.g.zoomOut)}">${icon('minus')}</button><output class="map-gzoom" aria-live="polite">${esc(m.g.zoomLevel(ctx.zoom))}</output><button class="btn small icon-only" data-action="map-g-zoom" data-dir="1" aria-label="${esc(m.g.zoomIn)}" title="${esc(m.g.zoomIn)}">${icon('plus')}</button>${ctx.mode === 'full' && ctx.expansion ? `<button class="btn small" data-action="map-g-collapse">${esc(m.g.collapse)}</button>` : ''}</span></div>`;
  const content =
    ctx.mode === 'path'
      ? pathCards({ ...ctx, focus: sheet.node.id }, path)
      : fullGraphSvg(m, full, sheet.node.id, {
          grouped: ctx.grouped,
          ...(ctx.selection ? { selection: ctx.selection } : {}),
        });
  const canvas = `<div class="map-canvas ${ctx.mode}" data-map-canvas tabindex="0" aria-label="${esc(m.p.traceOf(sheet.node.label ?? sheet.node.name))}"><div class="map-canvas-in" style="transform:translate(${String(ctx.panX)}px,${String(ctx.panY)}px) scale(${String(ctx.zoom)})">${content}</div></div>`;
  const truncated =
    ctx.mode === 'full' && full.truncated
      ? `<p class="map-note warn-t small" role="note">${esc(m.p.truncated(full.limit, full.depth))}</p>`
      : '';
  const title = `<div class="map-gtitle"><h3>${esc(m.p.traceOf(''))}<b>${esc(sheet.node.label ?? sheet.node.name)}</b> ${ctx.conf(sheet.concept.status)}</h3>${toolbar}</div>`;
  const gaps = sheet.concept.gaps.length
    ? `<h3>${esc(m.gaps)}</h3><ul class="map-why warn-t">${sheet.concept.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`
    : '';
  const homonyms = sheet.concept.homonyms.length
    ? `<h3>${esc(m.homonyms)}</h3><ul class="map-reuse-l">${sheet.concept.homonyms.map((h) => `<li>${esc(h.name)} <small class="mu">${esc(h.layers.map((l) => m.layers[l] ?? l).join(' → '))}</small></li>`).join('')}</ul>`
    : '';
  return `<div class="map-trace${ctx.fullscreen ? ' full' : ''}" data-map-trace>${title}${truncated}${canvas}${legend(ctx, viewEdges)}${selectionCard(ctx, nodes, viewEdges)}${relationsTable(ctx, listed, nodes, scope)}${gaps}${homonyms}</div>`;
}

export const GRAPH_CSS = `
.map-trace{display:flex;flex-direction:column;gap:10px;min-width:0}
.map-trace.full{position:fixed;inset:12px;z-index:60;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:14px;padding:16px;overflow:auto;box-shadow:0 20px 60px rgba(15,40,30,.25)}
.map-trace.full .map-canvas{height:calc(100vh - 300px);min-height:320px}
.map-gtitle{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between}
.map-gtitle h3{margin:0;font-size:14px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.map-gtools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.map-gtools .map-seg{display:inline-flex;border:1px solid var(--qa-color-border);border-radius:8px;overflow:hidden;background:var(--qa-color-surface-2)}
.map-gtools .map-seg button{border:0;background:transparent;padding:6px 12px;font-size:12px;font-weight:600;color:var(--qa-color-muted);cursor:pointer;white-space:nowrap}
.map-gtools .map-seg button[aria-selected="true"]{background:var(--qa-color-primary);color:#fff}
.map-gbtns{display:inline-flex;gap:4px;align-items:center}
.map-gbtns .btn.icon-only{width:30px;height:30px;min-height:30px;padding:0}
.map-gzoom{font-size:11px;color:var(--qa-color-muted);min-width:38px;text-align:center}
.map-canvas{position:relative;overflow:hidden;border:1px solid var(--qa-color-border);border-radius:10px;background:linear-gradient(var(--qa-color-surface),var(--qa-color-surface)) padding-box,radial-gradient(circle,var(--qa-color-border) 1px,transparent 1px) 0 0/16px 16px;cursor:grab;touch-action:none}
.map-canvas.path{min-height:200px}
.map-canvas.full{height:420px}
.map-canvas.dragging{cursor:grabbing}
.map-canvas:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.map-canvas-in{transform-origin:0 0;width:max-content;min-width:100%;padding:22px 16px}
.map-canvas.path .map-canvas-in{width:100%;min-width:0;padding:20px 14px}
.map-path{list-style:none;margin:0;padding:0;display:grid;align-items:start;gap:0}
.map-pcard{display:flex;flex-direction:column;align-items:center;gap:10px;min-width:0}
.map-pc{position:relative;width:100%;display:flex;flex-direction:column;gap:6px;padding:10px 10px 12px;border:1px solid color-mix(in srgb,var(--lane-b,#7c5cd6) 45%,var(--qa-color-border));border-radius:12px;background:var(--lane,var(--qa-color-surface-2));box-shadow:0 1px 2px rgba(15,40,30,.06)}
.map-pcard.l-frontend{--lane:color-mix(in srgb,#7c5cd6 12%,var(--qa-color-surface));--lane-b:#7c5cd6}
.map-pcard.l-bff{--lane:color-mix(in srgb,#2f80c8 12%,var(--qa-color-surface));--lane-b:#2f80c8}
.map-pcard.l-backend{--lane:color-mix(in srgb,var(--qa-color-success) 14%,var(--qa-color-surface));--lane-b:var(--qa-color-success)}
.map-pcard.l-api{--lane:color-mix(in srgb,#5b6b7a 10%,var(--qa-color-surface));--lane-b:#5b6b7a}
.map-pcard.l-database{--lane:color-mix(in srgb,var(--qa-color-warning) 16%,var(--qa-color-surface));--lane-b:var(--qa-color-warning)}
.map-pc-h{display:flex;gap:8px;align-items:center;padding-right:18px}
.map-pc-h .ico{width:22px;height:22px;flex:none;color:var(--lane-b)}
.map-pc-h span{display:flex;flex-direction:column;line-height:1.15}
.map-pc-h b{font-size:12.5px}
.map-pc-h small{font-size:11px;color:var(--qa-color-muted)}
.map-pc-st{position:absolute;top:-8px;right:-8px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;color:#fff;border:2px solid var(--qa-color-surface)}
.map-pc-st .ico{width:12px;height:12px}
.map-pc-st.c-confirmed{background:var(--qa-color-success)}
.map-pc-st.c-probable{background:var(--qa-color-warning)}
.map-pc-st.c-unknown{background:var(--qa-color-muted)}
.map-pc-b{display:flex;flex-direction:column;gap:4px}
.map-pn{display:flex;flex-direction:column;align-items:center;gap:1px;width:100%;padding:6px 4px;border:1px solid transparent;border-radius:8px;background:color-mix(in srgb,var(--qa-color-surface) 70%,transparent);color:inherit;cursor:pointer;text-align:center;font:inherit}
.map-pn span{font-size:11px;line-height:1.3}
.map-pn b{font-size:11.5px;font-weight:600;line-height:1.3}
.map-pn:hover,.map-pn.hl{border-color:var(--lane-b)}
.map-pn.sel{border-color:var(--qa-color-primary);box-shadow:0 0 0 1px var(--qa-color-primary)}
.map-pn.dim{opacity:.45}
.map-pn.focus b{color:var(--qa-color-primary-2)}
.map-pn:focus-visible,.map-pcount:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.map-pc-more{align-self:center;font-size:11px;color:var(--qa-color-muted)}
.map-pc-ct{display:flex;gap:4px;align-items:center;font-size:10.5px;color:var(--qa-color-muted);border-top:1px dashed var(--qa-color-border);padding-top:5px}
.map-pc-ct .ico{width:12px;height:12px;flex:none}
.map-pc-ct>span{min-width:0}
.map-pcount{border:1px solid var(--qa-color-border);background:var(--qa-color-surface);border-radius:7px;padding:3px 12px;font-size:11.5px;font-weight:600;color:var(--qa-color-text);cursor:pointer}
.map-pcount:hover,.map-pcount.on{border-color:var(--qa-color-primary);color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft-2)}
.map-plink{align-self:stretch;display:flex;align-items:flex-start;padding:46px 3px 0}
.map-pl{display:flex;flex-direction:column;gap:3px;align-items:center;width:100%;border:0;background:transparent;padding:4px 0;cursor:pointer;color:var(--qa-color-muted)}
.map-pl small{font-size:10px}
.map-pa{position:relative;display:block;width:100%;height:0;border-top:2px solid var(--qa-color-success)}
.map-pa::after{content:"";position:absolute;right:-1px;top:-6px;border:5px solid transparent;border-left:8px solid var(--qa-color-success);border-right:0}
.map-pa.c-probable{border-top:2px dashed var(--qa-color-warning)}
.map-pa.c-probable::after{border-left-color:var(--qa-color-warning)}
.map-pa.c-unknown{border-top:2px dashed var(--qa-color-muted)}
.map-pa.c-unknown::after{border-left-color:var(--qa-color-muted)}
.map-plink.hl .map-pa{border-top-width:3px}
.map-legend2{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;font-size:12px;padding:8px 12px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.map-legend2 .lg{display:inline-flex;gap:5px;align-items:center}
.map-legend2 .lg .ico{width:14px;height:14px}
.map-legend2 .c-confirmed .ico{color:var(--qa-color-success)}
.map-legend2 .c-probable .ico{color:var(--qa-color-warning)}
.map-legend2 .c-unknown i{width:14px;height:14px;border:2px dashed var(--qa-color-muted);border-radius:4px}
.map-legend2 .flow i{width:22px;border-top:2px solid var(--qa-color-text);position:relative}
.map-legend2 .flow i::after{content:"";position:absolute;right:-2px;top:-5px;border:4px solid transparent;border-left:6px solid var(--qa-color-text);border-right:0}
.map-switch{margin-left:auto;display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.map-switch input{position:absolute;opacity:0;width:1px;height:1px}
.map-switch .tr{width:32px;height:18px;border-radius:999px;background:var(--qa-color-border-strong);position:relative;transition:background .15s}
.map-switch .tr::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--qa-color-surface);transition:left .15s}
.map-switch input:checked+.tr{background:var(--qa-color-primary)}
.map-switch input:checked+.tr::after{left:16px}
.map-switch input:focus-visible+.tr{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.map-switch .ico{width:14px;height:14px;color:var(--qa-color-muted)}
.map-gsel{border:1px solid var(--qa-color-primary);border-radius:10px;padding:8px 12px;background:var(--qa-color-primary-soft-2)}
.map-gsel h4{margin:0;font-size:13px}
.map-gsel p{margin:4px 0}
.map-gsel-e+.map-gsel-e{border-top:1px solid var(--qa-color-border);margin-top:6px;padding-top:6px}
.map-rel{border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.map-rel summary{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 12px;font-weight:600;cursor:pointer}
.map-rel-scope{font-weight:400;font-size:12px;color:var(--qa-color-muted)}
.map-rel .tbl-w{max-height:280px;overflow:auto}
.map-rel-t{table-layout:fixed;width:100%}
.map-rel-t td,.map-rel-t th{font-size:11.5px;padding:6px 6px;vertical-align:middle;white-space:normal}
.map-rel-t td.mono{font-size:11px}
.map-rel-t .map-ev-btn{white-space:nowrap;font-size:11px}
.map-rel-t tr.sel td{background:var(--qa-color-primary-soft-2)}
.map-rel-ev .map-loc{font-size:11px}
.map-graph .map-g-n.field rect{stroke-width:1.5}
.map-graph .map-g-n.l-frontend rect{fill:color-mix(in srgb,#7c5cd6 9%,var(--qa-color-surface))}
.map-graph .map-g-n.l-bff rect{fill:color-mix(in srgb,#2f80c8 9%,var(--qa-color-surface))}
.map-graph .map-g-n.l-backend rect{fill:color-mix(in srgb,var(--qa-color-success) 10%,var(--qa-color-surface))}
.map-graph .map-g-n.l-database rect{fill:color-mix(in srgb,var(--qa-color-warning) 12%,var(--qa-color-surface))}
.map-graph .map-g-n.sel rect{stroke:var(--qa-color-primary);stroke-width:3}
.map-graph .dim{opacity:.3}
.map-graph .map-g-eg.hl .map-g-e{stroke-width:3}
.map-graph .map-g-hit{fill:none;stroke:transparent;stroke-width:12;cursor:pointer;pointer-events:stroke}
.map-graph .map-g-cnt{font-size:10px;fill:var(--qa-color-muted);text-anchor:middle}
.map-graph .map-g-m.c-confirmed{fill:var(--qa-color-success)}
.map-graph .map-g-m.c-probable{fill:var(--qa-color-warning)}
.map-graph .map-g-m.c-unknown{fill:var(--qa-color-muted)}
.map-graph .map-g-e.c-unknown{stroke:var(--qa-color-muted)}
.map-graph .map-g-e.c-confirmed{stroke:var(--qa-color-success)}
.map-graph:hover .map-g-eg:not(:hover):not(.hl) .map-g-e{opacity:.55}
@media (max-width:640px){.map-gtitle{flex-direction:column;align-items:flex-start}.map-switch{margin-left:0}}
`;
