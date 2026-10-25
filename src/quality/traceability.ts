import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BusinessRuleConfig, Criticality, RequirementConfig } from '../config/quality-schema.js';
import type { ContractOperation } from '../oracles/api-contract.js';
import type { AssertionResult, AssertionStatus, FlowQualityReport } from './model.js';

/**
 * LA TRAÇABILITÉ : exigence → règle métier → flow (test) → assertion → résultat → preuve. Chaque
 * exigence reçoit un statut de couverture tiré des résultats de CE run (ou de l'historique, avec son
 * âge) ; aucun agrégat ne masque un échec : les résultats individuels restent dans le rapport.
 */

/**
 * NOT_COVERED           aucun flow ni assertion ne la vérifie ;
 * COVERED_NOT_EXECUTED  couverte, mais rien de ce qui la couvre n'a été exécuté dans ce run ;
 * VERIFIED_PASS         toutes les assertions obligatoires qui la vérifient sont PASS ;
 * VERIFIED_FAIL         au moins une assertion obligatoire (ou le flow qui la couvre) échoue ;
 * BLOCKED               une précondition l'a empêchée d'être vérifiée ;
 * INCONCLUSIVE          exécutée, mais les preuves ne suffisent pas (UNVERIFIABLE, INCONCLUSIVE, aucune assertion) ;
 * STALE_EVIDENCE        pas exécutée dans ce run, et la dernière preuve est plus vieille que le seuil.
 */
