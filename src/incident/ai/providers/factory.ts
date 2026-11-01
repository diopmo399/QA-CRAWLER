import type { AiConfig } from '../../../config/config.js';
import type { IncidentAiSettings } from '../config.js';
import type { InvestigationModelClient } from '../model-client.js';
import { createAnthropicInvestigationClient, type AnthropicInvestigationClientOptions } from './anthropic.js';

/**
 * LA FABRIQUE DU CLIENT DE MODÈLE : rien en DETERMINISTIC, rien quand la politique ou la configuration rend
 * l'IA indisponible. Le seul fournisseur pris en charge pour l'investigation est `anthropic` (API Messages avec
 * outils) ; `copilot` est reconnu par la configuration mais son client multi-tours avec outils n'existe pas
 * encore : il est annoncé indisponible, avec la raison, jamais supposé.
 */
export interface ModelClientFactoryResult {
  client?: InvestigationModelClient;
  /** Pourquoi aucun client (jamais un secret). */
  unavailableReason?: string;
}

export interface ModelClientFactoryOptions {
  env: NodeJS.ProcessEnv;
  loadSdk?: AnthropicInvestigationClientOptions['loadSdk'];
  prices?: AnthropicInvestigationClientOptions['prices'];
}

export function createInvestigationModelClient(
  settings: IncidentAiSettings,
  ai: AiConfig | undefined,
  options: ModelClientFactoryOptions,
): ModelClientFactoryResult {
  if (!settings.enabled || settings.mode === 'DETERMINISTIC')
    return settings.unavailableReason !== undefined ? { unavailableReason: settings.unavailableReason } : {};
  if (settings.provider === 'copilot')
    return {
      unavailableReason:
        'Le fournisseur copilot n’est pas pris en charge pour l’investigation (appels d’outils multi-tours) : utilisez anthropic.',
    };
  if (settings.provider !== 'anthropic' || settings.model === undefined)
    return { unavailableReason: 'Aucun fournisseur d’investigation configuré (anthropic avec un modèle).' };
  const anthropic = ai?.anthropic;
  return {
    client: createAnthropicInvestigationClient({
      model: settings.model,
      env: options.env,
      ...(anthropic?.apiKeyEnv ? { apiKeyEnv: anthropic.apiKeyEnv } : {}),
      ...(anthropic?.baseUrl ? { baseUrl: anthropic.baseUrl } : {}),
      ...(anthropic ? { effort: anthropic.effort, serverSideFallback: anthropic.serverSideFallback } : {}),
      maxRetries: settings.maxRetries,
      ...(options.loadSdk ? { loadSdk: options.loadSdk } : {}),
      ...(options.prices ? { prices: options.prices } : {}),
    }),
  };
}
