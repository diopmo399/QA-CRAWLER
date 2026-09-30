import type { DiscoveredForm, FormField } from '../forms/form-model.js';
import type { ApiContract, ContractFieldSchema } from '../oracles/api-contract.js';
import { normalizeText } from '../policies/keywords.js';

/** D'où vient une contrainte. APPLICATION et HISTORICAL sont réservés aux sources à venir (messages, historique). */
export const CONSTRAINT_SOURCES = [
  'HTML',
  'ARIA',
  'FRAMEWORK',
  'OPENAPI',
  'APPLICATION',
  'HISTORICAL',
] as const;
export type ConstraintSource = (typeof CONSTRAINT_SOURCES)[number];

/**
 * Les contraintes que le modèle suit. `min` / `max` sont le minimum / maximum inclus
 * (attributs min/max, minimum/maximum OpenAPI) ; exclusiveMinimum / exclusiveMaximum
 * les bornes exclues (OpenAPI).
 */
export const CONSTRAINT_KEYS = [
  'required',
  'type',
  'format',
  'min',
  'max',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'step',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
  'nullable',
  'multiple',
  'disabled',
  'readonly',
] as const;
export type ConstraintKey = (typeof CONSTRAINT_KEYS)[number];

type ConstraintValue = string | number | boolean | string[];

/**
 * Ce qu'un champ accepte, normalisé et fusionné depuis le DOM (HTML, ARIA : ce que
 * l'utilisateur peut réellement saisir) et le contrat OpenAPI. Chaque contrainte garde
 * ses sources et une confiance ; deux sources qui se contredisent ne sont jamais
 * départagées en silence : le conflit est gardé (CONSTRAINT_MISMATCH) avec les deux
 * valeurs. À ne pas confondre avec les FieldConstraints d'une DiscoveredAction (faits
 * bruts de l'élément).
 */
export interface FieldConstraints {
  required?: boolean;
  /** Type de valeur : string, number, integer, boolean, array. */
  type?: string;
  /** email, uri, date, date-time, uuid, number, integer, time, tel… */
  format?: string;
  /** Minimum inclus. */
  min?: number;
  /** Maximum inclus. */
  max?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  /** Pas d'un champ numérique. */
  step?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  /** null accepté par l'API. */
  nullable?: boolean;
  multiple?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  /** Genre de contrôle (text, select, checkbox, radio…) : ce que « vide » veut dire pour lui. */
  control?: string;
  /** aria-invalid="true" au moment de l'observation (un constat, pas une contrainte). */
  observedInvalid?: boolean;
  /** Qui déclare chaque contrainte : maxLength → [HTML, OPENAPI]. */
  sources?: Partial<Record<ConstraintKey, ConstraintSource[]>>;
  /** Confiance dans chaque contrainte, 0..1 : plus haute quand plusieurs sources s'accordent. */
  confidence?: Partial<Record<ConstraintKey, number>>;
  /** Contraintes sur lesquelles les sources se contredisent. */
  conflicts?: ConstraintConflict[];
}

/** Deux sources disent des choses différentes pour la même contrainte. */
export interface ConstraintConflict {
  kind: 'CONSTRAINT_MISMATCH';
  constraint: ConstraintKey;
  /** Chaque source et sa valeur : HTML = 100, OPENAPI = 80. */
  values: { source: ConstraintSource; value: ConstraintValue }[];
  /** La valeur retenue pour les tests par l'interface (celle de la page), et pourquoi. */
  effective: ConstraintSource;
  reason: string;
}

/** Un conflit d'un formulaire, avec le champ qu'il concerne. */
export interface FieldConstraintConflict extends ConstraintConflict {
  fieldId: string;
}

/** Contraintes de chaque champ d'un formulaire, par id de champ. */
export type FormConstraints = Record<string, FieldConstraints>;

export interface ConstraintExtractor {
  extract(field: FormField, contract?: ApiContract): FieldConstraints;
}

