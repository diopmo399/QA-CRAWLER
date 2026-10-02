import type { Evidence } from './evidence.js';
import type { EvidenceGraph, NodeKind, Relation } from './evidence-graph.js';
import type { Hypothesis, HypothesisEngine, HypothesisStatus } from './hypothesis-engine.js';

/** Les relations causales (§10) — un sous-ensemble des relations du graphe de preuves. */
export const CAUSAL_RELATIONS = [
  'REQUIRES',
  'ENABLES',
  'DISABLES',
  'REVEALS',
  'HIDES',
  'POPULATES',
  'CLEARS',
  'VALIDATES',
  'INVALIDATES',
  'NAVIGATES_TO',
  'TRIGGERS',
  'DEPENDS_ON',
  'PREVENTS',
  'TRANSITIONS_TO',
] as const satisfies readonly Relation[];
export type CausalRelation = (typeof CAUSAL_RELATIONS)[number];

export interface CausalLink {
  cause: string;
  relation: CausalRelation;
  effect: string;
  hypothesis: Hypothesis;
}

/** Ce qu'une action a changé, en termes causaux (aucune valeur saisie). */
export interface ActionObservation {
  action: string;
  appeared: string[];
  disappeared: string[];
  enabled: string[];
  disabled: string[];
  route?: string;
  requests: string[];
}

/**
 * CAUSAL KNOWLEDGE GRAPH : CORRÉLATION ≠ CAUSALITÉ.
 *
 *   « CLICK EUR → formulaire entreprise visible » devient une HYPOTHÈSE causale
 *   (EUR REVEALS COMPANY_INFORMATION), soutenue ou contredite au fil des observations,
 *   du code source, des règles métier et des expériences sûres — jamais une vérité d'emblée.
 *
 * Chaque relation causale est portée par une hypothèse (HypothesisEngine) ET reflétée dans
 * le graphe de preuves (provenance, versions, comptes) : une seule source de connaissance.
 */
export class CausalKnowledgeGraph {
  constructor(
    private readonly hypotheses: HypothesisEngine,
    private readonly graph: EvidenceGraph,
  ) {}

  /** Une observation (ou une preuve statique, une règle…) d'une relation causale. */
  observe(
    cause: { kind: NodeKind; label: string },
    relation: CausalRelation,
    effect: { kind: NodeKind; label: string },
    evidence: Evidence,
  ): Hypothesis {
    const hypothesis = this.hypotheses.propose(
      { kind: 'CAUSAL', subject: cause.label, relation, object: effect.label },
      evidence,
      { testable: true, reason: 'repeat the cause alone (SAFE) and observe the effect' },
    );
    this.graph.relate(
      this.graph.node(cause.kind, cause.label),
      relation,
      this.graph.node(effect.kind, effect.label),
      evidence,
    );
    return hypothesis;
  }

  /** L'effet attendu n'est PAS venu : une preuve contre la relation. */
  refute(
    cause: string,
    relation: CausalRelation,
    effect: string,
    evidence: Evidence,
  ): Hypothesis | undefined {
    return this.hypotheses.contradictProposition(
      { kind: 'CAUSAL', subject: cause, relation, object: effect },
      evidence,
    );
  }

  /** Les observations causales d'une action exécutée (contrôles apparus, activés, route, requêtes). */
  learnFromAction(observation: ActionObservation, evidence: Evidence): Hypothesis[] {
    const cause = { kind: 'ACTION' as const, label: observation.action };
    const learned: Hypothesis[] = [];
    for (const control of observation.appeared.slice(0, 5))
      learned.push(this.observe(cause, 'REVEALS', { kind: 'CONTROL', label: control }, evidence));
    for (const control of observation.disappeared.slice(0, 3))
      learned.push(this.observe(cause, 'HIDES', { kind: 'CONTROL', label: control }, evidence));
    for (const control of observation.enabled.slice(0, 3))
      learned.push(this.observe(cause, 'ENABLES', { kind: 'CONTROL', label: control }, evidence));
    for (const control of observation.disabled.slice(0, 3))
      learned.push(this.observe(cause, 'DISABLES', { kind: 'CONTROL', label: control }, evidence));
    if (observation.route)
      learned.push(
        this.observe(cause, 'NAVIGATES_TO', { kind: 'ROUTE', label: observation.route }, evidence),
      );
    for (const request of observation.requests.slice(0, 3))
      learned.push(this.observe(cause, 'TRIGGERS', { kind: 'API', label: request }, evidence));
    return learned;
  }

  links(
    filter: { status?: readonly HypothesisStatus[]; cause?: string; effect?: string } = {},
  ): CausalLink[] {
    return this.hypotheses
      .all()
      .filter((hypothesis) => hypothesis.proposition.kind === 'CAUSAL')
      .filter((hypothesis) => !filter.status || filter.status.includes(hypothesis.status))
      .filter(
        (hypothesis) =>
          !filter.cause || hypothesis.proposition.subject.toLowerCase() === filter.cause.toLowerCase(),
      )
      .filter(
        (hypothesis) =>
          !filter.effect || hypothesis.proposition.object.toLowerCase() === filter.effect.toLowerCase(),
      )
      .map((hypothesis) => ({
        cause: hypothesis.proposition.subject,
        relation: hypothesis.proposition.relation as CausalRelation,
        effect: hypothesis.proposition.object,
        hypothesis,
      }));
  }

  /** Seulement ce que le runtime a confirmé : la connaissance utilisable comme fait. */
  confirmed(): CausalLink[] {
    return this.links({ status: ['RUNTIME_CONFIRMED'] });
  }

  /** « Qu'est-ce qui révèle / active X ? » — les causes connues d'un effet, de la plus solide à la plus faible. */
  causesOf(effect: string, relations: readonly CausalRelation[] = ['REVEALS', 'ENABLES']): CausalLink[] {
    return this.links({ effect })
      .filter((link) => relations.includes(link.relation) && link.hypothesis.status !== 'REJECTED')
      .sort((a, b) => b.hypothesis.confidence - a.hypothesis.confidence);
  }

  toJSON(): {
    links: {
      cause: string;
      relation: string;
      effect: string;
      status: HypothesisStatus;
      confidence: number;
      hypothesis: string;
      evidenceFor: number;
      evidenceAgainst: number;
    }[];
  } {
    return {
      links: this.links().map((link) => ({
        cause: link.cause,
        relation: link.relation,
        effect: link.effect,
        status: link.hypothesis.status,
        confidence: link.hypothesis.confidence,
        hypothesis: link.hypothesis.id,
        evidenceFor: link.hypothesis.evidenceFor.length,
        evidenceAgainst: link.hypothesis.evidenceAgainst.length,
      })),
    };
  }
}
