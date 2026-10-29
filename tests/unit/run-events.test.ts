import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunLogEvent } from '../../src/sdk/core/contracts.js';
import {
  EVENTS_FILE,
  eventLine,
  maskSecrets,
  MAX_STORED_EVENTS,
  readStoredEvents,
  RunEventLog,
} from '../../src/sdk/server/run-events.js';
import {
  countsOf,
  readTestRun,
  runDirectory,
  TestRunManager,
  type TestRunOutcome,
  type TestRunTask,
} from '../../src/sdk/server/test-runs.js';

/**
 * LE JOURNAL D'UNE EXÉCUTION, côté serveur (sans navigateur) : numéroté dans l'ordre, masqué (secrets
 * connus du run, jetons, mots de passe), écrit dans events.jsonl, borné en mémoire et sur disque, fermé
 * à la fin du run ; et le cycle de vie d'une exécution dit tel qu'il se passe (créée, démarrée, arrêt
 * demandé puis confirmé, finie). Les sources réelles : run-log-sources ; le bout en bout : sdk-run-logs.
 */
describe('run event log', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qa-run-events-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const base = { level: 'INFO', category: 'ENGINE', type: 'PHASE', source: 'engine' } as const;

  it('numbers events in order, stamps them, sends them to subscribers and writes them as JSON lines', async () => {
    const file = path.join(root, EVENTS_FILE);
    const log = new RunEventLog('tr-1', file);
    const received: RunLogEvent[] = [];
    const unsubscribe = log.subscribe((event) => received.push(event));
    log.emit({ ...base, message: 'one' });
    log.emit({ ...base, message: 'two', at: '2026-10-29T10:00:00.000Z' });
    unsubscribe();
    log.emit({ ...base, message: 'three' });
    expect(received.map((event) => event.seq)).toEqual([1, 2]);
    expect(received[1]?.at).toBe('2026-10-29T10:00:00.000Z');
    expect(received.every((event) => event.runId === 'tr-1')).toBe(true);
    expect(log.eventsAfter(1).map((event) => event.message)).toEqual(['two', 'three']);
    await log.flush();
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as RunLogEvent).seq)).toEqual([1, 2, 3]);
    expect(log.info()).toEqual({ state: 'LIVE', count: 3 });
  });

  it('masks the known secrets of the run and what looks like a secret, in the message and the data', () => {
    const log = new RunEventLog('tr-1', path.join(root, EVENTS_FILE), ['Sup3r-Secret-42']);
    const event = log.emit({
      ...base,
      message: 'typed Sup3r-Secret-42 then password=hunter2 with Authorization: Bearer abcdefghij',
      scenario: 'login Sup3r-Secret-42',
      data: { field: 'value Sup3r-Secret-42', count: 3 },
    });
    expect(JSON.stringify(event)).not.toContain('Sup3r-Secret-42');
    expect(event?.message).not.toContain('hunter2');
    expect(event?.message).not.toContain('abcdefghij');
    expect(event?.data?.count).toBe(3);
    // Les codes couleur d'un terminal (erreurs de Playwright) ne passent pas dans la page.
    expect(
      log.emit({ ...base, message: '\u001b[2mexpect(\u001b[22m\u001b[31mpage\u001b[39m) failed' })?.message,
    ).toBe('expect(page) failed');
    // Une valeur trop courte n'est pas masquée partout (trop d'homonymes) : la règle générale reste.
    expect(maskSecrets('a b c', ['b'])).toBe('a b c');
  });

  it('stops keeping events beyond the limit (and says how many), but the end of the run always passes', () => {
    const log = new RunEventLog('tr-1', path.join(root, EVENTS_FILE));
    for (let index = 0; index < MAX_STORED_EVENTS + 5; index += 1) log.emit({ ...base, message: 'x' });
    expect(log.info()).toEqual({ state: 'LIVE', count: MAX_STORED_EVENTS, dropped: 5 });
    expect(log.emit({ ...base, category: 'SYSTEM', type: 'RUN_FINISHED', message: 'end' })?.seq).toBe(
      MAX_STORED_EVENTS + 1,
    );
    // En mémoire : les derniers seulement.
    expect(log.eventsAfter(0).length).toBeLessThanOrEqual(5000);
  });

  it('a closed log receives nothing more, keeps nothing in memory, and is complete on disk', async () => {
    const file = path.join(root, EVENTS_FILE);
    const log = new RunEventLog('tr-1', file);
    for (let index = 0; index < 120; index += 1) log.emit({ ...base, message: `line ${String(index)}` });
    await log.close();
    expect(log.emit({ ...base, message: 'late' })).toBeUndefined();
    expect(log.eventsAfter(0)).toEqual([]);
    expect(log.info().state).toBe('STORED');
    const stored = await readStoredEvents(file);
    expect(stored?.length).toBe(120);
    expect((await readStoredEvents(file, { after: 100 }))?.map((event) => event.seq)[0]).toBe(101);
    expect((await readStoredEvents(file, { limit: 10 }))?.length).toBe(10);
  });

  it('a missing file is undefined (no log kept); a line cut by a crash is skipped', async () => {
    expect(await readStoredEvents(path.join(root, 'none.jsonl'))).toBeUndefined();
    const file = path.join(root, EVENTS_FILE);
    await writeFile(
      file,
      `${JSON.stringify({ seq: 1, at: 'x', runId: 'r', level: 'INFO', category: 'SYSTEM', type: 'A', message: 'a', source: 's' })}\n{"seq":2,"at`,
    );
    expect((await readStoredEvents(file))?.map((event) => event.seq)).toEqual([1]);
  });

  it('writes a readable text line: time, level, category, type, status, step and line, message, duration', () => {
    const line = eventLine({
      seq: 4,
      at: '2026-10-29T10:00:00.000Z',
      runId: 'r',
      level: 'ERROR',
      category: 'ACTION',
      type: 'STEP_FINISHED',
      status: 'FAILED',
      message: 'step 2 FAILED',
      source: 'engine',
      scenario: 'Ouvrir une fiche',
      step: 2,
      line: 25,
      durationMs: 812,
    });
    expect(line).toContain('2026-10-29T10:00:00.000Z');
    expect(line).toMatch(/ERROR\s+ACTION\s+STEP_FINISHED\s+FAILED/);
    expect(line).toContain('[Ouvrir une fiche · step 2 · line 25] step 2 FAILED (812 ms)');
  });
});

