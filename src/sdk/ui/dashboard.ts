import { createQaCrawler, QaCrawlerError, type QaCrawlerClient, type Subscription } from '../core/client.js';
import {
  DASHBOARD_EVENTS,
  GENERATION_FORMATS,
  type Environment,
  type GenerationFormatName,
  type Role,
} from '../core/contracts.js';
import { applyEvent, emptyCounters, isTerminal } from '../core/lifecycle.js';
import { dashboardStrings } from './dashboard-i18n.js';
import { emptyAccessUi } from './dashboard-access.js';
import { emptyRecordingsUi, newLiveRecording, type LiveRecording } from './dashboard-recordings.js';
import { compositionKey, emptyLibraryUi, runnableScenarios, type LibraryUi } from './dashboard-library.js';
import { activeRuns, emptyTestsUi, finishedRecordings } from './dashboard-tests.js';
import { emptyEditorUi } from './dashboard-editor.js';
import { EditorController, type EditorHost } from './dashboard-editor-controller.js';
import { PublishController, type PublishHost } from './dashboard-publish-controller.js';
import {
  assertionBuckets,
  bindFormOf,
  correctionWaiting,
  emptyReviewUi,
  REVIEW_TABS,
  rowColumnsOf,
  type RowChoice,
  type BindForm,
  type ReviewTab,
  type ReviewUi,
} from './dashboard-review.js';
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
 * Attributs : endpoint (API du serveur SDK), locale (fr | en), theme (light | dark | auto), sign-in
 * (mode nominatif : demander le jeton personnel, gardé pour l'onglet),
 * days (période de la vue d'ensemble : 1, 7 ou 30). Propriétés : token (jamais en attribut dans une
 * page publique), client (un client déjà construit). Méthode : open(route).
 *
 * Événements (bubbles, composed) : qa-dashboard-navigate `{ route }`, qa-execution-started
 * `{ projectId, exploration }`, qa-error `{ code, message }`.
 */
const Base: typeof HTMLElement =
  'HTMLElement' in globalThis ? globalThis.HTMLElement : (Object as unknown as typeof HTMLElement);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** Les raisons détaillées d'un refus du serveur (une par ligne). */
const detailsOf = (error: unknown): string[] => (error instanceof QaCrawlerError ? error.details : []);

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
    return ['endpoint', 'locale', 'days', 'sign-in'];
  }

  private root!: ShadowRoot;
  private state!: DashboardState;
  private injectedClient?: QaCrawlerClient;
  private ownClient?: QaCrawlerClient;
  private tokenValue?: string;
  private connected = false;
  private subscription?: Subscription;
  /** Le suivi en direct d'un enregistrement (indépendant de celui d'une exécution). */
  private recSubscription?: Subscription;
  private replayTimer?: ReturnType<typeof setTimeout>;
  private correctionTimer?: ReturnType<typeof setTimeout>;
  /** L'éditeur des tests générés (écran Éditeur). */
  private readonly editor: EditorController;
  private readonly publisher: PublishController;
  /** Le suivi des exécutions de tests générés en cours (écran Tests). */
  private testsTimer?: ReturnType<typeof setTimeout>;
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
      signIn: false,
      access: emptyAccessUi(),
      recs: emptyRecordingsUi(),
      lib: emptyLibraryUi(),
      tst: emptyTestsUi(),
      ed: emptyEditorUi(),
    };
    // Le contrôleur de l'éditeur voit l'état courant du Dashboard (lu à chaque accès).
    const host = {
      root: this.root,
      api: () => this.api,
      paint: () => {
        this.paint();
      },
      navigate: (route: DashboardRoute) => {
        this.navigate(route);
      },
    };
    Object.defineProperty(host, 'state', { get: () => this.state });
    this.editor = new EditorController(host as EditorHost);
    // La publication de groupes métier (revue) : relit la bibliothèque et le projet après une publication.
    const publishHost = {
      root: this.root,
      api: () => this.api,
      paint: () => {
        this.paint();
      },
      refresh: () => this.load(),
    };
    Object.defineProperty(publishHost, 'state', { get: () => this.state });
    this.publisher = new PublishController(publishHost as PublishHost);
    this.root.addEventListener('click', (event) => {
      this.onClick(event);
    });
    this.root.addEventListener('change', (event) => {
      this.onChange(event);
    });
    this.root.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = (event.target as HTMLElement).dataset.action;
      if (form === 'launch') void this.launch();
      if (form === 'sign-in')
        this.signInWith(this.root.querySelector<HTMLInputElement>('[data-bind="token"]')?.value ?? '');
      if (form === 'rec-checkpoint') void this.recordingControl('checkpoint');
      if (form?.startsWith('review-')) this.reviewSubmit(event.target as HTMLFormElement);
      if (form?.startsWith('lib-')) this.librarySubmit(event.target as HTMLFormElement);
      if (form === 'tst-generate') void this.testsGenerate();
      if (form === 'ed-add-submit') this.editor.submit(event.target as HTMLFormElement);
    });
    // La saisie d'un formulaire d'environnement : gardée dans l'état sans redessiner (le focus reste).
    this.root.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement;
      const reqField = target.dataset.req as keyof ImportForm | undefined;
      if (reqField && reqField !== 'source' && target.type !== 'file') {
        (this.state.req.form as unknown as Record<string, string>)[reqField] = target.value;
        return;
      }
      const recField = target.dataset.rec;
      if ((recField === 'name' || recField === 'startPath') && target.type !== 'checkbox') {
        this.state.recs.form[recField] = target.value;
        return;
      }
      if (recField === 'checkpoint' && this.state.recs.live) {
        this.state.recs.live.checkpointLabel = target.value;
        return;
      }
      if (target.dataset.lib) {
        this.libraryField(target.dataset.lib, target.value);
        return;
      }
      if (target.dataset.pub && this.publisher.input(target as HTMLInputElement)) return;
      if ((target.dataset.ed || target.dataset.edAdd) && this.editor.input(target as HTMLInputElement))
        return;
      const review = this.state.review;
      const reviewField = target.dataset.review;
      if (review && reviewField) {
        if (reviewField === 'newGroup') review.newGroup = target.value;
        else if (reviewField === 'rename' && review.renaming) review.renaming.name = target.value;
        else if (reviewField === 'modify' && review.editing) review.editing.description = target.value;
        return;
      }
      if (
        review &&
        target.dataset.rowColumn &&
        (target.dataset.rowField === 'value' || target.dataset.rowField === 'key')
      ) {
        this.rowChoice(target.dataset.rowColumn)[target.dataset.rowField] = target.value;
        return;
      }
      if (review?.intentEdit && target.dataset.intentField === 'reason') {
        review.intentEdit.reason = target.value;
        return;
      }
      if (review && target.dataset.bindStep && target.type !== 'radio') {
        this.bindForm(target.dataset.bindStep)[target.dataset.bindField as 'value' | 'variable'] =
          target.value;
        return;
      }
      if (target.dataset.memberField === 'name') {
        this.state.access.newMember.name = target.value;
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
    this.root.addEventListener('pointerdown', (event) => {
      this.editor.pointerDown(event as PointerEvent);
    });
    this.root.addEventListener('keydown', (event) => {
      if (this.editor.keydown(event as KeyboardEvent)) return;
      if (this.publisher.keydown(event as KeyboardEvent)) return;
      if ((event as KeyboardEvent).key === 'Escape' && this.state.lib.panel) {
        this.closePanel();
        return;
      }
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
    this.state.signIn = this.hasAttribute('sign-in');
    this.state.studioUrl = this.studioUrl();
    const days = Number(this.getAttribute('days'));
    if ((PERIODS as readonly number[]).includes(days)) this.state.days = days;
    void this.load();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.editor.dispose();
    this.unsubscribe();
    this.unfollowRecording();
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    if (this.correctionTimer) clearTimeout(this.correctionTimer);
    this.correctionTimer = undefined;
    this.stopTestsPolling();
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'sign-in') {
      this.state.signIn = next !== null;
      this.paint();
      return;
    }
    if (name === 'locale') {
      this.state.t = dashboardStrings(next);
      this.paint();
      return;
    }
    if (name === 'days') {
      const days = Number(next);
      if ((PERIODS as readonly number[]).includes(days)) this.state.days = days;
    }
    if (name === 'endpoint') {
      this.resetClient();
      this.state.studioUrl = this.studioUrl();
    }
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

  /** Le Flow Studio est servi par le même serveur que l'API (`…/api` → `…/studio`). */
  private studioUrl(): string {
    const endpoint = this.getAttribute('endpoint') ?? '/api';
    try {
      const url = new URL(
        endpoint,
        'location' in globalThis ? globalThis.location.href : 'http://localhost/',
      );
      url.pathname = url.pathname.replace(/\/api\/?$/, '') + '/studio';
      return endpoint.startsWith('/') ? url.pathname : url.toString().replace(/[?#].*$/, '');
    } catch {
      return '/studio';
    }
  }

  private resetClient(): void {
    this.unsubscribe();
    this.unfollowRecording();
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  private unsubscribe(): void {
    this.subscription?.close();
    this.subscription = undefined;
  }

  private unfollowRecording(): void {
    this.recSubscription?.close();
    this.recSubscription = undefined;
  }

  /**
   * Suivre une session d'enregistrement : ses gestes (la timeline), les moments qui comptent, les
   * phases du traitement, sa fin (puis la liste est relue). Le statut suit aussi la ligne de la liste.
   */
  private followRecording(api: QaCrawlerClient, projectId: string, name: string, status: string): void {
    this.unfollowRecording();
    const live: LiveRecording = newLiveRecording(name, status);
    this.state.recs.live = live;
    const notes = this.state.t.rec.notes;
    this.recSubscription = api.recordings.subscribe(projectId, name, (event) => {
      if (this.state.recs.live !== live) return;
      if (event.type === 'status') {
        live.status = event.status;
        const row = this.state.recordings?.find((recording) => recording.name === name);
        if (row) row.status = event.status;
      } else if (event.type === 'timeline') {
        const { seq: _seq, at: _at, type: _type, ...view } = event;
        live.timeline = view;
      } else if (event.type === 'recorder') {
        live.technical.push({ at: event.at, text: event.message });
        if (live.technical.length > 200) live.technical.splice(0, live.technical.length - 200);
        const note = notes[event.event];
        if (note) live.notes.push({ at: event.at, text: note });
      } else if (event.type === 'phase') {
        const last = live.phases.at(-1);
        const phase = {
          label: event.phase,
          ...(event.step !== undefined ? { step: event.step } : {}),
          ...(event.total !== undefined ? { total: event.total } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
        };
        if (last?.label === event.phase) live.phases[live.phases.length - 1] = phase;
        else live.phases.push(phase);
      } else if (event.type === 'failed') live.technical.push({ at: event.at, text: event.error });
      if (event.type === 'completed' || event.type === 'failed') {
        live.status = event.type === 'completed' ? 'COMPLETED' : 'FAILED';
        this.unfollowRecording();
        this.state.recs.live = undefined;
        if (event.type === 'failed') this.state.recs.error = event.error;
        void this.load();
        return;
      }
      if (this.state.route.view === 'recordings') this.paint();
    });
  }

  /** Une commande de la barre d'enregistrement : le serveur la transmet au recorder, la timeline suit. */
  private async recordingControl(
    control: string,
    target?: { stepId?: string; candidate?: number },
  ): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const live = this.state.recs.live;
    if (!api || !project || !live || live.control) return;
    live.control = control;
    live.error = undefined;
    this.paint();
    try {
      const name = live.name;
      if (control === 'pause') await api.recordings.pause(project.id, name);
      else if (control === 'resume') await api.recordings.resume(project.id, name);
      else if (control === 'undo') await api.recordings.undo(project.id, name);
      else if (control === 'checkpoint') {
        await api.recordings.checkpoint(project.id, name, live.checkpointLabel.trim() || undefined);
        live.checkpointLabel = '';
      } else if (control === 'resolve' && target?.stepId && target.candidate !== undefined)
        await api.recordings.resolve(project.id, name, target.stepId, target.candidate);
      else if (control === 'ignore' && target?.stepId)
        await api.recordings.ignore(project.id, name, target.stepId);
    } catch (error) {
      live.error = message(error);
    }
    live.control = undefined;
    if (this.state.recs.live === live) this.paint();
  }

  /** La revue : le flow (vue du Studio), les assertions, les données, les propositions, le rejeu. */
  private async loadReview(
    api: QaCrawlerClient,
    projectId: string,
    name: string,
    generation = this.generation,
  ): Promise<void> {
    const [studio, assertions, data, groupProposals, checks, replay, intents, correction] = await Promise.all(
      [
        api.recordings.studio(projectId, name),
        api.assertions.list(projectId, name),
        api.data.get(projectId, name).catch(() => undefined),
        api.groups.proposals(projectId, name).catch(() => []),
        api.groups.checks(projectId, name).catch(() => []),
        api.recordings.replayStatus(projectId, name).catch(() => undefined),
        api.recordings.intents(projectId, name).catch(() => undefined),
        api.corrections.get(projectId, name).catch(() => undefined),
      ],
    );
    const review = this.state.review;
    if (generation !== this.generation || review?.name !== name) return;
    review.studio = studio;
    review.assertions = assertions;
    review.data = data;
    review.groupProposals = groupProposals;
    review.checks = checks;
    review.replay = replay;
    review.intents = intents;
    review.correction = correction;
    if (correctionWaiting(correction)) this.pollCorrection(api, projectId, name);
    // Les choix de source enregistrés : le brouillon de la page est vidé.
    review.binds = {};
    review.selected = review.selected.filter((id) => studio.steps.some((step) => step.id === id));
    if (replay?.status === 'RUNNING') this.pollReplay(api, projectId, name);
  }

  /** Le rejeu suit sa progression (une requête par seconde), puis la revue est relue. */
  private pollReplay(api: QaCrawlerClient, projectId: string, name: string): void {
    if (this.replayTimer) return;
    this.replayTimer = setTimeout(() => {
      this.replayTimer = undefined;
      const route = this.state.route;
      if (route.view !== 'recording' || route.name !== name) return;
      void api.recordings
        .replayStatus(projectId, name)
        .then(async (replay) => {
          const review = this.state.review;
          if (review?.name !== name) return;
          review.replay = replay;
          if (replay.status === 'RUNNING') this.pollReplay(api, projectId, name);
          else await this.loadReview(api, projectId, name);
          this.paint();
        })
        .catch(() => undefined);
    }, 1000);
  }

  /** La correction suit sa session (une requête par seconde) tant que le serveur travaille. */
  private pollCorrection(api: QaCrawlerClient, projectId: string, name: string): void {
    if (this.correctionTimer) return;
    this.correctionTimer = setTimeout(() => {
      this.correctionTimer = undefined;
      const route = this.state.route;
      if (route.view !== 'recording' || route.name !== name) return;
      void api.corrections
        .get(projectId, name)
        .catch(() => undefined)
        .then((view) => {
          const review = this.state.review;
          if (review?.name !== name) return;
          review.correction = view;
          if (correctionWaiting(view)) this.pollCorrection(api, projectId, name);
          this.paint();
        });
    }, 1000);
  }

  private rowChoice(column: string): RowChoice {
    const edit = this.state.review?.rowEdit;
    const cell = edit?.source?.cells.find((entry) => entry.column === column);
    const fallback: RowChoice = {
      on: false,
      source: 'recorded',
      value: cell?.value ?? '',
      key: '',
      contains: false,
    };
    if (!edit) return fallback;
    edit.columns[column] ??= fallback;
    return edit.columns[column];
  }

  private bindForm(stepId: string): BindForm {
    const review = this.state.review;
    const input = review?.data?.inputs.find((entry) => entry.stepId === stepId);
    if (!review || !input) return { source: 'FIXED', variable: '', generator: '', reference: '', value: '' };
    review.binds[stepId] ??= bindFormOf(review, input, review.data?.generators ?? []);
    return review.binds[stepId];
  }

  /**
   * Une opération de la revue : envoyée au serveur (qui réécrit le flow), puis la revue est relue.
   * Les boutons sont désactivés pendant l'envoi ; une erreur s'affiche au-dessus de l'onglet.
   */
  private async reviewOp(
    label: string,
    run: (api: QaCrawlerClient, projectId: string, name: string, review: ReviewUi) => Promise<void>,
  ): Promise<void> {
    const api = this.api;
    const route = this.state.route;
    const review = this.state.review;
    if (!api || route.view !== 'recording' || !review || review.busy) return;
    review.busy = label;
    review.error = undefined;
    review.warnings = undefined;
    this.paint();
    try {
      await run(api, route.projectId, route.name, review);
      await this.loadReview(api, route.projectId, route.name);
    } catch (error) {
      review.error = message(error);
    }
    review.busy = undefined;
    if (this.state.review === review) this.paint();
  }

  private groupEdit(label: string, command: Parameters<QaCrawlerClient['groups']['edit']>[2]): void {
    void this.reviewOp(label, async (api, projectId, name, review) => {
      const result = await api.groups.edit(projectId, name, command);
      if (result.warnings.length > 0) review.warnings = result.warnings;
    });
  }

  private reviewClick(action: string, target: HTMLElement): boolean {
    const review = this.state.review;
    const route = this.state.route;
    if (!review || route.view !== 'recording') return false;
    const step = target.dataset.step ?? '';
    const group = target.dataset.group ?? '';
    const direction = target.dataset.direction === 'down' ? 'down' : 'up';
    switch (action) {
      case 'review-tab': {
        const tab = target.dataset.tab as ReviewTab | undefined;
        if (tab && (REVIEW_TABS as readonly string[]).includes(tab)) {
          this.state.route = { ...route, tab };
          this.paint();
          this.root.querySelector<HTMLElement>(`[data-action="review-tab"][data-tab="${tab}"]`)?.focus();
        }
        return true;
      }
      case 'review-replay':
        void this.reviewOp('replay', async (api, projectId, name, ui) => {
          ui.replay = await api.recordings.replay(projectId, name);
          this.pollReplay(api, projectId, name);
        });
        return true;
      case 'review-move':
        this.groupEdit('move', { op: 'move-step', stepId: step, direction });
        return true;
      case 'review-detach':
        this.groupEdit('detach', { op: 'detach', stepIds: [step] });
        return true;
      case 'review-detach-selected':
        this.groupEdit('detach', { op: 'detach', stepIds: [...review.selected] });
        review.selected = [];
        return true;
      case 'review-clear':
        review.selected = [];
        this.paint();
        return true;
      case 'review-remove':
        review.confirmRemove = step;
        this.paint();
        return true;
      case 'review-remove-no':
        review.confirmRemove = undefined;
        this.paint();
        return true;
      case 'review-remove-yes':
        review.confirmRemove = undefined;
        void this.reviewOp('remove', async (api, projectId, name) => {
          await api.recordings.removeStep(projectId, name, step);
        });
        return true;
      case 'review-rename-open': {
        const current = review.studio?.groups.find((entry) => entry.id === group);
        if (current) review.renaming = { id: group, name: current.name };
        this.paint();
        this.root.querySelector<HTMLInputElement>('[data-review="rename"]')?.focus();
        return true;
      }
      case 'review-rename-cancel':
        review.renaming = undefined;
        this.paint();
        return true;
      case 'review-move-group':
        this.groupEdit('move', { op: 'move-group', groupId: group, direction });
        return true;
      case 'review-delete-group':
        this.groupEdit('delete', { op: 'delete', groupId: group, keepSteps: true });
        return true;
      case 'review-accept-groups':
        void this.reviewOp('groups', async (api, projectId, name, ui) => {
          const result = await api.groups.acceptProposals(projectId, name);
          if (result.warnings.length > 0) ui.warnings = result.warnings;
        });
        return true;
      case 'review-add-check':
        void this.reviewOp('check', async (api, projectId, name) => {
          await api.groups.addCheck(projectId, name, { groupId: group, key: target.dataset.key ?? '' });
        });
        return true;
      case 'review-decide': {
        const decision = target.dataset.decision as 'ACCEPT' | 'REJECT' | 'DISABLE' | 'RESET';
        const id = target.dataset.assertion ?? '';
        void this.reviewOp('decide', async (api, projectId, name) => {
          await api.assertions.decide(projectId, name, id, { decision });
        });
        return true;
      }
      case 'review-decide-all': {
        const decision = target.dataset.decision === 'REJECT' ? 'REJECT' : 'ACCEPT';
        const buckets = assertionBuckets(review.assertions ?? []);
        const ids = (target.dataset.bucket === 'weak' ? buckets.weak : buckets.recommended).map(
          (proposal) => proposal.id,
        );
        void this.reviewOp('decide', async (api, projectId, name) => {
          for (const id of ids) await api.assertions.decide(projectId, name, id, { decision });
        });
        return true;
      }
      case 'review-correct':
        void this.reviewOp('correct', async (api, projectId, name, ui) => {
          ui.correctionChoice = {};
          ui.correction = await api.corrections.start(projectId, name, step);
          this.pollCorrection(api, projectId, name);
        });
        return true;
      case 'review-correction-pick':
        void this.reviewOp('correct', async (api, projectId, name, ui) => {
          ui.correctionChoice = {};
          ui.correction = await api.corrections.pick(projectId, name);
          this.pollCorrection(api, projectId, name);
        });
        return true;
      case 'review-correction-apply': {
        const choice = review.correctionChoice;
        const options = review.correction?.proposal?.rowOptions;
        const option = choice.option ?? options?.[0]?.id;
        const cells = review.correction?.proposal?.rowCells ?? [];
        const keys = review.correction?.proposal?.variables ?? [];
        const binding =
          option === 'manual'
            ? { column: choice.column ?? cells[0]?.column ?? '', key: choice.key ?? keys[0] ?? '' }
            : undefined;
        void this.reviewOp('correct', async (api, projectId, name, ui) => {
          ui.correction = await api.corrections.apply(projectId, name, {
            ...(option ? { option } : {}),
            ...(binding ? { binding } : {}),
          });
        });
        return true;
      }
      case 'review-correction-resume':
        void this.reviewOp('correct', async (api, projectId, name, ui) => {
          ui.correction = await api.corrections.resume(projectId, name);
          this.pollCorrection(api, projectId, name);
        });
        return true;
      case 'review-correction-close':
        void this.reviewOp('correct', async (api, projectId, name, ui) => {
          await api.corrections.close(projectId, name);
          ui.correction = undefined;
        });
        return true;
      case 'review-restore':
        void this.reviewOp('restore', async (api, projectId, name) => {
          await api.recordings.restoreTarget(projectId, name, step);
        });
        return true;
      case 'review-row-open': {
        const api = this.api;
        review.rowEdit = { stepId: step, columns: {} };
        this.paint();
        if (api)
          void api.recordings
            .rowSource(route.projectId, route.name, step)
            .then((source) => {
              if (review.rowEdit?.stepId !== step) return;
              review.rowEdit.source = source;
              this.paint();
            })
            .catch((error: unknown) => {
              review.rowEdit = undefined;
              review.error = message(error);
              this.paint();
            });
        return true;
      }
      case 'review-row-cancel':
        review.rowEdit = undefined;
        this.paint();
        return true;
      case 'review-intent': {
        const actionId = target.dataset.intentAction ?? '';
        const type = target.dataset.type === 'RESET' ? 'RESET' : 'CONFIRM';
        void this.reviewOp('intent', async (api, projectId, name, ui) => {
          ui.intents = await api.recordings.reviewIntent(projectId, name, { actionId, type });
        });
        return true;
      }
      case 'review-intent-open': {
        const actionId = target.dataset.intentAction ?? '';
        const row = review.intents?.rows.find((entry) => entry.actionId === actionId);
        const choices = review.intents?.choices ?? [];
        review.intentEdit = {
          actionId,
          intent: choices.includes(row?.intent ?? '') ? (row?.intent ?? '') : (choices[0] ?? ''),
          reason: '',
        };
        this.paint();
        return true;
      }
      case 'review-intent-cancel':
        review.intentEdit = undefined;
        this.paint();
        return true;
      case 'review-modify-open': {
        const proposal = review.assertions?.find((entry) => entry.id === target.dataset.assertion);
        if (proposal) review.editing = { id: proposal.id, description: proposal.description };
        this.paint();
        this.root.querySelector<HTMLTextAreaElement>('[data-review="modify"]')?.focus();
        return true;
      }
      case 'review-modify-cancel':
        review.editing = undefined;
        this.paint();
        return true;
      default:
        return false;
    }
  }

  private reviewSubmit(form: HTMLFormElement): void {
    const review = this.state.review;
    if (!review) return;
    switch (form.dataset.action) {
      case 'review-rename': {
        const renaming = review.renaming;
        if (!renaming?.name.trim()) return;
        review.renaming = undefined;
        this.groupEdit('rename', { op: 'rename', groupId: renaming.id, name: renaming.name.trim() });
        return;
      }
      case 'review-create-group': {
        const name = review.newGroup.trim();
        if (!name || review.selected.length === 0) return;
        const stepIds = [...review.selected];
        review.selected = [];
        review.newGroup = '';
        this.groupEdit('create', { op: 'create', name, stepIds });
        return;
      }
      case 'review-modify': {
        const editing = review.editing;
        if (!editing?.description.trim()) return;
        review.editing = undefined;
        void this.reviewOp('decide', async (api, projectId, name) => {
          await api.assertions.decide(projectId, name, editing.id, {
            decision: 'MODIFY',
            description: editing.description.trim(),
          });
        });
        return;
      }
      case 'review-bind': {
        const stepId = form.dataset.step ?? '';
        const choice = this.bindForm(stepId);
        void this.reviewOp('bind', async (api, projectId, name) => {
          await api.data.bind(projectId, name, {
            stepId,
            source: choice.source,
            ...(choice.source === 'FIXED' ? { value: choice.value } : {}),
            ...(choice.source === 'GENERATED'
              ? { variable: choice.variable.trim(), generator: choice.generator }
              : {}),
            ...(choice.source === 'REFERENCE' ? { variable: choice.reference } : {}),
          });
        });
        return;
      }
      case 'review-row-save': {
        const edit = review.rowEdit;
        if (!edit) return;
        const columns = rowColumnsOf(review);
        void this.reviewOp('row', async (api, projectId, name, ui) => {
          await api.recordings.editRow(projectId, name, edit.stepId, columns);
          ui.rowEdit = undefined;
        });
        return;
      }
      case 'review-intent-save': {
        const edit = review.intentEdit;
        if (!edit?.intent) return;
        void this.reviewOp('intent', async (api, projectId, name, ui) => {
          ui.intents = await api.recordings.reviewIntent(projectId, name, {
            actionId: edit.actionId,
            type: 'CORRECT',
            intent: edit.intent,
            ...(edit.reason.trim() ? { reason: edit.reason.trim() } : {}),
          });
          ui.intentEdit = undefined;
        });
        return;
      }
      case 'review-generate': {
        const formats = [...review.formats];
        const groupIds = [...review.genGroups];
        void this.reviewOp('generate', async (api, projectId, name, ui) => {
          ui.generation = await api.generation.run(projectId, name, {
            formats: formats as Parameters<QaCrawlerClient['generation']['run']>[2]['formats'],
            ...(groupIds.length > 0 ? { groupIds } : {}),
          });
        });
        return;
      }
    }
  }

  /** Une opération de la bibliothèque : envoyée au serveur, puis l'écran est relu (message ou erreur détaillée). */
  private async libraryOp(
    run: (api: QaCrawlerClient, projectId: string, lib: LibraryUi) => Promise<string | undefined>,
  ): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const lib = this.state.lib;
    if (!api || !project || lib.busy) return;
    lib.busy = true;
    lib.error = undefined;
    lib.details = undefined;
    lib.notice = undefined;
    this.paint();
    try {
      lib.notice = await run(api, project.id, lib);
      await this.load();
    } catch (error) {
      lib.error = message(error);
      lib.details = detailsOf(error);
    }
    lib.busy = false;
    this.paint();
  }

  // ── Tests générés ────────────────────────────────────────────────────────────────────────────

  /**
   * L'enregistrement affiché (celui de la route, le précédent, sinon le premier terminé), sa vue :
   * fichiers générés, outils du serveur, exécutions. Une exécution en cours est suivie.
   */
  private async loadTests(
    api: QaCrawlerClient,
    projectId: string,
    wanted: string | undefined,
    generation: number,
  ): Promise<void> {
    const ui = this.state.tst;
    const names = finishedRecordings(this.state);
    const name =
      [wanted, ui.recording].find((entry) => entry !== undefined && names.includes(entry)) ?? names[0];
    if (name !== ui.recording) {
      ui.view = undefined;
      ui.file = undefined;
      ui.run = undefined;
      ui.error = undefined;
      ui.details = undefined;
      ui.notice = undefined;
      ui.confirmRestore = undefined;
      ui.overwrite = undefined;
    }
    ui.recording = name;
    if (!name) return;
    const view = await api.generation.view(projectId, name);
    if (generation !== this.generation) return;
    ui.view = view;
    if (activeRuns(view).length > 0) this.pollTests(api, projectId, name);
  }

  private stopTestsPolling(): void {
    if (this.testsTimer) clearTimeout(this.testsTimer);
    this.testsTimer = undefined;
  }

  /** Les exécutions en cours : la vue est relue chaque seconde et demie, jusqu'à leur fin. */
  private pollTests(api: QaCrawlerClient, projectId: string, name: string): void {
    if (this.testsTimer) return;
    this.testsTimer = setTimeout(() => {
      this.testsTimer = undefined;
      const route = this.state.route;
      if (route.view !== 'tests' || this.state.tst.recording !== name) return;
      void api.generation
        .view(projectId, name)
        .then((view) => {
          if (this.state.tst.recording !== name) return;
          this.state.tst.view = view;
          if (activeRuns(view).length > 0) this.pollTests(api, projectId, name);
          this.paint();
        })
        .catch(() => {
          // Une lecture manquée n'arrête pas le suivi : la suivante réessaie.
          this.pollTests(api, projectId, name);
        });
    }, 1500);
  }

  private testsField(field: string, target: HTMLInputElement | HTMLSelectElement): void {
    const ui = this.state.tst;
    const route = this.state.route;
    if (field === 'recording' && route.view === 'tests') {
      this.navigate({ view: 'tests', projectId: route.projectId, recording: target.value });
      return;
    }
    if (field === 'environment') {
      ui.environment = target.value;
      return;
    }
    if (field === 'format') {
      const format = target.value as GenerationFormatName;
      ui.formats = (target as HTMLInputElement).checked
        ? GENERATION_FORMATS.filter((entry) => entry === format || ui.formats.includes(entry))
        : ui.formats.filter((entry) => entry !== format);
      this.paint();
      this.root
        .querySelector<HTMLInputElement>(`[data-tst="format"][value="${CSS.escape(format)}"]`)
        ?.focus();
    }
  }

  /** Une opération de l'écran Tests : une à la fois, son erreur (et ses raisons) dite dans l'écran. */
  private async testsOp(
    busy: string,
    run: (api: QaCrawlerClient, projectId: string, name: string) => Promise<string | undefined>,
  ): Promise<void> {
    const api = this.api;
    const route = this.state.route;
    const ui = this.state.tst;
    const name = ui.recording;
    if (!api || route.view !== 'tests' || !name || ui.busy !== undefined) return;
    ui.busy = busy;
    ui.error = undefined;
    ui.details = undefined;
    ui.notice = undefined;
    this.paint();
    try {
      ui.notice = await run(api, route.projectId, name);
      const view = await api.generation.view(route.projectId, name);
      if (ui.recording === name) ui.view = view;
      if (activeRuns(view).length > 0) this.pollTests(api, route.projectId, name);
    } catch (error) {
      ui.error = message(error);
      ui.details = detailsOf(error);
    }
    ui.busy = undefined;
    this.paint();
  }

  /** Générer ; une régénération qui remplacerait des fichiers modifiés à la main attend une confirmation. */
  private async testsGenerate(overwriteManual = false): Promise<void> {
    const ui = this.state.tst;
    if (ui.formats.length === 0) return;
    await this.testsOp('generate', async (api, projectId, name) => {
      try {
        const result = await api.generation.run(projectId, name, {
          formats: [...ui.formats],
          ...(overwriteManual ? { overwriteManual: true } : {}),
        });
        ui.overwrite = undefined;
        return this.state.t.tst.generated(result.files.length);
      } catch (error) {
        if ((error as { code?: string }).code !== 'MANUAL_EDITS') throw error;
        ui.overwrite = detailsOf(error);
        return undefined;
      }
    });
  }

  private testsClick(action: string, target: HTMLElement): boolean {
    const ui = this.state.tst;
    const t = this.state.t.tst;
    switch (action) {
      case 'tst-run': {
        const format = target.dataset.format as GenerationFormatName | undefined;
        if (!format) return true;
        const engine = ui.view?.runners.find((runner) => runner.format === format)?.kind === 'ENGINE';
        void this.testsOp(format, async (api, projectId, name) => {
          const run = await api.generation.execute(projectId, name, {
            format,
            ...(engine && ui.environment ? { environmentId: ui.environment } : {}),
          });
          ui.run = run.id;
          return t.started$(t.formats[format] ?? format);
        });
        return true;
      }
      case 'tst-cancel': {
        const id = target.dataset.run ?? '';
        void this.testsOp('cancel', async (api, projectId, name) => {
          await api.generation.cancel(projectId, name, id);
          return t.cancelling;
        });
        return true;
      }
      case 'tst-open-editor':
      case 'tst-overwrite-compare': {
        const route = this.state.route;
        if (route.view !== 'tests' || !ui.recording) return true;
        const file =
          target.dataset.path ?? (action === 'tst-overwrite-compare' ? ui.overwrite?.[0] : ui.file);
        ui.overwrite = undefined;
        this.navigate({
          view: 'editor',
          projectId: route.projectId,
          recording: ui.recording,
          ...(file ? { file } : {}),
          ...(action === 'tst-overwrite-compare' ? { compare: true } : {}),
        });
        return true;
      }
      case 'tst-restore':
        ui.confirmRestore = target.dataset.path;
        this.paint();
        this.root.querySelector<HTMLElement>('[data-action="tst-restore-confirm"]')?.focus();
        return true;
      case 'tst-restore-cancel':
        ui.confirmRestore = undefined;
        this.paint();
        return true;
      case 'tst-restore-confirm': {
        const file = ui.view?.files.find((entry) => entry.path === target.dataset.path);
        if (!file?.revision) return true;
        const revision = file.revision;
        ui.confirmRestore = undefined;
        void this.testsOp('restore', async (api, projectId, name) => {
          await api.generation.restoreFile(projectId, name, { path: file.path, revision });
          return t.restored(file.path);
        });
        return true;
      }
      case 'tst-overwrite':
        void this.testsGenerate(true);
        return true;
      case 'tst-overwrite-cancel':
        ui.overwrite = undefined;
        this.paint();
        return true;
      case 'tst-file': {
        const file = target.dataset.path;
        ui.file = ui.file === file ? undefined : file;
        this.paint();
        this.root
          .querySelector<HTMLElement>(`[data-action="tst-file"][data-path="${CSS.escape(file ?? '')}"]`)
          ?.focus();
        return true;
      }
      case 'tst-open-run': {
        const id = target.dataset.run;
        ui.run = ui.run === id ? undefined : id;
        this.paint();
        this.root
          .querySelector<HTMLElement>(`[data-action="tst-open-run"][data-run="${CSS.escape(id ?? '')}"]`)
          ?.focus();
        return true;
      }
      case 'tst-report': {
        const api = this.api;
        const route = this.state.route;
        const id = target.dataset.run;
        if (!api || route.view !== 'tests' || !ui.recording || !id) return true;
        api.generation
          .reportLink(route.projectId, ui.recording, id)
          .then((link) => {
            globalThis.open(link.url, '_blank', 'noopener');
          })
          .catch((error: unknown) => {
            ui.error = message(error);
            this.paint();
          });
        return true;
      }
      default:
        return false;
    }
  }

  private checkSequence = 0;

  /** VÉRIFIER LE PARCOURS (dry run de composition, sur le serveur) : ordre, dépendances, données. */
  private async checkJourney(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const lib = this.state.lib;
    if (!api || !project) return;
    if (lib.compose.parts.length === 0) {
      lib.check = undefined;
      lib.checkedFor = undefined;
      this.paint();
      return;
    }
    const sequence = ++this.checkSequence;
    const key = compositionKey(lib.compose);
    const input = { name: lib.compose.name, parts: [...lib.compose.parts] };
    lib.checking = true;
    this.paint();
    try {
      const check = await api.scenarios.checkComposition(project.id, input);
      if (sequence !== this.checkSequence) return;
      lib.check = check;
      lib.checkedFor = key;
    } catch (error) {
      if (sequence !== this.checkSequence) return;
      lib.error = message(error);
      lib.details = detailsOf(error);
    }
    lib.checking = false;
    this.paint();
  }

  private openPanel(scenario?: string): void {
    const sources = runnableScenarios(this.state.project?.scenarios ?? []).filter(
      (entry) => entry.format === 'yaml',
    );
    const chosen =
      scenario && sources.some((entry) => entry.name === scenario) ? scenario : (sources[0]?.name ?? '');
    this.state.lib.panel = { scenario: chosen, name: '', description: '' };
    this.paint();
    this.root.querySelector<HTMLElement>('[data-lib="panel.scenario"]')?.focus();
    void this.loadPreview();
  }

  private closePanel(): void {
    this.state.lib.panel = undefined;
    this.paint();
    this.root.querySelector<HTMLElement>('.hd [data-action="lib-panel-open"]')?.focus();
  }

  /** L'aperçu du scénario source (étapes, données sans valeur, contrat dérivé), avant d'en faire un bloc. */
  private async loadPreview(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const panel = this.state.lib.panel;
    if (!api || !project || !panel?.scenario) return;
    const scenario = panel.scenario;
    panel.loading = true;
    this.paint();
    try {
      const preview = await api.library.preview(project.id, scenario);
      if (this.state.lib.panel?.scenario !== scenario) return;
      panel.preview = preview;
      panel.previewFor = scenario;
    } catch (error) {
      panel.error = message(error);
    }
    panel.loading = false;
    this.paint();
  }

  private libraryClick(action: string, target: HTMLElement): boolean {
    const lib = this.state.lib;
    const route = this.state.route;
    const index = Number(target.dataset.index);
    const block = target.dataset.block ?? '';
    switch (action) {
      case 'lib-panel-open':
        this.openPanel();
        return true;
      case 'lib-panel-close':
        this.closePanel();
        return true;
      case 'lib-open':
        lib.open = lib.open === block ? undefined : block;
        this.paint();
        return true;
      case 'lib-clear':
        Object.assign(lib, { query: '', origin: 'ALL', state: 'ALL', usage: 'ALL' });
        this.paint();
        return true;
      case 'lib-jump':
        this.root.querySelector('#lib-composer')?.scrollIntoView({ block: 'start' });
        this.root.querySelector<HTMLElement>('[data-lib="compose.name"]')?.focus();
        return true;
      case 'lib-open-scenario': {
        const name = target.dataset.name ?? '';
        if ('projectId' in route && route.projectId)
          this.navigate({ view: 'scenarios', projectId: route.projectId, scenario: name });
        return true;
      }
      case 'lib-remove':
        lib.confirmRemove = block;
        this.paint();
        return true;
      case 'lib-remove-no':
        lib.confirmRemove = undefined;
        this.paint();
        return true;
      case 'lib-remove-yes':
        lib.confirmRemove = undefined;
        void this.libraryOp(async (api, projectId) => {
          await api.library.remove(projectId, block);
          return undefined;
        });
        return true;
      case 'lib-part-add':
        if (block) lib.compose.parts = [...lib.compose.parts, block];
        void this.checkJourney();
        return true;
      case 'lib-part-remove':
        // Retirer du parcours en cours, jamais de la bibliothèque.
        lib.compose.parts = lib.compose.parts.filter((_, at) => at !== index);
        void this.checkJourney();
        return true;
      case 'lib-part-move': {
        const to = target.dataset.direction === 'down' ? index + 1 : index - 1;
        const parts = [...lib.compose.parts];
        const [moved] = parts.splice(index, 1);
        if (moved !== undefined && to >= 0 && to <= parts.length) {
          parts.splice(to, 0, moved);
          lib.compose.parts = parts;
        }
        void this.checkJourney();
        return true;
      }
      case 'lib-check':
        void this.checkJourney();
        return true;
      case 'lib-contract-edit': {
        const view = lib.blocks?.find((entry) => entry.name === block);
        if (view) {
          const contract = view.contract;
          lib.contract = {
            block,
            required: contract.inputs
              .filter((input) => input.required)
              .map((input) => input.key)
              .join(', '),
            optional: contract.inputs
              .filter((input) => !input.required)
              .map((input) => input.key)
              .join(', '),
            outputs: contract.outputs.map((output) => output.key).join(', '),
            pre: contract.preconditions.join('\n'),
            post: contract.postconditions.join('\n'),
          };
        }
        this.paint();
        this.root.querySelector<HTMLElement>('[data-lib="contract.required"]')?.focus();
        return true;
      }
      case 'lib-contract-cancel':
        lib.contract = undefined;
        this.paint();
        return true;
      case 'lib-contract-reset':
        void this.libraryOp(async (api, projectId, ui) => {
          await api.library.declareContract(projectId, block, null);
          ui.contract = undefined;
          return this.state.t.lib.contractSaved(block);
        });
        return true;
      case 'lib-validate-version':
        void this.libraryOp(async (api, projectId) => {
          const view = await api.library.validateVersion(projectId, block);
          return this.state.t.lib.versionValidated(view.name, view.version);
        });
        return true;
      case 'lib-accept': {
        const name = target.dataset.name ?? '';
        void this.libraryOp(async (api, projectId) => {
          await api.scenarios.acceptBlocks(projectId, name);
          return this.state.t.lib.accepted(name);
        });
        return true;
      }
      case 'lib-from-scenario': {
        const name = target.dataset.name ?? '';
        if ('projectId' in route && route.projectId) {
          this.navigate({ view: 'library', projectId: route.projectId });
          // Le panneau s'ouvre une fois l'écran chargé, sur ce scénario.
          this.pendingPanel = name;
        }
        return true;
      }
      case 'lib-group': {
        const group = this.state.review?.studio?.groups.find((entry) => entry.id === target.dataset.group);
        if (group) lib.group = { id: group.id, name: group.name };
        this.paint();
        this.root.querySelector<HTMLInputElement>('[data-lib="group.name"]')?.focus();
        return true;
      }
      case 'lib-group-cancel':
        lib.group = undefined;
        this.paint();
        return true;
      default:
        return false;
    }
  }

  private pendingPanel: string | undefined;

  private librarySubmit(form: HTMLFormElement): void {
    const lib = this.state.lib;
    const keyList = (text: string): string[] =>
      text
        .split(/[,\s]+/)
        .map((key) => key.trim())
        .filter(Boolean);
    const lines = (text: string): string[] =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    switch (form.dataset.action) {
      case 'lib-add': {
        const panel = lib.panel;
        const api = this.api;
        const project = this.state.project;
        if (!panel || panel.busy || !api || !project) return;
        // Une seule soumission à la fois ; en cas d'erreur, la saisie reste.
        panel.busy = true;
        panel.error = undefined;
        this.paint();
        void (async () => {
          try {
            const block = await api.library.add(project.id, {
              from: 'scenario',
              scenario: panel.scenario,
              name: panel.name,
              ...(panel.description.trim() ? { description: panel.description.trim() } : {}),
            });
            lib.panel = undefined;
            lib.notice = this.state.t.lib.added(block.name);
            await this.load();
          } catch (error) {
            panel.error = [message(error), ...detailsOf(error).slice(1)].join(' · ');
            panel.busy = false;
          }
          this.paint();
        })();
        return;
      }
      case 'lib-compose': {
        const api = this.api;
        const project = this.state.project;
        if (!api || !project || lib.creating || lib.busy) return;
        const input = { name: lib.compose.name, parts: [...lib.compose.parts] };
        lib.creating = true;
        lib.error = undefined;
        lib.details = undefined;
        lib.notice = undefined;
        this.paint();
        void (async () => {
          try {
            const scenario = await api.scenarios.compose(project.id, input);
            lib.compose = { name: '', parts: [] };
            lib.check = undefined;
            lib.checkedFor = undefined;
            lib.notice = this.state.t.lib.composed(scenario.name);
            await this.load();
          } catch (error) {
            // La composition reste telle quelle ; la vérification dit pourquoi.
            lib.error = message(error);
            lib.details = detailsOf(error);
          }
          lib.creating = false;
          this.paint();
          if (lib.error) void this.checkJourney();
        })();
        return;
      }
      case 'lib-insert': {
        const scenario = form.dataset.scenario ?? '';
        const revision = form.dataset.revision;
        const block = lib.insert.block || lib.blocks?.find((entry) => entry.name !== scenario)?.name || '';
        const at = lib.insert.at;
        void this.libraryOp(async (api, projectId) => {
          await api.scenarios.insert(projectId, scenario, { block, at, ...(revision ? { revision } : {}) });
          return this.state.t.lib.inserted(block);
        });
        return;
      }
      case 'lib-contract': {
        const draft = lib.contract;
        const name = form.dataset.block ?? '';
        if (!draft) return;
        const contract = {
          inputs: [
            ...keyList(draft.required).map((key) => ({ key, required: true })),
            ...keyList(draft.optional).map((key) => ({ key, required: false })),
          ],
          outputs: keyList(draft.outputs),
          preconditions: lines(draft.pre),
          postconditions: lines(draft.post),
        };
        void this.libraryOp(async (api, projectId, ui) => {
          await api.library.declareContract(projectId, name, contract);
          ui.contract = undefined;
          return this.state.t.lib.contractSaved(name);
        });
        return;
      }
      case 'lib-group': {
        const group = lib.group;
        const route = this.state.route;
        if (!group || route.view !== 'recording') return;
        void this.libraryOp(async (api, projectId, ui) => {
          const block = await api.library.add(projectId, {
            from: 'recording',
            recording: route.name,
            groupId: group.id,
            name: group.name,
          });
          ui.group = undefined;
          return this.state.t.lib.added(block.name);
        });
        return;
      }
    }
  }

  private async startRecording(): Promise<void> {
    const api = this.api;
    const project = this.state.project;
    const ui = this.state.recs;
    if (!api || !project || ui.busy) return;
    const name = ui.form.name.trim();
    if (!name) {
      ui.error = this.state.t.rec.noName;
      this.paint();
      return;
    }
    ui.busy = true;
    ui.error = undefined;
    this.paint();
    try {
      const snapshot = await api.recordings.start(project.id, {
        name,
        ...(ui.form.startPath.trim() ? { startPath: ui.form.startPath.trim() } : {}),
        validate: ui.form.validate,
      });
      ui.busy = false;
      ui.form = { ...ui.form, name: '', startPath: '' };
      this.followRecording(api, project.id, snapshot.name, snapshot.status);
      await this.load();
    } catch (error) {
      ui.busy = false;
      ui.error = message(error);
      this.paint();
    }
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private navigate(route: DashboardRoute): void {
    // L'éditeur garde les modifications non enregistrées : la page le demande avant de partir.
    if (!this.editor.guard(route)) return;
    if (route.view !== 'execution') this.unsubscribe();
    if (route.view !== 'recordings') {
      this.unfollowRecording();
      this.state.recs.live = undefined;
    }
    if (route.view !== 'tests') this.stopTestsPolling();
    if (route.view !== 'recording') {
      if (this.replayTimer) clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
      if (this.correctionTimer) clearTimeout(this.correctionTimer);
      this.correctionTimer = undefined;
    }
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
      const scope = 'projectId' in route && route.projectId ? route.projectId : this.state.projectId;
      this.state.me = await api.access.me(scope ? { projectId: scope } : {}).catch(() => undefined);
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
        const [history, recordings, blocks] = await Promise.all([
          api.scenarios.history(route.projectId),
          api.recordings.list(route.projectId).catch(() => []),
          api.library.list(route.projectId).catch(() => []),
        ]);
        if (generation !== this.generation) return;
        this.state.scenarioHistory = history;
        this.state.recordings = recordings;
        this.state.lib.blocks = blocks;
      } else if (route.view === 'library') {
        await this.loadProject(api, route.projectId, generation);
        const blocks = await api.library.list(route.projectId);
        if (generation !== this.generation) return;
        this.state.lib.blocks = blocks;
        const panel = this.state.lib.panel;
        const scenarios = runnableScenarios(this.state.project?.scenarios ?? []).filter(
          (scenario) => scenario.format === 'yaml',
        );
        if (panel && !scenarios.some((scenario) => scenario.name === panel.scenario))
          panel.scenario = scenarios[0]?.name ?? '';
        // « Ajouter à la bibliothèque » depuis l'écran Scénarios : le panneau s'ouvre sur ce scénario.
        if (this.pendingPanel !== undefined) {
          const scenario = this.pendingPanel;
          this.pendingPanel = undefined;
          this.openPanel(scenario);
        }
      } else if (route.view === 'tests') {
        await this.loadProject(api, route.projectId, generation);
        const recordings = await api.recordings.list(route.projectId);
        if (generation !== this.generation) return;
        this.state.recordings = recordings;
        await this.loadTests(api, route.projectId, route.recording, generation);
      } else if (route.view === 'editor') {
        await this.loadProject(api, route.projectId, generation);
        await this.editor.load(api, route, () => generation === this.generation);
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
      } else if (route.view === 'recordings') {
        await this.loadProject(api, route.projectId, generation);
        const recordings = await api.recordings.list(route.projectId);
        if (generation !== this.generation) return;
        this.state.recordings = recordings;
        const running = recordings.find(
          (entry) => entry.status === 'RECORDING' || entry.status === 'PROCESSING',
        );
        if (running && this.state.recs.live?.name !== running.name)
          this.followRecording(api, route.projectId, running.name, running.status);
      } else if (route.view === 'recording') {
        await this.loadProject(api, route.projectId, generation);
        if (this.state.review?.name !== route.name) this.state.review = emptyReviewUi(route.name);
        await this.loadReview(api, route.projectId, route.name, generation);
      } else if (route.view === 'access') {
        if (this.state.me?.rights.includes('MANAGE_ACCESS')) {
          const kind = this.state.access.journalKind;
          const [members, journal] = await Promise.all([
            api.access.members(),
            // Le journal de tout l'espace : une action d'accès ne vise aucun projet.
            api.access.journal(kind !== 'ALL' ? { kind: kind as 'RUN' } : {}),
          ]);
          if (generation !== this.generation) return;
          this.state.access.members = members;
          this.state.access.journal = journal;
        }
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

  /** Connexion par jeton nominatif : gardé pour l'onglet seulement, jamais affiché. */
  private signInWith(value: string): void {
    const token = value.trim();
    if (!token) return;
    this.state.access.signInError = undefined;
    try {
      sessionStorage.setItem('qa-crawler-token', token);
    } catch {
      // Stockage refusé : la connexion vaut pour cette page seulement.
    }
    this.token = token;
  }

  private signOut(): void {
    try {
      sessionStorage.removeItem('qa-crawler-token');
    } catch {
      // Rien à retirer.
    }
    this.state.me = undefined;
    this.state.menuOpen = false;
    this.state.access = emptyAccessUi();
    this.token = undefined;
    this.state.phase = 'idle';
    this.paint();
  }

  private async createMember(): Promise<void> {
    const api = this.api;
    const ui = this.state.access;
    if (!api) return;
    ui.error = undefined;
    try {
      ui.created = await api.access.createMember({ name: ui.newMember.name.trim(), role: ui.newMember.role });
      ui.copyNote = undefined;
      ui.newMember = { name: '', role: ui.newMember.role };
      await this.load();
    } catch (error) {
      ui.error = message(error);
      this.paint();
    }
  }

  private copyToken(): void {
    const token = this.state.access.created?.token;
    if (!token) return;
    const note = (text: string): void => {
      this.state.access.copyNote = text;
      this.paint();
    };
    navigator.clipboard
      .writeText(token)
      .then(() => {
        note(this.state.t.access.copied);
      })
      .catch(() => {
        note(this.state.t.access.copyFailed);
      });
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
    if (code === 'UNAUTHORIZED' && this.state.signIn) {
      this.signOut();
      this.state.access.signInError = this.state.t.access.refused;
      this.paint();
      return;
    }
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
      const { kind, environmentId, scenarios, headed, slowMoMs } = this.state.launch;
      const visible = headed ? { headed: true, slowMoMs: slowMoMs ?? 0 } : {};
      const started =
        kind === 'EXPLORATION'
          ? await api.explorations.start(project.id, visible)
          : await api.executions.start(project.id, {
              ...(environmentId ? { environmentId } : {}),
              ...(scenarios.length > 0 ? { scenarios } : {}),
              ...visible,
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
      ...this.state.launch,
      kind: 'REPLAY',
      environmentId: environmentId ?? '',
      scenarios,
      busy: false,
      error: undefined,
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
    if (action?.startsWith('review-') && this.reviewClick(action, target)) return;
    if (action?.startsWith('lib-') && this.libraryClick(action, target)) return;
    if (action?.startsWith('pub-') && this.publisher.click(action, target)) return;
    if (action?.startsWith('tst-') && this.testsClick(action, target)) return;
    if (action?.startsWith('ed-') && this.editor.click(action, target)) return;
    switch (action) {
      case 'menu':
        this.state.menuOpen = !this.state.menuOpen;
        this.paint();
        return;
      case 'nav': {
        const view = target.dataset.view;
        const projectId = this.contextProject();
        if (view === 'projects') this.navigate({ view: 'projects' });
        else if (view === 'access') this.navigate({ view: 'access' });
        else if (view === 'trends')
          this.navigate({
            view: 'trends',
            ...(this.state.projectId ? { projectId: this.state.projectId } : {}),
          });
        else if (
          view === 'executions' ||
          view === 'history' ||
          view === 'scenarios' ||
          view === 'recordings' ||
          view === 'library' ||
          view === 'tests' ||
          view === 'editor' ||
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
      case 'start-recording':
        void this.startRecording();
        return;
      case 'open-review': {
        const project = this.state.project;
        const name = target.dataset.recording;
        if (project && name) this.navigate({ view: 'recording', projectId: project.id, name });
        return;
      }
      case 'rec-control':
        void this.recordingControl(target.dataset.control ?? '');
        return;
      case 'rec-resolve':
        void this.recordingControl('resolve', {
          stepId: target.dataset.step ?? '',
          candidate: Number(target.dataset.candidate),
        });
        return;
      case 'rec-ignore':
        void this.recordingControl('ignore', { stepId: target.dataset.step ?? '' });
        return;
      case 'stop-recording': {
        const project = this.state.project;
        const live = this.state.recs.live;
        if (!api || !project || !live) return;
        live.stopping = true;
        this.paint();
        api.recordings.stop(project.id, live.name).catch((error: unknown) => {
          live.stopping = false;
          this.state.recs.error = message(error);
          this.paint();
        });
        return;
      }
      case 'sign-out':
        this.signOut();
        return;
      case 'create-member':
        void this.createMember();
        return;
      case 'copy-token':
        this.copyToken();
        return;
      case 'hide-token':
        this.state.access.created = undefined;
        this.state.access.copyNote = undefined;
        this.paint();
        return;
      case 'journal-kind':
        this.state.access.journalKind = target.dataset.kind ?? 'ALL';
        void this.load();
        return;
      case 'revoke':
        if (target.dataset.member) {
          this.state.confirm = `revoke:${target.dataset.member}`;
          this.paint();
        }
        return;
      case 'revoke-confirm': {
        const member = target.dataset.member;
        if (!api || !member) return;
        void this.act(() => api.access.revoke(member));
        return;
      }
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
        else if (target.dataset.to === 'recordings' && route.view === 'recording')
          this.navigate({ view: 'recordings', projectId: route.projectId });
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

  /** Un champ de la bibliothèque (« add.name », « compose.pick », « insert.at »…), gardé sans redessiner. */
  private libraryField(field: string, value: string): void {
    const lib = this.state.lib;
    const [part, key] = field.split('.');
    if (part === 'query') lib.query = value;
    else if (part === 'origin' && ['ALL', 'scenario', 'recording', 'none'].includes(value))
      lib.origin = value as LibraryUi['origin'];
    else if (part === 'state' && ['ALL', 'VALID', 'CHANGED', 'INVALID'].includes(value))
      lib.state = value as LibraryUi['state'];
    else if (part === 'usage' && ['ALL', 'used', 'free'].includes(value))
      lib.usage = value as LibraryUi['usage'];
    else if (part === 'sort' && ['name', 'steps', 'usage', 'updated'].includes(value))
      lib.sort = value as LibraryUi['sort'];
    else if (part === 'compose' && key === 'name') {
      lib.compose.name = value;
      return;
    } else if (part === 'panel' && lib.panel && (key === 'name' || key === 'description'))
      lib.panel[key] = value;
    else if (part === 'panel' && lib.panel && key === 'scenario') {
      lib.panel.scenario = value;
      lib.panel.error = undefined;
      void this.loadPreview();
      return;
    } else if (part === 'contract' && lib.contract && key && key in lib.contract && key !== 'block')
      lib.contract[key as 'required' | 'optional' | 'outputs' | 'pre' | 'post'] = value;
    else if (part === 'insert' && key === 'block') lib.insert.block = value;
    else if (part === 'insert' && key === 'at') lib.insert.at = value === 'end' ? 'end' : 'start';
    else if (part === 'group' && key === 'name' && lib.group) lib.group.name = value;
    else return;
    // La recherche, les critères et le nom du bloc (sa validation) se voient tout de suite.
    if (['query', 'origin', 'state', 'usage', 'sort'].includes(part) || (part === 'panel' && key === 'name'))
      this.paint();
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.dataset.lib) {
      this.libraryField(target.dataset.lib, target.value);
      return;
    }
    if (target.dataset.pub && this.publisher.change(target)) return;
    if (target.dataset.tst) {
      this.testsField(target.dataset.tst, target);
      return;
    }
    if (this.state.route.view === 'editor' && this.editor.change(target)) return;
    const review = this.state.review;
    if (review && this.state.route.view === 'recording') {
      const pick = target.dataset.reviewPick;
      if (pick) {
        const checked = (target as HTMLInputElement).checked;
        review.selected = checked
          ? [...review.selected.filter((id) => id !== pick), pick]
          : review.selected.filter((id) => id !== pick);
        this.paint();
        // Redessinée, la page garde le focus sur la case (clavier).
        this.root.querySelector<HTMLInputElement>(`[data-review-pick="${CSS.escape(pick)}"]`)?.focus();
        return;
      }
      const format = target.dataset.reviewFormat;
      if (format) {
        const checked = (target as HTMLInputElement).checked;
        review.formats = checked
          ? [...review.formats.filter((entry) => entry !== format), format]
          : review.formats.filter((entry) => entry !== format);
        this.paint();
        this.root.querySelector<HTMLInputElement>(`[data-review-format="${CSS.escape(format)}"]`)?.focus();
        return;
      }
      const genGroup = target.dataset.reviewGenGroup;
      if (genGroup) {
        const checked = (target as HTMLInputElement).checked;
        review.genGroups = checked
          ? [...review.genGroups.filter((entry) => entry !== genGroup), genGroup]
          : review.genGroups.filter((entry) => entry !== genGroup);
        return;
      }
      if (target.dataset.action === 'review-assign' && target.value) {
        const stepIds = [...review.selected];
        review.selected = [];
        this.groupEdit('assign', { op: 'assign', groupId: target.value, stepIds });
        return;
      }
      const correctionOption = target.dataset.correctionOption;
      if (correctionOption) {
        review.correctionChoice.option = correctionOption;
        this.paint();
        return;
      }
      const correctionField = target.dataset.correctionField;
      if (correctionField === 'column' || correctionField === 'key') {
        review.correctionChoice[correctionField] = target.value;
        return;
      }
      const rowColumn = target.dataset.rowColumn;
      if (rowColumn) {
        const choice = this.rowChoice(rowColumn);
        const field = target.dataset.rowField;
        if (field === 'on' || field === 'contains') {
          choice[field] = (target as HTMLInputElement).checked;
          this.paint();
        } else if (field === 'source') {
          choice.source = target.value as RowChoice['source'];
          if (choice.source === 'variable') choice.key = review.rowEdit?.source?.variables[0]?.key ?? '';
          this.paint();
        } else if (field === 'key' || field === 'value') choice[field] = target.value;
        return;
      }
      if (review.intentEdit && target.dataset.intentField === 'intent') {
        review.intentEdit.intent = target.value;
        return;
      }
      const bindStep = target.dataset.bindStep;
      if (bindStep) {
        const field = target.dataset.bindField as keyof BindForm;
        const form = this.bindForm(bindStep);
        if (field === 'source') {
          form.source = target.value as BindForm['source'];
          this.paint();
        } else form[field] = target.value;
        return;
      }
    }
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
        route.view === 'recordings' ||
        route.view === 'library' ||
        route.view === 'tests' ||
        route.view === 'editor' ||
        route.view === 'explorations' ||
        route.view === 'environments' ||
        route.view === 'sources' ||
        route.view === 'requirements' ||
        route.view === 'traceability' ||
        route.view === 'indicators'
      )
        this.navigate({ view: route.view, projectId });
      else if (route.view === 'import') this.navigate({ view: 'sources', projectId });
      else if (route.view === 'recording') this.navigate({ view: 'recordings', projectId });
      else this.navigate({ view: 'project', projectId });
      return;
    }
    if (target.dataset.rec === 'validate') {
      this.state.recs.form.validate = (target as HTMLInputElement).checked;
      return;
    }
    if (target.dataset.memberField === 'role') {
      this.state.access.newMember.role = target.value as Role;
      return;
    }
    if (target.dataset.memberRole || target.dataset.memberProjectRole) {
      const api = this.api;
      const member = target.dataset.memberRole ?? target.dataset.memberProjectRole ?? '';
      const projectId = target.dataset.memberProjectRole ? this.state.projectId : undefined;
      if (!api) return;
      void this.act(() =>
        api.access.setRole(
          member,
          target.value ? (target.value as Role) : null,
          projectId ? { projectId } : {},
        ),
      );
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
    if (target.dataset.bind === 'headed' || target.dataset.bind === 'slow-mo') {
      if (target.dataset.bind === 'headed') this.state.launch.headed = (target as HTMLInputElement).checked;
      else this.state.launch.slowMoMs = Number(target.value) || 0;
      this.paint();
      this.root.querySelector<HTMLElement>(`[data-bind="${target.dataset.bind}"]`)?.focus();
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
      focused?.dataset.action ??
      focused?.dataset.bind ??
      focused?.dataset.field ??
      focused?.dataset.req ??
      focused?.dataset.lib ??
      focused?.dataset.edField ??
      focused?.dataset.edAdd ??
      focused?.dataset.ed;
    const focusValue = (focused as HTMLInputElement | null)?.value;
    // Le même bouton d'une liste (même bloc, même rang), et le curseur d'un champ texte, retrouvés.
    const focusTwin = `${focused?.dataset.block ?? ''}|${focused?.dataset.index ?? ''}|${focused?.dataset.direction ?? ''}`;
    const caret =
      focused instanceof HTMLInputElement && ['text', 'search'].includes(focused.type)
        ? focused.selectionStart
        : null;
    this.editor.beforePaint();
    this.root.innerHTML = `<style>${DASHBOARD_CSS}</style>${renderDashboard(this.state)}`;
    // L'éditeur de code et la comparaison reviennent dans la page redessinée.
    this.editor.afterPaint();
    if (focused?.closest('.cm-editor')) return;
    if (focusKey) {
      const key = CSS.escape(focusKey);
      const candidates = [
        ...this.root.querySelectorAll<HTMLElement>(
          `[data-action="${key}"],[data-bind="${key}"],[data-field="${key}"],[data-req="${key}"],[data-lib="${key}"],[data-ed-field="${key}"],[data-ed-add="${key}"],[data-ed="${key}"]`,
        ),
      ];
      const twin = candidates.find(
        (element) =>
          `${element.dataset.block ?? ''}|${element.dataset.index ?? ''}|${element.dataset.direction ?? ''}` ===
          focusTwin,
      );
      const same = candidates.find((element) => (element as HTMLInputElement).value === focusValue);
      const target = (focusTwin !== '||' ? twin : undefined) ?? same ?? candidates[0];
      target?.focus();
      if (caret !== null && target instanceof HTMLInputElement) target.setSelectionRange(caret, caret);
    }
  }
}

export function defineDashboard(name = 'qa-crawler-dashboard'): void {
  if (!('customElements' in globalThis) || customElements.get(name)) return;
  customElements.define(name, QaCrawlerDashboard);
}
