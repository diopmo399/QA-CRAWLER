import { describe, expect, it } from 'vitest';
import { normalizeSegment, routeKey, routePattern } from '../../src/crawler/route-normalizer.js';

describe('routePattern', () => {
  it('replaces numeric ids', () => {
    expect(routePattern('/users/1')).toBe('/users/:id');
    expect(routePattern('/users/42/orders/7')).toBe('/users/:id/orders/:id');
  });

  it('replaces UUIDs, hashes, dates and long tokens', () => {
    expect(routePattern('/users/550e8400-e29b-41d4-a716-446655440000')).toBe('/users/:uuid');
    expect(routePattern('/docs/507f1f77bcf86cd799439011')).toBe('/docs/:hash');
    expect(routePattern('/reports/2026-09-26')).toBe('/reports/:date');
    expect(routePattern('/share/aZ3kLm9Qx2Wv8Rt5Yp1Nb')).toBe('/share/:token');
    expect(routePattern('/products/123-blue-shirt')).toBe('/products/:id-slug');
  });

  it('keeps meaningful words', () => {
    expect(routePattern('/admin/users/new')).toBe('/admin/users/new');
    expect(routePattern('/')).toBe('/');
    expect(normalizeSegment('Settings')).toBe('settings');
    expect(normalizeSegment('v2')).toBe('v2');
  });

  it('groups concrete URLs of the same page type', () => {
    const routes = new Set(
      ['/users/1', '/users/2', '/users/3', '/users/4'].map((path) => routePattern(path)),
    );
    expect([...routes]).toEqual(['/users/:id']);
  });
});

describe('routeKey', () => {
  it('uses query parameter names but not values in pattern mode', () => {
    const keys = new Set(
      [1, 2, 3, 500].map((page) => routeKey(`https://example.com/products?page=${page}`, 'pattern')),
    );
    expect([...keys]).toEqual(['/products?page']);
    expect(routeKey('https://example.com/products?sort=asc&page=2', 'pattern')).toBe('/products?page&sort');
  });

  it('ignores the query in ignore mode and keeps it in keep mode', () => {
    expect(routeKey('https://example.com/products?page=2', 'ignore')).toBe('/products');
    expect(routeKey('https://example.com/products?page=2', 'keep')).toBe('/products?page=2');
  });

  it('ignores trailing slashes', () => {
    expect(routeKey('https://example.com/about/', 'pattern')).toBe(
      routeKey('https://example.com/about', 'pattern'),
    );
  });

  it('normalizes hash routes', () => {
    expect(routeKey('https://example.com/#/users/12?tab=info', 'pattern')).toBe('/users/:id?tab');
  });
});
