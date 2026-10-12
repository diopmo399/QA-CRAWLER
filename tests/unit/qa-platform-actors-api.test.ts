import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { AuthorizationReport } from '../../src/actors/authorization-observer.js';
import {
  createAuthenticator,
  SessionAwareAuthenticator,
  type Authenticator,
} from '../../src/auth/authenticator.js';
import { AuthenticationSessionProvider, writeEmptySession } from '../../src/auth/session-provider.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowStepReport } from '../../src/model/flow-run.js';
import { parseOpenApi } from '../../src/oracles/api-contract.js';
import { analyzeActors } from '../../src/platform/actor-analysis.js';
import {
  buildApiAnalysis,
  buildApiTestModel,
  runApiTests,
  runtimeMismatches,
  observedRequests,
} from '../../src/platform/api-testing.js';
import { correlateUiAndApi } from '../../src/platform/ui-api-correlation.js';
import { flow, step } from '../fixtures/qa-platform-results.js';

/**
 * QA PLATFORM — phases 4 à 6 : sessions réutilisables (SESSION_NEW / REUSE / RECORD / EXPIRED),
 * connexion SSO configurée, profils et écart de comportement des acteurs, corrélation UI ↔ API,
 * tests d'API dérivés du contrat OpenAPI et leur oracle.
 */
const CONTRACT = parseOpenApi(
  JSON.stringify({
    openapi: '3.0.0',
    paths: {
      '/api/items': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
                },
              },
            },
          },
        },
        post: { responses: { '201': {} } },
      },
      '/api/items/{id}': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'label'],
                    properties: { id: { type: 'integer' }, label: { type: 'string' } },
                  },
                },
              },
            },
            '404': {},
          },
        },
      },
    },
  }),
  'contract.json',
);

const fakePage = (urls: string[]): Page & { saved: number } => {
  let current = urls[0] ?? '';
  const page = {
    saved: 0,
    goto: (url: string) => {
      current = urls.length > 1 ? (urls[1] ?? url) : url;
      return Promise.resolve(null);
    },
    url: () => current,
    context: () => ({
      storageState: ({ path: file }: { path: string }) =>
        writeFile(file, JSON.stringify({ cookies: [], origins: [] })).then(() => ({
          cookies: [],
          origins: [],
        })),
    }),
  };
  return page as unknown as Page & { saved: number };
};

