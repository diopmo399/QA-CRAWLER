import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowEdge } from '../model/flow.js';
import { buildFlowTree, displayName, type FlowTreeNode } from './flow-tree.js';

/**
 * LA GÉOMÉTRIE DE LA CARTE DES ÉCRANS (rapport d'exécution) : des fonctions pures, sans DOM ni dépendance.
 *
 * - Disposition hiérarchique en couches : la couche d'un écran est sa profondeur dans l'arbre couvrant du
 *   parcours (le même que l'arbre affiché sous la carte), un parent est centré sur ses enfants, deux
 *   branches voisines sont séparées par un espace supplémentaire. Les dimensions réelles des cartes
 *   (hauteur adaptée au texte) servent au placement, jamais leur seul centre.
 * - Orientation : de haut en bas quand le parcours tient dans la largeur du rapport (parcours surtout
 *   séquentiel), de gauche à droite sinon (exploration très ramifiée).
 * - Routage orthogonal : chaque transition part d'un bord et arrive sur un bord. Les transitions de l'arbre
 *   sortent par le bord aval (un port par transition) et entrent par le bord amont ; les autres (retours,
 *   raccourcis, cycles) passent par les côtés et par les couloirs libres entre les cartes. Chaque segment
 *   parallèle prend sa propre piste : deux flèches ne partagent jamais le même trajet.
 * - Les étiquettes des transitions de l'arbre sont posées dans une bande réservée devant l'écran d'arrivée,
 *   hors des cartes et des pistes.
 *
 * La topologie n'est jamais modifiée : seules les transitions réellement exécutées sont dessinées, un écran
 * atteint sans transition enregistrée (saut, rejeu) est relié à la racine par un trait sans flèche.
 */

export type MapOrientation = 'TB' | 'LR';
export type ScreenStatus = 'PASS' | 'FAIL' | 'WARNING' | 'UNKNOWN';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapScreen extends Box {
  id: string;
  /** Rang de l'écran dans la carte : sert d'identifiant HTML sûr. */
  index: number;
  title: string;
  titleLines: string[];
  routeLines: string[];
  status: ScreenStatus;
  root: boolean;
  /** Atteint sans transition enregistrée (saut, rejeu). */
  direct: boolean;
  /** Actions exécutées depuis l'écran (tous résultats). */
  actions: number;
  /** Assertions observées à l'arrivée sur l'écran. */
  assertions: number;
  errors: number;
  warnings: number;
}

export interface MapLink {
  from: string;
  to: string;
  /** tree : transition de l'arbre ; link : autre transition (retour, raccourci, cycle) ; direct : sans transition. */
  kind: 'tree' | 'link' | 'direct';
  /** Dernière transition exécutée entre ces deux écrans (son verdict colore la flèche). */
  edge?: FlowEdge;
  /** Textes des actions réellement exécutées entre ces deux écrans. */
  actions: string[];
  points: Point[];
  label?: Box & { text: string };
}

export interface MapLayout {
  orientation: MapOrientation;
  width: number;
  height: number;
  screens: MapScreen[];
  links: MapLink[];
  /** Écrans non dessinés (au-delà de MAX_SCREENS) : ils restent dans l'arbre sous la carte. */
  hidden: number;
}

/** Au-delà, la carte deviendrait illisible : les écrans suivants sont listés dans l'arbre. */
export const MAX_SCREENS = 80;
/** Transitions hors de l'arbre (retours, raccourcis) dessinées au plus. */
export const MAX_LINKS = 60;

/** Les métriques des cartes, partagées avec le rendu SVG. */
export const CARD = {
  width: 240,
  padX: 12,
  padTop: 12,
  titleSize: 13,
  titleLine: 17,
  routeSize: 11,
  routeLine: 15,
  titleRouteGap: 3,
  routeStatsGap: 9,
  statsSize: 11,
  statsLine: 16,
  padBottom: 10,
  maxTitleLines: 2,
  maxRouteLines: 2,
} as const;

export const LABEL = { size: 11, height: 20, padX: 8, maxWidthTB: CARD.width - 24, maxWidthLR: 168 } as const;

/** Les espacements, à la taille réelle des cartes. */
const SPACING = {
  TB: { crossGap: 120, branchGap: 32, minChannel: 88, band: 30 },
  LR: { crossGap: 64, branchGap: 24, minChannel: 140, band: LABEL.maxWidthLR + 24 },
} as const;
const TRACK = 10;
const CHANNEL_PAD = 14;
const SIDE_FIRST = 14;
const MARGIN = 40;
/** Largeur au-delà de laquelle une disposition de haut en bas ne tient plus dans le rapport. */
const TB_MAX_WIDTH = 1200;

// ---------------------------------------------------------------------------------------------
// Texte : estimation de la largeur sans DOM (légèrement majorée, vérifiée dans Chromium par les tests).
// ---------------------------------------------------------------------------------------------

