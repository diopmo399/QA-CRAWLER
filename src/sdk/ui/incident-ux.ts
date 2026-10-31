import {
  EXECUTION_TARGETS,
  EXPERIMENT_STATUSES,
  HYPOTHESIS_STATUSES,
  incidentReproduction,
  type Diagnosis,
  type EnvironmentCapabilities,
  type ExecutionEnvironmentConfig,
  type ExecutionTarget,
  type ExperimentStatus,
  type HypothesisStatus,
  type Incident,
  type IncidentSeverity,
  type IncidentState,
} from '../core/incident-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import {
  demoBanner,
  panelState,
  selectable,
  selectionClass,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { esc } from './view.js';

/**
 * LA STRUCTURE DE L'ESPACE D'INVESTIGATION : la progression en dix étapes (déduite des seules données de
 * l'incident), l'en-tête, les onglets, la vue d'ensemble et le choix de l'environnement d'exécution
 * (LOCAL, REMOTE, ARO). Des fonctions pures, de l'état vers le HTML échappé ; les interactions passent
 * par `data-action` (préfixe `ws-ux-`), traitées par l'intégration. Un diagnostic n'est dit confirmé que
 * si son statut est CONFIRMED ; un test de non-régression n'est dit réussi que sur une exécution réelle.
 */

// ── Progression ──────────────────────────────────────────────────────────────────────────────

export const WORKSPACE_STAGES = [
  'description',
  'scope',
  'environment',
  'reproduction',
  'evidence',
  'code',
  'traceability',
  'diagnosis',
  'report',
  'regression',
] as const;
export type WorkspaceStage = (typeof WORKSPACE_STAGES)[number];

export type StageStatus = 'DONE' | 'CURRENT' | 'TODO' | 'BLOCKED';

export interface StageProgress {
  key: WorkspaceStage;
  status: StageStatus;
}

export interface WorkspaceProgress {
  stages: StageProgress[];
  /** La première étape non terminée (CURRENT, ou BLOCKED si l'incident est annulé ou en échec) ; absente : tout est fait. */
  current?: WorkspaceStage;
  /** L'étape qui avance sur le serveur sans action de la page (reproduction, vérification en cours). */
  running?: WorkspaceStage;
  done: number;
}

const filled = (value: string | undefined): boolean => (value ?? '').trim() !== '';

/** L'environnement d'exécution enregistré est-il complet ? ARO exige namespace, ServiceAccount, image et montage. */
function environmentReady(execution: ExecutionEnvironmentConfig): boolean {
  if (execution.target !== 'ARO') return true;
  const aro = execution.aro;
  return (
    aro !== undefined &&
    filled(aro.namespace) &&
    filled(aro.serviceAccount) &&
    filled(aro.image) &&
    filled(aro.repositoriesMount)
  );
}

/**
 * Les dix étapes, d'après les données de l'incident seulement. La validité du périmètre n'est pas connue
 * côté navigateur : « Périmètre » est terminé dès qu'il compte une application et un scénario.
 */
export function workspaceProgress(incident: Incident): WorkspaceProgress {
  const investigation = incident.investigation;
  const reproduction = incidentReproduction(incident);
  const done: Record<WorkspaceStage, boolean> = {
    description: filled(incident.title) && filled(incident.observed) && filled(incident.expected),
    scope:
      incident.scope.applications.length > 0 &&
      (filled(incident.scenario) || incident.scope.scenarios.length > 0),
    environment: environmentReady(incident.execution),
    reproduction: reproduction !== undefined,
    evidence:
      reproduction !== undefined && (reproduction.requests.length > 0 || reproduction.evidence.length > 0),
    code: investigation.code !== undefined,
    traceability: investigation.graph !== undefined,
    diagnosis: investigation.diagnosis !== undefined,
    report: investigation.diagnosis !== undefined,
    regression: investigation.regression?.execution !== undefined,
  };
  const current = WORKSPACE_STAGES.find((key) => !done[key]);
  const blocked = incident.state === 'CANCELLED' || incident.state === 'FAILED';
  const stages = WORKSPACE_STAGES.map((key): StageProgress => {
    if (done[key]) return { key, status: 'DONE' };
    if (key === current) return { key, status: blocked ? 'BLOCKED' : 'CURRENT' };
    return { key, status: 'TODO' };
  });
  const running: WorkspaceStage | undefined =
    incident.state === 'REPRODUCING'
      ? 'reproduction'
      : investigation.experiments.some((experiment) => experiment.status === 'RUNNING')
        ? 'diagnosis'
        : undefined;
  return {
    stages,
    ...(current ? { current } : {}),
    ...(running ? { running } : {}),
    done: stages.filter((stage) => stage.status === 'DONE').length,
  };
}

// ── État local ───────────────────────────────────────────────────────────────────────────────

/** Les champs de l'environnement d'exécution (attribut `data-ws-field`). */
export const UX_FIELDS = [
  'remote.apiServer',
  'remote.namespace',
  'remote.context',
  'aro.namespace',
  'aro.serviceAccount',
  'aro.image',
  'aro.repositoriesMount',
  'aro.apiServer',
] as const;
export type UxField = (typeof UX_FIELDS)[number];

const ARO_REQUIRED: readonly UxField[] = [
  'aro.namespace',
  'aro.serviceAccount',
  'aro.image',
  'aro.repositoriesMount',
];

export interface UxUi {
  /** La cible choisie, pas encore enregistrée ; absente : celle de l'incident. */
  target?: ExecutionTarget;
  /** Les champs saisis ; un champ absent garde la valeur enregistrée. */
  fields: Partial<Record<UxField, string>>;
  /** Les champs refusés au dernier enregistrement. */
  invalid: UxField[];
  /** L'enregistrement est en cours. */
  saving: boolean;
  error?: string;
}

export const emptyUxUi = (): UxUi => ({ fields: {}, invalid: [], saving: false });

const isTarget = (value: string | undefined): value is ExecutionTarget =>
  (EXECUTION_TARGETS as readonly string[]).includes(value ?? '');
const isField = (value: string | undefined): value is UxField =>
  (UX_FIELDS as readonly string[]).includes(value ?? '');

/**
 * Le réducteur pur des actions `ws-ux-…`. Les actions de l'interface : `ws-ux-target` (`data-target`),
 * `ws-ux-field` (`field`, `value` : le champ saisi), `ws-ux-target-reset`, `ws-ux-target-save` (marque
 * l'enregistrement en cours). Les retours de l'intégration : `ws-ux-invalid` (`fields`, liste séparée par
 * des virgules), `ws-ux-saved`, `ws-ux-error` (`message`). `ws-ux-stage` et `ws-ux-tab` sont de la
 * navigation (route) : non traitées ici.
 */
