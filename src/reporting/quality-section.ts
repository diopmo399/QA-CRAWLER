import type { ExplorationResult } from '../model/exploration-result.js';
import type { QualityVerificationReport } from '../quality/quality-verification.js';
import { classPill, esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/**
 * VÉRIFICATION MÉTIER — la section du rapport : le verdict métier du run, chaque assertion avec ce qui
 * était attendu, ce qui a été observé et ses preuves, la cohérence des données, et la couverture des
 * exigences. Tout vient de quality-verification.json (workflowAnalysis.extensionFiles).
 */
const TEXTS = {
  en: {
    title: 'Business verification',
    hint: 'Declared business assertions, data consistency across the screen, the request, the response and the search, and requirement coverage. BLOCKED, INCONCLUSIVE and UNVERIFIABLE are never counted as passed.',
    verdict: 'Business verdict',
    assertions: 'Assertions',
    assertionColumns: ['Assertion', 'Status', 'Expected', 'Observed', 'Evidence'],
    consistency: 'Data consistency',
    consistencyColumns: ['Rule', 'Status', 'Sources', 'Difference / limits'],
    requirements: 'Requirement coverage',
    requirementColumns: ['Requirement', 'Status', 'Verified by', 'Reasons'],
    critical: 'Critical requirements not verified',
    metrics: 'Metrics',
    limits: 'What this verification cannot assert',
    warnings: 'Traceability warnings',
    none: 'Nothing declared.',
    network: 'network not observed in values',
  },
  fr: {
    title: 'Vérification métier',
    hint: 'Les assertions métier déclarées, la cohérence des données entre l’écran, la requête, la réponse et la recherche, et la couverture des exigences. BLOCKED, INCONCLUSIVE et UNVERIFIABLE ne comptent jamais comme réussis.',
    verdict: 'Verdict métier',
    assertions: 'Assertions',
    assertionColumns: ['Assertion', 'Statut', 'Attendu', 'Observé', 'Preuves'],
    consistency: 'Cohérence des données',
    consistencyColumns: ['Règle', 'Statut', 'Sources', 'Écart / limites'],
    requirements: 'Couverture des exigences',
    requirementColumns: ['Exigence', 'Statut', 'Vérifiée par', 'Raisons'],
    critical: 'Exigences critiques non vérifiées',
    metrics: 'Métriques',
    limits: 'Ce que cette vérification ne peut pas affirmer',
    warnings: 'Avertissements de traçabilité',
    none: 'Rien de déclaré.',
    network: 'réseau non observé en valeurs',
  },
} as const;

const COLORS: Record<string, string> = {
  PASS: '#15803d',
  FAIL: '#b91c1c',
  BLOCKED: '#9333ea',
  INCONCLUSIVE: '#64748b',
  UNVERIFIABLE: '#ca8a04',
  NOT_DECLARED: '#94a3b8',
};

const list = (items: readonly string[]): string =>
  items.length === 0 ? '' : `<ul class="muted">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;

export function qualitySection(result: ExplorationResult, language: ReportLanguage): string {
  const report = result.workflowAnalysis?.extensionFiles?.qualityVerification?.data as
    QualityVerificationReport | undefined;
  if (!report) return '';
  const t = TEXTS[language];
  const evidenceById = new Map(report.evidence.map((entry) => [entry.id, entry]));
  const evidenceOf = (ids: readonly string[]): string =>
    ids.length === 0
      ? '—'
      : `<details><summary class="muted">${String(ids.length)}</summary>${list(
          ids.map((id) => {
            const entry = evidenceById.get(id);
            return entry
              ? `${entry.type} · ${entry.source}${entry.step !== undefined ? ` · step ${String(entry.step)}` : ''} · ${String(Math.round(entry.confidence * 100))} %`
              : id;
          }),
        )}</details>`;

  const color = COLORS[report.verdict] ?? '#64748b';
  const banner = `<div style="border-left:6px solid ${color};padding:10px 14px;margin:8px 0 12px;background:var(--surface-2, #f8fafc);border-radius:8px">
    <div><b>${esc(t.verdict)}</b> <span class="pill" style="background:${color};color:#fff">${esc(report.verdict)}</span> · run ${esc(report.runId)}</div>
    ${
      report.traceability.summary.criticalFailures.length > 0
        ? `<p><b>${esc(t.critical)}</b> : ${report.traceability.summary.criticalFailures.map((id) => esc(id)).join(', ')}</p>`
        : ''
    }
  </div>`;

  const flows = report.flows
    .map((flow) => {
      const assertions =
        flow.assertions.length === 0
          ? ''
          : `<h4>${esc(t.assertions)}</h4><table><thead><tr>${t.assertionColumns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${flow.assertions
              .map(
                (assertion) =>
                  `<tr><td class="wrap"><b>${esc(assertion.id)}</b> ${classPill(assertion.criticality)}${assertion.mandatory ? '' : ' <span class="muted">optional</span>'}<br><span class="muted">${esc(assertion.description)}</span></td><td>${classPill(assertion.status)}${assertion.source ? `<br><span class="muted">${esc(assertion.source)}</span>` : ''}</td><td class="wrap">${esc(assertion.expected)}</td><td class="wrap">${esc(assertion.observed)}${list(assertion.reasons)}${assertion.nextStep ? `<p class="muted">→ ${esc(assertion.nextStep)}</p>` : ''}</td><td>${evidenceOf(assertion.evidence)}</td></tr>`,
              )
              .join('')}</tbody></table>`;
      const consistency =
        flow.consistency.length === 0
          ? ''
          : `<h4>${esc(t.consistency)}</h4><table><thead><tr>${t.consistencyColumns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${flow.consistency
              .map(
                (entry) =>
                  `<tr><td class="wrap">${classPill(entry.rule)}${entry.key ? ` ${esc(entry.key)}` : ''}${entry.field ? `<br><span class="muted">${esc(entry.field)}</span>` : ''}</td><td>${classPill(entry.status)}${entry.declared ? '' : ' <span class="muted">auto</span>'}</td><td class="wrap">${esc(entry.sources.join(' → '))}${entry.normalization ? `<br><span class="muted">${esc(entry.normalization)}</span>` : ''}</td><td class="wrap">${esc(entry.difference ?? '')}${list(entry.limits)}${entry.evidence.length > 0 ? evidenceOf(entry.evidence) : ''}</td></tr>`,
              )
              .join('')}</tbody></table>`;
      return `<h3>${esc(flow.flow)} ${classPill(flow.verdict)} <span class="muted">(${esc(flow.flowStatus)}${flow.networkObserved ? '' : ` · ${esc(t.network)}`})</span></h3>${assertions}${consistency}`;
    })
    .join('');

  const requirements =
    report.traceability.requirements.length === 0
      ? ''
      : `<h3>${esc(t.requirements)}</h3><table><thead><tr>${t.requirementColumns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${report.traceability.requirements
          .map(
            (requirement) =>
              `<tr><td class="wrap"><b>${esc(requirement.id)}</b> ${classPill(requirement.criticality)}<br><span class="muted">${esc(requirement.description)}${requirement.source ? ` · ${esc(requirement.source)}` : ''}</span></td><td>${classPill(requirement.status)}</td><td class="wrap">${esc([...requirement.flows, ...requirement.rules, ...requirement.operations].join(', ') || '—')}${requirement.assertions.length > 0 ? `<br><span class="muted">${esc(requirement.assertions.map((entry) => `${entry.id}: ${entry.status}`).join(' · '))}</span>` : ''}</td><td class="wrap">${list(requirement.reasons)}</td></tr>`,
          )
          .join('')}</tbody></table>`;

  const metrics = report.metrics;
  const metricLines = [
    `assertions ${String(metrics.assertionsExecuted)}/${String(metrics.assertionsDeclared)} · ${Object.entries(
      metrics.assertionsByStatus,
    )
      .map(([status, count]) => `${status} ${String(count)}`)
      .join(', ')}`,
    `requirements ${String(metrics.requirementsVerified)}/${String(metrics.requirementsTotal)} verified · uncovered ${String(metrics.requirementsUncovered)} · stale ${String(metrics.requirementsStale)}`,
    `consistency checks ${String(metrics.consistencyChecks)} · divergences ${
      Object.entries(metrics.divergencesByRule)
        .filter(([, count]) => count > 0)
        .map(([rule, count]) => `${rule} ${String(count)}`)
        .join(', ') || '0'
    } · ambiguous ${String(metrics.ambiguousCorrelations)}`,
    `missing evidence ${String(metrics.missingEvidence)} · ${String(metrics.verificationMs)} ms`,
  ];

  return `<section>
    <h2>${esc(t.title)}</h2>
    <p class="muted">${esc(t.hint)}</p>
    ${banner}
    ${flows || `<p class="muted">${esc(t.none)}</p>`}
    ${requirements}
    <h3>${esc(t.metrics)}</h3>${list(metricLines)}
    ${report.traceability.warnings.length > 0 ? `<details><summary class="muted">${esc(t.warnings)} (${String(report.traceability.warnings.length)})</summary>${list(report.traceability.warnings)}</details>` : ''}
    <details><summary class="muted">${esc(t.limits)}</summary>${list(report.limits)}</details>
  </section>`;
}
