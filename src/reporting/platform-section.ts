import type { ExplorationResult } from '../model/exploration-result.js';
import type { ActorAnalysis } from '../platform/actor-analysis.js';
import type { ApiAnalysis } from '../platform/api-testing.js';
import type { OverallStatus } from '../platform/model.js';
import type { PerformanceAnalysis } from '../platform/performance-analysis.js';
import type { RegressionAnalysis } from '../platform/regression-analysis.js';
import type { ReproductionAnalysis } from '../platform/reproduction-planner.js';
import type { VisualAnalysis } from '../platform/visual-analysis.js';
import { classPill, esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/**
 * QA PLATFORM — la section « Run workflow analysis » du rapport : le statut global en cinq valeurs
 * et ses raisons, les anomalies catégorisées (symptôme, cause, régression, avis), la couverture
 * fonctionnelle et le résumé de chaque analyse optionnelle (API, visuel, performance, acteurs,
 * régression, reproductions, tests générés). Tout vient de `result.workflowAnalysis`.
 */
const TEXTS = {
  en: {
    title: 'Run workflow analysis',
    hint: 'The overall status of the run (PASS, PASS_WITH_WARNINGS, DEGRADED, FAIL, INCONCLUSIVE), the categorised anomalies with their probable or confirmed cause, the functional coverage and the optional analyses. Every conclusion names its evidence, its confidence and its source.',
    statuses: {
      PASS: 'Pass',
      PASS_WITH_WARNINGS: 'Pass with warnings',
      DEGRADED: 'Degraded',
      FAIL: 'Fail',
      INCONCLUSIVE: 'Inconclusive',
    },
    path: { FAST: 'fast path (nothing abnormal: the deep analysis was not needed)', DEEP: 'deep path' },
    anomalies: 'Anomalies',
    none: 'No anomaly.',
    columns: ['Category', 'Severity', 'Where', 'Symptom', 'Cause', 'Regression', 'Confidence', 'Source'],
    probable: 'probable',
    confirmed: 'confirmed',
    advisory: 'Advisor (never a decision)',
    coverage: 'Functional coverage',
    covered: 'covered',
    analyses: 'Optional analyses',
    api: 'UI ↔ API correlation',
    apiTests: 'API tests from the contract',
    visual: 'Visual comparison',
    performance: 'Performance trends',
    actors: 'Actors',
    regression: 'Regression',
    reproductions: 'Reproduction paths',
    generated: 'Generated Playwright tests',
    artifacts: 'Artifacts',
    findings: 'Conclusions',
  },
  fr: {
    title: 'Analyse du run de workflow',
    hint: 'Le statut global du run (PASS, PASS_WITH_WARNINGS, DEGRADED, FAIL, INCONCLUSIVE), les anomalies catégorisées avec leur cause probable ou confirmée, la couverture fonctionnelle et les analyses optionnelles. Chaque conclusion cite ses preuves, sa confiance et sa source.',
    statuses: {
      PASS: 'Réussi',
      PASS_WITH_WARNINGS: 'Réussi avec avertissements',
      DEGRADED: 'Dégradé',
      FAIL: 'Échec',
      INCONCLUSIVE: 'Non concluant',
    },
    path: {
      FAST: 'chemin rapide (rien d’anormal : l’analyse profonde n’a pas été nécessaire)',
      DEEP: 'chemin profond',
    },
    anomalies: 'Anomalies',
    none: 'Aucune anomalie.',
    columns: ['Catégorie', 'Gravité', 'Où', 'Symptôme', 'Cause', 'Régression', 'Confiance', 'Source'],
    probable: 'probable',
    confirmed: 'confirmée',
    advisory: 'Conseiller (jamais une décision)',
    coverage: 'Couverture fonctionnelle',
    covered: 'couverts',
    analyses: 'Analyses optionnelles',
    api: 'Corrélation UI ↔ API',
    apiTests: 'Tests d’API tirés du contrat',
    visual: 'Comparaison visuelle',
    performance: 'Tendances de performance',
    actors: 'Acteurs',
    regression: 'Régression',
    reproductions: 'Chemins de reproduction',
    generated: 'Tests Playwright générés',
    artifacts: 'Artefacts',
    findings: 'Conclusions',
  },
} as const;

const STATUS_COLORS: Record<OverallStatus, string> = {
  PASS: '#15803d',
  PASS_WITH_WARNINGS: '#ca8a04',
  DEGRADED: '#ea580c',
  FAIL: '#b91c1c',
  INCONCLUSIVE: '#64748b',
};

const pct = (value: number): string => `${String(Math.round(value * 100))} %`;
const list = (items: readonly string[]): string =>
  items.length === 0 ? '' : `<ul class="muted">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
const counts = (record: Record<string, number>): string =>
  Object.entries(record)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${classPill(key)} ${String(count)}`)
    .join(' ');

