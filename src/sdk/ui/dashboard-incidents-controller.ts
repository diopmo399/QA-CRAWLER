import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import { can } from './dashboard-access.js';
import type { Incident } from '../core/incident-contracts.js';
import {
  applicationOf,
  base64Of,
  emptyApplicationForm,
  emptyExtensionForm,
  emptyIncidentForm,
  emptyIncidentsUi,
  flowText,
  INCIDENT_LIST_GROUPS,
  incidentFormProblems,
  incidentInputOf,
  incidentsCsv,
  isListGroup,
  needsPolling,
  scopeFormOf,
  scopeOf,
  sortAttachments,
  visibleIncidents,
  type ApplicationForm,
  type ExtensionForm,
  type IncidentsUi,
  type InvestigationRow,
  type PendingAttachment,
  type ScopeForm,
} from './dashboard-incidents.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';
import {
  depthText,
  emptyScopeUi,
  reduceScope,
  SCOPE_MODES_ORDER,
  scopeDirty,
  scopeDraftOf,
  scopeEditable,
  scopeTreeRequests,
  type ScopeUi,
} from './incident-scope.js';
import {
  applyPlan,
  emptyDiscoveryUi,
  reduceDiscovery,
  withKnown,
  withResult,
  type DiscoveryUi,
} from './incident-scope-discovery.js';
import type { PrefsStorage } from './incident-split.js';
import { rovingTarget, workspaceProgress } from './incident-ux.js';
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
  /** Le stockage des préférences de l'espace d'investigation (absent : `localStorage` s'il est permis). */
  storage?(): PrefsStorage | undefined;
}

type IncidentRoute = Extract<DashboardRoute, { view: 'incident' }>;

/** Les investigations dont la progression est lue (les plus récentes d'abord). */
const MAX_PROGRESS = 40;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const detailsOf = (error: unknown): string[] => (error instanceof QaCrawlerError ? error.details : []);

type TextField =
  | 'title'
  | 'description'
  | 'application'
  | 'observed'
  | 'expected'
  | 'namespace'
  | 'serviceAccount'
  | 'image'
  | 'repositoriesMount';
