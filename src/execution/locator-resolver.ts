import type { Locator, Page } from 'playwright';
import type { LocatorDescriptor } from '../model/locator.js';

/** The part of Playwright's Page used to build locators (lets tests use a fake). */
export type LocatorFactory = Pick<Page, 'getByRole' | 'getByTestId' | 'getByLabel' | 'getByText' | 'locator'>;

type AriaRole = Parameters<Page['getByRole']>[0];

/**
 * Translates a serializable LocatorDescriptor into a Playwright Locator.
 * `nth` is not applied here: the executor applies it once it knows how many
 * elements match.
 */
export function toLocator(page: LocatorFactory, descriptor: LocatorDescriptor): Locator {
  const exact = descriptor.exact ?? false;
  switch (descriptor.strategy) {
    case 'testId':
      return page.getByTestId(descriptor.value ?? '');
    case 'role':
      return page.getByRole((descriptor.role ?? 'button') as AriaRole, {
        ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
        exact,
      });
    case 'label':
      return page.getByLabel(descriptor.value ?? '', { exact });
    case 'text':
      return page.getByText(descriptor.value ?? '', { exact });
    case 'css':
      return page.locator(descriptor.value ?? '');
  }
}
