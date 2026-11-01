import type { Experiment, Hypothesis, Incident } from '../core/incident-contracts.js';
import {
  TRIGGER_DEPTHS,
  type IncidentBrief,
  type SourcedText,
  type TriggerDepth,
  type TriggerRun,
  type TriggerRunReport,
  type TriggerTrial,
} from '../core/incident-trigger-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import { selectable, selectionClass, type Lang, type WorkspaceContext } from './incident-parts.js';
import { esc } from './view.js';

/**
 * L'ONGLET « DÉCLENCHEURS » DE L'ESPACE D'INVESTIGATION : la description interprétée (chaque élément avec sa
 * provenance), le périmètre découvert (statuts), l'explorateur (stratégies, couverture, conditions), l'exécution
 * en direct, la chronologie d'un essai, la matrice des essais, la reproduction minimale (première défaillance,
 * perte de données), le code Angular analysé, les causes (hypothèses PROPOSED, vérifications à trancher) et le
 * test proposé. Rien n'y est présenté comme confirmé par le moteur seul ; les décisions restent aux personnes.
 */
export const TRIGGER_SECTIONS = [
  'brief',
  'discovery',
  'explorer',
  'live',
  'events',
  'matrix',
  'minimal',
  'angular',
  'causes',
  'proposal',
] as const;
export type TriggerSection = (typeof TRIGGER_SECTIONS)[number];

export const TRIGGER_OPERATIONS = [
  'ws-trg-describe',
  'ws-trg-start',
  'ws-trg-pause',
  'ws-trg-resume',
  'ws-trg-cancel-yes',
  'ws-trg-approve',
  'ws-trg-refuse',
  'ws-trg-extend',
  'ws-trg-report-load',
] as const;

export const TRIGGER_BUDGET_KEYS = [
  'maxTrials',
  'maxDurationMs',
  'maxActions',
  'maxRepeats',
  'maxExperiments',
] as const;
export type TriggerBudgetKey = (typeof TRIGGER_BUDGET_KEYS)[number];

export type TriggerLoadState = 'loading' | 'denied' | { error: string };

export interface TriggerUi {
  depth: TriggerDepth;
  /** Le brouillon de la description (vide : celle de l'incident). */
  description: string;
  /** Le run affiché (id) ; absent : le dernier. */
  runId?: string;
  /** L'essai dont la chronologie est affichée. */
  trialId?: string;
  extendKey: TriggerBudgetKey;
  extendValue: string;
  confirmCancel: boolean;
  /** Les erreurs à afficher, par emplacement : `describe`, `start`, `control`, `decide:<id>`, `extend`, `report`. */
  errors: Record<string, string>;
  busy?: string;
  report?: TriggerRunReport;
  reportRunId?: string;
  reportState?: TriggerLoadState;
}

export function emptyTriggerUi(): TriggerUi {
  return {
    depth: 'STANDARD',
    description: '',
    extendKey: 'maxTrials',
    extendValue: '20',
    confirmCancel: false,
    errors: {},
  };
}

export const triggerBusyKey = (action: string, ref?: string): string => (ref ? `${action}:${ref}` : action);

const isDepth = (value: string | undefined): value is TriggerDepth =>
  (TRIGGER_DEPTHS as readonly string[]).includes(value ?? '');
const isBudgetKey = (value: string | undefined): value is TriggerBudgetKey =>
  (TRIGGER_BUDGET_KEYS as readonly string[]).includes(value ?? '');

