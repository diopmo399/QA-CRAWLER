import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  journeyOfParts,
  type Environment,
  type ExplorationSnapshot,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * LE CRITÈRE PRINCIPAL, de bout en bout et réellement :
 *   1. un vrai enregistrement (créer une société, la chercher, l'ouvrir), dont la saisie de création est
 *      liée à une donnée GÉNÉRÉE (company.name) et la recherche à la même donnée ;
 *   2. deux blocs publiés depuis ses groupes : le premier expose company.name (sortie générée, confirmée),
 *      le second la consomme (entrée confirmée) ;
 *   3. un parcours qui les enchaîne, vérifié (raccordement par le nom), créé en scénario ;
 *   4. deux exécutions réelles indépendantes : chacune crée UNE société avec un nom neuf, la cherche et
 *      l'ouvre avec exactement ce nom (l'application refuse les doublons ; le résultat cliqué porte le nom).
 * Puis les captures réelles : texte de l'écran, adresse, champ d'une réponse HTTP observée, recopie d'une
 * donnée, et les refus (donnée déjà dans le run, valeur absente).
 */
let app: CompanyRecordingApp;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;
const N = 'creer-puis-retrouver';

const human = async ({ page }: { page: Page }): Promise<void> => {
  const pause = (ms = 500): Promise<void> => page.waitForTimeout(ms);
  await page.getByRole('button', { name: 'New company' }).click();
  await pause();
  await page.getByLabel('Display label').fill('Company ABC');
  await page.getByLabel('Address').fill('123 Main Street');
  await pause();
  await page.getByRole('button', { name: 'Save' }).click();
  await pause(900);
  await page.getByRole('button', { name: 'Tasks' }).click();
  await pause();
  await page.getByLabel('Search companies').fill('Company ABC');
  await pause();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await pause(900);
  await page.getByRole('button', { name: 'Company ABC' }).click();
  await pause(900);
};

async function finished(started: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the replay did not finish in time'));
    }, 150_000);
    const subscription = client.explorations.subscribe(started.id, (event) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timer);
        subscription.close();
        resolve();
      }
    });
  });
  return client.explorations.status(started.id);
}

async function run(scenario: string) {
  const started = await client.executions.start(project.id, {
    environmentId: environment.id,
    scenarios: [scenario],
  });
  expect((await finished(started)).status).toBe('COMPLETED');
  return client.executions.get(project.id, started.run ?? '');
}

