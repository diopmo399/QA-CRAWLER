import type { ActionObservations, ExecutedAction, OracleReason, OracleResult, TestOracle } from './oracle.js';
import { result } from './oracle.js';

export interface TechnicalOracleOptions {
  /** HTTP 404 d'un appel d'API : un avertissement (défaut) ou un échec. */
  api404: 'warning' | 'fail';
}

const API_TYPES = new Set(['xhr', 'fetch']);

/**
 * Échecs techniques confirmés : action impossible, plantage de la page, exception
 * JavaScript non interceptée, HTTP 5xx. Avertissements : 404 d'API inattendu,
 * appels d'API en échec, problèmes de navigation. Un message console seul est au plus
 * un avertissement de faible confiance.
 */
export class TechnicalOracle implements TestOracle {
  readonly name = 'technical';

  constructor(private readonly options: TechnicalOracleOptions = { api404: 'warning' }) {}

  evaluate(
    _before: unknown,
    action: ExecutedAction,
    _after: unknown,
    observations: ActionObservations,
  ): Promise<OracleResult> {
    const failures: OracleReason[] = [];
    const warnings: OracleReason[] = [];
    let warningConfidence = 0;
    const warn = (reason: OracleReason, confidence: number): void => {
      warnings.push(reason);
      warningConfidence = Math.max(warningConfidence, confidence);
    };

    if (action.result === 'FAILED')
      failures.push({
        code: 'action-impossible',
        message: `the action could not be executed: ${action.error ?? 'failed'}`,
      });
    if (observations.pageCrashed) failures.push({ code: 'page-crash', message: 'the page crashed' });
    for (const exchange of observations.network) {
      const call = `${exchange.method} ${pathOf(exchange.url)}`;
      if (exchange.status !== undefined && exchange.status >= 500)
        failures.push({ code: 'http-5xx', message: `${call} returned HTTP ${exchange.status}` });
      else if (exchange.status === 404 && API_TYPES.has(exchange.resourceType)) {
        if (this.options.api404 === 'fail')
          failures.push({ code: 'api-404', message: `${call} returned HTTP 404` });
        else warn({ code: 'api-404', message: `${call} returned HTTP 404` }, 0.6);
      } else if (
        exchange.failure &&
        !/ABORTED|cancel/i.test(exchange.failure) &&
        API_TYPES.has(exchange.resourceType)
      )
        warn({ code: 'request-failed', message: `${call} failed: ${exchange.failure}` }, 0.6);
    }
    for (const issue of observations.issues) {
      if (issue.type === 'PAGE_ERROR') failures.push({ code: 'uncaught-exception', message: issue.message });
      else if (issue.type === 'PAGE_CRASH' && !observations.pageCrashed)
        failures.push({ code: 'page-crash', message: issue.message });
      else if (issue.type === 'NAVIGATION')
        warn({ code: 'navigation', message: issue.message }, /timeout/i.test(issue.message) ? 0.7 : 0.5);
      else if (issue.type === 'CONSOLE' && issue.severity === 'ERROR')
        warn({ code: 'console-error', message: issue.message }, 0.3);
    }

    if (failures.length > 0) return Promise.resolve(result(this.name, 'FAIL', 1, failures));
    if (warnings.length > 0)
      return Promise.resolve(result(this.name, 'WARNING', warningConfidence, warnings));
    return Promise.resolve(
      result(this.name, 'PASS', 0.9, [
        { code: 'executable', message: 'action executable' },
        { code: 'no-5xx', message: 'no HTTP 5xx' },
        { code: 'no-crash', message: 'no page crash nor uncaught exception' },
      ]),
    );
  }
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}
