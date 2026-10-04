import type { BrowserContext, CDPSession, Dialog, Download, Page } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';
import { FormKnowledgeObserver } from '../forms/state/form-knowledge-observer.js';
import { newValueSalt } from '../forms/state/value-digest.js';
import type { FunctionalExchange } from '../functional/model.js';
import { NavigationGuard } from '../navigation/navigation-guard.js';
import { StateDetector } from '../observation/state-detector.js';
import { UIObserver } from '../observation/ui-observer.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { SafetyPolicy } from '../policies/safety-policy.js';
import { sensitivityOf } from '../policies/sensitive-fields.js';
import { redactText, redactUrl } from '../security/redactor.js';
import { captureScript } from './capture-script.js';
import { NON_INTERACTIVE_NOISE } from './human-journey.js';
import type { RecordingTargetValidator } from './target-validator.js';
import type {
  RawEventType,
  RawRecordedEvent,
  PreActionCandidate,
  PreActionContext,
  RecordedDrag,
  RecordedCssCandidate,
  RecordedDropZone,
  RecordedElement,
  RecordedSelectors,
  RecordedState,
  RecordedValueFacts,
  RecordingEvent,
  RecordingEventType,
  RecordingSession,
  ScreenInventory,
  ScreenInventoryElement,
} from './model.js';

const BINDING = '__qaCrawlerRecord';
/** Jamais perdus, même tampon plein. */
const ESSENTIAL = new Set<RawEventType>([
  'submit',
  'navigation',
  'change',
  'checkpoint',
  'control',
  'dialog',
  'download',
  'popup',
]);
const RAW_TYPES = new Set<RawEventType>(['click', 'input', 'change', 'submit', 'keydown', 'control', 'drag']);

export type StopReason = 'overlay' | 'terminal' | 'page-closed' | 'browser-closed' | 'max-duration' | 'api';

export interface HumanFlowRecorderOptions {
  name: string;
  config: ScenarioConfig;
  onEvent?: (event: RecordingEvent) => void;
  /** Contexte de la session (rapport, connaissance) : version, environnement, rôle. */
  version?: string;
  environment?: string;
  role?: string;
  /** Pour les tests : l'horloge. */
  now?: () => number;
  /** AUTO-VALIDATION de la cible juste après chaque action (absente : désactivée). */
  targetValidator?: RecordingTargetValidator;
}

/**
 * HUMAN FLOW RECORDER — la capture. Un humain se sert de l'application dans Chromium ;
 * le recorder écoute sans rien changer (script passif, aucune requête interceptée),
 * observe chaque écran atteint (UIObserver → StateDetector) et les requêtes de chaque
 * action (FormKnowledgeObserver : formes et statuts, jamais une valeur). Le tampon est
 * borné, sans jamais perdre un envoi, une navigation, un changement ou un point de contrôle.
 *
 * Le traitement (sémantique, normalisation, résultats, flow) est fait ensuite par
 * processRecording, sur la session terminée.
 */
export class HumanFlowRecorder {
  readonly session: RecordingSession;
  readonly stopped: Promise<StopReason>;
  private resolveStop: (reason: StopReason) => void = () => undefined;
  private readonly salt = newValueSalt();
  private readonly safety: SafetyPolicy;
  private readonly observer: UIObserver;
  private readonly detector: StateDetector;
  private readonly network: FormKnowledgeObserver;
  private readonly now: () => number;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private paused = false;
  private stopping = false;
  /** Plus aucun événement accepté (après la dernière saisie en attente). */
  private closed = false;
  private sequence = 0;
  /** Fenêtre réseau ouverte : l'événement auquel elle appartient. */
  private window: RawRecordedEvent | undefined;
  /** Événements qui attendent l'écran observé après eux. */
  private awaiting: RawRecordedEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private observing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly snapshots = new Map<string, UiSnapshot>();
  private overflowWarned = false;

  constructor(private readonly options: HumanFlowRecorderOptions) {
    const { config } = options;
    this.now = options.now ?? Date.now;
    this.safety = new SafetyPolicy(config.safety);
    this.observer = new UIObserver(400, new NavigationGuard(), this.salt);
    this.detector = new StateDetector(
      config.exploration.queryParams.mode,
      config.exploration.queryParams.ignored,
    );
    this.network = new FormKnowledgeObserver(
      (url) => this.safety.navigation.isAllowedHost(new URL(url).hostname),
      undefined,
      this.salt,
    );
    this.session = {
      id: `rec-${new Date(this.now())
        .toISOString()
        .replace(/[-:T.Z]/g, '')
        .slice(0, 14)}-${this.salt.slice(0, 6)}`,
      name: options.name,
      startedAt: new Date(this.now()).toISOString(),
      startUrl: '',
      ...(options.version ? { version: options.version } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.role ? { role: options.role } : {}),
      status: 'RECORDING',
      rawEvents: [],
      semanticActions: [],
      checkpoints: [],
      states: [],
      warnings: [],
      droppedEvents: 0,
    };
    this.stopped = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    // L'effet d'une saisie se compare par empreinte salée (le même sel que la capture).
    options.targetValidator?.useValueSalt(this.salt);
  }

  /** Sel des empreintes de la session (jamais écrit : il ne sert qu'à comparer pendant le traitement). */
  get valueSalt(): string {
    return this.salt;
  }

  /** Commence à écouter la page (déjà ouverte, connectée, sur l'écran de départ). */
  async attach(context: BrowserContext, page: Page): Promise<void> {
    this.context = context;
    this.page = page;
    const { recording } = this.options.config;
    await context.exposeBinding(BINDING, (source, payload: unknown) => {
      this.onPayload(source.page, payload);
    });
    await context.exposeBinding(`${BINDING}_inventory`, (source, payload: unknown) => {
      this.onInventory(source.page, payload);
    });
    const script = captureScript({
      binding: BINDING,
      salt: this.salt,
      overlay: recording.overlay,
      inputDebounceMs: recording.inputDebounceMs,
      recordValues: recording.testData.enabled && recording.testData.extractRecordedValues,
      maxValueLength: recording.testData.maxValueLength,
      preActionCapture: recording.preActionCapture,
    });
    await context.addInitScript({ content: script });
    // La page déjà chargée : le script est posé tout de suite (les suivantes l'ont par l'init script).
    await page.evaluate(script).catch(() => undefined);
    this.network.attach(page);
    this.watchPage(page);
    context.on('page', (popup) => {
      if (popup === this.page) return;
      this.capture({ type: 'popup', at: this.now(), url: popup.url(), target: '(new window)' });
      void popup
        .waitForLoadState('domcontentloaded', { timeout: 5000 })
        .then(() => {
          const last = [...this.session.rawEvents].reverse().find((event) => event.type === 'popup');
          if (last) last.target = redactUrl(popup.url());
        })
        .catch(() => undefined);
    });
    context.on('close', () => {
      this.resolveStop('browser-closed');
    });
    this.session.startUrl = redactUrl(page.url());
    this.capture({ type: 'navigation', at: this.now(), url: page.url() });
    await this.observeNow();
    this.session.initialStateId = this.session.states[0]?.id;
    const maxMs = recording.maxDurationMinutes * 60_000;
    const limit = setTimeout(() => {
      this.resolveStop('max-duration');
    }, maxMs);
    limit.unref();
    void this.stopped.finally(() => {
      clearTimeout(limit);
    });
    this.emit('RECORDING_STARTED', `recording "${this.options.name}" on ${this.session.startUrl}`);
  }

