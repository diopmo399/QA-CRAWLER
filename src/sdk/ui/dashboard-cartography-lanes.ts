import type {
  ApiOutbound,
  ApiService,
  Evidence,
  MapConfidence,
  MapEdge,
  MapNode,
  MapSubgraph,
  MapSummary,
} from '../core/cartography.js';
import { breakable, idList, nodeText, technologyOf, weakest } from './dashboard-cartography-graph.js';
import type { MapStrings } from './dashboard-cartography-i18n.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * LE GRAPHE ENRICHI D'UNE API, EN COULOIRS : une colonne par couche (Frontend, BFF, Backend), puis les
 * couloirs terminaux empilés (API externe, à classifier, contrats, base de données…). Les nœuds d'un même
 * conteneur forment une carte (classe et ses méthodes, composant et ses champs, DTO et ses propriétés, table
 * et ses colonnes). Les relations entre cartes de deux couloirs forment un faisceau : un seul tracé
 * orthogonal avec son compteur « N liens », que l'on inspecte (liste et preuves) puis que l'on déplie.
 * Rien n'est créé : chaque relation dessinée est une relation du scan (ou un appel sortant qu'il a établi).
 */

export const LANE_ORDER = [
  'FRONTEND',
  'BFF',
  'BACKEND',
  'EXTERNAL',
  'UNCLASSIFIED',
  'API',
  'DATABASE',
  'EVENTS',
  'OTHER',
] as const;
export type LaneId = (typeof LANE_ORDER)[number];
/** Les couloirs terminaux : empilés dans la dernière colonne. */
const STACKED: ReadonlySet<string> = new Set([
  'EXTERNAL',
  'UNCLASSIFIED',
  'API',
  'DATABASE',
  'EVENTS',
  'OTHER',
]);
export type Nature = 'flow' | 'external' | 'db';
export const NATURES: readonly Nature[] = ['flow', 'external', 'db'];
export const STATUSES: readonly MapConfidence[] = ['CONFIRMED', 'PROBABLE', 'UNKNOWN'];
export type GraphView = 'architecture' | 'data';

/** Ce que l'on masque (listes vides : rien) et la profondeur (0 : toutes). */
export interface LaneFilters {
  lanes: string[];
  natures: string[];
  statuses: string[];
  depth: number;
}
export const NO_FILTERS: LaneFilters = { lanes: [], natures: [], statuses: [], depth: 0 };
export const filtersActive = (f: LaneFilters): boolean =>
  f.lanes.length > 0 || f.natures.length > 0 || f.statuses.length > 0 || f.depth > 0;

export type CardKind =
  'COMPONENT' | 'CONTAINER' | 'BUTTON' | 'CLASS' | 'ENDPOINT' | 'DTO' | 'TABLE' | 'EXTERNAL' | 'OTHER';
export interface LaneMember {
  id: string;
  text: string;
  kind: 'method' | 'field' | 'column' | 'out' | 'in' | 'condition';
}
export interface LaneCard {
  key: string;
  lane: LaneId;
  kind: CardKind;
  title: string;
  sub?: string;
  nodes: string[];
  members: LaneMember[];
  /** La relation la plus sûre qui la relie dans cette vue (UNKNOWN : aucune). */
  status: MapConfidence;
  /** Un élément de l'API elle-même (son endpoint servi, ou sa cible externe). */
  own: boolean;
  /** Sauts depuis l'API (cartes reliées) ; Infinity : non reliée dans cette vue. */
  depth: number;
}
export interface LaneLink {
  key: string;
  from: string;
  to: string;
  nature: Nature;
  edges: MapEdge[];
  confidence: MapConfidence;
}
export interface LaneBundle {
  key: string;
  from: LaneId;
  to: LaneId;
  nature: Nature;
  links: LaneLink[];
  count: number;
  confidence: MapConfidence;
  statuses: Record<MapConfidence, number>;
}
export interface LaneModel {
  lanes: { id: LaneId; cards: LaneCard[]; internal: LaneLink[] }[];
  cards: Map<string, LaneCard>;
  bundles: LaneBundle[];
  /** Les relations entre nœuds d'une même carte (appartenance) : listées, jamais dessinées. */
  inner: MapEdge[];
  /** Toutes les relations de la vue (y compris les appels sortants établis), avant les critères d'affichage. */
  all: MapEdge[];
  /** Les relations dessinées (entre cartes), après les critères d'affichage. */
  shown: MapEdge[];
  nodes: Map<string, MapNode>;
  /** Cartes masquées par les critères d'affichage ; cartes hors de la vue choisie (sans flux de données). */
  hiddenCards: number;
  viewHidden: number;
  cardOfNode: Map<string, string>;
}

const ARCH_KINDS: ReadonlySet<string> = new Set([
  'CALLS',
  'DEPENDS_ON',
  'READS',
  'WRITES',
  // La structure conditionnelle : contenu, conditions, valeurs pilotées, actions déclenchées.
  'CONTAINS',
  'VISIBLE_WHEN',
  'ENABLED_WHEN',
  'CONTROLLED_BY',
  'TRIGGERS',
]);
const DATA_KINDS: ReadonlySet<string> = new Set([
  'SENDS',
  'TRANSFORMS',
  'READS',
  'WRITES',
  'INPUTS',
  'DISPLAYS',
  'CONTROLLED_BY',
]);
const RANK: Record<MapConfidence, number> = { UNKNOWN: 0, PROBABLE: 1, CONFIRMED: 2 };
const strongest = (list: readonly MapConfidence[]): MapConfidence =>
  list.reduce<MapConfidence>((best, c) => (RANK[c] > RANK[best] ? c : best), 'UNKNOWN');
const sourceOf = (id: string): string => id.split(':')[1] ?? '';
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Le propriétaire d'une méthode : le champ « owner » du scan, sinon le symbole de son identifiant. */
function ownerOf(node: MapNode): { owner: string; method: string } {
  const owner = str(node.detail.owner);
  const tail = node.id.split(':').slice(2).join(':');
  const [left = '', right = ''] = tail.split('#');
  const symbol = right || left;
  if (owner)
    return { owner, method: symbol.startsWith(`${owner}.`) ? symbol.slice(owner.length + 1) : symbol };
  if (left && right && !left.includes('/')) return { owner: left, method: right };
  const cut = symbol.lastIndexOf('.');
  return cut > 0
    ? { owner: symbol.slice(0, cut), method: symbol.slice(cut + 1) }
    : { owner: node.name, method: node.name };
}

/** La carte d'un nœud : sa clé, sa sorte, son titre ; les membres sont ajoutés à part. */
function cardOf(
  node: MapNode,
  nodes: ReadonlyMap<string, MapNode>,
): { key: string; kind: CardKind; title: string; sub?: string; lane: LaneId } {
  const src = sourceOf(node.id);
  const lane: LaneId = node.layer;
  switch (node.kind) {
    case 'COMPONENT':
      return { key: `cmp:${node.id}`, kind: 'COMPONENT', title: node.name, lane };
    case 'CONTAINER':
    case 'BUTTON':
      return { key: `el:${node.id}`, kind: node.kind, title: node.label ?? node.name, lane };
    case 'CONDITION': {
      // Une condition se lit sur la carte de son élément.
      const owner = node.parent ? nodes.get(node.parent) : undefined;
      if (owner) return cardOf(owner, nodes);
      return { key: `n:${node.id}`, kind: 'OTHER', title: node.name, lane };
    }
    case 'FIELD': {
      const parent = node.parent ? nodes.get(node.parent) : undefined;
      if (parent && parent.kind !== 'FIELD') return cardOf(parent, nodes);
      const container = str(node.detail.container) || node.parent || node.name;
      return { key: `cls:${lane}:${src}:${container}`, kind: 'CLASS', title: container, lane };
    }
    case 'COLUMN': {
      const entity = str(node.detail.container);
      const table = node.name.split('.')[0] ?? entity;
      return { key: `tbl:${src}:${entity || table}`, kind: 'TABLE', title: table, lane };
    }
    case 'ENTITY': {
      const entity = str(node.detail.entity);
      return {
        key: `tbl:${src}:${entity || node.name}`,
        kind: 'TABLE',
        title: str(node.detail.table) || node.name,
        ...(entity ? { sub: entity } : {}),
        lane,
      };
    }
    case 'DTO':
      return { key: `cls:${lane}:${src}:${node.name}`, kind: 'DTO', title: node.name, lane };
    case 'METHOD':
    case 'STREAM':
      return {
        key: `cls:${lane}:${src}:${ownerOf(node).owner}`,
        kind: 'CLASS',
        title: ownerOf(node).owner,
        lane,
      };
    case 'SERVICE':
      return { key: `cls:${lane}:${src}:${node.name}`, kind: 'CLASS', title: node.name, lane };
    case 'API': {
      const method = str(node.detail.httpMethod);
      const path = str(node.detail.path);
      const handler = str(node.detail.handler).split('.')[0];
      return {
        key: `ep:${node.id}`,
        kind: 'ENDPOINT',
        title: method || path ? `${method} ${path}`.trim() : node.name,
        ...(handler ? { sub: handler } : {}),
        lane,
      };
    }
    default:
      return { key: `n:${node.id}`, kind: 'OTHER', title: node.label ?? node.name, lane };
  }
}

