import { fieldOf } from '../forms/form-analyzer.js';
import { runTag, type FormField, type TestDataContext, type TestValue } from '../forms/form-model.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import { normalizeText } from '../policies/keywords.js';
import { SimpleBoundaryValueGenerator } from '../constraints/test-case-generators.js';

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
  /** Valeurs par libellé, name ou placeholder du champ (majuscules, accents, « * » et « : » final ignorés). */
  fields?: Readonly<Record<string, string>>;
  /** Valeurs par sens (firstName, email, country…), pour chaque champ qui a ce sens. */
  defaults?: Readonly<Partial<Record<SemanticKey, string>>>;
  /** Langue des données générées (report.language) : une personne, une adresse et des textes cohérents dans cette langue. */
  language?: 'fr' | 'en';
  today?: () => Date;
}

/** Une personne fictive et son adresse : toutes les valeurs d'un run vont ensemble. */
interface Persona {
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
}

/**
 * Personnes fictives aux noms courants, adresses plausibles et numéros réservés à la
 * fiction (555-01xx). Choisie par l'id du run : le même run donne toujours la même.
 */
const PERSONAS: Record<'fr' | 'en', readonly Persona[]> = {
  fr: [
    {
      firstName: 'Julie',
      lastName: 'Tremblay',
      phone: '5145550101',
      address: '1250 rue Principale',
      city: 'Montréal',
      postalCode: 'H2X 1Y4',
      country: 'Canada',
    },
    {
      firstName: 'Marc',
      lastName: 'Gagnon',
      phone: '4185550102',
      address: '45 avenue des Érables',
      city: 'Québec',
      postalCode: 'G1R 2K5',
      country: 'Canada',
    },
    {
      firstName: 'Sophie',
      lastName: 'Roy',
      phone: '8195550103',
      address: '300 boulevard Laurier',
      city: 'Gatineau',
      postalCode: 'J8T 3R7',
      country: 'Canada',
    },
    {
      firstName: 'Olivier',
      lastName: 'Côté',
      phone: '4505550104',
      address: '88 rue Saint-Charles',
      city: 'Longueuil',
      postalCode: 'J4H 1C8',
      country: 'Canada',
    },
    {
      firstName: 'Émilie',
      lastName: 'Bouchard',
      phone: '8195550105',
      address: '17 rue King Ouest',
      city: 'Sherbrooke',
      postalCode: 'J1H 1N9',
      country: 'Canada',
    },
    {
      firstName: 'Mathieu',
      lastName: 'Gauthier',
      phone: '4185550106',
      address: '560 rue Racine',
      city: 'Saguenay',
      postalCode: 'G7H 1S2',
      country: 'Canada',
    },
  ],
  en: [
    {
      firstName: 'Emily',
      lastName: 'Clark',
      phone: '4165550101',
      address: '120 Main Street',
      city: 'Toronto',
      postalCode: 'M5V 2T6',
      country: 'Canada',
    },
    {
      firstName: 'James',
      lastName: 'Wilson',
      phone: '6045550102',
      address: '45 Maple Avenue',
      city: 'Vancouver',
      postalCode: 'V6B 1A1',
      country: 'Canada',
    },
    {
      firstName: 'Sarah',
      lastName: 'Miller',
      phone: '6135550103',
      address: '300 Bank Street',
      city: 'Ottawa',
      postalCode: 'K2P 1X8',
      country: 'Canada',
    },
    {
      firstName: 'Daniel',
      lastName: 'Brown',
      phone: '4035550104',
      address: '88 Centre Street',
      city: 'Calgary',
      postalCode: 'T2G 5K3',
      country: 'Canada',
    },
    {
      firstName: 'Olivia',
      lastName: 'Taylor',
      phone: '7805550105',
      address: '17 Jasper Avenue',
      city: 'Edmonton',
      postalCode: 'T5J 1W8',
      country: 'Canada',
    },
    {
      firstName: 'Ryan',
      lastName: 'Anderson',
      phone: '9025550106',
      address: '560 Barrington Street',
      city: 'Halifax',
      postalCode: 'B3J 1Z1',
      country: 'Canada',
    },
  ],
};

/** Textes génériques, lisibles et reconnaissables comme des données de test. */
const TEXTS: Record<
  'fr' | 'en',
  { text: string; title: string; company: string; paragraph: string; fallback: string }
