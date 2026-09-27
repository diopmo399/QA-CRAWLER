import { describe, expect, it } from 'vitest';
import type { PageContext } from '../../src/model/page-context.js';
import { CircuitBreaker, failureKind } from '../../src/recovery/circuit-breaker.js';
import { RecoveryEngine } from '../../src/recovery/recovery-engine.js';
import { RECOVERY_STRATEGIES } from '../../src/recovery/recovery-model.js';
import { StuckDetector } from '../../src/recovery/stuck-detector.js';

const state = (stateId: string): PageContext => ({
  url: `http://app.test/${stateId}`,
  title: stateId,
  stateId,
  stateLabel: stateId,
  route: `/${stateId}`,
  headings: [],
  dialogs: [],
  actions: [],
  forms: [],
  errors: [],
  metadata: { depth: 0, timestamp: '', flow: [] },
});

const engine = (overrides: Partial<ConstructorParameters<typeof RecoveryEngine>[0]> = {}): RecoveryEngine =>
  new RecoveryEngine({
    enabled: true,
    strategies: RECOVERY_STRATEGIES,
    maxRetries: 1,
    maxReauthentications: 2,
    ...overrides,
  });

describe('RecoveryEngine', () => {
  it('tries the strategies in order until one reaches a state, and records every attempt', async () => {
    const tried: string[] = [];
    const recovery = engine();
    const outcome = await recovery.recover(
      {
        stateId: 'users',
        actionId: 'a1',
        kind: 'action-failed',
        message: 'Timeout 3000ms exceeded.\nCall log…',
      },
      {
        escape: () => {
          tried.push('escape');
          return Promise.resolve(undefined);
        },
        'known-url': () => {
          tried.push('known-url');
          return Promise.resolve(state('users'));
        },
        'replay-path': () => {
          tried.push('replay-path');
          return Promise.resolve(state('users'));
        },
      },
    );
    expect(tried).toEqual(['escape', 'known-url']);
    expect(outcome.strategy).toBe('known-url');
    expect(recovery.events().map((event) => [event.strategy, event.success])).toEqual([
      ['escape', false],
      ['known-url', true],
    ]);
    expect(recovery.events()[0]?.message).toBe('Timeout 3000ms exceeded.');
  });

  it('follows the configured order and ignores the strategies left out', async () => {
    const tried: string[] = [];
    const attempt = (name: string) => () => {
      tried.push(name);
      return Promise.resolve(undefined);
    };
    await engine({ strategies: ['replay-path', 'known-url'] }).recover(
      { stateId: 's', kind: 'action-failed' },
      { escape: attempt('escape'), 'known-url': attempt('known-url'), 'replay-path': attempt('replay-path') },
    );
    expect(tried).toEqual(['replay-path', 'known-url']);
  });

  it('re-authenticates only after a session expiry, within the limit', async () => {
    const recovery = engine({ maxReauthentications: 1 });
    let logins = 0;
    const reauthenticate = (): Promise<PageContext | undefined> => {
      logins += 1;
      return Promise.resolve(state('s'));
    };
    await recovery.recover({ stateId: 's', kind: 'action-failed' }, { reauthenticate });
    expect(logins).toBe(0);
    await recovery.recover({ stateId: 's', kind: 'session-expired' }, { reauthenticate });
    expect(logins).toBe(1);
    expect(recovery.mayReauthenticate()).toBe(true);
    expect(recovery.mayReauthenticate()).toBe(false);
  });

  it('retries only a transient error, once, and never an action that sends data', () => {
    const recovery = engine();
    const safe = { classification: 'SAFE' as const };
    expect(recovery.shouldRetry('Element is not attached to the DOM', safe, 0)).toBe(true);
    expect(recovery.shouldRetry('Element is not attached to the DOM', safe, 1)).toBe(false);
    expect(recovery.shouldRetry('Timeout 3000ms exceeded', safe, 0)).toBe(false);
    expect(recovery.shouldRetry('element is not stable', { classification: 'MUTATION' }, 0)).toBe(false);
    expect(recovery.shouldRetry('element is not stable', { ...safe, submitsForm: true }, 0)).toBe(false);
    expect(engine({ enabled: false }).shouldRetry('not stable', safe, 0)).toBe(false);
  });

  it('disabled: only what the explorer always did (top layer, URL, replay, elsewhere)', () => {
    expect(engine({ enabled: false }).strategies).toEqual([
      'dismiss-dialog',
      'known-url',
      'replay-path',
      'abandon-branch',
    ]);
  });

  it('a strategy that throws counts as failed, the next one is tried', async () => {
    const outcome = await engine().recover(
      { stateId: 's', kind: 'page-crash' },
      {
        'known-url': () => Promise.reject(new Error('page closed')),
        'abandon-branch': () => Promise.resolve(state('elsewhere')),
      },
    );
    expect(outcome).toMatchObject({ strategy: 'abandon-branch', context: { stateId: 'elsewhere' } });
  });
});

