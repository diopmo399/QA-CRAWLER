import { normalize as normalizeControl } from '../flows/action-effect-verifier.js';
import type { BusinessSituation } from './business-state-engine.js';
import type { CausalKnowledgeGraph } from './causal-graph.js';
import type { EvidenceReference } from './evidence.js';
import { capabilityId, type FunctionalModel } from './functional-model.js';
import type { HypothesisStatus } from './hypothesis-engine.js';

export type ConditionKind =
  | 'MISSION_DONE'
  | 'READY_FOR_SUBMISSION'
  | 'PHASE_COMPLETE'
  | 'PHASE_AVAILABLE'
  | 'FIELD_VALID'
  | 'CHOICE_MADE'
  | 'CONTROL_AVAILABLE';

/** Une action qui peut réaliser une condition — d'où vient-elle, et à quel point est-on sûr ? */
export interface CandidateAction {
  kind: 'click' | 'check' | 'fill' | 'select';
  label: string;
  role?: string;
  /** HUMAN_FLOW : le plan démontré ; CAUSAL : le graphe causal ; MODEL : le modèle fonctionnel. */
  source: 'HUMAN_FLOW' | 'CAUSAL' | 'MODEL';
  confidence: number;
  hypothesis?: { id: string; status: HypothesisStatus; confidence: number };
  /** La SafetyPolicy dira au moment voulu ; l'envoi est marqué comme écriture. */
  writes?: boolean;
}

export interface GoalNode {
  id: string;
  label: string;
  kind: 'MISSION' | 'GOAL' | 'SUBGOAL' | 'PRECONDITION';
  condition: { kind: ConditionKind; subject: string };
  /** Ce qui doit être vrai avant (ids des nœuds). */
  requires: string[];
  achievedBy: CandidateAction[];
  evidence: EvidenceReference[];
}

export interface GoalGraph {
  mission?: string;
  root?: string;
  nodes: GoalNode[];
}

const conditionId = (subject: string, suffix: string): string => `${capabilityId(subject)}_${suffix}`;

/**
 * GOAL PLANNER (cognitif) : une mission devient un GRAPHE d'objectifs et de préconditions.
 *
 *   CREATE_REQUEST_DONE
 *     ↑ CREATE_REQUEST_READY
 *         ↑ COMPANY_INFORMATION_COMPLETE
 *             ↑ COMPANY_INFORMATION_AVAILABLE ← COMPANY_INFORMATION (l'ouvreur) AVAILABLE ← EUR_SELECTED
 *             ↑ COMPANY_NAME_VALID · BUSINESS_NUMBER_VALID
 *         ↑ EUR_SELECTED
 *
 * Les liens viennent du modèle fonctionnel (parcours démontré) et du graphe causal (« check EUR
 * révèle l'ouvreur ») : une précondition apprise reste marquée par le statut de son hypothèse.
 */
