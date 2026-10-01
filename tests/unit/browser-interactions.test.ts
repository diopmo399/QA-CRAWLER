import { inspect } from 'node:util';
import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import {
  BrowserInteractionManager,
  formatLogLine,
} from '../../src/interactions/browser-interaction-manager.js';
import { Credentials, EnvironmentCredentialProvider } from '../../src/interactions/credential-provider.js';
import { browserHttpCredentials } from '../../src/interactions/browser-credentials.js';
import type { BrowserInteractionHandler } from '../../src/interactions/handler.js';
import { HttpAuthHandler } from '../../src/interactions/handlers/http-auth-handler.js';
import type { BrowserInteraction, BrowserInteractionType } from '../../src/interactions/types.js';
import { InteractionPolicy } from '../../src/policies/interaction-policy.js';
import { AllowedOriginPolicy } from '../../src/policies/origin-policy.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';

const TARGET = 'https://app.example.com';

function setup(yaml = '', env: NodeJS.ProcessEnv = {}) {
  const { config } = parseConfig(
    `target:\n  baseUrl: ${TARGET}/\nsafety:\n  allowedHosts: [app.example.com, api.example.com]\n${yaml}`,
    {},
    {},
  );
  const safety = new SafetyPolicy(config.safety);
  const origins = new AllowedOriginPolicy(
    TARGET,
    safety.navigation,
    config.browserInteractions.blockedOrigins,
  );
  const policy = new InteractionPolicy(config.browserInteractions, safety, origins);
  const manager = new BrowserInteractionManager({
    config: config.browserInteractions,
    policy,
    credentials: new EnvironmentCredentialProvider(config.credentials, env),
    crawlContext: () => ({ stateId: 'state-1', actionId: 'action-1' }),
  });
  return { config, origins, policy, manager };
}

let ids = 0;
function interaction(
  type: BrowserInteractionType,
  overrides: Partial<BrowserInteraction> = {},
): BrowserInteraction & { fallback: ReturnType<typeof vi.fn> } {
  ids += 1;
  const fallback = vi.fn(() => Promise.resolve());
  return {
    id: `T-${String(ids)}`,
    type,
    page: {} as Page,
    sourceUrl: `${TARGET}/page`,
    details: {},
    native: { kind: 'none' },
    ...overrides,
    fallback,
  };
}

