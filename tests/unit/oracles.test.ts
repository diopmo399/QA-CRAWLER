import { describe, expect, it } from 'vitest';
import { enrichWithContract } from '../../src/forms/contract-enrichment.js';
import type { DiscoveredForm, FormField } from '../../src/forms/form-model.js';
import type { FlowGraphData } from '../../src/model/flow.js';
import type { Issue } from '../../src/model/issue.js';
import type { NetworkExchange } from '../../src/model/network.js';
import type { PageContext } from '../../src/model/page-context.js';
import { declares, parseOpenApi } from '../../src/oracles/api-contract.js';
import { BaselineOracle } from '../../src/oracles/baseline-oracle.js';
import { CompositeTestOracle } from '../../src/oracles/composite-oracle.js';
import { ContractOracle } from '../../src/oracles/contract-oracle.js';
import type { ActionObservations, ExecutedAction, TestOracle } from '../../src/oracles/oracle.js';
import { TechnicalOracle } from '../../src/oracles/technical-oracle.js';
import { UIOracle } from '../../src/oracles/ui-oracle.js';

const page = (stateId: string, stateLabel = stateId): PageContext => ({
  url: `http://app.test/${stateId}`,
  title: stateLabel,
  stateId,
  stateLabel,
  route: `/${stateId}`,
  headings: [stateLabel],
  dialogs: [],
  actions: [],
  forms: [],
  errors: [],
  metadata: { depth: 0, timestamp: '2026-01-01T00:00:00.000Z', flow: [] },
});

const action = (overrides: Partial<ExecutedAction> = {}): ExecutedAction => ({
  id: 'a1',
  type: 'click',
  category: 'navigation',
  classification: 'SAFE',
  text: 'Users',
  href: 'http://app.test/users',
  result: 'SUCCESS',
  ...overrides,
});

const signals = { alerts: [], busy: false, empty: false, invalidFields: 0 };
const observed = (overrides: Partial<ActionObservations> = {}): ActionObservations => ({
  issues: [],
  network: [],
  pageCrashed: false,
  before: signals,
  after: signals,
  ...overrides,
});

const call = (method: string, url: string, status?: number, resourceType = 'fetch'): NetworkExchange => ({
  method,
  url,
  resourceType,
  ...(status !== undefined ? { status } : {}),
});

const issue = (type: Issue['type'], message: string, severity: Issue['severity'] = 'ERROR'): Issue => ({
  id: 'i1',
  type,
  severity,
  message,
  pageUrl: 'http://app.test/',
  pages: [],
  states: [],
  timestamp: '2026-01-01T00:00:00.000Z',
  occurrences: 1,
});

const OPENAPI = `
openapi: 3.0.0
servers:
  - url: http://app.test/api
paths:
  /users:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/NewUser'
      responses:
        '201': {}
        '4XX': {}
  /users/{id}:
    get:
      responses:
        '200': {}
components:
  schemas:
    NewUser:
      type: object
      required: [email]
      properties:
        email: { type: string, format: email, maxLength: 80 }
        role: { type: string, enum: [admin, reader] }
        age: { type: integer, minimum: 18, maximum: 99 }
`;

describe('TechnicalOracle', () => {
  const oracle = new TechnicalOracle();

  it('passes a clean action', async () => {
    const verdict = await oracle.evaluate(page('a'), action(), page('b'), observed());
    expect(verdict.status).toBe('PASS');
  });

  it('fails on HTTP 5xx, crash, uncaught exception or impossible action', async () => {
    const http = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ network: [call('POST', 'http://app.test/api/users?x=1', 500)] }),
    );
    expect(http.status).toBe('FAIL');
    expect(http.reasons[0]?.message).toBe('POST /api/users returned HTTP 500');

    const crash = await oracle.evaluate(page('a'), action(), undefined, observed({ pageCrashed: true }));
    expect(crash.reasons.map((reason) => reason.code)).toContain('page-crash');

    const exception = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ issues: [issue('PAGE_ERROR', 'TypeError: x is undefined')] }),
    );
    expect(exception.status).toBe('FAIL');

    const impossible = await oracle.evaluate(
      page('a'),
      action({ result: 'FAILED', error: 'intercepted' }),
      undefined,
      observed(),
    );
    expect(impossible.reasons[0]?.code).toBe('action-impossible');
  });

  it('warns on API 404 (or fails when configured) and on console errors with low confidence', async () => {
    const notFound = observed({ network: [call('GET', 'http://app.test/api/missing', 404)] });
    expect((await oracle.evaluate(page('a'), action(), page('b'), notFound)).status).toBe('WARNING');
    const strict = new TechnicalOracle({ api404: 'fail' });
    expect((await strict.evaluate(page('a'), action(), page('b'), notFound)).status).toBe('FAIL');

    // Un 404 sur un document est un lien cassé pour le collecteur, pas un échec d'API.
    const document = observed({ network: [call('GET', 'http://app.test/old', 404, 'document')] });
    expect((await oracle.evaluate(page('a'), action(), page('b'), document)).status).toBe('PASS');

    const console = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ issues: [issue('CONSOLE', 'something logged')] }),
    );
    expect(console.status).toBe('WARNING');
    expect(console.confidence).toBeLessThan(0.5);
  });
});

