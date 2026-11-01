import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import { EXECUTION_TARGETS, type Incident } from '../core/incident-contracts.js';
import { can } from './dashboard-access.js';
import { base64Of, sortAttachments, type IncidentsUi } from './dashboard-incidents.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';
import { reduceAttachments, withoutAttachment, type RejectedFile } from './incident-attachments.js';
import { codeTarget, reduceCode, revealInCode } from './incident-code.js';
import {
  diagnosisBusyKey,
  isReportFormat,
  parseReportSections,
  planInputOf,
  reduceDiagnosis,
  selectedRunnable,
} from './incident-diagnosis.js';
import { reduceFrontendTrace } from './incident-frontend-trace.js';
import {
  graphHidden,
  graphKeyAction,
  graphViewBox,
  isGraphLayout,
  layoutGraph,
  reduceGraph,
  visibleGraph,
  type GraphLayout2,
  type GraphUi,
} from './incident-graph.js';
import { fileId, SELECTION_KINDS, selectionKey, sourceOf, type SelectionKind } from './incident-links.js';
import type * as DemoData from './incident-demo.js';
import type { WorkspaceContext } from './incident-parts.js';
import {
  clampSplit,
  isMainTab,
  isSplitterId,
  readPrefs,
  reduceSplit,
  splitFromPrefs,
  splitBounds,
  SPLITTERS,
  splitTemplates,
  writePrefs,
  type MainTab,
  type PaneId,
  type PrefsStorage,
  type SplitLayout,
  type SplitterId,
  type SplitUi,
  type WorkspacePrefs,
} from './incident-split.js';
import {
  formatElapsed,
  liveStamp,
  neededShots,
  reduceReproduction,
  reproductionTabFocus,
  type ReproductionTabGroup,
} from './incident-reproduction.js';
import { reduceTimeline } from './incident-timeline.js';
import {
  connectivityFailure,
  connectivityInput,
  connectivityOf,
  connectivityTargets,
  environmentDirty,
  executionOf,
  reduceUx,
  rovingTarget,
  UX_FIELDS,
  withConnectivity,
  type Connectivity,
  type UxField,
} from './incident-ux.js';
import {
  CODE_MAIN_TABS,
  codeCtxOf,
  demoUnavailable,
  emptyWorkspaceUi,
  environmentRefOf,
  isWorkspaceTab,
  LAYER_TABS,
  layoutOf,
  mainTabsOf,
  neededSources,
  screenshotOf,
  shotKey,
  STAGE_TABS,
  subTabsOf,
  VIEW_ROUTES,
  viewOf,
  viewOfMain,
  workspaceCtx,
  workspaceText,
  type LoadState,
  type WorkspaceTab,
  type WorkspaceUi,
} from './incident-workspace.js';
import { AI_OPERATIONS, aiBusyKey, chosenMode, reduceAi } from './incident-ai.js';
import {
  ACTIVE_TRIGGER_STATES,
  TRIGGER_OPERATIONS,
  reduceTrigger,
  shownTriggerRun,
  triggerBusyKey,
} from './incident-trigger.js';

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
  /** Le stockage des préférences (absent : `localStorage` s'il est permis). */
  storage?(): PrefsStorage | undefined;
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

/**
 * Les zones dont le défilement survit au redessin : le corps de chaque panneau, le cadre du graphe, les
 * barres d'onglets, la progression, le code, les tableaux. Clé : panneau (et vue, pour les panneaux dont le
 * contenu change avec la vue) + sélecteur + rang dans le panneau.
 */
const SCROLLERS = [
  '[data-ws-scroll]',
  '.ws-graph-canvas',
  '.ws-ux-tabs',
  '.ws-ux-stepper ol',
  '.ws-ux-head-more',
  '[data-ws-zone] .ws-code-scroll',
  '[data-ws-zone] .tw',
  '[data-ws-zone] .ws-code-tree',
  '[data-ws-zone] .ws-code-tabs',
  '.ws-code-tree-pane',
  '.ws-code-evidence',
  '.ws-code-layer-tree',
];

/** Les panneaux dont le contenu dépend de la vue (leur défilement est gardé par vue). */
const VIEW_PANES = new Set(['content', 'primary']);

/** La marge du contenu de la page autour de l'espace (2 × 8 px), et les largeurs d'une tablette. */
const MAIN_GUTTER_PX = 16;
const TABLET_MIN_PX = 720;
const TABLET_TREE_PX = 900;

/** Le délai d'écriture des préférences (une écriture pour une rafale de changements). */
const PREFS_DELAY_MS = 300;

/** Le changement de taille du cadre du graphe qui justifie un redessin. */
const VIEWPORT_STEP_PX = 8;

/** Deux appuis sur un séparateur à moins de 400 ms : le double clic (taille par défaut). */
const DOUBLE_MS = 400;

/** Un glisser de séparateur : la zone mesurée au départ, la fraction posée en direct, validée au relâcher. */
interface SplitDrag {
  pointerId: number;
  splitter: SplitterId;
  element: HTMLElement;
  zone: HTMLElement;
  layout: SplitLayout;
  value?: number;
}

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

/** Les octets d'un contenu base64 (le PDF du rapport). */
export function bytesOfBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/**
 * Montre une étape dans sa ligne qui défile horizontalement, sans faire défiler la page ni le panneau :
 * seul le défilement de la ligne bouge (`scrollIntoView` ferait aussi défiler les ancêtres).
 */
function scrollIntoRow(step: HTMLElement): void {
  const row = step.closest<HTMLElement>('.ws-ux-steps-row');
  if (!row || typeof row.getBoundingClientRect !== 'function') return;
  const item = step.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (item.left < box.left) row.scrollLeft -= box.left - item.left + 8;
  else if (item.right > box.right) row.scrollLeft += item.right - box.right + 8;
}

/**
 * La clé d'un volet `<details>` pour garder son état ouvert au redessin : son panneau et son nom stable
 * (`data-ws-details`), à défaut le texte de son résumé.
 */
function detailsKey(details: HTMLDetailsElement): string {
  const zone = details.closest<HTMLElement>('[data-ws-zone]')?.dataset.wsZone ?? '';
  const name = details.dataset.wsDetails ?? details.querySelector('summary')?.textContent ?? '';
  return `${zone}|${name}`;
}

/** Le compteur du temps écoulé d'une reproduction en cours : une écriture par seconde, sans redessin. */
export const ELAPSED_TICK_MS = 1000;

