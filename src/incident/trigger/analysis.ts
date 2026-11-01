import type {
  Experiment,
  Hypothesis,
  Layer,
  ProposedVerification,
} from '../../sdk/core/incident-contracts.js';
import type {
  AngularModel,
  AngularNode,
  DataLossAnalysis,
  FirstFailureAnalysis,
  IncidentBrief,
  MinimalReproduction,
  RuntimeEvent,
  SilentFailureKind,
  TriggerCondition,
  TriggerTrial,
} from '../../sdk/core/incident-trigger-contracts.js';
import { isFactorAction, type Factor } from './model.js';
import { describeAction } from './session.js';

/**
 * L'ANALYSE APRÈS EXPLORATION : les conditions (facteurs présents / absents dans les essais reproduisant),
 * la première défaillance (ce qui a fonctionné en dernier, la première erreur, la propagation), la perte de
 * données (champs modifiés non enregistrés, ce que le code montre), puis des hypothèses de cause Angular
 * fondées sur des observations — jamais sur une catégorie présumée. Chaque hypothèse reste PROPOSED : la
 * règle déterministe de confirmation de l'incident (≥ 2 vérifications de nature différente) vaut ensuite.
 */

// ── Conditions ────────────────────────────────────────────────────────────────────────────────

const rate = (count: { reproduced: number; total: number }): number =>
  count.total === 0 ? 0 : count.reproduced / count.total;

export function deriveConditions(
  trials: readonly TriggerTrial[],
  factors: readonly Factor[],
  minimal: MinimalReproduction | undefined,
  threshold: number,
): TriggerCondition[] {
  const judged = trials.filter(
    (trial) =>
      trial.status === 'DONE' &&
      (trial.verdict === 'FAILURE_REPRODUCED' || trial.verdict === 'FAILURE_NOT_REPRODUCED'),
  );
  const seen = new Set<string>();
  for (const trial of judged) for (const id of Object.keys(trial.factors)) seen.add(id);
  const minimalIds = new Set(minimal?.actions.map((action) => action.origin ?? '').filter(Boolean));
  const conditions: TriggerCondition[] = [];
  for (const id of seen) {
    const factor = factors.find((item) => item.id === id);
    const count = (subset: readonly TriggerTrial[]) => ({
      reproduced: subset.filter((trial) => trial.verdict === 'FAILURE_REPRODUCED').length,
      total: subset.length,
    });
    const withCondition = count(judged.filter((trial) => id in trial.factors));
    const withoutCondition = count(judged.filter((trial) => !(id in trial.factors)));
    const withRate = rate(withCondition);
    const withoutRate = rate(withoutCondition);
    let role: TriggerCondition['role'] = 'CANDIDATE';
    if (minimalIds.has(id) && withoutCondition.total > 0 && withoutCondition.reproduced === 0)
      role = 'NECESSARY';
    else if (withCondition.reproduced === 0 && withCondition.total >= 2) role = 'REFUTED';
    else if (withCondition.reproduced > 0 && withRate >= threshold && withRate > withoutRate)
      role = 'CONTRIBUTING';
    else if (withCondition.reproduced > 0 && withRate > withoutRate) role = 'CANDIDATE';
    else if (withCondition.reproduced === 0) role = 'REFUTED';
    const trialIds = judged.filter((trial) => id in trial.factors).map((trial) => trial.id);
    conditions.push({
      id: `cond:${id}`,
      description: factor?.label ?? trials.find((trial) => id in trial.factors)?.factors[id] ?? id,
      actions: factor?.actions ?? [],
      role,
      withCondition,
      withoutCondition,
      source: 'EXPERIMENT_VERIFIED',
      trialIds,
    });
  }
  const order: Record<TriggerCondition['role'], number> = {
    NECESSARY: 0,
    CONTRIBUTING: 1,
    CANDIDATE: 2,
    REFUTED: 3,
  };
  return conditions.sort(
    (a, b) => order[a.role] - order[b.role] || rate(b.withCondition) - rate(a.withCondition),
  );
}

// ── Première défaillance ──────────────────────────────────────────────────────────────────────

const eventRef = (trial: TriggerTrial, event: RuntimeEvent) => ({
  trialId: trial.id,
  eventId: event.id,
  summary: event.summary,
});

