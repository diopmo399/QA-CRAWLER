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
  /**
   * RÉTENTION : false — la trace garde les événements (clés, étapes, liens) mais aucune valeur
   * (`withheld: true`). Les valeurs des clés sensibles ne sont jamais gardées, quelle que soit l'option.
   */
  traceValues?: boolean;
}

/**
 * Un événement de la trace des données :
 * - GENERATED : une valeur générée (générateur, modèle, fournisseur) ;
 * - CAPTURED : une valeur lue pendant le rejeu (écran, adresse, réponse, donnée recopiée) ;
 * - TRANSFORMED : la valeur capturée a été transformée (`detail` : la transformation) ;
 * - ITERATION : une variable d'itération de boucle ;
 * - USED : une étape utilise la valeur (`use` : ASSIGN saisie, READ citation, VALIDATE vérification) ;
 * - OVERWRITE_REFUSED : une capture aurait écrasé une autre valeur : refusée (`detail` : la raison).
 */
export const DATA_TRACE_ORIGINS = [
  'GENERATED',
  'CAPTURED',
  'TRANSFORMED',
  'ITERATION',
  'USED',
  'OVERWRITE_REFUSED',
] as const;
export type DataTraceOrigin = (typeof DATA_TRACE_ORIGINS)[number];
export type DataTraceUse = 'ASSIGN' | 'READ' | 'VALIDATE';

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
  /** L'identifiant de l'événement dans ce run (`d1`, `d2`…). */
  id?: string;
  at: string;
  key: string;
  origin: DataTraceOrigin;
  /**
   * L'occurrence de valeur (`company.name@1`) : la même pour sa production et toutes ses utilisations ; une
   * nouvelle valeur de la même clé (une autre itération) a une autre occurrence.
   */
  valueId?: string;
  /** L'événement qui a produit la valeur utilisée (lien source → cible). */
  source?: string;
  /** USED : comment l'étape l'utilise. */
  use?: DataTraceUse;
  /** La valeur (absente pour une clé sensible ou si la rétention l'interdit). */
  value?: string;
  /** Une clé sensible : la valeur n'est jamais gardée. */
  masked?: boolean;
  /** La rétention interdit de garder les valeurs (`traceValues: false`). */
  withheld?: boolean;
  /** USED : une valeur fixe du jeu de données (définie statiquement, jamais produite pendant le run). */
  fixed?: boolean;
  /** TRANSFORMED : la transformation ; OVERWRITE_REFUSED : la raison. */
  detail?: string;
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
  /** L'occurrence courante de chaque clé, par portée (`''` : le run ; `persons#2` : une itération). */
  private readonly occurrences = new Map<string, { valueId: string; event: string; value: string }>();
  private readonly counts = new Map<string, number>();
  private sequence = 0;

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
    for (const [key, value] of scope.values) this.produce(key, 'ITERATION', value);
  }

  /** L'itération en cours se termine : ses variables et ses valeurs disparaissent. */
  leaveIteration(): void {
    const token = this.token();
    this.scopes.pop();
    for (const name of [...this.occurrences.keys()])
      if (name.startsWith(`${token}|`)) this.occurrences.delete(name);
  }

  /** La position courante du run (étape, boucles) : rattachée à chaque entrée de la trace. */
  locate(where: DataTraceWhere): void {
    this.where = where;
  }

  /** Les boucles et itérations en cours (`[{ id: 'persons', iteration: 2 }]`). */
  loops(): { id: string; iteration: number }[] {
    return this.scopes.map((scope) => ({ id: scope.id, iteration: scope.iteration }));
  }

  /**
   * Une étape UTILISE cette clé : saisie (ASSIGN), citation (READ), vérification (VALIDATE). L'événement est
   * relié à la production de la valeur (même occurrence) ; une valeur fixe du jeu est notée `fixed`.
   */
  used(key: string, use: DataTraceUse = 'READ', value?: string): void {
    const current = this.current(key);
    this.record(key, 'USED', current?.value ?? value, {
      use,
      ...(current
        ? { valueId: current.valueId, source: current.event }
        : value !== undefined
          ? { fixed: true }
          : {}),
    });
  }

  /** La valeur capturée vient d'être transformée (`detail` : la transformation). */
  transformed(key: string, transform: string): void {
    const current = this.current(key);
    if (!current) return;
    this.record(key, 'TRANSFORMED', current.value, {
      valueId: current.valueId,
      source: current.event,
      detail: transform,
    });
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

  /** La portée courante (`''` : le run ; `persons#2` : l'itération la plus interne). */
  private token(): string {
    const scope = this.scopes.at(-1);
    return scope ? this.scopes.map((entry) => `${entry.id}#${String(entry.iteration)}`).join('/') : '';
  }

  /** L'occurrence courante d'une clé : la plus interne des portées ouvertes, puis le run. */
  private current(key: string): { valueId: string; event: string; value: string } | undefined {
    for (let depth = this.scopes.length; depth >= 0; depth -= 1) {
      const token = this.scopes
        .slice(0, depth)
        .map((entry) => `${entry.id}#${String(entry.iteration)}`)
        .join('/');
      const found = this.occurrences.get(`${token}|${key}`);
      if (found) return found;
    }
    return undefined;
  }

  /** Une valeur PRODUITE : une nouvelle occurrence, dans la portée où elle est gardée. */
  private produce(key: string, origin: DataTraceOrigin, value: string, inScope = true): void {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    const valueId = `${key}@${String(count)}`;
    const event = this.record(key, origin, value, { valueId });
    if (event) this.occurrences.set(`${inScope ? this.token() : ''}|${key}`, { valueId, event, value });
  }

  private record(
    key: string,
    origin: DataTraceOrigin,
    value?: string,
    extra: Partial<DataTraceEntry> = {},
  ): string | undefined {
    if (this.traced.length >= TRACE_LIMIT) return undefined;
    this.sequence += 1;
    const id = `d${String(this.sequence)}`;
    const masked = SENSITIVE_KEY.test(key);
    const withheld = !masked && this.options.traceValues === false;
    const loops = this.loops();
    this.traced.push({
      id,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      key,
      origin,
      ...extra,
      ...(value !== undefined && !masked && !withheld ? { value } : {}),
      ...(value !== undefined && masked ? { masked: true } : {}),
      ...(value !== undefined && withheld ? { withheld: true } : {}),
      ...(this.where.step !== undefined ? { step: this.where.step } : {}),
      ...(this.where.stepName !== undefined ? { stepName: this.where.stepName } : {}),
      ...(loops.length > 0 ? { loops } : {}),
    });
    return id;
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
    const refuse = (reason: string): string => {
      this.record(key, 'OVERWRITE_REFUSED', value, { detail: reason });
      return reason;
    };
    // Dans une boucle, une clé que le run ne connaît pas encore appartient à l'itération.
    if (scope && !this.cache.has(key)) {
      const known = scope.values.get(key);
      if (known !== undefined && known !== value)
        return refuse(`testData.${key} already has another value in this iteration: nothing is overwritten`);
      scope.values.set(key, value);
      this.produce(key, 'CAPTURED', value);
      return undefined;
    }
    const known = this.cache.get(key);
    if (known !== undefined && known !== value)
      return refuse(`testData.${key} already has another value in this run: nothing is overwritten`);
    this.cache.set(key, value);
    this.produced.set(value, key);
    this.produce(key, 'CAPTURED', value, false);
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
    this.produce(key, 'GENERATED', value, scope !== undefined);
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