describe('run lifecycle in the log', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qa-run-life-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const task = (execute: TestRunTask['execute']): TestRunTask => ({
    projectId: 'prj_a',
    recording: 'ouvrir-une-fiche',
    format: 'yaml',
    kind: 'ENGINE',
    tool: 'QA-CRAWLER 0.2.0',
    target: 'http://127.0.0.1:9/?token=abcdef123456',
    directory: runDirectory(root),
    secrets: ['Sup3r-Secret-42'],
    execute,
  });
  const types = async (directory: string): Promise<string[]> =>
    ((await readStoredEvents(path.join(directory, EVENTS_FILE))) ?? []).map((event) => event.type);

  it('created, started, the events of the tool, finished: in this order, then the log is kept', async () => {
    const manager = new TestRunManager();
    const run = await manager.start(
      task(({ emit }) => {
        emit({
          level: 'INFO',
          category: 'ACTION',
          type: 'STEP_STARTED',
          status: 'RUNNING',
          source: 'engine',
          message: 'step 1 Sup3r-Secret-42',
          step: 1,
        });
        return Promise.resolve<TestRunOutcome>({
          status: 'PASSED',
          cases: [{ name: 'a', status: 'PASSED' }],
        });
      }),
    );
    await manager.idle(2000);
    expect(await types(run.task.directory)).toEqual([
      'RUN_CREATED',
      'RUN_STARTED',
      'STEP_STARTED',
      'RUN_FINISHED',
    ]);
    const stored = (await readStoredEvents(path.join(run.task.directory, EVENTS_FILE))) ?? [];
    expect(JSON.stringify(stored)).not.toContain('Sup3r-Secret-42');
    expect(JSON.stringify(stored)).not.toContain('abcdef123456');
    expect(stored.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      level: 'INFO',
      data: { status: 'PASSED', passed: 1 },
    });
    expect(run.view().logs).toEqual({ state: 'STORED', count: 4 });
    const persisted = await readTestRun(root, run.id, () => undefined);
    expect(persisted?.logs).toEqual({ state: 'STORED', count: 4 });
  });

  it('a stop while running: requested, then confirmed when the tool stopped; while queued: confirmed at once', async () => {
    const manager = new TestRunManager();
    const running = await manager.start(
      task(
        ({ signal }) =>
          new Promise<TestRunOutcome>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve({ status: 'CANCELLED', cases: [] });
            });
          }),
      ),
    );
    const queued = await manager.start(
      task(() => Promise.resolve<TestRunOutcome>({ status: 'PASSED', cases: [] })),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.cancel(queued.id)).toBe(true);
    expect(manager.cancel(running.id)).toBe(true);
    await manager.idle(2000);
    expect(await types(running.task.directory)).toEqual([
      'RUN_CREATED',
      'RUN_STARTED',
      'CANCEL_REQUESTED',
      'CANCEL_CONFIRMED',
      'RUN_FINISHED',
    ]);
    expect(await types(queued.task.directory)).toEqual(['RUN_CREATED', 'CANCEL_CONFIRMED', 'RUN_FINISHED']);
  });

  it('a tool that returns its result after the stop request: the stop is said unconfirmed, never a success', async () => {
    const manager = new TestRunManager();
    const run = await manager.start(
      task(
        ({ signal }) =>
          new Promise<TestRunOutcome>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve({ status: 'PASSED', cases: [{ name: 'a', status: 'PASSED' }] });
            });
          }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.cancel(run.id);
    await manager.idle(2000);
    expect(run.status).toBe('CANCELLED');
    expect(await types(run.task.directory)).toContain('CANCEL_UNCONFIRMED');
  });

  it('two runs never share their log', async () => {
    const manager = new TestRunManager();
    const emitTwice: TestRunTask['execute'] = ({ emit }) => {
      emit({ level: 'INFO', category: 'ENGINE', type: 'PHASE', source: 'engine', message: 'phase' });
      return Promise.resolve<TestRunOutcome>({ status: 'PASSED', cases: [{ name: 'a', status: 'PASSED' }] });
    };
    const first = await manager.start(task(emitTwice));
    const second = await manager.start(task(emitTwice));
    await manager.idle(2000);
    for (const run of [first, second]) {
      const stored = (await readStoredEvents(path.join(run.task.directory, EVENTS_FILE))) ?? [];
      expect(stored.every((event) => event.runId === run.id)).toBe(true);
      expect(stored.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    }
  });

  it('a run older than the console has no log: UNAVAILABLE, never an empty success', async () => {
    const directory = runDirectory(root);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'run.json'),
      JSON.stringify({ id: path.basename(directory), status: 'PASSED', cases: [], counts: countsOf([]) }),
    );
    const view = await readTestRun(root, path.basename(directory), () => undefined);
    expect(view?.logs).toEqual({ state: 'UNAVAILABLE', count: 0 });
  });
});
