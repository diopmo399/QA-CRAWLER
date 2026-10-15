import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowRunReport, FlowStepReport, StepRequestReport } from '../model/flow-run.js';
import type { Issue, IssueType } from '../model/issue.js';
import { EXPECTED_CATEGORIES, type AnomalyCategory, type Finding, type RunAnomaly } from './model.js';

/**
 * RUN ANOMALY ANALYZER : chaque symptôme du run (étape échouée, requête en erreur, anomalie
 * levée par les observateurs et les oracles) devient UNE anomalie catégorisée, avec son
 * symptôme, sa cause probable et, quand une preuve directe existe, sa cause confirmée.
 *
 * Ce qui existait : les issues (IssueCollector, oracles, observateurs), la divergence analysée de
 * chaque étape (WorkflowHealer / DivergenceAnalyzer), le réseau par étape (StepNetworkReport).
 * Ce qui est nouveau : la catégorisation unique (UI / fonctionnel / API / réseau / contrat /
 * autorisation / données / attendu / technique / inconnu) et la distinction symptôme ↔ cause.
 * Règle absolue : un refus que le parcours attendait (l'étape a RÉUSSI malgré un 4xx) n'est pas
 * un défaut, c'est une EXPECTED_VALIDATION ou une EXPECTED_BUSINESS_REJECTION.
 */

const AUTH_CATEGORIES = new Set(['AUTH_CONTEXT_DIVERGENCE', 'PERMISSION_DENIED', 'SESSION_EXPIRED']);
const TARGET_CATEGORIES = new Set([
  'TARGET_RENAMED',
  'TARGET_MOVED',
  'TARGET_NOT_FOUND',
  'TARGET_FINGERPRINT_MISMATCH',
  'WRONG_TAB_SELECTED',
  'PARENT_SECTION_CLOSED',
  'TARGET_CONTEXT_MISMATCH',
]);

const ISSUE_CATEGORY: Record<IssueType, AnomalyCategory | undefined> = {
  HTTP: 'API_FAILURE',
  REQUEST_FAILED: 'NETWORK_FAILURE',
  BROKEN_LINK: 'UI_FAILURE',
  CONSOLE: 'TECHNICAL_FAILURE',
  PAGE_ERROR: 'TECHNICAL_FAILURE',
  PAGE_CRASH: 'TECHNICAL_FAILURE',
  NAVIGATION: 'UI_FAILURE',
  FLOW: undefined, // porté par l'étape elle-même
  BROWSER_INTERACTION: 'TECHNICAL_FAILURE',
  FORM_VALIDATION: 'EXPECTED_VALIDATION',
  UI_ERROR: 'UI_FAILURE',
  REGRESSION: 'FUNCTIONAL_FAILURE',
  CONTRACT: 'CONTRACT_FAILURE',
  ACCESSIBILITY: 'UI_FAILURE',
  AUTHORIZATION: 'AUTHORIZATION_FAILURE',
  // Un invariant d'écran (« aucune erreur serveur », « un total jamais négatif »…) : un défaut fonctionnel.
  // Les invariants d'ACCÈS (ISSUE-INV-…) sont des autorisations : voir issueCategory.
  INVARIANT: 'FUNCTIONAL_FAILURE',
  WRITE_BLOCKED: undefined, // une décision de sécurité, pas un défaut de l'application
  UNEXPECTED_BEHAVIOR: 'FUNCTIONAL_FAILURE',
  PERFORMANCE: 'PERFORMANCE_REGRESSION',
  FUNCTIONAL: 'FUNCTIONAL_FAILURE',
};

const describeRequest = (request: StepRequestReport): string =>
  `${request.method} ${request.path} → ${request.failure ?? String(request.status ?? '?')}`;

function requestErrors(step: FlowStepReport): StepRequestReport[] {
  return (step.network?.requests ?? []).filter(
    (request) => request.failure !== undefined || (request.status !== undefined && request.status >= 400),
  );
}

