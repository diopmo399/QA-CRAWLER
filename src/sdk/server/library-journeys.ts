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
  type MappingCandidate,
  type MappingProposal,
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
  blockNamed,
  readRegistry,
  refsOf,
  registryFile,
  withLock,
  withTakenOver,
  type BlockInfo,
  type BlockRecord,
} from './library.js';
import { checkComposition, mergeData, type CompositionPart } from './library-contract.js';
import { sanitizeWait, waitReferences } from '../core/wait.js';
import {
  isLoopVariable,
  loopSummary,
  loopVariableKeys,
  sanitizeLoop,
  type JourneyLoopSpec,
  type JourneyPreview,
  type PreviewInput,
  type PreviewOutput,
  type PreviewStep,
  type PreviewValueStatus,
} from '../core/journey-loop.js';
import { waitSummary } from '../core/wait.js';
import { testDataSetDocument } from '../../data/test-data-set.js';
import { SECRET_KEY_PATTERN } from '../../config/flow-schema.js';
import { validateBlockFlow } from './library-extract.js';
import type {
  ContractField,
  FieldDeclaration,
  FieldDeclarationResult,
  LibraryBlockView,
} from '../core/contracts.js';
import {
  fieldKey,
  incompatibility,
  sanitizeDeclaration,
  type StoredField,
  type StoredFields,
} from './library-fields.js';

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
      ...(kind === 'WAIT' ? { wait: sanitizeWait(node.wait) } : {}),
      ...(kind === 'LOOP' ? { loop: sanitizeLoop(node.loop) } : {}),
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

/**
 * Les blocs rejoués sur un chemin, dans l'ordre : un nœud BLOCK, ou un bloc du corps d'une boucle (vu comme
 * un nœud BLOCK avec l'identifiant de l'élément, et sa boucle en `owner`).
 */
interface PathUnit {
  node: JourneyNode;
  owner?: JourneyNode & { loop: JourneyLoopSpec };
}

const unitsOf = (graph: JourneyGraph, nodes: readonly string[]): PathUnit[] =>
  nodes.flatMap((id): PathUnit[] => {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node?.kind === 'BLOCK') return [{ node }];
    if (node?.kind !== 'LOOP' || !node.loop) return [];
    const owner = node as JourneyNode & { loop: JourneyLoopSpec };
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
        owner,
      }));
  });

/**
 * Tous les blocs rejoués sur un chemin, corps des boucles compris (leurs jeux de données sont fusionnés et
 * leurs versions suivies comme les autres : rien ne change en silence dans une boucle).
 */
