import type { FlowTarget } from '../config/flow-schema.js';
import type { InteractionAccount } from './human-journey.js';
import type { RawRecordedEvent, RecordedFlowStep, SemanticRecordedAction } from './model.js';

/**
 * RECORDER TRACE (QA_DEBUG) — la preuve, ligne à ligne, que l'enregistrement est déterministe :
 *
 *   NIVEAU 1  RAW BROWSER EVENT       [RECORDER] RAW EVENT     (ce que le navigateur a émis)
 *   NIVEAU 2  VALIDATED USER ACTION   [RECORDER] ELEMENT / VALIDATION / STABILIZATION / RECORDED
 *             ou                      [RECORDER] EVENT IGNORED reason=…
 *   NIVEAU 3  SEMANTIC INTENT         jamais ici : semantic-intents.json, après coup, sans toucher au niveau 2.
 *
 * Jamais une valeur saisie : la forme et la longueur seulement.
 */
export type IgnoredReason =
  'element_not_interacted' | 'duplicate_event' | 'ambiguous_target' | 'blocked_by_policy' | 'buffer_overflow';

/** Une ligne par événement brut capturé (pendant l'enregistrement). */
export function rawEventDebugLine(event: RawRecordedEvent): string {
  const element = event.element;
  const parts = [`[RECORDER] RAW EVENT ${event.id} type=${event.type}`];
  if (element) {
    parts.push(`element=${element.role || element.tag} "${element.name}"`, `css=${element.css}`);
    if (element.sameRoleName > 1)
      parts.push(`matches=${String(element.sameRoleName)} index=${String(element.roleNameIndex)}`);
    if (element.inShadow) parts.push('shadow');
    // L'état d'avant n'a de sens que sur le `change` (au `click`, le navigateur a déjà basculé la case).
    if (element.checked !== undefined && event.type === 'change')
      parts.push(`checkedBefore=${String(element.checked)}`);
  }
  if (event.value?.checked !== undefined) parts.push(`checkedAfter=${String(event.value.checked)}`);
  if (event.value && event.value.checked === undefined && !event.value.option)
    parts.push(`value=${event.value.shape}(${String(event.value.length)})`);
  if (event.value?.option) parts.push(`option="${event.value.option.label}"`);
  if (event.key) parts.push(`key=${event.key}`);
  if (event.transition) parts.push(`transition=${event.transition}`);
  if (event.noise) parts.push(`noise=${event.noise}`);
  return parts.join(' ');
}

export function ignoredDebugLine(id: string, reason: IgnoredReason, detail?: string): string {
  return `[RECORDER] EVENT IGNORED ${id} reason=${reason}${detail ? ` (${detail})` : ''}`;
}

/** La trace complète, après le traitement : chaque interaction humaine, enregistrée ou ignorée (et pourquoi). */
export function recorderTrace(input: {
  events: readonly RawRecordedEvent[];
  accounts: readonly InteractionAccount[];
  kept: readonly SemanticRecordedAction[];
  steps: readonly RecordedFlowStep[];
}): string[] {
  const lines: string[] = [];
  const events = new Map(input.events.map((event) => [event.id, event]));
  const actions = new Map(input.kept.map((action) => [action.id, action]));
  for (const account of input.accounts) {
    const id = `${account.interactionId} [${account.rawEventIds.join(',')}]`;
    switch (account.status) {
      case 'PRESERVED':
      case 'UNRESOLVED_BUT_PRESERVED': {
        const action = account.actionId ? actions.get(account.actionId) : undefined;
        const step = account.flowStep !== undefined ? input.steps[account.flowStep - 1] : undefined;
        if (action?.target)
          lines.push(
            `[RECORDER] ELEMENT ${id} ${action.type} "${action.target.label}" locator=${locatorText(action.target.target)} quality=${action.target.quality}${action.target.ambiguous ? ' ambiguous (disambiguated)' : ''}`,
          );
        if (action?.targetValidation)
          lines.push(
            `[RECORDER] VALIDATION ${id} status=${action.targetValidation.status}${action.targetValidation.repairApplied ? ' repaired' : ''}${action.targetValidation.requiresReplayValidation ? ' requires-replay-validation' : ''}`,
          );
        const last = events.get(account.rawEventIds.at(-1) ?? '');
        if (last?.stateAfter)
          lines.push(
            `[RECORDER] STABILIZATION ${id} screen=${last.stateAfter}${last.observationClosedBy ? ` closed-by=${last.observationClosedBy}` : ''}${last.network && last.network.length > 0 ? ` requests=${String(last.network.length)}` : ''}`,
          );
        lines.push(
          step
            ? `[RECORDER] RECORDED ${id} step=${step.id} kind=${step.step.kind}`
            : `[RECORDER] RECORDED ${id} (no step: ${account.reason ?? account.status})`,
        );
        break;
      }
      case 'MERGED':
      case 'COLLAPSED_CORRECTION':
      case 'DUPLICATE':
      case 'SUPERSEDED':
        lines.push(
          ignoredDebugLine(
            id,
            'duplicate_event',
            [account.rule, account.mergedInto ? `kept in ${account.mergedInto}` : undefined]
              .filter(Boolean)
              .join(', ') || account.status,
          ),
        );
        break;
      case 'BLOCKED_BY_POLICY':
        lines.push(ignoredDebugLine(id, 'blocked_by_policy', account.reason));
        break;
      default:
        lines.push(
          ignoredDebugLine(
            id,
            /ambiguous/i.test(account.reason ?? '') ? 'ambiguous_target' : 'element_not_interacted',
            account.reason ?? account.rule ?? account.status,
          ),
        );
    }
  }
  return lines;
}

function locatorText(target: FlowTarget): string {
  const base =
    target.strategy === 'role'
      ? `role:${target.role ?? '?'}:"${target.name ?? ''}"`
      : `${target.strategy}:"${target.value ?? ''}"`;
  return target.nth !== undefined ? `${base} matchIndex=${String(target.nth)}` : base;
}
