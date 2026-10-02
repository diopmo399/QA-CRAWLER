import type { FlowConfig, FlowStep } from '../config/flow-schema.js';
import type { SuggestedFlowGraph, SuggestedStep } from '../dry-run/reconciliation-model.js';
import type { FlowStatus, FlowStepReport } from '../model/flow-run.js';
import { categoryOf } from './goal-recovery-engine.js';
import type { DriftClassification, FlowDriftFacts, FlowDriftReport, ReplayResult } from './model.js';

/**
 * FLOW DRIFT DETECTOR : le flow fonctionne-t-il encore DIRECTEMENT, ou seulement grâce
 * au self-healing ? Des FAITS d'abord (actions exactes, guéries, récupérées, insérées,
 * obsolètes, effets changés, ambiguës, non vérifiées), puis une classification prudente :
 * BUSINESS_RULE n'est jamais conclu sans preuve, et un objectif inatteignable n'est jamais
 * masqué (POSSIBLE_REGRESSION).
 */
export function detectFlowDrift(status: FlowStatus, steps: readonly FlowStepReport[]): FlowDriftReport {
  const facts: FlowDriftFacts = {
    totalActions: 0,
    exactActions: 0,
    locatorHealedActions: 0,
    goalRecoveredActions: 0,
    insertedRuntimeActions: 0,
    obsoleteCandidates: 0,
    changedEffects: 0,
    ambiguousActions: 0,
    unverifiedActions: 0,
    renamedTargets: 0,
    replacedTargets: 0,
  };
  const explanation: string[] = [];
  let businessDivergence = false;
  let noSafeRecovery = false;
  let inconclusive = false;
  let accessBlocked = false;
  let unreachableGoal = false;
  for (const step of steps) {
    if (step.status === 'SKIPPED' || step.status === 'MANUAL') continue;
    if (!['click', 'check', 'uncheck', 'fill', 'select'].includes(step.kind)) continue;
    facts.totalActions += 1;
    const recovery = step.recovery;
    const outcome = recovery?.outcome;
    if (recovery && outcome?.status === 'GOAL_REACHED') {
      facts.goalRecoveredActions += 1;
      const inserted = outcome.path.filter((action) => action.part === 'INSERTED_PREREQUISITE');
      facts.insertedRuntimeActions += inserted.length;
      const replacement = outcome.path.filter((action) => action.part === 'REPLACEMENT');
      const original = recovery.originalTarget;
      const kind = categoryOf(replacement, {
        label: original,
        ...(recovery.originalRole ? { role: recovery.originalRole } : {}),
      });
      if (kind === 'TARGET_RENAMED') facts.renamedTargets += 1;
      if (kind === 'TARGET_REPLACED') facts.replacedTargets += 1;
      explanation.push(
        `step ${String(step.index)} "${original}": goal ${recovery.goal.id} reached by ${outcome.path
          .map((action) => `${action.kind} ${action.role} "${action.name}"`)
          .join(' then ')} (${outcome.confirmedCategory ?? kind})`,
      );
      if (inserted.length > 0)
        explanation.push(
          `step ${String(step.index)}: inserted prerequisite ${inserted
            .map((action) => `${action.kind} ${action.role} "${action.name}"`)
            .join(', ')} — a new legitimate step, kept (never bypassed)`,
        );
      continue;
    }
    if (outcome?.status === 'GOAL_ALREADY_REACHED') {
      facts.obsoleteCandidates += 1;
      explanation.push(
        `step ${String(step.index)} "${recovery?.originalTarget ?? step.description}": goal already reached without it (possibly obsolete)`,
      );
      continue;
    }
    if (outcome?.status === 'AMBIGUOUS_RECOVERY') {
      facts.ambiguousActions += 1;
      inconclusive = true;
      explanation.push(`step ${String(step.index)}: ambiguous recovery, nothing chosen arbitrarily`);
      continue;
    }
    if (outcome?.status === 'RECOVERY_BUDGET_EXHAUSTED') {
      inconclusive = true;
      explanation.push(
        `step ${String(step.index)}: recovery budget exhausted (inconclusive, not unreachable)`,
      );
      continue;
    }
    if (outcome?.status === 'NO_SAFE_RECOVERY' || (recovery && outcome?.status === 'NOT_ATTEMPTED')) {
      const category = recovery?.divergence.category;
      if (category === 'APPLICATION_BEHAVIOR_CHANGED') businessDivergence = true;
      else if (category === 'AUTH_STATE_CHANGED' || category === 'ROLE_PERMISSION_CHANGED')
        accessBlocked = true;
      else {
        noSafeRecovery = true;
        if (outcome.experiments > 0) unreachableGoal = true;
      }
      explanation.push(
        `step ${String(step.index)}: ${category ?? 'divergence'} — ${outcome.reasons[0] ?? 'no safe recovery'}`,
      );
      continue;
    }
    if (step.effect?.status === 'AMBIGUOUS') {
      businessDivergence = true;
      facts.ambiguousActions += 1;
      explanation.push(
        `step ${String(step.index)}: the original action exists but its write had no clear answer (possible regression)`,
      );
      continue;
    }
    if (step.effect?.deferred) {
      // L'effet attendu était la cible de l'étape suivante, elle-même récupérée : expliqué par elle.
      const next = steps.find((candidate) => candidate.index === step.index + 1);
      if (
        next?.recovery?.outcome.status === 'GOAL_REACHED' ||
        next?.recovery?.outcome.status === 'GOAL_ALREADY_REACHED'
      ) {
        facts.exactActions += 1;
        explanation.push(
          `step ${String(step.index)}: its recorded effect changed with step ${String(next.index)} (recovered)`,
        );
        continue;
      }
      facts.changedEffects += 1;
      explanation.push(
        `step ${String(step.index)} "${step.description}": expected effect changed (observed ${step.effect.observed.slice(0, 3).join(', ')})`,
      );
      continue;
    }
    if (step.effect?.healed) {
      facts.locatorHealedActions += 1;
      explanation.push(
        `step ${String(step.index)}: locator healed ${step.effect.healed.from} → ${step.effect.healed.to}`,
      );
      continue;
    }
    if (step.status === 'PASSED') {
      if (step.effect?.status === 'NOT_VERIFIED') facts.unverifiedActions += 1;
      facts.exactActions += 1;
    }
  }

  const workflow =
    facts.insertedRuntimeActions > 0 || facts.obsoleteCandidates > 0 || facts.changedEffects > 0;
  const structural = facts.replacedTargets > 0;
  const minor = facts.renamedTargets > 0 || facts.locatorHealedActions > 0 || facts.goalRecoveredActions > 0;
  let classification: DriftClassification;
  let result: ReplayResult;
  if (status !== 'PASSED') {
    if (businessDivergence) {
      classification = 'POSSIBLE_REGRESSION';
      result = 'FAIL_BUSINESS_DIVERGENCE';
    } else if (accessBlocked) {
      // Droits ou session : jamais contournés ; ce n'est pas une dérive du flow, c'est un blocage.
      classification = 'INCONCLUSIVE';
      result = 'FAIL_NO_SAFE_RECOVERY';
      explanation.push('access changed (role or session): no recovery is attempted around an authorization');
    } else if (inconclusive) {
      classification = 'INCONCLUSIVE';
      result = 'INCONCLUSIVE';
    } else if (noSafeRecovery) {
      classification = unreachableGoal ? 'POSSIBLE_REGRESSION' : 'INCONCLUSIVE';
      result = 'FAIL_NO_SAFE_RECOVERY';
      if (unreachableGoal)
        explanation.push(
          'no safe path reaches the recorded goal: the recorded flow is obsolete, or the feature regressed',
        );
    } else {
      classification = workflow
        ? 'WORKFLOW_DRIFT'
        : structural
          ? 'STRUCTURAL_UI_DRIFT'
          : minor
            ? 'MINOR_UI_DRIFT'
            : 'NO_DRIFT';
      result = 'FAILED';
    }
  } else if (workflow) {
    classification = 'WORKFLOW_DRIFT';
    result = 'PASS_WITH_WORKFLOW_DRIFT';
  } else if (facts.goalRecoveredActions > 0) {
    classification = structural ? 'STRUCTURAL_UI_DRIFT' : 'MINOR_UI_DRIFT';
    result = 'PASS_WITH_GOAL_RECOVERY';
  } else if (facts.locatorHealedActions > 0) {
    classification = 'MINOR_UI_DRIFT';
    result = 'PASS_WITH_LOCATOR_HEALING';
  } else {
    classification = 'NO_DRIFT';
    result = 'PASS_EXACT';
  }
  const detected = classification !== 'NO_DRIFT';
  return {
    detected,
    classification,
    result,
    facts,
    explanation,
    flowUpdateSuggested:
      facts.goalRecoveredActions +
        facts.locatorHealedActions +
        facts.obsoleteCandidates +
        facts.changedEffects >
      0,
  };
}

