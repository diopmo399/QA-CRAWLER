import type { ExplorationResult } from '../model/exploration-result.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

const TEXTS = {
  en: {
    title: 'Cognitive engine',
    hint: 'Runtime is the proof. History is experience. Static code and contracts suggest. An advisor only proposes. Safety decides.',
    mission: 'Current mission',
    state: 'Functional state',
    goal: 'Current goal',
    blocked: 'Missing precondition chain',
    plan: 'Current plan',
    checkpoints: 'Semantic checkpoints',
    hypotheses: 'Hypotheses',
    confirmed: 'Confirmed causal relations',
    contradictions: 'Contradictions',
    recovered: 'Recovered plans',
    failures: 'Failures',
    coverage: 'Functional coverage',
    gaps: 'Still untested',
    invariants: 'Discovered invariants',
    decisions: 'Reasoning decisions (WHY / WHY NOT)',
    learned: 'Knowledge',
    none: 'none',
  },
  fr: {
    title: 'Moteur cognitif',
    hint: 'Le runtime prouve. L’historique est une expérience. Le code et les contrats suggèrent. Un conseiller propose seulement. La sécurité décide.',
    mission: 'Mission en cours',
    state: 'État fonctionnel',
    goal: 'Objectif courant',
    blocked: 'Chaîne de préconditions manquantes',
    plan: 'Plan courant',
    checkpoints: 'Checkpoints sémantiques',
    hypotheses: 'Hypothèses',
    confirmed: 'Relations causales confirmées',
    contradictions: 'Contradictions',
    recovered: 'Plans réparés',
    failures: 'Échecs',
    coverage: 'Couverture fonctionnelle',
    gaps: 'Pas encore testé',
    invariants: 'Invariants découverts',
    decisions: 'Décisions raisonnées (POURQUOI / POURQUOI PAS)',
    learned: 'Connaissance',
    none: 'aucun',
  },
} as const;

/**
 * Section « Moteur cognitif » : où en est le parcours métier, ce qui bloque et pourquoi, le
 * plan, les checkpoints, ce qui est su (confirmé) et seulement supposé (hypothèses), les
 * contradictions, les échecs classés, la couverture fonctionnelle et ses trous, les décisions
 * expliquées. Des faits et des statuts — jamais une note, jamais une valeur saisie.
 */
export function cognitiveSection(result: ExplorationResult, language: ReportLanguage): string {
  const summary = result.cognitive;
  if (!summary) return '';
  const t = TEXTS[language];
  const list = (items: readonly string[]): string =>
    items.length > 0
      ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
      : `<p class="muted">${t.none}</p>`;
  const row = (label: string, value: string | undefined): string =>
    value ? `<tr><th>${esc(label)}</th><td class="wrap">${esc(value)}</td></tr>` : '';
  const statuses = Object.entries(summary.hypotheses.byStatus)
    .map(([status, count]) => `${status} ${String(count)}`)
    .join(' · ');
  return `<section>
    <h2>${esc(t.title)}</h2>
    <p class="muted">${esc(t.hint)}</p>
    <table><tbody>
      ${row(t.mission, summary.mission)}
      ${row(t.state, summary.functionalState)}
      ${row(t.goal, summary.goal)}
      ${row(t.blocked, summary.missingChain)}
      ${row(t.plan, summary.currentPlan)}
      ${row(t.learned, `${String(summary.knowledge.evidence)} evidence · ${String(summary.knowledge.hypotheses)} hypotheses · ${String(summary.knowledge.confirmed)} runtime confirmed · ${String(summary.knowledge.contradicted)} contradicted/rejected · ${String(summary.experiments.proposed)} experiment(s) proposed, ${String(summary.experiments.rejected)} refused by the SafetyPolicy`)}
    </tbody></table>
    <h3>${esc(t.checkpoints)}</h3>${list(summary.checkpoints.map((checkpoint) => `${checkpoint.id}: ${checkpoint.status}`))}
    <h3>${esc(t.hypotheses)}</h3><p class="muted">${esc(statuses)}</p>${list(summary.hypotheses.top.map((hypothesis) => `${hypothesis.id} ${hypothesis.proposition} — ${hypothesis.status} (${String(hypothesis.confidence)})`))}
    <h3>${esc(t.confirmed)}</h3>${list(summary.confirmedRelations)}
    <h3>${esc(t.contradictions)}</h3>${list(summary.contradictions)}
    <h3>${esc(t.recovered)}</h3>${list(summary.recoveredPlans)}
    <h3>${esc(t.failures)}</h3>${list(summary.failures.map((failure) => `${failure.step}: ${failure.class} — ${failure.reason}`))}
    <h3>${esc(t.coverage)}</h3>${list(summary.coverage)}
    <h3>${esc(t.gaps)}</h3>${list(summary.coverageGaps)}
    <h3>${esc(t.invariants)}</h3>${list(summary.invariants.map((invariant) => `${invariant.statement} — ${invariant.status}`))}
    <h3>${esc(t.decisions)}</h3>${
      summary.decisions.length > 0
        ? summary.decisions
            .map(
              (decision) =>
                `<details class="suggest"><summary><b>${esc(decision.id)}</b> ${esc(decision.path)} ${esc(decision.status)}${decision.selected ? ` → ${esc(decision.selected)}` : ''}${decision.reason ? ` · ${esc(decision.reason)}` : ''}</summary><pre>${esc(decision.narration.join('\n'))}</pre></details>`,
            )
            .join('')
        : `<p class="muted">${t.none}</p>`
    }
  </section>`;
}
