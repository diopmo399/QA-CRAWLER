import { createQaCrawler, type QaCrawlerClient, type Subscription } from '../core/client.js';
import { DASHBOARD_EVENTS, type Environment } from '../core/contracts.js';
import { applyEvent, emptyCounters, isTerminal } from '../core/lifecycle.js';
import { dashboardStrings } from './dashboard-i18n.js';
import { DASHBOARD_CSS } from './dashboard-styles.js';
import {
  liveSteps,
  PERIODS,
  PROJECT_TABS,
  renderDashboard,
  type DashboardRoute,
  type DashboardState,
  type ProjectTab,
} from './dashboard-view.js';

/**
 * <qa-crawler-dashboard> — le pilotage d'un espace de travail : vue d'ensemble, projets (lancement,
 * environnements et leur vérification, scénarios, exécutions, politique de sécurité, archivage),
 * exécutions (suivi en direct, annulation, détail). Il ne fait qu'appeler le client du SDK : chaque
 * règle (archivage, écritures par environnement, annulation) est vérifiée par le serveur, jamais par
 * l'écran seul. Une action qui change l'état se confirme dans la page.
 *
 * Attributs : endpoint (API du serveur SDK), locale (fr | en), theme (light | dark | auto),
 * days (période de la vue d'ensemble : 1, 7 ou 30). Propriétés : token (jamais en attribut dans une
 * page publique), client (un client déjà construit). Méthode : open(route).
 *
 * Événements (bubbles, composed) : qa-dashboard-navigate `{ route }`, qa-execution-started
 * `{ projectId, exploration }`, qa-error `{ code, message }`.
 */
const Base: typeof HTMLElement =
  'HTMLElement' in globalThis ? globalThis.HTMLElement : (Object as unknown as typeof HTMLElement);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Un environnement tel qu'on le soumet à la vérification (sans ses champs de stockage). */
const inputOf = (environment: Environment) => {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = environment;
  return input;
};

export class QaCrawlerDashboard extends Base {
  static get observedAttributes(): string[] {
    return ['endpoint', 'locale', 'days'];
  }

