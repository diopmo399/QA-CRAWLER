import { REDACTED, redactText } from '../security/redactor.js';
import type { CrawlRunUpdate } from './model.js';
import type { PersistenceProvider } from './persistence-provider.js';

/**
 * RIEN DE SENSIBLE NE QUITTE LE PROCESSUS : chaque texte qui part vers un provider passe
 * par le redactor du crawler (URL, Bearer, JWT, Authorization/Cookie, password=…), puis
 * par des règles propres au stockage long terme (numéros de carte, IBAN). Les clés
 * d'objet sensibles (password, token, cookie…) sont retirées de context_json.
 */

const SENSITIVE_KEY =
  /(pass(word|wd)?|pwd|secret|token|authori[sz]ation|cookie|jwt|otp|api[-_]?key|cvv|cvc|card|iban|session|credential)/i;

/** Numéro de carte : 13 à 19 chiffres (espaces ou tirets possibles) qui passent la clé de Luhn. */
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
/** IBAN : code pays, clé, 11 à 30 caractères. */
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
/** Codes à usage unique et codes de carte recopiés : otp=…, pin: …, cvv=…, code de vérification… */
const ONE_TIME_CODE =
  /\b(otp|one[-_ ]?time[-_ ]?(?:code|password)|pin|cvv|cvc|mfa[-_ ]?code|2fa[-_ ]?code|verification[-_ ]?code|code de v[ée]rification)\s*[:=]\s*["']?[^\s"'&,;}]+/gi;

export function sanitizeText(text: string): string {
  return redactText(text)
    .replace(ONE_TIME_CODE, `$1=${REDACTED}`)
    .replace(CARD, (match) => (luhn(match.replace(/[ -]/g, '')) ? REDACTED : match))
    .replace(IBAN, REDACTED);
}

/** Un objet (context_json) : clés sensibles retirées, textes nettoyés, en profondeur. */
export function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, entry]) => [key, sanitizeValue(entry)]),
    );
  return value;
}

/** Tous les champs texte d'un enregistrement (et son contexte) nettoyés. */
export function sanitizeRecord<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      key === 'context' || (value !== null && typeof value === 'object')
        ? sanitizeValue(value)
        : typeof value === 'string'
          ? sanitizeText(value)
          : value,
    ]),
  ) as T;
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Enveloppe n'importe quel provider : toutes les écritures sont nettoyées avant de
 * l'atteindre. Le PersistenceManager ne donne jamais au crawler qu'un provider enveloppé.
 */
export function sanitizingProvider(provider: PersistenceProvider): PersistenceProvider {
  return {
    get kind() {
      return provider.kind;
    },
    get description() {
      return provider.description;
    },
    initialize: () => provider.initialize(),
    close: () => provider.close(),
    healthCheck: () => provider.healthCheck(),
    runs: {
      create: (run) => provider.runs.create(sanitizeRecord(run)),
      update: (id, update: CrawlRunUpdate) => provider.runs.update(id, sanitizeRecord(update)),
      get: (id) => provider.runs.get(id),
      list: (applicationId, limit) => provider.runs.list(sanitizeText(applicationId), limit),
    },
    states: {
      save: (states) => provider.states.save(states.map((state) => sanitizeRecord(state))),
      listByRun: (runId) => provider.states.listByRun(runId),
    },
    transitions: {
      add: (transitions) =>
        provider.transitions.add(transitions.map((transition) => sanitizeRecord(transition))),
      listByRun: (runId) => provider.transitions.listByRun(runId),
    },
    knowledge: {
      record: (observations) =>
        provider.knowledge.record(observations.map((observation) => sanitizeRecord(observation))),
      load: (applicationId, limit) => provider.knowledge.load(sanitizeText(applicationId), limit),
      find: (applicationId, from, action) =>
        provider.knowledge.find(sanitizeText(applicationId), sanitizeText(from), sanitizeText(action)),
    },
  };
}
