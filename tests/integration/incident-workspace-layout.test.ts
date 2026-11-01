import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Incident } from '../../src/incident/model.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startIncidentSite, type IncidentSite } from '../fixtures/incident-site.js';

/**
 * LA DISPOSITION EN PANNEAUX DE L'ESPACE D'INVESTIGATION (v2, façon IDE), dans Chromium, sur l'incident
 * connu réellement reproduit et analysé (tests/fixtures/incident-app) : pas de défilement de la page aux
 * tailles de bureau, panneaux visibles ensemble et qui défilent chacun en eux-mêmes, séparateurs au
 * pointeur et au clavier, agrandir / réduire / masquer, sélection synchronisée jusque dans l'éditeur,
 * éditeur à onglets (recherche, « Aller à la ligne »), préférences relues après rechargement (et page
 * intacte sans stockage), en-tête et progression repliables, clavier, écran étroit, démonstration et
 * thème sombre.
 */
let site: IncidentSite;
let server: RunningSdkServer;
let workspace: string;
let repos: string;
let service: QaCrawlerClient;
let project: Project;
let incident: Incident;
let browser: Browser;

const FAILING = 'Créer un livre sans éditeur';
const PASSING = 'Créer un livre avec éditeur';
const PREFS_KEY = 'qa-crawler:incident-workspace:v2';
const REQUEST_NODE = 'request:rep_1:req-3-1';

const MAIN_TABS = ['overview', 'timeline', 'traceability', 'code', 'diagnosis', 'report'] as const;
type MainTab = (typeof MAIN_TABS)[number];
const SUB_TABS: Record<MainTab, readonly string[]> = {
  overview: ['summary', 'scope', 'environment'],
  timeline: ['run', 'evidence', 'events', 'logs'],
  traceability: ['fullstack', 'frontend', 'bff', 'backend', 'http'],
  code: [],
  diagnosis: ['diagnosis', 'hypotheses', 'experiments'],
  report: ['report', 'regression'],
};
const TRACE_PANES = ['primary', 'details', 'tree', 'editor', 'evidence'] as const;
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;
const MUTATING =
  /^(inc-(reproduce|cancel|resume|validate|scope-edit|ext-approve|ext-reject|app-add|app-remove)|ws-dx-(analyze|plan|plan-submit|run|approve|diagnose|regression)|ws-ux-target-save)$/;

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
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-layout-ws-'));
  repos = await mkdtemp(path.join(tmpdir(), 'incident-layout-repos-'));
  await cp(path.join(import.meta.dirname, '../fixtures/incident-app'), repos, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr' });
  service = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await service.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: `${site.url}/books`, framework: 'other' },
  });
  const environment = await service.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: site.url,
    mutations: { enabled: true, maxPerRun: 5 },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows', 'books');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'sans-editeur.flow.yaml'), flow(FAILING));
  await writeFile(path.join(flows, 'avec-editeur.flow.yaml'), flow(PASSING, 'Éditions du Nord'));
  const app = (
    id: string,
    name: string,
    layer: 'FRONTEND' | 'BFF' | 'BACKEND',
    dir: string,
    include: string,
  ) => ({ id, name, layer, repository: { root: path.join(repos, dir), include: [include] } });
  incident = await service.incidents.create(project.id, {
    title: 'Erreur 500 à la création d’un livre',
    description:
      'Lors de la création d’un livre, après avoir cliqué sur Enregistrer, l’application affiche une erreur HTTP 500.',
    observed: 'Erreur HTTP 500 après Enregistrer',
    expected: 'Livre créé',
    severity: 'HIGH',
    scenario: FAILING,
    environmentId: environment.id,
    scope: {
      applications: [
        app('front', 'Frontend', 'FRONTEND', 'frontend', 'src'),
        app('bff', 'BFF', 'BFF', 'bff', 'src/main'),
        app('catalog', 'Catalogue', 'BACKEND', 'backend', 'src/main'),
      ],
      scenarios: [FAILING, PASSING],
    },
  });
  await service.incidents.reproduce(project.id, incident.id);
  const started = Date.now();
  for (;;) {
    incident = await service.incidents.get(project.id, incident.id);
    if (incident.state !== 'REPRODUCING') break;
    if (Date.now() - started > 150_000) throw new Error('reproduction timed out');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  incident = await service.incidents.analyze(project.id, incident.id);
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser.close();
  service.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(repos, { recursive: true, force: true });
});

interface Opened {
  page: Page;
  dash: Locator;
  errors: string[];
  width: number;
}

interface OpenOptions {
  width?: number;
  height?: number;
  query?: string;
  init?: () => void;
}

async function openMenu(dash: Locator): Promise<void> {
  if ((await dash.locator('.dash').getAttribute('data-menu')) === 'closed')
    await dash.locator('[data-action="menu"]').first().click();
  await dash.locator('.drawer [data-action="nav"][data-view="incidents"]').waitFor({ state: 'visible' });
}

