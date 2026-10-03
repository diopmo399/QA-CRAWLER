import type { AvailableModel, ModelCapabilities, RequiredCapabilities } from './model-types.js';

/** Ce que le SDK installé (`ModelInfo`) décrit d'un modèle — lu défensivement. */
export interface SdkModelInfo {
  id: string;
  name?: string;
  capabilities?: {
    supports?: { vision?: boolean; reasoningEffort?: boolean };
    limits?: { max_prompt_tokens?: number; max_output_tokens?: number; max_context_window_tokens?: number };
  };
  policy?: { state?: string };
  billing?: { multiplier?: number };
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

/**
 * MODEL CAPABILITY RESOLVER : traduit la description officielle d'un modèle en capacités
 * internes, SANS rien inventer (une information absente reste absente), et vérifie qu'un
 * modèle satisfait les capacités requises.
 */
export const ModelCapabilityResolver = {
  fromSdk(info: SdkModelInfo): AvailableModel {
    const supports = info.capabilities?.supports;
    const limits = info.capabilities?.limits;
    const efforts = info.supportedReasoningEfforts?.filter((effort) => typeof effort === 'string');
    const capabilities: ModelCapabilities = {
      ...(typeof supports?.reasoningEffort === 'boolean' ? { reasoning: supports.reasoningEffort } : {}),
      ...(efforts && efforts.length > 0 ? { supportedReasoningEfforts: efforts } : {}),
      ...(info.defaultReasoningEffort ? { defaultReasoningEffort: info.defaultReasoningEffort } : {}),
      ...(typeof supports?.vision === 'boolean' ? { vision: supports.vision } : {}),
      ...(typeof limits?.max_context_window_tokens === 'number'
        ? { maxContextTokens: limits.max_context_window_tokens }
        : {}),
      ...(typeof limits?.max_prompt_tokens === 'number' ? { maxPromptTokens: limits.max_prompt_tokens } : {}),
      ...(typeof limits?.max_output_tokens === 'number' ? { maxOutputTokens: limits.max_output_tokens } : {}),
    };
    const state = info.policy?.state;
    const available = state === undefined || state === 'enabled';
    return {
      id: info.id,
      ...(info.name ? { name: info.name } : {}),
      capabilities,
      available,
      ...(available
        ? {}
        : {
            unavailableReason:
              state === 'unconfigured' ? 'MODEL_POLICY_UNCONFIGURED' : 'MODEL_NOT_AUTHORIZED',
          }),
      ...(typeof info.billing?.multiplier === 'number' ? { billingMultiplier: info.billing.multiplier } : {}),
    };
  },

  /**
   * Les capacités requises qui sont CONNUES comme manquantes. Une capacité inconnue n'exclut
   * pas un modèle (elle est seulement signalée).
   */
  check(model: AvailableModel, required: RequiredCapabilities): { missing: string[]; unknown: string[] } {
    const missing: string[] = [];
    const unknown: string[] = [];
    const cap = model.capabilities;
    for (const key of ['tools', 'structuredOutput', 'vision'] as const) {
      if (!required[key]) continue;
      if (cap[key] === false) missing.push(key);
      else if (cap[key] === undefined) unknown.push(key);
    }
    if (required.minContextTokens !== undefined) {
      const limit = cap.maxPromptTokens ?? cap.maxContextTokens;
      if (limit === undefined) unknown.push('context size');
      else if (limit < required.minContextTokens)
        missing.push(`context ${String(limit)} < ${String(required.minContextTokens)} tokens`);
    }
    return { missing, unknown };
  },
};
