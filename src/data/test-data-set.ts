import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * TEST DATA SET : les données d'un flow, séparées de sa logique. Le flow dit QUOI faire
 * (`fill … value: { testData: request.title }`), le jeu de données dit AVEC QUOI :
 *
 *   values:
 *     request:
 *       title:        { strategy: recorded, value: "Imprimante bureau" }
 *       contactEmail: { strategy: generated, generator: email }
 *       requestType:  { strategy: literal, value: INCIDENT }
 *       confirmEmail: { strategy: reference, reference: request.contactEmail }
 *
 * Le même fichier sert au flow YAML (`testData: test-data.yaml`) et au .feature
 * (`# testData: test-data.yaml`) : un seul jeu de données. Une valeur sensible (mot de
 * passe, code, jeton) n'y est JAMAIS écrite en clair : `{ strategy: credential, env: … }`.
 */

/** Stratégies au rejeu (vocabulaire du modèle). */
export const TEST_DATA_STRATEGIES = [
  'RECORDED_LITERAL',
  'GENERATE_AT_REPLAY',
  'BUSINESS_LITERAL',
  'CREDENTIAL_REFERENCE',
  'PRESERVE_EXISTING',
  'REFERENCE',
  'TEMPLATE',
] as const;
export type TestDataStrategy = (typeof TEST_DATA_STRATEGIES)[number];

/** Les mêmes stratégies, telles qu'on les écrit dans un fichier de données. */
export const STRATEGY_WORDS: Readonly<Record<string, TestDataStrategy>> = {
  recorded: 'RECORDED_LITERAL',
  generated: 'GENERATE_AT_REPLAY',
  literal: 'BUSINESS_LITERAL',
  credential: 'CREDENTIAL_REFERENCE',
  preserve: 'PRESERVE_EXISTING',
  reference: 'REFERENCE',
  template: 'TEMPLATE',
};

export function strategyWord(strategy: TestDataStrategy): string {
  return Object.entries(STRATEGY_WORDS).find(([, value]) => value === strategy)?.[0] ?? 'recorded';
}

export interface TestDataProvenance {
  recordingSessionId?: string;
  /** Champ sémantique (email, firstName…) ou nom du champ. */
  semanticField?: string;
  rawEventIds?: string[];
  classification?: string;
  reasons?: string[];
}

/** Une donnée du jeu (clé à points : request.title). */
export interface TestDataEntry {
  key: string;
  strategy: TestDataStrategy;
  value?: string;
  /** GENERATE_AT_REPLAY : le générateur (email, firstName, phone, text, unique…). */
  generator?: string;
  /** CREDENTIAL_REFERENCE : la variable d'environnement (CredentialProvider). */
  env?: string;
  /** REFERENCE : la clé d'une autre donnée (confirmEmail → request.email). */
  reference?: string;
  /** TEMPLATE : « QA ${runId} » (variables : runId, timestamp, random). */
  template?: string;
  semanticType?: string;
  sensitive: boolean;
  provenance?: TestDataProvenance;
}

export interface TestDataSet {
  id: string;
  name: string;
  source: 'HUMAN_RECORDING' | 'GENERATED' | 'MANUAL' | 'MIXED';
  recordingSessionId?: string;
  createdAt?: string;
  /** Clés aplaties (request.title). */
  values: Record<string, TestDataEntry>;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

const entrySchema = z
  .object({
    // Le mot du fichier (recorded) ou, pour un jeu déjà chargé, le nom du modèle (RECORDED_LITERAL).
    strategy: z.enum(['recorded', ...Object.keys(STRATEGY_WORDS), ...TEST_DATA_STRATEGIES]),
    key: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).transform(String).optional(),
    generator: z.string().trim().min(1).optional(),
    env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    reference: z.string().regex(KEY).optional(),
    template: z.string().min(1).optional(),
    semanticType: z.string().optional(),
    sensitive: z.boolean().optional(),
    provenance: z
      .object({
        recordingSessionId: z.string().optional(),
        semanticField: z.string().optional(),
        rawEventIds: z.array(z.string()).optional(),
        classification: z.string().optional(),
        reasons: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const need: Record<string, keyof typeof entry> = {
      recorded: 'value',
      literal: 'value',
      credential: 'env',
      reference: 'reference',
      template: 'template',
      RECORDED_LITERAL: 'value',
      BUSINESS_LITERAL: 'value',
      CREDENTIAL_REFERENCE: 'env',
      REFERENCE: 'reference',
      TEMPLATE: 'template',
    };
    const field = need[entry.strategy];
    if (field && entry[field] === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `strategy ${entry.strategy} needs "${field}"` });
  });

const setSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    source: z.enum(['HUMAN_RECORDING', 'GENERATED', 'MANUAL', 'MIXED']).optional(),
    recordingSessionId: z.string().optional(),
    createdAt: z.string().optional(),
    values: z.record(z.unknown()).default({}),
  })
  .strict();

export class TestDataSetError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(details.length > 0 ? `${message}\n  - ${details.join('\n  - ')}` : message);
    this.name = 'TestDataSetError';
  }
}

/** Une clé qui nomme un secret : jamais une valeur en clair dans un jeu de données. */
const SENSITIVE_KEY =
  /(pass(word|wd)?|pwd|mot.?de.?passe|secret|token|otp|\bpin\b|cvv|cvc|api.?key|cookie|card.?number)/i;

export function isSensitiveKey(key: string): boolean {
  return key.split('.').some((part) => SENSITIVE_KEY.test(part.replace(/([a-z])([A-Z])/g, '$1 $2')));
}

/**
 * Lit un jeu de données (objet YAML déjà parsé). `values` est imbriqué (request: { title: … })
 * ou à clés à points ; une feuille est une valeur simple (= recorded) ou un objet avec `strategy`.
 */
