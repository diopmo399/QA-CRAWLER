import { normalizeText } from '../policies/keywords.js';
import { singularWords } from '../semantics/semantic-dictionary.js';

/** Mots vides FR/EN : ils ne rapprochent pas deux libellés. */
const STOP_WORDS = new Set(
  (
    'a an the of on in to for and or with by at from my your our their this that is are be ' +
    'le la les l de des du d un une sur et ou en au aux pour par avec mon ma mes ce cet cette ses son sa'
  ).split(' '),
);

/** Les mots porteurs de sens d'un libellé (singulier simple, sans mots vides). */
export function tokensOf(text: string): string[] {
  return singularWords(text.replace(/[’']/g, ' '))
    .split(' ')
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/**
 * Similarité de deux libellés, 0..1, déterministe (aucun modèle) : égalité normalisée,
 * puis recouvrement des mots (Dice), avec un bonus quand l'un contient l'autre.
 * `synonyms` (facultatif) donne les formes équivalentes d'un terme (SemanticDictionary.expand).
 */
export function labelSimilarity(
  a: string,
  b: string,
  synonyms?: (term: string) => readonly string[],
): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (synonyms) {
    const forms = new Set(synonyms(a).map((form) => normalizeText(form)));
    if (forms.has(right)) return 0.95;
  }
  const x = new Set(tokensOf(a));
  const y = new Set(tokensOf(b));
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const word of x) if (y.has(word)) common += 1;
  const dice = (2 * common) / (x.size + y.size);
  const contained = common > 0 && (common === x.size || common === y.size) ? 0.15 : 0;
  return round(Math.min(0.94, dice + contained));
}

/** Rôles « qui révèlent » : un onglet, un bouton, un lien, une entrée de menu, une bascule. */
export const REVEALING_ROLES = new Set([
  'button',
  'tab',
  'link',
  'menuitem',
  'treeitem',
  'switch',
  'summary',
]);
/** Rôles qu'une récupération peut utiliser (jamais un champ de saisie). */
export const RECOVERY_ROLES = new Set([...REVEALING_ROLES, 'checkbox', 'radio']);

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** « Company information » → COMPANY_INFORMATION. */
export function slugOf(text: string): string {
  return tokensOf(text)
    .slice(0, 4)
    .map((word) => word.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean)
    .join('_');
}