describe('QA platform — reusable authentication sessions', () => {
  it('SESSION_NEW without a file, SESSION_RECORD after the login, SESSION_REUSE at the next run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-sessions-'));
    const file = path.join(dir, 'primary.json');
    const config = { reuse: true, file, maxAgeMinutes: 60 };
    const first = new AuthenticationSessionProvider(config, 'primary');
    expect(await first.contextOptions()).toEqual({});
    expect(first.report().status).toBe('SESSION_NEW');
    let logins = 0;
    const inner: Authenticator = {
      description: 'fake',
      contextOptions: () => ({}),
      login: () => {
        logins += 1;
        return Promise.resolve();
      },
    };
    const authenticator = new SessionAwareAuthenticator(
      inner,
      first,
      'http://app.test/',
      ['http://app.test/login'],
      1000,
    );
    await authenticator.login(fakePage(['http://app.test/']));
    expect(logins).toBe(1);
    expect(authenticator.sessionReport().status).toBe('SESSION_RECORD');

    const second = new AuthenticationSessionProvider(config, 'primary');
    expect(await second.contextOptions()).toEqual({ storageState: file });
    const reused = new SessionAwareAuthenticator(
      inner,
      second,
      'http://app.test/',
      ['http://app.test/login'],
      1000,
    );
    await reused.login(fakePage(['http://app.test/', 'http://app.test/home']));
    expect(logins).toBe(1);
    expect(reused.sessionReport().status).toBe('SESSION_REUSE');
  });

  it('a stored session the application rejects, or too old, is SESSION_EXPIRED: login again, then save', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-sessions-'));
    const file = path.join(dir, 'reader.json');
    await writeEmptySession(file);
    let logins = 0;
    const inner: Authenticator = {
      description: 'fake',
      contextOptions: () => ({}),
      login: () => {
        logins += 1;
        return Promise.resolve();
      },
    };
    const rejected = new AuthenticationSessionProvider({ reuse: true, file, maxAgeMinutes: 60 }, 'reader');
    await rejected.contextOptions();
    const authenticator = new SessionAwareAuthenticator(
      inner,
      rejected,
      'http://app.test/',
      ['http://app.test/login'],
      1000,
    );
    await authenticator.login(fakePage(['http://app.test/', 'http://app.test/login?next=/']));
    expect(logins).toBe(1);
    expect(authenticator.sessionReport()).toMatchObject({
      status: 'SESSION_EXPIRED',
      reason: expect.stringContaining('sign-in') as string,
    });

    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(file, old, old);
    const expired = new AuthenticationSessionProvider({ reuse: true, file, maxAgeMinutes: 60 }, 'reader');
    expect(await expired.contextOptions()).toEqual({});
    expect(expired.report()).toMatchObject({ status: 'SESSION_EXPIRED', ageMinutes: 180 });
    expect(expired.canReuse).toBe(false);
  });

  it('the report never carries the session content, only its file path', async () => {
    const provider = new AuthenticationSessionProvider({ reuse: true, maxAgeMinutes: 60 }, 'primary');
    expect(provider.file).toBe(path.join('.qa-crawler', 'sessions', 'primary.json'));
    expect(JSON.stringify(provider.report())).not.toContain('cookies');
    expect(await provider.contextOptions()).toEqual({});
  });

  it('auth.type sso and auth.session parse; the authenticator is session-aware; the actor profile is kept', () => {
    const { config } = parseConfig(
      `mission: { name: sso }
target: { baseUrl: http://app.test, startAt: / }
auth:
  type: sso
  identityProviderOrigin: https://login.example.test/realm
  usernameSelector: '#user'
  passwordSelector: '#pass'
  submitSelector: '#go'
  nextSelector: '#next'
  session: { reuse: true, maxAgeMinutes: 30 }
actors:
  - name: reader
    auth: { type: form, loginUrl: /login, usernameSelector: '#u', passwordSelector: '#p', submitSelector: '#s' }
    profile: { roles: [reader], permissions: [items.read], claims: [sub, roles], tenant: north }
apiTesting: { enabled: true, methods: [GET, HEAD] }
`,
      {},
      {},
    );
    expect(config.auth.type).toBe('sso');
    if (config.auth.type !== 'sso') throw new Error('unreachable');
    expect(config.auth.identityProviderOrigin).toBe('https://login.example.test');
    expect(config.auth.session).toEqual({ reuse: true, maxAgeMinutes: 30 });
    expect(config.actors[0]?.profile).toEqual({
      roles: ['reader'],
      permissions: ['items.read'],
      claims: ['sub', 'roles'],
      tenant: 'north',
    });
    expect(config.apiTesting).toMatchObject({ enabled: true, methods: ['GET', 'HEAD'], maxOperations: 50 });
    const authenticator = createAuthenticator(config.auth, 'http://app.test', {}, 'http://app.test/');
    expect(authenticator).toBeInstanceOf(SessionAwareAuthenticator);
    expect(authenticator.description).toContain('SSO login via https://login.example.test');
    expect(authenticator.description).not.toContain('QA_PASSWORD=');
  });
});

