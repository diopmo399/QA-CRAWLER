import { declares, type ApiContract } from './api-contract.js';
import type { ActionObservations, ExecutedAction, OracleReason, OracleResult, TestOracle } from './oracle.js';
import { result } from './oracle.js';
import { pathOf } from './technical-oracle.js';

/**
 * Compares each API call of the action with the contract (OpenAPI): a status
 * the operation does not declare is a potential contract violation. Calls
 * the contract does not describe are ignored; with none described, UNKNOWN.
 */
export class ContractOracle implements TestOracle {
  readonly name = 'contract';

  constructor(private readonly contract: ApiContract | undefined) {}

  evaluate(
    _before: unknown,
    _action: ExecutedAction,
    _after: unknown,
    observations: ActionObservations,
  ): Promise<OracleResult> {
    if (!this.contract)
      return Promise.resolve(
        result(this.name, 'UNKNOWN', 0, [{ code: 'no-contract', message: 'no API contract configured' }]),
      );
    const violations: OracleReason[] = [];
    const respected: OracleReason[] = [];
    for (const exchange of observations.network) {
      if (exchange.status === undefined) continue;
      const path = pathOf(exchange.url);
      const operation = this.contract.operations.find(
        (candidate) => candidate.method === exchange.method && candidate.matcher.test(path),
      );
      if (!operation) continue;
      const call = `${exchange.method} ${path}`;
      if (declares(operation.responses, exchange.status))
        respected.push({ code: 'contract-respected', message: `${call} → ${exchange.status} (declared)` });
      else
        violations.push({
          code: 'contract-violation',
          message: `${call} → ${exchange.status}, expected one of ${operation.responses.join(', ')} (${operation.method} ${operation.path})`,
        });
    }
    if (violations.length > 0) return Promise.resolve(result(this.name, 'WARNING', 0.7, violations));
    if (respected.length > 0) return Promise.resolve(result(this.name, 'PASS', 0.8, respected));
    return Promise.resolve(
      result(this.name, 'UNKNOWN', 0, [
        { code: 'not-in-contract', message: 'no API call of this action is described by the contract' },
      ]),
    );
  }
}
