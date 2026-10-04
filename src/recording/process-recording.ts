import { detectDuplicateTargetActions } from './duplicate-target.js';
import { validateRecordingConsistency, type RecordingConsistencyReport } from './recording-consistency.js';
import type { ScenarioConfig } from '../config/config.js';
import { ActionDiscovery } from '../discovery/action-discovery.js';
import { FlowGraph } from '../graph/flow-graph.js';
import type { FlowGraphData } from '../model/flow.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { SafetyPolicy } from '../policies/safety-policy.js';
import type {
  RecordedFlow,
  RecordingEvent,
  RecordingEventType,
  RecordingSession,
  RecordingWarning,
  SemanticRecordedAction,
} from './model.js';
import { correlateActions, type CorrelationResult } from './action-correlation.js';
import { normalizeRecording, type NormalizedRecording } from './normalizer.js';
import { fieldIdentityKey, fieldIdentityOfEvent, type FieldIdentity } from './field-identity.js';
import { validateFieldMerges } from './field-merge-validator.js';
import {
  applyTargetValidations,
  groupSemanticActions,
  targetValidationReport,
  type TargetValidationReport,
} from './target-validation-state.js';
import { checkSemanticPreservation, type PreservationReport } from './semantic-preservation.js';
import { extractRecordedTestData, type RecordedTestDataResult } from './recorded-test-data.js';
import { inferOutcomes } from './outcomes.js';
import { buildRecordedFlow, generateFlowFiles, type GeneratedFiles } from './recorded-flow.js';
import { resolveSemanticActions, routeOf } from './semantic-recording.js';
import { optimizeRecordedActions } from './flow-optimizer.js';
import {
  accountHumanJourney,
  clicksWithEffects,
  attributeEffects,
  dependencyGraph,
  type HumanJourneyResult,
} from './human-journey.js';

/** Le jeu de données d'un enregistrement, à côté de generated.flow.yaml et generated.feature. */
export const TEST_DATA_FILE = 'test-data.yaml';

export interface RecordingResult {
  /** ACTION CORRELATION (absente si désactivée) et contrôle de préservation. */
  correlation?: CorrelationResult;
  preservation: PreservationReport;
  /** HUMAN JOURNEY : chaque interaction humaine, son statut, les dépendances, les phases. */
  journey: HumanJourneyResult;
  /** RECORDING CONSISTENCY : la cause de chaque effet attendu, la contamination, la chronologie. */
  consistency: RecordingConsistencyReport;
  /** AUTO-VALIDATION DES CIBLES : chaque action, sa validation immédiate, la confiance de rejeu. */
  targetValidation: TargetValidationReport;
  fidelity: 'EXACT' | 'SEMANTIC' | 'OPTIMIZED';
  /** FLOW OPTIMIZER (facultatif) : un flow raccourci séparé (optimized.flow.yaml). */
  optimized?: {
    flow: RecordedFlow;
    files: GeneratedFiles;
    removed: { actionId: string; label: string; reason: string }[];
  };
  /** RECORDED TEST DATA (absent si recording.testData.enabled vaut false) : le jeu de données du flow. */
  testData?: RecordedTestDataResult;
  session: RecordingSession;
  normalized: NormalizedRecording;
  flow: RecordedFlow;
  files: GeneratedFiles;
  graph: FlowGraphData;
  warnings: RecordingWarning[];
}

/**
 * RAW → SEMANTIC → NORMALIZED → OUTCOMES → RECORDED FLOW → flow.yaml + .feature.
 * Une fonction pure sur la session terminée : rejouable sur une trace enregistrée.
 */
