import type { FlowEdge, FlowNode } from '../model/flow.js';

export interface FlowTreeNode {
  node: FlowNode;
  /** Action qui a mené ici depuis le parent la première fois. */
  via?: FlowEdge;
  children: FlowTreeNode[];
}

/**
 * Arbre couvrant du graphe des flows : chaque état apparaît une fois, sous l'état
 * depuis lequel il a été atteint la première fois. Suffisant pour lire la structure
 * d'une application (Tableau de bord → Utilisateurs → Détail…) sans bibliothèque de graphes.
 */
export function buildFlowTree(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  rootId?: string,
): FlowTreeNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = rootId ? byId.get(rootId) : nodes[0];
  if (!root) return undefined;
  // Un état atteint par une entrée du menu global va sous la racine quand la racine offre cette entrée.
  const rootMenu = new Set(
    Object.values(root.actions)
      .filter((action) => action.category === 'menu')
      .map((action) => `${action.type}|${action.text ?? ''}|${action.href ?? ''}`),
  );
  const effective = edges.map((edge) =>
    edge.action.category === 'menu' &&
    rootMenu.has(`${edge.action.type}|${edge.action.text ?? ''}|${edge.action.href ?? ''}`)
      ? { ...edge, from: root.id }
      : edge,
  );
  const placed = new Set([root.id]);
  const tree: FlowTreeNode = { node: root, children: [] };
  const queue: FlowTreeNode[] = [tree];
  while (queue.length > 0) {
    const current = queue.shift() as FlowTreeNode;
    for (const edge of effective) {
      if (edge.from !== current.node.id || edge.result !== 'SUCCESS' || placed.has(edge.to)) continue;
      const child = byId.get(edge.to);
      if (!child) continue;
      placed.add(child.id);
      const branch: FlowTreeNode = { node: child, via: edge, children: [] };
      current.children.push(branch);
      queue.push(branch);
    }
  }
  // Les états atteints seulement par des sauts / rejeux méritent quand même une place.
  for (const node of nodes) {
    if (!placed.has(node.id)) tree.children.push({ node, children: [] });
  }
  return tree;
}

/** Arbre en texte simple, par exemple pour la CLI :  Home ├── Users │   └── User detail └── Settings */
export function renderTextTree(tree: FlowTreeNode | undefined): string {
  if (!tree) return '';
  const lines = [displayName(tree.node)];
  const walk = (branch: FlowTreeNode, prefix: string): void => {
    branch.children.forEach((child, index) => {
      const last = index === branch.children.length - 1;
      const via = child.via
        ? `  ⟵ ${child.via.action.type} "${child.via.action.text ?? child.via.action.label ?? ''}"`
        : '';
      lines.push(`${prefix}${last ? '└── ' : '├── '}${displayName(child.node)}${via}`);
      walk(child, `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  walk(tree, '');
  return lines.join('\n');
}

export function displayName(node: FlowNode): string {
  const name = node.headings[0] ?? node.title ?? node.label;
  return node.subtitle && node.subtitle !== name ? `${name} › ${node.subtitle}` : name;
}
