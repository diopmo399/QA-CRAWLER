import type { ActionClassification } from './discovered-action.js';

/**
 * - PASSED : fait (un `expect` a été vérifié).
 * - FAILED : élément introuvable, erreur d'action, attente non satisfaite.
 * - BLOCKED : refusé par la SafetyPolicy (DANGEROUS, MUTATION sans `allow`…).
 * - SKIPPED : pas exécuté parce qu'une étape précédente a arrêté le flow, ou qu'une limite a été atteinte.
 * - MANUAL : vérification que le robot ne sait pas faire (étape `manual`), à faire à la main ;
 *   n'arrête pas le flow et ne change pas son statut.
 */
export const FLOW_STATUSES = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'MANUAL'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** Résultat d'une étape d'un flow imposé. */
export interface FlowStepReport {
  /** Position dans le flow, à partir de 1. */
  index: number;
  kind: string;
  description: string;
  status: FlowStatus;
  optional: boolean;
  /** Raison de l'échec ou du blocage. */
  reason?: string;
  /** Mode automatique : ce que la phrase est devenue à l'écran (« click tab "Profil" → fill "Code" = 42 »). */
  interpretation?: string;
  /** Classement SafetyPolicy de l'élément ciblé. */
  classification?: ActionClassification;
  /** État atteint après l'étape. */
  stateId?: string;
  url?: string;
  durationMs: number;
  screenshot?: string;
  /** Élément introuvable : étapes YAML prêtes à coller, trouvées en inspectant l'écran. */
  suggestions?: string[];
  /** Élément introuvable : libellés des champs (ou noms des boutons) à l'écran. */
  onScreen?: string[];
}

/** Résultat d'un flow imposé. */
export interface FlowRunReport {
  name: string;
  description?: string;
  status: FlowStatus;
  startedAt: string;
  durationMs: number;
  steps: FlowStepReport[];
  /** États visités, dans l'ordre (pour le graphe des flows). */
  states: string[];
  /** Anomalies levées par le flow (étapes échouées/bloquées) et pendant son exécution. */
  issueIds: string[];
  /** L'explorateur a exploré en autonomie à partir du dernier écran (thenExplore). */
  explored: boolean;
}