export function analyzeFirstFailure(
  failing: TriggerTrial | undefined,
  reference: TriggerTrial | undefined,
  allFailing: readonly TriggerTrial[],
): FirstFailureAnalysis | undefined {
  if (!failing) return undefined;
  const events = failing.events;
  const firstErrorEvent = events.find((event) => event.kind === 'PAGE_ERROR');
  const errorT = firstErrorEvent?.t ?? Number.POSITIVE_INFINITY;
  const before = events.filter((event) => event.t < errorT);
  const lastOk = (kind: RuntimeEvent['kind'], extra?: (event: RuntimeEvent) => boolean) =>
    [...before].reverse().find((event) => event.kind === kind && (extra ? extra(event) : true));
  const lastRequest = lastOk('RESPONSE', (event) => {
    const status = Number(event.data?.status ?? 0);
    return status > 0 && status < 400;
  });
  const lastNavigation = lastOk('NAVIGATION') ?? lastOk('ROUTE');
  const lastState = lastOk('DOM') ?? lastOk('SNAPSHOT');
  const lastActionEvent = lastOk('ACTION');
  const firstFailedIndex = failing.probes.find((index) =>
    failing.failures.some((failure) => failure.action === index),
  );
  const propagation: string[] = [];
  if (firstErrorEvent) {
    propagation.push(
      `erreur de page à t+${String(firstErrorEvent.t)} ms pendant « ${actionAt(failing, firstErrorEvent.action)} »`,
    );
    const afterError = events.filter((event) => event.t > errorT);
    const requestsAfter = afterError.filter((event) => event.kind === 'REQUEST').length;
    const actionsAfter = afterError.filter((event) => event.kind === 'ACTION').length;
    if (actionsAfter > 0)
      propagation.push(
        requestsAfter === 0
          ? `${String(actionsAfter)} action(s) jouée(s) ensuite sans aucune requête HTTP`
          : `${String(actionsAfter)} action(s) ensuite, ${String(requestsAfter)} requête(s) encore émise(s)`,
      );
  }
  for (const failure of failing.failures) propagation.push(`${failure.kind} : ${failure.summary}`);
  // Ce qui n'apparaît que dans les parcours défaillants, par rapport à la référence.
  const referenceKeys = new Set((reference?.events ?? []).map(eventKey));
  const onlyMap = new Map<string, Set<string>>();
  for (const trial of allFailing)
    for (const event of trial.events) {
      if (
        event.kind === 'ACTION' ||
        event.kind === 'SNAPSHOT' ||
        event.kind === 'SCREENSHOT' ||
        event.kind === 'NOTE'
      )
        continue;
      const key = eventKey(event);
      if (referenceKeys.has(key)) continue;
      const set = onlyMap.get(key) ?? new Set<string>();
      set.add(trial.id);
      onlyMap.set(key, set);
    }
  const onlyInFailing = [...onlyMap.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 12)
    .map(([summary, ids]) => ({ summary, trialIds: [...ids] }));
  return {
    ...(lastActionEvent?.action !== undefined
      ? {
          lastFunctionalAction: {
            trialId: failing.id,
            action: lastActionEvent.action,
            summary: lastActionEvent.summary,
          },
        }
      : {}),
    ...(lastRequest ? { lastSuccessfulRequest: eventRef(failing, lastRequest) } : {}),
    ...(lastNavigation ? { lastNavigation: eventRef(failing, lastNavigation) } : {}),
    ...(lastState ? { lastStateChange: eventRef(failing, lastState) } : {}),
    ...(firstErrorEvent
      ? {
          firstError: {
            ...eventRef(failing, firstErrorEvent),
            t: firstErrorEvent.t,
            ...(typeof firstErrorEvent.data?.stack === 'string' ? { stack: firstErrorEvent.data.stack } : {}),
          },
        }
      : {}),
    ...(firstFailedIndex !== undefined
      ? {
          firstFailedAction: {
            trialId: failing.id,
            action: firstFailedIndex,
            summary: actionAt(failing, firstFailedIndex),
          },
        }
      : {}),
    propagation,
    onlyInFailing,
    note: firstErrorEvent
      ? 'Chronologie observée dans le navigateur ; la pile est celle du code livré, à rapprocher des sources.'
      : 'Aucune erreur de page capturée : la défaillance est silencieuse, seules les réactions manquantes la montrent.',
  };
}

const actionAt = (trial: TriggerTrial, index: number | undefined): string =>
  index === undefined ? 'hors action' : describeAction(trial.actions[index] ?? { kind: 'WAIT' });

const eventKey = (event: RuntimeEvent): string =>
  `${event.kind} ${event.summary.replace(/\d+/g, '#').slice(0, 120)}`;

// ── Perte de données ──────────────────────────────────────────────────────────────────────────

