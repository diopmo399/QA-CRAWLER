import type { CompositionCheck } from './contracts.js';
import { compileLoop, loopProblems, type JourneyLoopItem, type JourneyLoopSpec } from './journey-loop.js';
import { waitProblems, waitStep, type WaitSpec } from './wait.js';

/**
 * LE PARCOURS VISUEL DE LA BIBLIOTHÈQUE : un modèle logique unique, vu en mode linéaire (une suite de blocs)
 * ou en mode libre (un diagramme). Trois représentations restent séparées :
 *
 *   1. la disposition visuelle : la position de chaque nœud (x, y), le mode préféré ;
 *   2. la logique du parcours : des nœuds (début, blocs, attentes, conditions, jonctions, fins) et des connexions ;
 *   3. le format exécutable : des scénarios `steps: - run: <bloc>` (avec `with:` pour les données propres
 *      à une instance), produits par `compileJourneyPath`, chemin par chemin.
 *
 * Le moteur rejoue une suite d'étapes : il n'évalue pas de condition. Un parcours sans condition donne un
 * scénario. Un parcours avec conditions ne devient exécutable que sur demande explicite, un scénario par
 * chemin (la condition n'est pas évaluée au rejeu : chaque branche est une variante de test) ; aucun
 * branchement n'est jamais aplati en une séquence. Des fonctions pures, partagées par le serveur et le
 * Dashboard.
 */

export const JOURNEY_NODE_KINDS = ['START', 'BLOCK', 'WAIT', 'LOOP', 'CONDITION', 'JOIN', 'END'] as const;
export type JourneyNodeKind = (typeof JOURNEY_NODE_KINDS)[number];
export const JOURNEY_MODES = ['LINEAR', 'DIAGRAM'] as const;
export type JourneyMode = (typeof JOURNEY_MODES)[number];
export type JourneyBranch = 'YES' | 'NO';

/** Le paramètre d'une instance pour une entrée du contrat du bloc : une valeur, ou une autre clé. */
export type JourneyParam = { mode: 'VALUE'; value: string } | { mode: 'MAP'; key: string };

export interface JourneyNode {
  id: string;
  kind: JourneyNodeKind;
  /** BLOCK : le bloc rejoué et la version acceptée pour ce parcours. */
  block?: string;
  version?: number;
  /** CONDITION : la question (« Dossier urgent ? ») ; un libellé libre ailleurs. */
  label?: string;
  x: number;
  y: number;
  /** BLOCK : par clé d'entrée du contrat, ce que reçoit CETTE instance (absent : l'amont ou les données). */
  params?: Record<string, JourneyParam>;
  /** WAIT : la condition attendue (compilée en étape `expect`, voir wait.ts). */
  wait?: WaitSpec;
  /** LOOP : la boucle et son corps (compilée en étape `loop:`, voir journey-loop.ts). */
  loop?: JourneyLoopSpec;
}

export interface JourneyEdge {
  id: string;
  from: string;
  to: string;
  /** Une connexion qui part d'une condition : sa branche. */
  branch?: JourneyBranch;
}

export interface JourneyGraph {
  nodes: JourneyNode[];
  edges: JourneyEdge[];
}

export interface Journey {
  name: string;
  description?: string;
  /** Le mode d'édition préféré (la logique ne dépend pas du mode). */
  mode: JourneyMode;
  graph: JourneyGraph;
  /** Révision enregistrée (empreinte) : une sauvegarde sur une révision périmée est refusée. */
  revision?: string;
  updatedAt?: string;
  /** Les scénarios produits par ce parcours. */
  published?: string[];
}

export interface JourneySummary {
  name: string;
  description?: string;
  mode: JourneyMode;
  blocks: number;
  conditions: number;
  updatedAt?: string;
  published: string[];
}

/** Un chemin du début à une fin : ses nœuds, ses choix de branche, et la vérification de ses données. */
export interface JourneyPathCheck {
  index: number;
  nodes: string[];
  choices: { node: string; label: string; branch: JourneyBranch }[];
  check: CompositionCheck;
}

