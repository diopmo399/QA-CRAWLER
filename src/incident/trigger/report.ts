import type { Incident } from '../../sdk/core/incident-contracts.js';
import type { TriggerRun, TriggerRunReport } from '../../sdk/core/incident-trigger-contracts.js';
import { redactText } from '../../security/redactor.js';
import { isFactorAction } from './model.js';
import { describeAction } from './session.js';

/**
 * LE RAPPORT D'UN RUN DE DÉCOUVERTE : des sections en lignes Markdown, masquées, qui ne disent que ce qui a
 * été observé. Une hypothèse reste une hypothèse ; une condition porte ses taux avec et sans ; la couverture
 * se lit par dimension ; les limites et le budget consommé sont toujours écrits.
 */
const ratio = (count: { reproduced: number; total: number }): string =>
  `${String(count.reproduced)}/${String(count.total)}`;

export function buildTriggerReport(incident: Incident, run: TriggerRun, now: string): TriggerRunReport {
  const sections: Record<string, string[]> = {};
  const brief = run.brief;
  sections.summary = [
    `Run ${run.id} — profondeur ${run.depth} — état ${run.state}${run.stopReason ? ` (${run.stopReason})` : ''}`,
    `Démarré le ${run.startedAt} par ${run.startedBy}${run.finishedAt ? `, terminé le ${run.finishedAt}` : ''}`,
    `Essais : ${String(run.usage.trials)} / ${String(run.budget.maxTrials)} ; actions : ${String(run.usage.actions)} ; événements : ${String(run.usage.events)} ; durée : ${String(Math.round(run.usage.durationMs / 1000))} s ; appels IA : ${String(run.usage.aiCalls)}`,
    run.minimal
      ? `Déclencheur reproduit : ${run.minimal.actions
          .filter(isFactorAction)
          .map(describeAction)
          .join(', ')} (fréquence ${ratio(run.minimal.frequency)})`
      : 'Aucun déclencheur reproduit.',
  ];
  if (brief) {
    sections.brief = [
      `Langue : ${brief.language} ; interprété le ${brief.interpretedAt}`,
      ...(brief.functionalArea
        ? [`Zone fonctionnelle : ${brief.functionalArea.text} [${brief.functionalArea.source}]`]
        : []),
      ...(brief.businessAction
        ? [`Action métier : ${brief.businessAction.text} [${brief.businessAction.source}]`]
        : []),
      ...brief.symptoms.map((item) => `Symptôme : ${item.text} [${item.source}]`),
      ...brief.knownConditions.map((item) => `Condition connue : ${item.text} [${item.source}]`),
      ...brief.unknownConditions.map((item) => `Condition inconnue : ${item.text} [${item.source}]`),
      ...(brief.dataLoss ? [`Perte de données : ${brief.dataLoss.text} [${brief.dataLoss.source}]`] : []),
      `Défaillances suggérées par la description (pas des preuves) : ${brief.suspectedFailures.join(', ') || 'aucune'}`,
    ];
  }
  if (run.scope) {
    const byStatus = new Map<string, number>();
    for (const resource of run.scope.resources)
      byStatus.set(resource.status, (byStatus.get(resource.status) ?? 0) + 1);
    sections.scope = [
      `${String(run.scope.resources.length)} ressource(s) découverte(s) : ${[...byStatus.entries()].map(([status, count]) => `${status} ${String(count)}`).join(', ')}`,
      ...run.scope.resources
        .filter((resource) => resource.relevance >= 0.3 || resource.status === 'DENIED')
        .slice(0, 30)
        .map(
          (resource) =>
            `${resource.kind} ${resource.label} — ${resource.status} (${resource.foundBy.join('+')}, pertinence ${resource.relevance.toFixed(2)})${resource.detail ? ` : ${resource.detail}` : ''}`,
        ),
    ];
  }
  sections.strategies = run.strategies.map(
    (item) =>
      `${item.strategy} : ${String(item.trials)} essai(s), ${String(item.reproduced)} reproduction(s)`,
  );
  sections.trials = run.trials
    .slice(-60)
    .map(
      (trial) =>
        `${trial.id} [${trial.strategy}] ${Object.values(trial.factors).join(' → ') || 'référence'} → ${trial.verdict ?? trial.status}${trial.failures.length > 0 ? ` (${trial.failures.map((failure) => failure.kind).join(', ')})` : ''}${trial.repeats ? ` ×${ratio(trial.repeats)}` : ''}`,
    );
  sections.conditions = run.conditions
    .slice(0, 40)
    .map(
      (condition) =>
        `${condition.role} — ${condition.description} : avec ${ratio(condition.withCondition)}, sans ${ratio(condition.withoutCondition)} [${condition.source}]`,
    );
  if (run.minimal)
    sections.minimal = [
      ...run.minimal.preconditions.map((item) => `Précondition : ${item}`),
      ...run.minimal.actions.map(
        (action, index) =>
          `${String(index + 1)}. ${describeAction(action)}${action.origin === 'probe' ? ' (sonde)' : ''}`,
      ),
      `Fréquence : ${ratio(run.minimal.frequency)} ; réduit de ${String(run.minimal.reducedFrom)} facteur(s) ; ${run.minimal.note}`,
    ];
  if (run.firstFailure) {
    const first = run.firstFailure;
    sections.firstFailure = [
      ...(first.lastFunctionalAction
        ? [`Dernière action fonctionnelle : ${first.lastFunctionalAction.summary}`]
        : []),
      ...(first.lastSuccessfulRequest
        ? [`Dernière requête réussie : ${first.lastSuccessfulRequest.summary}`]
        : []),
      ...(first.lastNavigation ? [`Dernière navigation : ${first.lastNavigation.summary}`] : []),
      ...(first.firstError
        ? [`Première erreur : ${first.firstError.summary} (t+${String(first.firstError.t)} ms)`]
        : []),
      ...(first.firstFailedAction
        ? [`Première action sans réaction : ${first.firstFailedAction.summary}`]
        : []),
      ...first.propagation.map((item) => `Propagation : ${item}`),
      ...first.onlyInFailing
        .slice(0, 8)
        .map(
          (item) =>
            `Seulement dans les parcours défaillants : ${item.summary} (${String(item.trialIds.length)} essai(s))`,
        ),
      first.note,
    ];
  }
  if (run.dataLoss)
    sections.dataLoss = [
      `Champs modifiés non enregistrés : ${run.dataLoss.unsavedFields.join(', ') || 'aucun'}`,
      ...run.dataLoss.persistenceFound.map(
        (item) =>
          `Dans le code : ${item.summary}${item.file ? ` (${item.file}:${String(item.line ?? 0)})` : ''} [${item.source}]`,
      ),
      ...(run.dataLoss.triggerSummary ? [run.dataLoss.triggerSummary] : []),
      ...run.dataLoss.lossFactors.map((item) => `Facteur de perte : ${item}`),
      run.dataLoss.note,
    ];
  const hypotheses = incident.investigation.hypotheses.filter((hypothesis) =>
    run.hypothesisIds.includes(hypothesis.id),
  );
  sections.hypotheses = hypotheses.map(
    (hypothesis) =>
      `${hypothesis.status} — ${hypothesis.title} (confiance ${hypothesis.confidence.toFixed(2)}, ${String(hypothesis.verifications.length)} vérification(s) proposée(s))`,
  );
  const experiments = incident.investigation.experiments.filter((experiment) =>
    experiment.id.startsWith(`exp_trig_${run.id}_`),
  );
  sections.experiments = experiments.map(
    (experiment) =>
      `${experiment.status} — ${experiment.kind} : ${experiment.description}${experiment.outcome ? ` → ${experiment.outcome}` : ''}${experiment.summary ? ` (${experiment.summary})` : ''}`,
  );
  sections.coverage = run.coverage.map(
    (item) =>
      `${item.dimension} : ${String(item.explored)} / ${String(item.known)}${item.note ? ` — ${item.note}` : ''}`,
  );
  sections.limitations = [...run.limitations, ...(run.error ? [`Erreur : ${run.error}`] : [])];
  const regression = incident.investigation.regression;
  if (regression?.basedOn === `trigger:${run.id}`)
    sections.regression = [
      `${regression.name} — ${regression.status}${regression.execution ? ` ; exécuté (${regression.execution.passed ? 'réussi' : 'échoué'}) le ${regression.execution.at}` : ' ; jamais exécuté'}`,
      `Attendu : ${regression.expected}`,
    ];
  for (const key of Object.keys(sections))
    sections[key] = (sections[key] ?? []).map((line) => redactText(line));
  return { generatedAt: now, sections };
}