const PERSISTENCE =
  /localStorage|sessionStorage|IndexedDB|indexedDB|autosave|autoSave|brouillon|draft|CanDeactivate|canDeactivate|beforeunload|hasUnsavedChanges|dirty/;

export function analyzeDataLoss(
  brief: IncidentBrief | undefined,
  failing: TriggerTrial | undefined,
  angular: AngularModel | undefined,
  minimal: MinimalReproduction | undefined,
): DataLossAnalysis | undefined {
  if (!brief?.dataLoss && !failing) return undefined;
  const unsavedFields = new Set<string>();
  for (const action of failing?.actions ?? [])
    if (
      (action.kind === 'FILL' ||
        action.kind === 'SELECT' ||
        action.kind === 'CHECK' ||
        action.kind === 'CLEAR') &&
      action.target
    )
      unsavedFields.add(action.target.replace(/^[a-z]+:/, ''));
  const persistenceFound: DataLossAnalysis['persistenceFound'] = [];
  for (const node of angular?.nodes ?? []) {
    const detail = JSON.stringify(node.detail ?? {});
    if (node.kind === 'GUARD' && /deactivate/i.test(`${node.name} ${detail}`))
      persistenceFound.push({
        summary: `garde de sortie ${node.name}`,
        file: node.file,
        line: node.line,
        source: 'STATICALLY_RESOLVED',
      });
    else if (PERSISTENCE.test(`${node.name} ${detail}`))
      persistenceFound.push({
        summary: `${node.kind} ${node.name} : ${detail.match(PERSISTENCE)?.[0] ?? ''}`,
        file: node.file,
        line: node.line,
        source: 'STATICALLY_RESOLVED',
      });
  }
  const lossFactors: string[] = [];
  if (failing) {
    const noRequests = failing.probes.every(
      (index) => !failing.events.some((event) => event.kind === 'REQUEST' && event.action === index),
    );
    if (noRequests)
      lossFactors.push(
        "aucune requête d'enregistrement émise après le blocage : la saisie reste uniquement dans la page",
      );
  }
  if (persistenceFound.length === 0 && angular)
    lossFactors.push(
      'aucune sauvegarde locale, brouillon ni garde de navigation trouvés dans le code analysé',
    );
  lossFactors.push(
    'le rechargement (F5) réinitialise l’état de la page : ce qui n’a pas été envoyé est perdu',
  );
  return {
    unsavedFields: [...unsavedFields].slice(0, 20),
    persistenceFound: persistenceFound.slice(0, 10),
    ...(minimal
      ? {
          triggerSummary: `déclencheur observé : ${minimal.actions
            .filter(isFactorAction)
            .map(describeAction)
            .join(', ')}`,
        }
      : {}),
    lossFactors,
    note: 'Le déclencheur du blocage et les facteurs de la perte sont distincts ; aucune récupération automatique n’est promise.',
  };
}

// ── Hypothèses de cause Angular ───────────────────────────────────────────────────────────────

export interface RootCauseInput {
  runId: string;
  failing: TriggerTrial;
  reference?: TriggerTrial;
  minimal?: MinimalReproduction;
  angular?: AngularModel;
  conditions: readonly TriggerCondition[];
  existing: readonly Hypothesis[];
  now: string;
}

export interface RootCauseOutput {
  hypotheses: Hypothesis[];
  experiments: Experiment[];
}

const FRONTEND: Layer = 'FRONTEND';