export interface JourneyNodeDiagnostics {
  errors: string[];
  warnings: string[];
  /** Les données disponibles avant ce nœud sur TOUS les chemins qui l'atteignent. */
  available: string[];
  /** Les entrées obligatoires manquantes, avec le chemin concerné. */
  missing: { key: string; path: number }[];
  produces: string[];
  /** D'où vient chaque entrée (sur le premier chemin qui l'atteint). */
  satisfied: { key: string; from: string }[];
  /**
   * RACCORDEMENT : pour chaque entrée obligatoire sans donnée du même nom, les données disponibles en amont
   * (sur tous les chemins) qui pourraient la fournir. UNIQUE : une seule compatible, avec une raison (sens,
   * type ou nom) — proposée, jamais retenue sans une personne ; AMBIGUOUS : plusieurs ; NONE : aucune.
   */
  proposals?: MappingProposal[];
}

export interface MappingCandidate {
  key: string;
  /** Le nœud qui la produit, ou `data` (jeu d'un bloc du chemin). */
  from: string;
  type: string;
  meaning?: string;
  compatible: boolean;
  /** Pourquoi elle est proposée, ou pourquoi elle ne convient pas. */
  reason: string;
}

export interface MappingProposal {
  input: string;
  type: string;
  meaning?: string;
  status: 'UNIQUE' | 'AMBIGUOUS' | 'NONE';
  candidates: MappingCandidate[];
}

/**
 * Les sorties d'un parcours : les données que ses blocs produisent. Garanties : produites sur TOUS les
 * chemins ; sinon, seulement sur certains (numéros de chemins, à partir de 1).
 */
export interface JourneyOutputs {
  guaranteed: string[];
  partial: { key: string; paths: number[] }[];
}

export interface JourneyCheck {
  ok: boolean;
  /** Le parcours se lit sans perte en mode linéaire. */
  linear: boolean;
  linearReason?: string;
  /** Ce que « Créer » produirait : un scénario, un par chemin, ou rien (erreurs). */
  publishable: 'SINGLE' | 'PER_PATH' | 'NONE';
  paths: JourneyPathCheck[];
  nodes: Record<string, JourneyNodeDiagnostics>;
  edges: Record<string, string[]>;
  errors: string[];
  warnings: string[];
  outputs: JourneyOutputs;
}

export const JOURNEY_LIMITS = { nodes: 60, edges: 120, paths: 16, blocksPerPath: 30 } as const;
const PARAM_KEY = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

const nodeName = (node: JourneyNode): string =>
  node.kind === 'BLOCK'
    ? `« ${node.block ?? '?'} »`
    : node.kind === 'WAIT'
      ? 'l’attente'
      : node.kind === 'LOOP'
        ? 'la boucle'
        : node.kind === 'CONDITION'
          ? `la condition « ${node.label ?? '?'} »`
          : node.kind === 'JOIN'
            ? 'la jonction'
            : node.kind === 'START'
              ? 'le début'
              : 'la fin';

/** Le point de départ d'une connexion (le port de sortie, Oui à gauche et Non à droite d'une condition). */
export function portOf(node: JourneyNode, branch?: JourneyBranch): { x: number; y: number } {
  const size = NODE_SIZE[node.kind];
  // Une condition (losange) sort par ses pointes : Oui à gauche, Non à droite.
  if (node.kind === 'CONDITION')
    return { x: branch === 'NO' ? node.x + size.w : node.x, y: node.y + size.h / 2 };
  return { x: node.x + size.w / 2, y: node.y + size.h };
}

type Point = { x: number; y: number };

/**
 * Le tracé orthogonal d'une connexion, en points : du port de sortie au haut du nœud d'arrivée. Une
 * arrivée au-dessus du départ (retour en arrière) contourne par la droite des deux nœuds.
 */
export function edgePoints(from: JourneyNode, to: JourneyNode, branch?: JourneyBranch): Point[] {
  const start = portOf(from, branch);
  const end = { x: to.x + NODE_SIZE[to.kind].w / 2, y: to.y };
  const side = Math.max(from.x + NODE_SIZE[from.kind].w, to.x + NODE_SIZE[to.kind].w) + 32;
  if (from.kind === 'CONDITION') {
    const out = start.x + (branch === 'NO' ? 24 : -24);
    if (end.y > start.y + 12)
      return Math.abs(end.x - start.x) < 1 || (branch === 'NO' ? end.x > start.x : end.x < start.x)
        ? [start, { x: end.x, y: start.y }, end]
        : [start, { x: out, y: start.y }, { x: out, y: end.y - 24 }, { x: end.x, y: end.y - 24 }, end];
    return [start, { x: out, y: start.y }, { x: out, y: end.y - 24 }, { x: end.x, y: end.y - 24 }, end];
  }
  if (end.y >= start.y + 24) {
    if (Math.abs(end.x - start.x) < 1) return [start, end];
    const mid = Math.round((start.y + end.y) / 2);
    return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  }
  return [
    start,
    { x: start.x, y: start.y + 24 },
    { x: side, y: start.y + 24 },
    { x: side, y: end.y - 24 },
    { x: end.x, y: end.y - 24 },
    end,
  ];
}

