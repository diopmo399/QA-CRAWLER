import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestRunView } from '../../src/sdk/core/contracts.js';
import {
  countsOf,
  junitCases,
  listTestRuns,
  newRunId,
  readTestRun,
  runDirectory,
  TEST_RUN_ID,
  TestRunManager,
  verdictOf,
  type TestRunOutcome,
  type TestRunTask,
} from '../../src/sdk/server/test-runs.js';

/**
 * LES EXÉCUTIONS DES TESTS GÉNÉRÉS (sans navigateur) : la lecture du JUnit XML de Playwright Test et de
 * Surefire, le verdict qui ne déclare jamais réussi un ensemble vide, la file (une exécution à la fois,
 * annulation en file et en cours) et run.json relu après un arrêt du serveur. L'exécution réelle (moteur,
 * Playwright Test, Maven) : sdk-generated-test-runs (intégration).
 */
const PLAYWRIGHT_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites id="" name="" tests="3" failures="1" skipped="1" errors="0" time="4.2">
<testsuite name="ouvrir-une-fiche.spec.ts" timestamp="2026-10-28T10:00:00.000Z" hostname="chromium" tests="3" failures="1" skipped="1" time="4.2" errors="0">
<testcase name="ouvrir une fiche" classname="ouvrir-une-fiche.spec.ts" time="1.25">
</testcase>
<testcase name="modifier &amp; enregistrer" classname="ouvrir-une-fiche.spec.ts" time="2.5">
<failure message="ouvrir-une-fiche.spec.ts:12:5 locator.click: Timeout 5000ms exceeded" type="FAILURE">
<![CDATA[  Error: locator.click: Timeout 5000ms exceeded.]]>
</failure>
</testcase>
<testcase name="supprimer" classname="ouvrir-une-fiche.spec.ts" time="0">
<skipped/>
</testcase>
</testsuite>
</testsuites>`;

const SUREFIRE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.qa.OuvrirUneFicheTest" tests="2" errors="1" skipped="0" failures="0">
  <testcase name="ouvrirUneFiche" classname="com.example.qa.OuvrirUneFicheTest" time="3.1"/>
  <testcase name="verifierTitre" classname="com.example.qa.OuvrirUneFicheTest" time="0.4">
    <error type="java.lang.AssertionError">expected title &lt;Fiche&gt; but was &lt;Accueil&gt;</error>
  </testcase>
</testsuite>`;

describe('JUnit XML', () => {
  it('reads Playwright Test: passed, failed with its message, skipped; durations in ms', () => {
    const cases = junitCases(PLAYWRIGHT_JUNIT);
    expect(cases).toEqual([
      { name: 'ouvrir une fiche', status: 'PASSED', durationMs: 1250 },
      {
        name: 'modifier & enregistrer',
        status: 'FAILED',
        durationMs: 2500,
        message: 'Error: locator.click: Timeout 5000ms exceeded.',
      },
      { name: 'supprimer', status: 'SKIPPED', durationMs: 0 },
    ]);
    expect(countsOf(cases)).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(verdictOf(cases)).toBe('FAILED');
  });

  it('reads Surefire: an <error> is a failure, its text is the message, the class names the case', () => {
    const cases = junitCases(SUREFIRE);
    expect(cases[0]).toEqual({
      name: 'OuvrirUneFicheTest › ouvrirUneFiche',
      status: 'PASSED',
      durationMs: 3100,
    });
    expect(cases[1]).toMatchObject({
      status: 'FAILED',
      message: 'expected title <Fiche> but was <Accueil>',
    });
  });

  it('never declares an empty or all-skipped report passed', () => {
    expect(junitCases('<testsuites tests="0"></testsuites>')).toEqual([]);
    expect(verdictOf([])).toBe('ERROR');
    expect(verdictOf([{ name: 'a', status: 'SKIPPED' }])).toBe('ERROR');
    expect(
      verdictOf([
        { name: 'a', status: 'PASSED' },
        { name: 'b', status: 'BLOCKED' },
      ]),
    ).toBe('FAILED');
    expect(
      verdictOf([
        { name: 'a', status: 'PASSED' },
        { name: 'b', status: 'MANUAL' },
      ]),
    ).toBe('PASSED');
  });

  it('truncates a long message and masks what looks like a secret', () => {
    const long = 'x'.repeat(2000);
    const [entry] = junitCases(`<testcase name="a"><failure message="${long}"/></testcase>`);
    expect(entry?.message?.length).toBeLessThanOrEqual(500);
    const [secret] = junitCases(
      '<testcase name="a"><failure message="login failed with password=hunter2-very-secret"/></testcase>',
    );
    expect(secret?.message).not.toContain('hunter2-very-secret');
  });
});

