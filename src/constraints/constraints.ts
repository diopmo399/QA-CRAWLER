import type { DiscoveredForm, FormField } from '../forms/form-model.js';
import type { ApiContract, ContractFieldSchema } from '../oracles/api-contract.js';
import { normalizeText } from '../policies/keywords.js';

/**
 * Ce qu'un champ accepte, fusionné depuis le DOM (ce que l'utilisateur peut réellement
 * saisir : prioritaire) et le contrat OpenAPI (qui complète). À ne pas confondre avec
 * les FieldConstraints d'une DiscoveredAction (faits bruts de l'élément).
 */
export interface FieldConstraints {
  required?: boolean;
  min?: number;
  max?: number;
  /** Pas d'un champ numérique. */
  step?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** email, uri, date, number, integer… */
  format?: string;
  enum?: string[];
  /** D'où vient chaque contrainte : dom ou openapi. */
  sources?: Partial<Record<Exclude<keyof FieldConstraints, 'sources'>, 'dom' | 'openapi'>>;
}

/** Contraintes de chaque champ d'un formulaire, par id de champ. */
export type FormConstraints = Record<string, FieldConstraints>;

export interface ConstraintExtractor {
  extract(field: FormField, contract?: ApiContract): FieldConstraints;
}

/**
 * Lit les contraintes d'un champ : required, min/max, minlength/maxlength, pattern,
 * format (type du champ), options → enum ; puis complète avec le contrat OpenAPI de la
 * propriété de même nom. Une contrainte du DOM n'est jamais remplacée par le contrat.
 */
export class DomOpenApiConstraintExtractor implements ConstraintExtractor {
  extract(field: FormField, contract?: ApiContract): FieldConstraints {
    const constraints: FieldConstraints = { sources: {} };
    const set = <K extends Exclude<keyof FieldConstraints, 'sources'>>(
      key: K,
      value: FieldConstraints[K] | undefined,
      source: 'dom' | 'openapi',
    ): void => {
      if (value === undefined || constraints[key] !== undefined) return;
      constraints[key] = value;
      (constraints.sources ??= {})[key] = source;
    };
    if (field.required) set('required', true, 'dom');
    set('min', field.min, 'dom');
    set('max', field.max, 'dom');
    set('step', field.step, 'dom');
    set('minLength', field.minLength, 'dom');
    set('maxLength', field.maxLength, 'dom');
    set('pattern', field.pattern, 'dom');
    set('format', domFormat(field), 'dom');
    const options = field.options
      ?.filter((option) => !option.placeholder && !option.disabled)
      .map((option) => option.label);
    if (options && options.length > 0) set('enum', options, 'dom');

    const schema = contractSchemaFor(field, contract);
    if (schema) {
      if (schema.required) set('required', true, 'openapi');
      set('min', schema.minimum, 'openapi');
      set('max', schema.maximum, 'openapi');
      set('minLength', schema.minLength, 'openapi');
      set('maxLength', schema.maxLength, 'openapi');
      set('pattern', schema.pattern, 'openapi');
      set(
        'format',
        schema.format ?? (schema.type === 'integer' || schema.type === 'number' ? schema.type : undefined),
        'openapi',
      );
      set('enum', schema.enum, 'openapi');
    }
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
  field: Pick<FormField, 'name' | 'label'>,
  contract: ApiContract | undefined,
): ContractFieldSchema | undefined {
  if (!contract) return undefined;
  const properties = contractProperties(contract);
  return [field.name, field.label]
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