/** Les points d'une connexion en tracé SVG, angles légèrement arrondis. */
export function pointsPath(points: readonly Point[], radius = 8): string {
  const [first, ...rest] = points;
  if (!first) return '';
  let d = `M${String(first.x)} ${String(first.y)}`;
  for (let index = 0; index < rest.length; index += 1) {
    const corner = rest[index] as Point;
    const before = points[index] as Point;
    const after = rest[index + 1];
    if (!after) {
      d += ` L${String(corner.x)} ${String(corner.y)}`;
      continue;
    }
    const r = Math.min(
      radius,
      Math.hypot(corner.x - before.x, corner.y - before.y) / 2,
      Math.hypot(after.x - corner.x, after.y - corner.y) / 2,
    );
    const into = (a: Point, b: Point, length: number): Point => {
      const distance = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: b.x - ((b.x - a.x) / distance) * length, y: b.y - ((b.y - a.y) / distance) * length };
    };
    const p1 = into(before, corner, r);
    const p2 = into(after, corner, r);
    d += ` L${String(p1.x)} ${String(p1.y)} Q${String(corner.x)} ${String(corner.y)} ${String(p2.x)} ${String(p2.y)}`;
  }
  return d;
}

/** Le tracé d'une connexion (orthogonal, du port de sortie au haut du nœud d'arrivée). */
export function edgePath(from: JourneyNode, to: JourneyNode, branch?: JourneyBranch): string {
  return pointsPath(edgePoints(from, to, branch));
}

/** La distance d'un point à une connexion (pour déposer un bloc sur elle). */
export function distanceToPoints(points: readonly Point[], point: Point): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1] as Point;
    const b = points[index] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t =
      length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
    best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return best;
}

/** Un identifiant libre (n1, n2… / e1, e2…). */
export function freeId(prefix: 'n' | 'e', taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let index = 1; ; index += 1) {
    const id = `${prefix}${String(index)}`;
    if (!used.has(id)) return id;
  }
}

/** La taille d'un nœud dans le diagramme (ses ports et ses connexions en dépendent). */
export const NODE_SIZE: Readonly<Record<JourneyNodeKind, { w: number; h: number }>> = {
  START: { w: 120, h: 40 },
  END: { w: 120, h: 40 },
  BLOCK: { w: 200, h: 58 },
  WAIT: { w: 180, h: 58 },
  LOOP: { w: 240, h: 104 },
  CONDITION: { w: 160, h: 92 },
  JOIN: { w: 116, h: 34 },
};

const COLUMN_X = 0;
const ROW_GAP = 104;

