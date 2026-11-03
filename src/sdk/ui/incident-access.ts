import type { RecordingSnapshot } from '../core/contracts.js';
import type {
  AccessActionKind,
  AccessAnalysis,
  AccessCandidate,
  AccessElementKind,
  AccessMode,
  Incident,
  IncidentAccess,
  IncidentAccessInput,
  ScopeExtensionKind,
  TargetCandidate,
  TargetLocation,
  TargetPreparation,
} from '../core/incident-contracts.js';
import { ACCESS_ACTION_KINDS, ACCESS_MODES, MAX_ACCESS_STEPS } from '../core/incident-contracts.js';
import type {
  TriggerAction,
  TriggerDepth,
  TriggerRun,
  TriggerState,
} from '../core/incident-trigger-contracts.js';
import { TRIGGER_DEPTHS } from '../core/incident-trigger-contracts.js';
import { icon } from './dashboard-parts.js';
import { ACTIVE_TRIGGER_STATES, triggerActive } from './incident-trigger.js';
import type { Lang } from './incident-parts.js';
import type { ScopeContext } from './incident-scope.js';
import { esc } from './view.js';

/**
 * LA CARTE « SCÉNARIO D'ACCÈS ET EXPLORATION » (étape Périmètre) : la personne indique l'écran où le
 * problème se produit et le symptôme ; QA-CRAWLER localise l'écran dans le code (« Localiser l'écran »),
 * l'atteint dans un vrai navigateur (« Préparer l'exploration »), puis lance le moteur des déclencheurs
 * depuis cet écran (« Lancer l'investigation »). Trois modes : explorer automatiquement, parcours guidé
 * (étapes connues), démonstration (un enregistrement du module Enregistrements, jamais une vidéo).
 * La progression affichée vient du run réel (états, essais, couverture) : aucun pourcentage inventé.
 * Préfixe CSS `inc-acc-`, jetons du thème seulement.
 */

export interface AccessDraft {
  mode: AccessMode;
  target: string;
  url: string;
  hints: string;
  narrative: string;
  start: string;
  steps: { id?: string; text: string }[];
  expected: string;
  observed: string;
  conditions: string;
  testData: string;
}

export interface AccessUi {
  incidentId?: string;
  /** Le brouillon en cours d'édition ; absent : la version enregistrée est affichée. */
  draft?: AccessDraft;
  /** Les détails complémentaires (attendu, observé, conditions, données de test) sont-ils dépliés ? */
  more?: boolean;
  /** La profondeur de l'exploration (budget du moteur). */
  depth: TriggerDepth;
  recordings?: RecordingSnapshot[] | 'loading' | { error: string };
  /** La session d'enregistrement lancée depuis la carte (nom), jusqu'à son arrêt. */
  session?: string;
  /** L'annulation de l'exploration attend une confirmation. */
  confirmCancel?: boolean;
}

export const emptyAccessUi = (incidentId?: string): AccessUi => ({
  ...(incidentId ? { incidentId } : {}),
  depth: 'STANDARD',
});

/** Le brouillon initial : la version enregistrée (ou vide). */
export function draftOf(access: IncidentAccess | undefined): AccessDraft {
  return {
    mode: access?.mode ?? 'AUTO',
    target: access?.target ?? '',
    url: access?.url ?? '',
    hints: access?.hints ?? '',
    narrative: access?.narrative ?? '',
    start: access?.start ?? '',
    steps: (access?.steps ?? []).map((step) => ({ id: step.id, text: step.text })),
    expected: access?.expected ?? '',
    observed: access?.observed ?? '',
    conditions: access?.conditions ?? '',
    testData: access?.testData ?? '',
  };
}

/** Ce qui s'envoie au serveur pour enregistrer le brouillon (les étapes vides sont omises). */
export function accessInputOf(draft: AccessDraft): IncidentAccessInput {
  return {
    mode: draft.mode,
    target: draft.target,
    url: draft.url,
    hints: draft.hints,
    narrative: draft.narrative,
    start: draft.start,
    steps: draft.steps
      .filter((step) => step.text.trim() !== '')
      .map((step) => ({ ...(step.id ? { id: step.id } : {}), text: step.text })),
    expected: draft.expected,
    observed: draft.observed,
    conditions: draft.conditions,
    testData: draft.testData,
  };
}

const TEXT_KEYS = [
  'target',
  'url',
  'hints',
  'narrative',
  'start',
  'expected',
  'observed',
  'conditions',
  'testData',
] as const;
type TextKey = (typeof TEXT_KEYS)[number];

/**
 * Le réducteur : mode (`inc-acc-mode`), saisie (`acc.<champ>`, `acc.step.<i>`, `acc.depth`), étapes
 * (`inc-acc-step-add`, `inc-acc-step-remove`, `inc-acc-step-up`), détails (`inc-acc-more`), abandon du
 * brouillon (`inc-acc-reset`), confirmation d'annulation (`inc-acc-cancel`, `inc-acc-cancel-no`).
 * Undefined : action d'un autre bloc.
 */
export function reduceAccess(
  ui: AccessUi,
  access: IncidentAccess | undefined,
  action: string,
  dataset: Record<string, string | undefined>,
): AccessUi | undefined {
  const draft = (): AccessDraft => ui.draft ?? draftOf(access);
  const index = Number(dataset.index);
  switch (action) {
    case 'inc-acc-mode': {
      const mode = dataset.mode;
      if (!(ACCESS_MODES as readonly string[]).includes(mode ?? '')) return ui;
      return { ...ui, draft: { ...draft(), mode: mode as AccessMode } };
    }
    case 'inc-acc-more':
      return { ...ui, more: !ui.more };
    case 'inc-acc-cancel':
      return { ...ui, confirmCancel: true };
    case 'inc-acc-cancel-no': {
      const { confirmCancel: _dropped, ...rest } = ui;
      return rest;
    }
    case 'inc-acc-reset': {
      const { draft: _dropped, ...rest } = ui;
      return rest;
    }
    case 'inc-acc-step-add': {
      const current = draft();
      if (current.steps.length >= MAX_ACCESS_STEPS) return ui;
      return { ...ui, draft: { ...current, steps: [...current.steps, { text: '' }] } };
    }
    case 'inc-acc-step-remove': {
      const current = draft();
      if (!Number.isInteger(index) || index < 0 || index >= current.steps.length) return ui;
      return { ...ui, draft: { ...current, steps: current.steps.filter((_step, at) => at !== index) } };
    }
    case 'inc-acc-step-up': {
      const current = draft();
      if (!Number.isInteger(index) || index < 1 || index >= current.steps.length) return ui;
      const steps = [...current.steps];
      const [moved] = steps.splice(index, 1);
      if (moved) steps.splice(index - 1, 0, moved);
      return { ...ui, draft: { ...current, steps } };
    }
    case 'inc-acc-input': {
      const key = dataset.key ?? '';
      const value = dataset.value ?? '';
      if (key === 'depth')
        return (TRIGGER_DEPTHS as readonly string[]).includes(value)
          ? { ...ui, depth: value as TriggerDepth }
          : ui;
      const current = draft();
      if ((TEXT_KEYS as readonly string[]).includes(key))
        return { ...ui, draft: { ...current, [key as TextKey]: value } };
      const step = /^step\.(\d{1,2})$/.exec(key);
      if (step) {
        const at = Number(step[1]);
        if (at >= current.steps.length) return ui;
        const steps = current.steps.map((entry, position) =>
          position === at ? { ...entry, text: value } : entry,
        );
        return { ...ui, draft: { ...current, steps } };
      }
      return ui;
    }
    default:
      return undefined;
  }
}

/** Le brouillon diffère-t-il de la version enregistrée ? */
export function accessDirty(ui: AccessUi, access: IncidentAccess | undefined): boolean {
  if (!ui.draft) return false;
  return JSON.stringify(accessInputOf(ui.draft)) !== JSON.stringify(accessInputOf(draftOf(access)));
}

