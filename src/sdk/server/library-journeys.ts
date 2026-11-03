import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestDataSet } from '../../data/test-data-set.js';
import type { CompositionCheck } from '../core/contracts.js';
import {
  compileJourneyPath,
  freeId,
  instanceKey,
  instanceOutputs,
  JOURNEY_LIMITS,
  JOURNEY_MODES,
  JOURNEY_NODE_KINDS,
  journeyOutputs,
  journeyPaths,
  journeyRevision,
  journeyStructure,
  linearOrder,
  pathLetter,
  pathScenarioName,
  type Journey,
  type JourneyCheck,
  type JourneyEdge,
  type JourneyGraph,
  type JourneyNode,
  type JourneyNodeDiagnostics,
  type JourneyParam,
  type JourneySummary,
} from '../core/journey.js';
import {
  blocksOf,
  commitFiles,
  flowEntries,
  flowFiles,
  freeName,
  LibraryError,
  newBlock,
  partsOf,
  readRegistry,
  refsOf,
  registryFile,
  withLock,
  withTakenOver,
} from './library.js';
import { checkComposition, mergeData, type CompositionPart } from './library-contract.js';
import { validateBlockFlow } from './library-extract.js';
import type { LibraryBlockView } from '../core/contracts.js';

/**
 * LES PARCOURS VISUELS DE LA BIBLIOTHÈQUE (modèle : src/sdk/core/journey.ts). Un parcours s'enregistre tel
 * quel (nœuds, connexions, positions, paramètres des instances, mode préféré) dans `<projet>/sdk-journeys.json`,
 * sans rien produire d'exécutable. « Vérifier » analyse la structure puis CHAQUE CHEMIN avec la vérification
 * de composition existante (ordre, entrées, conflits de données) : une donnée produite dans une branche n'est
 * disponible que sur les chemins qui passent par cette branche. « Créer » écrit des scénarios ordinaires
 * (`run:` + `with:`), suivis par le registre de la bibliothèque comme les parcours composés : un seul pour un
 * parcours linéaire, un par chemin seulement sur demande explicite pour un parcours avec conditions. Une
 * version de bloc plus récente que celle retenue par un nœud doit être acceptée explicitement.
 */

const JOURNEYS_FILE = 'sdk-journeys.json';
const TEXT_MAX = 120;

interface JourneyStore {
  version: 1;
  journeys: Record<string, Journey>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function readStore(projectDir: string): Promise<JourneyStore> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDir, JOURNEYS_FILE), 'utf8')) as unknown;
    if (isObject(parsed) && isObject(parsed.journeys))
      return { version: 1, journeys: parsed.journeys as Record<string, Journey> };
  } catch {
    // Pas encore de parcours (ou fichier illisible) : une liste vide, jamais une erreur.
  }
  return { version: 1, journeys: {} };
}

const storeFile = (projectDir: string, store: JourneyStore): { file: string; content: string } => ({
  file: path.join(projectDir, JOURNEYS_FILE),
  content: `${JSON.stringify(store, null, 2)}\n`,
});

const text = (value: unknown, max = TEXT_MAX): string | undefined =>
  typeof value === 'string' && value.trim() !== ''
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : undefined;
const coordinate = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-20000, Math.min(20000, Math.round(value)))
    : 0;

