import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema } from '../../src/config/flow-schema.js';
import { gherkinFlows } from '../../src/flows/gherkin/gherkin-loader.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { runMission } from '../../src/orchestrator.js';
import { HumanFlowRecorder } from '../../src/recording/human-flow-recorder.js';
import type { RecordingEvent } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { generatedFlow, readGeneratedFlow } from '../helpers.js';
import { startRecordingApp, type RecordingApp } from '../fixtures/recording-app.js';

const TYPED = { firstName: 'Julieta', email: 'julieta.qa@example.test', password: 'Pw-recorded-9z!' };

/**
 * HUMAN FLOW RECORDER de bout en bout (spec §87) : Users → Add user → First name, Email,
 * Account type BUSINESS → Save → POST /api/users 201 → liste. Playwright joue l'humain.
 * Le flow généré (YAML et Gherkin, la même chose) est ensuite rejoué par le moteur des
 * flows imposés existant, puis validé par le Dry Run (REPLAY_CONFIRMED).
 */
describe('Human flow recorder (E2E)', () => {
  let app: RecordingApp;
  let dir: string;
  let outcome: RecordOutcome;
  const events: RecordingEvent[] = [];

  beforeAll(async () => {
    app = await startRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-'));
    outcome = await runRecording({
      name: 'Create business user',
      url: `${app.url}/users`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      validate: true,
      onEvent: (event) => events.push(event),
      drive: async ({ page, recorder }) => {
        // Un détour : l'onglet Reports, puis retour à Users (gardé : c'est le parcours enseigné).
        await page.getByRole('tab', { name: 'Reports' }).click();
        await page.waitForURL('**/reports');
        await page.waitForTimeout(700);
        await page.getByRole('tab', { name: 'Users' }).click();
        await page.waitForURL('**/users');
        await page.waitForTimeout(700);
        await page.getByRole('button', { name: 'Add user' }).click();
        await page.waitForURL('**/users/new');
        await page.waitForTimeout(700);
        // Une faute de frappe corrigée, en deux temps (deux saisies brutes, une seule étape).
        await page.getByLabel('First name').click();
        await page.getByLabel('First name').pressSequentially('Jul', { delay: 20 });
        await page.waitForTimeout(600);
        await page.getByLabel('First name').pressSequentially('ieta', { delay: 20 });
        await page.getByLabel('Email').click();
        await page.getByLabel('Email').pressSequentially(TYPED.email, { delay: 5 });
        await page.waitForTimeout(700);
        await page.getByLabel('Account type').selectOption('BUSINESS');
        await page.waitForTimeout(700);
        // Une case cochée puis décochée : aucune étape.
        await page.getByLabel('Newsletter').check();
        await page.waitForTimeout(300);
        await page.getByLabel('Newsletter').uncheck();
        await page.waitForTimeout(700);
        await page.getByRole('button', { name: 'Save' }).click();
        await page.waitForURL('**/users');
        await page.waitForTimeout(900);
        await recorder.checkpoint('user listed');
      },
    });
  }, 240_000);

  afterAll(async () => {
    await app.close();
  });

  it('writes every artifact of the recording', async () => {
    const files = await readdir(outcome.directory);
    for (const name of [
      'raw-recording.json',
      'semantic-recording.json',
      'recorded-flow.json',
      'generated.flow.yaml',
      'generated.feature',
      'flow-graph.json',
      'recording-events.jsonl',
      'index.html',
    ])
      expect(files).toContain(name);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'RECORDING_STARTED',
        'CHECKPOINT_ADDED',
        'RECORDING_STOPPED',
        'RECORDING_NORMALIZED',
        'OUTCOME_INFERRED',
        'FLOW_GENERATED',
        'REPLAY_VALIDATION_STARTED',
        'REPLAY_CONFIRMED',
        'RECORDING_COMPLETED',
      ]),
    );
  });

  it('generates a clean, semantic flow: no fragile selector, no keystroke, test data instead of typed values', async () => {
    const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
    const flow = generatedFlow(yaml, outcome.directory);
    expect(flow.startAt).toBe('/users');
    const steps = flow.steps.map((step) => JSON.stringify(step));
    expect(yaml).not.toMatch(/mat-input|nth-child|nth-of-type/);
    expect(flow.steps.filter((step) => step.kind === 'fill')).toHaveLength(2);
    // Les données portent l'entité écrite (POST /api/users) ; prénom et e-mail sont régénérés au rejeu.
    expect(steps.some((step) => step.includes('"testData":"user.firstName"'))).toBe(true);
    expect(steps.some((step) => step.includes('"testData":"user.email"'))).toBe(true);
    expect(flow.testData?.values['user.email']).toMatchObject({ strategy: 'GENERATE_AT_REPLAY' });
    expect(flow.testData?.values['user.firstName']).toMatchObject({ strategy: 'GENERATE_AT_REPLAY' });
    // Le littéral métier reste ; la valeur pré-remplie (Country) et la case revenue en arrière : aucune étape.
    expect(flow.steps).toContainEqual(expect.objectContaining({ kind: 'select', option: 'Business' }));
    expect(yaml).not.toMatch(/Country|Newsletter/);
    // PRESERVE FIRST : les onglets cliqués par l'humain (Reports, puis Users) restent des étapes —
    // le détour n'est retiré que par l'optimiseur séparé, jamais dans generated.flow.yaml.
    expect(
      flow.steps
        .filter((step) => step.kind === 'click' && step.target.role === 'tab')
        .map((step) => (step.kind === 'click' ? step.target.name : '')),
    ).toEqual(['Reports', 'Users']);
    expect(outcome.result.journey.summary.unaccounted).toBe(0);
    // Le clic d'envoi a le droit d'écrire ; les résultats observés sont vérifiés.
    const save = flow.steps.find(
      (step) => step.kind === 'click' && step.target.strategy === 'role' && step.target.name === 'Save',
    );
    expect(save?.allow).toEqual(['MUTATION']);
    expect(
      flow.steps.some(
        (step) =>
          step.kind === 'expect' &&
          step.expect.response?.method === 'POST' &&
          step.expect.response.url === '/api/users' &&
          step.expect.response.status === '2xx',
      ),
    ).toBe(true);
    expect(outcome.result.flow.intent.workflow).toBe('CREATE:USER');
    const quality = outcome.result.flow.quality;
    // Plus aucun détour retiré du parcours humain (seul l'optimiseur séparé en propose).
    expect(quality.removedDetours).toBe(0);
    expect(quality.mergedInputs + quality.collapsedCorrections).toBeGreaterThanOrEqual(2);
    expect(quality.fragileLocators).toBe(0);
  });

  it('YAML and Gherkin say the same thing', async () => {
    const yaml = await readGeneratedFlow(outcome.directory);
    const featureFile = path.join(outcome.directory, 'generated.feature');
    const [fromFeature] = gherkinFlows({ gherkin: featureFile }, '/').map((raw) => flowSchema.parse(raw));
    expect(fromFeature).toBeDefined();
    const shape = (steps: typeof yaml.steps): unknown[] =>
      steps.map((step) => {
        const { allow: _allow, optional: _optional, name: _name, ...rest } = step;
        return rest;
      });
    expect(shape(fromFeature?.steps ?? [])).toEqual(shape(yaml.steps));
    expect(fromFeature?.steps.some((step) => step.allow.includes('MUTATION'))).toBe(true);
  });

  it('never writes a typed value, in any artifact', async () => {
    for (const name of await readdir(outcome.directory, { recursive: true })) {
      const file = path.join(outcome.directory, name);
      if (!/\.(json|jsonl|yaml|feature|html)$/.test(file)) continue;
      const text = await readFile(file, 'utf8');
      expect(text, name).not.toContain(TYPED.firstName);
      expect(text, name).not.toContain(TYPED.email);
    }
  });

  it('the generated flow is replayed by the existing imposed-flow engine (POST /api/users 201, BUSINESS)', async () => {
    const generated = parseYaml(
      await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    // Le jeu de données du flow est à côté de lui (test-data.yaml).
    if (typeof generated.testData === 'string')
      generated.testData = path.join(outcome.directory, generated.testData);
    const missionFile = path.join(dir, 'replay-mission.yaml');
    await writeFile(
      missionFile,
      `mission: { name: replay }
target: { baseUrl: ${app.url}, startAt: /users }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'replay-reports')}, screenshotsDir: ${path.join(dir, 'replay-shots')} }
`,
      'utf8',
    );
    const { config } = parseConfig(
      `${await readFile(missionFile, 'utf8')}flows:\n  - ${JSON.stringify(generated)}\n`,
      {},
      {},
    );
    const before = app.writes.filter((write) => write.path === '/api/users' && write.status === 201).length;
    const { result } = await runMission(config, { env: {} });
    const flow = result.flows[0];
    expect(
      flow?.status,
      JSON.stringify(flow?.steps.map((step) => [step.description, step.status, step.reason])),
    ).toBe('PASSED');
    const created = app.writes.filter((write) => write.path === '/api/users' && write.status === 201);
    expect(created.length).toBe(before + 1);
    expect(created.at(-1)?.accountType).toBe('BUSINESS');
  }, 120_000);

  it('the replay validation (dry run) confirms the generated flow without modifying it', async () => {
    expect(outcome.replay.status).toBe('REPLAY_CONFIRMED');
    const html = await readFile(path.join(outcome.directory, 'index.html'), 'utf8');
    expect(html).toContain('REPLAY_CONFIRMED');
    expect(html).toContain('RAW → SEMANTIC → FINAL');
  });

  it('enriches the functional knowledge with the human-recorded workflow', async () => {
    const knowledge = path.join(dir, 'knowledge', 'functional');
    const [file] = await readdir(knowledge);
    const stored = JSON.parse(await readFile(path.join(knowledge, file ?? ''), 'utf8')) as {
      learned: { workflows: { id: string; provenance?: string; recordingSessionId?: string }[] };
    };
    expect(stored.learned.workflows).toContainEqual(
      expect.objectContaining({
        id: 'CREATE:USER',
        provenance: 'HUMAN_RECORDED',
        recordingSessionId: outcome.result.session.id,
      }),
    );
  });
});

