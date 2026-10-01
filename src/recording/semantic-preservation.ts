import type { RecordedFlow, RecordingWarning, SemanticRecordedAction } from './model.js';

export interface PreservationReport {
  /** Gestes humains significatifs (clics, envois) enregistrés. */
  humanTriggers: number;
  generatedClicks: number;
  /** goto du flow (le départ, startAt, n'en est pas un). */
  generatedGotos: number;
  /** Actions qui écrivaient (envoi, MUTATION) absentes du flow. */
  lostMutations: string[];
  warnings: RecordingWarning[];
}

/**
 * FLOW SEMANTIC PRESERVATION — avant de générer les fichiers : les gestes humains ont-ils
 * survécu ? Un envoi, une action qui modifie des données (MUTATION) n'est JAMAIS remplacé
 * par la page qu'il a produite ; un flow plus fait de goto que de clics, alors que l'humain a
 * cliqué, est suspect (SUSPICIOUS_NAVIGATION_COLLAPSE).
 */
export function checkSemanticPreservation(
  actions: readonly SemanticRecordedAction[],
  flow: RecordedFlow,
  options: { detectSemanticActionLoss: boolean; detectNavigationCollapse: boolean; collapseMinGotos: number },
): PreservationReport {
  const human = actions.filter(
    (action) =>
      (action.type === 'CLICK' || action.type === 'SUBMIT') &&
      !/^(navigation caused|detour|failed validation)/.test(action.dropped ?? ''),
  );
  const stepActions = new Set(flow.steps.flatMap((step) => step.actionIds));
  const generatedClicks = flow.steps.filter(
    (step) =>
      step.step.kind === 'click' || (step.step.kind === 'intent' && step.step.intent.kind === 'CLICK'),
  ).length;
  const generatedGotos = flow.steps.filter((step) => step.step.kind === 'goto').length;
  const lostMutations = human
    .filter(
      (action) =>
        (action.type === 'SUBMIT' || action.classification === 'MUTATION') &&
        !action.dropped &&
        !stepActions.has(action.id),
    )
    .map((action) => action.target?.label ?? action.id);
  const warnings: RecordingWarning[] = [];
  if (options.detectSemanticActionLoss)
    for (const label of lostMutations)
      warnings.push({
        code: 'SEMANTIC_ACTION_LOST',
        message: `"${label}" changes data but is not a step of the flow: it must never be replaced by the page it leads to`,
      });
  if (
    options.detectNavigationCollapse &&
    generatedGotos >= options.collapseMinGotos &&
    generatedGotos > generatedClicks &&
    human.length > 0
  )
    warnings.push({
      code: 'SUSPICIOUS_NAVIGATION_COLLAPSE',
      message: `${String(human.length)} human click(s) recorded, but the flow has ${String(generatedGotos)} goto for ${String(generatedClicks)} click(s): see "Navigation causality" in the report`,
    });
  return { humanTriggers: human.length, generatedClicks, generatedGotos, lostMutations, warnings };
}
