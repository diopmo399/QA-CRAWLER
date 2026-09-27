import { createHash } from 'node:crypto';
import type {
  ActionCategory,
  ActionType,
  DiscoveredAction,
  FieldConstraints,
} from '../model/discovered-action.js';
import type { UiElement, UiSnapshot } from '../model/ui-snapshot.js';
import {
  DETAILS_KEYWORDS,
  FILTER_KEYWORDS,
  KeywordMatcher,
  PAGINATION_KEYWORDS,
  SEARCH_KEYWORDS,
  STEP_KEYWORDS,
  SUBMIT_KEYWORDS,
} from '../policies/keywords.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import { buildLocators } from './locator-builder.js';

const TEXT_INPUT_TYPES = new Set([
  'text',
  'email',
  'tel',
  'url',
  'search',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'password',
  'color',
  'range',
]);

const pagination = new KeywordMatcher(PAGINATION_KEYWORDS);
const details = new KeywordMatcher(DETAILS_KEYWORDS);
const search = new KeywordMatcher(SEARCH_KEYWORDS);
const filter = new KeywordMatcher(FILTER_KEYWORDS);
const step = new KeywordMatcher(STEP_KEYWORDS);
const submitWords = new KeywordMatcher(SUBMIT_KEYWORDS);

/**
 * "What can I do on this screen?"
 *
 * Turns the UIObserver snapshot into DiscoveredActions: what the user can
 * click, follow, fill, select or check, with a robust serializable locator,
 * a stable id, a functional category and the SafetyPolicy classification.
 * Pure function of the snapshot — it never touches the browser.
 */
export class ActionDiscovery {
  constructor(
    private readonly safetyPolicy: SafetyPolicy,
    private readonly maxActions = 200,
  ) {}

  discover(snapshot: UiSnapshot, stateId: string): DiscoveredAction[] {
    const locators = buildLocators(snapshot.elements);
    const actions: DiscoveredAction[] = [];
    const ids = new Set<string>();
    // Forms (a <form>, or a dialog/overlay) that hold at least one field.
    // Radio groups where an option is already chosen: left as they are.
    const answered = new Set(
      snapshot.elements
        .filter(
          (element) =>
            element.choiceGroup !== undefined &&
            element.checked === true &&
            (element.inputType === 'radio' || element.role === 'radio'),
        )
        .map((element) => element.choiceGroup),
    );
    // Forms that hold fields. The page itself counts as a form (SPA without <form>) only with at
    // least two text fields: a lone checkbox or list next to a "Create…" button is not a form.
    const textFields = new Map<string, number>();
    for (const element of snapshot.elements) {
      if (element.formGroup !== undefined && isTextField(element))
        textFields.set(element.formGroup, (textFields.get(element.formGroup) ?? 0) + 1);
    }
    const groupsWithFields = new Set(
      snapshot.elements
        .filter(
          (element) =>
            element.formGroup !== undefined &&
            isFieldElement(element) &&
            (element.formGroup !== 'page' || (textFields.get('page') ?? 0) >= 2),
        )
        .map((element) => element.formGroup),
    );

    snapshot.elements.forEach((element, position) => {
      if (actions.length >= this.maxActions) return;
      const type = actionType(element, snapshot.url);
      if (!type) return;
      const locator = locators[position];
      if (!locator) return;

      const href = targetHref(element, snapshot.url);
      const external =
        href !== undefined && !this.safetyPolicy.navigation.isAllowedHost(new URL(href).hostname);
      const category = actionCategory(element, type);
      const label = element.label ?? (element.name !== element.text ? element.name : undefined);
      const text = element.text || element.name || undefined;
      const submitsForm =
        type === 'click' &&
        !element.inSearchForm &&
        element.formGroup !== undefined &&
        groupsWithFields.has(element.formGroup) &&
        (element.isSubmit || submitWords.match(element.name, element.text) !== undefined);
      const classification = this.safetyPolicy.classify({
        type,
        category,
        ...(text ? { text } : {}),
        ...(label ? { label } : {}),
        ...(element.fieldName ? { name: element.fieldName } : {}),
        ...(element.elementId ? { elementId: element.elementId } : {}),
        ...(href ? { href } : {}),
        ...(element.routerLink ? { routerLink: element.routerLink } : {}),
        role: element.role,
        ...(element.inputType ? { inputType: element.inputType } : {}),
        ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
        ...(element.placeholder ? { placeholder: element.placeholder } : {}),
        isSubmit: element.isSubmit,
        inSearchForm: element.inSearchForm,
        formHasAction: element.formHasAction,
        ...(element.dialogName ? { dialogName: element.dialogName } : {}),
        ...(submitsForm ? { submitsForm } : {}),
        external,
      });

      const id = actionId(stateId, type, element.role, element.name, href, locator.nth);
      if (ids.has(id)) return;
      ids.add(id);

      actions.push({
        id,
        stateId,
        type,
        category,
        elementType: element.tag === 'input' ? `input[${element.inputType ?? 'text'}]` : element.tag,
        ...(element.role ? { role: element.role } : {}),
        ...(text ? { text } : {}),
        ...(label ? { label } : {}),
        ...(href ? { href } : {}),
        ...(element.fieldName ? { name: element.fieldName } : {}),
        disabled: element.disabled || element.readOnly,
        ...(element.selected !== undefined ? { selected: element.selected } : {}),
        visible: element.visible,
        ...classification,
        locator,
        ...(locator.strategy !== 'css' ? { fallback: { strategy: 'css' as const, value: element.css } } : {}),
        ...(element.dialogName ? { dialogName: element.dialogName } : {}),
        ...(element.formGroup && groupsWithFields.has(element.formGroup)
          ? { formGroup: element.formGroup }
          : {}),
        ...(submitsForm ? { submitsForm: true } : {}),
        ...(element.foreground ? { foreground: true } : {}),
        ...(element.obscured ? { obscured: true } : {}),
        ...(element.formIndex !== undefined ? { formIndex: element.formIndex } : {}),
        ...(external ? { external } : {}),
        ...(isField(type)
          ? {
              field: fieldConstraints(
                element.choiceGroup !== undefined && answered.has(element.choiceGroup)
                  ? { ...element, hasValue: true }
                  : element,
              ),
            }
          : {}),
      });
    });
    return actions;
  }
}

