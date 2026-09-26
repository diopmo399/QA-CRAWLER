import type { ActionSummary, DiscoveredAction } from '../model/discovered-action.js';
import type { BrowserInteractionResult } from '../interactions/types.js';
import type { FlowEdge, FlowGraphData, FlowNode, TransitionResult } from '../model/flow.js';

export interface NodeInput {
  id: string;
  label: string;
  url: string;
  route: string;
  title?: string;
  headings: string[];
  subtitle?: string;
  depth: number;
  actions: readonly DiscoveredAction[];
  timestamp?: string;
}

/**
 * The functional map of the application, built during exploration:
 * nodes are states (screens, steps, tabs), edges are attempted actions.
 * It is also the explorer's memory of what was already tried, so the same
 * action is never retried from the same state.
 */
export class FlowGraph {
  private readonly nodes = new Map<string, FlowNode>();
  private readonly edges: FlowEdge[] = [];
  /** `${stateId}::${actionId}` of every attempted (or blocked) action. */
  private readonly tried = new Set<string>();
  private readonly interactions: BrowserInteractionResult[] = [];
  private root: string | undefined;

  static fromJSON(data: FlowGraphData): FlowGraph {
    const graph = new FlowGraph();
    for (const node of data.nodes) graph.nodes.set(node.id, { ...node });
    for (const edge of data.edges) {
      graph.edges.push({ ...edge });
      graph.tried.add(triedKey(edge.from, edge.actionId));
    }
    graph.root = data.rootId ?? data.nodes[0]?.id;
    for (const interaction of data.interactions ?? []) graph.interactions.push({ ...interaction });
    return graph;
  }

  toJSON(): FlowGraphData {
    return {
      version: 1,
      ...(this.root ? { rootId: this.root } : {}),
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
      ...(this.interactions.length > 0 ? { interactions: [...this.interactions] } : {}),
    };
  }

  /** Adds a state, or refreshes it (new actions, visit count) when already known. Returns true if new. */
  addNode(input: NodeInput): boolean {
    const now = input.timestamp ?? new Date().toISOString();
    const existing = this.nodes.get(input.id);
    const summaries: Record<string, ActionSummary> = {};
    for (const action of input.actions) {
      summaries[action.id] = {
        type: action.type,
        category: action.category,
        classification: action.classification,
        ...(action.text ? { text: action.text } : {}),
        ...(action.label ? { label: action.label } : {}),
        ...(action.href ? { href: action.href } : {}),
      };
    }
    if (existing) {
      existing.visits += 1;
      existing.depth = Math.min(existing.depth, input.depth);
      existing.lastSeenAt = now;
      for (const action of input.actions) {
        if (!existing.discoveredActions.includes(action.id)) existing.discoveredActions.push(action.id);
      }
      existing.actions = { ...existing.actions, ...summaries };
      return false;
    }
    this.nodes.set(input.id, {
      id: input.id,
      label: input.label,
      url: input.url,
      route: input.route,
      ...(input.title ? { title: input.title } : {}),
      headings: input.headings,
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
      depth: input.depth,
      discoveredActions: input.actions.map((action) => action.id),
      actions: summaries,
      firstSeenAt: now,
      lastSeenAt: now,
      visits: 1,
      issueIds: [],
    });
    this.root ??= input.id;
    return true;
  }

  addEdge(
    edge: Omit<FlowEdge, 'timestamp' | 'issueIds'> & Partial<Pick<FlowEdge, 'timestamp' | 'issueIds'>>,
  ): FlowEdge {
    const full: FlowEdge = {
      ...edge,
      timestamp: edge.timestamp ?? new Date().toISOString(),
      issueIds: edge.issueIds ?? [],
    };
    this.edges.push(full);
    this.tried.add(triedKey(edge.from, edge.actionId));
    return full;
  }

  /** Records an action the SafetyPolicy refused: it is never proposed again from this state. */
  recordBlocked(stateId: string, action: DiscoveredAction, reason: string): FlowEdge {
    return this.addEdge({
      from: stateId,
      to: stateId,
      actionId: action.id,
      action: summaryOf(action),
      result: 'BLOCKED',
      reason,
    });
  }

  /** Stores a browser interaction (already free of secrets) with the flow. */
  recordInteraction(result: BrowserInteractionResult): void {
    this.interactions.push({ ...result, details: { ...result.details } });
  }

