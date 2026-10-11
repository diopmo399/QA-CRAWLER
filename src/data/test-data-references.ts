/**
 * TEST DATA REFERENCES : une étape qui CITE une donnée du jeu ailleurs que dans la valeur d'une
 * saisie — le nom du résultat à ouvrir (« Company 7f3k » créée plus haut), le texte attendu, un
 * effet — écrit `${testData:company.companyName}`. Au rejeu, la référence est résolue par le
 * contexte des données du run (TestDataRunContext) : la MÊME valeur que la saisie de création et que
 * la recherche, générée une fois par run.
 *
 *   ${testData:<clé>}   la valeur de la clé pour ce run
 *
 * Résolution centrale, une fois par étape, avant son exécution : aucune action Playwright ne lit le
 * jeu elle-même. Une référence inconnue n'est JAMAIS remplacée par une chaîne vide : l'étape échoue
 * avec la clé en cause. Un sélecteur CSS ne cite jamais une donnée (la valeur n'y serait pas
 * échappée) : refusé explicitement.
 */
const PATTERN = /\$\{testData:([A-Za-z0-9_.-]+)\}/g;
/** Champs qui reçoivent du CSS brut : une donnée y est refusée. */
const RAW_SELECTOR_FIELDS = new Set(['css', 'selector']);

export function testDataReference(key: string): string {
  return `\${testData:${key}}`;
}

/** Les clés citées dans une valeur (chaîne, tableau, objet), dans l'ordre, sans doublon. */
export function referencedTestDataKeys(value: unknown): string[] {
  const keys: string[] = [];
  walk(value, (text) => {
    for (const match of text.matchAll(PATTERN)) if (match[1] && !keys.includes(match[1])) keys.push(match[1]);
    return text;
  });
  return keys;
}

export type ReferenceResolution = { value: string } | { error: string };

export type ResolvedReferences<T> =
  { ok: true; value: T; keys: string[] } | { ok: false; key?: string; reason: string };

/**
 * Remplace chaque `${testData:clé}` par sa valeur. Une chaîne qui n'est qu'une référence prend la
 * valeur telle quelle ; une référence dans un texte y est insérée. La valeur d'une clé n'est
 * demandée qu'UNE fois par appel (le contexte du run la garde, lui, pour tout le run).
 */
export function resolveTestDataReferences<T>(
  value: T,
  resolve: (key: string) => ReferenceResolution,
): ResolvedReferences<T> {
  const resolved = new Map<string, string>();
  let failure: { key?: string; reason: string } | undefined;
  const keys: string[] = [];
  const result = walk(value, (text, field) => {
    if (failure || !text.includes('${testData:')) return text;
    if (field !== undefined && RAW_SELECTOR_FIELDS.has(field)) {
      failure = { reason: `a CSS selector cannot cite test data (${field}: ${text})` };
      return text;
    }
    return text.replace(PATTERN, (whole, key: string) => {
      if (failure) return whole;
      let found = resolved.get(key);
      if (found === undefined) {
        const answer = resolve(key);
        if ('error' in answer) {
          failure = { key, reason: `test data reference ${whole} could not be resolved: ${answer.error}` };
          return whole;
        }
        found = answer.value;
        resolved.set(key, found);
        keys.push(key);
      }
      return found;
    });
  });
  return failure ? { ok: false, ...failure } : { ok: true, value: result as T, keys };
}

function walk(value: unknown, map: (text: string, field?: string) => string, field?: string): unknown {
  if (typeof value === 'string') return map(value, field);
  if (Array.isArray(value)) return value.map((item) => walk(item, map, field));
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [name, inner] of Object.entries(value)) copy[name] = walk(inner, map, name);
    return copy;
  }
  return value;
}
