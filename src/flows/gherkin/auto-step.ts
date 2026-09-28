import { actionLabel, type DiscoveredAction } from '../../model/discovered-action.js';
import { normalizeText } from '../../policies/keywords.js';

/**
 * MODE AUTOMATIQUE : une phrase Gherkin que ni les phrases intégrées ni celles de
 * l'équipe ne reconnaissent est interprétée sur l'écran, au moment de l'exécution.
 * Aucun modèle de langage : des verbes connus (FR/EN), les valeurs entre guillemets
 * ou contenant des chiffres, et les libellés réellement présents à l'écran.
 *
 * Quand la phrase ne donne rien de sûr, le plan est `manual` : la phrase est notée
 * « À VÉRIFIER » avec la raison, jamais remplacée par une action devinée.
 */

export type GherkinStepType = 'Context' | 'Action' | 'Outcome' | 'Unknown';

/** Un nom cité dans la phrase (« l'onglet "Profil" »), avec le type d'élément qui le précède. */
export interface Mention {
  text: string;
  /** Rôle ARIA suggéré par le mot qui précède (onglet → tab, bouton → button…). */
  role?: string;
}

export type AutoPlan =
  /** Cliquer sur chaque nom cité, dans l'ordre, en attendant qu'il apparaisse (un panneau ouvre sa section). */
  | { kind: 'navigate'; mentions: Mention[] }
  /** Saisir / choisir / cocher dans le champ dont le libellé est dans la phrase. */
  | { kind: 'field'; action: 'fill' | 'select' | 'check' | 'uncheck'; field: DiscoveredAction; value: string }
  /** Vérifier : textes visibles, textes absents, aucun message d'erreur, dernière écriture réussie. */
  | { kind: 'verify'; texts: string[]; hidden: string[]; noError: boolean; lastWriteOk: boolean }
  | { kind: 'manual'; reason: string };

const verbs = (...words: string[]): RegExp => new RegExp(`(^|\\s)(${words.join('|')})(\\s|$)`);
const CHECK_VERBS = verbs('coche', 'cocher', 'cochez', 'check', 'checks', 'tick', 'ticks');
const UNCHECK_VERBS = verbs('decoche', 'decocher', 'decochez', 'uncheck', 'unchecks', 'untick');
const SELECT_VERBS = verbs(
  'choisit',
  'choisir',
  'choisis',
  'choisissez',
  'selectionne',
  'selectionner',
  'selects',
  'select',
  'chooses',
  'choose',
  'picks',
  'pick',
);
const FILL_VERBS = verbs(
  'saisit',
  'saisir',
  'saisis',
  'saisissez',
  'entre',
  'entrer',
  'entrez',
  'renseigne',
  'renseigner',
  'renseignez',
  'tape',
  'taper',
  'tapez',
  'modifie',
  'modifier',
  'modifiez',
  'change',
  'changer',
  'changez',
  'remplace',
  'remplacer',
  'remplacez',
  'met a jour',
  'mettre a jour',
  'indique',
  'indiquer',
  'ecrit',
  'ecrire',
  'types',
  'type',
  'enters',
  'enter',
  'fills',
  'fill',
  'sets',
  'set',
  'changes',
  'updates',
  'update',
  'replaces',
  'replace',
  'modifies',
  'modify',
  'edits',
  'edit',
);
const NAVIGATE_VERBS = verbs(
  'accede',
  'acceder',
  'accedez',
  'clique',
  'cliquer',
  'cliquez',
  'ouvre',
  'ouvrir',
  'ouvrez',
  'va',
  'aller',
  'allez',
  'navigue',
  'naviguer',
  'naviguez',
  'selectionne',
  'selectionner',
  'affiche',
  'afficher',
  'consulte',
  'consulter',
  'accesses',
  'access',
  'clicks',
  'click',
  'opens',
  'open',
  'goes',
  'go',
  'navigates',
  'navigate',
  'visits',
  'visit',
  'selects',
  'select',
  'expands',
  'expand',
  'deplie',
  'deplier',
);
const NO_ERROR =
  /(aucun(e)? (message d'?)?erreur|sans erreur|no error|without (any )?error|not? (any )?error message)/;
const NEGATIVE = /(^|\s)(aucun|aucune|n'est pas|ne sont pas|n'apparait pas|not|no|never|jamais)(\s|$)/;
const SUCCESS = /(avec succes|succes|successfully|success|reussi|reussie)/;
/** Ce qui suit ces mots est la valeur attendue : « le taux demeure à 60 », « the status remains Open ». */
const EXPECTED_AFTER =
  /(?:^|\s)(?:demeure|demeurent|reste|restent|vaut|valent|est egal a|est egale a|remains|remain|stays|equals|is equal to)(?:\s+(?:a|à|de|to))?\s+(.+)$/i;

/** Les rôles suggérés par le mot qui précède un nom cité. */
const ROLE_HINTS: [RegExp, string][] = [
  [/(onglet|tab)$/, 'tab'],
  [/(bouton|button)$/, 'button'],
  [/(lien|link)$/, 'link'],
  [/(menu|menu item)$/, 'menuitem'],
  [/(case|case a cocher|checkbox)$/, 'checkbox'],
];

const QUOTES = /"([^"]*)"|«\s*([^»]*?)\s*»|“([^”]*)”/g;