export function reduceTrigger(
  ui: TriggerUi,
  action: string,
  dataset: Record<string, string | undefined>,
): TriggerUi | undefined {
  switch (action) {
    case 'ws-trg-depth':
      return isDepth(dataset.depth) ? { ...ui, depth: dataset.depth } : undefined;
    case 'ws-trg-run':
      return dataset.run ? { ...ui, runId: dataset.run, trialId: undefined } : undefined;
    case 'ws-trg-trial':
      return dataset.trial ? { ...ui, trialId: dataset.trial } : undefined;
    case 'ws-trg-cancel':
      return { ...ui, confirmCancel: true };
    case 'ws-trg-cancel-no':
      return { ...ui, confirmCancel: false };
    case 'ws-trg-dismiss': {
      const slot = dataset.slot;
      if (!slot) return undefined;
      const { [slot]: _dropped, ...errors } = ui.errors;
      return { ...ui, errors };
    }
    case 'ws-trg-field': {
      const value = dataset.value ?? '';
      switch (dataset.field) {
        case 'trg.description':
          return { ...ui, description: value.slice(0, 20_000) };
        case 'trg.extendKey':
          return isBudgetKey(value) ? { ...ui, extendKey: value } : undefined;
        case 'trg.extendValue':
          return { ...ui, extendValue: value.replace(/[^0-9]/g, '').slice(0, 7) };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

// ── Lectures ─────────────────────────────────────────────────────────────────────────────────

export const ACTIVE_TRIGGER_STATES: readonly TriggerRun['state'][] = [
  'INITIALIZING',
  'DISCOVERING_SCOPE',
  'EXPLORING_TRIGGERS',
  'FAILURE_DETECTED',
  'CONFIRMING_REPRODUCTION',
  'MINIMIZING',
  'ANALYZING_ROOT_CAUSE',
  'VERIFYING_HYPOTHESES',
  'PAUSED',
];

export function triggerRuns(incident: Pick<Incident, 'investigation'>): TriggerRun[] {
  return incident.investigation.trigger?.runs ?? [];
}

export const triggerActive = (incident: Pick<Incident, 'investigation'>): boolean =>
  triggerRuns(incident).some((run) => ACTIVE_TRIGGER_STATES.includes(run.state));

export function shownTriggerRun(
  incident: Pick<Incident, 'investigation'>,
  ui: Pick<TriggerUi, 'runId'>,
): TriggerRun | undefined {
  const runs = triggerRuns(incident);
  return (ui.runId ? runs.find((run) => run.id === ui.runId) : undefined) ?? runs.at(-1);
}

/** Les descriptions courtes des facteurs d'un essai (la matrice) ; « référence » quand il n'en a aucun. */
export const trialFactors = (trial: Pick<TriggerTrial, 'factors'>): string =>
  Object.values(trial.factors).join(' → ');

export const triggerExperiments = (
  incident: Pick<Incident, 'investigation'>,
  run: Pick<TriggerRun, 'id'>,
): Experiment[] =>
  incident.investigation.experiments.filter((experiment) => experiment.id.startsWith(`exp_trig_${run.id}_`));

export const triggerHypotheses = (
  incident: Pick<Incident, 'investigation'>,
  run: Pick<TriggerRun, 'hypothesisIds'>,
): Hypothesis[] =>
  incident.investigation.hypotheses.filter((hypothesis) => run.hypothesisIds.includes(hypothesis.id));

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    title: 'Découverte des déclencheurs',
    sub: 'Le moteur explore un environnement de test pour trouver les conditions qui déclenchent la perte de réaction. Les preuves restent la source de vérité : aucune cause n’est confirmée par le moteur seul.',
    describe: 'Interpréter la description',
    descriptionLabel: 'Description en langage naturel (français ou anglais)',
    descriptionHint:
      'Ce que vous savez : zone fonctionnelle, action, symptôme, ce qui remet en état, ce qui est perdu. Les conditions inconnues peuvent le rester.',
    depth: 'Profondeur',
    depths: { QUICK: 'QUICK', STANDARD: 'STANDARD', DEEP: 'DEEP' } as Record<TriggerDepth, string>,
    depthHints: {
      QUICK: 'Référence + un facteur à la fois (quelques minutes).',
      STANDARD: 'Limites, paires, guidage par le code et par les erreurs.',
      DEEP: 'Séquences avec état, variations de temps, propositions IA (si configurée), différentiel.',
    } as Record<TriggerDepth, string>,
    start: 'Lancer la découverte',
    resume: 'Reprendre',
    pause: 'Pause',
    cancel: 'Annuler',
    cancelConfirm: 'Annuler la découverte ? Les essais déjà joués et le rapport partiel sont conservés.',
    cancelYes: 'Annuler maintenant',
    cancelNo: 'Non',
    busy: 'En cours…',
    needsRun: 'Droit RUN requis.',
    decideRight: 'Droit DECIDE requis.',
    dismiss: 'Fermer le message',
    runs: 'Runs',
    state: 'État',
    states: {
      INITIALIZING: 'Initialisation',
      DISCOVERING_SCOPE: 'Découverte du périmètre',
      EXPLORING_TRIGGERS: 'Exploration des déclencheurs',
      FAILURE_DETECTED: 'Défaillance détectée',
      CONFIRMING_REPRODUCTION: 'Confirmation (rejouages)',
      MINIMIZING: 'Minimisation',
      ANALYZING_ROOT_CAUSE: 'Analyse de la cause',
      VERIFYING_HYPOTHESES: 'Vérification des hypothèses',
      WAITING_FOR_APPROVAL: 'En attente d’approbation',
      PAUSED: 'En pause',
      COMPLETED: 'Terminé',
      INCONCLUSIVE: 'Non concluant',
      CANCELLED: 'Annulé',
      FAILED: 'En échec',
    } as Record<TriggerRun['state'], string>,
    usage: 'Consommation',
    trials: 'Essais',
    actions: 'Actions',
    repeats: 'Rejouages',
    experiments: 'Vérifications',
    events: 'Événements',
    duration: 'Durée',
    aiCalls: 'Appels IA',
    stop: 'Arrêt',
    limitations: 'Limites',
    extend: 'Prolonger le budget',
    extendKeys: {
      maxTrials: 'essais',
      maxDurationMs: 'millisecondes',
      maxActions: 'actions',
      maxRepeats: 'rejouages',
      maxExperiments: 'vérifications',
    } as Record<TriggerBudgetKey, string>,
    extendBy: 'Ajouter',
    reportLoad: 'Lire le rapport du run',
    reportLoading: 'Rapport en cours de lecture…',
    reportError: (message: string) => `Rapport non lu : ${message}`,
    sections: {
      brief: 'Incident',
      discovery: 'Périmètre découvert',
      explorer: 'Explorateur',
      live: 'Exécution',
      events: 'Chronologie',
      matrix: 'Matrice',
      minimal: 'Reproduction minimale',
      angular: 'Code Angular',
      causes: 'Causes',
      proposal: 'Test proposé',
    } as Record<TriggerSection, string>,
    sources: {
      USER_REPORTED: 'déclaré',
      AI_INFERRED: 'inféré (IA)',
      STATICALLY_RESOLVED: 'code',
      RUNTIME_OBSERVED: 'observé',
      EXPERIMENT_VERIFIED: 'vérifié',
    } as Record<SourcedText['source'], string>,
    briefNone: 'Aucune description interprétée : saisissez-la ci-dessus puis « Interpréter ».',
    briefFields: {
      application: 'Application',
      functionalArea: 'Zone fonctionnelle',
      businessAction: 'Action métier',
      expected: 'Attendu',
      observed: 'Observé',
      businessImpact: 'Impact',
      dataLoss: 'Perte de données',
    },
    symptoms: 'Symptômes',
    known: 'Conditions connues',
    unknown: 'Conditions inconnues',
    environment: 'Environnement',
    suspected: 'Défaillances suggérées par la description (hypothèses de lecture, pas des preuves)',
    scopeNone: 'Le périmètre sera découvert au lancement.',
    scopeCols: ['Type', 'Ressource', 'Statut', 'Trouvée par', 'Pertinence', 'Détail'],
    scopeNote:
      'Découvrir une ressource n’accorde aucun droit : AUTHORIZED et DENIED viennent du Scope Policy Engine.',
    strategies: 'Stratégies',
    strategyCols: ['Stratégie', 'Essais', 'Reproductions'],
    coverage: 'Couverture par dimension',
    coverageCols: ['Dimension', 'Explorés', 'Connus'],
    conditions: 'Conditions',
    conditionCols: ['Rôle', 'Condition', 'Avec', 'Sans', 'Source'],
    roles: {
      NECESSARY: 'nécessaire',
      CONTRIBUTING: 'contributive',
      CANDIDATE: 'candidate',
      REFUTED: 'réfutée',
    } as Record<string, string>,
    noRun: 'Aucun run : lancez la découverte depuis l’onglet « Incident ».',
    lastTrials: 'Derniers essais',
    matrixCols: ['Essai', 'Stratégie', 'Facteurs', 'Verdict', 'Défaillances', 'Rejouages'],
    reference: 'référence',
    verdicts: {
      FAILURE_REPRODUCED: 'reproduit',
      FAILURE_NOT_REPRODUCED: 'non reproduit',
      INCONCLUSIVE: 'non concluant',
      ENVIRONMENT_FAILURE: 'environnement',
      TEST_INFRASTRUCTURE_FAILURE: 'infrastructure de test',
    } as Record<string, string>,
    eventsNone: 'Choisissez un essai dans la matrice pour lire sa chronologie.',
    eventCols: ['t (ms)', 'Type', 'Résumé'],
    minimalNone:
      'Aucune séquence minimale : rien n’a été reproduit (ou la réduction n’a pas encore eu lieu).',
    preconditions: 'Préconditions',
    sequence: 'Séquence',
    probe: 'sonde',
    frequency: 'Fréquence',
    firstFailure: 'Première défaillance',
    dataLoss: 'Perte de données',
    unsaved: 'Champs modifiés non enregistrés',
    persistence: 'Dans le code',
    lossFactors: 'Facteurs de perte',
    angularNone: 'Aucun code Angular analysé (sources non lues ou application sans frontend déclaré).',
    features: 'Caractéristiques détectées',
    nodes: 'Éléments du modèle',
    nodeCols: ['Type', 'Nom', 'Fichier'],
    files: (count: number, denied: number) =>
      `${String(count)} fichier(s) lu(s), ${String(denied)} refusé(s)`,
    hypotheses: 'Hypothèses proposées par le run',
    hypothesesNone: 'Aucune hypothèse : le moteur n’en propose qu’après une reproduction.',
    experimentsTitle: 'Vérifications',
    approve: 'Approuver',
    refuse: 'Refuser',
    sideEffects: 'effets de bord : droit RUN_WRITES',
    causesNote:
      'Les hypothèses restent PROPOSED tant que la règle déterministe de confirmation (deux vérifications de nature différente) n’est pas satisfaite ; un rejouage qui ne distingue pas les hypothèses concurrentes est marqué NEUTRAL.',
    proposalNone: 'Aucun test proposé par la découverte (il faut une séquence reproduite).',
    proposalNote:
      'Proposé, jamais « validé » sans exécution : l’exécution se fait depuis Rapport › Non-régression.',
    expected: 'Attendu',
    report: 'Rapport du run',
    confidence: 'confiance',
  },
  en: {
    title: 'Trigger discovery',
    sub: 'The engine explores a test environment to find the conditions that trigger the loss of reaction. Evidence stays the source of truth: no cause is confirmed by the engine alone.',
    describe: 'Interpret the description',
    descriptionLabel: 'Natural-language description (French or English)',
    descriptionHint:
      'What you know: functional area, action, symptom, what restores, what is lost. Unknown conditions may stay unknown.',
    depth: 'Depth',
    depths: { QUICK: 'QUICK', STANDARD: 'STANDARD', DEEP: 'DEEP' } as Record<TriggerDepth, string>,
    depthHints: {
      QUICK: 'Reference + one factor at a time (a few minutes).',
      STANDARD: 'Boundaries, pairs, code-guided and error-guided.',
      DEEP: 'Stateful sequences, timing variations, AI proposals (when configured), differential.',
    } as Record<TriggerDepth, string>,
    start: 'Start discovery',
    resume: 'Resume',
    pause: 'Pause',
    cancel: 'Cancel',
    cancelConfirm: 'Cancel the discovery? Played trials and the partial report are kept.',
    cancelYes: 'Yes, cancel',
    cancelNo: 'No',
    busy: 'Working…',
    needsRun: 'RUN right required.',
    decideRight: 'DECIDE right required.',
    dismiss: 'Dismiss the message',
    runs: 'Runs',
    state: 'State',
    states: {
      INITIALIZING: 'Initializing',
      DISCOVERING_SCOPE: 'Discovering scope',
      EXPLORING_TRIGGERS: 'Exploring triggers',
      FAILURE_DETECTED: 'Failure detected',
      CONFIRMING_REPRODUCTION: 'Confirming (repeats)',
      MINIMIZING: 'Minimizing',
      ANALYZING_ROOT_CAUSE: 'Analyzing root cause',
      VERIFYING_HYPOTHESES: 'Verifying hypotheses',
      WAITING_FOR_APPROVAL: 'Waiting for approval',
      PAUSED: 'Paused',
      COMPLETED: 'Completed',
      INCONCLUSIVE: 'Inconclusive',
      CANCELLED: 'Cancelled',
      FAILED: 'Failed',
    } as Record<TriggerRun['state'], string>,
    usage: 'Usage',
    trials: 'Trials',
    actions: 'Actions',
    repeats: 'Repeats',
    experiments: 'Experiments',
    events: 'Events',
    duration: 'Duration',
    aiCalls: 'AI calls',
    stop: 'Stop',
    limitations: 'Limitations',
    extend: 'Extend the budget',
    extendKeys: {
      maxTrials: 'trials',
      maxDurationMs: 'milliseconds',
      maxActions: 'actions',
      maxRepeats: 'repeats',
      maxExperiments: 'experiments',
    } as Record<TriggerBudgetKey, string>,
    extendBy: 'Add',
    reportLoad: 'Read the run report',
    reportLoading: 'Reading the report…',
    reportError: (message: string) => `Report not read: ${message}`,
    sections: {
      brief: 'Incident',
      discovery: 'Discovered scope',
      explorer: 'Explorer',
      live: 'Execution',
      events: 'Timeline',
      matrix: 'Matrix',
      minimal: 'Minimal reproduction',
      angular: 'Angular code',
      causes: 'Causes',
      proposal: 'Proposed test',
    } as Record<TriggerSection, string>,
    sources: {
      USER_REPORTED: 'reported',
      AI_INFERRED: 'inferred (AI)',
      STATICALLY_RESOLVED: 'code',
      RUNTIME_OBSERVED: 'observed',
      EXPERIMENT_VERIFIED: 'verified',
    } as Record<SourcedText['source'], string>,
    briefNone: 'No interpreted description: type it above, then “Interpret”.',
    briefFields: {
      application: 'Application',
      functionalArea: 'Functional area',
      businessAction: 'Business action',
      expected: 'Expected',
      observed: 'Observed',
      businessImpact: 'Impact',
      dataLoss: 'Data loss',
    },
    symptoms: 'Symptoms',
    known: 'Known conditions',
    unknown: 'Unknown conditions',
    environment: 'Environment',
    suspected: 'Failure kinds suggested by the description (reading hypotheses, not evidence)',
    scopeNone: 'The scope is discovered when the run starts.',
    scopeCols: ['Kind', 'Resource', 'Status', 'Found by', 'Relevance', 'Detail'],
    scopeNote:
      'Discovering a resource grants no right: AUTHORIZED and DENIED come from the Scope Policy Engine.',
    strategies: 'Strategies',
    strategyCols: ['Strategy', 'Trials', 'Reproductions'],
    coverage: 'Coverage per dimension',
    coverageCols: ['Dimension', 'Explored', 'Known'],
    conditions: 'Conditions',
    conditionCols: ['Role', 'Condition', 'With', 'Without', 'Source'],
    roles: {
      NECESSARY: 'necessary',
      CONTRIBUTING: 'contributing',
      CANDIDATE: 'candidate',
      REFUTED: 'refuted',
    } as Record<string, string>,
    noRun: 'No run: start the discovery from the “Incident” tab.',
    lastTrials: 'Last trials',
    matrixCols: ['Trial', 'Strategy', 'Factors', 'Verdict', 'Failures', 'Repeats'],
    reference: 'reference',
    verdicts: {
      FAILURE_REPRODUCED: 'reproduced',
      FAILURE_NOT_REPRODUCED: 'not reproduced',
      INCONCLUSIVE: 'inconclusive',
      ENVIRONMENT_FAILURE: 'environment',
      TEST_INFRASTRUCTURE_FAILURE: 'test infrastructure',
    } as Record<string, string>,
    eventsNone: 'Pick a trial in the matrix to read its timeline.',
    eventCols: ['t (ms)', 'Kind', 'Summary'],
    minimalNone: 'No minimal sequence: nothing was reproduced (or the reduction has not happened yet).',
    preconditions: 'Preconditions',
    sequence: 'Sequence',
    probe: 'probe',
    frequency: 'Frequency',
    firstFailure: 'First failure',
    dataLoss: 'Data loss',
    unsaved: 'Modified fields not saved',
    persistence: 'In the code',
    lossFactors: 'Loss factors',
    angularNone: 'No Angular code analyzed (sources not read or no frontend application declared).',
    features: 'Detected features',
    nodes: 'Model elements',
    nodeCols: ['Kind', 'Name', 'File'],
    files: (count: number, denied: number) => `${String(count)} file(s) read, ${String(denied)} denied`,
    hypotheses: 'Hypotheses proposed by the run',
    hypothesesNone: 'No hypothesis: the engine proposes them only after a reproduction.',
    experimentsTitle: 'Verifications',
    approve: 'Approve',
    refuse: 'Refuse',
    sideEffects: 'side effects: RUN_WRITES right',
    causesNote:
      'Hypotheses stay PROPOSED until the deterministic confirmation rule (two verifications of different kinds) is met; a replay that cannot tell competing hypotheses apart is marked NEUTRAL.',
    proposalNone: 'No test proposed by the discovery (a reproduced sequence is required).',
    proposalNote: 'Proposed, never “validated” without execution: run it from Report › Non-regression.',
    expected: 'Expected',
    report: 'Run report',
    confidence: 'confidence',
  },
};
type Text = (typeof TEXT)['fr'];
const text = (lang: Lang): Text => TEXT[lang];

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────

export function renderTriggerSection(ctx: WorkspaceContext, ui: TriggerUi, section: TriggerSection): string {
  const run = shownTriggerRun(ctx.incident, ui);
  const body = ((): string => {
    switch (section) {
      case 'brief':
        return `${intro(ctx)}${describeCard(ctx, ui)}${briefCard(ctx, ui)}${controls(ctx, ui, run)}`;
      case 'discovery':
        return discoveryCard(ctx, run);
      case 'explorer':
        return explorerCard(ctx, run);
      case 'live':
        return `${controls(ctx, ui, run)}${liveCard(ctx, ui, run)}`;
      case 'events':
        return eventsCard(ctx, ui, run);
      case 'matrix':
        return matrixCard(ctx, ui, run);
      case 'minimal':
        return minimalCard(ctx, run);
      case 'angular':
        return angularCard(ctx, run);
      case 'causes':
        return causesCard(ctx, ui, run);
      case 'proposal':
        return proposalCard(ctx, run);
    }
  })();
  return `<div class="ws-trg" data-section="${section}">${body}</div>`;
}

function intro(ctx: WorkspaceContext): string {
  const t = text(ctx.lang);
  return `<section class="card wide ws-trg-intro" aria-labelledby="ws-trg-title"><h2 id="ws-trg-title">${esc(t.title)}</h2><p class="mu">${esc(t.sub)}</p></section>`;
}

function errorBox(t: Text, message: string, slot: string): string {
  return `<div class="err-box ws-trg-err" role="alert"><p class="err">${esc(message)}</p><button type="button" class="btn small ghost" data-action="ws-trg-dismiss" data-slot="${esc(slot)}" aria-label="${esc(t.dismiss)}">${icon('close')}</button></div>`;
}

function describeCard(ctx: WorkspaceContext, ui: TriggerUi): string {
  const t = text(ctx.lang);
  const stored = ctx.incident.investigation.trigger?.brief?.rawText ?? '';
  const value = ui.description || stored || ctx.incident.description;
  const canRun = ctx.can('RUN') && !ctx.demo && ui.busy === undefined;
  return `<section class="card wide ws-trg-describe" aria-labelledby="ws-trg-desc-l"><label id="ws-trg-desc-l" for="ws-trg-description">${esc(t.descriptionLabel)}</label><textarea id="ws-trg-description" data-field="trg.description" rows="4" maxlength="20000">${esc(value)}</textarea><p class="mu"><small>${esc(t.descriptionHint)}</small></p><div class="row-acts"><button type="button" class="btn" data-action="ws-trg-describe"${canRun ? '' : ' disabled'}>${icon('search')}<span>${esc(t.describe)}</span></button></div>${ui.errors.describe ? errorBox(t, ui.errors.describe, 'describe') : ''}</section>`;
}

const sourced = (t: Text, item: SourcedText): string =>
  `<span class="ws-trg-sourced">${esc(item.text)} <span class="pill ws-trg-src" title="${esc(item.source)}">${esc(t.sources[item.source])}</span></span>`;

function briefCard(ctx: WorkspaceContext, ui: TriggerUi): string {
  const t = text(ctx.lang);
  const brief: IncidentBrief | undefined =
    shownTriggerRun(ctx.incident, ui)?.brief ?? ctx.incident.investigation.trigger?.brief;
  if (!brief) return `<section class="card wide"><p class="mu">${esc(t.briefNone)}</p></section>`;
  const fields = (Object.keys(t.briefFields) as (keyof typeof t.briefFields)[])
    .map((key) => {
      const item = brief[key];
      return item ? `<div><dt>${esc(t.briefFields[key])}</dt><dd>${sourced(t, item)}</dd></div>` : '';
    })
    .join('');
  const list = (title: string, items: readonly SourcedText[]) =>
    items.length > 0
      ? `<h4 class="ws-trg-h">${esc(title)}</h4><ul class="ws-trg-list">${items.map((item) => `<li>${sourced(t, item)}</li>`).join('')}</ul>`
      : '';
  return `<section class="card wide ws-trg-brief" aria-label="${esc(t.sections.brief)}"><dl class="ws-trg-kv">${fields}<div><dt>${esc('Langue')}</dt><dd>${esc(brief.language)}</dd></div></dl>${list(t.symptoms, brief.symptoms)}${list(t.known, brief.knownConditions)}${list(t.unknown, brief.unknownConditions)}${list(t.environment, brief.environment)}${
    brief.suspectedFailures.length > 0
      ? `<p class="mu"><small>${esc(t.suspected)} : ${esc(brief.suspectedFailures.join(', '))}</small></p>`
      : ''
  }</section>`;
}

function controls(ctx: WorkspaceContext, ui: TriggerUi, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  const active = triggerActive(ctx.incident);
  const paused = run?.state === 'PAUSED';
  const canRun = ctx.can('RUN') && !ctx.demo;
  const busy = ui.busy !== undefined;
  const depthButtons = TRIGGER_DEPTHS.map(
    (depth) =>
      `<button type="button" class="chip ws-trg-choice" data-action="ws-trg-depth" data-depth="${depth}" aria-pressed="${String(ui.depth === depth)}"${active ? ' disabled' : ''} title="${esc(t.depthHints[depth])}">${esc(t.depths[depth])}</button>`,
  ).join('');
  const resumable =
    run && !active && run.state !== 'COMPLETED' && run.state !== 'FAILED' && run.resumePoint !== undefined;
  const actions = active
    ? `<button type="button" class="btn" data-action="${paused ? 'ws-trg-resume' : 'ws-trg-pause'}"${canRun && !busy ? '' : ' disabled'}>${icon(paused ? 'play' : 'pause')}<span>${esc(paused ? t.resume : t.pause)}</span></button>${
        ui.confirmCancel
          ? `<div class="ws-trg-confirm" role="group" aria-label="${esc(t.cancel)}"><p>${esc(t.cancelConfirm)}</p><button type="button" class="btn ghost" data-action="ws-trg-cancel-no">${esc(t.cancelNo)}</button><button type="button" class="btn danger" data-action="ws-trg-cancel-yes"${canRun && !busy ? '' : ' disabled'}>${esc(t.cancelYes)}</button></div>`
          : `<button type="button" class="btn danger" data-action="ws-trg-cancel"${canRun && !busy ? '' : ' disabled'}>${icon('stop')}<span>${esc(t.cancel)}</span></button>`
      }`
    : `<button type="button" class="btn primary" data-action="ws-trg-start"${canRun && !busy ? '' : ' disabled'} title="${esc(canRun ? '' : t.needsRun)}">${icon('play')}<span>${esc(t.start)}</span></button>${
        resumable
          ? `<button type="button" class="btn" data-action="ws-trg-resume"${canRun && !busy ? '' : ' disabled'}>${icon('play')}<span>${esc(t.resume)}</span></button>`
          : ''
      }`;
  const runs = triggerRuns(ctx.incident);
  const runChips =
    runs.length > 1
      ? `<div class="ws-trg-runs" role="group" aria-label="${esc(t.runs)}">${runs
          .map(
            (item) =>
              `<button type="button" class="chip" data-action="ws-trg-run" data-run="${esc(item.id)}" aria-pressed="${String(item.id === run?.id)}">${esc(item.id)} · ${esc(t.states[item.state])}</button>`,
          )
          .join('')}</div>`
      : '';
  const error = ui.errors.start ?? ui.errors.control;
  return `<section class="card wide ws-trg-controls" aria-label="${esc(t.depth)}"><div class="ws-trg-row"><span class="ws-trg-label" id="ws-trg-depth-l">${esc(t.depth)}</span><div class="ws-trg-choices" role="group" aria-labelledby="ws-trg-depth-l">${depthButtons}</div></div><div class="ws-trg-actions row-acts">${actions}${busy ? `<span class="pill live" aria-live="polite">${esc(t.busy)}</span>` : ''}</div>${runChips}${error ? errorBox(t, error, ui.errors.start ? 'start' : 'control') : ''}${run ? runCard(ctx, ui, run) : ''}</section>`;
}

const pct = (value: number, max: number): number =>
  max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));

