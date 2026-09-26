import type { FlowAllowance } from '../config/flow-schema.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { SafetyPolicy, SafetyVerdict } from '../policies/safety-policy.js';

export interface FlowStepPermission {
  /** Classes the step explicitly allows on top of SAFE. */
  allow: readonly FlowAllowance[];
  /** The value typed in the field comes from an environment variable. */
  valueFromEnv?: boolean;
}

/**
 * Safety gate for imposed flow steps: the YAML chose the element, the
 * SafetyPolicy still decides whether it may run.
 *
 * - SAFE: runs.
 * - MUTATION / UNKNOWN: runs only when the step says `allow: MUTATION` / `allow: UNKNOWN`.
 * - DANGEROUS (delete, pay, send, logout, irreversible…): never runs.
 * - Links: allowed hosts and ignored paths still apply.
 * - Sensitive fields (password, OTP, secret): filled only from an environment
 *   variable; payment fields (card, IBAN…) are never filled.
 */
export function evaluateFlowAction(
  safety: SafetyPolicy,
  action: DiscoveredAction,
  permission: FlowStepPermission,
): SafetyVerdict {
  const isField =
    action.type === 'fill' ||
    action.type === 'select' ||
    action.type === 'check' ||
    action.type === 'uncheck';
  if (isField) {
    if (!action.risks.includes('sensitive-data')) return { verdict: 'ALLOW', reason: action.reason };
    if (safety.isPaymentField(action)) {
      return { verdict: 'BLOCK', reason: 'payment field (card, IBAN…): never filled automatically' };
    }
    if (action.type === 'fill' && permission.valueFromEnv === true) {
      return {
        verdict: 'ALLOW',
        reason: 'sensitive field filled from an environment variable (value never logged)',
      };
    }
    return {
      verdict: 'BLOCK',
      reason:
        'sensitive field (password, secret…): its value must come from an environment variable ({ env: NAME })',
    };
  }

  if (action.classification === 'DANGEROUS') {
    return { verdict: 'BLOCK', reason: `DANGEROUS actions are never executed (${action.reason})` };
  }
  if (action.href && (action.type === 'navigate' || action.external === true)) {
    const verdict = evaluateFlowUrl(safety, action.href);
    if (verdict.verdict === 'BLOCK') return verdict;
  }
  if (action.classification === 'MUTATION' && !permission.allow.includes('MUTATION')) {
    return {
      verdict: 'BLOCK',
      reason: `MUTATION action (${action.reason}): add "allow: MUTATION" to this step to execute it`,
    };
  }
  if (action.classification === 'UNKNOWN' && !permission.allow.includes('UNKNOWN')) {
    return {
      verdict: 'BLOCK',
      reason: `UNKNOWN action (${action.reason}): add "allow: UNKNOWN" to this step to execute it`,
    };
  }
  return { verdict: 'ALLOW', reason: action.reason };
}

/** A `goto` step or a link target: allowed hosts, ignored paths, dangerous URLs. */
export function evaluateFlowUrl(safety: SafetyPolicy, href: string): SafetyVerdict {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { verdict: 'BLOCK', reason: `invalid URL ${href}` };
  }
  const classified = safety.classifyUrl(url.toString());
  if (classified.classification === 'DANGEROUS') {
    return { verdict: 'BLOCK', reason: `DANGEROUS URL is never opened (${classified.reason})` };
  }
  const decision = safety.navigation.evaluate(url);
  if (!decision.allowed) {
    return { verdict: 'BLOCK', reason: `navigation refused: ${decision.reason} (${decision.detail})` };
  }
  return { verdict: 'ALLOW', reason: 'navigation allowed' };
}
