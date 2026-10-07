import type { IntelligenceProposal } from './model.js';

/**
 * DECISION CONFIDENCE : ce que mesure chaque score. Un seul nombre mélangeait « je suis sûr qu'il faut
 * s'abstenir » (0.99) et « je suis sûr de cette action » : une abstention sûre passait pour une
 * confiance élevée, une action plausible pour une proposition faible.
 *
 *   action      cette action est la bonne (c'est ELLE que l'arbitre compare au seuil)
 *   hypothesis  l'explication proposée est la bonne
 *   goal        l'objectif fonctionnel visé est le bon
 *   evidence    les preuves citées soutiennent la proposition
 *   safety      l'action est sans risque (la SafetyPolicy reste seule juge)
 *   abstention  il vaut mieux ne rien faire (INCONCLUSIVE / NEED_MORE_EVIDENCE)
 *   overall     la confiance globale déclarée
 */
export interface DecisionConfidence {
  action: number;
  hypothesis?: number;
  goal?: number;
  evidence?: number;
  safety?: number;
  abstention: number;
  overall: number;
}

/** L'action proposée : `selectedActionId`, sinon la première étape du plan (déjà validée). */
export function proposedActionOf(proposal: IntelligenceProposal): string | undefined {
  if (proposal.status !== 'PROPOSAL') return undefined;
  return proposal.selectedActionId ?? proposal.plan?.steps[0];
}

/** Les confiances, séparées ; sans détail fourni, `confidence` est lue selon le statut. */
export function decisionConfidenceOf(proposal: IntelligenceProposal): DecisionConfidence {
  const breakdown = proposal.confidenceBreakdown ?? {};
  const acting = proposal.status === 'PROPOSAL' && proposedActionOf(proposal) !== undefined;
  return {
    // Un score déclaré pour une abstention n'est JAMAIS une confiance dans une action.
    action: breakdown.action ?? (acting ? proposal.confidence : 0),
    ...(breakdown.hypothesis !== undefined ? { hypothesis: breakdown.hypothesis } : {}),
    ...(breakdown.goal !== undefined ? { goal: breakdown.goal } : {}),
    ...(breakdown.evidence !== undefined ? { evidence: breakdown.evidence } : {}),
    ...(breakdown.safety !== undefined ? { safety: breakdown.safety } : {}),
    abstention: breakdown.abstention ?? (proposal.status === 'PROPOSAL' ? 0 : proposal.confidence),
    overall: breakdown.overall ?? proposal.confidence,
  };
}

/** « action 0.87 · hypothesis 0.82 · abstention 0.10 » : chaque score nommé, jamais un nombre seul. */
export function describeConfidence(confidence: DecisionConfidence): string {
  const parts: [string, number | undefined][] = [
    ['action', confidence.action],
    ['hypothesis', confidence.hypothesis],
    ['goal', confidence.goal],
    ['evidence', confidence.evidence],
    ['safety', confidence.safety],
    ['abstention', confidence.abstention],
    ['overall', confidence.overall],
  ];
  return parts
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(' · ');
}
