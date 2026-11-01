import type {
  Diagnosis,
  Experiment,
  ExperimentKind,
  ExperimentStatus,
  Hypothesis,
  HypothesisStatus,
  Incident,
  InvestigationReport,
  PolicyDecision,
  ProposedVerification,
  RegressionTestProposal,
  RelationStatus,
  ReportFormat,
  ReportSection,
  SourceLocation,
} from '../core/incident-contracts.js';
import { EXPERIMENT_KINDS, REPORT_FORMATS, REPORT_SECTIONS } from '../core/incident-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import { displayStatus } from './incident-graph.js';
import { fileId, type SelectionKind } from './incident-links.js';
import {
  demoBanner,
  evidenceChips,
  panelState,
  partsText,
  selectable,
  selectionClass,
  sourceLink,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { originPill } from './incident-ai.js';
import { esc } from './view.js';

/**
 * LE DIAGNOSTIC DE L'ESPACE D'INVESTIGATION : hypothèses (preuves favorables et contraires côte à côte,
 * confiance, règle de confirmation), expériences (vérifications, décisions du périmètre, approbation
 * explicite des effets de bord dans la page), diagnostic (une cause n'est dite « confirmée » que si
 * `Diagnosis.status === 'CONFIRMED'`), rapport (résumé et exports, rien d'inventé) et test de
 * non-régression (« Réussi » seulement si `execution.passed === true`).
 *
 * Rendu en chaînes HTML pures ; les interactions passent par `data-action` (préfixe `ws-dx-`).
 * `reduceDiagnosis` ne traite que l'état local de l'interface ; les opérations qui touchent le serveur
 * (`DIAGNOSIS_OPERATIONS`) sont laissées à l'intégration.
 */

// ── État local ────────────────────────────────────────────────────────────────────────────────

export type HypothesisSort = 'confidence' | 'status';

export interface PlanParamRow {
  key: string;
  value: string;
}

/** Le brouillon du formulaire « Planifier une vérification ». */
export interface PlanDraft {
  kind: ExperimentKind;
  /** Vide : sans hypothèse liée. */
  hypothesisId: string;
  params: PlanParamRow[];
}

export type PlanProblem =
  { code: 'duplicate'; key: string; index: number } | { code: 'emptyKey'; index: number };

export interface DiagnosisUi {
  /** Les hypothèses dépliées (ids). */
  expanded: string[];
  sort: HypothesisSort;
  plan: PlanDraft;
  /** Les problèmes du brouillon au dernier envoi (rien n'est envoyé tant qu'il en reste). */
  planProblems: PlanProblem[];
  /** La vérification à effets de bord dont l'approbation est demandée dans la page. */
  approving?: string;
  /**
   * Les erreurs à afficher, par emplacement : `plan`, `analyze`, `diagnose`, `report`, `export`,
   * `regression`, `experiment:<id>`, `hypothesis:<id>`.
   */
  errors: Record<string, string>;
  /** L'opération en cours (`diagnosisBusyKey(action, ref)`) : une à la fois, les autres boutons attendent. */
  busy?: string;
  /** Les vérifications cochées dans « Vérifications proposées » (ids d'expériences). */
  checked: string[];
  /** « Pourquoi cette hypothèse ? » déplié. */
  why: boolean;
  /** Les sections du rapport retenues : elles pilotent l'aperçu ET l'export (ordre de REPORT_SECTIONS). */
  sections: ReportSection[];
  /** « Voir le test complet » : le code du test de non-régression en entier. */
  regFull: boolean;
  /** Le code affiché du test généré : le flow YAML ou le test Playwright. */
  regTab: RegressionTab;
}

export type RegressionTab = 'flow' | 'spec';

export const emptyPlanDraft = (): PlanDraft => ({
  kind: 'REPLAY',
  hypothesisId: '',
  params: [{ key: '', value: '' }],
});

export function emptyDiagnosisUi(): DiagnosisUi {
  return {
    expanded: [],
    sort: 'confidence',
    plan: emptyPlanDraft(),
    planProblems: [],
    errors: {},
    checked: [],
    why: false,
    sections: [...REPORT_SECTIONS],
    regFull: false,
    regTab: 'flow',
  };
}

/** La clé d'une opération en cours, pour `DiagnosisUi.busy`. */
export const diagnosisBusyKey = (action: string, ref?: string): string => (ref ? `${action}:${ref}` : action);

/** Les actions qui touchent le serveur : jamais traitées par le réducteur, toujours par l'intégration. */
export const DIAGNOSIS_OPERATIONS = [
  'ws-dx-analyze',
  'ws-dx-plan',
  'ws-dx-plan-submit',
  'ws-dx-run',
  'ws-dx-run-selected',
  'ws-dx-approve',
  'ws-dx-diagnose',
  'ws-dx-report',
  'ws-dx-export',
  'ws-dx-regression',
] as const;

// ── Textes ────────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    busy: 'Une opération est en cours.',
    notReady: 'Disponible une fois l’incident délimité, hors reproduction en cours.',
    dismiss: 'Fermer le message',
    noneItem: 'Aucune.',
    layer: 'Couche',
    files: 'Fichiers',
    fileOutside: 'Fichier absent de l’index de code : lien vers le code indisponible.',
    hypothesisStatus: {
      PROPOSED: 'Proposée',
      INVESTIGATING: 'En vérification',
      SUPPORTED: 'Étayée',
      REFUTED: 'Réfutée',
      INCONCLUSIVE: 'Inconclusive',
      CONFIRMED: 'Confirmée',
    } as Record<HypothesisStatus, string>,
    experimentKinds: {
      REPLAY: 'Rejouer le scénario',
      COMPARE_REQUESTS: 'Comparer les requêtes',
      COMPARE_RESPONSES: 'Comparer les réponses',
      UNIT_TEST: 'Test unitaire',
      INTEGRATION_TEST: 'Test d’intégration',
      INSPECT_LOGS: 'Lire les journaux',
      CHECK_VALIDATION: 'Vérifier une validation',
      COMPARE_WITH_PASSING: 'Comparer avec un cas qui passe',
    } as Record<ExperimentKind, string>,
    experimentStatus: {
      PROPOSED: 'Planifiée',
      REFUSED: 'Refusée',
      APPROVAL_REQUIRED: 'Approbation requise',
      RUNNING: 'En cours',
      DONE: 'Terminée',
      ERROR: 'Erreur',
      CANCELLED: 'Annulée',
    } as Record<ExperimentStatus, string>,
    outcomes: { SUPPORTS: 'Étaye l’hypothèse', REFUTES: 'Réfute l’hypothèse', NEUTRAL: 'Neutre' } as Record<
      NonNullable<Experiment['outcome']>,
      string
    >,
    levels: { low: 'faible', mid: 'moyenne', high: 'élevée' },
    confidence: 'Confiance',
    confidenceLabel: (percent: number, level: string) => `Confiance : ${String(percent)} % (${level})`,
    refKinds: {
      request: 'Requête',
      evidence: 'Preuve',
      symbol: 'Symbole',
      experiment: 'Vérification',
      other: 'Référence',
    } as Record<string, string>,
    hyp: {
      title: 'Hypothèses',
      sub: 'Chaque hypothèse dit ses preuves favorables et contraires ; sa confiance ne monte qu’avec des vérifications.',
      none: 'Aucune hypothèse pour l’instant.',
      analyze: 'Analyser le code et proposer des hypothèses',
      reanalyze: 'Analyser de nouveau',
      sortBy: 'Trier par',
      sorts: { confidence: 'Confiance', status: 'Statut' } as Record<HypothesisSort, string>,
      ruleTitle: 'Quand une hypothèse est-elle confirmée ?',
      rule: 'Une hypothèse n’est confirmée qu’avec au moins deux vérifications favorables de natures différentes, dont une dynamique (rejeu, comparaison de requêtes ou de réponses, test, lecture des journaux), et aucune preuve contraire. Une vérification statique seule (lecture du code) ne suffit jamais ; une hypothèse étayée reste une cause probable.',
      cause: 'Cause supposée',
      description: 'Description',
      select: (title: string) => `Sélectionner l’hypothèse « ${title} »`,
      expand: (title: string) => `Afficher le détail de « ${title} »`,
      collapse: (title: string) => `Masquer le détail de « ${title} »`,
      details: 'Détail',
      hide: 'Masquer',
      supporting: (n: number) => `Preuves favorables (${String(n)})`,
      contradicting: (n: number) => `Preuves contraires (${String(n)})`,
      verifications: 'Vérifications proposées',
      noVerification: 'Aucune vérification proposée.',
      plan: 'Planifier',
      planLabel: (kind: string, title: string) => `Planifier « ${kind} » pour l’hypothèse « ${title} »`,
      progress: 'Avancement vers la confirmation',
      checkKinds: (n: number) => `Deux vérifications favorables de natures différentes (${String(n)} sur 2)`,
      checkDynamic: 'Au moins une vérification dynamique favorable',
      checkContrary: (n: number) =>
        n === 0 ? 'Aucune preuve contraire' : `Aucune preuve contraire (${String(n)} à lever)`,
      met: 'atteint',
      unmet: 'manquant',
      experiments: 'Vérifications liées',
      noExperiment: 'Aucune vérification planifiée pour cette hypothèse.',
      notFound: 'Cette hypothèse n’existe plus dans l’investigation.',
    },
    exp: {
      title: 'Expériences',
      sub: 'Chaque vérification passe par le périmètre : un refus est affiché avec sa règle et sa raison, rien ne s’exécute en dehors.',
      none: 'Aucune vérification planifiée.',
      noSideEffects:
        'Le périmètre n’autorise pas les effets de bord : les vérifications qui écrivent seront refusées.',
      select: (kind: string) => `Sélectionner la vérification « ${kind} »`,
      run: 'Exécuter',
      review: 'Examiner avant d’exécuter',
      runLabel: (kind: string) => `Exécuter la vérification « ${kind} »`,
      reviewLabel: (kind: string) => `Examiner les effets de bord de « ${kind} » avant d’exécuter`,
      running: 'Vérification en cours…',
      sideEffects: 'Effets de bord',
      forHypothesis: 'Hypothèse',
      noHypothesis: 'Sans hypothèse liée',
      result: 'Résultat',
      approvedBy: (who: string) => `Approuvée par ${who}`,
      started: (at: string) => `Lancée le ${at}`,
      finished: (at: string) => `Terminée le ${at}`,
      params: 'Paramètres',
      refused: (n: number) => `${String(n)} opération(s) refusée(s) par le périmètre`,
      allowed: (n: number) => `${String(n)} opération(s) autorisée(s)`,
      rule: 'Règle',
      reason: 'Raison',
      extension: (kind: string, target: string) => `Extension qui la rendrait possible : ${kind} ${target}`,
      evidence: (n: number) => `${String(n)} preuve(s)`,
      approveTitle: 'Approuver une vérification avec effets de bord',
      approveText:
        'Cette vérification peut modifier des données de l’environnement cible (écritures, test d’intégration). Elle ne s’exécute qu’avec votre approbation explicite, dans un environnement adapté, jamais en production.',
      approveTarget: (target: string) => `Cible d’exécution : ${target}.`,
      scopeForbids:
        'Le périmètre n’autorise pas encore les effets de bord : le serveur refusera tant qu’une extension « Autoriser les effets de bord » n’est pas approuvée.',
      writesRight:
        'Approuver demande le droit de permettre les écritures : demandez-le à un administrateur du projet.',
      approveRun: 'Approuver et exécuter',
      approveLabel: (kind: string) => `Approuver et exécuter « ${kind} » malgré ses effets de bord`,
      cancel: 'Annuler',
      planTitle: 'Planifier une vérification',
      planSub: 'La vérification est planifiée, pas exécutée : elle passera par le périmètre au lancement.',
      kind: 'Nature',
      hypothesis: 'Hypothèse',
      paramsLegend: 'Paramètres (clé et valeur)',
      key: (n: number) => `Clé du paramètre ${String(n)}`,
      value: (n: number) => `Valeur du paramètre ${String(n)}`,
      keyHead: 'Clé',
      valueHead: 'Valeur',
      addParam: 'Ajouter un paramètre',
      removeParam: (n: number) => `Retirer le paramètre ${String(n)}`,
      paramsHint: 'Valeurs reconnues : true / false, nombres, liste séparée par « | ».',
      known: 'Paramètres reconnus :',
      integrationNote:
        'Un test d’intégration a toujours des effets de bord possibles : il attendra une approbation explicite.',
      plan: 'Planifier',
      problems: {
        duplicate: (key: string) => `Le paramètre « ${key} » est en double.`,
        emptyKey: (n: number) => `Le paramètre ${String(n)} a une valeur sans clé.`,
      },
      notFound: 'Cette vérification n’existe plus dans l’investigation.',
    },
    diag: {
      title: 'Diagnostic',
      statuses: { CONFIRMED: 'Confirmé', PROBABLE: 'Probable', INCONCLUSIVE: 'Inconclusif' } as Record<
        Diagnosis['status'],
        string
      >,
      sentences: {
        CONFIRMED:
          'Cause racine confirmée : au moins deux vérifications favorables de natures différentes, dont une dynamique, et aucune preuve contraire.',
        PROBABLE:
          'Cause probable, non confirmée : l’hypothèse la mieux étayée n’a pas encore les vérifications exigées pour être confirmée.',
        INCONCLUSIVE: 'Diagnostic inconclusif : les preuves ne suffisent pas à établir une cause.',
      } as Record<Diagnosis['status'], string>,
      rootConfirmed: 'Cause racine confirmée',
      rootProbable: 'Cause probable',
      rootNone: 'Aucune cause établie',
      lead: 'Piste la plus avancée, non établie :',
      noRoot: 'Aucune hypothèse n’est assez étayée pour désigner une cause.',
      hypothesis: 'Hypothèse',
      alternatives: 'Autres explications',
      missing: 'Ce qui manque pour conclure',
      recommendations: 'Recommandations',
      generated: (at: string) => `Établi le ${at}`,
      rediagnose: 'Rediagnostiquer',
      run: 'Établir le diagnostic',
      none: 'Pas encore de diagnostic.',
      needHypotheses: 'Le diagnostic s’établit à partir des hypothèses : lancez d’abord l’analyse.',
    },
    report: {
      title: 'Rapport d’investigation',
      generated: (at: string) => `Généré le ${at}`,
      exportJson: 'Exporter en JSON',
      exportMarkdown: 'Exporter en Markdown',
      exportNote: 'Le fichier est produit par le serveur à partir de l’investigation enregistrée.',
      reread: 'Actualiser',
      loading: 'Chargement du rapport…',
      missing: 'Le rapport n’est pas encore chargé.',
      incident: 'Incident',
      severity: 'Gravité',
      state: 'État',
      observed: 'Observé',
      expected: 'Attendu',
      environment: 'Environnement',
      target: 'Cible d’exécution',
      environmentId: 'Environnement du projet',
      baseUrl: 'URL de base',
      scope: 'Périmètre',
      mode: 'Mode',
      applications: 'Applications',
      endpoints: 'Endpoints ciblés',
      depth: 'Profondeur d’analyse',
      scenario: 'Scénario',
      counts: 'En chiffres',
      timeline: 'événement(s) dans la chronologie',
      failing: (total: number) => `requête(s) en erreur sur ${String(total)}`,
      files: 'fichier(s) de code retenu(s)',
      symbols: 'symbole(s) de code',
      denied: 'chemin(s) refusé(s) par le périmètre',
      hypotheses: 'hypothèse(s)',
      experiments: 'vérification(s)',
      diagnosis: 'Diagnostic',
      regression: 'Non-régression',
      limitations: 'Ce que le rapport ne peut pas affirmer',
      noLimitation: 'Aucune limite signalée.',
      none: '—',
    },
    reg: {
      title: 'Test de non-régression',
      propose: 'Proposer un test',
      proposeAgain: 'Proposer de nouveau',
      none: 'Aucun test proposé.',
      noScenario: 'Un scénario de la bibliothèque est nécessaire pour proposer un test.',
      statuses: { PROPOSED: 'Proposé', ACCEPTED: 'Ajouté à la bibliothèque', REJECTED: 'Refusé' } as Record<
        RegressionTestProposal['status'],
        string
      >,
      name: 'Nom',
      basedOn: 'À partir du scénario',
      expected: 'Résultat attendu',
      file: 'Fichier',
      verdict: 'Résultat d’exécution',
      notRun: 'Pas encore exécuté',
      notRunHint: 'Aucun verdict tant que le test n’a pas tourné réellement.',
      passed: 'Réussi',
      failed: 'Échoué',
      ranAt: (run: string, at: string) => `Exécution ${run} du ${at}`,
      run: 'Exécuter le test',
      runAgain: 'Exécuter de nouveau',
      accept: 'Ajouter à la bibliothèque',
      reject: 'Refuser',
      libraryNote:
        'Ajouter le test le place dans la bibliothèque de scénarios ; rien n’y entre sans cette validation.',
      runFirst:
        'Le test n’a pas encore été exécuté : l’exécuter avant de l’ajouter permet de voir son verdict.',
      flow: 'Flow proposé (YAML, lecture seule)',
    },
    severities: { LOW: 'Faible', MEDIUM: 'Moyenne', HIGH: 'Haute', CRITICAL: 'Critique' } as Record<
      string,
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
    } as Record<string, string>,
    targets: { LOCAL: 'Local', REMOTE: 'Distant', ARO: 'Azure Red Hat OpenShift' } as Record<string, string>,
    modes: {
      MANUAL: 'Manuel',
      GUIDED: 'Guidé',
      AUTO_WITHIN_SCOPE: 'Automatique dans le périmètre',
    } as Record<string, string>,
  },
  en: {
    busy: 'An operation is in progress.',
    notReady: 'Available once the incident is scoped, outside a running reproduction.',
    dismiss: 'Close the message',
    noneItem: 'None.',
    layer: 'Layer',
    files: 'Files',
    fileOutside: 'File missing from the code index: no link to the code.',
    hypothesisStatus: {
      PROPOSED: 'Proposed',
      INVESTIGATING: 'Being checked',
      SUPPORTED: 'Supported',
      REFUTED: 'Refuted',
      INCONCLUSIVE: 'Inconclusive',
      CONFIRMED: 'Confirmed',
    } as Record<HypothesisStatus, string>,
    experimentKinds: {
      REPLAY: 'Replay the scenario',
      COMPARE_REQUESTS: 'Compare requests',
      COMPARE_RESPONSES: 'Compare responses',
      UNIT_TEST: 'Unit test',
      INTEGRATION_TEST: 'Integration test',
      INSPECT_LOGS: 'Read the logs',
      CHECK_VALIDATION: 'Check a validation',
      COMPARE_WITH_PASSING: 'Compare with a passing case',
    } as Record<ExperimentKind, string>,
    experimentStatus: {
      PROPOSED: 'Planned',
      REFUSED: 'Refused',
      APPROVAL_REQUIRED: 'Approval required',
      RUNNING: 'Running',
      DONE: 'Done',
      ERROR: 'Error',
      CANCELLED: 'Cancelled',
    } as Record<ExperimentStatus, string>,
    outcomes: {
      SUPPORTS: 'Supports the hypothesis',
      REFUTES: 'Refutes the hypothesis',
      NEUTRAL: 'Neutral',
    } as Record<NonNullable<Experiment['outcome']>, string>,
    levels: { low: 'low', mid: 'medium', high: 'high' },
    confidence: 'Confidence',
    confidenceLabel: (percent: number, level: string) => `Confidence: ${String(percent)}% (${level})`,
    refKinds: {
      request: 'Request',
      evidence: 'Evidence',
      symbol: 'Symbol',
      experiment: 'Verification',
      other: 'Reference',
    } as Record<string, string>,
    hyp: {
      title: 'Hypotheses',
      sub: 'Each hypothesis lists its supporting and contradicting evidence; its confidence only rises with verifications.',
      none: 'No hypothesis yet.',
      analyze: 'Analyse the code and propose hypotheses',
      reanalyze: 'Analyse again',
      sortBy: 'Sort by',
      sorts: { confidence: 'Confidence', status: 'Status' } as Record<HypothesisSort, string>,
      ruleTitle: 'When is a hypothesis confirmed?',
      rule: 'A hypothesis is confirmed only with at least two favourable verifications of different kinds, one of them dynamic (replay, request or response comparison, test, log reading), and no contradicting evidence. A static verification alone (code reading) is never enough; a supported hypothesis remains a probable cause.',
      cause: 'Suspected cause',
      description: 'Description',
      select: (title: string) => `Select the hypothesis “${title}”`,
      expand: (title: string) => `Show the detail of “${title}”`,
      collapse: (title: string) => `Hide the detail of “${title}”`,
      details: 'Detail',
      hide: 'Hide',
      supporting: (n: number) => `Supporting evidence (${String(n)})`,
      contradicting: (n: number) => `Contradicting evidence (${String(n)})`,
      verifications: 'Proposed verifications',
      noVerification: 'No proposed verification.',
      plan: 'Plan',
      planLabel: (kind: string, title: string) => `Plan “${kind}” for the hypothesis “${title}”`,
      progress: 'Progress towards confirmation',
      checkKinds: (n: number) => `Two favourable verifications of different kinds (${String(n)} of 2)`,
      checkDynamic: 'At least one favourable dynamic verification',
      checkContrary: (n: number) =>
        n === 0 ? 'No contradicting evidence' : `No contradicting evidence (${String(n)} to resolve)`,
      met: 'met',
      unmet: 'missing',
      experiments: 'Linked verifications',
      noExperiment: 'No verification planned for this hypothesis.',
      notFound: 'This hypothesis no longer exists in the investigation.',
    },
    exp: {
      title: 'Experiments',
      sub: 'Each verification goes through the scope: a refusal is shown with its rule and reason, nothing runs outside it.',
      none: 'No verification planned.',
      noSideEffects: 'The scope does not allow side effects: verifications that write will be refused.',
      select: (kind: string) => `Select the verification “${kind}”`,
      run: 'Run',
      review: 'Review before running',
      runLabel: (kind: string) => `Run the verification “${kind}”`,
      reviewLabel: (kind: string) => `Review the side effects of “${kind}” before running`,
      running: 'Verification running…',
      sideEffects: 'Side effects',
      forHypothesis: 'Hypothesis',
      noHypothesis: 'No linked hypothesis',
      result: 'Result',
      approvedBy: (who: string) => `Approved by ${who}`,
      started: (at: string) => `Started on ${at}`,
      finished: (at: string) => `Finished on ${at}`,
      params: 'Parameters',
      refused: (n: number) => `${String(n)} operation(s) refused by the scope`,
      allowed: (n: number) => `${String(n)} operation(s) allowed`,
      rule: 'Rule',
      reason: 'Reason',
      extension: (kind: string, target: string) => `Extension that would allow it: ${kind} ${target}`,
      evidence: (n: number) => `${String(n)} evidence item(s)`,
      approveTitle: 'Approve a verification with side effects',
      approveText:
        'This verification may change data in the target environment (writes, integration test). It only runs with your explicit approval, in a suitable environment, never in production.',
      approveTarget: (target: string) => `Execution target: ${target}.`,
      scopeForbids:
        'The scope does not allow side effects yet: the server will refuse until an “Allow side effects” extension is approved.',
      writesRight: 'Approving requires the right to allow writes: ask a project administrator.',
      approveRun: 'Approve and run',
      approveLabel: (kind: string) => `Approve and run “${kind}” despite its side effects`,
      cancel: 'Cancel',
      planTitle: 'Plan a verification',
      planSub: 'The verification is planned, not run: it goes through the scope when launched.',
      kind: 'Kind',
      hypothesis: 'Hypothesis',
      paramsLegend: 'Parameters (key and value)',
      key: (n: number) => `Key of parameter ${String(n)}`,
      value: (n: number) => `Value of parameter ${String(n)}`,
      keyHead: 'Key',
      valueHead: 'Value',
      addParam: 'Add a parameter',
      removeParam: (n: number) => `Remove parameter ${String(n)}`,
      paramsHint: 'Recognised values: true / false, numbers, list separated by “|”.',
      known: 'Recognised parameters:',
      integrationNote:
        'An integration test always has possible side effects: it will wait for explicit approval.',
      plan: 'Plan',
      problems: {
        duplicate: (key: string) => `The parameter “${key}” is duplicated.`,
        emptyKey: (n: number) => `Parameter ${String(n)} has a value without a key.`,
      },
      notFound: 'This verification no longer exists in the investigation.',
    },
    diag: {
      title: 'Diagnosis',
      statuses: { CONFIRMED: 'Confirmed', PROBABLE: 'Probable', INCONCLUSIVE: 'Inconclusive' } as Record<
        Diagnosis['status'],
        string
      >,
      sentences: {
        CONFIRMED:
          'Root cause confirmed: at least two favourable verifications of different kinds, one of them dynamic, and no contradicting evidence.',
        PROBABLE:
          'Probable cause, not confirmed: the best supported hypothesis does not yet have the verifications required to be confirmed.',
        INCONCLUSIVE: 'Inconclusive diagnosis: the evidence is not enough to establish a cause.',
      } as Record<Diagnosis['status'], string>,
      rootConfirmed: 'Confirmed root cause',
      rootProbable: 'Probable cause',
      rootNone: 'No established cause',
      lead: 'Most advanced lead, not established:',
      noRoot: 'No hypothesis is supported enough to point to a cause.',
      hypothesis: 'Hypothesis',
      alternatives: 'Other explanations',
      missing: 'What is missing to conclude',
      recommendations: 'Recommendations',
      generated: (at: string) => `Established on ${at}`,
      rediagnose: 'Diagnose again',
      run: 'Establish the diagnosis',
      none: 'No diagnosis yet.',
      needHypotheses: 'The diagnosis is built from the hypotheses: run the analysis first.',
    },
    report: {
      title: 'Investigation report',
      generated: (at: string) => `Generated on ${at}`,
      exportJson: 'Export as JSON',
      exportMarkdown: 'Export as Markdown',
      exportNote: 'The file is produced by the server from the saved investigation.',
      reread: 'Refresh',
      loading: 'Loading the report…',
      missing: 'The report is not loaded yet.',
      incident: 'Incident',
      severity: 'Severity',
      state: 'State',
      observed: 'Observed',
      expected: 'Expected',
      environment: 'Environment',
      target: 'Execution target',
      environmentId: 'Project environment',
      baseUrl: 'Base URL',
      scope: 'Scope',
      mode: 'Mode',
      applications: 'Applications',
      endpoints: 'Targeted endpoints',
      depth: 'Analysis depth',
      scenario: 'Scenario',
      counts: 'In figures',
      timeline: 'timeline event(s)',
      failing: (total: number) => `failing request(s) out of ${String(total)}`,
      files: 'code file(s) kept',
      symbols: 'code symbol(s)',
      denied: 'path(s) refused by the scope',
      hypotheses: 'hypothesis(es)',
      experiments: 'verification(s)',
      diagnosis: 'Diagnosis',
      regression: 'Non-regression',
      limitations: 'What the report cannot assert',
      noLimitation: 'No limitation reported.',
      none: '—',
    },
    reg: {
      title: 'Non-regression test',
      propose: 'Propose a test',
      proposeAgain: 'Propose again',
      none: 'No test proposed.',
      noScenario: 'A library scenario is required to propose a test.',
      statuses: { PROPOSED: 'Proposed', ACCEPTED: 'Added to the library', REJECTED: 'Rejected' } as Record<
        RegressionTestProposal['status'],
        string
      >,
      name: 'Name',
      basedOn: 'From the scenario',
      expected: 'Expected result',
      file: 'File',
      verdict: 'Execution result',
      notRun: 'Not run yet',
      notRunHint: 'No verdict until the test has really run.',
      passed: 'Passed',
      failed: 'Failed',
      ranAt: (run: string, at: string) => `Run ${run} on ${at}`,
      run: 'Run the test',
      runAgain: 'Run again',
      accept: 'Add to the library',
      reject: 'Reject',
      libraryNote:
        'Adding the test puts it in the scenario library; nothing enters it without this validation.',
      runFirst: 'The test has not run yet: running it before adding it shows its verdict.',
      flow: 'Proposed flow (YAML, read-only)',
    },
    severities: { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' } as Record<
      string,
      string
    >,
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
    } as Record<string, string>,
    targets: { LOCAL: 'Local', REMOTE: 'Remote', ARO: 'Azure Red Hat OpenShift' } as Record<string, string>,
    modes: { MANUAL: 'Manual', GUIDED: 'Guided', AUTO_WITHIN_SCOPE: 'Automatic within the scope' } as Record<
      string,
      string
    >,
  },
} satisfies Record<Lang, unknown>;

