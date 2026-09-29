import { createHash } from 'node:crypto';
import { FlowDiffEngine, networkSignature, transitionKey } from '../diff/flow-diff.js';
import type { FlowEdge, FlowGraphData, FlowNode, TransitionResult } from '../model/flow.js';
import type { FlowRunReport } from '../model/flow-run.js';
import type { NetworkExchange } from '../model/network.js';

/**
 * FLOW EVOLUTION : v1 → v2 → v3 → v4, pas seulement baseline contre run courant.
 *
 * Une ligne par élément (état, transition, flow imposé), mise à jour à chaque run : quand
 * il est apparu, quand il a disparu, depuis quand une transition mène ailleurs, combien de
 * versions un flow a traversées — sans copier les graphes. La comparaison est celle du
 * FlowDiffEngine existant : le run contre une référence reconstruite depuis ces lignes.
 *
 * Une exploration partielle ne prouve pas une disparition : un état n'est déclaré disparu
 * qu'après une exploration complète ; une action, quand son écran a été revu sans elle.
 */
export type EvolutionKind = 'STATE' | 'TRANSITION' | 'FLOW';
export type EvolutionChange =
  | 'APPEARED'
  | 'REAPPEARED'
  | 'DISAPPEARED'
  | 'TARGET_CHANGED'
  | 'RESULT_CHANGED'
  | 'NETWORK_CHANGED'
  | 'PATH_CHANGED';

export interface Sighting {
  at: string;
  run: string;
  version: string;
}

export interface EvolutionEvent extends Sighting {
  change: EvolutionChange;
  detail?: string;
}

/** Ce qu'il faut pour reconstruire la référence du FlowDiffEngine (jamais une valeur saisie). */
export interface EvolutionSnapshot {
  state?: { url: string; route: string };
  transition?: {
    from: string;
    to: string;
    actionId: string;
    action: { type: FlowEdge['action']['type']; text?: string; label?: string; href?: string };
    result: TransitionResult;
    network: string[];
  };
  /** FLOW : les états traversés, dans l'ordre. */
  path?: string[];
}

export interface ElementEvolution {
  kind: EvolutionKind;
  /** Clé de stockage (≤ 200 caractères). */
  key: string;
  label: string;
  status: 'PRESENT' | 'DISAPPEARED';
  firstSeen: Sighting;
  lastSeen: Sighting;
  disappeared?: Sighting;
  /** TRANSITION : la destination actuelle, et depuis quand. */
  targetLabel?: string;
  targetSince?: Sighting;
  /** Versions distinctes où l'élément a été vu (les 50 dernières) et leur nombre total. */
  versions: string[];
  versionCount: number;
  runs: number;
  history: EvolutionEvent[];
  snapshot: EvolutionSnapshot;
}

export interface EvolutionRunInfo extends Sighting {
  /** L'exploration a tout vu (plus rien à explorer) : une absence est alors une disparition. */
  complete: boolean;
}

/** Un changement de ce run, pour le rapport et le journal. */
export interface EvolutionChangeView {
  kind: EvolutionKind;
  label: string;
  change: EvolutionChange;
  detail?: string;
  /** Vu pour la première fois (pour « disparu après N versions »). */
  firstSeen: Sighting;
  versionCount: number;
}

export interface EvolutionResult {
  /** Les éléments touchés par ce run (à enregistrer). */
  records: ElementEvolution[];
  changes: EvolutionChangeView[];
}

const MAX_VERSIONS = 50;

/** Clé courte et stable d'un texte long (transitionKey, nom de flow). */
export function shortKey(kind: EvolutionKind, identity: string): string {
  const text = `${kind}:${identity}`;
  return text.length <= 120
    ? text
    : `${kind}:${createHash('sha1').update(identity).digest('hex').slice(0, 32)}`;
}

