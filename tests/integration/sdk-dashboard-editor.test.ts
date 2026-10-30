import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * L'ÉDITEUR DES TESTS GÉNÉRÉS DANS CHROMIUM, sur un vrai serveur SDK, avec un parcours du vrai recorder :
 * la vue visuelle du flow YAML et son inspecteur, la source CodeMirror qui suit, le déplacement d'une
 * étape au clavier, l'enregistrement vérifié (Ctrl+S), la comparaison avec la version générée, une source
 * cassée refusée avec un diagnostic qui mène à sa ligne, la restauration, le .feature et sa phrase
 * inconnue, le plan d'un test Playwright, un vrai Dry Run du moteur, la garde des modifications non
 * enregistrées, le clavier dans l'explorateur, et le téléphone.
 */
const NAME = 'ouvrir-une-fiche';
const YAML = `${NAME}.flow.yaml`;
const FEATURE = `${NAME}.feature`;
const SPEC = `playwright/${NAME}.spec.ts`;
let site: TestSite;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const editor = (): Locator => dashboard().locator('.ed');
const steps = (): Locator => editor().locator('.ed-visual .ed-step');
const mavenAvailable = spawnSync('mvn', ['-v']).status === 0 && spawnSync('java', ['-version']).status === 0;

const human: NonNullable<RecordRequest['drive']> = async ({ page: recorded }) => {
  const pause = (): Promise<void> => recorded.waitForTimeout(500);
  await pause();
  await recorded.getByRole('link', { name: 'Utilisateurs' }).click();
  await recorded.waitForURL('**/users');
  await pause();
  await recorded.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
  await recorded.waitForURL('**/users/1');
  await pause();
};

/**
 * Le texte de l'éditeur de code, lu dans son état (il ne dessine que les lignes visibles). Une expression
 * en texte : le module du kit est importé par la page, tel que le Dashboard le charge.
 */
const sourceText = (): Promise<string> =>
  page.evaluate(`(async () => {
    const dom = document.querySelector('qa-crawler-dashboard').shadowRoot.querySelector('.cm-editor');
    const kit = await import('/sdk/ui/editor-kit.js');
    return kit.editorText(dom) ?? '';
  })()`);
const savedContent = async (file: string): Promise<string> =>
  (await client.generation.view(project.id, NAME)).files.find((entry) => entry.path === file)?.content ?? '';
