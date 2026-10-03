import type { Locator, Page } from 'playwright';
import { setCheckedRobust } from '../execution/checkable.js';
import type { FlowExpectation, FlowTarget } from '../config/flow-schema.js';
import { toLocator } from '../execution/locator-resolver.js';
import type { NetworkExchange } from '../model/network.js';
import { waitForScreenReady } from '../observation/screen-ready.js';
import { pathPatternToRegex } from '../policies/navigation-policy.js';
import { semanticScanExpression, type SemanticScanResult } from '../recording/semantic-dom.js';

const FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton']);
let contextualTokens = 0;

/**
 * Messages d'erreur visibles : les mêmes que ceux que l'UIObserver associe aux champs
 * (dom-snapshot.ts), plus les alertes ARIA et les notifications d'erreur courantes.
 */
const ERROR_MESSAGE_SELECTOR = [
  'mat-error',
  '.mat-mdc-form-field-error',
  '.mat-error',
  '.invalid-feedback',
  '.error-message',
  '.field-error',
  '[role="alert"]',
  '.alert-danger',
  '.toast-error',
  '.mat-mdc-snack-bar-container.error',
].join(', ');

/** Attribut posé sur l'élément ciblé pour que l'UIObserver le reconnaisse (voir dom-snapshot.ts). */
export const FLOW_TARGET_ATTRIBUTE = 'data-qa-flow-target';

export type FlowElementAction =
  | { kind: 'click' | 'check' | 'uncheck' }
  | { kind: 'fill'; value: string }
  | { kind: 'select'; option: string };

/**
 * Côté Playwright des étapes de flow imposé : trouve l'élément désigné par le YAML,
 * exécute l'étape et vérifie les attentes. Comme le PlaywrightActionExecutor, il ne
 * contient aucune règle de sécurité : l'explorateur n'appelle `perform` qu'une fois
 * l'étape permise par la SafetyPolicy.
 */
export class FlowStepExecutor {
  constructor(
    private readonly settleTimeMs: number,
    /** Attente au plus que l'écran soit affiché (plus de roue de chargement, DOM stable). */
    private readonly readyTimeoutMs = 0,
  ) {}

  /**
   * L'élément, une fois visible ; un message d'erreur sinon. Avec `nth`, cette
   * correspondance ; sans lui, la première correspondance visible dans une fenêtre
   * ouverte s'il y en a une (ce que l'utilisateur voit au-dessus : la page derrière
   * une fenêtre modale ne peut pas être cliquée), sinon la première correspondance.
   */
  async locate(page: Page, target: FlowTarget, timeoutMs: number): Promise<Locator | string> {
    if (
      target.section !== undefined &&
      target.nth === undefined &&
      target.strategy !== 'css' &&
      target.strategy !== 'testId'
    )
      return this.locateInSection(page, target, timeoutMs);
    const base = toLocator(page, {
      strategy: target.strategy,
      ...(target.role !== undefined ? { role: target.role } : {}),
      ...(target.name !== undefined ? { name: target.name } : {}),
      ...(target.value !== undefined ? { value: target.value } : {}),
      ...(target.exact !== undefined ? { exact: target.exact } : {}),
    });
    try {
      let index = target.nth ?? 0;
      if (target.nth === undefined) {
        await base.first().waitFor({ state: 'attached', timeout: timeoutMs });
        index = await base.evaluateAll((elements) => {
          const MODAL =
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';
          const inModal = elements.findIndex((el) => {
            const rect = el.getBoundingClientRect();
            return el.closest(MODAL) !== null && (rect.width > 0 || rect.height > 0);
          });
          return inModal >= 0 ? inModal : 0;
        });
      }
      const locator = base.nth(index);
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return locator;
    } catch (error) {
      const count = await base.count().catch(() => 0);
      return count === 0
        ? `element not found within ${timeoutMs} ms`
        : `element not visible within ${timeoutMs} ms (${count} match(es)): ${firstLine(error)}`;
    }
  }

  /** La dernière résolution contextuelle (candidats, scores, raisons) : pour le rapport. */
  lastContextualResolution: (SemanticScanResult & { section: string; label: string }) | undefined;

