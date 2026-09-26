import type { Page } from 'playwright';
import type { FillInstruction, TestDataProvider } from '../data/test-data-provider.js';
import type { PlaywrightActionExecutor } from '../execution/playwright-action-executor.js';
import { toLocator } from '../execution/locator-resolver.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';

/** A field filled (or left empty) while exercising a form. */
export interface FilledField {
  action: DiscoveredAction;
  /** Value typed or option chosen; undefined for a checkbox/radio, or when left empty. */
  value?: string;
  /** Why the field was left as it is, or why filling it failed. */
  skipped?: string;
  error?: string;
}

/** A field still invalid once the form is filled: what the application says about it. */
export interface ValidationProblem {
  field: FilledField;
  message: string;
}

export interface FormRun {
  group: string;
  name: string;
  fields: FilledField[];
  problems: ValidationProblem[];
}

/** Time given to the application to show a field's error message once the field is left. */
const BLUR_SETTLE_MS = 100;

const FIELD_TYPES = new Set<DiscoveredAction['type']>(['fill', 'select', 'check']);

/**
 * Fills the forms of a screen the way a user would — a <form>, or the fields
 * of a dialog/overlay (Angular Material dialogs often have no <form>) — with
 * the mission's test data, then reads the validation messages the
 * application shows. It never clicks the button that sends the form: that
 * decision stays with the SafetyPolicy (`forms.submit`, `safety.block`).
 */
export class FormExerciser {
  constructor(
    private readonly executor: PlaywrightActionExecutor,
    private readonly testData: TestDataProvider,
    private readonly safety: SafetyPolicy,
  ) {}

  /** Forms of the screen that have at least one field to fill, what is in front first. */
  groupsOf(context: PageContext): string[] {
    const groups = new Map<string, boolean>();
    for (const action of this.fieldsOf(context)) {
      if (!action.formGroup || this.instruction(action).kind === 'skip') continue;
      groups.set(action.formGroup, (groups.get(action.formGroup) ?? false) || action.foreground === true);
    }
    return [...groups.entries()].sort((a, b) => Number(b[1]) - Number(a[1])).map(([group]) => group);
  }

  /** Fills every field of the form; nothing is sent. */
  async fill(page: Page, context: PageContext, group: string): Promise<FormRun> {
    const fields: FilledField[] = [];
    const answered = new Set<string>();
    for (const action of this.fieldsOf(context, group)) {
      if (this.safety.evaluate(action).verdict === 'BLOCK') {
        fields.push({ action, skipped: 'not allowed by the mission' });
        continue;
      }
      const instruction = this.instruction(action);
      if (instruction.kind === 'skip') {
        fields.push({ action, skipped: instruction.reason });
        continue;
      }
      // One option per radio group.
      const choice = action.field?.choiceGroup;
      if (action.type === 'check' && choice !== undefined && isRadio(action)) {
        if (answered.has(choice)) {
          fields.push({ action, skipped: 'another option of the group is chosen' });
          continue;
        }
        answered.add(choice);
      }
      const value =
        instruction.kind === 'fill'
          ? instruction.value
          : instruction.kind === 'select'
            ? instruction.label
            : undefined;
      const result = await this.executor.execute(page, action, value !== undefined ? { value } : {});
      if (action.type !== 'check') {
        // Leave the field like a user: its error message appears now (blur), not in the middle of the
        // next click, where it would move the next field under the pointer.
        await page
          .evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
          })
          .catch(() => undefined);
        await page.waitForTimeout(BLUR_SETTLE_MS).catch(() => undefined);
      }
      fields.push({
        action,
        ...(value ? { value } : {}),
        ...(result.status === 'FAILED' ? { error: result.error ?? 'failed' } : {}),
      });
    }
    return { group, name: formName(group, context), fields, problems: [] };
  }

  /**
   * Leaves each field (the application validates on blur: Angular "touched"),
   * then reads what is still invalid and the message shown next to it.
   */
  async validate(page: Page, run: FormRun): Promise<ValidationProblem[]> {
    const problems: ValidationProblem[] = [];
    const seen = new Set<string>();
    for (const field of run.fields) {
      const { action } = field;
      // Sensitive fields (never filled) and fields the mission forbids are not judged.
      if (action.risks.includes('sensitive-data') || field.skipped === 'not allowed by the mission') continue;
      const choice = action.field?.choiceGroup;
      if (choice !== undefined) {
        if (seen.has(choice)) continue;
        seen.add(choice);
      }
      const base = toLocator(page, action.locator);
      const locator = action.locator.nth !== undefined ? base.nth(action.locator.nth) : base.first();
      if ((await base.count().catch(() => 0)) === 0) continue;
      if (action.type !== 'check') {
        await locator.focus({ timeout: 1000 }).catch(() => undefined);
        await locator.blur({ timeout: 1000 }).catch(() => undefined);
      }
      const state = await locator.evaluate(readValidity).catch(() => undefined);
      if (state?.invalid) problems.push({ field, message: state.message || 'invalid value' });
    }
    return problems;
  }

  private fieldsOf(context: PageContext, group?: string): DiscoveredAction[] {
    return context.actions.filter(
      (action) =>
        FIELD_TYPES.has(action.type) &&
        action.formGroup !== undefined &&
        (group === undefined || action.formGroup === group) &&
        action.category !== 'search' &&
        !action.disabled &&
        !action.obscured,
    );
  }

  private instruction(action: DiscoveredAction): FillInstruction {
    return this.testData.instructionFor(action);
  }
}

function isRadio(action: DiscoveredAction): boolean {
  return action.field?.inputType === 'radio' || action.role === 'radio';
}

/** Readable name of a form: the dialog's title, else the screen's. */
export function formName(group: string, context: PageContext): string {
  if (group.startsWith('layer:')) return group.slice('layer:'.length);
  return context.dialogs[0] ?? context.headings[0] ?? context.title;
}

/**
 * Runs in the browser: is the field invalid, and which message does the
 * application show for it (mat-error, invalid-feedback, aria-errormessage…)?
 * The value itself is never read.
 */
function readValidity(el: Element): { invalid: boolean; message: string } {
  const ERRORS =
    'mat-error, .mat-mdc-form-field-error, .mat-error, .invalid-feedback, .error-message, .field-error, [role="alert"]';
  const CONTAINER =
    'mat-form-field, .mat-mdc-form-field, .mat-form-field, .form-group, .form-field, .field, [role="radiogroup"], mat-radio-group, fieldset';
  const visible = (node: Element): boolean => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return (rect.width > 0 || rect.height > 0) && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const text = (node: Element | null): string =>
    ((node as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const container = el.closest(CONTAINER) ?? el.parentElement;
  const described = [el.getAttribute('aria-errormessage'), el.getAttribute('aria-describedby')]
    .join(' ')
    .split(/\s+/)
    .map((id) => (id ? document.getElementById(id) : null))
    .filter((node): node is HTMLElement => node !== null && node.matches(ERRORS) && visible(node));
  const shown = [...described, ...Array.from(container?.querySelectorAll(ERRORS) ?? []).filter(visible)];
  const message = [...new Set(shown.map((node) => text(node)).filter(Boolean))].join(' ').slice(0, 160);
  const control = el as HTMLInputElement;
  const invalid =
    el.getAttribute('aria-invalid') === 'true' ||
    (typeof control.checkValidity === 'function' && !control.checkValidity()) ||
    message !== '';
  return { invalid, message: message || control.validationMessage };
}
