import type { ArbiterSource } from './hybrid-arbiter.js';
import type { IntelligenceMode, IntelligenceTriggerReason } from './model.js';

export type AiOutcome =
  | 'PROPOSAL_ACCEPTED'
  | 'PROPOSAL_NOT_SELECTED'
  | 'PROPOSAL_REJECTED'
  | 'SHADOW'
  | 'INCONCLUSIVE'
  | 'NEED_MORE_EVIDENCE'
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_BUDGET_EXHAUSTED'
  | 'AI_ERROR';

export type AiContext = 'EXPLORATION' | 'RECOVERY' | 'FAILURE';

/**
 * Une intervention de l'intelligence, telle qu'elle reste dans l'audit (§62) : le résumé de
 * l'entrée, la proposition STRUCTURÉE, les références de preuve, la validation, la décision,
 * le résultat au runtime. Jamais de « chaîne de pensée », jamais de secret.
 */
export interface AiDecisionRecord {
  id: string;
  at: string;
  context: AiContext;
  trigger: IntelligenceTriggerReason;
  mode: IntelligenceMode;
  provider: string;
  model?: string;
  goal?: string;
  input: {
    actions: number;
    evidence: number;
    hypotheses: number;
    contradictions: number;
    redactions: number;
  };
  deterministic: { actionId?: string; action?: string; confidence: number };
  proposal?: {
    status: string;
    selectedActionId?: string;
    action?: string;
    intent?: string;
    confidence: number;
    evidenceIds: string[];
    uncertainties: string[];
    hypothesis?: string;
    failureCategory?: string;
    summary?: string;
  };
  validation: { status: 'VALID' | 'REJECTED' | 'NOT_RECEIVED'; rejection?: string; reasons: string[] };
  safety?: string;
  accepted: boolean;
  source: ArbiterSource;
  outcome: AiOutcome;
  /** ASSIST : la proposition rejoint-elle la décision exécutée ? */
  shadowAgreement?: boolean;
  runtimeResult?: 'GOAL_CONFIRMED' | 'RUNTIME_CONTRADICTED' | 'NOT_EXECUTED';
  runtimeDetail?: string;
  /** Une proposition confirmée au runtime peut devenir un candidat de connaissance (origine gardée). */
  knowledgeCandidate?: { origin: 'AI_PROPOSAL'; runtimeConfirmed: boolean };
  latencyMs: number;
  toolCalls: number;
  reasons: string[];
}

export interface AiSummary {
  mode: IntelligenceMode;
  provider: string;
  model?: string;
  available?: boolean;
  unavailableReason?: string;
  triggersEvaluated: number;
  fastPath: number;
  calls: number;
  proposals: number;
  accepted: number;
  rejected: number;
  inconclusive: number;
  runtimeConfirmed: number;
  runtimeContradicted: number;
  aiAssistedRecoveries: number;
  shadow: { compared: number; agreements: number; disagreements: number };
  timeouts: number;
  unavailable: number;
  budgetExhausted: number;
  fallbacks: number;
  averageLatencyMs: number;
  toolCalls: number;
  tokens?: { input: number; output: number };
  byTrigger: Partial<Record<IntelligenceTriggerReason, number>>;
  decisions: AiDecisionRecord[];
}

/** INTELLIGENCE AUDIT TRAIL (§61) : une trace par intervention, et les mesures de son utilité (§67). */
export class IntelligenceAuditTrail {
  private next = 1;
  readonly records: AiDecisionRecord[] = [];
  triggersEvaluated = 0;
  fastPath = 0;

  constructor(private readonly limit = 500) {}

  create(record: Omit<AiDecisionRecord, 'id'>): AiDecisionRecord {
    const entry: AiDecisionRecord = { id: `AI-${String(this.next)}`, ...record };
    this.next += 1;
    this.records.push(entry);
    if (this.records.length > this.limit) this.records.shift();
    return entry;
  }

  byId(id: string): AiDecisionRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  summarize(base: {
    mode: IntelligenceMode;
    provider: string;
    model?: string;
    available?: boolean;
    unavailableReason?: string;
    averageLatencyMs: number;
    toolCalls: number;
    tokens?: { input: number; output: number };
  }): AiSummary {
    const count = (predicate: (record: AiDecisionRecord) => boolean) => this.records.filter(predicate).length;
    const byTrigger: Partial<Record<IntelligenceTriggerReason, number>> = {};
    for (const record of this.records) byTrigger[record.trigger] = (byTrigger[record.trigger] ?? 0) + 1;
    const compared = this.records.filter((record) => record.shadowAgreement !== undefined);
    return {
      ...base,
      triggersEvaluated: this.triggersEvaluated,
      fastPath: this.fastPath,
      calls: count(
        (record) => record.outcome !== 'AI_BUDGET_EXHAUSTED' && record.outcome !== 'AI_UNAVAILABLE',
      ),
      proposals: count((record) => record.proposal?.status === 'PROPOSAL'),
      accepted: count((record) => record.accepted),
      rejected: count((record) => record.outcome === 'PROPOSAL_REJECTED'),
      inconclusive: count(
        (record) => record.outcome === 'INCONCLUSIVE' || record.outcome === 'NEED_MORE_EVIDENCE',
      ),
      runtimeConfirmed: count((record) => record.runtimeResult === 'GOAL_CONFIRMED'),
      runtimeContradicted: count((record) => record.runtimeResult === 'RUNTIME_CONTRADICTED'),
      aiAssistedRecoveries: count(
        (record) =>
          record.context === 'RECOVERY' && record.accepted && record.runtimeResult === 'GOAL_CONFIRMED',
      ),
      shadow: {
        compared: compared.length,
        agreements: compared.filter((record) => record.shadowAgreement).length,
        disagreements: compared.filter((record) => !record.shadowAgreement).length,
      },
      timeouts: count((record) => record.outcome === 'AI_TIMEOUT'),
      unavailable: count((record) => record.outcome === 'AI_UNAVAILABLE'),
      budgetExhausted: count((record) => record.outcome === 'AI_BUDGET_EXHAUSTED'),
      fallbacks: count((record) => !record.accepted),
      byTrigger,
      decisions: this.records.slice(-100),
    };
  }
}
