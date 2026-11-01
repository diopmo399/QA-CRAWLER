import type {
  ObservedReaction,
  ReactionSignature,
  RuntimeEvent,
  SilentFailure,
  SilentFailureKind,
  TriggerAction,
  TrialVerdict,
  UiSnapshot,
} from '../../sdk/core/incident-trigger-contracts.js';
import type { ActionOutcome } from './session.js';

/**
 * L'ORACLE DE DÉFAILLANCE ET LE DÉTECTEUR DE PANNES SILENCIEUSES.
 *
 * Un clic réussi ne dit rien du métier : l'oracle compare ce qu'une sonde (une action dont on vérifie la
 * réaction) a produit à ce qu'elle produit sur le parcours de référence — requête HTTP, validation, indicateur
 * de chargement, changement du DOM, navigation, message. Les niveaux non observables de l'extérieur (événement
 * DOM reçu, handler exécuté, service appelé) sont dits UNOBSERVABLE, jamais inventés ; un handler est dit
 * exécuté avec exception seulement quand une erreur de page survient pendant l'action.
 * Un blocage global demande plusieurs sondes indépendantes dont le comportement normal est établi.
 * Une erreur Playwright (cible absente, délai) est une défaillance d'infrastructure, jamais un défaut applicatif.
 */
export interface ProbeObservation {
  /** L'index de la sonde dans la séquence et son action. */
  index: number;
  action: TriggerAction;
  outcome: ActionOutcome;
  reference: ReactionSignature | undefined;
}

export interface OracleInput {
  probes: ProbeObservation[];
  /** Les actions préparatoires qui n'ont pas pu être jouées (erreurs d'infrastructure). */
  preparationErrors: string[];
  /** Les événements de tout l'essai (pour l'environnement : navigation en 5xx, réseau). */
  events: RuntimeEvent[];
  /** Les catégories recherchées (d'après la description) ; vide : toute perte de réaction fonctionnelle. */
  target?: readonly SilentFailureKind[];
}

export interface OracleResult {
  verdict: TrialVerdict;
  reason: string;
  failures: SilentFailure[];
  reactions: Record<number, ObservedReaction[]>;
}

const SUBMIT_LIKE =
  /(enregistr|sauvegard|valider|soumettre|envoyer|confirmer|save|submit|send|confirm|apply|ok)/i;
const VALIDATION_TEXT = /(requis|obligatoire|invalide|incorrect|doit |required|invalid|must |mandatory)/i;
const PROMISE_REJECTION = /(in promise|unhandled|promise rejection|non g[ée]r[ée])/i;
const FUNCTIONAL_LOSS: readonly SilentFailureKind[] = [
  'NO_FUNCTIONAL_REACTION_AFTER_ACTION',
  'GLOBAL_ACTION_FAILURE',
  'HTTP_REQUEST_NOT_EMITTED',
  'FORM_SUBMISSION_NOT_TRIGGERED',
  'VALIDATION_NOT_EXECUTED',
  'UI_STATE_STUCK',
];

const eventIds = (events: readonly RuntimeEvent[]): string[] => events.map((event) => event.id);

/** La réaction observée pendant une action : ce que les capteurs ont vu, rien de plus. */
export function reactionOf(outcome: ActionOutcome): ReactionSignature {
  const request = outcome.events.find(
    (event) => event.kind === 'REQUEST' && event.data?.resourceType !== 'document',
  );
  const navigation =
    outcome.events.some((event) => event.kind === 'NAVIGATION') || outcome.before.url !== outcome.after.url;
  const newMessages = outcome.after.messages.filter((message) => !outcome.before.messages.includes(message));
  const invalidAfter = outcome.after.elements.some((element) => element.invalid);
  const invalidBefore = outcome.before.elements.some((element) => element.invalid);
  // Un message de validation encore affiché après la sonde compte : il explique à lui seul l'absence d'envoi.
  const validationShown = outcome.after.messages.some((message) => VALIDATION_TEXT.test(message));
  // Un message d'état (« Dossier créé ») n'est pas une validation : seuls les champs invalides et les textes
  // de validation comptent ; les messages sont suivis à part (`message`).
  const validation =
    newMessages.some((message) => VALIDATION_TEXT.test(message)) ||
    (invalidAfter && !invalidBefore) ||
    validationShown;
  const domChange = snapshotsDiffer(outcome.before, outcome.after);
  const signature: ReactionSignature = {};
  if (request) {
    const method = typeof request.data?.method === 'string' ? request.data.method : 'GET';
    const path = typeof request.data?.path === 'string' ? request.data.path : '';
    signature.request = { method, path };
  }
  if (
    outcome.after.loading ||
    outcome.events.some((event) => event.kind === 'SNAPSHOT' && event.data?.loading === true)
  )
    signature.loading = true;
  if (validation) signature.validation = true;
  if (domChange) signature.domChange = true;
  if (navigation) signature.navigation = true;
  if (newMessages[0]) signature.message = newMessages[0];
  return signature;
}

