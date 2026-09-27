import type { FormSummary } from './discovered-action.js';

/**
 * Facts about one interactive element, extracted from the DOM by the
 * UIObserver. Plain data: ActionDiscovery turns it into a DiscoveredAction
 * without needing a browser.
 */
export interface UiElement {
  /** Position among interactive elements (debugging only; never used to locate). */
  index: number;
  tag: string;
  /** Explicit or implicit ARIA role (button, link, tab, checkbox, combobox…), '' if none. */
  role: string;
  /** Accessible name (aria-label, aria-labelledby, label, text, title…). */
  name: string;
  /** Visible text content, whitespace-collapsed. */
  text: string;
  /** Text of the associated <label>, for form fields. */
  label?: string;
  testId?: string;
  inputType?: string;
  /** name attribute. */
  fieldName?: string;
  elementId?: string;
  /** Absolute URL of links. */
  href?: string;
  target?: string;
  routerLink?: string;
  autocomplete?: string;
  placeholder?: string;
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  checked?: boolean;
  /** aria-selected (tabs, options). */
  selected?: boolean;
  /** aria-expanded (menus, accordions). */
  expanded?: boolean;
  hasPopup: boolean;
  required: boolean;
  /** Submits its form. */
  isSubmit: boolean;
  /** Belongs to a search/filter form (role=search, GET form with a search field). */
  inSearchForm: boolean;
  /** Index of the enclosing <form>, if any. */
  formIndex?: number;
  /** The enclosing form posts to a server URL (action attribute). */
  formHasAction: boolean;
  /** Inside <nav>, role=navigation, menu or tablist. */
  inNavigation: boolean;
  inDialog: boolean;
  /** Name of the enclosing dialog, if any. */
  dialogName?: string;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Labels of the disabled options of a <select>. */
  disabledOptions?: string[];
  /** Option labels of a <select> (first 30). */
  options?: string[];
  /** The element targeted by the current imposed flow step. */
  flowTarget?: boolean;
  /** Form the element belongs to: `form:<index>` for a <form>, `layer:<name>` for a dialog/overlay. */
  formGroup?: string;
  /** A select that is not a native <select> (role combobox/listbox: Angular Material…). */
  customSelect?: boolean;
  /** The field already holds a value (the value itself is never read). */
  hasValue?: boolean;
  /** Help text of the field (mat-hint, aria-describedby): "99999", "HH:MM"… */
  hint?: string;
  /** The field opens a date picker. */
  dateLike?: boolean;
  /** Label of the group of a radio/checkbox ("Canal de contact"). */
  groupLabel?: string;
  /** Radios of the same choice share this key. */
  choiceGroup?: string;
  /** Inside a toast, a live region or a timer: comes and goes, not part of the screen's identity. */
  transient?: boolean;
  /** In front of the screen: inside a dialog, drawer, open menu or overlay layer. */
  foreground?: boolean;
  /** Behind a modal layer (backdrop, aria-modal): a click would land on the layer. */
  obscured?: boolean;
  /** Best-effort CSS selector (last-resort locator). */
  css: string;
}

/** Structured view of the current screen — never the raw HTML. */
export interface UiSnapshot {
  url: string;
  title: string;
  /** Visible h1–h3 / role=heading texts, in document order (max 12). */
  headings: string[];
  /** Accessible names of visible dialogs (modal, drawer…). */
  dialogs: string[];
  /** What the screen tells about the last action (read by the UIOracle). */
  signals?: UiSignals;
  /** Name of the layer that covers the page (modal, full-screen overlay), if any. */
  overlay?: string;
  /** Names of selected tabs (aria-selected=true). */
  selectedTabs: string[];
  /** Elements marked aria-current (active step, active menu entry). */
  currentItems: string[];
  /** Short excerpt of the visible text (max ~600 chars), for humans and future engines. */
  textExcerpt: string;
  elements: UiElement[];
  forms: FormSummary[];
}

/** Visible hints of how an action went. */
export interface UiSignals {
  /** Texts of visible alerts, error banners, snackbars (5 max). */
  alerts: string[];
  /** A spinner, progress bar or aria-busy region is visible. */
  busy: boolean;
  /** Nothing to read nor to do on the screen. */
  empty: boolean;
  /** Fields marked aria-invalid. */
  invalidFields: number;
}
