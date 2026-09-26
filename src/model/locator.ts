/**
 * Serializable description of how to find an element again. Never a
 * Playwright Locator: decisions, graphs and reports must stay plain data
 * (storable in JSON, sendable to a future decision engine).
 *
 * Preference order when building one: testId → role + accessible name →
 * label → text → css (last resort).
 */
export type LocatorStrategy = 'testId' | 'role' | 'label' | 'text' | 'css';

export interface LocatorDescriptor {
  strategy: LocatorStrategy;
  /** ARIA role, for the `role` strategy. */
  role?: string;
  /** Accessible name, for the `role` strategy. */
  name?: string;
  /** testId, label text, visible text or CSS selector, depending on the strategy. */
  value?: string;
  /** Exact (case-sensitive, whole string) match. */
  exact?: boolean;
  /** 0-based index when the descriptor matches several elements on the page. */
  nth?: number;
}

export function describeLocator(locator: LocatorDescriptor): string {
  const nth = locator.nth !== undefined && locator.nth > 0 ? ` [${locator.nth}]` : '';
  switch (locator.strategy) {
    case 'role':
      return `role=${locator.role ?? '?'}[name="${locator.name ?? ''}"]${nth}`;
    case 'testId':
      return `testId=${locator.value ?? ''}${nth}`;
    case 'label':
      return `label="${locator.value ?? ''}"${nth}`;
    case 'text':
      return `text="${locator.value ?? ''}"${nth}`;
    case 'css':
      return `css=${locator.value ?? ''}${nth}`;
  }
}