type Text = (typeof TEXT)['fr'];
const text = (lang: Lang): Text => TEXT[lang];

/** Les paramètres que chaque nature de vérification reconnaît (lus dans le moteur des vérifications). */
const KNOWN_PARAMS: Record<ExperimentKind, readonly string[]> = {
  REPLAY: ['scenario', 'baseUrl', 'expectStatus', 'expectMessage'],
  COMPARE_REQUESTS: ['left', 'right', 'endpoint', 'field'],
  COMPARE_RESPONSES: ['left', 'right', 'endpoint', 'expectMissingField'],
  UNIT_TEST: ['applicationId', 'test', 'module', 'command', 'args', 'timeoutMs', 'patterns', 'expect'],
  INTEGRATION_TEST: [
    'applicationId',
    'test',
    'module',
    'command',
    'args',
    'environmentKind',
    'timeoutMs',
    'expect',
  ],
  INSPECT_LOGS: [
    'applicationId',
    'path',
    'selector',
    'namespace',
    'container',
    'tail',
    'sinceSeconds',
    'patterns',
    'maxLines',
    'expect',
  ],
  CHECK_VALIDATION: ['file', 'field', 'applicationId', 'expect', 'annotations'],
  COMPARE_WITH_PASSING: ['passingScenario', 'failing', 'endpoint', 'field', 'baseUrl'],
};

/** Les vérifications dynamiques (même liste que le moteur : rejeu, comparaisons, tests, journaux). */
const DYNAMIC_KINDS: readonly ExperimentKind[] = [
  'REPLAY',
  'COMPARE_WITH_PASSING',
  'COMPARE_REQUESTS',
  'COMPARE_RESPONSES',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'INSPECT_LOGS',
];

const EXPERIMENT_REF = /^experiment:([A-Z_]+):(.+)$/;

// ── Aides pures exportées ─────────────────────────────────────────────────────────────────────

const clampUnit = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
const percentOf = (value: number): number => Math.round(clampUnit(value) * 100);

/** Le libellé accessible d'une confiance (0 à 1) : pourcentage et niveau. */
export function confidenceLabel(value: number, lang: Lang): string {
  const t = text(lang);
  const unit = clampUnit(value);
  const level = unit < 0.34 ? t.levels.low : unit < 0.67 ? t.levels.mid : t.levels.high;
  return t.confidenceLabel(percentOf(unit), level);
}

/** Le verdict d'un test de non-régression : « réussi » seulement si `execution.passed === true`. */
export function regressionVerdict(
  regression: Pick<RegressionTestProposal, 'execution'> | undefined,
): 'PASSED' | 'FAILED' | 'NOT_RUN' {
  const passed = regression?.execution?.passed;
  if (passed === true) return 'PASSED';
  if (passed === false) return 'FAILED';
  return 'NOT_RUN';
}

const STATUS_ORDER: Record<HypothesisStatus, number> = {
  CONFIRMED: 0,
  SUPPORTED: 1,
  INVESTIGATING: 2,
  PROPOSED: 3,
  INCONCLUSIVE: 4,
  REFUTED: 5,
};

/** Les hypothèses triées (confiance décroissante, ou statut du plus avancé au réfuté). */
export function sortHypotheses(list: readonly Hypothesis[], sort: HypothesisSort): Hypothesis[] {
  const byConfidence = (a: Hypothesis, b: Hypothesis): number =>
    clampUnit(b.confidence) - clampUnit(a.confidence);
  const byStatus = (a: Hypothesis, b: Hypothesis): number => STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  return [...list].sort(
    (a, b) =>
      (sort === 'confidence' ? byConfidence(a, b) || byStatus(a, b) : byStatus(a, b) || byConfidence(a, b)) ||
      a.id.localeCompare(b.id),
  );
}

/** Où en est une hypothèse au regard de la règle de confirmation (informatif : le statut vient du serveur). */
export function confirmationProgress(hypothesis: Pick<Hypothesis, 'supporting' | 'contradicting'>): {
  kinds: number;
  verifications: number;
  dynamic: boolean;
  contrary: number;
} {
  const supports = hypothesis.supporting.flatMap((item) => {
    const match = EXPERIMENT_REF.exec(item.ref);
    return match?.[1] && match[2] ? [{ kind: match[1] as ExperimentKind, id: match[2] }] : [];
  });
  return {
    kinds: new Set(supports.map((item) => item.kind)).size,
    verifications: new Set(supports.map((item) => item.id)).size,
    dynamic: supports.some((item) => DYNAMIC_KINDS.includes(item.kind)),
    contrary: hypothesis.contradicting.length,
  };
}

function paramValue(raw: string): ProposedVerification['params'][string] {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.includes('|'))
    return value
      .split('|')
      .map((entry) => entry.trim())
      .filter(Boolean);
  return value;
}

export interface PlanInput {
  kind: ExperimentKind;
  params: ProposedVerification['params'];
  hypothesisId?: string;
}

/** Le brouillon du formulaire, prêt pour `client.incidents.planExperiment`, ou ses problèmes. */
export function planInputOf(
  draft: PlanDraft,
): { ok: true; input: PlanInput } | { ok: false; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const params: ProposedVerification['params'] = {};
  draft.params.forEach((row, index) => {
    const key = row.key.trim();
    if (!key) {
      if (row.value.trim()) problems.push({ code: 'emptyKey', index });
      return;
    }
    if (Object.hasOwn(params, key)) {
      problems.push({ code: 'duplicate', key, index });
      return;
    }
    params[key] = paramValue(row.value);
  });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    input: { kind: draft.kind, params, ...(draft.hypothesisId ? { hypothesisId: draft.hypothesisId } : {}) },
  };
}

// ── Réducteur (pur) ───────────────────────────────────────────────────────────────────────────

const isKind = (value: string | undefined): value is ExperimentKind =>
  value !== undefined && (EXPERIMENT_KINDS as readonly string[]).includes(value);

const indexOf = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * L'état local du diagnostic. Traite : `ws-dx-toggle` (data-hypothesis), `ws-dx-sort` (data-sort),
 * `ws-dx-run` seulement avec `data-approval="required"` (ouvre l'approbation dans la page, rien n'est
 * exécuté), `ws-dx-approve-cancel`, `ws-dx-field` (data-field `dx.kind` / `dx.hypothesisId` /
 * `dx.param.key` / `dx.param.value`, data-index, data-value), `ws-dx-plan-param-add`,
 * `ws-dx-plan-param-remove` (data-index), `ws-dx-plan-reset`, `ws-dx-dismiss` (data-key), et
 * `ws-dx-plan-submit` seulement quand le brouillon a des problèmes (sinon `undefined` : l'intégration
 * envoie `planInputOf(ui.plan)`). Écrans de la maquette : `ws-dx-check` (data-experiment, data-checked
 * `true|false` facultatif, sinon bascule), `ws-dx-why`, `ws-dx-section` (data-section, data-checked
 * facultatif), `ws-dx-sections` (data-value `all|none`), `ws-dx-reg-full`, `ws-dx-reg-tab`
 * (data-tab `flow|spec`). Toute autre action : `undefined`.
 */
export function reduceDiagnosis(
  ui: DiagnosisUi,
  action: string,
  dataset: Record<string, string | undefined>,
): DiagnosisUi | undefined {
  switch (action) {
    case 'ws-dx-toggle': {
      const id = dataset.hypothesis;
      if (!id) return undefined;
      return {
        ...ui,
        expanded: ui.expanded.includes(id)
          ? ui.expanded.filter((entry) => entry !== id)
          : [...ui.expanded, id],
      };
    }
    case 'ws-dx-sort': {
      const sort = dataset.sort;
      if (sort !== 'confidence' && sort !== 'status') return undefined;
      return { ...ui, sort };
    }
    case 'ws-dx-run': {
      if (dataset.approval !== 'required' || !dataset.experiment) return undefined;
      return { ...ui, approving: dataset.experiment };
    }
    case 'ws-dx-approve-cancel': {
      const { approving: _closed, ...rest } = ui;
      return rest;
    }
    case 'ws-dx-field': {
      const value = dataset.value ?? '';
      switch (dataset.field) {
        case 'dx.kind':
          return isKind(value) ? { ...ui, plan: { ...ui.plan, kind: value } } : undefined;
        case 'dx.hypothesisId':
          return { ...ui, plan: { ...ui.plan, hypothesisId: value } };
        case 'dx.param.key':
        case 'dx.param.value': {
          const index = indexOf(dataset.index);
          if (index === undefined || index >= ui.plan.params.length) return undefined;
          const field = dataset.field === 'dx.param.key' ? 'key' : 'value';
          return {
            ...ui,
            plan: {
              ...ui.plan,
              params: ui.plan.params.map((row, at) => (at === index ? { ...row, [field]: value } : row)),
            },
            planProblems: [],
          };
        }
        default:
          return undefined;
      }
    }
    case 'ws-dx-plan-param-add':
      return { ...ui, plan: { ...ui.plan, params: [...ui.plan.params, { key: '', value: '' }] } };
    case 'ws-dx-plan-param-remove': {
      const index = indexOf(dataset.index);
      if (index === undefined || index >= ui.plan.params.length) return undefined;
      const params = ui.plan.params.filter((_row, at) => at !== index);
      return {
        ...ui,
        plan: { ...ui.plan, params: params.length > 0 ? params : [{ key: '', value: '' }] },
        planProblems: [],
      };
    }
    case 'ws-dx-plan-reset':
      return { ...ui, plan: emptyPlanDraft(), planProblems: [] };
    case 'ws-dx-plan-submit': {
      const result = planInputOf(ui.plan);
      return result.ok ? undefined : { ...ui, planProblems: result.problems };
    }
    case 'ws-dx-check': {
      const id = dataset.experiment;
      if (!id) return undefined;
      const on = dataset.checked === undefined ? !ui.checked.includes(id) : dataset.checked === 'true';
      const rest = ui.checked.filter((entry) => entry !== id);
      return { ...ui, checked: on ? [...rest, id] : rest };
    }
    case 'ws-dx-why':
      return { ...ui, why: !ui.why };
    case 'ws-dx-section': {
      const section = REPORT_SECTIONS.find((entry) => entry === dataset.section);
      if (!section) return undefined;
      const on = dataset.checked === undefined ? !ui.sections.includes(section) : dataset.checked === 'true';
      return {
        ...ui,
        sections: REPORT_SECTIONS.filter((entry) => (entry === section ? on : ui.sections.includes(entry))),
      };
    }
    case 'ws-dx-sections':
      if (dataset.value === 'all') return { ...ui, sections: [...REPORT_SECTIONS] };
      if (dataset.value === 'none') return { ...ui, sections: [] };
      return undefined;
    case 'ws-dx-reg-full':
      return { ...ui, regFull: !ui.regFull };
    case 'ws-dx-reg-tab': {
      const tab = dataset.tab;
      if (tab !== 'flow' && tab !== 'spec') return undefined;
      return { ...ui, regTab: tab };
    }
    case 'ws-dx-dismiss': {
      const key = dataset.key;
      if (!key || !(key in ui.errors)) return undefined;
      const errors = Object.fromEntries(Object.entries(ui.errors).filter(([entry]) => entry !== key));
      return { ...ui, errors };
    }
    default:
      return undefined;
  }
}

