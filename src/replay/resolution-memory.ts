import { sampleConfidence } from '../intelligence/confidence-engine.js';
import { recencyWeight, type AgingOptions } from '../intelligence/knowledge-aging.js';
import type { TargetResolutionKnowledge } from '../knowledge/knowledge-model.js';
import { normalizeText } from '../policies/keywords.js';
import { round } from '../workflow-healing/similarity.js';
import type { PlanCandidate } from './model.js';

/**
 * RESOLUTION MEMORY : « Search » a été résolu « Run search » dans le contexte /items, et le parcours
 * a continué → la prochaine fois, la résolution est PROPOSÉE d'abord (HISTORICAL). Jamais une vérité :
 * le candidat doit être à l'écran, la SafetyPolicy le juge, et l'effet runtime le confirme (ou le
 * contredit, ce qui est aussi appris).
 */
export function resolutionKeyOf(
  action: { kind: string; role?: string; label: string },
  route?: string,
): string {
  return `${action.kind}|${action.role ?? ''}|${normalizeText(action.label)}|${routeKey(route)}`;
}

/** /items/42 → /items/{id} : la mémoire vaut pour l'écran, pas pour un enregistrement. */
export function routeKey(route: string | undefined): string {
  if (!route) return '';
  return (route.split('?')[0] ?? route)
    .split('/')
    .map((segment) => (/^\d+$|^[0-9a-f-]{8,}$/i.test(segment) ? '{id}' : segment))
    .join('/');
}

/**
 * Les résolutions apprises → candidats pondérés :
 *   poids = échantillon(succès) × part de succès × récence × version
 * Un candidat qui n'a jamais réussi et a échoué 2 fois est ÉVITÉ.
 */
export function historicalResolutions(
  knowledge: TargetResolutionKnowledge | undefined,
  options: { now: string; version?: string; aging?: AgingOptions },
): { candidates: PlanCandidate[]; avoid: string[] } {
  const candidates: PlanCandidate[] = [];
  const avoid: string[] = [];
  for (const [signature, resolution] of Object.entries(knowledge?.resolutions ?? {})) {
    if (resolution.successes === 0) {
      if (resolution.failures >= 2) avoid.push(signature);
      continue;
    }
    const share = resolution.successes / (resolution.successes + resolution.failures);
    const recency = recencyWeight(
      resolution.lastSuccessAt ?? resolution.lastSeenAt,
      options.now,
      options.aging,
    );
    const sameVersion = !options.version || !resolution.version || resolution.version === options.version;
    const score = round(sampleConfidence(resolution.successes) * share * recency * (sameVersion ? 1 : 0.7));
    candidates.push({
      role: resolution.role,
      name: resolution.name,
      source: 'HISTORICAL',
      score,
      reasons: [
        `learned ${resolution.how}: ${String(resolution.successes)} success(es), ${String(resolution.failures)} failure(s)${sameVersion ? '' : ' (another version)'}`,
      ],
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, avoid };
}
