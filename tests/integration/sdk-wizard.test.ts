import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LE SDK DE BOUT EN BOUT, avec le VRAI moteur (runMission), un vrai Chromium et le site de démo :
 * l'assistant crée le projet, lance l'exploration, suit les événements et montre le résultat du
 * moteur. Puis le même élément embarqué dans une application hôte sur une autre origine.
 */
let site: TestSite;
let server: RunningSdkServer;
let browser: Browser;
let workspace: string;
let host: Server;
let hostUrl = '';
const SECRET = 'not-a-real-password-4242';

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-wizard-'));
  host = createServer((request, response) => {
    if (request.url === '/host-api/token') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ token: server.token }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Hôte</title>
<style>qa-crawler-project-wizard{--qa-color-primary:#10B981;--qa-color-primary-2:#059669}</style></head>
<body><h1>Application hôte</h1>
<qa-crawler-project-wizard mode="embedded" locale="fr" endpoint="${server.url}/api"></qa-crawler-project-wizard>
<p id="log"></p>
<script type="module">
  import '${server.url}/sdk/ui/index.js';
  const wizard = document.querySelector('qa-crawler-project-wizard');
  wizard.token = (await (await fetch('/host-api/token')).json()).token;
  wizard.initialValues = { project: { name: 'Portail' }, exploration: { maxStates: 3, maxActions: 15, maxDurationMinutes: 2 } };
  for (const type of ['qa-project-created', 'qa-exploration-started', 'qa-exploration-completed', 'qa-error'])
    wizard.addEventListener(type, () => { document.getElementById('log').textContent += type + ' '; });
</script></body></html>`);
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  hostUrl = `http://127.0.0.1:${String((host.address() as AddressInfo).port)}`;
  server = await startSdkServer({
    workspace,
    language: 'fr',
    allowedOrigins: [hostUrl],
    env: { ...process.env, QA_USERNAME: 'demo-user', QA_PASSWORD: SECRET },
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await server.close();
  await new Promise<void>((resolve) =>
    host.close(() => {
      resolve();
    }),
  );
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

async function fillProject(wizard: Locator, url: string): Promise<void> {
  await wizard.getByLabel('Adresse de l’application').fill(url);
  await wizard.getByRole('button', { name: 'Vérifier l’accès' }).click();
  await expect
    .poll(() => wizard.getByText(/Accessible depuis le serveur QA-CRAWLER · HTTP 200/).count())
    .toBe(1);
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

describe('SDK wizard — standalone, real engine', () => {
  it('creates the project, runs the real exploration and shows the engine result', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = pageErrors(page);
    await page.goto(server.url);
    const wizard = page.locator('qa-crawler-project-wizard');
    await wizard.getByLabel('Nom du projet').fill('Site de démo');
    await fillProject(wizard, `${site.url}/`);
    await wizard.getByRole('radio', { name: /React/ }).click();
    await wizard.getByRole('button', { name: /Continuer/ }).click();

    // Les identifiants : des noms de variables, et leur présence vue par le serveur.
    await wizard.getByRole('radio', { name: 'Formulaire' }).click();
    await expect
      .poll(() =>
        wizard
          .locator('.var')
          .filter({ hasText: /^QA_(USERNAME|PASSWORD) définie$/ })
          .count(),
      )
      .toBe(2);
    expect(await wizard.locator('input[type=password]').count()).toBe(0);
    await wizard.getByRole('radio', { name: 'Aucune' }).click();
    await wizard.getByRole('button', { name: /Continuer/ }).click();

    await wizard.locator('input[type=number][data-bind="exploration.maxStates"]').fill('3');
    await wizard.locator('input[type=number][data-bind="exploration.maxActions"]').fill('15');
    await wizard.locator('input[type=number][data-bind="exploration.maxDurationMinutes"]').fill('2');
    await wizard.getByRole('button', { name: /Continuer/ }).click();
    await wizard.getByText('Configuration valide').waitFor({ timeout: 30_000 });
    await expect.poll(() => wizard.locator('pre.yaml').innerText()).toContain('maxStates: 3');

    await wizard.getByRole('button', { name: /Lancer l’exploration/ }).click();
    await wizard
      .getByText(/Exploration en cours|Exploration en attente/)
      .first()
      .waitFor();
    await wizard.getByText('Exploration terminée').waitFor({ timeout: 180_000 });

    // Les chiffres affichés sont ceux du résultat du moteur.
    const [projectId] = (await readdir(workspace)).filter((name) => name.startsWith('prj_'));
    expect(projectId).toBeDefined();
    const headline = await wizard.locator('h1').innerText();
    expect(headline).toMatch(/^\d+ écrans? explorés? en /);
    const states = Number(/^(\d+)/.exec(headline)?.[1]);
    expect(states).toBeGreaterThan(0);
    expect(states).toBeLessThanOrEqual(3);
    await wizard
      .getByText(/^Arrêt /)
      .first()
      .waitFor();

    // Le projet écrit : le format du moteur, aucune valeur secrète.
    const projectFile = await readFile(
      path.join(workspace, projectId ?? '', 'qa-crawler.config.yaml'),
      'utf8',
    );
    expect(projectFile).toContain('framework: react');
    expect(projectFile).not.toContain(SECRET);
    const reportsRoot = path.join(workspace, projectId ?? '', 'qa-reports');
    const [runDir] = await readdir(reportsRoot);
    const result = JSON.parse(
      await readFile(path.join(reportsRoot, runDir ?? '', 'result.json'), 'utf8'),
    ) as {
      stats: { states: number };
    };
    expect(result.stats.states).toBe(states);

    // Le rapport HTML s'ouvre par un lien de courte durée, dans un bac à sable.
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      wizard.getByRole('button', { name: 'Ouvrir' }).first().click(),
    ]);
    await popup.waitForLoadState();
    expect(popup.url()).toMatch(/\/reports\/[A-Za-z0-9_-]+\/index\.html$/);
    expect(await popup.title()).toContain('Site de démo');
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe('SDK wizard — embedded in a host on another origin', () => {
  it('takes the host theme and token, and emits its events to the host', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = pageErrors(page);
    await page.goto(hostUrl);
    const wizard = page.locator('qa-crawler-project-wizard');
    await expect.poll(() => wizard.getByLabel('Nom du projet').inputValue()).toBe('Portail');
    // Le thème de l'hôte : la couleur principale passe dans le Shadow DOM.
    const primary = await wizard
      .getByRole('button', { name: /Continuer/ })
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(primary).toContain('rgb(16, 185, 129)');
    // Embarqué : une barre d'étapes compacte, pas le panneau sombre.
    expect(await wizard.locator('.pan').isVisible()).toBe(false);
    expect(await wizard.locator('.hsteps').isVisible()).toBe(true);

    await fillProject(wizard, `${site.url}/`);
    await wizard.getByRole('button', { name: /Continuer/ }).click();
    await wizard.getByRole('button', { name: /Continuer/ }).click();
    await wizard.getByRole('button', { name: /Continuer/ }).click();
    await wizard.getByText('Configuration valide').waitFor({ timeout: 30_000 });
    await wizard.getByRole('button', { name: /Lancer l’exploration/ }).click();
    await wizard.getByText('Exploration terminée').waitFor({ timeout: 180_000 });
    await expect.poll(() => page.locator('#log').innerText()).toContain('qa-exploration-completed');
    const log = await page.locator('#log').innerText();
    expect(log).toContain('qa-project-created');
    expect(log).toContain('qa-exploration-started');
    expect(log).not.toContain('qa-error');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('is refused from an origin the server does not list', async () => {
    const other = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><qa-crawler-project-wizard mode="embedded" endpoint="${server.url}/api"></qa-crawler-project-wizard>
<script type="module">import '${server.url}/sdk/ui/index.js'; document.querySelector('qa-crawler-project-wizard').token = ${JSON.stringify(server.token)};</script>`);
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${String((other.address() as AddressInfo).port)}`);
      await page.locator('qa-crawler-project-wizard').getByText('Serveur QA-CRAWLER injoignable').waitFor();
      expect(await page.locator('qa-crawler-project-wizard').getByLabel('Nom du projet').count()).toBe(0);
    } finally {
      await page.close();
      await new Promise<void>((resolve) =>
        other.close(() => {
          resolve();
        }),
      );
    }
  });
});
