import {
  runtimeEvidence,
  sameLabel,
  staticEvidence,
  type ActionSideEffect,
  type BusinessStateMachine,
  type FunctionalActionObservation,
  type FunctionalExchange,
  type FunctionalWorkflow,
  type SideEffectStatus,
} from './model.js';

/** Le jugement d'un effet attendu après une action. */
export interface SideEffectVerdict {
  effect: ActionSideEffect;
  status: SideEffectStatus;
  detail: string;
}

/**
 * SIDE EFFECT ANALYZER : ce qu'une action doit PRODUIRE — l'appel d'API, le nouvel
 * état métier, le déclencheur qui disparaît, l'entité créée — et, après l'action, ce qui
 * s'est vraiment produit (avant / après, fenêtre réseau). Un effet attendu absent
 * (PATCH 200 mais le badge reste PENDING) est MISSING ; une écriture que rien
 * n'annonçait est UNEXPECTED. Jamais un bug en soi : l'oracle sémantique en juge.
 */
export class SideEffectAnalyzer {
  private readonly effects = new Map<string, ActionSideEffect[]>();

  build(workflows: readonly FunctionalWorkflow[], machines: readonly BusinessStateMachine[]): void {
    for (const workflow of workflows) {
      const list: ActionSideEffect[] = [];
      const evidence = workflow.evidence.slice(0, 1);
      if (workflow.api) list.push(this.effect(workflow.id, 'API', workflow.api, evidence));
      for (const outcome of workflow.expectedOutcomes) {
        if (outcome.kind === 'STATE_CHANGE')
          list.push(this.effect(workflow.id, 'STATE_CHANGE', outcome.description, evidence));
        if (outcome.kind === 'ENTITY')
          list.push(this.effect(workflow.id, 'ENTITY', outcome.description, evidence));
      }
      // Le déclencheur n'est plus offert dans le nouvel état (transition interdite depuis l'état d'arrivée).
      const machine = machines.find((entry) => entry.entityType === workflow.entityType);
      const transition = machine?.transitions.find(
        (entry) => workflow.id === `${(entry.trigger ?? '').toUpperCase()}:${entry.entityType}`,
      );
      if (
        machine &&
        transition?.triggerLabel &&
        machine.forbidden.some(
          (entry) => entry.from === transition.to && entry.trigger === transition.trigger,
        )
      )
        list.push(
          this.effect(workflow.id, 'UI', `"${transition.triggerLabel}" no longer offered`, [
            staticEvidence(`forbidden ${transition.to} → ${transition.trigger}`),
          ]),
        );
      this.effects.set(workflow.id, list);
    }
  }

  private effect(
    actionIntent: string,
    category: ActionSideEffect['category'],
    expectedEffect: string,
    evidence: ActionSideEffect['evidence'],
  ): ActionSideEffect {
    return { actionIntent, category, expectedEffect, evidence: [...evidence], status: 'EXPECTED' };
  }

  all(): ActionSideEffect[] {
    return [...this.effects.values()].flat();
  }

  expected(workflowId: string): ActionSideEffect[] {
    return this.effects.get(workflowId) ?? [];
  }

  /**
   * Après une action qui réalise un workflow : chaque effet attendu est jugé avant /
   * après. stateShown : l'état d'arrivée est-il affiché (undefined : on ne peut pas le savoir).
   */
  observe(
    workflow: FunctionalWorkflow,
    observation: FunctionalActionObservation,
    stateShown: boolean | undefined,
    /** L'appel qui réalise ce workflow (route et littéraux du corps), choisi par le WorkflowIntentAnalyzer. */
    write: FunctionalExchange | undefined,
  ): SideEffectVerdict[] {
    const verdicts: SideEffectVerdict[] = [];
    const accepted = write?.status !== undefined && write.status < 400;
    for (const effect of this.expected(workflow.id)) {
      // Aucun appel vu : peut-être une confirmation à l'écran, un autre bouton du même nom — on ne conclut rien.
      if (!write) {
        verdicts.push({
          effect,
          status: 'INCONCLUSIVE',
          detail: `no ${workflow.api ?? 'API'} call after "${observation.label}"`,
        });
        continue;
      }
      const call = `${write.method} ${write.path} → ${String(write.status ?? '?')}`;
      let status: SideEffectStatus;
      let detail: string;
      switch (effect.category) {
        case 'API':
          status = accepted ? 'CONFIRMED' : 'INCONCLUSIVE';
          detail = call;
          break;
        case 'STATE_CHANGE':
          status = !accepted
            ? 'INCONCLUSIVE'
            : stateShown === true
              ? 'CONFIRMED'
              : stateShown === false
                ? 'MISSING'
                : 'INCONCLUSIVE';
          detail = `${effect.expectedEffect}: ${status === 'CONFIRMED' ? 'shown' : status === 'MISSING' ? `not shown after ${call}` : 'cannot tell from this screen'}`;
          break;
        case 'UI': {
          const label = /"(.+)"/.exec(effect.expectedEffect)?.[1];
          const still = label
            ? observation.after?.buttons.some((button) => button.enabled && sameLabel(button.label, label))
            : undefined;
          status = !accepted || still === undefined ? 'INCONCLUSIVE' : still ? 'MISSING' : 'CONFIRMED';
          detail = `${effect.expectedEffect}: ${still ? 'still offered' : 'gone'}`;
          break;
        }
        case 'ENTITY': {
          // Une entité créée se voit : 201, ou un identifiant dans la réponse. Une suppression acceptée suffit.
          const created =
            write.status === 201 ||
            (accepted &&
              (write.responseFields?.id !== undefined || write.responseFields?.uuid !== undefined));
          status =
            created || (accepted && workflow.id.startsWith('DELETE:'))
              ? 'CONFIRMED'
              : accepted
                ? 'MISSING'
                : 'INCONCLUSIVE';
          detail = `${effect.expectedEffect}: ${call}${status === 'MISSING' ? ', no identifier returned' : ''}`;
          break;
        }
        default:
          status = 'INCONCLUSIVE';
          detail = effect.expectedEffect;
      }
      // Un INCONCLUSIVE n'efface pas ce qu'une observation précédente a établi.
      if (status !== 'INCONCLUSIVE' || effect.status === 'EXPECTED') effect.status = status;
      effect.observations = [...(effect.observations ?? []), `${status}: ${detail}`].slice(-5);
      if (status === 'CONFIRMED' || status === 'MISSING')
        effect.evidence.push(runtimeEvidence(detail, status === 'CONFIRMED' ? 0.9 : 0.7));
      verdicts.push({ effect, status, detail });
    }
    return verdicts;
  }

  /** Une écriture que l'action ne devait pas faire (aucun workflow ne l'annonce). */
  unexpected(
    observation: FunctionalActionObservation,
    known: (method: string, path: string) => boolean,
  ): ActionSideEffect[] {
    return observation.exchanges
      .filter(
        (exchange) =>
          exchange.method !== 'GET' && exchange.method !== 'HEAD' && exchange.method !== 'OPTIONS',
      )
      .filter((exchange) => !known(exchange.method, exchange.path))
      .slice(0, 3)
      .map((exchange) => ({
        actionIntent: observation.label,
        category: 'API' as const,
        expectedEffect: `${exchange.method} ${exchange.path}`,
        evidence: [
          runtimeEvidence(
            `${exchange.method} ${exchange.path} → ${String(exchange.status ?? '?')} after "${observation.label}"`,
            0.6,
          ),
        ],
        status: 'UNEXPECTED' as const,
      }));
  }
}
