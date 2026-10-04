import type { FlowStep, FlowTarget, StepEffects } from '../config/flow-schema.js';
import type {
  BusinessIntent,
  FunctionalGoal,
  GoalPredicate,
  GoalProgress,
  GoalSource,
  IntentConfidence,
  SemanticAction,
  WorkflowActionContext,
} from './model.js';
import { slugOf } from './similarity.js';

/** Le libellé d'une cible (jamais un sélecteur CSS brut quand un nom existe). */
export function targetLabel(target: FlowTarget): string {
  return target.name ?? target.value ?? '';
}

/** Une cible désignée par un sélecteur technique (css, xpath, test id) : son « libellé » n'est pas un nom. */
export function isTechnicalTarget(target: FlowTarget | undefined): boolean {
  return target !== undefined && (target.strategy === 'css' || target.strategy === 'testId');
}

/** Une étape de flow vue par son sens. Les valeurs saisies ne sont jamais lues. */
export function semanticActionOf(step: FlowStep, index: number): SemanticAction {
  switch (step.kind) {
    case 'click':
      return {
        index,
        kind: 'click',
        label: targetLabel(step.target),
        ...(step.target.role ? { role: step.target.role } : {}),
        target: step.target,
      };
    case 'check':
    case 'uncheck':
      return {
        index,
        kind: step.kind,
        label: targetLabel(step.target),
        role: step.target.role ?? 'checkbox',
        field: true,
      };
    case 'fill':
    case 'select':
      return {
        index,
        kind: step.kind,
        label: targetLabel(step.target),
        ...(step.target.role ? { role: step.target.role } : {}),
        field: true,
        target: step.target,
      };
    case 'goto':
      return { index, kind: 'goto', label: step.url };
    case 'expect':
      return { index, kind: 'expect', label: step.expect.text ?? step.expect.url ?? 'expectation' };
    default:
      return { index, kind: 'other', label: step.name ?? step.kind };
  }
}

/** « + button:Next », « route /a/{id} »… : les effets appris, en texte. */
export function effectsText(effects: StepEffects | undefined): string[] {
  return [
    ...(effects?.appears ?? []).map((control) => `+ ${control}`),
    ...(effects?.disappears ?? []).map((control) => `- ${control}`),
    ...(effects?.route ? [`route ${effects.route}`] : []),
    ...(effects?.request ? [`request ${effects.request}`] : []),
  ];
}

/**
 * WORKFLOW CONTEXT RESOLVER : une action n'est jamais analysée seule.
 *
 *   précédentes (3) + courante + suivantes (jusqu'à la prochaine vérification, 4 au plus)
 *   + effets appris + intention + champs et contrôles exigés par la suite.
 *
 * Les étapes suivantes sont une PREUVE : « quelle action de cet écran rend disponibles les
 * champs que le parcours remplit ensuite ? » plutôt que « où est passé l'ancien bouton ? ».
 */
export function resolveWorkflowContext(steps: readonly FlowStep[], position: number): WorkflowActionContext {
  const current = steps[position];
  if (!current) throw new Error(`no step at position ${String(position)}`);
  const previousActions = steps
    .slice(Math.max(0, position - 3), position)
    .map((step, offset) => semanticActionOf(step, Math.max(0, position - 3) + offset + 1))
    .filter((action) => action.kind !== 'other');
  const nextActions: SemanticAction[] = [];
  for (let at = position + 1; at < steps.length && nextActions.length < 4; at += 1) {
    const step = steps[at];
    if (!step) break;
    if (step.kind === 'screenshot' || step.kind === 'manual') continue;
    const action = semanticActionOf(step, at + 1);
    nextActions.push(action);
    if (step.kind === 'expect' || step.kind === 'goto') break;
  }
  // Les champs que la suite IMMÉDIATE remplit : ce que l'action courante doit rendre disponible.
  const requiredFutureFields: SemanticAction[] = [];
  for (const action of nextActions) {
    if (!action.field) break;
    requiredFutureFields.push(action);
  }
  const requiredFutureControls = nextActions.filter((action) => action.kind === 'click').slice(0, 1);
  const currentAction = semanticActionOf(current, position + 1);
  const effects = 'effects' in current ? current.effects : undefined;
  return {
    previousActions,
    currentAction,
    nextActions,
    expectedEffects: effectsText(effects),
    businessIntent: intentOf(currentAction, requiredFutureFields, effects),
    requiredFutureControls,
    requiredFutureFields,
  };
}

const VERB: Record<SemanticAction['kind'], string> = {
  click: 'OPEN',
  check: 'SELECT',
  uncheck: 'UNSELECT',
  fill: 'ENTER',
  select: 'CHOOSE',
  goto: 'GO_TO',
  expect: 'VERIFY',
  other: 'DO',
};

/** OPEN_COMPANY_INFORMATION, avec ses sources et une confiance qui n'invente rien. */
function intentOf(
  action: SemanticAction,
  futureFields: readonly SemanticAction[],
  effects: StepEffects | undefined,
): BusinessIntent {
  const subject = slugOf(action.label) || slugOf(futureFields[0]?.label ?? '');
  const sources = [
    ...(action.label ? ['action label'] : []),
    ...(effects && (effects.appears?.length ?? 0) > 0 ? ['expected effects'] : []),
    ...(futureFields.length > 0 ? ['next actions'] : []),
  ];
  const confidence: IntentConfidence = !subject
    ? 'UNRESOLVED'
    : sources.length >= 3
      ? 'HIGH'
      : sources.length === 2
        ? 'MEDIUM'
        : 'LOW';
  return { name: subject ? `${VERB[action.kind]}_${subject}` : 'UNRESOLVED', confidence, sources };
}

