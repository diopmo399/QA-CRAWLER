import { createQaCrawler, QaCrawlerError, type QaCrawlerClient, type Subscription } from '../core/client.js';
import type { ExplorationEvent } from '../core/contracts.js';
import { MONITOR_EVENTS } from '../core/contracts.js';
import { isTerminal } from '../core/lifecycle.js';
import { monitorStrings } from './monitor-i18n.js';
import { EMPTY_VIEW, type MonitorView } from './monitor-model.js';
import { MONITOR_CSS } from './monitor-styles.js';
import { renderMonitor, type ConnectionState, type MonitorState } from './monitor-view.js';

/**
 * <qa-crawler-run-monitor> — le suivi en direct d'une exploration : statut, compteurs, avancement de
 * chaque flow imposé, et le journal des événements du moteur, à afficher par flow, statut d'étape,
 * type d'événement ou type d'anomalie.
 *
 * Le flux coupé (réseau, serveur redémarré) est rouvert après le dernier événement reçu, sans doublon
 * (client du SDK) ; l'état de la connexion est annoncé. Rien n'est estimé : un compte est un nombre
 * d'événements reçus, un flow sans événement de fin est « en cours ».
 *
 * Attributs : endpoint (API du serveur SDK), exploration (identifiant), locale (fr | en).
 * Propriétés : token (jamais en attribut dans une page publique), client (un client déjà construit).
 * Événements (bubbles, composed) : qa-monitor-connection `{ state, attempt }`, qa-error.
 */
const Base: typeof HTMLElement =
  'HTMLElement' in globalThis ? globalThis.HTMLElement : (Object as unknown as typeof HTMLElement);