/** Un parcours reçu du Dashboard, contrôlé champ par champ (rien d'inconnu n'est gardé). */
export function sanitizeJourney(raw: unknown): Journey {
  if (!isObject(raw) || !isObject(raw.graph)) throw new LibraryError('a journey has a name and a graph', 400);
  const name = text(raw.name, 80);
  if (!name) throw new LibraryError('a name of 1 to 80 characters is required', 400);
  const nodesRaw = Array.isArray(raw.graph.nodes) ? raw.graph.nodes : [];
  const edgesRaw = Array.isArray(raw.graph.edges) ? raw.graph.edges : [];
  if (nodesRaw.length > JOURNEY_LIMITS.nodes || edgesRaw.length > JOURNEY_LIMITS.edges)
    throw new LibraryError(
      `${String(JOURNEY_LIMITS.nodes)} nodes and ${String(JOURNEY_LIMITS.edges)} connections at most`,
      400,
    );
  const nodes: JourneyNode[] = nodesRaw.filter(isObject).map((node) => {
    const id = text(node.id, 40);
    const kind = JOURNEY_NODE_KINDS.find((candidate) => candidate === node.kind);
    if (!id || !kind) throw new LibraryError('every node has an id and a kind', 400);
    const params: Record<string, JourneyParam> = {};
    if (isObject(node.params))
      for (const [key, param] of Object.entries(node.params).slice(0, 40)) {
        if (!isObject(param) || key.length > TEXT_MAX) continue;
        if (param.mode === 'VALUE' && typeof param.value === 'string')
          params[key] = { mode: 'VALUE', value: param.value.slice(0, 500) };
        else if (param.mode === 'MAP' && typeof param.key === 'string')
          params[key] = { mode: 'MAP', key: param.key.trim().slice(0, TEXT_MAX) };
      }
    const block = kind === 'BLOCK' ? text(node.block) : undefined;
    const label = text(node.label);
    return {
      id,
      kind,
      ...(block ? { block } : {}),
      ...(kind === 'BLOCK' && typeof node.version === 'number' && Number.isInteger(node.version)
        ? { version: node.version }
        : {}),
      ...(label ? { label } : {}),
      x: coordinate(node.x),
      y: coordinate(node.y),
      ...(kind === 'BLOCK' && Object.keys(params).length > 0 ? { params } : {}),
    };
  });
  const edges: JourneyEdge[] = edgesRaw.filter(isObject).map((edge) => {
    const id = text(edge.id, 40);
    const from = text(edge.from, 40);
    const to = text(edge.to, 40);
    if (!id || !from || !to) throw new LibraryError('every connection has an id, a from and a to', 400);
    return {
      id,
      from,
      to,
      ...(edge.branch === 'YES' || edge.branch === 'NO' ? { branch: edge.branch } : {}),
    };
  });
  const description = text(raw.description, 500);
  return {
    name,
    ...(description ? { description } : {}),
    mode: JOURNEY_MODES.find((mode) => mode === raw.mode) ?? 'LINEAR',
    graph: { nodes, edges },
  };
}

const summaryOf = (journey: Journey): JourneySummary => ({
  name: journey.name,
  ...(journey.description ? { description: journey.description } : {}),
  mode: journey.mode,
  blocks: journey.graph.nodes.filter((node) => node.kind === 'BLOCK').length,
  conditions: journey.graph.nodes.filter((node) => node.kind === 'CONDITION').length,
  ...(journey.updatedAt ? { updatedAt: journey.updatedAt } : {}),
  published: journey.published ?? [],
});

export async function listJourneys(projectDir: string): Promise<JourneySummary[]> {
  const store = await readStore(projectDir);
  return Object.values(store.journeys)
    .map(summaryOf)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name));
}

export async function getJourney(projectDir: string, name: string): Promise<Journey> {
  const journey = (await readStore(projectDir)).journeys[name];
  if (!journey) throw new LibraryError(`no journey named "${name}"`, 404);
  return journey;
}

/**
 * ENREGISTRER un parcours (brouillon : rien d'exécutable n'est écrit). Sur une révision périmée, refusé (409) :
 * rien n'est écrasé. `previous` : son ancien nom quand il est renommé ; un autre parcours de ce nom est refusé.
 */
export function saveJourney(
  projectDir: string,
  raw: unknown,
  options: { revision?: string; previous?: string } = {},
): Promise<Journey> {
  return withLock(projectDir, async () => {
    const journey = sanitizeJourney(raw);
    const store = await readStore(projectDir);
    const previousName = options.previous ?? journey.name;
    const current = store.journeys[previousName];
    if (current && options.revision !== undefined && current.revision !== options.revision)
      throw new LibraryError('the journey changed since it was opened: reload it first', 409);
    if (!current && options.previous !== undefined)
      throw new LibraryError(`no journey named "${options.previous}"`, 404);
    if (journey.name !== previousName && store.journeys[journey.name])
      throw new LibraryError(`a journey is already named "${journey.name}"`, 409);
    const saved: Journey = {
      ...journey,
      revision: journeyRevision(journey),
      updatedAt: new Date().toISOString(),
      ...(current?.published ? { published: current.published } : {}),
    };
    // Renommé : l'ancien nom disparaît, le nouveau prend sa place (aucun autre parcours n'est touché).
    const journeys = Object.fromEntries(
      Object.entries(store.journeys).filter(([key]) => key !== previousName),
    );
    journeys[journey.name] = saved;
    await commitFiles([storeFile(projectDir, { version: 1, journeys })]);
    return saved;
  });
}