describe('BrowserInteractionManager', () => {
  it('unknown interaction: UNSUPPORTED, safe fallback applied', async () => {
    const { manager } = setup();
    const unknown = interaction('UNKNOWN_BROWSER_INTERACTION', { details: { dialog: 'beforeunload' } });
    const result = await manager.dispatch(unknown);
    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      outcome: 'NO_HANDLER',
      stateId: 'state-1',
      actionId: 'action-1',
    });
    expect(unknown.fallback).toHaveBeenCalledOnce();
  });

  it('blocked by the safety policy: the handler never runs, fallback applied', async () => {
    const { manager } = setup();
    const handle = vi.fn();
    const grant: BrowserInteractionHandler = { name: 'Grant', handles: ['PERMISSION_REQUEST'], handle };
    manager.register(grant);
    const request = interaction('PERMISSION_REQUEST', { details: { permission: 'camera' } });
    const result = await manager.dispatch(request);
    expect(result).toMatchObject({ status: 'BLOCKED', outcome: 'PERMISSION_DENIED', handler: 'Grant' });
    expect(handle).not.toHaveBeenCalled();
    expect(request.fallback).toHaveBeenCalledOnce();
  });

  it('handler error or timeout: FAILED, fallback applied, never stuck', async () => {
    const { manager } = setup('browserInteractions:\n  timeoutMs: 50\n');
    manager.register({
      name: 'Broken',
      handles: ['DOWNLOAD'],
      handle: () => Promise.reject(new Error('boom')),
    });
    manager.register({
      name: 'Slow',
      handles: ['JS_ALERT'],
      handle: () => new Promise(() => undefined),
    });
    const broken = interaction('DOWNLOAD');
    expect(await manager.dispatch(broken)).toMatchObject({
      status: 'FAILED',
      outcome: 'ERROR',
      reason: 'boom',
    });
    expect(broken.fallback).toHaveBeenCalled();
    const slow = interaction('JS_ALERT');
    expect(await manager.dispatch(slow)).toMatchObject({ status: 'FAILED', outcome: 'TIMEOUT' });
    expect(slow.fallback).toHaveBeenCalled();
  });

  it('the same interaction over and over: INTERACTION_LOOP_DETECTED, then stopped', async () => {
    const { manager } = setup('browserInteractions:\n  loopThreshold: 3\n');
    manager.register({
      name: 'Accept',
      handles: ['JS_ALERT'],
      handle: () => Promise.resolve({ status: 'HANDLED', success: true }),
    });
    const statuses = [];
    for (let index = 0; index < 5; index += 1) {
      statuses.push((await manager.dispatch(interaction('JS_ALERT'))).outcome ?? 'ok');
    }
    expect(statuses).toEqual(['ok', 'ok', 'ok', 'INTERACTION_LOOP_DETECTED', 'INTERACTION_LOOP_DETECTED']);
    expect(manager.blockingSince(0).length).toBe(2);
  });

  it('HTTP auth: credentials resolved from a profile, bounded retries, logs without secrets', async () => {
    const { manager } = setup(
      'credentials:\n  qa-default: { usernameEnv: QA_U, passwordEnv: QA_P }\nbrowserInteractions:\n  httpAuth:\n    credentialProfile: qa-default\n',
      { QA_U: 'agent', QA_P: 'Sup3r-Secret' },
    );
    const lines: string[] = [];
    const logged = new BrowserInteractionManager({
      ...(manager as unknown as { options: ConstructorParameters<typeof BrowserInteractionManager>[0] })
        .options,
      log: (line) => lines.push(line),
    }).register(new HttpAuthHandler());
    const provided: string[] = [];
    const auth = () =>
      interaction('HTTP_AUTH', {
        origin: TARGET,
        details: { scheme: 'basic', realm: 'R' },
        native: {
          kind: 'http-auth',
          provideCredentials: (username, password) => {
            provided.push(`${username}:${password}`);
            return Promise.resolve();
          },
          cancel: () => Promise.resolve(),
        },
      });
    const results = [];
    for (let index = 0; index < 3; index += 1) results.push(await logged.dispatch(auth()));
    expect(results.map((result) => [result.attempt, result.status, result.outcome])).toEqual([
      [1, 'HANDLED', 'AUTHENTICATED'],
      [2, 'HANDLED', 'AUTHENTICATED'],
      [3, 'FAILED', 'AUTH_FAILED'],
    ]);
    expect(provided).toEqual(['agent:Sup3r-Secret', 'agent:Sup3r-Secret']);
    expect(lines[0]).toBe(
      `[BROWSER_INTERACTION] type=HTTP_AUTH origin=${TARGET} handler=HttpAuthHandler status=HANDLED outcome=AUTHENTICATED action=AUTHENTICATE attempt=1 state=state-1`,
    );
    for (const text of [...lines, JSON.stringify(results)]) expect(text).not.toContain('Sup3r-Secret');
  });

  it('formats a structured log line', () => {
    expect(
      formatLogLine({
        id: 'BI-1',
        type: 'POPUP',
        status: 'HANDLED',
        sourceUrl: `${TARGET}/a`,
        targetUrl: `${TARGET}/b`,
        timestamp: '',
        attempt: 1,
        retryAttempted: false,
        success: true,
        blocking: false,
        details: {},
      }),
    ).toBe(`[BROWSER_INTERACTION] type=POPUP origin=${TARGET} status=HANDLED attempt=1`);
  });
});

