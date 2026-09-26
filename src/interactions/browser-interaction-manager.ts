import type { BrowserInteractionsConfig } from '../config/config.js';
import type { InteractionDecision, InteractionPolicy } from '../policies/interaction-policy.js';
import { originOf } from '../policies/origin-policy.js';
import { redactText, redactUrl } from '../security/redactor.js';
import type { CredentialProvider } from './credential-provider.js';
import type { BrowserInteractionHandler, HandlerOutcome } from './handler.js';
import type {
  BrowserInteraction,
  BrowserInteractionResult,
  BrowserInteractionType,
  InteractionContext,
  InteractionDetails,
} from './types.js';

export interface BrowserInteractionManagerOptions {
  config: BrowserInteractionsConfig;
  policy: InteractionPolicy;
  credentials: CredentialProvider;
  /** Where the crawl is (state, action, flow), for attribution and loop detection. */
  crawlContext?: () => InteractionContext;
  /** Called with every recorded result (flow graph, issues, CLI). */
  onResult?: (result: BrowserInteractionResult) => void;
  /** Structured log line, e.g. `[BROWSER_INTERACTION] type=HTTP_AUTH status=HANDLED …`. Never contains a secret. */
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Central place for everything the browser raises outside the DOM.
 *
 *   detect (BrowserEventDiscovery) → loop guard → handler lookup →
 *   SafetyPolicy (InteractionPolicy) → handler (with retry count and
 *   timeout) → record → the crawl engine resumes.
 *
 * The crawl engine never talks to handlers: it only reads the results
 * (e.g. to stop a flow on AUTH_REQUIRED). New interactions are supported by
 * registering a handler.
 */
export class BrowserInteractionManager {
  private readonly handlers: BrowserInteractionHandler[] = [];
  private readonly recorded: BrowserInteractionResult[] = [];
  /** Occurrences per (type, origin, action): loop detection. */
  private readonly occurrences = new Map<string, number>();
  /** Tries per (type, origin, realm, action) and the last result: retry accounting. */
  private readonly attempts = new Map<string, { count: number; last: BrowserInteractionResult }>();
  private sequence = 0;

  constructor(private readonly options: BrowserInteractionManagerOptions) {}

  register(handler: BrowserInteractionHandler): this {
    this.handlers.push(handler);
    return this;
  }

  handlerFor(type: BrowserInteractionType): BrowserInteractionHandler | undefined {
    return this.handlers.find((handler) => handler.handles.includes(type));
  }

  nextId(): string {
    this.sequence += 1;
    return `BI-${String(this.sequence).padStart(4, '0')}`;
  }

  async dispatch(interaction: BrowserInteraction): Promise<BrowserInteractionResult> {
    const crawl = this.options.crawlContext?.() ?? {};
    const origin = interaction.origin ?? originOf(interaction.targetUrl ?? interaction.sourceUrl);

    // 1. Loop protection: the same interaction over and over is never retried forever.
    const loopKey = [interaction.type, origin ?? '', crawl.actionId ?? crawl.stateId ?? ''].join('|');
    const occurrences = (this.occurrences.get(loopKey) ?? 0) + 1;
    this.occurrences.set(loopKey, occurrences);
    if (occurrences > this.options.config.loopThreshold) {
      await this.safely(interaction.fallback());
      return this.record(interaction, crawl, {
        status: 'BLOCKED',
        outcome: 'INTERACTION_LOOP_DETECTED',
        action: 'STOP',
        success: false,
        blocking: true,
        reason: `${interaction.type} raised ${occurrences} times for the same origin and action (loopThreshold ${this.options.config.loopThreshold})`,
      });
    }

    // 2. Retry accounting: the browser raising the same interaction again means the previous answer failed.
    const attemptKey = [loopKey, String(interaction.details.realm ?? '')].join('|');
    const previous = this.attempts.get(attemptKey);
    const attempt = (previous?.count ?? 0) + 1;
    if (previous && interaction.type === 'HTTP_AUTH' && previous.last.success) {
      previous.last.success = false;
      previous.last.reason = 'credentials rejected by the server';
    }

    // 3. Handler lookup.
    const handler = this.handlerFor(interaction.type);
    if (!handler) {
      await this.safely(interaction.fallback());
      return this.remember(
        attemptKey,
        attempt,
        this.record(interaction, crawl, {
          status: 'UNSUPPORTED',
          outcome: 'NO_HANDLER',
          action: 'FALLBACK',
          success: false,
          reason: 'no handler for this interaction: safe fallback applied',
        }),
      );
    }

    // 4. Safety policy.
    const decision = this.options.policy.evaluate(interaction);
    if (decision.verdict === 'BLOCK') {
      await this.safely(interaction.fallback());
      return this.remember(
        attemptKey,
        attempt,
        this.record(
          interaction,
          crawl,
          {
            status: 'BLOCKED',
            ...(decision.outcome ? { outcome: decision.outcome } : {}),
            action: 'REFUSE',
            success: false,
            reason: decision.reason,
            ...(decision.originClass ? { originClass: decision.originClass } : {}),
            blocking: interaction.type === 'HTTP_AUTH',
          },
          handler.name,
        ),
      );
    }

    // 5. Handler, bounded in time.
    const outcome = await this.runHandler(handler, interaction, decision, attempt, crawl);
    return this.remember(
      attemptKey,
      attempt,
      this.record(interaction, crawl, outcome, handler.name, attempt),
    );
  }

