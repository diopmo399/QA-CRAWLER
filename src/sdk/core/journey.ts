import type { CompositionCheck } from './contracts.js';

/**
 * LE PARCOURS VISUEL DE LA BIBLIOTHÈQUE : un modèle logique unique, vu en mode linéaire (une suite de blocs)
 * ou en mode libre (un diagramme). Trois représentations restent séparées :
 *
 *   1. la disposition visuelle : la position de chaque nœud (x, y), le mode préféré ;
 *   2. la logique du parcours : des nœuds (début, blocs, conditions, jonctions, fins) et des connexions ;
 *   3. le format exécutable : des scénarios `steps: - run: <bloc>` (avec `with:` pour les données propres
 *      à une instance), produits par `compileJourneyPath`, chemin par chemin.
 *
 * Le moteur rejoue une suite d'étapes : il n'évalue pas de condition. Un parcours sans condition donne un
 * scénario. Un parcours avec conditions ne devient exécutable que sur demande explicite, un scénario par
 * chemin (la condition n'est pas évaluée au rejeu : chaque branche est une variante de test) ; aucun
 * branchement n'est jamais aplati en une séquence. Des fonctions pures, partagées par le serveur et le
 * Dashboard.
 */

export const JOURNEY_NODE_KINDS = ['START', 'BLOCK', 'CONDITION', 'JOIN', 'END'] as const;
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
  const ratio = node.kind === 'CONDITION' ? (branch === 'NO' ? 0.78 : 0.22) : 0.5;
  return { x: node.x + size.w * ratio, y: node.y + size.h };
}

/** Le tracé d'une connexion : une courbe du port de sortie au haut du nœud d'arrivée. */
export function edgePath(from: JourneyNode, to: JourneyNode, branch?: JourneyBranch): string {
  const start = portOf(from, branch);
  const end = { x: to.x + NODE_SIZE[to.kind].w / 2, y: to.y };
  const bend = Math.max(36, Math.abs(end.y - start.y) / 2);
  return `M${String(start.x)} ${String(start.y)} C${String(start.x)} ${String(start.y + bend)} ${String(end.x)} ${String(end.y - bend)} ${String(end.x)} ${String(end.y)}`;
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
  START: { w: 140, h: 44 },
  END: { w: 140, h: 44 },
  BLOCK: { w: 232, h: 76 },
  CONDITION: { w: 208, h: 76 },
  JOIN: { w: 132, h: 40 },
};

const COLUMN_X = 0;
const ROW_GAP = 124;

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
  // Boucles : aucune n'est exécutable (pas de boucle contrôlée dans le moteur).
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const edge of out(id)) {
      const mark = state.get(edge.to);
      if (mark === 1) onEdge(edge.id, 'boucle : le moteur ne rejoue pas de boucle, retirez cette connexion');
      else if (mark === undefined) visit(edge.to);
    }
    state.set(id, 2);
  };
  for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id);
  const blocks = graph.nodes.filter((node) => node.kind === 'BLOCK');
  if (blocks.length === 0) errors.push('ajoutez au moins un bloc');
  // Paramètres d'instance : des clés valides.
  for (const node of blocks)
    for (const [key, param] of Object.entries(node.params ?? {})) {
      if (param.mode === 'MAP' && !PARAM_KEY.test(param.key))
        onNode(node.id, `l’entrée ${key} est reliée à « ${param.key} », qui n’est pas une clé de donnée`);
      if (param.mode === 'VALUE' && param.value.trim() === '')
        onNode(node.id, `l’entrée ${key} attend une valeur`);
    }
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

/**
 * LE FORMAT EXÉCUTABLE d'un chemin : `run: <bloc>` par bloc, avec `with:` quand l'instance reçoit une valeur
 * ou une autre clé ; les valeurs saisies deviennent des données du scénario (clé propre à l'instance).
 */
export function compileJourneyPath(
  graph: JourneyGraph,
  path: readonly string[],
): { steps: { run: string; with?: Record<string, string> }[]; values: { key: string; value: string }[] } {
  const steps: { run: string; with?: Record<string, string> }[] = [];
  const values: { key: string; value: string }[] = [];
  for (const id of path) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node?.kind !== 'BLOCK' || !node.block) continue;
    const mapping: Record<string, string> = {};
    for (const [key, param] of Object.entries(node.params ?? {})) {
      if (param.mode === 'MAP') mapping[key] = param.key;
      else {
        const own = instanceKey(key, node.id);
        mapping[key] = own;
        values.push({ key: own, value: param.value });
      }
    }
    steps.push({ run: node.block, ...(Object.keys(mapping).length > 0 ? { with: mapping } : {}) });
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