/** Les hypothèses que les observations autorisent, chacune avec les vérifications qui pourraient la réfuter. */
export function proposeRootCauses(input: RootCauseInput): RootCauseOutput {
  const { failing, angular, minimal } = input;
  const hypotheses: Hypothesis[] = [];
  const experiments: Experiment[] = [];
  const existingTitles = new Set(input.existing.map((hypothesis) => hypothesis.title));
  const firstError = failing.events.find((event) => event.kind === 'PAGE_ERROR');
  const kinds = new Set<SilentFailureKind>(failing.failures.map((failure) => failure.kind));
  const refs = {
    trial: `trigger:trial:${failing.id}`,
    error: firstError ? `trigger:event:${failing.id}:${firstError.id}` : undefined,
    reference: input.reference ? `trigger:trial:${input.reference.id}` : undefined,
  };
  const triggerActions = (minimal?.actions ?? failing.actions).filter(isFactorAction);
  const triggerText = triggerActions.map(describeAction).join(', ') || 'la séquence reproduite';
  const handlers = handlersOf(angular, failing);
  const files = [...new Set(handlers.map((node) => node.file))].slice(0, 6);
  let sequence = 0;
  let considered = 0;
  const add = (
    title: string,
    description: string,
    suspectedCause: string,
    supporting: Hypothesis['supporting'],
    verifications: ProposedVerification[],
    confidence: number,
  ) => {
    considered += 1;
    if (existingTitles.has(title)) return;
    sequence += 1;
    const id = `hyp_trig_${input.runId}_${String(sequence)}`;
    hypotheses.push({
      id,
      title,
      description,
      suspectedCause,
      layer: FRONTEND,
      files,
      supporting,
      contradicting: [],
      confidence,
      verifications,
      status: 'PROPOSED',
      origin: 'RULE',
    });
    for (const verification of verifications) {
      const sideEffects = verification.kind === 'REPLAY' || verification.kind === 'COMPARE_WITH_PASSING';
      experiments.push({
        id: `exp_trig_${input.runId}_${String(sequence)}_${String(experiments.length + 1)}`,
        kind: verification.kind,
        hypothesisId: id,
        description: verification.description,
        params: verification.params,
        status: sideEffects ? 'APPROVAL_REQUIRED' : 'PROPOSED',
        sideEffects,
        decisions: [],
        evidence: [],
      });
    }
  };
  const replay: ProposedVerification = {
    kind: 'REPLAY',
    description: `Rejouer la séquence minimale (${triggerText}) sur un environnement de test et vérifier que les boutons ne réagissent plus`,
    params: { trialId: failing.id, sequence: triggerActions.map(describeAction) },
  };
  const differential: ProposedVerification = {
    kind: 'COMPARE_WITH_PASSING',
    description:
      'Comparer avec le parcours de référence (mêmes sondes, sans le déclencheur) : les réactions doivent revenir',
    params: {
      failingTrialId: failing.id,
      ...(input.reference ? { referenceTrialId: input.reference.id } : {}),
    },
  };
  const commonSupport: Hypothesis['supporting'] = [
    { ref: refs.trial, fact: `essai ${failing.id} : ${failing.reason ?? 'défaut reproduit'}` },
    ...(refs.reference
      ? [{ ref: refs.reference, fact: 'le parcours de référence réagit normalement aux mêmes sondes' }]
      : []),
  ];

  if (firstError) {
    const handlerNames = handlers
      .map((node) => node.name)
      .slice(0, 3)
      .join(', ');
    const sharedState = sharedStateOf(angular, handlers);
    add(
      "Exception dans un gestionnaire d'événement laissant un état partagé incohérent",
      `Une erreur de page (« ${firstError.summary.slice(0, 140)} ») survient pendant « ${actionAt(failing, firstError.action)} » après ${triggerText} ; les actions suivantes ne produisent plus de réaction.${handlerNames ? ` Gestionnaires statiquement liés : ${handlerNames}.` : ''}`,
      sharedState
        ? `Le gestionnaire lève avant de rétablir un état partagé (${sharedState}) : les actions suivantes s'arrêtent sur cet état.`
        : "Le gestionnaire lève avant d'achever son travail ; ce qu'il devait rétablir reste dans l'état intermédiaire.",
      [
        ...commonSupport,
        ...(refs.error
          ? [{ ref: refs.error, fact: `première erreur de page : ${firstError.summary.slice(0, 160)}` }]
          : []),
        ...handlers.slice(0, 3).map((node) => ({
          ref: `angular:${node.id}`,
          fact: `gestionnaire ${node.name} (${node.file}:${String(node.line)})`,
        })),
      ],
      [
        replay,
        differential,
        {
          kind: 'UNIT_TEST',
          description: `Test unitaire du gestionnaire${handlerNames ? ` (${handlerNames})` : ''} avec les données de la séquence : il doit rétablir son état même en cas d'erreur`,
          params: { handlers: handlers.map((node) => node.name).slice(0, 5) },
        },
      ],
      0.55,
    );
  }
  if (kinds.has('GLOBAL_ACTION_FAILURE') || kinds.has('NO_FUNCTIONAL_REACTION_AFTER_ACTION')) {
    const guards = ['[disabled]', 'busy', 'loading', 'pending', 'locked', 'saving', 'inProgress'];
    const guardHits = (angular?.nodes ?? []).filter((node) =>
      guards.some((guard) => JSON.stringify(node.detail ?? {}).includes(guard)),
    );
    add(
      'Indicateur d’occupation resté actif (désactivation conditionnelle)',
      `Après ${triggerText}, ${String(new Set(failing.failures.filter((failure) => failure.action !== undefined).map((failure) => failure.action)).size)} sonde(s) ne déclenchent plus ni validation, ni chargement, ni requête, alors que la page reste affichée.${guardHits.length > 0 ? ` Le code lie ${String(guardHits.length)} élément(s) à un indicateur d'occupation.` : ''}`,
      "Un indicateur d'occupation n'est jamais remis à faux après la séquence ; chaque gestionnaire sort immédiatement.",
      [
        ...commonSupport,
        ...guardHits.slice(0, 3).map((node) => ({
          ref: `angular:${node.id}`,
          fact: `${node.kind} ${node.name} dépend d'un indicateur d'occupation (${node.file}:${String(node.line)})`,
        })),
      ],
      [
        replay,
        differential,
        {
          kind: 'CHECK_VALIDATION',
          description:
            "Après la séquence, saisir une valeur invalide : l'absence de message de validation confirme que les gestionnaires ne s'exécutent plus",
          params: { trialId: failing.id },
        },
      ],
      firstError ? 0.4 : 0.5,
    );
  }
  if (kinds.has('POSSIBLE_EVENT_INTERCEPTION')) {
    add(
      'Superposition ou dialogue résiduel interceptant les événements',
      `Une superposition reste présente après la séquence (${triggerText}) ; les clics n'atteignent plus les boutons.`,
      "Le dialogue ou son arrière-plan n'est pas retiré du DOM après la fermeture.",
      commonSupport,
      [
        replay,
        {
          kind: 'INSPECT_LOGS',
          description:
            "Inspecter l'état du DOM après la séquence : superposition présente, pointer-events, aria-modal",
          params: { trialId: failing.id },
        },
      ],
      0.4,
    );
  }
  if (kinds.has('POSSIBLE_CHANGE_DETECTION_FAILURE') && !firstError) {
    add(
      'Vue non rafraîchie après la séquence (détection de changements)',
      `Sans erreur de page, les sondes ne modifient plus l'affichage après ${triggerText}${angular?.features.zoneless ? ' ; l’application est déclarée sans Zone.js' : ''}${angular?.features.onPush ? ' ; des composants utilisent OnPush' : ''}.`,
      "Le modèle change peut-être, mais la vue n'est pas marquée pour vérification.",
      commonSupport,
      [replay, differential],
      0.3,
    );
  }
  if (considered === 0)
    add(
      'Perte de réaction après la séquence déclenchante (cause à préciser)',
      `La séquence ${triggerText} reproduit la perte de réaction ; aucune catégorie de cause ne ressort encore des observations.`,
      'Non déterminée : les vérifications proposées distinguent indicateur bloqué, exception et interception.',
      commonSupport,
      [replay, differential],
      0.3,
    );
  return { hypotheses, experiments };
}