const FORM_FIELDS: readonly TextField[] = [
  'title',
  'description',
  'application',
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
  /** Le texte du message au dernier dessin (absent avant le premier), et l'effacement de la zone live. */
  private liveSource: string | undefined;
  private liveClear: ReturnType<typeof setTimeout> | undefined;

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
      ...(host.storage ? { storage: () => host.storage?.() } : {}),
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

  /**
   * Focalise le premier élément visé qui peut l'être : pas désactivé, pas dans un corps masqué (panneau
   * réduit, `hidden`) — un bouton invisible laisserait le focus tomber sur la page.
   */
  private focus(selector: string): boolean {
    const root = this.host.root;
    let element = root.querySelector<HTMLElement>(selector);
    if (element && hiddenElement(element))
      element =
        [...root.querySelectorAll<HTMLElement>(selector)].find((candidate) => !hiddenElement(candidate)) ??
        null;
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
        scope: emptyScopeUi(),
        scopeTrees: {},
        discovery: emptyDiscoveryUi(),
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
      if (route.create && !ui.form) ui.form = emptyIncidentForm(this.host.state.project);
      try {
        const list = await api.incidents.list(route.projectId);
        if (!current()) return;
        ui.list = list;
        ui.listError = undefined;
      } catch (error) {
        if (!current()) return;
        ui.list = undefined;
        ui.listError = message(error);
      }
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
      // Les pièces jointes, une à une après la création : un refus n'empêche pas les suivantes.
      const failed: string[] = [];
      if (form.attachments.length > 0) {
        ui.busy = 'inc-attach';
        this.host.paint();
        for (const file of form.attachments)
          try {
            await api.incidents.addAttachment(route.projectId, incident.id, {
              name: file.name,
              type: file.type,
              dataBase64: file.dataBase64,
            });
          } catch (error) {
            failed.push(`${file.name} : ${message(error)}`);
          }
      }
      ui.busy = undefined;
      this.pendingFocus = '#ws-ux-sub-scope';
      this.host.navigate({
        view: 'incident',
        projectId: route.projectId,
        incidentId: incident.id,
        tab: 'scope',
      });
      const f = flowText(this.host.state.t.locale);
      ui.notice = `${this.host.state.t.inc.done.created(incident.title)}${
        form.attachments.length > 0 ? ` ${f.attachmentsSent(form.attachments.length - failed.length)}` : ''
      }`;
      if (failed.length > 0) {
        ui.error = f.attachmentsFailed(failed.length);
        ui.details = failed;
      }
    } catch (error) {
      ui.busy = undefined;
      ui.error = message(error);
      ui.details = detailsOf(error);
      this.paintKeepingFocus('[data-inc="title"]');
    }
  }

  // ── Liste et pièces jointes ────────────────────────────────────────────────────────────────

  /** Les lignes affichées de la liste, en fichier CSV (téléchargé par la page, rien n'est envoyé). */
  private exportCsv(): void {
    const ui = this.ui;
    const state = this.host.state;
    const route = state.route;
    if (route.view !== 'incidents' || !ui.list) return;
    const lang = state.t.locale;
    const f = flowText(lang);
    const rows = visibleIncidents(ui.list, ui.group, ui.query);
    if (rows.length === 0) return;
    const csv = incidentsCsv(
      rows,
      {
        columns: [f.col.id, f.col.title, f.col.severity, f.col.application, f.col.state, f.col.created],
        severities: state.t.inc.severities,
        states: state.t.inc.states,
      },
      lang,
    );
    const name = `incidents-${route.projectId}-${new Date().toISOString().slice(0, 10)}.csv`;
    try {
      const document = this.host.root.ownerDocument;
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 10_000);
      ui.notice = f.exported(name, rows.length);
    } catch (error) {
      ui.error = message(error);
    }
    this.host.paint();
  }

  /** Les fichiers choisis : triés (type, taille, nombre), lus en base64, gardés jusqu'à la création. */
  private async readFiles(input: HTMLInputElement): Promise<void> {
    const form = this.ui.form;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!form || files.length === 0) return;
    const { accepted, rejected } = sortAttachments(form.attachments.length, files);
    const read: PendingAttachment[] = [];
    for (const { index, type } of accepted) {
      const file = files[index];
      if (!file) continue;
      try {
        read.push({
          name: file.name,
          type,
          bytes: file.size,
          dataBase64: base64Of(new Uint8Array(await file.arrayBuffer())),
        });
      } catch {
        rejected.push({ name: file.name, reason: 'read' });
      }
    }
    if (this.ui.form !== form) return;
    form.attachments = [...form.attachments, ...read];
    form.rejected = rejected;
    this.host.paint();
    this.focus('#inc-f-files');
  }

  // ── Définition du périmètre ────────────────────────────────────────────────────────────────

  /** Le brouillon du périmètre de l'incident ouvert (un autre incident repart de zéro). */
  private scopeUi(): ScopeUi {
    const ui = this.ui;
    const id = ui.incident?.id;
    if (ui.scope.incidentId !== id) ui.scope = emptyScopeUi(id);
    return ui.scope;
  }

  private scopeAction(action: string, dataset: Record<string, string | undefined>): void {
    const ui = this.ui;
    const incident = ui.incident;
    if (!incident) return;
    ui.scope = reduceScope(this.scopeUi(), action, dataset, { incident, trees: ui.scopeTrees }) ?? ui.scope;
  }

  private scopeContext() {
    const state = this.host.state;
    const ui = this.ui;
    const incident = ui.incident;
    return incident
      ? {
          incident,
          lang: state.t.locale,
          can: (right: 'RUN' | 'DECIDE' | 'PUBLISH' | 'RUN_WRITES') => can(state, right),
          demo: ui.ws.demo && isDemoIncident(incident.id),
        }
      : undefined;
  }

  private scopeClick(action: string, target: HTMLElement): void {
    const context = this.scopeContext();
    if (!context || (action !== 'inc-scope-expand' && !scopeEditable(context))) return;
    const data = target.dataset;
    this.scopeAction(action, { mode: data.mode, block: data.block, index: data.index, open: data.open });
    this.host.paint();
    if (action === 'inc-scope-mode')
      this.focus(`[data-action="inc-scope-mode"][data-mode="${attr(data.mode ?? '')}"]`);
    else if (action === 'inc-scope-reset') this.focus('[data-action="inc-scope-next"]');
    else if (action === 'inc-scope-remove') {
      if (!this.focus('[data-action="inc-scope-remove"]')) this.focus('[data-action="inc-scope-next"]');
    } else
      this.focus(
        `[data-action="${action}"][data-block="${attr(data.block ?? '')}"][data-index="${attr(data.index ?? '')}"]`,
      );
  }

  /** Les arborescences de l'onglet « Périmètre » qui manquent : lues en parallèle, chaque réponse redessine. */
  private ensureScopeTrees(): void {
    const route = this.route();
    const ui = this.ui;
    const incident = ui.incident;
    const api = this.host.api();
    if (!route || route.tab !== 'scope' || !api || !incident || incident.id !== route.incidentId) return;
    const context = this.scopeContext();
    if (!context || context.demo || !context.can('RUN')) return;
    for (const app of scopeTreeRequests(incident, ui.scopeTrees)) {
      const root = app.repository.root;
      ui.scopeTrees = { ...ui.scopeTrees, [app.id]: { state: 'loading', root } };
      api.incidents.scopeTree(route.projectId, incident.id, app.id).then(
        (tree) => {
          if (this.ui.incident?.id !== incident.id) return;
          this.ui.scopeTrees = { ...this.ui.scopeTrees, [app.id]: { tree, root } };
          this.host.paint();
        },
        (error: unknown) => {
          if (this.ui.incident?.id !== incident.id) return;
          const denied = error instanceof QaCrawlerError && error.status === 403;
          this.ui.scopeTrees = {
            ...this.ui.scopeTrees,
            [app.id]: { state: denied ? 'denied' : { error: message(error) }, root },
          };
          this.host.paint();
        },
      );
    }
  }

  // ── Applications et dépôts (découverte automatique) ──────────────────────────────────────

  /** Le bloc de découverte de l'incident ouvert (un autre incident repart de zéro). */
  private discoveryUi(): DiscoveryUi {
    const ui = this.ui;
    const id = ui.incident?.id;
    if (ui.discovery.incidentId !== id) ui.discovery = emptyDiscoveryUi(id);
    return ui.discovery;
  }

  private discoveryAction(action: string, dataset: Record<string, string | undefined>): void {
    this.ui.discovery = reduceDiscovery(this.discoveryUi(), action, dataset) ?? this.ui.discovery;
  }

  /** Les dépôts connus de l'environnement, lus une fois par incident quand l'onglet « Périmètre » s'ouvre. */
  private ensureKnownRepositories(): void {
    const route = this.route();
    const ui = this.ui;
    const incident = ui.incident;
    const api = this.host.api();
    if (!route || route.tab !== 'scope' || !api || !incident || incident.id !== route.incidentId) return;
    const context = this.scopeContext();
    if (!context || context.demo || !context.can('RUN')) return;
    const discovery = this.discoveryUi();
    if (discovery.known !== undefined || discovery.knownState !== undefined) return;
    ui.discovery = { ...discovery, knownState: 'loading' };
    api.incidents.knownRepositories(route.projectId, incident.id).then(
      (result) => {
        if (this.ui.incident?.id !== incident.id) return;
        this.ui.discovery = withKnown(this.discoveryUi(), result.repositories);
        this.host.paint();
      },
      (error: unknown) => {
        if (this.ui.incident?.id !== incident.id) return;
        const denied = error instanceof QaCrawlerError && error.status === 403;
        this.ui.discovery = {
          ...this.discoveryUi(),
          knownState: denied ? 'denied' : { error: message(error) },
        };
        this.host.paint();
      },
    );
  }

  /** « Analyser automatiquement » : le chemin saisi (ou un dépôt connu) analysé par le serveur, en lecture seule. */
  private runDiscovery(root?: string): void {
    const context = this.scopeContext();
    if (!context || !scopeEditable(context)) return;
    if (root !== undefined) this.discoveryAction('inc-disc-known', { root });
    const typed = this.discoveryUi().root.trim();
    if (typed === '') {
      this.focus('[data-inc="disc.root"]');
      return;
    }
    void this.op(
      'inc-disc-run',
      async (api, projectId, incident) => {
        const result = await api.incidents.discoverScope(projectId, incident.id, typed);
        if (this.ui.incident?.id === incident.id) this.ui.discovery = withResult(this.discoveryUi(), result);
        return undefined;
      },
      {
        focus: '[data-action="inc-disc-apply"]:not([disabled]), [data-inc="disc.root"]',
      },
    );
  }

  /**
   * « Ajouter au périmètre » : les applications cochées enregistrées dans le périmètre (brouillon, périmètre
   * défini) ou, l'investigation commencée, demandées comme extensions (à décider) ; la découverte reste tracée
   * dans chaque application ajoutée (origine, racine analysée, preuves).
   */
  private applyDiscovery(): void {
    const ui = this.ui;
    const incident = ui.incident;
    const context = this.scopeContext();
    if (!incident || !context || !scopeEditable(context)) return;
    const plan = applyPlan(incident, this.discoveryUi());
    if (plan.kind === 'NONE') return;
    const t = this.host.state.t.inc;
    if (plan.kind === 'UPDATE') {
      void this.op(
        'inc-disc-apply',
        (api, projectId, current) =>
          api.incidents.update(projectId, current.id, current.revision, { scope: plan.scope }),
        {
          notice: () => t.done.applicationsAdded(plan.added.length),
          revision: true,
          after: () => {
            ui.discovery = reduceDiscovery(this.discoveryUi(), 'inc-disc-clear', {}) ?? ui.discovery;
            ui.validation = undefined;
          },
          focus: '[data-action="inc-scope-next"]',
        },
      );
      return;
    }
    void this.op(
      'inc-disc-apply',
      async (api, projectId, current) => {
        let next: Incident | undefined;
        for (const request of plan.requests)
          next = await api.incidents.requestExtension(projectId, current.id, request);
        return next;
      },
      {
        notice: () => t.done.extensionsRequested(plan.requests.length),
        after: () => {
          ui.discovery = reduceDiscovery(this.discoveryUi(), 'inc-disc-clear', {}) ?? ui.discovery;
        },
        focus: '[data-action="inc-ext-approve"], [data-inc="disc.root"]',
      },
    );
  }

  /**
   * « Étape suivante » : le brouillon vérifié dans la page, enregistré s'il a changé (révision lue ; 409 :
   * relu et dit), puis le périmètre enregistré vérifié par le serveur ; valide, « Environnement » s'ouvre.
   */
  private scopeNext(): void {
    const ui = this.ui;
    const context = this.scopeContext();
    const incident = ui.incident;
    if (!context || !incident) return;
    if (!scopeEditable(context)) {
      this.goToStage('environment');
      return;
    }
    const scopeUi = this.scopeUi();
    const draft = scopeDraftOf(incident, scopeUi);
    if (draft.invalid.length > 0) {
      ui.scope = reduceScope(scopeUi, 'inc-scope-invalid', { fields: draft.invalid.join(',') }) ?? scopeUi;
      this.host.paint();
      const first = draft.invalid[0] ?? '';
      if (first.startsWith('limit:')) this.focus(`[data-inc="scope.limit.${attr(first.slice(6))}"]`);
      else
        this.focus(`[data-action="inc-scope-toggle"][data-block="${attr(first.slice(4))}"][data-index=""]`);
      return;
    }
    const dirty = scopeDirty(incident, scopeUi);
    let valid = false;
    void this.op(
      'inc-scope-next',
      async (api, projectId, current) => {
        if (dirty) {
          // Enregistré : l'incident relu remplace l'affiché et le brouillon est vidé, même si la
          // vérification qui suit échoue (la page ne garde jamais une révision périmée).
          const saved = await api.incidents.update(projectId, current.id, current.revision, {
            scope: draft.scope,
          });
          if (this.route()?.incidentId !== current.id) return undefined;
          this.receive(saved);
          ui.scope = reduceScope(this.scopeUi(), 'inc-scope-saved', {}) ?? ui.scope;
          ui.notice = this.host.state.t.inc.done.scopeSaved;
        }
        const validation = await api.incidents.validateScope(projectId, current.id);
        ui.validation = validation;
        valid = validation.ok;
        return undefined;
      },
      {
        revision: dirty,
        after: () => {
          if (valid) {
            ui.validation = undefined;
            this.goToStage('environment');
          }
        },
        focus: '[data-action="inc-scope-next"]',
      },
    );
  }

  /** Ouvre l'onglet d'une étape, comme un clic dans la progression. */
  private goToStage(stage: string): void {
    this.workspace.click('ws-ux-stage', { dataset: { stage } } as unknown as HTMLElement);
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
      case 'inc-group': {
        const group = target.dataset.group;
        if (!isListGroup(group)) return true;
        ui.group = group;
        this.host.paint();
        this.focus(`[data-action="inc-group"][data-group="${group}"]`);
        return true;
      }
      case 'inc-list-reset':
        ui.group = 'ALL';
        ui.query = '';
        this.host.paint();
        this.focus('#inc-l-q');
        return true;
      case 'inc-export':
        this.exportCsv();
        return true;
      case 'inc-options-toggle': {
        // Le clic sur le résumé : le volet change ensuite ; son état est gardé pour les redessins.
        const details = target.parentElement as HTMLDetailsElement | null;
        if (ui.form && details) ui.form.optionsOpen = !details.open;
        return false;
      }
      case 'inc-att-remove': {
        const form = ui.form;
        const index = Number(target.dataset.index);
        if (!form || !Number.isInteger(index)) return true;
        form.attachments = form.attachments.filter((_, at) => at !== index);
        this.host.paint();
        if (
          !this.focus(
            `[data-action="inc-att-remove"][data-index="${String(Math.min(index, form.attachments.length - 1))}"]`,
          )
        )
          this.focus('#inc-f-files');
        return true;
      }
      case 'inc-scope-mode':
      case 'inc-scope-expand':
      case 'inc-scope-toggle':
      case 'inc-scope-remove':
      case 'inc-scope-reset':
        this.scopeClick(action, target);
        return true;
      case 'inc-scope-tree-retry': {
        const app = target.dataset.block;
        if (app)
          ui.scopeTrees = Object.fromEntries(Object.entries(ui.scopeTrees).filter(([key]) => key !== app));
        this.host.paint();
        this.focus(`[data-action="inc-scope-toggle"][data-block="${attr(app ?? '')}"][data-index=""]`);
        return true;
      }
      case 'inc-disc-run':
        this.runDiscovery();
        return true;
      case 'inc-disc-known':
        this.runDiscovery(target.dataset.root ?? '');
        return true;
      case 'inc-disc-apply':
        this.applyDiscovery();
        return true;
      case 'inc-disc-clear':
        this.discoveryAction('inc-disc-clear', {});
        this.host.paint();
        this.focus('[data-inc="disc.root"]');
        return true;
      case 'inc-disc-advanced':
        // Le résumé bascule le dépliage lui-même : l'état est gardé pour le prochain dessin, sans redessiner.
        this.discoveryAction('inc-disc-advanced', { open: target.dataset.open });
        return true;
      case 'inc-scope-next':
        this.scopeNext();
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
      case 'inc-disc-run':
        this.runDiscovery();
        return true;
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
    if (key === 'list.query') {
      ui.query = value;
      this.host.paint();
      return true;
    }
    if (key === 'files') return true;
    if (ui.form && (FORM_FIELDS as readonly string[]).includes(key)) {
      ui.form[key as TextField] = value;
      // Un champ signalé qui devient valide : son message disparaît tout de suite (un seul redessin).
      if (ui.invalid?.includes(key) && !incidentFormProblems(ui.form).includes(key as TextField)) {
        ui.invalid = ui.invalid.filter((entry) => entry !== key);
        this.host.paint();
      }
      return true;
    }
    if (ui.form && (key === 'severity' || key === 'scenario' || key === 'environmentId' || key === 'kind')) {
      (ui.form as unknown as Record<string, string>)[key] = value;
      return true;
    }
    if (key === 'disc.root') {
      this.discoveryAction('inc-disc-root', { value });
      return true;
    }
    if (key.startsWith('disc.layer.')) {
      this.discoveryAction('inc-disc-layer', { block: key.slice('disc.layer.'.length), value });
      return true;
    }
    if (key.startsWith('disc.app.')) {
      this.discoveryAction('inc-disc-toggle', { block: key.slice('disc.app.'.length) });
      return true;
    }
    if (key === 'scope.range') {
      this.scopeAction('inc-scope-depth', { value });
      // Pendant le glissement : la valeur dite et affichée, sans redessiner (le curseur reste saisi).
      const text = depthText(this.host.state.t.locale, Number(value));
      target.setAttribute('aria-valuetext', text);
      const shown = this.host.root.querySelector<HTMLElement>('.inc-sc-depth-v');
      if (shown) shown.textContent = text;
      return true;
    }
    if (key.startsWith('scope.limit.')) {
      this.scopeAction('inc-scope-limit', { field: key.slice('scope.limit.'.length), value });
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
    if (key === 'files' && 'files' in target) {
      void this.readFiles(target);
      return true;
    }
    this.input(target);
    if (
      key === 'ext.kind' ||
      key === 'severity' ||
      key === 'scope.range' ||
      key.startsWith('disc.layer.') ||
      key.startsWith('disc.app.')
    )
      this.host.paint();
    return true;
  }

  /** Échap referme la confirmation d'annulation ; le reste du clavier de l'espace va à son contrôleur. */
  keydown(event: KeyboardEvent): boolean {
    const element = event.target as HTMLElement | null;
    const action = element && 'dataset' in element ? element.dataset.action : undefined;
    if (action === 'inc-group' && this.host.state.route.view === 'incidents') {
      const next = rovingTarget(INCIDENT_LIST_GROUPS, this.ui.group, event.key);
      if (!next) return false;
      event.preventDefault();
      this.ui.group = next;
      this.host.paint();
      this.focus(`[data-action="inc-group"][data-group="${next}"]`);
      return true;
    }
    if (!this.route()) return false;
    if (action === 'inc-scope-mode') {
      const incident = this.ui.incident;
      if (!incident) return false;
      const next = rovingTarget(SCOPE_MODES_ORDER, this.scopeUi().mode ?? incident.scope.mode, event.key);
      if (!next) return false;
      event.preventDefault();
      this.scopeAction('inc-scope-mode', { mode: next });
      this.host.paint();
      this.focus(`[data-action="inc-scope-mode"][data-mode="${next}"]`);
      return true;
    }
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
    if (!this.route()) return;
    this.ensureScopeTrees();
    this.ensureKnownRepositories();
    this.workspace.beforePaint();
  }

  afterPaint(): void {
    this.announce();
    if (this.route()) this.workspace.afterPaint();
  }

  /**
   * Après le dessin et le retour du focus : un focus resté dans un corps masqué (panneau réduit) va au
   * bouton qui rouvre ce panneau ; un focus perdu dans l'espace revient sur l'onglet affiché.
   */
  afterFocus(): void {
    if (!this.route()) return;
    const active = this.host.root.activeElement as HTMLElement | null;
    if (!active || !hiddenElement(active)) return;
    const pane = active.closest<HTMLElement>('[data-ws-pane]')?.dataset.wsPane;
    if (pane && this.focus(`[data-ws-pane="${pane}"] .ws-pane-ops [data-op="restore"]`)) return;
    this.focus('[data-action="ws-ux-tab"][aria-selected="true"]');
  }

  /**
   * LA ZONE LIVE : un nœud permanent du Dashboard (`.inc-live`, hors de la partie redessinée) reprend le
   * texte du message affiché (`.inc-msg`) seulement quand ce texte CHANGE : un redessin au même texte
   * (suivi, sélection, disposition) ne dit rien, le premier dessin non plus (un message plus ancien que la
   * page). Le texte annoncé s'efface de la zone live après un moment (le message affiché reste).
   */
  private announce(): void {
    const root = this.host.root;
    const live = root.querySelector<HTMLElement>('.inc-live');
    if (!live) return;
    const text = root.querySelector<HTMLElement>('.inc-msg')?.textContent.trim() ?? '';
    const first = this.liveSource === undefined;
    if (text === this.liveSource) return;
    this.liveSource = text;
    clearTimeout(this.liveClear);
    this.liveClear = undefined;
    if (first) return;
    live.textContent = text;
    if (text)
      this.liveClear = setTimeout(() => {
        this.liveClear = undefined;
        live.textContent = '';
      }, LIVE_CLEAR_MS);
  }
}

/** Le temps pendant lequel la zone live garde le texte annoncé. */
const LIVE_CLEAR_MS = 8000;

/** Une valeur dans un sélecteur d'attribut entre guillemets. */
const attr = (value: string): string => value.replace(/["\\]/g, '\\$&');

/** Un élément dans une partie masquée (`hidden`), donc ni visible ni focalisable utilement. */
const hiddenElement = (element: HTMLElement): boolean =>
  typeof element.closest === 'function' && element.closest('[hidden]') !== null;
