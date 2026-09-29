import type { PageContext } from '../../model/page-context.js';
import type { SemanticDictionary } from '../semantic-dictionary.js';
import type { AssertionIntent } from './intent.js';
import { containsPhrase, normalizeForMatch } from './normalize.js';
import { classifyValue } from './value-classifier.js';

/**
 * ASSERTION RESOLVER : « Alors la page Utilisateurs est affichée », « Alors un message de
 * confirmation est affiché », « Alors l'utilisateur doit apparaître dans la liste ».
 *
 * Trois issues, jamais une de plus : PASSED (preuve forte), FAILED (preuve contraire ou
 * absence nette), MANUAL (preuve faible ou ambiguë). Une correspondance faible ne devient
 * JAMAIS un PASS.
 */
export type AssertionVerdict = 'PASSED' | 'FAILED' | 'MANUAL';

export type AssertionPlan =
  /** Jugé sur l'écran observé (titre, titres de section, adresse). */
  | { kind: 'decided'; verdict: AssertionVerdict; reasons: string[] }
  /** À vérifier sur la page : un message (alerte, statut, notification). */
  | { kind: 'message'; expect: 'confirmation' | 'error' | 'any' }
  /** À vérifier sur la page : les valeurs saisies pendant le scénario. */
  | { kind: 'texts'; values: string[]; identifying: string[] }
  /** À vérifier dans le trafic : la dernière écriture a réussi, sans message d'erreur. */
  | { kind: 'write' };

const CONFIRMATION =
  /(succ[eè]s|réussi|reussi|cré[ée]e?s?|cree?e?s?|enregistr[ée]e?s?|sauvegard[ée]e?s?|ajout[ée]e?s?|mis[e]? à jour|mis[e]? a jour|modifi[ée]e?s?|confirm|success|saved|created|added|updated|done|completed)/i;
const ERROR =
  /(erreur|échec|echec|invalide|impossible|refus|error|failed|failure|invalid|denied|not allowed)/i;

/** Le genre d'un message affiché : confirmation, erreur, ou rien de reconnaissable. */
export function classifyMessage(text: string): 'confirmation' | 'error' | undefined {
  if (ERROR.test(text)) return 'error';
  if (CONFIRMATION.test(text)) return 'confirmation';
  return undefined;
}

/** Une valeur saisie pendant le scénario (jamais une valeur sensible), et ce qu'elle dit de l'entité. */
export interface ScenarioValue {
  text: string;
  /** name : prénom, nom, raison sociale, identifiant ; contact : courriel, téléphone. */
  identity?: 'name' | 'contact';
}

/** Les concepts de champ qui identifient une entité dans une liste. */
export const IDENTITY_CONCEPTS: Readonly<Record<string, 'name' | 'contact'>> = {
  firstName: 'name',
  lastName: 'name',
  fullName: 'name',
  username: 'name',
  company: 'name',
  email: 'contact',
  phone: 'contact',
};

function unique(values: readonly ScenarioValue[]): ScenarioValue[] {
  const seen = new Set<string>();
  return values.filter((value) => !seen.has(value.text) && Boolean(seen.add(value.text)));
}

export class AssertionResolver {
  constructor(private readonly dictionary: SemanticDictionary) {}

  plan(
    intent: AssertionIntent,
    context: PageContext,
    scenario: { values: readonly ScenarioValue[] },
  ): AssertionPlan {
    switch (intent.assertion) {
      case 'PAGE_DISPLAYED':
        return this.page(intent.subject ?? '', context);
      case 'MESSAGE':
        return { kind: 'message', expect: intent.message ?? 'any' };
      case 'ENTITY_VISIBLE': {
        const values = unique(scenario.values).slice(0, 6);
        if (values.length === 0)
          return {
            kind: 'decided',
            verdict: 'MANUAL',
            reasons: ['no value typed earlier in the scenario to look for'],
          };
        // Ce qui identifie l'entité : ses noms (prénom, nom, raison sociale, identifiant) ; à défaut son
        // courriel, à défaut le premier texte. Un commentaire, une date ou un nombre peuvent ne pas être listés.
        const names = values.filter((value) => value.identity === 'name').map((value) => value.text);
        const contacts = values.filter((value) => value.identity === 'contact').map((value) => value.text);
        const firstText = values.find((value) => classifyValue(value.text).type === 'TEXT')?.text;
        const identifying =
          names.length > 0 ? names : contacts.length > 0 ? contacts : firstText ? [firstText] : [];
        return { kind: 'texts', values: values.map((value) => value.text), identifying };
      }
      case 'ENTITY_CREATED':
        return { kind: 'write' };
    }
  }

