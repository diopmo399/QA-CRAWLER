import type { FlowRunReport, StepRequestReport } from '../model/flow-run.js';
import {
  declares,
  type ApiContract,
  type ContractFieldSchema,
  type ContractOperation,
} from '../oracles/api-contract.js';
import { apiPrefixesOf, type UiApiCorrelation } from './ui-api-correlation.js';
import type { Finding } from './model.js';

/**
 * OPENAPI API TESTING : ContractAnalyzer → API Test Model → Runtime API Tests → API Test Oracle.
 *
 * Ce qui existait : le contrat (OpenApiContractProvider, parseOpenApi, declares), utilisé comme
 * oracle des requêtes vues au passage (ContractOracle) et corrélé statiquement
 * (RuntimeContractCorrelator). Ce qui est nouveau : des TESTS d'API dérivés du contrat et
 * exécutés dans la session authentifiée du run — seulement des méthodes sûres (GET par défaut :
 * la SafetyPolicy interdit à la plateforme d'écrire hors d'un flow), sur des chemins que le run a
 * réellement observés (les paramètres de chemin viennent des requêtes de l'interface, jamais
 * inventés). L'oracle rend UNEXPECTED_STATUS, SCHEMA_DRIFT, API_FAILURE ou PASS, et le contrat est
 * confronté au réseau du run : CONTRACT_RUNTIME_MISMATCH, UNDOCUMENTED_ENDPOINT.
 */

export type ApiTestVerdict =
  'PASS' | 'UNEXPECTED_STATUS' | 'SCHEMA_DRIFT' | 'API_FAILURE' | 'SKIPPED' | 'ERROR';

export interface ApiTestCase {
  id: string;
  method: string;
  /** Chemin concret, masqué (les valeurs de paramètres viennent du run). */
  path: string;
  operation: string;
  expectedStatuses: string[];
  source: 'OBSERVED_PATH' | 'LITERAL_PATH';
  /** Non exécutable : pourquoi. */
  skipped?: string;
}

export interface ApiTestModel {
  source: string;
  operations: number;
  tests: ApiTestCase[];
  /** Opérations du contrat sans cas de test (méthode non sûre, paramètre sans valeur observée). */
  untested: { operation: string; reason: string }[];
}

export interface ApiResponse {
  status: number;
  contentType?: string;
  body?: unknown;
  durationMs?: number;
  /** Erreur réseau (le serveur n'a pas répondu). */
  failure?: string;
}

export type ApiRequester = (method: string, path: string) => Promise<ApiResponse>;

export interface ApiTestResult {
  test: ApiTestCase;
  verdict: ApiTestVerdict;
  status?: number;
  durationMs?: number;
  reasons: string[];
}

export type RuntimeMismatchKind = 'CONTRACT_RUNTIME_MISMATCH' | 'UNDOCUMENTED_ENDPOINT';

export interface RuntimeMismatch {
  kind: RuntimeMismatchKind;
  request: string;
  operation?: string;
  detail: string;
  /** Où (flow, étape). */
  at: string[];
}

export interface ApiAnalysis {
  correlation: UiApiCorrelation;
  contract?: {
    source: string;
    operations: number;
    model: ApiTestModel;
    results: ApiTestResult[];
    runtimeMismatches: RuntimeMismatch[];
    summary: Record<ApiTestVerdict, number>;
  };
  findings: Finding[];
}

export interface ApiTestingOptions {
  methods: readonly string[];
  maxOperations: number;
}

const describe = (request: StepRequestReport): string =>
  `${request.method} ${request.path} → ${request.failure ?? String(request.status ?? '?')}`;

/** Les requêtes d'API (xhr/fetch) du run, avec l'étape qui les a envoyées. */
export function observedRequests(
  flows: readonly FlowRunReport[],
): { request: StepRequestReport; at: string }[] {
  const observed: { request: StepRequestReport; at: string }[] = [];
  for (const flow of flows)
    for (const step of flow.steps)
      for (const request of step.network?.requests ?? [])
        if (request.resourceType === 'xhr' || request.resourceType === 'fetch')
          observed.push({ request, at: `${flow.name}#${String(step.index)}` });
  return observed;
}

