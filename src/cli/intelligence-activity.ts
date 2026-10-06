import type { AiEventRecord } from '../ai/gateway.js';
import type { ProgressSink } from '../progress/progress.js';
import { color, logger } from './logger.js';

/**
 * L'INTELLIGENCE dans le terminal : un appel au conseiller (Copilot…) peut durer plusieurs secondes.
 * Sans retour, le run a l'air bloqué. Pendant l'appel : une ligne animée « Waiting for the intelligence
 * advisor — <déclencheur> · 4.2 s » ; à la fin : la réponse reçue, le délai dépassé ou l'indisponibilité,
 * et ce que le crawler en a fait (proposition acceptée, rejetée, décision déterministe gardée).
 */
export interface IntelligenceActivity {
  onIntelligence: (record: AiEventRecord) => void;
  /** La ligne animée est retirée (fin du run, erreur). */
  stop: () => void;
}

const ENDS_OK = new Set(['AI_PROPOSAL_RECEIVED']);
const ENDS_KO = new Set(['AI_TIMEOUT', 'AI_UNAVAILABLE', 'AI_MODEL_DISCOVERY_FAILED']);

export function intelligenceActivity(
  sink: ProgressSink,
  stopRenderer: () => void,
  now: () => number = Date.now,
): IntelligenceActivity {
  let started: number | undefined;
  let trigger = '';
  const running = (detail?: string): void => {
    sink({
      task: 'Intelligence advisor',
      step: 0,
      total: 0,
      label: `waiting for the answer${trigger ? ` (${trigger})` : ''}`,
      ...(detail ? { detail } : {}),
      elapsedMs: now() - (started ?? now()),
      state: 'RUNNING',
    });
  };
  const end = (state: 'DONE' | 'FAILED', label: string): void => {
    if (started === undefined) return;
    sink({ task: 'Intelligence advisor', step: 0, total: 0, label, elapsedMs: now() - started, state });
    started = undefined;
  };
  return {
    onIntelligence: (record) => {
      const { event, message } = record;
      if (event === 'AI_REQUEST_CREATED') {
        // « <id> <déclencheur>: n action(s)… » : le déclencheur dit pourquoi le conseiller est consulté.
        trigger = /^\S+\s+([^:]+):/.exec(message)?.[1]?.trim() ?? '';
        started = now();
        running();
        return;
      }
      if (event === 'AI_SESSION_CREATED' || event === 'AI_MODEL_SELECTED') {
        if (started !== undefined) running(message);
        return;
      }
      if (ENDS_OK.has(event)) {
        const model = / from (\S+)/.exec(message)?.[1];
        end('DONE', `answer received${model ? ` from ${model}` : ''}`);
        return;
      }
      if (ENDS_KO.has(event)) {
        end(
          'FAILED',
          `${event === 'AI_TIMEOUT' ? 'no answer in time' : 'unavailable'}: ${message.replace(/^\S+:\s*/, '')}`,
        );
        if (event !== 'AI_TIMEOUT') return;
        logger.info(color.dim('   ↳ the deterministic decision is kept'));
        return;
      }
      if (event === 'AI_PROPOSAL_ACCEPTED') logger.info(color.green(`   ↳ proposal accepted: ${message}`));
      else if (event === 'AI_PROPOSAL_REJECTED') logger.info(color.dim(`   ↳ proposal not used: ${message}`));
      else if (event === 'AI_FALLBACK_ACTIVATED') {
        end('FAILED', 'no usable answer');
        logger.info(color.dim(`   ↳ ${message}`));
      } else if (event === 'AI_BUDGET_EXHAUSTED')
        logger.info(color.yellow(`   ↳ intelligence budget reached: ${message}`));
    },
    stop: () => {
      started = undefined;
      stopRenderer();
    },
  };
}