describe('InteractionPolicy', () => {
  it('HTTP auth: credentials only to trusted origins, from a configured profile', () => {
    const withProfile = setup(
      'credentials:\n  p: { usernameEnv: A, passwordEnv: B }\nbrowserInteractions:\n  httpAuth:\n    credentialProfile: p\n',
    );
    const decide = (origin: string) => withProfile.policy.evaluate(interaction('HTTP_AUTH', { origin }));
    expect(decide(TARGET)).toMatchObject({
      verdict: 'ALLOW',
      credentialProfile: 'p',
      originClass: 'SAME_ORIGIN',
    });
    expect(decide('https://api.example.com')).toMatchObject({
      verdict: 'ALLOW',
      originClass: 'ALLOWED_ORIGIN',
    });
    expect(decide('https://evil.example.org')).toMatchObject({
      verdict: 'BLOCK',
      outcome: 'CREDENTIALS_NOT_ALLOWED',
    });
    expect(setup().policy.evaluate(interaction('HTTP_AUTH', { origin: TARGET }))).toMatchObject({
      verdict: 'BLOCK',
      outcome: 'AUTH_REQUIRED',
    });
  });

  it('dialogs: destructive confirm never accepted, prompt never invented', () => {
    const { policy } = setup(
      'browserInteractions:\n  dialogs:\n    confirm: accept-safe\n    promptValues: [{ match: "Nom", value: "QA" }]\n',
    );
    const confirm = (message: string) =>
      policy.evaluate(interaction('JS_CONFIRM', { details: { message } })).dialog;
    expect(confirm('Supprimer le dossier ?')).toEqual({ accept: false });
    expect(confirm('Voulez-vous vraiment payer ?')).toEqual({ accept: false });
    expect(confirm('Continuer la lecture ?')).toEqual({ accept: true });
    expect(
      setup().policy.evaluate(interaction('JS_CONFIRM', { details: { message: 'Continuer ?' } })).dialog,
    ).toEqual({
      accept: false,
    });
    expect(
      policy.evaluate(interaction('JS_PROMPT', { details: { message: 'Nom du dossier' } })),
    ).toMatchObject({
      verdict: 'ALLOW',
      dialog: { accept: true, value: 'QA' },
    });
    expect(policy.evaluate(interaction('JS_PROMPT', { details: { message: 'Code ?' } }))).toMatchObject({
      verdict: 'BLOCK',
      outcome: 'PROMPT_VALUE_REQUIRED',
    });
  });

  it('permissions, file chooser, popups and navigation', () => {
    const { policy } = setup(
      'browserInteractions:\n  permissions:\n    grant: [clipboard-read]\n  blockedOrigins: [https://blocked.example.net]\n',
    );
    const permission = (name: string) =>
      policy.evaluate(interaction('PERMISSION_REQUEST', { details: { permission: name } })).verdict;
    expect(permission('clipboard-read')).toBe('ALLOW');
    expect(permission('camera')).toBe('BLOCK');
    expect(permission('geolocation')).toBe('BLOCK');
    expect(policy.evaluate(interaction('FILE_CHOOSER')).outcome).toBe('FILE_INPUT_REQUIRED');
    const popup = (targetUrl: string) =>
      policy.evaluate(interaction('POPUP', { targetUrl, origin: new URL(targetUrl).origin }));
    expect(popup(`${TARGET}/doc`)).toMatchObject({ verdict: 'ALLOW', originClass: 'SAME_ORIGIN' });
    expect(popup('https://other.example.org/')).toMatchObject({
      verdict: 'BLOCK',
      outcome: 'EXTERNAL_ORIGIN',
    });
    expect(popup('https://blocked.example.net/x')).toMatchObject({
      verdict: 'BLOCK',
      outcome: 'BLOCKED_ORIGIN',
    });
  });
});

describe('AllowedOriginPolicy', () => {
  it('classifies same, allowed, external and blocked origins', () => {
    const { origins } = setup('browserInteractions:\n  blockedOrigins: [https://blocked.example.net]\n');
    expect(origins.classify(`${TARGET}/x`)).toBe('SAME_ORIGIN');
    expect(origins.classify('https://api.example.com/v1')).toBe('ALLOWED_ORIGIN');
    expect(origins.classify('http://app.example.com/')).toBe('ALLOWED_ORIGIN'); // autre schéma = autre origine
    expect(origins.classify('https://external-service.com/')).toBe('EXTERNAL_ORIGIN');
    expect(origins.classify('https://blocked.example.net/')).toBe('BLOCKED_ORIGIN');
    expect(origins.classify('about:blank')).toBeUndefined();
  });
});