// ── Pièces locales ────────────────────────────────────────────────────────────────────────────

const TONES: Record<string, string> = {
  PROPOSED: 'mu',
  INVESTIGATING: 'live',
  SUPPORTED: 'live',
  REFUTED: 'mu',
  INCONCLUSIVE: 'warn',
  CONFIRMED: 'ok',
  REFUSED: 'ko',
  APPROVAL_REQUIRED: 'warn',
  RUNNING: 'live',
  DONE: 'ok',
  ERROR: 'ko',
  CANCELLED: 'mu',
  SUPPORTS: 'ok',
  REFUTES: 'ko',
  NEUTRAL: 'mu',
  PROBABLE: 'warn',
  ACCEPTED: 'ok',
  REJECTED: 'mu',
  PASSED: 'ok',
  FAILED: 'ko',
  NOT_RUN: 'mu',
};

const chip = (raw: string, label: string, extra = ''): string =>
  `<span class="pill ${TONES[raw] ?? 'mu'} ws-dx-chip" data-status="${esc(raw)}"${extra}>${esc(label)}</span>`;

/** Un identifiant d'élément HTML sûr (les ids du domaine peuvent porter « : », « # », « / »). */
const domId = (prefix: string, id: string): string => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** L'incident permet-il d'investiguer (analyse, vérifications, diagnostic) ? Même règle que la page actuelle. */
const investigable = (incident: Pick<Incident, 'state'>): boolean =>
  incident.state !== 'DRAFT' &&
  incident.state !== 'REPRODUCING' &&
  incident.state !== 'CANCELLED' &&
  incident.state !== 'FAILED';

const listOrNone = (items: string[], none: string): string =>
  items.length === 0
    ? `<p class="mu">${esc(none)}</p>`
    : `<ul class="plain tight ws-dx-list">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;

function errorBox(ctx: WorkspaceContext, ui: DiagnosisUi, key: string): string {
  const message = ui.errors[key];
  if (!message) return '';
  return `<div class="err-box ws-dx-err" role="alert"><p class="err">${esc(message)}</p><button type="button" class="btn small ghost" data-action="ws-dx-dismiss" data-key="${esc(key)}" aria-label="${esc(text(ctx.lang).dismiss)}">${icon('close')}</button></div>`;
}

interface OpButton {
  action: string;
  label: string;
  /** Le nom accessible quand le libellé visible ne suffit pas. */
  aria?: string;
  ref?: string;
  data?: Record<string, string>;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  /** Désactivé, avec la raison (visible et liée par aria-describedby). */
  reason?: string;
  reasonId?: string;
}

/** Un bouton d'opération : désactivé pendant une autre opération ou avec sa raison ; `aria-busy` pendant la sienne. */
function opButton(ctx: WorkspaceContext, ui: DiagnosisUi, options: OpButton): string {
  const key = diagnosisBusyKey(options.action, options.ref);
  const busy = ui.busy === key;
  const blocked = ui.busy !== undefined;
  const disabled = options.reason !== undefined || blocked;
  const title = options.reason ?? (blocked && !busy ? text(ctx.lang).busy : undefined);
  const data = Object.entries(options.data ?? {})
    .map(([name, value]) => ` data-${name}="${esc(value)}"`)
    .join('');
  const classes = `btn${options.small ? ' small' : ''}${options.primary ? ' primary' : ''}${options.danger ? ' danger' : ''}`;
  return `<button type="button" class="${classes}" data-action="${esc(options.action)}"${data}${options.aria ? ` aria-label="${esc(options.aria)}"` : ''}${disabled ? ' disabled' : ''}${options.reason && options.reasonId ? ` aria-describedby="${esc(options.reasonId)}"` : ''}${title ? ` title="${esc(title)}"` : ''} aria-busy="${String(busy)}">${busy ? '<span class="spin sm" aria-hidden="true"></span>' : ''}${esc(options.label)}</button>`;
}

const reasonNote = (id: string, reason: string | undefined): string =>
  reason ? `<small class="mu ws-dx-why" id="${esc(id)}">${esc(reason)}</small>` : '';

/** La barre de confiance : `role="meter"`, valeur et libellé accessibles, pourcentage visible. */
function confidenceBar(ctx: WorkspaceContext, value: number, showPercent = true): string {
  const percent = percentOf(value);
  const label = confidenceLabel(value, ctx.lang);
  const level = clampUnit(value) < 0.34 ? 'low' : clampUnit(value) < 0.67 ? 'mid' : 'high';
  return `<span class="ws-dx-conf"><span class="ws-dx-meter ws-dx-${level}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${String(percent)}" aria-valuetext="${esc(label)}" aria-label="${esc(label)}"><span class="ws-dx-fill" style="width:${String(percent)}%"></span></span>${showPercent ? `<b aria-hidden="true">${String(percent)} %</b>` : ''}</span>`;
}

// ── Références (preuves, requêtes, symboles, vérifications) ──────────────────────────────────

interface RefIndex {
  requests: ReadonlySet<string>;
  evidence: ReadonlySet<string>;
  symbols: ReadonlyMap<string, string>;
  experiments: ReadonlyMap<string, Experiment>;
}

function refIndex(incident: Incident): RefIndex {
  const investigation = incident.investigation;
  return {
    requests: new Set(
      investigation.reproductions.flatMap((run) => run.requests.map((request) => request.id)),
    ),
    evidence: new Set([
      ...investigation.reproductions.flatMap((run) => run.evidence.map((item) => item.id)),
      ...investigation.experiments.flatMap((experiment) => experiment.evidence.map((item) => item.id)),
    ]),
    symbols: new Map((investigation.code?.symbols ?? []).map((symbol) => [symbol.id, symbol.name])),
    experiments: new Map(investigation.experiments.map((experiment) => [experiment.id, experiment])),
  };
}

function refTarget(index: RefIndex, ref: string): { kind: SelectionKind; id: string } | undefined {
  if (index.requests.has(ref)) return { kind: 'request', id: ref };
  if (index.evidence.has(ref)) return { kind: 'evidence', id: ref };
  if (index.symbols.has(ref)) return { kind: 'symbol', id: ref };
  const experiment = EXPERIMENT_REF.exec(ref)?.[2];
  if (experiment) return { kind: 'experiment', id: experiment };
  if (index.experiments.has(ref)) return { kind: 'experiment', id: ref };
  return undefined;
}

/** Une référence : une puce sélectionnable quand elle désigne un élément de l'investigation, sinon le texte. */
function refHtml(ctx: WorkspaceContext, index: RefIndex, ref: string): string {
  const t = text(ctx.lang);
  const target = refTarget(index, ref);
  if (!target) return `<code class="ws-dx-ref" title="${esc(t.refKinds.other ?? '')}">${esc(ref)}</code>`;
  if (target.kind === 'request' || target.kind === 'evidence') return evidenceChips(ctx, [ref]);
  if (target.kind === 'symbol') {
    const name = index.symbols.get(target.id) ?? target.id;
    const source = ctx.links.sources.get(`symbol:${target.id}`);
    return `<span class="ws-chips"><button type="button" class="ws-chip ${selectionClass(ctx, 'symbol', target.id)}" ${selectable(ctx, 'symbol', target.id)} title="${esc(`${t.refKinds.symbol ?? ''} ${target.id}`)}">${esc(name)}</button>${source ? sourceLink(ctx.lang, source) : ''}</span>`;
  }
  const experiment = index.experiments.get(target.id);
  const kindMatch = EXPERIMENT_REF.exec(ref)?.[1];
  const kind = experiment?.kind ?? (isKind(kindMatch) ? kindMatch : undefined);
  const label = kind ? t.experimentKinds[kind] : target.id;
  return `<span class="ws-chips"><button type="button" class="ws-chip ${selectionClass(ctx, 'experiment', target.id)}" ${selectable(ctx, 'experiment', target.id)} title="${esc(`${t.refKinds.experiment ?? ''} ${target.id}`)}">${esc(label)}</button></span>`;
}

function factsList(
  ctx: WorkspaceContext,
  index: RefIndex,
  items: Hypothesis['supporting'],
  tone: 'pro' | 'con',
): string {
  if (items.length === 0) return `<p class="mu">${esc(text(ctx.lang).noneItem)}</p>`;
  return `<ul class="plain ws-dx-facts ws-dx-${tone}">${items
    .map(
      (item) => `<li class="ws-dx-fact"><span>${esc(item.fact)}</span>${refHtml(ctx, index, item.ref)}</li>`,
    )
    .join('')}</ul>`;
}

/** Les fichiers : un lien vers le code pour chaque application qui déclare le fichier, sinon le chemin seul. */
function fileLinks(ctx: WorkspaceContext, files: readonly string[]): string {
  if (files.length === 0) return '';
  const t = text(ctx.lang);
  const items = files.flatMap((file) => {
    const applications = ctx.links.fileApplications.get(file) ?? [];
    if (applications.length === 0)
      return [`<li><code class="ws-dx-file" title="${esc(t.fileOutside)}">${esc(file)}</code></li>`];
    return applications.map((applicationId) => {
      const key = fileId(applicationId, file);
      const source: SourceLocation = ctx.links.sources.get(`file:${key}`) ?? {
        applicationId,
        layer: 'FRONTEND',
        file,
        line: 1,
      };
      const label = applications.length > 1 ? `${file} (${applicationId})` : file;
      return `<li class="${selectionClass(ctx, 'file', key)}">${sourceLink(ctx.lang, source, label)}</li>`;
    });
  });
  return `<ul class="plain ws-dx-files" aria-label="${esc(t.files)}">${items.join('')}</ul>`;
}

// ── Hypothèses ────────────────────────────────────────────────────────────────────────────────

function planReason(ctx: WorkspaceContext): string | undefined {
  return investigable(ctx.incident) ? undefined : text(ctx.lang).notReady;
}

function verificationsList(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  hypothesis: Hypothesis,
  prefix: string,
): string {
  const t = text(ctx.lang);
  if (hypothesis.verifications.length === 0) return `<p class="mu">${esc(t.hyp.noVerification)}</p>`;
  const runner = ctx.can('RUN');
  const reason = planReason(ctx);
  const reasonId = domId(`${prefix}-why`, hypothesis.id);
  return `<ul class="plain ws-dx-verifs">${hypothesis.verifications
    .map((verification, index) => {
      const kind = t.experimentKinds[verification.kind];
      const button = runner
        ? opButton(ctx, ui, {
            action: 'ws-dx-plan',
            label: t.hyp.plan,
            aria: t.hyp.planLabel(kind, hypothesis.title),
            ref: `${hypothesis.id}#${String(index)}`,
            data: { hypothesis: hypothesis.id, index: String(index) },
            small: true,
            ...(reason ? { reason, reasonId } : {}),
          })
        : '';
      return `<li class="ws-dx-verif">${chip('PROPOSED', kind)}<span>${esc(verification.description)}</span>${button}</li>`;
    })
    .join('')}</ul>${runner ? reasonNote(reasonId, reason) : ''}`;
}

function progressList(ctx: WorkspaceContext, hypothesis: Hypothesis): string {
  const t = text(ctx.lang);
  const progress = confirmationProgress(hypothesis);
  const kinds = Math.min(progress.kinds, progress.verifications);
  const item = (met: boolean, label: string): string =>
    `<li class="${met ? 'ok' : 'ko'}">${icon(met ? 'check' : 'cross')}<span>${esc(label)} <small class="mu">(${esc(met ? t.hyp.met : t.hyp.unmet)})</small></span></li>`;
  return `<ul class="checks ws-dx-progress" aria-label="${esc(t.hyp.progress)}">${item(kinds >= 2, t.hyp.checkKinds(Math.min(kinds, 2)))}${item(progress.dynamic, t.hyp.checkDynamic)}${item(progress.contrary === 0, t.hyp.checkContrary(progress.contrary))}</ul>`;
}

function hypothesisBody(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  index: RefIndex,
  hypothesis: Hypothesis,
  prefix: string,
): string {
  const t = text(ctx.lang);
  return `<div class="ws-dx-body">${hypothesis.description ? `<p>${esc(hypothesis.description)}</p>` : ''}<div class="ws-dx-evidence"><section class="ws-dx-side ws-dx-side-pro"><h4>${icon('check')}<span>${esc(t.hyp.supporting(hypothesis.supporting.length))}</span></h4>${factsList(ctx, index, hypothesis.supporting, 'pro')}</section><section class="ws-dx-side ws-dx-side-con"><h4>${icon('cross')}<span>${esc(t.hyp.contradicting(hypothesis.contradicting.length))}</span></h4>${factsList(ctx, index, hypothesis.contradicting, 'con')}</section></div>${
    hypothesis.files.length > 0 ? `<h4>${esc(t.files)}</h4>${fileLinks(ctx, hypothesis.files)}` : ''
  }<h4>${esc(t.hyp.progress)}</h4>${progressList(ctx, hypothesis)}<h4>${esc(t.hyp.verifications)}</h4>${verificationsList(ctx, ui, hypothesis, prefix)}${errorBox(ctx, ui, `hypothesis:${hypothesis.id}`)}</div>`;
}

function hypothesisCard(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  index: RefIndex,
  hypothesis: Hypothesis,
): string {
  const t = text(ctx.lang);
  const expanded = ui.expanded.includes(hypothesis.id);
  const bodyId = domId('ws-dx-hb', hypothesis.id);
  const titleId = domId('ws-dx-ht', hypothesis.id);
  const layer = partsText(ctx.lang).layers[hypothesis.layer];
  return `<li class="card ws-dx-hyp ${selectionClass(ctx, 'hypothesis', hypothesis.id)}" data-hypothesis="${esc(hypothesis.id)}" aria-labelledby="${titleId}"><div class="ws-dx-head"><h3 id="${titleId}"><button type="button" class="lnk ws-dx-title" ${selectable(ctx, 'hypothesis', hypothesis.id)} aria-label="${esc(t.hyp.select(hypothesis.title))}">${esc(hypothesis.title)}</button></h3><span class="ws-dx-meta">${originPill(hypothesis, ctx.lang)}${chip(hypothesis.status, t.hypothesisStatus[hypothesis.status])}<span class="ws-dx-layer"><small class="mu">${esc(t.layer)}</small> ${esc(layer)}</span>${confidenceBar(ctx, hypothesis.confidence)}</span></div><p class="ws-dx-cause"><b>${esc(t.hyp.cause)} :</b> ${esc(hypothesis.suspectedCause)}</p><button type="button" class="btn small ghost ws-dx-toggle" data-action="ws-dx-toggle" data-hypothesis="${esc(hypothesis.id)}" aria-expanded="${String(expanded)}" aria-controls="${bodyId}" aria-label="${esc(expanded ? t.hyp.collapse(hypothesis.title) : t.hyp.expand(hypothesis.title))}">${icon(expanded ? 'up' : 'down')}<span>${esc(expanded ? t.hyp.hide : t.hyp.details)}</span></button><div id="${bodyId}"${expanded ? '' : ' hidden'}>${expanded ? hypothesisBody(ctx, ui, index, hypothesis, 'ws-dx-h') : ''}</div></li>`;
}

function ruleNote(ctx: WorkspaceContext): string {
  const t = text(ctx.lang);
  return `<div class="note ws-dx-rule" role="note">${icon('info')}<div><b>${esc(t.hyp.ruleTitle)}</b><p>${esc(t.hyp.rule)}</p></div></div>`;
}

/** L'onglet « Hypothèses ». */
export function renderHypotheses(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const list = ctx.incident.investigation.hypotheses;
  const reason = planReason(ctx);
  const analyze = ctx.can('RUN')
    ? `${opButton(ctx, ui, {
        action: 'ws-dx-analyze',
        label: ctx.incident.investigation.code ? t.hyp.reanalyze : t.hyp.analyze,
        primary: list.length === 0,
        ...(reason ? { reason, reasonId: 'ws-dx-analyze-why' } : {}),
      })}${reasonNote('ws-dx-analyze-why', reason)}`
    : '';
  const head = `<section class="card wide ws-dx-intro"><div class="card-h"><h2>${esc(t.hyp.title)}</h2><div class="row-acts">${analyze}</div></div><p class="mu">${esc(t.hyp.sub)}</p>${ruleNote(ctx)}${errorBox(ctx, ui, 'analyze')}</section>`;
  if (list.length === 0) return `${head}${panelState(ctx.lang, 'empty', t.hyp.none)}`;
  const index = refIndex(ctx.incident);
  const sorts = `<div class="ws-dx-sort" role="group" aria-label="${esc(t.hyp.sortBy)}"><span class="mu">${esc(t.hyp.sortBy)} :</span>${(
    ['confidence', 'status'] as const
  )
    .map(
      (sort) =>
        `<button type="button" class="btn small${ui.sort === sort ? ' primary' : ' ghost'}" data-action="ws-dx-sort" data-sort="${sort}" aria-pressed="${String(ui.sort === sort)}">${esc(t.hyp.sorts[sort])}</button>`,
    )
    .join('')}</div>`;
  const cards = sortHypotheses(list, ui.sort)
    .map((hypothesis) => hypothesisCard(ctx, ui, index, hypothesis))
    .join('');
  return `${head}${sorts}<ul class="plain ws-dx-hyps">${cards}</ul>`;
}

// ── Expériences ───────────────────────────────────────────────────────────────────────────────

const needsApproval = (experiment: Experiment): boolean =>
  experiment.sideEffects || experiment.status === 'APPROVAL_REQUIRED';

function decisionsBlock(ctx: WorkspaceContext, decisions: readonly PolicyDecision[]): string {
  const t = text(ctx.lang);
  const refused = decisions.filter((decision) => !decision.allowed);
  const allowed = decisions.filter((decision) => decision.allowed);
  const refusedHtml =
    refused.length === 0
      ? ''
      : `<div class="ws-dx-refused" role="note"><b>${esc(t.exp.refused(refused.length))}</b><ul class="checks">${refused
          .map(
            (decision) =>
              `<li class="ko">${icon('cross')}<span><span class="ws-dx-reason"><small class="mu">${esc(t.exp.reason)} :</small> ${esc(decision.reason)}</span> <span class="ws-dx-rulename"><small class="mu">${esc(t.exp.rule)} :</small> <code>${esc(decision.rule)}</code></span>${
                decision.extension
                  ? ` <small class="mu block">${esc(t.exp.extension(decision.extension.kind, decision.extension.target))}</small>`
                  : ''
              }</span></li>`,
          )
          .join('')}</ul></div>`;
  const allowedHtml =
    allowed.length === 0
      ? ''
      : `<details class="ws-dx-allowed"><summary>${esc(t.exp.allowed(allowed.length))}</summary><ul class="checks">${allowed
          .map(
            (decision) =>
              `<li class="ok">${icon('check')}<span>${esc(decision.reason)} <code>${esc(decision.rule)}</code></span></li>`,
          )
          .join('')}</ul></details>`;
  return refusedHtml + allowedHtml;
}

function paramsBlock(ctx: WorkspaceContext, params: Experiment['params']): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return '';
  return `<p class="ws-dx-params" aria-label="${esc(text(ctx.lang).exp.params)}">${entries
    .map(
      ([key, value]) =>
        `<code>${esc(`${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)}</code>`,
    )
    .join(' ')}</p>`;
}

