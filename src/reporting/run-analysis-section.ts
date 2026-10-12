import type { RunVerdict } from '../analysis/run-analysis.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import { classPill, esc, formatDuration } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/**
 * RUN ANALYSIS, la première section de l'analyse détaillée : le verdict fonctionnel, la chaîne
 * explicative (voulu → observé → divergence → cause → hypothèses → récupération → vérification →
 * suite → dérive → couverture → apprentissage → conseiller → verdict), puis les blocs qui la
 * portent. Tout vient de `result.runAnalysis` ; les sections existantes restent le détail.
 */
const TEXTS = {
  en: {
    title: 'Run analysis',
    hint: 'What the run meant to do, what happened, where it first diverged, why, what was tried, whether it worked, what changed, what was learned — and the functional verdict. Built on the engines’ own findings: nothing is re-decided here.',
    verdicts: {
      PROVEN: 'Goal proven',
      PASSED: 'Passed',
      PASSED_WITH_RECOVERY: 'Passed with recovery',
      PASSED_UNVERIFIED: 'Passed, effects unverified',
      DIVERGED: 'Diverged',
      BLOCKED: 'Blocked',
      INCONCLUSIVE: 'Inconclusive',
      EXPLORED: 'Explored',
    } as Record<RunVerdict, string>,
    why: 'Why this verdict',
    chain: 'Causal chain',
    stages: {
      INTENT: 'Intent',
      OBSERVED: 'Observed',
      DIVERGENCE: 'First divergence',
      ROOT_CAUSE: 'Root cause',
      HYPOTHESES: 'Hypotheses',
      RECOVERY: 'Recovery',
      VERIFICATION: 'Effect verification',
      CONTINUATION: 'Continuation',
      DRIFT: 'Workflow drift',
      COVERAGE: 'Functional coverage',
      LEARNING: 'Learning',
      INTELLIGENCE: 'Intelligence advisor',
      VERDICT: 'Verdict',
    } as Record<string, string>,
    summary: 'Summary',
    flows: 'Flows',
    steps: 'Steps',
    recoveries: 'Recoveries',
    writes: 'Writes',
    proof: 'Business proof',
    divergence: 'First divergence and root cause',
    expected: 'Expected',
    observed: 'Observed',
    evidence: 'Evidence',
    candidates: 'Other candidates',
    missing: 'Missing prerequisites',
    blockedGoal: 'Blocked goal',
    recovery: 'Recovery attempts',
    chose: 'chose',
    because: 'because',
    rejected: 'rejected',
    verified: 'confirmed by the next step',
    notVerified: 'not confirmed by the next step',
    hypotheses: 'Hypotheses',
    aboutDivergence: 'about the divergence',
    checkpoints: 'Semantic checkpoints',
    coverage: 'Coverage gaps',
    drift: 'Drift',
    knowledge: 'Knowledge',
    intelligence: 'Intelligence advisor',
    contribution: 'contribution',
    recommendations: 'Recommendations',
    none: 'none',
    timeline: 'Execution timeline',
    step: 'Step',
    status: 'Status',
    effect: 'Effect',
    target: 'Target',
    network: 'Network',
    duration: 'Duration',
    json: 'run-analysis.json',
  },
  fr: {
    title: 'Analyse du run',
    hint: 'Ce que le run voulait faire, ce qui s’est passé, où il a divergé en premier, pourquoi, ce qui a été tenté, si cela a marché, ce qui a changé, ce qui a été appris — et le verdict fonctionnel. Construit sur les constats des moteurs : rien n’est redécidé ici.',
    verdicts: {
      PROVEN: 'Objectif prouvé',
      PASSED: 'Réussi',
      PASSED_WITH_RECOVERY: 'Réussi avec récupération',
      PASSED_UNVERIFIED: 'Réussi, effets non vérifiés',
      DIVERGED: 'Divergé',
      BLOCKED: 'Bloqué',
      INCONCLUSIVE: 'Indéterminé',
      EXPLORED: 'Exploré',
    } as Record<RunVerdict, string>,
    why: 'Pourquoi ce verdict',
    chain: 'Chaîne causale',
    stages: {
      INTENT: 'Intention',
      OBSERVED: 'Observé',
      DIVERGENCE: 'Première divergence',
      ROOT_CAUSE: 'Cause racine',
      HYPOTHESES: 'Hypothèses',
      RECOVERY: 'Récupération',
      VERIFICATION: 'Vérification de l’effet',
      CONTINUATION: 'Suite du parcours',
      DRIFT: 'Dérive du workflow',
      COVERAGE: 'Couverture fonctionnelle',
      LEARNING: 'Apprentissage',
      INTELLIGENCE: 'Conseiller d’intelligence',
      VERDICT: 'Verdict',
    } as Record<string, string>,
    summary: 'Synthèse',
    flows: 'Flows',
    steps: 'Étapes',
    recoveries: 'Récupérations',
    writes: 'Écritures',
    proof: 'Preuve métier',
    divergence: 'Première divergence et cause racine',
    expected: 'Attendu',
    observed: 'Observé',
    evidence: 'Preuves',
    candidates: 'Autres candidats',
    missing: 'Prérequis manquants',
    blockedGoal: 'Objectif bloqué',
    recovery: 'Tentatives de récupération',
    chose: 'a choisi',
    because: 'parce que',
    rejected: 'rejeté(s)',
    verified: 'confirmée par l’étape suivante',
    notVerified: 'non confirmée par l’étape suivante',
    hypotheses: 'Hypothèses',
    aboutDivergence: 'sur la divergence',
    checkpoints: 'Checkpoints sémantiques',
    coverage: 'Lacunes de couverture',
    drift: 'Dérive',
    knowledge: 'Connaissance',
    intelligence: 'Conseiller d’intelligence',
    contribution: 'contribution',
    recommendations: 'Recommandations',
    none: 'aucune',
    timeline: 'Chronologie de l’exécution',
    step: 'Étape',
    status: 'Statut',
    effect: 'Effet',
    target: 'Cible',
    network: 'Réseau',
    duration: 'Durée',
    json: 'run-analysis.json',
  },
};

