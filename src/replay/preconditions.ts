import type { FlowStep } from '../config/flow-schema.js';
import { normalize, present, routeMatches } from '../flows/action-effect-verifier.js';
import { labelSimilarity } from '../workflow-healing/similarity.js';
import { isTechnicalTarget, targetLabel } from '../workflow-healing/workflow-context.js';
import type {
  FunctionalCheckpoint,
  ObservedFunctionalState,
  PreconditionCheck,
  PreconditionExplanation,
  StepDependency,
  StepPrecondition,
} from './model.js';

/** Les intentions / libellés d'une action qui SOUMET ce qui a été saisi avant elle. */
const SUBMIT_INTENTS = new Set([
  'SEARCH',
  'FILTER',
  'SUBMIT',
  'SAVE',
  'CONFIRM',
  'CREATE',
  'UPDATE',
  'NEXT',
  'VALIDATE',
  'LOGIN',
  'SIGN_IN',
]);
const SUBMIT_WORDS =
  /\b(search|find|rechercher|chercher|submit|save|enregistrer|sauvegarder|confirm|confirmer|create|cr[ée]er|next|suivant|continue|continuer|ok|validate|valider|send|envoyer|login|log in|sign in|connexion|se connecter|add|ajouter|apply|run|lancer|go)\b/i;

/**
 * STEP DEPENDENCIES : ce qu'une étape EXIGE des étapes précédentes —
 *
 *   fill Name (2) ─FILLS_FIELD─▶ click Search (3) ─REVEALS_TARGET─▶ click Item 42 (4)
 *   goto /items (1) ─REACHES_ROUTE─▶ …            ─OPENS_DIALOG─▶ fill Description (6)
 *
 * — pour qu'un échec en 4 remonte à 3 (« la recherche n'a pas vraiment eu lieu ») au lieu de
 * réparer le bouton de sélection. Pure : dérivée du flow seul (effets enregistrés, empreintes,
 * intention fonctionnelle, routes).
 */
export function deriveDependencies(steps: readonly FlowStep[]): StepDependency[] {
  const dependencies: StepDependency[] = [];
  const add = (dependency: StepDependency): void => {
    if (
      dependencies.some(
        (known) =>
          known.step === dependency.step &&
          known.requires === dependency.requires &&
          known.kind === dependency.kind,
      )
    )
      return;
    dependencies.push(dependency);
  };
  let lastRouteStep: number | undefined;
  let lastRoute: string | undefined;
  steps.forEach((step, position) => {
    const index = position + 1;
    if (step.kind === 'goto') {
      lastRouteStep = index;
      lastRoute = step.url;
      return;
    }
    if (
      step.kind === 'screenshot' ||
      step.kind === 'manual' ||
      step.kind === 'auto' ||
      step.kind === 'intent'
    )
      return;
    // Une route atteinte par une étape précédente : la suite en dépend jusqu'à la prochaine route.
    if (lastRouteStep !== undefined && lastRouteStep !== index)
      add({
        step: index,
        requires: lastRouteStep,
        kind: 'REACHES_ROUTE',
        reason: `route ${lastRoute ?? ''} reached by step ${String(lastRouteStep)}`,
      });
    if ('target' in step) {
      const label = targetLabel(step.target);
      // La cible est révélée par l'effet enregistré d'une étape précédente (appears) → REVEALS_TARGET.
      for (let at = position - 1; at >= 0; at -= 1) {
        const earlier = steps[at];
        if (!earlier || !('effects' in earlier) || !earlier.effects) continue;
        const appears = earlier.effects.appears ?? [];
        if (appears.some((control) => sameControl(control, label, step.target.role))) {
          add({
            step: index,
            requires: at + 1,
            kind: 'REVEALS_TARGET',
            reason: `"${label}" appeared after step ${String(at + 1)} during the recording`,
          });
          break;
        }
      }
      // La cible vit dans un dialogue : l'étape qui l'a ouvert (effet « dialog » ou intention OPEN_DIALOG).
      const dialog = step.fingerprint?.dialog ?? step.fingerprint?.owner?.replace(/^dialog:/, '');
      if (dialog && !step.fingerprint?.owner?.startsWith('listbox:'))
        for (let at = position - 1; at >= 0; at -= 1) {
          const earlier = steps[at];
          if (!earlier) continue;
          const opened =
            ('effects' in earlier &&
              (earlier.effects?.appears ?? []).some((control) =>
                normalize(control).toLowerCase().includes(normalize(dialog).toLowerCase()),
              )) ||
            (earlier.functionalIntent?.ui === 'OPEN_DIALOG' && earlier.kind === 'click');
          if (opened) {
            add({
              step: index,
              requires: at + 1,
              kind: 'OPENS_DIALOG',
              reason: `dialog "${dialog}" opened by step ${String(at + 1)}`,
            });
            break;
          }
        }
      // Une action qui soumet dépend des saisies faites depuis la dernière soumission / route sur cet écran.
      if (step.kind === 'click' && isSubmitLike(step)) {
        for (let at = position - 1; at >= 0; at -= 1) {
          const earlier = steps[at];
          if (!earlier) continue;
          if (earlier.kind === 'goto' || (earlier.kind === 'click' && isSubmitLike(earlier))) break;
          if (earlier.kind === 'fill' || earlier.kind === 'select' || earlier.kind === 'check')
            add({
              step: index,
              requires: at + 1,
              kind: 'FILLS_FIELD',
              reason: `"${targetLabel(earlier.target)}" entered at step ${String(at + 1)} is submitted by this action`,
            });
        }
      }
      // Une donnée de test citée (le résultat créé plus haut, à ouvrir) : l'étape qui l'a produite.
      const cited = citedTestData(step);
      if (cited)
        for (let at = position - 1; at >= 0; at -= 1) {
          const earlier = steps[at];
          if (
            earlier?.kind === 'fill' &&
            typeof earlier.value !== 'string' &&
            'testData' in earlier.value &&
            earlier.value.testData === cited
          ) {
            add({
              step: index,
              requires: at + 1,
              kind: 'PRODUCES_DATA',
              reason: `testData.${cited} entered at step ${String(at + 1)}`,
            });
            break;
          }
        }
      // Le lien de précédence immédiat (l'étape d'action juste avant), quand rien de plus précis n'existe.
      if (
        !dependencies.some((dependency) => dependency.step === index && dependency.kind !== 'REACHES_ROUTE')
      ) {
        const previous = previousActionStep(steps, position);
        if (previous !== undefined)
          add({
            step: index,
            requires: previous,
            kind: 'PRECEDES',
            reason: `follows step ${String(previous)}`,
          });
      }
    }
  });
  return dependencies;
}

