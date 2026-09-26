import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult, StateReport } from '../model/exploration-result.js';
import { SEVERITIES, type Issue, type Severity } from '../model/issue.js';
import type { Reporter } from './reporter.js';
import { buildFlowTree, displayName } from './flow-tree.js';
import {
  BASE_CSS,
  card,
  classPill,
  esc,
  formatDate,
  formatDuration,
  renderTreeHtml,
  severityBadge,
  SEVERITY_COLORS,
} from './html-common.js';

export { esc } from './html-common.js';

/** reports/index.html — static, self-contained report (no JavaScript, no external assets). */
export class HtmlReporter implements Reporter {
  readonly format = 'html';

  constructor(
    private readonly directory: string,
    private readonly fileName = 'index.html',
  ) {}

  async write(result: ExplorationResult): Promise<string> {
    const target = path.join(this.directory, this.fileName);
    await writeFile(
      target,
      renderHtml(result, (file) => relativeTo(this.directory, file)),
      'utf8',
    );
    return target;
  }
}

/** Path of a file relative to the report, so reports and screenshots can be published together. */
export function relativeTo(directory: string, file: string): string {
  const relative = path.relative(directory, path.resolve(file));
  return relative.split(path.sep).map(encodeURIComponent).join('/');
}

export function renderHtml(
  result: ExplorationResult,
  href: (file: string) => string = (file) => file,
): string {
  const stateNames = new Map(result.states.map((state) => [state.id, displayName(state)]));
  const nameOf = (stateId: string): string => stateNames.get(stateId) ?? stateId;
  const bySeverity = [...result.issues].sort(
    (a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.id.localeCompare(b.id),
  );
  const httpIssues = bySeverity.filter((issue) =>
    ['HTTP', 'REQUEST_FAILED', 'BROKEN_LINK'].includes(issue.type),
  );
  const jsIssues = bySeverity.filter((issue) => ['CONSOLE', 'PAGE_ERROR', 'PAGE_CRASH'].includes(issue.type));
  const navigationIssues = bySeverity.filter((issue) => issue.type === 'NAVIGATION');
  const flowIssues = bySeverity.filter((issue) => issue.type === 'FLOW');
  const executed = result.transitions.filter((edge) => edge.result !== 'BLOCKED');
  const blocked = result.transitions.filter((edge) => edge.result === 'BLOCKED');
  const tree = buildFlowTree(result.states, result.transitions, result.states[0]?.id);
  const status = overallStatus(result.stats.issuesBySeverity);
  const shots = result.states.filter((state) => state.screenshot);
  const actionText = (actionId: string | undefined): string => {
    if (!actionId) return '';
    const edge = result.transitions.find((candidate) => candidate.actionId === actionId);
    return edge ? `${edge.action.type} “${edge.action.text ?? edge.action.label ?? ''}”` : actionId;
  };

  const issueTable = (title: string, issues: Issue[], withRequest: boolean): string => {
    if (issues.length === 0)
      return `<section><h2>${esc(title)}</h2><p class="empty">None detected.</p></section>`;
    const rows = issues
      .map(
        (issue) => `<tr>
        <td>${severityBadge(issue.severity)}<br><span class="muted">${esc(issue.type)}</span></td>
        ${withRequest ? `<td>${issue.status ?? ''}</td><td class="wrap">${esc([issue.method, issue.requestUrl].filter(Boolean).join(' '))}</td>` : ''}
        <td class="wrap">${esc(issue.message)}</td>
        <td class="wrap">${issue.stateId ? `<b>${esc(nameOf(issue.stateId))}</b>` : ''}${issue.actionId ? `<br><span class="muted">after ${esc(actionText(issue.actionId))}</span>` : ''}
          ${issue.flow && issue.flow.length > 1 ? `<div class="flow">${issue.flow.map((id) => esc(nameOf(id))).join(' → ')}</div>` : ''}</td>
        <td>${issue.occurrences}</td>
        <td>${issue.screenshot ? `<a href="${esc(href(issue.screenshot))}">view</a>` : ''}</td>
      </tr>`,
      )
      .join('');
    return `<section><h2>${esc(title)} (${issues.length})</h2><table><thead><tr><th>Severity</th>${withRequest ? '<th>Status</th><th>Request</th>' : ''}<th>Message</th><th>State · action · flow</th><th>Count</th><th>Shot</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA Flow Explorer — ${esc(result.mission)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <h1>${esc(result.mission)}</h1>
  <div class="meta">${esc(result.target.startUrl)} · ${esc(formatDate(result.startedAt))} · ${esc(formatDuration(result.durationMs))} · stopped: ${esc(result.stopReason)} · engine: ${esc(result.decisionEngine)}</div>
  ${result.description ? `<div class="meta">${esc(result.description)}</div>` : ''}
  <span class="status" style="background:${status.color}">${esc(status.label)}</span>
  <nav>${result.artifacts.flowGraphHtml ? `<a href="${esc(href(result.artifacts.flowGraphHtml))}">Flow graph →</a>` : ''}${result.artifacts.json ? `<a href="${esc(href(result.artifacts.json))}">result.json</a>` : ''}${result.artifacts.flowGraph ? `<a href="${esc(href(result.artifacts.flowGraph))}">flow-graph.json</a>` : ''}</nav>
</header>
<main>
  <div class="cards">
    ${card('States', result.stats.states)}
    ${card('Transitions', result.stats.transitions)}
    ${card('Actions executed', result.stats.actionsExecuted)}
    ${card('Actions blocked', result.stats.actionsBlocked)}
    ${card('Max depth', result.stats.maxDepth)}
    ${card('Backtracks', result.stats.backtracks)}
    ${result.flows.length > 0 ? card('Flows passed', `${result.stats.flowsPassed}/${result.flows.length}`) : ''}
    ${card('Issues', result.issues.length)}
    ${SEVERITIES.slice()
      .reverse()
      .map((severity) => card(severity, result.stats.issuesBySeverity[severity], SEVERITY_COLORS[severity]))
      .join('')}
    ${card('Duration', formatDuration(result.durationMs))}
  </div>

  ${result.flows.length > 0 ? flowsSection(result, nameOf, href) : ''}

  <section>
    <h2>Discovered flow</h2>
    <p class="muted">Each state appears under the state from which it was first reached, with the action that led there.</p>
    ${renderTreeHtml(tree, (stateId) => result.issues.filter((issue) => issue.states.includes(stateId)).length)}
  </section>

  ${flowIssues.length > 0 ? issueTable('Flow failures', flowIssues, false) : ''}
  ${issueTable('HTTP errors & broken pages', httpIssues, true)}
  ${issueTable('JavaScript errors', jsIssues, false)}
  ${navigationIssues.length > 0 ? issueTable('Navigation problems', navigationIssues, true) : ''}

  <section>
    <h2>States (${result.states.length})</h2>
    ${statesTable(result.states, href)}
  </section>

  <section>
    <h2>Executed actions (${executed.length})</h2>
    ${
      executed.length === 0
        ? '<p class="empty">No action executed.</p>'
        : `<table><thead><tr><th>From</th><th>Action</th><th>To</th><th>Result</th><th>Duration</th></tr></thead><tbody>${executed
            .map(
              (edge) =>
                `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(edge.action.type)} “${esc(edge.action.text ?? edge.action.label ?? '')}” <span class="muted">${esc(edge.action.category)}</span></td><td>${edge.to === edge.from ? '<span class="muted">(same state)</span>' : esc(nameOf(edge.to))}</td><td>${classPill(edge.result)}${edge.reason ? `<br><span class="muted">${esc(edge.reason)}</span>` : ''}</td><td>${edge.durationMs ?? ''} ms</td></tr>`,
            )
            .join('')}</tbody></table>`
    }
  </section>

  <section>
    <h2>Blocked actions (${blocked.length})</h2>
    <p class="muted">Refused by the safety policy (after the decision engine chose them, before Playwright).</p>
    ${
      blocked.length === 0
        ? '<p class="empty">No action was blocked.</p>'
        : `<table><thead><tr><th>State</th><th>Action</th><th>Class</th><th>Reason</th></tr></thead><tbody>${blocked
            .map(
              (edge) =>
                `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(edge.action.type)} “${esc(edge.action.text ?? edge.action.label ?? '')}”</td><td>${classPill(edge.action.classification)}</td><td class="wrap">${esc(edge.reason ?? '')}</td></tr>`,
            )
            .join('')}</tbody></table>`
    }
  </section>

  <section>
    <h2>Screenshots (${shots.length})</h2>
    ${
      shots.length === 0
        ? '<p class="empty">No screenshots were captured.</p>'
        : `<div class="shots">${shots
            .map((state) => {
              const link = esc(href(state.screenshot ?? ''));
              return `<figure><a href="${link}"><img loading="lazy" src="${link}" alt="${esc(displayName(state))}"></a><figcaption><b>${esc(displayName(state))}</b><br>${esc(state.url)}</figcaption></figure>`;
            })
            .join('')}</div>`
    }
  </section>
  <p class="muted">Generated by qa-crawler (flow explorer) · ${esc(formatDate(result.finishedAt))}</p>
</main>
</body>
</html>
`;
}

function flowsSection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  href: (file: string) => string,
): string {
  const runs = result.flows
    .map((flow) => {
      const rows = flow.steps
        .map(
          (step) =>
            `<tr><td>${step.index}</td><td class="wrap"><code>${esc(step.description)}</code>${step.optional ? ' <span class="muted">(optional)</span>' : ''}</td><td>${step.classification ? classPill(step.classification) : ''}</td><td>${classPill(step.status)}</td><td class="wrap muted">${esc(step.reason ?? '')}</td><td class="wrap">${step.stateId ? esc(nameOf(step.stateId)) : ''}</td><td>${step.durationMs} ms</td><td>${step.screenshot ? `<a href="${esc(href(step.screenshot))}">view</a>` : ''}</td></tr>`,
        )
        .join('');
      return `<div class="flow-run"><h3>${esc(flow.name)} ${classPill(flow.status)} <span class="muted">${esc(formatDuration(flow.durationMs))}${flow.explored ? ' · last screen explored' : ''}</span></h3>
      ${flow.description ? `<p class="muted">${esc(flow.description)}</p>` : ''}
      <table><thead><tr><th>#</th><th>Step</th><th>Class</th><th>Result</th><th>Reason</th><th>State</th><th>Duration</th><th>Shot</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');
  return `<section>
    <h2>Imposed flows (${result.flows.length})</h2>
    <p class="muted">Steps written in the mission, run in order. Each step still goes through the safety policy: DANGEROUS actions never run, MUTATION ones only with <code>allow: MUTATION</code>.</p>
    ${runs}
  </section>`;
}

function statesTable(states: StateReport[], href: (file: string) => string): string {
  if (states.length === 0) return '<p class="empty">No state discovered.</p>';
  const rows = states
    .map((state) => {
      const counts = new Map<string, number>();
      for (const action of state.actionsDetail)
        counts.set(action.classification, (counts.get(action.classification) ?? 0) + 1);
      const actions = [...counts.entries()]
        .map(([classification, count]) => `${classPill(classification)} ${count}`)
        .join(' ');
      const details = state.actionsDetail
        .map(
          (action) =>
            `<tr><td>${classPill(action.classification)}</td><td>${esc(action.type)}</td><td>${esc(action.category)}</td><td class="wrap">${esc(action.text ?? action.label ?? action.name ?? '(no label)')}</td><td class="wrap"><code>${esc(describe(action.locator))}</code></td><td class="wrap muted">${esc(action.reason)}</td></tr>`,
        )
        .join('');
      return `<tr>
        <td class="wrap"><b>${esc(displayName(state))}</b><br><span class="muted">${esc(state.id)}</span></td>
        <td class="wrap">${esc(state.url)}<br><code>${esc(state.route)}</code></td>
        <td>${state.depth}</td>
        <td>${actions}${details ? `<details><summary>${state.actionsDetail.length} action(s)</summary><table><thead><tr><th>Class</th><th>Type</th><th>Category</th><th>Label</th><th>Locator</th><th>Reason</th></tr></thead><tbody>${details}</tbody></table></details>` : ''}</td>
        <td>${state.forms.filter((form) => form.index >= 0).length}</td>
        <td>${state.issueIds.length}</td>
        <td>${state.screenshot ? `<a href="${esc(href(state.screenshot))}">view</a>` : ''}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr><th>State</th><th>URL · route</th><th>Depth</th><th>Actions</th><th>Forms</th><th>Issues</th><th>Shot</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function describe(locator: StateReport['actionsDetail'][number]['locator']): string {
  const nth = locator.nth !== undefined ? ` nth=${locator.nth}` : '';
  switch (locator.strategy) {
    case 'role':
      return `getByRole('${locator.role ?? ''}', { name: '${locator.name ?? ''}' })${nth}`;
    case 'testId':
      return `getByTestId('${locator.value ?? ''}')${nth}`;
    case 'label':
      return `getByLabel('${locator.value ?? ''}')${nth}`;
    case 'text':
      return `getByText('${locator.value ?? ''}')${nth}`;
    case 'css':
      return `locator('${locator.value ?? ''}')${nth}`;
  }
}

function overallStatus(counts: Record<Severity, number>): { label: string; color: string } {
  if (counts.CRITICAL > 0) return { label: 'CRITICAL issues found', color: SEVERITY_COLORS.CRITICAL };
  if (counts.ERROR > 0) return { label: 'Errors found', color: SEVERITY_COLORS.ERROR };
  if (counts.WARNING > 0) return { label: 'Warnings only', color: SEVERITY_COLORS.WARNING };
  return { label: 'No issues', color: '#15803d' };
}
