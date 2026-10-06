import { describe, expect, it } from 'vitest';
import { CopilotClientManager } from '../../src/ai/copilot/client-manager.js';
import type { CopilotSdkModule } from '../../src/ai/copilot/sdk.js';
import { intelligenceActivity } from '../../src/cli/intelligence-activity.js';
import { progressLine } from '../../src/cli/progress-renderer.js';
import type { ProgressUpdate } from '../../src/progress/progress.js';

/** Le conseiller d'intelligence n'a jamais l'air bloqué : l'attente se voit, sa fin aussi. */
describe('intelligence activity in the terminal', () => {
  const collect = (): {
    updates: ProgressUpdate[];
    activity: ReturnType<typeof intelligenceActivity>;
    clock: { t: number };
  } => {
    const updates: ProgressUpdate[] = [];
    const clock = { t: 0 };
    const activity = intelligenceActivity(
      (update) => updates.push(update),
      () => undefined,
      () => clock.t,
    );
    return { updates, activity, clock };
  };

  it('an answer: an animated waiting line (trigger, elapsed time), then « answer received from <model> »', () => {
    const { updates, activity, clock } = collect();
    activity.onIntelligence({
      event: 'AI_REQUEST_CREATED',
      message: 'REQ-1 TARGET_NOT_FOUND: 12 action(s), 3 evidence',
    });
    clock.t = 4200;
    activity.onIntelligence({ event: 'AI_SESSION_CREATED', message: 'copilot ready' });
    activity.onIntelligence({ event: 'AI_PROPOSAL_RECEIVED', message: 'REQ-1 from model-x' });
    expect(updates.map((u) => [u.state, u.label, u.detail, u.elapsedMs])).toEqual([
      ['RUNNING', 'waiting for the answer (TARGET_NOT_FOUND)', undefined, 0],
      ['RUNNING', 'waiting for the answer (TARGET_NOT_FOUND)', 'copilot ready', 4200],
      ['DONE', 'answer received from model-x', undefined, 4200],
    ]);
    expect(progressLine(updates[1] as ProgressUpdate, '⠋')).toBe(
      '⠋ Intelligence advisor — waiting for the answer (TARGET_NOT_FOUND) — copilot ready · 4.2 s',
    );
  });

  it('a timeout or an unavailable advisor ends the line as a failure (the run goes on); nothing to end: nothing shown', () => {
    const { updates, activity } = collect();
    activity.onIntelligence({ event: 'AI_PROPOSAL_RECEIVED', message: 'late' });
    expect(updates).toHaveLength(0);
    activity.onIntelligence({ event: 'AI_REQUEST_CREATED', message: 'REQ-2 BLOCKED_GOAL: 1 action(s)' });
    activity.onIntelligence({ event: 'AI_TIMEOUT', message: 'REQ-2: no answer within 30000 ms' });
    activity.onIntelligence({ event: 'AI_REQUEST_CREATED', message: 'REQ-3 BLOCKED_GOAL: 1 action(s)' });
    activity.onIntelligence({ event: 'AI_UNAVAILABLE', message: 'copilot: not authenticated' });
    expect(updates.filter((u) => u.state === 'FAILED').map((u) => u.label)).toEqual([
      'no answer in time: no answer within 30000 ms',
      'unavailable: not authenticated',
    ]);
  });
});

describe('closing the intelligence client never blocks the end of the run', () => {
  const sdk = (stop: () => Promise<unknown>, calls: string[]): CopilotSdkModule => ({
    CopilotClient: class {
      start(): Promise<void> {
        return Promise.resolve();
      }
      stop(): Promise<unknown> {
        calls.push('stop');
        return stop();
      }
      forceStop(): Promise<void> {
        calls.push('forceStop');
        return Promise.resolve();
      }
      getAuthStatus(): Promise<{ isAuthenticated: boolean }> {
        return Promise.resolve({ isAuthenticated: true });
      }
      listModels(): Promise<never[]> {
        return Promise.resolve([]);
      }
      createSession(): Promise<never> {
        return Promise.reject(new Error('unused'));
      }
    },
  });

  it('a runtime that never stops is force-stopped after the delay; a normal stop is not forced', async () => {
    const calls: string[] = [];
    const hanging = new CopilotClientManager({
      baseDirectory: '/tmp/qa-copilot-close',
      env: {},
      startTimeoutMs: 1000,
      loadSdk: () => Promise.resolve(sdk(() => new Promise(() => undefined), calls)),
    });
    expect(await hanging.isAvailable()).toBe(true);
    const started = Date.now();
    await hanging.close(80);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toEqual(['stop', 'forceStop']);

    const normal: string[] = [];
    const manager = new CopilotClientManager({
      baseDirectory: '/tmp/qa-copilot-close',
      env: {},
      startTimeoutMs: 1000,
      loadSdk: () => Promise.resolve(sdk(() => Promise.resolve([]), normal)),
    });
    await manager.isAvailable();
    await manager.close(80);
    expect(normal).toEqual(['stop']);
  });
});
