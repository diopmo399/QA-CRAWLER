import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isNavigationError, UIObserver } from '../../src/observation/ui-observer.js';

const DOM = {
  headings: [],
  dialogs: [],
  selectedTabs: [],
  currentItems: [],
  elements: [],
  forms: [],
  textExcerpt: '',
};

/** Une page dont les premières lectures tombent pendant une navigation (redirections d'une connexion unique). */
function navigatingPage(failures: string[]): { page: Page; waits: number } {
  const state = { waits: 0 };
  const page = {
    evaluate: () => {
      const message = failures.shift();
      return message === undefined ? Promise.resolve(DOM) : Promise.reject(new Error(message));
    },
    waitForLoadState: () => {
      state.waits += 1;
      return Promise.resolve();
    },
    title: () => Promise.resolve('Accueil'),
    isClosed: () => false,
    url: () => 'https://app.test/accueil',
  } as unknown as Page;
  return {
    page,
    get waits() {
      return state.waits;
    },
  };
}

const DESTROYED = 'page.evaluate: Execution context was destroyed, most likely because of a navigation';

describe('UIObserver while the page navigates', () => {
  it('waits for the new page and reads again instead of failing the mission', async () => {
    const target = navigatingPage([DESTROYED, DESTROYED]);
    const snapshot = await new UIObserver().observe(target.page);
    expect(snapshot).toMatchObject({ url: 'https://app.test/accueil', title: 'Accueil' });
    expect(target.waits).toBe(2);
  });

  it('gives up after a few attempts: a page that never settles is still reported', async () => {
    const target = navigatingPage([DESTROYED, DESTROYED, DESTROYED, DESTROYED]);
    await expect(new UIObserver().observe(target.page)).rejects.toThrow('Execution context was destroyed');
  });

  it('any other error is not retried', async () => {
    const target = navigatingPage(['page.evaluate: Target page, context or browser has been closed']);
    await expect(new UIObserver().observe(target.page)).rejects.toThrow('has been closed');
    expect(target.waits).toBe(0);
  });

  it('recognizes the navigation errors of Playwright', () => {
    expect(isNavigationError(new Error(DESTROYED))).toBe(true);
    expect(isNavigationError(new Error('Protocol error: Cannot find context with specified id'))).toBe(true);
    expect(isNavigationError(new Error('Frame was detached'))).toBe(true);
    expect(isNavigationError(new Error('Timeout 30000ms exceeded'))).toBe(false);
  });
});