  /** Point de contrôle : « vérifier ici » (CLI, API, ou bandeau). */
  async checkpoint(label?: string): Promise<void> {
    const text =
      (label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) ||
      `checkpoint ${String(this.session.checkpoints.length + 1)}`;
    const event = this.capture({
      type: 'checkpoint',
      at: this.now(),
      url: this.page?.url() ?? '',
      label: text,
    });
    await this.observeNow();
    const state = this.session.states.find((candidate) => candidate.id === event?.stateAfter);
    this.session.checkpoints.push({
      id: `k${String(this.session.checkpoints.length + 1)}`,
      label: text,
      at: this.now(),
      ...(state ? { state } : {}),
      assertions: [],
    });
    this.emit('CHECKPOINT_ADDED', `checkpoint "${text}"${state ? ` on ${state.route}` : ''}`);
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.page
      ?.evaluate(() => {
        (
          window as unknown as { __qaCrawlerRecorder?: { setPaused(value: boolean): void } }
        ).__qaCrawlerRecorder?.setPaused(true);
      })
      .catch(() => undefined);
    this.emit('RECORDING_PAUSED', 'paused');
  }

  async resume(): Promise<void> {
    this.paused = false;
    await this.page
      ?.evaluate(() => {
        (
          window as unknown as { __qaCrawlerRecorder?: { setPaused(value: boolean): void } }
        ).__qaCrawlerRecorder?.setPaused(false);
      })
      .catch(() => undefined);
    this.emit('RECORDING_RESUMED', 'resumed');
  }

  /** Demande l'arrêt (le terminal, l'API). */
  requestStop(reason: StopReason = 'api'): void {
    this.resolveStop(reason);
  }

  /** Le temps de chaque phase de l'arrêt (ms) : le bilan dit où passe le temps. */
  readonly stopTimings: { phase: string; ms: number }[] = [];

