import type { ActionCategory, ActionClassification, ActionType } from '../model/discovered-action.js';
import type { Issue } from '../model/issue.js';
import type { NetworkExchange } from '../model/network.js';
import type { PageContext } from '../model/page-context.js';
import type { UiSignals } from '../model/ui-snapshot.js';

/**
 * PASS : les vérifications que cet oracle sait faire sont satisfaites.
 * FAIL : un échec confirmé (HTTP 5xx, plantage, action impossible…).
 * WARNING : quelque chose semble anormal mais peut être attendu (différence de baseline, bannière d'erreur…).
 * UNKNOWN : pas assez d'informations. Jamais transformé en PASS.
 */
export const ORACLE_STATUSES = ['PASS', 'FAIL', 'WARNING', 'UNKNOWN'] as const;
export type OracleStatus = (typeof ORACLE_STATUSES)[number];

export interface OracleReason {
  /** Code stable (http-5xx, page-crash, baseline-differs…). */
  code: string;
  message: string;
}

export interface OracleResult {
  oracle: string;
  status: OracleStatus;
  /**
   * 0..1 : à quel point l'oracle est sûr. Un moyen de classer les observations, pas
   * une mesure scientifique.
   */
  confidence: number;
  reasons: OracleReason[];
}

/** L'action telle qu'exécutée (aucune valeur saisie, aucun secret). */
export interface ExecutedAction {
  id: string;
  type: ActionType;
  category: ActionCategory;
  classification: ActionClassification;
  text?: string;
  href?: string;
  /** Envoie un formulaire (submit, « Enregistrer »… dans un formulaire). */
  submitsForm?: boolean;
  result: 'SUCCESS' | 'FAILED';
  error?: string;
  durationMs?: number;
}

/** Ce que les observateurs ont vu pendant l'action. */
export interface ActionObservations {
  /** Anomalies levées pendant l'action (HTTP, erreurs JS, console…). */
  issues: Issue[];
  /** Échanges HTTP de la fenêtre réseau de l'action. */
  network: NetworkExchange[];
  pageCrashed: boolean;
  /** Indices de l'écran avant et après (alertes, chargement, écran vide, champs invalides). */
  before?: UiSignals;
  after?: UiSignals;
  /** Le formulaire de cet écran vient d'être rempli avec des données valides. */
  formFilledWithValidData?: boolean;
}

/**
 * « Le résultat semble-t-il correct ? » Un oracle juge une action exécutée à partir
 * de données simples. Il doit répondre UNKNOWN quand il ne peut pas savoir — jamais
 * inventer un PASS.
 */
export interface TestOracle {
  readonly name: string;
  evaluate(
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
  ): Promise<OracleResult>;
}

/**
 * Point d'extension pour le sens métier (« la facture a été créée avec le bon
 * total »). Aucune implémentation n'est fournie : sans attente métier explicite, le
 * résultat métier est UNKNOWN. Une future implémentation (règles, contrats, ou un
 * modèle) se branche ici sans toucher à l'explorateur.
 */
export type SemanticOracle = TestOracle;

export function result(
  oracle: string,
  status: OracleStatus,
  confidence: number,
  reasons: OracleReason[],
): OracleResult {
  return { oracle, status, confidence: Math.round(confidence * 100) / 100, reasons };
}