/**
 * WORKFLOW INTENT RESOLVER → FUNCTIONAL GOAL : ce que l'action devait rendre VRAI, pas
 * l'élément qu'elle visait. « Company information » (bouton) et « Company » (onglet)
 * atteignent le même objectif : COMPANY_INFORMATION_AVAILABLE.
 *
 * Prédicats : contrôles appris (effects.appears), champs que la suite remplit, cible de
 * l'étape suivante, route apprise. Aucun prédicat : l'objectif reste UNRESOLVED.
 */
export function inferFunctionalGoal(
  context: WorkflowActionContext,
  effects: StepEffects | undefined,
): FunctionalGoal {
  const predicates: GoalPredicate[] = [];
  const sources = new Set<GoalSource>();
  const seen = new Set<string>();
  const push = (predicate: GoalPredicate): void => {
    const key = `${predicate.kind}|${predicate.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    predicates.push(predicate);
  };
  // Un champ (ou une case) introuvable : l'objectif est d'abord que CE contrôle soit disponible — sinon
  // la cible de l'étape SUIVANTE, déjà visible, ferait croire l'objectif atteint sans avoir agi.
  if (context.currentAction.field && context.currentAction.label) {
    push({
      kind: 'VISIBLE_FIELD',
      value: context.currentAction.label,
      ...(context.currentAction.role ? { role: context.currentAction.role } : {}),
      source: 'current step',
      // Le champ se vérifie par son localisateur enregistré quand il n'a pas de nom (css, test id).
      ...(isTechnicalTarget(context.currentAction.target) && context.currentAction.target
        ? { target: context.currentAction.target }
        : {}),
    });
    sources.add('ACTION_LABEL');
  }
  for (const control of (effects?.appears ?? []).slice(0, 3)) {
    const colon = control.indexOf(':');
    const role = colon > 0 && !control.slice(0, colon).includes(' ') ? control.slice(0, colon) : undefined;
    const name = role ? control.slice(colon + 1) : control;
    push({ kind: 'VISIBLE_CONTROL', value: name, ...(role ? { role } : {}), source: 'expected effect' });
    sources.add('EXPECTED_EFFECTS');
  }
  for (const control of (effects?.disappears ?? []).slice(0, 1)) {
    if ((effects?.appears?.length ?? 0) > 0) break;
    const colon = control.indexOf(':');
    push({
      kind: 'ABSENT_CONTROL',
      value: colon > 0 ? control.slice(colon + 1) : control,
      source: 'expected effect',
    });
    sources.add('EXPECTED_EFFECTS');
  }
  for (const field of context.requiredFutureFields.slice(0, 3)) {
    if (!field.label) continue;
    push({
      kind: 'VISIBLE_FIELD',
      value: field.label,
      ...(field.role ? { role: field.role } : {}),
      source: `next step ${String(field.index)}`,
      ...(isTechnicalTarget(field.target) && field.target ? { target: field.target } : {}),
    });
    sources.add('NEXT_ACTIONS');
  }
  if (context.requiredFutureFields.length === 0) {
    const [next] = context.requiredFutureControls;
    if (next && next.index === context.currentAction.index + 1 && next.label) {
      push({
        kind: 'CONTROL_AVAILABLE',
        value: next.label,
        ...(next.role ? { role: next.role } : {}),
        source: `next step ${String(next.index)}`,
        ...(isTechnicalTarget(next.target) && next.target ? { target: next.target } : {}),
      });
      sources.add('NEXT_ACTIONS');
    }
  }
  if (effects?.route) {
    push({ kind: 'ROUTE', value: effects.route, source: 'expected effect' });
    sources.add('EXPECTED_EFFECTS');
  }
  if (context.currentAction.label) sources.add('ACTION_LABEL');
  const subject =
    slugOf(context.currentAction.label) || slugOf(context.requiredFutureFields[0]?.label ?? '') || 'STEP';
  const confirmedByBoth = sources.has('EXPECTED_EFFECTS') && sources.has('NEXT_ACTIONS');
  const confidence =
    predicates.length === 0 ? 0 : confirmedByBoth ? 0.9 : sources.has('EXPECTED_EFFECTS') ? 0.75 : 0.6;
  const level: IntentConfidence =
    predicates.length === 0 ? 'UNRESOLVED' : confirmedByBoth ? 'HIGH' : confidence >= 0.7 ? 'MEDIUM' : 'LOW';
  return {
    id: `${subject}_AVAILABLE`,
    predicates,
    confidence,
    level,
    source: [...sources],
  };
}

/** Le texte d'un prédicat (« field Company name », « button:Next »). */
export function predicateText(predicate: GoalPredicate): string {
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
  }
}

/** GOAL PROGRESS : 0..1, pas seulement atteint / pas atteint. */
export function goalProgressOf(goal: FunctionalGoal, satisfied: readonly boolean[]): GoalProgress {
  const met: string[] = [];
  const missing: string[] = [];
  goal.predicates.forEach((predicate, at) => {
    (satisfied[at] ? met : missing).push(predicateText(predicate));
  });
  const total = goal.predicates.length;
  const progress = total === 0 ? 0 : Math.round((met.length / total) * 100) / 100;
  return {
    goal: goal.id,
    progress,
    status: total > 0 && met.length === total ? 'REACHED' : met.length > 0 ? 'PARTIAL' : 'NOT_REACHED',
    satisfied: met,
    missing,
  };
}
