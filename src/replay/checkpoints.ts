import type { FlowStep } from '../config/flow-schema.js';
import { normalize, present, requestMatches, routeMatches } from '../flows/action-effect-verifier.js';
import { slugOf } from '../workflow-healing/similarity.js';
import type { GoalPredicate } from '../workflow-healing/model.js';
import { targetLabel } from '../workflow-healing/workflow-context.js';
import type {
  CheckpointPredicate,
  CheckpointResult,
  CheckpointSource,
  FunctionalCheckpoint,
  ObservedFunctionalState,
} from './model.js';

/**
 * FUNCTIONAL CHECKPOINTS : au lieu de vérifier seulement chaque action (click, fill, click…), le
 * rejeu sait quel ÉTAT métier / UI doit tenir après chaque étape :
 *
 *   CP1 search screen loaded → CP2 criteria entered → CP3 search executed → CP4 results shown
 *   → CP5 item selected → CP6 request created
 *
 * Si l'étape 8 échoue alors que CP4 manque, la divergence est entre CP3 et CP4, pas forcément à
 * l'étape 8. Les checkpoints viennent des effets enregistrés, de l'intention fonctionnelle, des
 * étapes `expect`, de la route et de la cible de l'étape suivante. Pure : dérivation et évaluation
 * sont testables sans navigateur ; seule l'observation vient du runtime.
 */
