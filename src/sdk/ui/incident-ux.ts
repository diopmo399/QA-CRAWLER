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
import type { EnvironmentCheck, EnvironmentInput, EnvironmentKind } from '../core/contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import {
  demoBanner,
  panelState,
  partsText,
  selectable,
  selectionClass,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { INCIDENT_SCOPE_CSS } from './incident-scope.js';
import { INCIDENT_SCOPE_DISCOVERY_CSS } from './incident-scope-discovery.js';
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
  /** Le test de connectivité est en cours. */
  checking?: boolean;
  /** Le dernier test de connectivité, par clé de cible (`connectivityTargets`). */
  connectivity?: Record<string, Connectivity>;
  /** Le test de connectivité n'a pas pu être lancé. */
  checkError?: string;
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
 * des virgules), `ws-ux-saved`, `ws-ux-error` (`message`). Le test de connectivité : `ws-ux-check` (lancé),
 * `ws-ux-check-error` (`message`) ; ses résultats arrivent par `withConnectivity`. `ws-ux-stage` et
 * `ws-ux-tab` sont de la navigation (route) : non traitées ici.
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
    case 'ws-ux-check':
      return { ...ui, checking: true, connectivity: undefined, checkError: undefined };
    case 'ws-ux-check-error':
      return { ...ui, checking: false, checkError: dataset.message ?? '' };
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

// ── Connectivité ─────────────────────────────────────────────────────────────────────────────

/** L'environnement du projet de l'incident (son URL de base est celle du frontend). */
export interface EnvironmentRef {
  id: string;
  name: string;
  kind: EnvironmentKind;
  baseUrl: string;
}

/** Une URL à vérifier : celle de l'environnement du projet ou celle d'une application du périmètre. */
export interface ConnectivityTarget {
  /** `environment`, ou `app:<id>`. */
  key: string;
  role: 'FRONTEND' | 'BFF' | 'BACKEND';
  /** Le nom de l'environnement ou de l'application. */
  label: string;
  url: string;
}

/** Le résultat d'une URL, tel que le serveur l'a mesuré (`EnvironmentCheck.url`) ou l'erreur de l'appel. */
export interface Connectivity {
  url: string;
  formatOk: boolean;
  /** Absent : aucune requête faite (format invalide, appel en échec). */
  reachable?: boolean;
  status?: number;
  durationMs?: number;
  message?: string;
}

/** Les URL connues de l'incident : l'environnement du projet (frontend), puis les applications qui en ont une. */
export function connectivityTargets(incident: Incident, environment?: EnvironmentRef): ConnectivityTarget[] {
  const targets: ConnectivityTarget[] = [];
  const seen = new Set<string>();
  const add = (target: ConnectivityTarget): void => {
    const url = target.url.trim();
    // La même URL pour la même couche n'est testée qu'une fois ; une autre couche la garde (rien n'est caché).
    if (!url || seen.has(`${target.role} ${url}`)) return;
    seen.add(`${target.role} ${url}`);
    targets.push({ ...target, url });
  };
  if (environment)
    add({ key: 'environment', role: 'FRONTEND', label: environment.name, url: environment.baseUrl });
  for (const app of incident.scope.applications)
    if (app.baseUrl) add({ key: `app:${app.id}`, role: app.layer, label: app.name, url: app.baseUrl });
  return targets;
}

/**
 * L'appel du test d'une URL : `client.environments.check(projectId, input, options)`. Le serveur ne joint
 * que `baseUrl` (`reach: true`) ; les autres remarques de la vérification (nom, variables) ne sont pas lues.
 */
export function connectivityInput(
  target: ConnectivityTarget,
  environment?: EnvironmentRef,
): { input: EnvironmentInput; options: { reach: true; selfId?: string } } {
  return {
    input: {
      name: environment?.name ?? target.label,
      kind: environment?.kind ?? 'OTHER',
      baseUrl: target.url,
    },
    options: { reach: true, ...(environment ? { selfId: environment.id } : {}) },
  };
}

/** Le résultat d'une URL d'après la vérification du serveur (format, puis joignabilité mesurée). */
export function connectivityOf(url: string, check: EnvironmentCheck): Connectivity {
  const result = check.url;
  if (!result)
    return {
      url,
      formatOk: false,
      message: check.issues.find((issue) => issue.field === 'baseUrl')?.message,
    };
  if (!result.format.ok)
    return { url, formatOk: false, ...(result.format.message ? { message: result.format.message } : {}) };
  const reach = result.reachable;
  if (!reach) return { url, formatOk: true };
  return {
    url,
    formatOk: true,
    reachable: reach.ok,
    durationMs: reach.durationMs,
    ...(reach.status !== undefined ? { status: reach.status } : {}),
    ...(reach.message ? { message: reach.message } : {}),
  };
}

/** L'appel de vérification a échoué (droits, réseau du Dashboard) : rien n'a été mesuré. */
export const connectivityFailure = (url: string, message: string): Connectivity => ({
  url,
  formatOk: true,
  message,
});