/** Un parcours vide : un début relié à une fin. */
export function emptyJourney(name = ''): Journey {
  return {
    name,
    mode: 'LINEAR',
    graph: {
      nodes: [
        { id: 'n1', kind: 'START', x: COLUMN_X - NODE_SIZE.START.w / 2, y: 0 },
        { id: 'n2', kind: 'END', x: COLUMN_X - NODE_SIZE.END.w / 2, y: ROW_GAP },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    },
  };
}

/** Le parcours linéaire équivalent à une suite de blocs (un ancien parcours composé, par exemple). */
export function journeyOfParts(name: string, parts: readonly { block: string; version?: number }[]): Journey {
  const journey = emptyJourney(name);
  const start = journey.graph.nodes[0] as JourneyNode;
  const end = journey.graph.nodes[1] as JourneyNode;
  const blocks: JourneyNode[] = parts.map((part, index) => ({
    id: `n${String(index + 3)}`,
    kind: 'BLOCK',
    block: part.block,
    ...(part.version !== undefined ? { version: part.version } : {}),
    x: COLUMN_X,
    y: 0,
  }));
  return { ...journey, graph: chain(start, blocks, end, [], true) };
}

/**
 * La chaîne début → blocs → fin : les connexions sont refaites dans l'ordre des blocs ; la disposition en
 * colonne n'est recalculée que sur demande (`relayout`), sinon les positions restent celles de l'utilisateur.
 */
export function chain(
  start: JourneyNode,
  blocks: readonly JourneyNode[],
  end: JourneyNode,
  previousEdges: readonly JourneyEdge[],
  relayout: boolean,
): JourneyGraph {
  const order = [start, ...blocks, end];
  const nodes = relayout
    ? order.map((node, index) => ({
        ...node,
        x: COLUMN_X - Math.round(NODE_SIZE[node.kind].w / 2),
        y: index * ROW_GAP,
      }))
    : order.map((node) => ({ ...node }));
  const taken = new Set(previousEdges.map((edge) => edge.id));
  const edges: JourneyEdge[] = [];
  for (let index = 0; index < order.length - 1; index += 1) {
    const from = order[index] as JourneyNode;
    const to = order[index + 1] as JourneyNode;
    const kept = previousEdges.find((edge) => edge.from === from.id && edge.to === to.id && !edge.branch);
    const id = kept?.id ?? freeId('e', [...taken, ...edges.map((edge) => edge.id)]);
    edges.push({ id, from: from.id, to: to.id });
  }
  return { nodes, edges };
}

/** Le mode linéaire tient-il sans perte ? L'ordre des blocs, ou la raison précise. */
export function linearOrder(
  graph: JourneyGraph,
): { ok: true; start: JourneyNode; blocks: JourneyNode[]; end: JourneyNode } | { ok: false; reason: string } {
  const conditions = graph.nodes.filter((node) => node.kind === 'CONDITION');
  if (conditions.length > 0)
    return {
      ok: false,
      reason: `le parcours contient ${String(conditions.length)} condition(s) : un branchement ne se lit pas comme une suite`,
    };
  if (graph.nodes.some((node) => node.kind === 'JOIN'))
    return { ok: false, reason: 'le parcours contient une jonction : elle réunit des branches' };
  const starts = graph.nodes.filter((node) => node.kind === 'START');
  const ends = graph.nodes.filter((node) => node.kind === 'END');
  if (starts.length !== 1 || ends.length !== 1)
    return { ok: false, reason: 'un mode linéaire a exactement un début et une fin' };
  const start = starts[0] as JourneyNode;
  const end = ends[0] as JourneyNode;
  const blocks: JourneyNode[] = [];
  const seen = new Set([start.id]);
  let current = start;
  for (;;) {
    const out = graph.edges.filter((edge) => edge.from === current.id);
    if (out.length !== 1) {
      return {
        ok: false,
        reason:
          out.length === 0
            ? `${nodeName(current)} n’est relié à rien : la suite est interrompue`
            : `${nodeName(current)} a ${String(out.length)} sorties : ce n’est plus une suite`,
      };
    }
    const next = graph.nodes.find((node) => node.id === (out[0] as JourneyEdge).to);
    if (!next) return { ok: false, reason: 'une connexion mène à un nœud absent' };
    if (seen.has(next.id)) return { ok: false, reason: 'une boucle relie des blocs entre eux' };
    seen.add(next.id);
    if (next.kind === 'END') break;
    blocks.push(next);
    current = next;
  }
  const orphans = graph.nodes.filter((node) => !seen.has(node.id));
  if (orphans.length > 0)
    return {
      ok: false,
      reason: `${String(orphans.length)} nœud(s) hors de la suite (${orphans.map(nodeName).join(', ')}) : ils seraient perdus`,
    };
  return { ok: true, start, blocks, end };
}

/** LA STRUCTURE du graphe : règles de chaque type de nœud, connexions, accessibilité, boucles. */
export function journeyStructure(graph: JourneyGraph): {
  errors: string[];
  warnings: string[];
  nodes: Record<string, string[]>;
  edges: Record<string, string[]>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodes: Record<string, string[]> = {};
  const edges: Record<string, string[]> = {};
  const onNode = (id: string, text: string): void => {
    (nodes[id] ??= []).push(text);
  };
  const onEdge = (id: string, text: string): void => {
    (edges[id] ??= []).push(text);
  };
  if (graph.nodes.length > JOURNEY_LIMITS.nodes) errors.push(`${String(JOURNEY_LIMITS.nodes)} nœuds au plus`);
  if (graph.edges.length > JOURNEY_LIMITS.edges)
    errors.push(`${String(JOURNEY_LIMITS.edges)} connexions au plus`);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  if (byId.size !== graph.nodes.length) errors.push('deux nœuds ont le même identifiant');
  const starts = graph.nodes.filter((node) => node.kind === 'START');
  if (starts.length === 0) errors.push('le parcours n’a pas de début');
  if (starts.length > 1) for (const node of starts.slice(1)) onNode(node.id, 'un seul début par parcours');
  if (!graph.nodes.some((node) => node.kind === 'END')) errors.push('le parcours n’a pas de fin');

  const valid: JourneyEdge[] = [];
  const seenPairs = new Set<string>();
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      onEdge(edge.id, 'connexion vers un nœud absent');
      continue;
    }
    if (edge.from === edge.to) {
      onEdge(edge.id, 'un nœud ne se relie pas à lui-même');
      continue;
    }
    if (to.kind === 'START') onEdge(edge.id, 'rien ne mène au début');
    if (from.kind === 'END') onEdge(edge.id, 'rien ne part d’une fin');
    if (edge.branch && from.kind !== 'CONDITION')
      onEdge(edge.id, 'seule une condition a des branches Oui/Non');
    if (from.kind === 'CONDITION' && !edge.branch) onEdge(edge.id, 'une sortie de condition est Oui ou Non');
    const pair = `${edge.from}>${edge.to}>${edge.branch ?? ''}`;
    if (seenPairs.has(pair)) onEdge(edge.id, 'connexion en double');
    seenPairs.add(pair);
    if (!edges[edge.id]) valid.push(edge);
  }
  const out = (id: string): JourneyEdge[] => valid.filter((edge) => edge.from === id);
  const into = (id: string): JourneyEdge[] => valid.filter((edge) => edge.to === id);
  for (const node of graph.nodes) {
    const outs = out(node.id);
    const ins = into(node.id);
    switch (node.kind) {
      case 'START':
        if (outs.length !== 1) onNode(node.id, 'le début mène à exactement un nœud');
        break;
      case 'BLOCK':
        if (!node.block) onNode(node.id, 'aucun bloc choisi');
        if (ins.length === 0) onNode(node.id, 'rien ne mène à ce bloc');
        if (outs.length !== 1)
          onNode(
            node.id,
            outs.length === 0
              ? 'ce bloc ne mène nulle part'
              : 'un bloc a une seule sortie : utilisez une condition',
          );
        break;
      case 'WAIT':
        if (!node.wait) onNode(node.id, 'aucune condition d’attente');
        else for (const problem of waitProblems(node.wait)) onNode(node.id, problem);
        if (ins.length === 0) onNode(node.id, 'rien ne mène à cette attente');
        if (outs.length !== 1)
          onNode(
            node.id,
            outs.length === 0 ? 'cette attente ne mène nulle part' : 'une attente a une seule sortie',
          );
        break;
      case 'LOOP':
        if (!node.loop) onNode(node.id, 'aucune boucle définie');
        else for (const problem of loopProblems(node.loop)) onNode(node.id, problem);
        if (ins.length === 0) onNode(node.id, 'rien ne mène à cette boucle');
        if (outs.length !== 1)
          onNode(
            node.id,
            outs.length === 0 ? 'cette boucle ne mène nulle part' : 'une boucle a une seule sortie',
          );
        break;
      case 'CONDITION': {
        if (!node.label?.trim()) onNode(node.id, 'la condition n’a pas de question');
        if (ins.length === 0) onNode(node.id, 'rien ne mène à cette condition');
        const yes = outs.filter((edge) => edge.branch === 'YES').length;
        const no = outs.filter((edge) => edge.branch === 'NO').length;
        if (yes !== 1 || no !== 1 || outs.length !== 2)
          onNode(node.id, 'une condition a exactement une branche Oui et une branche Non');
        break;
      }
      case 'JOIN':
        if (ins.length < 2) onNode(node.id, 'une jonction réunit au moins deux branches');
        if (outs.length !== 1) onNode(node.id, 'une jonction mène à exactement un nœud');
        break;
      case 'END':
        if (ins.length === 0) onNode(node.id, 'rien ne mène à cette fin');
        if (outs.length > 0) onNode(node.id, 'rien ne part d’une fin');
        break;
    }
  }
  // Accessibilité depuis le début, et chaque nœud doit pouvoir atteindre une fin.
  const start = starts[0];
  if (start) {
    const reached = new Set([start.id]);
    const queue = [start.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const edge of out(id))
        if (!reached.has(edge.to)) {
          reached.add(edge.to);
          queue.push(edge.to);
        }
    }
    for (const node of graph.nodes)
      if (!reached.has(node.id)) onNode(node.id, 'inaccessible depuis le début');
    const ending = new Set(graph.nodes.filter((node) => node.kind === 'END').map((node) => node.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of valid)
        if (ending.has(edge.to) && !ending.has(edge.from)) {
          ending.add(edge.from);
          grew = true;
        }
    }
    for (const node of graph.nodes)
      if (reached.has(node.id) && !ending.has(node.id))
        onNode(node.id, 'aucune fin n’est atteinte depuis ce nœud');
  }
  // Une connexion qui revient en arrière est une boucle NON contrôlée (sans limite ni condition d'arrêt) :
  // refusée ; une répétition passe par un nœud Boucle, borné et interprété par le moteur.
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const edge of out(id)) {
      const mark = state.get(edge.to);
      if (mark === 1)
        onEdge(
          edge.id,
          'boucle non contrôlée : une connexion ne revient pas en arrière, utilisez un nœud Boucle (borné)',
        );
      else if (mark === undefined) visit(edge.to);
    }
    state.set(id, 2);
  };
  for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id);
  const blocks = graph.nodes.filter((node) => node.kind === 'BLOCK');
  const looped = graph.nodes.flatMap((node) =>
    node.kind === 'LOOP'
      ? (node.loop?.body ?? []).filter((item) => item.kind === 'BLOCK').map((item) => ({ node, item }))
      : [],
  );
  if (blocks.length === 0 && looped.length === 0) errors.push('ajoutez au moins un bloc');
  // Paramètres d'instance : des clés valides (blocs du parcours et blocs des boucles).
  const checkParams = (id: string, params: JourneyNode['params'], where = ''): void => {
    for (const [key, param] of Object.entries(params ?? {})) {
      if (param.mode === 'MAP' && !PARAM_KEY.test(param.key))
        onNode(id, `${where}l’entrée ${key} est reliée à « ${param.key} », qui n’est pas une clé de donnée`);
      if (param.mode === 'VALUE' && param.value.trim() === '')
        onNode(id, `${where}l’entrée ${key} attend une valeur`);
    }
  };
  for (const node of blocks) checkParams(node.id, node.params);
  for (const { node, item } of looped) checkParams(node.id, item.params, `« ${item.block ?? '?'} » : `);
  return { errors, warnings, nodes, edges };
}

