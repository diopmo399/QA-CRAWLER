import { describe, expect, it } from 'vitest';
import { IntelligenceGateway } from '../../src/ai/gateway.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import type { TriggerSettings } from '../../src/ai/trigger-policy.js';
import { flowSchema, type FlowStep } from '../../src/config/flow-schema.js';
import { rawStepOf } from '../../src/dry-run/suggested-flow.js';
import { arbitrateIntents } from '../../src/intent/ai-arbiter.js';
import { collectIntentEvidence, historyKeyOf, intentKeyOf } from '../../src/intent/evidence.js';
import {
  annotationOf,
  entityToken,
  functionalName,
  generalize,
  genericOf,
  type FunctionalIntent,
} from '../../src/intent/model.js';
import { annotateFlowSteps, resolveRecordingIntents, summarize } from '../../src/intent/resolve-recording.js';
import { adoptCandidate, resolveFunctionalIntent } from '../../src/intent/resolver.js';
import { FunctionalKnowledgeStore } from '../../src/knowledge/functional-knowledge-store.js';
import { buildApplicationModel } from '../../src/recording/application/application-model.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedFlowStep,
  RecordedState,
  RecordingSession,
  SemanticRecordedAction,
} from '../../src/recording/model.js';
import { parseConfig } from '../../src/config/config-loader.js';
import { parse as parseYaml } from 'yaml';
import { processRecording } from '../../src/recording/process-recording.js';
import { resolveWorkflowContext } from '../../src/workflow-healing/workflow-context.js';
import { FakeIntelligenceProvider, proposeByName } from '../fixtures/fake-intelligence-provider.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * FUNCTIONAL INTENT : element + contexte + action humaine + état → intention fonctionnelle, à trois
 * niveaux, avec preuves, candidats et statut. Une application fictive et générique (items, a list, a
 * detail, a dialog) ; aucune règle ne connaît ses noms.
 */
const ORIGIN = 'http://app.test';

function state(id: string, route: string, extra: Partial<RecordedState> = {}): RecordedState {
  return {
    id,
    stateId: id,
    label: route,
    route,
    url: `${ORIGIN}${route}`,
    title: 'App',
    headings: [],
    alerts: [],
    invalidFields: 0,
    dialogs: [],
    controls: [],
    ...extra,
  };
}

let counter = 0;
function action(
  type: SemanticRecordedAction['type'],
  label: string,
  extra: Partial<SemanticRecordedAction> = {},
  fingerprint: Record<string, string> = {},
): SemanticRecordedAction {
  counter += 1;
  const role = fingerprint.role;
  return {
    id: `a${String(counter)}`,
    type,
    rawEventIds: [`r${String(counter)}`],
    at: counter * 1000,
    url: `${ORIGIN}/items`,
    target: {
      target: role ? { strategy: 'role', role, name: label } : { strategy: 'label', value: label },
      quality: 'SEMANTIC',
      label,
      alternatives: [],
      ambiguous: false,
      named: true,
      reasons: [],
      fingerprint: { name: label, ...fingerprint },
    },
    network: [],
    provenance: 'HUMAN_RECORDED',
    confidence: 1,
    evidence: [],
    ...extra,
  };
}

const LIST = state('o1', '/items', { tableRows: 20 });
const RESULTS = state('o2', '/items', { tableRows: 3 });
const DETAIL = state('o3', '/items/42');
const DIALOG = state('o4', '/items/42', { dialogs: ['Edit item'] });
const STATES = [LIST, RESULTS, DETAIL, DIALOG];