/** Retire un parcours enregistré ; les scénarios déjà créés restent (ce sont des scénarios ordinaires). */
export function removeJourney(projectDir: string, name: string): Promise<void> {
  return withLock(projectDir, async () => {
    const store = await readStore(projectDir);
    if (!store.journeys[name]) throw new LibraryError(`no journey named "${name}"`, 404);
    const journeys = Object.fromEntries(Object.entries(store.journeys).filter(([key]) => key !== name));
    await commitFiles([storeFile(projectDir, { version: 1, journeys })]);
  });
}

/** Les parts d'un chemin pour la vérification de composition, avec les paramètres de chaque instance. */
function pathParts(blockNodes: readonly JourneyNode[], base: CompositionPart[]): CompositionPart[] {
  return base.map((part, index) => {
    const node = blockNodes[index];
    const params = node?.params ?? {};
    if (!node || !part.block || Object.keys(params).length === 0) return part;
    const values: TestDataSet['values'] = { ...(part.block.data?.values ?? {}) };
    const inputs = part.block.contract.inputs.map((input) => {
      const param = params[input.key];
      if (!param) return input;
      if (param.mode === 'MAP') return { ...input, key: param.key };
      const key = instanceKey(input.key, node.id);
      values[key] = { key, strategy: 'BUSINESS_LITERAL', value: param.value, sensitive: false };
      return { ...input, key };
    });
    const data: TestDataSet = {
      id: part.block.data?.id ?? `journey-${node.id}`,
      name: part.block.data?.name ?? part.name,
      source: part.block.data?.source ?? 'MANUAL',
      values,
    };
    return { ...part, block: { ...part.block, contract: { ...part.block.contract, inputs }, data } };
  });
}

const blockNodesOf = (graph: JourneyGraph, nodes: readonly string[]): JourneyNode[] =>
  nodes
    .map((id) => graph.nodes.find((node) => node.id === id))
    .filter((node): node is JourneyNode => node?.kind === 'BLOCK');

