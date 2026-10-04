import type { StepEffects } from '../config/flow-schema.js';
import type { SemanticRecordedAction } from './model.js';

/**
 * ACTION EFFECT CORRELATION : TIME DOES NOT PROVE CAUSALITY.
 *
 * Un effet observé APRÈS une action n'est pas forcément SON effet. Chaque effet candidat est
 * classé par la force de sa preuve :
 *  - DIRECT                : corrélé par identité (la requête de la fenêtre de l'action, la navigation
 *                            que l'ActionCorrelationEngine lui attribue) ;
 *  - STRONGLY_CORRELATED   : l'écran observé pour CETTE action seule, avant toute action humaine suivante ;
 *  - POSSIBLY_CORRELATED   : un indice (une réponse jamais reçue pendant la fenêtre…) ;
 *  - TEMPORAL_ONLY         : seulement « après » ;
 *  - BELONGS_TO_NEXT_ACTION: observé sur un écran partagé avec une action humaine PLUS RÉCENTE, ou une
 *                            route que la corrélation donne à l'action suivante ;
 *  - BACKGROUND / AMBIGUOUS.
 * Seuls DIRECT et STRONGLY_CORRELATED deviennent des attentes obligatoires ; POSSIBLY_CORRELATED une
 * attente facultative ; le reste est écarté (et consigné dans la validation de l'enregistrement).
 */
export type EffectCausality =
  | 'DIRECT'
  | 'STRONGLY_CORRELATED'
  | 'POSSIBLY_CORRELATED'
  | 'TEMPORAL_ONLY'
  | 'BELONGS_TO_NEXT_ACTION'
  | 'BACKGROUND'
  | 'AMBIGUOUS';

export type CausalEffectKind = 'APPEARS' | 'DISAPPEARS' | 'ROUTE' | 'REQUEST';

export interface CausalEffectCandidate {
  /** « + button:Process », « route /process », « request GET /api/search ». */
  effect: string;
  kind: CausalEffectKind;
  /** L'action évaluée. */
  actionId: string;
  /** Le propriétaire retenu ; undefined si l'attribution est ambiguë. */
  ownerActionId?: string;
  temporalConfidence: number;
  causalConfidence: number;
  evidence: string[];
  startedBeforeNextHumanAction: boolean;
  completedAfterNextHumanAction?: boolean;
  /** L'identifiant qui prouve le lien (fenêtre réseau, navigation corrélée). */
  correlationId?: string;
  classification: EffectCausality;
  /**
   * EFFECT_REASSIGNED : écarté de cette action parce que la capture pré-action de l'action suivante
   * prouve qu'il est venu APRÈS le début de son geste — il revient à l'action suivante.
   */
  reassignTo?: string;
}

const REQUIRED: readonly EffectCausality[] = ['DIRECT', 'STRONGLY_CORRELATED'];
const CONFIDENCE: Record<EffectCausality, number> = {
  DIRECT: 0.97,
  STRONGLY_CORRELATED: 0.85,
  POSSIBLY_CORRELATED: 0.55,
  TEMPORAL_ONLY: 0.3,
  BELONGS_TO_NEXT_ACTION: 0.1,
  BACKGROUND: 0.1,
  AMBIGUOUS: 0.3,
};

/** L'effet est-il une attente OBLIGATOIRE ? (DIRECT, STRONGLY_CORRELATED) */
export function isRequired(candidate: CausalEffectCandidate): boolean {
  return REQUIRED.includes(candidate.classification);
}

/**
 * Les effets candidats d'une action, classés. `learned` : ce que l'écran / le réseau montrent
 * (learnExpectedEffects) ; `ownsScreen` : l'écran observé lui revient (le geste le plus récent avant
 * l'observation) ; `screenShared` : d'autres gestes partagent cet écran ; `next` : l'action humaine
 * suivante (frontière causale).
 */