  /**
   * CONTEXTUAL TARGET RESOLVER : une cible avec une section est cherchée PAR SON IDENTITÉ
   * (libellé, rôle, section), jamais par position. Un candidat d'une autre section est exclu ;
   * deux candidats aussi proches → AMBIGUOUS_TARGET (jamais le premier du DOM au hasard).
   */
  private async locateInSection(
    page: Page,
    target: FlowTarget,
    timeoutMs: number,
  ): Promise<Locator | string> {
    const label = target.strategy === 'role' ? (target.name ?? '') : (target.value ?? '');
    const section = target.section ?? '';
    const kind =
      target.strategy === 'label' || (target.strategy === 'role' && FIELD_ROLES.has(target.role ?? ''))
        ? 'field'
        : 'control';
    contextualTokens += 1;
    const token = `ctx-${String(contextualTokens)}`;
    const deadline = Date.now() + timeoutMs;
    let result: SemanticScanResult | undefined;
    for (;;) {
      result = (await page
        .evaluate(
          semanticScanExpression({
            kind,
            label,
            ...(target.strategy === 'role' && target.role ? { role: target.role } : {}),
            section,
            token,
          }),
        )
        .catch(() => undefined)) as SemanticScanResult | undefined;
      if (result?.status === 'RESOLVED' || result?.status === 'AMBIGUOUS' || Date.now() >= deadline) break;
      await page.waitForTimeout(Math.min(150, Math.max(0, deadline - Date.now())));
    }
    this.lastContextualResolution = result ? { ...result, section, label } : undefined;
    if (result?.status === 'AMBIGUOUS')
      return `AMBIGUOUS_TARGET: ${String(result.candidates.length)} candidates for "${label}" in section "${section}" (${result.candidates
        .slice(0, 3)
        .map((candidate) => `${candidate.label} @ ${candidate.section || '?'} = ${String(candidate.score)}`)
        .join('; ')})`;
    if (result?.status !== 'RESOLVED')
      return `element "${label}" not found in section "${section}" within ${timeoutMs} ms`;
    return page.locator(`[data-qa-crawler-target="${token}"]`).first();
  }

  /**
   * Marque l'élément interactif qui va recevoir l'action (l'élément lui-même, ou le
   * lien/bouton qui le contient) pour la prochaine observation.
   */
  async mark(locator: Locator): Promise<void> {
    await locator.evaluate((el, attribute) => {
      const INTERACTIVE =
        'a[href], button, summary, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"], [routerlink], [onclick]';
      const NESTING = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
      let target: Element = el.closest(INTERACTIVE) ?? el;
      let outer = target.parentElement?.closest(NESTING);
      while (outer) {
        target = outer;
        outer = target.parentElement?.closest(NESTING);
      }
      target.setAttribute(attribute, 'true');
    }, FLOW_TARGET_ATTRIBUTE);
  }

  async unmark(page: Page): Promise<void> {
    await page
      .evaluate((attribute) => {
        for (const el of Array.from(document.querySelectorAll(`[${attribute}]`)))
          el.removeAttribute(attribute);
      }, FLOW_TARGET_ATTRIBUTE)
      .catch(() => undefined);
  }

  /** Exécute l'étape sur l'élément ; renvoie un message d'erreur en cas d'échec. */
  async perform(
    page: Page,
    locator: Locator,
    action: FlowElementAction,
    timeoutMs: number,
  ): Promise<string | undefined> {
    try {
      switch (action.kind) {
        case 'click':
          await locator.click({ timeout: timeoutMs });
          break;
        case 'check':
          await setCheckedRobust(locator, true, timeoutMs);
          break;
        case 'uncheck':
          await setCheckedRobust(locator, false, timeoutMs);
          break;
        case 'fill':
          await locator.fill(action.value, { timeout: timeoutMs });
          break;
        case 'select':
          await this.select(page, locator, action.option, timeoutMs);
          break;
      }
      // Un clic peut changer d'écran : attendre qu'il soit affiché. Une saisie, non.
      await this.settle(page, timeoutMs, action.kind === 'click');
      return undefined;
    } catch (error) {
      await this.settle(page, timeoutMs).catch(() => undefined);
      return firstLine(error);
    }
  }