describe('Human flow recorder: secrets and negative validation', () => {
  let app: RecordingApp;
  let dir: string;

  beforeAll(async () => {
    app = await startRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-neg-'));
  });

  afterAll(async () => {
    await app.close();
  });

  it('a sign-in typed during the recording becomes environment references, never the secret', async () => {
    const outcome = await runRecording({
      name: 'Sign in',
      url: `${app.url}/login`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      drive: async ({ page }) => {
        await page.getByLabel('Username').fill('qa-human');
        await page.getByLabel('Password').fill(TYPED.password);
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForURL('**/users');
        await page.waitForTimeout(800);
      },
    });
    const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
    expect(yaml).toContain('env: QA_USERNAME');
    expect(yaml).toContain('env: QA_PASSWORD');
    for (const name of await readdir(outcome.directory)) {
      const text = await readFile(path.join(outcome.directory, name), 'utf8');
      expect(text, name).not.toContain(TYPED.password);
      expect(text, name).not.toContain('qa-human');
    }
  }, 120_000);

  it('an invalid-then-valid cycle with a checkpoint on the error is kept as a negative validation flow', async () => {
    const outcome = await runRecording({
      name: 'Email required',
      url: `${app.url}/users/new`,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      drive: async ({ page, recorder }) => {
        await page.getByLabel('First name').fill('Someone');
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'Save' }).click();
        await page.getByText('Email is required').waitFor();
        await page.waitForTimeout(800);
        await recorder.checkpoint('email required');
        await page.getByLabel('Email').fill('someone@example.test');
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'Save' }).click();
        await page.waitForURL('**/users');
        await page.waitForTimeout(800);
      },
    });
    expect(outcome.result.flow.negative).toBe(true);
    expect(outcome.result.warnings.map((warning) => warning.code)).toContain('NEGATIVE_VALIDATION_FLOW');
    const flow = await readGeneratedFlow(outcome.directory);
    expect(flow.steps.filter((step) => step.kind === 'click')).toHaveLength(2);
    expect(flow.steps).toContainEqual(
      expect.objectContaining({ kind: 'expect', expect: { text: 'Email is required' } }),
    );
  }, 120_000);
});

