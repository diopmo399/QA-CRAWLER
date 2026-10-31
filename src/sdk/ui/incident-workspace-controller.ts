import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import { EXECUTION_TARGETS, type CodeLayer, type Incident } from '../core/incident-contracts.js';
import { can } from './dashboard-access.js';
import type { IncidentsUi } from './dashboard-incidents.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';
import { reduceCode } from './incident-code.js';
import { diagnosisBusyKey, planInputOf, reduceDiagnosis } from './incident-diagnosis.js';
import { reduceFrontendTrace } from './incident-frontend-trace.js';
import {
  graphKeyAction,
  graphLayout2,
  graphViewBox,
  reduceGraph,
  visibleGraph,
  type GraphLayout2,
  type GraphUi,
} from './incident-graph.js';
import { fileId, SELECTION_KINDS, selectionKey, sourceOf, type SelectionKind } from './incident-links.js';
import type * as DemoData from './incident-demo.js';
import type { WorkspaceContext } from './incident-parts.js';
import { reduceTimeline } from './incident-timeline.js';
import {
  environmentDirty,
  executionOf,
  reduceUx,
  rovingTarget,
  UX_FIELDS,
  type UxField,
} from './incident-ux.js';
import {
  codeCtxOf,
  demoUnavailable,
  emptyWorkspaceUi,
  isWorkspaceTab,
  LAYER_TABS,
  neededSources,
  screenshotOf,
  shotKey,
  STAGE_TABS,
  tabOfLayer,
  tabsOf,
  workspaceCtx,
  workspaceText,
  type LoadState,
  type WorkspaceTab,
  type WorkspaceUi,
} from './incident-workspace.js';

/**
 * LE CONTRÔLEUR DE L'ESPACE D'INVESTIGATION. Il tient l'état de la page (`WorkspaceUi` : sélection
 * partagée, onglet, état de chaque vue), traite les `data-action` des modules (`ws-…`), le clavier
 * (onglets et cibles à tabindex itinérant, cadre du graphe, nœuds, Échap), le glisser et la molette du
 * graphe, et lit ce que la vue affichée demande : l'arborescence du périmètre (une fois par incident), les
 * fichiers (à la demande, petit cache, relus quand la révision change), les captures d'écran, le rapport
 * et les capacités de l'environnement. Pendant une reproduction ou une expérience en cours, il relit
 * l'incident toutes les 1,5 s et ne redessine que si la révision a changé ; le suivi s'arrête quand on
 * quitte la page. En démonstration, rien n'est demandé au serveur et aucune action ne modifie l'incident.
 */

type IncidentRoute = Extract<DashboardRoute, { view: 'incident' }>;

/** Une relecture par seconde et demie pendant une reproduction ou une expérience. */
export const INCIDENT_POLL_MS = 1500;

/** Le délai entre le dessin et l'annonce d'un message nouveau (la zone live existe déjà). */
const LIVE_DELAY_MS = 120;

/** Les fichiers gardés en mémoire au plus (les plus anciens sont oubliés). */
const MAX_SOURCES = 24;

export interface OpOptions {
  notice?: (incident: Incident) => string | undefined;
  focus?: string;
  /** Après un succès. */
  after?: () => void;
  /** Avant le dernier dessin, succès ou échec. */
  settle?: () => void;
  /** Une modification sur la révision lue : un 409 veut dire que l'incident a changé entre-temps. */
  revision?: boolean;
  /** L'erreur est dite à cet endroit plutôt que dans la zone des messages. */
  onError?: (message: string, details: string[]) => void;
}

export type OpRun = (
  api: QaCrawlerClient,
  projectId: string,
  incident: Incident,
) => Promise<Incident | undefined>;

export interface WorkspaceHost {
  readonly state: DashboardState;
  readonly root: ShadowRoot;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  /** Une opération du serveur sur l'incident ouvert (une à la fois ; 409 relu). */
  op(busy: string, run: OpRun, options?: OpOptions): Promise<void>;
  /** L'incident relu remplace l'affiché. */
  receive(incident: Incident): void;
  focus(selector: string): boolean;
}

/** Le module de démonstration, chargé à la demande (il pèse ses données). */
export type DemoModule = typeof DemoData;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const denied = (error: unknown): boolean => error instanceof QaCrawlerError && error.status === 403;
const loadStateOf = (error: unknown): LoadState => (denied(error) ? 'denied' : { error: message(error) });

/** Une valeur d'attribut sûre dans un sélecteur `[attr="…"]`. */
export const attr = (value: string): string => value.replace(/["\\]/g, '\\$&');

/** Les données d'un élément (`data-*`), en objet simple. */
const datasetOf = (element: HTMLElement): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(element.dataset));

/** Un enregistrement sans les clés données. */
const without = <T>(record: Record<string, T>, drop: (key: string, value: T) => boolean): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([key, value]) => !drop(key, value)));

const isSelectionKind = (value: string | undefined): value is SelectionKind =>
  (SELECTION_KINDS as readonly string[]).includes(value ?? '');
const isUxField = (value: string | undefined): value is UxField =>
  (UX_FIELDS as readonly string[]).includes(value ?? '');

/** Les zones dont le défilement survit au redessin (clé : sélecteur + rang). */
const SCROLLERS = [
  '.ws-ux-aside',
  '.ws-ux-graph',
  '.ws-graph-canvas',
  '.ws-ux-tabs',
  '.ws-ux-stepper ol',
  '[data-ws-zone] .ws-code-scroll',
  '[data-ws-zone] .tw',
  '.ws-code-layer-tree',
];

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  canvas: HTMLElement;
  svg: SVGSVGElement | null;
  w: number;
  h: number;
  base: GraphUi;
  layout: GraphLayout2;
  next?: GraphUi;
  moved: boolean;
}

