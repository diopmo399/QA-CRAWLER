import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
import { parseTestDataSet, testDataSetDocument, type TestDataSet } from '../../data/test-data-set.js';
import { slug } from '../../knowledge/signatures.js';
import type {
  BlockSourceComparison,
  BlockState,
  ComposeScenarioInput,
  CompositionCheck,
  CompositionDrift,
  DeclaredContract,
  ExtractionInput,
  ExtractionPlan,
  ExtractionStepView,
  LibraryBlockDetails,
  LibraryBlockView,
  LibrarySourcePreview,
} from '../core/contracts.js';
import {
  checkComposition,
  contentHash,
  contractOf,
  dataUse,
  isDynamic,
  mergeData,
  type CompositionPart,
} from './library-contract.js';
import {
  contentChanges,
  planExtraction,
  validateBlockFlow,
  type ExtractionDraft,
  type ExtractionSource,
} from './library-extract.js';
import { describeStep, flowSchema } from '../../config/flow-schema.js';
import { flowsDirOf, revisionOf } from './platform.js';

/**
 * LA BIBLIOTHÈQUE DE SCÉNARIOS : des parcours réutilisables. Un bloc est un flow `reusable: true`
 * (jamais exécuté seul) que d'autres scénarios rejouent par une étape `run: <nom>` ; le moteur recopie
 * ses étapes à cet endroit (src/flows/flow-includes.ts). Un bloc vient d'un scénario ou d'un groupe
 * métier d'un enregistrement ; il s'insère dans un scénario existant ou compose un nouveau parcours.
 * Ses données de test suivent : elles rejoignent le jeu du scénario qui le rejoue, et une donnée
 * définie autrement des deux côtés est refusée (jamais écrasée, rien n'est écrit en partie).
 *
 *   <flows>/library/<bloc>/<bloc>.flow.yaml     le bloc (reusable: true) et son test-data.yaml
 *   <flows>/composed/<nom>/<nom>.flow.yaml      un parcours composé de blocs (steps: - run: …)
 *   <projet>/sdk-library.json                   le registre (version 2) : pour chaque bloc son identifiant,
 *                                               sa version validée et l'empreinte de son contenu, son
 *                                               historique, son origine et son contrat déclaré ; pour
 *                                               chaque parcours suivi, la version de chaque bloc rejoué.
 *
 * Le format de `run:` ne change pas : un parcours rejoue toujours un bloc par son nom. La reproductibilité
 * vient du registre : un parcours suivi dont un bloc a changé depuis sa composition n'est pas rejoué tant
 * que la nouvelle version n'est pas acceptée explicitement (compositionDrift, acceptBlocks).
 */
export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

type Raw = Record<string, unknown>;

interface FlowEntry {
  name: string;
  /** Le fichier (absolu) et son chemin relatif au dossier des flows. */
  file: string;
  relative: string;
  flow: Raw;
  /** Le flow est l'un de plusieurs d'un fichier (`flows: [...]`), à cette position. */
  index?: number;
}

interface BlockRecord {
  id: string;
  version: number;
  hash: string;
  createdAt?: string;
  updatedAt?: string;
  origin?: LibraryBlockView['origin'];
  contract?: DeclaredContract;
  history: { version: number; at?: string; change: string }[];
}

interface CompositionRecord {
  at: string;
  blocks: { name: string; id: string; version: number; hash: string }[];
}

interface Registry {
  version: 2;
  blocks: Record<string, BlockRecord>;
  compositions: Record<string, CompositionRecord>;
}