/** Confiance d'une contrainte vue par une seule source. */
const SOURCE_CONFIDENCE: Record<ConstraintSource, number> = {
  HTML: 0.8,
  ARIA: 0.75,
  /** Validateurs du framework lus dans le code (Angular Validators) : l'application les applique. */
  FRAMEWORK: 0.8,
  OPENAPI: 0.7,
  APPLICATION: 0.8,
  HISTORICAL: 0.6,
};
/** Chaque source qui confirme ajoute ceci, jusqu'à 0,95 : une contrainte n'est jamais certaine. */
const AGREEMENT_BONUS = 0.15;
const MAX_CONFIDENCE = 0.95;
/** Deux sources en désaccord : la contrainte retenue reste douteuse. */
const CONFLICT_CONFIDENCE = 0.5;
/** Ordre de préférence quand il faut une valeur pour tester par l'interface : ce que la page impose. */
const UI_PRIORITY: ConstraintSource[] = ['HTML', 'ARIA', 'FRAMEWORK', 'APPLICATION', 'OPENAPI', 'HISTORICAL'];

interface Observation {
  key: ConstraintKey;
  value: ConstraintValue;
  source: ConstraintSource;
}

/**
 * Lit les contraintes d'un champ dans ce que le FormAnalyzer en sait (required et son
 * origine HTML / aria-required, min/max, step, minlength/maxlength, pattern, type,
 * multiple, disabled, readonly, options → enum) puis dans le contrat OpenAPI de la
 * propriété de même nom (required, nullable, type, format, bornes incluses et exclues,
 * longueurs, pattern, enum). Aucune seconde lecture du DOM.
 *
 * Même valeur des deux côtés : les deux sources sont gardées et la confiance monte.
 * Valeurs différentes : CONSTRAINT_MISMATCH avec les deux valeurs ; la valeur de la
 * page reste celle qu'on teste par l'interface (l'utilisateur ne peut rien saisir
 * d'autre), et le conflit est signalé.
 */
export class DomOpenApiConstraintExtractor implements ConstraintExtractor {
  extract(field: FormField, contract?: ApiContract): FieldConstraints {
    const observations = [
      ...pageObservations(field),
      ...frameworkObservations(field),
      ...contractObservations(field, contract),
    ];
    const constraints: FieldConstraints = { sources: {}, confidence: {} };
    for (const key of CONSTRAINT_KEYS) {
      const seen = observations.filter((observation) => observation.key === key);
      if (seen.length > 0) merge(constraints, key, seen);
    }
    constraints.control = field.type;
    if (field.ariaInvalid) constraints.observedInvalid = true;
    return constraints;
  }

  /** Les contraintes de chaque champ d'un formulaire (jamais les champs sensibles). */
  extractForm(form: DiscoveredForm, contract?: ApiContract): FormConstraints {
    return Object.fromEntries(
      form.fields
        .filter((field) => !field.sensitive && !field.payment)
        .map((field) => [field.id, this.extract(field, contract)]),
    );
  }
}

/** Tous les conflits d'un formulaire, champ par champ. */
export function formConflicts(constraints: FormConstraints): FieldConstraintConflict[] {
  return Object.entries(constraints).flatMap(([fieldId, own]) =>
    (own.conflicts ?? []).map((conflict) => ({ fieldId, ...conflict })),
  );
}

