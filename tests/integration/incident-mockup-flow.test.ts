import { readFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import type { Incident } from '../../src/sdk/core/incident-contracts.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startIncidentSite, type IncidentSite } from '../fixtures/incident-site.js';

/**
 * LE PARCOURS DE LA MAQUETTE (12 écrans), dans Chromium, de bout en bout sur l'incident connu de la
 * fixture (tests/fixtures/incident-app) avec le vrai moteur : liste (onglets, recherche, colonnes),
 * création (application, type, une capture PNG et un texte joints) qui ouvre le Périmètre, arborescence
 * (cocher / décocher un dossier), profondeur, mémoire (note LOCAL), « Étape suivante » qui enregistre puis
 * ouvre l'Environnement, « Tester la connectivité » (l'URL de la fixture joignable), Reproduction ›
 * Exécution (suivi en direct si le rejeu dure assez, puis l'état final avec étapes et durées), Preuves
 * (ligne 500 en erreur, cURL reconstruit et masqué), Traçabilité en couloirs, Code (couches, « Détails de
 * la ligne »), Diagnostic, Rapport (HTML, Markdown, PDF ou sa raison), Non-régression (test Playwright,
 * « Validé » absent tant que rien n'est accepté). Aucune erreur de page, aucun défilement du document
 * à 1440×900 sur les vues de l'espace.
 */
let site: IncidentSite;
let server: RunningSdkServer;
let workspace: string;
let repos: string;
let service: QaCrawlerClient;
let project: Project;
let browser: Browser;

const FAILING = 'Créer un livre sans éditeur';
const PASSING = 'Créer un livre avec éditeur';
const TITLE = 'Erreur 500 à la création d’un livre (parcours)';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABICAIAAACyfKYoAAAAuElEQVR42u3ZsQmAMBRF0Uwjlk5hq8NaOYFDWAXcQUREnEE0MR64Exxe8/mhbnq9UEAAGrRAgwZNATRogc4Wet12vRBo0KAF+mququT9BfqIMWGgQYMGDboU6GGcss2iLRo0aNCgQYMGDRo0aNAuQ4u2aNCgvbLkOQtaoEGD1vPQ370MLdqiBRq0QIMGLdCg5TK0aIsWaNACDRq0SoXu2uVmoEGDBg0aNGjQoEE7WBwsAg1aoEEX3glLFkpEt2KJHAAAAABJRU5ErkJggg==',
  'base64',
);

const flow = (name: string, publisher?: string): string => `name: ${name}
startAt: /books/new
steps:
  - fill: { label: Titre, value: Les Marées du Nord }
  - fill: { label: ISBN, value: 978-2-0000-0000-1 }
${publisher ? `  - select: { label: Éditeur, option: ${publisher} }\n` : ''}  - click: { role: button, name: Enregistrer }
    allow: MUTATION
  - expect: { text: Livre créé }
`;

beforeAll(async () => {
  site = await startIncidentSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-mockup-ws-'));
  repos = await mkdtemp(path.join(tmpdir(), 'incident-mockup-repos-'));
  await cp(path.join(import.meta.dirname, '../fixtures/incident-app'), repos, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr' });
  service = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await service.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: `${site.url}/books`, framework: 'other' },
  });
  await service.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: site.url,
    mutations: { enabled: true, maxPerRun: 5 },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows', 'books');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'sans-editeur.flow.yaml'), flow(FAILING));
  await writeFile(path.join(flows, 'avec-editeur.flow.yaml'), flow(PASSING, 'Éditions du Nord'));
  // Un autre incident, d'une autre application, pour les onglets et la recherche de la liste.
  await service.incidents.create(project.id, {
    title: 'Échec de connexion',
    description: 'La connexion échoue avec un mot de passe valide.',
    observed: 'Identifiants invalides',
    expected: 'Connexion réussie',
    severity: 'MEDIUM',
    application: 'IAM',
    kind: 'FUNCTIONAL',
  });
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser.close();
  service.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(repos, { recursive: true, force: true });
});

/** Le défilement vertical du document (l'espace tient dans la fenêtre à 1440×900). */
const documentScrolls = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const element = document.scrollingElement;
    return element ? element.scrollHeight > window.innerHeight + 1 : false;
  });

async function noDocumentScroll(page: Page, view: string): Promise<void> {
  await page.waitForTimeout(150);
  expect(await documentScrolls(page), `document scroll on ${view}`).toBe(false);
}

async function until(id: string, done: (incident: Incident) => boolean, ms = 150_000): Promise<Incident> {
  const started = Date.now();
  for (;;) {
    const incident = await service.incidents.get(project.id, id);
    if (done(incident)) return incident;
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function downloaded(page: Page, trigger: Locator): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger.click()]);
  const file = await download.path();
  return { name: download.suggestedFilename(), text: await readFile(file, 'utf8') };
}