/** VÉRIFIER un parcours : structure, versions, puis chaque chemin (rien n'est écrit ni exécuté). */
export async function checkJourney(projectDir: string, raw: unknown): Promise<JourneyCheck> {
  const journey = sanitizeJourney(raw);
  const graph = journey.graph;
  const structure = journeyStructure(graph);
  const linear = linearOrder(graph);
  const { entries } = await flowEntries(projectDir);
  const blocks = await blocksOf(entries, await readRegistry(projectDir));
  const errors = [...structure.errors];
  const warnings = [...structure.warnings];
  const nodes: Record<string, JourneyNodeDiagnostics> = {};
  for (const node of graph.nodes) {
    const info = node.block ? blocks.get(node.block) : undefined;
    const diag: JourneyNodeDiagnostics = {
      errors: [...(structure.nodes[node.id] ?? [])],
      warnings: [],
      available: [],
      missing: [],
      produces: info ? info.view.contract.outputs.map((output) => output.key) : [],
      satisfied: [],
    };
    if (node.kind === 'BLOCK' && node.block) {
      if (!info) diag.errors.push(`aucun bloc « ${node.block} » dans la bibliothèque`);
      else {
        if (node.version !== undefined && node.version !== info.view.version)
          diag.errors.push(
            `version ${String(node.version)} retenue, version ${String(info.view.version)} disponible : acceptez-la explicitement`,
          );
        if (info.view.state === 'INVALID')
          diag.errors.push(`le contrat du bloc ne tient pas (${info.view.problems.join(' ; ')})`);
        if (info.view.state === 'CHANGED')
          diag.warnings.push('le contenu du bloc a changé depuis sa dernière version validée');
        const known = new Set(info.view.contract.inputs.map((input) => input.key));
        for (const key of Object.keys(node.params ?? {}))
          if (!known.has(key))
            diag.warnings.push(`le paramètre ${key} ne correspond plus à une entrée du contrat`);
      }
    }
    nodes[node.id] = diag;
  }
  const found = journeyPaths(graph);
  if (found.length > JOURNEY_LIMITS.paths)
    errors.push(`plus de ${String(JOURNEY_LIMITS.paths)} chemins : simplifiez les conditions`);
  const cyclic = Object.values(structure.edges).some((list) =>
    list.some((item) => item.startsWith('boucle')),
  );
  const paths: JourneyCheck['paths'] = [];
  const availableBy = new Map<string, Set<string>[]>();
  const outputsByPath: string[][] = [];
  if (!cyclic)
    for (const [index, found1] of found.slice(0, JOURNEY_LIMITS.paths).entries()) {
      const blockNodes = blockNodesOf(graph, found1.nodes);
      if (blockNodes.length > JOURNEY_LIMITS.blocksPerPath)
        errors.push(`chemin ${pathLetter(index)} : ${String(JOURNEY_LIMITS.blocksPerPath)} blocs au plus`);
      const names = blockNodes.map((node) => node.block ?? '');
      const parts = pathParts(blockNodes, partsOf(names, blocks, entries));
      const check: CompositionCheck =
        blockNodes.length === 0
          ? {
              ok: false,
              name: journey.name,
              blocks: 0,
              steps: 0,
              order: [],
              dependencies: [],
              missing: [],
              conflicts: [],
              shared: [],
              dynamic: [],
              errors: ['ce chemin ne rejoue aucun bloc'],
              warnings: [],
            }
          : checkComposition({ name: journey.name, parts, taken: [], nameRequired: false });
      paths.push({ index, nodes: found1.nodes, choices: found1.choices, check });
      if (blockNodes.length === 0) errors.push(`chemin ${pathLetter(index)} : aucun bloc n’est rejoué`);
      const label = found.length > 1 ? ` (chemin ${pathLetter(index)})` : '';
      // Les données disponibles avant chaque bloc sur CE chemin : sorties des blocs précédents, données
      // définies par les blocs du chemin, valeurs des instances.
      const dataKeys = new Set(parts.flatMap((part) => Object.keys(part.block?.data?.values ?? {})));
      const produced = new Set<string>();
      for (const [at, node] of blockNodes.entries()) {
        const diag = nodes[node.id] as JourneyNodeDiagnostics;
        const before = new Set([...dataKeys, ...produced]);
        availableBy.set(node.id, [...(availableBy.get(node.id) ?? []), before]);
        const entry = check.order[at];
        for (const key of entry?.missing ?? []) {
          diag.missing.push({ key, path: index + 1 });
          diag.errors.push(`entrée ${key} manquante${label}`);
        }
        if (index === 0 || diag.satisfied.length === 0)
          diag.satisfied = (entry?.satisfied ?? []).map((item) => ({
            key: item.key,
            from:
              typeof item.from === 'number'
                ? (blockNodes[item.from - 1]?.id ?? 'data')
                : item.from === 'data'
                  ? 'data'
                  : 'scenario',
          }));
        for (const output of parts[at]?.block?.contract.outputs ?? []) produced.add(output.key);
      }
      outputsByPath.push(
        blockNodes.flatMap((node, at) =>
          instanceOutputs(
            node,
            (parts[at]?.block?.contract.outputs ?? []).map((output) => output.key),
          ),
        ),
      );
      for (const conflict of check.conflicts) {
        errors.push(`données en conflit${label} : ${conflict.detail}`);
        for (const node of blockNodes)
          if (node.block && conflict.blocks.includes(node.block))
            (nodes[node.id] as JourneyNodeDiagnostics).errors.push(
              `la donnée ${conflict.key} est définie autrement ailleurs${label}`,
            );
      }
      for (const warning of check.warnings)
        if (!warnings.includes(warning)) warnings.push(`${warning}${label}`);
    }
  // Les clés propres aux instances (`clé__nœud`) sont un détail de compilation : jamais montrées.
  const instanceKeys = new Set(
    graph.nodes.flatMap((node) =>
      Object.entries(node.params ?? {})
        .filter(([, param]) => param.mode === 'VALUE')
        .map(([key]) => instanceKey(key, node.id)),
    ),
  );
  for (const [id, sets] of availableBy) {
    const [first, ...rest] = sets;
    (nodes[id] as JourneyNodeDiagnostics).available = first
      ? [...first].filter((key) => !instanceKeys.has(key) && rest.every((set) => set.has(key))).sort()
      : [];
  }
  for (const diag of Object.values(nodes))
    diag.satisfied = diag.satisfied.filter((item) => !instanceKeys.has(item.key));
  for (const diag of Object.values(nodes)) {
    diag.errors = [...new Set(diag.errors)];
    diag.warnings = [...new Set(diag.warnings)];
  }
  const ok =
    errors.length === 0 &&
    Object.values(nodes).every((diag) => diag.errors.length === 0) &&
    Object.keys(structure.edges).length === 0 &&
    paths.length > 0;
  return {
    ok,
    linear: linear.ok,
    ...(linear.ok ? {} : { linearReason: linear.reason }),
    publishable: ok ? (linear.ok ? 'SINGLE' : 'PER_PATH') : 'NONE',
    paths,
    nodes,
    edges: structure.edges,
    errors,
    warnings,
    outputs: journeyOutputs(outputsByPath),
  };
}

