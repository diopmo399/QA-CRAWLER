import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { NavigationEvent } from '../../src/navigation/navigation-guard.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Une mission autonome où la lecture de la page qui suit « Créer » (une MUTATION) tombe
 * pendant une vraie navigation : page.evaluate échoue avec « Execution context was
 * destroyed, most likely because of a navigation », comme après une connexion unique.
 * La mission doit continuer, sans renvoyer le formulaire ni contourner la SafetyPolicy.
 */
describe('an autonomous mission whose page navigates while it is read', () => {
  let server: Server;
  let result: ExplorationResult;
  let creates = 0;
  let deletes = 0;
  const logged: NavigationEvent[] = [];
  let reproduced: string | undefined;

  beforeAll(async () => {
    const page = (body: string): string =>
      `<!doctype html><html><head><meta charset="utf-8"><title>Dossiers</title></head><body>${body}</body></html>`;
    server = createServer((req, res) => {
      const send = (body: string, status = 200, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(body);
      };
      if (req.method === 'POST' && req.url === '/create') {
        creates += 1;
        send('', 303, { location: '/created' });
        return;
      }
      if (req.method === 'POST' && req.url === '/delete') {
        deletes += 1;
        send('', 303, { location: '/' });
        return;
      }
      if (req.url === '/created') {
        send(
          page(`<h1>Dossier créé</h1><a href="/next">Suite</a>
<form method="post" action="/delete"><button type="submit">Supprimer le dossier</button></form>`),
        );
        return;
      }
      if (req.url === '/next') {
        send(page('<h1>Étape suivante</h1><a href="/">Accueil</a>'));
        return;
      }
      send(
        page(`<h1>Nouveau dossier</h1>
<form method="post" action="/create"><label for="n">Nom</label><input id="n" name="nom"><button type="submit">Créer</button></form>`),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-nav-recovery-'));

    /** La première lecture après l'envoi du formulaire est interrompue par une vraie navigation (rechargement). */
    class NavigatingObserver extends UIObserver {
      private interrupted = false;
      override observe(target: Page): Promise<Awaited<ReturnType<UIObserver['observe']>>> {
        if (this.interrupted || creates === 0) return super.observe(target);
        this.interrupted = true;
        let first = true;
        const navigating = new Proxy(target, {
          get(page, property, receiver) {
            if (property !== 'evaluate') return Reflect.get(page, property, receiver) as unknown;
            return (...args: Parameters<Page['evaluate']>) => {
              if (!first) return page.evaluate(...args);
              first = false;
              return page
                .evaluate(
                  () =>
                    new Promise((resolve) => {
                      location.reload();
                      setTimeout(resolve, 5000);
                    }),
                )
                .catch((error: unknown) => {
                  reproduced = error instanceof Error ? error.message : String(error);
                  throw error;
                });
            };
          },
        });
        return super.observe(navigating);
      }
    }

    const { config } = parseConfig(
      `
mission: { name: navigation-recovery }
target: { baseUrl: ${url} }
exploration: { maxStates: 10, maxActions: 20, actionTimeoutMs: 3000, settleTimeMs: 50 }
safety:
  mutations: { enabled: true, maxPerRun: 5 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    ({ result } = await runMission(config, {
      observer: (navigation) => new NavigatingObserver(400, navigation),
      listener: { onNavigation: (event) => logged.push(event) },
    }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('reproduces the original error inside the mission', () => {
    expect(reproduced).toMatch(
      /page\.evaluate: Execution context was destroyed, most likely because of a navigation/,
    );
  });

  it('recovers: NAVIGATION_DETECTED then NAVIGATION_RECOVERED, reported in result.recovery.navigation', () => {
    expect(logged.map((event) => event.type)).toEqual(['NAVIGATION_DETECTED', 'NAVIGATION_RECOVERED']);
    expect(logged[1]).toMatchObject({ operation: 'dom-snapshot', reason: 'CONTEXT_DESTROYED' });
    expect(logged[1]?.retries).toBeGreaterThanOrEqual(1);
    expect(logged[1]?.retries).toBeLessThanOrEqual(3);
    expect(result.recovery?.navigation?.map((event) => event.type)).toEqual([
      'NAVIGATION_DETECTED',
      'NAVIGATION_RECOVERED',
    ]);
  });

  it('the exploration goes on after the recovery: the pages after the mutation are explored', () => {
    const headings = result.states.flatMap((state) => state.headings);
    expect(headings).toEqual(expect.arrayContaining(['Nouveau dossier', 'Dossier créé', 'Étape suivante']));
    expect(result.stopReason).not.toBe('error');
  });

  it('the mutation is sent once: never replayed by the recovery', () => {
    expect(creates).toBe(1);
  });

  it('the Safety Policy still applies after the recovery: the dangerous action is blocked', () => {
    expect(deletes).toBe(0);
    const blocked = result.transitions.filter((edge) => edge.result === 'BLOCKED');
    expect(blocked.some((edge) => /Supprimer/.test(edge.action.text ?? ''))).toBe(true);
  });

  it('a recovered navigation is not an application anomaly', () => {
    expect(
      result.issues.filter((issue) => /Execution context|navigation recovery/i.test(issue.message)),
    ).toEqual([]);
  });
});

/**
 * Une page qui ne cesse pas de naviguer pendant qu'on la lit : les lectures (bornées) échouent,
 * NAVIGATION_RECOVERY_FAILED est signalé avec la cause, et l'exploration repart d'un état connu
 * au lieu de s'arrêter.
 */
describe('a page that never stops navigating while it is read', () => {
  let server: Server;
  let result: ExplorationResult;
  const logged: NavigationEvent[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/instable')
        res.end('<!doctype html><title>I</title><h1>Instable</h1><a href="/">Retour</a>');
      else if (req.url === '/stable')
        res.end('<!doctype html><title>S</title><h1>Stable</h1><a href="/">Retour</a>');
      else
        res.end(
          '<!doctype html><title>A</title><h1>Accueil</h1><a href="/instable">Instable</a> <a href="/stable">Stable</a>',
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-nav-unstable-'));

    /** Sur /instable, chaque lecture est interrompue par un rechargement : le garde abandonne après ses tentatives. */
    class UnstableObserver extends UIObserver {
      override observe(target: Page): Promise<Awaited<ReturnType<UIObserver['observe']>>> {
        if (!target.url().endsWith('/instable')) return super.observe(target);
        const navigating = new Proxy(target, {
          get(page, property, receiver) {
            if (property !== 'evaluate') return Reflect.get(page, property, receiver) as unknown;
            return () =>
              page.evaluate(
                () =>
                  new Promise((resolve) => {
                    location.reload();
                    setTimeout(resolve, 5000);
                  }),
              );
          },
        });
        return super.observe(navigating);
      }
    }

    const { config } = parseConfig(
      `
mission: { name: navigation-unstable }
target: { baseUrl: ${url} }
exploration: { maxStates: 10, maxActions: 20, actionTimeoutMs: 3000, settleTimeMs: 50 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    ({ result } = await runMission(config, {
      observer: (navigation) => new UnstableObserver(400, navigation),
      listener: { onNavigation: (event) => logged.push(event) },
    }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('reports NAVIGATION_RECOVERY_FAILED with the original cause, after a bounded number of retries', () => {
    const failed = logged.find((event) => event.type === 'NAVIGATION_RECOVERY_FAILED');
    expect(failed).toMatchObject({ reason: 'CONTEXT_DESTROYED', retries: 3 });
    expect(failed?.cause).toMatch(/Execution context was destroyed/);
  });

  it('does not stop the mission: the other pages are still explored', () => {
    expect(result.states.flatMap((state) => state.headings)).toEqual(
      expect.arrayContaining(['Accueil', 'Stable']),
    );
    expect(result.stopReason).not.toBe('error');
  });
});
