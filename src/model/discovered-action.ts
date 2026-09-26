/**
 * How risky it is to trigger an action automatically.
 * - SAFE: read-only navigation (links, tabs, pagination, filters, search).
 * - MUTATION: changes data (create, save, edit, submit a form...).
 * - DANGEROUS: destructive or irreversible (delete, pay, send, logout...).
 * - UNKNOWN: not recognised; treated as unsafe and never executed automatically.
 */
export const ACTION_CLASSIFICATIONS = ['SAFE', 'MUTATION', 'DANGEROUS', 'UNKNOWN'] as const;
export type ActionClassification = (typeof ACTION_CLASSIFICATIONS)[number];

export type ActionType = 'link' | 'button' | 'router-link' | 'input' | 'select' | 'textarea';

/** Raw facts about an interactive element, as extracted from the DOM (no classification yet). */
export interface RawAction {
  type: ActionType;
  /** Visible label: aria-label, text, value, title or placeholder. */
  text: string;
  /** Resolved absolute URL for links. */
  href?: string;
  /** Angular routerLink value, when present on the element. */
  routerLink?: string;
  tagName: string;
  /** `type` attribute of inputs/buttons. */
  inputType?: string;
  name?: string;
  elementId?: string;
  /** Human-readable CSS hint (not guaranteed unique). */
  selector: string;
  /** Position within the page's candidate elements, used to locate the element again. */
  index: number;
  visible: boolean;
  disabled: boolean;
  /** The element submits a form. */
  isSubmit: boolean;
  /** The enclosing form looks like a search/filter form (role=search, GET method, search input). */
  inSearchForm: boolean;
}

export interface DiscoveredAction extends RawAction {
  classification: ActionClassification;
  /** Why the SafetyPolicy chose this classification. */
  reason: string;
}

export type FieldTag = 'input' | 'select' | 'textarea';

/** A form field and its HTML constraints — the basis for future validation/boundary tests. */
export interface FormField {
  tag: FieldTag;
  /** input type (text, email, number, checkbox, radio...), or the tag for select/textarea. */
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
