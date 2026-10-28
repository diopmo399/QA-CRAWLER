import { createHash } from 'node:crypto';
import type { TestDataEntry, TestDataSet } from '../../data/test-data-set.js';
import type {
  BlockContract,
  BlockState,
  CompositionCheck,
  CompositionCheckBlock,
  DeclaredContract,
} from '../core/contracts.js';

/**
 * LE CONTRAT D'UN BLOC ET LA VÉRIFICATION D'UNE COMPOSITION : des fonctions pures, sans fichier.
 *
 * Un bloc lit et saisit des données de test : `{ testData: clé }` (saisie dans un champ) et
 * `${testData:clé}` (citée, par exemple dans une vérification). Son jeu de données définit certaines
 * clés. Sans déclaration, son contrat est DÉRIVÉ de ce contenu :
 *   - sorties : les clés qu'il saisit à partir de son propre jeu (l'application les détient ensuite) ;
 *   - entrées obligatoires : les clés qu'il saisit ou cite sans les définir (un bloc précédent ou le jeu
 *     du scénario doit les fournir).
 * Un contrat DÉCLARÉ (entrées obligatoires ou facultatives, sorties, préconditions, postconditions) est
 * comparé à ce contenu : il ne peut pas promettre une sortie que le bloc ne saisit pas, ni taire une
 * entrée qu'il lit. Une vérification réussie au rejeu n'est jamais supposée : on ne vérifie ici que la
 * définition du parcours, sans rien exécuter.
 */

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Les stratégies dont la valeur est résolue au rejeu (jamais une valeur enregistrée). */
const DYNAMIC = new Set<TestDataEntry['strategy']>([
  'GENERATE_AT_REPLAY',
  'TEMPLATE',
  'REFERENCE',
  'CREDENTIAL_REFERENCE',
  'PRESERVE_EXISTING',
]);

export const isDynamic = (entry: TestDataEntry): boolean => DYNAMIC.has(entry.strategy);

/** Les clés saisies ({ testData: clé }) et citées (${testData:clé}) par des étapes. */
export function dataUse(steps: readonly unknown[]): { fills: string[]; cites: string[] } {
  const fills = new Set<string>();
  const cites = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\$\{testData:([^}]+)\}/g)) if (match[1]) cites.add(match[1].trim());
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.testData === 'string' && Object.keys(node).length === 1) fills.add(node.testData);
    Object.values(node).forEach(visit);
  };
  steps.forEach(visit);
  return { fills: [...fills].sort(), cites: [...cites].sort() };
}

/** Le contenu exécutable d'un bloc, pour en tirer une empreinte stable (version vérifiable). */
export function contentHash(
  flow: { startAt?: unknown; steps: readonly unknown[] },
  data?: TestDataSet,
): string {
  const values = Object.fromEntries(
    Object.entries(data?.values ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, comparable(entry)]),
  );
  return createHash('sha256')
    .update(JSON.stringify({ startAt: flow.startAt ?? null, steps: flow.steps, values }))
    .digest('hex')
    .slice(0, 16);
}

/** Une donnée sans sa provenance : deux définitions sont identiques si ceci l'est. */
export function comparable(entry: TestDataEntry): string {
  const { provenance: _provenance, key: _key, ...rest } = entry;
  return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
}

/** Une définition en mots, pour expliquer un conflit (jamais une valeur sensible). */
export function describeEntry(entry: TestDataEntry): string {
  if (entry.sensitive || entry.strategy === 'CREDENTIAL_REFERENCE') return `secret (${entry.env ?? 'env'})`;
  switch (entry.strategy) {
    case 'GENERATE_AT_REPLAY':
      return `generated at replay (${entry.generator ?? 'value'})`;
    case 'TEMPLATE':
      return `template "${entry.template ?? ''}"`;
    case 'REFERENCE':
      return `reference to ${entry.reference ?? '?'}`;
    case 'PRESERVE_EXISTING':
      return 'existing value kept';
    default:
      return `fixed value "${entry.value ?? ''}"`;
  }
}

export interface BlockContent {
  name: string;
  steps: readonly unknown[];
  data?: TestDataSet;
  declared?: DeclaredContract;
}

