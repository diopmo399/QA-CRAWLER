import type { ActionClassification } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { classifyPlaywrightError } from '../navigation/navigation-guard.js';
import { redactText } from '../security/redactor.js';
import type { FailureKind, RecoveryEvent, RecoveryStrategyName } from './recovery-model.js';

export interface RecoveryOptions {
  enabled: boolean;
  /** Essayées dans cet ordre ; une stratégie absente n'est jamais utilisée. */
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
 * Comment l'explorateur réalise chaque stratégie. Chaque tentative renvoie l'état
 * observé quand elle a marché (l'explorateur vérifie que c'est celui attendu),
 * undefined sinon. Une stratégie que l'explorateur ne peut pas appliquer ici est absente.
 */
export type RecoveryActions = Partial<
  Record<Exclude<RecoveryStrategyName, 'retry'>, () => Promise<PageContext | undefined>>
>;

/**
 * Erreurs Playwright qui méritent un nouvel essai : l'élément a bougé sous le clic, pas un vrai échec.
 * Une NAVIGATION (contexte détruit, cadre remplacé) n'en fait pas partie : l'action a très
 * probablement eu lieu, la rejouer pourrait l'exécuter deux fois (voir NavigationGuard).
 */
const TRANSIENT_ERROR = /not attached|not stable|element is outside of the viewport|element.*detached/i;

/** Sans configuration de récupération : ce que l'explorateur a toujours fait (calque du dessus, URL, rejeu, ailleurs). */
const MINIMAL: readonly RecoveryStrategyName[] = [
  'dismiss-dialog',
  'known-url',
  'replay-path',
  'abandon-branch',
];

/**
 * RÉCUPÉRATION : après un échec, essaie les stratégies configurées dans l'ordre
 * jusqu'à ce que l'une ramène l'exploration à un état connu, et enregistre chaque
 * tentative. Elle ne décide rien sur l'application ; elle ne fait qu'enchaîner ce que
 * l'explorateur sait faire, dans des limites (nouvelles tentatives, reconnexions).
 */
export class RecoveryEngine {
  private readonly log: RecoveryEvent[] = [];
  private reauthentications = 0;

  constructor(private readonly options: RecoveryOptions) {}

  get strategies(): readonly RecoveryStrategyName[] {
    return this.options.enabled ? this.options.strategies : MINIMAL;
  }

  /** Cette action en échec doit-elle être exécutée une fois de plus (attempt : nouvelles tentatives déjà faites) ? */
  shouldRetry(
    error: string | undefined,
    action: { classification: ActionClassification; submitsForm?: boolean },
    attempt: number,
  ): boolean {
    return (
      this.options.enabled &&
      this.options.strategies.includes('retry') &&
      attempt < this.options.maxRetries &&
      // Jamais deux fois une action qui peut envoyer ou modifier des données.
      action.classification === 'SAFE' &&
      action.submitsForm !== true &&
      !classifyPlaywrightError(error ?? '').navigation &&
      TRANSIENT_ERROR.test(error ?? '')
    );
  }

  /** La session peut-elle être renouvelée une fois de plus ? Compte la tentative quand c'est permis. */
  mayReauthenticate(): boolean {
    if (!this.options.enabled || !this.options.strategies.includes('reauthenticate')) return false;
    if (this.reauthentications >= this.options.maxReauthentications) return false;
    this.reauthentications += 1;
    return true;
  }

  get reauthenticationCount(): number {
    return this.reauthentications;
  }

  /** Essaie les stratégies dans l'ordre ; la première qui atteint un état gagne. */
  async recover(
    failure: Failure,
    actions: RecoveryActions,
  ): Promise<{ context?: PageContext; strategy?: RecoveryStrategyName }> {
    for (const strategy of this.strategies) {
      if (strategy === 'retry') continue; // décidé avant l'enregistrement de l'échec
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

  /** `reached` : l'état atteint, ou simplement si cela a marché. */
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
