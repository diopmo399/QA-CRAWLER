import type { ScenarioConfig } from '../config/config.js';
import type { KnowledgeIdentity } from '../knowledge/knowledge-model.js';
import type { AdvancedActionScorer } from '../decision/advanced-action-scorer.js';
import type { ActionScorer } from '../decision/action-scorer.js';
import type { CoverageTracker } from '../coverage/coverage-map.js';
import type { KnowledgeBase, TransitionKnowledge } from '../knowledge/knowledge-model.js';
import { classifyFlakiness, DEFAULT_FLAKINESS, type FlakinessResult } from './flakiness.js';
import { AdaptiveActionScorer } from './adaptive-scoring.js';
import { DeterministicConfidenceEngine, type ConfidenceEngine } from './confidence-engine.js';
import type { AgingOptions } from './knowledge-aging.js';
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
  const aging = agingOf(config);
  return new DeterministicConfidenceEngine({
    sampleHalfPoint: intelligence.confidence.sampleHalfPoint,
    ...(aging ? { aging } : {}),
    compareContext: intelligence.context.enabled,
    ...(now ? { now } : {}),
  });
}

/** Vieillissement de la connaissance (intelligence.aging), ou rien s'il est désactivé. */
export function agingOf(config: ScenarioConfig): AgingOptions | undefined {
  const { aging } = config.intelligence;
  if (!aging.enabled) return undefined;
  return { halfLifeDays: aging.halfLifeDays ?? config.knowledge.halfLifeDays, minWeight: aging.minWeight };
}

/**
 * Le scorer de la mission : l'AdvancedActionScorer tel quel, ou enveloppé par
 * l'AdaptiveActionScorer (intelligence.enabled + intelligence.adaptiveScoring.enabled).
 * historyAvailable: false → impact historique nul, même activé.
 */
export function adaptiveScorerOf(
  config: ScenarioConfig,
  inner: AdvancedActionScorer,
  signals: {
    knowledge: KnowledgeBase;
    coverage?: CoverageTracker;
    historyAvailable: boolean;
    now?: () => string;
  },
): ActionScorer {
  const { intelligence } = config;
  if (!intelligence.enabled || !intelligence.adaptiveScoring.enabled) return inner;
  const aging = agingOf(config);
  const { enabled: stabilityEnabled, ...stability } = intelligence.stability;
  return new AdaptiveActionScorer(inner, {
    historyAvailable: signals.historyAvailable,
    weights: {
      confidenceWeight: intelligence.adaptiveScoring.confidenceWeight,
      noveltyWeight: intelligence.adaptiveScoring.noveltyWeight,
      stabilityWeight: intelligence.adaptiveScoring.stabilityWeight,
    },
    sampleHalfPoint: intelligence.confidence.sampleHalfPoint,
    novelty: { enabled: intelligence.novelty.enabled, ...(aging ? { aging } : {}) },
    stability: {
      enabled: stabilityEnabled,
      sampleHalfPoint: intelligence.confidence.sampleHalfPoint,
      ...stability,
    },
    knowledge: signals.knowledge,
    ...(signals.coverage ? { coverage: signals.coverage } : {}),
    ...(signals.now ? { now: signals.now } : {}),
  });
}

/**
 * Le classement d'instabilité (intelligence.enabled + intelligence.flakyDetection.enabled),
 * ou rien : l'oracle historique garde alors son comportement d'avant.
 */
export function flakinessOf(
  config: ScenarioConfig,
): ((knowledge: TransitionKnowledge) => FlakinessResult) | undefined {
  const { intelligence } = config;
  if (!intelligence.enabled || !intelligence.flakyDetection.enabled) return undefined;
  const { enabled: _enabled, ...thresholds } = intelligence.flakyDetection;
  const options = {
    ...DEFAULT_FLAKINESS,
    ...thresholds,
    sampleHalfPoint: intelligence.confidence.sampleHalfPoint,
  };
  return (knowledge) => classifyFlakiness(knowledge, options);
}
