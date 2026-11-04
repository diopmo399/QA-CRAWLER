import { sanitizeWait, waitProblems, waitStep, type WaitSpec } from './wait.js';

/**
 * UNE BOUCLE DU PARCOURS : un nœud qui contient une suite de blocs (et d'attentes) répétée sous contrôle.
 * Elle se compile en UNE étape `loop:` du flow, que le moteur interprète itération par itération (jamais
 * aplatie en une suite) :
 *
 *   REPEAT    un nombre de fois (`times`)
 *   FOR_EACH  une collection : des éléments écrits dans le nœud, ou une donnée du run (tableau JSON)
 *   WHILE     tant qu'une condition d'écran est vraie (mêmes conditions qu'une attente), vérifiée avant
 *             chaque itération ; encore vraie au plafond : échec (protection contre la boucle infinie)
 *
 * Chaque itération a ses variables : `<as>.index` (1…n), `<as>` pour un élément texte, `<as>.<champ>` pour
 * un élément à champs. Ce que les blocs du corps produisent n'existe que pendant l'itération.
 */
export const JOURNEY_LOOP_TYPES = ['REPEAT', 'FOR_EACH', 'WHILE'] as const;
export type JourneyLoopType = (typeof JOURNEY_LOOP_TYPES)[number];
export const JOURNEY_LOOP_LIMITS = {
  maxIterations: 100,
  whileIterations: 20,
  timeoutS: { min: 1, max: 600, default: 120 },
  bodyItems: 12,
} as const;

/** Un élément de collection FOR_EACH : une valeur, ou des champs nommés. */
export type JourneyLoopElement = string | Record<string, string>;
/** Le paramètre d'une instance de bloc dans le corps (même forme que JourneyParam). */
export type JourneyLoopParam = { mode: 'VALUE'; value: string } | { mode: 'MAP'; key: string };

/** Un élément du corps : un bloc de la bibliothèque, ou une attente. */
export interface JourneyLoopItem {
  id: string;
  kind: 'BLOCK' | 'WAIT';
  block?: string;
  version?: number;
  label?: string;
  params?: Record<string, JourneyLoopParam>;
  wait?: WaitSpec;
}

