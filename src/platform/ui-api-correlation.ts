import type { FlowRunReport, FlowStepReport, StepRequestReport } from '../model/flow-run.js';
import { declares, type ApiContract, type ContractOperation } from '../oracles/api-contract.js';
import type { Finding } from './model.js';

/**
 * UI ↔ API CORRELATION ENGINE : chaque étape d'un flow confrontée aux requêtes qu'elle a déclenchées.
 *
 * Ce qui existait : le réseau par étape (StepNetworkReport, enrichStepReport), l'effet vérifié de
 * chaque étape (StepEffectReport), le contrat d'API (ApiContract, ContractOracle) et la corrélation
 * côté enregistrement (recording-analysis). Ce qui est nouveau : la corrélation AU REJEU — l'issue
 * de l'interface et l'issue de l'API, mises côte à côte, avec un verdict par étape :
 *
 *   CONSISTENT                 l'interface et l'API racontent la même chose ;
 *   UI_SUCCESS_API_ERROR       l'écran a dit « ok », le serveur a répondu 5xx (échec silencieux) ;
 *   UI_SUCCESS_API_REJECTED    l'écran a dit « ok », le serveur a refusé (4xx) ;
 *   UI_FAILURE_API_SUCCESS     le serveur a répondu, l'écran n'a pas suivi (problème d'interface) ;
 *   WRITE_WITHOUT_API          une étape de modification sans aucune écriture réseau ;
 *   NOT_CORRELATED             aucun appel d'API pendant l'étape.
 *
 * Avec un contrat : UNDOCUMENTED_ENDPOINT, UNDOCUMENTED_RESPONSE et CONTRACT_UI_MISMATCH (l'écran a
 * réussi sur une réponse d'erreur que le contrat ne déclare pas).
 */

export type UiOutcome = 'UI_SUCCESS' | 'UI_FAILURE' | 'UI_UNKNOWN';
export type ApiOutcome = 'API_SUCCESS' | 'API_REJECTED' | 'API_ERROR' | 'NO_API';
export type CorrelationVerdict =
  | 'CONSISTENT'
  | 'UI_SUCCESS_API_ERROR'
  | 'UI_SUCCESS_API_REJECTED'
  | 'UI_FAILURE_API_SUCCESS'
  | 'WRITE_WITHOUT_API'
  | 'NOT_CORRELATED';

export type ContractIssueKind = 'UNDOCUMENTED_ENDPOINT' | 'UNDOCUMENTED_RESPONSE' | 'CONTRACT_UI_MISMATCH';

export interface ContractIssue {
  kind: ContractIssueKind;
  request: string;
  operation?: string;
  detail: string;
}

export interface CorrelationEntry {
  flow: string;
  step: number;
  description: string;
  ui: UiOutcome;
  api: ApiOutcome;
  verdict: CorrelationVerdict;
  requests: string[];
  contractIssues: ContractIssue[];
}

export interface UiApiCorrelation {
  entries: CorrelationEntry[];
  summary: Record<CorrelationVerdict, number> & { steps: number; contractIssues: number };
  findings: Finding[];
}

const API_RESOURCE = new Set(['xhr', 'fetch']);
const describe = (request: StepRequestReport): string =>
  `${request.method} ${request.path} → ${request.failure ?? String(request.status ?? '?')}`;

function uiOutcomeOf(step: FlowStepReport): UiOutcome {
  if (step.status === 'FAILED') return 'UI_FAILURE';
  if (step.status !== 'PASSED') return 'UI_UNKNOWN';
  if (!step.effect || step.effect.status === 'CONFIRMED' || step.effect.status === 'NOT_REQUIRED')
    return 'UI_SUCCESS';
  return step.effect.status === 'NOT_VERIFIED' ? 'UI_SUCCESS' : 'UI_UNKNOWN';
}

function apiOutcomeOf(requests: readonly StepRequestReport[]): ApiOutcome {
  if (requests.length === 0) return 'NO_API';
  if (requests.some((request) => request.failure !== undefined || (request.status ?? 0) >= 500))
    return 'API_ERROR';
  if (requests.some((request) => (request.status ?? 0) >= 400)) return 'API_REJECTED';
  return 'API_SUCCESS';
}

function verdictOf(step: FlowStepReport, ui: UiOutcome, api: ApiOutcome, writes: number): CorrelationVerdict {
  const mutating = step.classification === 'MUTATION' || step.classification === 'DANGEROUS';
  if (api === 'NO_API')
    return mutating && writes === 0 && step.kind === 'click' ? 'WRITE_WITHOUT_API' : 'NOT_CORRELATED';
  if (ui === 'UI_SUCCESS' && api === 'API_ERROR') return 'UI_SUCCESS_API_ERROR';
  if (ui === 'UI_SUCCESS' && api === 'API_REJECTED') return 'UI_SUCCESS_API_REJECTED';
  if (ui === 'UI_FAILURE' && api === 'API_SUCCESS') return 'UI_FAILURE_API_SUCCESS';
  return 'CONSISTENT';
}

