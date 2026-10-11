import type { ExplorationResult } from '../model/exploration-result.js';
import { countBy } from './model.js';

/**
 * FUNCTIONAL COVERAGE GRAPH : ce que le run a couvert FONCTIONNELLEMENT, et avec quelle preuve.
 *
 * Ce qui existait : les checkpoints sémantiques et la couverture du moteur cognitif
 * (`cognitive.checkpoints`, `coverage`, `coverageGaps`), les objectifs et workflows de
 * l'intelligence fonctionnelle (`functional.goals`, `functional.workflows`), la preuve métier de
 * chaque flow (`businessProof`), les règles d'autorisation (`authorization.rules`). Ce qui est
 * nouveau : un graphe unique d'éléments fonctionnels avec un statut en cinq valeurs
 * (COVERED / PARTIALLY_COVERED / NOT_COVERED / BLOCKED / UNKNOWN), la preuve de chacun et un résumé.
 * Couvert ≠ réussi : un workflow FAILED est couvert (il a été exercé), un workflow DISCOVERED
 * ne l'est pas.
 */

export const COVERAGE_STATUSES = [
  'COVERED',
  'PARTIALLY_COVERED',
  'NOT_COVERED',
  'BLOCKED',
  'UNKNOWN',
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export type CoverageItemKind =
  'FLOW' | 'BUSINESS_PROOF' | 'CHECKPOINT' | 'WORKFLOW' | 'GOAL' | 'AUTHORIZATION_RULE' | 'COVERAGE_GAP';

export interface CoverageItem {
  id: string;
  kind: CoverageItemKind;
  label: string;
  status: CoverageStatus;
  /** Ce qui établit le statut (statut d'origine, preuve). */
  evidence: string[];
  /** Les éléments dont celui-ci dépend (un objectif couvert par un flow, une preuve par un flow). */
  dependsOn: string[];
}

export interface FunctionalCoverageGraph {
  items: CoverageItem[];
  summary: Record<CoverageStatus, number> & { total: number; ratio: number };
  byKind: Record<CoverageItemKind, Record<CoverageStatus, number>>;
}

const CHECKPOINT: Record<string, CoverageStatus> = {
  CONFIRMED: 'COVERED',
  PARTIAL: 'PARTIALLY_COVERED',
  NOT_REACHED: 'NOT_COVERED',
  CONTRADICTED: 'BLOCKED',
};
const WORKFLOW: Record<string, CoverageStatus> = {
  VERIFIED: 'COVERED',
  FAILED: 'COVERED',
  PARTIALLY_VERIFIED: 'PARTIALLY_COVERED',
  DISCOVERED: 'NOT_COVERED',
  BLOCKED_BY_POLICY: 'BLOCKED',
  INCONCLUSIVE: 'UNKNOWN',
};
const GOAL: Record<string, CoverageStatus> = {
  VERIFIED: 'COVERED',
  FAILED: 'COVERED',
  RUNNING: 'PARTIALLY_COVERED',
  PLANNED: 'NOT_COVERED',
  CANDIDATE: 'NOT_COVERED',
  BLOCKED: 'BLOCKED',
  INCONCLUSIVE: 'UNKNOWN',
};
const PROOF: Record<string, CoverageStatus> = {
  PROVEN: 'COVERED',
  PARTIAL: 'PARTIALLY_COVERED',
  NOT_PROVEN: 'NOT_COVERED',
};

function flowStatus(flow: ExplorationResult['flows'][number]): CoverageStatus {
  if (flow.status === 'BLOCKED') return 'BLOCKED';
  const executed = flow.steps.filter((step) => step.status === 'PASSED' || step.status === 'FAILED').length;
  const judged = flow.steps.filter((step) => step.status !== 'MANUAL').length;
  if (judged === 0) return 'UNKNOWN';
  if (executed === judged) return 'COVERED';
  return executed === 0 ? 'NOT_COVERED' : 'PARTIALLY_COVERED';
}

/** Le graphe de couverture fonctionnelle du run. */
export function buildFunctionalCoverage(result: ExplorationResult): FunctionalCoverageGraph {
  const items: CoverageItem[] = [];
  for (const flow of result.flows) {
    const status = flowStatus(flow);
    const skipped = flow.steps.filter((step) => step.status === 'SKIPPED').length;
    items.push({
      id: `flow:${flow.name}`,
      kind: 'FLOW',
      label: flow.name,
      status,
      evidence: [
        `flow ${flow.status}`,
        `${String(flow.steps.length - skipped)}/${String(flow.steps.length)} step(s) executed`,
      ],
      dependsOn: [],
    });
    const proof = flow.businessProof;
    if (proof && proof.status !== 'NOT_APPLICABLE')
      items.push({
        id: `proof:${flow.name}`,
        kind: 'BUSINESS_PROOF',
        label: `${flow.name}: created data found and opened${proof.key ? ` (${proof.key})` : ''}`,
        status: PROOF[proof.status] ?? 'UNKNOWN',
        evidence: [...proof.evidence, ...proof.missing.map((entry) => `missing: ${entry}`)],
        dependsOn: [`flow:${flow.name}`],
      });
  }
  for (const checkpoint of result.cognitive?.checkpoints ?? [])
    items.push({
      id: `checkpoint:${checkpoint.id}`,
      kind: 'CHECKPOINT',
      label: checkpoint.id,
      status: CHECKPOINT[checkpoint.status] ?? 'UNKNOWN',
      evidence: [`checkpoint ${checkpoint.status}`],
      dependsOn: [],
    });
  for (const workflow of result.functional?.workflows ?? [])
    items.push({
      id: `workflow:${workflow.id}`,
      kind: 'WORKFLOW',
      label: workflow.intent,
      status: WORKFLOW[workflow.status] ?? 'UNKNOWN',
      evidence: [`workflow ${workflow.status}`, ...(workflow.api ? [`api ${workflow.api}`] : [])],
      dependsOn: [],
    });
  for (const goal of result.functional?.goals ?? [])
    items.push({
      id: `goal:${goal.id}`,
      kind: 'GOAL',
      label: goal.intent,
      status: GOAL[goal.status] ?? 'UNKNOWN',
      evidence: [`goal ${goal.status}`, `from ${goal.generatedFrom}`, ...(goal.reason ? [goal.reason] : [])],
      dependsOn: [],
    });
  for (const rule of result.authorization?.rules ?? [])
    items.push({
      id: `authorization:${rule.actor}:${rule.path}`,
      kind: 'AUTHORIZATION_RULE',
      label: `${rule.actor} → ${rule.path} expected ${rule.expect}`,
      status: rule.status === 'UNKNOWN' ? 'NOT_COVERED' : 'COVERED',
      evidence: [`rule ${rule.status}`, `${String(rule.checked)} screen(s) checked`, ...rule.violations],
      dependsOn: [],
    });
  for (const [index, gap] of (result.cognitive?.coverageGaps ?? []).entries())
    items.push({
      id: `gap:${String(index + 1)}`,
      kind: 'COVERAGE_GAP',
      label: gap,
      status: 'NOT_COVERED',
      evidence: ['reported by the cognitive engine as a coverage gap'],
      dependsOn: [],
    });
  const statuses = items.map((item) => item.status);
  const counts = countBy(COVERAGE_STATUSES, statuses);
  const kinds: CoverageItemKind[] = [
    'FLOW',
    'BUSINESS_PROOF',
    'CHECKPOINT',
    'WORKFLOW',
    'GOAL',
    'AUTHORIZATION_RULE',
    'COVERAGE_GAP',
  ];
  const byKind = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      countBy(
        COVERAGE_STATUSES,
        items.filter((item) => item.kind === kind).map((item) => item.status),
      ),
    ]),
  ) as FunctionalCoverageGraph['byKind'];
  const covered = counts.COVERED + counts.PARTIALLY_COVERED / 2;
  return {
    items,
    summary: {
      ...counts,
      total: items.length,
      ratio: items.length === 0 ? 0 : Math.round((covered / items.length) * 100) / 100,
    },
    byKind,
  };
}