describe('Incident Reconstruction — the 12-screen mockup, end to end (Chromium, real engine)', () => {
  it('list → create → scope → environment → run → evidence → traceability → code → diagnosis → report → regression', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.url}/dashboard`);
    const dash = page.locator('qa-crawler-dashboard');
    await dash.locator('select[data-action="project-context"]').selectOption(project.id);
    await page.waitForTimeout(400);

    // ── 1. Liste des incidents : onglets par groupe, recherche, colonnes ──
    await dash.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
    await dash.locator('tr.inc-l-row').first().waitFor();
    const headers = (await dash.locator('table thead th').allTextContents()).map((text) => text.trim());
    for (const column of ['ID', 'Titre', 'Sévérité', 'Application', 'Statut', 'Date de création'])
      expect(headers.join('|')).toContain(column);
    expect(await dash.locator('[data-action="inc-group"]').count()).toBe(5);
    await dash.locator('#inc-l-q').fill('IAM');
    await expect.poll(() => dash.locator('tr.inc-l-row').count()).toBe(1);
    await dash.locator('#inc-l-q').fill('');

    // ── 2. Création : application, type, une capture et un texte joints → Périmètre ──
    await dash.locator('[data-action="inc-new"]').first().click();
    await dash.locator('[data-inc="title"]').fill(TITLE);
    await dash
      .locator('[data-inc="description"]')
      .fill('Après avoir cliqué sur Enregistrer, l’application affiche une erreur HTTP 500.');
    await dash.locator('[data-inc="application"]').fill('Catalogue');
    await dash.locator('select[data-inc="kind"]').selectOption('FUNCTIONAL');
    await dash.locator('select[data-inc="scenario"]').selectOption(FAILING);
    await dash.locator('[data-inc="expected"]').fill('Livre créé');
    await dash.locator('[data-inc="observed"]').fill('Erreur HTTP 500 après Enregistrer');
    await dash.locator('#inc-f-files').setInputFiles([
      { name: 'capture.png', mimeType: 'image/png', buffer: PNG },
      { name: 'console.txt', mimeType: 'text/plain', buffer: Buffer.from('POST /api/books -> 500\n') },
    ]);
    await dash.locator('[data-action="inc-att-remove"]').nth(1).waitFor();
    await dash.locator('form[data-action="inc-create"] button[type="submit"]').click();
    await dash.locator('#ws-ux-sub-scope[aria-selected="true"]').waitFor();
    const list = await service.incidents.list(project.id);
    const summary = list.find((entry) => entry.title === TITLE);
    expect(summary).toMatchObject({ application: 'Catalogue', kind: 'FUNCTIONAL' });
    let incident = await service.incidents.get(project.id, summary?.id ?? '');
    expect(incident.attachments?.map((entry) => [entry.name, entry.type])).toEqual([
      ['capture.png', 'image/png'],
      ['console.txt', 'text/plain'],
    ]);
    // Les applications du périmètre (leurs dépôts) : le formulaire de création ne les demande pas.
    incident = await service.incidents.update(project.id, incident.id, incident.revision, {
      scope: {
        applications: [
          {
            id: 'front',
            name: 'Frontend',
            layer: 'FRONTEND',
            repository: { root: path.join(repos, 'frontend'), include: ['src'] },
          },
          {
            id: 'bff',
            name: 'BFF',
            layer: 'BFF',
            repository: { root: path.join(repos, 'bff'), include: ['src/main'] },
          },
          {
            id: 'catalog',
            name: 'Catalogue',
            layer: 'BACKEND',
            repository: { root: path.join(repos, 'backend'), include: ['src/main'] },
          },
        ],
        scenarios: [FAILING, PASSING],
      },
    });
    await dash.locator('[data-action="inc-refresh"]').click();

    // ── 3. Définition du périmètre : arborescence, profondeur, mémoire, « Étape suivante » ──
    const testFolder = dash.locator(
      '[data-action="inc-scope-toggle"][data-block="catalog"][data-index="src/test"]',
    );
    await testFolder.waitFor();
    expect(await testFolder.getAttribute('aria-checked')).toBe('false');
    await testFolder.click();
    await expect.poll(() => testFolder.getAttribute('aria-checked')).toBe('true');
    await testFolder.click();
    await expect.poll(() => testFolder.getAttribute('aria-checked')).toBe('false');
    await dash.locator('[data-inc="scope.range"]').fill('4');
    await dash.locator('[data-inc="scope.limit.memory"]').fill('1024');
    expect(await dash.locator('#ws-ux-panel').textContent()).toContain('Sans effet en LOCAL');
    await noDocumentScroll(page, 'scope');
    const before = incident.revision;
    await dash.locator('[data-action="inc-scope-next"]').click();
    await dash.locator('#ws-ux-sub-environment[aria-selected="true"]').waitFor();
    incident = await service.incidents.get(project.id, incident.id);
    expect(incident.revision).toBeGreaterThan(before);
    expect(incident.scope.depth).toBe(4);
    expect(incident.scope.limits.maxMemoryMb).toBe(1024);

    // ── 4. Sélection de l'environnement : « Tester la connectivité » ──
    await dash.locator('[data-action="ws-ux-check"]').click();
    const config = dash.locator('.ws-ux-config');
    await expect
      .poll(async () => (await config.textContent()) ?? '', { timeout: 15_000 })
      .toContain('Joignable');
    expect(await config.textContent()).toContain(site.url);
    await noDocumentScroll(page, 'environment');
    await dash.locator('.ws-ux-config [data-action="ws-ux-stage"][data-stage="reproduction"]').click();
    await dash.locator('#ws-ux-sub-run[aria-selected="true"]').waitFor();

    // ── 5. Reproduction avec Playwright : suivi en direct (si le rejeu dure assez), état final ──
    await dash.locator('[data-action="ws-repro-start"]').click();
    let liveSeen = false;
    for (let at = 0; at < 300; at += 1) {
      if (
        (await dash
          .locator('.ws-repro-run[data-state="RUNNING"] .ws-repro-step[aria-current="step"]')
          .count()) > 0
      ) {
        liveSeen = true;
        expect(await dash.locator('[data-ws-ticking="true"]').count()).toBe(1);
        expect(await dash.locator('.ws-repro-run .ws-repro-state').textContent()).toMatch(/En cours/i);
        break;
      }
      if ((await dash.locator('.ws-repro-run[data-state="REPRODUCED"]').count()) > 0) break;
      await page.waitForTimeout(100);
    }
    await dash.locator('.ws-repro-run[data-state="REPRODUCED"]').waitFor({ timeout: 150_000 });
    incident = await until(incident.id, (current) => current.state !== 'REPRODUCING');
    expect(incident.state).toBe('REPRODUCED');
    const steps = dash.locator('.ws-repro-run .ws-repro-step');
    expect(await steps.count()).toBe(incident.investigation.reproductions.at(-1)?.actions.length);
    expect(await dash.locator('.ws-repro-run').textContent()).toMatch(/\d+ ms/);
    expect(await dash.locator('[data-ws-ticking="true"]').count()).toBe(0);
    await noDocumentScroll(page, 'run');
    // Le suivi en direct est vu quand un dessin tombe pendant le rejeu (relecture toutes les 1,5 s) ;
    // l'API le garantit (incident-reconstruction), l'écran le montre au mieux.
    console.info(`live run state seen in the Dashboard: ${String(liveSeen)}`);

    // ── 6. Preuves collectées : la ligne 500 en erreur, le cURL reconstruit et masqué ──
    await dash.locator('#ws-ux-sub-evidence').click();
    const failing = dash.locator('.ws-repro-ev tr.ws-repro-tr-ko', { hasText: '/api/books' }).first();
    await failing.waitFor();
    expect(await failing.textContent()).toContain('500');
    // La première requête en erreur est détaillée d'office (ligne marquée « en cours »).
    expect(await failing.getAttribute('aria-current')).toBe('true');
    await dash.locator('#ws-repro-req-tab-curl').click();
    const curl = (await dash.locator('#ws-repro-req-panel').textContent()) ?? '';
    expect(curl).toContain('curl -X POST');
    expect(curl).toMatch(/masqu/);
    await noDocumentScroll(page, 'evidence');

    // L'analyse du code (graphe, hypothèses) : par le serveur ; la page relit l'incident.
    incident = await service.incidents.analyze(project.id, incident.id);
    await dash.locator('[data-action="inc-refresh"]').click();

    // ── 7. Traçabilité Full Stack : « Couloirs horizontaux » montre les titres des couches ──
    await dash.locator('#ws-ux-tab-traceability').click();
    await dash.locator('#ws-ux-sub-fullstack').click();
    await dash.locator('select[data-action="ws-graph-layout"]').selectOption('lanes');
    await dash.locator('.ws-graph-lane-t').first().waitFor();
    const lanes = await dash.locator('.ws-graph-lane-t').allTextContents();
    expect(lanes.join('|')).toMatch(/Frontend/);
    expect(lanes.join('|')).toMatch(/Backend/);
    await noDocumentScroll(page, 'traceability');

    // ── 8. Explorateur de code : onglets de couche, « Détails de la ligne » ──
    await dash.locator('#ws-ux-tab-code').click();
    const backend = dash.locator('[data-action="ws-code-layer"][data-layer="BACKEND"]').first();
    await backend.click();
    expect(await backend.getAttribute('aria-pressed')).toBe('true');
    await dash.locator('[data-action="ws-code-layer"][data-layer="ALL"]').first().click();
    // Le point de départ (la ligne signalée du backend) ouvert dans l'éditeur : « Détails de la ligne ».
    await dash.locator('[data-ws-pane="editor"] [data-action="ws-code-open"]').first().click();
    await dash.locator('[data-ws-pane="evidence"] .ws-code-linebox .ws-code-lineh').first().waitFor();
    expect(await dash.locator('[data-ws-pane="evidence"]').textContent()).toContain('Détails de la ligne');
    await noDocumentScroll(page, 'code');

    // ── 9. Diagnostic et hypothèses : le tableau à trois colonnes ──
    await dash.locator('#ws-ux-tab-diagnosis').click();
    await dash.locator('#ws-ux-sub-diagnosis').click();
    await dash.locator('.ws-dx-board').waitFor();
    expect(await dash.locator('.ws-dx-col').count()).toBe(3);
    expect(await dash.locator('.ws-dx-board').textContent()).toContain(
      `Hypothèses (${String(incident.investigation.hypotheses.length)})`,
    );
    await noDocumentScroll(page, 'diagnosis');

    // ── 10. Rapport d'investigation : HTML, Markdown, PDF (ou sa raison) ──
    await dash.locator('#ws-ux-tab-report').click();
    await dash.locator('#ws-ux-sub-report').click();
    await dash.locator('.ws-dx-rx-doc .ws-dx-rx-sec').first().waitFor();
    const html = await downloaded(page, dash.locator('[data-action="ws-dx-export"][data-format="html"]'));
    expect(html.name).toBe(`incident-${incident.id}.html`);
    expect(html.text.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    await dash.locator('[data-action="ws-dx-export"][data-format="markdown"]:not([disabled])').waitFor();
    const markdown = await downloaded(
      page,
      dash.locator('[data-action="ws-dx-export"][data-format="markdown"]'),
    );
    expect(markdown.name).toBe(`incident-${incident.id}.md`);
    expect(markdown.text).toContain(TITLE);
    await dash.locator('[data-action="ws-dx-export"][data-format="pdf"]:not([aria-busy="true"])').waitFor();
    const pdfButton = dash.locator('[data-action="ws-dx-export"][data-format="pdf"]');
    const pdf = await Promise.race([
      page.waitForEvent('download', { timeout: 60_000 }).then(async (download) => ({
        kind: 'file' as const,
        head: (await readFile(await download.path())).subarray(0, 5).toString('latin1'),
      })),
      dash
        .locator('#ws-dx-rx-why-pdf')
        .waitFor({ timeout: 60_000 })
        .then(async () => ({
          kind: 'unavailable' as const,
          head: (await dash.locator('#ws-dx-rx-why-pdf').textContent()) ?? '',
        })),
      pdfButton.click().then(() => new Promise<never>(() => undefined)),
    ]);
    console.info(`PDF export: ${pdf.kind}`);
    if (pdf.kind === 'file') expect(pdf.head).toBe('%PDF-');
    else {
      expect(pdf.head.length).toBeGreaterThan(0);
      expect(await pdfButton.isDisabled()).toBe(true);
    }
    await noDocumentScroll(page, 'report');

    // ── 11. Test de non-régression : proposé, test Playwright généré, « Validé » absent ──
    await dash.locator('#ws-ux-sub-regression').click();
    await dash.locator('[data-action="ws-dx-regression"][data-op="propose"]').click();
    await dash.locator('#ws-dx-rt-tab-spec').waitFor({ timeout: 30_000 });
    await dash.locator('#ws-dx-rt-tab-spec').click();
    const code = dash.locator('#ws-dx-rt-src');
    await expect
      .poll(async () => (await code.textContent()) ?? '', { timeout: 15_000 })
      .toContain('@playwright/test');
    expect(await code.textContent()).toContain('page.goto');
    expect(await dash.locator('.ws-dx-rt').textContent()).not.toContain('Validé');
    expect((await service.incidents.get(project.id, incident.id)).investigation.regression?.status).toBe(
      'PROPOSED',
    );
    await noDocumentScroll(page, 'regression');

    // Les pièces jointes, de retour sur le résumé : l'aperçu de l'image dans le panneau des détails.
    await dash.locator('#ws-ux-tab-overview').click();
    await dash.locator('#ws-ux-sub-summary').click();
    expect(await dash.locator('.ws-att').textContent()).toContain('Pièces jointes (2)');
    await dash.locator('[data-action="ws-att-open"]', { hasText: 'capture.png' }).click();
    await dash.locator('[data-ws-pane="details"] .ws-att-fig img').waitFor();
    expect(await dash.locator('[data-ws-pane="details"] .ws-att-fig img').getAttribute('src')).toMatch(
      /^data:image\/png;base64,/,
    );
    await noDocumentScroll(page, 'summary');

    expect(errors).toEqual([]);
    await page.close();
  }, 420_000);
});
