/**
 * VALUE CLASSIFIER, déterministe : quel genre de valeur le scénario veut saisir.
 * C'est un SIGNAL de score, jamais une certitude : « 4185551234 » est probablement un
 * téléphone, mais peut être un numéro métier — les deux lectures sont gardées.
 */

export const SEMANTIC_VALUE_TYPES = [
  'EMAIL',
  'PHONE',
  'DATE',
  'DATETIME',
  'TIME',
  'NUMBER',
  'INTEGER',
  'URL',
  'BOOLEAN',
  'ENUM',
  'TEXT',
  'UNKNOWN',
] as const;
export type SemanticValueType = (typeof SEMANTIC_VALUE_TYPES)[number];

export interface ValueClassification {
  type: SemanticValueType;
  /** 0..1 : à quel point ce type est probable. */
  confidence: number;
  /** Autres lectures possibles (« 4185551234 » : PHONE, sinon INTEGER). */
  alternatives: { type: SemanticValueType; confidence: number }[];
  reason: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL = /^(https?:\/\/|www\.)\S+$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const TIME = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const INTEGER = /^[-+]?\d+$/;
const NUMBER = /^[-+]?(\d+([.,]\d+)?|\d{1,3}([  ]\d{3})+([.,]\d+)?)$/;
const PHONE_FORMATTED = /^\+?[\d\s().-]{7,}$/;
const BOOLEAN = new Set(['true', 'false', 'oui', 'non', 'yes', 'no', 'vrai', 'faux', 'on', 'off']);

/**
 * Classe une valeur. Avec `options` (les choix d'une liste), une valeur qui en fait
 * partie est un ENUM.
 */
export function classifyValue(raw: string, options: readonly string[] = []): ValueClassification {
  const value = raw.trim();
  const result = (
    type: SemanticValueType,
    confidence: number,
    reason: string,
    alternatives: ValueClassification['alternatives'] = [],
  ): ValueClassification => ({ type, confidence, alternatives, reason });
  if (!value) return result('UNKNOWN', 0, 'empty value');
  if (options.some((option) => option.trim().toLowerCase() === value.toLowerCase()))
    return result('ENUM', 0.9, 'one of the available options');
  if (EMAIL.test(value)) return result('EMAIL', 0.95, 'local@domain.tld');
  if (URL.test(value)) return result('URL', 0.9, 'starts with http(s):// or www.');
  if (ISO_DATETIME.test(value)) return result('DATETIME', 0.9, 'ISO date and time');
  const iso = ISO_DATE.exec(value);
  if (iso && validDate(Number(iso[1]), Number(iso[2]), Number(iso[3])))
    return result('DATE', 0.9, 'ISO date (YYYY-MM-DD)');
  const dayFirst = DAY_FIRST_DATE.exec(value);
  if (dayFirst) {
    const [a, b, year] = [Number(dayFirst[1]), Number(dayFirst[2]), Number(dayFirst[3])];
    if (validDate(year, b, a) || validDate(year, a, b))
      // JJ/MM/AAAA ou MM/JJ/AAAA : c'est une date, le sens du jour et du mois reste ouvert.
      return result('DATE', 0.8, 'date with separators (day/month order not certain)');
  }
  if (TIME.test(value)) return result('TIME', 0.85, 'HH:MM');
  if (BOOLEAN.has(value.toLowerCase())) return result('BOOLEAN', 0.8, 'yes/no word');
  const digits = value.replace(/\D/g, '');
  if (INTEGER.test(value)) {
    // 10 ou 11 chiffres (numéro nord-américain, avec ou sans 1) : probablement un téléphone.
    if ((digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) && !value.startsWith('-'))
      return result('PHONE', 0.55, `${digits.length} digits: probably a phone number`, [
        { type: 'INTEGER', confidence: 0.45 },
      ]);
    return result('INTEGER', 0.9, 'whole number', [{ type: 'NUMBER', confidence: 0.9 }]);
  }
  if (NUMBER.test(value)) return result('NUMBER', 0.9, 'decimal number');
  if (PHONE_FORMATTED.test(value) && digits.length >= 7 && digits.length <= 15 && /[\s().+-]/.test(value))
    return result('PHONE', 0.8, 'digits with phone separators');
  return result('TEXT', 0.6, 'free text');
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export type Compatibility = 'compatible' | 'neutral' | 'conflict';

/** Types d'input HTML (ou de champ du FormAnalyzer) attendus par chaque genre de valeur. */
const EXPECTED_FIELDS: Partial<Record<SemanticValueType, readonly string[]>> = {
  EMAIL: ['email'],
  PHONE: ['tel'],
  DATE: ['date'],
  DATETIME: ['datetime-local', 'datetime'],
  TIME: ['time'],
  NUMBER: ['number', 'range'],
  INTEGER: ['number', 'range'],
  URL: ['url'],
  BOOLEAN: ['checkbox', 'radio'],
  ENUM: ['select', 'combobox', 'radio'],
};

/** Champs qui refusent un genre de valeur (le navigateur l'ignorerait ou la refuserait). */
const STRICT_FIELDS = new Set([
  'email',
  'number',
  'range',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'url',
  'color',
]);

/**
 * Une valeur de ce genre va-t-elle dans ce type de champ ? « compatible » (le champ
 * l'attend), « conflict » (le champ la refuserait : un courriel dans un champ numérique),
 * « neutral » sinon (un texte libre va partout où l'on tape du texte).
 */
export function valueFieldCompatibility(
  classification: ValueClassification,
  fieldType: string | undefined,
): Compatibility {
  if (!fieldType || classification.type === 'UNKNOWN') return 'neutral';
  const readings = [classification.type, ...classification.alternatives.map((alt) => alt.type)];
  if (readings.some((type) => EXPECTED_FIELDS[type]?.includes(fieldType))) return 'compatible';
  if (STRICT_FIELDS.has(fieldType)) return 'conflict';
  return 'neutral';
}