/** Le nom d'un enregistrement lancé depuis la carte (motif des noms d'enregistrement). */
export function sessionName(incidentId: string, now: number): string {
  const base = `parcours-${incidentId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    .replace(/-+$/, '')
    .slice(0, 64);
  return `${base}-${now.toString(36)}`.slice(0, 80);
}

/** L'extension à demander pour une portion de code refusée (dossier du fichier, hôte) ; undefined : aucune. */
export function extensionFor(
  candidate: AccessCandidate,
): { kind: ScopeExtensionKind; target: string; applicationId?: string } | undefined {
  if (candidate.kind === 'DEPENDENCY' && candidate.status === 'PROPOSED')
    return { kind: 'ADD_HOST', target: candidate.label };
  if (candidate.status !== 'DENIED' || !candidate.applicationId) return undefined;
  const file = candidate.ref.split(':')[0] ?? '';
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  return folder ? { kind: 'ADD_PATH', target: folder, applicationId: candidate.applicationId } : undefined;
}

// ── Progression réelle ───────────────────────────────────────────────────────────────────────

export const EXPLORATION_PHASES = [
  'SEARCH',
  'PATH',
  'REACHED',
  'INTERACTIONS',
  'COMBINATIONS',
  'SUSPECTED',
  'REPRODUCING',
  'CONFIRMED',
  'DIAGNOSIS',
] as const;
export type ExplorationPhase = (typeof EXPLORATION_PHASES)[number];
export type PhaseStatus = 'done' | 'current' | 'pending' | 'failed';

/** La phase du moteur que représente chaque état actif du run. */
const PHASE_OF_STATE: Partial<Record<TriggerState, ExplorationPhase>> = {
  INITIALIZING: 'INTERACTIONS',
  DISCOVERING_SCOPE: 'INTERACTIONS',
  EXPLORING_TRIGGERS: 'COMBINATIONS',
  FAILURE_DETECTED: 'SUSPECTED',
  CONFIRMING_REPRODUCTION: 'REPRODUCING',
  MINIMIZING: 'CONFIRMED',
  ANALYZING_ROOT_CAUSE: 'DIAGNOSIS',
  VERIFYING_HYPOTHESES: 'DIAGNOSIS',
};

export interface ExplorationCounters {
  sequences: number;
  states?: { explored: number; known: number };
  lastAction?: string;
  anomalies: number;
  durationMs: number;
  remainingTrials: number;
  remainingMs: number;
}

export interface ExplorationView {
  location?: TargetLocation;
  /** La préparation de l'écran retenu (une préparation d'un autre écran n'est pas montrée comme valable). */
  preparation?: TargetPreparation;
  run?: TriggerRun;
  live: boolean;
  phases: { key: ExplorationPhase; status: PhaseStatus }[];
  counters?: ExplorationCounters;
  /** La reproduction répétée la plus forte : reproduite / rejouée (jamais une cause). */
  repeats?: { reproduced: number; total: number };
}

/** Le run du moteur lancé depuis l'écran cible (le dernier). */
export function explorationRun(incident: Pick<Incident, 'access' | 'investigation'>): TriggerRun | undefined {
  const id = incident.access?.exploration?.runId;
  if (!id) return undefined;
  return incident.investigation.trigger?.runs.find((run) => run.id === id);
}

/** Une action du moteur, lisible (une valeur vide est dite, jamais une valeur masquée inventée). */
export function actionText(action: TriggerAction, lang: Lang): string {
  const target = (action.target ?? '').replace(/^[a-z]+:/, '');
  const fr = lang === 'fr';
  const empty = fr ? '« vide »' : '“empty”';
  switch (action.kind) {
    case 'NAVIGATE':
      return `${fr ? 'aller à' : 'go to'} ${action.target ?? ''}`;
    case 'FILL':
      return `${target} = ${action.value === '' ? empty : (action.value ?? '')}`;
    case 'CLEAR':
      return `${target} = ${empty}`;
    case 'SELECT':
      return `${target} ← ${action.value ?? ''}`;
    case 'CHECK':
      return `${target} ${action.value === 'false' ? '☐' : '☑'}`;
    case 'OPEN_DIALOG':
      return fr ? `ouvrir « ${target} »` : `open “${target}”`;
    case 'CLOSE_DIALOG':
      return fr
        ? target
          ? `fermer « ${target} »`
          : 'fermer le dialogue'
        : target
          ? `close “${target}”`
          : 'close the dialog';
    case 'PRESS':
      return `${fr ? 'touche' : 'key'} ${action.value ?? ''}`;
    case 'WAIT':
      return `${fr ? 'attendre' : 'wait'} ${String(action.count ?? 0)} ms`;
    case 'REPEAT':
      return `${String(action.count ?? 2)}× « ${target} »`;
    case 'CLICK':
      return fr ? `cliquer « ${target} »` : `click “${target}”`;
    default:
      return `${action.kind.toLowerCase()} « ${target} »`;
  }
}

/** La progression : chaque phase est faite, en cours, à venir ou en échec selon les données réelles. */
export function explorationView(
  incident: Pick<Incident, 'access' | 'investigation'>,
  lang: Lang,
  busy?: string,
): ExplorationView {
  const access = incident.access;
  const location = access?.location;
  const preparation =
    access?.preparation && location?.chosen && access.preparation.route === location.chosen
      ? access.preparation
      : undefined;
  const run = explorationRun(incident);
  const live = run !== undefined && ACTIVE_TRIGGER_STATES.includes(run.state) && run.state !== 'PAUSED';
  const current = run && live ? PHASE_OF_STATE[run.state] : undefined;
  const reproduced = run?.trials.filter((trial) => trial.verdict === 'FAILURE_REPRODUCED') ?? [];
  const repeated = (run?.trials ?? [])
    .map((trial) => trial.repeats)
    .filter((item): item is { reproduced: number; total: number } => item !== undefined)
    .sort((a, b) => b.reproduced - a.reproduced || b.total - a.total)[0];
  const terminal = run !== undefined && !ACTIVE_TRIGGER_STATES.includes(run.state);
  const done: Record<ExplorationPhase, PhaseStatus> = {
    SEARCH: location ? (location.chosen ? 'done' : 'failed') : 'pending',
    PATH: location?.chosen ? (location.path.length > 0 ? 'done' : 'failed') : 'pending',
    REACHED: preparation ? (preparation.reached ? 'done' : 'failed') : 'pending',
    INTERACTIONS: run && (run.trials.length > 0 || run.angular) ? 'done' : 'pending',
    COMBINATIONS: run?.trials.some((trial) => trial.strategy !== 'MINIMIZATION') ? 'done' : 'pending',
    SUSPECTED: reproduced.length > 0 ? 'done' : 'pending',
    REPRODUCING: repeated ? 'done' : 'pending',
    CONFIRMED: repeated && repeated.reproduced >= 2 ? 'done' : 'pending',
    DIAGNOSIS:
      terminal && run.state !== 'CANCELLED' && (run.hypothesisIds.length > 0 || run.firstFailure)
        ? 'done'
        : 'pending',
  };
  if (run?.state === 'FAILED' && run.trials.length === 0) done.INTERACTIONS = 'failed';
  const busyPhase: ExplorationPhase | undefined =
    busy === 'inc-acc-locate'
      ? 'SEARCH'
      : busy === 'inc-acc-prepare'
        ? 'REACHED'
        : busy === 'inc-acc-explore'
          ? 'INTERACTIONS'
          : undefined;
  const phases = EXPLORATION_PHASES.map((key) => ({
    key,
    status: key === busyPhase || key === current ? ('current' as const) : done[key],
  }));
  if (!run) return { ...viewBase(location, preparation), live, phases };
  const states = run.coverage.find((item) => item.dimension === 'STATES');
  const last = [...run.trials].reverse().find((trial) => trial.actions.length > 0);
  const probe = last ? (last.actions[last.probes.at(-1) ?? -1] ?? last.actions.at(-1)) : undefined;
  return {
    ...viewBase(location, preparation),
    run,
    live,
    phases,
    ...(repeated ? { repeats: repeated } : {}),
    counters: {
      sequences: run.usage.trials,
      ...(states ? { states: { explored: states.explored, known: states.known } } : {}),
      ...(probe ? { lastAction: actionText(probe, lang) } : {}),
      anomalies: reproduced.length,
      durationMs: run.usage.durationMs,
      remainingTrials: Math.max(0, run.budget.maxTrials - run.usage.trials),
      remainingMs: Math.max(0, run.budget.maxDurationMs - run.usage.durationMs),
    },
  };
}

const viewBase = (
  location: TargetLocation | undefined,
  preparation: TargetPreparation | undefined,
): Pick<ExplorationView, 'location' | 'preparation'> => ({
  ...(location ? { location } : {}),
  ...(preparation ? { preparation } : {}),
});

/** Peut-on lancer l'investigation ? (écran retenu réellement atteint, aucun run actif) */
export function canExplore(incident: Pick<Incident, 'access' | 'investigation'>): boolean {
  const location = incident.access?.location;
  const preparation = incident.access?.preparation;
  return (
    location?.chosen !== undefined &&
    preparation?.reached === true &&
    preparation.route === location.chosen &&
    !triggerActive(incident)
  );
}

const durationText = (ms: number, _lang: Lang): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)} min ${String(rest).padStart(2, '0')} s`;
};

const dateText = (iso: string | undefined, lang: Lang): string => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'short', timeStyle: 'short' });
};

