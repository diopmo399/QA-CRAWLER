import { normalizeText } from '../../policies/keywords.js';
import { singularWords } from '../semantic-dictionary.js';

/**
 * NORMALISATION POUR LA COMPARAISON — jamais pour la saisie : la valeur envoyée au
 * formulaire reste celle du scénario. « Prénom », « prenom », « PRÉNOM », «  prénom »,
 * « firstName », « first_name », « First Name » deviennent comparables :
 *
 *   casse · accents · espaces · ponctuation · tirets · soulignés · camelCase · pluriel simple
 *
 * Les mots vides (articles, prépositions FR/EN) sont retirés des jetons : « l'adresse de
 * facturation » → [adresse, facturation].
 */

const STOPWORDS = new Set([
  // français
  'le',
  'la',
  'les',
  'l',
  'un',
  'une',
  'des',
  'du',
  'de',
  'd',
  'au',
  'aux',
  'a',
  'mon',
  'ma',
  'mes',
  'ton',
  'ta',
  'tes',
  'son',
  'sa',
  'ses',
  'votre',
  'vos',
  'notre',
  'nos',
  'ce',
  'cet',
  'cette',
  'ces',
  'en',
  'et',
  'pour',
  'par',
  'sur',
  // anglais
  'the',
  'an',
  'of',
  'to',
  'my',
  'your',
  'its',
  'his',
  'her',
  'their',
  'our',
  'in',
  'on',
  'for',
  'and',
]);

export interface NormalizedText {
  /** Forme comparable complète : minuscules, sans accents, mots séparés par une espace, au singulier. */
  text: string;
  /** Jetons significatifs (sans mots vides), au singulier. */
  tokens: string[];
}

/** « L'Adresse_de-Facturation » → { text: "l adresse de facturation", tokens: [adresse, facturation] }. */
export function normalizeForMatch(input: string | undefined): NormalizedText {
  if (!input) return { text: '', tokens: [] };
  const text = singularWords(
    normalizeText(input)
      .replace(/'/g, ' ')
      .replace(/[*:()[\]{}"«»“”.,;!?/\\|+=<>#]+/g, ' '),
  );
  const all = text.split(' ').filter(Boolean);
  const tokens = all.filter((token) => !STOPWORDS.has(token));
  return { text: all.join(' '), tokens: tokens.length > 0 ? tokens : all };
}

/** La forme comparable, jetons significatifs joints : la clé des comparaisons « exactes ». */
export function matchKey(input: string | undefined): string {
  return normalizeForMatch(input).tokens.join(' ');
}

/** Mêmes jetons significatifs ? (« Prénom : » = « prenom » = « le prénom »). */
export function sameMeaningfulText(a: string | undefined, b: string | undefined): boolean {
  const left = matchKey(a);
  return left !== '' && left === matchKey(b);
}

/**
 * Part des jetons de `wanted` présents dans `candidate` (0..1), et les jetons de
 * `candidate` en trop. « adresse » dans « Adresse de facturation » → 1, 1 en trop.
 */
export function tokenOverlap(
  wanted: readonly string[],
  candidate: readonly string[],
): { ratio: number; extra: number; common: number } {
  if (wanted.length === 0 || candidate.length === 0) return { ratio: 0, extra: candidate.length, common: 0 };
  const pool = new Set(candidate);
  const common = wanted.filter((token) => pool.has(token)).length;
  const wantedSet = new Set(wanted);
  const extra = candidate.filter((token) => !wantedSet.has(token)).length;
  return { ratio: common / wanted.length, extra, common };
}

/**
 * Les jetons du candidat contiennent-ils la suite de jetons voulue, dans l'ordre et
 * contiguë ? (« nom de famille » dans « Nom de famille du titulaire »).
 */
export function containsPhrase(candidate: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > candidate.length) return false;
  for (let start = 0; start + phrase.length <= candidate.length; start++)
    if (phrase.every((token, index) => candidate[start + index] === token)) return true;
  return false;
}

/**
 * Un identifiant généré par le framework (« mat-input-23 », « ng-12 », « :r5: »,
 * « field_8f3a2c ») : jamais utilisé pour reconnaître un champ ni pour la mémoire.
 */
export function isDynamicId(id: string | undefined): boolean {
  if (!id) return true;
  return /\d{2,}|^(mat|ng|cdk|mui|rc|react|ember|el|input|field)[-_:]|^:r|[0-9a-f]{6,}/i.test(id);
}
