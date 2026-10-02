import type { IntelligenceRequest, ProviderCallOptions, ProviderResult } from '../../src/ai/model.js';
import type { IntelligenceProvider } from '../../src/ai/provider.js';

/**
 * Un FAUX fournisseur d'intelligence, scripté : aucun réseau, aucun SDK. Il enregistre chaque
 * requête reçue (après nettoyage) et répond par la fonction donnée — pour tester la passerelle,
 * la validation, l'arbitrage, l'audit et la vérification au runtime sans Copilot.
 */
export class FakeIntelligenceProvider implements IntelligenceProvider {
  readonly id = 'fake';
  readonly model = 'fake-model';
  readonly requests: IntelligenceRequest[] = [];
  availabilityChecks = 0;
  closed = false;

  constructor(
    private readonly answer: (request: IntelligenceRequest, options: ProviderCallOptions) => unknown,
    private readonly options: { available?: boolean; reason?: string; delayMs?: number } = {},
  ) {}

  isAvailable(): Promise<boolean> {
    this.availabilityChecks += 1;
    return Promise.resolve(this.options.available ?? true);
  }

  unavailableReason(): string | undefined {
    return this.options.available === false ? (this.options.reason ?? 'fake provider offline') : undefined;
  }

  async analyze(request: IntelligenceRequest, options: ProviderCallOptions): Promise<ProviderResult> {
    this.requests.push(request);
    if (this.options.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    return { raw: this.answer(request, options), model: this.model, toolCalls: 0 };
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** Une proposition « choisir l'action nommée » (par son libellé), au format strict. */
export function proposeByName(
  name: string,
  confidence: number,
  extra: Record<string, unknown> = {},
): (request: IntelligenceRequest) => unknown {
  return (request) => {
    const action = request.availableActions.find((candidate) => candidate.name === name);
    return {
      status: action ? 'PROPOSAL' : 'INCONCLUSIVE',
      ...(action ? { selectedActionId: action.id } : {}),
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: action ? confidence : 0,
      ...extra,
    };
  };
}