  /** Arrête : dernière observation, réseau fermé, puis la session (statut PROCESSING). */
  async stop(): Promise<RecordingSession> {
    if (this.stopping) return this.session;
    this.stopping = true;
    this.resolveStop('api');
    const reason = await this.stopped;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Plus aucun appel IA pour les validations encore en file : un Stop ne les attend pas.
    const validator = this.options.targetValidator;
    validator?.drain();
    const timed = async (phase: string, run: () => Promise<unknown>): Promise<void> => {
      const started = Date.now();
      await run();
      this.stopTimings.push({ phase, ms: Date.now() - started });
    };
    if (this.page && !this.page.isClosed()) {
      const page = this.page;
      // Les saisies en attente dans la page partent maintenant.
      await timed('flush pending input', async () => {
        await page
          .evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
          })
          .catch(() => undefined);
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.config.recording.inputDebounceMs + 50),
        );
      });
      await timed('final screen observation', () => this.observeNow());
    }
    this.closed = true;
    const queued = validator?.pending ?? 0;
    if (queued > 0 || this.pending.size > 0)
      this.emit(
        'RECORDING_STOPPING',
        `finishing ${String(queued)} target validation(s) and ${String(Math.max(0, this.pending.size - queued))} other pending task(s) — no AI call any more`,
      );
    await timed('pending validations and observations', () => Promise.allSettled([...this.pending]));
    if (this.window) await this.closeWindow();
    if (this.page) this.network.detach(this.page);
    dedupeNetwork(this.session.rawEvents);
    this.session.endedAt = new Date(this.now()).toISOString();
    this.session.status = 'PROCESSING';
    this.emit(
      'RECORDING_STOPPED',
      `stopped (${reason}): ${String(this.session.rawEvents.length)} raw event(s)`,
    );
    return this.session;
  }

  /** Les instantanés d'écran (pour la carte des flows) : jamais écrits tels quels. */
  snapshot(observationId: string): UiSnapshot | undefined {
    return this.snapshots.get(observationId);
  }

  // ------------------------------------------------------------------ page

  private watchPage(page: Page): void {
    // La session CDP est ouverte d'emblée : la première navigation n'attend pas sa création.
    this.cdp ??= this.openCdp(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const last = [...this.session.rawEvents].reverse().find((event) => event.type === 'navigation');
      if (last && last.url === redactUrl(frame.url())) return;
      const event = this.capture({ type: 'navigation', at: this.now(), url: frame.url() });
      // Le navigateur dit comment on est arrivé là : adresse tapée, retour arrière, lien, rechargement…
      if (event) {
        // Les requêtes d'historique sont faites dans l'ordre des navigations (index cohérent).
        const url = frame.url();
        this.history = this.history.then(() => this.transitionOf(page, event, url));
        this.track(this.history);
      }
    });
    page.on('dialog', (dialog: Dialog) => {
      void this.answer(dialog);
    });
    page.on('download', (download: Download) => {
      const match = /\.([A-Za-z0-9]{1,8})$/.exec(download.suggestedFilename());
      this.capture({
        type: 'download',
        at: this.now(),
        url: page.url(),
        target: match?.[1] ? `.${match[1].toLowerCase()}` : '(file)',
      });
    });
    page.on('filechooser', () => {
      this.capture({ type: 'filechooser', at: this.now(), url: page.url() });
    });
    page.on('close', () => {
      this.resolveStop('page-closed');
    });
  }

  private cdp: Promise<CDPSession | undefined> | undefined;
  /** Adresses atteintes sans changer de document (pushState, ancre) : jamais une adresse tapée. */
  private readonly withinDocument = new Set<string>();

  /** Session CDP de la page : historique de navigation et navigations internes au document. */
  private async openCdp(page: Page): Promise<CDPSession | undefined> {
    try {
      const cdp = await page.context().newCDPSession(page);
      cdp.on('Page.navigatedWithinDocument', (event: { frameId: string; url: string }) => {
        if (this.withinDocument.size > 500) this.withinDocument.clear();
        this.withinDocument.add(event.url);
      });
      await cdp.send('Page.enable');
      return cdp;
    } catch {
      return undefined;
    }
  }
  private history: Promise<void> = Promise.resolve();
  private historyIndex = -1;

  /**
   * Le type de transition de l'entrée d'historique de CETTE navigation (Chromium) : typed, link,
   * reload, forward_back… L'historique peut ne pas être encore à jour quand la navigation est
   * signalée (machine chargée) : relu jusqu'à ce que l'entrée courante soit la bonne adresse ;
   * une session CDP perdue (changement de processus) est rouverte.
   */
  private async transitionOf(page: Page, event: RawRecordedEvent, url: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const cdp = await this.cdp;
        if (!cdp) return;
        const history = (await cdp.send('Page.getNavigationHistory')) as {
          currentIndex: number;
          entries: { url?: string; transitionType?: string }[];
        };
        const entry = history.entries[history.currentIndex];
        if (entry?.url !== undefined && entry.url !== url && attempt < 7) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          continue;
        }
        let type = entry?.transitionType ?? '';
        // Une entrée créée par pushState hérite du type de la page d'origine (souvent « typed ») :
        // une navigation interne au document est toujours le fait de l'application.
        if (/typed|address_bar|keyword|auto_bookmark/.test(type)) {
          if (!this.withinDocument.has(url)) await new Promise((resolve) => setTimeout(resolve, 100));
          if (this.withinDocument.has(url)) type = 'same_document';
        }
        const back = this.historyIndex >= 0 && history.currentIndex < this.historyIndex;
        this.historyIndex = history.currentIndex;
        event.transition = back ? `${type}|forward_back` : type;
        return;
      } catch {
        // La page a disparu (fin de l'enregistrement) : la corrélation s'en passe.
        if (page.isClosed()) return;
        this.cdp = this.openCdp(page);
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  /** Un dialogue du navigateur pendant l'enregistrement : l'humain a voulu son clic (recording.dialogs). */
  private async answer(dialog: Dialog): Promise<void> {
    const kind = dialog.type();
    // Un prompt() n'est jamais rempli (la saisie serait une donnée) : refusé.
    const accept =
      kind === 'alert' ||
      kind === 'beforeunload' ||
      (kind === 'confirm' && this.options.config.recording.dialogs.confirm === 'accept');
    this.capture({
      type: 'dialog',
      at: this.now(),
      url: this.page?.url() ?? '',
      dialog: { kind, accepted: accept, message: redactText(dialog.message()).slice(0, 120) },
    });
    await (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
  }

  /** SCREEN ELEMENT INVENTORY : chaque écran inventorié pendant l'enregistrement (borné). */
  readonly inventories: ScreenInventory[] = [];

  private onInventory(page: Page | undefined, payload: unknown): void {
    if ((page && page !== this.page) || this.closed || this.paused) return;
    const inventory = sanitizeInventory(payload);
    if (!inventory || this.inventories.length >= 100) return;
    this.inventories.push(inventory);
    const ambiguous = inventory.descriptors.filter((entry) => entry.status === 'AMBIGUOUS').length;
    this.emit(
      'SCREEN_INVENTORY_COMPLETED',
      `${inventory.screen ?? inventory.url}: ${String(inventory.elements)} interactive element(s), ${String(ambiguous)} without a unique selector (${inventory.reason}, ${String(inventory.durationMs)} ms)`,
      { elements: inventory.elements, ambiguous, reason: inventory.reason },
    );
  }

  private onPayload(page: Page | undefined, payload: unknown): void {
    if (page && page !== this.page) return;
    const event = sanitize(payload);
    if (!event) return;
    if (event.type === 'control') {
      if (event.control === 'stop') this.resolveStop('overlay');
      else if (event.control === 'pause') {
        this.paused = true;
        this.emit('RECORDING_PAUSED', 'paused from the page');
      } else if (event.control === 'resume') {
        this.paused = false;
        this.emit('RECORDING_RESUMED', 'resumed from the page');
      } else void this.checkpoint(event.label);
      return;
    }
    if (this.paused) return;
    const captured = this.capture({ ...event, at: event.at ?? this.now() });
    // VALIDATION IMMÉDIATE : tant que l'élément original existe encore (jamais l'action rejouée).
    const ref = isObject(payload) && typeof payload.ref === 'string' ? payload.ref.slice(0, 40) : undefined;
    const validator = this.options.targetValidator;
    // Toute action reçue est connue du validateur : celle qui SUIT une action incertaine en est une preuve.
    if (captured && validator) validator.observe(captured);
    if (captured && validator && page && !captured.noise && (captured.element || captured.drag))
      this.track(
        validator.validate(page, captured, ref).then((result) => {
          if (result) captured.targetValidation = result;
        }),
      );
    // Le texte saisi (données de test) : hors de la trace brute, dans un coffre en mémoire.
    const typed = captured ? typedValueOf(payload, captured) : undefined;
    if (captured && typed !== undefined) this.typedValues.set(captured.id, typed);
  }

  /**
   * Les textes saisis dans les champs non sensibles, par événement brut : la matière des
   * données de test. Jamais écrits dans raw-recording.json, ni journalisés.
   */
  readonly typedValues = new Map<string, string>();

  // ------------------------------------------------------------------ capture

  private capture(
    input: Omit<RawRecordedEvent, 'id' | 'sequence'> & { at: number },
  ): RawRecordedEvent | undefined {
    if (this.closed) return undefined;
    const events = this.session.rawEvents;
    const max = this.options.config.recording.maxRawEvents;
    if (events.length >= max && !ESSENTIAL.has(input.type)) {
      this.session.droppedEvents += 1;
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.session.warnings.push({
          code: 'BUFFER_OVERFLOW',
          message: `more than ${String(max)} raw events: clicks and inputs beyond are dropped (submits, navigations, changes and checkpoints are always kept)`,
        });
      }
      return undefined;
    }
    this.sequence += 1;
    const event: RawRecordedEvent = {
      ...input,
      id: `r${String(this.sequence)}`,
      sequence: this.sequence,
      url: redactUrl(input.url),
    };
    events.push(event);
    this.emit(
      'RAW_EVENT_CAPTURED',
      `${event.type}${event.element ? ` ${event.element.role || event.element.tag} "${event.element.name}"` : ''}`,
      {
        id: event.id,
      },
    );
    // Une action qui peut changer l'écran ou appeler le serveur : sa fenêtre réseau, puis l'écran observé.
    // Un clic sur un élément non reconnu est observé aussi : s'il change l'écran, c'est une action humaine.
    const observed = !event.noise || event.noise === NON_INTERACTIVE_NOISE;
    if (event.type !== 'input' && event.type !== 'keydown' && event.type !== 'filechooser' && observed) {
      // THE NEXT HUMAN ACTION CREATES A STRONG CAUSAL BOUNDARY : les actions encore en attente de leur
      // écran sont observées MAINTENANT, avant les effets de celle-ci (jamais un écran partagé avec elle).
      if (this.awaiting.length > 0) {
        const boundary = this.awaiting;
        this.awaiting = [];
        for (const pending of boundary) pending.observationClosedBy = event.id;
        this.emit(
          'RECORDING_ACTION_WINDOW_CLOSED',
          `${boundary.map((pending) => pending.id).join(', ')} closed by the next human action ${event.id}`,
          { ids: boundary.map((pending) => pending.id), closedBy: event.id },
        );
        this.track(this.observeNow(boundary));
      }
      this.openWindow(event);
      this.awaiting.push(event);
      this.emit('RECORDING_ACTION_WINDOW_OPENED', `${event.id} ${event.type}`, { id: event.id });
      this.schedule();
    }
    return event;
  }

  private openWindow(event: RawRecordedEvent): void {
    const previous = this.window;
    this.window = event;
    this.network.startFunctional(event.id);
    if (previous) this.track(this.assign(previous));
  }

  private async closeWindow(): Promise<void> {
    const open = this.window;
    this.window = undefined;
    if (open) await this.assign(open);
  }

  private async assign(event: RawRecordedEvent): Promise<void> {
    const exchanges: FunctionalExchange[] = await this.network.stopFunctional(event.id);
    event.network = [...(event.network ?? []), ...exchanges];
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  /** L'écran est observé peu après la PREMIÈRE action en attente (jamais repoussé indéfiniment par un humain rapide). */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.track(this.observeNow());
    }, this.options.config.recording.settleMs);
  }

  /** Observe l'écran courant et le donne aux événements qui l'attendent (ou à ceux d'une frontière). */
  private async observeNow(boundary?: RawRecordedEvent[]): Promise<void> {
    if (this.observing) await this.observing.catch(() => undefined);
    const run = this.observe(boundary);
    this.observing = run;
    await run.catch(() => undefined);
  }

  private observations = 0;

  private async observe(boundary?: RawRecordedEvent[]): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed()) return;
    // Les événements arrivés pendant l'observation attendront la suivante.
    const waiting = boundary ?? this.awaiting;
    if (!boundary) this.awaiting = [];
    // À une frontière, l'écran est capté tout de suite : attendre le réseau laisserait entrer les
    // effets de l'action suivante (UI STABILITY DOES NOT PROVE EFFECT OWNERSHIP).
    if (!boundary) await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
    const snapshot = await this.observer.observe(page).catch(() => undefined);
    if (!snapshot) {
      // Une frontière sans écran lisible (page en navigation) : ces actions restent SANS écran d'après,
      // jamais fusionnées avec la suivante.
      if (!boundary) this.awaiting = [...waiting, ...this.awaiting];
      return;
    }
    const detected = this.detector.detect(snapshot);
    const state: RecordedState = {
      id: `o${String(this.session.states.length + 1)}`,
      stateId: detected.stateId,
      label: detected.label,
      route: detected.route,
      url: redactUrl(snapshot.url),
      title: redactText(snapshot.title),
      headings: snapshot.headings.map(redactText),
      alerts: (snapshot.signals?.alerts ?? []).map(redactText),
      invalidFields: snapshot.signals?.invalidFields ?? 0,
      dialogs: snapshot.dialogs,
      controls: snapshot.elements
        .filter((element) => element.visible && element.role)
        .map((element) => `${element.role}:${element.name}`)
        .slice(0, 300),
      ...(snapshot.structure ? { tableRows: snapshot.structure.tableRows } : {}),
      observedAt: this.now(),
    };
    // Le même écran, inchangé : l'observation précédente suffit (la session reste bornée).
    const previous = this.session.states.at(-1);
    const same = previous !== undefined && sameObservation(previous, state);
    if (!same && this.session.states.length < MAX_OBSERVATIONS) {
      this.session.states.push(state);
      this.snapshots.set(state.id, snapshot);
    }
    const kept = same || this.session.states.length >= MAX_OBSERVATIONS ? (previous ?? state) : state;
    // L'IDENTITÉ de cette observation (distincte de l'écran : deux observations d'un écran inchangé ne
    // sont pas UNE observation partagée — seules les actions de la même observation se la disputent).
    this.observations += 1;
    const observationId = `v${String(this.observations)}`;
    for (const event of waiting) {
      event.stateAfter = kept.id;
      event.observationId = observationId;
    }
    // L'écran est stable : la fenêtre réseau de la dernière action se ferme.
    if (this.window && waiting.includes(this.window)) await this.closeWindow();
  }

  private emit(type: RecordingEventType, message: string, data?: Record<string, unknown>): void {
    this.options.onEvent?.({
      type,
      at: new Date(this.now()).toISOString(),
      message,
      ...(data ? { data } : {}),
    });
  }
}

