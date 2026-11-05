import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Environment,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startCartographyApp, type CartographyApp } from '../fixtures/cartography-app.js';

/**
 * L'ÉCRAN CARTOGRAPHIE DANS CHROMIUM, avec le vrai serveur et le vrai moteur : le mini-projet de
 * référence est scanné depuis l'écran ; l'exploration est progressive (une page de fonctionnalités, puis
 * les champs de « Request create », puis la fiche du champ « Company name » et son sous-graphe), sans
 * jamais télécharger le graphe complet ; une décision est prise ; la preuve ouvre l'extrait de code ; la
 * couverture suit une exécution réelle ; après une modification du code, l'impact propose les scénarios et
 * le rejeu de la sélection est lancé.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography');
let app: CartographyApp;
let server: RunningSdkServer;
let workspace: string;
let sourcesRoot: string;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;
let browser: Browser;
let page: Page;
/** Les appels de l'écran à l'API de cartographie, dans l'ordre. */
const calls: string[] = [];

const dashboard = (): Locator => page.locator('qa-crawler-dashboard');
const CREATE = `name: Create a request
startAt: /requests/new
steps:
  - fill: { label: Company name, value: Example Ltd }
  - fill: { label: Contact email, value: contact@example.test }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { response: { method: POST, url: /api/requests, status: 201 } }
`;

async function scanned(): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await client.cartography.currentScan(project.id)).state !== 'RUNNING') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the scan did not finish in time');
}

