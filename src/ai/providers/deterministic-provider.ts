import { normalize } from '../../flows/action-effect-verifier.js';
import type { IntelligenceProposal, IntelligenceRequest, ProviderResult } from '../model.js';
import type { IntelligenceProvider } from '../provider.js';

const words = (text: string): Set<string> =>
  new Set(
    normalize(text)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );

/**
 * Le fournisseur DÉTERMINISTE : aucun réseau, aucun modèle. Il ne propose qu'une action
 * autorisée dont le nom partage des mots avec le but, la suite du parcours ou l'intention —
 * sinon INCONCLUSIVE. Utile pour exercer toute la chaîne (validation, arbitrage, audit,
 * vérification au runtime) sans dépendre d'un service externe.
 */
export class DeterministicIntelligenceProvider implements IntelligenceProvider {
  readonly id = 'deterministic';

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  analyze(request: IntelligenceRequest): Promise<ProviderResult> {
    const target = new Set([
      ...words(request.goal?.id.replace(/_/g, ' ') ?? ''),
      ...(request.goal?.conditions ?? []).flatMap((condition) => [...words(condition)]),
      ...(request.workflowContext?.requiredFields ?? []).flatMap((field) => [...words(field)]),
      ...words(request.workflowContext?.intent ?? ''),
    ]);
    const ranked = request.availableActions
      .filter((action) => action.allowed && action.safety === 'SAFE' && !action.disabled)
      .filter((action) => request.constraints.allowedActionIds.includes(action.id))
      .map((action) => ({
        action,
        overlap: [...words(action.name)].filter((word) => target.has(word)).length,
      }))
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap);
    const [best, second] = ranked;
    const proposal: IntelligenceProposal =
      best && (!second || second.overlap < best.overlap)
        ? {
            status: 'PROPOSAL',
            selectedActionId: best.action.id,
            ...(request.goal ? { intent: request.goal.id } : {}),
            supportingEvidenceIds: [],
            uncertainties: ['lexical overlap only'],
            confidence: 0.5,
          }
        : {
            status: 'INCONCLUSIVE',
            supportingEvidenceIds: [],
            uncertainties: [best ? 'several actions match equally' : 'no allowed action relates to the goal'],
            confidence: 0,
          };
    return Promise.resolve({ raw: proposal, model: 'rules' });
  }
}
