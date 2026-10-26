import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { compareFlowRuns, flowRunMemoryOf } from '../../flows/flow-run-comparison.js';
import type { FlowRunReport } from '../../model/flow-run.js';
import type { RegressionAnalysis } from '../../platform/regression-analysis.js';
import type { QualityVerificationReport } from '../../quality/quality-verification.js';
import type { AssertionTrace } from '../../quality/traceability.js';
import type {
  FlowComparisonView,
  RegressionView,
  RequirementComparisonView,
  RunComparisonView,
  TraceAssertionView,
  TraceabilityView,
} from '../core/contracts.js';

/**
 * COMPARAISON ET TRAÇABILITÉ des explorations d'un projet : le SDK lit ce que le moteur a écrit dans
 * le dossier de chaque run (`result.json`, `quality-verification.json`, `regression-analysis.json`)
 * et ne recalcule rien. Deux runs se comparent flow par flow avec `compareFlowRuns`, la même règle
 * que l'écart avec le run précédent du rapport ; les couvertures d'exigences sont celles du moteur.
 */

const readJson = async <T>(file: string): Promise<T | undefined> => {
  const raw = await readFile(file, 'utf8').catch(() => undefined);
  return raw === undefined ? undefined : (JSON.parse(raw) as T);
};

interface ResultFlows {
  startedAt?: string;
  flows?: FlowRunReport[];
}

const assertionView = (trace: AssertionTrace): TraceAssertionView => ({
  flow: trace.flow,
  id: trace.id,
  status: trace.status,
  mandatory: trace.mandatory,
  ...(trace.criticality ? { criticality: trace.criticality } : {}),
  evidence: trace.evidence,
});

/** La traçabilité d'un run ; undefined quand le moteur n'en a pas écrit (aucune exigence déclarée). */
export async function traceabilityView(
  directory: string,
  run: string,
): Promise<TraceabilityView | undefined> {
  const report = await readJson<QualityVerificationReport>(path.join(directory, 'quality-verification.json'));
  if (!report) return undefined;
  const trace = report.traceability;
  return {
    run,
    generatedAt: trace.generatedAt,
    verdict: report.verdict,
    requirements: trace.requirements.map((requirement) => ({
      id: requirement.id,
      description: requirement.description,
      criticality: requirement.criticality,
      ...(requirement.source ? { source: requirement.source } : {}),
      declared: requirement.declared,
      status: requirement.status,
      flows: requirement.flows,
      rules: requirement.rules,
      operations: requirement.operations,
      assertions: requirement.assertions.map(assertionView),
      evidence: requirement.evidence,
      dependsOn: requirement.dependsOn,
      reasons: requirement.reasons,
      ...(requirement.lastVerified ? { lastVerified: requirement.lastVerified } : {}),
    })),
    rules: trace.rules.map((rule) => ({
      id: rule.id,
      description: rule.description,
      requirementIds: rule.requirementIds,
      status: rule.status,
      assertions: rule.assertions.map(assertionView),
      conflictsWith: rule.conflictsWith,
      reasons: rule.reasons,
    })),
    warnings: trace.warnings,
    summary: trace.summary,
    limits: report.limits,
  };
}

/** L'analyse de régression d'un run (par rapport à l'historique du moteur) ; undefined si absente. */
export async function regressionView(directory: string, run: string): Promise<RegressionView | undefined> {
  const analysis = await readJson<RegressionAnalysis>(path.join(directory, 'regression-analysis.json'));
  if (!analysis) return undefined;
  return { run, entries: analysis.entries, summary: analysis.summary };
}

async function runAt(directory: string, result: ResultFlows | undefined): Promise<string> {
  if (result?.startedAt) return result.startedAt;
  return (await stat(directory)).mtime.toISOString();
}

/** Deux runs d'un projet, flow par flow et exigence par exigence. Rien n'est rejoué. */
export async function compareRuns(
  base: { dir: string; run: string },
  head: { dir: string; run: string },
): Promise<RunComparisonView | undefined> {
  const [baseResult, headResult] = await Promise.all([
    readJson<ResultFlows>(path.join(base.dir, 'result.json')),
    readJson<ResultFlows>(path.join(head.dir, 'result.json')),
  ]);
  if (!baseResult || !headResult) return undefined;
  const baseFlows = new Map((baseResult.flows ?? []).map((flow) => [flow.name, flow]));
  const headFlows = new Map((headResult.flows ?? []).map((flow) => [flow.name, flow]));
  const flows: FlowComparisonView[] = [];
  for (const [name, after] of headFlows) {
    const before = baseFlows.get(name);
    if (!before) {
      flows.push({ name, presence: 'ONLY_HEAD', headStatus: after.status, changes: [] });
      continue;
    }
    const comparison = compareFlowRuns(flowRunMemoryOf(before, base.run), after);
    flows.push({
      name,
      presence: 'BOTH',
      baseStatus: before.status,
      headStatus: after.status,
      verdict: comparison.verdict,
      durationDeltaMs: comparison.durationDeltaMs,
      changes: comparison.changes,
    });
  }
  for (const [name, before] of baseFlows)
    if (!headFlows.has(name))
      flows.push({ name, presence: 'ONLY_BASE', baseStatus: before.status, changes: [] });

  const [baseTrace, headTrace] = await Promise.all([
    traceabilityView(base.dir, base.run),
    traceabilityView(head.dir, head.run),
  ]);
  const requirements: RequirementComparisonView[] = [];
  const ids = new Set([
    ...(baseTrace?.requirements ?? []).map((requirement) => requirement.id),
    ...(headTrace?.requirements ?? []).map((requirement) => requirement.id),
  ]);
  for (const id of ids) {
    const before = baseTrace?.requirements.find((requirement) => requirement.id === id);
    const after = headTrace?.requirements.find((requirement) => requirement.id === id);
    const known = after ?? before;
    if (!known) continue;
    requirements.push({
      id,
      description: known.description,
      criticality: known.criticality,
      ...(before ? { baseStatus: before.status } : {}),
      ...(after ? { headStatus: after.status } : {}),
      changed: before?.status !== after?.status,
    });
  }

  const both = flows.filter((flow) => flow.presence === 'BOTH');
  return {
    base: { run: base.run, at: await runAt(base.dir, baseResult) },
    head: { run: head.run, at: await runAt(head.dir, headResult) },
    flows,
    requirements,
    traceability: { base: baseTrace !== undefined, head: headTrace !== undefined },
    summary: {
      flows: flows.length,
      changed: both.filter((flow) => flow.verdict === 'CHANGED').length,
      same: both.filter((flow) => flow.verdict === 'SAME').length,
      onlyBase: flows.filter((flow) => flow.presence === 'ONLY_BASE').length,
      onlyHead: flows.filter((flow) => flow.presence === 'ONLY_HEAD').length,
      newlyFailing: both
        .filter((flow) => flow.baseStatus === 'PASSED' && flow.headStatus !== 'PASSED')
        .map((flow) => flow.name),
      newlyPassing: both
        .filter((flow) => flow.baseStatus !== 'PASSED' && flow.headStatus === 'PASSED')
        .map((flow) => flow.name),
      requirementsChanged: requirements.filter((requirement) => requirement.changed).length,
    },
  };
}