  private root!: ShadowRoot;
  private state!: DashboardState;
  private injectedClient?: QaCrawlerClient;
  private ownClient?: QaCrawlerClient;
  private tokenValue?: string;
  private connected = false;
  private subscription?: Subscription;
  /** Chaque chargement porte un numéro : une réponse arrivée après un autre choix est ignorée. */
  private generation = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.state = {
      t: dashboardStrings(this.getAttribute('locale')),
      phase: 'idle',
      route: { view: 'overview' },
      days: 7,
      showArchived: false,
      projectId: '',
      menuOpen: false,
      launch: { kind: 'REPLAY', environmentId: '', scenarios: [], busy: false },
      checks: {},
      cancellation: false,
    };
    this.root.addEventListener('click', (event) => {
      this.onClick(event);
    });
    this.root.addEventListener('change', (event) => {
      this.onChange(event);
    });
    this.root.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.launch();
    });
    this.root.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && this.state.menuOpen) {
        this.state.menuOpen = false;
        this.paint();
        this.root.querySelector<HTMLElement>('[data-action="menu"]')?.focus();
      }
    });
  }

  set token(value: string | undefined) {
    if (value === this.tokenValue) return;
    this.tokenValue = value;
    this.resetClient();
    if (this.connected) void this.load();
  }

  get token(): string | undefined {
    return this.tokenValue;
  }

  set client(value: QaCrawlerClient | undefined) {
    this.injectedClient = value;
    this.resetClient();
    if (this.connected) void this.load();
  }

  /** Ouvrir une vue (lien profond de l'hôte). */
  open(route: DashboardRoute): void {
    this.navigate(route);
  }

  connectedCallback(): void {
    this.connected = true;
    const days = Number(this.getAttribute('days'));
    if ((PERIODS as readonly number[]).includes(days)) this.state.days = days;
    void this.load();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.unsubscribe();
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'locale') {
      this.state.t = dashboardStrings(next);
      this.paint();
      return;
    }
    if (name === 'days') {
      const days = Number(next);
      if ((PERIODS as readonly number[]).includes(days)) this.state.days = days;
    }
    if (name === 'endpoint') this.resetClient();
    if (this.connected) void this.load();
  }

  private get api(): QaCrawlerClient | undefined {
    if (this.injectedClient) return this.injectedClient;
    if (!this.ownClient) {
      const endpoint = this.getAttribute('endpoint');
      if (!endpoint || !this.tokenValue) return undefined;
      this.ownClient = createQaCrawler({ endpoint, token: this.tokenValue });
    }
    return this.ownClient;
  }

  private resetClient(): void {
    this.unsubscribe();
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  private unsubscribe(): void {
    this.subscription?.close();
    this.subscription = undefined;
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private navigate(route: DashboardRoute): void {
    if (route.view !== 'execution') this.unsubscribe();
    if ('projectId' in route && route.projectId !== this.state.projectId) {
      this.state.projectId = route.projectId;
      this.state.checks = {};
    }
    this.state.route = route;
    this.state.confirm = undefined;
    this.state.notice = undefined;
    this.state.menuOpen = false;
    this.emit(DASHBOARD_EVENTS.navigate, { route });
    void this.load();
  }

  /** Le projet du menu, ou le premier projet actif quand aucun n'est choisi. */
  private contextProject(): string | undefined {
    return this.state.projectId || this.state.catalog?.[0]?.id;
  }

  /** Charge ce que la vue courante affiche ; une réponse périmée (autre vue entre-temps) est ignorée. */
  private async load(): Promise<void> {
    const api = this.api;
    if (!api) {
      this.state.phase = 'idle';
      this.paint();
      return;
    }
    const generation = ++this.generation;
    const route = this.state.route;
    if (this.state.phase !== 'ready') {
      this.state.phase = 'loading';
      this.paint();
    }
    try {
      const [capabilities, catalog] = await Promise.all([api.capabilities(), api.projects.list()]);
      if (generation !== this.generation) return;
      this.state.capabilities = capabilities;
      this.state.cancellation = capabilities.cancellation;
      this.state.catalog = catalog.filter((project) => project.state === 'ACTIVE');
      if (route.view === 'overview') {
        this.state.overview = await api.overview.get({ days: this.state.days });
      } else if (route.view === 'projects') {
        this.state.projects = this.state.showArchived ? await api.projects.list({ archived: true }) : catalog;
      } else if (route.view === 'project' || route.view === 'executions') {
        await this.loadProject(api, route.projectId, generation);
      } else {
        if (this.state.project?.id !== route.projectId)
          await this.loadProject(api, route.projectId, generation);
        await this.loadExecution(api, route, generation);
      }
      if (generation !== this.generation) return;
      this.state.phase = 'ready';
      this.state.error = undefined;
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error);
    }
    this.paint();
    if (generation === this.generation && route.view === 'project') this.checkAll(api, generation);
  }

  private async loadProject(api: QaCrawlerClient, projectId: string, generation: number): Promise<void> {
    const [project, executions] = await Promise.all([
      api.projects.detail(projectId),
      api.executions.list(projectId),
    ]);
    if (generation !== this.generation) return;
    if (this.state.project?.id !== project.id) {
      this.state.launch = { kind: 'REPLAY', environmentId: '', scenarios: [], busy: false };
      this.state.checks = {};
    }
    this.state.project = project;
    this.state.executions = executions;
  }

  /**
   * Vérifie chaque environnement du projet affiché (règles du moteur, secrets présents sur le serveur),
   * sans joindre l'URL : la vérification complète se demande par le bouton « Vérifier ».
   */
  private checkAll(api: QaCrawlerClient, generation: number): void {
    const project = this.state.project;
    if (!project || project.state === 'ARCHIVED') return;
    for (const environment of project.environments) {
      if (this.state.checks[environment.id]) continue;
      api.environments
        .check(project.id, inputOf(environment), { selfId: environment.id })
        .then((check) => {
          if (generation !== this.generation || this.state.project?.id !== project.id) return;
          this.state.checks[environment.id] = check;
          this.paint();
        })
        .catch(() => undefined);
    }
  }

  private async checkEnvironment(environmentId: string): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const environment = project?.environments.find((candidate) => candidate.id === environmentId);
    if (!api || !project || !environment || this.state.checking) return;
    this.state.checking = environmentId;
    this.paint();
    try {
      this.state.checks[environmentId] = await api.environments.check(project.id, inputOf(environment), {
        reach: true,
        selfId: environmentId,
      });
    } catch (error) {
      this.fail(error);
    }
    this.state.checking = undefined;
    this.paint();
  }

  private async loadExecution(
    api: QaCrawlerClient,
    route: Extract<DashboardRoute, { view: 'execution' }>,
    generation: number,
  ): Promise<void> {
    if (route.explorationId) {
      const snapshot = await api.explorations.status(route.explorationId);
      if (generation !== this.generation) return;
      if (!isTerminal(snapshot.status)) {
        this.state.execution = undefined;
        if (this.state.live?.snapshot.id !== snapshot.id)
          this.state.live = { snapshot, steps: [], cancelRequested: false };
        else this.state.live.snapshot = snapshot;
        this.follow(api, snapshot.id, route.projectId, route.run);
        return;
      }
      this.state.live = { snapshot, steps: this.state.live?.steps ?? [], cancelRequested: false };
    }
    this.state.execution = await api.executions.get(route.projectId, route.run);
  }

  /** Le flux de l'exécution : étapes et phases en direct, puis le détail lu sur disque. */
  private follow(api: QaCrawlerClient, id: string, projectId: string, run: string): void {
    if (this.subscription) return;
    // Le flux rejoue tout depuis le premier événement : les compteurs repartent de zéro et se reconstruisent.
    const live = this.state.live;
    if (live?.snapshot.id === id) live.snapshot.counters = emptyCounters();
    this.subscription = api.explorations.subscribe(
      id,
      (event) => {
        const live = this.state.live;
        if (!live || live.snapshot.id !== id) return;
        if (event.type === 'flow-step') live.steps = liveSteps(live.steps, event);
        if (event.type === 'phase') live.phase = event.phase;
        if (event.type === 'status') live.snapshot = { ...live.snapshot, status: event.status };
        // Les compteurs d'une exploration avancent avec ses événements, comme sur le serveur.
        live.snapshot.counters = applyEvent(live.snapshot.counters, event);
        if (event.type === 'completed' || event.type === 'failed') {
          this.unsubscribe();
          // Le statut final suit l'événement de fin ; le détail est écrit par le moteur.
          void this.settle(api, id, projectId, run);
          return;
        }
        this.paint();
      },
      {
        onError: (error) => {
          this.unsubscribe();
          this.state.notice = message(error);
          this.paint();
        },
      },
    );
  }

  private async settle(api: QaCrawlerClient, id: string, projectId: string, run: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await api.explorations.status(id).catch(() => undefined);
      if (snapshot && isTerminal(snapshot.status)) {
        if (this.state.live?.snapshot.id === id) this.state.live.snapshot = snapshot;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const route = this.state.route;
    if (route.view === 'execution' && route.projectId === projectId && route.run === run) void this.load();
  }

  private fail(error: unknown): void {
    const code = (error as { code?: string }).code;
    this.emit('qa-error', { code: code ?? 'ERROR', message: message(error) });
    // Un refus du serveur (projet introuvable, archivé…) se dit dans la vue ; un serveur absent la remplace.
    if (code === 'UNREACHABLE' || this.state.phase !== 'ready') {
      this.state.phase = 'error';
      this.state.error = message(error);
    } else {
      this.state.notice = message(error);
    }
  }

  private async launch(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    if (!api || !project || this.state.launch.busy) return;
    this.state.launch.busy = true;
    this.state.launch.error = undefined;
    this.paint();
    try {
      const { kind, environmentId, scenarios } = this.state.launch;
      const started =
        kind === 'EXPLORATION'
          ? await api.explorations.start(project.id)
          : await api.executions.start(project.id, {
              ...(environmentId ? { environmentId } : {}),
              ...(scenarios.length > 0 ? { scenarios } : {}),
            });
      this.state.launch.busy = false;
      this.emit(DASHBOARD_EVENTS.executionStarted, { projectId: project.id, exploration: started });
      this.state.live = { snapshot: started, steps: [], cancelRequested: false };
      this.navigate({
        view: 'execution',
        projectId: project.id,
        run: started.run ?? '',
        explorationId: started.id,
      });
    } catch (error) {
      this.state.launch.busy = false;
      this.state.launch.error = message(error);
      this.paint();
    }
  }

  private async act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      this.state.confirm = undefined;
      await this.load();
    } catch (error) {
      this.state.confirm = undefined;
      this.fail(error);
      this.paint();
    }
  }

  private onClick(event: Event): void {
    const target = (event.target as Element).closest<HTMLElement>('[data-action]');
    if (!target || target.tagName === 'FORM' || target.tagName === 'SELECT' || target.tagName === 'INPUT')
      return;
    const action = target.dataset.action;
    const api = this.api;
    if (target.tagName === 'A') event.preventDefault();
    switch (action) {
      case 'menu':
        this.state.menuOpen = !this.state.menuOpen;
        this.paint();
        return;
      case 'nav': {
        const view = target.dataset.view;
        if (view === 'projects') this.navigate({ view: 'projects' });
        else if (view === 'executions') {
          const projectId = this.contextProject();
          if (projectId) this.navigate({ view: 'executions', projectId });
          else this.navigate({ view: 'projects' });
        } else this.navigate({ view: 'overview' });
        return;
      }
      case 'launch-shortcut': {
        const projectId = this.contextProject();
        if (projectId) this.navigate({ view: 'project', projectId, tab: 'launch' });
        else this.navigate({ view: 'projects' });
        return;
      }
      case 'open-project':
        if (target.dataset.project) this.navigate({ view: 'project', projectId: target.dataset.project });
        return;
      case 'tab': {
        const route = this.state.route;
        const tab = target.dataset.tab as ProjectTab | undefined;
        if (route.view === 'project' && tab && (PROJECT_TABS as readonly string[]).includes(tab)) {
          this.state.route = { ...route, tab };
          this.state.confirm = undefined;
          this.paint();
          this.root.querySelector<HTMLElement>(`[data-action="tab"][data-tab="${tab}"]`)?.focus();
        }
        return;
      }
      case 'open-run':
        if (target.dataset.project && target.dataset.run) {
          this.state.live = undefined;
          this.state.execution = undefined;
          this.navigate({ view: 'execution', projectId: target.dataset.project, run: target.dataset.run });
        }
        return;
      case 'back': {
        const route = this.state.route;
        if (target.dataset.to === 'project' && 'projectId' in route)
          this.navigate({ view: 'project', projectId: route.projectId });
        else this.navigate({ view: 'projects' });
        return;
      }
      case 'check-env':
        if (target.dataset.env) void this.checkEnvironment(target.dataset.env);
        return;
      case 'retry':
      case 'refresh':
        void this.load();
        return;
      case 'archive':
        this.state.confirm = 'archive';
        this.paint();
        return;
      case 'cancel':
        this.state.confirm = 'cancel';
        this.paint();
        return;
      case 'confirm-cancel':
        this.state.confirm = undefined;
        this.paint();
        return;
      case 'archive-confirm':
        if (api && this.state.project) {
          const id = this.state.project.id;
          void this.act(() => api.projects.archive(id));
        }
        return;
      case 'restore':
        if (api && this.state.project) {
          const id = this.state.project.id;
          void this.act(() => api.projects.restore(id));
        }
        return;
      case 'cancel-confirm': {
        const live = this.state.live;
        if (!api || !live) return;
        this.state.confirm = undefined;
        live.cancelRequested = true;
        this.paint();
        api.explorations.cancel(live.snapshot.id).catch((error: unknown) => {
          live.cancelRequested = false;
          this.fail(error);
          this.paint();
        });
        return;
      }
      case 'report': {
        const route = this.state.route;
        if (!api || route.view !== 'execution') return;
        api.reports
          .link(route.projectId, 'exploration', route.run)
          .then((link) => {
            globalThis.open(link.url, '_blank', 'noopener');
          })
          .catch((error: unknown) => {
            this.fail(error);
            this.paint();
          });
        return;
      }
      default:
        return;
    }
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.dataset.action === 'period') {
      const days = Number(target.value);
      if ((PERIODS as readonly number[]).includes(days)) this.state.days = days;
      void this.load();
      return;
    }
    if (target.dataset.action === 'archived') {
      this.state.showArchived = (target as HTMLInputElement).checked;
      void this.load();
      return;
    }
    if (target.dataset.action === 'project-context') {
      const projectId = target.value;
      const route = this.state.route;
      this.state.projectId = projectId;
      if (!projectId) {
        if (route.view !== 'overview' && route.view !== 'projects') this.navigate({ view: 'overview' });
        else this.paint();
        return;
      }
      if (route.view === 'executions') this.navigate({ view: 'executions', projectId });
      else this.navigate({ view: 'project', projectId });
      return;
    }
    if (target.dataset.bind === 'kind') {
      this.state.launch.kind = target.value === 'EXPLORATION' ? 'EXPLORATION' : 'REPLAY';
      this.paint();
      return;
    }
    if (target.dataset.bind === 'environment') {
      this.state.launch.environmentId = target.value;
      this.paint();
      return;
    }
    if (target.dataset.bind === 'scenario') {
      const chosen = new Set(this.state.launch.scenarios);
      if ((target as HTMLInputElement).checked) chosen.add(target.value);
      else chosen.delete(target.value);
      this.state.launch.scenarios = [...chosen];
      this.paint();
    }
  }

  private paint(): void {
    if (!this.connected) return;
    const focused = this.root.activeElement as HTMLElement | null;
    const focusKey = focused?.dataset.action ?? focused?.dataset.bind;
    const focusValue = (focused as HTMLInputElement | null)?.value;
    this.root.innerHTML = `<style>${DASHBOARD_CSS}</style>${renderDashboard(this.state)}`;
    if (focusKey) {
      const candidates = [
        ...this.root.querySelectorAll<HTMLElement>(`[data-action="${focusKey}"],[data-bind="${focusKey}"]`),
      ];
      const same = candidates.find((element) => (element as HTMLInputElement).value === focusValue);
      (same ?? candidates[0])?.focus();
    }
  }
}

export function defineDashboard(name = 'qa-crawler-dashboard'): void {
  if (!('customElements' in globalThis) || customElements.get(name)) return;
  customElements.define(name, QaCrawlerDashboard);
}