const percent = (value: number): string => `${String(Math.round(value * 100))} %`;

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const FR = {
  title: 'Scénario d’accès et exploration',
  sub: 'Indiquez l’écran où le problème se produit et décrivez le symptôme. QA-CRAWLER localise l’écran dans le code, l’atteint dans un navigateur, puis explore ses interactions pour reproduire et diagnostiquer le problème.',
  entry:
    'L’écran cible est un point d’entrée : l’analyse suit les dépendances au-delà, dans les règles du périmètre.',
  modesLabel: 'Mode d’investigation',
  modes: {
    AUTO: 'Explorer automatiquement',
    GUIDED: 'Parcours guidé',
    DEMO: 'Démonstration',
  } as Record<AccessMode, string>,
  modeHints: {
    AUTO: 'Recommandé : QA-CRAWLER trouve le parcours dans le code et explore seul.',
    GUIDED: 'Vous indiquez les étapes connues ; QA-CRAWLER les suit puis explore.',
    DEMO: 'Vous enregistrez le parcours (module Enregistrements) ; son départ sert d’entrée.',
  } as Record<AccessMode, string>,
  recommended: 'recommandé',
  status: {
    saved: 'Scénario enregistré',
    none: 'Aucun scénario',
    located: (route: string) => `Écran localisé : ${route}`,
    reached: 'Écran atteint',
    notReached: 'Écran non atteint',
    stale: 'Localisation antérieure à la dernière modification',
    recording: (name: string) => `Enregistrement associé : ${name}`,
    analysis: 'Parcours analysé',
  },
  states: {
    INITIALIZING: 'Initialisation',
    DISCOVERING_SCOPE: 'Analyse des interactions',
    EXPLORING_TRIGGERS: 'Exploration des combinaisons',
    FAILURE_DETECTED: 'Anomalie suspectée',
    CONFIRMING_REPRODUCTION: 'Reproduction en cours',
    MINIMIZING: 'Réduction de la séquence',
    ANALYZING_ROOT_CAUSE: 'Diagnostic en cours',
    VERIFYING_HYPOTHESES: 'Diagnostic en cours',
    WAITING_FOR_APPROVAL: 'En attente d’une décision',
    PAUSED: 'En pause',
    COMPLETED: 'Terminée',
    INCONCLUSIVE: 'Non concluante',
    CANCELLED: 'Annulée',
    FAILED: 'Échec',
  } as Record<TriggerState, string>,
  target: 'Écran ou fonctionnalité cible',
  targetHint: 'Exemple : création d’un nouveau dossier.',
  url: 'URL facultative',
  urlHint: 'Un chemin (/dossiers/nouveau) ou une URL http(s), si connue.',
  hints: 'Indications de navigation facultatives',
  hintsHint: 'Exemple : menu Dossiers, puis Nouveau dossier.',
  narrative: 'Description du problème',
  narrativeHint: 'Le symptôme, avec vos mots : ce qui se passe et ce qui devrait se passer.',
  narrativePlaceholder:
    'Après une erreur, le bouton Enregistrer ne fait plus rien : aucune validation, aucun chargement, aucune requête. Les données saisies sont perdues après un rechargement.',
  required: 'obligatoire',
  more: 'Détails complémentaires',
  start: 'Point de départ',
  startHint: 'Exemple : page d’accueil après connexion.',
  steps: 'Étapes connues',
  stepsHint: 'Une action par étape ; chacune est rapprochée d’un lien relevé dans le code.',
  step: (n: number) => `Étape ${String(n)}`,
  stepUp: (n: number) => `Monter l’étape ${String(n)}`,
  stepRemove: (n: number) => `Retirer l’étape ${String(n)}`,
  addStep: 'Ajouter une étape',
  expected: 'Résultat attendu',
  observed: 'Comportement observé',
  conditions: 'Conditions particulières',
  testData: 'Données de test nécessaires',
  testDataHint:
    'Décrivez les données sans mot de passe ni jeton : les valeurs sensibles sont masquées à l’enregistrement.',
  save: 'Enregistrer le scénario',
  reset: 'Annuler les modifications',
  locate: 'Localiser l’écran',
  prepare: 'Préparer l’exploration',
  explore: 'Lancer l’investigation',
  depth: 'Profondeur',
  depths: { QUICK: 'Rapide', STANDARD: 'Standard', DEEP: 'Approfondie' } as Record<TriggerDepth, string>,
  actionsHint:
    'Localiser lit le code (lecture seule). Préparer ouvre un navigateur sur l’environnement de test. Lancer explore depuis l’écran atteint, dans les budgets du moteur.',
  needTarget: 'Indiquez l’écran cible (ou une URL), puis localisez-le : la saisie est enregistrée d’abord.',
  needLocation: 'Localisez d’abord l’écran.',
  needReached: 'L’écran doit être atteint dans le navigateur avant l’exploration.',
  running: 'Une exploration est déjà en cours.',
  dirty: 'Modifications non enregistrées : chaque action les enregistre d’abord.',
  readOnly: 'Lecture seule : votre rôle ne permet pas de modifier le scénario.',
  demoNote: 'Indisponible dans la démonstration : utilisez un incident réel.',
  analyze: 'Analyser le parcours',
  candidatesTitle: 'Écrans candidats',
  chosen: 'retenu',
  choose: 'Choisir cet écran',
  nameOnly: 'nom seul',
  guarded: (guards: string) => `garde : ${guards}`,
  pathTitle: 'Parcours trouvé',
  pathSources: {
    LINKS: 'lien relevé',
    GUIDED: 'étape connue',
    RECORDING: 'enregistrement',
    DIRECT: 'URL directe',
  } as Record<string, string>,
  noCandidate: 'Aucun écran ne correspond dans le code lu.',
  limits: 'Limites',
  prepTitle: 'Écran atteint',
  prepFailed: 'Écran non atteint',
  prepSteps: 'Parcours joué',
  inventory: 'Interactions relevées',
  inv: {
    buttons: 'boutons',
    fields: 'champs',
    links: 'liens',
    selects: 'listes',
    dialogs: 'dialogues ouverts',
    disabled: 'désactivés',
  },
  prepErrors: 'Erreurs vues pendant le parcours',
  prepRequests: (n: number) => `${String(n)} requête(s) observée(s)`,
  blockers: 'Ce qui empêche l’exploration',
  shot: (name: string) => `Capture gardée : ${name}`,
  progress: 'Progression de l’investigation',
  phases: {
    SEARCH: 'Recherche de l’écran',
    PATH: 'Parcours identifié',
    REACHED: 'Écran atteint',
    INTERACTIONS: 'Analyse des interactions',
    COMBINATIONS: 'Exploration des combinaisons',
    SUSPECTED: 'Anomalie suspectée',
    REPRODUCING: 'Reproduction en cours',
    CONFIRMED: 'Anomalie confirmée',
    DIAGNOSIS: 'Diagnostic en cours',
  } as Record<ExplorationPhase, string>,
  phaseStatus: { done: 'fait', current: 'en cours', pending: 'à venir', failed: 'échec' } as Record<
    PhaseStatus,
    string
  >,
  counters: {
    sequences: 'Séquences exécutées',
    states: 'États explorés',
    lastAction: 'Dernière action',
    anomalies: 'Anomalies',
    duration: 'Durée',
    remaining: 'Limites restantes',
  },
  remaining: (trials: number, time: string) => `${String(trials)} essai(s), ${time}`,
  pause: 'Mettre en pause',
  resume: 'Reprendre',
  cancel: 'Annuler l’exploration',
  cancelConfirm: 'Annuler l’exploration en cours ? Les essais déjà joués restent.',
  cancelYes: 'Confirmer l’annulation',
  cancelNo: 'Continuer',
  results: 'Résultats',
  sequence: 'Séquence déclenchante',
  frequency: (reproduced: number, total: number) =>
    `séquence réduite : reproduite ${String(reproduced)} fois sur ${String(total)}`,
  confirmedNote: (reproduced: number, total: number) =>
    `Anomalie reproduite ${String(reproduced)} fois sur ${String(total)} : le symptôme est confirmé, la cause reste à vérifier.`,
  singleNote: 'Une seule reproduction : le symptôme n’est pas encore confirmé.',
  noReproduction:
    'Aucune reproduction dans le budget : rien n’est conclu. Élargissez la profondeur ou précisez le scénario.',
  preconditions: 'Préconditions',
  conditionsTitle: 'Conditions découvertes',
  roles: {
    NECESSARY: 'nécessaire',
    CONTRIBUTING: 'aggravante',
    CANDIDATE: 'corrélée',
    REFUTED: 'réfutée',
  } as Record<string, string>,
  withWithout: (a: string, b: string) => `avec : ${a} · sans : ${b}`,
  evidence: 'Preuves',
  firstError: 'Première erreur',
  firstFailed: 'Première action sans effet',
  lastRequest: 'Dernière requête réussie',
  onlyFailing: 'Vu seulement dans les essais défaillants',
  suspects: 'Composants suspects',
  noSuspect: 'Aucune hypothèse écrite par ce run.',
  confidence: 'Confiance',
  hypoStatus: {
    PROPOSED: 'proposée',
    CONFIRMED: 'confirmée',
    REFUTED: 'réfutée',
    INCONCLUSIVE: 'non concluante',
  } as Record<string, string>,
  locConfidence: (value: string) => `localisation de l’écran : ${value}`,
  recoTitle: 'Actions recommandées',
  recoPending: (n: number) => `Décider des ${String(n)} vérification(s) en attente.`,
  recoHypotheses: 'Vérifier les hypothèses proposées : aucune n’est confirmée par le moteur seul.',
  recoDeeper: 'Relancer avec une profondeur plus grande ou des étapes connues.',
  openMinimal: 'Voir la séquence minimale',
  openCauses: 'Voir les causes possibles',
  openHypotheses: 'Voir les hypothèses',
  recordTitle: 'Enregistrer le parcours',
  recordText:
    'Le module Enregistrements ouvre un navigateur sur la machine du serveur QA-CRAWLER, à l’URL indiquée ; vos actions y sont capturées (aucune valeur saisie n’est gardée), puis l’enregistrement est associé au scénario.',
  recordStart: 'Démarrer l’enregistrement',
  recordStop: 'Arrêter et associer',
  recordRunning: (name: string) => `Enregistrement en cours : ${name}`,
  recordFollow: 'Suivre dans Enregistrements',
  recordingsTitle: 'Enregistrements existants',
  recordingsLoad: 'Afficher les enregistrements',
  recordingsRefresh: 'Actualiser',
  recordingsEmpty: 'Aucun enregistrement dans ce projet.',
  recordingSteps: (n: number) => `${String(n)} étape(s)`,
  link: 'Associer au scénario',
  linked: 'Associé',
  unlink: 'Dissocier',
  analysis: 'Analyse du parcours décrit',
  path: 'Parcours compris',
  sources: { TEXT: 'texte', STEPS: 'étapes', RECORDING: 'enregistrement' } as Record<string, string>,
  critical: 'étape critique',
  interpretations: 'Interprétations',
  kinds: { AREA: 'Zone métier', ENTITY: 'Entité', ACTION: 'Action', TRIGGER: 'Événement critique' } as Record<
    string,
    string
  >,
  candidates: 'Portions de code candidates',
  matchedTitle: 'Correspondances',
  uncertainTitle: 'Correspondances incertaines',
  noCandidates: 'Aucune portion de code localisée.',
  transversal: 'au-delà de l’écran',
  outOfScope: 'hors périmètre',
  extension: 'Demander l’extension',
  leads: 'Pistes à vérifier',
  leadsNote:
    'Des pistes, jamais des causes : seules les preuves de la reproduction et des vérifications concluent.',
  noRefs: 'rien trouvé dans le code lu',
  analysisLimits: 'Limites de l’analyse',
  anomalies: 'Comportements anormaux décrits',
  actions: {
    LOGIN: 'Connexion',
    NAVIGATE: 'Navigation',
    OPEN: 'Ouverture',
    CREATE: 'Création',
    EDIT: 'Modification',
    DELETE: 'Suppression',
    FILL: 'Saisie',
    SELECT: 'Sélection',
    CLICK: 'Clic',
    SAVE: 'Enregistrement',
    SUBMIT: 'Validation',
    SEARCH: 'Recherche',
    CLOSE: 'Fermeture',
    WAIT: 'Attente',
    OTHER: 'Action',
  } as Record<AccessActionKind, string>,
  elements: {
    MENU: 'menu',
    BUTTON: 'bouton',
    FIELD: 'champ',
    TAB: 'onglet',
    PAGE: 'page',
    LINK: 'lien',
    MODAL: 'fenêtre',
    LIST: 'liste',
  } as Record<AccessElementKind, string>,
  summaryTitle: 'Scénario d’accès',
  summaryScreen: 'Écran cible',
  summaryHints: 'Indications',
  summaryExploration: 'Exploration',
};

type Text = typeof FR;

