import { routePattern } from '../crawler/route-normalizer.js';
import type { FlowEdge, FlowGraphData, FlowNode, TransitionResult } from '../model/flow.js';

export interface DiffState {
  id: string;
  label: string;
  route: string;
  url: string;
}

export interface DiffTransition {
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  actionId: string;
  action: { type: string; text?: string; href?: string };
  result: TransitionResult;
  /** "POST /api/users 2xx", un par échange distinct. */
  network: string[];
}

export interface ChangedTransition {
  from: string;
  fromLabel: string;
  actionId: string;
  action: DiffTransition['action'];
  previous: Pick<DiffTransition, 'to' | 'toLabel' | 'result' | 'network'>;
  current: Pick<DiffTransition, 'to' | 'toLabel' | 'result' | 'network'>;
  /** Ce qui a changé, lisible : "target: Create user → Error", "result: SUCCESS → FAILED", "network: + POST /api/users 5xx". */
  changes: string[];
}

export interface FlowDiff {
  addedStates: DiffState[];
  removedStates: DiffState[];
  addedTransitions: DiffTransition[];
  removedTransitions: DiffTransition[];
  changedTransitions: ChangedTransition[];
  summary: {
    addedStates: number;
    removedStates: number;
    addedTransitions: number;
    removedTransitions: number;
    changedTransitions: number;
  };
}

/**
 * Compare deux graphes de flows (une baseline et un nouveau run). Les états sont
 * appariés par leur empreinte (stateId) ; les transitions par leur point de départ
 * et l'action qu'elles exécutent (from + actionId). Une transition qui existe encore
 * mais mène à un autre état, échoue maintenant ou appelle d'autres points d'accès
 * est « modifiée ». Seules les transitions exécutées comptent : les actions bloquées
 * décrivent les réglages de sécurité de la mission, pas l'application.
 */
export class FlowDiffEngine {
  compare(previous: FlowGraphData, current: FlowGraphData): FlowDiff {
    const before = indexGraph(previous);
    const after = indexGraph(current);

    const addedStates = [...after.states.values()].filter((state) => !before.states.has(state.id));
    const removedStates = [...before.states.values()].filter((state) => !after.states.has(state.id));
    const addedTransitions: DiffTransition[] = [];
    const removedTransitions: DiffTransition[] = [];
    const changedTransitions: ChangedTransition[] = [];

    for (const [key, transition] of after.transitions) {
      const old = before.transitions.get(key);
      if (!old) {
        addedTransitions.push(transition);
        continue;
      }
      const changes: string[] = [];
      if (old.to !== transition.to) changes.push(`target: ${old.toLabel} → ${transition.toLabel}`);
      if (old.result !== transition.result) changes.push(`result: ${old.result} → ${transition.result}`);
      const gone = old.network.filter((call) => !transition.network.includes(call));
      const added = transition.network.filter((call) => !old.network.includes(call));
      if (gone.length > 0 || added.length > 0) {
        changes.push(
          `network: ${[...added.map((call) => `+ ${call}`), ...gone.map((call) => `- ${call}`)].join(', ')}`,
        );
      }
      if (changes.length === 0) continue;
      changedTransitions.push({
        from: transition.from,
        fromLabel: transition.fromLabel,
        actionId: transition.actionId,
        action: transition.action,
        previous: { to: old.to, toLabel: old.toLabel, result: old.result, network: old.network },
        current: {
          to: transition.to,
          toLabel: transition.toLabel,
          result: transition.result,
          network: transition.network,
        },
        changes,
      });
    }
    for (const [key, transition] of before.transitions) {
      if (!after.transitions.has(key)) removedTransitions.push(transition);
    }

    return {
      addedStates,
      removedStates,
      addedTransitions,
      removedTransitions,
      changedTransitions,
      summary: {
        addedStates: addedStates.length,
        removedStates: removedStates.length,
        addedTransitions: addedTransitions.length,
        removedTransitions: removedTransitions.length,
        changedTransitions: changedTransitions.length,
      },
    };
  }
}

