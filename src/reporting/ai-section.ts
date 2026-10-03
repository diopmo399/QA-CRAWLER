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
        `<tr><td>${esc(decision.id)}</td><td>${esc(decision.context)}</td><td>${esc(decision.trigger)}</td><td class="wrap">${esc(
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
    </tbody></table>
    <h3>${esc(t.decisions)}</h3>${
      ai.decisions.length > 0
        ? `<table><thead><tr><th>id</th><th>context</th><th>trigger</th><th>proposal</th><th>validation</th><th>safety</th><th>outcome</th><th>runtime</th></tr></thead><tbody>${decisions}</tbody></table>`
        : `<p class="muted">${t.none}</p>`
    }
  </section>`;
}