export class WorkspaceController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private demoModule: DemoModule | undefined;
  private drag: Drag | undefined;
  private suppressClick = false;
  private wheelDelta = 0;
  private wheelFrame: number | undefined;
  private scrolls = new Map<string, { top: number; left: number }>();
  private opened = new Map<string, boolean>();
  /** Le fichier et la ligne visés au dernier dessin, par zone : un changement fait défiler jusqu'à la ligne. */
  private codeTargets = new Map<string, string>();
  /** Le texte de la zone des messages au dernier dessin, et l'annonce qui attend son tour. */
  private liveText: string | undefined;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: WorkspaceHost) {}

  private get ui(): IncidentsUi {
    const inc = this.host.state.inc;
    if (!inc) throw new Error('incidents state missing');
    return inc;
  }

  get ws(): WorkspaceUi {
    return this.ui.ws;
  }

  private set ws(value: WorkspaceUi) {
    this.ui.ws = value;
  }

  private route(): IncidentRoute | undefined {
    const route = this.host.state.route;
    return route.view === 'incident' ? route : undefined;
  }

  private tab(): WorkspaceTab {
    return this.route()?.tab ?? 'overview';
  }

  private context(): { ctx: WorkspaceContext; codeCtx: WorkspaceContext } | undefined {
    const incident = this.ui.incident;
    const route = this.route();
    if (!incident || incident.id !== route?.incidentId) return undefined;
    const state = this.host.state;
    const ctx = workspaceCtx(incident, this.ws, state.t.locale, (right) => can(state, right));
    return { ctx, codeCtx: codeCtxOf(ctx, this.ws) };
  }

  private lang(): 'fr' | 'en' {
    return this.host.state.t.locale;
  }

  // ── Incident et démonstration ──────────────────────────────────────────────────────────────

  /** Le module de démonstration, pour un incident `demo` (chargé avant son premier dessin). */
  async demo(): Promise<DemoModule> {
    this.demoModule ??= await import('./incident-demo.js');
    return this.demoModule;
  }

  /** L'état de cet incident : un autre incident (ou la démonstration) repart de zéro. */
  adopt(incident: Incident, demo: boolean): void {
    const ws = this.ws;
    if (ws.incidentId !== incident.id || ws.demo !== demo) {
      this.ws = emptyWorkspaceUi(incident.id, demo);
      this.codeTargets.clear();
      return;
    }
    const before = this.ui.incident;
    // Le rapport est calculé sur l'incident : une nouvelle révision le rend périmé.
    if (!demo && before && before.revision !== incident.revision) {
      ws.report = undefined;
      ws.reportState = {};
      // Une vérification terminée pendant le suivi est dite (zone des messages), une seule fois.
      const finished = incident.investigation.experiments.find(
        (experiment) =>
          experiment.status !== 'RUNNING' &&
          before.investigation.experiments.some(
            (previous) => previous.id === experiment.id && previous.status === 'RUNNING',
          ),
      );
      if (finished) {
        const t = this.host.state.t.inc;
        this.ui.notice = t.done.experimentOver(t.experimentStatus[finished.status] ?? finished.status);
      }
    }
  }

  /**
   * Ce qui vient de changer est dit par la zone des messages du Dashboard (`.inc-live`), et seulement
   * cela : le texte reste affiché aux redessins suivants sans être répété.
   */
  private announce(text: string): void {
    this.ui.notice = text;
  }

  /** En démonstration, une action qui modifierait l'incident ou interrogerait le serveur est refusée. */
  private refuseInDemo(): boolean {
    if (!this.ws.demo) return false;
    this.ui.notice = demoUnavailable(this.lang());
    this.host.paint();
    return true;
  }

  // ── Lectures ───────────────────────────────────────────────────────────────────────────────

  /** Lit ce que la vue affichée demande et qui manque encore (sans attendre : chaque réponse redessine). */
  ensure(): void {
    const context = this.context();
    if (!context) return;
    const { ctx, codeCtx } = context;
    const ws = this.ws;
    const tab = this.tab();
    const codeNeeded = LAYER_TABS[tab] !== undefined || sourceOf(ctx.links, ctx.selection) !== undefined;
    if (codeNeeded && codeCtx.can('RUN')) {
      if (!ws.tree && ws.treeState === undefined) this.loadTree();
      for (const location of neededSources(codeCtx, ws, tab))
        this.loadSource(location.applicationId, location.file);
    }
    const shot = screenshotOf(ctx.incident, ws.selection);
    if (shot && !ws.demo) this.loadShot(shot.reproduction, shot.file);
    if (tab === 'report' && !ws.report && !ws.reportState.loading && !ws.reportState.error) this.loadReport();
    if (tab === 'environment' && !ws.demo && !ws.capabilities && ws.capabilitiesState === undefined)
      this.loadCapabilities();
  }

  /** Une réponse arrivée : la vue est complétée puis redessinée (si l'état est toujours celui de la page). */
  private arrived(ws: WorkspaceUi): void {
    if (this.ws !== ws) return;
    this.ensure();
    this.host.paint();
  }

  private target(): { api: QaCrawlerClient; route: IncidentRoute } | undefined {
    const api = this.host.api();
    const route = this.route();
    return api && route ? { api, route } : undefined;
  }

  private loadTree(): void {
    const ws = this.ws;
    if (ws.demo) {
      if (this.demoModule) ws.tree = this.demoModule.demoSourceTree();
      return;
    }
    const target = this.target();
    if (!target) return;
    ws.treeState = 'loading';
    target.api.incidents.sourceTree(target.route.projectId, target.route.incidentId).then(
      (tree) => {
        ws.tree = tree;
        ws.treeState = undefined;
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.treeState = loadStateOf(error);
        const text = workspaceText(this.lang());
        if (this.ws === ws)
          this.announce(ws.treeState === 'denied' ? text.fileDenied : text.treeFailed(message(error)));
        this.arrived(ws);
      },
    );
  }

  private loadSource(applicationId: string, file: string): void {
    const ws = this.ws;
    const incident = this.ui.incident;
    if (!incident) return;
    const key = fileId(applicationId, file);
    const entry = ws.sources[key];
    const revision = incident.revision;
    if (entry && (entry.state === 'loading' || entry.revision === revision)) return;
    if (ws.demo) {
      const view = this.demoModule?.demoSource(applicationId, file);
      ws.sources[key] = view
        ? { view, revision }
        : { revision, state: { error: workspaceText(this.lang()).notInDemo } };
      return;
    }
    const target = this.target();
    if (!target) return;
    // Le fichier déjà lu reste affiché pendant sa relecture (révision nouvelle : lignes signalées recalculées).
    // Le plus récent en dernier ; au-delà de MAX_SOURCES, les plus anciens sont oubliés.
    const kept = Object.entries(ws.sources).filter(([other]) => other !== key);
    ws.sources = Object.fromEntries([
      ...kept.slice(Math.max(0, kept.length - MAX_SOURCES + 1)),
      [key, { ...(entry?.view ? { view: entry.view } : {}), revision, state: 'loading' as const }],
    ]);
    target.api.incidents.source(target.route.projectId, target.route.incidentId, applicationId, file).then(
      (view) => {
        ws.sources[key] = { view, revision };
        this.arrived(ws);
      },
      (error: unknown) => {
        const state = loadStateOf(error);
        ws.sources[key] = { ...(entry?.view ? { view: entry.view } : {}), revision, state };
        if (state === 'denied') ws.treeState = 'denied';
        const text = workspaceText(this.lang());
        if (this.ws === ws)
          this.announce(state === 'denied' ? text.fileDenied : text.fileFailed(file, message(error)));
        this.arrived(ws);
      },
    );
  }

  private loadShot(reproduction: string, file: string): void {
    const ws = this.ws;
    const key = shotKey(reproduction, file);
    if (ws.shots[key]) return;
    const target = this.target();
    if (!target) return;
    ws.shots[key] = { state: 'loading' };
    target.api.incidents.screenshot(target.route.projectId, target.route.incidentId, reproduction, file).then(
      (shot) => {
        ws.shots[key] = { dataUrl: shot.dataUrl };
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.shots[key] = { state: loadStateOf(error) };
        this.arrived(ws);
      },
    );
  }

  private loadReport(): void {
    const ws = this.ws;
    if (ws.demo) {
      if (this.demoModule) ws.report = this.demoModule.demoReport(this.lang());
      return;
    }
    const target = this.target();
    if (!target) return;
    ws.reportState = { loading: true };
    target.api.incidents.report(target.route.projectId, target.route.incidentId).then(
      (report) => {
        ws.report = report;
        ws.reportState = {};
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.reportState = { error: message(error) };
        this.arrived(ws);
      },
    );
  }

  private loadCapabilities(): void {
    const ws = this.ws;
    const target = this.target();
    if (!target) return;
    ws.capabilitiesState = 'loading';
    target.api.incidents.capabilities(target.route.projectId, target.route.incidentId).then(
      (capabilities) => {
        ws.capabilities = capabilities;
        ws.capabilitiesState = undefined;
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.capabilitiesState = loadStateOf(error);
        this.arrived(ws);
      },
    );
  }

  // ── Suivi ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Relit l'incident toutes les 1,5 s tant qu'il avance sur le serveur (reproduction, expérience en
   * cours). Une révision inchangée ne redessine rien : zoom, défilement, fichiers ouverts et focus restent.
   */
  poll(): void {
    if (this.timer || this.ws.demo) return;
    const target = this.target();
    if (!target) return;
    const { api, route } = target;
    const { projectId, incidentId } = route;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.route()?.incidentId !== incidentId) return;
      // Une opération (ou un glisser) en cours : le suivi attend le tour suivant.
      if (this.ui.busy !== undefined || this.drag) {
        this.poll();
        return;
      }
      api.incidents.get(projectId, incidentId).then(
        (incident) => {
          if (this.route()?.incidentId !== incidentId) return;
          const current = this.ui.incident;
          if (current?.id === incident.id && current.revision === incident.revision) {
            this.poll();
            return;
          }
          this.host.receive(incident);
          this.ensure();
          this.host.paint();
        },
        () => {
          // Une lecture manquée n'arrête pas le suivi : la suivante réessaie.
          this.poll();
        },
      );
    }, INCIDENT_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.liveText = undefined;
  }

  get polling(): boolean {
    return this.timer !== undefined;
  }

  // ── Navigation dans l'espace ───────────────────────────────────────────────────────────────

  selectTab(tab: WorkspaceTab, focus = true): void {
    const route = this.route();
    if (!route) return;
    this.host.state.route = { ...route, tab };
    this.ensure();
    this.host.paint();
    if (focus) this.host.focus(`#ws-ux-tab-${tab}`);
  }

  /** La sélection partagée : un second clic sur l'élément sélectionné la vide. */
  select(kind: SelectionKind, id: string): void {
    const ws = this.ws;
    const current = ws.selection;
    ws.selection = current?.kind === kind && current.id === id ? undefined : { kind, id };
    const context = this.context();
    if (context && ws.selection) {
      const source = sourceOf(context.ctx.links, ws.selection);
      // L'endroit du code de la sélection est ouvert dans l'onglet de sa couche.
      if (source)
        ws.code =
          reduceCode(ws.code, 'ws-code', {
            app: source.applicationId,
            file: source.file,
            line: String(source.line),
            sel: selectionKey(ws.selection),
          }) ?? ws.code;
    }
    this.ensure();
    this.host.paint();
  }

  clearSelection(): boolean {
    if (!this.ws.selection) return false;
    this.ws.selection = undefined;
    this.ensure();
    this.host.paint();
    return true;
  }

  /** La couche d'une application (arborescence, périmètre, index de code). */
  private layerOf(applicationId: string): CodeLayer | undefined {
    const ws = this.ws;
    const incident = this.ui.incident;
    return (
      ws.tree?.applications.find((entry) => entry.applicationId === applicationId)?.layer ??
      incident?.scope.applications.find((entry) => entry.id === applicationId)?.layer ??
      incident?.investigation.code?.applications.find((entry) => entry.id === applicationId)?.layer
    );
  }

  /** Un lien vers le code : le fichier est ouvert dans l'explorateur, dans l'onglet de sa couche. */
  private openCode(action: string, dataset: Record<string, string | undefined>): void {
    const ws = this.ws;
    const sel = dataset.sel ?? (ws.selection ? selectionKey(ws.selection) : '');
    ws.code = reduceCode(ws.code, action, { ...dataset, sel }) ?? ws.code;
    const applicationId = dataset.app ?? ws.code.open[0]?.applicationId;
    const layer =
      (dataset.layer as CodeLayer | undefined) ?? (applicationId ? this.layerOf(applicationId) : undefined);
    const tab = layer ? tabOfLayer(layer) : undefined;
    if (tab && tab !== this.tab()) {
      this.selectTab(tab, false);
      if (!this.host.focus('.ws-zone-main .ws-code-scroll')) this.host.focus(`#ws-ux-tab-${tab}`);
      return;
    }
    this.ensure();
    this.host.paint();
  }

  // ── Opérations ─────────────────────────────────────────────────────────────────────────────

  /** Une opération du diagnostic : son bouton est occupé, son erreur dite à son emplacement. */
  private dxOp(
    action: string,
    ref: string | undefined,
    slot: string,
    run: OpRun,
    options: OpOptions = {},
  ): void {
    if (this.refuseInDemo() || this.ui.busy !== undefined) return;
    const ws = this.ws;
    const { [slot]: _cleared, ...errors } = ws.dx.errors;
    ws.dx = { ...ws.dx, busy: diagnosisBusyKey(action, ref), errors };
    void this.host.op(action, run, {
      ...options,
      onError: (text) => {
        this.ws.dx = { ...this.ws.dx, errors: { ...this.ws.dx.errors, [slot]: text } };
      },
      settle: () => {
        const { busy: _done, ...rest } = this.ws.dx;
        this.ws.dx = rest;
        options.settle?.();
        this.ensure();
      },
    });
  }

  private saveEnvironment(): void {
    const incident = this.ui.incident;
    if (!incident || this.refuseInDemo() || this.ui.busy !== undefined || !can(this.host.state, 'RUN'))
      return;
    const ws = this.ws;
    ws.ux = reduceUx(ws.ux, 'ws-ux-target-save', {}) ?? ws.ux;
    const { execution, invalid } = executionOf(incident, ws.ux);
    if (invalid.length > 0) {
      ws.ux = reduceUx(ws.ux, 'ws-ux-invalid', { fields: invalid.join(',') }) ?? ws.ux;
      this.host.paint();
      this.host.focus(`[data-ws-field="${attr(invalid[0] ?? '')}"]`);
      return;
    }
    const t = this.host.state.t.inc;
    void this.host.op(
      'ws-ux-target-save',
      (api, projectId, current) =>
        api.incidents.update(projectId, current.id, current.revision, { execution }),
      {
        revision: true,
        notice: () => t.done.environmentSaved,
        after: () => {
          this.ws.ux = reduceUx(this.ws.ux, 'ws-ux-saved', {}) ?? this.ws.ux;
          // Les capacités sont relues pour la cible enregistrée.
          this.ws.capabilities = undefined;
          this.ws.capabilitiesState = undefined;
        },
        onError: (text) => {
          this.ws.ux = reduceUx(this.ws.ux, 'ws-ux-error', { message: text }) ?? this.ws.ux;
        },
        settle: () => {
          this.ensure();
        },
        focus: '[data-action="ws-ux-target"][aria-checked="true"]',
      },
    );
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
    if (this.refuseInDemo() || this.ui.busy !== undefined) return;
    const t = this.host.state.t.inc;
    const ws = this.ws;
    ws.reportState = { ...ws.reportState, exporting: format };
    this.dxOp(
      'ws-dx-export',
      undefined,
      'export',
      async (api, projectId, incident) => {
        const file = `incident-${incident.id}.${format === 'json' ? 'json' : 'md'}`;
        if (format === 'json') {
          const report = await api.incidents.report(projectId, incident.id);
          ws.report = report;
          this.download(file, `${JSON.stringify(report, null, 2)}\n`, 'application/json;charset=utf-8');
        } else {
          const markdown = await api.incidents.reportMarkdown(projectId, incident.id);
          this.download(file, markdown, 'text/markdown;charset=utf-8');
        }
        this.ui.notice = t.done.exported(file);
        return undefined;
      },
      {
        settle: () => {
          const { exporting: _done, ...rest } = this.ws.reportState;
          this.ws.reportState = rest;
        },
      },
    );
  }

  private experimentNotice(incident: Incident, experimentId: string): string | undefined {
    const t = this.host.state.t.inc;
    const done = incident.investigation.experiments.find((entry) => entry.id === experimentId);
    return done ? t.done.experimentOver(t.experimentStatus[done.status] ?? done.status) : undefined;
  }

  /** Les opérations du diagnostic (`DIAGNOSIS_OPERATIONS`) : toujours par le serveur. */
  private diagnosisOperation(action: string, target: HTMLElement): void {
    const ui = this.ui;
    const ws = this.ws;
    const t = this.host.state.t.inc;
    const incident = ui.incident;
    if (!incident) return;
    const data = target.dataset;
    switch (action) {
      case 'ws-dx-analyze':
        this.dxOp(
          action,
          undefined,
          'analyze',
          (api, projectId, current) => api.incidents.analyze(projectId, current.id),
          {
            notice: (next) => t.done.analyzed(next.investigation.hypotheses.length),
            focus: '[data-action="ws-dx-analyze"]',
          },
        );
        return;
      case 'ws-dx-plan': {
        const hypothesis = incident.investigation.hypotheses.find((entry) => entry.id === data.hypothesis);
        const index = data.index ?? '0';
        const verification = hypothesis?.verifications[Number(index)];
        if (!hypothesis || !verification) return;
        this.dxOp(
          action,
          `${hypothesis.id}#${index}`,
          `hypothesis:${hypothesis.id}`,
          (api, projectId, current) =>
            api.incidents.planExperiment(projectId, current.id, {
              kind: verification.kind,
              params: verification.params,
              hypothesisId: hypothesis.id,
            }),
          { notice: () => t.done.planned },
        );
        return;
      }
      case 'ws-dx-run': {
        const experiment = incident.investigation.experiments.find((entry) => entry.id === data.experiment);
        if (!experiment) return;
        // Une expérience à effets de bord s'approuve dans la page, en connaissance de cause.
        const approving = reduceDiagnosis(ws.dx, action, data);
        if (approving) {
          if (this.refuseInDemo()) return;
          ws.dx = approving;
          this.host.paint();
          if (!this.host.focus('[data-action="ws-dx-approve"]'))
            this.host.focus('[data-action="ws-dx-approve-cancel"]');
          return;
        }
        this.dxOp(
          action,
          experiment.id,
          `experiment:${experiment.id}`,
          (api, projectId, current) => api.incidents.runExperiment(projectId, current.id, experiment.id),
          {
            notice: (next) => this.experimentNotice(next, experiment.id),
          },
        );
        return;
      }
      case 'ws-dx-approve': {
        const id = data.experiment ?? '';
        if (ws.dx.approving !== id || !can(this.host.state, 'RUN_WRITES')) return;
        this.dxOp(
          action,
          id,
          `experiment:${id}`,
          (api, projectId, current) =>
            api.incidents.runExperiment(projectId, current.id, id, { approve: true }),
          {
            notice: (next) => this.experimentNotice(next, id),
            after: () => {
              this.ws.dx = reduceDiagnosis(this.ws.dx, 'ws-dx-approve-cancel', {}) ?? this.ws.dx;
            },
            focus: '[data-action="ws-ux-tab"][aria-selected="true"]',
          },
        );
        return;
      }
      case 'ws-dx-diagnose':
        this.dxOp(
          action,
          undefined,
          'diagnose',
          (api, projectId, current) => api.incidents.diagnose(projectId, current.id),
          {
            notice: (next) => {
              const status = next.investigation.diagnosis?.status;
              return status ? t.done.diagnosed(t.diagnosisStatus[status] ?? status) : undefined;
            },
            focus: '[data-action="ws-dx-diagnose"]',
          },
        );
        return;
      case 'ws-dx-report':
        if (this.refuseInDemo()) return;
        ws.report = undefined;
        ws.reportState = {};
        this.loadReport();
        this.host.paint();
        return;
      case 'ws-dx-export':
        this.exportReport(data.format === 'markdown' ? 'markdown' : 'json');
        return;
      case 'ws-dx-regression': {
        const op = data.op;
        const call =
          op === 'propose'
            ? {
                run: (api: QaCrawlerClient, p: string, id: string) => api.incidents.proposeRegression(p, id),
                notice: t.done.regressionProposed,
              }
            : op === 'run'
              ? {
                  run: (api: QaCrawlerClient, p: string, id: string) => api.incidents.runRegression(p, id),
                  notice: t.done.regressionRun,
                }
              : op === 'accept'
                ? {
                    run: (api: QaCrawlerClient, p: string, id: string) =>
                      api.incidents.acceptRegression(p, id),
                    notice: t.done.regressionAccepted,
                  }
                : op === 'reject'
                  ? {
                      run: (api: QaCrawlerClient, p: string, id: string) =>
                        api.incidents.rejectRegression(p, id),
                      notice: t.done.regressionRejected,
                    }
                  : undefined;
        if (!call) return;
        this.dxOp(
          action,
          op,
          'regression',
          (api, projectId, current) => call.run(api, projectId, current.id),
          {
            notice: () => call.notice,
            focus: `[data-action="ws-dx-regression"][data-op="${attr(op ?? '')}"]`,
          },
        );
        return;
      }
    }
  }

  // ── Événements ─────────────────────────────────────────────────────────────────────────────

  click(action: string, target: HTMLElement): boolean {
    if (!action.startsWith('ws-')) return false;
    if (this.suppressClick) return true;
    const ws = this.ws;
    const data = datasetOf(target);
    switch (action) {
      case 'ws-select': {
        const kind = data.kind;
        const ref = data.ref;
        if (isSelectionKind(kind) && ref) this.select(kind, ref);
        return true;
      }
      case 'ws-select-clear':
        this.clearSelection();
        this.host.focus('#ws-ux-panel');
        return true;
      case 'ws-ux-tab':
        if (isWorkspaceTab(data.tab)) this.selectTab(data.tab);
        return true;
      case 'ws-ux-stage': {
        const stage = data.stage as keyof typeof STAGE_TABS | undefined;
        const tab = stage ? STAGE_TABS[stage] : undefined;
        if (tab) this.selectTab(tab);
        return true;
      }
      case 'ws-ux-target-save':
        this.saveEnvironment();
        return true;
      case 'ws-code':
      case 'ws-code-open':
      case 'ws-code-goto':
        this.openCode(action, data);
        return true;
      case 'ws-code-reload':
      case 'ws-shot-reload': {
        if (this.refuseInDemo()) return true;
        const failed = (_key: string, entry: { state?: LoadState }): boolean =>
          entry.state !== undefined && entry.state !== 'loading';
        ws.sources = without(ws.sources, failed);
        ws.shots = without(ws.shots, failed);
        if (ws.treeState && typeof ws.treeState === 'object') ws.treeState = undefined;
        this.ensure();
        this.host.paint();
        return true;
      }
      case 'ws-code-search-clear':
        ws.code = reduceCode(ws.code, action, data) ?? ws.code;
        this.host.paint();
        this.host.focus('[data-ws-field="code-search"]');
        return true;
    }
    if (
      (
        [
          'ws-dx-analyze',
          'ws-dx-plan',
          'ws-dx-run',
          'ws-dx-approve',
          'ws-dx-diagnose',
          'ws-dx-report',
          'ws-dx-export',
          'ws-dx-regression',
        ] as string[]
      ).includes(action)
    ) {
      this.diagnosisOperation(action, target);
      return true;
    }
    const next =
      reduceGraph(ws.graph, action, data) ??
      reduceTimeline(ws.timeline, action, data) ??
      reduceFrontendTrace(ws.trace, action, data) ??
      reduceCode(ws.code, action, data) ??
      reduceUx(ws.ux, action, data) ??
      reduceDiagnosis(ws.dx, action, data);
    if (next === undefined) return true;
    if (action.startsWith('ws-graph-')) ws.graph = next as WorkspaceUi['graph'];
    else if (action.startsWith('ws-timeline-')) ws.timeline = next as WorkspaceUi['timeline'];
    else if (action.startsWith('ws-frontend-trace-')) ws.trace = next as WorkspaceUi['trace'];
    else if (action.startsWith('ws-code-')) ws.code = next as WorkspaceUi['code'];
    else if (action.startsWith('ws-ux-')) ws.ux = next as WorkspaceUi['ux'];
    else if (action.startsWith('ws-dx-')) ws.dx = next as WorkspaceUi['dx'];
    this.ensure();
    this.host.paint();
    if (action === 'ws-dx-approve-cancel' && data.experiment)
      this.host.focus(`[data-action="ws-dx-run"][data-experiment="${attr(data.experiment)}"]`);
    return true;
  }

  /** L'envoi du formulaire « Planifier une expérience ». */
  submit(form: HTMLFormElement): boolean {
    if (form.dataset.action !== 'ws-dx-plan-submit') return false;
    const ws = this.ws;
    const problems = reduceDiagnosis(ws.dx, 'ws-dx-plan-submit', {});
    if (problems) {
      ws.dx = problems;
      this.host.paint();
      const first = problems.planProblems[0];
      if (first) this.host.focus(`[data-ws-field="dx.param.key"][data-index="${String(first.index)}"]`);
      return true;
    }
    const planned = planInputOf(ws.dx.plan);
    if (!planned.ok) return true;
    const t = this.host.state.t.inc;
    this.dxOp(
      'ws-dx-plan-submit',
      undefined,
      'plan',
      (api, projectId, incident) => api.incidents.planExperiment(projectId, incident.id, planned.input),
      {
        notice: () => t.done.planned,
        after: () => {
          this.ws.dx = reduceDiagnosis(this.ws.dx, 'ws-dx-plan-reset', {}) ?? this.ws.dx;
        },
        focus: '[data-ws-field="dx.kind"]',
      },
    );
    return true;
  }

  /** Une saisie : gardée dans l'état ; redessinée seulement quand l'affichage en dépend. */
  input(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
    const field = target.dataset.wsField;
    if (!field) return false;
    const ws = this.ws;
    const value = target.value;
    if (field === 'code-search') {
      ws.code = reduceCode(ws.code, 'ws-code-search', { value }) ?? ws.code;
      this.host.paint();
      return true;
    }
    if (field.startsWith('dx.')) {
      ws.dx = reduceDiagnosis(ws.dx, 'ws-dx-field', { field, index: target.dataset.index, value }) ?? ws.dx;
      return true;
    }
    if (isUxField(field)) {
      const incident = this.ui.incident;
      const before = incident ? environmentDirty(incident, ws.ux) : false;
      const invalid = ws.ux.invalid.length;
      ws.ux = reduceUx(ws.ux, 'ws-ux-field', { field, value }) ?? ws.ux;
      const after = incident ? environmentDirty(incident, ws.ux) : false;
      if (before !== after || invalid !== ws.ux.invalid.length) this.host.paint();
      return true;
    }
    return true;
  }

  /** Un choix (case à cocher, liste, champ numérique validé). */
  change(target: HTMLInputElement | HTMLSelectElement): boolean {
    const action = target.dataset.action;
    const ws = this.ws;
    if (action === 'ws-timeline-related' || action === 'ws-timeline-req-errors') {
      ws.timeline = reduceTimeline(ws.timeline, action, {}) ?? ws.timeline;
      this.host.paint();
      return true;
    }
    if (action === 'ws-timeline-from' || action === 'ws-timeline-to') {
      ws.timeline = reduceTimeline(ws.timeline, action, { value: target.value }) ?? ws.timeline;
      this.host.paint();
      return true;
    }
    const field = target.dataset.wsField;
    if (field === 'dx.kind' || field === 'dx.hypothesisId') {
      ws.dx = reduceDiagnosis(ws.dx, 'ws-dx-field', { field, value: target.value }) ?? ws.dx;
      this.host.paint();
      return true;
    }
    if (field) return this.input(target);
    return false;
  }

  /** Le clavier : onglets et cibles itinérants, cadre du graphe, nœuds, Entrée sur un bouton non natif, Échap. */
  keydown(event: KeyboardEvent): boolean {
    if (!this.route()) return false;
    const target = event.target as HTMLElement | null;
    const ws = this.ws;
    if (event.key === 'Escape') {
      if (ws.dx.approving) {
        const id = ws.dx.approving;
        ws.dx = reduceDiagnosis(ws.dx, 'ws-dx-approve-cancel', {}) ?? ws.dx;
        this.host.paint();
        this.host.focus(`[data-action="ws-dx-run"][data-experiment="${attr(id)}"]`);
        return true;
      }
      return this.clearSelection();
    }
    if (!target) return false;
    const action = target.dataset.action;
    if (action === 'ws-ux-tab') {
      const context = this.context();
      const keys = context ? tabsOf(context.ctx).map((tab) => tab.key) : [];
      const next = rovingTarget(keys, this.tab(), event.key);
      if (!next || !isWorkspaceTab(next)) return false;
      event.preventDefault();
      this.selectTab(next);
      return true;
    }
    if (action === 'ws-ux-target') {
      const incident = this.ui.incident;
      if (!incident) return false;
      const next = rovingTarget(EXECUTION_TARGETS, ws.ux.target ?? incident.execution.target, event.key);
      if (!next) return false;
      event.preventDefault();
      ws.ux = reduceUx(ws.ux, 'ws-ux-target', { target: next }) ?? ws.ux;
      this.host.paint();
      this.host.focus(`[data-action="ws-ux-target"][data-target="${next}"]`);
      return true;
    }
    if (target.dataset.wsGraph === 'canvas') {
      const key = graphKeyAction(event.key);
      if (!key) return false;
      event.preventDefault();
      ws.graph =
        reduceGraph(ws.graph, key.action, { ...key.dataset, w: target.dataset.w, h: target.dataset.h }) ??
        ws.graph;
      this.host.paint();
      return true;
    }
    if (action === 'ws-select' && target.dataset.kind === 'node' && target.closest('[data-ws-graph]')) {
      const moved = this.moveInGraph(target, event.key);
      if (moved) {
        event.preventDefault();
        return true;
      }
    }
    // Un élément focalisable qui n'est pas un bouton natif (nœud, relation du graphe) : Entrée, Espace.
    if (
      action &&
      (event.key === 'Enter' || event.key === ' ') &&
      target.tagName !== 'BUTTON' &&
      target.getAttribute('role') === 'button'
    ) {
      event.preventDefault();
      return this.click(action, target);
    }
    return false;
  }

  /** Les flèches sur un nœud du graphe : vers ses voisins (→ suivant, ← précédent, ↓ ↑ dans l'ordre). */
  private moveInGraph(node: HTMLElement, key: string): boolean {
    const graph = this.ui.incident?.investigation.graph;
    const id = node.dataset.ref;
    if (!graph || !id) return false;
    const canvas = node.closest('[data-ws-graph]');
    if (!canvas) return false;
    const nodes = [...canvas.querySelectorAll<HTMLElement>('[data-action="ws-select"][data-kind="node"]')];
    const at = nodes.indexOf(node);
    let next: HTMLElement | undefined;
    const byRef = (ref: string | undefined): HTMLElement | undefined =>
      ref ? nodes.find((entry) => entry.dataset.ref === ref) : undefined;
    if (key === 'ArrowRight') next = byRef(graph.edges.find((edge) => edge.from === id)?.to);
    else if (key === 'ArrowLeft') next = byRef(graph.edges.find((edge) => edge.to === id)?.from);
    else if (key === 'ArrowDown') next = nodes[at + 1];
    else if (key === 'ArrowUp') next = at > 0 ? nodes[at - 1] : undefined;
    else return false;
    if (next) {
      // Un seul arrêt de tabulation dans le graphe : il suit le nœud atteint par les flèches.
      for (const entry of nodes) entry.tabIndex = entry === next ? 0 : -1;
      next.focus();
    }
    return true;
  }

  /** Le glisser du graphe : le contenu suit le pointeur (viewBox posé en direct), l'état au relâcher. */
  pointerDown(event: PointerEvent): boolean {
    const canvas = (event.target as Element | null)?.closest<HTMLElement>('[data-ws-graph="canvas"]');
    if (!canvas || event.button !== 0) return false;
    const graph = this.ui.incident?.investigation.graph;
    if (!graph) return false;
    const w = Number(canvas.dataset.w);
    const h = Number(canvas.dataset.h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
    const drag: Drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      canvas,
      svg: canvas.querySelector('svg'),
      w,
      h,
      base: this.ws.graph,
      layout: graphLayout2(visibleGraph(graph, this.ws.graph.hidden)),
      moved: false,
    };
    this.drag = drag;
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== drag.pointerId) return;
      const px = moveEvent.clientX - drag.startX;
      const py = moveEvent.clientY - drag.startY;
      if (!drag.moved && Math.hypot(px, py) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        canvas.classList.add('ws-dragging');
        try {
          canvas.setPointerCapture(drag.pointerId);
        } catch {
          // Le pointeur n'est plus actif : le glisser continue sans capture.
        }
      }
      const width = drag.svg?.clientWidth ?? 0;
      if (width <= 0) return;
      const scale = drag.w / width;
      drag.next = reduceGraph(drag.base, 'ws-graph-pan', {
        dx: String(px * scale),
        dy: String(py * scale),
        w: String(drag.w),
        h: String(drag.h),
      });
      if (drag.next && drag.svg) {
        const view = graphViewBox(drag.layout, drag.next);
        drag.svg.setAttribute(
          'viewBox',
          `${String(view.x)} ${String(view.y)} ${String(view.width)} ${String(view.height)}`,
        );
      }
    };
    const end = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== drag.pointerId) return;
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      this.finishDrag();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    return true;
  }

  private finishDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag?.moved) return;
    if (drag.next) this.ws.graph = drag.next;
    // Le clic qui suit le relâcher n'est pas une sélection.
    this.suppressClick = true;
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    this.host.paint();
  }

  /** La molette sur le graphe : zoom autour du pointeur (un dessin par image). */
  wheel(event: WheelEvent): boolean {
    const canvas = (event.target as Element | null)?.closest<HTMLElement>('[data-ws-graph="canvas"]');
    if (!canvas) return false;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const fx = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    const fy = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    this.wheelDelta += event.deltaY;
    if (this.wheelFrame !== undefined) return true;
    const w = canvas.dataset.w;
    const h = canvas.dataset.h;
    this.wheelFrame = requestAnimationFrame(() => {
      this.wheelFrame = undefined;
      const delta = this.wheelDelta;
      this.wheelDelta = 0;
      this.ws.graph =
        reduceGraph(this.ws.graph, 'ws-graph-zoom', {
          delta: String(delta),
          fx: String(fx),
          fy: String(fy),
          w,
          h,
        }) ?? this.ws.graph;
      this.host.paint();
    });
    return true;
  }

  // ── Autour du dessin ───────────────────────────────────────────────────────────────────────

  /** Avant un dessin : le défilement des zones et les détails ouverts sont notés ; un glisser est validé. */
  beforePaint(): void {
    const drag = this.drag;
    if (drag?.moved && drag.next) {
      this.ws.graph = drag.next;
      drag.base = drag.next;
      drag.startX = Number.NaN;
    }
    const root = this.host.root;
    if (!root.querySelector('.ws-root')) return;
    this.scrolls.clear();
    for (const selector of SCROLLERS)
      root.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
        if (element.scrollTop > 0 || element.scrollLeft > 0)
          this.scrolls.set(`${selector}#${String(index)}`, {
            top: element.scrollTop,
            left: element.scrollLeft,
          });
      });
    this.opened.clear();
    root.querySelectorAll<HTMLDetailsElement>('.ws-root details').forEach((details) => {
      const summary = details.querySelector('summary')?.textContent ?? '';
      const zone = details.closest<HTMLElement>('[data-ws-zone]')?.dataset.wsZone ?? '';
      this.opened.set(`${zone}|${summary}`, details.open);
    });
  }

  /**
   * La zone des messages (`.inc-live`, la seule zone live de la page) est redessinée avec la page : un
   * nœud neuf qui naît avec son texte n'est en général pas annoncé. Quand ce texte CHANGE (opération
   * lancée ou finie, reproduction ou vérification terminée, fichier non lu), son contenu est remplacé par
   * une copie identique un instant après le dessin : la zone, déjà dans l'arbre d'accessibilité, annonce
   * cet ajout une fois. Un redessin au même texte (suivi, sélection, zoom) ne dit rien, le premier dessin
   * de la page non plus.
   */
  private speak(root: ShadowRoot): void {
    const live = root.querySelector<HTMLElement>('.inc-live');
    if (!live) return;
    live.setAttribute('aria-atomic', 'true');
    const text = live.textContent.trim();
    const interrupted = this.liveTimer !== undefined;
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    // Le premier dessin de la page ne dit pas un message plus ancien qu'elle.
    const first = this.liveText === undefined;
    if (text === this.liveText && !interrupted) return;
    this.liveText = text;
    if (!text || first) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      if (live.isConnected) live.replaceChildren(...[...live.childNodes].map((node) => node.cloneNode(true)));
    }, LIVE_DELAY_MS);
  }

  /** Après un dessin : défilements et détails rétablis ; une ligne de code nouvellement visée est montrée. */
  afterPaint(): void {
    const root = this.host.root;
    if (!root.querySelector('.ws-root')) return;
    this.speak(root);
    if (this.drag && Number.isNaN(this.drag.startX)) this.drag = undefined;
    for (const selector of SCROLLERS)
      root.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
        const saved = this.scrolls.get(`${selector}#${String(index)}`);
        if (!saved) return;
        element.scrollTop = saved.top;
        element.scrollLeft = saved.left;
      });
    root.querySelectorAll<HTMLDetailsElement>('.ws-root details').forEach((details) => {
      const summary = details.querySelector('summary')?.textContent ?? '';
      const zone = details.closest<HTMLElement>('[data-ws-zone]')?.dataset.wsZone ?? '';
      const open = this.opened.get(`${zone}|${summary}`);
      if (open !== undefined) details.open = open;
    });
    root.querySelectorAll<HTMLElement>('[data-ws-zone]').forEach((zone) => {
      const name = zone.dataset.wsZone ?? '';
      zone.querySelectorAll<HTMLElement>('.ws-code-scroll').forEach((scroller, index) => {
        const selected = scroller.querySelector<HTMLElement>('.ws-code-sel');
        const key = `${name}#${String(index)}`;
        if (!selected) return;
        const label = `${scroller.getAttribute('aria-label') ?? ''}|${selected.textContent.slice(0, 40)}`;
        if (this.codeTargets.get(key) === label) return;
        this.codeTargets.set(key, label);
        const box = scroller.getBoundingClientRect();
        const line = selected.getBoundingClientRect();
        scroller.scrollTop += line.top - box.top - box.height / 2 + line.height / 2;
      });
    });
  }
}