/** Le statut HTTP le plus parlant d'une étape : d'abord une erreur serveur, puis un refus, puis le reste. */
function worstStatus(errors: readonly StepRequestReport[]): StepRequestReport | undefined {
  return (
    errors.find((entry) => (entry.status ?? 0) >= 500) ??
    errors.find((entry) => entry.failure !== undefined) ??
    errors.find((entry) => entry.status === 401 || entry.status === 403) ??
    errors[0]
  );
}

function stepFinding(step: FlowStepReport): { probable?: Finding; confirmed?: Finding } {
  const divergence = step.recovery?.divergence;
  if (!divergence) return {};
  const evidence = divergence.evidence.map((entry) => `${entry.source}: ${entry.detail}`);
  const cause = divergence.functionalRootCause ?? divergence.possibleCauses[0];
  const finding: Finding = {
    conclusion: cause
      ? `${cause.category} (root step ${String(divergence.rootStepIndex)})`
      : divergence.category,
    evidence,
    confidence: cause?.confidence ?? divergence.confidence,
    source: 'RUNTIME',
  };
  // Une cause n'est CONFIRMÉE que par une preuve directe au runtime (confiance ≥ 0,9 des moteurs).
  return finding.confidence >= 0.9 ? { confirmed: finding } : { probable: finding };
}

function categorizeFailedStep(step: FlowStepReport): {
  category: AnomalyCategory;
  confidence: number;
  why: string;
} {
  const divergence = step.recovery?.divergence;
  const reason = (step.reason ?? '').toLowerCase();
  if (divergence && AUTH_CATEGORIES.has(divergence.category))
    return { category: 'AUTHORIZATION_FAILURE', confidence: 0.9, why: `divergence ${divergence.category}` };
  if (/not authori[sz]ed|forbidden|permission|access denied|session expired|login page/.test(reason))
    return {
      category: 'AUTHORIZATION_FAILURE',
      confidence: 0.75,
      why: 'the failure names access or session',
    };
  const errors = requestErrors(step);
  const worst = worstStatus(errors);
  if (worst?.failure !== undefined)
    return { category: 'NETWORK_FAILURE', confidence: 0.85, why: describeRequest(worst) };
  if (worst?.status !== undefined && worst.status >= 500)
    return { category: 'API_FAILURE', confidence: 0.85, why: describeRequest(worst) };
  if (worst?.status === 401 || worst?.status === 403)
    return { category: 'AUTHORIZATION_FAILURE', confidence: 0.85, why: describeRequest(worst) };
  if (worst?.status === 409)
    return {
      category: 'DATA_FAILURE',
      confidence: 0.8,
      why: `${describeRequest(worst)} (conflict on the data)`,
    };
  if (divergence && TARGET_CATEGORIES.has(divergence.category))
    return { category: 'UI_FAILURE', confidence: 0.85, why: `divergence ${divergence.category}` };
  if (step.targetResolution && step.targetResolution.status !== 'TARGET_FUNCTIONALLY_EQUIVALENT')
    return {
      category: 'UI_FAILURE',
      confidence: 0.7,
      why: `target resolution ${step.targetResolution.status}`,
    };
  if (/not found|no element|locator|timeout|not visible|detached|strict mode/.test(reason))
    return { category: 'UI_FAILURE', confidence: 0.7, why: 'the target could not be used' };
  if (worst?.status !== undefined && worst.status >= 400)
    return {
      category: 'FUNCTIONAL_FAILURE',
      confidence: 0.7,
      why: `${describeRequest(worst)}: the server rejected the submitted data`,
    };
  if (
    step.kind === 'expect' ||
    step.effect?.status === 'NO_EFFECT' ||
    step.effect?.status === 'WRONG_EFFECT' ||
    /no effect|expected|not observed|did not/.test(reason)
  )
    return { category: 'FUNCTIONAL_FAILURE', confidence: 0.65, why: 'the expected effect was not observed' };
  if (/crash|navigation|page closed|net::/.test(reason))
    return { category: 'TECHNICAL_FAILURE', confidence: 0.6, why: 'the browser or the page failed' };
  return { category: 'UNKNOWN_FAILURE', confidence: 0.3, why: 'no rule recognises this symptom' };
}

