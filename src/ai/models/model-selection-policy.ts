import type { ModelDiscoverySnapshot } from './available-model-registry.js';
import { ModelCapabilityResolver } from './capability-resolver.js';
import type { ComplexityAssessment } from './complexity-analyzer.js';
import { ModelFallbackPolicy, type FallbackSettings } from './model-fallback-policy.js';
import type {
  AutoTier,
  AvailableModel,
  ModelFallbackReason,
  ModelProfile,
  ModelSelectionDecision,
  ModelSelectionMode,
  RequiredCapabilities,
} from './model-types.js';
import { ReasoningEffortPolicy, type ReasoningSettings } from './reasoning-effort-policy.js';

export interface ProfileSettings {
  /** Modèles candidats (identifiants), essayés dans l'ordre s'ils sont découverts et utilisables. */
  models: string[];
  /** Sans candidat utilisable : le routage AUTO officiel, avec cette préférence. */
  autoTier: AutoTier;
}

export interface SelectionInput {
  mode: ModelSelectionMode;
  requestedModel?: string;
  complexity: ComplexityAssessment;
  required: RequiredCapabilities;
  /** undefined : la découverte n'a pas été tentée ; FAILED : elle a échoué. */
  discovery?: ModelDiscoverySnapshot;
  profiles: Record<ModelProfile, ProfileSettings>;
  defaultProfile: ModelProfile;
  reasoning: ReasoningSettings;
  fallback: FallbackSettings;
}

const PROFILE_OF = {
  LOW: 'FAST',
  MEDIUM: 'BALANCED',
  HIGH: 'INTELLIGENCE',
  VERY_HIGH: 'INTELLIGENCE',
} as const satisfies Record<string, ModelProfile>;

/**
 * MODEL SELECTION POLICY : quel modèle, avec quel effort, pour CE raisonnement.
 *
 *   EXPLICIT  le modèle demandé, vérifié AVANT la session (découvert ? autorisé ? capable ?)
 *   AUTO      le routage officiel de Copilot (`auto`), sans le réinventer
 *   ADAPTIVE  complexité → profil (FAST / BALANCED / INTELLIGENCE) → un modèle candidat
 *             découvert et capable, sinon `auto` avec la préférence du profil
 *
 * Aucun classement de modèles écrit en dur : seulement la configuration, les capacités
 * découvertes et la difficulté. Toute décision porte ses raisons ; tout repli est visible.
 */