export function reduceUx(
  ui: UxUi,
  action: string,
  dataset: Record<string, string | undefined>,
): UxUi | undefined {
  switch (action) {
    case 'ws-ux-target': {
      const target = dataset.target;
      if (!isTarget(target)) return ui;
      return { ...ui, target, invalid: [], error: undefined };
    }
    case 'ws-ux-field': {
      const field = dataset.field;
      if (!isField(field)) return ui;
      return {
        ...ui,
        fields: { ...ui.fields, [field]: dataset.value ?? '' },
        invalid: ui.invalid.filter((entry) => entry !== field),
      };
    }
    case 'ws-ux-target-reset':
      return emptyUxUi();
    case 'ws-ux-target-save':
      return { ...ui, saving: true, invalid: [], error: undefined };
    case 'ws-ux-invalid':
      return {
        ...ui,
        saving: false,
        invalid: (dataset.fields ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(isField),
      };
    case 'ws-ux-saved':
      return emptyUxUi();
    case 'ws-ux-error':
      return { ...ui, saving: false, error: dataset.message ?? '' };
    default:
      return undefined;
  }
}

/** La valeur enregistrée d'un champ. */
function savedValue(execution: ExecutionEnvironmentConfig, field: UxField): string {
  const openshift = execution.remote?.openshift;
  const aro = execution.aro;
  switch (field) {
    case 'remote.apiServer':
      return openshift?.apiServer ?? '';
    case 'remote.namespace':
      return openshift?.namespace ?? '';
    case 'remote.context':
      return openshift?.context ?? '';
    case 'aro.namespace':
      return aro?.namespace ?? '';
    case 'aro.serviceAccount':
      return aro?.serviceAccount ?? '';
    case 'aro.image':
      return aro?.image ?? '';
    case 'aro.repositoriesMount':
      return aro?.repositoriesMount ?? '';
    case 'aro.apiServer':
      return aro?.apiServer ?? '';
  }
}

/** La valeur affichée d'un champ : la saisie, sinon la valeur enregistrée. */
export const uxFieldValue = (incident: Incident, ui: UxUi, field: UxField): string =>
  ui.fields[field] ?? savedValue(incident.execution, field);

export const selectedTarget = (incident: Incident, ui: UxUi): ExecutionTarget =>
  ui.target ?? incident.execution.target;

/**
 * La configuration à enregistrer (`client.incidents.update(revision, { execution })`) et les champs qui
 * la rendent invalide (ARO : namespace, ServiceAccount, image et montage obligatoires ; REMOTE : un
 * serveur d'API ou un contexte sans namespace).
 */
export function executionOf(
  incident: Incident,
  ui: UxUi,
): { execution: ExecutionEnvironmentConfig; invalid: UxField[] } {
  const target = selectedTarget(incident, ui);
  const value = (field: UxField): string => uxFieldValue(incident, ui, field).trim();
  if (target === 'ARO') {
    const invalid = ARO_REQUIRED.filter((field) => !value(field));
    const apiServer = value('aro.apiServer');
    return {
      execution: {
        target,
        aro: {
          namespace: value('aro.namespace'),
          serviceAccount: value('aro.serviceAccount'),
          image: value('aro.image'),
          repositoriesMount: value('aro.repositoriesMount'),
          ...(apiServer ? { apiServer } : {}),
        },
      },
      invalid,
    };
  }
  if (target === 'REMOTE') {
    const namespace = value('remote.namespace');
    const apiServer = value('remote.apiServer');
    const context = value('remote.context');
    const invalid: UxField[] = !namespace && (apiServer || context) ? ['remote.namespace'] : [];
    return {
      execution: namespace
        ? {
            target,
            remote: {
              openshift: { namespace, ...(apiServer ? { apiServer } : {}), ...(context ? { context } : {}) },
            },
          }
        : { target },
      invalid,
    };
  }
  return { execution: { target: 'LOCAL' }, invalid: [] };
}

/** Le choix diffère-t-il de ce qui est enregistré ? */
export function environmentDirty(incident: Incident, ui: UxUi): boolean {
  if (selectedTarget(incident, ui) !== incident.execution.target) return true;
  return UX_FIELDS.some(
    (field) =>
      ui.fields[field] !== undefined &&
      (ui.fields[field] ?? '').trim() !== savedValue(incident.execution, field),
  );
}

/** La cible du clavier dans une liste à tabindex itinérant (onglets, groupe de boutons radio). */
export function rovingTarget<T extends string>(keys: readonly T[], current: T, key: string): T | undefined {
  const at = keys.indexOf(current);
  if (keys.length === 0) return undefined;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return keys[(at + 1) % keys.length];
    case 'ArrowLeft':
    case 'ArrowUp':
      return keys[(at - 1 + keys.length) % keys.length];
    case 'Home':
      return keys[0];
    case 'End':
      return keys.at(-1);
    default:
      return undefined;
  }
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const fr = {
  stages: {
    description: 'Description',
    scope: 'Périmètre',
    environment: 'Environnement',
    reproduction: 'Reproduction',
    evidence: 'Preuves',
    code: 'Analyse du code',
    traceability: 'Traçabilité',
    diagnosis: 'Diagnostic',
    report: 'Rapport',
    regression: 'Non-régression',
  } as Record<WorkspaceStage, string>,
  stageStatus: {
    DONE: 'Terminée',
    CURRENT: 'Étape actuelle',
    TODO: 'À venir',
    BLOCKED: 'Bloquée',
  } as Record<StageStatus, string>,
  running: 'En cours',
  progress: 'Progression de l’investigation',
  progressCount: (done: number, total: number) => `${String(done)} étape(s) terminée(s) sur ${String(total)}`,
  investigation: 'Investigation',
  severity: 'Gravité',
  state: 'État',
  diagnosis: 'Diagnostic',
  severities: { LOW: 'Faible', MEDIUM: 'Moyenne', HIGH: 'Haute', CRITICAL: 'Critique' } as Record<
    IncidentSeverity,
    string
  >,
  states: {
    DRAFT: 'Brouillon',
    SCOPED: 'Délimité',
    REPRODUCING: 'Reproduction en cours',
    REPRODUCED: 'Reproduit',
    NOT_REPRODUCED: 'Non reproduit',
    INVESTIGATING: 'Investigation',
    DIAGNOSED: 'Diagnostiqué',
    INCONCLUSIVE: 'Inconclusif',
    CANCELLED: 'Annulé',
    FAILED: 'En échec',
  } as Record<IncidentState, string>,
  cancelledFrom: (state: string) => `annulé à l’état « ${state} »`,
  diagnosisStatus: {
    CONFIRMED: 'Cause racine confirmée',
    PROBABLE: 'Cause probable, à vérifier',
    INCONCLUSIVE: 'Diagnostic inconclusif',
  } as Record<Diagnosis['status'], string>,
  rootCauseLabel: {
    CONFIRMED: 'Cause racine',
    PROBABLE: 'Cause la plus probable',
    INCONCLUSIVE: 'Piste principale',
  } as Record<Diagnosis['status'], string>,
  environment: 'Environnement',
  projectEnvironment: (id: string) => `environnement du projet ${id}`,
  firstEnvironment: 'premier environnement du projet',
  scenario: 'Scénario',
  noScenario: 'Aucun scénario',
  updated: 'Dernière mise à jour',
  actions: 'Actions sur l’incident',
  targets: { LOCAL: 'Local', REMOTE: 'Distant', ARO: 'Azure Red Hat OpenShift' } as Record<
    ExecutionTarget,
    string
  >,
  tabsLabel: 'Sections de l’investigation',
  count: (count: number) => `${String(count)} élément(s)`,
  tabs: {
    overview: 'Vue d’ensemble',
    timeline: 'Chronologie',
    traceability: 'Traçabilité',
    requests: 'Requêtes HTTP',
    frontend: 'Frontend',
    bff: 'BFF',
    backend: 'Backend',
    logs: 'Journaux',
    hypotheses: 'Hypothèses',
    experiments: 'Expériences',
    report: 'Rapport',
    regression: 'Non-régression',
  } as Record<string, string>,
  overview: {
    incident: 'L’incident',
    description: 'Description',
    observed: 'Observé',
    expected: 'Attendu',
    noDescription: 'Aucune description.',
    reproduction: 'Reproduction de référence',
    noReproduction: 'Aucune reproduction terminée du scénario de l’incident.',
    reproducing: 'Reproduction en cours : les preuves s’afficheront à la fin du run.',
    reproduced: {
      true: 'Symptôme observé',
      false: 'Symptôme non observé',
      null: 'Run non abouti',
    } as Record<'true' | 'false' | 'null', string>,
    run: (id: string, at: string) => `Run ${id}, ${at}`,
    failing: 'Requêtes en échec',
    noFailing: 'Aucune requête en échec dans ce run.',
    failure: 'sans réponse',
    jsError: 'Première erreur JavaScript',
    noJsError: 'Aucune erreur JavaScript capturée.',
    diagnosis: 'Diagnostic',
    noDiagnosis: 'Pas encore de diagnostic.',
    missing: 'Ce qui manque pour conclure',
    alternatives: (count: number) => `${String(count)} autre(s) piste(s) gardée(s)`,
    work: 'Hypothèses et expériences',
    hypotheses: 'Hypothèses',
    experiments: 'Expériences',
    none: 'Aucune pour l’instant.',
    regression: 'Test de non-régression',
    regressionVerdict: {
      NONE: 'Pas encore proposé',
      NOT_RUN: 'Proposé, pas encore exécuté',
      PASSED: 'Exécuté : réussi',
      FAILED: 'Exécuté : en échec',
    } as Record<'NONE' | 'NOT_RUN' | 'PASSED' | 'FAILED', string>,
    next: 'Prochaine étape recommandée',
    goTo: (stage: string) => `Aller à « ${stage} »`,
    complete: 'Investigation complète : le test de non-régression a été exécuté.',
    cancelled: 'Investigation annulée : la reprendre pour continuer.',
    failed: (stage: string) =>
      `L’investigation a échoué à l’étape « ${stage} » : lire l’erreur, puis relancer.`,
    advice: {
      description: 'Compléter la description : titre, comportement observé et comportement attendu.',
      scope: 'Délimiter le périmètre : au moins une application et le scénario qui mène au symptôme.',
      environment: 'Compléter l’environnement ARO : namespace, ServiceAccount, image et montage des dépôts.',
      reproduction: 'Lancer la reproduction du scénario avec Playwright.',
      evidence: 'La reproduction n’a capturé ni requête ni preuve : vérifier le scénario, puis relancer.',
      code: 'Lancer l’analyse du code du périmètre.',
      traceability: 'Relier la reproduction au code : construire le graphe de traçabilité.',
      diagnosis: 'Examiner les hypothèses, mener les expériences utiles, puis établir le diagnostic.',
      report: 'Établir le diagnostic pour obtenir le rapport.',
      regression: 'Proposer, puis exécuter le test de non-régression.',
    } as Record<WorkspaceStage, string>,
    runningAdvice: 'Une opération est en cours sur le serveur : la page se met à jour seule.',
  },
  hypothesisStatus: {
    PROPOSED: 'Proposées',
    INVESTIGATING: 'En examen',
    SUPPORTED: 'Étayées',
    REFUTED: 'Réfutées',
    INCONCLUSIVE: 'Inconclusives',
    CONFIRMED: 'Confirmées',
  } as Record<HypothesisStatus, string>,
  experimentStatus: {
    PROPOSED: 'Proposées',
    REFUSED: 'Refusées',
    APPROVAL_REQUIRED: 'En attente d’approbation',
    RUNNING: 'En cours',
    DONE: 'Terminées',
    ERROR: 'En erreur',
    CANCELLED: 'Annulées',
  } as Record<ExperimentStatus, string>,
  env: {
    title: 'Environnement d’exécution',
    sub: 'Où QA-CRAWLER et Playwright s’exécutent pour cette investigation.',
    group: 'Cible d’exécution',
    default: 'Par défaut',
    saved: 'Enregistrée',
    selected: 'Sélectionnée',
    playwright: 'Playwright',
    repositories: 'Dépôts',
    logs: 'Journaux',
    tests: 'Tests',
    jobs: 'Jobs Kubernetes',
    measured: 'Capacités mesurées',
    generic: {
      LOCAL: {
        playwright: 'Programme local, sur ce poste',
        repositories: 'Lus sur ce poste',
        logs: 'Fichiers locaux autorisés par le périmètre',
        tests: 'Maven, Gradle ou npm s’ils sont installés',
      },
      REMOTE: {
        playwright: 'Programme local, applications distantes',
        repositories: 'Lus sur ce poste',
        logs: 'Fichiers locaux ; OpenShift en lecture si configuré',
        tests: 'Locaux, si les outils sont installés',
      },
      ARO: {
        playwright: 'Conteneur dans le cluster',
        repositories: 'Montés dans le pod',
        logs: 'OpenShift (lecture) et fichiers montés',
        tests: 'Dans le pod, si l’image fournit les outils',
      },
    } as Record<ExecutionTarget, { playwright: string; repositories: string; logs: string; tests: string }>,
    playwrightKinds: { LOCAL_PROCESS: 'Programme local', CONTAINER: 'Conteneur' } as Record<string, string>,
    repositoryKinds: { LOCAL: 'Sur cette machine', CLUSTER_VOLUME: 'Volume du cluster' } as Record<
      string,
      string
    >,
    logKinds: {
      FILES: 'Fichiers',
      OPENSHIFT: 'OpenShift',
      FILES_AND_OPENSHIFT: 'Fichiers et OpenShift',
      NONE: 'Aucun',
    } as Record<string, string>,
    available: 'Disponibles',
    unavailable: 'Indisponibles',
    remoteFields: 'Consultation OpenShift (facultatif)',
    aroFields: 'Déploiement ARO',
    fields: {
      'remote.apiServer': 'Serveur d’API',
      'remote.namespace': 'Namespace',
      'remote.context': 'Contexte',
      'aro.namespace': 'Namespace',
      'aro.serviceAccount': 'ServiceAccount',
      'aro.image': 'Image',
      'aro.repositoriesMount': 'Montage des dépôts',
      'aro.apiServer': 'Serveur d’API',
    } as Record<UxField, string>,
    hints: {
      'remote.namespace': 'Nécessaire pour lire les journaux OpenShift.',
      'aro.repositoriesMount': 'Le chemin des dépôts dans le pod (volume ou clone préalable).',
    } as Partial<Record<UxField, string>>,
    required: 'Les champs marqués * sont obligatoires.',
    invalid: 'Compléter les champs signalés avant d’enregistrer.',
    fieldRequired: 'Champ obligatoire.',
    fieldInvalid: {
      'remote.namespace': 'Obligatoire quand un serveur d’API ou un contexte est indiqué.',
    } as Partial<Record<UxField, string>>,
    limitations: 'Limites',
    measuredLimitations: (target: string) => `Limites constatées (${target})`,
    noLimitation: 'Aucune limite constatée.',
    measuredFor: (target: string) =>
      `Capacités mesurées pour la cible enregistrée (${target}) ; elles seront relues après l’enregistrement.`,
    known: {
      LOCAL: ['Les applications doivent être joignables depuis ce poste.'],
      REMOTE: [
        'Les dépôts restent sur ce poste : ils doivent correspondre à la version déployée.',
        'Les journaux OpenShift exigent un namespace et la lecture OpenShift dans le périmètre.',
      ],
      ARO: [
        'QA-CRAWLER doit être déployé dans le cluster : ce choix décrit où il s’exécute, il ne déplace pas l’exécution.',
        'Les dépôts doivent être montés dans le pod au chemin indiqué.',
      ],
    } as Record<ExecutionTarget, string[]>,
    dirty: 'Modifications non enregistrées.',
    save: 'Enregistrer l’environnement',
    reset: 'Revenir à l’environnement enregistré',
    readOnly: 'Lecture seule : votre rôle ne permet pas de changer l’environnement.',
    locked: (state: string) => `Indisponible dans l’état « ${state} ».`,
  },
};

const en: typeof fr = {
  stages: {
    description: 'Description',
    scope: 'Scope',
    environment: 'Environment',
    reproduction: 'Reproduction',
    evidence: 'Evidence',
    code: 'Code analysis',
    traceability: 'Traceability',
    diagnosis: 'Diagnosis',
    report: 'Report',
    regression: 'Non-regression',
  },
  stageStatus: { DONE: 'Done', CURRENT: 'Current step', TODO: 'Upcoming', BLOCKED: 'Blocked' },
  running: 'Running',
  progress: 'Investigation progress',
  progressCount: (done, total) => `${String(done)} of ${String(total)} step(s) done`,
  investigation: 'Investigation',
  severity: 'Severity',
  state: 'State',
  diagnosis: 'Diagnosis',
  severities: { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' },
  states: {
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
  },
  cancelledFrom: (state) => `cancelled in state “${state}”`,
  diagnosisStatus: {
    CONFIRMED: 'Root cause confirmed',
    PROBABLE: 'Probable cause, to be checked',
    INCONCLUSIVE: 'Inconclusive diagnosis',
  },
  rootCauseLabel: { CONFIRMED: 'Root cause', PROBABLE: 'Most probable cause', INCONCLUSIVE: 'Main lead' },
  environment: 'Environment',
  projectEnvironment: (id) => `project environment ${id}`,
  firstEnvironment: 'first project environment',
  scenario: 'Scenario',
  noScenario: 'No scenario',
  updated: 'Last update',
  actions: 'Incident actions',
  targets: { LOCAL: 'Local', REMOTE: 'Remote', ARO: 'Azure Red Hat OpenShift' },
  tabsLabel: 'Investigation sections',
  count: (count) => `${String(count)} item(s)`,
  tabs: {
    overview: 'Overview',
    timeline: 'Timeline',
    traceability: 'Traceability',
    requests: 'HTTP requests',
    frontend: 'Frontend',
    bff: 'BFF',
    backend: 'Backend',
    logs: 'Logs',
    hypotheses: 'Hypotheses',
    experiments: 'Experiments',
    report: 'Report',
    regression: 'Non-regression',
  },
  overview: {
    incident: 'The incident',
    description: 'Description',
    observed: 'Observed',
    expected: 'Expected',
    noDescription: 'No description.',
    reproduction: 'Reference reproduction',
    noReproduction: 'No completed reproduction of the incident scenario.',
    reproducing: 'Reproduction running: the evidence will show when the run ends.',
    reproduced: { true: 'Symptom observed', false: 'Symptom not observed', null: 'Run did not complete' },
    run: (id, at) => `Run ${id}, ${at}`,
    failing: 'Failing requests',
    noFailing: 'No failing request in this run.',
    failure: 'no response',
    jsError: 'First JavaScript error',
    noJsError: 'No JavaScript error captured.',
    diagnosis: 'Diagnosis',
    noDiagnosis: 'No diagnosis yet.',
    missing: 'What is missing to conclude',
    alternatives: (count) => `${String(count)} other lead(s) kept`,
    work: 'Hypotheses and experiments',
    hypotheses: 'Hypotheses',
    experiments: 'Experiments',
    none: 'None yet.',
    regression: 'Non-regression test',
    regressionVerdict: {
      NONE: 'Not proposed yet',
      NOT_RUN: 'Proposed, not run yet',
      PASSED: 'Run: passed',
      FAILED: 'Run: failed',
    },
    next: 'Recommended next step',
    goTo: (stage) => `Go to “${stage}”`,
    complete: 'Investigation complete: the non-regression test has been run.',
    cancelled: 'Investigation cancelled: resume it to continue.',
    failed: (stage) => `The investigation failed at step “${stage}”: read the error, then run it again.`,
    advice: {
      description: 'Complete the description: title, observed behaviour and expected behaviour.',
      scope: 'Define the scope: at least one application and the scenario that leads to the symptom.',
      environment: 'Complete the ARO environment: namespace, ServiceAccount, image and repository mount.',
      reproduction: 'Run the reproduction of the scenario with Playwright.',
      evidence:
        'The reproduction captured no request and no evidence: check the scenario, then run it again.',
      code: 'Run the analysis of the scope code.',
      traceability: 'Link the reproduction to the code: build the traceability graph.',
      diagnosis: 'Review the hypotheses, run the useful experiments, then establish the diagnosis.',
      report: 'Establish the diagnosis to get the report.',
      regression: 'Propose, then run the non-regression test.',
    },
    runningAdvice: 'An operation is running on the server: the page updates by itself.',
  },
  hypothesisStatus: {
    PROPOSED: 'Proposed',
    INVESTIGATING: 'Under review',
    SUPPORTED: 'Supported',
    REFUTED: 'Refuted',
    INCONCLUSIVE: 'Inconclusive',
    CONFIRMED: 'Confirmed',
  },
  experimentStatus: {
    PROPOSED: 'Proposed',
    REFUSED: 'Refused',
    APPROVAL_REQUIRED: 'Awaiting approval',
    RUNNING: 'Running',
    DONE: 'Done',
    ERROR: 'Error',
    CANCELLED: 'Cancelled',
  },
  env: {
    title: 'Execution environment',
    sub: 'Where QA-CRAWLER and Playwright run for this investigation.',
    group: 'Execution target',
    default: 'Default',
    saved: 'Saved',
    selected: 'Selected',
    playwright: 'Playwright',
    repositories: 'Repositories',
    logs: 'Logs',
    tests: 'Tests',
    jobs: 'Kubernetes jobs',
    measured: 'Measured capabilities',
    generic: {
      LOCAL: {
        playwright: 'Local process, on this machine',
        repositories: 'Read on this machine',
        logs: 'Local files allowed by the scope',
        tests: 'Maven, Gradle or npm when installed',
      },
      REMOTE: {
        playwright: 'Local process, remote applications',
        repositories: 'Read on this machine',
        logs: 'Local files; OpenShift read access when configured',
        tests: 'Local, when the tools are installed',
      },
      ARO: {
        playwright: 'Container in the cluster',
        repositories: 'Mounted in the pod',
        logs: 'OpenShift (read) and mounted files',
        tests: 'In the pod, when the image provides the tools',
      },
    },
    playwrightKinds: { LOCAL_PROCESS: 'Local process', CONTAINER: 'Container' },
    repositoryKinds: { LOCAL: 'On this machine', CLUSTER_VOLUME: 'Cluster volume' },
    logKinds: {
      FILES: 'Files',
      OPENSHIFT: 'OpenShift',
      FILES_AND_OPENSHIFT: 'Files and OpenShift',
      NONE: 'None',
    },
    available: 'Available',
    unavailable: 'Unavailable',
    remoteFields: 'OpenShift access (optional)',
    aroFields: 'ARO deployment',
    fields: {
      'remote.apiServer': 'API server',
      'remote.namespace': 'Namespace',
      'remote.context': 'Context',
      'aro.namespace': 'Namespace',
      'aro.serviceAccount': 'ServiceAccount',
      'aro.image': 'Image',
      'aro.repositoriesMount': 'Repository mount',
      'aro.apiServer': 'API server',
    },
    hints: {
      'remote.namespace': 'Required to read OpenShift logs.',
      'aro.repositoriesMount': 'The repositories path in the pod (volume or prior clone).',
    },
    required: 'Fields marked * are required.',
    invalid: 'Complete the flagged fields before saving.',
    fieldRequired: 'Required field.',
    fieldInvalid: {
      'remote.namespace': 'Required when an API server or a context is given.',
    },
    limitations: 'Limitations',
    measuredLimitations: (target) => `Measured limitations (${target})`,
    noLimitation: 'No limitation found.',
    measuredFor: (target) =>
      `Capabilities measured for the saved target (${target}); they will be read again after saving.`,
    known: {
      LOCAL: ['The applications must be reachable from this machine.'],
      REMOTE: [
        'The repositories stay on this machine: they must match the deployed version.',
        'OpenShift logs require a namespace and OpenShift read access in the scope.',
      ],
      ARO: [
        'QA-CRAWLER must be deployed in the cluster: this choice describes where it runs, it does not move the run.',
        'The repositories must be mounted in the pod at the given path.',
      ],
    },
    dirty: 'Unsaved changes.',
    save: 'Save the environment',
    reset: 'Back to the saved environment',
    readOnly: 'Read only: your role does not allow changing the environment.',
    locked: (state) => `Unavailable in state “${state}”.`,
  },
};

const TEXT: Record<Lang, typeof fr> = { fr, en };

/** Les textes de la structure (pour l'intégration : libellés des étapes et des onglets). */
export const uxText = (lang: Lang): typeof fr => TEXT[lang];

// ── Pièces ───────────────────────────────────────────────────────────────────────────────────

const TONES: Record<string, string> = {
  LOW: 'mu',
  MEDIUM: 'warn',
  HIGH: 'ko',
  CRITICAL: 'ko',
  DRAFT: 'mu',
  SCOPED: 'live',
  REPRODUCING: 'live',
  REPRODUCED: 'warn',
  NOT_REPRODUCED: 'mu',
  INVESTIGATING: 'live',
  DIAGNOSED: 'ok',
  INCONCLUSIVE: 'warn',
  CANCELLED: 'mu',
  FAILED: 'ko',
  CONFIRMED: 'ok',
  PROBABLE: 'warn',
  PROPOSED: 'mu',
  SUPPORTED: 'live',
  REFUTED: 'mu',
  REFUSED: 'ko',
  APPROVAL_REQUIRED: 'warn',
  RUNNING: 'live',
  DONE: 'ok',
  ERROR: 'ko',
  NONE: 'mu',
  NOT_RUN: 'mu',
  PASSED: 'ok',
};

/** Une pastille ; `prefix` est lu par les lecteurs d'écran seulement (« Gravité : »). */
const tag = (raw: string, text: string, prefix?: string): string =>
  `<span class="pill ${TONES[raw] ?? 'mu'}">${prefix ? `<span class="sr">${esc(prefix)} : </span>` : ''}${esc(text)}</span>`;

const fact = (term: string, value: string): string => `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;

// ── Progression : l'affichage ────────────────────────────────────────────────────────────────

/** La progression en liste ordonnée : chaque étape est un bouton (`ws-ux-stage`), l'étape actuelle porte aria-current. */
export function renderStepper(ctx: WorkspaceContext): string {
  const t = TEXT[ctx.lang];
  const progress = workspaceProgress(ctx.incident);
  const items = progress.stages
    .map((stage, index) => {
      const running = progress.running === stage.key;
      const marker =
        stage.status === 'DONE'
          ? icon('check')
          : stage.status === 'BLOCKED'
            ? icon('alert')
            : `<span>${String(index + 1)}</span>`;
      const status = running ? t.running : t.stageStatus[stage.status];
      return `<li class="ws-ux-stage ws-ux-s-${stage.status.toLowerCase()}${running ? ' ws-ux-s-running' : ''}"><button type="button" data-action="ws-ux-stage" data-stage="${stage.key}"${progress.current === stage.key ? ' aria-current="step"' : ''}><span class="ws-ux-dot" aria-hidden="true">${marker}</span><span class="ws-ux-stage-t"><b>${esc(t.stages[stage.key])}</b><small>${running ? '<span class="spin sm" aria-hidden="true"></span>' : ''}${esc(status)}</small></span></button></li>`;
    })
    .join('');
  return `<nav class="ws-ux-stepper" aria-label="${esc(t.progress)}"><p class="ws-ux-progress mu">${esc(t.progressCount(progress.done, progress.stages.length))}</p><ol>${items}</ol></nav>`;
}

// ── En-tête ──────────────────────────────────────────────────────────────────────────────────

/** L'en-tête : titre, gravité, état, environnement, scénario, mise à jour, bandeau de démonstration, actions. */
export function renderWorkspaceHeader(ctx: WorkspaceContext, actions: string): string {
  const t = TEXT[ctx.lang];
  const incident = ctx.incident;
  const progress = workspaceProgress(incident);
  const diagnosis = incident.investigation.diagnosis;
  const stateText =
    incident.state === 'CANCELLED' && incident.cancelledFrom
      ? `${t.states.CANCELLED} (${t.cancelledFrom(t.states[incident.cancelledFrom])})`
      : t.states[incident.state];
  const tags = [
    tag(incident.severity, t.severities[incident.severity], t.severity),
    tag(incident.state, stateText, t.state),
    diagnosis ? tag(diagnosis.status, t.diagnosisStatus[diagnosis.status], t.diagnosis) : '',
    progress.running
      ? `<span class="pill live ws-ux-run"><span class="spin sm" aria-hidden="true"></span>${esc(`${t.stages[progress.running]} : ${t.running.toLowerCase()}`)}</span>`
      : '',
  ].join('');
  const environment = `<b>${esc(t.targets[incident.execution.target])}</b><small class="mu block">${esc(
    incident.environmentId ? t.projectEnvironment(incident.environmentId) : t.firstEnvironment,
  )}</small>`;
  const meta = `<dl class="ws-ux-meta">${fact(t.environment, environment)}${fact(
    t.scenario,
    incident.scenario ? esc(incident.scenario) : `<span class="mu">${esc(t.noScenario)}</span>`,
  )}${fact(t.updated, `<time datetime="${esc(incident.updatedAt)}">${esc(formatDate(incident.updatedAt, ctx.lang))}</time>`)}</dl>`;
  return `<header class="ws-ux-head" aria-labelledby="ws-ux-title"><div class="ws-ux-head-top"><div class="ws-ux-head-t"><p class="ws-ux-eyebrow">${esc(t.investigation)} <code>${esc(incident.id)}</code></p><h1 id="ws-ux-title">${esc(incident.title)}</h1><div class="ws-ux-tags">${tags}</div></div><div class="acts" role="group" aria-label="${esc(t.actions)}">${actions}</div></div>${meta}${demoBanner(ctx)}</header>`;
}

// ── Onglets ──────────────────────────────────────────────────────────────────────────────────

export interface UxTab {
  key: string;
  label: string;
  count?: number;
}

/** Les onglets de l'espace d'investigation, avec les nombres connus d'après l'incident. */
export function workspaceTabs(ctx: WorkspaceContext): UxTab[] {
  const t = TEXT[ctx.lang];
  const investigation = ctx.incident.investigation;
  const reproduction = incidentReproduction(ctx.incident);
  const counts: Record<string, number | undefined> = {
    timeline: investigation.timeline?.length,
    requests: reproduction?.requests.length,
    hypotheses: investigation.hypotheses.length,
    experiments: investigation.experiments.length,
  };
  return Object.entries(t.tabs).map(([key, label]) => {
    const count = counts[key];
    return { key, label, ...(count !== undefined && count > 0 ? { count } : {}) };
  });
}

/** La liste d'onglets : tabindex itinérant (flèches, Début, Fin via rovingTarget), `ws-ux-tab`. */
export function renderTabs(ctx: WorkspaceContext, tabs: UxTab[], current: string): string {
  const t = TEXT[ctx.lang];
  return `<div class="tabs ws-ux-tabs" role="tablist" aria-label="${esc(t.tabsLabel)}" aria-orientation="horizontal">${tabs
    .map((tab) => {
      const selected = tab.key === current;
      return `<button type="button" role="tab" id="ws-ux-tab-${esc(tab.key)}" data-action="ws-ux-tab" data-tab="${esc(tab.key)}" aria-selected="${String(selected)}" aria-controls="ws-ux-panel" tabindex="${selected ? '0' : '-1'}">${esc(tab.label)}${tab.count !== undefined ? ` <span class="ws-ux-count"><span aria-hidden="true">${String(tab.count)}</span><span class="sr">${esc(t.count(tab.count))}</span></span>` : ''}</button>`;
    })
    .join('')}</div>`;
}

/** Le panneau de l'onglet courant, relié à son onglet. */
export const renderTabPanel = (current: string, body: string): string =>
  `<div id="ws-ux-panel" class="ws-ux-panel" role="tabpanel" aria-labelledby="ws-ux-tab-${esc(current)}" tabindex="0">${body}</div>`;

// ── Vue d'ensemble ───────────────────────────────────────────────────────────────────────────

function countList<S extends string>(
  statuses: readonly S[],
  values: readonly S[],
  labels: Record<S, string>,
): string {
  const rows = statuses
    .map((status) => ({ status, count: values.filter((value) => value === status).length }))
    .filter((row) => row.count > 0);
  return `<ul class="ws-ux-counts">${rows.map((row) => `<li>${tag(row.status, labels[row.status])}<b>${String(row.count)}</b></li>`).join('')}</ul>`;
}

/** L'onglet « Vue d'ensemble » : l'incident, la reproduction de référence, le diagnostic, le travail, la suite. */
export function renderOverview(ctx: WorkspaceContext): string {
  const t = TEXT[ctx.lang];
  const o = t.overview;
  const incident = ctx.incident;
  const investigation = incident.investigation;
  const progress = workspaceProgress(incident);

  const about = `<section class="card ws-ux-card" aria-labelledby="ws-ux-o-incident"><h2 id="ws-ux-o-incident">${esc(o.incident)}</h2><dl class="ws-ux-dl">${fact(o.observed, esc(incident.observed))}${fact(o.expected, esc(incident.expected))}<div class="wide"><dt>${esc(o.description)}</dt><dd>${incident.description ? esc(incident.description) : `<span class="mu">${esc(o.noDescription)}</span>`}</dd></div></dl></section>`;

  const reproduction = incidentReproduction(incident);
  let reproBody: string;
  if (!reproduction)
    reproBody =
      incident.state === 'REPRODUCING'
        ? panelState(ctx.lang, 'loading', o.reproducing)
        : panelState(ctx.lang, 'empty', o.noReproduction);
  else {
    const verdict = String(reproduction.reproduced) as 'true' | 'false' | 'null';
    const failing = reproduction.requests.filter(
      (request) => request.failure !== undefined || (request.status !== undefined && request.status >= 400),
    );
    const failingList =
      failing.length === 0
        ? `<p class="mu">${esc(o.noFailing)}</p>`
        : `<ul class="plain ws-ux-reqs">${failing
            .map(
              (request) =>
                `<li><button type="button" class="ws-ux-req ${selectionClass(ctx, 'request', request.id)}" ${selectable(ctx, 'request', request.id)}><code>${esc(request.method)} ${esc(request.path)}</code>${tag('ERROR', request.status !== undefined ? String(request.status) : o.failure)}</button>${request.failure ? `<small class="mu block">${esc(request.failure)}</small>` : ''}</li>`,
            )
            .join('')}</ul>`;
    const jsError = reproduction.evidence.find((item) => item.kind === 'JS_ERROR');
    const jsErrorBlock = jsError
      ? `<button type="button" class="ws-ux-ev ${selectionClass(ctx, 'evidence', jsError.id)}" ${selectable(ctx, 'evidence', jsError.id)}>${esc(jsError.summary)}</button>`
      : `<p class="mu">${esc(o.noJsError)}</p>`;
    reproBody = `<p class="ws-ux-verdict">${tag(reproduction.reproduced === true ? 'ERROR' : reproduction.reproduced === false ? 'NONE' : 'INCONCLUSIVE', o.reproduced[verdict])}<small class="mu">${esc(o.run(reproduction.id, formatDate(reproduction.finishedAt ?? reproduction.startedAt, ctx.lang)))}</small></p>${reproduction.symptomMatch ? `<p class="mu">${esc(reproduction.symptomMatch)}</p>` : ''}<h3>${esc(o.failing)}</h3>${failingList}<h3>${esc(o.jsError)}</h3>${jsErrorBlock}`;
  }
  const repro = `<section class="card ws-ux-card" aria-labelledby="ws-ux-o-repro"><h2 id="ws-ux-o-repro">${esc(o.reproduction)}</h2>${reproBody}</section>`;

  const diagnosis = investigation.diagnosis;
  const diagnosisBody = diagnosis
    ? `<p class="ws-ux-verdict">${tag(diagnosis.status, t.diagnosisStatus[diagnosis.status])}</p>${
        diagnosis.rootCause
          ? `<div class="ws-ux-cause ws-ux-cause-${diagnosis.status.toLowerCase()} ${selectionClass(ctx, 'hypothesis', diagnosis.rootCause.hypothesisId)}"><h3>${esc(t.rootCauseLabel[diagnosis.status])}</h3><p>${esc(diagnosis.rootCause.statement)}</p></div>`
          : ''
      }${diagnosis.alternatives.length > 0 ? `<p class="mu">${esc(o.alternatives(diagnosis.alternatives.length))}</p>` : ''}${
        diagnosis.missing.length > 0
          ? `<h3>${esc(o.missing)}</h3><ul class="plain tight">${diagnosis.missing.map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul>`
          : ''
      }`
    : `<p class="mu">${esc(o.noDiagnosis)}</p>`;
  const diagnosisCard = `<section class="card ws-ux-card" aria-labelledby="ws-ux-o-diag"><h2 id="ws-ux-o-diag">${esc(o.diagnosis)}</h2>${diagnosisBody}</section>`;

  const hypotheses = investigation.hypotheses.map((entry) => entry.status);
  const experiments = investigation.experiments.map((entry) => entry.status);
  const regression = investigation.regression;
  const verdict = !regression
    ? 'NONE'
    : !regression.execution
      ? 'NOT_RUN'
      : regression.execution.passed
        ? 'PASSED'
        : 'FAILED';
  const work = `<section class="card ws-ux-card" aria-labelledby="ws-ux-o-work"><h2 id="ws-ux-o-work">${esc(o.work)}</h2><h3>${esc(o.hypotheses)}</h3>${hypotheses.length === 0 ? `<p class="mu">${esc(o.none)}</p>` : countList(HYPOTHESIS_STATUSES, hypotheses, t.hypothesisStatus)}<h3>${esc(o.experiments)}</h3>${experiments.length === 0 ? `<p class="mu">${esc(o.none)}</p>` : countList(EXPERIMENT_STATUSES, experiments, t.experimentStatus)}<h3>${esc(o.regression)}</h3><p>${tag(verdict, o.regressionVerdict[verdict])}</p></section>`;

  const current = progress.current;
  const blocked = progress.stages.find((stage) => stage.status === 'BLOCKED');
  const advice = !current
    ? o.complete
    : blocked
      ? incident.state === 'CANCELLED'
        ? o.cancelled
        : o.failed(t.stages[blocked.key])
      : progress.running
        ? o.runningAdvice
        : o.advice[current];
  const next = `<section class="card ws-ux-card ws-ux-next" aria-labelledby="ws-ux-o-next"><h2 id="ws-ux-o-next">${esc(o.next)}</h2><p>${esc(advice)}</p>${
    current
      ? `<button type="button" class="btn small" data-action="ws-ux-stage" data-stage="${current}">${icon('right')}<span>${esc(o.goTo(t.stages[current]))}</span></button>`
      : ''
  }</section>`;

  return `<div class="ws-ux-overview">${demoBanner(ctx)}${next}${about}${repro}${diagnosisCard}${work}</div>`;
}

// ── Environnement d'exécution ────────────────────────────────────────────────────────────────

function envField(
  ctx: WorkspaceContext,
  ui: UxUi,
  field: UxField,
  options: { required: boolean; disabled: boolean },
): string {
  const e = TEXT[ctx.lang].env;
  const id = `ws-ux-f-${field}`;
  const hint = e.hints[field];
  const invalid = ui.invalid.includes(field);
  // Un champ refusé porte son propre message (lié par aria-describedby, avant l'indication).
  const described = [invalid ? `${id}-e` : '', hint ? `${id}-h` : ''].filter(Boolean).join(' ');
  const problem = invalid
    ? `<small id="${id}-e" class="err ws-ux-field-err">${icon('alert')}<span>${esc(e.fieldInvalid[field] ?? e.fieldRequired)}</span></small>`
    : '';
  return `<label class="field" for="${id}">${esc(e.fields[field])}${options.required ? ' <span aria-hidden="true">*</span>' : ''}<input id="${id}" data-ws-field="${field}" class="mono" spellcheck="false" autocomplete="off" value="${esc(uxFieldValue(ctx.incident, ui, field))}"${options.required ? ' required aria-required="true"' : ''}${invalid ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''}${options.disabled ? ' disabled' : ''}>${problem}${hint ? `<small id="${id}-h" class="mu">${esc(hint)}</small>` : ''}</label>`;
}

/**
 * Le choix LOCAL / REMOTE / ARO : trois cartes en groupe de boutons radio (`ws-ux-target`), ce que chaque
 * cible permet (mesuré quand `capabilities` vaut pour elle, sinon le cas général), les champs OpenShift
 * (REMOTE, facultatifs) ou ARO (obligatoires), les limites, puis l'enregistrement (`ws-ux-target-save`).
 */
export function renderEnvironmentSelector(
  ctx: WorkspaceContext,
  ui: UxUi,
  capabilities?: EnvironmentCapabilities,
): string {
  const t = TEXT[ctx.lang];
  const e = t.env;
  const incident = ctx.incident;
  const selected = selectedTarget(incident, ui);
  const saved = incident.execution.target;
  const runner = ctx.can('RUN');
  const locked = incident.state === 'REPRODUCING' || incident.state === 'CANCELLED';
  const disabled = !runner || locked || ui.saving;

  const cards = EXECUTION_TARGETS.map((target) => {
    const checked = target === selected;
    const measured = capabilities?.target === target ? capabilities : undefined;
    const generic = e.generic[target];
    const rows: [string, string][] = measured
      ? [
          [e.playwright, e.playwrightKinds[measured.playwright] ?? measured.playwright],
          [e.repositories, e.repositoryKinds[measured.repositories] ?? measured.repositories],
          [e.logs, e.logKinds[measured.logs] ?? measured.logs],
          [e.tests, measured.tests ? e.available : e.unavailable],
          [e.jobs, measured.kubernetesJobs ? e.available : e.unavailable],
        ]
      : [
          [e.playwright, generic.playwright],
          [e.repositories, generic.repositories],
          [e.logs, generic.logs],
          [e.tests, generic.tests],
        ];
    const badges = [
      target === 'LOCAL' ? `<span class="pill mu">${esc(e.default)}</span>` : '',
      target === saved ? `<span class="pill live">${esc(e.saved)}</span>` : '',
      measured ? `<span class="pill ok">${esc(e.measured)}</span>` : '',
    ].join('');
    return `<button type="button" role="radio" class="ws-ux-target" data-action="ws-ux-target" data-target="${target}" aria-checked="${String(checked)}" tabindex="${checked ? '0' : '-1'}"><span class="ws-ux-target-h"><span class="ws-ux-radio" aria-hidden="true">${checked ? icon('check') : ''}</span><b>${esc(t.targets[target])}</b>${badges}</span>${rows.map(([term, value]) => `<span class="ws-ux-cap"><span class="mu">${esc(term)}</span><span>${esc(value)}</span></span>`).join('')}${checked ? `<span class="sr">${esc(e.selected)}</span>` : ''}</button>`;
  }).join('');

  const fields =
    selected === 'ARO'
      ? `<fieldset class="ws-ux-fields"><legend>${esc(e.aroFields)}</legend><div class="fields">${ARO_REQUIRED.map((field) => envField(ctx, ui, field, { required: true, disabled })).join('')}${envField(ctx, ui, 'aro.apiServer', { required: false, disabled })}</div><small class="mu">${esc(e.required)}</small></fieldset>`
      : selected === 'REMOTE'
        ? `<fieldset class="ws-ux-fields"><legend>${esc(e.remoteFields)}</legend><div class="fields">${(['remote.namespace', 'remote.apiServer', 'remote.context'] as const).map((field) => envField(ctx, ui, field, { required: false, disabled })).join('')}</div></fieldset>`
        : '';

  const measuredBlock = capabilities
    ? `<div class="ws-ux-limits"><h3>${esc(e.measuredLimitations(t.targets[capabilities.target]))}</h3>${
        capabilities.limitations.length === 0
          ? `<p class="mu">${esc(e.noLimitation)}</p>`
          : `<ul class="checks">${capabilities.limitations.map((entry) => `<li class="ko">${icon('alert')}<span>${esc(entry)}</span></li>`).join('')}</ul>`
      }${capabilities.target !== selected ? `<p class="mu">${esc(e.measuredFor(t.targets[capabilities.target]))}</p>` : ''}</div>`
    : '';
  const limits = `<div class="ws-ux-limits"><h3>${esc(e.limitations)}</h3><ul class="plain tight">${e.known[selected].map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul></div>${measuredBlock}`;

  const dirty = environmentDirty(incident, ui);
  const problems =
    ui.invalid.length > 0
      ? `<p class="err" role="alert">${esc(e.invalid)}</p>`
      : ui.error
        ? `<p class="err" role="alert">${esc(ui.error)}</p>`
        : '';
  const footer = !runner
    ? `<p class="note">${icon('info')}<span>${esc(e.readOnly)}</span></p>`
    : `${problems}${locked ? `<p class="mu">${esc(e.locked(t.states[incident.state]))}</p>` : ''}<div class="form-acts start ws-ux-env-acts">${dirty ? `<span class="mu">${esc(e.dirty)}</span>` : ''}<button type="button" class="btn primary" data-action="ws-ux-target-save" aria-busy="${String(ui.saving)}"${disabled || !dirty ? ' disabled' : ''}>${esc(e.save)}</button>${dirty ? `<button type="button" class="btn ghost" data-action="ws-ux-target-reset"${ui.saving ? ' disabled' : ''}>${esc(e.reset)}</button>` : ''}</div>`;

  return `<section class="card ws-ux-env" aria-labelledby="ws-ux-env-t"><h2 id="ws-ux-env-t" class="fl">${esc(e.title)}</h2><p class="mu">${esc(e.sub)}</p><div class="ws-ux-targets" role="radiogroup" aria-labelledby="ws-ux-env-t">${cards}</div>${fields}${limits}${footer}</section>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/** Les styles de la structure (s'ajoutent à DASHBOARD_CSS et INCIDENT_PARTS_CSS) : jetons du thème seulement. */
export const INCIDENT_UX_CSS = `
.ws-ux-head{display:flex;flex-direction:column;gap:14px;padding:20px;border-radius:var(--qa-radius);background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-left:4px solid var(--qa-color-primary)}
.ws-ux-head-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.ws-ux-head-t{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1 1 320px}
.ws-ux-eyebrow{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ws-ux-head h1{margin:0;font-size:24px;line-height:1.25;font-weight:600;overflow-wrap:anywhere}
.ws-ux-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ws-ux-run{display:inline-flex;align-items:center;gap:6px}
.ws-ux-meta,.ws-ux-dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 18px;margin:0}
.ws-ux-meta>div,.ws-ux-dl>div{min-width:0;display:flex;flex-direction:column;gap:2px}
.ws-ux-dl>div.wide{grid-column:1 / -1}
.ws-ux-meta dt,.ws-ux-dl dt{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ws-ux-meta dd,.ws-ux-dl dd{margin:0;overflow-wrap:anywhere}
.ws-ux-stepper{display:flex;flex-direction:column;gap:6px;min-width:0;container:ws-ux-steps / inline-size}
.ws-ux-progress{margin:0;font-size:13px}
.ws-ux-stepper ol{position:relative;list-style:none;margin:0;padding:0 0 4px;display:flex;gap:4px;overflow-x:auto;background:linear-gradient(to right,var(--qa-color-background) 40%,transparent) left / 28px 100% no-repeat local,linear-gradient(to left,var(--qa-color-background) 40%,transparent) right / 28px 100% no-repeat local,radial-gradient(farthest-side at 0 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) left / 12px 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) right / 12px 100% no-repeat scroll}
.ws-ux-stage{flex:0 0 auto;min-width:96px;position:relative}
.ws-ux-stage+.ws-ux-stage::before{content:"";position:absolute;top:21px;left:-50%;right:50%;border-top:2px solid var(--qa-color-border);z-index:0}
.ws-ux-stage.ws-ux-s-done+.ws-ux-stage::before{border-top-color:var(--qa-color-success)}
.ws-ux-stage button{position:relative;z-index:1;width:100%;display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 2px 6px;min-height:44px;border:0;border-radius:10px;background:transparent;color:var(--qa-color-text);cursor:pointer;text-align:center}
.ws-ux-stage button:hover{background:var(--qa-color-surface-2)}
.ws-ux-stage button:focus-visible,.ws-ux-target:focus-visible,.ws-ux-req:focus-visible,.ws-ux-ev:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 60%,transparent);outline-offset:2px}
.ws-ux-dot{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:13px;border:2px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-muted)}
.ws-ux-dot .ico{width:16px;height:16px}
.ws-ux-stage-t{display:flex;flex-direction:column;gap:1px;min-width:0}
.ws-ux-stage-t b{font-size:13px;font-weight:600;overflow-wrap:normal;hyphens:manual}
.ws-ux-stage-t small{font-size:12px;color:var(--qa-color-muted);display:inline-flex;align-items:center;justify-content:center;gap:4px}
.ws-ux-s-done .ws-ux-dot{border-color:var(--qa-color-success);background:var(--qa-color-success-soft);color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.ws-ux-s-current .ws-ux-dot{border-color:var(--qa-color-primary);background:var(--qa-color-primary);color:var(--qa-color-surface)}
.ws-ux-s-current .ws-ux-stage-t small{color:var(--qa-color-primary);font-weight:600}
.ws-ux-s-blocked .ws-ux-dot{border-color:var(--qa-color-danger);border-style:dashed;background:var(--qa-color-danger-soft);color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.ws-ux-s-blocked .ws-ux-stage-t small{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));font-weight:600}
.ws-ux-s-todo .ws-ux-dot{border-style:dashed}
.ws-ux-s-running .ws-ux-dot{box-shadow:0 0 0 4px color-mix(in srgb,var(--qa-color-primary) 20%,transparent)}
.ws-ux-tabs{position:relative;flex-wrap:wrap;row-gap:0}
.ws-ux-tabs button{position:relative;white-space:nowrap}
.ws-ux-count{display:inline-flex;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);font-size:12px;align-items:center;justify-content:center;font-weight:600}
.ws-ux-panel{display:flex;flex-direction:column;gap:16px;min-width:0}
.ws-ux-panel:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:4px;border-radius:8px}
.ws-ux-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start}
.ws-ux-overview>.ws-demo,.ws-ux-next{grid-column:1 / -1}
.ws-ux-card p{margin:0}
.ws-ux-next{border-color:color-mix(in srgb,var(--qa-color-primary) 35%,var(--qa-color-border));background:color-mix(in srgb,var(--qa-color-primary) 5%,var(--qa-color-surface))}
.ws-ux-verdict{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ws-ux-reqs{gap:6px}
.ws-ux-req,.ws-ux-ev{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:40px;padding:6px 10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);color:var(--qa-color-text);cursor:pointer;text-align:left;max-width:100%}
.ws-ux-req:hover,.ws-ux-ev:hover{border-color:var(--qa-color-primary)}
.ws-ux-cause{padding:12px 14px;border-radius:12px;display:flex;flex-direction:column;gap:4px;border:1px solid var(--qa-color-border)}
.ws-ux-cause h3{margin:0}
.ws-ux-cause-confirmed{background:var(--qa-color-success-soft);border-color:color-mix(in srgb,var(--qa-color-success) 40%,transparent)}
.ws-ux-cause-probable{background:var(--qa-color-warning-soft);border-style:dashed;border-color:color-mix(in srgb,var(--qa-color-warning) 50%,transparent)}
.ws-ux-cause-inconclusive{background:var(--qa-color-surface-2);border-style:dotted}
.ws-ux-counts{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px 16px}
.ws-ux-counts li{display:flex;align-items:center;gap:6px}
.ws-ux-targets{display:flex;flex-wrap:wrap;gap:12px}
.ws-ux-target{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:14px;border:1px solid var(--qa-color-border-strong);border-radius:12px;background:var(--qa-color-surface);color:var(--qa-color-text);cursor:pointer;text-align:left}
.ws-ux-target:hover{border-color:var(--qa-color-primary)}
.ws-ux-target[aria-checked="true"]{border:2px solid var(--qa-color-primary);padding:13px;background:color-mix(in srgb,var(--qa-color-primary) 6%,var(--qa-color-surface))}
.ws-ux-target-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ws-ux-radio{width:20px;height:20px;border-radius:50%;border:2px solid var(--qa-color-border-strong);display:grid;place-items:center;flex:none;color:var(--qa-color-primary)}
.ws-ux-target[aria-checked="true"] .ws-ux-radio{border-color:var(--qa-color-primary)}
.ws-ux-radio .ico{width:12px;height:12px;stroke-width:3}
.ws-ux-cap{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;font-size:13px}
.ws-ux-fields{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-ux-fields legend{font-weight:600;padding:0;margin-bottom:8px}
.ws-ux-limits{display:flex;flex-direction:column;gap:6px}
.ws-ux-limits h3{margin:0}
.ws-ux-env-acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ws-ux-fields input[aria-invalid="true"]{border-color:var(--qa-color-danger);box-shadow:0 0 0 1px var(--qa-color-danger)}
.ws-ux-field-err{display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:500}
.ws-ux-field-err .ico{width:14px;height:14px;flex:none}
@container ws-ux-steps (min-width:600px){
  .ws-ux-stepper ol{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));row-gap:10px;overflow:visible;background:none}
  .ws-ux-stage{min-width:0}
  .ws-ux-stage:nth-child(5n+1)::before{display:none}
}
@container ws-ux-steps (min-width:1040px){
  .ws-ux-stepper ol{grid-template-columns:repeat(10,minmax(0,1fr))}
  .ws-ux-stage:nth-child(5n+1)::before{display:block}
}
.ws-ux-shell{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);grid-template-areas:"main" "graph" "aside"}
.ws-ux-main{grid-area:main;min-width:0}
.ws-ux-graph{grid-area:graph;min-width:0;overflow:auto}
.ws-ux-graph .ws-graph-canvas{max-height:clamp(320px,50vh,420px)}
.ws-ux-aside{grid-area:aside;min-width:0}
@container (min-width:960px){
  .ws-ux-shell{grid-template-areas:"graph" "main" "aside"}
}
@container (min-width:1280px){
  .ws-ux-shell{grid-template-columns:minmax(0,1fr) 340px;grid-template-areas:"graph graph" "main aside"}
  .ws-ux-aside{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto}
}
@container (max-width:600px){
  .ws-ux-head{padding:14px}
  .ws-ux-head h1{font-size:20px}
  .ws-ux-tabs button{padding:0 10px}
  .ws-ux-cap{grid-template-columns:minmax(0,1fr);gap:0}
  .ws-ux-overview{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){.ws-ux-s-running .ws-ux-dot{box-shadow:none}}
`;