  /** La page demandée est-elle celle qui est affichée ? Titre de section, titre, libellé d'écran, adresse. */
  private page(subject: string, context: PageContext): AssertionPlan {
    const wanted = normalizeForMatch(subject).tokens;
    if (wanted.length === 0) return { kind: 'decided', verdict: 'MANUAL', reasons: ['no page named'] };
    const strong: string[] = [];
    const weak: string[] = [];
    const check = (where: string, text: string | undefined): void => {
      if (!text) return;
      const tokens = normalizeForMatch(text).tokens;
      if (
        tokens.join(' ') === wanted.join(' ') ||
        (this.dictionary.mentions(subject, text) && tokens.length === wanted.length)
      )
        strong.push(`${where} "${text}" names "${subject}"`);
      else if (containsPhrase(tokens, wanted) || this.dictionary.mentions(subject, text))
        weak.push(`${where} "${text}" mentions "${subject}"`);
    };
    for (const heading of context.headings.slice(0, 3)) check('heading', heading);
    check('title', context.title);
    check('screen', context.stateLabel);
    for (const crumb of context.structure?.breadcrumbs.slice(-1) ?? []) check('breadcrumb', crumb);
    let path = '';
    try {
      path = new URL(context.url).pathname;
    } catch {
      path = '';
    }
    if (path && containsPhrase(normalizeForMatch(path).tokens, wanted))
      weak.push(`address ${path} contains "${subject}"`);
    if (strong.length > 0) return { kind: 'decided', verdict: 'PASSED', reasons: [...strong, ...weak] };
    if (weak.length > 0)
      return { kind: 'decided', verdict: 'MANUAL', reasons: [`only weak evidence: ${weak.join('; ')}`] };
    return {
      kind: 'decided',
      verdict: 'FAILED',
      reasons: [
        `"${subject}" is not displayed: headings ${JSON.stringify(context.headings.slice(0, 3))}, title "${context.title}"`,
      ],
    };
  }
}

/**
 * Les valeurs du scénario à l'écran : toutes → PASSED ; aucune → FAILED ; toutes les
 * valeurs qui identifient l'entité (ses noms) mais pas les autres (un commentaire, une
 * date reformatée) → PASSED ; sinon MANUAL (preuve faible, jamais un PASS).
 */
export function judgeTexts(
  plan: Extract<AssertionPlan, { kind: 'texts' }>,
  visible: ReadonlySet<string>,
): { verdict: AssertionVerdict; reasons: string[] } {
  const shown = plan.values.filter((value) => visible.has(value));
  const missing = plan.values.filter((value) => !visible.has(value));
  if (missing.length === 0)
    return { verdict: 'PASSED', reasons: [`${shown.length} value(s) of the scenario shown`] };
  if (shown.length === 0)
    return {
      verdict: 'FAILED',
      reasons: [`none of the ${plan.values.length} value(s) of the scenario is shown`],
    };
  if (plan.identifying.every((value) => visible.has(value)))
    return {
      verdict: 'PASSED',
      reasons: [
        `identifying value(s) shown (${plan.identifying.length}); ${missing.length} other value(s) not shown as typed`,
      ],
    };
  return {
    verdict: 'MANUAL',
    reasons: [`only ${shown.length} of ${plan.values.length} value(s) shown: weak evidence`],
  };
}
