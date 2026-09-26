import type { FlowEdge, FlowNode } from '../model/flow.js';

export interface FlowTreeNode {
  node: FlowNode;
  /** Action that first led here from the parent. */
  via?: FlowEdge;
  children: FlowTreeNode[];
}

/**
 * Spanning tree of the flow graph: each state appears once, under the state
 * from which it was first reached. Good enough to read an application's
 * structure (Dashboard → Users → User detail…) without a graph library.
 */
export function buildFlowTree(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  rootId?: string,
): FlowTreeNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = rootId ? byId.get(rootId) : nodes[0];
  if (!root) return undefined;
  // A state reached through a global menu entry belongs under the root when the root offers that entry.
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
  // States reached only by jumps/replays still deserve a place.
  for (const node of nodes) {
    if (!placed.has(node.id)) tree.children.push({ node, children: [] });
  }
  return tree;
}

/** Plain-text tree, e.g. for the CLI:  Home ├── Users │   └── User detail └── Settings */
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
