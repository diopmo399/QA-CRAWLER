import { fieldOf } from '../forms/form-analyzer.js';
import { runTag, type FormField, type TestDataContext, type TestValue } from '../forms/form-model.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import { normalizeText } from '../policies/keywords.js';

/** What to do with a field when a form is prepared (legacy form, used by flows and prepareForm). */
export type FillInstruction =
  | { kind: 'fill'; value: string }
  /** label '' : the first real option (the options of a custom list are only known once it is open). */
  | { kind: 'select'; label: string }
  | { kind: 'check' }
  | { kind: 'skip'; reason: string };

/**
 * "Which synthetic data should I use?" Swappable: fixtures per application,
 * boundary-value generators, generators driven by an API contract…
 */
export interface TestDataProvider {
  generateValidValue(field: FormField, context: TestDataContext): Promise<TestValue>;
  /** Values the form should reject (validation testing), most telling first. */
  generateInvalidValues?(field: FormField, context: TestDataContext): Promise<TestValue[]>;
  /** Same as generateValidValue, for a discovered action (synchronous). */
  instructionFor(action: DiscoveredAction): FillInstruction;
}

/** Known values of the mission, by meaning rather than by field. */
export type SemanticKey =
  | 'firstName'
  | 'lastName'
  | 'name'
  | 'email'
  | 'phone'
  | 'company'
  | 'address'
  | 'city'
  | 'postalCode'
  | 'country'
  | 'url'
  | 'text';

export interface TestDataOptions {
  /** Short id of the run: created values carry QA-CRAWLER-<runId>. */
  runId?: string;
  /** Values by field label, name or placeholder (case, accents and "*" ignored). */
  fields?: Readonly<Record<string, string>>;
  /** Values by meaning (firstName, email, country…), for every field that means it. */
  defaults?: Readonly<Partial<Record<SemanticKey, string>>>;
  today?: () => Date;
}

const YES = new Set(['true', 'oui', 'yes', '1', 'x', 'coche', 'checked']);

/** How a field's name, label or placeholder tells what it means. Order matters: "prénom" before "nom". */
const SEMANTIC_RULES: readonly [SemanticKey, RegExp][] = [
  ['email', /(e-?mail|courriel)/],
  ['firstName', /(first ?name|given ?name|prenom|forename)/],
  ['lastName', /(last ?name|surname|family ?name|nom de famille|^nom\b|\bnom$)/],
  ['company', /(company|organi[sz]ation|entreprise|societe|raison sociale|employer)/],
  ['phone', /(phone|telephone|mobile|cellulaire|\btel\b)/],
  ['postalCode', /(zip|postal|code postal|\bcp\b)/],
  ['city', /(city|ville|town)/],
  ['country', /(country|pays)/],
  ['address', /(address|adresse|street|rue)/],
  ['url', /(website|site web|\burl\b)/],
  ['name', /(\bname\b|title|titre|libelle|intitule|designation)/],
];

/**
 * Deterministic, obviously synthetic values. Priority:
 *
 *   1. explicit configuration (testData.fields, by label/name/placeholder)
 *   2. field-specific rule (testData.defaults by meaning, the app's hints: "99999", "HH:MM")
 *   3. type-specific generator (email, number within min/max, date…)
 *   4. safe fallback ("QA Test")
 *
 * Names, titles and companies carry QA-CRAWLER-<runId>, e-mails
 * qa-crawler-<runId>@example.test: what the crawler creates can be found
 * (and cleaned) later. Sensitive fields (passwords, cards, secrets) are
 * never filled — even when a value is configured.
 */
export class DefaultTestDataProvider implements TestDataProvider {
  private readonly fields: ReadonlyMap<string, string>;
  private readonly defaults: Readonly<Partial<Record<SemanticKey, string>>>;
  private readonly runId: string;
  private readonly today: () => Date;

  constructor(options: TestDataOptions = {}) {
    this.fields = new Map(Object.entries(options.fields ?? {}).map(([key, value]) => [fieldKey(key), value]));
    this.defaults = options.defaults ?? {};
    this.runId = options.runId ?? 'run';
    this.today = options.today ?? (() => new Date());
  }

  /** Value the mission gives for this field, if any. */
  configured(field: Pick<FormField, 'label' | 'groupLabel' | 'name' | 'placeholder'>): string | undefined {
    for (const key of [field.label, field.groupLabel, field.name, field.placeholder]) {
      if (!key) continue;
      const value = this.fields.get(fieldKey(key));
      if (value !== undefined) return value;
    }
    return undefined;
  }