export function processRecording(
  session: RecordingSession,
  config: ScenarioConfig,
  options: {
    language: 'fr' | 'en';
    snapshot?: (observationId: string) => UiSnapshot | undefined;
    onEvent?: (event: RecordingEvent) => void;
    /** Les textes saisis (champs non sensibles), par événement brut : jamais dans la trace. */
    typedValues?: ReadonlyMap<string, string>;
  },
): RecordingResult {
  const emit = (type: RecordingEventType, message: string): void => {
    options.onEvent?.({ type, at: new Date().toISOString(), message });
  };
  const safety = new SafetyPolicy(config.safety);
  // RAW → ACTION CORRELATION : chaque navigation rattachée à l'action humaine qui l'a causée (un effet, pas un goto).
  const settings = config.recording.actionCorrelation;
  let correlation: CorrelationResult | undefined;
  if (settings.enabled) {
    emit('ACTION_CORRELATION_STARTED', `${String(session.rawEvents.length)} raw event(s)`);
    correlation = correlateActions(session.rawEvents, settings);
    for (const decision of correlation.navigations) {
      if (decision.kind === 'EFFECT') {
        emit(
          'NAVIGATION_CORRELATED_TO_ACTION',
          `${decision.route} ← ${decision.causedBy ?? ''} (${decision.confidence ?? ''}: ${decision.reasons.join('; ')})`,
        );
        if (decision.ambiguous)
          emit('CAUSALITY_AMBIGUOUS', `${decision.route}: another recent action was almost as likely`);
      } else if (decision.kind === 'GOTO') {
        emit('NAVIGATION_UNCORRELATED', `${decision.route}: ${decision.reasons.join('; ')}`);
        if (decision.gotoReason !== 'INITIAL_NAVIGATION')
          emit('GOTO_FALLBACK_GENERATED', `goto ${decision.route} (${decision.gotoReason ?? ''})`);
      }
    }
    for (const group of correlation.groups)
      emit(
        'ACTION_EFFECT_CORRELATED',
        `${group.triggerId} → ${(group.effects.navigation?.routes ?? []).join(' → ')}${group.effects.network.length > 0 ? ` (${group.effects.network.map((exchange) => `${exchange.method} ${exchange.path}`).join(', ')})` : ''}`,
      );
  }
  // HUMAN JOURNEY : un clic que la capture n'a pas reconnu comme un contrôle, mais qui a changé l'écran
  // ou dont l'action suivante dépend, est une action humaine (UNRESOLVED), jamais du bruit.
  const recording = config.recording;
  const fidelity = recording.fidelity;
  const promoted =
    recording.preserveUnknownInteractiveActions && !recording.normalization.removeUnresolvedClicks
      ? clicksWithEffects(session.rawEvents, session.states)
      : new Map<string, string>();
  const semantic = resolveSemanticActions(
    session.rawEvents,
    safety,
    session.initialStateId,
    correlation,
    promoted,
  );
  session.semanticActions = semantic.actions;
  // Effets sur l'écran et dépendances entre actions : ce qui ne doit jamais être fusionné ni retiré.
  attributeEffects(semantic.actions, session.states);
  const dependencies = dependencyGraph(semantic.actions, session.states);
  const labelOfAction = new Map(
    semantic.actions.map((action) => [action.id, action.target?.label ?? action.type]),
  );
  for (const dependency of dependencies)
    emit(
      'HUMAN_ACTION_DEPENDENCY_DISCOVERED',
      `"${labelOfAction.get(dependency.from) ?? ''}" → "${labelOfAction.get(dependency.to) ?? ''}" (${dependency.evidence}: ${dependency.reason})`,
    );
  // Un vrai bouton cliqué sans effet observé (écran, navigation, requête, action suivante) : gardé,
  // mais son rôle dans le parcours n'est pas compris (UNRESOLVED) — jamais une raison de le retirer.
  const sources = new Set(dependencies.map((dependency) => dependency.from));
  for (const action of semantic.actions)
    if (
      action.type === 'CLICK' &&
      action.semanticStatus === undefined &&
      action.stateAfter !== undefined &&
      (action.domEffects ?? []).length === 0 &&
      !action.navigation &&
      action.network.length === 0 &&
      !sources.has(action.id) &&
      action.checkpoint === undefined
    ) {
      action.semanticStatus = 'UNRESOLVED';
      action.evidence.push('no effect observed (screen, navigation, request, next action): kept as taught');
    }
  const preserve = new Set<string>();
  if (recording.preserveHumanJourney) {
    if (recording.preserveDependencyActions)
      for (const dependency of dependencies) preserve.add(dependency.from);
    if (recording.preserveDomChangingActions)
      for (const action of semantic.actions)
        if ((action.domEffects ?? []).some((effect) => effect !== 'VALIDATION_CHANGED'))
          preserve.add(action.id);
  }
  for (const action of semantic.actions)
    emit(
      'SEMANTIC_ACTION_RESOLVED',
      `${action.type} ${action.target?.label ?? action.route ?? ''} (${action.target?.quality ?? '-'})`,
    );
  const normalized = normalizeRecording(
    semantic.actions,
    session.rawEvents,
    session.states,
    semantic.noise - (correlation?.promoted.size ?? 0) - promoted.size,
    config.recording.credentials,
    correlation !== undefined,
    {
      mergeTyping: recording.normalization.mergeTyping,
      // EXACT : chaque valeur saisie reste une étape.
      collapseCorrections: fidelity !== 'EXACT' && recording.normalization.collapseCorrections,
      preserve,
    },
  );
  session.semanticActions = normalized.actions;
  emitFieldIdentity(session.rawEvents, normalized, emit);
  emit(
    'RECORDING_NORMALIZED',
    `${String(normalized.kept.length)} action(s) kept of ${String(normalized.actions.length)}: ${String(normalized.stats.mergedInputs)} input(s) merged, ${String(normalized.stats.collapsedCorrections)} correction(s), ${String(normalized.stats.removedDetours)} detour(s), ${String(normalized.stats.removedNoise)} noise event(s)`,
  );
  // TARGET SELF-VALIDATION : la représentation validée (ou réparée puis revalidée) pendant
  // l'enregistrement remplace la représentation brute ; le groupe sémantique donne le contexte.
  applyTargetValidations(normalized.kept, session.rawEvents);
  groupSemanticActions(normalized.kept);
  // CAUSE → EFFET : chaque attente relue (effets futurs écartés, propriété disputée, route d'une autre action).
  const consistency = validateRecordingConsistency(normalized.kept, session.states, session.rawEvents);
  for (const action of consistency.actions) {
    for (const effect of action.required)
      emit('EFFECT_ASSIGNED_TO_ACTION', `${action.actionId} ${action.action}: ${effect}`);
    for (const effect of action.optional)
      emit('EFFECT_MARKED_OPTIONAL', `${action.actionId} ${action.action}: ${effect}`);
    for (const issue of action.issues)
      if (issue.resolved)
        emit(
          issue.probableOwner ? 'EFFECT_REASSIGNED' : 'EFFECT_REJECTED_FROM_ACTION',
          `${action.actionId} ${action.action}: ${issue.effect}${issue.probableOwner ? ` → ${issue.probableOwner}` : ''} (${issue.detail})`,
        );
      else
        emit(
          'RECORDING_EFFECT_CONTAMINATION_DETECTED',
          `${action.actionId} ${action.action}: ${issue.type} ${issue.effect}${issue.probableOwner ? ` (probable owner ${issue.probableOwner})` : ''}`,
        );
  }
  emit(
    'RECORDING_CONSISTENCY_VALIDATED',
    `${consistency.status}: ${String(consistency.actions.filter((action) => action.status !== 'CLEAN').length)} suspect action(s) of ${String(consistency.actions.length)}`,
  );
  const outcomes = inferOutcomes(normalized.kept, session.states, normalized.negative);
  emit(
    'OUTCOME_INFERRED',
    `${outcomes.intent.workflow ?? 'no business write'}; ${String(outcomes.assertions.filter((candidate) => candidate.selected).length)} assertion(s) selected of ${String(outcomes.assertions.length)}`,
  );
  for (const checkpoint of session.checkpoints) {
    const action = checkpointAction(normalized.kept, checkpoint.label);
    if (!action) continue;
    checkpoint.afterActionId = action.id;
    checkpoint.assertions = outcomes.assertions
      .filter(
        (candidate) => candidate.afterActionId === action.id && candidate.provenance === 'MANUAL_CHECKPOINT',
      )
      .map((candidate) => candidate.id);
  }
  // RECORDED TEST DATA : les valeurs saisies deviennent un jeu de données ; le flow cite ses clés.
  let testData: RecordedTestDataResult | undefined;
  if (config.recording.testData.enabled) {
    testData = extractRecordedTestData({
      name: session.name,
      recordingSessionId: session.id,
      createdAt: session.startedAt,
      actions: normalized.actions,
      kept: normalized.kept,
      rawEvents: session.rawEvents,
      typedValues: options.typedValues ?? new Map(),
      settings: config.recording.testData,
    });
    for (const event of testData.events) emit(event.type, event.message);
    // Une valeur calculée (champ en lecture seule) n'est pas une saisie : écartée du flow.
    normalized.kept = normalized.kept.filter((action) => !action.dropped);
  }
  const startRoute =
    normalized.kept.find((action) => action.type === 'NAVIGATE')?.route ?? routeOf(session.startUrl);
  const built = buildRecordedFlow({
    name: session.name,
    recordingSessionId: session.id,
    startRoute,
    kept: normalized.kept,
    assertions: outcomes.assertions,
    intent: outcomes.intent,
    negative: normalized.negative,
    stats: normalized.stats,
  });
  const preservation = checkSemanticPreservation(normalized.actions, built.flow, config.recording.validation);
  emit(
    'FLOW_SEMANTIC_PRESERVATION_CHECK',
    `${String(preservation.humanTriggers)} human click(s), ${String(preservation.generatedClicks)} click step(s), ${String(preservation.generatedGotos)} goto, ${String(preservation.lostMutations.length)} data-changing action(s) lost`,
  );
  for (const warning of preservation.warnings)
    if (warning.code === 'SUSPICIOUS_NAVIGATION_COLLAPSE')
      emit('SUSPICIOUS_NAVIGATION_COLLAPSE', warning.message);
  // HUMAN JOURNEY VALIDATOR : chaque interaction humaine a un statut ; aucune n'est perdue sans raison.
  emit('HUMAN_JOURNEY_VALIDATION_STARTED', `${String(session.rawEvents.length)} raw event(s)`);
  const journey = accountHumanJourney({
    events: session.rawEvents,
    actions: normalized.actions,
    kept: normalized.kept,
    flow: built.flow,
    states: session.states,
    dependencies,
  });
  annotateSteps(built.flow, journey, normalized.kept);
  // FINAL RECORDING AUDIT : à partir des validations immédiates (un écran passé n'est jamais « NOT_FOUND »).
  const targetValidation = targetValidationReport(normalized.kept, journey, {
    enabled: config.recording.targetValidation.enabled,
  });
  emit(
    'TARGET_VALIDATION',
    `${String(targetValidation.summary.validated)}/${String(targetValidation.summary.humanActions)} target(s) validated (${String(targetValidation.summary.validatedAfterRepair)} after repair), ${String(targetValidation.summary.fragile)} fragile, ${String(targetValidation.summary.unresolved)} unresolved; replay confidence ${targetValidation.replayConfidence}`,
  );
  for (const interaction of journey.interactions)
    emit('HUMAN_INTERACTION_CAPTURED', `${interaction.id} ${interaction.type} "${interaction.target ?? ''}"`);
  for (const account of journey.accounts) {
    const line = `${account.interactionId} ${account.type} "${account.target ?? ''}"`;
    if (account.status === 'PRESERVED')
      emit('HUMAN_INTERACTION_PRESERVED', `${line} → step ${String(account.flowStep ?? '')}`);
    else if (account.status === 'UNRESOLVED_BUT_PRESERVED')
      emit(
        'HUMAN_INTERACTION_UNRESOLVED',
        `${line} → step ${String(account.flowStep ?? '')} (${account.reason ?? ''})`,
      );
    else if (
      account.status === 'MERGED' ||
      account.status === 'COLLAPSED_CORRECTION' ||
      account.status === 'DUPLICATE'
    )
      emit('HUMAN_INTERACTION_MERGED', `${line} → ${account.mergedInto ?? ''} (${account.rule ?? ''})`);
    else if (account.status === 'UNACCOUNTED')
      emit('HUMAN_ACTION_LOST', `${line}: ${account.reason ?? 'no reason'}`);
    else
      emit(
        'HUMAN_INTERACTION_EXCLUDED',
        `${line}: ${account.status} ${account.rule ?? ''} (${account.reason ?? ''})`,
      );
  }
  const summary = journey.summary;
  emit(
    'HUMAN_JOURNEY_BUILT',
    `${String(summary.meaningful)} interaction(s): ${String(summary.preserved)} preserved, ${String(summary.unresolvedPreserved)} unresolved but preserved, ${String(summary.merged)} merged, ${String(summary.excluded)} excluded, ${String(summary.noise)} noise, ${String(summary.unaccounted)} lost; ${String(journey.phases.length)} phase(s)`,
  );
  emit(
    summary.unaccounted === 0 && journey.ordered
      ? 'HUMAN_JOURNEY_VALIDATED'
      : 'HUMAN_JOURNEY_VALIDATION_FAILED',
    summary.unaccounted === 0 && journey.ordered
      ? 'every human interaction is accounted for, in the human order'
      : `${String(summary.unaccounted)} interaction(s) lost without a reason${journey.ordered ? '' : '; steps reordered'}`,
  );
  const files = generateFlowFiles(built.flow, {
    language: options.language,
    recordedAt: session.startedAt,
    ...(testData && Object.keys(testData.set.values).length > 0 ? { testDataFile: TEST_DATA_FILE } : {}),
  });
  emit('FLOW_GENERATED', `${String(built.flow.steps.length)} step(s)`);
  // FLOW OPTIMIZER (séparé, facultatif) : un AUTRE flow, jamais à la place du parcours humain.
  let optimized: RecordingResult['optimized'];
  if (recording.optimization.enabled || fidelity === 'OPTIMIZED') {
    emit('FLOW_OPTIMIZATION_STARTED', `${String(normalized.kept.length)} action(s)`);
    // Un détour change l'écran par nature : seule une action dont une suivante dépend est intouchable ici.
    const shorter = optimizeRecordedActions(normalized.kept, session.states, sources);
    const optimizedFlow = buildRecordedFlow({
      name: `${session.name} (optimized)`,
      recordingSessionId: session.id,
      startRoute,
      kept: shorter.kept,
      assertions: outcomes.assertions,
      intent: outcomes.intent,
      negative: normalized.negative,
      stats: normalized.stats,
    }).flow;
    optimized = {
      flow: optimizedFlow,
      removed: shorter.removed,
      files: generateFlowFiles(optimizedFlow, {
        language: options.language,
        recordedAt: session.startedAt,
        ...(testData && Object.keys(testData.set.values).length > 0 ? { testDataFile: TEST_DATA_FILE } : {}),
      }),
    };
    emit(
      'FLOW_OPTIMIZATION_COMPLETED',
      `${String(optimizedFlow.steps.length)} step(s) instead of ${String(built.flow.steps.length)}: ${shorter.removed.map((item) => `${item.label} (${item.reason})`).join('; ') || 'nothing to remove'}`,
    );
  }
  const warnings = [
    ...session.warnings,
    ...semantic.warnings,
    ...normalized.warnings,
    ...outcomes.warnings,
    ...built.warnings,
    ...preservation.warnings,
    ...(testData?.warnings ?? []),
    ...journey.warnings,
    // FIELD IDENTITY : une fusion de saisies de champs différents est signalée, jamais tue.
    ...validateFieldMerges(normalized.actions, session.rawEvents).map((issue) => ({
      code: issue.type,
      message: `${issue.rawEventIds.join(', ')}: ${issue.reasons.join('; ')}`,
      actionId: issue.actionId,
    })),
  ];
  return {
    session,
    normalized,
    flow: built.flow,
    files,
    ...(correlation ? { correlation } : {}),
    ...(testData ? { testData } : {}),
    journey,
    consistency,
    targetValidation,
    fidelity,
    ...(optimized ? { optimized } : {}),
    preservation,
    graph: flowGraphOf(session, normalized.kept, safety, config, options.snapshot),
    warnings: dedupe(warnings),
  };
}