/** Ouvre le Dashboard et choisit le projet (sans accès nominatif : pas de connexion). */
async function openDashboard(options: OpenOptions = {}): Promise<Opened> {
  const width = options.width ?? 1440;
  const page = await browser.newPage({ viewport: { width, height: options.height ?? 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (options.init) await page.addInitScript(options.init);
  await page.goto(`${server.url}/dashboard${options.query ?? ''}`);
  const dash = page.locator('qa-crawler-dashboard');
  await dash.locator('select[data-action="project-context"]').first().waitFor({ state: 'attached' });
  if (width <= 960) await openMenu(dash);
  await dash.locator('select[data-action="project-context"]').selectOption(project.id);
  // Le choix du projet redessine la page (menu compris) : attendre qu'elle soit stable.
  await page.waitForTimeout(400);
  return { page, dash, errors, width };
}

/** Ouvre l'incident depuis la liste ; `tab` : l'onglet principal attendu (préférence relue). */
async function openIncident(opened: Opened, tab: MainTab = 'overview'): Promise<void> {
  if (opened.width <= 960) await openMenu(opened.dash);
  await opened.dash.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
  await opened.dash.locator(`button[data-action="inc-open"][data-incident="${incident.id}"]`).first().click();
  await opened.dash.locator(`#ws-ux-tab-${tab}[aria-selected="true"]`).waitFor();
}

async function open(options: OpenOptions = {}): Promise<Opened> {
  const opened = await openDashboard(options);
  await openIncident(opened);
  return opened;
}

async function openMain(opened: Opened, tab: MainTab): Promise<void> {
  await opened.dash.locator(`#ws-ux-tab-${tab}`).click();
  await opened.dash.locator(`#ws-ux-tab-${tab}[aria-selected="true"]`).waitFor();
}

async function openSub(opened: Opened, sub: string): Promise<void> {
  await opened.dash.locator(`#ws-ux-sub-${sub}`).click();
  await opened.dash.locator(`#ws-ux-sub-${sub}[aria-selected="true"]`).waitFor();
}

/** Évalue dans la racine fantôme du Dashboard. */
function inRoot<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(
    `(() => { const root = document.querySelector('qa-crawler-dashboard').shadowRoot; ${body} })()`,
  );
}

/** Le défilement du document (vertical et horizontal). */
const pageScroll = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      height: scroller.scrollHeight,
      inner: window.innerHeight,
      top: scroller.scrollTop,
      width: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    };
  });

/** Les boîtes des panneaux affichés. */
const paneBoxes = (page: Page) =>
  inRoot<Record<string, { top: number; bottom: number; left: number; right: number; w: number; h: number }>>(
    page,
    `const out = {}; for (const p of root.querySelectorAll('[data-ws-pane]')) { const r = p.getBoundingClientRect();
       if (r.width > 0 && r.height > 0) out[p.dataset.wsPane] = { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; }
     return out;`,
  );

const canvasBox = (page: Page) =>
  inRoot<{ w: number; h: number } | null>(
    page,
    `const c = root.querySelector('[data-ws-pane="primary"] [data-ws-graph="canvas"]'); if (!c) return null;
     const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) };`,
  );

const splitterValue = async (dash: Locator, id: string): Promise<number> =>
  Number(await dash.locator(`[data-ws-splitter="${id}"]`).getAttribute('aria-valuenow'));

const activeSplitter = (page: Page) =>
  inRoot<string>(page, `return root.activeElement?.dataset?.wsSplitter ?? '';`);

