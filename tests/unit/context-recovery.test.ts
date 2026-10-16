import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { TestDataRunContext } from '../../src/data/test-data-run-context.js';
import {
  CONTEXT_CHECKPOINT_SCHEMA,
  compareContext,
  decideRecovery,
  fieldStepsOf,
  mutationSteps,
  redactedCheckpoint,
  type ContextCheckpoint,
  type ContextSnapshot,
  type RecoveryInput,
} from '../../src/replay/context-checkpoint.js';

/**
 * RESTAURATION DU CONTEXTE : la page tenue est comparée au checkpoint pris devant l'étape, et la
 * stratégie de reprise est décidée — REVALIDATE, RESTORE, REBUILD, MANUAL_RECOVERY. Une URL identique
 * n'est jamais une preuve suffisante ; une étape à effet métier n'est jamais répétée sans décision.
 */
const NOW = new Date('2026-10-13T10:00:00.000Z');

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    capturedAt: NOW.toISOString(),
    location: {
      href: 'https://app.test/requests/42?tab=details',
      path: '/requests/42',
      query: { tab: 'details' },
      fragment: '',
      route: '/requests/42',
      title: 'Request 42',
    },
    frames: ['/mfe/requests'],
    activeTabs: ['Details'],
    scroll: { x: 0, y: 120 },
    fields: [
      { key: 'Search', kind: 'text', filled: true, sensitive: false, value: 'Northwind' },
      { key: 'Only open', kind: 'checkbox', filled: true, checked: true, sensitive: false },
      { key: 'Password', kind: 'text', filled: true, sensitive: true },
    ],
    selectedRows: [],
    ...overrides,
  };
}

function checkpoint(overrides: Partial<ContextCheckpoint> = {}): ContextCheckpoint {
  return {
    schema: CONTEXT_CHECKPOINT_SCHEMA,
    scenario: 'demo',
    runId: 'run-1',
    stepIndex: 5,
    capturedAt: NOW.toISOString(),
    snapshot: snapshot(),
    runData: [{ key: 'request.name', value: 'Northwind' }],
    confirmedCheckpoints: [],
    executedMutations: [],
    preconditions: [],
    ...overrides,
  };
}

const input = (overrides: Partial<RecoveryInput> = {}): RecoveryInput => ({
  checkpoint: checkpoint(),
  live: snapshot(),
  stepIndex: 5,
  mutations: [],
  repeatMutations: false,
  now: NOW,
  maxAgeMs: 30 * 60_000,
  fieldSteps: new Map([
    ['search', 3],
    ['only open', 4],
  ]),
  ...overrides,
});