  /** Every recorded result, in order. */
  results(): BrowserInteractionResult[] {
    return [...this.recorded];
  }

  /** Position to pass to `since` / `blockingSince` (take it before an action). */
  mark(): number {
    return this.recorded.length;
  }

  since(mark: number): BrowserInteractionResult[] {
    return this.recorded.slice(mark);
  }

  /** Interactions since `mark` that prevent the flow from going on normally. */
  blockingSince(mark: number): BrowserInteractionResult[] {
    return this.since(mark).filter((result) => result.blocking);
  }

  private async runHandler(
    handler: BrowserInteractionHandler,
    interaction: BrowserInteraction,
    decision: InteractionDecision,
    attempt: number,
    crawl: InteractionContext,
  ): Promise<HandlerOutcome> {
    const { timeoutMs, retry } = this.options.config;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<HandlerOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          status: 'FAILED',
          outcome: 'TIMEOUT',
          action: 'FALLBACK',
          success: false,
          reason: `handler did not finish within ${timeoutMs} ms`,
          blocking: interaction.type === 'HTTP_AUTH',
        });
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        handler.handle(interaction, {
          decision,
          credentials: this.options.credentials,
          attempt,
          maxAttempts: retry.maxAttempts,
          crawl,
        }),
        timeout,
      ]);
      if (outcome.outcome === 'TIMEOUT') await this.safely(interaction.fallback());
      return { ...(decision.originClass ? { originClass: decision.originClass } : {}), ...outcome };
    } catch (error) {
      await this.safely(interaction.fallback());
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return {
        status: 'FAILED',
        outcome: 'ERROR',
        action: 'FALLBACK',
        success: false,
        reason: redactText(message ?? 'handler error'),
        blocking: interaction.type === 'HTTP_AUTH',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(key: string, attempt: number, result: BrowserInteractionResult): BrowserInteractionResult {
    this.attempts.set(key, { count: attempt, last: result });
    return result;
  }

  private record(
    interaction: BrowserInteraction,
    crawl: InteractionContext,
    outcome: HandlerOutcome,
    handler?: string,
    attempt = 1,
  ): BrowserInteractionResult {
    const details: InteractionDetails = { ...interaction.details, ...outcome.details };
    if (typeof details.message === 'string') details.message = redactText(details.message).slice(0, 300);
    const targetUrl = outcome.targetUrl ?? interaction.targetUrl;
    const result: BrowserInteractionResult = {
      id: interaction.id,
      type: interaction.type,
      status: outcome.status,
      ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
      ...(handler ? { handler } : {}),
      ...(outcome.action ? { action: outcome.action } : {}),
      sourceUrl: redactUrl(interaction.sourceUrl),
      ...(targetUrl ? { targetUrl: redactUrl(targetUrl) } : {}),
      ...(interaction.origin ? { origin: interaction.origin } : {}),
      ...(outcome.originClass ? { originClass: outcome.originClass } : {}),
      timestamp: (this.options.now ?? (() => new Date()))().toISOString(),
      attempt,
      retryAttempted: attempt > 1,
      success: outcome.success,
      ...(outcome.reason ? { reason: redactText(outcome.reason) } : {}),
      ...(crawl.stateId ? { stateId: crawl.stateId } : {}),
      ...(crawl.actionId ? { actionId: crawl.actionId } : {}),
      ...(crawl.flow ? { flow: crawl.flow } : {}),
      ...(outcome.targetStateId ? { targetStateId: outcome.targetStateId } : {}),
      ...(outcome.credentialProfile ? { credentialProfile: outcome.credentialProfile } : {}),
      blocking: outcome.blocking ?? false,
      details,
    };
    this.recorded.push(result);
    this.options.log?.(formatLogLine(result));
    this.options.onResult?.(result);
    return result;
  }

  private async safely(promise: Promise<void>): Promise<void> {
    await promise.catch(() => undefined);
  }
}

/** `[BROWSER_INTERACTION] type=HTTP_AUTH origin=https://… handler=HttpAuthHandler status=HANDLED attempt=1` */
export function formatLogLine(result: BrowserInteractionResult): string {
  const fields: [string, string | number | undefined][] = [
    ['type', result.type],
    ['origin', result.origin ?? originOf(result.targetUrl ?? result.sourceUrl)],
    ['handler', result.handler],
    ['status', result.status],
    ['outcome', result.outcome],
    ['action', result.action],
    ['attempt', result.attempt],
    ['state', result.stateId],
  ];
  return `[BROWSER_INTERACTION] ${fields
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')}`;
}
