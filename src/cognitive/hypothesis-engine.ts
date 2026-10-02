import {
  combineWeights,
  evidenceWeight,
  isRuntimeEvidence,
  type Evidence,
  type EvidenceReference,
} from './evidence.js';

export const HYPOTHESIS_STATUSES = [
  'HYPOTHESIS',
  'SUPPORTED',
  'RUNTIME_CONFIRMED',
  'CONTRADICTED',
  'STALE',
  'REJECTED',
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export type PropositionKind =
  | 'CAUSAL'
  | 'BUSINESS_RULE'
  | 'DEPENDENCY'
  | 'UI_BEHAVIOR'
  | 'WORKFLOW_TRANSITION'
  | 'PRECONDITION'
  | 'FAILURE_CAUSE'
  | 'INVARIANT';

/** Une proposition sujet — relation — objet (« EUR_SELECTED REVEALS COMPANY_INFORMATION »). */
export interface Proposition {
  kind: PropositionKind;
  subject: string;
  relation: string;
  object: string;
}

export interface Testability {
  testable: boolean;
  reason: string;
}

export interface Hypothesis {
  id: string;
  proposition: Proposition;
  evidenceFor: EvidenceReference[];
  evidenceAgainst: EvidenceReference[];
  confidence: number;
  status: HypothesisStatus;
  testability: Testability;
  createdAt: string;
  updatedAt: string;
  /** Version de l'application de la dernière preuve runtime. */
  lastRuntimeVersion?: string;
}

export function propositionKey(proposition: Proposition): string {
  return `${proposition.kind}|${proposition.subject}|${proposition.relation}|${proposition.object}`.toLowerCase();
}

export function describeProposition(proposition: Proposition): string {
  return `${proposition.subject} ${proposition.relation} ${proposition.object}`;
}

export interface HypothesisChange {
  hypothesis: Hypothesis;
  previous?: HypothesisStatus;
  created: boolean;
}

export interface HypothesisOptions {
  /** Observations runtime indépendantes exigées pour RUNTIME_CONFIRMED. */
  runtimeObservationsToConfirm: number;
  version?: string;
  now?: () => string;
}

/**
 * HYPOTHESIS ENGINE : une observation n'est jamais une vérité.
 *
 *   Observation → Hypothesis → accumulation de preuves → confirmation / contradiction → Knowledge
 *
 * Règles (déterministes, explicables) :
 * - une seule observation : HYPOTHESIS ;
 * - plusieurs preuves, ou une preuve runtime + une autre source : SUPPORTED ;
 * - RUNTIME_CONFIRMED : au moins N observations runtime distinctes ET une source indépendante
 *   (code, règle, démonstration humaine, expérience contrôlée), sans contradiction runtime ;
 * - une contradiction runtime plus forte que le soutien : CONTRADICTED ; contredite par le
 *   runtime sans aucun soutien runtime, au moins deux fois : REJECTED ;
 * - une proposition qui ne vient QUE d'un LLM reste HYPOTHESIS, quoi qu'il arrive ;
 * - preuve runtime d'une autre version de l'application, plus rien de récent : STALE.
 */
export class HypothesisEngine {
  private readonly hypotheses = new Map<string, Hypothesis>();
  private readonly evidence = new Map<string, Evidence>();
  private next = 1;

  constructor(
    private readonly options: HypothesisOptions = { runtimeObservationsToConfirm: 2 },
    private readonly onChange?: (change: HypothesisChange) => void,
  ) {}

  /** Une proposition (nouvelle ou connue) et la preuve qui la soutient. */
  propose(proposition: Proposition, evidence: Evidence, testability?: Testability): Hypothesis {
    const key = propositionKey(proposition);
    let hypothesis = this.hypotheses.get(key);
    const created = !hypothesis;
    if (!hypothesis) {
      hypothesis = {
        id: `H-${String(this.next)}`,
        proposition,
        evidenceFor: [],
        evidenceAgainst: [],
        confidence: 0,
        status: 'HYPOTHESIS',
        testability: testability ?? { testable: false, reason: 'no safe experiment known yet' },
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.next += 1;
      this.hypotheses.set(key, hypothesis);
    } else if (testability) hypothesis.testability = testability;
    return this.apply(hypothesis, evidence, 'for', created);
  }

  support(id: string, evidence: Evidence): Hypothesis | undefined {
    const hypothesis = this.byId(id);
    return hypothesis ? this.apply(hypothesis, evidence, 'for', false) : undefined;
  }

  contradict(id: string, evidence: Evidence): Hypothesis | undefined {
    const hypothesis = this.byId(id);
    return hypothesis ? this.apply(hypothesis, evidence, 'against', false) : undefined;
  }

  /** Contredire par la proposition (l'effet attendu n'est pas venu). */
  contradictProposition(proposition: Proposition, evidence: Evidence): Hypothesis | undefined {
    const hypothesis = this.hypotheses.get(propositionKey(proposition));
    return hypothesis ? this.apply(hypothesis, evidence, 'against', false) : undefined;
  }

  find(proposition: Proposition): Hypothesis | undefined {
    return this.hypotheses.get(propositionKey(proposition));
  }

  byId(id: string): Hypothesis | undefined {
    return [...this.hypotheses.values()].find((hypothesis) => hypothesis.id === id);
  }

  all(): Hypothesis[] {
    return [...this.hypotheses.values()];
  }

  /** Les hypothèses concurrentes sur un même effet (« qui révèle COMPANY_INFORMATION ? »). */
  competing(relation: string, object: string): Hypothesis[] {
    return this.all().filter(
      (hypothesis) =>
        hypothesis.proposition.relation === relation &&
        hypothesis.proposition.object.toLowerCase() === object.toLowerCase() &&
        hypothesis.status !== 'REJECTED',
    );
  }

  /** Reprendre des hypothèses d'un run précédent (connaissance persistée : jamais confirmée de ce fait). */
  restore(saved: readonly Hypothesis[], evidence: readonly Evidence[]): void {
    for (const item of evidence) this.evidence.set(item.id, item);
    for (const hypothesis of saved) {
      this.hypotheses.set(propositionKey(hypothesis.proposition), structuredClone(hypothesis));
      const number = Number(hypothesis.id.replace(/^H-/, ''));
      if (Number.isFinite(number) && number >= this.next) this.next = number + 1;
    }
    for (const hypothesis of this.hypotheses.values()) this.reevaluate(hypothesis);
  }

  evidenceOf(hypothesis: Hypothesis): { for: Evidence[]; against: Evidence[] } {
    const resolve = (references: readonly EvidenceReference[]): Evidence[] =>
      references
        .map((reference) => this.evidence.get(reference.id))
        .filter((item): item is Evidence => item !== undefined);
    return { for: resolve(hypothesis.evidenceFor), against: resolve(hypothesis.evidenceAgainst) };
  }

  private apply(
    hypothesis: Hypothesis,
    evidence: Evidence,
    side: 'for' | 'against',
    created: boolean,
  ): Hypothesis {
    this.evidence.set(evidence.id, evidence);
    const list = side === 'for' ? hypothesis.evidenceFor : hypothesis.evidenceAgainst;
    if (!list.some((reference) => reference.id === evidence.id))
      list.push({ id: evidence.id, type: evidence.type });
    if (isRuntimeEvidence(evidence.type) && side === 'for' && evidence.applicationVersion)
      hypothesis.lastRuntimeVersion = evidence.applicationVersion;
    const previous = hypothesis.status;
    hypothesis.updatedAt = this.now();
    this.reevaluate(hypothesis);
    if (created || previous !== hypothesis.status || side === 'against')
      this.onChange?.({ hypothesis, ...(created ? {} : { previous }), created });
    return hypothesis;
  }

  private reevaluate(hypothesis: Hypothesis): void {
    const { for: support, against } = this.evidenceOf(hypothesis);
    const context = { now: this.now(), ...(this.options.version ? { version: this.options.version } : {}) };
    const forWeight = combineWeights(support.map((item) => evidenceWeight(item, context)));
    const againstWeight = combineWeights(against.map((item) => evidenceWeight(item, context)));
    const runtimeFor = support.filter((item) => isRuntimeEvidence(item.type));
    const runtimeAgainst = against.filter((item) => isRuntimeEvidence(item.type));
    const independent = support.some(
      (item) =>
        item.type === 'STATIC_SOURCE' ||
        item.type === 'BUSINESS_RULE' ||
        item.type === 'HUMAN_RECORDING' ||
        item.type === 'OPENAPI' ||
        (item.type === 'TEST_RESULT' && item.details.experiment === true),
    );
    const llmOnly = support.length > 0 && support.every((item) => item.type === 'LLM_PROPOSAL');
    let confidence = Math.max(0, forWeight - againstWeight * 0.8);
    let status: HypothesisStatus;
    if (llmOnly) {
      // Une affirmation de LLM ne devient jamais une connaissance confirmée.
      status = 'HYPOTHESIS';
      confidence = Math.min(confidence, 0.3);
    } else if (runtimeAgainst.length >= 2 && runtimeFor.length === 0) status = 'REJECTED';
    else if (runtimeAgainst.length > 0 && againstWeight >= forWeight * 0.8) status = 'CONTRADICTED';
    else if (
      runtimeFor.length >= this.options.runtimeObservationsToConfirm &&
      independent &&
      runtimeAgainst.length === 0
    )
      status = 'RUNTIME_CONFIRMED';
    else if (support.length >= 2) status = 'SUPPORTED';
    else status = 'HYPOTHESIS';
    // Une connaissance confirmée sur une autre version, sans preuve runtime récente : STALE.
    if (
      (status === 'RUNTIME_CONFIRMED' || status === 'SUPPORTED') &&
      this.options.version &&
      hypothesis.lastRuntimeVersion &&
      hypothesis.lastRuntimeVersion !== this.options.version &&
      !runtimeFor.some((item) => item.applicationVersion === this.options.version)
    ) {
      status = 'STALE';
      confidence *= 0.6;
    }
    hypothesis.confidence = Math.round(confidence * 1000) / 1000;
    hypothesis.status = status;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