export function evolveFlows(
  previous: readonly ElementEvolution[],
  current: FlowGraphData,
  flows: readonly FlowRunReport[],
  run: EvolutionRunInfo,
  options: { historyLimit: number },
): EvolutionResult {
  const byKey = new Map(previous.map((record) => [record.key, structuredClone(record)]));
  const touched = new Map<string, ElementEvolution>();
  const changes: EvolutionChangeView[] = [];
  const sighting: Sighting = { at: run.at, run: run.run, version: run.version };
  const note = (record: ElementEvolution, change: EvolutionChange, detail?: string): void => {
    record.history.push({ ...sighting, change, ...(detail ? { detail } : {}) });
    if (record.history.length > options.historyLimit)
      record.history.splice(0, record.history.length - options.historyLimit);
    changes.push({
      kind: record.kind,
      label: record.label,
      change,
      ...(detail ? { detail } : {}),
      firstSeen: record.firstSeen,
      versionCount: record.versionCount,
    });
  };
  const seen = (record: ElementEvolution): void => {
    record.lastSeen = sighting;
    record.runs += 1;
    if (!record.versions.includes(run.version)) {
      record.versions.push(run.version);
      record.versionCount += 1;
      if (record.versions.length > MAX_VERSIONS) record.versions.shift();
    }
    touched.set(record.key, record);
  };
  const create = (
    kind: EvolutionKind,
    key: string,
    label: string,
    snapshot: EvolutionSnapshot,
  ): ElementEvolution => ({
    kind,
    key,
    label,
    status: 'PRESENT',
    firstSeen: sighting,
    lastSeen: sighting,
    versions: [],
    versionCount: 0,
    runs: 0,
    history: [],
    snapshot,
  });
  /** Présent dans ce run : créé (APPEARED), revenu (REAPPEARED) ou simplement revu. */
  const present = (
    kind: EvolutionKind,
    key: string,
    label: string,
    snapshot: EvolutionSnapshot,
  ): ElementEvolution => {
    let record = byKey.get(key);
    if (!record) {
      record = create(kind, key, label, snapshot);
      byKey.set(key, record);
      seen(record);
      note(record, 'APPEARED');
      return record;
    }
    record.label = label;
    if (record.status === 'DISAPPEARED') {
      record.status = 'PRESENT';
      delete record.disappeared;
      seen(record);
      note(record, 'REAPPEARED');
    } else seen(record);
    return record;
  };

  // ---- la référence : ce que l'historique connaît encore, reconstruit pour le FlowDiffEngine
  const reference = referenceGraph([...byKey.values()]);
  const diff = new FlowDiffEngine().compare(reference, current);
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const labelOf = (id: string): string =>
    nodes.get(id)?.label ?? byKey.get(shortKey('STATE', id))?.label ?? id;

  // États
  for (const node of current.nodes)
    present('STATE', shortKey('STATE', node.id), node.label, { state: { url: node.url, route: node.route } });
  if (run.complete)
    for (const state of diff.removedStates) {
      const record = byKey.get(shortKey('STATE', state.id));
      if (!record || record.status !== 'PRESENT') continue;
      record.status = 'DISAPPEARED';
      record.disappeared = sighting;
      touched.set(record.key, record);
      note(record, 'DISAPPEARED', 'not reached by a complete exploration');
    }

  // Transitions (exécutées) : apparues, revues, modifiées
  const executed = new Map<string, FlowEdge>();
  for (const edge of current.edges) if (edge.result !== 'BLOCKED') executed.set(transitionKey(edge), edge);
  const changed = new Map(diff.changedTransitions.map((transition) => [transition.key, transition]));
  for (const [identity, edge] of executed) {
    const label = `${labelOf(edge.from)} → "${edge.action.text ?? edge.action.label ?? edge.action.type}"`;
    const snapshot: EvolutionSnapshot = {
      transition: {
        from: edge.from,
        to: edge.to,
        actionId: edge.actionId,
        action: {
          type: edge.action.type,
          ...(edge.action.text ? { text: edge.action.text } : {}),
          ...(edge.action.label ? { label: edge.action.label } : {}),
          ...(edge.action.href ? { href: edge.action.href } : {}),
        },
        result: edge.result,
        network: networkSignature(edge),
      },
    };
    const record = present('TRANSITION', shortKey('TRANSITION', identity), label, snapshot);
    const change = changed.get(identity);
    if (change) {
      if (change.previous.to !== change.current.to) {
        record.targetSince = sighting;
        note(record, 'TARGET_CHANGED', `${change.previous.toLabel} → ${change.current.toLabel}`);
      }
      if (change.previous.result !== change.current.result)
        note(record, 'RESULT_CHANGED', `${change.previous.result} → ${change.current.result}`);
      const network = change.changes.find((text) => text.startsWith('network:'));
      if (network) note(record, 'NETWORK_CHANGED', network.slice('network: '.length));
    }
    if (!record.targetSince) record.targetSince = record.firstSeen;
    record.targetLabel = labelOf(edge.to);
    record.snapshot = snapshot;
  }
  // Une action disparue : son écran a été revu, et elle n'y est plus proposée.
  for (const transition of diff.removedTransitions) {
    const record = byKey.get(shortKey('TRANSITION', transition.key));
    const node = nodes.get(transition.from);
    if (!record || record.status !== 'PRESENT' || !node) continue;
    if (offeredKeys(node).has(transition.key)) continue; // encore là, simplement pas exécutée
    record.status = 'DISAPPEARED';
    record.disappeared = sighting;
    touched.set(record.key, record);
    note(
      record,
      'DISAPPEARED',
      `"${transition.action.text ?? transition.action.type}" no longer on "${node.label}"`,
    );
  }

  // Flows imposés : les états traversés
  for (const flow of flows) {
    if (flow.status !== 'PASSED' || flow.states.length === 0) continue;
    const key = shortKey('FLOW', flow.name);
    const before = byKey.get(key);
    const path = flow.states.map((id) => labelOf(id));
    const record = present('FLOW', key, flow.name, { path: flow.states });
    const oldPath = before?.snapshot.path;
    if (before && oldPath && oldPath.join('>') !== flow.states.join('>'))
      note(record, 'PATH_CHANGED', `${oldPath.map((id) => labelOf(id)).join(' → ')} ⇒ ${path.join(' → ')}`);
    record.snapshot = { path: flow.states };
  }

  return { records: [...touched.values()], changes };
}