/** Le parcours de référence : recherche → ouverture → édition dans un dialogue → enregistrement → soumission. */
function journey(): SemanticRecordedAction[] {
  counter = 0;
  return [
    action(
      'FILL',
      'Name',
      { stateBefore: 'o1', stateAfter: 'o1' },
      { role: 'textbox', form: 'item-search', section: 'Search' },
    ),
    action(
      'CLICK',
      'Search',
      {
        stateBefore: 'o1',
        stateAfter: 'o2',
        classification: 'SAFE',
        network: [
          {
            method: 'GET',
            path: '/api/items?name=x',
            status: 200,
            records: [
              { index: 0, identifiers: [{ field: 'id', value: '41', digest: 'd41', source: 'response' }] },
              { index: 1, identifiers: [{ field: 'id', value: '42', digest: 'd42', source: 'response' }] },
              { index: 2, identifiers: [{ field: 'id', value: '43', digest: 'd43', source: 'response' }] },
            ],
          },
        ],
      },
      { role: 'button', form: 'item-search', section: 'Search' },
    ),
    action(
      'CLICK',
      'Item 42',
      {
        stateBefore: 'o2',
        stateAfter: 'o3',
        navigation: {
          routes: ['/items/42'],
          navigationIds: [],
          confidence: 'HIGH',
          score: 1,
          reasons: [],
          provenance: 'RUNTIME_OBSERVED',
        },
        network: [{ method: 'GET', path: '/api/items/42', status: 200 }],
      },
      { role: 'link', row: 'row 1' },
    ),
    action(
      'CLICK',
      'Edit',
      {
        stateBefore: 'o3',
        stateAfter: 'o4',
        expectedEffects: { appears: ['textbox:Name', 'textbox:Code', 'button:Save'] },
      },
      { role: 'button' },
    ),
    action('FILL', 'Code', { stateBefore: 'o4', stateAfter: 'o4' }, { role: 'textbox', dialog: 'Edit item' }),
    action(
      'CLICK',
      'Save',
      {
        stateBefore: 'o4',
        stateAfter: 'o3',
        classification: 'MUTATION',
        network: [{ method: 'PUT', path: '/api/items/42', status: 200 }],
      },
      { role: 'button', dialog: 'Edit item' },
    ),
    action(
      'CLICK',
      'Continue',
      {
        stateBefore: 'o3',
        stateAfter: 'o3',
        classification: 'MUTATION',
        network: [
          {
            method: 'POST',
            path: '/api/items/42/submit',
            status: 200,
            requestState: { field: 'status', code: 'DRAFT' },
            responseState: { field: 'status', code: 'SUBMITTED' },
          },
        ],
      },
      { role: 'button' },
    ),
    action('CLICK', 'Mystery', { stateBefore: 'o3', stateAfter: 'o3' }, { role: 'button' }),
  ];
}

const byAction = (intents: readonly FunctionalIntent[], id: string): FunctionalIntent => {
  const found = intents.find((intent) => intent.actionId === id);
  if (!found) throw new Error(`no intent for ${id}`);
  return found;
};

describe('the intent model', () => {
  it('names a functional intent operation × entity, generalizes it, and keeps the physical action apart', () => {
    expect(functionalName('SEARCH', 'items')).toBe('SEARCH_ITEM');
    expect(functionalName('SEARCH', 'work items')).toBe('SEARCH_WORK_ITEM');
    expect(functionalName('SEARCH')).toBe('SEARCH_ENTITY');
    expect(entityToken('Équipes')).toBe('EQUIPE');
    expect(generalize('SEARCH_ITEM')).toBe('SEARCH_ENTITY');
    expect(generalize('OPEN_DIALOG')).toBe('OPEN_DIALOG');
    expect(
      genericOf({ name: 'OPEN_ITEM', functional: { operation: 'OPEN', entity: 'item', name: 'OPEN_ITEM' } }),
    ).toBe('OPEN_ENTITY');
    expect(genericOf({ name: 'OPEN_DIALOG' })).toBe('OPEN_DIALOG');
    expect(intentKeyOf('SEARCH_ITEM')).toBe('op:SEARCH:item');
    expect(intentKeyOf('OPEN_DIALOG')).toBe('ui:OPEN_DIALOG');
    expect(intentKeyOf('SEARCH_ENTITY')).toBe('op:SEARCH');
  });
});