const MAX_OBSERVATIONS = 1000;

function sameObservation(a: RecordedState, b: RecordedState): boolean {
  return (
    a.stateId === b.stateId &&
    a.url === b.url &&
    a.tableRows === b.tableRows &&
    a.invalidFields === b.invalidFields &&
    a.alerts.join('\n') === b.alerts.join('\n') &&
    a.dialogs.join('\n') === b.dialogs.join('\n') &&
    // L'empreinte de l'écran ne voit pas une section ouverte, un onglet, des champs devenus
    // visibles : les contrôles visibles, si (HUMAN JOURNEY : ce sont les effets d'un clic).
    a.controls.join('\n') === b.controls.join('\n')
  );
}

/**
 * Une requête vue dans deux fenêtres (une action a commencé avant que la précédente ne
 * se ferme) appartient à la plus récente.
 */
export function dedupeNetwork(events: RawRecordedEvent[]): void {
  const seen = new Set<FunctionalExchange>();
  for (const event of [...events].reverse()) {
    if (!event.network) continue;
    event.network = event.network.filter((exchange) => {
      if (seen.has(exchange)) return false;
      seen.add(exchange);
      return true;
    });
  }
}

// ------------------------------------------------------------------ données venues de la page

/**
 * Le texte saisi envoyé par la page, s'il peut devenir une donnée de test : champ NON sensible
 * (pour la page ET pour le serveur), et pas une valeur qui ressemble à un secret (jeton, clé).
 */
