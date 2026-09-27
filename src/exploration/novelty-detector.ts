import type { FlowGraph } from '../graph/flow-graph.js';
import type { KnowledgeBase } from '../knowledge/knowledge-model.js';
import { actionSignature, stateSignature } from '../knowledge/signatures.js';
import type { PageContext } from '../model/page-context.js';
import type { UiPattern } from '../patterns/ui-pattern.js';
import { normalizeText } from '../policies/keywords.js';

export interface NoveltyScore {
  /** 0..100 : à quel point l'écran montre du nouveau. */
  score: number;
  /** Ce qui est nouveau : « new heading », « 4 new actions »… */
  reasons: string[];
}

export interface NoveltyDetector {
  evaluate(context: PageContext, graph: FlowGraph, knowledge?: KnowledgeBase): NoveltyScore;
}

/**
 * Un écran qui montre un nouveau titre, un nouveau formulaire, de nouvelles actions ou
 * un nouveau motif mérite d'être exploré en priorité. Comparé au graphe du run (et,
 * avec une KnowledgeBase, à ce qu'on a déjà vu lors des runs précédents).
 */
export class GraphNoveltyDetector implements NoveltyDetector {
  constructor(private readonly seenPatterns: () => ReadonlySet<UiPattern> = () => new Set()) {}

  evaluate(
    context: PageContext,
    graph: FlowGraph,
    knowledge?: KnowledgeBase,
    patterns: readonly UiPattern[] = [],
  ): NoveltyScore {
    const reasons: string[] = [];
    let score = 0;
    const others = graph.allNodes().filter((node) => node.id !== context.stateId);
    const knownHeadings = new Set(
      others.flatMap((node) => node.headings.map((heading) => normalizeText(heading))),
    );
    const heading = context.headings[0];
    if (heading && !knownHeadings.has(normalizeText(heading))) {
      score += 30;
      reasons.push('new heading');
    }
    const knownActions = new Set(
      others.flatMap((node) =>
        Object.values(node.actions).map((action) =>
          actionSignature({
            type: action.type,
            elementType: '',
            ...(action.text !== undefined ? { text: action.text } : {}),
            ...(action.label !== undefined ? { label: action.label } : {}),
            ...(action.href !== undefined ? { href: action.href } : {}),
          }),
        ),
      ),
    );
    const fresh = context.actions.filter((action) => !knownActions.has(actionSignature(action))).length;
    if (fresh > 0) {
      score += Math.min(30, fresh * 5);
      reasons.push(`${fresh} new action(s)`);
    }
    if (
      context.forms.length > 0 &&
      context.actions.some((action) => action.formGroup && !knownActions.has(actionSignature(action)))
    ) {
      score += 20;
      reasons.push('new form');
    }
    const seen = this.seenPatterns();
    const newPatterns = patterns.filter((pattern) => !seen.has(pattern));
    if (newPatterns.length > 0) {
      score += 20;
      reasons.push(`new pattern ${newPatterns.join(', ')}`);
    }
    // Seulement quand l'historique existe : sans run précédent, tout serait « jamais vu ».
    const hasHistory = knowledge !== undefined && knowledge.actionsLeadingTo(() => true).length > 0;
    if (
      hasHistory &&
      knowledge.actionsLeadingTo((state) => state === stateSignature(context.stateLabel)).length === 0
    ) {
      score += 10;
      reasons.push('never seen in previous runs');
    }
    return { score: Math.min(100, score), reasons };
  }
}
