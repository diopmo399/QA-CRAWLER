import { redactText } from '../security/redactor.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult, StateReport } from '../model/exploration-result.js';
import type { FlowStepReport } from '../model/flow-run.js';
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
  issuesCard,
  layoutSections,
  renderTreeHtml,
  type ReportSection,
  severityBadge,
  SEVERITY_COLORS,
} from './html-common.js';
import { reportTexts, translateReason, valueLabel, type ReportLanguage, type ReportTexts } from './i18n.js';
import {
  authorizationSection,
  dataSection,
  formsSection,
  oraclesSection,
  qualityTexts,
  recoverySection,
} from './quality-sections.js';
import { renderFlowMap, renderFlowSteps } from './flow-diagram.js';
import { intelligenceSection } from './intelligence-section.js';
import { persistenceSection } from './persistence-section.js';
import { staticAnalysisSection } from './static-section.js';
import { rulesSection } from './rules-section.js';
import { functionalSection } from './functional-section.js';
import { aiSection } from './ai-section.js';
import { cognitiveSection } from './cognitive-section.js';
import { regressionSection } from './regression-section.js';
import { driftLines, healingMetrics, recoveryLines } from '../workflow-healing/explain.js';

export { esc } from './html-common.js';

/** reports/index.html — rapport statique et autonome (sans JavaScript ni ressource externe). */
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

