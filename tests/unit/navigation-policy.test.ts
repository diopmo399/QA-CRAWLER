import { describe, expect, it } from 'vitest';
import { NavigationPolicy, pathPatternToRegex } from '../../src/policies/navigation-policy.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';

const safety = {
  allowedHosts: ['localhost', '*.example.com'],
  ignoredPaths: ['/logout', '/admin/*/purge', '/api/**'],
  allowedActionClasses: ['SAFE' as const],
  keywords: { safe: [], mutation: [], dangerous: [] },
};
const policy = new NavigationPolicy(safety, new SafetyPolicy(safety));
const evaluate = (url: string) => policy.evaluate(new URL(url));

describe('NavigationPolicy', () => {
  it('allows internal pages', () => {
    expect(evaluate('http://localhost:4200/users').allowed).toBe(true);
    expect(evaluate('https://app.example.com/dashboard').allowed).toBe(true);
  });

  it('never allows external hosts', () => {
    expect(evaluate('https://evil.test/users')).toMatchObject({ allowed: false, reason: 'external-host' });
    expect(evaluate('https://example.com/')).toMatchObject({ allowed: false, reason: 'external-host' });
  });

  it('skips ignored paths', () => {
    expect(evaluate('http://localhost/logout')).toMatchObject({ allowed: false, reason: 'ignored-path' });
    expect(evaluate('http://localhost/logout/now')).toMatchObject({ allowed: false, reason: 'ignored-path' });
    expect(evaluate('http://localhost/logouts').allowed).toBe(true);
    expect(evaluate('http://localhost/admin/cache/purge')).toMatchObject({
      allowed: false,
      reason: 'ignored-path',
    });
    expect(evaluate('http://localhost/api/v1/users')).toMatchObject({
      allowed: false,
      reason: 'ignored-path',
    });
    expect(evaluate('http://localhost/#/logout')).toMatchObject({ allowed: false, reason: 'ignored-path' });
  });

  it('skips dangerous URLs and downloads', () => {
    expect(evaluate('http://localhost/users/3/delete')).toMatchObject({
      allowed: false,
      reason: 'dangerous-url',
    });
    expect(evaluate('http://localhost/files/report.pdf')).toMatchObject({
      allowed: false,
      reason: 'non-html-resource',
    });
  });
});

describe('pathPatternToRegex', () => {
  it('matches on segment boundaries', () => {
    const regex = pathPatternToRegex('/payment');
    expect(regex.test('/payment')).toBe(true);
    expect(regex.test('/payment/confirm')).toBe(true);
    expect(regex.test('/payments')).toBe(false);
  });
});