/** Ce que la page déclare. Les valeurs que le contrat a ajoutées au champ (enrichWithContract) n'en sont pas. */
function pageObservations(field: FormField): Observation[] {
  const fromContract = new Set(field.contractFilled ?? []);
  const own = <K extends keyof FormField>(key: K): FormField[K] | undefined =>
    fromContract.has(key) ? undefined : field[key];
  const observations: Observation[] = [];
  const add = (key: ConstraintKey, value: ConstraintValue | undefined, source: ConstraintSource): void => {
    if (value !== undefined) observations.push({ key, value, source });
  };
  if (own('required')) {
    const by = field.requiredBy && field.requiredBy.length > 0 ? field.requiredBy : ['HTML' as const];
    for (const source of by) add('required', true, source);
  }
  const type = fromContract.has('type') ? undefined : domType(field);
  add('type', type, 'HTML');
  add('format', fromContract.has('type') ? undefined : domFormat(field), 'HTML');
  add('min', own('min'), 'HTML');
  add('max', own('max'), 'HTML');
  add('step', own('step'), 'HTML');
  add('minLength', own('minLength'), 'HTML');
  add('maxLength', own('maxLength'), 'HTML');
  add('pattern', own('pattern'), 'HTML');
  if (field.multiple) add('multiple', true, 'HTML');
  if (field.disabled) add('disabled', true, 'HTML');
  if (field.readonly) add('readonly', true, 'HTML');
  const options = fromContract.has('options')
    ? undefined
    : field.options
        ?.filter((option) => !option.placeholder && !option.disabled)
        .map((option) => option.label);
  if (options && options.length > 0) add('enum', options, 'HTML');
  return observations;
}

/** Ce que les validateurs du framework (analyse statique) imposent : Validators.maxLength(100)… */
function frameworkObservations(field: FormField): Observation[] {
  const observations: Observation[] = [];
  for (const validator of field.staticValidators ?? []) {
    const add = (key: ConstraintKey, value: ConstraintValue | undefined): void => {
      if (value !== undefined) observations.push({ key, value, source: 'FRAMEWORK' });
    };
    const number = typeof validator.value === 'number' ? validator.value : undefined;
    switch (validator.kind) {
      case 'required':
      case 'requiredTrue':
        add('required', true);
        break;
      case 'email':
        add('format', 'email');
        break;
      case 'min':
        add('min', number);
        break;
      case 'max':
        add('max', number);
        break;
      case 'minLength':
        add('minLength', number);
        break;
      case 'maxLength':
        add('maxLength', number);
        break;
      case 'pattern':
        add(
          'pattern',
          typeof validator.value === 'string' ? validator.value.replace(/^\/(.*)\/[a-z]*$/, '$1') : undefined,
        );
        break;
    }
  }
  return observations;
}

function contractObservations(field: FormField, contract: ApiContract | undefined): Observation[] {
  const schema = contractSchemaFor(field, contract);
  if (!schema) return [];
  const observations: Observation[] = [];
  const add = (key: ConstraintKey, value: ConstraintValue | undefined): void => {
    if (value !== undefined) observations.push({ key, value, source: 'OPENAPI' });
  };
  if (schema.required) add('required', true);
  if (schema.nullable) add('nullable', true);
  add('type', schema.type);
  add(
    'format',
    schema.format ?? (schema.type === 'integer' || schema.type === 'number' ? schema.type : undefined),
  );
  add('min', schema.minimum);
  add('max', schema.maximum);
  add('exclusiveMinimum', schema.exclusiveMinimum);
  add('exclusiveMaximum', schema.exclusiveMaximum);
  add('minLength', schema.minLength);
  add('maxLength', schema.maxLength);
  add('pattern', schema.pattern);
  add('enum', schema.enum);
  return observations;
}

/** Fusionne ce que chaque source dit d'une contrainte. */
function merge(constraints: FieldConstraints, key: ConstraintKey, seen: Observation[]): void {
  const ordered = [...seen].sort((a, b) => UI_PRIORITY.indexOf(a.source) - UI_PRIORITY.indexOf(b.source));
  const [first] = ordered;
  if (!first) return;
  let value = first.value;
  const agreeing: ConstraintSource[] = [first.source];
  const disagreeing: Observation[] = [];
  for (const other of ordered.slice(1)) {
    const refined = agree(key, value, other.value);
    if (refined === undefined) disagreeing.push(other);
    else {
      value = refined;
      if (!agreeing.includes(other.source)) agreeing.push(other.source);
    }
  }
  (constraints as Record<string, unknown>)[key] = value;
  (constraints.sources ??= {})[key] = agreeing;
  const single = Math.max(...agreeing.map((source) => SOURCE_CONFIDENCE[source]));
  (constraints.confidence ??= {})[key] =
    disagreeing.length > 0
      ? CONFLICT_CONFIDENCE
      : round(Math.min(MAX_CONFIDENCE, single + AGREEMENT_BONUS * (agreeing.length - 1)));
  if (disagreeing.length > 0)
    (constraints.conflicts ??= []).push({
      kind: 'CONSTRAINT_MISMATCH',
      constraint: key,
      values: [first, ...disagreeing].map(({ source, value: stated }) => ({ source, value: stated })),
      effective: first.source,
      reason: `${first.source} and ${disagreeing.map((entry) => entry.source).join(', ')} disagree on ${key}; the ${first.source} value is what the user can enter, so it is the one tested through the UI`,
    });
}

