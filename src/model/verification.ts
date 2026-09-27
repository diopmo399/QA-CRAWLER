import type { NetworkExchange } from './network.js';

/**
 * - PASSED : la transition connue mène toujours au même état.
 * - CHANGED : elle mène maintenant à un autre état.
 * - FAILED : l'action échoue maintenant.
 * - ACTION_MISSING : son état de départ est là, pas l'action.
 * - UNREACHABLE : son état de départ ne peut plus être atteint.
 * - BLOCKED : la politique de sécurité actuelle refuse l'action (pas une régression).
 * - SKIPPED : pas vérifiée (limite de la mission atteinte).
 */
export const VERIFICATION_STATUSES = [
  'PASSED',
  'CHANGED',
  'FAILED',
  'ACTION_MISSING',
  'UNREACHABLE',
  'BLOCKED',
  'SKIPPED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Statuts qui veulent dire que l'application ne se comporte plus comme la baseline. */
export const REGRESSION_STATUSES: readonly VerificationStatus[] = [
  'CHANGED',
  'FAILED',
  'ACTION_MISSING',
  'UNREACHABLE',
];

/** Une transition connue de la baseline, rejouée. */
export interface VerifiedTransition {
  from: string;
  fromLabel: string;
  actionId: string;
  action: { type: string; text?: string; href?: string };
  expectedTo: string;
  expectedToLabel: string;
  actualTo?: string;
  actualToLabel?: string;
  status: VerificationStatus;
  reason?: string;
  network?: NetworkExchange[];
}

export interface VerificationReport {
  /** Run de baseline vérifié. */
  baselineRunId?: string;
  transitions: VerifiedTransition[];
  summary: Record<VerificationStatus, number>;
  /** Nombre de transitions dans un statut de régression. */
  regressions: number;
}
