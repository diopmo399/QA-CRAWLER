import { createQaCrawler, QaCrawlerError, type QaCrawlerClient, type Subscription } from '../core/client.js';
import type { AuthDraft, ExplorationEvent, ProjectDraft, ReportKind } from '../core/contracts.js';
import { WIZARD_EVENTS } from '../core/contracts.js';
import { applyEvent, emptyCounters } from '../core/lifecycle.js';
import { strings, type Locale } from './i18n.js';
import { WIZARD_CSS } from './styles.js';
import { draftWith, render, stepErrors, type StepNumber, type WizardState } from './view.js';

/**
 * <qa-crawler-project-wizard> — l'assistant de création de projet QA-CRAWLER, en Web Component.
 *
 * Attributs : endpoint (URL de l'API du serveur SDK), mode (standalone | embedded), locale (fr | en),
 * product-name, logo. Propriétés : token (jamais en attribut dans une page publique), initialValues,
 * client (un client déjà construit, pour les tests ou un intercepteur de l'hôte).
 *
 * Événements (bubbles, composed) : qa-project-created, qa-exploration-started,
 * qa-exploration-progress, qa-exploration-completed, qa-exploration-failed, qa-error.
 */
// Sous Node (tests du rendu), HTMLElement n'existe pas : l'import ne doit pas échouer.
const Base: typeof HTMLElement =
  'HTMLElement' in globalThis ? globalThis.HTMLElement : (Object as unknown as typeof HTMLElement);

const EMPTY_DRAFT: ProjectDraft = {
  project: { name: '', targetUrl: '', framework: 'other' },
  environment: {
    viewport: { width: 1366, height: 768 },
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 15_000,
    auth: { type: 'none' },
  },
  exploration: {
    maxStates: 100,
    maxActions: 500,
    maxDurationMinutes: 15,
    maxDepth: 10,
    allowedHosts: [],
    ignoredPaths: [],
    checks: { pageErrors: true, network: true, screenshots: true },
  },
};

export class QaCrawlerProjectWizard extends Base {
  static get observedAttributes(): string[] {
    return ['endpoint', 'mode', 'locale', 'product-name', 'logo'];
  }

