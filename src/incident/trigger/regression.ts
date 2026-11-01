import { stringify as stringifyYaml } from 'yaml';
import type { Incident, RegressionTestProposal } from '../../sdk/core/incident-contracts.js';
import type { TriggerAction, TriggerRun } from '../../sdk/core/incident-trigger-contracts.js';
import { redactText } from '../../security/redactor.js';
import { responsePattern } from '../regression.js';
import { isFactorAction } from './model.js';
import { describeAction } from './session.js';

/**
 * LE TEST DE NON-RÉGRESSION D'UNE SÉQUENCE DÉCLENCHANTE : la séquence minimale devient un flow de la
 * bibliothèque (goto, fill, select, check, click, expect) qui rejoue le déclencheur puis vérifie que la sonde
 * réagit encore (requête attendue en 2xx, aucun message d'erreur). Il est PROPOSÉ ; il devient « validé »
 * seulement après avoir été exécuté par le chemin existant de régression (échec avant correction, succès après).
 */
type Raw = Record<string, unknown>;

export interface TriggerRegressionResult {
  proposal: RegressionTestProposal;
  /** Les actions que le format de flow ne peut pas exprimer (touches, attentes…), signalées. */
  unexpressed: string[];
}

function targetOf(target: string | undefined, fallbackRole?: string): Raw | undefined {
  if (!target) return undefined;
  const [strategy, ...rest] = target.split(':');
  const value = rest.join(':');
  switch (strategy) {
    case 'button':
    case 'tab':
    case 'link':
      return { role: strategy, name: value };
    case 'role': {
      const [role, ...name] = value.split(' ');
      return { role, name: name.join(' ') };
    }
    case 'label':
      return { label: value };
    case 'text':
      return { text: value };
    case 'testid':
      return { testId: value };
    case 'css':
      return { css: value };
    default:
      return fallbackRole ? { role: fallbackRole, name: target } : { text: target };
  }
}

function stepOf(action: TriggerAction, closedWith?: string): { step?: Raw; unexpressed?: string } {
  switch (action.kind) {
    case 'NAVIGATE':
    case 'RELOAD':
      return action.target ? { step: { goto: action.target } } : { unexpressed: describeAction(action) };
    case 'CLICK':
    case 'OPEN_DIALOG':
    case 'TAB': {
      const target = targetOf(action.target, action.kind === 'TAB' ? 'tab' : 'button');
      return target ? { step: { click: target } } : { unexpressed: describeAction(action) };
    }
    case 'CLOSE_DIALOG': {
      const target =
        targetOf(action.target, 'button') ?? (closedWith ? { role: 'button', name: closedWith } : undefined);
      return target
        ? { step: { click: target } }
        : { unexpressed: `${describeAction(action)} (touche Échap)` };
    }
    case 'FILL':
    case 'CLEAR': {
      const target = targetOf(action.target);
      return target
        ? { step: { fill: { ...target, value: action.kind === 'CLEAR' ? '' : (action.value ?? '') } } }
        : { unexpressed: describeAction(action) };
    }
    case 'SELECT': {
      const target = targetOf(action.target);
      return target
        ? { step: { select: { ...target, option: action.value ?? '' } } }
        : { unexpressed: describeAction(action) };
    }
    case 'CHECK': {
      const target = targetOf(action.target);
      if (!target) return { unexpressed: describeAction(action) };
      return { step: action.value === 'false' ? { uncheck: target } : { check: target } };
    }
    case 'REPEAT': {
      const target = targetOf(action.target, 'button');
      return target ? { step: { click: target } } : { unexpressed: describeAction(action) };
    }
    default:
      return { unexpressed: describeAction(action) };
  }
}

export function buildTriggerRegression(incident: Incident, run: TriggerRun): TriggerRegressionResult {
  const minimal = run.minimal;
  const failing =
    run.trials.find((trial) => trial.id === minimal?.fromTrialId) ??
    run.trials.find((trial) => trial.verdict === 'FAILURE_REPRODUCED');
  if (!minimal && !failing) throw new Error('no reproduced sequence to turn into a regression test');
  const actions = minimal?.actions ?? failing?.actions ?? [];
  const probes = failing ? failing.probes : [];
  const closedWith = failing?.events.find(
    (event) => event.kind === 'NOTE' && typeof event.data?.closedWith === 'string',
  )?.data?.closedWith as string | undefined;
  const steps: Raw[] = [];
  const unexpressed: string[] = [];
  const expected: string[] = [];
  let probeDone = false;
  actions.forEach((action, index) => {
    const isProbe = action.origin === 'probe' || probes.includes(index);
    if (isProbe && probeDone) return; // une seule sonde : la principale
    const { step, unexpressed: missing } = stepOf(action, closedWith);
    if (missing) unexpressed.push(missing);
    if (!step) return;
    if (isProbe) {
      step.allow = 'MUTATION';
      step.name = `Sonde : ${describeAction(action)}`;
      steps.push(step);
      const key = action.target ?? '';
      const signature = run.reference[key];
      if (signature?.request) {
        steps.push({
          name: `${signature.request.method} ${signature.request.path} est émis et réussit`,
          expect: {
            response: {
              method: signature.request.method,
              url: responsePattern(signature.request.path),
              status: '2xx',
            },
          },
        });
        expected.push(
          `${signature.request.method} ${signature.request.path} répond en 2xx après la séquence`,
        );
      } else {
        expected.push('la sonde réagit encore après la séquence');
      }
      steps.push({ name: "Aucun message d'erreur affiché", expect: { noError: true } });
      expected.push("aucun message d'erreur affiché");
      probeDone = true;
      return;
    }
    steps.push(step);
  });
  const trigger = actions.filter(isFactorAction).map(describeAction).join(', ');
  const name = `Non-régression — ${redactText(incident.title).replace(/\s+/g, ' ').trim()} (déclencheur)`;
  const flow: Raw = {
    name,
    description: `Proposé par la découverte des déclencheurs de l'incident ${incident.id} (run ${run.id}). Séquence : ${trigger || 'référence'}. Fréquence observée : ${String(minimal?.frequency.reproduced ?? 1)}/${String(minimal?.frequency.total ?? 1)}.`,
    steps,
  };
  return {
    proposal: {
      name,
      basedOn: `trigger:${run.id}`,
      flowYaml: stringifyYaml({ flows: [flow] }, { lineWidth: 0 }),
      expected: expected.join(' ; ') || 'la sonde réagit encore après la séquence',
      status: 'PROPOSED',
    },
    unexpressed,
  };
}