/** Chaque étape porte les interactions humaines qu'elle représente (h001…) et son statut sémantique. */
function annotateSteps(
  flow: RecordedFlow,
  journey: HumanJourneyResult,
  kept: readonly SemanticRecordedAction[],
): void {
  const byId = new Map(kept.map((action) => [action.id, action]));
  // L'étape de chaque interaction : la sienne, ou celle de l'interaction qui la représente.
  const stepOf = new Map<string, number>();
  for (const account of journey.accounts)
    if (account.flowStep !== undefined) stepOf.set(account.interactionId, account.flowStep);
  const idsByStep = new Map<number, string[]>();
  for (const account of journey.accounts) {
    const step = account.flowStep ?? (account.mergedInto ? stepOf.get(account.mergedInto) : undefined);
    if (step === undefined) continue;
    const ids = idsByStep.get(step) ?? [];
    ids.push(account.interactionId);
    idsByStep.set(step, ids);
  }
  for (const [index, step] of flow.steps.entries()) {
    const ids = idsByStep.get(index + 1);
    if (ids && ids.length > 0) step.interactionIds = ids;
    if (step.step.kind === 'expect') continue;
    if (step.actionIds.some((id) => byId.get(id)?.semanticStatus === 'UNRESOLVED'))
      step.semanticStatus = 'UNRESOLVED';
  }
}