/**
 * Deux valeurs d'une même contrainte s'accordent-elles ? Rend la valeur retenue (la plus
 * précise : number + integer → integer), ou undefined quand elles se contredisent.
 */
function agree(
  key: ConstraintKey,
  current: ConstraintValue,
  other: ConstraintValue,
): ConstraintValue | undefined {
  if (key === 'pattern' && typeof current === 'string' && typeof other === 'string')
    return anchorless(current) === anchorless(other) ? current : undefined;
  if (key === 'format' || key === 'type') {
    const a = canonicalFormat(String(current));
    const b = canonicalFormat(String(other));
    if (a === b) return current;
    if ((a === 'number' && b === 'integer') || (a === 'integer' && b === 'number')) return 'integer';
    return undefined;
  }
  if (key === 'enum' && Array.isArray(current) && Array.isArray(other))
    // La page montre des libellés, l'API liste des valeurs (« Administrateur » / ADMIN) :
    // seul le nombre de choix se compare de façon fiable.
    return current.length === other.length ? current : undefined;
  return current === other ? current : undefined;
}

function anchorless(pattern: string): string {
  return pattern.replace(/^\^/, '').replace(/\$$/, '');
}

function canonicalFormat(format: string): string {
  const lower = format.toLowerCase();
  return lower === 'url' ? 'uri' : lower;
}

/** Type de valeur que le contrôle impose ; rien pour un champ texte (il peut porter n'importe quoi). */
function domType(field: FormField): string | undefined {
  switch (field.type) {
    case 'number':
    case 'range':
      return 'number';
    case 'checkbox':
      return field.choiceGroup === undefined ? 'boolean' : undefined;
    default:
      return field.multiple && field.type === 'select' ? 'array' : undefined;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function domFormat(field: FormField): string | undefined {
  switch (field.type) {
    case 'email':
      return 'email';
    case 'url':
      return 'uri';
    case 'number':
    case 'range':
      return 'number';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'tel':
      return 'tel';
    default:
      return undefined;
  }
}

/**
 * La propriété du contrat qui correspond au champ (par name, puis libellé), comparée
 * sans casse, accents ni séparateurs. Partagé avec enrichWithContract.
 */
export function contractSchemaFor(
  field: Pick<FormField, 'name' | 'label' | 'staticProperty'>,
  contract: ApiContract | undefined,
): ContractFieldSchema | undefined {
  if (!contract) return undefined;
  const properties = contractProperties(contract);
  // La propriété d'API que le code relie au champ (analyse statique), puis name et libellé.
  return [field.staticProperty, field.name, field.label]
    .map((name) => (name ? properties.get(propertyKey(name)) : undefined))
    .find(Boolean);
}

const cache = new WeakMap<ApiContract, Map<string, ContractFieldSchema>>();

export function contractProperties(contract: ApiContract): Map<string, ContractFieldSchema> {
  let properties = cache.get(contract);
  if (!properties) {
    properties = new Map();
    for (const operation of contract.operations)
      for (const [name, schema] of Object.entries(operation.requestFields))
        if (!properties.has(propertyKey(name))) properties.set(propertyKey(name), schema);
    cache.set(contract, properties);
  }
  return properties;
}

/** "Email", "email", "e_mail", "userEmail"… */
export function propertyKey(name: string): string {
  return normalizeText(name).replace(/[^a-z0-9]/g, '');
}
