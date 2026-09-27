import { KeywordMatcher, PAYMENT_FIELD_KEYWORDS, SENSITIVE_FIELD_KEYWORDS } from './keywords.js';

/** What a field says about itself, whatever the source (DOM snapshot, discovered action, OpenAPI). */
export interface FieldDescription {
  inputType?: string;
  autocomplete?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  elementId?: string;
}

export interface Sensitivity {
  /** Never logged, never reported with its value, never filled with real data, never stored. */
  sensitive: boolean;
  /** Payment data (card, IBAN, bank account…): never filled at all, and the SafetyPolicy blocks it. */
  payment: boolean;
  /** Why (the keyword or attribute that matched). */
  reason?: string;
}

const sensitiveWords = new KeywordMatcher(SENSITIVE_FIELD_KEYWORDS);
const paymentWords = new KeywordMatcher(PAYMENT_FIELD_KEYWORDS);
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
const PAYMENT_AUTOCOMPLETE = /^cc-/;

/**
 * The one place that decides whether a field is sensitive: passwords,
 * secrets, tokens, authorization, API keys, card numbers, CVV, bank
 * accounts, SIN/NAS, SSN… Used by the SafetyPolicy (classification), the
 * test data (never fill), the reports and the flow memory (never keep a value).
 */
export function sensitivityOf(field: FieldDescription): Sensitivity {
  const texts = [field.name, field.label, field.placeholder, field.elementId];
  const autocomplete = field.autocomplete ?? '';
  const payment = PAYMENT_AUTOCOMPLETE.test(autocomplete)
    ? 'autocomplete cc-*'
    : paymentWords.match(...texts);
  if (payment) return { sensitive: true, payment: true, reason: payment };
  if (field.inputType === 'password') return { sensitive: true, payment: false, reason: 'password field' };
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete))
    return { sensitive: true, payment: false, reason: `autocomplete ${autocomplete}` };
  const word = sensitiveWords.match(...texts);
  return word ? { sensitive: true, payment: false, reason: word } : { sensitive: false, payment: false };
}
