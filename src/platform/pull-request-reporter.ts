import type { ExplorationResult } from '../model/exploration-result.js';
import type { RunWorkflowAnalysisReport } from './run-workflow-analysis.js';
import type { RegressionAnalysis } from './regression-analysis.js';
import type { PerformanceAnalysis } from './performance-analysis.js';
import type { VisualAnalysis } from './visual-analysis.js';
import type { ActorAnalysis } from './actor-analysis.js';

/**
 * PULL REQUEST REPORTER : le résultat STRUCTURÉ du run rendu en un commentaire de pull request,
 * puis publié par un reporter (GitHub ici ; l'interface permet d'autres forges). Le commentaire
 * est régénéré à chaque run et REMPLACE le précédent (marqueur caché) au lieu d'empiler. Aucun
 * secret : le jeton vient d'une variable d'environnement, n'est jamais journalisé, et le texte ne
 * contient que ce que les rapports contiennent déjà.
 */
export const PR_COMMENT_MARKER = '<!-- qa-crawler-run-report -->';

export interface PullRequestPublication {
  posted: boolean;
  url?: string;
  /** created | updated | skipped */
  action: 'created' | 'updated' | 'skipped';
  reason?: string;
}

export interface PullRequestReporter {
  readonly name: string;
  publish(comment: string): Promise<PullRequestPublication>;
}

export interface PullRequestCommentInput {
  result: ExplorationResult;
  report: RunWorkflowAnalysisReport;
  regression?: RegressionAnalysis;
  performance?: PerformanceAnalysis;
  visual?: VisualAnalysis;
  actors?: ActorAnalysis;
  /** Lien vers le rapport HTML publié (artefact de CI), s'il y en a un. */
  reportUrl?: string;
}