export function snapshotsDiffer(before: UiSnapshot, after: UiSnapshot): boolean {
  if (before.url !== after.url || before.title !== after.title) return true;
  if (before.overlays !== after.overlays || before.loading !== after.loading) return true;
  if (before.messages.join('|') !== after.messages.join('|')) return true;
  const keys = (snapshot: UiSnapshot): string =>
    snapshot.elements
      .map(
        (element) =>
          `${element.key}:${String(element.enabled)}:${String(element.visible)}:${element.value ?? ''}`,
      )
      .join('|');
  return keys(before) !== keys(after);
}

/** Les sept niveaux d'une sonde : observé, attendu et absent, ou non observable. */
export function observeReactions(probe: ProbeObservation): ObservedReaction[] {
  const { outcome, reference } = probe;
  const seen = reactionOf(outcome);
  const errors = outcome.events.filter((event) => event.kind === 'PAGE_ERROR');
  const requests = outcome.events.filter(
    (event) => event.kind === 'REQUEST' && event.data?.resourceType !== 'document',
  );
  const expectsRequest = reference?.request !== undefined;
  const expectsValidation = reference?.validation === true;
  const expectsResult = Boolean(
    reference && (reference.message || reference.navigation || reference.domChange || reference.loading),
  );
  const levels: ObservedReaction[] = [
    {
      level: 'CLICKED',
      state: outcome.ok ? 'OBSERVED' : 'NOT_OBSERVED',
      eventIds: [],
      ...(outcome.error ? { detail: outcome.error } : {}),
    },
    {
      level: 'DOM_EVENT',
      state: 'UNOBSERVABLE',
      eventIds: [],
      detail: 'non observable de l’extérieur sans instrumentation',
    },
    errors.length > 0
      ? {
          level: 'HANDLER_RUN',
          state: 'OBSERVED',
          eventIds: eventIds(errors),
          detail: `exception pendant l’action : ${errors[0]?.summary ?? ''}`,
        }
      : {
          level: 'HANDLER_RUN',
          state: 'UNOBSERVABLE',
          eventIds: [],
          detail: 'non observable sans erreur ni effet',
        },
    expectsValidation
      ? {
          level: 'VALIDATION_RUN',
          state: seen.validation ? 'OBSERVED' : 'NOT_OBSERVED',
          eventIds: [],
          ...(seen.message ? { detail: seen.message } : {}),
        }
      : { level: 'VALIDATION_RUN', state: seen.validation ? 'OBSERVED' : 'UNOBSERVABLE', eventIds: [] },
    { level: 'SERVICE_CALLED', state: 'UNOBSERVABLE', eventIds: [], detail: 'non observable de l’extérieur' },
    expectsRequest
      ? {
          level: 'HTTP_EMITTED',
          state: requests.length > 0 ? 'OBSERVED' : 'NOT_OBSERVED',
          eventIds: eventIds(requests),
          detail:
            requests[0]?.summary ??
            `attendu : ${reference.request?.method ?? ''} ${reference.request?.path ?? ''}`,
        }
      : {
          level: 'HTTP_EMITTED',
          state: requests.length > 0 ? 'OBSERVED' : 'UNOBSERVABLE',
          eventIds: eventIds(requests),
        },
    expectsResult
      ? {
          level: 'BUSINESS_RESULT',
          state:
            seen.message || seen.navigation || seen.domChange || seen.loading ? 'OBSERVED' : 'NOT_OBSERVED',
          eventIds: [],
          ...(seen.message ? { detail: seen.message } : {}),
        }
      : {
          level: 'BUSINESS_RESULT',
          state: 'UNOBSERVABLE',
          eventIds: [],
          detail: 'aucune réaction de référence établie',
        },
  ];
  return levels;
}