describe('CircuitBreaker', () => {
  it('opens after the same failure of the same action, twice', () => {
    const breaker = new CircuitBreaker({ threshold: 2, maxFailuresPerState: 5 });
    expect(breaker.record('users', 'a1', 'Timeout 3000ms exceeded waiting for "#save"')).toBe('closed');
    expect(breaker.isOpen('users', 'a1')).toBe(false);
    expect(breaker.record('users', 'a1', 'Timeout 5000ms exceeded waiting for "#other"')).toBe('action-open');
    expect(breaker.isOpen('users', 'a1')).toBe(true);
    expect(breaker.isOpen('users', 'a2')).toBe(false);
    expect(breaker.circuits()).toEqual([
      { stateId: 'users', actionId: 'a1', failure: 'Timeout Nms exceeded waiting for "…"', occurrences: 2 },
    ]);
  });

  it('different failures do not add up for one action; too many on a state abandon it', () => {
    const breaker = new CircuitBreaker({ threshold: 2, maxFailuresPerState: 3 });
    expect(breaker.record('s', 'a1', 'Timeout')).toBe('closed');
    expect(breaker.record('s', 'a1', 'Element is not visible')).toBe('closed');
    expect(breaker.record('s', 'a2', 'Timeout')).toBe('state-open');
    expect(breaker.isOpen('s')).toBe(true);
    expect(breaker.circuits().at(-1)).toMatchObject({ stateId: 's', occurrences: 3 });
  });

  it('failureKind removes what changes between occurrences', () => {
    expect(failureKind('Timeout 3000ms exceeded.\n  waiting for locator')).toBe('Timeout Nms exceeded.');
    expect(failureKind("locator('#row-42') not found")).toBe('locator("…") not found');
  });
});

describe('StuckDetector', () => {
  const detector = (): StuckDetector =>
    new StuckDetector({ oscillationCycles: 3, maxNoOpActions: 3, maxBusyObservations: 2 });
  const move = (from: string, to: string, requests = 1, busy = false) => ({ from, to, requests, busy });

  it('detects A→B→A→B oscillation', () => {
    const stuck = detector();
    const events = [move('a', 'b'), move('b', 'a'), move('a', 'b'), move('b', 'a'), move('a', 'b')].map(
      (transition) => stuck.observe(transition),
    );
    expect(events.slice(0, 4).every((event) => event === undefined)).toBe(true);
    expect(events[4]).toMatchObject({ kind: 'oscillation', stateId: 'b' });
  });

  it('a normal walk through several states is not an oscillation', () => {
    const stuck = detector();
    const events = [move('a', 'b'), move('b', 'c'), move('c', 'a'), move('a', 'b'), move('b', 'c')].map(
      (transition) => stuck.observe(transition),
    );
    expect(events.every((event) => event === undefined)).toBe(true);
  });

  it('detects repeated actions that change nothing, and a screen that keeps loading', () => {
    const stuck = detector();
    expect(stuck.observe(move('a', 'a', 0))).toBeUndefined();
    expect(stuck.observe(move('a', 'a', 1))).toBeUndefined(); // a request: something happened
    expect(stuck.observe(move('a', 'a', 0))).toBeUndefined();
    expect(stuck.observe(move('a', 'a', 0))).toBeUndefined();
    expect(stuck.observe(move('a', 'a', 0))).toMatchObject({ kind: 'no-op' });

    expect(stuck.observe(move('a', 'b', 1, true))).toBeUndefined();
    expect(stuck.observe(move('b', 'c', 1, true))).toMatchObject({ kind: 'busy', stateId: 'c' });
    expect(stuck.all().map((event) => event.kind)).toEqual(['no-op', 'busy']);
  });
});
