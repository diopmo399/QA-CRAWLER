import { describe, expect, it } from 'vitest';
import { assertionSchema, type AssertionConfig } from '../../src/config/quality-schema.js';
import { identifiersOf, recordsOf, valueDigestsOf } from '../../src/forms/state/form-knowledge-observer.js';
import type { FlowStatus } from '../../src/model/flow-run.js';
import { parseOpenApi } from '../../src/oracles/api-contract.js';
import {
  BusinessAssertionEngine,
  type ApiReadResult,
  type VerificationContext,
} from '../../src/quality/assertion-engine.js';
import { verdictOf } from '../../src/quality/model.js';
import type { ObservedExchange } from '../../src/quality/values.js';

/**
 * LE MOTEUR D'ASSERTIONS MÉTIER : un clic réussi n'est pas un résultat métier. Chaque assertion est
 * jugée sur des preuves (réseau en empreintes, écran, lecture d'API), avec les valeurs DU RUN.
 */
const SALT = 'unit-salt';
const RUN_TITLE = 'QA-run42 Printer request';

/** Un échange comme l'observateur le garde : des empreintes salées, jamais les valeurs. */
function write(path: string, status: number, sent: unknown, returned?: unknown, step = 3): ObservedExchange {
  return {
    method: 'POST',
    path,
    status,
    step,
    requestCriteria: valueDigestsOf(sent, SALT, 30),
    ...(returned !== undefined
      ? { identifiers: identifiersOf(returned, SALT), responseValues: valueDigestsOf(returned, SALT, 40) }
      : {}),
    ...(returned && typeof returned === 'object' && 'status' in returned
      ? { responseState: { field: 'status', code: (returned as { status: string }).status } }
      : {}),
  };
}

function read(path: string, body: unknown, step = 4): ObservedExchange {
  return {
    method: 'GET',
    path,
    status: 200,
    step,
    records: recordsOf(body, SALT),
    listSize: Array.isArray(body) ? body.length : undefined,
  };
}

interface Fake {
  exchanges?: ObservedExchange[];
  networkObserved?: boolean;
  values?: Record<string, string>;
  steps?: Record<number, FlowStatus>;
  ui?: string;
  api?: (url: string, call: number) => ApiReadResult;
  contract?: VerificationContext['contract'];
}

function context(fake: Fake): VerificationContext & { calls: string[] } {
  let clock = 1_000;
  let call = 0;
  const calls: string[] = [];
  return {
    runId: 'run-1',
    flow: 'Create request',
    salt: SALT,
    networkObserved: fake.networkObserved ?? true,
    exchanges: () => fake.exchanges ?? [],
    runValue: (key) => {
      const value = (fake.values ?? { title: RUN_TITLE })[key];
      return value === undefined ? undefined : { value, displayable: true };
    },
    stepStatus: (index) => fake.steps?.[index] ?? 'PASSED',
    ...(fake.ui !== undefined ? { uiText: () => Promise.resolve(fake.ui) } : {}),
    ...(fake.api
      ? {
          apiGet: (url: string) => {
            call += 1;
            calls.push(url);
            return Promise.resolve((fake.api as NonNullable<Fake['api']>)(url, call));
          },
        }
      : {}),
    ...(fake.contract ? { contract: fake.contract } : {}),
    showValues: false,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    calls,
  };
}

const assertion = (input: Record<string, unknown>): AssertionConfig =>
  assertionSchema.parse({ id: 'A', description: 'business result', ...input });

