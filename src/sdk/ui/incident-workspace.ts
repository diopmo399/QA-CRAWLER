import {
  incidentReproduction,
  type CodeLayer,
  type EnvironmentCapabilities,
  type Evidence,
  type Incident,
  type InvestigationReport,
  type SourceFileView,
  type SourceTree,
  type TimelineEvent,
} from '../core/incident-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import {
  emptyAttachmentsUi,
  renderAttachmentsCard,
  renderAttachmentView,
  type AttachmentsUi,
} from './incident-attachments.js';
import {
  codeTarget,
  emptyCodeUi,
  openCodeFiles,
  renderCodeExcerpt,
  renderCodeWorkspace,
  type CodeLoadState,
  type CodeUi,
} from './incident-code.js';
import {
  emptyDiagnosisUi,
  renderDiagnosisBoard,
  renderExperimentDetail,
  renderExperiments,
  renderHypotheses,
  renderHypothesisDetail,
  renderRegressionTest,
  renderReportExport,
  type DiagnosisUi,
  type RegressionSpecView,
  type ReportViewState,
} from './incident-diagnosis.js';
import { AI_OPERATIONS, emptyAiUi, renderAiInvestigation, type AiUi } from './incident-ai.js';
import {
  TRIGGER_OPERATIONS,
  emptyTriggerUi,
  renderTriggerSection,
  shownTriggerRun,
  type TriggerUi,
} from './incident-trigger.js';
import {
  emptyFrontendTraceUi,
  renderFrontendStepDetail,
  renderFrontendTrace,
  type FrontendTraceUi,
} from './incident-frontend-trace.js';
import {
  emptyGraphUi,
  renderGraph,
  renderGraphDetail,
  renderRelationsTable,
  type GraphUi,
} from './incident-graph.js';
import {
  fileId,
  selectionKey,
  sourceOf,
  stepId,
  workspaceLinks,
  type SelectionKind,
  type WorkspaceLinks,
  type WorkspaceSelection,
} from './incident-links.js';
import {
  evidenceChips,
  panelState,
  partsText,
  selectable,
  selectionClass,
  sourceLink,
  workspaceContext,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import {
  emptyReproductionUi,
  renderEvidence,
  renderReproductionRun,
  type ReproductionMedia,
  type ReproductionUi,
  type ShotView,
} from './incident-reproduction.js';
import {
  emptyTimelineUi,
  renderLogs,
  renderRequestDetail,
  renderRequests,
  renderScreenshot,
  renderTimeline,
  type TimelineUi,
} from './incident-timeline.js';
import {
  emptySplitUi,
  INCIDENT_SPLIT_CSS,
  isSubTabOf,
  MAIN_TABS,
  renderHiddenBar,
  renderSplitLayout,
  splitText,
  SUB_TABS,
  type MainTab,
  type PaneId,
  type PaneSpec,
  type SplitLayout,
  type SplitUi,
  type SubTab,
} from './incident-split.js';
import {
  emptyUxUi,
  renderEnvironmentSelector,
  renderOverview,
  renderStepper,
  renderTabPanel,
  renderTabs,
  renderWorkspaceHeader,
  uxText,
  type EnvironmentRef,
  type UxTab,
  type UxUi,
  type WorkspaceStage,
} from './incident-ux.js';
import { esc } from './view.js';

/**
 * LA COQUILLE DE L'ESPACE D'INVESTIGATION : l'en-tête, la progression, les onglets, la zone principale
 * (le contenu de l'onglet, le graphe full-stack quand l'onglet n'est pas déjà le graphe, le panneau
 * contextuel de la sélection). Elle assemble les vues des modules (`incident-ux`, `-graph`, `-timeline`,
 * `-frontend-trace`, `-code`, `-diagnosis`) sur un seul contexte : la même sélection, les mêmes liens,
 * les mêmes droits. Des fonctions pures : l'état (`WorkspaceUi`) est tenu par le contrôleur, qui lit
 * l'arborescence, les fichiers, les captures, le rapport et les capacités et les range ici.
 */

/** L'identifiant de route de la démonstration (`{ view: 'incident', incidentId: 'demo' }`). */
export const DEMO_INCIDENT_ID = 'demo';

export const isDemoIncident = (incidentId: string | undefined): boolean => incidentId === DEMO_INCIDENT_ID;

// ── Onglets ──────────────────────────────────────────────────────────────────────────────────

/**
 * Les CLÉS DE VUE (la route `tab`) : les quinze clés historiques, qui restent valables (progression,
 * liens, actions), plus `run` et `evidence` (Reproduction › Exécution, Preuves) et `code`. Chaque clé désigne un onglet principal et un sous-onglet (`VIEW_ROUTES`).
 */
export const WORKSPACE_TABS = [
  'overview',
  'scope',
  'environment',
  'run',
  'evidence',
  'timeline',
  'traceability',
  'requests',
  'frontend',
  'bff',
  'backend',
  'logs',
  'hypotheses',
  'experiments',
  'diagnosis',
  'ai',
  'tbrief',
  'tdiscovery',
  'texplorer',
  'tlive',
  'tevents',
  'tmatrix',
  'tminimal',
  'tangular',
  'tcauses',
  'tproposal',
  'report',
  'regression',
  'code',
] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const isWorkspaceTab = (value: string | undefined): value is WorkspaceTab =>
  (WORKSPACE_TABS as readonly string[]).includes(value ?? '');

/** L'onglet principal et le sous-onglet de chaque clé de vue. */
export const VIEW_ROUTES: Readonly<Record<WorkspaceTab, { tab: MainTab; sub?: SubTab }>> = {
  overview: { tab: 'overview', sub: 'summary' },
  scope: { tab: 'overview', sub: 'scope' },
  environment: { tab: 'overview', sub: 'environment' },
  run: { tab: 'timeline', sub: 'run' },
  evidence: { tab: 'timeline', sub: 'evidence' },
  timeline: { tab: 'timeline', sub: 'events' },
  logs: { tab: 'timeline', sub: 'logs' },
  traceability: { tab: 'traceability', sub: 'fullstack' },
  requests: { tab: 'traceability', sub: 'http' },
  frontend: { tab: 'traceability', sub: 'frontend' },
  bff: { tab: 'traceability', sub: 'bff' },
  backend: { tab: 'traceability', sub: 'backend' },
  hypotheses: { tab: 'diagnosis', sub: 'hypotheses' },
  experiments: { tab: 'diagnosis', sub: 'experiments' },
  diagnosis: { tab: 'diagnosis', sub: 'diagnosis' },
  ai: { tab: 'diagnosis', sub: 'ai' },
  tbrief: { tab: 'trigger', sub: 'brief' },
  tdiscovery: { tab: 'trigger', sub: 'discovery' },
  texplorer: { tab: 'trigger', sub: 'explorer' },
  tlive: { tab: 'trigger', sub: 'live' },
  tevents: { tab: 'trigger', sub: 'chronology' },
  tmatrix: { tab: 'trigger', sub: 'matrix' },
  tminimal: { tab: 'trigger', sub: 'minimal' },
  tangular: { tab: 'trigger', sub: 'angular' },
  tcauses: { tab: 'trigger', sub: 'causes' },
  tproposal: { tab: 'trigger', sub: 'proposal' },
  report: { tab: 'report', sub: 'report' },
  regression: { tab: 'report', sub: 'regression' },
  code: { tab: 'code' },
};

/** La clé de vue d'un onglet principal et d'un sous-onglet (le premier sous-onglet par défaut). */
export function viewOf(tab: MainTab, sub?: string): WorkspaceTab {
  const wanted = sub !== undefined && isSubTabOf(tab, sub) ? sub : SUB_TABS[tab][0];
  const found = WORKSPACE_TABS.find((key) => {
    const route = VIEW_ROUTES[key];
    return route.tab === tab && route.sub === wanted;
  });
  return found ?? (tab === 'code' ? 'code' : 'overview');
}

/** La clé de vue d'un clic sur un onglet principal : le dernier sous-onglet ouvert de cet onglet. */
export function viewOfMain(tab: MainTab, subs: Partial<Record<MainTab, SubTab>>): WorkspaceTab {
  return viewOf(tab, subs[tab]);
}

/** L'onglet ouvert par chaque étape de la progression. */
export const STAGE_TABS: Record<WorkspaceStage, WorkspaceTab> = {
  description: 'overview',
  scope: 'scope',
  environment: 'environment',
  reproduction: 'run',
  evidence: 'evidence',
  code: 'code',
  traceability: 'traceability',
  diagnosis: 'diagnosis',
  report: 'report',
  regression: 'regression',
};

/** La couche de code d'une vue (Frontend, BFF, Backend). */
export const LAYER_TABS: Partial<Record<WorkspaceTab, CodeLayer>> = {
  frontend: 'FRONTEND',
  bff: 'BFF',
  backend: 'BACKEND',
};

/** La vue d'une couche de code. */
export const tabOfLayer = (layer: CodeLayer): WorkspaceTab =>
  layer === 'FRONTEND' ? 'frontend' : layer === 'BFF' ? 'bff' : 'backend';

/** Les onglets principaux qui montrent l'éditeur de code (zone basse de la disposition en panneaux). */
export const CODE_MAIN_TABS: readonly MainTab[] = ['traceability', 'code'];

/** Les vues de document dont le panneau des détails n'apparaît qu'avec une sélection. */
export const FULL_WIDTH_VIEWS: readonly WorkspaceTab[] = [
  'scope',
  'environment',
  'run',
  'evidence',
  'diagnosis',
  'ai',
  'tbrief',
  'tdiscovery',
  'texplorer',
  'tlive',
  'tevents',
  'tmatrix',
  'tminimal',
  'tangular',
  'tcauses',
  'tproposal',
  'report',
  'regression',
];

/** La disposition d'un onglet principal. */
export const layoutOf = (tab: MainTab): SplitLayout =>
  tab === 'traceability' ? 'trace' : tab === 'code' ? 'code' : 'document';

// ── État ─────────────────────────────────────────────────────────────────────────────────────

/** Une lecture : en cours, refusée (403), en échec (message). */
export type LoadState = 'loading' | 'denied' | { error: string };

/** Un fichier lu (ou en lecture) : la révision de l'incident qui a calculé ses lignes signalées. */
export interface SourceEntry {
  view?: SourceFileView;
  revision: number;
  state?: LoadState;
}

export interface ShotEntry {
  dataUrl?: string;
  state?: LoadState;
}

export interface WorkspaceUi {
  /** L'incident dont l'état est tenu (un autre incident repart de zéro). */
  incidentId?: string;
  /** Données de démonstration : aucun appel au serveur, actions désactivées. */
  demo: boolean;
  /** La sélection partagée par toutes les vues. */
  selection?: WorkspaceSelection;
  ux: UxUi;
  graph: GraphUi;
  timeline: TimelineUi;
  trace: FrontendTraceUi;
  code: CodeUi;
  dx: DiagnosisUi;
  /** L'investigation IA (mode, profondeur, section, mémoire lue, brouillons). */
  ai: AiUi;
  /** La découverte des déclencheurs (profondeur, description, run et essai affichés, rapport lu). */
  trg: TriggerUi;
  /** Reproduction › Exécution et Preuves (onglets, reproduction choisie, confirmation d'« Arrêter »). */
  repro: ReproductionUi;
  /** Les pièces jointes (aperçu, contenu lu, retrait confirmé, fichiers écartés). */
  att: AttachmentsUi;
  /** Le test Playwright généré (`incidents.regressionSpec`), lu à la demande. */
  regressionSpec?: RegressionSpecView;
  /** L'heure du dessin (ms) : le temps écoulé d'une reproduction (posée par le contrôleur avant chaque dessin). */
  now?: number;
  /** L'opération du serveur en cours (posée par le contrôleur avant chaque dessin). */
  busy?: string;
  /** L'environnement du projet de l'incident (posé par le contrôleur) : URL de « Tester la connectivité ». */
  environment?: EnvironmentRef;
  /** L'arborescence du périmètre (lue une fois par incident). */
  tree?: SourceTree;
  treeState?: LoadState;
  /** Les fichiers lus, par clé `application:fichier` (petit cache). */
  sources: Record<string, SourceEntry>;
  /** Les captures d'écran lues, par clé `reproduction|fichier`. */
  shots: Record<string, ShotEntry>;
  report?: InvestigationReport;
  reportState: ReportViewState;
  capabilities?: EnvironmentCapabilities;
  capabilitiesState?: LoadState;
  /** La disposition en panneaux (tailles, panneaux réduits, masqués, agrandi). */
  split: SplitUi;
  /** Le dernier sous-onglet ouvert de chaque onglet principal. */
  subs: Partial<Record<MainTab, SubTab>>;
  /** La divulgation « Détails » de l'en-tête. */
  headOpen: boolean;
  /** La progression dépliée (dix étapes) ou repliée sur sa ligne. */
  stepperOpen: boolean;
  /** Le mode compact (espacements resserrés). */
  compact: boolean;
}

export function emptyWorkspaceUi(incidentId?: string, demo = false): WorkspaceUi {
  return {
    ...(incidentId ? { incidentId } : {}),
    demo,
    ux: emptyUxUi(),
    graph: emptyGraphUi(),
    timeline: emptyTimelineUi(),
    trace: emptyFrontendTraceUi(),
    code: emptyCodeUi(),
    dx: emptyDiagnosisUi(),
    ai: emptyAiUi(),
    trg: emptyTriggerUi(),
    repro: emptyReproductionUi(),
    att: emptyAttachmentsUi(),
    sources: {},
    shots: {},
    reportState: {},
    split: emptySplitUi(),
    subs: {},
    headOpen: false,
    stepperOpen: false,
    compact: false,
  };
}

/** La clé d'une capture d'écran. */
export const shotKey = (reproduction: string, file: string): string => `${reproduction}|${file}`;

/**
 * L'environnement du projet de l'incident : celui qu'il désigne (`environmentId`), sinon le premier du
 * projet ; aucun : rien (le test de connectivité ne vise alors que les URL des applications).
 */
export function environmentRefOf(
  environments: readonly EnvironmentRef[] | undefined,
  incident: Pick<Incident, 'environmentId'>,
): EnvironmentRef | undefined {
  const list = environments ?? [];
  const found = list.find((entry) => entry.id === incident.environmentId) ?? list[0];
  return found ? { id: found.id, name: found.name, kind: found.kind, baseUrl: found.baseUrl } : undefined;
}

/**
 * Ce que les écrans de la reproduction reçoivent en plus de l'incident : les captures lues (démonstration :
 * absentes), l'heure du dessin et l'opération du serveur en cours.
 */
export function reproductionMedia(ws: WorkspaceUi): ReproductionMedia {
  const shot = (reproduction: string, file: string): ShotView | undefined => {
    if (ws.demo) return { state: 'absent' };
    const entry = ws.shots[shotKey(reproduction, file)];
    if (!entry) return undefined;
    return {
      ...(entry.dataUrl ? { dataUrl: entry.dataUrl } : {}),
      ...(entry.state ? { state: entry.state } : {}),
    };
  };
  return { shot, ...(ws.now !== undefined ? { now: ws.now } : {}), ...(ws.busy ? { busy: ws.busy } : {}) };
}

// ── Contexte ─────────────────────────────────────────────────────────────────────────────────

/** Les liens d'un incident : calculés une fois par incident lu (un redessin ne les recalcule pas). */
const LINKS = new WeakMap<Incident, WorkspaceLinks>();

export function linksOf(incident: Incident): WorkspaceLinks {
  let links = LINKS.get(incident);
  if (!links) {
    links = workspaceLinks(incident);
    LINKS.set(incident, links);
  }
  return links;
}

export function workspaceCtx(
  incident: Incident,
  ws: WorkspaceUi,
  lang: Lang,
  can: WorkspaceContext['can'],
): WorkspaceContext {
  return workspaceContext({
    incident,
    lang,
    ...(ws.selection ? { selection: ws.selection } : {}),
    links: linksOf(incident),
    demo: ws.demo,
    // Le bandeau de démonstration est dit une fois, dans l'en-tête : les vues ne le répètent pas.
    demoInShell: true,
    can,
  });
}

/** Le contexte des vues du code : sans le droit de lecture quand le serveur a refusé l'accès (403). */
export function codeCtxOf(ctx: WorkspaceContext, ws: WorkspaceUi): WorkspaceContext {
  if (ws.treeState !== 'denied') return ctx;
  return { ...ctx, can: (right) => right !== 'RUN' && ctx.can(right) };
}

/**
 * Les fichiers que la vue affichée lit : l'endroit de la sélection (panneau des détails), les onglets
 * ouverts de l'éditeur (`openCodeFiles`, l'actif d'abord) sur les onglets Traçabilité et Code, et, sur une
 * vue de couche sans fichier ouvert, le fichier de départ de la couche.
 */
export function neededSources(
  ctx: WorkspaceContext,
  ws: WorkspaceUi,
  tab: WorkspaceTab,
): { applicationId: string; file: string }[] {
  const needed: { applicationId: string; file: string }[] = [];
  const seen = new Set<string>();
  const add = (location: { applicationId: string; file: string }): void => {
    const key = fileId(location.applicationId, location.file);
    if (seen.has(key)) return;
    seen.add(key);
    needed.push({ applicationId: location.applicationId, file: location.file });
  };
  const selected = sourceOf(ctx.links, ctx.selection);
  if (selected) add(selected);
  if (CODE_MAIN_TABS.includes(VIEW_ROUTES[tab].tab)) {
    for (const file of openCodeFiles(ws.code)) add(file);
    const layer = LAYER_TABS[tab];
    if (layer && ws.code.tabs.length === 0) {
      const target = codeTarget(ctx, ws.code, layer, ws.tree);
      if (target) add(target);
    }
  }
  return needed;
}

/** La preuve désignée (reproductions et vérifications). */
export function evidenceOf(incident: Incident, id: string): Evidence | undefined {
  for (const run of incident.investigation.reproductions) {
    const found = run.evidence.find((item) => item.id === id);
    if (found) return found;
  }
  for (const experiment of incident.investigation.experiments) {
    const found = experiment.evidence.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}

/** La capture d'écran qu'une sélection demande (preuve SCREENSHOT avec reproduction et fichier). */
export function screenshotOf(
  incident: Incident,
  selection: WorkspaceSelection | undefined,
): { reproduction: string; file: string; label: string } | undefined {
  if (selection?.kind !== 'evidence') return undefined;
  const evidence = evidenceOf(incident, selection.id);
  if (evidence?.kind !== 'SCREENSHOT' || !evidence.source.file || !evidence.source.reproduction)
    return undefined;
  return { reproduction: evidence.source.reproduction, file: evidence.source.file, label: evidence.summary };
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    workspace: 'Espace d’investigation',
    graphZone: 'Graphe full-stack de l’incident',
    panel: 'Détail de la sélection',
    clear: 'Vider la sélection',
    clearHint: 'Échap vide aussi la sélection.',
    kinds: {
      node: 'Nœud du graphe',
      edge: 'Relation du graphe',
      request: 'Requête HTTP',
      event: 'Événement de la chronologie',
      evidence: 'Preuve',
      symbol: 'Symbole du code',
      file: 'Fichier',
      hypothesis: 'Hypothèse',
      experiment: 'Expérience',
      step: 'Étape de la reproduction',
    } as Record<SelectionKind, string>,
    code: 'Code relié',
    codeLoading: 'Lecture du fichier…',
    notInDemo: 'Ce fichier n’est pas inclus dans les données de démonstration.',
    shotNotInDemo: 'La capture d’écran n’est pas incluse dans les données de démonstration.',
    shotDenied: 'Votre rôle ne permet pas de voir les captures d’écran.',
    codeDenied: 'Votre rôle ne permet pas de lire le code du périmètre.',
    unknown: 'Cet élément n’existe plus dans l’investigation (relue entre-temps).',
    evidenceKind: 'Nature',
    at: 'Heure',
    reproduction: 'Reproduction',
    step: (index: number) => `Étape ${String(index)}`,
    stepLabel: 'Étape',
    file: 'Fichier',
    experiment: 'Expérience',
    data: 'Données',
    eventStatus: 'Statut',
    layer: 'Couche',
    related: 'Requête reliée',
    evidence: 'Preuves',
    action: 'Action',
    durationLabel: 'Durée',
    duration: (ms: number) => `${String(ms)} ms`,
    reason: 'Raison',
    cancelled: (from: string) =>
      `Investigation annulée à l’état « ${from} » : les preuves restent lisibles, la reprendre pour continuer.`,
    cancelledPlain: 'Investigation annulée : les preuves restent lisibles, la reprendre pour continuer.',
    failed:
      'L’investigation est en échec : lire l’erreur ci-dessous, corriger, puis relancer la reproduction.',
    failedRun: (error: string) => `Dernière reproduction : ${error}`,
    demoWhy:
      'Données de démonstration : action indisponible. Les boutons qui modifient l’incident ou interrogent le serveur sont désactivés ; la navigation, la sélection et l’exploration restent possibles.',
    capabilitiesError: (message: string) => `Capacités non lues : ${message}`,
    relations: 'Toutes les relations',
    fileFailed: (file: string, message: string) => `Fichier ${file} non lu : ${message}`,
    fileDenied: 'Lecture du code refusée : votre rôle ne le permet pas.',
    treeFailed: (message: string) => `Arborescence du code non lue : ${message}`,
    primary: {
      fullstack: 'Graphe full-stack',
      frontend: 'Traçabilité frontend',
      bff: 'Graphe : couche BFF',
      backend: 'Graphe : couche Backend',
      requests: 'Requêtes HTTP',
    },
    primaryShort: { frontend: 'Frontend', requests: 'Requêtes' },
    codeTree: 'Fichiers du périmètre',
    codeEditor: 'Code (lecture seule)',
    codeEvidence: 'Lignes signalées et preuves',
    seeDetail: 'Voir le détail',
    compact: 'Mode compact',
    compactHint: 'Resserrer les espacements de l’espace d’investigation',
    noConnectivityTarget:
      'Aucune URL à tester : ni l’environnement du projet ni les applications du périmètre n’en déclarent.',
    attachmentsAdded: (count: number) => `${String(count)} pièce(s) jointe(s) ajoutée(s).`,
    attachmentRemoved: 'Pièce jointe retirée.',
    dxMore: 'Alternatives, éléments manquants et recommandations du diagnostic',
    dxAlternatives: 'Causes alternatives',
    dxMissing: 'Éléments manquants pour conclure',
    dxRecommendations: 'Recommandations',
    dxNone: 'Aucun.',
    dxConfidence: (percent: number) => `${String(percent)} %`,
  },
  en: {
    workspace: 'Investigation workspace',
    graphZone: 'Full-stack graph of the incident',
    panel: 'Selection detail',
    clear: 'Clear the selection',
    clearHint: 'Escape also clears the selection.',
    kinds: {
      node: 'Graph node',
      edge: 'Graph relation',
      request: 'HTTP request',
      event: 'Timeline event',
      evidence: 'Evidence',
      symbol: 'Code symbol',
      file: 'File',
      hypothesis: 'Hypothesis',
      experiment: 'Experiment',
      step: 'Reproduction step',
    } as Record<SelectionKind, string>,
    code: 'Linked code',
    codeLoading: 'Reading the file…',
    notInDemo: 'This file is not part of the demonstration data.',
    shotNotInDemo: 'The screenshot is not part of the demonstration data.',
    shotDenied: 'Your role does not allow you to see screenshots.',
    codeDenied: 'Your role does not allow you to read the code of the scope.',
    unknown: 'This item no longer exists in the investigation (read again meanwhile).',
    evidenceKind: 'Kind',
    at: 'Time',
    reproduction: 'Reproduction',
    step: (index: number) => `Step ${String(index)}`,
    stepLabel: 'Step',
    file: 'File',
    experiment: 'Experiment',
    data: 'Data',
    eventStatus: 'Status',
    layer: 'Layer',
    related: 'Linked request',
    evidence: 'Evidence',
    action: 'Action',
    durationLabel: 'Duration',
    duration: (ms: number) => `${String(ms)} ms`,
    reason: 'Reason',
    cancelled: (from: string) =>
      `Investigation cancelled in state “${from}”: the evidence stays readable, resume it to continue.`,
    cancelledPlain: 'Investigation cancelled: the evidence stays readable, resume it to continue.',
    failed: 'The investigation failed: read the error below, fix it, then launch the reproduction again.',
    failedRun: (error: string) => `Last reproduction: ${error}`,
    demoWhy:
      'Demonstration data: action unavailable. Buttons that change the incident or query the server are disabled; navigation, selection and exploration remain possible.',
    capabilitiesError: (message: string) => `Capabilities not read: ${message}`,
    relations: 'All relations',
    fileFailed: (file: string, message: string) => `File ${file} not read: ${message}`,
    fileDenied: 'Reading the code was denied: your role does not allow it.',
    treeFailed: (message: string) => `Code tree not read: ${message}`,
    primary: {
      fullstack: 'Full-stack graph',
      frontend: 'Frontend traceability',
      bff: 'Graph: BFF layer',
      backend: 'Graph: Backend layer',
      requests: 'HTTP requests',
    },
    primaryShort: { frontend: 'Frontend', requests: 'Requests' },
    codeTree: 'Scope files',
    codeEditor: 'Code (read only)',
    codeEvidence: 'Flagged lines and evidence',
    seeDetail: 'See the detail',
    compact: 'Compact mode',
    compactHint: 'Tighten the spacing of the investigation workspace',
    noConnectivityTarget:
      'No URL to test: neither the project environment nor the scope applications declare one.',
    attachmentsAdded: (count: number) => `${String(count)} attachment(s) added.`,
    attachmentRemoved: 'Attachment removed.',
    dxMore: 'Alternatives, missing elements and recommendations of the diagnosis',
    dxAlternatives: 'Alternative causes',
    dxMissing: 'Missing elements to conclude',
    dxRecommendations: 'Recommendations',
    dxNone: 'None.',
    dxConfidence: (percent: number) => `${String(percent)}%`,
  },
};

export const workspaceText = (lang: Lang): (typeof TEXT)['fr'] => TEXT[lang];

/** Le motif court affiché sur une action indisponible en démonstration. */
export const demoUnavailable = (lang: Lang): string =>
  lang === 'fr' ? 'Données de démonstration : action indisponible' : 'Demonstration data: action unavailable';

// ── Pièces ───────────────────────────────────────────────────────────────────────────────────

const row = (term: string, value: string): string => `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;

function loadPanel(lang: Lang, state: LoadState | undefined, loading: string, retry?: string): string {
  if (state === 'denied') return panelState(lang, 'denied');
  if (state && typeof state === 'object') return panelState(lang, 'error', state.error, retry);
  return panelState(lang, 'loading', loading);
}

/** L'extrait du code relié à la sélection (fichier lu par le contrôleur), ou son état de lecture. */
function codeExcerpt(ctx: WorkspaceContext, codeCtx: WorkspaceContext, ws: WorkspaceUi): string {
  const source = sourceOf(ctx.links, ctx.selection);
  if (!source) return '';
  const t = TEXT[ctx.lang];
  const entry = ws.sources[fileId(source.applicationId, source.file)];
  const body = !codeCtx.can('RUN')
    ? panelState(ctx.lang, 'denied', t.codeDenied)
    : entry?.view
      ? renderCodeExcerpt(codeCtx, entry.view, source.line)
      : ws.demo && entry?.state && typeof entry.state === 'object'
        ? panelState(ctx.lang, 'empty', t.notInDemo)
        : loadPanel(ctx.lang, entry?.state, t.codeLoading, 'ws-code-reload');
  return `<details class="ws-ctx-code" data-ws-details="ctx-code" open><summary>${icon('code')}<span>${esc(t.code)}</span></summary><p class="ws-ctx-src">${sourceLink(ctx.lang, source)}</p>${body}</details>`;
}

function evidenceDetail(ctx: WorkspaceContext, ws: WorkspaceUi, evidence: Evidence): string {
  const t = TEXT[ctx.lang];
  const source = evidence.source;
  const stepButton =
    source.step !== undefined && source.reproduction
      ? `<button type="button" class="lnk ${selectionClass(ctx, 'step', stepId(source.reproduction, source.step))}" ${selectable(ctx, 'step', stepId(source.reproduction, source.step))}>${esc(t.step(source.step))}</button>`
      : '';
  const data = Object.entries(evidence.data ?? {})
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 12)
    .map(([key, value]) => {
      const text = String(value);
      return row(key, `<code>${esc(text.length > 240 ? `${text.slice(0, 239)}…` : text)}</code>`);
    })
    .join('');
  let shot = '';
  const screenshot = screenshotOf(ctx.incident, { kind: 'evidence', id: evidence.id });
  if (screenshot) {
    const entry = ws.shots[shotKey(screenshot.reproduction, screenshot.file)];
    shot = ws.demo
      ? panelState(ctx.lang, 'empty', t.shotNotInDemo)
      : entry?.state === 'denied'
        ? panelState(ctx.lang, 'denied', t.shotDenied)
        : entry?.state && typeof entry.state === 'object'
          ? panelState(ctx.lang, 'error', entry.state.error, 'ws-shot-reload')
          : renderScreenshot(ctx, entry?.dataUrl, screenshot.label);
  }
  return `<article class="ws-ctx-card" aria-labelledby="ws-ctx-ev-t"><p class="ws-ctx-eyebrow">${esc(t.kinds.evidence)} · ${esc(evidence.kind)}</p><h3 id="ws-ctx-ev-t">${esc(evidence.summary)}</h3><dl class="ws-ctx-dl">${
    evidence.at
      ? row(t.at, `<time datetime="${esc(evidence.at)}">${esc(formatDate(evidence.at, ctx.lang))}</time>`)
      : ''
  }${source.reproduction ? row(t.reproduction, `<code>${esc(source.reproduction)}</code>`) : ''}${stepButton ? row(t.stepLabel, stepButton) : ''}${
    source.file
      ? row(
          t.file,
          `<code>${esc(source.line !== undefined ? `${source.file}:${String(source.line)}` : source.file)}</code>`,
        )
      : ''
  }${
    source.experiment
      ? row(
          t.experiment,
          `<button type="button" class="lnk ${selectionClass(ctx, 'experiment', source.experiment)}" ${selectable(ctx, 'experiment', source.experiment)}>${esc(source.experiment)}</button>`,
        )
      : ''
  }</dl>${data ? `<details class="ws-ctx-more" data-ws-details="ctx-data"><summary>${esc(t.data)}</summary><dl class="ws-ctx-dl">${data}</dl></details>` : ''}${shot}</article>`;
}

function eventDetail(ctx: WorkspaceContext, event: TimelineEvent): string {
  const t = TEXT[ctx.lang];
  const parts = partsText(ctx.lang);
  const chips = evidenceChips(
    ctx,
    event.evidence.filter((ref) => ref !== event.requestId),
    6,
  );
  const step =
    event.step !== undefined && event.reproduction
      ? `<button type="button" class="lnk ${selectionClass(ctx, 'step', stepId(event.reproduction, event.step))}" ${selectable(ctx, 'step', stepId(event.reproduction, event.step))}>${esc(t.step(event.step))}</button>`
      : '';
  return `<article class="ws-ctx-card" aria-labelledby="ws-ctx-evt-t"><p class="ws-ctx-eyebrow">${esc(t.kinds.event)} · ${esc(event.kind)}</p><h3 id="ws-ctx-evt-t">${esc(event.summary)}</h3><dl class="ws-ctx-dl">${row(t.eventStatus, esc(event.status))}${row(t.layer, esc(parts.layers[event.layer]))}${
    event.at
      ? row(
          t.at,
          `<time datetime="${esc(event.at)}">${event.estimated ? '≈ ' : ''}${esc(formatDate(event.at, ctx.lang))}</time>`,
        )
      : ''
  }${step ? row(t.stepLabel, step) : ''}${chips ? row(t.evidence, chips) : ''}</dl>${
    event.requestId
      ? `<details class="ws-ctx-more" data-ws-details="ctx-request" open><summary>${esc(t.related)}</summary>${renderRequestDetail(ctx, event.requestId)}</details>`
      : ''
  }</article>`;
}

function stepDetail(ctx: WorkspaceContext, id: string): string {
  const t = TEXT[ctx.lang];
  const at = id.lastIndexOf('#');
  const reproduction = id.slice(0, at);
  const index = Number(id.slice(at + 1));
  const trace = ctx.incident.investigation.frontendTrace;
  if (trace?.reproduction === reproduction && trace.steps.some((step) => step.index === index))
    return renderFrontendStepDetail(ctx, index);
  const run = ctx.incident.investigation.reproductions.find((entry) => entry.id === reproduction);
  const action = run?.actions.find((entry) => entry.index === index);
  if (!run || !action) return panelState(ctx.lang, 'empty', t.unknown);
  return `<article class="ws-ctx-card" aria-labelledby="ws-ctx-step-t"><p class="ws-ctx-eyebrow">${esc(t.kinds.step)} · <code>${esc(run.id)}</code></p><h3 id="ws-ctx-step-t">${esc(`${t.step(index)} : ${action.description}`)}</h3><dl class="ws-ctx-dl">${row(t.action, `<code>${esc(action.kind)}</code> ${esc(action.status)}`)}${row(t.durationLabel, esc(t.duration(action.durationMs)))}${action.reason ? row(t.reason, esc(action.reason)) : ''}${
    action.requestIds.length > 0 ? row(t.evidence, evidenceChips(ctx, action.requestIds, 6)) : ''
  }</dl></article>`;
}

/** Le détail de la sélection, selon sa nature. */
function selectionDetail(ctx: WorkspaceContext, ws: WorkspaceUi): string {
  const selection = ctx.selection;
  const t = TEXT[ctx.lang];
  if (!selection) return renderGraphDetail(ctx);
  const incident = ctx.incident;
  switch (selection.kind) {
    case 'node':
    case 'edge':
      return renderGraphDetail(ctx) || panelState(ctx.lang, 'empty', t.unknown);
    case 'request':
      return renderRequestDetail(ctx, selection.id);
    case 'step':
      return stepDetail(ctx, selection.id);
    case 'hypothesis':
      return renderHypothesisDetail(ctx, selection.id, ws.dx);
    case 'experiment':
      return renderExperimentDetail(ctx, selection.id, ws.dx);
    case 'evidence': {
      const evidence = evidenceOf(incident, selection.id);
      return evidence ? evidenceDetail(ctx, ws, evidence) : panelState(ctx.lang, 'empty', t.unknown);
    }
    case 'event': {
      const event = (incident.investigation.timeline ?? []).find((entry) => entry.id === selection.id);
      return event ? eventDetail(ctx, event) : panelState(ctx.lang, 'empty', t.unknown);
    }
    case 'symbol': {
      const symbol = incident.investigation.code?.symbols.find((entry) => entry.id === selection.id);
      return symbol
        ? `<p class="ws-ctx-eyebrow">${esc(t.kinds.symbol)} · ${esc(symbol.kind)}</p><h3 class="ws-ctx-h">${esc(symbol.name)}</h3>`
        : panelState(ctx.lang, 'empty', t.unknown);
    }
    case 'file':
      return `<p class="ws-ctx-eyebrow">${esc(t.kinds.file)}</p><h3 class="ws-ctx-h"><code>${esc(selection.id)}</code></h3>`;
  }
}

/** Le bouton qui vide la sélection (outil de la barre du panneau des détails). */
function clearButton(ctx: WorkspaceContext): string {
  const t = TEXT[ctx.lang];
  return ctx.selection
    ? `<button type="button" class="ws-pane-btn ws-ctx-clear" data-action="ws-select-clear" aria-label="${esc(t.clear)}" title="${esc(`${t.clear}. ${t.clearHint}`)}">${icon('undo')}</button>`
    : '';
}

/** Le contenu du panneau des détails : la nature de la sélection, son détail, le code relié. */
function contextBody(ctx: WorkspaceContext, codeCtx: WorkspaceContext, ws: WorkspaceUi): string {
  const t = TEXT[ctx.lang];
  const selection = ctx.selection;
  return `${selection ? `<p class="mu ws-ctx-kind">${esc(t.kinds[selection.kind])} <code>${esc(selection.id)}</code></p>` : ''}<div class="ws-ctx-body" data-sel="${esc(selection ? selectionKey(selection) : '')}">${selectionDetail(ctx, ws)}${codeExcerpt(ctx, codeCtx, ws)}</div>`;
}

/** Le panneau contextuel complet (titre, vider la sélection, détail, code relié). */
export function renderContextPanel(
  ctx: WorkspaceContext,
  codeCtx: WorkspaceContext,
  ws: WorkspaceUi,
): string {
  const t = TEXT[ctx.lang];
  return `<div class="ws-ctx-h2"><h2 id="ws-ctx-t">${esc(t.panel)}</h2>${clearButton(ctx)}</div>${contextBody(ctx, codeCtx, ws)}`;
}

// ── Contenu des onglets ──────────────────────────────────────────────────────────────────────

/** L'état de lecture d'un fichier pour les vues du code (absent : la lecture va commencer). */
function codeStateOf(entry: SourceEntry | undefined, demo: boolean, lang: Lang): CodeLoadState | undefined {
  if (entry?.view) return undefined;
  if (entry?.state && typeof entry.state === 'object')
    return demo ? { error: TEXT[lang].notInDemo } : entry.state;
  return 'loading';
}

function treeStateOf(ws: WorkspaceUi): CodeLoadState | undefined {
  if (ws.tree) return undefined;
  if (ws.treeState && typeof ws.treeState === 'object') return ws.treeState;
  return 'loading';
}

/**
 * Sous le tableau du diagnostic : ce que le diagnostic dit en plus (causes alternatives avec leur
 * confiance, éléments manquants, recommandations), replié, tel que le serveur l'a produit.
 */
function diagnosisExtras(ctx: WorkspaceContext): string {
  const diagnosis = ctx.incident.investigation.diagnosis;
  if (!diagnosis) return '';
  const t = TEXT[ctx.lang];
  const list = (items: string[]): string =>
    items.length === 0
      ? `<p class="mu">${esc(t.dxNone)}</p>`
      : `<ul class="plain tight">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  const alternatives = diagnosis.alternatives.map(
    (entry) =>
      `<button type="button" class="lnk ${selectionClass(ctx, 'hypothesis', entry.hypothesisId)}" ${selectable(ctx, 'hypothesis', entry.hypothesisId)}>${esc(entry.statement)}</button> <span class="pill mu">${esc(t.dxConfidence(Math.round(Math.min(1, Math.max(0, entry.confidence)) * 100)))}</span>`,
  );
  return `<details class="card ws-dx-more" data-ws-details="dx-more"><summary>${esc(t.dxMore)}</summary><h3>${esc(t.dxAlternatives)}</h3>${list(alternatives)}<h3>${esc(t.dxMissing)}</h3>${list(diagnosis.missing.map((entry) => esc(entry)))}<h3>${esc(t.dxRecommendations)}</h3>${list(diagnosis.recommendations.map((entry) => esc(entry)))}</details>`;
}