const KIND_RANK: Record<CardKind, number> = {
  ENDPOINT: 0,
  COMPONENT: 1,
  CONTAINER: 1,
  BUTTON: 1,
  CLASS: 2,
  DTO: 3,
  TABLE: 4,
  EXTERNAL: 5,
  OTHER: 6,
};

/** Le modèle du graphe en couloirs pour une vue et des critères d'affichage (fonction pure, sans DOM). */
/** Ce que le graphe en couloirs dessine : un sous-graphe, ses appels sortants, et ce qui appartient au sujet. */
export interface LaneInput {
  graph: MapSubgraph;
  outbound: ApiOutbound[];
  /** L'API dont c'est la fiche (ses endpoints et champs sont « les siens »). */
  api?: Pick<ApiService, 'id' | 'endpoints' | 'fields'>;
  /** D'autres nœuds propres au sujet (l'élément d'une page, par exemple). */
  ownNodes?: string[];
  /** Des sortes de liens montrées en plus dans la vue Architecture (les mappings d'une chaîne de décision). */
  extraKinds?: string[];
  scanId: string;
}

export function laneModel(sheet: LaneInput, view: GraphView, filters: LaneFilters = NO_FILTERS): LaneModel {
  const nodes = new Map(sheet.graph.nodes.map((n) => [n.id, n]));
  // Les appels sortants établis : une cible par endpoint externe (ou à classifier), un lien par appel.
  const extEdges: MapEdge[] = [];
  const extCards = new Map<string, { node: MapNode; lane: LaneId; own: boolean; sub: string }>();
  for (const call of sheet.outbound) {
    const id = `EXT:${call.endpoint}`;
    const lane: LaneId = call.scope === 'EXTERNAL' ? 'EXTERNAL' : 'UNCLASSIFIED';
    if (!extCards.has(id)) {
      const title = `${call.method ?? ''} ${call.path ?? ''}`.trim();
      const node: MapNode = {
        id,
        kind: 'API',
        layer: 'API',
        name: title || call.name,
        label: call.name,
        detail: { httpMethod: call.method ?? '', path: call.path ?? '', api: call.api },
        signature: '',
        evidence: call.evidence,
      };
      extCards.set(id, { node, lane, own: call.api === sheet.api?.id, sub: call.provider ?? call.name });
      nodes.set(id, node);
    }
    extEdges.push({
      id: `EXTCALL:${call.from}>${call.endpoint}`,
      from: call.from,
      to: id,
      kind: 'CALLS',
      confidence: call.confidence,
      reason: call.how,
      evidence: call.evidence,
    });
  }
  const kinds = view === 'data' ? DATA_KINDS : new Set([...ARCH_KINDS, ...(sheet.extraKinds ?? [])]);
  const all = [...sheet.graph.edges.filter((e) => kinds.has(e.kind)), ...extEdges];

  // Les cartes : chaque nœud dans la carte de son conteneur.
  const cards = new Map<string, LaneCard>();
  const cardOfNode = new Map<string, string>();
  const ownNodes = new Set([
    ...(sheet.api?.endpoints ?? []).map((ep) => ep.node).filter((n): n is string => Boolean(n)),
    ...(sheet.ownNodes ?? []),
  ]);
  const place = (node: MapNode): void => {
    const ext = extCards.get(node.id);
    const base = ext
      ? {
          key: `ext:${node.id}`,
          kind: 'EXTERNAL' as CardKind,
          title: node.name,
          sub: ext.sub,
          lane: ext.lane,
        }
      : cardOf(node, nodes);
    let card = cards.get(base.key);
    if (!card) {
      card = {
        key: base.key,
        lane: base.lane,
        kind: base.kind,
        title: base.title,
        ...(base.sub ? { sub: base.sub } : {}),
        nodes: [],
        members: [],
        status: 'UNKNOWN',
        own: false,
        depth: Number.POSITIVE_INFINITY,
      };
      cards.set(base.key, card);
    }
    // Une carte prend la sorte la plus parlante de ses nœuds (DTO, table ou composant plutôt que classe).
    if (KIND_RANK[base.kind] < KIND_RANK[card.kind] && card.kind !== 'ENDPOINT') card.kind = base.kind;
    if (base.sub && !card.sub) card.sub = base.sub;
    card.nodes.push(node.id);
    cardOfNode.set(node.id, base.key);
    if (ownNodes.has(node.id) || ext?.own) card.own = true;
    const text = nodeText(node, node.id);
    if (node.kind === 'METHOD')
      card.members.push({ id: node.id, text: `${ownerOf(node).method}()`, kind: 'method' });
    else if (node.kind === 'STREAM')
      card.members.push({ id: node.id, text: ownerOf(node).method, kind: 'field' });
    else if (node.kind === 'FIELD')
      card.members.push({ id: node.id, text: str(node.detail.field) || text.name, kind: 'field' });
    else if (node.kind === 'COLUMN')
      card.members.push({ id: node.id, text: str(node.detail.column) || text.name, kind: 'column' });
    else if (node.kind === 'CONDITION')
      card.members.push({
        id: node.id,
        text: `${node.detail.aspect === 'ENABLED' ? 'activé' : 'visible'} si ${shownExpression({ expression: node.name, whenTrue: node.detail.whenTrue !== false })}`,
        kind: 'condition',
      });
  };
  for (const node of sheet.graph.nodes) place(node);
  for (const ext of extCards.values()) place(ext.node);
  // Les propriétés d'un DTO sans nœud de champ : celles que le scan a lues dans sa déclaration.
  for (const node of sheet.graph.nodes) {
    if (node.kind !== 'DTO') continue;
    const card = cards.get(cardOfNode.get(node.id) ?? '');
    const props = node.detail.properties;
    if (card && card.members.length === 0 && Array.isArray(props))
      for (const p of props) card.members.push({ id: `${node.id}#${p}`, text: p, kind: 'field' });
  }
  // Les champs échangés avec l'API elle-même : sur ses cibles, dans la vue Données.
  if (view === 'data')
    for (const card of cards.values()) {
      if (!card.own) continue;
      // Les champs de ses endpoints : ceux du type envoyé (requête) et du type reçu (réponse).
      const ids = new Set(card.nodes.map((id) => (id.startsWith('EXT:') ? id.slice(4) : id)));
      const eps = (sheet.api?.endpoints ?? []).filter(
        (ep) => ids.has(ep.id) || (ep.node !== undefined && ids.has(ep.node)),
      );
      const exchanged = (sheet.api?.fields ?? []).filter((f) =>
        eps.some((ep) => (f.direction === 'OUT' ? ep.requestType : ep.responseType) === f.container),
      );
      for (const f of exchanged)
        card.members.push({
          id: `${card.key}#${f.direction}:${f.name}`,
          text: f.name,
          kind: f.direction === 'OUT' ? 'out' : 'in',
        });
    }

  // Les liens entre cartes, regroupés par paire (sens compris) ; ceux d'une même carte sont internes.
  const natureOf = (e: MapEdge): Nature =>
    e.id.startsWith('EXTCALL:')
      ? 'external'
      : nodes.get(e.to)?.layer === 'DATABASE' || nodes.get(e.from)?.layer === 'DATABASE'
        ? 'db'
        : 'flow';
  const inner: MapEdge[] = [];
  const links = new Map<string, LaneLink>();
  for (const e of all) {
    const a = cardOfNode.get(e.from);
    const b = cardOfNode.get(e.to);
    if (!a || !b) continue;
    if (a === b) {
      inner.push(e);
      continue;
    }
    const nature = natureOf(e);
    const key = `${a}>${b}>${nature}`;
    const link = links.get(key) ?? { key, from: a, to: b, nature, edges: [], confidence: 'CONFIRMED' };
    link.edges.push(e);
    links.set(key, link);
  }
  for (const link of links.values()) link.confidence = weakest(link.edges.map((e) => e.confidence));

  // Les critères d'affichage : couches, natures, statuts (sur chaque relation), puis profondeur depuis l'API.
  const hiddenLanes = new Set(filters.lanes);
  let visibleLinks = [...links.values()]
    .map((link) => ({
      ...link,
      edges: link.edges.filter((e) => !filters.statuses.includes(e.confidence)),
    }))
    .filter(
      (link) =>
        link.edges.length > 0 &&
        !filters.natures.includes(link.nature) &&
        !hiddenLanes.has(cards.get(link.from)?.lane ?? '') &&
        !hiddenLanes.has(cards.get(link.to)?.lane ?? ''),
    )
    .map((link) => ({ ...link, confidence: weakest(link.edges.map((e) => e.confidence)) }));
  // La profondeur : sauts entre cartes reliées, depuis les cartes de l'API (sans tenir compte du sens).
  const around = new Map<string, string[]>();
  for (const link of visibleLinks) {
    around.set(link.from, [...(around.get(link.from) ?? []), link.to]);
    around.set(link.to, [...(around.get(link.to) ?? []), link.from]);
  }
  let frontier = [...cards.values()].filter((c) => c.own).map((c) => c.key);
  for (const key of frontier) {
    const card = cards.get(key);
    if (card) card.depth = 0;
  }
  for (let d = 1; frontier.length > 0 && d < 50; d += 1) {
    const next: string[] = [];
    for (const key of frontier)
      for (const other of around.get(key) ?? []) {
        const card = cards.get(other);
        if (card && card.depth === Number.POSITIVE_INFINITY) {
          card.depth = d;
          next.push(other);
        }
      }
    frontier = next;
  }
  const active = filtersActive(filters);
  const linked = new Set(visibleLinks.flatMap((l) => [l.from, l.to]));
  // Vue Données : seules les cartes qui portent des champs ou un flux de données.
  const inView = (card: LaneCard): boolean =>
    view === 'architecture' ||
    linked.has(card.key) ||
    card.members.some((m) => m.kind !== 'method') ||
    card.own;
  const passes = (card: LaneCard): boolean =>
    !hiddenLanes.has(card.lane) &&
    (filters.depth === 0 || card.depth <= filters.depth) &&
    (!active || card.own || linked.has(card.key));
  const kept = new Map([...cards].filter(([, card]) => inView(card) && passes(card)));
  const viewHidden = [...cards.values()].filter((card) => !inView(card)).length;
  visibleLinks = visibleLinks.filter((l) => kept.has(l.from) && kept.has(l.to));
  for (const card of kept.values()) {
    const touching = visibleLinks.filter((l) => l.from === card.key || l.to === card.key);
    card.status = touching.length ? strongest(touching.map((l) => l.confidence)) : 'UNKNOWN';
  }

  // Les couloirs, dans l'ordre des couches ; les cartes ordonnées pour croiser le moins possible.
  const lanes = LANE_ORDER.map((id) => ({
    id,
    cards: [...kept.values()]
      .filter((c) => c.lane === id)
      .sort(
        (a, b) =>
          Number(b.own) - Number(a.own) ||
          KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
          a.title.localeCompare(b.title),
      ),
    internal: visibleLinks.filter((l) => cards.get(l.from)?.lane === id && cards.get(l.to)?.lane === id),
  })).filter((lane) => lane.cards.length > 0);
  for (let pass = 0; pass < 3; pass += 1)
    for (const lane of lanes) {
      const position = new Map<string, number>();
      for (const other of lanes)
        if (other !== lane)
          other.cards.forEach((c, i) => position.set(c.key, i / Math.max(1, other.cards.length - 1)));
      const score = (card: LaneCard): number => {
        const known = visibleLinks
          .filter((l) => l.from === card.key || l.to === card.key)
          .map((l) => position.get(l.from === card.key ? l.to : l.from))
          .filter((v): v is number => v !== undefined);
        return known.length ? known.reduce((s, v) => s + v, 0) / known.length : 2;
      };
      const scores = new Map(lane.cards.map((c) => [c.key, score(c)]));
      lane.cards.sort(
        (a, b) => (scores.get(a.key) ?? 2) - (scores.get(b.key) ?? 2) || a.title.localeCompare(b.title),
      );
    }

  const bundles = new Map<string, LaneBundle>();
  for (const link of visibleLinks) {
    const from = cards.get(link.from)?.lane;
    const to = cards.get(link.to)?.lane;
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}>${link.nature}`;
    const bundle =
      bundles.get(key) ??
      ({
        key,
        from,
        to,
        nature: link.nature,
        links: [],
        count: 0,
        confidence: 'CONFIRMED',
        statuses: { CONFIRMED: 0, PROBABLE: 0, UNKNOWN: 0 },
      } satisfies LaneBundle);
    bundle.links.push(link);
    bundle.count += link.edges.length;
    for (const e of link.edges) bundle.statuses[e.confidence] += 1;
    bundles.set(key, bundle);
  }
  for (const b of bundles.values()) b.confidence = weakest(b.links.map((l) => l.confidence));
  return {
    lanes,
    cards: kept,
    bundles: [...bundles.values()],
    inner,
    all,
    shown: visibleLinks.flatMap((l) => l.edges),
    nodes,
    hiddenCards: cards.size - kept.size - viewHidden,
    viewHidden,
    cardOfNode,
  };
}

/**
 * La condition telle qu'elle s'énonce : « [disabled]="!x" » se lit « activé si x », et « [disabled]="!(x | async)" »
 * « activé si x | async » (négation de tête retirée quand la parenthèse couvre toute l'expression).
 */
export function shownExpression(c: { expression: string; whenTrue: boolean }): string {
  if (c.whenTrue) return c.expression;
  const text = c.expression.trim();
  const simple = /^!\s*([\w$.?]+)$/.exec(text);
  if (simple?.[1]) return simple[1];
  const grouped = /^!\s*\((.*)\)$/s.exec(text)?.[1];
  if (grouped !== undefined && wholeGroup(grouped)) return grouped.trim();
  return `!(${c.expression})`;
}

/** Les parenthèses du texte s'équilibrent sans jamais se refermer avant la fin. */
function wholeGroup(inner: string): boolean {
  let depth = 0;
  for (const ch of inner) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

// ── Disposition ─────────────────────────────────────────────────────────────────────────────────

export const CARD_W = 234;
const LANE_PAD = 12;
const LANE_W = CARD_W + LANE_PAD * 2;
const HEAD_H = 54;
const CARD_GAP = 10;
const GAP = 112;
const LINE_H = 15;
const STACK_GAP = 22;
const MARGIN_X = 28;

export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LaneLayout {
  width: number;
  height: number;
  lanes: Map<LaneId, Placed & { col: number }>;
  cards: Map<string, Placed & { lines: string[][]; more: number }>;
  cols: number;
}

/** Les lignes des membres d'une carte : une méthode par ligne, les champs regroupés (≈ 30 caractères). */
export function memberLines(card: LaneCard, open: boolean): { lines: string[][]; more: number } {
  const lines: string[][] = [];
  // Une méthode ou une colonne par ligne ; les champs regroupés.
  const methods = card.members.filter((m) => m.kind === 'method' || m.kind === 'column');
  const others = card.members.filter((m) => m.kind !== 'method' && m.kind !== 'column');
  for (const m of methods) lines.push([m.id]);
  let current: string[] = [];
  let length = 0;
  for (const m of others) {
    if (current.length > 0 && length + m.text.length + 2 > 30) {
      lines.push(current);
      current = [];
      length = 0;
    }
    current.push(m.id);
    length += m.text.length + 2;
  }
  if (current.length) lines.push(current);
  const max = open ? lines.length : card.kind === 'TABLE' ? 6 : 3;
  if (lines.length <= max) return { lines, more: 0 };
  const shown = lines.slice(0, max - 1);
  const hidden = lines.slice(max - 1).reduce((s, l) => s + l.length, 0);
  return { lines: shown, more: hidden };
}

/** Un chemin d'endpoint long passe sur deux lignes (coupé aux « / ») plutôt que d'être tronqué. */
export const TITLE_CHARS = 24;
const titleLines = (card: LaneCard): number =>
  (card.kind === 'ENDPOINT' || card.kind === 'EXTERNAL') && card.title.length > TITLE_CHARS ? 2 : 1;
const cardHeight = (card: LaneCard, lines: number, more: boolean): number =>
  32 +
  (titleLines(card) - 1) * 16 +
  (card.sub ? 14 : 0) +
  (lines + (more ? 1 : 0)) * LINE_H +
  (lines || more ? 6 : 0);

export function laneLayout(model: LaneModel, open: ReadonlySet<string>, corridors: number): LaneLayout {
  const main = model.lanes.filter((l) => !STACKED.has(l.id));
  const stacked = model.lanes.filter((l) => STACKED.has(l.id));
  const cols = main.length + (stacked.length ? 1 : 0);
  const top = 30 + corridors * 7;
  const cards = new Map<string, Placed & { lines: string[][]; more: number }>();
  const lanes = new Map<LaneId, Placed & { col: number }>();
  const heightOf = (lane: LaneModel['lanes'][number]): number => {
    let h = HEAD_H;
    for (const card of lane.cards) {
      const { lines, more } = memberLines(card, open.has(card.key));
      h += cardHeight(card, lines.length, more > 0) + CARD_GAP;
    }
    return h + LANE_PAD - CARD_GAP + 4;
  };
  const stackHeight =
    stacked.reduce((s, l) => s + heightOf(l), 0) + Math.max(0, stacked.length - 1) * STACK_GAP;
  const mainHeight = Math.max(stackHeight, ...main.map(heightOf), 180);
  const colX = (c: number): number => MARGIN_X + c * (LANE_W + GAP);
  const placeLane = (lane: LaneModel['lanes'][number], col: number, y: number, h: number): void => {
    lanes.set(lane.id, { x: colX(col), y, w: LANE_W, h, col });
    let cy = y + HEAD_H;
    for (const card of lane.cards) {
      const { lines, more } = memberLines(card, open.has(card.key));
      const ch = cardHeight(card, lines.length, more > 0);
      cards.set(card.key, { x: colX(col) + LANE_PAD, y: cy, w: CARD_W, h: ch, lines, more });
      cy += ch + CARD_GAP;
    }
  };
  main.forEach((lane, c) => {
    placeLane(lane, c, top, mainHeight);
  });
  let sy = top;
  stacked.forEach((lane, i) => {
    const h = i === stacked.length - 1 ? Math.max(heightOf(lane), top + mainHeight - sy) : heightOf(lane);
    placeLane(lane, main.length, sy, h);
    sy += h + STACK_GAP;
  });
  const bottom = top + Math.max(mainHeight, sy - STACK_GAP - top);
  return {
    width: colX(Math.max(cols, 1)) - GAP + MARGIN_X + 14,
    height: bottom + 24 + corridors * 7,
    lanes,
    cards,
    cols,
  };
}

// ── Tracés ──────────────────────────────────────────────────────────────────────────────────────

interface Route {
  key: string;
  nature: Nature;
  ids: string[];
  /** Les segments partagés (tronc), puis un segment par source et par cible avec son statut. */
  trunk: string;
  branches: { d: string; status: MapConfidence; arrow: boolean }[];
  badge?: { x: number; y: number; count: number; statuses: Record<MapConfidence, number> };
  touch: string[];
  bundle: string;
}

const portY = (p: Placed): number => p.y + Math.min(p.h / 2, 22);

function routeLinks(
  key: string,
  bundleKey: string,
  links: readonly LaneLink[],
  layout: LaneLayout,
  slot: { src: number; dst: number; corridor: number },
  nature: Nature,
): Route | undefined {
  const sources = [...new Set(links.map((l) => l.from))];
  const targets = [...new Set(links.map((l) => l.to))];
  const sp = sources
    .map((k) => ({ k, p: layout.cards.get(k) }))
    .filter((s): s is { k: string; p: Placed & { lines: string[][]; more: number } } => s.p !== undefined);
  const tp = targets
    .map((k) => ({ k, p: layout.cards.get(k) }))
    .filter((s): s is { k: string; p: Placed & { lines: string[][]; more: number } } => s.p !== undefined);
  const first = sp[0];
  const firstT = tp[0];
  if (!first || !firstT) return undefined;
  const laneOf = (x: number): number => Math.round((x - LANE_PAD - MARGIN_X) / (LANE_W + GAP));
  const ca = laneOf(first.p.x);
  const cb = laneOf(firstT.p.x);
  const right = (c: number): number => MARGIN_X + c * (LANE_W + GAP) + LANE_W;
  const left = (c: number): number => MARGIN_X + c * (LANE_W + GAP);
  const ys = sp.map((s) => portY(s.p));
  const yt = tp.map((t) => portY(t.p));
  let xs: number;
  let xt: number;
  let ymid: number;
  const forward = cb > ca;
  if (forward) {
    xs = right(ca) + 14 + slot.src * 9;
    xt = left(cb) - 14 - slot.dst * 9;
    if (cb === ca + 1) {
      const all = [...ys, ...yt];
      ymid =
        yt.length === 1
          ? (yt[0] ?? 0)
          : ys.length === 1
            ? (ys[0] ?? 0)
            : Math.round(all.reduce((s, v) => s + v, 0) / all.length);
    } else ymid = 18 + slot.corridor * 7;
  } else {
    // Retour vers une colonne antérieure (ou la même) : par le couloir du bas, entrée à gauche de la cible.
    xs = right(ca) + 14 + slot.src * 9;
    xt = left(cb) - 14 - slot.dst * 9;
    ymid = layout.height - 14 - slot.corridor * 7;
  }
  const minmax = (list: number[]): [number, number] => [Math.min(...list), Math.max(...list)];
  const [s0, s1] = minmax([...ys, ymid]);
  const [t0, t1] = minmax([...yt, ymid]);
  const trunk = `M${String(xs)} ${String(s0)}V${String(s1)}M${String(xs)} ${String(ymid)}H${String(xt)}M${String(xt)} ${String(t0)}V${String(t1)}`;
  const branches: Route['branches'] = [];
  for (const s of sp) {
    const mine = links.filter((l) => l.from === s.k);
    branches.push({
      d: `M${String(s.p.x + s.p.w)} ${String(portY(s.p))}H${String(xs)}`,
      status: weakest(mine.map((l) => l.confidence)),
      arrow: false,
    });
  }
  for (const t of tp) {
    const mine = links.filter((l) => l.to === t.k);
    branches.push({
      d: `M${String(xt)} ${String(portY(t.p))}H${String(t.p.x - 2)}`,
      status: weakest(mine.map((l) => l.confidence)),
      arrow: true,
    });
  }
  const count = links.reduce((s, l) => s + l.edges.length, 0);
  const statuses: Record<MapConfidence, number> = { CONFIRMED: 0, PROBABLE: 0, UNKNOWN: 0 };
  for (const l of links) for (const e of l.edges) statuses[e.confidence] += 1;
  return {
    key,
    nature,
    ids: links.flatMap((l) => l.edges.map((e) => e.id)),
    trunk,
    branches,
    badge: { x: Math.round((xs + xt) / 2), y: ymid, count, statuses },
    touch: [...sources, ...targets],
    bundle: bundleKey,
  };
}

/** Les liens internes d'un couloir dépliés : par la marge gauche du couloir, une voie par lien. */
function routeInternal(lane: Placed, links: readonly LaneLink[], layout: LaneLayout): Route[] {
  return links
    .map((link, i): Route | undefined => {
      const a = layout.cards.get(link.from);
      const b = layout.cards.get(link.to);
      if (!a || !b) return undefined;
      const x = lane.x + 3 + (i % 3) * 3;
      return {
        key: link.key,
        nature: link.nature,
        ids: link.edges.map((e) => e.id),
        trunk: '',
        branches: [
          {
            d: `M${String(a.x)} ${String(a.y + 12)}H${String(x)}V${String(b.y + 12)}H${String(b.x - 2)}`,
            status: link.confidence,
            arrow: true,
          },
        ],
        touch: [link.from, link.to],
        bundle: link.key,
      };
    })
    .filter((r): r is Route => r !== undefined);
}

// ── Rendu ───────────────────────────────────────────────────────────────────────────────────────

const LANE_ICON: Record<string, string> = {
  FRONTEND: 'monitor',
  BFF: 'code',
  BACKEND: 'gear',
  EXTERNAL: 'cloud',
  UNCLASSIFIED: 'alert',
  API: 'requirements',
  DATABASE: 'data',
  EVENTS: 'network',
  OTHER: 'layers',
};
const CARD_ICON: Record<CardKind, string> = {
  COMPONENT: 'cube',
  CONTAINER: 'grid',
  BUTTON: 'pointer',
  CLASS: 'gear',
  ENDPOINT: 'code',
  DTO: 'file',
  TABLE: 'data',
  EXTERNAL: 'cloud',
  OTHER: 'layers',
};
const STATUS_ICON: Record<MapConfidence, string> = {
  CONFIRMED: 'checkCircle',
  PROBABLE: 'alert',
  UNKNOWN: 'scan',
};

export interface LaneRenderOptions {
  m: MapStrings;
  summary?: MapSummary;
  sheet: LaneInput;
  model: LaneModel;
  /** Cartes dépliées (tous les membres), faisceaux dépliés (un tracé par paire de cartes). */
  openCards: ReadonlySet<string>;
  openBundles: ReadonlySet<string>;
  selection?: { kind: 'node'; id: string } | { kind: 'edge'; ids: string[] };
}

export function lanesView(o: LaneRenderOptions): { html: string; width: number; height: number } {
  const { m, model } = o;
  if (model.lanes.length === 0)
    return { html: `<p class="mu ln-empty">${esc(m.ln.empty)}</p>`, width: 320, height: 120 };
  // Une voie par faisceau qui traverse une colonne (couloir du haut) ou revient en arrière (couloir du bas).
  const colOf = new Map<string, number>();
  {
    let c = 0;
    for (const lane of model.lanes) if (!STACKED.has(lane.id)) colOf.set(lane.id, c++);
    for (const lane of model.lanes) if (STACKED.has(lane.id)) colOf.set(lane.id, c);
  }
  const far = model.bundles.filter((b) => {
    const a = colOf.get(b.from) ?? 0;
    const z = colOf.get(b.to) ?? 0;
    return z > a + 1 || z <= a;
  });
  const layout = laneLayout(model, o.openCards, far.length);
  const sideSlots = new Map<string, number>();
  const nextSlot = (key: string): number => {
    const n = sideSlots.get(key) ?? 0;
    sideSlots.set(key, n + 1);
    return Math.min(n, 5);
  };
  let corridor = 0;
  const routes: Route[] = [];
  // Les faisceaux les plus fournis d'abord : leurs troncs restent près des cartes.
  for (const bundle of [...model.bundles].sort((a, b) => b.count - a.count)) {
    const ca = colOf.get(bundle.from) ?? 0;
    const cb = colOf.get(bundle.to) ?? 0;
    const isFar = cb > ca + 1 || cb <= ca;
    const groups = o.openBundles.has(bundle.key) ? bundle.links.map((l) => [l]) : [bundle.links];
    for (const [i, links] of groups.entries()) {
      const slot = {
        src: nextSlot(`s${String(ca)}`),
        dst: nextSlot(`d${String(cb)}`),
        corridor: isFar ? corridor++ : 0,
      };
      const route = routeLinks(
        groups.length > 1 ? `${bundle.key}#${String(i)}` : bundle.key,
        bundle.key,
        links,
        layout,
        slot,
        bundle.nature,
      );
      if (route) routes.push(route);
    }
  }
  for (const lane of model.lanes) {
    const placed = layout.lanes.get(lane.id);
    if (placed && o.openBundles.has(`internal:${lane.id}`))
      routes.push(...routeInternal(placed, lane.internal, layout));
  }

  // Sélection : la carte et ses voisines, ou les relations choisies ; le reste est atténué.
  const sel = o.selection;
  const selIds = sel?.kind === 'edge' ? new Set(sel.ids) : undefined;
  const near = new Set<string>();
  if (sel?.kind === 'node') {
    near.add(sel.id);
    for (const r of routes) if (r.touch.includes(sel.id)) for (const t of r.touch) near.add(t);
  }
  const routeLit = (r: Route): boolean =>
    selIds ? r.ids.some((id) => selIds.has(id)) : sel?.kind === 'node' ? r.touch.includes(sel.id) : false;
  if (selIds) for (const r of routes) if (routeLit(r)) for (const t of r.touch) near.add(t);
  const index = new Map([...model.cards.keys()].map((k, i) => [k, `c${String(i)}`]));
  const tok = (keys: readonly string[]): string => keys.map((k) => index.get(k) ?? '').join(' ');
  const neighbours = new Map<string, Set<string>>();
  for (const r of routes)
    for (const a of r.touch) {
      const set = neighbours.get(a) ?? new Set<string>();
      for (const b of r.touch) if (b !== a) set.add(b);
      neighbours.set(a, set);
    }

  const lanesHtml = model.lanes
    .map((lane) => {
      const p = layout.lanes.get(lane.id);
      if (!p) return '';
      const first = model.nodes.get(model.cards.get(lane.cards[0]?.key ?? '')?.nodes[0] ?? '');
      const tech =
        lane.id === 'EXTERNAL' || lane.id === 'UNCLASSIFIED'
          ? [...new Set(lane.cards.map((c) => c.sub).filter(Boolean))].join(', ')
          : first
            ? (technologyOf(o.summary, first) ?? '')
            : '';
      const count = lane.internal.reduce((s, l) => s + l.edges.length, 0);
      const ids = lane.internal.flatMap((l) => l.edges.map((e) => e.id));
      const openInt = o.openBundles.has(`internal:${lane.id}`);
      const chip = count
        ? `<button class="ln-int${openInt ? ' open' : ''}${ids.some((id) => selIds?.has(id)) ? ' sel' : ''}" data-action="map-ln-bundle" data-bundle="internal:${esc(lane.id)}" data-ids="${esc(idList(ids))}" title="${esc(m.ln.internalHelp)}">${icon('network')}<span>${esc(m.ln.internal(count))}</span></button>`
        : '';
      const ext =
        lane.id === 'EXTERNAL'
          ? `<span class="ln-ext" title="${esc(m.ln.outbound)}">${icon('external')}</span>`
          : '';
      return `<section class="ln-lane l-${lane.id.toLowerCase()}" style="left:${String(p.x)}px;top:${String(p.y)}px;width:${String(p.w)}px;height:${String(p.h)}px" aria-label="${esc(m.ln.lanes[lane.id] ?? lane.id)}"><header><span class="ln-li">${icon(LANE_ICON[lane.id] ?? 'layers')}</span><span class="ln-lt"><b>${esc(m.ln.lanes[lane.id] ?? lane.id)}</b>${tech ? `<small>(${esc(tech)})</small>` : ''}</span>${ext}</header>${chip}</section>`;
    })
    .join('');

  const cardsHtml = [...model.cards.values()]
    .map((card) => {
      const p = layout.cards.get(card.key);
      if (!p) return '';
      const id = index.get(card.key) ?? '';
      const memberText = new Map(card.members.map((mm) => [mm.id, mm]));
      const lines = p.lines
        .map((line) => {
          const parts = line
            .map((mid) => memberText.get(mid))
            .filter((x): x is LaneMember => x !== undefined);
          const text = parts
            .map((x) => (x.kind === 'out' ? `→ ${x.text}` : x.kind === 'in' ? `← ${x.text}` : x.text))
            .join(', ');
          return `<li title="${esc(text)}">${esc(text)}</li>`;
        })
        .join('');
      const more =
        p.more > 0
          ? `<li><button class="lnk ln-more" data-action="map-ln-card" data-card="${esc(card.key)}">${esc(m.ln.more(p.more))}</button></li>`
          : o.openCards.has(card.key)
            ? `<li><button class="lnk ln-more" data-action="map-ln-card" data-card="${esc(card.key)}">${esc(m.ln.less)}</button></li>`
            : '';
      const state = sel ? (near.has(card.key) ? ' hl' : ' dim') : '';
      const selected = sel?.kind === 'node' && sel.id === card.key ? ' sel' : '';
      const tip = `${card.title}${card.sub ? ` · ${card.sub}` : ''} — ${m.ln.statusTip[card.status] ?? card.status}`;
      return `<div class="ln-card k-${card.kind.toLowerCase()} s-${card.status.toLowerCase()}${card.own ? ' own' : ''}${state}${selected}" style="left:${String(p.x)}px;top:${String(p.y)}px;width:${String(p.w)}px;height:${String(p.h)}px" data-lcard="${id}" data-near="${tok([...(neighbours.get(card.key) ?? [])])}" data-touch="${id}" data-action="map-g-select" data-kind="node" data-id="${esc(card.key)}" role="button" tabindex="0" aria-label="${esc(tip)}"><div class="ln-ch${titleLines(card) > 1 ? ' two' : ''}"><span class="ln-ci">${icon(CARD_ICON[card.kind])}</span><b title="${esc(card.title)}">${titleLines(card) > 1 ? breakable(card.title) : esc(card.title)}</b><span class="ln-st" title="${esc(m.ln.statusTip[card.status] ?? card.status)}">${icon(STATUS_ICON[card.status])}</span></div>${card.sub ? `<small class="ln-sub" title="${esc(card.sub)}">${esc(card.sub)}</small>` : ''}${lines || more ? `<ul>${lines}${more}</ul>` : ''}</div>`;
    })
    .join('');

  const paths = routes
    .map((r) => {
      const lit = sel ? (routeLit(r) ? ' hl' : ' dim') : '';
      const touch = tok(r.touch);
      const branches = r.branches
        .map(
          (b) =>
            `<path class="ln-p st-${b.status.toLowerCase()}" d="${b.d}"${b.arrow ? ` marker-end="url(#ln-arrow-${r.nature})"` : ''}/>`,
        )
        .join('');
      const all = `${r.trunk}${r.branches.map((b) => b.d).join('')}`;
      return `<g class="ln-e n-${r.nature}${lit}" data-touch="${touch}">${r.trunk ? `<path class="ln-p ln-trunk" d="${r.trunk}"/>` : ''}${branches}<path class="ln-hit" d="${all}" data-action="map-ln-bundle" data-bundle="${esc(r.bundle)}" data-ids="${esc(idList(r.ids))}"><title>${esc(m.ln.bundleHelp)}</title></path></g>`;
    })
    .join('');
  const badges = routes
    .filter((r) => r.badge && (r.badge.count > 1 || r.key === r.bundle))
    .map((r) => {
      const b = r.badge;
      if (!b) return '';
      const lit = sel ? (routeLit(r) ? ' hl' : ' dim') : '';
      const warn = b.statuses.PROBABLE + b.statuses.UNKNOWN;
      const open = o.openBundles.has(r.bundle);
      return `<button class="ln-badge n-${r.nature}${lit}${open ? ' open' : ''}" style="left:${String(b.x)}px;top:${String(b.y)}px" data-action="map-ln-bundle" data-bundle="${esc(r.bundle)}" data-ids="${esc(idList(r.ids))}" data-touch="${tok(r.touch)}" title="${esc(`${m.ln.natures[r.nature] ?? r.nature} · ${m.g.legendConfirmed(b.statuses.CONFIRMED)} · ${m.g.legendProbable(b.statuses.PROBABLE)} · ${m.g.legendUnknown(b.statuses.UNKNOWN)} — ${m.ln.bundleHelp}`)}">${esc(m.g.links(b.count))}${warn ? `<span class="ln-bw">${icon('alert')}${String(warn)}</span>` : ''}</button>`;
    })
    .join('');
  const marker = (n: Nature): string =>
    `<marker id="ln-arrow-${n}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ln-m n-${n}"/></marker>`;
  return {
    html: `<div class="ln-g" style="width:${String(layout.width)}px;height:${String(layout.height)}px" data-lanes>${lanesHtml}<svg class="ln-svg" width="${String(layout.width)}" height="${String(layout.height)}" aria-hidden="true"><defs>${NATURES.map(marker).join('')}</defs>${paths}</svg>${cardsHtml}${badges}</div>`,
    width: layout.width,
    height: layout.height,
  };
}