function stepAnomaly(
  flow: FlowRunReport,
  step: FlowStepReport,
  id: string,
  issueIds: string[],
): RunAnomaly | undefined {
  const location = {
    flow: flow.name,
    step: step.index,
    ...(step.stateId ? { stateId: step.stateId } : {}),
    ...(step.url ? { url: step.url } : {}),
  };
  const errors = requestErrors(step);
  if (step.status === 'PASSED') {
    // Un refus attendu par le parcours : l'application a dit non, l'étape l'a vérifié — mais seulement si le
    // parcours a ensuite réussi : un refus suivi d'un échec est une PREUVE de cet échec, pas un refus attendu.
    const refusal = errors.find(
      (entry) => entry.status !== undefined && entry.status >= 400 && entry.status < 500,
    );
    if (!refusal) return undefined;
    if (flow.steps.some((later) => later.index > step.index && later.status === 'FAILED')) return undefined;
    const business = refusal.status === 409 || refusal.status === 412 || refusal.status === 423;
    return {
      id,
      category: business ? 'EXPECTED_BUSINESS_REJECTION' : 'EXPECTED_VALIDATION',
      severity: 'INFO',
      symptom: `${describeRequest(refusal)} while step ${String(step.index)} "${step.description}" passed`,
      evidence: [describeRequest(refusal), `step ${String(step.index)} status PASSED`],
      confidence: 0.7,
      source: 'RUNTIME',
      location,
      issueIds,
    };
  }
  if (step.status === 'BLOCKED') {
    if (!/authori|permission|session|login/i.test(step.reason ?? '')) return undefined;
    return {
      id,
      category: 'AUTHORIZATION_FAILURE',
      severity: 'ERROR',
      symptom: `step ${String(step.index)} "${step.description}" blocked: ${step.reason ?? ''}`,
      evidence: [step.reason ?? 'blocked'],
      confidence: 0.7,
      source: 'RUNTIME',
      location,
      issueIds,
    };
  }
  if (step.status !== 'FAILED') return undefined;
  const { category, confidence, why } = categorizeFailedStep(step);
  const finding = stepFinding(step);
  // Les refus et erreurs réseau des étapes PRÉCÉDENTES du flow : le signal antérieur d'un symptôme plus loin.
  const earlier = flow.steps
    .filter((previous) => previous.index < step.index)
    .flatMap((previous) =>
      requestErrors(previous).map(
        (request) => `${describeRequest(request)} at step ${String(previous.index)}`,
      ),
    );
  const probable =
    finding.probable ??
    (!finding.confirmed && earlier.length > 0
      ? {
          conclusion: `an earlier request was refused or failed: ${earlier[0] ?? ''}`,
          evidence: earlier,
          confidence: 0.5,
          source: 'RUNTIME' as const,
        }
      : undefined);
  const confirmed = finding.confirmed;
  const evidence = [
    ...(step.reason ? [step.reason] : []),
    why,
    ...errors.map(describeRequest),
    ...earlier.map((entry) => `earlier: ${entry}`),
    ...(step.effect
      ? [
          `effect ${step.effect.status}${step.effect.observed.length > 0 ? `: ${step.effect.observed.join(', ')}` : ''}`,
        ]
      : []),
    ...(step.screenshot ? [`screenshot ${step.screenshot}`] : []),
  ];
  return {
    id,
    category,
    severity: step.optional ? 'WARNING' : 'ERROR',
    symptom: `step ${String(step.index)} "${step.description}" failed${step.reason ? `: ${step.reason}` : ''}`,
    ...(probable ? { probableCause: probable } : {}),
    ...(confirmed ? { confirmedCause: confirmed } : {}),
    evidence: [...new Set(evidence)],
    confidence,
    source: 'RUNTIME',
    location,
    issueIds,
  };
}

