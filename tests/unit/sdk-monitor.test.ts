import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowConfig } from '../../src/config/flow-schema.js';
import type { FlowRunReport, FlowStepReport } from '../../src/model/flow-run.js';
import type { ExplorationEvent } from '../../src/sdk/core/index.js';
import { Exploration, stepLabel } from '../../src/sdk/server/explorations.js';
import { monitorStrings } from '../../src/sdk/ui/monitor-i18n.js';
import { EMPTY_VIEW, flowProgress, monitorFacets, selectEvents } from '../../src/sdk/ui/monitor-model.js';
import { renderMonitor, type MonitorState } from '../../src/sdk/ui/monitor-view.js';

/**
 * LE RUN MONITOR : les étapes des flows relayées par le serveur sans valeur saisie, le modèle (ce que
 * le flux a dit, rien d'estimé) et le rendu. Le vrai moteur et la reprise du flux dans Chromium :
 * tests/integration/sdk-monitor.test.ts.
 */
const step = (overrides: Partial<FlowStepReport>): FlowStepReport => ({
  index: 1,
  kind: 'click',
  description: 'click role=button "Save"',
  status: 'PASSED',
  optional: false,
  durationMs: 120,
  ...overrides,
});

describe('flow steps relayed by the server, never with a typed value', () => {
  it('labels a step without the value it typed or chose', () => {
    expect(stepLabel({ kind: 'fill', description: 'fill label="Title" = "secret title"' })).toBe(
      'fill label="Title"',
    );
    expect(stepLabel({ kind: 'fill', description: 'fill label="Code" = ${testData:item.code}' })).toBe(
      'fill label="Code"',
    );
    expect(stepLabel({ kind: 'select', description: 'select label="Owner" = "Jane Roe"' })).toBe(
      'select label="Owner"',
    );
    expect(stepLabel({ kind: 'auto', description: 'auto: je saisis "4111 1111" dans "Carte"' })).toBe('auto');
    expect(stepLabel({ kind: 'click', description: 'click role=button "Save"' })).toBe(
      'click role=button "Save"',
    );
  });

  it('emits flow and flow-step events from the engine listener, without the reason of a typed step', () => {
    const { config } = parseConfig('mission: { name: m }\ntarget: { baseUrl: http://app.test }\n', {}, {});
    const exploration = new Exploration({ projectId: 'prj', config, reportsDir: '/tmp/x' });
    const events: ExplorationEvent[] = [];
    exploration.subscribe((event) => events.push(event));
    const listener = exploration.listener();
    const flow = { name: 'create' } as FlowConfig;
    listener.onFlowStart?.(flow);
    listener.onFlowStep?.(
      flow,
      step({
        index: 1,
        kind: 'fill',
        description: 'fill label="Title" = "typed"',
        status: 'FAILED',
        reason: 'value "typed" was not kept',
      }),
    );
    listener.onFlowStep?.(
      flow,
      step({ index: 2, status: 'BLOCKED', reason: 'refused by the safety policy' }),
    );
    listener.onFlowEnd?.({
      name: 'create',
      status: 'FAILED',
      durationMs: 900,
      steps: [step({}), step({})],
    } as FlowRunReport);
    const relayed = events.filter((event) => event.type === 'flow' || event.type === 'flow-step');
    expect(relayed).toEqual([
      expect.objectContaining({ type: 'flow', flow: 'create', phase: 'start' }),
      expect.objectContaining({
        type: 'flow-step',
        index: 1,
        kind: 'fill',
        label: 'fill label="Title"',
        status: 'FAILED',
      }),
      expect.objectContaining({
        type: 'flow-step',
        index: 2,
        status: 'BLOCKED',
        reason: 'refused by the safety policy',
      }),
      expect.objectContaining({ type: 'flow', phase: 'end', status: 'FAILED', durationMs: 900, steps: 2 }),
    ]);
    expect(JSON.stringify(events)).not.toContain('typed');
    expect(relayed.map((event) => event.seq)).toEqual(
      [...relayed.map((event) => event.seq)].sort((a, b) => a - b),
    );
  });
});

