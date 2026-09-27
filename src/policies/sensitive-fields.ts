import { KeywordMatcher, PAYMENT_FIELD_KEYWORDS, SENSITIVE_FIELD_KEYWORDS } from './keywords.js';

/** Ce qu'un champ dit de lui-même, quelle que soit la source (instantané du DOM, action découverte, OpenAPI). */
export interface FieldDescription {
  inputType?: string;
  autocomplete?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  elementId?: string;
}

export interface Sensitivity {
  /** Jamais journalisé, jamais rapporté avec sa valeur, jamais rempli avec de vraies données, jamais enregistré. */
  sensitive: boolean;
  /** Données de paiement (carte, IBAN, compte bancaire…) : jamais remplies du tout, et la SafetyPolicy les bloque. */
  payment: boolean;
  /** Pourquoi (le mot-clé ou l'attribut qui a correspondu). */
  reason?: string;
}

const sensitiveWords = new KeywordMatcher(SENSITIVE_FIELD_KEYWORDS);
const paymentWords = new KeywordMatcher(PAYMENT_FIELD_KEYWORDS);
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
const PAYMENT_AUTOCOMPLETE = /^cc-/;

/**
 * Le seul endroit qui décide si un champ est sensible : mots de passe, secrets,
 * jetons, autorisation, clés d'API, numéros de carte, CVV, comptes bancaires, NAS,
 * SSN… Utilisé par la SafetyPolicy (classement), les données de test (ne jamais
 * remplir), les rapports et la mémoire des flows (ne jamais garder une valeur).
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