/** Field where a value is typed (not a checkbox, radio or list). */
function isTextField(element: UiElement): boolean {
  if (element.tag === 'textarea' || element.editable === true) return true;
  return (
    element.tag === 'input' &&
    TEXT_INPUT_TYPES.has(element.inputType ?? 'text') &&
    element.inputType !== 'search'
  );
}

function isFieldElement(element: UiElement): boolean {
  return (
    ['input', 'select', 'textarea'].includes(element.tag) ||
    element.customSelect === true ||
    element.editable === true
  );
}

function isField(type: ActionType): boolean {
  return type === 'fill' || type === 'select' || type === 'check' || type === 'uncheck';
}

function actionType(element: UiElement, pageUrl: string): ActionType | undefined {
  const { tag, role, inputType } = element;
  if (tag === 'a') {
    if (targetHref(element, pageUrl)) return 'navigate';
    // href="#section" only scrolls; href="#" / javascript: usually carries a click handler.
    return isScrollAnchor(element.href, pageUrl) ? undefined : 'click';
  }
  if (element.routerLink && tag !== 'button') return 'navigate';
  if (tag === 'select' || element.customSelect) return 'select';
  if (tag === 'textarea' || element.editable) return element.readOnly ? undefined : 'fill';
  if (tag === 'input') {
    if (inputType === 'checkbox' || inputType === 'radio') {
      if (element.checked) return inputType === 'checkbox' ? 'uncheck' : undefined;
      return 'check';
    }
    if (inputType === 'reset' || inputType === 'file') return undefined;
    if (['button', 'submit', 'image'].includes(inputType ?? '')) return 'click';
    if (TEXT_INPUT_TYPES.has(inputType ?? 'text')) return element.readOnly ? undefined : 'fill';
    return undefined;
  }
  if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') {
    return element.checked ? 'uncheck' : 'check';
  }
  if (role === 'radio' || role === 'menuitemradio') return element.checked ? undefined : 'check';
  return 'click';
}