const EN: Text = {
  ...FR,
  title: 'Access scenario and exploration',
  sub: 'Name the screen where the problem happens and describe the symptom. QA-CRAWLER locates the screen in the code, reaches it in a browser, then explores its interactions to reproduce and diagnose the problem.',
  entry:
    'The target screen is an entry point: the analysis follows dependencies beyond it, within the scope rules.',
  modesLabel: 'Investigation mode',
  modes: { AUTO: 'Explore automatically', GUIDED: 'Guided path', DEMO: 'Demonstration' },
  modeHints: {
    AUTO: 'Recommended: QA-CRAWLER finds the path in the code and explores on its own.',
    GUIDED: 'You give the known steps; QA-CRAWLER follows them, then explores.',
    DEMO: 'You record the path (Recordings module); its start is used as the entry.',
  },
  recommended: 'recommended',
  status: {
    saved: 'Scenario saved',
    none: 'No scenario',
    located: (route) => `Screen located: ${route}`,
    reached: 'Screen reached',
    notReached: 'Screen not reached',
    stale: 'Location older than the last change',
    recording: (name) => `Linked recording: ${name}`,
    analysis: 'Path analysed',
  },
  states: {
    INITIALIZING: 'Starting',
    DISCOVERING_SCOPE: 'Analysing interactions',
    EXPLORING_TRIGGERS: 'Exploring combinations',
    FAILURE_DETECTED: 'Anomaly suspected',
    CONFIRMING_REPRODUCTION: 'Reproducing',
    MINIMIZING: 'Reducing the sequence',
    ANALYZING_ROOT_CAUSE: 'Diagnosing',
    VERIFYING_HYPOTHESES: 'Diagnosing',
    WAITING_FOR_APPROVAL: 'Waiting for a decision',
    PAUSED: 'Paused',
    COMPLETED: 'Completed',
    INCONCLUSIVE: 'Inconclusive',
    CANCELLED: 'Cancelled',
    FAILED: 'Failed',
  },
  target: 'Target screen or feature',
  targetHint: 'Example: creating a new folder.',
  url: 'Optional URL',
  urlHint: 'A path (/folders/new) or an http(s) URL, if known.',
  hints: 'Optional navigation hints',
  hintsHint: 'Example: Folders menu, then New folder.',
  narrative: 'Problem description',
  narrativeHint: 'The symptom, in your own words: what happens and what should happen.',
  narrativePlaceholder:
    'After an error, the Save button does nothing: no validation, no loading, no request. Typed data is lost after a reload.',
  required: 'required',
  more: 'Additional details',
  start: 'Starting point',
  startHint: 'Example: home page after signing in.',
  steps: 'Known steps',
  stepsHint: 'One action per step; each one is matched with a link found in the code.',
  step: (n) => `Step ${String(n)}`,
  stepUp: (n) => `Move step ${String(n)} up`,
  stepRemove: (n) => `Remove step ${String(n)}`,
  addStep: 'Add a step',
  expected: 'Expected result',
  observed: 'Observed behaviour',
  conditions: 'Special conditions',
  testData: 'Test data needed',
  testDataHint: 'Describe the data without passwords or tokens: sensitive values are masked when saved.',
  save: 'Save the scenario',
  reset: 'Discard changes',
  locate: 'Locate the screen',
  prepare: 'Prepare the exploration',
  explore: 'Start the investigation',
  depth: 'Depth',
  depths: { QUICK: 'Quick', STANDARD: 'Standard', DEEP: 'Deep' },
  actionsHint:
    'Locate reads the code (read only). Prepare opens a browser on the test environment. Start explores from the reached screen, within the engine budgets.',
  needTarget: 'Give the target screen (or a URL), then locate it: the input is saved first.',
  needLocation: 'Locate the screen first.',
  needReached: 'The screen must be reached in the browser before the exploration.',
  running: 'An exploration is already running.',
  dirty: 'Unsaved changes: each action saves them first.',
  readOnly: 'Read only: your role cannot change the scenario.',
  demoNote: 'Unavailable in the demonstration: use a real incident.',
  analyze: 'Analyse the path',
  candidatesTitle: 'Candidate screens',
  chosen: 'chosen',
  choose: 'Choose this screen',
  nameOnly: 'name only',
  guarded: (guards) => `guard: ${guards}`,
  pathTitle: 'Path found',
  pathSources: { LINKS: 'link found', GUIDED: 'known step', RECORDING: 'recording', DIRECT: 'direct URL' },
  noCandidate: 'No screen matches in the code read.',
  limits: 'Limits',
  prepTitle: 'Screen reached',
  prepFailed: 'Screen not reached',
  prepSteps: 'Path played',
  inventory: 'Interactions found',
  inv: {
    buttons: 'buttons',
    fields: 'fields',
    links: 'links',
    selects: 'lists',
    dialogs: 'open dialogs',
    disabled: 'disabled',
  },
  prepErrors: 'Errors seen during the path',
  prepRequests: (n) => `${String(n)} request(s) observed`,
  blockers: 'What prevents the exploration',
  shot: (name) => `Screenshot kept: ${name}`,
  progress: 'Investigation progress',
  phases: {
    SEARCH: 'Searching the screen',
    PATH: 'Path identified',
    REACHED: 'Screen reached',
    INTERACTIONS: 'Analysing interactions',
    COMBINATIONS: 'Exploring combinations',
    SUSPECTED: 'Anomaly suspected',
    REPRODUCING: 'Reproducing',
    CONFIRMED: 'Anomaly confirmed',
    DIAGNOSIS: 'Diagnosing',
  },
  phaseStatus: { done: 'done', current: 'running', pending: 'pending', failed: 'failed' },
  counters: {
    sequences: 'Sequences run',
    states: 'States explored',
    lastAction: 'Last action',
    anomalies: 'Anomalies',
    duration: 'Duration',
    remaining: 'Remaining limits',
  },
  remaining: (trials, time) => `${String(trials)} trial(s), ${time}`,
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel the exploration',
  cancelConfirm: 'Cancel the running exploration? Trials already played are kept.',
  cancelYes: 'Yes, cancel',
  cancelNo: 'Continue',
  results: 'Results',
  sequence: 'Triggering sequence',
  frequency: (reproduced, total) =>
    `reduced sequence: reproduced ${String(reproduced)} times out of ${String(total)}`,
  confirmedNote: (reproduced, total) =>
    `Anomaly reproduced ${String(reproduced)} times out of ${String(total)}: the symptom is confirmed, the cause still has to be verified.`,
  singleNote: 'A single reproduction: the symptom is not confirmed yet.',
  noReproduction:
    'No reproduction within the budget: nothing is concluded. Increase the depth or refine the scenario.',
  preconditions: 'Preconditions',
  conditionsTitle: 'Conditions found',
  roles: { NECESSARY: 'necessary', CONTRIBUTING: 'aggravating', CANDIDATE: 'correlated', REFUTED: 'refuted' },
  withWithout: (a, b) => `with: ${a} · without: ${b}`,
  evidence: 'Evidence',
  firstError: 'First error',
  firstFailed: 'First action without effect',
  lastRequest: 'Last successful request',
  onlyFailing: 'Seen only in failing trials',
  suspects: 'Suspect components',
  noSuspect: 'No hypothesis written by this run.',
  confidence: 'Confidence',
  hypoStatus: {
    PROPOSED: 'proposed',
    CONFIRMED: 'confirmed',
    REFUTED: 'refuted',
    INCONCLUSIVE: 'inconclusive',
  },
  locConfidence: (value) => `screen location: ${value}`,
  recoTitle: 'Recommended actions',
  recoPending: (n) => `Decide on the ${String(n)} pending verification(s).`,
  recoHypotheses: 'Verify the proposed hypotheses: none is confirmed by the engine alone.',
  recoDeeper: 'Run again with a greater depth or known steps.',
  openMinimal: 'See the minimal sequence',
  openCauses: 'See the possible causes',
  openHypotheses: 'See the hypotheses',
  recordTitle: 'Record the path',
  recordText:
    'The Recordings module opens a browser on the QA-CRAWLER server machine, at the given URL; your actions are captured there (no typed value is kept), then the recording is linked to the scenario.',
  recordStart: 'Start recording',
  recordStop: 'Stop and link',
  recordRunning: (name) => `Recording in progress: ${name}`,
  recordFollow: 'Follow in Recordings',
  recordingsTitle: 'Existing recordings',
  recordingsLoad: 'Show recordings',
  recordingsRefresh: 'Refresh',
  recordingsEmpty: 'No recording in this project.',
  recordingSteps: (n) => `${String(n)} step(s)`,
  link: 'Link to the scenario',
  linked: 'Linked',
  unlink: 'Unlink',
  analysis: 'Analysis of the described path',
  path: 'Understood path',
  sources: { TEXT: 'text', STEPS: 'steps', RECORDING: 'recording' },
  critical: 'critical step',
  interpretations: 'Interpretations',
  kinds: { AREA: 'Business area', ENTITY: 'Entity', ACTION: 'Action', TRIGGER: 'Critical event' },
  candidates: 'Candidate code',
  matchedTitle: 'Matches',
  uncertainTitle: 'Uncertain matches',
  noCandidates: 'No code located.',
  transversal: 'beyond the screen',
  outOfScope: 'out of scope',
  extension: 'Request the extension',
  leads: 'Leads to check',
  leadsNote: 'Leads, never causes: only reproduction and verification evidence concludes.',
  noRefs: 'nothing found in the code read',
  analysisLimits: 'Analysis limits',
  anomalies: 'Described abnormal behaviours',
  actions: {
    LOGIN: 'Sign in',
    NAVIGATE: 'Navigation',
    OPEN: 'Open',
    CREATE: 'Create',
    EDIT: 'Edit',
    DELETE: 'Delete',
    FILL: 'Fill',
    SELECT: 'Select',
    CLICK: 'Click',
    SAVE: 'Save',
    SUBMIT: 'Submit',
    SEARCH: 'Search',
    CLOSE: 'Close',
    WAIT: 'Wait',
    OTHER: 'Action',
  },
  elements: {
    MENU: 'menu',
    BUTTON: 'button',
    FIELD: 'field',
    TAB: 'tab',
    PAGE: 'page',
    LINK: 'link',
    MODAL: 'window',
    LIST: 'list',
  },
  summaryTitle: 'Access scenario',
  summaryScreen: 'Target screen',
  summaryHints: 'Hints',
  summaryExploration: 'Exploration',
};

const TEXT: Record<Lang, Text> = { fr: FR, en: EN };

const NOTICES = {
  fr: {
    saved: 'Scénario d’accès enregistré.',
    analyzed: 'Parcours analysé : les portions de code candidates sont listées sous la carte.',
    located: (route: string) => `Écran localisé : ${route}. Préparez maintenant l’exploration.`,
    notLocated: 'Aucun écran retenu : voir les limites sous la carte.',
    prepared: 'Écran atteint dans le navigateur : l’investigation peut être lancée.',
    notPrepared: 'Écran non atteint : voir ce qui empêche l’exploration.',
    explored: 'Investigation lancée depuis l’écran cible : la progression se met à jour seule.',
    paused: 'Exploration mise en pause.',
    resumed: 'Exploration reprise.',
    cancelled: 'Exploration annulée.',
    linked: (name: string) => `Enregistrement « ${name} » associé au scénario.`,
    unlinked: 'Enregistrement dissocié du scénario.',
    recording: (name: string) =>
      `Enregistrement « ${name} » démarré : agissez dans le navigateur ouvert, puis « Arrêter et associer ».`,
  },
  en: {
    saved: 'Access scenario saved.',
    analyzed: 'Path analysed: candidate code is listed under the card.',
    located: (route: string) => `Screen located: ${route}. Now prepare the exploration.`,
    notLocated: 'No screen chosen: see the limits under the card.',
    prepared: 'Screen reached in the browser: the investigation can start.',
    notPrepared: 'Screen not reached: see what prevents the exploration.',
    explored: 'Investigation started from the target screen: progress updates on its own.',
    paused: 'Exploration paused.',
    resumed: 'Exploration resumed.',
    cancelled: 'Exploration cancelled.',
    linked: (name: string) => `Recording “${name}” linked to the scenario.`,
    unlinked: 'Recording unlinked from the scenario.',
    recording: (name: string) =>
      `Recording “${name}” started: act in the opened browser, then “Stop and link”.`,
  },
};

/** Les messages de confirmation des actions de la carte. */
export const accessNotices = (lang: Lang): (typeof NOTICES)['fr'] => NOTICES[lang];

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────

/** Peut-on modifier le scénario ? (droit RUN, incident réel, non annulé) */
export function accessEditable(ctx: ScopeContext): boolean {
  return !ctx.demo && ctx.can('RUN') && ctx.incident.state !== 'CANCELLED';
}

function textField(
  key: TextKey,
  label: string,
  value: string,
  opts: {
    area?: boolean;
    hint?: string;
    placeholder?: string;
    mono?: boolean;
    disabled: boolean;
    rows?: number;
    required?: string;
    wide?: boolean;
  },
): string {
  const id = `inc-acc-${key}`;
  const described = opts.hint ? ` aria-describedby="${id}-h"` : '';
  const common = `id="${id}" data-inc="acc.${key}"${described}${opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : ''}${opts.mono ? ' class="mono" spellcheck="false"' : ''} autocomplete="off"${opts.disabled ? ' disabled' : ''}${opts.required ? ' aria-required="true"' : ''}`;
  const input = opts.area
    ? `<textarea ${common} rows="${String(opts.rows ?? 3)}">${esc(value)}</textarea>`
    : `<input ${common} value="${esc(value)}">`;
  const star = opts.required
    ? ` <span class="inc-acc-req" aria-hidden="true">*</span><span class="sr"> (${esc(opts.required)})</span>`
    : '';
  return `<div class="inc-acc-f${opts.area || opts.wide ? ' wide' : ''}"><label class="field" for="${id}"><span>${esc(label)}${star}</span>${input}</label>${opts.hint ? `<small id="${id}-h" class="mu">${esc(opts.hint)}</small>` : ''}</div>`;
}

const chip = (text: string, kind = ''): string =>
  `<li class="inc-acc-chip${kind ? ` ${kind}` : ''}">${esc(text)}</li>`;