function approvalPanel(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  experiment: Experiment,
  prefix: string,
): string {
  const t = text(ctx.lang);
  const id = domId(`${prefix}-ap`, experiment.id);
  const kind = t.experimentKinds[experiment.kind];
  const writer = ctx.can('RUN_WRITES');
  const target = t.targets[ctx.incident.execution.target] ?? ctx.incident.execution.target;
  return `<div class="ws-dx-approve" role="group" aria-labelledby="${id}"><h4 id="${id}">${icon('alert')}<span>${esc(t.exp.approveTitle)}</span></h4><p>${esc(t.exp.approveText)}</p><p class="mu">${esc(t.exp.approveTarget(target))}</p>${
    ctx.incident.scope.permissions.sideEffects
      ? ''
      : `<p class="note">${icon('info')}<span>${esc(t.exp.scopeForbids)}</span></p>`
  }${writer ? '' : `<p class="note">${icon('info')}<span>${esc(t.exp.writesRight)}</span></p>`}<div class="row-acts">${
    writer
      ? opButton(ctx, ui, {
          action: 'ws-dx-approve',
          label: t.exp.approveRun,
          aria: t.exp.approveLabel(kind),
          ref: experiment.id,
          data: { experiment: experiment.id },
          danger: true,
        })
      : ''
  }<button type="button" class="btn ghost" data-action="ws-dx-approve-cancel" data-experiment="${esc(experiment.id)}">${esc(t.exp.cancel)}</button></div></div>`;
}

function experimentControl(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  experiment: Experiment,
  prefix: string,
): string {
  const t = text(ctx.lang);
  if (!ctx.can('RUN')) return '';
  if (experiment.status !== 'PROPOSED' && experiment.status !== 'APPROVAL_REQUIRED') return '';
  if (ui.approving === experiment.id && needsApproval(experiment))
    return approvalPanel(ctx, ui, experiment, prefix);
  const kind = t.experimentKinds[experiment.kind];
  const approval = needsApproval(experiment);
  const reason = planReason(ctx);
  const reasonId = domId(`${prefix}-rwhy`, experiment.id);
  return `<div class="row-acts">${opButton(ctx, ui, {
    action: 'ws-dx-run',
    label: approval ? t.exp.review : t.exp.run,
    aria: approval ? t.exp.reviewLabel(kind) : t.exp.runLabel(kind),
    ref: experiment.id,
    data: { experiment: experiment.id, ...(approval ? { approval: 'required' } : {}) },
    primary: !approval,
    ...(reason ? { reason, reasonId } : {}),
  })}${reasonNote(reasonId, reason)}</div>`;
}

function experimentBody(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  experiment: Experiment,
  prefix: string,
): string {
  const t = text(ctx.lang);
  const hypothesis = ctx.incident.investigation.hypotheses.find(
    (entry) => entry.id === experiment.hypothesisId,
  );
  const linked = hypothesis
    ? `<button type="button" class="lnk ${selectionClass(ctx, 'hypothesis', hypothesis.id)}" ${selectable(ctx, 'hypothesis', hypothesis.id)} aria-label="${esc(t.hyp.select(hypothesis.title))}">${esc(hypothesis.title)}</button>`
    : experiment.hypothesisId
      ? `<code>${esc(experiment.hypothesisId)}</code>`
      : `<span class="mu">${esc(t.exp.noHypothesis)}</span>`;
  const evidenceIds = experiment.evidence.map((item) => item.id);
  const times = [
    experiment.startedAt ? t.exp.started(formatDate(experiment.startedAt, ctx.lang)) : '',
    experiment.finishedAt ? t.exp.finished(formatDate(experiment.finishedAt, ctx.lang)) : '',
    experiment.approvedBy ? t.exp.approvedBy(experiment.approvedBy) : '',
  ].filter(Boolean);
  return `<p>${esc(experiment.description)}</p><p class="ws-dx-for"><small class="mu">${esc(t.exp.forHypothesis)} :</small> ${linked}</p>${paramsBlock(ctx, experiment.params)}${
    experiment.status === 'RUNNING'
      ? `<p class="ws-dx-running" aria-busy="true"><span class="spin sm" aria-hidden="true"></span><span>${esc(t.exp.running)}</span></p>`
      : ''
  }${experiment.summary ? `<p class="ws-dx-summary"><b>${esc(t.exp.result)} :</b> ${esc(experiment.summary)}</p>` : ''}${
    times.length > 0 ? `<p class="mu ws-dx-times">${times.map((entry) => esc(entry)).join(' · ')}</p>` : ''
  }${decisionsBlock(ctx, experiment.decisions)}${
    evidenceIds.length > 0
      ? `<p class="ws-dx-ev"><small class="mu">${esc(t.exp.evidence(evidenceIds.length))}</small> ${evidenceChips(ctx, evidenceIds, 6)}</p>`
      : ''
  }${errorBox(ctx, ui, `experiment:${experiment.id}`)}${experimentControl(ctx, ui, experiment, prefix)}`;
}

function experimentHeadChips(ctx: WorkspaceContext, experiment: Experiment): string {
  const t = text(ctx.lang);
  return `${chip(experiment.status, t.experimentStatus[experiment.status])}${experiment.sideEffects ? chip('APPROVAL_REQUIRED', t.exp.sideEffects) : ''}${experiment.outcome ? chip(experiment.outcome, t.outcomes[experiment.outcome]) : ''}`;
}

function experimentCard(ctx: WorkspaceContext, ui: DiagnosisUi, experiment: Experiment): string {
  const t = text(ctx.lang);
  const kind = t.experimentKinds[experiment.kind];
  const titleId = domId('ws-dx-et', experiment.id);
  return `<li class="card ws-dx-exp ${selectionClass(ctx, 'experiment', experiment.id)}" data-experiment="${esc(experiment.id)}" aria-labelledby="${titleId}"><div class="ws-dx-head"><h3 id="${titleId}"><button type="button" class="lnk ws-dx-title" ${selectable(ctx, 'experiment', experiment.id)} aria-label="${esc(t.exp.select(kind))}">${esc(kind)}</button></h3><span class="ws-dx-meta">${experimentHeadChips(ctx, experiment)}</span></div>${experimentBody(ctx, ui, experiment, 'ws-dx-e')}</li>`;
}

function planForm(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const draft = ui.plan;
  const hypotheses = ctx.incident.investigation.hypotheses;
  const problems = ui.planProblems;
  const invalidRows = new Set(problems.map((problem) => problem.index));
  const rows = draft.params
    .map((row, index) => {
      const n = index + 1;
      const invalid = invalidRows.has(index)
        ? ' aria-invalid="true" aria-describedby="ws-dx-plan-problems"'
        : '';
      return `<li class="ws-dx-param"><input type="text" class="mono" data-ws-field="dx.param.key" data-index="${String(index)}" value="${esc(row.key)}" aria-label="${esc(t.exp.key(n))}" placeholder="${esc(t.exp.keyHead)}" autocomplete="off" spellcheck="false"${invalid}><input type="text" class="mono" data-ws-field="dx.param.value" data-index="${String(index)}" value="${esc(row.value)}" aria-label="${esc(t.exp.value(n))}" placeholder="${esc(t.exp.valueHead)}" autocomplete="off" spellcheck="false"><button type="button" class="btn small ghost" data-action="ws-dx-plan-param-remove" data-index="${String(index)}" aria-label="${esc(t.exp.removeParam(n))}">${icon('trash')}</button></li>`;
    })
    .join('');
  const problemList =
    problems.length === 0
      ? ''
      : `<ul class="plain tight err" id="ws-dx-plan-problems" role="alert">${problems
          .map(
            (problem) =>
              `<li>${esc(problem.code === 'duplicate' ? t.exp.problems.duplicate(problem.key) : t.exp.problems.emptyKey(problem.index + 1))}</li>`,
          )
          .join('')}</ul>`;
  const blocked = ui.busy !== undefined;
  return `<section class="card wide ws-dx-plan"><form class="col ws-dx-form" data-action="ws-dx-plan-submit" novalidate aria-labelledby="ws-dx-plan-title"><h2 id="ws-dx-plan-title">${esc(t.exp.planTitle)}</h2><p class="mu">${esc(t.exp.planSub)}</p><div class="ws-dx-fields"><label class="field" for="ws-dx-plan-kind">${esc(t.exp.kind)}<select id="ws-dx-plan-kind" data-ws-field="dx.kind">${EXPERIMENT_KINDS.map(
    (kind) =>
      `<option value="${kind}"${kind === draft.kind ? ' selected' : ''}>${esc(t.experimentKinds[kind])}</option>`,
  ).join(
    '',
  )}</select></label><label class="field" for="ws-dx-plan-hyp">${esc(t.exp.hypothesis)}<select id="ws-dx-plan-hyp" data-ws-field="dx.hypothesisId"><option value=""${draft.hypothesisId === '' ? ' selected' : ''}>${esc(t.exp.noHypothesis)}</option>${hypotheses
    .map(
      (hypothesis) =>
        `<option value="${esc(hypothesis.id)}"${hypothesis.id === draft.hypothesisId ? ' selected' : ''}>${esc(hypothesis.title)}</option>`,
    )
    .join(
      '',
    )}</select></label></div>${draft.kind === 'INTEGRATION_TEST' ? `<p class="note">${icon('alert')}<span>${esc(t.exp.integrationNote)}</span></p>` : ''}<fieldset class="ws-dx-paramset"><legend>${esc(t.exp.paramsLegend)}</legend><ul class="plain ws-dx-params-rows">${rows}</ul><button type="button" class="btn small" data-action="ws-dx-plan-param-add">${icon('plus')}<span>${esc(t.exp.addParam)}</span></button><small class="mu block" id="ws-dx-plan-hint">${esc(t.exp.paramsHint)} ${esc(t.exp.known)} ${KNOWN_PARAMS[
    draft.kind
  ]
    .map((key) => esc(key))
    .join(
      ', ',
    )}</small></fieldset>${problemList}${errorBox(ctx, ui, 'plan')}<div class="form-acts start"><button type="submit" class="btn"${blocked ? ' disabled' : ''} aria-busy="${String(ui.busy === 'ws-dx-plan-submit')}">${esc(t.exp.plan)}</button></div></form></section>`;
}

/** L'onglet « Expériences ». */
export function renderExperiments(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const list = ctx.incident.investigation.experiments;
  const head = `<section class="card wide ws-dx-intro"><h2>${esc(t.exp.title)}</h2><p class="mu">${esc(t.exp.sub)}</p>${
    ctx.incident.scope.permissions.sideEffects ? '' : `<p class="mu">${esc(t.exp.noSideEffects)}</p>`
  }</section>`;
  const cards =
    list.length === 0
      ? panelState(ctx.lang, 'empty', t.exp.none)
      : `<ul class="plain ws-dx-exps">${list.map((experiment) => experimentCard(ctx, ui, experiment)).join('')}</ul>`;
  const plan = ctx.can('RUN') && investigable(ctx.incident) ? planForm(ctx, ui) : '';
  return `${head}${cards}${plan}`;
}

// ── Diagnostic ────────────────────────────────────────────────────────────────────────────────

function hypothesisLink(ctx: WorkspaceContext, hypothesisId: string): string {
  const hypothesis = ctx.incident.investigation.hypotheses.find((entry) => entry.id === hypothesisId);
  const label = hypothesis?.title ?? hypothesisId;
  return `<button type="button" class="lnk ${selectionClass(ctx, 'hypothesis', hypothesisId)}" ${selectable(ctx, 'hypothesis', hypothesisId)} aria-label="${esc(text(ctx.lang).hyp.select(label))}">${esc(label)}</button>`;
}

/** Le titre de la carte de cause : « Cause racine confirmée » seulement si le diagnostic est CONFIRMED. */
function rootTitle(t: Text, diagnosis: Diagnosis): string {
  if (diagnosis.status === 'CONFIRMED' && diagnosis.rootCause) return t.diag.rootConfirmed;
  if (diagnosis.status === 'PROBABLE' && diagnosis.rootCause) return t.diag.rootProbable;
  return t.diag.rootNone;
}

function rootCard(ctx: WorkspaceContext, diagnosis: Diagnosis): string {
  const t = text(ctx.lang);
  const root = diagnosis.rootCause;
  const title = rootTitle(t, diagnosis);
  const tone =
    diagnosis.status === 'CONFIRMED' && root ? 'ok' : root && diagnosis.status === 'PROBABLE' ? 'warn' : 'mu';
  if (!root)
    return `<section class="ws-dx-root ws-dx-root-${tone}" aria-labelledby="ws-dx-root-t"><h3 id="ws-dx-root-t">${esc(title)}</h3><p class="mu">${esc(t.diag.noRoot)}</p></section>`;
  const lead = diagnosis.status === 'INCONCLUSIVE' ? `<p class="mu">${esc(t.diag.lead)}</p>` : '';
  return `<section class="ws-dx-root ws-dx-root-${tone}" aria-labelledby="ws-dx-root-t"><h3 id="ws-dx-root-t">${esc(title)}</h3>${lead}<p class="ws-dx-statement"><b>${esc(root.statement)}</b></p><dl class="ws-dx-dl"><div><dt>${esc(t.layer)}</dt><dd>${esc(partsText(ctx.lang).layers[root.layer])}</dd></div><div><dt>${esc(t.diag.hypothesis)}</dt><dd>${hypothesisLink(ctx, root.hypothesisId)}</dd></div></dl>${
    root.files.length > 0 ? `<h4>${esc(t.files)}</h4>${fileLinks(ctx, root.files)}` : ''
  }</section>`;
}

/** L'onglet « Diagnostic ». */
export function renderDiagnosis(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const diagnosis = ctx.incident.investigation.diagnosis;
  const hypotheses = ctx.incident.investigation.hypotheses;
  const reason = !investigable(ctx.incident)
    ? t.notReady
    : hypotheses.length === 0
      ? t.diag.needHypotheses
      : undefined;
  const action = ctx.can('RUN')
    ? `<div class="row-acts">${opButton(ctx, ui, {
        action: 'ws-dx-diagnose',
        label: diagnosis ? t.diag.rediagnose : t.diag.run,
        primary: !diagnosis,
        ...(reason ? { reason, reasonId: 'ws-dx-diag-why' } : {}),
      })}${reasonNote('ws-dx-diag-why', reason)}</div>`
    : '';
  const head = `<div class="card-h"><h2>${esc(t.diag.title)}</h2>${action}</div>`;
  if (!diagnosis)
    return `${demoBanner(ctx)}<section class="card wide ws-dx-diag">${head}${errorBox(ctx, ui, 'diagnose')}<p class="mu">${esc(hypotheses.length === 0 ? t.diag.needHypotheses : t.diag.none)}</p></section>`;
  const alternatives = diagnosis.alternatives.map(
    (entry) =>
      `<span class="ws-dx-alt"><span>${esc(entry.statement)}</span>${hypothesisLink(ctx, entry.hypothesisId)}${confidenceBar(ctx, entry.confidence)}</span>`,
  );
  return `${demoBanner(ctx)}<section class="card wide ws-dx-diag" data-status="${esc(diagnosis.status)}">${head}${errorBox(ctx, ui, 'diagnose')}<p class="ws-dx-status">${chip(diagnosis.status, t.diag.statuses[diagnosis.status])}<span>${esc(t.diag.sentences[diagnosis.status])}</span></p><p class="mu"><small>${esc(t.diag.generated(formatDate(diagnosis.generatedAt, ctx.lang)))}</small></p>${rootCard(ctx, diagnosis)}<h3>${esc(t.diag.alternatives)}</h3>${listOrNone(alternatives, t.noneItem)}<h3>${esc(t.diag.missing)}</h3>${listOrNone(
    diagnosis.missing.map((entry) => esc(entry)),
    t.noneItem,
  )}<h3>${esc(t.diag.recommendations)}</h3>${listOrNone(
    diagnosis.recommendations.map((entry) => esc(entry)),
    t.noneItem,
  )}</section>`;
}

// ── Rapport ───────────────────────────────────────────────────────────────────────────────────

/** L'état du chargement du rapport (fourni par l'intégration). */
export interface ReportViewState {
  loading?: boolean;
  error?: string;
  /** L'export en cours. */
  exporting?: ReportFormat;
  /**
   * L'export PDF est indisponible (le serveur a répondu 501 `PDF_UNAVAILABLE` : aucun navigateur sans
   * interface sur le serveur) : la raison à afficher. Le bouton PDF est alors désactivé avec elle.
   */
  pdfUnavailable?: string;
}

function exportButtons(ctx: WorkspaceContext, state: ReportViewState): string {
  const t = text(ctx.lang);
  const button = (format: 'json' | 'markdown', label: string): string =>
    `<button type="button" class="btn" data-action="ws-dx-export" data-format="${format}"${state.exporting ? ' disabled' : ''} aria-busy="${String(state.exporting === format)}">${icon('download')}<span>${esc(label)}</span></button>`;
  return `<div class="row-acts">${button('json', t.report.exportJson)}${button('markdown', t.report.exportMarkdown)}<button type="button" class="btn ghost" data-action="ws-dx-report"${state.loading ? ' disabled' : ''} aria-busy="${String(state.loading === true)}">${icon('refresh')}<span>${esc(t.report.reread)}</span></button></div>`;
}