export class WorkspaceController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Le compteur `[data-ws-ticking="true"]` (actif tant qu'un tel élément est affiché). */
  private ticker: ReturnType<typeof setInterval> | undefined;
  /** L'étape actuelle de la progression au dernier dessin (montrée dans sa ligne quand elle change). */
  private stepperCurrent = '';
  private demoModule: DemoModule | undefined;
  private drag: Drag | undefined;
  private suppressClick = false;
  private wheelDelta = 0;
  private wheelFrame: number | undefined;
  private scrolls = new Map<string, { top: number; left: number }>();
  private opened = new Map<string, boolean>();
  /** Le fichier et la ligne visés au dernier dessin, par zone : un changement fait défiler jusqu'à la ligne. */
  private codeTargets = new Map<string, string>();
  /** L'onglet de fichier actif au dernier dessin (montré dans sa barre quand il change). */
  private activeCodeTab = '';
  /**
   * La vue dessinée en dernier : `beforePaint` note les défilements sous CETTE vue (la route a déjà changé
   * quand un changement d'onglet redessine), si bien que chaque vue garde le sien (Périmètre ↔ Résumé).
   */
  private paintedView: WorkspaceTab | undefined;
  /**
   * L'arborescence réduite d'office sur une tablette (espace de 720 à 900 px de large), sans préférence
   * enregistrée : ce choix automatique n'est pas mémorisé tant que la personne ne touche pas à l'arborescence.
   */
  private treeAuto = false;
  /** Les préférences lues (une fois), et l'écriture qui attend. */
  private prefs: WorkspacePrefs | undefined;
  private prefsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Le séparateur en cours de glisser, et le dernier appui (double clic). */
  private splitDrag: SplitDrag | undefined;
  private lastSplitDown: { splitter: string; at: number } | undefined;
  /** Le cadre du graphe observé (taille → `ws-graph-viewport`), une mesure par image au plus. */
  private resizer: ResizeObserver | undefined;
  private observed: Element | undefined;
  private viewportFrame: number | undefined;

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

  private mainTab(): MainTab {
    return VIEW_ROUTES[this.tab()].tab;
  }

  private layout(): SplitLayout {
    return layoutOf(this.mainTab());
  }

  // ── Préférences ────────────────────────────────────────────────────────────────────────────

  private storage(): PrefsStorage | undefined {
    if (this.host.storage) return this.host.storage();
    try {
      return (globalThis as { localStorage?: PrefsStorage }).localStorage;
    } catch {
      // Stockage refusé (navigation privée, politique du site) : la page fonctionne sans.
      return undefined;
    }
  }

  /** Les préférences, lues une fois par page (toutes les investigations les partagent). */
  private loadPrefs(): WorkspacePrefs {
    this.prefs ??= readPrefs(this.storage());
    return this.prefs;
  }

  /** Un état neuf, habillé des préférences (disposition, sous-onglets, mode compact, progression). */
  private freshWorkspace(incidentId: string, demo: boolean): WorkspaceUi {
    const ws = emptyWorkspaceUi(incidentId, demo);
    const prefs = this.loadPrefs();
    ws.split = splitFromPrefs(prefs);
    ws.subs = { ...prefs.subs };
    ws.compact = prefs.compact;
    ws.stepperOpen = prefs.stepper;
    this.treeAuto = false;
    if (!prefs.treeCollapsed && prefs.panes.tree === undefined && this.tabletWidth()) {
      this.treeAuto = true;
      ws.code = { ...ws.code, treeCollapsed: true };
      ws.split = { ...ws.split, panes: { ...ws.split.panes, tree: 'min' } };
    } else if (prefs.treeCollapsed) {
      ws.code = { ...ws.code, treeCollapsed: true };
      ws.split = { ...ws.split, panes: { ...ws.split.panes, tree: ws.split.panes.tree ?? 'min' } };
    }
    if (prefs.graphZoom !== undefined) ws.graph = { ...ws.graph, zoom: prefs.graphZoom };
    if (isGraphLayout(prefs.graphLayout)) ws.graph = { ...ws.graph, layout: prefs.graphLayout };
    return ws;
  }

  /**
   * Une tablette : l'espace (le contenu de la page, moins ses marges) mesure de 720 à 900 px de large. Au-delà,
   * l'arborescence garde au moins 190 px (noms lisibles) ; en deçà, un seul panneau est affiché à la fois.
   */
  private tabletWidth(): boolean {
    let width = 0;
    try {
      const main = this.host.root.querySelector<HTMLElement>('.main');
      width = main ? main.clientWidth - MAIN_GUTTER_PX : 0;
    } catch {
      // Une racine qui ne se mesure pas (double de test) : pas de tablette.
    }
    return width >= TABLET_MIN_PX && width < TABLET_TREE_PX;
  }

  /** Les préférences de l'état affiché. */
  private prefsOf(ws: WorkspaceUi): WorkspacePrefs {
    const { tree: _autoTree, ...withoutTree } = ws.split.panes;
    return {
      sizes: { ...ws.split.sizes },
      panes: this.treeAuto ? withoutTree : { ...ws.split.panes },
      ...(ws.split.maximized ? { maximized: ws.split.maximized } : {}),
      tab: this.mainTab(),
      subs: { ...ws.subs },
      graphZoom: ws.graph.zoom,
      graphLayout: ws.graph.layout,
      compact: ws.compact,
      stepper: ws.stepperOpen,
      treeCollapsed: this.treeAuto ? false : ws.code.treeCollapsed,
      codeTop: ws.split.codeTop,
    };
  }

  /** Les préférences sont écrites un instant après le dernier changement (stockage refusé : rien de grave). */
  private savePrefs(): void {
    if (!this.route()) return;
    this.prefs = this.prefsOf(this.ws);
    clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => {
      this.prefsTimer = undefined;
      if (this.prefs) writePrefs(this.storage(), this.prefs);
    }, PREFS_DELAY_MS);
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
      this.ws = this.freshWorkspace(incident.id, demo);
      this.codeTargets.clear();
      this.scrolls.clear();
      // Sans onglet dans la route, l'investigation s'ouvre sur le dernier onglet utilisé.
      const route = this.route();
      const prefs = this.loadPrefs();
      if (route && route.tab === undefined && prefs.tab && prefs.tab !== 'overview')
        this.host.state.route = { ...route, tab: viewOfMain(prefs.tab, this.ws.subs) };
      return;
    }
    const before = this.ui.incident;
    // Le rapport est calculé sur l'incident : une nouvelle révision le rend périmé.
    if (!demo && before && before.revision !== incident.revision) {
      ws.report = undefined;
      // Le rapport relu ; l'indisponibilité du PDF (une session sans navigateur) reste dite.
      ws.reportState = ws.reportState.pdfUnavailable ? { pdfUnavailable: ws.reportState.pdfUnavailable } : {};
      // Le test généré suit la proposition : relu quand l'incident change.
      ws.regressionSpec = undefined;
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
      // Un run IA terminé pendant le suivi est dit une fois ; sa mémoire sera relue au prochain dessin de la vue.
      const aiOver = (incident.investigation.ai?.runs ?? []).find(
        (run) =>
          run.status !== 'RUNNING' &&
          (before.investigation.ai?.runs ?? []).some(
            (previous) => previous.id === run.id && previous.status === 'RUNNING',
          ),
      );
      if (aiOver) this.ui.notice = this.host.state.t.inc.done.aiOver(aiOver.status);
      // Un run de découverte des déclencheurs terminé pendant le suivi est dit une fois.
      const trgOver = (incident.investigation.trigger?.runs ?? []).find(
        (run) =>
          !ACTIVE_TRIGGER_STATES.includes(run.state) &&
          (before.investigation.trigger?.runs ?? []).some(
            (previous) => previous.id === run.id && ACTIVE_TRIGGER_STATES.includes(previous.state),
          ),
      );
      if (trgOver) this.ui.notice = this.host.state.t.inc.done.trgOver(trgOver.state);
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
    const codeNeeded =
      CODE_MAIN_TABS.includes(VIEW_ROUTES[tab].tab) || sourceOf(ctx.links, ctx.selection) !== undefined;
    if (codeNeeded && codeCtx.can('RUN')) {
      if (!ws.tree && ws.treeState === undefined) this.loadTree();
      for (const location of neededSources(codeCtx, ws, tab))
        this.loadSource(location.applicationId, location.file);
    }
    const shot = screenshotOf(ctx.incident, ws.selection);
    if (shot && !ws.demo) this.loadShot(shot.reproduction, shot.file);
    // Reproduction › Exécution et Preuves : l'aperçu et les vignettes affichées (la démonstration n'en a pas).
    if ((tab === 'run' || tab === 'evidence') && !ws.demo)
      for (const needed of neededShots(ctx, ws.repro, tab)) this.loadShot(needed.reproduction, needed.file);
    if (
      tab === 'regression' &&
      ws.dx.regTab === 'spec' &&
      ws.regressionSpec === undefined &&
      ctx.incident.investigation.regression
    )
      this.loadRegressionSpec();
    if (tab === 'overview' && ws.att.open && !ws.att.content[ws.att.open]) this.loadAttachment(ws.att.open);
    if (tab === 'report' && !ws.report && !ws.reportState.loading && !ws.reportState.error) this.loadReport();
    if (tab === 'environment' && !ws.demo && !ws.capabilities && ws.capabilitiesState === undefined)
      this.loadCapabilities();
    if (tab === 'ai' && !ws.demo) {
      if (!ws.ai.capabilities && ws.ai.capabilitiesState === undefined) this.loadAiCapabilities();
      // La mémoire d'investigation suit la révision : relue quand l'incident change (fin de run, décision).
      if (ws.ai.memoryState === undefined && ws.ai.memoryRevision !== ctx.incident.revision)
        this.loadAiMemory();
    }
  }

  private loadAiCapabilities(): void {
    const ws = this.ws;
    const target = this.target();
    if (!target) return;
    ws.ai = { ...ws.ai, capabilitiesState: 'loading' };
    target.api.incidents.ai.capabilities(target.route.projectId, target.route.incidentId).then(
      (capabilities) => {
        const { capabilitiesState: _done, ...rest } = ws.ai;
        ws.ai = { ...rest, capabilities };
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.ai = { ...ws.ai, capabilitiesState: loadStateOf(error) };
        this.arrived(ws);
      },
    );
  }

  private loadAiMemory(): void {
    const ws = this.ws;
    const target = this.target();
    const incident = this.ui.incident;
    if (!target || !incident) return;
    const revision = incident.revision;
    ws.ai = { ...ws.ai, memoryState: 'loading' };
    target.api.incidents.ai.memory(target.route.projectId, target.route.incidentId).then(
      (memory) => {
        const { memoryState: _done, ...rest } = ws.ai;
        ws.ai = { ...rest, memory, memoryRevision: revision };
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.ai = { ...ws.ai, memoryState: loadStateOf(error), memoryRevision: revision };
        this.arrived(ws);
      },
    );
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
    const kept = (): { pdfUnavailable?: string } =>
      ws.reportState.pdfUnavailable ? { pdfUnavailable: ws.reportState.pdfUnavailable } : {};
    ws.reportState = { ...kept(), loading: true };
    target.api.incidents.report(target.route.projectId, target.route.incidentId).then(
      (report) => {
        ws.report = report;
        ws.reportState = kept();
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.reportState = { ...kept(), error: message(error) };
        this.arrived(ws);
      },
    );
  }

  /**
   * Le test Playwright généré depuis la proposition (`incidents.regressionSpec`). Le serveur répond 400
   * INVALID quand il ne peut pas le produire (pas de proposition, pas d'URL de base) : c'est dit comme
   * indisponible, avec son message. La démonstration a son exemple, généré pour elle.
   */
  private loadRegressionSpec(): void {
    const ws = this.ws;
    if (ws.demo) {
      const spec = this.demoModule?.demoRegressionSpec();
      ws.regressionSpec = spec ? { language: spec.language, code: spec.code } : { unavailable: '' };
      return;
    }
    const target = this.target();
    if (!target) return;
    ws.regressionSpec = { loading: true };
    target.api.incidents.regressionSpec(target.route.projectId, target.route.incidentId).then(
      (spec) => {
        ws.regressionSpec = { language: spec.language, code: spec.code };
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.regressionSpec =
          error instanceof QaCrawlerError && error.status === 400
            ? { unavailable: message(error) }
            : { error: message(error) };
        this.arrived(ws);
      },
    );
  }

  /** Le contenu d'une pièce jointe (image `data:` ou texte masqué) ; la démonstration génère le sien. */
  private loadAttachment(id: string): void {
    const ws = this.ws;
    if (ws.att.content[id]) return;
    if (ws.demo) {
      const content = this.demoModule?.demoAttachment(id);
      ws.att = {
        ...ws.att,
        content: {
          ...ws.att.content,
          [id]: content
            ? {
                ...('dataUrl' in content ? { dataUrl: content.dataUrl } : { text: content.text }),
                demo: true,
              }
            : { state: { error: workspaceText(this.lang()).notInDemo } },
        },
      };
      return;
    }
    const target = this.target();
    if (!target) return;
    ws.att = { ...ws.att, content: { ...ws.att.content, [id]: { state: 'loading' } } };
    target.api.incidents.attachment(target.route.projectId, target.route.incidentId, id).then(
      (content) => {
        ws.att = {
          ...ws.att,
          content: {
            ...ws.att.content,
            [id]: 'dataUrl' in content ? { dataUrl: content.dataUrl } : { text: content.text },
          },
        };
        this.arrived(ws);
      },
      (error: unknown) => {
        ws.att = { ...ws.att, content: { ...ws.att.content, [id]: { state: loadStateOf(error) } } };
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
      if (this.ui.busy !== undefined || this.drag || this.splitDrag) {
        this.poll();
        return;
      }
      api.incidents.get(projectId, incidentId).then(
        (incident) => {
          if (this.route()?.incidentId !== incidentId) return;
          const current = this.ui.incident;
          // Une révision inchangée ET le même suivi en direct (étapes, dernier signal du moteur) : rien à
          // redessiner. Le suivi en direct est servi depuis la mémoire du serveur sans changer la révision.
          if (
            current?.id === incident.id &&
            current.revision === incident.revision &&
            liveStamp(current) === liveStamp(incident)
          ) {
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
    this.stopTicker();
    this.resizer?.disconnect();
    this.observed = undefined;
    if (this.viewportFrame !== undefined) cancelAnimationFrame(this.viewportFrame);
    this.viewportFrame = undefined;
    if (this.prefsTimer) {
      clearTimeout(this.prefsTimer);
      this.prefsTimer = undefined;
      if (this.prefs) writePrefs(this.storage(), this.prefs);
    }
  }

  get polling(): boolean {
    return this.timer !== undefined;
  }

  // ── Navigation dans l'espace ───────────────────────────────────────────────────────────────

  /**
   * Ouvre une vue (clé de vue) : la route change, le sous-onglet est retenu pour son onglet principal ; une
   * vue de couche sans fichier ouvert montre le fichier de départ de la couche dans l'éditeur. `focus` :
   * l'onglet principal (`main`), le sous-onglet (`sub`), ou rien.
   */
  selectTab(tab: WorkspaceTab, focus: boolean | 'main' | 'sub' = true): void {
    const route = this.route();
    if (!route) return;
    const ws = this.ws;
    const target = VIEW_ROUTES[tab];
    if (target.sub) ws.subs = { ...ws.subs, [target.tab]: target.sub };
    this.host.state.route = { ...route, tab };
    const layer = LAYER_TABS[tab];
    const context = this.context();
    if (layer && context && ws.code.tabs.length === 0) {
      const start = codeTarget(context.codeCtx, ws.code, layer, ws.tree);
      if (start) ws.code = revealInCode(ws.code, start, ws.selection ? selectionKey(ws.selection) : '');
    }
    this.ensure();
    this.host.paint();
    this.savePrefs();
    if (focus === false) return;
    const sub = focus === 'sub' || (focus === true && target.sub !== undefined && this.focusedSub);
    if (sub && target.sub) {
      if (!this.host.focus(`#ws-ux-sub-${target.sub}`)) this.host.focus(`#ws-ux-tab-${target.tab}`);
    } else this.host.focus(`#ws-ux-tab-${target.tab}`);
  }

  /** Le dernier changement d'onglet venait-il d'un sous-onglet (le focus y revient) ? */
  private focusedSub = false;

  /** Un clic sur un onglet principal : le dernier sous-onglet ouvert de cet onglet. */
  selectMain(tab: MainTab, focus = true): void {
    this.focusedSub = false;
    this.selectTab(viewOfMain(tab, this.ws.subs), focus ? 'main' : false);
  }

  /** La sélection partagée : un second clic sur l'élément sélectionné la vide. */
  select(kind: SelectionKind, id: string, fromGraph = false): void {
    const ws = this.ws;
    const current = ws.selection;
    ws.selection = current?.kind === kind && current.id === id ? undefined : { kind, id };
    const context = this.context();
    if (context && ws.selection) {
      const source = sourceOf(context.ctx.links, ws.selection);
      // L'endroit du code de la sélection est montré dans l'éditeur (onglet ouvert ou repris, sur la ligne).
      if (source) ws.code = revealInCode(ws.code, source, selectionKey(ws.selection));
      // Une sélection dans le graphe montre le détail : le panneau des détails réduit est rouvert (sur un
      // grand écran ; sur un écran étroit, le lien « Voir le détail » y mène sans changer de panneau).
      if (fromGraph && !this.narrow()) {
        const split = ws.split;
        if (split.panes.details === 'min') {
          const { details: _restored, ...panes } = split.panes;
          ws.split = { ...split, panes };
        }
      }
    }
    this.ensure();
    this.host.paint();
  }

  /** L'espace de travail est-il en disposition étroite (un panneau à la fois, sous 720 px) ? */
  private narrow(): boolean {
    const split = this.host.root.querySelector<HTMLElement>('.ws-split');
    const width = split?.clientWidth ?? 0;
    return width > 0 && width < 720;
  }

  clearSelection(): boolean {
    if (!this.ws.selection) return false;
    this.ws.selection = undefined;
    this.ensure();
    this.host.paint();
    return true;
  }

  /**
   * Un lien vers le code : le fichier est ouvert dans l'éditeur. Sur les onglets Traçabilité et Code,
   * l'éditeur est déjà là (rouvert s'il était réduit ou masqué) ; ailleurs, l'onglet Code s'ouvre.
   */
  private openCode(action: string, dataset: Record<string, string | undefined>): void {
    const ws = this.ws;
    const sel = dataset.sel ?? (ws.selection ? selectionKey(ws.selection) : '');
    ws.code = reduceCode(ws.code, action, { ...dataset, sel }) ?? ws.code;
    const split = ws.split;
    if (split.panes.editor !== undefined || (split.maximized && split.maximized !== 'editor')) {
      const { editor: _shown, ...panes } = split.panes;
      ws.split = { ...split, panes };
      if (split.maximized && split.maximized !== 'editor') delete ws.split.maximized;
    }
    if (!CODE_MAIN_TABS.includes(this.mainTab())) {
      this.selectTab('code', false);
      if (!this.host.focus('[data-ws-pane="editor"] .ws-code-scroll')) this.host.focus('#ws-ux-tab-code');
      return;
    }
    this.ensure();
    this.host.paint();
    this.savePrefs();
  }

  // ── Disposition ────────────────────────────────────────────────────────────────────────────

  /** Une action de la disposition (panneaux, séparateurs) : état, dessin, préférences, focus. */
  private splitAction(action: string, data: Record<string, string | undefined>): void {
    const ws = this.ws;
    const before = ws.split;
    const next = reduceSplit(before, action, { layout: this.layout(), ...data });
    if (!next) return;
    ws.split = next;
    const pane = data.pane as PaneId | undefined;
    if ((action === 'ws-pane' && pane === 'tree') || (action === 'ws-split-reset' && !data.splitter))
      this.treeAuto = false;
    // L'arborescence réduite ou rouverte par son panneau : l'explorateur suit (et inversement).
    if (action === 'ws-pane' && pane === 'tree') {
      const collapsed = next.panes.tree === 'min';
      if (collapsed !== ws.code.treeCollapsed) ws.code = { ...ws.code, treeCollapsed: collapsed };
    }
    if (action === 'ws-split-reset' && data.splitter === undefined && ws.code.treeCollapsed)
      ws.code = { ...ws.code, treeCollapsed: false };
    this.ensure();
    this.host.paint();
    this.savePrefs();
    if (action !== 'ws-pane' || !pane) return;
    const sel = (op: string): string => `[data-ws-pane="${pane}"] .ws-pane-ops [data-op="${op}"]`;
    switch (data.op) {
      case 'max':
        this.host.focus(sel('restore'));
        return;
      case 'restore':
        if (before.maximized === pane) this.host.focus(sel('max'));
        else if (!this.host.focus(sel('min'))) this.host.focus(sel('max'));
        return;
      case 'min':
        this.host.focus(sel('restore'));
        return;
      case 'hide':
        if (!this.host.focus(`[data-action="ws-pane"][data-op="show"][data-pane="${pane}"]`))
          this.host.focus('[data-action="ws-ux-tab"][aria-selected="true"]');
        return;
      case 'show':
        if (!this.host.focus(sel('min'))) this.host.focus(sel('restore'));
        return;
    }
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

  private download(name: string, content: string | Uint8Array<ArrayBuffer>, type: string): void {
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

  /**
   * « Exporter » : le rapport dans le format choisi, limité aux sections cochées (`data-sections`), lu sur le
   * serveur puis téléchargé (JSON, Markdown, HTML autonome, PDF décodé du base64). Un 501 (pas de navigateur
   * sans interface sur le serveur) rend le PDF indisponible pour la session, avec la raison du serveur.
   */
  private exportReport(format: string | undefined, sectionsParam: string | undefined): void {
    if (this.refuseInDemo() || this.ui.busy !== undefined || !isReportFormat(format)) return;
    const sections = parseReportSections(sectionsParam);
    if (sections.length === 0) return;
    const t = this.host.state.t.inc;
    const ws = this.ws;
    ws.reportState = { ...ws.reportState, exporting: format };
    this.dxOp(
      'ws-dx-export',
      undefined,
      'export',
      async (api, projectId, incident) => {
        const base = `incident-${incident.id}`;
        let file: string;
        try {
          if (format === 'json') {
            const part = await api.incidents.report(projectId, incident.id, { format: 'json', sections });
            file = `${base}.json`;
            this.download(file, `${JSON.stringify(part, null, 2)}\n`, 'application/json;charset=utf-8');
          } else if (format === 'markdown') {
            const { markdown } = await api.incidents.report(projectId, incident.id, { format, sections });
            file = `${base}.md`;
            this.download(file, markdown, 'text/markdown;charset=utf-8');
          } else if (format === 'html') {
            const { html } = await api.incidents.report(projectId, incident.id, { format, sections });
            file = `${base}.html`;
            this.download(file, html, 'text/html;charset=utf-8');
          } else {
            const { pdfBase64 } = await api.incidents.report(projectId, incident.id, { format, sections });
            file = `${base}.pdf`;
            this.download(file, bytesOfBase64(pdfBase64), 'application/pdf');
          }
        } catch (error) {
          if (format === 'pdf' && error instanceof QaCrawlerError && error.status === 501) {
            this.ws.reportState = { ...this.ws.reportState, pdfUnavailable: message(error) };
            return undefined;
          }
          throw error;
        }
        this.ui.notice = t.done.exported(file);
        return undefined;
      },
      {
        settle: () => {
          const { exporting: _done, ...rest } = this.ws.reportState;
          this.ws.reportState = rest;
        },
        focus: `[data-action="ws-dx-export"][data-format="${format}"]`,
      },
    );
  }

  /**
   * « Exécuter la vérification » : les vérifications cochées (revérifiées : exécutables, sans effet de bord),
   * lancées une à une sur le serveur ; la première erreur arrête la suite et s'affiche sous la liste. Les
   * vérifications à effets de bord gardent leur approbation dans la page (`ws-dx-run` / `ws-dx-approve`).
   */
  private runSelected(target: HTMLElement): void {
    const incident = this.ui.incident;
    if (!incident || this.refuseInDemo() || this.ui.busy !== undefined) return;
    const asked = (target.dataset.experiments ?? '').split(',').filter((id) => id !== '');
    const allowed = new Set(selectedRunnable(incident, this.ws.dx));
    const ids = asked.filter((id) => allowed.has(id));
    if (ids.length === 0) return;
    const t = this.host.state.t.inc;
    this.dxOp(
      'ws-dx-run-selected',
      undefined,
      'run-selected',
      async (api, projectId, current) => {
        let last: Incident | undefined;
        for (const id of ids) {
          last = await api.incidents.runExperiment(projectId, current.id, id);
          if (this.route()?.incidentId !== current.id) return undefined;
          // Chaque résultat est montré dès qu'il arrive (la suivante attend son tour).
          this.host.receive(last);
          this.host.paint();
        }
        return last;
      },
      {
        notice: () => t.done.experimentsRun(ids.length),
        after: () => {
          this.ws.dx = { ...this.ws.dx, checked: [] };
        },
        focus: '[data-action="ws-dx-run-selected"]',
      },
    );
  }

  /**
   * « Tester la connectivité » : chaque URL connue (environnement du projet, applications du périmètre)
   * est vérifiée par le serveur (`environments.check`, `reach: true`) ; chaque résultat s'affiche dès qu'il
   * arrive. Rien à tester : la raison est dite.
   */
  private checkConnectivity(): void {
    const incident = this.ui.incident;
    const target = this.target();
    if (!incident || !target || this.refuseInDemo() || !can(this.host.state, 'RUN')) return;
    const ws = this.ws;
    if (ws.ux.checking) return;
    const environment = environmentRefOf(this.host.state.project?.environments, incident);
    const targets = connectivityTargets(incident, environment);
    ws.ux = reduceUx(ws.ux, 'ws-ux-check', {}) ?? ws.ux;
    if (targets.length === 0) {
      ws.ux =
        reduceUx(ws.ux, 'ws-ux-check-error', { message: workspaceText(this.lang()).noConnectivityTarget }) ??
        ws.ux;
      this.host.paint();
      return;
    }
    this.host.paint();
    const results: Record<string, Connectivity> = {};
    const { api, route } = target;
    void (async () => {
      for (const entry of targets) {
        const { input, options } = connectivityInput(entry, environment);
        try {
          results[entry.key] = connectivityOf(
            entry.url,
            await api.environments.check(route.projectId, input, options),
          );
        } catch (error) {
          results[entry.key] = connectivityFailure(entry.url, message(error));
        }
        if (this.ws !== ws) return;
        const done = Object.keys(results).length === targets.length;
        ws.ux = { ...withConnectivity(ws.ux, { ...results }), ...(done ? {} : { checking: true }) };
        this.host.paint();
      }
      this.host.focus('[data-action="ws-ux-check"]');
    })();
  }

  /** « Reproduire » (écran Exécution) : la même reproduction que l'en-tête ; le suivi en direct suit. */
  private startReproduction(): void {
    if (this.refuseInDemo() || this.ui.busy !== undefined) return;
    const t = this.host.state.t.inc;
    this.ws.repro = reduceReproduction(this.ws.repro, 'ws-repro-start', {}) ?? this.ws.repro;
    // La reproduction suivie est la nouvelle (la dernière du scénario), pas une ancienne choisie.
    const { reproduction: _latest, ...repro } = this.ws.repro;
    this.ws.repro = repro;
    void this.host.op(
      'ws-repro-start',
      (api, projectId, incident) => api.incidents.reproduce(projectId, incident.id),
      {
        notice: () => t.done.reproductionStarted,
        settle: () => {
          this.ensure();
        },
        focus: '[data-action="ws-repro-stop"]',
      },
    );
  }

  /** « Arrêter » confirmé : l'investigation est annulée sur le serveur (la reproduction en cours s'arrête). */
  private stopReproduction(): void {
    if (this.refuseInDemo() || this.ui.busy !== undefined || !can(this.host.state, 'RUN')) return;
    const t = this.host.state.t.inc;
    this.ws.repro = reduceReproduction(this.ws.repro, 'ws-repro-stop-yes', {}) ?? this.ws.repro;
    void this.host.op(
      'ws-repro-stop-yes',
      (api, projectId, incident) => api.incidents.cancel(projectId, incident.id),
      {
        notice: () => t.done.cancelled,
        focus: '[data-action="ws-repro-start"]',
      },
    );
  }

  /**
   * « Ajouter » (pièces jointes) : les fichiers choisis sont triés comme dans le formulaire de création
   * (type, taille, nombre), lus en base64 puis envoyés un à un ; les écartés sont dits avec leur raison.
   */
  private async addAttachments(input: HTMLInputElement): Promise<void> {
    const incident = this.ui.incident;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!incident || files.length === 0 || this.refuseInDemo() || this.ui.busy !== undefined) return;
    const ws = this.ws;
    const { accepted, rejected } = sortAttachments((incident.attachments ?? []).length, files);
    const kept: RejectedFile[] = [...rejected];
    const read: { name: string; type: (typeof accepted)[number]['type']; dataBase64: string }[] = [];
    for (const { index, type } of accepted) {
      const file = files[index];
      if (!file) continue;
      try {
        read.push({ name: file.name, type, dataBase64: base64Of(new Uint8Array(await file.arrayBuffer())) });
      } catch {
        kept.push({ name: file.name, reason: 'read' });
      }
    }
    if (this.ws !== ws) return;
    const { error: _cleared, ...att } = ws.att;
    ws.att = { ...att, rejected: kept };
    if (read.length === 0) {
      this.host.paint();
      this.host.focus('#ws-att-file');
      return;
    }
    const t = workspaceText(this.lang());
    await this.host.op(
      'ws-att-add',
      async (api, projectId, current) => {
        let last: Incident | undefined;
        for (const file of read) last = await api.incidents.addAttachment(projectId, current.id, file);
        return last;
      },
      {
        notice: () => t.attachmentsAdded(read.length),
        onError: (text) => {
          this.ws.att = { ...this.ws.att, error: text };
        },
        focus: '#ws-att-file',
      },
    );
  }

  /** Le retrait confirmé d'une pièce jointe. */
  private removeAttachment(id: string): void {
    if (this.refuseInDemo() || this.ui.busy !== undefined || !can(this.host.state, 'RUN')) return;
    const t = workspaceText(this.lang());
    const { error: _cleared, ...att } = this.ws.att;
    this.ws.att = att;
    void this.host.op(
      'ws-att-remove-yes',
      (api, projectId, incident) => api.incidents.removeAttachment(projectId, incident.id, id),
      {
        notice: () => t.attachmentRemoved,
        after: () => {
          this.ws.att = withoutAttachment(this.ws.att, id);
        },
        onError: (text) => {
          this.ws.att = { ...this.ws.att, error: text };
        },
        focus: '#ws-att-file',
      },
    );
  }

  private experimentNotice(incident: Incident, experimentId: string): string | undefined {
    const t = this.host.state.t.inc;
    const done = incident.investigation.experiments.find((entry) => entry.id === experimentId);
    return done ? t.done.experimentOver(t.experimentStatus[done.status] ?? done.status) : undefined;
  }

  /** Les opérations de l'investigation IA (`AI_OPERATIONS`) : toujours par le serveur, jamais en démonstration. */
  private aiOperation(action: string, target: HTMLElement): void {
    const incident = this.ui.incident;
    if (!incident) return;
    const t = this.host.state.t.inc;
    const data = target.dataset;
    const ai = this.ws.ai;
    const mode = chosenMode(ai);
    const startInput = mode === 'DETERMINISTIC' ? {} : { mode, depth: ai.depth };
    switch (action) {
      case 'ws-ai-start':
        if (mode === 'DETERMINISTIC') return;
        this.aiOp(
          action,
          undefined,
          'start',
          (api, projectId, current) => api.incidents.ai.investigate(projectId, current.id, startInput),
          {
            notice: () => t.done.aiStarted,
            after: () => {
              this.poll();
            },
            focus: '[data-action="ws-ai-cancel"]',
          },
        );
        return;
      case 'ws-ai-resume':
        if (mode === 'DETERMINISTIC') return;
        this.aiOp(
          action,
          undefined,
          'start',
          (api, projectId, current) => api.incidents.ai.resume(projectId, current.id, startInput),
          {
            notice: () => t.done.aiStarted,
            after: () => {
              this.poll();
            },
            focus: '[data-action="ws-ai-cancel"]',
          },
        );
        return;
      case 'ws-ai-pause':
        this.aiOp(
          action,
          undefined,
          'control',
          (api, projectId, current) => api.incidents.ai.pause(projectId, current.id),
          { notice: () => t.done.aiPaused },
        );
        return;
      case 'ws-ai-cancel-yes':
        this.aiOp(
          action,
          undefined,
          'control',
          (api, projectId, current) => api.incidents.ai.cancel(projectId, current.id),
          {
            notice: () => t.done.aiCancelled,
            after: () => {
              this.ws.ai = { ...this.ws.ai, confirmCancel: false };
            },
            focus: '[data-action="ws-ai-start"]',
          },
        );
        return;
      case 'ws-ai-ask': {
        const question = ai.question.trim();
        if (!question) {
          this.host.focus('#ws-ai-question');
          return;
        }
        this.aiOp(
          action,
          undefined,
          'ask',
          async (api, projectId, current) => {
            await api.incidents.ai.ask(projectId, current.id, question);
            return api.incidents.get(projectId, current.id);
          },
          {
            notice: () => t.done.aiAnswered,
            after: () => {
              this.ws.ai = { ...this.ws.ai, question: '' };
            },
            focus: '#ws-ai-question',
          },
        );
        return;
      }
      case 'ws-ai-approve':
      case 'ws-ai-refuse': {
        const proposal = data.proposal;
        if (!proposal || !can(this.host.state, 'DECIDE')) return;
        const approve = action === 'ws-ai-approve';
        this.aiOp(
          action,
          proposal,
          `decide:${proposal}`,
          (api, projectId, current) =>
            api.incidents.ai.decideExperiment(projectId, current.id, proposal, { approve }),
          {
            notice: () => t.done.aiDecided(approve),
            after: () => {
              this.forgetAiMemory();
            },
            focus: `[data-action="ws-ai-section"][data-section="proposals"]`,
          },
        );
        return;
      }
      case 'ws-ai-extend': {
        const value = Number(ai.extendValue);
        if (!Number.isInteger(value) || value <= 0 || !can(this.host.state, 'DECIDE')) return;
        const key = ai.extendKey;
        this.aiOp(
          action,
          undefined,
          'extend',
          async (api, projectId, current) => {
            await api.incidents.ai.extendBudget(projectId, current.id, { [key]: value });
            return api.incidents.get(projectId, current.id);
          },
          {
            notice: () => t.done.aiExtended,
            after: () => {
              this.forgetAiMemory();
            },
          },
        );
        return;
      }
      case 'ws-ai-reload':
        this.forgetAiMemory();
        this.ensure();
        this.host.paint();
        return;
      default:
        return;
    }
  }

  /** La mémoire sera relue au prochain dessin de la vue (après une décision, une prolongation, une relecture demandée). */
  private forgetAiMemory(): void {
    const { memoryState: _state, memoryRevision: _revision, ...rest } = this.ws.ai;
    this.ws.ai = rest;
  }

  /** Les opérations de la découverte des déclencheurs (`TRIGGER_OPERATIONS`) : toujours par le serveur, jamais en démonstration. */
  private triggerOperation(action: string, target: HTMLElement): void {
    const incident = this.ui.incident;
    if (!incident) return;
    const t = this.host.state.t.inc;
    const data = target.dataset;
    const trg = this.ws.trg;
    const input = {
      depth: trg.depth,
      ...(trg.description.trim() ? { description: trg.description.trim() } : {}),
    };
    switch (action) {
      case 'ws-trg-describe': {
        const stored = incident.investigation.trigger?.brief?.rawText ?? '';
        const text = (trg.description || stored || incident.description).trim();
        if (!text) return;
        this.trgOp(
          action,
          undefined,
          'describe',
          (api, projectId, current) => api.incidents.trigger.describe(projectId, current.id, text),
          { notice: () => t.done.trgDescribed },
        );
        return;
      }
      case 'ws-trg-start':
        this.trgOp(
          action,
          undefined,
          'start',
          (api, projectId, current) => api.incidents.trigger.start(projectId, current.id, input),
          {
            notice: () => t.done.trgStarted,
            after: () => {
              this.poll();
            },
            focus: '[data-action="ws-trg-cancel"]',
          },
        );
        return;
      case 'ws-trg-resume':
        this.trgOp(
          action,
          undefined,
          'control',
          (api, projectId, current) =>
            api.incidents.trigger.resume(projectId, current.id, { depth: trg.depth }),
          {
            notice: () => t.done.trgResumed,
            after: () => {
              this.poll();
            },
          },
        );
        return;
      case 'ws-trg-pause':
        this.trgOp(
          action,
          undefined,
          'control',
          (api, projectId, current) => api.incidents.trigger.pause(projectId, current.id),
          {
            notice: () => t.done.trgPaused,
          },
        );
        return;
      case 'ws-trg-cancel-yes':
        this.trgOp(
          action,
          undefined,
          'control',
          (api, projectId, current) => api.incidents.trigger.cancel(projectId, current.id),
          {
            notice: () => t.done.trgCancelled,
            settle: () => {
              this.ws.trg = { ...this.ws.trg, confirmCancel: false };
            },
            focus: '[data-action="ws-trg-start"]',
          },
        );
        return;
      case 'ws-trg-approve':
      case 'ws-trg-refuse': {
        const experiment = data.experiment;
        if (!experiment || !can(this.host.state, 'DECIDE')) return;
        const approve = action === 'ws-trg-approve';
        this.trgOp(
          action,
          experiment,
          `decide:${experiment}`,
          (api, projectId, current) =>
            api.incidents.trigger.decideExperiment(projectId, current.id, experiment, { approve }),
          {
            notice: () => t.done.trgDecided(approve),
            after: () => {
              this.poll();
            },
          },
        );
        return;
      }
      case 'ws-trg-extend': {
        const value = Number(trg.extendValue);
        if (!Number.isInteger(value) || value <= 0 || !can(this.host.state, 'DECIDE')) return;
        const key = trg.extendKey;
        this.trgOp(
          action,
          undefined,
          'extend',
          (api, projectId, current) =>
            api.incidents.trigger.extendBudget(projectId, current.id, { [key]: value }),
          { notice: () => t.done.trgExtended },
        );
        return;
      }
      case 'ws-trg-report-load':
        this.loadTriggerReport();
        return;
      default:
        return;
    }
  }

  private loadTriggerReport(): void {
    const target = this.target();
    const incident = this.ui.incident;
    if (!target || !incident || this.ws.demo) return;
    const run = shownTriggerRun(incident, this.ws.trg);
    if (!run) return;
    this.ws.trg = { ...this.ws.trg, reportState: 'loading' };
    this.host.paint();
    target.api.incidents.trigger.report(target.route.projectId, target.route.incidentId, run.id).then(
      (report) => {
        const { reportState: _done, ...rest } = this.ws.trg;
        this.ws.trg = { ...rest, report, reportRunId: run.id };
        this.host.paint();
      },
      (error: unknown) => {
        this.ws.trg = { ...this.ws.trg, reportState: loadStateOf(error) };
        this.host.paint();
      },
    );
  }

  private trgOp(
    action: string,
    ref: string | undefined,
    slot: string,
    run: OpRun,
    options: OpOptions = {},
  ): void {
    if (this.refuseInDemo() || this.ui.busy !== undefined) return;
    if (!can(this.host.state, 'RUN')) return;
    const ws = this.ws;
    const { [slot]: _cleared, ...errors } = ws.trg.errors;
    ws.trg = { ...ws.trg, busy: triggerBusyKey(action, ref), errors };
    void this.host.op(action, run, {
      ...options,
      onError: (text) => {
        this.ws.trg = { ...this.ws.trg, errors: { ...this.ws.trg.errors, [slot]: text } };
      },
      settle: () => {
        const { busy: _done, ...rest } = this.ws.trg;
        this.ws.trg = rest;
        options.settle?.();
        this.ensure();
      },
    });
  }

  private aiOp(
    action: string,
    ref: string | undefined,
    slot: string,
    run: OpRun,
    options: OpOptions = {},
  ): void {
    if (this.refuseInDemo() || this.ui.busy !== undefined) return;
    if (!can(this.host.state, 'RUN')) return;
    const ws = this.ws;
    const { [slot]: _cleared, ...errors } = ws.ai.errors;
    ws.ai = { ...ws.ai, busy: aiBusyKey(action, ref), errors };
    void this.host.op(action, run, {
      ...options,
      onError: (text) => {
        this.ws.ai = { ...this.ws.ai, errors: { ...this.ws.ai.errors, [slot]: text } };
      },
      settle: () => {
        const { busy: _done, ...rest } = this.ws.ai;
        this.ws.ai = rest;
        options.settle?.();
        this.ensure();
      },
    });
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
          // « Annuler » d'abord : Entrée ne lance jamais par mégarde une expérience à effets de bord.
          if (!this.host.focus('[data-action="ws-dx-approve-cancel"]'))
            this.host.focus('[data-action="ws-dx-approve"]');
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
        this.exportReport(data.format, data.sections);
        return;
      case 'ws-dx-run-selected':
        this.runSelected(target);
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
            // Une nouvelle proposition : le test généré est relu (onglet « Test Playwright »).
            ...(op === 'propose'
              ? {
                  after: () => {
                    this.ws.regressionSpec = undefined;
                  },
                }
              : {}),
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
        if (isSelectionKind(kind) && ref)
          this.select(
            kind,
            ref,
            typeof target.closest === 'function' && target.closest('[data-ws-graph]') !== null,
          );
        return true;
      }
      case 'ws-select-clear':
        this.clearSelection();
        if (!this.host.focus('#ws-pane-details-t')) this.host.focus('#ws-ux-panel');
        return true;
      case 'ws-ux-tab':
        // Un onglet principal (son dernier sous-onglet), ou une clé de vue historique (lien, test).
        if (isMainTab(data.tab)) this.selectMain(data.tab);
        else if (isWorkspaceTab(data.tab)) this.selectTab(data.tab);
        return true;
      case 'ws-ux-sub': {
        const view = viewOf(this.mainTab(), data.sub);
        this.focusedSub = true;
        this.selectTab(view, 'sub');
        return true;
      }
      case 'ws-ux-stage': {
        const stage = data.stage as keyof typeof STAGE_TABS | undefined;
        const tab = stage ? STAGE_TABS[stage] : undefined;
        if (tab) {
          this.focusedSub = false;
          this.selectTab(tab, 'main');
        }
        return true;
      }
      case 'ws-ux-details':
        ws.headOpen = !ws.headOpen;
        this.host.paint();
        this.host.focus('[data-action="ws-ux-details"]');
        return true;
      case 'ws-ux-stepper':
        ws.stepperOpen = !ws.stepperOpen;
        this.host.paint();
        this.savePrefs();
        this.host.focus('[data-action="ws-ux-stepper"]');
        return true;
      case 'ws-ux-compact':
        ws.compact = !ws.compact;
        this.host.paint();
        this.savePrefs();
        this.host.focus('[data-action="ws-ux-compact"]');
        return true;
      case 'ws-pane':
      case 'ws-pane-focus':
      case 'ws-split-reset':
        this.splitAction(action, data);
        if (action === 'ws-pane-focus' && data.pane)
          this.host.focus(`[data-action="ws-pane-focus"][data-pane="${attr(data.pane)}"]`);
        if (action === 'ws-split-reset' && !data.splitter) this.host.focus('[data-action="ws-split-reset"]');
        return true;
      case 'ws-split':
        // Le séparateur se manie au pointeur et au clavier ; un clic seul ne change rien.
        return true;
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
      case 'ws-ux-check':
        this.checkConnectivity();
        return true;
      case 'ws-repro-start':
        this.startReproduction();
        return true;
      case 'ws-repro-stop':
        if (this.refuseInDemo() || !can(this.host.state, 'RUN')) return true;
        ws.repro = reduceReproduction(ws.repro, action, data) ?? ws.repro;
        this.host.paint();
        this.host.focus('[data-action="ws-repro-stop-yes"]');
        return true;
      case 'ws-repro-stop-no':
        ws.repro = reduceReproduction(ws.repro, action, data) ?? ws.repro;
        this.host.paint();
        this.host.focus('[data-action="ws-repro-stop"]');
        return true;
      case 'ws-repro-stop-yes':
        this.stopReproduction();
        return true;
      case 'ws-repro-ev-show': {
        // « Voir les preuves associées » (code, exécution) : la preuve est sélectionnée et Reproduction ›
        // Preuves s'ouvre sur son onglet.
        ws.repro = reduceReproduction(ws.repro, action, data) ?? ws.repro;
        const kind = data.kind;
        if ((kind === 'request' || kind === 'evidence') && data.ref) ws.selection = { kind, id: data.ref };
        this.focusedSub = true;
        this.selectTab('evidence', 'sub');
        return true;
      }
      case 'ws-att-open':
      case 'ws-att-close': {
        const before = ws.att.open;
        ws.att = reduceAttachments(ws.att, action, data) ?? ws.att;
        // L'aperçu s'affiche dans le panneau des détails : rouvert s'il était réduit ou masqué.
        if (ws.att.open !== undefined && ws.split.panes.details !== undefined) {
          const { details: _shown, ...panes } = ws.split.panes;
          ws.split = { ...ws.split, panes };
        }
        this.ensure();
        this.host.paint();
        if (action === 'ws-att-close' && before)
          this.host.focus(`[data-action="ws-att-open"][data-ref="${attr(before)}"]`);
        return true;
      }
      case 'ws-att-retry': {
        const open = ws.att.open;
        if (open && !ws.demo) {
          ws.att = { ...ws.att, content: without(ws.att.content, (key) => key === open) };
          this.ensure();
          this.host.paint();
        }
        return true;
      }
      case 'ws-att-remove':
        if (this.refuseInDemo() || !can(this.host.state, 'RUN')) return true;
        ws.att = reduceAttachments(ws.att, action, data) ?? ws.att;
        this.host.paint();
        // « Garder » d'abord : Entrée ne supprime jamais un fichier par mégarde.
        this.host.focus(`[data-action="ws-att-remove-no"][data-ref="${attr(data.ref ?? '')}"]`);
        return true;
      case 'ws-att-remove-no':
        ws.att = reduceAttachments(ws.att, action, data) ?? ws.att;
        this.host.paint();
        this.host.focus(`[data-action="ws-att-remove"][data-ref="${attr(data.ref ?? '')}"]`);
        return true;
      case 'ws-att-remove-yes':
        if (data.ref) this.removeAttachment(data.ref);
        return true;
      case 'ws-dx-reg-spec':
        // Le test généré (re)lu : l'onglet « Test Playwright » l'affiche dès qu'il arrive.
        if (ws.regressionSpec?.loading) return true;
        ws.regressionSpec = undefined;
        ws.dx = { ...ws.dx, regTab: 'spec' };
        this.ensure();
        this.host.paint();
        return true;
      case 'ws-repro-tab':
      case 'ws-repro-ev-tab':
      case 'ws-repro-req-tab': {
        ws.repro = reduceReproduction(ws.repro, action, data) ?? ws.repro;
        this.ensure();
        this.host.paint();
        const group = data.group as ReproductionTabGroup | undefined;
        if (group) this.host.focus(reproductionTabFocus(ws.repro, group));
        return true;
      }
      case 'ws-dx-reg-tab':
        ws.dx = reduceDiagnosis(ws.dx, action, data) ?? ws.dx;
        this.ensure();
        this.host.paint();
        this.host.focus(`#ws-dx-rt-tab-${ws.dx.regTab}`);
        return true;
    }
    if ((AI_OPERATIONS as readonly string[]).includes(action)) {
      this.aiOperation(action, target);
      return true;
    }
    if ((TRIGGER_OPERATIONS as readonly string[]).includes(action)) {
      this.triggerOperation(action, target);
      return true;
    }
    if (
      (
        [
          'ws-dx-analyze',
          'ws-dx-plan',
          'ws-dx-run',
          'ws-dx-run-selected',
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
      reduceDiagnosis(ws.dx, action, data) ??
      reduceReproduction(ws.repro, action, data) ??
      reduceAi(ws.ai, action, data) ??
      reduceTrigger(ws.trg, action, data);
    if (next === undefined) return true;
    if (action.startsWith('ws-graph-')) ws.graph = next as WorkspaceUi['graph'];
    else if (action.startsWith('ws-timeline-')) ws.timeline = next as WorkspaceUi['timeline'];
    else if (action.startsWith('ws-frontend-trace-')) ws.trace = next as WorkspaceUi['trace'];
    else if (action.startsWith('ws-code-')) {
      ws.code = next as WorkspaceUi['code'];
      // L'arborescence réduite par l'explorateur : son panneau devient un rail (et inversement).
      if (action === 'ws-code-tree-toggle') {
        this.treeAuto = false;
        const { tree: _tree, ...panes } = ws.split.panes;
        ws.split = { ...ws.split, panes: ws.code.treeCollapsed ? { ...panes, tree: 'min' } : panes };
        this.savePrefs();
      }
    } else if (action.startsWith('ws-ux-')) ws.ux = next as WorkspaceUi['ux'];
    else if (action.startsWith('ws-dx-')) ws.dx = next as WorkspaceUi['dx'];
    else if (action.startsWith('ws-repro-')) ws.repro = next as WorkspaceUi['repro'];
    else if (action.startsWith('ws-ai-')) ws.ai = next as WorkspaceUi['ai'];
    else if (action.startsWith('ws-trg-')) ws.trg = next as WorkspaceUi['trg'];
    this.ensure();
    this.host.paint();
    if (action === 'ws-graph-zoom' || action === 'ws-graph-fit' || action === 'ws-graph-reset')
      this.savePrefs();
    if (action === 'ws-dx-approve-cancel' && data.experiment)
      this.host.focus(`[data-action="ws-dx-run"][data-experiment="${attr(data.experiment)}"]`);
    // L'arborescence repliée : son bouton disparaît avec le corps du panneau réduit, le focus va au bouton
    // qui la rouvre (barre du panneau) ; rouverte, il revient sur le bouton de l'explorateur.
    if (action === 'ws-code-tree-toggle') {
      if (ws.code.treeCollapsed) this.host.focus('[data-ws-pane="tree"] .ws-pane-ops [data-op="restore"]');
      else if (!this.host.focus('[data-ws-pane="tree"] [data-action="ws-code-tree-toggle"]'))
        this.host.focus('[data-ws-pane="tree"] .ws-pane-ops [data-op="min"]');
    }
    return true;
  }

  /** L'envoi du formulaire « Planifier une expérience ». */
  submit(form: HTMLFormElement): boolean {
    if (form.dataset.action === 'ws-ai-ask') {
      this.aiOperation('ws-ai-ask', form);
      return true;
    }
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
    if (field === 'code-find' || field === 'code-goto') {
      const action = field === 'code-find' ? 'ws-code-find' : 'ws-code-goto-field';
      ws.code = reduceCode(ws.code, action, { value }) ?? ws.code;
      this.host.paint();
      return true;
    }
    if (field.startsWith('dx.')) {
      ws.dx = reduceDiagnosis(ws.dx, 'ws-dx-field', { field, index: target.dataset.index, value }) ?? ws.dx;
      return true;
    }
    if (field.startsWith('ai.')) {
      ws.ai = reduceAi(ws.ai, 'ws-ai-field', { field, value }) ?? ws.ai;
      if (field === 'ai.extendKey') this.host.paint();
      return true;
    }
    if (field.startsWith('trg.')) {
      ws.trg = reduceTrigger(ws.trg, 'ws-trg-field', { field, value }) ?? ws.trg;
      if (field === 'trg.extendKey') this.host.paint();
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
    const checked = 'checked' in target ? String(target.checked) : undefined;
    switch (action) {
      case 'ws-graph-layout':
        ws.graph = reduceGraph(ws.graph, action, { value: target.value }) ?? ws.graph;
        this.host.paint();
        this.savePrefs();
        return true;
      case 'ws-dx-check':
        ws.dx =
          reduceDiagnosis(ws.dx, action, {
            experiment: target.dataset.experiment,
            ...(checked !== undefined ? { checked } : {}),
          }) ?? ws.dx;
        this.host.paint();
        return true;
      case 'ws-dx-section':
        ws.dx =
          reduceDiagnosis(ws.dx, action, {
            section: target.dataset.section,
            ...(checked !== undefined ? { checked } : {}),
          }) ?? ws.dx;
        this.host.paint();
        return true;
      case 'ws-repro-pick':
        ws.repro = reduceReproduction(ws.repro, action, { value: target.value }) ?? ws.repro;
        this.ensure();
        this.host.paint();
        return true;
      case 'ws-repro-ev-errors':
        ws.repro = reduceReproduction(ws.repro, action, {}) ?? ws.repro;
        this.host.paint();
        return true;
      case 'ws-att-add':
        void this.addAttachments(target as HTMLInputElement);
        return true;
    }
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
    if (target && this.codeKey(event, target)) return true;
    if (event.key === 'Escape') {
      // Un menu déroulant ouvert (« Couches » du graphe…) se ferme d'abord, le focus sur son résumé.
      const menu =
        typeof target?.closest === 'function'
          ? target.closest<HTMLDetailsElement>('details[data-ws-menu][open]')
          : null;
      if (menu) {
        menu.open = false;
        menu.querySelector<HTMLElement>('summary')?.focus();
        return true;
      }
      if (ws.repro.confirmStop) {
        ws.repro = reduceReproduction(ws.repro, 'ws-repro-stop-no', {}) ?? ws.repro;
        this.host.paint();
        this.host.focus('[data-action="ws-repro-stop"]');
        return true;
      }
      if (ws.att.confirmRemove) {
        const id = ws.att.confirmRemove;
        ws.att = reduceAttachments(ws.att, 'ws-att-remove-no', {}) ?? ws.att;
        this.host.paint();
        this.host.focus(`[data-action="ws-att-remove"][data-ref="${attr(id)}"]`);
        return true;
      }
      if (ws.dx.approving) {
        const id = ws.dx.approving;
        ws.dx = reduceDiagnosis(ws.dx, 'ws-dx-approve-cancel', {}) ?? ws.dx;
        this.host.paint();
        this.host.focus(`[data-action="ws-dx-run"][data-experiment="${attr(id)}"]`);
        return true;
      }
      // Un panneau agrandi revient dans la disposition (« plein écran » quitté), le focus sur son bouton.
      if (ws.split.maximized) {
        this.splitAction('ws-pane', { pane: ws.split.maximized, op: 'restore' });
        return true;
      }
      return this.clearSelection();
    }
    if (!target) return false;
    const action = target.dataset.action;
    // Ctrl/Cmd + G dans l'éditeur : « Aller à la ligne ».
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 'g' &&
      typeof target.closest === 'function' &&
      target.closest('[data-ws-pane="editor"]')
    ) {
      event.preventDefault();
      ws.code = reduceCode(ws.code, 'ws-code-goto-open', { open: 'true' }) ?? ws.code;
      this.host.paint();
      this.host.focus('[data-ws-field="code-goto"]');
      return true;
    }
    if (action === 'ws-ux-tab') {
      const context = this.context();
      const keys = context ? mainTabsOf(context.ctx).map((tab) => tab.key) : [];
      const next = rovingTarget(keys, this.mainTab(), event.key);
      if (!next || !isMainTab(next)) return false;
      event.preventDefault();
      this.selectMain(next);
      return true;
    }
    if (action === 'ws-ux-sub') {
      const context = this.context();
      const main = this.mainTab();
      const keys = context ? subTabsOf(context.ctx, main).map((tab) => tab.key) : [];
      const current = VIEW_ROUTES[this.tab()].sub ?? '';
      const next = rovingTarget(keys, current, event.key);
      if (!next) return false;
      event.preventDefault();
      this.focusedSub = true;
      this.selectTab(viewOf(main, next), 'sub');
      return true;
    }
    // Les onglets de l'Exécution et des Preuves (groupes run, ev, req) : flèches, Début, Fin.
    const group = target.dataset.group;
    if (
      (group === 'run' || group === 'ev' || group === 'req') &&
      (action === 'ws-repro-tab' || action === 'ws-repro-ev-tab' || action === 'ws-repro-req-tab') &&
      ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    ) {
      event.preventDefault();
      ws.repro = reduceReproduction(ws.repro, 'ws-repro-key', { group, key: event.key }) ?? ws.repro;
      this.ensure();
      this.host.paint();
      this.host.focus(reproductionTabFocus(ws.repro, group));
      return true;
    }
    // Les onglets du test de non-régression (flow YAML, test Playwright).
    if (action === 'ws-dx-reg-tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const tabs = ['flow', 'spec'] as const;
      const next = rovingTarget(tabs, ws.dx.regTab, event.key);
      if (!next) return false;
      event.preventDefault();
      ws.dx = reduceDiagnosis(ws.dx, 'ws-dx-reg-tab', { tab: next }) ?? ws.dx;
      this.ensure();
      this.host.paint();
      this.host.focus(`#ws-dx-rt-tab-${next}`);
      return true;
    }
    if (target.dataset.wsSplitter !== undefined && isSplitterId(target.dataset.wsSplitter)) {
      const splitter = target.dataset.wsSplitter;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key))
        return false;
      event.preventDefault();
      const zone = target.parentElement;
      const rect = zone?.getBoundingClientRect();
      const total = rect ? (SPLITTERS[splitter].axis === 'x' ? rect.width : rect.height) : 0;
      this.splitAction('ws-split-key', {
        splitter,
        key: event.key,
        shift: String(event.shiftKey),
        ...(total > 0 ? { total: String(total) } : {}),
      });
      if (!this.host.focus(`[data-ws-splitter="${splitter}"]`) && event.key === 'Enter') {
        const pane = SPLITTERS[splitter].first;
        this.host.focus(`[data-ws-pane="${pane}"] .ws-pane-ops [data-op="restore"]`);
      }
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

  /**
   * Le clavier de l'éditeur : Entrée / Maj+Entrée dans « Rechercher » (occurrence suivante, précédente),
   * Entrée et Échap dans « Aller à la ligne », flèches / Début / Fin / Suppr sur un onglet de fichier.
   */
  private codeKey(event: KeyboardEvent, target: HTMLElement): boolean {
    const ws = this.ws;
    const field = target.dataset.wsField;
    let action: string | undefined;
    let data: Record<string, string | undefined> = {};
    let focus: string | undefined;
    if (field === 'code-find' && event.key === 'Enter') {
      action = event.shiftKey ? 'ws-code-find-prev' : 'ws-code-find-next';
      focus = '[data-ws-field="code-find"]';
    } else if (field === 'code-goto' && event.key === 'Enter') {
      action = 'ws-code-goto-submit';
      data = { ...datasetOf(target) };
      focus = '[data-ws-field="code-goto"]';
    } else if (field === 'code-goto' && event.key === 'Escape') {
      action = 'ws-code-goto-open';
      data = { open: 'false' };
      focus = '[data-action="ws-code-goto-open"]';
    } else if (
      target.dataset.action === 'ws-code-tab' &&
      ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key)
    ) {
      action = 'ws-code-tab-key';
      data = { key: event.key };
    }
    if (!action) return false;
    event.preventDefault();
    const next = reduceCode(ws.code, action, data);
    if (next) ws.code = next;
    this.ensure();
    this.host.paint();
    if (action === 'ws-code-tab-key') {
      if (!this.host.focus(`#ws-code-tab-${String(ws.code.active ?? 0)}`))
        this.host.focus('[data-ws-pane="editor"] .ws-code-scroll');
    } else if (action === 'ws-code-goto-submit' && !ws.code.gotoOpen) {
      this.host.focus('[data-ws-pane="editor"] .ws-code-scroll');
    } else if (focus && !this.host.focus(focus)) this.host.focus('[data-ws-pane="editor"] .ws-code-scroll');
    return true;
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
    if (this.splitDown(event)) return true;
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
      layout: layoutGraph(
        visibleGraph(graph, graphHidden(this.ws.graph.hidden, canvas.dataset.focus)),
        this.ws.graph.layout,
      ),
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
      const scale = Number(canvas.dataset.upp) || drag.w / width;
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

  /**
   * Le glisser d'un séparateur : capture du pointeur, la grille de la zone suit en direct (sans redessin),
   * l'état et les préférences au relâcher. Deux appuis rapprochés : la taille par défaut.
   */
  private splitDown(event: PointerEvent): boolean {
    const element = (event.target as Element | null)?.closest<HTMLElement>('[data-ws-splitter]');
    const splitter = element?.dataset.wsSplitter;
    if (!element || !isSplitterId(splitter) || event.button !== 0) return false;
    const zone = element.parentElement;
    if (!zone) return false;
    event.preventDefault();
    const now = Date.now();
    const last = this.lastSplitDown;
    this.lastSplitDown = { splitter, at: now };
    if (last?.splitter === splitter && now - last.at < DOUBLE_MS) {
      this.lastSplitDown = undefined;
      this.splitAction('ws-split-reset', { splitter });
      this.host.focus(`[data-ws-splitter="${splitter}"]`);
      return true;
    }
    const layout = this.layout();
    const drag: SplitDrag = { pointerId: event.pointerId, splitter, element, zone, layout };
    this.splitDrag = drag;
    element.focus();
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Le pointeur n'est plus actif : le glisser continue sans capture.
    }
    element.classList.add('ws-dragging');
    const axis = SPLITTERS[splitter].axis;
    const split = element.closest<HTMLElement>('.ws-split');
    split?.classList.add('ws-resizing', ...(axis === 'y' ? ['ws-resizing-y'] : []));
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== drag.pointerId) return;
      const rect = zone.getBoundingClientRect();
      const total = axis === 'x' ? rect.width : rect.height;
      if (total <= 0) return;
      const offset = axis === 'x' ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
      const sizes = this.ws.split.sizes;
      drag.value = clampSplit(splitter, offset / total, sizes, total);
      this.liveSplit(drag);
    };
    const end = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== drag.pointerId) return;
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', end);
      element.removeEventListener('pointercancel', end);
      element.classList.remove('ws-dragging');
      split?.classList.remove('ws-resizing', 'ws-resizing-y');
      this.splitDrag = undefined;
      if (drag.value === undefined) return;
      const rect = zone.getBoundingClientRect();
      const total = axis === 'x' ? rect.width : rect.height;
      this.splitAction('ws-split-set', {
        splitter,
        value: String(drag.value),
        ...(total > 0 ? { total: String(total) } : {}),
      });
      this.host.focus(`[data-ws-splitter="${splitter}"]`);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    return true;
  }

  /** La grille de la zone suit le séparateur pendant le glisser (style posé directement, sans redessin). */
  private liveSplit(drag: SplitDrag): void {
    if (drag.value === undefined) return;
    const preview: SplitUi = {
      ...this.ws.split,
      sizes: { ...this.ws.split.sizes, [drag.splitter]: drag.value },
    };
    const present = [
      ...(drag.zone.closest('.ws-split')?.querySelectorAll<HTMLElement>('[data-ws-pane]') ?? []),
    ].map((pane) => pane.dataset.wsPane as PaneId);
    const templates = splitTemplates(preview, drag.layout, present);
    const grid = drag.zone.dataset.wsGrid;
    if (grid === 'rows' && templates.rows) drag.zone.style.gridTemplateRows = templates.rows;
    else if (grid === 'top' && templates.top) drag.zone.style.gridTemplateColumns = templates.top;
    else if (grid === 'bottom' && templates.bottom) drag.zone.style.gridTemplateColumns = templates.bottom;
    else if (grid === 'doc' && templates.doc) drag.zone.style.gridTemplateColumns = templates.doc;
    drag.element.setAttribute('aria-valuenow', String(Math.round(drag.value * 100)));
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

  /** Les zones qui défilent, par clé stable : panneau (et vue), sélecteur, rang dans le panneau. */
  private scrollTargets(root: ShadowRoot, view: WorkspaceTab = this.tab()): [string, HTMLElement][] {
    const found: [string, HTMLElement][] = [];
    for (const selector of SCROLLERS) {
      const ranks = new Map<string, number>();
      root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
        const pane = element.closest<HTMLElement>('[data-ws-pane]')?.dataset.wsPane ?? '';
        const scope = VIEW_PANES.has(pane) ? `${pane}@${view}` : pane;
        const rank = ranks.get(scope) ?? 0;
        ranks.set(scope, rank + 1);
        found.push([`${scope}|${selector}#${String(rank)}`, element]);
      });
    }
    return found;
  }

  /**
   * Le cadre du graphe est observé : quand sa taille change d'au moins 8 px, `ws-graph-viewport` lui donne
   * la nouvelle taille (au plus une fois par image) et la vue se redessine ajustée au cadre.
   */
  private observeGraph(root: ShadowRoot): void {
    if (typeof ResizeObserver === 'undefined') return;
    const canvas = root.querySelector<HTMLElement>('[data-ws-graph="canvas"]');
    if (canvas === this.observed) return;
    this.resizer ??= new ResizeObserver(() => {
      if (this.viewportFrame !== undefined) return;
      this.viewportFrame = requestAnimationFrame(() => {
        this.viewportFrame = undefined;
        this.measureGraph();
      });
    });
    if (this.observed) this.resizer.unobserve(this.observed);
    this.observed = canvas ?? undefined;
    if (canvas) this.resizer.observe(canvas);
  }

  private measureGraph(): void {
    const canvas = this.observed as HTMLElement | undefined;
    if (!canvas?.isConnected || this.drag || this.splitDrag || !this.route()) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const ws = this.ws;
    const previous = ws.graph.viewport;
    if (
      previous &&
      Math.abs(previous.width - width) < VIEWPORT_STEP_PX &&
      Math.abs(previous.height - height) < VIEWPORT_STEP_PX
    )
      return;
    const next = reduceGraph(ws.graph, 'ws-graph-viewport', { w: String(width), h: String(height) });
    if (!next || next === ws.graph) return;
    ws.graph = next;
    this.host.paint();
  }

  /** Avant un dessin : le défilement des zones et les détails ouverts sont notés ; un glisser est validé. */
  beforePaint(): void {
    // Ce que les écrans lisent à chaque dessin : l'heure (temps écoulé), l'opération en cours,
    // l'environnement du projet de l'incident (URL du test de connectivité).
    const ws = this.ws;
    ws.now = Date.now();
    ws.busy = this.ui.busy;
    const incident = this.ui.incident;
    const environment = incident
      ? environmentRefOf(this.host.state.project?.environments, incident)
      : undefined;
    if (environment) ws.environment = environment;
    else delete ws.environment;
    const drag = this.drag;
    if (drag?.moved && drag.next) {
      this.ws.graph = drag.next;
      drag.base = drag.next;
      drag.startX = Number.NaN;
    }
    const root = this.host.root;
    if (!root.querySelector('.ws-root')) return;
    for (const [key, element] of this.scrollTargets(root, this.paintedView ?? this.tab())) {
      if (element.scrollTop > 0 || element.scrollLeft > 0)
        this.scrolls.set(key, { top: element.scrollTop, left: element.scrollLeft });
      else this.scrolls.delete(key);
    }
    this.opened.clear();
    root.querySelectorAll<HTMLDetailsElement>('.ws-root details').forEach((details) => {
      this.opened.set(detailsKey(details), details.open);
    });
  }

  /** Après un dessin : défilements et détails rétablis ; une ligne de code nouvellement visée est montrée. */
  afterPaint(): void {
    const root = this.host.root;
    if (!root.querySelector('.ws-root')) return;
    this.paintedView = this.tab();
    if (this.drag && Number.isNaN(this.drag.startX)) this.drag = undefined;
    for (const [key, element] of this.scrollTargets(root)) {
      const saved = this.scrolls.get(key);
      if (!saved) continue;
      element.scrollTop = saved.top;
      element.scrollLeft = saved.left;
    }
    this.observeGraph(root);
    root.querySelectorAll<HTMLDetailsElement>('.ws-root details').forEach((details) => {
      const open = this.opened.get(detailsKey(details));
      if (open !== undefined) details.open = open;
    });
    root.querySelectorAll<HTMLElement>('[data-ws-zone]').forEach((zone) => {
      const name = zone.dataset.wsZone ?? '';
      zone.querySelectorAll<HTMLElement>('.ws-code-scroll').forEach((scroller, index) => {
        const key = `${name}#${String(index)}`;
        // L'éditeur : sa clé `data-ws-target` (application|fichier|ligne|occurrence) a changé → la ligne visée
        // est centrée ; sinon le défilement gardé reste. Les extraits : la ligne `ws-code-sel`.
        const editorKey = scroller.dataset.wsTarget;
        const selected =
          editorKey !== undefined
            ? scroller.querySelector<HTMLElement>('.ws-code-target')
            : scroller.querySelector<HTMLElement>('.ws-code-sel');
        if (!selected) return;
        const label =
          editorKey ?? `${scroller.getAttribute('aria-label') ?? ''}|${selected.textContent.slice(0, 40)}`;
        if (this.codeTargets.get(key) === label) return;
        this.codeTargets.set(key, label);
        const box = scroller.getBoundingClientRect();
        const line = selected.getBoundingClientRect();
        scroller.scrollTop += line.top - box.top - box.height / 2 + line.height / 2;
      });
    });
    // Les bornes annoncées par chaque séparateur (motif ARIA « window splitter ») tiennent compte de la place
    // réelle de sa zone : le rendu ne connaît que les bornes relatives.
    root.querySelectorAll<HTMLElement>('[data-ws-splitter]').forEach((handle) => {
      const id = handle.dataset.wsSplitter;
      if (!isSplitterId(id)) return;
      const rect = handle.parentElement?.getBoundingClientRect();
      const total = rect ? (SPLITTERS[id].axis === 'x' ? rect.width : rect.height) : 0;
      if (total <= 0) return;
      const bounds = splitBounds(id, this.ws.split.sizes, total);
      handle.setAttribute('aria-valuemin', String(Math.round(bounds.min * 100)));
      handle.setAttribute('aria-valuemax', String(Math.round(bounds.max * 100)));
      // La valeur dite est la position RENDUE (bornée par la place réelle), pas la fraction mémorisée.
      const now = clampSplit(id, this.ws.split.sizes[id], this.ws.split.sizes, total);
      handle.setAttribute('aria-valuenow', String(Math.round(now * 100)));
    });
    // L'onglet de fichier actif reste visible dans sa barre (quand il change).
    const activeTab = root.querySelector<HTMLElement>('.ws-code-tab[aria-selected="true"]');
    const tabKey = activeTab ? `${activeTab.id}|${activeTab.title}` : '';
    if (activeTab && tabKey !== this.activeCodeTab && typeof activeTab.scrollIntoView === 'function')
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.activeCodeTab = tabKey;
    // L'étape actuelle reste visible dans la ligne de la progression (quand elle change).
    const step = root.querySelector<HTMLElement>('.ws-ux-steps-row [aria-current="step"]');
    const stepKey = step?.dataset.stage ?? '';
    if (step && stepKey !== this.stepperCurrent) scrollIntoRow(step);
    this.stepperCurrent = stepKey;
    this.tickElapsed(root);
  }

  /**
   * Le compteur du temps écoulé : chaque seconde, `[data-ws-ticking="true"]` reçoit le temps depuis
   * `data-ws-elapsed-from` (sans redessin) ; il s'arrête quand plus aucun tel élément n'est affiché.
   */
  private tickElapsed(root: ShadowRoot): void {
    if (!root.querySelector('[data-ws-ticking="true"]')) {
      this.stopTicker();
      return;
    }
    if (this.ticker !== undefined) return;
    this.ticker = setInterval(() => {
      const ticking = [...this.host.root.querySelectorAll<HTMLElement>('[data-ws-ticking="true"]')];
      if (ticking.length === 0 || !this.route()) {
        this.stopTicker();
        return;
      }
      const now = Date.now();
      for (const element of ticking) {
        const from = Date.parse(element.dataset.wsElapsedFrom ?? '');
        if (Number.isFinite(from)) element.textContent = formatElapsed(now - from);
      }
    }, ELAPSED_TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** Le compteur est-il actif (tests) ? */
  get ticking(): boolean {
    return this.ticker !== undefined;
  }
}