const blockNodesOf = (graph: JourneyGraph, nodes: readonly string[]): JourneyNode[] =>
  unitsOf(graph, nodes).map((unit) => unit.node);

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
  const bodyNodes = graph.nodes.flatMap((node) =>
    node.kind === 'LOOP' && node.loop
      ? node.loop.body
          .filter((item) => item.kind === 'BLOCK')
          .map((item): JourneyNode => ({
            id: item.id,
            kind: 'BLOCK',
            ...(item.block ? { block: item.block } : {}),
            ...(item.version !== undefined ? { version: item.version } : {}),
            ...(item.params ? { params: item.params } : {}),
            x: 0,
            y: 0,
          }))
      : [],
  );
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const item of bodyNodes)
    if (ids.has(item.id)) errors.push(`l’élément de boucle ${item.id} porte l’identifiant d’un nœud`);
    else ids.add(item.id);
  for (const node of [...graph.nodes, ...bodyNodes]) {
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
      const units = unitsOf(graph, found1.nodes);
      const blockNodes = units.map((unit) => unit.node);
      if (blockNodes.length > JOURNEY_LIMITS.blocksPerPath)
        errors.push(`chemin ${pathLetter(index)} : ${String(JOURNEY_LIMITS.blocksPerPath)} blocs au plus`);
      const names = blockNodes.map((node) => node.block ?? '');
      // Dans une boucle, une entrée lue dans une variable d'itération est fournie par la boucle elle-même.
      const fromLoop = new Map<string, string[]>();
      const parts = pathParts(blockNodes, partsOf(names, blocks, entries)).map((part, at) => {
        const owner = units[at]?.owner;
        if (!owner || !part.block) return part;
        const variables = loopVariableKeys(owner.loop);
        const local = (key: string): boolean =>
          variables.keys.includes(key) || (variables.open && isLoopVariable(owner.loop, key));
        const given = part.block.contract.inputs
          .filter((input) => local(input.key))
          .map((input) => input.key);
        if (given.length === 0) return part;
        fromLoop.set(units[at]?.node.id ?? '', given);
        return {
          ...part,
          block: {
            ...part.block,
            contract: {
              ...part.block.contract,
              inputs: part.block.contract.inputs.filter((input) => !local(input.key)),
            },
          },
        };
      });
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
      // Une attente cite des données (${testData:clé}) : elles existent avant elle sur CE chemin, ou c'est une
      // erreur. Une sortie GÉNÉRÉE au rejeu doit être produite avant l'attente : citée plus tôt, elle serait
      // générée à l'attente même, qui attendrait une valeur que l'application n'a pas encore reçue.
      const generated = new Set(
        parts.flatMap((part) =>
          (part.block?.contract.outputs ?? []).filter((output) => output.dynamic).map((output) => output.key),
        ),
      );
      const known = new Set([...dataKeys].filter((key) => !generated.has(key)));
      let blockAt = 0;
      for (const id of found1.nodes) {
        const node = graph.nodes.find((candidate) => candidate.id === id);
        if (node?.kind === 'LOOP' && node.loop) {
          // LA BOUCLE : sa collection existe avant elle ; ses attentes lisent l'amont, les variables
          // d'itération et ce que les blocs précédents du corps ont produit ; rien n'en sort.
          const diag = nodes[node.id] as JourneyNodeDiagnostics;
          const before = new Set(known);
          availableBy.set(node.id, [...(availableBy.get(node.id) ?? []), before]);
          const spec = node.loop;
          if (spec.type === 'FOR_EACH' && spec.itemsFrom !== undefined) {
            if (before.has(spec.itemsFrom)) {
              if (!diag.satisfied.some((item) => item.key === spec.itemsFrom))
                diag.satisfied.push({ key: spec.itemsFrom, from: 'data' });
            } else {
              diag.missing.push({ key: spec.itemsFrom, path: index + 1 });
              diag.errors.push(
                `la collection ${spec.itemsFrom} n’est produite par aucun bloc avant la boucle${label}`,
              );
            }
          }
          const variables = loopVariableKeys(spec);
          const inside = new Set([...before, ...variables.keys]);
          for (const condition of spec.while ? waitReferences(spec.while) : [])
            if (!before.has(condition))
              diag.errors.push(
                `la condition cite ${condition}, produite par aucun bloc avant la boucle${label}`,
              );
          for (const item of spec.body) {
            if (item.kind === 'BLOCK') {
              for (const output of parts[blockAt]?.block?.contract.outputs ?? []) inside.add(output.key);
              blockAt += 1;
              continue;
            }
            for (const key of item.wait ? waitReferences(item.wait) : [])
              if (!inside.has(key) && !(variables.open && isLoopVariable(spec, key)))
                diag.errors.push(
                  `l’attente de la boucle cite ${key}, qui n’existe pas encore à ce moment de l’itération${label}`,
                );
          }
          continue;
        }
        if (node?.kind === 'BLOCK') {
          for (const key of instanceOutputs(
            node,
            (parts[blockAt]?.block?.contract.outputs ?? []).map((output) => output.key),
          ))
            known.add(key);
          for (const output of parts[blockAt]?.block?.contract.outputs ?? []) known.add(output.key);
          blockAt += 1;
        }
        if (node?.kind !== 'WAIT' || !node.wait) continue;
        const diag = nodes[node.id] as JourneyNodeDiagnostics;
        const before = new Set(known);
        availableBy.set(node.id, [...(availableBy.get(node.id) ?? []), before]);
        for (const key of waitReferences(node.wait)) {
          if (before.has(key)) {
            if (!diag.satisfied.some((item) => item.key === key)) {
              const producer = blockNodes.find((candidate, at) =>
                (parts[at]?.block?.contract.outputs ?? []).some((output) => output.key === key),
              );
              diag.satisfied.push({ key, from: producer?.id ?? 'data' });
            }
          } else {
            diag.missing.push({ key, path: index + 1 });
            diag.errors.push(`la donnée ${key} n’est produite par aucun bloc avant cette attente${label}`);
          }
        }
      }
      // Ce que produit le corps d'une boucle n'existe que pendant l'itération : visible des blocs suivants
      // du MÊME corps, jamais après la boucle.
      let iteration = new Set<string>();
      let currentLoop: string | undefined;
      for (const [at, node] of blockNodes.entries()) {
        const diag = nodes[node.id] as JourneyNodeDiagnostics;
        const owner = units[at]?.owner;
        if (owner?.id !== currentLoop) {
          iteration = new Set();
          currentLoop = owner?.id;
        }
        const variables = owner ? loopVariableKeys(owner.loop).keys : [];
        const before = new Set([...dataKeys, ...produced, ...iteration, ...variables]);
        availableBy.set(node.id, [...(availableBy.get(node.id) ?? []), before]);
        const entry = check.order[at];
        for (const key of entry?.missing ?? []) {
          diag.missing.push({ key, path: index + 1 });
          diag.errors.push(`entrée ${key} manquante${label}`);
        }
        for (const item of entry?.satisfied ?? []) {
          if (typeof item.from !== 'number') continue;
          const source = units[item.from - 1]?.owner;
          if (source && source.id !== owner?.id)
            diag.errors.push(
              `la donnée ${item.key} est produite dans la boucle « ${source.label ?? source.id} » : elle n’existe que pendant une itération${label}`,
            );
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
        // Une entrée lue dans une variable d'itération : fournie par la boucle elle-même.
        for (const key of fromLoop.get(node.id) ?? [])
          if (!diag.satisfied.some((item) => item.key === key))
            diag.satisfied.push({ key, from: owner?.id ?? 'loop' });
        for (const output of parts[at]?.block?.contract.outputs ?? [])
          (owner ? iteration : produced).add(output.key);
      }
      outputsByPath.push(
        blockNodes.flatMap((node, at) =>
          units[at]?.owner
            ? []
            : instanceOutputs(
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
    [...graph.nodes, ...bodyNodes].flatMap((node) =>
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
  wireNodes(graph, blocks, nodes, instanceKeys);
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
 * SIMULATION STATIQUE (aperçu) : la vérification du parcours, puis, chemin par chemin, chaque étape avec la
 * provenance de ses entrées et la portée de ses sorties. Rien n'est exécuté, aucune valeur n'est inventée.
 */
export async function previewJourney(projectDir: string, raw: unknown): Promise<JourneyPreview> {
  const journey = sanitizeJourney(raw);
  const graph = journey.graph;
  const check = await checkJourney(projectDir, journey);
  const { entries } = await flowEntries(projectDir);
  const blocks = await blocksOf(entries, await readRegistry(projectDir));
  const known = (
    entry: TestDataSet['values'][string] | undefined,
    key: string,
  ): { status: PreviewValueStatus; value?: string } => {
    if (!entry) return { status: 'MISSING' };
    if (entry.sensitive || entry.strategy === 'CREDENTIAL_REFERENCE' || SECRET_KEY_PATTERN.test(key))
      return { status: 'SECRET' };
    if (
      (entry.strategy === 'BUSINESS_LITERAL' || entry.strategy === 'RECORDED_LITERAL') &&
      entry.value !== undefined
    )
      return { status: 'KNOWN', value: entry.value };
    return { status: 'AT_RUN' };
  };
  const paths: JourneyPreview['paths'] = check.paths.map((path1) => {
    const steps: PreviewStep[] = [];
    // Ce qui est produit avant chaque étape : la clé → son producteur et sa portée.
    const produced = new Map<string, { from: string; origin: string; scope: 'RUN' | 'ITERATION' }>();
    const blockStep = (
      node: JourneyNode,
      depth: number,
      loop: JourneyLoopSpec | undefined,
      local: Map<string, { from: string; origin: string; scope: 'RUN' | 'ITERATION' }>,
    ): PreviewStep => {
      const info = node.block ? blocks.get(node.block) : undefined;
      const data = info?.data?.values ?? {};
      const variables = loop ? loopVariableKeys(loop) : undefined;
      const inputs: PreviewInput[] = (info?.view.contract.inputs ?? []).map((input) => {
        const param = node.params?.[input.key];
        if (param?.mode === 'VALUE')
          return SECRET_KEY_PATTERN.test(input.key)
            ? { key: input.key, source: 'VALUE', status: 'SECRET' }
            : { key: input.key, source: 'VALUE', status: 'KNOWN', value: param.value };
        const reads = param?.mode === 'MAP' ? param.key : input.key;
        if (
          loop &&
          variables &&
          (variables.keys.includes(reads) || (variables.open && isLoopVariable(loop, reads)))
        )
          return {
            key: input.key,
            source: 'LOOP',
            reads,
            status: loop.itemsFrom !== undefined || reads.endsWith('.index') ? 'AT_RUN' : 'KNOWN',
            from: 'loop',
          };
        const producer = local.get(reads) ?? produced.get(reads);
        if (producer)
          return { key: input.key, source: 'UPSTREAM', reads, from: producer.from, status: 'AT_RUN' };
        const own = data[reads];
        if (own) return { key: input.key, source: 'DATA', reads, ...known(own, reads) };
        return { key: input.key, source: 'MISSING', reads, status: 'MISSING' };
      });
      const fields = info?.view.contract.fields?.outputs ?? [];
      const outputs: PreviewOutput[] = (info?.view.contract.outputs ?? []).map((output) => {
        const field = fields.find((candidate) => candidate.key === output.key);
        const origin = field?.origin ?? (output.dynamic ? 'GENERATED' : 'DATA');
        const entry = data[output.key];
        const value =
          output.dynamic || origin === 'CAPTURED' || origin === 'GENERATED'
            ? { status: 'AT_RUN' as const }
            : known(entry, output.key);
        return { key: output.key, origin, scope: loop ? 'ITERATION' : 'RUN', ...value };
      });
      for (const output of outputs)
        (loop ? local : produced).set(output.key, {
          from: node.id,
          origin: output.origin,
          scope: output.scope,
        });
      return {
        node: node.id,
        kind: 'BLOCK',
        label: node.block ?? '?',
        depth,
        ...(node.version !== undefined ? { version: node.version } : {}),
        inputs,
        outputs,
        errors: check.nodes[node.id]?.errors ?? [],
      };
    };
    for (const id of path1.nodes) {
      const node = graph.nodes.find((candidate) => candidate.id === id);
      if (!node) continue;
      if (node.kind === 'BLOCK') steps.push(blockStep(node, 0, undefined, new Map()));
      else if (node.kind === 'WAIT' && node.wait)
        steps.push({
          node: node.id,
          kind: 'WAIT',
          label: node.label ?? 'Attente',
          depth: 0,
          wait: waitSummary(node.wait),
          inputs: [],
          outputs: [],
          errors: check.nodes[node.id]?.errors ?? [],
        });
      else if (node.kind === 'LOOP' && node.loop) {
        const spec = node.loop;
        const variables = loopVariableKeys(spec);
        const items =
          spec.type === 'FOR_EACH' && spec.itemsFrom === undefined ? (spec.items ?? []) : undefined;
        steps.push({
          node: node.id,
          kind: 'LOOP',
          label: node.label ?? loopSummary(spec),
          depth: 0,
          inputs:
            spec.itemsFrom !== undefined
              ? [
                  {
                    key: spec.itemsFrom,
                    source: produced.has(spec.itemsFrom) ? 'UPSTREAM' : 'DATA',
                    ...(produced.get(spec.itemsFrom)
                      ? { from: produced.get(spec.itemsFrom)?.from ?? '' }
                      : {}),
                    status: 'AT_RUN',
                  },
                ]
              : [],
          outputs: [],
          loop: {
            type: spec.type,
            summary: loopSummary(spec),
            ...(spec.type === 'REPEAT'
              ? { iterations: spec.times ?? 1 }
              : items
                ? { iterations: items.length }
                : {}),
            maxIterations: spec.maxIterations,
            timeoutS: spec.timeoutS,
            variables: variables.keys.map((key) => {
              if (key === `${spec.as}.index`) {
                const count = spec.type === 'REPEAT' ? (spec.times ?? 1) : items?.length;
                return count !== undefined
                  ? { key, values: Array.from({ length: count }, (_, at) => String(at + 1)) }
                  : { key };
              }
              if (!items) return { key };
              return {
                key,
                values: items.map((item) =>
                  typeof item === 'string' ? item : (item[key.slice(spec.as.length + 1)] ?? ''),
                ),
              };
            }),
          },
          errors: check.nodes[node.id]?.errors ?? [],
        });
        const local = new Map<string, { from: string; origin: string; scope: 'RUN' | 'ITERATION' }>();
        for (const item of spec.body) {
          if (item.kind === 'WAIT') {
            steps.push({
              node: item.id,
              kind: 'WAIT',
              label: item.label ?? 'Attente',
              depth: 1,
              ...(item.wait ? { wait: waitSummary(item.wait) } : {}),
              inputs: [],
              outputs: [],
              errors: [],
            });
            continue;
          }
          steps.push(
            blockStep(
              {
                id: item.id,
                kind: 'BLOCK',
                ...(item.block ? { block: item.block } : {}),
                ...(item.version !== undefined ? { version: item.version } : {}),
                ...(item.params ? { params: item.params } : {}),
                x: 0,
                y: 0,
              },
              1,
              spec,
              local,
            ),
          );
        }
      }
    }
    return { index: path1.index, choices: path1.choices, steps };
  });
  const errors = [
    ...check.errors,
    ...Object.entries(check.nodes).flatMap(([id, diag]) => diag.errors.map((error) => `${id} : ${error}`)),
    ...Object.entries(check.edges).flatMap(([id, list]) => list.map((error) => `${id} : ${error}`)),
  ];
  return { ok: check.ok, staticOnly: true, errors, paths };
}

/**
 * LE FLOW D'UNE EXÉCUTION DE SIMULATION : le chemin choisi d'un parcours valide, compilé comme « Créer » le
 * ferait (blocs rejoués par `run:`, boucles, attentes, données fusionnées), mais jamais écrit dans le projet.
 */
export async function simulationFlow(
  projectDir: string,
  raw: unknown,
  pathIndex = 0,
): Promise<{ flow: Record<string, unknown>; name: string }> {
  const journey = sanitizeJourney(raw);
  const check = await checkJourney(projectDir, journey);
  if (!check.ok) {
    const details = [
      ...check.errors,
      ...Object.entries(check.nodes).flatMap(([id, diag]) => diag.errors.map((error) => `${id} : ${error}`)),
      ...Object.entries(check.edges).flatMap(([id, list]) => list.map((error) => `${id} : ${error}`)),
    ];
    throw new LibraryError(details[0] ?? 'the journey does not hold', 422, details);
  }
  const path1 = check.paths.find((candidate) => candidate.index === pathIndex);
  if (!path1) throw new LibraryError(`no path ${String(pathIndex)} in this journey`, 404);
  const { entries } = await flowEntries(projectDir);
  const blocks = await blocksOf(entries, await readRegistry(projectDir));
  const { steps } = compileJourneyPath(journey.graph, path1.nodes);
  const blockNodes = blockNodesOf(journey.graph, path1.nodes);
  const names = blockNodes.map((node) => node.block ?? '');
  const parts = pathParts(blockNodes, partsOf(names, blocks, entries));
  const merged = mergeData(
    parts.map((part) => ({ from: part.name, data: part.block?.data })),
    journey.name,
  ).merged;
  const first = entries.find((entry) => entry.name === names[0]);
  const startAt = typeof first?.flow.startAt === 'string' ? first.flow.startAt : undefined;
  const name = `${journey.name.slice(0, 60)} · simulation${check.paths.length > 1 ? ` ${pathLetter(path1.index)}` : ''}`;
  return {
    name,
    flow: {
      name,
      description: `Simulation du parcours « ${journey.name} » (non enregistré comme scénario)`,
      ...(startAt ? { startAt } : {}),
      steps,
      ...(merged ? { testData: testDataSetDocument(merged) } : {}),
    },
  };
}

/** La description d'une donnée produite dans le parcours : son producteur et son champ de contrat. */
interface Produced {
  from: string;
  field?: ContractField;
}

const lastSegment = (key: string): string => (key.split('.').at(-1) ?? key).toLowerCase();

/** Deux types réellement connus (déclarés ou proposés) qui diffèrent : incompatibles. */
function typeClash(a: ContractField | undefined, b: ContractField | undefined): string | undefined {
  if (!a || !b || a.typeSource === 'DEFAULT' || b.typeSource === 'DEFAULT' || a.type === b.type)
    return undefined;
  return `${a.type}${a.typeSource === 'INFERRED' ? ' (proposé)' : ''} ≠ ${b.type}${b.typeSource === 'INFERRED' ? ' (proposé)' : ''}`;
}

/**
 * LE RACCORDEMENT, mêmes règles en mode linéaire et en diagramme (c'est la vérification du serveur) :
 *   - une correspondance existante (même nom, ou `MAP`) entre deux types connus différents est une erreur
 *     (déclarés) ou un avertissement (proposés) ; rien n'est converti ;
 *   - une entrée obligatoire manquante reçoit des propositions parmi les données disponibles sur TOUS les
 *     chemins qui l'atteignent : même sens métier, même type connu, même nom final. Une seule compatible
 *     avec une raison : UNIQUE (proposée) ; plusieurs : AMBIGUOUS ; aucune : NONE (une personne décide).
 */
function wireNodes(
  graph: JourneyGraph,
  blocks: Map<string, BlockInfo>,
  nodes: Record<string, JourneyNodeDiagnostics>,
  instanceKeys: Set<string>,
): void {
  const produced = new Map<string, Produced>();
  for (const node of graph.nodes) {
    if (node.kind !== 'BLOCK' || !node.block) continue;
    const info = blocks.get(node.block);
    const outputs = info?.view.contract.outputs.map((output) => output.key) ?? [];
    const renamed = instanceOutputs(node, outputs);
    outputs.forEach((key) => {
      const param = node.params?.[key];
      const name = param?.mode === 'MAP' ? param.key : param ? undefined : key;
      if (name === undefined || !renamed.includes(name)) return;
      const field = info?.view.contract.fields?.outputs.find((entry) => entry.key === key);
      if (!produced.has(name)) produced.set(name, { from: node.id, ...(field ? { field } : {}) });
    });
  }
  for (const node of graph.nodes) {
    if (node.kind !== 'BLOCK' || !node.block) continue;
    const diag = nodes[node.id];
    const fields = blocks.get(node.block)?.view.contract.fields?.inputs ?? [];
    if (!diag) continue;
    // Les correspondances existantes : types comparés.
    for (const input of fields) {
      const param = node.params?.[input.key];
      if (param?.mode === 'VALUE') continue;
      const source = param?.mode === 'MAP' ? param.key : input.key;
      const clash = typeClash(input, produced.get(source)?.field);
      if (!clash) continue;
      const text = `types incompatibles : l’entrée ${input.key} reçoit ${source} (${clash})`;
      if (input.typeSource === 'DECLARED' && produced.get(source)?.field?.typeSource === 'DECLARED')
        diag.errors.push(text);
      else diag.warnings.push(text);
    }
    const missing = [...new Set(diag.missing.map((item) => item.key))];
    if (missing.length === 0) continue;
    diag.proposals = missing.map((key): MappingProposal => {
      const input = fields.find((field) => field.key === key);
      const ranked = diag.available
        .filter((candidate) => candidate !== key && !instanceKeys.has(candidate))
        .map((candidate) => {
          const source = produced.get(candidate);
          const field = source?.field;
          const clash = typeClash(input, field);
          const reasons: string[] = [];
          let strength = 0;
          if (input?.meaning && field?.meaning && input.meaning === field.meaning) {
            reasons.push(`même sens métier (« ${input.meaning} »)`);
            strength = 3;
          }
          if (
            input &&
            field &&
            input.typeSource !== 'DEFAULT' &&
            field.typeSource !== 'DEFAULT' &&
            input.type === field.type
          ) {
            reasons.push(`même type (${input.type})`);
            strength = Math.max(strength, 2);
          }
          if (lastSegment(candidate) === lastSegment(key)) {
            reasons.push(`même nom final (${lastSegment(key)})`);
            strength = Math.max(strength, 1);
          }
          return { candidate, source, field, clash, reasons, strength: clash ? 0 : strength };
        });
      // Seul le plus fort indice compte : un même sens métier l'emporte sur un même type, lui-même sur un
      // même nom final ; à égalité, la correspondance reste ambiguë.
      const best = Math.max(0, ...ranked.map((entry) => entry.strength));
      const candidates = ranked
        .map((entry): MappingCandidate => ({
          key: entry.candidate,
          from: entry.source?.from ?? 'data',
          type: entry.field?.type ?? 'text',
          ...(entry.field?.meaning ? { meaning: entry.field.meaning } : {}),
          compatible: best > 0 && entry.strength === best,
          reason: entry.clash
            ? `types incompatibles (${entry.clash})`
            : entry.reasons.length > 0
              ? entry.reasons.join(', ')
              : 'aucun indice commun',
        }))
        .sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.key.localeCompare(b.key));
      const compatible = candidates.filter((candidate) => candidate.compatible);
      return {
        input: key,
        type: input?.type ?? 'text',
        ...(input?.meaning ? { meaning: input.meaning } : {}),
        status: compatible.length === 1 ? 'UNIQUE' : compatible.length > 1 ? 'AMBIGUOUS' : 'NONE',
        candidates: candidates.slice(0, 12),
      };
    });
    for (const proposal of diag.proposals)
      if (proposal.status === 'AMBIGUOUS')
        diag.warnings.push(
          `correspondance ambiguë pour ${proposal.input} : ${proposal.candidates
            .filter((candidate) => candidate.compatible)
            .map((candidate) => candidate.key)
            .join(', ')} — choisissez`,
        );
  }
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

/**
 * DÉCLARER DES DONNÉES d'un bloc : libellé, description, sens métier, type, valeur par défaut d'une entrée,
 * confirmation (ou retrait d'une sortie). Ce qui change de façon INCOMPATIBLE (type ou sens déclarés qui
 * changent, sortie retirée) incrémente la version de la donnée — jamais celle du bloc. Quand des scénarios
 * ou des parcours utilisent le bloc, ce changement est refusé (409, la liste des dépendants dans `details`)
 * tant que `acceptIncompatible` ne le valide pas explicitement. Rien n'est écrit en cas de refus.
 */
export function declareFields(
  projectDir: string,
  name: string,
  input: { fields: unknown; acceptIncompatible?: unknown },
): Promise<FieldDeclarationResult> {
  return withLock(projectDir, async () => {
    const declarations = (Array.isArray(input.fields) ? input.fields : [])
      .slice(0, 100)
      .map(sanitizeDeclaration)
      .filter((entry): entry is FieldDeclaration => entry !== undefined);
    if (declarations.length === 0) throw new LibraryError('fields: at least one valid declaration', 400);
    const { entries } = await flowEntries(projectDir);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const block = blocks.get(name);
    if (!block) throw new LibraryError(`no block named "${name}"`, 404);
    const known = new Set([
      ...(block.view.contract.fields?.inputs ?? []).map((field) => fieldKey('input', field.key)),
      ...(block.view.contract.fields?.outputs ?? []).map((field) => fieldKey('output', field.key)),
    ]);
    const next = withTakenOver(registry, blocks);
    const record = next.blocks[name] as BlockRecord;
    const stored: StoredFields = { ...(record.fields ?? {}) };
    const incompatible: FieldDeclarationResult['incompatible'] = [];
    for (const declaration of declarations) {
      const id = fieldKey(declaration.direction, declaration.key);
      if (!known.has(id))
        throw new LibraryError(
          `${declaration.key} is not an ${declaration.direction} of "${name}" (its steps decide its data)`,
          422,
        );
      const before = stored[id];
      const { direction: _direction, key: _key, ...rest } = declaration;
      const after: StoredField = { ...(before ?? { version: 1 }), ...rest };
      const reason = incompatibility(before, after, declaration.direction);
      if (reason) {
        after.version = (before?.version ?? 1) + 1;
        incompatible.push({
          key: declaration.key,
          direction: declaration.direction,
          version: after.version,
          reason,
        });
      }
      stored[id] = after;
    }
    const store = await readStore(projectDir);
    const journeys = Object.values(store.journeys)
      .filter((journey) =>
        journey.graph.nodes.some(
          (node) =>
            (node.kind === 'BLOCK' && node.block === name) ||
            (node.loop?.body ?? []).some((item) => item.block === name),
        ),
      )
      .map((journey) => `parcours ${journey.name}`);
    const dependents = [...block.view.usedBy.map((scenario) => `scénario ${scenario}`), ...journeys];
    if (incompatible.length > 0 && dependents.length > 0 && input.acceptIncompatible !== true)
      throw new LibraryError(
        `incompatible change (${incompatible.map((item) => `${item.key}: ${item.reason}`).join('; ')}) used by ${dependents.join(', ')}: validate it explicitly`,
        409,
        [...incompatible.map((item) => `${item.key} : ${item.reason}`), ...dependents],
      );
    const at = new Date().toISOString();
    next.blocks[name] = {
      ...record,
      fields: stored,
      updatedAt: at,
      history: [
        ...record.history,
        {
          version: record.version,
          at,
          change: `data declared: ${declarations.map((entry) => entry.key).join(', ')}${incompatible.length > 0 ? ` (incompatible: ${incompatible.map((item) => `${item.key} v${String(item.version)}`).join(', ')})` : ''}`,
        },
      ],
    };
    await commitFiles([registryFile(projectDir, next)]);
    return { block: await blockNamed(projectDir, name), incompatible, dependents };
  });
}
