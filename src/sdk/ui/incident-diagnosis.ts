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
  SourceLocation,
} from '../core/incident-contracts.js';
import { EXPERIMENT_KINDS } from '../core/incident-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
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
}

export const emptyPlanDraft = (): PlanDraft => ({
  kind: 'REPLAY',
  hypothesisId: '',
  params: [{ key: '', value: '' }],
});

export function emptyDiagnosisUi(): DiagnosisUi {
  return { expanded: [], sort: 'confidence', plan: emptyPlanDraft(), planProblems: [], errors: {} };
}

/** La clé d'une opération en cours, pour `DiagnosisUi.busy`. */
export const diagnosisBusyKey = (action: string, ref?: string): string => (ref ? `${action}:${ref}` : action);

/** Les actions qui touchent le serveur : jamais traitées par le réducteur, toujours par l'intégration. */
export const DIAGNOSIS_OPERATIONS = [
  'ws-dx-analyze',
  'ws-dx-plan',
  'ws-dx-plan-submit',
  'ws-dx-run',
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
 * envoie `planInputOf(ui.plan)`). Toute autre action : `undefined`.
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
function confidenceBar(ctx: WorkspaceContext, value: number): string {
  const percent = percentOf(value);
  const label = confidenceLabel(value, ctx.lang);
  const level = clampUnit(value) < 0.34 ? 'low' : clampUnit(value) < 0.67 ? 'mid' : 'high';
  return `<span class="ws-dx-conf"><span class="ws-dx-meter ws-dx-${level}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${String(percent)}" aria-valuetext="${esc(label)}" aria-label="${esc(label)}"><span class="ws-dx-fill" style="width:${String(percent)}%"></span></span><b aria-hidden="true">${String(percent)} %</b></span>`;
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
  return `<li class="card ws-dx-hyp ${selectionClass(ctx, 'hypothesis', hypothesis.id)}" data-hypothesis="${esc(hypothesis.id)}" aria-labelledby="${titleId}"><div class="ws-dx-head"><h3 id="${titleId}"><button type="button" class="lnk ws-dx-title" ${selectable(ctx, 'hypothesis', hypothesis.id)} aria-label="${esc(t.hyp.select(hypothesis.title))}">${esc(hypothesis.title)}</button></h3><span class="ws-dx-meta">${chip(hypothesis.status, t.hypothesisStatus[hypothesis.status])}<span class="ws-dx-layer"><small class="mu">${esc(t.layer)}</small> ${esc(layer)}</span>${confidenceBar(ctx, hypothesis.confidence)}</span></div><p class="ws-dx-cause"><b>${esc(t.hyp.cause)} :</b> ${esc(hypothesis.suspectedCause)}</p><button type="button" class="btn small ghost ws-dx-toggle" data-action="ws-dx-toggle" data-hypothesis="${esc(hypothesis.id)}" aria-expanded="${String(expanded)}" aria-controls="${bodyId}" aria-label="${esc(expanded ? t.hyp.collapse(hypothesis.title) : t.hyp.expand(hypothesis.title))}">${icon(expanded ? 'up' : 'down')}<span>${esc(expanded ? t.hyp.hide : t.hyp.details)}</span></button><div id="${bodyId}"${expanded ? '' : ' hidden'}>${expanded ? hypothesisBody(ctx, ui, index, hypothesis, 'ws-dx-h') : ''}</div></li>`;
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
  exporting?: 'json' | 'markdown';
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
  return `<article class="ws-dx-detail" aria-labelledby="${titleId}"><h3 id="${titleId}">${esc(hypothesis.title)}</h3><p class="ws-dx-meta">${chip(hypothesis.status, t.hypothesisStatus[hypothesis.status])}<span class="ws-dx-layer"><small class="mu">${esc(t.layer)}</small> ${esc(partsText(ctx.lang).layers[hypothesis.layer])}</span>${confidenceBar(ctx, hypothesis.confidence)}</p><p class="ws-dx-cause"><b>${esc(t.hyp.cause)} :</b> ${esc(hypothesis.suspectedCause)}</p>${hypothesisBody(ctx, ui, index, hypothesis, 'ws-dx-p')}<h4>${esc(t.hyp.experiments)}</h4>${linked}</article>`;
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
@container (max-width:600px){
  .ws-dx-evidence{grid-template-columns:1fr}
  .ws-dx-param{grid-template-columns:minmax(0,1fr) auto}
  .ws-dx-param input[data-ws-field="dx.param.value"]{grid-column:1/2}
  .ws-dx-meter{width:72px}
}
@media (prefers-reduced-motion:reduce){.ws-dx-fill{transition:none}}
`;
