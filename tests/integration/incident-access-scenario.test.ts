import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Incident } from '../../src/incident/model.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startAngularSite, type AngularSite } from '../fixtures/angular-site.js';

/**
 * LE SCÉNARIO D'ACCÈS ET L'EXPLORATION DANS LE DASHBOARD (Chromium, serveur SDK réel, application Angular
 * exécutable, aucune IA) : la carte se place entre « Applications et dépôts » et « Définition du
 * périmètre » ; l'utilisateur ne saisit que l'écran cible et le symptôme (sans perdre le focus) ;
 * « Localiser l'écran » trouve la route et le parcours dans le code ; « Préparer l'exploration » atteint
 * l'écran dans un vrai navigateur et inventorie ses contrôles ; « Lancer l'investigation » démarre le
 * moteur depuis cet écran : la progression vient du run (phases, compteurs), puis la séquence déclenchante
 * et ses conditions s'affichent. Aucune vidéo ; la démonstration passe par un enregistrement. Tout reste
 * après rechargement ; le Résumé et le rapport reprennent l'écran cible ; aucun débordement.
 */
const FIXTURE = path.resolve('tests/fixtures/angular-app');
const SHOTS = process.env.ACC_SHOTS_DIR;
const SYMPTOM =
  'Après une erreur JavaScript, le bouton Enregistrer ne fait plus rien : aucune validation, aucun chargement, aucune requête. Les données saisies sont perdues après un rechargement.';

let site: AngularSite;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let incident: Incident;
let browser: Browser;

beforeAll(async () => {
  site = await startAngularSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-access-ui-'));
  server = await startSdkServer({ workspace, language: 'fr', env: {} });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: site.url, framework: 'other' },
  });
  const environment = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: site.url,
    mutations: { enabled: true, maxPerRun: 50 },
  });
  incident = await client.incidents.create(project.id, {
    title: 'Blocage après l’enregistrement d’un dossier',
    description: 'Les boutons ne répondent plus.',
    observed: 'aucune réaction',
    expected: 'dossier enregistré',
    severity: 'HIGH',
    application: 'Dossiers',
    environmentId: environment.id,
    scope: {
      applications: [
        {
          id: 'web',
          name: 'dossiers-frontend',
          layer: 'FRONTEND',
          repository: { root: FIXTURE, include: ['src'] },
        },
      ],
      allowedHosts: [new URL(site.url).host],
    },
  });
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

async function openScope(page: Page): Promise<Locator> {
  await page.goto(`${server.url}/dashboard`);
  const dashboard = page.locator('qa-crawler-dashboard');
  await dashboard.locator('select[data-action="project-context"]').selectOption(project.id);
  await dashboard.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
  await dashboard.locator('tr.inc-l-row', { hasText: 'Blocage après' }).first().click();
  await dashboard.locator('#ws-ux-tab-overview[aria-selected="true"]').waitFor();
  await dashboard.locator('#ws-ux-sub-scope').click();
  await dashboard.locator('#inc-acc-t').waitFor();
  return dashboard;
}