/** Vrai quand rien ne diffère. */
export function isEmptyDiff(diff: FlowDiff): boolean {
  return Object.values(diff.summary).every((count) => count === 0);
}

/**
 * FLOW DIFF
 *
 * + Import users (/users/import)
 * - Settings → "Permissions" → Permissions
 *
 * Changed:
 *   Users → "Create user"
 *     target: Create user → Error
 */
export function renderFlowDiffText(diff: FlowDiff): string {
  const lines: string[] = ['FLOW DIFF', ''];
  const transition = (t: DiffTransition): string =>
    `${t.fromLabel} → "${t.action.text ?? t.action.href ?? t.action.type}" → ${t.toLabel}`;
  for (const state of diff.addedStates) lines.push(`+ ${state.label} (${state.route})`);
  for (const t of diff.addedTransitions) lines.push(`+ ${transition(t)}`);
  for (const state of diff.removedStates) lines.push(`- ${state.label} (${state.route})`);
  for (const t of diff.removedTransitions) lines.push(`- ${transition(t)}`);
  if (diff.changedTransitions.length > 0) {
    lines.push('', 'Changed:');
    for (const changed of diff.changedTransitions) {
      lines.push(
        `  ${changed.fromLabel} → "${changed.action.text ?? changed.action.href ?? changed.action.type}"`,
      );
      for (const change of changed.changes) lines.push(`    ${change}`);
    }
  }
  if (isEmptyDiff(diff)) lines.push('(no difference)');
  return lines.join('\n');
}

function indexGraph(data: FlowGraphData): {
  states: Map<string, DiffState>;
  transitions: Map<string, DiffTransition>;
} {
  const nodes = new Map<string, FlowNode>(data.nodes.map((node) => [node.id, node]));
  const labelOf = (id: string): string => {
    const node = nodes.get(id);
    return node?.label ?? id;
  };
  const states = new Map<string, DiffState>();
  for (const node of data.nodes) {
    states.set(node.id, { id: node.id, label: node.label, route: node.route, url: node.url });
  }
  const transitions = new Map<string, DiffTransition>();
  for (const edge of data.edges) {
    if (edge.result === 'BLOCKED') continue;
    // La dernière tentative l'emporte (une transition reprise ou rejouée).
    transitions.set(transitionKey(edge), {
      from: edge.from,
      fromLabel: labelOf(edge.from),
      to: edge.to,
      toLabel: labelOf(edge.to),
      actionId: edge.actionId,
      action: {
        type: edge.action.type,
        ...(edge.action.text ? { text: edge.action.text } : {}),
        ...(edge.action.href ? { href: edge.action.href } : {}),
      },
      result: edge.result,
      network: networkSignature(edge),
    });
  }
  return { states, transitions };
}

/**
 * Identité d'une transition d'un run et d'un environnement à l'autre : son état de
 * départ et son contrôle (type, libellé, genre de cible). Les id d'action contiennent
 * l'URL complète, qui change d'un environnement à l'autre.
 */
export function transitionKey(edge: Pick<FlowEdge, 'from' | 'action'>): string {
  let target = edge.action.href ?? '';
  if (target) {
    try {
      target = routePattern(new URL(target).pathname);
    } catch {
      // garder le href tel qu'enregistré
    }
  }
  return `${edge.from}::${edge.action.type}|${(edge.action.text ?? edge.action.label ?? '').toLowerCase()}|${target}`;
}

/** Échanges distincts d'une transition, sans les données qui changent à chaque run (id, requête, statut exact). */
export function networkSignature(edge: Pick<FlowEdge, 'network'>): string[] {
  const calls = new Set<string>();
  for (const exchange of edge.network ?? []) {
    let path = exchange.url;
    try {
      path = routePattern(new URL(exchange.url).pathname);
    } catch {
      // garder l'URL telle qu'enregistrée
    }
    const outcome =
      exchange.status !== undefined
        ? `${Math.floor(exchange.status / 100)}xx`
        : exchange.failure
          ? 'failed'
          : 'no answer';
    calls.add(`${exchange.method} ${path} ${outcome}`);
  }
  return [...calls].sort();
}
