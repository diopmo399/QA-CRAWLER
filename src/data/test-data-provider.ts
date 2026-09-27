import { fieldOf } from '../forms/form-analyzer.js';
import { runTag, type FormField, type TestDataContext, type TestValue } from '../forms/form-model.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import { normalizeText } from '../policies/keywords.js';

/** Que faire d'un champ quand un formulaire est préparé (ancienne forme, utilisée par les flows et prepareForm). */
export type FillInstruction =
  | { kind: 'fill'; value: string }
  /** label '' : la première vraie option (les options d'une liste personnalisée ne sont connues qu'une fois ouverte). */
  | { kind: 'select'; label: string }
  | { kind: 'check' }
  | { kind: 'skip'; reason: string };

/**
 * « Quelles données synthétiques utiliser ? » Remplaçable : jeux de données par
 * application, générateurs de valeurs limites, générateurs guidés par un contrat d'API…
 */
export interface TestDataProvider {
  generateValidValue(field: FormField, context: TestDataContext): Promise<TestValue>;
  /** Valeurs que le formulaire devrait refuser (tests de validation), les plus parlantes d'abord. */
  generateInvalidValues?(field: FormField, context: TestDataContext): Promise<TestValue[]>;
  /** Identique à generateValidValue, pour une action découverte (synchrone). */
  instructionFor(action: DiscoveredAction): FillInstruction;
}

/** Valeurs connues de la mission, par sens plutôt que par champ. */
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
  /** Id court du run : les valeurs créées portent QA-CRAWLER-<runId>. */
  runId?: string;
  /** Valeurs par libellé, name ou placeholder du champ (majuscules, accents et « * » ignorés). */
  fields?: Readonly<Record<string, string>>;
  /** Valeurs par sens (firstName, email, country…), pour chaque champ qui a ce sens. */
  defaults?: Readonly<Partial<Record<SemanticKey, string>>>;
  today?: () => Date;
}

const YES = new Set(['true', 'oui', 'yes', '1', 'x', 'coche', 'checked']);

/** Comment le name, le libellé ou le placeholder d'un champ dit ce qu'il signifie. L'ordre compte : « prénom » avant « nom ». */
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
 * Valeurs déterministes, visiblement synthétiques. Priorité :
 *
 *   1. configuration explicite (testData.fields, par libellé/name/placeholder)
 *   2. règle propre au champ (testData.defaults par sens, aides de l'application : "99999", "HH:MM")
 *   3. générateur propre au type (e-mail, nombre dans min/max, date…)
 *   4. valeur de repli sûre ("QA Test")
 *
 * Noms, titres et entreprises portent QA-CRAWLER-<runId>, les e-mails
 * qa-crawler-<runId>@example.test : ce que le crawler crée peut être retrouvé
 * (et nettoyé) plus tard. Les champs sensibles (mots de passe, cartes, secrets)
 * ne sont jamais remplis — même quand une valeur est configurée.
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

  /** Valeur donnée par la mission pour ce champ, s'il y en a une. */
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

  /** La valeur valide d'un champ (cœur synchrone). */
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
          // « Canal de contact » : « Téléphone » → cette radio seulement si c'est cette option.
          const own = [field.label, field.name].some((key) => key && fieldKey(key) === fieldKey(configured));
          return own
            ? { kind: 'check', source: 'configured' }
            : { kind: 'skip', source: 'configured', reason: 'another option is configured' };
        }
        if (configured !== undefined)
          return YES.has(fieldKey(configured))
            ? { kind: 'check', source: 'configured' }
            : { kind: 'skip', source: 'configured', reason: 'configured: unchecked' };
        // Radios : un choix par groupe. Cases à cocher : seulement ce que le formulaire exige.
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
        // Des chiffres attendus (inputmode numeric, motif de chiffres) : jamais un texte de repli.
        if (field.type !== 'number' && field.type !== 'range' && expectsDigits(field)) {
          if (semantic && /^\d+$/.test(semantic.value)) return fitted(semantic.value, field, 'rule');
          return fitted(digitsFor(field), field, 'type');
        }
        if (semantic) return fitted(semantic.value, field, 'rule');
        const typed = this.byType(field, runId);
        if (typed !== undefined) return fitted(typed, field, 'type');
        return fitted('QA Test', field, 'fallback');
      }
    }
  }

  /**
   * Valeurs que le formulaire devrait refuser, les plus parlantes d'abord : vide
   * quand il est obligatoire, hors min/max, trop court/long, mauvais format. Jamais pour les champs sensibles.
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

  /** testData.defaults, puis le sens intégré du champ (les noms portent le marqueur du run). */
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

  /** Les aides de l'application elle-même : "99999" (5 chiffres), "HH:MM", "AAAA-MM-JJ", "JJ/MM/AAAA"… */
  private fromHint(field: FormField): string | undefined {
    // Tout champ où l'on tape (texte, autocomplétion, recherche, date…) : l'aide de l'application prime.
    if (!['text', 'textarea', 'date', 'autocomplete', 'search', 'other'].includes(field.type))
      return undefined;
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

  /** Aujourd'hui, maintenu entre les dates min/max du champ. */
  private isoToday(field: FormField): string {
    const date = this.today().toISOString().slice(0, 10);
    if (field.minText && /^\d{4}-\d{2}-\d{2}/.test(field.minText) && date < field.minText)
      return field.minText;
    if (field.maxText && /^\d{4}-\d{2}-\d{2}/.test(field.maxText) && date > field.maxText)
      return field.maxText;
    return date;
  }
}

/** Libellé tel qu'écrit dans le YAML ou à l'écran : majuscules, accents et marque d'obligation « * » ignorés. */
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

/** Ajuste un texte à minlength/maxlength et vérifie le motif ; skip si c'est impossible. */
/** Motif réduit à des chiffres : \d{5}, [0-9]+, ^\d{3,6}$… ; renvoie la longueur imposée s'il y en a une. */
const DIGITS_PATTERN = /^\^?(?:\\d|\[0-9\])(?:\{(\d+)(?:,(\d*))?\}|[*+])?\$?$/;

/** Le champ attend des chiffres : inputmode numeric/decimal, ou un motif fait de chiffres. */
export function expectsDigits(field: FormField): boolean {
  const mode = (field.inputMode ?? '').toLowerCase();
  return mode === 'numeric' || mode === 'decimal' || DIGITS_PATTERN.test(field.pattern ?? '');
}

/** Une suite de chiffres de la bonne longueur : celle du motif, sinon maxlength (≤ 10), sinon minlength, sinon 5. */
function digitsFor(field: FormField): string {
  const fromPattern = DIGITS_PATTERN.exec(field.pattern ?? '')?.[1];
  const length = fromPattern
    ? Number(fromPattern)
    : field.maxLength !== undefined && field.maxLength <= 10
      ? field.maxLength
      : Math.max(field.minLength ?? 0, 5);
  return '1234567890'.repeat(3).slice(0, Math.max(1, length));
}

function fitted(value: string, field: FormField, source: TestValue['source']): TestValue {
  let text = value;
  if (field.minLength !== undefined && text.length < field.minLength)
    text = text.padEnd(field.minLength, 'x');
  if (field.maxLength !== undefined && text.length > field.maxLength) text = text.slice(0, field.maxLength);
  if (field.pattern && !matches(text, field.pattern))
    return { kind: 'skip', source, reason: 'no valid value satisfies the constraints' };
  return { kind: 'fill', value: text, source };
}
