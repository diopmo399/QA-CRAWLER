import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import type { Incident } from '../core/incident-contracts.js';
import {
  applicationOf,
  emptyApplicationForm,
  emptyExtensionForm,
  emptyIncidentForm,
  emptyIncidentsUi,
  incidentFormProblems,
  incidentInputOf,
  needsPolling,
  scopeFormOf,
  scopeOf,
  type ApplicationForm,
  type ExtensionForm,
  type IncidentForm,
  type IncidentsUi,
  type InvestigationRow,
  type ScopeForm,
} from './dashboard-incidents.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';
import { workspaceProgress } from './incident-ux.js';
import {
  WorkspaceController,
  type OpOptions,
  type OpRun,
  type WorkspaceHost,
} from './incident-workspace-controller.js';
import { DEMO_INCIDENT_ID, isDemoIncident } from './incident-workspace.js';

export { INCIDENT_POLL_MS } from './incident-workspace-controller.js';

/**
 * LE CONTRÔLEUR DES INCIDENTS : la liste, la déclaration, la liste des investigations, l'ouverture d'un
 * incident (ou de la démonstration), le périmètre et ses extensions, la reproduction, l'annulation et la
 * reprise. L'espace d'investigation (onglets, sélection, graphe, code, diagnostic, suivi) est tenu par
 * `WorkspaceController`, à qui il passe les `data-action` `ws-…`. Une seule opération à la fois ; un 409
 * (révision périmée) relit l'incident et le dit. Le serveur revérifie droits et périmètre.
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

/** Les investigations dont la progression est lue (les plus récentes d'abord). */
const MAX_PROGRESS = 40;

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
  /** Le sélecteur à focaliser après le prochain chargement (ouverture d'une page). */
  private pendingFocus: string | undefined;
  /** L'espace d'investigation de l'incident ouvert. */
  readonly workspace: WorkspaceController;

  constructor(private readonly host: IncidentsHost) {
    const workspaceHost = {
      root: host.root,
      api: () => host.api(),
      paint: () => {
        host.paint();
      },
      op: (busy: string, run: OpRun, options?: OpOptions) => this.op(busy, run, options),
      receive: (incident: Incident) => {
        this.receive(incident);
      },
      focus: (selector: string) => this.focus(selector),
    };
    Object.defineProperty(workspaceHost, 'state', { get: () => host.state });
    this.workspace = new WorkspaceController(workspaceHost as WorkspaceHost);
  }

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
      '[data-action="ws-ux-tab"][aria-selected="true"]',
      '[data-action="inc-refresh"]',
    ])
      if (candidate && this.focus(candidate)) return;
  }

  // ── Navigation et chargement ───────────────────────────────────────────────────────────────

  /** Appelé à chaque navigation : quitter la page arrête le suivi ; un autre incident repart de zéro. */
  leave(route: DashboardRoute): void {
    const ui = this.ui;
    if (route.view !== 'incident' || route.incidentId !== ui.incident?.id) {
      this.workspace.stop();
      Object.assign(ui, {
        incident: undefined,
        loadError: undefined,
        validation: undefined,
        scopeForm: undefined,
        extension: emptyExtensionForm(),
      });
    }
    if (route.view !== 'incidents' || !route.create) ui.form = undefined;
    ui.confirmCancel = false;
    ui.invalid = undefined;
    ui.error = undefined;
    ui.details = undefined;
    ui.notice = undefined;
  }

  /** Ce que la vue affiche : la liste, les investigations, ou l'incident (et ce que son onglet lit). */
  async load(api: QaCrawlerClient, route: DashboardRoute, current: () => boolean): Promise<void> {
    const ui = this.ui;
    if (route.view === 'incidents') {
      const list = await api.incidents.list(route.projectId);
      if (!current()) return;
      ui.list = list;
      if (route.create && !ui.form) ui.form = emptyIncidentForm(this.host.state.project);
      return;
    }
    if (route.view === 'investigations') {
      const list = await api.incidents.list(route.projectId);
      if (!current()) return;
      ui.list = list;
      const open = [...list]
        .filter((summary) => summary.state !== 'DRAFT')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      // La progression demande l'incident entier : lue pour les plus récentes, en parallèle.
      const read = await Promise.allSettled(
        open.slice(0, MAX_PROGRESS).map((summary) => api.incidents.get(route.projectId, summary.id)),
      );
      if (!current()) return;
      ui.investigations = open.map((summary, index): InvestigationRow => {
        const result = read[index];
        return result?.status === 'fulfilled'
          ? { summary, progress: workspaceProgress(result.value) }
          : { summary };
      });
      return;
    }
    if (route.view !== 'incident') return;
    if (isDemoIncident(route.incidentId)) {
      // La démonstration : ses données viennent du module, aucune lecture du serveur.
      const demo = await this.workspace.demo();
      if (!current()) return;
      ui.loadError = undefined;
      this.receive(demo.demoIncident(), true);
      this.workspace.ensure();
      return;
    }
    try {
      const incident = await api.incidents.get(route.projectId, route.incidentId);
      if (!current()) return;
      ui.loadError = undefined;
      this.receive(incident, false);
      this.workspace.ensure();
    } catch (error) {
      if (!current()) return;
      ui.incident = undefined;
      ui.loadError = {
        message: message(error),
        denied: error instanceof QaCrawlerError && error.status === 403,
      };
    }
  }

  /** Après le dessin d'un chargement : le focus demandé (ouverture d'un incident). */
  afterLoad(): void {
    const selector = this.pendingFocus;
    this.pendingFocus = undefined;
    if (selector) this.focus(selector);
  }

  /** Un incident relu : il remplace l'affiché ; un incident qui avance encore est suivi. */
  receive(incident: Incident, demo = this.ui.ws.demo && isDemoIncident(incident.id)): void {
    const ui = this.ui;
    const before = ui.incident;
    this.workspace.adopt(incident, demo);
    ui.incident = incident;
    if (before?.id === incident.id && before.state === 'REPRODUCING' && incident.state !== 'REPRODUCING')
      ui.notice = this.host.state.t.inc.done.reproductionOver(
        this.host.state.t.inc.states[incident.state] ?? incident.state,
      );
    if (!demo && needsPolling(incident)) this.workspace.poll();
  }

  stop(): void {
    this.workspace.stop();
  }

  /** Le suivi est-il actif (tests) ? */
  get polling(): boolean {
    return this.workspace.polling;
  }

  dispose(): void {
    this.workspace.stop();
  }

  // ── Opérations ─────────────────────────────────────────────────────────────────────────────

  /**
   * Une opération sur l'incident ouvert : une à la fois, son erreur (et ses raisons) dite dans la page.
   * Une révision périmée (409) relit l'incident et le dit. Jamais en démonstration.
   */
  async op(busy: string, run: OpRun, options: OpOptions = {}): Promise<void> {
    const api = this.host.api();
    const route = this.route();
    const ui = this.ui;
    const incident = ui.incident;
    if (!api || !route || incident?.id !== route.incidentId || ui.busy !== undefined) {
      options.settle?.();
      return;
    }
    if (ui.ws.demo) {
      ui.notice = this.host.state.t.inc.demo.unavailable;
      options.settle?.();
      this.host.paint();
      return;
    }
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
      const conflict = error instanceof QaCrawlerError && error.status === 409;
      const text = conflict && options.revision ? this.host.state.t.inc.conflict : message(error);
      if (options.onError) options.onError(text, detailsOf(error));
      else {
        ui.error = text;
        ui.details = detailsOf(error);
      }
      // Un refus 409 (révision périmée, état qui a changé) : l'incident du serveur est relu.
      if (conflict) {
        try {
          const fresh = await api.incidents.get(route.projectId, incident.id);
          if (this.route()?.incidentId === incident.id) this.receive(fresh);
        } catch {
          // La relecture suivante (Actualiser) montrera la version du serveur.
        }
      }
    }
    ui.busy = undefined;
    options.settle?.();
    this.paintKeepingFocus(options.focus);
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
      this.pendingFocus = '#ws-ux-tab-scope';
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

  // ── Événements de la page ──────────────────────────────────────────────────────────────────

  click(action: string, target: HTMLElement): boolean {
    if (action.startsWith('ws-')) return this.workspace.click(action, target);
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
        this.pendingFocus = '#ws-ux-tab-overview';
        this.host.navigate({ view: 'incident', projectId: route.projectId, incidentId });
        return true;
      }
      case 'inc-demo': {
        if (!('projectId' in route) || !route.projectId) return true;
        this.pendingFocus = '#ws-ux-tab-overview';
        this.host.navigate({ view: 'incident', projectId: route.projectId, incidentId: DEMO_INCIDENT_ID });
        return true;
      }
      case 'inc-scope-edit':
        if (!ui.incident || ui.ws.demo) return true;
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
      case 'inc-cancel':
        if (ui.ws.demo) return true;
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
      default:
        return this.workspace.submit(form);
    }
  }

  /** Une saisie : gardée dans l'état sans redessiner (le focus et le curseur restent). */
  input(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
    if (target.dataset.wsField !== undefined) return this.workspace.input(target);
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
    return key === 'target';
  }

  /** Un choix (liste, bouton radio, case à cocher) : gardé ; la cible et la nature d'extension changent le formulaire. */
  change(target: HTMLInputElement | HTMLSelectElement): boolean {
    if (target.dataset.wsField !== undefined || target.dataset.action?.startsWith('ws-'))
      return this.workspace.change(target);
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

  /** Échap referme la confirmation d'annulation ; le reste du clavier de l'espace va à son contrôleur. */
  keydown(event: KeyboardEvent): boolean {
    if (!this.route()) return false;
    const ui = this.ui;
    if (event.key === 'Escape' && ui.confirmCancel) {
      ui.confirmCancel = false;
      this.host.paint();
      this.focus('[data-action="inc-cancel"]');
      return true;
    }
    return this.workspace.keydown(event);
  }

  pointerDown(event: PointerEvent): boolean {
    return this.route() ? this.workspace.pointerDown(event) : false;
  }

  wheel(event: WheelEvent): boolean {
    return this.route() ? this.workspace.wheel(event) : false;
  }

  beforePaint(): void {
    if (this.route()) this.workspace.beforePaint();
  }

  afterPaint(): void {
    if (this.route()) this.workspace.afterPaint();
  }
}
