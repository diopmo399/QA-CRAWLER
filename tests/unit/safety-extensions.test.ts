import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { CreatedDataRegistry, ManualCleanup } from '../../src/data/created-data.js';
import { combineListeners, EngineEventLog } from '../../src/logging/engine-log.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import type { PageContext } from '../../src/model/page-context.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { NoVisualComparator } from '../../src/visual/visual-comparator.js';
import { testConfig } from '../helpers.js';

const action = (overrides: Partial<DiscoveredAction>): DiscoveredAction => ({
  id: 'a-1',
  stateId: 's-1',
  type: 'click',
  category: 'other',
  elementType: 'button',
  disabled: false,
  visible: true,
  classification: 'SAFE',
  reason: 'test',
  risks: [],
  locator: { strategy: 'role', role: 'button', name: 'x' },
  ...overrides,
});

describe('safety.mutations', () => {
  it('is off by default: MUTATION and form submission stay blocked', () => {
    const config = testConfig();
    expect(config.safety.mutations).toEqual({ enabled: false, maxPerRun: 10 });
    const policy = new SafetyPolicy(config.safety);
    expect(policy.evaluate(action({ classification: 'MUTATION', text: 'Save' })).verdict).toBe('BLOCK');
  });

  it('enabled: MUTATION and form submission allowed within the budget, DANGEROUS never', () => {
    const { config, warnings } = parseConfig(
      'target: { baseUrl: http://localhost:4200 }\nsafety:\n  mutations: { enabled: true, maxPerRun: 2 }\n',
      {},
      {},
    );
    expect(config.safety.allowedActionClasses).toContain('MUTATION');
    expect(config.safety.block).not.toContain('form-submit');
    expect(warnings.some((warning) => warning.includes('at most 2 per run'))).toBe(true);
    const policy = new SafetyPolicy(config.safety);
    const save = action({ classification: 'MUTATION', text: 'Save' });
    const submit = action({ id: 'a-2', classification: 'MUTATION', risks: ['form-submit'] });
    expect(policy.evaluate(save).verdict).toBe('ALLOW');
    policy.recordExecuted(save);
    policy.recordExecuted(action({ text: 'Users' })); // SAFE: not counted
    expect(policy.evaluate(submit).verdict).toBe('ALLOW');
    policy.recordExecuted(submit);
    expect(policy.mutationCount).toBe(2);
    expect(policy.evaluate(save)).toEqual({ verdict: 'BLOCK', reason: 'mutation budget spent (2/2)' });
    // Safe actions go on.
    expect(policy.evaluate(action({ text: 'Users' })).verdict).toBe('ALLOW');
    expect(policy.evaluate(action({ classification: 'DANGEROUS', risks: [] })).verdict).toBe('BLOCK');
  });

  it('DANGEROUS in allowedActionClasses: executed, with a warning naming the risks still blocked', () => {
    const { config, warnings } = parseConfig(
      'target: { baseUrl: http://localhost:4200 }\nsafety:\n  allowedActionClasses: [SAFE, DANGEROUS]\n  block: [payment]\n  mutations: { enabled: true, maxPerRun: 1 }\n',
      {},
      {},
    );
    expect(config.safety.allowedActionClasses).toEqual(['SAFE', 'DANGEROUS', 'MUTATION']);
    expect(
      warnings.some((warning) => warning.includes('destructive actions') && warning.includes('payment')),
    ).toBe(true);
    const policy = new SafetyPolicy(config.safety);
    const remove = action({ classification: 'DANGEROUS', text: 'Delete', risks: ['delete'] });
    expect(policy.evaluate(remove).verdict).toBe('ALLOW');
    expect(policy.evaluate(action({ classification: 'DANGEROUS', risks: ['payment'] })).verdict).toBe(
      'BLOCK',
    );
    expect(
      policy.evaluate(action({ type: 'fill', classification: 'DANGEROUS', risks: ['sensitive-data'] }))
        .verdict,
    ).toBe('BLOCK');
    // It counts in the budget of actions changing data.
    policy.recordExecuted(remove);
    expect(policy.evaluate(remove).verdict).toBe('BLOCK');
  });
});

