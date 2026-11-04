import { SECRET_KEY_PATTERN } from '../../config/flow-schema.js';
import type { ContractField, ExecutionDetail } from '../core/contracts.js';
import { instanceKey, type JourneyGraph, type JourneyNode } from '../core/journey.js';
import { loopVariableKeys, loopSummary } from '../core/journey-loop.js';
import type {
  JourneyTraceability,
  TraceCorrespondence,
  TraceEndpoint,
  TraceEvent,
  TraceFlowNode,
  TraceRun,
  TraceVariable,
} from '../core/journey-trace.js';
import { waitSummary } from '../core/wait.js';
import { blocksOf, flowEntries, readRegistry, type BlockInfo } from './library.js';
import { checkJourney, getJourney, sanitizeJourney } from './library-journeys.js';
import { executionDetail, listExecutions } from './platform.js';

/**
 * LA TRAÇABILITÉ D'UN PARCOURS (modèle : src/sdk/core/journey-trace.ts) : les définitions viennent des
 * contrats des blocs et de la vérification du parcours ; les traces viennent du rapport d'une exécution
 * RÉELLE de ce parcours (scénario créé ou exécution de simulation), lu sur disque. Aucune valeur n'est
 * produite ici : une donnée sans trace observée reste « non observée ».
 */

const SENSITIVE = /pass(word)?|pwd|secret|token|otp|cookie|session|credential|api[-_]?key|private/i;
const PRODUCTIONS = new Set(['GENERATED', 'CAPTURED', 'ITERATION']);

interface Placed {
  node: JourneyNode;
  /** Le nœud de boucle qui le contient. */
  loop?: JourneyNode;
}

/** Tous les blocs du parcours, corps des boucles compris (un élément de boucle vu comme un nœud BLOCK). */
function placedBlocks(graph: JourneyGraph): Placed[] {
  return graph.nodes.flatMap((node): Placed[] => {
    if (node.kind === 'BLOCK') return [{ node }];
    if (node.kind !== 'LOOP' || !node.loop) return [];
    return node.loop.body
      .filter((item) => item.kind === 'BLOCK')
      .map((item) => ({
        node: {
          id: item.id,
          kind: 'BLOCK' as const,
          ...(item.block ? { block: item.block } : {}),
          ...(item.version !== undefined ? { version: item.version } : {}),
          ...(item.params ? { params: item.params } : {}),
          x: 0,
          y: 0,
        },
        loop: node,
      }));
  });
}

/** La clé que lit (ou produit) une instance pour une clé de son contrat : la correspondance `MAP`, sinon la clé. */
function scenarioKey(node: JourneyNode, key: string): string {
  const param = node.params?.[key];
  if (param?.mode === 'MAP') return param.key;
  if (param?.mode === 'VALUE') return instanceKey(key, node.id);
  return key;
}

function endpoint(
  placed: Placed,
  info: BlockInfo | undefined,
  field: ContractField | undefined,
  key: string,
): TraceEndpoint {
  const node = placed.node;
  return {
    node: node.id,
    block: node.block ?? '?',
    ...(node.version !== undefined ? { version: node.version } : {}),
    ...(info && node.version !== undefined && info.view.version !== node.version
      ? { libraryVersion: info.view.version }
      : {}),
    steps: field?.steps ?? [],
    ...(field && field.key !== key ? { contractKey: field.key } : {}),
    ...(placed.loop ? { loop: placed.loop.id } : {}),
  };
}

/** Les exécutions réelles d'un parcours : ses scénarios créés, ou ses exécutions de simulation. */
async function runsOf(
  projectId: string,
  reportsDir: string,
  journey: string,
  published: readonly string[],
): Promise<TraceRun[]> {
  const records = await listExecutions(projectId, reportsDir);
  return records
    .filter(
      (record) =>
        record.kind === 'REPLAY' &&
        (record.simulation?.journey === journey ||
          (record.scenarios ?? []).some((scenario) => published.includes(scenario))),
    )
    .map((record) => ({
      run: record.run,
      createdAt: record.createdAt,
      verdict: record.verdict,
      ...(record.simulation ? { simulation: true } : {}),
      scenarios: record.scenarios ?? [],
    }));
}