function checkpointAction(
  kept: readonly SemanticRecordedAction[],
  label: string,
): SemanticRecordedAction | undefined {
  return [...kept].reverse().find((action) => action.checkpoint === label);
}

/** La carte des flows (FlowGraph) : les écrans vus et les actions de l'humain entre eux. */
function flowGraphOf(
  session: RecordingSession,
  kept: readonly SemanticRecordedAction[],
  safety: SafetyPolicy,
  config: ScenarioConfig,
  snapshot?: (observationId: string) => UiSnapshot | undefined,
): FlowGraphData {
  const graph = new FlowGraph();
  const discovery = new ActionDiscovery(safety, config.exploration.maxRecordedActions);
  const screenOf = new Map(session.states.map((state) => [state.id, state.stateId]));
  for (const [depth, state] of session.states.entries()) {
    const shot = snapshot?.(state.id);
    graph.addNode({
      id: state.stateId,
      label: state.label,
      url: state.url,
      route: state.route,
      title: state.title,
      headings: state.headings,
      depth,
      actions: shot ? discovery.discover(shot, state.stateId) : [],
    });
  }
  for (const action of kept) {
    if (!action.stateBefore || !action.stateAfter || action.type === 'NAVIGATE') continue;
    graph.addEdge({
      from: screenOf.get(action.stateBefore) ?? action.stateBefore,
      to: screenOf.get(action.stateAfter) ?? action.stateAfter,
      actionId: `recorded:${action.id}`,
      action: {
        type:
          action.type === 'FILL'
            ? 'fill'
            : action.type === 'SELECT'
              ? 'select'
              : action.type === 'CHECK'
                ? 'check'
                : action.type === 'UNCHECK'
                  ? 'uncheck'
                  : 'click',
        category: 'other',
        label: action.target?.label ?? action.type,
        classification: action.classification ?? 'SAFE',
      },
      result: 'SUCCESS',
      flow: session.name,
      timestamp: new Date(action.at).toISOString(),
    });
  }
  return graph.toJSON();
}

