import type { Locator, Page } from 'playwright';
import type { FormFillPlan } from '../forms/form-model.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import { setCheckedRobust } from './checkable.js';
import { validityOf } from '../forms/validity.js';
import type { LocatorDescriptor } from '../model/locator.js';
import { toLocator } from './locator-resolver.js';
import { normalizeText } from '../policies/keywords.js';
import { classifyPlaywrightError, NavigationGuard } from '../navigation/navigation-guard.js';
import { waitForScreenReady } from '../observation/screen-ready.js';

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
  /**
   * L'action a navigué (nouveau document, redirection, envoi de formulaire, route
   * d'application monopage) : l'état, l'instantané et les actions d'avant sont périmés.
   */
  navigationOccurred?: boolean;
  /** Le document a changé pendant l'action (contexte d'exécution détruit, cadre remplacé). */
  contextChanged?: boolean;
  /**
   * L'erreur vient d'une navigation, pas de l'application : la page peut être relue.
   * Jamais une raison de rejouer l'action : elle a très probablement eu lieu.
   */
  recoverable?: boolean;
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
    /** Sait si une action a navigué ; partagé avec l'UIObserver. */
    private readonly navigation: NavigationGuard = new NavigationGuard(),
    /** Attente au plus que l'écran soit affiché (plus de roue de chargement, DOM stable). */
    private readonly readyTimeoutMs = 0,
  ) {}

  async execute(
    page: Page,
    action: DiscoveredAction,
    input: ExecutionInput = {},
  ): Promise<ActionExecutionResult> {
    const started = Date.now();
    const urlBefore = page.url();
    const mark = this.navigation.mark(page);
    const result = (
      status: 'SUCCESS' | 'FAILED',
      extra: Partial<ActionExecutionResult> = {},
      error?: unknown,
    ): ActionExecutionResult => {
      const outcome = this.navigation.outcome(page, mark, error);
      return {
        status,
        urlBefore,
        urlAfter: page.isClosed() ? urlBefore : page.url(),
        durationMs: Date.now() - started,
        usedFallback: false,
        openedPopup: false,
        navigationOccurred: outcome.navigationOccurred,
        contextChanged: outcome.contextChanged,
        ...extra,
      };
    };

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
            // Un clic peut changer d'écran : attendre qu'il soit affiché. Une saisie, non.
            await this.settle(page, true);
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
      const after = actionOutcomeAfterError(action.type, error);
      if (after === 'PERFORMED') {
        // Le clic a déclenché la navigation qui a détruit le document : l'action a eu lieu.
        // Attendre la nouvelle page ; l'explorateur l'observera. Jamais un second clic.
        await this.navigation.waitUntilUsable(page);
        return result(
          'SUCCESS',
          { usedFallback: target.usedFallback, openedPopup, recoverable: true },
          error,
        );
      }
      return result(
        'FAILED',
        {
          error: firstLine(error),
          usedFallback: target.usedFallback,
          openedPopup,
          ...(after === 'INTERRUPTED' ? { recoverable: true } : {}),
        },
        error,
      );
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
      // Champ à suggestions (autocomplete, Angular Material…) : taper ne suffit pas, choisir une suggestion.
      let chosen: string | undefined;
      if (executed.status === 'SUCCESS' && operation.operation === 'fill' && isAutocomplete(action))
        chosen = await this.pickSuggestion(page, action, operation.value ?? '');
      if (operation.operation === 'fill' || operation.operation === 'select') await this.leaveField(page);
      // Masques de saisie, champs à suggestions… : certains n'écoutent que les vraies frappes.
      // Toujours invalide (ou valeur perdue) après fill : retaper touche par touche.
      if (
        executed.status === 'SUCCESS' &&
        chosen === undefined &&
        operation.operation === 'fill' &&
        operation.value !== undefined &&
        operation.value !== ''
      )
        await this.retypeIfRejected(page, action, operation.value);
      results.push({
        fieldId: operation.fieldId,
        status: executed.status,
        ...(executed.error ? { error: executed.error } : {}),
        ...(chosen !== undefined ? { suggestion: chosen } : {}),
      });
    }
    return results;
  }

  /**
   * Champ à suggestions : après la saisie, attendre la liste, puis cliquer la suggestion
   * qui correspond à la valeur (sinon la première). Sans liste, la valeur est retapée
   * touche par touche (certains champs ne filtrent qu'au clavier), puis on réessaie.
   * Renvoie le texte de la suggestion choisie, ou undefined s'il n'y en avait aucune.
   */
  private async pickSuggestion(
    page: Page,
    action: DiscoveredAction,
    value: string,
  ): Promise<string | undefined> {
    const target = await this.resolve(page, action).catch(() => undefined);
    if (!target) return undefined;
    const { locator } = target;
    const listId = await locator
      .evaluate((el) => el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns') ?? '')
      .catch(() => '');
    const options = (): Locator =>
      listId
        ? page.locator(
            `[id="${listId.replace(/"/g, '')}"] [role="option"], [id="${listId.replace(/"/g, '')}"] mat-option`,
          )
        : page.locator('[role="listbox"] [role="option"], mat-option, .mat-mdc-option, [role="option"]');
    const visible = async (): Promise<Locator | undefined> => {
      const list = options().filter({ visible: true });
      try {
        await list.first().waitFor({ state: 'visible', timeout: SUGGESTION_WAIT_MS });
        return list;
      } catch {
        return undefined;
      }
    };
    let list = await visible();
    if (!list && value) {
      await locator.press('ControlOrMeta+a').catch(() => undefined);
      await locator.press('Backspace').catch(() => undefined);
      await locator
        .pressSequentially(value, { delay: TYPING_DELAY_MS, timeout: 5000 })
        .catch(() => undefined);
      list = await visible();
    }
    if (!list) {
      // La valeur ne correspond à aucune suggestion : champ vidé, liste ouverte au clavier (↓), première suggestion.
      await locator.fill('', { timeout: 2000 }).catch(() => undefined);
      await locator.press('ArrowDown').catch(() => undefined);
      list = await visible();
    }
    if (!list) return undefined;
    const texts = (await list.allInnerTexts().catch(() => [])).map((text) => text.trim());
    const wanted = normalizeText(value);
    const enabled = async (index: number): Promise<boolean> =>
      (await list
        .nth(index)
        .getAttribute('aria-disabled')
        .catch(() => null)) !== 'true';
    let index = texts.findIndex((text) => wanted !== '' && normalizeText(text).includes(wanted));
    if (index < 0 || !(await enabled(index))) {
      index = -1;
      for (let candidate = 0; candidate < texts.length; candidate++)
        if (texts[candidate] && (await enabled(candidate))) {
          index = candidate;
          break;
        }
    }
    if (index < 0) return undefined;
    const clicked = await list
      .nth(index)
      .click({ timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    return clicked ? (texts[index] ?? '') : undefined;
  }

  /** Quitte le champ comme un utilisateur (blur), pour que l'application le valide maintenant. */
  private async leaveField(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      })
      .catch(() => undefined);
    await page.waitForTimeout(BLUR_SETTLE_MS).catch(() => undefined);
  }

  /**
   * `fill` pose la valeur d'un coup, sans événements clavier : un masque de saisie
   * (ngx-mask…) ou un champ à suggestions peut l'ignorer et rester vide ou invalide.
   * Dans ce cas seulement, le champ est vidé puis retapé touche par touche.
   */
  private async retypeIfRejected(page: Page, action: DiscoveredAction, value: string): Promise<void> {
    const target = await this.resolve(page, action).catch(() => undefined);
    if (!target) return;
    const { locator } = target;
    const current = await locator.inputValue({ timeout: 1000 }).catch(() => undefined);
    const validity = await validityOf(locator);
    if (current === value && !validity?.invalid) return;
    await locator.click({ timeout: 2000 }).catch(() => undefined);
    await locator.press('ControlOrMeta+a').catch(() => undefined);
    await locator.press('Backspace').catch(() => undefined);
    await locator.pressSequentially(value, { delay: TYPING_DELAY_MS, timeout: 5000 }).catch(() => undefined);
    await this.leaveField(page);
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
    // Une liste déjà ouverte (aria-expanded) n'est pas recliquée : ce clic la refermerait.
    if ((await locator.getAttribute('aria-expanded').catch(() => null)) !== 'true')
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

  private async settle(page: Page, untilReady = false): Promise<void> {
    if (page.isClosed()) return;
    await page.waitForLoadState('domcontentloaded', { timeout: this.actionTimeoutMs }).catch(() => undefined);
    if (this.settleTimeMs > 0) await page.waitForTimeout(this.settleTimeMs).catch(() => undefined);
    if (untilReady) await waitForScreenReady(page, this.readyTimeoutMs);
  }
}

/** Temps laissé à l'application pour afficher le message d'erreur d'un champ une fois quitté. */
const BLUR_SETTLE_MS = 100;
/** Délai entre deux frappes quand un champ doit être tapé touche par touche. */
const TYPING_DELAY_MS = 30;
/** Temps laissé à une liste de suggestions pour apparaître. */
const SUGGESTION_WAIT_MS = 1500;

export interface PlanOperationResult {
  fieldId: string;
  status: 'SUCCESS' | 'FAILED';
  error?: string;
  /** Suggestion choisie dans un champ à suggestions (autocomplete). */
  suggestion?: string;
}

/** Un champ où l'on tape et qui propose des suggestions (role combobox, aria-autocomplete, matAutocomplete). */
export function isAutocomplete(action: DiscoveredAction): boolean {
  return (
    (action.type === 'fill' || action.type === 'select') &&
    action.role === 'combobox' &&
    !action.field?.customSelect
  );
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

/**
 * Ce que veut dire une erreur Playwright pendant une action :
 * - PERFORMED : un clic (ou un lien) interrompu par une navigation ; c'est lui qui l'a
 *   déclenchée, l'action a eu lieu : on observe la nouvelle page, on ne reclique pas ;
 * - INTERRUPTED : une saisie ou un choix dont le champ a disparu avec le document : échec
 *   récupérable (la page est relue), jamais rejoué automatiquement ;
 * - FAILED : une vraie erreur.
 */
export function actionOutcomeAfterError(
  type: DiscoveredAction['type'],
  error: unknown,
): 'PERFORMED' | 'INTERRUPTED' | 'FAILED' {
  if (!classifyPlaywrightError(error).navigation) return 'FAILED';
  return type === 'click' || type === 'navigate' ? 'PERFORMED' : 'INTERRUPTED';
}