export async function journeyTraceability(
  projectDir: string,
  input: { projectId: string; reportsDir: string; journey: unknown; run?: string },
): Promise<JourneyTraceability> {
  const journey = sanitizeJourney(input.journey);
  const graph = journey.graph;
  const check = await checkJourney(projectDir, journey);
  const { entries } = await flowEntries(projectDir);
  const blocks = await blocksOf(entries, await readRegistry(projectDir));
  const notes: string[] = [];

  // ── 1. Définitions : producteurs et consommateurs, d'après les contrats ─────────────────────────────
  const variables = new Map<string, TraceVariable>();
  const variable = (key: string, field: ContractField | undefined, origin: string): TraceVariable => {
    const known = variables.get(key);
    if (known) {
      // Une variable d'itération est produite par sa boucle, même si un bloc du corps l'a déclarée en entrée.
      if (origin === 'ITERATION' && known.origin === 'INPUT') known.origin = 'ITERATION';
      // La définition du producteur l'emporte sur celle d'un consommateur.
      if (field && field.direction === 'output' && known.origin === 'INPUT') {
        Object.assign(known, {
          ...(field.label ? { label: field.label } : {}),
          ...(field.meaning ? { meaning: field.meaning } : {}),
          type: field.type,
          typeSource: field.typeSource,
          version: field.version,
          origin,
        });
      }
      return known;
    }
    const created: TraceVariable = {
      key,
      ...(field?.label ? { label: field.label } : {}),
      type: field?.type ?? 'text',
      ...(field ? { typeSource: field.typeSource } : {}),
      ...(field?.meaning ? { meaning: field.meaning } : {}),
      version: field?.version ?? 1,
      origin,
      sensitive: SENSITIVE.test(key) || SECRET_KEY_PATTERN.test(key),
      producers: [],
      consumers: [],
      status: 'NO_EXECUTION',
      justification: [],
      problems: [],
    };
    variables.set(key, created);
    return created;
  };
  const placed = placedBlocks(graph);
  for (const item of placed) {
    const info = item.node.block ? blocks.get(item.node.block) : undefined;
    if (!info) continue;
    const fields = info.view.contract.fields;
    for (const output of info.view.contract.outputs) {
      const field = fields?.outputs.find((candidate) => candidate.key === output.key);
      const key = scenarioKey(item.node, output.key);
      const target = variable(key, field, field?.origin ?? (output.dynamic ? 'GENERATED' : 'DATA'));
      target.producers.push(endpoint(item, info, field, key));
    }
    for (const input of info.view.contract.inputs) {
      const field = fields?.inputs.find((candidate) => candidate.key === input.key);
      const key = scenarioKey(item.node, input.key);
      const param = item.node.params?.[input.key];
      const target = variable(key, field, param?.mode === 'VALUE' ? 'VALUE' : 'INPUT');
      target.consumers.push(endpoint(item, info, field, key));
    }
    // Une sortie déclarée qu'aucune étape ne produit : rien à tracer, on le dit.
    for (const problem of info.view.problems)
      if (problem.startsWith('declares the output ')) {
        const key = problem.slice('declares the output '.length).split(' ')[0] ?? '';
        const target = variables.get(scenarioKey(item.node, key));
        if (target) {
          target.status = 'UNSUPPORTED';
          target.problems.push(
            `« ${item.node.block ?? '?'} » déclare ${key} mais aucune étape ne la produit`,
          );
        }
      }
  }
  // Les variables d'itération : produites par la boucle elle-même.
  for (const node of graph.nodes)
    if (node.kind === 'LOOP' && node.loop)
      for (const key of loopVariableKeys(node.loop).keys) {
        const target = variable(key, undefined, 'ITERATION');
        target.producers.push({ node: node.id, block: node.label ?? loopSummary(node.loop), steps: [] });
      }

  // ── 2. Correspondances configurées, suggérées, manquantes ────────────────────────────────────────────
  const correspondences: TraceCorrespondence[] = [];
  for (const item of placed) {
    const diag = check.nodes[item.node.id];
    if (!diag) continue;
    for (const satisfied of diag.satisfied) {
      const contractKey =
        Object.entries(item.node.params ?? {}).find(
          ([, param]) => param.mode === 'MAP' && param.key === satisfied.key,
        )?.[0] ?? satisfied.key;
      const loop = graph.nodes.find((node) => node.id === satisfied.from && node.kind === 'LOOP');
      correspondences.push({
        ...(satisfied.from === 'data' || satisfied.from === 'scenario' ? {} : { from: satisfied.from }),
        fromKey: satisfied.key,
        to: item.node.id,
        toKey: contractKey,
        kind: loop
          ? 'LOOP'
          : satisfied.from === 'data' || satisfied.from === 'scenario'
            ? 'DATA'
            : contractKey !== satisfied.key
              ? 'EXPLICIT'
              : 'AUTOMATIC',
      });
    }
    for (const missing of diag.missing) {
      if (
        correspondences.some(
          (entry) => entry.to === item.node.id && entry.toKey === missing.key && entry.kind === 'MISSING',
        )
      )
        continue;
      correspondences.push({ to: item.node.id, toKey: missing.key, kind: 'MISSING', path: missing.path });
      const target = variables.get(missing.key);
      if (target) {
        target.status = 'MISSING';
        target.problems.push(
          `aucun producteur avant « ${item.node.block ?? '?'} » sur le chemin ${String(missing.path)}`,
        );
      }
    }
    for (const proposal of diag.proposals ?? [])
      for (const candidate of proposal.candidates.filter((entry) => entry.compatible))
        correspondences.push({
          from: candidate.from,
          fromKey: candidate.key,
          to: item.node.id,
          toKey: proposal.input,
          kind: 'SUGGESTED',
          reason: candidate.reason,
        });
    // Une version retenue plus ancienne que celle de la bibliothèque : la définition peut avoir changé.
    const info = item.node.block ? blocks.get(item.node.block) : undefined;
    if (info && item.node.version !== undefined && info.view.version !== item.node.version)
      for (const target of variables.values())
        if ([...target.producers, ...target.consumers].some((entry) => entry.node === item.node.id))
          target.problems.push(
            `« ${item.node.block ?? '?'} » est retenu en version ${String(item.node.version)}, la bibliothèque est en version ${String(info.view.version)}`,
          );
  }
  for (const path of check.paths)
    for (const conflict of path.check.conflicts) {
      const target = variables.get(conflict.key);
      const text = `collision : ${conflict.detail}`;
      if (target && !target.problems.includes(text)) target.problems.push(text);
    }

  // ── 3. Le flux d'exécution (bandeau) : le premier chemin, dans l'ordre ───────────────────────────────
  const firstPath = check.paths[0]?.nodes ?? graph.nodes.map((node) => node.id);
  const flowNodes: TraceFlowNode[] = [];
  for (const id of firstPath) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    const contractOf = (entry: JourneyNode): { inputs: string[]; outputs: string[] } => {
      const info = entry.block ? blocks.get(entry.block) : undefined;
      return {
        inputs: (info?.view.contract.inputs ?? []).map((input) => scenarioKey(entry, input.key)),
        outputs: (info?.view.contract.outputs ?? []).map((output) => scenarioKey(entry, output.key)),
      };
    };
    if (node.kind === 'LOOP' && node.loop) {
      flowNodes.push({
        id: node.id,
        kind: 'LOOP',
        label: node.label ?? loopSummary(node.loop),
        inputs: node.loop.itemsFrom ? [node.loop.itemsFrom] : [],
        outputs: loopVariableKeys(node.loop).keys,
      });
      for (const item of placed.filter((entry) => entry.loop?.id === node.id))
        flowNodes.push({
          id: item.node.id,
          kind: 'BLOCK',
          label: item.node.block ?? '?',
          ...(item.node.version !== undefined ? { version: item.node.version } : {}),
          ...contractOf(item.node),
          loop: node.id,
        });
      continue;
    }
    flowNodes.push({
      id: node.id,
      kind: node.kind,
      label:
        node.kind === 'BLOCK'
          ? (node.block ?? '?')
          : node.kind === 'WAIT' && node.wait
            ? (node.label ?? waitSummary(node.wait))
            : (node.label ?? node.kind),
      ...(node.version !== undefined ? { version: node.version } : {}),
      ...(node.kind === 'BLOCK' ? contractOf(node) : { inputs: [], outputs: [] }),
    });
  }
  const flowEdges = graph.edges.map((edge) => ({ from: edge.from, to: edge.to }));
  // Les liens de DONNÉES (distincts des liens de contrôle) : producteur → consommateur.
  const dataLinks = new Map<string, string[]>();
  for (const entry of correspondences)
    if (entry.from && entry.kind !== 'SUGGESTED' && entry.kind !== 'MISSING' && entry.kind !== 'LOOP') {
      const link = `${entry.from}>${entry.to}`;
      dataLinks.set(link, [...(dataLinks.get(link) ?? []), entry.fromKey ?? entry.toKey]);
    }
  const edges = [
    ...flowEdges,
    ...[...dataLinks.entries()].map(([link, keys]) => {
      const [from = '', to = ''] = link.split('>');
      return { from, to, data: [...new Set(keys)] };
    }),
  ];

  // ── 4. Les traces observées d'une exécution réelle ──────────────────────────────────────────────────
  const saved = await getJourney(projectDir, journey.name).catch(() => undefined);
  const runs = await runsOf(input.projectId, input.reportsDir, journey.name, saved?.published ?? []);
  const chosen = input.run ? runs.find((entry) => entry.run === input.run) : runs[0];
  if (input.run && !chosen) notes.push(`l’exécution ${input.run} n’appartient pas à ce parcours`);
  let detail: ExecutionDetail | undefined;
  if (chosen) detail = await executionDetail(input.projectId, input.reportsDir, chosen.run);
  const byBlock = new Map<string, string[]>();
  for (const item of placed)
    if (item.node.block)
      byBlock.set(item.node.block, [...(byBlock.get(item.node.block) ?? []), item.node.id]);
  for (const [block, ids] of byBlock)
    if (ids.length > 1)
      notes.push(
        `« ${block} » apparaît ${String(ids.length)} fois : ses événements ne sont pas rattachés à une instance précise`,
      );
  const events: TraceEvent[] = (detail?.flowsDetail ?? []).flatMap((flow) =>
    (flow.dataTrace ?? []).map((entry): TraceEvent => {
      const ids = entry.block ? (byBlock.get(entry.block) ?? []) : [];
      return { ...entry, flow: flow.name, ...(ids.length === 1 && ids[0] ? { node: ids[0] } : {}) };
    }),
  );
  const state: JourneyTraceability['state'] = !chosen
    ? 'NO_EXECUTION'
    : events.length === 0
      ? 'NO_TRACES'
      : 'OK';

  // ── 5. Statut observé de chaque donnée, avec sa justification ──────────────────────────────────────
  for (const event of events)
    if (!variables.has(event.key))
      variable(event.key, undefined, event.origin === 'ITERATION' ? 'ITERATION' : 'UNKNOWN');
  for (const target of variables.values()) {
    const own = events.filter((event) => event.key === target.key);
    const productions = own.filter((event) => PRODUCTIONS.has(event.origin));
    const uses = own.filter((event) => event.origin === 'USED');
    if (own.length > 0) {
      const occurrences = new Map<
        string,
        { valueId: string; value?: string; masked?: boolean; withheld?: boolean }
      >();
      for (const event of own)
        if (event.valueId && !occurrences.has(event.valueId))
          occurrences.set(event.valueId, {
            valueId: event.valueId,
            ...(event.value !== undefined ? { value: event.value } : {}),
            ...(event.masked ? { masked: true } : {}),
            ...(event.withheld ? { withheld: true } : {}),
          });
      for (const event of uses.filter((entry) => entry.fixed && !entry.valueId)) {
        const id = `${target.key}@fixed`;
        if (!occurrences.has(id))
          occurrences.set(id, {
            valueId: id,
            ...(event.value !== undefined ? { value: event.value } : {}),
            ...(event.masked ? { masked: true } : {}),
            ...(event.withheld ? { withheld: true } : {}),
          });
      }
      target.observed = {
        occurrences: [...occurrences.values()],
        productions: productions.length,
        uses: uses.length,
        ...(own[0] ? { firstAt: own[0].at } : {}),
        ...(own.at(-1) ? { lastAt: own.at(-1)?.at } : {}),
      };
    }
    if (target.status === 'UNSUPPORTED') {
      target.justification.push(
        'aucune étape exécutable ne produit cette donnée : le moteur ne peut pas la tracer',
      );
      continue;
    }
    if (target.status === 'MISSING') {
      target.justification.push(
        ...target.problems.filter((problem) => problem.startsWith('aucun producteur')),
      );
      continue;
    }
    if (!chosen) {
      target.status = 'NO_EXECUTION';
      target.justification.push(
        'aucune exécution réelle de ce parcours : seules les définitions sont connues',
      );
      continue;
    }
    const linked = uses.filter(
      (use) => use.source && productions.some((production) => production.id === use.source),
    );
    if (productions.length > 0 && linked.length > 0) {
      target.status = 'CONFIRMED';
      const blocksUsing = [...new Set(linked.map((use) => use.block ?? use.flow))];
      target.justification.push(
        `produite ${String(productions.length)} fois et utilisée ${String(linked.length)} fois avec la même occurrence de valeur (${blocksUsing.join(', ')}) dans l’exécution ${chosen.run}`,
      );
    } else if (productions.length > 0) {
      target.status = 'PRODUCED_ONLY';
      target.justification.push(`produite dans l’exécution ${chosen.run}, aucune utilisation observée`);
    } else if (uses.some((use) => use.fixed)) {
      target.status = 'STATIC';
      target.justification.push(
        'valeur fixe du jeu de données : utilisée, jamais produite pendant l’exécution',
      );
    } else if (uses.length > 0) {
      target.status = 'NOT_OBSERVED';
      target.justification.push('utilisée sans événement de production observé dans cette exécution');
    } else {
      target.status = 'NOT_OBSERVED';
      target.justification.push(`aucun événement pour cette donnée dans l’exécution ${chosen.run}`);
    }
  }
  return {
    journey: journey.name,
    flow: { nodes: flowNodes, edges },
    variables: [...variables.values()].sort((a, b) => a.key.localeCompare(b.key)),
    correspondences,
    runs,
    ...(chosen ? { run: chosen } : {}),
    events,
    state,
    notes,
  };
}
