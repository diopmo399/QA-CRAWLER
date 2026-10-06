import type { Locator, Page } from 'playwright';
import { BUSY_SELECTOR } from './screen-ready.js';

/**
 * SCREEN READINESS — « peut-on agir MAINTENANT sur cette cible ? », observé AVANT l'action.
 *
 * Principes :
 *  - ATTENDRE N'EST PAS JUGER. Un délai dépassé rend `status: 'TIMEOUT'` avec ses raisons ; l'appelant
 *    journalise et exécute l'action quand même (`proceed` vaut toujours true sauf page fermée). C'est
 *    l'action et la vérification de son effet qui décident d'un échec, jamais l'attente.
 *  - Un contrôle n'est pas « couvert » par SON PROPRE habillage : radio / case natifs cachés sous un div
 *    stylé, libellé associé, enveloppe Material / ARIA, élément décoratif dans le flux. Seul un vrai
 *    calque bloque : fenêtre modale qui ne contient pas la cible, fond (backdrop), chargeur, élément
 *    fixe / collant posé par-dessus.
 *  - Un écran qui bouge sans fin (horloge, carrousel, animation, région aria-live) ne bloque que jusqu'à
 *    `maxDomMutationWaitMs` ; une cible animée de même.
 *  - Sans cible (après une action), une fenêtre ouverte est un état normal : seuls un chargeur plein
 *    écran et les requêtes critiques font attendre.
 *  - Sa propre sonde DOM (`__qaReadiness`) : jamais celle de la synchronisation des transitions.
 */

export type ReadinessReason =
  | 'document_loading'
  | 'framework_not_ready'
  | 'dom_unstable'
  | 'target_missing'
  | 'target_hidden'
  | 'target_disabled'
  | 'target_not_editable'
  | 'target_unstable'
  | 'target_covered'
  | 'application_loader_visible'
  | 'critical_request_pending'
  | 'page_closed';

/** Ce qui a été observé mais ne bloque pas (journalisé pour expliquer la décision). */
export type ReadinessAdvisory =
  | 'covered_by_own_control'
  | 'covered_by_in_flow_element'
  | 'dom_unstable_ignored'
  | 'target_unstable_ignored'
  | 'target_scrolled_into_view'
  | 'network_not_observed';

export interface ScreenReadinessSample {
  documentReady: boolean;
  frameworkMounted: boolean;
  domQuiet: boolean;
  target?: {
    present: boolean;
    visible: boolean;
    enabled: boolean;
    editable: boolean;
    stable: boolean;
    covered: boolean;
  };
  busyInTargetRegion: boolean;
  blockingOverlay: boolean;
  pendingCriticalRequests: number;
}

export interface ReadinessObstruction {
  targetTag: string;
  targetType: string | null;
  interactionTag: string;
  coveringTag: string;
  coveringRole: string | null;
  coveringIsTarget: boolean;
  /** OWN_CONTROL : habillage du contrôle ; IN_FLOW : élément de mise en page ; OVERLAY : vrai calque. */
  coveringKind: 'OWN_CONTROL' | 'IN_FLOW' | 'OVERLAY';
  modal: boolean;
}

export interface ScreenReadiness {
  status: 'WAITING' | 'READY' | 'TIMEOUT';
  ready: boolean;
  /** L'action peut être tentée : toujours, sauf page fermée. Un TIMEOUT n'est jamais un échec. */
  proceed: boolean;
  domReady: boolean;
  frameworkReady: boolean;
  criticalNetworkReady: boolean;
  loadingIndicatorsGone: boolean;
  overlaysGone: boolean;
  targetReady?: boolean;
  reasons: ReadinessReason[];
  advisories: ReadinessAdvisory[];
  confidence: number;
  durationMs: number;
  pendingCriticalRequests: number;
  obstruction?: ReadinessObstruction;
}

export interface ScreenReadinessSettings {
  /** Borne totale de l'attente ; au-delà : TIMEOUT (l'action est tentée). */
  timeoutMs: number;
  /** Durée sans mutation pour dire le DOM calme (et la cible immobile). */
  stabilityWindowMs: number;
  /** Au-delà, un DOM / une cible qui bougent encore ne font plus attendre. */
  maxDomMutationWaitMs: number;
  waitForCriticalNetwork: boolean;
  detectLoadingIndicators: boolean;
  detectOverlays: boolean;
  loadingSelector: string;
  /** Intervalle maximal entre deux lectures (réveil anticipé sur mutation). */
  pollIntervalMs?: number;
}