function runCard(ctx: WorkspaceContext, ui: TriggerUi, run: TriggerRun): string {
  const t = text(ctx.lang);
  const cells: [string, string][] = [
    [t.trials, `${String(run.usage.trials)} / ${String(run.budget.maxTrials)}`],
    [t.actions, `${String(run.usage.actions)} / ${String(run.budget.maxActions)}`],
    [t.repeats, `${String(run.usage.repeats)} / ${String(run.budget.maxRepeats)}`],
    [t.experiments, `${String(run.usage.experiments)} / ${String(run.budget.maxExperiments)}`],
    [t.events, `${String(run.usage.events)} / ${String(run.budget.maxEvents)}`],
    [
      t.duration,
      `${String(Math.round(run.usage.durationMs / 1000))} s / ${String(Math.round(run.budget.maxDurationMs / 1000))} s`,
    ],
    [t.aiCalls, `${String(run.usage.aiCalls)} / ${String(run.budget.maxAiCalls)}`],
  ];
  const tone =
    run.state === 'COMPLETED'
      ? 'ok'
      : run.state === 'FAILED' || run.state === 'CANCELLED'
        ? 'ko'
        : run.state === 'INCONCLUSIVE'
          ? 'warn'
          : 'live';
  const canDecide = ctx.can('DECIDE') && !ctx.demo && ui.busy === undefined;
  const extend = `<details class="ws-trg-extend"><summary>${esc(t.extend)}</summary><div class="row-acts ws-trg-extend-form"><select data-field="trg.extendKey" aria-label="${esc(t.extend)}">${TRIGGER_BUDGET_KEYS.map((key) => `<option value="${key}"${ui.extendKey === key ? ' selected' : ''}>${esc(t.extendKeys[key])}</option>`).join('')}</select><input type="text" inputmode="numeric" class="ws-trg-extend-value" data-field="trg.extendValue" value="${esc(ui.extendValue)}" aria-label="${esc(t.extendBy)}"><button type="button" class="btn small" data-action="ws-trg-extend"${canDecide ? '' : ' disabled'} title="${esc(canDecide ? '' : t.decideRight)}">${esc(t.extendBy)}</button></div>${ui.errors.extend ? errorBox(t, ui.errors.extend, 'extend') : ''}</details>`;
  return `<div class="ws-trg-run" data-state="${run.state}"><div class="ws-trg-head"><h3>${esc(run.id)} · ${esc(run.depth)}</h3><span class="ws-trg-meta"><span class="pill ${tone}" data-state="${run.state}">${esc(t.states[run.state])}</span><time datetime="${esc(run.startedAt)}">${esc(formatDate(run.startedAt, ctx.lang))}</time></span></div><div class="ws-trg-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${String(run.budget.maxTrials)}" aria-valuenow="${String(run.usage.trials)}" aria-label="${esc(t.trials)}"><span class="ws-trg-bar" style="width:${String(pct(run.usage.trials, run.budget.maxTrials))}%"></span></div><dl class="ws-trg-usage">${cells.map(([label, value]) => `<div class="ws-trg-cell"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${run.stopReason ? `<p class="mu"><b>${esc(t.stop)} :</b> ${esc(run.stopReason)}</p>` : ''}${run.error ? `<p class="err">${esc(run.error)}</p>` : ''}${
    run.limitations.length > 0
      ? `<details class="ws-trg-limits"><summary>${esc(t.limitations)} (${String(run.limitations.length)})</summary><ul>${run.limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></details>`
      : ''
  }${extend}</div>`;
}

function table(headers: readonly string[], rows: readonly string[][], className = 'ws-trg-table'): string {
  return `<div class="ws-trg-scroll"><table class="${className}"><thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function discoveryCard(ctx: WorkspaceContext, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  if (!run?.scope)
    return `<section class="card wide"><p class="mu">${esc(run ? t.scopeNone : t.noRun)}</p></section>`;
  const rows = [...run.scope.resources]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 120)
    .map((resource) => [
      esc(resource.kind),
      `<b>${esc(resource.label)}</b>${resource.ref !== resource.label ? `<br><small class="mu">${esc(resource.ref)}</small>` : ''}`,
      `<span class="pill ws-trg-status" data-status="${resource.status}">${esc(resource.status)}</span>`,
      esc(resource.foundBy.join(' + ')),
      esc(resource.relevance.toFixed(2)),
      esc(resource.detail ?? resource.reason ?? ''),
    ]);
  return `<section class="card wide" aria-label="${esc(t.sections.discovery)}"><p class="mu">${esc(t.scopeNote)}</p>${table(t.scopeCols, rows)}</section>`;
}