> = {
  fr: {
    text: 'Texte de test',
    title: 'Test',
    company: 'Entreprise Test',
    paragraph: 'Donnée de test saisie automatiquement par QA-Crawler',
    fallback: 'Valeur de test',
  },
  en: {
    text: 'Test text',
    title: 'Test',
    company: 'Test Company',
    paragraph: 'Test data entered automatically by QA-Crawler',
    fallback: 'Test value',
  },
};

/** Date de naissance, d'embauche… : ce sens appelle une date passée, pas aujourd'hui. */
const BIRTH_DATE = /(birth|naissance|\bdob\b|\bne le\b|\bnee le\b)/;

const boundaries = new SimpleBoundaryValueGenerator(12);

const YES = new Set(['true', 'oui', 'yes', '1', 'x', 'coche', 'checked']);

/** Comment le name, le libellé ou le placeholder d'un champ dit ce qu'il signifie. L'ordre compte : « prénom » avant « nom », « entreprise » avant « nom ». */
const SEMANTIC_RULES: readonly [SemanticKey, RegExp][] = [
  ['email', /(e-?mail|courriel)/],
  ['firstName', /(first ?name|given ?name|prenom|forename)/],
  // « Nom de la société » est une entreprise, pas un nom de famille : company avant lastName.
  ['company', /(company|organi[sz]ation|entreprise|societe|raison sociale|employer)/],
  ['lastName', /(last ?name|surname|family ?name|nom de famille|^nom\b|\bnom$)/],
  ['phone', /(phone|telephone|mobile|cellulaire|\btel\b)/],
  ['postalCode', /(zip|postal|code postal|\bcp\b)/],
  ['city', /(city|ville|town)/],
  ['country', /(country|pays)/],
  ['address', /(address|adresse|street|rue)/],
  ['url', /(website|site web|\burl\b)/],
  ['name', /(\bname\b|title|titre|libelle|intitule|designation)/],
];

/**
 * Valeurs déterministes, cohérentes et lisibles. Priorité :
 *
 *   1. configuration explicite (testData.fields, par libellé/name/placeholder)
 *   2. règle propre au champ (testData.defaults par sens, aides de l'application : "99999", "HH:MM")
 *   3. générateur propre au type (e-mail, nombre dans min/max, date…)
 *   4. valeur de repli sûre (« Valeur de test »)
 *
 * Une personne fictive par run (prénom, nom, e-mail, téléphone, adresse, ville, code
 * postal et pays qui vont ensemble), dans la langue du rapport ; une date de naissance
 * est dans le passé. Titres, entreprises et textes longs portent QA-CRAWLER-<runId>, les
 * e-mails prenom.nom.qa-crawler-<runId>@example.test : ce que le crawler crée peut être retrouvé
 * (et nettoyé) plus tard. Les champs sensibles (mots de passe, cartes, secrets) ne sont
 * jamais remplis — même quand une valeur est configurée.
 */
export class DefaultTestDataProvider implements TestDataProvider {
  private readonly fields: ReadonlyMap<string, string>;
  private readonly defaults: Readonly<Partial<Record<SemanticKey, string>>>;
  private readonly runId: string;
  private readonly today: () => Date;
  private readonly language: 'fr' | 'en';

  constructor(options: TestDataOptions = {}) {
    this.fields = new Map(Object.entries(options.fields ?? {}).map(([key, value]) => [fieldKey(key), value]));
    this.defaults = options.defaults ?? {};
    this.runId = options.runId ?? 'run';
    this.today = options.today ?? (() => new Date());
    this.language = options.language ?? 'en';
  }

