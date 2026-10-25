import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';
import {
  createQaCrawler,
  type ExplorationEvent,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LE RUN MONITOR SUR LE VRAI MOTEUR : une exploration du projet joue deux flows imposés sur le site
 * de démo (l'un passe, l'autre vise un lien absent et échoue). Le flux d'événements porte les flows et
 * leurs étapes ; <qa-crawler-run-monitor> les montre dans Chromium, après une première ouverture du
 * flux volontairement coupée (reprise sans doublon par le client du SDK).
 *
 * Seule la composition est propre au test : les flows sont ajoutés à la mission du projet avant de
 * la donner au vrai `runMission` (l'assistant ne crée pas encore de flow imposé).
 */
let site: TestSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let browser: Browser;

const FLOWS = `
mission: { name: flows }
target: { baseUrl: http://placeholder.test }
flows:
  - name: ouvrir-les-utilisateurs
    startAt: /
    steps:
      - click: { role: link, name: Utilisateurs }
      - expect: { url: /users }
  - name: lien-absent
    startAt: /
    steps:
      - click: { role: link, name: Lien qui n'existe pas }
`;

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-monitor-'));
  const { flows } = parseConfig(FLOWS, {}, {}).config;
  server = await startSdkServer({
    workspace,
    language: 'fr',
    run: (config, options) =>
      runMission(
        {
          ...config,
          flows,
          exploration: { ...config.exploration, autonomous: false, actionTimeoutMs: 1500 },
          browser: { ...config.browser, headless: true },
        },
        options,
      ),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  const draft: ProjectDraft = {
    ...engineDefaults(),
    project: { name: 'Site de démo', targetUrl: `${site.url}/`, framework: 'other' },
  };
  project = await client.projects.create(draft);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser.close();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('Run Monitor — real engine, flows and steps, stream resumed', () => {
  let explorationId = '';
  let events: ExplorationEvent[] = [];

  it('streams the flows and their steps as the engine plays them, each event once', async () => {
    const started = await client.explorations.start(project.id);
    explorationId = started.id;
    events = [];
    await client.explorations.subscribe(explorationId, (event) => events.push(event)).done;
    const ends = events.filter((event) => event.type === 'flow' && event.phase === 'end');
    expect(ends).toEqual([
      expect.objectContaining({ flow: 'ouvrir-les-utilisateurs', status: 'PASSED' }),
      expect.objectContaining({ flow: 'lien-absent', status: 'FAILED' }),
    ]);
    const steps = events.filter((event) => event.type === 'flow-step');
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flow: 'ouvrir-les-utilisateurs', index: 1, status: 'PASSED' }),
        expect.objectContaining({ flow: 'lien-absent', index: 1, status: 'FAILED' }),
      ]),
    );
    const seqs = events.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 120_000);

  it('shows them in <qa-crawler-run-monitor>, after a cut stream is resumed', async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { connections: string[] }).connections = seen;
        document.addEventListener('qa-monitor-connection', (event) => {
          seen.push((event as CustomEvent<{ state: string }>).detail.state);
        });
      });
      let cut = false;
      await page.route('**/events*', async (route) => {
        if (!cut) {
          cut = true;
          await route.abort('connectionreset');
          return;
        }
        await route.continue();
      });
      await page.goto(`${server.url}/monitor?exploration=${explorationId}`);
      const monitor = page.locator('qa-crawler-run-monitor');
      await monitor.getByText('lien-absent').first().waitFor();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { connections: string[] }).connections))
        .toEqual(expect.arrayContaining(['reconnecting', 'live', 'closed']));
      // Le flux rejoué après la coupure n'a pas doublé les événements.
      await expect
        .poll(() =>
          monitor.evaluate((element) => (element as unknown as { events: unknown[] }).events.length),
        )
        .toBe(events.length);
      await expect.poll(() => monitor.locator('.flows li').count()).toBe(2);

      await monitor.locator('select[data-view="stepStatus"]').selectOption('FAILED');
      const lines = monitor.locator('.events li');
      await expect.poll(() => lines.count()).toBe(1);
      await expect.poll(() => lines.first().textContent()).toContain('lien-absent');

      await monitor.locator('select[data-view="stepStatus"]').selectOption('');
      await monitor.locator('select[data-view="flow"]').selectOption('ouvrir-les-utilisateurs');
      await expect
        .poll(async () =>
          (await lines.allTextContents()).every((text) => text.includes('ouvrir-les-utilisateurs')),
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});