const VERDICT_COLORS: Record<RunVerdict, string> = {
  PROVEN: '#15803d',
  PASSED: '#15803d',
  PASSED_WITH_RECOVERY: '#0369a1',
  PASSED_UNVERIFIED: '#b45309',
  DIVERGED: '#b91c1c',
  BLOCKED: '#7c2d12',
  INCONCLUSIVE: '#6b7280',
  EXPLORED: '#4338ca',
};

function list(items: readonly string[], cls = 'muted'): string {
  return items.length === 0
    ? ''
    : `<ul class="${cls}">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
}

export function runAnalysisSection(result: ExplorationResult, language: ReportLanguage): string {
  const analysis = result.runAnalysis;
  if (!analysis) return '';
  const t = TEXTS[language];
  const s = analysis.summary;
  const verdict = `<div class="verdict" style="border-left:6px solid ${VERDICT_COLORS[analysis.status]};padding:10px 14px;margin:8px 0 12px;background:var(--surface-2, #f8fafc);border-radius:8px">
    <div><span class="pill ${esc(analysis.status)}" style="background:${VERDICT_COLORS[analysis.status]};color:#fff">${esc(analysis.status)}</span> <b>${esc(t.verdicts[analysis.status])}</b> · <span class="muted">${esc(formatDuration(s.durationMs))} · run ${esc(analysis.runId)}</span></div>
    <p style="margin:6px 0 0">${esc(s.headline)}</p>
    ${analysis.explainability.verdictReasons.length > 0 ? `<p class="muted"><b>${esc(t.why)}</b></p>${list(analysis.explainability.verdictReasons)}` : ''}
  </div>`;

  const cards = [
    [t.flows, `${String(s.flows.passed)}/${String(s.flows.total)}`],
    [
      t.steps,
      `${String(s.steps.passed)}/${String(s.steps.total)}${s.steps.unverified > 0 ? ` (${String(s.steps.unverified)} ?)` : ''}`,
    ],
    [t.recoveries, `${String(s.recoveries.succeeded)}/${String(s.recoveries.attempted)}`],
    [t.writes, String(s.mutations.executed)],
    ...(s.businessProof
      ? [
          [
            t.proof,
            `${String(s.businessProof.proven)} PROVEN${s.businessProof.partial ? ` · ${String(s.businessProof.partial)} PARTIAL` : ''}${s.businessProof.notProven ? ` · ${String(s.businessProof.notProven)} NOT_PROVEN` : ''}`,
          ],
        ]
      : []),
  ]
    .map(
      ([label, value]) =>
        `<div class="card"><div class="muted" style="font-size:11px;text-transform:uppercase">${esc(label ?? '')}</div><div style="font-size:20px;font-weight:700">${esc(value ?? '')}</div></div>`,
    )
    .join('');

  const chain = `<h3>${esc(t.chain)}</h3><ol class="chain">${analysis.explainability.chain
    .map(
      (link) =>
        `<li><b>${esc(t.stages[link.stage] ?? link.stage)}</b> — ${esc(link.text)}${link.evidence.length > 0 ? `<details><summary class="muted">${esc(t.evidence)} (${String(link.evidence.length)})</summary>${list(link.evidence)}</details>` : ''}</li>`,
    )
    .join('')}</ol>`;

  const divergence = analysis.firstDivergence
    ? `<h3>${esc(t.divergence)}</h3><p><b>${esc(analysis.firstDivergence.flow)}</b> · step ${String(analysis.firstDivergence.step)} ${classPill(analysis.firstDivergence.kind)} <code>${esc(analysis.firstDivergence.description)}</code>${analysis.firstDivergence.symptomStep !== undefined ? ` <span class="muted">(symptom at step ${String(analysis.firstDivergence.symptomStep)})</span>` : ''}<br><span class="muted">${esc(analysis.firstDivergence.reason)}</span></p>
      ${analysis.firstDivergence.expected.length > 0 ? `<p class="muted"><b>${esc(t.expected)}</b></p>${list(analysis.firstDivergence.expected)}` : ''}
      ${analysis.firstDivergence.observed.length > 0 ? `<p class="muted"><b>${esc(t.observed)}</b></p>${list(analysis.firstDivergence.observed)}` : ''}
      ${
        analysis.rootCause
          ? `<p>${classPill(analysis.rootCause.category)} ${String(analysis.rootCause.confidence)}${analysis.rootCause.functional ? ` · functional ${classPill(analysis.rootCause.functional.category)} ${String(analysis.rootCause.functional.confidence)}` : ''}${analysis.rootCause.failureClass ? ` · ${classPill(analysis.rootCause.failureClass)}` : ''}${analysis.rootCause.recoverable ? '' : ' · <b>not recoverable</b>'}</p>
        ${analysis.rootCause.evidence.length > 0 ? `<p class="muted"><b>${esc(t.evidence)}</b></p>${list(analysis.rootCause.evidence.map((evidence) => `${evidence.source}: ${evidence.detail}`))}` : ''}
        ${analysis.rootCause.candidates.length > 1 ? `<p class="muted"><b>${esc(t.candidates)}</b> ${esc(analysis.rootCause.candidates.map((candidate) => `${candidate.category} (${String(candidate.confidence)})`).join(', '))}</p>` : ''}
        ${analysis.rootCause.missingPrerequisites.length > 0 ? `<p class="muted"><b>${esc(t.missing)}</b></p>${list(analysis.rootCause.missingPrerequisites)}` : ''}
        ${analysis.rootCause.blockedGoal ? `<p class="muted"><b>${esc(t.blockedGoal)}</b> ${esc(analysis.rootCause.blockedGoal.goal)} · ${esc(analysis.rootCause.blockedGoal.state)}</p>${list([...analysis.rootCause.blockedGoal.blockingReasons, ...analysis.rootCause.blockedGoal.candidateActions.map((action) => `candidate: ${action}`)])}` : ''}`
          : ''
      }`
    : '';

  const recovery = analysis.recovery
    ? `<h3>${esc(t.recovery)}</h3><ul>${analysis.recovery.attempts
        .map(
          (attempt) =>
            `<li><b>${esc(attempt.flow)}</b> step ${String(attempt.step)} · ${classPill(attempt.divergenceCategory)} → ${classPill(attempt.outcome.status)}${attempt.aiAssisted ? ' <code>AI_ASSISTED</code>' : ''}<br><span class="muted">goal ${esc(attempt.goal)} · plan ${esc(attempt.planStatus)} · ${String(attempt.candidates)} candidate(s), ${String(attempt.rejected.length)} ${esc(t.rejected)}</span>${attempt.selected ? `<br>${esc(t.chose)} <code>${esc(attempt.selected.signature)}</code> (${esc(attempt.selected.source)}) ${esc(t.because)} ${esc(attempt.selected.reasons.join('; '))}` : ''}${attempt.outcome.path.length > 0 ? `<br><span class="muted">${esc(attempt.outcome.path.join(' → '))}</span>` : ''}${attempt.verified !== undefined ? `<br>${attempt.verified ? '✓ ' + esc(t.verified) : '✕ ' + esc(t.notVerified)}` : ''}${attempt.outcome.reasons.length > 0 ? list(attempt.outcome.reasons) : ''}</li>`,
        )
        .join('')}</ul>`
    : '';

  const hypotheses =
    analysis.hypotheses.length > 0
      ? `<h3>${esc(t.hypotheses)}</h3><table><thead><tr><th>id</th><th></th><th>${esc(t.status)}</th><th>confidence</th><th>+ / −</th><th>origin</th></tr></thead><tbody>${analysis.hypotheses
          .slice(0, 12)
          .map(
            (hypothesis) =>
              `<tr><td>${esc(hypothesis.id)}${hypothesis.relatedToDivergence ? ` <span class="muted">(${esc(t.aboutDivergence)})</span>` : ''}</td><td class="wrap">${esc(hypothesis.proposition)}${hypothesis.contradiction ? `<div class="muted">${esc(hypothesis.contradiction.why)}${hypothesis.contradiction.alternatives.length > 0 ? ` → ${esc(hypothesis.contradiction.alternatives.join(', '))}` : ''}</div>` : ''}</td><td>${classPill(hypothesis.status)}</td><td>${String(hypothesis.confidence)}</td><td>${String(hypothesis.evidenceFor)} / ${String(hypothesis.evidenceAgainst)}</td><td class="muted">${esc(hypothesis.origin)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : '';

  const timeline = `<details class="flow-analysis"><summary><b>${esc(t.timeline)}</b></summary><table><thead><tr><th>#</th><th>${esc(t.step)}</th><th>${esc(t.status)}</th><th>${esc(t.effect)}</th><th>${esc(t.target)}</th><th>${esc(t.network)}</th><th>${esc(t.duration)}</th></tr></thead><tbody>${analysis.executionTimeline.entries
    .map(
      (entry) =>
        `<tr><td>${String(entry.step)}</td><td class="wrap"><code>${esc(entry.description)}</code>${entry.recovery ? `<div class="muted">recovery ${esc(entry.recovery)}</div>` : ''}${entry.testData.length > 0 ? `<div class="muted">${esc(entry.testData.join(', '))}</div>` : ''}</td><td>${classPill(entry.status)}</td><td>${entry.effect ? classPill(entry.effect) : ''}${entry.transition ? `<div class="muted">${esc(entry.transition)}</div>` : ''}</td><td>${entry.target ? classPill(entry.target) : ''}</td><td class="muted">${String(entry.requests)}${entry.writes > 0 ? ` · ${String(entry.writes)} w` : ''}${entry.errors > 0 ? ` · <b>${String(entry.errors)} err</b>` : ''}</td><td>${String(entry.durationMs)} ms</td></tr>`,
    )
    .join('')}</tbody></table></details>`;

  const extras = [
    analysis.checkpoints.length > 0
      ? `<p><b>${esc(t.checkpoints)}</b> ${analysis.checkpoints.map((checkpoint) => `${esc(checkpoint.id)} ${classPill(checkpoint.status)}`).join(' ')}</p>`
      : '',
    analysis.workflowDrift
      ? `<p><b>${esc(t.drift)}</b> ${analysis.workflowDrift.flows.map((flow) => `${esc(flow.flow)} ${classPill(flow.classification)}${flow.comparison ? ` ${classPill(flow.comparison.verdict)}` : ''}`).join(' · ')}</p>`
      : '',
    analysis.functionalCoverage && analysis.functionalCoverage.gaps.length > 0
      ? `<p><b>${esc(t.coverage)}</b></p>${list(analysis.functionalCoverage.gaps.slice(0, 8))}`
      : '',
    analysis.knowledge
      ? `<p><b>${esc(t.knowledge)}</b> <span class="muted">${String(analysis.knowledge.evidence)} evidence · ${String(analysis.knowledge.confirmed)} confirmed · ${String(analysis.knowledge.contradicted)} contradicted · ${String(analysis.knowledge.recoveriesLearned)} recoveries learned${analysis.knowledge.runs !== undefined ? ` · ${String(analysis.knowledge.runs)} run(s)` : ''}</span></p>`
      : '',
    analysis.intelligence
      ? `<p><b>${esc(t.intelligence)}</b> <span class="muted">${esc(analysis.intelligence.mode)} · ${esc(analysis.intelligence.provider)} · ${String(analysis.intelligence.calls)} calls · ${String(analysis.intelligence.accepted)} accepted · ${String(analysis.intelligence.runtimeConfirmed)} runtime-confirmed · ${esc(t.contribution)} ${classPill(analysis.intelligence.contribution)}</span></p>`
      : '',
  ].join('');

  const recommendations = `<h3>${esc(t.recommendations)}</h3>${
    analysis.recommendations.length === 0
      ? `<p class="muted">${esc(t.none)}</p>`
      : `<ul>${analysis.recommendations.map((item) => `<li>${classPill(item.kind)} ${esc(item.message)} <span class="muted">(${esc(item.origin)})</span></li>`).join('')}</ul>`
  }`;

  return `<section>
    <h2>${esc(t.title)}</h2>
    <p class="muted">${esc(t.hint)}${result.artifacts.runAnalysis ? ` · <a href="run-analysis.json">${esc(t.json)}</a>` : ''}</p>
    ${verdict}
    <div class="cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">${cards}</div>
    ${chain}
    ${divergence}
    ${recovery}
    ${hypotheses}
    ${extras}
    ${recommendations}
    ${timeline}
  </section>`;
}
