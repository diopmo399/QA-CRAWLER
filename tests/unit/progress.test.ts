import { describe, expect, it } from 'vitest';
import { progressLine, terminalProgress } from '../../src/cli/progress-renderer.js';
import { logger } from '../../src/cli/logger.js';
import { ProgressTracker, type ProgressUpdate } from '../../src/progress/progress.js';

/** PROGRESS : après la dernière action, le système dit ce qu'il fait (phase, détail, temps). */
describe('ProgressTracker', () => {
  const PHASES = ['Finishing the capture', 'Building the flow', 'Writing the report'];
  const collect = (): { updates: ProgressUpdate[]; tracker: ProgressTracker; clock: { t: number } } => {
    const updates: ProgressUpdate[] = [];
    const clock = { t: 1000 };
    const tracker = new ProgressTracker(
      'Finalizing',
      PHASES,
      (update) => updates.push(update),
      () => clock.t,
    );
    return { updates, tracker, clock };
  };

  it('phases in order, a detail on the current phase, elapsed time from the first phase, then DONE', async () => {
    const { updates, tracker, clock } = collect();
    clock.t = 5000; // le temps compte à partir de la première phase, pas de la création
    tracker.start('Finishing the capture');
    clock.t = 5600;
    tracker.detail('3 pending task(s)');
    const value = await tracker.run('Building the flow', () => 42);
    expect(value).toBe(42);
    clock.t = 7000;
    tracker.done('5 step(s)');
    tracker.start('Writing the report'); // après la fin : ignoré
    expect(updates.map((u) => [u.step, u.total, u.label, u.detail, u.state, u.elapsedMs])).toEqual([
      [1, 3, 'Finishing the capture', undefined, 'RUNNING', 0],
      [1, 3, 'Finishing the capture', '3 pending task(s)', 'RUNNING', 600],
      [2, 3, 'Building the flow', undefined, 'RUNNING', 600],
      [4, 3, '5 step(s)', undefined, 'DONE', 2000],
    ]);
  });

  it('a skipped phase still advances; FAILED stops everything; a broken display never breaks the work', () => {
    const { updates, tracker } = collect();
    tracker.start('Writing the report');
    expect(updates[0]).toMatchObject({ step: 3, total: 3 });
    tracker.fail('browser crashed');
    tracker.done();
    expect(updates.map((u) => u.state)).toEqual(['RUNNING', 'FAILED']);
    const throwing = new ProgressTracker('x', PHASES, () => {
      throw new Error('display');
    });
    expect(() => {
      throwing.start('Building the flow');
    }).not.toThrow();
  });
});

describe('terminal progress', () => {
  const stream = (isTTY: boolean): { out: string[]; target: NodeJS.WriteStream } => {
    const out: string[] = [];
    const target = {
      isTTY,
      columns: 200,
      write: (chunk: string) => {
        out.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { out, target };
  };
  const update = (over: Partial<ProgressUpdate>): ProgressUpdate => ({
    task: 'Finalizing the recording',
    step: 2,
    total: 4,
    label: 'Building the flow',
    elapsedMs: 3400,
    state: 'RUNNING',
    ...over,
  });

  it('the line: task, bar, step/total, phase, detail, elapsed time', () => {
    expect(progressLine(update({ detail: '3 pending task(s)' }), '⠋')).toBe(
      '⠋ Finalizing the recording [█████░░░░░░░░░░░░░] 2/4 Building the flow — 3 pending task(s) · 3.4 s',
    );
    expect(progressLine(update({ elapsedMs: 125_000 }))).toContain('· 2 min 05 s');
  });

  it('redirected output (CI): one line per phase, no animation, a final ✓ line', () => {
    const { out, target } = stream(false);
    const renderer = terminalProgress(target, false);
    renderer.sink(update({ step: 1, label: 'Finishing the capture' }));
    renderer.sink(update({ step: 1, label: 'Finishing the capture', detail: '2 pending task(s)' }));
    renderer.sink(update({}));
    renderer.sink(update({ state: 'DONE', label: '5 step(s)', step: 5 }));
    expect(out.join('')).toBe(
      [
        '… Finalizing the recording 1/4 Finishing the capture',
        '… Finalizing the recording 2/4 Building the flow',
        '✓ Finalizing the recording — 5 step(s) (3.4 s)',
        '',
      ].join('\n'),
    );
  });

  it('interactive terminal: one line redrawn in place, cleared before an ordinary message, ✓ at the end', () => {
    const { out, target } = stream(true);
    const renderer = terminalProgress(target, true);
    renderer.sink(update({}));
    expect(out.at(-1)?.startsWith('\r\u001b[2K')).toBe(true);
    expect(out.at(-1)).toContain('2/4 Building the flow');
    const before = out.length;
    const log = console.log;
    console.log = () => undefined;
    try {
      logger.info('an event');
    } finally {
      console.log = log;
    }
    expect(out[before]).toBe('\r\u001b[2K');
    renderer.sink(update({ state: 'FAILED', label: 'browser crashed' }));
    expect(out.at(-1)).toContain('✗ Finalizing the recording — browser crashed');
    renderer.stop();
  });
});