const LIBRARY_FILE = 'sdk-library.json';
const NAME_MAX = 80;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------------------------------------
// Écritures : une opération à la fois par projet, et tous ses fichiers ensemble ou aucun.
// ---------------------------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/** Les opérations de la bibliothèque d'un projet passent l'une après l'autre (jamais deux écritures mêlées). */
function withLock<T>(projectDir: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectDir) ?? Promise.resolve();
  const next = previous.then(run, run);
  locks.set(
    projectDir,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Écrit plusieurs fichiers ensemble : chacun d'abord à côté, puis tous mis en place ; si une mise en
 * place échoue, les fichiers déjà remplacés reprennent leur contenu d'avant. Jamais d'état partiel.
 */
export async function commitFiles(files: readonly { file: string; content: string }[]): Promise<void> {
  const token = randomUUID().slice(0, 8);
  const staged: { file: string; temp: string; backup?: string }[] = [];
  try {
    for (const { file, content } of files) {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${token}.tmp`;
      await writeFile(temp, content, 'utf8');
      staged.push({ file, temp, ...((await exists(file)) ? { backup: `${file}.${token}.bak` } : {}) });
    }
    for (const item of staged) if (item.backup) await copyFile(item.file, item.backup);
  } catch (error) {
    await Promise.all(staged.flatMap((item) => [rm(item.temp, { force: true })]));
    throw error;
  }
  const placed: typeof staged = [];
  try {
    for (const item of staged) {
      await rename(item.temp, item.file);
      placed.push(item);
    }
  } catch (error) {
    for (const item of placed)
      if (item.backup) await copyFile(item.backup, item.file).catch(() => undefined);
      else await rm(item.file, { force: true }).catch(() => undefined);
    await Promise.all(staged.map((item) => rm(item.temp, { force: true })));
    await removeBackups(staged);
    throw error;
  }
  await removeBackups(staged);
}

const removeBackups = (staged: readonly { backup?: string }[]): Promise<unknown> =>
  Promise.all(staged.flatMap((item) => (item.backup ? [rm(item.backup, { force: true })] : [])));

// ---------------------------------------------------------------------------------------------
// Le registre : version 2, l'ancien format (origines seules) est repris avec des valeurs explicites.
// ---------------------------------------------------------------------------------------------

async function readRegistry(projectDir: string): Promise<Registry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(projectDir, LIBRARY_FILE), 'utf8'));
  } catch {
    return { version: 2, blocks: {}, compositions: {} };
  }
  if (!isObject(parsed)) return { version: 2, blocks: {}, compositions: {} };
  if (parsed.version === 2)
    return {
      version: 2,
      blocks: isObject(parsed.blocks) ? (parsed.blocks as Registry['blocks']) : {},
      compositions: isObject(parsed.compositions) ? (parsed.compositions as Registry['compositions']) : {},
    };
  // Version 1 : { origins: { bloc: origine } }. Les autres champs sont complétés à la lecture des blocs
  // (version 1, empreinte du contenu actuel, historique « repris ») et écrits à la prochaine opération.
  const origins = isObject(parsed.origins)
    ? (parsed.origins as Record<string, LibraryBlockView['origin']>)
    : {};
  return {
    version: 2,
    blocks: Object.fromEntries(
      Object.entries(origins).map(([name, origin]) => [
        name,
        { id: slug(name), version: 0, hash: '', ...(origin ? { origin } : {}), history: [] },
      ]),
    ),
    compositions: {},
  };
}

const registryFile = (projectDir: string, registry: Registry): { file: string; content: string } => ({
  file: path.join(projectDir, LIBRARY_FILE),
  content: `${JSON.stringify(registry, null, 2)}\n`,
});

// ---------------------------------------------------------------------------------------------
// Lecture des flows du projet.
// ---------------------------------------------------------------------------------------------

async function flowEntries(projectDir: string): Promise<{ root: string; entries: FlowEntry[] }> {
  const root = await flowsDirOf(projectDir);
  if (!(await exists(root))) return { root, entries: [] };
  const files = (await readdir(root, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name) && !entry.name.includes('test-data'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  const entries: FlowEntry[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (Array.isArray(parsed.flows))
      parsed.flows.forEach((flow, index) => {
        if (isObject(flow) && typeof flow.name === 'string')
          entries.push({ name: flow.name, file, relative, flow, index });
      });
    else if ('steps' in parsed && typeof parsed.name === 'string')
      entries.push({ name: parsed.name, file, relative, flow: parsed });
  }
  return { root, entries };
}

const stepsOf = (flow: Raw): Raw[] => (Array.isArray(flow.steps) ? flow.steps.filter(isObject) : []);

/** Les flows qu'un flow rejoue par `run:`, dans l'ordre. */
export function runsOf(flow: Raw): string[] {
  return stepsOf(flow)
    .map((step) => step.run)
    .filter((run): run is string => typeof run === 'string');
}

/** Le jeu de données d'un flow (fichier relatif au flow, ou jeu écrit dans le flow). */
async function testDataOf(entry: FlowEntry): Promise<TestDataSet | undefined> {
  const value = entry.flow.testData;
  if (value === undefined) return undefined;
  const raw: unknown =
    typeof value === 'string'
      ? parseYaml(await readFile(path.resolve(path.dirname(entry.file), value), 'utf8'))
      : value;
  return parseTestDataSet(raw, entry.name);
}

interface BlockInfo {
  view: LibraryBlockView;
  data?: TestDataSet;
  /** L'enregistrement à écrire si le bloc vient d'être repris (pas encore dans le registre). */
  record: BlockRecord;
}

/** Ce qu'est un bloc maintenant : contrat, état (version, contenu), scénarios qui le rejouent. */
async function describeBlock(
  entry: FlowEntry,
  entries: readonly FlowEntry[],
  registry: Registry,
): Promise<BlockInfo> {
  const problems: string[] = [];
  let data: TestDataSet | undefined;
  try {
    data = await testDataOf(entry);
  } catch (error) {
    problems.push(`its test data cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const steps = stepsOf(entry.flow);
  if (steps.length === 0) problems.push('it has no step');
  // Un bloc dont le flow ne passe pas le schéma ne se compose pas (le rejeu le refuserait).
  else problems.push(...validateBlockFlow(entry.flow, data));
  for (const run of runsOf(entry.flow))
    if (!entries.some((other) => other.name === run)) problems.push(`run "${run}": no flow has this name`);
  const hash = contentHash({ startAt: entry.flow.startAt, steps }, data);
  const known = registry.blocks[entry.name];
  const record: BlockRecord =
    known && known.version > 0
      ? known
      : {
          id: known?.id ?? slug(entry.name),
          version: 1,
          hash,
          ...(known?.origin ? { origin: known.origin } : {}),
          history: [{ version: 1, change: 'taken over: no earlier record of this block' }],
        };
  const { contract, problems: contradictions } = contractOf({
    name: entry.name,
    steps,
    ...(data ? { data } : {}),
    ...(record.contract ? { declared: record.contract } : {}),
  });
  problems.push(...contradictions);
  const changed = record.hash !== hash;
  if (changed) problems.push(`its content changed since version ${String(record.version)}`);
  const state: BlockState = problems.length > (changed ? 1 : 0) ? 'INVALID' : changed ? 'CHANGED' : 'VALID';
  const use = dataUse(steps);
  const pinnedBy = Object.entries(registry.compositions).flatMap(([scenario, composition]) =>
    composition.blocks
      .filter((ref) => ref.name === entry.name)
      .map((ref) => ({ scenario, version: ref.version, current: ref.hash === hash })),
  );
  const view: LibraryBlockView = {
    id: record.id,
    name: entry.name,
    file: entry.relative,
    steps: steps.length,
    ...(typeof entry.flow.startAt === 'string' ? { startAt: entry.flow.startAt } : {}),
    ...(typeof entry.flow.description === 'string' ? { description: entry.flow.description } : {}),
    ...(record.origin ? { origin: record.origin } : {}),
    ...(Array.isArray(entry.flow.groups) && entry.flow.groups.length > 0
      ? {
          groups: entry.flow.groups.filter(isObject).map((group) => ({
            id: typeof group.id === 'string' ? group.id : '',
            name: typeof group.name === 'string' ? group.name : '',
            steps: Array.isArray(group.steps) ? group.steps.length : 0,
          })),
        }
      : {}),
    version: record.version,
    hash,
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    history: record.history,
    state,
    problems,
    contract,
    data: Object.values(data?.values ?? {})
      .map((value) => ({ key: value.key, dynamic: isDynamic(value) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    assertions: Array.isArray(entry.flow.assertions) ? entry.flow.assertions.length : 0,
    inputs: use.fills,
    citations: use.cites,
    usedBy: entries.filter((other) => runsOf(other.flow).includes(entry.name)).map((other) => other.name),
    pinnedBy: pinnedBy.filter((pin) => entries.some((other) => other.name === pin.scenario)),
  };
  return { view, ...(data ? { data } : {}), record };
}

async function blocksOf(entries: readonly FlowEntry[], registry: Registry): Promise<Map<string, BlockInfo>> {
  const blocks = new Map<string, BlockInfo>();
  for (const entry of entries)
    if (entry.flow.reusable === true) blocks.set(entry.name, await describeBlock(entry, entries, registry));
  return blocks;
}

/** Les blocs de la bibliothèque : version, contrat, état, provenance et scénarios qui les rejouent. */
export async function listLibrary(projectDir: string): Promise<LibraryBlockView[]> {
  const { entries } = await flowEntries(projectDir);
  const blocks = await blocksOf(entries, await readRegistry(projectDir));
  return [...blocks.values()].map((block) => block.view);
}

/** Ce qu'un scénario deviendrait en bloc : étapes, départ, données (sans valeur), contrat dérivé. */
export async function previewSource(projectDir: string, scenario: string): Promise<LibrarySourcePreview> {
  const { entries } = await flowEntries(projectDir);
  const source = entries.find((entry) => entry.name === scenario);
  if (!source) throw new LibraryError(`no scenario named "${scenario}"`, 404);
  const data = await testDataOf(source);
  const steps = stepsOf(source.flow);
  return {
    scenario,
    file: source.relative,
    steps: steps.length,
    ...(typeof source.flow.startAt === 'string' ? { startAt: source.flow.startAt } : {}),
    ...(typeof source.flow.description === 'string' ? { description: source.flow.description } : {}),
    data: Object.values(data?.values ?? {})
      .map((value) => ({ key: value.key, dynamic: isDynamic(value) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    contract: contractOf({ name: scenario, steps, ...(data ? { data } : {}) }).contract,
    reusable: source.flow.reusable === true,
  };
}

function freeName(entries: readonly FlowEntry[], raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > NAME_MAX || !slug(name))
    throw new LibraryError(`a name of 1 to ${String(NAME_MAX)} characters is required`, 400);
  if (entries.some((entry) => entry.name === name))
    throw new LibraryError(`a scenario or a block is already named "${name}"`, 409);
  return name;
}

/** Les fichiers d'un nouveau flow dans <flows>/<dossier>/<nom>/, avec son jeu de données ; jamais par-dessus un autre. */
async function flowFiles(
  root: string,
  folder: string,
  flow: Raw,
  data: TestDataSet | undefined,
): Promise<{ relative: string; files: { file: string; content: string }[] }> {
  const base = slug(String(flow.name));
  const directory = path.join(root, folder, base);
  if (await exists(directory)) throw new LibraryError(`${folder}/${base} already exists`, 409);
  const hasData = data !== undefined && Object.keys(data.values).length > 0;
  const { steps, ...head } = flow;
  return {
    relative: `${folder}/${base}/${base}.flow.yaml`,
    files: [
      ...(hasData
        ? [
            {
              file: path.join(directory, 'test-data.yaml'),
              content: stringifyYaml(testDataSetDocument(data), { lineWidth: 0 }),
            },
          ]
        : []),
      {
        file: path.join(directory, `${base}.flow.yaml`),
        content: stringifyYaml(
          { ...head, ...(hasData ? { testData: 'test-data.yaml' } : {}), steps },
          { lineWidth: 0 },
        ),
      },
    ],
  };
}

async function newBlock(
  projectDir: string,
  root: string,
  flow: Raw,
  data: TestDataSet | undefined,
  origin: NonNullable<LibraryBlockView['origin']>,
): Promise<LibraryBlockView> {
  const name = String(flow.name);
  const { files } = await flowFiles(root, 'library', flow, data);
  const registry = await readRegistry(projectDir);
  const at = new Date().toISOString();
  registry.blocks[name] = {
    id: slug(name),
    version: 1,
    hash: contentHash({ startAt: flow.startAt, steps: stepsOf(flow) }, data),
    createdAt: at,
    updatedAt: at,
    origin,
    history: [
      {
        version: 1,
        at,
        change:
          origin.kind === 'scenario'
            ? `created from the scenario "${origin.name}"`
            : `created from the group "${origin.group ?? ''}" of the recording ${origin.name}`,
      },
    ],
  };
  await commitFiles([...files, registryFile(projectDir, registry)]);
  return blockNamed(projectDir, name);
}

/** Un scénario devient un bloc de la bibliothèque (ses étapes et ses données sont recopiées). */
export function addScenarioToLibrary(
  projectDir: string,
  input: { scenario: string; name: string; description?: string },
): Promise<LibraryBlockView> {
  return withLock(projectDir, async () => {
    const { root, entries } = await flowEntries(projectDir);
    const source = entries.find((entry) => entry.name === input.scenario);
    if (!source) throw new LibraryError(`no scenario named "${input.scenario}"`, 404);
    const name = freeName(entries, input.name);
    const steps = stepsOf(source.flow);
    if (steps.length === 0) throw new LibraryError(`"${input.scenario}" has no step`, 422);
    // Un flow invalide n'entre jamais dans la bibliothèque : chaque erreur dit son étape.
    const invalid = validateBlockFlow(
      {
        name,
        ...(typeof source.flow.startAt === 'string' ? { startAt: source.flow.startAt } : {}),
        steps,
      },
      await testDataOf(source),
    );
    if (invalid.length > 0)
      throw new LibraryError(`"${input.scenario}" is not a valid flow: ${invalid[0] ?? ''}`, 422, invalid);
    return newBlock(
      projectDir,
      root,
      {
        name,
        ...(input.description ? { description: input.description } : {}),
        reusable: true,
        ...(typeof source.flow.startAt === 'string' ? { startAt: source.flow.startAt } : {}),
        steps,
      },
      await testDataOf(source),
      { kind: 'scenario', name: input.scenario },
    );
  });
}

/** Un groupe métier d'un enregistrement devient un bloc (ses étapes, telles que dans le flow généré). */
export function addGroupToLibrary(
  projectDir: string,
  recording: { directory: string; name: string },
  input: { groupId: string; name: string; startAt?: string; description?: string },
): Promise<LibraryBlockView> {
  return withLock(projectDir, async () => {
    const { root, entries } = await flowEntries(projectDir);
    const name = freeName(entries, input.name);
    const text = await readFile(path.join(recording.directory, 'generated.flow.yaml'), 'utf8').catch(
      () => undefined,
    );
    if (!text) throw new LibraryError(`recording "${recording.name}" has no generated flow (YAML)`, 422);
    const flow = parseYaml(text) as Raw;
    const groups = Array.isArray(flow.groups) ? flow.groups.filter(isObject) : [];
    const group = groups.find((entry) => entry.id === input.groupId);
    if (!group || !Array.isArray(group.steps))
      throw new LibraryError(`no group ${input.groupId} in this recording`, 404);
    const all = stepsOf(flow);
    const steps = (group.steps as unknown[])
      .filter((position): position is number => typeof position === 'number')
      .map((position) => all[position - 1])
      .filter((step): step is Raw => step !== undefined);
    if (steps.length === 0) throw new LibraryError(`group ${input.groupId} has no step`, 422);
    const dataFile = path.join(recording.directory, 'test-data.yaml');
    const data = (await exists(dataFile))
      ? parseTestDataSet(parseYaml(await readFile(dataFile, 'utf8')), name)
      : undefined;
    return newBlock(
      projectDir,
      root,
      {
        name,
        ...(input.description ? { description: input.description } : {}),
        reusable: true,
        ...(input.startAt ? { startAt: input.startAt } : {}),
        steps,
      },
      data,
      {
        kind: 'recording',
        name: recording.name,
        group: typeof group.name === 'string' ? group.name : input.groupId,
      },
    );
  });
}

async function blockNamed(projectDir: string, name: string): Promise<LibraryBlockView> {
  const block = (await listLibrary(projectDir)).find((entry) => entry.name === name);
  if (!block) throw new LibraryError(`the block "${name}" could not be read back`, 422);
  return block;
}

/** Retire un bloc de la bibliothèque ; refusé tant qu'un scénario le rejoue (les scénarios sont nommés). */
export function removeFromLibrary(projectDir: string, name: string): Promise<void> {
  return withLock(projectDir, async () => {
    const { root, entries } = await flowEntries(projectDir);
    const entry = entries.find((candidate) => candidate.name === name && candidate.flow.reusable === true);
    if (!entry) throw new LibraryError(`no block named "${name}"`, 404);
    const users = entries.filter((other) => runsOf(other.flow).includes(name)).map((other) => other.name);
    if (users.length > 0)
      throw new LibraryError(
        `"${name}" is used by ${users.map((user) => `"${user}"`).join(', ')}`,
        409,
        users,
      );
    const directory = path.dirname(entry.file);
    if (path.dirname(directory) !== path.join(root, 'library') || entry.index !== undefined)
      throw new LibraryError(`"${name}" was not created by the library: edit ${entry.relative} instead`, 409);
    const registry = await readRegistry(projectDir);
    registry.blocks = Object.fromEntries(Object.entries(registry.blocks).filter(([key]) => key !== name));
    await commitFiles([registryFile(projectDir, registry)]);
    await rm(directory, { recursive: true, force: true });
  });
}

/** Les blocs d'une composition, tels que la vérification les voit. */
function partsOf(
  names: readonly string[],
  blocks: Map<string, BlockInfo>,
  entries: readonly FlowEntry[],
): CompositionPart[] {
  return names.map((name) => {
    const block = blocks.get(name);
    if (block)
      return {
        name,
        block: {
          reusable: true,
          version: block.view.version,
          state: block.view.state,
          steps: block.view.steps,
          contract: block.view.contract,
          problems: block.view.problems,
          ...(block.data ? { data: block.data } : {}),
        },
      };
    const scenario = entries.find((entry) => entry.name === name);
    return scenario
      ? {
          name,
          block: {
            reusable: false,
            version: 0,
            state: 'VALID' as const,
            steps: stepsOf(scenario.flow).length,
            contract: {
              source: 'DERIVED' as const,
              inputs: [],
              outputs: [],
              preconditions: [],
              postconditions: [],
            },
            problems: [],
          },
        }
      : { name };
  });
}

const refsOf = (names: readonly string[], blocks: Map<string, BlockInfo>): CompositionRecord['blocks'] =>
  names.flatMap((name) => {
    const block = blocks.get(name);
    return block ? [{ name, id: block.view.id, version: block.view.version, hash: block.view.hash }] : [];
  });

/** Le registre, avec les blocs repris (lus pour la première fois) enregistrés tels qu'ils sont. */
function withTakenOver(registry: Registry, blocks: Map<string, BlockInfo>): Registry {
  const next: Registry = { ...registry, blocks: { ...registry.blocks } };
  for (const [name, block] of blocks)
    if ((next.blocks[name]?.version ?? 0) === 0) next.blocks[name] = block.record;
  return next;
}

/** VÉRIFIER UN PARCOURS avant de le créer (dry run de composition : rien n'est écrit ni exécuté). */
export async function checkCompositionOf(
  projectDir: string,
  input: ComposeScenarioInput,
): Promise<CompositionCheck> {
  const { entries } = await flowEntries(projectDir);
  const blocks = await blocksOf(entries, await readRegistry(projectDir));
  return checkComposition({
    name: typeof input.name === 'string' ? input.name : '',
    parts: partsOf(Array.isArray(input.parts) ? input.parts : [], blocks, entries),
    taken: entries.map((entry) => entry.name),
  });
}

/** Une vérification qui refuse : 409 pour un conflit de données, 422 sinon ; chaque erreur est détaillée. */
function refuse(check: CompositionCheck): never {
  const status =
    check.conflicts.length > 0 || check.errors.some((error) => error.includes('already named')) ? 409 : 422;
  throw new LibraryError(check.errors[0] ?? 'the journey does not hold', status, check.errors);
}

/** Un nouveau scénario fait de blocs, rejoués dans l'ordre : vérifié d'abord, puis écrit en une fois. */
export function composeScenario(projectDir: string, input: ComposeScenarioInput): Promise<string> {
  return withLock(projectDir, async () => {
    const { root, entries } = await flowEntries(projectDir);
    if (!Array.isArray(input.parts) || input.parts.length === 0 || input.parts.length > 30)
      throw new LibraryError('choose 1 to 30 blocks', 400);
    const name = freeName(entries, input.name);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const parts = partsOf(input.parts, blocks, entries);
    const unknown = parts.find((part) => !part.block);
    if (unknown) throw new LibraryError(`no block named "${unknown.name}"`, 404);
    const check = checkComposition({ name, parts, taken: entries.map((entry) => entry.name) });
    if (!check.ok) refuse(check);
    const merged = mergeData(
      parts.map((part) => ({ from: part.name, data: part.block?.data })),
      name,
    ).merged;
    const first = entries.find((entry) => entry.name === input.parts[0]);
    const startAt = typeof first?.flow.startAt === 'string' ? first.flow.startAt : undefined;
    const { relative, files } = await flowFiles(
      root,
      'composed',
      {
        name,
        ...(input.description ? { description: input.description } : {}),
        ...(startAt ? { startAt } : {}),
        steps: input.parts.map((part) => ({ run: part })),
      },
      merged,
    );
    const next = withTakenOver(registry, blocks);
    next.compositions[name] = { at: new Date().toISOString(), blocks: refsOf(input.parts, blocks) };
    await commitFiles([...files, registryFile(projectDir, next)]);
    return relative;
  });
}

/**
 * Insère un bloc au début ou à la fin d'un scénario (`run:`) ; ses données rejoignent le jeu du scénario.
 * Vérifié d'abord (conflit : 409, entrée manquante : 422), sur la version lue du scénario (sinon 409),
 * puis les deux fichiers sont écrits ensemble.
 */
export function insertBlock(
  projectDir: string,
  scenario: string,
  input: { block: string; at: 'start' | 'end'; revision?: string },
): Promise<void> {
  return withLock(projectDir, async () => {
    const { entries } = await flowEntries(projectDir);
    const target = entries.find((entry) => entry.name === scenario);
    if (!target) throw new LibraryError(`no scenario named "${scenario}"`, 404);
    const text = await readFile(target.file, 'utf8');
    if (input.revision !== undefined && input.revision !== revisionOf(text))
      throw new LibraryError(`"${scenario}" changed since it was read: reload it, then insert again`, 409);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const block = blocks.get(input.block);
    if (!block) throw new LibraryError(`no block named "${input.block}"`, 404);
    if (
      input.block === target.name ||
      runsOf(entries.find((entry) => entry.name === input.block)?.flow ?? {}).includes(target.name)
    )
      throw new LibraryError(`"${input.block}" already replays "${scenario}": that would loop`, 409);
    const document = parseDocument(text);
    const node = target.index !== undefined ? document.getIn(['flows', target.index]) : document.contents;
    if (!isMap(node)) throw new LibraryError(`"${scenario}" cannot be edited`, 422);
    const steps = node.get('steps');
    if (!isSeq(steps)) throw new LibraryError(`"${scenario}" has no steps`, 422);
    const current = node.get('testData');
    if (current !== undefined && typeof current !== 'string')
      throw new LibraryError(`"${scenario}" writes its test data inline: move it to a file first`, 422);
    const dataFile =
      typeof current === 'string'
        ? path.resolve(path.dirname(target.file), current)
        : path.join(path.dirname(target.file), `${slug(scenario)}.test-data.yaml`);
    const existing = (await exists(dataFile))
      ? parseTestDataSet(parseYaml(await readFile(dataFile, 'utf8')), scenario)
      : undefined;
    // Ce que le scénario fournit déjà au bloc : son jeu, et à la fin, ce que ses étapes et ses blocs saisissent.
    const runs = runsOf(target.flow);
    const produces =
      input.at === 'end'
        ? [
            ...dataUse(stepsOf(target.flow)).fills,
            ...runs.flatMap(
              (run) => blocks.get(run)?.view.contract.outputs.map((output) => output.key) ?? [],
            ),
          ]
        : [];
    const check = checkComposition({
      name: scenario,
      parts: partsOf([input.block], blocks, entries),
      taken: [],
      nameRequired: false,
      base: { from: scenario, ...(existing ? { data: existing } : {}), produces },
    });
    if (!check.ok) refuse(check);
    const files: { file: string; content: string }[] = [];
    if (block.data && Object.keys(block.data.values).length > 0) {
      const merged = mergeData(
        [
          { from: scenario, ...(existing ? { data: existing } : {}) },
          { from: input.block, data: block.data },
        ],
        scenario,
      ).merged;
      if (merged)
        files.push({ file: dataFile, content: stringifyYaml(testDataSetDocument(merged), { lineWidth: 0 }) });
      if (typeof current !== 'string') node.set('testData', path.basename(dataFile));
    }
    const step = document.createNode({ run: input.block });
    if (input.at === 'start') steps.items.unshift(step);
    else steps.items.push(step);
    files.push({ file: target.file, content: document.toString({ lineWidth: 0 }) });
    const next = withTakenOver(registry, blocks);
    const order = input.at === 'start' ? [input.block, ...runs] : [...runs, input.block];
    next.compositions[scenario] = { at: new Date().toISOString(), blocks: refsOf(order, blocks) };
    files.push(registryFile(projectDir, next));
    await commitFiles(files);
  });
}

const textList = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

/** Lit un contrat envoyé : des clés de données valides, des conditions en texte court. */
export function declaredContractOf(raw: unknown): DeclaredContract {
  if (!isObject(raw)) throw new LibraryError('contract must be an object', 400);
  const inputs = Array.isArray(raw.inputs)
    ? raw.inputs.filter(isObject).map((input) => ({
        key: typeof input.key === 'string' ? input.key.trim() : '',
        required: input.required !== false,
      }))
    : [];
  const outputs = textList(raw.outputs, 50);
  for (const key of [...inputs.map((input) => input.key), ...outputs])
    if (!KEY.test(key)) throw new LibraryError(`"${key}" is not a test data key (request.title)`, 400);
  return {
    inputs: inputs.slice(0, 50),
    outputs,
    preconditions: textList(raw.preconditions, 20).map((text) => text.slice(0, 200)),
    postconditions: textList(raw.postconditions, 20).map((text) => text.slice(0, 200)),
  };
}

/** Déclare (ou, avec null, retire) le contrat d'un bloc ; le changement entre dans son historique. */
export function declareContract(
  projectDir: string,
  name: string,
  contract: DeclaredContract | null,
): Promise<LibraryBlockView> {
  return withLock(projectDir, async () => {
    const { entries } = await flowEntries(projectDir);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const block = blocks.get(name);
    if (!block) throw new LibraryError(`no block named "${name}"`, 404);
    const next = withTakenOver(registry, blocks);
    const record = next.blocks[name] as BlockRecord;
    const at = new Date().toISOString();
    const { contract: _previous, ...rest } = record;
    next.blocks[name] = {
      ...rest,
      ...(contract ? { contract } : {}),
      updatedAt: at,
      history: [
        ...record.history,
        {
          version: record.version,
          at,
          change: contract ? 'contract declared' : 'contract derived from the content again',
        },
      ],
    };
    await commitFiles([registryFile(projectDir, next)]);
    return blockNamed(projectDir, name);
  });
}

/** Valide le contenu actuel d'un bloc modifié : il devient sa version suivante (explicitement). */
export function validateVersion(projectDir: string, name: string): Promise<LibraryBlockView> {
  return withLock(projectDir, async () => {
    const { entries } = await flowEntries(projectDir);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const block = blocks.get(name);
    if (!block) throw new LibraryError(`no block named "${name}"`, 404);
    if (block.view.state !== 'CHANGED')
      throw new LibraryError(
        block.view.state === 'INVALID'
          ? `"${name}" does not hold: ${block.view.problems.join('; ')}`
          : `"${name}" did not change since version ${String(block.view.version)}`,
        block.view.state === 'INVALID' ? 422 : 409,
        block.view.problems,
      );
    const next = withTakenOver(registry, blocks);
    const record = next.blocks[name] as BlockRecord;
    const at = new Date().toISOString();
    next.blocks[name] = {
      ...record,
      version: record.version + 1,
      hash: block.view.hash,
      updatedAt: at,
      history: [...record.history, { version: record.version + 1, at, change: 'new content validated' }],
    };
    await commitFiles([registryFile(projectDir, next)]);
    return blockNamed(projectDir, name);
  });
}

/** Les parcours suivis dont un bloc a changé depuis leur composition (rejeu refusé tant que ce n'est pas accepté). */
export async function compositionDrift(
  projectDir: string,
  scenarios?: readonly string[],
): Promise<CompositionDrift[]> {
  const registry = await readRegistry(projectDir);
  const wanted = Object.entries(registry.compositions).filter(
    ([scenario]) => !scenarios || scenarios.includes(scenario),
  );
  if (wanted.length === 0) return [];
  const { entries } = await flowEntries(projectDir);
  const blocks = await blocksOf(entries, registry);
  const drift: CompositionDrift[] = [];
  for (const [scenario, composition] of wanted) {
    if (!entries.some((entry) => entry.name === scenario)) continue;
    for (const ref of composition.blocks) {
      const block = blocks.get(ref.name);
      if (!block || block.view.hash === ref.hash) continue;
      drift.push({
        scenario,
        block: ref.name,
        pinned: ref.version,
        current: block.view.version,
        unvalidated: block.view.state !== 'VALID',
      });
    }
  }
  return drift;
}

/** Accepte la version actuelle des blocs d'un parcours suivi, après l'avoir vérifié de nouveau. */
export function acceptBlocks(projectDir: string, scenario: string): Promise<CompositionCheck> {
  return withLock(projectDir, async () => {
    const { entries } = await flowEntries(projectDir);
    const target = entries.find((entry) => entry.name === scenario);
    if (!target) throw new LibraryError(`no scenario named "${scenario}"`, 404);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const runs = runsOf(target.flow);
    const unvalidated = runs.filter((run) => blocks.get(run)?.view.state !== 'VALID');
    if (unvalidated.length > 0)
      throw new LibraryError(
        `validate the new version of ${unvalidated.map((run) => `"${run}"`).join(', ')} first`,
        409,
        unvalidated,
      );
    let existing: TestDataSet | undefined;
    try {
      existing = await testDataOf(target);
    } catch {
      existing = undefined;
    }
    const check = checkComposition({
      name: scenario,
      parts: partsOf(runs, blocks, entries),
      taken: [],
      nameRequired: false,
      base: {
        from: scenario,
        ...(existing ? { data: existing } : {}),
        produces: dataUse(stepsOf(target.flow)).fills,
      },
    });
    if (!check.ok) refuse(check);
    const next = withTakenOver(registry, blocks);
    next.compositions[scenario] = { at: new Date().toISOString(), blocks: refsOf(runs, blocks) };
    await commitFiles([registryFile(projectDir, next)]);
    return check;
  });
}

// ---------------------------------------------------------------------------------------------
// Extraction de groupes métier d'un enregistrement (voir library-extract.ts).
// ---------------------------------------------------------------------------------------------

/** LE PLAN d'une publication de groupes : rien n'est écrit. */
export async function planGroupExtraction(
  projectDir: string,
  source: ExtractionSource,
  input: ExtractionInput,
): Promise<ExtractionPlan> {
  const { entries } = await flowEntries(projectDir);
  return planExtraction(source, input, { taken: entries.map((entry) => entry.name) }).plan;
}

/**
 * PUBLIER des groupes d'un enregistrement : le plan est refait, puis TOUS les blocs sont écrits
 * ensemble (avec le registre), ou aucun si l'un ne passe pas sa validation.
 */
export function publishGroupExtraction(
  projectDir: string,
  source: ExtractionSource,
  input: ExtractionInput,
  author?: string,
): Promise<LibraryBlockView[]> {
  return withLock(projectDir, async () => {
    const { root, entries } = await flowEntries(projectDir);
    const { plan, drafts } = planExtraction(source, input, { taken: entries.map((entry) => entry.name) });
    if (!plan.ok) {
      const details = [
        ...plan.errors,
        ...plan.blocks.flatMap((block) =>
          block.validation.errors.map((error) => `"${block.name}": ${error}`),
        ),
      ];
      throw new LibraryError(details[0] ?? 'nothing to publish', 422, details);
    }
    const registry = await readRegistry(projectDir);
    const at = new Date().toISOString();
    const files: { file: string; content: string }[] = [];
    const folders = new Set<string>();
    for (const draft of drafts) {
      const name = draft.plan.name;
      const written = await flowFiles(root, 'library', draft.flow, draft.data);
      if (folders.has(written.relative))
        throw new LibraryError(`two blocks of this publication would be written to ${written.relative}`, 409);
      folders.add(written.relative);
      files.push(...written.files);
      const groupNames = draft.plan.groups.map((group) => group.name);
      registry.blocks[name] = {
        id: slug(name),
        version: 1,
        hash: contentHash({ startAt: draft.flow.startAt, steps: stepsOf(draft.flow) }, draft.data),
        createdAt: at,
        updatedAt: at,
        origin: {
          kind: 'recording',
          name: source.name,
          group: groupNames.join(' + '),
          groupIds: draft.groupIds,
          groups: groupNames,
          stepIds: draft.stepIds,
          selection: draft.selection,
          mode: plan.mode,
          ...(source.flow.recordingSessionId ? { sessionId: source.flow.recordingSessionId } : {}),
          revision: source.revision,
          extractedAt: at,
          ...(author ? { author } : {}),
          ...(input.navigate ? { navigate: true } : {}),
          ...(draft.plan.data.some((entry) => entry.provided)
            ? { provided: draft.plan.data.filter((entry) => entry.provided).map((entry) => entry.key) }
            : {}),
          ...(draft.plan.transformations.length > 0 ? { transformations: draft.plan.transformations } : {}),
        },
        history: [
          {
            version: 1,
            at,
            change: `extracted from the ${draft.plan.composite ? 'groups' : 'group'} "${groupNames.join('", "')}" of the recording ${source.name}`,
          },
        ],
      };
    }
    await commitFiles([...files, registryFile(projectDir, registry)]);
    const views = await listLibrary(projectDir);
    return drafts
      .map((draft) => views.find((view) => view.name === draft.plan.name))
      .filter((view): view is LibraryBlockView => view !== undefined);
  });
}

/** Ce que la source d'un bloc extrait donnerait aujourd'hui (même sélection, même navigation, mêmes valeurs fournies). */
function redraft(
  entry: FlowEntry,
  record: BlockRecord,
  source: ExtractionSource,
  data: TestDataSet | undefined,
): ExtractionDraft | { missing: string } {
  const origin = record.origin;
  const selection = origin?.selection ?? (origin?.groupIds ?? []).map((groupId) => ({ groupId }));
  const groups = new Set((source.flow.groups ?? []).map((group) => group.id));
  const gone = selection.filter((item) => !groups.has(item.groupId));
  if (selection.length === 0 || gone.length > 0)
    return {
      missing: `the group(s) ${gone.map((item) => item.groupId).join(', ') || '?'} no longer exist in ${source.name}`,
    };
  const provided = Object.fromEntries(
    (origin?.provided ?? []).flatMap((key) => {
      const value = data?.values[key]?.value;
      return value !== undefined ? [[key, value]] : [];
    }),
  );
  const description = typeof entry.flow.description === 'string' ? entry.flow.description : undefined;
  const key = origin?.mode === 'composite' ? 'composite' : (selection[0]?.groupId ?? '');
  const { drafts } = planExtraction(
    source,
    {
      selection,
      mode: origin?.mode === 'composite' ? 'composite' : 'separate',
      names: { [key]: { name: entry.name, ...(description ? { description } : {}) } },
      ...(origin?.navigate ? { navigate: true } : {}),
      provided,
    },
    { taken: [] },
  );
  const draft = drafts[0];
  return draft ?? { missing: `nothing left to extract from ${source.name}` };
}

/** COMPARER un bloc extrait d'un enregistrement avec ce que cet enregistrement donne aujourd'hui. */
export async function compareWithSource(
  projectDir: string,
  name: string,
  loadSource: (recording: string) => Promise<ExtractionSource | undefined>,
): Promise<BlockSourceComparison> {
  const { entries } = await flowEntries(projectDir);
  const entry = entries.find((candidate) => candidate.name === name && candidate.flow.reusable === true);
  if (!entry) throw new LibraryError(`no block named "${name}"`, 404);
  const record = (await readRegistry(projectDir)).blocks[name];
  const origin = record?.origin;
  if (!record || origin?.kind !== 'recording' || (!origin.groupIds && !origin.selection))
    return { block: name, status: 'NOT_FROM_RECORDING', changes: [] };
  const source = await loadSource(origin.name);
  if (!source)
    return {
      block: name,
      status: 'SOURCE_MISSING',
      recording: origin.name,
      ...(origin.revision ? { revision: { extracted: origin.revision } } : {}),
      changes: [`the recording ${origin.name} no longer exists`],
    };
  const data = await testDataOf(entry);
  const draft = redraft(entry, record, source, data);
  const revision = { ...(origin.revision ? { extracted: origin.revision } : {}), current: source.revision };
  if ('missing' in draft)
    return {
      block: name,
      status: 'SOURCE_MISSING',
      recording: origin.name,
      revision,
      changes: [draft.missing],
    };
  const { testData: _testData, ...flow } = entry.flow;
  const changes = contentChanges(
    { flow, ...(data ? { data } : {}) },
    { flow: draft.flow, ...(draft.data ? { data: draft.data } : {}) },
  );
  return {
    block: name,
    status: changes.length === 0 ? 'SAME' : 'DIFFERENT',
    recording: origin.name,
    revision,
    changes,
  };
}

/**
 * METTRE À JOUR un bloc depuis sa source, à la demande : le contenu que l'enregistrement donne
 * aujourd'hui remplace celui du bloc, qui devient CHANGED (une nouvelle version à valider) ; les
 * parcours qui le rejouent ne le suivent qu'après cette validation et leur acceptation.
 */
export function updateFromSource(
  projectDir: string,
  name: string,
  loadSource: (recording: string) => Promise<ExtractionSource | undefined>,
): Promise<LibraryBlockView> {
  return withLock(projectDir, async () => {
    const { entries } = await flowEntries(projectDir);
    const entry = entries.find((candidate) => candidate.name === name && candidate.flow.reusable === true);
    if (!entry || entry.index !== undefined) throw new LibraryError(`no block named "${name}"`, 404);
    const registry = await readRegistry(projectDir);
    const record = registry.blocks[name];
    const origin = record?.origin;
    if (!record || origin?.kind !== 'recording')
      throw new LibraryError(`"${name}" was not extracted from a recording`, 409);
    const source = await loadSource(origin.name);
    if (!source) throw new LibraryError(`the recording ${origin.name} no longer exists`, 409);
    const data = await testDataOf(entry);
    const draft = redraft(entry, record, source, data);
    if ('missing' in draft) throw new LibraryError(draft.missing, 409);
    if (!draft.plan.validation.ok)
      throw new LibraryError(
        `the content of ${origin.name} would not be a valid block: ${draft.plan.validation.errors[0] ?? ''}`,
        422,
        draft.plan.validation.errors,
      );
    const { testData: _testData, ...flow } = entry.flow;
    const changes = contentChanges(
      { flow, ...(data ? { data } : {}) },
      { flow: draft.flow, ...(draft.data ? { data: draft.data } : {}) },
    );
    if (changes.length === 0) throw new LibraryError(`"${name}" is already the same as its source`, 409);
    const directory = path.dirname(entry.file);
    const hasData = draft.data !== undefined && Object.keys(draft.data.values).length > 0;
    const { steps, ...head } = draft.flow;
    const files = [
      {
        file: entry.file,
        content: stringifyYaml(
          { ...head, ...(hasData ? { testData: 'test-data.yaml' } : {}), steps },
          { lineWidth: 0 },
        ),
      },
      ...(hasData && draft.data
        ? [
            {
              file: path.join(directory, 'test-data.yaml'),
              content: stringifyYaml(testDataSetDocument(draft.data), { lineWidth: 0 }),
            },
          ]
        : []),
    ];
    const at = new Date().toISOString();
    registry.blocks[name] = {
      ...record,
      updatedAt: at,
      origin: { ...origin, revision: source.revision, stepIds: draft.stepIds, extractedAt: at },
      history: [
        ...record.history,
        {
          version: record.version,
          at,
          change: `content taken again from the recording ${source.name} (${String(changes.length)} change(s)): validate it to make version ${String(record.version + 1)}`,
        },
      ],
    };
    await commitFiles([...files, registryFile(projectDir, registry)]);
    if (!hasData) await rm(path.join(directory, 'test-data.yaml'), { force: true });
    return blockNamed(projectDir, name);
  });
}

/** LE DÉTAIL d'un bloc : ses étapes en mots, ses groupes internes, ses données (jamais une valeur sensible). */
export async function blockDetails(projectDir: string, name: string): Promise<LibraryBlockDetails> {
  const { entries } = await flowEntries(projectDir);
  const entry = entries.find((candidate) => candidate.name === name && candidate.flow.reusable === true);
  if (!entry) throw new LibraryError(`no block named "${name}"`, 404);
  const block = await blockNamed(projectDir, name);
  const data = await testDataOf(entry).catch(() => undefined);
  const groups = (Array.isArray(entry.flow.groups) ? entry.flow.groups : [])
    .filter(isObject)
    .map((group) => ({
      id: typeof group.id === 'string' ? group.id : '',
      name: typeof group.name === 'string' ? group.name : '',
      positions: Array.isArray(group.steps)
        ? group.steps.filter((position): position is number => typeof position === 'number')
        : [],
    }));
  const groupAt = (position: number): string | undefined =>
    groups.find((group) => group.positions.includes(position))?.id;
  const stepParser = flowSchema.shape.steps.element;
  const steps: ExtractionStepView[] = stepsOf(entry.flow).map((step, index) => {
    const kind =
      typeof step.run === 'string'
        ? 'run'
        : (Object.keys(step).find(
            (key) =>
              ![
                'name',
                'effects',
                'fingerprint',
                'functionalIntent',
                'allow',
                'optional',
                'timeoutMs',
                'sourceLine',
              ].includes(key),
          ) ?? 'unknown');
    const parsed = typeof step.run === 'string' ? undefined : stepParser.safeParse(step);
    const label =
      typeof step.run === 'string'
        ? `run ${step.run}`
        : parsed?.success
          ? describeStep(parsed.data, true)
          : kind;
    const group = groupAt(index + 1);
    return { position: index + 1, kind, label, ...(group ? { groupId: group } : {}) };
  });
  return {
    block,
    steps,
    groups,
    data: Object.values(data?.values ?? {})
      .map((entry) => ({
        key: entry.key,
        // Le code de la stratégie (jamais la valeur) ; pour un secret, seulement le nom de sa variable.
        strategy: entry.sensitive ? 'CREDENTIAL_REFERENCE' : entry.strategy,
        ...(entry.sensitive || entry.strategy === 'CREDENTIAL_REFERENCE'
          ? entry.env
            ? { detail: entry.env }
            : {}
          : entry.strategy === 'GENERATE_AT_REPLAY' && entry.generator
            ? { detail: entry.generator }
            : entry.strategy === 'REFERENCE' && entry.reference
              ? { detail: entry.reference }
              : {}),
        dynamic: isDynamic(entry),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}
