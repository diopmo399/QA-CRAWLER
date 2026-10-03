import type { Locator, Page } from 'playwright';
import type { LocatorDescriptor } from '../model/locator.js';

/** La partie de la Page de Playwright qui sert à construire les localisateurs (permet aux tests d'utiliser une imitation). */
export type LocatorFactory = Pick<
  Page,
  'getByRole' | 'getByTestId' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'locator'
>;

type AriaRole = Parameters<Page['getByRole']>[0];

/**
 * Traduit un LocatorDescriptor sérialisable en Locator Playwright.
 * `nth` n'est pas appliqué ici : l'exécuteur l'applique une fois qu'il sait
 * combien d'éléments correspondent.
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
    case 'label': {
      // Le « libellé » d'un champ est son NOM ACCESSIBLE : <label for>, aria-label(ledby)… mais
      // un champ d'autocomplétion (Angular Material, combobox ARIA) n'a souvent qu'un placeholder
      // ou un nom porté par son rôle. getByLabel seul ne le voit pas, alors que l'écran le montre.
      const value = descriptor.value ?? '';
      return page
        .getByLabel(value, { exact })
        .or(page.getByPlaceholder(value, { exact }))
        .or(page.getByRole('combobox', { name: value, exact }))
        .or(page.getByRole('textbox', { name: value, exact }));
    }
    case 'text':
      return page.getByText(descriptor.value ?? '', { exact });
    case 'css':
      return page.locator(descriptor.value ?? '');
  }
}
