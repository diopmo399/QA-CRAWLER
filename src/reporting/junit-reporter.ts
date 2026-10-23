import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowRunReport, FlowStepReport } from '../model/flow-run.js';
import { isAtLeast, type Issue, type Severity } from '../model/issue.js';
import type { Reporter } from './reporter.js';

/**
 * JUNIT XML : le résultat d'un run dans le format que les serveurs d'intégration continue lisent
 * (Jenkins, GitLab, Azure DevOps, GitHub). Un reporter DE PLUS, à côté de result.json et index.html,
 * qui n'y change rien : il ne lit que `ExplorationResult`, ne décide de rien et n'écrit qu'un fichier.
 *
 *   <testsuite> par flow imposé, <testcase> par étape :
 *     PASSED  → réussi                     FAILED (obligatoire) → <failure>
 *     BLOCKED → <error> (politique de sécurité)   SKIPPED, MANUAL, FAILED (facultative) → <skipped>
 *   <testsuite name="anomalies"> : une <failure> par anomalie au seuil de report.failOnSeverity
 *     (NONE : aucune), pour que la CI échoue aux mêmes conditions que la commande qa-crawler.
 *   Sans flow ni anomalie au seuil : un <testcase> réussi, pour que le fichier reste exploitable.
 *
 * Les messages sont ceux déjà écrits dans result.json (anomalies masquées par le collecteur) :
 * aucune valeur saisie, aucun secret de plus.
 */

export interface JUnitOptions {
  /** Les anomalies à partir de cette gravité deviennent des échecs ; NONE : aucune. */
  failOnSeverity: Severity | 'NONE';
}

export interface JUnitSummary {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

/** Les caractères de contrôle (sauf tabulation et sauts de ligne) ne sont pas permis dans un document XML 1.0. */
function printable(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) out += text.charAt(index);
  }
  return out;
}

const escape = (text: string): string =>
  printable(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const attribute = (name: string, value: string | number): string => ` ${name}="${escape(String(value))}"`;
const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3);
const slug = (text: string): string =>
  text.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'flow';

interface Case {
  name: string;
  classname: string;
  timeMs: number;
  outcome: 'passed' | 'failure' | 'error' | 'skipped';
  message?: string;
  type?: string;
  body?: string;
}

interface Suite {
  name: string;
  timestamp?: string;
  properties: [string, string][];
  cases: Case[];
}

function stepCase(flow: FlowRunReport, step: FlowStepReport): Case {
  const base = {
    name: `step ${String(step.index)} — ${step.description}`,
    classname: `qa-crawler.flows.${slug(flow.name)}`,
    timeMs: step.durationMs,
  };
  const reason = step.reason ?? step.status;
  switch (step.status) {
    case 'PASSED':
      return { ...base, outcome: 'passed' };
    case 'FAILED':
      return step.optional
        ? { ...base, outcome: 'skipped', message: `optional step failed: ${reason}` }
        : { ...base, outcome: 'failure', type: 'FAILED', message: reason, body: stepDetails(step) };
    case 'BLOCKED':
      return {
        ...base,
        outcome: step.optional ? 'skipped' : 'error',
        type: 'BLOCKED',
        message: step.optional ? `optional step blocked: ${reason}` : reason,
        body: stepDetails(step),
      };
    case 'SKIPPED':
      return { ...base, outcome: 'skipped', message: reason };
    case 'MANUAL':
      return { ...base, outcome: 'skipped', message: `manual check: ${step.description}` };
  }
}

function stepDetails(step: FlowStepReport): string {
  return [
    `status: ${step.status}`,
    ...(step.reason ? [`reason: ${step.reason}`] : []),
    ...(step.url ? [`url: ${step.url}`] : []),
    ...(step.screenshot ? [`screenshot: ${step.screenshot}`] : []),
    ...(step.suggestions ?? []).map((suggestion) => `suggestion: ${suggestion}`),
  ].join('\n');
}

function flowSuite(flow: FlowRunReport): Suite {
  return {
    name: flow.name,
    timestamp: flow.startedAt,
    properties: [
      ['qa-crawler.flow.status', flow.status],
      ...(flow.description ? [['qa-crawler.flow.description', flow.description] as [string, string]] : []),
      ...(flow.businessProof
        ? [['qa-crawler.businessProof', flow.businessProof.status] as [string, string]]
        : []),
    ],
    cases: flow.steps.map((step) => stepCase(flow, step)),
  };
}

