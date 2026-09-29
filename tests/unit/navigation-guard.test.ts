import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { actionOutcomeAfterError } from '../../src/execution/playwright-action-executor.js';
import {
  classifyPlaywrightError,
  mayReplayAfterNavigation,
  NavigationGuard,
  navigationLogLines,
  NavigationRecoveryError,
  type NavigationEvent,
} from '../../src/navigation/navigation-guard.js';
import { RecoveryEngine } from '../../src/recovery/recovery-engine.js';

const DESTROYED = 'page.evaluate: Execution context was destroyed, most likely because of a navigation';

/** Une page qui navigue : son URL change à chaque attente de la nouvelle page. */
function fakePage(urls: string[] = ['https://app.test/a', 'https://app.test/b']): {
  page: Page;
  waits: () => number;
} {
  let waits = 0;
  let index = 0;
  const page = {
    url: () => urls[Math.min(index, urls.length - 1)] ?? '',
    isClosed: () => false,
    waitForLoadState: () => {
      waits += 1;
      index += 1;
      return Promise.resolve();
    },
    on: () => page,
  } as unknown as Page;
  return { page, waits: () => waits };
}

/** Une lecture qui échoue avec ces messages, puis rend `value`. */
function reader<T>(failures: (string | Error)[], value: T): () => Promise<T> {
  return () => {
    const next = failures.shift();
    if (next === undefined) return Promise.resolve(value);
    return Promise.reject(next instanceof Error ? next : new Error(next));
  };
}

describe('classifyPlaywrightError', () => {
  it('recognizes the exact error of the crash as a navigation', () => {
    expect(classifyPlaywrightError(new Error(DESTROYED))).toEqual({
      kind: 'CONTEXT_DESTROYED',
      navigation: true,
      message: DESTROYED,
    });
    expect(
      classifyPlaywrightError(new Error('Protocol error: Cannot find context with specified id')).kind,
    ).toBe('CONTEXT_DESTROYED');
  });

  it('frame detached and interrupted navigations are navigations too', () => {
    expect(classifyPlaywrightError(new Error('frame.evaluate: Frame was detached'))).toMatchObject({
      kind: 'FRAME_DETACHED',
      navigation: true,
    });
    expect(
      classifyPlaywrightError(new Error('page.goto: Navigation to "x" is interrupted by another navigation')),
    ).toMatchObject({ kind: 'NAVIGATION_INTERRUPTED', navigation: true });
    expect(classifyPlaywrightError('net::ERR_ABORTED at https://x').kind).toBe('NAVIGATION_INTERRUPTED');
  });

  it('a closed page, a timeout or a functional error are not navigations', () => {
    expect(
      classifyPlaywrightError(new Error('page.evaluate: Target page, context or browser has been closed')),
    ).toMatchObject({ kind: 'PAGE_CLOSED', navigation: false });
    expect(classifyPlaywrightError(new Error('locator.click: Timeout 3000ms exceeded.'))).toMatchObject({
      kind: 'TIMEOUT',
      navigation: false,
    });
    expect(classifyPlaywrightError(new TypeError('Cannot read properties of null'))).toMatchObject({
      kind: 'OTHER',
      navigation: false,
    });
  });
});

describe('NavigationGuard.read (a READ of the page, replayed on the new page)', () => {
  it('abandons the interrupted read, waits for the new page and reads again', async () => {
    const events: NavigationEvent[] = [];
    const { page, waits } = fakePage();
    const guard = new NavigationGuard({ onEvent: (event) => events.push(event) });
    await expect(guard.read(page, 'dom-snapshot', reader([DESTROYED], 'snapshot'), 'a1')).resolves.toBe(
      'snapshot',
    );
    expect(waits()).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['NAVIGATION_DETECTED', 'NAVIGATION_RECOVERED']);
    expect(events[1]).toMatchObject({
      operation: 'dom-snapshot',
      reason: 'CONTEXT_DESTROYED',
      previousUrl: 'https://app.test/a',
      currentUrl: 'https://app.test/b',
      retries: 1,
      actionId: 'a1',
    });
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('several successive navigations: one read per new page, within the limit', async () => {
    const events: NavigationEvent[] = [];
    const { page } = fakePage(['https://sso.test/login', 'https://sso.test/relay', 'https://app.test/']);
    const guard = new NavigationGuard({ onEvent: (event) => events.push(event) });
    await expect(guard.read(page, 'dom-snapshot', reader([DESTROYED, DESTROYED], 1))).resolves.toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: 'NAVIGATION_RECOVERED',
      retries: 2,
      currentUrl: 'https://app.test/',
    });
  });

  it('a page that never stops navigating: bounded, NAVIGATION_RECOVERY_FAILED with the original cause', async () => {
    const events: NavigationEvent[] = [];
    const { page, waits } = fakePage();
    const guard = new NavigationGuard({ maxAttempts: 3, onEvent: (event) => events.push(event) });
    const failure = guard.read(page, 'dom-snapshot', reader([DESTROYED, DESTROYED, DESTROYED, DESTROYED], 0));
    await expect(failure).rejects.toBeInstanceOf(NavigationRecoveryError);
    await expect(failure).rejects.toThrow(/after 2 retries: .*Execution context was destroyed/);
    expect(waits()).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'NAVIGATION_RECOVERY_FAILED', retries: 2, cause: DESTROYED });
  });

  it('a navigation followed by a real error: the real error is raised, never masked', async () => {
    const { page } = fakePage();
    const guard = new NavigationGuard();
    const bug = new TypeError('Cannot read properties of null (reading "x")');
    await expect(guard.read(page, 'dom-snapshot', reader([DESTROYED, bug], 0))).rejects.toBe(bug);
  });

  it('a non-navigation error is raised at once, without waiting', async () => {
    const { page, waits } = fakePage();
    const guard = new NavigationGuard();
    await expect(guard.read(page, 'x', reader(['Timeout 3000ms exceeded'], 0))).rejects.toThrow('Timeout');
    expect(waits()).toBe(0);
  });

  it('passive when nothing navigates: no event, no wait', async () => {
    const events: NavigationEvent[] = [];
    const { page, waits } = fakePage();
    const guard = new NavigationGuard({ onEvent: (event) => events.push(event) });
    await expect(guard.read(page, 'x', reader([], 42))).resolves.toBe(42);
    expect(events).toEqual([]);
    expect(waits()).toBe(0);
  });
});