/** Le contenu d'une vue de document (onglets Vue d'ensemble, Reproduction, Diagnostic, Rapport). */
function documentBody(ctx: WorkspaceContext, ws: WorkspaceUi, tab: WorkspaceTab, scope: string): string {
  const t = TEXT[ctx.lang];
  switch (tab) {
    case 'scope':
      return scope;
    case 'environment': {
      const failed =
        ws.capabilitiesState && typeof ws.capabilitiesState === 'object'
          ? `<p class="mu" role="note">${esc(t.capabilitiesError(ws.capabilitiesState.error))}</p>`
          : '';
      return `${renderEnvironmentSelector(ctx, ws.ux, ws.capabilities, ws.environment ? { environment: ws.environment } : {})}${failed}`;
    }
    case 'run':
      return renderReproductionRun(ctx, ws.repro, reproductionMedia(ws));
    case 'evidence':
      return renderEvidence(ctx, ws.repro, reproductionMedia(ws));
    case 'timeline':
      return renderTimeline(ctx, ws.timeline);
    case 'logs':
      return renderLogs(ctx);
    case 'hypotheses':
      return renderHypotheses(ctx, ws.dx);
    case 'experiments':
      return renderExperiments(ctx, ws.dx);
    case 'diagnosis':
      return `${renderDiagnosisBoard(ctx, ws.dx)}${diagnosisExtras(ctx)}`;
    case 'ai':
      return renderAiInvestigation(ctx, ws.ai);
    case 'tbrief':
      return renderTriggerSection(ctx, ws.trg, 'brief');
    case 'tdiscovery':
      return renderTriggerSection(ctx, ws.trg, 'discovery');
    case 'texplorer':
      return renderTriggerSection(ctx, ws.trg, 'explorer');
    case 'tlive':
      return renderTriggerSection(ctx, ws.trg, 'live');
    case 'tevents':
      return renderTriggerSection(ctx, ws.trg, 'events');
    case 'tmatrix':
      return renderTriggerSection(ctx, ws.trg, 'matrix');
    case 'tminimal':
      return renderTriggerSection(ctx, ws.trg, 'minimal');
    case 'tangular':
      return renderTriggerSection(ctx, ws.trg, 'angular');
    case 'tcauses':
      return renderTriggerSection(ctx, ws.trg, 'causes');
    case 'tproposal':
      return renderTriggerSection(ctx, ws.trg, 'proposal');
    case 'report':
      return renderReportExport(ctx, ws.dx, ws.report, ws.reportState);
    case 'regression':
      return renderRegressionTest(ctx, ws.dx, ws.regressionSpec);
    default:
      return `${renderOverview(ctx)}${renderAttachmentsCard(ctx, ws.att, ws.busy)}`;
  }
}

