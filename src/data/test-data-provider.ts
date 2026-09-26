import type { DiscoveredAction, FieldConstraints } from '../model/discovered-action.js';
import { KeywordMatcher, normalizeText, SENSITIVE_FIELD_KEYWORDS } from '../policies/keywords.js';

/** What to do with a field when a form is prepared. */
export type FillInstruction =
  | { kind: 'fill'; value: string }
  /** label '' : the first real option (the options of a custom list are only known once it is open). */
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

const YES = new Set(['true', 'oui', 'yes', '1', 'x', 'coche', 'checked']);

/**
 * Deterministic, obviously fake, valid-looking values — or the values the
 * mission gives per field (`testData.fields`, by label, name or placeholder).
 * Never fills passwords, payment or secret fields — even if asked to.
 */
export class DefaultTestDataProvider implements TestDataProvider {
  private readonly fields: ReadonlyMap<string, string>;

  constructor(
    private readonly today: () => Date = () => new Date(),
    fields: Readonly<Record<string, string>> = {},
  ) {
    this.fields = new Map(Object.entries(fields).map(([key, value]) => [fieldKey(key), value]));
  }

  /** Value the mission gives for this field, if any. */
  configured(field: FieldConstraints): string | undefined {
    for (const key of [field.label, field.groupLabel, field.name, field.placeholder]) {
      if (!key) continue;
      const value = this.fields.get(fieldKey(key));
      if (value !== undefined) return value;
    }
    return undefined;
  }

  instructionFor(action: DiscoveredAction): FillInstruction {
    const field = action.field;
    if (!field) return { kind: 'skip', reason: 'not a form field' };
    if (isSensitive(field)) return { kind: 'skip', reason: 'sensitive field: never filled automatically' };

    const configured = this.configured(field);
    if (configured === undefined && field.hasValue) return { kind: 'skip', reason: 'already filled' };
    switch (action.type) {
      case 'check':
        if (field.choiceGroup !== undefined && field.groupLabel !== undefined && configured !== undefined) {
          // "Canal de contact": "Téléphone" → this radio only if it is that option.
          const own = [field.label, field.name].some((key) => key && fieldKey(key) === fieldKey(configured));
          return own ? { kind: 'check' } : { kind: 'skip', reason: 'another option is configured' };
        }
        if (configured !== undefined)
          return YES.has(fieldKey(configured))
            ? { kind: 'check' }
            : { kind: 'skip', reason: 'configured: unchecked' };
        // Radios: one choice per group (the explorer checks the first option of each group).
        // Checkboxes: only what the form requires.
        return field.required || field.choiceGroup !== undefined
          ? { kind: 'check' }
          : { kind: 'skip', reason: 'optional choice' };
      case 'uncheck':
        return { kind: 'skip', reason: 'already checked' };
      case 'select': {
        if (configured !== undefined) return { kind: 'select', label: configured };
        if (field.customSelect) return { kind: 'select', label: '' };
        const option = (field.options ?? []).find(
          (label) => label !== '' && !/^(-+|choisir|select|choose|--)/i.test(label),
        );
        return option ? { kind: 'select', label: option } : { kind: 'skip', reason: 'no usable option' };
      }
      case 'fill': {
        const value = configured ?? this.valueFor(field);
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
    const shown = `${field.hint ?? ''} ${field.placeholder ?? ''}`;
    const today = this.today().toISOString().slice(0, 10);
    if (field.inputType === 'text' || field.inputType === 'textarea') {
      // Help text of the application: "99999" (5 digits), "HH:MM", "AAAA-MM-JJ", "JJ/MM/AAAA"…
      const digits = /(?:^|[^\w])([9#]{2,})(?:$|[^\w])/.exec(shown)?.[1];
      if (digits) return fitText('1234567890'.repeat(3).slice(0, digits.length), field);
      if (/\b(HH|hh):(MM|mm)\b/.test(shown)) return fitText('10:00', field);
      const date = dateFormat(shown);
      if (date || field.dateLike) return fitText(formatDate(today, date ?? 'iso'), field);
    }
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

/** Label as written in the YAML or on screen: case, accents, required marker "*" ignored. */
function fieldKey(text: string): string {
  return normalizeText(text.replace(/\*/g, ' '));
}

type DateFormat = 'iso' | 'dmy' | 'mdy';

function dateFormat(text: string): DateFormat | undefined {
  if (/\b(AAAA|YYYY|aaaa|yyyy)-(MM|mm)-(JJ|DD|jj|dd)\b/.test(text)) return 'iso';
  if (/\b(JJ|DD|jj|dd)\/(MM|mm)\/(AAAA|YYYY|aaaa|yyyy)\b/.test(text)) return 'dmy';
  if (/\b(MM|mm)\/(JJ|DD|jj|dd)\/(AAAA|YYYY|aaaa|yyyy)\b/.test(text)) return 'mdy';
  return undefined;
}

function formatDate(iso: string, format: DateFormat): string {
  const [year, month, day] = iso.split('-');
  if (format === 'dmy') return `${day}/${month}/${year}`;
  if (format === 'mdy') return `${month}/${day}/${year}`;
  return iso;
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
