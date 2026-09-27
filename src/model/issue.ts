/** Du moins grave au plus grave. */
export const SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ISSUE_TYPES = [
  'HTTP',
  'REQUEST_FAILED',
  'BROKEN_LINK',
  'CONSOLE',
  'PAGE_ERROR',
  'PAGE_CRASH',
  'NAVIGATION',
  /** Une étape de flow imposé a échoué ou a été bloquée. */
  'FLOW',
  /** Une interaction du navigateur hors du DOM demande de l'attention (AUTH_REQUIRED, boucle, fichier demandé…). */
  'BROWSER_INTERACTION',
  /** Un champ de formulaire est encore invalide une fois rempli avec les données de test (ou n'a pas pu être rempli). */
  'FORM_VALIDATION',
  /** UIOracle : un message d'erreur, un écran vide ou un chargement sans fin après une action. */
  'UI_ERROR',
  /** BaselineOracle : l'action ne mène plus là où la baseline le dit (régression potentielle). */
  'REGRESSION',
  /** ContractOracle : une réponse d'API que le contrat (OpenAPI) ne déclare pas. */
  'CONTRACT',
  /** AccessibilityChecker : noms manquants, liens-images sans texte, problèmes au clavier. */
  'ACCESSIBILITY',
  /** AuthorizationObserver : un acteur atteint un écran qu'une règle lui interdit (ou l'inverse). */
  'AUTHORIZATION',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * Une anomalie observée pendant l'exploration. Les anomalies identiques (même type,
 * message, requête, statut) sont fusionnées : `occurrences` les compte et `pages`
 * liste chaque page où elles ont été vues.
 */
export interface Issue {
  id: string;
  type: IssueType;
  severity: Severity;
  message: string;
  /** Page où l'anomalie a été observée la première fois. */
  pageUrl: string;
  /** Toutes les pages où cette anomalie a été observée. */
  pages: string[];
  requestUrl?: string;
  method?: string;
  status?: number;
  /** Page qui renvoyait vers une page cassée. */
  referrerUrl?: string;
  /** État fonctionnel (voir StateDetector) où l'anomalie a été observée la première fois. */
  stateId?: string;
  /** Action dont l'exécution a déclenché l'anomalie (undefined quand elle a été vue au chargement d'un état). */
  actionId?: string;
  /** Chemin d'id d'états depuis l'état de départ jusqu'à `stateId` : comment reproduire le problème. */
  flow?: string[];
  /** Tous les états où cette anomalie a été observée. */
  states: string[];
  /** Horodatage ISO de la première occurrence. */
  timestamp: string;
  occurrences: number;
  /** Chemin de la capture, relatif au dossier de travail, quand une capture a été prise. */
  screenshot?: string;
}

/** Données nécessaires pour signaler une nouvelle anomalie ; les champs de suivi sont remplis par le collecteur. */
export type IssueInput = Omit<Issue, 'id' | 'pages' | 'states' | 'timestamp' | 'occurrences' | 'severity'> & {
  severity?: Severity;
};

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export function isAtLeast(severity: Severity, threshold: Severity): boolean {
  return severityRank(severity) >= severityRank(threshold);
}