beforeAll(async () => {
  app = await startCompanyRecordingApp();
  app.nameLabel = 'Display label';
  app.rejectDuplicates = true;
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-block-chain-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Sociétés', targetUrl: `${app.url}/`, framework: 'other' },
  });
  environment = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 10 },
  });
  await client.recordings.start(project.id, { name: 'Créer puis retrouver' });
  await client.recordings.subscribe(project.id, N, () => undefined).done;
}, 240_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('blocks — a generated value exposed by one block, consumed by the next, in a real run', () => {
  it('binds the recorded value: generated at creation, reused by the search', async () => {
    const data = await client.data.get(project.id, N);
    const create = data.inputs.find((entry) => entry.label.includes('Display label'));
    const search = data.inputs.find((entry) => entry.label.includes('Search companies'));
    if (!create || !search)
      throw new Error(`inputs not found: ${data.inputs.map((entry) => entry.label).join(' | ')}`);
    await client.data.bind(project.id, N, {
      stepId: create.stepId,
      source: 'GENERATED',
      variable: 'company.name',
      generator: 'company',
    });
    await client.data.bind(project.id, N, {
      stepId: search.stepId,
      source: 'REFERENCE',
      variable: 'company.name',
    });
    const after = await client.data.get(project.id, N);
    expect(after.inputs.find((entry) => entry.stepId === search.stepId)).toMatchObject({
      source: 'REFERENCE',
      reference: 'company.name',
    });
  });

  it('publishes two blocks: the first exposes company.name (generated, confirmed), the second consumes it', async () => {
    const steps = (await client.recordings.studio(project.id, N)).steps;
    const save = steps.findIndex((step) => /Save/.test(step.description));
    expect(save).toBeGreaterThan(0);
    await client.groups.edit(project.id, N, {
      op: 'create',
      name: 'Créer une société',
      stepIds: steps.slice(0, save + 1).map((step) => step.id),
    });
    await client.groups.edit(project.id, N, {
      op: 'create',
      name: 'Retrouver la société',
      stepIds: steps.slice(save + 1).map((step) => step.id),
    });
    const groups = await client.groups.list(project.id, N);
    const blocks = await client.library.publishExtraction(project.id, N, {
      selection: groups.map((group) => ({ groupId: group.id })),
      mode: 'separate',
    });
    expect(blocks.map((block) => [block.name, block.state])).toEqual([
      ['Créer une société', 'VALID'],
      ['Retrouver la société', 'VALID'],
    ]);
    const [create, find] = blocks;
    const output = create?.contract.fields?.outputs.find((field) => field.key === 'company.name');
    expect(output).toMatchObject({
      origin: 'GENERATED',
      detection: 'CONFIRMED',
      generator: 'company',
      exposed: true,
    });
    expect(output?.evidence.join(' ')).toMatch(
      /générée au rejeu \(générateur company\), une fois par exécution/,
    );
    expect(output?.steps.length).toBe(1);
    const input = find?.contract.fields?.inputs.find((field) => field.key === 'company.name');
    expect(input).toMatchObject({ origin: 'INPUT', required: true, detection: 'CONFIRMED' });
    expect(input?.evidence.join(' ')).toMatch(/lue par une référence explicite/);
  });

  it('chains the blocks: the input is wired by name, then two real runs each use ONE new name, created then found', async () => {
    const journey = journeyOfParts('Créer puis retrouver une société', [
      { block: 'Créer une société', version: 1 },
      { block: 'Retrouver la société', version: 1 },
    ]);
    await client.journeys.save(project.id, journey);
    const check = await client.journeys.check(project.id, journey);
    expect(check).toMatchObject({ ok: true, publishable: 'SINGLE' });
    const [first, second] = journey.graph.nodes.filter((node) => node.kind === 'BLOCK');
    expect(check.nodes[second?.id ?? '']?.satisfied).toEqual([{ key: 'company.name', from: first?.id }]);
    expect(check.outputs.guaranteed).toContain('company.name');
    await client.journeys.publish(project.id, 'Créer puis retrouver une société');

    const before = app.names().length;
    for (const attempt of [1, 2]) {
      const detail = await run('Créer puis retrouver une société');
      expect(detail.verdict, `run ${String(attempt)}`).toBe('PASSED');
      expect(detail.flowsDetail[0]?.steps.every((step) => step.status === 'PASSED')).toBe(true);
    }
    // Deux exécutions indépendantes : deux sociétés, deux noms neufs, jamais la valeur enregistrée.
    const created = app.names().slice(before);
    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(2);
    expect(created).not.toContain('Company ABC');
  }, 360_000);
});