/** Les chemins du début aux fins (au plus JOURNEY_LIMITS.paths + 1 : au-delà, c'est une erreur). */
export function journeyPaths(
  graph: JourneyGraph,
): { nodes: string[]; choices: JourneyPathCheck['choices'] }[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const start = graph.nodes.find((node) => node.kind === 'START');
  if (!start) return [];
  const paths: { nodes: string[]; choices: JourneyPathCheck['choices'] }[] = [];
  const walk = (id: string, nodes: string[], choices: JourneyPathCheck['choices']): void => {
    if (paths.length > JOURNEY_LIMITS.paths) return;
    const node = byId.get(id);
    if (!node || nodes.includes(id)) return;
    const here = [...nodes, id];
    if (node.kind === 'END') {
      paths.push({ nodes: here, choices });
      return;
    }
    for (const edge of graph.edges.filter((candidate) => candidate.from === id))
      walk(
        edge.to,
        here,
        node.kind === 'CONDITION' && edge.branch
          ? [...choices, { node: id, label: node.label ?? '', branch: edge.branch }]
          : choices,
      );
  };
  walk(start.id, [], []);
  return paths;
}

/** La clé de donnée propre à une instance (une valeur saisie pour l'entrée d'un bloc). */
export const instanceKey = (key: string, nodeId: string): string => `${key}__${nodeId}`;