/**
 * STEP PRECONDITIONS : « Can I execute this action? » — la cible présente et activée, les champs
 * que l'action soumet encore remplis, la route / le dialogue attendus, aucun overlay bloquant, le
 * checkpoint précédent confirmé. HARD : non satisfaite, l'action n'est pas exécutée (mode enforce) ;
 * SOFT : signalée, et versée à l'analyse de divergence si l'étape échoue ensuite.
 */
export function derivePreconditions(
  steps: readonly FlowStep[],
  index: number,
  dependencies: readonly StepDependency[],
  checkpoints: readonly FunctionalCheckpoint[] = [],
): StepPrecondition[] {
  const step = steps[index - 1];
  if (!step || !('target' in step)) return [];
  const preconditions: StepPrecondition[] = [];
  const label = targetLabel(step.target);
  const technical = isTechnicalTarget(step.target);
  const revealedBy = revealer(dependencies, index);
  preconditions.push({
    kind: 'TARGET_PRESENT',
    value: step.target.role ? `${step.target.role}:${label}` : label,
    severity: 'HARD',
    ...(revealedBy !== undefined ? { establishedBy: revealedBy } : {}),
    reason: technical ? 'the recorded locator must resolve to an element' : 'the target must be on screen',
  });
  if (step.kind === 'click' || step.kind === 'check' || step.kind === 'uncheck')
    preconditions.push({
      kind: 'TARGET_ENABLED',
      value: label,
      severity: 'SOFT',
      reason: 'a disabled control cannot take the action',
    });
  preconditions.push({
    kind: 'NO_OVERLAY',
    value: 'blocking overlay',
    severity: 'SOFT',
    reason: 'a modal or a loading overlay would swallow the action',
  });
  for (const dependency of dependencies.filter((candidate) => candidate.step === index)) {
    const required = steps[dependency.requires - 1];
    if (!required) continue;
    if (dependency.kind === 'FILLS_FIELD' && 'target' in required)
      preconditions.push({
        kind: 'FIELD_FILLED',
        value: targetLabel(required.target),
        // Une saisie perdue avant une soumission : l'action ne doit pas partir (HARD, mode enforce).
        severity: required.kind === 'fill' ? 'HARD' : 'SOFT',
        establishedBy: dependency.requires,
        reason: dependency.reason,
      });
    if (dependency.kind === 'REACHES_ROUTE' && required.kind === 'goto')
      preconditions.push({
        kind: 'ROUTE',
        value: required.url,
        severity: 'SOFT',
        establishedBy: dependency.requires,
        reason: dependency.reason,
      });
    if (dependency.kind === 'OPENS_DIALOG' && step.fingerprint?.dialog)
      preconditions.push({
        kind: 'DIALOG_OPEN',
        value: step.fingerprint.dialog,
        severity: 'SOFT',
        establishedBy: dependency.requires,
        reason: dependency.reason,
      });
    if (dependency.kind === 'PRODUCES_DATA') {
      const cited = citedTestData(step);
      if (cited)
        preconditions.push({
          kind: 'TEST_DATA',
          value: cited,
          severity: 'HARD',
          establishedBy: dependency.requires,
          reason: dependency.reason,
        });
    }
  }
  if (step.fingerprint?.dialog && !preconditions.some((precondition) => precondition.kind === 'DIALOG_OPEN'))
    preconditions.push({
      kind: 'DIALOG_OPEN',
      value: step.fingerprint.dialog,
      severity: 'SOFT',
      reason: 'the target was recorded inside this dialog',
    });
  const previous = [...checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.afterStep < index && checkpoint.strength === 'STRONG');
  if (previous)
    preconditions.push({
      kind: 'CHECKPOINT',
      value: previous.id,
      severity: 'SOFT',
      establishedBy: previous.afterStep,
      reason: `${previous.label} must hold before this step`,
    });
  return preconditions;
}

