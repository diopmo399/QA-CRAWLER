/**
 * FAST PATH ELIGIBILITY : une situation CONNUE (étape enregistrée, cible trouvée directement et
 * confirmée par son empreinte, rien d'anormal avant) prend le chemin rapide — l'attente s'arrête dès
 * que la preuve positive est là et confirmée par un calme court. Tout le reste prend le chemin
 * profond (le comportement complet, inchangé). Le chemin rapide ne retire AUCUNE vérification :
 * ActionEffectVerifier, SafetyPolicy et la vérification des valeurs s'exécutent pareil.
 */
export type ExecutionPath = 'FAST_PATH' | 'DEEP_PATH';

export type DeepPathReason =
  | 'FAST_PATH_DISABLED'
  | 'UNKNOWN_STEP'
  | 'LOCATOR_HEALED'
  | 'FUNCTIONAL_RESOLUTION'
  | 'CONTEXTUAL_RESOLUTION'
  | 'REACQUIRED_AFTER_RERENDER'
  | 'RECOVERY_IN_PROGRESS'
  | 'PREVIOUS_STEP_NOT_PASSED'
  | 'DANGEROUS_ACTION';

export interface FastPathInput {
  enabled: boolean;
  /** Une empreinte ou des effets enregistrés : l'étape vient d'un parcours connu. */
  recorded: boolean;
  healed: boolean;
  functionalResolution: boolean;
  contextualResolution: boolean;
  reacquired: boolean;
  /** L'étape est rejouée à l'intérieur d'une récupération. */
  inRecovery: boolean;
  /** Le statut de l'étape précédente du flow (undefined : première étape). */
  previousStatus: string | undefined;
  dangerous: boolean;
}

export interface FastPathDecision {
  path: ExecutionPath;
  reasons: DeepPathReason[];
}

/** La décision, pure : FAST_PATH seulement si AUCUNE raison de prendre le chemin profond. */
export function evaluateFastPath(input: FastPathInput): FastPathDecision {
  const reasons: DeepPathReason[] = [];
  if (!input.enabled) reasons.push('FAST_PATH_DISABLED');
  if (!input.recorded) reasons.push('UNKNOWN_STEP');
  if (input.healed) reasons.push('LOCATOR_HEALED');
  if (input.functionalResolution) reasons.push('FUNCTIONAL_RESOLUTION');
  if (input.contextualResolution) reasons.push('CONTEXTUAL_RESOLUTION');
  if (input.reacquired) reasons.push('REACQUIRED_AFTER_RERENDER');
  if (input.inRecovery) reasons.push('RECOVERY_IN_PROGRESS');
  if (input.previousStatus !== undefined && input.previousStatus !== 'PASSED')
    reasons.push('PREVIOUS_STEP_NOT_PASSED');
  if (input.dangerous) reasons.push('DANGEROUS_ACTION');
  return { path: reasons.length === 0 ? 'FAST_PATH' : 'DEEP_PATH', reasons };
}