describe('business assertions: a clicked button is not a business result', () => {
  it('1 · a valid creation passes when the evidence confirms it (accepted write, stored value, entity found)', async () => {
    const engine = new BusinessAssertionEngine(
      context({
        exchanges: [
          write(
            '/api/requests',
            201,
            { title: RUN_TITLE },
            { id: 'R-1001', title: RUN_TITLE, status: 'NEW' },
          ),
          read('/api/requests', [{ id: 'R-1001', title: RUN_TITLE, status: 'NEW' }]),
        ],
      }),
    );
    const created = await engine.evaluate(
      assertion({
        id: 'CREATED',
        check: {
          kind: 'request',
          method: 'POST',
          path: '/api/requests',
          status: 201,
          requireIdentifier: true,
          extract: { name: 'requestId', field: 'id' },
        },
      }),
    );
    const stored = await engine.evaluate(
      assertion({
        id: 'STORED',
        check: {
          kind: 'value',
          source: 'response',
          path: '/api/requests',
          field: 'title',
          expected: { testData: 'title' },
        },
      }),
    );
    const found = await engine.evaluate(
      assertion({
        id: 'FOUND',
        check: {
          kind: 'entity',
          source: 'network',
          by: { extracted: 'requestId' },
          field: 'id',
          unique: true,
        },
      }),
    );
    const state = await engine.evaluate(
      assertion({
        id: 'STATE',
        check: { kind: 'state', source: 'response', method: 'POST', path: '/api/requests', expected: 'NEW' },
      }),
    );
    expect([created.status, stored.status, found.status, state.status]).toEqual([
      'PASS',
      'PASS',
      'PASS',
      'PASS',
    ]);
    expect(created.observed).toContain('R-1001');
    expect(engine.allEvidence.every((item) => item.runId === 'run-1' && item.assertionId)).toBe(true);
    expect(verdictOf(engine.allResults)).toBe('PASS');
  });

  it('2 · a successful click without any business result does not pass (no write reached the server)', async () => {
    const engine = new BusinessAssertionEngine(context({ exchanges: [read('/api/requests', [])] }));
    const result = await engine.evaluate(
      assertion({ check: { kind: 'request', method: 'POST', path: '/api/requests' } }),
    );
    expect(result.status).toBe('FAIL');
    expect(result.reasons[0]).toMatch(/did not reach the server/);
  });

  it('3 · a positive HTTP answer with wrong business data fails', async () => {
    const engine = new BusinessAssertionEngine(
      context({
        exchanges: [
          write('/api/requests', 201, { title: RUN_TITLE }, { id: 'R-1001', title: 'Something else' }),
        ],
      }),
    );
    const accepted = await engine.evaluate(
      assertion({ id: 'OK', check: { kind: 'request', method: 'POST', path: '/api/requests' } }),
    );
    const stored = await engine.evaluate(
      assertion({
        id: 'VALUE',
        check: {
          kind: 'value',
          source: 'response',
          path: '/api/requests',
          field: 'title',
          expected: { testData: 'title' },
        },
      }),
    );
    expect(accepted.status).toBe('PASS');
    expect(stored.status).toBe('FAIL');
    expect(stored.observed).toMatch(/title carries another value/);
    expect(verdictOf(engine.allResults)).toBe('FAIL');
  });

  it('4 · an entity found with the wrong name fails (read-only API verification)', async () => {
    const ctx = context({
      exchanges: [write('/api/requests', 201, { title: RUN_TITLE }, { id: 'R-1001' })],
      api: () => ({ status: 200, body: { id: 'R-1001', title: 'Printer request (old)' } }),
    });
    const engine = new BusinessAssertionEngine(ctx);
    await engine.evaluate(
      assertion({
        id: 'CREATED',
        check: { kind: 'request', path: '/api/requests', extract: { name: 'requestId' } },
      }),
    );
    const result = await engine.evaluate(
      assertion({
        id: 'NAME',
        check: {
          kind: 'value',
          source: 'api',
          field: 'title',
          expected: { testData: 'title' },
          api: { url: 'http://app.test/api/requests/${extracted:requestId}' },
        },
      }),
    );
    expect(ctx.calls).toEqual(['http://app.test/api/requests/R-1001']);
    expect(result.status).toBe('FAIL');
    expect(result.observed).toBe('title has another value: (value not shown)');
  });

  it('5 · an asynchronous result still pending is never declared passed too early, and passes once observed', async () => {
    const pending = (url: string, call: number): ApiReadResult => ({
      status: 200,
      body: { id: 'R-1', status: call < 4 ? 'PROCESSING' : 'APPROVED' },
    });
    const check = {
      kind: 'state',
      source: 'api',
      expected: 'APPROVED',
      pending: ['PROCESSING'],
      api: { url: 'http://app.test/api/requests/R-1' },
    };
    const short = await new BusinessAssertionEngine(context({ api: pending })).evaluate(
      assertion({ timeoutMs: 1000, pollMs: 500, check }),
    );
    expect(short.status).toBe('INCONCLUSIVE');
    expect(short.reasons[0]).toMatch(/still PROCESSING/);
    const long = await new BusinessAssertionEngine(context({ api: pending })).evaluate(
      assertion({ timeoutMs: 5000, pollMs: 500, check }),
    );
    expect(long.status).toBe('PASS');
    expect(long.attempts).toBe(4);
  });

  it('6 · without a verification source the result is explicit, never a false success', async () => {
    const engine = new BusinessAssertionEngine(context({ networkObserved: false }));
    const network = await engine.evaluate(
      assertion({ id: 'N', check: { kind: 'request', path: '/api/requests' } }),
    );
    const api = await engine.evaluate(
      assertion({
        id: 'P',
        check: {
          kind: 'entity',
          source: 'api',
          by: { testData: 'title' },
          api: { url: 'http://app.test/api/requests' },
        },
      }),
    );
    const contract = await engine.evaluate(
      assertion({ id: 'C', check: { kind: 'contract', path: '/api/requests' } }),
    );
    expect([network.status, api.status, contract.status]).toEqual([
      'UNVERIFIABLE',
      'UNVERIFIABLE',
      'UNVERIFIABLE',
    ]);
    expect(verdictOf(engine.allResults)).toBe('UNVERIFIABLE');
  });

  it('7 · the dynamic value of the run is compared, never the recorded literal', async () => {
    const recorded = 'Printer request';
    const sentRecorded = new BusinessAssertionEngine(
      context({
        exchanges: [write('/api/requests', 201, { title: recorded }, { id: 'R-2', title: recorded })],
      }),
    );
    const check = {
      kind: 'value',
      source: 'request',
      path: '/api/requests',
      field: 'title',
      expected: { testData: 'title' },
    };
    expect((await sentRecorded.evaluate(assertion({ check }))).status).toBe('FAIL');
    const sentRun = new BusinessAssertionEngine(
      context({
        exchanges: [write('/api/requests', 201, { title: RUN_TITLE }, { id: 'R-2', title: RUN_TITLE })],
      }),
    );
    expect((await sentRun.evaluate(assertion({ check }))).status).toBe('PASS');
    // Une donnée de test sans valeur dans ce run (son étape n'a pas eu lieu) : BLOCKED, jamais une valeur inventée.
    const missing = new BusinessAssertionEngine(context({ values: {} }));
    expect((await missing.evaluate(assertion({ check }))).status).toBe('BLOCKED');
  });
});