/** Le contrat effectif d'un bloc (déclaré ou dérivé) et ce qui le contredit. */
export function contractOf(block: BlockContent): { contract: BlockContract; problems: string[] } {
  const { fills, cites } = dataUse(block.steps);
  const own = block.data?.values ?? {};
  const defined = new Set(Object.keys(own));
  const references = Object.values(own)
    .filter((entry) => entry.strategy === 'REFERENCE' && entry.reference && !defined.has(entry.reference))
    .map((entry) => entry.reference as string);
  const produced = fills.filter((key) => defined.has(key));
  const needed = [...new Set([...fills, ...cites, ...references])].filter((key) => !defined.has(key)).sort();
  const dynamicOutput = (key: string): boolean => {
    const entry = own[key];
    return entry !== undefined && isDynamic(entry);
  };
  if (!block.declared)
    return {
      contract: {
        source: 'DERIVED',
        inputs: needed.map((key) => ({ key, required: true })),
        outputs: produced.map((key) => ({ key, dynamic: dynamicOutput(key) })),
        preconditions: [],
        postconditions: [],
      },
      problems: [],
    };
  const declared = block.declared;
  const problems: string[] = [];
  const declaredInputs = new Set(declared.inputs.map((input) => input.key));
  for (const key of needed)
    if (!declaredInputs.has(key)) problems.push(`uses ${key} without declaring it as an input`);
  for (const output of declared.outputs)
    if (!produced.includes(output))
      problems.push(`declares the output ${output} but does not type it from its own data`);
  for (const input of declared.inputs)
    if (defined.has(input.key)) problems.push(`declares the input ${input.key} but defines it itself`);
  return {
    contract: {
      source: 'DECLARED',
      inputs: declared.inputs.map((input) => ({ key: input.key, required: input.required })),
      outputs: declared.outputs.map((key) => ({ key, dynamic: dynamicOutput(key) })),
      preconditions: [...declared.preconditions],
      postconditions: [...declared.postconditions],
    },
    problems,
  };
}

export interface DataConflict {
  key: string;
  blocks: string[];
  detail: string;
}

/**
 * Réunit des jeux de données dans l'ordre, sans jamais écraser : une clé définie à l'identique est
 * partagée ; définie autrement (valeur, générateur, ou valeur fixe face à une valeur générée au rejeu),
 * c'est un conflit, nommé avec ses deux sources. Rien n'est réuni quand il y a un conflit.
 */
export function mergeData(
  sets: readonly { from: string; data?: TestDataSet }[],
  name: string,
): { merged?: TestDataSet; conflicts: DataConflict[]; shared: { key: string; blocks: string[] }[] } {
  const values: Record<string, TestDataEntry> = {};
  const owners: Record<string, string[]> = {};
  const conflicts: DataConflict[] = [];
  let base: TestDataSet | undefined;
  for (const { from, data } of sets) {
    if (!data) continue;
    base ??= data;
    for (const [key, entry] of Object.entries(data.values)) {
      const current = values[key];
      if (!current) {
        values[key] = entry;
        owners[key] = [from];
        continue;
      }
      if (comparable(current) === comparable(entry)) {
        if (!owners[key]?.includes(from)) owners[key]?.push(from);
        continue;
      }
      const first = owners[key]?.[0] ?? '?';
      if (!conflicts.some((conflict) => conflict.key === key && conflict.blocks.includes(from)))
        conflicts.push({
          key,
          blocks: [first, from],
          detail: `${key}: ${describeEntry(current)} in "${first}", ${describeEntry(entry)} in "${from}"`,
        });
    }
  }
  const shared = Object.entries(owners)
    .filter(([, list]) => list.length > 1)
    .map(([key, blocks]) => ({ key, blocks }));
  if (conflicts.length > 0 || !base) return { conflicts, shared };
  return { merged: { ...base, name, values }, conflicts, shared };
}

export interface CompositionPart {
  name: string;
  /** Absent : aucun bloc de ce nom. */
  block?: {
    reusable: boolean;
    version: number;
    state: BlockState;
    steps: number;
    contract: BlockContract;
    problems: string[];
    data?: TestDataSet;
  };
}

/**
 * LA VÉRIFICATION D'UN PARCOURS (dry run de composition, rien n'est exécuté) : l'ordre, les dépendances
 * entre blocs (une sortie consommée par un bloc suivant), les entrées manquantes, les conflits de données,
 * les erreurs de structure et les avertissements.
 */
