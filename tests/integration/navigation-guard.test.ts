import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ActionDiscovery } from '../../src/discovery/action-discovery.js';
import { PlaywrightActionExecutor } from '../../src/execution/playwright-action-executor.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import {
  classifyPlaywrightError,
  NavigationGuard,
  type NavigationEvent,
} from '../../src/navigation/navigation-guard.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

const DESTROYED = /page\.evaluate: Execution context was destroyed, most likely because of a navigation/;

/**
 * De vraies navigations dans Chromium : lien, redirection HTTP, envoi de formulaire,
 * route d'application monopage, cadre retiré, et le « Execution context was destroyed »
 * d'origine. Le NavigationGuard doit les voir comme des changements d'état, pas des pannes.
 */
describe('NavigationGuard in a real browser', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let base = '';
  let posts = 0;
  let events: NavigationEvent[] = [];
  let guard: NavigationGuard;

  const html = (body: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>${body}</body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (body: string, status = 200, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(body);
      };
      if (req.url === '/redirect') {
        send('', 302, { location: '/landing' });
        return;
      }
      if (req.url === '/landing') {
        send(html('<h1>Arrivée</h1><a href="/">Accueil</a>'));
        return;
      }
      if (req.url === '/create' && req.method === 'POST') {
        posts += 1;
        send('', 303, { location: '/created' });
        return;
      }
      if (req.url === '/created') {
        send(html('<h1>Créé</h1>'));
        return;
      }
      if (req.url === '/spa') {
        send(
          html(
            `<h1 id="t">Liste</h1><button onclick="history.pushState({}, '', '/spa/details'); document.getElementById('t').textContent='Détails'">Détails</button>`,
          ),
        );
        return;
      }
      if (req.url === '/frame') {
        send(html('<iframe src="/landing"></iframe>'));
        return;
      }
      send(
        html(`<h1>Accueil</h1>
<a href="/landing">Aller</a>
<a href="/redirect">Redirection</a>
<form method="post" action="/create"><button type="submit">Créer</button></form>`),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  beforeEach(async () => {
    events = [];
    posts = 0;
    guard = new NavigationGuard({ onEvent: (event) => events.push(event) });
    page = await browser.newPage();
    guard.watch(page);
    await page.goto(base);
  });

  const discover = async (target: Page): Promise<DiscoveredAction[]> => {
    const snapshot = await new UIObserver(400, guard).observe(target);
    return new ActionDiscovery(new SafetyPolicy(testConfig().safety)).discover(snapshot, 's');
  };
  const actionNamed = async (label: string): Promise<DiscoveredAction> => {
    const found = (await discover(page)).find((action) => (action.text ?? action.label) === label);
    if (!found) throw new Error(`no action "${label}"`);
    return found;
  };
  /** Un page.evaluate qui déclenche une navigation et attend : il échoue comme dans le crash d'origine. */
  const navigateDuringEvaluate = (to: string): Promise<unknown> =>
    page.evaluate(
      (target) =>
        new Promise((resolve) => {
          location.href = target;
          setTimeout(resolve, 5000);
        }),
      to,
    );
  /** La page telle que le guard la voit, avec des lectures interrompues par de vraies navigations. */
  const navigatingPage = (targets: string[], then?: () => Promise<unknown>): Page =>
    new Proxy(page, {
      get(target, property, receiver) {
        if (property !== 'evaluate') return Reflect.get(target, property, receiver) as unknown;
        return (...args: Parameters<Page['evaluate']>) => {
          const next = targets.shift();
          if (next !== undefined) return navigateDuringEvaluate(next);
          if (then) {
            const failing = then;
            then = undefined;
            return failing();
          }
          return target.evaluate(...args);
        };
      },
    });

  it('reproduces the exact error: page.evaluate while the page navigates', async () => {
    await expect(navigateDuringEvaluate('/landing')).rejects.toThrow(DESTROYED);
    expect(
      classifyPlaywrightError(await navigateDuringEvaluate('/').catch((error: unknown) => error)).kind,
    ).toBe('CONTEXT_DESTROYED');
  });

  it('navigation during the DOM snapshot: the new page is read and discovery runs on it', async () => {
    const actions = await discover(navigatingPage(['/landing']));
    // Les actions sont celles de la nouvelle page : l'ancien document n'est pas réutilisé.
    expect(actions.map((action) => action.text ?? action.label)).toEqual(['Accueil']);
    expect(events.map((event) => event.type)).toEqual(['NAVIGATION_DETECTED', 'NAVIGATION_RECOVERED']);
    expect(events[1]).toMatchObject({
      reason: 'CONTEXT_DESTROYED',
      previousUrl: `${base}/`,
      currentUrl: `${base}/landing`,
    });
    // Au moins une relecture ; une de plus si la lecture retombe dans la navigation encore en cours (selon la machine).
    expect(events[1]?.retries).toBeGreaterThanOrEqual(1);
    expect(events[1]?.retries).toBeLessThanOrEqual(3);
  });

  it('several successive navigations (single sign-on style) are followed to the last page', async () => {
    const snapshot = await new UIObserver(400, guard).observe(navigatingPage(['/redirect', '/created']));
    expect(snapshot.headings).toEqual(['Créé']);
    // Une relecture par navigation au moins, toujours dans la limite (4 lectures) ; le compte exact dépend du minutage.
    expect(events.at(-1)?.type).toBe('NAVIGATION_RECOVERED');
    expect(events.at(-1)?.retries).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.retries).toBeLessThanOrEqual(3);
  });

  it('a navigation followed by a real error: the real error is raised', async () => {
    const observer = new UIObserver(400, guard);
    const broken = navigatingPage(['/landing'], () =>
      page.evaluate(() => (null as unknown as { x: number }).x),
    );
    await expect(observer.observe(broken)).rejects.toThrow(/Cannot read properties of null/);
    expect(events.map((event) => event.type)).toEqual(['NAVIGATION_DETECTED']);
  });

  it('a click that navigates: SUCCESS, navigationOccurred, previous and current URL', async () => {
    const executor = new PlaywrightActionExecutor(5000, 0, guard);
    const result = await executor.execute(page, await actionNamed('Aller'));
    expect(result).toMatchObject({
      status: 'SUCCESS',
      navigationOccurred: true,
      contextChanged: true,
      urlBefore: `${base}/`,
      urlAfter: `${base}/landing`,
    });
  });

  it('an HTTP redirect: the final page is the current URL', async () => {
    const executor = new PlaywrightActionExecutor(5000, 0, guard);
    const result = await executor.execute(page, await actionNamed('Redirection'));
    expect(result).toMatchObject({
      status: 'SUCCESS',
      navigationOccurred: true,
      urlAfter: `${base}/landing`,
    });
  });

  it('a form submission that navigates is sent once, never twice', async () => {
    const executor = new PlaywrightActionExecutor(5000, 0, guard);
    const result = await executor.execute(page, await actionNamed('Créer'));
    expect(result).toMatchObject({
      status: 'SUCCESS',
      navigationOccurred: true,
      urlAfter: `${base}/created`,
    });
    expect(posts).toBe(1);
  });

  it('an SPA route change (history API) is a navigation, without a new document', async () => {
    await page.goto(`${base}/spa`);
    const executor = new PlaywrightActionExecutor(5000, 0, guard);
    const result = await executor.execute(page, await actionNamed('Détails'));
    expect(result).toMatchObject({
      status: 'SUCCESS',
      navigationOccurred: true,
      urlAfter: `${base}/spa/details`,
    });
    // Le nouvel état est relu : le titre a changé.
    expect((await new UIObserver(400, guard).observe(page)).headings).toEqual(['Détails']);
  });

  it('a click that does not navigate is not reported as a navigation', async () => {
    await page.goto(`${base}/spa`);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<button>Rien</button>');
    });
    const executor = new PlaywrightActionExecutor(5000, 0, guard);
    const result = await executor.execute(page, await actionNamed('Rien'));
    expect(result).toMatchObject({ status: 'SUCCESS', navigationOccurred: false, contextChanged: false });
    expect(events).toEqual([]);
  });

  it('a detached frame is recognized as a navigation, not a functional error', async () => {
    await page.goto(`${base}/frame`);
    const frame = page.frames()[1];
    if (!frame) throw new Error('no frame');
    await frame.waitForLoadState('domcontentloaded');
    await page.evaluate(() => document.querySelector('iframe')?.remove());
    const error = await frame.evaluate(() => 1).catch((caught: unknown) => caught);
    expect(classifyPlaywrightError(error)).toMatchObject({ kind: 'FRAME_DETACHED', navigation: true });
  });
});