function explorerCard(ctx: WorkspaceContext, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  if (!run) return `<section class="card wide"><p class="mu">${esc(t.noRun)}</p></section>`;
  const strategies = table(
    t.strategyCols,
    run.strategies.map((item) => [esc(item.strategy), String(item.trials), String(item.reproduced)]),
  );
  const coverage = table(
    t.coverageCols,
    run.coverage.map((item) => [
      `${esc(item.dimension)}${item.note ? `<br><small class="mu">${esc(item.note)}</small>` : ''}`,
      String(item.explored),
      String(item.known),
    ]),
  );
  const ratio = (count: { reproduced: number; total: number }) =>
    `${String(count.reproduced)}/${String(count.total)}`;
  const conditions = table(
    t.conditionCols,
    run.conditions
      .slice(0, 60)
      .map((condition) => [
        `<span class="pill ws-trg-role" data-role="${condition.role}">${esc(t.roles[condition.role] ?? condition.role)}</span>`,
        esc(condition.description),
        esc(ratio(condition.withCondition)),
        esc(ratio(condition.withoutCondition)),
        esc(t.sources[condition.source]),
      ]),
  );
  return `<section class="card wide" aria-label="${esc(t.sections.explorer)}"><h3 class="ws-trg-h">${esc(t.strategies)}</h3>${strategies}<h3 class="ws-trg-h">${esc(t.coverage)}</h3>${coverage}<h3 class="ws-trg-h">${esc(t.conditions)}</h3>${run.conditions.length > 0 ? conditions : `<p class="mu">—</p>`}</section>`;
}