  private root!: ShadowRoot;
  private state!: WizardState;
  private injectedClient?: QaCrawlerClient;
  private ownClient?: QaCrawlerClient;
  private tokenValue?: string;
  private initial?: unknown;
  private subscription?: Subscription;
  private ticker?: ReturnType<typeof setInterval>;
  private frame = 0;
  private envTimer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private loadQueued = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.state = this.freshState();
    this.root.addEventListener('click', (event) => {
      this.onClick(event);
    });
    this.root.addEventListener('input', (event) => {
      this.onInput(event);
    });
    this.root.addEventListener('change', (event) => {
      this.onInput(event);
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

  set initialValues(value: unknown) {
    this.initial = value;
    if (this.state.caps) {
      this.state.draft = draftWith(this.state.draft, value);
      this.paint();
    }
  }

  get initialValues(): unknown {
    return this.initial;
  }

  /** Le brouillon courant (lecture seule) : l'hôte peut le lire, jamais un secret. */
  get draft(): ProjectDraft {
    return structuredClone(this.state.draft);
  }

  connectedCallback(): void {
    this.connected = true;
    this.queueLoad();
  }

  /**
   * Le premier chargement attend la fin du script en cours : l'hôte pose souvent le jeton juste
   * après avoir défini l'élément ; plusieurs changements dans le même script ne font qu'un appel.
   */
  private queueLoad(): void {
    if (this.loadQueued) return;
    this.loadQueued = true;
    queueMicrotask(() => {
      this.loadQueued = false;
      if (this.connected) void this.load();
    });
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.subscription?.close();
    if (this.ticker) clearInterval(this.ticker);
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'endpoint') {
      this.resetClient();
      if (this.connected) this.queueLoad();
      return;
    }
    this.state.t = strings(this.getAttribute('locale'));
    this.state.locale = localeOf(this.getAttribute('locale'));
    this.state.mode = this.getAttribute('mode') === 'embedded' ? 'embedded' : 'standalone';
    const product = this.getAttribute('product-name');
    const logo = this.getAttribute('logo');
    this.state.productName = product ?? undefined;
    this.state.logo = logo ?? undefined;
    this.paint();
  }

  private freshState(): WizardState {
    return {
      t: strings(this.getAttribute('locale')),
      locale: localeOf(this.getAttribute('locale')),
      mode: this.getAttribute('mode') === 'embedded' ? 'embedded' : 'standalone',
      phase: 'loading',
      step: 1,
      visited: 1,
      draft: structuredClone(EMPTY_DRAFT),
      showErrors: {},
      urlChecking: false,
      env: {},
      validating: false,
      busy: false,
      pending: { host: '', path: '' },
    };
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

  private async load(): Promise<void> {
    this.state.phase = 'loading';
    this.paint();
    // L'API exige toujours le jeton : sans lui (l'hôte le pose souvent après un appel à son
    // back-end), l'assistant attend au lieu d'essuyer un refus.
    if (!this.injectedClient && !this.tokenValue) return;
    const api = this.api;
    if (!api) {
      this.state.phase = 'error';
      this.state.loadError = 'endpoint attribute missing';
      this.paint();
      return;
    }
    try {
      const caps = await api.capabilities();
      this.state.caps = caps;
      this.state.draft = draftWith(caps.defaults, this.initial);
      this.state.phase = 'ready';
    } catch (error) {
      this.state.phase = 'error';
      this.state.loadError = error instanceof Error ? error.message : String(error);
      this.fail(error);
    }
    this.paint();
  }

  // ———————————————————————————————————————————— rendu

  private paint(): void {
    const active = this.root.activeElement as HTMLInputElement | null;
    const focusKey = active ? (active.dataset.bind ?? active.dataset.pending ?? active.id) : undefined;
    const focusType = active?.type;
    const selection =
      active && 'selectionStart' in active && typeof active.selectionStart === 'number'
        ? [active.selectionStart, active.selectionEnd]
        : undefined;
    this.root.innerHTML = `<style>${WIZARD_CSS}</style>${render(this.state)}`;
    if (focusKey) {
      const candidates = [
        ...this.root.querySelectorAll<HTMLInputElement>('[data-bind],[data-pending],[id]'),
      ].filter(
        (el) => (el.dataset.bind ?? el.dataset.pending ?? el.id) === focusKey && el.type === focusType,
      );
      const target = candidates[0];
      if (target) {
        target.focus();
        if (
          selection &&
          typeof target.setSelectionRange === 'function' &&
          /^(text|url|search|)$/.test(target.type)
        )
          try {
            target.setSelectionRange(selection[0] ?? null, selection[1] ?? null);
          } catch {
            // certains types n'acceptent pas de sélection
          }
      }
    }
  }

  /** Repeint au plus une fois par image (les événements du moteur arrivent par rafales). */
  private schedule(): void {
    if (this.frame) return;
    const raf: (callback: FrameRequestCallback) => number =
      'requestAnimationFrame' in globalThis
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback) =>
            Number(
              setTimeout(() => {
                callback(0);
              }, 16),
            );
    this.frame = raf(() => {
      this.frame = 0;
      this.paint();
    });
  }

  // ———————————————————————————————————————————— saisie

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.dataset.pending) {
      this.state.pending[target.dataset.pending === 'hosts' ? 'host' : 'path'] = target.value;
      return;
    }
    const bind = target.dataset.bind;
    if (!bind) return;
    // Une saisie de texte met à jour le brouillon sans repeindre à chaque frappe (sauf la fiche).
    const value = this.readValue(target);
    if (value === undefined) return;
    this.setPath(bind, value);
    if (bind === 'project.targetUrl') this.state.urlCheck = undefined;
    if (bind === 'environment.auth.usernameEnv' || bind === 'environment.auth.passwordEnv') this.refreshEnv();
    this.state.validation = undefined;
    this.state.project = undefined;
    // Jamais de repeinte complète ici : elle remplacerait le champ que l'utilisateur est en train
    // de quitter ou de faire glisser. Seuls la fiche et le jumeau d'un réglage (curseur ↔ nombre) suivent.
    for (const twin of this.root.querySelectorAll<HTMLInputElement>(`[data-bind="${CSS.escape(bind)}"]`))
      if (twin !== target && twin.type !== 'checkbox') twin.value = target.value;
    this.repaintFiche();
  }

  private repaintFiche(): void {
    const fresh = document.createElement('div');
    fresh.innerHTML = render(this.state);
    const next = fresh.querySelector('.fiche');
    const current = this.root.querySelector('.fiche');
    if (next && current) current.replaceWith(next);
  }

  private readValue(target: HTMLInputElement | HTMLSelectElement): unknown {
    const type = target.dataset.type;
    if (type === 'boolean') return (target as HTMLInputElement).checked;
    if (type === 'viewport') {
      const [width, height] = target.value.split('x').map(Number);
      return { width, height };
    }
    if (type === 'number') {
      const n = Number(target.value);
      if (!Number.isFinite(n) || target.value === '') return undefined;
      const bind = target.dataset.bind ?? '';
      return bind.endsWith('TimeoutMs') ? Math.round(n * 1000) : n;
    }
    const value = target.value;
    if (
      value === '' &&
      /(description|locale|sourceRoot|successUrlContains|successSelector|nextSelector|origin)$/.test(
        target.dataset.bind ?? '',
      )
    )
      return null;
    return value;
  }

  private setPath(bind: string, value: unknown): void {
    const keys = bind.split('.');
    let node = this.state.draft as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
    const last = keys[keys.length - 1] ?? '';
    if (value === null) Reflect.deleteProperty(node, last);
    else node[last] = value;
  }

  private onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLInputElement;
    if (event.key === 'Enter' && target.dataset.pending) {
      event.preventDefault();
      this.addChip(target.dataset.pending === 'hosts' ? 'hosts' : 'paths');
    }
  }

  // ———————————————————————————————————————————— actions

  private onClick(event: Event): void {
    const button = (event.target as Element).closest<HTMLElement>('[data-act]');
    if (!button || (button as HTMLButtonElement).disabled) return;
    const act = button.dataset.act;
    switch (act) {
      case 'reload':
        void this.load();
        return;
      case 'goto':
        this.goTo(Number(button.dataset.step) as StepNumber);
        return;
      case 'back':
        this.goTo((this.state.step - 1) as StepNumber);
        return;
      case 'next':
        this.next();
        return;
      case 'framework':
        this.state.draft.project.framework = button.dataset.value as ProjectDraft['project']['framework'];
        if (this.state.draft.project.framework !== 'angular') delete this.state.draft.project.sourceRoot;
        this.state.validation = undefined;
        this.paint();
        return;
      case 'auth':
        this.setAuth(button.dataset.value as AuthDraft['type']);
        return;
      case 'check-url':
        void this.checkUrl();
        return;
      case 'add-hosts':
      case 'add-paths':
        this.addChip(act === 'add-hosts' ? 'hosts' : 'paths');
        return;
      case 'remove-hosts':
      case 'remove-paths': {
        const list =
          act === 'remove-hosts'
            ? this.state.draft.exploration.allowedHosts
            : this.state.draft.exploration.ignoredPaths;
        list.splice(Number(button.dataset.index), 1);
        this.state.validation = undefined;
        this.paint();
        return;
      }
      case 'save':
        void this.save();
        return;
      case 'launch':
        void this.launch();
        return;
      case 'open-report':
        void this.openReport(button.dataset.kind as ReportKind);
        return;
      case 'again':
        void this.launch(true);
        return;
      case 'edit-project':
        this.subscription?.close();
        this.state.run = undefined;
        this.state.project = undefined;
        this.state.validation = undefined;
        this.goTo(1);
        return;
      default:
        return;
    }
  }

  private goTo(step: StepNumber): void {
    if (step < 1 || step > 5) return;
    if (this.state.run && step !== 5) return;
    this.state.step = step;
    this.state.actionError = undefined;
    if (step > this.state.visited) this.state.visited = step;
    if (step === 4) void this.validate();
    if (step === 2) this.refreshEnv();
    this.paint();
    (this.root.querySelector('h1') as HTMLElement | null)?.setAttribute('tabindex', '-1');
    (this.root.querySelector('h1') as HTMLElement | null)?.focus({ preventScroll: false });
  }

  private next(): void {
    const step = this.state.step;
    if (step <= 3) {
      const errors = stepErrors(this.state.draft, step, this.state.t);
      if (Object.keys(errors).length > 0) {
        this.state.showErrors[step] = true;
        this.paint();
        this.root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        return;
      }
      if (step === 1 && !this.state.urlCheck) void this.checkUrl();
      this.goTo((step + 1) as StepNumber);
    }
  }

  private setAuth(type: AuthDraft['type']): void {
    const previous = this.state.draft.environment.auth;
    const names =
      previous.type === 'none'
        ? { usernameEnv: 'QA_USERNAME', passwordEnv: 'QA_PASSWORD' }
        : { usernameEnv: previous.usernameEnv, passwordEnv: previous.passwordEnv };
    const auth: AuthDraft =
      type === 'none'
        ? { type: 'none' }
        : type === 'form'
          ? {
              type: 'form',
              loginUrl: '/login',
              usernameSelector: '',
              passwordSelector: '',
              submitSelector: '',
              ...names,
            }
          : type === 'http'
            ? { type: 'http', ...names }
            : {
                type: 'sso',
                identityProviderOrigin: '',
                usernameSelector: '',
                passwordSelector: '',
                submitSelector: '',
                ...names,
              };
    this.state.draft.environment.auth = auth;
    this.state.validation = undefined;
    this.refreshEnv();
    this.paint();
  }

  private addChip(kind: 'hosts' | 'paths'): void {
    const key = kind === 'hosts' ? 'host' : 'path';
    const value = this.state.pending[key].trim();
    if (!value) return;
    const list =
      kind === 'hosts'
        ? this.state.draft.exploration.allowedHosts
        : this.state.draft.exploration.ignoredPaths;
    if (!list.includes(value)) list.push(kind === 'paths' && !value.startsWith('/') ? `/${value}` : value);
    this.state.pending[key] = '';
    this.state.validation = undefined;
    this.paint();
  }

  private refreshEnv(): void {
    const auth = this.state.draft.environment.auth;
    if (auth.type === 'none') return;
    if (this.envTimer) clearTimeout(this.envTimer);
    this.envTimer = setTimeout(() => {
      const names = [auth.usernameEnv, auth.passwordEnv].filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name));
      if (names.length === 0 || !this.api) return;
      this.api.checks.env(names).then(
        (known) => {
          this.state.env = { ...this.state.env, ...known };
          this.paint();
        },
        () => {
          // un nom refusé par le serveur est signalé au récapitulatif
          this.state.env = { ...this.state.env, ...Object.fromEntries(names.map((name) => [name, false])) };
          this.paint();
        },
      );
    }, 250);
  }

  private async checkUrl(): Promise<void> {
    const api = this.api;
    if (!api) return;
    this.state.urlChecking = true;
    this.paint();
    try {
      this.state.urlCheck = await api.checks.url(this.state.draft.project.targetUrl);
    } catch (error) {
      this.fail(error);
    } finally {
      this.state.urlChecking = false;
      this.paint();
    }
  }

  private async validate(): Promise<void> {
    const api = this.api;
    if (!api) return;
    this.state.validating = true;
    this.state.validation = undefined;
    this.paint();
    try {
      this.state.validation = await api.projects.validate(this.state.draft);
      this.state.env = { ...this.state.env, ...this.state.validation.environment };
    } catch (error) {
      this.state.actionError = error instanceof Error ? error.message : String(error);
      this.fail(error);
    } finally {
      this.state.validating = false;
      this.paint();
    }
  }

  private async save(): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    if (this.state.project) return true;
    this.state.busy = true;
    this.paint();
    try {
      const project = await api.projects.create(this.state.draft);
      this.state.project = project;
      this.emit(WIZARD_EVENTS.projectCreated, { project });
      return true;
    } catch (error) {
      if (error instanceof QaCrawlerError && error.issues.length > 0 && this.state.validation)
        this.state.validation = { ...this.state.validation, ok: false, blocking: error.issues };
      this.state.actionError = error instanceof Error ? error.message : String(error);
      this.fail(error);
      return false;
    } finally {
      this.state.busy = false;
      this.paint();
    }
  }

  private async launch(again = false): Promise<void> {
    const api = this.api;
    if (!api) return;
    if (!again && !(await this.save())) return;
    const project = this.state.project;
    if (!project) return;
    this.subscription?.close();
    this.state.busy = true;
    this.state.actionError = undefined;
    this.paint();
    try {
      const snapshot = await api.explorations.start(project.id);
      const offset = Date.parse(snapshot.serverTime) - Date.now();
      this.state.run = {
        snapshot,
        counters: emptyCounters(),
        events: [],
        nodes: [],
        edges: [],
        now: Date.now(),
        ...(snapshot.startedAt ? { startedAtMs: Date.parse(snapshot.startedAt) - offset } : {}),
      };
      this.offset = offset;
      this.state.step = 5;
      this.state.visited = 5;
      this.emit(WIZARD_EVENTS.explorationStarted, { exploration: snapshot, project });
      this.subscription = api.explorations.subscribe(
        snapshot.id,
        (event) => {
          this.onEvent(event);
        },
        {
          onError: (error) => {
            this.fail(error);
          },
        },
      );
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = setInterval(() => {
        const run = this.state.run;
        if (!run || run.finishedAtMs) return;
        run.now = Date.now();
        if (run.startedAtMs !== undefined) this.schedule();
      }, 1000);
    } catch (error) {
      this.state.actionError = error instanceof Error ? error.message : String(error);
      this.fail(error);
    } finally {
      this.state.busy = false;
      this.paint();
    }
  }

  private offset = 0;

  private onEvent(event: ExplorationEvent): void {
    const run = this.state.run;
    if (!run) return;
    run.events.push(event);
    if (run.events.length > 500) run.events.splice(0, run.events.length - 500);
    run.counters = applyEvent(run.counters, event);
    const local = Date.parse(event.at) - this.offset;
    if (event.type === 'status') {
      run.snapshot = { ...run.snapshot, status: event.status };
      if (event.status === 'RUNNING') run.startedAtMs = local;
      if (event.status === 'COMPLETED' || event.status === 'FAILED') {
        run.finishedAtMs = local;
        if (this.ticker) clearInterval(this.ticker);
      }
    }
    if (event.type === 'state' && !run.nodes.some((node) => node.id === event.stateId))
      run.nodes.push({ id: event.stateId, label: event.label, route: event.route });
    if (event.type === 'transition' && event.changed) run.edges.push({ from: event.from, to: event.to });
    if (event.type === 'completed') {
      run.summary = event.summary;
      this.emit(WIZARD_EVENTS.explorationCompleted, {
        exploration: { ...run.snapshot, status: 'COMPLETED' },
        summary: event.summary,
      });
    }
    if (event.type === 'failed') {
      run.error = event.error;
      run.snapshot = { ...run.snapshot, status: 'FAILED', error: event.error };
      this.emit(WIZARD_EVENTS.explorationFailed, { exploration: run.snapshot, error: event.error });
    }
    this.emit(WIZARD_EVENTS.explorationProgress, { event, counters: run.counters });
    this.schedule();
  }

  private async openReport(kind: ReportKind): Promise<void> {
    const run = this.state.run;
    const api = this.api;
    const file = run?.summary?.reports[kind];
    if (!run || !api || !file) return;
    try {
      const link = await api.explorations.reportLink(run.snapshot.id);
      const base = link.url.slice(0, link.url.lastIndexOf('/') + 1);
      if ('open' in globalThis) globalThis.open(`${base}${file}`, '_blank', 'noopener');
    } catch (error) {
      this.state.actionError = error instanceof Error ? error.message : String(error);
      this.fail(error);
      this.paint();
    }
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private fail(error: unknown): void {
    const code = error instanceof QaCrawlerError ? error.code : 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    this.emit(WIZARD_EVENTS.error, { code, message });
  }
}

function localeOf(value: string | null | undefined): 'fr' | 'en' {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

export function defineWizard(name = 'qa-crawler-project-wizard'): void {
  if (!('customElements' in globalThis)) return;
  if (!globalThis.customElements.get(name)) globalThis.customElements.define(name, QaCrawlerProjectWizard);
}

export type { Locale };