export const DEFAULT_SCREEN_READINESS: ScreenReadinessSettings = {
  timeoutMs: 10_000,
  stabilityWindowMs: 200,
  maxDomMutationWaitMs: 3_000,
  waitForCriticalNetwork: true,
  detectLoadingIndicators: true,
  detectOverlays: true,
  loadingSelector: `${BUSY_SELECTOR}, [class*="loading"], [class*="progress"]`,
  pollIntervalMs: 100,
};

/** Ce que l'action va faire à la cible : décide des contrôles pertinents. */
export type ReadinessActionKind =
  'click' | 'check' | 'uncheck' | 'fill' | 'select' | 'hover' | 'expect' | 'navigate' | (string & {});

/** Décision pure : les raisons bloquantes d'un échantillon. */
export function assessScreenReadiness(
  sample: ScreenReadinessSample,
  waitForCriticalNetwork: boolean,
): Omit<ScreenReadiness, 'status' | 'durationMs' | 'pendingCriticalRequests' | 'proceed' | 'advisories'> {
  const reasons: ReadinessReason[] = [];
  if (!sample.documentReady) reasons.push('document_loading');
  if (!sample.frameworkMounted) reasons.push('framework_not_ready');
  if (!sample.domQuiet) reasons.push('dom_unstable');
  const target = sample.target;
  if (target) {
    if (!target.present) reasons.push('target_missing');
    else {
      if (!target.visible) reasons.push('target_hidden');
      if (!target.enabled) reasons.push('target_disabled');
      if (!target.editable) reasons.push('target_not_editable');
      if (!target.stable) reasons.push('target_unstable');
      if (target.covered) reasons.push('target_covered');
    }
  }
  if (sample.busyInTargetRegion) reasons.push('application_loader_visible');
  if (sample.blockingOverlay) reasons.push('target_covered');
  if (waitForCriticalNetwork && sample.pendingCriticalRequests > 0) reasons.push('critical_request_pending');
  const unique = [...new Set(reasons)];
  return {
    ready: unique.length === 0,
    domReady: sample.documentReady && sample.domQuiet,
    frameworkReady: sample.frameworkMounted,
    criticalNetworkReady: !waitForCriticalNetwork || sample.pendingCriticalRequests === 0,
    loadingIndicatorsGone: !sample.busyInTargetRegion,
    overlaysGone: !sample.blockingOverlay && !(target?.covered ?? false),
    ...(target
      ? {
          targetReady:
            target.present &&
            target.visible &&
            target.enabled &&
            target.editable &&
            target.stable &&
            !target.covered,
        }
      : {}),
    reasons: unique,
    confidence: unique.length === 0 ? 0.9 : Math.max(0.1, 0.8 - unique.length * 0.1),
  };
}