const NARROW = new Set(Array.from("fijlrtI.,:;|!'’`()[]{}-/ "));
const WIDE = new Set(Array.from('mwMW@%'));

export function textWidth(
  text: string,
  size: number,
  options: { bold?: boolean; mono?: boolean } = {},
): number {
  if (options.mono) return Array.from(text).length * size * 0.62;
  let em = 0;
  for (const char of text) {
    if (char === ' ') em += 0.3;
    else if (NARROW.has(char)) em += 0.36;
    else if (WIDE.has(char)) em += 0.9;
    else if (char >= 'A' && char <= 'Z') em += 0.72;
    else if (char >= '0' && char <= '9') em += 0.6;
    else em += 0.6;
  }
  return em * size * (options.bold ? 1.08 : 1);
}

/** Coupe un texte trop long pour sa largeur, avec « … ». */
export function fitText(
  text: string,
  maxWidth: number,
  size: number,
  options: { bold?: boolean; mono?: boolean } = {},
): string {
  if (textWidth(text, size, options) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 0 && textWidth(`${chars.join('')}…`, size, options) > maxWidth) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/**
 * Découpe un texte en lignes qui tiennent dans la largeur : par mots (ou après « / ? & = # » pour une
 * adresse), un mot trop long est coupé ; au-delà de maxLines, la dernière ligne se termine par « … ».
 */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number,
  options: { bold?: boolean; mono?: boolean } = {},
): string[] {
  const tokens = options.mono ? text.split(/(?<=[/?&=#])/) : text.split(/(?<= )/);
  const fits = (value: string): boolean => textWidth(value.trimEnd(), size, options) <= maxWidth;
  const lines: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.trim()) lines.push(current.trimEnd());
    current = '';
  };
  for (const token of tokens) {
    if (fits(current + token)) {
      current += token;
      continue;
    }
    push();
    if (fits(token)) {
      current = token;
      continue;
    }
    // Un mot plus large que la carte : coupé où il faut.
    for (const char of token) {
      if (!fits(current + char)) push();
      current += char;
    }
  }
  push();
  if (lines.length <= maxLines) return lines.length > 0 ? lines : [''];
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitText(`${kept[maxLines - 1] ?? ''}…`, maxWidth, size, options);
  if (!kept[maxLines - 1]?.endsWith('…')) kept[maxLines - 1] = `${kept[maxLines - 1] ?? ''}…`;
  return kept;
}

export function cardHeight(titleLines: number, routeLines: number): number {
  return (
    CARD.padTop +
    titleLines * CARD.titleLine +
    CARD.titleRouteGap +
    routeLines * CARD.routeLine +
    CARD.routeStatsGap +
    CARD.statsLine +
    CARD.padBottom
  );
}

/** Les lignes de base du texte d'une carte (rendu SVG). */
export function cardRows(screen: MapScreen): { title: number[]; route: number[]; stats: number } {
  const titleTop = screen.y + CARD.padTop;
  const title = screen.titleLines.map((_, index) => titleTop + CARD.titleSize + index * CARD.titleLine - 1);
  const routeTop = titleTop + screen.titleLines.length * CARD.titleLine + CARD.titleRouteGap;
  const route = screen.routeLines.map((_, index) => routeTop + CARD.routeSize + index * CARD.routeLine);
  return { title, route, stats: screen.y + screen.height - CARD.padBottom - 3 };
}

// ---------------------------------------------------------------------------------------------
// Statut d'un écran : uniquement à partir des preuves de l'exécution.
// ---------------------------------------------------------------------------------------------

/**
 * ÉCHEC : une anomalie ERROR / CRITICAL sur l'écran, ou une vérification en échec à l'arrivée ;
 * AVERTISSEMENT : une anomalie WARNING ou une vérification qui avertit ; VALIDÉ : au moins une
 * vérification réussie à l'arrivée et rien de plus grave ; NON JUGÉ sinon (jamais validé sans preuve).
 */
export function screenEvidence(
  result: Pick<ExplorationResult, 'issues' | 'transitions'>,
  id: string,
): Pick<MapScreen, 'status' | 'actions' | 'assertions' | 'errors' | 'warnings'> {
  const issues = result.issues.filter((issue) => issue.states.includes(id));
  const errors = issues.filter((issue) => issue.severity === 'ERROR' || issue.severity === 'CRITICAL').length;
  const warnings = issues.filter((issue) => issue.severity === 'WARNING').length;
  const arrivals = result.transitions.filter(
    (edge) => edge.to === id && edge.from !== id && edge.result === 'SUCCESS',
  );
  const verdicts = new Set(arrivals.map((edge) => edge.oracle?.status));
  const status: ScreenStatus =
    errors > 0 || verdicts.has('FAIL')
      ? 'FAIL'
      : warnings > 0 || verdicts.has('WARNING')
        ? 'WARNING'
        : verdicts.has('PASS')
          ? 'PASS'
          : 'UNKNOWN';
  return {
    status,
    actions: result.transitions.filter((edge) => edge.from === id).length,
    assertions: arrivals.reduce((sum, edge) => sum + (edge.oracle?.assertions.length ?? 0), 0),
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Disposition et routage, dans un repère abstrait : c = axe transverse (entre frères), l = axe des couches.
// ---------------------------------------------------------------------------------------------

interface Node {
  screen: MapScreen;
  depth: number;
  parent?: string;
  children: string[];
  /** Taille sur l'axe transverse et sur l'axe des couches. */
  cs: number;
  ls: number;
  c0: number;
}

/** Une position sur l'axe des couches, résolue une fois les épaisseurs des canaux connues. */
type L =
  | { at: 'layer'; layer: number; offset: number }
  | { at: 'track'; channel: number; track: number }
  | { at: 'band'; channel: number };

interface APoint {
  c: number;
  l: L;
}

interface Route {
  link: Omit<MapLink, 'points' | 'label'>;
  points: APoint[];
  label?: { text: string; width: number; c: number; channel: number };
}

interface Span {
  a: number;
  b: number;
}

const overlaps = (x: Span, y: Span, pad = 0): boolean =>
  Math.min(x.a, x.b) - pad < Math.max(y.a, y.b) && Math.min(y.a, y.b) - pad < Math.max(x.a, x.b);

interface Plan {
  orientation: MapOrientation;
  nodes: Map<string, Node>;
  order: string[];
  routes: Route[];
  layers: number;
  channelTracks: Map<number, number>;
  layerSize: number[];
  spacing: (typeof SPACING)[MapOrientation];
  /** Le couloir entre deux cartes, et s'il a manqué de place pour une voie (la disposition est refaite plus large). */
  crossGap: number;
  overflow: boolean;
}

export interface LayoutOptions {
  orientation?: MapOrientation;
  maxScreens?: number;
  maxLinks?: number;
}

export function layoutFlowMap(
  result: Pick<ExplorationResult, 'states' | 'transitions' | 'issues'>,
  options: LayoutOptions = {},
): MapLayout | undefined {
  const tree = buildFlowTree(result.states, result.transitions, result.states[0]?.id);
  if (!tree || result.states.length === 0) return undefined;
  const maxScreens = options.maxScreens ?? MAX_SCREENS;
  // Les écrans retenus : en largeur depuis la racine (le haut de la hiérarchie d'abord).
  const kept: { branch: FlowTreeNode; depth: number; parent?: string }[] = [];
  const queue: { branch: FlowTreeNode; depth: number; parent?: string }[] = [{ branch: tree, depth: 0 }];
  while (queue.length > 0 && kept.length < maxScreens) {
    const item = queue.shift() as (typeof queue)[number];
    kept.push(item);
    for (const child of item.branch.children)
      queue.push({ branch: child, depth: item.depth + 1, parent: item.branch.node.id });
  }
  const screens = kept.map(({ branch, depth }, index): MapScreen => {
    const state = branch.node;
    const title = displayName(state);
    const titleLines = wrapText(title, CARD.width - 2 * CARD.padX, CARD.titleSize, CARD.maxTitleLines, {
      bold: true,
    });
    const routeLines = wrapText(
      state.route || state.url,
      CARD.width - 2 * CARD.padX,
      CARD.routeSize,
      CARD.maxRouteLines,
      {
        mono: true,
      },
    );
    return {
      id: state.id,
      index,
      title,
      titleLines,
      routeLines,
      root: depth === 0,
      direct: depth > 0 && !branch.via,
      ...screenEvidence(result, state.id),
      x: 0,
      y: 0,
      width: CARD.width,
      height: cardHeight(titleLines.length, routeLines.length),
    };
  });
  const make = (orientation: MapOrientation): Plan => {
    // Un couloir trop étroit pour ses voies : la disposition est refaite avec un couloir plus large.
    let planned = plan(orientation, kept, screens, result.transitions, options.maxLinks ?? MAX_LINKS, 0);
    for (let attempt = 0; planned.overflow && attempt < 6; attempt += 1)
      planned = plan(
        orientation,
        kept,
        screens,
        result.transitions,
        options.maxLinks ?? MAX_LINKS,
        planned.crossGap + 48,
      );
    return planned;
  };
  let chosen: MapLayout;
  if (options.orientation) chosen = materialize(make(options.orientation));
  else {
    const vertical = materialize(make('TB'));
    chosen = vertical.width <= TB_MAX_WIDTH ? vertical : materialize(make('LR'));
  }
  return { ...chosen, hidden: result.states.length - screens.length };
}

function plan(
  orientation: MapOrientation,
  kept: { branch: FlowTreeNode; depth: number; parent?: string }[],
  screensIn: MapScreen[],
  transitions: readonly FlowEdge[],
  maxLinks: number,
  minCrossGap: number,
): Plan {
  const spacing = SPACING[orientation];
  const screens = screensIn.map((screen) => ({ ...screen }));
  const nodes = new Map<string, Node>();
  kept.forEach(({ depth, parent }, index) => {
    const screen = screens[index] as MapScreen;
    nodes.set(screen.id, {
      screen,
      depth,
      ...(parent !== undefined ? { parent } : {}),
      children: [],
      cs: orientation === 'TB' ? screen.width : screen.height,
      ls: orientation === 'TB' ? screen.height : screen.width,
      c0: 0,
    });
  });
  for (const node of nodes.values()) if (node.parent) nodes.get(node.parent)?.children.push(node.screen.id);
  const order = [...nodes.keys()];
  const layers = Math.max(...[...nodes.values()].map((node) => node.depth)) + 1;

  // Les liens : l'arbre (avec ses actions), puis les autres transitions réussies entre deux écrans.
  // Le verdict d'un lien : la dernière tentative entre ces deux écrans, quel que soit son résultat. Un lien
  // n'est dessiné que si une transition entre eux a réussi.
  const lastEdge = new Map<string, FlowEdge>();
  const lastAttempt = new Map<string, FlowEdge>();
  const actionsOf = new Map<string, string[]>();
  for (const edge of transitions) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    lastAttempt.set(key, edge);
    if (edge.result !== 'SUCCESS') continue;
    lastEdge.set(key, edge);
    const text = edge.action.text ?? edge.action.label ?? edge.action.type;
    const list = actionsOf.get(key) ?? [];
    if (!list.includes(text)) list.push(text);
    actionsOf.set(key, list);
  }
  const treeLinks: Omit<MapLink, 'points' | 'label'>[] = [];
  const treeKeys = new Set<string>();
  for (const { branch, parent } of kept) {
    if (parent === undefined) continue;
    const via = branch.via;
    const key = via ? `${via.from}\u0000${via.to}` : '';
    const edge = via ? (lastAttempt.get(key) ?? via) : undefined;
    treeKeys.add(`${parent}\u0000${branch.node.id}`);
    treeLinks.push({
      from: parent,
      to: branch.node.id,
      kind: via ? 'tree' : 'direct',
      ...(edge ? { edge } : {}),
      actions: via ? (actionsOf.get(key) ?? [via.action.text ?? via.action.label ?? via.action.type]) : [],
    });
  }
  const otherLinks: Omit<MapLink, 'points' | 'label'>[] = [];
  for (const [key, success] of lastEdge) {
    const edge = lastAttempt.get(key) ?? success;
    if (otherLinks.length >= maxLinks) break;
    if (treeKeys.has(key) || !nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    otherLinks.push({ from: edge.from, to: edge.to, kind: 'link', edge, actions: actionsOf.get(key) ?? [] });
  }

  // Une carte grandit pour donner un port distinct à chacune de ses transitions (hauteur adaptative).
  const PORT = 14;
  const degree = new Map<string, number>();
  const bump = (id: string): void => {
    degree.set(id, (degree.get(id) ?? 0) + 1);
  };
  if (orientation === 'LR') for (const link of treeLinks) bump(link.from);
  else
    for (const link of otherLinks) {
      bump(link.from);
      bump(link.to);
    }
  for (const [id, count] of degree) {
    const node = nodes.get(id) as Node;
    const needed = (count + 1) * PORT;
    if (orientation === 'LR' && node.cs < needed) node.cs = needed;
    if (orientation === 'TB' && node.ls < needed) node.ls = needed;
    node.screen.height = orientation === 'TB' ? node.ls : node.cs;
  }
  const layerSize = Array.from({ length: layers }, (_, layer) =>
    Math.max(0, ...[...nodes.values()].filter((node) => node.depth === layer).map((node) => node.ls)),
  );

  // Placement transverse : arbre rangé (un parent au milieu de ses enfants), contours par couche.
  let crossGap: number = Math.max(spacing.crossGap, minCrossGap);
  let overflow = false;
  let placedInLayer: Node[][] = [];
  const nextFree = (layer: number, node: Node): number => {
    const previous = placedInLayer[layer]?.at(-1);
    if (!previous) return 0;
    const gap = previous.parent === node.parent ? crossGap : crossGap + spacing.branchGap;
    return previous.c0 + previous.cs + gap;
  };
  const shift = (node: Node, delta: number): void => {
    node.c0 += delta;
    for (const child of node.children) shift(nodes.get(child) as Node, delta);
  };
  const place = (node: Node): void => {
    for (const child of node.children) place(nodes.get(child) as Node);
    const free = nextFree(node.depth, node);
    if (node.children.length === 0) node.c0 = free;
    else {
      const first = nodes.get(node.children[0] ?? '') as Node;
      const last = nodes.get(node.children.at(-1) ?? '') as Node;
      node.c0 = (first.c0 + first.cs / 2 + last.c0 + last.cs / 2) / 2 - node.cs / 2;
      if (node.c0 < free) shift(node, free - node.c0);
    }
    placedInLayer[node.depth]?.push(node);
  };
  const root = nodes.get(order[0] ?? '') as Node;
  const placeAll = (): void => {
    placedInLayer = Array.from({ length: layers }, () => []);
    place(root);
    for (const layer of placedInLayer) layer.sort((a, b) => a.c0 - b.c0);
  };
  placeAll();
  const centerOf = (node: Node): number => node.c0 + node.cs / 2;

  // Les transitions hors de l'arbre passent par les côtés. Chaque extrémité a sa voie, distincte de toutes
  // celles qui longent le même bord vertical (une colonne de cartes alignées) : jamais deux voies confondues.
  type Side = 'low' | 'high';
  type Link = Omit<MapLink, 'points' | 'label'>;
  const sideOf = (link: Link): { out: Side; in: Side } => {
    const a = nodes.get(link.from) as Node;
    const b = nodes.get(link.to) as Node;
    const delta = centerOf(b) - centerOf(a);
    if (Math.abs(delta) < 1) return { out: 'high', in: 'high' };
    return delta > 0 ? { out: 'high', in: 'low' } : { out: 'low', in: 'high' };
  };
  let sidePorts = new Map<string, Link[]>();
  let lanes = new Map<string, number>();
  const prepareSides = (): number => {
    sidePorts = new Map();
    lanes = new Map();
    const faces = new Map<string, { key: string; depth: number; at: number }[]>();
    for (const link of otherLinks) {
      const sides = sideOf(link);
      for (const [id, side] of [
        [link.from, sides.out],
        [link.to, sides.in],
      ] as const) {
        const key = `${id}|${side}`;
        sidePorts.set(key, [...(sidePorts.get(key) ?? []), link]);
      }
    }
    for (const [key, list] of sidePorts) {
      const [id, side] = key.split('|') as [string, Side];
      const node = nodes.get(id) as Node;
      const face = (side === 'high' ? node.c0 + node.cs : node.c0).toFixed(1);
      const group = faces.get(`${side}|${face}`) ?? [];
      list.forEach((link, index) =>
        group.push({ key: `${key}|${otherLinks.indexOf(link)}`, depth: node.depth, at: index }),
      );
      faces.set(`${side}|${face}`, group);
    }
    let busiest = 0;
    for (const group of faces.values()) {
      group.sort((a, b) => a.depth - b.depth || a.at - b.at);
      group.forEach((item, index) => lanes.set(item.key, index));
      busiest = Math.max(busiest, group.length);
    }
    return busiest;
  };
  // Le couloir entre deux cartes est assez large pour toutes ses voies, des deux côtés.
  const busiest = prepareSides();
  const needed = 2 * (SIDE_FIRST + Math.max(0, busiest - 1) * TRACK) + 24;
  if (needed > crossGap) {
    crossGap = Math.max(crossGap, Math.min(420, needed));
    placeAll();
    prepareSides();
  }

  const routes: Route[] = [];
  const channelTracks = new Map<number, number>();
  const horizontals = new Map<number, { span: Span; track: number }[]>();
  const verticals: { c: number; from: L; to: L; span: [number, number] }[] = [];
  // Un ordre sur l'axe des couches (couche, puis canal qui la suit, puis piste), pour comparer des intervalles.
  const lValue = (l: L): number =>
    l.at === 'layer'
      ? l.layer * 10_000 + l.offset
      : l.at === 'track'
        ? l.channel * 10_000 + 5_000 + l.track
        : 0;
  const registerVerticals = (points: APoint[]): void => {
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1] as APoint;
      const b = points[index] as APoint;
      if (Math.abs(a.c - b.c) > 0.5) continue;
      verticals.push({
        c: a.c,
        from: a.l,
        to: b.l,
        span: [Math.min(lValue(a.l), lValue(b.l)), Math.max(lValue(a.l), lValue(b.l)) + 1],
      });
    }
  };
  const takeTrack = (channel: number, span: Span, from = 0): number => {
    const used = horizontals.get(channel) ?? [];
    let track = from;
    while (used.some((item) => item.track === track && overlaps(item.span, span, 6))) track += 1;
    used.push({ span, track });
    horizontals.set(channel, used);
    channelTracks.set(channel, Math.max(channelTracks.get(channel) ?? 0, track + 1));
    return track;
  };

  // 1. Les transitions de l'arbre : un port par transition sur le bord aval, ordonnés comme les enfants.
  const treeOut = new Map<string, Omit<MapLink, 'points' | 'label'>[]>();
  for (const link of treeLinks) treeOut.set(link.from, [...(treeOut.get(link.from) ?? []), link]);
  for (const [from, links] of treeOut) {
    const parent = nodes.get(from) as Node;
    const sorted = [...links].sort(
      (a, b) => centerOf(nodes.get(a.to) as Node) - centerOf(nodes.get(b.to) as Node),
    );
    const inset = 16;
    const minGap = 12;
    const ports = sorted.map((link) =>
      Math.min(
        Math.max(centerOf(nodes.get(link.to) as Node), parent.c0 + inset),
        parent.c0 + parent.cs - inset,
      ),
    );
    for (let i = 1; i < ports.length; i += 1)
      ports[i] = Math.max(ports[i] ?? 0, (ports[i - 1] ?? 0) + minGap);
    // Trop de départs pour leur place idéale : répartis régulièrement le long du bord.
    const high = parent.c0 + parent.cs - inset;
    if ((ports.at(-1) ?? 0) > high && ports.length > 1)
      for (let i = 0; i < ports.length; i += 1)
        ports[i] = parent.c0 + inset + (i * (high - parent.c0 - inset)) / (ports.length - 1);
    // Un port n'est jamais en face d'un autre écran de la couche suivante : la flèche qui y arrive suit cette
    // ligne. Il glisse d'une piste vers sa propre cible, sans dépasser ses voisins ni sortir du bord.
    const centers = (placedInLayer[parent.depth + 1] ?? []).map(centerOf);
    sorted.forEach((link, i) => {
      const own = centerOf(nodes.get(link.to) as Node);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const port = ports[i] ?? 0;
        if (!centers.some((c) => Math.abs(c - own) > 0.5 && Math.abs(c - port) < TRACK)) return;
        const lowest = Math.max(parent.c0 + 4, (ports[i - 1] ?? -Infinity) + 6);
        const highest = Math.min(parent.c0 + parent.cs - 4, (ports[i + 1] ?? Infinity) - 6);
        const toward = own >= port ? 1 : -1;
        const next = [port + toward * TRACK, port - toward * TRACK].find(
          (value) => value >= lowest && value <= highest,
        );
        if (next === undefined) return;
        ports[i] = next;
      }
    });
    // Pistes : la transition qui va le plus loin passe le plus près de l'écran de départ (aucun croisement).
    const withPorts = sorted.map((link, index) => ({ link, port: ports[index] ?? 0 }));
    const goingLow = withPorts.filter((item) => centerOf(nodes.get(item.link.to) as Node) < item.port - 0.5);
    const goingHigh = withPorts
      .filter((item) => centerOf(nodes.get(item.link.to) as Node) > item.port + 0.5)
      .reverse();
    const straight = withPorts.filter(
      (item) => Math.abs(centerOf(nodes.get(item.link.to) as Node) - item.port) <= 0.5,
    );
    // Dans chaque groupe, les pistes croissent dans l'ordre d'imbrication : la flèche extérieure tourne avant
    // que l'intérieure n'arrive, leurs segments ne se suivent jamais sur une même ligne.
    let nextTrack = 0;
    const firstOfHigh = goingHigh[0];
    for (const { link, port } of [...goingLow, ...goingHigh, ...straight]) {
      if (firstOfHigh && link === firstOfHigh.link) nextTrack = 0;
      const child = nodes.get(link.to) as Node;
      const target = centerOf(child);
      const start: APoint = { c: port, l: { at: 'layer', layer: parent.depth, offset: parent.ls } };
      const end: APoint = { c: target, l: { at: 'layer', layer: child.depth, offset: 0 } };
      const points: APoint[] =
        Math.abs(target - port) <= 0.5
          ? [
              { c: target, l: start.l },
              { c: target, l: end.l },
            ]
          : (() => {
              const track = takeTrack(parent.depth, { a: port, b: target }, nextTrack);
              nextTrack = track + 1;
              const l: L = { at: 'track', channel: parent.depth, track };
              return [start, { c: port, l }, { c: target, l }, end];
            })();
      // Les segments de l'arbre sont réservés : un couloir de retour ne les suit jamais.
      registerVerticals(points);
      const text = link.kind === 'tree' ? (link.actions[0] ?? '') : '';
      const maxWidth = orientation === 'TB' ? Math.min(LABEL.maxWidthTB, child.cs - 24) : LABEL.maxWidthLR;
      const shown = text ? fitText(text, maxWidth - 2 * LABEL.padX, LABEL.size) : '';
      routes.push({
        link,
        points,
        ...(shown
          ? {
              label: {
                text: shown,
                width: Math.min(maxWidth, textWidth(shown, LABEL.size) + 2 * LABEL.padX),
                c: target,
                channel: parent.depth,
              },
            }
          : {}),
      });
    }
  }

  // 2. Les autres transitions : par les côtés et les couloirs libres entre les cartes.
  // Les ports latéraux, répartis le long du bord ; la voie de chacun le long de ce bord.
  const portOf = (node: Node, side: Side, link: Link): { l: number; lane: number } => {
    const key = `${node.screen.id}|${side}`;
    const list = sidePorts.get(key) ?? [];
    const index = Math.max(0, list.indexOf(link));
    return {
      l: (node.ls * (index + 1)) / (list.length + 1),
      lane: lanes.get(`${key}|${otherLinks.indexOf(link)}`) ?? index,
    };
  };
  const laneC = (node: Node, side: Side, lane: number): number => {
    const offset = Math.min(SIDE_FIRST + lane * TRACK, crossGap / 2 - 6);
    return side === 'high' ? node.c0 + node.cs + offset : node.c0 - offset;
  };
  // Les intervalles transverses libres d'une couche.
  const blocked = (layer: number): Span[] =>
    (placedInLayer[layer] ?? []).map((node) => ({ a: node.c0 - 12, b: node.c0 + node.cs + 12 }));
  const allC = [...nodes.values()];
  const minC = Math.min(...allC.map((node) => node.c0));
  const maxC = Math.max(...allC.map((node) => node.c0 + node.cs));
  const corridor = (fromLayer: number, toLayer: number, preferred: number, from: L, to: L): number => {
    const lo = Math.min(fromLayer, toLayer);
    const hi = Math.max(fromLayer, toLayer);
    const walls: Span[] = [];
    for (let layer = lo; layer <= hi; layer += 1) walls.push(...blocked(layer));
    const span: [number, number] = [
      Math.min(lValue(from), lValue(to)),
      Math.max(lValue(from), lValue(to)) + 999,
    ];
    const free = (c: number): boolean =>
      !walls.some((wall) => c > wall.a && c < wall.b) &&
      !verticals.some(
        (item) => Math.abs(item.c - c) < TRACK - 1 && item.span[0] < span[1] && span[0] < item.span[1],
      );
    const candidates = new Set<number>([minC - 24, maxC + 24]);
    for (let layer = lo; layer <= hi; layer += 1)
      for (const node of placedInLayer[layer] ?? []) {
        candidates.add(node.c0 - crossGap / 2);
        candidates.add(node.c0 + node.cs + crossGap / 2);
      }
    const sorted = [...candidates].sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
    for (const base of sorted)
      for (let step = 0; step < 8; step += 1) {
        const c = base + (step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2) * TRACK;
        if (free(c)) {
          verticals.push({ c, from, to, span });
          return c;
        }
      }
    // Toujours libre : au-delà de la carte.
    let c = maxC + 24;
    while (!free(c)) c += TRACK;
    verticals.push({ c, from, to, span });
    return c;
  };
  // Les voies le long des côtés sont choisies d'abord, en évitant les segments de l'arbre déjà posés et les
  // voies voisines ; un couloir ne s'y superpose jamais ensuite.
  const laneAt = new Map<string, number>();
  const taken = (c: number, span: [number, number]): boolean =>
    verticals.some(
      (item) => Math.abs(item.c - c) < TRACK - 1 && item.span[0] < span[1] && span[0] < item.span[1],
    );
  otherLinks.forEach((link, index) => {
    const sides = sideOf(link);
    for (const [node, side, other] of [
      [nodes.get(link.from) as Node, sides.out, nodes.get(link.to) as Node],
      [nodes.get(link.to) as Node, sides.in, nodes.get(link.from) as Node],
    ] as const) {
      const port = portOf(node, side, link);
      const channel = other.depth < node.depth ? node.depth - 1 : node.depth;
      const from: L = { at: 'layer', layer: node.depth, offset: port.l };
      const to: L = { at: 'track', channel, track: 0 };
      const span: [number, number] = [
        Math.min(lValue(from), lValue(to)),
        Math.max(lValue(from), lValue(to) + 999),
      ];
      let lane = port.lane;
      let c = laneC(node, side, lane);
      while (taken(c, span) && SIDE_FIRST + (lane + 1) * TRACK <= crossGap / 2 - 6)
        c = laneC(node, side, (lane += 1));
      if (taken(c, span)) overflow = true;
      laneAt.set(`${node.screen.id}|${side}|${String(index)}`, c);
      verticals.push({ c, from, to, span });
    }
  });
  for (const link of otherLinks) {
    const a = nodes.get(link.from) as Node;
    const b = nodes.get(link.to) as Node;
    const sides = sideOf(link);
    const out = portOf(a, sides.out, link);
    const inn = portOf(b, sides.in, link);
    const index = otherLinks.indexOf(link);
    const cs = laneAt.get(`${a.screen.id}|${sides.out}|${String(index)}`) ?? laneC(a, sides.out, out.lane);
    const ct = laneAt.get(`${b.screen.id}|${sides.in}|${String(index)}`) ?? laneC(b, sides.in, inn.lane);
    const start: APoint = {
      c: sides.out === 'high' ? a.c0 + a.cs : a.c0,
      l: { at: 'layer', layer: a.depth, offset: out.l },
    };
    const end: APoint = {
      c: sides.in === 'high' ? b.c0 + b.cs : b.c0,
      l: { at: 'layer', layer: b.depth, offset: inn.l },
    };
    // Le canal voisin de chaque écran, du côté de l'autre.
    const c1 = b.depth > a.depth ? a.depth : b.depth < a.depth ? a.depth - 1 : a.depth;
    const c2 = b.depth > a.depth ? b.depth - 1 : b.depth < a.depth ? b.depth : a.depth;
    const points: APoint[] = [start, { c: cs, l: start.l }];
    if (c1 === c2) {
      const track = takeTrack(c1, { a: cs, b: ct });
      const l: L = { at: 'track', channel: c1, track };
      points.push({ c: cs, l }, { c: ct, l });
    } else {
      // Un couloir libre à travers les couches intermédiaires, puis une piste dans chaque canal.
      const lo = Math.min(a.depth, b.depth) + 1;
      const hi = Math.max(a.depth, b.depth) - 1;
      const x = corridor(
        lo,
        hi,
        (cs + ct) / 2,
        { at: 'track', channel: c1, track: 0 },
        {
          at: 'track',
          channel: c2,
          track: 0,
        },
      );
      const l1: L = { at: 'track', channel: c1, track: takeTrack(c1, { a: cs, b: x }) };
      const l2: L = { at: 'track', channel: c2, track: takeTrack(c2, { a: x, b: ct }) };
      points.push({ c: cs, l: l1 }, { c: x, l: l1 }, { c: x, l: l2 }, { c: ct, l: l2 });
    }
    points.push({ c: ct, l: end.l }, end);
    routes.push({ link, points });
  }
  return { orientation, nodes, order, routes, layers, channelTracks, layerSize, spacing, crossGap, overflow };
}

