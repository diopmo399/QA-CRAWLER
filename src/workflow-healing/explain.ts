import type { FlowDriftReport, StepRecoveryReport } from './model.js';
import { predicateText } from './workflow-context.js';

/**
 * WHY DID YOU CHOOSE THIS? — le rapport d'une récupération, en lignes courtes (CLI et HTML) :
 * action d'origine, divergence et cause, contexte, objectif, candidats, choix et raisons,
 * sécurité, preuve de l'objectif, vérification par l'étape suivante.
 */
export function recoveryLines(recovery: StepRecoveryReport): string[] {
  const outcome = recovery.outcome;
  const divergence = recovery.divergence;
  const target = divergence.expectedTarget;
  const lines = [
    `Original action: ${recovery.originalRole ? `${recovery.originalRole} ` : ''}"${recovery.originalTarget}"`,
    `Symptom: ${divergence.symptom}${divergence.rootStepIndex !== divergence.stepIndex ? ` (first divergence: step ${String(divergence.rootStepIndex)})` : ''}`,
    ...(divergence.technicalSymptom ? [`Technical symptom: ${divergence.technicalSymptom}`] : []),
    // RECOVERY ANALYSIS : la cible comprise avant le sélecteur.
    ...(target
      ? [
          `Expected target: ${target.target.field ? 'field' : 'control'} "${target.target.label}" — ${target.presence}${target.semanticMatches.length > 0 ? ` (similar: ${target.semanticMatches.join(', ')})` : ''}${target.parentSection ? ` · parent ${target.parentSection.label} ${target.parentSection.state}` : ''}`,
          `Precondition chain: ${target.preconditionChain.join(' ← ')}`,
          ...(target.missingPreconditions.length > 0
            ? [`Missing preconditions: ${target.missingPreconditions.join(', ')}`]
            : []),
          ...(target.revealers.length > 0
            ? [
                `Revealed by: ${target.revealers
                  .slice(0, 3)
                  .map(
                    (revealer) =>
                      `${revealer.kind} "${revealer.label}" (${revealer.source}${revealer.hypothetical ? ', hypothesis' : ''}${revealer.onScreen ? ', on screen' : ''})`,
                  )
                  .join(' · ')}`,
              ]
            : []),
          `Recovery mode: ${target.functionalRecovery ? 'FUNCTIONAL_RECOVERY (the target is absent: no locator retries)' : 'LOCATOR_HEALING (the functional target looks present)'}`,
        ]
      : []),
    ...(divergence.functionalRootCause
      ? [
          `Functional root cause: ${divergence.functionalRootCause.category} (${String(divergence.functionalRootCause.confidence)})`,
        ]
      : []),
    `Probable cause: ${divergence.category} (${String(divergence.confidence)})${
      divergence.possibleCauses.length > 1
        ? ` — other hypotheses: ${divergence.possibleCauses
            .filter((cause) => cause.category !== divergence.category)
            .slice(0, 3)
            .map((cause) => `${cause.category} ${String(cause.confidence)}`)
            .join(', ')}`
        : ''
    }`,
    ...divergence.evidence
      .slice(0, 3)
      .map((evidence) => `  evidence (${evidence.source.toLowerCase()}): ${evidence.detail}`),
    ...(recovery.context.previous.length > 0 ? [`Previous: ${recovery.context.previous.join(' · ')}`] : []),
    ...(recovery.context.next.length > 0 ? [`Next: ${recovery.context.next.join(' · ')}`] : []),
    `Inferred goal: ${recovery.goal.id} (${recovery.goal.level}) — ${recovery.goal.predicates.map(predicateText).join(', ') || 'no predicate'}`,
    ...(recovery.plan.candidates.length > 0
      ? [
          `Candidates: ${recovery.plan.candidates
            .map(
              (candidate) =>
                `${candidate.signature} [${candidate.source}, ${String(candidate.score)}, ${candidate.risk}]`,
            )
            .join(' · ')}`,
        ]
      : []),
    ...recovery.plan.rejected.map(
      (rejected) =>
        `Rejected by the SafetyPolicy: ${rejected.signature} (${rejected.risk}: ${rejected.reason})`,
    ),
    ...(recovery.selected
      ? [
          `Selected: ${recovery.selected.signature} (${recovery.selected.source}, ${recovery.selected.risk})`,
          ...recovery.selected.reasons.map((reason) => `  ${reason}`),
        ]
      : []),
    `Recovery: ${outcome.status}${outcome.path.length > 0 ? ` — ${outcome.path.map((action) => `${action.kind} ${action.role} "${action.name}"${action.part === 'INSERTED_PREREQUISITE' ? ' (inserted prerequisite)' : ''}`).join(' → ')}` : ''} · ${String(outcome.experiments)} experiment(s), ${String(outcome.actionsExecuted)} action(s), ${String(outcome.durationMs)} ms`,
    ...outcome.reasons.slice(0, 2).map((reason) => `  ${reason}`),
    ...(recovery.goalVerification
      ? [
          `Goal: ${recovery.goalVerification.status} (${String(recovery.goalVerification.progress)})${recovery.goalVerification.satisfied.length > 0 ? ` — ${recovery.goalVerification.satisfied.join(', ')}` : ''}`,
        ]
      : []),
    `Result: ${
      outcome.status === 'GOAL_REACHED' || outcome.status === 'GOAL_ALREADY_REACHED'
        ? 'RECOVERED'
        : outcome.status === 'RECOVERY_BUDGET_EXHAUSTED' || outcome.status === 'AMBIGUOUS_RECOVERY'
          ? 'INCONCLUSIVE'
          : 'NOT_RECOVERED'
    }`,
    ...(recovery.nextActionVerified !== undefined
      ? [
          `Next action: ${recovery.nextActionVerified ? 'SUCCESS (recovery confirmed)' : 'FAILED (recovery not confirmed)'}`,
        ]
      : []),
  ];
  return lines;
}

