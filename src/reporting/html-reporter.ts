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
import { reportTexts, translateReason, valueLabel, type ReportLanguage, type ReportTexts } from './i18n.js';

export { esc } from './html-common.js';

/** reports/index.html — static, self-contained report (no JavaScript, no external assets). */
export class HtmlReporter implements Reporter {
  readonly format = 'html';

  constructor(
    private readonly directory: string,
    private readonly fileName = 'index.html',
    private readonly language: ReportLanguage = 'en',
  ) {}

  async write(result: ExplorationResult): Promise<string> {
    const target = path.join(this.directory, this.fileName);
    await writeFile(
      target,
      renderHtml(result, (file) => relativeTo(this.directory, file), this.language),
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
  language: ReportLanguage = 'en',
): string {
  const t = reportTexts(language);
  const c = t.columns;
  const label = (value: string): string => valueLabel(language, value);
  const reason = (text: string): string => translateReason(language, text);
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
  const formIssues = bySeverity.filter((issue) => issue.type === 'FORM_VALIDATION');
  const executed = result.transitions.filter((edge) => edge.result !== 'BLOCKED');
  const blocked = result.transitions.filter((edge) => edge.result === 'BLOCKED');
  const tree = buildFlowTree(result.states, result.transitions, result.states[0]?.id);
  const status = overallStatus(result.stats.issuesBySeverity, t);
  const shots = result.states.filter((state) => state.screenshot);
  const actionText = (actionId: string | undefined): string => {
    if (!actionId) return '';
    const edge = result.transitions.find((candidate) => candidate.actionId === actionId);
    return edge ? `${label(edge.action.type)} “${edge.action.text ?? edge.action.label ?? ''}”` : actionId;
  };

  const issueTable = (title: string, issues: Issue[], withRequest: boolean): string => {
    if (issues.length === 0)
      return `<section><h2>${esc(title)}</h2><p class="empty">${esc(t.noneDetected)}</p></section>`;
    const rows = issues
      .map(
        (issue) => `<tr>
        <td>${severityBadge(issue.severity, language)}<br><span class="muted">${esc(label(issue.type))}</span></td>
        ${withRequest ? `<td>${issue.status ?? ''}</td><td class="wrap">${esc([issue.method, issue.requestUrl].filter(Boolean).join(' '))}</td>` : ''}
        <td class="wrap">${esc(issue.type === 'FLOW' || issue.type === 'FORM_VALIDATION' ? reason(issue.message) : issue.message)}</td>
        <td class="wrap">${issue.stateId ? `<b>${esc(nameOf(issue.stateId))}</b>` : ''}${issue.actionId ? `<br><span class="muted">${esc(t.after)} ${esc(actionText(issue.actionId))}</span>` : ''}
          ${issue.flow && issue.flow.length > 1 ? `<div class="flow">${issue.flow.map((id) => esc(nameOf(id))).join(' → ')}</div>` : ''}</td>
        <td>${issue.occurrences}</td>
        <td>${issue.screenshot ? `<a href="${esc(href(issue.screenshot))}">${esc(t.view)}</a>` : ''}</td>
      </tr>`,
      )
      .join('');
    return `<section><h2>${esc(title)} (${issues.length})</h2><table><thead><tr><th>${c.severity}</th>${withRequest ? `<th>${c.status}</th><th>${c.request}</th>` : ''}<th>${c.message}</th><th>${c.stateActionFlow}</th><th>${c.count}</th><th>${c.shot}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  };

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.reportTitle)} — ${esc(result.mission)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <h1>${esc(result.mission)}</h1>
  <div class="meta">${esc(result.target.startUrl)} · ${esc(formatDate(result.startedAt))} · ${esc(formatDuration(result.durationMs))} · ${esc(t.stopped)} : ${esc(label(result.stopReason))} · ${esc(t.engine)} : ${esc(label(result.decisionEngine))}</div>
  ${result.description ? `<div class="meta">${esc(result.description)}</div>` : ''}
  <span class="status" style="background:${status.color}">${esc(status.label)}</span>
  <nav>${result.artifacts.flowGraphHtml ? `<a href="${esc(href(result.artifacts.flowGraphHtml))}">${esc(t.flowGraphLink)}</a>` : ''}${result.artifacts.json ? `<a href="${esc(href(result.artifacts.json))}">result.json</a>` : ''}${result.artifacts.flowGraph ? `<a href="${esc(href(result.artifacts.flowGraph))}">flow-graph.json</a>` : ''}</nav>
</header>
<main>
  <div class="cards">
    ${card(t.cards.states, result.stats.states)}
    ${card(t.cards.transitions, result.stats.transitions)}
    ${card(t.cards.actionsExecuted, result.stats.actionsExecuted)}
    ${card(t.cards.actionsBlocked, result.stats.actionsBlocked)}
    ${card(t.cards.maxDepth, result.stats.maxDepth)}
    ${card(t.cards.backtracks, result.stats.backtracks)}
    ${result.flows.length > 0 ? card(t.cards.flowsPassed, `${result.stats.flowsPassed}/${result.flows.length}`) : ''}
    ${card(t.cards.issues, result.issues.length)}
    ${SEVERITIES.slice()
      .reverse()
      .map((severity) =>
        card(label(severity), result.stats.issuesBySeverity[severity], SEVERITY_COLORS[severity]),
      )
      .join('')}
    ${card(t.cards.duration, formatDuration(result.durationMs))}
  </div>

  ${result.flows.length > 0 ? flowsSection(result, nameOf, href, t) : ''}

  ${result.browserInteractions.length > 0 ? interactionsSection(result, nameOf, t) : ''}

  <section>
    <h2>${esc(t.discoveredFlow)}</h2>
    <p class="muted">${esc(t.discoveredFlowHint)}</p>
    ${renderTreeHtml(tree, (stateId) => result.issues.filter((issue) => issue.states.includes(stateId)).length, t)}
  </section>

  ${flowIssues.length > 0 ? issueTable(t.issueSections.flow, flowIssues, false) : ''}
  ${formIssues.length > 0 ? issueTable(t.issueSections.forms, formIssues, false) : ''}
  ${issueTable(t.issueSections.http, httpIssues, true)}
  ${issueTable(t.issueSections.js, jsIssues, false)}
  ${navigationIssues.length > 0 ? issueTable(t.issueSections.navigation, navigationIssues, true) : ''}

  <section>
    <h2>${esc(t.statesTitle)} (${result.states.length})</h2>
    ${statesTable(result.states, href, t)}
  </section>

  <section>
    <h2>${esc(t.executedTitle)} (${executed.length})</h2>
    ${
      executed.length === 0
        ? `<p class="empty">${esc(t.noExecuted)}</p>`
        : `<table><thead><tr><th>${c.from}</th><th>${c.action}</th><th>${c.to}</th><th>${c.result}</th><th>${c.duration}</th></tr></thead><tbody>${executed
            .map(
              (edge) =>
                `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(label(edge.action.type))} “${esc(edge.action.text ?? edge.action.label ?? '')}” <span class="muted">${esc(label(edge.action.category))}</span></td><td>${edge.to === edge.from ? `<span class="muted">${esc(t.sameState)}</span>` : esc(nameOf(edge.to))}</td><td>${classPill(edge.result, language)}${edge.reason ? `<br><span class="muted">${esc(reason(edge.reason))}</span>` : ''}</td><td>${edge.durationMs ?? ''} ms</td></tr>`,
            )
            .join('')}</tbody></table>`
    }
  </section>

  <section>
    <h2>${esc(t.blockedTitle)} (${blocked.length})</h2>
    <p class="muted">${esc(t.blockedHint)}</p>
    ${
      blocked.length === 0
        ? `<p class="empty">${esc(t.noBlocked)}</p>`
        : `<table><thead><tr><th>${c.state}</th><th>${c.action}</th><th>${c.class}</th><th>${c.reason}</th></tr></thead><tbody>${blocked
            .map(
              (edge) =>
                `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(label(edge.action.type))} “${esc(edge.action.text ?? edge.action.label ?? '')}”</td><td>${classPill(edge.action.classification, language)}</td><td class="wrap">${esc(reason(edge.reason ?? ''))}</td></tr>`,
            )
            .join('')}</tbody></table>`
    }
  </section>

  <section>
    <h2>${esc(t.screenshotsTitle)} (${shots.length})</h2>
    ${
      shots.length === 0
        ? `<p class="empty">${esc(t.noScreenshots)}</p>`
        : `<div class="shots">${shots
            .map((state) => {
              const link = esc(href(state.screenshot ?? ''));
              return `<figure><a href="${link}"><img loading="lazy" src="${link}" alt="${esc(displayName(state))}"></a><figcaption><b>${esc(displayName(state))}</b><br>${esc(state.url)}</figcaption></figure>`;
            })
            .join('')}</div>`
    }
  </section>
  <p class="muted">${esc(t.generatedBy)} · ${esc(formatDate(result.finishedAt))}</p>
</main>
</body>
</html>
`;
}

function interactionsSection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  t: ReportTexts,
): string {
  const c = t.interactionColumns;
  const actionText = (actionId: string | undefined): string => {
    if (!actionId) return '';
    const edge = result.transitions.find((candidate) => candidate.actionId === actionId);
    return edge
      ? `${valueLabel(t.lang, edge.action.type)} “${edge.action.text ?? edge.action.label ?? ''}”`
      : actionId;
  };
  const rows = result.browserInteractions
    .map((interaction) => {
      const details = Object.entries(interaction.details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' · ');
      const target = interaction.targetStateId ? `<b>${esc(nameOf(interaction.targetStateId))}</b><br>` : '';
      return `<tr>
        <td><code>${esc(interaction.type)}</code><br><span class="muted">${esc(interaction.id)}</span></td>
        <td>${classPill(interaction.status, t.lang)}${interaction.blocking ? ' ⛔' : ''}</td>
        <td><code>${esc(interaction.outcome ?? '')}</code></td>
        <td>${esc(interaction.handler ?? '')}${interaction.action ? `<br><span class="muted">${esc(interaction.action)}</span>` : ''}${interaction.credentialProfile ? `<br><span class="muted">profile: ${esc(interaction.credentialProfile)}</span>` : ''}</td>
        <td class="wrap">${esc(interaction.originClass ?? '')}${interaction.origin ? `<br><span class="muted">${esc(interaction.origin)}</span>` : ''}</td>
        <td class="wrap">${interaction.stateId ? esc(nameOf(interaction.stateId)) : ''}${interaction.actionId ? `<br><span class="muted">${esc(actionText(interaction.actionId))}</span>` : ''}${interaction.flow ? `<br><span class="muted">flow: ${esc(interaction.flow)}</span>` : ''}</td>
        <td class="wrap">${target}${esc(interaction.targetUrl ?? '')}</td>
        <td>${interaction.attempt}${interaction.retryAttempted ? ' ↻' : ''}</td>
        <td class="wrap muted">${esc(translateReason(t.lang, interaction.reason ?? ''))}</td>
        <td class="wrap muted">${esc(details)}</td>
      </tr>`;
    })
    .join('');
  return `<section>
    <h2>${esc(t.interactionsTitle)} (${result.browserInteractions.length})</h2>
    <p class="muted">${esc(t.interactionsHint)}</p>
    <table><thead><tr><th>${c.type}</th><th>${c.status}</th><th>${c.outcome}</th><th>${c.handler}</th><th>${c.origin}</th><th>${c.source}</th><th>${c.target}</th><th>${c.attempt}</th><th>${c.reason}</th><th>${c.details}</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

function flowsSection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  href: (file: string) => string,
  t: ReportTexts,
): string {
  const c = t.columns;
  const runs = result.flows
    .map((flow) => {
      const rows = flow.steps
        .map(
          (step) =>
            `<tr><td>${step.index}</td><td class="wrap"><code>${esc(step.description)}</code>${step.optional ? ` <span class="muted">${esc(t.optional)}</span>` : ''}</td><td>${step.classification ? classPill(step.classification, t.lang) : ''}</td><td>${classPill(step.status, t.lang)}</td><td class="wrap muted">${esc(translateReason(t.lang, step.reason ?? ''))}${suggestionBlock(step, t)}</td><td class="wrap">${step.stateId ? esc(nameOf(step.stateId)) : ''}</td><td>${step.durationMs} ms</td><td>${step.screenshot ? `<a href="${esc(href(step.screenshot))}">${esc(t.view)}</a>` : ''}</td></tr>`,
        )
        .join('');
      return `<div class="flow-run"><h3>${esc(flow.name)} ${classPill(flow.status, t.lang)} <span class="muted">${esc(formatDuration(flow.durationMs))}${flow.explored ? ` · ${esc(t.lastScreenExplored)}` : ''}</span></h3>
      ${flow.description ? `<p class="muted">${esc(flow.description)}</p>` : ''}
      <table><thead><tr><th>#</th><th>${c.step}</th><th>${c.class}</th><th>${c.result}</th><th>${c.reason}</th><th>${c.state}</th><th>${c.duration}</th><th>${c.shot}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');
  return `<section>
    <h2>${esc(t.flowsTitle)} (${result.flows.length})</h2>
    <p class="muted">${t.flowsHint}</p>
    ${runs}
  </section>`;
}

/** Element not found: the steps found on the screen, ready to paste, and what the screen shows. */
function suggestionBlock(step: ExplorationResult['flows'][number]['steps'][number], t: ReportTexts): string {
  const parts: string[] = [];
  if (step.suggestions && step.suggestions.length > 0)
    parts.push(
      `<div class="suggest"><b>${esc(t.suggestion)}</b><pre>${esc(step.suggestions.join('\n'))}</pre></div>`,
    );
  if (step.onScreen && step.onScreen.length > 0)
    parts.push(
      `<div class="suggest">${esc(t.onScreen)} ${step.onScreen.map((label) => `<code>${esc(label)}</code>`).join(' · ')}</div>`,
    );
  return parts.join('');
}

function statesTable(states: StateReport[], href: (file: string) => string, t: ReportTexts): string {
  if (states.length === 0) return `<p class="empty">${esc(t.noState)}</p>`;
  const c = t.columns;
  const rows = states
    .map((state) => {
      const counts = new Map<string, number>();
      for (const action of state.actionsDetail)
        counts.set(action.classification, (counts.get(action.classification) ?? 0) + 1);
      const actions = [...counts.entries()]
        .map(([classification, count]) => `${classPill(classification, t.lang)} ${count}`)
        .join(' ');
      const details = state.actionsDetail
        .map(
          (action) =>
            `<tr><td>${classPill(action.classification, t.lang)}</td><td>${esc(valueLabel(t.lang, action.type))}</td><td>${esc(valueLabel(t.lang, action.category))}</td><td class="wrap">${esc(action.text ?? action.label ?? action.name ?? t.noLabel)}</td><td class="wrap"><code>${esc(describe(action.locator))}</code></td><td class="wrap muted">${esc(translateReason(t.lang, action.reason))}</td></tr>`,
        )
        .join('');
      return `<tr>
        <td class="wrap"><b>${esc(displayName(state))}</b><br><span class="muted">${esc(state.id)}</span></td>
        <td class="wrap">${esc(state.url)}<br><code>${esc(state.route)}</code></td>
        <td>${state.depth}</td>
        <td>${actions}${details ? `<details><summary>${esc(t.actionCount(state.actionsDetail.length))}</summary><table><thead><tr><th>${c.class}</th><th>${c.type}</th><th>${c.category}</th><th>${c.label}</th><th>${c.locator}</th><th>${c.reason}</th></tr></thead><tbody>${details}</tbody></table></details>` : ''}</td>
        <td>${state.forms.filter((form) => form.index >= 0).length}</td>
        <td>${state.issueIds.length}</td>
        <td>${state.screenshot ? `<a href="${esc(href(state.screenshot))}">${esc(t.view)}</a>` : ''}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr><th>${c.state}</th><th>${c.urlRoute}</th><th>${c.depth}</th><th>${c.actions}</th><th>${c.forms}</th><th>${c.issues}</th><th>${c.shot}</th></tr></thead><tbody>${rows}</tbody></table>`;
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

function overallStatus(counts: Record<Severity, number>, t: ReportTexts): { label: string; color: string } {
  if (counts.CRITICAL > 0) return { label: t.status.critical, color: SEVERITY_COLORS.CRITICAL };
  if (counts.ERROR > 0) return { label: t.status.errors, color: SEVERITY_COLORS.ERROR };
  if (counts.WARNING > 0) return { label: t.status.warnings, color: SEVERITY_COLORS.WARNING };
  return { label: t.status.none, color: '#15803d' };
}
