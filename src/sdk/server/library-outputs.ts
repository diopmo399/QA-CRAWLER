import { stringify as stringifyYaml } from 'yaml';
import { DATA_KEY_PATTERN, SECRET_KEY_PATTERN } from '../../config/flow-schema.js';
import {
  DATA_TYPES,
  OUTPUT_GENERATORS,
  OUTPUT_SOURCES,
  OUTPUT_TRANSFORMS,
  type BlockOutputInput,
  type LibraryBlockView,
} from '../core/contracts.js';
import {
  blockNamed,
  blocksOf,
  commitFiles,
  flowEntries,
  keysUsedBy,
  LibraryError,
  readRegistry,
  registryFile,
  stepsOf,
  withLock,
  withTakenOver,
  type BlockRecord,
} from './library.js';
import { validateBlockFlow } from './library-extract.js';
import { dataUse } from './library-contract.js';
import { fieldKey, type StoredFields } from './library-fields.js';

/**
 * AJOUTER UNE SORTIE À UN BLOC (voir OUTPUT_SOURCES) : une étape `capture` exécutable est insérée dans le
 * fichier du bloc, à la position choisie, et la sortie est décrite (libellé, sens, type) dans le registre.
 * Jamais une simple déclaration : sans étape qui la produit, il n'y a pas de sortie. Le bloc passe à CHANGED ;
 * sa version suivante n'existe qu'une fois validée explicitement (les parcours gardent la version retenue).
 */

type Raw = Record<string, unknown>;
const TEXT_MAX = 300;
const clean = (value: unknown, max = TEXT_MAX): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
};

/** La demande reçue (JSON), contrôlée champ par champ. */
export function sanitizeOutput(raw: unknown): BlockOutputInput {
  const value = typeof raw === 'object' && raw !== null ? (raw as Raw) : {};
  const key = clean(value.key, 120);
  if (!key || !DATA_KEY_PATTERN.test(key))
    throw new LibraryError('key: a data key (letters, digits, _ and -, parts joined by dots)', 400);
  if (SECRET_KEY_PATTERN.test(key))
    throw new LibraryError(`${key} looks like a secret: a secret is never an output`, 422);
  const source = OUTPUT_SOURCES.find((candidate) => candidate === value.source);
  if (!source) throw new LibraryError(`source: one of ${OUTPUT_SOURCES.join(', ')}`, 400);
  const type = DATA_TYPES.find((candidate) => candidate === value.type);
  const transform = OUTPUT_TRANSFORMS.find((candidate) => candidate === value.transform);
  const text = (name: string, max?: number): Partial<BlockOutputInput> => {
    const found = clean(value[name], max);
    return found ? { [name]: found } : {};
  };
  return {
    key,
    source,
    ...text('label', 120),
    ...text('description', 500),
    ...text('meaning', 200),
    ...(type ? { type } : {}),
    ...(typeof value.after === 'number' && Number.isInteger(value.after) ? { after: value.after } : {}),
    ...text('generator', 40),
    ...text('selector'),
    ...text('testId', 120),
    ...text('attribute', 80),
    ...text('pattern'),
    ...text('param', 80),
    ...text('method', 10),
    ...text('url'),
    ...text('field', 120),
    ...text('from', 120),
    ...(transform ? { transform } : {}),
  };
}

/** L'étape `capture` qui produit la sortie (refus expliqué si la source est incomplète). */
export function outputStep(input: BlockOutputInput, known: ReadonlySet<string>): Raw {
  const target = (): Raw => {
    if (input.testId) return { testId: input.testId };
    if (input.selector) return { css: input.selector };
    throw new LibraryError('the element: a CSS selector or a test id', 422);
  };
  const pattern = input.pattern !== undefined ? { pattern: input.pattern } : {};
  let capture: Raw;
  switch (input.source) {
    case 'GENERATED': {
      const generator = OUTPUT_GENERATORS.find((candidate) => candidate === input.generator);
      if (!generator) throw new LibraryError(`generator: one of ${OUTPUT_GENERATORS.join(', ')}`, 422);
      capture = { as: input.key, generate: generator };
      break;
    }
    case 'DOM_TEXT':
      capture = { as: input.key, text: target(), ...pattern };
      break;
    case 'DOM_ATTRIBUTE':
      if (!input.attribute) throw new LibraryError('the attribute to read (href, value, data-id…)', 422);
      capture = { as: input.key, attribute: { ...target(), attribute: input.attribute }, ...pattern };
      break;
    case 'URL':
      if (!input.param && !input.pattern)
        throw new LibraryError('the address: a parameter name, or a pattern with a group', 422);
      capture = {
        as: input.key,
        url: {
          ...(input.param ? { param: input.param } : {}),
          ...(input.pattern ? { pattern: input.pattern } : {}),
        },
      };
      break;
    case 'RESPONSE':
      if (!input.url || !input.field)
        throw new LibraryError('the observed request (address) and the field to read', 422);
      capture = {
        as: input.key,
        response: {
          ...(input.method ? { method: input.method.toUpperCase() } : {}),
          url: input.url,
          field: input.field,
        },
      };
      break;
    case 'INPUT':
      if (!input.from || !known.has(input.from))
        throw new LibraryError(
          `from: an input or a data of the block (${[...known].sort().join(', ')})`,
          422,
        );
      if (input.from === input.key) throw new LibraryError('the output needs its own key', 422);
      capture = { as: input.key, data: input.from };
      break;
  }
  return {
    name: input.label ?? `Sortie ${input.key}`,
    capture: { ...capture, ...(input.transform ? { transform: input.transform } : {}) },
  };
}