describe('Credentials', () => {
  it('never leak through JSON, string conversion or console inspection', async () => {
    const provider = new EnvironmentCredentialProvider(
      { qa: { usernameEnv: 'U', passwordEnv: 'P' } },
      { U: 'agent', P: 'Sup3r-Secret' },
    );
    const credentials = await provider.resolve({ type: 'HTTP_AUTH', profile: 'qa' });
    expect(credentials).toBeInstanceOf(Credentials);
    expect(credentials?.password).toBe('Sup3r-Secret');
    for (const text of [
      JSON.stringify({ credentials }),
      String(credentials),
      inspect(credentials),
      `Profile: ${credentials?.toString() ?? ''}`,
    ]) {
      expect(text).not.toContain('Sup3r-Secret');
      expect(text).not.toContain('agent');
    }
    expect(await provider.resolve({ type: 'HTTP_AUTH', profile: 'unknown' })).toBeUndefined();
    expect(provider.missingVariables('qa')).toEqual([]);
  });
});

describe('configuration', () => {
  const base = 'target:\n  baseUrl: https://app.example.com\n';
  it('keeps defaults safe and maps auth.type: http to a credential profile', () => {
    const { config } = parseConfig(base, {}, {});
    expect(config.browserInteractions).toMatchObject({
      enabled: true,
      retry: { maxAttempts: 2 },
      loopThreshold: 5,
      dialogs: { alert: 'accept', confirm: 'dismiss', promptValues: [] },
      permissions: { grant: [] },
    });
    expect(config.browserInteractions.httpAuth.credentialProfile).toBeUndefined();
    const http = parseConfig(
      `${base}auth:\n  type: http\n  origin: https://sso.example.com/x\n`,
      {},
      {},
    ).config;
    expect(http.credentials.auth).toEqual({ usernameEnv: 'QA_USERNAME', passwordEnv: 'QA_PASSWORD' });
    expect(http.browserInteractions.httpAuth).toEqual({
      credentialProfile: 'auth',
      origins: ['https://sso.example.com'],
      answerByBrowser: false,
    });
  });

  it('rejects unknown profiles, secrets in the file and unbounded retries', () => {
    expect(() =>
      parseConfig(`${base}browserInteractions:\n  httpAuth:\n    credentialProfile: nope\n`, {}, {}),
    ).toThrowError(/unknown profile "nope"/);
    expect(() =>
      parseConfig(`${base}credentials:\n  qa: { username: a, password: b }\n`, {}, {}),
    ).toThrowError(/credentials/);
    expect(() =>
      parseConfig(`${base}browserInteractions:\n  retry:\n    maxAttempts: 50\n`, {}, {}),
    ).toThrowError(/maxAttempts/);
    expect(() =>
      parseConfig(`${base}browserInteractions:\n  permissions:\n    grant: [everything]\n`, {}, {}),
    ).toThrowError(/grant/);
  });
});

describe('browser HTTP credentials (sign-in popups)', () => {
  const base = (yaml: string) =>
    parseConfig(`mission: { name: x }\ntarget: { baseUrl: "https://app.example.test" }\n${yaml}`, {}, {})
      .config;
  const env = { SSO_USER: 'qa-user', SSO_PASS: 'qa-pass' };
  const yaml = (origins: string) => `credentials:
  sso: { usernameEnv: SSO_USER, passwordEnv: SSO_PASS }
browserInteractions:
  httpAuth: { credentialProfile: sso, origins: ${origins}, answerByBrowser: true }
`;

  it('one declared origin and a profile: the browser answers, only for that origin, only on challenge', () => {
    const found = browserHttpCredentials(base(yaml('["https://sso.example.test"]')), env);
    expect(found?.origin).toBe('https://sso.example.test');
    expect(found?.options.httpCredentials).toMatchObject({
      origin: 'https://sso.example.test',
      send: 'unauthorized',
    });
  });

  it('not asked, no origin, several origins, missing variables or interactions disabled: nothing given to the browser', () => {
    expect(
      browserHttpCredentials(
        base(yaml('["https://sso.example.test"]').replace(', answerByBrowser: true', '')),
        env,
      ),
    ).toBeUndefined();
    expect(browserHttpCredentials(base(yaml('[]')), env)).toBeUndefined();
    expect(
      browserHttpCredentials(base(yaml('["https://a.example.test", "https://b.example.test"]')), env),
    ).toBeUndefined();
    expect(browserHttpCredentials(base(yaml('["https://sso.example.test"]')), {})).toBeUndefined();
    expect(
      browserHttpCredentials(base(`${yaml('["https://sso.example.test"]')}  enabled: false\n`), env),
    ).toBeUndefined();
  });
});
