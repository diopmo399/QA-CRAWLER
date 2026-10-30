import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
  type RunLogEvent,
  type TestRunInput,
  type TestRunView,
} from '../../src/sdk/core/index.js';
import { parseFlow } from '../../src/sdk/editor/flow-document.js';
import { parseFeature } from '../../src/sdk/editor/gherkin-document.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { EVENTS_FILE, RunEventLog } from '../../src/sdk/server/run-events.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { newRunId } from '../../src/sdk/server/test-runs.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LE JOURNAL D'UNE EXÉCUTION, DE BOUT EN BOUT : un parcours enregistré par le vrai recorder, généré, puis
 * joué par le vrai moteur (YAML, .feature, Dry Run), par Playwright Test et par Maven ; le journal est
 * suivi par le client du SDK comme la console de l'éditeur le fait. Rien n'est simulé : chaque
 * événement vient de l'outil qui joue le test.
 */
const NAME = 'ouvrir-une-fiche';
const SECRET = 'Tres-Secret-Valeur-77';
let site: TestSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;

const javaAvailable = spawnSync('java', ['-version']).status === 0 && spawnSync('mvn', ['-v']).status === 0;

const human: NonNullable<RecordRequest['drive']> = async ({ page }) => {
  await page.waitForTimeout(500);
  await page.getByRole('link', { name: 'Utilisateurs' }).click();
  await page.waitForURL('**/users');
  await page.waitForTimeout(500);
  await page.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await page.waitForURL('**/users/1');
  await page.waitForTimeout(500);
};

/** Lance une exécution et suit son journal jusqu'à la fin ; rend aussi le statut vu au premier début d'étape. */
async function play(
  input: TestRunInput,
  options: { onEvent?: (event: RunLogEvent, run: TestRunView) => void } = {},
): Promise<{ run: TestRunView; events: RunLogEvent[]; statusAtFirstStep?: string }> {
  const started = await client.generation.execute(project.id, NAME, input);
  const events: RunLogEvent[] = [];
  let statusAtFirstStep: string | undefined;
  let probe: Promise<void> | undefined;
  await client.generation.runEvents(project.id, NAME, started.id, (event) => {
    events.push(event);
    options.onEvent?.(event, started);
    if (!probe && /^(STEP_STARTED|ACTION_STARTED|TEST_STARTED)$/.test(event.type))
      probe = client.generation.runOf(project.id, NAME, started.id).then((view) => {
        statusAtFirstStep = view.status;
      });
  }).done;
  await probe;
  const run = await client.generation.runOf(project.id, NAME, started.id);
  return { run, events, ...(statusAtFirstStep ? { statusAtFirstStep } : {}) };
}

const ordered = (events: readonly RunLogEvent[]): boolean =>
  events.every((event, index) => index === 0 || event.seq === (events[index - 1]?.seq ?? 0) + 1);

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-run-logs-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    env: { ...process.env, QA_LOG_SECRET: SECRET },
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  const draft: ProjectDraft = {
    ...engineDefaults(),
    project: { name: 'Fiches', targetUrl: `${site.url}/`, framework: 'other' },
  };
  project = await client.projects.create(draft);
  await client.recordings.start(project.id, { name: 'Ouvrir une fiche' });
  await client.recordings.subscribe(project.id, NAME, () => undefined).done;
  await client.generation.run(project.id, NAME, {
    formats: ['yaml', 'gherkin', 'playwright', ...(javaAvailable ? (['java'] as const) : [])],
  });
}, 300_000);

