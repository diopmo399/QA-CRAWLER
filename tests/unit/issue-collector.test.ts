import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../../src/anomaly/issue-collector.js';
import { SeverityRules } from '../../src/anomaly/severity-rules.js';

describe('IssueCollector', () => {
  it('merges identical anomalies seen on several pages', () => {
    const collector = new IssueCollector(() => new Date('2026-01-01T00:00:00Z'));
    const base = {
      type: 'PAGE_ERROR' as const,
      severity: 'ERROR' as const,
      message: 'Uncaught TypeError at app.js:10:5',
    };
    collector.add({ ...base, pageUrl: 'http://x.test/a' });
    collector.add({ ...base, pageUrl: 'http://x.test/b' });
    collector.add({ ...base, message: 'Uncaught TypeError at app.js:12:9', pageUrl: 'http://x.test/b' });

    const issues = collector.all();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'ISSUE-0001',
      occurrences: 3,
      pages: ['http://x.test/a', 'http://x.test/b'],
    });
    expect(collector.forPage('http://x.test/b')).toHaveLength(1);
  });

  it('keeps different requests apart and redacts them', () => {
    const collector = new IssueCollector();
    collector.add({
      type: 'HTTP',
      severity: 'ERROR',
      message: 'GET /api/a -> 500',
      pageUrl: 'http://x.test/',
      requestUrl: 'http://x.test/api/a?token=s3cr3t',
      status: 500,
    });
    collector.add({
      type: 'HTTP',
      severity: 'ERROR',
      message: 'GET /api/b -> 500',
      pageUrl: 'http://x.test/',
      requestUrl: 'http://x.test/api/b',
      status: 500,
    });
    const issues = collector.all();
    expect(issues).toHaveLength(2);
    expect(JSON.stringify(issues)).not.toContain('s3cr3t');
    expect(collector.countBySeverity()).toMatchObject({ ERROR: 2, WARNING: 0 });
  });
});

describe('SeverityRules', () => {
  it('grades HTTP statuses', () => {
    expect(SeverityRules.httpResponse(500)).toBe('ERROR');
    expect(SeverityRules.httpResponse(404)).toBe('WARNING');
    expect(SeverityRules.httpResponse(403)).toBe('WARNING');
    expect(SeverityRules.pageResponse(404)).toBe('ERROR');
    expect(SeverityRules.pageResponse(503)).toBe('ERROR');
  });

  it('grades JavaScript and navigation failures', () => {
    expect(SeverityRules.consoleError()).toBe('ERROR');
    expect(SeverityRules.pageError()).toBe('ERROR');
    expect(SeverityRules.pageCrash()).toBe('CRITICAL');
    expect(SeverityRules.navigationFailure('timeout')).toBe('ERROR');
    expect(SeverityRules.navigationFailure('external-redirect')).toBe('WARNING');
  });
});