/**
 * Le graphe en panneau (commandes sur une ligne, cadre qui remplit le panneau), restreint ou non à une
 * couche. Pas de bandeau de démonstration ici : l'en-tête le porte pour tout l'espace.
 */
function graphPane(ctx: WorkspaceContext, ws: WorkspaceUi, focus?: 'BFF' | 'BACKEND'): string {
  return renderGraph(ctx, ws.graph, {
    compact: true,
    ...(focus ? { focus } : {}),
    maximized: ws.split.maximized === 'primary',
  });
}

/** Le panneau principal de l'onglet Traçabilité (selon le sous-onglet) ou de l'onglet Code (le graphe). */
function primaryPane(ctx: WorkspaceContext, ws: WorkspaceUi, tab: WorkspaceTab): PaneSpec {
  const t = TEXT[ctx.lang];
  const short = splitText(ctx.lang).short;
  switch (tab) {
    case 'frontend':
      return {
        title: t.primary.frontend,
        short: t.primaryShort.frontend,
        icon: icon('traceability'),
        body: renderFrontendTrace(ctx, ws.trace),
      };
    case 'bff':
      return {
        title: t.primary.bff,
        short: short.primary,
        icon: icon('traceability'),
        body: graphPane(ctx, ws, 'BFF'),
        fill: true,
      };
    case 'backend':
      return {
        title: t.primary.backend,
        short: short.primary,
        icon: icon('traceability'),
        body: graphPane(ctx, ws, 'BACKEND'),
        fill: true,
      };
    case 'requests':
      return {
        title: t.primary.requests,
        short: t.primaryShort.requests,
        icon: icon('executions'),
        body: renderRequests(ctx, ws.timeline),
      };
    default:
      return {
        title: t.primary.fullstack,
        short: short.primary,
        icon: icon('traceability'),
        body: graphPane(ctx, ws),
        fill: true,
      };
  }
}