/** La légende comptée : statuts (des relations dessinées), natures, total. */
export function laneLegend(m: MapStrings, model: LaneModel): string {
  const count = (c: MapConfidence): number => model.shown.filter((e) => e.confidence === c).length;
  return `<div class="ln-legend" role="group" aria-label="${esc(m.ln.legend)}"><b>${esc(m.ln.legend)} :</b><span class="lg s-confirmed">${icon('checkCircle')}${esc(m.g.legendConfirmed(count('CONFIRMED')))}</span><span class="lg s-probable">${icon('alert')}${esc(m.g.legendProbable(count('PROBABLE')))}</span><span class="lg s-unknown">${icon('scan')}${esc(m.g.legendUnknown(count('UNKNOWN')))}</span><span class="lg n-flow"><i></i>${esc(m.g.legendFlow)}</span><span class="lg n-external"><i></i>${esc(m.ln.legendExternal)}</span><span class="lg n-db"><i></i>${esc(m.ln.legendDb)}</span><span class="ln-total">${esc(m.ln.total(model.shown.length))}</span></div>`;
}

/** Les critères d'affichage : couches présentes, natures, statuts, profondeur (masquer n'efface aucune relation). */
export function laneFilters(m: MapStrings, sheet: LaneInput, view: GraphView, filters: LaneFilters): string {
  const present = laneModel(sheet, view, NO_FILTERS).lanes.map((l) => l.id);
  const chip = (group: string, value: string, label: string, hidden: boolean): string =>
    `<label class="ln-f"><input type="checkbox" data-map="ln-filter" data-group="${group}" value="${esc(value)}" ${hidden ? '' : 'checked'}>${esc(label)}</label>`;
  const depth = `<label class="ln-fd">${esc(m.ln.depth)} <select data-map="ln-depth">${[0, 1, 2, 3, 4, 5]
    .map(
      (d) =>
        `<option value="${String(d)}" ${filters.depth === d ? 'selected' : ''}>${esc(d === 0 ? m.ln.depthAll : m.ln.depthN(d))}</option>`,
    )
    .join('')}</select></label>`;
  return `<div class="ln-filters" role="group" aria-label="${esc(m.ln.filters)}"><span class="ln-fg"><b>${esc(m.ln.filterLanes)}</b>${present.map((id) => chip('lanes', id, m.ln.lanes[id] ?? id, filters.lanes.includes(id))).join('')}</span><span class="ln-fg"><b>${esc(m.ln.filterNatures)}</b>${NATURES.map((n) => chip('natures', n, m.ln.natures[n] ?? n, filters.natures.includes(n))).join('')}</span><span class="ln-fg"><b>${esc(m.ln.filterStatus)}</b>${STATUSES.map((s) => chip('statuses', s, m.confidence[s] ?? s, filters.statuses.includes(s))).join('')}</span>${depth}<button class="btn small ghost" data-action="map-ln-reset" ${filtersActive(filters) ? '' : 'disabled'}>${esc(m.ln.resetFilters)}</button></div>`;
}