function verdictPill(t: Text, trial: TriggerTrial): string {
  const verdict = trial.verdict ?? trial.status;
  return `<span class="pill ws-trg-verdict" data-verdict="${esc(verdict)}">${esc(t.verdicts[verdict] ?? verdict)}</span>`;
}

function trialRow(ctx: WorkspaceContext, ui: TriggerUi, trial: TriggerTrial): string[] {
  const t = text(ctx.lang);
  return [
    `<button type="button" class="lnk" data-action="ws-trg-trial" data-trial="${esc(trial.id)}" aria-pressed="${String(ui.trialId === trial.id)}">${esc(trial.id)}</button>`,
    esc(trial.strategy),
    esc(trialFactors(trial) || t.reference),
    `${verdictPill(t, trial)}${trial.reason ? `<br><small class="mu">${esc(trial.reason.slice(0, 160))}</small>` : ''}`,
    esc([...new Set(trial.failures.map((failure) => failure.kind))].join(', ')),
    trial.repeats ? esc(`${String(trial.repeats.reproduced)}/${String(trial.repeats.total)}`) : '',
  ];
}

function liveCard(ctx: WorkspaceContext, ui: TriggerUi, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  if (!run) return `<section class="card wide"><p class="mu">${esc(t.noRun)}</p></section>`;
  const last = run.trials.slice(-6).reverse();
  const report =
    ui.reportState === 'loading'
      ? `<p class="mu">${esc(t.reportLoading)}</p>`
      : ui.reportState && typeof ui.reportState === 'object'
        ? `<p class="err">${esc(t.reportError(ui.reportState.error))}</p>`
        : ui.report && ui.reportRunId === run.id
          ? Object.entries(ui.report.sections)
              .filter(([, lines]) => lines.length > 0)
              .map(
                ([key, lines]) =>
                  `<details class="ws-trg-rep"><summary>${esc(key)} (${String(lines.length)})</summary><ul>${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details>`,
              )
              .join('')
          : `<button type="button" class="btn small" data-action="ws-trg-report-load"${ctx.demo ? ' disabled' : ''}>${icon('file')}<span>${esc(t.reportLoad)}</span></button>`;
  return `<section class="card wide" aria-label="${esc(t.sections.live)}"><h3 class="ws-trg-h">${esc(t.lastTrials)}</h3>${
    last.length > 0
      ? table(
          t.matrixCols,
          last.map((trial) => trialRow(ctx, ui, trial)),
        )
      : `<p class="mu">—</p>`
  }<h3 class="ws-trg-h">${esc(t.report)}</h3>${report}</section>`;
}

