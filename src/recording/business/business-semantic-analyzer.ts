import { IntelligenceContextBuilder, type DiscoveredCandidate } from '../../ai/context-builder.js';
import type { IntelligenceGateway } from '../../ai/gateway.js';
import type { Evidence } from '../../cognitive/evidence.js';
import {
  detectBusinessEvents,
  type BusinessDetection,
  type BusinessDetectionInput,
} from './business-event-detector.js';
import type { BusinessEvent } from './model.js';

/**
 * BUSINESS SEMANTIC ANALYZER : qui interprète le parcours.
 *
 *   DETERMINISTIC  toujours, sans coût, sans IA : l'interprétation complète.
 *   LLM            facultatif, seulement pour une AMBIGUÏTÉ (plusieurs entités possibles) : il CHOISIT
 *                  parmi les candidats observés, jamais une entité nouvelle ; son choix est revalidé
 *                  par le détecteur (hors des candidats : ignoré) et ne dépasse jamais PROBABLE.
 */
export interface BusinessSemanticAnalyzer {
  readonly kind: 'DETERMINISTIC' | 'LLM';
  analyze(input: BusinessDetectionInput): Promise<BusinessDetection>;
}

export class DeterministicBusinessAnalyzer implements BusinessSemanticAnalyzer {
  readonly kind = 'DETERMINISTIC' as const;

  analyze(input: BusinessDetectionInput): Promise<BusinessDetection> {
    return Promise.resolve(detectBusinessEvents(input));
  }
}

/** Le choix d'une entité parmi des candidats observés (l'IA, ou un test). */
export type EntityChooser = (question: {
  event: BusinessEvent;
  candidates: readonly string[];
}) => Promise<string | undefined>;

export class LlmBusinessAnalyzer implements BusinessSemanticAnalyzer {
  readonly kind = 'LLM' as const;
  /** Les questions posées et les réponses (rapport). */
  readonly consultations: { eventId: string; candidates: string[]; answer?: string; accepted: boolean }[] =
    [];

  constructor(
    private readonly chooser: EntityChooser,
    private readonly maxCalls = 5,
  ) {}

  async analyze(input: BusinessDetectionInput): Promise<BusinessDetection> {
    const first = detectBusinessEvents(input);
    const ambiguous = first.events.filter(
      (event) =>
        event.status === 'AMBIGUOUS' &&
        event.type === 'ENTITY_CREATED' &&
        (event.candidates?.length ?? 0) > 1,
    );
    if (ambiguous.length === 0) return first;
    const decisions = new Map(input.decisions ?? []);
    for (const event of ambiguous.slice(0, this.maxCalls)) {
      const candidates = event.candidates ?? [];
      const answer = await this.chooser({ event, candidates }).catch(() => undefined);
      const accepted =
        answer !== undefined && candidates.some((candidate) => fold(candidate) === fold(answer));
      this.consultations.push({
        eventId: event.id,
        candidates: [...candidates],
        ...(answer ? { answer } : {}),
        accepted,
      });
      // L'action qui a déclenché l'écriture (le dernier geste du groupe) porte la décision.
      const actionId = event.actionIds.at(-1);
      if (accepted && answer && actionId) decisions.set(actionId, answer);
    }
    if (decisions.size === 0) return first;
    // Le détecteur rejoue tout avec ces choix (une création tranchée nourrit les recherches suivantes).
    return detectBusinessEvents({ ...input, decisions });
  }
}

/**
 * L'IA de QA-CRAWLER (IntelligenceGateway, contexte RECORDING, avis seulement) comme juge d'une
 * ambiguïté : les entités candidates sont les SEULES actions proposées ; la réponse est validée
 * par le gateway (identifiant connu, preuves citées) puis par le détecteur.
 */
export function gatewayEntityChooser(gateway: IntelligenceGateway, sessionId: string): EntityChooser {
  const builder = new IntelligenceContextBuilder({
    maxActions: 10,
    maxEvidence: 20,
    maxHypotheses: 0,
    maxPlanSteps: 3,
  });
  return async ({ event, candidates }) => {
    const trigger = gateway.evaluate({ deterministicConfidence: 0.4, recordingAmbiguity: true });
    if (!trigger.shouldInvoke || !trigger.reason) return undefined;
    const options: DiscoveredCandidate[] = candidates.map((candidate) => ({
      key: `entity:${candidate}`,
      kind: 'click',
      name: candidate,
      safety: 'SAFE',
      allowed: true,
    }));
    const lines = [
      ...event.evidence.network,
      ...event.evidence.dom,
      ...event.evidence.navigation,
      ...event.evidence.context,
    ];
    const evidence: Evidence[] = lines.slice(0, 12).map((line, index) => ({
      id: `E${String(index + 1)}`,
      type: 'HUMAN_RECORDING',
      source: 'business detection',
      confidence: 0.8,
      details: { observation: line.slice(0, 160) },
    }));
    const known = new Set(evidence.map((entry) => entry.id));
    const built = builder.build(trigger.reason, {
      mission: 'business interpretation of a recording',
      workflow: { previous: [], next: [], requiredFields: [] },
      candidates: options,
      evidence,
      hypotheses: [],
      contradictions: [],
      functional: {
        satisfiedPreconditions: [],
        missingPreconditions: [],
        blockingReasons: [],
        causalRelations: [],
        previousConfirmedActions: [],
        nextExpectedActions: [],
        nextActionTargets: [],
        functionalCoverage: [],
        question: `A recorded user action wrote data; the observations do not say which business entity was ${
          event.type === 'ENTITY_CREATED' ? 'created' : 'concerned'
        }. Choose the ONE entity among the action IDs (selectedActionId) that the evidence supports, citing evidence IDs; if the evidence does not decide, answer INCONCLUSIVE. Never invent an entity.`,
      },
    });
    const consulted = await gateway.consult({
      context: 'RECORDING',
      request: built.request,
      scope: { action: `business|${sessionId}|${event.id}` },
      deterministic: { confidence: 0.4 },
      safety: () => ({
        allowed: false,
        classification: 'ADVISORY',
        reason: 'a business interpretation never executes',
      }),
      knownEvidence: (id) => known.has(id),
      advisory: true,
    });
    const proposal = consulted.validation?.valid ? consulted.validation.proposal : undefined;
    if (proposal?.status !== 'PROPOSAL' || !proposal.selectedActionId) return undefined;
    const key = built.keyOf(proposal.selectedActionId);
    return key?.startsWith('entity:') ? key.slice('entity:'.length) : undefined;
  };
}

function fold(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/s$/, '');
}
