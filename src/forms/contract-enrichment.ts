import { contractProperties, contractSchemaFor } from '../constraints/constraints.js';
import type { ApiContract } from '../oracles/api-contract.js';
import type { DiscoveredForm, FormField } from './form-model.js';

/**
 * Complète un formulaire avec ce que le contrat d'API dit des champs de requête
 * correspondants (format e-mail, longueurs, bornes, motif, valeurs permises). Le DOM
 * reste la référence : une contrainte n'est ajoutée que si la page n'en déclare pas,
 * et le type du champ ne peut que devenir plus précis (texte → e-mail). La recherche de
 * la propriété est celle du ConstraintExtractor.
 */
export function enrichWithContract(form: DiscoveredForm, contract: ApiContract | undefined): DiscoveredForm {
  if (!contract || contractProperties(contract).size === 0) return form;
  return { ...form, fields: form.fields.map((field) => enrichField(field, contract)) };
}

function enrichField(field: FormField, contract: ApiContract): FormField {
  const schema = contractSchemaFor(field, contract);
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