function matrixCard(ctx: WorkspaceContext, ui: TriggerUi, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  if (!run) return `<section class="card wide"><p class="mu">${esc(t.noRun)}</p></section>`;
  return `<section class="card wide" aria-label="${esc(t.sections.matrix)}">${table(
    t.matrixCols,
    run.trials.map((trial) => trialRow(ctx, ui, trial)),
  )}</section>`;
}

function eventsCard(ctx: WorkspaceContext, ui: TriggerUi, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  const trial =
    run?.trials.find((item) => item.id === ui.trialId) ??
    run?.trials.find((item) => item.verdict === 'FAILURE_REPRODUCED');
  if (!run || !trial)
    return `<section class="card wide"><p class="mu">${esc(run ? t.eventsNone : t.noRun)}</p></section>`;
  const rows = trial.events.map((event) => [
    String(event.t),
    `<span class="pill ws-trg-ev" data-kind="${event.kind}" data-level="${event.level ?? 'info'}">${esc(event.kind)}</span>`,
    `${esc(event.summary)}${event.action !== undefined ? ` <small class="mu">#${String(event.action)}</small>` : ''}`,
  ]);
  return `<section class="card wide" aria-label="${esc(t.sections.events)}"><div class="ws-trg-head"><h3 class="ws-trg-h">${esc(trial.id)} · ${esc(trialFactors(trial) || t.reference)}</h3>${verdictPill(t, trial)}</div>${trial.firstError ? `<p class="err">${esc(trial.firstError.summary)} (t+${String(trial.firstError.t)} ms)</p>` : ''}${table(t.eventCols, rows)}</section>`;
}

