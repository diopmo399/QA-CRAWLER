import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording } from '../../src/recording/record-orchestrator.js';

/**
 * AUCUN SAUT DE LA PAGE ENREGISTRÉE : ni défilement quand l'étape choisie dans la fenêtre du recorder
 * est déjà visible, ni recentrage quand elle ne l'est pas (défilement au plus près), ni attribut posé
 * sur les éléments de l'application pendant la validation des cibles.
 */
const PAGE = `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif}.wrap{max-width:900px;margin:0 auto;padding:20px}</style></head>
<body><div class="wrap"><h1>Long page</h1><div style="height:1400px"></div>
<label>Name <input id="n"></label> <button id="go" onclick="document.getElementById('out').textContent='done'">Go</button>
<p id="out"></p><div style="height:1400px"></div></div></body></html>`;

type Observed = { events: string[]; scrollY: number };

describe('Recording — the recorded page never jumps', () => {
  let server: Server;
  let url = '';
  const seen: Record<string, Observed> = {};

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-record-shift-'));
    const missionFile = path.join(dir, 'shift.mission.yaml');
    await writeFile(missionFile, `mission: { name: shift }\ntarget: { baseUrl: ${url}, startAt: / }\n`);
    const take = async (page: Page): Promise<Observed> =>
      page.evaluate(() => {
        const store = window as unknown as { __seen: string[] };
        const events = [...store.__seen];
        store.__seen.length = 0;
        return { events, scrollY: Math.round(window.scrollY) };
      });
    await runRecording({
      name: 'shift',
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page, panel }) => {
        await page.evaluate(() => {
          const store = window as unknown as { __seen: string[] };
          store.__seen = [];
          addEventListener('scroll', () => store.__seen.push('scroll'), { passive: true });
          new MutationObserver((mutations) => {
            for (const mutation of mutations)
              if (mutation.type === 'attributes' && mutation.attributeName?.startsWith('data-qa-crawler'))
                store.__seen.push(`attribute ${mutation.attributeName}`);
          }).observe(document.documentElement, { attributes: true, subtree: true });
        });
        await page.locator('#n').scrollIntoViewIfNeeded();
        await page.locator('#n').click();
        await page.keyboard.type('Alex');
        await page.locator('#go').click();
        await page.waitForTimeout(1500);
        seen.capture = await take(page);
        const step = panel?.locator('li[data-step]').filter({ hasText: 'Go' }).first();
        // Étape choisie alors que l'élément est à l'écran : la page ne bouge pas.
        // Visible mais pas au centre (un recentrage ferait défiler).
        await page.evaluate(() => {
          window.scrollBy(0, 250);
        });
        await page.waitForTimeout(300);
        const before = await take(page);
        await step?.click();
        await page.waitForTimeout(1200);
        seen.visibleBefore = before;
        seen.visible = await take(page);
        // Étape choisie depuis le haut de la page : un défilement au plus près, jamais recentré.
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(300);
        await take(page);
        await step?.click();
        await page.waitForTimeout(1200);
        seen.offscreen = await take(page);
        seen.offscreenGeometry = {
          events: [],
          scrollY: await page.evaluate(() => {
            const box = document.getElementById('go')?.getBoundingClientRect();
            return box ? Math.round(window.innerHeight - box.bottom) : -1;
          }),
        };
      },
    });
  }, 120_000);

  afterAll(() => {
    server.close();
  });

  it('validating the targets writes nothing into the application DOM', () => {
    expect(seen.capture?.events.filter((event) => event.startsWith('attribute'))).toEqual([]);
  });

  it('selecting a step whose element is visible never scrolls the page', () => {
    expect(seen.visible?.events).toEqual([]);
    expect(seen.visible?.scrollY).toBe(seen.visibleBefore?.scrollY);
  });

  it('an off-screen element is scrolled to the nearest edge, never centred', () => {
    expect(seen.offscreen?.events).toContain('scroll');
    // Au plus près : l'élément touche le bas de l'écran (à quelques pixels), il n'est pas au milieu.
    expect(seen.offscreenGeometry?.scrollY).toBeLessThan(40);
    expect(seen.offscreenGeometry?.scrollY).toBeGreaterThanOrEqual(0);
  });
});