/** Les défaillances silencieuses d'un essai, chacune liée à ses événements et à sa sonde. */
export function detectSilentFailures(probes: readonly ProbeObservation[]): {
  failures: SilentFailure[];
  reactions: Record<number, ObservedReaction[]>;
} {
  const failures: SilentFailure[] = [];
  const reactions: Record<number, ObservedReaction[]> = {};
  const silent: number[] = [];
  for (const probe of probes) {
    const levels = observeReactions(probe);
    reactions[probe.index] = levels;
    if (!probe.outcome.ok) continue;
    const { outcome, reference } = probe;
    const seen = reactionOf(outcome);
    const errors = outcome.events.filter((event) => event.kind === 'PAGE_ERROR');
    for (const error of errors) {
      const rejection =
        PROMISE_REJECTION.test(error.summary) ||
        (typeof error.data?.stack === 'string' && PROMISE_REJECTION.test(error.data.stack));
      failures.push({
        kind: rejection ? 'UNHANDLED_PROMISE_REJECTION' : 'EVENT_HANDLER_EXCEPTION',
        summary: `${rejection ? 'rejet de promesse non géré' : 'exception pendant l’action'} « ${actionLabel(probe.action)} » : ${error.summary}`,
        eventIds: [error.id],
        action: probe.index,
        reactions: levels,
      });
    }
    if (!reference) continue;
    const expected = Boolean(
      reference.request ||
      reference.validation ||
      reference.message ||
      reference.navigation ||
      reference.domChange ||
      reference.loading,
    );
    // Un indicateur de chargement déjà affiché avant la sonde n'est pas une réaction à la sonde.
    const loadingStarted = Boolean(seen.loading && !outcome.before.loading);
    // Pendant une erreur de page, un indicateur ou un changement de DOM n'atteste pas d'une réaction fonctionnelle.
    const reacted = Boolean(
      seen.request ||
      seen.validation ||
      seen.message ||
      seen.navigation ||
      (errors.length === 0 && (seen.domChange || loadingStarted)),
    );
    // Une validation visible explique à elle seule l'absence d'envoi : ce n'est pas une requête manquante.
    if (reference.request && !seen.request && !seen.validation)
      failures.push({
        kind: 'HTTP_REQUEST_NOT_EMITTED',
        summary: `aucune requête ${reference.request.method} ${reference.request.path} après « ${actionLabel(probe.action)} » (émise sur le parcours de référence)`,
        eventIds: eventIds(outcome.events),
        action: probe.index,
        reactions: levels,
      });
    if (reference.validation && !seen.validation)
      failures.push({
        kind: 'VALIDATION_NOT_EXECUTED',
        summary: `aucune validation visible après « ${actionLabel(probe.action)} » (présente sur le parcours de référence)`,
        eventIds: eventIds(outcome.events),
        action: probe.index,
        reactions: levels,
      });
    if (expected && !reacted) {
      silent.push(probe.index);
      const submit = SUBMIT_LIKE.test(probe.action.target ?? '');
      failures.push({
        kind: submit ? 'FORM_SUBMISSION_NOT_TRIGGERED' : 'NO_FUNCTIONAL_REACTION_AFTER_ACTION',
        summary: `aucune réaction fonctionnelle après « ${actionLabel(probe.action)} » : ni requête, ni validation, ni chargement, ni changement d’écran`,
        eventIds: eventIds(outcome.events),
        action: probe.index,
        reactions: levels,
      });
      if (outcome.after.overlays > 0)
        failures.push({
          kind: 'POSSIBLE_EVENT_INTERCEPTION',
          summary: `${String(outcome.after.overlays)} overlay(s) présent(s) pendant l’action sans réaction : interception possible des événements (à vérifier)`,
          eventIds: [],
          action: probe.index,
          reactions: levels,
        });
      else if (errors.length === 0)
        failures.push({
          kind: 'POSSIBLE_CHANGE_DETECTION_FAILURE',
          summary:
            'aucune erreur ni réaction : défaut possible de détection des changements ou garde interne (hypothèse, à vérifier)',
          eventIds: [],
          action: probe.index,
          reactions: levels,
        });
    }
    if (!reference.loading && outcome.after.loading)
      failures.push({
        kind: 'UI_STATE_STUCK',
        summary: `indicateur de chargement toujours affiché après « ${actionLabel(probe.action)} » alors que la référence n’en montre pas`,
        eventIds: [],
        action: probe.index,
        reactions: levels,
      });
  }
  const independent = new Set(
    silent.map((index) => probes.find((probe) => probe.index === index)?.action.target ?? String(index)),
  );
  if (independent.size >= 2)
    failures.push({
      kind: 'GLOBAL_ACTION_FAILURE',
      summary: `${String(independent.size)} actions indépendantes sans réaction fonctionnelle (${[...independent].join(', ')}) : blocage global`,
      eventIds: silent.flatMap(
        (index) =>
          probes.find((probe) => probe.index === index)?.outcome.events.map((event) => event.id) ?? [],
      ),
      reactions: [],
    });
  return { failures, reactions };
}

