import type { ScenarioConfig } from '../config/config.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { KnowledgeBase } from '../knowledge/knowledge-model.js';
import { actionSignature } from '../knowledge/signatures.js';
import type { PageContext } from '../model/page-context.js';
import type { UiPattern } from '../patterns/ui-pattern.js';
import { SemanticDictionary, semanticKey, singularWords } from '../semantics/semantic-dictionary.js';
import type { ExplorationPlan, GoalState, Mission } from './goal-model.js';

/**
 * Transforme la mission en objectifs fonctionnels — jamais en liste de clics. Le
 * crawler reste libre de trouver le chemin ; le plan dit seulement quoi chercher et
 * comment reconnaître qu'on l'a trouvé.
 */
export interface GoalPlanner {
  plan(
    mission: Mission,
    context: PageContext,
    graph: FlowGraph,
    knowledge?: KnowledgeBase,
  ): Promise<ExplorationPlan>;
}

/** Ce qu'un concept ouvre d'habitude, pour reconnaître qu'on y est arrivé. */
const CONCEPT_PATTERNS: Record<string, UiPattern[]> = {
  create: ['CREATE_FORM', 'WIZARD'],
  edit: ['EDIT_FORM'],
  search: ['SEARCH'],
  filter: ['FILTER'],
  view: ['DETAIL', 'MASTER_DETAIL'],
  delete: ['CONFIRMATION_DIALOG'],
  upload: ['UPLOAD'],
  login: ['LOGIN'],
  settings: ['TABS', 'EDIT_FORM', 'DASHBOARD'],
};
/** Ce qui prouve qu'un objet « a été exploré » : sa liste, sa fiche, son tableau de bord. */
const EXPLORE_PATTERNS: UiPattern[] = ['CRUD_LIST', 'MASTER_DETAIL', 'DETAIL', 'DASHBOARD', 'EMPTY_STATE'];

export interface GoalPlannerOptions {
  /** Concepts que la SafetyPolicy bloque (delete, payment…) : leurs objectifs sont BLOCKED dès le départ. */
  blockedConcepts?: ReadonlySet<string>;
}

/**
 * Décompose chaque objectif avec des règles simples :
 *
 *   users        → trouver « users » → explorer sa liste / sa fiche
 *   create-user  → trouver « user » → chercher l'action « créer » → atteindre le formulaire de création
 *   permissions  → trouver « permissions » → l'explorer
 *
 * Le concept (create, search…) vient du SemanticDictionary ; le reste du nom est
 * l'objet. Les sous-objectifs communs (« trouver user ») ne sont créés qu'une fois.
 * La KnowledgeBase apporte des indices (actions qui y ont mené avant), jamais des preuves.
 */
export class RuleBasedGoalPlanner implements GoalPlanner {
  constructor(
    private readonly dictionary = new SemanticDictionary(),
    private readonly options: GoalPlannerOptions = {},
  ) {}

