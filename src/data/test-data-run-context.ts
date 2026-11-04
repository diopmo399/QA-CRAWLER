import type { TestDataEntry, TestDataSet, TestDataStrategy } from './test-data-set.js';

export type ResolvedTestData =
  | {
      kind: 'value';
      value: string;
      strategy: TestDataStrategy | 'PROVIDER' | 'ITERATION';
      generated: boolean;
    }
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
  /** false : la trace garde les événements sans aucune valeur (`withheld`). Par défaut : les valeurs. */
  traceValues?: boolean;
}

/** D'où vient une donnée du run (traçabilité). */
export type DataTraceOrigin = 'GENERATED' | 'CAPTURED' | 'ITERATION' | 'USED';

/** Où en est le run quand une donnée est produite ou lue : l'étape, et la boucle/itération éventuelles. */
export interface DataTraceWhere {
  /** Position de l'étape (1…n) dans le flow, ou dans le corps de la boucle. */
  step?: number;
  /** La description de l'étape (son nom : « Bloc › étape » pour une étape d'un bloc rejoué). */
  stepName?: string;
  /** Les boucles englobantes : `persons#2` (id et itération à partir de 1). */
  loops?: { id: string; iteration: number }[];
}

/**
 * Une entrée de la trace des données d'un run : une valeur PRODUITE (générée, capturée, variable
 * d'itération) ou LUE (citée par une étape). La valeur n'est gardée que pour une clé non sensible.
 */
export interface DataTraceEntry extends DataTraceWhere {
  at: string;
  key: string;
  origin: DataTraceOrigin;
  /** La valeur (absente pour une clé sensible, ou une lecture). */
  value?: string;
  /** Une clé sensible : la valeur n'est jamais gardée. */
  masked?: boolean;
  /** La valeur existait, mais la mission ne garde pas les valeurs (`testData.traceValues: false`). */
  withheld?: boolean;
}

/** Une portée d'itération : les variables de l'itération et les valeurs produites pendant celle-ci. */
interface IterationScope {
  id: string;
  iteration: number;
  values: Map<string, string>;
}

