import { sampleConfidence } from '../intelligence/confidence-engine.js';
import { recencyWeight, type AgingOptions } from '../intelligence/knowledge-aging.js';
import type { RecoveryKnowledge } from '../knowledge/knowledge-model.js';
import { normalizeText } from '../policies/keywords.js';
import type { HistoricalRecovery } from './recovery-planner.js';
import { round } from './similarity.js';

/** La clé d'une action enregistrée dans la mémoire des récupérations (+ son objectif). */
export function recoveryKeyOf(
  action: { kind: string; role?: string; label: string },
  goal: string,
): {
  key: string;
  actionSignature: string;
} {
  const actionSignature = `${action.kind}|${action.role ?? ''}|${normalizeText(action.label)}`;
  return { key: `${actionSignature}|${goal}`, actionSignature };
}

/**
 * HISTORY IS NOT TRUTH : les chemins appris deviennent des CANDIDATS pondérés.
 *
 *   poids = échantillon(succès) × part de succès × récence (KnowledgeAging) × version
 *
 * Un chemin d'une autre version pèse moins (0,7), un chemin ancien perd du poids (demi-vie),
 * un chemin qui n'a jamais réussi et a échoué 2 fois est ÉVITÉ (rendu dans `avoid`).
 */
export function historicalRecoveries(
  knowledge: RecoveryKnowledge | undefined,
  options: { now: string; version?: string; aging?: AgingOptions },
): { candidates: HistoricalRecovery[]; avoid: string[] } {
  const candidates: HistoricalRecovery[] = [];
  const avoid: string[] = [];
  for (const [signature, path] of Object.entries(knowledge?.paths ?? {})) {
    if (path.successes === 0) {
      if (path.failures >= 2) avoid.push(signature);
      continue;
    }
    const share = path.successes / (path.successes + path.failures);
    const recency = recencyWeight(path.lastSuccessAt ?? path.lastSeenAt, options.now, options.aging);
    const sameVersion = !options.version || !path.version || path.version === options.version;
    const weight = round(sampleConfidence(path.successes) * share * recency * (sameVersion ? 1 : 0.7));
    candidates.push({
      actions: path.actions,
      weight,
      successes: path.successes,
      failures: path.failures,
      detail: `${String(path.successes)} success(es), ${String(path.failures)} failure(s)${
        path.version ? `, version ${path.version}` : ''
      }${sameVersion ? '' : ' (another version)'}`,
    });
  }
  candidates.sort((a, b) => b.weight - a.weight);
  return { candidates, avoid };
}
