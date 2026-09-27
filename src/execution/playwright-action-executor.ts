import type { Locator, Page } from 'playwright';
import type { FormFillPlan } from '../forms/form-model.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import { setCheckedRobust } from './checkable.js';
import type { LocatorDescriptor } from '../model/locator.js';
import { toLocator } from './locator-resolver.js';

/** Valeur à saisir/choisir pour les actions fill et select. */
export interface ExecutionInput {
  value?: string;
}

export interface ActionExecutionResult {
  status: 'SUCCESS' | 'FAILED';
  error?: string;
  urlBefore: string;
  urlAfter: string;
  durationMs: number;
  /** Le localisateur préféré n'a rien trouvé ; le CSS de repli a été utilisé. */
  usedFallback: boolean;
  /** L'élément a ouvert une nouvelle fenêtre (gérée par le BrowserInteractionManager). */
  openedPopup: boolean;
}

/**
 * « Exécute. » Traduit l'action choisie en appels Playwright
 * (getByRole(...).click(), fill, selectOption, setChecked) et attend que la
 * page se stabilise. Aucune logique de décision ni règle de sécurité ici : il n'est
 * appelé qu'avec une action que la SafetyPolicy a permise.
 */
export class PlaywrightActionExecutor {
  constructor(
    private readonly actionTimeoutMs: number,
    private readonly settleTimeMs: number,
  ) {}

  async execute(
    page: Page,
    action: DiscoveredAction,
    input: ExecutionInput = {},
  ): Promise<ActionExecutionResult> {
    const started = Date.now();
    const urlBefore = page.url();
    const result = (
      status: 'SUCCESS' | 'FAILED',
      extra: Partial<ActionExecutionResult> = {},
    ): ActionExecutionResult => ({
      status,
      urlBefore,
      urlAfter: page.isClosed() ? urlBefore : page.url(),
      durationMs: Date.now() - started,
      usedFallback: false,
      openedPopup: false,
      ...extra,
    });

    let target: { locator: Locator; usedFallback: boolean } | undefined;
    try {
      target = await this.resolve(page, action);
    } catch (error) {
      return result('FAILED', { error: `locator error: ${firstLine(error)}` });
    }
    if (!target) return result('FAILED', { error: 'element not found on the page' });

    const timeout = this.actionTimeoutMs;
    let openedPopup = false;
    try {
      switch (action.type) {
        case 'click':
        case 'navigate': {
          let opened: Page | undefined;
          const onPopup = (popup: Page): void => {
            opened = popup;
          };
          page.on('popup', onPopup);
          try {
            await this.click(target.locator, timeout);
            await this.settle(page);
          } finally {
            page.off('popup', onPopup);
          }
          if (opened) {
            openedPopup = true;
            // La nouvelle fenêtre elle-même est gérée par le BrowserInteractionManager (enregistrée, observée, fermée).
            // Un lien qui ouvre une nouvelle fenêtre : atteindre aussi sa cible dans la page courante.
            if (action.type === 'navigate' && action.href) {
              await page.goto(action.href, { timeout, waitUntil: 'domcontentloaded' });
            }
          }
          break;
        }
        case 'fill':
          await target.locator.fill(input.value ?? '', { timeout });
          break;
        case 'select':
          await this.select(page, target.locator, input.value, timeout);
          break;
        case 'check':
        case 'uncheck':
          // Cases et radios stylées ou pilotées par un framework : libellé, relecture différée, clic forcé.
          await setCheckedRobust(target.locator, action.type === 'check', timeout);
          break;
      }
      await this.settle(page);
      return result('SUCCESS', { usedFallback: target.usedFallback, openedPopup });
    } catch (error) {
      await this.settle(page).catch(() => undefined);
      return result('FAILED', { error: firstLine(error), usedFallback: target.usedFallback, openedPopup });
    }
  }