export const COVERAGE_STATUSES = [
  'NOT_COVERED',
  'COVERED_NOT_EXECUTED',
  'VERIFIED_PASS',
  'VERIFIED_FAIL',
  'BLOCKED',
  'INCONCLUSIVE',
  'STALE_EVIDENCE',
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const TRACE_LINK_TYPES = [
  'COVERS',
  'VERIFIES',
  'DEPENDS_ON',
  'CONFLICTS_WITH',
  'DERIVED_FROM',
] as const;
export type TraceLinkType = (typeof TRACE_LINK_TYPES)[number];

export type TraceNodeKind = 'REQUIREMENT' | 'RULE' | 'FLOW' | 'ASSERTION' | 'OPERATION';

export interface TraceLink {
  type: TraceLinkType;
  from: { kind: TraceNodeKind; id: string };
  to: { kind: TraceNodeKind; id: string };
  /** D'où vient le lien : la mission (YAML), un tag Gherkin, l'OpenAPI (x-requirements). */
  origin: 'YAML' | 'GHERKIN' | 'OPENAPI';
}

/** Un flow vu par la traçabilité : ses exigences, ses assertions, et ce que le run en a fait. */
export interface TraceFlow {
  name: string;
  requirements: string[];
  /** Les identifiants d'assertion déclarés (même non exécutés). */
  assertions: string[];
  /** Les exigences venues d'un tag Gherkin (pour l'origine du lien). */
  fromGherkin?: boolean;
  executed: boolean;
  status?: string;
  quality?: FlowQualityReport;
}

export interface TraceHistoryEntry {
  status: CoverageStatus;
  at: string;
  runId: string;
}

export interface TraceHistory {
  version: 1;
  requirements: Record<string, TraceHistoryEntry>;
}

export interface TraceabilityInput {
  runId: string;
  requirements: readonly RequirementConfig[];
  rules: readonly BusinessRuleConfig[];
  flows: readonly TraceFlow[];
  operations?: readonly ContractOperation[];
  history?: TraceHistory;
  evidenceMaxAgeDays: number;
  now: Date;
}

export interface AssertionTrace {
  flow: string;
  id: string;
  status: AssertionStatus | 'NOT_EXECUTED';
  mandatory: boolean;
  criticality?: Criticality;
  evidence: string[];
}

export interface RequirementCoverage {
  id: string;
  description: string;
  criticality: Criticality;
  source?: string;
  /** Déclarée dans la mission, ou seulement citée (tag, flow, OpenAPI). */
  declared: boolean;
  status: CoverageStatus;
  flows: string[];
  rules: string[];
  operations: string[];
  assertions: AssertionTrace[];
  evidence: string[];
  dependsOn: string[];
  preconditions: string[];
  reasons: string[];
  /** La dernière vérification connue (ce run, ou l'historique). */
  lastVerified?: TraceHistoryEntry;
}

export interface RuleCoverage {
  id: string;
  description: string;
  requirementIds: string[];
  status: CoverageStatus;
  assertions: AssertionTrace[];
  conflictsWith: string[];
  derivedFrom: string[];
  reasons: string[];
}

export interface TraceabilityReport {
  runId: string;
  generatedAt: string;
  requirements: RequirementCoverage[];
  rules: RuleCoverage[];
  links: TraceLink[];
  /** Références à rien (assertion inconnue, exigence citée par une règle mais jamais déclarée…). */
  warnings: string[];
  summary: {
    total: number;
    byStatus: Record<CoverageStatus, number>;
    /** Les exigences HIGH / CRITICAL en échec ou bloquées : jamais noyées dans un pourcentage. */
    criticalFailures: string[];
    /** Part des exigences vérifiées PASS parmi celles exécutées (null : aucune exécutée). */
    passRate: number | null;
  };
}

const RANK: Record<CoverageStatus, number> = {
  VERIFIED_FAIL: 6,
  BLOCKED: 5,
  INCONCLUSIVE: 4,
  STALE_EVIDENCE: 3,
  COVERED_NOT_EXECUTED: 2,
  NOT_COVERED: 1,
  VERIFIED_PASS: 0,
};

const EXECUTED: readonly CoverageStatus[] = ['VERIFIED_PASS', 'VERIFIED_FAIL', 'BLOCKED', 'INCONCLUSIVE'];

/** L'assertion « contract » vise-t-elle cette opération (« POST /api/requests/12 follows … ») ? */
function targetsOperation(result: AssertionResult, operation: ContractOperation): boolean {
  const [method, target] = result.expected.split(' ');
  if (!method || !target) return false;
  return (
    (method === 'any' || method.toUpperCase() === operation.method) &&
    (target === operation.path || operation.matcher.test(target))
  );
}

/** Le statut d'un ensemble d'assertions exécutées : un échec l'emporte, puis ce qui n'a pas pu conclure. */
function statusOfAssertions(traces: readonly AssertionTrace[]): CoverageStatus | undefined {
  const mandatory = traces.filter((trace) => trace.mandatory && trace.status !== 'NOT_EXECUTED');
  if (mandatory.length === 0) return undefined;
  const has = (status: AssertionTrace['status']): boolean =>
    mandatory.some((trace) => trace.status === status);
  if (has('FAIL')) return 'VERIFIED_FAIL';
  if (has('BLOCKED')) return 'BLOCKED';
  if (has('UNVERIFIABLE') || has('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'VERIFIED_PASS';
}

export function buildTraceability(input: TraceabilityInput): TraceabilityReport {
  const warnings: string[] = [];
  const links: TraceLink[] = [];
  const declared = new Map(input.requirements.map((requirement) => [requirement.id, requirement]));
  const cited = new Set<string>();
  const results = new Map<string, AssertionResult>();
  for (const flow of input.flows)
    for (const result of flow.quality?.assertions ?? []) results.set(`${flow.name}#${result.id}`, result);

  const trace = (flow: TraceFlow, id: string): AssertionTrace => {
    const result = results.get(`${flow.name}#${id}`);
    return {
      flow: flow.name,
      id,
      status: result && flow.executed ? result.status : 'NOT_EXECUTED',
      mandatory: result?.mandatory ?? true,
      ...(result ? { criticality: result.criticality } : {}),
      evidence: result?.evidence ?? [],
    };
  };
  /** Les assertions désignées par une règle (dans tous les flows qui les déclarent). */
  const resolveRef = (ref: string, owner: string): AssertionTrace[] => {
    const found = input.flows
      .filter((candidate) => candidate.assertions.includes(ref))
      .map((candidate) => trace(candidate, ref));
    if (found.length === 0) warnings.push(`${owner}: assertion "${ref}" is not declared by any flow`);
    return found;
  };

  // LES LIENS : flow COVERS exigence ; règle VERIFIES (par ses assertions) ; DEPENDS_ON ; CONFLICTS_WITH ; DERIVED_FROM.
  for (const flow of input.flows)
    for (const requirement of flow.requirements) {
      cited.add(requirement);
      links.push({
        type: 'COVERS',
        from: { kind: 'FLOW', id: flow.name },
        to: { kind: 'REQUIREMENT', id: requirement },
        origin: flow.fromGherkin ? 'GHERKIN' : 'YAML',
      });
    }
  const ruleIds = new Set(input.rules.map((rule) => rule.id));
  const originKind = (origin: string): TraceNodeKind =>
    ruleIds.has(origin) ? 'RULE' : /^[A-Z]+ \//.test(origin) ? 'OPERATION' : 'REQUIREMENT';
  const ruleTraces = new Map<string, AssertionTrace[]>();
  for (const rule of input.rules) {
    const traces = rule.assertions.flatMap((ref) => resolveRef(ref, `businessRules.${rule.id}`));
    ruleTraces.set(rule.id, traces);
    for (const requirement of rule.requirementIds) {
      cited.add(requirement);
      links.push({
        type: 'VERIFIES',
        from: { kind: 'RULE', id: rule.id },
        to: { kind: 'REQUIREMENT', id: requirement },
        origin: 'YAML',
      });
    }
    for (const ref of rule.assertions)
      links.push({
        type: 'VERIFIES',
        from: { kind: 'ASSERTION', id: ref },
        to: { kind: 'RULE', id: rule.id },
        origin: 'YAML',
      });
    for (const other of rule.conflictsWith)
      links.push({
        type: 'CONFLICTS_WITH',
        from: { kind: 'RULE', id: rule.id },
        to: { kind: 'RULE', id: other },
        origin: 'YAML',
      });
    for (const origin of rule.derivedFrom)
      links.push({
        type: 'DERIVED_FROM',
        from: { kind: 'RULE', id: rule.id },
        to: { kind: originKind(origin), id: origin },
        origin: 'YAML',
      });
  }
  for (const requirement of input.requirements)
    for (const dependency of requirement.dependsOn) {
      if (!declared.has(dependency))
        warnings.push(`requirements.${requirement.id}: depends on "${dependency}", which is not declared`);
      links.push({
        type: 'DEPENDS_ON',
        from: { kind: 'REQUIREMENT', id: requirement.id },
        to: { kind: 'REQUIREMENT', id: dependency },
        origin: 'YAML',
      });
    }
  // L'OpenAPI : l'opération qui porte x-requirements est vérifiée par les assertions « contract » qui la visent.
  const operationsOf = new Map<string, ContractOperation[]>();
  for (const operation of input.operations ?? [])
    for (const requirement of operation.requirements ?? []) {
      cited.add(requirement);
      operationsOf.set(requirement, [...(operationsOf.get(requirement) ?? []), operation]);
      links.push({
        type: 'COVERS',
        from: { kind: 'OPERATION', id: `${operation.method} ${operation.path}` },
        to: { kind: 'REQUIREMENT', id: requirement },
        origin: 'OPENAPI',
      });
    }
  for (const rule of input.rules)
    for (const other of rule.conflictsWith)
      if (!ruleIds.has(other))
        warnings.push(`businessRules.${rule.id}: conflicts with unknown rule "${other}"`);

  // LA COUVERTURE de chaque exigence (déclarée, ou seulement citée : elle reste visible).
  const ids = [...declared.keys(), ...[...cited].filter((id) => !declared.has(id)).sort()];
  for (const id of ids)
    if (!declared.has(id))
      warnings.push(`requirement "${id}" is referenced but not declared under requirements`);
  const nowMs = input.now.getTime();
  const maxAgeMs = input.evidenceMaxAgeDays * 86_400_000;

  const requirements: RequirementCoverage[] = ids.map((id) => {
    const config = declared.get(id);
    const flows = input.flows.filter((flow) => flow.requirements.includes(id));
    const rules = input.rules.filter((rule) => rule.requirementIds.includes(id));
    const operations = operationsOf.get(id) ?? [];
    const assertions: AssertionTrace[] = [
      ...flows.flatMap((flow) => flow.assertions.map((assertion) => trace(flow, assertion))),
      ...rules.flatMap((rule) => ruleTraces.get(rule.id) ?? []),
    ];
    // Les assertions « contract » qui visent une opération liée à l'exigence.
    for (const flow of input.flows)
      for (const result of flow.quality?.assertions ?? [])
        if (result.kind === 'contract' && operations.some((operation) => targetsOperation(result, operation)))
          assertions.push(trace(flow, result.id));
    const unique = [...new Map(assertions.map((entry) => [`${entry.flow}#${entry.id}`, entry])).values()];
    const reasons: string[] = [];
    const executedFlows = flows.filter((flow) => flow.executed);
    let status: CoverageStatus;
    if (flows.length === 0 && unique.length === 0) {
      status = 'NOT_COVERED';
      reasons.push(
        operations.length > 0
          ? 'declared by the OpenAPI, but no flow or contract assertion verifies it'
          : 'no flow, business rule or assertion verifies it',
      );
    } else {
      const fromAssertions = statusOfAssertions(unique);
      const failedFlow = executedFlows.find((flow) => flow.status === 'FAILED');
      if (fromAssertions === 'VERIFIED_FAIL' || (failedFlow && fromAssertions !== 'BLOCKED')) {
        status = 'VERIFIED_FAIL';
        if (fromAssertions !== 'VERIFIED_FAIL' && failedFlow)
          reasons.push(`flow "${failedFlow.name}" failed`);
      } else if (fromAssertions) status = fromAssertions;
      else if (executedFlows.length > 0) {
        status = 'INCONCLUSIVE';
        reasons.push(
          'covered by flow(s) without a business assertion: a technical success does not verify the requirement',
        );
      } else status = 'COVERED_NOT_EXECUTED';
      for (const entry of unique.filter(
        (entry) => entry.mandatory && entry.status !== 'PASS' && entry.status !== 'NOT_EXECUTED',
      ))
        reasons.push(`${entry.flow}#${entry.id}: ${entry.status}`);
    }
    const previous = input.history?.requirements[id];
    let lastVerified: TraceHistoryEntry | undefined;
    if (EXECUTED.includes(status)) lastVerified = { status, at: input.now.toISOString(), runId: input.runId };
    else if (previous) {
      lastVerified = previous;
      const age = nowMs - Date.parse(previous.at);
      if (status === 'COVERED_NOT_EXECUTED' && Number.isFinite(age) && age > maxAgeMs) {
        status = 'STALE_EVIDENCE';
        reasons.push(
          `last verified ${String(Math.floor(age / 86_400_000))} day(s) ago (${previous.status}), beyond ${String(input.evidenceMaxAgeDays)} day(s)`,
        );
      } else if (status === 'COVERED_NOT_EXECUTED')
        reasons.push(`not executed in this run; last result ${previous.status} on ${previous.at}`);
    }
    return {
      id,
      description: config?.description ?? id,
      criticality: config?.criticality ?? 'MEDIUM',
      ...(config?.source ? { source: config.source } : {}),
      declared: config !== undefined,
      status,
      flows: flows.map((flow) => flow.name),
      rules: rules.map((rule) => rule.id),
      operations: operations.map((operation) => `${operation.method} ${operation.path}`),
      assertions: unique,
      evidence: [...new Set(unique.flatMap((entry) => entry.evidence))],
      dependsOn: config?.dependsOn ?? [],
      preconditions: config?.preconditions ?? [],
      reasons,
      ...(lastVerified ? { lastVerified } : {}),
    };
  });
  // Une dépendance non vérifiée se DIT sur l'exigence qui en dépend (son propre résultat est gardé).
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  for (const requirement of requirements)
    for (const dependency of requirement.dependsOn) {
      const other = byId.get(dependency);
      if (other && other.status !== 'VERIFIED_PASS')
        requirement.reasons.push(`depends on ${dependency}, which is ${other.status}`);
    }

  const rules: RuleCoverage[] = input.rules.map((rule) => {
    const traces = ruleTraces.get(rule.id) ?? [];
    const status =
      traces.length === 0
        ? 'NOT_COVERED'
        : (statusOfAssertions(traces) ??
          (traces.every((entry) => entry.status === 'NOT_EXECUTED')
            ? 'COVERED_NOT_EXECUTED'
            : 'INCONCLUSIVE'));
    const reasons: string[] = [];
    for (const other of rule.conflictsWith) {
      const conflicting = ruleTraces.get(other);
      if (status === 'VERIFIED_PASS' && conflicting && statusOfAssertions(conflicting) === 'VERIFIED_PASS')
        reasons.push(`conflicts with ${other}, which also passes: the rules cannot both hold, review them`);
    }
    return {
      id: rule.id,
      description: rule.description,
      requirementIds: rule.requirementIds,
      status,
      assertions: traces,
      conflictsWith: rule.conflictsWith,
      derivedFrom: rule.derivedFrom,
      reasons,
    };
  });

  const byStatus = Object.fromEntries(COVERAGE_STATUSES.map((status) => [status, 0])) as Record<
    CoverageStatus,
    number
  >;
  for (const requirement of requirements) byStatus[requirement.status] += 1;
  const executed = requirements.filter((requirement) => EXECUTED.includes(requirement.status));
  return {
    runId: input.runId,
    generatedAt: input.now.toISOString(),
    requirements: requirements.sort((left, right) => RANK[right.status] - RANK[left.status]),
    rules,
    links,
    warnings: [...new Set(warnings)],
    summary: {
      total: requirements.length,
      byStatus,
      criticalFailures: requirements
        .filter(
          (requirement) =>
            (requirement.criticality === 'HIGH' || requirement.criticality === 'CRITICAL') &&
            (requirement.status === 'VERIFIED_FAIL' || requirement.status === 'BLOCKED'),
        )
        .map((requirement) => requirement.id),
      passRate:
        executed.length === 0
          ? null
          : executed.filter((requirement) => requirement.status === 'VERIFIED_PASS').length / executed.length,
    },
  };
}

/** L'historique mis à jour : seules les exigences vérifiées dans CE run changent. */
export function updateHistory(history: TraceHistory | undefined, report: TraceabilityReport): TraceHistory {
  const next: TraceHistory = { version: 1, requirements: { ...(history?.requirements ?? {}) } };
  for (const requirement of report.requirements)
    if (EXECUTED.includes(requirement.status) && requirement.lastVerified)
      next.requirements[requirement.id] = requirement.lastVerified;
  return next;
}

/** L'historique sur disque (absent ou illisible : aucun historique, jamais une erreur du run). */
export async function loadHistory(file: string): Promise<TraceHistory | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<TraceHistory>;
    if (parsed.version !== 1 || !parsed.requirements || typeof parsed.requirements !== 'object')
      return undefined;
    return { version: 1, requirements: parsed.requirements };
  } catch {
    return undefined;
  }
}

export async function saveHistory(file: string, history: TraceHistory): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}
