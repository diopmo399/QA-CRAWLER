import type { Page } from 'playwright';
import { BUSY_SELECTOR } from './screen-ready.js';

/**
 * REPLAY TRANSITION SYNCHRONIZATION.
 *
 *   ACTION_EXECUTED ≠ TRANSITION_COMPLETED ≠ UI_STABLE ≠ EFFECT_CONFIRMED
 *
 * Un `locator.click()` qui retourne prouve seulement que l'action a été TECHNIQUEMENT exécutée. Une
 * SPA continue ensuite : elle change de vue, re-rend, ouvre un dialogue, charge des données. Le
 * UITransitionWaiter OBSERVE (il n'agit jamais) jusqu'à ce que la transition pertinente soit là et
 * que l'interface soit stable ; l'ActionEffectVerifier décide ensuite du SENS fonctionnel.
 *
 * Aucun sommeil fixe : le délai est une BORNE, jamais la condition de succès. On attend des
 * conditions observables — mutations du DOM, route, dialogues, indicateurs de chargement, requêtes
 * corrélées à l'action, effets attendus, cible de l'action suivante (résolue sur le DOM FRAIS).
 */

export type TransitionSignalKind =
  | 'URL_CHANGED'
  | 'ROUTE_CHANGED'
  | 'DOM_CHANGED'
  | 'DIALOG_OPENED'
  | 'DIALOG_CLOSED'
  | 'LOADER_APPEARED'
  | 'LOADER_DISAPPEARED'
  | 'NETWORK_ACTIVITY_STARTED'
  | 'NETWORK_ACTIVITY_COMPLETED'
  | 'EXPECTED_EFFECT_OBSERVED'
  | 'NEXT_ACTION_TARGET_AVAILABLE'
  | 'NEXT_ACTION_TARGET_NOT_READY'
  | 'UI_STABLE';

export interface TransitionSignal {
  kind: TransitionSignalKind;
  /** Millisecondes depuis la fin de l'exécution technique. */
  atMs: number;
  detail?: string;
}

export type TransitionWaitStatus =
  | 'TRANSITION_CONFIRMED'
  | 'STABLE_WITH_LOCAL_EFFECT'
  | 'NEXT_ACTION_READY'
  | 'NO_TRANSITION_EXPECTED'
  | 'TIMEOUT'
  | 'AMBIGUOUS';

export interface TransitionWaitResult {
  status: TransitionWaitStatus;
  signals: TransitionSignal[];
  /** Ce qui était attendu et n'est jamais venu (pour un TIMEOUT). */
  missing: string[];
  durationMs: number;
  /** Depuis combien de temps l'interface était calme quand l'attente s'est terminée. */
  stabilityDurationMs: number;
  stable: boolean;
  confidence: number;
  evidence: string[];
  /** La préparation de l'action suivante : READY / NOT_READY / UNKNOWN (pas de cible connue). */
  nextAction: 'READY' | 'NOT_READY' | 'UNKNOWN';
}

/** Les réglages (replay.synchronization). */
export interface TransitionSettings {
  transitionTimeoutMs: number;
  stabilityWindowMs: number;
  /** Une action dont rien n'est attendu : borne de la seule attente de stabilité. */
  noTransitionCapMs: number;
  /** Rien d'observé, rien de précis attendu : au-delà, l'attente conclut (AMBIGUOUS ou local). */
  graceMs: number;
  observeDomChanges: boolean;
  observeRouteChanges: boolean;
  observeNetwork: boolean;
  observeDialogs: boolean;
  observeLoaders: boolean;
}

/** Ce que l'attente sait AVANT de commencer (déduit de l'action, des effets enregistrés, de la suite). */
export interface TransitionExpectation {
  /** Une transition est-elle attendue (clic, choix, effets enregistrés) ? */
  expected: boolean;
  /** Effets enregistrés de l'action (ActionExpectedEffects). */
  effectsDeclared: boolean;
  /** La cible de l'action suivante était absente avant l'action : son apparition est un point de contrôle. */
  nextAwaited: boolean;
  /** Une cible d'action suivante est connue (sinon la préparation est UNKNOWN). */
  nextKnown: boolean;
}

