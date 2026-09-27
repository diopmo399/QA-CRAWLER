import { transitionKey } from '../diff/flow-diff.js';
import type { FlowGraphData } from '../model/flow.js';
import type { PageContext } from '../model/page-context.js';
import type { ActionObservations, ExecutedAction, OracleResult, TestOracle } from './oracle.js';
import { result } from './oracle.js';

/**
 * Compare le résultat avec ce que la baseline a appris pour la même action depuis
 * le même état. Une différence est une RÉGRESSION POTENTIELLE — un avertissement,
 * jamais un échec confirmé : l'application a peut-être simplement changé.
 */
export class BaselineOracle implements TestOracle {
  readonly name = 'baseline';
  private readonly known = new Map<string, { to: string; toLabel: string; result: string }>();

  constructor(baseline: FlowGraphData | undefined) {
    if (!baseline) return;
    const labels = new Map(baseline.nodes.map((node) => [node.id, node.label]));
    for (const edge of baseline.edges) {
      if (edge.result === 'BLOCKED') continue;
      this.known.set(transitionKey(edge), {
        to: edge.to,
        toLabel: labels.get(edge.to) ?? edge.to,
        result: edge.result,
      });
    }
  }

  evaluate(
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    _observations: ActionObservations,
  ): Promise<OracleResult> {
    const expected = this.known.get(
      transitionKey({
        from: before.stateId,
        action: {
          type: action.type,
          text: action.text,
          href: action.href,
          category: action.category,
          classification: action.classification,
        },
      }),
    );
    if (!expected)
      return Promise.resolve(
        result(this.name, 'UNKNOWN', 0, [
          { code: 'not-in-baseline', message: 'this transition is not in the baseline' },
        ]),
      );
    if (action.result === 'FAILED' || !after) {
      return Promise.resolve(
        result(
          this.name,
          expected.result === 'SUCCESS' ? 'WARNING' : 'PASS',
          expected.result === 'SUCCESS' ? 0.7 : 0.6,
          [
            expected.result === 'SUCCESS'
              ? {
                  code: 'regression-potential',
                  message: `worked in the baseline (reached ${expected.toLabel}), fails now`,
                }
              : { code: 'same-as-baseline', message: 'failed in the baseline too' },
          ],
        ),
      );
    }
    if (after.stateId === expected.to)
      return Promise.resolve(
        result(this.name, 'PASS', 0.9, [
          { code: 'same-as-baseline', message: `reached ${expected.toLabel}, as in the baseline` },
        ]),
      );
    return Promise.resolve(
      result(this.name, 'WARNING', 0.55, [
        {
          code: 'regression-potential',
          message: `resulting state differs from baseline: expected ${expected.toLabel}, observed ${after.stateLabel}`,
        },
      ]),
    );
  }
}
