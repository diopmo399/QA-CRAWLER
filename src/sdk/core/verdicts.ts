import type { AssertionVerdictStatus, StepReplayOutcome } from './contracts.js';

/**
 * LES CORRESPONDANCES DE VERDICTS : du vocabulaire du moteur vers celui que le SDK publie. Une
 * table fixe, testée ; rien n'est déduit. `NOT_EXECUTED` ne vient que d'une absence de résultat.
 */

/** Le statut du moteur d'assertions métier (PASS, FAIL, BLOCKED, INCONCLUSIVE, UNVERIFIABLE). */
export function verdictOfAssertionStatus(status: string | undefined): AssertionVerdictStatus {
  switch (status) {
    case 'PASS':
      return 'VERIFIED_PASS';
    case 'FAIL':
      return 'VERIFIED_FAIL';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'INCONCLUSIVE':
    case 'UNVERIFIABLE':
      return 'INCONCLUSIVE';
    default:
      return 'NOT_EXECUTED';
  }
}

/**
 * Le résultat du rejeu pour une étape `expect` : retrouvée et conforme, vérification différente,
 * refusée par la politique de sécurité. Introuvable, ambiguë ou non vérifiée ne prouve ni la
 * conformité ni l'écart : INCONCLUSIVE.
 */
export function verdictOfReplayOutcome(outcome: StepReplayOutcome | undefined): AssertionVerdictStatus {
  switch (outcome) {
    case 'MATCHED':
      return 'VERIFIED_PASS';
    case 'ASSERTION_MISMATCH':
      return 'VERIFIED_FAIL';
    case 'BLOCKED_BY_POLICY':
      return 'BLOCKED';
    case 'AMBIGUOUS':
    case 'NOT_FOUND':
    case 'NOT_VERIFIED':
      return 'INCONCLUSIVE';
    default:
      return 'NOT_EXECUTED';
  }
}