  generateValidValue(field: FormField, context: TestDataContext): Promise<TestValue> {
    return Promise.resolve(this.validValue(field, context.runId));
  }

  generateInvalidValues(field: FormField): Promise<TestValue[]> {
    return Promise.resolve(this.invalidValues(field));
  }

  instructionFor(action: DiscoveredAction): FillInstruction {
    if (!action.field) return { kind: 'skip', reason: 'not a form field' };
    if (action.type === 'uncheck') return { kind: 'skip', reason: 'already checked' };
    const value = this.validValue(fieldOf(action), this.runId);
    switch (value.kind) {
      case 'fill':
        return { kind: 'fill', value: value.value ?? '' };
      case 'select':
        return { kind: 'select', label: value.value ?? '' };
      case 'check':
        return { kind: 'check' };
      default:
        return { kind: 'skip', reason: value.reason ?? 'skipped' };
    }
  }

  /** The valid value of a field (synchronous core). */
  validValue(field: FormField, runId = this.runId): TestValue {
    if (field.sensitive || field.payment)
      return { kind: 'skip', source: 'fallback', reason: 'sensitive field: never filled automatically' };
    const configured = this.configured(field);
    if (configured === undefined && field.hasValue)
      return { kind: 'skip', source: 'fallback', reason: 'already filled' };

    switch (field.type) {
      case 'checkbox':
      case 'radio':
        if (field.choiceGroup !== undefined && field.groupLabel !== undefined && configured !== undefined) {
          // "Contact channel": "Phone" → this radio only if it is that option.
          const own = [field.label, field.name].some((key) => key && fieldKey(key) === fieldKey(configured));
          return own
            ? { kind: 'check', source: 'configured' }
            : { kind: 'skip', source: 'configured', reason: 'another option is configured' };
        }
        if (configured !== undefined)
          return YES.has(fieldKey(configured))
            ? { kind: 'check', source: 'configured' }
            : { kind: 'skip', source: 'configured', reason: 'configured: unchecked' };
        // Radios: one choice per group. Checkboxes: only what the form requires.
        return field.required || field.choiceGroup !== undefined
          ? { kind: 'check', source: 'type' }
          : { kind: 'skip', source: 'type', reason: 'optional choice' };
      case 'select':
      case 'combobox': {
        if (configured !== undefined) return { kind: 'select', value: configured, source: 'configured' };
        const semantic = this.semantic(field, runId);
        if (semantic && field.options?.some((option) => option.label === semantic.value))
          return { kind: 'select', value: semantic.value, source: 'rule' };
        if (field.type === 'combobox' && !field.options)
          return {
            kind: 'select',
            value: '',
            source: 'type',
            reason: 'first real option once the list is open',
          };
        const option = field.options?.find((candidate) => !candidate.placeholder && !candidate.disabled);
        return option
          ? { kind: 'select', value: option.label, source: 'type' }
          : { kind: 'skip', source: 'type', reason: 'no usable option' };
      }
      default: {
        if (configured !== undefined) return { kind: 'fill', value: configured, source: 'configured' };
        const hinted = this.fromHint(field);
        if (hinted !== undefined) return fitted(hinted, field, 'rule');
        const semantic = this.semantic(field, runId);
        if (semantic) return fitted(semantic.value, field, 'rule');
        const typed = this.byType(field, runId);
        if (typed !== undefined) return fitted(typed, field, 'type');
        return fitted('QA Test', field, 'fallback');
      }
    }
  }

  /**
   * Values the form should reject, most telling first: empty when required,
   * out of min/max, too short/long, wrong format. Never for sensitive fields.
   */
  invalidValues(field: FormField): TestValue[] {
    if (field.sensitive || field.payment || field.disabled || field.readonly) return [];
    if (['checkbox', 'radio', 'select', 'combobox'].includes(field.type)) {
      return field.required && field.type === 'checkbox'
        ? [{ kind: 'uncheck', source: 'type', case: 'required-unchecked' }]
        : [];
    }
    const cases: TestValue[] = [];
    const add = (value: string, name: string): void => {
      cases.push({ kind: 'fill', value, source: 'type', case: name });
    };
    if (field.required) add('', 'empty');
    switch (field.type) {
      case 'email':
        add('invalid-email', 'invalid-email');
        break;
      case 'url':
        add('not a url', 'invalid-url');
        break;
      case 'number':
      case 'range':
        if (field.min !== undefined) add(String(field.min - (field.step ?? 1)), 'below-min');
        if (field.max !== undefined) add(String(field.max + (field.step ?? 1)), 'above-max');
        break;
      default:
        break;
    }
    if (field.minLength !== undefined && field.minLength > 1)
      add('x'.repeat(field.minLength - 1), 'too-short');
    if (field.maxLength !== undefined) add('x'.repeat(field.maxLength + 1), 'too-long');
    if (field.pattern && !matches('QA invalid !', field.pattern)) add('QA invalid !', 'pattern-mismatch');
    return cases;
  }

