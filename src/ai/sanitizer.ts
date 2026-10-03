import { sanitizeText } from '../persistence/sanitize.js';
import type { IntelligenceRequest } from './model.js';

export const PLACEHOLDERS = {
  email: '<EMAIL_TEST_DATA>',
  secret: '<PASSWORD_SECRET>',
  token: '<AUTH_TOKEN_REDACTED>',
  value: '<SENSITIVE_VALUE_REDACTED>',
} as const;

/** Clés d'objet dont la valeur ne part JAMAIS vers un fournisseur. */
const SENSITIVE_KEY =
  /(pass(word|wd)?|pwd|secret|token|authori[sz]ation|cookie|jwt|otp|api[-_]?key|cvv|cvc|credential)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Jetons GitHub (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_) et clés génériques longues. */
const GITHUB_TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const LONG_SECRET = /\b(sk|pk|rk)[-_][A-Za-z0-9]{16,}\b/g;

export interface SanitizerOptions {
  /** Valeurs secrètes connues (TestData sensibles, identifiants) : retirées où qu'elles apparaissent. */
  secretValues?: readonly string[];
  /** Libellés de champs sensibles configurés : leur contenu éventuel est masqué. */
  sensitiveFields?: readonly string[];
}

export interface SanitizedRequest {
  request: IntelligenceRequest;
  redactions: number;
}

/**
 * INTELLIGENCE CONTEXT SANITIZER (§31) : appliqué à CHAQUE requête avant qu'elle quitte le
 * processus. Réutilise le redactor du crawler (Bearer, JWT, Authorization/Cookie, password=…,
 * cartes, IBAN), puis remplace adresses, jetons, valeurs secrètes connues et champs sensibles
 * par des marqueurs (<EMAIL_TEST_DATA>, <PASSWORD_SECRET>, <AUTH_TOKEN_REDACTED>).
 */
export class IntelligenceContextSanitizer {
  private readonly secrets: string[];
  private readonly fields: RegExp | undefined;

  constructor(options: SanitizerOptions = {}) {
    this.secrets = [...new Set(options.secretValues ?? [])]
      .filter((value) => value.length >= 4)
      .sort((a, b) => b.length - a.length);
    const fields = (options.sensitiveFields ?? []).filter((field) => field.trim().length > 0);
    this.fields =
      fields.length > 0
        ? new RegExp(
            `(${fields.map((field) => field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[:=]\\s*[^,;\\n]+`,
            'gi',
          )
        : undefined;
  }

  sanitize(request: IntelligenceRequest): SanitizedRequest {
    let redactions = 0;
    const text = (value: string): string => {
      let result = value;
      for (const secret of this.secrets)
        if (result.includes(secret)) result = result.split(secret).join(PLACEHOLDERS.secret);
      result = sanitizeText(result)
        .replace(GITHUB_TOKEN, PLACEHOLDERS.token)
        .replace(LONG_SECRET, PLACEHOLDERS.token)
        .replace(EMAIL, PLACEHOLDERS.email)
        .replace(/\[REDACTED\]/g, PLACEHOLDERS.token);
      if (this.fields) result = result.replace(this.fields, `$1: ${PLACEHOLDERS.value}`);
      if (result !== value) redactions += 1;
      return result;
    };
    const walk = (value: unknown, key?: string): unknown => {
      if (typeof value === 'string') {
        if (key && SENSITIVE_KEY.test(key)) {
          redactions += 1;
          return PLACEHOLDERS.secret;
        }
        return text(value);
      }
      if (Array.isArray(value)) return value.map((entry) => walk(entry));
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
            entryKey,
            walk(entry, entryKey),
          ]),
        );
      return value;
    };
    return { request: walk(request) as IntelligenceRequest, redactions };
  }

  /** Une réponse d'outil (lecture seule) passe par le même filtre avant de partir. */
  sanitizeValue(value: unknown): unknown {
    const holder = this.sanitize({ tool: value } as unknown as IntelligenceRequest).request as unknown as {
      tool: unknown;
    };
    return holder.tool;
  }
}
