import { actionLabel, type DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { DetectedPattern } from '../patterns/ui-pattern.js';
import { urlText } from '../policies/keywords.js';
import { actionSignature } from '../knowledge/signatures.js';
import { SemanticDictionary } from '../semantics/semantic-dictionary.js';
import type { GoalEvidence, GoalMatch, GoalState } from './goal-model.js';

/** « Cet écran prouve-t-il l'objectif ? » et « cette action y mène-t-elle ? » */
export interface GoalMatcher {
  evaluate(goal: GoalState, context: PageContext, patterns?: readonly DetectedPattern[]): GoalMatch;
  /** 0..1 : à quel point une action rapproche de l'objectif (libellé, URL, concept, historique). */
  relevance(goal: GoalState, action: DiscoveredAction, context: PageContext): number;
}

/** Preuves « l'écran parle de l'objet » : fortes (URL, titre, titres, région, fil d'Ariane). */
const SCREEN_EVIDENCE = new Set<GoalEvidence['kind']>(['url', 'title', 'heading', 'region', 'breadcrumb']);

/**
 * Correspondance par mots, sans NLP : URL, titre, titres, régions nommées, fil
 * d'Ariane, libellés des actions et motifs détectés, avec les synonymes et les
 * pluriels simples du SemanticDictionary. Un objectif n'est atteint qu'avec une preuve
 * observable sur l'écran ; un bouton qui en parle rapproche, mais ne prouve pas.
 */
export class RuleBasedGoalMatcher implements GoalMatcher {
  constructor(private readonly dictionary = new SemanticDictionary()) {}

  evaluate(goal: GoalState, context: PageContext, patterns: readonly DetectedPattern[] = []): GoalMatch {
    const at = context.metadata.timestamp;
    const about = this.screenEvidence(goal, context, at);
    const evidence: GoalEvidence[] = [...about];
    const onSubject = about.some((entry) => SCREEN_EVIDENCE.has(entry.kind));
    const wanted = patterns.filter((pattern) => goal.patterns?.includes(pattern.type));
    const patternEvidence = wanted.map<GoalEvidence>((pattern) => ({
      kind: 'pattern',
      value: `${pattern.type} (${pattern.evidence.slice(0, 3).join(', ')})`,
      stateId: context.stateId,
      at,
    }));
    let reached = false;
    let proximity = onSubject ? 0.5 : 0;
    switch (goal.kind) {
      case 'locate':
        reached = onSubject;
        proximity = onSubject ? 1 : 0;
        break;
      case 'explore':
        evidence.push(...patternEvidence);
        reached = onSubject && patternEvidence.length > 0;
        break;
      case 'find-action': {
        const found = context.actions.find(
          (action) =>
            !action.disabled &&
            this.hasConcept(goal, action) &&
            (onSubject || this.mentionsSubject(goal, actionLabel(action), action.href)),
        );
        if (found)
          evidence.push({
            kind: 'action',
            value: `${actionLabel(found)} (${goal.concept ?? ''})`,
            stateId: context.stateId,
            at,
          });
        reached = found !== undefined;
        break;
      }
      case 'reach-pattern': {
        evidence.push(...patternEvidence);
        const subjectInForm = this.mentionsSubject(goal, [...context.dialogs, ...context.headings].join(' '));
        reached = patternEvidence.length > 0 && (onSubject || subjectInForm);
        if (patternEvidence.length > 0) proximity = Math.max(proximity, 0.7);
        break;
      }
      case 'mission':
        break;
    }
    return { goalId: goal.id, evidence, reached, proximity: reached ? 1 : proximity };
  }

  relevance(goal: GoalState, action: DiscoveredAction, context: PageContext): number {
    const label = actionLabel(action);
    const mentions = this.mentionsSubject(goal, label, action.href);
    const learned = goal.hints.includes(actionSignature(action)) ? 0.8 : 0;
    switch (goal.kind) {
      case 'locate':
        return Math.max(mentions ? 1 : 0, learned);
      case 'explore':
        return Math.max(mentions ? 0.8 : 0, learned);
      case 'find-action':
      case 'reach-pattern': {
        const concept = this.hasConcept(goal, action);
        const onSubject = this.screenEvidence(goal, context, '').some((entry) =>
          SCREEN_EVIDENCE.has(entry.kind),
        );
        if (concept && (mentions || onSubject)) return 1;
        if (mentions) return 0.6;
        if (concept) return 0.4;
        return learned;
      }
      case 'mission':
        return 0;
    }
  }

  private hasConcept(goal: GoalState, action: DiscoveredAction): boolean {
    if (!goal.concept) return false;
    return (
      this.dictionary.match(
        goal.concept,
        actionLabel(action),
        action.href ? urlText(action.href) : undefined,
      ) !== undefined
    );
  }

  private mentionsSubject(goal: GoalState, text: string, href?: string): boolean {
    const terms = [...(goal.subject ? [goal.subject] : []), ...goal.keywords];
    return terms.some(
      (term) =>
        this.dictionary.mentions(term, text) ||
        (href !== undefined && this.dictionary.mentions(term, urlText(href))),
    );
  }

  /** Ce que l'écran dit de l'objet : URL, titre, titres, régions, fil d'Ariane. */
  private screenEvidence(goal: GoalState, context: PageContext, at: string): GoalEvidence[] {
    const evidence: GoalEvidence[] = [];
    const add = (kind: GoalEvidence['kind'], value: string): void => {
      if (value && this.mentionsSubject(goal, value))
        evidence.push({ kind, value: value.slice(0, 80), stateId: context.stateId, at });
    };
    add('url', urlText(context.url));
    add('title', context.title);
    for (const heading of context.headings.slice(0, 3)) add('heading', heading);
    for (const dialog of context.dialogs) add('heading', dialog);
    for (const region of context.structure?.regions ?? []) add('region', region);
    const crumbs = context.structure?.breadcrumbs ?? [];
    if (crumbs.length > 0) add('breadcrumb', crumbs.join(' › '));
    return evidence;
  }
}