describe('created data and cleanup', () => {
  it('keeps actions answered by a successful write, tagged with the run', async () => {
    const registry = new CreatedDataRegistry('r42');
    expect(
      registry.record({
        stateId: 's',
        actionId: 'a',
        action: 'Search',
        requests: [{ method: 'GET', url: 'http://app.test/api/users', status: 200 }],
      }),
    ).toBeUndefined();
    expect(
      registry.record({
        stateId: 's',
        actionId: 'b',
        action: 'Save',
        requests: [{ method: 'POST', url: 'http://app.test/api/users', status: 500 }],
      }),
    ).toBeUndefined();
    const created = registry.record({
      stateId: 's',
      actionId: 'c',
      action: 'Save',
      form: 'Create user',
      requests: [
        { method: 'POST', url: 'http://app.test/api/users', status: 201 },
        { method: 'GET', url: 'http://app.test/api/users', status: 200 },
      ],
    });
    expect(created).toMatchObject({
      runId: 'r42',
      tag: 'QA-CRAWLER-r42',
      requests: [{ method: 'POST', url: 'http://app.test/api/users', status: 201 }],
    });
    const report = await new ManualCleanup().cleanup(registry.all());
    expect(report).toMatchObject({ cleaner: 'manual', cleaned: 0 });
    expect(report.pending).toHaveLength(1);
    expect(report.notes[0]).toContain('QA-CRAWLER-r42');
  });

  it('visual comparison without comparator: UNKNOWN', async () => {
    expect((await new NoVisualComparator().compare()).status).toBe('UNKNOWN');
  });
});

describe('engine log', () => {
  const context = {
    stateId: 'users',
    stateLabel: 'Users',
    route: '/users',
    url: 'http://app.test/users?token=abc123',
    actions: [],
    metadata: { depth: 1 },
  } as unknown as PageContext;

  it('keeps the entries of its level and above, as JSON lines with redacted URLs', () => {
    const log = new EngineEventLog('INFO');
    const listener = log.listener();
    listener.onState?.(context, true);
    listener.onState?.(context, false); // TRACE: not kept
    listener.onBacktrack?.('users', 'home', 'url'); // DEBUG: not kept
    listener.onStuck?.({
      at: '',
      stateId: 'users',
      kind: 'no-op',
      message: '15 consecutive actions changed nothing',
    });
    expect(log.entries().map((entry) => [entry.level, entry.event])).toEqual([
      ['INFO', 'FLOW_STATE_DISCOVERED'],
      ['WARN', 'STUCK_DETECTED'],
    ]);
    const text = log.toJsonLines();
    expect(text).not.toContain('abc123');
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  it('combines listeners: each receives every event', () => {
    const seen: string[] = [];
    const combined = combineListeners({ onBacktrack: (from) => seen.push(`a:${from}`) }, undefined, {
      onBacktrack: (from) => seen.push(`b:${from}`),
      onStuck: () => seen.push('stuck'),
    });
    combined.onBacktrack?.('x', undefined, 'url');
    combined.onStuck?.({ at: '', stateId: 'x', kind: 'busy', message: '' });
    expect(seen).toEqual(['a:x', 'b:x', 'stuck']);
  });

  it('accepts lower-case levels in the mission', () => {
    expect(testConfig('logging: { level: debug }').logging.level).toBe('DEBUG');
  });
});

describe('actors configuration', () => {
  const base = 'target: { baseUrl: http://localhost:4200 }\n';
  const reader =
    "  - name: reader\n    auth: { type: form, loginUrl: /login, usernameSelector: '#u', passwordSelector: '#p', submitSelector: button, usernameEnv: R_USER, passwordEnv: R_PASS }\n";

  it('parses actors with environment variable names only', () => {
    const { config } = parseConfig(`${base}actors:\n${reader}`, {}, {});
    expect(config.actors[0]).toMatchObject({
      name: 'reader',
      auth: { usernameEnv: 'R_USER', passwordEnv: 'R_PASS' },
    });
    expect(config.authorization).toMatchObject({
      enabled: true,
      primaryActor: 'primary',
      rules: [],
      maxTargets: 50,
    });
  });

  it('rejects a password in the file, unknown actors in rules and duplicate names', () => {
    expect(() =>
      parseConfig(
        `${base}actors:\n  - name: x\n    auth: { type: form, loginUrl: /l, usernameSelector: a, passwordSelector: b, submitSelector: c, password: hunter2 }\n`,
        {},
        {},
      ),
    ).toThrowError(/Invalid scenario/);
    expect(() =>
      parseConfig(
        `${base}actors:\n${reader}authorization:\n  rules: [{ actor: nobody, path: /admin, expect: denied }]\n`,
        {},
        {},
      ),
    ).toThrowError(/unknown actor "nobody"/);
    expect(() => parseConfig(`${base}actors:\n${reader}${reader}`, {}, {})).toThrowError(/unique/);
    expect(() => parseConfig(`${base}actors:\n${reader.replace('reader', 'primary')}`, {}, {})).toThrowError(
      /unique/,
    );
  });
});