/** Chemin d'un fichier relatif au rapport, pour publier rapports et captures ensemble. */
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
  const oracleIssues = bySeverity.filter((issue) =>
    ['UI_ERROR', 'REGRESSION', 'CONTRACT'].includes(issue.type),
  );
  const accessibilityIssues = bySeverity.filter((issue) => issue.type === 'ACCESSIBILITY');
  const authorizationIssues = bySeverity.filter((issue) => issue.type === 'AUTHORIZATION');
  const q = qualityTexts(language);
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
      return `<section><h2>${esc(title)}</h2><p class="empty ok">${esc(t.noneDetected)}</p></section>`;
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

  const alerting = (html: string, issues: Issue[]): ReportSection => ({ html, alert: issues.length > 0 });
  const layout = layoutSections(
    [
      {
        title: t.layout.results,
        collapsed: false,
        sections: [
          result.flows.length > 0 ? flowsSection(result, nameOf, href, t) : '',
          result.verification ? verificationSection(result, t) : '',
          result.flowDiff ? flowDiffSection(result, t) : '',
          alerting(issueTable(t.issueSections.http, httpIssues, true), httpIssues),
          alerting(issueTable(t.issueSections.js, jsIssues, false), jsIssues),
          flowIssues.length > 0
            ? alerting(issueTable(t.issueSections.flow, flowIssues, false), flowIssues)
            : '',
          formIssues.length > 0
            ? alerting(issueTable(t.issueSections.forms, formIssues, false), formIssues)
            : '',
          navigationIssues.length > 0
            ? alerting(issueTable(t.issueSections.navigation, navigationIssues, true), navigationIssues)
            : '',
          oracleIssues.length > 0
            ? alerting(issueTable(q.oracleFindings, oracleIssues, false), oracleIssues)
            : '',
          accessibilityIssues.length > 0
            ? alerting(issueTable(q.accessibility, accessibilityIssues, false), accessibilityIssues)
            : '',
          authorizationIssues.length > 0
            ? alerting(issueTable(q.authorizationIssues, authorizationIssues, false), authorizationIssues)
            : '',
        ],
      },
      {
        title: t.layout.exploration,
        collapsed: false,
        sections: [
          `<section>
    <h2>${esc(t.discoveredFlow)}</h2>
    <p class="muted">${esc(t.discoveredFlowHint)}</p>
    ${renderFlowMap(result, language)}
    ${renderTreeHtml(tree, (stateId) => result.issues.filter((issue) => issue.states.includes(stateId)).length, t)}
  </section>`,
          `<section>
    <h2>${esc(t.statesTitle)} (${result.states.length})</h2>
    ${statesTable(result.states, href, t)}
  </section>`,
          `<section>
    <h2>${esc(t.executedTitle)} (${executed.length})</h2>
    ${
      executed.length === 0
        ? `<p class="empty">${esc(t.noExecuted)}</p>`
        : `<table><thead><tr><th>${c.from}</th><th>${c.action}</th><th>${c.to}</th><th>${c.result}</th><th>${c.duration}</th></tr></thead><tbody>${executed
            .map(
              (edge) =>
                `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(label(edge.action.type))} “${esc(edge.action.text ?? edge.action.label ?? '')}” <span class="muted">${esc(label(edge.action.category))}</span></td><td>${edge.to === edge.from ? `<span class="muted">${esc(t.sameState)}</span>` : esc(nameOf(edge.to))}</td><td>${classPill(edge.result, language)}${edge.reason ? `<br><span class="muted">${esc(reason(edge.reason))}</span>` : ''}</td><td>${edge.durationMs !== undefined ? `${edge.durationMs} ms` : ''}</td></tr>`,
            )
            .join('')}</tbody></table>`
    }
  </section>`,
          `<section>
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
  </section>`,
          `<section>
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
  </section>`,
        ],
      },
      {
        title: t.layout.analysis,
        hint: t.layout.analysisHint,
        collapsed: true,
        sections: [
          intelligenceSection(result, nameOf, language),
          regressionSection(result, language),
          persistenceSection(result, language),
          staticAnalysisSection(result, language),
          rulesSection(result, language),
          functionalSection(result, language),
          cognitiveSection(result, language),
          aiSection(result, language),
          oraclesSection(result, nameOf, language),
          formsSection(result, nameOf, language),
          authorizationSection(result, language),
          recoverySection(result, nameOf, language),
          dataSection(result, nameOf, language),
          result.browserInteractions.length > 0 ? interactionsSection(result, nameOf, t) : '',
        ],
      },
    ],
    t.layout.contents,
  );

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
  <div class="hero">
    <div class="eyebrow">${esc(t.reportTitle)}</div>
    <div class="hero-title"><h1>${esc(result.mission)}</h1><span class="status" style="--status:${status.color}">${esc(status.label)}</span></div>
    ${result.description ? `<p class="hero-desc">${esc(result.description)}</p>` : ''}
    <div class="chips">
      <span class="chip url">${esc(result.target.startUrl)}</span>
      <span class="chip">${esc(formatDate(result.startedAt))}</span>
      <span class="chip">${esc(formatDuration(result.durationMs))}</span>
      <span class="chip"><span>${esc(t.stopped)}</span> ${esc(label(result.stopReason))}</span>
      <span class="chip"><span>${esc(t.engine)}</span> ${esc(label(result.decisionEngine))}</span>
      <span class="chip"><span>${esc(t.baselineTexts.mode)}</span> ${esc(label(result.mode))}</span>
      ${result.baseline ? `<span class="chip"><span>${esc(t.baselineTexts.baseline)}</span> ${esc(baselineName(result.baseline))}</span>` : ''}
      ${result.learnedBaseline ? `<span class="chip"><span>${esc(t.baselineTexts.learned)}</span> ${esc(baselineName(result.learnedBaseline))}</span>` : ''}
    </div>
    <nav class="links">${result.artifacts.flowGraphHtml ? `<a class="primary" href="${esc(href(result.artifacts.flowGraphHtml))}">${esc(t.flowGraphLink)}</a>` : ''}${result.artifacts.json ? `<a href="${esc(href(result.artifacts.json))}">result.json</a>` : ''}${result.artifacts.flowGraph ? `<a href="${esc(href(result.artifacts.flowGraph))}">flow-graph.json</a>` : ''}${result.artifacts.engineLog ? `<a href="${esc(href(result.artifacts.engineLog))}">${esc(q.engineLog)}</a>` : ''}</nav>
  </div>
</header>
<div class="layout">
<div class="summary">
  <div class="cards">
    ${issuesCard(t.cards.issues, result.stats.issuesBySeverity, label)}
    ${SEVERITIES.slice()
      .reverse()
      .map((severity) =>
        card(label(severity), result.stats.issuesBySeverity[severity], SEVERITY_COLORS[severity]),
      )
      .join('')}
    ${result.flows.length > 0 ? card(t.cards.flowsPassed, `${result.stats.flowsPassed}/${result.flows.length}`) : ''}
  </div>
  <div class="cards secondary">
    ${card(t.cards.states, result.stats.states)}
    ${card(t.cards.transitions, result.stats.transitions)}
    ${card(t.cards.actionsExecuted, result.stats.actionsExecuted)}
    ${card(t.cards.actionsBlocked, result.stats.actionsBlocked)}
    ${card(t.cards.maxDepth, result.stats.maxDepth)}
    ${card(t.cards.backtracks, result.stats.backtracks)}
    ${card(t.cards.duration, formatDuration(result.durationMs))}
  </div>