describe('test run queue', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qa-test-runs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const task = (execute: TestRunTask['execute'], directory = runDirectory(root)): TestRunTask => ({
    projectId: 'prj_a',
    recording: 'ouvrir-une-fiche',
    format: 'playwright',
    kind: 'EXTERNAL',
    tool: 'Playwright Test 1.56.1',
    target: 'http://127.0.0.1:9',
    directory,
    execute,
  });

  it('names a run directory with a sortable identifier', () => {
    const id = newRunId(new Date('2026-10-28T10:00:00.000Z'));
    expect(id).toMatch(TEST_RUN_ID);
    expect(id.startsWith('tr-2026-10-28T10-00-00-000Z-')).toBe(true);
  });

  it('runs one at a time, writes run.json at each step, and keeps the outcome of the tool', async () => {
    const manager = new TestRunManager();
    let release: (outcome: TestRunOutcome) => void = () => undefined;
    const first = await manager.start(
      task(
        ({ log }) =>
          new Promise<TestRunOutcome>((resolve) => {
            log('1 passed\n');
            release = resolve;
          }),
      ),
    );
    const second = await manager.start(
      task(() =>
        Promise.resolve<TestRunOutcome>({
          status: 'FAILED',
          cases: [{ name: 'b', status: 'FAILED', message: 'boom' }],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.status).toBe('RUNNING');
    expect(second.status).toBe('QUEUED');
    release({ status: 'PASSED', cases: [{ name: 'a', status: 'PASSED', durationMs: 10 }] });
    expect(await manager.idle(2000)).toBe(true);
    expect(first.view()).toMatchObject({
      status: 'PASSED',
      counts: { passed: 1, total: 1 },
      output: '1 passed\n',
    });
    expect(second.view()).toMatchObject({ status: 'FAILED', counts: { failed: 1 } });
    const persisted = JSON.parse(
      await readFile(path.join(first.task.directory, 'run.json'), 'utf8'),
    ) as TestRunView;
    expect(persisted).toMatchObject({ id: first.id, status: 'PASSED', tool: 'Playwright Test 1.56.1' });
  });

  it('cancels a queued run (never started) and a running one (the tool receives the signal)', async () => {
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
    let started = false;
    const queued = await manager.start(
      task(() => {
        started = true;
        return Promise.resolve<TestRunOutcome>({
          status: 'PASSED',
          cases: [{ name: 'a', status: 'PASSED' }],
        });
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.cancel(queued.id)).toBe(true);
    expect(manager.cancel(running.id)).toBe(true);
    expect(await manager.idle(2000)).toBe(true);
    expect(started).toBe(false);
    expect(queued.status).toBe('CANCELLED');
    expect(running.status).toBe('CANCELLED');
    expect(manager.cancel(running.id)).toBe(false);
  });

  it('a tool that throws gives ERROR with its message, never PASSED', async () => {
    const manager = new TestRunManager();
    const run = await manager.start(task(() => Promise.reject(new Error('spawn failed'))));
    await manager.idle(2000);
    expect(run.view()).toMatchObject({ status: 'ERROR', message: 'spawn failed' });
  });

  it('lists the runs from disk, most recent first; a run left RUNNING by a stopped server reads ERROR', async () => {
    const older = runDirectory(root, newRunId(new Date('2026-10-27T10:00:00.000Z')));
    const newer = runDirectory(root, newRunId(new Date('2026-10-28T10:00:00.000Z')));
    for (const [directory, status] of [
      [older, 'PASSED'],
      [newer, 'RUNNING'],
    ] as const) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'run.json'),
        JSON.stringify({ id: path.basename(directory), status, cases: [], counts: countsOf([]) }),
      );
    }
    await mkdir(path.join(root, 'test-runs', 'not-a-run'), { recursive: true });
    const runs = await listTestRuns(root, () => undefined);
    expect(runs.map((run) => run.id)).toEqual([path.basename(newer), path.basename(older)]);
    expect(runs[0]?.status).toBe('ERROR');
    expect(runs[0]?.message).toContain('interrupted');
    expect(await readTestRun(root, '../../etc', () => undefined)).toBeUndefined();
  });
});