export function checkComposition(input: {
  name: string;
  parts: readonly CompositionPart[];
  /** Les noms déjà pris (scénarios et blocs). */
  taken: readonly string[];
  /** Le jeu du scénario qui reçoit les blocs (insertion), disponible pour tous. */
  base?: { from: string; data?: TestDataSet; produces?: readonly string[] };
  nameRequired?: boolean;
}): CompositionCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (input.nameRequired !== false) {
    if (!name || name.length > 80) errors.push('a name of 1 to 80 characters is required');
    else if (input.taken.includes(name)) errors.push(`a scenario or a block is already named "${name}"`);
  }
  if (input.parts.length === 0) errors.push('choose at least one block');
  if (input.parts.length > 30) errors.push('choose 30 blocks at most');

  const { merged, conflicts, shared } = mergeData(
    [
      ...(input.base ? [{ from: input.base.from, data: input.base.data }] : []),
      ...input.parts.map((part) => ({ from: part.name, data: part.block?.data })),
    ],
    name || 'composition',
  );
  const available = new Set([
    ...Object.keys(input.base?.data?.values ?? {}),
    ...input.parts.flatMap((part) => Object.keys(part.block?.data?.values ?? {})),
  ]);
  const baseProduces = new Set(input.base?.produces ?? []);
  const dependencies: CompositionCheck['dependencies'] = [];
  const missing: CompositionCheck['missing'] = [];
  const order: CompositionCheckBlock[] = input.parts.map((part, index) => {
    const position = index + 1;
    const block = part.block;
    if (!block) {
      errors.push(`#${String(position)} "${part.name}": no block has this name`);
      return { position, block: part.name, steps: 0, inputs: [], outputs: [], satisfied: [], missing: [] };
    }
    if (!block.reusable)
      errors.push(`#${String(position)} "${part.name}" is a scenario: add it to the library first`);
    if (block.state === 'INVALID')
      errors.push(
        `#${String(position)} "${part.name}": its contract does not hold (${block.problems.join('; ')})`,
      );
    if (block.state === 'CHANGED')
      warnings.push(
        `#${String(position)} "${part.name}" changed since its version ${String(block.version)}: validate the new version first`,
      );
    const satisfied: CompositionCheckBlock['satisfied'] = [];
    const lacking: string[] = [];
    for (const wanted of block.contract.inputs) {
      const producer = input.parts.findIndex(
        (other, at) =>
          at < index && other.block?.contract.outputs.some((output) => output.key === wanted.key),
      );
      if (producer >= 0) {
        satisfied.push({ key: wanted.key, from: producer + 1 });
        dependencies.push({ key: wanted.key, from: producer + 1, to: position });
        continue;
      }
      if (baseProduces.has(wanted.key)) {
        satisfied.push({ key: wanted.key, from: 'scenario' });
        continue;
      }
      const later = input.parts.findIndex(
        (other, at) =>
          at > index && other.block?.contract.outputs.some((output) => output.key === wanted.key),
      );
      if (later >= 0) {
        if (wanted.required) {
          errors.push(
            `#${String(position)} "${part.name}" needs ${wanted.key}, produced only later by #${String(later + 1)}`,
          );
          lacking.push(wanted.key);
        }
        continue;
      }
      if (available.has(wanted.key)) {
        satisfied.push({ key: wanted.key, from: 'data' });
        continue;
      }
      if (wanted.required) {
        lacking.push(wanted.key);
        missing.push({ key: wanted.key, block: part.name, position });
      } else
        warnings.push(
          `#${String(position)} "${part.name}": the optional input ${wanted.key} is not provided`,
        );
    }
    return {
      position,
      block: part.name,
      version: block.version,
      state: block.state,
      steps: block.steps,
      inputs: block.contract.inputs,
      outputs: block.contract.outputs,
      satisfied,
      missing: lacking,
    };
  });
  for (const entry of missing)
    errors.push(
      `#${String(entry.position)} "${entry.block}" needs ${entry.key}: no earlier block produces it and no test data defines it`,
    );
  for (const conflict of conflicts)
    errors.push(`test data ${conflict.detail}: rename it in one of them first`);
  const dynamic = Object.values(merged?.values ?? {})
    .filter(isDynamic)
    .map((entry) => entry.key)
    .sort();
  return {
    ok: errors.length === 0,
    name,
    blocks: input.parts.length,
    steps: order.reduce((sum, entry) => sum + entry.steps, 0),
    order,
    dependencies,
    missing,
    conflicts,
    shared,
    dynamic,
    errors,
    warnings,
  };
}