const chip = (text: string): Locator => editor().locator('.ed-top .ed-chip', { hasText: text });

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-dash-editor-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Fiches', targetUrl: `${site.url}/`, framework: 'other' },
  });
  await client.recordings.start(project.id, { name: 'Ouvrir une fiche' });
  await client.recordings.subscribe(project.id, NAME, () => undefined).done;
  await client.generation.run(project.id, NAME, {
    formats: ['yaml', 'gherkin', 'playwright', ...(mavenAvailable ? (['java'] as const) : [])],
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${server.url}/dashboard`);
  await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard().locator('.drawer [data-action="nav"][data-view="tests"]').click();
  await dashboard().locator('h1', { hasText: 'Tests générés' }).waitFor({ timeout: 15_000 });
}, 600_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Dashboard — generated test editor in Chromium', () => {
  it('opens from the Tests screen on the flow YAML: visual view, explorer, tab, honest status', async () => {
    await dashboard().locator('.hd [data-action="tst-open-editor"]').click();
    await steps().first().waitFor({ timeout: 30_000 });
    expect(await steps().count()).toBe(3);
    expect(await steps().nth(0).textContent()).toContain('Cliquer sur le lien « Utilisateurs »');
    expect(await editor().locator('.ed-tab.on').textContent()).toContain(YAML);
    expect(
      await editor().locator('[data-action="ed-mode"][data-mode="visual"]').getAttribute('aria-checked'),
    ).toBe('true');
    await chip('Enregistré').waitFor();
    // Vérifié à la génération : une vérification statique, jamais présentée comme un succès d'exécution.
    expect(await chip('Vérifié statiquement').getAttribute('title')).toContain('ne prouve pas');
    const tree = await editor().locator('.ed-tree [role="treeitem"]').allTextContents();
    expect(tree.join('|')).toContain(FEATURE);
    expect(tree.join('|')).toContain(`${NAME}.spec.ts`);
    expect(await editor().locator('[data-action="ed-save"]').isDisabled()).toBe(true);
  });

  it('edits a step in the inspector: the visual view, the source and the unsaved state follow, comments kept', async () => {
    const original = await savedContent(YAML);
    await steps().nth(1).locator('.ed-sm').click();
    await editor().locator('.ed-inspector h3', { hasText: 'Étape 2' }).waitFor();
    const name = editor().locator('.ed-inspector [data-ed-field="name"]');
    await name.fill('Ouvrir la fiche du premier utilisateur');
    await name.press('Enter');
    await expect.poll(() => steps().nth(1).textContent()).toContain('Ouvrir la fiche du premier utilisateur');
    await chip('Modifications non enregistrées').waitFor();
    expect(await editor().locator('.ed-tab.on .ed-dot').count()).toBe(1);
    await editor().locator('[data-action="ed-mode"][data-mode="source"]').click();
    await editor().locator('.cm-editor').waitFor({ timeout: 30_000 });
    const source = await sourceText();
    expect(source).toContain('name: Ouvrir la fiche du premier utilisateur');
    // Les commentaires de provenance sont tous là.
    for (const comment of original.split('\n').filter((line) => line.trim().startsWith('#')))
      expect(source).toContain(comment.trim());
    await editor().locator('[data-action="ed-mode"][data-mode="visual"]').click();
  });

  it('moves a step with Alt+arrow, then back with the arrow button', async () => {
    await steps().nth(1).locator('.ed-sm').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => steps().nth(0).textContent()).toContain('Ouvrir la fiche du premier utilisateur');
    await steps().nth(0).locator('[data-action="ed-move"][data-to="1"]').click();
    await expect.poll(() => steps().nth(1).textContent()).toContain('Ouvrir la fiche du premier utilisateur');
  });

  it('saves with Ctrl+S: checked by the server, marked edited by hand, compared with the generated version', async () => {
    await steps().nth(1).locator('.ed-sm').focus();
    await page.keyboard.press('Control+s');
    await editor().locator('.ed-note.ok', { hasText: 'enregistré et vérifié' }).waitFor({ timeout: 30_000 });
    await chip('Modifié à la main').waitFor();
    expect(await savedContent(YAML)).toContain('name: Ouvrir la fiche du premier utilisateur');
    await editor().locator('.ed-top [data-action="ed-compare"]').click();
    await editor().locator('.ed-diff .cm-mergeView').waitFor({ timeout: 30_000 });
    expect(await editor().locator('select[data-ed="compare-left"]').inputValue()).toBe('generated');
    expect(await editor().locator('.ed-sum').textContent()).toContain('+1');
    expect(await editor().locator('.ed-diff .cm-changedLine').count()).toBeGreaterThan(0);
  });

  it('a broken source: Check lists it with its line, a click goes to the line, saving is refused and nothing written', async () => {
    await editor().locator('[data-action="ed-mode"][data-mode="source"]').click();
    await editor().locator('.cm-editor').waitFor();
    const saved = await savedContent(YAML);
    const broken = saved.replace(
      '      role: link\n      name: Utilisateurs\n',
      '      role: link\n      label: Utilisateurs\n',
    );
    expect(broken).not.toBe(saved);
    await editor().locator('.cm-content').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(broken);
    await chip('Modifications non enregistrées').waitFor();
    await editor().locator('.ed-top [data-action="ed-check"]').click();
    const problem = editor().locator('.ed-panel .ed-dcat', { hasText: 'Schéma' }).locator('button').first();
    await problem.waitFor({ timeout: 60_000 });
    expect(await problem.textContent()).toMatch(/ligne \d+ · étape 1/);
    const line = Number(/ligne (\d+)/.exec((await problem.textContent()) ?? '')?.[1]);
    await editor().locator('.cm-editor').locator('.cm-lineNumbers .cm-activeLineGutter').waitFor();
    await problem.click();
    await expect
      .poll(() => editor().locator('.cm-lineNumbers .cm-activeLineGutter').textContent())
      .toBe(String(line));
    // La marge de l'éditeur porte le problème.
    expect(await editor().locator('.cm-lint-marker-error').count()).toBeGreaterThan(0);
    await editor().locator('.ed-top [data-action="ed-save"]').click();
    await editor()
      .locator('.ed-note.err', { hasText: 'ne passe pas sa vérification' })
      .waitFor({ timeout: 60_000 });
    expect(await savedContent(YAML)).toBe(saved);
    // Annuler les modifications en cours : la version enregistrée revient.
    await editor().locator('.ed-top [data-action="ed-compare"]').click();
    await editor().locator('[data-action="ed-discard"]').click();
    await editor().locator('[data-action="ed-discard-confirm"]').click();
    await chip('Enregistré').waitFor();
  });

  it('restores the generated version after a confirmation in the page', async () => {
    await editor().locator('[data-action="ed-restore"]').click();
    await editor().locator('.ed-confirm', { hasText: 'version générée remplacera' }).waitFor();
    await editor().locator('[data-action="ed-restore-confirm"]').click();
    await editor()
      .locator('.ed-note.ok', { hasText: 'Version générée restaurée' })
      .waitFor({ timeout: 30_000 });
    expect(await chip('Modifié à la main').count()).toBe(0);
    expect(await savedContent(YAML)).not.toContain('Ouvrir la fiche du premier utilisateur');
  });

  it('Gherkin: the scenario steps; an unknown sentence is reported on its row after Check', async () => {
    await editor().locator(`.ed-tree [data-action="ed-open"][data-path="${FEATURE}"]`).click();
    await editor().locator('[data-action="ed-mode"][data-mode="visual"]').click();
    await steps().first().waitFor();
    expect(await steps().count()).toBe(3);
    expect(await steps().nth(2).textContent()).toContain("l'URL contient");
    await steps().nth(2).locator('.ed-sm').click();
    const sentence = editor().locator('.ed-inspector [data-ed-field="sentence"]');
    await sentence.fill('la lune est bleue');
    await sentence.press('Enter');
    await expect.poll(() => steps().nth(2).textContent()).toContain('la lune est bleue');
    await editor().locator('.ed-top [data-action="ed-check"]').click();
    await steps().nth(2).locator('.ed-st.ko', { hasText: 'Phrase inconnue' }).waitFor({ timeout: 60_000 });
    expect(await editor().locator('.ed-panel').textContent()).toContain('no step definition for');
    // Fermer l'onglet modifié : la page le demande.
    await editor().locator(`.ed-tab [data-action="ed-close"][data-path="${FEATURE}"]`).click();
    await editor().locator('[data-action="ed-close-confirm"]').click();
    expect(await editor().locator('.ed-tab').allTextContents()).not.toContain(FEATURE);
  });

  it('Playwright TypeScript: no visual view (said why), the outline in the explorer leads to its line', async () => {
    await editor().locator(`.ed-tree [data-action="ed-open"][data-path="${SPEC}"]`).click();
    await editor().locator('.cm-editor').waitFor({ timeout: 30_000 });
    const visual = editor().locator('[data-action="ed-mode"][data-mode="visual"]');
    expect(await visual.isDisabled()).toBe(true);
    expect(await visual.getAttribute('title')).toContain('ne se représente pas sans perte');
    const spec = await savedContent(SPEC);
    const line = spec.split('\n').findIndex((entry) => entry.trim() === '// step 2') + 1;
    await editor().locator('.ed-tree button', { hasText: 'Étape 2' }).click();
    await expect
      .poll(() => editor().locator('.cm-lineNumbers .cm-activeLineGutter').textContent())
      .toBe(String(line));
    expect(await sourceText()).toContain("import { test, expect } from '@playwright/test';");
  });

  it('Dry Run of the flow YAML with the real engine: followed, every expected step found, results on the rows', async () => {
    await editor().locator(`.ed-tab [data-action="ed-tab"][data-path="${YAML}"]`).click();
    await editor().locator('[data-action="ed-mode"][data-mode="visual"]').click();
    await editor().locator('.ed-top [data-action="ed-dry-run"]').click();
    await editor().locator('.ed-note', { hasText: 'Dry Run' }).waitFor({ timeout: 15_000 });
    await editor().locator('.ed-note.ok', { hasText: 'Tout retrouvé' }).waitFor({ timeout: 240_000 });
    // Le Résumé de la console : le verdict du Dry Run, tel que le moteur le rend.
    await editor().locator('[data-action="ed-con-tab"][data-tab="summary"]').click();
    expect(await editor().locator('.ed-con-stats').textContent()).toContain('Tout retrouvé');
    await editor().locator('[data-action="ed-con-tab"][data-tab="console"]').click();
    expect(await steps().locator('.ed-st.ok').count()).toBe(3);
  }, 300_000);

  it('the explorer is a keyboard tree', async () => {
    const current = editor().locator('.ed-tree [data-action="ed-open"][tabindex="0"]');
    await current.focus();
    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => {
      const host = document.querySelector('qa-crawler-dashboard');
      return (host?.shadowRoot?.activeElement as HTMLElement | null)?.textContent ?? '';
    });
    expect(focused).toContain('1.');
  });

  it('leaving with unsaved changes asks first; staying keeps them', async () => {
    await steps().nth(0).locator('.ed-sm').click();
    const name = editor().locator('.ed-inspector [data-ed-field="name"]');
    await name.fill('Liste des utilisateurs');
    expect(await name.inputValue()).toBe('Liste des utilisateurs');
    await name.press('Enter');
    await chip('Modifications non enregistrées')
      .waitFor()
      .catch(async (error: unknown) => {
        // L'état de l'écran au moment de l'échec, pour en trouver la cause (le test échoue quand même).
        const state = await editor().evaluate((element) => ({
          top: element.querySelector('.ed-top')?.textContent,
          selected: element.querySelector('.ed-step.sel')?.textContent,
          inspector: element.querySelector('.ed-inspector')?.innerHTML.slice(0, 1500),
          active: (element.getRootNode() as ShadowRoot).activeElement?.outerHTML.slice(0, 300),
        }));
        console.error('EDITOR-STATE', JSON.stringify(state));
        throw error;
      });
    await dashboard().locator('.drawer [data-action="nav"][data-view="overview"]').click();
    await editor().locator('.ed-confirm', { hasText: 'non enregistrées' }).waitFor();
    await editor().locator('[data-action="ed-confirm-cancel"]').click();
    expect(await steps().nth(0).textContent()).toContain('Liste des utilisateurs');
    await dashboard().locator('.drawer [data-action="nav"][data-view="overview"]').click();
    await editor().locator('[data-action="ed-leave-confirm"]').click();
    await dashboard().locator('.ed').waitFor({ state: 'detached' });
    expect(await savedContent(YAML)).not.toContain('Liste des utilisateurs');
  });

  it.skipIf(!mavenAvailable)(
    'Java JUnit 5: the class and the @Test method in the outline, Java in the source',
    async () => {
      await dashboard().locator('.drawer [data-action="nav"][data-view="editor"]').click();
      await editor().locator('.ed-tree').waitFor({ timeout: 30_000 });
      await editor()
        .locator('.ed-tree [data-action="ed-open"]', { hasText: 'OuvrirUneFicheTest.java' })
        .click();
      await editor().locator('.cm-editor').waitFor({ timeout: 30_000 });
      expect(await editor().locator('.ed-tree').textContent()).toContain('Ouvrir une fiche');
      expect(await sourceText()).toContain('@Test');
    },
  );

  it.skipIf(!mavenAvailable)(
    'Java: a compilation error is one diagnostic, on its line, in this file only; saving is refused',
    async () => {
      const javaPath = await editor()
        .locator('.ed-tree [data-action="ed-open"]', { hasText: 'OuvrirUneFicheTest.java' })
        .getAttribute('data-path');
      const saved = await savedContent(javaPath ?? '');
      const line = saved.split('\n').findIndex((text) => text.includes('.click()')) + 1;
      expect(line).toBeGreaterThan(0);
      await editor().locator('.cm-content').click();
      await page.keyboard.press('Control+a');
      await page.keyboard.insertText(saved.replace('.click()', '.clique()'));
      await chip('Modifications non enregistrées').waitFor();
      await editor().locator('.ed-top [data-action="ed-check"]').click();
      const problems = editor().locator('.ed-panel .ed-dcat button');
      await problems.first().waitFor({ timeout: 300_000 });
      // Un seul diagnostic : ni recopié sur les autres fichiers du projet, ni une ligne par phrase de Maven.
      expect(await problems.count()).toBe(1);
      const text = (await problems.first().textContent()) ?? '';
      expect(text).toContain('clique()');
      expect(text).toContain(`ligne ${String(line)}`);
      expect(text).not.toMatch(/Env\.java|pom\.xml|Help 1/);
      await problems.first().click();
      await expect
        .poll(() => editor().locator('.cm-lineNumbers .cm-activeLineGutter').textContent())
        .toBe(String(line));
      await editor().locator('.ed-top [data-action="ed-save"]').click();
      await editor()
        .locator('.ed-note.err', { hasText: 'ne passe pas sa vérification' })
        .waitFor({ timeout: 300_000 });
      expect(await savedContent(javaPath ?? '')).toBe(saved);
      await editor().locator('.ed-top [data-action="ed-compare"]').click();
      await editor().locator('[data-action="ed-discard"]').click();
      await editor().locator('[data-action="ed-discard-confirm"]').click();
    },
  );

  it('on a phone: one column, nothing overflows the page, the actions stay reachable', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${server.url}/dashboard`);
    const element = phone.locator('qa-crawler-dashboard');
    await element.locator('[data-action="menu"]').click();
    await element.locator('select[data-action="project-context"]').selectOption(project.id);
    await element.locator('[data-action="menu"]').click();
    await element.locator('.drawer [data-action="nav"][data-view="editor"]').click();
    await element.locator('.ed-visual .ed-step').first().waitFor({ timeout: 30_000 });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    const explorer = await element.locator('.ed-explorer').boundingBox();
    const center = await element.locator('.ed-center').boundingBox();
    expect((center?.y ?? 0) >= (explorer?.y ?? 0) + (explorer?.height ?? 0) - 1).toBe(true);
    expect(await element.locator('.ed-top [data-action="ed-save"]').isVisible()).toBe(true);
    await phone.close();
    expect(errors).toEqual([]);
  });
});