/** Les faits de la dérive (jamais un score magique). */
export function driftLines(drift: FlowDriftReport): string[] {
  const f = drift.facts;
  return [
    `Replay result: ${drift.result} · drift: ${drift.classification}`,
    `Exact actions: ${String(f.exactActions)} · locator healed: ${String(f.locatorHealedActions)} · goal recovered: ${String(f.goalRecoveredActions)} · inserted runtime actions: ${String(f.insertedRuntimeActions)} · possibly obsolete: ${String(f.obsoleteCandidates)} · changed effects: ${String(f.changedEffects)} · ambiguous: ${String(f.ambiguousActions)} · unverified: ${String(f.unverifiedActions)}`,
    `Flow update suggested: ${drift.flowUpdateSuggested ? 'YES' : 'NO'}${drift.suggestedFiles && drift.suggestedFiles.length > 0 ? ` (${drift.suggestedFiles.join(', ')}; original unchanged)` : ''}`,
    ...drift.explanation.slice(0, 8),
  ];
}

/** OBSERVABILITY : ce que le self-healing a fait sur le run (des comptes, pas un score). */
export function healingMetrics(
  flows: readonly { steps: readonly { recovery?: StepRecoveryReport }[]; drift?: FlowDriftReport }[],
): {
  recoveryAttempts: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  averageRecoveryDepth: number;
  staticKnowledgeUsed: number;
  historicalRecoveryUsed: number;
  flowsWithDrift: number;
  firstDivergenceBeforeSymptom: number;
} {
  const recoveries = flows.flatMap((flow) =>
    flow.steps.flatMap((step) => (step.recovery ? [step.recovery] : [])),
  );
  const successful = recoveries.filter(
    (recovery) =>
      recovery.outcome.status === 'GOAL_REACHED' || recovery.outcome.status === 'GOAL_ALREADY_REACHED',
  );
  const depths = successful.map((recovery) => recovery.outcome.path.length);
  return {
    recoveryAttempts: recoveries.length,
    successfulRecoveries: successful.length,
    failedRecoveries: recoveries.length - successful.length,
    averageRecoveryDepth:
      depths.length > 0 ? Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 100) / 100 : 0,
    staticKnowledgeUsed: recoveries.filter((recovery) =>
      recovery.plan.candidates.some((candidate) => candidate.source === 'STATIC_ANALYSIS'),
    ).length,
    historicalRecoveryUsed: recoveries.filter((recovery) =>
      recovery.outcome.attempts.some((attempt) => attempt.source === 'HISTORY'),
    ).length,
    flowsWithDrift: flows.filter((flow) => flow.drift?.detected === true).length,
    firstDivergenceBeforeSymptom: recoveries.filter(
      (recovery) => recovery.divergence.rootStepIndex !== recovery.divergence.stepIndex,
    ).length,
  };
}
