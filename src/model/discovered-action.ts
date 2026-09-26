import type { LocatorDescriptor } from './locator.js';

/**
 * How risky it is to trigger an action automatically.
 * - SAFE: read-only (navigation, tabs, details, pagination, search, filters, filling a field).
 * - MUTATION: changes data (create, save, edit, submit a form…).
 * - DANGEROUS: destructive or irreversible (delete, pay, send, logout, sensitive data…).
 * - UNKNOWN: not recognised; treated as unsafe and never executed automatically.
 */
export const ACTION_CLASSIFICATIONS = ['SAFE', 'MUTATION', 'DANGEROUS', 'UNKNOWN'] as const;
export type ActionClassification = (typeof ACTION_CLASSIFICATIONS)[number];

/** What the executor does with the element. */
export const ACTION_TYPES = ['click', 'navigate', 'fill', 'select', 'check', 'uncheck'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Functional intent, used by the decision engine (priorities) and the safety policy (mission allow-list). */
export const ACTION_CATEGORIES = [
  'navigation',
  'tab',
  'menu',
  'details',
  'pagination',
  'search',
  'filter',
  'form-input',
  'form-step',
  'submit',
  'toggle',
  'other',
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/** Why an action is risky; names usable in the mission's `safety.block` list. */
export const RISK_KINDS = [
  'delete',
  'payment',
  'send',
  'logout',
  'irreversible',
  'sensitive-data',
  'external-navigation',
  'form-submit',
  'mutation',
  'download',
] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

/** HTML constraints of a form field — input of the TestDataProvider and of future validation tests. */
export interface FieldConstraints {
  inputType: string;
  required: boolean;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  options?: string[];
  autocomplete?: string;
  name?: string;
  label?: string;
  placeholder?: string;
}

/** A user action available on a given state. Plain, serializable data. */
export interface DiscoveredAction {
  /** Stable id: same state + same element ⇒ same id across runs. */
  id: string;
  stateId: string;
  type: ActionType;
  category: ActionCategory;
  /** tag, or tag[type] for inputs (a, button, input[email], select…). */
  elementType: string;
  role?: string;
  text?: string;
  label?: string;
  href?: string;
  /** name attribute of fields. */
  name?: string;
  disabled: boolean;
  visible: boolean;
  /** aria-selected (tabs): clicking a selected tab changes nothing. */
  selected?: boolean;
  classification: ActionClassification;
  /** Why the SafetyPolicy chose this classification. */
  reason: string;
  risks: RiskKind[];
  locator: LocatorDescriptor;
  /** CSS locator used when the preferred one no longer matches. */
  fallback?: LocatorDescriptor;
  /** Name of the dialog the element belongs to. */
  dialogName?: string;
  /** Enclosing form, if any. */
  formIndex?: number;
  /** Link target outside the allowed hosts. */
  external?: boolean;
  /** Constraints for fill/select/check actions. */
  field?: FieldConstraints;
}

/** Short form of an action, stored in the flow graph and reports. */
export interface ActionSummary {
  type: ActionType;
  category: ActionCategory;
  text?: string;
  label?: string;
  href?: string;
  classification: ActionClassification;
}

export function summarizeAction(action: DiscoveredAction): ActionSummary {
  return {
    type: action.type,
    category: action.category,
    classification: action.classification,
    ...(action.text ? { text: action.text } : {}),
    ...(action.label ? { label: action.label } : {}),
    ...(action.href ? { href: action.href } : {}),
  };
}

/** Human label of an action for logs: its text, label or name. */
export function actionLabel(
  action: Pick<DiscoveredAction, 'text' | 'label' | 'name' | 'elementType'>,
): string {
  return action.text || action.label || action.name || action.elementType;
}

export type FieldTag = 'input' | 'select' | 'textarea';

export interface FormField {
  tag: FieldTag;
  /** input type (text, email, number, checkbox, radio…), or the tag for select/textarea. */
  type: string;
  name?: string;
  elementId?: string;
  label?: string;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Option labels for select elements (truncated). */
  options?: string[];
}

export interface DiscoveredForm {
  /** Index among the page's forms; -1 groups fields that are not inside a <form>. */
  index: number;
  name?: string;
  elementId?: string;
  /** Redacted absolute action URL. */
  action?: string;
  method: string;
  isSearchForm: boolean;
  submitLabel?: string;
  fields: FormField[];
}
