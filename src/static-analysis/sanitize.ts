import { REDACTED, redactText, redactUrl } from '../security/redactor.js';
import type { StaticApplicationGraph } from './model.js';

/**
 * Rien de secret dans la connaissance statique. Seuls des NOMS (routes, contrôles,
 * propriétés, types) et des contraintes sont gardés, jamais la valeur d'une constante.
 * En plus : les URL passent par le redactor, et toute chaîne qui ressemble à une clé
 * (longue suite de lettres et de chiffres, JWT, en-tête d'autorisation) est masquée.
 */

/** Une clé d'API, un jeton : au moins 24 caractères d'alphabet de jeton, lettres ET chiffres. */
const KEY_LIKE =
  /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g;

/** Noms dont la valeur ne doit jamais être lue (utilisé par les visiteurs de l'AST). */
export const SECRET_NAME =
  /(pass(word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential|authorization|cookie|bearer|session[-_]?id)/i;

export function sanitizeText(text: string): string {
  const redacted = /^https?:\/\//i.test(text) ? redactUrl(text) : redactText(text);
  return redacted.replace(KEY_LIKE, REDACTED);
}

/** Une chaîne de motif (Validators.pattern) : gardée telle quelle sauf si elle contient un secret. */
function sanitizePattern(pattern: string): string {
  return redactText(pattern);
}

/** Passe chaque chaîne du graphe au crible ; les motifs de validation gardent leur forme. */
export function sanitizeGraph(graph: StaticApplicationGraph): StaticApplicationGraph {
  const visit = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string')
      return key === 'value' || key === 'pattern' ? sanitizePattern(value) : sanitizeText(value);
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
          entryKey,
          // Les empreintes sont des sha256 : pas des secrets, et elles doivent rester exactes.
          entryKey.endsWith('Hash') ? entry : visit(entry, entryKey),
        ]),
      );
    return value;
  };
  return visit(graph) as StaticApplicationGraph;
}