export function parseTestDataSet(raw: unknown, id: string): TestDataSet {
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success)
    throw new TestDataSetError(
      `Invalid test data set ${id}`,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  const values: Record<string, TestDataEntry> = {};
  const problems: string[] = [];
  const visit = (node: unknown, prefix: string): void => {
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      add(prefix, { strategy: 'recorded', value: String(node) });
      return;
    }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      problems.push(`${prefix}: a value, or an object with "strategy"`);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.strategy === 'string') {
      add(prefix, record);
      return;
    }
    for (const [name, child] of Object.entries(record)) visit(child, prefix ? `${prefix}.${name}` : name);
  };
  const add = (key: string, input: unknown): void => {
    if (!KEY.test(key)) {
      problems.push(`${key}: invalid key (letters, digits, "_" and "-", dot-separated)`);
      return;
    }
    const entry = entrySchema.safeParse(input);
    if (!entry.success) {
      problems.push(...entry.error.issues.map((issue) => `${key}: ${issue.message}`));
      return;
    }
    const strategy =
      STRATEGY_WORDS[entry.data.strategy] ??
      TEST_DATA_STRATEGIES.find((name) => name === entry.data.strategy) ??
      'RECORDED_LITERAL';
    const sensitive = entry.data.sensitive === true || isSensitiveKey(key);
    // SÉCURITÉ ABSOLUE : un secret n'est jamais une valeur en clair, quoi que dise le fichier.
    if (sensitive && (entry.data.value !== undefined || entry.data.template !== undefined)) {
      problems.push(
        `${key}: a sensitive value is never written in clear text; use { strategy: credential, env: NAME_OF_THE_VARIABLE }`,
      );
      return;
    }
    values[key] = {
      key,
      strategy,
      ...(entry.data.value !== undefined ? { value: entry.data.value } : {}),
      ...(entry.data.generator ? { generator: entry.data.generator } : {}),
      ...(entry.data.env ? { env: entry.data.env } : {}),
      ...(entry.data.reference ? { reference: entry.data.reference } : {}),
      ...(entry.data.template ? { template: entry.data.template } : {}),
      ...(entry.data.semanticType ? { semanticType: entry.data.semanticType } : {}),
      sensitive,
      ...(entry.data.provenance ? { provenance: stripUndefined(entry.data.provenance) } : {}),
    };
  };
  visit(parsed.data.values, '');
  for (const entry of Object.values(values))
    if (entry.reference !== undefined && values[entry.reference] === undefined)
      problems.push(`${entry.key}: reference to an unknown key "${entry.reference}"`);
  if (problems.length > 0) throw new TestDataSetError(`Invalid test data set ${id}`, problems);
  return {
    id,
    name: parsed.data.name ?? path.basename(id).replace(/\.ya?ml$/i, ''),
    source: parsed.data.source ?? 'MANUAL',
    ...(parsed.data.recordingSessionId ? { recordingSessionId: parsed.data.recordingSessionId } : {}),
    ...(parsed.data.createdAt ? { createdAt: parsed.data.createdAt } : {}),
    values,
  };
}

/** Lit un fichier de données (chemin absolu ou relatif à baseDir). */
export function loadTestDataSetFile(file: string, baseDir: string): TestDataSet {
  const absolute = path.resolve(baseDir, file);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(absolute, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new TestDataSetError(
      code === 'ENOENT' ? `Test data file not found: ${file}` : `Cannot read test data file: ${file}`,
      code === 'ENOENT' ? [] : [error instanceof Error ? error.message : String(error)],
    );
  }
  return parseTestDataSet(raw, absolute);
}

/** Plusieurs jeux en un (le dernier l'emporte clé par clé). */
export function mergeTestDataSets(sets: readonly TestDataSet[], id = 'merged'): TestDataSet | undefined {
  if (sets.length === 0) return undefined;
  if (sets.length === 1) return sets[0];
  const values: Record<string, TestDataEntry> = {};
  for (const set of sets) Object.assign(values, set.values);
  return { id, name: id, source: 'MIXED', values };
}

/**
 * Écrit un jeu de données (imbriqué par espace de noms) : test-data.yaml. Les entrées
 * sensibles n'ont jamais de valeur (garanti ici une seconde fois).
 */
export function testDataSetDocument(set: TestDataSet): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of Object.values(set.values).sort((a, b) => a.key.localeCompare(b.key))) {
    const leaf: Record<string, unknown> = { strategy: strategyWord(entry.strategy) };
    if (entry.value !== undefined && !entry.sensitive) leaf.value = entry.value;
    if (entry.generator) leaf.generator = entry.generator;
    if (entry.env) leaf.env = entry.env;
    if (entry.reference) leaf.reference = entry.reference;
    if (entry.template && !entry.sensitive) leaf.template = entry.template;
    if (entry.semanticType) leaf.semanticType = entry.semanticType;
    if (entry.sensitive) leaf.sensitive = true;
    if (entry.provenance) leaf.provenance = entry.provenance;
    let node = values;
    const parts = entry.key.split('.');
    parts.slice(0, -1).forEach((part) => {
      const next = node[part];
      if (next === undefined || typeof next !== 'object' || next === null || 'strategy' in next)
        node[part] = {};
      node = node[part] as Record<string, unknown>;
    });
    node[parts.at(-1) ?? entry.key] = leaf;
  }
  return {
    name: set.name,
    source: set.source,
    ...(set.recordingSessionId ? { recordingSessionId: set.recordingSessionId } : {}),
    ...(set.createdAt ? { createdAt: set.createdAt } : {}),
    values,
  };
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