// Une cible introuvable (locator en délai) est une erreur d'infrastructure de test ; seuls le réseau et la
// navigation en délai désignent l'environnement.
const ENVIRONMENT_ERROR =
  /(net::ERR_|ECONNREFUSED|ENOTFOUND|page\.goto|Navigation timeout|navigating to|\b5\d\d\b)/i;

/** Le verdict d'un essai, avec ce qui le justifie. */
export function judge(input: OracleInput): OracleResult {
  const { failures, reactions } = detectSilentFailures(input.probes);
  const navigationFailure = input.events.find(
    (event) =>
      (event.kind === 'REQUEST_FAILED' && event.data?.resourceType === 'document') ||
      (event.kind === 'RESPONSE' &&
        event.data?.resourceType === 'document' &&
        Number(event.data.status) >= 500),
  );
  if (navigationFailure)
    return {
      verdict: 'ENVIRONMENT_FAILURE',
      reason: `l’application n’a pas répondu : ${navigationFailure.summary}`,
      failures,
      reactions,
    };
  if (input.preparationErrors.length > 0)
    return {
      verdict: 'TEST_INFRASTRUCTURE_FAILURE',
      reason: `une action préparatoire n’a pas pu être jouée : ${input.preparationErrors[0] ?? ''}`,
      failures,
      reactions,
    };
  const probeInfra = input.probes.filter((probe) => !probe.outcome.ok);
  if (probeInfra.length === input.probes.length && input.probes.length > 0)
    return {
      verdict: ENVIRONMENT_ERROR.test(probeInfra[0]?.outcome.error ?? '')
        ? 'ENVIRONMENT_FAILURE'
        : 'TEST_INFRASTRUCTURE_FAILURE',
      reason: `la sonde n’a pas pu être jouée : ${probeInfra[0]?.outcome.error ?? ''}`,
      failures,
      reactions,
    };
  const withReference = input.probes.filter((probe) => probe.reference !== undefined);
  if (withReference.length === 0)
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'aucune réaction de référence : le comportement normal des sondes n’est pas établi',
      failures,
      reactions,
    };
  const wanted = input.target && input.target.length > 0 ? input.target : FUNCTIONAL_LOSS;
  const matched = failures.filter(
    (failure) => wanted.includes(failure.kind) && FUNCTIONAL_LOSS.includes(failure.kind),
  );
  // Une perte de réaction n'est tenue pour reproduite que si elle est globale (≥ 2 sondes indépendantes
  // silencieuses) ou accompagnée d'une erreur de page : une seule sonde muette peut n'être qu'une attente.
  const pageError = failures.some(
    (failure) => failure.kind === 'EVENT_HANDLER_EXCEPTION' || failure.kind === 'UNHANDLED_PROMISE_REJECTION',
  );
  const global = matched.some((failure) => failure.kind === 'GLOBAL_ACTION_FAILURE');
  if (matched.length > 0 && (global || pageError))
    return {
      verdict: 'FAILURE_REPRODUCED',
      reason: matched
        .map((failure) => failure.summary)
        .slice(0, 3)
        .join(' ; '),
      failures,
      reactions,
    };
  if (matched.length > 0)
    return {
      verdict: 'INCONCLUSIVE',
      reason: `une seule sonde sans réaction, sans erreur de page : ${matched[0]?.summary ?? ''} (à confirmer)`,
      failures,
      reactions,
    };
  const onlyExceptions = failures.filter(
    (failure) => failure.kind === 'EVENT_HANDLER_EXCEPTION' || failure.kind === 'UNHANDLED_PROMISE_REJECTION',
  );
  if (
    onlyExceptions.length > 0 &&
    wanted.some((kind) => kind === 'EVENT_HANDLER_EXCEPTION' || kind === 'UNHANDLED_PROMISE_REJECTION')
  )
    return {
      verdict: 'INCONCLUSIVE',
      reason: `erreur de page observée sans perte de réaction fonctionnelle : ${onlyExceptions[0]?.summary ?? ''}`,
      failures,
      reactions,
    };
  return {
    verdict: 'FAILURE_NOT_REPRODUCED',
    reason:
      failures.length > 0
        ? `réactions différentes de la référence sans la perte recherchée : ${failures[0]?.summary ?? ''}`
        : 'chaque sonde a réagi comme sur le parcours de référence',
    failures,
    reactions,
  };
}

export function actionLabel(action: TriggerAction): string {
  const target = action.target ?? '';
  const name = target.includes(':') ? target.slice(target.indexOf(':') + 1) : target;
  return name || action.kind;
}

export const isFunctionalLoss = (kind: SilentFailureKind): boolean => FUNCTIONAL_LOSS.includes(kind);
