import type { ScenarioConfig } from '../config/config.js';
import type { KnowledgeIdentity } from '../knowledge/knowledge-model.js';
import { DeterministicConfidenceEngine, type ConfidenceEngine } from './confidence-engine.js';
import { viewportClassOf, type KnowledgeContext } from './knowledge-context.js';

/** L'application dans la connaissance et le stockage : son identité, séparée par environnement. */
export function applicationIdOf(identity: Pick<KnowledgeIdentity, 'application' | 'environment'>): string {
  return identity.environment ? `${identity.application}@${identity.environment}` : identity.application;
}

/**
 * Le contexte courant : l'application et son environnement, l'acteur de l'exploration,
 * la version testée, le navigateur (Chromium) et la classe d'écran de la fenêtre.
 */
export function knowledgeContextOf(config: ScenarioConfig, identity: KnowledgeIdentity): KnowledgeContext {
  const version = identity.commit ?? identity.appVersion;
  return {
    applicationId: applicationIdOf(identity),
    ...(identity.environment ? { environment: identity.environment } : {}),
    actor: config.authorization.primaryActor,
    ...(version ? { version } : {}),
    browser: 'chromium',
    viewportClass: viewportClassOf(config.browser.viewport.width),
  };
}

/**
 * Le ConfidenceEngine de la mission, ou rien : intelligence.enabled et
 * intelligence.confidence.enabled doivent être vrais (sinon le comportement d'avant).
 * aging et context se désactivent séparément.
 */
export function confidenceEngineOf(config: ScenarioConfig, now?: () => string): ConfidenceEngine | undefined {
  const { intelligence } = config;
  if (!intelligence.enabled || !intelligence.confidence.enabled) return undefined;
  return new DeterministicConfidenceEngine({
    sampleHalfPoint: intelligence.confidence.sampleHalfPoint,
    ...(intelligence.aging.enabled
      ? {
          aging: {
            halfLifeDays: intelligence.aging.halfLifeDays ?? config.knowledge.halfLifeDays,
            minWeight: intelligence.aging.minWeight,
          },
        }
      : {}),
    compareContext: intelligence.context.enabled,
    ...(now ? { now } : {}),
  });
}