export function typedValueOf(payload: unknown, event: RawRecordedEvent): string | undefined {
  if (!isObject(payload) || !isObject(payload.value)) return undefined;
  const raw = payload.value.text;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 10_000) return undefined;
  if (event.type !== 'input' && event.type !== 'change') return undefined;
  if (event.value?.sensitive || event.value?.option || event.value?.checked !== undefined) return undefined;
  const element = event.element;
  if (!element) return undefined;
  const label = element.label ?? element.name;
  const verdict = sensitivityOf({
    ...(element.inputType ? { inputType: element.inputType } : {}),
    ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
    ...(label ? { label } : {}),
    ...(element.nameAttr ? { name: element.nameAttr } : {}),
    ...(element.placeholder ? { placeholder: element.placeholder } : {}),
    ...(element.elementId ? { elementId: element.elementId } : {}),
  });
  if (verdict.sensitive || looksSecret(raw)) return undefined;
  return raw;
}

/** Un jeton, une clé d'API, un JWT : jamais gardé, même tapé dans un champ ordinaire. */
export function looksSecret(value: string): boolean {
  const text = value.trim();
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(text)) return true;
  if (/^(sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}$/.test(text)) return true;
  // Une longue suite sans espace mêlant lettres et chiffres (hex, base64) : un secret probable.
  return /^[A-Za-z0-9+/=_-]{32,}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);
}

/**
 * Ce que la page envoie est une donnée NON FIABLE (la page peut appeler la fonction) :
 * types vérifiés, textes bornés, rien d'autre n'est gardé.
 */
export function sanitize(
  payload: unknown,
): (Omit<RawRecordedEvent, 'id' | 'sequence' | 'at'> & { at?: number }) | undefined {
  if (!isObject(payload)) return undefined;
  const type = payload.type;
  if (typeof type !== 'string' || !RAW_TYPES.has(type as RawEventType)) return undefined;
  const url = typeof payload.url === 'string' ? payload.url.slice(0, 2000) : '';
  const at = typeof payload.at === 'number' && Number.isFinite(payload.at) ? payload.at : undefined;
  const element = isObject(payload.element) ? elementOf(payload.element) : undefined;
  const value = isObject(payload.value) ? valueOf(payload.value) : undefined;
  const control = payload.control;
  return {
    type: type as RawEventType,
    url,
    ...(at !== undefined ? { at } : {}),
    ...(element ? { element } : {}),
    ...(value ? { value } : {}),
    ...(typeof payload.key === 'string' && ['Enter', 'Escape'].includes(payload.key)
      ? { key: payload.key }
      : {}),
    ...(typeof payload.label === 'string' ? { label: text(payload.label, 80) } : {}),
    ...(control === 'stop' || control === 'pause' || control === 'resume' || control === 'checkpoint'
      ? { control }
      : {}),
    ...(typeof payload.noise === 'string' ? { noise: text(payload.noise, 80) } : {}),
    ...(typeof payload.activeDomInstance === 'string' && /^e\d{1,9}$/.test(payload.activeDomInstance)
      ? { activeDomInstance: payload.activeDomInstance }
      : {}),
    ...(type === 'drag' && isObject(payload.drag) ? dragOf(payload.drag) : {}),
    ...(isObject(payload.pre) ? { pre: preOf(payload.pre) } : {}),
  };
}

/** Le contexte pré-action envoyé par la page : textes d'interface bornés et expurgés, nombres stricts. */
function preOf(raw: Record<string, unknown>): PreActionContext {
  const str = (value: unknown, max: number): string =>
    typeof value === 'string' ? redactText(text(value, max)) : '';
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(10_000, Math.round(value)))
      : 0;
  const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
  const dialog = str(raw.dialog, 60);
  const activeTab = str(raw.activeTab, 60);
  return {
    route: str(raw.route, 200),
    title: str(raw.title, 80),
    ...(dialog ? { dialog } : {}),
    headings: list(raw.headings, 5)
      .map((entry) => str(entry, 60))
      .filter(Boolean),
    cssCount: num(raw.cssCount),
    sameText: num(raw.sameText),
    selected: list(raw.selected, 6)
      .filter(isObject)
      .map((entry) => ({ label: str(entry.label, 60), value: str(entry.value, 60) }))
      .filter((entry) => entry.label && entry.value),
    ...(activeTab ? { activeTab } : {}),
    peers: list(raw.peers, 6)
      .filter(isObject)
      .map((entry) => {
        const section = str(entry.section, 180);
        return { role: str(entry.role, 30), name: str(entry.name, 60), ...(section ? { section } : {}) };
      }),
    loading: raw.loading === true,
    ...(Array.isArray(raw.controls)
      ? {
          controls: list(raw.controls, 150)
            .map((entry) => str(entry, 60))
            .filter(Boolean),
        }
      : {}),
    ...(typeof raw.phase === 'string' && /^[A-Z_]{3,20}$/.test(raw.phase) ? { phase: raw.phase } : {}),
    ...(typeof raw.generation === 'number' ? { generation: num(raw.generation) } : {}),
    ...(typeof raw.sentGeneration === 'number' ? { sentGeneration: num(raw.sentGeneration) } : {}),
    ...(typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt)
      ? { capturedAt: raw.capturedAt }
      : {}),
    ...(typeof raw.captureId === 'string' ? { captureId: text(raw.captureId, 40) } : {}),
    ...(isObject(raw.target)
      ? {
          target: {
            ...candidateOf(raw.target, str),
            captureId: typeof raw.target.captureId === 'string' ? text(raw.target.captureId, 40) : '',
            ...optionalText('ariaLabel', raw.target.ariaLabel, str),
            ...optionalText('ariaLabelledBy', raw.target.ariaLabelledBy, str),
            ...optionalText('ariaDescription', raw.target.ariaDescription, str),
          },
        }
      : {}),
    ...(Array.isArray(raw.candidates)
      ? {
          candidates: list(raw.candidates, 40)
            .filter(isObject)
            .map((entry) => candidateOf(entry, str)),
        }
      : {}),
    ...(Array.isArray(raw.dropZones)
      ? {
          dropZones: list(raw.dropZones, 6)
            .filter(isObject)
            .map((zone) => {
              const section = str(zone.section, 180);
              const label = str(zone.label, 60);
              return {
                id: typeof zone.id === 'string' && /^D\d$/.test(zone.id) ? zone.id : 'D?',
                origin: zone.origin === 'SOURCE' ? ('SOURCE' as const) : ('CONTEXT' as const),
                ...(section ? { section } : {}),
                ...(label ? { label } : {}),
                itemCount: num(zone.itemCount),
              };
            }),
        }
      : {}),
    ...(typeof raw.originalCandidateId === 'string' && /^T\d{1,2}$/.test(raw.originalCandidateId)
      ? { originalCandidateId: raw.originalCandidateId }
      : {}),
  };
}

