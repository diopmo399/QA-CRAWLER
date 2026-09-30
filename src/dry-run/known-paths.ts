import type { KnownPath } from './dry-run-driver.js';

/** Une transition connue, par signatures stables (écran --action--> écran). */
export interface KnownEdge {
  from: string;
  action: string;
  to: string;
  /** Nombre d'observations. */
  count: number;
  source: 'graph' | 'historical';
}

/**
 * Chemins connus de l'écran `from` vers un écran où l'intention a abouti : largeur
 * d'abord (les plus courts d'abord), au plus `maxDepth` actions, au plus `maxPaths`
 * chemins, sans repasser par un écran. La fréquence d'un chemin est son maillon le plus
 * faible ; `share` est sa part parmi les chemins trouvés — une fréquence historique
 * observée, jamais une probabilité d'être correct.
 */
export function findKnownPaths(
  edges: readonly KnownEdge[],
  from: string,
  isTarget: (state: string) => boolean,
  options: { maxDepth: number; maxPaths: number },
): KnownPath[] {
  const outgoing = new Map<string, KnownEdge[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const list = outgoing.get(edge.from) ?? [];
    const same = list.find((known) => known.action === edge.action && known.to === edge.to);
    if (same) {
      same.count += edge.count;
      if (edge.source === 'historical') same.source = 'historical';
    } else list.push({ ...edge });
    outgoing.set(edge.from, list);
  }
  for (const list of outgoing.values())
    list.sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));

  const found: { actions: string[]; observations: number; historical: boolean }[] = [];
  const queue: {
    state: string;
    actions: string[];
    seen: Set<string>;
    observations: number;
    historical: boolean;
  }[] = [
    {
      state: from,
      actions: [],
      seen: new Set([from]),
      observations: Number.POSITIVE_INFINITY,
      historical: false,
    },
  ];
  while (queue.length > 0 && found.length < options.maxPaths) {
    const node = queue.shift();
    if (!node) break;
    if (node.actions.length >= options.maxDepth) continue;
    for (const edge of outgoing.get(node.state) ?? []) {
      if (node.seen.has(edge.to)) continue;
      const next = {
        state: edge.to,
        actions: [...node.actions, edge.action],
        seen: new Set([...node.seen, edge.to]),
        observations: Math.min(node.observations, edge.count),
        historical: node.historical || edge.source === 'historical',
      };
      if (isTarget(edge.to)) {
        found.push(next);
        if (found.length >= options.maxPaths) break;
        continue;
      }
      queue.push(next);
    }
  }
  const total = found.reduce((sum, path) => sum + path.observations, 0);
  return found.map((path) => ({
    actions: path.actions,
    source: path.historical ? 'historical' : 'graph',
    observations: path.observations,
    ...(found.length > 1 && total > 0 ? { share: Math.round((path.observations / total) * 100) / 100 } : {}),
  }));
}
