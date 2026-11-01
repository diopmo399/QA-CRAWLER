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
 * REVUE QA DE L'ESPACE D'INVESTIGATION, dans Chromium, sur l'incident connu réellement reproduit et
 * analysé (tests/fixtures/incident-app) : parcours clavier, démonstration sans appel au serveur,
 * sélection synchronisée, lecteur sans droit sur le code, pas de défilement horizontal, ids uniques,
 * noms accessibles. Accès nominatif : un administrateur et un lecteur se connectent avec leur jeton.
 *
 * Disposition v2 : les vues sont des onglets principaux (`#ws-ux-tab-<onglet>`) et des sous-onglets
 * (`#ws-ux-sub-<sous-onglet>`) ; les zones sont des panneaux (`data-ws-pane` / `data-ws-zone` : primary,
 * details, tree, editor, evidence, content). Les quinze clés de vue historiques désignent chacune un onglet
 * et un sous-onglet (`VIEWS`). Le bloc « défauts relevés par la revue » garde les contrôles des défauts
 * corrigés (docs/incident-reconstruction/qa-review.md).
 */
let site: IncidentSite;
let server: RunningSdkServer;
let workspace: string;
let repos: string;
let service: QaCrawlerClient;
let project: Project;
let incident: Incident;
let adminToken: string;
let readerToken: string;
let browser: Browser;

const FAILING = 'Créer un livre sans éditeur';
const PASSING = 'Créer un livre avec éditeur';
/** Les clés de vue (route `tab`) : l'onglet principal et le sous-onglet de chacune (contrat v2). */
const VIEWS = {
  overview: ['overview', 'summary'],
  scope: ['overview', 'scope'],
  environment: ['overview', 'environment'],
  timeline: ['timeline', 'events'],
  logs: ['timeline', 'logs'],
  traceability: ['traceability', 'fullstack'],
  frontend: ['traceability', 'frontend'],
  bff: ['traceability', 'bff'],
  backend: ['traceability', 'backend'],
  requests: ['traceability', 'http'],
  code: ['code', undefined],
  diagnosis: ['diagnosis', 'diagnosis'],
  hypotheses: ['diagnosis', 'hypotheses'],
  experiments: ['diagnosis', 'experiments'],
  report: ['report', 'report'],
  regression: ['report', 'regression'],
} as const satisfies Record<string, readonly [string, string | undefined]>;
type View = keyof typeof VIEWS;
const TABS = Object.keys(VIEWS) as View[];
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
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-review-ws-'));
  repos = await mkdtemp(path.join(tmpdir(), 'incident-review-repos-'));
  await cp(path.join(import.meta.dirname, '../fixtures/incident-app'), repos, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  service = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  adminToken = (await service.access.createMember({ name: 'Camille A.', role: 'ADMIN' })).token;
  readerToken = (await service.access.createMember({ name: 'Noa L.', role: 'READER' })).token;
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
  ) => ({
    id,
    name,
    layer,
    repository: { root: path.join(repos, dir), include: [include] },
  });
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
}

