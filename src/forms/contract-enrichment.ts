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
  // Ce qui vient du contrat reste marqué : le modèle de contraintes ne le prend pas pour une déclaration de la page.
  const filled: (keyof FormField)[] = [];
  const fill = <K extends keyof FormField>(key: K, value: FormField[K] | undefined): void => {
    if (enriched[key] !== undefined || value === undefined) return;
    enriched[key] = value;
    filled.push(key);
  };
  if (field.type === 'text' && (schema.format === 'email' || schema.format === 'uri')) {
    enriched.type = schema.format === 'email' ? 'email' : 'url';
    filled.push('type');
  }
  fill('minLength', schema.minLength);
  fill('maxLength', schema.maxLength);
  fill('min', schema.minimum);
  fill('max', schema.maximum);
  fill('pattern', schema.pattern);
  if (schema.required && !field.required) {
    enriched.required = true;
    filled.push('required');
  }
  if (!field.options && schema.enum && (field.type === 'select' || field.type === 'combobox'))
    fill(
      'options',
      schema.enum.map((label) => ({ label, disabled: false, placeholder: false })),
    );
  if (filled.length > 0) enriched.contractFilled = [...(field.contractFilled ?? []), ...filled];
  return Object.fromEntries(
    Object.entries(enriched).filter(([, value]) => value !== undefined),
  ) as unknown as FormField;
}