function statusRow(ctx: ScopeContext, ui: AccessUi, view: ExplorationView): string {
  const t = TEXT[ctx.lang];
  const access = ctx.incident.access;
  const saved =
    access &&
    ((access.target ?? '').trim() !== '' || access.narrative.trim() !== '' || access.steps.length > 0);
  const location = view.location;
  const items = [
    saved ? chip(t.status.saved, 'ok') : chip(t.status.none),
    location?.chosen ? chip(t.status.located(location.chosen), 'ok') : '',
    location && access && location.locatedAt < access.updatedAt ? chip(t.status.stale, 'warn') : '',
    view.preparation
      ? view.preparation.reached
        ? chip(t.status.reached, 'ok')
        : chip(t.status.notReached, 'warn')
      : '',
    view.run ? chip(`${t.summaryExploration} : ${t.states[view.run.state]}`, view.live ? 'live' : 'ok') : '',
    access?.recording ? chip(t.status.recording(access.recording.name), 'ok') : '',
    access?.analysis ? chip(t.status.analysis) : '',
    accessDirty(ui, access) ? chip(t.dirty, 'warn') : '',
  ].join('');
  return `<ul class="inc-acc-status" role="list" aria-live="polite">${items}</ul>`;
}

function modePicker(ctx: ScopeContext, mode: AccessMode, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const options = ACCESS_MODES.map((key) => {
    const on = key === mode;
    return `<button type="button" role="radio" class="inc-acc-mode${on ? ' on' : ''}" id="inc-acc-mode-${key}" data-action="inc-acc-mode" data-mode="${key}" aria-checked="${String(on)}" tabindex="${on ? '0' : '-1'}"${disabled ? ' disabled' : ''}><b>${esc(t.modes[key])}${key === 'AUTO' ? ` <span class="inc-acc-chip ok">${esc(t.recommended)}</span>` : ''}</b><small class="mu">${esc(t.modeHints[key])}</small></button>`;
  }).join('');
  return `<div class="inc-acc-modes" role="radiogroup" aria-label="${esc(t.modesLabel)}">${options}</div>`;
}

function stepsEditor(ctx: ScopeContext, draft: AccessDraft, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const steps = draft.steps
    .map(
      (step, index) =>
        `<li class="inc-acc-step"><span class="inc-acc-n" aria-hidden="true">${String(index + 1)}</span><label class="sr" for="inc-acc-step-${String(index)}">${esc(t.step(index + 1))}</label><input id="inc-acc-step-${String(index)}" data-inc="acc.step.${String(index)}" value="${esc(step.text)}" autocomplete="off"${disabled ? ' disabled' : ''}>${
          disabled
            ? ''
            : `<button type="button" class="inc-acc-ib" data-action="inc-acc-step-up" data-index="${String(index)}" aria-label="${esc(t.stepUp(index + 1))}"${index === 0 ? ' disabled' : ''}>${icon('up')}</button><button type="button" class="inc-acc-ib" data-action="inc-acc-step-remove" data-index="${String(index)}" aria-label="${esc(t.stepRemove(index + 1))}">${icon('trash')}</button>`
        }</li>`,
    )
    .join('');
  return `<div class="inc-acc-f wide"><span class="inc-acc-l" id="inc-acc-steps-l">${esc(t.steps)}</span><small class="mu" id="inc-acc-steps-h">${esc(t.stepsHint)}</small><ol class="inc-acc-steps" role="list" aria-labelledby="inc-acc-steps-l" aria-describedby="inc-acc-steps-h">${steps}</ol>${disabled || draft.steps.length >= MAX_ACCESS_STEPS ? '' : `<button type="button" class="btn small" data-action="inc-acc-step-add">${icon('plus')}<span>${esc(t.addStep)}</span></button>`}</div>`;
}

function demoBlock(ctx: ScopeContext, ui: AccessUi, disabled: boolean, busy: string | undefined): string {
  const t = TEXT[ctx.lang];
  const session = ui.session;
  const record = disabled
    ? ''
    : `<section class="inc-acc-box" aria-labelledby="inc-acc-rec-t"><h3 id="inc-acc-rec-t">${icon('play')}<span>${esc(t.recordTitle)}</span></h3><p class="mu">${esc(t.recordText)}</p>${
        session
          ? `<p class="inc-acc-live" role="status"><span class="dot" aria-hidden="true"></span>${esc(t.recordRunning(session))}</p><div class="inc-acc-acts start"><button type="button" class="btn primary" data-action="inc-acc-rec-stop"${busy ? ' disabled' : ''}>${esc(t.recordStop)}</button><button type="button" class="btn ghost" data-action="nav" data-view="recordings">${esc(t.recordFollow)}</button></div>`
          : `<div class="inc-acc-acts start"><button type="button" class="btn" data-action="inc-acc-rec-start"${busy ? ' disabled' : ''}>${icon('play')}<span>${esc(t.recordStart)}</span></button></div>`
      }</section>`;
  const linked = ctx.incident.access?.recording?.name;
  const list = ui.recordings;
  const body =
    list === undefined
      ? `<button type="button" class="btn small" data-action="inc-acc-rec-load">${esc(t.recordingsLoad)}</button>`
      : list === 'loading'
        ? '<p class="mu"><span class="spin sm" aria-hidden="true"></span></p>'
        : !Array.isArray(list)
          ? `<p class="err" role="alert">${esc(list.error)}</p>`
          : list.length === 0
            ? `<p class="mu">${esc(t.recordingsEmpty)}</p>`
            : `<ul class="inc-acc-recs" role="list">${list
                .map((recording) => {
                  const on = recording.name === linked;
                  const meta = [
                    dateText(recording.startedAt, ctx.lang),
                    recording.status,
                    recording.summary ? t.recordingSteps(recording.summary.steps) : '',
                    recording.summary?.replay ?? '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const action = disabled
                    ? ''
                    : on
                      ? `<button type="button" class="btn small ghost" data-action="inc-acc-rec-unlink"${busy ? ' disabled' : ''}>${esc(t.unlink)}</button>`
                      : `<button type="button" class="btn small" data-action="inc-acc-rec-link" data-block="${esc(recording.name)}"${busy || (recording.status !== 'STORED' && recording.status !== 'COMPLETED') ? ' disabled' : ''}>${esc(t.link)}</button>`;
                  return `<li class="inc-acc-rec${on ? ' on' : ''}"><div><b>${esc(recording.name)}</b>${on ? ` <span class="inc-acc-chip ok">${esc(t.linked)}</span>` : ''}<small class="mu block">${esc(meta)}</small></div>${action}</li>`;
                })
                .join(
                  '',
                )}</ul><button type="button" class="btn small ghost" data-action="inc-acc-rec-load">${esc(t.recordingsRefresh)}</button>`;
  return `${record}<section class="inc-acc-box" aria-labelledby="inc-acc-recs-t"><h3 id="inc-acc-recs-t">${icon('library')}<span>${esc(t.recordingsTitle)}</span></h3>${body}</section>`;
}

function actionBar(
  ctx: ScopeContext,
  ui: AccessUi,
  draft: AccessDraft,
  view: ExplorationView,
  busy: string | undefined,
): string {
  const t = TEXT[ctx.lang];
  const dirty = accessDirty(ui, ctx.incident.access);
  const idle = busy === undefined;
  // « Localiser » reste actif : la saisie n'est pas redessinée pendant la frappe (le focus reste dans le
  // champ), elle est enregistrée d'abord et le serveur dit ce qui manque.
  const hasTarget = draft.target.trim() !== '' || draft.url.trim() !== '';
  const located = view.location?.chosen !== undefined && view.location.path.length > 0;
  const ready = canExplore(ctx.incident);
  const running = triggerActive(ctx.incident);
  const reason = !hasTarget
    ? t.needTarget
    : !located
      ? t.needLocation
      : running
        ? t.running
        : !ready
          ? t.needReached
          : t.actionsHint;
  const spin = (key: string, ic: string): string =>
    busy === key ? '<span class="spin sm" aria-hidden="true"></span>' : icon(ic);
  const depth = `<label class="inc-acc-depth" for="inc-acc-depth"><span>${esc(t.depth)}</span><select id="inc-acc-depth" data-inc="acc.depth"${idle ? '' : ' disabled'}>${TRIGGER_DEPTHS.map((key) => `<option value="${key}"${key === ui.depth ? ' selected' : ''}>${esc(t.depths[key])}</option>`).join('')}</select></label>`;
  return `<div class="inc-acc-foot"><small class="mu" id="inc-acc-why">${esc(reason)}</small><div class="inc-acc-acts">${dirty ? `<button type="button" class="btn ghost" data-action="inc-acc-reset"${idle ? '' : ' disabled'}>${esc(t.reset)}</button>` : ''}<button type="button" class="btn${dirty ? '' : ' ghost'}" data-action="inc-acc-save"${idle ? '' : ' disabled'}>${spin('inc-acc-save', 'check')}<span>${esc(t.save)}</span></button><button type="button" class="btn${located ? '' : ' primary'}" data-action="inc-acc-locate" aria-describedby="inc-acc-why" aria-busy="${String(busy === 'inc-acc-locate')}"${idle ? '' : ' disabled'}>${spin('inc-acc-locate', 'search')}<span>${esc(t.locate)}</span></button><button type="button" class="btn${located && !view.preparation?.reached ? ' primary' : ''}" data-action="inc-acc-prepare" aria-describedby="inc-acc-why" aria-busy="${String(busy === 'inc-acc-prepare')}"${idle && located && !running ? '' : ' disabled'}>${spin('inc-acc-prepare', 'eye')}<span>${esc(t.prepare)}</span></button>${depth}<button type="button" class="btn${ready ? ' primary' : ''}" data-action="inc-acc-explore" aria-describedby="inc-acc-why" aria-busy="${String(busy === 'inc-acc-explore')}"${idle && ready ? '' : ' disabled'}>${spin('inc-acc-explore', 'play')}<span>${esc(t.explore)}</span></button></div></div>`;
}

function candidateRow(ctx: ScopeContext, candidate: TargetCandidate, chosen: boolean, can: boolean): string {
  const t = TEXT[ctx.lang];
  return `<li class="inc-acc-scr${chosen ? ' on' : ''}"><div class="inc-acc-cand-h"><b class="mono">${esc(candidate.route)}</b>${candidate.component ? `<span class="inc-acc-pill">${esc(candidate.component)}</span>` : ''}<span class="inc-acc-conf">${esc(percent(candidate.confidence))}</span>${chosen ? `<span class="inc-acc-chip ok">${esc(t.chosen)}</span>` : ''}${candidate.nameOnly ? `<span class="inc-acc-chip warn">${esc(t.nameOnly)}</span>` : ''}${candidate.guards.length > 0 ? `<span class="inc-acc-chip warn">${esc(t.guarded(candidate.guards.join(', ')))}</span>` : ''}</div><ul class="inc-acc-ev" role="list">${candidate.evidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>${
    !chosen && can
      ? `<button type="button" class="btn small" data-action="inc-acc-choose" data-block="${esc(candidate.route)}">${esc(t.choose)}</button>`
      : ''
  }</li>`;
}