const dlRow = (term: string, value: string): string => `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;

/** L'onglet « Rapport » : le résumé du rapport tel que le serveur l'a produit, et ses exports. */
export function renderReport(
  ctx: WorkspaceContext,
  report?: InvestigationReport,
  state: ReportViewState = {},
): string {
  const t = text(ctx.lang);
  const r = t.report;
  const head = `<div class="card-h"><h2>${esc(r.title)}</h2>${exportButtons(ctx, state)}</div><p class="mu"><small>${esc(r.exportNote)}</small></p>`;
  if (!report) {
    const body = state.error
      ? panelState(ctx.lang, 'error', state.error, 'ws-dx-report')
      : state.loading
        ? panelState(ctx.lang, 'loading', r.loading)
        : panelState(ctx.lang, 'empty', r.missing);
    return `${demoBanner(ctx)}<section class="card wide ws-dx-report">${head}${body}</section>`;
  }
  const none = `<span class="mu">${esc(r.none)}</span>`;
  const incident = report.incident;
  const environment = report.environment;
  const scope = report.scope;
  const failing = report.requests.filter((request) => request.status !== undefined && request.status >= 400);
  const tile = (value: number, label: string, ko = false): string =>
    `<div class="tile${ko ? ' ko' : ''}"><b>${String(value)}</b><span>${esc(label)}</span></div>`;
  const diagnosis = report.diagnosis;
  const regression = report.regression;
  const verdict = regressionVerdict(regression);
  return `${demoBanner(ctx)}<section class="card wide ws-dx-report">${head}${
    state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : ''
  }<p class="mu">${esc(r.generated(formatDate(report.generatedAt, ctx.lang)))}</p><div class="ws-dx-report-grid"><section aria-labelledby="ws-dx-r-inc"><h3 id="ws-dx-r-inc">${esc(r.incident)}</h3><dl class="ws-dx-dl">${dlRow(r.incident, `${esc(incident.title)} <small class="mu"><code>${esc(incident.id)}</code></small>`)}${dlRow(r.severity, esc(t.severities[incident.severity] ?? incident.severity))}${dlRow(r.state, esc(t.states[incident.state] ?? incident.state))}${dlRow(r.observed, esc(incident.observed))}${dlRow(r.expected, esc(incident.expected))}</dl></section><section aria-labelledby="ws-dx-r-env"><h3 id="ws-dx-r-env">${esc(r.environment)}</h3><dl class="ws-dx-dl">${dlRow(r.target, esc(t.targets[environment.execution.target] ?? environment.execution.target))}${dlRow(r.environmentId, environment.environmentId ? `<code>${esc(environment.environmentId)}</code>` : none)}${dlRow(r.baseUrl, environment.baseUrl ? `<code>${esc(environment.baseUrl)}</code>` : none)}${dlRow(r.scenario, report.scenario ? esc(report.scenario) : none)}</dl></section><section aria-labelledby="ws-dx-r-scope"><h3 id="ws-dx-r-scope">${esc(r.scope)}</h3><dl class="ws-dx-dl">${dlRow(r.mode, esc(t.modes[scope.mode] ?? scope.mode))}${dlRow(
    r.applications,
    scope.applications.length > 0
      ? scope.applications
          .map(
            (application) =>
              `${esc(application.name)} <small class="mu">${esc(partsText(ctx.lang).layers[application.layer])}</small>`,
          )
          .join(', ')
      : none,
  )}${dlRow(r.endpoints, scope.endpoints.length > 0 ? scope.endpoints.map((entry) => `<code>${esc(entry)}</code>`).join(' ') : none)}${dlRow(r.depth, String(scope.depth))}</dl></section></div><h3>${esc(r.counts)}</h3><div class="tiles">${tile(report.timeline.length, r.timeline)}${tile(failing.length, r.failing(report.requests.length), failing.length > 0)}${tile(report.code.files.length, r.files)}${tile(report.code.symbols.length, r.symbols)}${tile(report.code.denied.length, r.denied, report.code.denied.length > 0)}${tile(report.hypotheses.length, r.hypotheses)}${tile(report.experiments.length, r.experiments)}</div><dl class="ws-dx-dl">${dlRow(
    r.diagnosis,
    diagnosis
      ? `${chip(diagnosis.status, t.diag.statuses[diagnosis.status])} <span>${esc(t.diag.sentences[diagnosis.status])}</span>${
          diagnosis.rootCause
            ? `<span class="block"><b>${esc(rootTitle(t, diagnosis))} :</b> ${esc(diagnosis.rootCause.statement)}</span>`
            : ''
        }`
      : none,
  )}${dlRow(
    r.regression,
    regression
      ? `${esc(regression.name)} ${chip(regression.status, t.reg.statuses[regression.status])} ${verdictChip(t, verdict)}`
      : none,
  )}</dl><h3>${esc(r.limitations)}</h3>${listOrNone(
    report.limitations.map((entry) => esc(entry)),
    r.noLimitation,
  )}</section>`;
}

// ── Non-régression ────────────────────────────────────────────────────────────────────────────

function verdictChip(t: Text, verdict: 'PASSED' | 'FAILED' | 'NOT_RUN'): string {
  return chip(
    verdict,
    verdict === 'PASSED' ? t.reg.passed : verdict === 'FAILED' ? t.reg.failed : t.reg.notRun,
  );
}

/** L'onglet « Non-régression ». */
export function renderRegression(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const g = t.reg;
  const incident = ctx.incident;
  const proposal = incident.investigation.regression;
  const ready = investigable(incident);
  const runner = ctx.can('RUN');
  const proposeReason = !ready ? t.notReady : !incident.scenario ? g.noScenario : undefined;
  const regButton = (op: string, label: string, options: Partial<OpButton> = {}): string =>
    opButton(ctx, ui, { action: 'ws-dx-regression', label, ref: op, data: { op }, ...options });
  const propose = runner
    ? regButton('propose', proposal ? g.proposeAgain : g.propose, {
        primary: !proposal,
        ...(proposeReason ? { reason: proposeReason, reasonId: 'ws-dx-reg-why' } : {}),
      })
    : '';
  if (!proposal)
    return `<section class="card wide ws-dx-reg"><div class="card-h"><h2>${esc(g.title)}</h2><div class="row-acts">${propose}${runner ? reasonNote('ws-dx-reg-why', proposeReason) : ''}</div></div>${errorBox(ctx, ui, 'regression')}<p class="mu">${esc(incident.scenario ? g.none : g.noScenario)}</p></section>`;
  const verdict = regressionVerdict(proposal);
  const execution = proposal.execution;
  const result = `<p class="ws-dx-verdict" data-verdict="${verdict}">${verdictChip(t, verdict)}<small class="mu">${esc(
    verdict !== 'NOT_RUN' && execution
      ? g.ranAt(execution.run, formatDate(execution.at, ctx.lang))
      : g.notRunHint,
  )}</small></p>`;
  const decided = proposal.status !== 'PROPOSED';
  const runReason = !ready ? t.notReady : undefined;
  const buttons = `<div class="row-acts">${
    runner && proposal.status !== 'REJECTED'
      ? regButton('run', execution ? g.runAgain : g.run, runReason ? { reason: runReason } : {})
      : ''
  }${!decided && ctx.can('PUBLISH') ? regButton('accept', g.accept, { primary: true }) : ''}${
    !decided && ctx.can('DECIDE') ? regButton('reject', g.reject) : ''
  }${propose}</div>${runner ? reasonNote('ws-dx-reg-why', proposeReason ?? runReason) : ''}`;
  return `<section class="card wide ws-dx-reg"><div class="card-h"><h2>${esc(g.title)}</h2>${chip(proposal.status, g.statuses[proposal.status])}</div>${errorBox(ctx, ui, 'regression')}<dl class="ws-dx-dl">${dlRow(g.name, esc(proposal.name))}${dlRow(g.basedOn, esc(proposal.basedOn))}${dlRow(g.expected, esc(proposal.expected))}${proposal.file ? dlRow(g.file, `<code>${esc(proposal.file)}</code>`) : ''}</dl><h3>${esc(g.verdict)}</h3>${result}${
    !decided ? `<p class="note">${icon('info')}<span>${esc(g.libraryNote)}</span></p>` : ''
  }${!decided && !execution ? `<p class="mu">${esc(g.runFirst)}</p>` : ''}${buttons}</section><section class="card wide ws-dx-flow"><h3 id="ws-dx-flow-t">${esc(g.flow)}</h3><pre class="inc-pre ws-dx-yaml" tabindex="0" aria-labelledby="ws-dx-flow-t" aria-readonly="true"><code>${esc(proposal.flowYaml)}</code></pre></section>`;
}

// ── Panneau latéral ───────────────────────────────────────────────────────────────────────────

/** Le détail d'une hypothèse dans le panneau latéral. */
export function renderHypothesisDetail(
  ctx: WorkspaceContext,
  hypothesisId: string,
  ui: DiagnosisUi = emptyDiagnosisUi(),
): string {
  const t = text(ctx.lang);
  const hypothesis = ctx.incident.investigation.hypotheses.find((entry) => entry.id === hypothesisId);
  if (!hypothesis) return panelState(ctx.lang, 'empty', t.hyp.notFound);
  const index = refIndex(ctx.incident);
  const experiments = ctx.incident.investigation.experiments.filter(
    (experiment) => experiment.hypothesisId === hypothesis.id,
  );
  const linked =
    experiments.length === 0
      ? `<p class="mu">${esc(t.hyp.noExperiment)}</p>`
      : `<ul class="plain ws-dx-linked">${experiments
          .map(
            (experiment) =>
              `<li class="${selectionClass(ctx, 'experiment', experiment.id)}"><button type="button" class="lnk" ${selectable(ctx, 'experiment', experiment.id)} aria-label="${esc(t.exp.select(t.experimentKinds[experiment.kind]))}">${esc(t.experimentKinds[experiment.kind])}</button> ${experimentHeadChips(ctx, experiment)}</li>`,
          )
          .join('')}</ul>`;
  const titleId = domId('ws-dx-pt', hypothesis.id);
  return `<article class="ws-dx-detail" aria-labelledby="${titleId}"><h3 id="${titleId}">${esc(hypothesis.title)}</h3><p class="ws-dx-meta">${originPill(hypothesis, ctx.lang)}${chip(hypothesis.status, t.hypothesisStatus[hypothesis.status])}<span class="ws-dx-layer"><small class="mu">${esc(t.layer)}</small> ${esc(partsText(ctx.lang).layers[hypothesis.layer])}</span>${confidenceBar(ctx, hypothesis.confidence)}</p><p class="ws-dx-cause"><b>${esc(t.hyp.cause)} :</b> ${esc(hypothesis.suspectedCause)}</p>${hypothesisBody(ctx, ui, index, hypothesis, 'ws-dx-p')}<h4>${esc(t.hyp.experiments)}</h4>${linked}</article>`;
}

/** Le détail d'une vérification dans le panneau latéral. */
export function renderExperimentDetail(
  ctx: WorkspaceContext,
  experimentId: string,
  ui: DiagnosisUi = emptyDiagnosisUi(),
): string {
  const t = text(ctx.lang);
  const experiment = ctx.incident.investigation.experiments.find((entry) => entry.id === experimentId);
  if (!experiment) return panelState(ctx.lang, 'empty', t.exp.notFound);
  const titleId = domId('ws-dx-px', experiment.id);
  const details =
    experiment.evidence.length === 0
      ? ''
      : `<ul class="plain ws-dx-evlist">${experiment.evidence
          .map(
            (item) =>
              `<li class="${selectionClass(ctx, 'evidence', item.id)}">${evidenceChips(ctx, [item.id])} <span>${esc(item.summary)}</span></li>`,
          )
          .join('')}</ul>`;
  return `<article class="ws-dx-detail" aria-labelledby="${titleId}"><h3 id="${titleId}">${esc(t.experimentKinds[experiment.kind])}</h3><p class="ws-dx-meta">${experimentHeadChips(ctx, experiment)}</p>${experimentBody(ctx, ui, experiment, 'ws-dx-q')}${details}</article>`;
}

// ── Écrans de la maquette : textes ────────────────────────────────────────────────────────────

const SCREEN_TEXT = {
  fr: {
    board: {
      title: 'Diagnostic et hypothèses',
      hypotheses: (n: number) => `Hypothèses (${String(n)})`,
      none: 'Aucune hypothèse pour l’instant : l’analyse du code les propose.',
      rank: (n: number) => `n° ${String(n)}`,
      selectLabel: (rank: number, title: string, pct: number, status: string) =>
        `Hypothèse ${String(rank)} : ${title}, confiance ${String(pct)} %, ${status}`,
      cause: 'Cause',
      rootConfirmed: 'Cause racine confirmée',
      rootProbable: 'Cause racine probable',
      rootInconclusive: 'Piste la plus avancée, non établie',
      noRoot: 'Aucune cause établie',
      leading: 'Hypothèse en tête, sans diagnostic',
      leadingInconclusive: 'Hypothèse en tête, non établie',
      selected: 'Hypothèse sélectionnée',
      noDiagnosis:
        'Pas encore de diagnostic : cette hypothèse est la mieux classée, elle n’est pas une cause établie.',
      selectedNote: 'Ce n’est pas la cause retenue par le diagnostic.',
      confidence: (pct: number) => `Confiance : ${String(pct)} %`,
      noConfidence: 'Confiance : non disponible (hypothèse absente de l’investigation)',
      why: 'Pourquoi cette hypothèse ?',
      whyHide: 'Masquer les preuves',
      checks: 'Vérifications proposées',
      checksNone: 'Aucune vérification planifiée ni proposée.',
      checkLabel: (description: string) => `Sélectionner la vérification « ${description} »`,
      detail: 'Détail',
      detailLabel: (kind: string) => `Voir le détail de la vérification « ${kind} »`,
      sideEffectsReason:
        'Effets de bord possibles : approbation explicite exigée, une vérification à la fois.',
      notRunnable: 'Déjà traitée : rien à exécuter.',
      noRight: 'Votre rôle ne permet pas d’exécuter des vérifications.',
      pickOne: 'Cochez au moins une vérification sans effet de bord.',
      run: (n: number) => (n > 1 ? `Exécuter les vérifications (${String(n)})` : 'Exécuter la vérification'),
      runHint:
        'Les vérifications cochées s’exécutent l’une après l’autre, dans le périmètre ; un refus est affiché avec sa règle.',
      proposed: 'Proposée, à planifier',
      diagnose: 'Établir le diagnostic',
      rediagnose: 'Rediagnostiquer',
    },
    rx: {
      title: 'Rapport d’investigation',
      preview: 'Aperçu du rapport',
      export: 'Exporter',
      sections: 'Sections',
      all: 'Toutes',
      none: 'Aucune',
      formats: { pdf: 'PDF', html: 'HTML', markdown: 'Markdown', json: 'JSON' } as Record<
        ReportFormat,
        string
      >,
      exportLabel: (format: string, n: number) =>
        `Exporter le rapport en ${format} (${String(n)} section(s))`,
      noSection: 'Cochez au moins une section à exporter.',
      exportNote:
        'Le fichier est produit par le serveur à partir de l’investigation enregistrée, avec les sections cochées.',
      pdfUnavailable: 'Export PDF indisponible sur ce serveur.',
      emptyPreview: 'Aucune section cochée : l’aperçu est vide.',
      labels: {
        summary: 'Résumé',
        environment: 'Environnement',
        timeline: 'Chronologie',
        requests: 'Requêtes HTTP',
        graph: 'Graphe de traçabilité',
        code: 'Code analysé',
        hypotheses: 'Hypothèses',
        experiments: 'Résultats des vérifications',
        diagnosis: 'Diagnostic',
        regression: 'Test de non-régression',
        ai: 'Investigation IA',
      } as Record<ReportSection, string>,
      more: (n: number) => `… et ${String(n)} de plus (dans l’export).`,
      method: 'Méthode',
      path: 'Chemin',
      status: 'Statut',
      duration: 'Durée',
      noResponse: 'sans réponse',
      noGraph: 'Pas de graphe dans ce rapport.',
      graphCounts: (nodes: number, edges: number) => `${String(nodes)} nœud(s), ${String(edges)} relation(s)`,
      relations: {
        OBSERVED: 'observée(s)',
        STATICALLY_RESOLVED: 'lue(s) dans le code',
        INFERRED: 'déduite(s)',
        UNKNOWN: 'inconnue(s)',
      } as Record<RelationStatus, string>,
      staticNote: 'Seules les relations observées viennent de la reproduction.',
      files: (n: number) => `${String(n)} fichier(s) retenu(s)`,
      symbols: (n: number) => `${String(n)} symbole(s)`,
      denied: (n: number) => `${String(n)} chemin(s) refusé(s) par le périmètre`,
      truncated: (n: number) => `${String(n)} fichier(s) tronqué(s)`,
      empty: 'Rien dans cette section.',
      step: (n: number) => `étape ${String(n)}`,
    },
    rt: {
      title: 'Test de non-régression',
      generated: 'Test généré',
      validated: 'Validé',
      proposed: 'Proposé, non validé',
      rejected: 'Refusé',
      tabs: 'Code du test',
      flow: 'Flow YAML',
      spec: 'Playwright (TypeScript)',
      specLoading: 'Génération du test Playwright…',
      specMissing: 'Le test Playwright n’est pas encore chargé.',
      specLoad: 'Charger le test Playwright',
      full: 'Voir le test complet',
      fullHide: 'Réduire le test',
      hiddenLines: (n: number) => `${String(n)} ligne(s) de plus`,
      lastRun: 'Dernière exécution',
      neverRun: 'Jamais exécuté : aucun verdict tant que le test n’a pas tourné réellement.',
      passed: 'Réussie',
      failed: 'Échouée',
      ranAt: (run: string, at: string) => `exécution ${run} du ${at}`,
      run: 'Exécuter',
      accept: 'Ajouter au catalogue',
      reject: 'Refuser',
      propose: 'Proposer un test',
      proposeAgain: 'Proposer de nouveau',
      runRight: 'Votre rôle ne permet pas d’exécuter ce test.',
      acceptRight: 'Votre rôle ne permet pas d’ajouter un test au catalogue.',
      rejectRight: 'Votre rôle ne permet pas de refuser ce test.',
      rejectedRun: 'Test refusé : il ne s’exécute plus.',
      decided: 'Décision déjà prise.',
      catalogNote: 'Rien n’entre au catalogue de scénarios sans cette validation explicite.',
      inCatalog: (file: string) => `Au catalogue : ${file}`,
    },
  },
  en: {
    board: {
      title: 'Diagnosis and hypotheses',
      hypotheses: (n: number) => `Hypotheses (${String(n)})`,
      none: 'No hypothesis yet: the code analysis proposes them.',
      rank: (n: number) => `#${String(n)}`,
      selectLabel: (rank: number, title: string, pct: number, status: string) =>
        `Hypothesis ${String(rank)}: ${title}, confidence ${String(pct)} %, ${status}`,
      cause: 'Cause',
      rootConfirmed: 'Confirmed root cause',
      rootProbable: 'Probable root cause',
      rootInconclusive: 'Most advanced lead, not established',
      noRoot: 'No established cause',
      leading: 'Leading hypothesis, no diagnosis',
      leadingInconclusive: 'Leading hypothesis, not established',
      selected: 'Selected hypothesis',
      noDiagnosis: 'No diagnosis yet: this hypothesis ranks first, it is not an established cause.',
      selectedNote: 'This is not the cause kept by the diagnosis.',
      confidence: (pct: number) => `Confidence: ${String(pct)} %`,
      noConfidence: 'Confidence: not available (hypothesis missing from the investigation)',
      why: 'Why this hypothesis?',
      whyHide: 'Hide the evidence',
      checks: 'Proposed checks',
      checksNone: 'No check planned or proposed.',
      checkLabel: (description: string) => `Select the check “${description}”`,
      detail: 'Details',
      detailLabel: (kind: string) => `See the details of the check “${kind}”`,
      sideEffectsReason: 'Possible side effects: explicit approval required, one check at a time.',
      notRunnable: 'Already handled: nothing to run.',
      noRight: 'Your role does not allow running checks.',
      pickOne: 'Tick at least one check without side effects.',
      run: (n: number) => (n > 1 ? `Run the checks (${String(n)})` : 'Run the check'),
      runHint:
        'The ticked checks run one after the other, within the scope; a refusal is shown with its rule.',
      proposed: 'Proposed, to be planned',
      diagnose: 'Establish the diagnosis',
      rediagnose: 'Diagnose again',
    },
    rx: {
      title: 'Investigation report',
      preview: 'Report preview',
      export: 'Export',
      sections: 'Sections',
      all: 'All',
      none: 'None',
      formats: { pdf: 'PDF', html: 'HTML', markdown: 'Markdown', json: 'JSON' } as Record<
        ReportFormat,
        string
      >,
      exportLabel: (format: string, n: number) => `Export the report as ${format} (${String(n)} section(s))`,
      noSection: 'Tick at least one section to export.',
      exportNote:
        'The file is produced by the server from the saved investigation, with the ticked sections.',
      pdfUnavailable: 'PDF export unavailable on this server.',
      emptyPreview: 'No section ticked: the preview is empty.',
      labels: {
        summary: 'Summary',
        environment: 'Environment',
        timeline: 'Timeline',
        requests: 'HTTP requests',
        graph: 'Traceability graph',
        code: 'Analysed code',
        hypotheses: 'Hypotheses',
        experiments: 'Check results',
        diagnosis: 'Diagnosis',
        regression: 'Non-regression test',
        ai: 'AI investigation',
      } as Record<ReportSection, string>,
      more: (n: number) => `… and ${String(n)} more (in the export).`,
      method: 'Method',
      path: 'Path',
      status: 'Status',
      duration: 'Duration',
      noResponse: 'no response',
      noGraph: 'No graph in this report.',
      graphCounts: (nodes: number, edges: number) => `${String(nodes)} node(s), ${String(edges)} relation(s)`,
      relations: {
        OBSERVED: 'observed',
        STATICALLY_RESOLVED: 'read in the code',
        INFERRED: 'inferred',
        UNKNOWN: 'unknown',
      } as Record<RelationStatus, string>,
      staticNote: 'Only observed relations come from the reproduction.',
      files: (n: number) => `${String(n)} file(s) kept`,
      symbols: (n: number) => `${String(n)} symbol(s)`,
      denied: (n: number) => `${String(n)} path(s) refused by the scope`,
      truncated: (n: number) => `${String(n)} truncated file(s)`,
      empty: 'Nothing in this section.',
      step: (n: number) => `step ${String(n)}`,
    },
    rt: {
      title: 'Non-regression test',
      generated: 'Generated test',
      validated: 'Validated',
      proposed: 'Proposed, not validated',
      rejected: 'Rejected',
      tabs: 'Test code',
      flow: 'YAML flow',
      spec: 'Playwright (TypeScript)',
      specLoading: 'Generating the Playwright test…',
      specMissing: 'The Playwright test is not loaded yet.',
      specLoad: 'Load the Playwright test',
      full: 'See the full test',
      fullHide: 'Collapse the test',
      hiddenLines: (n: number) => `${String(n)} more line(s)`,
      lastRun: 'Last run',
      neverRun: 'Never run: no verdict until the test has really run.',
      passed: 'Passed',
      failed: 'Failed',
      ranAt: (run: string, at: string) => `run ${run} on ${at}`,
      run: 'Run',
      accept: 'Add to the catalogue',
      reject: 'Reject',
      propose: 'Propose a test',
      proposeAgain: 'Propose again',
      runRight: 'Your role does not allow running this test.',
      acceptRight: 'Your role does not allow adding a test to the catalogue.',
      rejectRight: 'Your role does not allow rejecting this test.',
      rejectedRun: 'Rejected test: it no longer runs.',
      decided: 'Decision already taken.',
      catalogNote: 'Nothing enters the scenario catalogue without this explicit validation.',
      inCatalog: (file: string) => `In the catalogue: ${file}`,
    },
  },
} satisfies Record<Lang, unknown>;