function issueCase(issue: Issue): Case {
  return {
    name: `${issue.id} ${issue.type}: ${issue.message}`,
    classname: `qa-crawler.anomalies.${issue.type}`,
    timeMs: 0,
    outcome: 'failure',
    type: issue.severity,
    message: issue.message,
    body: [
      `severity: ${issue.severity}`,
      `page: ${issue.pageUrl}`,
      ...(issue.requestUrl
        ? [`request: ${issue.method ?? ''} ${issue.requestUrl} ${String(issue.status ?? '')}`.trim()]
        : []),
      `occurrences: ${String(issue.occurrences)}`,
      ...(issue.screenshot ? [`screenshot: ${issue.screenshot}`] : []),
    ].join('\n'),
  };
}

/** Les suites JUnit d'un résultat (pures : rien n'est lu ni écrit). */
export function junitSuitesOf(result: ExplorationResult, options: JUnitOptions): Suite[] {
  const suites = result.flows.map(flowSuite);
  const threshold = options.failOnSeverity;
  const failing =
    threshold === 'NONE' ? [] : result.issues.filter((issue) => isAtLeast(issue.severity, threshold));
  if (failing.length > 0)
    suites.push({
      name: 'anomalies',
      timestamp: result.startedAt,
      properties: [['qa-crawler.failOnSeverity', options.failOnSeverity]],
      cases: failing.map(issueCase),
    });
  if (suites.every((suite) => suite.cases.length === 0))
    suites.push({
      name: 'mission',
      timestamp: result.startedAt,
      properties: [],
      cases: [
        {
          name: `${result.mission}: ${String(result.issues.length)} anomaly(ies), none at or above ${options.failOnSeverity}`,
          classname: 'qa-crawler.mission',
          timeMs: result.durationMs,
          outcome: 'passed',
        },
      ],
    });
  return suites;
}

function summarize(cases: readonly Case[]): JUnitSummary {
  return {
    tests: cases.length,
    failures: cases.filter((entry) => entry.outcome === 'failure').length,
    errors: cases.filter((entry) => entry.outcome === 'error').length,
    skipped: cases.filter((entry) => entry.outcome === 'skipped').length,
  };
}

function renderCase(entry: Case): string {
  const open = `<testcase${attribute('name', entry.name)}${attribute('classname', entry.classname)}${attribute('time', seconds(entry.timeMs))}>`;
  if (entry.outcome === 'passed') return `${open}</testcase>`;
  const tag = entry.outcome;
  const inner = `<${tag}${entry.message !== undefined ? attribute('message', entry.message) : ''}${entry.type ? attribute('type', entry.type) : ''}>${escape(entry.body ?? '')}</${tag}>`;
  return `${open}${inner}</testcase>`;
}

function renderSuite(suite: Suite): string {
  const summary = summarize(suite.cases);
  const time = suite.cases.reduce((sum, entry) => sum + entry.timeMs, 0);
  const properties =
    suite.properties.length > 0
      ? `<properties>${suite.properties.map(([name, value]) => `<property${attribute('name', name)}${attribute('value', value)}/>`).join('')}</properties>`
      : '';
  return [
    `<testsuite${attribute('name', suite.name)}${attribute('tests', summary.tests)}${attribute('failures', summary.failures)}${attribute('errors', summary.errors)}${attribute('skipped', summary.skipped)}${attribute('time', seconds(time))}${suite.timestamp ? attribute('timestamp', suite.timestamp.replace(/\.\d{3}Z$/, '')) : ''}>`,
    properties,
    ...suite.cases.map(renderCase),
    '</testsuite>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Le document JUnit XML d'un résultat, et son résumé. */
export function junitXmlOf(
  result: ExplorationResult,
  options: JUnitOptions,
): { xml: string; summary: JUnitSummary } {
  const suites = junitSuitesOf(result, options);
  const summary = summarize(suites.flatMap((suite) => suite.cases));
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attribute('name', `qa-crawler: ${result.mission}`)}${attribute('tests', summary.tests)}${attribute('failures', summary.failures)}${attribute('errors', summary.errors)}${attribute('skipped', summary.skipped)}${attribute('time', seconds(result.durationMs))}>`,
    ...suites.map(renderSuite),
    '</testsuites>',
    '',
  ].join('\n');
  return { xml, summary };
}

/** Écrit reports/junit.xml (ou le fichier demandé, relatif au dossier des rapports). */
export class JUnitReporter implements Reporter {
  readonly format = 'junit';

  constructor(
    private readonly directory: string,
    private readonly fileName: string,
    private readonly options: JUnitOptions,
  ) {}

  async write(result: ExplorationResult): Promise<string> {
    const file = path.resolve(this.directory, this.fileName);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, junitXmlOf(result, this.options).xml, 'utf8');
    return file;
  }
}