function locationBlock(ctx: ScopeContext, location: TargetLocation, can: boolean): string {
  const t = TEXT[ctx.lang];
  const candidates =
    location.candidates.length > 0
      ? `<ul class="inc-acc-scrs" role="list">${location.candidates.map((candidate) => candidateRow(ctx, candidate, candidate.route === location.chosen, can)).join('')}</ul>`
      : `<p class="mu">${esc(t.noCandidate)}</p>`;
  const path =
    location.path.length > 0
      ? `<ol class="inc-acc-path" role="list">${location.path.map((step) => `<li><span class="inc-acc-pill act">${esc(step.kind === 'NAVIGATE' ? t.actions.NAVIGATE : t.actions.CLICK)}</span><span>${esc(step.label)}</span> <code>${esc(step.route)}</code><small class="inc-acc-src">${esc(t.pathSources[step.source] ?? step.source)}${step.evidence ? ` · ${esc(step.evidence)}` : ''}</small></li>`).join('')}</ol>`
      : '';
  return `<section class="inc-acc-sub" aria-labelledby="inc-acc-loc-t"><h4 id="inc-acc-loc-t">${esc(t.candidatesTitle)}</h4>${candidates}${path ? `<h4 id="inc-acc-path-found">${esc(t.pathTitle)}</h4>${path}` : ''}${limitsList(t.limits, location.limits, 'inc-acc-loc-lim')}</section>`;
}

function limitsList(title: string, items: readonly string[], id: string): string {
  return items.length > 0
    ? `<div class="inc-acc-lims"><h4 id="${id}">${esc(title)}</h4><ul class="plain" role="list" aria-labelledby="${id}">${items.map((item) => `<li>${icon('info')} ${esc(item)}</li>`).join('')}</ul></div>`
    : '';
}

function preparationBlock(ctx: ScopeContext, preparation: TargetPreparation): string {
  const t = TEXT[ctx.lang];
  const inventory = preparation.inventory;
  const count = (label: string, items: readonly string[]): string =>
    `<li><b>${String(items.length)}</b> ${esc(label)}${items.length > 0 ? `<small class="mu block">${esc(items.slice(0, 8).join(', '))}${items.length > 8 ? ' …' : ''}</small>` : ''}</li>`;
  const steps = `<ol class="inc-acc-path" role="list">${preparation.steps.map((step) => `<li class="${step.ok ? 'ok' : 'ko'}">${icon(step.ok ? 'check' : 'cross')} <span>${esc(step.summary)}</span>${step.error ? ` <small class="err">${esc(step.error)}</small>` : ''}</li>`).join('')}</ol>`;
  return `<section class="inc-acc-sub inc-acc-prep${preparation.reached ? ' ok' : ' ko'}" aria-labelledby="inc-acc-prep-t"><h4 id="inc-acc-prep-t">${icon(preparation.reached ? 'check' : 'alert')} ${esc(preparation.reached ? t.prepTitle : t.prepFailed)} <code>${esc(preparation.finalUrl || preparation.route)}</code> <small class="mu">${esc(dateText(preparation.preparedAt, ctx.lang))} · ${esc(durationText(preparation.durationMs, ctx.lang))}</small></h4><div class="inc-acc-cols"><div><h4>${esc(t.prepSteps)}</h4>${steps}${preparation.screenshot ? `<small class="mu block">${esc(t.shot(preparation.screenshot))}</small>` : ''}<small class="mu block">${esc(t.prepRequests(preparation.requests.length))}</small></div><div><h4>${esc(t.inventory)}</h4><ul class="inc-acc-inv" role="list">${count(t.inv.buttons, inventory.buttons)}${count(t.inv.fields, inventory.fields)}${count(t.inv.links, inventory.links)}${count(t.inv.selects, inventory.selects)}${count(t.inv.disabled, inventory.disabled)}<li><b>${String(inventory.dialogs)}</b> ${esc(t.inv.dialogs)}</li></ul></div></div>${limitsList(t.prepErrors, preparation.errors, 'inc-acc-prep-err')}${limitsList(t.blockers, preparation.blockers, 'inc-acc-prep-blk')}</section>`;
}

function progressBlock(
  ctx: ScopeContext,
  ui: AccessUi,
  view: ExplorationView,
  busy: string | undefined,
): string {
  const t = TEXT[ctx.lang];
  const phases = `<ol class="inc-acc-phases" role="list">${view.phases.map((phase) => `<li class="inc-acc-ph ${phase.status}"><span class="inc-acc-dot" aria-hidden="true">${phase.status === 'done' ? icon('check') : phase.status === 'failed' ? icon('cross') : phase.status === 'current' ? '<span class="spin sm"></span>' : ''}</span><span>${esc(t.phases[phase.key])}</span><span class="sr"> : ${esc(t.phaseStatus[phase.status])}</span></li>`).join('')}</ol>`;
  const counters = view.counters;
  const run = view.run;
  const stats = counters
    ? `<dl class="inc-acc-stats"><div><dt>${esc(t.counters.sequences)}</dt><dd>${String(counters.sequences)}</dd></div><div><dt>${esc(t.counters.states)}</dt><dd>${counters.states ? `${String(counters.states.explored)} / ${String(counters.states.known)}` : '—'}</dd></div><div><dt>${esc(t.counters.anomalies)}</dt><dd>${String(counters.anomalies)}</dd></div><div><dt>${esc(t.counters.duration)}</dt><dd>${esc(durationText(counters.durationMs, ctx.lang))}</dd></div><div class="wide"><dt>${esc(t.counters.lastAction)}</dt><dd>${esc(counters.lastAction ?? '—')}</dd></div><div class="wide"><dt>${esc(t.counters.remaining)}</dt><dd>${esc(t.remaining(counters.remainingTrials, durationText(counters.remainingMs, ctx.lang)))}</dd></div></dl>`
    : '';
  const can = accessEditable(ctx) && busy === undefined;
  const controls =
    run && ACTIVE_TRIGGER_STATES.includes(run.state)
      ? `<div class="inc-acc-acts start">${
          run.state === 'PAUSED'
            ? `<button type="button" class="btn" data-action="inc-acc-resume"${can ? '' : ' disabled'}>${icon('play')}<span>${esc(t.resume)}</span></button>`
            : `<button type="button" class="btn" data-action="inc-acc-pause"${can ? '' : ' disabled'}>${icon('pause')}<span>${esc(t.pause)}</span></button>`
        }${
          ui.confirmCancel
            ? `<div class="inc-acc-confirm" role="group" aria-label="${esc(t.cancel)}"><p>${esc(t.cancelConfirm)}</p><button type="button" class="btn ghost" data-action="inc-acc-cancel-no">${esc(t.cancelNo)}</button><button type="button" class="btn danger" data-action="inc-acc-cancel-yes"${can ? '' : ' disabled'}>${esc(t.cancelYes)}</button></div>`
            : `<button type="button" class="btn danger" data-action="inc-acc-cancel"${can ? '' : ' disabled'}>${icon('stop')}<span>${esc(t.cancel)}</span></button>`
        }</div>`
      : '';
  return `<section class="inc-acc-sub inc-acc-prog" aria-labelledby="inc-acc-prog-t"><h4 id="inc-acc-prog-t">${esc(t.progress)}${run ? ` <span class="inc-acc-chip${view.live ? ' live' : ''}">${esc(t.states[run.state])}</span>` : ''}</h4><div class="inc-acc-cols"><div>${phases}</div><div>${stats}${controls}</div></div></section>`;
}

function resultsBlock(ctx: ScopeContext, view: ExplorationView): string {
  const run = view.run;
  if (!run || ACTIVE_TRIGGER_STATES.includes(run.state)) return '';
  const t = TEXT[ctx.lang];
  const minimal = run.minimal;
  const repeats = view.repeats;
  const confirmation = !minimal
    ? `<p class="note">${icon('info')}<span>${esc(t.noReproduction)}</span></p>`
    : repeats && repeats.reproduced >= 2
      ? `<p class="inc-acc-okline">${icon('check')}<span>${esc(t.confirmedNote(repeats.reproduced, repeats.total))}</span></p>`
      : `<p class="note">${icon('info')}<span>${esc(t.singleNote)}</span></p>`;
  const sequence = minimal
    ? `<div><h4>${esc(t.sequence)} <small class="mu">${esc(t.frequency(minimal.frequency.reproduced, minimal.frequency.total))}</small></h4><ol class="inc-acc-path" role="list">${minimal.actions
        .slice(run.entry?.actions.length ?? 0)
        .map((action) => `<li><span>${esc(actionText(action, ctx.lang))}</span></li>`)
        .join(
          '',
        )}</ol>${minimal.preconditions.length > 0 ? `<small class="mu block">${esc(t.preconditions)} : ${esc(minimal.preconditions.join(' ; '))}</small>` : ''}</div>`
    : '';
  const conditions = run.conditions.filter((condition) => condition.role !== 'REFUTED');
  const ratio = (value: { reproduced: number; total: number }): string =>
    `${String(value.reproduced)}/${String(value.total)}`;
  const conditionsHtml =
    conditions.length > 0
      ? `<div><h4>${esc(t.conditionsTitle)}</h4><ul class="inc-acc-ev" role="list">${conditions.map((condition) => `<li><span class="inc-acc-pill act">${esc(t.roles[condition.role] ?? condition.role)}</span>${esc(condition.description)} <small class="mu">${esc(t.withWithout(ratio(condition.withCondition), ratio(condition.withoutCondition)))}</small></li>`).join('')}</ul></div>`
      : '';
  const first = run.firstFailure;
  const evidence = first
    ? [
        first.firstError ? [t.firstError, first.firstError.summary] : undefined,
        first.firstFailedAction ? [t.firstFailed, first.firstFailedAction.summary] : undefined,
        first.lastSuccessfulRequest ? [t.lastRequest, first.lastSuccessfulRequest.summary] : undefined,
        ...first.onlyInFailing.slice(0, 3).map((item) => [t.onlyFailing, item.summary]),
      ].filter((item): item is string[] => item !== undefined)
    : [];
  const evidenceHtml =
    evidence.length > 0
      ? `<div><h4>${esc(t.evidence)}</h4><ul class="inc-acc-ev" role="list">${evidence.map(([label, value]) => `<li><b>${esc(label ?? '')}</b> : <code>${esc(value ?? '')}</code></li>`).join('')}</ul></div>`
      : '';
  const hypotheses = ctx.incident.investigation.hypotheses.filter((hypothesis) =>
    run.hypothesisIds.includes(hypothesis.id),
  );
  const chosen = view.location?.candidates.find((candidate) => candidate.route === view.location?.chosen);
  const suspects = `<div><h4>${esc(t.suspects)}</h4>${
    hypotheses.length > 0
      ? `<ul class="inc-acc-ev" role="list">${hypotheses
          .map(
            (hypothesis) =>
              `<li><b>${esc(hypothesis.title)}</b> <span class="inc-acc-chip">${esc(t.hypoStatus[hypothesis.status] ?? hypothesis.status)}</span> <span class="inc-acc-conf">${esc(t.confidence)} ${esc(percent(hypothesis.confidence))}</span>${
                hypothesis.files.length > 0
                  ? `<small class="mu block">${hypothesis.files
                      .slice(0, 3)
                      .map((file) => `<code>${esc(file)}</code>`)
                      .join(' ')}</small>`
                  : ''
              }</li>`,
          )
          .join('')}</ul>`
      : `<p class="mu">${esc(t.noSuspect)}</p>`
  }${chosen ? `<small class="mu block">${esc(t.locConfidence(percent(chosen.confidence)))}</small>` : ''}</div>`;
  const reco = [
    run.pendingExperimentIds.length > 0 ? t.recoPending(run.pendingExperimentIds.length) : '',
    hypotheses.length > 0 ? t.recoHypotheses : '',
    !minimal ? t.recoDeeper : '',
  ].filter(Boolean);
  const links = `<div class="inc-acc-acts start">${minimal ? `<button type="button" class="btn small" data-action="ws-ux-tab" data-tab="tminimal">${esc(t.openMinimal)}</button>` : ''}<button type="button" class="btn small ghost" data-action="ws-ux-tab" data-tab="tcauses">${esc(t.openCauses)}</button>${hypotheses.length > 0 ? `<button type="button" class="btn small ghost" data-action="ws-ux-tab" data-tab="hypotheses">${esc(t.openHypotheses)}</button>` : ''}</div>`;
  return `<section class="inc-acc-sub inc-acc-out" aria-labelledby="inc-acc-out-t"><h4 id="inc-acc-out-t">${icon('explorations')} ${esc(t.results)}</h4>${confirmation}<div class="inc-acc-cols">${sequence}${conditionsHtml}</div><div class="inc-acc-cols">${evidenceHtml}${suspects}</div>${reco.length > 0 ? `<div><h4>${esc(t.recoTitle)}</h4><ul class="plain" role="list">${reco.map((item) => `<li>${icon('right')} ${esc(item)}</li>`).join('')}</ul></div>` : ''}${links}${limitsList(t.limits, run.limitations.slice(0, 6), 'inc-acc-run-lim')}</section>`;
}

