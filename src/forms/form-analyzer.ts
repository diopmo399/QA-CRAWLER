import type { Page } from 'playwright';
import { toLocator } from '../execution/locator-resolver.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { sensitivityOf } from '../policies/sensitive-fields.js';
import type { DiscoveredForm, FieldType, FormField, SelectOption, ValidationMessage } from './form-model.js';
import { validityOf } from './validity.js';

const FIELD_ACTIONS = new Set<DiscoveredAction['type']>(['fill', 'select', 'check', 'uncheck']);
const PLACEHOLDER_OPTION = /^(-+|(choisir|choose|select|sélectionner|selectionner|aucun|none)\b)/i;

/**
 * « Qu'attend ce formulaire ? »
 *
 * Transforme les champs et boutons déjà découverts sur un écran en formulaires
 * logiques — un <form>, une fenêtre, un calque, ou la page elle-même quand une
 * application monopage n'a pas de <form> — avec le type, les contraintes, les
 * options et la sensibilité de chaque champ. Avec une page, il lit aussi les messages
 * de validation affichés. Il ne remplit et ne clique jamais rien.
 */
export interface FormAnalyzer {
  analyze(page: Page | undefined, context: PageContext): Promise<DiscoveredForm[]>;
}

export class DomFormAnalyzer implements FormAnalyzer {
  async analyze(page: Page | undefined, context: PageContext): Promise<DiscoveredForm[]> {
    const forms = this.formsOf(context);
    if (page) for (const form of forms) form.validationMessages = await validationMessages(page, form.fields);
    return forms;
  }

  /** Les formulaires logiques d'un écran, à partir de ce qui y a été découvert (sans navigateur). */
  formsOf(context: PageContext): DiscoveredForm[] {
    const groups = new Map<string, DiscoveredAction[]>();
    for (const action of context.actions) {
      if (!action.formGroup) continue;
      const list = groups.get(action.formGroup) ?? [];
      list.push(action);
      groups.set(action.formGroup, list);
    }
    const forms: DiscoveredForm[] = [];
    for (const [group, actions] of groups) {
      const fields = actions
        .filter((action) => FIELD_ACTIONS.has(action.type) && action.category !== 'search')
        .map(fieldOf);
      if (fields.length === 0) continue;
      const submitActions = actions.filter(
        (action) =>
          action.type === 'click' &&
          (action.submitsForm === true || action.category === 'submit' || action.category === 'form-step'),
      );
      forms.push({
        id: `${context.stateId}:${group}`,
        stateId: context.stateId,
        group,
        name: formName(group, context),
        fields,
        submitActions,
        validationMessages: [],
        foreground: actions.some((action) => action.foreground === true),
      });
    }
    // Ce qui est devant l'écran d'abord.
    return forms.sort((a, b) => Number(b.foreground) - Number(a.foreground));
  }
}

/** Nom lisible d'un formulaire : le titre de la fenêtre, sinon celui de l'écran. */
export function formName(group: string, context: PageContext): string {
  if (group.startsWith('layer:')) return group.slice('layer:'.length);
  return context.dialogs[0] ?? context.headings[0] ?? context.title;
}

/** Le champ qu'une action découverte remplit, tel que le formulaire l'attend. */
export function fieldOf(action: DiscoveredAction): FormField {
  const field = action.field;
  const sensitivity = sensitivityOf({
    ...(field?.inputType !== undefined ? { inputType: field.inputType } : {}),
    ...(field?.autocomplete !== undefined ? { autocomplete: field.autocomplete } : {}),
    ...(field?.name !== undefined ? { name: field.name } : {}),
    ...(field?.label !== undefined ? { label: field.label } : action.label ? { label: action.label } : {}),
    ...(field?.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
  });
  const number = (value: string | undefined): number | undefined =>
    value !== undefined && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : undefined;
  const options: SelectOption[] | undefined = field?.options?.map((label) => ({
    label,
    disabled: field.disabledOptions?.includes(label) ?? false,
    placeholder: label.trim() === '' || PLACEHOLDER_OPTION.test(label.trim()),
  }));
  const optional = {
    name: field?.name,
    label: field?.label ?? action.label ?? action.text,
    groupLabel: field?.groupLabel,
    choiceGroup: field?.choiceGroup,
    min: number(field?.min),
    max: number(field?.max),
    minText: field?.min || undefined,
    maxText: field?.max || undefined,
    step: number(field?.step),
    minLength: field?.minLength,
    maxLength: field?.maxLength,
    pattern: field?.pattern,
    inputMode: field?.inputMode,
    options,
    placeholder: field?.placeholder,
    hint: field?.hint,
  };
  const result: FormField = {
    id: action.id,
    type: fieldTypeOf(action),
    required: field?.required ?? false,
    disabled: action.disabled,
    readonly: false,
    hasValue: field?.hasValue ?? false,
    sensitive: sensitivity.sensitive || action.risks.includes('sensitive-data'),
    payment: sensitivity.payment,
    locator: action.locator,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** La sémantique ARIA et HTML d'abord, les indices des frameworks (datepicker Material…) en repli. */
export function fieldTypeOf(action: DiscoveredAction): FieldType {
  const field = action.field;
  const input = field?.inputType ?? '';
  if (action.role === 'radio' || input === 'radio') return 'radio';
  if (action.role === 'checkbox' || action.role === 'switch' || input === 'checkbox') return 'checkbox';
  if (field?.customSelect) return 'combobox';
  if (input === 'select') return 'select';
  if (action.role === 'combobox' && action.type === 'fill') return 'autocomplete';
  if (field?.dateLike) return 'date';
  switch (input) {
    case 'textarea':
    case 'email':
    case 'password':
    case 'tel':
    case 'url':
    case 'number':
    case 'date':
    case 'time':
    case 'month':
    case 'week':
    case 'color':
    case 'range':
    case 'search':
      return input;
    case 'datetime-local':
      return 'datetime';
    case '':
    case 'text':
      return 'text';
    default:
      return 'other';
  }
}

async function validationMessages(page: Page, fields: FormField[]): Promise<ValidationMessage[]> {
  const messages: ValidationMessage[] = [];
  for (const field of fields) {
    if (field.sensitive) continue;
    const base = toLocator(page, field.locator);
    const locator = field.locator.nth !== undefined ? base.nth(field.locator.nth) : base.first();
    const validity = await validityOf(locator);
    if (validity?.message) messages.push({ fieldId: field.id, message: validity.message });
  }
  return messages;
}
