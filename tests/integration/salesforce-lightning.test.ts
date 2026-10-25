import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { waitForScreenReady } from '../../src/observation/screen-ready.js';
import { runMission } from '../../src/orchestrator.js';
import { startLightningApp, type LightningApp } from '../fixtures/lightning-app.js';

/**
 * LE PROFIL SALESFORCE LIGHTNING, sur une IMITATION locale de Lightning (tests/fixtures/lightning-app.ts) :
 * composants en Shadow DOM, lectures en `POST /aura`, chargeurs, identifiants d'enregistrement de 18
 * caractères. Ces tests prouvent ce que fait le moteur face à ces traits ; ils ne prouvent PAS la
 * compatibilité avec une vraie organisation Salesforce.
 */
let app: LightningApp;
let dir: string;

const mission = (platform: 'generic' | 'salesforce-lightning', reportsDir: string): string => `
mission:
  name: lightning-${platform}
  mode: explore
target:
  baseUrl: ${app.url}
  startAt: /lightning/page/home
  platform: ${platform}
exploration: { maxStates: 8, maxActions: 30, maxDurationMinutes: 2, maxStatesPerRoute: 2, actionTimeoutMs: 4000 }
output:
  reportsDir: ${reportsDir}
  screenshotsDir: ${path.join(reportsDir, 'screenshots')}
`;

async function explore(platform: 'generic' | 'salesforce-lightning'): Promise<ExplorationResult> {
  const config = parseConfig(mission(platform, path.join(dir, platform)), {}, {}).config;
  return (await runMission(config, { env: {} })).result;
}

beforeAll(async () => {
  app = await startLightningApp();
  dir = await mkdtemp(path.join(tmpdir(), 'qa-lightning-'));
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('Salesforce Lightning profile — on a local imitation, never a real org', () => {
  it('without the profile, the write guard cancels the Aura reads: the screens stay without data', async () => {
    const result = await explore('generic');
    const auraBlocked = (result.blockedWrites ?? []).filter((write) => write.url.includes('/aura'));
    expect(auraBlocked.length).toBeGreaterThan(0);
    // Aucune fiche d'enregistrement atteinte : la liste ne s'est jamais chargée.
    expect(result.states.some((state) => state.route.startsWith('/lightning/r/'))).toBe(false);
  }, 180_000);

  it('with the profile, Aura reads pass, records are explored as one route pattern, the write stays blocked', async () => {
    const before = app.writes.length;
    const result = await explore('salesforce-lightning');
    const records = result.states.filter((state) => state.route.startsWith('/lightning/r/'));
    expect(records.length).toBeGreaterThan(0);
    // Les écrans observés sont ceux d'après le chargement (le chargeur dans le Shadow DOM a été attendu).
    expect(records.some((state) => state.headings.some((heading) => heading.startsWith('Acme')))).toBe(true);
    expect(result.states.some((state) => state.headings.includes('Comptes'))).toBe(true);
    // Les lectures Aura n'apparaissent jamais parmi les écritures bloquées.
    expect(app.auraActions.some((action) => action.endsWith('getListUi'))).toBe(true);
    const blocked = result.blockedWrites ?? [];
    expect(blocked.every((write) => !write.url.includes('getListUi'))).toBe(true);
    // Aucune écriture n'atteint l'application pendant l'exploration.
    expect(app.writes.length).toBe(before);
  }, 180_000);

  it('waits for a loader that only exists inside a shadow tree (no network involved)', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<x-host></x-host><script>
        customElements.define('x-host', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<lightning-spinner style="display:block;height:20px">…</lightning-spinner>';
            setTimeout(() => { root.innerHTML = '<h1>Chargé</h1>'; }, 800);
          }
        });
      </script>`);
      const started = Date.now();
      await waitForScreenReady(page, 5_000);
      // Le chargeur est dans l'arbre « shadow » : l'écran n'est prêt qu'après son retrait.
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
      expect(await page.locator('x-host').getByRole('heading', { name: 'Chargé' }).count()).toBe(1);
    } finally {
      await browser.close();
    }
  });
});
