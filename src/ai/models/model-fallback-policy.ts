import { ModelCapabilityResolver } from './capability-resolver.js';
import type { AvailableModel, ModelFallbackReason, RequiredCapabilities } from './model-types.js';

export interface FallbackSettings {
  enabled: boolean;
  /**
   * AUTO : le routage officiel de Copilot ; ALTERNATIVE : un autre modèle découvert, utilisable
   * et compatible (dans l'ordre rendu par le SDK — aucun classement), sinon AUTO ;
   * DETERMINISTIC : pas d'IA pour cet appel.
   */
  strategy: 'AUTO' | 'ALTERNATIVE' | 'DETERMINISTIC';
}

export type FallbackResolution =
  | { action: 'AUTO'; reasons: string[] }
  | { action: 'MODEL'; model: AvailableModel; reasons: string[] }
  | { action: 'NONE'; reasons: string[] };

/**
 * MODEL FALLBACK POLICY : que faire quand le modèle voulu n'est pas utilisable (absent, non
 * autorisé, capacité manquante, session refusée, découverte en échec). Le repli n'est JAMAIS
 * masqué : la raison et le modèle d'origine restent dans l'audit et le rapport.
 */
export const ModelFallbackPolicy = {
  resolve(
    reason: ModelFallbackReason,
    settings: FallbackSettings,
    context: {
      models?: readonly AvailableModel[];
      exclude: readonly string[];
      required: RequiredCapabilities;
    },
  ): FallbackResolution {
    if (!settings.enabled) return { action: 'NONE', reasons: [`${reason}: model fallback disabled`] };
    if (settings.strategy === 'DETERMINISTIC')
      return { action: 'NONE', reasons: [`${reason}: fallback strategy DETERMINISTIC`] };
    if (settings.strategy === 'ALTERNATIVE' && reason !== 'MODEL_DISCOVERY_FAILED') {
      const alternative = (context.models ?? []).find(
        (model) =>
          model.available &&
          !context.exclude.includes(model.id) &&
          ModelCapabilityResolver.check(model, context.required).missing.length === 0,
      );
      if (alternative)
        return { action: 'MODEL', model: alternative, reasons: [`${reason}: alternative ${alternative.id}`] };
    }
    return { action: 'AUTO', reasons: [`${reason}: official auto routing`] };
  },
};
