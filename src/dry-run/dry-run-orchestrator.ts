import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScenarioConfig } from '../config/config.js';
import { knowledgeFileOf } from '../knowledge/json-knowledge-base.js';
import { slug } from '../knowledge/signatures.js';
import { EngineEventLog } from '../logging/engine-log.js';
import { runMission, type RunOptions } from '../orchestrator.js';
import { loadSemantics } from '../semantics/domain-packs.js';
import { DryRunEngine, type DryRunEvent, type DryRunOutcome } from './dry-run-engine.js';
import { dryRunHtml } from './dry-run-report.js';
import type { FlowIntentGraph } from './flow-intent-graph.js';
import { reconcile } from './flow-reconciliation.js';
import type { DryRunStatus, Reconciliation, SuggestedFlowGraph } from './reconciliation-model.js';
import { loadDryRunScenario, type DryRunInput } from './scenario-input.js';
import { buildSuggestedFlow, suggestedFeature, suggestedFlowYaml } from './suggested-flow.js';

export type DryRunOutputFormat = 'gherkin' | 'yaml' | 'both';

export interface DryRunRequest extends DryRunInput {
  /** true / false : forcer l'usage des chemins historiques (sinon dryRun.useHistoricalKnowledge). */
  useHistory?: boolean;
  /** true : une mémoire propre à ce Dry Run (sinon : le fichier de connaissances commun aux runs de la mission). */
  isolatedMemory?: boolean;
  maxDepth?: number;
  maxActions?: number;
  maxDurationMs?: number;
  /** Formats du flow suggéré (sinon dryRun.suggestion). */
  outputFormat?: DryRunOutputFormat;
  onEvent?: (event: DryRunEvent) => void;
  /** Options de runMission (observation, environnement, listener…). */
  run?: Omit<RunOptions, 'dryRun' | 'mode'>;
}

export interface DryRunFlowResult {
  graph: FlowIntentGraph;
  outcome: DryRunOutcome;
  reconciliation: Reconciliation;
  suggested: SuggestedFlowGraph;
  directory: string;
  /** Fichiers écrits, par nom. */
  files: Record<string, string>;
}

export interface DryRunResult {
  flows: DryRunFlowResult[];
  /** Le pire statut des flows. */
  status: DryRunStatus;
  directory: string;
  warnings: string[];
}

const STATUS_ORDER: DryRunStatus[] = [
  'FULLY_MATCHED',
  'PARTIALLY_MATCHED',
  'INCONCLUSIVE',
  'DIVERGED',
  'BLOCKED',
];

/**
 * DRY RUN ORCHESTRATOR : charger → normaliser (FlowIntentGraph) → ouvrir le navigateur
 * (connexion, mémoire, KnowledgeBase : la mise en place de runMission) → confronter chaque
 * flow à l'application (DryRunEngine) → réconcilier → suggérer → écrire les rapports.
 *
 * Le fichier du scénario est seulement lu. Tout est écrit sous
 * `<reportsDir>/dry-run/<scénario>/` : expected-flow.json, observed-flow.json,
 * suggested-flow.json, reconciliation.json, suggested.feature, suggested.flow.yaml,
 * dry-run-events.jsonl, index.html (et exploration/ : le rapport du run sous-jacent).
 */
