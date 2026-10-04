import { classifyEffects, expectedEffectsFrom } from './effect-causality.js';
import type { StepEffects } from '../config/flow-schema.js';
import type {
  RawRecordedEvent,
  RecordedFlow,
  RecordedState,
  RecordingWarning,
  SemanticRecordedAction,
} from './model.js';

/**
 * HUMAN JOURNEY — PRESERVE FIRST, UNDERSTAND SECOND, OPTIMIZE LAST.
 *
 * Le Human Recorder ne cherche pas le chemin le plus court vers l'écran final : il garde le
 * parcours ENSEIGNÉ par l'humain. Chaque interaction significative reçoit un id (h001…) et un
 * numéro d'ordre dès la trace brute, et termine dans un statut explicite : préservée (étape
 * du flow), fusionnée (frappe, focus, correction), bruit confirmé, ou exclue avec sa raison.
 * Une interaction non comprise devient UNRESOLVED_BUT_PRESERVED — jamais « absente ».
 */

export type HumanInteractionType =
  'CLICK' | 'FILL' | 'CHECK' | 'SELECT' | 'SUBMIT' | 'KEY' | 'DIALOG' | 'UPLOAD' | 'DRAG_AND_DROP';

export interface HumanInteraction {
  id: string;
  sequence: number;
  timestamp: number;
  type: HumanInteractionType;
  /** Libellé lisible de la cible (jamais une valeur saisie). */
  target?: string;
  rawEventIds: string[];
  source: 'HUMAN';
  /** Pourquoi la capture l'a jugée sans intention propre (focus, ouverture d'une liste native…). */
  noise?: string;
}

export type InteractionStatus =
  | 'PRESERVED'
  | 'MERGED'
  | 'COLLAPSED_CORRECTION'
  | 'DUPLICATE'
  | 'HUMAN_NOISE'
  | 'SUPERSEDED'
  | 'UNRESOLVED_BUT_PRESERVED'
  | 'BLOCKED_BY_POLICY'
  | 'EXCLUDED_WITH_REASON'
  /** Interdit : une interaction perdue sans explication (FLOW_GENERATION_LOST_HUMAN_ACTIONS). */
  | 'UNACCOUNTED';

/** Le compte d'une interaction : où elle est dans le flow, ou pourquoi elle n'y est pas. */
export interface InteractionAccount {
  interactionId: string;
  sequence: number;
  type: HumanInteractionType;
  target?: string;
  status: InteractionStatus;
  /** Étape du flow (1, 2…), pour une interaction préservée. */
  flowStep?: number;
  actionId?: string;
  /** L'interaction qui la représente (fusion). */
  mergedInto?: string;
  reason?: string;
  /** La règle qui l'a fusionnée ou exclue (REDUNDANT_FOCUS_CLICK, TYPING_MERGED…). */
  rule?: string;
  rawEventIds: string[];
  effects?: string[];
  testData?: string;
}

/** Un effet de l'action sur l'écran, même sans changement d'adresse ni requête. */
export type DomEffect =
  | 'ROUTE_CHANGED'
  | 'FIELD_ADDED'
  | 'FIELD_REMOVED'
  | 'HIDDEN_TO_VISIBLE'
  | 'VISIBLE_TO_HIDDEN'
  | 'MODAL_OPENED'
  | 'MODAL_CLOSED'
  | 'VALIDATION_CHANGED'
  | 'FORM_STRUCTURE_CHANGED';

/** A → B : l'action B n'était possible qu'après A (le champ n'était pas accessible avant). */
export interface ActionDependency {
  from: string;
  to: string;
  /** FORWARD : vu juste après A ; BACKWARD : déduit de B (absent avant A, utilisé ensuite). */
  evidence: 'FORWARD' | 'BACKWARD';
  reason: string;
}

export interface WorkflowPhase {
  index: number;
  label: string;
  interactionIds: string[];
}

export interface JourneySummary {
  meaningful: number;
  preserved: number;
  unresolvedPreserved: number;
  merged: number;
  excluded: number;
  noise: number;
  unaccounted: number;
}