describe('UIOracle', () => {
  const oracle = new UIOracle();

  it('is UNKNOWN without the screen after the action', async () => {
    const verdict = await oracle.evaluate(page('a'), action(), undefined, observed());
    expect(verdict.status).toBe('UNKNOWN');
  });

  it('warns on a new error message, not on one already shown', async () => {
    const fresh = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ after: { ...signals, alerts: ['Une erreur est survenue'] } }),
    );
    expect(fresh.status).toBe('WARNING');
    expect(fresh.reasons[0]?.code).toBe('error-message');

    const old = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({
        before: { ...signals, alerts: ['Error: quota'] },
        after: { ...signals, alerts: ['Error: quota'] },
      }),
    );
    expect(old.status).toBe('PASS');
    expect(old.confidence).toBeLessThanOrEqual(0.5);
  });

  it('warns when a form sent with valid data stays invalid, on an empty screen and on a spinner', async () => {
    const invalid = await oracle.evaluate(
      page('a'),
      action({ submitsForm: true }),
      page('a'),
      observed({ formFilledWithValidData: true, after: { ...signals, invalidFields: 2 } }),
    );
    expect(invalid.reasons.map((reason) => reason.code)).toEqual(['form-still-invalid']);

    const empty = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ after: { ...signals, empty: true, busy: true } }),
    );
    expect(empty.reasons.map((reason) => reason.code)).toEqual(['empty-screen', 'still-loading']);
  });
});

describe('BaselineOracle', () => {
  const baseline = {
    version: 1,
    nodes: [
      { id: 'home', label: 'Home' },
      { id: 'users', label: 'Users' },
    ],
    edges: [
      {
        from: 'home',
        to: 'users',
        actionId: 'x',
        action: {
          type: 'click',
          category: 'navigation',
          text: 'Users',
          href: 'http://old-host.test/users',
          classification: 'SAFE',
        },
        result: 'SUCCESS',
        timestamp: '',
        issueIds: [],
      },
    ],
  } as unknown as FlowGraphData;
  const oracle = new BaselineOracle(baseline);

  it('passes when the same action reaches the same state', async () => {
    const verdict = await oracle.evaluate(page('home'), action(), page('users'), observed());
    expect(verdict.status).toBe('PASS');
  });

  it('flags a regression potential (WARNING, never FAIL) when the target differs or the action fails', async () => {
    const differs = await oracle.evaluate(page('home'), action(), page('error', 'Error'), observed());
    expect(differs.status).toBe('WARNING');
    expect(differs.reasons[0]?.message).toBe(
      'resulting state differs from baseline: expected Users, observed Error',
    );
    const fails = await oracle.evaluate(page('home'), action({ result: 'FAILED' }), undefined, observed());
    expect(fails.status).toBe('WARNING');
  });

  it('is UNKNOWN for a transition the baseline does not know, or without baseline', async () => {
    const unknown = await oracle.evaluate(page('home'), action({ text: 'Settings' }), page('s'), observed());
    expect(unknown.status).toBe('UNKNOWN');
    const none = await new BaselineOracle(undefined).evaluate(
      page('home'),
      action(),
      page('users'),
      observed(),
    );
    expect(none.status).toBe('UNKNOWN');
  });
});