/** Une ligne de journal : la décision et pourquoi. */
export function readinessSummary(state: ScreenReadiness): string {
  const parts = [
    `${state.status}${state.proceed ? '' : ' (no action)'} in ${String(state.durationMs)} ms`,
    state.reasons.length > 0 ? `waiting on: ${state.reasons.join(', ')}` : '',
    state.advisories.length > 0 ? `ignored: ${state.advisories.join(', ')}` : '',
    state.pendingCriticalRequests > 0 ? `${String(state.pendingCriticalRequests)} critical requests` : '',
    state.obstruction
      ? `covered by <${state.obstruction.coveringTag.toLowerCase()}> (${state.obstruction.coveringKind})`
      : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TargetReading {
  identity: number;
  box: Box;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  inViewport: boolean;
  /** Couvert par un VRAI calque (bloquant). */
  covered: boolean;
  blockingModal: boolean;
  busy: boolean;
  advisory?: 'covered_by_own_control' | 'covered_by_in_flow_element';
  obstruction?: ReadinessObstruction;
}

interface ScreenReading {
  documentReady: boolean;
  frameworkMounted: boolean;
  mutations: number;
  msSinceMutation: number;
  fullScreenLoader: boolean;
}

const MODAL_SELECTOR =
  '[aria-modal="true"], [role="dialog"], [role="alertdialog"], dialog[open], .cdk-overlay-pane, .modal.show';
const BACKDROP_SELECTOR =
  '.cdk-overlay-backdrop-showing, .cdk-overlay-backdrop, .modal-backdrop, [class*="backdrop"]';
/** Les mutations de ces zones (horloges, annonces, graphiques, chargeurs) ne disent rien de l'écran. */
const NOISY_SELECTOR =
  '[role="timer"], [role="marquee"], [aria-live], canvas, svg, video, [role="progressbar"], [aria-busy="true"]';

export class ScreenReadinessService {
  private readonly settings: ScreenReadinessSettings;

  constructor(settings: Partial<ScreenReadinessSettings> = {}) {
    this.settings = { ...DEFAULT_SCREEN_READINESS, ...settings };
  }

  async waitUntilReady(
    page: Page,
    input: {
      target?: Locator;
      kind?: ReadinessActionKind;
      network?: () => { pending: number };
      onState?: (state: ScreenReadiness) => void;
    } = {},
  ): Promise<ScreenReadiness> {
    const s = this.settings;
    const started = Date.now();
    const advisories = new Set<ReadinessAdvisory>();
    if (s.waitForCriticalNetwork && !input.network) advisories.add('network_not_observed');
    let previous: TargetReading | undefined;
    let lastTargetChange = started;
    let scrolled = false;
    let lastReasons = '';
    let last: ScreenReadiness | undefined;
    await this.installProbe(page);
    try {
      for (;;) {
        const elapsed = Date.now() - started;
        if (page.isClosed()) return this.closed(last, elapsed);
        const screen = await this.readScreen(page);
        const current = input.target ? await this.readTarget(input.target, input.kind) : undefined;
        // Hors de l'écran (ou sous un en-tête collant) : un seul défilement, puis relecture.
        if (input.target && current && !current.inViewport && !scrolled) {
          scrolled = true;
          advisories.add('target_scrolled_into_view');
          await input.target
            .first()
            .evaluate((el) => {
              el.scrollIntoView({ block: 'center', inline: 'nearest' });
            })
            .catch(() => undefined);
          previous = undefined;
          lastTargetChange = Date.now();
          continue;
        }
        const now = Date.now();
        if (current && previous && !sameReading(current, previous)) lastTargetChange = now;
        if (current && !previous) lastTargetChange = now;
        previous = current;

        const domMoving = !screen || screen.msSinceMutation < s.stabilityWindowMs;
        const domQuiet = !domMoving || elapsed >= s.maxDomMutationWaitMs;
        if (domMoving && domQuiet) advisories.add('dom_unstable_ignored');
        const targetMoving = current !== undefined && now - lastTargetChange < s.stabilityWindowMs;
        const targetStable = !targetMoving || elapsed >= s.maxDomMutationWaitMs;
        if (targetMoving && targetStable) advisories.add('target_unstable_ignored');
        if (current?.advisory) advisories.add(current.advisory);

        const needsTarget = input.target !== undefined && input.kind !== 'navigate';
        const interacts = needsTarget && input.kind !== 'expect';
        const pending = input.network?.().pending ?? 0;
        const assessed = assessScreenReadiness(
          {
            documentReady: screen?.documentReady ?? false,
            frameworkMounted: screen?.frameworkMounted ?? false,
            domQuiet,
            ...(needsTarget
              ? {
                  target: {
                    present: current !== undefined,
                    visible: current?.visible ?? false,
                    enabled: interacts ? (current?.enabled ?? false) : true,
                    editable: input.kind === 'fill' ? (current?.editable ?? false) : true,
                    stable: interacts ? targetStable : true,
                    covered: interacts && s.detectOverlays ? (current?.covered ?? false) : false,
                  },
                }
              : {}),
            busyInTargetRegion:
              s.detectLoadingIndicators && ((current?.busy ?? false) || (screen?.fullScreenLoader ?? false)),
            blockingOverlay: false,
            pendingCriticalRequests: pending,
          },
          s.waitForCriticalNetwork,
        );
        const durationMs = Date.now() - started;
        const state: ScreenReadiness = {
          ...assessed,
          status: assessed.ready ? 'READY' : 'WAITING',
          proceed: true,
          advisories: [...advisories],
          durationMs,
          pendingCriticalRequests: pending,
          ...(current?.obstruction && (!assessed.ready || current.advisory)
            ? { obstruction: current.obstruction }
            : {}),
        };
        last = state;
        const key = state.reasons.join('|');
        if (key !== lastReasons || state.ready) input.onState?.(state);
        lastReasons = key;
        if (state.ready) return state;
        if (durationMs >= s.timeoutMs) {
          const timedOut: ScreenReadiness = { ...state, status: 'TIMEOUT' };
          input.onState?.(timedOut);
          return timedOut;
        }
        await this.pause(
          page,
          screen?.mutations,
          Math.min(s.pollIntervalMs ?? 100, s.timeoutMs - durationMs),
        );
      }
    } finally {
      await this.removeProbe(page);
    }
  }

  private closed(last: ScreenReadiness | undefined, durationMs: number): ScreenReadiness {
    return {
      ...(last ?? {
        ready: false,
        domReady: false,
        frameworkReady: false,
        criticalNetworkReady: true,
        loadingIndicatorsGone: true,
        overlaysGone: true,
        confidence: 0.1,
        pendingCriticalRequests: 0,
        advisories: [],
      }),
      status: 'TIMEOUT',
      ready: false,
      proceed: false,
      reasons: ['page_closed'],
      durationMs,
    };
  }

  /** Réveil à la prochaine mutation, au plus tard après `ms` (jamais un sommeil aveugle). */
  private async pause(page: Page, mutations: number | undefined, ms: number): Promise<void> {
    if (ms <= 0 || page.isClosed()) return;
    await page
      .waitForFunction(
        ({ count, since, wait }) => {
          const probe = (window as unknown as { __qaReadiness?: { mutations: number } }).__qaReadiness;
          return !probe || probe.mutations !== count || Date.now() - since >= wait;
        },
        { count: mutations ?? -1, since: Date.now(), wait: ms },
        { polling: 'raf', timeout: ms + 250 },
      )
      .catch(() => undefined);
  }

  private async installProbe(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page
      .evaluate((noisy) => {
        type Probe = { observer: MutationObserver; mutations: number; last: number };
        const holder = window as unknown as { __qaReadiness?: Probe };
        holder.__qaReadiness?.observer.disconnect();
        const probe: Probe = {
          observer: new MutationObserver((records) => {
            for (const record of records) {
              if (record.type === 'attributes' && record.attributeName?.startsWith('data-qa-crawler'))
                continue;
              const node = record.target instanceof Element ? record.target : record.target.parentElement;
              if (node?.closest(noisy)) continue;
              probe.mutations += 1;
              probe.last = performance.now();
            }
          }),
          mutations: 0,
          last: performance.now() - 10_000,
        };
        probe.observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        holder.__qaReadiness = probe;
      }, NOISY_SELECTOR)
      .catch(() => undefined);
  }

  private async removeProbe(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page
      .evaluate(() => {
        const holder = window as unknown as { __qaReadiness?: { observer: MutationObserver } };
        holder.__qaReadiness?.observer.disconnect();
        delete holder.__qaReadiness;
      })
      .catch(() => undefined);
  }

  /** L'écran : document, application montée, calme du DOM, chargeur plein écran. undefined : navigation. */
  private async readScreen(page: Page): Promise<ScreenReading | undefined> {
    if (page.isClosed()) return undefined;
    const reading = await page
      .evaluate((loading) => {
        const probe = (window as unknown as { __qaReadiness?: { mutations: number; last: number } })
          .__qaReadiness;
        const shown = (el: Element): boolean => {
          if (el.getClientRects().length === 0) return false;
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
        };
        // Angular : la racine (ng-version) a reçu son contenu ; sinon le corps n'est pas vide.
        const root = document.querySelector('[ng-version]');
        const mounted = root ? root.childElementCount > 0 : document.body.childElementCount > 0;
        const viewport = innerWidth * innerHeight;
        const fullScreenLoader = Array.from(document.querySelectorAll(loading)).some((el) => {
          if (!shown(el)) return false;
          const box = el.getBoundingClientRect();
          // Une barre déterminée arrivée au bout n'est plus un chargement.
          const now = Number(el.getAttribute('aria-valuenow'));
          const max = Number(el.getAttribute('aria-valuemax') || 100);
          if (el.getAttribute('aria-valuenow') !== null && now >= max) return false;
          return viewport > 0 && (box.width * box.height) / viewport >= 0.5;
        });
        return {
          documentReady: document.readyState !== 'loading',
          frameworkMounted: mounted,
          mutations: probe?.mutations ?? 0,
          msSinceMutation: probe ? performance.now() - probe.last : 0,
          fullScreenLoader,
          probed: probe !== undefined,
        };
      }, this.settings.loadingSelector)
      .catch(() => undefined);
    if (!reading) return undefined;
    // Un nouveau document (navigation complète) : la sonde a disparu, elle est reposée.
    if (!reading.probed) {
      await this.installProbe(page);
      return { ...reading, msSinceMutation: 0 };
    }
    return reading;
  }

  /** La cible : visible, active, modifiable, à l'écran, et ce qui la couvre (calque ou habillage). */
  private async readTarget(
    target: Locator,
    kind: ReadinessActionKind | undefined,
  ): Promise<TargetReading | undefined> {
    const first = target.first();
    if ((await first.count().catch(() => 0)) === 0) return undefined;
    return first
      .evaluate(
        (el, args) => {
          const doc = el.ownerDocument;
          const view = doc.defaultView ?? window;
          const holder = view as unknown as {
            __qaReadinessIds?: { map: WeakMap<Element, number>; next: number };
          };
          const ids = (holder.__qaReadinessIds ??= { map: new WeakMap(), next: 0 });
          let identity = ids.map.get(el);
          if (identity === undefined) {
            identity = ++ids.next;
            ids.map.set(el, identity);
          }
          const style = (node: Element): CSSStyleDeclaration => view.getComputedStyle(node);
          const shown = (node: Element | null | undefined): boolean => {
            if (!node) return false;
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const css = style(node);
            if (css.visibility === 'hidden' || css.visibility === 'collapse' || css.display === 'none')
              return false;
            const closed = node.closest('details:not([open])');
            return !closed || node.closest('summary') !== null;
          };
          const within = (ancestor: Element | null | undefined, node: Node | null): boolean => {
            let current: Node | null = node;
            while (current) {
              if (current === ancestor) return true;
              current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
            }
            return false;
          };
          const input = el as HTMLInputElement;
          const tag = el.tagName.toLowerCase();
          const labels = Array.from((input as { labels?: NodeListOf<HTMLLabelElement> | null }).labels ?? []);
          // LA RACINE DU CONTRÔLE : l'enveloppe Material / ARIA, ou le plus petit ancêtre commun de
          // l'input et de son libellé — s'il ne contient qu'UNE case / un radio (jamais tout le groupe).
          // Un seul contrôle dans ce nœud (jamais tout un groupe, une ligne ou un formulaire).
          const single = (node: Element): boolean =>
            node.querySelectorAll(
              'input:not([type="hidden"]), button, select, textarea, a[href], [role="radio"], [role="checkbox"], [role="button"]',
            ).length <= 1;
          const checkable = tag === 'input' && ['radio', 'checkbox'].includes(input.type);
          const controlRoot = ((): Element | null => {
            const wrapper = el.closest(
              'mat-radio-button, mat-checkbox, mat-slide-toggle, [role="radio"], [role="checkbox"], [role="switch"], [role="option"], mat-select, [role="combobox"]',
            );
            if (wrapper && wrapper !== el && single(wrapper)) return wrapper;
            // Seulement pour un contrôle habillé : une case / un radio, ou un champ relié à un libellé.
            const anchor = labels[0];
            if (!checkable && !anchor) return null;
            let node: Element | null = el.parentElement;
            for (let depth = 0; node && node !== doc.body && depth < 6; depth += 1) {
              if (!single(node)) return null;
              if (!anchor || within(node, anchor)) return node;
              node = node.parentElement;
            }
            return null;
          })();
          // LA ZONE D'INTERACTION : la cible si elle est visible et cliquable ; sinon (input natif caché,
          // select natif sous un composant) son libellé, sa racine de contrôle, ou l'hôte du composant.
          const usable = (node: Element | null | undefined): boolean => {
            if (!node || !shown(node)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width >= 4 && rect.height >= 4 && Number(style(node).opacity) > 0.05;
          };
          const host = ((): Element | null => {
            let node: Element | null = el.parentElement;
            for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement)
              if (node.tagName.includes('-') && shown(node)) return node;
            return null;
          })();
          const interaction: Element =
            (usable(el) ? el : undefined) ??
            labels.find((label) => shown(label)) ??
            (controlRoot && shown(controlRoot) ? controlRoot : undefined) ??
            (host && !usable(el) ? host : undefined) ??
            el;
          const rect = el.getBoundingClientRect();
          const box = interaction.getBoundingClientRect();
          const visible = shown(el) || (interaction !== el && shown(interaction));
          const enabled =
            !(el as HTMLButtonElement).disabled &&
            !el.matches(':disabled') &&
            el.closest('[aria-disabled="true"]') === null &&
            el.closest('[inert]') === null &&
            style(interaction).pointerEvents !== 'none';
          const editable =
            args.kind !== 'fill' ||
            (el as HTMLElement).isContentEditable ||
            (!(el as HTMLInputElement).readOnly && el.getAttribute('aria-readonly') !== 'true');
          const inViewport =
            box.width > 0 &&
            box.height > 0 &&
            box.bottom > 0 &&
            box.right > 0 &&
            box.top < view.innerHeight &&
            box.left < view.innerWidth;
          // Ce qui reçoit le pointeur au centre de la zone d'interaction (en traversant les shadow roots).
          const deepAt = (x: number, y: number): Element | null => {
            let hit = doc.elementFromPoint(x, y);
            while (hit?.shadowRoot) {
              const inner = hit.shadowRoot.elementFromPoint(x, y);
              if (!inner || inner === hit) break;
              hit = inner;
            }
            return hit;
          };
          const top = inViewport ? deepAt(box.x + box.width / 2, box.y + box.height / 2) : null;
          const ownControl = (node: Element | null): boolean =>
            !!node &&
            (node === el ||
              within(el, node) ||
              within(interaction, node) ||
              within(node, interaction) ||
              labels.some((label) => within(label, node)) ||
              (controlRoot !== null && within(controlRoot, node)));
          // UN VRAI CALQUE : modal / fond / chargeur, ou un élément fixe / collant posé au-dessus.
          const overlayOf = (node: Element): Element | null => {
            let current: Element | null = node;
            while (current && current !== doc.body && current !== doc.documentElement) {
              if (
                current.matches(args.modal) ||
                current.matches(args.backdrop) ||
                current.matches(args.loading)
              )
                return current;
              const position = style(current).position;
              if (position === 'fixed' || position === 'sticky') return current;
              current = current.parentElement;
            }
            return null;
          };
          let covered = false;
          let blockingModal = false;
          let advisory: 'covered_by_own_control' | 'covered_by_in_flow_element' | undefined;
          let obstruction: ReadinessObstruction | undefined;
          if (top && top !== el && top !== interaction) {
            const own = ownControl(top);
            const overlay = own ? null : overlayOf(top);
            // Une fenêtre qui CONTIENT la cible n'est pas un obstacle pour elle.
            const foreign = overlay !== null && !within(overlay, el);
            covered = foreign;
            if (overlay && foreign) {
              const modal = overlay.closest(args.modal);
              blockingModal = modal !== null && !within(modal, el);
            } else advisory = own ? 'covered_by_own_control' : 'covered_by_in_flow_element';
            obstruction = {
              targetTag: el.tagName,
              targetType: tag === 'input' ? input.type : null,
              interactionTag: interaction.tagName,
              coveringTag: top.tagName,
              coveringRole: top.getAttribute('role'),
              coveringIsTarget: false,
              coveringKind: own ? 'OWN_CONTROL' : foreign ? 'OVERLAY' : 'IN_FLOW',
              modal: blockingModal,
            };
          }
          // Occupé : un ancêtre aria-busy, ou un chargeur visible qui chevauche la zone d'interaction.
          const busy =
            el.closest('[aria-busy="true"]') !== null ||
            Array.from(doc.querySelectorAll(args.loading)).some((indicator) => {
              if (within(el, indicator) || !shown(indicator)) return false;
              const area = indicator.getBoundingClientRect();
              return (
                area.left < box.right &&
                area.right > box.left &&
                area.top < box.bottom &&
                area.bottom > box.top
              );
            });
          return {
            identity,
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            visible,
            enabled,
            editable,
            inViewport,
            covered,
            blockingModal,
            busy,
            ...(advisory ? { advisory } : {}),
            ...(obstruction ? { obstruction } : {}),
          };
        },
        {
          kind: kind ?? 'click',
          modal: MODAL_SELECTOR,
          backdrop: BACKDROP_SELECTOR,
          loading: this.settings.loadingSelector,
        },
        { timeout: 500 },
      )
      .catch(() => undefined);
  }
}

function sameReading(current: TargetReading, previous: TargetReading): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1;
  return (
    current.identity === previous.identity &&
    near(current.box.x, previous.box.x) &&
    near(current.box.y, previous.box.y) &&
    near(current.box.width, previous.box.width) &&
    near(current.box.height, previous.box.height)
  );
}
