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
import { checkSemanticPreservation, type PreservationReport } from './semantic-preservation.js';
import { extractRecordedTestData, type RecordedTestDataResult } from './recorded-test-data.js';
import { inferOutcomes } from './outcomes.js';
import { buildRecordedFlow, generateFlowFiles, type GeneratedFiles } from './recorded-flow.js';
import { resolveSemanticActions, routeOf } from './semantic-recording.js';

/** Le jeu de données d'un enregistrement, à côté de generated.flow.yaml et generated.feature. */
export const TEST_DATA_FILE = 'test-data.yaml';

export interface RecordingResult {
  /** ACTION CORRELATION (absente si désactivée) et contrôle de préservation. */
  correlation?: CorrelationResult;
  preservation: PreservationReport;
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
  const semantic = resolveSemanticActions(session.rawEvents, safety, session.initialStateId, correlation);
  session.semanticActions = semantic.actions;
  for (const action of semantic.actions)
    emit(
      'SEMANTIC_ACTION_RESOLVED',
      `${action.type} ${action.target?.label ?? action.route ?? ''} (${action.target?.quality ?? '-'})`,
    );
  const normalized = normalizeRecording(
    semantic.actions,
    session.rawEvents,
    session.states,
    semantic.noise - (correlation?.promoted.size ?? 0),
    config.recording.credentials,
    correlation !== undefined,
  );
  session.semanticActions = normalized.actions;
  emit(
    'RECORDING_NORMALIZED',
    `${String(normalized.kept.length)} action(s) kept of ${String(normalized.actions.length)}: ${String(normalized.stats.mergedInputs)} input(s) merged, ${String(normalized.stats.collapsedCorrections)} correction(s), ${String(normalized.stats.removedDetours)} detour(s), ${String(normalized.stats.removedNoise)} noise event(s)`,
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
  const files = generateFlowFiles(built.flow, {
    language: options.language,
    recordedAt: session.startedAt,
    ...(testData && Object.keys(testData.set.values).length > 0 ? { testDataFile: TEST_DATA_FILE } : {}),
  });
  emit('FLOW_GENERATED', `${String(built.flow.steps.length)} step(s)`);
  const warnings = [
    ...session.warnings,
    ...semantic.warnings,
    ...normalized.warnings,
    ...outcomes.warnings,
    ...built.warnings,
    ...preservation.warnings,
    ...(testData?.warnings ?? []),
  ];
  return {
    session,
    normalized,
    flow: built.flow,
    files,
    ...(correlation ? { correlation } : {}),
    ...(testData ? { testData } : {}),
    preservation,
    graph: flowGraphOf(session, normalized.kept, safety, config, options.snapshot),
    warnings: dedupe(warnings),
  };
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
