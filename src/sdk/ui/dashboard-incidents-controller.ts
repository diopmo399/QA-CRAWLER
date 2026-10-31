import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import type { Incident } from '../core/incident-contracts.js';
import { can } from './dashboard-access.js';
import {
  applicationOf,
  emptyApplicationForm,
  emptyExperimentForm,
  emptyExtensionForm,
  emptyIncidentForm,
  emptyIncidentsUi,
  INCIDENT_TABS,
  incidentFormProblems,
  incidentInputOf,
  needsPolling,
  parseParams,
  scopeFormOf,
  scopeOf,
  type ApplicationForm,
  type ExperimentForm,
  type ExtensionForm,
  type IncidentForm,
  type IncidentTab,
  type IncidentsUi,
  type ScopeForm,
} from './dashboard-incidents.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';

/**
 * LE CONTRÔLEUR DES INCIDENTS : il ne fait qu'appeler le client du SDK (déclarer, délimiter,
 * reproduire, analyser, vérifier, diagnostiquer, proposer un test) et garde l'état de la page. Une
 * reproduction ou une vérification en cours est suivie en relisant l'incident jusqu'à sa fin, et le
 * suivi s'arrête dès qu'on quitte la page. Une vérification avec effets de bord n'est exécutée
 * qu'après une approbation explicite dans la page ; le serveur revérifie droits et périmètre.
 */
export interface IncidentsHost {
  readonly state: DashboardState;
  readonly root: ShadowRoot;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  navigate(route: DashboardRoute): void;
  /** Relit la vue courante (liste ou incident). */
  refresh(): Promise<void>;
}

type IncidentRoute = Extract<DashboardRoute, { view: 'incident' }>;

/** Une relecture par seconde et demie pendant une reproduction (comme le suivi des tests générés). */
export const INCIDENT_POLL_MS = 1500;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const detailsOf = (error: unknown): string[] => (error instanceof QaCrawlerError ? error.details : []);

const FORM_FIELDS: readonly (keyof IncidentForm)[] = [
  'title',
  'description',
  'observed',
  'expected',
  'namespace',
  'serviceAccount',
  'image',
  'repositoriesMount',
];
const SCOPE_FIELDS: Record<string, keyof Omit<ScopeForm, 'applications' | 'app' | 'appError'>> = {
  'scope.mode': 'mode',
  'scope.depth': 'depth',
  'scope.scenarios': 'scenarios',
  'scope.steps': 'steps',
  'scope.endpoints': 'endpoints',
  'scope.allowedHosts': 'allowedHosts',
};

