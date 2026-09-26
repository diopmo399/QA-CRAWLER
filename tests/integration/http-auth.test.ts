import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/authenticator.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { BrowserInteractionResult } from '../../src/interactions/types.js';
import type { FlowGraphData } from '../../src/model/flow.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * The browser's own sign-in dialog (HTTP Basic, e.g. SiteMinder Basic
 * scheme). It is not in the DOM: it is detected through the browser
 * protocol and answered by the HttpAuthHandler with credentials from the
 * environment — never with locators, clicks or keyboard.
 *
 *   /            public page with links to protected areas
 *   /secure/     Basic realm "Secure", accepts USER:PASSWORD
 *   /flaky/      rejects the first valid answer, then accepts (retry)
 *   /loop/       asks again forever with a new realm (loop)
 */
const USER = 'agent.qa';
const PASSWORD = 'Basic-S3cret!';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

describe('HTTP authentication (browser sign-in dialog)', () => {
  let server: Server;
  let url = '';
  let outputDir = '';
  /** Authorization headers received (to prove what was — or was not — sent). */
  let authorizations: string[] = [];
  let flakyRejections = 0;
  let loopRealm = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const requestPath = req.url ?? '/';
      const header = req.headers.authorization;
      if (header) authorizations.push(header);
      const page = (title: string, body = ''): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`,
        );
      };
      const challenge = (realm: string): void => {
        res.writeHead(401, { 'www-authenticate': `Basic realm="${realm}"`, 'content-type': 'text/html' });
        res.end('<h1>401</h1>');
      };
      if (requestPath.startsWith('/secure')) {
        if (header !== BASIC) {
          challenge('Secure');
          return;
        }
        page('Espace sécurisé', '<a href="/">Accueil</a>');
        return;
      }
      if (requestPath.startsWith('/flaky')) {
        if (header !== BASIC || flakyRejections > 0) {
          if (header === BASIC) flakyRejections -= 1;
          challenge('Flaky');
          return;
        }
        page('Espace instable');
        return;
      }
      if (requestPath.startsWith('/siteminderagent')) {
        // SiteMinder-like popup: native sign-in, then tells the application and closes itself.
        if (header !== BASIC) {
          challenge('SiteMinder');
          return;
        }
        page(
          'Connexion réussie',
          "<script>window.opener.document.getElementById('etat').textContent = 'connecté'; setTimeout(() => window.close(), 200);</script>",
        );
        return;
      }
      if (requestPath.startsWith('/loop')) {
        loopRealm += 1;
        challenge(`Loop-${String(loopRealm)}`);
        return;
      }
      page(
        'Accueil',
        '<p id="etat">déconnecté</p><a href="/secure/">Espace sécurisé</a> <a href="/flaky/">Espace instable</a> <a href="/loop/">Espace en boucle</a> <button onclick="window.open(\'/siteminderagent/ntlm/smntlm.ntc?TARGET=app\')">Connexion SSO</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-http-auth-'));
  });

  beforeEach(() => {
    authorizations = [];
    flakyRejections = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const mission = (name: string, yaml: string) =>
    parseConfig(
      `
mission:
  name: ${name}
target:
  baseUrl: ${url}
exploration:
  autonomous: false
  maxDurationMinutes: 1
  settleTimeMs: 50
  actionTimeoutMs: 5000
output:
  reportsDir: ${path.join(outputDir, name, 'reports')}
  screenshotsDir: ${path.join(outputDir, name, 'screenshots')}
${yaml}`,
      {},
      {},
    ).config;

  /** A crawl with a credential profile and one imposed flow opening `target`. */
  const crawl = (name: string, target: string, extra = '') =>
    mission(
      name,
      `
credentials:
  qa-default: { usernameEnv: QA_USERNAME, passwordEnv: QA_PASSWORD }
browserInteractions:
${extra}
  httpAuth:
    credentialProfile: qa-default
flows:
  - name: zone
    steps:
      - click: { role: link, name: ${target} }
`,
    );
  const env = { QA_USERNAME: USER, QA_PASSWORD: PASSWORD };
  const auths = (interactions: BrowserInteractionResult[]) =>
    interactions.filter((interaction) => interaction.type === 'HTTP_AUTH');

  it('auth.type: http — answers the sign-in dialog with credentials from the environment', async () => {
    const { result } = await runMission(
      mission(
        'login',
        `auth:\n  type: http\n  origin: ${url}\n  checkUrl: /secure/\nflows:\n  - name: noop\n    steps: [{ expect: { text: Accueil } }]`,
      ),
      { env },
    );
    const [auth] = auths(result.browserInteractions);
    expect(auth).toMatchObject({
      status: 'HANDLED',
      outcome: 'AUTHENTICATED',
      handler: 'HttpAuthHandler',
      action: 'AUTHENTICATE',
      credentialProfile: 'auth',
      success: true,
      attempt: 1,
      origin: url,
      details: { scheme: 'basic', realm: 'Secure' },
    });
    expect(authorizations).toContain(BASIC);
    // Never any secret in the persisted flow nor in the reports.
    for (const file of ['result.json', 'index.html', 'flow-graph.html', 'flow-graph.json']) {
      const text = await readFile(path.join(outputDir, 'login', 'reports', file), 'utf8');
      expect(text, file).not.toContain(PASSWORD);
      expect(text, file).not.toContain(BASIC.slice(6));
    }
    const graph = JSON.parse(
      await readFile(path.join(outputDir, 'login', 'reports', 'flow-graph.json'), 'utf8'),
    ) as FlowGraphData;
    expect(graph.interactions?.[0]).toMatchObject({ type: 'HTTP_AUTH', credentialProfile: 'auth' });
  });

  it('detects the dialog during a flow, authenticates and continues', async () => {
    const { result } = await runMission(crawl('crawl-ok', 'Espace sécurisé'), { env });
    expect(result.flows[0]?.status).toBe('PASSED');
    const [auth] = auths(result.browserInteractions);
    expect(auth).toMatchObject({ outcome: 'AUTHENTICATED', flow: 'zone' });
    expect(auth?.actionId).toBeDefined();
    expect(result.states.some((state) => state.headings.includes('Espace sécurisé'))).toBe(true);
    // The transition that went through the dialog references it.
    const edge = result.transitions.find((transition) => transition.interactionIds?.includes(auth?.id ?? ''));
    expect(edge?.result).toBe('SUCCESS');
  });

  it('credentials missing: AUTH_REQUIRED, nothing invented, flow blocked', async () => {
    const { result } = await runMission(crawl('missing', 'Espace sécurisé'), { env: {} });
    const [auth] = auths(result.browserInteractions);
    expect(auth).toMatchObject({
      status: 'BLOCKED',
      outcome: 'AUTH_REQUIRED',
      action: 'CANCEL',
      blocking: true,
    });
    expect(authorizations).toEqual([]);
    expect(result.flows[0]?.status).toBe('BLOCKED');
    expect(result.flows[0]?.steps[0]?.reason).toContain('AUTH_REQUIRED');
    const issue = result.issues.find((candidate) => candidate.type === 'BROWSER_INTERACTION');
    expect(issue).toMatchObject({ severity: 'ERROR' });
    expect(issue?.message).toContain('AUTH_REQUIRED');
  });

  it('no credential profile configured: AUTH_REQUIRED from the safety policy', async () => {
    const { result } = await runMission(
      mission(
        'no-profile',
        'flows:\n  - name: zone\n    steps: [{ click: { role: link, name: Espace sécurisé } }]',
      ),
      { env },
    );
    const [auth] = auths(result.browserInteractions);
    expect(auth).toMatchObject({ status: 'BLOCKED', outcome: 'AUTH_REQUIRED', action: 'REFUSE' });
    expect(auth?.reason).toContain('credentialProfile');
    expect(authorizations).toEqual([]);
  });

  it('invalid credentials: bounded retry, then AUTH_FAILED', async () => {
    const { result } = await runMission(crawl('invalid', 'Espace sécurisé'), {
      env: { QA_USERNAME: USER, QA_PASSWORD: 'wrong' },
    });
    const attempts = auths(result.browserInteractions);
    expect(attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.outcome])).toEqual([
      [1, 'HANDLED', 'AUTHENTICATED'],
      [2, 'HANDLED', 'AUTHENTICATED'],
      [3, 'FAILED', 'AUTH_FAILED'],
    ]);
    expect(attempts[0]?.success).toBe(false); // rejected by the server, so retried
    expect(attempts[1]?.retryAttempted).toBe(true);
    expect(attempts[2]?.blocking).toBe(true);
    expect(result.flows[0]?.status).toBe('BLOCKED');
  });

  it('retry succeeds when the server accepts the second answer', async () => {
    flakyRejections = 1;
    const { result } = await runMission(crawl('flaky', 'Espace instable'), { env });
    const attempts = auths(result.browserInteractions);
    expect(attempts.map((attempt) => [attempt.attempt, attempt.success])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(attempts[1]).toMatchObject({ outcome: 'AUTHENTICATED', retryAttempted: true });
    expect(result.flows[0]?.status).toBe('PASSED');
  });

  it('stops an authentication loop: INTERACTION_LOOP_DETECTED', async () => {
    const { result } = await runMission(crawl('loop', 'Espace en boucle', '  loopThreshold: 3'), {
      env,
    });
    const attempts = auths(result.browserInteractions);
    expect(attempts.length).toBe(4);
    expect(attempts[3]).toMatchObject({
      status: 'BLOCKED',
      outcome: 'INTERACTION_LOOP_DETECTED',
      blocking: true,
    });
    expect(result.flows[0]?.status).toBe('BLOCKED');
  });

  it('never sends the credentials to an origin that is not allowed', async () => {
    const { result } = await runMission(
      mission(
        'other-origin',
        `
credentials:
  qa-default: { usernameEnv: QA_USERNAME, passwordEnv: QA_PASSWORD }
browserInteractions:
  httpAuth:
    credentialProfile: qa-default
    origins: [https://sso.example.com]
flows:
  - name: zone
    steps: [{ click: { role: link, name: Espace sécurisé } }]
`,
      ),
      { env },
    );
    const [auth] = auths(result.browserInteractions);
    expect(auth).toMatchObject({
      status: 'BLOCKED',
      outcome: 'CREDENTIALS_NOT_ALLOWED',
      blocking: true,
    });
    expect(authorizations).toEqual([]);
  });

  it('auth.type: http — clear errors for rejected, missing or misdirected credentials', async () => {
    const login = (name: string, extra = '') =>
      mission(name, `auth:\n  type: http\n  checkUrl: /secure/\n${extra}`);
    await expect(
      runMission(login('login-wrong'), { env: { QA_USERNAME: USER, QA_PASSWORD: 'nope' } }),
    ).rejects.toThrowError(/HTTP authentication AUTH_FAILED/);
    const missing = runMission(login('login-missing'), { env: {} });
    await expect(missing).rejects.toBeInstanceOf(AuthError);
    await expect(runMission(login('login-missing-2'), { env: {} })).rejects.toThrowError(
      /AUTH_REQUIRED.*QA_USERNAME, QA_PASSWORD/,
    );
    authorizations = [];
    await expect(
      runMission(login('login-origin', '  origin: https://sso.example.com\n'), { env }),
    ).rejects.toThrowError(/CREDENTIALS_NOT_ALLOWED.*auth\.origin/);
    expect(authorizations).toEqual([]);
  });

  it('sign-in dialog inside a popup (SiteMinder): caught, handled, and the popup finishes on its own', async () => {
    const { result } = await runMission(
      mission(
        'popup-sso',
        `
credentials:
  qa-default: { usernameEnv: QA_USERNAME, passwordEnv: QA_PASSWORD }
browserInteractions:
  httpAuth:
    credentialProfile: qa-default
  popups:
    closeAfterMs: 5000
flows:
  - name: sso
    steps:
      - click: { role: button, name: Connexion SSO }
      - expect: { text: connecté }
`,
      ),
      { env },
    );
    expect(result.flows[0]?.status).toBe('PASSED');
    const [auth] = auths(result.browserInteractions);
    expect(auth).toMatchObject({
      status: 'HANDLED',
      outcome: 'AUTHENTICATED',
      details: { realm: 'SiteMinder' },
    });
    expect(auth?.targetUrl).toContain('/siteminderagent/ntlm/smntlm.ntc');
    const popup = result.browserInteractions.find((interaction) => interaction.type === 'POPUP');
    expect(popup).toMatchObject({
      status: 'HANDLED',
      outcome: 'POPUP_CLOSED',
      details: { closedByPage: true },
    });
    expect(authorizations).toContain(BASIC);
  });
});
