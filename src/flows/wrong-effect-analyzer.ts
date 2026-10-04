import type { FlowStep, StepEffects } from '../config/flow-schema.js';
import { futureEffectsOf } from '../recording/recording-consistency.js';
import type { EffectVerification } from './action-effect-verifier.js';

/**
 * WRONG EFFECT ANALYZER : avant toute récupération, POURQUOI l'effet attendu manque.
 *
 * RECOVERY MUST NOT TRY TO REPAIR A TARGET WHEN THE REAL PROBLEM IS A CORRUPTED EXPECTATION.
 * Une attente enregistrée peut appartenir à la SUITE du parcours (contamination temporelle d'un
 * ancien enregistrement) : l'action a fonctionné, c'est l'attente qui est douteuse. Jamais un
 * masque : une écriture refusée, une cible suivante absente, un effet attendu sans lien avec la
 * suite restent un échec.
 */
export type WrongEffectClassification =
  | 'TARGET_WRONG'
  | 'ACTION_NOT_EXECUTED'
  | 'EXPECTED_EFFECT_MISSING'
  | 'UNEXPECTED_EFFECT'
  | 'EXPECTED_EFFECT_CHANGED'
  | 'RECORDED_EXPECTATION_CONTAMINATED'
  | 'ASYNC_EFFECT_LATE'
  | 'APPLICATION_REGRESSION'
  | 'INCONCLUSIVE';

export interface WrongEffectAnalysis {
  classification: WrongEffectClassification;
  /** Les attentes enregistrées qui désignent la suite du parcours. */
  suspectEffects: string[];
  reasons: string[];
}

export function analyzeWrongEffect(input: {
  verification: EffectVerification;
  effects: StepEffects | undefined;
  steps: readonly FlowStep[];
  index: number;
  /** Les écritures observées et leur statut (undefined : sans réponse). */
  writes: readonly { request: string; status?: number }[];
  /** Les requêtes observées (« GET /api/search 200 »). */
  requests: readonly string[];
  routeChanged: boolean;
  /** La cible de l'étape suivante est-elle disponible maintenant ? */
  nextTargetAvailable: boolean | undefined;
  /** La synchronisation n'a jamais vu l'écran se stabiliser. */
  screenNeverSettled?: boolean;
}): WrongEffectAnalysis {
  const { verification, effects } = input;
  const refused = input.writes.filter((write) => write.status !== undefined && write.status >= 400);
  if (refused.length > 0)
    return {
      classification: 'APPLICATION_REGRESSION',
      suspectEffects: [],
      reasons: refused.map((write) => `${write.request} answered ${String(write.status)}`),
    };
  if (input.screenNeverSettled)
    return { classification: 'ASYNC_EFFECT_LATE', suspectEffects: [], reasons: ['the screen never settled'] };
  // Les attentes qui désignent la SUITE : un contrôle cible d'une étape ultérieure (N+2…), une route
  // non atteinte alors que la cible de l'étape suivante est là (la navigation est celle de la suite).
  const future = futureEffectsOf(input.steps, input.index).map((control) => `+ ${control}`);
  const next = input.steps
    .slice(input.index + 1)
    .find((step) => step.kind !== 'expect' && step.kind !== 'screenshot');
  // Une route PROUVÉE par corrélation à l'enregistrement (provenance DIRECT) n'est jamais suspecte.
  const provenRoute = (effects?.provenance?.effects ?? []).some(
    (entry) => entry.effect.startsWith('route ') && entry.causality === 'DIRECT',
  );
  const routeOfSuite =
    effects?.route !== undefined &&
    !provenRoute &&
    !input.routeChanged &&
    input.nextTargetAvailable === true &&
    next?.kind === 'click'
      ? [`route ${effects.route}`]
      : [];
  const learned = verification.expected.filter((expected) => !expected.startsWith('next target'));
  // La route de la suite explique aussi les contrôles de l'écran qu'elle ouvre.
  const suspects =
    routeOfSuite.length > 0
      ? learned.filter((expected) => !expected.startsWith('request '))
      : future.filter((effect) => learned.includes(effect));
  const allExplained = learned.length > 0 && learned.every((expected) => suspects.includes(expected));
  const worked =
    input.requests.some((request) => /\s2\d\d$/.test(request)) || verification.observed.length > 0;
  if (allExplained && worked && input.nextTargetAvailable === true)
    return {
      classification: 'RECORDED_EXPECTATION_CONTAMINATED',
      suspectEffects: suspects,
      reasons: [
        'every missing expected effect describes a LATER step of the journey (recording-time contamination)',
        input.requests.some((request) => /\s2\d\d$/.test(request))
          ? `the action's request succeeded (${input.requests.filter((request) => /\s2\d\d$/.test(request)).join(', ')})`
          : `the screen changed (${verification.observed.slice(0, 3).join(', ')})`,
        'the next step target is available: the journey can continue',
      ],
    };
  return {
    classification:
      verification.status === 'WRONG_EFFECT'
        ? 'EXPECTED_EFFECT_CHANGED'
        : verification.status === 'NO_EFFECT'
          ? 'EXPECTED_EFFECT_MISSING'
          : 'INCONCLUSIVE',
    suspectEffects: suspects,
    reasons: [...verification.reasons],
  };
}