  allInteractions(): BrowserInteractionResult[] {
    return [...this.interactions];
  }

  hasNode(stateId: string): boolean {
    return this.nodes.has(stateId);
  }

  getNode(stateId: string): FlowNode | undefined {
    return this.nodes.get(stateId);
  }

  /** True once the action was attempted (or blocked) from this state. */
  hasTransition(from: string, actionId: string): boolean {
    return this.tried.has(triedKey(from, actionId));
  }

  /** Ids of actions discovered on the state and never attempted. */
  getUnexploredActions(stateId: string): string[] {
    const node = this.nodes.get(stateId);
    if (!node) return [];
    return node.discoveredActions.filter((actionId) => !this.tried.has(triedKey(stateId, actionId)));
  }

  /** States whose route pattern is `route`. */
  statesForRoute(route: string): FlowNode[] {
    return [...this.nodes.values()].filter((node) => node.route === route);
  }

  /**
   * Shortest successful path of transitions from the root to a state (empty
   * for the root). A link validated from one state is also usable from any
   * other state offering a link to the same target (a global menu entry): the
   * path then uses that state's own action id, so it can be replayed.
   */
  pathTo(stateId: string): FlowEdge[] {
    if (!this.root || stateId === this.root) return [];
    const successes = this.edges.filter((edge) => edge.result === 'SUCCESS' && edge.from !== edge.to);
    const byTarget = new Map<string, FlowEdge>();
    for (const edge of successes) {
      if (edge.action.type === 'navigate' && edge.action.href && !byTarget.has(edge.action.href)) {
        byTarget.set(edge.action.href, edge);
      }
    }
    const outgoing = (nodeId: string): FlowEdge[] => {
      const real = successes.filter((edge) => edge.from === nodeId);
      const node = this.nodes.get(nodeId);
      if (!node) return real;
      const equivalent: FlowEdge[] = [];
      for (const [actionId, action] of Object.entries(node.actions)) {
        const known = action.type === 'navigate' && action.href ? byTarget.get(action.href) : undefined;
        if (known && known.from !== nodeId) equivalent.push({ ...known, from: nodeId, actionId });
      }
      return [...real, ...equivalent];
    };

    const previous = new Map<string, FlowEdge>();
    const queue = [this.root];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const edge of outgoing(current)) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        previous.set(edge.to, edge);
        if (edge.to === stateId) {
          const path: FlowEdge[] = [];
          let cursor: string | undefined = stateId;
          while (cursor && cursor !== this.root) {
            const step = previous.get(cursor);
            if (!step) break;
            path.unshift(step);
            cursor = step.from;
          }
          return path;
        }
        queue.push(edge.to);
      }
    }
    return [];
  }

  /** State ids from the root to a state, for issue attribution and reports. */
  flowTo(stateId: string): string[] {
    if (!this.root) return [stateId];
    if (stateId === this.root) return [stateId];
    const path = this.pathTo(stateId);
    return path.length > 0 ? [this.root, ...path.map((edge) => edge.to)] : [stateId];
  }

  attachIssues(stateId: string, issueIds: readonly string[]): void {
    const node = this.nodes.get(stateId);
    if (!node) return;
    for (const id of issueIds) if (!node.issueIds.includes(id)) node.issueIds.push(id);
  }

  setScreenshot(stateId: string, file: string): void {
    const node = this.nodes.get(stateId);
    if (node && !node.screenshot) node.screenshot = file;
  }

  get rootId(): string | undefined {
    return this.root;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  allNodes(): FlowNode[] {
    return [...this.nodes.values()];
  }

  allEdges(): FlowEdge[] {
    return [...this.edges];
  }

  countEdges(result: TransitionResult): number {
    return this.edges.filter((edge) => edge.result === result).length;
  }
}

function triedKey(stateId: string, actionId: string): string {
  return `${stateId}::${actionId}`;
}

export function summaryOf(action: DiscoveredAction): FlowEdge['action'] {
  return {
    type: action.type,
    category: action.category,
    classification: action.classification,
    ...(action.text ? { text: action.text } : {}),
    ...(action.label ? { label: action.label } : {}),
    ...(action.href ? { href: action.href } : {}),
  };
}