  /** testData.defaults, then the built-in meaning of the field (names carry the run tag). */
  private semantic(field: FormField, runId: string): { key: SemanticKey; value: string } | undefined {
    const text = normalizeText(`${field.name ?? ''} ${field.label ?? ''} ${field.placeholder ?? ''}`);
    const key =
      field.type === 'email'
        ? 'email'
        : field.type === 'tel'
          ? 'phone'
          : field.type === 'url'
            ? 'url'
            : SEMANTIC_RULES.find(([, pattern]) => pattern.test(text))?.[0];
    if (!key) return undefined;
    const tag = runTag(runId);
    const builtIn: Record<SemanticKey, string> = {
      firstName: 'Qa',
      lastName: 'Crawler',
      name: tag,
      email: `qa-crawler-${runId.toLowerCase()}@example.test`,
      phone: '5550100',
      company: tag,
      address: '1 QA Street',
      city: 'Testville',
      postalCode: '75001',
      country: 'Canada',
      url: 'https://example.test',
      text: 'QA Test',
    };
    return { key, value: this.defaults[key] ?? builtIn[key] };
  }

  /** The application's own hints: "99999" (5 digits), "HH:MM", "AAAA-MM-JJ", "JJ/MM/AAAA"… */
  private fromHint(field: FormField): string | undefined {
    if (field.type !== 'text' && field.type !== 'textarea' && field.type !== 'date') return undefined;
    const shown = `${field.hint ?? ''} ${field.placeholder ?? ''}`;
    const digits = /(?:^|[^\w])([9#]{2,})(?:$|[^\w])/.exec(shown)?.[1];
    if (digits) return '1234567890'.repeat(3).slice(0, digits.length);
    if (/\b(HH|hh):(MM|mm)\b/.test(shown)) return '10:00';
    const format = dateFormat(shown);
    if (format) return formatDate(this.isoToday(field), format);
    return undefined;
  }

  private byType(field: FormField, runId: string): string | undefined {
    const today = this.isoToday(field);
    switch (field.type) {
      case 'email':
        return `qa-crawler-${runId.toLowerCase()}@example.test`;
      case 'tel':
        return '5550100';
      case 'url':
        return 'https://example.test';
      case 'number':
      case 'range':
        return numberWithin(field);
      case 'date':
        return today;
      case 'datetime':
        return `${today}T10:00`;
      case 'time':
        return '10:00';
      case 'month':
        return today.slice(0, 7);
      case 'week':
        return `${today.slice(0, 4)}-W10`;
      case 'color':
        return '#336699';
      case 'textarea':
        return `QA crawler test content (${runTag(runId)}).`;
      case 'search':
        return 'test';
      default:
        return undefined;
    }
  }

  /** Today, kept within the field's min/max dates. */
  private isoToday(field: FormField): string {
    const date = this.today().toISOString().slice(0, 10);
    if (field.minText && /^\d{4}-\d{2}-\d{2}/.test(field.minText) && date < field.minText)
      return field.minText;
    if (field.maxText && /^\d{4}-\d{2}-\d{2}/.test(field.maxText) && date > field.maxText)
      return field.maxText;
    return date;
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

function numberWithin(field: FormField): string {
  const { min, max } = field;
  const step = field.step !== undefined && field.step > 0 ? field.step : 1;
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

function matches(text: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'v').test(text);
  } catch {
    return true;
  }
}

/** Adjusts a text to minlength/maxlength and checks the pattern; skip if impossible. */
function fitted(value: string, field: FormField, source: TestValue['source']): TestValue {
  let text = value;
  if (field.minLength !== undefined && text.length < field.minLength)
    text = text.padEnd(field.minLength, 'x');
  if (field.maxLength !== undefined && text.length > field.maxLength) text = text.slice(0, field.maxLength);
  if (field.pattern && !matches(text, field.pattern))
    return { kind: 'skip', source, reason: 'no valid value satisfies the constraints' };
  return { kind: 'fill', value: text, source };
}