function isScrollAnchor(href: string | undefined, pageUrl: string): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, pageUrl);
    const page = new URL(pageUrl);
    return (
      url.hash.length > 1 &&
      !/^#!?\//.test(url.hash) &&
      url.pathname === page.pathname &&
      url.search === page.search
    );
  } catch {
    return false;
  }
}

/** Absolute http(s) URL of a link or routerLink, if any. */
function targetHref(element: UiElement, pageUrl: string): string | undefined {
  const raw =
    element.href ?? (element.routerLink && element.tag !== 'button' ? element.routerLink : undefined);
  if (!raw) return undefined;
  try {
    const path = element.href
      ? raw
      : raw.includes(',')
        ? raw
            .split(',')
            .join('/')
            .replace(/\/{2,}/g, '/')
        : raw;
    const url = new URL(path, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    // In-page anchors (#section) are not navigations; hash routes (#/users) are.
    const page = new URL(pageUrl);
    if (
      url.hash &&
      !/^#!?\//.test(url.hash) &&
      url.pathname === page.pathname &&
      url.search === page.search
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function actionCategory(element: UiElement, type: ActionType): ActionCategory {
  const label = [element.name, element.text, element.label, element.fieldName].filter(Boolean).join(' ');
  if (isField(type)) {
    if (element.inputType === 'search' || element.role === 'searchbox' || element.inSearchForm)
      return 'search';
    if (type === 'select' && filter.match(label)) return 'filter';
    return 'form-input';
  }
  if (element.role === 'tab') return 'tab';
  if (element.role.startsWith('menuitem') || element.hasPopup) return 'menu';
  if (type === 'navigate') {
    if (pagination.match(label) || /^\d+$/.test(label.trim())) return 'pagination';
    // Links of a navigation landmark (main menu, sidebar) are global entry points.
    if (element.inNavigation) return 'menu';
    if (details.match(label)) return 'details';
    return 'navigation';
  }
  if (element.inSearchForm || search.match(label)) return 'search';
  if (filter.match(label)) return 'filter';
  if (element.formIndex !== undefined && step.match(label)) return 'form-step';
  if (element.isSubmit) return 'submit';
  if (pagination.match(label) || /^\d+$/.test(label.trim())) return 'pagination';
  if (details.match(label)) return 'details';
  if (element.expanded !== undefined) return 'toggle';
  if (element.inNavigation) return 'navigation';
  return 'other';
}

function fieldConstraints(element: UiElement): FieldConstraints {
  const constraints: FieldConstraints = {
    inputType:
      element.tag === 'input' ? (element.inputType ?? 'text') : element.editable ? 'textarea' : element.tag,
    required: element.required,
  };
  const optional: Partial<FieldConstraints> = {
    min: element.min,
    max: element.max,
    step: element.step,
    minLength: element.minLength,
    maxLength: element.maxLength,
    pattern: element.pattern,
    options: element.options,
    disabledOptions: element.disabledOptions,
    autocomplete: element.autocomplete,
    name: element.fieldName,
    label: element.label ?? element.name,
    placeholder: element.placeholder,
    hint: element.hint,
    hasValue: element.hasValue,
    dateLike: element.dateLike,
    customSelect: element.customSelect,
    groupLabel: element.groupLabel,
    choiceGroup: element.choiceGroup,
  };
  for (const [key, value] of Object.entries(optional) as [keyof FieldConstraints, unknown][]) {
    if (value !== undefined && value !== '') (constraints as unknown as Record<string, unknown>)[key] = value;
  }
  return constraints;
}

/**
 * Stable action id: same state, same kind of action on the same element
 * (role + accessible name + target) ⇒ same id, run after run.
 */
export function actionId(
  stateId: string,
  type: ActionType,
  role: string,
  name: string,
  href: string | undefined,
  nth: number | undefined,
): string {
  const key = [stateId, type, role, name.toLowerCase(), href ?? '', nth ?? 0].join('␟');
  return `a-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}