describe('Human flow recorder: the page is left alone', () => {
  it('the overlay is invisible to the observer and the capture never changes what the application sees', async () => {
    const app = await startRecordingApp();
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addInitScript({
        content:
          'if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; }',
      });
      const page = await context.newPage();
      await page.goto(`${app.url}/users`);
      const { config } = parseConfig(`mission: { name: overlay }\ntarget: { baseUrl: ${app.url} }\n`, {}, {});
      const recorder = new HumanFlowRecorder({ name: 'overlay', config });
      await recorder.attach(context, page);
      // L'application voit ses propres événements, et rien n'est empêché.
      const seen = await page.evaluate(
        () =>
          new Promise<{ fired: boolean; prevented: boolean }>((resolve) => {
            const button = document.getElementById('add');
            if (!button) throw new Error('no button');
            button.onclick = (event) => {
              resolve({ fired: true, prevented: event.defaultPrevented });
            };
            button.click();
          }),
      );
      expect(seen).toEqual({ fired: true, prevented: false });
      expect(await page.locator('[data-qa-crawler-overlay]').count()).toBe(1);
      const snapshot = await new UIObserver().observe(page);
      expect(snapshot.elements.map((element) => element.name)).not.toEqual(
        expect.arrayContaining(['Stop', 'Checkpoint', 'Pause']),
      );
      expect(snapshot.textExcerpt).not.toContain('RECORDING');
      const session = await recorder.stop();
      // Un clic par script (non fiable, isTrusted=false) n'est pas une action humaine.
      expect(session.rawEvents.filter((event) => event.type === 'click')).toHaveLength(0);
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);
});

describe('Human flow recorder: stopping', () => {
  it('a value still being typed when the recording stops is kept', async () => {
    const app = await startRecordingApp();
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-record-stop-'));
    try {
      const outcome = await runRecording({
        name: 'Typing at stop',
        url: `${app.url}/users/new`,
        overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
        env: {},
        drive: async ({ page }) => {
          await page.getByLabel('Last name').click();
          await page.getByLabel('Last name').pressSequentially('Tremblay', { delay: 5 });
        },
      });
      const flow = await readGeneratedFlow(outcome.directory);
      expect(flow.steps).toContainEqual(
        expect.objectContaining({ kind: 'fill', value: { testData: 'lastName' } }),
      );
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe('Human flow recorder: unlabelled fields', () => {
  it('a field labelled only by the text before it is recorded with that text, never as "input"', async () => {
    const app = await startRecordingApp();
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-record-guess-'));
    try {
      const outcome = await runRecording({
        name: 'Branch code',
        url: `${app.url}/users/new`,
        overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
        env: {},
        drive: async ({ page }) => {
          await page.locator('#mat-input-26').fill('12345');
          await page.waitForTimeout(600);
        },
      });
      const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
      expect(yaml).toContain('field: Branch code');
      expect(yaml).not.toMatch(/field: input|mat-input/);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe('Human flow recorder: test ids', () => {
  it('a field marked data-qa is replayed through that attribute (getByTestId only reads data-testid)', async () => {
    const app = await startRecordingApp();
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-record-testid-'));
    try {
      const outcome = await runRecording({
        name: 'Reference',
        url: `${app.url}/users/new`,
        overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
        env: {},
        drive: async ({ page }) => {
          await page.locator('[data-qa="Reference_input"]').fill('ABC-1');
          await page.waitForTimeout(600);
        },
      });
      const yaml = await readFile(path.join(outcome.directory, 'generated.flow.yaml'), 'utf8');
      expect(yaml).toContain(`css: '[data-qa="Reference_input"]'`);
      const flow = generatedFlow(yaml, outcome.directory);
      const { config } = parseConfig(
        `mission: { name: replay-testid }
target: { baseUrl: ${app.url}, startAt: /users/new }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'replay')}, screenshotsDir: ${path.join(dir, 'shots')} }
flows:
  - ${JSON.stringify({ ...(parseYaml(yaml) as object), testData: path.join(outcome.directory, 'test-data.yaml') })}
`,
        {},
        {},
      );
      expect(flow.steps.length).toBeGreaterThan(0);
      const { result } = await runMission(config, { env: {} });
      expect(result.flows[0]?.status).toBe('PASSED');
    } finally {
      await app.close();
    }
  }, 120_000);
});
