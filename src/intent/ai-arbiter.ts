import { IntelligenceContextBuilder, type DiscoveredCandidate } from '../ai/context-builder.js';
import type { IntelligenceGateway } from '../ai/gateway.js';
import type { AiDecisionRecord } from '../ai/audit-trail.js';
import type { IntelligenceMode } from '../ai/model.js';
import type { Evidence } from '../cognitive/evidence.js';
import type { FunctionalIntent } from './model.js';
import { adoptCandidate } from './resolver.js';

/**
 * AI INTENT ARBITER : pour une intention AMBIGUOUS seulement, le conseiller reçoit LES CANDIDATS et
 * TOUTES LES PREUVES, et choisit UN candidat (jamais une intention nouvelle). La réponse passe par la
 * validation existante (schéma, identifiants, preuves citées) ; sans gateway, en mode OFF, ou quand
 * le fournisseur ne conclut pas, l'intention reste AMBIGUOUS avec ses alternatives classées.
 */
export interface ArbitrateIntentsInput {
  intents: readonly FunctionalIntent[];
  gateway?: IntelligenceGateway;
  mode: IntelligenceMode;
  recordingId: string;
  /** Appels au plus (une intention ambiguë = un appel). */
  maxCalls?: number;
}

export interface ArbitratedIntents {
  intents: FunctionalIntent[];
  decisions: AiDecisionRecord[];
  aiCalls: number;
  /** Les intentions tranchées par l'IA (actionId → candidat retenu). */
  arbitrated: { actionId: string; chosen: string; previous: string }[];
}

export async function arbitrateIntents(input: ArbitrateIntentsInput): Promise<ArbitratedIntents> {
  const intents = [...input.intents];
  const decisions: AiDecisionRecord[] = [];
  const arbitrated: ArbitratedIntents['arbitrated'] = [];
  let aiCalls = 0;
  const gateway = input.gateway;
  if (!gateway || input.mode === 'OFF') return { intents, decisions, aiCalls, arbitrated };
  const builder = new IntelligenceContextBuilder({
    maxActions: 8,
    maxEvidence: 30,
    maxHypotheses: 0,
    maxPlanSteps: 0,
  });
  const limit = input.maxCalls ?? 4;
  for (const [index, intent] of intents.entries()) {
    if (aiCalls >= limit) break;
    if (intent.status !== 'AMBIGUOUS' || intent.alternatives.length < 2) continue;
    const trigger = gateway.evaluate({
      deterministicConfidence: intent.confidence,
      unresolvedIntent: true,
      topScores: intent.alternatives.slice(0, 3).map((candidate) => candidate.confidence),
    });
    if (!trigger.shouldInvoke || !trigger.reason) break;
    const candidates: DiscoveredCandidate[] = intent.alternatives.slice(0, 6).map((candidate) => ({
      key: candidate.name,
      kind: 'click',
      role: candidate.operation ? 'operation' : 'ui-intent',
      name: `${candidate.name} — ${candidate.explanation}`.slice(0, 200),
      safety: 'SAFE',
      allowed: true,
      score: candidate.confidence,
    }));
    const evidence: Evidence[] = intent.evidence.map((item) => ({
      id: item.id,
      type: item.trust,
      source: item.type,
      confidence: item.weight,
      details: {
        summary: item.summary,
        supports: item.supports,
        ...(item.contradicts ? { contradicts: item.contradicts } : {}),
      },
    }));
    const built = builder.build(trigger.reason, {
      mission: input.recordingId,
      workflow: { previous: [], next: [], requiredFields: [], intent: intent.name },
      candidates,
      evidence,
      hypotheses: [],
      contradictions: [],
      deterministic: {
        key: intent.alternatives[0]?.name,
        confidence: intent.confidence,
        status: 'AMBIGUOUS',
      },
      functional: {
        satisfiedPreconditions: [],
        missingPreconditions: [],
        blockingReasons: intent.contradictions.map((contradiction) => contradiction.summary),
        causalRelations: [],
        previousConfirmedActions: [],
        nextExpectedActions: [],
        nextActionTargets: [],
        functionalCoverage: [],
        question: `A human ${intent.physical} on ${intent.target?.role ?? 'an element'} "${intent.target?.label ?? ''}" (route ${intent.context.route ?? '?'}). The deterministic resolver found several plausible functional intents (the IDs A1..An are INTENT CANDIDATES, not browser actions). Using only the provided evidence, pick the single candidate the evidence supports best, cite the evidence ids, or answer INCONCLUSIVE. Never invent an intent.`,
      },
    });
    const consulted = await gateway.consult({
      context: 'RECORDING',
      request: built.request,
      scope: { divergence: `intent|${input.recordingId}|${intent.actionId}` },
      deterministic: {
        actionId: built.idOf(intent.alternatives[0]?.name ?? ''),
        confidence: intent.confidence,
      },
      safety: () => ({
        allowed: true,
        classification: 'ADVISORY',
        reason: 'an intent candidate, never executed',
      }),
      knownEvidence: (id) => intent.evidence.some((item) => item.id === id),
      advisory: true,
    });
    decisions.push(consulted.record);
    if (consulted.record.lifecycle.call) aiCalls += 1;
    const proposal = consulted.validation?.valid ? consulted.validation.proposal : undefined;
    const chosen = proposal?.selectedActionId ? built.keyOf(proposal.selectedActionId) : undefined;
    if (!chosen || !intent.alternatives.some((candidate) => candidate.name === chosen)) continue;
    const cited = proposal?.supportingEvidenceIds.length ?? 0;
    intents[index] = adoptCandidate(
      intent,
      chosen,
      'AI_ARBITER',
      `${String(cited)} evidence(s) cited, decision ${consulted.record.id}`,
    );
    arbitrated.push({ actionId: intent.actionId, chosen, previous: intent.name });
  }
  return { intents, decisions, aiCalls, arbitrated };
}