  /** Attend que chaque attente soit satisfaite ; renvoie ce qui ne l'est pas. */
  async expect(
    page: Page,
    expectation: FlowExpectation,
    timeoutMs: number,
    network: readonly NetworkExchange[] = [],
  ): Promise<string | undefined> {
    const failures: string[] = [];
    if (expectation.response) {
      // Une réponse lente (l'envoi vient de partir) : l'attendre jusqu'au délai de l'étape.
      const deadline = Date.now() + timeoutMs;
      let failure = responseFailure(expectation.response, network);
      while (
        failure &&
        isPending(expectation.response, network) &&
        Date.now() < deadline &&
        !page.isClosed()
      ) {
        await page.waitForTimeout(200).catch(() => undefined);
        failure = responseFailure(expectation.response, network);
      }
      if (failure) failures.push(failure);
    }
    if (expectation.noError) {
      // Laisser le temps à un message d'erreur d'apparaître, sans attendre le délai complet.
      await page.waitForTimeout(Math.min(timeoutMs, 500)).catch(() => undefined);
      const shown = await page
        .locator(ERROR_MESSAGE_SELECTOR)
        .filter({ visible: true })
        .allInnerTexts()
        .catch(() => [] as string[]);
      const messages = shown.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (messages.length > 0)
        failures.push(
          `error message shown: ${messages
            .slice(0, 3)
            .map((text) => `"${text.slice(0, 120)}"`)
            .join(', ')}`,
        );
    }
    if (expectation.url !== undefined) {
      const expected = expectation.url;
      try {
        await page.waitForURL((url) => url.href.includes(expected), {
          timeout: timeoutMs,
          waitUntil: 'commit',
        });
      } catch {
        failures.push(`URL does not contain "${expected}" (${page.url()})`);
      }
    }
    if (expectation.text !== undefined) {
      try {
        await page.getByText(expectation.text).first().waitFor({ state: 'visible', timeout: timeoutMs });
      } catch {
        failures.push(`text "${expectation.text}" not visible`);
      }
    }
    if (expectation.visible) {
      const found = await this.locate(page, expectation.visible, timeoutMs);
      if (typeof found === 'string') failures.push(`expected element: ${found}`);
    }
    if (expectation.hidden) {
      const hidden = expectation.hidden;
      const base = toLocator(page, {
        strategy: hidden.strategy,
        ...(hidden.role !== undefined ? { role: hidden.role } : {}),
        ...(hidden.name !== undefined ? { name: hidden.name } : {}),
        ...(hidden.value !== undefined ? { value: hidden.value } : {}),
        ...(hidden.exact !== undefined ? { exact: hidden.exact } : {}),
      });
      try {
        await base.nth(hidden.nth ?? 0).waitFor({ state: 'hidden', timeout: timeoutMs });
      } catch {
        failures.push('element still visible');
      }
    }
    return failures.length > 0 ? failures.join('; ') : undefined;
  }

  /** <select> natif : selectOption ; listes personnalisées (Angular Material, combobox ARIA) : l'ouvrir, puis cliquer sur l'option. */
  private async select(page: Page, locator: Locator, option: string, timeoutMs: number): Promise<void> {
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await locator.selectOption({ label: option }, { timeout: timeoutMs });
      return;
    }
    await locator.click({ timeout: timeoutMs });
    await page.getByRole('option', { name: option }).first().click({ timeout: timeoutMs });
  }

  private async settle(page: Page, timeoutMs: number, untilReady = false): Promise<void> {
    if (page.isClosed()) return;
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
    if (this.settleTimeMs > 0) await page.waitForTimeout(this.settleTimeMs).catch(() => undefined);
    if (untilReady) await waitForScreenReady(page, this.readyTimeoutMs);
  }
}

/** La dernière requête qui correspond n'a pas encore de réponse (ni d'échec). */
function isPending(
  expected: NonNullable<FlowExpectation['response']>,
  network: readonly NetworkExchange[],
): boolean {
  const pattern = expected.url.includes('*') ? pathPatternToRegex(expected.url) : undefined;
  const last = network
    .filter((exchange) => {
      if (expected.method && exchange.method.toUpperCase() !== expected.method.toUpperCase()) return false;
      if (!pattern) return exchange.url.includes(expected.url);
      try {
        return pattern.test(new URL(exchange.url).pathname);
      } catch {
        return false;
      }
    })
    .at(-1);
  return last !== undefined && last.status === undefined && last.failure === undefined;
}

/**
 * La dernière requête du flow qui correspond (méthode, URL) a-t-elle le statut attendu ?
 * Renvoie la raison de l'échec, ou undefined.
 */
export function responseFailure(
  expected: NonNullable<FlowExpectation['response']>,
  network: readonly NetworkExchange[],
): string | undefined {
  const pattern = expected.url.includes('*') ? pathPatternToRegex(expected.url) : undefined;
  const matches = network.filter((exchange) => {
    if (expected.method && exchange.method.toUpperCase() !== expected.method.toUpperCase()) return false;
    if (!pattern) return exchange.url.includes(expected.url);
    try {
      return pattern.test(new URL(exchange.url).pathname);
    } catch {
      return false;
    }
  });
  const label = `${expected.method ? `${expected.method} ` : ''}"${expected.url}"`;
  const last = matches.at(-1);
  if (!last) {
    const seen = network
      .filter((exchange) => exchange.resourceType !== 'document')
      .slice(-5)
      .map((exchange) => `${exchange.method} ${pathOf(exchange.url)}`);
    return `no request ${label} seen during the flow${seen.length > 0 ? ` (last: ${seen.join(', ')})` : ''}`;
  }
  const status = last.status;
  const ok =
    status !== undefined &&
    (typeof expected.status === 'number'
      ? status === expected.status
      : Math.floor(status / 100) === Number(expected.status[0]));
  if (ok) return undefined;
  return `${label} answered ${status ?? last.failure ?? 'nothing'} (expected ${String(expected.status)})`;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).trim();
}