/**
 * FLOW RECONCILIATION (le générateur du Dry Run, réutilisé) : ORIGINAL → RECOVERED → SUGGESTED.
 * Les actions récupérées remplacent l'action d'origine, les prérequis découverts sont insérés,
 * une étape dont l'objectif est déjà atteint est gardée À REVOIR (jamais supprimée), un effet
 * changé est retiré (il sera réappris). Le flow d'origine n'est JAMAIS modifié.
 */
export function buildRecoveredFlow(flow: FlowConfig, steps: readonly FlowStepReport[]): SuggestedFlowGraph {
  const suggested: SuggestedStep[] = [];
  flow.steps.forEach((step, position) => {
    const report = steps.find((candidate) => candidate.index === position + 1);
    const label = report?.description ?? step.kind;
    const outcome = report?.recovery?.outcome;
    if (report?.recovery && outcome?.status === 'GOAL_REACHED') {
      const allow = 'allow' in step ? step.allow : [];
      for (const action of outcome.path) {
        const recovered: FlowStep = {
          kind: action.kind,
          target: { strategy: 'role', role: action.role, name: action.name },
          optional: false,
          allow,
        };
        suggested.push({
          provenance: 'RUNTIME_RECOVERED',
          status: action.part === 'INSERTED_PREREQUISITE' ? 'INSERTED' : 'ALTERNATIVE',
          step: recovered,
          label: `${action.role} ${action.name}`,
          comment:
            action.part === 'INSERTED_PREREQUISITE'
              ? `INSERTED · RUNTIME_RECOVERED · new prerequisite before "${report.recovery.originalTarget}"`
              : `ALTERNATIVE · RUNTIME_RECOVERED · replaces "${report.recovery.originalTarget}" (${outcome.confirmedCategory ?? 'recovered'}) · goal ${report.recovery.goal.id} confirmed`,
        });
      }
      return;
    }
    if (report?.recovery && outcome?.status === 'GOAL_ALREADY_REACHED') {
      suggested.push({
        provenance: 'ORIGINAL',
        status: 'POSSIBLY_OBSOLETE',
        step,
        label,
        review: `to review: goal ${report.recovery.goal.id} is already reached without this step`,
      });
      return;
    }
    if (report?.effect?.deferred && 'effects' in step && step.effects) {
      const { effects: _changed, ...rest } = step;
      suggested.push({
        provenance: 'ORIGINAL',
        status: 'MATCHED',
        step: rest,
        label,
        comment: `MATCHED · ORIGINAL · expected effect changed (observed ${report.effect.observed.slice(0, 2).join(', ')}): effects removed, to relearn`,
      });
      return;
    }
    suggested.push({
      provenance: 'ORIGINAL',
      status: report?.status === 'PASSED' || !report ? 'MATCHED' : 'NOT_VERIFIED',
      step,
      label,
      ...(report?.effect?.healed
        ? { comment: `MATCHED · ORIGINAL · locator healed to ${report.effect.healed.to}` }
        : {}),
    });
  });
  return {
    name: flow.name,
    source: { type: 'YAML' },
    ...(flow.startAt ? { startAt: flow.startAt } : {}),
    status: 'PARTIALLY_MATCHED',
    steps: suggested,
  };
}