function materialize(p: Plan): MapLayout {
  const { spacing } = p;
  // Épaisseur de chaque canal : ses pistes, puis la bande des étiquettes devant la couche suivante.
  const thickness = (channel: number): number => {
    const tracks = p.channelTracks.get(channel) ?? 0;
    const used = tracks > 0 ? 2 * CHANNEL_PAD + (tracks - 1) * TRACK : CHANNEL_PAD;
    return channel < p.layers - 1 ? Math.max(spacing.minChannel, used + spacing.band) : tracks > 0 ? used : 0;
  };
  const layerStart: number[] = [];
  let cursor = 0;
  for (let layer = 0; layer < p.layers; layer += 1) {
    layerStart.push(cursor);
    cursor += (p.layerSize[layer] ?? 0) + thickness(layer);
  }
  const resolve = (l: L): number => {
    if (l.at === 'layer') return (layerStart[l.layer] ?? 0) + l.offset;
    const channelStart = (layerStart[l.channel] ?? 0) + (p.layerSize[l.channel] ?? 0);
    if (l.at === 'track') return channelStart + CHANNEL_PAD + l.track * TRACK;
    return (layerStart[l.channel + 1] ?? channelStart) - spacing.band / 2;
  };
  const toXY = (c: number, l: number): Point => (p.orientation === 'TB' ? { x: c, y: l } : { x: l, y: c });

  const screens = p.order.map((id) => {
    const node = p.nodes.get(id) as Node;
    const corner = toXY(node.c0, layerStart[node.depth] ?? 0);
    return { ...node.screen, x: corner.x, y: corner.y };
  });
  const links: MapLink[] = p.routes.map((route) => {
    const raw = route.points.map((point) => toXY(point.c, resolve(point.l)));
    const points = simplify(raw);
    const link: MapLink = { ...route.link, points };
    if (route.label) {
      const center = toXY(route.label.c, resolve({ at: 'band', channel: route.label.channel }));
      link.label = {
        text: route.label.text,
        x: center.x - route.label.width / 2,
        y: center.y - LABEL.height / 2,
        width: route.label.width,
        height: LABEL.height,
      };
    }
    return link;
  });

  // Le cadre : tout ce qui est dessiné, plus la marge intérieure.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const box of [...screens, ...links.flatMap((link) => (link.label ? [link.label] : []))]) {
    xs.push(box.x, box.x + box.width);
    ys.push(box.y, box.y + box.height);
  }
  for (const link of links)
    for (const point of link.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
  const dx = MARGIN - Math.min(...xs);
  const dy = MARGIN - Math.min(...ys);
  const move = <T extends Point>(item: T): T => ({ ...item, x: item.x + dx, y: item.y + dy });
  return {
    orientation: p.orientation,
    width: Math.ceil(Math.max(...xs) - Math.min(...xs) + 2 * MARGIN),
    height: Math.ceil(Math.max(...ys) - Math.min(...ys) + 2 * MARGIN),
    screens: screens.map(move),
    links: links.map((link) => ({
      ...link,
      points: link.points.map(move),
      ...(link.label ? { label: move(link.label) } : {}),
    })),
    hidden: 0,
  };
}

/** Retire les points répétés et les points alignés : une polyligne orthogonale minimale. */
function simplify(points: Point[]): Point[] {
  const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  const unique = points.filter((point, index) => index === 0 || !same(point, points[index - 1] as Point));
  return unique.filter((point, index) => {
    const before = unique[index - 1];
    const after = unique[index + 1];
    if (!before || !after) return true;
    const vertical = Math.abs(before.x - point.x) < 0.01 && Math.abs(point.x - after.x) < 0.01;
    const horizontal = Math.abs(before.y - point.y) < 0.01 && Math.abs(point.y - after.y) < 0.01;
    return !vertical && !horizontal;
  });
}
