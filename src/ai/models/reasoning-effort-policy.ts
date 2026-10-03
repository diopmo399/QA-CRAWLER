import type { AvailableModel, ComplexityLevel, ReasoningEffortLevel } from './model-types.js';

export interface ReasoningSettings {
  /** AUTO : rien n'est envoyé (défaut du modèle) ; FIXED : `default` ; ADAPTIVE : selon la complexité. */
  mode: 'AUTO' | 'FIXED' | 'ADAPTIVE';
  default: ReasoningEffortLevel;
  lowComplexity: ReasoningEffortLevel;
  mediumComplexity: ReasoningEffortLevel;
  highComplexity: ReasoningEffortLevel;
  veryHighComplexity: ReasoningEffortLevel;
}

const ORDER: readonly ReasoningEffortLevel[] = ['LOW', 'MEDIUM', 'HIGH'];
const toSdk = (level: ReasoningEffortLevel): string => level.toLowerCase();

export interface EffortResolution {
  /** Le niveau envoyé au SDK (absent : rien n'est envoyé). */
  effort?: ReasoningEffortLevel;
  /** Pourquoi le niveau demandé a été changé ou retiré (REASONING_EFFORT_ADJUSTED). */
  adjusted?: string;
}

/**
 * REASONING EFFORT POLICY : le niveau voulu (selon la complexité), puis le niveau POSSIBLE —
 * seulement ceux que le modèle choisi DÉCLARE (`supportedReasoningEfforts`). Jamais envoyé à
 * l'aveugle : un modèle qui ne le déclare pas, ou le routage `auto` (modèle inconnu d'avance),
 * ne reçoit pas de niveau.
 */
export const ReasoningEffortPolicy = {
  requested(level: ComplexityLevel, settings: ReasoningSettings): ReasoningEffortLevel | undefined {
    if (settings.mode === 'AUTO' || level === 'TRIVIAL') return undefined;
    if (settings.mode === 'FIXED') return settings.default;
    return {
      LOW: settings.lowComplexity,
      MEDIUM: settings.mediumComplexity,
      HIGH: settings.highComplexity,
      VERY_HIGH: settings.veryHighComplexity,
    }[level];
  },

  supports(model: AvailableModel, level: ReasoningEffortLevel): boolean {
    return model.capabilities.supportedReasoningEfforts?.includes(toSdk(level)) === true;
  },

  resolve(requested: ReasoningEffortLevel | undefined, model: AvailableModel | undefined): EffortResolution {
    if (!requested) return {};
    if (!model)
      return {
        adjusted: `${requested} not sent: the routed model is not known in advance (support cannot be verified)`,
      };
    const supported = ORDER.filter((level) => ReasoningEffortPolicy.supports(model, level));
    if (model.capabilities.reasoning === false || supported.length === 0)
      return { adjusted: `${requested} not sent: ${model.id} declares no reasoning effort` };
    if (supported.includes(requested)) return { effort: requested };
    const index = ORDER.indexOf(requested);
    const lower = supported.filter((level) => ORDER.indexOf(level) < index).at(-1);
    const nearest = lower ?? supported.find((level) => ORDER.indexOf(level) > index);
    return nearest
      ? { effort: nearest, adjusted: `${requested} unsupported by ${model.id}: ${nearest} used` }
      : { adjusted: `${requested} not sent: unsupported by ${model.id}` };
  },

  toSdk,
};
