import type { StaticAnalysisSummary } from '../static-analysis/model.js';
import type { RegressionReport } from '../regression/regression-store.js';
import type { HistoricalKnowledgeSummary } from '../intelligence/knowledge-summary.js';
import type { PersistenceReport } from './persistence-report.js';
import type { BaselineMetadata } from '../baseline/baseline-store.js';
import type { MissionMode } from '../config/config.js';
import type { FlowDiff } from '../diff/flow-diff.js';
import type { VerificationReport } from './verification.js';
import type { ActionClassification, DiscoveredAction, FormSummary } from './discovered-action.js';
import type { FlowEdge, FlowNode } from './flow.js';
import type { FlowRunReport } from './flow-run.js';
import type { BrowserInteractionResult } from '../interactions/types.js';
import type { Issue, IssueType, Severity } from './issue.js';
import type { FormReport } from '../forms/form-report.js';
import type { RecoverySummary } from '../recovery/recovery-model.js';
import type { CleanupReport, CreatedDataRecord } from '../data/created-data.js';
import type { AuthorizationReport } from '../actors/authorization-observer.js';
import type { CoverageMap } from '../coverage/coverage-map.js';
import type { ScoreBreakdown } from '../decision/score-breakdown.js';
import type { BudgetKind } from '../exploration/exploration-budget.js';
import type { GoalState } from '../goals/goal-model.js';
import type { KnowledgeIdentity } from '../knowledge/knowledge-model.js';
import type { InvariantEvaluation } from '../oracles/invariant-oracle.js';
import type { DetectedPattern } from '../patterns/ui-pattern.js';
import type { BlockedWrite } from '../policies/write-guard.js';

/** Pourquoi l'exploration s'est terminée. */
export type StopReason =
  | 'exhausted'
  | 'flows-only'
  | 'max-states'
  | 'max-actions'
  | 'max-duration'
  | 'engine-stop'
  | 'unreachable-start';

export interface ExplorationStats {
  states: number;
  transitions: number;
  actionsExecuted: number;
  actionsSucceeded: number;
  actionsFailed: number;
  actionsBlocked: number;
  backtracks: number;
  maxDepth: number;
  issuesBySeverity: Record<Severity, number>;
  issuesByType: Record<IssueType, number>;
  actionsByClassification: Record<ActionClassification, number>;
  formsFound: number;
  flowsPassed: number;
  flowsFailed: number;
  /** Interactions du navigateur par type et par statut. */
  interactionsByType: Record<string, number>;
  interactionsByStatus: Record<string, number>;
}

/** Un état avec tout ce qui y a été observé. */
export interface StateReport extends FlowNode {
  actionsDetail: DiscoveredAction[];
  forms: FormSummary[];
  /** Comment l'atteindre depuis l'état de départ. */
  flow: string[];
}

export interface ExplorationResult {
  mission: string;
  /** learn, verify ou explore. */
  mode: MissionMode;
  description?: string;
  target: {
    baseUrl: string;
    startUrl: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason: StopReason;
  decisionEngine: string;
  stats: ExplorationStats;
  states: StateReport[];
  transitions: FlowEdge[];
  /** Flows imposés, dans l'ordre de la mission. */
  flows: FlowRunReport[];
  /** Interactions levées par le navigateur hors du DOM (HTTP_AUTH, dialogues, popups, téléchargements…). */
  browserInteractions: BrowserInteractionResult[];
  issues: Issue[];
  /** Régression intelligente : évolution des flows, cycle de vie des anomalies. */
  regression?: RegressionReport;
  /** Baseline avec laquelle ce run a été comparé (verify, explore) ou qu'il a remplacée (learn). */
  baseline?: BaselineMetadata;
  /** learn : la baseline enregistrée par ce run. */
  learnedBaseline?: BaselineMetadata;
  /** Différences avec cette baseline. */
  flowDiff?: FlowDiff;
  /** verify : chaque transition connue de la baseline, rejouée. */
  verification?: VerificationReport;
  /** Id du run, porté par les données qu'il a créées (QA-CRAWLER-<runId>). */
  runId?: string;
  /** Formulaires trouvés et remplis, avec leurs cas de validation (jamais une valeur sensible). */
  formReports?: FormReport[];
  /** Tentatives de récupération, branches abandonnées, circuits ouverts. */
  recovery?: RecoverySummary;
  /** Actions de modification exécutées, et le budget (safety.mutations). */
  mutations?: { enabled: boolean; executed: number; maxPerRun?: number };
  /** Données que le run a probablement créées, marquées QA-CRAWLER-<runId> (jamais les valeurs). */
  createdData?: CreatedDataRecord[];
  /** Ce qui a été nettoyé, et ce qui reste à supprimer. */
  cleanup?: CleanupReport;
  /** actors : ce que chaque utilisateur atteint, les différences, les règles vérifiées. */
  authorization?: AuthorizationReport;
  /** Persistance (où ce run est enregistré) et mémoire (l'historique a-t-il servi ?). */
  persistence?: PersistenceReport;
  /** Moteur de décision : stratégie, objectifs, motifs, couverture, décisions expliquées, budget. */
  intelligence?: {
    strategy: string;
    goals: GoalState[];
    /** Motifs d'interface reconnus, par état. */
    patterns: Record<string, DetectedPattern[]>;
    coverage: CoverageMap;
    /** Actions choisies, dans l'ordre, avec leur score expliqué. */
    decisions: { at: string; stateId: string; label: string; score: number; breakdown?: ScoreBreakdown }[];
    budget: Record<BudgetKind, { used: number; max: number }>;
    /** Packs de domaine chargés. */
    domainPacks: string[];
    /** La base de connaissances : pour quelle application, combien de runs. */
    knowledge?: { identity: KnowledgeIdentity; runs: number; file?: string };
    /** intelligence.enabled : la connaissance historique évaluée (confiance, vieillissement, contexte). */
    historicalKnowledge?: HistoricalKnowledgeSummary;
  };
  /** Invariants jugés (actions et accès des acteurs), expliqués. */
  invariants?: InvariantEvaluation[];
  /** Requêtes d'écriture annulées par la garde d'écriture (effets de bord). */
  blockedWrites?: BlockedWrite[];
  /** Analyse statique : ce que le code de l'application a apporté (preuves, jamais des vérités). */
  staticAnalysis?: StaticAnalysisSummary;
  /** Résumé non secret de la configuration effective. */
  settings: Record<string, unknown>;
  artifacts: {
    json?: string;
    html?: string;
    flowGraph?: string;
    flowGraphHtml?: string;
    screenshotsDir?: string;
    flowDiff?: string;
    baseline?: string;
    /** Journal structuré du moteur (lignes JSON). */
    engineLog?: string;
    /** Flows imposés générés à partir des chemins trouvés (YAML). */
    generatedFlows?: string;
    /** Chaque décision du moteur avec ses candidats (logging.decisionTrace). */
    decisionTrace?: string;
    /** Base de connaissances mise à jour. */
    knowledge?: string;
  };
}