describe('QA platform — actor profiles and behaviour diff', () => {
  const report = (readerOnAdmin: 'ALLOWED' | 'DENIED'): AuthorizationReport => ({
    primaryActor: 'primary',
    actors: ['primary', 'reader'],
    profiles: { reader: { roles: ['reader'], permissions: [], claims: [] } },
    sessions: { reader: { status: 'SESSION_REUSE', file: 'x.json' } },
    observations: [
      { actor: 'primary', stateId: 'S1', label: 'Admin', url: 'http://app.test/admin', access: 'ALLOWED' },
      { actor: 'reader', stateId: 'S1', label: 'Admin', url: 'http://app.test/admin', access: readerOnAdmin },
      {
        actor: 'primary',
        stateId: 'S2',
        label: 'Reports',
        url: 'http://app.test/reports',
        access: 'ALLOWED',
      },
      { actor: 'reader', stateId: 'S2', label: 'Reports', url: 'http://app.test/reports', access: 'DENIED' },
    ],
    differences: [
      ...(readerOnAdmin === 'DENIED'
        ? [
            {
              stateId: 'S1',
              label: 'Admin',
              url: 'http://app.test/admin',
              access: { primary: 'ALLOWED' as const, reader: 'DENIED' as const },
              message: '',
            },
          ]
        : []),
      {
        stateId: 'S2',
        label: 'Reports',
        url: 'http://app.test/reports',
        access: { primary: 'ALLOWED', reader: 'DENIED' },
        message: '',
      },
    ],
    rules: [
      {
        actor: 'reader',
        path: '/admin*',
        expect: 'denied',
        status: readerOnAdmin === 'DENIED' ? 'PASS' : 'FAIL',
        checked: 1,
        violations: [],
      },
    ],
    errors: [],
  });

  it('differences are classified by the rules; profiles and sessions are carried per actor', () => {
    const analysis = analyzeActors(report('DENIED'), {}, 'run-2', '2026-10-11T10:00:00.000Z');
    expect(analysis.differences.map((entry) => entry.classification)).toEqual([
      'EXPECTED_BY_RULE',
      'UNEXPECTED',
    ]);
    expect(analysis.actors[1]).toMatchObject({
      name: 'reader',
      profile: { roles: ['reader'] },
      session: { status: 'SESSION_REUSE' },
      reached: 0,
      denied: 2,
    });
    expect(analysis.behaviorDiff).toEqual([]);
    expect(analysis.summary).toMatchObject({
      actors: 2,
      differences: 2,
      unexpectedDifferences: 1,
      rulesFailed: 0,
      possibleRegressions: 0,
    });
    expect(analysis.memory.reader?.['http://app.test/admin']).toMatchObject({
      access: 'DENIED',
      runId: 'run-2',
    });
  });

  it('an actor allowed before and denied now is a POSSIBLE_AUTHORIZATION_REGRESSION (historical, never certain)', () => {
    const previous = analyzeActors(report('ALLOWED'), {}, 'run-1', '2026-10-10T10:00:00.000Z').memory;
    const analysis = analyzeActors(report('DENIED'), previous, 'run-2', '2026-10-11T10:00:00.000Z');
    expect(analysis.behaviorDiff).toEqual([
      expect.objectContaining({
        actor: 'reader',
        label: 'Admin',
        previous: 'ALLOWED',
        current: 'DENIED',
        change: 'POSSIBLE_AUTHORIZATION_REGRESSION',
        previousRun: 'run-1',
      }),
    ]);
    const finding = analysis.findings.find((entry) =>
      entry.conclusion.startsWith('possible authorization regression'),
    );
    expect(finding).toMatchObject({ source: 'HISTORICAL', confidence: 0.6 });
    expect(analysis.summary.possibleRegressions).toBe(1);
  });
});

const network = (
  requests: { method: string; path: string; status?: number; failure?: string }[],
  writes = 0,
): FlowStepReport['network'] => ({
  requests: requests.map((request) => ({ ...request, resourceType: 'fetch' })),
  writes,
  errors: requests.filter((request) => request.failure !== undefined || (request.status ?? 0) >= 400).length,
});

describe('QA platform — UI ↔ API correlation', () => {
  it('each step gets a verdict: consistent, silent API error, UI failure on a healthy API, write without API', () => {
    const effect = (status: 'CONFIRMED' | 'NO_EFFECT') => ({
      execution: 'EXECUTED' as const,
      status,
      expected: [],
      observed: [],
      reasons: [],
      recovery: [],
    });
    const correlation = correlateUiAndApi([
      flow('f', [
        step(1, 'click Save', {
          classification: 'MUTATION',
          effect: effect('CONFIRMED'),
          network: network([{ method: 'POST', path: '/api/items', status: 201 }], 1),
        }),
        step(2, 'click Publish', {
          classification: 'MUTATION',
          effect: effect('CONFIRMED'),
          network: network([{ method: 'POST', path: '/api/items/7/publish', status: 500 }], 1),
        }),
        step(3, 'click Open', {
          status: 'FAILED',
          reason: 'not found',
          network: network([{ method: 'GET', path: '/api/items/7', status: 200 }]),
        }),
        step(4, 'click Archive', { classification: 'MUTATION', effect: effect('CONFIRMED') }),
        step(5, 'click Tabs', { effect: effect('CONFIRMED') }),
      ]),
    ]);
    expect(correlation.entries.map((entry) => entry.verdict)).toEqual([
      'CONSISTENT',
      'UI_SUCCESS_API_ERROR',
      'UI_FAILURE_API_SUCCESS',
      'WRITE_WITHOUT_API',
    ]);
    expect(correlation.summary).toMatchObject({ steps: 4, CONSISTENT: 1, UI_SUCCESS_API_ERROR: 1 });
    expect(correlation.findings[0]).toMatchObject({
      conclusion: expect.stringContaining('UI_SUCCESS_API_ERROR') as string,
      confidence: 0.9,
      source: 'RUNTIME',
    });
  });

  it('with a contract: undocumented response, UI success on an undeclared error, undocumented endpoint', () => {
    const correlation = correlateUiAndApi(
      [
        flow('f', [
          step(1, 'click Save', {
            effect: {
              execution: 'EXECUTED',
              status: 'CONFIRMED',
              expected: [],
              observed: [],
              reasons: [],
              recovery: [],
            },
            network: network(
              [
                { method: 'POST', path: '/api/items', status: 422 },
                { method: 'GET', path: '/api/legacy/items', status: 200 },
              ],
              1,
            ),
          }),
        ]),
      ],
      CONTRACT,
    );
    expect(correlation.entries[0]?.contractIssues.map((issue) => issue.kind)).toEqual([
      'UNDOCUMENTED_RESPONSE',
      'CONTRACT_UI_MISMATCH',
      'UNDOCUMENTED_ENDPOINT',
    ]);
    expect(correlation.entries[0]?.verdict).toBe('UI_SUCCESS_API_REJECTED');
    expect(correlation.findings.filter((finding) => finding.source === 'CONTRACT')).toHaveLength(3);
  });
});

