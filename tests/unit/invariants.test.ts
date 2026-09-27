import { describe, expect, it } from 'vitest';
import type { AuthorizationReport } from '../../src/actors/authorization-observer.js';
import { CompositeTestOracle } from '../../src/oracles/composite-oracle.js';
import { categoryOf, confidenceOf } from '../../src/oracles/confidence.js';
import { InvariantOracle } from '../../src/oracles/invariant-oracle.js';
import type { ActionObservations, ExecutedAction } from '../../src/oracles/oracle.js';
import { screen, testConfig } from '../helpers.js';

const config = testConfig(`
invariants:
  - id: NO-500
    description: No server error
    when: { anyRequest: true }
    expect: { statusBelow: 500 }
  - id: USER-CREATE
    severity: WARNING
    when: { actionMatches: [create user, créer utilisateur] }
    expect: { resultingPattern: [CREATE_FORM] }
  - id: SLOW
    severity: INFO
    when: {}
    expect: { maxDurationMs: 1000 }
  - id: ADMIN-ACCESS
    severity: CRITICAL
    when: { actor: user, path: /admin/** }
    expect: { access: [denied, forbidden] }
`);

const before = screen({ url: 'http://localhost:4200/users', headings: ['Utilisateurs'] });
const after = screen({ url: 'http://localhost:4200/users/new', headings: ['Nouvel utilisateur'] });
const action = (text: string, durationMs = 100): ExecutedAction => ({
  id: 'a1',
  type: 'click',
  category: 'other',
  classification: 'SAFE',
  text,
  result: 'SUCCESS',
  durationMs,
});
const observations = (status: number, afterPattern?: 'CREATE_FORM'): ActionObservations => ({
  issues: [],
  network: [{ method: 'POST', url: 'http://localhost:4200/api/users', status, resourceType: 'fetch' }],
  pageCrashed: false,
  ...(afterPattern ? { afterPatterns: [{ type: afterPattern, confidence: 0.8, evidence: [] }] } : {}),
});

describe('InvariantOracle', () => {
  it('explains the verdict: rule, expected, observed; ERROR fails', async () => {
    const oracle = new InvariantOracle(config.invariants);
    const verdict = await oracle.evaluate(
      before,
      action('Créer utilisateur'),
      after,
      observations(500, 'CREATE_FORM'),
    );
    expect(verdict).toMatchObject({
      oracle: 'invariant',
      status: 'FAIL',
      confidenceSource: 'explicit-invariant',
    });
    expect(verdict.reasons.map((reason) => reason.message)).toEqual([
      'invariant NO-500: expected status < 500, observed POST /api/users → 500',
      'invariant USER-CREATE: resulting screen CREATE_FORM',
      'invariant SLOW: ≤ 1000 ms',
    ]);
    expect(oracle.evaluations()[0]).toMatchObject({
      invariantId: 'NO-500',
      severity: 'ERROR',
      status: 'FAIL',
    });
  });

  it('severity decides: WARNING warns, INFO is only noted, a rule that does not apply is not counted', async () => {
    const oracle = new InvariantOracle(config.invariants);
    expect(
      (await oracle.evaluate(before, action('Créer utilisateur'), after, observations(201))).status,
    ).toBe('WARNING');
    expect(
      (await oracle.evaluate(before, action('Voir', 5000), after, { ...observations(200), network: [] }))
        .status,
    ).toBe(
      'PASS', // seul SLOW (INFO) s'applique et échoue
    );
    const none = new InvariantOracle(config.invariants.slice(1, 2));
    expect((await none.evaluate(before, action('Voir'), after, observations(200))).status).toBe('UNKNOWN');
  });

  it('ADMIN-ACCESS: actor rules judged on the multi-actor observations', () => {
    const oracle = new InvariantOracle(config.invariants);
    const report = {
      primaryActor: 'admin',
      actors: ['admin', 'user'],
      observations: [
        {
          actor: 'user',
          stateId: 's1',
          label: 'admin',
          url: 'http://localhost:4200/admin/users',
          access: 'ALLOWED',
        },
        {
          actor: 'user',
          stateId: 's2',
          label: 'x',
          url: 'http://localhost:4200/admin/logs',
          access: 'DENIED',
          status: 403,
        },
        { actor: 'user', stateId: 's3', label: 'home', url: 'http://localhost:4200/', access: 'ALLOWED' },
      ],
      differences: [],
      rules: [],
      errors: [],
    } as AuthorizationReport;
    expect(oracle.evaluateAccess(report)).toEqual([
      expect.objectContaining({
        invariantId: 'ADMIN-ACCESS',
        status: 'FAIL',
        severity: 'CRITICAL',
        expected: 'access denied or forbidden',
        observed: 'page accessible',
      }),
      expect.objectContaining({ status: 'PASS', observed: 'access forbidden (HTTP 403)' }),
    ]);
  });
});

describe('confidence and verdict categories', () => {
  it('explicit rules > contract > repeated history > single observation', () => {
    expect(confidenceOf('explicit-invariant')).toBeGreaterThan(confidenceOf('openapi-contract'));
    expect(confidenceOf('openapi-contract')).toBeGreaterThan(confidenceOf('repeated-history', 20));
    expect(confidenceOf('repeated-history', 20)).toBeGreaterThan(confidenceOf('repeated-history', 3));
    expect(confidenceOf('repeated-history', 1)).toBe(confidenceOf('single-observation'));
  });

  it('an unusual behaviour is not a bug: categories keep them apart', async () => {
    expect(categoryOf('technical', 'FAIL')).toBe('CONFIRMED_FAILURE');
    expect(categoryOf('contract', 'WARNING')).toBe('CONTRACT_VIOLATION');
    expect(categoryOf('baseline', 'WARNING')).toBe('POTENTIAL_REGRESSION');
    expect(categoryOf('historical', 'WARNING')).toBe('UNEXPECTED_BEHAVIOR');
    const composite = new CompositeTestOracle([new InvariantOracle(config.invariants)]);
    const verdict = await composite.evaluate(
      before,
      action('Créer utilisateur'),
      after,
      observations(500, 'CREATE_FORM'),
    );
    expect(verdict.categories).toEqual(['INVARIANT_VIOLATION']);
  });
});
