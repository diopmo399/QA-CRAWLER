import type {
  ActionEvidence,
  Evidence,
  HttpExchange,
  Incident,
  IncidentState,
  ReproductionRun,
} from '../core/incident-contracts.js';
import { incidentReproduction } from '../core/incident-contracts.js';
import { stepId } from './incident-links.js';
import {
  panelState,
  partsText,
  relationBadge,
  selectable,
  selectionClass,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import {
  clock,
  formatDuration,
  isDataImage,
  isFailing,
  isSensitiveHeader,
  linkedNodes,
  maskJson,
  maskText,
  prettyBody,
  statusPill,
} from './incident-timeline.js';
import { esc, icon } from './view.js';
import { ACTIVE_TRIGGER_STATES } from './incident-trigger.js';

/**
 * LA REPRODUCTION ET LES PREUVES COLLECTÉES (écrans « Reproduction avec Playwright » et « Preuves
 * collectées » de l'espace d'investigation).
 *
 * - `renderReproductionRun` : le scénario rejoué, l'état de la reproduction, le temps écoulé (le contrôleur
 *   fait avancer le compteur pendant le run), « Arrêter » / « Reproduire », les étapes (statut, durée
 *   mesurée), l'aperçu de la dernière capture avec l'erreur de l'étape en échec, et en bas les captures, la
 *   console, la trace Playwright et les requêtes HTTP.
 * - `renderEvidence` : les preuves de la reproduction par nature (requêtes HTTP, console, captures, traces,
 *   actions) ; le détail d'une requête en sous-onglets (détails, en-têtes, payload, réponse, cURL).
 *
 * PENDANT LE RUN, la source est `ReproductionRun.live` (servi depuis la mémoire du serveur par
 * `incidents.get` tant que la reproduction est RUNNING) : les étapes COMMENCÉES ou terminées (statut,
 * description du moteur, durée mesurée une fois l'étape finie, raison, capture), le nombre d'étapes annoncé
 * (`total`), l'étape en cours, le dernier signal (`updatedAt`) et la dernière capture réellement écrite.
 * Absent tant que le moteur n'a rien annoncé : l'écran dit « en attente du moteur ». Aucune étape à venir
 * n'est inventée (seulement « n étape(s) à venir », d'après `total`) ; aucune durée pour une étape en cours.
 * Après le run, `live` disparaît et `actions` (avec requêtes, preuves, captures) le remplace.
 * (`client.executions.get` n'est pas utilisé : il ne lit que `result.json`, écrit à la fin du scénario.)
 *
 * Toutes les interactions passent par `data-action` (`ws-repro-…`, `ws-select`, `ws-code`) ; le contrôleur
 * lit les données (incident, exécution, captures) et les passe aux fonctions de rendu, qui restent pures.
 */

// ── État local ───────────────────────────────────────────────────────────────────────────────

/** Les onglets du bas de l'écran « Exécution ». */
export const RUN_TABS = ['shots', 'console', 'traces', 'http'] as const;
export type RunTab = (typeof RUN_TABS)[number];

/** Les onglets de l'écran « Preuves ». */
export const EVIDENCE_TABS = ['http', 'console', 'shots', 'traces', 'actions'] as const;
export type EvidenceTab = (typeof EVIDENCE_TABS)[number];

/** Les sous-onglets du détail d'une requête. */
export const REQUEST_TABS = ['details', 'headers', 'payload', 'response', 'curl'] as const;
export type RequestTab = (typeof REQUEST_TABS)[number];

/** Les groupes d'onglets (clavier : `ws-repro-key`). */
export type ReproductionTabGroup = 'run' | 'ev' | 'req';

export interface ReproductionUi {
  /** La reproduction choisie (identifiant) ; absente : la dernière du scénario (Exécution), la référence (Preuves). */
  reproduction?: string;
  runTab: RunTab;
  evidenceTab: EvidenceTab;
  requestTab: RequestTab;
  /** La requête montrée quand la sélection partagée n'en désigne pas une (« Voir les preuves associées »). */
  request?: string;
  /** La capture montrée (fichier relatif au run) quand la sélection n'en désigne pas une. */
  shot?: string;
  /** Requêtes HTTP : seulement les échanges en erreur. */
  errorsOnly: boolean;
  /** « Arrêter » demande une confirmation dans la page. */
  confirmStop: boolean;
}

export function emptyReproductionUi(): ReproductionUi {
  return {
    runTab: 'shots',
    evidenceTab: 'http',
    requestTab: 'details',
    errorsOnly: false,
    confirmStop: false,
  };
}

const TAB_GROUPS: Record<ReproductionTabGroup, readonly string[]> = {
  run: RUN_TABS,
  ev: EVIDENCE_TABS,
  req: REQUEST_TABS,
};

const currentTab = (ui: ReproductionUi, group: ReproductionTabGroup): string =>
  group === 'run' ? ui.runTab : group === 'ev' ? ui.evidenceTab : ui.requestTab;

function withTab(ui: ReproductionUi, group: ReproductionTabGroup, tab: string): ReproductionUi {
  if (!TAB_GROUPS[group].includes(tab) || currentTab(ui, group) === tab) return ui;
  if (group === 'run') return { ...ui, runTab: tab as RunTab };
  if (group === 'ev') return { ...ui, evidenceTab: tab as EvidenceTab };
  return { ...ui, requestTab: tab as RequestTab };
}

const isGroup = (value: string | undefined): value is ReproductionTabGroup =>
  value === 'run' || value === 'ev' || value === 'req';

/** L'onglet d'une preuve dans l'écran « Preuves ». */
function tabOfEvidence(kind: string | undefined): EvidenceTab {
  switch (kind) {
    case 'CONSOLE':
    case 'JS_ERROR':
      return 'console';
    case 'SCREENSHOT':
      return 'shots';
    case 'TRACE':
      return 'traces';
    default:
      return 'actions';
  }
}

/**
 * Le réducteur PUR de la reproduction et des preuves. Actions :
 * - `ws-repro-tab` (`tab` ∈ RUN_TABS), `ws-repro-ev-tab` (`tab` ∈ EVIDENCE_TABS), `ws-repro-req-tab`
 *   (`tab` ∈ REQUEST_TABS) ; `ws-repro-key` (`group` run|ev|req, `key` ArrowLeft/ArrowRight/Home/End) ;
 * - `ws-repro-pick` (`value` : identifiant de reproduction, vide = par défaut) ;
 * - `ws-repro-shot` (`file`) : la capture montrée ;
 * - `ws-repro-ev-errors` : seulement les échanges en erreur ;
 * - `ws-repro-ev-show` (`kind` request|evidence, `ref`, `evkind?`, `file?`) : ouvre l'onglet de la preuve
 *   (le contrôleur sélectionne aussi `kind:ref` et montre « Reproduction › Preuves ») ;
 * - `ws-repro-stop` / `ws-repro-stop-no` / `ws-repro-stop-yes` : la confirmation de « Arrêter » (le
 *   contrôleur appelle `incidents.cancel` sur `-yes`) ; `ws-repro-start` (le contrôleur appelle
 *   `incidents.reproduce`) referme la confirmation.
 */
export function reduceReproduction(
  ui: ReproductionUi,
  action: string,
  dataset: Record<string, string | undefined>,
): ReproductionUi | undefined {
  switch (action) {
    case 'ws-repro-tab':
      return withTab(ui, 'run', dataset.tab ?? '');
    case 'ws-repro-ev-tab':
      return withTab(ui, 'ev', dataset.tab ?? '');
    case 'ws-repro-req-tab':
      return withTab(ui, 'req', dataset.tab ?? '');
    case 'ws-repro-key': {
      const group = dataset.group;
      if (!isGroup(group)) return ui;
      const tabs = TAB_GROUPS[group];
      const at = tabs.indexOf(currentTab(ui, group));
      const next =
        dataset.key === 'ArrowRight'
          ? tabs[(at + 1) % tabs.length]
          : dataset.key === 'ArrowLeft'
            ? tabs[(at - 1 + tabs.length) % tabs.length]
            : dataset.key === 'Home'
              ? tabs[0]
              : dataset.key === 'End'
                ? tabs[tabs.length - 1]
                : undefined;
      return next === undefined ? ui : withTab(ui, group, next);
    }
    case 'ws-repro-pick': {
      const value = (dataset.value ?? '').trim();
      const { reproduction: _r, request: _q, shot: _s, ...rest } = ui;
      return value === ''
        ? { ...rest, confirmStop: false }
        : { ...rest, reproduction: value, confirmStop: false };
    }
    case 'ws-repro-shot': {
      const file = dataset.file;
      return file ? { ...ui, shot: file } : ui;
    }
    case 'ws-repro-ev-errors':
      return { ...ui, errorsOnly: !ui.errorsOnly };
    case 'ws-repro-ev-show': {
      const ref = dataset.ref;
      if (!ref) return ui;
      if (dataset.kind === 'request')
        return { ...ui, evidenceTab: 'http', request: ref, requestTab: 'details' };
      const tab = tabOfEvidence(dataset.evkind);
      return { ...ui, evidenceTab: tab, ...(tab === 'shots' && dataset.file ? { shot: dataset.file } : {}) };
    }
    case 'ws-repro-stop':
      return { ...ui, confirmStop: true };
    case 'ws-repro-stop-no':
    case 'ws-repro-stop-yes':
    case 'ws-repro-start':
      return ui.confirmStop ? { ...ui, confirmStop: false } : ui;
    default:
      return undefined;
  }
}

/** L'élément à focaliser après `ws-repro-key` ou un clic d'onglet. */
export function reproductionTabFocus(ui: ReproductionUi, group: ReproductionTabGroup): string {
  return `#ws-repro-${group}-tab-${currentTab(ui, group)}`;
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

export type ReproductionState = 'RUNNING' | 'REPRODUCED' | 'NOT_REPRODUCED' | 'FAILED' | 'CANCELLED';

const TEXT = {
  fr: {
    locale: 'fr-FR',
    runTitle: 'Reproduction avec Playwright',
    scenario: 'Scénario :',
    noScenario: 'aucun scénario',
    states: {
      RUNNING: 'En cours',
      REPRODUCED: 'Reproduit',
      NOT_REPRODUCED: 'Non reproduit',
      FAILED: 'Échec',
      CANCELLED: 'Annulé',
    } as Record<ReproductionState, string>,
    stateHints: {
      RUNNING: 'Le moteur rejoue le scénario.',
      REPRODUCED: 'Le symptôme décrit a été observé pendant le run.',
      NOT_REPRODUCED: 'Le run est allé au bout sans montrer le symptôme décrit.',
      FAILED: 'Le run n’a pas abouti : le symptôme n’a pas pu être comparé.',
      CANCELLED: 'Le run a été arrêté à la demande.',
    } as Record<ReproductionState, string>,
    elapsed: 'Temps écoulé',
    elapsedDone: 'Durée de la reproduction (du lancement à la fin)',
    stop: 'Arrêter',
    stopConfirm: 'Arrêter la reproduction',
    stopHint:
      'Arrêter annule l’investigation (état « Annulé ») : le moteur s’arrête, ce qu’il a déjà joué reste dans le run ; « Reprendre » la relance ensuite depuis le périmètre.',
    keep: 'Continuer',
    reproduce: 'Reproduire',
    reproduceAgain: 'Reproduire de nouveau',
    noRight: 'Votre rôle ne permet pas de lancer ni d’arrêter une reproduction (droit RUN).',
    demoOff: 'Indisponible dans la démonstration : aucun appel au serveur.',
    noScenarioWhy: 'L’incident n’a pas de scénario à rejouer : choisissez-le dans le périmètre.',
    navigateWhy: 'Le périmètre ne permet pas la navigation Playwright.',
    runningWhy: 'Une reproduction est déjà en cours.',
    stateWhy: (state: string) => `Indisponible dans l’état « ${state} » de l’incident.`,
    incidentStates: {
      DRAFT: 'Brouillon',
      SCOPED: 'Périmètre défini',
      REPRODUCING: 'Reproduction en cours',
      REPRODUCED: 'Reproduit',
      NOT_REPRODUCED: 'Non reproduit',
      INVESTIGATING: 'En investigation',
      DIAGNOSED: 'Diagnostiqué',
      INCONCLUSIVE: 'Inconclusif',
      CANCELLED: 'Annulé',
      FAILED: 'En échec',
    } as Record<IncidentState, string>,
    pick: 'Reproduction affichée',
    pickDefault: 'La dernière du scénario',
    pickReference: 'La reproduction de référence',
    pickOption: (id: string, scenario: string, state: string, at: string) =>
      `${id} · ${scenario} · ${state} · ${at}`,
    noRun: 'Aucune reproduction : lancez « Reproduire » pour rejouer le scénario de l’incident.',
    steps: 'Étapes du scénario',
    stepCount: (count: number) => `${String(count)} étape(s)`,
    stepStatus: {
      PASSED: 'Réussie',
      FAILED: 'En échec',
      BLOCKED: 'Bloquée',
      SKIPPED: 'Non jouée',
      MANUAL: 'Manuelle',
      RUNNING: 'En cours',
    } as Record<string, string>,
    notPlayed: 'non jouée',
    selectStep: (label: string) => `Sélectionner ${label}`,
    step: (index: number) => `Étape ${String(index)}`,
    waitingEngine:
      'En attente du moteur : aucune étape annoncée pour l’instant. Les étapes apparaissent dès que le moteur les commence.',
    flowStarted: (flow: string) => `Flow « ${flow} » démarré : aucune étape commencée pour l’instant.`,
    progress: (done: number, total: number) => `${String(done)} / ${String(total)}`,
    progressLabel: (done: number, total: number) =>
      `${String(done)} étape(s) commencée(s) sur ${String(total)} annoncée(s) par le moteur`,
    upcoming: (count: number) =>
      `${String(count)} étape(s) à venir : leur libellé apparaît quand le moteur les commence.`,
    runningNow: 'en cours',
    liveUpdated: (at: string) => `Dernier signal du moteur : ${at}`,
    noSteps: 'Aucune étape rapportée par le moteur pour ce run.',
    preview: 'Aperçu',
    previewOf: (label: string) => `Aperçu : ${label}`,
    shotAfter: (index: number) => `capture après l’étape ${String(index)}`,
    shotFile: (file: string) => `capture ${file}`,
    shotOf: (kind: string, step: number | undefined) =>
      `capture de l’anomalie (${kind}${step !== undefined ? `, étape ${String(step)}` : ''})`,
    noShotRunning: 'Aucune capture pour l’instant : le moteur n’en a pas encore écrit pendant ce run.',
    latestShot: (index: number | undefined) =>
      index !== undefined ? `dernière capture du run (étape ${String(index)})` : 'dernière capture du run',
    noShot: 'Aucune capture d’écran enregistrée pour cette reproduction.',
    shotLoading: 'Chargement de la capture…',
    shotDenied: 'Votre rôle ne permet pas de voir les captures d’écran.',
    shotAbsent: 'Capture non disponible.',
    shotNotInDemo: 'La capture d’écran n’est pas incluse dans les données de démonstration.',
    shotInvalid: 'Format de capture non pris en charge (seules les images data: sont affichées).',
    failedStep: (index: number) => `Étape ${String(index)} en échec`,
    failedRequests: 'Requêtes en erreur de l’étape',
    tabs: {
      shots: 'Captures d’écran',
      console: 'Console',
      traces: 'Traces',
      http: 'Requêtes HTTP',
    } as Record<RunTab, string>,
    runTabsLabel: 'Preuves de la reproduction',
    openShot: (label: string) => `Voir ${label} en grand`,
    noConsole: 'Aucune erreur console ni JavaScript capturée pendant cette reproduction.',
    noHttp: 'Aucune requête enregistrée pendant cette reproduction.',
    seeInEvidence: 'Voir dans Preuves',
    trace: 'Trace Playwright',
    tracePresent:
      'Le moteur a enregistré une trace Playwright (actions, instantanés du DOM, réseau, console).',
    tracePath: 'Fichier',
    traceHow:
      'La trace ne s’affiche pas dans le Dashboard : ouvrez-la sur le poste qui a exécuté la reproduction avec la commande ci-dessous (dossier du projet).',
    traceCommand: 'Commande',
    noTrace: 'Aucune trace Playwright pour cette reproduction (pas de trace.zip dans le dossier du run).',
    noTraceRunning: 'La trace est écrite à la fin du run.',
    // Preuves
    evidenceTitle: 'Preuves collectées',
    evidenceSub: 'Requêtes HTTP, console, captures, trace et actions de la reproduction.',
    evidenceTabs: {
      http: 'Requêtes HTTP',
      console: 'Console',
      shots: 'Captures d’écran',
      traces: 'Traces',
      actions: 'Actions',
    } as Record<EvidenceTab, string>,
    evidenceTabsLabel: 'Nature des preuves',
    evidenceRunning: 'Reproduction en cours : les preuves sont lues à la fin du run.',
    noEvidenceRun:
      'Aucune reproduction terminée du scénario de l’incident : lancez « Reproduire » depuis l’onglet Exécution.',
    errorsOnly: 'Seulement les échanges en erreur',
    requestCount: (shown: number, total: number) => `${String(shown)} requête(s) sur ${String(total)}`,
    noErrorRequests: 'Aucun échange en erreur.',
    columns: {
      index: '#',
      method: 'Méthode',
      url: 'URL',
      status: 'Statut',
      duration: 'Durée',
      action: 'Action',
    },
    httpCaption: 'Requêtes HTTP de la reproduction',
    openRequest: (label: string) => `Sélectionner la requête ${label}`,
    detailTabs: {
      details: 'Détails de la requête',
      headers: 'En-têtes',
      payload: 'Payload',
      response: 'Réponse',
      curl: 'cURL',
    } as Record<RequestTab, string>,
    detailTabsLabel: 'Détail de la requête',
    detailOf: (label: string) => `Détail de ${label}`,
    shownFirstError: 'Première requête en erreur (sélectionnez une ligne pour en voir une autre).',
    shownFirst: 'Première requête (sélectionnez une ligne pour en voir une autre).',
    facts: {
      method: 'Méthode',
      path: 'Chemin',
      status: 'Statut',
      duration: 'Durée',
      start: 'Départ',
      type: 'Type de ressource',
      step: 'Action',
      correlation: 'Corrélation',
      failure: 'Échec réseau',
    },
    noResponse: 'sans réponse',
    notCaptured: 'non capturé',
    correlationReasons: {
      OBSERVED: 'Vue pendant la fenêtre réseau de l’action.',
      INFERRED: 'Rattachée à l’action par son horodatage, sans observation directe.',
      STATICALLY_RESOLVED: 'Lue dans le code.',
      UNKNOWN: 'Aucune action ne l’encadre : le lien n’est pas établi.',
    } as Record<string, string>,
    graphNodes: 'Nœuds du graphe reliés',
    noGraphNodes: 'Aucun nœud du graphe ne cite cette requête.',
    requestHeaders: 'En-têtes de la requête',
    responseHeaders: 'En-têtes de la réponse',
    noHeaders:
      'Aucun en-tête gardé : seuls ceux de la liste blanche (type, longueur, cache, redirection, identifiants de corrélation) le sont, avec network.captureBodies.',
    headerName: 'Nom',
    headerValue: 'Valeur (masquée)',
    requestBody: 'Corps de la requête (masqué)',
    responseBody: 'Corps de la réponse (masqué)',
    noBody: 'Corps non capturé (seulement les erreurs et les écritures, avec network.captureBodies).',
    truncated: 'Corps tronqué à 8 Kio.',
    prettyJson: 'JSON mis en forme',
    curlTitle: 'Commande cURL reconstruite',
    curlNote:
      'Reconstruction à partir de l’échange capturé, pas la requête exacte : les valeurs sensibles sont masquées ([REDACTED]), seuls les en-têtes de la liste blanche sont repris (ni authentification ni cookie).',
    curlBase: (origin: string) =>
      `L’hôte n’est pas capturé : l’URL de base est celle de l’application rejouée (${origin}) ; corrigez-la si la requête visait un autre hôte.`,
    curlNoBase:
      'L’hôte n’est pas capturé et la reproduction n’a pas d’URL de base : définissez BASE_URL avant de lancer la commande.',
    curlTruncated: 'Le corps capturé est tronqué : la commande n’envoie pas le corps complet.',
    consoleColumns: { at: 'Heure', kind: 'Nature', step: 'Étape', message: 'Message', severity: 'Gravité' },
    consoleCaption: 'Erreurs console et JavaScript de la reproduction',
    evidenceKinds: {
      CONSOLE: 'Console',
      JS_ERROR: 'Erreur JavaScript',
      ASSERTION: 'Assertion',
      SCREENSHOT: 'Capture',
      TRACE: 'Trace',
      ACTION: 'Action',
      PAGE: 'Page',
    } as Record<string, string>,
    stack: 'Pile d’appels',
    noTime: 'heure inconnue',
    shotsCaption: 'Captures d’écran de la reproduction',
    actionsColumns: {
      index: '#',
      kind: 'Type',
      description: 'Description',
      status: 'Statut',
      duration: 'Durée',
      requests: 'Requêtes',
      reason: 'Raison',
    },
    actionsCaption: 'Actions Playwright de la reproduction',
    noActions: 'Aucune action rapportée pour cette reproduction.',
    assertions: 'Assertions non satisfaites',
    reference: 'référence',
  },
  en: {
    locale: 'en-GB',
    runTitle: 'Reproduction with Playwright',
    scenario: 'Scenario:',
    noScenario: 'no scenario',
    states: {
      RUNNING: 'Running',
      REPRODUCED: 'Reproduced',
      NOT_REPRODUCED: 'Not reproduced',
      FAILED: 'Failed',
      CANCELLED: 'Cancelled',
    } as Record<ReproductionState, string>,
    stateHints: {
      RUNNING: 'The engine is replaying the scenario.',
      REPRODUCED: 'The described symptom was observed during the run.',
      NOT_REPRODUCED: 'The run completed without showing the described symptom.',
      FAILED: 'The run did not complete: the symptom could not be compared.',
      CANCELLED: 'The run was stopped on request.',
    } as Record<ReproductionState, string>,
    elapsed: 'Elapsed time',
    elapsedDone: 'Reproduction duration (from start to end)',
    stop: 'Stop',
    stopConfirm: 'Stop the reproduction',
    stopHint:
      'Stopping cancels the investigation (state “Cancelled”): the engine stops, what it already played stays in the run; “Resume” then restarts it from the scope.',
    keep: 'Continue',
    reproduce: 'Reproduce',
    reproduceAgain: 'Reproduce again',
    noRight: 'Your role does not allow you to start or stop a reproduction (RUN right).',
    demoOff: 'Unavailable in the demonstration: no call to the server.',
    noScenarioWhy: 'The incident has no scenario to replay: choose it in the scope.',
    navigateWhy: 'The scope does not allow Playwright navigation.',
    runningWhy: 'A reproduction is already running.',
    stateWhy: (state: string) => `Unavailable in the incident state “${state}”.`,
    incidentStates: {
      DRAFT: 'Draft',
      SCOPED: 'Scoped',
      REPRODUCING: 'Reproducing',
      REPRODUCED: 'Reproduced',
      NOT_REPRODUCED: 'Not reproduced',
      INVESTIGATING: 'Investigating',
      DIAGNOSED: 'Diagnosed',
      INCONCLUSIVE: 'Inconclusive',
      CANCELLED: 'Cancelled',
      FAILED: 'Failed',
    } as Record<IncidentState, string>,
    pick: 'Reproduction shown',
    pickDefault: 'The latest of the scenario',
    pickReference: 'The reference reproduction',
    pickOption: (id: string, scenario: string, state: string, at: string) =>
      `${id} · ${scenario} · ${state} · ${at}`,
    noRun: 'No reproduction: start “Reproduce” to replay the incident scenario.',
    steps: 'Scenario steps',
    stepCount: (count: number) => `${String(count)} step(s)`,
    stepStatus: {
      PASSED: 'Passed',
      FAILED: 'Failed',
      BLOCKED: 'Blocked',
      SKIPPED: 'Not played',
      MANUAL: 'Manual',
      RUNNING: 'Running',
    } as Record<string, string>,
    notPlayed: 'not played',
    selectStep: (label: string) => `Select ${label}`,
    step: (index: number) => `Step ${String(index)}`,
    waitingEngine:
      'Waiting for the engine: no step announced yet. Steps appear as soon as the engine starts them.',
    flowStarted: (flow: string) => `Flow “${flow}” started: no step started yet.`,
    progress: (done: number, total: number) => `${String(done)} / ${String(total)}`,
    progressLabel: (done: number, total: number) =>
      `${String(done)} step(s) started out of ${String(total)} announced by the engine`,
    upcoming: (count: number) =>
      `${String(count)} step(s) to come: their label appears when the engine starts them.`,
    runningNow: 'running',
    liveUpdated: (at: string) => `Last signal from the engine: ${at}`,
    noSteps: 'No step reported by the engine for this run.',
    preview: 'Preview',
    previewOf: (label: string) => `Preview: ${label}`,
    shotAfter: (index: number) => `screenshot after step ${String(index)}`,
    shotFile: (file: string) => `screenshot ${file}`,
    shotOf: (kind: string, step: number | undefined) =>
      `screenshot of the anomaly (${kind}${step !== undefined ? `, step ${String(step)}` : ''})`,
    noShotRunning: 'No screenshot yet: the engine has not written one during this run.',
    latestShot: (index: number | undefined) =>
      index !== undefined
        ? `latest screenshot of the run (step ${String(index)})`
        : 'latest screenshot of the run',
    noShot: 'No screenshot recorded for this reproduction.',
    shotLoading: 'Loading the screenshot…',
    shotDenied: 'Your role does not allow you to see screenshots.',
    shotAbsent: 'Screenshot not available.',
    shotNotInDemo: 'The screenshot is not part of the demonstration data.',
    shotInvalid: 'Unsupported screenshot format (only data: images are shown).',
    failedStep: (index: number) => `Step ${String(index)} failed`,
    failedRequests: 'Failing requests of the step',
    tabs: {
      shots: 'Screenshots',
      console: 'Console',
      traces: 'Traces',
      http: 'HTTP requests',
    } as Record<RunTab, string>,
    runTabsLabel: 'Evidence of the reproduction',
    openShot: (label: string) => `Show ${label} large`,
    noConsole: 'No console or JavaScript error captured during this reproduction.',
    noHttp: 'No request recorded during this reproduction.',
    seeInEvidence: 'Show in Evidence',
    trace: 'Playwright trace',
    tracePresent: 'The engine recorded a Playwright trace (actions, DOM snapshots, network, console).',
    tracePath: 'File',
    traceHow:
      'The trace is not shown in the Dashboard: open it on the machine that ran the reproduction with the command below (project folder).',
    traceCommand: 'Command',
    noTrace: 'No Playwright trace for this reproduction (no trace.zip in the run folder).',
    noTraceRunning: 'The trace is written at the end of the run.',
    evidenceTitle: 'Collected evidence',
    evidenceSub: 'HTTP requests, console, screenshots, trace and actions of the reproduction.',
    evidenceTabs: {
      http: 'HTTP requests',
      console: 'Console',
      shots: 'Screenshots',
      traces: 'Traces',
      actions: 'Actions',
    } as Record<EvidenceTab, string>,
    evidenceTabsLabel: 'Kinds of evidence',
    evidenceRunning: 'Reproduction running: evidence is read at the end of the run.',
    noEvidenceRun:
      'No completed reproduction of the incident scenario: start “Reproduce” from the Execution tab.',
    errorsOnly: 'Only failing exchanges',
    requestCount: (shown: number, total: number) => `${String(shown)} of ${String(total)} request(s)`,
    noErrorRequests: 'No failing exchange.',
    columns: {
      index: '#',
      method: 'Method',
      url: 'URL',
      status: 'Status',
      duration: 'Duration',
      action: 'Action',
    },
    httpCaption: 'HTTP requests of the reproduction',
    openRequest: (label: string) => `Select request ${label}`,
    detailTabs: {
      details: 'Request details',
      headers: 'Headers',
      payload: 'Payload',
      response: 'Response',
      curl: 'cURL',
    } as Record<RequestTab, string>,
    detailTabsLabel: 'Request detail',
    detailOf: (label: string) => `Detail of ${label}`,
    shownFirstError: 'First failing request (select a row to see another one).',
    shownFirst: 'First request (select a row to see another one).',
    facts: {
      method: 'Method',
      path: 'Path',
      status: 'Status',
      duration: 'Duration',
      start: 'Start',
      type: 'Resource type',
      step: 'Action',
      correlation: 'Correlation',
      failure: 'Network failure',
    },
    noResponse: 'no response',
    notCaptured: 'not captured',
    correlationReasons: {
      OBSERVED: 'Seen during the network window of the action.',
      INFERRED: 'Attached to the action by its timestamp, not directly observed.',
      STATICALLY_RESOLVED: 'Read in the code.',
      UNKNOWN: 'No action frames it: the link is not established.',
    } as Record<string, string>,
    graphNodes: 'Related graph nodes',
    noGraphNodes: 'No graph node cites this request.',
    requestHeaders: 'Request headers',
    responseHeaders: 'Response headers',
    noHeaders:
      'No header kept: only allowlisted ones (type, length, cache, redirect, correlation identifiers) are, with network.captureBodies.',
    headerName: 'Name',
    headerValue: 'Value (masked)',
    requestBody: 'Request body (masked)',
    responseBody: 'Response body (masked)',
    noBody: 'Body not captured (only errors and writes, with network.captureBodies).',
    truncated: 'Body truncated to 8 KiB.',
    prettyJson: 'Formatted JSON',
    curlTitle: 'Reconstructed cURL command',
    curlNote:
      'Rebuilt from the captured exchange, not the exact request: sensitive values are masked ([REDACTED]), only allowlisted headers are kept (no authentication, no cookie).',
    curlBase: (origin: string) =>
      `The host is not captured: the base URL is the replayed application’s (${origin}); change it if the request targeted another host.`,
    curlNoBase:
      'The host is not captured and the reproduction has no base URL: set BASE_URL before running the command.',
    curlTruncated: 'The captured body is truncated: the command does not send the full body.',
    consoleColumns: { at: 'Time', kind: 'Kind', step: 'Step', message: 'Message', severity: 'Severity' },
    consoleCaption: 'Console and JavaScript errors of the reproduction',
    evidenceKinds: {
      CONSOLE: 'Console',
      JS_ERROR: 'JavaScript error',
      ASSERTION: 'Assertion',
      SCREENSHOT: 'Screenshot',
      TRACE: 'Trace',
      ACTION: 'Action',
      PAGE: 'Page',
    } as Record<string, string>,
    stack: 'Call stack',
    noTime: 'unknown time',
    shotsCaption: 'Screenshots of the reproduction',
    actionsColumns: {
      index: '#',
      kind: 'Kind',
      description: 'Description',
      status: 'Status',
      duration: 'Duration',
      requests: 'Requests',
      reason: 'Reason',
    },
    actionsCaption: 'Playwright actions of the reproduction',
    noActions: 'No action reported for this reproduction.',
    assertions: 'Unmet assertions',
    reference: 'reference',
  },
};

type Text = (typeof TEXT)['fr'];
const textOf = (lang: Lang): Text => TEXT[lang];

// ── Données ──────────────────────────────────────────────────────────────────────────────────

/** Ce que le contrôleur sait d'une capture : son image `data:`, ou l'état de sa lecture. */
export interface ShotView {
  dataUrl?: string;
  /** `absent` : pas disponible (démonstration, fichier absent du run). */
  state?: 'loading' | 'denied' | 'absent' | { error: string };
}

/** Ce que le contrôleur passe en plus des données de l'incident. */
export interface ReproductionMedia {
  /** Les captures lues (`incidents.screenshot`), par reproduction et fichier. */
  shot?: (reproduction: string, file: string) => ShotView | undefined;
  /** L'heure courante (ms) : le temps écoulé d'un run en cours ; absent : « --:--:-- » jusqu'au premier tic. */
  now?: number;
  /** L'action du serveur en cours (`ws-repro-start`, `ws-repro-stop-yes`) : bouton occupé. */
  busy?: string;
}

/** Les reproductions de l'incident pour son scénario (toutes, sinon). */
function scenarioRuns(ctx: WorkspaceContext): ReproductionRun[] {
  const runs = ctx.incident.investigation.reproductions;
  const scenario = ctx.incident.scenario;
  return scenario ? runs.filter((run) => run.scenario === scenario) : runs;
}

/**
 * La reproduction de l'écran « Exécution » : celle choisie, sinon la DERNIÈRE du scénario de l'incident,
 * quel que soit son statut (en cours, en échec, annulée) — c'est celle que l'on suit.
 */
export function runReproduction(ctx: WorkspaceContext, ui: ReproductionUi): ReproductionRun | undefined {
  const runs = ctx.incident.investigation.reproductions;
  const picked = ui.reproduction ? runs.find((run) => run.id === ui.reproduction) : undefined;
  return picked ?? scenarioRuns(ctx).at(-1);
}

/**
 * La reproduction de l'écran « Preuves » : celle choisie, sinon la reproduction de référence
 * (`incidentReproduction` : le dernier run terminé du scénario), sinon la dernière du scénario.
 */
export function evidenceReproduction(ctx: WorkspaceContext, ui: ReproductionUi): ReproductionRun | undefined {
  const runs = ctx.incident.investigation.reproductions;
  const picked = ui.reproduction ? runs.find((run) => run.id === ui.reproduction) : undefined;
  return picked ?? incidentReproduction(ctx.incident) ?? scenarioRuns(ctx).at(-1);
}

/** L'état affiché d'une reproduction. */
export function reproductionState(run: Pick<ReproductionRun, 'status' | 'reproduced'>): ReproductionState {
  switch (run.status) {
    case 'RUNNING':
      return 'RUNNING';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'FAILED':
      return 'FAILED';
    case 'COMPLETED':
      return run.reproduced === true ? 'REPRODUCED' : run.reproduced === false ? 'NOT_REPRODUCED' : 'FAILED';
  }
}

/** La reproduction affichée est-elle en cours (le contrôleur relit l'incident et fait avancer le compteur) ? */
export function reproductionRunning(ctx: WorkspaceContext, ui: ReproductionUi): boolean {
  return runReproduction(ctx, ui)?.status === 'RUNNING';
}

/**
 * L'empreinte du suivi en direct d'un incident : les reproductions en cours et le dernier signal de leur
 * moteur (`live.updatedAt`, servi depuis la mémoire du serveur, sans changer la révision). Le contrôleur la
 * compare en plus de `revision` pour savoir si l'incident relu doit être redessiné.
 */
export function liveStamp(incident: Pick<Incident, 'investigation'>): string {
  const reproductions = incident.investigation.reproductions
    .filter((run) => run.status === 'RUNNING')
    .map((run) => `${run.id}@${run.live?.updatedAt ?? ''}#${String(run.live?.steps.length ?? 0)}`);
  // Un run IA en cours est servi depuis la mémoire du serveur sans changer la révision : ses étapes et sa
  // consommation disent s'il a avancé.
  const ai = (incident.investigation.ai?.runs ?? [])
    .filter((run) => run.status === 'RUNNING')
    .map(
      (run) =>
        `${run.id}@${String(run.steps.length)}/${String(run.steps.filter((step) => step.status !== 'RUNNING').length)}#${String(run.findings.length)}#${String(run.usage.modelCalls)}#${String(run.proposals.length)}`,
    );
  // Un run de découverte des déclencheurs actif avance essai par essai (état, essais, actions, horodatage).
  const trigger = (incident.investigation.trigger?.runs ?? [])
    .filter((run) => ACTIVE_TRIGGER_STATES.includes(run.state))
    .map(
      (run) =>
        `${run.id}@${run.state}#${String(run.trials.length)}#${String(run.usage.actions)}#${run.updatedAt}`,
    );
  return [...reproductions, ...ai, ...trigger].join('|');
}

/** Un temps écoulé « hh:mm:ss » (le contrôleur l'écrit chaque seconde dans `[data-ws-ticking="true"]`). */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const STABLE_BEFORE_REPRODUCTION: readonly IncidentState[] = [
  'SCOPED',
  'REPRODUCED',
  'NOT_REPRODUCED',
  'INVESTIGATING',
  'DIAGNOSED',
  'INCONCLUSIVE',
  'FAILED',
];

/** Pourquoi « Reproduire » est indisponible (undefined : disponible). */
function reproduceBlocker(ctx: WorkspaceContext, t: Text): string | undefined {
  if (ctx.demo) return t.demoOff;
  if (!ctx.can('RUN')) return t.noRight;
  const incident = ctx.incident;
  if (incident.state === 'REPRODUCING') return t.runningWhy;
  if (!incident.scenario) return t.noScenarioWhy;
  if (!incident.scope.permissions.navigate) return t.navigateWhy;
  if (!STABLE_BEFORE_REPRODUCTION.includes(incident.state))
    return t.stateWhy(t.incidentStates[incident.state]);
  return undefined;
}

/** Une étape affichée : celle de l'incident (actions), ou celle annoncée par le moteur pendant le run (live). */
interface StepRow {
  index: number;
  description: string;
  status: string;
  /** La durée mesurée par le moteur (absente pour une étape en cours ou jamais jouée). */
  durationMs?: number;
  reason?: string;
  screenshot?: string;
  /** Une étape de l'incident (sélectionnable : `step:<reproduction>#<index>`). */
  selectable: boolean;
}

function stepRows(run: ReproductionRun): StepRow[] {
  if (run.actions.length > 0)
    return run.actions.map((action) => ({
      index: action.index,
      description: action.description,
      status: action.status,
      durationMs: action.durationMs,
      ...(action.reason ? { reason: action.reason } : {}),
      ...(action.screenshot ? { screenshot: action.screenshot } : {}),
      selectable: true,
    }));
  if (run.status !== 'RUNNING') return [];
  return [...(run.live?.steps ?? [])]
    .sort((a, b) => a.index - b.index)
    .map((step) => ({
      index: step.index,
      description: step.description,
      status: step.status,
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      ...(step.reason ? { reason: step.reason } : {}),
      ...(step.screenshot ? { screenshot: step.screenshot } : {}),
      selectable: false,
    }));
}

type StepTone = 'done' | 'failed' | 'running' | 'skipped' | 'other';

function stepTone(status: string): StepTone {
  switch (status) {
    case 'PASSED':
      return 'done';
    case 'FAILED':
    case 'BLOCKED':
      return 'failed';
    case 'RUNNING':
      return 'running';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'other';
  }
}

const STEP_ICON: Record<StepTone, string> = {
  done: 'check',
  failed: 'x',
  running: 'clock',
  skipped: 'ban',
  other: 'spark',
};

/** Une durée n'est affichée que pour une étape jouée (mesurée par le moteur). */
const playedDuration = (
  row: Pick<StepRow, 'status' | 'durationMs'>,
): row is { status: string; durationMs: number } =>
  row.status !== 'SKIPPED' &&
  row.status !== 'RUNNING' &&
  row.durationMs !== undefined &&
  Number.isFinite(row.durationMs) &&
  row.durationMs >= 0;

/** La première étape en échec (ou bloquée) d'une reproduction. */
function failingAction(run: ReproductionRun): ActionEvidence | undefined {
  return run.actions.find((action) => action.status === 'FAILED' || action.status === 'BLOCKED');
}

/** Les captures d'une reproduction, avec leur étape et leur preuve quand elles en ont une. */
interface ShotItem {
  file: string;
  step?: number;
  evidence?: Evidence;
  /** La capture d'une action (prise après l'étape), sinon celle d'une anomalie ou du run. */
  afterStep: boolean;
  /** Une capture annoncée pendant le run (étape en cours ou dernière capture), avec son étape si connue. */
  live?: { step?: number };
}

function shotsOf(run: ReproductionRun): ShotItem[] {
  const items: ShotItem[] = [];
  const seen = new Set<string>();
  const add = (file: string, step: number | undefined, live?: { step?: number }): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const evidence =
      run.evidence.find((item) => item.kind === 'SCREENSHOT' && item.source.file === file) ??
      run.evidence.find((item) => item.source.file === file);
    const at = step ?? evidence?.source.step;
    items.push({
      file,
      ...(at !== undefined ? { step: at } : {}),
      ...(evidence ? { evidence } : {}),
      afterStep: step !== undefined,
      ...(live ? { live } : {}),
    });
  };
  if (run.status === 'RUNNING' && run.actions.length === 0) {
    // Pendant le run : seulement les captures que le moteur a annoncées (étapes, puis la dernière).
    for (const step of [...(run.live?.steps ?? [])].sort((a, b) => a.index - b.index))
      if (step.screenshot)
        add(
          step.screenshot,
          step.status === 'RUNNING' ? undefined : step.index,
          step.status === 'RUNNING' ? { step: step.index } : undefined,
        );
    if (run.live?.latestScreenshot) add(run.live.latestScreenshot, undefined, {});
    return items;
  }
  for (const action of [...run.actions].sort((a, b) => a.index - b.index))
    if (action.screenshot && run.screenshots.includes(action.screenshot))
      add(action.screenshot, action.index);
  for (const file of run.screenshots) add(file, undefined);
  return items;
}

/**
 * La capture de l'aperçu : celle que la sélection désigne (preuve de ce run), sinon celle choisie
 * (`ui.shot`), sinon la dernière (étape la plus avancée, puis la dernière enregistrée).
 */
function previewShot(ctx: WorkspaceContext, ui: ReproductionUi, run: ReproductionRun): ShotItem | undefined {
  const shots = shotsOf(run);
  if (shots.length === 0) return undefined;
  if (ctx.selection?.kind === 'evidence') {
    const id = ctx.selection.id;
    const selected = shots.find((shot) => shot.evidence?.id === id);
    if (selected) return selected;
  }
  const chosen = ui.shot ? shots.find((shot) => shot.file === ui.shot) : undefined;
  if (chosen) return chosen;
  const latest = run.status === 'RUNNING' ? run.live?.latestScreenshot : undefined;
  if (latest) return shots.find((shot) => shot.file === latest);
  const stepped = shots.filter((shot) => shot.afterStep);
  return stepped.sort((a, b) => (a.step ?? 0) - (b.step ?? 0)).at(-1) ?? shots.at(-1);
}

/** Les captures à lire (`incidents.screenshot`) pour la vue affichée : l'aperçu d'abord, au plus 12. */
export function neededShots(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  view: 'run' | 'evidence',
): { reproduction: string; file: string }[] {
  const run = view === 'run' ? runReproduction(ctx, ui) : evidenceReproduction(ctx, ui);
  if (!run) return [];
  const shots = shotsOf(run);
  const first = previewShot(ctx, ui, run);
  const showsStrip = view === 'run' ? ui.runTab === 'shots' : ui.evidenceTab === 'shots';
  if (view === 'evidence' && !showsStrip) return [];
  const ordered = [
    ...(first ? [first] : []),
    ...(showsStrip ? shots.filter((shot) => shot.file !== first?.file) : []),
  ];
  return ordered.slice(0, 12).map((shot) => ({ reproduction: run.id, file: shot.file }));
}

const consoleOf = (run: ReproductionRun): Evidence[] =>
  run.evidence.filter((item) => item.kind === 'CONSOLE' || item.kind === 'JS_ERROR');

function sortedRequests(run: ReproductionRun): HttpExchange[] {
  return [...run.requests].sort(
    (left, right) =>
      (left.step ?? Number.MAX_SAFE_INTEGER) - (right.step ?? Number.MAX_SAFE_INTEGER) ||
      run.requests.indexOf(left) - run.requests.indexOf(right),
  );
}

const requestLabel = (request: Pick<HttpExchange, 'method' | 'path'>): string =>
  `${request.method} ${request.path}`;

function formatAt(lang: Lang, at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(textOf(lang).locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── cURL ─────────────────────────────────────────────────────────────────────────────────────

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Les en-têtes que curl calcule lui-même : jamais repris. */
const COMPUTED_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);

/** L'origine (schéma, hôte, port) d'une URL de base, sans identifiants ; undefined si invalide. */
export function baseOrigin(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Un corps prêt pour la ligne de commande : JSON compact masqué, sinon le texte masqué. */
function commandBody(body: string): string {
  if (/^\s*[[{]/.test(body)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(body)));
    } catch {
      // Pas du JSON (ou tronqué) : le texte masqué.
    }
  }
  return maskText(body);
}

/**
 * LA COMMANDE cURL d'un échange capturé, reconstruite côté client (pure) : méthode, URL (origine de
 * `baseUrl` + chemin capturé ; sans base, `"$BASE_URL"`), en-têtes de la liste blanche (jamais
 * d'authentification, de cookie ni d'en-tête calculé par curl), valeurs masquées, corps masqué. Les
 * arguments sont entre apostrophes (shell POSIX). Ce n'est pas la requête exacte : l'interface le dit.
 */
export function curlOf(
  exchange: Pick<HttpExchange, 'method' | 'path' | 'requestHeaders' | 'requestBody'>,
  baseUrl?: string,
): string {
  const method = exchange.method.toUpperCase();
  const origin = baseOrigin(baseUrl);
  const path = exchange.path.startsWith('/') ? exchange.path : `/${exchange.path}`;
  const url = origin ? quote(`${origin}${path}`) : `"$BASE_URL"${quote(path)}`;
  const parts = [
    `curl${method === 'GET' ? '' : ` -X ${/^[A-Z]+$/.test(method) ? method : quote(method)}`} ${url}`,
  ];
  for (const [name, value] of Object.entries(exchange.requestHeaders ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (isSensitiveHeader(name) || COMPUTED_HEADERS.has(name.toLowerCase())) continue;
    parts.push(`-H ${quote(`${name}: ${maskText(value)}`)}`);
  }
  if (exchange.requestBody !== undefined)
    parts.push(`--data-raw ${quote(commandBody(exchange.requestBody))}`);
  return parts.join(' \\\n  ');
}

// ── Briques de rendu ─────────────────────────────────────────────────────────────────────────

const STATE_TONE: Record<ReproductionState, string> = {
  RUNNING: 'live',
  REPRODUCED: 'ko',
  NOT_REPRODUCED: 'mu',
  FAILED: 'warn',
  CANCELLED: 'mu',
};

function statePill(lang: Lang, state: ReproductionState): string {
  const t = textOf(lang);
  return `<span class="pill ${STATE_TONE[state]} ws-repro-state" title="${esc(t.stateHints[state])}">${state === 'RUNNING' ? '<span class="ws-repro-pulse" aria-hidden="true"></span>' : ''}${esc(t.states[state])}</span>`;
}

function timer(lang: Lang, run: ReproductionRun, now: number | undefined): string {
  const t = textOf(lang);
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return '';
  if (run.status === 'RUNNING') {
    const text = now !== undefined ? formatElapsed(now - start) : '--:--:--';
    return `<span class="ws-repro-timer" role="timer" aria-label="${esc(t.elapsed)}" title="${esc(t.elapsed)}">${icon('clock')}<span data-ws-elapsed-from="${esc(run.startedAt)}" data-ws-ticking="true">${esc(text)}</span></span>`;
  }
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  if (!Number.isFinite(end)) return '';
  return `<span class="ws-repro-timer" title="${esc(t.elapsedDone)}">${icon('clock')}<span class="ws-repro-sr">${esc(t.elapsedDone)} : </span><span data-ws-elapsed-from="${esc(run.startedAt)}" data-ws-ticking="false">${esc(formatElapsed(end - start))}</span></span>`;
}

/** Un bouton indisponible garde sa raison (infobulle et texte lu). */
function button(options: {
  action: string;
  label: string;
  cls: string;
  why?: string | undefined;
  busy?: boolean;
  extra?: string;
  iconName?: string;
}): string {
  const off = options.why !== undefined || options.busy === true;
  return `<button type="button" class="btn small ${options.cls}" data-action="${options.action}"${off ? ' disabled' : ''}${options.why ? ` title="${esc(options.why)}"` : ''} aria-busy="${String(options.busy === true)}"${options.extra ?? ''}>${options.iconName ? icon(options.iconName) : ''}<span>${esc(options.label)}</span></button>`;
}

function runActions(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  run: ReproductionRun | undefined,
  media: ReproductionMedia,
): string {
  const t = textOf(ctx.lang);
  const blocker = reproduceBlocker(ctx, t);
  const reproduce = button({
    action: 'ws-repro-start',
    label: run ? t.reproduceAgain : t.reproduce,
    cls: run ? '' : 'primary',
    why: blocker,
    busy: media.busy === 'ws-repro-start',
    iconName: 'play',
  });
  const running = run?.status === 'RUNNING' && ctx.incident.state === 'REPRODUCING';
  if (!running) return `<div class="ws-repro-acts">${reproduce}</div>`;
  const stopWhy = ctx.demo ? t.demoOff : ctx.can('RUN') ? undefined : t.noRight;
  if (ui.confirmStop && stopWhy === undefined)
    return `<div class="ws-repro-acts"><div class="ws-repro-confirm" role="group" aria-labelledby="ws-repro-stop-hint"><p id="ws-repro-stop-hint" class="ws-repro-small">${esc(t.stopHint)}</p><span class="ws-repro-confirm-b">${button({ action: 'ws-repro-stop-yes', label: t.stopConfirm, cls: 'danger', busy: media.busy === 'ws-repro-stop-yes', iconName: 'stop' })}${button({ action: 'ws-repro-stop-no', label: t.keep, cls: 'ghost' })}</span></div></div>`;
  const stop = button({
    action: 'ws-repro-stop',
    label: t.stop,
    cls: 'danger',
    why: stopWhy,
    iconName: 'stop',
    extra: ' aria-haspopup="true"',
  });
  return `<div class="ws-repro-acts">${stop}${reproduce}</div>`;
}

function picker(ctx: WorkspaceContext, ui: ReproductionUi, defaultLabel: string): string {
  const t = textOf(ctx.lang);
  const runs = ctx.incident.investigation.reproductions;
  if (runs.length < 2) return '';
  const reference = incidentReproduction(ctx.incident)?.id;
  const options = [...runs]
    .reverse()
    .map(
      (run) =>
        `<option value="${esc(run.id)}"${ui.reproduction === run.id ? ' selected' : ''}>${esc(
          t.pickOption(
            run.id,
            run.scenario,
            t.states[reproductionState(run)],
            formatAt(ctx.lang, run.finishedAt ?? run.startedAt),
          ),
        )}${run.id === reference ? ` (${esc(t.reference)})` : ''}</option>`,
    )
    .join('');
  return `<label class="ws-repro-pick"><span class="ws-repro-small mu">${esc(t.pick)}</span><select data-action="ws-repro-pick"><option value=""${ui.reproduction === undefined ? ' selected' : ''}>${esc(defaultLabel)}</option>${options}</select></label>`;
}

/** Une barre d'onglets à tabindex itinérant (`ws-repro-key` au clavier). */
function tabBar(
  group: ReproductionTabGroup,
  action: string,
  label: string,
  tabs: readonly { key: string; label: string; count?: number }[],
  current: string,
): string {
  return `<div class="ws-repro-tabs" role="tablist" aria-label="${esc(label)}">${tabs
    .map((tab) => {
      const on = tab.key === current;
      return `<button type="button" role="tab" id="ws-repro-${group}-tab-${tab.key}" class="ws-repro-tab" aria-selected="${String(on)}" aria-controls="ws-repro-${group}-panel" tabindex="${on ? '0' : '-1'}" data-action="${action}" data-tab="${tab.key}" data-group="${group}">${esc(tab.label)}${tab.count !== undefined ? ` <span class="ws-repro-count">(${String(tab.count)})</span>` : ''}</button>`;
    })
    .join('')}</div>`;
}

function tabPanel(group: ReproductionTabGroup, current: string, body: string, cls = ''): string {
  return `<div id="ws-repro-${group}-panel" class="ws-repro-panel${cls ? ` ${cls}` : ''}" role="tabpanel" aria-labelledby="ws-repro-${group}-tab-${current}" tabindex="0">${body}</div>`;
}

/** L'image d'une capture (ou l'état de sa lecture). */
function shotImage(
  ctx: WorkspaceContext,
  media: ReproductionMedia,
  run: ReproductionRun,
  file: string,
  label: string,
  cls: string,
): string {
  const t = textOf(ctx.lang);
  const view = media.shot?.(run.id, file);
  if (view?.dataUrl !== undefined)
    return isDataImage(view.dataUrl)
      ? `<img class="${cls}" src="${esc(view.dataUrl)}" alt="${esc(label)}" decoding="async">`
      : `<p class="ws-repro-shot-st err">${esc(t.shotInvalid)}</p>`;
  const state = view?.state ?? (ctx.demo ? 'absent' : 'loading');
  if (state === 'loading')
    return `<p class="ws-repro-shot-st mu" aria-busy="true"><span class="spin" aria-hidden="true"></span>${esc(t.shotLoading)}</p>`;
  if (state === 'denied') return `<p class="ws-repro-shot-st mu">${esc(t.shotDenied)}</p>`;
  if (state === 'absent')
    return `<p class="ws-repro-shot-st mu">${esc(ctx.demo ? t.shotNotInDemo : t.shotAbsent)}</p>`;
  return `<p class="ws-repro-shot-st err" role="alert">${esc(state.error)} <button type="button" class="lnk" data-action="ws-shot-reload">${esc(partsText(ctx.lang).retry)}</button></p>`;
}

function shotLabel(lang: Lang, shot: ShotItem): string {
  const t = textOf(lang);
  if (shot.afterStep && shot.step !== undefined) return t.shotAfter(shot.step);
  if (shot.live) return t.latestShot(shot.live.step);
  const kind = shot.evidence && shot.evidence.kind !== 'SCREENSHOT' ? shot.evidence.kind : undefined;
  if (kind) return t.shotOf(t.evidenceKinds[kind] ?? kind, shot.step);
  return t.shotFile(shot.file.split('/').at(-1) ?? shot.file);
}

/** Un bouton de capture : la sélectionne (sa preuve) ou la montre dans l'aperçu (`ws-repro-shot`). */
function shotButton(
  ctx: WorkspaceContext,
  shot: ShotItem,
  current: boolean,
  content: string,
  cls: string,
): string {
  const t = textOf(ctx.lang);
  const label = shotLabel(ctx.lang, shot);
  const attrs = shot.evidence
    ? selectable(ctx, 'evidence', shot.evidence.id)
    : `data-action="ws-repro-shot" data-file="${esc(shot.file)}" aria-pressed="${String(current)}"`;
  const state = shot.evidence ? selectionClass(ctx, 'evidence', shot.evidence.id) : '';
  return `<button type="button" class="${cls}${current ? ' ws-repro-on' : ''} ${state}" ${attrs} aria-label="${esc(t.openShot(label))}" title="${esc(label)}">${content}</button>`;
}

// ── « Exécution » ────────────────────────────────────────────────────────────────────────────

function stepsList(ctx: WorkspaceContext, run: ReproductionRun): string {
  const t = textOf(ctx.lang);
  const rows = stepRows(run);
  const notes: string[] = [];
  const live = run.status === 'RUNNING' && run.actions.length === 0 ? run.live : undefined;
  let progress = '';
  let upcoming = '';
  if (run.status === 'RUNNING' && run.actions.length === 0) {
    if (!live)
      notes.push(
        `<p class="ws-repro-note" aria-busy="true"><span class="spin" aria-hidden="true"></span> ${esc(t.waitingEngine)}</p>`,
      );
    else {
      if (rows.length === 0)
        notes.push(
          `<p class="ws-repro-note" role="note">${esc(live.flow ? t.flowStarted(live.flow) : t.waitingEngine)}</p>`,
        );
      if (live.total !== undefined && live.total > 0) {
        const done = Math.min(rows.length, live.total);
        progress = `<span class="ws-repro-prog" title="${esc(t.progressLabel(done, live.total))}"><span class="ws-repro-sr">${esc(t.progressLabel(done, live.total))}</span><span aria-hidden="true">${esc(t.progress(done, live.total))}</span><progress max="${String(live.total)}" value="${String(done)}" aria-hidden="true"></progress></span>`;
        if (live.total > rows.length)
          upcoming = `<p class="ws-repro-small mu ws-repro-upcoming">${esc(t.upcoming(live.total - rows.length))}</p>`;
      }
      notes.push(
        `<p class="ws-repro-small mu"><time datetime="${esc(live.updatedAt)}">${esc(t.liveUpdated(clock(ctx.lang, live.updatedAt)))}</time></p>`,
      );
    }
  }
  if (rows.length === 0)
    return `<section class="ws-repro-steps-box" aria-label="${esc(t.steps)}"><h3 class="ws-repro-h">${esc(t.steps)}${progress}</h3>${notes.join('')}${upcoming}${run.status === 'RUNNING' ? '' : `<p class="mu ws-repro-small">${esc(t.noSteps)}</p>`}</section>`;
  const items = rows
    .map((row) => {
      const tone = stepTone(row.status);
      const statusLabel = t.stepStatus[row.status] ?? row.status;
      const duration = playedDuration(row)
        ? esc(formatDuration(ctx.lang, row.durationMs))
        : row.status === 'RUNNING'
          ? `<span class="ws-repro-now">${esc(t.runningNow)}</span>`
          : `<span class="mu">${esc(row.status === 'SKIPPED' ? t.notPlayed : '…')}</span>`;
      const content = `<span class="ws-repro-ico ws-repro-ico-${tone}" aria-hidden="true">${icon(STEP_ICON[tone])}</span><span class="ws-repro-idx">${String(row.index)}</span><span class="ws-repro-desc">${esc(row.description)}</span><span class="ws-repro-sr">, ${esc(statusLabel)}</span><span class="ws-repro-dur">${duration}</span>`;
      const id = stepId(run.id, row.index);
      const main = row.selectable
        ? `<button type="button" class="ws-repro-stepb" ${selectable(ctx, 'step', id)} aria-label="${esc(t.selectStep(`${t.step(row.index)} : ${row.description}, ${statusLabel}`))}">${content}</button>`
        : `<div class="ws-repro-stepb">${content}</div>`;
      const reason =
        tone === 'failed' && row.reason
          ? `<p class="ws-repro-why" title="${esc(row.reason)}">${esc(row.reason.length > 240 ? `${row.reason.slice(0, 239)}…` : row.reason)}</p>`
          : '';
      return `<li class="ws-repro-step ws-repro-st-${tone} ${row.selectable ? selectionClass(ctx, 'step', id) : ''}" title="${esc(statusLabel)}"${row.status === 'RUNNING' ? ' aria-current="step"' : ''}>${main}${reason}</li>`;
    })
    .join('');
  const count = progress || ` <small class="mu">${esc(t.stepCount(rows.length))}</small>`;
  return `<section class="ws-repro-steps-box" aria-label="${esc(t.steps)}"><h3 class="ws-repro-h">${esc(t.steps)}${count}</h3>${notes.join('')}<ol class="ws-repro-steps">${items}</ol>${upcoming}</section>`;
}

/** L'erreur de l'étape en échec, posée sur l'aperçu (raison du moteur, preuves et requêtes en erreur). */
function errorToast(ctx: WorkspaceContext, run: ReproductionRun): string {
  const t = textOf(ctx.lang);
  if (run.status === 'RUNNING' && run.actions.length === 0) {
    const step = run.live?.steps.find((entry) => entry.status === 'FAILED' || entry.status === 'BLOCKED');
    if (!step) return '';
    const why = step.reason;
    return `<div class="ws-repro-toast" role="note">${icon('alert')}<div><b>${esc(t.failedStep(step.index))}</b>${why ? `<p title="${esc(why)}">${esc(why.length > 200 ? `${why.slice(0, 199)}…` : why)}</p>` : ''}</div></div>`;
  }
  const action = failingAction(run);
  if (!action) return '';
  const evidence = run.evidence.filter(
    (item) => item.source.step === action.index && (item.kind === 'ASSERTION' || item.kind === 'JS_ERROR'),
  );
  const failing = run.requests.filter((request) => request.step === action.index && isFailing(request));
  const reason = action.reason ?? evidence[0]?.summary;
  const requests =
    failing.length > 0
      ? `<ul class="ws-repro-toast-req" aria-label="${esc(t.failedRequests)}">${failing
          .slice(0, 3)
          .map(
            (request) =>
              `<li><button type="button" class="lnk ${selectionClass(ctx, 'request', request.id)}" ${selectable(ctx, 'request', request.id)} aria-label="${esc(t.openRequest(requestLabel(request)))}"><code>${esc(requestLabel(request))}</code></button> ${statusPill(ctx.lang, request)}</li>`,
          )
          .join('')}</ul>`
      : '';
  return `<div class="ws-repro-toast" role="note">${icon('alert')}<div><b>${esc(t.failedStep(action.index))}</b>${reason ? `<p title="${esc(reason)}">${esc(reason.length > 200 ? `${reason.slice(0, 199)}…` : reason)}</p>` : ''}${requests}</div></div>`;
}

function previewBox(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  run: ReproductionRun,
  media: ReproductionMedia,
): string {
  const t = textOf(ctx.lang);
  const shot = previewShot(ctx, ui, run);
  const label = shot ? shotLabel(ctx.lang, shot) : undefined;
  const stage = shot
    ? shotImage(ctx, media, run, shot.file, label ?? '', 'ws-repro-img')
    : `<p class="ws-repro-shot-st mu">${esc(run.status === 'RUNNING' ? t.noShotRunning : t.noShot)}</p>`;
  return `<figure class="ws-repro-preview" aria-label="${esc(label ? t.previewOf(label) : t.preview)}"><figcaption class="ws-repro-h">${esc(t.preview)}${label ? ` <small class="mu">${esc(label)}</small>` : ''}</figcaption><div class="ws-repro-stage">${stage}${errorToast(ctx, run)}</div></figure>`;
}

function consoleList(ctx: WorkspaceContext, run: ReproductionRun, limit: number): string {
  const t = textOf(ctx.lang);
  const items = consoleOf(run);
  if (items.length === 0) return panelState(ctx.lang, 'empty', t.noConsole);
  return `<ul class="ws-repro-list">${items
    .slice(0, limit)
    .map(
      (item) =>
        `<li class="${selectionClass(ctx, 'evidence', item.id)}"><button type="button" class="ws-repro-rowb" ${selectable(ctx, 'evidence', item.id)}><span class="ws-repro-kind ws-repro-kind-${item.kind === 'JS_ERROR' ? 'js' : 'console'}">${esc(t.evidenceKinds[item.kind] ?? item.kind)}</span>${item.source.step !== undefined ? `<span class="mu ws-repro-small">${esc(t.step(item.source.step))}</span>` : ''}<code class="ws-repro-msg">${esc(item.summary)}</code></button></li>`,
    )
    .join(
      '',
    )}</ul>${items.length > limit ? `<p class="mu ws-repro-small">+${String(items.length - limit)}</p>` : ''}`;
}

function traceBlock(ctx: WorkspaceContext, run: ReproductionRun): string {
  const t = textOf(ctx.lang);
  if (!run.trace)
    return panelState(ctx.lang, 'empty', run.status === 'RUNNING' ? t.noTraceRunning : t.noTrace);
  const file = run.run ? `qa-reports/${run.run}/${run.trace}` : run.trace;
  const evidence = run.evidence.find((item) => item.kind === 'TRACE');
  return `<div class="ws-repro-trace">${evidence ? `<p><button type="button" class="lnk ${selectionClass(ctx, 'evidence', evidence.id)}" ${selectable(ctx, 'evidence', evidence.id)}>${icon('layers')} ${esc(t.trace)}</button></p>` : `<p><b>${esc(t.trace)}</b></p>`}<p class="ws-repro-small">${esc(t.tracePresent)}</p><dl class="ws-repro-dl"><div><dt>${esc(t.tracePath)}</dt><dd><code>${esc(file)}</code></dd></div><div><dt>${esc(t.traceCommand)}</dt><dd><code class="ws-repro-cmd">${esc(`npx playwright show-trace ${file}`)}</code></dd></div></dl><p class="ws-repro-note" role="note">${esc(t.traceHow)}</p></div>`;
}

function httpMini(ctx: WorkspaceContext, run: ReproductionRun): string {
  const t = textOf(ctx.lang);
  const requests = sortedRequests(run);
  if (requests.length === 0) return panelState(ctx.lang, 'empty', t.noHttp);
  return `<ul class="ws-repro-list">${requests
    .map(
      (request) =>
        `<li class="${isFailing(request) ? 'ws-repro-ko ' : ''}${selectionClass(ctx, 'request', request.id)}"><button type="button" class="ws-repro-rowb" ${selectable(ctx, 'request', request.id)} aria-label="${esc(t.openRequest(requestLabel(request)))}"><code class="ws-repro-meth">${esc(request.method)}</code><code class="ws-repro-msg">${esc(request.path)}</code>${statusPill(ctx.lang, request)}<span class="ws-repro-dur">${request.durationMs !== undefined ? esc(formatDuration(ctx.lang, request.durationMs)) : '—'}</span></button><button type="button" class="lnk ws-repro-small" data-action="ws-repro-ev-show" data-kind="request" data-ref="${esc(request.id)}">${esc(t.seeInEvidence)}</button></li>`,
    )
    .join('')}</ul>`;
}

function thumbStrip(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  run: ReproductionRun,
  media: ReproductionMedia,
): string {
  const t = textOf(ctx.lang);
  const shots = shotsOf(run);
  if (shots.length === 0)
    return panelState(ctx.lang, 'empty', run.status === 'RUNNING' ? t.noShotRunning : t.noShot);
  const preview = previewShot(ctx, ui, run);
  return `<ul class="ws-repro-strip">${shots
    .map((shot) => {
      const label = shotLabel(ctx.lang, shot);
      return `<li>${shotButton(ctx, shot, shot.file === preview?.file, `<span class="ws-repro-thumb-i">${shotImage(ctx, media, run, shot.file, label, 'ws-repro-thumb-img')}</span><span class="ws-repro-small">${esc(label)}</span>`, 'ws-repro-thumb')}</li>`;
    })
    .join('')}</ul>`;
}

/**
 * L'ÉCRAN « EXÉCUTION » (Reproduction avec Playwright). Pendant le run, tout vient de
 * `reproduction.live` (l'incident relu) ; `media` : les captures lues (`incidents.screenshot`, captures
 * annoncées comprises), l'heure courante (compteur) et l'action du serveur en cours.
 */
export function renderReproductionRun(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  media: ReproductionMedia = {},
): string {
  const t = textOf(ctx.lang);
  const run = runReproduction(ctx, ui);
  const scenario = run?.scenario ?? ctx.incident.scenario;
  const head = `<header class="ws-repro-head"><h2 class="ws-repro-title"><span class="mu">${esc(t.scenario)}</span> ${scenario ? esc(scenario) : `<span class="mu">${esc(t.noScenario)}</span>`}</h2>${run ? statePill(ctx.lang, reproductionState(run)) : ''}${run ? timer(ctx.lang, run, media.now) : ''}${picker(ctx, ui, t.pickDefault)}${runActions(ctx, ui, run, media)}</header>`;
  if (!run)
    return `<section class="ws-repro ws-repro-run" aria-label="${esc(t.runTitle)}">${head}${panelState(ctx.lang, 'empty', t.noRun)}</section>`;
  const error =
    run.error && run.status !== 'RUNNING'
      ? `<p class="ws-repro-note err" role="alert">${esc(run.error)}</p>`
      : '';
  const counts = {
    shots: shotsOf(run).length,
    console: consoleOf(run).length,
    http: run.requests.length,
  };
  const tabs = RUN_TABS.map((key) => ({
    key,
    label: t.tabs[key],
    ...(key === 'traces' ? {} : { count: counts[key] }),
  }));
  const panel =
    ui.runTab === 'shots'
      ? thumbStrip(ctx, ui, run, media)
      : ui.runTab === 'console'
        ? consoleList(ctx, run, 50)
        : ui.runTab === 'traces'
          ? traceBlock(ctx, run)
          : httpMini(ctx, run);
  return `<section class="ws-repro ws-repro-run" aria-label="${esc(t.runTitle)}" data-reproduction="${esc(run.id)}" data-state="${reproductionState(run)}">${head}${error}${run.symptomMatch && run.status !== 'RUNNING' ? `<p class="ws-repro-small mu ws-repro-match">${esc(run.symptomMatch)}</p>` : ''}<div class="ws-repro-grid">${stepsList(ctx, run)}${previewBox(ctx, ui, run, media)}</div><div class="ws-repro-bottom">${tabBar('run', 'ws-repro-tab', t.runTabsLabel, tabs, ui.runTab)}${tabPanel('run', ui.runTab, panel)}</div></section>`;
}

// ── « Preuves » ──────────────────────────────────────────────────────────────────────────────

/** La requête détaillée : celle sélectionnée (dans ce run), sinon celle choisie, sinon la première en erreur. */
function focusedRequest(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  requests: readonly HttpExchange[],
): { request: HttpExchange; fallback?: 'error' | 'first' } | undefined {
  if (ctx.selection?.kind === 'request') {
    const id = ctx.selection.id;
    const selected = requests.find((request) => request.id === id);
    if (selected) return { request: selected };
  }
  const chosen = ui.request ? requests.find((request) => request.id === ui.request) : undefined;
  if (chosen) return { request: chosen };
  const failing = requests.find(isFailing);
  if (failing) return { request: failing, fallback: 'error' };
  const first = requests[0];
  return first ? { request: first, fallback: 'first' } : undefined;
}

function actionLabel(run: ReproductionRun, step: number | undefined): string | undefined {
  if (step === undefined) return undefined;
  return run.actions.find((action) => action.index === step)?.description;
}

function stepLink(ctx: WorkspaceContext, run: ReproductionRun, step: number | undefined): string {
  const t = textOf(ctx.lang);
  if (step === undefined) return '—';
  const id = stepId(run.id, step);
  const description = actionLabel(run, step);
  const label = description ?? t.step(step);
  return `<button type="button" class="lnk ws-repro-steplink ${selectionClass(ctx, 'step', id)}" ${selectable(ctx, 'step', id)} aria-label="${esc(t.selectStep(`${t.step(step)}${description ? ` : ${description}` : ''}`))}" title="${esc(`${t.step(step)}${description ? ` : ${description}` : ''}`)}">${esc(label)}</button>`;
}

function headersTable(
  ctx: WorkspaceContext,
  title: string,
  headers: Record<string, string> | undefined,
): string {
  const t = textOf(ctx.lang);
  const entries = Object.entries(headers ?? {})
    .filter(([name]) => !isSensitiveHeader(name))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0)
    return `<section class="ws-repro-sec"><h4>${esc(title)}</h4><p class="mu ws-repro-small">${esc(t.noHeaders)}</p></section>`;
  return `<section class="ws-repro-sec"><h4>${esc(title)} <small class="mu">(${String(entries.length)})</small></h4><div class="tw"><table class="tbl ws-repro-tbl"><thead><tr><th scope="col">${esc(t.headerName)}</th><th scope="col">${esc(t.headerValue)}</th></tr></thead><tbody>${entries
    .map(
      ([name, value]) =>
        `<tr><td><code>${esc(name)}</code></td><td><code>${esc(maskText(value))}</code></td></tr>`,
    )
    .join('')}</tbody></table></div></section>`;
}

function bodyBlock(ctx: WorkspaceContext, title: string, body: string | undefined): string {
  const t = textOf(ctx.lang);
  if (body === undefined)
    return `<section class="ws-repro-sec"><h4>${esc(title)} <small class="mu">${esc(t.notCaptured)}</small></h4><p class="mu ws-repro-small">${esc(t.noBody)}</p></section>`;
  const pretty = prettyBody(body);
  return `<section class="ws-repro-sec"><h4>${esc(title)}${pretty.json ? ` <small class="mu">${esc(t.prettyJson)}</small>` : ''}</h4><pre class="ws-repro-pre" tabindex="0">${esc(pretty.text)}</pre>${pretty.truncated ? `<p class="mu ws-repro-small">${esc(t.truncated)}</p>` : ''}</section>`;
}

function requestDetails(ctx: WorkspaceContext, run: ReproductionRun, request: HttpExchange): string {
  const t = textOf(ctx.lang);
  const parts = partsText(ctx.lang);
  const f = t.facts;
  const row = (term: string, value: string): string => `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;
  const nodes = linkedNodes(ctx, request.id);
  const nodeList =
    nodes.length === 0
      ? `<p class="mu ws-repro-small">${esc(t.noGraphNodes)}</p>`
      : `<ul class="ws-repro-nodes">${nodes
          .map(
            (node) =>
              `<li><button type="button" class="lnk ${selectionClass(ctx, 'node', node.id)}" ${selectable(ctx, 'node', node.id)}>${esc(node.label)}</button> <small class="mu">${esc(parts.layers[node.layer])}</small></li>`,
          )
          .join('')}</ul>`;
  return `<dl class="ws-repro-dl ws-repro-facts">${row(f.method, `<code>${esc(request.method)}</code>`)}${row(f.path, `<code>${esc(request.path)}</code>`)}${row(f.status, statusPill(ctx.lang, request))}${row(f.duration, request.durationMs !== undefined ? esc(formatDuration(ctx.lang, request.durationMs)) : `<span class="mu">${esc(t.notCaptured)}</span>`)}${request.startedAt ? row(f.start, `<time datetime="${esc(request.startedAt)}">${esc(clock(ctx.lang, request.startedAt))}</time>`) : ''}${row(f.type, `<code>${esc(request.resourceType)}</code>`)}${row(f.step, stepLink(ctx, run, request.step))}${row(f.correlation, `${relationBadge(ctx.lang, request.correlation)} <small class="mu">${esc(t.correlationReasons[request.correlation] ?? '')}</small>`)}</dl>${request.failure !== undefined ? `<p class="err" role="alert"><b>${esc(f.failure)}</b> : ${esc(request.failure)}</p>` : ''}<section class="ws-repro-sec"><h4>${esc(t.graphNodes)}</h4>${nodeList}</section>`;
}

function curlBlock(ctx: WorkspaceContext, run: ReproductionRun, request: HttpExchange): string {
  const t = textOf(ctx.lang);
  const origin = baseOrigin(run.baseUrl);
  const truncated = request.requestBody !== undefined && prettyBody(request.requestBody).truncated;
  return `<section class="ws-repro-sec"><h4>${esc(t.curlTitle)}</h4><pre class="ws-repro-pre ws-repro-curl" tabindex="0" aria-label="${esc(t.curlTitle)}">${esc(curlOf(request, run.baseUrl))}</pre><p class="ws-repro-note" role="note">${esc(t.curlNote)}</p><p class="mu ws-repro-small">${esc(origin ? t.curlBase(origin) : t.curlNoBase)}</p>${truncated ? `<p class="mu ws-repro-small">${esc(t.curlTruncated)}</p>` : ''}</section>`;
}

function requestDetail(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  run: ReproductionRun,
  focused: { request: HttpExchange; fallback?: 'error' | 'first' },
): string {
  const t = textOf(ctx.lang);
  const { request, fallback } = focused;
  const tabs = REQUEST_TABS.map((key) => ({ key, label: t.detailTabs[key] }));
  const body =
    ui.requestTab === 'details'
      ? requestDetails(ctx, run, request)
      : ui.requestTab === 'headers'
        ? `${headersTable(ctx, t.requestHeaders, request.requestHeaders)}${headersTable(ctx, t.responseHeaders, request.responseHeaders)}`
        : ui.requestTab === 'payload'
          ? bodyBlock(ctx, t.requestBody, request.requestBody)
          : ui.requestTab === 'response'
            ? bodyBlock(ctx, t.responseBody, request.responseBody)
            : curlBlock(ctx, run, request);
  const index = sortedRequests(run).indexOf(request) + 1;
  return `<article class="ws-repro-detail" aria-label="${esc(t.detailOf(requestLabel(request)))}"><header class="ws-repro-detail-h"><h3><span class="mu">#${String(index)}</span> <code>${esc(request.method)}</code> <code class="ws-repro-msg">${esc(request.path)}</code> ${statusPill(ctx.lang, request)}</h3>${fallback ? `<p class="mu ws-repro-small">${esc(fallback === 'error' ? t.shownFirstError : t.shownFirst)}</p>` : ''}</header>${tabBar('req', 'ws-repro-req-tab', t.detailTabsLabel, tabs, ui.requestTab)}${tabPanel('req', ui.requestTab, body, 'ws-repro-req-panel')}</article>`;
}

function httpTab(ctx: WorkspaceContext, ui: ReproductionUi, run: ReproductionRun): string {
  const t = textOf(ctx.lang);
  const requests = sortedRequests(run);
  if (requests.length === 0) return panelState(ctx.lang, 'empty', t.noHttp);
  const shown = ui.errorsOnly ? requests.filter(isFailing) : requests;
  const toolbar = `<div class="ws-repro-bar"><label class="ws-repro-check"><input type="checkbox" data-action="ws-repro-ev-errors"${ui.errorsOnly ? ' checked' : ''}> ${esc(t.errorsOnly)}</label><span class="mu ws-repro-small">${esc(t.requestCount(shown.length, requests.length))}</span></div>`;
  const focused = focusedRequest(ctx, ui, shown.length > 0 ? shown : requests);
  const c = t.columns;
  const rows = shown
    .map((request) => {
      const index = requests.indexOf(request) + 1;
      const on = focused?.request === request;
      return `<tr class="ws-repro-tr${isFailing(request) ? ' ws-repro-tr-ko' : ''}${on ? ' ws-repro-tr-on' : ''} ${selectionClass(ctx, 'request', request.id)}"${on ? ' aria-current="true"' : ''}><td class="ws-repro-num">${String(index)}</td><td><code>${esc(request.method)}</code></td><td><button type="button" class="lnk ws-repro-path" ${selectable(ctx, 'request', request.id)} aria-label="${esc(t.openRequest(requestLabel(request)))}"><code>${esc(request.path)}</code></button></td><td>${statusPill(ctx.lang, request)}</td><td class="ws-repro-num">${request.durationMs !== undefined ? esc(formatDuration(ctx.lang, request.durationMs)) : '—'}</td><td>${stepLink(ctx, run, request.step)}</td></tr>`;
    })
    .join('');
  const table =
    shown.length === 0
      ? panelState(ctx.lang, 'empty', t.noErrorRequests)
      : `<div class="tw ws-repro-tw"><table class="tbl ws-repro-tbl ws-repro-http"><caption class="ws-repro-sr">${esc(t.httpCaption)}</caption><thead><tr><th scope="col" class="ws-repro-num">${esc(c.index)}</th><th scope="col">${esc(c.method)}</th><th scope="col">${esc(c.url)}</th><th scope="col">${esc(c.status)}</th><th scope="col" class="ws-repro-num">${esc(c.duration)}</th><th scope="col">${esc(c.action)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `${toolbar}${table}${focused ? requestDetail(ctx, ui, run, focused) : ''}`;
}

function consoleTab(ctx: WorkspaceContext, run: ReproductionRun): string {
  const t = textOf(ctx.lang);
  const items = consoleOf(run);
  if (items.length === 0) return panelState(ctx.lang, 'empty', t.noConsole);
  const c = t.consoleColumns;
  const rows = items
    .map((item) => {
      const severity = typeof item.data?.severity === 'string' ? item.data.severity : undefined;
      const stack = Array.isArray(item.data?.stack)
        ? (item.data.stack as unknown[]).filter((line): line is string => typeof line === 'string')
        : [];
      return `<tr class="ws-repro-tr ws-repro-tr-ko ${selectionClass(ctx, 'evidence', item.id)}"><td>${item.at ? `<time datetime="${esc(item.at)}">${esc(clock(ctx.lang, item.at))}</time>` : `<span class="mu">${esc(t.noTime)}</span>`}</td><td><span class="ws-repro-kind ws-repro-kind-${item.kind === 'JS_ERROR' ? 'js' : 'console'}">${esc(t.evidenceKinds[item.kind] ?? item.kind)}</span></td><td>${item.source.step !== undefined ? stepLink(ctx, run, item.source.step) : '—'}</td><td><button type="button" class="ws-repro-rowb" ${selectable(ctx, 'evidence', item.id)}><code class="ws-repro-msg">${esc(item.summary)}</code></button>${stack.length > 0 ? `<details class="ws-repro-stack"><summary>${esc(t.stack)}</summary><pre class="ws-repro-pre">${esc(stack.join('\n'))}</pre></details>` : ''}</td><td>${severity ? `<span class="pill mu">${esc(severity)}</span>` : '—'}</td></tr>`;
    })
    .join('');
  return `<div class="tw ws-repro-tw"><table class="tbl ws-repro-tbl"><caption class="ws-repro-sr">${esc(t.consoleCaption)}</caption><thead><tr><th scope="col">${esc(c.at)}</th><th scope="col">${esc(c.kind)}</th><th scope="col">${esc(c.step)}</th><th scope="col">${esc(c.message)}</th><th scope="col">${esc(c.severity)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function shotsTab(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  run: ReproductionRun,
  media: ReproductionMedia,
): string {
  const t = textOf(ctx.lang);
  const shots = shotsOf(run);
  if (shots.length === 0) return panelState(ctx.lang, 'empty', t.noShot);
  const current = previewShot(ctx, ui, run);
  const large = current
    ? `<figure class="ws-repro-large"><div class="ws-repro-stage">${shotImage(ctx, media, run, current.file, shotLabel(ctx.lang, current), 'ws-repro-img')}</div><figcaption class="mu ws-repro-small">${esc(shotLabel(ctx.lang, current))} · <code>${esc(current.file)}</code></figcaption></figure>`
    : '';
  return `${large}<ul class="ws-repro-strip" aria-label="${esc(t.shotsCaption)}">${shots
    .map((shot) => {
      const label = shotLabel(ctx.lang, shot);
      return `<li>${shotButton(ctx, shot, shot.file === current?.file, `<span class="ws-repro-thumb-i">${shotImage(ctx, media, run, shot.file, label, 'ws-repro-thumb-img')}</span><span class="ws-repro-small">${esc(label)}</span>`, 'ws-repro-thumb')}</li>`;
    })
    .join('')}</ul>`;
}

function actionsTab(ctx: WorkspaceContext, run: ReproductionRun): string {
  const t = textOf(ctx.lang);
  if (run.actions.length === 0) return panelState(ctx.lang, 'empty', t.noActions);
  const c = t.actionsColumns;
  const rows = [...run.actions]
    .sort((a, b) => a.index - b.index)
    .map((action) => {
      const tone = stepTone(action.status);
      const id = stepId(run.id, action.index);
      const played = playedDuration(action);
      return `<tr class="ws-repro-tr${tone === 'failed' ? ' ws-repro-tr-ko' : ''} ${selectionClass(ctx, 'step', id)}"><td class="ws-repro-num">${String(action.index)}</td><td><code>${esc(action.kind)}</code></td><td><button type="button" class="ws-repro-rowb" ${selectable(ctx, 'step', id)}>${esc(action.description)}</button></td><td><span class="ws-repro-ico ws-repro-ico-${tone}" aria-hidden="true">${icon(STEP_ICON[tone])}</span> ${esc(t.stepStatus[action.status] ?? action.status)}</td><td class="ws-repro-num">${played ? esc(formatDuration(ctx.lang, action.durationMs)) : `<span class="mu">${esc(t.notPlayed)}</span>`}</td><td class="ws-repro-num">${String(action.requestIds.length)}</td><td class="ws-repro-small">${action.reason ? esc(action.reason) : '—'}</td></tr>`;
    })
    .join('');
  const assertions = run.evidence.filter((item) => item.kind === 'ASSERTION');
  const unmet =
    assertions.length > 0
      ? `<section class="ws-repro-sec"><h4>${esc(t.assertions)}</h4><ul class="ws-repro-list">${assertions
          .map(
            (item) =>
              `<li class="${selectionClass(ctx, 'evidence', item.id)}"><button type="button" class="ws-repro-rowb" ${selectable(ctx, 'evidence', item.id)}><span class="ws-repro-msg">${esc(item.summary)}</span></button></li>`,
          )
          .join('')}</ul></section>`
      : '';
  return `<div class="tw ws-repro-tw"><table class="tbl ws-repro-tbl"><caption class="ws-repro-sr">${esc(t.actionsCaption)}</caption><thead><tr><th scope="col" class="ws-repro-num">${esc(c.index)}</th><th scope="col">${esc(c.kind)}</th><th scope="col">${esc(c.description)}</th><th scope="col">${esc(c.status)}</th><th scope="col" class="ws-repro-num">${esc(c.duration)}</th><th scope="col" class="ws-repro-num">${esc(c.requests)}</th><th scope="col">${esc(c.reason)}</th></tr></thead><tbody>${rows}</tbody></table></div>${unmet}`;
}

/** Les nombres des onglets de l'écran « Preuves » (données de la reproduction, rien d'estimé). */
export function evidenceCounts(run: ReproductionRun): Record<EvidenceTab, number> {
  return {
    http: run.requests.length,
    console: consoleOf(run).length,
    shots: run.screenshots.length,
    traces: run.trace ? 1 : 0,
    actions: run.actions.length,
  };
}

/**
 * L'ÉCRAN « PREUVES COLLECTÉES » : les preuves de la reproduction (référence par défaut) par nature ;
 * requêtes HTTP en tableau (lignes en erreur marquées), détail de la requête en sous-onglets avec la
 * commande cURL reconstruite. `media.shot` donne les captures lues.
 */
export function renderEvidence(
  ctx: WorkspaceContext,
  ui: ReproductionUi,
  media: ReproductionMedia = {},
): string {
  const t = textOf(ctx.lang);
  const run = evidenceReproduction(ctx, ui);
  const head = `<header class="ws-repro-head"><div><h2 class="ws-repro-title">${esc(t.evidenceTitle)}</h2><p class="mu ws-repro-small">${esc(t.evidenceSub)}${run ? ` · <code>${esc(run.id)}</code>` : ''}</p></div>${picker(ctx, ui, t.pickReference)}</header>`;
  if (!run)
    return `<section class="ws-repro ws-repro-ev" aria-label="${esc(t.evidenceTitle)}">${head}${panelState(ctx.lang, 'empty', t.noEvidenceRun)}</section>`;
  if (run.status === 'RUNNING')
    return `<section class="ws-repro ws-repro-ev" aria-label="${esc(t.evidenceTitle)}">${head}${panelState(ctx.lang, 'empty', t.evidenceRunning)}</section>`;
  const counts = evidenceCounts(run);
  const tabs = EVIDENCE_TABS.map((key) => ({ key, label: t.evidenceTabs[key], count: counts[key] }));
  const body =
    ui.evidenceTab === 'http'
      ? httpTab(ctx, ui, run)
      : ui.evidenceTab === 'console'
        ? consoleTab(ctx, run)
        : ui.evidenceTab === 'shots'
          ? shotsTab(ctx, ui, run, media)
          : ui.evidenceTab === 'traces'
            ? traceBlock(ctx, run)
            : actionsTab(ctx, run);
  return `<section class="ws-repro ws-repro-ev" aria-label="${esc(t.evidenceTitle)}" data-reproduction="${esc(run.id)}">${head}${tabBar('ev', 'ws-repro-ev-tab', t.evidenceTabsLabel, tabs, ui.evidenceTab)}${tabPanel('ev', ui.evidenceTab, body, `ws-repro-ev-${ui.evidenceTab}`)}</section>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

export const INCIDENT_REPRODUCTION_CSS = `
.ws-repro{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;height:100%}
.ws-repro>*{flex:none}
.ws-repro-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ws-repro-small{font-size:12px}
.ws-repro-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.ws-repro-title{margin:0;font-size:16px;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;min-width:0;overflow-wrap:anywhere}
.ws-repro-head>div{min-width:0}
.ws-repro-head p{margin:2px 0 0}
.ws-repro-state{display:inline-flex;align-items:center;gap:6px}
.ws-repro-pulse{width:8px;height:8px;border-radius:50%;background:currentColor;animation:ws-repro-pulse 1.2s ease-in-out infinite}
@keyframes ws-repro-pulse{50%{opacity:.25}}
.ws-repro-timer{display:inline-flex;align-items:center;gap:6px;font:600 13px var(--qa-font-family-mono);font-variant-numeric:tabular-nums;margin-left:auto}
.ws-repro-timer .ico{width:16px;height:16px}
.ws-repro-acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ws-repro-acts .btn .ico{width:16px;height:16px}
.ws-repro-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 10px;border:1px solid color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border));border-radius:10px;background:color-mix(in srgb,var(--qa-color-danger) 6%,var(--qa-color-surface));max-width:560px}
.ws-repro-confirm p{margin:0;flex:1 1 260px}
.ws-repro-confirm-b{display:inline-flex;gap:6px}
.ws-repro-pick{display:inline-flex;flex-direction:column;gap:2px;min-width:0}
.ws-repro-pick select{min-height:32px;max-width:340px;border:1px solid var(--qa-color-border-strong);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);padding:0 8px;font:inherit;font-size:13px}
.ws-repro-note{margin:0;padding:6px 10px;border-left:3px solid var(--qa-color-warning);background:color-mix(in srgb,var(--qa-color-warning) 8%,transparent);border-radius:6px;font-size:13px;display:flex;gap:6px;align-items:center}
.ws-repro-note.err{border-left-color:var(--qa-color-danger);background:color-mix(in srgb,var(--qa-color-danger) 8%,transparent)}
.ws-repro-match{margin:0}
.ws-repro-grid{flex:1 1 auto;min-height:220px;display:grid;grid-template-columns:minmax(260px,2fr) minmax(300px,3fr);gap:12px}
.ws-repro-grid>*{min-width:0;min-height:0}
.ws-repro-h{margin:0 0 6px;font-size:14px;font-weight:600;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.ws-repro-steps-box{display:flex;flex-direction:column;gap:6px;overflow:auto;padding:10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.ws-repro-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ws-repro-step{border-radius:8px;border:1px solid transparent}
.ws-repro-step.ws-repro-st-failed{border-color:color-mix(in srgb,var(--qa-color-danger) 40%,transparent);background:color-mix(in srgb,var(--qa-color-danger) 7%,var(--qa-color-surface))}
.ws-repro-stepb{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:4px 8px;border:0;background:none;color:var(--qa-color-text);font:inherit;text-align:left;cursor:pointer;border-radius:8px}
div.ws-repro-stepb{cursor:default}
button.ws-repro-stepb:hover{background:color-mix(in srgb,var(--qa-color-primary) 6%,transparent)}
.ws-repro-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--qa-color-border-strong);color:var(--qa-color-muted)}
.ws-repro-ico .ico{width:13px;height:13px}
.ws-repro-ico-done{border-color:var(--qa-color-success);background:var(--qa-color-success);color:var(--qa-color-surface)}
.ws-repro-ico-failed{border-color:var(--qa-color-danger);background:var(--qa-color-danger);color:var(--qa-color-surface)}
.ws-repro-ico-running{border-color:var(--qa-color-primary);color:color-mix(in srgb,var(--qa-color-primary) 75%,var(--qa-color-text))}
.ws-repro-idx{flex:none;min-width:2ch;font:600 12px var(--qa-font-family-mono);color:var(--qa-color-muted);text-align:right}
.ws-repro-desc{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.ws-repro-prog{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font:600 12px var(--qa-font-family-mono);font-variant-numeric:tabular-nums}
.ws-repro-prog progress{width:90px;height:6px;accent-color:var(--qa-color-primary)}
.ws-repro-now{font-weight:600;color:color-mix(in srgb,var(--qa-color-primary) 75%,var(--qa-color-text))}
.ws-repro-step.ws-repro-st-running{border-color:color-mix(in srgb,var(--qa-color-primary) 40%,transparent);background:color-mix(in srgb,var(--qa-color-primary) 7%,var(--qa-color-surface))}
.ws-repro-upcoming{margin:2px 0 0;padding-left:8px}
.ws-repro-dur{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--qa-color-text) 80%,var(--qa-color-muted));white-space:nowrap}
.ws-repro-st-failed .ws-repro-dur{color:color-mix(in srgb,var(--qa-color-danger) 72%,var(--qa-color-text))}
.ws-repro-why{margin:0 8px 6px 64px;font-size:12px;color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text));overflow-wrap:anywhere}
.ws-repro-preview{margin:0;display:flex;flex-direction:column;min-height:0;padding:10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.ws-repro-stage{position:relative;flex:1 1 auto;min-height:160px;display:flex;align-items:flex-start;justify-content:center;overflow:auto;border-radius:8px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border)}
.ws-repro-img{display:block;max-width:100%;height:auto}
.ws-repro-shot-st{margin:auto;padding:16px;font-size:13px;text-align:center;display:flex;gap:6px;align-items:center}
.ws-repro-toast{position:absolute;top:10px;right:10px;max-width:min(340px,calc(100% - 20px));display:flex;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--qa-color-danger) 55%,var(--qa-color-border));background:var(--qa-color-surface);box-shadow:0 6px 18px color-mix(in srgb,var(--qa-color-text) 18%,transparent);font-size:13px}
.ws-repro-toast>.ico{flex:none;width:18px;height:18px;color:var(--qa-color-danger)}
.ws-repro-toast b{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.ws-repro-toast p{margin:2px 0 0;overflow-wrap:anywhere}
.ws-repro-toast-req{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.ws-repro-bottom{display:flex;flex-direction:column;min-height:0;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);max-height:42%}
.ws-repro-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:0 6px;border-bottom:1px solid var(--qa-color-border)}
.ws-repro-tab{min-height:36px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:none;color:var(--qa-color-muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.ws-repro-tab:hover{color:var(--qa-color-text)}
.ws-repro-tab[aria-selected="true"]{color:color-mix(in srgb,var(--qa-color-primary) 75%,var(--qa-color-text));border-bottom-color:var(--qa-color-primary)}
.ws-repro-count{font-weight:500}
.ws-repro-panel{padding:8px 10px;min-height:0;overflow:auto}
.ws-repro-bottom>.ws-repro-panel{flex:1 1 auto}
.ws-repro-strip{list-style:none;margin:0;padding:2px;display:flex;gap:8px;overflow-x:auto}
.ws-repro-thumb{display:flex;flex-direction:column;gap:4px;align-items:flex-start;width:150px;padding:4px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;cursor:pointer;text-align:left}
.ws-repro-thumb.ws-repro-on{border-color:var(--qa-color-primary);box-shadow:0 0 0 1px var(--qa-color-primary)}
.ws-repro-thumb-i{display:flex;align-items:center;justify-content:center;width:140px;height:84px;overflow:hidden;border-radius:6px;background:var(--qa-color-surface-2)}
.ws-repro-thumb-img{width:100%;height:100%;object-fit:cover;object-position:top}
.ws-repro-thumb-i .ws-repro-shot-st{padding:4px;font-size:11px}
.ws-repro-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ws-repro-list li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;border-radius:6px}
.ws-repro-list li.ws-repro-ko{box-shadow:inset 3px 0 0 var(--qa-color-danger)}
.ws-repro-rowb{flex:1 1 280px;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-height:32px;padding:2px 8px;border:0;background:none;color:var(--qa-color-text);font:inherit;text-align:left;cursor:pointer;border-radius:6px}
.ws-repro-rowb:hover{background:color-mix(in srgb,var(--qa-color-primary) 6%,transparent)}
.ws-repro-msg{min-width:0;overflow-wrap:anywhere;font-size:12px}
.ws-repro-meth{font-weight:700;min-width:5ch}
.ws-repro-kind{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:6px;background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.ws-repro-kind-js{background:color-mix(in srgb,var(--qa-color-danger) 12%,transparent);color:color-mix(in srgb,var(--qa-color-danger) 72%,var(--qa-color-text))}
.ws-repro-trace{display:flex;flex-direction:column;gap:6px}
.ws-repro-trace p{margin:0}
.ws-repro-dl{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 14px;margin:0}
.ws-repro-dl div{min-width:0}
.ws-repro-dl dt{font-size:12px;color:var(--qa-color-muted)}
.ws-repro-dl dd{margin:0;overflow-wrap:anywhere}
.ws-repro-facts{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.ws-repro-cmd{user-select:all}
.ws-repro-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-bottom:6px}
.ws-repro-check{display:inline-flex;align-items:center;gap:6px;min-height:32px;cursor:pointer;font-size:13px}
.ws-repro-tw{max-height:min(320px,45vh);overflow:auto}
.ws-repro-tbl{font-size:13px;min-width:560px}
.ws-repro-tbl td{padding:3px 8px;vertical-align:top}
.ws-repro-tbl thead th{position:sticky;top:0;z-index:1;padding:6px 8px;background:var(--qa-color-surface);box-shadow:inset 0 -1px 0 var(--qa-color-border)}
.ws-repro-num{white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right}
.ws-repro-tr-ko td:first-child{box-shadow:inset 3px 0 0 var(--qa-color-danger)}
.ws-repro-http .ws-repro-tr-ko{background:color-mix(in srgb,var(--qa-color-danger) 7%,transparent)}
.ws-repro-tr-on{background:color-mix(in srgb,var(--qa-color-primary) 8%,transparent)}
.ws-repro-http .ws-repro-tr-ko.ws-repro-tr-on{background:color-mix(in srgb,var(--qa-color-danger) 12%,transparent)}
.ws-repro-path{min-height:28px;padding:2px 0;overflow-wrap:anywhere;text-align:left}
.ws-repro-steplink{text-align:left;overflow-wrap:anywhere}
.ws-repro-detail{display:flex;flex-direction:column;gap:6px;margin-top:10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.ws-repro-detail-h{padding:8px 10px 0}
.ws-repro-detail-h h3{margin:0;font-size:14px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;overflow-wrap:anywhere}
.ws-repro-detail-h p{margin:2px 0 0}
.ws-repro-sec{margin:0 0 8px}
.ws-repro-sec h4{margin:0 0 4px;font-size:13px;color:var(--qa-color-muted)}
.ws-repro-pre{margin:0;padding:10px;max-height:320px;overflow:auto;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2);color:var(--qa-color-text);font:12px/1.5 var(--qa-font-family-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.ws-repro-curl{white-space:pre;overflow-wrap:normal}
.ws-repro-nodes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ws-repro-stack summary{cursor:pointer;font-size:12px;min-height:28px;display:flex;align-items:center}
.ws-repro-large{margin:0 0 8px;display:flex;flex-direction:column;gap:4px}
.ws-repro-large .ws-repro-stage{max-height:420px}
.ws-repro-ev>.ws-repro-panel{flex:1 1 auto;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface)}
.ws-repro-ev>.ws-repro-tabs{border-bottom:0}
.ws-repro-tab:focus-visible,.ws-repro-stepb:focus-visible,.ws-repro-rowb:focus-visible,.ws-repro-thumb:focus-visible,.ws-repro-panel:focus-visible,.ws-repro-pre:focus-visible,.ws-repro .lnk:focus-visible,.ws-repro-pick select:focus-visible,.ws-repro-check input:focus-visible,.ws-repro-stack summary:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.ws-repro-pulse{animation:none}}
@media (max-width:900px){.ws-repro-grid{grid-template-columns:minmax(0,1fr)}.ws-repro-bottom{max-height:none}.ws-repro-toast{position:static;max-width:none;margin:8px}.ws-repro-stage{flex-direction:column;align-items:stretch}.ws-repro-timer{margin-left:0}}
@media (max-width:600px){.ws-repro-why{margin-left:8px}.ws-repro-thumb{width:120px}.ws-repro-thumb-i{width:110px;height:66px}}
`;