export function classifyEffects(input: {
  action: SemanticRecordedAction;
  learned: StepEffects | undefined;
  ownsScreen: boolean;
  screenShared: boolean;
  /** Le geste le plus récent qui partage l'écran (son propriétaire), si ce n'est pas cette action. */
  screenOwner?: SemanticRecordedAction;
  next?: SemanticRecordedAction;
}): CausalEffectCandidate[] {
  const { action, learned, ownsScreen, next } = input;
  if (!learned) return [];
  const candidates: CausalEffectCandidate[] = [];
  const correlatedRoutes = new Set(action.navigation?.routes ?? []);
  const nextRoutes = new Set(next?.navigation?.routes ?? []);
  const closedByNext = action.observationClosedBy !== undefined;
  const add = (
    kind: CausalEffectKind,
    effect: string,
    classification: EffectCausality,
    evidence: string[],
    extra: Partial<CausalEffectCandidate> = {},
  ): void => {
    const owner =
      classification === 'BELONGS_TO_NEXT_ACTION'
        ? (input.screenOwner?.id ?? next?.id)
        : classification === 'AMBIGUOUS'
          ? undefined
          : action.id;
    candidates.push({
      effect,
      kind,
      actionId: action.id,
      ...(owner ? { ownerActionId: owner } : {}),
      temporalConfidence: classification === 'BELONGS_TO_NEXT_ACTION' ? 0.4 : 0.9,
      causalConfidence: CONFIDENCE[classification],
      evidence,
      startedBeforeNextHumanAction: classification !== 'BELONGS_TO_NEXT_ACTION',
      classification,
      ...extra,
    });
  };
  // Un écran capté à la frontière APRÈS la navigation de l'action suivante (sa route est celle que la
  // corrélation donne à la suite) : tout cet écran appartient à l'action suivante.
  const screenOfNext =
    closedByNext &&
    learned.route !== undefined &&
    [...nextRoutes].some((candidate) => routeTemplateEquals(candidate, learned.route ?? ''));
  // L'écran au DÉBUT du geste suivant (capture pré-action, avant son gestionnaire) : ce que CETTE
  // action a laissé. Un contrôle apparu qui n'y est pas encore est apparu après le début du geste
  // suivant (un dialogue ouvert de façon synchrone par lui) : jamais un effet de cette action.
  const nextBefore = closedByNext && next?.preActionControls ? new Set(next.preActionControls) : undefined;
  const nameOf = (effect: string): string =>
    effect
      .slice(effect.indexOf(':') + 1)
      .trim()
      .toLowerCase();
  // L'écran : à cette action seulement si elle est le geste le plus récent avant l'observation.
  const screen = (kind: CausalEffectKind, effect: string): void => {
    if (kind === 'APPEARS' && nextBefore && !nextBefore.has(nameOf(effect.slice(2)))) {
      add(
        kind,
        effect,
        'BELONGS_TO_NEXT_ACTION',
        [
          `absent when the next human action (${next?.id ?? '?'}) started (pre-action capture): it appeared after it`,
        ],
        next ? { reassignTo: next.id } : {},
      );
      return;
    }
    if (kind === 'DISAPPEARS' && nextBefore && nextBefore.has(nameOf(effect.slice(2)))) {
      add(
        kind,
        effect,
        'BELONGS_TO_NEXT_ACTION',
        [`still present when the next human action (${next?.id ?? '?'}) started: it disappeared after it`],
        next ? { reassignTo: next.id } : {},
      );
      return;
    }
    if (screenOfNext) {
      add(kind, effect, 'BELONGS_TO_NEXT_ACTION', [
        `observed at the boundary after the navigation of the next action (${next?.id ?? '?'})`,
      ]);
      return;
    }
    if (!ownsScreen) {
      add(kind, effect, 'BELONGS_TO_NEXT_ACTION', [
        `observed on a screen shared with a later human action (${input.screenOwner?.id ?? next?.id ?? '?'})`,
      ]);
      return;
    }
    add(kind, effect, 'STRONGLY_CORRELATED', [
      input.screenShared
        ? 'the most recent human action before the observation'
        : 'the screen observed for this action alone',
      ...(closedByNext ? ['observed at the boundary, before the next human action'] : []),
    ]);
  };
  for (const control of learned.appears ?? []) screen('APPEARS', `+ ${control}`);
  for (const control of learned.disappears ?? []) screen('DISAPPEARS', `- ${control}`);
  if (learned.route) {
    const route = learned.route;
    if ([...correlatedRoutes].some((candidate) => routeTemplateEquals(candidate, route)))
      add(
        'ROUTE',
        `route ${route}`,
        'DIRECT',
        ['navigation correlated to this action (ActionCorrelationEngine)'],
        {
          correlationId: action.navigation?.navigationIds.at(-1) ?? action.id,
        },
      );
    else if ([...nextRoutes].some((candidate) => routeTemplateEquals(candidate, route)))
      // Une route que la corrélation donne à l'action SUIVANTE : jamais un effet de celle-ci.
      add('ROUTE', `route ${route}`, 'BELONGS_TO_NEXT_ACTION', [
        `the navigation to ${route} is correlated to the next action (${next?.id ?? '?'})`,
      ]);
    else screen('ROUTE', `route ${route}`);
  }
  if (learned.request) {
    const [method, path] = learned.request.split(' ');
    const exchange = action.network.find(
      (candidate) => candidate.method.toUpperCase() === method && path !== undefined,
    );
    const answered = exchange?.status !== undefined;
    add(
      'REQUEST',
      `request ${learned.request}`,
      answered ? 'DIRECT' : 'POSSIBLY_CORRELATED',
      [
        answered
          ? `sent in this action's network window (answered ${String(exchange.status)})`
          : "sent in this action's network window, no answer observed",
      ],
      { correlationId: action.id, ...(answered ? {} : { completedAfterNextHumanAction: true }) },
    );
  }
  return candidates;
}

