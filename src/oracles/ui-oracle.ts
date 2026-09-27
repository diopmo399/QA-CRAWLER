import type { PageContext } from '../model/page-context.js';
import { KeywordMatcher } from '../policies/keywords.js';
import type { ActionObservations, ExecutedAction, OracleReason, OracleResult, TestOracle } from './oracle.js';
import { result } from './oracle.js';

export const DEFAULT_ERROR_TEXTS = [
  'error',
  'erreur',
  'failed',
  'failure',
  'echec',
  'impossible',
  'unable',
  'invalid',
  'invalide',
  'refused',
  'refuse',
  'exception',
  'something went wrong',
  'une erreur est survenue',
] as const;

/**
 * What the screen shows after the action: an error banner, alert or
 * snackbar that just appeared, a form still invalid after valid data, an
 * empty screen, a spinner that does not stop. Only warnings: a banner may be
 * the expected answer. Nothing visible does not prove success — PASS with a
 * low confidence.
 */
export class UIOracle implements TestOracle {
  readonly name = 'ui';
  private readonly errorWords: KeywordMatcher;

  constructor(errorTexts: readonly string[] = DEFAULT_ERROR_TEXTS) {
    this.errorWords = new KeywordMatcher(errorTexts);
  }

  evaluate(
    _before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
  ): Promise<OracleResult> {
    const signals = observations.after;
    if (!after || !signals)
      return Promise.resolve(
        result(this.name, 'UNKNOWN', 0, [
          { code: 'no-observation', message: 'the screen after the action is not known' },
        ]),
      );
    const reasons: OracleReason[] = [];
    let confidence = 0;
    const warn = (reason: OracleReason, weight: number): void => {
      reasons.push(reason);
      confidence = Math.max(confidence, weight);
    };
    const before = new Set(observations.before?.alerts ?? []);
    for (const alert of signals.alerts) {
      if (before.has(alert)) continue;
      const word = this.errorWords.match(alert);
      if (word) warn({ code: 'error-message', message: `error message shown: "${alert}"` }, 0.6);
    }
    if (observations.formFilledWithValidData && action.submitsForm && signals.invalidFields > 0)
      warn(
        {
          code: 'form-still-invalid',
          message: `${signals.invalidFields} field(s) still invalid after valid data`,
        },
        0.5,
      );
    if (signals.empty && !observations.before?.empty)
      warn({ code: 'empty-screen', message: 'the screen is empty' }, 0.5);
    if (signals.busy)
      warn({ code: 'still-loading', message: 'still loading after the action (spinner)' }, 0.4);
    if (reasons.length > 0) return Promise.resolve(result(this.name, 'WARNING', confidence, reasons));
    return Promise.resolve(
      result(this.name, 'PASS', 0.5, [{ code: 'no-error-shown', message: 'no error message shown' }]),
    );
  }
}