/**
 * CRÉER le(s) scénario(s) d'un parcours enregistré, tous ensemble ou aucun. Un parcours linéaire donne un
 * scénario ; un parcours avec conditions n'en donne qu'avec `perPath` (un scénario par chemin, nommé
 * « <nom> · chemin N »), jamais en aplatissant ses branches. Un nom déjà pris est refusé (409) : rien
 * n'est écrasé.
 */
export function publishJourney(
  projectDir: string,
  name: string,
  options: { perPath?: boolean } = {},
): Promise<{ scenarios: string[] }> {
  return withLock(projectDir, async () => {
    const store = await readStore(projectDir);
    const journey = store.journeys[name];
    if (!journey) throw new LibraryError(`no journey named "${name}"`, 404);
    const check = await checkJourney(projectDir, journey);
    if (!check.ok) {
      const details = [
        ...check.errors,
        ...Object.entries(check.nodes).flatMap(([id, diag]) =>
          diag.errors.map((error) => `${id} : ${error}`),
        ),
        ...Object.entries(check.edges).flatMap(([id, list]) => list.map((error) => `${id} : ${error}`)),
      ];
      throw new LibraryError(details[0] ?? 'the journey does not hold', 422, details);
    }
    if (!check.linear && options.perPath !== true)
      throw new LibraryError(
        `this journey has conditions (${check.linearReason ?? ''}): the engine does not evaluate them; create one scenario per path explicitly`,
        422,
      );
    const { root, entries } = await flowEntries(projectDir);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const next = withTakenOver(registry, blocks);
    const files: { file: string; content: string }[] = [];
    const scenarios: string[] = [];
    const taken = [...entries];
    for (const path1 of check.paths) {
      const scenario = check.linear ? journey.name : pathScenarioName(journey.name, path1.index);
      freeName(taken, scenario);
      if (scenarios.includes(scenario)) throw new LibraryError(`two paths would be named "${scenario}"`, 409);
      // Les valeurs des instances sont déjà dans le jeu fusionné (pathParts) : seules les étapes servent ici.
      const { steps } = compileJourneyPath(journey.graph, path1.nodes);
      const blockNodes = blockNodesOf(journey.graph, path1.nodes);
      const names = blockNodes.map((node) => node.block ?? '');
      const parts = pathParts(blockNodes, partsOf(names, blocks, entries));
      const merged = mergeData(
        parts.map((part) => ({ from: part.name, data: part.block?.data })),
        scenario,
      ).merged;
      const choice = path1.choices.map((item) => `${item.label} = ${item.branch === 'YES' ? 'Oui' : 'Non'}`);
      const description = [
        journey.description,
        `Parcours visuel « ${journey.name} »${choice.length > 0 ? ` — chemin : ${choice.join(', ')}` : ''}`,
      ]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 500);
      const first = entries.find((entry) => entry.name === names[0]);
      const startAt = typeof first?.flow.startAt === 'string' ? first.flow.startAt : undefined;
      const written = await flowFiles(
        root,
        'composed',
        { name: scenario, description, ...(startAt ? { startAt } : {}), steps },
        merged,
      );
      files.push(...written.files);
      scenarios.push(scenario);
      next.compositions[scenario] = { at: new Date().toISOString(), blocks: refsOf(names, blocks) };
    }
    const journeys = {
      ...store.journeys,
      [journey.name]: { ...journey, published: [...new Set([...(journey.published ?? []), ...scenarios])] },
    };
    await commitFiles([
      ...files,
      registryFile(projectDir, next),
      storeFile(projectDir, { version: 1, journeys }),
    ]);
    return { scenarios };
  });
}