  /**
   * Exécute un plan de remplissage (FormFillStrategy) : chaque opération sur
   * l'élément du champ, puis le champ est quitté comme le ferait un utilisateur (blur),
   * pour que l'application le valide maintenant et pas au milieu du clic suivant.
   */
  async executePlan(
    page: Page,
    plan: FormFillPlan,
    actionOf: (fieldId: string) => DiscoveredAction | undefined,
  ): Promise<PlanOperationResult[]> {
    const results: PlanOperationResult[] = [];
    for (const operation of plan.operations) {
      if (operation.operation === 'skip') continue;
      const action = actionOf(operation.fieldId);
      if (!action) {
        results.push({ fieldId: operation.fieldId, status: 'FAILED', error: 'field no longer on the page' });
        continue;
      }
      const executed = await this.execute(
        page,
        { ...action, type: operation.operation },
        operation.value !== undefined ? { value: operation.value } : {},
      );
      if (operation.operation === 'fill' || operation.operation === 'select') {
        await page
          .evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
          })
          .catch(() => undefined);
        await page.waitForTimeout(BLUR_SETTLE_MS).catch(() => undefined);
      }
      results.push({
        fieldId: operation.fieldId,
        status: executed.status,
        ...(executed.error ? { error: executed.error } : {}),
      });
    }
    return results;
  }

  /**
   * Clique, en échouant vite avec une raison claire quand un autre calque (le fond
   * d'un calendrier, une fenêtre modale…) prend le clic à la place de l'élément.
   */
  private async click(locator: Locator, timeout: number): Promise<void> {
    try {
      await locator.click({ trial: true, timeout: Math.min(timeout, TRIAL_CLICK_MS) });
    } catch (error) {
      const blocker = interceptor(error);
      if (blocker) throw new Error(`click intercepted by ${blocker}: another layer covers the element`);
      // Pas encore prêt (animation, chargement…) : le vrai clic ci-dessous l'attend.
    }
    await locator.click({ timeout });
  }

  /** <select> natif : selectOption ; liste personnalisée (Angular Material, combobox ARIA) : l'ouvrir, choisir l'option. */
  private async select(
    page: Page,
    locator: Locator,
    label: string | undefined,
    timeout: number,
  ): Promise<void> {
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await locator.selectOption(label ? { label } : { index: 0 }, { timeout });
      return;
    }
    await this.click(locator, timeout);
    const options = page.locator('[role="option"]:visible:not([aria-disabled="true"])');
    await options.first().waitFor({ state: 'visible', timeout });
    if (label) {
      await page.getByRole('option', { name: label }).first().click({ timeout });
    } else {
      // La première vraie option : les options d'invite (« -- », « Choisir… ») sont sautées.
      const texts = await options.allInnerTexts();
      const index = texts.findIndex((text) => text.trim() !== '' && !PLACEHOLDER_OPTION.test(text.trim()));
      await options.nth(Math.max(index, 0)).click({ timeout });
    }
    // Une liste à choix multiples reste ouverte : la fermer.
    if (
      await options
        .first()
        .isVisible()
        .catch(() => false)
    )
      await page.keyboard.press('Escape');
  }

  /** Localisateur préféré, sinon le CSS de repli ; `nth` appliqué quand plusieurs éléments correspondent. */
  private async resolve(
    page: Page,
    action: DiscoveredAction,
  ): Promise<{ locator: Locator; usedFallback: boolean } | undefined> {
    const attempts: [LocatorDescriptor, boolean][] = [[action.locator, false]];
    if (action.fallback) attempts.push([action.fallback, true]);
    for (const [descriptor, usedFallback] of attempts) {
      const base = toLocator(page, descriptor);
      const count = await base.count();
      if (count === 0) continue;
      const index = Math.min(descriptor.nth ?? 0, count - 1);
      return { locator: count === 1 ? base : base.nth(index), usedFallback };
    }
    return undefined;
  }

  private async settle(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page.waitForLoadState('domcontentloaded', { timeout: this.actionTimeoutMs }).catch(() => undefined);
    if (this.settleTimeMs > 0) await page.waitForTimeout(this.settleTimeMs).catch(() => undefined);
  }
}

/** Temps laissé à l'application pour afficher le message d'erreur d'un champ une fois quitté. */
const BLUR_SETTLE_MS = 100;

export interface PlanOperationResult {
  fieldId: string;
  status: 'SUCCESS' | 'FAILED';
  error?: string;
}

/** Temps laissé à un clic avant de signaler qu'un autre calque le prend. */
const TRIAL_CLICK_MS = 2500;
const PLACEHOLDER_OPTION = /^(-+|choisir|select|choose|aucun|none)/i;

/** L'élément qui a pris le clic à la place de la cible, d'après le journal d'appels de Playwright. */
export function interceptor(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /(<[^\n]*?>)(?: from <[^\n]*?> subtree)? intercepts pointer events/.exec(message);
  if (!match?.[1]) return undefined;
  const element = match[1];
  return element.length > 90 ? `${element.slice(0, 87)}…>` : element;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).trim();
}