async function signIn(options: { token?: string; width?: number } = {}): Promise<Opened> {
  const width = options.width ?? 1440;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}/dashboard`);
  const dash = page.locator('qa-crawler-dashboard');
  await dash.locator('input[data-bind="token"]').fill(options.token ?? adminToken);
  await dash.locator('form[data-action="sign-in"] button[type="submit"]').click();
  await dash.locator('select[data-action="project-context"]').first().waitFor({ state: 'attached' });
  if (width <= 960) await openMenu(dash);
  await dash.locator('select[data-action="project-context"]').selectOption(project.id);
  // Le choix du projet redessine la page (menu compris) : attendre qu'elle soit stable.
  await page.waitForTimeout(400);
  return { page, dash, errors };
}

async function openMenu(dash: Locator): Promise<void> {
  if ((await dash.locator('.dash').getAttribute('data-menu')) === 'closed')
    await dash.locator('[data-action="menu"]').first().click();
  await dash.locator('.drawer [data-action="nav"][data-view="incidents"]').waitFor({ state: 'visible' });
}

async function openIncident(opened: Opened, width = 1440): Promise<void> {
  if (width <= 960) await openMenu(opened.dash);
  await opened.dash.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
  await opened.dash.locator(`button[data-action="inc-open"][data-incident="${incident.id}"]`).first().click();
  await opened.dash.locator('#ws-ux-tab-overview[aria-selected="true"]').waitFor();
}

/** Ouvre une vue : son onglet principal, puis son sous-onglet. */
async function openTab(opened: Opened, view: View): Promise<void> {
  const [tab, sub] = VIEWS[view];
  await opened.dash.locator(`#ws-ux-tab-${tab}`).click();
  await opened.dash.locator(`#ws-ux-tab-${tab}[aria-selected="true"]`).waitFor();
  if (sub === undefined) return;
  await opened.dash.locator(`#ws-ux-sub-${sub}`).click();
  await opened.dash.locator(`#ws-ux-sub-${sub}[aria-selected="true"]`).waitFor();
}

/** Évalue dans la racine fantôme du Dashboard. */
function inRoot<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(
    `(() => { const root = document.querySelector('qa-crawler-dashboard').shadowRoot; ${body} })()`,
  );
}

const activeElement = (page: Page) =>
  inRoot<{ id: string; action: string; ref: string; outline: string; shadow: string } | null>(
    page,
    `const a = root.activeElement; if (!a) return null; const s = getComputedStyle(a);
     return { id: a.id, action: a.dataset.action ?? '', ref: a.dataset.ref ?? '', outline: s.outlineStyle + ' ' + s.outlineWidth, shadow: s.boxShadow };`,
  );