function issueCategory(issue: Issue): { category: AnomalyCategory; confidence: number } | undefined {
  if (issue.type === 'HTTP') {
    const status = issue.status ?? 0;
    if (status >= 500) return { category: 'API_FAILURE', confidence: 0.85 };
    if (status === 401 || status === 403) return { category: 'AUTHORIZATION_FAILURE', confidence: 0.8 };
    if (status === 404) return { category: 'API_FAILURE', confidence: 0.6 };
    if (status === 409) return { category: 'EXPECTED_BUSINESS_REJECTION', confidence: 0.6 };
    if (status >= 400) return { category: 'EXPECTED_VALIDATION', confidence: 0.55 };
    return { category: 'API_FAILURE', confidence: 0.4 };
  }
  // Les invariants d'accès (« l'acteur user n'accède pas à /admin/** ») portent le préfixe ISSUE-INV- (orchestrateur).
  if (issue.type === 'INVARIANT' && issue.id.startsWith('ISSUE-INV-'))
    return { category: 'AUTHORIZATION_FAILURE', confidence: 0.75 };
  const category = ISSUE_CATEGORY[issue.type];
  return category ? { category, confidence: issue.type === 'UNEXPECTED_BEHAVIOR' ? 0.5 : 0.75 } : undefined;
}

function issueAnomaly(issue: Issue, id: string): RunAnomaly | undefined {
  const mapped = issueCategory(issue);
  if (!mapped) return undefined;
  const request = issue.requestUrl
    ? `${issue.method ?? 'GET'} ${issue.requestUrl}${issue.status !== undefined ? ` → ${String(issue.status)}` : ''}`
    : undefined;
  return {
    id,
    category: mapped.category,
    severity: EXPECTED_CATEGORIES.includes(mapped.category) ? 'INFO' : issue.severity,
    symptom: issue.message,
    evidence: [
      ...(request ? [request] : []),
      `seen ${String(issue.occurrences)} time(s) on ${String(issue.pages.length)} page(s)`,
      ...(issue.screenshot ? [`screenshot ${issue.screenshot}`] : []),
    ],
    confidence: mapped.confidence,
    source: issue.type === 'CONTRACT' ? 'CONTRACT' : 'RUNTIME',
    location: {
      ...(issue.stateId ? { stateId: issue.stateId } : {}),
      ...(issue.pageUrl ? { url: issue.pageUrl } : {}),
    },
    ...(issue.flow && issue.flow.length > 0 ? { reproductionPath: issue.flow } : {}),
    issueIds: [issue.id],
  };
}

/** Les anomalies du run, dans l'ordre : étapes des flows (dans l'ordre du parcours), puis les autres issues. */
export function analyzeAnomalies(result: ExplorationResult): RunAnomaly[] {
  const anomalies: RunAnomaly[] = [];
  const consumed = new Set<string>();
  let sequence = 0;
  const nextId = (): string => `ANOMALY-${String(++sequence).padStart(3, '0')}`;
  for (const flow of result.flows)
    for (const step of flow.steps) {
      // Les issues FLOW de cette étape (« Flow "x" — step 3: … ») lui appartiennent.
      const own = result.issues.filter(
        (issue) =>
          issue.type === 'FLOW' &&
          flow.issueIds.includes(issue.id) &&
          issue.message.includes(`step ${String(step.index)}`) &&
          issue.message.includes(`"${flow.name}"`),
      );
      const anomaly = stepAnomaly(
        flow,
        step,
        nextId(),
        own.map((issue) => issue.id),
      );
      if (!anomaly) {
        sequence -= 1;
        continue;
      }
      for (const issue of own) consumed.add(issue.id);
      anomalies.push(anomaly);
    }
  for (const issue of result.issues) {
    if (consumed.has(issue.id) || issue.type === 'FLOW') continue;
    const anomaly = issueAnomaly(issue, nextId());
    if (anomaly) anomalies.push(anomaly);
    else sequence -= 1;
  }
  return anomalies;
}

/** Les anomalies qui comptent comme défauts (ni attendues, ni de simples informations). */
export function defects(anomalies: readonly RunAnomaly[]): RunAnomaly[] {
  return anomalies.filter(
    (anomaly) => !EXPECTED_CATEGORIES.includes(anomaly.category) && anomaly.severity !== 'INFO',
  );
}