async function shot(dashboard: Locator, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await dashboard.locator('.inc-acc').screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const focused = (field: Locator): Promise<boolean> =>
  field.evaluate((element) => element === (element.getRootNode() as ShadowRoot).activeElement);

describe('scénario d’accès et exploration dans le Dashboard', () => {
  it('écran cible → localiser → préparer → lancer → progression réelle → résultats ; persistance, résumé, rapport', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let dashboard = await openScope(page);

    const headings = (await dashboard.locator('h2').allTextContents()).filter((text) =>
      /Applications et dépôts|Scénario d’accès|Définition du périmètre/.test(text),
    );
    expect(headings).toEqual([
      'Applications et dépôts',
      'Scénario d’accès et exploration',
      'Définition du périmètre',
    ]);
    const card = dashboard.locator('.inc-acc');
    // Trois modes, l'exploration automatique par défaut ; aucune vidéo.
    expect(await card.locator('[role="radio"]').allTextContents()).toEqual([
      expect.stringContaining('Explorer automatiquement'),
      expect.stringContaining('Parcours guidé'),
      expect.stringContaining('Démonstration'),
    ]);
    expect(await card.locator('#inc-acc-mode-AUTO').getAttribute('aria-checked')).toBe('true');
    expect(await card.locator('input[type="file"], video').count()).toBe(0);
    // Les détails sont dépliés AVANT la saisie de l'écran : le dernier rendu a été fait écran vide, et
    // « Localiser » doit pourtant rester cliquable (la frappe ne redessine pas la carte).
    await card.locator('button[data-action="inc-acc-more"]').click();
    expect(await card.locator('button[data-action="inc-acc-locate"]').isEnabled()).toBe(true);
    await card.locator('#inc-acc-target').fill('création d’un nouveau dossier');
    await card.locator('#inc-acc-narrative').fill(SYMPTOM);
    // Aucun redessin pendant la frappe : le focus reste dans le champ.
    expect(await focused(card.locator('#inc-acc-narrative'))).toBe(true);
    await card.locator('#inc-acc-testData').fill('compte recette, mot de passe : Secret123');
    expect(await focused(card.locator('#inc-acc-testData'))).toBe(true);
    await shot(dashboard, '1-saisie');

    // Localiser : la saisie est enregistrée d'abord, puis l'écran est trouvé dans le code.
    await card.locator('button[data-action="inc-acc-locate"]').click();
    await card.locator('#inc-acc-loc-t').waitFor({ timeout: 60_000 });
    expect(await card.locator('.inc-acc-status').textContent()).toContain(
      'Écran localisé : /dossiers/nouveau',
    );
    const chosen = card.locator('.inc-acc-scr.on');
    expect(await chosen.locator('b.mono').textContent()).toBe('/dossiers/nouveau');
    expect(await chosen.textContent()).toContain('DossierComponent');
    expect(await chosen.textContent()).toContain('lien « Nouveau dossier »');
    expect(await card.locator('.inc-acc-scr:not(.on) [data-action="inc-acc-choose"]').count()).toBe(1);
    expect(await card.locator('#inc-acc-path-found + ol li').allTextContents()).toEqual([
      expect.stringContaining('/dossiers'),
      expect.stringContaining('Nouveau dossier'),
    ]);
    const saved = await client.incidents.get(project.id, incident.id);
    expect(saved.access?.target).toBe('création d’un nouveau dossier');
    expect(saved.access?.testData).toBe('compte recette, mot de passe : [masqué]');
    expect(JSON.stringify(saved)).not.toContain('Secret123');
    await shot(dashboard, '2-localise');

    // Préparer : le parcours est joué dans un vrai navigateur, l'écran est atteint et inventorié.
    await card.locator('button[data-action="inc-acc-prepare"]').click();
    await card.locator('#inc-acc-prep-t').waitFor({ timeout: 90_000 });
    expect(await card.locator('#inc-acc-prep-t').textContent()).toContain('Écran atteint');
    const inventory = (await card.locator('.inc-acc-inv').textContent()) ?? '';
    expect(inventory).toContain('Enregistrer');
    expect(inventory).toContain('Code');
    expect(await card.locator('button[data-action="inc-acc-explore"]').isEnabled()).toBe(true);
    await shot(dashboard, '3-prepare');

    // Lancer : le moteur explore depuis l'écran ; la progression vient du run réel.
    await card.locator('#inc-acc-depth').selectOption('QUICK');
    await card.locator('button[data-action="inc-acc-explore"]').click();
    await card.locator('#inc-acc-prog-t').waitFor();
    const progress = card.locator('.inc-acc-prog');
    expect(await progress.locator('.inc-acc-ph').count()).toBe(9);
    // Le run atteint la fin : résultats affichés (≤ 4 min).
    await card.locator('#inc-acc-out-t').waitFor({ timeout: 240_000 });
    const stats = (await progress.locator('.inc-acc-stats').textContent()) ?? '';
    expect(stats).toMatch(/Séquences exécutées\d+/);
    expect(stats).toContain('Limites restantes');
    expect(await progress.textContent()).not.toMatch(/\d+ ?%/);
    const out = card.locator('.inc-acc-out');
    const results = (await out.textContent()) ?? '';
    expect(results).toContain('Séquence déclenchante');
    expect(results).toContain('Code = « vide »');
    expect(results).toContain('ouvrir « Notes »');
    expect(results).toMatch(
      /Anomalie reproduite \d fois sur \d : le symptôme est confirmé, la cause reste à vérifier/,
    );
    expect(results).toContain('Conditions découvertes');
    expect(await out.locator('[data-action="ws-ux-tab"][data-tab="tminimal"]').count()).toBe(1);
    const done = await client.incidents.get(project.id, incident.id);
    const run = done.investigation.trigger?.runs.find((item) => item.id === done.access?.exploration?.runId);
    expect(run?.entry?.source).toBe('TARGET');
    expect(done.investigation.diagnosis?.status ?? 'INCONCLUSIVE').not.toBe('CONFIRMED');
    await shot(dashboard, '4-resultats');

    // Démonstration : un enregistrement (module Enregistrements), jamais une vidéo.
    await card.locator('#inc-acc-mode-DEMO').click();
    await card.getByText('Aucun enregistrement dans ce projet.').waitFor();
    expect(await card.locator('button[data-action="inc-acc-rec-start"]').count()).toBe(1);
    expect(await card.locator('input[type="file"], video').count()).toBe(0);
    await card.locator('#inc-acc-mode-GUIDED').click();
    await card.locator('#inc-acc-steps-l').waitFor();

    dashboard = await openScope(page);
    const again = dashboard.locator('.inc-acc');
    expect(await again.locator('#inc-acc-target').inputValue()).toBe('création d’un nouveau dossier');
    expect(await again.locator('#inc-acc-narrative').inputValue()).toBe(SYMPTOM);
    expect(await again.locator('#inc-acc-out-t').count()).toBe(1);

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dashboard.locator('#ws-ux-sub-summary').click();
    await dashboard.locator('.inc-acc-sum').waitFor();
    const summary = (await dashboard.locator('.inc-acc-sum').textContent()) ?? '';
    expect(summary).toContain('Écran cible : création d’un nouveau dossier (/dossiers/nouveau)');
    expect(summary).toContain('Écran atteint');
    expect(summary).toMatch(/Exploration : /);

    const report = (await client.incidents.report(project.id, incident.id, {
      format: 'markdown',
    } as never)) as unknown as {
      markdown: string;
    };
    expect(report.markdown).toContain("### Scénario d'accès");
    expect(report.markdown).toContain('**Écran cible** : création d’un nouveau dossier');
    expect(report.markdown).toContain('**Écran localisé** : /dossiers/nouveau');
    expect(report.markdown).toContain('**Écran atteint**');
    expect(report.markdown).not.toContain('Secret123');
    expect(errors).toEqual([]);
    await page.close();
  }, 400_000);
});
