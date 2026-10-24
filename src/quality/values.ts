import type { ValueRef } from '../config/quality-schema.js';
import { foldValue } from '../functional/http-structure.js';
import type { ExchangeRecord, FunctionalExchange, ValueDigest } from '../functional/model.js';
import { valueDigest } from '../forms/state/value-digest.js';
import { pathPatternToRegex } from '../policies/navigation-policy.js';

/**
 * LES VALEURS d'une vérification : la valeur du RUN (TestDataRunContext), une valeur déclarée, un
 * identifiant extrait plus tôt. Les valeurs ne quittent jamais la mémoire : la comparaison avec le
 * réseau se fait sur des empreintes salées (le sel du run), comme l'observateur réseau les garde.
 */

/** Un échange réseau observé pendant le flow, avec l'étape qui l'a déclenché. */
export interface ObservedExchange extends FunctionalExchange {
  step?: number;
}

/** Une valeur prête à comparer. `text` absent : seule l'empreinte est connue (un identifiant non affichable). */
export interface ResolvedValue {
  label: string;
  text?: string;
  digest?: string;
  folded?: string;
  /** La valeur peut figurer dans le rapport (générée ou déclarée, jamais sensible). */
  displayable: boolean;
}

export interface ExtractedValue {
  value?: string;
  digest: string;
}

export interface ValueSources {
  salt?: string;
  runValue(key: string): { value: string; displayable: boolean } | undefined;
  extracted(name: string): ExtractedValue | undefined;
}

export type ValueResolution = { ok: true; value: ResolvedValue } | { ok: false; reason: string };

/** La valeur attendue pour CE run. Une donnée de test sans valeur (étape non jouée) n'est jamais remplacée. */
export function resolveValue(ref: ValueRef, sources: ValueSources): ValueResolution {
  const digests = (text: string): Pick<ResolvedValue, 'digest' | 'folded'> =>
    sources.salt === undefined
      ? {}
      : { digest: valueDigest(text, sources.salt), folded: valueDigest(foldValue(text), sources.salt) };
  if ('testData' in ref) {
    const found = sources.runValue(ref.testData);
    if (!found)
      return {
        ok: false,
        reason: `testData.${ref.testData} has no value in this run (its step did not run)`,
      };
    return {
      ok: true,
      value: {
        label: `testData.${ref.testData}`,
        text: found.value,
        ...digests(found.value),
        displayable: found.displayable,
      },
    };
  }
  if ('value' in ref)
    return {
      ok: true,
      value: { label: 'declared value', text: ref.value, ...digests(ref.value), displayable: true },
    };
  const extracted = sources.extracted(ref.extracted);
  if (!extracted)
    return {
      ok: false,
      reason: `extracted.${ref.extracted} was not extracted (its request was not observed)`,
    };
  return {
    ok: true,
    value: {
      label: `extracted.${ref.extracted}`,
      ...(extracted.value !== undefined
        ? {
            text: extracted.value,
            folded:
              sources.salt === undefined ? undefined : valueDigest(foldValue(extracted.value), sources.salt),
          }
        : {}),
      digest: extracted.digest,
      displayable: extracted.value !== undefined,
    },
  };
}

/** Le chemin d'un champ (data.title, items.title, ?q) correspond-il au champ demandé (title) ? */
export function fieldMatches(path: string, field: string | undefined): boolean {
  if (field === undefined) return true;
  const wanted = field.replace(/^\?/, '');
  const bare = path.replace(/^\?/, '');
  return bare === wanted || bare.endsWith(`.${wanted}`);
}

export type DigestMatch = 'exact' | 'normalized';

/** Une empreinte observée correspond-elle à la valeur attendue (exacte, puis pliée si permis) ? */
export function digestMatch(
  observed: Pick<ValueDigest, 'digest' | 'folded'>,
  expected: ResolvedValue,
  allowNormalized: boolean,
): DigestMatch | undefined {
  if (expected.digest !== undefined && observed.digest === expected.digest) return 'exact';
  if (allowNormalized && expected.folded !== undefined && observed.folded === expected.folded)
    return 'normalized';
  return undefined;
}

