import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDryRun } from '../../src/dry-run/dry-run-orchestrator.js';
import type { HumanReviewLedger } from '../../src/recording/application/human-review.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * LIAISON EXPLICITE DES DONNÉES, dans la vraie fenêtre du recorder. Le champ de création a un libellé
 * neutre (« Display label ») : rien ne dit que c'est le nom de la société, la valeur saisie
 * (« Company ABC ») resterait telle quelle. L'humain choisit : création → GÉNÉRER company.name ;
 * recherche → RÉUTILISER company.name. Au rejeu, contre une application qui refuse les doublons :
 * un nouveau nom, saisi à la création, recherché, et le résultat qui le porte est ouvert.
 */
describe('Recording — explicit test data binding between steps (recorder window + replay)', () => {
  let app: CompanyRecordingApp;
  let dir = '';
  let recorded = '';
  const ui: Record<string, string> = {};

  const stepRow = (panel: Page, text: string) => panel.locator('li[data-step]', { hasText: text }).first();

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    app.nameLabel = 'Display label';
    app.rejectDuplicates = true;
    dir = await mkdtemp(path.join(tmpdir(), 'qa-binding-'));
    const missionFile = path.join(dir, 'binding.mission.yaml');
    await writeFile(
      missionFile,
      `mission: { name: binding }\ntarget: { baseUrl: ${app.url}, startAt: / }\nsafety:\n  mutations: { enabled: true, maxPerRun: 20 }\n`,
    );
    const outcome = await runRecording({
      name: 'create-and-find',
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page }) => {
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
      },
      reviewDriver: async ({ panel }) => {
        await panel.getByText('Enregistrement terminé', { exact: true }).waitFor({ timeout: 60_000 });
        // 1. La saisie de création : GÉNÉRER une variable nommée par l'humain.
        await stepRow(panel, 'Display label').click();
        await panel.getByRole('button', { name: 'Modifier la source de la valeur' }).click();
        const block = panel.locator('.databind');
        await block.waitFor();
        ui.createBefore = await block.innerText();
        await block.getByLabel('Générer une nouvelle valeur').check();
        await block.locator('input[data-bind-field="variable"]').fill('company.name');
        await block.locator('select[data-bind-field="generator"]').selectOption('company');
        await block.getByRole('button', { name: 'Enregistrer la source' }).click();
        await panel
          .locator('#details .box')
          .getByText(/Choix explicite/)
          .waitFor();
        // 2. La saisie de recherche : RÉUTILISER la variable produite à l'étape de création.
        await stepRow(panel, 'Search companies').click();
        await panel.getByRole('button', { name: 'Modifier la source de la valeur' }).click();
        await panel.locator('.databind').getByLabel('Réutiliser une donnée existante').check();
        const search = panel.locator('.databind');
        ui.searchOptions = await search.locator('.dref').innerText();
        await search.locator('input[name^="dref-"][value="company.name"]').check();
        await search.getByRole('button', { name: 'Enregistrer la source' }).click();
        await panel
          .locator('#details .box')
          .getByText(/Choix explicite/)
          .waitFor();
        ui.searchAfter = await panel.locator('#details .box').innerText();
        // La carte « Intents métier » suit la liaison : le critère cite la variable choisie, pas la clé abandonnée.
        await panel.getByRole('tab', { name: 'Analyse' }).click();
        await panel.locator('.search').first().waitFor({ timeout: 30_000 });
        ui.searchIntent = await panel.locator('.search').first().innerText();
        await panel.getByRole('tab', { name: /^Parcours/ }).click();
        // 3. La première saisie ne peut rien réutiliser (aucune donnée produite avant elle).
        await stepRow(panel, 'Display label').click();
        await panel.getByRole('button', { name: 'Modifier la source de la valeur' }).click();
        await panel.locator('.databind').getByLabel('Réutiliser une donnée existante').check();
        ui.firstReuse = await panel.locator('.databind').innerText();
        // 4. La lignée, dans l'onglet Données de test.
        await panel.getByRole('tab', { name: /^Données de test/ }).click();
        await panel.locator('#data-lineage').waitFor({ timeout: 30_000 });
        ui.lineage = await panel.locator('#data-lineage').innerText();
      },
    });
    recorded = outcome.directory;
  }, 240_000);

  afterAll(async () => {
    await app.close();
  });

  it('the window offers the three sources; only data produced BEFORE a step can be reused', () => {
    expect(ui.createBefore).toMatch(
      /Valeur enregistrée[\s\S]*Générer une nouvelle valeur[\s\S]*Réutiliser une donnée existante/,
    );
    expect(ui.searchOptions).toMatch(/company\.name[\s\S]*Étape \d+/);
    expect(ui.searchAfter).toMatch(/Choix explicite/);
    expect(ui.firstReuse).toContain('Aucune donnée de test disponible.');
    expect(ui.searchIntent).toContain('${testData.company.name}');
    expect(ui.searchIntent).not.toContain('search.q');
    expect(ui.lineage).toMatch(
      /company\.name[\s\S]*générée \(company\)[\s\S]*produite à l’étape[\s\S]*utilisée par/,
    );
  });

  it('the files: one variable generated, reused by the search, cited by the OPEN click — never the demo value', async () => {
    const data = parseYaml(await readFile(path.join(recorded, 'test-data.yaml'), 'utf8')) as {
      values: Record<string, Record<string, { strategy: string; generator?: string }>>;
    };
    expect(data.values.company?.name).toMatchObject({ strategy: 'generated', generator: 'company' });
    const yaml = await readFile(path.join(recorded, 'generated.flow.yaml'), 'utf8');
    const flow = parseYaml(yaml) as { steps: Record<string, unknown>[] };
    const fills = flow.steps.filter((step) => 'fill' in step).map((step) => step.fill);
    expect(fills).toContainEqual({ label: 'Display label', value: { testData: 'company.name' } });
    expect(fills).toContainEqual({ label: 'Search companies', value: { testData: 'company.name' } });
    expect(flow.steps.map((step) => (step.click as { name?: string } | undefined)?.name)).toContain(
      '${testData:company.name}',
    );
    expect(yaml).not.toContain('Company ABC');
    const ledger = JSON.parse(
      await readFile(path.join(recorded, 'human-review.json'), 'utf8'),
    ) as HumanReviewLedger;
    expect(ledger.bindings?.map((decision) => `${decision.source}:${decision.variable}`)).toEqual([
      'GENERATED:company.name',
      'REFERENCE:company.name',
    ]);
    const report = await readFile(path.join(recorded, 'index.html'), 'utf8');
    expect(report).toContain('Test data lineage');
  });

  it('replay: a NEW generated name is created, searched with exactly that value and its result opened', async () => {
    const before = app.names().length;
    const scenarioFile = path.join(dir, 'replay.flow.yaml');
    await copyFile(path.join(recorded, 'generated.flow.yaml'), scenarioFile);
    await copyFile(path.join(recorded, 'test-data.yaml'), path.join(dir, 'test-data.yaml'));
    const outcome = await runDryRun({
      scenarioFile,
      missionFile: path.join(dir, 'binding.mission.yaml'),
      overrides: { headless: true, reportsDir: path.join(dir, 'replay') },
      env: {},
      useHistory: false,
      isolatedMemory: true,
      outputFormat: 'yaml',
    });
    expect(outcome.status).toBe('FULLY_MATCHED');
    const created = app.names().slice(before);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/QA-CRAWLER-/);
    // La valeur de la démonstration n'a pas été réutilisée (une seule « Company ABC », celle de l'enregistrement).
    expect(app.names().filter((name) => name === 'Company ABC')).toHaveLength(1);
  });
});