/** Les trois panneaux du code (arborescence, éditeur, preuves) : le module du code les dessine. */
function codePanes(
  codeCtx: WorkspaceContext,
  ws: WorkspaceUi,
): Record<'tree' | 'editor' | 'evidence', PaneSpec> {
  const t = TEXT[codeCtx.lang];
  const short = splitText(codeCtx.lang).short;
  const bodies = renderCodeWorkspace(
    codeCtx,
    ws.code,
    ws.tree,
    (applicationId: string, file: string) => {
      const entry = ws.sources[fileId(applicationId, file)];
      const state = codeStateOf(entry, ws.demo, codeCtx.lang);
      return { ...(entry?.view ? { view: entry.view } : {}), ...(state !== undefined ? { state } : {}) };
    },
    treeStateOf(ws),
  );
  return {
    tree: { title: t.codeTree, short: short.tree, icon: icon('projects'), body: bodies.tree },
    editor: { title: t.codeEditor, short: short.editor, icon: icon('code'), body: bodies.editor, fill: true },
    evidence: { title: t.codeEvidence, short: short.evidence, icon: icon('search'), body: bodies.evidence },
  };
}

/** Les onglets principaux, dans l'ordre de l'investigation, avec les nombres connus. */
export function mainTabsOf(ctx: WorkspaceContext): UxTab[] {
  const ux = uxText(ctx.lang);
  const investigation = ctx.incident.investigation;
  const pending = ctx.incident.scope.extensions.filter((extension) => extension.status === 'PENDING').length;
  const counts: Partial<Record<MainTab, number | undefined>> = {
    overview: pending,
    timeline: investigation.reproductions.length,
    diagnosis: investigation.hypotheses.length,
  };
  return MAIN_TABS.map((key): UxTab => {
    const count = counts[key];
    return { key, label: ux.mainTabs[key] ?? key, ...(count !== undefined && count > 0 ? { count } : {}) };
  });
}

