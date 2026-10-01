import type { TestDataEntry, TestDataSet, TestDataStrategy } from './test-data-set.js';

export type ResolvedTestData =
  | { kind: 'value'; value: string; strategy: TestDataStrategy | 'PROVIDER'; generated: boolean }
  /** PRESERVE_EXISTING : la valeur déjà dans le champ est gardée, rien n'est saisi. */
  | { kind: 'preserve' }
  | { kind: 'missing'; reason: string };

interface Sources {
  /** Une clé absente des jeux : la valeur du TestDataProvider pour ce champ. */
  fallback: () => string | undefined;
  /** Une valeur pour un générateur (email, firstName, text…) : le TestDataProvider du run. */
  generate: (generator: string) => string | undefined;
}

export interface TestDataRunContextOptions {
  runId: string;
  env: NodeJS.ProcessEnv;
  /** TEST_DATA_GENERATED_FOR_RUN (la clé seulement, jamais la valeur). */
  onGenerated?: (key: string, strategy: string) => void;
  now?: () => Date;
}

/**
 * TEST DATA RUN CONTEXT : `{ testData: clé }` → une valeur, UNE FOIS PAR RUN. La même clé
 * citée trois fois (créer avec l'e-mail, chercher par l'e-mail, vérifier l'e-mail) donne la
 * même valeur pendant le run ; un nouveau run en génère une nouvelle.
 *
 *   RECORDED_LITERAL / BUSINESS_LITERAL  la valeur du jeu, telle quelle
 *   GENERATE_AT_REPLAY                   le générateur, une fois par run (deux clés générées ne
 *                                        reçoivent jamais la même valeur)
 *   TEMPLATE                             « QA ${runId} »
 *   CREDENTIAL_REFERENCE                 la variable d'environnement (jamais mise en cache ni journalisée)
 *   REFERENCE                            la valeur d'une autre clé (confirmEmail = email)
 *   PRESERVE_EXISTING                    rien n'est saisi
 * Une clé absente du jeu : la valeur du TestDataProvider (le comportement d'avant), elle aussi une fois par run.
 */
export class TestDataRunContext {
  private readonly cache = new Map<string, string>();
  private readonly produced = new Map<string, string>();

  constructor(private readonly options: TestDataRunContextOptions) {}

  /** Valeur d'une clé : jeux de données dans l'ordre de priorité (celui du flow, puis celui de la mission). */
  resolve(key: string, sets: readonly (TestDataSet | undefined)[], sources: Sources): ResolvedTestData {
    return this.resolveKey(key, sets, sources, new Set());
  }

  private resolveKey(
    key: string,
    sets: readonly (TestDataSet | undefined)[],
    sources: Sources,
    visiting: Set<string>,
  ): ResolvedTestData {
    if (visiting.has(key)) return { kind: 'missing', reason: `circular reference through "${key}"` };
    visiting.add(key);
    const entry = sets.map((set) => set?.values[key]).find((candidate) => candidate !== undefined);
    if (!entry) {
      const value = this.once(key, sources.fallback);
      return value === undefined
        ? { kind: 'missing', reason: `no test data for "${key}"` }
        : { kind: 'value', value, strategy: 'PROVIDER', generated: true };
    }
    return this.ofEntry(entry, sets, sources, visiting);
  }

  private ofEntry(
    entry: TestDataEntry,
    sets: readonly (TestDataSet | undefined)[],
    sources: Sources,
    visiting: Set<string>,
  ): ResolvedTestData {
    switch (entry.strategy) {
      case 'RECORDED_LITERAL':
      case 'BUSINESS_LITERAL':
        return entry.value === undefined || entry.sensitive
          ? { kind: 'missing', reason: `"${entry.key}" has no value` }
          : { kind: 'value', value: entry.value, strategy: entry.strategy, generated: false };
      case 'CREDENTIAL_REFERENCE': {
        const value = entry.env ? this.options.env[entry.env] : undefined;
        return value === undefined
          ? { kind: 'missing', reason: `environment variable ${entry.env ?? '(none)'} is not set` }
          : { kind: 'value', value, strategy: entry.strategy, generated: false };
      }
      case 'PRESERVE_EXISTING':
        return { kind: 'preserve' };
      case 'REFERENCE':
        return entry.reference
          ? this.resolveKey(entry.reference, sets, sources, visiting)
          : { kind: 'missing', reason: `"${entry.key}" references nothing` };
      case 'TEMPLATE': {
        const value = this.once(entry.key, () => this.interpolate(entry.template ?? ''));
        return value === undefined
          ? { kind: 'missing', reason: `"${entry.key}" has an empty template` }
          : { kind: 'value', value, strategy: entry.strategy, generated: true };
      }
      case 'GENERATE_AT_REPLAY': {
        const generator = entry.generator ?? entry.semanticType ?? lastPart(entry.key);
        const value = this.once(entry.key, () => sources.generate(generator) ?? sources.fallback());
        return value === undefined
          ? { kind: 'missing', reason: `no generator for "${generator}"` }
          : { kind: 'value', value, strategy: entry.strategy, generated: true };
      }
    }
  }

  /** Une valeur générée une seule fois par clé et par run ; deux clés ne partagent jamais une valeur générée. */
  private once(key: string, make: () => string | undefined): string | undefined {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let value = make();
    if (value === undefined) return undefined;
    // Le même e-mail pour deux entités distinctes (deux clients) provoquerait un conflit : une variante.
    for (let index = 2; this.produced.has(value) && this.produced.get(value) !== key; index += 1)
      value = variant(value, index);
    this.cache.set(key, value);
    this.produced.set(value, key);
    this.options.onGenerated?.(key, 'generated once for this run');
    return value;
  }

  private interpolate(template: string): string | undefined {
    const now = (this.options.now ?? (() => new Date()))();
    const text = template
      .replace(/\$\{runId\}/g, this.options.runId)
      .replace(/\$\{timestamp\}/g, String(now.getTime()))
      .replace(/\$\{random\}/g, Math.random().toString(36).slice(2, 8));
    return text === '' ? undefined : text;
  }
}

function lastPart(key: string): string {
  return key.split('.').at(-1) ?? key;
}

function variant(value: string, index: number): string {
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, at).replace(/\+\d+$/, '')}+${String(index)}${value.slice(at)}`;
  return `${value.replace(/ \d+$/, '')} ${String(index)}`;
}