type ScreenText = (typeof SCREEN_TEXT)['fr'];
const screen = (lang: Lang): ScreenText => SCREEN_TEXT[lang];

const levelOf = (value: number): 'low' | 'mid' | 'high' =>
  clampUnit(value) < 0.34 ? 'low' : clampUnit(value) < 0.67 ? 'mid' : 'high';

/** Une pastille de confiance en pour cent (la valeur de `Hypothesis.confidence`, rien d'autre). */
const pctPill = (value: number): string =>
  `<span class="ws-dx-pct ws-dx-pct-${levelOf(value)}">${String(percentOf(value))} %</span>`;

// ── Écran 9 : Diagnostic et hypothèses ────────────────────────────────────────────────────────

/** Une vérification exécutable : planifiée (ou en attente d'approbation), pas encore lancée. */
export const isRunnableExperiment = (experiment: Pick<Experiment, 'status'>): boolean =>
  experiment.status === 'PROPOSED' || experiment.status === 'APPROVAL_REQUIRED';

/**
 * Les vérifications cochées que « Exécuter la vérification » lance : exécutables, sans effet de bord
 * (celles qui en ont passent par l'approbation dans la page, une à la fois), dans l'ordre de l'investigation.
 */
export function selectedRunnable(incident: Incident, ui: Pick<DiagnosisUi, 'checked'>): string[] {
  return incident.investigation.experiments
    .filter(
      (experiment) =>
        ui.checked.includes(experiment.id) && isRunnableExperiment(experiment) && !needsApproval(experiment),
    )
    .map((experiment) => experiment.id);
}

interface Featured {
  hypothesis?: Hypothesis;
  /** Le titre de la carte, selon Diagnosis.status (jamais « confirmée » sans CONFIRMED). */
  title: string;
  tone: 'ok' | 'warn' | 'mu';
  statement?: string;
  note?: string;
  isRoot: boolean;
}

/**
 * L'hypothèse mise en avant au centre : la sélection (si c'est une hypothèse), sinon la cause du
 * diagnostic, sinon la mieux classée. Le titre dit ce qu'elle est réellement.
 */
function featuredOf(ctx: WorkspaceContext, ui: DiagnosisUi): Featured | undefined {
  const b = screen(ctx.lang).board;
  const investigation = ctx.incident.investigation;
  const diagnosis = investigation.diagnosis;
  const root = diagnosis?.rootCause;
  const byId = (id: string | undefined): Hypothesis | undefined =>
    investigation.hypotheses.find((entry) => entry.id === id);
  const selected = ctx.selection?.kind === 'hypothesis' ? byId(ctx.selection.id) : undefined;
  const top = sortHypotheses(investigation.hypotheses, ui.sort)[0];
  if (diagnosis && root && (!selected || selected.id === root.hypothesisId)) {
    const hypothesis = byId(root.hypothesisId);
    const title =
      diagnosis.status === 'CONFIRMED'
        ? b.rootConfirmed
        : diagnosis.status === 'PROBABLE'
          ? b.rootProbable
          : b.rootInconclusive;
    return {
      ...(hypothesis ? { hypothesis } : {}),
      title,
      tone: diagnosis.status === 'CONFIRMED' ? 'ok' : diagnosis.status === 'PROBABLE' ? 'warn' : 'mu',
      statement: root.statement,
      isRoot: true,
    };
  }
  if (selected)
    return {
      hypothesis: selected,
      title: b.selected,
      tone: 'mu',
      statement: selected.suspectedCause,
      ...(root ? { note: b.selectedNote } : {}),
      isRoot: false,
    };
  if (!top) return undefined;
  return {
    hypothesis: top,
    title: diagnosis ? b.leadingInconclusive : b.leading,
    tone: 'mu',
    statement: top.suspectedCause,
    note: diagnosis ? text(ctx.lang).diag.noRoot : b.noDiagnosis,
    isRoot: false,
  };
}

function boardHypotheses(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const b = screen(ctx.lang).board;
  const list = sortHypotheses(ctx.incident.investigation.hypotheses, ui.sort);
  const head = `<h3 id="ws-dx-b-hyps" class="ws-dx-coltitle">${esc(b.hypotheses(list.length))}</h3>`;
  if (list.length === 0) {
    const reason = planReason(ctx);
    const analyze = ctx.can('RUN')
      ? `${opButton(ctx, ui, {
          action: 'ws-dx-analyze',
          label: t.hyp.analyze,
          primary: true,
          small: true,
          ...(reason ? { reason, reasonId: 'ws-dx-b-analyze-why' } : {}),
        })}${reasonNote('ws-dx-b-analyze-why', reason)}`
      : '';
    return `${head}<p class="mu">${esc(b.none)}</p>${analyze}${errorBox(ctx, ui, 'analyze')}`;
  }
  const items = list
    .map((hypothesis, index) => {
      const rank = index + 1;
      const status = t.hypothesisStatus[hypothesis.status];
      return `<li class="ws-dx-hrow ${selectionClass(ctx, 'hypothesis', hypothesis.id)}"><button type="button" class="ws-dx-hbtn" ${selectable(ctx, 'hypothesis', hypothesis.id)} aria-label="${esc(b.selectLabel(rank, hypothesis.title, percentOf(hypothesis.confidence), status))}" title="${esc(hypothesis.title)}"><span class="ws-dx-rank" aria-hidden="true">${String(rank)}</span><span class="ws-dx-htitle">${esc(hypothesis.title)}</span>${pctPill(hypothesis.confidence)}${chip(hypothesis.status, status)}</button></li>`;
    })
    .join('');
  return `${head}<ol class="plain ws-dx-hlist" aria-labelledby="ws-dx-b-hyps">${items}</ol>`;
}

function boardCause(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const b = screen(ctx.lang).board;
  const featured = featuredOf(ctx, ui);
  const diagnosis = ctx.incident.investigation.diagnosis;
  if (!featured) {
    const title = diagnosis ? b.noRoot : b.leading;
    return `<article class="ws-dx-cause-card ws-dx-root-mu" aria-labelledby="ws-dx-b-cause"><h3 id="ws-dx-b-cause" class="ws-dx-coltitle">${icon('alert')}<span>${esc(title)}</span></h3><p class="mu">${esc(diagnosis ? t.diag.noRoot : t.diag.needHypotheses)}</p></article>`;
  }
  const hypothesis = featured.hypothesis;
  const index = refIndex(ctx.incident);
  const confidence = hypothesis
    ? `<p class="ws-dx-confline"><b>${esc(b.confidence(percentOf(hypothesis.confidence)))}</b>${confidenceBar(ctx, hypothesis.confidence, false)}</p>`
    : `<p class="mu ws-dx-confline">${esc(b.noConfidence)}</p>`;
  const status =
    featured.isRoot && diagnosis
      ? `<p class="ws-dx-status">${chip(diagnosis.status, t.diag.statuses[diagnosis.status])}<small class="mu">${esc(t.diag.sentences[diagnosis.status])}</small></p>`
      : hypothesis
        ? `<p class="ws-dx-status">${chip(hypothesis.status, t.hypothesisStatus[hypothesis.status])}</p>`
        : '';
  const files = featured.isRoot ? (diagnosis?.rootCause?.files ?? []) : (hypothesis?.files ?? []);
  const why = hypothesis
    ? `<button type="button" class="btn small ws-dx-whybtn" data-action="ws-dx-why" aria-expanded="${String(ui.why)}" aria-controls="ws-dx-b-why">${icon(ui.why ? 'up' : 'down')}<span>${esc(ui.why ? b.whyHide : b.why)}</span></button><div id="ws-dx-b-why" class="ws-dx-whybody"${ui.why ? '' : ' hidden'}>${
        ui.why
          ? `<div class="ws-dx-evidence"><section class="ws-dx-side ws-dx-side-pro"><h4>${icon('check')}<span>${esc(t.hyp.supporting(hypothesis.supporting.length))}</span></h4>${factsList(ctx, index, hypothesis.supporting, 'pro')}</section><section class="ws-dx-side ws-dx-side-con"><h4>${icon('cross')}<span>${esc(t.hyp.contradicting(hypothesis.contradicting.length))}</span></h4>${factsList(ctx, index, hypothesis.contradicting, 'con')}</section></div><h4>${esc(t.hyp.progress)}</h4>${progressList(ctx, hypothesis)}`
          : ''
      }</div>`
    : '';
  const titleLink = hypothesis
    ? `<p class="ws-dx-hyplink"><small class="mu">${esc(t.diag.hypothesis)} :</small> ${hypothesisLink(ctx, hypothesis.id)} <small class="mu">· ${esc(partsText(ctx.lang).layers[hypothesis.layer])}</small></p>`
    : '';
  return `<article class="ws-dx-cause-card ws-dx-root-${featured.tone}" aria-labelledby="ws-dx-b-cause" data-root="${String(featured.isRoot)}"><h3 id="ws-dx-b-cause" class="ws-dx-coltitle">${icon(featured.tone === 'ok' ? 'check' : 'alert')}<span>${esc(featured.title)}</span></h3>${confidence}${featured.statement ? `<p class="ws-dx-statement"><b>${esc(featured.statement)}</b></p>` : ''}${hypothesis?.description ? `<p class="ws-dx-explain">${esc(hypothesis.description)}</p>` : ''}${featured.note ? `<p class="note ws-dx-cardnote">${esc(featured.note)}</p>` : ''}${status}${titleLink}${files.length > 0 ? fileLinks(ctx, files) : ''}${why}</article>`;
}

function boardChecks(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const b = screen(ctx.lang).board;
  const investigation = ctx.incident.investigation;
  const runner = ctx.can('RUN');
  const featured = featuredOf(ctx, ui)?.hypothesis;
  const experiments = [...investigation.experiments].sort(
    (a, c) => Number(isRunnableExperiment(c)) - Number(isRunnableExperiment(a)),
  );
  const items = experiments.map((experiment) => {
    const kind = t.experimentKinds[experiment.kind];
    const runnable = isRunnableExperiment(experiment);
    const approval = needsApproval(experiment);
    const id = domId('ws-dx-ck', experiment.id);
    const whyId = domId('ws-dx-ckw', experiment.id);
    const reason = !runnable ? undefined : !runner ? b.noRight : approval ? b.sideEffectsReason : undefined;
    const box = runnable
      ? `<input type="checkbox" id="${id}" class="ws-dx-cbox" data-action="ws-dx-check" data-experiment="${esc(experiment.id)}"${ui.checked.includes(experiment.id) && !reason ? ' checked' : ''}${reason ? ` disabled aria-describedby="${whyId}"` : ''}>`
      : `<span class="ws-dx-cicon ws-dx-cicon-${experiment.status.toLowerCase()}" aria-hidden="true">${icon(experiment.status === 'DONE' ? 'check' : experiment.status === 'RUNNING' ? 'history' : 'cross')}</span>`;
    const label = runnable
      ? `<label for="${id}" class="ws-dx-clabel" title="${esc(b.checkLabel(experiment.description))}">${esc(experiment.description)}</label>`
      : `<span class="ws-dx-clabel">${esc(experiment.description)}</span>`;
    const control =
      runner && runnable && approval
        ? ui.approving === experiment.id
          ? approvalPanel(ctx, ui, experiment, 'ws-dx-b')
          : `<div class="row-acts">${opButton(ctx, ui, {
              action: 'ws-dx-run',
              label: t.exp.review,
              aria: t.exp.reviewLabel(kind),
              ref: experiment.id,
              data: { experiment: experiment.id, approval: 'required' },
              small: true,
              ...(planReason(ctx) ? { reason: planReason(ctx) ?? '' } : {}),
            })}</div>`
        : '';
    return `<li class="ws-dx-checkrow ${selectionClass(ctx, 'experiment', experiment.id)}" data-experiment="${esc(experiment.id)}">${box}<div class="ws-dx-cbody">${label}<span class="ws-dx-cmeta"><small class="mu">${esc(kind)}</small>${chip(experiment.status, t.experimentStatus[experiment.status])}${experiment.sideEffects ? chip('APPROVAL_REQUIRED', t.exp.sideEffects) : ''}${experiment.outcome ? chip(experiment.outcome, t.outcomes[experiment.outcome]) : ''}<button type="button" class="lnk ws-dx-cdetail" ${selectable(ctx, 'experiment', experiment.id)} aria-label="${esc(b.detailLabel(kind))}">${esc(b.detail)}</button></span>${reason ? `<small class="mu ws-dx-why" id="${whyId}">${esc(reason)}</small>` : ''}${errorBox(ctx, ui, `experiment:${experiment.id}`)}${control}</div></li>`;
  });
  // Les vérifications proposées par l'hypothèse mise en avant, pas encore planifiées.
  const planned = new Set(
    investigation.experiments
      .filter((experiment) => experiment.hypothesisId === featured?.id)
      .map((experiment) => experiment.kind),
  );
  const reason = planReason(ctx);
  const proposals = (featured?.verifications ?? []).flatMap((verification, index) => {
    if (planned.has(verification.kind) || !featured) return [];
    const kind = t.experimentKinds[verification.kind];
    const plan = runner
      ? opButton(ctx, ui, {
          action: 'ws-dx-plan',
          label: t.hyp.plan,
          aria: t.hyp.planLabel(kind, featured.title),
          ref: `${featured.id}#${String(index)}`,
          data: { hypothesis: featured.id, index: String(index) },
          small: true,
          ...(reason ? { reason } : {}),
        })
      : '';
    return [
      `<li class="ws-dx-checkrow ws-dx-checkplan"><span class="ws-dx-cicon" aria-hidden="true">${icon('plus')}</span><div class="ws-dx-cbody"><span class="ws-dx-clabel">${esc(verification.description)}</span><span class="ws-dx-cmeta"><small class="mu">${esc(kind)}</small>${chip('PROPOSED', b.proposed)}${plan}</span></div></li>`,
    ];
  });
  const all = [...items, ...proposals];
  const picked = selectedRunnable(ctx.incident, ui);
  const runReason = !runner
    ? b.noRight
    : !investigable(ctx.incident)
      ? t.notReady
      : picked.length === 0
        ? b.pickOne
        : undefined;
  const run = opButton(ctx, ui, {
    action: 'ws-dx-run-selected',
    label: b.run(picked.length),
    data: { experiments: picked.join(',') },
    primary: true,
    ...(runReason ? { reason: runReason, reasonId: 'ws-dx-b-run-why' } : {}),
  });
  return `<h3 id="ws-dx-b-checks" class="ws-dx-coltitle">${esc(b.checks)}</h3>${
    all.length === 0
      ? `<p class="mu">${esc(b.checksNone)}</p>`
      : `<ul class="plain ws-dx-checks" aria-labelledby="ws-dx-b-checks">${all.join('')}</ul>`
  }${errorBox(ctx, ui, 'run-selected')}<div class="ws-dx-runbar">${run}${reasonNote('ws-dx-b-run-why', runReason)}<small class="mu">${esc(b.runHint)}</small></div>`;
}

/**
 * ÉCRAN 9 — « Diagnostic et hypothèses » : trois colonnes sur un grand écran (une seule en dessous de
 * 900 px de panneau) : la liste des hypothèses (rang, titre, confiance en %, statut ; un clic les
 * sélectionne partout), la carte de la cause (titre selon `Diagnosis.status` — « confirmée » seulement pour
 * CONFIRMED —, confiance = `Hypothesis.confidence`, explication, « Pourquoi cette hypothèse ? » qui déplie les
 * preuves favorables et contraires) et la liste « Vérifications proposées » (cases à cocher pour les
 * vérifications sans effet de bord, approbation dans la page pour les autres, « Exécuter la vérification »).
 */