/** Les préconditions confrontées à l'état observé AVANT l'action (jamais une valeur saisie). */
export function checkPreconditions(
  preconditions: readonly StepPrecondition[],
  observed: ObservedFunctionalState | undefined,
  confirmedCheckpoints: readonly string[] = [],
  availableTestData: readonly string[] = [],
): PreconditionCheck[] {
  const controls = new Set((observed?.controls ?? []).map((control) => control.toLowerCase()));
  const enabled = observed?.enabledControls
    ? new Set(observed.enabledControls.map((control) => control.toLowerCase()))
    : undefined;
  const lost = new Set((observed?.filledLost ?? []).map((field) => normalize(field).toLowerCase()));
  const held = new Set((observed?.filledHeld ?? []).map((field) => normalize(field).toLowerCase()));
  return preconditions.map((precondition) => {
    let satisfied: boolean | undefined;
    let detail = '';
    switch (precondition.kind) {
      case 'TARGET_PRESENT':
        satisfied = observed ? present(controls, precondition.value.toLowerCase()) || undefined : undefined;
        detail = satisfied ? 'on screen' : 'not seen among the visible controls (the locator will decide)';
        break;
      case 'TARGET_ENABLED':
        satisfied = enabled
          ? present(enabled, precondition.value.toLowerCase()) ||
            (present(controls, precondition.value.toLowerCase()) ? false : undefined)
          : undefined;
        detail = satisfied === false ? 'present but disabled' : satisfied ? 'enabled' : 'not observable';
        break;
      case 'FIELD_FILLED': {
        const key = normalize(precondition.value).toLowerCase();
        satisfied = lost.has(key) ? false : held.has(key) ? true : undefined;
        detail =
          satisfied === false
            ? 'the value entered earlier is no longer in the field'
            : satisfied
              ? 'still holds the entered value'
              : 'not re-read';
        break;
      }
      case 'ROUTE':
        satisfied = observed
          ? routeMatches(precondition.value, observed.route) ||
            observed.route.startsWith(precondition.value.split('?')[0] ?? precondition.value)
          : undefined;
        detail = observed ? `current route ${observed.route}` : 'route not observed';
        break;
      case 'NO_OVERLAY':
        satisfied = observed ? !observed.overlay : undefined;
        detail = observed?.overlay ? `overlay "${observed.overlay}"` : 'no overlay';
        break;
      case 'DIALOG_OPEN':
        satisfied = observed
          ? observed.dialog
            ? normalize(observed.dialog).toLowerCase().includes(normalize(precondition.value).toLowerCase())
            : false
          : undefined;
        detail = observed?.dialog ? `open dialog "${observed.dialog}"` : 'no dialog open';
        break;
      case 'CHECKPOINT':
        satisfied = confirmedCheckpoints.includes(precondition.value);
        detail = satisfied ? 'confirmed' : 'not confirmed';
        break;
      case 'TEST_DATA':
        satisfied = availableTestData.includes(precondition.value);
        detail = satisfied ? 'available for this run' : 'not produced in this run';
        break;
    }
    return { precondition, satisfied, detail };
  });
}