export interface HumanJourneyResult {
  interactions: HumanInteraction[];
  accounts: InteractionAccount[];
  dependencies: ActionDependency[];
  phases: WorkflowPhase[];
  summary: JourneySummary;
  /** Les actions préservées sont-elles dans l'ordre humain ? */
  ordered: boolean;
  warnings: RecordingWarning[];
}

/** Le bruit qui a une interaction cible : focus, ouverture d'une liste, libellé d'une case. */
const MERGEABLE_NOISE: readonly [RegExp, string, readonly HumanInteractionType[]][] = [
  [/focus click/, 'REDUNDANT_FOCUS_CLICK', ['FILL']],
  [/native list/, 'LIST_OPENED_FOR_SELECT', ['SELECT']],
  [/toggle|label of a control/, 'CONTROL_LABEL_FOR_CHANGE', ['CHECK', 'FILL', 'SELECT']],
];
export const NON_INTERACTIVE_NOISE = 'click on a non-interactive element';

// ------------------------------------------------------------------ timeline

/**
 * HUMAN INTERACTION TIMELINE : les interactions humaines dans l'ordre où l'humain les a
 * commencées. Les saisies successives d'un même champ (frappe, debounce, valeur validée)
 * sont UNE interaction ; un clic, un choix, une case, un envoi, une touche en sont une chacun.
 */