/** Les événements gardés en mémoire (les plus anciens sortent au-delà). */
const MAX_EVENTS = 5000;
const VIEW_KEYS: readonly (keyof MonitorView)[] = ['flow', 'stepStatus', 'type', 'issueType'];

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class QaCrawlerRunMonitor extends Base {
  static get observedAttributes(): string[] {
    return ['endpoint', 'exploration', 'locale'];
  }

  private root!: ShadowRoot;
  private state!: MonitorState;
  private injectedClient?: QaCrawlerClient;
  private ownClient?: QaCrawlerClient;
  private tokenValue?: string;
  private connected = false;
  private loadQueued = false;
  private subscription?: Subscription;
  private paintQueued = false;
  /** Chaque abonnement porte un numéro : les événements d'un abonnement remplacé sont ignorés. */
  private generation = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.state = {
      t: monitorStrings(this.getAttribute('locale')),
      phase: 'idle',
      events: [],
      connection: 'connecting',
      attempt: 0,
      view: { ...EMPTY_VIEW },
    };
    this.root.addEventListener('change', (event) => {
      this.onChange(event);
    });
  }

  set token(value: string | undefined) {
    if (value === this.tokenValue) return;
    this.tokenValue = value;
    this.resetClient();
    if (this.connected) this.queueLoad();
  }

  get token(): string | undefined {
    return this.tokenValue;
  }

  set client(value: QaCrawlerClient | undefined) {
    this.injectedClient = value;
    this.resetClient();
    if (this.connected) this.queueLoad();
  }

  /** Les événements reçus (copie). */
  get events(): ExplorationEvent[] {
    return structuredClone(this.state.events);
  }

  connectedCallback(): void {
    this.connected = true;
    this.queueLoad();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.stop();
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'locale') {
      this.state.t = monitorStrings(next);
      this.paint();
      return;
    }
    if (name === 'endpoint') this.resetClient();
    if (this.connected) this.queueLoad();
  }

  private get api(): QaCrawlerClient | undefined {
    if (this.injectedClient) return this.injectedClient;
    if (!this.ownClient) {
      const endpoint = this.getAttribute('endpoint');
      if (!endpoint) return undefined;
      this.ownClient = createQaCrawler({ endpoint, ...(this.tokenValue ? { token: this.tokenValue } : {}) });
    }
    return this.ownClient;
  }

  private resetClient(): void {
    this.stop();
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  private stop(): void {
    this.generation += 1;
    this.subscription?.close();
    this.subscription = undefined;
  }

  private queueLoad(): void {
    if (this.loadQueued) return;
    this.loadQueued = true;
    queueMicrotask(() => {
      this.loadQueued = false;
      if (this.connected) void this.load();
    });
  }

  private async load(): Promise<void> {
    this.stop();
    const id = this.getAttribute('exploration');
    this.state.events = [];
    this.state.view = { ...EMPTY_VIEW };
    if (!id) {
      this.state.phase = 'idle';
      this.paint();
      return;
    }
    if (!this.injectedClient && !this.tokenValue) return;
    const api = this.api;
    if (!api) {
      this.state.phase = 'error';
      this.state.error = 'endpoint attribute missing';
      this.paint();
      return;
    }
    const ticket = this.generation;
    this.state.phase = 'loading';
    this.paint();
    try {
      this.state.snapshot = await api.explorations.status(id);
    } catch (error) {
      if (ticket !== this.generation) return;
      this.state.phase = 'error';
      this.state.error = message(error);
      this.fail(error);
      this.paint();
      return;
    }
    if (ticket !== this.generation) return;
    this.state.phase = 'ready';
    this.setConnection('connecting', 0);
    let lost = false;
    this.subscription = api.explorations.subscribe(
      id,
      (event) => {
        if (ticket !== this.generation) return;
        this.receive(event);
      },
      {
        reconnect: { retries: 5, delayMs: 500 },
        onReconnect: (attempt) => {
          if (ticket === this.generation) this.setConnection('reconnecting', attempt);
        },
        onError: (error) => {
          if (ticket !== this.generation) return;
          lost = true;
          this.setConnection('lost', this.state.attempt);
          this.fail(error);
        },
      },
    );
    void this.subscription.done.then(() => {
      if (ticket !== this.generation || lost) return;
      this.setConnection('closed', this.state.attempt);
    });
  }

  private receive(event: ExplorationEvent): void {
    if (this.state.connection !== 'live') this.setConnection('live', this.state.attempt);
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS)
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    const snapshot = this.state.snapshot;
    if (snapshot) {
      if (event.type === 'status') this.state.snapshot = { ...snapshot, status: event.status };
      if (event.type === 'completed') this.state.snapshot = { ...snapshot, status: 'COMPLETED' };
      if (event.type === 'failed') this.state.snapshot = { ...snapshot, status: 'FAILED' };
    }
    this.schedulePaint();
  }

  private setConnection(state: ConnectionState, attempt: number): void {
    if (this.state.connection === state && this.state.attempt === attempt) return;
    // Un flux terminé avec l'exploration n'est pas une coupure.
    const terminal = this.state.snapshot ? isTerminal(this.state.snapshot.status) : false;
    this.state.connection = state === 'lost' && terminal ? 'closed' : state;
    this.state.attempt = attempt;
    this.emit(MONITOR_EVENTS.connection, { state: this.state.connection, attempt });
    this.schedulePaint();
  }

  /** Une rafale d'événements ne redessine qu'une fois par image. */
  private schedulePaint(): void {
    if (this.paintQueued) return;
    this.paintQueued = true;
    const run = (): void => {
      this.paintQueued = false;
      this.paint();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  }

  private paint(): void {
    const active = this.root.activeElement as HTMLElement | null;
    const focused = active?.getAttribute('data-view');
    const list = this.root.querySelector('.events');
    const scroll = list?.scrollTop ?? 0;
    this.root.innerHTML = `<style>${MONITOR_CSS}</style>${renderMonitor(this.state)}`;
    if (focused)
      this.root.querySelector<HTMLElement>(`[data-view="${focused}"]`)?.focus({ preventScroll: true });
    const next = this.root.querySelector('.events');
    if (next) next.scrollTop = scroll;
  }

  private onChange(event: Event): void {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    const key = select.dataset.view as keyof MonitorView | undefined;
    if (!key || !VIEW_KEYS.includes(key)) return;
    this.state.view = { ...this.state.view, [key]: select.value };
    this.paint();
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private fail(error: unknown): void {
    const code = error instanceof QaCrawlerError ? error.code : 'ERROR';
    this.emit(MONITOR_EVENTS.error, { code, message: message(error) });
  }
}

export function defineRunMonitor(name = 'qa-crawler-run-monitor'): void {
  if (!('customElements' in globalThis)) return;
  if (!globalThis.customElements.get(name)) globalThis.customElements.define(name, QaCrawlerRunMonitor);
}