/** Une étape compilée : un bloc rejoué (`run:` + `with:`), ou une attente (`expect` avec délai). */
export type CompiledJourneyStep =
  | { run: string; with?: Record<string, string> }
  | ({ expect: Record<string, unknown> } & Record<string, unknown>)
  | ({ loop: Record<string, unknown> } & Record<string, unknown>);

/**
 * LE FORMAT EXÉCUTABLE d'un chemin : `run: <bloc>` par bloc, avec `with:` quand l'instance reçoit une valeur
 * ou une autre clé ; les valeurs saisies deviennent des données du scénario (clé propre à l'instance). Une
 * attente devient une étape `expect` à sa place dans la suite.
 */
export function compileJourneyPath(
  graph: JourneyGraph,
  path: readonly string[],
): { steps: CompiledJourneyStep[]; values: { key: string; value: string }[] } {
  const steps: CompiledJourneyStep[] = [];
  const values: { key: string; value: string }[] = [];
  for (const id of path) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node?.kind === 'WAIT' && node.wait) {
      steps.push(waitStep(node.wait, node.label) as CompiledJourneyStep);
      continue;
    }
    const instance = (
      id: string,
      block: string,
      params: JourneyNode['params'],
    ): { run: string; with?: Record<string, string> } => {
      const mapping: Record<string, string> = {};
      for (const [key, param] of Object.entries(params ?? {})) {
        if (param.mode === 'MAP') mapping[key] = param.key;
        else {
          const own = instanceKey(key, id);
          mapping[key] = own;
          values.push({ key: own, value: param.value });
        }
      }
      return { run: block, ...(Object.keys(mapping).length > 0 ? { with: mapping } : {}) };
    };
    if (node?.kind === 'LOOP' && node.loop) {
      // UNE BOUCLE reste une boucle : une seule étape `loop:` que le moteur interprète (jamais aplatie).
      steps.push(
        compileLoop(node.id, node.loop, node.label, (item: JourneyLoopItem) =>
          item.block ? instance(item.id, item.block, item.params) : undefined,
        ) as CompiledJourneyStep,
      );
      continue;
    }
    if (node?.kind !== 'BLOCK' || !node.block) continue;
    steps.push(instance(node.id, node.block, node.params));
  }
  return { steps, values };
}