function minimalCard(ctx: WorkspaceContext, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  if (!run) return `<section class="card wide"><p class="mu">${esc(t.noRun)}</p></section>`;
  const minimal = run.minimal;
  const steps = minimal
    ? `<h3 class="ws-trg-h">${esc(t.sequence)}</h3><ol class="ws-trg-steps">${minimal.actions.map((action) => `<li>${esc(describe(action))}${action.origin === 'probe' ? ` <span class="pill">${esc(t.probe)}</span>` : ''}</li>`).join('')}</ol><h4 class="ws-trg-h">${esc(t.preconditions)}</h4><ul>${minimal.preconditions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul><p><b>${esc(t.frequency)} :</b> ${String(minimal.frequency.reproduced)}/${String(minimal.frequency.total)} · ${esc(minimal.note)}</p>`
    : `<p class="mu">${esc(t.minimalNone)}</p>`;
  const first = run.firstFailure;
  const firstHtml = first
    ? `<h3 class="ws-trg-h">${esc(t.firstFailure)}</h3><ul>${[
        first.lastFunctionalAction
          ? `Dernière action fonctionnelle : ${first.lastFunctionalAction.summary}`
          : '',
        first.lastSuccessfulRequest
          ? `Dernière requête réussie : ${first.lastSuccessfulRequest.summary}`
          : '',
        first.firstError
          ? `Première erreur : ${first.firstError.summary} (t+${String(first.firstError.t)} ms)`
          : '',
        first.firstFailedAction ? `Première action sans réaction : ${first.firstFailedAction.summary}` : '',
        ...first.propagation,
        ...first.onlyInFailing
          .slice(0, 6)
          .map((item) => `Seulement dans les parcours défaillants : ${item.summary}`),
        first.note,
      ]
        .filter(Boolean)
        .map((line) => `<li>${esc(line)}</li>`)
        .join('')}</ul>`
    : '';
  const loss = run.dataLoss;
  const lossHtml = loss
    ? `<h3 class="ws-trg-h">${esc(t.dataLoss)}</h3><p><b>${esc(t.unsaved)} :</b> ${esc(loss.unsavedFields.join(', ') || '—')}</p>${loss.persistenceFound.length > 0 ? `<p><b>${esc(t.persistence)} :</b> ${loss.persistenceFound.map((item) => esc(`${item.summary}${item.file ? ` (${item.file}:${String(item.line ?? 0)})` : ''}`)).join(' · ')}</p>` : ''}<p><b>${esc(t.lossFactors)} :</b></p><ul>${loss.lossFactors.map((item) => `<li>${esc(item)}</li>`).join('')}</ul><p class="mu"><small>${esc(loss.note)}</small></p>`
    : '';
  return `<section class="card wide" aria-label="${esc(t.sections.minimal)}">${steps}${firstHtml}${lossHtml}</section>`;
}

function describe(action: TriggerRun['trials'][number]['actions'][number]): string {
  const target = (action.target ?? '').replace(/^[a-z]+:/, '');
  switch (action.kind) {
    case 'NAVIGATE':
      return `→ ${action.target ?? ''}`;
    case 'FILL':
      return `${target} = ${action.value === '' ? '«vide»' : (action.value ?? '')}`;
    case 'CLEAR':
      return `${target} = «vide»`;
    case 'SELECT':
      return `${target} ← ${action.value ?? ''}`;
    case 'CHECK':
      return `${target} ${action.value === 'false' ? '☐' : '☑'}`;
    case 'OPEN_DIALOG':
      return `ouvrir « ${target} »`;
    case 'CLOSE_DIALOG':
      return target ? `fermer « ${target} »` : 'fermer le dialogue';
    case 'PRESS':
      return `touche ${action.value ?? ''}`;
    case 'WAIT':
      return `attendre ${String(action.count ?? 0)} ms`;
    case 'REPEAT':
      return `${String(action.count ?? 2)}× « ${target} »`;
    default:
      return `${action.kind.toLowerCase()} « ${target} »`;
  }
}

function angularCard(ctx: WorkspaceContext, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  const model = run?.angular;
  if (!run || !model)
    return `<section class="card wide"><p class="mu">${esc(run ? t.angularNone : t.noRun)}</p></section>`;
  const features = (Object.entries(model.features) as [string, boolean | string | undefined][])
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `<span class="pill" data-on="${String(value)}">${esc(key)} : ${esc(String(value))}</span>`,
    )
    .join(' ');
  const order = [
    'BINDING',
    'HANDLER',
    'SERVICE',
    'HTTP_CALL',
    'API',
    'INTERCEPTOR',
    'ERROR_HANDLER',
    'FORM',
    'CONTROL',
    'VALIDATOR',
    'STREAM',
    'SIGNAL',
    'GUARD',
    'COMPONENT',
  ];
  const rows = [...model.nodes]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .slice(0, 80)
    .map((node) => [
      esc(node.kind),
      esc(node.name),
      `<code>${esc(`${node.file}:${String(node.line)}`)}</code>`,
    ]);
  return `<section class="card wide" aria-label="${esc(t.sections.angular)}"><p class="mu">${esc(t.files(model.files, model.denied.length))}</p><h3 class="ws-trg-h">${esc(t.features)}</h3><p class="ws-trg-features">${features || '—'}</p><h3 class="ws-trg-h">${esc(t.nodes)} (${String(model.nodes.length)})</h3>${table(t.nodeCols, rows)}</section>`;
}

function causesCard(ctx: WorkspaceContext, ui: TriggerUi, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  if (!run) return `<section class="card wide"><p class="mu">${esc(t.noRun)}</p></section>`;
  const hypotheses = triggerHypotheses(ctx.incident, run);
  const experiments = triggerExperiments(ctx.incident, run);
  const canDecide = ctx.can('DECIDE') && !ctx.demo && ui.busy === undefined;
  const hyps =
    hypotheses.length > 0
      ? `<ul class="ws-trg-hyps">${hypotheses
          .map(
            (hypothesis) =>
              `<li class="ws-trg-hyp"><button type="button" class="lnk ${selectionClass(ctx, 'hypothesis', hypothesis.id)}" ${selectable(ctx, 'hypothesis', hypothesis.id)}>${esc(hypothesis.title)}</button> <span class="pill" data-status="${hypothesis.status}">${esc(hypothesis.status)}</span> <small class="mu">${esc(t.confidence)} ${hypothesis.confidence.toFixed(2)}</small><p class="mu">${esc(hypothesis.description)}</p></li>`,
          )
          .join('')}</ul>`
      : `<p class="mu">${esc(t.hypothesesNone)}</p>`;
  const exps =
    experiments.length > 0
      ? `<ul class="ws-trg-exps">${experiments
          .map((experiment) => {
            const slot = `decide:${experiment.id}`;
            const decide =
              experiment.status === 'APPROVAL_REQUIRED' || experiment.status === 'PROPOSED'
                ? `<div class="row-acts"><button type="button" class="btn small primary" data-action="ws-trg-approve" data-experiment="${esc(experiment.id)}"${canDecide ? '' : ' disabled'} title="${esc(canDecide ? '' : t.decideRight)}">${esc(t.approve)}</button><button type="button" class="btn small ghost" data-action="ws-trg-refuse" data-experiment="${esc(experiment.id)}"${canDecide ? '' : ' disabled'}>${esc(t.refuse)}</button></div>`
                : '';
            return `<li class="ws-trg-exp"><b>${esc(experiment.kind)}</b> <span class="pill" data-status="${experiment.status}">${esc(experiment.status)}</span>${experiment.sideEffects ? ` <span class="pill warn">${esc(t.sideEffects)}</span>` : ''}${experiment.outcome ? ` <span class="pill" data-outcome="${experiment.outcome}">${esc(experiment.outcome)}</span>` : ''}<p>${esc(experiment.description)}</p>${experiment.summary ? `<p class="mu">${esc(experiment.summary)}</p>` : ''}${decide}${ui.errors[slot] ? errorBox(t, ui.errors[slot], slot) : ''}</li>`;
          })
          .join('')}</ul>`
      : `<p class="mu">—</p>`;
  return `<section class="card wide" aria-label="${esc(t.sections.causes)}"><h3 class="ws-trg-h">${esc(t.hypotheses)}</h3>${hyps}<h3 class="ws-trg-h">${esc(t.experimentsTitle)}</h3>${exps}<p class="mu"><small>${esc(t.causesNote)}</small></p></section>`;
}