/** Une valeur relue en clair (API de lecture) correspond-elle (exacte, puis pliée si permis) ? */
export function textMatch(
  observed: string,
  expected: ResolvedValue,
  allowNormalized: boolean,
): DigestMatch | undefined {
  if (expected.text === undefined) return undefined;
  if (observed.trim() === expected.text.trim()) return 'exact';
  if (allowNormalized && foldValue(observed) === foldValue(expected.text)) return 'normalized';
  return undefined;
}

/** Méthode (facultative) et chemin : sous-chaîne, ou motif avec * et **. */
export function exchangeMatches(
  exchange: Pick<FunctionalExchange, 'method' | 'path'>,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (method !== undefined && exchange.method.toUpperCase() !== method.toUpperCase()) return false;
  if (path === undefined) return true;
  if (path.includes('*')) return pathPatternToRegex(path).test(exchange.path);
  return exchange.path.includes(path);
}

/** Les écritures HTTP. */
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isAccepted(exchange: Pick<FunctionalExchange, 'status'>): boolean {
  return exchange.status !== undefined && exchange.status >= 200 && exchange.status < 400;
}

/** `2xx` ou un code exact. */
export function statusMatches(status: number, expected: number | '2xx' | '3xx' | '4xx' | '5xx'): boolean {
  return typeof expected === 'number'
    ? status === expected
    : Math.floor(status / 100) === Number(expected[0]);
}

/** Les empreintes d'un enregistrement (attributs + identifiants). */
export function recordDigests(record: ExchangeRecord): ValueDigest[] {
  return [
    ...(record.attributes ?? []),
    ...record.identifiers.map((identifier) => ({ field: identifier.field, digest: identifier.digest })),
  ];
}

/** Un enregistrement porte-t-il la valeur (dans ce champ) ? */
export function recordHas(
  record: ExchangeRecord,
  field: string | undefined,
  expected: ResolvedValue,
  allowNormalized = true,
): DigestMatch | undefined {
  for (const digest of recordDigests(record))
    if (fieldMatches(digest.field, field)) {
      const match = digestMatch(digest, expected, allowNormalized);
      if (match) return match;
    }
  return undefined;
}

/** `${testData:clé}` et `${extracted:nom}` dans une URL de lecture (valeurs encodées). */
export function interpolateUrl(template: string, sources: ValueSources): { url?: string; missing?: string } {
  let missing: string | undefined;
  const url = template.replace(/\$\{(testData|extracted):([^}]+)\}/g, (_all, kind: string, name: string) => {
    const resolved = resolveValue(kind === 'testData' ? { testData: name } : { extracted: name }, sources);
    if (!resolved.ok || resolved.value.text === undefined) {
      missing ??= `${kind}.${name}`;
      return '';
    }
    return encodeURIComponent(resolved.value.text);
  });
  return missing ? { missing } : { url };
}

/** La liste (ou l'objet) désignée par `select` (data.items) dans une réponse JSON. */
export function selectJson(body: unknown, select: string | undefined): unknown {
  if (!select) return body;
  let current: unknown = body;
  for (const part of select.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Les enregistrements d'une réponse JSON : un tableau d'objets, l'enveloppe d'un tableau, ou un objet seul. */
export function jsonRecords(body: unknown): Record<string, unknown>[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (Array.isArray(body)) return body.filter(isRecord).slice(0, 500);
  if (!isRecord(body)) return [];
  for (const value of Object.values(body))
    if (Array.isArray(value) && value.some(isRecord)) return value.filter(isRecord).slice(0, 500);
  return [body];
}

/** Les valeurs simples d'un objet JSON, par chemin (data.client.id), en clair et EN MÉMOIRE seulement. */
export function jsonLeaves(
  value: unknown,
  prefix = '',
  depth = 0,
  out: [string, string][] = [],
): [string, string][] {
  if (depth > 6 || out.length > 300) return out;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) jsonLeaves(entry, prefix, depth + 1, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80))
      jsonLeaves(entry, prefix ? `${prefix}.${key}` : key, depth + 1, out);
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    out.push([prefix, String(value)]);
  return out;
}

/** Une empreinte courte pour le rapport (salée par run : elle ne révèle pas la valeur). */
export function shortDigest(digest: string | undefined): string {
  return digest ? `#${digest.slice(0, 8)}` : '(no digest)';
}