/** Les résultats arrivés : le test est terminé. */
export const withConnectivity = (ui: UxUi, results: Record<string, Connectivity>): UxUi => ({
  ...ui,
  checking: false,
  checkError: undefined,
  connectivity: results,
});

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
  /** Les libellés courts de la ligne des dix étapes. */
  stagesShort: {
    description: 'Description',
    scope: 'Périmètre',
    environment: 'Environnement',
    reproduction: 'Reproduction',
    evidence: 'Preuves',
    code: 'Analyse',
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
  subTabsLabel: (tab: string) => `Vues de « ${tab} »`,
  count: (count: number) => `${String(count)} élément(s)`,
  mainTabs: {
    overview: 'Vue d’ensemble',
    timeline: 'Reproduction',
    traceability: 'Traçabilité',
    code: 'Code',
    diagnosis: 'Diagnostic',
    trigger: 'Déclencheurs',
    report: 'Rapport',
  } as Record<string, string>,
  subTabs: {
    summary: 'Résumé',
    scope: 'Périmètre',
    environment: 'Environnement',
    run: 'Exécution',
    evidence: 'Preuves',
    events: 'Chronologie',
    logs: 'Journaux',
    fullstack: 'Full Stack',
    frontend: 'Frontend',
    bff: 'BFF',
    backend: 'Backend',
    http: 'HTTP',
    diagnosis: 'Diagnostic',
    hypotheses: 'Hypothèses',
    experiments: 'Expériences',
    ai: 'Investigation IA',
    brief: 'Incident',
    discovery: 'Périmètre découvert',
    explorer: 'Explorateur',
    live: 'Exécution',
    chronology: 'Chronologie',
    matrix: 'Matrice',
    minimal: 'Reproduction minimale',
    angular: 'Code Angular',
    causes: 'Causes',
    proposal: 'Test proposé',
    report: 'Rapport',
    regression: 'Non-régression',
  } as Record<string, string>,
  details: 'Détails',
  detailsShow: 'Afficher les détails de l’incident',
  detailsHide: 'Masquer les détails de l’incident',
  reference: 'Reproduction de référence',
  noReference: 'Aucune reproduction terminée',
  stepperShow: 'Afficher les dix étapes',
  stepperHide: 'Replier la progression',
  stepNow: 'Étape actuelle',
  stepDone: 'Investigation complète',
  stepOf: (index: number, total: number) => `${String(index)}/${String(total)}`,
  stepOfLong: (index: number, total: number) => `étape ${String(index)} sur ${String(total)}`,
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
    screenTitle: 'Sélection de l’environnement',
    screenSub: 'Choix entre LOCAL, REMOTE ou ARO : où QA-CRAWLER et Playwright s’exécutent.',
    cardTitles: { LOCAL: 'LOCAL', REMOTE: 'REMOTE', ARO: 'ARO (OpenShift)' } as Record<
      ExecutionTarget,
      string
    >,
    generalCase: 'Cas général (non mesuré)',
    selectedConfig: (target: string) => `Configuration sélectionnée : ${target}`,
    urlFrontend: 'URL Frontend',
    urlBff: 'URL BFF',
    urlBackend: 'URL Backend',
    repositoriesRow: 'Dépôts',
    mountRow: 'Montage des dépôts',
    namespaceRow: 'Namespace',
    notGiven: 'non indiquée',
    notGivenPlural: 'aucun',
    check: 'Tester la connectivité',
    checking: 'Vérification…',
    checkFrom: 'Chaque URL est jointe depuis le serveur QA-CRAWLER (une requête, sans effet de bord).',
    noUrl:
      'Aucune URL connue : ni l’environnement du projet ni les applications du périmètre n’en indiquent.',
    checkFailed: (message: string) => `Test de connectivité impossible : ${message}`,
    reachable: (status: string, ms: number) =>
      `Joignable${status ? ` · HTTP ${status}` : ''} · ${String(ms)} ms`,
    unreachable: (message: string, ms?: number) =>
      `Injoignable${message ? ` : ${message}` : ''}${ms !== undefined ? ` (${String(ms)} ms)` : ''}`,
    badFormat: (message: string) => `Format invalide${message ? ` : ${message}` : ''}`,
    notMeasured: (message: string) => `Non mesurée${message ? ` : ${message}` : ''}`,
    next: 'Étape suivante',
    nextHint: 'Ouvre « Reproduction ».',
    saveFirst: 'Enregistrer l’environnement choisi avant de passer à l’étape suivante.',
    knownLimits: 'Limites connues',
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
  stagesShort: {
    description: 'Description',
    scope: 'Scope',
    environment: 'Environment',
    reproduction: 'Reproduction',
    evidence: 'Evidence',
    code: 'Analysis',
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
  subTabsLabel: (tab) => `Views of “${tab}”`,
  count: (count) => `${String(count)} item(s)`,
  mainTabs: {
    overview: 'Overview',
    timeline: 'Reproduction',
    traceability: 'Traceability',
    code: 'Code',
    diagnosis: 'Diagnosis',
    trigger: 'Triggers',
    report: 'Report',
  },
  subTabs: {
    summary: 'Summary',
    scope: 'Scope',
    environment: 'Environment',
    run: 'Run',
    evidence: 'Evidence',
    events: 'Timeline',
    logs: 'Logs',
    fullstack: 'Full Stack',
    frontend: 'Frontend',
    bff: 'BFF',
    backend: 'Backend',
    http: 'HTTP',
    diagnosis: 'Diagnosis',
    hypotheses: 'Hypotheses',
    experiments: 'Experiments',
    report: 'Report',
    regression: 'Non-regression',
  },
  details: 'Details',
  detailsShow: 'Show the incident details',
  detailsHide: 'Hide the incident details',
  reference: 'Reference reproduction',
  noReference: 'No completed reproduction',
  stepperShow: 'Show the ten steps',
  stepperHide: 'Fold the progress',
  stepNow: 'Current step',
  stepDone: 'Investigation complete',
  stepOf: (index, total) => `${String(index)}/${String(total)}`,
  stepOfLong: (index, total) => `step ${String(index)} of ${String(total)}`,
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
    ai: 'AI investigation',
    brief: 'Incident',
    discovery: 'Discovered scope',
    explorer: 'Explorer',
    live: 'Execution',
    chronology: 'Timeline',
    matrix: 'Matrix',
    minimal: 'Minimal reproduction',
    angular: 'Angular code',
    causes: 'Causes',
    proposal: 'Proposed test',
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
    screenTitle: 'Environment selection',
    screenSub: 'Choose LOCAL, REMOTE or ARO: where QA-CRAWLER and Playwright run.',
    cardTitles: { LOCAL: 'LOCAL', REMOTE: 'REMOTE', ARO: 'ARO (OpenShift)' },
    generalCase: 'General case (not measured)',
    selectedConfig: (target) => `Selected configuration: ${target}`,
    urlFrontend: 'Frontend URL',
    urlBff: 'BFF URL',
    urlBackend: 'Backend URL',
    repositoriesRow: 'Repositories',
    mountRow: 'Repository mount',
    namespaceRow: 'Namespace',
    notGiven: 'not given',
    notGivenPlural: 'none',
    check: 'Test connectivity',
    checking: 'Checking…',
    checkFrom: 'Each URL is reached from the QA-CRAWLER server (one request, no side effect).',
    noUrl: 'No known URL: neither the project environment nor the scope applications give one.',
    checkFailed: (message) => `Connectivity test impossible: ${message}`,
    reachable: (status, ms) => `Reachable${status ? ` · HTTP ${status}` : ''} · ${String(ms)} ms`,
    unreachable: (message, ms) =>
      `Unreachable${message ? `: ${message}` : ''}${ms !== undefined ? ` (${String(ms)} ms)` : ''}`,
    badFormat: (message) => `Invalid format${message ? `: ${message}` : ''}`,
    notMeasured: (message) => `Not measured${message ? `: ${message}` : ''}`,
    next: 'Next step',
    nextHint: 'Opens “Reproduction”.',
    saveFirst: 'Save the chosen environment before going to the next step.',
    knownLimits: 'Known limitations',
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

/**
 * La progression. Repliée (par défaut) : UNE ligne fine des dix étapes numérotées (numéro, libellé court ;
 * l'étape actuelle mise en avant et `aria-current="step"`, une étape terminée marquée d'une coche, une étape
 * bloquée d'une alerte), chaque étape un bouton (`ws-ux-stage`) ; la ligne défile horizontalement sans
 * couper un libellé, et finit par « n/10 ». Le bouton `ws-ux-stepper` déplie la liste ordonnée complète
 * (`#ws-ux-steps`, statut écrit de chaque étape), préférence `stepper`.
 */
export function renderStepper(ctx: WorkspaceContext, opts: { open?: boolean } = {}): string {
  const t = TEXT[ctx.lang];
  const open = opts.open ?? true;
  const progress = workspaceProgress(ctx.incident);
  const total = progress.stages.length;
  const currentIndex = progress.current ? WORKSPACE_STAGES.indexOf(progress.current) + 1 : total;
  const percent = Math.round((progress.done / Math.max(1, total)) * 100);
  const blocked = progress.stages.some((stage) => stage.status === 'BLOCKED');
  const marker = (status: StageStatus, index: number): string =>
    status === 'DONE'
      ? icon('check')
      : status === 'BLOCKED'
        ? icon('alert')
        : `<span>${String(index + 1)}</span>`;
  const toggle = `<button type="button" class="ws-ux-step-toggle" data-action="ws-ux-stepper" aria-expanded="${String(open)}"${open ? ' aria-controls="ws-ux-steps"' : ''} title="${esc(open ? t.stepperHide : t.stepperShow)}">${icon(open ? 'up' : 'down')}<span class="sr">${esc(open ? t.stepperHide : t.stepperShow)}</span></button>`;
  const running = progress.running
    ? `<span class="pill live ws-ux-run"><span class="spin sm" aria-hidden="true"></span>${esc(`${t.stages[progress.running]} : ${t.running.toLowerCase()}`)}</span>`
    : '';
  const count = `<span class="ws-ux-step-n" aria-label="${esc(t.stepOfLong(currentIndex, total))}">${esc(t.stepOf(currentIndex, total))}</span>`;
  if (!open) {
    const steps = progress.stages
      .map((stage, index) => {
        const isRunning = progress.running === stage.key;
        const status = isRunning ? t.running : t.stageStatus[stage.status];
        const full = t.stages[stage.key];
        return `<li class="ws-ux-sr ws-ux-s-${stage.status.toLowerCase()}${isRunning ? ' ws-ux-s-running' : ''}"><button type="button" data-action="ws-ux-stage" data-stage="${stage.key}"${progress.current === stage.key ? ' aria-current="step"' : ''} title="${esc(`${String(index + 1)}. ${full} — ${status}`)}"><span class="ws-ux-sn" aria-hidden="true">${isRunning ? '<span class="spin sm"></span>' : marker(stage.status, index)}</span><span class="sr">${String(index + 1)}. </span><span class="ws-ux-sl">${esc(t.stagesShort[stage.key])}</span><span class="sr"> (${esc(status)})</span></button></li>`;
      })
      .join('');
    return `<nav class="ws-ux-stepper ws-ux-stepper-row" aria-label="${esc(t.progress)}"><div class="ws-ux-step-row">${toggle}<ol class="ws-ux-steps-row">${steps}</ol>${count}${running}</div></nav>`;
  }
  const items = progress.stages
    .map((stage, index) => {
      const isRunning = progress.running === stage.key;
      const status = isRunning ? t.running : t.stageStatus[stage.status];
      return `<li class="ws-ux-stage ws-ux-s-${stage.status.toLowerCase()}${isRunning ? ' ws-ux-s-running' : ''}"><button type="button" data-action="ws-ux-stage" data-stage="${stage.key}"${progress.current === stage.key ? ' aria-current="step"' : ''}><span class="ws-ux-dot" aria-hidden="true">${marker(stage.status, index)}</span><span class="ws-ux-stage-t"><b>${esc(t.stages[stage.key])}</b><small>${isRunning ? '<span class="spin sm" aria-hidden="true"></span>' : ''}${esc(status)}</small></span></button></li>`;
    })
    .join('');
  const now = progress.current
    ? `<span class="ws-ux-step-now"><span class="mu">${esc(t.stepNow)} :</span> <b class="${blocked ? 'ws-ux-step-blocked' : ''}">${esc(t.stages[progress.current])}</b>${blocked ? `<span class="sr"> (${esc(t.stageStatus.BLOCKED)})</span>` : ''}</span>`
    : `<span class="ws-ux-step-now">${icon('check')}<b>${esc(t.stepDone)}</b></span>`;
  const row = `<div class="ws-ux-step-row">${toggle}${now}${count}<span class="ws-ux-step-bar${blocked ? ' ws-ux-step-bar-ko' : ''}" role="img" aria-label="${esc(t.progressCount(progress.done, total))}"><span style="width:${String(percent)}%"></span></span><span class="ws-ux-progress mu">${esc(t.progressCount(progress.done, total))}</span>${running}</div>`;
  return `<nav class="ws-ux-stepper ws-ux-stepper-open" aria-label="${esc(t.progress)}">${row}<ol id="ws-ux-steps">${items}</ol></nav>`;
}

// ── En-tête ──────────────────────────────────────────────────────────────────────────────────

/**
 * L'en-tête compact : une ligne (retour, titre tronqué avec son infobulle, gravité, état, diagnostic,
 * environnement, actions) et une divulgation « Détails » (`ws-ux-details`, aria-expanded) pour le
 * scénario, la description, l'observé et l'attendu, la mise à jour et la reproduction de référence. Le
 * bandeau de démonstration reste toujours visible, une seule fois pour tout l'espace et sur une ligne : le
 * détail est dans son infobulle et dans la note `#ws-demo-why` (`demoNote`, lue par les lecteurs d'écran,
 * référencée par aria-describedby sur chaque bouton désactivé).
 */
export function renderWorkspaceHeader(
  ctx: WorkspaceContext,
  actions: string,
  opts: { back?: string; open?: boolean; demoNote?: string } = {},
): string {
  const t = TEXT[ctx.lang];
  const o = t.overview;
  const incident = ctx.incident;
  const open = opts.open ?? false;
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
    `<span class="ws-ux-env" title="${esc(incident.environmentId ? t.projectEnvironment(incident.environmentId) : t.firstEnvironment)}"><span class="sr">${esc(t.environment)} : </span><b>${esc(t.targets[incident.execution.target])}</b></span>`,
  ].join('');
  const toggle = `<button type="button" class="btn small ghost ws-ux-more" data-action="ws-ux-details" aria-expanded="${String(open)}"${open ? ' aria-controls="ws-ux-head-more"' : ''} title="${esc(open ? t.detailsHide : t.detailsShow)}">${icon(open ? 'up' : 'down')}<span>${esc(t.details)}</span></button>`;
  const reproduction = incidentReproduction(incident);
  const verdict = reproduction
    ? `${esc(o.reproduced[String(reproduction.reproduced) as 'true' | 'false' | 'null'])} <small class="mu">${esc(o.run(reproduction.id, formatDate(reproduction.finishedAt ?? reproduction.startedAt, ctx.lang)))}</small>`
    : `<span class="mu">${esc(t.noReference)}</span>`;
  const environment = `<b>${esc(t.targets[incident.execution.target])}</b> <small class="mu">${esc(
    incident.environmentId ? t.projectEnvironment(incident.environmentId) : t.firstEnvironment,
  )}</small>`;
  const more = open
    ? `<div class="ws-ux-head-more" id="ws-ux-head-more"><dl class="ws-ux-meta">${fact(t.investigation, `<code>${esc(incident.id)}</code>`)}${fact(t.environment, environment)}${fact(
        t.scenario,
        incident.scenario ? esc(incident.scenario) : `<span class="mu">${esc(t.noScenario)}</span>`,
      )}${fact(t.updated, `<time datetime="${esc(incident.updatedAt)}">${esc(formatDate(incident.updatedAt, ctx.lang))}</time>`)}${fact(o.observed, esc(incident.observed))}${fact(o.expected, esc(incident.expected))}${fact(t.reference, verdict)}<div class="wide"><dt>${esc(o.description)}</dt><dd>${incident.description ? esc(incident.description) : `<span class="mu">${esc(o.noDescription)}</span>`}</dd></div></dl></div>`
    : '';
  const banner = demoBanner(ctx, true);
  const demo = banner
    ? `<div class="ws-ux-demo" title="${esc(`${partsText(ctx.lang).demoHint}${opts.demoNote ? ` ${opts.demoNote}` : ''}`)}">${banner}${opts.demoNote ? `<p class="sr" id="ws-demo-why">${esc(opts.demoNote)}</p>` : ''}</div>`
    : '';
  return `<header class="ws-ux-head" aria-labelledby="ws-ux-title"><div class="ws-ux-head-top">${opts.back ?? ''}<div class="ws-ux-head-t"><h1 id="ws-ux-title" title="${esc(incident.title)}">${esc(incident.title)}</h1><div class="ws-ux-tags">${tags}</div></div><div class="acts" role="group" aria-label="${esc(t.actions)}">${actions}${toggle}</div></div>${demo}${more}</header>`;
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

/**
 * Une liste d'onglets : tabindex itinérant (flèches, Début, Fin via rovingTarget). Les onglets principaux
 * (`ws-ux-tab`, `data-tab`, id `ws-ux-tab-<clé>`) ou les sous-onglets (`ws-ux-sub`, `data-sub`, id
 * `ws-ux-sub-<clé>`) ; tous commandent le panneau `ws-ux-panel`. `tools` : des outils à droite de la barre.
 */
export function renderTabs(
  ctx: WorkspaceContext,
  tabs: UxTab[],
  current: string,
  opts: { kind?: 'main' | 'sub'; label?: string; tools?: string } = {},
): string {
  const t = TEXT[ctx.lang];
  const sub = opts.kind === 'sub';
  const list = `<div class="tabs ws-ux-tabs${sub ? ' ws-ux-subtabs' : ''}" role="tablist" aria-label="${esc(opts.label ?? t.tabsLabel)}" aria-orientation="horizontal">${tabs
    .map((tab) => {
      const selected = tab.key === current;
      const ident = sub
        ? `id="ws-ux-sub-${esc(tab.key)}" data-action="ws-ux-sub" data-sub="${esc(tab.key)}"`
        : `id="ws-ux-tab-${esc(tab.key)}" data-action="ws-ux-tab" data-tab="${esc(tab.key)}"`;
      return `<button type="button" role="tab" ${ident} aria-selected="${String(selected)}" aria-controls="ws-ux-panel" tabindex="${selected ? '0' : '-1'}">${esc(tab.label)}${tab.count !== undefined ? ` <span class="ws-ux-count"><span aria-hidden="true">${String(tab.count)}</span><span class="sr">${esc(t.count(tab.count))}</span></span>` : ''}</button>`;
    })
    .join('')}</div>`;
  return opts.tools !== undefined
    ? `<div class="ws-ux-tabbar${sub ? ' ws-ux-subbar' : ''}">${list}<div class="ws-ux-tabtools">${opts.tools}</div></div>`
    : list;
}

/** Le panneau de l'onglet courant, relié à son onglet (`labelledBy` : l'identifiant de l'onglet). */
export const renderTabPanel = (current: string, body: string, labelledBy?: string, cls = ''): string =>
  `<div id="ws-ux-panel" class="ws-ux-panel${cls ? ` ${cls}` : ''}" role="tabpanel" aria-labelledby="${esc(labelledBy ?? `ws-ux-tab-${current}`)}"${labelledBy ? '' : ' tabindex="0"'}>${body}</div>`;

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

const TARGET_ICONS: Record<ExecutionTarget, string> = {
  LOCAL: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  REMOTE:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  ARO: '<path d="M7 18h10a4 4 0 00.6-7.95A6 6 0 006.3 9.4 4.4 4.4 0 007 18z"/>',
};

const targetIcon = (target: ExecutionTarget): string =>
  `<svg class="ico ws-ux-tg-ico" viewBox="0 0 24 24" aria-hidden="true">${TARGET_ICONS[target]}</svg>`;

/** Le résultat affiché d'une URL testée. */
function connectivityPill(lang: Lang, result: Connectivity): string {
  const e = TEXT[lang].env;
  if (!result.formatOk) return `<span class="pill warn">${esc(e.badFormat(result.message ?? ''))}</span>`;
  if (result.reachable === true)
    return `<span class="pill ok">${icon('check')}${esc(e.reachable(result.status !== undefined ? String(result.status) : '', result.durationMs ?? 0))}</span>`;
  if (result.reachable === false)
    return `<span class="pill ko">${icon('cross')}${esc(e.unreachable(result.message ?? '', result.durationMs))}</span>`;
  return `<span class="pill mu">${esc(e.notMeasured(result.message ?? ''))}</span>`;
}

/**
 * Le choix LOCAL / REMOTE / ARO : trois cartes en groupe de boutons radio (`ws-ux-target`, flèches par le
 * contrôleur via rovingTarget), ce que chaque cible permet (mesuré quand `capabilities` vaut pour elle,
 * sinon le cas général, dit comme tel), les champs OpenShift (REMOTE, facultatifs) ou ARO (obligatoires),
 * l'encadré « Configuration sélectionnée » (URL de l'environnement du projet `opts.environment` et des
 * applications du périmètre, dépôts), le test de connectivité (`ws-ux-check`, résultats par URL dans
 * `ui.connectivity`), l'enregistrement (`ws-ux-target-save`) et « Étape suivante » (`ws-ux-stage`,
 * `reproduction` ; désactivée tant que le choix n'est pas enregistré).
 */
export function renderEnvironmentSelector(
  ctx: WorkspaceContext,
  ui: UxUi,
  capabilities?: EnvironmentCapabilities,
  opts: { environment?: EnvironmentRef } = {},
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
    const rows: [string, string, 'ok' | 'ko' | 'gen'][] = measured
      ? [
          [e.playwright, e.playwrightKinds[measured.playwright] ?? measured.playwright, 'ok'],
          [e.repositories, e.repositoryKinds[measured.repositories] ?? measured.repositories, 'ok'],
          [e.logs, e.logKinds[measured.logs] ?? measured.logs, measured.logs === 'NONE' ? 'ko' : 'ok'],
          [e.tests, measured.tests ? e.available : e.unavailable, measured.tests ? 'ok' : 'ko'],
          [
            e.jobs,
            measured.kubernetesJobs ? e.available : e.unavailable,
            measured.kubernetesJobs ? 'ok' : 'ko',
          ],
        ]
      : [
          [e.playwright, generic.playwright, 'gen'],
          [e.repositories, generic.repositories, 'gen'],
          [e.logs, generic.logs, 'gen'],
          [e.tests, generic.tests, 'gen'],
        ];
    const badges = [
      target === 'LOCAL' ? `<span class="pill mu">${esc(e.default)}</span>` : '',
      target === saved ? `<span class="pill live">${esc(e.saved)}</span>` : '',
      measured ? `<span class="pill ok">${esc(e.measured)}</span>` : '',
    ].join('');
    const id = `ws-ux-tg-${target}`;
    const bullet = (kind: 'ok' | 'ko' | 'gen'): string =>
      `<span class="ws-ux-cap-i ws-ux-cap-${kind}" aria-hidden="true">${kind === 'ok' ? icon('check') : kind === 'ko' ? icon('cross') : ''}</span>`;
    return `<button type="button" role="radio" class="ws-ux-target" data-action="ws-ux-target" data-target="${target}" aria-checked="${String(checked)}" tabindex="${checked ? '0' : '-1'}" aria-labelledby="${id}-t" aria-describedby="${id}-d"><span class="ws-ux-radio" aria-hidden="true">${checked ? icon('check') : ''}</span><span class="ws-ux-tg-top">${targetIcon(target)}<b id="${id}-t" class="ws-ux-tg-t">${esc(e.cardTitles[target])}<span class="sr"> — ${esc(t.targets[target])}${checked ? ` (${esc(e.selected)})` : ''}</span></b><small class="mu" aria-hidden="true">${esc(t.targets[target])}</small><span class="ws-ux-target-h">${badges}</span></span><span class="ws-ux-caps" id="${id}-d">${rows.map(([term, value, kind]) => `<span class="ws-ux-cap">${bullet(kind)}<span><span class="mu">${esc(term)} : </span>${esc(value)}</span></span>`).join('')}${measured ? '' : `<small class="mu ws-ux-gen">${esc(e.generalCase)}</small>`}</span></button>`;
  }).join('');

  const fields =
    selected === 'ARO'
      ? `<fieldset class="ws-ux-fields"><legend>${esc(e.aroFields)}</legend><div class="fields">${ARO_REQUIRED.map((field) => envField(ctx, ui, field, { required: true, disabled })).join('')}${envField(ctx, ui, 'aro.apiServer', { required: false, disabled })}</div><small class="mu">${esc(e.required)}</small></fieldset>`
      : selected === 'REMOTE'
        ? `<fieldset class="ws-ux-fields"><legend>${esc(e.remoteFields)}</legend><div class="fields">${(['remote.namespace', 'remote.apiServer', 'remote.context'] as const).map((field) => envField(ctx, ui, field, { required: false, disabled })).join('')}</div></fieldset>`
        : '';

  // L'encadré « Configuration sélectionnée » : les URL connues, testables, et les dépôts.
  const targets = connectivityTargets(incident, opts.environment);
  const urlRow = (term: string, role: ConnectivityTarget['role']): string => {
    const list = targets.filter((target) => target.role === role);
    const value =
      list.length === 0
        ? `<span class="mu">${esc(e.notGiven)}</span>`
        : `<ul class="plain ws-ux-urls">${list
            .map((target) => {
              const result = ui.connectivity?.[target.key];
              const state = ui.checking
                ? `<span class="pill mu"><span class="spin sm" aria-hidden="true"></span>${esc(e.checking)}</span>`
                : result
                  ? connectivityPill(ctx.lang, result)
                  : '';
              return `<li><code title="${esc(target.label)}">${esc(target.url)}</code>${state}</li>`;
            })
            .join('')}</ul>`;
    return `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;
  };
  const roots = incident.scope.applications.map((app) => app.repository.root);
  const mount = selected === 'ARO' ? uxFieldValue(incident, ui, 'aro.repositoriesMount').trim() : '';
  const namespace =
    selected === 'ARO'
      ? uxFieldValue(incident, ui, 'aro.namespace').trim()
      : selected === 'REMOTE'
        ? uxFieldValue(incident, ui, 'remote.namespace').trim()
        : '';
  const config = `<dl class="ws-ux-config-dl">${urlRow(e.urlFrontend, 'FRONTEND')}${urlRow(e.urlBff, 'BFF')}${urlRow(e.urlBackend, 'BACKEND')}<div><dt>${esc(e.repositoriesRow)}</dt><dd>${
    roots.length === 0
      ? `<span class="mu">${esc(e.notGivenPlural)}</span>`
      : `<ul class="plain ws-ux-urls">${roots.map((root) => `<li><code>${esc(root)}</code></li>`).join('')}</ul>`
  }</dd></div>${selected === 'ARO' ? `<div><dt>${esc(e.mountRow)}</dt><dd>${mount ? `<code>${esc(mount)}</code>` : `<span class="mu">${esc(e.notGiven)}</span>`}</dd></div>` : ''}${
    selected !== 'LOCAL'
      ? `<div><dt>${esc(e.namespaceRow)}</dt><dd>${namespace ? `<code>${esc(namespace)}</code>` : `<span class="mu">${esc(e.notGiven)}</span>`}</dd></div>`
      : ''
  }</dl>`;

  const measuredBlock = capabilities
    ? `<div class="ws-ux-limits"><h3>${esc(e.measuredLimitations(t.targets[capabilities.target]))}</h3>${
        capabilities.limitations.length === 0
          ? `<p class="mu">${esc(e.noLimitation)}</p>`
          : `<ul class="checks">${capabilities.limitations.map((entry) => `<li class="ko">${icon('alert')}<span>${esc(entry)}</span></li>`).join('')}</ul>`
      }${capabilities.target !== selected ? `<p class="mu">${esc(e.measuredFor(t.targets[capabilities.target]))}</p>` : ''}</div>`
    : '';
  const limits = `<details class="ws-ux-limits-d"${capabilities && capabilities.limitations.length > 0 ? ' open' : ''}><summary>${esc(e.knownLimits)}</summary><div class="ws-ux-limits"><h3>${esc(e.limitations)}</h3><ul class="plain tight">${e.known[selected].map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul></div>${measuredBlock}</details>`;

  const dirty = environmentDirty(incident, ui);
  const problems =
    ui.invalid.length > 0
      ? `<p class="err" role="alert">${esc(e.invalid)}</p>`
      : ui.error
        ? `<p class="err" role="alert">${esc(ui.error)}</p>`
        : '';
  const checkProblem = ui.checkError
    ? `<p class="err" role="alert">${esc(e.checkFailed(ui.checkError))}</p>`
    : '';
  const canCheck = runner && !ctx.demo && targets.length > 0 && ui.checking !== true;
  const check = runner
    ? `<button type="button" class="btn" data-action="ws-ux-check" aria-busy="${String(ui.checking === true)}" aria-describedby="ws-ux-check-h"${canCheck ? '' : ' disabled'}>${icon('refresh')}<span>${esc(e.check)}</span></button>`
    : '';
  const next = `<button type="button" class="btn${dirty ? '' : ' primary'}" data-action="ws-ux-stage" data-stage="reproduction" aria-describedby="ws-ux-next-h"${dirty ? ' disabled' : ''}><span>${esc(e.next)}</span>${icon('right')}</button><small id="ws-ux-next-h" class="${dirty ? 'mu' : 'sr'}">${esc(dirty ? e.saveFirst : e.nextHint)}</small>`;
  const save =
    runner && dirty
      ? `<button type="button" class="btn ghost" data-action="ws-ux-target-reset"${ui.saving ? ' disabled' : ''}>${esc(e.reset)}</button><button type="button" class="btn primary" data-action="ws-ux-target-save" aria-busy="${String(ui.saving)}"${disabled ? ' disabled' : ''}>${esc(e.save)}</button>`
      : '';
  const notes = !runner
    ? `<p class="note">${icon('info')}<span>${esc(e.readOnly)}</span></p>`
    : `${problems}${locked ? `<p class="mu">${esc(e.locked(t.states[incident.state]))}</p>` : ''}`;
  const configBox = `<section class="ws-ux-config${dirty ? ' ws-ux-config-dirty' : ''}" aria-labelledby="ws-ux-config-t"><div class="ws-ux-config-h"><span class="ws-ux-config-i" aria-hidden="true">${icon('check')}</span><h3 id="ws-ux-config-t">${esc(e.selectedConfig(e.cardTitles[selected]))}</h3>${dirty ? `<span class="pill warn">${esc(e.dirty)}</span>` : ''}</div><div class="ws-ux-config-b">${config}<div class="ws-ux-config-acts">${check}${save}${next}</div></div><small id="ws-ux-check-h" class="mu">${esc(targets.length === 0 ? e.noUrl : e.checkFrom)}</small>${checkProblem}</section>`;

  return `<section class="card ws-ux-envsel" aria-labelledby="ws-ux-env-t"><h2 id="ws-ux-env-t" class="fl">${esc(e.screenTitle)}</h2><p class="mu">${esc(e.screenSub)}</p><div class="ws-ux-targets" role="radiogroup" aria-labelledby="ws-ux-env-t">${cards}</div>${fields}${notes}${configBox}${limits}</section>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/**
 * Les styles des écrans « Liste des incidents » (`inc-l-`) et « Création d'un incident » (`inc-cf-`), rendus
 * par dashboard-incidents.ts : jetons du thème seulement, clair et sombre.
 */
export const INCIDENT_FLOW_CSS = `
.inc-l{gap:10px}
.inc-l-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.inc-l-search{flex:1 1 280px;min-width:0;display:flex;align-items:center;gap:8px;min-height:var(--qa-control,36px);padding:0 10px;border:1px solid var(--qa-color-border-strong);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-muted)}
.inc-l-search:focus-within{outline:2px solid var(--qa-color-primary);outline-offset:1px;border-color:var(--qa-color-primary)}
.inc-l-search .ico{width:16px;height:16px;flex:none}
.inc-l-search input{flex:1 1 auto;min-width:0;border:0;background:transparent;color:var(--qa-color-text);font:inherit;font-size:14px;outline:none;min-height:calc(var(--qa-control,36px) - 2px)}
.inc-l-search input::placeholder{color:var(--qa-color-muted)}
.inc-l-icons{display:flex;gap:6px;flex:none}
.inc-l-tabs{position:relative;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.inc-l-tabs button{position:relative;white-space:nowrap;flex:none;display:inline-flex;align-items:center;gap:6px}
.inc-l-n{display:inline-flex;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);font-size:12px;font-weight:600;align-items:center;justify-content:center;color:var(--qa-color-muted)}
.inc-l-tabs button[aria-selected="true"] .inc-l-n{background:color-mix(in srgb,var(--qa-color-primary) 12%,var(--qa-color-surface));border-color:color-mix(in srgb,var(--qa-color-primary) 35%,transparent);color:var(--qa-color-primary)}
.inc-l-shown{margin:0;font-size:12.5px}
.inc-l-tbl{min-width:720px}
.inc-l-tbl td{padding:10px 8px}
.inc-l-row{cursor:pointer}
.inc-l-row:hover td{background:color-mix(in srgb,var(--qa-color-primary) 5%,var(--qa-color-surface))}
.inc-l-row:focus-within td{background:color-mix(in srgb,var(--qa-color-primary) 7%,var(--qa-color-surface))}
.inc-l-id{font-size:12.5px;color:var(--qa-color-primary);white-space:nowrap;background:transparent}
.inc-l-title .lnk{color:var(--qa-color-text);font-weight:600;min-height:28px}
.inc-l-title .lnk:hover{color:var(--qa-color-primary)}
.inc-l-title .lnk:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px;border-radius:4px}
.inc-sev{display:inline-flex;align-items:center;gap:6px}
.inc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;background:var(--qa-color-muted)}
.inc-dot-medium{background:var(--qa-color-warning)}
.inc-dot-high{background:var(--qa-color-danger)}
.inc-dot-critical{background:var(--qa-color-danger);box-shadow:0 0 0 2px color-mix(in srgb,var(--qa-color-danger) 30%,transparent)}
.inc-cf-crumbs ol{list-style:none;margin:0 0 -8px;padding:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--qa-color-muted)}
.inc-cf-crumbs li+li::before{content:"›";margin-right:6px}
.inc-cf-crumbs .lnk{min-height:24px;font-size:13px}
.inc-cf{max-width:1040px}
.inc-cf-form{display:flex;flex-direction:column;gap:12px;min-width:0}
.inc-cf-f{display:grid;grid-template-columns:150px minmax(0,1fr);gap:4px 14px;align-items:start;min-width:0}
.inc-cf-l{font-size:13px;font-weight:600;padding-top:8px}
.inc-cf-l small{font-weight:400}
.inc-cf-c{display:flex;flex-direction:column;gap:4px;min-width:0}
.inc-cf-c>input,.inc-cf-c>textarea,.inc-cf-c>select,.inc-cf-sev select{width:100%;min-height:var(--qa-control,36px);border-radius:8px;border:1px solid var(--qa-color-border-strong);padding:6px 10px;background-color:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;font-size:14px}
.inc-cf-c>select,.inc-cf-sev select{padding-right:32px}
.inc-cf-c>textarea{resize:vertical;font-size:13.5px;line-height:1.45}
.inc-cf-c>input:focus-visible,.inc-cf-c>textarea:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px;border-color:var(--qa-color-primary)}
.inc-cf-c>[aria-invalid="true"]{border-color:var(--qa-color-danger);box-shadow:0 0 0 1px var(--qa-color-danger)}
.inc-cf-c>small.mu{font-size:12px}
.inc-cf-err{display:flex;align-items:center;gap:4px;font-size:12.5px;font-weight:500}
.inc-cf-err .ico{width:14px;height:14px;flex:none}
.inc-cf-pair{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:12px 20px;align-items:start}
.inc-cf-pair>.inc-cf-f+datalist+.inc-cf-f,.inc-cf-pair>.inc-cf-f+.inc-cf-f{grid-template-columns:120px minmax(0,1fr)}
.inc-cf-sev{position:relative;display:flex;align-items:center}
.inc-cf-sev .inc-dot{position:absolute;left:11px;width:10px;height:10px;pointer-events:none;z-index:1}
.inc-cf-sev select{padding-left:30px}
.inc-cf-sev-high select,.inc-cf-sev-critical select{background-color:var(--qa-color-danger-soft);border-color:color-mix(in srgb,var(--qa-color-danger) 45%,var(--qa-color-border-strong));color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));font-weight:600}
.inc-cf-sev-medium select{background-color:var(--qa-color-warning-soft);border-color:color-mix(in srgb,var(--qa-color-warning) 45%,var(--qa-color-border-strong))}
.inc-cf-pick{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.inc-cf-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.inc-cf-file:focus-visible+label{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.inc-cf-pick label.btn{cursor:pointer}
.inc-cf-pick label.btn.disabled{opacity:.55;cursor:not-allowed}
.inc-cf-atts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.inc-cf-atts li{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 4px 4px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2);font-size:13px}
.inc-cf-att-i .ico{width:15px;height:15px;color:var(--qa-color-muted)}
.inc-cf-att-n{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inc-cf-att-rm{flex:none;width:28px;height:28px;display:inline-grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--qa-color-muted);cursor:pointer;padding:0}
.inc-cf-att-rm:hover{background:var(--qa-color-danger-soft);color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.inc-cf-att-rm:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.inc-cf-att-rm .ico{width:14px;height:14px}
.inc-cf-rej{display:flex;flex-direction:column;gap:2px;font-size:13px}
.inc-cf-rej p{margin:0}
.inc-cf-opts{border:1px solid var(--qa-color-border);border-radius:10px;padding:0 12px;background:var(--qa-color-surface)}
.inc-cf-opts>summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:40px;cursor:pointer;font-weight:600;font-size:13.5px}
.inc-cf-opts>summary .ico{width:16px;height:16px;color:var(--qa-color-muted)}
.inc-cf-opts>summary small{font-weight:400}
.inc-cf-opts[open]{padding-bottom:12px;display:flex;flex-direction:column;gap:10px}
.inc-cf-opts>p{margin:0}
.inc-cf-foot{display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;padding-top:4px;border-top:1px solid var(--qa-color-border)}
.inc-cf-foot>p.err{display:flex;align-items:center;gap:6px;margin:0}
.inc-cf-foot .ico{width:16px;height:16px}
.inc-cf-acts{display:flex;gap:8px;margin-left:auto}
.inc-sc-other{gap:10px}
.inc-sc-apps-d>summary{cursor:pointer;font-weight:600;font-size:14px;padding:4px 0}
@media (max-width:760px){
  .inc-cf-f,.inc-cf-pair>.inc-cf-f+datalist+.inc-cf-f,.inc-cf-pair>.inc-cf-f+.inc-cf-f{grid-template-columns:minmax(0,1fr)}
  .inc-cf-l{padding-top:0}
  .inc-cf-pair{grid-template-columns:minmax(0,1fr)}
  .inc-cf-acts{width:100%;justify-content:flex-end}
}
`;

/** Les styles de la structure (s'ajoutent à DASHBOARD_CSS et INCIDENT_PARTS_CSS) : jetons du thème seulement. */
export const INCIDENT_UX_CSS = `
.ws-ux-head{display:flex;flex-direction:column;gap:4px;padding:4px 10px;border-radius:12px;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-left:4px solid var(--qa-color-primary);min-width:0}
.ws-ux-head-top{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;min-width:0}
.ws-ux-head-top>.back{flex:none;min-height:32px}
.ws-ux-head-t{display:flex;align-items:center;gap:6px 8px;min-width:0;flex:1 1 280px;flex-wrap:nowrap}
.ws-ux-eyebrow{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ws-ux-head h1{margin:0;font-size:17px;line-height:1.3;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:8ch;max-width:100%;flex:0 1 auto}
.ws-ux-tags{display:flex;flex-wrap:nowrap;gap:4px;align-items:center;flex:none}
.ws-ux-env{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:999px;border:1px solid var(--qa-color-border-strong);font-size:12px}
.ws-ux-head .acts{gap:6px}
.ws-ux-head .acts .btn{min-height:32px;padding:0 12px}
.ws-ux-head .acts .btn.small{min-height:32px}
.ws-ux-head .acts .btn.icon-only{width:32px;padding:0}
.ws-ux-head-more{border-top:1px solid var(--qa-color-border);padding-top:8px;max-height:32vh;overflow:auto}
.ws-ux-demo{display:flex;align-items:center;min-width:0}
.ws-ux-demo>.ws-demo{flex:1 1 auto;min-width:0;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;padding:2px 10px;gap:8px;font-size:12px;border-radius:8px}
.ws-ux-demo>.ws-demo>b{flex:none}
.ws-ux-demo>.ws-demo>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.ws-ux-run{display:inline-flex;align-items:center;gap:6px}
.ws-ux-meta,.ws-ux-dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 18px;margin:0}
.ws-ux-meta>div,.ws-ux-dl>div{min-width:0;display:flex;flex-direction:column;gap:2px}
.ws-ux-meta>div.wide,.ws-ux-dl>div.wide{grid-column:1 / -1}
.ws-ux-meta dt,.ws-ux-dl dt{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:600}
.ws-ux-meta dd,.ws-ux-dl dd{margin:0;overflow-wrap:anywhere}
.ws-ux-stepper{display:flex;flex-direction:column;gap:6px;min-width:0;container:ws-ux-steps / inline-size}
.ws-ux-step-row{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;min-height:30px;font-size:13px;min-width:0}
.ws-ux-step-toggle{width:30px;height:30px;display:inline-grid;place-items:center;border:1px solid var(--ws-edge,var(--qa-color-border-strong));border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-muted);cursor:pointer;padding:0;flex:none}
.ws-ux-step-toggle:hover{border-color:var(--qa-color-primary);color:var(--qa-color-text)}
.ws-ux-step-toggle .ico{width:15px;height:15px}
.ws-ux-step-now{display:inline-flex;align-items:center;gap:4px;min-width:0}
.ws-ux-step-now .ico{width:15px;height:15px;color:var(--qa-color-success)}
.ws-ux-step-cur{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--qa-color-primary);cursor:pointer}
.ws-ux-step-cur:hover{background:var(--qa-color-surface-2)}
.ws-ux-step-cur .ico{width:14px;height:14px;color:var(--qa-color-danger)}
.ws-ux-step-blocked{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.ws-ux-step-n{font-weight:600;font-variant-numeric:tabular-nums}
.ws-ux-step-bar{display:block;width:120px;height:6px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow:hidden;flex:none}
.ws-ux-step-bar>span{display:block;height:100%;background:var(--qa-color-primary)}
.ws-ux-step-bar-ko>span{background:var(--qa-color-danger)}
.ws-ux-progress{margin:0;font-size:12px}
.ws-ux-stepper-row .ws-ux-step-row{flex-wrap:nowrap;gap:6px}
.ws-ux-steps-row{list-style:none;margin:0;padding:2px 0;display:flex;align-items:center;gap:0;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scroll-padding-inline:24px;background:linear-gradient(to right,var(--qa-color-background) 40%,transparent) left / 24px 100% no-repeat local,linear-gradient(to left,var(--qa-color-background) 40%,transparent) right / 24px 100% no-repeat local,radial-gradient(farthest-side at 0 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) left / 10px 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) right / 10px 100% no-repeat scroll}
.ws-ux-sr{flex:none;display:flex;align-items:center}
.ws-ux-sr+.ws-ux-sr::before{content:"";flex:none;width:8px;height:1px;background:var(--qa-color-border-strong)}
.ws-ux-sr.ws-ux-s-done+.ws-ux-sr::before{background:var(--qa-color-success)}
.ws-ux-sr button{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:0 7px 0 3px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--qa-color-muted);font:inherit;font-size:12.5px;white-space:nowrap;cursor:pointer}
.ws-ux-sr button:hover{background:var(--qa-color-surface-2);color:var(--qa-color-text)}
.ws-ux-sn{width:21px;height:21px;border-radius:50%;display:grid;place-items:center;font-size:11.5px;font-weight:700;border:1.5px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-muted);flex:none}
.ws-ux-sn .ico{width:12px;height:12px;stroke-width:3}
.ws-ux-sn .spin{width:12px;height:12px}
.ws-ux-sr.ws-ux-s-todo .ws-ux-sn{border-style:dashed}
.ws-ux-sr.ws-ux-s-done button{color:var(--qa-color-text)}
.ws-ux-sr.ws-ux-s-done .ws-ux-sn{border-color:var(--qa-color-success);background:var(--qa-color-success-soft);color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.ws-ux-sr button[aria-current="step"]{background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface));border-color:color-mix(in srgb,var(--qa-color-primary) 40%,transparent);color:var(--qa-color-primary);font-weight:600}
.ws-ux-sr button[aria-current="step"] .ws-ux-sn{background:var(--qa-color-primary);border-color:var(--qa-color-primary);border-style:solid;color:var(--qa-color-surface)}
.ws-ux-sr.ws-ux-s-blocked button{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.ws-ux-sr.ws-ux-s-blocked .ws-ux-sn{border-color:var(--qa-color-danger);border-style:dashed;background:var(--qa-color-danger-soft);color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text))}
.ws-ux-sr.ws-ux-s-running .ws-ux-sn{box-shadow:0 0 0 3px color-mix(in srgb,var(--qa-color-primary) 20%,transparent)}
.ws-ux-stepper #ws-ux-steps{position:relative;list-style:none;margin:0;padding:0 0 4px;display:flex;gap:4px;overflow-x:auto;background:linear-gradient(to right,var(--qa-color-background) 40%,transparent) left / 28px 100% no-repeat local,linear-gradient(to left,var(--qa-color-background) 40%,transparent) right / 28px 100% no-repeat local,radial-gradient(farthest-side at 0 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) left / 12px 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) right / 12px 100% no-repeat scroll}
.ws-ux-stage{flex:0 0 auto;min-width:96px;position:relative}
.ws-ux-stage+.ws-ux-stage::before{content:"";position:absolute;top:21px;left:-50%;right:50%;border-top:2px solid var(--qa-color-border);z-index:0}
.ws-ux-stage.ws-ux-s-done+.ws-ux-stage::before{border-top-color:var(--qa-color-success)}
.ws-ux-stage button{position:relative;z-index:1;width:100%;display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 2px 6px;min-height:44px;border:0;border-radius:10px;background:transparent;color:var(--qa-color-text);cursor:pointer;text-align:center}
.ws-ux-stage button:hover{background:var(--qa-color-surface-2)}
.ws-ux-stage button:focus-visible,.ws-ux-target:focus-visible,.ws-ux-req:focus-visible,.ws-ux-ev:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
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
.ws-ux-tabbar{display:flex;align-items:flex-end;justify-content:space-between;gap:4px 12px;min-width:0;border-bottom:1px solid var(--qa-color-border)}
.ws-ux-tabbar>.ws-ux-tabs{flex:1 1 auto;min-width:0;border-bottom:0}
.ws-ux-tabtools{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:nowrap;padding:2px 0 4px;min-width:0;flex:none}
.ws-ux-tabs{position:relative;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;row-gap:0}
.ws-ux-tabs button{position:relative;white-space:nowrap;min-height:38px;flex:none}
.ws-ux-subtabs button{min-height:32px;padding:0 12px;font-size:13px}
.ws-ux-subbar{border-bottom-style:dashed}
.ws-ux-count{display:inline-flex;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);font-size:12px;align-items:center;justify-content:center;font-weight:600}
.ws-ux-panel{display:flex;flex-direction:column;gap:16px;min-width:0}
.ws-ux-panel:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:4px;border-radius:8px}
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
.ws-ux-targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.ws-ux-target{position:relative;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:14px 16px;border:1px solid var(--qa-color-border-strong);border-radius:12px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;cursor:pointer;text-align:left}
.ws-ux-target:hover{border-color:var(--qa-color-primary)}
.ws-ux-target[aria-checked="true"]{border:2px solid var(--qa-color-primary);padding:13px 15px;background:color-mix(in srgb,var(--qa-color-primary) 6%,var(--qa-color-surface))}
.ws-ux-tg-top{display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center}
.ws-ux-tg-ico{width:30px;height:30px;color:var(--qa-color-primary);stroke-width:1.6;margin-bottom:2px}
.ws-ux-tg-t{font-size:15px;letter-spacing:.02em}
.ws-ux-tg-top>small{font-size:12px}
.ws-ux-target-h{display:flex;align-items:center;justify-content:center;gap:4px;flex-wrap:wrap;margin-top:4px}
.ws-ux-target-h:empty{display:none}
.ws-ux-radio{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:50%;border:2px solid var(--qa-color-border-strong);display:grid;place-items:center;flex:none;color:var(--qa-color-surface);background:var(--qa-color-surface)}
.ws-ux-target[aria-checked="true"] .ws-ux-radio{border-color:var(--qa-color-primary);background:var(--qa-color-primary)}
.ws-ux-radio .ico{width:12px;height:12px;stroke-width:3.5}
.ws-ux-caps{display:flex;flex-direction:column;gap:5px}
.ws-ux-cap{display:flex;align-items:flex-start;gap:8px;font-size:13px;min-width:0}
.ws-ux-cap>span:last-child{min-width:0;overflow-wrap:anywhere}
.ws-ux-cap-i{flex:none;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;margin-top:2px}
.ws-ux-cap-ok{background:var(--qa-color-success);color:var(--qa-color-surface)}
.ws-ux-cap-ko{background:var(--qa-color-danger-soft);color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));border:1px solid color-mix(in srgb,var(--qa-color-danger) 45%,transparent)}
.ws-ux-cap-gen{border:1.5px solid var(--qa-color-border-strong);width:12px;height:12px;margin:4px 2px 0}
.ws-ux-cap-i .ico{width:10px;height:10px;stroke-width:3.5}
.ws-ux-gen{font-size:12px;font-style:italic}
.ws-ux-config{border:1px solid color-mix(in srgb,var(--qa-color-success) 35%,var(--qa-color-border));background:color-mix(in srgb,var(--qa-color-success) 7%,var(--qa-color-surface));border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-ux-config-dirty{border-color:color-mix(in srgb,var(--qa-color-warning) 45%,var(--qa-color-border));background:color-mix(in srgb,var(--qa-color-warning) 6%,var(--qa-color-surface))}
.ws-ux-config-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ws-ux-config-h h3{margin:0;font-size:14px}
.ws-ux-config-i{width:22px;height:22px;border-radius:50%;background:var(--qa-color-success);color:var(--qa-color-surface);display:grid;place-items:center;flex:none}
.ws-ux-config-i .ico{width:13px;height:13px;stroke-width:3}
.ws-ux-config-b{display:flex;gap:12px 20px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;min-width:0}
.ws-ux-config-dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:0;font-size:13px;flex:1 1 360px;min-width:0}
.ws-ux-config-dl>div{display:contents}
.ws-ux-config-dl dt{color:var(--qa-color-muted);font-weight:600}
.ws-ux-config-dl dd{margin:0;min-width:0}
.ws-ux-urls{display:flex;flex-direction:column;gap:2px;margin:0}
.ws-ux-urls li{display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap;min-width:0}
.ws-ux-urls code{overflow-wrap:anywhere}
.ws-ux-urls .pill{display:inline-flex;align-items:center;gap:4px;white-space:normal}
.ws-ux-urls .pill .ico{width:12px;height:12px;stroke-width:3}
.ws-ux-config-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.ws-ux-config-acts .btn .ico{width:16px;height:16px}
.ws-ux-config-acts small.mu{flex-basis:100%;text-align:right;font-size:12px}
.ws-ux-limits-d>summary{cursor:pointer;color:var(--qa-color-primary);font-size:13px;padding:2px 0}
.ws-ux-limits-d[open]>summary{margin-bottom:6px}
.ws-ux-target:focus-visible,.ws-ux-sr button:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ws-ux-fields{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-ux-fields legend{font-weight:600;padding:0;margin-bottom:8px}
.ws-ux-limits{display:flex;flex-direction:column;gap:6px}
.ws-ux-limits h3{margin:0}
.ws-ux-env-acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ws-ux-fields input[aria-invalid="true"]{border-color:var(--qa-color-danger);box-shadow:0 0 0 1px var(--qa-color-danger)}
.ws-ux-field-err{display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:500}
.ws-ux-field-err .ico{width:14px;height:14px;flex:none}
@container ws-ux-steps (min-width:600px){
  .ws-ux-stepper #ws-ux-steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));row-gap:10px;overflow:visible;background:none}
  .ws-ux-stage{min-width:0}
  .ws-ux-stage:nth-child(5n+1)::before{display:none}
}
@container ws-ux-steps (min-width:1040px){
  .ws-ux-stepper #ws-ux-steps{grid-template-columns:repeat(10,minmax(0,1fr))}
  .ws-ux-stage:nth-child(5n+1)::before{display:block}
}
@container ws-root (max-width:1100px){
  .ws-ux-head-top>.back>span:not(.ico),.ws-ux-more>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .ws-ux-head-top>.back{min-width:32px;justify-content:center}
  .ws-ux-more{padding:0 8px}
}
@container (max-width:600px){
  .ws-ux-head{padding:6px 8px}
  .ws-ux-head-t{flex-wrap:wrap}
  .ws-ux-tags{flex-wrap:wrap;flex:1 1 auto;min-width:0}
  .ws-ux-head h1{font-size:16px;white-space:normal;overflow-wrap:anywhere}
  .ws-ux-tabs button{padding:0 10px}
  .ws-ux-step-bar,.ws-ux-progress{display:none}
  .ws-ux-config-dl{grid-template-columns:minmax(0,1fr);gap:0}
  .ws-ux-config-dl dd{margin-bottom:6px}
  .ws-ux-overview{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){.ws-ux-s-running .ws-ux-dot,.ws-ux-s-running .ws-ux-sn{box-shadow:none}}
${INCIDENT_SCOPE_CSS}
${INCIDENT_SCOPE_DISCOVERY_CSS}
${INCIDENT_FLOW_CSS}`;