export async function runDryRun(request: DryRunRequest): Promise<DryRunResult> {
  const loaded = loadDryRunScenario(request);
  const base = scenarioName(request.scenarioFile);
  const directory = path.join(loaded.config.output.reportsDir, 'dry-run', base);
  const config = dryRunConfig(loaded.config, request, directory);
  const log = new EngineEventLog('INFO');
  const onEvent = (event: DryRunEvent): void => {
    log.log('INFO', event.type, event.message, {
      data: { flow: event.flow, ...(event.intentId ? { intent: event.intentId } : {}) },
    });
    request.onEvent?.(event);
  };
  const semantics = await loadSemantics(config);
  const outcomes = new Map<string, DryRunOutcome>();

  await runMission(config, {
    ...request.run,
    mode: 'explore',
    dryRun: async (driverFor) => {
      for (const graph of loaded.graphs) {
        const flow = config.flows.find((candidate) => candidate.name === graph.name);
        if (!flow) continue;
        const engine = new DryRunEngine(
          driverFor(flow),
          {
            budget: {
              maxDepth: config.dryRun.maxDepth,
              maxActions: config.dryRun.maxActions,
              maxDurationMs: config.dryRun.maxDurationMs,
              maxAlternativePaths: config.dryRun.maxAlternativePaths,
              useHistoricalKnowledge: config.dryRun.useHistoricalKnowledge,
            },
            continueAfterMismatch: config.dryRun.continueAfterMismatch,
          },
          onEvent,
          semantics.dictionary,
        );
        outcomes.set(graph.id, await engine.run(graph));
      }
    },
  });

  const format = request.outputFormat;
  const gherkin = format ? format !== 'yaml' : config.dryRun.suggestion.generateGherkin;
  const yaml = format ? format !== 'gherkin' : config.dryRun.suggestion.generateYaml;
  const flows: DryRunFlowResult[] = [];
  const many = loaded.graphs.length > 1;
  for (const graph of loaded.graphs) {
    const outcome = outcomes.get(graph.id) ?? {
      observed: {
        flow: graph.name,
        states: [],
        steps: [],
        stopReason: 'START_FAILED' as const,
        budget: {
          actions: 0,
          maxActions: config.dryRun.maxActions,
          durationMs: 0,
          maxDurationMs: config.dryRun.maxDurationMs,
        },
      },
      findings: graph.intents.map((intent) => ({
        intentId: intent.id,
        outcome: 'NOT_VERIFIED' as const,
        confidence: 0,
        reasons: ['the dry run could not start (start page or sign-in)'],
        evidence: [],
      })),
    };
    const reconciliation = reconcile(graph, outcome.observed, outcome.findings);
    onEvent({
      type: 'FLOW_RECONCILIATION_COMPLETED',
      at: new Date().toISOString(),
      flow: graph.name,
      message: `${reconciliation.status}: ${summaryLine(reconciliation)}`,
    });
    const suggested = buildSuggestedFlow(graph, outcome.observed, reconciliation);
    const flowDir = many ? path.join(directory, slug(graph.name) || graph.id) : directory;
    await mkdir(flowDir, { recursive: true });
    const header = [
      `Suggested by QA-CRAWLER dry run of ${graph.source.file ?? graph.name} (${new Date().toISOString()})`,
      `Status: ${reconciliation.status}. Review before use: this proposal is built from what was observed; the original file is unchanged.`,
    ];
    const files: Record<string, string> = {};
    const write = async (name: string, content: string): Promise<void> => {
      await writeFile(path.join(flowDir, name), content, 'utf8');
      files[name] = name;
    };
    await write('expected-flow.json', json(expectedJson(graph)));
    await write('observed-flow.json', json(outcome.observed));
    await write('suggested-flow.json', json(suggestedJson(suggested)));
    await write('reconciliation.json', json({ ...reconciliation, findings: outcome.findings }));
    if (gherkin)
      await write(
        'suggested.feature',
        suggestedFeature(suggested, {
          language: loaded.language ?? (config.report.language === 'fr' ? 'fr' : 'en'),
          header,
        }),
      );
    if (yaml) await write('suggested.flow.yaml', suggestedFlowYaml(suggested, header));
    onEvent({
      type: 'SUGGESTED_FLOW_GENERATED',
      at: new Date().toISOString(),
      flow: graph.name,
      message: `${String(suggested.steps.length)} step(s): ${Object.keys(files)
        .filter((name) => name.startsWith('suggested.'))
        .join(', ')}`,
    });
    files['exploration report'] = path.relative(flowDir, path.join(directory, 'exploration', 'index.html'));
    await write(
      'index.html',
      dryRunHtml({
        graph,
        observed: outcome.observed,
        reconciliation,
        suggested,
        files: { ...files },
        generatedAt: new Date().toISOString(),
      }),
    );
    flows.push({ graph, outcome, reconciliation, suggested, directory: flowDir, files });
  }
  const status = flows.reduce<DryRunStatus>(
    (worst, flow) =>
      STATUS_ORDER.indexOf(flow.reconciliation.status) > STATUS_ORDER.indexOf(worst)
        ? flow.reconciliation.status
        : worst,
    'FULLY_MATCHED',
  );
  onEvent({
    type: 'DRY_RUN_COMPLETED',
    at: new Date().toISOString(),
    flow: loaded.graphs.map((graph) => graph.name).join(', '),
    message: `${status} (${String(flows.length)} flow(s))`,
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'dry-run-events.jsonl'), log.toJsonLines(), 'utf8');
  return { flows, status, directory, warnings: loaded.warnings };
}

/** La configuration du run sous-jacent : jamais une baseline, ses rapports sous exploration/. */
function dryRunConfig(config: ScenarioConfig, request: DryRunRequest, directory: string): ScenarioConfig {
  return {
    ...config,
    mission: { ...config.mission, mode: 'explore' },
    // La mémoire des runs de la mission (calculée avant de déplacer les rapports) : le Dry Run profite
    // de ce qu'ils ont appris, et eux de ce qu'il découvre. --isolated-memory : le dossier du Dry Run.
    knowledge: {
      ...config.knowledge,
      file: request.isolatedMemory
        ? path.join(directory, 'knowledge', 'knowledge-base.json')
        : knowledgeFileOf(config),
    },
    output: {
      ...config.output,
      reportsDir: path.join(directory, 'exploration'),
      screenshotsDir: path.join(directory, 'exploration', 'screenshots'),
    },
    dryRun: {
      ...config.dryRun,
      ...(request.useHistory !== undefined ? { useHistoricalKnowledge: request.useHistory } : {}),
      ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
      ...(request.maxActions !== undefined ? { maxActions: request.maxActions } : {}),
      ...(request.maxDurationMs !== undefined ? { maxDurationMs: request.maxDurationMs } : {}),
    },
  };
}

/** create-user.feature, create-user.flow.yaml → create-user. */
export function scenarioName(file: string): string {
  const name = path
    .basename(file)
    .replace(/\.(feature|ya?ml)$/i, '')
    .replace(/\.flow$/i, '');
  return slug(name) || 'scenario';
}

/** Les intentions attendues, sans leurs valeurs (une valeur du scénario peut être sensible). */
function expectedJson(graph: FlowIntentGraph): unknown {
  return {
    ...graph,
    intents: graph.intents.map(({ step: _step, value, ...intent }) => ({
      ...intent,
      ...(value === undefined ? {} : { value: typeof value === 'string' ? '…' : value }),
    })),
  };
}

function suggestedJson(suggested: SuggestedFlowGraph): unknown {
  return {
    ...suggested,
    steps: suggested.steps.map(({ step, ...rest }) => ({ ...rest, ...(step ? { kind: step.kind } : {}) })),
  };
}

function summaryLine(reconciliation: Reconciliation): string {
  const s = reconciliation.summary;
  return `${String(s.matched)}/${String(s.originalIntents)} matched, ${String(s.inserted)} inserted, ${String(s.possiblyObsolete)} possibly obsolete, ${String(s.reordered)} reordered, ${String(s.unreachable)} unreachable, ${String(s.blocked)} blocked, ${String(s.notVerified)} not verified`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
