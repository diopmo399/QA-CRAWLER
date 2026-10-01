import type { BrowserContext, Dialog, Download, Page } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';
import { FormKnowledgeObserver } from '../forms/state/form-knowledge-observer.js';
import { newValueSalt } from '../forms/state/value-digest.js';
import type { FunctionalExchange } from '../functional/model.js';
import { NavigationGuard } from '../navigation/navigation-guard.js';
import { StateDetector } from '../observation/state-detector.js';
import { UIObserver } from '../observation/ui-observer.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { SafetyPolicy } from '../policies/safety-policy.js';
import { redactText, redactUrl } from '../security/redactor.js';
import { captureScript } from './capture-script.js';
import type {
  RawEventType,
  RawRecordedEvent,
  RecordedElement,
  RecordedState,
  RecordedValueFacts,
  RecordingEvent,
  RecordingEventType,
  RecordingSession,
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
const RAW_TYPES = new Set<RawEventType>(['click', 'input', 'change', 'submit', 'keydown', 'control']);

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
    const script = captureScript({
      binding: BINDING,
      salt: this.salt,
      overlay: recording.overlay,
      inputDebounceMs: recording.inputDebounceMs,
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

  /** Arrête : dernière observation, réseau fermé, puis la session (statut PROCESSING). */
  async stop(): Promise<RecordingSession> {
    if (this.stopping) return this.session;
    this.stopping = true;
    this.resolveStop('api');
    const reason = await this.stopped;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.page && !this.page.isClosed()) {
      // Les saisies en attente dans la page partent maintenant.
      await this.page
        .evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
        })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, this.options.config.recording.inputDebounceMs + 50));
      await this.observeNow();
    }
    this.closed = true;
    await Promise.allSettled([...this.pending]);
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
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const last = [...this.session.rawEvents].reverse().find((event) => event.type === 'navigation');
      if (last && last.url === redactUrl(frame.url())) return;
      this.capture({ type: 'navigation', at: this.now(), url: frame.url() });
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
    this.capture({ ...event, at: event.at ?? this.now() });
  }

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
    if (event.type !== 'input' && event.type !== 'keydown' && event.type !== 'filechooser' && !event.noise) {
      this.openWindow(event);
      this.awaiting.push(event);
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

  /** Observe l'écran courant et le donne aux événements qui l'attendent. */
  private async observeNow(): Promise<void> {
    if (this.observing) await this.observing.catch(() => undefined);
    const run = this.observe();
    this.observing = run;
    await run.catch(() => undefined);
  }

  private async observe(): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed()) return;
    // Les événements arrivés pendant l'observation attendront la suivante.
    const waiting = this.awaiting;
    this.awaiting = [];
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
    const snapshot = await this.observer.observe(page).catch(() => undefined);
    if (!snapshot) {
      this.awaiting = [...waiting, ...this.awaiting];
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
    };
    // Le même écran, inchangé : l'observation précédente suffit (la session reste bornée).
    const previous = this.session.states.at(-1);
    const same = previous !== undefined && sameObservation(previous, state);
    if (!same && this.session.states.length < MAX_OBSERVATIONS) {
      this.session.states.push(state);
      this.snapshots.set(state.id, snapshot);
    }
    const kept = same || this.session.states.length >= MAX_OBSERVATIONS ? (previous ?? state) : state;
    for (const event of waiting) event.stateAfter = kept.id;
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
    a.dialogs.join('\n') === b.dialogs.join('\n')
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
    ...(bool('hasOptions') ? { hasOptions: true } : {}),
  };
}

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