describe('OpenAPI contract', () => {
  const contract = parseOpenApi(OPENAPI, 'test.yaml');

  it('parses operations, server base paths, declared statuses and request fields', () => {
    const create = contract.operations.find((operation) => operation.method === 'POST');
    expect(create?.path).toBe('/users');
    expect(create?.matcher.test('/api/users')).toBe(true);
    expect(create?.matcher.test('/users')).toBe(true);
    expect(create?.requestFields.email).toEqual({
      type: 'string',
      format: 'email',
      maxLength: 80,
      required: true,
    });
    const read = contract.operations.find((operation) => operation.method === 'GET');
    expect(read?.matcher.test('/api/users/42')).toBe(true);
    expect(read?.matcher.test('/api/users/42/roles')).toBe(false);
    expect(declares(['201', '4XX'], 422)).toBe(true);
    expect(declares(['201', '4XX'], 500)).toBe(false);
    expect(declares(['default'], 500)).toBe(true);
    expect(() => parseOpenApi('hello: world')).toThrow(/not an OpenAPI document/);
  });

  it('ContractOracle: PASS when declared, WARNING when not, UNKNOWN when nothing is described', async () => {
    const oracle = new ContractOracle(contract);
    const ok = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ network: [call('POST', 'http://app.test/api/users', 201)] }),
    );
    expect(ok.status).toBe('PASS');
    const violation = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ network: [call('GET', 'http://app.test/api/users/7', 500)] }),
    );
    expect(violation.status).toBe('WARNING');
    expect(violation.reasons[0]?.message).toContain('GET /api/users/7 → 500, expected one of 200');
    const other = await oracle.evaluate(
      page('a'),
      action(),
      page('b'),
      observed({ network: [call('GET', 'http://app.test/api/other', 200)] }),
    );
    expect(other.status).toBe('UNKNOWN');
    const none = await new ContractOracle(undefined).evaluate(page('a'), action(), page('b'), observed());
    expect(none.status).toBe('UNKNOWN');
  });

  it('enriches form fields where the DOM says nothing, never overriding it nor touching sensitive fields', () => {
    const field = (overrides: Partial<FormField>): FormField => ({
      id: 'f',
      type: 'text',
      required: false,
      disabled: false,
      readonly: false,
      hasValue: false,
      sensitive: false,
      payment: false,
      locator: { strategy: 'css', value: 'input' },
      ...overrides,
    });
    const form: DiscoveredForm = {
      id: 's:page',
      stateId: 's',
      group: 'page',
      name: 'Create user',
      fields: [
        field({ id: 'email', label: 'Email' }),
        field({ id: 'age', name: 'age', type: 'number', max: 50 }),
        field({ id: 'role', label: 'Role', type: 'select' }),
        field({ id: 'secret', label: 'Email', sensitive: true }),
      ],
      submitActions: [],
      validationMessages: [],
      foreground: false,
    };
    const [email, age, role, secret] = enrichWithContract(form, contract).fields;
    expect(email).toMatchObject({ type: 'email', maxLength: 80, required: true });
    expect(age).toMatchObject({ min: 18, max: 50 });
    expect(role?.options?.map((option) => option.label)).toEqual(['admin', 'reader']);
    expect(secret).toEqual(form.fields[3]);
    expect(Object.values(email ?? {})).not.toContain(undefined);
    expect(enrichWithContract(form, undefined)).toBe(form);
  });
});

describe('CompositeTestOracle', () => {
  const fixed = (
    name: string,
    status: 'PASS' | 'FAIL' | 'WARNING' | 'UNKNOWN',
    confidence = 0.8,
  ): TestOracle => ({
    name,
    evaluate: () =>
      Promise.resolve({
        oracle: name,
        status,
        confidence,
        reasons: [{ code: status, message: `${name} ${status}` }],
      }),
  });

  it('FAIL wins over WARNING, WARNING over PASS', async () => {
    const verdict = await new CompositeTestOracle([
      fixed('a', 'PASS'),
      fixed('b', 'WARNING', 0.6),
      fixed('c', 'FAIL', 1),
    ]).evaluate(page('x'), action(), page('y'), observed());
    expect(verdict.status).toBe('FAIL');
    expect(verdict.reasons).toEqual(['c: c FAIL']);
    const warned = await new CompositeTestOracle([fixed('a', 'PASS'), fixed('b', 'WARNING', 0.6)]).evaluate(
      page('x'),
      action(),
      page('y'),
      observed(),
    );
    expect(warned).toMatchObject({ status: 'WARNING', confidence: 0.6 });
  });

  it('never turns UNKNOWN into PASS, and says the business result is unknown', async () => {
    const unknown = await new CompositeTestOracle([fixed('a', 'UNKNOWN', 0)]).evaluate(
      page('x'),
      action(),
      page('y'),
      observed(),
    );
    expect(unknown.status).toBe('UNKNOWN');
    const verdict = await new CompositeTestOracle([
      new TechnicalOracle(),
      new BaselineOracle(undefined),
    ]).evaluate(page('x'), action(), page('y'), observed());
    expect(verdict.status).toBe('PASS');
    expect(verdict.assertions).toContain('✓ no HTTP 5xx');
    expect(verdict.assertions).toContain('? this transition is not in the baseline');
    expect(verdict.assertions.at(-1)).toBe('? business result unknown');
  });

  it('an oracle that throws gives UNKNOWN, not a crash', async () => {
    const broken: TestOracle = { name: 'broken', evaluate: () => Promise.reject(new Error('boom')) };
    const verdict = await new CompositeTestOracle([broken]).evaluate(
      page('x'),
      action(),
      page('y'),
      observed(),
    );
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.results[0]?.reasons[0]?.message).toBe('boom');
  });
});