/** Les gestionnaires Angular statiquement liés aux sondes de l'essai (par le texte du bouton). */
function handlersOf(angular: AngularModel | undefined, trial: TriggerTrial): AngularNode[] {
  if (!angular) return [];
  const probeNames = trial.probes
    .map((index) => trial.actions[index]?.target ?? '')
    .map((target) => target.replace(/^[a-z]+:/, '').toLowerCase())
    .filter(Boolean);
  const bindings = angular.nodes.filter(
    (node) =>
      node.kind === 'BINDING' &&
      probeNames.some((name) =>
        `${node.name} ${String(node.detail?.text ?? '')}`.toLowerCase().includes(name),
      ),
  );
  const handlerIds = new Set(
    angular.links
      .filter((link) => link.kind === 'HANDLES' && bindings.some((binding) => binding.id === link.from))
      .map((link) => link.to),
  );
  return angular.nodes.filter((node) => node.kind === 'HANDLER' && handlerIds.has(node.id));
}

/** Un service partagé (singleton) dont dépendent plusieurs gestionnaires, s'il existe. */
function sharedStateOf(
  angular: AngularModel | undefined,
  handlers: readonly AngularNode[],
): string | undefined {
  if (!angular || handlers.length === 0) return undefined;
  const called = angular.links.filter(
    (link) => link.kind === 'CALLS' && handlers.some((handler) => handler.id === link.from),
  );
  const services = angular.nodes.filter(
    (node) => node.kind === 'SERVICE' && called.some((link) => link.to === node.id),
  );
  return services.length > 0
    ? services
        .map((node) => node.name)
        .slice(0, 2)
        .join(', ')
    : undefined;
}