describe('business assertions: preconditions, evidence, side effects, contract, relations', () => {
  it('a step that did not pass blocks the assertions verified after it; a failed precondition blocks its dependents', async () => {
    const engine = new BusinessAssertionEngine(context({ steps: { 3: 'FAILED' }, exchanges: [] }));
    const after = await engine.evaluate(
      assertion({ id: 'AFTER', after: 3, check: { kind: 'request', path: '/api/requests' } }),
    );
    const first = await engine.evaluate(
      assertion({ id: 'FIRST', check: { kind: 'request', path: '/api/requests' } }),
    );
    const dependent = await engine.evaluate(
      assertion({ id: 'DEP', requires: ['FIRST'], check: { kind: 'request', path: '/api/other' } }),
    );
    expect(after.status).toBe('BLOCKED');
    expect(first.status).toBe('FAIL');
    expect(dependent.status).toBe('BLOCKED');
    expect(dependent.reasons[0]).toBe('precondition FIRST is FAIL');
  });

  it('a success without the required evidence is INCONCLUSIVE', async () => {
    const engine = new BusinessAssertionEngine(context({ ui: `Request ${RUN_TITLE} created` }));
    const result = await engine.evaluate(
      assertion({ evidence: ['API'], check: { kind: 'entity', source: 'ui', by: { testData: 'title' } } }),
    );
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.reasons.at(-1)).toBe('required evidence missing: API');
  });

  it('an extra write or a second creation is a forbidden side effect', async () => {
    const engine = new BusinessAssertionEngine(
      context({
        exchanges: [
          write('/api/requests', 201, { title: RUN_TITLE }, { id: 'R-1' }),
          write('/api/requests', 201, { title: RUN_TITLE }, { id: 'R-2' }),
          { method: 'DELETE', path: '/api/drafts/7', status: 204 },
        ],
      }),
    );
    const result = await engine.evaluate(
      assertion({
        check: {
          kind: 'sideEffects',
          allowedWrites: [{ method: 'POST', path: '/api/requests' }],
          maxCreated: 1,
        },
      }),
    );
    expect(result.status).toBe('FAIL');
    expect(result.reasons).toEqual([
      'unexpected write(s): DELETE /api/drafts/7 → 204',
      '2 creation(s) for at most 1',
    ]);
  });

  it('the contract: an undocumented response fails, a declared one passes', async () => {
    const contract = parseOpenApi(
      JSON.stringify({
        openapi: '3.0.0',
        paths: { '/api/requests': { post: { responses: { '201': { description: 'created' } } } } },
      }),
    ).operations;
    const ok = new BusinessAssertionEngine(
      context({ contract, exchanges: [write('/api/requests', 201, {}, { id: 'R-1' })] }),
    );
    expect(
      (await ok.evaluate(assertion({ check: { kind: 'contract', method: 'POST', path: '/api/requests' } })))
        .status,
    ).toBe('PASS');
    const ko = new BusinessAssertionEngine(
      context({ contract, exchanges: [write('/api/requests', 409, {}, { code: 'DUPLICATE' })] }),
    );
    expect(
      (await ko.evaluate(assertion({ check: { kind: 'contract', method: 'POST', path: '/api/requests' } })))
        .status,
    ).toBe('FAIL');
  });

  it('a forbidden transition accepted by the server fails; not exercised stays INCONCLUSIVE', async () => {
    const exchanges: ObservedExchange[] = [
      {
        method: 'GET',
        path: '/api/requests/1',
        status: 200,
        responseState: { field: 'status', code: 'CLOSED' },
      },
      {
        method: 'PATCH',
        path: '/api/requests/1',
        status: 200,
        requestState: { field: 'status', code: 'NEW' },
      },
    ];
    const engine = new BusinessAssertionEngine(context({ exchanges }));
    const forbidden = await engine.evaluate(
      assertion({ id: 'T', check: { kind: 'transition', from: 'CLOSED', to: 'NEW', expect: 'forbidden' } }),
    );
    const other = await engine.evaluate(
      assertion({ id: 'U', check: { kind: 'transition', from: 'NEW', to: 'APPROVED', expect: 'allowed' } }),
    );
    expect(forbidden.status).toBe('FAIL');
    expect(other.status).toBe('INCONCLUSIVE');
  });

  it('a relation pointing to the wrong entity fails; an ambiguous entity is INCONCLUSIVE', async () => {
    const clients = { values: { title: RUN_TITLE, client: 'C-7' } };
    const wrong = new BusinessAssertionEngine(
      context({
        ...clients,
        exchanges: [read('/api/requests', [{ id: 'R-1', title: RUN_TITLE, clientId: 'C-9' }])],
      }),
    );
    const check = {
      kind: 'relation',
      source: 'network',
      entity: { field: 'title', value: { testData: 'title' } },
      field: 'clientId',
      expected: { testData: 'client' },
    };
    expect((await wrong.evaluate(assertion({ check }))).status).toBe('FAIL');
    const right = new BusinessAssertionEngine(
      context({
        ...clients,
        exchanges: [read('/api/requests', [{ id: 'R-1', title: RUN_TITLE, clientId: 'C-7' }])],
      }),
    );
    expect((await right.evaluate(assertion({ check }))).status).toBe('PASS');
    const twice = new BusinessAssertionEngine(
      context({
        ...clients,
        exchanges: [
          read('/api/requests', [
            { id: 'R-1', title: RUN_TITLE, clientId: 'C-7' },
            { id: 'R-2', title: RUN_TITLE, clientId: 'C-9' },
          ]),
        ],
      }),
    );
    expect((await twice.evaluate(assertion({ check }))).status).toBe('INCONCLUSIVE');
  });

  it('cardinality catches a duplicate creation; the schema refuses a cardinality without bounds', async () => {
    const engine = new BusinessAssertionEngine(
      context({
        exchanges: [
          read('/api/requests', [
            { id: 'R-1', title: RUN_TITLE },
            { id: 'R-2', title: RUN_TITLE },
          ]),
        ],
      }),
    );
    const result = await engine.evaluate(
      assertion({
        check: {
          kind: 'cardinality',
          source: 'network',
          matching: { field: 'title', value: { testData: 'title' } },
          equals: 1,
        },
      }),
    );
    expect(result.status).toBe('FAIL');
    expect(result.observed).toBe('2 record(s)');
    expect(() =>
      assertion({ check: { kind: 'cardinality', source: 'network', matching: { value: { value: 'x' } } } }),
    ).toThrow(/equals, min or max/);
  });

  it('an unreadable response body (the page navigated) is INCONCLUSIVE, never a missing identifier', async () => {
    const unread: ObservedExchange = {
      method: 'POST',
      path: '/api/requests',
      status: 201,
      step: 3,
      requestCriteria: valueDigestsOf({ title: RUN_TITLE }, SALT, 30),
      responseUnread: true,
    };
    const engine = new BusinessAssertionEngine(context({ exchanges: [unread] }));
    const created = await engine.evaluate(
      assertion({
        id: 'CREATED',
        check: {
          kind: 'request',
          method: 'POST',
          path: '/api/requests',
          status: 201,
          requireIdentifier: true,
        },
      }),
    );
    expect(created.status).toBe('INCONCLUSIVE');
    expect(created.reasons[0]).toContain('could not be read');
    const stored = await engine.evaluate(
      assertion({
        id: 'STORED',
        check: {
          kind: 'value',
          source: 'response',
          path: '/api/requests',
          field: 'title',
          expected: { testData: 'title' },
        },
      }),
    );
    expect(stored.status).toBe('INCONCLUSIVE');
    expect(stored.reasons[0]).toContain('could not be read');
  });

  it('a read API that refuses the session is UNVERIFIABLE; a 404 means the entity is not found', async () => {
    const refused = new BusinessAssertionEngine(context({ api: () => ({ status: 403, body: {} }) }));
    const check = {
      kind: 'entity',
      source: 'api',
      by: { testData: 'title' },
      api: { url: 'http://app.test/api/requests' },
    };
    expect((await refused.evaluate(assertion({ check }))).status).toBe('UNVERIFIABLE');
    const gone = new BusinessAssertionEngine(context({ api: () => ({ status: 404, body: {} }) }));
    expect((await gone.evaluate(assertion({ check }))).status).toBe('FAIL');
  });
});