/** Un échantillon de ce que l'application fait, à un instant. */
export interface TransitionSample {
  elapsedMs: number;
  mutations: number;
  msSinceMutation: number;
  urlChanged: boolean;
  routeChanged: boolean;
  dialogsOpened: boolean;
  dialogsClosed: boolean;
  loaderVisible: boolean;
  network: {
    started: number;
    pending: number;
    completed: number;
    lastStarted?: string;
    lastCompleted?: string;
  };
  /** undefined : pas vérifié à cet échantillon. */
  effectObserved?: boolean;
  nextReady?: boolean;
  /** La cible suivante est là, actionnable, mais son empreinte diffère (re-rendu ou changement). */
  nextPresent?: boolean;
  nextReason?: string;
}

/**
 * LA DÉCISION, pure (testable sans navigateur) : chaque échantillon ajoute ses signaux ; l'attente
 * se termine quand la transition pertinente est là ET que l'interface est stable, quand rien n'est
 * attendu et que tout est calme, ou à la borne (TIMEOUT : jamais une conclusion fonctionnelle).
 */
export class TransitionTracker {
  private readonly signals: TransitionSignal[] = [];
  private readonly seen = new Set<string>();
  private loaderSeen = false;
  private effect = false;
  private next: boolean | undefined;
  private nextPresent = false;
  private nextReason: string | undefined;
  private network = { started: 0, completed: 0 };

  constructor(
    private readonly expectation: TransitionExpectation,
    private readonly settings: TransitionSettings,
  ) {}

  private signal(kind: TransitionSignalKind, atMs: number, detail?: string, repeat = false): void {
    const key = `${kind}|${detail ?? ''}`;
    if (!repeat && this.seen.has(key)) return;
    this.seen.add(key);
    if (this.signals.length < 60) this.signals.push({ kind, atMs, ...(detail ? { detail } : {}) });
  }

  /** Les signaux observés jusqu'ici (journal en direct). */
  get observed(): readonly TransitionSignal[] {
    return this.signals;
  }

