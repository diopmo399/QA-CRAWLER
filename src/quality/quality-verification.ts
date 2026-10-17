import type { BusinessRuleConfig, RequirementConfig } from '../config/quality-schema.js';
import type { FlowRunReport } from '../model/flow-run.js';
import type { ContractOperation } from '../oracles/api-contract.js';
import {
  CONSISTENCY_RULES,
  type AssertionResult,
  type AssertionStatus,
  type BusinessVerdict,
  type ConsistencyResult,
  type ConsistencyRule,
  type QualityEvidence,
} from './model.js';
import { buildTraceability, type TraceabilityReport, type TraceHistory } from './traceability.js';

/**
 * LE RAPPORT DE VÉRIFICATION DU RUN (quality-verification.json) : le verdict métier de chaque flow,
 * la traçabilité des exigences, les métriques. Tout est corrélé par runId, flow, étape et assertion ;
 * aucune valeur sensible (les preuves ne portent que des noms, des codes et des empreintes).
 */

export interface QualityMetrics {
  assertionsDeclared: number;
  /** Évaluées (toutes sauf BLOCKED : une précondition manquante n'est pas une exécution). */
  assertionsExecuted: number;
  assertionsByStatus: Record<AssertionStatus, number>;
  requirementsTotal: number;
  requirementsVerified: number;
  requirementsUncovered: number;
  requirementsStale: number;
  consistencyChecks: number;
  divergencesByRule: Record<ConsistencyRule, number>;
  ambiguousCorrelations: number;
  /** Assertions qui n'ont pas pu conclure faute de preuve (UNVERIFIABLE, INCONCLUSIVE). */
  missingEvidence: number;
  verificationMs: number;
}

export interface FlowVerification {
  flow: string;
  flowStatus: string;
  verdict: BusinessVerdict;
  networkObserved: boolean;
  assertions: AssertionResult[];
  consistency: ConsistencyResult[];
}

export interface QualityVerificationReport {
  runId: string;
  generatedAt: string;
  /** Le verdict métier du run : un échec obligatoire l'emporte, puis ce qui n'a pas pu être vérifié. */
  verdict: BusinessVerdict;
  flows: FlowVerification[];
  traceability: TraceabilityReport;
  evidence: QualityEvidence[];
  metrics: QualityMetrics;
  /** Ce que cette vérification ne peut PAS affirmer (dit dans chaque rapport). */
  limits: string[];
}

export interface QualityVerificationInput {
  runId: string;
  flows: readonly FlowRunReport[];
  /** Les flows de la mission (leurs exigences et assertions déclarées, même non exécutés). */
  declared: readonly {
    name: string;
    requirements: string[];
    assertions: { id: string }[];
    gherkin?: boolean;
  }[];
  requirements: readonly RequirementConfig[];
  rules: readonly BusinessRuleConfig[];
  operations?: readonly ContractOperation[];
  history?: TraceHistory;
  evidenceMaxAgeDays: number;
  now: Date;
}

const VERDICT_ORDER: readonly BusinessVerdict[] = ['FAIL', 'BLOCKED', 'UNVERIFIABLE', 'INCONCLUSIVE', 'PASS'];

export const QUALITY_LIMITS = [
  'only what the browser exchanged during the run is observed: server-side processing and database persistence are not verified, unless an authorized read API confirms them',
  'values are compared as salted digests of this run; a value that the application transforms (format, rounding) needs a documented transformation',
  'an assertion that is BLOCKED, INCONCLUSIVE or UNVERIFIABLE is never counted as passed',
];

export function buildQualityVerification(input: QualityVerificationInput): QualityVerificationReport {
  const executed = new Map(input.flows.map((flow) => [flow.name, flow]));
  const flows: FlowVerification[] = input.flows
    .filter((flow) => flow.quality)
    .map((flow) => ({
      flow: flow.name,
      flowStatus: flow.status,
      verdict: flow.quality?.verdict ?? 'NOT_DECLARED',
      networkObserved: flow.quality?.networkObserved ?? false,
      assertions: flow.quality?.assertions ?? [],
      consistency: flow.quality?.consistency ?? [],
    }));
  const verdicts = flows.map((flow) => flow.verdict);
  const verdict = VERDICT_ORDER.find((candidate) => verdicts.includes(candidate)) ?? 'NOT_DECLARED';

  const traceability = buildTraceability({
    runId: input.runId,
    requirements: input.requirements,
    rules: input.rules,
    flows: input.declared.map((flow) => {
      const run = executed.get(flow.name);
      return {
        name: flow.name,
        requirements: flow.requirements,
        assertions: flow.assertions.map((assertion) => assertion.id),
        ...(flow.gherkin ? { fromGherkin: true } : {}),
        executed: run !== undefined && run.steps.some((step) => step.status !== 'SKIPPED'),
        ...(run ? { status: run.status } : {}),
        ...(run?.quality ? { quality: run.quality } : {}),
      };
    }),
    ...(input.operations ? { operations: input.operations } : {}),
    ...(input.history ? { history: input.history } : {}),
    evidenceMaxAgeDays: input.evidenceMaxAgeDays,
    now: input.now,
  });

  const assertions = flows.flatMap((flow) => flow.assertions);
  const consistency = flows.flatMap((flow) => flow.consistency);
  const byStatus = { PASS: 0, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0, UNVERIFIABLE: 0 } satisfies Record<
    AssertionStatus,
    number
  >;
  for (const assertion of assertions) byStatus[assertion.status] += 1;
  const divergencesByRule = Object.fromEntries(CONSISTENCY_RULES.map((rule) => [rule, 0])) as Record<
    ConsistencyRule,
    number
  >;
  for (const result of consistency) if (result.status === 'INCONSISTENT') divergencesByRule[result.rule] += 1;
  return {
    runId: input.runId,
    generatedAt: input.now.toISOString(),
    verdict,
    flows,
    traceability,
    evidence: input.flows.flatMap((flow) => flow.quality?.evidence ?? []),
    metrics: {
      assertionsDeclared: input.declared.reduce((sum, flow) => sum + flow.assertions.length, 0),
      assertionsExecuted: assertions.length - byStatus.BLOCKED,
      assertionsByStatus: byStatus,
      requirementsTotal: traceability.summary.total,
      requirementsVerified: traceability.summary.byStatus.VERIFIED_PASS,
      requirementsUncovered: traceability.summary.byStatus.NOT_COVERED,
      requirementsStale: traceability.summary.byStatus.STALE_EVIDENCE,
      consistencyChecks: consistency.length,
      divergencesByRule,
      ambiguousCorrelations: consistency.filter((result) => result.status === 'AMBIGUOUS_ENTITY').length,
      missingEvidence: byStatus.UNVERIFIABLE + byStatus.INCONCLUSIVE,
      verificationMs: input.flows.reduce((sum, flow) => sum + (flow.quality?.durationMs ?? 0), 0),
    },
    limits: QUALITY_LIMITS,
  };
}

/** Les assertions obligatoires d'un ensemble de flows : échouées, et non vérifiées (pour le statut global). */
export function qualityCountsOf(flows: readonly FlowRunReport[]): { failed: number; unverified: number } {
  let failed = 0;
  let unverified = 0;
  for (const assertion of flows.flatMap((flow) => flow.quality?.assertions ?? [])) {
    if (!assertion.mandatory) continue;
    if (assertion.status === 'FAIL') failed += 1;
    else if (assertion.status !== 'PASS') unverified += 1;
  }
  return { failed, unverified };
}
