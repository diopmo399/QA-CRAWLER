/**
 * FIRST FUNCTIONAL DIVERGENCE : l'étape qui ÉCHOUE n'est pas forcément la CAUSE.
 *
 *   étape 8 : a sélectionné le mauvais onglet (techniquement réussie)
 *   étape 9 : a réussi (dans le mauvais onglet)
 *   étape 10 : cible introuvable → la cause racine est l'étape 8, pas la 10.
 *
 * L'analyse remonte le parcours rejoué : quel est le DERNIER point où le contexte que la cible de
 * l'étape en échec exige (son onglet, sa section ouverte, son dialogue, sa route) tenait encore, et
 * quelle étape l'a perdu (ou devait l'établir et ne l'a pas fait) ? Pure : testable sans navigateur.
 */
export interface FunctionalStepContext {
  route?: string;
  selectedTabs?: string[];
  /** Les sections / accordéons ouverts (aria-expanded=true). */
  expandedSections?: string[];
  /** Le dialogue ouvert. */
  dialog?: string;
}

export interface ReplayedStepView {
  index: number;
  description: string;
  /** La cible enregistrée de l'étape (« tab:Company », « button:Apply »). */
  target?: { role?: string; name?: string };
  before?: FunctionalStepContext;
  after?: FunctionalStepContext;
}

/** Le contexte que la cible de l'étape en échec exige (son empreinte enregistrée). */
export interface RequiredContext {
  tab?: string;
  accordion?: string;
  dialog?: string;
  route?: string;
}

export interface FirstFunctionalDivergence {
  /** L'étape où la divergence fonctionnelle a commencé (= l'étape en échec si rien de plus tôt). */
  stepIndex: number;
  failedStep: number;
  /** Le contexte perdu (« tab Company »), et comment. */
  dimension?: 'tab' | 'accordion' | 'dialog' | 'route';
  expected?: string;
  observed?: string;
  /** LOST : un contexte présent avant l'étape a disparu après ; NOT_ESTABLISHED : l'étape devait l'établir. */
  kind?: 'LOST' | 'NOT_ESTABLISHED';
  /** Le dernier point où le contexte requis tenait encore. */
  lastConfirmedCheckpoint?: number;
  reasons: string[];
}

const norm = (text: string | undefined): string =>
  (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Le contexte tient-il ? (undefined : la dimension n'a pas été observée) */
function holds(
  context: FunctionalStepContext | undefined,
  dimension: 'tab' | 'accordion' | 'dialog' | 'route',
  expected: string,
): boolean | undefined {
  if (!context) return undefined;
  if (dimension === 'tab')
    return context.selectedTabs
      ? context.selectedTabs.some((tab) => norm(tab) === norm(expected))
      : undefined;
  if (dimension === 'accordion')
    return context.expandedSections
      ? context.expandedSections.some((section) => norm(section) === norm(expected))
      : undefined;
  if (dimension === 'dialog')
    return context.dialog === undefined ? false : norm(context.dialog) === norm(expected);
  return context.route === undefined ? undefined : norm(context.route) === norm(expected);
}

const observedOf = (
  context: FunctionalStepContext | undefined,
  dimension: 'tab' | 'accordion' | 'dialog' | 'route',
): string | undefined =>
  dimension === 'tab'
    ? context?.selectedTabs?.join(', ')
    : dimension === 'accordion'
      ? context?.expandedSections?.join(', ')
      : dimension === 'dialog'
        ? context?.dialog
        : context?.route;

export function locateFirstFunctionalDivergence(input: {
  failedStep: number;
  required: RequiredContext;
  history: readonly ReplayedStepView[];
  /** Le contexte observé maintenant (au moment de l'échec). */
  current?: FunctionalStepContext;
}): FirstFunctionalDivergence {
  const none: FirstFunctionalDivergence = {
    stepIndex: input.failedStep,
    failedStep: input.failedStep,
    reasons: ['no earlier step lost the required context'],
  };
  const dimensions = (['tab', 'accordion', 'dialog', 'route'] as const).filter(
    (dimension) => input.required[dimension] !== undefined,
  );
  const history = [...input.history]
    .filter((step) => step.index < input.failedStep)
    .sort((a, b) => a.index - b.index);
  for (const dimension of dimensions) {
    const expected = input.required[dimension] ?? '';
    // Le contexte requis tient MAINTENANT : il n'explique pas l'échec.
    if (holds(input.current, dimension, expected) === true) continue;
    // 1. LOST : de la plus récente à la plus ancienne, l'étape après laquelle le contexte a disparu.
    for (const step of [...history].reverse()) {
      if (
        holds(step.before, dimension, expected) === true &&
        holds(step.after, dimension, expected) === false
      )
        return {
          stepIndex: step.index,
          failedStep: input.failedStep,
          dimension,
          expected,
          ...(observedOf(step.after, dimension) ? { observed: observedOf(step.after, dimension) } : {}),
          kind: 'LOST',
          lastConfirmedCheckpoint: step.index - 1,
          reasons: [
            `step ${String(step.index)} "${step.description}" left ${dimension} "${expected}" (now "${observedOf(step.after, dimension) ?? 'none'}")`,
            `step ${String(input.failedStep)} needs ${dimension} "${expected}"`,
          ],
        };
    }
    // 2. NOT_ESTABLISHED : l'étape qui devait l'établir (sa cible EST ce contexte), mais après laquelle il ne tient pas.
    const establisher = [...history]
      .reverse()
      .find(
        (step) =>
          norm(step.target?.name) === norm(expected) &&
          (dimension !== 'tab' || step.target?.role === 'tab' || step.target?.role === undefined),
      );
    if (establisher && holds(establisher.after, dimension, expected) === false)
      return {
        stepIndex: establisher.index,
        failedStep: input.failedStep,
        dimension,
        expected,
        ...(observedOf(establisher.after, dimension)
          ? { observed: observedOf(establisher.after, dimension) }
          : {}),
        kind: 'NOT_ESTABLISHED',
        lastConfirmedCheckpoint: establisher.index - 1,
        reasons: [
          `step ${String(establisher.index)} "${establisher.description}" should have established ${dimension} "${expected}" but "${observedOf(establisher.after, dimension) ?? 'none'}" is active`,
          ...(input.failedStep - 1 > establisher.index
            ? [
                `steps ${String(establisher.index + 1)}–${String(input.failedStep - 1)} ran in the wrong context`,
              ]
            : []),
        ],
      };
    // 3. Un contexte changé par une étape (sans qu'il ait été requis avant) : la dernière étape qui a
    //    changé cette dimension vers une autre valeur.
    for (const step of [...history].reverse()) {
      const before = observedOf(step.before, dimension);
      const after = observedOf(step.after, dimension);
      if (after !== undefined && before !== after && holds(step.after, dimension, expected) === false)
        return {
          stepIndex: step.index,
          failedStep: input.failedStep,
          dimension,
          expected,
          observed: after,
          kind: 'LOST',
          lastConfirmedCheckpoint: step.index - 1,
          reasons: [
            `step ${String(step.index)} "${step.description}" changed ${dimension} to "${after}"`,
            `step ${String(input.failedStep)} needs ${dimension} "${expected}"`,
          ],
        };
    }
  }
  return none;
}