export interface JourneyLoopSpec {
  type: JourneyLoopType;
  times?: number;
  items?: JourneyLoopElement[];
  itemsFrom?: string;
  /** Le nom de la variable d'itération. */
  as: string;
  /** WHILE : la condition (une attente : élément visible, texte, adresse, réponse). */
  while?: WaitSpec;
  maxIterations: number;
  timeoutS: number;
  onFailure: 'STOP' | 'CONTINUE';
  body: JourneyLoopItem[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
const TEXT_MAX = 200;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const clean = (value: unknown, max = TEXT_MAX): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
};
const integer = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

/** Une boucle par défaut : REPEAT 2 fois, corps vide (à remplir). */
export function defaultLoop(type: JourneyLoopType = 'REPEAT'): JourneyLoopSpec {
  return {
    type,
    ...(type === 'REPEAT' ? { times: 2 } : {}),
    ...(type === 'FOR_EACH' ? { items: [] } : {}),
    ...(type === 'WHILE' ? { while: { type: 'VISIBLE', timeoutS: 1, onTimeout: 'FAIL' } } : {}),
    as: type === 'FOR_EACH' ? 'item' : 'iteration',
    maxIterations: type === 'WHILE' ? JOURNEY_LOOP_LIMITS.whileIterations : 2,
    timeoutS: JOURNEY_LOOP_LIMITS.timeoutS.default,
    onFailure: 'STOP',
    body: [],
  };
}

function sanitizeElement(raw: unknown): JourneyLoopElement | undefined {
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw).slice(0, TEXT_MAX);
  if (!isObject(raw)) return undefined;
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(raw).slice(0, 12))
    if (NAME.test(field) && (typeof value === 'string' || typeof value === 'number'))
      fields[field] = String(value).slice(0, TEXT_MAX);
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function sanitizeParams(raw: unknown): Record<string, JourneyLoopParam> | undefined {
  if (!isObject(raw)) return undefined;
  const params: Record<string, JourneyLoopParam> = {};
  for (const [key, param] of Object.entries(raw).slice(0, 40)) {
    if (!isObject(param) || key.length > 120) continue;
    if (param.mode === 'VALUE' && typeof param.value === 'string')
      params[key] = { mode: 'VALUE', value: param.value.slice(0, 500) };
    else if (param.mode === 'MAP' && typeof param.key === 'string')
      params[key] = { mode: 'MAP', key: param.key.trim().slice(0, 120) };
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Une boucle reçue (JSON) ramenée à sa forme : ce qui est inconnu ou hors limites est ignoré ou borné. */
export function sanitizeLoop(raw: unknown): JourneyLoopSpec {
  const value = isObject(raw) ? raw : {};
  const type = JOURNEY_LOOP_TYPES.find((candidate) => candidate === value.type) ?? 'REPEAT';
  const as = clean(value.as, 40);
  const spec: JourneyLoopSpec = {
    type,
    as: as && NAME.test(as) ? as : type === 'FOR_EACH' ? 'item' : 'iteration',
    maxIterations: integer(
      value.maxIterations,
      1,
      JOURNEY_LOOP_LIMITS.maxIterations,
      type === 'WHILE' ? JOURNEY_LOOP_LIMITS.whileIterations : JOURNEY_LOOP_LIMITS.maxIterations,
    ),
    timeoutS: integer(
      value.timeoutS,
      JOURNEY_LOOP_LIMITS.timeoutS.min,
      JOURNEY_LOOP_LIMITS.timeoutS.max,
      JOURNEY_LOOP_LIMITS.timeoutS.default,
    ),
    onFailure: value.onFailure === 'CONTINUE' ? 'CONTINUE' : 'STOP',
    body: [],
  };
  if (type === 'REPEAT') spec.times = integer(value.times, 1, JOURNEY_LOOP_LIMITS.maxIterations, 1);
  if (type === 'FOR_EACH') {
    const from = clean(value.itemsFrom, 120);
    if (from) spec.itemsFrom = from;
    else
      spec.items = (Array.isArray(value.items) ? value.items : [])
        .slice(0, JOURNEY_LOOP_LIMITS.maxIterations)
        .map(sanitizeElement)
        .filter((item): item is JourneyLoopElement => item !== undefined);
  }
  if (type === 'WHILE') spec.while = sanitizeWait(value.while);
  const body = Array.isArray(value.body) ? value.body : [];
  for (const item of body.slice(0, JOURNEY_LOOP_LIMITS.bodyItems)) {
    if (!isObject(item)) continue;
    const id = clean(item.id, 40);
    const kind = item.kind === 'WAIT' ? 'WAIT' : item.kind === 'BLOCK' ? 'BLOCK' : undefined;
    if (!id || !kind) continue;
    const block = kind === 'BLOCK' ? clean(item.block, 120) : undefined;
    const label = clean(item.label, 120);
    const params = kind === 'BLOCK' ? sanitizeParams(item.params) : undefined;
    spec.body.push({
      id,
      kind,
      ...(block ? { block } : {}),
      ...(kind === 'BLOCK' && typeof item.version === 'number' && Number.isInteger(item.version)
        ? { version: item.version }
        : {}),
      ...(label ? { label } : {}),
      ...(params ? { params } : {}),
      ...(kind === 'WAIT' ? { wait: sanitizeWait(item.wait) } : {}),
    });
  }
  return spec;
}

/** Les variables d'une itération connues à l'avance (FOR_EACH lu dans une donnée : seulement l'index). */
export function loopVariableKeys(spec: JourneyLoopSpec): { keys: string[]; open: boolean } {
  const keys = [`${spec.as}.index`];
  if (spec.type !== 'FOR_EACH') return { keys, open: false };
  if (spec.itemsFrom !== undefined) return { keys, open: true };
  for (const item of spec.items ?? []) {
    if (typeof item === 'string') {
      if (!keys.includes(spec.as)) keys.push(spec.as);
    } else
      for (const field of Object.keys(item)) {
        const key = `${spec.as}.${field}`;
        if (!keys.includes(key)) keys.push(key);
      }
  }
  return { keys, open: false };
}

/** Une clé est-elle une variable de la boucle (`<as>`, `<as>.<champ>`) ? */
export const isLoopVariable = (spec: JourneyLoopSpec, key: string): boolean =>
  key === spec.as || key.startsWith(`${spec.as}.`);

/** Ce qui empêche la boucle de s'exécuter (jamais de valeur par défaut silencieuse). */
export function loopProblems(spec: JourneyLoopSpec): string[] {
  const problems: string[] = [];
  if (spec.body.length === 0) problems.push('la boucle ne contient aucun bloc');
  if (!spec.body.some((item) => item.kind === 'BLOCK'))
    problems.push('ajoutez au moins un bloc dans la boucle');
  for (const item of spec.body) {
    if (item.kind === 'BLOCK' && !item.block) problems.push('un élément de la boucle n’a pas de bloc');
    if (item.kind === 'WAIT')
      for (const problem of waitProblems(item.wait ?? { type: 'VISIBLE', timeoutS: 30, onTimeout: 'FAIL' }))
        problems.push(`attente de la boucle : ${problem}`);
  }
  if (spec.type === 'REPEAT' && (spec.times ?? 0) > spec.maxIterations)
    problems.push(
      `${String(spec.times)} répétitions dépassent le plafond de ${String(spec.maxIterations)} itérations`,
    );
  if (spec.type === 'FOR_EACH') {
    if (spec.itemsFrom !== undefined && !KEY.test(spec.itemsFrom))
      problems.push(`« ${spec.itemsFrom} » n’est pas une clé de donnée`);
    if (spec.itemsFrom === undefined && (spec.items ?? []).length === 0)
      problems.push('la collection est vide : ajoutez des éléments ou choisissez une donnée');
    if ((spec.items ?? []).length > spec.maxIterations)
      problems.push(
        `${String(spec.items?.length ?? 0)} éléments dépassent le plafond de ${String(spec.maxIterations)} itérations`,
      );
  }
  if (spec.type === 'WHILE') {
    if (!spec.while) problems.push('la boucle « tant que » n’a pas de condition');
    else for (const problem of waitProblems(spec.while)) problems.push(`condition : ${problem}`);
  }
  return problems;
}

/** Le résumé d'une boucle : « Pour chaque person (3 éléments) », « Répéter 3 fois », « Tant que … ». */
export function loopSummary(spec: JourneyLoopSpec): string {
  if (spec.type === 'REPEAT') return `Répéter ${String(spec.times ?? 1)} fois`;
  if (spec.type === 'WHILE') return `Tant que la condition est vraie (au plus ${String(spec.maxIterations)})`;
  return spec.itemsFrom !== undefined
    ? `Pour chaque ${spec.as} de ${spec.itemsFrom}`
    : `Pour chaque ${spec.as} (${String(spec.items?.length ?? 0)} éléments)`;
}

/**
 * L'étape `loop:` exécutable. `compileItem` rend un bloc du corps (`run:` + `with:`, valeurs propres à
 * l'instance) ; une attente du corps devient son étape `expect`.
 */
export function compileLoop(
  id: string,
  spec: JourneyLoopSpec,
  label: string | undefined,
  compileItem: (item: JourneyLoopItem) => Record<string, unknown> | undefined,
): Record<string, unknown> {
  const steps = spec.body.flatMap((item) => {
    if (item.kind === 'WAIT') return item.wait ? [waitStep(item.wait, item.label)] : [];
    const step = compileItem(item);
    return step ? [step] : [];
  });
  const condition = spec.while ? waitStep(spec.while).expect : undefined;
  return {
    name: label ?? loopSummary(spec),
    loop: {
      id,
      type: spec.type,
      ...(spec.type === 'REPEAT' ? { times: spec.times ?? 1 } : {}),
      ...(spec.type === 'FOR_EACH' && spec.itemsFrom !== undefined ? { itemsFrom: spec.itemsFrom } : {}),
      ...(spec.type === 'FOR_EACH' && spec.itemsFrom === undefined ? { items: spec.items ?? [] } : {}),
      ...(spec.type === 'WHILE' && condition ? { while: condition } : {}),
      as: spec.as,
      maxIterations: spec.maxIterations,
      timeoutMs: spec.timeoutS * 1000,
      onFailure: spec.onFailure,
      steps,
    },
  };
}

/**
 * LA SIMULATION STATIQUE d'un parcours (aperçu, rien n'est exécuté) : par chemin, chaque étape dans l'ordre,
 * d'où vient chaque entrée et ce que chaque bloc produit. Une valeur n'est montrée que si elle est CONNUE avant
 * l'exécution (valeur fixe non sensible, valeur saisie dans le parcours, élément d'une collection écrite) ;
 * une valeur générée ou capturée est « connue à l'exécution » — jamais inventée.
 */
export type PreviewValueStatus = 'KNOWN' | 'AT_RUN' | 'MISSING' | 'SECRET';

export interface PreviewInput {
  key: string;
  /** UPSTREAM : un bloc précédent ; DATA : le jeu d'un bloc ; VALUE : saisie dans le parcours ; LOOP : variable d'itération. */
  source: 'UPSTREAM' | 'DATA' | 'VALUE' | 'LOOP' | 'MISSING';
  /** Le nœud (ou l'élément de boucle) producteur, ou la clé reliée. */
  from?: string;
  /** La clé effectivement lue (après une correspondance `with:`). */
  reads?: string;
  status: PreviewValueStatus;
  value?: string;
}

export interface PreviewOutput {
  key: string;
  origin: string;
  status: PreviewValueStatus;
  value?: string;
  /** RUN : disponible jusqu'à la fin de l'exécution ; ITERATION : pendant une itération seulement. */
  scope: 'RUN' | 'ITERATION';
}

export interface PreviewStep {
  node: string;
  kind: 'BLOCK' | 'WAIT' | 'LOOP';
  label: string;
  /** 1 : dans le corps d'une boucle. */
  depth: number;
  version?: number;
  inputs: PreviewInput[];
  outputs: PreviewOutput[];
  /** LOOP : le nombre d'itérations s'il est connu, son plafond, et ses variables (valeurs connues). */
  loop?: {
    type: JourneyLoopType;
    summary: string;
    iterations?: number;
    maxIterations: number;
    timeoutS: number;
    variables: { key: string; values?: string[] }[];
  };
  /** WAIT : la condition attendue. */
  wait?: string;
  errors: string[];
}

export interface JourneyPreview {
  ok: boolean;
  /** Toujours vrai : un aperçu n'exécute rien et ne contacte aucune application. */
  staticOnly: true;
  errors: string[];
  paths: {
    index: number;
    choices: { node: string; label: string; branch: 'YES' | 'NO' }[];
    steps: PreviewStep[];
  }[];
}
