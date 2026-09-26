import { describe, expect, it } from 'vitest';
import { screenshotFileName } from '../../src/browser/screenshot-service.js';
import { CrawlQueue } from '../../src/crawler/queue.js';
import { esc } from '../../src/reporting/html-reporter.js';
import { parseCliArgs, UsageError } from '../../src/cli/args.js';

describe('CrawlQueue', () => {
  it('is FIFO, deduplicates URLs and caps URLs per route', () => {
    const queue = new CrawlQueue(2);
    expect(queue.enqueue({ url: 'u/1', depth: 1, route: '/u/:id' })).toBeUndefined();
    expect(queue.enqueue({ url: 'u/2', depth: 1, route: '/u/:id' })).toBeUndefined();
    expect(queue.enqueue({ url: 'u/3', depth: 1, route: '/u/:id' })).toBe('route-limit');
    expect(queue.enqueue({ url: 'u/1', depth: 2, route: '/u/:id' })).toBe('already-seen');
    expect(queue.dequeue()?.url).toBe('u/1');
    expect(queue.size).toBe(1);
    queue.markSeen('redirect/target');
    expect(queue.hasSeen('redirect/target')).toBe(true);
  });
});

describe('screenshotFileName', () => {
  it('builds safe, sortable names', () => {
    expect(screenshotFileName(1, 'http://x.test/')).toBe('001-home.png');
    expect(screenshotFileName(2, 'http://x.test/login?next=/admin')).toBe('002-login.png');
    expect(screenshotFileName(3, 'http://x.test/admin/Users/', 'error')).toBe('003-admin-users-error.png');
    expect(screenshotFileName(4, 'http://x.test/#/équipe/../../etc')).toBe('004-equipe-etc.png');
    expect(screenshotFileName(5, 'http://x.test/a%20b/<script>')).toMatch(/^005-[a-z0-9-]+\.png$/);
  });
});

describe('HTML escaping', () => {
  it('escapes markup', () => {
    expect(esc(`<img src=x onerror="alert('x')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
    );
  });
});

describe('parseCliArgs', () => {
  it('accepts a positional scenario or --config', () => {
    expect(parseCliArgs(['scenarios/smoke.yaml']).configPath).toBe('scenarios/smoke.yaml');
    expect(parseCliArgs(['--config', 'scenarios/smoke.yaml']).configPath).toBe('scenarios/smoke.yaml');
    expect(parseCliArgs(['-c', 's.yaml', '--max-pages', '5', '--headed'])).toMatchObject({
      maxPages: 5,
      headless: false,
    });
    expect(parseCliArgs(['--help']).help).toBe(true);
  });

  it('rejects invalid usage', () => {
    expect(() => parseCliArgs(['a.yaml', 'b.yaml'])).toThrowError(UsageError);
    expect(() => parseCliArgs(['--max-pages', 'zero'])).toThrowError(UsageError);
    expect(() => parseCliArgs(['--unknown'])).toThrowError(UsageError);
  });
});
