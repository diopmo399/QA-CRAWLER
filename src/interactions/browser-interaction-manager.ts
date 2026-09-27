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
  /** Où en est l'exploration (état, action, flow), pour rattacher les interactions et détecter les boucles. */
  crawlContext?: () => InteractionContext;
  /** Appelé avec chaque résultat enregistré (graphe des flows, anomalies, CLI). */
  onResult?: (result: BrowserInteractionResult) => void;
  /** Ligne de log structurée, par exemple `[BROWSER_INTERACTION] type=HTTP_AUTH status=HANDLED …`. Ne contient jamais de secret. */
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Point central pour tout ce que le navigateur lève hors du DOM.
 *
 *   détection (BrowserEventDiscovery) → garde anti-boucle → choix du handler →
 *   SafetyPolicy (InteractionPolicy) → handler (avec compte des essais et
 *   délai) → enregistrement → l'exploration reprend.
 *
 * Le moteur d'exploration ne parle jamais aux handlers : il lit seulement les
 * résultats (par exemple pour arrêter un flow sur AUTH_REQUIRED). Une nouvelle
 * interaction se prend en charge en enregistrant un handler.
 */
export class BrowserInteractionManager {
  private readonly handlers: BrowserInteractionHandler[] = [];
  private readonly recorded: BrowserInteractionResult[] = [];
  /** Occurrences par (type, origine, action) : détection des boucles. */
  private readonly occurrences = new Map<string, number>();
  /** Essais par (type, origine, domaine, action) et dernier résultat : compte des nouvelles tentatives. */
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

    // 1. Protection contre les boucles : la même interaction répétée n'est jamais retentée indéfiniment.
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

    // 2. Compte des essais : le navigateur qui relève la même interaction veut dire que la réponse précédente a échoué.
    const attemptKey = [loopKey, String(interaction.details.realm ?? '')].join('|');
    const previous = this.attempts.get(attemptKey);
    const attempt = (previous?.count ?? 0) + 1;
    if (previous && interaction.type === 'HTTP_AUTH' && previous.last.success) {
      previous.last.success = false;
      previous.last.reason = 'credentials rejected by the server';
    }

    // 3. Choix du handler.
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

    // 4. Politique de sécurité.
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

    // 5. Handler, limité dans le temps.
    const outcome = await this.runHandler(handler, interaction, decision, attempt, crawl);
    return this.remember(
      attemptKey,
      attempt,
      this.record(interaction, crawl, outcome, handler.name, attempt),
    );
  }

  /** Chaque résultat enregistré, dans l'ordre. */
  results(): BrowserInteractionResult[] {
    return [...this.recorded];
  }

  /** Position à passer à `since` / `blockingSince` (à prendre avant une action). */
  mark(): number {
    return this.recorded.length;
  }

  since(mark: number): BrowserInteractionResult[] {
    return this.recorded.slice(mark);
  }

  /** Interactions depuis `mark` qui empêchent le flow de continuer normalement. */
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
    const { retry, popups } = this.options.config;
    // Une popup peut être laissée ouverte un moment volontairement (popups.closeAfterMs).
    const timeoutMs =
      this.options.config.timeoutMs +
      (interaction.type === 'POPUP' || interaction.type === 'NEW_TAB' ? popups.closeAfterMs : 0);
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
