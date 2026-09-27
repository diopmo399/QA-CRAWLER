import type { Locator } from 'playwright';

/** Temps laissé à un simple check avant les solutions de repli. */
const QUICK_CHECK_MS = 3000;
/** Temps laissé à l'application pour mettre à jour l'état (composants contrôlés, animations). */
const STATE_SETTLE_MS = 150;

/**
 * Coche ou décoche une case / une radio, y compris stylée ou pilotée par un framework :
 *
 * 1. le check normal de Playwright ;
 * 2. l'application met parfois l'état à jour un peu plus tard (composant contrôlé) :
 *    on relit l'état après un court délai ;
 * 3. clic sur le libellé ou l'enveloppe de l'option (mat-radio-button, [role=radio]…),
 *    comme le ferait un utilisateur quand le dessin recouvre l'input natif ;
 * 4. clic forcé sur l'élément, puis check forcé.
 *
 * L'état est vérifié après chaque essai ; l'erreur d'origine est levée si rien n'a marché.
 */
export async function setCheckedRobust(locator: Locator, checked: boolean, timeoutMs: number): Promise<void> {
  const done = async (): Promise<boolean> => (await locator.isChecked().catch(() => !checked)) === checked;
  const pause = (): Promise<void> => locator.page().waitForTimeout(STATE_SETTLE_MS);
  try {
    await locator.setChecked(checked, { timeout: Math.min(timeoutMs, QUICK_CHECK_MS) });
    return;
  } catch (error) {
    await pause();
    if (await done()) return;
    const viaLabel = await locator
      .evaluate((el) => {
        const wrapper =
          (el as HTMLInputElement).labels?.[0] ??
          el.closest(
            'label, mat-radio-button, mat-checkbox, [role="radio"], [role="checkbox"], [role="switch"]',
          );
        if (!wrapper || wrapper === el) return false;
        (wrapper as HTMLElement).click();
        return true;
      })
      .catch(() => false);
    if (viaLabel) {
      await pause();
      if (await done()) return;
    }
    await locator.click({ force: true, timeout: timeoutMs }).catch(() => undefined);
    await pause();
    if (await done()) return;
    await locator.setChecked(checked, { force: true, timeout: timeoutMs }).catch(() => undefined);
    await pause();
    if (await done()) return;
    throw error;
  }
}