function operationName(operation: ContractOperation): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

/** CONTRACT ANALYZER : du contrat (et des chemins observés) au modèle de tests. */
export function buildApiTestModel(
  contract: ApiContract,
  observed: readonly { request: StepRequestReport; at: string }[],
  options: ApiTestingOptions,
): ApiTestModel {
  const tests: ApiTestCase[] = [];
  const untested: ApiTestModel['untested'] = [];
  const safe = new Set(options.methods.map((method) => method.toUpperCase()));
  let sequence = 0;
  for (const operation of contract.operations) {
    const method = operation.method.toUpperCase();
    const name = operationName(operation);
    if (!safe.has(method)) {
      untested.push({
        operation: name,
        reason: `method ${method} is not in apiTesting.methods (writes are never generated)`,
      });
      continue;
    }
    if (tests.length >= options.maxOperations) {
      untested.push({
        operation: name,
        reason: `apiTesting.maxOperations (${String(options.maxOperations)}) reached`,
      });
      continue;
    }
    const parameterised = /\{[^}]+\}/.test(operation.path);
    const concrete = parameterised
      ? observed.find(
          (entry) =>
            entry.request.method.toUpperCase() === method && operation.matcher.test(entry.request.path),
        )?.request.path
      : operation.path;
    if (!concrete) {
      untested.push({ operation: name, reason: 'path parameter without an observed value in this run' });
      continue;
    }
    tests.push({
      id: `API-${String(++sequence).padStart(3, '0')}`,
      method,
      path: concrete,
      operation: name,
      expectedStatuses: operation.responses,
      source: parameterised ? 'OBSERVED_PATH' : 'LITERAL_PATH',
    });
  }
  return { source: contract.source, operations: contract.operations.length, tests, untested };
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string | undefined, actual: string, schema: ContractFieldSchema): boolean {
  if (!expected) return true;
  if (actual === 'null') return schema.nullable === true;
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

/** API TEST ORACLE : la réponse confrontée au contrat (statut déclaré, schéma de la réponse). */
export function judgeApiResponse(
  test: ApiTestCase,
  response: ApiResponse,
  operation: ContractOperation | undefined,
): ApiTestResult {
  const base = { test, ...(response.durationMs !== undefined ? { durationMs: response.durationMs } : {}) };
  if (response.failure)
    return { ...base, verdict: 'ERROR', reasons: [`network failure: ${response.failure}`] };
  const status = response.status;
  if (status >= 500)
    return { ...base, verdict: 'API_FAILURE', status, reasons: [`server error ${String(status)}`] };
  if (!declares(test.expectedStatuses, status))
    return {
      ...base,
      verdict: 'UNEXPECTED_STATUS',
      status,
      reasons: [`status ${String(status)} is not declared (${test.expectedStatuses.join(', ')})`],
    };
  const schema = operation?.responseSchemas?.[String(status)];
  const body = response.body;
  if (schema && body !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const reasons: string[] = [];
    for (const field of schema.required)
      if (!(field in record)) reasons.push(`required field "${field}" is missing`);
    for (const [field, definition] of Object.entries(schema.fields)) {
      if (!(field in record)) continue;
      const actual = typeOf(record[field]);
      if (!typeMatches(definition.type, actual, definition))
        reasons.push(`field "${field}" is ${actual}, the contract says ${definition.type ?? '?'}`);
    }
    if (reasons.length > 0) return { ...base, verdict: 'SCHEMA_DRIFT', status, reasons };
  }
  return { ...base, verdict: 'PASS', status, reasons: [] };
}

/** RUNTIME API TESTS : exécute le modèle avec le client fourni (la session authentifiée du run). */
export async function runApiTests(
  model: ApiTestModel,
  contract: ApiContract,
  request: ApiRequester,
): Promise<ApiTestResult[]> {
  const results: ApiTestResult[] = [];
  for (const test of model.tests) {
    if (test.skipped) {
      results.push({ test, verdict: 'SKIPPED', reasons: [test.skipped] });
      continue;
    }
    const operation = contract.operations.find((entry) => operationName(entry) === test.operation);
    const started = Date.now();
    try {
      const response = await request(test.method, test.path);
      results.push(judgeApiResponse(test, { durationMs: Date.now() - started, ...response }, operation));
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      results.push(judgeApiResponse(test, { status: 0, failure: reason ?? 'request failed' }, operation));
    }
  }
  return results;
}

/** Le contrat confronté au réseau RÉEL du run : statuts non déclarés, points d'entrée inconnus. */
export function runtimeMismatches(
  contract: ApiContract,
  observed: readonly { request: StepRequestReport; at: string }[],
): RuntimeMismatch[] {
  const prefixes = apiPrefixesOf(contract);
  const byKey = new Map<string, RuntimeMismatch>();
  for (const { request, at } of observed) {
    const operation = contract.operations.find(
      (entry) =>
        entry.method.toUpperCase() === request.method.toUpperCase() && entry.matcher.test(request.path),
    );
    const label = describe(request);
    let mismatch: RuntimeMismatch | undefined;
    if (!operation) {
      if (prefixes.some((prefix) => request.path.startsWith(prefix)))
        mismatch = {
          kind: 'UNDOCUMENTED_ENDPOINT',
          request: label,
          detail: 'no operation in the contract matches this request',
          at: [],
        };
    } else if (request.status !== undefined && !declares(operation.responses, request.status)) {
      mismatch = {
        kind: 'CONTRACT_RUNTIME_MISMATCH',
        request: label,
        operation: operationName(operation),
        detail: `status ${String(request.status)} observed, declared: ${operation.responses.join(', ')}`,
        at: [],
      };
    }
    if (!mismatch) continue;
    const key = `${mismatch.kind}|${mismatch.request}`;
    const existing = byKey.get(key);
    if (existing) existing.at.push(at);
    else byKey.set(key, { ...mismatch, at: [at] });
  }
  return [...byKey.values()];
}

/** L'analyse d'API complète : corrélation UI ↔ API, et le contrat quand il y en a un. */
export function buildApiAnalysis(
  correlation: UiApiCorrelation,
  contract?: {
    contract: ApiContract;
    model: ApiTestModel;
    results: ApiTestResult[];
    observed: readonly { request: StepRequestReport; at: string }[];
  },
): ApiAnalysis {
  const findings: Finding[] = [...correlation.findings];
  if (!contract) return { correlation, findings };
  const verdicts: ApiTestVerdict[] = [
    'PASS',
    'UNEXPECTED_STATUS',
    'SCHEMA_DRIFT',
    'API_FAILURE',
    'SKIPPED',
    'ERROR',
  ];
  const summary = Object.fromEntries(
    verdicts.map((verdict) => [
      verdict,
      contract.results.filter((result) => result.verdict === verdict).length,
    ]),
  ) as Record<ApiTestVerdict, number>;
  const mismatches = runtimeMismatches(contract.contract, contract.observed);
  for (const result of contract.results)
    if (result.verdict !== 'PASS' && result.verdict !== 'SKIPPED')
      findings.push({
        conclusion: `${result.verdict}: ${result.test.method} ${result.test.path}`,
        evidence: [
          ...result.reasons,
          `operation ${result.test.operation}`,
          `path source ${result.test.source}`,
        ],
        confidence: result.verdict === 'ERROR' ? 0.5 : 0.9,
        source: 'CONTRACT',
      });
  for (const mismatch of mismatches)
    findings.push({
      conclusion: `${mismatch.kind}: ${mismatch.request}`,
      evidence: [mismatch.detail, `seen at ${mismatch.at.join(', ')}`],
      confidence: 0.8,
      source: 'CONTRACT',
    });
  return {
    correlation,
    contract: {
      source: contract.contract.source,
      operations: contract.contract.operations.length,
      model: contract.model,
      results: contract.results,
      runtimeMismatches: mismatches,
      summary,
    },
    findings,
  };
}