/** La fiche de la sélection : une carte (ses éléments et preuves) ou des relations (leurs preuves). */
export function laneSelection(
  o: LaneRenderOptions & {
    conf: (value: string) => string;
    evidence: (evidence: Evidence | undefined) => string;
    where: (evidence: Evidence | undefined) => string;
  },
): string {
  const { m, model, sheet } = o;
  const sel = o.selection;
  if (!sel) return '';
  const close = `<button class="btn small ghost icon-only" data-action="map-g-clear" aria-label="${esc(m.g.clearSel)}" title="${esc(m.g.clearSel)}">${icon('close')}</button>`;
  const label = (id: string): string => {
    const t = nodeText(model.nodes.get(id), id);
    return t.container ? `${t.container}.${t.name}` : t.name;
  };
  if (sel.kind === 'node') {
    const card = model.cards.get(sel.id);
    if (!card) return '';
    const rows = card.nodes
      .map((id) => {
        const node = model.nodes.get(id);
        if (!node) return '';
        const ev = node.evidence.find((e) => e.file) ?? node.evidence[0];
        return `<tr><td class="mono">${esc(node.name)}<small class="mu"> ${esc(node.kind)}</small></td><td>${esc(node.label && node.label !== node.name ? node.label : '—')}</td><td>${ev?.file ? o.where(ev) : `<small class="mu">${esc(m.g.noEvidenceFile)}</small>`}</td><td>${esc(ev?.sourceId ?? '—')}</td><td>${o.conf(ev?.confidence ?? 'UNKNOWN')}</td><td>${o.evidence(ev)}</td></tr>`;
      })
      .join('');
    const touching = model.shown.filter((e) => card.nodes.includes(e.from) || card.nodes.includes(e.to));
    return `<section class="map-gsel ln-sel" aria-label="${esc(m.g.selNode)}"><div class="card-h"><h4>${icon(CARD_ICON[card.kind])} <b>${esc(card.title)}</b> <small class="mu">${esc(m.ln.lanes[card.lane] ?? card.lane)}${card.sub ? ` · ${esc(card.sub)}` : ''}</small> ${o.conf(card.status)}</h4>${close}</div><p class="small mu">${esc(m.ln.statusTip[card.status] ?? '')} · ${esc(m.ln.cardRelations(touching.length))} · ${esc(m.ln.scanVersion)} : <span class="mono">${esc(sheet.scanId.slice(0, 12))}</span></p><div class="tbl-w"><table class="tbl map-tbl ln-sel-t"><thead><tr><th>${esc(m.ln.technical)}</th><th>${esc(m.ln.business)}</th><th>${esc(m.ln.location)}</th><th>${esc(m.ln.scanSource)}</th><th>${esc(m.g.colConfidence)}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }
  const chosen = [...model.all, ...model.inner].filter(
    (e, i, list) => sel.ids.includes(e.id) && list.findIndex((x) => x.id === e.id) === i,
  );
  if (chosen.length === 0) return '';
  const bundle = model.bundles.find((b) => b.links.some((l) => l.edges.some((e) => sel.ids.includes(e.id))));
  const internalLane = model.lanes.find((l) =>
    l.internal.some((link) => link.edges.some((e) => sel.ids.includes(e.id))),
  );
  const key =
    bundle && bundle.links.flatMap((l) => l.edges).every((e) => sel.ids.includes(e.id))
      ? bundle.key
      : internalLane
        ? `internal:${internalLane.id}`
        : '';
  const toggle = key
    ? `<button class="btn small" data-action="map-ln-expand" data-bundle="${esc(key)}">${icon(o.openBundles.has(key) ? 'minimize' : 'maximize')}<span>${esc(o.openBundles.has(key) ? m.ln.regroup : m.ln.expand)}</span></button>`
    : '';
  return `<section class="map-gsel ln-sel" aria-label="${esc(m.g.selEdge)}"><div class="card-h"><h4>${esc(m.g.selEdge)}${chosen.length > 1 ? ` (${String(chosen.length)})` : ''}</h4><span class="map-decide">${toggle}${close}</span></div>${chosen
    .slice(0, 12)
    .map((e) => {
      const ev = e.evidence.find((x) => x.file) ?? e.evidence[0];
      return `<div class="map-gsel-e"><p><b class="mono">${esc(label(e.from))}</b> ${icon('arrowRight')} <b class="mono">${esc(label(e.to))}</b> · ${esc(e.id.startsWith('EXTCALL:') ? m.ln.legendExternal : (m.g.relKinds[e.kind] ?? e.kind))} ${o.conf(e.confidence)}</p><p class="small"><b>${esc(m.g.justification)} :</b> ${esc(e.reason)}</p><p class="small">${ev?.file ? o.where(ev) : `<small class="mu">${esc(m.g.noEvidenceFile)}</small>`} ${o.evidence(ev)}</p></div>`;
    })
    .join(
      '',
    )}${chosen.length > 12 ? `<p class="small mu">${esc(m.g.more(chosen.length - 12))}</p>` : ''}</section>`;
}

export const LANES_CSS = `
.ln-wrap{display:flex;flex-direction:column;gap:10px;min-width:0}
.map-explorer.map-apis.trace,.map-explorer.map-apis.trace.collapsed{grid-template-columns:minmax(240px,1fr) minmax(0,2fr)}
.map-explorer.map-apis.trace>.map-acenter{grid-column:1 / -1;order:-1}
.map-explorer.map-apis.trace>.map-right{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
@media (max-width:860px){.map-explorer.map-apis.trace{grid-template-columns:1fr}}
.map-canvas.lanes{height:var(--ln-h,420px);background:var(--qa-color-surface)}
.map-trace.full .map-canvas.lanes{height:calc(100vh - 250px);min-height:320px}
.ln-g{position:relative;font-size:12px}
.ln-lane{position:absolute;border-radius:14px;border:1px solid var(--ln-b);background:var(--ln-bg);box-sizing:border-box}
.ln-lane header{display:flex;gap:10px;align-items:center;padding:10px 12px 0;height:44px;box-sizing:border-box}
.ln-li .ico{width:26px;height:26px;color:var(--ln-c);stroke-width:1.7}
.ln-lt{display:flex;flex-direction:column;line-height:1.2;min-width:0}
.ln-lt b{font-size:14px;color:var(--qa-color-text)}
.ln-lt small{color:var(--qa-color-muted);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}
.ln-ext{margin-left:auto}.ln-ext .ico{width:16px;height:16px;color:var(--qa-color-muted)}
.ln-int{position:absolute;right:10px;top:-11px;display:inline-flex;gap:4px;align-items:center;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--ln-b);background:var(--qa-color-surface);color:var(--qa-color-muted);cursor:pointer}
.ln-int .ico{width:12px;height:12px}.ln-int.open,.ln-int.sel{color:var(--ln-c);border-color:var(--ln-c)}
.l-frontend{--ln-bg:#f6f1fd;--ln-b:#e3d6f7;--ln-c:#7c3aed}
.l-bff{--ln-bg:#eef4fd;--ln-b:#d3e1f7;--ln-c:#2563eb}
.l-backend{--ln-bg:#eef8f0;--ln-b:#cfe9d5;--ln-c:#15803d}
.l-external{--ln-bg:#f5f0fe;--ln-b:#d9c8f8;--ln-c:#7c3aed}
.l-unclassified{--ln-bg:#fdf6ea;--ln-b:#f1dfbd;--ln-c:#b45309}
.l-api{--ln-bg:#f2f6f8;--ln-b:#d8e3e8;--ln-c:#0e7490}
.l-database{--ln-bg:#fdf7e8;--ln-b:#f1e2b8;--ln-c:#c2850c}
.l-events,.l-other{--ln-bg:#f4f5f6;--ln-b:#e1e4e7;--ln-c:#64748b}
.ln-svg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
.ln-svg .ln-hit{pointer-events:stroke;cursor:pointer}
.ln-e .ln-p{fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.ln-e .ln-trunk{stroke-width:2.6}
.ln-e.n-flow .ln-p{stroke:#16a34a}.ln-e.n-external .ln-p{stroke:#7c3aed}.ln-e.n-db .ln-p{stroke:#2563eb}
.ln-m.n-flow{fill:#16a34a}.ln-m.n-external{fill:#7c3aed}.ln-m.n-db{fill:#2563eb}
.ln-e .ln-p.st-probable{stroke-dasharray:7 5}
.ln-e .ln-p.st-unknown{stroke-dasharray:2 5}
.ln-hit{fill:none;stroke:transparent;stroke-width:14}
.ln-e.dim{opacity:.16}.ln-e.hl .ln-p{stroke-width:3.2}
.ln-card{position:absolute;box-sizing:border-box;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:10px;padding:7px 10px;cursor:pointer;box-shadow:0 1px 2px rgba(16,40,30,.06);z-index:2;overflow:hidden;transition:opacity .12s,box-shadow .12s}
.ln-card:hover,.ln-card:focus-visible{box-shadow:0 0 0 2px var(--ln-c,#15803d) inset,0 2px 8px rgba(16,40,30,.12);outline:none}
.ln-card.own{border-color:var(--qa-color-primary,#15803d);box-shadow:0 0 0 1px var(--qa-color-primary,#15803d) inset}
.ln-card.sel{box-shadow:0 0 0 2px #2563eb inset,0 3px 10px rgba(37,99,235,.18)}
.ln-card.dim{opacity:.4}
.ln-ch{display:flex;gap:7px;align-items:center;min-width:0;height:20px}
.ln-ch b{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;color:var(--qa-color-text)}
.ln-ch.two{height:36px;align-items:flex-start}
.ln-ch.two b{white-space:normal;line-height:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ln-ci .ico{width:16px;height:16px;color:var(--qa-color-muted)}
.k-component .ln-ci .ico{color:#7c3aed}.k-endpoint .ln-ci .ico{color:#2563eb}.k-class .ln-ci .ico{color:#15803d}.k-dto .ln-ci .ico{color:#2563eb}.k-table .ln-ci .ico{color:#c2850c}.k-external .ln-ci .ico{color:#7c3aed}
.ln-st .ico{width:16px;height:16px}
.s-confirmed .ln-st .ico{color:#16a34a}.s-probable .ln-st .ico{color:#d97706}.s-unknown .ln-st .ico{color:#94a3b8}
.ln-sub{display:block;color:var(--qa-color-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:14px;line-height:14px;padding-left:23px}
.ln-card ul{list-style:none;margin:4px 0 0;padding:0 0 0 23px}
.ln-card li{height:${String(LINE_H)}px;line-height:${String(LINE_H)}px;font-size:11.5px;color:var(--qa-color-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--qa-font-mono,ui-monospace,monospace)}
.ln-more{font-size:11px;padding:0}
.ln-badge{position:absolute;transform:translate(-50%,-50%);z-index:3;display:inline-flex;gap:5px;align-items:center;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:700;background:var(--qa-color-surface);border:1.6px solid;cursor:pointer;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.ln-badge.n-flow{color:#15803d;border-color:#16a34a}.ln-badge.n-external{color:#6d28d9;border-color:#7c3aed}.ln-badge.n-db{color:#1d4ed8;border-color:#2563eb}
.ln-badge.open{border-style:dashed}.ln-badge.dim{opacity:.3}.ln-badge.hl{box-shadow:0 0 0 3px rgba(37,99,235,.18)}
.ln-badge:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.ln-bw{display:inline-flex;align-items:center;gap:2px;color:#b45309;font-weight:600}.ln-bw .ico{width:12px;height:12px}
.ln-g.hov .ln-card:not(.on){opacity:.45}.ln-g.hov .ln-e:not(.on){opacity:.14}.ln-g.hov .ln-badge:not(.on){opacity:.3}
.ln-g.hov .ln-e.on .ln-p{stroke-width:3.2}
.ln-legend{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;border:1px solid var(--qa-color-border);border-radius:12px;padding:8px 12px;font-size:12px}
.ln-legend .lg{display:inline-flex;gap:6px;align-items:center}
.ln-legend .lg .ico{width:15px;height:15px}
.ln-legend .s-confirmed .ico{color:#16a34a}.ln-legend .s-probable .ico{color:#d97706}.ln-legend .s-unknown .ico{color:#64748b}
.ln-legend .lg i{display:inline-block;width:26px;height:0;border-top:2.4px solid;position:relative}
.ln-legend .lg i::after{content:"";position:absolute;right:-2px;top:-5.5px;border:4px solid transparent;border-left:7px solid}
.ln-legend .n-flow i{color:#16a34a}.ln-legend .n-external i{color:#7c3aed}.ln-legend .n-db i{color:#2563eb}
.ln-total{margin-left:auto;background:var(--qa-color-primary-soft,#e8f5ec);color:var(--qa-color-primary,#15803d);font-weight:700;border-radius:999px;padding:3px 12px}
.ln-filters{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;font-size:12px;border:1px dashed var(--qa-color-border);border-radius:10px;padding:8px 12px}
.ln-fg{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.ln-f{display:inline-flex;gap:4px;align-items:center;border:1px solid var(--qa-color-border);border-radius:999px;padding:2px 8px;cursor:pointer}
.ln-fd select{font:inherit;padding:2px 4px}
.ln-sel-t td{vertical-align:top}
.ln-empty{padding:24px}
.ln-note{margin:0}
.map-seg.ln-view button{display:inline-flex;gap:6px;align-items:center}
/* La barre d'outils du graphe : toutes les commandes à la même hauteur, centrées sur une ligne. */
.map-gtools{align-items:center}
.map-gtools .map-seg{margin:0;height:34px;box-sizing:border-box;padding:2px;align-items:stretch;gap:2px}
.map-gtools .map-seg button{min-height:0;height:100%;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border-radius:6px}
.map-gview{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--qa-color-muted);white-space:nowrap}
.map-gtools .btn.small{height:34px;min-height:34px;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:0 12px;margin:0}
.map-gtools .map-gbtns .btn.icon-only{width:34px;padding:0;justify-content:center}
.map-gbtns{gap:6px}
.map-gzoom{height:34px;line-height:34px}
.map-seg.ln-view .ico{width:15px;height:15px}
:host([theme="dark"]) .ln-lane{--ln-bg:rgba(255,255,255,.035)}
@media (prefers-color-scheme:dark){:host([theme="auto"]) .ln-lane{--ln-bg:rgba(255,255,255,.035)}}
`;
