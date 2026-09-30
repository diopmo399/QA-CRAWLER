import type { FormField } from '../form-model.js';
import type { FieldKind, FieldState } from './field-state.js';

/**
 * L'état d'un champ tel que le connaît un plan de remplissage (FormField), sans la
 * provenance (qui demande l'écran entier, voir FormStateAnalyzer) : assez pour décider
 * KEEP / REPLACE / FILL / OBSERVE_ONLY.
 */
export function fieldStateOfFormField(field: FormField): FieldState {
  const kind: FieldKind =
    field.type === 'select' || field.type === 'combobox'
      ? 'select'
      : field.type === 'radio'
        ? 'radio'
        : field.type === 'checkbox'
          ? 'checkbox'
          : 'text';
  const valid = field.frameworkValid ?? (field.ariaInvalid ? false : undefined);
  return {
    fieldId: field.control ?? field.name ?? field.label ?? field.id,
    ...(field.label ? { label: field.label } : {}),
    ...(field.control ? { control: field.control } : {}),
    kind,
    ...(field.staticConcept ? { semanticType: field.staticConcept } : {}),
    ...(field.hasValue
      ? {
          currentValue: {
            ...(field.valueDigest ? { digest: field.valueDigest } : {}),
            ...(field.selectedOption ? { option: field.selectedOption } : {}),
            ...(field.selectedValue ? { code: field.selectedValue } : {}),
          },
        }
      : {}),
    state: !field.hasValue ? 'EMPTY' : field.autofilled ? 'AUTOFILLED' : 'UNKNOWN_PREFILLED',
    editable: !field.readonly && !field.disabled,
    readonly: field.readonly,
    disabled: field.disabled,
    required: field.required,
    visible: true,
    ...(valid !== undefined ? { valid } : {}),
    sensitive: field.sensitive || field.payment,
  };
}
