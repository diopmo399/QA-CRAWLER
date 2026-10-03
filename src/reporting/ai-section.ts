import type { ExplorationResult } from '../model/exploration-result.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

const TEXTS = {
  en: {
    title: 'AI Intelligence',
    hint: 'The advisor thinks; QA-Crawler decides what is valid; the SafetyPolicy decides what is allowed; Playwright executes; the runtime decides what is true.',
    mode: 'Mode',
    provider: 'Provider',
    model: 'Model',
    calls: 'Calls',
    proposals: 'Proposals',
    accepted: 'Accepted',
    rejected: 'Rejected',
    inconclusive: 'Inconclusive',
    confirmed: 'Runtime confirmed',
    contradicted: 'Runtime contradicted',
    recoveries: 'AI-assisted recoveries',
    shadow: 'Shadow comparisons (ASSIST)',
    fastPath: 'Fast path (no call)',
    timeouts: 'Timeouts',
    fallbacks: 'Fallbacks to deterministic',
    unavailable: 'Unavailable',
    budget: 'Budget exhausted',
    latency: 'Average latency',
    decisions: 'Interventions',
    none: 'none',
    selection: 'Model selection',
    defaultProfile: 'Default profile',
    reasoningMode: 'Reasoning effort',
    discovery: 'Model discovery',
    noLlm: 'No LLM required (trivial)',
    modelFallbacks: 'Model fallbacks',
    models: 'Models used (observed, not ranked)',
    reasoning: 'Reasoning effort sent',
    complexity: 'Reasoning complexity',
    effectiveness: 'Effectiveness by trigger and complexity',
    lifecycle: 'AI decisions — lifecycle',
    lifecycleHint:
      'Every call ends in exactly one response. Validation, shadow comparison, execution, runtime and fallbacks are separate dimensions. In ASSIST a valid proposal is SHADOW_ONLY, never a fallback.',
    byTrigger: 'Calls by trigger',
    responses: 'Responses',
    validation: 'Proposal validation',
    shadowResults: 'Shadow (deterministic vs AI)',
    executed: 'Executed from AI',
    notExecuted: 'Not executed because',
    runtime: 'Runtime confirmation',
    runtimeNa: 'N/A because current mode=ASSIST (shadow only)',
    fallbackReasons: 'Fallbacks (an expected AI path could not be used)',
    knowledge: 'Knowledge impact',
    consistency: 'Counter check',
    withoutCall: 'Decisions without a call',
  },
  fr: {
    title: 'Intelligence IA',
    hint: 'Le conseiller réfléchit ; QA-Crawler décide de ce qui est valide ; la SafetyPolicy de ce qui est permis ; Playwright exécute ; le runtime dit ce qui est vrai.',
    mode: 'Mode',
    provider: 'Fournisseur',
    model: 'Modèle',
    calls: 'Appels',
    proposals: 'Propositions',
    accepted: 'Acceptées',
    rejected: 'Rejetées',
    inconclusive: 'Sans conclusion',
    confirmed: 'Confirmées au runtime',
    contradicted: 'Contredites au runtime',
    recoveries: 'Récupérations aidées par l’IA',
    shadow: 'Comparaisons shadow (ASSIST)',
    fastPath: 'Chemin rapide (aucun appel)',
    timeouts: 'Délais dépassés',
    fallbacks: 'Replis déterministes',
    unavailable: 'Indisponible',
    budget: 'Budget épuisé',
    latency: 'Latence moyenne',
    decisions: 'Interventions',
    none: 'aucune',
    selection: 'Sélection du modèle',
    defaultProfile: 'Profil par défaut',
    reasoningMode: 'Effort de raisonnement',
    discovery: 'Découverte des modèles',
    noLlm: 'Sans LLM (trivial)',
    modelFallbacks: 'Replis de modèle',
    models: 'Modèles utilisés (observés, sans classement)',
    reasoning: 'Effort envoyé',
    complexity: 'Complexité du raisonnement',
    effectiveness: 'Efficacité par déclencheur et complexité',
    lifecycle: 'Décisions IA — cycle de vie',
    lifecycleHint:
      'Chaque appel a exactement une réponse. Validation, comparaison shadow, exécution, runtime et replis sont des dimensions séparées. En ASSIST, une proposition valide est SHADOW_ONLY, jamais un repli.',
    byTrigger: 'Appels par déclencheur',
    responses: 'Réponses',
    validation: 'Validation des propositions',
    shadowResults: 'Shadow (déterministe vs IA)',
    executed: 'Exécutées depuis l’IA',
    notExecuted: 'Non exécutées parce que',
    runtime: 'Confirmation au runtime',
    runtimeNa: 'sans objet : mode ASSIST (shadow seulement)',
    fallbackReasons: 'Replis (un chemin IA attendu n’a pas servi)',
    knowledge: 'Apport à la connaissance',
    consistency: 'Contrôle des compteurs',
    withoutCall: 'Décisions sans appel',
  },
} as const;