/** Les attentes du YAML : obligatoires (DIRECT, STRONGLY), facultatives (POSSIBLY), avec leur provenance. */
export function expectedEffectsFrom(
  action: SemanticRecordedAction,
  candidates: readonly CausalEffectCandidate[],
): StepEffects | undefined {
  const required = candidates.filter(isRequired);
  const optional = candidates.filter((candidate) => candidate.classification === 'POSSIBLY_CORRELATED');
  const effects: StepEffects = {};
  const appears = required.filter((c) => c.kind === 'APPEARS').map((c) => c.effect.slice(2));
  const disappears = required.filter((c) => c.kind === 'DISAPPEARS').map((c) => c.effect.slice(2));
  const route = required.find((c) => c.kind === 'ROUTE')?.effect.slice('route '.length);
  const request = required.find((c) => c.kind === 'REQUEST')?.effect.slice('request '.length);
  if (appears.length > 0) effects.appears = appears;
  if (disappears.length > 0) effects.disappears = disappears;
  if (route) effects.route = route;
  if (request) effects.request = request;
  if (optional.length > 0) effects.optional = optional.map((candidate) => candidate.effect);
  const kept = [...required, ...optional];
  if (kept.length === 0) return undefined;
  effects.provenance = {
    actionId: action.id,
    effects: kept.map((candidate) => ({
      effect: candidate.effect,
      causality: candidate.classification,
      confidence: candidate.causalConfidence,
    })),
  };
  return effects;
}

/** /requests/42 et /requests/{id} désignent la même route (gabarit). */
function routeTemplateEquals(a: string, b: string): boolean {
  const normalize = (route: string): string =>
    route
      .split(/[?#]/)[0]
      ?.split('/')
      .map((segment) => (/^\{.+\}$|^:|^\d+$/.test(segment) ? '{}' : segment))
      .join('/') ?? route;
  return normalize(a) === normalize(b);
}