/**
 * TRANSFORMER UN PARCOURS EN BLOC : ses étapes (`run:` + `with:`, les blocs rejoués restent liés par leur
 * nom) et son jeu de données fusionné deviennent un bloc de la bibliothèque, réutilisable dans d'autres
 * parcours. Son contrat est déclaré d'emblée : ses sorties sont celles que le parcours produit (vérifiées).
 * Seul un parcours valide et sans condition le peut : ses chemins donneraient des sorties différentes.
 * Un nom déjà pris est refusé (409) ; le parcours et ses scénarios ne changent pas.
 */
export function journeyToBlock(
  projectDir: string,
  name: string,
  input: { block: unknown; description?: unknown },
): Promise<{ block: LibraryBlockView; outputs: string[] }> {
  return withLock(projectDir, async () => {
    const store = await readStore(projectDir);
    const journey = store.journeys[name];
    if (!journey) throw new LibraryError(`no journey named "${name}"`, 404);
    const check = await checkJourney(projectDir, journey);
    if (!check.ok) {
      const details = [
        ...check.errors,
        ...Object.entries(check.nodes).flatMap(([id, diag]) =>
          diag.errors.map((error) => `${id} : ${error}`),
        ),
        ...Object.entries(check.edges).flatMap(([id, list]) => list.map((error) => `${id} : ${error}`)),
      ];
      throw new LibraryError(details[0] ?? 'the journey does not hold', 422, details);
    }
    const only = check.paths[0];
    if (!check.linear || check.paths.length !== 1 || !only)
      throw new LibraryError(
        `this journey has conditions (${check.linearReason ?? ''}): its paths produce different data, it cannot become one block`,
        422,
      );
    const { root, entries } = await flowEntries(projectDir);
    const blockName = freeName(entries, input.block);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const { steps } = compileJourneyPath(journey.graph, only.nodes);
    const blockNodes = blockNodesOf(journey.graph, only.nodes);
    const names = blockNodes.map((node) => node.block ?? '');
    const parts = pathParts(blockNodes, partsOf(names, blocks, entries));
    const merged = mergeData(
      parts.map((part) => ({ from: part.name, data: part.block?.data })),
      blockName,
    ).merged;
    const first = entries.find((entry) => entry.name === names[0]);
    const startAt = typeof first?.flow.startAt === 'string' ? first.flow.startAt : undefined;
    const raw = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim() : '';
    const description = (raw || journey.description || `Parcours visuel « ${journey.name} »`).slice(0, 500);
    const flow = {
      name: blockName,
      description,
      reusable: true,
      ...(startAt ? { startAt } : {}),
      steps,
    };
    const invalid = validateBlockFlow(flow, merged);
    if (invalid.length > 0)
      throw new LibraryError(`the journey is not a valid block: ${invalid[0] ?? ''}`, 422, invalid);
    const outputs = check.outputs.guaranteed.slice(0, 50);
    const block = await newBlock(
      projectDir,
      root,
      flow,
      merged,
      { kind: 'scenario', name: journey.name, journey: journey.name },
      {
        contract: { inputs: [], outputs, preconditions: [], postconditions: [] },
        uses: { at: new Date().toISOString(), blocks: refsOf(names, blocks) },
      },
    );
    return { block, outputs };
  });
}

/** Un identifiant de nœud libre (exposé pour les tests et le Dashboard). */
export const nextNodeId = (graph: JourneyGraph): string =>
  freeId(
    'n',
    graph.nodes.map((node) => node.id),
  );