export const ModelSelectionPolicy = {
  select(input: SelectionInput): ModelSelectionDecision {
    const { complexity } = input;
    const base = { mode: input.mode, complexity: complexity.level, alternatives: [] as string[] };
    if (complexity.level === 'TRIVIAL')
      return { ...base, status: 'NO_LLM_REQUIRED', reasons: ['TRIVIAL: no LLM required'], confidence: 1 };
    const requestedEffort = ReasoningEffortPolicy.requested(complexity.level, input.reasoning);
    const discovered = input.discovery?.status === 'OK' ? input.discovery.models : undefined;
    const reasons = [`complexity ${complexity.level} (${complexity.reasons.slice(0, 4).join('; ')})`];
    const alternatives = (discovered ?? []).filter((model) => model.available).map((model) => model.id);

    const finish = (
      selected: { model?: AvailableModel; id: string; autoTier?: AutoTier; profile?: ModelProfile },
      confidence: number,
      extra: {
        requestedModel?: string;
        fallback?: ModelSelectionDecision['fallback'];
        reasons?: string[];
      } = {},
    ): ModelSelectionDecision => {
      const effort = ReasoningEffortPolicy.resolve(requestedEffort, selected.model);
      return {
        ...base,
        status: 'SELECTED',
        ...(extra.requestedModel ? { requestedModel: extra.requestedModel } : {}),
        selectedModel: selected.id,
        ...(selected.autoTier ? { autoTier: selected.autoTier } : {}),
        ...(selected.profile ? { profile: selected.profile } : {}),
        ...(requestedEffort ? { requestedReasoningEffort: requestedEffort } : {}),
        ...(effort.effort ? { reasoningEffort: effort.effort } : {}),
        alternatives: alternatives.filter((id) => id !== selected.id).slice(0, 5),
        reasons: [
          ...reasons,
          ...(extra.reasons ?? []),
          ...(effort.adjusted ? [`REASONING_EFFORT_ADJUSTED: ${effort.adjusted}`] : []),
          ...(effort.effort ? [`reasoning effort ${effort.effort}`] : []),
        ],
        confidence,
        ...(extra.fallback ? { fallback: extra.fallback } : {}),
      };
    };
    const fallBack = (
      reason: ModelFallbackReason,
      from: string | undefined,
      context: { profile?: ModelProfile; autoTier?: AutoTier; detail: string },
    ): ModelSelectionDecision => {
      const resolution = ModelFallbackPolicy.resolve(reason, input.fallback, {
        ...(discovered ? { models: discovered } : {}),
        exclude: from ? [from] : [],
        required: input.required,
      });
      const fallback = { reason, ...(from ? { from } : {}) };
      const requested = input.requestedModel ? { requestedModel: input.requestedModel } : {};
      if (resolution.action === 'NONE')
        return {
          ...base,
          status: 'NO_MODEL',
          ...requested,
          ...(context.profile ? { profile: context.profile } : {}),
          ...(requestedEffort ? { requestedReasoningEffort: requestedEffort } : {}),
          alternatives: alternatives.slice(0, 5),
          reasons: [...reasons, context.detail, ...resolution.reasons],
          confidence: 0,
          fallback,
        };
      if (resolution.action === 'MODEL')
        return finish(
          {
            model: resolution.model,
            id: resolution.model.id,
            ...(context.profile ? { profile: context.profile } : {}),
          },
          0.6,
          {
            ...requested,
            fallback: { ...fallback, to: resolution.model.id },
            reasons: [context.detail, ...resolution.reasons],
          },
        );
      return finish(
        {
          id: 'auto',
          ...(context.autoTier ? { autoTier: context.autoTier } : {}),
          ...(context.profile ? { profile: context.profile } : {}),
        },
        0.5,
        {
          ...requested,
          fallback: { ...fallback, to: 'auto' },
          reasons: [context.detail, ...resolution.reasons],
        },
      );
    };
    /** Le modèle demandé est-il utilisable ? (vérifié avant toute session) */
    const usable = (
      id: string,
    ): { model?: AvailableModel; problem?: ModelFallbackReason; detail: string } => {
      const model = discovered?.find((candidate) => candidate.id === id);
      if (!model) return { problem: 'MODEL_NOT_AVAILABLE', detail: `${id} is not offered to this account` };
      if (!model.available)
        return {
          problem: 'MODEL_NOT_AUTHORIZED',
          detail: `${id} is listed but not enabled (${model.unavailableReason ?? 'policy'})`,
        };
      const check = ModelCapabilityResolver.check(model, input.required);
      if (check.missing.length > 0)
        return {
          model,
          problem: 'MODEL_CAPABILITY_MISMATCH',
          detail: `${id} lacks ${check.missing.join(', ')}`,
        };
      return {
        model,
        detail: `${id} available${check.unknown.length > 0 ? ` (unknown: ${check.unknown.join(', ')})` : ''}`,
      };
    };

    if (input.mode === 'EXPLICIT' && input.requestedModel) {
      const requested = input.requestedModel;
      if (!discovered) {
        if (input.discovery?.status === 'FAILED')
          return fallBack('MODEL_DISCOVERY_FAILED', requested, {
            detail: `availability of ${requested} cannot be verified (discovery failed)`,
          });
        return finish({ id: requested }, 0.5, {
          requestedModel: requested,
          reasons: [`EXPLICIT ${requested} (availability not verified)`],
        });
      }
      const check = usable(requested);
      if (check.problem) return fallBack(check.problem, requested, { detail: check.detail });
      return finish({ ...(check.model ? { model: check.model } : {}), id: requested }, 1, {
        requestedModel: requested,
        reasons: [`EXPLICIT ${check.detail}`],
      });
    }

    if (input.mode === 'ADAPTIVE') {
      // MEDIUM, le cas ordinaire, prend le profil par défaut configuré (BALANCED par défaut).
      const profile = complexity.level === 'MEDIUM' ? input.defaultProfile : PROFILE_OF[complexity.level];
      const settings = input.profiles[profile];
      const profileReason = `ADAPTIVE: ${complexity.level} → ${profile}`;
      if (settings.models.length > 0) {
        if (!discovered)
          return fallBack('MODEL_DISCOVERY_FAILED', settings.models[0], {
            profile,
            autoTier: settings.autoTier,
            detail: `${profileReason}; candidates cannot be verified (discovery ${input.discovery?.status ?? 'not run'})`,
          });
        const checks = settings.models.map((id) => ({ id, ...usable(id) }));
        const capable = checks.filter((check) => !check.problem && check.model);
        const best =
          capable.find(
            (check) =>
              !requestedEffort ||
              (check.model && ReasoningEffortPolicy.supports(check.model, requestedEffort)),
          ) ?? capable[0];
        if (best?.model)
          return finish({ model: best.model, id: best.id, profile }, 0.8, {
            reasons: [
              profileReason,
              `profile candidate ${best.detail}`,
              ...checks.filter((check) => check.problem).map((check) => `skipped ${check.detail}`),
            ],
          });
        return fallBack(checks[0]?.problem ?? 'MODEL_NOT_AVAILABLE', settings.models[0], {
          profile,
          autoTier: settings.autoTier,
          detail: `${profileReason}; no usable candidate (${checks.map((check) => check.detail).join('; ')})`,
        });
      }
      return finish({ id: 'auto', autoTier: settings.autoTier, profile }, 0.7, {
        reasons: [profileReason, `official auto routing (autoTier ${settings.autoTier})`],
      });
    }

    return finish({ id: 'auto' }, 0.6, {
      reasons: [
        input.mode === 'EXPLICIT'
          ? 'EXPLICIT without a model: official auto routing'
          : 'AUTO: official auto routing',
      ],
    });
  },
};