function operationFor(contract: ApiContract, request: StepRequestReport): ContractOperation | undefined {
  return contract.operations.find(
    (operation) =>
      operation.method.toUpperCase() === request.method.toUpperCase() && operation.matcher.test(request.path),
  );
}

function contractIssuesOf(
  contract: ApiContract | undefined,
  requests: readonly StepRequestReport[],
  ui: UiOutcome,
  apiPrefixes: readonly string[],
): ContractIssue[] {
  if (!contract) return [];
  const issues: ContractIssue[] = [];
  for (const request of requests) {
    const operation = operationFor(contract, request);
    const label = describe(request);
    if (!operation) {
      if (apiPrefixes.some((prefix) => request.path.startsWith(prefix)))
        issues.push({
          kind: 'UNDOCUMENTED_ENDPOINT',
          request: label,
          detail: 'no operation in the contract matches this request',
        });
      continue;
    }
    const name = `${operation.method.toUpperCase()} ${operation.path}`;
    if (request.status !== undefined && !declares(operation.responses, request.status)) {
      issues.push({
        kind: 'UNDOCUMENTED_RESPONSE',
        request: label,
        operation: name,
        detail: `status ${String(request.status)} is not declared (${operation.responses.join(', ')})`,
      });
      if (ui === 'UI_SUCCESS' && request.status >= 400)
        issues.push({
          kind: 'CONTRACT_UI_MISMATCH',
          request: label,
          operation: name,
          detail: 'the screen reported success on an error response the contract does not declare',
        });
    }
  }
  return issues;
}

/** Les préfixes des chemins d'API vus par le contrat (/api/…) : seuls ces chemins sont jugés « non documentés ». */
export function apiPrefixesOf(contract: ApiContract): string[] {
  const prefixes = new Set<string>();
  for (const operation of contract.operations) {
    const first = operation.path.split('/').filter(Boolean)[0];
    if (first && !first.startsWith('{')) prefixes.add(`/${first}/`);
  }
  return [...prefixes];
}

/** La corrélation UI ↔ API de chaque étape des flows. */
export function correlateUiAndApi(flows: readonly FlowRunReport[], contract?: ApiContract): UiApiCorrelation {
  const prefixes = contract ? apiPrefixesOf(contract) : [];
  const entries: CorrelationEntry[] = [];
  for (const flow of flows)
    for (const step of flow.steps) {
      if (
        step.status === 'SKIPPED' ||
        step.status === 'MANUAL' ||
        step.kind === 'expect' ||
        step.kind === 'screenshot'
      )
        continue;
      const requests = (step.network?.requests ?? []).filter((request) =>
        API_RESOURCE.has(request.resourceType),
      );
      const ui = uiOutcomeOf(step);
      const api = apiOutcomeOf(requests);
      const verdict = verdictOf(step, ui, api, step.network?.writes ?? 0);
      const contractIssues = contractIssuesOf(contract, requests, ui, prefixes);
      if (verdict === 'NOT_CORRELATED' && contractIssues.length === 0) continue;
      entries.push({
        flow: flow.name,
        step: step.index,
        description: step.description,
        ui,
        api,
        verdict,
        requests: requests.map(describe),
        contractIssues,
      });
    }
  const verdicts: CorrelationVerdict[] = [
    'CONSISTENT',
    'UI_SUCCESS_API_ERROR',
    'UI_SUCCESS_API_REJECTED',
    'UI_FAILURE_API_SUCCESS',
    'WRITE_WITHOUT_API',
    'NOT_CORRELATED',
  ];
  const summary = Object.fromEntries(
    verdicts.map((verdict) => [verdict, entries.filter((entry) => entry.verdict === verdict).length]),
  ) as Record<CorrelationVerdict, number>;
  const findings: Finding[] = entries
    .filter((entry) => entry.verdict !== 'CONSISTENT' && entry.verdict !== 'NOT_CORRELATED')
    .map((entry) => ({
      conclusion: `${entry.verdict} at ${entry.flow} step ${String(entry.step)} "${entry.description}"`,
      evidence: [`ui ${entry.ui}`, `api ${entry.api}`, ...entry.requests],
      confidence: entry.verdict === 'UI_SUCCESS_API_ERROR' ? 0.9 : 0.7,
      source: 'RUNTIME' as const,
    }));
  for (const entry of entries)
    for (const issue of entry.contractIssues)
      findings.push({
        conclusion: `${issue.kind}: ${issue.request}`,
        evidence: [issue.detail, ...(issue.operation ? [`operation ${issue.operation}`] : [])],
        confidence: 0.8,
        source: 'CONTRACT',
      });
  return {
    entries,
    summary: {
      ...summary,
      steps: entries.length,
      contractIssues: entries.reduce((sum, entry) => sum + entry.contractIssues.length, 0),
    },
    findings,
  };
}
