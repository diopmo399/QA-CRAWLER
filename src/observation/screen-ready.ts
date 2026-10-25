import type { Page } from 'playwright';

/** Roues de chargement, barres de progression, zones occupées, squelettes d'écran. */
export const BUSY_SELECTOR = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  'mat-spinner',
  'mat-progress-spinner',
  'mat-progress-bar',
  'ngx-spinner',
  'lightning-spinner',
  '.spinner',
  '.loading',
  '.loader',
  '[class*="spinner"]',
  '[class*="skeleton"]',
].join(', ');

/** Temps sans changement du nombre d'éléments pour considérer l'écran affiché. */
const QUIET_MS = 200;

/**
 * « L'écran est-il prêt ? » Attend, dans la limite de `timeoutMs`, qu'aucun indicateur
 * de chargement ne soit visible ET que le nombre d'éléments de la page n'ait plus
 * bougé depuis un court instant (la liste, le détail, le formulaire sont arrivés).
 * Au-delà du délai, on observe l'écran tel qu'il est : jamais une erreur.
 */
export async function waitForScreenReady(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0 || page.isClosed()) return;
  await page
    .waitForFunction(
      ({ busy, quietMs }) => {
        const holder = window as unknown as { __qaReady?: { count: number; since: number } };
        const visible = (el: Element): boolean => {
          if (el.getClientRects().length === 0) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        // Les composants web (Lightning, Stencil, Lit…) rendent dans des arbres « shadow » que
        // document.querySelectorAll ne voit pas : chargeurs et éléments sont cherchés dans chacun.
        let count = 0;
        let loading = false;
        const roots: (Document | ShadowRoot)[] = [document];
        while (roots.length > 0 && !loading) {
          const root = roots.pop() as Document | ShadowRoot;
          const all = root.querySelectorAll('*');
          count += all.length;
          if (Array.from(root.querySelectorAll(busy)).some(visible)) loading = true;
          for (const element of Array.from(all)) if (element.shadowRoot) roots.push(element.shadowRoot);
        }
        if (loading) {
          holder.__qaReady = undefined;
          return false;
        }
        const now = Date.now();
        if (holder.__qaReady?.count !== count) {
          holder.__qaReady = { count, since: now };
          return false;
        }
        return now - holder.__qaReady.since >= quietMs;
      },
      { busy: BUSY_SELECTOR, quietMs: QUIET_MS },
      { timeout: timeoutMs, polling: 50 },
    )
    .catch(() => undefined);
}
