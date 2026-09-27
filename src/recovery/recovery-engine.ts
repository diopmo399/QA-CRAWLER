import type { ActionClassification } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { redactText } from '../security/redactor.js';
import type { FailureKind, RecoveryEvent, RecoveryStrategyName } from './recovery-model.js';

export interface RecoveryOptions {
  enabled: boolean;
  /** Tried in this order; a strategy left out is never used. */
  strategies: readonly RecoveryStrategyName[];
  maxRetries: number;
  maxReauthentications: number;
}

export interface Failure {
  stateId: string;
  actionId?: string;
  kind: FailureKind;
  message?: string;
}

/**
 * How the explorer carries out each strategy. Each attempt returns the
 * observed state when it worked (the explorer checks it is the expected one),
 * undefined otherwise. A strategy the explorer cannot apply here is absent.
 */
export type RecoveryActions = Partial<
  Record<Exclude<RecoveryStrategyName, 'retry'>, () => Promise<PageContext | undefined>>
>;

/** Playwright errors worth one more try: the element moved under the click, not a real failure. */
const TRANSIENT_ERROR =
  /detached|not attached|not stable|Execution context was destroyed|element is outside of the viewport/i;

/** Without a recovery configuration: what the explorer always did (top layer, URL, replay, elsewhere). */
const MINIMAL: readonly RecoveryStrategyName[] = [
  'dismiss-dialog',
  'known-url',
  'replay-path',
  'abandon-branch',
];

/**
 * RECOVERY: after a failure, tries the configured strategies in order until
 * one brings the exploration back to a known state, and records every
 * attempt. It decides nothing about the application; it only sequences what
 * the explorer knows how to do, within limits (retries, re-authentications).
 */
export class RecoveryEngine {
  private readonly log: RecoveryEvent[] = [];
  private reauthentications = 0;

  constructor(private readonly options: RecoveryOptions) {}

  get strategies(): readonly RecoveryStrategyName[] {
    return this.options.enabled ? this.options.strategies : MINIMAL;
  }

  /** Should this failed action be executed once more (attempt: retries already made)? */
  shouldRetry(
    error: string | undefined,
    action: { classification: ActionClassification; submitsForm?: boolean },
    attempt: number,
  ): boolean {
    return (
      this.options.enabled &&
      this.options.strategies.includes('retry') &&
      attempt < this.options.maxRetries &&
      // Never twice something that may send or change data.
      action.classification === 'SAFE' &&
      action.submitsForm !== true &&
      TRANSIENT_ERROR.test(error ?? '')
    );
  }

  /** May the session be renewed once more? Counts the attempt when it may. */
  mayReauthenticate(): boolean {
    if (!this.options.enabled || !this.options.strategies.includes('reauthenticate')) return false;
    if (this.reauthentications >= this.options.maxReauthentications) return false;
    this.reauthentications += 1;
    return true;
  }

  get reauthenticationCount(): number {
    return this.reauthentications;
  }

  /** Tries the strategies in order; the first that reaches a state wins. */
  async recover(
    failure: Failure,
    actions: RecoveryActions,
  ): Promise<{ context?: PageContext; strategy?: RecoveryStrategyName }> {
    for (const strategy of this.strategies) {
      if (strategy === 'retry') continue; // decided before the failure is recorded
      if (strategy === 'reauthenticate' && failure.kind !== 'session-expired') continue;
      const attempt = actions[strategy];
      if (!attempt) continue;
      let context: PageContext | undefined;
      try {
        context = await attempt();
      } catch {
        context = undefined;
      }
      this.record(failure, strategy, context);
      if (context) return { context, strategy };
    }
    return {};
  }

  /** `reached`: the state reached, or just whether it worked. */
  record(failure: Failure, strategy: RecoveryStrategyName, reached: PageContext | boolean | undefined): void {
    const success = typeof reached === 'boolean' ? reached : reached !== undefined;
    const state = typeof reached === 'object' ? reached : undefined;
    this.log.push({
      at: new Date().toISOString(),
      stateId: failure.stateId,
      ...(failure.actionId ? { actionId: failure.actionId } : {}),
      failure: failure.kind,
      ...(failure.message ? { message: redactText(firstLine(failure.message)) } : {}),
      strategy,
      success,
      ...(state ? { reachedStateId: state.stateId } : {}),
    });
  }

  events(): RecoveryEvent[] {
    return [...this.log];
  }
}

export function firstLine(message: string): string {
  return (message.split('\n')[0] ?? message).trim().slice(0, 300);
}