  /** Ajoute un échantillon ; le résultat quand l'attente est terminée, sinon undefined. */
  observe(sample: TransitionSample): TransitionWaitResult | undefined {
    const at = sample.elapsedMs;
    const s = this.settings;
    if (s.observeDomChanges && sample.mutations > 0) this.signal('DOM_CHANGED', at);
    if (s.observeRouteChanges && sample.urlChanged) this.signal('URL_CHANGED', at);
    if (s.observeRouteChanges && sample.routeChanged) this.signal('ROUTE_CHANGED', at);
    if (s.observeDialogs && sample.dialogsOpened) this.signal('DIALOG_OPENED', at);
    if (s.observeDialogs && sample.dialogsClosed) this.signal('DIALOG_CLOSED', at);
    if (s.observeLoaders && sample.loaderVisible) {
      this.loaderSeen = true;
      this.signal('LOADER_APPEARED', at);
    } else if (this.loaderSeen) this.signal('LOADER_DISAPPEARED', at);
    if (s.observeNetwork) {
      if (sample.network.started > this.network.started)
        this.signal('NETWORK_ACTIVITY_STARTED', at, sample.network.lastStarted, true);
      if (sample.network.completed > this.network.completed)
        this.signal('NETWORK_ACTIVITY_COMPLETED', at, sample.network.lastCompleted, true);
      this.network = { started: sample.network.started, completed: sample.network.completed };
    }
    if (sample.effectObserved) {
      this.effect = true;
      this.signal('EXPECTED_EFFECT_OBSERVED', at);
    }
    if (sample.nextReady !== undefined) {
      if (sample.nextReady && this.next !== true) this.signal('NEXT_ACTION_TARGET_AVAILABLE', at);
      if (!sample.nextReady && this.next === undefined)
        this.signal('NEXT_ACTION_TARGET_NOT_READY', at, sample.nextReason);
      this.next = sample.nextReady;
      this.nextPresent = !sample.nextReady && sample.nextPresent === true;
      if (sample.nextReason) this.nextReason = sample.nextReason;
    }

    const loaderBusy = s.observeLoaders && sample.loaderVisible;
    const networkBusy = s.observeNetwork && sample.network.pending > 0;
    const quiet = !s.observeDomChanges || sample.msSinceMutation >= s.stabilityWindowMs;
    const stable = quiet && !loaderBusy && !networkBusy;
    const timedOut = at >= s.transitionTimeoutMs;
    const finish = (status: TransitionWaitStatus, confidence: number): TransitionWaitResult => {
      if (stable) this.signal('UI_STABLE', at, `${String(Math.round(sample.msSinceMutation))} ms`);
      return this.result(status, sample, stable, confidence, timedOut);
    };

    // Rien d'attendu (saisie, focus) : seulement une stabilité courte, jamais la borne complète.
    if (!this.expectation.expected) {
      if (stable || at >= Math.min(s.noTransitionCapMs, s.transitionTimeoutMs))
        return finish('NO_TRANSITION_EXPECTED', stable ? 0.7 : 0.4);
      return undefined;
    }
    // Un point de contrôle (effet enregistré, cible suivante absente avant) : l'un des deux suffit.
    const checkpoint = this.expectation.effectsDeclared || this.expectation.nextAwaited;
    const reached = this.effect || this.next === true;
    if (checkpoint && !reached) {
      // La cible suivante est là mais son empreinte diffère : une fois l'écran durablement stable,
      // la synchronisation s'arrête (la résolution de cible de l'étape suivante jugera, pas l'attente).
      if (this.nextPresent && stable && sample.msSinceMutation >= 2 * s.stabilityWindowMs) {
        this.signal('NEXT_ACTION_TARGET_AVAILABLE', at, 'fingerprint differs');
        return finish('TRANSITION_CONFIRMED', 0.5);
      }
      return timedOut ? finish('TIMEOUT', 0.2) : undefined;
    }
    if (stable) {
      if (this.next === true) return finish('NEXT_ACTION_READY', 0.9);
      const strong =
        this.effect ||
        this.seen.has('URL_CHANGED|') ||
        this.seen.has('ROUTE_CHANGED|') ||
        this.seen.has('DIALOG_OPENED|') ||
        this.seen.has('DIALOG_CLOSED|') ||
        this.seen.has('LOADER_DISAPPEARED|') ||
        this.network.completed > 0;
      if (strong) return finish('TRANSITION_CONFIRMED', this.effect ? 0.9 : 0.75);
      if (this.seen.has('DOM_CHANGED|')) return finish('STABLE_WITH_LOCAL_EFFECT', 0.5);
      if (at >= s.graceMs) return finish('AMBIGUOUS', 0.3);
      return undefined;
    }
    return timedOut ? finish('TIMEOUT', 0.2) : undefined;
  }

  private result(
    status: TransitionWaitStatus,
    sample: TransitionSample,
    stable: boolean,
    confidence: number,
    timedOut: boolean,
  ): TransitionWaitResult {
    const missing: string[] = [];
    if (status === 'TIMEOUT' || timedOut) {
      if (this.expectation.effectsDeclared && !this.effect) missing.push('EXPECTED_EFFECT_OBSERVED');
      if (this.expectation.nextAwaited && this.next !== true)
        missing.push(`NEXT_ACTION_TARGET_AVAILABLE${this.nextReason ? ` (${this.nextReason})` : ''}`);
      if (!stable)
        missing.push(
          `UI_STABLE (${[
            sample.msSinceMutation < this.settings.stabilityWindowMs ? 'DOM still changing' : '',
            sample.loaderVisible ? 'loader visible' : '',
            sample.network.pending > 0 ? `${String(sample.network.pending)} request(s) pending` : '',
          ]
            .filter(Boolean)
            .join(', ')})`,
        );
    }
    return {
      status,
      signals: [...this.signals],
      missing,
      durationMs: Math.round(sample.elapsedMs),
      stabilityDurationMs: Math.round(Math.min(sample.msSinceMutation, sample.elapsedMs)),
      stable,
      confidence,
      evidence: this.signals.map((signal) => `${signal.kind}${signal.detail ? ` ${signal.detail}` : ''}`),
      nextAction: !this.expectation.nextKnown
        ? 'UNKNOWN'
        : this.next === true
          ? 'READY'
          : this.next === false
            ? 'NOT_READY'
            : 'UNKNOWN',
    };
  }
}