beforeAll(async () => {
  app = await startCartographyApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-map-'));
  sourcesRoot = await mkdtemp(path.join(tmpdir(), 'sdk-dashboard-map-sources-'));
  await cp(FIXTURE, sourcesRoot, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr', env: {}, allowedSourceRoots: [sourcesRoot] });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: `${app.url}/`, framework: 'angular' },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'create-request.yaml'), CREATE);
  environment = await client.environments.create(project.id, {
    name: 'Test',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 5 },
  });
  await client.cartography.saveConfig(project.id, {
    sources: (
      [
        ['front', 'FRONTEND'],
        ['bff', 'BFF'],
        ['backend', 'BACKEND'],
        ['contracts', 'API'],
      ] as const
    ).map(([id, layer]) => ({
      id,
      name: id,
      layer,
      path: path.join(sourcesRoot, id),
      include: [],
      enabled: true,
    })),
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('request', (request) => {
    const url = new URL(request.url());
    const at = url.pathname.indexOf('/cartography');
    if (at >= 0) calls.push(`${request.method()} ${url.pathname.slice(at)}${url.search}`);
  });
}, 60_000);

afterAll(async () => {
  await browser.close();
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(sourcesRoot, { recursive: true, force: true });
});

describe('Dashboard — functional map, in Chromium', () => {
  /** Un appel qui renverrait le graphe complet : la vue entière, sans sous-chemin. */
  const fullGraph = (call: string): boolean => /^GET \/cartography(\?|$)/.test(call);

  it('runs a scan from the screen; the overview loads a summary and one page, never the whole graph', async () => {
    await page.goto(`${server.url}/dashboard`);
    await dashboard().locator('select[data-action="project-context"]').selectOption(project.id);
    const entry = dashboard().locator('.drawer [data-action="nav"][data-view="cartography"]');
    expect(await entry.textContent()).toBe('Cartographie');
    await entry.click();
    await dashboard().locator('.map .msg', { hasText: 'Aucun scan' }).waitFor();
    await dashboard().locator('.map-head [data-action="map-scan"]').click();
    await dashboard().locator('.notice', { hasText: 'Scan terminé.' }).waitFor({ timeout: 30_000 });
    await dashboard().locator('.map-kpis').waitFor();
    expect(
      await dashboard().locator('.map-kpi', { hasText: 'Fonctionnalités' }).locator('b').textContent(),
    ).toBe('4');
    // Aucun scénario exécuté : la couverture est mesurée, à 0 %, avec sa formule.
    expect(await dashboard().locator('.map-kpi', { hasText: 'Couverture' }).locator('b').textContent()).toBe(
      '0 %',
    );
    // La liste est paginée par le serveur : une page de cinq au plus, le total annoncé.
    await dashboard().locator('.map-flist .map-item').first().waitFor();
    expect(await dashboard().locator('.map-flist h2').textContent()).toContain('(4)');
    expect(calls.some((call) => call.startsWith('GET /cartography/summary'))).toBe(true);
    expect(calls.some((call) => call.startsWith('GET /cartography/features?'))).toBe(true);
    expect(calls.filter(fullGraph)).toEqual([]);
  }, 60_000);

  it('level 1 → 2 → 3: Request create, its fields, then the trace of Company name, loaded on demand', async () => {
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="features"]').click();
    await dashboard().locator('input[data-map="f-q"]').fill('request create');
    const item = dashboard().locator('.map-flist .map-item', { hasText: 'Request create' });
    await item.waitFor();
    // La recherche part au serveur après une courte pause de saisie.
    await expect.poll(() => dashboard().locator('.map-flist .map-item').count()).toBe(1);
    const before = calls.length;
    await item.click();
    await dashboard().locator('.map-center h2', { hasText: 'Request create' }).waitFor();
    // Niveau 2 : seuls les champs de cette fonctionnalité, demandés pour elle.
    await dashboard()
      .locator('.map-center [role="tab"][data-action="map-center-tab"][data-tab="fields"]')
      .click();
    await dashboard().locator('input[data-map="c-q"]').fill('company');
    const row = dashboard().locator('.map-center .map-frow', { hasText: 'Company name' });
    await row.waitFor();
    await expect.poll(() => dashboard().locator('.map-center .map-frow').count()).toBe(1);
    await row.click();
    const details = dashboard().locator('.map-fdetails');
    await details.locator('dd b', { hasText: 'Company name' }).waitFor();
    const requested = calls.slice(before);
    expect(requested.some((call) => call.startsWith('GET /cartography/feature?id='))).toBe(true);
    expect(
      requested.some((call) => call.startsWith('GET /cartography/feature-fields?') && call.includes('id=')),
    ).toBe(true);
    expect(
      requested.some((call) => call.startsWith('GET /cartography/field?') && call.includes('limit=60')),
    ).toBe(true);
    expect(calls.filter(fullGraph)).toEqual([]);
    // Niveau 3 : le parcours principal, aéré : une carte par couche démontrée, de gauche à droite.
    await dashboard()
      .locator('.map-center [role="tab"][data-action="map-center-tab"][data-tab="trace"]')
      .click();
    const cards = dashboard().locator('.map-center .map-path .map-pcard');
    await cards.first().waitFor();
    expect(await cards.locator('.map-pc-h b').allTextContents()).toEqual([
      'Frontend',
      'BFF',
      'Backend',
      'Base de données',
    ]);
    expect(await cards.locator('.map-pc-h small').allTextContents()).toEqual([
      '(Angular)',
      '(Spring)',
      '(Spring)',
      '(JPA)',
    ]);
    // Le lien vers le backend passe par une adresse lue dans la configuration : probable, dit comme tel.
    expect(await cards.nth(2).locator('.map-pc-st.c-probable').count()).toBe(1);
    expect(await dashboard().locator('.map-center .map-plink .map-pa.c-probable').count()).toBe(1);
    expect(await dashboard().locator('.map-center h3', { hasText: 'Homonymes' }).count()).toBe(1);
    // Un compteur de liens ouvre la liste exacte des relations de cette étape.
    await cards.nth(1).locator('[data-action="map-rel-step"]').click();
    const relations = dashboard().locator('.map-center .map-rel');
    await relations.locator('summary', { hasText: 'Étape : BFF' }).waitFor();
    const rows = relations.locator('tbody tr');
    expect(await rows.count()).toBe(3);
    expect(await rows.allTextContents()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/BackendRequest.*Body.*organization.*Name.*CreateRequest.*Command/s),
      ]),
    );
    expect(await relations.locator('tbody .pill', { hasText: 'probable' }).count()).toBe(2);
    // Réutilisations, preuves et impact, dans les panneaux du champ.
    const right = dashboard().locator('.map-right');
    expect(await right.locator('.map-fd-reuse .map-reused').textContent()).toContain('Request edit');
    expect(await right.locator('.map-fd-proofs .map-pv-l li').count()).toBeGreaterThan(0);
    const impact = dashboard().locator('.map-icard');
    expect(await impact.textContent()).toContain('Company name');
    await impact.locator('[data-action="map-impact-open"]').click();
    expect(await impact.locator('.map-tag.ok', { hasText: 'RequestCreateComponent' }).count()).toBe(1);
    expect(await impact.locator('.map-tag.warn', { hasText: 'REQUEST.ORGANIZATION_NAME' }).count()).toBe(1);
    // Le rejeu est préparé (scénario démontré coché), jamais lancé sans action explicite.
    expect(
      await impact.locator('input[data-map="field-pick"][data-scenario="Create a request"]').isChecked(),
    ).toBe(true);
    expect(await client.executions.list(project.id)).toEqual([]);
  });

  it('the evidence opens the code of the mapping, at its line', async () => {
    await dashboard()
      .locator('.map-center .map-pcard')
      .nth(3)
      .locator('[data-action="map-rel-step"]')
      .click();
    const mapping = dashboard()
      .locator('.map-center .map-rel tbody tr', { hasText: 'CreateRequest' })
      .first();
    await mapping.locator('[data-action="map-evidence"]').click();
    await dashboard().locator('.map-ev .hit').waitFor();
    expect(await dashboard().locator('.map-ev .hit').textContent()).toContain('setOrganizationName');
    expect(calls.some((call) => call.startsWith('GET /cartography/evidence?'))).toBe(true);
    await dashboard().locator('[data-action="map-evidence-close"]').click();
  });

  it('the full graph zooms, fits, goes full screen, selects a node, then the main path comes back', async () => {
    const center = dashboard().locator('.map-center');
    await center.locator('[data-action="map-g-mode"][data-mode="full"]').click();
    await center.locator('svg.map-graph').waitFor();
    const zoom = center.locator('.map-gzoom');
    await center.locator('[data-action="map-g-zoom"][data-dir="1"]').click();
    expect(await zoom.textContent()).toBe('120 %');
    const transform = (): Promise<string | null> => center.locator('.map-canvas-in').getAttribute('style');
    expect(await transform()).toContain('scale(1.2)');
    await center.locator('[data-action="map-g-fit"]').click();
    // Ajusté à la vue : le graphe entier tient dans la zone (mesuré dans la page).
    await expect.poll(() => zoom.textContent()).not.toBe('120 %');
    const box = await center.locator('.map-canvas').boundingBox();
    const svg = await center.locator('svg.map-graph').boundingBox();
    expect(svg && box && svg.width <= box.width + 1).toBe(true);
    // Déplacer la vue en glissant.
    const before = await transform();
    if (box) {
      await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 80, box.y + box.height - 50, { steps: 4 });
      await page.mouse.up();
    }
    expect(await transform()).not.toBe(before);
    // Plein écran, puis Échap.
    await center.locator('[data-action="map-g-full"]').click();
    await dashboard().locator('.map-trace.full').waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => dashboard().locator('.map-trace.full').count()).toBe(0);
    // La vue déplacée peut avoir sorti le nœud du cadre : on réajuste, puis on le choisit.
    await center.locator('[data-action="map-g-fit"]').click();
    // Un nœud choisi : sa fiche, ses preuves, ses relations seulement ; les autres sont atténués.
    await center.locator('svg.map-graph .map-g-n.focus').click();
    await center.locator('.map-gsel', { hasText: 'Company name' }).waitFor();
    expect(await center.locator('.map-gsel [data-action="map-evidence"]').count()).toBeGreaterThan(0);
    expect(await center.locator('svg.map-graph .map-g-n.dim').count()).toBeGreaterThan(0);
    await center.locator('.map-rel summary', { hasText: 'Sélection du graphe' }).waitFor();
    // Retour au parcours principal.
    await center.locator('[data-action="map-g-mode"][data-mode="path"]').click();
    await center.locator('.map-path .map-pcard').first().waitFor();
    expect(await zoom.textContent()).toBe('100 %');
    expect(calls.filter(fullGraph)).toEqual([]);
  });

  it('the reuse of a field opens the other feature on the same field; a decision is recorded', async () => {
    await dashboard()
      .locator('.map-right [data-action="map-reuse-open"]', { hasText: 'Request edit' })
      .click();
    await dashboard().locator('.map-center h2', { hasText: 'Request edit' }).waitFor();
    await dashboard().locator('.map-fdetails dd', { hasText: 'Request edit' }).waitFor();
    expect(await dashboard().locator('.map-fdetails dd b').first().textContent()).toBe('Company name');
    await dashboard()
      .locator('.map-center [role="tab"][data-action="map-center-tab"][data-tab="summary"]')
      .click();
    await dashboard().locator('.map-center [data-action="map-decide"][data-kind="CONFIRM"]').click();
    await dashboard().locator('.notice', { hasText: 'Décision enregistrée.' }).waitFor();
    const view = await client.cartography.get(project.id);
    expect(view.decisions.map((d) => d.kind)).toEqual(['CONFIRM']);
    await dashboard().locator('.map-center .map-head-c .pill', { hasText: 'confirmée' }).waitFor();
    expect(calls.filter(fullGraph)).toEqual([]);
  });

  it('the fields tab searches the concepts on the server and lists the divergences', async () => {
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="fields"]').click();
    await dashboard().locator('input[data-map="k-q"]').fill('ORGANIZATION_NAME');
    await expect
      .poll(() =>
        calls.some(
          (call) => call.startsWith('GET /cartography/concepts?') && call.includes('q=ORGANIZATION_NAME'),
        ),
      )
      .toBe(true);
    const concept = dashboard().locator('.map-c', { hasText: 'Company name' });
    await concept.first().waitFor();
    await concept.first().click();
    const sheet = dashboard().locator('.map-concept');
    await sheet.locator('h2', { hasText: 'Company name' }).waitFor();
    expect(await sheet.locator('h3', { hasText: 'Homonymes' }).count()).toBe(1);
    expect(await dashboard().locator('.map-issues').textContent()).toContain(
      'longueurs maximales différentes (120 / 100)',
    );
  });

  it('the coverage follows a real execution: associated, executed, verified by assertion', async () => {
    const started = await client.executions.start(project.id, { environmentId: environment.id });
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const status = (await client.explorations.status(started.id)).status;
      if (status !== 'RUNNING' && status !== 'QUEUED') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await dashboard().locator('[data-action="map-refresh"]').click();
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="coverage"]').click();
    const row = dashboard().locator('.map-matrix tr', { hasText: 'Request create' });
    await row.waitFor();
    await row.locator('[data-action="map-feature"]').click();
    await dashboard().locator('.map-links', { hasText: 'Create a request' }).waitFor();
    // Associé, traversé, vérifié, réussi, champs obligatoires saisis ; aucun chemin négatif joué.
    expect(await row.locator('.map-crit').allTextContents()).toEqual(['✓', '✓', '✓', '✓', '✓', '✗']);
    expect(await row.textContent()).toContain('Partielle');
    expect(await dashboard().locator('.map-links').textContent()).toContain(started.run ?? '');
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="features"]').click();
    const scenario = dashboard().locator('.map-scards tr', { hasText: 'Create a request' });
    await scenario.waitFor();
    expect(await scenario.locator('.pill').textContent()).toBe('vérifié par assertion');
  }, 180_000);

  it('APIs & Services: real KPIs, the external partner, its path and fields, renamed from the screen', async () => {
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="apis"]').click();
    await dashboard().locator('.map-acat .map-aitem').first().waitFor();
    expect(await dashboard().locator('.map-hd h1').textContent()).toBe('Cartographie des API & Services');
    const kpi = async (label: string): Promise<string | null> =>
      dashboard().locator('.map-kpi', { hasText: label }).locator('b').textContent();
    expect([
      await kpi('API & Services'),
      await kpi('API internes'),
      await kpi('API externes'),
      await kpi('Endpoints'),
    ]).toEqual(['6', '4', '1', '11']);
    // « Planifier » n'existe pas encore : le bouton le dit, désactivé, sans faux succès.
    expect(await dashboard().locator('.map-hd button', { hasText: 'Planifier' }).isDisabled()).toBe(true);
    await dashboard().locator('[data-action="map-api-scope"][data-scope="EXTERNAL"]').click();
    await expect.poll(() => dashboard().locator('.map-acat .map-aitem').count()).toBe(1);
    await dashboard().locator('.map-acat .map-aitem', { hasText: 'Partner' }).click();
    const center = dashboard().locator('.map-acenter');
    await center.locator('h2', { hasText: 'Partner Verification' }).waitFor();
    // Le parcours démontré : écran → BFF → Backend → API externe (carte finale).
    expect(await center.locator('.map-path .map-pc-h b').allTextContents()).toEqual([
      'Frontend',
      'BFF',
      'Backend',
      'API externe',
    ]);
    expect(await center.locator('.map-agen').textContent()).toContain('partner.url');
    expect(await center.locator('.map-acon').textContent()).toContain('Aucun contrat trouvé');
    const fields = dashboard().locator('.map-afields');
    expect(
      await fields.locator('tr', { hasText: 'companyName' }).locator('.map-dir').textContent(),
    ).toContain('Sortant');
    expect(await fields.locator('tr', { hasText: 'errorCode' }).locator('.map-dir').textContent()).toContain(
      'Entrant',
    );
    expect(await dashboard().locator('.map-afeat tbody').textContent()).toContain('Company form');
    expect(calls.some((call) => call.startsWith('GET /cartography/apis?'))).toBe(true);
    expect(calls.some((call) => call.startsWith('GET /cartography/api?'))).toBe(true);
    // Renommer : un nom métier enregistré comme décision, le code et l'identifiant inchangés.
    await center.locator('[data-action="map-api-rename-open"]').click();
    await center.locator('input[data-map="api-name"]').fill('Company verification');
    await center.locator('form[data-action="map-api-rename"] button[type="submit"]').click();
    await dashboard().locator('.notice', { hasText: 'Décision enregistrée.' }).waitFor();
    await center.locator('h2', { hasText: 'Company verification' }).waitFor();
    const external = (await client.cartography.apis(project.id, { scope: 'EXTERNAL' })).items[0];
    expect(external?.name).toBe('Company verification');
    expect(external?.technicalName).toBe('PartnerVerificationClient');
    expect(calls.filter(fullGraph)).toEqual([]);
  });

  it('after a change in the code, the impact proposes the scenario and replays the selection', async () => {
    const component = path.join(sourcesRoot, 'front/src/app/requests/request-create.component.ts');
    await writeFile(
      component,
      (await readFile(component, 'utf8')).replace('Validators.maxLength(120)', 'Validators.maxLength(100)'),
    );
    await client.cartography.scan(project.id);
    await scanned();
    await dashboard().locator('[data-action="map-refresh"]').click();
    await dashboard().locator('.map-tabs [data-action="map-tab"][data-tab="impact"]').click();
    await dashboard().locator('[data-action="map-impact"]').click();
    await dashboard().locator('.map-impact').waitFor();
    expect(await dashboard().locator('.map-impact').textContent()).toContain('maxLength : 120 → 100');
    const pick = dashboard().locator('input[data-map="impact-pick"][data-scenario="Create a request"]');
    expect(await pick.isChecked()).toBe(true);
    await dashboard().locator('select[data-map="impact-env"]').selectOption(environment.id);
    await dashboard().locator('[data-action="map-impact-launch"]').click();
    await page.waitForFunction(() =>
      document
        .querySelector('qa-crawler-dashboard')
        ?.shadowRoot?.querySelector('.main h1')
        ?.textContent.includes('run-'),
    );
    const executions = await client.executions.list(project.id);
    expect(executions[0]?.scenarios).toEqual(['Create a request']);
    // De bout en bout, l'écran n'a jamais demandé le graphe complet (l'export n'a pas été utilisé).
    expect(calls.filter(fullGraph)).toEqual([]);
  }, 120_000);
});