describe('the evidence engine (one action, every source typed)', () => {
  it('reads the element, its structural context, the neighbours, the effects and the network — never a typed value', () => {
    const actions = journey();
    const search = actions[1];
    if (!search) throw new Error('fixture');
    const collected = collectIntentEvidence({
      action: search,
      previous: actions.slice(0, 1),
      next: actions.slice(2, 6),
      stateBefore: LIST,
      stateAfter: RESULTS,
    });
    const types = collected.evidence.map((item) => item.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'LABEL',
        'FORM_CONTEXT',
        'SECTION',
        'FILLED_CRITERIA',
        'NEXT_ACTION',
        'EFFECT_ROWS',
        'NETWORK_LIST',
      ]),
    );
    expect(collected.entity).toBe('item');
    expect(collected.context).toMatchObject({
      route: '/items',
      form: 'item-search',
      section: 'Search',
      entity: 'item',
    });
    // Chaque preuve dit qui elle soutient et pèse selon son type (le runtime pèse plus qu'un libellé).
    const network = collected.evidence.find((item) => item.type === 'NETWORK_LIST');
    const label = collected.evidence.find((item) => item.type === 'LABEL');
    expect(network?.supports[0]).toBe('op:SEARCH:item');
    expect(label?.supports).toContain('ui:SEARCH');
    expect(label?.contradicts).toContain('ui:SAVE');
    expect((network?.weight ?? 0) > (label?.weight ?? 1)).toBe(true);
    expect(JSON.stringify(collected)).not.toContain('name=x');
  });

  it('a human decision remembered for the same screen and element is the strongest evidence', () => {
    const actions = journey();
    const mystery = actions[7];
    if (!mystery) throw new Error('fixture');
    const collected = collectIntentEvidence({
      action: mystery,
      previous: [],
      next: [],
      stateBefore: DETAIL,
      decisions: [
        {
          key: 'k',
          context: { page: '/items/42', label: 'Mystery' },
          intent: 'OPEN_MENU',
          status: 'HUMAN_CORRECTED',
          systemIntent: ['UNKNOWN'],
          source: 'HUMAN',
          scope: 'CONTEXTUAL',
          recordingSessionId: 'rec',
          confirmations: 1,
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const human = collected.evidence.find((item) => item.type === 'HUMAN_DECISION');
    expect(human).toMatchObject({ trust: 'HUMAN_RECORDING', supports: ['ui:OPEN_MENU'] });
    // La même décision sur un AUTRE écran ne compte pas : une preuve contextuelle, jamais une règle globale.
    const elsewhere = collectIntentEvidence({
      action: mystery,
      previous: [],
      next: [],
      stateBefore: LIST,
      decisions: [
        {
          key: 'k',
          context: { page: '/items/42', label: 'Mystery' },
          intent: 'OPEN_MENU',
          status: 'HUMAN_CORRECTED',
          systemIntent: ['UNKNOWN'],
          source: 'HUMAN',
          scope: 'CONTEXTUAL',
          recordingSessionId: 'rec',
          confirmations: 1,
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(elsewhere.evidence.some((item) => item.type === 'HUMAN_DECISION')).toBe(false);
  });

  it('the history key is the gesture, the label and the request shape — never a value, never a page', () => {
    const actions = journey();
    const search = actions[1];
    if (!search) throw new Error('fixture');
    expect(historyKeyOf(search)).toBe('CLICK|search|GET /api/items');
    const collected = collectIntentEvidence({
      action: search,
      previous: [],
      next: [],
      history: [
        { key: historyKeyOf(search), intent: 'SEARCH_ITEM', confirmations: 3 },
        { key: 'CLICK|other|', intent: 'OPEN_MENU', confirmations: 9 },
      ],
    });
    const history = collected.evidence.filter((item) => item.type === 'HISTORY');
    expect(history).toHaveLength(1);
    expect(history[0]?.supports).toEqual(['op:SEARCH:item']);
  });
});

describe('the functional intent resolver (candidates, scoring, contradictions, status)', () => {
  it('search → open → edit (dialog) → save → submit: three levels, confident, from several evidence sources', () => {
    const { intents, summary } = resolveRecordingIntents({ kept: journey(), states: STATES });
    expect(byAction(intents, 'a1')).toMatchObject({
      physical: 'FILL',
      ui: 'ENTER_VALUE',
      status: 'CONFIRMED',
    });
    const search = byAction(intents, 'a2');
    expect(search).toMatchObject({
      physical: 'CLICK',
      ui: 'SEARCH',
      functional: { operation: 'SEARCH', entity: 'item', name: 'SEARCH_ITEM' },
      status: 'CONFIRMED',
    });
    expect(search.expectedEffects.map((effect) => effect.kind)).toEqual(
      expect.arrayContaining(['RESULTS_UPDATED', 'ROWS_CHANGED', 'NETWORK_REQUEST']),
    );
    expect(search.alternatives[0]?.name).toBe('SEARCH_ITEM');
    expect(byAction(intents, 'a3')).toMatchObject({
      ui: 'OPEN_ITEM',
      functional: { operation: 'OPEN', entity: 'item' },
    });
    expect(byAction(intents, 'a4')).toMatchObject({ ui: 'OPEN_DIALOG' });
    expect(byAction(intents, 'a4').expectedEffects.map((effect) => effect.kind)).toContain('DIALOG_OPENED');
    expect(byAction(intents, 'a6').functional?.operation).toBe('UPDATE');
    expect(byAction(intents, 'a7')).toMatchObject({
      functional: { operation: 'SUBMIT', entity: 'item', name: 'SUBMIT_ITEM' },
    });
    expect(byAction(intents, 'a7').expectedEffects.map((effect) => effect.kind)).toContain(
      'ENTITY_STATE_CHANGED',
    );
    // Rien ne dit ce que fait « Mystery » : UNKNOWN, jamais une intention inventée.
    expect(byAction(intents, 'a8')).toMatchObject({
      name: 'CLICK',
      status: 'UNKNOWN',
      confidence: 0,
      alternatives: [],
    });
    expect(summary.byStatus.UNKNOWN).toBe(1);
    expect(summary.functional.map((entry) => [entry.name, entry.generic])).toEqual(
      expect.arrayContaining([
        ['SEARCH_ITEM', 'SEARCH_ENTITY'],
        ['OPEN_ITEM', 'OPEN_ENTITY'],
        ['SUBMIT_ITEM', 'SUBMIT_ENTITY'],
      ]),
    );
    expect(summary.unresolved.map((entry) => entry.actionId)).toEqual(['a8']);
  });

  it('the same evidence always gives the same intent (deterministic)', () => {
    const first = resolveRecordingIntents({ kept: journey(), states: STATES });
    const second = resolveRecordingIntents({ kept: journey(), states: STATES });
    expect(JSON.stringify(second.intents)).toBe(JSON.stringify(first.intents));
  });

  it('two rivals too close are AMBIGUOUS with ranked candidates — never the first past the post', () => {
    counter = 0;
    // Un bouton « Go » sans réseau, sans effet observé : l'étiquette ne dit rien, la suite pose un critère.
    const go = action(
      'CLICK',
      'Go',
      { stateBefore: 'o1', stateAfter: 'o1' },
      { role: 'button', form: 'item-search' },
    );
    const intent = resolveFunctionalIntent({
      action: go,
      previous: [
        action(
          'FILL',
          'Name',
          { stateBefore: 'o1', stateAfter: 'o1' },
          { role: 'textbox', form: 'item-search' },
        ),
      ],
      next: [],
      stateBefore: LIST,
      stateAfter: LIST,
    });
    expect(intent.status).toBe('AMBIGUOUS');
    expect(intent.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(intent.name).toMatch(/^AMBIGUOUS\(/);
    const [first, second] = intent.alternatives;
    expect((first?.confidence ?? 0) - (second?.confidence ?? 0)).toBeLessThan(0.12);
    expect(intent.explanation).toContain('ambiguous with');
  });

  it('a label that says one thing while the network and the effects say another is a contradiction, not a certainty', () => {
    counter = 0;
    const cancel = action(
      'CLICK',
      'Cancel',
      {
        stateBefore: 'o4',
        stateAfter: 'o3',
        classification: 'MUTATION',
        network: [{ method: 'POST', path: '/api/items', status: 201 }],
      },
      { role: 'button', dialog: 'Edit item' },
    );
    const intent = resolveFunctionalIntent({
      action: cancel,
      previous: [],
      next: [],
      stateBefore: DIALOG,
      stateAfter: DETAIL,
    });
    expect(intent.contradictions.length).toBeGreaterThan(0);
    expect(
      intent.contradictions[0]?.between.some((name) => name === 'CANCEL' || name === 'CLOSE_DIALOG'),
    ).toBe(true);
    expect(intent.contradictions[0]?.between).toContain('SUBMIT');
    expect(intent.status).not.toBe('CONFIRMED');
    // Les deux lectures restent visibles dans les candidats.
    expect(intent.alternatives.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(['CANCEL', 'CREATE_ITEM']),
    );
  });

  it('thresholds are configurable: a stricter confirmed level turns CONFIRMED into PROBABLE', () => {
    const relaxed = resolveRecordingIntents({ kept: journey(), states: STATES });
    const strict = resolveRecordingIntents({
      kept: journey(),
      states: STATES,
      thresholds: { confirmed: 0.99 },
    });
    expect(byAction(relaxed.intents, 'a2').status).toBe('CONFIRMED');
    expect(byAction(strict.intents, 'a2').status).toBe('PROBABLE');
    expect(byAction(strict.intents, 'a2').name).toBe('SEARCH_ITEM');
  });

  it('a checked box inside a row is SELECT_ITEM; a dialog that opens is OPEN_DIALOG even when the label is mute', () => {
    counter = 0;
    const tick = action(
      'CHECK',
      'Select row',
      { stateBefore: 'o1', stateAfter: 'o1' },
      { role: 'checkbox', row: 'row 2', expectedState: 'checked' },
    );
    const selected = resolveFunctionalIntent({
      action: tick,
      previous: [],
      next: [],
      stateBefore: LIST,
      stateAfter: LIST,
    });
    expect(selected).toMatchObject({ physical: 'CHECK', ui: 'SELECT_ITEM' });
    expect(selected.expectedEffects.map((effect) => effect.kind)).toContain('SELECTION_CHANGED');
    const plus = action('CLICK', '+', { stateBefore: 'o3', stateAfter: 'o4' }, { role: 'button' });
    const opened = resolveFunctionalIntent({
      action: plus,
      previous: [],
      next: [],
      stateBefore: DETAIL,
      stateAfter: DIALOG,
    });
    expect(opened).toMatchObject({ ui: 'OPEN_DIALOG' });
    expect(opened.status).not.toBe('UNKNOWN');
  });

  it('an external choice (human, AI) adopts a candidate without touching the evidence or the raw action', () => {
    counter = 0;
    const go = action(
      'CLICK',
      'Go',
      { stateBefore: 'o1', stateAfter: 'o1' },
      { role: 'button', form: 'item-search' },
    );
    const intent = resolveFunctionalIntent({
      action: go,
      previous: [action('FILL', 'Name', { stateBefore: 'o1' }, { role: 'textbox', form: 'item-search' })],
      next: [],
      stateBefore: LIST,
    });
    const chosen = intent.alternatives[1]?.name ?? '';
    const adopted = adoptCandidate(intent, chosen, 'HUMAN_DECISION', 'reviewed');
    expect(adopted.name).toBe(chosen);
    expect(adopted.status).toBe('CONFIRMED');
    expect(adopted.source).toBe('HUMAN_DECISION');
    expect(adopted.evidence).toEqual(intent.evidence);
    expect(adopted.actionId).toBe(intent.actionId);
    expect(adoptCandidate(intent, 'NOT_A_CANDIDATE', 'AI_ARBITER', 'x')).toBe(intent);
  });
});

describe('the intent next to the raw action (steps, YAML, consumers)', () => {
  it('annotates the flow steps, round-trips through the YAML schema, and never replaces the step', () => {
    const kept = journey();
    const { intents } = resolveRecordingIntents({ kept, states: STATES });
    const steps: RecordedFlowStep[] = [
      {
        id: 's1',
        step: {
          kind: 'click',
          target: { strategy: 'role', role: 'button', name: 'Search' },
          allow: [],
          optional: false,
        },
        label: 'click Search',
        actionIds: ['a2'],
        rawEventIds: ['r2'],
        provenance: 'HUMAN_RECORDED',
        confidence: 1,
        explanation: 'x',
      },
      {
        id: 's2',
        step: { kind: 'expect', expect: { url: '/items' }, allow: [], optional: false },
        label: 'expect',
        actionIds: ['a2'],
        rawEventIds: ['r2'],
        provenance: 'INFERRED_OUTCOME',
        confidence: 1,
        explanation: 'x',
      },
    ];
    annotateFlowSteps(steps, intents);
    expect(steps[0]?.intent).toMatchObject({
      name: 'SEARCH_ITEM',
      status: 'CONFIRMED',
      operation: 'SEARCH',
      entity: 'item',
    });
    expect(steps[0]?.step.functionalIntent).toMatchObject({
      name: 'SEARCH_ITEM',
      ui: 'SEARCH',
      context: { form: 'item-search' },
    });
    expect(steps[0]?.step.kind).toBe('click');
    expect(steps[1]?.intent).toBeUndefined();
    const raw = rawStepOf(steps[0]?.step as FlowStep);
    expect(raw).toMatchObject({
      click: { role: 'button', name: 'Search' },
      functionalIntent: { name: 'SEARCH_ITEM' },
    });
    // Le YAML relu accepte l'annotation et la garde ; une annotation mal formée est refusée.
    const parsed = flowSchema.parse({ name: 'f', steps: [raw] });
    expect(parsed.steps[0]?.functionalIntent?.name).toBe('SEARCH_ITEM');
    expect(() =>
      flowSchema.parse({
        name: 'f',
        steps: [{ ...raw, functionalIntent: { name: 'X', status: 'MAYBE', confidence: 0.5 } }],
      }),
    ).toThrow();
    expect(annotationOf(byAction(intents, 'a8'))).toMatchObject({ name: 'CLICK', status: 'UNKNOWN' });
  });

  it('the self-healing workflow context prefers the recorded functional intent over the label heuristic', () => {
    const steps: FlowStep[] = [
      { kind: 'fill', target: { strategy: 'label', value: 'Name' }, value: 'x', allow: [], optional: false },
      {
        kind: 'click',
        target: { strategy: 'role', role: 'button', name: 'Go' },
        allow: [],
        optional: false,
        functionalIntent: {
          name: 'SEARCH_ITEM',
          status: 'CONFIRMED',
          confidence: 0.9,
          ui: 'SEARCH',
          operation: 'SEARCH',
          entity: 'item',
          alternatives: ['FILTER'],
        },
      },
      { kind: 'click', target: { strategy: 'role', role: 'button', name: 'Go' }, allow: [], optional: false },
    ];
    const recorded = resolveWorkflowContext(steps, 1);
    expect(recorded.businessIntent).toMatchObject({ name: 'SEARCH_ITEM', confidence: 'CONFIRMED' });
    expect(recorded.businessIntent?.sources).toContain('recorded functional intent');
    const heuristic = resolveWorkflowContext(steps, 2);
    expect(heuristic.businessIntent?.name).toBe('OPEN_GO');
  });

  it('the application model carries the functional intent of every action view and counts the UNKNOWN ones it explains', () => {
    const kept = journey();
    const { intents } = resolveRecordingIntents({ kept, states: STATES });
    const rawEvents = kept.map((entry, index) => ({
      id: entry.rawEventIds[0] ?? `r${String(index)}`,
      sequence: index + 1,
      type: entry.type === 'FILL' ? ('input' as const) : ('click' as const),
      at: entry.at,
      url: entry.url,
    }));
    const model = buildApplicationModel({ actions: kept, states: STATES, rawEvents, intents });
    const search = model.actions.find((view) => view.actionId === 'a2');
    expect(search?.functionalIntent).toMatchObject({ name: 'SEARCH_ITEM', status: 'CONFIRMED' });
    expect(model.summary.actions.intentResolved).toBeGreaterThanOrEqual(5);
    expect((model.summary.actions.intentOnly ?? 0) >= 1).toBe(true);
  });

  it('summarize counts statuses, distinct functional intents and the unresolved actions', () => {
    const { intents } = resolveRecordingIntents({ kept: journey(), states: STATES });
    const summary = summarize(intents);
    expect(summary.actions).toBe(8);
    expect(
      summary.byStatus.CONFIRMED +
        summary.byStatus.PROBABLE +
        summary.byStatus.AMBIGUOUS +
        summary.byStatus.UNKNOWN,
    ).toBe(8);
    expect(summary.unresolved[0]).toMatchObject({ actionId: 'a8', label: 'Mystery', candidates: [] });
  });
});

const TRIGGERS: TriggerSettings = {
  ambiguousTarget: true,
  unknownScreen: true,
  flowDivergence: true,
  recoveryFailed: true,
  multiplePlans: true,
  unresolvedHypothesis: true,
  unknownBusinessError: true,
  lowConfidence: true,
  knowledgeContradiction: true,
  unknownBlockingPrecondition: true,
  hypothesisAnalysis: true,
  recordingEnrichment: true,
};

function gatewayWith(
  provider: FakeIntelligenceProvider,
  mode: 'OFF' | 'ASSIST' | 'HYBRID' = 'HYBRID',
): IntelligenceGateway {
  return new IntelligenceGateway({
    mode,
    providerId: provider.id,
    createProvider: () => provider,
    triggers: TRIGGERS,
    thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
    budgets: {
      maxCallsPerRun: 10,
      maxCallsPerAction: 1,
      maxCallsPerDivergence: 1,
      maxToolCallsPerRequest: 4,
      maxReasoningDurationMs: 60_000,
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    failOnUnavailable: false,
    sanitizer: new IntelligenceContextSanitizer(),
  });
}

function ambiguousIntent(): FunctionalIntent {
  counter = 0;
  const go = action(
    'CLICK',
    'Go',
    { stateBefore: 'o1', stateAfter: 'o1' },
    { role: 'button', form: 'item-search' },
  );
  return resolveFunctionalIntent({
    action: go,
    previous: [
      action(
        'FILL',
        'Name',
        { stateBefore: 'o1', stateAfter: 'o1' },
        { role: 'textbox', form: 'item-search' },
      ),
    ],
    next: [],
    stateBefore: LIST,
    stateAfter: LIST,
  });
}

describe('the AI arbiter (AMBIGUOUS only, among the deterministic candidates)', () => {
  it('chooses one of the candidates when the provider answers with a valid proposal; the raw action and evidence are untouched', async () => {
    const intent = ambiguousIntent();
    expect(intent.status).toBe('AMBIGUOUS');
    const second = intent.alternatives[1];
    if (!second) throw new Error('fixture');
    const provider = new FakeIntelligenceProvider((request) => {
      const match = request.availableActions.find((candidate) => candidate.name.startsWith(second.name));
      return {
        status: match ? 'PROPOSAL' : 'INCONCLUSIVE',
        ...(match ? { selectedActionId: match.id } : {}),
        intent: second.name,
        supportingEvidenceIds: request.relevantEvidence.slice(0, 1).map((item) => item.id),
        uncertainties: [],
        confidence: 0.9,
      };
    });
    const result = await arbitrateIntents({
      intents: [intent],
      gateway: gatewayWith(provider),
      mode: 'HYBRID',
      recordingId: 'rec',
    });
    expect(result.aiCalls).toBe(1);
    expect(result.arbitrated).toEqual([
      { actionId: intent.actionId, chosen: second.name, previous: intent.name },
    ]);
    expect(result.intents[0]).toMatchObject({ name: second.name, status: 'PROBABLE', source: 'AI_ARBITER' });
    expect(result.intents[0]?.evidence).toEqual(intent.evidence);
    // Le fournisseur n'a vu que des candidats et des preuves : aucune valeur saisie, aucun sélecteur.
    const request = provider.requests[0];
    expect(request?.availableActions.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(request)).not.toContain('strategy');
  });

  it('never invents: an INCONCLUSIVE answer, an unknown candidate, mode OFF or no gateway leave the intent AMBIGUOUS', async () => {
    const intent = ambiguousIntent();
    const inconclusive = new FakeIntelligenceProvider(() => ({
      status: 'INCONCLUSIVE',
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 0,
    }));
    const kept = await arbitrateIntents({
      intents: [intent],
      gateway: gatewayWith(inconclusive),
      mode: 'HYBRID',
      recordingId: 'rec',
    });
    expect(kept.intents[0]?.status).toBe('AMBIGUOUS');
    expect(kept.arbitrated).toEqual([]);
    const invented = new FakeIntelligenceProvider(proposeByName('SOMETHING_ELSE', 0.99));
    const still = await arbitrateIntents({
      intents: [intent],
      gateway: gatewayWith(invented),
      mode: 'HYBRID',
      recordingId: 'rec',
    });
    expect(still.intents[0]?.status).toBe('AMBIGUOUS');
    const off = await arbitrateIntents({ intents: [intent], mode: 'OFF', recordingId: 'rec' });
    expect(off.aiCalls).toBe(0);
    expect(off.intents[0]).toBe(intent);
    // Une intention déjà sûre n'est jamais soumise.
    const confirmed = byAction(resolveRecordingIntents({ kept: journey(), states: STATES }).intents, 'a2');
    const untouched = new FakeIntelligenceProvider(proposeByName('X', 0.9));
    const none = await arbitrateIntents({
      intents: [confirmed],
      gateway: gatewayWith(untouched),
      mode: 'HYBRID',
      recordingId: 'rec',
    });
    expect(none.aiCalls).toBe(0);
    expect(untouched.requests).toHaveLength(0);
  });
});

describe('the intent library (learning across recordings)', () => {
  it('remembers confirmed intents by gesture + label + request shape, generalizes them, and feeds them back as HISTORY evidence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qa-intent-lib-'));
    const store = new FunctionalKnowledgeStore(directory, { application: 'app' });
    await store.load();
    const kept = journey();
    const { intents } = resolveRecordingIntents({ kept, states: STATES });
    const search = byAction(intents, 'a2');
    const action2 = kept[1];
    if (!action2) throw new Error('fixture');
    store.rememberIntentPatterns([
      { key: historyKeyOf(action2), intent: search.name, generic: generalize(search.name) },
    ]);
    store.rememberIntentPatterns([
      { key: historyKeyOf(action2), intent: search.name, generic: generalize(search.name) },
    ]);
    await store.save([]);
    const reloaded = new FunctionalKnowledgeStore(directory, { application: 'app' });
    await reloaded.load();
    expect(reloaded.intentPatterns()).toEqual([
      expect.objectContaining({
        key: 'CLICK|search|GET /api/items',
        intent: 'SEARCH_ITEM',
        generic: 'SEARCH_ENTITY',
        confirmations: 2,
      }),
    ]);
    // Un autre enregistrement, un bouton « Search » sans réseau observé cette fois : l'historique soutient SEARCH, sans l'imposer.
    counter = 0;
    const mute = action('CLICK', 'Search', { stateBefore: 'o1', stateAfter: 'o1' }, { role: 'button' });
    const history = reloaded
      .intentPatterns()
      .map((pattern) => ({ key: pattern.key, intent: pattern.intent, confirmations: pattern.confirmations }));
    const withHistory = resolveFunctionalIntent({
      action: mute,
      previous: [],
      next: [],
      history: [...history, { key: historyKeyOf(mute), intent: 'SEARCH_ITEM', confirmations: 2 }],
    });
    expect(withHistory.evidence.some((item) => item.type === 'HISTORY')).toBe(true);
    expect(withHistory.evidence.find((item) => item.type === 'HISTORY')?.trust).toBe('HISTORICAL');
    // Une autre intention pour la même clé repart de 1 : la bibliothèque n'est pas une règle gravée.
    reloaded.rememberIntentPatterns([
      { key: 'CLICK|search|GET /api/items', intent: 'FILTER', generic: 'FILTER' },
    ]);
    expect(reloaded.intentPatterns()[0]).toMatchObject({ intent: 'FILTER', confirmations: 1 });
  });
});

describe('end to end: a recording of search → pick in the list → open (processRecording)', () => {
  it('resolves the intents, annotates the generated YAML next to each step, and the feature keeps the same steps', () => {
    const { config } = parseConfig(
      'mission: { name: rec }\ntarget: { baseUrl: "http://app.test", startAt: /items }\n',
      {},
      {},
    );
    const element = (overrides: Partial<RecordedElement>): RecordedElement => ({
      tag: 'button',
      role: 'button',
      name: 'x',
      css: 'main > button',
      cssStable: false,
      inForm: false,
      isSubmit: false,
      inNavigation: false,
      inDialog: false,
      sameRoleName: 1,
      roleNameIndex: 0,
      sameLabel: 1,
      ...overrides,
    });
    let sequence = 0;
    const raw = (
      type: RawRecordedEvent['type'],
      at: number,
      extra: Partial<RawRecordedEvent>,
    ): RawRecordedEvent => {
      sequence += 1;
      return { id: `r${String(sequence)}`, sequence, type, at, url: 'http://app.test/items', ...extra };
    };
    const states: RecordedState[] = [
      state('o1', '/items', { tableRows: 20, controls: ['button:Search'] }),
      state('o2', '/items', { tableRows: 3, controls: ['button:Search', 'link:Item 42'] }),
      state('o3', '/items/42', { controls: ['button:Edit'] }),
    ];
    const events: RawRecordedEvent[] = [
      raw('navigation', 100, { stateAfter: 'o1' }),
      raw('change', 1000, {
        element: element({ tag: 'input', role: 'textbox', name: 'Name', label: 'Name', inForm: true }),
        value: { empty: false, length: 4, shape: 'text' },
        stateAfter: 'o1',
      }),
      raw('click', 2000, {
        element: element({ name: 'Search', text: 'Search', inForm: true }),
        network: [
          {
            method: 'GET',
            path: '/api/items?name=x',
            status: 200,
            records: [
              { index: 0, identifiers: [{ field: 'id', value: '41', digest: 'd41', source: 'response' }] },
              { index: 1, identifiers: [{ field: 'id', value: '42', digest: 'd42', source: 'response' }] },
              { index: 2, identifiers: [{ field: 'id', value: '43', digest: 'd43', source: 'response' }] },
            ],
          },
        ],
        stateAfter: 'o2',
      }),
      raw('click', 3000, {
        element: element({ tag: 'a', role: 'link', name: 'Item 42', text: 'Item 42', href: '/items/42' }),
        network: [{ method: 'GET', path: '/api/items/42', status: 200 }],
        stateAfter: 'o3',
      }),
    ];
    const session: RecordingSession = {
      id: 'rec-intent',
      name: 'Find an item',
      startedAt: '2026-01-01T00:00:00.000Z',
      startUrl: 'http://app.test/items',
      status: 'PROCESSING',
      rawEvents: events,
      semanticActions: [],
      checkpoints: [],
      states,
      initialStateId: 'o1',
      warnings: [],
      droppedEvents: 0,
    };
    const result = processRecording(session, config, { language: 'en' });
    expect(result.intents).toBeDefined();
    const intents = result.intents?.intents ?? [];
    const search = intents.find((intent) => intent.target?.label === 'Search');
    expect(search).toMatchObject({
      physical: 'CLICK',
      ui: 'SEARCH',
      functional: { operation: 'SEARCH', entity: 'item' },
    });
    expect(search?.status === 'CONFIRMED' || search?.status === 'PROBABLE').toBe(true);
    const open = intents.find((intent) => intent.target?.label === 'Item 42');
    expect(open?.functional?.operation).toBe('OPEN');
    // L'étape garde sa cible ; l'intention est à côté, dans le modèle et dans le YAML.
    const searchStep = result.flow.steps.find((step) => step.label.includes('Search'));
    expect(searchStep?.step.kind).toBe('click');
    expect(searchStep?.intent?.name).toBe('SEARCH_ITEM');
    expect(searchStep?.step.functionalIntent?.name).toBe('SEARCH_ITEM');
    expect(result.files.yaml).toContain('functionalIntent:');
    expect(result.files.yaml).toContain('name: SEARCH_ITEM');
    expect(result.files.yaml).toMatch(/# .*intent SEARCH_ITEM (CONFIRMED|PROBABLE)/);
    expect(result.files.yaml).not.toContain('name=x');
    // Le YAML généré reste un flow valide, et sa relecture garde l'annotation.
    const { testData: _file, ...flowDocument } = parseYaml(result.files.yaml) as Record<string, unknown>;
    const replayed = flowSchema.parse(flowDocument);
    const replayedStep = replayed.steps.find((step) => step.kind === 'click' && step.functionalIntent);
    expect(replayedStep?.functionalIntent?.name).toBe('SEARCH_ITEM');
    // Le modèle de l'application voit la même intention.
    const view = result.application?.actions.find((entry) => entry.label === 'Search');
    expect(view?.functionalIntent?.name).toBe('SEARCH_ITEM');
  });
});