export function deriveCheckpoints(steps: readonly FlowStep[]): FunctionalCheckpoint[] {
  const checkpoints: FunctionalCheckpoint[] = [];
  steps.forEach((step, position) => {
    const index = position + 1;
    const predicates: CheckpointPredicate[] = [];
    const sources = new Set<CheckpointSource>();
    const seen = new Set<string>();
    const push = (predicate: CheckpointPredicate, source: CheckpointSource): void => {
      const key = `${predicate.kind}|${normalize(predicate.value).toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      predicates.push(predicate);
      sources.add(source);
    };
    if (step.kind === 'expect') {
      const expectation = step.expect;
      if (expectation.text !== undefined)
        push({ kind: 'TEXT', value: expectation.text, source: 'expect step' }, 'EXPECT_STEP');
      if (expectation.url !== undefined)
        push({ kind: 'ROUTE', value: expectation.url, source: 'expect step' }, 'EXPECT_STEP');
      if (expectation.visible)
        push(
          controlPredicate(targetLabel(expectation.visible), expectation.visible.role, 'expect step'),
          'EXPECT_STEP',
        );
      if (expectation.hidden)
        push(
          { kind: 'ABSENT_CONTROL', value: targetLabel(expectation.hidden), source: 'expect step' },
          'EXPECT_STEP',
        );
      if (expectation.response)
        push(
          {
            kind: 'REQUEST',
            value: `${expectation.response.method ?? 'GET'} ${expectation.response.url}`,
            source: 'expect step',
          },
          'EXPECT_STEP',
        );
    } else if (step.kind === 'screenshot' || step.kind === 'manual') {
      return;
    } else {
      const effects = step.effects;
      const required = effects?.required !== false;
      for (const control of (effects?.appears ?? []).slice(0, 4))
        push(controlOf(control, 'expected effect'), 'EXPECTED_EFFECTS');
      if ((effects?.appears?.length ?? 0) === 0)
        for (const control of (effects?.disappears ?? []).slice(0, 2))
          push(
            { kind: 'ABSENT_CONTROL', value: nameOf(control), source: 'expected effect' },
            'EXPECTED_EFFECTS',
          );
      if (effects?.route) push({ kind: 'ROUTE', value: effects.route, source: 'expected effect' }, 'ROUTE');
      if (effects?.request)
        push({ kind: 'REQUEST', value: effects.request, source: 'expected effect' }, 'EXPECTED_EFFECTS');
      if (step.functionalIntent && step.functionalIntent.status !== 'UNKNOWN')
        sources.add('FUNCTIONAL_INTENT');
      // La cible de l'étape d'action suivante (non facultative) : elle doit être disponible après celle-ci.
      const next = nextActionStep(steps, position);
      if (next && 'target' in next && !next.optional) {
        const label = targetLabel(next.target);
        if (label && !/^[.#[]/.test(label))
          push(
            next.kind === 'fill' || next.kind === 'select'
              ? {
                  kind: 'VISIBLE_FIELD',
                  value: label,
                  ...(next.target.role ? { role: next.target.role } : {}),
                  source: 'next step',
                }
              : {
                  kind: 'CONTROL_AVAILABLE',
                  value: label,
                  ...(next.target.role ? { role: next.target.role } : {}),
                  source: 'next step',
                },
            'NEXT_ACTION',
          );
      }
      if (!required && sources.has('EXPECTED_EFFECTS') && !sources.has('NEXT_ACTION'))
        sources.add('FLOW_END');
    }
    if (predicates.length === 0) return;
    const intent = step.functionalIntent?.name;
    const subject =
      intent ??
      (step.kind === 'expect'
        ? `EXPECT_${slugOf(describeStep(step)) || 'STATE'}`
        : `${step.kind.toUpperCase()}_${slugOf(labelOf(step)) || 'STEP'}`);
    const strong =
      sources.has('EXPECT_STEP') ||
      (sources.has('EXPECTED_EFFECTS') && ('effects' in step ? step.effects?.required !== false : true)) ||
      [...sources].filter((source) => source !== 'FLOW_END' && source !== 'FUNCTIONAL_INTENT').length >= 2;
    checkpoints.push({
      id: `CP${String(index)}_${subject}`,
      label: labelFor(step, intent),
      afterStep: index,
      predicates,
      source: [...sources].filter((source) => source !== 'FLOW_END'),
      strength: strong ? 'STRONG' : 'WEAK',
    });
  });
  return checkpoints;
}

/** Les checkpoints à vérifier après l'étape `index`. */
export function checkpointsAfter(
  checkpoints: readonly FunctionalCheckpoint[],
  index: number,
): FunctionalCheckpoint[] {
  return checkpoints.filter((checkpoint) => checkpoint.afterStep === index);
}

/**
 * Le checkpoint tient-il dans l'état observé ? CONFIRMED : tous les prédicats ; FAILED : aucun (et le
 * checkpoint est fort) ; INCONCLUSIVE : une partie, ou rien d'observable, ou un checkpoint faible.
 */
export function evaluateCheckpoint(
  checkpoint: FunctionalCheckpoint,
  observed: ObservedFunctionalState | undefined,
): CheckpointResult {
  if (!observed)
    return {
      id: checkpoint.id,
      status: 'INCONCLUSIVE',
      satisfied: [],
      missing: checkpoint.predicates.map(predicateLabel),
      progress: 0,
      reasons: ['no observation of the screen after the step'],
    };
  const controls = new Set(observed.controls.map(normalizeControl));
  const fields = new Set((observed.fields ?? []).map((field) => normalize(field).toLowerCase()));
  const requests = observed.requests ?? [];
  const text = normalize(observed.text ?? '').toLowerCase();
  const satisfied: string[] = [];
  const missing: string[] = [];
  const reasons: string[] = [];
  for (const predicate of checkpoint.predicates) {
    const label = predicateLabel(predicate);
    let held: boolean | undefined;
    switch (predicate.kind) {
      case 'VISIBLE_CONTROL':
      case 'CONTROL_AVAILABLE':
        held = present(controls, predicate.role ? `${predicate.role}:${predicate.value}` : predicate.value);
        if (held && predicate.kind === 'CONTROL_AVAILABLE' && observed.enabledControls) {
          const enabled = new Set(observed.enabledControls.map(normalizeControl));
          held = present(enabled, predicate.role ? `${predicate.role}:${predicate.value}` : predicate.value);
          if (!held) reasons.push(`${label}: present but disabled`);
        }
        break;
      case 'VISIBLE_FIELD':
        held =
          fields.has(normalize(predicate.value).toLowerCase()) ||
          present(controls, predicate.value) ||
          (text.length > 0 && text.includes(normalize(predicate.value).toLowerCase()));
        break;
      case 'ABSENT_CONTROL':
        held = !present(controls, predicate.value);
        break;
      case 'ROUTE':
        held = routeMatches(predicate.value, observed.route) || observed.route.includes(predicate.value);
        break;
      case 'ABSENT_ROUTE':
        held = !routeMatches(predicate.value, observed.route);
        break;
      case 'REQUEST':
        held =
          requests.length === 0 && observed.requests === undefined
            ? undefined
            : requestMatches(predicate.value, requests) !== undefined;
        break;
      case 'TEXT':
        held =
          text.length === 0 && observed.text === undefined
            ? undefined
            : text.includes(normalize(predicate.value).toLowerCase());
        break;
    }
    if (held === true) satisfied.push(label);
    else {
      missing.push(label);
      if (held === undefined) reasons.push(`${label}: not observable`);
    }
  }
  const total = checkpoint.predicates.length;
  const progress = total === 0 ? 0 : Math.round((satisfied.length / total) * 100) / 100;
  const status =
    total === 0
      ? 'INCONCLUSIVE'
      : satisfied.length === total
        ? 'CONFIRMED'
        : satisfied.length === 0 && checkpoint.strength === 'STRONG' && reasons.length === 0
          ? 'FAILED'
          : 'INCONCLUSIVE';
  if (status === 'FAILED')
    reasons.push(`none of ${String(total)} predicate(s) holds after step ${String(checkpoint.afterStep)}`);
  return { id: checkpoint.id, status, satisfied, missing, progress, reasons };
}

export function predicateLabel(predicate: CheckpointPredicate): string {
  switch (predicate.kind) {
    case 'VISIBLE_FIELD':
      return `field "${predicate.value}" visible`;
    case 'VISIBLE_CONTROL':
      return `${predicate.role ? `${predicate.role} ` : ''}"${predicate.value}" visible`;
    case 'CONTROL_AVAILABLE':
      return `${predicate.role ? `${predicate.role} ` : ''}"${predicate.value}" available`;
    case 'ABSENT_CONTROL':
      return `"${predicate.value}" gone`;
    case 'ROUTE':
      return `route ${predicate.value}`;
    case 'ABSENT_ROUTE':
      return `left route ${predicate.value}`;
    case 'REQUEST':
      return `request ${predicate.value}`;
    case 'TEXT':
      return `text "${predicate.value}"`;
  }
}

function controlPredicate(name: string, role: string | undefined, source: string): GoalPredicate {
  return { kind: 'VISIBLE_CONTROL', value: name, ...(role ? { role } : {}), source };
}

/** « button:Next » → prédicat (rôle, nom) ; « Next » → nom seul. */
function controlOf(control: string, source: string): GoalPredicate {
  const colon = control.indexOf(':');
  const role = colon > 0 && !control.slice(0, colon).includes(' ') ? control.slice(0, colon) : undefined;
  return controlPredicate(role ? control.slice(colon + 1) : control, role, source);
}

function nameOf(control: string): string {
  const colon = control.indexOf(':');
  return colon > 0 && !control.slice(0, colon).includes(' ') ? control.slice(colon + 1) : control;
}

function normalizeControl(control: string): string {
  const colon = control.indexOf(':');
  if (colon <= 0) return normalize(control);
  return `${control.slice(0, colon)}:${normalize(control.slice(colon + 1))}`;
}

function nextActionStep(steps: readonly FlowStep[], position: number): FlowStep | undefined {
  for (let at = position + 1; at < steps.length; at += 1) {
    const step = steps[at];
    if (!step) return undefined;
    if (step.kind === 'expect' || step.kind === 'screenshot' || step.kind === 'manual') continue;
    return step;
  }
  return undefined;
}

function labelOf(step: FlowStep): string {
  if ('target' in step) return targetLabel(step.target);
  if (step.kind === 'goto') return step.url;
  if (step.kind === 'dragAndDrop') return step.item;
  return '';
}

function describeStep(step: FlowStep): string {
  if (step.kind !== 'expect') return labelOf(step);
  const expectation = step.expect;
  return (
    expectation.text ??
    expectation.url ??
    (expectation.visible ? targetLabel(expectation.visible) : undefined) ??
    (expectation.hidden ? targetLabel(expectation.hidden) : undefined) ??
    expectation.response?.url ??
    'state'
  );
}

function labelFor(step: FlowStep, intent: string | undefined): string {
  if (intent) return `${intent.replace(/_/g, ' ').toLowerCase()} done`;
  if (step.kind === 'expect') return `expected: ${describeStep(step)}`;
  if (step.kind === 'goto') return `at ${step.url}`;
  if ('target' in step) return `${step.kind} "${targetLabel(step.target)}" took effect`;
  return `${step.kind} done`;
}
