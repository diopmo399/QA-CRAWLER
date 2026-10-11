import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowEdge } from '../model/flow.js';

/**
 * OBSERVED WORKFLOW GRAPH : ce que le run a RÉELLEMENT parcouru, écran par écran.
 *
 * Ce qui existait : le FlowGraph (états + transitions, `result.states` / `result.transitions`),
 * les états visités par chaque flow (`FlowRunReport.states`), les étapes avec leur état atteint,
 * les checkpoints sémantiques du moteur cognitif. Ce qui est nouveau : une vue unique, orientée
 * workflow — des nœuds (écrans) annotés de ce qui s'y est passé (étapes, anomalies, checkpoints),
 * des arêtes annotées du résultat, du réseau et du temps, et le chemin de chaque flow avec sa
 * première divergence. Rien n'est recalculé : le graphe relie des faits déjà établis.
 */

export interface WorkflowGraphNode {
  id: string;
  label: string;
  route: string;
  /** URL masquée. */
  url: string;
  visits: number;
  /** Étapes des flows qui ont atteint cet écran : « flow#index ». */
  steps: string[];
  /** Les flows passés par cet écran. */
  flows: string[];
  issueIds: string[];
  /** Première divergence d'un flow sur cet écran. */
  divergences: { flow: string; step: number; reason: string }[];
  screenshot?: string;
}

export interface WorkflowGraphEdge {
  from: string;
  to: string;
  actionId: string;
  label: string;
  type: string;
  result: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  flow?: string;
  durationMs?: number;
  network?: { requests: number; writes: number; errors: number };
  oracle?: string;
}

export interface WorkflowPath {
  flow: string;
  status: string;
  /** Les écrans dans l'ordre (id), sans répétition consécutive. */
  states: string[];
  /** Chaque étape et l'écran où elle a laissé le parcours. */
  steps: { index: number; description: string; status: string; stateId?: string }[];
  divergence?: { step: number; stateId?: string; reason: string };
}

export interface ObservedWorkflowGraph {
  runId: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  paths: WorkflowPath[];
  /** Les checkpoints sémantiques du moteur cognitif (id → statut), quand il est actif. */
  checkpoints: { id: string; status: string }[];
  summary: {
    nodes: number;
    edges: number;
    /** Écrans atteints par au moins un flow imposé. */
    coveredByFlows: number;
    /** Écrans vus seulement par l'exploration autonome. */
    autonomousOnly: number;
    failedEdges: number;
    blockedEdges: number;
  };
}

const isWrite = (method: string): boolean => /^(POST|PUT|PATCH|DELETE)$/i.test(method);

function edgeOf(edge: FlowEdge): WorkflowGraphEdge {
  const network = edge.network;
  return {
    from: edge.from,
    to: edge.to,
    actionId: edge.actionId,
    label: edge.action.label ?? edge.action.text ?? edge.action.type,
    type: edge.action.type,
    result: edge.result,
    ...(edge.flow ? { flow: edge.flow } : {}),
    ...(edge.durationMs !== undefined ? { durationMs: edge.durationMs } : {}),
    ...(network && network.length > 0
      ? {
          network: {
            requests: network.length,
            writes: network.filter((exchange) => isWrite(exchange.method)).length,
            errors: network.filter(
              (exchange) =>
                exchange.failure !== undefined || (exchange.status !== undefined && exchange.status >= 400),
            ).length,
          },
        }
      : {}),
    ...(edge.oracle ? { oracle: edge.oracle.status } : {}),
  };
}

/** Le graphe observé du run, construit à partir des états, transitions et flows du résultat. */
export function buildWorkflowGraph(result: ExplorationResult): ObservedWorkflowGraph {
  const nodes = new Map<string, WorkflowGraphNode>();
  for (const state of result.states)
    nodes.set(state.id, {
      id: state.id,
      label: state.label,
      route: state.route,
      url: state.url,
      visits: state.visits,
      steps: [],
      flows: [],
      issueIds: [...state.issueIds],
      divergences: [],
      ...(state.screenshot ? { screenshot: state.screenshot } : {}),
    });
  const paths: WorkflowPath[] = [];
  for (const flow of result.flows) {
    const states: string[] = [];
    for (const step of flow.steps) {
      if (!step.stateId) continue;
      if (states[states.length - 1] !== step.stateId) states.push(step.stateId);
      const node = nodes.get(step.stateId);
      if (!node) continue;
      node.steps.push(`${flow.name}#${String(step.index)}`);
      if (!node.flows.includes(flow.name)) node.flows.push(flow.name);
    }
    const divergence = flow.divergence;
    const divergenceState = divergence
      ? flow.steps.find((step) => step.index === divergence.stepIndex)?.stateId
      : undefined;
    if (divergence && divergenceState)
      nodes
        .get(divergenceState)
        ?.divergences.push({ flow: flow.name, step: divergence.stepIndex, reason: divergence.reason });
    paths.push({
      flow: flow.name,
      status: flow.status,
      states,
      steps: flow.steps.map((step) => ({
        index: step.index,
        description: step.description,
        status: step.status,
        ...(step.stateId ? { stateId: step.stateId } : {}),
      })),
      ...(divergence
        ? {
            divergence: {
              step: divergence.stepIndex,
              ...(divergenceState ? { stateId: divergenceState } : {}),
              reason: divergence.reason,
            },
          }
        : {}),
    });
  }
  const edges = result.transitions.map(edgeOf);
  const all = [...nodes.values()];
  return {
    runId: result.runId ?? '',
    nodes: all,
    edges,
    paths,
    checkpoints: (result.cognitive?.checkpoints ?? []).map((checkpoint) => ({ ...checkpoint })),
    summary: {
      nodes: all.length,
      edges: edges.length,
      coveredByFlows: all.filter((node) => node.flows.length > 0).length,
      autonomousOnly: all.filter((node) => node.flows.length === 0).length,
      failedEdges: edges.filter((edge) => edge.result === 'FAILED').length,
      blockedEdges: edges.filter((edge) => edge.result === 'BLOCKED').length,
    },
  };
}