function candidateItem(ctx: ScopeContext, candidate: AccessCandidate, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const extension = disabled ? undefined : extensionFor(candidate);
  const blocked =
    candidate.status === 'DENIED' || candidate.status === 'INACCESSIBLE' || candidate.status === 'PROPOSED';
  return `<li class="inc-acc-cand${candidate.match === 'MATCHED' ? ' hit' : ''}"><div class="inc-acc-cand-h"><span class="inc-acc-pill">${esc(candidate.kind)}</span><b>${esc(candidate.label)}</b><span class="inc-acc-conf" title="${esc(percent(candidate.confidence))}">${esc(percent(candidate.confidence))}</span>${candidate.transversal ? `<span class="inc-acc-chip">${esc(t.transversal)}</span>` : ''}${blocked ? `<span class="inc-acc-chip warn">${esc(t.outOfScope)}</span>` : ''}</div><code class="inc-acc-ref" title="${esc(candidate.ref)}">${esc(candidate.ref)}</code>${candidate.reasons.length > 0 ? `<small class="mu block">${esc(candidate.reasons.join(' · '))}</small>` : ''}${
    extension
      ? `<button type="button" class="btn small" data-action="inc-acc-ext" data-block="${esc(candidate.id)}">${esc(t.extension)}</button>`
      : ''
  }</li>`;
}

function analysisBlock(ctx: ScopeContext, analysis: AccessAnalysis, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  const path = `<ol class="inc-acc-path" role="list">${analysis.path
    .map(
      (step) =>
        `<li${step.critical ? ' class="critical"' : ''}><span class="inc-acc-pill act">${esc(t.actions[step.action])}</span><span>${esc(step.text)}</span>${step.target ? ` <code>${esc(step.target)}</code>` : ''}${step.element ? ` <small class="mu">${esc(t.elements[step.element])}</small>` : ''}<small class="inc-acc-src">${esc(t.sources[step.source] ?? step.source)}</small>${step.critical ? `<span class="inc-acc-chip warn">${esc(t.critical)}</span>` : ''}</li>`,
    )
    .join('')}</ol>`;
  const interpretations = analysis.interpretations.length
    ? `<ul class="inc-acc-int" role="list">${analysis.interpretations
        .map(
          (item) =>
            `<li><small class="mu">${esc(t.kinds[item.kind] ?? item.kind)}</small><b>${esc(item.kind === 'ACTION' ? ((ACCESS_ACTION_KINDS as readonly string[]).includes(item.value) ? t.actions[item.value as AccessActionKind] : item.value) : item.value)}</b><span class="inc-acc-conf">${esc(percent(item.confidence))}</span></li>`,
        )
        .join('')}</ul>`
    : '';
  const matched = analysis.candidates.filter((item) => item.match === 'MATCHED');
  const uncertain = analysis.candidates.filter((item) => item.match === 'UNCERTAIN');
  const group = (title: string, items: AccessCandidate[]): string =>
    items.length > 0
      ? `<h4>${esc(title)} (${String(items.length)})</h4><ul class="inc-acc-cands" role="list">${items.map((item) => candidateItem(ctx, item, disabled)).join('')}</ul>`
      : '';
  const candidates =
    analysis.candidates.length > 0
      ? `${group(t.matchedTitle, matched)}${group(t.uncertainTitle, uncertain)}`
      : `<p class="mu">${esc(t.noCandidates)}</p>`;
  const leads =
    analysis.leads.length > 0
      ? `<section class="inc-acc-sub" aria-labelledby="inc-acc-leads-t"><h4 id="inc-acc-leads-t">${esc(t.leads)}</h4><p class="mu">${esc(t.leadsNote)}</p><ul class="inc-acc-leads" role="list">${analysis.leads
          .map(
            (lead) =>
              `<li><b>${esc(lead.label)}</b><span>${esc(lead.why)}</span><small class="mu block">${lead.refs.length > 0 ? lead.refs.map((ref) => `<code>${esc(ref)}</code>`).join(' ') : esc(t.noRefs)}</small></li>`,
          )
          .join('')}</ul></section>`
      : '';
  const anomalies =
    analysis.anomalies.length > 0
      ? `<p class="mu"><b>${esc(t.anomalies)} :</b> ${analysis.anomalies.map((kind) => `<code>${esc(kind)}</code>`).join(' ')}</p>`
      : '';
  return `<section class="inc-acc-res" aria-labelledby="inc-acc-res-t"><h3 id="inc-acc-res-t">${icon('explorations')}<span>${esc(t.analysis)}</span> <small class="mu">${esc(analysis.sources.map((source) => t.sources[source] ?? source).join(' + '))}</small></h3><div class="inc-acc-cols"><section class="inc-acc-sub" aria-labelledby="inc-acc-path-t"><h4 id="inc-acc-path-t">${esc(t.path)}</h4>${path}${anomalies}</section><section class="inc-acc-sub" aria-labelledby="inc-acc-int-t"><h4 id="inc-acc-int-t">${esc(t.interpretations)}</h4>${interpretations}</section></div><section class="inc-acc-sub" aria-labelledby="inc-acc-cand-t"><h4 id="inc-acc-cand-t" class="inc-acc-h4">${esc(t.candidates)}</h4>${candidates}</section>${leads}${limitsList(t.analysisLimits, analysis.limits, 'inc-acc-lim-t')}</section>`;
}

/** La carte complète (étape Périmètre). */
export function renderAccess(ctx: ScopeContext, ui: AccessUi, opts: { busy?: string } = {}): string {
  const t = TEXT[ctx.lang];
  const editable = accessEditable(ctx);
  const busy = opts.busy;
  const disabled = !editable || busy !== undefined;
  const note = ctx.demo
    ? `<p class="note">${icon('info')}<span>${esc(t.demoNote)}</span></p>`
    : !editable
      ? `<p class="note">${icon('info')}<span>${esc(t.readOnly)}</span></p>`
      : '';
  const draft = ui.draft ?? draftOf(ctx.incident.access);
  const view = explorationView(ctx.incident, ctx.lang, busy);
  const fields = `<div class="inc-acc-grid">${textField('target', t.target, draft.target, { hint: t.targetHint, disabled, required: t.required })}${textField('url', t.url, draft.url, { hint: t.urlHint, mono: true, disabled })}${textField('hints', t.hints, draft.hints, { hint: t.hintsHint, disabled, wide: true })}${textField('narrative', t.narrative, draft.narrative, { area: true, rows: 3, hint: t.narrativeHint, placeholder: t.narrativePlaceholder, disabled })}</div>`;
  const byMode =
    draft.mode === 'GUIDED'
      ? `<div class="inc-acc-grid">${stepsEditor(ctx, draft, disabled)}</div>`
      : draft.mode === 'DEMO'
        ? demoBlock(ctx, ui, !editable, busy)
        : '';
  const more = `<div class="inc-acc-more"><button type="button" class="inc-acc-toggle" data-action="inc-acc-more" aria-expanded="${String(ui.more === true)}"${ui.more ? ' aria-controls="inc-acc-more-p"' : ''}>${icon(ui.more ? 'down' : 'right')}<span>${esc(t.more)}</span></button>${
    ui.more
      ? `<div id="inc-acc-more-p" class="inc-acc-grid">${textField('start', t.start, draft.start, { hint: t.startHint, disabled })}${textField('expected', t.expected, draft.expected, { disabled })}${textField('observed', t.observed, draft.observed, { disabled })}${textField('conditions', t.conditions, draft.conditions, { disabled })}${textField('testData', t.testData, draft.testData, { area: true, rows: 2, hint: t.testDataHint, disabled })}${draft.mode === 'GUIDED' ? '' : stepsEditor(ctx, draft, disabled)}</div>`
      : ''
  }</div>`;
  const access = ctx.incident.access;
  const actions = editable ? actionBar(ctx, ui, draft, view, busy) : '';
  const located = view.location ? locationBlock(ctx, view.location, editable && busy === undefined) : '';
  const prepared = view.preparation ? preparationBlock(ctx, view.preparation) : '';
  const started = view.location || view.run ? progressBlock(ctx, ui, view, busy) : '';
  const results = resultsBlock(ctx, view);
  const analyze = editable
    ? `<div class="inc-acc-acts start"><button type="button" class="btn small ghost" data-action="inc-acc-analyze" aria-busy="${String(busy === 'inc-acc-analyze')}"${busy === undefined ? '' : ' disabled'}>${busy === 'inc-acc-analyze' ? '<span class="spin sm" aria-hidden="true"></span>' : icon('code')}<span>${esc(t.analyze)}</span></button></div>`
    : '';
  const analysis = access?.analysis ? analysisBlock(ctx, access.analysis, disabled) : '';
  return `<section class="card wide inc-acc" aria-labelledby="inc-acc-t"><div class="inc-acc-head"><span class="inc-acc-ic" aria-hidden="true">${icon('explorations')}</span><div><h2 id="inc-acc-t" class="fl">${esc(t.title)}</h2><p class="mu">${esc(t.sub)}</p></div></div>${note}${statusRow(ctx, ui, view)}${modePicker(ctx, draft.mode, disabled)}${fields}${byMode}${more}${actions}${started}${located}${prepared}${results}<p class="mu inc-acc-entry">${icon('info')}<span>${esc(t.entry)}</span></p>${analyze}${analysis}</section>`;
}

