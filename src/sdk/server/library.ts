import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
import { parseTestDataSet, testDataSetDocument, type TestDataSet } from '../../data/test-data-set.js';
import { slug } from '../../knowledge/signatures.js';
import type { ComposeScenarioInput, LibraryBlockView } from '../core/contracts.js';
import { flowsDirOf } from './platform.js';

/**
 * LA BIBLIOTHÈQUE DE SCÉNARIOS : des parcours réutilisables. Un bloc est un flow `reusable: true`
 * (jamais exécuté seul) que d'autres scénarios rejouent par une étape `run: <nom>` ; le moteur recopie
 * ses étapes à cet endroit (src/flows/flow-includes.ts). Un bloc vient d'un scénario ou d'un groupe
 * métier d'un enregistrement ; il s'insère dans un scénario existant ou compose un nouveau parcours.
 * Ses données de test suivent : elles rejoignent le jeu du scénario qui le rejoue, et une donnée
 * définie autrement des deux côtés est refusée (jamais écrasée).
 *
 *   <flows>/library/<bloc>/<bloc>.flow.yaml     le bloc (reusable: true) et son test-data.yaml
 *   <flows>/composed/<nom>/<nom>.flow.yaml      un parcours composé de blocs (steps: - run: …)
 *   <projet>/sdk-library.json                   l'origine de chaque bloc (scénario, enregistrement)
 */
export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422,
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

const LIBRARY_FILE = 'sdk-library.json';
const NAME_MAX = 80;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

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

/** Les données saisies ({ testData: clé }) et citées (${testData:clé}) par des étapes. */
function dataOf(steps: readonly Raw[]): { inputs: string[]; citations: string[] } {
  const inputs = new Set<string>();
  const citations = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\$\{testData:([^}]+)\}/g))
        if (match[1]) citations.add(match[1].trim());
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.testData === 'string' && Object.keys(node).length === 1) inputs.add(node.testData);
    Object.values(node).forEach(visit);
  };
  steps.forEach(visit);
  return { inputs: [...inputs].sort(), citations: [...citations].sort() };
}

async function origins(projectDir: string): Promise<Record<string, LibraryBlockView['origin']>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDir, LIBRARY_FILE), 'utf8')) as {
      origins?: Record<string, LibraryBlockView['origin']>;
    };
    return parsed.origins ?? {};
  } catch {
    return {};
  }
}

async function saveOrigin(
  projectDir: string,
  name: string,
  origin: LibraryBlockView['origin'] | undefined,
): Promise<void> {
  const all = Object.fromEntries(Object.entries(await origins(projectDir)).filter(([key]) => key !== name));
  if (origin) all[name] = origin;
  await writeFile(
    path.join(projectDir, LIBRARY_FILE),
    `${JSON.stringify({ origins: all }, null, 2)}\n`,
    'utf8',
  );
}

/** Les blocs de la bibliothèque, avec leurs données et les scénarios qui les rejouent. */
export async function listLibrary(projectDir: string): Promise<LibraryBlockView[]> {
  const { entries } = await flowEntries(projectDir);
  const known = await origins(projectDir);
  return entries
    .filter((entry) => entry.flow.reusable === true)
    .map((entry) => {
      const origin = known[entry.name];
      return {
        name: entry.name,
        file: entry.relative,
        steps: stepsOf(entry.flow).length,
        ...(typeof entry.flow.startAt === 'string' ? { startAt: entry.flow.startAt } : {}),
        ...(typeof entry.flow.description === 'string' ? { description: entry.flow.description } : {}),
        ...(origin ? { origin } : {}),
        ...dataOf(stepsOf(entry.flow)),
        usedBy: entries.filter((other) => runsOf(other.flow).includes(entry.name)).map((other) => other.name),
      };
    });
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

const comparable = (entry: TestDataSet['values'][string]): string => {
  const { provenance: _provenance, ...rest } = entry;
  return JSON.stringify(rest);
};

/** Les données du bloc rejoignent le jeu ; une donnée définie autrement des deux côtés est refusée. */
function mergeSets(
  target: TestDataSet | undefined,
  extra: TestDataSet,
  from: string,
  name: string,
): TestDataSet {
  const values = { ...(target?.values ?? {}) };
  for (const [key, entry] of Object.entries(extra.values)) {
    const current = values[key];
    if (current && comparable(current) !== comparable(entry))
      throw new LibraryError(
        `the test data ${key} is defined differently in "${from}": rename it in one of them first`,
        409,
      );
    values[key] = entry;
  }
  return { ...(target ?? { ...extra, name }), values };
}

function freeName(entries: readonly FlowEntry[], raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > NAME_MAX || !slug(name))
    throw new LibraryError(`a name of 1 to ${String(NAME_MAX)} characters is required`, 400);
  if (entries.some((entry) => entry.name === name))
    throw new LibraryError(`a scenario or a block is already named "${name}"`, 409);
  return name;
}