export function platformSection(result: ExplorationResult, language: ReportLanguage): string {
  const report = result.workflowAnalysis;
  if (!report) return '';
  const t = TEXTS[language];
  const ext = (key: string): unknown => report.extensionFiles?.[key]?.data;
  const api = ext('apiAnalysis') as ApiAnalysis | undefined;
  const visual = ext('visualAnalysis') as VisualAnalysis | undefined;
  const performance = ext('performanceAnalysis') as PerformanceAnalysis | undefined;
  const actors = ext('actorAnalysis') as ActorAnalysis | undefined;
  const regression = ext('regressionAnalysis') as RegressionAnalysis | undefined;
  const reproductions = ext('reproductions') as ReproductionAnalysis | undefined;
  const generated = ext('generatedTests') as
    { tests: { flow: string; file: string; assertions: number }[] } | undefined;

  const banner = `<div style="border-left:6px solid ${STATUS_COLORS[report.overallStatus]};padding:10px 14px;margin:8px 0 12px;background:#f8fafc;border-radius:6px">
    <div><span class="pill" style="background:${STATUS_COLORS[report.overallStatus]};color:#fff">${esc(report.overallStatus)}</span> <b>${esc(t.statuses[report.overallStatus])}</b>${report.verdict ? ` · ${classPill(report.verdict)}` : ''} · <span class="muted">${esc(t.path[report.path])}</span></div>
    ${list(report.statusReasons)}
  </div>`;

  const anomalies =
    report.anomalies.length === 0
      ? `<p class="muted">${esc(t.none)}</p>`
      : `<table><thead><tr>${t.columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${report.anomalies
          .map((anomaly) => {
            const where = [
              anomaly.location.flow,
              anomaly.location.step !== undefined ? `#${String(anomaly.location.step)}` : '',
              anomaly.location.url ?? '',
            ]
              .filter(Boolean)
              .join(' ');
            const cause = anomaly.confirmedCause
              ? `<b>${esc(t.confirmed)}</b> ${esc(anomaly.confirmedCause.conclusion)}`
              : anomaly.probableCause
                ? `${esc(t.probable)} ${esc(anomaly.probableCause.conclusion)} (${pct(anomaly.probableCause.confidence)})`
                : '';
            const advisory = anomaly.advisory
              ? `<details><summary class="muted">${esc(t.advisory)}: ${esc(anomaly.advisory.status)}</summary><p class="muted">${esc(anomaly.advisory.text ?? anomaly.advisory.reason ?? '')}</p></details>`
              : '';
            return `<tr><td>${classPill(anomaly.category)}<br><span class="muted">${esc(anomaly.id)}</span></td><td>${classPill(anomaly.severity)}</td><td>${esc(where)}</td><td>${esc(anomaly.symptom)}<details><summary class="muted">evidence (${String(anomaly.evidence.length)})</summary>${list(anomaly.evidence)}</details>${advisory}</td><td>${cause}</td><td>${anomaly.regression ? classPill(anomaly.regression) : ''}</td><td>${pct(anomaly.confidence)}</td><td>${classPill(anomaly.source)}</td></tr>`;
          })
          .join('')}</tbody></table>`;

  const coverage = report.functionalCoverage;
  const coverageHtml = `<h3>${esc(t.coverage)}</h3><p>${pct(coverage.summary.ratio)} ${esc(t.covered)} · ${counts(
    {
      COVERED: coverage.summary.COVERED,
      PARTIALLY_COVERED: coverage.summary.PARTIALLY_COVERED,
      NOT_COVERED: coverage.summary.NOT_COVERED,
      BLOCKED: coverage.summary.BLOCKED,
      UNKNOWN: coverage.summary.UNKNOWN,
    },
  )}</p>${
    coverage.items.length > 0
      ? `<details><summary class="muted">${String(coverage.items.length)} item(s)</summary><table><tbody>${coverage.items
          .map(
            (item) =>
              `<tr><td>${classPill(item.kind)}</td><td>${esc(item.label)}</td><td>${classPill(item.status)}</td><td class="muted">${esc(item.evidence.join(' · '))}</td></tr>`,
          )
          .join('')}</tbody></table></details>`
      : ''
  }`;

  const analyses: string[] = [];
  if (api) {
    analyses.push(
      `<li><b>${esc(t.api)}</b> — ${String(api.correlation.summary.steps)} step(s): ${counts({ ...api.correlation.summary, steps: 0, contractIssues: 0 })}${api.correlation.summary.contractIssues > 0 ? ` · contract issues ${String(api.correlation.summary.contractIssues)}` : ''}</li>`,
    );
    if (api.contract)
      analyses.push(
        `<li><b>${esc(t.apiTests)}</b> — ${String(api.contract.model.tests.length)} test(s) from ${String(api.contract.operations)} operation(s): ${counts(api.contract.summary)}${api.contract.runtimeMismatches.length > 0 ? ` · runtime mismatches ${String(api.contract.runtimeMismatches.length)}` : ''}</li>`,
      );
  }
  if (visual)
    analyses.push(
      `<li><b>${esc(t.visual)}</b> — ${String(visual.summary.checkpoints)} checkpoint(s): ${counts({ ...visual.summary, checkpoints: 0 })}</li>`,
    );
  if (performance)
    analyses.push(
      `<li><b>${esc(t.performance)}</b> — ${String(performance.summary.metrics)} metric(s): ${counts({ ...performance.summary, metrics: 0 })}</li>`,
    );
  if (actors)
    analyses.push(
      `<li><b>${esc(t.actors)}</b> — ${String(actors.summary.actors)} actor(s), ${String(actors.summary.differences)} difference(s) (${String(actors.summary.unexpectedDifferences)} unexpected), rules failed ${String(actors.summary.rulesFailed)}, possible authorization regressions ${String(actors.summary.possibleRegressions)}</li>`,
    );
  if (regression)
    analyses.push(`<li><b>${esc(t.regression)}</b> — ${counts(regression.summary) || '—'}</li>`);
  if (reproductions)
    analyses.push(
      `<li><b>${esc(t.reproductions)}</b> — ${String(reproductions.artifacts.length)} artifact(s): ${counts(reproductions.summary)}</li>`,
    );
  if (generated)
    analyses.push(
      `<li><b>${esc(t.generated)}</b> — ${generated.tests.map((test) => `${esc(test.flow)} (${String(test.assertions)} assertion(s))`).join(', ')}</li>`,
    );

  const artifacts = Object.entries(report.artifacts).map(([key, file]) => `${key}: ${file}`);
  const findings = report.findings
    .slice(0, 12)
    .map(
      (finding) =>
        `${finding.conclusion} — ${String(Math.round(finding.confidence * 100))} % · ${finding.source}${finding.evidence.length > 0 ? ` · ${finding.evidence.slice(0, 3).join(' · ')}` : ''}`,
    );

  return `<section>
    <h2>${esc(t.title)}</h2>
    <p class="muted">${esc(t.hint)}</p>
    ${banner}
    <h3>${esc(t.anomalies)} (${String(report.anomalySummary.total)}, ${String(report.anomalySummary.defects)} defect(s))</h3>
    ${anomalies}
    ${coverageHtml}
    ${analyses.length > 0 ? `<h3>${esc(t.analyses)}</h3><ul>${analyses.join('')}</ul>` : ''}
    ${findings.length > 0 ? `<details><summary>${esc(t.findings)} (${String(report.findings.length)})</summary>${list(findings)}</details>` : ''}
    ${artifacts.length > 0 ? `<details><summary class="muted">${esc(t.artifacts)}</summary>${list(artifacts)}</details>` : ''}
  </section>`;
}