function optionalText(
  key: string,
  value: unknown,
  str: (value: unknown, max: number) => string,
): Record<string, string> {
  const cleaned = str(value, 80);
  return cleaned ? { [key]: cleaned } : {};
}

const RELATIONSHIPS = new Set(['SELF', 'SAME_FORM', 'SAME_DIALOG', 'SAME_SECTION', 'SAME_ROLE']);

/** Un candidat pré-action : textes d'interface bornés et expurgés ; jamais une valeur saisie. */
function candidateOf(
  raw: Record<string, unknown>,
  str: (value: unknown, max: number) => string,
): PreActionCandidate {
  const attributes: Record<string, string> = {};
  if (isObject(raw.stableAttributes))
    for (const [key, value] of Object.entries(raw.stableAttributes).slice(0, 8))
      if (/^[a-z-]{1,20}$/.test(key) && str(value, 60)) attributes[key] = str(value, 60);
  const relationship =
    typeof raw.relationship === 'string' && RELATIONSHIPS.has(raw.relationship)
      ? (raw.relationship as PreActionCandidate['relationship'])
      : 'SAME_ROLE';
  const container = isObject(raw.container) ? raw.container : undefined;
  const containerLabel = container ? str(container.label, 60) : '';
  const nearby = Array.isArray(raw.nearby)
    ? raw.nearby
        .slice(0, 4)
        .map((entry) => str(entry, 60))
        .filter(Boolean)
    : [];
  const optional = (key: string, value: unknown, max: number): Record<string, string> => {
    const cleaned = str(value, max);
    return cleaned ? { [key]: cleaned } : {};
  };
  return {
    id: typeof raw.id === 'string' && /^T\d{1,2}$/.test(raw.id) ? raw.id : 'T?',
    origin: relationship === 'SELF' ? 'ORIGINAL_HUMAN_TARGET' : 'CONTEXT',
    relationship,
    tag: str(raw.tag, 30),
    role: str(raw.role, 30),
    name: str(raw.name, 60),
    ...optional('label', raw.label, 60),
    ...optional('text', raw.text, 60),
    stableAttributes: attributes,
    visible: raw.visible === true,
    enabled: raw.enabled !== false,
    editable: raw.editable === true,
    ...optional('component', raw.component, 40),
    ...optional('form', raw.form, 60),
    ...optional('section', raw.section, 180),
    ...optional('dialog', raw.dialog, 60),
    ...(container && typeof container.tag === 'string'
      ? { container: { tag: str(container.tag, 30), ...(containerLabel ? { label: containerLabel } : {}) } }
      : {}),
    ...(nearby.length > 0 ? { nearby } : {}),
    ...optional('cssHint', raw.cssHint, 200),
  };
}

/** Le glisser-déposer envoyé par la page : textes d'interface bornés et expurgés, booléens stricts. */
function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, 10)
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => redactText(text(entry, 60)))
    : [];
}

function dragOf(raw: Record<string, unknown>): { drag: RecordedDrag } | Record<string, never> {
  const item = typeof raw.item === 'string' ? redactText(text(raw.item, 60)) : '';
  if (!item) return {};
  const zone = (value: unknown): RecordedDropZone | undefined => {
    if (!isObject(value)) return undefined;
    const section =
      typeof value.section === 'string' && value.section ? redactText(text(value.section, 180)) : undefined;
    const label =
      typeof value.label === 'string' && value.label ? redactText(text(value.label, 60)) : undefined;
    return section || label ? { ...(section ? { section } : {}), ...(label ? { label } : {}) } : undefined;
  };
  const source = zone(raw.source);
  const destination = zone(raw.destination);
  return {
    drag: {
      kind: raw.kind === 'HTML5' ? 'HTML5' : 'POINTER',
      item,
      ...(source ? { source } : {}),
      ...(destination ? { destination } : {}),
      sameZone: raw.sameZone === true,
      moved: raw.moved === true,
      ...(isObject(raw.lists)
        ? {
            lists: {
              sourceBefore: texts(raw.lists.sourceBefore),
              sourceAfter: texts(raw.lists.sourceAfter),
              destinationAfter: texts(raw.lists.destinationAfter),
              ...(Array.isArray(raw.lists.destinationBefore)
                ? { destinationBefore: texts(raw.lists.destinationBefore) }
                : {}),
            },
          }
        : {}),
      ...(typeof raw.destinationCandidateId === 'string' && /^D\d$/.test(raw.destinationCandidateId)
        ? { destinationCandidateId: raw.destinationCandidateId }
        : {}),
    },
  };
}