const STATUS_ICON: Record<RunWorkflowAnalysisReport['overallStatus'], string> = {
  PASS: '✅',
  PASS_WITH_WARNINGS: '🟡',
  DEGRADED: '🟠',
  FAIL: '❌',
  INCONCLUSIVE: '⚪',
};

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Le commentaire Markdown (déterministe : les mêmes analyses donnent le même texte). */
export function renderPullRequestComment(input: PullRequestCommentInput): string {
  const { result, report } = input;
  const lines: string[] = [
    PR_COMMENT_MARKER,
    `## ${STATUS_ICON[report.overallStatus]} QA-CRAWLER — ${report.overallStatus}`,
    '',
    `**Mission** \`${cell(result.mission)}\` · **mode** ${result.mode} · **run** \`${cell(result.runId ?? '')}\` · **duration** ${String(Math.round(result.durationMs / 1000))} s${report.verdict ? ` · **functional verdict** ${report.verdict}` : ''}`,
    '',
    ...report.statusReasons.map((reason) => `- ${cell(reason)}`),
    '',
    '| Flows | Steps | Anomalies | Defects | Coverage |',
    '| --- | --- | --- | --- | --- |',
    `| ${String(report.execution.flows.filter((flow) => flow.status === 'PASSED').length)}/${String(report.execution.flows.length)} passed | ${String(report.execution.flows.reduce((sum, flow) => sum + flow.steps.filter((step) => step.status === 'PASSED').length, 0))}/${String(report.execution.flows.reduce((sum, flow) => sum + flow.steps.length, 0))} passed | ${String(report.anomalySummary.total)} | ${String(report.anomalySummary.defects)} | ${String(Math.round(report.functionalCoverage.summary.ratio * 100))} % (${String(report.functionalCoverage.summary.COVERED)}/${String(report.functionalCoverage.summary.total)}) |`,
    '',
  ];
  const defects = report.anomalies.filter((anomaly) => anomaly.severity !== 'INFO').slice(0, 10);
  if (defects.length > 0) {
    lines.push(
      '### Anomalies',
      '',
      '| Category | Where | Symptom | Regression | Confidence |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const anomaly of defects)
      lines.push(
        `| ${anomaly.category} | ${cell([anomaly.location.flow, anomaly.location.step !== undefined ? `step ${String(anomaly.location.step)}` : undefined].filter(Boolean).join(' '))} | ${cell(anomaly.symptom.slice(0, 160))} | ${anomaly.regression ?? '—'} | ${String(Math.round(anomaly.confidence * 100))} % |`,
      );
    lines.push('');
  }
  const regression = input.regression;
  if (regression && regression.entries.length > 0) {
    const counts = Object.entries(regression.summary).filter(([, count]) => count > 0);
    lines.push(
      '### Regression',
      '',
      counts.map(([status, count]) => `**${status}** ${String(count)}`).join(' · '),
      '',
    );
  }
  const performance = input.performance;
  if (performance && performance.summary.PERFORMANCE_REGRESSION + performance.summary.VARIATION > 0) {
    lines.push('### Performance', '');
    for (const metric of performance.metrics.filter(
      (entry) => entry.status === 'PERFORMANCE_REGRESSION' || entry.status === 'VARIATION',
    ))
      lines.push(
        `- ${metric.status}: ${cell(metric.label)} ${String(metric.currentValue)} ms vs ${String(metric.baselineValue ?? 0)} ms (${metric.percentageChange !== undefined && metric.percentageChange > 0 ? '+' : ''}${String(metric.percentageChange ?? 0)} %)`,
      );
    lines.push('');
  }
  const visual = input.visual;
  if (
    visual &&
    visual.summary.VISUAL_REGRESSION + visual.summary.MAJOR_CHANGE + visual.summary.MINOR_CHANGE > 0
  )
    lines.push(
      '### Visual',
      '',
      `**VISUAL_REGRESSION** ${String(visual.summary.VISUAL_REGRESSION)} · **MAJOR_CHANGE** ${String(visual.summary.MAJOR_CHANGE)} · **MINOR_CHANGE** ${String(visual.summary.MINOR_CHANGE)} · **VISUAL_MATCH** ${String(visual.summary.VISUAL_MATCH)}`,
      '',
    );
  const actors = input.actors;
  if (
    actors &&
    (actors.summary.rulesFailed > 0 ||
      actors.summary.possibleRegressions > 0 ||
      actors.summary.unexpectedDifferences > 0)
  )
    lines.push(
      '### Actors',
      '',
      `${String(actors.summary.actors)} actor(s) · rules failed ${String(actors.summary.rulesFailed)} · possible authorization regressions ${String(actors.summary.possibleRegressions)} · unexpected differences ${String(actors.summary.unexpectedDifferences)}`,
      '',
    );
  if (input.reportUrl) lines.push(`[Full report](${input.reportUrl})`, '');
  lines.push(
    `<sub>Generated by QA-CRAWLER (${report.path} path). Artifacts: ${Object.keys(report.artifacts).sort().join(', ') || 'none'}.</sub>`,
  );
  return lines.join('\n');
}

export interface GitHubReporterOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  /** Nom de la variable d'environnement qui contient le jeton (jamais le jeton). */
  tokenEnv: string;
  env: NodeJS.ProcessEnv;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

interface GitHubComment {
  id: number;
  body?: string;
  html_url?: string;
}

/** Publie (ou met à jour) le commentaire sur une pull request GitHub. */
export class GitHubPullRequestReporter implements PullRequestReporter {
  readonly name = 'github';

  constructor(private readonly options: GitHubReporterOptions) {}

  async publish(comment: string): Promise<PullRequestPublication> {
    const token = this.options.env[this.options.tokenEnv];
    if (!token)
      return {
        posted: false,
        action: 'skipped',
        reason: `environment variable ${this.options.tokenEnv} is not set`,
      };
    const base = `${(this.options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '')}/repos/${this.options.owner}/${this.options.repo}/issues/${String(this.options.pullNumber)}/comments`;
    const call = this.options.fetch ?? fetch;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
    try {
      const listed = await call(`${base}?per_page=100`, { headers });
      if (!listed.ok)
        return {
          posted: false,
          action: 'skipped',
          reason: `GitHub answered ${String(listed.status)} when listing the comments`,
        };
      const existing = ((await listed.json()) as GitHubComment[]).find((entry) =>
        entry.body?.includes(PR_COMMENT_MARKER),
      );
      const target = existing
        ? `${(this.options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '')}/repos/${this.options.owner}/${this.options.repo}/issues/comments/${String(existing.id)}`
        : base;
      const response = await call(target, {
        method: existing ? 'PATCH' : 'POST',
        headers,
        body: JSON.stringify({ body: comment }),
      });
      if (!response.ok)
        return {
          posted: false,
          action: 'skipped',
          reason: `GitHub answered ${String(response.status)} when ${existing ? 'updating' : 'creating'} the comment`,
        };
      const created = (await response.json()) as GitHubComment;
      return {
        posted: true,
        action: existing ? 'updated' : 'created',
        ...(created.html_url ? { url: created.html_url } : {}),
      };
    } catch (error) {
      // Le message d'erreur ne contient jamais le jeton (il n'est pas dans l'URL).
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return {
        posted: false,
        action: 'skipped',
        reason: `GitHub request failed: ${reason ?? 'unknown error'}`,
      };
    }
  }
}
