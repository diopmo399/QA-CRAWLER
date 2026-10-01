import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Frame,
  Page,
  Response,
} from 'playwright';
import type { AllowedOriginPolicy } from '../policies/origin-policy.js';
import { originOf } from '../policies/origin-policy.js';
import type { BrowserInteractionManager } from './browser-interaction-manager.js';
import type { BrowserInteraction, BrowserInteractionType, InteractionDetails } from './types.js';

/** Pont page → crawler pour les demandes de permission (le navigateur ne lève aucun événement pour elles). */
const BINDING = '__qaBrowserInteraction';

/**
 * Signale les demandes de permission. S'exécute dans chaque page avant ses propres
 * scripts ; il ne fait qu'observer et appeler l'API d'origine (que le navigateur
 * refuse, sauf si la mission a accordé la permission).
 */
const PERMISSION_SCRIPT = `(() => {
  const report = (permission) => { try { window.${BINDING}?.({ type: 'PERMISSION_REQUEST', permission }); } catch {} };
  const wrap = (target, name, permission) => {
    if (!target || typeof target[name] !== 'function') return;
    const original = target[name];
    target[name] = function (...args) { report(permission); return original.apply(this, args); };
  };
  if (navigator.geolocation) {
    wrap(navigator.geolocation, 'getCurrentPosition', 'geolocation');
    wrap(navigator.geolocation, 'watchPosition', 'geolocation');
  }
  if (window.Notification) wrap(window.Notification, 'requestPermission', 'notifications');
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints && constraints.video) report('camera');
      if (constraints && constraints.audio) report('microphone');
      return original(constraints);
    };
  }
  if (navigator.clipboard) {
    wrap(navigator.clipboard, 'readText', 'clipboard-read');
    wrap(navigator.clipboard, 'read', 'clipboard-read');
  }
})();`;

interface FetchRequestPaused {
  requestId: string;
  request: { url: string };
  responseStatusCode?: number;
  responseHeaders?: { name: string; value: string }[];
}

interface FetchAuthRequired {
  requestId: string;
  request: { url: string };
  authChallenge: { source?: string; origin: string; scheme: string; realm: string };
}

export interface BrowserEventDiscoveryOptions {
  origins: AllowedOriginPolicy;
  /** Surveiller la fenêtre de connexion du navigateur (HTTP_AUTH) via le protocole du navigateur. */
  httpAuth: boolean;
  /**
   * false : le navigateur répond lui-même aux défis de connexion (identifiants donnés au contexte,
   * voir browser-credentials.ts) ; la découverte ne les intercepte plus.
   */
  answerAuth?: boolean;
  /** Attente maximale du chargement d'une nouvelle page avant de la classer. */
  popupLoadTimeoutMs: number;
}

/**
 * « Browser Event Discovery » : le pendant de l'ActionDiscovery du DOM pour tout ce
 * que le DOM ne montre pas. Écoute Playwright et le protocole du navigateur,
 * transforme chaque événement en BrowserInteraction et le confie au
 * BrowserInteractionManager. Elle ne décide jamais rien.
 *
 * Sources :
 * - HTTP_AUTH : `Fetch.authRequired` de Chromium (la fenêtre de connexion native), pas le code de statut de la page ;
 * - JS_ALERT / JS_CONFIRM / JS_PROMPT (et les dialogues inconnus comme beforeunload) : `page.on('dialog')` ;
 * - POPUP / NEW_TAB : `context.on('page')`, avec ou sans opener ;
 * - DOWNLOAD : `page.on('download')` ; FILE_CHOOSER : `page.on('filechooser')` ;
 * - PERMISSION_REQUEST : un script d'initialisation autour des API de permission ;
 * - EXTERNAL_NAVIGATION : les navigations du cadre principal qui quittent les origines autorisées.
 */
export class BrowserEventDiscovery {
  /** Pages ouvertes par le crawler lui-même (pas des popups). */
  private creatingOwnPage = 0;
  private readonly ownPages = new WeakSet<Page>();
  private readonly lastUrl = new WeakMap<Page, string>();
  /** Pages dont le défi de connexion reçoit sa réponse de cette découverte. */
  private readonly authWatched = new WeakSet<Page>();
  /** URL dont le défi de connexion (WWW-Authenticate) est arrivé avant que la découverte puisse s'attacher à leur page. */
  private readonly missedChallenge = new Set<string>();
  /** Réponses téléchargeables récentes : type MIME et taille pour les enregistrements DOWNLOAD. */
  private readonly fileResponses = new Map<string, { mimeType?: string; size?: number }>();

