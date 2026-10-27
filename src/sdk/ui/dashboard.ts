import { createQaCrawler, type QaCrawlerClient, type Subscription } from '../core/client.js';
import { DASHBOARD_EVENTS, type Environment } from '../core/contracts.js';
import { applyEvent, emptyCounters, isTerminal } from '../core/lifecycle.js';
import { dashboardStrings } from './dashboard-i18n.js';
import { environmentForm, environmentInputOf } from './dashboard-ops.js';
import {
  connectorOfFile,
  emptyImportForm,
  emptyLinkForm,
  TREND_WEEKS,
  type ImportForm,
  type LinkForm,
} from './dashboard-requirements.js';
import { DASHBOARD_CSS } from './dashboard-styles.js';
import {
  liveSteps,
  PERIODS,
  PROJECT_TABS,
  renderDashboard,
  type DashboardRoute,
  type DashboardState,
  type EnvironmentForm,
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

/** Le formulaire ouvert : l'identifiant de l'environnement, ou « new » pour une création. */
const formKey = (form: EnvironmentForm | undefined): string | undefined =>
  form ? (form.id ?? 'new') : undefined;

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
  /** Le fichier choisi pour un import (jamais dans l'état rendu). */
  private file?: File;

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
      picked: [],
      severity: 'ALL',
      req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
    };
    this.root.addEventListener('click', (event) => {
      this.onClick(event);
    });
    this.root.addEventListener('change', (event) => {
      this.onChange(event);
    });
    this.root.addEventListener('submit', (event) => {
      event.preventDefault();
      if ((event.target as HTMLElement).dataset.action === 'launch') void this.launch();
    });
    // La saisie d'un formulaire d'environnement : gardée dans l'état sans redessiner (le focus reste).
    this.root.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement;
      const reqField = target.dataset.req as keyof ImportForm | undefined;
      if (reqField && reqField !== 'source' && target.type !== 'file') {
        (this.state.req.form as unknown as Record<string, string>)[reqField] = target.value;
        return;
      }
      const linkField = target.dataset.linkField as keyof LinkForm | undefined;
      if (linkField && this.state.req.linkForm) {
        this.state.req.linkForm[linkField] = target.value;
        return;
      }
      const name = target.dataset.field as keyof EnvironmentForm | undefined;
      if (!name || !this.state.envForm || name === 'writes') return;
      (this.state.envForm as unknown as Record<string, string>)[name] = target.value;
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
    if ('projectId' in route && route.projectId !== undefined && route.projectId !== this.state.projectId) {
      this.state.projectId = route.projectId;
      this.state.checks = {};
      this.state.picked = [];
      this.state.comparison = undefined;
      const { form: _form, kind, source, weeks } = this.state.req;
      this.state.req = { form: emptyImportForm(), kind, source, weeks };
      this.file = undefined;
    }
    if (route.view !== 'import') this.state.req.batch = undefined;
    this.state.req.linkForm = undefined;
    this.state.req.error = undefined;
    if (route.view !== 'environments' || route.environmentId !== formKey(this.state.envForm)) {
      this.state.envForm = undefined;
      this.state.envCheck = undefined;
      this.state.envError = undefined;
    }
    if (route.view !== 'explorations' || route.run !== this.state.explored?.run) {
      this.state.explored = undefined;
      this.state.graph = undefined;
      this.state.severity = 'ALL';
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
      } else if (route.view === 'history') {
        await this.loadProject(api, route.projectId, generation);
      } else if (route.view === 'scenarios') {
        await this.loadProject(api, route.projectId, generation);
        const [history, recordings] = await Promise.all([
          api.scenarios.history(route.projectId),
          api.recordings.list(route.projectId).catch(() => []),
        ]);
        if (generation !== this.generation) return;
        this.state.scenarioHistory = history;
        this.state.recordings = recordings;
      } else if (route.view === 'environments') {
        await this.loadProject(api, route.projectId, generation);
        if (generation !== this.generation) return;
        if (route.environmentId && formKey(this.state.envForm) !== route.environmentId) {
          const existing = this.state.project?.environments.find((env) => env.id === route.environmentId);
          this.state.envForm = environmentForm(route.environmentId === 'new' ? undefined : existing);
          this.state.envCheck = undefined;
        }
      } else if (route.view === 'explorations') {
        await this.loadProject(api, route.projectId, generation);
        if (route.run) {
          const run = route.run;
          const [detail, graph] = await Promise.all([
            api.executions.get(route.projectId, run),
            api.graph.of(route.projectId, 'exploration', run).catch(() => undefined),
          ]);
          if (generation !== this.generation) return;
          this.state.explored = detail;
          this.state.graph = graph;
        }
      } else if (route.view === 'execution') {
        if (this.state.project?.id !== route.projectId)
          await this.loadProject(api, route.projectId, generation);
        await this.loadExecution(api, route, generation);
      } else {
        await this.loadRequirements(api, route, generation);
      }
      if (generation !== this.generation) return;
      this.state.phase = 'ready';
      this.state.error = undefined;
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error);
    }
    this.paint();
    if (generation === this.generation && (route.view === 'project' || route.view === 'environments'))
      this.checkAll(api, generation);
  }

  /** Les écrans des exigences : le référentiel sert aussi au compteur du menu. */
  private async loadRequirements(
    api: QaCrawlerClient,
    route: Extract<
      DashboardRoute,
      { view: 'sources' | 'import' | 'requirements' | 'traceability' | 'indicators' | 'trends' }
    >,
    generation: number,
  ): Promise<void> {
    const req = this.state.req;
    if (route.view === 'trends') {
      if (route.projectId) await this.loadProject(api, route.projectId, generation);
      const trends = await api.trends.get({
        weeks: req.weeks,
        ...(route.projectId ? { projectId: route.projectId } : {}),
      });
      if (generation !== this.generation) return;
      req.trends = trends;
      return;
    }
    const projectId = route.projectId;
    await this.loadProject(api, projectId, generation);
    const [repository, extra] = await Promise.all([
      api.requirements.get(projectId),
      route.view === 'sources'
        ? Promise.all([
            api.requirements.connectors(projectId),
            api.requirements.profiles(projectId),
            api.requirements.imports(projectId),
          ])
        : route.view === 'import'
          ? api.requirements.importBatch(projectId, route.batchId)
          : route.view === 'traceability'
            ? api.requirements.matrix(projectId)
            : route.view === 'indicators'
              ? api.requirements.indicators(projectId, { days: this.state.days })
              : undefined,
    ]);
    if (generation !== this.generation) return;
    req.repository = repository;
    if (route.view === 'sources') {
      const [connectors, profiles, imports] = extra as [
        NonNullable<typeof req.connectors>,
        NonNullable<typeof req.profiles>,
        NonNullable<typeof req.imports>,
      ];
      req.connectors = connectors;
      req.profiles = profiles;
      req.imports = imports;
    } else if (route.view === 'import') req.batch = extra as NonNullable<typeof req.batch>;
    else if (route.view === 'traceability') req.matrix = extra as NonNullable<typeof req.matrix>;
    else if (route.view === 'indicators') req.indicators = extra as NonNullable<typeof req.indicators>;
  }

  /** Lire une source : le fichier choisi (envoyé tel quel) ou une page Confluence (variables nommées). */
  private async importSource(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const req = this.state.req;
    if (!api || !project || req.busy) return;
    const form = req.form;
    const t = this.state.t.req;
    let call: () => Promise<{ id: string }>;
    if (form.source === 'FILE') {
      const file = this.file;
      const connector = file ? connectorOfFile(file.name) : undefined;
      if (!file || !connector) {
        req.error = file ? t.unknownFormat : t.noFile;
        this.paint();
        return;
      }
      call = () =>
        api.requirements.importFile(project.id, {
          connector,
          name: file.name,
          data: file,
          ...(form.profile ? { profile: form.profile } : {}),
        });
    } else {
      call = () =>
        api.requirements.importConfluence(project.id, {
          baseUrl: form.baseUrl.trim(),
          page: form.page.trim(),
          ...(form.variant ? { variant: form.variant } : {}),
          auth: {
            tokenEnv: form.tokenEnv.trim(),
            ...(form.userEnv.trim() ? { userEnv: form.userEnv.trim() } : {}),
          },
          ...(form.profile ? { profile: form.profile } : {}),
        });
    }
    req.busy = true;
    req.error = undefined;
    this.paint();
    try {
      const batch = await call();
      req.busy = false;
      this.file = undefined;
      req.form = { ...emptyImportForm(), source: form.source };
      this.navigate({ view: 'import', projectId: project.id, batchId: batch.id });
    } catch (error) {
      req.busy = false;
      req.error = message(error);
      this.paint();
    }
  }

  private async decideItem(
    itemId: string,
    action: 'ACCEPT' | 'REJECT' | 'MERGE',
    extra: { kind?: string; mergeInto?: string },
  ): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const req = this.state.req;
    const batch = req.batch;
    if (!api || !project || !batch || req.deciding) return;
    req.deciding = itemId;
    req.error = undefined;
    this.paint();
    try {
      req.batch = await api.requirements.decide(project.id, batch.id, [
        {
          itemId,
          decision: {
            action,
            ...(extra.kind ? { kind: extra.kind as 'REQUIREMENT' } : {}),
            ...(extra.mergeInto ? { mergeInto: extra.mergeInto } : {}),
          },
        },
      ]);
    } catch (error) {
      req.error = message(error);
    }
    req.deciding = undefined;
    this.paint();
  }

  private async publishBatch(acknowledgePartial: boolean): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const req = this.state.req;
    const batch = req.batch;
    if (!api || !project || !batch || req.busy) return;
    req.busy = true;
    req.error = undefined;
    this.state.confirm = undefined;
    this.paint();
    try {
      const result = await api.requirements.publish(project.id, batch.id, { acknowledgePartial });
      req.busy = false;
      await this.load();
      this.state.notice = this.state.t.req.published(
        result.created.length,
        result.updated.length,
        result.merged.length,
      );
      this.paint();
    } catch (error) {
      req.busy = false;
      req.error = message(error);
      this.paint();
    }
  }

  /** L'élément affiché par le référentiel ou la matrice. */
  private shownEntity(): string | undefined {
    const route = this.state.route;
    return route.view === 'requirements' || route.view === 'traceability' ? route.entityId : undefined;
  }

  private async addLinkNow(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const req = this.state.req;
    const form = req.linkForm;
    const entityId = this.shownEntity();
    const entity = req.repository?.entities.find((candidate) => candidate.id === entityId);
    if (!api || !project || !form || !entity) return;
    try {
      await api.requirements.addLink(project.id, {
        type: form.type as 'TESTED_BY',
        from: { kind: entity.kind, id: entity.id, version: String(entity.version) },
        to: { kind: form.targetKind, id: form.targetId.trim() },
        justification: form.justification.trim() ? [form.justification.trim()] : [],
      });
      req.linkForm = undefined;
      await this.load();
      this.state.notice = this.state.t.req.linkAdded;
      this.paint();
    } catch (error) {
      req.error = message(error);
      this.paint();
    }
  }

  private async exportCsv(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    if (!api || !project) return;
    try {
      const csv = await api.requirements.matrixCsv(project.id);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `traceability-${project.id}.csv`;
      this.root.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (error) {
      this.fail(error);
      this.paint();
    }
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

  /** Compare les deux exécutions cochées : la plus ancienne est la base, la plus récente la tête. */
  private async compare(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    if (!api || !project || this.state.picked.length !== 2) return;
    const records = (this.state.executions ?? []).filter((row) => this.state.picked.includes(row.run));
    const [head, base] = records;
    if (!head || !base) return;
    this.state.comparing = true;
    this.state.comparison = undefined;
    this.paint();
    try {
      this.state.comparison = await api.reports.compare(project.id, base.run, head.run);
    } catch (error) {
      this.fail(error);
    }
    this.state.comparing = false;
    this.paint();
  }

  /** Lance un rejeu de ces scénarios, dans l'environnement de l'exécution de référence s'il y en a un. */
  private async replay(scenarios: string[], environmentId?: string): Promise<void> {
    const project = this.state.project;
    if (!project) return;
    this.state.launch = {
      kind: 'REPLAY',
      environmentId: environmentId ?? '',
      scenarios,
      busy: false,
    };
    await this.launch();
  }

  private async saveEnvironment(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const form = this.state.envForm;
    if (!api || !project || !form || this.state.envBusy) return;
    const converted = environmentInputOf(form, this.state.t);
    if ('error' in converted) {
      this.state.envError = converted.error;
      this.paint();
      return;
    }
    this.state.envBusy = true;
    this.state.envError = undefined;
    this.paint();
    try {
      const saved = form.id
        ? await api.environments.update(project.id, form.id, converted.input)
        : await api.environments.create(project.id, converted.input);
      this.state.envBusy = false;
      this.state.envForm = undefined;
      this.state.checks = {};
      this.navigate({ view: 'environments', projectId: project.id, environmentId: saved.id });
      this.state.notice = this.state.t.ops.saved;
    } catch (error) {
      this.state.envBusy = false;
      this.state.envError = message(error);
      this.paint();
    }
  }

  private async verifyEnvironment(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const form = this.state.envForm;
    if (!api || !project || !form || this.state.envBusy) return;
    const converted = environmentInputOf(form, this.state.t);
    if ('error' in converted) {
      this.state.envError = converted.error;
      this.paint();
      return;
    }
    this.state.envBusy = true;
    this.state.envError = undefined;
    this.paint();
    try {
      this.state.envCheck = await api.environments.check(project.id, converted.input, {
        reach: true,
        ...(form.id ? { selfId: form.id } : {}),
      });
    } catch (error) {
      this.state.envError = message(error);
    }
    this.state.envBusy = false;
    this.paint();
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
        const projectId = this.contextProject();
        if (view === 'projects') this.navigate({ view: 'projects' });
        else if (view === 'trends')
          this.navigate({
            view: 'trends',
            ...(this.state.projectId ? { projectId: this.state.projectId } : {}),
          });
        else if (
          view === 'executions' ||
          view === 'history' ||
          view === 'scenarios' ||
          view === 'explorations' ||
          view === 'environments' ||
          view === 'sources' ||
          view === 'requirements' ||
          view === 'traceability' ||
          view === 'indicators'
        ) {
          if (projectId) this.navigate({ view, projectId });
          else this.navigate({ view: 'projects' });
        } else this.navigate({ view: 'overview' });
        return;
      }
      case 'import':
        void this.importSource();
        return;
      case 'open-import': {
        const project = this.state.project;
        if (project && target.dataset.batch)
          this.navigate({ view: 'import', projectId: project.id, batchId: target.dataset.batch });
        return;
      }
      case 'decide': {
        const itemId = target.dataset.item;
        const decision = target.dataset.decision;
        if (!itemId || (decision !== 'ACCEPT' && decision !== 'REJECT' && decision !== 'MERGE')) return;
        const kind = this.root.querySelector<HTMLSelectElement>(
          `select[data-kind-for="${CSS.escape(itemId)}"]`,
        )?.value;
        void this.decideItem(itemId, decision, {
          ...(kind ? { kind } : {}),
          ...(target.dataset.into ? { mergeInto: target.dataset.into } : {}),
        });
        return;
      }
      case 'publish':
        if (this.state.req.batch?.completeness === 'PARTIAL') {
          this.state.confirm = 'publish-partial';
          this.paint();
        } else void this.publishBatch(false);
        return;
      case 'publish-confirm':
        void this.publishBatch(true);
        return;
      case 'pick-entity':
      case 'pick-trace': {
        const route = this.state.route;
        if ((route.view === 'requirements' || route.view === 'traceability') && target.dataset.entity) {
          this.state.route = { ...route, entityId: target.dataset.entity };
          this.state.req.linkForm = undefined;
          this.state.req.error = undefined;
          this.paint();
        }
        return;
      }
      case 'link-open':
        this.state.req.linkForm = emptyLinkForm();
        this.state.req.error = undefined;
        this.paint();
        return;
      case 'link-cancel':
        this.state.req.linkForm = undefined;
        this.state.req.error = undefined;
        this.paint();
        return;
      case 'link-add':
        void this.addLinkNow();
        return;
      case 'link-decide': {
        const project = this.state.project;
        const link = target.dataset.link;
        const decision = target.dataset.decision;
        if (!api || !project || !link || (decision !== 'CONFIRM' && decision !== 'REJECT')) return;
        void this.act(() => api.requirements.decideLink(project.id, link, decision));
        return;
      }
      case 'export-csv':
        void this.exportCsv();
        return;
      case 'pick-scenario': {
        const route = this.state.route;
        if (route.view === 'scenarios' && target.dataset.name) {
          this.state.route = { ...route, scenario: target.dataset.name };
          this.paint();
        }
        return;
      }
      case 'promote': {
        const recording = target.dataset.recording;
        const project = this.state.project;
        if (!api || !project || !recording) return;
        this.state.promoting = recording;
        this.paint();
        api.scenarios
          .promote(project.id, recording)
          .then((scenario) => {
            this.state.promoting = undefined;
            this.navigate({ view: 'scenarios', projectId: project.id, scenario: scenario.name });
          })
          .catch((error: unknown) => {
            this.state.promoting = undefined;
            this.fail(error);
            this.paint();
          });
        return;
      }
      case 'replay-scenario':
        if (target.dataset.name) void this.replay([target.dataset.name]);
        return;
      case 'replay-failed': {
        const comparison = this.state.comparison;
        if (!comparison) return;
        const head = (this.state.executions ?? []).find((row) => row.run === comparison.head.run);
        void this.replay(comparison.summary.newlyFailing, head?.environment?.id);
        return;
      }
      case 'edit-env': {
        const project = this.state.project;
        if (project && target.dataset.env)
          this.navigate({ view: 'environments', projectId: project.id, environmentId: target.dataset.env });
        return;
      }
      case 'env-verify':
        void this.verifyEnvironment();
        return;
      case 'env-save':
        void this.saveEnvironment();
        return;
      case 'env-remove':
        this.state.confirm = 'remove-env';
        this.paint();
        return;
      case 'env-remove-confirm': {
        const project = this.state.project;
        const id = this.state.envForm?.id;
        if (!api || !project || !id) return;
        void this.act(async () => {
          await api.environments.remove(project.id, id, { confirm: true });
          this.state.envForm = undefined;
          this.state.route = { view: 'environments', projectId: project.id };
        });
        return;
      }
      case 'open-exploration': {
        const project = this.state.project;
        if (project && target.dataset.run)
          this.navigate({ view: 'explorations', projectId: project.id, run: target.dataset.run });
        return;
      }
      case 'severity':
        this.state.severity = target.dataset.level ?? 'ALL';
        this.paint();
        return;
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
        if (target.dataset.to === 'project' && 'projectId' in route && route.projectId)
          this.navigate({ view: 'project', projectId: route.projectId });
        else if (target.dataset.to === 'explorations' && route.view === 'explorations')
          this.navigate({ view: 'explorations', projectId: route.projectId });
        else if (target.dataset.to === 'sources' && route.view === 'import')
          this.navigate({ view: 'sources', projectId: route.projectId });
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
        const run =
          route.view === 'execution' ? route.run : route.view === 'explorations' ? route.run : undefined;
        const reportProject = 'projectId' in route ? route.projectId : undefined;
        if (!api || !run || !reportProject) return;
        api.reports
          .link(reportProject, 'exploration', run)
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
      if (route.view === 'trends') {
        this.navigate({ view: 'trends', ...(projectId ? { projectId } : {}) });
        return;
      }
      if (!projectId) {
        if (route.view !== 'overview' && route.view !== 'projects') this.navigate({ view: 'overview' });
        else this.paint();
        return;
      }
      if (
        route.view === 'executions' ||
        route.view === 'history' ||
        route.view === 'scenarios' ||
        route.view === 'explorations' ||
        route.view === 'environments' ||
        route.view === 'sources' ||
        route.view === 'requirements' ||
        route.view === 'traceability' ||
        route.view === 'indicators'
      )
        this.navigate({ view: route.view, projectId });
      else if (route.view === 'import') this.navigate({ view: 'sources', projectId });
      else this.navigate({ view: 'project', projectId });
      return;
    }
    if (target.dataset.action === 'req-kind' || target.dataset.action === 'req-source') {
      if (target.dataset.action === 'req-kind') this.state.req.kind = target.value;
      else this.state.req.source = target.value;
      this.paint();
      return;
    }
    if (target.dataset.action === 'trend-weeks') {
      const weeks = Number(target.value);
      if ((TREND_WEEKS as readonly number[]).includes(weeks)) this.state.req.weeks = weeks;
      void this.load();
      return;
    }
    if (target.dataset.req) {
      const form = this.state.req.form;
      if (target.dataset.req === 'file') {
        this.file = (target as HTMLInputElement).files?.[0];
        form.fileName = this.file?.name ?? '';
        form.profile = '';
        this.state.req.error = undefined;
        this.paint();
        return;
      }
      if (target.dataset.req === 'source') {
        form.source = target.value === 'CONFLUENCE' ? 'CONFLUENCE' : 'FILE';
        form.profile = '';
        this.state.req.error = undefined;
        this.paint();
        return;
      }
      (form as unknown as Record<string, string>)[target.dataset.req] = target.value;
      return;
    }
    if (target.dataset.linkField && this.state.req.linkForm) {
      (this.state.req.linkForm as unknown as Record<string, string>)[target.dataset.linkField] = target.value;
      return;
    }
    if (target.dataset.bind === 'pick') {
      const run = target.value;
      const checked = (target as HTMLInputElement).checked;
      const picked = this.state.picked.filter((entry) => entry !== run);
      this.state.picked = checked ? [...picked, run].slice(-2) : picked;
      this.state.comparison = undefined;
      if (this.state.picked.length === 2) void this.compare();
      else this.paint();
      return;
    }
    if (target.dataset.field && this.state.envForm) {
      // Un champ texte est déjà gardé à chaque frappe (écouteur input) : ne rien redessiner ici, sinon
      // le champ qui prend le focus serait remplacé pendant la saisie. Seules les écritures changent
      // la page (le plafond se grise).
      const form = this.state.envForm as unknown as Record<string, string | boolean>;
      if (target.dataset.field !== 'writes') {
        form[target.dataset.field] = target.value;
        return;
      }
      form.writes = (target as HTMLInputElement).checked;
      this.paint();
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
    const focusKey =
      focused?.dataset.action ?? focused?.dataset.bind ?? focused?.dataset.field ?? focused?.dataset.req;
    const focusValue = (focused as HTMLInputElement | null)?.value;
    this.root.innerHTML = `<style>${DASHBOARD_CSS}</style>${renderDashboard(this.state)}`;
    if (focusKey) {
      const candidates = [
        ...this.root.querySelectorAll<HTMLElement>(
          `[data-action="${focusKey}"],[data-bind="${focusKey}"],[data-field="${focusKey}"],[data-req="${focusKey}"]`,
        ),
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
