import type { Page } from 'playwright';

export interface DiscoveredLink {
  /** Absolute URL as resolved by the browser (relative hrefs, <base href> and routerLinks resolved). */
  href: string;
  text: string;
  source: 'anchor' | 'router-link';
}

/**
 * Extracts navigation targets from the current page: <a href>, <area href>
 * and, for Angular apps, [routerLink] attributes on non-anchor elements
 * (anchors with routerLink already render an href).
 *
 * The callback runs inside the browser and must stay self-contained.
 */
export async function discoverLinks(page: Page, followRouterLinks: boolean): Promise<DiscoveredLink[]> {
  return page.evaluate((includeRouterLinks: boolean) => {
    const links: { href: string; text: string; source: 'anchor' | 'router-link' }[] = [];
    for (const element of Array.from(document.querySelectorAll('a[href], area[href]'))) {
      const raw = element.getAttribute('href') ?? '';
      if (raw.trim() === '' || (raw.trim().startsWith('#') && !/^#!?\//.test(raw.trim()))) continue;
      const href = (element as HTMLAnchorElement | HTMLAreaElement).href;
      const text = ((element as HTMLElement).innerText || element.getAttribute('aria-label') || '').trim();
      links.push({ href, text: text.slice(0, 120), source: 'anchor' });
    }
    if (includeRouterLinks) {
      for (const element of Array.from(
        document.querySelectorAll('[routerlink]:not(a), [ng-reflect-router-link]:not(a)'),
      )) {
        const value =
          element.getAttribute('routerlink') ?? element.getAttribute('ng-reflect-router-link') ?? '';
        if (value.trim() === '' || value.includes('{{')) continue;
        // ng-reflect renders ['/users', 1] as "/users,1"
        const path = value.includes(',')
          ? value
              .split(',')
              .join('/')
              .replace(/\/{2,}/g, '/')
          : value;
        try {
          const href = new URL(path, document.baseURI).href;
          const text = (
            (element as HTMLElement).innerText ||
            element.getAttribute('aria-label') ||
            ''
          ).trim();
          links.push({ href, text: text.slice(0, 120), source: 'router-link' });
        } catch {
          // unresolvable routerLink value
        }
      }
    }
    return links;
  }, followRouterLinks);
}
