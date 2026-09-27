import { describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import {
  authorizationSection,
  dataSection,
  oraclesSection,
  recoverySection,
} from '../../src/reporting/quality-sections.js';

const nameOf = (stateId: string): string => stateId.toUpperCase();

const result = {
  transitions: [
    {
      from: 'users',
      to: 'users',
      actionId: 'a1',
      action: { type: 'click', category: 'other', text: 'Save <b>now</b>', classification: 'MUTATION' },
      result: 'SUCCESS',
      timestamp: '',
      issueIds: [],
      oracle: {
        status: 'FAIL',
        confidence: 1,
        reasons: ['technical: POST /api/users returned HTTP 500'],
        results: [],
        assertions: ['✗ POST /api/users returned HTTP 500', '? business result unknown'],
      },
    },
    {
      from: 'home',
      to: 'users',
      actionId: 'a2',
      action: { type: 'click', category: 'navigation', text: 'Users', classification: 'SAFE' },
      result: 'SUCCESS',
      timestamp: '',
      issueIds: [],
      oracle: {
        status: 'UNKNOWN',
        confidence: 0,
        reasons: [],
        results: [],
        assertions: ['? business result unknown'],
      },
    },
  ],
  recovery: {
    events: [
      {
        at: '',
        stateId: 'users',
        actionId: 'a3',
        failure: 'action-failed',
        message: 'Timeout',
        strategy: 'known-url',
        success: true,
      },
    ],
    stuck: [{ at: '', stateId: 'pages', kind: 'oscillation', message: 'oscillation between two states' }],
    circuits: [],
    reauthentications: 1,
  },
  authorization: {
    primaryActor: 'admin',
    actors: ['admin', 'reader'],
    observations: [],
    differences: [
      {
        stateId: 'admin',
        label: 'admin-users',
        url: 'http://x.test/admin',
        access: { admin: 'ALLOWED', reader: 'DENIED' },
        message: '',
      },
    ],
    rules: [
      { actor: 'reader', path: '/admin/*', expect: 'denied', status: 'PASS', checked: 1, violations: [] },
    ],
    errors: [],
  },
  mutations: { enabled: true, executed: 1, maxPerRun: 5 },
  createdData: [
    {
      runId: 'r1',
      tag: 'QA-CRAWLER-r1',
      stateId: 'users',
      actionId: 'a1',
      action: 'Save',
      requests: [{ method: 'POST', url: 'http://x.test/api/users', status: 201 }],
      at: '',
    },
  ],
  cleanup: { cleaner: 'manual', cleaned: 0, pending: [], notes: ['Nothing was deleted automatically.'] },
} as unknown as ExplorationResult;

describe('HTML quality sections', () => {
  it('oracle verdicts: FAIL first, counts per status, escaped labels, business result unknown', () => {
    const html = oraclesSection(result, nameOf, 'en');
    expect(html).toContain('Test oracle verdicts (2)');
    expect(html.indexOf('FAIL</span></td>')).toBeLessThan(html.indexOf('UNKNOWN</span></td>'));
    expect(html).toContain('Save &lt;b&gt;now&lt;/b&gt;');
    expect(html).not.toContain('<b>now</b>');
    expect(html).toContain('? business result unknown');
  });

  it('recovery, authorization and data sections, in French too', () => {
    expect(recoverySection(result, nameOf, 'en')).toContain('1 re-authentication(s)');
    expect(recoverySection(result, nameOf, 'fr')).toContain('Branches abandonnées (1)');
    const authorization = authorizationSection(result, 'en');
    expect(authorization).toContain('admin, reader');
    expect(authorization).toContain('<td>DENIED</td>');
    const data = dataSection(result, nameOf, 'en');
    expect(data).toContain('QA-CRAWLER-r1');
    expect(data).toContain('budget: 5');
    expect(data).toContain('Nothing was deleted automatically.');
  });

  it('sections without data are left out', () => {
    const empty = { transitions: [] } as unknown as ExplorationResult;
    expect(oraclesSection(empty, nameOf, 'en')).toBe('');
    expect(recoverySection(empty, nameOf, 'en')).toBe('');
    expect(authorizationSection(empty, 'en')).toBe('');
    expect(dataSection(empty, nameOf, 'en')).toBe('');
  });
});
