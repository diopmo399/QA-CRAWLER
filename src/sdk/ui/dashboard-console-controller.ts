import { QaCrawlerError, type QaCrawlerClient, type Subscription } from '../core/client.js';
import type { RunLogEvent, RunLogLevel, TestRunView } from '../core/contracts.js';
import {
  type ConsoleUi,
  detailHtml,
  emptyFilters,
  lineHtml,
  matches,
  MAX_CLIENT_EVENTS,
  MAX_DOM_LINES,
  shownEvents,
} from './dashboard-console.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LE CONTRÔLEUR DE LA CONSOLE : il suit UNE exécution (son `runId`), reçoit ses événements par le flux
 * du serveur (reprise après une coupure, sans doublon) et tient la liste des lignes dans un nœud qui
 * survit aux rendus de l'écran : une ligne reçue est ajoutée, jamais l'écran entier redessiné. Les vues
 * dérivées (étapes, erreurs, résumé) sont redessinées au plus toutes les 600 ms, et seulement quand un
 * événement qui les change arrive.
 */
export interface ConsoleHost {
  readonly state: DashboardState;
  readonly root: ShadowRoot;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  /** Le projet et l'enregistrement de l'éditeur. */
  context(): { api: QaCrawlerClient; projectId: string; recording: string } | undefined;
  notice(tone: 'ok' | 'err' | 'info', text: string): void;
  /** La vue des tests générés a pu changer (fin d'un run) : la relire. */
  refresh(): Promise<void>;
  /** Le chemin du fichier ouvert (les lignes s'y rattachent quand l'événement ne dit pas son fichier). */
  activePath(): string;
  /** Relancer : la même exécution (format, mode, fichier du Dry Run). */
  rerun(run: TestRunView): Promise<TestRunView | undefined>;
}

/** Les types d'événements qui changent les vues dérivées (étapes, erreurs, en-tête). */
const STRUCTURAL =
  /^(STEP_|SCENARIO_|RUN_|CANCEL_|TEST_|ACTION_|ASSERTION_|TARGET_|STEP_RECONCILED|INTENT_|FAILURE_LOCATED|REPORT_WRITTEN)/;
const REPAINT_MS = 600;

export class RunConsole {
  private subscription: Subscription | undefined;
  private wrap: HTMLElement | undefined;
  private list: HTMLOListElement | undefined;
  private older: HTMLElement | undefined;
  private announcer: HTMLElement | undefined;
  /** Lignes reçues pendant la pause du suivi (montrées à la reprise). */
  private held: RunLogEvent[] = [];
  private queued: RunLogEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private repaintTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRepaint = 0;
  private scrollTop = 0;
  private selected = new Set<number>();
  private detail: number | undefined;
  private generation = 0;

  constructor(private readonly host: ConsoleHost) {}

  private get ui(): ConsoleUi {
    return this.host.state.ed.console;
  }

  // ── Le suivi d'une exécution ──────────────────────────────────────────────────────────────

  /** Suit une exécution : son journal conservé, puis ce qui arrive. Un autre run : rien n'est mélangé. */
  follow(run: TestRunView | undefined): void {
    const ui = this.ui;
    if (run && ui.runId === run.id) {
      ui.run = run;
      return;
    }
    this.close();
    this.generation += 1;
    this.selected.clear();
    this.detail = undefined;
    this.held = [];
    this.queued = [];
    ui.events = [];
    ui.unseen = 0;
    ui.cleared = 0;
    ui.dropped = 0;
    ui.stopping = undefined;
    ui.stopError = undefined;
    ui.attempt = undefined;
    ui.filters.step = '';
    if (!run) {
      ui.runId = undefined;
      ui.run = undefined;
      ui.connection = 'idle';
      this.rebuild();
      return;
    }
    ui.runId = run.id;
    ui.run = run;
    ui.connection = run.logs?.state === 'UNAVAILABLE' ? 'unavailable' : 'connecting';
    this.rebuild();
    if (ui.connection === 'unavailable') return;
    this.subscribe(0);
  }

  /** Rouvre le flux après le dernier événement reçu (après une interruption). */
  resume(): void {
    if (!this.ui.runId || this.subscription) return;
    this.ui.connection = 'connecting';
    this.subscribe(this.ui.events.at(-1)?.seq ?? 0);
  }

