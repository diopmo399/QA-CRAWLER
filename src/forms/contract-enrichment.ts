import type { ApiContract, ContractFieldSchema } from '../oracles/api-contract.js';
import { normalizeText } from '../policies/keywords.js';
import type { DiscoveredForm, FormField } from './form-model.js';

/**
 * Complète un formulaire avec ce que le contrat d'API dit des champs de requête
 * correspondants (format e-mail, longueurs, bornes, motif, valeurs permises). Le DOM
 * reste la référence : une contrainte n'est ajoutée que si la page n'en déclare pas,
 * et le type du champ ne peut que devenir plus précis (texte → e-mail).
 */
export function enrichWithContract(form: DiscoveredForm, contract: ApiContract | undefined): DiscoveredForm {
  if (!contract) return form;
  const properties = new Map<string, ContractFieldSchema>();
  for (const operation of contract.operations) {
    for (const [name, schema] of Object.entries(operation.requestFields)) {
      if (!properties.has(key(name))) properties.set(key(name), schema);
    }
  }
  if (properties.size === 0) return form;
  return { ...form, fields: form.fields.map((field) => enrichField(field, properties)) };
}

function enrichField(field: FormField, properties: ReadonlyMap<string, ContractFieldSchema>): FormField {
  const schema = [field.name, field.label]
    .map((name) => (name ? properties.get(key(name)) : undefined))
    .find(Boolean);
  if (!schema || field.sensitive) return field;
  const enriched: FormField = { ...field };
  if (field.type === 'text' && schema.format === 'email') enriched.type = 'email';
  if (field.type === 'text' && schema.format === 'uri') enriched.type = 'url';
  enriched.minLength ??= schema.minLength;
  enriched.maxLength ??= schema.maxLength;
  enriched.min ??= schema.minimum;
  enriched.max ??= schema.maximum;
  enriched.pattern ??= schema.pattern;
  if (schema.required) enriched.required = true;
  if (!field.options && schema.enum && (field.type === 'select' || field.type === 'combobox'))
    enriched.options = schema.enum.map((label) => ({ label, disabled: false, placeholder: false }));
  return Object.fromEntries(
    Object.entries(enriched).filter(([, value]) => value !== undefined),
  ) as unknown as FormField;
}

/** "Email", "email", "e_mail", "userEmail"… comparés sans tenir compte de la casse, des accents ni des séparateurs. */
function key(name: string): string {
  return normalizeText(name).replace(/[^a-z0-9]/g, '');
}