/** Qu'attendre d'une action ? (type d'action, effets enregistrés, action suivante). */
export function expectationOf(input: {
  kind: string;
  effectsDeclared: boolean;
  nextKnown: boolean;
  nextReadyBefore: boolean | undefined;
}): TransitionExpectation {
  // Une saisie ne change pas d'écran (sauf effets enregistrés) ; un clic, un choix, une case, si.
  const interactive = ['click', 'select', 'check', 'uncheck', 'dragAndDrop'].includes(input.kind);
  const nextAwaited = input.nextKnown && input.nextReadyBefore === false;
  return {
    expected: interactive || input.effectsDeclared,
    effectsDeclared: input.effectsDeclared,
    nextAwaited: interactive && nextAwaited,
    nextKnown: input.nextKnown,
  };
}

const DIALOG_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';

interface ProbeReading {
  mutations: number;
  msSinceMutation: number;
  href: string;
  route: string;
  dialogs: number;
  loaderVisible: boolean;
}

/**
 * La SONDE, dans la page : un MutationObserver posé AVANT l'action (les attributs internes
 * data-qa-crawler-* sont ignorés), la route, les dialogues visibles, les indicateurs de chargement.
 */
export async function installTransitionProbe(
  page: Page,
): Promise<{ href: string; route: string; dialogs: number } | undefined> {
  return page
    .evaluate(
      ({ dialog }) => {
        type Probe = { observer: MutationObserver; mutations: number; last: number };
        const holder = window as unknown as { __qaTransition?: Probe };
        holder.__qaTransition?.observer.disconnect();
        const probe: Probe = {
          observer: new MutationObserver((records) => {
            for (const record of records) {
              if (record.type === 'attributes' && record.attributeName?.startsWith('data-qa-crawler'))
                continue;
              probe.mutations += 1;
              probe.last = performance.now();
            }
          }),
          mutations: 0,
          last: performance.now(),
        };
        probe.observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        holder.__qaTransition = probe;
        const visible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 || rect.height > 0;
        };
        return {
          href: location.href,
          route: `${location.pathname}${location.hash}`,
          dialogs: Array.from(document.querySelectorAll(dialog)).filter(visible).length,
        };
      },
      { dialog: DIALOG_SELECTOR },
    )
    .catch(() => undefined);
}