/**
 * Pourquoi la précondition n'est pas satisfaite : remonter la chaîne des dépendances jusqu'à
 * l'étape la plus en amont qui n'a pas tenu (checkpoint manquant, étape non commise), plutôt que
 * de réparer l'étape courante.
 */
export function explainUnmetPrecondition(
  check: PreconditionCheck,
  index: number,
  steps: readonly FlowStep[],
  dependencies: readonly StepDependency[],
  held: (step: number) => boolean | undefined,
): PreconditionExplanation {
  const chain: PreconditionExplanation['chain'] = [
    { step: index, label: labelOfStep(steps, index), held: false },
  ];
  const reasons: string[] = [`${check.precondition.kind} "${check.precondition.value}": ${check.detail}`];
  let root = index;
  const visited = new Set<number>([index]);
  let current = check.precondition.establishedBy;
  // Remonter tant qu'une étape amont n'a PAS tenu (false) ; une étape inconnue est notée, jamais accusée.
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const state = held(current);
    chain.push({ step: current, label: labelOfStep(steps, current), held: state });
    if (state === true) break;
    if (state === false) root = current;
    const upstream = dependencies.filter(
      (dependency) => dependency.step === current && dependency.kind !== 'PRECEDES',
    );
    const failed = upstream.find((dependency) => held(dependency.requires) === false);
    if (!failed) {
      // Ce que l'étape racine exigeait (tenu ou non) : la chaîne complète, lisible.
      for (const dependency of upstream.filter((candidate) => candidate.kind !== 'REACHES_ROUTE'))
        if (!visited.has(dependency.requires)) {
          visited.add(dependency.requires);
          chain.push({
            step: dependency.requires,
            label: labelOfStep(steps, dependency.requires),
            held: held(dependency.requires),
          });
          reasons.push(
            `step ${String(current)} requires step ${String(dependency.requires)}: ${dependency.reason}`,
          );
        }
      break;
    }
    reasons.push(`step ${String(current)} requires step ${String(failed.requires)}: ${failed.reason}`);
    current = failed.requires;
  }
  if (root !== index) reasons.push(`root step ${String(root)}: ${labelOfStep(steps, root)}`);
  return { precondition: check.precondition, rootStep: root, chain, reasons };
}

function revealer(dependencies: readonly StepDependency[], index: number): number | undefined {
  return dependencies.find(
    (dependency) =>
      dependency.step === index &&
      (dependency.kind === 'REVEALS_TARGET' || dependency.kind === 'OPENS_DIALOG'),
  )?.requires;
}

function isSubmitLike(step: FlowStep): boolean {
  if (step.kind !== 'click') return false;
  const intent = step.functionalIntent;
  if (intent && intent.status !== 'UNKNOWN') {
    if (intent.operation && SUBMIT_INTENTS.has(intent.operation)) return true;
    if (intent.ui && SUBMIT_INTENTS.has(intent.ui)) return true;
  }
  if (step.fingerprint?.tag === 'button' && step.fingerprint.stableAttributes?.type === 'submit') return true;
  return SUBMIT_WORDS.test(targetLabel(step.target));
}

function sameControl(control: string, label: string, role: string | undefined): boolean {
  const colon = control.indexOf(':');
  const controlRole =
    colon > 0 && !control.slice(0, colon).includes(' ') ? control.slice(0, colon) : undefined;
  const name = controlRole ? control.slice(colon + 1) : control;
  if (role && controlRole && role !== controlRole) return false;
  return labelSimilarity(name, label) >= 0.9;
}

function citedTestData(step: FlowStep): string | undefined {
  if (!('target' in step)) return undefined;
  const text = JSON.stringify(step.target);
  return /\$\{testData:([A-Za-z0-9_.-]+)\}/.exec(text)?.[1];
}

function previousActionStep(steps: readonly FlowStep[], position: number): number | undefined {
  for (let at = position - 1; at >= 0; at -= 1) {
    const step = steps[at];
    if (!step) return undefined;
    if ('target' in step || step.kind === 'goto') return at + 1;
  }
  return undefined;
}

function labelOfStep(steps: readonly FlowStep[], index: number): string {
  const step = steps[index - 1];
  if (!step) return `step ${String(index)}`;
  if ('target' in step) return `${step.kind} "${targetLabel(step.target)}"`;
  if (step.kind === 'goto') return `goto ${step.url}`;
  return step.kind;
}