describe('idempotence: reads may be replayed, actions never', () => {
  it('only a READ is replayed after a navigation', () => {
    expect(mayReplayAfterNavigation('READ')).toBe(true);
    for (const kind of ['SAFE', 'MUTATION', 'DANGEROUS', 'UNKNOWN'] as const)
      expect(mayReplayAfterNavigation(kind)).toBe(false);
  });

  it('a click interrupted by its own navigation was performed; a field lost with its document is not replayed', () => {
    expect(actionOutcomeAfterError('click', new Error(DESTROYED))).toBe('PERFORMED');
    expect(actionOutcomeAfterError('navigate', new Error('Frame was detached'))).toBe('PERFORMED');
    expect(actionOutcomeAfterError('fill', new Error(DESTROYED))).toBe('INTERRUPTED');
    expect(actionOutcomeAfterError('click', new Error('locator.click: Timeout 3000ms exceeded'))).toBe(
      'FAILED',
    );
  });

  it('the RecoveryEngine never retries an action after a navigation, whatever its class', () => {
    const recovery = new RecoveryEngine({
      enabled: true,
      strategies: ['retry'],
      maxRetries: 3,
      maxReauthentications: 0,
    });
    for (const classification of ['SAFE', 'MUTATION', 'DANGEROUS', 'UNKNOWN'] as const) {
      expect(recovery.shouldRetry(DESTROYED, { classification }, 0)).toBe(false);
      expect(recovery.shouldRetry('Frame was detached', { classification }, 0)).toBe(false);
    }
    // Un élément réaffiché sous le clic reste une erreur passagère pour une action SAFE.
    expect(recovery.shouldRetry('Element is not attached to the DOM', { classification: 'SAFE' }, 0)).toBe(
      true,
    );
  });
});

describe('structured logs', () => {
  it('[NAVIGATION] detected … recovered, and [NAVIGATION_RECOVERY_FAILED] with the cause', () => {
    const base = {
      at: '',
      operation: 'dom-snapshot',
      reason: 'CONTEXT_DESTROYED' as const,
      previousUrl: 'https://a.test/',
      currentUrl: 'https://b.test/',
    };
    expect(navigationLogLines({ ...base, type: 'NAVIGATION_DETECTED' })).toEqual([
      '[NAVIGATION] detected previousUrl=https://a.test/ currentUrl=https://b.test/ reason=context-destroyed operation=dom-snapshot',
      '[NAVIGATION] recovering',
    ]);
    expect(navigationLogLines({ ...base, type: 'NAVIGATION_RECOVERED', retries: 1, durationMs: 40 })).toEqual(
      [
        '[NAVIGATION] DOM ready',
        '[NAVIGATION] snapshot invalidated',
        '[NAVIGATION] recovered previousUrl=https://a.test/ currentUrl=https://b.test/ retries=1 durationMs=40',
      ],
    );
    expect(
      navigationLogLines({ ...base, type: 'NAVIGATION_RECOVERY_FAILED', retries: 3, cause: DESTROYED })[0],
    ).toMatch(
      /^\[NAVIGATION_RECOVERY_FAILED\] .* retries=3 cause="page\.evaluate: Execution context was destroyed/,
    );
  });
});