describe('context recovery: the decision', () => {
  it('the page is still in the checkpoint state: REVALIDATE (the preconditions are checked next)', () => {
    const decision = decideRecovery(input());
    expect(decision.strategy).toBe('REVALIDATE');
    expect(decision.differences).toEqual([]);
  });

  it('1 · same URL, different application state (a dialog closed): never trusted, REBUILD', () => {
    const decision = decideRecovery(
      input({ checkpoint: checkpoint({ snapshot: snapshot({ dialog: 'Edit request' }) }), live: snapshot() }),
    );
    expect(decision.strategy).toBe('REBUILD');
    expect(decision.differences.map((difference) => difference.kind)).toEqual(['DIALOG']);
    expect(decision.rebuildFrom).toBe(1);
  });

  it('2 · client-side navigation (SPA, no reload) to another route: REBUILD', () => {
    const live = snapshot({ location: { ...snapshot().location, path: '/requests', route: '/requests' } });
    const decision = decideRecovery(input({ live }));
    expect(decision.strategy).toBe('REBUILD');
    expect(decision.reasons.join(' ')).toContain('route /requests/42 expected, /requests found');
  });

  it('3 · a search filter emptied (its POST is sent again by its step): RESTORE replays the step that fills it', () => {
    const live = snapshot({
      fields: [
        { key: 'Search', kind: 'text', filled: false, sensitive: false },
        ...snapshot().fields.slice(1),
      ],
    });
    const decision = decideRecovery(input({ live }));
    expect(decision.strategy).toBe('RESTORE');
    expect(decision.restoreSteps).toEqual([3]);
  });

  it('4 · a framework-controlled field holds another value, a checkbox flipped: RESTORE both steps', () => {
    const live = snapshot({
      fields: [
        { key: 'Search', kind: 'text', filled: true, sensitive: false, value: 'Globex' },
        { key: 'Only open', kind: 'checkbox', filled: false, checked: false, sensitive: false },
        snapshot().fields[2] as ContextSnapshot['fields'][number],
      ],
    });
    const decision = decideRecovery(input({ live }));
    expect(decision.strategy).toBe('RESTORE');
    expect(decision.restoreSteps).toEqual([3, 4]);
  });

  it('5 · a modal that was open is gone (or an unexpected one is open): REBUILD', () => {
    const expected = checkpoint({ snapshot: snapshot({ dialog: 'Confirm' }) });
    expect(decideRecovery(input({ checkpoint: expected })).strategy).toBe('REBUILD');
    expect(
      decideRecovery(input({ live: snapshot({ dialog: 'Session warning' }) })).differences[0]?.kind,
    ).toBe('DIALOG');
  });

  it('6 · a micro-frontend reloaded elsewhere (its frame is gone): REBUILD', () => {
    const decision = decideRecovery(input({ live: snapshot({ frames: [] }) }));
    expect(decision.strategy).toBe('REBUILD');
    expect(decision.differences[0]).toMatchObject({ kind: 'FRAME', severity: 'HARD' });
  });

  it('7 · another tab selected: REBUILD', () => {
    const decision = decideRecovery(input({ live: snapshot({ activeTabs: ['History'] }) }));
    expect(decision.strategy).toBe('REBUILD');
    expect(decision.differences[0]?.kind).toBe('TAB');
  });

  it('8 · the session expired (sign-in page): MANUAL_RECOVERY, never restored automatically', () => {
    const live = snapshot({ location: { ...snapshot().location, path: '/login', route: '/login' } });
    const decision = decideRecovery(input({ live }));
    expect(decision.strategy).toBe('MANUAL_RECOVERY');
    expect(decision.reasons.join(' ')).toContain('never restored automatically');
    // Une route de connexion propre à l'application, déclarée dans la mission.
    const custom = snapshot({
      location: { ...snapshot().location, path: '/portail/entree', route: '/portail/entree' },
    });
    expect(decideRecovery(input({ live: custom, loginRoutes: ['/portail/entree'] })).strategy).toBe(
      'MANUAL_RECOVERY',
    );
  });

  it('10 · a creation already done in this run: a rebuild would repeat it — MANUAL_RECOVERY unless allowed', () => {
    const lost = input({
      live: undefined,
      mutations: [2],
      checkpoint: checkpoint({ executedMutations: [2] }),
    });
    const blocked = decideRecovery(lost);
    expect(blocked.strategy).toBe('MANUAL_RECOVERY');
    expect(blocked.blockedBy).toEqual([
      {
        step: 2,
        reason: 'already executed in this run (creation or change): not repeated without a decision',
      },
    ]);
    expect(decideRecovery({ ...lost, repeatMutations: true }).strategy).toBe('REBUILD');
    // Une création APRÈS l'étape visée n'empêche rien.
    expect(
      decideRecovery({ ...lost, mutations: [7], checkpoint: checkpoint({ executedMutations: [] }) }).strategy,
    ).toBe('REBUILD');
  });

  it('11 · an old checkpoint is never taken for granted: noted, the page is verified again', () => {
    const old = checkpoint({ capturedAt: new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString() });
    const decision = decideRecovery(input({ checkpoint: old }));
    expect(decision.strategy).toBe('REVALIDATE');
    expect(decision.differences[0]?.kind).toBe('STALE');
    expect(decision.reasons[0]).toContain('old');
  });

  it('12 · the in-memory state is lost (page closed): nothing is written into the application, REBUILD by replay', () => {
    const decision = decideRecovery(input({ live: undefined }));
    expect(decision.strategy).toBe('REBUILD');
    expect(decision.differences[0]?.kind).toBe('PAGE_CLOSED');
  });

  it('13 · a lost field whose value is not known (sensitive, or no step fills it): RESTORE impossible, REBUILD', () => {
    const live = snapshot({
      fields: [
        ...snapshot().fields.slice(0, 2),
        { key: 'Password', kind: 'text', filled: false, sensitive: true },
      ],
    });
    const decision = decideRecovery(input({ live }));
    expect(decision.strategy).toBe('REBUILD');
    expect(decision.reasons.join(' ')).toContain('"Password" cannot be restored');
  });

  it('a query parameter that differs is reported, not blocking', () => {
    const live = snapshot({ location: { ...snapshot().location, query: { tab: 'history' } } });
    const differences = compareContext(snapshot(), live);
    expect(differences).toEqual([{ kind: 'QUERY', detail: 'query parameter tab differs', severity: 'SOFT' }]);
    expect(decideRecovery(input({ live })).strategy).toBe('REVALIDATE');
  });
});

describe('context recovery: the flow facts and the security', () => {
  const steps: FlowStep[] = [
    { kind: 'goto', url: '/requests' } as FlowStep,
    {
      kind: 'click',
      target: { strategy: 'role', role: 'button', name: 'Create' },
      allow: [],
      optional: false,
      effects: { request: 'POST /api/requests' },
    },
    {
      kind: 'fill',
      target: { strategy: 'label', value: 'Search' },
      value: 'x',
      allow: [],
      optional: false,
    },
    {
      kind: 'click',
      target: { strategy: 'role', role: 'button', name: 'Delete' },
      allow: ['MUTATION'],
      optional: false,
    },
  ];

  it('steps with a business effect: a recorded write request or a MUTATION / DANGEROUS permission', () => {
    expect(mutationSteps(steps)).toEqual([2, 4]);
    expect(fieldStepsOf(steps).get('search')).toBe(3);
  });

  it('9 · the run data generated before the failure is reused at the resume, never generated again', () => {
    const context = new TestDataRunContext({ runId: 'r', env: {} });
    context.seed([{ key: 'company.name', value: 'Northwind 42' }]);
    const resolved = context.resolve('company.name', [], {
      fallback: () => 'Other',
      generate: () => 'Generated again',
    });
    expect(resolved).toEqual({ kind: 'value', value: 'Northwind 42', strategy: 'PROVIDER', generated: true });
    expect(context.values()).toEqual([{ key: 'company.name', value: 'Northwind 42' }]);
  });

  it('the written checkpoint holds digests, never a value (run data, fields); sensitive fields never had one', () => {
    const written = JSON.stringify(redactedCheckpoint(checkpoint(), (value) => `#${String(value.length)}`));
    expect(written).not.toContain('Northwind');
    expect(written).toContain('"digest":"#9"');
    expect(written).toContain('"key":"request.name"');
  });
});