export class IncidentsController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Le sélecteur à focaliser après le prochain chargement (ouverture d'une page). */
  private pendingFocus: string | undefined;

  constructor(private readonly host: IncidentsHost) {}

  get ui(): IncidentsUi {
    this.host.state.inc ??= emptyIncidentsUi();
    return this.host.state.inc;
  }

  private route(): IncidentRoute | undefined {
    const route = this.host.state.route;
    return route.view === 'incident' ? route : undefined;
  }

  private focus(selector: string): boolean {
    const element = this.host.root.querySelector<HTMLElement>(selector);
    if (!element || (element as HTMLButtonElement).disabled) return false;
    element.focus();
    return true;
  }

  /**
   * Redessine ; quand le focus a été perdu (bouton désactivé pendant l'opération), il revient sur
   * `selector`, sinon sur l'onglet affiché : le clavier ne repart jamais du début de la page.
   */
  private paintKeepingFocus(selector?: string): void {
    this.host.paint();
    if (this.host.root.activeElement) return;
    for (const candidate of [
      selector,
      '[data-action="inc-tab"][aria-selected="true"]',
      '[data-action="inc-refresh"]',
    ])
      if (candidate && this.focus(candidate)) return;
  }

  // ── Navigation et chargement ───────────────────────────────────────────────────────────────

  /** Appelé à chaque navigation : quitter la page arrête le suivi ; un autre incident repart de zéro. */
  leave(route: DashboardRoute): void {
    const ui = this.ui;
    if (route.view !== 'incident' || route.incidentId !== ui.incident?.id) {
      this.stop();
      Object.assign(ui, {
        incident: undefined,
        capabilities: undefined,
        capabilitiesError: undefined,
        validation: undefined,
        report: undefined,
        reportError: undefined,
        scopeForm: undefined,
        approving: undefined,
        extension: emptyExtensionForm(),
        experiment: emptyExperimentForm(),
      });
    }
    if (route.view !== 'incidents' || !route.create) ui.form = undefined;
    ui.confirmCancel = false;
    ui.invalid = undefined;
    ui.error = undefined;
    ui.details = undefined;
    ui.notice = undefined;
  }

  /** Ce que la vue affiche : la liste, ou l'incident et les données de son onglet. */
  async load(api: QaCrawlerClient, route: DashboardRoute, current: () => boolean): Promise<void> {
    const ui = this.ui;
    if (route.view === 'incidents') {
      const list = await api.incidents.list(route.projectId);
      if (!current()) return;
      ui.list = list;
      if (route.create && !ui.form) ui.form = emptyIncidentForm(this.host.state.project);
      return;
    }
    if (route.view !== 'incident') return;
    const incident = await api.incidents.get(route.projectId, route.incidentId);
    if (!current()) return;
    this.receive(incident);
    await this.loadTab(api, route, current);
  }

  /** Après le dessin d'un chargement : le focus demandé (ouverture d'un incident). */
  afterLoad(): void {
    const selector = this.pendingFocus;
    this.pendingFocus = undefined;
    if (selector) this.focus(selector);
  }

  /** Les données propres à l'onglet : capacités (Environnement), rapport (Chronologie, Rapport). */
  private async loadTab(
    api: QaCrawlerClient,
    route: IncidentRoute,
    current: () => boolean = () => true,
  ): Promise<void> {
    const ui = this.ui;
    const tab = route.tab ?? 'scope';
    const same = (): boolean => current() && this.route()?.incidentId === route.incidentId;
    if (tab === 'environment') {
      try {
        const capabilities = await api.incidents.capabilities(route.projectId, route.incidentId);
        if (!same()) return;
        ui.capabilities = capabilities;
        ui.capabilitiesError = undefined;
      } catch (error) {
        if (same()) ui.capabilitiesError = message(error);
      }
    } else if (tab === 'timeline' || tab === 'report') {
      try {
        const report = await api.incidents.report(route.projectId, route.incidentId);
        if (!same()) return;
        ui.report = report;
        ui.reportError = undefined;
      } catch (error) {
        if (same()) ui.reportError = message(error);
      }
    }
  }

  /** Un incident relu : il remplace l'affiché ; un incident qui avance encore est suivi. */
  private receive(incident: Incident): void {
    const ui = this.ui;
    const before = ui.incident;
    // Le rapport est calculé sur l'incident : une nouvelle révision le rend périmé.
    if (before && before.revision !== incident.revision) ui.report = undefined;
    ui.incident = incident;
    if (before?.state === 'REPRODUCING' && incident.state !== 'REPRODUCING')
      ui.notice = this.host.state.t.inc.done.reproductionOver(
        this.host.state.t.inc.states[incident.state] ?? incident.state,
      );
    if (needsPolling(incident)) this.poll();
  }

  /** Relit l'incident tant qu'il avance sur le serveur ; s'arrête quand on quitte sa page. */
  private poll(): void {
    if (this.timer) return;
    const api = this.host.api();
    const route = this.route();
    if (!api || !route) return;
    const { projectId, incidentId } = route;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.route()?.incidentId !== incidentId) return;
      // Une opération en cours rendra l'incident à jour : le suivi attend le tour suivant.
      if (this.ui.busy !== undefined) {
        this.poll();
        return;
      }
      void api.incidents
        .get(projectId, incidentId)
        .then(async (incident) => {
          const now = this.route();
          if (now?.incidentId !== incidentId) return;
          this.receive(incident);
          if (!this.ui.report && (now.tab === 'timeline' || now.tab === 'report'))
            await this.loadTab(api, now);
          this.paintKeepingFocus();
        })
        .catch(() => {
          // Une lecture manquée n'arrête pas le suivi : la suivante réessaie.
          this.poll();
        });
    }, INCIDENT_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Le suivi est-il actif (tests) ? */
  get polling(): boolean {
    return this.timer !== undefined;
  }

  dispose(): void {
    this.stop();
  }

  // ── Opérations ─────────────────────────────────────────────────────────────────────────────

  /**
   * Une opération sur l'incident ouvert : une à la fois, son erreur (et ses raisons) dite dans la page.
   * Une révision périmée (409) relit l'incident et le dit.
   */
  private async op(
    busy: string,
    run: (api: QaCrawlerClient, projectId: string, incident: Incident) => Promise<Incident | undefined>,
    options: {
      notice?: (incident: Incident) => string | undefined;
      focus?: string;
      after?: () => void;
      /** Une modification sur la révision lue : un 409 veut dire que l'incident a changé entre-temps. */
      revision?: boolean;
    } = {},
  ): Promise<void> {
    const api = this.host.api();
    const route = this.route();
    const ui = this.ui;
    const incident = ui.incident;
    if (!api || !route || incident?.id !== route.incidentId || ui.busy !== undefined) return;
    ui.busy = busy;
    ui.error = undefined;
    ui.details = undefined;
    ui.notice = undefined;
    this.host.paint();
    try {
      const next = await run(api, route.projectId, incident);
      if (next && this.route()?.incidentId === incident.id) {
        this.receive(next);
        ui.notice = options.notice?.(next) ?? ui.notice;
      }
      options.after?.();
    } catch (error) {
      ui.error = message(error);
      ui.details = detailsOf(error);
      // Un refus 409 (révision périmée, état qui a changé) : l'incident du serveur est relu.
      if (error instanceof QaCrawlerError && error.status === 409) {
        if (options.revision) ui.error = this.host.state.t.inc.conflict;
        try {
          const fresh = await api.incidents.get(route.projectId, incident.id);
          if (this.route()?.incidentId === incident.id) this.receive(fresh);
        } catch {
          // La relecture suivante (Actualiser) montrera la version du serveur.
        }
      }
    }
    ui.busy = undefined;
    const now = this.route();
    if (now?.incidentId === incident.id && !ui.report && (now.tab === 'timeline' || now.tab === 'report'))
      await this.loadTab(api, now);
    this.paintKeepingFocus(options.focus);
  }

  private stateLabel(state: string): string {
    return this.host.state.t.inc.states[state] ?? state;
  }

  private async create(): Promise<void> {
    const api = this.host.api();
    const route = this.host.state.route;
    const ui = this.ui;
    const form = ui.form;
    if (!api || route.view !== 'incidents' || !form || ui.busy !== undefined) return;
    const missing = incidentFormProblems(form);
    if (missing.length > 0) {
      ui.invalid = missing;
      this.host.paint();
      this.focus(`[data-inc="${missing[0] ?? 'title'}"]`);
      return;
    }
    ui.invalid = undefined;
    ui.busy = 'inc-create';
    ui.error = undefined;
    ui.details = undefined;
    this.host.paint();
    try {
      const incident = await api.incidents.create(route.projectId, incidentInputOf(form));
      ui.busy = undefined;
      this.pendingFocus = '#inc-tab-scope';
      this.host.navigate({
        view: 'incident',
        projectId: route.projectId,
        incidentId: incident.id,
        tab: 'scope',
      });
      ui.notice = this.host.state.t.inc.done.created(incident.title);
    } catch (error) {
      ui.busy = undefined;
      ui.error = message(error);
      ui.details = detailsOf(error);
      this.paintKeepingFocus('[data-inc="title"]');
    }
  }

  private download(name: string, content: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = this.host.root.ownerDocument.createElement('a');
    anchor.href = url;
    anchor.download = name;
    this.host.root.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  private exportReport(format: 'json' | 'markdown'): void {
    const t = this.host.state.t.inc;
    void this.op(`inc-export-${format}`, async (api, projectId, incident) => {
      const file = `incident-${incident.id}.${format === 'json' ? 'json' : 'md'}`;
      if (format === 'json') {
        const report = await api.incidents.report(projectId, incident.id);
        this.ui.report = report;
        this.download(file, `${JSON.stringify(report, null, 2)}\n`, 'application/json;charset=utf-8');
      } else {
        const markdown = await api.incidents.reportMarkdown(projectId, incident.id);
        this.download(file, markdown, 'text/markdown;charset=utf-8');
      }
      this.ui.notice = t.done.exported(file);
      return undefined;
    });
  }

  /** Passer d'un onglet à l'autre : la route change sur place, les données de l'onglet sont lues. */
  private selectTab(tab: IncidentTab): void {
    const route = this.route();
    if (!route) return;
    this.host.state.route = { ...route, tab };
    this.ui.approving = undefined;
    this.ui.invalid = undefined;
    this.host.paint();
    this.focus(`#inc-tab-${tab}`);
    const api = this.host.api();
    if (!api) return;
    const next = this.route();
    if (!next) return;
    const needs =
      (tab === 'environment' && !this.ui.capabilities) ||
      ((tab === 'timeline' || tab === 'report') && !this.ui.report);
    if (needs)
      void this.loadTab(api, next).then(() => {
        if (this.route()?.tab === tab) this.paintKeepingFocus(`#inc-tab-${tab}`);
      });
  }

  // ── Événements de la page ──────────────────────────────────────────────────────────────────

  click(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    const t = this.host.state.t.inc;
    const state = this.host.state;
    const route = state.route;
    const block = target.dataset.block ?? '';
    switch (action) {
      case 'inc-refresh':
        void this.host.refresh();
        return true;
      case 'inc-new':
        if (route.view !== 'incidents') return true;
        state.route = { ...route, create: true };
        ui.form = emptyIncidentForm(state.project);
        ui.invalid = undefined;
        this.host.paint();
        this.focus('[data-inc="title"]');
        return true;
      case 'inc-create-cancel':
        if (route.view !== 'incidents') return true;
        state.route = { view: 'incidents', projectId: route.projectId };
        ui.form = undefined;
        ui.invalid = undefined;
        this.host.paint();
        this.focus('[data-action="inc-new"]');
        return true;
      case 'inc-open': {
        const incidentId = target.dataset.incident;
        if (!incidentId || !('projectId' in route) || !route.projectId) return true;
        this.pendingFocus = '#inc-tab-scope';
        this.host.navigate({ view: 'incident', projectId: route.projectId, incidentId });
        return true;
      }
      case 'inc-tab': {
        const tab = INCIDENT_TABS.find((entry) => entry === target.dataset.tab);
        if (tab) this.selectTab(tab);
        return true;
      }
      case 'inc-scope-edit':
        if (!ui.incident) return true;
        ui.scopeForm = scopeFormOf(ui.incident.scope);
        this.host.paint();
        this.focus('[data-inc="scope.mode"]');
        return true;
      case 'inc-scope-cancel':
        ui.scopeForm = undefined;
        this.host.paint();
        this.focus('[data-action="inc-scope-edit"]');
        return true;
      case 'inc-app-add': {
        const form = ui.scopeForm;
        if (!form) return true;
        const app = applicationOf(form.app, form.applications);
        if (typeof app === 'string') {
          form.appError = app;
          this.host.paint();
          this.focus(app === 'relative' ? '[data-inc="app.root"]' : '[data-inc="app.id"]');
          return true;
        }
        form.applications = [...form.applications, app];
        form.app = emptyApplicationForm();
        form.appError = undefined;
        this.host.paint();
        this.focus('[data-inc="app.id"]');
        return true;
      }
      case 'inc-app-remove': {
        const form = ui.scopeForm;
        const index = Number(target.dataset.index);
        if (!form || !Number.isInteger(index)) return true;
        form.applications = form.applications.filter((_, at) => at !== index);
        this.host.paint();
        if (
          !this.focus(
            `[data-action="inc-app-remove"][data-index="${String(Math.min(index, form.applications.length - 1))}"]`,
          )
        )
          this.focus('[data-inc="app.id"]');
        return true;
      }
      case 'inc-validate':
        void this.op(
          'inc-validate',
          async (api, projectId, incident) => {
            ui.validation = await api.incidents.validateScope(projectId, incident.id);
            return undefined;
          },
          { focus: '[data-action="inc-validate"]' },
        );
        return true;
      case 'inc-ext-approve':
      case 'inc-ext-reject': {
        const approve = action === 'inc-ext-approve';
        void this.op(
          action,
          (api, projectId, incident) => api.incidents.decideExtension(projectId, incident.id, block, approve),
          {
            notice: () => (approve ? t.done.extensionApproved : t.done.extensionRejected),
          },
        );
        return true;
      }
      case 'inc-capabilities':
        void this.op(
          'inc-capabilities',
          async (api, projectId, incident) => {
            ui.capabilities = await api.incidents.capabilities(projectId, incident.id);
            ui.capabilitiesError = undefined;
            return undefined;
          },
          { focus: '[data-action="inc-capabilities"]' },
        );
        return true;
      case 'inc-reproduce':
        void this.op(
          'inc-reproduce',
          (api, projectId, incident) => api.incidents.reproduce(projectId, incident.id),
          {
            notice: () => t.done.reproductionStarted,
            focus: '[data-action="inc-reproduce"]',
          },
        );
        return true;
      case 'inc-analyze':
        void this.op(
          'inc-analyze',
          (api, projectId, incident) => api.incidents.analyze(projectId, incident.id),
          {
            notice: (incident) => t.done.analyzed(incident.investigation.hypotheses.length),
            focus: '[data-action="inc-analyze"]',
          },
        );
        return true;
      case 'inc-plan': {
        const hypothesis = ui.incident?.investigation.hypotheses.find((entry) => entry.id === block);
        const verification = hypothesis?.verifications[Number(target.dataset.index)];
        if (!hypothesis || !verification) return true;
        void this.op(
          'inc-plan',
          (api, projectId, incident) =>
            api.incidents.planExperiment(projectId, incident.id, {
              kind: verification.kind,
              params: verification.params,
              hypothesisId: hypothesis.id,
            }),
          {
            notice: () => t.done.planned,
            focus: `[data-action="inc-plan"][data-block="${CSS.escape(block)}"][data-index="${target.dataset.index ?? '0'}"]`,
          },
        );
        return true;
      }
      case 'inc-run': {
        const experiment = ui.incident?.investigation.experiments.find((entry) => entry.id === block);
        if (!experiment) return true;
        if (experiment.sideEffects || experiment.status === 'APPROVAL_REQUIRED') {
          // L'approbation se donne dans la page, en connaissance de cause (jamais une boîte du navigateur).
          ui.approving = experiment.id;
          this.host.paint();
          if (!this.focus('[data-action="inc-approve-yes"]')) this.focus('[data-action="inc-approve-no"]');
          return true;
        }
        void this.op(
          'inc-run',
          (api, projectId, incident) => api.incidents.runExperiment(projectId, incident.id, experiment.id),
          {
            notice: (incident) => this.experimentNotice(incident, experiment.id),
          },
        );
        return true;
      }
      case 'inc-approve-no':
        ui.approving = undefined;
        this.host.paint();
        this.focus(`[data-action="inc-run"][data-block="${CSS.escape(block)}"]`);
        return true;
      case 'inc-approve-yes': {
        if (ui.approving !== block || !can(state, 'RUN_WRITES')) return true;
        void this.op(
          'inc-approve-yes',
          (api, projectId, incident) =>
            api.incidents.runExperiment(projectId, incident.id, block, { approve: true }),
          {
            notice: (incident) => this.experimentNotice(incident, block),
            after: () => {
              ui.approving = undefined;
            },
            focus: '[data-action="inc-tab"][aria-selected="true"]',
          },
        );
        return true;
      }
      case 'inc-diagnose':
        void this.op(
          'inc-diagnose',
          (api, projectId, incident) => api.incidents.diagnose(projectId, incident.id),
          {
            notice: (incident) => {
              const status = incident.investigation.diagnosis?.status;
              return status ? t.done.diagnosed(t.diagnosisStatus[status] ?? status) : undefined;
            },
            focus: '[data-action="inc-diagnose"]',
          },
        );
        return true;
      case 'inc-report':
        void this.op(
          'inc-report',
          async (api, projectId, incident) => {
            ui.report = await api.incidents.report(projectId, incident.id);
            ui.reportError = undefined;
            return undefined;
          },
          { focus: '[data-action="inc-report"]' },
        );
        return true;
      case 'inc-export-json':
        this.exportReport('json');
        return true;
      case 'inc-export-markdown':
        this.exportReport('markdown');
        return true;
      case 'inc-reg-propose':
        void this.op(
          'inc-reg-propose',
          (api, projectId, incident) => api.incidents.proposeRegression(projectId, incident.id),
          { notice: () => t.done.regressionProposed, focus: '[data-action="inc-reg-run"]' },
        );
        return true;
      case 'inc-reg-run':
        void this.op(
          'inc-reg-run',
          (api, projectId, incident) => api.incidents.runRegression(projectId, incident.id),
          {
            notice: () => t.done.regressionRun,
            focus: '[data-action="inc-reg-run"]',
          },
        );
        return true;
      case 'inc-reg-accept':
        void this.op(
          'inc-reg-accept',
          (api, projectId, incident) => api.incidents.acceptRegression(projectId, incident.id),
          { notice: () => t.done.regressionAccepted, focus: '[data-action="inc-reg-run"]' },
        );
        return true;
      case 'inc-reg-reject':
        void this.op(
          'inc-reg-reject',
          (api, projectId, incident) => api.incidents.rejectRegression(projectId, incident.id),
          { notice: () => t.done.regressionRejected, focus: '[data-action="inc-reg-propose"]' },
        );
        return true;
      case 'inc-cancel':
        ui.confirmCancel = true;
        this.host.paint();
        this.focus('[data-action="inc-cancel-yes"]');
        return true;
      case 'inc-cancel-no':
        ui.confirmCancel = false;
        this.host.paint();
        this.focus('[data-action="inc-cancel"]');
        return true;
      case 'inc-cancel-yes':
        void this.op(
          'inc-cancel-yes',
          (api, projectId, incident) => api.incidents.cancel(projectId, incident.id),
          {
            notice: () => t.done.cancelled,
            after: () => {
              ui.confirmCancel = false;
            },
            focus: '[data-action="inc-resume"]',
          },
        );
        return true;
      case 'inc-resume':
        void this.op(
          'inc-resume',
          (api, projectId, incident) => api.incidents.resume(projectId, incident.id),
          {
            notice: () => t.done.resumed,
            focus: '[data-action="inc-cancel"]',
          },
        );
        return true;
      default:
        return false;
    }
  }

  private experimentNotice(incident: Incident, experimentId: string): string | undefined {
    const t = this.host.state.t.inc;
    const done = incident.investigation.experiments.find((entry) => entry.id === experimentId);
    return done ? t.done.experimentOver(t.experimentStatus[done.status] ?? done.status) : undefined;
  }

  submit(form: HTMLFormElement): boolean {
    const action = form.dataset.action;
    const ui = this.ui;
    const t = this.host.state.t.inc;
    switch (action) {
      case 'inc-create':
        void this.create();
        return true;
      case 'inc-scope-save': {
        const scopeForm = ui.scopeForm;
        if (!scopeForm) return true;
        void this.op(
          'inc-scope-save',
          (api, projectId, incident) =>
            api.incidents.update(projectId, incident.id, incident.revision, {
              scope: scopeOf(scopeForm, incident.scope),
            }),
          {
            notice: () => t.done.scopeSaved,
            revision: true,
            after: () => {
              ui.scopeForm = undefined;
              ui.validation = undefined;
            },
            focus: '[data-action="inc-scope-edit"]',
          },
        );
        return true;
      }
      case 'inc-ext-request': {
        const extension = ui.extension;
        const missing = [
          ...(extension.target.trim() ? [] : ['ext.target']),
          ...(extension.reason.trim() ? [] : ['ext.reason']),
        ];
        if (missing.length > 0) {
          ui.invalid = missing;
          this.host.paint();
          this.focus(`[data-inc="${missing[0] ?? 'ext.target'}"]`);
          return true;
        }
        ui.invalid = undefined;
        void this.op(
          'inc-ext-request',
          (api, projectId, incident) =>
            api.incidents.requestExtension(projectId, incident.id, {
              kind: extension.kind,
              target: extension.target.trim(),
              ...(extension.applicationId ? { applicationId: extension.applicationId } : {}),
              reason: extension.reason.trim(),
            }),
          {
            notice: () => t.done.extensionRequested,
            after: () => {
              ui.extension = emptyExtensionForm();
            },
            focus: '[data-inc="ext.kind"]',
          },
        );
        return true;
      }
      case 'inc-plan-form': {
        const experiment = ui.experiment;
        void this.op(
          'inc-plan-form',
          (api, projectId, incident) =>
            api.incidents.planExperiment(projectId, incident.id, {
              kind: experiment.kind,
              params: parseParams(experiment.params),
              ...(experiment.hypothesisId ? { hypothesisId: experiment.hypothesisId } : {}),
            }),
          {
            notice: () => t.done.planned,
            after: () => {
              ui.experiment = emptyExperimentForm();
            },
            focus: '[data-inc="exp.kind"]',
          },
        );
        return true;
      }
      default:
        return false;
    }
  }

  /** Une saisie : gardée dans l'état sans redessiner (le focus et le curseur restent). */
  input(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
    const key = target.dataset.inc;
    if (!key) return false;
    const ui = this.ui;
    const value = target.value;
    if (ui.form && (FORM_FIELDS as readonly string[]).includes(key)) {
      ui.form[key as Exclude<keyof IncidentForm, 'severity' | 'target'>] = value;
      return true;
    }
    if (ui.form && (key === 'severity' || key === 'scenario' || key === 'environmentId')) {
      (ui.form as unknown as Record<string, string>)[key] = value;
      return true;
    }
    const scopeField = SCOPE_FIELDS[key];
    if (ui.scopeForm && scopeField) {
      (ui.scopeForm as unknown as Record<string, string>)[scopeField] = value;
      return true;
    }
    if (ui.scopeForm && key.startsWith('app.')) {
      const field = key.slice(4) as keyof ApplicationForm;
      if (field in ui.scopeForm.app) (ui.scopeForm.app as unknown as Record<string, string>)[field] = value;
      return true;
    }
    if (key.startsWith('ext.')) {
      const field = key.slice(4) as keyof ExtensionForm;
      if (field in ui.extension) (ui.extension as unknown as Record<string, string>)[field] = value;
      return true;
    }
    if (key.startsWith('exp.')) {
      const field = key.slice(4) as keyof ExperimentForm;
      if (field in ui.experiment) (ui.experiment as unknown as Record<string, string>)[field] = value;
      return true;
    }
    return key === 'target';
  }

  /** Un choix (liste, bouton radio) : gardé ; la cible et la nature d'extension changent le formulaire. */
  change(target: HTMLInputElement | HTMLSelectElement): boolean {
    const key = target.dataset.inc;
    if (!key) return false;
    const ui = this.ui;
    if (key === 'target' && ui.form) {
      const value = target.value;
      if (value === 'LOCAL' || value === 'REMOTE' || value === 'ARO') ui.form.target = value;
      ui.invalid = undefined;
      this.host.paint();
      return true;
    }
    this.input(target);
    if (key === 'ext.kind') this.host.paint();
    return true;
  }

  /** Les flèches passent d'un onglet à l'autre ; Échap referme une approbation ou une confirmation. */
  keydown(event: KeyboardEvent): boolean {
    const route = this.route();
    if (!route) return false;
    const ui = this.ui;
    if (event.key === 'Escape' && ui.approving) {
      const block = ui.approving;
      ui.approving = undefined;
      this.host.paint();
      this.focus(`[data-action="inc-run"][data-block="${CSS.escape(block)}"]`);
      return true;
    }
    if (event.key === 'Escape' && ui.confirmCancel) {
      ui.confirmCancel = false;
      this.host.paint();
      this.focus('[data-action="inc-cancel"]');
      return true;
    }
    const target = event.target as HTMLElement | null;
    if (target?.dataset.action !== 'inc-tab') return false;
    const at = INCIDENT_TABS.indexOf(route.tab ?? 'scope');
    const next =
      event.key === 'ArrowRight'
        ? INCIDENT_TABS[(at + 1) % INCIDENT_TABS.length]
        : event.key === 'ArrowLeft'
          ? INCIDENT_TABS[(at - 1 + INCIDENT_TABS.length) % INCIDENT_TABS.length]
          : event.key === 'Home'
            ? INCIDENT_TABS[0]
            : event.key === 'End'
              ? INCIDENT_TABS[INCIDENT_TABS.length - 1]
              : undefined;
    if (!next) return false;
    event.preventDefault();
    this.selectTab(next);
    return true;
  }
}