  /** La personne fictive du run : la même pour tous les champs, d'un formulaire à l'autre. */
  private persona(runId: string): Persona {
    const pool = PERSONAS[this.language];
    let hash = 0;
    for (const char of runId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return pool[hash % pool.length] ?? (pool[0] as Persona);
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
        return fitted(TEXTS[this.language].fallback, field, 'fallback');
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
    if (field.type === 'email') add('invalid-email', 'invalid-email');
    if (field.type === 'url') add('not a url', 'invalid-url');
    // Bornes : les valeurs invalides du générateur de bornes (min − pas, max + pas, longueurs).
    const numeric = field.type === 'number' || field.type === 'range';
    const invalid = boundaries
      .generate({
        ...(numeric && field.min !== undefined ? { min: field.min } : {}),
        ...(numeric && field.max !== undefined ? { max: field.max } : {}),
        ...(field.step !== undefined ? { step: field.step } : {}),
        ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      })
      .filter((entry) => !entry.valid);
    for (const kind of ['below-min', 'above-max', 'too-short', 'too-long'])
      for (const entry of invalid) if (entry.kind === kind) add(entry.value, kind);
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
            : (SEMANTIC_RULES.find(([, pattern]) => pattern.test(text))?.[0] ??
              // Un champ muet (ni libellé ni name) dont le code et l'API prouvent le sens.
              staticKeyOf(field.staticConcept));
    if (!key) return undefined;
    const tag = runTag(runId);
    const person = this.persona(runId);
    const texts = TEXTS[this.language];
    // Une personne cohérente (nom, e-mail, téléphone, adresse vont ensemble) ; ce qui nomme
    // une donnée créée (titre, entreprise) garde le marqueur du run, pour la retrouver et la nettoyer.
    const builtIn: Record<SemanticKey, string> = {
      firstName: person.firstName,
      lastName: person.lastName,
      name: `${texts.title} ${tag}`,
      email: emailOf(person, runId),
      phone: person.phone,
      company: `${texts.company} ${tag}`,
      address: person.address,
      city: person.city,
      postalCode: person.postalCode,
      country: person.country,
      url: 'https://example.test',
      text: texts.text,
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
    if (format) return formatDate(this.dateFor(field), format);
    return undefined;
  }

  private byType(field: FormField, runId: string): string | undefined {
    const today = this.dateFor(field);
    switch (field.type) {
      case 'email':
        return emailOf(this.persona(runId), runId);
      case 'tel':
        return this.persona(runId).phone;
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
        return `${TEXTS[this.language].paragraph} (${runTag(runId)}).`;
      case 'search':
        return 'test';
      default:
        return undefined;
    }
  }

  /** La date d'un champ : aujourd'hui, ou il y a 35 ans pour une date de naissance ; toujours dans ses bornes. */
  private dateFor(field: FormField): string {
    const text = normalizeText(`${field.name ?? ''} ${field.label ?? ''} ${field.placeholder ?? ''}`);
    const now = this.today();
    const date = BIRTH_DATE.test(text)
      ? `${now.getUTCFullYear() - 35}${now.toISOString().slice(4, 10)}`.replace(/-02-29$/, '-02-28')
      : now.toISOString().slice(0, 10);
    return this.withinBounds(field, date);
  }

  /** Une date maintenue entre les dates min/max du champ. */
  private withinBounds(field: FormField, date: string): string {
    if (field.minText && /^\d{4}-\d{2}-\d{2}/.test(field.minText) && date < field.minText)
      return field.minText;
    if (field.maxText && /^\d{4}-\d{2}-\d{2}/.test(field.maxText) && date > field.maxText)
      return field.maxText;
    return date;
  }
}

/** Libellé tel qu'écrit dans le YAML ou à l'écran : majuscules, accents et marque d'obligation « * » ignorés. */
/** Clé de comparaison d'un libellé : sans « * », sans « : » final (« N° dossier : » = « N° dossier »). */
function fieldKey(text: string): string {
  return normalizeText(text.replace(/\*/g, ' ')).replace(/[\s:]+$/, '');
}

type DateFormat = 'iso' | 'dmy' | 'mdy';

function dateFormat(text: string): DateFormat | undefined {
  if (/\b(AAAA|YYYY|aaaa|yyyy)-(MM|mm)-(JJ|DD|jj|dd)\b/.test(text)) return 'iso';
  if (/\b(JJ|DD|jj|dd)\/(MM|mm)\/(AAAA|YYYY|aaaa|yyyy)\b/.test(text)) return 'dmy';
  if (/\b(MM|mm)\/(JJ|DD|jj|dd)\/(AAAA|YYYY|aaaa|yyyy)\b/.test(text)) return 'mdy';
  return undefined;
}

/** prenom.nom.qa-crawler-<runId>@example.test : lisible, cohérent avec la personne, retrouvable, domaine réservé aux tests. */
function emailOf(person: Persona, runId: string): string {
  const ascii = (text: string): string =>
    normalizeText(text)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${ascii(person.firstName)}.${ascii(person.lastName)}.qa-crawler-${ascii(runId)}@example.test`;
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

/** Le concept prouvé par l'analyse statique (vocabulaire) → la clé de données de test. */
const STATIC_CONCEPT_KEYS: Readonly<Record<string, SemanticKey>> = {
  email: 'email',
  phone: 'phone',
  firstName: 'firstName',
  lastName: 'lastName',
  fullName: 'name',
  company: 'company',
  address: 'address',
  city: 'city',
  postalCode: 'postalCode',
  country: 'country',
  website: 'url',
};

function staticKeyOf(concept: string | undefined): SemanticKey | undefined {
  return concept ? STATIC_CONCEPT_KEYS[concept] : undefined;
}