describe('captures — screen text, address, observed HTTP response, run data', () => {
  it('captures from the screen, the address and the search response, then cites them; conflicts are refused', async () => {
    const flows = await flowsDirOf(path.join(workspace, project.id));
    await mkdir(path.join(flows, 'capture'), { recursive: true });
    await writeFile(
      path.join(flows, 'capture', 'capture.flow.yaml'),
      `name: Capturer la fiche
startAt: /
reusable: true
steps:
  - goto: /
  - click: { role: button, name: Tasks }
  - fill: { label: Search companies, value: "\${testData:company.name}" }
  - click: { role: button, name: Search, exact: true }
    allow: MUTATION
  - capture: { as: company.apiId, response: { method: POST, url: /api/companies/search, field: items.0.id } }
  - click: { role: button, name: "\${testData:company.name}" }
  - expect: { text: "\${testData:company.name}" }
  - capture: { as: company.shown, text: { css: "#view h1" } }
  - capture: { as: company.id, url: { pattern: "/companies/(\\\\d+)" } }
  - capture: { as: company.copy, data: company.name }
  - expect: { url: "/companies/\${testData:company.apiId}" }
  - expect: { text: "\${testData:company.shown}" }
  - expect: { url: "/companies/\${testData:company.id}" }
  - expect: { text: "\${testData:company.copy}" }
`,
    );
    const library = await client.library.list(project.id);
    const block = library.find((entry) => entry.name === 'Capturer la fiche');
    expect(block?.state).toBe('VALID');
    const outputs = block?.contract.fields?.outputs ?? [];
    expect(outputs.map((field) => [field.key, field.origin, field.detection]).sort()).toEqual([
      ['company.apiId', 'CAPTURED', 'CONFIRMED'],
      ['company.copy', 'CAPTURED', 'CONFIRMED'],
      ['company.id', 'CAPTURED', 'CONFIRMED'],
      ['company.shown', 'CAPTURED', 'CONFIRMED'],
    ]);
    expect(outputs.find((field) => field.key === 'company.id')).toMatchObject({
      type: 'identifier',
      typeSource: 'INFERRED',
    });
    expect(block?.contract.inputs.map((input) => input.key)).toEqual(['company.name']);

    const journey = journeyOfParts('Créer puis capturer', [
      { block: 'Créer une société', version: 1 },
      { block: 'Capturer la fiche', version: 1 },
    ]);
    await client.journeys.save(project.id, journey);
    expect(await client.journeys.check(project.id, journey)).toMatchObject({ ok: true });
    await client.journeys.publish(project.id, 'Créer puis capturer');
    const detail = await run('Créer puis capturer');
    const steps = detail.flowsDetail[0]?.steps ?? [];
    expect(
      steps.filter((step) => step.status !== 'PASSED').map((step) => `${step.label}: ${step.reason ?? ''}`),
    ).toEqual([]);
    expect(detail.verdict).toBe('PASSED');
  }, 240_000);

  it('a capture never overwrites a value of the run, nor invents a missing one', async () => {
    const flows = await flowsDirOf(path.join(workspace, project.id));
    await mkdir(path.join(flows, 'conflict'), { recursive: true });
    await writeFile(
      path.join(flows, 'conflict', 'conflict.flow.yaml'),
      `name: Capture en conflit
startAt: /
steps:
  - goto: /
  - click: { role: button, name: Tasks }
  - capture: { as: page.title, text: { css: "#view h1" } }
  - click: { role: button, name: New company }
    allow: MUTATION
  - capture: { as: page.title, text: { css: "#view h1" } }
`,
    );
    await mkdir(path.join(flows, 'absent'), { recursive: true });
    await writeFile(
      path.join(flows, 'absent', 'absent.flow.yaml'),
      `name: Capture absente
startAt: /
steps:
  - goto: /
  - capture: { as: missing.id, url: { param: id } }
    timeoutMs: 1500
`,
    );
    const conflict = await run('Capture en conflit');
    expect(conflict.verdict).toBe('FAILED');
    expect(conflict.flowsDetail[0]?.steps.find((step) => step.status === 'FAILED')?.reason).toMatch(
      /capture page\.title failed: testData\.page\.title already has another value in this run: nothing is overwritten/,
    );
    const absent = await run('Capture absente');
    expect(absent.flowsDetail[0]?.steps.find((step) => step.status === 'FAILED')?.reason).toMatch(
      /capture missing\.id failed: the address has no parameter id/,
    );
  }, 240_000);
});