describe('QA platform — OpenAPI API testing', () => {
  const flows = [
    flow('f', [
      step(1, 'click Items', {
        network: network([
          { method: 'GET', path: '/api/items/42', status: 200 },
          { method: 'GET', path: '/api/other', status: 418 },
        ]),
      }),
      step(2, 'click Save', { network: network([{ method: 'POST', path: '/api/items', status: 200 }], 1) }),
    ]),
  ];

  it('the test model keeps safe methods only and takes path parameters from the run', () => {
    const model = buildApiTestModel(CONTRACT, observedRequests(flows), {
      methods: ['GET'],
      maxOperations: 50,
    });
    expect(model.tests.map((test) => `${test.method} ${test.path} (${test.source})`)).toEqual([
      'GET /api/items (LITERAL_PATH)',
      'GET /api/items/42 (OBSERVED_PATH)',
    ]);
    expect(model.untested).toEqual([
      {
        operation: 'POST /api/items',
        reason: expect.stringContaining('writes are never generated') as string,
      },
    ]);
    const noValues = buildApiTestModel(CONTRACT, [], { methods: ['GET'], maxOperations: 1 });
    expect(noValues.untested.map((entry) => entry.reason)).toEqual([
      expect.stringContaining('writes'),
      expect.stringContaining('maxOperations'),
    ]);
  });

  it('the oracle: PASS, UNEXPECTED_STATUS, SCHEMA_DRIFT, API_FAILURE, ERROR — and the runtime mismatches of the run', async () => {
    const model = buildApiTestModel(CONTRACT, observedRequests(flows), {
      methods: ['GET'],
      maxOperations: 50,
    });
    const responses: Record<string, { status: number; body?: unknown; failure?: string }> = {
      '/api/items': { status: 200, body: { items: [] } },
      '/api/items/42': { status: 200, body: { id: '42' } },
    };
    const results = await runApiTests(model, CONTRACT, (_method, requestPath) => {
      const response = responses[requestPath];
      return Promise.resolve(
        response ? { ...response, contentType: 'application/json' } : { status: 0, failure: 'no route' },
      );
    });
    expect(results.map((result) => result.verdict)).toEqual(['PASS', 'SCHEMA_DRIFT']);
    expect(results[1]?.reasons).toEqual([
      'required field "label" is missing',
      'field "id" is string, the contract says integer',
    ]);
    const failing = await runApiTests(model, CONTRACT, (_method, requestPath) =>
      requestPath === '/api/items'
        ? Promise.resolve({ status: 503 })
        : Promise.reject(new Error('socket hang up')),
    );
    expect(failing.map((result) => result.verdict)).toEqual(['API_FAILURE', 'ERROR']);
    const unexpected = await runApiTests(model, CONTRACT, () => Promise.resolve({ status: 204 }));
    expect(unexpected[0]).toMatchObject({ verdict: 'UNEXPECTED_STATUS', status: 204 });

    const mismatches = runtimeMismatches(CONTRACT, observedRequests(flows));
    expect(mismatches.map((entry) => `${entry.kind} ${entry.request}`)).toEqual([
      'UNDOCUMENTED_ENDPOINT GET /api/other → 418',
      'CONTRACT_RUNTIME_MISMATCH POST /api/items → 200',
    ]);
    const analysis = buildApiAnalysis(correlateUiAndApi(flows, CONTRACT), {
      contract: CONTRACT,
      model,
      results,
      observed: observedRequests(flows),
    });
    expect(analysis.contract?.summary).toMatchObject({ PASS: 1, SCHEMA_DRIFT: 1 });
    expect(analysis.findings.some((finding) => finding.conclusion.startsWith('SCHEMA_DRIFT'))).toBe(true);
    expect(analysis.findings.some((finding) => finding.conclusion.startsWith('UNDOCUMENTED_ENDPOINT'))).toBe(
      true,
    );
  });
});
