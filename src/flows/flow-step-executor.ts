import type { Locator, Page } from 'playwright';
import { clickRobust } from '../execution/robust-click.js';
import { setCheckedRobust } from '../execution/checkable.js';
import { describeTarget, type FlowExpectation, type FlowTarget } from '../config/flow-schema.js';
import { toLocator } from '../execution/locator-resolver.js';
import {
  describeRow,
  goToPage,
  ROW_ATTRIBUTE,
  scanTableRows,
  waitForRowsChange,
} from './table-row-resolver.js';
import type { NetworkExchange } from '../model/network.js';
import { waitForScreenReady } from '../observation/screen-ready.js';
import { pathPatternToRegex } from '../policies/navigation-policy.js';
import {
  dropMembershipExpression,
  semanticScanExpression,
  type DropMembership,
  type SemanticScanResult,
  type SemanticTargetSpec,
} from '../recording/semantic-dom.js';
import type { DropZone } from '../config/flow-schema.js';

/**
 * Le résultat d'un glisser-déposer : MOVED (ITEM_MOVED observé), NOT_MOVED (Playwright a glissé,
 * l'élément n'a pas changé de zone : ACTION_EFFECT_MISMATCH), ou la cible introuvable / ambiguë.
 */
export interface DragOutcome {
  status: 'MOVED' | 'NOT_MOVED' | 'ITEM_NOT_FOUND' | 'DESTINATION_NOT_FOUND' | 'AMBIGUOUS_TARGET' | 'FAILED';
  reason: string;
  /** Comment le glisser a été joué : HTML5 (draggable) ou une suite d'événements pointeur. */
  mode?: 'HTML5' | 'POINTER';
  membership?: DropMembership;
  evidence: string[];
}

const FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton']);
let contextualTokens = 0;
let rowTokens = 0;

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

  /** Journal de débogage (QA_DEBUG / logging.level DEBUG) : chaque décision de clic, expliquée. */
  debug: ((line: string) => void) | undefined;

  /**
   * L'élément, une fois visible ; un message d'erreur sinon. Avec `nth`, cette
   * correspondance ; sans lui, la première correspondance visible dans une fenêtre
   * ouverte s'il y en a une (ce que l'utilisateur voit au-dessus : la page derrière
   * une fenêtre modale ne peut pas être cliquée), sinon la première correspondance.
   */
  async locate(
    page: Page,
    target: FlowTarget,
    timeoutMs: number,
    /**
     * NEVER BLINDLY EXECUTE AN AMBIGUOUS LOCATOR : un CSS qui désigne plusieurs éléments visibles (hors
     * d'une fenêtre ouverte qui les départage) est refusé — jamais « le premier ». Sans `strict`, le
     * comportement historique (l'appelant départage lui-même, par l'empreinte et le contexte).
     */
    /**
     * paginate : l'EXÉCUTION de l'étape peut parcourir les pages d'un tableau pour trouver la ligne ;
     * toute autre recherche (sonde, vérification, récupération) ne lit que la page affichée.
     */
    options: { strict?: boolean; paginate?: boolean } = {},
  ): Promise<Locator | string> {
    if (target.row !== undefined) return this.locateInRow(page, target, timeoutMs, options.paginate !== true);
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
        const picked = await base.evaluateAll((elements) => {
          const MODAL =
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';
          const shown = (el: Element): boolean => {
            const rect = el.getBoundingClientRect();
            return (rect.width > 0 || rect.height > 0) && getComputedStyle(el).visibility !== 'hidden';
          };
          const visible = elements.filter(shown).length;
          const modal = elements.filter((el) => el.closest(MODAL) !== null && shown(el));
          const inModal = modal[0] ? elements.indexOf(modal[0]) : -1;
          return { index: inModal >= 0 ? inModal : 0, visible, inModal: modal.length };
        });
        index = picked.index;
        // Plusieurs éléments visibles, et pas exactement un dans la fenêtre ouverte : rien de choisi.
        if (options.strict && target.strategy === 'css' && picked.visible > 1 && picked.inModal !== 1)
          return `AMBIGUOUS_TARGET: AMBIGUOUS_LOCATOR — ${String(picked.visible)} visible elements match css "${target.value ?? ''}" (never the first one; nothing executed)`;
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

  /** Le nombre maximal de pages d'un tableau parcourues pour trouver une ligne. */
  static readonly MAX_TABLE_PAGES = 20;

  /**
   * TABLE ROW : la ligne est trouvée par ses valeurs (colonne → valeur), sur la page courante puis les
   * suivantes ; la cible est cherchée DANS cette ligne. Jamais une position ; plusieurs lignes avec
   * `unique` → AMBIGUOUS_ROW, rien n'est exécuté.
   */
  /**
   * readOnly : une sonde (la cible suivante est-elle prête ?) ne pagine jamais le tableau — seule
   * l'exécution de l'étape agit sur la page.
   */
  private async locateInRow(
    page: Page,
    target: FlowTarget,
    timeoutMs: number,
    readOnly = false,
  ): Promise<Locator | string> {
    const criteria = target.row ?? {};
    const pick = target.rowPick ?? 'unique';
    rowTokens += 1;
    const token = `row-${String(rowTokens)}`;
    const deadline = Date.now() + timeoutMs;
    let scan = await scanTableRows(page, criteria, pick, token);
    // Le tableau arrive (requête en cours) : réessayer jusqu'au délai avant de parcourir les pages.
    while (scan.status === 'NONE' && scan.rows === 0 && Date.now() < deadline) {
      await page.waitForTimeout(150);
      scan = await scanTableRows(page, criteria, pick, token);
    }
    let pages = 1;
    let read = scan.status === 'NONE' ? scan.rows : 0;
    if (scan.status === 'NONE' && scan.missingColumns.length === 0 && !readOnly) {
      // La pagination du tableau, dans le cadre qui le porte (page, ou iframe d'un shell).
      const pager = scan.tableFrame ?? page;
      // Repartir de la première page (une étape précédente a pu paginer), puis avancer page par page.
      const before = scan.signature;
      if (await goToPage(pager, 'first')) {
        await waitForRowsChange(pager, before, Math.min(timeoutMs, 5000));
        scan = await scanTableRows(page, criteria, pick, token);
        read = scan.status === 'NONE' ? scan.rows : 0;
      }
      while (scan.status === 'NONE' && pages < FlowStepExecutor.MAX_TABLE_PAGES) {
        const signature = scan.signature;
        if (!(await goToPage(pager, 'next'))) break;
        pages += 1;
        await waitForRowsChange(pager, signature, Math.min(timeoutMs, 5000));
        scan = await scanTableRows(page, criteria, pick, token);
        if (scan.status === 'NONE') read += scan.rows;
      }
    }
    const wanted = describeRow(criteria);
    if (scan.status === 'AMBIGUOUS')
      return `AMBIGUOUS_TARGET: AMBIGUOUS_ROW — ${String(scan.matches)} rows match {${wanted}} (rowPick: unique; add a column to the row criteria, or rowPick: first) — nothing executed`;
    if (scan.status === 'NONE')
      return scan.missingColumns.length > 0
        ? scan.tables === 0
          ? `ROW_NOT_FOUND: no table on the screen (document, shadow roots and frames read) — the table never appeared within ${String(timeoutMs)} ms`
          : `ROW_NOT_FOUND: no table column "${scan.missingColumns.join('", "')}" (columns: ${scan.columns.join(', ') || 'none'})`
        : `ROW_NOT_FOUND: no row matches {${wanted}} (${String(read)} row(s) read on ${String(pages)} page(s))`;
    // La ligne marquée, dans SON cadre (un shell de micro-frontends peut charger le tableau dans une iframe).
    const scope = (scan.frame ?? page).locator(`[${ROW_ATTRIBUTE}="${scan.token}"]`);
    const inside = toLocator(scope, {
      strategy: target.strategy,
      ...(target.role !== undefined ? { role: target.role } : {}),
      ...(target.name !== undefined ? { name: target.name } : {}),
      ...(target.value !== undefined ? { value: target.value } : {}),
      ...(target.exact !== undefined ? { exact: target.exact } : {}),
    });
    const locator = inside.nth(target.nth ?? 0);
    try {
      await locator.waitFor({ state: 'visible', timeout: Math.max(500, deadline - Date.now()) });
      return locator;
    } catch {
      return `element not found in the row {${wanted}}: ${describeTarget({ ...target, row: undefined })}`;
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

  /** Une résolution contextuelle (libellé + section), attendue au plus `timeoutMs`. */
  private async scan(
    page: Page,
    spec: SemanticTargetSpec,
    timeoutMs: number,
  ): Promise<SemanticScanResult | undefined> {
    const deadline = Date.now() + timeoutMs;
    let result: SemanticScanResult | undefined;
    for (;;) {
      result = (await page.evaluate(semanticScanExpression(spec)).catch(() => undefined)) as
        SemanticScanResult | undefined;
      if (result?.status === 'RESOLVED' || result?.status === 'AMBIGUOUS' || Date.now() >= deadline)
        return result;
      await page.waitForTimeout(Math.min(150, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * DRAG_AND_DROP : l'élément (par son texte, dans sa zone d'origine) glissé vers la zone de
   * destination (par sa section / son libellé). L'action n'est réussie que si l'élément est
   * ENSUITE dans la destination et plus dans la source (ITEM_MOVED) — sinon NOT_MOVED.
   */
  async dragAndDrop(
    page: Page,
    step: { item: string; from?: DropZone; to: DropZone },
    timeoutMs: number,
    effectTimeoutMs: number,
  ): Promise<DragOutcome> {
    contextualTokens += 1;
    const token = `drag-${String(contextualTokens)}`;
    const evidence: string[] = [];
    const item = await this.scan(
      page,
      {
        kind: 'item',
        label: step.item,
        ...(step.from?.section ? { section: step.from.section } : {}),
        token: `${token}-item`,
      },
      timeoutMs,
    );
    if (item?.status === 'AMBIGUOUS')
      return {
        status: 'AMBIGUOUS_TARGET',
        reason: `AMBIGUOUS_TARGET: ${String(item.candidates.length)} items "${step.item}"${step.from?.section ? ` in "${step.from.section}"` : ''}`,
        evidence,
      };
    if (item?.status !== 'RESOLVED')
      return {
        status: 'ITEM_NOT_FOUND',
        reason: `item "${step.item}" not found${step.from?.section ? ` in section "${step.from.section}"` : ''}`,
        evidence,
      };
    evidence.push(`item "${step.item}" found in "${item.chosen?.section ?? '?'}"`);
    const source = page.locator(`[data-qa-crawler-target="${token}-item"]`).first();
    // La zone d'origine est marquée AVANT de chercher la destination (le marquage de la destination remplace celui de l'élément).
    await source
      .evaluate((el, value) => {
        const CONTAINER =
          '[cdkdroplist], .cdk-drop-list, [role="list"], [role="listbox"], [role="tree"], ul, ol, [aria-dropeffect], [data-drop-zone], tbody';
        const zone = el.parentElement?.closest(CONTAINER);
        if (zone) zone.setAttribute('data-qa-crawler-source', value);
        el.setAttribute('data-qa-crawler-dragged', value);
      }, token)
      .catch(() => undefined);
    const draggable = await source.getAttribute('draggable').catch(() => null);
    const destination = await this.scan(
      page,
      {
        kind: 'container',
        ...(step.to.label ? { label: step.to.label } : {}),
        ...(step.to.section ? { section: step.to.section } : {}),
        token: `${token}-to`,
      },
      timeoutMs,
    );
    const zone = describeZone(step.to);
    if (destination?.status === 'AMBIGUOUS')
      return {
        status: 'AMBIGUOUS_TARGET',
        reason: `AMBIGUOUS_TARGET: ${String(destination.candidates.length)} drop zones ${zone}`,
        evidence,
      };
    if (destination?.status !== 'RESOLVED')
      return { status: 'DESTINATION_NOT_FOUND', reason: `drop zone ${zone} not found`, evidence };
    evidence.push(`drop zone ${zone} found (${destination.chosen?.reasons.join(', ') ?? ''})`);
    const item2 = page.locator(`[data-qa-crawler-dragged="${token}"]`).first();
    const target = page.locator(`[data-qa-crawler-target="${token}-to"]`).first();
    const mode = draggable === 'true' ? 'HTML5' : 'POINTER';
    try {
      if (mode === 'HTML5') await item2.dragTo(target, { timeout: timeoutMs });
      else {
        // Pointeur (CDK, implémentations maison) : appuyer, dépasser le seuil, glisser par étapes, relâcher.
        await item2.scrollIntoViewIfNeeded({ timeout: timeoutMs });
        const from = await item2.boundingBox({ timeout: timeoutMs });
        const to = await target.boundingBox({ timeout: timeoutMs });
        if (!from || !to)
          return { status: 'FAILED', reason: 'drag source or drop zone has no box', mode, evidence };
        const startX = from.x + from.width / 2;
        const startY = from.y + from.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 8, startY + 8, { steps: 4 });
        await page.mouse.move(
          to.x + to.width / 2,
          to.y + Math.min(to.height - 4, Math.max(4, to.height / 2)),
          { steps: 12 },
        );
        await page.mouse.up();
      }
    } catch (error) {
      return { status: 'FAILED', reason: `drag failed: ${firstLine(error)}`, mode, evidence };
    }
    // L'EFFET : l'élément a-t-il changé de zone ? (une application peut déplacer après un délai)
    const deadline = Date.now() + effectTimeoutMs;
    let membership: DropMembership | undefined;
    for (;;) {
      membership = (await page
        .evaluate(dropMembershipExpression({ item: step.item, destination: `${token}-to`, source: token }))
        .catch(() => undefined)) as DropMembership | undefined;
      if ((membership?.inDestination && !membership.inSource) || Date.now() >= deadline) break;
      await page.waitForTimeout(100);
    }
    await page
      .evaluate((value) => {
        for (const el of Array.from(
          document.querySelectorAll(
            `[data-qa-crawler-source="${value}"], [data-qa-crawler-dragged="${value}"]`,
          ),
        )) {
          el.removeAttribute('data-qa-crawler-source');
          el.removeAttribute('data-qa-crawler-dragged');
        }
      }, token)
      .catch(() => undefined);
    if (membership?.inDestination && !membership.inSource)
      return {
        status: 'MOVED',
        reason: `ITEM_MOVED: "${step.item}" is now in ${zone}`,
        mode,
        membership,
        evidence: [...evidence, `"${step.item}" in ${zone}`],
      };
    return {
      status: 'NOT_MOVED',
      reason: `ACTION_EFFECT_MISMATCH: the drag was executed but "${step.item}" ${membership?.inDestination ? 'is still in its source zone' : `is not in ${zone}`}`,
      mode,
      ...(membership ? { membership } : {}),
      evidence,
    };
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
    /** false : la synchronisation des transitions (UITransitionWaiter) prend le relais — aucun sommeil fixe. */
    settle = true,
  ): Promise<string | undefined> {
    try {
      switch (action.kind) {
        case 'click':
          // Le contrôle de la cible posé sur elle (radio natif sur son libellé) n'est jamais un obstacle.
          await clickRobust(locator, timeoutMs, this.debug);
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
      if (settle) await this.settle(page, timeoutMs, action.kind === 'click');
      else
        await page
          .waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 5000) })
          .catch(() => undefined);
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
    // Une liste déjà ouverte (aria-expanded) n'est pas recliquée : ce clic la refermerait.
    if ((await locator.getAttribute('aria-expanded').catch(() => null)) !== 'true')
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

function describeZone(zone: DropZone): string {
  if (zone.label && zone.section) return `"${zone.label}" (${zone.section})`;
  return `"${zone.label ?? zone.section ?? ''}"`;
}
