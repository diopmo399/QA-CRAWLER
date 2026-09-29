import type { NavigationEvent } from '../navigation/navigation-guard.js';
/**
 * Façons de remettre l'exploration sur pied après un échec, dans l'ordre où elles
 * sont essayées par défaut (les moins coûteuses et les moins intrusives d'abord).
 *
 * - retry : la même action une fois de plus, seulement pour une erreur Playwright
 *   passagère (élément détaché, pas stable…) et jamais pour une action qui envoie des données ;
 * - dismiss-dialog : fermer ce qui est devant l'écran (Escape, sinon son bouton
 *   « Fermer ») ;
 * - escape : appuyer sur Escape même quand rien n'a été vu devant ;
 * - back : historique du navigateur, quand l'action a changé de page ;
 * - known-url : recharger l'URL de l'état d'où partait l'action ;
 * - replay-path : rejouer les transitions enregistrées depuis l'état de départ ;
 * - reauthenticate : se reconnecter quand la session a expiré ;
 * - abandon-branch : laisser cet état et continuer ailleurs.
 */
export const RECOVERY_STRATEGIES = [
  'retry',
  'dismiss-dialog',
  'escape',
  'back',
  'known-url',
  'replay-path',
  'reauthenticate',
  'abandon-branch',
] as const;
export type RecoveryStrategyName = (typeof RECOVERY_STRATEGIES)[number];

export type FailureKind =
  'action-failed' | 'page-crash' | 'left-allowed-hosts' | 'session-expired' | 'circuit-open' | 'stuck';

/** Une tentative de récupération, pour le rapport. Jamais une valeur saisie ni un secret. */
export interface RecoveryEvent {
  at: string;
  /** État que l'exploration a essayé de retrouver (ou de quitter). */
  stateId: string;
  actionId?: string;
  failure: FailureKind;
  /** Première ligne de l'erreur, telle que donnée par Playwright. */
  message?: string;
  strategy: RecoveryStrategyName;
  success: boolean;
  /** État atteint quand la stratégie a marché. */
  reachedStateId?: string;
}

/** Une branche que l'exploration a quittée parce qu'elle n'avançait plus. */
export interface StuckEvent {
  at: string;
  stateId: string;
  kind: 'oscillation' | 'cycle' | 'no-op' | 'busy';
  message: string;
  /**
   * Réponse choisie : `penalize` (la première fois qu'une boucle est vue, ses actions
   * perdent des points et l'exploration continue) ou `backtrack` (la branche est quittée).
   */
  response?: 'penalize' | 'backtrack';
  /** Les actions de la boucle (état + action), pénalisées au lieu d'abandonner tout de suite. */
  actions?: { stateId: string; actionId: string }[];
}

/** Un échec vu assez souvent pour arrêter d'essayer. */
export interface OpenCircuit {
  stateId: string;
  /** Absent : tout l'état est abandonné. */
  actionId?: string;
  failure: string;
  occurrences: number;
}

export interface RecoverySummary {
  events: RecoveryEvent[];
  stuck: StuckEvent[];
  circuits: OpenCircuit[];
  reauthentications: number;
  /** Navigations qui ont interrompu une lecture de la page (NAVIGATION_RECOVERED…) ; absent quand il n'y en a eu aucune. */
  navigation?: NavigationEvent[];
}