  /** Les traitements d'événements en cours (nouvel onglet, fenêtre, téléchargement…). */
  private readonly inFlight = new Set<Promise<unknown>>();
  /**
   * Onglets ouverts par une page que Playwright n'a pas encore annoncés : il n'émet
   * l'événement 'page' qu'après la première réponse du nouvel onglet (serveur ou machine
   * lents). Chromium les signale dès leur création ; `settle` les attend aussi.
   */
  private readonly openingTargets = new Set<string>();
  private readonly knownTargets = new Set<string>();
  /** Contextes de navigateur suivis : les onglets des autres contextes ne sont pas attendus ici. */
  private readonly contextIds = new Set<string>();

  constructor(
    private readonly manager: BrowserInteractionManager,
    private readonly options: BrowserEventDiscoveryOptions,
  ) {}

  async attachContext(context: BrowserContext): Promise<void> {
    await context.exposeBinding(BINDING, (source: { page: Page }, payload: unknown) => {
      const permission =
        payload && typeof payload === 'object' && 'permission' in payload
          ? String(payload.permission)
          : 'unknown';
      this.track(
        this.dispatch('PERMISSION_REQUEST', source.page, {
          native: { kind: 'none' },
          details: { permission },
        }),
      );
    });
    await context.addInitScript({ content: PERMISSION_SCRIPT });
    context.on('page', (page) => {
      this.track(this.onNewPage(page));
    });
    await this.watchOpeningTabs(context).catch(() => undefined);
    // Une popup commence à se charger avant que quiconque puisse s'y attacher : quand son premier document est un défi
    // de connexion, la fenêtre native serait manquée. On le retient, pour rejouer le défi une fois attaché.
    context.on('response', (response) => {
      if (!response.request().isNavigationRequest()) return;
      const headers = response.headers();
      if (headers['www-authenticate'] === undefined && headers['proxy-authenticate'] === undefined) return;
      let page: Page | undefined;
      try {
        page = response.frame().page();
      } catch {
        page = undefined; // première requête d'une popup : son cadre n'existe pas encore
      }
      if (page && (this.authWatched.has(page) || response.frame() !== page.mainFrame())) return;
      this.missedChallenge.add(response.url());
    });
  }