export function renderDiagnosisBoard(ctx: WorkspaceContext, ui: DiagnosisUi): string {
  const t = text(ctx.lang);
  const b = screen(ctx.lang).board;
  const diagnosis = ctx.incident.investigation.diagnosis;
  const hypotheses = ctx.incident.investigation.hypotheses;
  const reason = !investigable(ctx.incident)
    ? t.notReady
    : hypotheses.length === 0
      ? t.diag.needHypotheses
      : undefined;
  const action = ctx.can('RUN')
    ? `<div class="row-acts">${opButton(ctx, ui, {
        action: 'ws-dx-diagnose',
        label: diagnosis ? b.rediagnose : b.diagnose,
        small: true,
        primary: !diagnosis && hypotheses.length > 0,
        ...(reason ? { reason, reasonId: 'ws-dx-b-diag-why' } : {}),
      })}${reasonNote('ws-dx-b-diag-why', reason)}</div>`
    : '';
  return `${demoBanner(ctx)}<section class="ws-dx-board" aria-labelledby="ws-dx-b-title"><div class="ws-dx-boardhead"><h2 id="ws-dx-b-title">${esc(b.title)}</h2>${diagnosis ? chip(diagnosis.status, t.diag.statuses[diagnosis.status]) : ''}${action}</div>${errorBox(ctx, ui, 'diagnose')}<div class="ws-dx-cols"><section class="ws-dx-col ws-dx-col-hyps" aria-labelledby="ws-dx-b-hyps">${boardHypotheses(ctx, ui)}</section><section class="ws-dx-col ws-dx-col-cause" aria-labelledby="ws-dx-b-cause">${boardCause(ctx, ui)}</section><section class="ws-dx-col ws-dx-col-checks" aria-labelledby="ws-dx-b-checks">${boardChecks(ctx, ui)}</section></div></section>`;
}

// ── Écran 10 : Rapport d'investigation (aperçu par sections et exports) ───────────────────────

/** Un format d'export valable (lu sur `data-format`). */
export const isReportFormat = (value: unknown): value is ReportFormat =>
  typeof value === 'string' && (REPORT_FORMATS as readonly string[]).includes(value);

/**
 * Les sections lues sur `data-sections` (liste séparée par des virgules) : seulement des sections connues,
 * sans doublon, dans l'ordre du rapport.
 */
export function parseReportSections(value: string | undefined): ReportSection[] {
  const asked = new Set((value ?? '').split(',').map((entry) => entry.trim()));
  return REPORT_SECTIONS.filter((section) => asked.has(section));
}

/** Les sections retenues, dans l'ordre du rapport, pour `?sections=` (vide : aucune). */
export function reportSectionsParam(ui: Pick<DiagnosisUi, 'sections'>): string {
  return REPORT_SECTIONS.filter((section) => ui.sections.includes(section)).join(',');
}

const PREVIEW_MAX = 8;
/** L'ordre des boutons « Exporter » (celui de la maquette ; JSON en dernier). */
const EXPORT_ORDER: readonly ReportFormat[] = ['pdf', 'html', 'markdown', 'json'];

function moreLine(ctx: WorkspaceContext, total: number): string {
  return total > PREVIEW_MAX
    ? `<p class="mu ws-dx-rx-more">${esc(screen(ctx.lang).rx.more(total - PREVIEW_MAX))}</p>`
    : '';
}

function previewSection(ctx: WorkspaceContext, report: InvestigationReport, section: ReportSection): string {
  const t = text(ctx.lang);
  const x = screen(ctx.lang).rx;
  const none = `<span class="mu">${esc(t.report.none)}</span>`;
  const body = ((): string => {
    switch (section) {
      case 'summary': {
        const incident = report.incident;
        const tone = incident.severity === 'LOW' ? 'mu' : incident.severity === 'MEDIUM' ? 'warn' : 'ko';
        return `<p class="ws-dx-rx-id"><code>${esc(incident.id)}</code> <span class="pill ${tone} ws-dx-chip" data-severity="${esc(incident.severity)}">${esc(t.severities[incident.severity] ?? incident.severity)}</span> <small class="mu">${esc(t.states[incident.state] ?? incident.state)}</small></p><p class="ws-dx-rx-title"><b>${esc(incident.title)}</b></p>${incident.description ? `<p>${esc(incident.description)}</p>` : ''}<dl class="ws-dx-dl">${dlRow(t.report.observed, esc(incident.observed))}${dlRow(t.report.expected, esc(incident.expected))}${dlRow(t.report.scenario, report.scenario ? esc(report.scenario) : none)}</dl>`;
      }
      case 'environment': {
        const environment = report.environment;
        const scope = report.scope;
        return `<dl class="ws-dx-dl">${dlRow(t.report.target, esc(t.targets[environment.execution.target] ?? environment.execution.target))}${dlRow(t.report.environmentId, environment.environmentId ? `<code>${esc(environment.environmentId)}</code>` : none)}${dlRow(t.report.baseUrl, environment.baseUrl ? `<code>${esc(environment.baseUrl)}</code>` : none)}${dlRow(t.report.mode, esc(t.modes[scope.mode] ?? scope.mode))}${dlRow(
          t.report.applications,
          scope.applications.length > 0
            ? scope.applications
                .map(
                  (application) =>
                    `${esc(application.name)} <small class="mu">${esc(partsText(ctx.lang).layers[application.layer])}</small>`,
                )
                .join(', ')
            : none,
        )}${dlRow(t.report.depth, String(scope.depth))}</dl>`;
      }
      case 'timeline':
        return report.timeline.length === 0
          ? `<p class="mu">${esc(x.empty)}</p>`
          : `<ol class="ws-dx-rx-list">${report.timeline
              .slice(0, PREVIEW_MAX)
              .map(
                (entry) =>
                  `<li><small class="mu">${esc(entry.kind)}${entry.step !== undefined ? ` · ${esc(x.step(entry.step))}` : ''}</small> ${esc(entry.summary)}</li>`,
              )
              .join('')}</ol>${moreLine(ctx, report.timeline.length)}`;
      case 'requests':
        return report.requests.length === 0
          ? `<p class="mu">${esc(x.empty)}</p>`
          : `<div class="tw"><table class="tbl ws-dx-rx-tbl"><thead><tr><th scope="col">${esc(x.method)}</th><th scope="col">${esc(x.path)}</th><th scope="col">${esc(x.status)}</th><th scope="col">${esc(x.duration)}</th></tr></thead><tbody>${report.requests
              .slice(0, PREVIEW_MAX)
              .map((request) => {
                const failing = (request.status ?? 0) >= 400 || request.failure !== undefined;
                return `<tr${failing ? ' class="ws-dx-rx-ko"' : ''}><td><code>${esc(request.method.toUpperCase())}</code></td><td><code>${esc(request.path)}</code></td><td>${request.status !== undefined ? String(request.status) : esc(request.failure ?? x.noResponse)}</td><td>${request.durationMs !== undefined ? `${String(Math.round(request.durationMs))} ms` : '—'}</td></tr>`;
              })
              .join('')}</tbody></table></div>${moreLine(ctx, report.requests.length)}`;
      case 'graph': {
        const graph = report.graph;
        if (!graph) return `<p class="mu">${esc(x.noGraph)}</p>`;
        const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
        const counts = (['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED', 'UNKNOWN'] as const).map(
          (status) =>
            `${String(graph.edges.filter((edge) => displayStatus(edge, nodes) === status).length)} ${x.relations[status]}`,
        );
        return `<p>${esc(x.graphCounts(graph.nodes.length, graph.edges.length))} : ${esc(counts.join(', '))}.</p><p class="mu"><small>${esc(x.staticNote)}</small></p>`;
      }
      case 'code': {
        const code = report.code;
        return `<p>${esc([x.files(code.files.length), x.symbols(code.symbols.length), x.denied(code.denied.length), ...(code.truncated.length > 0 ? [x.truncated(code.truncated.length)] : [])].join(' · '))}</p>${
          code.files.length > 0
            ? `<ul class="plain tight ws-dx-rx-files">${code.files
                .slice(0, PREVIEW_MAX)
                .map((file) => `<li><code>${esc(file)}</code></li>`)
                .join('')}</ul>${moreLine(ctx, code.files.length)}`
            : ''
        }`;
      }
      case 'hypotheses':
        return report.hypotheses.length === 0
          ? `<p class="mu">${esc(x.empty)}</p>`
          : `<ol class="ws-dx-rx-list">${sortHypotheses(report.hypotheses, 'confidence')
              .slice(0, PREVIEW_MAX)
              .map(
                (hypothesis) =>
                  `<li><span>${esc(hypothesis.title)}</span> ${pctPill(hypothesis.confidence)} ${chip(hypothesis.status, t.hypothesisStatus[hypothesis.status])}</li>`,
              )
              .join('')}</ol>${moreLine(ctx, report.hypotheses.length)}`;
      case 'experiments':
        return report.experiments.length === 0
          ? `<p class="mu">${esc(x.empty)}</p>`
          : `<ul class="plain ws-dx-rx-list">${report.experiments
              .slice(0, PREVIEW_MAX)
              .map(
                (experiment) =>
                  `<li><span>${esc(t.experimentKinds[experiment.kind])}</span> ${chip(experiment.status, t.experimentStatus[experiment.status])}${experiment.outcome ? ` ${chip(experiment.outcome, t.outcomes[experiment.outcome])}` : ''}${experiment.summary ? ` <small class="mu">${esc(experiment.summary)}</small>` : ''}</li>`,
              )
              .join('')}</ul>${moreLine(ctx, report.experiments.length)}`;
      case 'diagnosis': {
        const diagnosis = report.diagnosis;
        if (!diagnosis) return `<p class="mu">${esc(t.diag.none)}</p>`;
        return `<p class="ws-dx-status">${chip(diagnosis.status, t.diag.statuses[diagnosis.status])}<span>${esc(t.diag.sentences[diagnosis.status])}</span></p>${
          diagnosis.rootCause
            ? `<p><b>${esc(rootTitle(t, diagnosis))} :</b> ${esc(diagnosis.rootCause.statement)}</p>`
            : ''
        }${diagnosis.missing.length > 0 ? `<p class="mu"><small>${esc(t.diag.missing)} : ${esc(diagnosis.missing.join(' · '))}</small></p>` : ''}`;
      }
      case 'regression': {
        const regression = report.regression;
        if (!regression) return `<p class="mu">${esc(t.reg.none)}</p>`;
        return `<p>${esc(regression.name)} ${regressionStatusChip(ctx, regression)} ${verdictChip(t, regressionVerdict(regression))}</p>`;
      }
      case 'ai': {
        // Le résumé du dernier run IA, s'il y en a un : jamais présenté comme un diagnostic.
        const run = report.ai?.runs.at(-1);
        return run?.synthesis ? `<p>${esc(run.synthesis.summary)}</p>` : `<p class="mu">${esc(x.empty)}</p>`;
      }
    }
  })();
  return `<section class="ws-dx-rx-sec" data-section="${section}" aria-labelledby="ws-dx-rx-${section}"><h4 id="ws-dx-rx-${section}">${esc(x.labels[section])}</h4>${body}</section>`;
}

/**
 * ÉCRAN 10 — « Rapport d'investigation » : l'aperçu du rapport par sections (celles qui sont cochées),
 * « Exporter » en PDF, HTML, Markdown ou JSON (chaque bouton porte `data-format` et `data-sections`, la
 * liste des sections cochées), « Sections » (cases à cocher qui pilotent l'aperçu ET l'export). Le PDF est
 * désactivé, avec sa raison, quand `state.pdfUnavailable` le dit (réponse 501 du serveur).
 */
export function renderReportExport(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  report: InvestigationReport | undefined,
  state: ReportViewState = {},
): string {
  const t = text(ctx.lang);
  const x = screen(ctx.lang).rx;
  const sections = REPORT_SECTIONS.filter((section) => ui.sections.includes(section));
  const param = sections.join(',');
  const blocked = ui.busy !== undefined || state.exporting !== undefined;
  const noneId = 'ws-dx-rx-why-none';
  const pdfId = 'ws-dx-rx-why-pdf';
  const pdfReason =
    state.pdfUnavailable !== undefined ? `${x.pdfUnavailable} ${state.pdfUnavailable}`.trim() : undefined;
  const exportButtons = EXPORT_ORDER.map((format) => {
    const reason =
      format === 'pdf' && pdfReason ? pdfReason : sections.length === 0 ? x.noSection : undefined;
    const reasonId = format === 'pdf' && pdfReason ? pdfId : noneId;
    const busy = state.exporting === format;
    return `<li><button type="button" class="btn ws-dx-rx-btn" data-action="ws-dx-export" data-format="${format}" data-sections="${esc(param)}" aria-label="${esc(x.exportLabel(x.formats[format], sections.length))}"${reason || blocked ? ' disabled' : ''}${reason ? ` aria-describedby="${reasonId}" title="${esc(reason)}"` : ''} aria-busy="${String(busy)}">${busy ? '<span class="spin sm" aria-hidden="true"></span>' : icon('download')}<span>${esc(x.formats[format])}</span></button>${format === 'pdf' && pdfReason ? `<small class="mu ws-dx-why" id="${pdfId}">${esc(pdfReason)}</small>` : ''}</li>`;
  }).join('');
  const checks = REPORT_SECTIONS.map(
    (section) =>
      `<li><label class="ws-dx-rx-check"><input type="checkbox" data-action="ws-dx-section" data-section="${section}"${ui.sections.includes(section) ? ' checked' : ''}><span>${esc(x.labels[section])}</span></label></li>`,
  ).join('');
  const preview = !report
    ? state.error
      ? panelState(ctx.lang, 'error', state.error, 'ws-dx-report')
      : state.loading
        ? panelState(ctx.lang, 'loading', t.report.loading)
        : panelState(ctx.lang, 'empty', t.report.missing)
    : `${state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : ''}<p class="mu ws-dx-rx-gen"><small>${esc(t.report.generated(formatDate(report.generatedAt, ctx.lang)))}</small></p>${
        sections.length === 0
          ? `<p class="mu">${esc(x.emptyPreview)}</p>`
          : sections.map((section) => previewSection(ctx, report, section)).join('')
      }<section class="ws-dx-rx-sec ws-dx-rx-limits" aria-labelledby="ws-dx-rx-limits"><h4 id="ws-dx-rx-limits">${esc(t.report.limitations)}</h4>${listOrNone(
        report.limitations.map((entry) => esc(entry)),
        t.report.noLimitation,
      )}</section>`;
  return `${demoBanner(ctx)}<section class="ws-dx-rx" aria-labelledby="ws-dx-rx-title"><div class="ws-dx-boardhead"><h2 id="ws-dx-rx-title">${esc(x.title)}</h2><div class="row-acts"><button type="button" class="btn small ghost" data-action="ws-dx-report"${state.loading ? ' disabled' : ''} aria-busy="${String(state.loading === true)}">${icon('refresh')}<span>${esc(t.report.reread)}</span></button></div></div>${errorBox(ctx, ui, 'export')}<div class="ws-dx-rx-cols"><section class="ws-dx-rx-preview" aria-labelledby="ws-dx-rx-pt"><h3 id="ws-dx-rx-pt" class="ws-dx-coltitle">${esc(x.preview)}</h3><div class="ws-dx-rx-doc" tabindex="0" role="region" aria-labelledby="ws-dx-rx-pt">${preview}</div></section><section class="ws-dx-rx-export" aria-labelledby="ws-dx-rx-et"><h3 id="ws-dx-rx-et" class="ws-dx-coltitle">${esc(x.export)}</h3><ul class="plain ws-dx-rx-btns">${exportButtons}</ul>${sections.length === 0 ? `<p class="ws-dx-why warn" id="${noneId}">${esc(x.noSection)}</p>` : ''}<p class="mu"><small>${esc(x.exportNote)}</small></p></section><fieldset class="ws-dx-rx-sections"><legend class="ws-dx-coltitle">${esc(x.sections)}</legend><ul class="plain ws-dx-rx-checks">${checks}</ul><div class="row-acts"><button type="button" class="btn small ghost" data-action="ws-dx-sections" data-value="all"${sections.length === REPORT_SECTIONS.length ? ' disabled' : ''}>${esc(x.all)}</button><button type="button" class="btn small ghost" data-action="ws-dx-sections" data-value="none"${sections.length === 0 ? ' disabled' : ''}>${esc(x.none)}</button></div></fieldset></div></section>`;
}

// ── Écran 11 : Test de non-régression ─────────────────────────────────────────────────────────

/** Le test Playwright généré (`GET …/regression/spec`) et l'état de son chargement (fournis par l'intégration). */
export interface RegressionSpecView {
  language?: 'typescript';
  code?: string;
  loading?: boolean;
  error?: string;
  /** Le serveur ne sait pas le produire : la raison. */
  unavailable?: string;
}

/** La pastille du statut : « Validé » seulement pour ACCEPTED. */
function regressionStatusChip(
  ctx: WorkspaceContext,
  proposal: Pick<RegressionTestProposal, 'status'>,
): string {
  const r = screen(ctx.lang).rt;
  return chip(
    proposal.status,
    proposal.status === 'ACCEPTED' ? r.validated : proposal.status === 'REJECTED' ? r.rejected : r.proposed,
  );
}

const CODE_PREVIEW_LINES = 14;

function codeBlock(ctx: WorkspaceContext, ui: DiagnosisUi, code: string, id: string, label: string): string {
  const r = screen(ctx.lang).rt;
  const lines = code.replace(/\n$/, '').split('\n');
  const hidden = ui.regFull ? 0 : Math.max(0, lines.length - CODE_PREVIEW_LINES);
  const shown = hidden > 0 ? lines.slice(0, CODE_PREVIEW_LINES) : lines;
  const gutter = shown.map((_line, index) => `<span>${String(index + 1)}</span>`).join('');
  return `<div class="ws-dx-rt-code${ui.regFull ? ' ws-dx-rt-full' : ''}"><pre class="ws-dx-rt-gutter" aria-hidden="true">${gutter}</pre><pre class="ws-dx-rt-pre" id="${id}" tabindex="0" aria-label="${esc(label)}" aria-readonly="true"><code>${esc(shown.join('\n'))}</code></pre></div>${
    hidden > 0 || ui.regFull
      ? `<div class="row-acts ws-dx-rt-more"><button type="button" class="btn small ghost" data-action="ws-dx-reg-full" aria-expanded="${String(ui.regFull)}" aria-controls="${id}">${icon(ui.regFull ? 'minimize' : 'maximize')}<span>${esc(ui.regFull ? r.fullHide : r.full)}</span></button>${hidden > 0 ? `<small class="mu">${esc(r.hiddenLines(hidden))}</small>` : ''}</div>`
      : ''
  }`;
}

/**
 * ÉCRAN 11 — « Test de non-régression » : le test généré (flow YAML, et le test Playwright TypeScript quand
 * le serveur sait le produire), « Validé » seulement si la proposition est ACCEPTED, le verdict de la
 * dernière exécution réelle (« Réussie » seulement si `execution.passed === true`), « Voir le test
 * complet », et les actions selon les droits : « Exécuter » (RUN), « Ajouter au catalogue » (PUBLISH),
 * « Refuser » (DECIDE) — désactivées avec leur raison quand le rôle ne le permet pas.
 */
