import type { ScenarioConfig } from '../config/config.js';
import type { ExplorationOutcome } from '../explorer/flow-explorer.js';
import { ACTION_CLASSIFICATIONS, type ActionClassification } from '../model/discovered-action.js';
import type { ExplorationResult, StateReport } from '../model/exploration-result.js';
import { ISSUE_TYPES, SEVERITIES, type IssueType, type Severity } from '../model/issue.js';
import { redactUrl } from '../security/redactor.js';

/** Turns what the explorer learned into the report model (result.json, index.html). */
export function buildResult(outcome: ExplorationOutcome, config: ScenarioConfig): ExplorationResult {
  const { graph } = outcome;
  // Shortest path known at the end of the run: the easiest way to reproduce each anomaly.
  const issues = outcome.issues.map((issue) =>
    issue.stateId && graph.hasNode(issue.stateId) ? { ...issue, flow: graph.flowTo(issue.stateId) } : issue,
  );
  const nodes = graph.allNodes();
  const edges = graph.allEdges();

  const states: StateReport[] = nodes.map((node) => {
    const detail = outcome.details.get(node.id);
    return {
      ...node,
      actionsDetail: detail?.actions ?? [],
      forms: detail?.forms ?? [],
      flow: graph.flowTo(node.id),
    };
  });

  const issuesBySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
    Severity,
    number
  >;
  const issuesByType = Object.fromEntries(ISSUE_TYPES.map((type) => [type, 0])) as Record<IssueType, number>;
  for (const issue of issues) {
    issuesBySeverity[issue.severity] += 1;
    issuesByType[issue.type] += 1;
  }
  const actionsByClassification = Object.fromEntries(
    ACTION_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<ActionClassification, number>;
  for (const state of states) {
    for (const action of state.actionsDetail) actionsByClassification[action.classification] += 1;
  }

  const { exploration, goals, safety, checks, http, browser, auth, report } = config;
  return {
    mission: config.mission.name,
    ...(config.mission.description ? { description: config.mission.description } : {}),
    target: { baseUrl: redactUrl(config.target.baseUrl), startUrl: outcome.startUrl },
    startedAt: outcome.startedAt.toISOString(),
    finishedAt: outcome.finishedAt.toISOString(),
    durationMs: outcome.finishedAt.getTime() - outcome.startedAt.getTime(),
    stopReason: outcome.stopReason,
    decisionEngine: outcome.decisionEngine,
    stats: {
      states: nodes.length,
      transitions: edges.filter((edge) => edge.result === 'SUCCESS' && edge.from !== edge.to).length,
      actionsExecuted: outcome.actionsExecuted,
      actionsSucceeded: graph.countEdges('SUCCESS'),
      actionsFailed: graph.countEdges('FAILED'),
      actionsBlocked: graph.countEdges('BLOCKED'),
      backtracks: outcome.backtracks,
      maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
      issuesBySeverity,
      issuesByType,
      actionsByClassification,
      formsFound: states.reduce(
        (total, state) => total + state.forms.filter((form) => form.index >= 0).length,
        0,
      ),
      flowsPassed: outcome.flows.filter((flow) => flow.status === 'PASSED').length,
      flowsFailed: outcome.flows.filter((flow) => flow.status === 'FAILED' || flow.status === 'BLOCKED')
        .length,
      interactionsByType: countBy(outcome.interactions.map((interaction) => interaction.type)),
      interactionsByStatus: countBy(outcome.interactions.map((interaction) => interaction.status)),
    },
    states,
    transitions: edges,
    flows: outcome.flows,
    browserInteractions: outcome.interactions,
    issues,
    settings: {
      exploration,
      goals,
      safety: { ...safety },
      checks,
      http,
      browser: { headless: browser.headless, viewport: browser.viewport },
      auth: { type: auth.type },
      failOnSeverity: report.failOnSeverity,
      browserInteractions: {
        ...config.browserInteractions,
        // Prompt answers are mission data: only their match is reported.
        dialogs: {
          ...config.browserInteractions.dialogs,
          promptValues: config.browserInteractions.dialogs.promptValues.map((entry) => ({
            match: entry.match,
          })),
        },
      },
      credentialProfiles: Object.keys(config.credentials),
      flows: config.flows.map((flow) => ({
        name: flow.name,
        steps: flow.steps.length,
        thenExplore: flow.thenExplore,
      })),
    },
    artifacts: {},
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