function elementOf(raw: Record<string, unknown>): RecordedElement {
  const str = (key: string, max = 120): string | undefined =>
    typeof raw[key] === 'string' && raw[key] !== '' ? text(raw[key], max) : undefined;
  const num = (key: string): number =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] : 0;
  const bool = (key: string): boolean => raw[key] === true;
  const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
    value === undefined ? {} : { [key]: value };
  return {
    tag: str('tag', 40) ?? 'element',
    role: str('role', 40) ?? '',
    name: redactText(str('name') ?? ''),
    ...optional('text', str('text', 80) ? redactText(str('text', 80) ?? '') : undefined),
    ...optional('label', str('label') ? redactText(str('label') ?? '') : undefined),
    ...optional('guessedLabel', str('guessedLabel') ? redactText(str('guessedLabel') ?? '') : undefined),
    ...optional('testId', str('testId', 120)),
    ...optional(
      'testIdAttribute',
      TEST_ID_ATTRIBUTES.includes(str('testIdAttribute', 40) ?? '') ? str('testIdAttribute', 40) : undefined,
    ),
    ...optional('nameAttr', str('nameAttr', 120)),
    ...optional('formControlName', str('formControlName', 120)),
    ...optional('elementId', str('elementId', 120)),
    ...(bool('generatedId') ? { generatedId: true } : {}),
    ...optional('inputType', str('inputType', 40)),
    ...optional('autocomplete', str('autocomplete', 60)),
    ...optional('placeholder', str('placeholder') ? redactText(str('placeholder') ?? '') : undefined),
    ...optional('href', str('href', 2000) ? redactUrl(str('href', 2000) ?? '') : undefined),
    css: str('css', 400) ?? '',
    cssStable: bool('cssStable'),
    inForm: bool('inForm'),
    isSubmit: bool('isSubmit'),
    inNavigation: bool('inNavigation'),
    inDialog: bool('inDialog'),
    ...optional('dialogName', str('dialogName', 80)),
    ...optional('groupLabel', str('groupLabel', 80)),
    sameRoleName: num('sameRoleName'),
    roleNameIndex: num('roleNameIndex'),
    sameLabel: num('sameLabel'),
    ...(bool('contentEditable') ? { contentEditable: true } : {}),
    ...(bool('customSelect') ? { customSelect: true } : {}),
    ...(bool('required') ? { required: true } : {}),
    ...(bool('readOnly') ? { readOnly: true } : {}),
    ...optional('context', str('context', 60) ? redactText(str('context', 60) ?? '') : undefined),
    ...(Array.isArray(raw.sectionPath)
      ? {
          sectionPath: raw.sectionPath
            .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
            .slice(0, 3)
            .map((entry) => redactText(text(entry, 60))),
        }
      : {}),
    ...(num('sameLabelInSection') > 0 ? { sameLabelInSection: num('sameLabelInSection') } : {}),
    ...optional(
      'componentTag',
      /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(str('componentTag', 80) ?? '')
        ? str('componentTag', 80)
        : undefined,
    ),
    ...(bool('inShadow') ? { inShadow: true } : {}),
    ...(bool('hasOptions') ? { hasOptions: true } : {}),
    // IDENTITÉ CONTEXTUALISÉE / FIELD IDENTITY : le libellé du champ fonctionnel, le voisinage, un id
    // dupliqué, l'instance DOM de l'enregistreur, l'unicité du CSS, le profil de saisie.
    ...optional('formField', str('formField', 60) ? redactText(str('formField', 60) ?? '') : undefined),
    ...(Array.isArray(raw.nearbyText)
      ? {
          nearbyText: raw.nearbyText
            .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
            .slice(0, 6)
            .map((entry) => redactText(text(entry, 40))),
        }
      : {}),
    ...(num('sameId') > 1 ? { sameId: num('sameId') } : {}),
    ...optional(
      'domInstance',
      /^e\d{1,9}$/.test(str('domInstance', 12) ?? '') ? str('domInstance', 12) : undefined,
    ),
    ...(num('cssMatches') > 1
      ? {
          cssMatches: num('cssMatches'),
          ...(typeof raw.cssIndex === 'number' ? { cssIndex: num('cssIndex') } : {}),
        }
      : {}),
    ...(num('maxLength') > 0 ? { maxLength: num('maxLength') } : {}),
    ...optional(
      'inputMode',
      /^[a-z]{1,20}$/.test(str('inputMode', 20) ?? '') ? str('inputMode', 20) : undefined,
    ),
    ...optional('pattern', str('pattern', 120)),
    // INTERACTION OWNER et contexte structurel (textes d'interface, expurgés).
    ...optional(
      'ownerKind',
      /^(dialog|tab|accordion|form|fieldset|card|row|menu|listbox|toolbar|section|component)$/.test(
        str('ownerKind', 20) ?? '',
      )
        ? str('ownerKind', 20)
        : undefined,
    ),
    ...optional('ownerName', str('ownerName', 60) ? redactText(str('ownerName', 60) ?? '') : undefined),
    ...optional('tab', str('tab', 60) ? redactText(str('tab', 60) ?? '') : undefined),
    ...(typeof raw.tabSelected === 'boolean' ? { tabSelected: raw.tabSelected } : {}),
    ...optional('accordion', str('accordion', 60) ? redactText(str('accordion', 60) ?? '') : undefined),
    ...(typeof raw.accordionExpanded === 'boolean' ? { accordionExpanded: raw.accordionExpanded } : {}),
    ...optional('form', str('form', 60) ? redactText(str('form', 60) ?? '') : undefined),
    ...optional('row', str('row', 40) ? redactText(str('row', 40) ?? '') : undefined),
    ...optional(
      'listboxOwner',
      str('listboxOwner', 60) ? redactText(str('listboxOwner', 60) ?? '') : undefined,
    ),
    ...optional('menu', str('menu', 60) ? redactText(str('menu', 60) ?? '') : undefined),
    ...(typeof raw.checked === 'boolean' ? { checked: raw.checked } : {}),
    ...(raw.formControlFromHost === true ? { formControlFromHost: true } : {}),
    ...(isObject(raw.hostIdentity) ? hostIdentityOf(raw.hostIdentity) : {}),
    ...(isObject(raw.selectors) ? selectorsOf(raw.selectors) : {}),
  };
}

const KINDS =
  /^(TEST_ID|STABLE_ID|FORM_CONTROL|NAME|ARIA|HOST_BINDING|CONTEXTUAL|COMPONENT|STABLE_CLASS|STRUCTURAL)$/;