/** Écrit un flow dans <flows>/<dossier>/<nom>/, avec son jeu de données ; jamais par-dessus un autre. */
async function writeFlow(
  root: string,
  folder: string,
  flow: Raw,
  data: TestDataSet | undefined,
): Promise<string> {
  const base = slug(String(flow.name));
  const directory = path.join(root, folder, base);
  if (await exists(directory)) throw new LibraryError(`${folder}/${base} already exists`, 409);
  await mkdir(directory, { recursive: true });
  const hasData = data !== undefined && Object.keys(data.values).length > 0;
  if (hasData)
    await writeFile(
      path.join(directory, 'test-data.yaml'),
      stringifyYaml(testDataSetDocument(data), { lineWidth: 0 }),
      'utf8',
    );
  const { steps, ...head } = flow;
  await writeFile(
    path.join(directory, `${base}.flow.yaml`),
    stringifyYaml({ ...head, ...(hasData ? { testData: 'test-data.yaml' } : {}), steps }, { lineWidth: 0 }),
    'utf8',
  );
  return `${folder}/${base}/${base}.flow.yaml`;
}

/** Un scénario devient un bloc de la bibliothèque (ses étapes et ses données sont recopiées). */
export async function addScenarioToLibrary(
  projectDir: string,
  input: { scenario: string; name: string; description?: string },
): Promise<LibraryBlockView> {
  const { root, entries } = await flowEntries(projectDir);
  const source = entries.find((entry) => entry.name === input.scenario);
  if (!source) throw new LibraryError(`no scenario named "${input.scenario}"`, 404);
  const name = freeName(entries, input.name);
  const steps = stepsOf(source.flow);
  if (steps.length === 0) throw new LibraryError(`"${input.scenario}" has no step`, 422);
  await writeFlow(
    root,
    'library',
    {
      name,
      ...(input.description ? { description: input.description } : {}),
      reusable: true,
      ...(typeof source.flow.startAt === 'string' ? { startAt: source.flow.startAt } : {}),
      steps,
    },
    await testDataOf(source),
  );
  await saveOrigin(projectDir, name, { kind: 'scenario', name: input.scenario });
  return blockNamed(projectDir, name);
}

/** Un groupe métier d'un enregistrement devient un bloc (ses étapes, telles que dans le flow généré). */
export async function addGroupToLibrary(
  projectDir: string,
  recording: { directory: string; name: string },
  input: { groupId: string; name: string; startAt?: string; description?: string },
): Promise<LibraryBlockView> {
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
  await writeFlow(
    root,
    'library',
    {
      name,
      ...(input.description ? { description: input.description } : {}),
      reusable: true,
      ...(input.startAt ? { startAt: input.startAt } : {}),
      steps,
    },
    data,
  );
  await saveOrigin(projectDir, name, {
    kind: 'recording',
    name: recording.name,
    group: typeof group.name === 'string' ? group.name : input.groupId,
  });
  return blockNamed(projectDir, name);
}

async function blockNamed(projectDir: string, name: string): Promise<LibraryBlockView> {
  const block = (await listLibrary(projectDir)).find((entry) => entry.name === name);
  if (!block) throw new LibraryError(`the block "${name}" could not be read back`, 422);
  return block;
}