describe('the block sheet in the Dashboard (Chromium)', () => {
  it('steps by role, inputs and outputs with provenance and detection; a correction saved; an incompatible change validated', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${server.url}/dashboard`);
      const dashboard = page.locator('qa-crawler-dashboard');
      await dashboard.locator('select[data-action="project-context"]').selectOption(project.id);
      await dashboard.locator('.drawer [data-action="nav"][data-view="library"]').click();
      await dashboard.locator('[data-action="jn-tab"][data-tab="catalog"]').click();
      await dashboard.locator('.lib-tabpanel .lib-title[data-block="Capturer la fiche"]').click();
      const sheet = dashboard.locator('.lib-fiche');
      await sheet.waitFor();
      // Étapes : leur rôle (capture, vérification…).
      await sheet.locator('[data-action="lib-sheet-tab"][data-tab="steps"]').click();
      await sheet
        .locator('.pub-step', { hasText: 'capture company.id' })
        .locator('.lib-role.capture')
        .waitFor({ timeout: 15_000 });
      // Sorties : capturées, confirmées, avec la source.
      await sheet.locator('[data-action="lib-sheet-tab"][data-tab="outputs"]').click();
      const id = sheet.locator('tr[data-field="output:company.id"]');
      await expect
        .poll(() => id.innerText())
        .toMatch(/Identifiant \(proposé\)[\s\S]*Capturée[\s\S]*Confirmée/);
      // Entrées : company.name lue par une référence explicite.
      await sheet.locator('[data-action="lib-sheet-tab"][data-tab="inputs"]').click();
      const input = sheet.locator('tr[data-field="input:company.name"]');
      await expect.poll(() => input.innerText()).toMatch(/Fournie en entrée[\s\S]*Confirmée/);
      await page.keyboard.press('Escape');

      // Le bloc qui génère le nom : sa sortie, puis une correction de sa description (enregistrée, relue).
      await dashboard.locator('.lib-tabpanel .lib-title[data-block="Créer une société"]').click();
      await sheet.locator('[data-action="lib-sheet-tab"][data-tab="steps"]').click();
      await sheet.locator('.lib-role.generation').first().waitFor({ timeout: 15_000 });
      await sheet.locator('[data-action="lib-sheet-tab"][data-tab="outputs"]').click();
      const output = sheet.locator('tr[data-field="output:company.name"]');
      await expect
        .poll(() => output.innerText())
        .toMatch(/Générée au rejeu[\s\S]*company[\s\S]*v1[\s\S]*Confirmée/);
      await output.locator('[data-action="lib-field-edit"]').click();
      await sheet.locator('input[data-lib="field.label"]').fill('Nom de la société');
      await sheet.locator('input[data-lib="field.meaning"]').fill('nom de la société créée');
      await sheet.locator('[data-action="lib-field-save"]').click();
      await sheet
        .locator('.notice', { hasText: 'Donnée company.name enregistrée.' })
        .waitFor({ timeout: 15_000 });
      expect(
        (await client.library.list(project.id))
          .find((block) => block.name === 'Créer une société')
          ?.contract.fields?.outputs.find((field) => field.key === 'company.name'),
      ).toMatchObject({ label: 'Nom de la société', meaning: 'nom de la société créée', version: 1 });
      // Un changement incompatible (le sens) d'un bloc utilisé : refusé, les dépendants dits, puis validé.
      await output.locator('[data-action="lib-field-edit"]').click();
      await sheet.locator('input[data-lib="field.meaning"]').fill('raison affichée');
      await sheet.locator('[data-action="lib-field-save"]').click();
      await sheet
        .locator('.lib-fedit .err', { hasText: 'Créer puis retrouver une société' })
        .waitFor({ timeout: 15_000 });
      await sheet.locator('[data-action="lib-field-accept"]').click();
      await sheet
        .locator('.notice', { hasText: 'changement incompatible validé, version 2 de sa définition' })
        .waitFor({ timeout: 15_000 });
      await expect.poll(() => output.innerText()).toContain('v2');
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