  plan(
    mission: Mission,
    _context: PageContext,
    graph: FlowGraph,
    knowledge?: KnowledgeBase,
  ): Promise<ExplorationPlan> {
    const goals = new Map<string, GoalState>();
    const targets: Mission['targets'] =
      mission.targets.length > 0
        ? mission.targets
        : mission.keywords.map((keyword) => ({ id: keyword, keywords: [] }));
    targets.forEach((target, index) => {
      const priority = target.priority ?? Math.max(1, 10 - index);
      const { concept, subject } = this.split(target.id);
      const root = this.goal({
        id: target.id,
        description: target.description ?? describe(concept, subject),
        kind: 'mission',
        priority,
        subject,
        keywords: target.keywords,
      });
      goals.set(root.id, root);
      const add = (goal: GoalState): GoalState => {
        const existing = goals.get(goal.id);
        if (existing) {
          existing.priority = Math.max(existing.priority, goal.priority);
          return existing;
        }
        goals.set(goal.id, goal);
        return goal;
      };
      const locate = add(
        this.goal({
          id: `find:${subject}`,
          description: `find "${subject}"`,
          kind: 'locate',
          priority,
          parentId: root.id,
          subject,
          keywords: target.keywords,
          hints: this.hints(subject, graph, knowledge),
        }),
      );
      if (!concept) {
        add(
          this.goal({
            id: `explore:${subject}`,
            description: `explore "${subject}" (list, detail)`,
            kind: 'explore',
            priority,
            parentId: root.id,
            subject,
            keywords: target.keywords,
            patterns: EXPLORE_PATTERNS,
            dependsOn: [locate.id],
          }),
        );
        return;
      }
      const blocked = this.options.blockedConcepts?.has(concept);
      const find = add(
        this.goal({
          id: `action:${concept}-${subject}`,
          description: `find the "${concept}" action for "${subject}"`,
          kind: 'find-action',
          priority,
          parentId: root.id,
          subject,
          concept,
          keywords: target.keywords,
          dependsOn: [locate.id],
        }),
      );
      add(
        this.goal({
          id: `reach:${concept}-${subject}`,
          description: `reach the "${concept}" screen for "${subject}"`,
          kind: 'reach-pattern',
          priority,
          parentId: root.id,
          subject,
          concept,
          keywords: target.keywords,
          patterns: CONCEPT_PATTERNS[concept] ?? [],
          dependsOn: [find.id],
          ...(blocked ? { status: 'BLOCKED', reason: `"${concept}" is blocked by the safety policy` } : {}),
        }),
      );
    });
    return Promise.resolve({ mission: mission.name, goals: [...goals.values()] });
  }

  /** « create-user » → concept create, objet user ; « users » → objet user. */
  split(id: string): { concept?: string; subject: string } {
    const words = semanticKey(id).split(' ').filter(Boolean);
    const index = words.findIndex((word) => this.dictionary.conceptsIn(word).length > 0 && words.length > 1);
    if (index < 0) return { subject: singularWords(words.join(' ')) || id };
    const concept = this.dictionary.conceptsIn(words[index] ?? '')[0];
    const rest = words.filter((_, position) => position !== index).join(' ');
    return { ...(concept ? { concept } : {}), subject: singularWords(rest) || rest };
  }

  /** Actions qui, d'après le graphe et l'historique, ont mené à un écran qui parle de l'objet. */
  private hints(subject: string, graph: FlowGraph, knowledge?: KnowledgeBase): string[] {
    const hints = new Set<string>();
    for (const signature of knowledge?.actionsLeadingTo((state) =>
      this.dictionary.mentions(subject, state),
    ) ?? [])
      hints.add(signature);
    for (const edge of graph.allEdges()) {
      const target = graph.getNode(edge.to);
      if (
        edge.result === 'SUCCESS' &&
        target &&
        this.dictionary.mentions(subject, [target.label, ...target.headings].join(' '))
      )
        hints.add(
          actionSignature({
            type: edge.action.type,
            elementType: '',
            ...(edge.action.text !== undefined ? { text: edge.action.text } : {}),
            ...(edge.action.label !== undefined ? { label: edge.action.label } : {}),
            ...(edge.action.href !== undefined ? { href: edge.action.href } : {}),
          }),
        );
    }
    return [...hints].slice(0, 10);
  }

  private goal(
    input: Partial<GoalState> & Pick<GoalState, 'id' | 'description' | 'kind' | 'priority'>,
  ): GoalState {
    return { status: 'PENDING', evidence: [], dependsOn: [], keywords: [], hints: [], ...input };
  }
}

function describe(concept: string | undefined, subject: string): string {
  return concept ? `${concept} ${subject}` : `explore ${subject}`;
}

/** La mission telle que le planner la lit, depuis la configuration. */
export function missionOf(config: Pick<ScenarioConfig, 'mission' | 'goals'>): Mission {
  return {
    name: config.mission.name,
    ...(config.mission.description ? { description: config.mission.description } : {}),
    targets: config.goals.targets.map((target) =>
      typeof target === 'string'
        ? { id: target, keywords: [] }
        : {
            id: target.id,
            keywords: target.keywords,
            ...(target.description ? { description: target.description } : {}),
            ...(target.priority !== undefined ? { priority: target.priority } : {}),
          },
    ),
    keywords: config.goals.keywords,
  };
}