function proposalCard(ctx: WorkspaceContext, run: TriggerRun | undefined): string {
  const t = text(ctx.lang);
  const regression = ctx.incident.investigation.regression;
  if (!run || !regression || regression.basedOn !== `trigger:${run.id}`)
    return `<section class="card wide"><p class="mu">${esc(run ? t.proposalNone : t.noRun)}</p></section>`;
  const execution = regression.execution
    ? `<span class="pill ${regression.execution.passed ? 'ok' : 'ko'}">${esc(regression.execution.passed ? 'PASSED' : 'FAILED')} · ${esc(formatDate(regression.execution.at, ctx.lang))}</span>`
    : `<span class="pill">GENERATED</span>`;
  return `<section class="card wide" aria-label="${esc(t.sections.proposal)}"><div class="ws-trg-head"><h3 class="ws-trg-h">${esc(regression.name)}</h3><span class="ws-trg-meta"><span class="pill" data-status="${regression.status}">${esc(regression.status)}</span>${execution}</span></div><p><b>${esc(t.expected)} :</b> ${esc(regression.expected)}</p><pre class="ws-trg-yaml"><code>${esc(regression.flowYaml)}</code></pre><p class="mu"><small>${esc(t.proposalNote)}</small></p></section>`;
}

export const INCIDENT_TRIGGER_CSS = `
.ws-trg{display:flex;flex-direction:column;gap:12px;min-width:0}
.ws-trg-intro p,.ws-trg-controls p{margin:4px 0}
.ws-trg-describe textarea{width:100%;min-height:88px;padding:8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;resize:vertical;box-sizing:border-box}
.ws-trg-describe textarea:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ws-trg-describe label{display:block;font-weight:600;font-size:13px;margin-bottom:6px}
.ws-trg-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 16px;margin:0 0 8px}
.ws-trg-kv dt{font-size:12px;color:var(--qa-color-muted)}
.ws-trg-kv dd{margin:0;overflow-wrap:anywhere}
.ws-trg-list{margin:0 0 8px;padding-left:20px}
.ws-trg-sourced{display:inline-flex;flex-wrap:wrap;gap:4px 6px;align-items:baseline}
.ws-trg-src{font-size:11px}
.ws-trg-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:0 0 8px}
.ws-trg-label{min-width:88px;font-weight:600;font-size:13px}
.ws-trg-choices{display:flex;flex-wrap:wrap;gap:6px}
.ws-trg-choice{min-height:32px;padding:0 12px;font-size:13px}
.ws-trg-choice[disabled]{opacity:.55;cursor:not-allowed}
.ws-trg-actions{margin-top:8px}
.ws-trg-confirm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;border-radius:10px;border:2px solid var(--qa-color-warning);background:color-mix(in srgb,var(--qa-color-warning) 10%,transparent)}
.ws-trg-confirm p{margin:0;flex:1 1 240px}
.ws-trg-err{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;margin-top:8px}
.ws-trg-runs{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.ws-trg-run{margin-top:10px;padding-top:10px;border-top:1px solid var(--qa-color-border)}
.ws-trg-head{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;justify-content:space-between}
.ws-trg-head h3{margin:0;min-width:0;overflow-wrap:anywhere}
.ws-trg-meta{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center}
.ws-trg-progress{position:relative;height:8px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow:hidden;margin:8px 0 4px}
.ws-trg-bar{position:absolute;inset:0 auto 0 0;background:var(--qa-color-primary);transition:width .2s}
.ws-trg-usage{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px 12px;margin:0}
.ws-trg-cell dt{font-size:12px;color:var(--qa-color-muted)}
.ws-trg-cell dd{margin:0;font:600 13px var(--qa-font-family-mono)}
.ws-trg-limits,.ws-trg-extend,.ws-trg-rep{margin-top:8px}
.ws-trg-limits summary,.ws-trg-extend summary,.ws-trg-rep summary{cursor:pointer}
.ws-trg-extend-form{align-items:center;margin-top:6px}
.ws-trg-extend-form select,.ws-trg-extend-value{min-height:32px;padding:4px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text)}
.ws-trg-extend-value{width:110px}
.ws-trg-h{margin:8px 0 4px;font-size:15px}
.ws-trg-scroll{overflow-x:auto}
.ws-trg-table{width:100%;border-collapse:collapse;font-size:13px}
.ws-trg-table th,.ws-trg-table td{border-bottom:1px solid var(--qa-color-border);padding:6px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.ws-trg-table th[scope="col"]{font-size:12px;color:var(--qa-color-muted);font-weight:600}
.ws-trg-status[data-status="AUTHORIZED"],.ws-trg-verdict[data-verdict="FAILURE_NOT_REPRODUCED"]{background:var(--qa-color-success-soft)}
.ws-trg-status[data-status="DENIED"],.ws-trg-verdict[data-verdict="FAILURE_REPRODUCED"]{background:var(--qa-color-danger-soft)}
.ws-trg-status[data-status="PROPOSED"],.ws-trg-status[data-status="DISCOVERED"],.ws-trg-verdict[data-verdict="INCONCLUSIVE"]{background:var(--qa-color-warning-soft,transparent)}
.ws-trg-role[data-role="NECESSARY"]{background:var(--qa-color-danger-soft)}
.ws-trg-role[data-role="CONTRIBUTING"]{background:var(--qa-color-warning-soft,transparent)}
.ws-trg-ev[data-level="error"]{background:var(--qa-color-danger-soft)}
.ws-trg-steps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
.ws-trg-features{display:flex;flex-wrap:wrap;gap:6px}
.ws-trg-hyps,.ws-trg-exps{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
.ws-trg-hyp p,.ws-trg-exp p{margin:4px 0;overflow-wrap:anywhere}
.ws-trg-yaml{max-height:360px;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);font-size:12px}
.ws-compact .ws-trg{gap:8px}
`;