/** Le résumé du scénario d'accès (Résumé de l'incident, Reproduction) : rien quand il n'existe pas. */
export function renderAccessSummary(
  lang: Lang,
  access: IncidentAccess | undefined,
  incident?: Pick<Incident, 'access' | 'investigation'>,
): string {
  if (
    !access ||
    ((access.target ?? '').trim() === '' &&
      access.narrative.trim() === '' &&
      access.steps.length === 0 &&
      !access.recording)
  )
    return '';
  const t = TEXT[lang];
  const steps =
    access.steps.length > 0
      ? `<ol class="inc-acc-mini" role="list">${access.steps.map((step) => `<li>${esc(step.text)}</li>`).join('')}</ol>`
      : '';
  const run = incident ? explorationRun(incident) : undefined;
  const meta = [
    access.target
      ? `${t.summaryScreen} : ${access.target}${access.location?.chosen ? ` (${access.location.chosen})` : ''}`
      : '',
    access.hints ? `${t.summaryHints} : ${access.hints}` : '',
    access.start ? `${t.start} : ${access.start}` : '',
    access.url ? `${t.url} : ${access.url}` : '',
    access.preparation ? (access.preparation.reached ? t.status.reached : t.status.notReached) : '',
    run ? `${t.summaryExploration} : ${t.states[run.state]}` : '',
    access.recording ? t.status.recording(access.recording.name) : '',
  ]
    .filter(Boolean)
    .map((line) => `<li>${esc(line)}</li>`)
    .join('');
  const critical = access.analysis?.path.find((step) => step.critical);
  return `<section class="card wide inc-acc-sum" aria-labelledby="inc-acc-sum-t"><h2 id="inc-acc-sum-t" class="fl">${icon('explorations')}<span>${esc(t.summaryTitle)}</span></h2>${access.narrative ? `<p>${esc(access.narrative)}</p>` : ''}${steps}${meta ? `<ul class="plain mu" role="list">${meta}</ul>` : ''}${critical ? `<p><span class="inc-acc-chip warn">${esc(t.critical)}</span> ${esc(critical.text)}</p>` : ''}</section>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

export const INCIDENT_ACCESS_CSS = `
.inc-acc{display:flex;flex-direction:column;gap:12px;min-width:0}
.inc-acc-head{display:flex;align-items:flex-start;gap:12px}
.inc-acc-head h2{margin:0;font-size:18px}
.inc-acc-head p{margin:2px 0 0}
.inc-acc-ic{width:40px;height:40px;border-radius:10px;background:var(--qa-color-primary-soft);color:var(--qa-color-primary);display:grid;place-items:center;flex:none}
.inc-acc-ic .ico{width:22px;height:22px}
.inc-acc-status{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.inc-acc-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.inc-acc-chip.ok{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft);border-color:color-mix(in srgb,var(--qa-color-primary) 25%,var(--qa-color-border))}
.inc-acc-chip.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft);border-color:color-mix(in srgb,var(--qa-color-warning) 30%,var(--qa-color-border))}
.inc-acc-chip.live{color:var(--qa-color-primary);background:var(--qa-color-surface)}
.inc-acc-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.inc-acc-mode{display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;padding:10px 12px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;cursor:pointer;min-width:0}
.inc-acc-mode b{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13.5px}
.inc-acc-mode small{font-size:12px;line-height:1.4}
.inc-acc-mode:hover:not(:disabled){border-color:var(--qa-color-primary)}
.inc-acc-mode.on{border-color:var(--qa-color-primary);background:var(--qa-color-primary-soft-2);box-shadow:inset 0 0 0 1px var(--qa-color-primary)}
.inc-acc-mode:disabled{cursor:default;opacity:.75}
.inc-acc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;align-items:start}
.inc-acc-f{display:flex;flex-direction:column;gap:4px;min-width:0}
.inc-acc-f.wide{grid-column:1 / -1}
.inc-acc-req{color:var(--qa-color-danger)}
.inc-acc-l{font-size:13px;font-weight:600}
.inc-acc-steps{list-style:none;margin:4px 0;padding:0;display:flex;flex-direction:column;gap:6px}
.inc-acc-step{display:flex;align-items:center;gap:6px;min-width:0}
.inc-acc-step>input{flex:1 1 auto;min-width:0;min-height:var(--qa-control,36px);border-radius:8px;border:1px solid var(--qa-color-border-strong);padding:4px 10px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit}
.inc-acc-n{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--qa-color-primary-soft);color:var(--qa-color-primary-2);flex:none}
.inc-acc-ib{width:32px;height:32px;display:inline-grid;place-items:center;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-muted);cursor:pointer;padding:0;flex:none}
.inc-acc-ib:hover:not(:disabled){color:var(--qa-color-text);border-color:var(--qa-color-primary)}
.inc-acc-ib:disabled{opacity:.45;cursor:default}
.inc-acc-ib .ico{width:15px;height:15px}
.inc-acc-more{display:flex;flex-direction:column;gap:10px}
.inc-acc-toggle{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--qa-color-primary-2);font:inherit;font-weight:600;cursor:pointer;padding:2px 0}
.inc-acc-toggle .ico{width:14px;height:14px}
.inc-acc-acts{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center}
.inc-acc-acts.start{justify-content:flex-start}
.inc-acc-depth{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.inc-acc-depth select{min-height:var(--qa-control,36px);border-radius:8px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;padding:0 8px}
.inc-acc-box{border:1px solid var(--qa-color-border);border-radius:10px;padding:12px 14px;background:var(--qa-color-surface);display:flex;flex-direction:column;gap:8px;min-width:0}
.inc-acc-box h3,.inc-acc-res h3{margin:0;font-size:15px;display:flex;align-items:center;gap:8px}
.inc-acc-box h3 .ico,.inc-acc-res h3 .ico{width:18px;height:18px;color:var(--qa-color-primary)}
.inc-acc-box p{margin:0}
.inc-acc-live{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--qa-color-primary-2)}
.inc-acc-recs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.inc-acc-rec{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:8px;min-width:0}
.inc-acc-rec>div{min-width:0;overflow-wrap:anywhere}
.inc-acc-rec.on{border-color:color-mix(in srgb,var(--qa-color-primary) 40%,var(--qa-color-border));background:var(--qa-color-primary-soft-2)}
.inc-acc-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--qa-color-border)}
.inc-acc-foot>small{flex:1 1 260px;min-width:0}
.inc-acc-entry{display:flex;align-items:flex-start;gap:6px;margin:0;font-size:12.5px}
.inc-acc-entry .ico{width:14px;height:14px;flex:none;margin-top:2px}
.inc-acc-res{display:flex;flex-direction:column;gap:12px;padding-top:12px;border-top:1px solid var(--qa-color-border);min-width:0}
.inc-acc-cols{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:12px}
.inc-acc-cols>*{min-width:0}
.inc-acc-sub{display:flex;flex-direction:column;gap:6px;min-width:0}
.inc-acc-sub h4{margin:0;font-size:13px;font-weight:600;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.inc-acc-sub h4 .ico{width:15px;height:15px;color:var(--qa-color-primary)}
.inc-acc-prog,.inc-acc-prep,.inc-acc-out{border:1px solid var(--qa-color-border);border-radius:10px;padding:12px 14px;background:var(--qa-color-surface)}
.inc-acc-prep.ko h4:first-child .ico{color:var(--qa-color-warning)}
.inc-acc-phases{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.inc-acc-ph{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--qa-color-muted)}
.inc-acc-ph.done{color:var(--qa-color-text)}
.inc-acc-ph.current{color:var(--qa-color-primary-2);font-weight:600}
.inc-acc-ph.failed{color:color-mix(in srgb,var(--qa-color-danger) 80%,var(--qa-color-text))}
.inc-acc-dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);flex:none}
.inc-acc-ph.done .inc-acc-dot{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:var(--qa-color-surface)}
.inc-acc-ph.failed .inc-acc-dot{border-color:var(--qa-color-danger);color:var(--qa-color-danger)}
.inc-acc-ph.current .inc-acc-dot{border-color:var(--qa-color-primary)}
.inc-acc-dot .ico{width:12px;height:12px}
.inc-acc-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0 0 10px}
.inc-acc-stats>div{border:1px solid var(--qa-color-border);border-radius:8px;padding:6px 10px;min-width:0}
.inc-acc-stats>div.wide{grid-column:1 / -1}
.inc-acc-stats dt{font-size:11.5px;color:var(--qa-color-muted)}
.inc-acc-stats dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.inc-acc-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.inc-acc-confirm p{margin:0;flex-basis:100%}
.inc-acc-scrs{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
.inc-acc-scr{border:1px solid var(--qa-color-border);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;min-width:0}
.inc-acc-scr.on{border-color:color-mix(in srgb,var(--qa-color-primary) 45%,var(--qa-color-border));background:var(--qa-color-primary-soft-2)}
.inc-acc-scr .btn{align-self:flex-start}
.inc-acc-ev{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12.5px}
.inc-acc-ev li{overflow-wrap:anywhere}
.inc-acc-inv{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
.inc-acc-inv li{overflow-wrap:anywhere}
.inc-acc-lims h4{margin:4px 0}
.inc-acc-lims li{overflow-wrap:anywhere}
.inc-acc-okline{display:flex;align-items:flex-start;gap:6px;margin:0;font-weight:600;color:var(--qa-color-primary-2)}
.inc-acc-okline .ico{width:16px;height:16px;flex:none;margin-top:2px}
.inc-acc-path{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
.inc-acc-path li{overflow-wrap:anywhere}
.inc-acc-path li.critical{font-weight:600}
.inc-acc-path li.ok .ico{width:13px;height:13px;color:var(--qa-color-primary)}
.inc-acc-path li.ko .ico{width:13px;height:13px;color:var(--qa-color-danger)}
.inc-acc-src{margin-left:6px;color:var(--qa-color-faint);font-size:11.5px}
.inc-acc-pill{display:inline-block;padding:0 8px;margin-right:6px;border-radius:6px;font-size:11.5px;font-weight:600;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);color:var(--qa-color-muted)}
.inc-acc-pill.act{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft)}
.inc-acc-int{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.inc-acc-int li{display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr) auto;gap:8px;align-items:baseline}
.inc-acc-conf{font-variant-numeric:tabular-nums;font-size:12px;color:var(--qa-color-muted)}
.inc-acc-cands{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
.inc-acc-cand{border:1px solid var(--qa-color-border);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;min-width:0}
.inc-acc-cand.hit{border-color:color-mix(in srgb,var(--qa-color-primary) 35%,var(--qa-color-border))}
.inc-acc-cand-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.inc-acc-cand-h b{overflow-wrap:anywhere}
.inc-acc-cand .btn{align-self:flex-start}
.inc-acc-ref{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:transparent;border:0;padding:0;color:var(--qa-color-muted)}
.inc-acc-leads{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.inc-acc-leads li{display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.inc-acc-mini{margin:4px 0;padding-left:20px}
.inc-acc-sum h2{display:flex;align-items:center;gap:8px}
@container (max-width:760px){
  .inc-acc-grid,.inc-acc-cols,.inc-acc-modes{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:760px){
  .inc-acc-grid,.inc-acc-cols,.inc-acc-modes{grid-template-columns:minmax(0,1fr)}
}
`;