/** Les sous-onglets d'un onglet principal, avec les nombres connus. */
export function subTabsOf(ctx: WorkspaceContext, tab: MainTab): UxTab[] {
  const ux = uxText(ctx.lang);
  const investigation = ctx.incident.investigation;
  const reproduction = incidentReproduction(ctx.incident);
  const pending = ctx.incident.scope.extensions.filter((extension) => extension.status === 'PENDING').length;
  const counts: Record<string, number | undefined> = {
    scope: pending,
    evidence: reproduction ? reproduction.requests.length + reproduction.evidence.length : undefined,
    events: investigation.timeline?.length,
    http: reproduction?.requests.length,
    hypotheses: investigation.hypotheses.length,
    experiments: investigation.experiments.length,
    ai: investigation.ai?.runs.length,
    brief: investigation.trigger?.runs.length,
    matrix: shownTriggerRun(ctx.incident, {})?.trials.length,
    causes: shownTriggerRun(ctx.incident, {})?.hypothesisIds.length,
  };
  return (SUB_TABS[tab] as readonly string[]).map((key): UxTab => {
    const count = counts[key];
    return { key, label: ux.subTabs[key] ?? key, ...(count !== undefined && count > 0 ? { count } : {}) };
  });
}

/** Toutes les clés de vue avec leur libellé (onglet principal › sous-onglet) : liens, tests, documentation. */
export function tabsOf(ctx: WorkspaceContext): UxTab[] {
  const ux = uxText(ctx.lang);
  return WORKSPACE_TABS.map((key): UxTab => {
    const route = VIEW_ROUTES[key];
    const label = route.sub ? (ux.subTabs[route.sub] ?? key) : (ux.mainTabs[route.tab] ?? key);
    return { key, label };
  });
}