describe('Investigation Workspace — QA review (Chromium)', () => {
  it('keyboard only: roving tabs (arrows, Home, End) with visible focus, Enter selects a graph node, Escape clears', async () => {
    const opened = await signIn();
    const { page, dash } = opened;
    try {
      await openIncident(opened);
      await dash.locator('#ws-ux-tab-overview').focus();
      // Un seul arrêt de tabulation par liste d'onglets (onglets principaux, sous-onglets).
      const stops = await inRoot<number[]>(
        page,
        `return [...root.querySelectorAll('[role="tablist"]')].map((list) => list.querySelectorAll('[role="tab"][tabindex="0"]').length);`,
      );
      expect(stops).toEqual([1, 1]);
      await page.keyboard.press('ArrowRight');
      await dash.locator('#ws-ux-tab-timeline[aria-selected="true"]').waitFor();
      expect((await activeElement(page))?.id).toBe('ws-ux-tab-timeline');
      await page.keyboard.press('End');
      await dash.locator('#ws-ux-tab-report[aria-selected="true"]').waitFor();
      expect((await activeElement(page))?.id).toBe('ws-ux-tab-report');
      // Les sous-onglets roulent aussi, le focus suit.
      await dash.locator('#ws-ux-sub-report').focus();
      await page.keyboard.press('ArrowRight');
      await dash.locator('#ws-ux-sub-regression[aria-selected="true"]').waitFor();
      expect((await activeElement(page))?.id).toBe('ws-ux-sub-regression');
      await page.keyboard.press('Home');
      await dash.locator('#ws-ux-sub-report[aria-selected="true"]').waitFor();
      expect((await activeElement(page))?.id).toBe('ws-ux-sub-report');
      await dash.locator('#ws-ux-tab-report').focus();
      await page.keyboard.press('Home');
      await dash.locator('#ws-ux-tab-overview[aria-selected="true"]').waitFor();
      const tab = await activeElement(page);
      expect(tab?.id).toBe('ws-ux-tab-overview');
      // Le focus est visible (contour), au clavier.
      expect(tab?.outline).not.toMatch(/^none/);
      expect(
        await inRoot<string | null>(page, `return root.querySelector('#ws-ux-panel')?.getAttribute('role');`),
      ).toBe('tabpanel');
      // Un nœud du graphe : Entrée sélectionne, le focus reste, Échap vide la sélection.
      await openTab(opened, 'traceability');
      const node = dash.locator('[data-ws-zone="primary"] .ws-graph-node[data-action="ws-select"]').first();
      const ref = await node.getAttribute('data-ref');
      await node.focus();
      await page.keyboard.press('Enter');
      await dash.locator(`[data-ws-zone="details"] .ws-ctx-body[data-sel="node:${ref ?? ''}"]`).waitFor();
      expect((await activeElement(page))?.ref).toBe(ref);
      await page.keyboard.press('Escape');
      await dash.locator('[data-ws-zone="details"] .ws-ctx-body[data-sel=""]').waitFor();
      // Une requête choisie au clavier : la sélection est faite, le focus reste sur elle.
      await openTab(opened, 'requests');
      const request = dash
        .locator('[data-ws-zone="primary"] .ws-timeline-path', { hasText: '/api/books' })
        .first();
      await request.focus();
      await page.keyboard.press('Enter');
      await dash.locator('[data-ws-zone="details"] .ws-timeline-detail').waitFor();
      expect((await activeElement(page))?.action).toBe('ws-select');
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('demo mode: no call to the incidents API while exploring, every mutating action disabled', async () => {
    const opened = await signIn();
    const { page, dash } = opened;
    try {
      await dash.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
      await dash.locator('[data-action="inc-demo"]').first().waitFor();
      const calls: string[] = [];
      page.on('request', (request) => {
        if (/\/api\/projects\/[^/]+\/incidents/.test(request.url())) calls.push(request.url());
      });
      await dash.locator('[data-action="inc-demo"]').first().click();
      await dash.locator('#ws-demo-why').waitFor();
      for (const tab of TABS) {
        await openTab(opened, tab);
        // Explorer : sélections et liens de code (lus dans les données de démonstration).
        await inRoot(
          page,
          `for (const e of [...root.querySelectorAll('[data-action="ws-select"], [data-action="ws-code-open"], [data-action="ws-code"]')].slice(0, 5))
             e.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); return 0;`,
        );
        const enabled = await inRoot<string[]>(
          page,
          `return [...root.querySelectorAll('.ws-root button')].filter((b) => !b.disabled && ${MUTATING.toString()}.test(b.dataset.action ?? '')).map((b) => b.dataset.action);`,
        );
        expect(enabled, tab).toEqual([]);
      }
      // Le suivi ne part pas en démonstration (au-delà d'une période de relecture).
      await page.waitForTimeout(2000);
      expect(calls).toEqual([]);
      await openTab(opened, 'diagnosis');
      expect(
        await dash
          .locator('#ws-ux-panel .ws-dx-board .ws-dx-boardhead .ws-dx-chip')
          .getAttribute('data-status'),
      ).toBe('PROBABLE');
      expect(await dash.locator('#ws-ux-panel').textContent()).not.toContain('Cause racine confirmée');
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('synchronized selection: a request highlights the graph and opens its code; a node and a hypothesis show their detail', async () => {
    const opened = await signIn();
    const { page, dash } = opened;
    try {
      await openIncident(opened);
      await openTab(opened, 'requests');
      await dash
        .locator('[data-ws-zone="primary"] .ws-timeline-path', { hasText: '/api/books' })
        .first()
        .click();
      const aside = dash.locator('[data-ws-zone="details"]');
      await aside.locator('.ws-timeline-detail').waitFor();
      expect(await aside.locator('.ws-ctx-body').getAttribute('data-sel')).toMatch(/^request:/);
      // L'extrait du code relié, la ligne visée en évidence ; l'éditeur ouvre le même endroit.
      await aside.locator('.ws-ctx-code .ws-code-sel').waitFor();
      await dash.locator('[data-ws-zone="editor"] .ws-code-scroll .ws-code-target').waitFor();
      // Le graphe met en évidence les nœuds reliés et atténue les autres.
      await openTab(opened, 'traceability');
      expect(
        await dash.locator('[data-ws-zone="primary"] .ws-graph-node[data-ws-state="related"]').count(),
      ).toBeGreaterThan(0);
      expect(
        await dash.locator('[data-ws-zone="primary"] .ws-graph-node[data-ws-state="dimmed"]').count(),
      ).toBeGreaterThan(0);
      // La chronologie peut se restreindre aux éléments reliés.
      await openTab(opened, 'timeline');
      const count = async () => (await dash.locator('.ws-timeline-count').textContent()) ?? '';
      const all = await count();
      await dash.locator('[data-ws-zone="content"] input[data-action="ws-timeline-related"]').check();
      await expect.poll(count).not.toBe(all);
      expect(await dash.locator('[data-ws-zone="content"] .ws-timeline-ev').count()).toBeGreaterThan(0);
      // Un nœud du graphe : son détail ; un nœud de code ne porte aucune durée.
      await page.keyboard.press('Escape');
      await openTab(opened, 'traceability');
      const codeNode = await inRoot<string>(
        page,
        `return [...root.querySelectorAll('[data-ws-zone="primary"] .ws-graph-node[data-action="ws-select"]')].map((n) => n.dataset.ref).find((ref) => /CatalogBookService/.test(ref)) ?? '';`,
      );
      expect(codeNode).not.toBe('');
      await inRoot(
        page,
        `[...root.querySelectorAll('[data-ws-zone="primary"] .ws-graph-node')].find((n) => n.dataset.ref === ${JSON.stringify(codeNode)}).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); return 0;`,
      );
      await dash.locator(`[data-ws-zone="details"] .ws-ctx-body[data-sel="node:${codeNode}"]`).waitFor();
      await aside.locator('.ws-ctx-code .ws-code-sel').waitFor();
      const nodeDetail = ((await aside.locator('.ws-ctx-body').textContent()) ?? '').split('Code relié')[0];
      expect(nodeDetail).not.toMatch(/\b\d+\s?ms\b/);
      // Aucune relation lue dans le code n'est présentée comme observée (table « Toutes les relations »).
      expect(
        await inRoot<number>(
          page,
          `return root.querySelectorAll('[data-ws-zone="details"] .ws-rel-table tbody tr').length;`,
        ),
      ).toBeGreaterThan(0);
      const staticObserved = await inRoot<number>(
        page,
        `return [...root.querySelectorAll('[data-ws-zone="details"] .ws-rel-table tbody tr')].filter((tr) => tr.querySelector('.ws-rel-observed') && /\\.(java|ts):\\d+/.test(tr.children[3]?.textContent ?? '')).length;`,
      );
      expect(staticObserved).toBe(0);
      // Une hypothèse : ses éléments reliés sont mis en évidence dans le graphe.
      await page.keyboard.press('Escape');
      await openTab(opened, 'hypotheses');
      await dash
        .locator('[data-ws-zone="content"] [data-action="ws-select"][data-kind="hypothesis"]')
        .first()
        .click();
      await aside.locator('.ws-ctx-body[data-sel^="hypothesis:"]').waitFor();
      await openTab(opened, 'traceability');
      await expect
        .poll(() => dash.locator('[data-ws-zone="primary"] .ws-graph-node[data-ws-state="related"]').count())
        .toBeGreaterThan(0);
      expect(await aside.locator('.ws-ctx-body').getAttribute('data-sel')).toMatch(/^hypothesis:/);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('a reader: no code request, the code panel says access is denied, no mutating action; the API answers 403', async () => {
    const opened = await signIn({ token: readerToken });
    const { page, dash } = opened;
    const codeCalls: string[] = [];
    page.on('request', (request) => {
      if (/\/incidents\/[^/]+\/sources?(\?|$)/.test(request.url())) codeCalls.push(request.url());
    });
    try {
      await openIncident(opened);
      await openTab(opened, 'backend');
      expect(await dash.locator('[data-ws-zone="tree"]').textContent()).toContain(
        'Votre rôle ne permet pas de lire le code du périmètre.',
      );
      await openTab(opened, 'requests');
      await dash
        .locator('[data-ws-zone="primary"] .ws-timeline-path', { hasText: '/api/books' })
        .first()
        .click();
      expect(await dash.locator('[data-ws-zone="details"] .ws-ctx-code').textContent()).toContain(
        'Votre rôle ne permet pas de lire le code',
      );
      expect(await dash.locator('[data-ws-zone="editor"]').textContent()).toContain(
        'Votre rôle ne permet pas de lire le code',
      );
      for (const tab of TABS) {
        await openTab(opened, tab);
        const actions = await inRoot<string[]>(
          page,
          `return [...root.querySelectorAll('.ws-root button[data-action]')].map((b) => b.dataset.action).filter((a) => ${MUTATING.toString()}.test(a));`,
        );
        expect(actions, tab).toEqual([]);
      }
      expect(codeCalls).toEqual([]);
      const response = await fetch(
        `${server.url}/api/projects/${project.id}/incidents/${incident.id}/source?application=catalog&file=src/main/java/org/example/catalog/books/CatalogBookService.java`,
        { headers: { authorization: `Bearer ${readerToken}` } },
      );
      expect(response.status).toBe(403);
      expect(opened.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('a server error on the code is said (role=alert) with a working « Réessayer »', async () => {
    const opened = await signIn();
    const { page, dash } = opened;
    let fail = true;
    await page.route(/\/incidents\/[^/]+\/sources?(\?|$)/, (route) =>
      fail
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            // Le format d'erreur du serveur SDK (ErrorBody).
            body: JSON.stringify({ error: 'Erreur interne simulée', status: 500, code: 'INTERNAL' }),
          })
        : route.continue(),
    );
    try {
      await openIncident(opened);
      await openTab(opened, 'backend');
      // L'arborescence et le fichier de départ de la couche (ouvert dans l'éditeur) en échec : dits.
      const tree = dash.locator('[data-ws-zone="tree"]');
      const editor = dash.locator('[data-ws-zone="editor"]');
      await tree.locator('[role="alert"]').first().waitFor();
      await editor.locator('[role="alert"]').first().waitFor();
      expect(await tree.locator('[role="alert"]').first().textContent()).toContain('Erreur interne simulée');
      expect(await editor.locator('[role="alert"]').first().textContent()).toContain(
        'Erreur interne simulée',
      );
      fail = false;
      await editor.locator('[data-action="ws-code-reload"]').first().click();
      await editor.locator('.ws-code-scroll .ws-code-sel').waitFor();
      if ((await tree.locator('[data-action="ws-code-reload"]').count()) > 0)
        await tree.locator('[data-action="ws-code-reload"]').first().click();
      await tree.locator('.ws-code-file').first().waitFor();
      expect(await dash.locator('[data-ws-pane] [role="alert"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('every tab: no duplicate id in the shadow root, every interactive element has an accessible name, no dangling aria reference', async () => {
    const opened = await signIn();
    const { page } = opened;
    try {
      await openIncident(opened);
      const dangling = new Set<string>();
      for (const tab of TABS) {
        await openTab(opened, tab);
        const audit = await inRoot<{ dup: string[]; unnamed: string[]; dangling: string[]; imgs: number }>(
          page,
          `const ids = new Map();
           root.querySelectorAll('[id]').forEach((e) => ids.set(e.id, (ids.get(e.id) ?? 0) + 1));
           const nameOf = (el) => {
             const label = el.getAttribute('aria-label'); if (label && label.trim()) return label.trim();
             const by = el.getAttribute('aria-labelledby');
             if (by) return by.split(/\\s+/).map((id) => root.getElementById(id)?.textContent ?? '').join(' ').trim();
             if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
               const lab = (el.id && root.querySelector('label[for="' + el.id + '"]')) || el.closest('label');
               return (lab?.textContent ?? '').trim();
             }
             return ((el.textContent ?? '').trim() || el.querySelector('title')?.textContent || el.getAttribute('title') || '').trim();
           };
           const ws = root.querySelector('.ws-root');
           const unnamed = [...ws.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], a[href], input:not([type="hidden"]), select, textarea')]
             .filter((el) => !nameOf(el)).map((el) => el.outerHTML.slice(0, 120));
           const dangling = [];
           for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'for'])
             root.querySelectorAll('[' + attr + ']').forEach((e) => {
               for (const id of (e.getAttribute(attr) ?? '').split(/\\s+/).filter(Boolean))
                 if (!root.getElementById(id)) dangling.push(attr + '=' + id);
             });
           return { dup: [...ids].filter(([, n]) => n > 1).map(([id]) => id), unnamed, dangling, imgs: ws.querySelectorAll('img:not([alt])').length };`,
        );
        expect(audit.dup, tab).toEqual([]);
        expect(audit.unnamed, tab).toEqual([]);
        expect(audit.imgs, tab).toBe(0);
        for (const reference of audit.dangling) dangling.add(reference);
      }
      // Les boutons qui déplient un élément (« Détails », progression, « Aller à la ligne ») ne le désignent
      // (aria-controls) que lorsqu'il est affiché.
      expect([...dangling]).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

describe('Investigation Workspace — defects found by the QA review (regression checks)', () => {
  it('no horizontal page scroll, at 390 px and at 1440 px, on every tab', async () => {
    for (const width of [390, 1440]) {
      const opened = await signIn({ width });
      try {
        await openIncident(opened, width);
        for (const tab of TABS) {
          await openTab(opened, tab);
          const scroll = await opened.page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
          }));
          // Fixed defect (qa-review): the screen-reader count (.sr, position:absolute) of the tab counters
          // escaped the scrolling tab bar and widened the page (1331 px at 390).
          expect(scroll.scroll, `${String(width)} ${tab}`).toBeLessThanOrEqual(scroll.client);
        }
      } finally {
        await opened.page.close();
      }
    }
  });

  it('every evidence chip of the traceability tab selects something that exists', async () => {
    const opened = await signIn();
    try {
      await openIncident(opened);
      await openTab(opened, 'traceability');
      const refs = await inRoot<string[]>(
        opened.page,
        `return [...new Set([...root.querySelectorAll('[data-ws-pane] .ws-chip[data-action="ws-select"]')].map((c) => c.dataset.kind + '|' + c.dataset.ref))];`,
      );
      expect(refs.length).toBeGreaterThan(0);
      const dead: string[] = [];
      for (const key of refs) {
        const [kind, ref] = key.split('|');
        const text = await inRoot<string>(
          opened.page,
          `const chip = [...root.querySelectorAll('[data-ws-pane] .ws-chip[data-action="ws-select"]')].find((c) => c.dataset.kind === ${JSON.stringify(kind)} && c.dataset.ref === ${JSON.stringify(ref)});
           chip.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
           return root.querySelector('[data-ws-zone="details"] .ws-ctx-body')?.textContent ?? '';`,
        );
        if (/n’existe plus/.test(text)) dead.push(key);
        await opened.page.keyboard.press('Escape');
      }
      // Fixed defect (qa-review): evidenceChips (incident-parts.ts) turned every ref that is not a request
      // into an `evidence` selection; graph edges carry symbol ids and reproduction ids → « n'existe plus ».
      expect(dead).toEqual([]);
    } finally {
      await opened.page.close();
    }
  });

  it('relation badges and timeline statuses reach WCAG AA (4.5:1) in the light theme', async () => {
    const opened = await signIn();
    try {
      await openIncident(opened);
      const worst: { cls: string; ratio: number }[] = [];
      for (const tab of ['traceability', 'timeline'] as const) {
        await openTab(opened, tab);
        // La table « Toutes les relations » (panneau des détails) ouverte : ses badges sont rendus.
        if (tab === 'traceability')
          await opened.dash
            .locator('[data-ws-zone="details"] details[data-ws-details="relations"] > summary')
            .click();
        worst.push(
          ...(await inRoot<{ cls: string; ratio: number }[]>(
            opened.page,
            `const parse = (c) => { const m = c.match(/\\(([^)]+)\\)/); const p = m[1].split(/[ ,/]+/).filter((t) => t !== '' && !Number.isNaN(Number(t))).map(Number); return c.startsWith('color(') ? [p[0]*255, p[1]*255, p[2]*255, p[3] ?? 1] : [p[0], p[1], p[2], p[3] ?? 1]; };
             const up = (el) => el.parentElement ?? el.getRootNode().host ?? null;
             const bg = (el) => { const layers = []; for (let c = el; c; c = up(c)) { const v = parse(getComputedStyle(c).backgroundColor); if (v[3] > 0) { layers.push(v); if (v[3] >= 1) break; } }
               let out = [255, 255, 255]; for (const l of layers.reverse()) out = out.map((x, i) => l[i] * l[3] + x * (1 - l[3])); return out; };
             const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
             return [...root.querySelectorAll('[data-ws-pane] .ws-rel, [data-ws-pane] .ws-timeline-status')].map((el) => {
               const b = bg(el); const f = parse(getComputedStyle(el).color);
               const [x, y] = [lum(f), lum(b)].sort((p, q) => q - p);
               return { cls: el.className, ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100 };
             }).filter((r) => r.ratio < 4.5);`,
          )),
        );
      }
      // Fixed defect (qa-review): .ws-rel-* (incident-parts.ts) and .ws-timeline-status (incident-timeline.ts)
      // used the raw status token as text colour (2.5–3.6:1).
      expect([...new Set(worst.map((entry) => `${entry.cls} ${String(entry.ratio)}`))]).toEqual([]);
    } finally {
      await opened.page.close();
    }
  });

  it('the relations table keeps its « De » and « Vers » columns readable at 1440 px', async () => {
    const opened = await signIn();
    try {
      await openIncident(opened);
      await openTab(opened, 'traceability');
      // La table vit dans le panneau des détails, sous « Toutes les relations » (fermé par défaut).
      const drawer = opened.dash.locator('[data-ws-zone="details"] details[data-ws-details="relations"]');
      expect(await drawer.locator('summary').textContent()).toContain('Toutes les relations');
      await drawer.locator('summary').click();
      await opened.dash
        .locator('[data-ws-zone="details"] details[data-ws-details="relations"][open] tbody tr')
        .first()
        .waitFor();
      expect(
        await inRoot<string[]>(
          opened.page,
          `return [...root.querySelectorAll('[data-ws-zone="details"] .ws-rel-table thead th')].map((th) => th.textContent.trim()).slice(0, 2);`,
        ),
      ).toEqual(['De', 'Vers']);
      const widths = await inRoot<number[]>(
        opened.page,
        `return [...(root.querySelector('[data-ws-zone="details"] .ws-rel-table tbody tr')?.children ?? [])].slice(0, 2).map((cell) => Math.round(cell.getBoundingClientRect().width));`,
      );
      expect(widths).toHaveLength(2);
      // Fixed defect (qa-review): .ws-graph-nodebtn had overflow-wrap:anywhere, which squeezed the node
      // columns to 33 and 49 px (labels broken letter by letter).
      for (const width of widths) expect(width).toBeGreaterThanOrEqual(96);
    } finally {
      await opened.page.close();
    }
  });
});