/** Lit la sonde ; undefined si elle a disparu (nouveau document : une navigation complète). */
export async function readTransitionProbe(page: Page): Promise<ProbeReading | undefined> {
  if (page.isClosed()) return undefined;
  return page
    .evaluate(
      ({ dialog, busy }) => {
        const holder = window as unknown as {
          __qaTransition?: { mutations: number; last: number };
        };
        const probe = holder.__qaTransition;
        if (!probe) return undefined;
        const shown = (el: Element): boolean => {
          if (el.getClientRects().length === 0) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        return {
          mutations: probe.mutations,
          msSinceMutation: performance.now() - probe.last,
          href: location.href,
          route: `${location.pathname}${location.hash}`,
          dialogs: Array.from(document.querySelectorAll(dialog)).filter(shown).length,
          loaderVisible: Array.from(document.querySelectorAll(busy)).some(shown),
        };
      },
      { dialog: DIALOG_SELECTOR, busy: BUSY_SELECTOR },
    )
    .catch(() => undefined);
}

/** Retire la sonde (fin de l'attente). */
export async function removeTransitionProbe(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page
    .evaluate(() => {
      const holder = window as unknown as { __qaTransition?: { observer: MutationObserver } };
      holder.__qaTransition?.observer.disconnect();
      delete holder.__qaTransition;
    })
    .catch(() => undefined);
}

export interface TransitionWaitContext {
  page: Page;
  expectation: TransitionExpectation;
  /** L'état de la page juste AVANT l'action (sonde posée). */
  before: { href: string; route: string; dialogs: number };
  /** Le réseau corrélé à l'action (NetworkObserver existant). */
  network?: () => TransitionSample['network'];
  /** L'effet enregistré est-il observable maintenant ? (ActionExpectedEffects) */
  effectObserved?: () => Promise<boolean>;
  /** La cible de l'action suivante est-elle prête (résolue sur le DOM frais, empreinte, actionnable) ? */
  nextReady?: () => Promise<{ ready: boolean; present?: boolean; reason?: string }>;
  onSignal?: (signal: TransitionSignal) => void;
}

/**
 * UITransitionWaiter : orchestre la sonde, le réseau, les effets attendus et la préparation de
 * l'action suivante. Il n'exécute JAMAIS d'action (rien n'est rejoué pendant une synchronisation).
 */
export class UITransitionWaiter {
  constructor(
    private readonly settings: TransitionSettings,
    private readonly pollMs = 50,
    private readonly checkEveryMs = 200,
  ) {}

  async waitForTransition(context: TransitionWaitContext): Promise<TransitionWaitResult> {
    const { page } = context;
    const tracker = new TransitionTracker(context.expectation, this.settings);
    const started = Date.now();
    let lastCheck = -Infinity;
    let probeMutations = 0;
    let lastMutationAt = started;
    let navigated = false;
    let reported = 0;
    for (;;) {
      const elapsed = Date.now() - started;
      let reading = await readTransitionProbe(page);
      if (!reading && !page.isClosed()) {
        // Nouveau document (navigation complète) : une transition ; la sonde est reposée.
        navigated = true;
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => undefined);
        await installTransitionProbe(page);
        lastMutationAt = Date.now();
        reading = await readTransitionProbe(page);
      }
      if (reading) {
        if (reading.mutations !== probeMutations) {
          probeMutations = reading.mutations;
          lastMutationAt = Date.now() - reading.msSinceMutation;
        }
      }
      const check = Date.now() - lastCheck >= this.checkEveryMs;
      const effect =
        check && context.effectObserved ? await context.effectObserved().catch(() => false) : undefined;
      const next =
        check && context.nextReady
          ? await context
              .nextReady()
              .catch((): { ready: boolean; present?: boolean; reason?: string } => ({ ready: false }))
          : undefined;
      if (check) lastCheck = Date.now();
      const sample: TransitionSample = {
        elapsedMs: Date.now() - started,
        mutations: (reading?.mutations ?? 0) + (navigated ? 1 : 0),
        msSinceMutation: Date.now() - lastMutationAt,
        urlChanged: navigated || (reading !== undefined && reading.href !== context.before.href),
        routeChanged: navigated || (reading !== undefined && reading.route !== context.before.route),
        dialogsOpened: reading !== undefined && reading.dialogs > context.before.dialogs,
        dialogsClosed: reading !== undefined && reading.dialogs < context.before.dialogs,
        loaderVisible: reading?.loaderVisible ?? false,
        network: context.network?.() ?? { started: 0, pending: 0, completed: 0 },
        ...(effect !== undefined ? { effectObserved: effect } : {}),
        ...(next
          ? {
              nextReady: next.ready,
              ...(next.present ? { nextPresent: true } : {}),
              ...(next.reason ? { nextReason: next.reason } : {}),
            }
          : {}),
      };
      const result = tracker.observe(sample);
      const seen = result?.signals ?? tracker.observed;
      for (const signal of seen.slice(reported)) context.onSignal?.(signal);
      reported = seen.length;
      if (result || page.isClosed()) {
        await removeTransitionProbe(page);
        return (
          result ?? {
            status: 'TIMEOUT',
            signals: [...seen],
            missing: ['page closed'],
            durationMs: elapsed,
            stabilityDurationMs: 0,
            stable: false,
            confidence: 0,
            evidence: [],
            nextAction: 'UNKNOWN',
          }
        );
      }
      // Intervalle d'ÉCHANTILLONNAGE (borné par la condition), pas une attente de succès.
      await page.waitForTimeout(this.pollMs).catch(() => undefined);
    }
  }
}