/** Un candidat CSS envoyé par la page : un sélecteur borné et expurgé, des nombres vérifiés. */
function cssCandidateOf(raw: unknown): RecordedCssCandidate | undefined {
  if (!isObject(raw) || typeof raw.selector !== 'string' || raw.selector === '') return undefined;
  const number = (value: unknown, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : 0;
  return {
    selector: redactText(text(raw.selector, 400)),
    kind: typeof raw.kind === 'string' && KINDS.test(raw.kind) ? raw.kind : 'STRUCTURAL',
    matchCount: Math.round(number(raw.matchCount, 100_000)),
    confidence: number(raw.confidence, 1),
    ...(raw.dynamic === true ? { dynamic: true } : {}),
    ...(raw.structural === true ? { structural: true } : {}),
  };
}

function selectorsOf(raw: Record<string, unknown>): { selectors?: RecordedSelectors } {
  const structural = cssCandidateOf(raw.structural);
  if (!structural) return {};
  const preferred = cssCandidateOf(raw.preferred);
  const ambiguity = isObject(raw.ambiguity) ? raw.ambiguity : {};
  const level = ambiguity.level;
  return {
    selectors: {
      ...(preferred ? { preferred } : {}),
      structural,
      candidates: (Array.isArray(raw.candidates) ? raw.candidates : [])
        .slice(0, 5)
        .map(cssCandidateOf)
        .filter((entry): entry is RecordedCssCandidate => entry !== undefined),
      ambiguity: {
        level: level === 'NONE' || level === 'LOW' || level === 'MEDIUM' || level === 'HIGH' ? level : 'HIGH',
        reasons: (Array.isArray(ambiguity.reasons) ? ambiguity.reasons : [])
          .filter((reason): reason is string => typeof reason === 'string' && /^[A-Z_]{3,30}$/.test(reason))
          .slice(0, 6),
        structuralMatches:
          typeof ambiguity.structuralMatches === 'number' && Number.isFinite(ambiguity.structuralMatches)
            ? Math.max(0, Math.round(ambiguity.structuralMatches))
            : 0,
      },
      inventory: raw.inventory === 'INVENTORY' ? 'INVENTORY' : 'LOCAL',
    },
  };
}

function hostIdentityOf(raw: Record<string, unknown>): { hostIdentity?: RecordedElement['hostIdentity'] } {
  if (
    typeof raw.tag !== 'string' ||
    !/^[a-z][a-z0-9-]{0,60}$/.test(raw.tag) ||
    typeof raw.attribute !== 'string' ||
    !/^[a-z][a-z-]{0,30}$/.test(raw.attribute) ||
    typeof raw.value !== 'string' ||
    raw.value === ''
  )
    return {};
  return {
    hostIdentity: {
      tag: raw.tag,
      attribute: raw.attribute,
      value: redactText(text(raw.value, 80)),
      depth: typeof raw.depth === 'number' && Number.isFinite(raw.depth) ? Math.round(raw.depth) : 0,
    },
  };
}

/** L'inventaire d'un écran envoyé par la page : bornée, expurgée, jamais une valeur saisie. */
export function sanitizeInventory(payload: unknown): ScreenInventory | undefined {
  if (!isObject(payload) || !Array.isArray(payload.descriptors)) return undefined;
  const count = (value: unknown, max = 100_000): number | undefined =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(Math.round(value), max))
      : undefined;
  const descriptors = payload.descriptors
    .slice(0, 150)
    .filter(isObject)
    .map((raw): ScreenInventoryElement => {
      const str = (key: string, max = 120): string | undefined =>
        typeof raw[key] === 'string' && raw[key] !== '' ? redactText(text(raw[key], max)) : undefined;
      return {
        elementId: /^[A-Z]{3,10}-\d{3}$/.test(String(raw.elementId)) ? String(raw.elementId) : 'ELEMENT-000',
        kind: /^[A-Z]{3,10}$/.test(String(raw.kind)) ? String(raw.kind) : 'ELEMENT',
        tag: /^[a-z][a-z0-9-]{0,60}$/.test(String(raw.tag)) ? String(raw.tag) : 'element',
        ...(str('role', 30) ? { role: str('role', 30) } : {}),
        ...(str('label', 60) ? { label: str('label', 60) } : {}),
        ...(str('formControlName', 80) ? { formControlName: str('formControlName', 80) } : {}),
        ...(str('preferredCss', 400) ? { preferredCss: str('preferredCss', 400) } : {}),
        ...(count(raw.preferredMatches) !== undefined
          ? { preferredMatches: count(raw.preferredMatches) }
          : {}),
        ...(typeof raw.confidence === 'number'
          ? { confidence: Math.max(0, Math.min(raw.confidence, 1)) }
          : {}),
        ...(str('structuralCss', 400) ? { structuralCss: str('structuralCss', 400) } : {}),
        ...(count(raw.structuralMatches) !== undefined
          ? { structuralMatches: count(raw.structuralMatches) }
          : {}),
        ...(typeof raw.ambiguity === 'string' && /^(NONE|LOW|MEDIUM|HIGH)$/.test(raw.ambiguity)
          ? { ambiguity: raw.ambiguity }
          : {}),
        ...(Array.isArray(raw.reasons)
          ? {
              reasons: raw.reasons
                .filter(
                  (reason): reason is string => typeof reason === 'string' && /^[A-Z_]{3,30}$/.test(reason),
                )
                .slice(0, 6),
            }
          : {}),
        status: raw.status === 'UNIQUE' ? 'UNIQUE' : 'AMBIGUOUS',
      };
    });
  return {
    at: count(payload.at, Number.MAX_SAFE_INTEGER) ?? 0,
    url: typeof payload.url === 'string' ? redactUrl(payload.url.slice(0, 2000)) : '',
    ...(typeof payload.screen === 'string' && payload.screen !== ''
      ? { screen: redactText(text(payload.screen, 80)) }
      : {}),
    reason: /^[A-Z_]{3,30}$/.test(String(payload.reason)) ? String(payload.reason) : 'SCREEN_ARRIVED',
    elements: descriptors.length,
    durationMs: count(payload.durationMs, 600_000) ?? 0,
    descriptors,
  };
}

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

const SHAPES = new Set(['email', 'number', 'date', 'phone', 'url', 'code', 'text', 'empty']);

function valueOf(raw: Record<string, unknown>): RecordedValueFacts {
  const shape =
    typeof raw.shape === 'string' && SHAPES.has(raw.shape)
      ? (raw.shape as RecordedValueFacts['shape'])
      : 'text';
  const sensitive = raw.sensitive === true;
  const option = isObject(raw.option) && typeof raw.option.label === 'string' ? raw.option : undefined;
  const digest = (key: string): string | undefined =>
    !sensitive && typeof raw[key] === 'string' && /^[0-9a-f]{16}$/.test(raw[key]) ? raw[key] : undefined;
  return {
    empty: raw.empty === true,
    length: typeof raw.length === 'number' && Number.isFinite(raw.length) ? Math.min(raw.length, 100_000) : 0,
    shape,
    ...(digest('digest') ? { digest: digest('digest') } : {}),
    ...(digest('initialDigest') ? { initialDigest: digest('initialDigest') } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    ...(option && !sensitive
      ? {
          option: {
            label: redactText(text(option.label as string, 120)),
            ...(typeof option.value === 'string' && option.value !== ''
              ? { value: text(option.value, 60) }
              : {}),
          },
        }
      : {}),
    ...(typeof raw.checked === 'boolean' ? { checked: raw.checked } : {}),
    ...(typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt)
      ? { startedAt: raw.startedAt }
      : {}),
    ...(Array.isArray(raw.files)
      ? {
          files: raw.files
            .filter((ext): ext is string => typeof ext === 'string' && /^[a-z0-9]{0,8}$/.test(ext))
            .slice(0, 10),
        }
      : {}),
  };
}

function text(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
