import { createQaCrawler, QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import type { CoverageStatusName, RunComparisonView, TraceabilityView } from '../core/contracts.js';
import { COVERAGE_STATUSES, RUNS_EVENTS } from '../core/contracts.js';
import { runsStrings } from './runs-i18n.js';
import { RUNS_CSS } from './runs-styles.js';
import { renderRuns, type RunsState } from './runs-view.js';

/**
 * <qa-crawler-run-compare> — deux explorations d'un projet, comparées flow par flow et exigence par
 * exigence, et la traçabilité de l'exécution comparée (exigences ↔ règles ↔ flows ↔ assertions ↔
 * preuves). Tout est lu dans ce que le moteur a écrit : rien n'est rejoué ni recalculé.
 *
 * Attributs : endpoint (API du serveur SDK), project, base, head (dossiers `run-…` ; par défaut les
 * deux plus récents), locale (fr | en). Propriétés : token (jamais en attribut dans une page
 * publique), client (un client déjà construit).
 *
 * Événements (bubbles, composed) : qa-runs-selection `{ base, head }`, qa-error.
 */
const Base: typeof HTMLElement =
  'HTMLElement' in globalThis ? globalThis.HTMLElement : (Object as unknown as typeof HTMLElement);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class QaCrawlerRunCompare extends Base {
  static get observedAttributes(): string[] {
    return ['endpoint', 'project', 'base', 'head', 'locale'];
  }

  private root!: ShadowRoot;
  private state!: RunsState;
  private injectedClient?: QaCrawlerClient;
  private ownClient?: QaCrawlerClient;
  private tokenValue?: string;
  private connected = false;
  private loadQueued = false;
  /** Chaque chargement porte un numéro : une réponse arrivée après un autre choix est ignorée. */
  private generation = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.state = {
      t: runsStrings(this.getAttribute('locale')),
      phase: 'idle',
      tab: 'compare',
      runs: [],
      status: '',
    };
    this.root.addEventListener('click', (event) => {
      this.onClick(event);
    });
    this.root.addEventListener('change', (event) => {
      this.onChange(event);
    });
    this.root.addEventListener('keydown', (event) => {
      this.onKey(event as KeyboardEvent);
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

  /** La comparaison chargée (lecture seule). */
  get comparison(): RunComparisonView | undefined {
    return this.state.comparison ? structuredClone(this.state.comparison) : undefined;
  }

  /** La traçabilité chargée de l'exécution comparée (lecture seule). */
  get traceability(): TraceabilityView | undefined {
    return this.state.traceability ? structuredClone(this.state.traceability) : undefined;
  }

  /** Recharger depuis le serveur (après une nouvelle exploration). */
  reload(): void {
    this.queueLoad();
  }

  connectedCallback(): void {
    this.connected = true;
    this.queueLoad();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'locale') {
      this.state.t = runsStrings(next);
      this.paint();
      return;
    }
    if (name === 'endpoint') this.resetClient();
    if (name === 'base' || name === 'head') {
      if (next) this.state[name] = next;
      if (this.connected && this.state.runs.length) void this.loadSelection();
      return;
    }
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
    this.ownClient?.dispose();
    this.ownClient = undefined;
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
    const project = this.getAttribute('project');
    if (!project) {
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
    this.state.phase = 'loading';
    this.paint();
    try {
      const entries = await api.reports.list(project);
      this.state.runs = entries
        .filter((entry) => entry.kind === 'exploration')
        .map((entry) => ({ name: entry.name, createdAt: entry.createdAt }));
      const names = this.state.runs.map((run) => run.name);
      const wanted = (attribute: string): string | undefined => {
        const value = this.getAttribute(attribute);
        return value && names.includes(value) ? value : undefined;
      };
      this.state.head = wanted('head') ?? names[0];
      this.state.base = wanted('base') ?? names.find((name) => name !== this.state.head);
      this.state.phase = 'ready';
    } catch (error) {
      this.state.phase = 'error';
      this.state.error = message(error);
      this.fail(error);
      this.paint();
      return;
    }
    await this.loadSelection();
  }

  /** La comparaison et la traçabilité des exécutions choisies ; l'une peut manquer sans cacher l'autre. */
  private async loadSelection(): Promise<void> {
    const project = this.getAttribute('project');
    const api = this.api;
    if (!project || !api) return;
    const ticket = ++this.generation;
    const { base, head } = this.state;
    this.state.comparison = undefined;
    this.state.comparisonError = undefined;
    this.state.traceability = undefined;
    this.state.traceabilityError = undefined;
    this.paint();
    const [comparison, traceability] = await Promise.allSettled([
      base && head && base !== head ? api.reports.compare(project, base, head) : Promise.resolve(undefined),
      head ? api.reports.traceability(project, head) : Promise.resolve(undefined),
    ]);
    if (ticket !== this.generation) return;
    if (comparison.status === 'fulfilled') this.state.comparison = comparison.value;
    else {
      this.state.comparisonError = message(comparison.reason);
      this.fail(comparison.reason);
    }
    if (traceability.status === 'fulfilled') this.state.traceability = traceability.value;
    else if (traceability.reason instanceof QaCrawlerError && traceability.reason.status === 404)
      this.state.traceabilityError = this.state.t.noTraceability;
    else {
      this.state.traceabilityError = this.state.t.failed + message(traceability.reason);
      this.fail(traceability.reason);
    }
    this.paint();
  }

  private paint(): void {
    const active = this.root.activeElement as HTMLElement | null;
    const focusKey = active ? focusKeyOf(active) : undefined;
    this.root.innerHTML = `<style>${RUNS_CSS}</style>${renderRuns(this.state)}`;
    if (focusKey) this.root.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
  }

  private onClick(event: Event): void {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-tab], [data-flow]');
    if (!target) return;
    const tab = target.dataset.tab;
    if (tab === 'compare' || tab === 'traceability') {
      this.state.tab = tab;
      this.paint();
      return;
    }
    const flow = target.dataset.flow;
    if (flow !== undefined) {
      this.state.open = this.state.open === flow ? undefined : flow;
      this.paint();
    }
  }

  private onChange(event: Event): void {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    const role = select.dataset.run;
    if (role === 'base' || role === 'head') {
      this.state[role] = select.value;
      this.state.open = undefined;
      this.emit(RUNS_EVENTS.selection, { base: this.state.base, head: this.state.head });
      void this.loadSelection();
      return;
    }
    if (select.hasAttribute('data-status')) {
      const value = select.value;
      this.state.status = (COVERAGE_STATUSES as readonly string[]).includes(value)
        ? (value as CoverageStatusName)
        : '';
      this.paint();
    }
  }

  /** Les onglets au clavier : flèches gauche / droite, comme un tablist ARIA. */
  private onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target?.dataset.tab || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    this.state.tab = this.state.tab === 'compare' ? 'traceability' : 'compare';
    this.paint();
    this.root.querySelector<HTMLElement>(`[data-tab="${this.state.tab}"]`)?.focus();
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private fail(error: unknown): void {
    const code = error instanceof QaCrawlerError ? error.code : 'ERROR';
    this.emit(RUNS_EVENTS.error, { code, message: message(error) });
  }
}

function focusKeyOf(element: HTMLElement): string | undefined {
  for (const attribute of ['data-tab', 'data-flow', 'data-run']) {
    const value = element.getAttribute(attribute);
    if (value !== null) return `[${attribute}="${value.replace(/["\\]/g, '\\$&')}"]`;
  }
  if (element.hasAttribute('data-status')) return '[data-status]';
  return undefined;
}

export function defineRunCompare(name = 'qa-crawler-run-compare'): void {
  if (!('customElements' in globalThis)) return;
  if (!globalThis.customElements.get(name)) globalThis.customElements.define(name, QaCrawlerRunCompare);
}