export function buildGoalGraph(model: FunctionalModel, causal?: CausalKnowledgeGraph): GoalGraph {
  const nodes = new Map<string, GoalNode>();
  const add = (node: GoalNode): GoalNode => {
    const existing = nodes.get(node.id);
    if (existing) return existing;
    nodes.set(node.id, node);
    return node;
  };
  const mission = model.mission;
  if (!mission) return { nodes: [] };

  const choices = model.capabilities
    .filter((capability) => capability.kind === 'CHOICE')
    .map((capability) =>
      add({
        id: conditionId(capability.label, 'SELECTED'),
        label: `${capability.label} selected`,
        kind: 'PRECONDITION',
        condition: { kind: 'CHOICE_MADE', subject: capability.label },
        requires: [],
        achievedBy: [{ kind: 'check', label: capability.label, source: 'HUMAN_FLOW', confidence: 0.9 }],
        evidence: capability.evidence,
      }),
    );
  const choiceFor = (cause: string): GoalNode | undefined =>
    choices.find((choice) => cause === `check ${normalizeControl(choice.condition.subject)}`);

  /** Les causes connues qui révèlent un contrôle : préconditions (un choix) ou actions candidates. */
  const causesOf = (control: string): { requires: string[]; actions: CandidateAction[] } => {
    const requires: string[] = [];
    const actions: CandidateAction[] = [];
    for (const link of causal?.causesOf(control) ?? []) {
      if (link.hypothesis.status === 'CONTRADICTED' || link.hypothesis.status === 'REJECTED') continue;
      const choice = choiceFor(link.cause);
      if (choice) {
        if (!requires.includes(choice.id)) requires.push(choice.id);
        continue;
      }
      const [kind = 'click', ...rest] = link.cause.split(' ');
      actions.push({
        kind: kind === 'check' || kind === 'fill' || kind === 'select' ? kind : 'click',
        label: rest.join(' '),
        source: 'CAUSAL',
        confidence: link.hypothesis.confidence,
        hypothesis: {
          id: link.hypothesis.id,
          status: link.hypothesis.status,
          confidence: link.hypothesis.confidence,
        },
      });
    }
    return { requires, actions };
  };

  const phases = model.phases.map((phase) => {
    const fields = phase.fields.map((field) =>
      add({
        id: conditionId(field, 'VALID'),
        label: `${field} valid`,
        kind: 'PRECONDITION',
        condition: { kind: 'FIELD_VALID', subject: field },
        requires: [],
        achievedBy: [{ kind: 'fill', label: field, source: 'HUMAN_FLOW', confidence: 0.9 }],
        evidence: [],
      }),
    );
    const requiresForAvailable: string[] = [];
    const openers: CandidateAction[] = [];
    if (phase.opener) {
      const opener = phase.opener;
      const learned = causesOf(`${opener.role ?? 'button'}:${normalizeControl(opener.label)}`);
      const openerNode = add({
        id: conditionId(opener.label, 'CONTROL_AVAILABLE'),
        label: `"${opener.label}" available`,
        kind: 'PRECONDITION',
        condition: { kind: 'CONTROL_AVAILABLE', subject: `${opener.role ?? 'button'}:${opener.label}` },
        requires: learned.requires,
        achievedBy: learned.actions,
        evidence: [],
      });
      requiresForAvailable.push(openerNode.id);
      openers.push({
        kind: 'click',
        label: opener.label,
        ...(opener.role ? { role: opener.role } : {}),
        source: 'HUMAN_FLOW',
        confidence: 0.9,
      });
    }
    // Ce que le graphe causal sait de ce qui révèle les champs de la phase (autres chemins possibles).
    const firstField = phase.fields[0];
    if (firstField)
      openers.push(
        ...causesOf(`textbox:${normalizeControl(firstField)}`).actions.filter(
          (action) => !openers.some((known) => known.label.toLowerCase() === action.label.toLowerCase()),
        ),
      );
    const available = add({
      id: `${phase.id}_AVAILABLE`,
      label: `${phase.label} available`,
      kind: 'SUBGOAL',
      condition: { kind: 'PHASE_AVAILABLE', subject: phase.id },
      requires: requiresForAvailable,
      achievedBy: openers,
      evidence: [],
    });
    return add({
      id: `${phase.id}_COMPLETE`,
      label: `${phase.label} complete`,
      kind: 'GOAL',
      condition: { kind: 'PHASE_COMPLETE', subject: phase.id },
      requires: [available.id, ...fields.map((field) => field.id)],
      achievedBy: [],
      evidence: [],
    });
  });

  const ready = add({
    id: `${mission.id}_READY`,
    label: `${mission.label} ready for submission`,
    kind: 'GOAL',
    condition: { kind: 'READY_FOR_SUBMISSION', subject: mission.id },
    requires: [...choices.map((choice) => choice.id), ...phases.map((phase) => phase.id)],
    achievedBy: [],
    evidence: [],
  });
  const root = add({
    id: `${mission.id}_DONE`,
    label: `${mission.label} done`,
    kind: 'MISSION',
    condition: { kind: 'MISSION_DONE', subject: mission.id },
    requires: [ready.id],
    achievedBy: model.submit
      ? [
          {
            kind: 'click',
            label: model.submit.label,
            ...(model.submit.role ? { role: model.submit.role } : {}),
            source: 'HUMAN_FLOW',
            confidence: 0.9,
            writes: true,
          },
        ]
      : [],
    evidence: mission.evidence,
  });
  return { mission: mission.id, root: root.id, nodes: [...nodes.values()] };
}

/** Ce que l'on sait de l'écran pour juger une condition. */
export interface ConditionContext {
  situation?: BusinessSituation;
  /** Contrôles visibles et actifs (« button:company information »). */
  controls?: ReadonlySet<string>;
  /** Objectifs confirmés par leur effet (envoi accepté…). */
  achieved?: ReadonlySet<string>;
}

