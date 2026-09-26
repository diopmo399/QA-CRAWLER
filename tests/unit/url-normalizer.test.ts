import { describe, expect, it } from 'vitest';
import {
  effectivePath,
  normalizeUrl,
  resolveUrl,
  type NormalizeOptions,
} from '../../src/crawler/url-normalizer.js';

const pattern: NormalizeOptions = { queryParamMode: 'pattern', ignoredParams: ['utm_*', 'fbclid'] };
const norm = (url: string, options: NormalizeOptions = pattern): string => normalizeUrl(url, options);

describe('resolveUrl', () => {
  const base = 'https://app.example.com/users/list?page=2';

  it('resolves relative, root-relative and absolute URLs', () => {
    expect(resolveUrl('details', base)?.toString()).toBe('https://app.example.com/users/details');
    expect(resolveUrl('../about', base)?.toString()).toBe('https://app.example.com/about');
    expect(resolveUrl('/settings', base)?.toString()).toBe('https://app.example.com/settings');
    expect(resolveUrl('https://other.example.org/x', base)?.toString()).toBe('https://other.example.org/x');
    expect(resolveUrl('//cdn.example.com/lib.js', base)?.toString()).toBe('https://cdn.example.com/lib.js');
  });

  it('keeps query parameters and fragments for later normalization', () => {
    expect(resolveUrl('?sort=name#top', base)?.toString()).toBe(
      'https://app.example.com/users/list?sort=name#top',
    );
  });

  it('rejects non-navigable targets', () => {
    for (const href of [
      '',
      '   ',
      'mailto:a@b.c',
      'tel:+331',
      'javascript:void(0)',
      'data:text/html,x',
      'ftp://x/y',
    ]) {
      expect(resolveUrl(href, base)).toBeUndefined();
    }
  });
});

describe('normalizeUrl', () => {
  it('lower-cases the host and removes default ports', () => {
    expect(norm('HTTP://Example.COM:80/Path')).toBe('http://example.com/Path');
    expect(norm('https://example.com:443/')).toBe('https://example.com/');
    expect(norm('http://localhost:4200/x')).toBe('http://localhost:4200/x');
  });

  it('removes plain fragments and trailing slashes', () => {
    expect(norm('https://example.com/about/#team')).toBe('https://example.com/about');
    expect(norm('https://example.com//a//b/')).toBe('https://example.com/a/b');
    expect(norm('https://example.com')).toBe('https://example.com/');
  });

  it('keeps hash routes used by single-page applications', () => {
    expect(norm('https://example.com/#/users/12/')).toBe('https://example.com/#/users/12');
    expect(norm('https://example.com/#!/users?b=2&a=1')).toBe('https://example.com/#/users?a=1&b=2');
  });

  it('sorts query parameters and drops tracking parameters', () => {
    expect(norm('https://example.com/p?b=2&a=1&utm_source=mail&fbclid=x')).toBe(
      'https://example.com/p?a=1&b=2',
    );
  });

  it('drops every query parameter in ignore mode', () => {
    expect(norm('https://example.com/p?page=3', { queryParamMode: 'ignore', ignoredParams: [] })).toBe(
      'https://example.com/p',
    );
  });

  it('treats equivalent URLs as identical', () => {
    const variants = [
      'https://Example.com/users/?utm_campaign=x#top',
      'https://example.com:443/users',
      'https://example.com//users/',
    ];
    expect(new Set(variants.map((url) => norm(url))).size).toBe(1);
  });
});

describe('effectivePath', () => {
  it('returns the hash route for hash-routed applications', () => {
    expect(effectivePath('https://example.com/app/#/admin/users?x=1')).toBe('/admin/users');
    expect(effectivePath('https://example.com/admin/users?x=1')).toBe('/admin/users');
  });
});