  private subscribe(after: number): void {
    const context = this.host.context();
    const runId = this.ui.runId;
    if (!context || !runId) return;
    const generation = this.generation;
    const subscription = context.api.generation.runEvents(
      context.projectId,
      context.recording,
      runId,
      (event) => {
        if (generation !== this.generation) return;
        this.receive(event);
      },
      {
        after,
        reconnect: { retries: 5, delayMs: 1000 },
        onReconnect: (attempt) => {
          if (generation !== this.generation) return;
          this.ui.connection = 'reconnecting';
          this.ui.attempt = attempt;
          this.schedulePaint(true);
        },
        onError: () => undefined,
      },
    );
    this.subscription = subscription;
    void subscription.done.then(() => {
      if (generation !== this.generation) return;
      this.subscription = undefined;
      const ui = this.ui;
      if (ui.connection === 'unavailable') return;
      const finished = ui.events.some((event) => event.type === 'RUN_FINISHED');
      ui.connection = finished ? 'ended' : 'interrupted';
      this.schedulePaint(true);
    });
  }

  private receive(raw: RunLogEvent | { type: 'UNAVAILABLE'; runId: string }): void {
    const ui = this.ui;
    if (raw.type === 'UNAVAILABLE') {
      ui.connection = 'unavailable';
      this.schedulePaint(true);
      return;
    }
    const event = raw as RunLogEvent;
    // L'isolation : un événement d'un autre run n'entre jamais dans cette console.
    if (event.runId !== ui.runId) return;
    const last = ui.events.at(-1);
    if (last && event.seq <= last.seq) return;
    if (ui.connection !== 'live' && !ui.events.some((entry) => entry.type === 'RUN_FINISHED'))
      ui.connection = 'live';
    ui.events.push(event);
    if (ui.events.length > MAX_CLIENT_EVENTS) {
      const extra = ui.events.length - MAX_CLIENT_EVENTS;
      ui.events.splice(0, extra);
      ui.dropped += extra;
    }
    if (event.type === 'CANCEL_REQUESTED') ui.stopping = 'requested';
    if (event.type === 'CANCEL_CONFIRMED' || event.type === 'CANCEL_UNCONFIRMED') ui.stopping = undefined;
    this.announce(event);
    this.queued.push(event);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 40);
    if (event.type === 'RUN_FINISHED') {
      ui.connection = 'ended';
      void this.host.refresh().then(() => {
        const fresh = this.host.state.ed.view?.runs.find((run) => run.id === ui.runId);
        if (fresh) ui.run = fresh;
        this.schedulePaint(true);
      });
    } else if (STRUCTURAL.test(event.type) || event.level === 'ERROR') this.schedulePaint(false);
  }

  /** Les lignes reçues : ajoutées à la liste (ou tenues, en pause), les plus anciennes retirées au-delà de la limite. */
  private flush(): void {
    const ui = this.ui;
    const events = this.queued.filter((event) => event.seq > ui.cleared && matches(event, ui.filters));
    this.queued = [];
    if (events.length === 0) return;
    if (ui.paused) {
      this.held.push(...events);
      ui.unseen += events.length;
      this.updateUnseen();
      return;
    }
    this.append(events);
  }

  private append(events: readonly RunLogEvent[]): void {
    const list = this.list;
    if (!list) return;
    const path = this.host.activePath();
    list.insertAdjacentHTML(
      'beforeend',
      events.map((event) => lineHtml(this.host.state, event, path, this.selected.has(event.seq))).join(''),
    );
    let hidden = Number(this.older?.dataset.count ?? '0');
    while (list.children.length > MAX_DOM_LINES) {
      list.firstElementChild?.remove();
      hidden += 1;
    }
    this.setOlder(hidden);
    if (this.ui.follow) this.toBottom();
    else {
      this.ui.unseen += events.length;
      this.updateUnseen();
    }
  }

  /** La liste refaite d'après les critères (changement de critère, effacement, nouvelle exécution). */
  rebuild(): void {
    this.ensureNodes();
    const list = this.list;
    if (!list) return;
    const shown = shownEvents(this.ui);
    const visible = shown.slice(-MAX_DOM_LINES);
    const path = this.host.activePath();
    list.innerHTML = visible
      .map((event) => {
        const line = lineHtml(this.host.state, event, path, this.selected.has(event.seq));
        return this.detail === event.seq
          ? line.replace(/<\/li>$/, `${detailHtml(this.host.state, event, path)}</li>`)
          : line;
      })
      .join('');
    this.setOlder(shown.length - visible.length);
    this.held = [];
    this.ui.unseen = 0;
    this.updateUnseen();
    if (this.ui.follow) this.toBottom();
  }

  // ── Le nœud de la liste, qui survit aux rendus ──────────────────────────────────────────────

  private ensureNodes(): void {
    if (this.wrap) return;
    const document = this.host.root.ownerDocument;
    const wrap = document.createElement('div');
    wrap.className = 'ed-log-wrap';
    const t = this.host.state.t.ed.con;
    wrap.innerHTML = `<p class="ed-log-older" hidden><span></span> <button class="lnk" data-action="ed-con-older">${esc(t.showOlder)}</button></p><ol class="ed-log" role="log" aria-live="off" aria-label="${esc(t.tabs.console)}" tabindex="0"></ol><p class="sr" role="status" aria-live="polite"></p>`;
    this.wrap = wrap;
    this.older = wrap.querySelector<HTMLElement>('.ed-log-older') ?? undefined;
    this.list = wrap.querySelector('ol') ?? undefined;
    this.announcer = wrap.querySelector<HTMLElement>('[role="status"]') ?? undefined;
    this.list?.addEventListener('scroll', () => {
      const list = this.list;
      if (!list) return;
      this.scrollTop = list.scrollTop;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      // Remonter dans le journal arrête le suivi en bas ; y redescendre le reprend.
      if (atBottom !== this.ui.follow) {
        this.ui.follow = atBottom;
        if (atBottom) {
          this.ui.unseen = 0;
          this.updateUnseen();
        }
        const box = this.host.root.querySelector<HTMLInputElement>('[data-ed="con-follow"]');
        if (box) box.checked = atBottom;
      }
    });
  }

  /** Avant un rendu : la position dans la liste. */
  beforePaint(): void {
    if (this.list) this.scrollTop = this.list.scrollTop;
  }

  // ── La hauteur : la poignée au-dessus de la console ─────────────────────────────────────────

  /** Les bornes de la hauteur : la console garde 150 px, les colonnes au-dessus d'elle 200 px. */
  private bounds(panel: HTMLElement): { min: number; max: number } {
    const body = panel.closest<HTMLElement>('.ed-body');
    const view = this.host.root.ownerDocument.defaultView?.innerHeight ?? 800;
    const max = Math.max(150, Math.min((body?.clientHeight ?? view) - 210, view - 160));
    return { min: 150, max };
  }

  private setHeight(panel: HTMLElement, height: number): void {
    const { min, max } = this.bounds(panel);
    const value = Math.round(Math.min(max, Math.max(min, height)));
    this.ui.height = value;
    panel.closest<HTMLElement>('.ed-body')?.style.setProperty('--con-h', `${String(value)}px`);
    panel.querySelector('[data-con-split]')?.setAttribute('aria-valuenow', String(value));
    this.announceBounds(panel);
  }

  /** Les bornes du séparateur (motif ARIA « window splitter ») : elles dépendent de la place à l'écran. */
  private announceBounds(panel: HTMLElement): void {
    const { min, max } = this.bounds(panel);
    const handle = panel.querySelector('[data-con-split]');
    handle?.setAttribute('aria-valuemin', String(min));
    handle?.setAttribute('aria-valuemax', String(max));
  }

  /** Glisser la poignée : la hauteur suit le pointeur, sans redessiner l'écran. */
  pointerDown(event: PointerEvent): boolean {
    const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-con-split]');
    const panel = handle?.closest<HTMLElement>('[data-con-panel]');
    if (!handle || !panel || event.button !== 0) return false;
    event.preventDefault();
    const startY = event.clientY;
    const start = panel.getBoundingClientRect().height;
    this.announceBounds(panel);
    handle.setPointerCapture(event.pointerId);
    panel.classList.add('sizing');
    const move = (moved: PointerEvent): void => {
      this.setHeight(panel, start + (startY - moved.clientY));
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      panel.classList.remove('sizing');
      if (this.list && this.ui.follow) this.toBottom();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    return true;
  }

  /** Au clavier, sur la poignée : ↑/↓ règlent la hauteur, Entrée agrandit. */
  keydown(event: KeyboardEvent): boolean {
    const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-con-split]');
    const panel = handle?.closest<HTMLElement>('[data-con-panel]');
    if (!handle || !panel) return false;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.setHeight(panel, panel.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 40 : -40));
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.toggleMax();
      return true;
    }
    return false;
  }

  private toggleMax(): void {
    this.ui.maximized = !this.ui.maximized;
    this.ui.open = true;
    this.host.paint();
    this.host.root.querySelector<HTMLElement>('[data-action="ed-con-max"]')?.focus();
  }

  /** Après un rendu : la liste revient dans la page, à sa position (ou en bas, en suivi). */
  afterPaint(): void {
    const slot = this.host.root.querySelector('[data-log-host]');
    if (!slot) return;
    this.ensureNodes();
    if (!this.wrap) return;
    slot.append(this.wrap);
    if (this.list) {
      if (this.ui.follow) this.toBottom();
      else this.list.scrollTop = this.scrollTop;
    }
    this.updateUnseen();
  }

  private toBottom(): void {
    const list = this.list;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    this.scrollTop = list.scrollTop;
  }

  private setOlder(count: number): void {
    const older = this.older;
    if (!older) return;
    older.dataset.count = String(count);
    older.hidden = count <= 0;
    const label = older.querySelector('span');
    if (label) label.textContent = this.host.state.t.ed.con.olderHidden(count);
  }

  private updateUnseen(): void {
    const button = this.host.root.querySelector<HTMLElement>('[data-log-unseen]');
    if (!button) return;
    button.hidden = this.ui.unseen <= 0;
    const label = button.querySelector('span');
    if (label) label.textContent = this.host.state.t.ed.con.newEvents(this.ui.unseen);
  }

  /** Les moments qui comptent, dits aux lecteurs d'écran (pas chaque ligne). */
  private announce(event: RunLogEvent): void {
    const announcer = this.announcer;
    if (!announcer) return;
    const t = this.host.state.t.ed.con;
    if (
      event.type === 'STEP_FINISHED' &&
      (event.status === 'FAILED' || event.status === 'BLOCKED') &&
      event.step !== undefined
    )
      announcer.textContent = t.announceFailed(event.step);
    else if (event.type === 'RUN_FINISHED')
      announcer.textContent = t.announceFinished(String(event.data?.status ?? ''));
  }

  private schedulePaint(now: boolean): void {
    if (this.repaintTimer) {
      if (!now) return;
      clearTimeout(this.repaintTimer);
    }
    const wait = now ? 0 : Math.max(0, REPAINT_MS - (Date.now() - this.lastRepaint));
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined;
      this.lastRepaint = Date.now();
      if (this.host.state.route.view === 'editor') this.host.paint();
    }, wait);
  }

  // ── Les actions de la console ───────────────────────────────────────────────────────────────

  click(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    switch (action) {
      case 'ed-con-tab': {
        const tab = target.dataset.tab as ConsoleUi['tab'] | undefined;
        if (tab) ui.tab = tab;
        ui.open = true;
        this.host.paint();
        this.host.root
          .querySelector<HTMLElement>(`[data-action="ed-con-tab"][data-tab="${tab ?? ''}"]`)
          ?.focus();
        return true;
      }
      case 'ed-con-max':
        this.toggleMax();
        return true;
      case 'ed-con-toggle':
        ui.open = !ui.open;
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-action="ed-con-toggle"]')?.focus();
        return true;
      case 'ed-con-pause':
        ui.paused = !ui.paused;
        if (!ui.paused) {
          const held = this.held;
          this.held = [];
          ui.unseen = 0;
          this.append(held);
          this.toBottom();
        }
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-action="ed-con-pause"]')?.focus();
        return true;
      case 'ed-con-bottom':
        ui.follow = true;
        ui.unseen = 0;
        if (ui.paused) {
          ui.paused = false;
          const held = this.held;
          this.held = [];
          this.append(held);
        }
        this.toBottom();
        this.host.paint();
        return true;
      case 'ed-con-older':
        // Les lignes plus anciennes : la liste est refaite sans limite pour ce qui passe les critères.
        this.showAll();
        return true;
      case 'ed-con-clear':
        ui.cleared = ui.events.at(-1)?.seq ?? ui.cleared;
        this.selected.clear();
        this.detail = undefined;
        this.rebuild();
        this.host.paint();
        return true;
      case 'ed-con-more':
        ui.moreFilters = !ui.moreFilters;
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-action="ed-con-more"]')?.focus();
        return true;
      case 'ed-con-reset':
        ui.filters = emptyFilters();
        this.rebuild();
        this.host.paint();
        return true;
      case 'ed-con-line': {
        const seq = Number(target.dataset.seq);
        if (!Number.isInteger(seq)) return true;
        if (this.selected.has(seq)) this.selected.delete(seq);
        else this.selected.add(seq);
        this.detail = this.detail === seq ? undefined : seq;
        this.renderLine(seq);
        return true;
      }
      case 'ed-con-step-events': {
        ui.filters.step = target.dataset.step ?? '';
        ui.tab = 'console';
        ui.open = true;
        this.rebuild();
        this.host.paint();
        return true;
      }
      case 'ed-con-copy':
        void this.copy();
        return true;
      case 'ed-con-download':
        void this.download(target.dataset.format === 'text' ? 'text' : 'json');
        return true;
      case 'ed-con-stop':
        void this.stop();
        return true;
      case 'ed-con-rerun':
        void this.rerun();
        return true;
      case 'ed-con-resume':
        this.resume();
        this.host.paint();
        return true;
      case 'ed-con-evidence':
        void this.openEvidence(target.dataset.shot ?? '');
        return true;
      case 'ed-con-report':
        void this.openEvidence('');
        return true;
      default:
        return false;
    }
  }

  change(target: HTMLInputElement | HTMLSelectElement): boolean {
    const field = target.dataset.ed ?? '';
    if (!field.startsWith('con-')) return false;
    const ui = this.ui;
    const filters = ui.filters;
    switch (field) {
      case 'con-level': {
        const level = target.value as RunLogLevel;
        const box = target as HTMLInputElement;
        filters.levels = box.checked
          ? [...new Set([...filters.levels, level])]
          : filters.levels.filter((entry) => entry !== level);
        break;
      }
      case 'con-category':
        filters.category = target.value as ConsoleUi['filters']['category'];
        break;
      case 'con-step':
        filters.step = target.value;
        break;
      case 'con-type':
        filters.type = target.value;
        break;
      case 'con-status':
        filters.status = target.value as ConsoleUi['filters']['status'];
        break;
      case 'con-from':
        filters.from = target.value;
        break;
      case 'con-to':
        filters.to = target.value;
        break;
      case 'con-follow':
        ui.follow = (target as HTMLInputElement).checked;
        if (ui.follow) {
          ui.unseen = 0;
          this.toBottom();
          this.updateUnseen();
        }
        return true;
      case 'con-run': {
        const run = this.host.state.ed.view?.runs.find((entry) => entry.id === target.value);
        if (run) this.follow(run);
        this.host.paint();
        return true;
      }
      case 'con-text':
        return true;
      default:
        return false;
    }
    this.rebuild();
    this.host.paint();
    return true;
  }

  input(target: HTMLInputElement): boolean {
    if (target.dataset.ed !== 'con-text') return false;
    this.ui.filters.text = target.value;
    this.rebuild();
    this.host.paint();
    return true;
  }

  private renderLine(seq: number): void {
    const list = this.list;
    const event = this.ui.events.find((entry) => entry.seq === seq);
    if (!list || !event) return;
    const path = this.host.activePath();
    for (const item of list.querySelectorAll<HTMLElement>('li[data-seq]')) {
      const current = Number(item.dataset.seq);
      const source = this.ui.events.find((entry) => entry.seq === current);
      if (!source) continue;
      const open = this.detail === current;
      const wasOpen = item.querySelector('.ev-detail') !== null;
      if (current !== seq && !wasOpen) continue;
      let html = lineHtml(this.host.state, source, path, this.selected.has(current));
      if (open) html = html.replace(/<\/li>$/, `${detailHtml(this.host.state, source, path)}</li>`);
      item.outerHTML = html;
    }
    list.querySelector<HTMLElement>(`li[data-seq="${String(seq)}"] .ev-main`)?.focus();
  }

  private showAll(): void {
    const list = this.list;
    if (!list) return;
    const path = this.host.activePath();
    list.innerHTML = shownEvents(this.ui)
      .map((event) => lineHtml(this.host.state, event, path, this.selected.has(event.seq)))
      .join('');
    this.setOlder(0);
  }

  /** Les lignes choisies (ou toutes celles montrées), en texte, dans le presse-papiers. */
  private async copy(): Promise<void> {
    const t = this.host.state.t.ed.con;
    const shown = shownEvents(this.ui);
    const lines = (
      this.selected.size > 0 ? shown.filter((event) => this.selected.has(event.seq)) : shown
    ).map(
      (event) =>
        `${event.at} ${event.level} ${event.category} ${event.type}${event.status ? ` ${event.status}` : ''}${event.step !== undefined ? ` [step ${String(event.step)}]` : ''}${event.line !== undefined ? ` [line ${String(event.line)}]` : ''} ${event.message}`,
    );
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      this.host.notice('ok', t.copied(lines.length));
    } catch {
      // Sans accès au presse-papiers : les lignes sont sélectionnées dans la page, Ctrl+C les copie.
      const list = this.list;
      const selection = this.host.root.ownerDocument.getSelection();
      if (list && selection) {
        const range = this.host.root.ownerDocument.createRange();
        range.selectNodeContents(list);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      this.host.notice('info', t.copyFailed);
    }
    this.host.paint();
  }

  /** Le journal conservé par le serveur, masqué comme à l'écran, en fichier. */
  private async download(format: 'json' | 'text'): Promise<void> {
    const context = this.host.context();
    const runId = this.ui.runId;
    if (!context || !runId) return;
    try {
      const file = await context.api.generation.runLogs(context.projectId, context.recording, runId, format);
      const document = this.host.root.ownerDocument;
      const url = URL.createObjectURL(new Blob([file.content], { type: file.type }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 10_000);
      this.host.notice('ok', this.host.state.t.ed.con.downloaded(file.name));
    } catch (error) {
      this.host.notice('err', error instanceof Error ? error.message : String(error));
    }
    this.host.paint();
  }

  /** L'arrêt : demandé au serveur ; confirmé par le journal (CANCEL_CONFIRMED), ou refusé (déjà fini). */
  private async stop(): Promise<void> {
    const context = this.host.context();
    const runId = this.ui.runId;
    if (!context || !runId) return;
    this.ui.stopping = 'requested';
    this.ui.stopError = undefined;
    this.host.paint();
    try {
      await context.api.generation.cancel(context.projectId, context.recording, runId);
    } catch (error) {
      this.ui.stopping = 'failed';
      this.ui.stopError = error instanceof QaCrawlerError ? error.message : String(error);
    }
    this.host.paint();
  }

  private async rerun(): Promise<void> {
    const run = this.ui.run;
    if (!run) return;
    const started = await this.host.rerun(run);
    if (started) this.follow(started);
    this.host.paint();
  }

  private async openEvidence(shot: string): Promise<void> {
    const context = this.host.context();
    const runId = this.ui.runId;
    if (!context || !runId) return;
    try {
      const link = await context.api.generation.reportLink(context.projectId, context.recording, runId);
      globalThis.open(shot ? new URL(shot, link.url).toString() : link.url, '_blank', 'noopener');
    } catch (error) {
      this.host.notice('err', error instanceof Error ? error.message : String(error));
      this.host.paint();
    }
  }

  /** Ferme le flux (l'exécution, elle, continue sur le serveur). */
  close(): void {
    this.subscription?.close();
    this.subscription = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    this.flushTimer = undefined;
    this.repaintTimer = undefined;
  }

  /** L'écran est quitté : plus d'abonnement, plus de nœud. */
  dispose(): void {
    this.close();
    this.generation += 1;
    this.wrap?.remove();
    this.wrap = undefined;
    this.list = undefined;
    this.older = undefined;
    this.announcer = undefined;
  }
}