/** Une condition est-elle vraie maintenant ? undefined : on ne sait pas. */
export function holds(node: GoalNode, context: ConditionContext): boolean | undefined {
  const situation = context.situation;
  const phase = (id: string) => situation?.phases.find((candidate) => candidate.phase === id);
  const norm = (text: string): string => normalizeControl(text);
  switch (node.condition.kind) {
    case 'MISSION_DONE':
      return context.achieved?.has(node.id) ?? false;
    case 'READY_FOR_SUBMISSION':
      return situation ? situation.submission === 'READY' : undefined;
    case 'PHASE_COMPLETE':
      return situation ? phase(node.condition.subject)?.status === 'COMPLETE' : undefined;
    case 'PHASE_AVAILABLE': {
      const state = phase(node.condition.subject);
      return situation ? state !== undefined && state.status !== 'UNAVAILABLE' : undefined;
    }
    case 'FIELD_VALID': {
      if (!situation) return undefined;
      const owner = situation.phases.find(
        (candidate) =>
          candidate.status !== 'UNAVAILABLE' &&
          candidate.missing
            .concat(candidate.invalid)
            .some((field) => norm(field) === norm(node.condition.subject)),
      );
      if (owner) return false;
      // Pas manquant : vrai seulement si sa phase est visible.
      return situation.phases.some((candidate) => candidate.status !== 'UNAVAILABLE');
    }
    case 'CHOICE_MADE':
      return situation
        ? situation.facts.some(
            (fact) =>
              norm(fact.value) === norm(node.condition.subject) ||
              (fact.value === 'selected' && norm(fact.name) === norm(node.condition.subject)),
          )
        : undefined;
    case 'CONTROL_AVAILABLE': {
      if (!context.controls) return undefined;
      const [role = '', ...rest] = node.condition.subject.split(':');
      return context.controls.has(`${role}:${norm(rest.join(':'))}`);
    }
  }
}

export interface PreconditionResolution {
  goal: string;
  status: 'SATISFIED' | 'BLOCKED' | 'UNKNOWN';
  /** Chaînes « pourquoi ? » : du but jusqu'à la condition manquante la plus profonde. */
  chains: string[][];
  /** Les conditions manquantes dont toutes les préconditions sont vraies : actionnables maintenant. */
  missingPreconditions: GoalNode[];
  candidateActions: CandidateAction[];
  supportingEvidence: EvidenceReference[];
}

/**
 * PRECONDITION RESOLVER : un objectif bloqué ne répond pas « BLOCKED », il répond POURQUOI.
 *
 *   SUBMIT ← READY ← COMPANY_INFORMATION_COMPLETE ← BUSINESS_NUMBER_VALID (manquant)
 *
 * Il remonte les préconditions non satisfaites jusqu'aux plus profondes, et propose les
 * actions candidates de celles qui sont actionnables maintenant (les autres attendent).
 */
export function resolvePreconditions(
  graph: GoalGraph,
  goalId: string,
  context: ConditionContext,
  maxDepth = 8,
): PreconditionResolution {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const chains: string[][] = [];
  const actionable: GoalNode[] = [];
  const visit = (id: string, path: string[]): boolean | undefined => {
    const node = byId.get(id);
    if (!node || path.includes(id) || path.length > maxDepth) return undefined;
    const here = [...path, id];
    const satisfied = holds(node, context);
    if (satisfied === true) return true;
    const children = node.requires.map((child) => ({ child, ok: visit(child, here) }));
    const blockedChildren = children.filter((entry) => entry.ok === false);
    if (blockedChildren.length === 0) {
      // Toutes les préconditions sont vraies (ou inconnues) : la condition elle-même manque.
      if (satisfied === false || node.condition.kind === 'MISSION_DONE') {
        chains.push(here);
        if (!actionable.some((known) => known.id === node.id)) actionable.push(node);
      }
    }
    return satisfied ?? (blockedChildren.length > 0 ? false : undefined);
  };
  const result = visit(goalId, []);
  const evidence = context.situation?.evidence ?? [];
  return {
    goal: goalId,
    status: result === true ? 'SATISFIED' : chains.length > 0 ? 'BLOCKED' : 'UNKNOWN',
    chains,
    missingPreconditions: actionable,
    candidateActions: actionable.flatMap((node) => node.achievedBy),
    supportingEvidence: evidence.slice(0, 10),
  };
}

/** « CREATE_REQUEST_DONE ← CREATE_REQUEST_READY ← COMPANY_INFORMATION_COMPLETE ← BUSINESS_NUMBER_VALID » */
export function describeChain(chain: readonly string[]): string {
  return chain.join(' ← ');
}