/**
 * Section « AI Intelligence » : ce que le conseiller a proposé, ce qui a été validé, retenu,
 * confirmé ou contredit au runtime — et si cela améliore réellement QA-Crawler. Des faits
 * structurés : aucune « chaîne de pensée », aucune valeur saisie.
 */
export function aiSection(result: ExplorationResult, language: ReportLanguage): string {
  const ai = result.ai;
  if (!ai) return '';
  const t = TEXTS[language];
  const row = (label: string, value: string | number | undefined): string =>
    value === undefined ? '' : `<tr><th>${esc(label)}</th><td class="wrap">${esc(String(value))}</td></tr>`;
  const decisions = ai.decisions
    .map(
      (decision) =>
        `<tr><td>${esc(decision.id)}</td><td>${esc(decision.context)}</td><td>${esc(decision.trigger)}</td><td>${esc(modelCell(decision))}</td><td class="wrap">${esc(
          decision.proposal?.action
            ? `${decision.proposal.selectedActionId ?? ''} ${decision.proposal.action}`
            : (decision.proposal?.status ?? '—'),
        )}${decision.proposal?.hypothesis ? `<br><span class="muted">${esc(`${decision.proposal.hypothesisType ?? 'hypothesis'}: ${decision.proposal.hypothesis}`)}</span>` : ''}${decision.proposal?.missingPrecondition ? `<br><span class="muted">${esc(`missing precondition: ${decision.proposal.missingPrecondition}`)}</span>` : ''}</td><td>${esc(decision.lifecycle.response)}</td><td>${esc(decision.validation.rejection ?? decision.validation.status)}</td><td>${esc(decision.safety ?? '—')}</td><td>${esc(decision.lifecycle.shadowResult ?? '—')}</td><td><b>${esc(decision.lifecycle.terminal)}</b>${decision.lifecycle.notExecutedReason ? `<br><span class="muted">${esc(decision.lifecycle.notExecutedReason)}</span>` : ''}</td><td>${esc(decision.lifecycle.fallbackReason ?? '—')}</td><td>${esc(decision.runtimeResult ?? (decision.lifecycle.runtime === 'NOT_APPLICABLE' ? '—' : decision.lifecycle.runtime))}${decision.lifecycle.goalProgress?.after !== undefined ? `<br><span class="muted">${esc(`${decision.lifecycle.goalProgress.goal} ${String(decision.lifecycle.goalProgress.before)} → ${String(decision.lifecycle.goalProgress.after)} (${decision.lifecycle.goalProgress.impact ?? ''})`)}</span>` : ''}</td><td class="wrap">${esc(functionalCell(decision))}</td></tr>`,
    )
    .join('');
  return `<section>
    <h2>${esc(t.title)}</h2>
    <p class="muted">${esc(t.hint)}</p>
    <table><tbody>
      ${row(t.mode, ai.mode)}
      ${row(t.provider, ai.provider)}
      ${row(t.model, ai.model)}
      ${ai.available === false ? row(t.unavailable, ai.unavailableReason ?? 'yes') : ''}
      ${row(t.fastPath, ai.fastPath)}
      ${row(t.calls, ai.calls)}
      ${row(t.proposals, ai.proposals)}
      ${row(t.accepted, ai.accepted)}
      ${row(t.rejected, ai.rejected)}
      ${row(t.inconclusive, ai.inconclusive)}
      ${row(t.confirmed, ai.runtimeConfirmed)}
      ${row(t.contradicted, ai.runtimeContradicted)}
      ${row(t.recoveries, ai.aiAssistedRecoveries)}
      ${ai.shadow.compared > 0 ? row(t.shadow, `${String(ai.shadow.agreements)} agree / ${String(ai.shadow.disagreements)} disagree`) : ''}
      ${row(t.timeouts, ai.timeouts)}
      ${row(t.budget, ai.budgetExhausted)}
      ${row(t.fallbacks, ai.fallbacks)}
      ${row(t.latency, `${String(ai.averageLatencyMs)} ms`)}
      ${ai.modelSelection ? row(t.selection, `${ai.modelSelection.selectionMode}${ai.modelSelection.requestedModel ? ` (requested ${ai.modelSelection.requestedModel})` : ''}`) : ''}
      ${ai.modelSelection ? row(t.defaultProfile, ai.modelSelection.defaultProfile) : ''}
      ${ai.modelSelection ? row(t.reasoningMode, ai.modelSelection.reasoningMode) : ''}
      ${ai.modelSelection?.discovery ? row(t.discovery, `${ai.modelSelection.discovery.status}: ${String(ai.modelSelection.discovery.available)} available / ${String(ai.modelSelection.discovery.listed)} listed${ai.modelSelection.discovery.error ? ` — ${ai.modelSelection.discovery.error}` : ''}`) : ''}
      ${row(t.noLlm, ai.noLlmRequired)}
      ${row(t.modelFallbacks, ai.modelFallbacks)}
      ${
        Object.keys(ai.reasoning).length > 0
          ? row(
              t.reasoning,
              Object.entries(ai.reasoning)
                .map(([level, count]) => `${level}: ${String(count)}`)
                .join(' · '),
            )
          : ''
      }
      ${
        Object.keys(ai.complexity).length > 0
          ? row(
              t.complexity,
              Object.entries(ai.complexity)
                .map(([level, count]) => `${level}: ${String(count)}`)
                .join(' · '),
            )
          : ''
      }
    </tbody></table>${
      ai.models.length > 0
        ? `<h3>${esc(t.models)}</h3><table><thead><tr><th>model</th><th>calls</th><th>accepted</th><th>rejected</th><th>inconclusive</th><th>runtime confirmed</th><th>runtime contradicted</th><th>timeouts</th><th>fallbacks</th><th>avg latency</th><th>recoveries solved</th></tr></thead><tbody>${ai.models
            .map(
              (model) =>
                `<tr><td>${esc(model.model)}</td><td>${String(model.calls)}</td><td>${String(model.accepted)}</td><td>${String(model.rejected)}</td><td>${String(model.inconclusive)}</td><td>${String(model.runtimeConfirmed)}</td><td>${String(model.runtimeContradicted)}</td><td>${String(model.timeouts)}</td><td>${String(model.fallbacks)}</td><td>${String(model.averageLatencyMs)} ms</td><td>${String(model.recoverySolved)}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : ''
    }${
      ai.effectiveness.length > 0
        ? `<h3>${esc(t.effectiveness)}</h3><table><thead><tr><th>model</th><th>trigger</th><th>complexity</th><th>samples</th><th>confirmed</th><th>contradicted</th><th>rate</th></tr></thead><tbody>${ai.effectiveness
            .map(
              (entry) =>
                `<tr><td>${esc(entry.model)}</td><td>${esc(entry.trigger)}</td><td>${esc(entry.complexity)}</td><td>${String(entry.samples)}</td><td>${String(entry.runtimeConfirmed)}</td><td>${String(entry.runtimeContradicted)}</td><td>${entry.confirmationRate === null ? 'too few samples' : `${String(Math.round(entry.confirmationRate * 100))}%`}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : ''
    }
    ${lifecycleHtml(ai, t)}
    <h3>${esc(t.decisions)}</h3>${
      ai.decisions.length > 0
        ? `<table><thead><tr><th>id</th><th>context</th><th>trigger</th><th>complexity / model / effort</th><th>proposal</th><th>response</th><th>validation</th><th>safety</th><th>shadow</th><th>result</th><th>fallback</th><th>runtime</th><th>functional context</th></tr></thead><tbody>${decisions}</tbody></table>`
        : `<p class="muted">${t.none}</p>`
    }
  </section>`;
}

type AiSummaryView = NonNullable<ExplorationResult['ai']>;

/**
 * AI DECISIONS (§43-44) : les appels par déclencheur, puis chaque dimension SÉPARÉE — réponses,
 * validation, shadow, exécution, runtime, replis (avec les décisions qui les ont produits).
 */
function lifecycleHtml(ai: AiSummaryView, t: (typeof TEXTS)[ReportLanguage]): string {
  const lifecycle = ai.lifecycle;
  const tally = (values: Partial<Record<string, number>>): string =>
    Object.entries(values)
      .filter(([, count]) => (count ?? 0) > 0)
      .map(([key, count]) => `${key}: ${String(count)}`)
      .join(' · ') || '—';
  const callTriggers: Partial<Record<string, number>> = {};
  for (const decision of ai.decisions)
    if (decision.lifecycle.call) callTriggers[decision.trigger] = (callTriggers[decision.trigger] ?? 0) + 1;
  const responses: Partial<Record<string, number>> = {};
  const without: Partial<Record<string, number>> = {};
  for (const [response, count] of Object.entries(lifecycle.byResponse))
    if (['UNAVAILABLE', 'BUDGET_EXHAUSTED', 'NO_LLM_REQUIRED'].includes(response)) without[response] = count;
    else responses[response] = count;
  const runtime =
    ai.mode === 'ASSIST' && lifecycle.execution.executedFromAi === 0
      ? t.runtimeNa
      : `confirmed ${String(lifecycle.runtime.confirmed)} · contradicted ${String(lifecycle.runtime.contradicted)}${lifecycle.runtime.pending > 0 ? ` · pending ${String(lifecycle.runtime.pending)}` : ''}`;
  const fallbacks = Object.entries(lifecycle.fallbacks.byReason)
    .map(
      ([reason, count]) =>
        `${reason}: ${String(count)} (${(lifecycle.fallbacks.decisionIds[reason as keyof typeof lifecycle.fallbacks.decisionIds] ?? []).join(', ')})`,
    )
    .join(' · ');
  const rows: [string, string][] = [
    [t.calls, String(lifecycle.calls)],
    [t.byTrigger, tally(callTriggers)],
    [t.responses, tally(responses)],
    [t.withoutCall, `${String(lifecycle.notCalled)}${lifecycle.notCalled > 0 ? ` — ${tally(without)}` : ''}`],
    [
      t.validation,
      `valid ${String(lifecycle.validation.valid)} · invalid ${String(lifecycle.validation.invalid)}`,
    ],
    [t.shadowResults, tally(lifecycle.shadow)],
    [t.executed, String(lifecycle.execution.executedFromAi)],
    [t.notExecuted, tally(lifecycle.execution.notExecuted)],
    [t.runtime, runtime],
    [t.fallbackReasons, `${String(lifecycle.fallbacks.total)}${fallbacks ? ` — ${fallbacks}` : ''}`],
    [
      t.knowledge,
      `${String(lifecycle.knowledge.hypothesesProposed)} hypothesis(es) proposed · ${String(lifecycle.knowledge.runtimeSupported)} runtime supported · ${String(lifecycle.knowledge.runtimeContradicted)} runtime contradicted`,
    ],
    [t.consistency, `${lifecycle.consistent ? 'OK' : 'INCONSISTENT'} — ${lifecycle.consistency}`],
  ];
  return `<h3>${esc(t.lifecycle)}</h3><p class="muted">${esc(t.lifecycleHint)}</p><table><tbody>${rows
    .map(([label, value]) => `<tr><th>${esc(label)}</th><td class="wrap">${esc(value)}</td></tr>`)
    .join('')}</tbody></table>`;
}

/** Ce que la décision savait du parcours : objectif, checkpoint, précondition manquante, divergence. */
function functionalCell(decision: AiSummaryView['decisions'][number]): string {
  const functional = decision.functionalContext;
  if (!functional) return '—';
  return [
    functional.goal ? `goal ${functional.goal}` : '',
    functional.goalProgress !== undefined ? `progress ${String(functional.goalProgress)}` : '',
    functional.lastConfirmedCheckpoint ? `checkpoint ${functional.lastConfirmedCheckpoint}` : '',
    functional.missingPreconditions.length > 0
      ? `missing ${functional.missingPreconditions.join(', ')}${functional.unknownPrecondition ? ' (unknown)' : ''}`
      : '',
    functional.blockingReason ? `blocked: ${functional.blockingReason}` : '',
    functional.firstDivergence ? `first divergence: ${functional.firstDivergence}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Complexité, modèle demandé → choisi (→ réellement utilisé), effort, repli : jamais masqué. */
function modelCell(decision: NonNullable<ExplorationResult['ai']>['decisions'][number]): string {
  const context = decision.modelContext;
  const complexity = decision.complexity?.level ?? context?.complexity;
  if (!context) return complexity ?? '—';
  const selected = context.selectedModel ?? '—';
  const route = [
    context.requestedModel && context.requestedModel !== selected ? `${context.requestedModel} →` : '',
    selected,
    context.autoTier ? `(${context.autoTier})` : '',
    context.effectiveModel && context.effectiveModel !== selected ? `→ ${context.effectiveModel}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return [
    complexity,
    context.profile,
    route,
    context.sentReasoningEffort ?? 'effort not sent',
    context.fallbackApplied ? `fallback ${context.fallbackReason ?? ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