  /**
   * Attend les événements du navigateur encore en traitement (au plus `timeoutMs`) : sur une
   * machine lente, un nouvel onglet peut n'être traité qu'après la dernière étape ; fermer le
   * navigateur avant le perdrait.
   */
  async settle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.inFlight.size > 0 || this.openingTargets.size > 0) && Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        // Un onglet qui s'ouvre n'est pas encore un traitement en cours : revenir voir sous peu.
        this.inFlight.size > 0
          ? Promise.allSettled([...this.inFlight])
          : new Promise<void>((resolve) => setTimeout(resolve, 50)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
    }
  }

  private track(task: Promise<unknown>): void {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => undefined);
  }

  /** Chromium signale chaque onglet ouvert par une page (openerId) dès sa création. */
  private async watchOpeningTabs(context: BrowserContext): Promise<void> {
    const browser = context.browser();
    if (!browser || browser.browserType().name() !== 'chromium') return;
    const session = await browser.newBrowserCDPSession();
    session.on('Target.targetCreated', ({ targetInfo }) => {
      const { targetId, type, openerId, browserContextId } = targetInfo;
      if (type !== 'page' || !openerId || this.knownTargets.has(targetId)) return;
      if (browserContextId && this.contextIds.size > 0 && !this.contextIds.has(browserContextId)) return;
      this.openingTargets.add(targetId);
    });
    session.on('Target.targetDestroyed', ({ targetId }) => {
      this.openingTargets.delete(targetId);
    });
    await session.send('Target.setDiscoverTargets', { discover: true });
  }

  /** L'onglet est annoncé par Playwright : il n'est plus « en train de s'ouvrir ». */
  private async markKnown(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      this.knownTargets.add(targetInfo.targetId);
      this.openingTargets.delete(targetInfo.targetId);
      if (targetInfo.browserContextId) this.contextIds.add(targetInfo.browserContextId);
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  /** Ouvre une page pour le crawler lui-même : elle n'est pas signalée comme popup / nouvel onglet. */
  async openOwnPage(open: () => Promise<Page>): Promise<Page> {
    this.creatingOwnPage += 1;
    try {
      const page = await open();
      this.ownPages.add(page);
      return page;
    } finally {
      this.creatingOwnPage -= 1;
    }
  }

  /** Écoute une page (pages du crawler et popups). */
  async attachPage(page: Page): Promise<void> {
    page.on('dialog', (dialog) => {
      this.track(this.onDialog(page, dialog));
    });
    page.on('download', (download) => {
      this.track(this.onDownload(page, download));
    });
    page.on('filechooser', (chooser) => {
      this.track(this.onFileChooser(page, chooser));
    });
    page.on('response', (response) => {
      this.rememberFileResponse(response);
    });
    page.on('framenavigated', (frame) => {
      this.onNavigation(page, frame);
    });
    if (this.options.httpAuth) await this.watchHttpAuth(page);
  }

  // ------------------------------------------------------------------ sources

  private async watchHttpAuth(page: Page): Promise<void> {
    let session: CDPSession;
    try {
      session = await page.context().newCDPSession(page);
      await session.send('Fetch.enable', {
        handleAuthRequests: this.options.answerAuth !== false,
        patterns: [
          { urlPattern: '*' },
          // Les documents sont aussi mis en pause à l'arrivée de leurs en-têtes : nom, type et taille d'un téléchargement.
          { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
        ],
      });
      this.authWatched.add(page);
    } catch {
      return; // pas Chromium, ou la page a déjà disparu
    }
    // Chaque requête est mise en pause par Fetch.enable : la laisser continuer telle quelle.
    session.on('Fetch.requestPaused', (event: FetchRequestPaused) => {
      if (event.responseStatusCode === undefined) {
        void session.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
        return;
      }
      this.rememberFileHeaders(event.request.url, event.responseHeaders ?? []);
      void session
        .send('Fetch.continueResponse', { requestId: event.requestId })
        .catch(() => session.send('Fetch.continueRequest', { requestId: event.requestId }))
        .catch(() => undefined);
    });
    session.on('Fetch.authRequired', (event: FetchAuthRequired) => {
      let answered = false;
      const answer = async (response: Record<string, string>): Promise<void> => {
        if (answered) return;
        answered = true;
        await session
          .send('Fetch.continueWithAuth', {
            requestId: event.requestId,
            authChallengeResponse: response as never,
          })
          .catch(() => undefined);
      };
      const cancel = (): Promise<void> => answer({ response: 'CancelAuth' });
      this.track(
        this.dispatch('HTTP_AUTH', page, {
          targetUrl: event.request.url,
          origin: event.authChallenge.origin,
          details: {
            scheme: event.authChallenge.scheme,
            realm: event.authChallenge.realm,
            source: event.authChallenge.source ?? 'Server',
          },
          native: {
            kind: 'http-auth',
            provideCredentials: (username, password) =>
              answer({ response: 'ProvideCredentials', username, password }),
            cancel,
          },
          fallback: cancel,
        }),
      );
    });
  }

  private async onDialog(page: Page, dialog: Dialog): Promise<void> {
    const kind = dialog.type();
    const type: BrowserInteractionType =
      kind === 'alert'
        ? 'JS_ALERT'
        : kind === 'confirm'
          ? 'JS_CONFIRM'
          : kind === 'prompt'
            ? 'JS_PROMPT'
            : 'UNKNOWN_BROWSER_INTERACTION';
    await this.dispatch(type, page, {
      details: { dialog: kind, message: dialog.message() },
      native: { kind: 'dialog', dialog },
      // beforeunload : laisser partir la page (le crawler a décidé de la quitter) ; tout le reste : refuser.
      fallback: () => (kind === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => undefined),
    });
  }

  private async onNewPage(page: Page): Promise<void> {
    const own = this.creatingOwnPage > 0 || this.ownPages.has(page);
    await this.markKnown(page).catch(() => undefined);
    if (own) return;
    const opener = await page.opener().catch(() => null);
    await page
      .waitForLoadState('domcontentloaded', { timeout: this.options.popupLoadTimeoutMs })
      .catch(() => undefined);
    await this.attachPage(page).catch(() => undefined);
    if (
      this.options.httpAuth &&
      this.options.answerAuth !== false &&
      this.missedChallenge.has(page.url()) &&
      !page.isClosed()
    ) {
      // Le défi de connexion a eu lieu avant que la page soit surveillée : la recharger, le
      // défi est maintenant remonté au BrowserInteractionManager (HTTP_AUTH), puis traité.
      this.missedChallenge.delete(page.url());
      await page
        .reload({ waitUntil: 'domcontentloaded', timeout: this.options.popupLoadTimeoutMs * 3 })
        .catch(() => undefined);
    }
    // POPUP : la page peut piloter sa page d'origine (window.open, target=_blank avec opener).
    // NEW_TAB : aucun lien de retour (rel="noopener", ctrl+clic…), même quand le navigateur sait qui l'a ouverte.
    const scriptable = await page.evaluate(() => window.opener !== null).catch(() => false);
    const type = opener && scriptable ? 'POPUP' : 'NEW_TAB';
    await this.dispatch(type, opener ?? page, {
      targetUrl: page.url(),
      ...(originOf(page.url()) ? { origin: originOf(page.url()) } : {}),
      details: { opener: scriptable },
      native: { kind: 'page', page },
      fallback: () => page.close().catch(() => undefined),
    });
  }

  private async onDownload(page: Page, download: Download): Promise<void> {
    const file = this.fileResponses.get(download.url());
    await this.dispatch('DOWNLOAD', page, {
      targetUrl: download.url(),
      details: {
        filename: download.suggestedFilename(),
        ...(file?.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file?.size !== undefined ? { size: file.size } : {}),
      },
      native: { kind: 'download', download },
      fallback: () => download.cancel().catch(() => undefined),
    });
  }

  private async onFileChooser(page: Page, chooser: FileChooser): Promise<void> {
    const accept = await chooser
      .element()
      .getAttribute('accept')
      .catch(() => null);
    await this.dispatch('FILE_CHOOSER', page, {
      details: { multiple: chooser.isMultiple(), ...(accept ? { accept } : {}) },
      native: { kind: 'file-chooser', chooser },
      // Rien à faire : le sélecteur intercepté ne s'ouvre jamais et aucun fichier n'est choisi.
    });
  }

  private onNavigation(page: Page, frame: Frame): void {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    const previous = this.lastUrl.get(page);
    this.lastUrl.set(page, url);
    const originClass = this.options.origins.classify(url);
    if (originClass !== 'EXTERNAL_ORIGIN' && originClass !== 'BLOCKED_ORIGIN') return;
    if (previous !== undefined && originOf(previous) === originOf(url)) return; // déjà signalé
    this.track(
      this.dispatch('EXTERNAL_NAVIGATION', page, {
        ...(previous ? { sourceUrl: previous } : {}),
        targetUrl: url,
        ...(originOf(url) ? { origin: originOf(url) } : {}),
        details: {},
        native: { kind: 'none' },
      }),
    );
  }

  private rememberFileResponse(response: Response): void {
    this.rememberFile(response.url(), response.headers());
  }

  private rememberFileHeaders(url: string, headers: readonly { name: string; value: string }[]): void {
    this.rememberFile(
      url,
      Object.fromEntries(headers.map((header) => [header.name.toLowerCase(), header.value])),
    );
  }

  private rememberFile(url: string, headers: Record<string, string>): void {
    const disposition = headers['content-disposition'] ?? '';
    const type = headers['content-type'] ?? '';
    if (!/attachment/i.test(disposition) && (type === '' || /text\/html/i.test(type))) return;
    const length = Number(headers['content-length']);
    this.fileResponses.set(url, {
      ...(type ? { mimeType: type.split(';')[0]?.trim() ?? type } : {}),
      ...(Number.isFinite(length) && headers['content-length'] !== undefined ? { size: length } : {}),
    });
    if (this.fileResponses.size > 50) {
      const oldest = this.fileResponses.keys().next().value;
      if (oldest !== undefined) this.fileResponses.delete(oldest);
    }
  }

  // ------------------------------------------------------------------ répartition

  private async dispatch(
    type: BrowserInteractionType,
    page: Page,
    parts: {
      sourceUrl?: string;
      targetUrl?: string;
      origin?: string;
      details: InteractionDetails;
      native: BrowserInteraction['native'];
      fallback?: () => Promise<void>;
    },
  ): Promise<void> {
    const interaction: BrowserInteraction = {
      id: this.manager.nextId(),
      type,
      page,
      sourceUrl: parts.sourceUrl ?? (page.isClosed() ? '' : page.url()),
      ...(parts.targetUrl ? { targetUrl: parts.targetUrl } : {}),
      ...(parts.origin ? { origin: parts.origin } : {}),
      details: parts.details,
      native: parts.native,
      fallback: parts.fallback ?? (() => Promise.resolve()),
    };
    await this.manager.dispatch(interaction).catch(() => interaction.fallback());
  }
}