function statusBanner(ctx: WorkspaceContext): string {
  const t = TEXT[ctx.lang];
  const incident = ctx.incident;
  if (incident.state === 'CANCELLED') {
    const from = incident.cancelledFrom ? uxText(ctx.lang).states[incident.cancelledFrom] : undefined;
    return `<p class="note warn ws-banner" role="note">${icon('alert')}<span>${esc(from ? t.cancelled(from) : t.cancelledPlain)}</span></p>`;
  }
  if (incident.state === 'FAILED') {
    const error = [...incident.investigation.reproductions].reverse().find((run) => run.error)?.error;
    return `<div class="err-box ws-banner" role="alert"><p class="err"><b>${esc(t.failed)}</b></p>${error ? `<p>${esc(t.failedRun(error))}</p>` : ''}</div>`;
  }
  return '';
}

// ── La coquille ──────────────────────────────────────────────────────────────────────────────

export interface WorkspaceView {
  incident: Incident;
  ws: WorkspaceUi;
  tab: WorkspaceTab;
  lang: Lang;
  can: WorkspaceContext['can'];
  /** Le retour à la liste (bouton). */
  back: string;
  /** Les actions de l'en-tête (reproduire, actualiser, annuler, reprendre). */
  actions: string;
  /** La zone des messages (la seule zone aria-live de la page). */
  messages: string;
  /** Le contenu de l'onglet « Périmètre » (liste, édition, extensions). */
  scope: string;
  /** Les remarques sous l'en-tête (lecture seule…). */
  notes?: string;
}