/** Les noms cités entre guillemets, dans l'ordre, avec le rôle suggéré par le mot d'avant. */
export function mentionsOf(sentence: string): Mention[] {
  const mentions: Mention[] = [];
  for (const match of sentence.matchAll(QUOTES)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!text) continue;
    const before = normalizeText(sentence.slice(0, match.index))
      .replace(/[^a-z' ]+/g, ' ')
      .trim();
    const role = ROLE_HINTS.find(([pattern]) => pattern.test(before))?.[1];
    mentions.push({ text, ...(role ? { role } : {}) });
  }
  return mentions;
}

/**
 * Le plan d'une phrase sur l'écran courant (`actions` : ce que l'explorateur y a trouvé).
 * Une phrase « Alors / Then » vérifie ; les autres agissent.
 */
export function planAutoStep(
  sentence: string,
  type: GherkinStepType,
  actions: readonly DiscoveredAction[],
): AutoPlan {
  const text = normalizeText(sentence);
  if (type === 'Outcome') return planCheck(sentence, text);

  const field = fieldIn(text, actions);
  if (UNCHECK_VERBS.test(text) || CHECK_VERBS.test(text)) {
    const box =
      fieldIn(text, actions, (action) => action.type === 'check') ?? checkboxMention(sentence, actions);
    if (box)
      return { kind: 'field', action: UNCHECK_VERBS.test(text) ? 'uncheck' : 'check', field: box, value: '' };
  }
  if (SELECT_VERBS.test(text) && field?.type === 'select') {
    const value = valueFor(sentence, actionLabel(field));
    if (value) return { kind: 'field', action: 'select', field, value };
  }
  if (FILL_VERBS.test(text) && field && (field.type === 'fill' || field.type === 'select')) {
    const value = valueFor(sentence, actionLabel(field));
    if (value) return { kind: 'field', action: field.type === 'select' ? 'select' : 'fill', field, value };
    return { kind: 'manual', reason: `field "${actionLabel(field)}" found, but no value in the sentence` };
  }
  const mentions = mentionsOf(sentence);
  if (mentions.length > 0 && (NAVIGATE_VERBS.test(text) || type === 'Context' || type === 'Action'))
    return { kind: 'navigate', mentions };
  if (type === 'Context')
    return {
      kind: 'manual',
      reason: 'precondition not automated: write it as a flow and use "run:" in gherkin.steps',
    };
  return {
    kind: 'manual',
    reason: field
      ? `field "${actionLabel(field)}" found, but no known verb (saisir, modifier, choisir, cocher…)`
      : 'no element of the screen named in the sentence, and no quoted name to click',
  };
}

/** « Alors … » : ce qui peut être observé. */
function planCheck(sentence: string, text: string): AutoPlan {
  const noError = NO_ERROR.test(text);
  const values = expectedValues(sentence);
  const negative = !noError && NEGATIVE.test(text);
  const success = SUCCESS.test(text);
  if (values.length === 0 && !noError && !success)
    return {
      kind: 'manual',
      reason: 'nothing observable in the sentence (no value, no error or success wording)',
    };
  if (negative && values.length === 0)
    return { kind: 'manual', reason: 'negative check without a value to look for' };
  return {
    kind: 'verify',
    texts: negative ? [] : values,
    hidden: negative ? values : [],
    noError: noError || success,
    lastWriteOk: success,
  };
}

/** Les valeurs attendues : entre guillemets, avec des chiffres, ou après « demeure / reste / vaut ». */
export function expectedValues(sentence: string): string[] {
  const values: string[] = [];
  const add = (value: string | undefined): void => {
    const clean = (value ?? '').replace(/^[\s"'«“]+|[\s"'»”.;,!]+$/g, '').trim();
    if (clean && !values.includes(clean)) values.push(clean);
  };
  for (const mention of mentionsOf(sentence)) add(mention.text);
  const unquoted = sentence.replace(QUOTES, ' ');
  const tail = EXPECTED_AFTER.exec(unquoted)?.[1];
  if (tail && !/\d/.test(tail)) add(tail);
  for (const token of unquoted.match(/[\p{L}\p{N}-]*\d[\p{L}\p{N}.,%/-]*/gu) ?? []) add(token);
  return values;
}

/**
 * Le champ dont le libellé apparaît dans la phrase, en mots entiers (le plus long
 * gagne : « Code postal » plutôt que « Code »).
 */
export function fieldIn(
  text: string,
  actions: readonly DiscoveredAction[],
  accept: (action: DiscoveredAction) => boolean = (action) =>
    action.type === 'fill' || action.type === 'select' || action.type === 'check',
): DiscoveredAction | undefined {
  const haystack = ` ${words(text)} `;
  let best: { action: DiscoveredAction; length: number } | undefined;
  for (const action of actions) {
    if (!accept(action) || !action.visible || action.disabled) continue;
    const label = words(actionLabel(action));
    if (label.length < 2 || !haystack.includes(` ${label} `)) continue;
    if (!best || label.length > best.length) best = { action, length: label.length };
  }
  return best?.action;
}

function checkboxMention(
  sentence: string,
  actions: readonly DiscoveredAction[],
): DiscoveredAction | undefined {
  for (const mention of mentionsOf(sentence)) {
    const found = findByName(
      actions.filter((action) => action.type === 'check'),
      mention,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * La valeur à saisir : entre guillemets (autre que le libellé du champ), sinon ce qui suit
 * le dernier « à / avec / par / to / with / = », sinon le dernier mot contenant un chiffre.
 */
export function valueFor(sentence: string, fieldLabel: string): string | undefined {
  const label = words(fieldLabel);
  const quoted = mentionsOf(sentence)
    .map((mention) => mention.text)
    .filter((value) => words(value) !== label);
  if (quoted.length > 0) return quoted.at(-1);
  const plain = sentence.replace(/[.;!]+$/, '').trim();
  // Ce qui suit le dernier « à / avec / par / to / with / = » : « … de 112310 à 455219 » → 455219.
  const after = /\s(?:à|avec|par|to|with|=)\s+(?!.*\s(?:à|avec|par|to|with|=)\s)(.+)$/i
    .exec(plain)?.[1]
    ?.trim();
  if (after && !words(after).includes(label)) return after;
  return plain.match(/[\p{L}\p{N}-]*\d[\p{L}\p{N}.,-]*/gu)?.at(-1);
}

/**
 * L'élément cliquable de l'écran qui porte ce nom : nom identique d'abord, puis qui
 * commence par lui, puis qui le contient ; le rôle suggéré départage, puis ce qui est
 * devant l'écran. Undefined si rien ne correspond, ou si deux éléments sont à égalité.
 */
export function findByName(
  actions: readonly DiscoveredAction[],
  mention: Mention,
): DiscoveredAction | undefined {
  const wanted = words(mention.text);
  if (!wanted) return undefined;
  const scored = actions
    .filter((action) => action.visible && !action.disabled && !action.obscured)
    .map((action) => {
      const name = words(actionLabel(action));
      const base = name === wanted ? 30 : name.startsWith(`${wanted} `) ? 20 : name.includes(wanted) ? 10 : 0;
      if (base === 0) return { action, score: 0 };
      const role = mention.role && action.role === mention.role ? 5 : 0;
      const clickable = action.type === 'click' || action.type === 'navigate' ? 2 : 0;
      return { action, score: base + role + clickable + (action.foreground ? 1 : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  if (!first) return undefined;
  if (
    second &&
    second.score === first.score &&
    words(actionLabel(second.action)) !== words(actionLabel(first.action))
  )
    return undefined;
  return first.action;
}

/** Texte comparable : minuscules, sans accents, ponctuation réduite à des espaces. */
function words(text: string): string {
  return normalizeText(text)
    .replace(/[^a-z0-9%']+/g, ' ')
    .trim();
}