function dedupe(warnings: RecordingWarning[]): RecordingWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}|${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** FIELD IDENTITY : chaque champ saisi, son identité ; chaque décision de fusion, ses raisons. */
function emitFieldIdentity(
  rawEvents: RecordingSession['rawEvents'],
  normalized: NormalizedRecording,
  emit: (type: RecordingEventType, message: string) => void,
): void {
  const seen = new Set<string>();
  for (const event of rawEvents) {
    if ((event.type !== 'input' && event.type !== 'change') || !event.element) continue;
    const identity = fieldIdentityOfEvent(event);
    if (!identity) continue;
    const key = fieldIdentityKey(identity) ?? `raw:${event.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      emit('FIELD_IDENTITY_CREATED', `${event.id}: ${describeFieldIdentity(identity)}`);
    }
    if (identity.locatorUniqueness === 'NON_UNIQUE') {
      emit(
        'NON_UNIQUE_FIELD_LOCATOR',
        `${event.id}: css "${identity.domPathFingerprint}" matches several elements: it cannot identify the field alone`,
      );
      if (!/^(#|\[|[a-z]+\[)/i.test(identity.domPathFingerprint))
        emit('GENERIC_LOCATOR_DETECTED', `${event.id}: structural css "${identity.domPathFingerprint}"`);
    }
  }
  // DISCRIMINATING SELECTORS : la cible venait-elle de l'inventaire de l'écran ? quel CSS a été retenu ?
  const described = new Set<string>();
  for (const event of rawEvents) {
    const selectors = event.element?.selectors;
    if (!selectors || !event.element) continue;
    const identity = fieldIdentityOfEvent(event);
    const key = (identity ? fieldIdentityKey(identity) : undefined) ?? event.element.css;
    if (described.has(key)) continue;
    described.add(key);
    emit(
      selectors.inventory === 'INVENTORY' ? 'TARGET_MATCHED_FROM_INVENTORY' : 'TARGET_INVENTORY_MISS',
      `${event.id}: ${selectors.inventory === 'INVENTORY' ? 'descriptor reused from the screen inventory' : 'analysed locally (not in the inventory yet)'}`,
    );
    if (selectors.preferred && !selectors.preferred.structural && !selectors.preferred.dynamic)
      emit(
        'CSS_CANDIDATE_SELECTED',
        `${event.id}: ${selectors.preferred.selector} (${selectors.preferred.kind}, ${String(selectors.preferred.matchCount)} match, confidence ${String(selectors.preferred.confidence)})${selectors.structural.matchCount > 1 ? ` — structural fallback ${selectors.structural.selector} matches ${String(selectors.structural.matchCount)}: not selected` : ''}`,
      );
    else
      emit(
        'LOCATOR_AMBIGUOUS',
        `${event.id}: no stable unique selector (${selectors.ambiguity.level}: ${selectors.ambiguity.reasons.join(', ') || '—'})`,
      );
  }
  for (const duplicate of detectDuplicateTargetActions(normalized.kept))
    emit(
      'DUPLICATE_TARGET_ACTION_DETECTED',
      `${duplicate.firstActionId} → ${duplicate.secondActionId} ${duplicate.type} "${duplicate.target}": ${duplicate.classification} — ${duplicate.reasons.join('; ')}`,
    );
  for (const decision of normalized.mergeDecisions) {
    const pair = `${decision.previousRawEventIds.join('+')} + ${decision.currentRawEventIds.join('+')}`;
    emit(
      'TYPING_MERGE_EVALUATED',
      `${decision.rule} ${pair}: ${decision.verdict} (${decision.confidence.toFixed(2)}) — ${decision.reasons.join('; ')}`,
    );
    emit(
      decision.verdict === 'DIFFERENT_FIELD'
        ? 'FIELD_IDENTITY_MISMATCH'
        : decision.verdict === 'AMBIGUOUS_FIELD'
          ? 'FIELD_IDENTITY_AMBIGUOUS'
          : 'FIELD_IDENTITY_MATCHED',
      `${pair}: ${decision.verdict}`,
    );
    emit(
      decision.decision === 'MERGE' ? 'TYPING_MERGE_ACCEPTED' : 'TYPING_MERGE_REJECTED',
      `${pair}: ${decision.decision}`,
    );
  }
}

/** « label "Employee number", e3, NUMERIC maxlength 5 » : de quoi relire une identité. */
export function describeFieldIdentity(identity: FieldIdentity): string {
  return [
    identity.formControlName ? `formControlName "${identity.formControlName}"` : '',
    identity.label ? `label "${identity.label}"` : '',
    identity.formField && identity.formField !== identity.label ? `field "${identity.formField}"` : '',
    identity.placeholder ? `placeholder "${identity.placeholder}"` : '',
    identity.sectionContext ? `section "${identity.sectionContext}"` : '',
    identity.dialogContext ? `dialog "${identity.dialogContext}"` : '',
    identity.domInstance ? `instance ${identity.domInstance}` : '',
    `${identity.valueProfile.type}${identity.valueProfile.maxLength !== undefined ? ` maxlength ${String(identity.valueProfile.maxLength)}` : ''}`,
    `locator ${identity.locatorUniqueness}`,
  ]
    .filter(Boolean)
    .join(', ');
}
