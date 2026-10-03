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
        )}</td><td>${esc(decision.validation.rejection ?? decision.validation.status)}</td><td>${esc(decision.safety ?? '—')}</td><td>${esc(decision.outcome)}</td><td>${esc(decision.runtimeResult ?? '—')}</td></tr>`,
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
    <h3>${esc(t.decisions)}</h3>${
      ai.decisions.length > 0
        ? `<table><thead><tr><th>id</th><th>context</th><th>trigger</th><th>complexity / model / effort</th><th>proposal</th><th>validation</th><th>safety</th><th>outcome</th><th>runtime</th></tr></thead><tbody>${decisions}</tbody></table>`
        : `<p class="muted">${t.none}</p>`
    }
  </section>`;
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