/** Retire un bloc de la bibliothèque ; refusé tant qu'un scénario le rejoue. */
export async function removeFromLibrary(projectDir: string, name: string): Promise<void> {
  const { root, entries } = await flowEntries(projectDir);
  const entry = entries.find((candidate) => candidate.name === name && candidate.flow.reusable === true);
  if (!entry) throw new LibraryError(`no block named "${name}"`, 404);
  const users = entries.filter((other) => runsOf(other.flow).includes(name)).map((other) => other.name);
  if (users.length > 0)
    throw new LibraryError(`"${name}" is used by ${users.map((user) => `"${user}"`).join(', ')}`, 409);
  const directory = path.dirname(entry.file);
  if (path.dirname(directory) !== path.join(root, 'library') || entry.index !== undefined)
    throw new LibraryError(`"${name}" was not created by the library: edit ${entry.relative} instead`, 409);
  await rm(directory, { recursive: true, force: true });
  await saveOrigin(projectDir, name, undefined);
}

/** Un nouveau scénario fait de blocs, rejoués dans l'ordre ; leurs données se réunissent. */
export async function composeScenario(projectDir: string, input: ComposeScenarioInput): Promise<string> {
  const { root, entries } = await flowEntries(projectDir);
  const name = freeName(entries, input.name);
  if (!Array.isArray(input.parts) || input.parts.length === 0 || input.parts.length > 30)
    throw new LibraryError('choose 1 to 30 blocks or scenarios', 400);
  let data: TestDataSet | undefined;
  let startAt: string | undefined;
  for (const [index, part] of input.parts.entries()) {
    const entry = entries.find((candidate) => candidate.name === part);
    if (!entry) throw new LibraryError(`no block named "${part}"`, 404);
    // Seul un bloc suit toujours le parcours qui le rejoue ; un scénario se met d'abord en bibliothèque.
    if (entry.flow.reusable !== true)
      throw new LibraryError(
        `"${part}" is a scenario: add it to the library first, then compose with it`,
        422,
      );
    if (index === 0 && typeof entry.flow.startAt === 'string') startAt = entry.flow.startAt;
    const set = await testDataOf(entry);
    if (set) data = mergeSets(data, set, part, name);
  }
  return writeFlow(
    root,
    'composed',
    {
      name,
      ...(input.description ? { description: input.description } : {}),
      ...(startAt ? { startAt } : {}),
      steps: input.parts.map((part) => ({ run: part })),
    },
    data,
  );
}

/** Insère un bloc au début ou à la fin d'un scénario (`run:`) ; ses données rejoignent le jeu du scénario. */
export async function insertBlock(
  projectDir: string,
  scenario: string,
  input: { block: string; at: 'start' | 'end' },
): Promise<void> {
  const { entries } = await flowEntries(projectDir);
  const target = entries.find((entry) => entry.name === scenario);
  if (!target) throw new LibraryError(`no scenario named "${scenario}"`, 404);
  const block = entries.find((entry) => entry.name === input.block && entry.flow.reusable === true);
  if (!block) throw new LibraryError(`no block named "${input.block}"`, 404);
  if (block.name === target.name || runsOf(block.flow).includes(target.name))
    throw new LibraryError(`"${input.block}" already replays "${scenario}": that would loop`, 409);
  const document = parseDocument(await readFile(target.file, 'utf8'));
  const node = target.index !== undefined ? document.getIn(['flows', target.index]) : document.contents;
  if (!isMap(node)) throw new LibraryError(`"${scenario}" cannot be edited`, 422);
  const steps = node.get('steps');
  if (!isSeq(steps)) throw new LibraryError(`"${scenario}" has no steps`, 422);
  const blockData = await testDataOf(block);
  if (blockData && Object.keys(blockData.values).length > 0) {
    const current = node.get('testData');
    if (current !== undefined && typeof current !== 'string')
      throw new LibraryError(`"${scenario}" writes its test data inline: move it to a file first`, 422);
    const file =
      typeof current === 'string'
        ? path.resolve(path.dirname(target.file), current)
        : path.join(path.dirname(target.file), `${slug(scenario)}.test-data.yaml`);
    const existing = (await exists(file))
      ? parseTestDataSet(parseYaml(await readFile(file, 'utf8')), scenario)
      : undefined;
    const merged = mergeSets(existing, blockData, input.block, scenario);
    await writeFile(file, stringifyYaml(testDataSetDocument(merged), { lineWidth: 0 }), 'utf8');
    if (typeof current !== 'string') node.set('testData', path.basename(file));
  }
  const step = document.createNode({ run: input.block });
  if (input.at === 'start') steps.items.unshift(step);
  else steps.items.push(step);
  await writeFile(target.file, document.toString({ lineWidth: 0 }), 'utf8');
}