export function renderRegressionTest(
  ctx: WorkspaceContext,
  ui: DiagnosisUi,
  spec?: RegressionSpecView,
): string {
  const t = text(ctx.lang);
  const r = screen(ctx.lang).rt;
  const incident = ctx.incident;
  const proposal = incident.investigation.regression;
  const ready = investigable(incident);
  const proposeReason = !ready ? t.notReady : !incident.scenario ? t.reg.noScenario : undefined;
  const regButton = (op: string, label: string, options: Partial<OpButton> = {}): string =>
    opButton(ctx, ui, { action: 'ws-dx-regression', label, ref: op, data: { op }, small: true, ...options });
  const propose = ctx.can('RUN')
    ? regButton('propose', proposal ? r.proposeAgain : r.propose, {
        primary: !proposal,
        ...(proposeReason ? { reason: proposeReason, reasonId: 'ws-dx-rt-propose-why' } : {}),
      })
    : '';
  const head = (pill: string): string =>
    `<div class="ws-dx-boardhead"><h2 id="ws-dx-rt-title">${esc(r.title)}</h2>${pill}</div>`;
  if (!proposal)
    return `<section class="ws-dx-rt" aria-labelledby="ws-dx-rt-title">${head('')}${errorBox(ctx, ui, 'regression')}<p class="mu">${esc(incident.scenario ? t.reg.none : t.reg.noScenario)}</p><div class="row-acts">${propose}${reasonNote('ws-dx-rt-propose-why', ctx.can('RUN') ? proposeReason : undefined)}</div></section>`;
  const verdict = regressionVerdict(proposal);
  const execution = proposal.execution;
  const tab = ui.regTab;
  const tabs = `<div class="ws-dx-rt-tabs" role="tablist" aria-label="${esc(r.tabs)}">${(
    ['flow', 'spec'] as const
  )
    .map(
      (key) =>
        `<button type="button" role="tab" id="ws-dx-rt-tab-${key}" class="ws-dx-rt-tab" data-action="ws-dx-reg-tab" data-tab="${key}" aria-selected="${String(tab === key)}" aria-controls="ws-dx-rt-panel" tabindex="${tab === key ? '0' : '-1'}">${esc(key === 'flow' ? r.flow : r.spec)}</button>`,
    )
    .join('')}</div>`;
  const panel =
    tab === 'flow'
      ? codeBlock(ctx, ui, proposal.flowYaml, 'ws-dx-rt-src', r.flow)
      : spec?.code !== undefined
        ? codeBlock(ctx, ui, spec.code, 'ws-dx-rt-src', r.spec)
        : spec?.unavailable !== undefined
          ? panelState(ctx.lang, 'empty', spec.unavailable)
          : spec?.error !== undefined
            ? panelState(ctx.lang, 'error', spec.error, 'ws-dx-reg-spec')
            : spec?.loading
              ? panelState(ctx.lang, 'loading', r.specLoading)
              : `${panelState(ctx.lang, 'empty', r.specMissing)}<div class="row-acts"><button type="button" class="btn small" data-action="ws-dx-reg-spec">${esc(r.specLoad)}</button></div>`;
  const runReason = !ctx.can('RUN')
    ? r.runRight
    : proposal.status === 'REJECTED'
      ? r.rejectedRun
      : !ready
        ? t.notReady
        : undefined;
  const decided = proposal.status !== 'PROPOSED';
  const acceptReason = !ctx.can('PUBLISH') ? r.acceptRight : decided ? r.decided : undefined;
  const rejectReason = !ctx.can('DECIDE') ? r.rejectRight : decided ? r.decided : undefined;
  const reasons = [
    ...new Set([runReason, acceptReason, rejectReason].filter((entry): entry is string => !!entry)),
  ];
  const actions = `<div class="row-acts ws-dx-rt-acts">${regButton('run', r.run, {
    ...(runReason ? { reason: runReason, reasonId: 'ws-dx-rt-why' } : {}),
  })}${regButton('accept', r.accept, {
    primary: !decided,
    ...(acceptReason ? { reason: acceptReason, reasonId: 'ws-dx-rt-why' } : {}),
  })}${regButton('reject', r.reject, {
    ...(rejectReason ? { reason: rejectReason, reasonId: 'ws-dx-rt-why' } : {}),
  })}${propose}</div>${reasons.length > 0 ? `<small class="mu ws-dx-why" id="ws-dx-rt-why">${esc(reasons.join(' '))}</small>` : ''}${reasonNote('ws-dx-rt-propose-why', ctx.can('RUN') ? proposeReason : undefined)}`;
  const last = `<p class="ws-dx-verdict" data-verdict="${verdict}"><b>${esc(r.lastRun)} :</b> ${
    verdict === 'NOT_RUN' || !execution
      ? `${verdictChip(t, 'NOT_RUN')}<small class="mu">${esc(r.neverRun)}</small>`
      : `${chip(verdict, verdict === 'PASSED' ? r.passed : r.failed)}<small class="mu">${esc(r.ranAt(execution.run, formatDate(execution.at, ctx.lang)))}</small>`
  }</p>`;
  return `<section class="ws-dx-rt" aria-labelledby="ws-dx-rt-title">${head(regressionStatusChip(ctx, proposal))}${errorBox(ctx, ui, 'regression')}<dl class="ws-dx-dl">${dlRow(t.reg.name, esc(proposal.name))}${dlRow(t.reg.basedOn, esc(proposal.basedOn))}${dlRow(t.reg.expected, esc(proposal.expected))}${proposal.file ? dlRow(t.reg.file, `<code>${esc(proposal.file)}</code>`) : ''}</dl><h3 class="ws-dx-coltitle">${esc(r.generated)}</h3>${tabs}<div id="ws-dx-rt-panel" role="tabpanel" aria-labelledby="ws-dx-rt-tab-${tab}">${panel}</div>${last}${!decided ? `<p class="note">${icon('info')}<span>${esc(r.catalogNote)}</span></p>` : proposal.status === 'ACCEPTED' && proposal.file ? `<p class="mu">${esc(r.inCatalog(proposal.file))}</p>` : ''}${actions}</section>`;
}

// ── Styles ────────────────────────────────────────────────────────────────────────────────────

export const INCIDENT_DIAGNOSIS_CSS = `
.ws-dx-intro .row-acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ws-dx-rule{display:flex;gap:10px;align-items:flex-start;margin:8px 0 0}
.ws-dx-rule p{margin:4px 0 0}
.ws-dx-sort{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:12px 0}
.ws-dx-hyps,.ws-dx-exps{display:flex;flex-direction:column;gap:12px;margin:0;padding:0}
.ws-dx-hyp,.ws-dx-exp{display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-dx-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}
.ws-dx-head h3{margin:0;font-size:16px;min-width:0;overflow-wrap:anywhere}
.ws-dx-title{font:inherit;font-weight:600;text-align:left}
.ws-dx-meta{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin:0}
.ws-dx-layer{font-size:13px;white-space:nowrap}
.ws-dx-chip{white-space:nowrap}
.ws-dx-cause{margin:0;overflow-wrap:anywhere}
.ws-dx-toggle{align-self:flex-start;display:inline-flex;gap:6px;align-items:center}
.ws-dx-conf{display:inline-flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap}
.ws-dx-meter{position:relative;display:inline-block;width:96px;height:8px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow:hidden}
.ws-dx-fill{position:absolute;inset:0 auto 0 0;background:var(--qa-color-primary);transition:width .2s}
.ws-dx-low .ws-dx-fill{background:var(--qa-color-danger)}
.ws-dx-mid .ws-dx-fill{background:var(--qa-color-warning)}
.ws-dx-high .ws-dx-fill{background:var(--qa-color-success)}
.ws-dx-body{display:flex;flex-direction:column;gap:6px}
.ws-dx-body h4,.ws-dx-detail h4{margin:8px 0 2px;font-size:14px;display:flex;gap:6px;align-items:center}
.ws-dx-evidence{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.ws-dx-side{padding:10px 12px;border-radius:10px;border:1px solid var(--qa-color-border);min-width:0}
.ws-dx-side-pro{border-left:4px solid var(--qa-color-success);background:color-mix(in srgb,var(--qa-color-success) 6%,transparent)}
.ws-dx-side-con{border-left:4px dashed var(--qa-color-danger);background:color-mix(in srgb,var(--qa-color-danger) 6%,transparent)}
.ws-dx-side h4{margin-top:0}
.ws-dx-facts{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}
.ws-dx-fact{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;overflow-wrap:anywhere}
.ws-dx-ref,.ws-dx-file{font-size:12px;overflow-wrap:anywhere}
.ws-dx-files{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0;padding:0}
.ws-dx-verifs{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}
.ws-dx-verif{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.ws-dx-verif>span:not(.pill){flex:1 1 200px;min-width:0}
.ws-dx-why{display:block}
.ws-dx-progress{margin:0}
.ws-dx-params{display:flex;flex-wrap:wrap;gap:4px;margin:0}
.ws-dx-params code{overflow-wrap:anywhere}
.ws-dx-for{margin:0}
.ws-dx-running{display:flex;gap:8px;align-items:center;margin:0}
.ws-dx-refused{padding:8px 12px;border-radius:10px;border:1px solid var(--qa-color-danger);background:color-mix(in srgb,var(--qa-color-danger) 8%,transparent)}
.ws-dx-refused .checks{margin:6px 0 0}
.ws-dx-reason,.ws-dx-rulename{overflow-wrap:anywhere}
.ws-dx-allowed summary{cursor:pointer}
.ws-dx-ev{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0}
.ws-dx-approve{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:10px;border:2px solid var(--qa-color-warning);background:color-mix(in srgb,var(--qa-color-warning) 10%,transparent)}
.ws-dx-approve h4{display:flex;gap:6px;align-items:center;margin:0}
.ws-dx-approve p{margin:0}
.ws-dx-err{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}
.ws-dx-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.ws-dx-paramset{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-dx-params-rows{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}
.ws-dx-param{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto;gap:6px;align-items:center}
.ws-dx-param input{min-width:0;padding:6px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);font:13px var(--qa-font-family-mono)}
.ws-dx-param input:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ws-dx-param input[aria-invalid="true"]{border-color:var(--qa-color-danger)}
.ws-dx-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}
.ws-dx-root{margin:12px 0;padding:12px 14px;border-radius:10px;border:1px solid var(--qa-color-border)}
.ws-dx-root h3{margin:0 0 6px}
.ws-dx-root-ok{border-left:4px solid var(--qa-color-success)}
.ws-dx-root-warn{border-left:4px dashed var(--qa-color-warning)}
.ws-dx-root-mu{border-left:4px dotted var(--qa-color-muted)}
.ws-dx-statement{margin:4px 0;overflow-wrap:anywhere}
.ws-dx-dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 16px;margin:8px 0}
.ws-dx-dl dt{font-size:12px;color:var(--qa-color-muted)}
.ws-dx-dl dd{margin:0;overflow-wrap:anywhere}
.ws-dx-alt{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.ws-dx-report-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.ws-dx-report-grid h3{margin:8px 0 0}
.ws-dx-verdict{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ws-dx-yaml{max-height:420px;overflow:auto;white-space:pre}
.ws-dx-detail{display:flex;flex-direction:column;gap:6px;min-width:0}
.ws-dx-detail h3{margin:0;overflow-wrap:anywhere}
.ws-dx-linked,.ws-dx-evlist{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}
.ws-dx-board,.ws-dx-rx,.ws-dx-rt{container-type:inline-size;display:flex;flex-direction:column;gap:12px;min-width:0}
.ws-dx-boardhead{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.ws-dx-boardhead h2{margin:0;font-size:18px}
.ws-dx-boardhead .row-acts{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ws-dx-coltitle{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:14px;font-weight:700}
.ws-dx-cols{display:grid;grid-template-columns:minmax(220px,1fr) minmax(280px,1.25fr) minmax(260px,1.1fr);gap:12px;align-items:start}
.ws-dx-col{min-width:0;padding:12px 14px;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface)}
.ws-dx-hlist{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.ws-dx-hrow{border-radius:8px}
.ws-dx-hbtn{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"rank title pct" "rank status status";gap:4px 8px;align-items:center;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;text-align:left;cursor:pointer}
.ws-dx-hbtn:hover{border-color:var(--qa-color-border-strong)}
.ws-dx-hbtn:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ws-dx-hbtn[aria-pressed="true"]{border-color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 8%,var(--qa-color-surface))}
.ws-dx-rank{grid-area:rank;display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--qa-color-surface-2);font-size:12px;font-weight:700;color:var(--qa-color-muted)}
.ws-dx-htitle{grid-area:title;font-weight:600;overflow-wrap:anywhere}
.ws-dx-hbtn .ws-dx-pct{grid-area:pct}
.ws-dx-hbtn .ws-dx-chip{grid-area:status;justify-self:start}
.ws-dx-pct{display:inline-block;padding:1px 8px;border-radius:999px;font:600 12px var(--qa-font-family-mono);white-space:nowrap}
.ws-dx-pct-high{background:color-mix(in srgb,var(--qa-color-success) 16%,transparent);color:color-mix(in srgb,var(--qa-color-success) 52%,var(--qa-color-text))}
.ws-dx-pct-mid{background:color-mix(in srgb,var(--qa-color-warning) 18%,transparent);color:color-mix(in srgb,var(--qa-color-warning) 55%,var(--qa-color-text))}
.ws-dx-pct-low{background:color-mix(in srgb,var(--qa-color-danger) 14%,transparent);color:color-mix(in srgb,var(--qa-color-danger) 60%,var(--qa-color-text))}
.ws-dx-col-cause{padding:0;border:0;background:none}
.ws-dx-cause-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);min-width:0}
.ws-dx-cause-card.ws-dx-root-warn{border-left:4px dashed var(--qa-color-warning)}
.ws-dx-cause-card.ws-dx-root-ok{border-left:4px solid var(--qa-color-success)}
.ws-dx-cause-card.ws-dx-root-mu{border-left:4px dotted var(--qa-color-muted)}
.ws-dx-root-warn>.ws-dx-coltitle{color:color-mix(in srgb,var(--qa-color-warning) 60%,var(--qa-color-text))}
.ws-dx-root-ok>.ws-dx-coltitle{color:color-mix(in srgb,var(--qa-color-success) 55%,var(--qa-color-text))}
.ws-dx-cause-card p{margin:0}
.ws-dx-confline{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:13px}
.ws-dx-explain{overflow-wrap:anywhere}
.ws-dx-cardnote{font-size:13px}
.ws-dx-hyplink{font-size:13px}
.ws-dx-whybtn{align-self:flex-start;display:inline-flex;align-items:center;gap:6px}
.ws-dx-whybody{display:flex;flex-direction:column;gap:6px}
.ws-dx-whybody h4{margin:6px 0 2px;font-size:13px;display:flex;gap:6px;align-items:center}
.ws-dx-checks{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.ws-dx-checkrow{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;align-items:start;padding:6px 4px;border-radius:8px}
.ws-dx-cbox{width:18px;height:18px;margin:2px 0 0;accent-color:var(--qa-color-primary);cursor:pointer}
.ws-dx-cbox:disabled{cursor:not-allowed}
.ws-dx-cbox:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ws-dx-cicon{display:inline-grid;place-items:center;width:20px;height:20px;color:var(--qa-color-muted)}
.ws-dx-cicon-done{color:var(--qa-color-success)}
.ws-dx-cicon-refused,.ws-dx-cicon-error{color:var(--qa-color-danger)}
.ws-dx-cbody{display:flex;flex-direction:column;gap:4px;min-width:0}
.ws-dx-clabel{overflow-wrap:anywhere;cursor:default}
label.ws-dx-clabel{cursor:pointer}
.ws-dx-cmeta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center}
.ws-dx-cdetail{font-size:12px;padding:0;min-height:24px}
.ws-dx-runbar{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin-top:10px}
.ws-dx-runbar>small{font-size:12px}
.ws-dx-rx-cols{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(170px,.8fr) minmax(200px,.9fr);gap:12px;align-items:start}
.ws-dx-rx-preview,.ws-dx-rx-export,.ws-dx-rx-sections{min-width:0;margin:0;padding:12px 14px;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface)}
.ws-dx-rx-doc{display:flex;flex-direction:column;gap:10px;max-height:min(70vh,640px);overflow:auto;padding:12px 14px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-background)}
.ws-dx-rx-doc:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ws-dx-rx-gen{margin:0}
.ws-dx-rx-sec{display:flex;flex-direction:column;gap:4px;padding-bottom:8px;border-bottom:1px solid var(--qa-color-border)}
.ws-dx-rx-sec:last-child{border-bottom:0}
.ws-dx-rx-sec h4{margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--qa-color-muted)}
.ws-dx-rx-sec p{margin:0;overflow-wrap:anywhere}
.ws-dx-rx-id{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ws-dx-rx-title{font-size:16px}
.ws-dx-rx-list{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:20px;font-size:13px}
.ws-dx-rx-list li{overflow-wrap:anywhere}
.ws-dx-rx-tbl{font-size:13px;min-width:360px}
.ws-dx-rx-ko{background:color-mix(in srgb,var(--qa-color-danger) 9%,transparent)}
.ws-dx-rx-files{font-size:12px}
.ws-dx-rx-more{font-size:12px}
.ws-dx-rx-btns{display:flex;flex-direction:column;gap:6px;margin:0 0 8px;padding:0;list-style:none}
.ws-dx-rx-btn{width:100%;justify-content:flex-start;display:inline-flex;align-items:center;gap:8px}
.ws-dx-rx-sections legend{float:left;width:100%;padding:0}
.ws-dx-rx-checks{clear:both;display:flex;flex-direction:column;gap:2px;margin:0 0 8px;padding:0;list-style:none}
.ws-dx-rx-check{display:flex;align-items:center;gap:8px;min-height:30px;cursor:pointer}
.ws-dx-rx-check input{width:18px;height:18px;margin:0;accent-color:var(--qa-color-primary)}
.ws-dx-rx-check input:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ws-dx-rt-tabs{display:flex;gap:2px;border-bottom:1px solid var(--qa-color-border)}
.ws-dx-rt-tab{min-height:32px;padding:4px 12px;border:0;border-bottom:2px solid transparent;background:none;color:var(--qa-color-muted);font:600 13px var(--qa-font-family);cursor:pointer}
.ws-dx-rt-tab[aria-selected="true"]{color:var(--qa-color-primary);border-bottom-color:var(--qa-color-primary)}
.ws-dx-rt-tab:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ws-dx-rt-code{display:grid;grid-template-columns:auto minmax(0,1fr);max-height:360px;overflow:auto;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-background)}
.ws-dx-rt-code.ws-dx-rt-full{max-height:none}
.ws-dx-rt-gutter{display:flex;flex-direction:column;margin:0;padding:10px 8px;text-align:right;font:12px/1.55 var(--qa-font-family-mono);color:var(--qa-color-muted);border-right:1px solid var(--qa-color-border);user-select:none}
.ws-dx-rt-pre{margin:0;padding:10px 12px;font:12px/1.55 var(--qa-font-family-mono);white-space:pre;overflow:visible}
.ws-dx-rt-pre code{display:block;padding:0;border:0;border-radius:0;background:none;font:inherit;overflow-wrap:normal}
.ws-dx-rt-pre:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ws-dx-rt-more{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ws-dx-rt-acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
@container (max-width:900px){
  .ws-dx-cols{grid-template-columns:minmax(0,1fr)}
  .ws-dx-rx-cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .ws-dx-rx-preview{grid-column:1/-1}
}
@container (max-width:560px){
  .ws-dx-rx-cols{grid-template-columns:minmax(0,1fr)}
}
@container (max-width:600px){
  .ws-dx-evidence{grid-template-columns:1fr}
  .ws-dx-param{grid-template-columns:minmax(0,1fr) auto}
  .ws-dx-param input[data-ws-field="dx.param.value"]{grid-column:1/2}
  .ws-dx-meter{width:72px}
}
@media (prefers-reduced-motion:reduce){.ws-dx-fill{transition:none}}
`;