export function addBlockOutput(projectDir: string, name: string, raw: unknown): Promise<LibraryBlockView> {
  return withLock(projectDir, async () => {
    const input = sanitizeOutput(raw);
    const { entries } = await flowEntries(projectDir);
    const entry = entries.find((candidate) => candidate.name === name && candidate.flow.reusable === true);
    if (!entry) throw new LibraryError(`no block named "${name}"`, 404);
    if (entry.index !== undefined)
      throw new LibraryError(`"${name}" shares its file with other flows: edit it in the editor`, 409);
    const registry = await readRegistry(projectDir);
    const blocks = await blocksOf(entries, registry);
    const block = blocks.get(name);
    if (!block) throw new LibraryError(`no block named "${name}"`, 404);
    const steps = stepsOf(entry.flow);
    const after = input.after ?? steps.length;
    if (after < 0 || after > steps.length)
      throw new LibraryError(`after is a position between 0 and ${String(steps.length)}`, 400);
    // Une clé déjà connue du bloc (entrée, sortie, donnée de son jeu) n'est jamais réécrite.
    const taken = new Set([
      ...block.view.data.map((item) => item.key),
      ...block.view.contract.inputs.map((item) => item.key),
      ...block.view.contract.outputs.map((item) => item.key),
      ...dataUse(steps).captures,
    ]);
    if (taken.has(input.key))
      throw new LibraryError(`${input.key} already exists in "${name}": choose another key`, 409);
    // Une entrée transmise doit être connue AVANT l'étape : une entrée du contrat, ou une donnée déjà saisie.
    const known = new Set([
      ...block.view.contract.inputs.map((item) => item.key),
      ...block.view.data.filter((item) => !item.dynamic).map((item) => item.key),
      ...keysUsedBy(steps.slice(0, after)),
      ...dataUse(steps.slice(0, after)).captures,
    ]);
    const step = outputStep(input, known);
    const groups = Array.isArray(entry.flow.groups)
      ? entry.flow.groups.map((group): unknown =>
          typeof group === 'object' && group !== null && Array.isArray((group as Raw).steps)
            ? {
                ...(group as Raw),
                steps: ((group as Raw).steps as unknown[]).map((position) =>
                  typeof position === 'number' && position > after ? position + 1 : position,
                ),
              }
            : group,
        )
      : undefined;
    const flow: Raw = {
      ...entry.flow,
      steps: [...steps.slice(0, after), step, ...steps.slice(after)],
      ...(groups ? { groups } : {}),
    };
    const invalid = validateBlockFlow(flow, block.data);
    if (invalid.length > 0)
      throw new LibraryError(`the output does not hold: ${invalid[0] ?? ''}`, 422, invalid);
    const next = withTakenOver(registry, blocks);
    const record = next.blocks[name] as BlockRecord;
    const at = new Date().toISOString();
    const fields: StoredFields = {
      ...(record.fields ?? {}),
      [fieldKey('output', input.key)]: {
        version: 1,
        confirmed: true,
        ...(input.label ? { label: input.label } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.meaning ? { meaning: input.meaning } : {}),
        ...(input.type ? { type: input.type } : {}),
      },
    };
    next.blocks[name] = {
      ...record,
      fields,
      updatedAt: at,
      history: [
        ...record.history,
        {
          version: record.version,
          at,
          change: `output ${input.key} added (${input.source.toLowerCase()}) after step ${String(after)}: validate it to make version ${String(record.version + 1)}`,
        },
      ],
    };
    await commitFiles([
      { file: entry.file, content: stringifyYaml(flow, { lineWidth: 0 }) },
      registryFile(projectDir, next),
    ]);
    return blockNamed(projectDir, name);
  });
}
