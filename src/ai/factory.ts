import path from 'node:path';
import type { AiConfig } from '../config/config.js';
import { IntelligenceGateway, type AiEventRecord } from './gateway.js';
import type { IntelligenceMode } from './model.js';
import type { IntelligenceProvider } from './provider.js';
import { CopilotIntelligenceProvider } from './providers/copilot-provider.js';
import { DeterministicIntelligenceProvider } from './providers/deterministic-provider.js';
import { IntelligenceContextSanitizer } from './sanitizer.js';

/** Le mode effectif : `enabled: false` vaut OFF, quel que soit `mode`. */
export function effectiveMode(config: AiConfig): IntelligenceMode {
  return config.enabled ? config.mode : 'OFF';
}

/** Les valeurs d'environnement qui ressemblent à des secrets : retirées de tout ce qui part. */
export function secretValuesOf(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([key, value]) => /pass|pwd|secret|token|api[-_]?key|credential|cookie|session/i.test(key) && value,
    )
    .map(([, value]) => (value ?? '').trim())
    .filter((value) => value.length >= 6);
}

export interface GatewayFactoryOptions {
  env: NodeJS.ProcessEnv;
  /** Un fournisseur injecté par programme (tests, intégrations) : remplace `ai.provider`. */
  provider?: IntelligenceProvider;
  emit?: (record: AiEventRecord) => void;
  /** Valeurs secrètes connues en plus de l'environnement (TestData sensibles). */
  secretValues?: readonly string[];
  cwd?: string;
}

/**
 * La passerelle d'un run, ou RIEN en mode OFF : aucun objet créé, aucun fournisseur, aucun
 * SDK chargé — le comportement d'avant, exactement.
 */
export function createIntelligenceGateway(
  config: AiConfig,
  options: GatewayFactoryOptions,
): IntelligenceGateway | undefined {
  const mode = effectiveMode(config);
  if (mode === 'OFF') return undefined;
  const sanitizer = new IntelligenceContextSanitizer({
    secretValues: [...secretValuesOf(options.env), ...(options.secretValues ?? [])],
    sensitiveFields: config.context.sensitiveFields,
  });
  const providerId = options.provider?.id ?? config.provider;
  return new IntelligenceGateway({
    mode,
    providerId,
    createProvider: () =>
      options.provider ??
      (config.provider === 'deterministic'
        ? new DeterministicIntelligenceProvider()
        : new CopilotIntelligenceProvider({
            model: config.copilot.model,
            sessionReuse: config.copilot.sessionReuse,
            tools: config.copilot.tools,
            timeoutMs: config.copilot.timeoutMs,
            startTimeoutMs: config.copilot.timeoutMs,
            baseDirectory: path.resolve(options.cwd ?? process.cwd(), config.copilot.baseDirectory),
            ...(config.copilot.tokenEnv ? { tokenEnv: config.copilot.tokenEnv } : {}),
            env: options.env,
            sanitize: (value) => sanitizer.sanitizeValue(value),
          })),
    triggers: config.triggers,
    thresholds: config.thresholds,
    budgets: config.budgets,
    timeoutMs: config.copilot.timeoutMs,
    maxRetries: config.copilot.maxRetries,
    failOnUnavailable: config.failOnUnavailable,
    reasoningEffort: config.copilot.reasoningEffort,
    adaptiveReasoning: config.copilot.adaptiveReasoning,
    sanitizer,
    ...(options.emit ? { emit: options.emit } : {}),
  });
}
