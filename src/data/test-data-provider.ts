import type { DiscoveredAction, FieldConstraints } from '../model/discovered-action.js';
import { KeywordMatcher, SENSITIVE_FIELD_KEYWORDS } from '../policies/keywords.js';

/** What to do with a field when a form is prepared. */
export type FillInstruction =
  | { kind: 'fill'; value: string }
  | { kind: 'select'; label: string }
  | { kind: 'check' }
  | { kind: 'skip'; reason: string };

/**
 * Provides values for form fields. Swappable (fixtures per application,
 * boundary-value generators, invalid-data generators for validation tests).
 */
export interface TestDataProvider {
  instructionFor(action: DiscoveredAction): FillInstruction;
}

const sensitive = new KeywordMatcher(SENSITIVE_FIELD_KEYWORDS);

/**
 * Deterministic, obviously fake, valid-looking values.
 * Never fills passwords, payment or secret fields — even if asked to.
 */
export class DefaultTestDataProvider implements TestDataProvider {
  constructor(private readonly today: () => Date = () => new Date()) {}

  instructionFor(action: DiscoveredAction): FillInstruction {
    const field = action.field;
    if (!field) return { kind: 'skip', reason: 'not a form field' };
    if (isSensitive(field)) return { kind: 'skip', reason: 'sensitive field: never filled automatically' };

    switch (action.type) {
      case 'check':
        // Only what the form requires: required checkboxes, and a choice in required radio groups.
        return field.required ? { kind: 'check' } : { kind: 'skip', reason: 'optional choice' };
      case 'uncheck':
        return { kind: 'skip', reason: 'already checked' };
      case 'select': {
        const option = (field.options ?? []).find(
          (label) => label !== '' && !/^(-+|choisir|select|choose|--)/i.test(label),
        );
        return option ? { kind: 'select', label: option } : { kind: 'skip', reason: 'no usable option' };
      }
      case 'fill': {
        const value = this.valueFor(field);
        return value === undefined
          ? { kind: 'skip', reason: 'no valid value satisfies the constraints' }
          : { kind: 'fill', value };
      }
      default:
        return { kind: 'skip', reason: 'not a field action' };
    }
  }

  valueFor(field: FieldConstraints): string | undefined {
    const hint = `${field.name ?? ''} ${field.label ?? ''} ${field.placeholder ?? ''}`.toLowerCase();
    let value: string;
    switch (field.inputType) {
      case 'email':
        value = 'qa-crawler@example.test';
        break;
      case 'tel':
        value = '0100000000';
        break;
      case 'url':
        value = 'https://example.test';
        break;
      case 'number':
      case 'range':
        return numberWithin(field);
      case 'date':
        return clampDate(this.today().toISOString().slice(0, 10), field);
      case 'datetime-local':
        return `${clampDate(this.today().toISOString().slice(0, 10), field)}T10:00`;
      case 'time':
        value = '10:00';
        break;
      case 'month':
        value = this.today().toISOString().slice(0, 7);
        break;
      case 'week':
        value = `${this.today().getUTCFullYear()}-W10`;
        break;
      case 'color':
        value = '#336699';
        break;
      case 'textarea':
        value = 'QA crawler test content.';
        break;
      case 'search':
        value = 'test';
        break;
      default:
        value = /mail/.test(hint)
          ? 'qa-crawler@example.test'
          : /(zip|postal|cp\b|code postal)/.test(hint)
            ? '75001'
            : /(city|ville)/.test(hint)
              ? 'Testville'
              : /(first|prenom|prénom)/.test(hint)
                ? 'Qa'
                : /(last|nom|name)/.test(hint)
                  ? 'Crawler'
                  : 'QA Test';
    }
    return fitText(value, field);
  }
}

function isSensitive(field: FieldConstraints): boolean {
  return (
    field.inputType === 'password' ||
    /^(cc-|current-password|new-password|one-time-code)/.test(field.autocomplete ?? '') ||
    sensitive.match(field.name, field.label, field.placeholder) !== undefined
  );
}

function numberWithin(field: FieldConstraints): string {
  const min = field.min !== undefined && field.min !== '' ? Number(field.min) : undefined;
  const max = field.max !== undefined && field.max !== '' ? Number(field.max) : undefined;
  const step = field.step !== undefined && field.step !== '' && field.step !== 'any' ? Number(field.step) : 1;
  let value =
    min !== undefined && max !== undefined
      ? (min + max) / 2
      : min !== undefined
        ? min + step
        : max !== undefined
          ? Math.min(max, 1)
          : 1;
  const base = min ?? 0;
  value = base + Math.round((value - base) / step) * step;
  if (max !== undefined && value > max) value = max;
  if (min !== undefined && value < min) value = min;
  return String(Number(value.toFixed(6)));
}

function clampDate(date: string, field: FieldConstraints): string {
  if (field.min && date < field.min) return field.min;
  if (field.max && date > field.max) return field.max;
  return date;
}

/** Adjusts a text to minlength/maxlength and checks the pattern; undefined if impossible. */
function fitText(value: string, field: FieldConstraints): string | undefined {
  let text = value;
  if (field.minLength !== undefined && text.length < field.minLength)
    text = text.padEnd(field.minLength, 'x');
  if (field.maxLength !== undefined && text.length > field.maxLength) text = text.slice(0, field.maxLength);
  if (field.pattern) {
    try {
      if (!new RegExp(`^(?:${field.pattern})$`, 'v').test(text)) return undefined;
    } catch {
      return undefined;
    }
  }
  return text;
}