afterAll(async () => {
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

const fileOf = async (suffix: string): Promise<{ path: string; content: string; revision: string }> => {
  const view = await client.generation.view(project.id, NAME);
  const file = view.files.find((entry) => entry.path.endsWith(suffix));
  if (!file?.content || !file.revision) throw new Error(`no ${suffix}`);
  return { path: file.path, content: file.content, revision: file.revision };
};

describe('run log, from the real tools', () => {
  it('YAML replay: the events arrive while the run is running, in order, step by step with their lines', async () => {
    const yaml = await fileOf('.flow.yaml');
    const lines = parseFlow(yaml.content);
    if (!lines.ok) throw new Error('flow not parsed');
    const { run, events, statusAtFirstStep } = await play({ format: 'yaml' });
    expect(run.status).toBe('PASSED');
    // En direct : le premier début d'étape est reçu alors que le moteur joue encore.
    expect(statusAtFirstStep).toBe('RUNNING');
    expect(ordered(events)).toBe(true);
    expect(events[0]).toMatchObject({ seq: 1, type: 'RUN_CREATED' });
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', data: { status: 'PASSED' } });
    expect(events.every((event) => event.runId === run.id)).toBe(true);
    const started = events.filter((event) => event.type === 'STEP_STARTED');
    expect(started.map((event) => [event.step, event.line])).toEqual(
      lines.outline.steps.map((step) => [step.position, step.line]),
    );
    const finished = events.filter((event) => event.type === 'STEP_FINISHED');
    expect(finished.map((event) => event.status)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    // Un geste n'est jamais dit fini avant d'avoir commencé.
    for (const end of finished) {
      const begin = started.find((event) => event.step === end.step);
      expect(begin && begin.seq < end.seq).toBe(true);
    }
    expect(events.some((event) => event.category === 'NETWORK' && event.step === 1)).toBe(true);
    expect(run.logs).toEqual({ state: 'STORED', count: events.length });
  }, 240_000);

  it('a cut stream resumed after its last event: nothing missing, nothing twice', async () => {
    const started = await client.generation.execute(project.id, NAME, { format: 'yaml' });
    const first: RunLogEvent[] = [];
    const subscription = client.generation.runEvents(project.id, NAME, started.id, (event) => {
      first.push(event);
      if (first.length === 5) subscription.close();
    });
    await subscription.done;
    const rest: RunLogEvent[] = [];
    await client.generation.runEvents(project.id, NAME, started.id, (event) => rest.push(event), {
      after: first.at(-1)?.seq ?? 0,
    }).done;
    const all = [...first, ...rest];
    expect(first.length).toBe(5);
    expect(ordered(all)).toBe(true);
    expect(all.at(-1)?.type).toBe('RUN_FINISHED');
  }, 240_000);

  it('a stop: requested, then confirmed by the engine; the remaining steps are not run, never passed', async () => {
    let asked = false;
    const { run, events } = await play(
      { format: 'yaml' },
      {
        onEvent: (event, current) => {
          if (!asked && event.type === 'STEP_STARTED') {
            asked = true;
            void client.generation.cancel(project.id, NAME, current.id);
          }
        },
      },
    );
    expect(run.status).toBe('CANCELLED');
    const types = events.map((event) => event.type);
    expect(types.indexOf('CANCEL_REQUESTED')).toBeLessThan(types.indexOf('CANCEL_CONFIRMED'));
    expect(types.at(-1)).toBe('RUN_FINISHED');
    const statuses = events.filter((event) => event.type === 'STEP_FINISHED').map((event) => event.status);
    expect(statuses).toContain('NOT_RUN');
    expect(statuses.filter((status) => status === 'CONFIRMED').length).toBeLessThan(3);
  }, 240_000);

  it('two runs one after the other: each log has only its own events, numbered from 1', async () => {
    const a = await client.generation.execute(project.id, NAME, { format: 'yaml' });
    const b = await client.generation.execute(project.id, NAME, { format: 'gherkin' });
    const logs = await Promise.all(
      [a, b].map(async (run) => {
        const events: RunLogEvent[] = [];
        await client.generation.runEvents(project.id, NAME, run.id, (event) => events.push(event)).done;
        return { run, events };
      }),
    );
    for (const { run, events } of logs) {
      expect(events.every((event) => event.runId === run.id)).toBe(true);
      expect(events[0]?.seq).toBe(1);
      expect(ordered(events)).toBe(true);
    }
  }, 300_000);

  it('a secret typed by a step never appears: not in the live log, the stored log, nor the downloads', async () => {
    const yaml = await fileOf('.flow.yaml');
    const document = parseDocument(yaml.content);
    const steps = document.get('steps') as { add: (value: unknown) => void };
    steps.add(document.createNode({ goto: '/forms' }));
    steps.add(document.createNode({ fill: { label: 'Mot de passe', value: { env: 'QA_LOG_SECRET' } } }));
    await client.generation.editFile(project.id, NAME, {
      path: yaml.path,
      content: document.toString({ lineWidth: 0 }),
      revision: yaml.revision,
    });
    const { run, events } = await play({ format: 'yaml' });
    expect(events.filter((event) => event.type === 'STEP_FINISHED').length).toBe(5);
    expect(events.find((event) => event.type === 'STEP_STARTED' && event.step === 5)?.message).toContain(
      'fill',
    );
    expect(JSON.stringify(events)).not.toContain(SECRET);
    const json = await client.generation.runLogs(project.id, NAME, run.id, 'json');
    const text = await client.generation.runLogs(project.id, NAME, run.id, 'text');
    expect(json.content).not.toContain(SECRET);
    expect(text.content).not.toContain(SECRET);
    expect((JSON.parse(json.content) as { events: RunLogEvent[] }).events.length).toBe(events.length);
    expect(text.content.split('\n').filter((line) => line.includes('STEP_FINISHED')).length).toBe(5);
    await client.generation.restoreFile(project.id, NAME, {
      path: yaml.path,
      revision: (await fileOf('.flow.yaml')).revision,
    });
  }, 240_000);

  it('a finished run: its log is read back without replaying anything', async () => {
    const view = await client.generation.view(project.id, NAME);
    const done = view.runs.find((run) => run.status === 'PASSED' && run.format === 'yaml');
    if (!done) throw new Error('no finished run');
    const before = (await client.generation.view(project.id, NAME)).runs.length;
    const events: RunLogEvent[] = [];
    await client.generation.runEvents(project.id, NAME, done.id, (event) => events.push(event)).done;
    expect(events.length).toBe(done.logs?.count);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect((await client.generation.view(project.id, NAME)).runs.length).toBe(before);
  });

  it('Gherkin: the steps are tied to the line of their sentence', async () => {
    const feature = await fileOf('.feature');
    const parsed = parseFeature(feature.content);
    if (!parsed.ok) throw new Error('feature not parsed');
    const lines = parsed.outline.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.line));
    const { run, events } = await play({ format: 'gherkin' });
    expect(run.status).toBe('PASSED');
    expect(events.filter((event) => event.type === 'STEP_STARTED').map((event) => event.line)).toEqual(lines);
  }, 240_000);

  it('Dry Run: each expected step is reconciled, with its position and its line', async () => {
    const yaml = await fileOf('.flow.yaml');
    const { run, events } = await play({ format: 'yaml', mode: 'DRY_RUN', path: yaml.path });
    expect(run.dryRunStatus).toBe('FULLY_MATCHED');
    const reconciled = events.filter((event) => event.type === 'STEP_RECONCILED');
    expect(reconciled.map((event) => [event.step, event.status])).toEqual([
      [1, 'CONFIRMED'],
      [2, 'CONFIRMED'],
      [3, 'CONFIRMED'],
    ]);
    expect(reconciled.every((event) => typeof event.line === 'number')).toBe(true);
    expect(events.some((event) => event.source === 'dry-run' && event.type === 'DRY_RUN_STARTED')).toBe(true);
  }, 240_000);

  it('Playwright Test: each gesture with its line and its flow step; a failing assertion says its family and line', async () => {
    const passed = await play({ format: 'playwright' });
    expect(passed.run.status).toBe('PASSED');
    const clicks = passed.events.filter(
      (event) => event.type === 'ACTION_FINISHED' && event.step !== undefined,
    );
    expect(clicks.map((event) => event.step)).toEqual([1, 2]);
    expect(clicks.every((event) => event.status === 'EXECUTED' && typeof event.line === 'number')).toBe(true);
    const spec = await fileOf('.spec.ts');
    const broken = spec.content.replace(
      'toHaveURL(new RegExp("/users/[^/]+"))',
      'toHaveURL(new RegExp("/nulle-part"))',
    );
    expect(broken).not.toBe(spec.content);
    const line = broken.split('\n').findIndex((text) => text.includes('/nulle-part')) + 1;
    await client.generation.editFile(project.id, NAME, {
      path: spec.path,
      content: broken,
      revision: spec.revision,
    });
    const failed = await play({ format: 'playwright' });
    expect(failed.run.status).toBe('FAILED');
    const error = failed.events.find(
      (event) => event.type === 'ASSERTION_FINISHED' && event.status === 'FAILED',
    );
    expect(error).toMatchObject({ level: 'ERROR', errorKind: 'ASSERTION', line, step: 2 });
    expect(failed.events.find((event) => event.type === 'TEST_FINISHED')).toMatchObject({ status: 'FAILED' });
    await client.generation.restoreFile(project.id, NAME, {
      path: spec.path,
      revision: (await fileOf('.spec.ts')).revision,
    });
  }, 300_000);

  it.skipIf(!javaAvailable)(
    'Java: the test started and finished, the driver gestures, no typed value',
    async () => {
      const { run, events } = await play({ format: 'java' });
      expect(run.status).toBe('PASSED');
      const types = events.map((event) => event.type);
      for (const type of [
        'TEST_STARTED',
        'TARGET_WAIT',
        'TARGET_RESOLVED',
        'ACTION_FINISHED',
        'TEST_FINISHED',
      ])
        expect(types).toContain(type);
      expect(events.find((event) => event.type === 'TEST_STARTED')?.scenario).toBe('Ouvrir une fiche');
      expect(events.find((event) => event.type === 'TEST_FINISHED')?.status).toBe('CONFIRMED');
    },
    300_000,
  );

  it('a run older than the console has no log: said so, the download refused', async () => {
    const recordingDir = path.join(workspace, project.id, 'qa-reports', 'recordings', NAME);
    const id = newRunId(new Date('2026-01-01T00:00:00.000Z'));
    const directory = path.join(recordingDir, 'test-runs', id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'run.json'),
      JSON.stringify({
        id,
        recording: NAME,
        format: 'yaml',
        status: 'PASSED',
        cases: [],
        counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
        output: '',
      }),
    );
    const view = await client.generation.runOf(project.id, NAME, id);
    expect(view.logs).toEqual({ state: 'UNAVAILABLE', count: 0 });
    const received: unknown[] = [];
    await client.generation.runEvents(project.id, NAME, id, (event) => received.push(event)).done;
    expect(received).toEqual([{ type: 'UNAVAILABLE', runId: id }]);
    await expect(client.generation.runLogs(project.id, NAME, id, 'json')).rejects.toMatchObject({
      status: 404,
      code: 'NO_LOGS',
    });
  });

  it('a large stored log streams whole and in order', async () => {
    const recordingDir = path.join(workspace, project.id, 'qa-reports', 'recordings', NAME);
    const id = newRunId(new Date('2026-01-02T00:00:00.000Z'));
    const directory = path.join(recordingDir, 'test-runs', id);
    await mkdir(directory, { recursive: true });
    const log = new RunEventLog(id, path.join(directory, EVENTS_FILE));
    for (let index = 0; index < 20_000; index += 1)
      log.emit({
        level: 'INFO',
        category: 'OUTPUT',
        type: 'OUTPUT',
        source: 'test',
        message: `line ${String(index)}`,
      });
    await log.close();
    await writeFile(
      path.join(directory, 'run.json'),
      JSON.stringify({
        id,
        recording: NAME,
        format: 'yaml',
        status: 'PASSED',
        cases: [],
        counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
        output: '',
        logs: log.info(),
      }),
    );
    const events: RunLogEvent[] = [];
    const started = Date.now();
    await client.generation.runEvents(project.id, NAME, id, (event) => events.push(event)).done;
    expect(events.length).toBe(20_000);
    expect(ordered(events)).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
