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
    blockedGoal: 'Blocked goal analysis',
    progress: 'Goal progress',
    divergence: 'First functional divergence',
    hypothesisDetail: 'Hypotheses (origin, evidence, status)',
    contradicted: 'Contradicted hypotheses: why, alternatives, investigation',
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
    blockedGoal: 'Analyse de l’objectif bloqué',
    progress: 'Avancement de l’objectif',
    divergence: 'Première divergence fonctionnelle',
    hypothesisDetail: 'Hypothèses (origine, preuves, statut)',
    contradicted: 'Hypothèses contredites : pourquoi, alternatives, investigation',
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
    ${blockedGoalHtml(summary, t)}
    <h3>${esc(t.checkpoints)}</h3>${list(summary.checkpoints.map((checkpoint) => `${checkpoint.id}: ${checkpoint.status}`))}
    <h3>${esc(t.hypotheses)}</h3><p class="muted">${esc(statuses)}</p>${list(summary.hypotheses.top.map((hypothesis) => `${hypothesis.id} ${hypothesis.proposition} — ${hypothesis.status} (${String(hypothesis.confidence)})`))}
    ${
      summary.hypothesisDetails.length > 0
        ? `<h3>${esc(t.hypothesisDetail)}</h3><table><thead><tr><th>id</th><th>type</th><th>origin</th><th>description</th><th>for</th><th>against</th><th>confidence</th><th>status</th><th>created</th><th>last evaluated</th></tr></thead><tbody>${summary.hypothesisDetails
            .map(
              (detail) =>
                `<tr><td>${esc(detail.id)}</td><td>${esc(detail.type)}</td><td>${esc(detail.origin)}${detail.aiDecisionId ? ` (${esc(detail.aiDecisionId)})` : ''}${detail.sourceRecording ? `<br><span class="muted">recording ${esc(detail.sourceRecording)}</span>` : ''}</td><td class="wrap">${esc(detail.description)}</td><td>${esc(detail.supportingEvidence.join(', '))}</td><td>${esc(detail.contradictingEvidence.join(', '))}</td><td>${String(detail.confidence)}</td><td>${esc(detail.status)}</td><td>${esc(detail.createdAt)}</td><td>${esc(detail.lastEvaluatedAt)}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : ''
    }
    ${
      summary.contradictedAnalysis.length > 0
        ? `<h3>${esc(t.contradicted)}</h3>${list(
            summary.contradictedAnalysis.map(
              (entry) =>
                `${entry.id} ${entry.description} — why: ${entry.why} · alternatives: ${entry.alternatives.join('; ') || 'none'} · investigation: ${entry.investigation}${entry.needsAnalysis ? ' · needs analysis (HYPOTHESIS_ANALYSIS)' : ''}`,
            ),
          )}`
        : ''
    }
    <h3>${esc(t.confirmed)}</h3>${list(summary.confirmedRelations)}
    <h3>${esc(t.contradictions)}</h3>${list(summary.contradictions)}
    <h3>${esc(t.recovered)}</h3>${list(summary.recoveredPlans)}
    ${
      summary.divergences.length > 0
        ? `<h3>${esc(t.divergence)}</h3>${list(
            summary.divergences.map(
              ({ flow, divergence }) =>
                `${flow}: step ${String(divergence.step)} "${divergence.description}" — ${divergence.kind}${divergence.expected.length > 0 ? ` · expected ${divergence.expected.join(', ')}` : ''}${divergence.observed.length > 0 ? ` · observed ${divergence.observed.join(', ')}` : ''}${divergence.rootBeforeSymptom ? ` · failure reported later at step ${String(divergence.lastFailedStep ?? '?')} (symptom, not cause)` : ''}`,
            ),
          )}`
        : ''
    }
    <h3>${esc(t.failures)}</h3>${list(
      summary.failures.map(
        (failure) =>
          `${failure.step}: ${failure.class} — ${failure.reason}${
            failure.context
              ? ` · goal ${failure.context.affectedGoal ?? '?'}${failure.context.checkpoint ? `, checkpoint ${failure.context.checkpoint}` : ''}${failure.context.expected ? `, expected ${failure.context.expected}` : ''}, observed ${failure.context.observed}`
              : ''
          }`,
      ),
    )}
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

/** Pourquoi l'objectif reste bloqué : préconditions satisfaites / manquantes, raisons, checkpoints, avancement. */
function blockedGoalHtml(
  summary: NonNullable<ExplorationResult['cognitive']>,
  t: (typeof TEXTS)[ReportLanguage],
): string {
  const analysis = summary.blockedGoal;
  const progress = summary.goalProgress;
  if (!analysis && !progress) return '';
  const rows: [string, string | undefined][] = analysis
    ? [
        ['goal', `${analysis.goal} (${analysis.node})`],
        ['state', analysis.state],
        ['satisfied preconditions', analysis.satisfiedPreconditions.join(', ') || '—'],
        [
          'missing preconditions',
          `${analysis.missingPreconditions.join(', ') || '—'}${analysis.unknownPrecondition ? ' (UNKNOWN_BLOCKING_PRECONDITION)' : ''}`,
        ],
        ['blocking reasons', analysis.blockingReasons.join(' · ') || '—'],
        ['candidate actions', analysis.candidateActions.join(', ') || undefined],
        ['candidate hypotheses', analysis.candidateHypotheses.join(', ') || undefined],
        ['last confirmed checkpoint', analysis.lastConfirmedCheckpoint],
        ['next expected checkpoint', analysis.nextExpectedCheckpoint],
        ['confidence', String(analysis.confidence)],
      ]
    : [];
  const timeline = summary.progressTimeline
    .slice(-8)
    .map((entry) => `${entry.before.toFixed(2)} → ${entry.after.toFixed(2)} (${entry.source})`)
    .join(' · ');
  return `<h3>${esc(t.blockedGoal)}</h3><table><tbody>${rows
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `<tr><th>${esc(label)}</th><td class="wrap">${esc(value ?? '')}</td></tr>`)
    .join('')}${
    progress
      ? `<tr><th>${esc(t.progress)}</th><td class="wrap">${esc(`${progress.goal}: ${String(progress.progress)}${timeline ? ` — ${timeline}` : ''}`)}</td></tr>`
      : ''
  }</tbody></table>`;
}