/** La référence du FlowDiffEngine : les états et transitions encore présents dans l'historique. */
function referenceGraph(records: readonly ElementEvolution[]): FlowGraphData {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  for (const record of records) {
    if (record.status !== 'PRESENT') continue;
    if (record.kind === 'STATE' && record.snapshot.state)
      nodes.push({
        id: record.key.slice('STATE:'.length),
        label: record.label,
        url: record.snapshot.state.url,
        route: record.snapshot.state.route,
        headings: [],
        depth: 0,
        discoveredActions: [],
        actions: {},
        firstSeenAt: record.firstSeen.at,
        lastSeenAt: record.lastSeen.at,
        visits: record.runs,
        issueIds: [],
      });
    const transition = record.snapshot.transition;
    if (record.kind === 'TRANSITION' && transition)
      edges.push({
        from: transition.from,
        to: transition.to,
        actionId: transition.actionId,
        action: { ...transition.action, category: 'other', classification: 'SAFE' },
        result: transition.result,
        timestamp: record.lastSeen.at,
        issueIds: [],
        network: transition.network.map(exchangeOf),
      });
  }
  return { version: 1, nodes, edges };
}

/** Les transitions encore proposées par un écran (ses actions découvertes). */
function offeredKeys(node: FlowNode): Set<string> {
  return new Set(Object.values(node.actions).map((action) => transitionKey({ from: node.id, action })));
}

/** L'échange minimal qui redonne la même signature au FlowDiffEngine. */
function exchangeOf(signature: string): NetworkExchange {
  const [method = 'GET', path = '/', outcome = ''] = signature.split(' ');
  const family = /^(\d)xx$/.exec(outcome)?.[1];
  return {
    method,
    url: `http://evolution.invalid${path}`,
    resourceType: 'fetch',
    ...(family ? { status: Number(family) * 100 } : outcome === 'failed' ? { failure: 'failed' } : {}),
  };
}