/**
 * Le nom du scénario d'un chemin (publication « un scénario par chemin ») : une lettre par chemin (A, B…),
 * car les noms de dossiers des flows masquent les chiffres.
 */
export const pathLetter = (index: number): string => String.fromCharCode(65 + (index % 26));

export function pathScenarioName(name: string, index: number): string {
  const suffix = ` · chemin ${pathLetter(index)}`;
  return `${name.slice(0, 80 - suffix.length).trim()}${suffix}`;
}

/** Une empreinte courte et stable du contenu d'un parcours (révision). */
export function journeyRevision(journey: Pick<Journey, 'name' | 'description' | 'mode' | 'graph'>): string {
  const text = JSON.stringify([journey.name, journey.description ?? '', journey.mode, journey.graph]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Les sorties d'une instance de bloc : celles de son contrat, renommées par une correspondance (`MAP`) ;
 * une valeur propre à l'instance (`VALUE`) n'en est pas une (clé interne).
 */
export function instanceOutputs(node: JourneyNode, outputs: readonly string[]): string[] {
  return outputs.flatMap((key) => {
    const param = node.params?.[key];
    if (!param) return [key];
    return param.mode === 'MAP' ? [param.key] : [];
  });
}

/** Garanties (sur tous les chemins) et partielles (sur certains), à partir des sorties de chaque chemin. */
export function journeyOutputs(perPath: readonly (readonly string[])[]): JourneyOutputs {
  const all = [...new Set(perPath.flat())].sort();
  const guaranteed =
    perPath.length === 0 ? [] : all.filter((key) => perPath.every((keys) => keys.includes(key)));
  const partial = all
    .filter((key) => !guaranteed.includes(key))
    .map((key) => ({
      key,
      paths: perPath.flatMap((keys, index) => (keys.includes(key) ? [index + 1] : [])),
    }));
  return { guaranteed, partial };
}