/** Les panneaux de la vue affichée, selon sa disposition. */
export function workspacePanes(
  ctx: WorkspaceContext,
  codeCtx: WorkspaceContext,
  ws: WorkspaceUi,
  tab: WorkspaceTab,
  scope: string,
): { layout: SplitLayout; specs: Partial<Record<PaneId, PaneSpec>>; mobileDefault: PaneId } {
  const t = TEXT[ctx.lang];
  const ux = uxText(ctx.lang);
  const route = VIEW_ROUTES[tab];
  const layout = layoutOf(route.tab);
  const attachment =
    tab === 'overview' && ws.att.open !== undefined
      ? (ctx.incident.attachments ?? []).find((entry) => entry.id === ws.att.open)
      : undefined;
  const details: PaneSpec = {
    title: t.panel,
    short: splitText(ctx.lang).short.details,
    icon: icon('info'),
    tools: clearButton(ctx),
    body:
      tab === 'overview' && ws.att.open !== undefined
        ? renderAttachmentView(ctx, ws.att, attachment)
        : contextBody(ctx, codeCtx, ws),
  };
  // L'alternative textuelle du graphe (toutes les relations) suit le détail, repliée, quand le graphe est affiché.
  if (layout === 'code' || tab === 'traceability')
    details.body += `<details class="ws-rel-table" data-ws-details="relations"><summary>${esc(t.relations)}</summary>${renderRelationsTable(ctx)}</details>`;
  if (layout === 'document') {
    const label = route.sub ? (ux.subTabs[route.sub] ?? tab) : (ux.mainTabs[route.tab] ?? tab);
    // Les écrans de la maquette (Périmètre, Environnement, Exécution, Preuves, Diagnostic, Rapport,
    // Non-régression) n'ouvrent le panneau des détails que pour une sélection : vide, il ne prendrait
    // que de la place.
    const bare = FULL_WIDTH_VIEWS.includes(tab) && !ctx.selection;
    return {
      layout,
      mobileDefault: 'content',
      specs: {
        content: {
          title: label,
          short: splitText(ctx.lang).short.content,
          body: documentBody(ctx, ws, tab, scope),
        },
        ...(bare ? {} : { details }),
      },
    };
  }
  return {
    layout,
    mobileDefault: layout === 'code' ? 'editor' : 'primary',
    specs: {
      primary: primaryPane(ctx, ws, layout === 'code' ? 'traceability' : tab),
      details,
      ...codePanes(codeCtx, ws),
    },
  };
}

/**
 * L'ESPACE D'INVESTIGATION, sans défilement de la page : une colonne qui prend toute la hauteur
 * disponible — en-tête compact (et « Détails »), messages, progression repliable, onglets principaux sur
 * une ligne (avec les outils de disposition), sous-onglets, puis le corps (`flex:1`), une disposition en
 * panneaux qui défilent chacun en eux-mêmes : Traçabilité et Code en deux zones (graphe | détails au-dessus,
 * fichiers | code | preuves dessous), les autres onglets en document (contenu | détails). Sous 560 px de
 * haut ou 600 px de large, la page retrouve sa hauteur naturelle (rien n'est jamais inaccessible).
 */
export function renderWorkspace(view: WorkspaceView): string {
  const { incident, ws, tab } = view;
  const ctx = workspaceCtx(incident, ws, view.lang, view.can);
  const codeCtx = codeCtxOf(ctx, ws);
  const t = TEXT[view.lang];
  const ux = uxText(view.lang);
  const route = VIEW_ROUTES[tab];
  const { layout, specs, mobileDefault } = workspacePanes(ctx, codeCtx, ws, tab, view.scope);
  const splitOpts = {
    lang: view.lang,
    layout,
    mobileDefault,
    ...(ws.selection ? { detailsHint: t.seeDetail } : {}),
  };
  const subs = subTabsOf(ctx, route.tab);
  const tools = `${renderHiddenBar(ws.split, specs, splitOpts)}<button type="button" class="ws-tool" data-action="ws-ux-compact" aria-pressed="${String(ws.compact)}" title="${esc(t.compactHint)}">${icon('sliders')}<span>${esc(t.compact)}</span></button><button type="button" class="ws-tool" data-action="ws-split-reset" title="${esc(splitText(view.lang).reset)}">${icon('undo')}<span class="sr">${esc(splitText(view.lang).reset)}</span></button>`;
  // Les outils (panneaux masqués, mode compact, réinitialisation) : sur la ligne des sous-onglets quand il y en a une.
  const hasSub = subs.length > 0 && route.sub !== undefined;
  const mainBar = renderTabs(
    ctx,
    mainTabsOf(ctx),
    route.tab,
    hasSub ? { kind: 'main' } : { kind: 'main', tools },
  );
  const subBar =
    subs.length > 0 && route.sub
      ? renderTabs(ctx, subs, route.sub, {
          kind: 'sub',
          label: ux.subTabsLabel(ux.mainTabs[route.tab] ?? route.tab),
          tools,
        })
      : '';
  const labelledBy = route.sub && subs.length > 0 ? `ws-ux-sub-${route.sub}` : `ws-ux-tab-${route.tab}`;
  const body = renderTabPanel(tab, renderSplitLayout(specs, ws.split, splitOpts), labelledBy, 'ws-body');
  // Les remarques (messages, état annulé ou en échec, lecture seule) : rien quand il n'y en a pas.
  const notes = `${view.messages}${statusBanner(ctx)}${view.notes ?? ''}`;
  const header = renderWorkspaceHeader(ctx, view.actions, {
    back: view.back,
    open: ws.headOpen,
    ...(ws.demo ? { demoNote: t.demoWhy } : {}),
  });
  return `<div class="ws-root${ws.compact ? ' ws-compact' : ''}" data-incident="${esc(incident.id)}" data-tab="${route.tab}" data-view="${tab}">${header}${notes ? `<div class="ws-notes">${notes}</div>` : ''}${renderStepper(ctx, { open: ws.stepperOpen })}${mainBar}${subBar}${body}</div>`;
}

/**
 * La démonstration : chaque bouton qui modifierait l'incident ou interrogerait le serveur est désactivé,
 * avec la raison (infobulle, et la note `#ws-demo-why` liée par aria-describedby). Les envois de
 * formulaires aussi.
 */
