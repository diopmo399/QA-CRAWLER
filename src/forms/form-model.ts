import type { DiscoveredAction } from '../model/discovered-action.js';
import type { LocatorDescriptor } from '../model/locator.js';

/** Kind of value a field expects. */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'password',
  'tel',
  'url',
  'number',
  'date',
  'time',
  'datetime',
  'month',
  'week',
  'color',
  'range',
  'search',
  'select',
  'combobox',
  'autocomplete',
  'checkbox',
  'radio',
  'other',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface SelectOption {
  label: string;
  disabled: boolean;
  /** "--", "Choose…": not a real choice. */
  placeholder: boolean;
}

/**
 * One field of a logical form, as the form expects it. Its value is never
 * read; sensitive fields are marked and never filled with real data.
 */
export interface FormField {
  /** Stable within the form (the id of the action that fills it). */
  id: string;
  name?: string;
  label?: string;
  /** Label of the group (radio buttons: "Contact channel"). */
  groupLabel?: string;
  /** Radios sharing one choice. */
  choiceGroup?: string;
  type: FieldType;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  min?: number;
  max?: number;
  /** min/max as written (dates, times: "2026-01-01"). */
  minText?: string;
  maxText?: string;
  step?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  options?: SelectOption[];
  placeholder?: string;
  /** Help text shown by the application ("99999", "HH:MM"). */
  hint?: string;
  /** Holds a value already (the value itself is never read). */
  hasValue: boolean;
  sensitive: boolean;
  /** Card, IBAN, bank account…: never filled, whatever the source. */
  payment: boolean;
  locator: LocatorDescriptor;
}

/** A message the application shows about a field ("This field is required"). */
export interface ValidationMessage {
  fieldId: string;
  message: string;
}

/**
 * One logical form: the fields a user fills together and the buttons that
 * send or move it forward — a <form>, a dialog, an overlay, or the page
 * itself when a single-page application has no <form> at all.
 */
export interface DiscoveredForm {
  /** `<stateId>:<group>` */
  id: string;
  stateId: string;
  /** form:<index>, layer:<name> or page. */
  group: string;
  /** Readable name: the dialog's title, else the screen's. */
  name: string;
  fields: FormField[];
  /** Buttons that send the form or move a wizard forward. */
  submitActions: DiscoveredAction[];
  validationMessages: ValidationMessage[];
  /** In front of the screen (dialog, drawer). */
  foreground: boolean;
}

/** One step of a fill plan. Sensitive fields never get a value here. */
export interface FormFillOperation {
  fieldId: string;
  operation: 'fill' | 'select' | 'check' | 'uncheck' | 'skip';
  /** Typed value or option label ('' = first real option). Never set for a sensitive field. */
  value?: string;
  /** Where the value comes from. */
  source?: TestValueSource;
  reason?: string;
}

/** What to do with a form: computed by a FormFillStrategy, executed by the PlaywrightActionExecutor. */
export interface FormFillPlan {
  formId: string;
  operations: FormFillOperation[];
}

/** configured (testData.fields) > rule (testData.defaults, semantic rules) > type > fallback. */
export type TestValueSource = 'configured' | 'rule' | 'type' | 'fallback';

/** A value for a field, and why. `skip`: left as it is. */
export interface TestValue {
  kind: 'fill' | 'select' | 'check' | 'uncheck' | 'skip';
  value?: string;
  source: TestValueSource;
  reason?: string;
  /** Validation cases: what makes the value invalid ("empty", "above-max"…). */
  case?: string;
}

/** What a TestDataProvider may know about the run. */
export interface TestDataContext {
  /** Short id of the run; every created value carries QA-CRAWLER-<runId> when possible. */
  runId: string;
  formName?: string;
  stateId?: string;
}

/** The tag that makes created data identifiable (and, later, cleanable). */
export function runTag(runId: string): string {
  return `QA-CRAWLER-${runId}`;
}
