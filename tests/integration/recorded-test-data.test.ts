import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { runMission } from '../../src/orchestrator.js';
import type { RecordingEvent } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { readGeneratedFlow } from '../helpers.js';
import { startRequestFormApp, type RequestFormApp } from '../fixtures/request-form-app.js';

const fillValues = (steps: FlowStep[]): unknown[] =>
  steps.flatMap((step) => (step.kind === 'fill' ? [step.value] : []));

/**
 * RECORDED TEST DATA de bout en bout (§67) : l'humain crée une demande ; le flow garde ce
 * qu'il a FAIT, test-data.yaml les données qu'il a UTILISÉES. Titre et description sont
 * gardés, l'e-mail de contact est régénéré à chaque rejeu (sinon 409), le type reste INCIDENT,
 * la case « Urgent » reste une étape.
 */
describe('Recorded test data (E2E)', () => {
  let app: RequestFormApp;
  let dir: string;
  let outcome: RecordOutcome;
  const events: RecordingEvent[] = [];

  beforeAll(async () => {
    app = await startRequestFormApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-recorded-data-'));
    outcome = await runRecording({
      name: 'create request',
      url: `${app.url}/requests/new`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      onEvent: (event) => events.push(event),
      drive: async ({ page }) => {
        await page.getByLabel('Title').fill('Imprimante bureau');
        await page.waitForTimeout(500);
        await page.getByLabel('Description').fill("Impossible d'imprimer");
        await page.waitForTimeout(500);
        await page.getByLabel('Request type').selectOption('INCIDENT');
        await page.getByLabel('Contact e-mail').fill('test@example.com');
        await page.waitForTimeout(500);
        await page.getByLabel('Urgent').check();
        await page.getByRole('button', { name: 'Submit' }).click();
        await page.getByText('Request saved').waitFor();
        await page.waitForTimeout(1000);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  /** generated.flow.yaml tel qu'écrit (pour le reprendre dans une mission). */
  const rawFlow = async (): Promise<Record<string, unknown>> =>
    parseYaml(await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;

  it('§67 / §68: the flow references semantic test data; test-data.yaml says how to replay each one', async () => {
    const data = parseYaml(await readFile(path.join(outcome.directory, 'test-data.yaml'), 'utf8')) as {
      values: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(data.values.request?.title).toMatchObject({ strategy: 'recorded', value: 'Imprimante bureau' });
    expect(data.values.request?.description).toMatchObject({
      strategy: 'recorded',
      value: "Impossible d'imprimer",
    });
    expect(data.values.request?.contactEmail).toMatchObject({ strategy: 'generated', generator: 'email' });
    const flow = await readGeneratedFlow(outcome.directory);
    expect(fillValues(flow.steps)).toEqual([
      { testData: 'request.title' },
      { testData: 'request.description' },
      { testData: 'request.contactEmail' },
    ]);
    expect(flow.steps).toContainEqual(expect.objectContaining({ kind: 'select', option: 'Incident' }));
    expect(flow.steps.some((step) => step.kind === 'check')).toBe(true);
    expect(flow.testData?.values['request.title']).toMatchObject({ value: 'Imprimante bureau' });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'RECORDED_TEST_DATA_DISCOVERED',
        'TEST_DATA_KEY_RESOLVED',
        'TEST_DATA_CLASSIFIED',
        'TEST_DATA_GENERALIZED',
      ]),
    );
    const html = await readFile(path.join(outcome.directory, 'index.html'), 'utf8');
    expect(html).toContain('Recorded test data');
    expect(html).not.toContain('Imprimante');
  });

  it('§42 / §19: typed values live only in test-data.yaml (never the trace, the flow or the report); the e-mail nowhere', async () => {
    for (const file of [
      'raw-recording.json',
      'semantic-recording.json',
      'recorded-flow.json',
      'generated.flow.yaml',
      'generated.feature',
      'recording-events.jsonl',
      'index.html',
    ]) {
      const text = await readFile(path.join(outcome.directory, file), 'utf8');
      expect(text, file).not.toContain('Imprimante bureau');
      expect(text, file).not.toContain('test@example.com');
    }
    expect(await readFile(path.join(outcome.directory, 'test-data.yaml'), 'utf8')).not.toContain(
      'test@example.com',
    );
  });

  it('§30 / §31 / §32: replayed twice, the recorded values are reused, the e-mail is new each run (no 409)', async () => {
    const flow = await rawFlow();
    const replay = async (run: string): Promise<string | undefined> => {
      const { config } = parseConfig(
        `mission: { name: replay-data-${run} }
target: { baseUrl: ${app.url}, startAt: /requests/new }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 200 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, `replay-${run}`)}, screenshotsDir: ${path.join(dir, `shots-${run}`)} }
flows:
  - ${JSON.stringify({ ...flow, testData: path.join(outcome.directory, 'test-data.yaml') })}
`,
        {},
        {},
      );
      const { result } = await runMission(config, { env: {} });
      const report = result.flows[0];
      expect(
        report?.status,
        JSON.stringify(report?.steps.map((step) => [step.description, step.status, step.reason])),
      ).toBe('PASSED');
      return app.created.at(-1)?.contactEmail;
    };
    const before = app.created.length;
    const first = await replay('a');
    const second = await replay('b');
    expect(app.created.length).toBe(before + 2);
    expect(app.conflicts).toBe(0);
    for (const created of app.created.slice(before))
      expect(created).toMatchObject({
        title: 'Imprimante bureau',
        description: "Impossible d'imprimer",
        requestType: 'INCIDENT',
        urgent: true,
      });
    expect(first).toMatch(/@example\.test$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe('test@example.com');
  }, 180_000);

  it('§55: the .feature replays with the same data set (# testData: test-data.yaml)', async () => {
    const before = app.created.length;
    const { config } = parseConfig(
      `mission: { name: replay-data-feature }
target: { baseUrl: ${app.url}, startAt: /requests/new }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 200 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'replay-feature')}, screenshotsDir: ${path.join(dir, 'shots-feature')} }
flows:
  - gherkin: ${path.join(outcome.directory, 'generated.feature')}
`,
      {},
      {},
    );
    expect(config.flows[0]?.testData?.values['request.title']).toMatchObject({ value: 'Imprimante bureau' });
    const { result } = await runMission(config, { env: {} });
    const report = result.flows[0];
    expect(
      report?.status,
      JSON.stringify(report?.steps.map((step) => [step.description, step.status, step.reason])),
    ).toBe('PASSED');
    expect(app.created.length).toBe(before + 1);
    expect(app.created.at(-1)).toMatchObject({ title: 'Imprimante bureau', requestType: 'INCIDENT' });
  }, 120_000);

  it('§41: a recorded e-mail reused verbatim is answered 409: a traced strategy suggestion, never a silent change', async () => {
    const flow = await rawFlow();
    const dataFile = path.join(dir, 'fixed-data.yaml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      dataFile,
      `values:\n  request:\n    title: { strategy: recorded, value: Imprimante bureau }\n    description: { strategy: recorded, value: "Impossible d'imprimer" }\n    contactEmail: { strategy: recorded, value: fixed@example.test }\n`,
      'utf8',
    );
    const replay = async (run: string) => {
      const { config } = parseConfig(
        `mission: { name: replay-fixed-${run} }
target: { baseUrl: ${app.url}, startAt: /requests/new }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 200 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, `fixed-${run}`)}, screenshotsDir: ${path.join(dir, `fixed-shots-${run}`)} }
flows:
  - ${JSON.stringify({ ...flow, testData: dataFile })}
`,
        {},
        {},
      );
      return (await runMission(config, { env: {} })).result.flows[0];
    };
    await replay('1');
    const second = await replay('2');
    expect(app.conflicts).toBeGreaterThan(0);
    expect(second?.testDataSuggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('testData.request.contactEmail: RECORDED_LITERAL → GENERATE_AT_REPLAY'),
      ]),
    );
  }, 180_000);
});
