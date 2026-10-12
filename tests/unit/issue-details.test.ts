import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../../src/anomaly/issue-collector.js';
import { sourceOfFrame, stackFrames } from '../../src/observers/page-error-observer.js';
import { issueDetailsHtml } from '../../src/reporting/html-reporter.js';
import { reportTexts } from '../../src/reporting/i18n.js';
import type { Issue } from '../../src/model/issue.js';

const STACK = `TypeError: window.undefinedFunction is not a function
    at boom (http://app.test/js-error:13:16)
    at HTMLButtonElement.onclick (http://app.test/js-error:20:5)`;

function issue(details: Issue['details']): Issue {
  return {
    id: 'ISSUE-0001',
    type: 'PAGE_ERROR',
    severity: 'ERROR',
    message: 'Uncaught TypeError: window.undefinedFunction is not a function',
    pageUrl: 'http://app.test/js-error',
    pages: ['http://app.test/js-error'],
    states: [],
    timestamp: '2026-01-01T00:00:00.000Z',
    occurrences: 1,
    ...(details ? { details } : {}),
  };
}

describe('Issue details: stack frames and source', () => {
  it('keeps every frame of a V8 stack, without the "Name: message" line', () => {
    expect(stackFrames(STACK)).toEqual([
      'at boom (http://app.test/js-error:13:16)',
      'at HTMLButtonElement.onclick (http://app.test/js-error:20:5)',
    ]);
    expect(stackFrames(undefined)).toEqual([]);
  });

  it('reads the file, line and column of a frame, with or without a function name', () => {
    expect(sourceOfFrame('at boom (http://app.test/js-error:13:16)')).toEqual({
      url: 'http://app.test/js-error',
      line: 13,
      column: 16,
    });
    expect(sourceOfFrame('at http://app.test/app.js:1:2')).toEqual({
      url: 'http://app.test/app.js',
      line: 1,
      column: 2,
    });
    expect(sourceOfFrame('at <anonymous>')).toBeUndefined();
  });
});

describe('Issue details: collector', () => {
  it('redacts and bounds the details, and keeps those of the first occurrence', () => {
    const collector = new IssueCollector();
    const base = {
      type: 'CONSOLE' as const,
      severity: 'ERROR' as const,
      message: 'console.error: Payment widget failed',
      pageUrl: 'http://app.test/',
    };
    collector.add({
      ...base,
      details: {
        name: 'console.error',
        source: { url: 'http://app.test/widget.js?token=s3cr3t', line: 12 },
        stack: Array.from(
          { length: 40 },
          (_, i) => `at frame${String(i)} (http://app.test/w.js:${String(i)}:1)`,
        ),
        text: 'Payment widget failed\nauthorization: Bearer abc.def password=hunter2',
        extra: { empty: '', arguments: '2' },
      },
    });
    collector.add({ ...base, details: { name: 'second' } });
    const [only] = collector.all();
    expect(collector.all()).toHaveLength(1);
    expect(only?.occurrences).toBe(2);
    expect(only?.details?.name).toBe('console.error');
    expect(only?.details?.source?.url).not.toContain('s3cr3t');
    expect(only?.details?.stack).toHaveLength(30);
    expect(only?.details?.text).not.toContain('hunter2');
    expect(only?.details?.extra).toEqual({ arguments: '2' });
  });
});

describe('Issue details: HTML', () => {
  const t = reportTexts('en');

  it('renders nothing without details', () => {
    expect(issueDetailsHtml(issue(undefined), t)).toBe('');
    expect(issueDetailsHtml(issue({ name: 'TypeError' }), t)).toBe('');
  });

  it('renders a collapsible block with the source, the extra values, the stack and the full text, escaped', () => {
    const html = issueDetailsHtml(
      issue({
        name: 'TypeError',
        source: { url: 'http://app.test/js-error', line: 13, column: 16 },
        stack: stackFrames(STACK),
        text: 'line 1\nline <2>',
        extra: { 'content-type': 'text/html' },
      }),
      t,
    );
    expect(html).toContain('<details class="issue-details"><summary>Details (4)</summary>');
    expect(html).toContain('<dt>Source</dt><dd>http://app.test/js-error:13:16</dd>');
    expect(html).toContain('<dt>content-type</dt><dd>text/html</dd>');
    expect(html).toContain('Stack trace');
    expect(html).toContain('at HTMLButtonElement.onclick (http://app.test/js-error:20:5)');
    expect(html).toContain('line &lt;2&gt;');
    expect(html).not.toContain('<dt>Error</dt>');
    expect(issueDetailsHtml(issue({ source: { url: 'http://app.test/a.js' } }), reportTexts('fr'))).toContain(
      'Détails (1)',
    );
  });
});
