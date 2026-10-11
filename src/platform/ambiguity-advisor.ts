import { z } from 'zod';
import type { IntelligenceRequest } from '../ai/model.js';
import type { IntelligenceProvider } from '../ai/provider.js';
import { IntelligenceContextSanitizer } from '../ai/sanitizer.js';
import type { RunAnomaly } from './model.js';

/**
 * AMBIGUITY ADVISOR : le LLM (GitHub Copilot ou tout IntelligenceProvider) consulté SEULEMENT aux
 * points d'ambiguïté — une anomalie dont aucune règle n'a reconnu le symptôme (UNKNOWN_FAILURE) ou
 * dont la catégorie est peu sûre — et seulement comme CONSEILLER : son avis est attaché à
 * l'anomalie (advisory), jamais appliqué ; la catégorie, le statut et le verdict ne changent pas.
 *
 * Ce qui existait : IntelligenceProvider, le sanitizer de contexte, les providers Copilot et
 * déterministe, l'audit. Ce qui est nouveau : le point d'appel « analyse du run », hors
 * exploration, borné (maxCalls), avec une réponse validée par un schéma strict.
 *
 *   DISABLED     ai.enabled false ou mode OFF : rien n'est envoyé ;
 *   UNAVAILABLE  le fournisseur n'est pas joignable (SDK absent, jeton absent) ;
 *   REJECTED     la réponse ne respecte pas le schéma (ou est vide) : écartée ;
 *   ADVISORY     un avis court, avec ses incertitudes, à lire par un humain.
 */
export interface AdvisorOptions {
  enabled: boolean;
  maxCalls: number;
  /** Les catégories ambiguës consultées (par défaut : UNKNOWN_FAILURE et confiance < minConfidence). */
  minConfidence: number;
  timeoutMs: number;
  secretValues?: readonly string[];
}

export interface AdvisorSummary {
  mode: 'DISABLED' | 'UNAVAILABLE' | 'ACTIVE';
  provider?: string;
  consulted: number;
  advisory: number;
  rejected: number;
  reason?: string;
}

const adviceSchema = z
  .object({
    status: z.enum(['PROPOSAL', 'INCONCLUSIVE', 'NEED_MORE_EVIDENCE']),
    summary: z.string().max(300).optional(),
    failureCategory: z.string().max(80).optional(),
    nextInvestigation: z.string().max(200).optional(),
    uncertainties: z.array(z.string().max(200)).max(10),
    confidence: z.number().min(0).max(1),
  })
  .passthrough();

/** Les anomalies qui méritent un avis : symptôme non reconnu ou catégorie peu sûre. */
export function ambiguousAnomalies(anomalies: readonly RunAnomaly[], minConfidence: number): RunAnomaly[] {
  return anomalies.filter(
    (anomaly) =>
      anomaly.severity !== 'INFO' &&
      (anomaly.category === 'UNKNOWN_FAILURE' || anomaly.confidence < minConfidence),
  );
}

function requestOf(anomaly: RunAnomaly, index: number): IntelligenceRequest {
  return {
    requestId: `advice-${String(index + 1)}`,
    trigger: 'UNKNOWN_BUSINESS_ERROR',
    availableActions: [],
    relevantEvidence: anomaly.evidence.slice(0, 20).map((detail, position) => ({
      id: `E${String(position + 1)}`,
      type: 'RUNTIME',
      summary: detail,
    })),
    hypotheses: [],
    contradictions: [],
    failure: {
      step:
        anomaly.location.step !== undefined
          ? `${anomaly.location.flow ?? ''}#${String(anomaly.location.step)}`
          : (anomaly.location.url ?? ''),
      symptom: anomaly.symptom,
      observed: anomaly.evidence.slice(0, 10),
    },
    constraints: {
      allowedActionIds: [],
      forbidden: ['executing anything', 'changing the verdict', 'inventing evidence'],
      maxPlanSteps: 0,
    },
  };
}

/** Consulte le fournisseur pour chaque anomalie ambiguë ; pose `anomaly.advisory`. */
export async function adviseOnAmbiguities(
  anomalies: RunAnomaly[],
  provider: IntelligenceProvider | undefined,
  options: AdvisorOptions,
): Promise<AdvisorSummary> {
  const candidates = ambiguousAnomalies(anomalies, options.minConfidence);
  if (!options.enabled || !provider) {
    for (const anomaly of candidates)
      anomaly.advisory = { status: 'DISABLED', reason: 'the intelligence advisor is disabled' };
    return {
      mode: 'DISABLED',
      consulted: 0,
      advisory: 0,
      rejected: 0,
      reason: 'ai.enabled is false or ai.mode is OFF',
    };
  }
  if (!(await provider.isAvailable())) {
    const reason = provider.unavailableReason?.() ?? 'provider unavailable';
    for (const anomaly of candidates) anomaly.advisory = { status: 'UNAVAILABLE', reason };
    return { mode: 'UNAVAILABLE', provider: provider.id, consulted: 0, advisory: 0, rejected: 0, reason };
  }
  const sanitizer = new IntelligenceContextSanitizer({ secretValues: [...(options.secretValues ?? [])] });
  let advisory = 0;
  let rejected = 0;
  let consulted = 0;
  for (const [index, anomaly] of candidates.entries()) {
    if (consulted >= options.maxCalls) {
      anomaly.advisory = {
        status: 'DISABLED',
        reason: `advisor budget reached (${String(options.maxCalls)} call(s))`,
      };
      continue;
    }
    consulted += 1;
    const request = sanitizer.sanitize(requestOf(anomaly, index)).request;
    try {
      const result = await provider.analyze(request, {
        signal: AbortSignal.timeout(options.timeoutMs),
        maxToolCalls: 0,
      });
      const parsed = adviceSchema.safeParse(result.raw);
      if (
        !parsed.success ||
        (!parsed.data.summary && !parsed.data.failureCategory && !parsed.data.nextInvestigation)
      ) {
        rejected += 1;
        anomaly.advisory = {
          status: 'REJECTED',
          reason: parsed.success ? 'empty advice' : 'the answer does not match the advice schema',
        };
        continue;
      }
      advisory += 1;
      const { summary, failureCategory, nextInvestigation, uncertainties, confidence } = parsed.data;
      anomaly.advisory = {
        status: 'ADVISORY',
        text: [
          ...(failureCategory ? [`suggested category (advice only): ${failureCategory}`] : []),
          ...(summary ? [summary] : []),
          ...(nextInvestigation ? [`next investigation: ${nextInvestigation}`] : []),
          ...(uncertainties.length > 0 ? [`uncertainties: ${uncertainties.join('; ')}`] : []),
          `advisor confidence ${String(Math.round(confidence * 100))} %`,
        ].join(' — '),
      };
    } catch (error) {
      rejected += 1;
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      anomaly.advisory = { status: 'REJECTED', reason: `provider error: ${reason ?? 'unknown'}` };
    }
  }
  return { mode: 'ACTIVE', provider: provider.id, consulted, advisory, rejected };
}