const at = '2026-10-25T10:00:00.000Z';
const EVENTS: ExplorationEvent[] = [
  { seq: 1, at, type: 'status', status: 'RUNNING' },
  { seq: 2, at, type: 'flow', flow: 'create', phase: 'start' },
  {
    seq: 3,
    at,
    type: 'flow-step',
    flow: 'create',
    index: 1,
    kind: 'click',
    label: 'click "New"',
    status: 'PASSED',
    durationMs: 80,
  },
  {
    seq: 4,
    at,
    type: 'flow-step',
    flow: 'create',
    index: 2,
    kind: 'click',
    label: 'click "<b>Save</b>"',
    status: 'FAILED',
    durationMs: 900,
    reason: 'element not found',
  },
  { seq: 5, at, type: 'flow', flow: 'create', phase: 'end', status: 'FAILED', durationMs: 1000, steps: 2 },
  { seq: 6, at, type: 'flow', flow: 'search', phase: 'start' },
  {
    seq: 7,
    at,
    type: 'flow-step',
    flow: 'search',
    index: 1,
    kind: 'click',
    label: 'click "Search"',
    status: 'PASSED',
    durationMs: 60,
  },
  { seq: 8, at, type: 'state', stateId: 's1', label: 'Home', route: '/', title: 'Home' },
  {
    seq: 9,
    at,
    type: 'issue',
    severity: 'ERROR',
    issueType: 'HTTP',
    message: 'GET /api/x returned 500',
    route: '/x',
  },
  { seq: 10, at, type: 'issue', severity: 'WARNING', issueType: 'CONSOLE', message: 'deprecated call' },
];

describe('run monitor model', () => {
  it('lists what the stream actually carried', () => {
    expect(monitorFacets(EVENTS)).toEqual({
      flows: ['create', 'search'],
      stepStatuses: ['FAILED', 'PASSED'],
      types: ['flow-step', 'flow', 'state', 'issue', 'status'],
      issueTypes: ['CONSOLE', 'HTTP'],
    });
  });

  it('selects by flow, step status, event type and issue type, newest first', () => {
    expect(selectEvents(EVENTS, { ...EMPTY_VIEW, flow: 'create' }).shown.map((event) => event.seq)).toEqual([
      5, 4, 3, 2,
    ]);
    expect(
      selectEvents(EVENTS, { ...EMPTY_VIEW, stepStatus: 'FAILED' }).shown.map((event) => event.seq),
    ).toEqual([4]);
    expect(selectEvents(EVENTS, { ...EMPTY_VIEW, type: 'issue' }).shown.map((event) => event.seq)).toEqual([
      10, 9,
    ]);
    expect(
      selectEvents(EVENTS, { ...EMPTY_VIEW, issueType: 'HTTP' }).shown.map((event) => event.seq),
    ).toEqual([9]);
    expect(selectEvents(EVENTS, { ...EMPTY_VIEW, flow: 'search', stepStatus: 'FAILED' }).matching).toBe(0);
    expect(selectEvents(EVENTS, EMPTY_VIEW, 3)).toMatchObject({
      matching: 10,
      shown: [{ seq: 10 }, { seq: 9 }, { seq: 8 }],
    });
  });

  it('tells each flow from its own events: ended with the engine status, otherwise running', () => {
    expect(flowProgress(EVENTS)).toEqual([
      { name: 'create', steps: 2, byStatus: { PASSED: 1, FAILED: 1 }, status: 'FAILED', durationMs: 1000 },
      { name: 'search', steps: 1, byStatus: { PASSED: 1 } },
    ]);
  });
});

describe('run monitor rendering', () => {
  const base: MonitorState = {
    t: monitorStrings('fr'),
    phase: 'ready',
    events: EVENTS,
    connection: 'live',
    attempt: 0,
    view: { ...EMPTY_VIEW },
  };

  it('shows the counters, the flows and the events, escaped and without a percentage', () => {
    const html = renderMonitor(base);
    expect(html).toContain('En direct');
    expect(html).toContain('role="status"');
    expect(html).toContain('&lt;b&gt;Save&lt;/b&gt;');
    expect(html).not.toContain('<b>Save</b>');
    expect(html).toContain('element not found');
    expect(html).toContain('10 sur 10 événements');
    expect(html).toContain('en cours');
    expect(html).not.toContain('%');
    expect(html).toContain('groupes métier');
  });

  it('announces a reconnection and a lost stream', () => {
    expect(renderMonitor({ ...base, connection: 'reconnecting', attempt: 2 })).toContain(
      'Reconnexion (tentative 2)',
    );
    expect(renderMonitor({ ...base, connection: 'lost' })).toContain('Flux interrompu');
  });

  it('shows how many events match the choice', () => {
    const html = renderMonitor({ ...base, view: { ...EMPTY_VIEW, type: 'issue' } });
    expect(html).toContain('2 affichés, 2 correspondent, 10 reçus');
    expect(html).toContain('<option value="issue" selected>');
  });
});