export function buildInteractionTimeline(events: readonly RawRecordedEvent[]): {
  interactions: HumanInteraction[];
  byRaw: Map<string, HumanInteraction>;
} {
  const ordered = events
    .map((event, index) => ({ event, index, at: event.value?.startedAt ?? event.at }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.event);
  const interactions: HumanInteraction[] = [];
  const byRaw = new Map<string, HumanInteraction>();
  let lastField: { key: string; interaction: HumanInteraction } | undefined;
  const add = (event: RawRecordedEvent, type: HumanInteractionType, target?: string): HumanInteraction => {
    const interaction: HumanInteraction = {
      id: `h${String(interactions.length + 1).padStart(3, '0')}`,
      sequence: interactions.length + 1,
      timestamp: event.value?.startedAt ?? event.at,
      type,
      ...(target ? { target } : {}),
      rawEventIds: [event.id],
      source: 'HUMAN',
      ...(event.noise ? { noise: event.noise } : {}),
    };
    interactions.push(interaction);
    byRaw.set(event.id, interaction);
    return interaction;
  };
  for (const event of ordered) {
    const element = event.element;
    const label = element ? (element.label ?? element.name) || element.groupLabel || element.tag : undefined;
    switch (event.type) {
      case 'click':
        lastField = undefined;
        add(event, element?.isSubmit ? 'SUBMIT' : 'CLICK', label);
        break;
      case 'submit':
        lastField = undefined;
        add(event, 'SUBMIT', label);
        break;
      case 'keydown':
        lastField = undefined;
        add(event, 'KEY', event.key);
        break;
      case 'dialog':
        lastField = undefined;
        add(event, 'DIALOG', event.dialog?.kind);
        break;
      case 'filechooser':
        lastField = undefined;
        add(event, 'UPLOAD', label);
        break;
      case 'drag':
        // Un glisser-déposer est UNE interaction humaine (appui, déplacement, dépôt corrélés).
        lastField = undefined;
        add(event, 'DRAG_AND_DROP', event.drag?.item ?? label);
        break;
      case 'input':
      case 'change': {
        if (!element) break;
        const type: HumanInteractionType =
          element.tag === 'select' || event.value?.option !== undefined
            ? element.inputType === 'radio'
              ? 'CHECK'
              : 'SELECT'
            : element.inputType === 'checkbox' || element.inputType === 'radio' || element.role === 'switch'
              ? 'CHECK'
              : element.inputType === 'file'
                ? 'UPLOAD'
                : 'FILL';
        const key = `${type}|${element.css}|${element.name}`;
        // Une saisie qui continue (même champ, rien entre) : la même interaction.
        if (type === 'FILL' && lastField?.key === key) {
          lastField.interaction.rawEventIds.push(event.id);
          byRaw.set(event.id, lastField.interaction);
          break;
        }
        const interaction = add(event, type, label);
        lastField = type === 'FILL' ? { key, interaction } : undefined;
        break;
      }
      default:
        break;
    }
  }
  return { interactions, byRaw };
}

// ------------------------------------------------------------------ effects and dependencies

const normalizeName = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[*:]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Les noms des contrôles visibles d'un écran (role:nom → nom). */
function names(state: RecordedState | undefined): Set<string> | undefined {
  if (!state) return undefined;
  return new Set(state.controls.map((control) => normalizeName(control.slice(control.indexOf(':') + 1))));
}

/** Le nom de la cible d'une action, tel que l'écran l'expose. */
export function targetName(action: SemanticRecordedAction): string | undefined {
  const target = action.target?.target;
  if (!target) return undefined;
  const text = target.strategy === 'role' ? target.name : target.value;
  return text ? normalizeName(text) : undefined;
}

/** Ce que l'action a changé à l'écran, d'après l'écran avant et l'écran après. */
export function domEffects(before: RecordedState | undefined, after: RecordedState | undefined): DomEffect[] {
  if (!before || !after || before.id === after.id) return [];
  const effects: DomEffect[] = [];
  if (before.route !== after.route) effects.push('ROUTE_CHANGED');
  const was = new Set(before.controls);
  const now = new Set(after.controls);
  const added = [...now].filter((control) => !was.has(control));
  const removed = [...was].filter((control) => !now.has(control));
  const field = (control: string): boolean =>
    /^(textbox|combobox|checkbox|radio|spinbutton|searchbox|switch|listbox|slider):/.test(control);
  if (added.some(field)) effects.push('FIELD_ADDED');
  if (removed.some(field)) effects.push('FIELD_REMOVED');
  if (added.length > 0) effects.push('HIDDEN_TO_VISIBLE');
  if (removed.length > 0) effects.push('VISIBLE_TO_HIDDEN');
  if (after.dialogs.length > before.dialogs.length) effects.push('MODAL_OPENED');
  if (after.dialogs.length < before.dialogs.length) effects.push('MODAL_CLOSED');
  if (after.invalidFields !== before.invalidFields) effects.push('VALIDATION_CHANGED');
  if (added.some(field) && removed.some(field)) effects.push('FORM_STRUCTURE_CHANGED');
  return effects;
}

const MAX_LOOK_BACK = 60;
const ENABLING = new Set(['CLICK', 'CHECK', 'UNCHECK', 'SELECT', 'SUBMIT', 'CONFIRM']);

/**
 * Les effets de chaque action sur l'écran. Une saisie n'est validée qu'en quittant le champ —
 * souvent par le clic suivant : la saisie et le clic partagent alors la même observation.
 * L'effet (section ouverte, champs révélés) revient à l'action qui peut le produire (clic,
 * case, choix), et cette action a eu lieu sur l'écran d'AVANT le groupe.
 */
export function attributeEffects(
  actions: readonly SemanticRecordedAction[],
  states: readonly RecordedState[],
): void {
  const stateById = new Map(states.map((state) => [state.id, state]));
  let start = 0;
  while (start < actions.length) {
    const first = actions[start];
    if (!first) break;
    let end = start;
    // UNE observation partagée (même identité d'observation) ; un ancien enregistrement sans identité :
    // le même écran d'après (comportement historique).
    const sameObservation = (next: SemanticRecordedAction | undefined): boolean =>
      next !== undefined &&
      (first.observationId !== undefined && next.observationId !== undefined
        ? next.observationId === first.observationId
        : next.stateAfter === first.stateAfter);
    while (
      first.stateAfter !== undefined &&
      first.type !== 'NAVIGATE' &&
      sameObservation(actions[end + 1]) &&
      actions[end + 1]?.type !== 'NAVIGATE'
    )
      end += 1;
    const group = actions.slice(start, end + 1);
    const before = first.stateBefore;
    const enablers = group.filter((action) => ENABLING.has(action.type));
    if (group.length > 1) for (const action of enablers) if (before) action.stateBefore = before;
    // THE NEXT HUMAN ACTION CREATES A STRONG CAUSAL BOUNDARY : un écran partagé revient au geste le
    // PLUS RÉCENT avant l'observation (une saisie validée par le clic qui suit : ce clic). Les gestes
    // plus anciens du groupe ne gardent que leurs effets prouvés par identité (réseau, navigation).
    const owner = enablers.at(-1) ?? group.at(-1);
    const beforeState = before ? stateById.get(before) : undefined;
    const afterState = first.stateAfter ? stateById.get(first.stateAfter) : undefined;
    const effects = domEffects(beforeState, afterState);
    if (owner && effects.length > 0) owner.domEffects = effects;
    const nextAction = actions[end + 1];
    for (const action of group) {
      if (action !== owner && !ENABLING.has(action.type)) continue;
      const candidates = classifyEffects({
        action,
        learned: learnExpectedEffects(beforeState, afterState, action),
        ownsScreen: action === owner,
        screenShared: enablers.length > 1,
        ...(owner && action !== owner ? { screenOwner: owner } : {}),
        ...(nextAction ? { next: nextAction } : {}),
      });
      action.effectCausality = candidates;
      const learned = expectedEffectsFrom(action, candidates);
      if (learned) action.expectedEffects = learned;
      else delete action.expectedEffects;
    }
    start = end + 1;
  }
}

/** Le gabarit complet d'une route (/requests/42, /requests/:id → /requests/{id}) : comparé au rejeu. */
export function routeTemplate(route: string): string {
  const hash = route.indexOf('#/');
  const path =
    hash >= 0 ? (route.slice(hash + 1).split('?')[0] ?? '/') : (route.split(/[?#]/)[0] ?? route) || '/';
  return path
    .split('/')
    .map((segment) =>
      /^:/.test(segment)
        ? `{${segment.slice(1)}}`
        : /^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{24,}$/i.test(segment)
          ? '{id}'
          : segment,
    )
    .join('/');
}

/** Un contrôle dont le nom change d'un affichage à l'autre (heure, compteur, chargement) : jamais un effet exigé. */
const UNSTABLE_NAME =
  /\d{3,}|\d{1,2}:\d{2}|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|loading|chargement|spinner|please wait|patienter|^\s*$/i;
const MAX_LEARNED = 3;

/**
 * EXPECTATION LEARNING : ce que l'action a produit pendant l'enregistrement, réduit à ce qui est
 * fonctionnellement stable — des contrôles nommés apparus ou disparus (pas un horodatage, pas un
 * compteur, pas un indicateur de chargement), la route atteinte, la requête envoyée.
 */
export function learnExpectedEffects(
  before: RecordedState | undefined,
  after: RecordedState | undefined,
  action: SemanticRecordedAction,
): StepEffects | undefined {
  const effects: StepEffects = {};
  if (before && after && before.id !== after.id) {
    const was = new Set(before.controls);
    const now = new Set(after.controls);
    const stable = (control: string): boolean => {
      const name = control.slice(control.indexOf(':') + 1);
      return name.length > 1 && name.length <= 60 && !UNSTABLE_NAME.test(name);
    };
    const appears = [...now].filter((control) => !was.has(control) && stable(control)).slice(0, MAX_LEARNED);
    const disappears = [...was].filter((control) => !now.has(control) && stable(control)).slice(0, 2);
    if (appears.length > 0) effects.appears = appears;
    if (disappears.length > 0 && appears.length === 0) effects.disappears = disappears;
    if (before.route !== after.route) effects.route = routeTemplate(after.route);
  }
  const navigated = action.navigation?.routes.at(-1);
  if (navigated && !effects.route) effects.route = routeTemplate(navigated);
  const exchange =
    action.network.find(
      (candidate) => !['GET', 'HEAD', 'OPTIONS'].includes(candidate.method.toUpperCase()),
    ) ?? action.network[0];
  if (exchange) effects.request = `${exchange.method.toUpperCase()} ${routeTemplate(exchange.path)}`;
  return Object.keys(effects).length > 0 ? effects : undefined;
}
const DEPENDENT = new Set([
  'FILL',
  'CLICK',
  'CHECK',
  'UNCHECK',
  'SELECT',
  'SUBMIT',
  'UPLOAD',
  'DRAG_AND_DROP',
]);

/**
 * HUMAN ACTION DEPENDENCY GRAPH : A → B quand la cible de B n'était pas accessible avant A.
 * FORWARD : l'écran observé après A la montre ; BACKWARD : rien de visible juste après A,
 * mais B l'utilise ensuite et elle n'existait pas avant A (la plus récente action de ce genre).
 */
export function dependencyGraph(
  actions: readonly SemanticRecordedAction[],
  states: readonly RecordedState[],
): ActionDependency[] {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const cache = new Map<string, Set<string> | undefined>();
  const namesOf = (id: string | undefined): Set<string> | undefined => {
    if (!id) return undefined;
    if (!cache.has(id)) cache.set(id, names(stateById.get(id)));
    return cache.get(id);
  };
  const dependencies: ActionDependency[] = [];
  for (const [j, later] of actions.entries()) {
    if (!DEPENDENT.has(later.type)) continue;
    const name = targetName(later);
    if (!name) continue;
    let found: ActionDependency | undefined;
    let backward: number | undefined;
    // Une fenêtre bornée en arrière : la cause d'un champ révélé est proche de son usage.
    for (let i = j - 1; i >= Math.max(0, j - MAX_LOOK_BACK); i -= 1) {
      const earlier = actions[i];
      if (!earlier || earlier.type === 'NAVIGATE') break;
      if (!ENABLING.has(earlier.type)) continue;
      const before = namesOf(earlier.stateBefore);
      if (!before || before.size === 0 || before.has(name)) {
        // La cible était déjà là avant cette action : elle n'en dépend pas (ni des plus anciennes).
        if (before?.has(name)) break;
        continue;
      }
      const after = namesOf(earlier.stateAfter);
      if (after?.has(name)) {
        found = {
          from: earlier.id,
          to: later.id,
          evidence: 'FORWARD',
          reason: `"${name}" appeared after "${earlier.target?.label ?? earlier.type}"`,
        };
        break;
      }
      backward ??= i;
    }
    if (!found && backward !== undefined) {
      const earlier = actions[backward];
      if (earlier)
        found = {
          from: earlier.id,
          to: later.id,
          evidence: 'BACKWARD',
          reason: `"${name}" was not available before "${earlier.target?.label ?? earlier.type}", then used`,
        };
    }
    if (found) dependencies.push(found);
  }
  return dependencies;
}

/**
 * Les clics que la capture n'a pas reconnus comme interactifs (un <div>, une carte, un en-tête
 * de composant maison), mais qui ont un effet : l'écran a changé, ou l'action suivante vise un
 * contrôle qui n'existait pas avant eux. Ils sont des actions humaines (UNRESOLVED), pas du bruit.
 */
export function clicksWithEffects(
  events: readonly RawRecordedEvent[],
  states: readonly RecordedState[],
): Map<string, string> {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const promoted = new Map<string, string>();
  let current: string | undefined = states[0]?.id;
  for (const [index, event] of events.entries()) {
    const before = current;
    if (event.stateAfter) current = event.stateAfter;
    if (event.type !== 'click' || event.noise !== NON_INTERACTIVE_NOISE) continue;
    const effects = domEffects(
      before ? stateById.get(before) : undefined,
      event.stateAfter ? stateById.get(event.stateAfter) : undefined,
    ).filter((effect) => effect !== 'VALIDATION_CHANGED');
    if (effects.length > 0) {
      promoted.set(event.id, `the screen changed after it (${effects.join(', ')})`);
      continue;
    }
    // L'action suivante vise un contrôle absent de l'écran avant ce clic.
    const known = names(before ? stateById.get(before) : undefined);
    const next = events
      .slice(index + 1)
      .find((candidate) => ['click', 'input', 'change'].includes(candidate.type) && !candidate.noise);
    const nextName = next?.element ? normalizeName(next.element.label ?? next.element.name) : undefined;
    if (known && known.size > 0 && nextName && !known.has(nextName))
      promoted.set(event.id, `the next action uses "${nextName}", not available before it`);
  }
  return promoted;
}

// ------------------------------------------------------------------ accounting

/**
 * ACTION ACCOUNTING + HUMAN JOURNEY VALIDATOR : chaque interaction termine dans exactement un
 * statut. meaningful = preserved + merged + excluded (+ bruit confirmé) ; unaccounted DOIT
 * valoir 0, sinon FLOW_GENERATION_LOST_HUMAN_ACTIONS.
 */
export function accountHumanJourney(input: {
  events: readonly RawRecordedEvent[];
  actions: readonly SemanticRecordedAction[];
  kept: readonly SemanticRecordedAction[];
  flow: RecordedFlow;
  states: readonly RecordedState[];
  dependencies: readonly ActionDependency[];
}): HumanJourneyResult {
  const { interactions, byRaw } = buildInteractionTimeline(input.events);
  const stepOfAction = new Map<string, number>();
  input.flow.steps.forEach((step, index) => {
    for (const id of step.actionIds) if (!stepOfAction.has(id)) stepOfAction.set(id, index + 1);
  });
  const keptIds = new Set(input.kept.map((action) => action.id));
  /** L'interaction qui « possède » une action : la valeur finale pour une saisie, le geste pour un clic. */
  const ownerOf = (action: SemanticRecordedAction): HumanInteraction | undefined => {
    const owners = action.rawEventIds
      .map((id) => byRaw.get(id))
      .filter((interaction): interaction is HumanInteraction => interaction !== undefined);
    if (owners.length === 0) return undefined;
    return ['FILL', 'SELECT', 'CHECK', 'UNCHECK'].includes(action.type) ? owners.at(-1) : owners[0];
  };
  // Index brut → action (gardée d'abord, sinon écartée) : une recherche par interaction, pas un parcours.
  const keptByRaw = new Map<string, SemanticRecordedAction>();
  for (const action of input.kept)
    for (const id of action.rawEventIds) if (!keptByRaw.has(id)) keptByRaw.set(id, action);
  const droppedByRaw = new Map<string, SemanticRecordedAction>();
  for (const action of input.actions)
    if (!keptIds.has(action.id))
      for (const id of action.rawEventIds) if (!droppedByRaw.has(id)) droppedByRaw.set(id, action);
  const accounts: InteractionAccount[] = [];
  for (const interaction of interactions) {
    const base = {
      interactionId: interaction.id,
      sequence: interaction.sequence,
      type: interaction.type,
      ...(interaction.target ? { target: interaction.target } : {}),
      rawEventIds: interaction.rawEventIds,
    };
    const containing = (
      index: ReadonlyMap<string, SemanticRecordedAction>,
    ): SemanticRecordedAction | undefined => {
      for (const id of interaction.rawEventIds) {
        const action = index.get(id);
        if (action) return action;
      }
      return undefined;
    };
    const keptAction = containing(keptByRaw);
    if (keptAction) {
      const owner = ownerOf(keptAction);
      const step = stepOfAction.get(keptAction.id);
      if (owner && owner.id !== interaction.id) {
        const correction = keptAction.merged?.includes('correction') === true;
        accounts.push({
          ...base,
          status: correction ? 'COLLAPSED_CORRECTION' : 'MERGED',
          mergedInto: owner.id,
          actionId: keptAction.id,
          rule:
            interaction.type === 'SUBMIT' || interaction.type === 'KEY'
              ? 'SAME_GESTURE'
              : correction
                ? 'CORRECTION_BEFORE_VALIDATION'
                : 'TYPING_MERGED',
          reason: keptAction.merged ?? 'same gesture as the step',
        });
        continue;
      }
      if (step !== undefined) {
        const unresolved = keptAction.semanticStatus === 'UNRESOLVED';
        accounts.push({
          ...base,
          status: unresolved ? 'UNRESOLVED_BUT_PRESERVED' : 'PRESERVED',
          flowStep: step,
          actionId: keptAction.id,
          ...(unresolved ? { reason: keptAction.evidence.at(-1) ?? 'intention not understood yet' } : {}),
          ...(keptAction.domEffects && keptAction.domEffects.length > 0
            ? { effects: keptAction.domEffects }
            : {}),
          ...(keptAction.value?.testData ? { testData: keptAction.value.testData } : {}),
        });
        continue;
      }
      if (keptAction.type === 'CONFIRM' || keptAction.type === 'CANCEL') {
        accounts.push({
          ...base,
          status: 'EXCLUDED_WITH_REASON',
          actionId: keptAction.id,
          rule: 'BROWSER_DIALOG',
          reason: 'a browser dialog: answered at replay by browserInteractions.dialogs',
        });
        continue;
      }
      accounts.push({
        ...base,
        status: 'EXCLUDED_WITH_REASON',
        actionId: keptAction.id,
        rule: keptAction.type === 'UPLOAD' ? 'UPLOAD_WITHOUT_NAMED_FIELD' : 'NO_REPLAYABLE_STEP',
        reason:
          keptAction.type === 'UPLOAD'
            ? 'a file chosen in a field without a name: the file itself is never recorded'
            : `${keptAction.type} has no replayable step`,
      });
      continue;
    }
    const droppedAction = containing(droppedByRaw);
    if (droppedAction) {
      accounts.push({ ...base, actionId: droppedAction.id, ...droppedStatus(droppedAction) });
      continue;
    }
    // Pas d'action : un geste que la capture a jugé sans intention propre.
    accounts.push({
      ...base,
      ...noiseStatus(interaction, interactions.slice(interaction.sequence, interaction.sequence + 20)),
    });
  }
  for (const account of accounts)
    if (account.status === 'MERGED' && account.mergedInto === undefined)
      account.mergedInto = account.interactionId;

  const preservedInOrder = accounts
    .filter((account) => account.flowStep !== undefined)
    .map((account) => account.flowStep ?? 0);
  const ordered = preservedInOrder.every(
    (step, index) => index === 0 || step >= (preservedInOrder[index - 1] ?? 0),
  );
  const count = (...statuses: InteractionStatus[]): number =>
    accounts.filter((account) => statuses.includes(account.status)).length;
  const summary: JourneySummary = {
    meaningful: accounts.length,
    preserved: count('PRESERVED'),
    unresolvedPreserved: count('UNRESOLVED_BUT_PRESERVED'),
    merged: count('MERGED', 'COLLAPSED_CORRECTION', 'DUPLICATE'),
    excluded: count('EXCLUDED_WITH_REASON', 'SUPERSEDED', 'BLOCKED_BY_POLICY'),
    noise: count('HUMAN_NOISE'),
    unaccounted: count('UNACCOUNTED'),
  };
  const warnings: RecordingWarning[] = [];
  for (const account of accounts.filter((candidate) => candidate.status === 'UNACCOUNTED'))
    warnings.push({
      code: 'FLOW_GENERATION_LOST_HUMAN_ACTIONS',
      message: `${account.interactionId} ${account.type} "${account.target ?? ''}" is in no flow step and has no reason: the flow is not a faithful journey`,
      ...(account.actionId ? { actionId: account.actionId } : {}),
    });
  if (!ordered)
    warnings.push({
      code: 'FLOW_GENERATION_LOST_HUMAN_ACTIONS',
      message: 'the flow steps are not in the order the human acted: the journey was reordered',
    });
  return {
    interactions,
    accounts,
    dependencies: [...input.dependencies],
    phases: workflowPhases(accounts, input.kept, input.dependencies),
    summary,
    ordered,
    warnings,
  };
}

function droppedStatus(
  action: SemanticRecordedAction,
): Pick<InteractionAccount, 'status' | 'reason' | 'rule'> {
  const reason = action.dropped ?? '';
  if (/^merged into the next input/.test(reason)) return { status: 'MERGED', rule: 'TYPING_MERGED', reason };
  if (/corrected later|toggled back/.test(reason))
    return { status: 'COLLAPSED_CORRECTION', rule: 'CORRECTION_BEFORE_VALIDATION', reason };
  if (/failed validation attempt/.test(reason))
    return { status: 'SUPERSEDED', rule: 'RETRIED_SUBMIT', reason };
  if (/value unchanged/.test(reason))
    return { status: 'EXCLUDED_WITH_REASON', rule: 'PREFILLED_VALUE', reason };
  if (/derived value/.test(reason)) return { status: 'EXCLUDED_WITH_REASON', rule: 'DERIVED_VALUE', reason };
  if (/^detour/.test(reason)) return { status: 'EXCLUDED_WITH_REASON', rule: 'OPTIMIZER_DETOUR', reason };
  if (/navigation caused|same page/.test(reason))
    return { status: 'DUPLICATE', rule: 'NAVIGATION_EFFECT', reason };
  // Une suppression sans règle connue : perdue sans explication.
  return { status: 'UNACCOUNTED', reason: reason || 'removed without a reason' };
}

function noiseStatus(
  interaction: HumanInteraction,
  all: readonly HumanInteraction[],
): Pick<InteractionAccount, 'status' | 'reason' | 'rule' | 'mergedInto'> {
  const after = all.filter(
    (candidate) =>
      candidate.sequence > interaction.sequence && candidate.timestamp - interaction.timestamp < 15_000,
  );
  if (interaction.type === 'KEY') {
    const next = after.find((candidate) => candidate.type !== 'KEY');
    return next && next.timestamp - interaction.timestamp < 3000
      ? {
          status: 'MERGED',
          rule: 'KEY_ALREADY_REPRESENTED',
          mergedInto: next.id,
          reason: `${interaction.target ?? 'key'} pressed: its effect is "${next.type} ${next.target ?? ''}"`,
        }
      : {
          status: 'HUMAN_NOISE',
          rule: 'KEY_WITHOUT_EFFECT',
          reason: `${interaction.target ?? 'key'} pressed without a recorded effect`,
        };
  }
  if (interaction.type === 'UPLOAD') {
    const next = after.find((candidate) => candidate.type === 'UPLOAD');
    return next
      ? {
          status: 'MERGED',
          rule: 'FILE_CHOOSER',
          mergedInto: next.id,
          reason: 'the file chooser of the upload',
        }
      : {
          status: 'EXCLUDED_WITH_REASON',
          rule: 'FILE_CHOOSER_CLOSED',
          reason: 'file chooser opened, no file chosen',
        };
  }
  const noise = interaction.noise ?? '';
  for (const [pattern, rule, types] of MERGEABLE_NOISE) {
    if (!pattern.test(noise)) continue;
    const next =
      after.find((candidate) => types.includes(candidate.type) && candidate.target === interaction.target) ??
      after.find((candidate) => types.includes(candidate.type));
    return next
      ? {
          status: 'MERGED',
          rule,
          mergedInto: next.id,
          reason: `${noise}: represented by ${next.id} ${next.type} "${next.target ?? ''}"`,
        }
      : { status: 'HUMAN_NOISE', rule, reason: `${noise}, nothing followed` };
  }
  if (noise === NON_INTERACTIVE_NOISE)
    return {
      status: 'HUMAN_NOISE',
      rule: 'NON_INTERACTIVE_NO_EFFECT',
      reason:
        'click on plain content: no interactive control, no effect on the screen, nothing depended on it',
    };
  if (noise) return { status: 'HUMAN_NOISE', rule: 'CAPTURE_NOISE', reason: noise };
  return { status: 'UNACCOUNTED', reason: 'no semantic action was produced for it' };
}

/**
 * WORKFLOW PHASES : le parcours lu par étapes métier. Une phase commence à une action qui
 * ouvre quelque chose (des actions suivantes en dépendent, l'écran change) ou après un envoi.
 * Ne retire jamais rien : c'est une lecture du parcours, pour le rapport.
 */
export function workflowPhases(
  accounts: readonly InteractionAccount[],
  kept: readonly SemanticRecordedAction[],
  dependencies: readonly ActionDependency[],
): WorkflowPhase[] {
  const opens = new Set(dependencies.map((dependency) => dependency.from));
  const byId = new Map(kept.map((action) => [action.id, action]));
  const phases: WorkflowPhase[] = [];
  let current: WorkflowPhase | undefined;
  let afterSubmit = false;
  for (const account of accounts) {
    if (account.flowStep === undefined || !account.actionId) continue;
    const action = byId.get(account.actionId);
    const opener =
      action !== undefined &&
      (opens.has(action.id) || (action.type === 'CLICK' && (action.domEffects ?? []).length > 0));
    if (!current || opener || afterSubmit) {
      current = {
        index: phases.length + 1,
        label: action?.target?.label ?? account.target ?? `phase ${String(phases.length + 1)}`,
        interactionIds: [],
      };
      phases.push(current);
    }
    current.interactionIds.push(account.interactionId);
    afterSubmit = action?.type === 'SUBMIT' || action?.classification === 'MUTATION';
  }
  return phases;
}