</div>
${layout.toc}
<main>

  ${layout.body}
  <p class="muted report-footer">${esc(t.generatedBy)} · ${esc(formatDate(result.finishedAt))}</p>
</main>
</div>
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
            `<tr><td>${step.index}</td><td class="wrap"><code>${esc(step.description)}</code>${step.interpretation ? `<div class="muted">↳ ${esc(step.interpretation)}</div>` : ''}${step.optional ? ` <span class="muted">${esc(t.optional)}</span>` : ''}</td><td>${step.classification ? classPill(step.classification, t.lang) : ''}</td><td>${classPill(step.status, t.lang)}</td><td class="wrap muted">${esc(translateReason(t.lang, step.reason ?? ''))}${suggestionBlock(step, t)}${synchronizationBlock(step)}${effectBlock(step)}${recoveryBlock(step)}${targetResolutionBlock(step)}</td><td class="wrap">${step.stateId ? esc(nameOf(step.stateId)) : ''}</td><td>${step.durationMs} ms</td><td>${step.screenshot ? `<a href="${esc(href(step.screenshot))}">${esc(t.view)}</a>` : ''}</td></tr>`,
        )
        .join('');
      return `<div class="flow-run"><h3>${esc(flow.name)} ${classPill(flow.status, t.lang)} <span class="muted">${esc(formatDuration(flow.durationMs))}${flow.explored ? ` · ${esc(t.lastScreenExplored)}` : ''}</span></h3>
      ${flow.description ? `<p class="muted">${esc(flow.description)}</p>` : ''}
      ${
        flow.divergence
          ? `<p><b>Root divergence: step ${String(flow.divergence.stepIndex)}</b> — ${esc(flow.divergence.description)}${flow.divergence.symptomStep !== undefined ? ` <span class="muted">(symptom at step ${String(flow.divergence.symptomStep)})</span>` : ''}${flow.divergence.probableCause ? ` · probable cause <b>${esc(flow.divergence.probableCause.category)}</b> (${String(flow.divergence.probableCause.confidence)})` : ''}<br><span class="muted">${esc(flow.divergence.reason)}${flow.divergence.lastConfirmedStep !== undefined ? ` · last confirmed checkpoint: step ${String(flow.divergence.lastConfirmedStep)}` : ''}</span></p>`
          : ''
      }
      ${
        flow.drift && (flow.drift.detected || flow.drift.result !== 'PASS_EXACT')
          ? `<div class="suggest"><b>Flow drift</b><pre>${esc(driftLines(flow.drift).join('\n'))}</pre></div>`
          : ''
      }
      ${renderFlowSteps(flow)}
      <table><thead><tr><th>#</th><th>${c.step}</th><th>${c.class}</th><th>${c.result}</th><th>${c.reason}</th><th>${c.state}</th><th>${c.duration}</th><th>${c.shot}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');
  const metrics = healingMetrics(result.flows);
  const healing =
    metrics.recoveryAttempts > 0 || metrics.flowsWithDrift > 0
      ? `<p class="muted">Workflow self-healing: ${String(metrics.recoveryAttempts)} recovery attempt(s), ${String(metrics.successfulRecoveries)} successful, ${String(metrics.failedRecoveries)} failed · average depth ${String(metrics.averageRecoveryDepth)} · static knowledge used ${String(metrics.staticKnowledgeUsed)} · history used ${String(metrics.historicalRecoveryUsed)} · flows with drift ${String(metrics.flowsWithDrift)}</p>`
      : '';
  return `<section>
    <h2>${esc(t.flowsTitle)} (${result.flows.length})</h2>
    <p class="muted">${t.flowsHint}</p>
    ${healing}
    ${runs}
  </section>`;
}

/**
 * SYNCHRONIZATION : exécution → transition → stabilité → préparation de la suite. Distingue d'un
 * coup d'œil un problème de localisateur, de transition, d'effet fonctionnel ou une régression.
 */
function synchronizationBlock(step: FlowStepReport): string {
  const sync = step.synchronization;
  if (!sync) return '';
  const lines = [
    `execution: ${esc(sync.execution)} · transition: <b>${esc(sync.transition)}</b> (${String(sync.durationMs)} ms)`,
    `stability: ${sync.stability.stable ? `STABLE ${String(sync.stability.durationMs)} ms` : 'NOT STABLE'} · next action: ${esc(sync.nextAction)}`,
    ...(sync.signals.length > 0 ? [`signals: ${sync.signals.map(esc).join(' · ')}`] : []),
    ...(sync.missing.length > 0 ? [`missing: ${sync.missing.map(esc).join(' · ')}`] : []),
    ...(sync.reacquired ? [`reacquired after rerender: ${esc(sync.reacquired)}`] : []),
  ];
  return `<div class="muted">${lines.join('<br>')}</div>`;
}

/** EXECUTED ≠ CONFIRMED : l'effet de l'étape (attendu / observé), la cible vérifiée, la récupération. */
function effectBlock(step: FlowStepReport): string {
  const effect = step.effect;
  if (!effect || effect.status === 'NOT_VERIFIED') return '';
  const lines = [
    `effect: <b>${esc(effect.status)}</b> (execution ${esc(effect.execution)})`,
    ...(effect.locator ? [`locator: ${esc(effect.locator)}`] : []),
    ...(effect.targetMatch
      ? [`target match: ${esc(effect.targetMatch.verdict)} ${String(effect.targetMatch.score)}`]
      : []),
    ...(effect.healed ? [`healed: ${esc(effect.healed.from)} → ${esc(effect.healed.to)}`] : []),
    ...(effect.expected.length > 0 ? [`expected: ${effect.expected.map(esc).join(', ')}`] : []),
    ...(effect.observed.length > 0 ? [`observed: ${effect.observed.map(esc).join(', ')}`] : []),
    ...(effect.recovery.length > 0 ? [`recovery: ${effect.recovery.map(esc).join(' · ')}`] : []),
    ...(step.recordingModelDivergence
      ? [
          `<b>recording-model divergence</b>: ${esc(step.recordingModelDivergence.classification)} — suspect expectations ${step.recordingModelDivergence.suspectEffects.map(esc).join(', ')} (not an application divergence)`,
        ]
      : []),
  ];
  return `<div class="muted">${lines.join('<br>')}</div>`;
}

/** WORKFLOW SELF-HEALING : divergence, objectif, candidats, choix, preuve (WHY DID YOU CHOOSE THIS?). */
function recoveryBlock(step: FlowStepReport): string {
  if (!step.recovery) return '';
  return `<details class="suggest"><summary><b>Workflow recovery: ${esc(step.recovery.outcome.status)}</b> · ${esc(step.recovery.divergence.category)}</summary><pre>${esc(recoveryLines(step.recovery).join('\n'))}</pre></details>`;
}

/**
 * TARGET RESOLUTION : cible enregistrée / runtime, empreinte, identité fonctionnelle, re-rendu,
 * avant / courante / après, préconditions, candidats et scores, conseiller, décision, effet, statut.
 */
function targetResolutionBlock(step: FlowStepReport): string {
  const trace = step.targetResolution;
  if (!trace) return '';
  const badges = [
    trace.rerender.detected ? 'RERENDERED' : undefined,
    trace.status === 'TARGET_FUNCTIONALLY_EQUIVALENT' || trace.status === 'TARGET_RERENDERED'
      ? 'FUNCTIONALLY_EQUIVALENT'
      : undefined,
    trace.status === 'TARGET_HEALED' ? 'HEALED' : undefined,
    trace.ai.outcome === 'VALIDATED' ? 'AI_ASSISTED' : undefined,
    trace.decision === 'AMBIGUOUS' && !trace.resolution ? 'AMBIGUOUS' : undefined,
    trace.evidenceStatus === 'CONTRADICTORY_EVIDENCE' ? 'CONTRADICTORY_EVIDENCE' : undefined,
    trace.ai.rejection ? trace.ai.rejection : undefined,
    trace.runtimeVerification?.status === 'CONFIRMED' ? 'RUNTIME_CONFIRMED' : undefined,
    trace.runtimeVerification?.status === 'REJECTED' ? 'RUNTIME_REJECTED' : undefined,
  ].filter((badge): badge is string => badge !== undefined);
  const rows: [string, string][] = [
    ['Recorded target', trace.recorded.locator],
    [
      'Runtime target',
      `${trace.runtime.locator} (fingerprint ${trace.runtime.fingerprintVerdict}: ${trace.runtime.reasons.join('; ')})`,
    ],
    [
      'Functional identity',
      `${trace.identity.businessConcept ?? trace.identity.semanticRole}${trace.identity.section ? ` · section ${trace.identity.section}` : ''}`,
    ],
    ['Rerender detected', trace.rerender.detected ? `yes — ${trace.rerender.evidence.join('; ')}` : 'no'],
    [
      'Previous actions',
      trace.temporal.previousActions
        .map((action) => `${action.type} ${action.target}${action.value ? ` = ${action.value}` : ''}`)
        .join(' → ') || '—',
    ],
    [
      'Current action',
      `${trace.temporal.currentAction.type} (${trace.temporal.currentAction.semanticIntent})`,
    ],
    [
      'Next actions',
      trace.temporal.nextActions.map((action) => `${action.type} ${action.target}`).join(' → ') || '—',
    ],
    ['Preconditions', trace.temporal.preconditions.join(', ')],
    [
      'Candidates',
      trace.candidates
        .map(
          (candidate) =>
            `${candidate.id} ${String(candidate.score)}${candidate.source ? ` [${candidate.source}]` : ''}${candidate.rejected ? ` (rejected: ${candidate.rejected})` : ''} — ${candidate.summary}${candidate.positive && candidate.positive.length > 0 ? `\n   + ${candidate.positive.join(', ')}` : ''}${candidate.negative && candidate.negative.length > 0 ? `\n   − ${candidate.negative.join('\n   − ')}` : ''}`,
        )
        .join('\n') || 'none',
    ],
    ...(trace.evidenceStatus ? [['Evidence', trace.evidenceStatus] as [string, string]] : []),
    ...(trace.scanError ? [['Scan error', trace.scanError] as [string, string]] : []),
    [
      'AI',
      trace.ai.requested
        ? `${trace.ai.trigger ? `trigger ${trace.ai.trigger} · ` : ''}${trace.ai.outcome ?? 'requested'}${trace.ai.proposal ? ` · proposal ${trace.ai.proposal}` : ''}${trace.ai.confidence !== undefined ? ` · confidence ${String(trace.ai.confidence)}` : ''}${trace.ai.rejection ? ` · ${trace.ai.rejection}` : ''}${trace.ai.citedEvidence ? ` · evidence ${trace.ai.citedEvidence.join(' ')}` : ''}`
        : trace.ai.trigger
          ? `not called (${trace.ai.trigger}; intelligence off or not triggered)`
          : 'not required',
    ],
    ['Decision', `${trace.resolution ?? trace.decision} — ${trace.reason}`],
    [
      'Runtime effect',
      trace.runtimeVerification
        ? `${trace.runtimeVerification.status} — ${trace.runtimeVerification.detail}`
        : 'not executed',
    ],
    ['Final status', `${trace.status}${trace.final ? ` → ${trace.final}` : ''}`],
  ];
  return `<details class="suggest"><summary><b>Target resolution: ${esc(trace.status)}</b>${badges.map((badge) => ` <code>${esc(badge)}</code>`).join('')}</summary><table>${rows
    .map(([label, value]) => `<tr><th>${esc(label)}</th><td><pre>${esc(value)}</pre></td></tr>`)
    .join('')}</table></details>`;
}

/** Élément introuvable : les étapes trouvées à l'écran, prêtes à coller, et ce que montre l'écran. */
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
  const resolution = step.resolution;
  if (resolution) {
    // L'explication : l'intention, la cible, la confiance, les raisons, les autres candidats — jamais une valeur.
    const lines = resolution.explanation ?? [
      `Intent: ${resolution.intent}`,
      `Status: ${resolution.status}${resolution.selected ? ` → "${resolution.selected}"` : ''} · Confidence: ${resolution.score} ${resolution.confidence}`,
      ...resolution.reasons.map((reason) => `  ${reason}`),
    ];
    parts.push(
      `<details class="suggest"><summary>${esc(t.resolution)} : ${esc(resolution.status)}${resolution.selected ? ` → ${esc(resolution.selected)}` : ''} · ${resolution.score} ${esc(resolution.confidence)}</summary><pre>${esc(lines.map((line) => redactText(line)).join('\n'))}</pre></details>`,
    );
  }
  return parts.join('');
}

/** "2026-09-27T10-32-05Z-1a2b3c4 (main, qa)" */
function baselineName(metadata: NonNullable<ExplorationResult['baseline']>): string {
  const details = [metadata.branch, metadata.commit?.slice(0, 7), metadata.environment].filter(Boolean);
  return details.length > 0 ? `${metadata.runId} (${details.join(', ')})` : metadata.runId;
}

/** verify : chaque transition connue rejouée, les régressions d'abord. */
function verificationSection(result: ExplorationResult, t: ReportTexts): string {
  const verification = result.verification;
  if (!verification) return '';
  const b = t.baselineTexts;
  const c = t.columns;
  const order = ['FAILED', 'UNREACHABLE', 'ACTION_MISSING', 'CHANGED', 'BLOCKED', 'SKIPPED', 'PASSED'];
  const rows = [...verification.transitions]
    .sort((a, z) => order.indexOf(a.status) - order.indexOf(z.status))
    .map(
      (v) =>
        `<tr><td>${classPill(v.status, t.lang)}</td><td>${esc(v.fromLabel)}</td><td class="wrap">${esc(valueLabel(t.lang, v.action.type))} “${esc(v.action.text ?? v.action.href ?? '')}”</td><td>${esc(v.expectedToLabel)}</td><td>${esc(v.actualToLabel ?? '')}</td><td class="wrap muted">${esc(translateReason(t.lang, v.reason ?? ''))}${networkBlock(v.network)}</td></tr>`,
    )
    .join('');
  const counts = Object.entries(verification.summary)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${classPill(status, t.lang)} ${count}`)
    .join(' ');
  return `<section><h2>${esc(b.verificationTitle)} — ${verification.regressions} ${esc(b.regressions)}</h2>
    <p class="muted">${esc(b.verificationHint)}</p><p>${counts}</p>
    <table><thead><tr><th>${c.result}</th><th>${c.from}</th><th>${c.action}</th><th>${esc(b.expected)}</th><th>${esc(b.actual)}</th><th>${c.reason}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** FLOW DIFF : ce qui est nouveau, disparu ou modifié par rapport à la baseline. */
function flowDiffSection(result: ExplorationResult, t: ReportTexts): string {
  const diff = result.flowDiff;
  if (!diff) return '';
  const b = t.baselineTexts;
  const hint =
    result.mode === 'verify'
      ? b.diffHintVerify
      : result.mode === 'learn'
        ? b.diffHintLearn
        : b.diffHintExplore;
  const list = (title: string, sign: string, items: string[]): string =>
    items.length === 0
      ? ''
      : `<h3>${esc(title)} (${items.length})</h3><pre class="diff">${esc(items.map((item) => `${sign} ${item}`).join('\n'))}</pre>`;
  const transition = (x: {
    fromLabel: string;
    toLabel: string;
    action: { type: string; text?: string; href?: string };
  }): string => `${x.fromLabel} → "${x.action.text ?? x.action.href ?? x.action.type}" → ${x.toLabel}`;
  const changed =
    diff.changedTransitions.length === 0
      ? ''
      : `<h3>${esc(b.changedTransitions)} (${diff.changedTransitions.length})</h3><pre class="diff">${esc(
          diff.changedTransitions
            .map(
              (x) =>
                `~ ${x.fromLabel} → "${x.action.text ?? x.action.href ?? x.action.type}"\n${x.changes.map((line) => `    ${line}`).join('\n')}`,
            )
            .join('\n'),
        )}</pre>`;
  const body =
    list(
      b.addedStates,
      '+',
      diff.addedStates.map((s) => `${s.label} (${s.route})`),
    ) +
    list(b.addedTransitions, '+', diff.addedTransitions.map(transition)) +
    list(
      b.removedStates,
      '-',
      diff.removedStates.map((s) => `${s.label} (${s.route})`),
    ) +
    list(b.removedTransitions, '-', diff.removedTransitions.map(transition)) +
    changed;
  return `<section><h2>${esc(b.diffTitle)}</h2><p class="muted">${esc(hint)}</p>${body || `<p class="empty">${esc(b.noDifference)}</p>`}</section>`;
}

function networkBlock(network: ExplorationResult['transitions'][number]['network']): string {
  if (!network || network.length === 0) return '';
  const lines = network.map((x) => {
    let path = x.url;
    try {
      const url = new URL(x.url);
      path = `${url.pathname}${url.search}`;
    } catch {
      // garder l'URL telle qu'enregistrée
    }
    return `${x.method} ${path} ${x.status ?? x.failure ?? '…'}${x.durationMs !== undefined ? ` ${x.durationMs} ms` : ''}`;
  });
  return `<pre class="network">${esc(lines.join('\n'))}</pre>`;
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