const SENSITIVE_KEY = /(password|passwd|secret|token|apikey|api-key|credential|motdepasse|mot-de-passe)/i;
const TRACE_LIMIT = 2_000;

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
  /** Les portées d'itération ouvertes (la plus interne en dernier). */
  private readonly scopes: IterationScope[] = [];
  private readonly traced: DataTraceEntry[] = [];
  private where: DataTraceWhere = {};

  constructor(private readonly options: TestDataRunContextOptions) {}

  /** La clé a-t-elle déjà reçu sa valeur pendant ce run (saisie, génération, itération en cours) ? */
  has(key: string): boolean {
    return this.scoped(key) !== undefined || this.cache.has(key);
  }

  /**
   * Les valeurs produites pendant ce run, par clé (générées, modèles, fournisseur) : en mémoire seulement,
   * pour le correction manager (lier une ligne de tableau à la donnée du run). Jamais un identifiant.
   * Pendant une boucle, les valeurs de l'itération en cours masquent celles du run.
   */
  values(): { key: string; value: string }[] {
    const merged = new Map(this.cache);
    for (const scope of this.scopes) for (const [key, value] of scope.values) merged.set(key, value);
    return [...merged.entries()].map(([key, value]) => ({ key, value }));
  }

  /**
   * UNE ITÉRATION DE BOUCLE commence : ses variables (`person.firstName`, `person.index`) n'existent que
   * pendant l'itération ; ce qui est généré ou capturé pendant celle-ci aussi (l'itération suivante produit
   * sa propre valeur). Les valeurs déjà produites avant la boucle restent les mêmes.
   */
  enterIteration(id: string, iteration: number, variables: Readonly<Record<string, string>>): void {
    const scope: IterationScope = { id, iteration, values: new Map(Object.entries(variables)) };
    this.scopes.push(scope);
    for (const [key, value] of scope.values) this.record(key, 'ITERATION', value);
  }

  /** L'itération en cours se termine : ses variables et ses valeurs disparaissent. */
  leaveIteration(): void {
    this.scopes.pop();
  }

  /** La position courante du run (étape, boucles) : rattachée à chaque entrée de la trace. */
  locate(where: DataTraceWhere): void {
    this.where = where;
  }

  /** Les boucles et itérations en cours (`[{ id: 'persons', iteration: 2 }]`). */
  loops(): { id: string; iteration: number }[] {
    return this.scopes.map((scope) => ({ id: scope.id, iteration: scope.iteration }));
  }

  /** Une étape LIT cette clé (citation, saisie) : tracé sans la valeur. */
  used(key: string): void {
    this.record(key, 'USED');
  }

  /** La trace des données de ce run (bornée), dans l'ordre. */
  trace(): DataTraceEntry[] {
    return this.traced.map((entry) => ({ ...entry, ...(entry.loops ? { loops: [...entry.loops] } : {}) }));
  }

  private scoped(key: string): string | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const value = this.scopes[index]?.values.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private record(key: string, origin: DataTraceOrigin, value?: string): void {
    if (this.traced.length >= TRACE_LIMIT) return;
    const masked = SENSITIVE_KEY.test(key);
    const kept = this.options.traceValues !== false;
    const loops = this.loops();
    this.traced.push({
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      key,
      origin,
      ...(value !== undefined && !masked && kept ? { value } : {}),
      ...(value !== undefined && masked ? { masked: true } : {}),
      ...(value !== undefined && !masked && !kept ? { withheld: true } : {}),
      ...(this.where.step !== undefined ? { step: this.where.step } : {}),
      ...(this.where.stepName !== undefined ? { stepName: this.where.stepName } : {}),
      ...(loops.length > 0 ? { loops } : {}),
    });
  }

  /**
   * LA REPRISE : les valeurs produites par un run précédent (le rejeu interrompu) sont reprises telles
   * quelles — la même donnée créée, le même critère saisi — jamais régénérées ni remplacées par la
   * valeur statique de l'enregistrement.
   */
  seed(values: readonly { key: string; value: string }[]): void {
    for (const entry of values) {
      this.cache.set(entry.key, entry.value);
      this.produced.set(entry.value, entry.key);
    }
  }

  /**
   * UNE VALEUR CAPTURÉE pendant le run (écran, adresse, réponse) : gardée comme les valeurs générées, citée
   * ensuite avec la même valeur. Une clé qui a déjà une AUTRE valeur dans ce run n'est jamais écrasée (la raison
   * est rendue ; undefined : gardée).
   */
  capture(key: string, value: string): string | undefined {
    // La même valeur déjà connue (générée juste avant) : rien à refaire, rien à tracer deux fois.
    if ((this.scoped(key) ?? this.cache.get(key)) === value) return undefined;
    const scope = this.scopes.at(-1);
    // Dans une boucle, une clé que le run ne connaît pas encore appartient à l'itération.
    if (scope && !this.cache.has(key)) {
      const known = scope.values.get(key);
      if (known !== undefined && known !== value)
        return `testData.${key} already has another value in this iteration: nothing is overwritten`;
      scope.values.set(key, value);
      this.record(key, 'CAPTURED', value);
      return undefined;
    }
    const known = this.cache.get(key);
    if (known !== undefined && known !== value)
      return `testData.${key} already has another value in this run: nothing is overwritten`;
    this.cache.set(key, value);
    this.produced.set(value, key);
    this.record(key, 'CAPTURED', value);
    return undefined;
  }

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
    // Une variable (ou une valeur) de l'itération en cours l'emporte : c'est la donnée de CETTE itération.
    const iteration = this.scoped(key);
    if (iteration !== undefined)
      return { kind: 'value', value: iteration, strategy: 'ITERATION', generated: false };
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
    const cached = this.scoped(key) ?? this.cache.get(key);
    if (cached !== undefined) return cached;
    let value = make();
    if (value === undefined) return undefined;
    // Dans une boucle : une valeur PAR ITÉRATION (deux personnes ne reçoivent jamais le même e-mail).
    const scope = this.scopes.at(-1);
    const owner = scope ? `${key}@${scope.id}#${String(scope.iteration)}` : key;
    // Le même e-mail pour deux entités distinctes (deux clients) provoquerait un conflit : une variante.
    for (let index = 2; this.produced.has(value) && this.produced.get(value) !== owner; index += 1)
      value = variant(value, index);
    if (scope) scope.values.set(key, value);
    else this.cache.set(key, value);
    this.produced.set(value, owner);
    this.record(key, 'GENERATED', value);
    this.options.onGenerated?.(
      key,
      scope
        ? `generated once for iteration ${String(scope.iteration)} of loop ${scope.id}`
        : 'generated once for this run',
    );
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