export const DEMO_DISABLED_ACTIONS = [
  ...TRIGGER_OPERATIONS,
  'inc-reproduce',
  'inc-cancel',
  'inc-cancel-yes',
  'inc-resume',
  'inc-validate',
  'inc-scope-edit',
  'inc-ext-approve',
  'inc-ext-reject',
  'inc-app-add',
  'inc-app-remove',
  'inc-disc-run',
  'inc-disc-known',
  'inc-disc-apply',
  'inc-disc-clear',
  'ws-ux-target-save',
  'ws-ux-check',
  'ws-repro-start',
  'ws-repro-stop',
  'ws-repro-stop-yes',
  'ws-repro-stop-no',
  'ws-att-remove',
  'ws-att-remove-yes',
  'ws-dx-run-selected',
  'ws-dx-analyze',
  'ws-dx-plan',
  'ws-dx-plan-submit',
  'ws-dx-run',
  'ws-dx-approve',
  'ws-dx-diagnose',
  'ws-dx-report',
  'ws-dx-export',
  'ws-dx-regression',
  ...AI_OPERATIONS,
  'ws-code-reload',
  'ws-shot-reload',
] as const;

const DEMO_BUTTON = new RegExp(
  `<button\\b(?=[^>]*\\b(?:data-action="(?:${DEMO_DISABLED_ACTIONS.join('|')})"|type="submit"))`,
  'g',
);

export function disableForDemo(html: string, lang: Lang): string {
  return html.replace(
    DEMO_BUTTON,
    `<button disabled title="${esc(demoUnavailable(lang))}" aria-describedby="ws-demo-why"`,
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/**
 * Le plancher du corps de l'espace (la zone des panneaux) : la zone haute (200 px), un séparateur et la
 * zone basse (160 px), avec leurs bords. Quand la progression complète, les « Détails » de l'en-tête ou une
 * fenêtre basse ne lui laissent plus cette place, l'espace défile verticalement (et seulement alors) :
 * aucun panneau n'est coupé.
 */
export const WORKSPACE_BODY_MIN_PX = 380;

/** Les styles de la coquille (après ceux des modules) : jetons du thème seulement, clair et sombre. */
export const INCIDENT_WORKSPACE_CSS = `${INCIDENT_SPLIT_CSS}
.ws-root{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;flex:1 1 auto;overflow:hidden auto;overscroll-behavior:contain;container:ws-root / inline-size}
@container ws-root (max-width:1100px){.ws-tool>span:not(.sr){position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.ws-ux-head .acts .btn{padding:0 10px}}
.ws-root>*{flex:none;min-width:0}
.ws-root>.ws-body{flex:1 1 auto;min-height:${String(WORKSPACE_BODY_MIN_PX)}px;display:flex;flex-direction:column;gap:0}
.ws-body>.ws-split-host{flex:1 1 auto;min-height:0}
.ws-root :where(:focus-visible){outline:2px solid var(--qa-color-primary);outline-offset:2px}
/* La ligne de la progression défile en elle-même : ses textes pour lecteurs d'écran (position absolue) y
   restent contenus, sans élargir la page. */
.ws-ux-steps-row{position:relative}
.ws-notes{display:flex;flex-direction:column;gap:6px}
.ws-notes:empty{display:none}
.ws-notes>*{margin:0}
.ws-tool{display:inline-flex;align-items:center;gap:4px;min-height:30px;padding:0 8px;border:1px solid var(--ws-edge);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-muted);cursor:pointer;font-size:12px}
.ws-tool:hover{border-color:var(--qa-color-primary);color:var(--qa-color-text)}
.ws-tool[aria-pressed="true"]{border-color:var(--qa-color-primary);color:var(--qa-color-primary);font-weight:600}
.ws-tool .ico{width:14px;height:14px}
.ws-compact{gap:2px}
.ws-compact .ws-pane-b{padding:6px;gap:8px}
.ws-compact .ws-pane-fill>.ws-pane-b{padding:4px}
.ws-compact .ws-pane-h{min-height:28px;padding:0 2px 0 8px}
.ws-compact .ws-pane-btn{width:26px;height:26px}
.ws-compact .ws-ux-head{padding:2px 8px;gap:2px}
.ws-compact .ws-ux-head h1{font-size:15px}
.ws-compact .ws-ux-head .acts .btn,.ws-compact .ws-ux-head-top>.back{min-height:28px}
.ws-compact .ws-ux-head .acts .btn.icon-only{width:28px}
.ws-compact .ws-ux-step-row{min-height:26px}
.ws-compact .ws-ux-step-toggle{width:26px;height:26px}
.ws-compact .ws-ux-step-cur{min-height:24px}
.ws-compact .ws-ux-progress{display:none}
.ws-compact .ws-ux-tabs button{min-height:30px;padding:0 10px}
.ws-compact .ws-ux-subtabs button{min-height:26px}
.ws-compact .ws-ux-tabtools{padding:1px 0 2px}
.ws-compact .ws-tool{min-height:26px}
.ws-compact .ws-ux-count{height:18px;min-width:18px;padding:0 4px}
.ws-compact .card{padding:12px;gap:8px}
.ws-pane-b p,.ws-pane-b li{overflow-wrap:anywhere}
.ws-pane-fill>.ws-pane-b>.ws-graph{flex:1 1 auto;min-height:200px}
.ws-pane-b:has(>.ws-code-pane){padding:0}
.ws-pane-b>.ws-code-pane{flex:1 1 auto;min-height:0}
.ws-pane-fill>.ws-pane-b>.ws-demo{flex:none}
.ws-zone{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:14px;min-width:0}
.ws-ctx-h2{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.ws-ctx-h2 h2{margin:0;font-size:16px}
.ws-ctx-kind{margin:0;font-size:12px;overflow-wrap:anywhere}
.ws-ctx-body{display:flex;flex-direction:column;gap:12px;min-width:0}
.ws-ctx-card{display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-ctx-card h3,.ws-ctx-h{margin:0;font-size:15px;overflow-wrap:anywhere}
.ws-ctx-card h4{margin:4px 0 0;font-size:13px}
.ws-ctx-eyebrow{margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ws-ctx-dl{display:grid;grid-template-columns:minmax(80px,max-content) minmax(0,1fr);gap:4px 12px;margin:0;font-size:13px}
.ws-ctx-dl>div{display:contents}
.ws-ctx-dl dt{color:var(--qa-color-muted)}
.ws-ctx-dl dd{margin:0;overflow-wrap:anywhere}
.ws-ctx-more>summary,.ws-ctx-code>summary,.ws-rel-table>summary{cursor:pointer;font-weight:600;font-size:13px;min-height:28px;line-height:28px}
.ws-ctx-code>summary .ico{width:15px;height:15px;vertical-align:-3px;margin-right:4px}
.ws-ctx-more[open]>summary,.ws-ctx-code[open]>summary{margin-bottom:6px}
.ws-ctx-code{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--qa-color-border);padding-top:8px}
.ws-ctx-src{margin:0 0 6px;font-size:13px}
.ws-banner{margin:0;display:flex;gap:8px;align-items:flex-start}
.ws-rel-table{flex:none;border-top:1px solid var(--qa-color-border);padding-top:6px}
.ws-inv-progress{display:flex;flex-direction:column;gap:4px;min-width:160px}
.ws-inv-bar{display:block;height:8px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow:hidden}
.ws-inv-bar>span{display:block;height:100%;background:var(--qa-color-primary)}
.ws-inv-blocked .ws-inv-bar>span{background:var(--qa-color-danger)}
.ws-dx-more>summary{cursor:pointer;font-weight:600;min-height:28px;line-height:28px}
.ws-dx-more h3{margin:10px 0 4px;font-size:14px}
.ws-demo-entry{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.ws-demo-entry p{margin:0}
[data-ws-graph="canvas"]{touch-action:none;cursor:grab}
[data-ws-graph="canvas"].ws-dragging{cursor:grabbing}
@media (max-height:559px),(max-width:599px){
  .ws-root{flex:none;overflow:visible}
  .ws-root>.ws-body{flex:none}
  .ws-body>.ws-split-host{flex:none;height:auto}
  .ws-split-doc,.ws-split-doc .ws-split-zone,.ws-split-doc .ws-pane,.ws-split-doc .ws-pane-b{overflow:visible;min-height:auto;flex:none}
  .ws-split-two,.ws-split-maxed{flex:none!important;height:max(480px,calc(100dvh - 48px))}
}
`;