/** Glisse un séparateur au pointeur (souris) de dx, dy pixels. */
async function drag(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error('splitter not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function selectRequestNode(opened: Opened): Promise<void> {
  await opened.dash.locator(`[data-ws-pane="primary"] .ws-graph-node[data-ref="${REQUEST_NODE}"]`).click();
  await opened.dash
    .locator(`[data-ws-pane="details"] .ws-ctx-body[data-sel="node:${REQUEST_NODE}"]`)
    .waitFor();
}

describe('Investigation Workspace v2 — layout without page scroll (Chromium)', () => {
  it('no page scroll at 1440×900, 1280×800 and 1024×768, on every main tab and every sub-tab', async () => {
    for (const size of SIZES) {
      const opened = await open(size);
      try {
        for (const tab of MAIN_TABS) {
          await openMain(opened, tab);
          const subs = SUB_TABS[tab];
          for (const sub of subs.length > 0 ? subs : ['']) {
            if (sub) await openSub(opened, sub);
            await opened.page.waitForTimeout(150);
            const scroll = await pageScroll(opened.page);
            const where = `${String(size.width)}×${String(size.height)} ${tab}/${sub}`;
            expect(scroll.height, where).toBeLessThanOrEqual(scroll.inner + 1);
            expect(scroll.width, where).toBeLessThanOrEqual(scroll.client);
          }
        }
        expect(opened.errors).toEqual([]);
      } finally {
        await opened.page.close();
      }
    }
  });

  it('traceability: the five panes are visible together; the graph canvas keeps a usable height', async () => {
    for (const [size, minCanvas] of [
      [SIZES[0], 200],
      [SIZES[2], 120],
    ] as const) {
      const opened = await open(size);
      try {
        await openMain(opened, 'traceability');
        await opened.page.waitForTimeout(300);
        const boxes = await paneBoxes(opened.page);
        if (size.width === 1440)
          for (const pane of TRACE_PANES) {
            const box = boxes[pane];
            expect(box, pane).toBeDefined();
            expect(box?.w ?? 0, pane).toBeGreaterThan(40);
            expect(box?.h ?? 0, pane).toBeGreaterThan(40);
            expect(box?.top ?? -1, pane).toBeGreaterThanOrEqual(0);
            expect(box?.bottom ?? Infinity, pane).toBeLessThanOrEqual(size.height);
            expect(box?.right ?? Infinity, pane).toBeLessThanOrEqual(size.width);
          }
        const canvas = await canvasBox(opened.page);
        expect(canvas?.h ?? 0, `${String(size.width)} canvas`).toBeGreaterThanOrEqual(minCanvas);
        expect(canvas?.w ?? 0).toBeGreaterThan(200);
      } finally {
        await opened.page.close();
      }
    }
  });

  it('each pane scrolls by itself: the wheel moves only that pane, the document stays at the top', async () => {
    const opened = await open();
    const { page, dash } = opened;
    try {
      await openMain(opened, 'traceability');
      // Une sélection allonge les détails et ouvre le fichier relié dans l'éditeur.
      await selectRequestNode(opened);
      await dash.locator('[data-ws-pane="editor"] .ws-code-scroll .ws-code-target').waitFor();
      await page.waitForTimeout(300);
      const scrollers = `const pick = (pane) => { const p = root.querySelector('[data-ws-pane="' + pane + '"]');
          const all = [p, ...p.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1);
          if (pane === 'editor') return p.querySelector('.ws-code-scroll');
          return all.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0] ?? null; };`;
      for (const pane of ['details', 'tree', 'editor', 'evidence'] as const) {
        const before = await inRoot<Record<string, number>>(
          page,
          `${scrollers} const out = {}; for (const id of ['primary', 'details', 'tree', 'editor', 'evidence']) { const s = pick(id); if (s) out[id] = s.scrollTop; } return out;`,
        );
        const target = await inRoot<{ x: number; y: number; room: number } | null>(
          page,
          `${scrollers} const s = pick(${JSON.stringify(pane)}); if (!s) return null; s.scrollTop = 0; const r = s.getBoundingClientRect();
           return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40), room: s.scrollHeight - s.clientHeight };`,
        );
        expect(target, `${pane} has its own scroll container`).not.toBeNull();
        expect(target?.room ?? 0, `${pane} overflows`).toBeGreaterThan(20);
        before[pane] = 0;
        await page.mouse.move(target?.x ?? 0, target?.y ?? 0);
        await page.mouse.wheel(0, 120);
        await expect
          .poll(() => inRoot<number>(page, `${scrollers} return pick(${JSON.stringify(pane)}).scrollTop;`))
          .toBeGreaterThan(0);
        const after = await inRoot<Record<string, number>>(
          page,
          `${scrollers} const out = {}; for (const id of ['primary', 'details', 'tree', 'editor', 'evidence']) { const s = pick(id); if (s) out[id] = s.scrollTop; } return out;`,
        );
        for (const [other, top] of Object.entries(before))
          if (other !== pane) expect(after[other], `${pane} wheel moved ${other}`).toBe(top);
        expect((await pageScroll(page)).top, `${pane} wheel moved the document`).toBe(0);
      }
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('splitters: mouse drag resizes (kept after a repaint), keyboard moves aria-valuenow with the focus kept, double click resets', async () => {
    const opened = await open();
    const { page, dash } = opened;
    try {
      await openMain(opened, 'traceability');
      await page.waitForTimeout(300);
      const vertical = dash.locator('[data-ws-splitter="primary-details"]');
      const horizontal = dash.locator('[data-ws-splitter="top-bottom"]');
      expect(await vertical.getAttribute('role')).toBe('separator');
      expect(await vertical.getAttribute('aria-orientation')).toBe('vertical');
      expect(await horizontal.getAttribute('aria-orientation')).toBe('horizontal');
      const initial = await paneBoxes(page);
      const initialValue = await splitterValue(dash, 'primary-details');
      // Le séparateur vertical : le graphe perd 150 px, les détails les gagnent.
      await drag(page, vertical, -150, 0);
      await expect
        .poll(async () => (await paneBoxes(page)).primary?.w ?? 0)
        .toBeLessThan((initial.primary?.w ?? 0) - 100);
      const dragged = await paneBoxes(page);
      expect(dragged.details?.w ?? 0).toBeGreaterThan((initial.details?.w ?? 0) + 100);
      expect(await splitterValue(dash, 'primary-details')).toBeLessThan(initialValue);
      // Le séparateur horizontal : la zone haute gagne 80 px.
      await drag(page, horizontal, 0, 80);
      await expect
        .poll(async () => (await paneBoxes(page)).primary?.h ?? 0)
        .toBeGreaterThan((initial.primary?.h ?? 0) + 50);
      const resized = await paneBoxes(page);
      expect(resized.editor?.h ?? 0).toBeLessThan((initial.editor?.h ?? 0) - 50);
      // Un redessin (changement de sélection) garde les tailles.
      await selectRequestNode(opened);
      await page.waitForTimeout(300);
      const repainted = await paneBoxes(page);
      expect(Math.abs((repainted.primary?.w ?? 0) - (resized.primary?.w ?? 0))).toBeLessThanOrEqual(2);
      expect(Math.abs((repainted.primary?.h ?? 0) - (resized.primary?.h ?? 0))).toBeLessThanOrEqual(2);
      // Le clavier : flèches (2 %), Début / Fin, le focus reste sur le séparateur.
      await vertical.focus();
      const start = await splitterValue(dash, 'primary-details');
      await page.keyboard.press('ArrowRight');
      expect(await splitterValue(dash, 'primary-details')).toBe(start + 2);
      expect(await activeSplitter(page)).toBe('primary-details');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      expect(await splitterValue(dash, 'primary-details')).toBe(start - 2);
      expect(await activeSplitter(page)).toBe('primary-details');
      await page.keyboard.press('Home');
      const min = await splitterValue(dash, 'primary-details');
      expect(min).toBeLessThan(start - 2);
      expect(min).toBeGreaterThanOrEqual(Number(await vertical.getAttribute('aria-valuemin')));
      await page.keyboard.press('ArrowLeft');
      expect(await splitterValue(dash, 'primary-details')).toBe(min);
      await page.keyboard.press('End');
      const max = await splitterValue(dash, 'primary-details');
      expect(max).toBeGreaterThan(start);
      expect(max).toBeLessThanOrEqual(Number(await vertical.getAttribute('aria-valuemax')));
      expect(await activeSplitter(page)).toBe('primary-details');
      // Le graphe garde son minimum lisible, les détails aussi.
      const extreme = await paneBoxes(page);
      expect(extreme.details?.w ?? 0).toBeGreaterThanOrEqual(255);
      await horizontal.focus();
      const rows = await splitterValue(dash, 'top-bottom');
      await page.keyboard.press('ArrowUp');
      expect(await splitterValue(dash, 'top-bottom')).toBe(rows - 2);
      expect(await activeSplitter(page)).toBe('top-bottom');
      // Le double clic rend la taille par défaut (70 % et 58 %).
      await vertical.dblclick();
      await expect.poll(() => splitterValue(dash, 'primary-details')).toBe(70);
      await horizontal.dblclick();
      await expect.poll(() => splitterValue(dash, 'top-bottom')).toBe(58);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('pane operations: maximize (Escape restores), collapse to the header, hide and show again', async () => {
    const opened = await open();
    const { page, dash } = opened;
    try {
      await openMain(opened, 'traceability');
      await page.waitForTimeout(300);
      const before = await canvasBox(page);
      // Agrandir le graphe : seul panneau affiché, plus grand.
      await dash.locator('[data-ws-pane="primary"] .ws-pane-ops [data-op="max"]').click();
      await dash.locator('[data-ws-pane="primary"][data-mode="max"]').waitFor();
      await page.waitForTimeout(300);
      expect(Object.keys(await paneBoxes(page))).toEqual(['primary']);
      const maxed = await canvasBox(page);
      expect(maxed?.h ?? 0).toBeGreaterThan((before?.h ?? 0) + 100);
      expect(maxed?.w ?? 0).toBeGreaterThan(before?.w ?? 0);
      expect(
        await dash
          .locator('[data-ws-pane="primary"] .ws-pane-ops [data-op="restore"]')
          .getAttribute('aria-pressed'),
      ).toBe('true');
      expect((await pageScroll(page)).height).toBeLessThanOrEqual(900 + 1);
      await page.keyboard.press('Escape');
      await dash.locator('[data-ws-pane="primary"][data-mode="normal"]').waitFor();
      expect(Object.keys(await paneBoxes(page)).sort()).toEqual([...TRACE_PANES].sort());
      // Réduire les détails : la barre de titre seule.
      const details = dash.locator('[data-ws-pane="details"]');
      await details.locator('.ws-pane-ops [data-op="min"]').click();
      await dash.locator('[data-ws-pane="details"][data-mode="min"]').waitFor();
      expect(await details.locator('.ws-pane-b').isHidden()).toBe(true);
      expect(await details.locator('.ws-pane-h').isVisible()).toBe(true);
      const collapsed = await paneBoxes(page);
      expect(collapsed.details?.w ?? 999).toBeLessThanOrEqual(48);
      expect(collapsed.primary?.w ?? 0).toBeGreaterThan(before?.w ?? 0);
      await details.locator('.ws-pane-ops [data-op="restore"]').click();
      await dash.locator('[data-ws-pane="details"][data-mode="normal"]').waitFor();
      expect(await details.locator('.ws-pane-b').isVisible()).toBe(true);
      // Une sélection dans le graphe rouvre les détails réduits (bureau).
      await details.locator('.ws-pane-ops [data-op="min"]').click();
      await dash.locator('[data-ws-pane="details"][data-mode="min"]').waitFor();
      await selectRequestNode(opened);
      await dash.locator('[data-ws-pane="details"][data-mode="normal"]').waitFor();
      expect(await details.locator('.ws-pane-b').isVisible()).toBe(true);
      await page.keyboard.press('Escape');
      // « Plein écran » de la barre du graphe agrandit le panneau ; Échap le rétablit.
      await dash
        .locator('[data-ws-pane="primary"] .ws-pane-b [data-action="ws-pane"][data-op="max"]')
        .click();
      await dash.locator('[data-ws-pane="primary"][data-mode="max"]').waitFor();
      await page.keyboard.press('Escape');
      await dash.locator('[data-ws-pane="primary"][data-mode="normal"]').waitFor();
      // Masquer les preuves : rappelées dans la barre « Panneaux masqués », « Afficher » les rend.
      await dash.locator('[data-ws-pane="evidence"] .ws-pane-ops [data-op="hide"]').click();
      await dash.locator('[data-ws-pane="evidence"]').waitFor({ state: 'detached' });
      const show = dash.locator(
        '.ws-hidden-bar [data-action="ws-pane"][data-pane="evidence"][data-op="show"]',
      );
      expect(await dash.locator('.ws-hidden-bar').textContent()).toContain('Panneaux masqués');
      await show.click();
      await dash.locator('[data-ws-pane="evidence"]').waitFor();
      expect(await dash.locator('.ws-hidden-bar').count()).toBe(0);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('synchronized selection: the failing request node opens BookController.java at its line; the HTTP list highlights the graph', async () => {
    const opened = await open();
    const { page, dash } = opened;
    try {
      await openMain(opened, 'traceability');
      await selectRequestNode(opened);
      const editor = dash.locator('[data-ws-pane="editor"]');
      const target = editor.locator('.ws-code-scroll .ws-code-target');
      await target.waitFor();
      expect(await editor.locator('.ws-code-scroll').getAttribute('data-file')).toMatch(
        /bff\/books\/BookController\.java$/,
      );
      expect(await editor.locator('.ws-code-tab[aria-selected="true"]').textContent()).toContain(
        'BookController.java',
      );
      // La ligne visée est dans la partie visible de la vue du code.
      const visible = await inRoot<boolean>(
        page,
        `const ed = root.querySelector('[data-ws-pane="editor"]'); const s = ed.querySelector('.ws-code-scroll').getBoundingClientRect();
         const t = ed.querySelector('.ws-code-target').getBoundingClientRect(); return t.top >= s.top - 1 && t.bottom <= s.bottom + 1 && t.height > 0;`,
      );
      expect(visible).toBe(true);
      const details = (await dash.locator('[data-ws-pane="details"]').textContent()) ?? '';
      expect(details).toContain('POST /api/books');
      expect(details).toContain('500');
      // La liste HTTP : une requête choisie met son nœud en évidence dans le graphe, les détails suivent.
      await page.keyboard.press('Escape');
      await dash.locator('[data-ws-pane="details"] .ws-ctx-body[data-sel=""]').waitFor();
      await openSub(opened, 'http');
      await dash
        .locator('[data-ws-pane="primary"] .ws-timeline-path', { hasText: '/api/books' })
        .first()
        .click();
      await dash.locator('[data-ws-pane="details"] .ws-ctx-body[data-sel^="request:"]').waitFor();
      await dash.locator('[data-ws-pane="details"] .ws-timeline-detail').waitFor();
      await editor.locator('.ws-code-scroll .ws-code-target').waitFor();
      await openSub(opened, 'fullstack');
      const node = dash.locator(`[data-ws-pane="primary"] .ws-graph-node[data-ref="${REQUEST_NODE}"]`);
      expect(await node.getAttribute('class')).toMatch(/\bws-(related|selected)\b/);
      expect(await dash.locator('[data-ws-pane="details"] .ws-ctx-body').getAttribute('data-sel')).toMatch(
        /^request:/,
      );
      expect(await dash.locator('[data-ws-pane="details"] .ws-timeline-detail').count()).toBe(1);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('code editor: file tabs (open, switch, close), in-file search « n/m », Ctrl+G « Aller à la ligne », tree collapse', async () => {
    const opened = await open();
    const { page, dash } = opened;
    try {
      await openMain(opened, 'code');
      const tree = dash.locator('[data-ws-pane="tree"]');
      const editor = dash.locator('[data-ws-pane="editor"]');
      await tree.locator('.ws-code-file[data-action="ws-code-open"]').first().waitFor();
      const files = await tree
        .locator('.ws-code-file[data-action="ws-code-open"]')
        .evaluateAll((buttons) => buttons.map((b) => (b as HTMLElement).dataset.file ?? ''));
      const [first, second] = [...new Set(files)];
      expect(second).toBeDefined();
      await tree
        .locator(`.ws-code-file[data-file="${first ?? ''}"]`)
        .first()
        .click();
      await editor.locator(`.ws-code-scroll[data-file="${first ?? ''}"]`).waitFor();
      await tree
        .locator(`.ws-code-file[data-file="${second ?? ''}"]`)
        .first()
        .click();
      await editor.locator(`.ws-code-scroll[data-file="${second ?? ''}"]`).waitFor();
      expect(await editor.locator('.ws-code-tab').count()).toBe(2);
      // Changer d'onglet.
      const firstTab = editor.locator('.ws-code-tab', { hasText: path.basename(first ?? '') });
      await firstTab.click();
      await editor.locator(`.ws-code-scroll[data-file="${first ?? ''}"]`).waitFor();
      expect(await firstTab.getAttribute('aria-selected')).toBe('true');
      // Rechercher dans le fichier : « n/m », l'occurrence courante avance.
      const find = editor.locator('[data-ws-field="code-find"]');
      await find.fill('o');
      const count = editor.locator('#ws-code-find-count [aria-hidden="true"]');
      await expect.poll(async () => (await count.textContent()) ?? '').toMatch(/^1\/\d+\+?$/);
      const total = Number(/\/(\d+)/.exec((await count.textContent()) ?? '')?.[1]);
      expect(total).toBeGreaterThan(1);
      const current = () =>
        inRoot<string>(
          page,
          `const marks = [...root.querySelectorAll('[data-ws-pane="editor"] mark.ws-code-f')]; const cur = root.querySelector('[data-ws-pane="editor"] .ws-code-fcur');
           return cur ? String(marks.indexOf(cur)) + '@' + (cur.closest('tr')?.dataset.codeLine ?? '') : '';`,
        );
      const was = await current();
      expect(was).toMatch(/^0@/);
      await editor.locator('[data-action="ws-code-find-next"]').click();
      await expect.poll(async () => (await count.textContent()) ?? '').toMatch(/^2\/\d+\+?$/);
      expect(await current()).not.toBe(was);
      expect(await current()).toMatch(/^1@/);
      // Ctrl+G dans l'éditeur : « Aller à la ligne », Entrée y va.
      await editor.locator('.ws-code-scroll').focus();
      await page.keyboard.press('Control+g');
      const goto = editor.locator('[data-ws-field="code-goto"]');
      await goto.waitFor();
      expect(
        await editor
          .locator('[data-action="ws-code-goto-open"][aria-expanded]')
          .getAttribute('aria-expanded'),
      ).toBe('true');
      expect(await editor.locator('#ws-code-goto').getAttribute('aria-label')).toBe('Aller à la ligne');
      await goto.fill('5');
      await goto.press('Enter');
      await editor.locator('[data-ws-field="code-goto"]').waitFor({ state: 'detached' });
      // Avec une recherche active, « Aller à la ligne » l'emporte : la ligne demandée devient la ligne visée.
      expect(await editor.locator('.ws-code-target').getAttribute('data-ws-line')).toBe('5');
      // Sans recherche, « Aller à la ligne » mène à la ligne demandée.
      await find.fill('');
      await expect.poll(async () => (await count.textContent()) ?? '').toBe('');
      await editor.locator('.ws-code-scroll').focus();
      await page.keyboard.press('Control+g');
      await goto.waitFor();
      await goto.fill('5');
      await goto.press('Enter');
      await editor.locator('.ws-code-target[data-ws-line="5"]').waitFor();
      expect(
        await inRoot<boolean>(
          page,
          `const ed = root.querySelector('[data-ws-pane="editor"]'); const s = ed.querySelector('.ws-code-scroll').getBoundingClientRect();
           const t = ed.querySelector('.ws-code-target').getBoundingClientRect(); return t.top >= s.top - 1 && t.bottom <= s.bottom + 1;`,
        ),
      ).toBe(true);
      // Fermer l'onglet actif : il en reste un.
      await editor.locator('.ws-code-tabw.ws-code-on .ws-code-tab-x').click();
      await expect.poll(() => editor.locator('.ws-code-tab').count()).toBe(1);
      await editor.locator(`.ws-code-scroll[data-file="${second ?? ''}"]`).waitFor();
      // L'arborescence : un dossier se replie et se déplie ; l'arborescence se réduit en rail.
      const folder = tree.locator('.ws-code-folder[aria-expanded="true"]').first();
      const folderKey = (await folder.getAttribute('data-folder')) ?? '';
      await folder.click();
      await tree.locator(`.ws-code-folder[data-folder="${folderKey}"][aria-expanded="false"]`).waitFor();
      await tree.locator(`.ws-code-folder[data-folder="${folderKey}"]`).click();
      await tree.locator(`.ws-code-folder[data-folder="${folderKey}"][aria-expanded="true"]`).waitFor();
      const wide = (await paneBoxes(page)).tree?.w ?? 0;
      // Replier l'arborescence : son panneau devient un rail (barre de titre) ; « Déplier » la rouvre.
      await tree.locator('[data-action="ws-code-tree-toggle"][aria-expanded="true"]').click();
      await dash.locator('[data-ws-pane="tree"][data-mode="min"]').waitFor();
      await expect.poll(async () => (await paneBoxes(page)).tree?.w ?? 0).toBeLessThan(wide - 60);
      const unfold = tree.locator('.ws-pane-ops [data-op="restore"][aria-expanded="false"]');
      expect(await unfold.isVisible()).toBe(true);
      await unfold.click();
      await tree.locator('[data-action="ws-code-tree-toggle"][aria-expanded="true"]').waitFor();
      expect((await paneBoxes(page)).tree?.w ?? 0).toBeGreaterThanOrEqual(wide - 2);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('preferences: splitter, main tab and stepper are restored after a reload; without storage the workspace still works', async () => {
    const opened = await open();
    try {
      const { page, dash } = opened;
      await openMain(opened, 'traceability');
      await dash.locator('[data-ws-splitter="primary-details"]').focus();
      for (let index = 0; index < 3; index += 1) await page.keyboard.press('ArrowLeft');
      const value = await splitterValue(dash, 'primary-details');
      expect(value).toBe(64);
      await openSub(opened, 'bff');
      await dash.locator('[data-action="ws-ux-stepper"]').click();
      await dash.locator('[data-action="ws-ux-stepper"][aria-expanded="true"]').waitFor();
      await openMain(opened, 'diagnosis');
      await openSub(opened, 'hypotheses');
      await expect
        .poll(async () =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>,
            PREFS_KEY,
          ),
        )
        .toMatchObject({ tab: 'diagnosis', stepper: true, sizes: { 'primary-details': 0.64 } });
      await page.reload();
      const dashboard = page.locator('qa-crawler-dashboard');
      await dashboard.locator('select[data-action="project-context"]').selectOption(project.id);
      await page.waitForTimeout(400);
      await openIncident({ ...opened, dash: dashboard }, 'diagnosis');
      await dashboard.locator('#ws-ux-sub-hypotheses[aria-selected="true"]').waitFor();
      await dashboard.locator('[data-action="ws-ux-stepper"][aria-expanded="true"]').waitFor();
      expect(await dashboard.locator('#ws-ux-steps li').count()).toBe(10);
      await dashboard.locator('#ws-ux-tab-traceability').click();
      await dashboard.locator('#ws-ux-sub-bff[aria-selected="true"]').waitFor();
      expect(await splitterValue(dashboard, 'primary-details')).toBe(64);
      expect(opened.errors).toEqual([]);
    } finally {
      await opened.page.close();
    }
    const denied = await open({
      init: () => {
        for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const)
          Object.defineProperty(Storage.prototype, method, {
            configurable: true,
            value: () => {
              throw new DOMException('Stockage refusé', 'SecurityError');
            },
          });
      },
    });
    try {
      const { page, dash } = denied;
      expect(
        await page.evaluate(() => {
          try {
            localStorage.getItem('x');
            return 'readable';
          } catch {
            return 'throws';
          }
        }),
      ).toBe('throws');
      await openMain(denied, 'traceability');
      expect(Object.keys(await paneBoxes(page)).sort()).toEqual([...TRACE_PANES].sort());
      await dash.locator('[data-ws-splitter="primary-details"]').focus();
      await page.keyboard.press('ArrowLeft');
      expect(await splitterValue(dash, 'primary-details')).toBe(68);
      await page.waitForTimeout(500);
      await openMain(denied, 'code');
      expect((await pageScroll(page)).height).toBeLessThanOrEqual(900 + 1);
      expect(denied.errors).toEqual([]);
    } finally {
      await denied.page.close();
    }
  });

  it('header « Détails » and the compact stepper disclose their content', async () => {
    const opened = await open();
    const { dash } = opened;
    try {
      const toggle = dash.locator('[data-action="ws-ux-details"]');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(await dash.locator('#ws-ux-head-more').count()).toBe(0);
      await toggle.click();
      await dash.locator('[data-action="ws-ux-details"][aria-expanded="true"]').waitFor();
      const more = (await dash.locator('#ws-ux-head-more').textContent()) ?? '';
      expect(more).toContain(FAILING);
      expect(more).toContain('après avoir cliqué sur Enregistrer');
      await dash.locator('[data-action="ws-ux-details"]').click();
      await dash.locator('[data-action="ws-ux-details"][aria-expanded="false"]').waitFor();
      expect(await dash.locator('#ws-ux-head-more').count()).toBe(0);
      // La progression compacte : une ligne (« n/10 »), puis les dix étapes.
      const stepper = dash.locator('[data-action="ws-ux-stepper"]');
      expect(await stepper.getAttribute('aria-expanded')).toBe('false');
      expect(await dash.locator('.ws-ux-step-n').textContent()).toMatch(/\d+\s*\/\s*10/);
      expect(await dash.locator('#ws-ux-steps').count()).toBe(0);
      await stepper.click();
      await dash.locator('[data-action="ws-ux-stepper"][aria-expanded="true"]').waitFor();
      expect(await dash.locator('#ws-ux-steps li').count()).toBe(10);
      expect(await dash.locator('#ws-ux-steps [aria-current="step"]').count()).toBe(1);
      await dash.locator('[data-action="ws-ux-stepper"]').click();
      await dash.locator('[data-action="ws-ux-stepper"][aria-expanded="false"]').waitFor();
      expect(opened.errors).toEqual([]);
    } finally {
      await opened.page.close();
    }
  });

  it('keyboard: main tabs and sub-tabs rove with arrows, Home and End; the graph keeps a single tab stop among its nodes', async () => {
    const opened = await open();
    const { page, dash } = opened;
    const focused = () => inRoot<string>(page, `return root.activeElement?.id ?? '';`);
    try {
      await dash.locator('#ws-ux-tab-overview').focus();
      await page.keyboard.press('ArrowRight');
      await dash.locator('#ws-ux-tab-timeline[aria-selected="true"]').waitFor();
      expect(await focused()).toBe('ws-ux-tab-timeline');
      await page.keyboard.press('End');
      await dash.locator('#ws-ux-tab-report[aria-selected="true"]').waitFor();
      expect(await focused()).toBe('ws-ux-tab-report');
      await page.keyboard.press('Home');
      await dash.locator('#ws-ux-tab-overview[aria-selected="true"]').waitFor();
      expect(await focused()).toBe('ws-ux-tab-overview');
      // Chaque liste d'onglets n'a qu'un arrêt de tabulation.
      const stops = await inRoot<number[]>(
        page,
        `return [...root.querySelectorAll('.ws-root [role="tablist"]')].map((list) => list.querySelectorAll('[role="tab"][tabindex="0"]').length);`,
      );
      expect(stops.length).toBeGreaterThanOrEqual(2);
      expect(stops.every((count) => count === 1)).toBe(true);
      await openMain(opened, 'traceability');
      await dash.locator('#ws-ux-sub-fullstack').focus();
      await page.keyboard.press('ArrowRight');
      await dash.locator('#ws-ux-sub-frontend[aria-selected="true"]').waitFor();
      expect(await focused()).toBe('ws-ux-sub-frontend');
      await page.keyboard.press('End');
      await dash.locator('#ws-ux-sub-http[aria-selected="true"]').waitFor();
      expect(await focused()).toBe('ws-ux-sub-http');
      await page.keyboard.press('Home');
      await dash.locator('#ws-ux-sub-fullstack[aria-selected="true"]').waitFor();
      expect(await focused()).toBe('ws-ux-sub-fullstack');
      expect(await dash.locator('#ws-ux-tab-traceability').getAttribute('aria-selected')).toBe('true');
      // Le graphe : un seul nœud dans l'ordre de tabulation, qui suit les flèches.
      const nodeStops = () =>
        inRoot<string[]>(
          page,
          `return [...root.querySelectorAll('[data-ws-pane="primary"] .ws-graph-node[tabindex="0"], [data-ws-pane="primary"] .ws-graph-edge[tabindex="0"]')].map((n) => n.dataset.ref ?? '');`,
        );
      const stopsBefore = await nodeStops();
      expect(stopsBefore).toHaveLength(1);
      await dash
        .locator(`[data-ws-pane="primary"] .ws-graph-node[data-ref="${stopsBefore[0] ?? ''}"]`)
        .focus();
      await page.keyboard.press('ArrowRight');
      const moved = await inRoot<string>(page, `return root.activeElement?.dataset?.ref ?? '';`);
      expect(moved).not.toBe(stopsBefore[0]);
      expect(moved).not.toBe('');
      expect(await nodeStops()).toEqual([moved]);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('390×844: one pane at a time, the switcher changes it, nothing clipped without a scroll container, no horizontal scroll', async () => {
    const opened = await open({ width: 390, height: 844 });
    const { page, dash } = opened;
    const clipped = `const out = [];
      for (const e of root.querySelector('.ws-root').querySelectorAll('*')) {
        if (!e.checkVisibility()) continue;
        const s = getComputedStyle(e);
        if (s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '') continue;
        if (/(hidden|clip)/.test(s.overflowY) && e.clientHeight > 2 && e.scrollHeight > e.clientHeight + 1) out.push('y ' + e.tagName + '.' + String(e.className).slice(0, 60) + ' ' + e.scrollHeight + '/' + e.clientHeight);
        if (/(hidden|clip)/.test(s.overflowX) && s.textOverflow !== 'ellipsis' && e.clientWidth > 2 && e.scrollWidth > e.clientWidth + 1) out.push('x ' + e.tagName + '.' + String(e.className).slice(0, 60) + ' ' + e.scrollWidth + '/' + e.clientWidth);
      }
      return out;`;
    try {
      // Les écrans pleine largeur de la maquette (Diagnostic › Diagnostic…) n'ont qu'un panneau sans sélection.
      await openMain(opened, 'diagnosis');
      expect(Object.keys(await paneBoxes(page)), 'diagnosis').toEqual(['content']);
      expect((await pageScroll(page)).width, 'diagnosis').toBeLessThanOrEqual(390);
      await openSub(opened, 'hypotheses');
      for (const tab of ['overview', 'traceability', 'code', 'diagnosis'] as const) {
        await openMain(opened, tab);
        const panes = await dash
          .locator('.ws-mswitch button[data-action="ws-pane-focus"]')
          .evaluateAll((buttons) => buttons.map((b) => (b as HTMLElement).dataset.pane ?? ''));
        expect(panes.length, tab).toBeGreaterThanOrEqual(2);
        if (tab === 'traceability') expect(panes).toEqual([...TRACE_PANES]);
        for (const pane of panes) {
          await dash.locator(`.ws-mswitch button[data-pane="${pane}"]`).click();
          await dash.locator(`.ws-mswitch button[data-pane="${pane}"][aria-pressed="true"]`).waitFor();
          await page.waitForTimeout(150);
          const shown = Object.keys(await paneBoxes(page));
          expect(shown, `${tab}/${pane}`).toEqual([pane]);
          expect(await inRoot<string[]>(page, clipped), `${tab}/${pane}`).toEqual([]);
          const scroll = await pageScroll(page);
          expect(scroll.width, `${tab}/${pane}`).toBeLessThanOrEqual(scroll.client);
          // Le contenu du panneau se lit : il défile (lui ou la page), il ne déborde pas de l'écran.
          const box = (await paneBoxes(page))[pane];
          expect(box?.left ?? -1).toBeGreaterThanOrEqual(0);
          expect(box?.right ?? Infinity).toBeLessThanOrEqual(390);
        }
      }
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('demo: « Données de démonstration » banner, no incidents API call, mutating actions disabled, same layout', async () => {
    const opened = await openDashboard();
    const { page, dash } = opened;
    try {
      await dash.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
      await dash.locator('[data-action="inc-demo"]').first().waitFor();
      const calls: string[] = [];
      // Aucune mutation de l'API, aucune lecture des incidents : la démonstration reste dans la page.
      page.on('request', (request) => {
        const url = request.url();
        const mutation = request.method() !== 'GET' && /\/api\//.test(url);
        if (mutation || /\/api\/projects\/[^/]+\/incidents/.test(url))
          calls.push(`${request.method()} ${url}`);
      });
      await dash.locator('[data-action="inc-demo"]').first().click();
      await dash.locator('#ws-demo-why').waitFor();
      expect(await dash.locator('.ws-demo').first().textContent()).toContain('Données de démonstration');
      for (const tab of MAIN_TABS) {
        await openMain(opened, tab);
        await page.waitForTimeout(150);
        const scroll = await pageScroll(page);
        expect(scroll.height, tab).toBeLessThanOrEqual(scroll.inner + 1);
        expect(scroll.width, tab).toBeLessThanOrEqual(scroll.client);
        const enabled = await inRoot<string[]>(
          page,
          `return [...root.querySelectorAll('.ws-root button')].filter((b) => !b.disabled && ${MUTATING.toString()}.test(b.dataset.action ?? '')).map((b) => b.dataset.action);`,
        );
        expect(enabled, tab).toEqual([]);
      }
      await openMain(opened, 'traceability');
      const boxes = await paneBoxes(page);
      for (const pane of TRACE_PANES) expect(boxes[pane], pane).toBeDefined();
      await page.waitForTimeout(1500);
      expect(calls).toEqual([]);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('dark theme at 1440×900: no page scroll, the splitters stay visible', async () => {
    const opened = await open({ query: '?theme=dark' });
    const { page } = opened;
    try {
      for (const tab of MAIN_TABS) {
        await openMain(opened, tab);
        await page.waitForTimeout(150);
        const scroll = await pageScroll(page);
        expect(scroll.height, tab).toBeLessThanOrEqual(scroll.inner + 1);
        expect(scroll.width, tab).toBeLessThanOrEqual(scroll.client);
      }
      await openMain(opened, 'traceability');
      const splitters = await inRoot<{ id: string; w: number; h: number; ratio: number }[]>(
        page,
        `const parse = (c) => { const m = c.match(/\\(([^)]+)\\)/); const p = m[1].split(/[ ,/]+/).filter((t) => t !== '' && !Number.isNaN(Number(t))).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
         const up = (el) => el.parentElement ?? el.getRootNode().host ?? null;
         const bg = (el) => { const layers = []; for (let c = el; c; c = up(c)) { const v = parse(getComputedStyle(c).backgroundColor); if (v[3] > 0) { layers.push(v); if (v[3] >= 1) break; } }
           let out = [255, 255, 255]; for (const l of layers.reverse()) out = out.map((x, i) => l[i] * l[3] + x * (1 - l[3])); return out; };
         const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
         return [...root.querySelectorAll('[data-ws-splitter]')].map((s) => {
           const r = s.getBoundingClientRect(); const after = getComputedStyle(s, '::after'); const back = bg(s);
           const grip = parse(after.backgroundColor); const alpha = grip[3] * Number(after.opacity);
           const mixed = back.map((x, i) => grip[i] * alpha + x * (1 - alpha));
           const [x, y] = [lum(mixed), lum(back)].sort((p, q) => q - p);
           return { id: s.dataset.wsSplitter, w: r.width, h: r.height, ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100 };
         });`,
      );
      expect(splitters.map((s) => s.id).sort()).toEqual(
        ['editor-evidence', 'primary-details', 'top-bottom', 'tree-editor'].sort(),
      );
      for (const splitter of splitters) {
        expect(Math.min(splitter.w, splitter.h), splitter.id).toBeGreaterThanOrEqual(4);
        expect(splitter.ratio, splitter.id).toBeGreaterThanOrEqual(1.5);
      }
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
