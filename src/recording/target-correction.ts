import type { FlowStep, FlowTarget } from '../config/flow-schema.js';
import { isSensitiveKey } from '../data/test-data-set.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedFlow,
  RecordedFlowStep,
  TargetCorrection,
} from './model.js';
import { resolveRecordedTarget, type TargetUse } from './recorded-target.js';
import type { LocatorQuality } from './model.js';

/**
 * CORRECTION MANAGER — corriger la cible d'une action DANS LE NAVIGATEUR.
 *
 * L'humain désigne dans la page (mode sélection du bandeau) l'élément que l'action doit viser ; la
 * nouvelle référence se construit avec le MÊME résolveur que l'enregistrement (`resolveRecordedTarget`
 * : test id, rôle + nom accessible, libellé, texte, attribut stable, CSS) — jamais un second moteur,
 * jamais une devinette. Deux destinations, une seule interface :
 *
 *   PENDANT L'ENREGISTREMENT   la correction est posée sur les événements bruts de l'action
 *                              (`userCorrection`) ; le flow généré à l'arrêt la porte ;
 *   APRÈS L'ARRÊT (revue)      la correction réécrit l'étape du flow généré, avec son historique
 *                              (`corrections`), et les fichiers sont régénérés.
 *
 * L'original n'est jamais perdu : la première entrée de l'historique le garde (« Restaurer l'original »).
 */

/** Ce que la page renvoie quand l'humain a cliqué un élément en mode sélection. */
export interface PickedElement {
  element: RecordedElement;
  /** La référence de l'élément dans la page (mise en évidence), jamais écrite. */
  ref?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
  };
  url?: string;
  /**
   * Les cellules de la ligne de tableau qui porte l'élément (colonne → texte, sans la cellule de
   * l'élément) : la matière pour LIER LA LIGNE À UNE DONNÉE DU RUN plutôt qu'à une clé figée.
   */
  rowCells?: { column: string; value: string }[];
}

/** Une valeur connue du run : saisie par l'humain (clé du jeu de données en revue) ou produite au rejeu. */
export interface KnownValue {
  value: string;
  /** La clé du jeu de données (`${testData:clé}` au rejeu) ; absente pendant l'enregistrement (citée à l'arrêt). */
  key?: string;
}

/** Ce que la proposition sait du run : ses valeurs connues et l'ancienne cible de l'étape. */
export interface CorrectionContext {
  known?: readonly KnownValue[];
  previous?: FlowTarget;
  /**
   * REVUE : une colonne peut créer une nouvelle donnée du jeu de test ; `taken` : les clés déjà prises
   * (aucune donnée existante n'est écrasée). Absent pendant l'enregistrement (le jeu n'existe pas encore).
   */
  newVariables?: { taken: readonly string[] };
}

/**
 * COMMENT IDENTIFIER LA LIGNE : `bound`, par une colonne dont la valeur est une donnée du run (la
 * ligne créée pendant le run se retrouve au prochain rejeu) ; `key`, par la clé lue dans le tableau
 * (`fixed` quand elle est propre à ce run : l'ancienne cible avait la même colonne, une autre valeur).
 */
export interface RowOption {
  id: 'bound' | 'key' | 'manual';
  row: Record<string, string>;
  /** bound : la donnée citée (sa clé, ou sa valeur littérale pendant l'enregistrement). */
  via?: string;
  /** bound : la cellule est égale à la donnée, ou la contient (« Northwind inc. » contient « Northwind »). */
  match?: 'exact' | 'contains';
  fixed?: boolean;
}

/** LIAISON MANUELLE : l'humain lie une colonne de la ligne à une donnée du run (la cellule la contient au rejeu). */
export interface RowBinding {
  column: string;
  key: string;
}

/**
 * UNE COLONNE DE LA LIGNE choisie par l'humain, et la source de sa valeur au rejeu :
 *
 *   recorded       la valeur lue dans la ligne (fixe) ;
 *   value          une valeur saisie dans la fenêtre (fixe) ;
 *   variable       une donnée du run (`${testData:clé}`) ;
 *   new-variable   une NOUVELLE donnée du jeu de test, créée à partir de la valeur (revue seulement) :
 *                  test-data.yaml la porte, on la modifie là sans toucher au flow.
 *
 * Plusieurs colonnes se combinent (toutes doivent correspondre) ; `contains` : la cellule contient la valeur.
 */
export interface RowColumnChoice {
  column: string;
  source: 'recorded' | 'value' | 'variable' | 'new-variable';
  /** value : la valeur saisie ; new-variable : sa valeur initiale (la cellule par défaut). */
  value?: string;
  /** variable : la donnée citée ; new-variable : le nom de la nouvelle donnée. */
  key?: string;
  match?: 'exact' | 'contains';
}

/** Une donnée créée par une liaison de colonne : à ajouter au jeu de test (revue). */
export interface CreatedRowVariable {
  key: string;
  value: string;
  column: string;
}

/** La proposition de correction : la nouvelle cible, ses replis et l'ordre de résolution au rejeu. */
export interface CorrectionProposal {
  target: FlowTarget;
  /** La cible est dans une ligne de tableau : les façons d'identifier la ligne (la première est celle de `target`). */
  rowOptions?: RowOption[];
  /** Les cellules de la ligne et les données du run (avec une clé) : la liaison manuelle d'une colonne à une donnée. */
  rowCells?: { column: string; value: string }[];
  variables?: { key: string; value: string }[];
  quality: LocatorQuality;
  label: string;
  alternatives: FlowTarget[];
  /** L'ordre dans lequel le rejeu essaiera les stratégies (lisible : « testId », « rôle + nom »…). */
  order: string[];
  ambiguous: boolean;
  /** Les traits de l'élément montrés à l'humain (jamais une valeur saisie). */
  traits: {
    role: string;
    name?: string;
    label?: string;
    text?: string;
    testId?: string;
    css: string;
    section?: string;
    tag: string;
  };
}

/** L'usage d'une cible selon le genre de l'étape (clic, champ, case). */
export function useOfStep(kind: string): TargetUse {
  if (kind === 'fill' || kind === 'select' || kind === 'FILL' || kind === 'SELECT' || kind === 'TYPE')
    return 'field';
  if (kind === 'check' || kind === 'uncheck' || kind === 'choose' || kind === 'CHECK' || kind === 'UNCHECK')
    return 'check';
  return 'click';
}

const STRATEGY_WORDS: Record<string, { fr: string; en: string }> = {
  testId: { fr: 'testId', en: 'testId' },
  role: { fr: 'rôle + nom accessible', en: 'role + accessible name' },
  label: { fr: 'libellé', en: 'label' },
  text: { fr: 'texte visible', en: 'visible text' },
  css: { fr: 'CSS', en: 'CSS' },
};

/** Une cible dite en un mot lisible : `button "Rechercher"`, `testId "search"`, `label "Numéro" (section Colonnes)`. */
export function describeTarget(target: FlowTarget): string {
  const base =
    target.strategy === 'role'
      ? `${target.role ?? 'element'} "${target.name ?? ''}"`
      : `${target.strategy} "${target.value ?? ''}"`;
  const extras = [
    ...(target.section ? [`section ${target.section}`] : []),
    ...(target.row ? [`row ${Object.values(target.row).join(' ')}`] : []),
    ...(target.nth !== undefined ? [`#${String(target.nth + 1)}`] : []),
  ];
  return extras.length ? `${base} (${extras.join(', ')})` : base;
}

/** La proposition pour un élément désigné : la cible résolue, ses replis, l'ordre d'essai au rejeu. */
export function proposeCorrection(
  element: RecordedElement,
  use: TargetUse,
  language: 'fr' | 'en' = 'fr',
  context: CorrectionContext = {},
  rowCells: readonly { column: string; value: string }[] = [],
): CorrectionProposal {
  const resolved = resolveRecordedTarget(element, use);
  const rowOptions = rowOptionsOf(resolved.target, rowCells, context);
  const target = rowOptions[0] ? withRow(resolved.target, rowOptions[0].row) : resolved.target;
  const strategies: string[] = [];
  for (const candidate of [resolved.target, ...resolved.alternatives.map((entry) => entry.target)]) {
    const word = STRATEGY_WORDS[candidate.strategy]?.[language] ?? candidate.strategy;
    const said = candidate.section ? `${word} + ${language === 'fr' ? 'section' : 'section'}` : word;
    if (!strategies.includes(said)) strategies.push(said);
  }
  const section =
    element.sectionPath && element.sectionPath.length > 0 ? element.sectionPath.join(' > ') : undefined;
  const variables = (context.known ?? [])
    .filter(
      (entry): entry is { key: string; value: string } =>
        entry.key !== undefined && entry.value.trim() !== '',
    )
    .filter((entry, index, all) => all.findIndex((other) => other.key === entry.key) === index);
  return {
    target,
    ...(rowOptions.length > 0 ? { rowOptions } : {}),
    ...(rowCells.length > 0 ? { rowCells: [...rowCells] } : {}),
    ...(rowCells.length > 0 && variables.length > 0 ? { variables } : {}),
    quality: resolved.quality,
    label: resolved.label,
    alternatives: resolved.alternatives.map((entry) => entry.target),
    order: strategies,
    ambiguous: resolved.ambiguous,
    traits: {
      role: element.role,
      ...(element.name ? { name: element.name } : {}),
      ...(element.label ? { label: element.label } : {}),
      ...(element.text ? { text: element.text } : {}),
      ...(element.testId ? { testId: element.testId } : {}),
      css: element.css,
      ...(section ? { section } : {}),
      tag: element.tag,
    },
  };
}

/** Le texte comparable : sans accents, espaces réduits, minuscules (comme le rejeu compare les cellules). */
const comparable = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * LES FAÇONS D'IDENTIFIER LA LIGNE. Une clé renvoyée par le serveur (« 3024 ») n'identifie la ligne que
 * dans le run qui l'a créée : au prochain rejeu la ligne créée porte une autre clé, et la correction
 * échouerait de nouveau — la même erreur qu'on voulait corriger. Quand une cellule de la ligne porte
 * une VALEUR CONNUE DU RUN (saisie, donnée générée), la ligne se lie à cette donnée : c'est l'option
 * proposée en premier. La clé du tableau reste offerte, marquée « propre à ce run » quand l'ancienne
 * cible visait la même colonne avec une autre valeur.
 */
function rowOptionsOf(
  resolved: FlowTarget,
  rowCells: readonly { column: string; value: string }[],
  context: CorrectionContext,
): RowOption[] {
  const options: RowOption[] = [];
  const known = (context.known ?? []).filter((entry) => comparable(entry.value).length >= 2);
  // Une cellule ÉGALE à une donnée du run d'abord ; sinon une cellule qui la CONTIENT (le nom suivi d'un
  // suffixe, d'un statut) — seulement pour une donnée qui a une clé (elle se cite au rejeu : `~${testData:clé}`).
  const exact = rowCells
    .map((cell) => {
      const match = known.find((entry) => comparable(entry.value) === comparable(cell.value));
      return match ? { cell, match, how: 'exact' as const } : undefined;
    })
    .find((entry) => entry !== undefined);
  const contained = exact
    ? undefined
    : rowCells
        .map((cell) => {
          const match = known.find(
            (entry) =>
              entry.key !== undefined &&
              comparable(entry.value).length >= 4 &&
              comparable(cell.value).includes(comparable(entry.value)),
          );
          return match ? { cell, match, how: 'contains' as const } : undefined;
        })
        .find((entry) => entry !== undefined);
  const bound = exact ?? contained;
  if (bound) {
    const reference = bound.match.key ? `\${testData:${bound.match.key}}` : bound.cell.value;
    options.push({
      id: 'bound',
      row: { [bound.cell.column]: bound.how === 'contains' ? `~${reference}` : reference },
      via: bound.match.key ?? bound.cell.value,
      match: bound.how,
    });
  }
  if (resolved.row) {
    const previous = context.previous?.row;
    const fixed =
      previous !== undefined &&
      Object.entries(resolved.row).some(
        ([column, value]) => previous[column] !== undefined && previous[column] !== value,
      );
    options.push({ id: 'key', row: resolved.row, ...(fixed ? { fixed } : {}) });
  }
  return options;
}

function withRow(target: FlowTarget, row: Record<string, string>): FlowTarget {
  const { nth: _position, ...rest } = target;
  return { ...rest, row };
}

/**
 * La cible de la proposition pour l'option de ligne choisie (la première par défaut). `manual` : la colonne
 * et la donnée choisies par l'humain, seulement parmi les cellules de la ligne et les données du run proposées.
 * `columns` : les colonnes choisies une à une (`rowOfColumns`) ; un choix invalide garde la cible proposée.
 */
export function proposalTarget(
  proposal: CorrectionProposal,
  option?: string,
  binding?: RowBinding,
  columns?: readonly RowColumnChoice[],
): FlowTarget {
  const chosen = chosenTarget(proposal, option, binding, columns, {});
  return 'target' in chosen ? chosen.target : proposal.target;
}

const COLUMN_VALUE = 60;
const KEY = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

/**
 * LA LIGNE PAR SES COLONNES : chaque colonne choisie doit exister dans la ligne ; une donnée citée doit
 * être une donnée du run proposée ; une nouvelle donnée a un nom valide, libre, jamais sensible. Une valeur
 * saisie ne peut pas citer une autre source (`${…}`) : elle reste un texte.
 */
export function rowOfColumns(
  cells: readonly { column: string; value: string }[],
  variables: readonly { key: string; value: string }[],
  choices: readonly RowColumnChoice[],
  newVariables?: { taken: readonly string[] },
): { row: Record<string, string>; created: CreatedRowVariable[] } | { error: string } {
  if (choices.length === 0) return { error: 'choose at least one column of the row' };
  if (choices.length > 6) return { error: 'at most 6 columns identify a row' };
  const row: Record<string, string> = {};
  const created: CreatedRowVariable[] = [];
  for (const choice of choices) {
    const cell = cells.find((entry) => entry.column === choice.column);
    if (!cell) return { error: `column "${choice.column}" is not in the row` };
    if (row[cell.column] !== undefined) return { error: `column "${cell.column}" is chosen twice` };
    let value: string;
    if (choice.source === 'recorded') value = cell.value;
    else if (choice.source === 'value') {
      const typed = (choice.value ?? '').trim().replace(/^~/, '').trim();
      if (!typed) return { error: `column "${cell.column}": the value is empty` };
      if (typed.length > COLUMN_VALUE) return { error: `column "${cell.column}": the value is too long` };
      if (typed.includes('${'))
        return { error: `column "${cell.column}": a typed value cannot cite a variable` };
      value = typed;
    } else if (choice.source === 'variable') {
      const variable = variables.find((entry) => entry.key === choice.key);
      if (!variable)
        return { error: `column "${cell.column}": "${choice.key ?? ''}" is not a variable of the run` };
      value = `\${testData:${variable.key}}`;
    } else {
      if (!newVariables) return { error: 'a new variable is created during the review only' };
      const key = (choice.key ?? '').trim();
      if (!KEY.test(key)) return { error: `"${key}" is not a valid variable name (object.attribute)` };
      if (isSensitiveKey(key))
        return { error: `"${key}" names a sensitive value: never written to the test data` };
      if (
        newVariables.taken.includes(key) ||
        variables.some((entry) => entry.key === key) ||
        created.some((entry) => entry.key === key)
      )
        return { error: `the variable "${key}" already exists` };
      const initial = (choice.value ?? cell.value).trim();
      if (!initial) return { error: `variable "${key}": the value is empty` };
      if (initial.length > COLUMN_VALUE) return { error: `variable "${key}": the value is too long` };
      created.push({ key, value: initial, column: cell.column });
      value = `\${testData:${key}}`;
    }
    row[cell.column] = choice.match === 'contains' ? `~${value}` : value;
  }
  return { row, created };
}

/** La cible choisie (option, liaison manuelle ou colonnes) et les données qu'elle crée. */
function chosenTarget(
  proposal: CorrectionProposal,
  option: string | undefined,
  binding: RowBinding | undefined,
  columns: readonly RowColumnChoice[] | undefined,
  context: CorrectionContext,
): { target: FlowTarget; created: CreatedRowVariable[] } | { error: string } {
  if (option === 'columns') {
    if (!proposal.rowCells || !columns) return { error: 'the element is not in a table row' };
    const outcome = rowOfColumns(proposal.rowCells, proposal.variables ?? [], columns, context.newVariables);
    if ('error' in outcome) return outcome;
    return { target: withRow(proposal.target, outcome.row), created: outcome.created };
  }
  if (option === 'manual' && binding) {
    const column = proposal.rowCells?.find((cell) => cell.column === binding.column);
    const variable = proposal.variables?.find((entry) => entry.key === binding.key);
    if (column && variable)
      return {
        target: withRow(proposal.target, { [column.column]: `~\${testData:${variable.key}}` }),
        created: [],
      };
  }
  const chosen = option ? proposal.rowOptions?.find((entry) => entry.id === option) : undefined;
  return { target: chosen ? withRow(proposal.target, chosen.row) : proposal.target, created: [] };
}

/** L'étape porte-t-elle une cible corrigeable (clic, saisie, sélection, case) ? */
export function hasTarget(step: FlowStep): step is FlowStep & { target: FlowTarget } {
  return 'target' in step;
}

/**
 * REVUE : la cible d'une étape du flow généré est remplacée par celle que l'humain a désignée. L'étape
 * garde son genre, sa valeur et ses effets ; seule la cible change. L'historique garde l'original.
 */
export function correctFlowTarget(
  flow: RecordedFlow,
  stepId: string,
  picked: PickedElement,
  at: number,
  language: 'fr' | 'en' = 'fr',
  context: CorrectionContext = {},
  option?: string,
  binding?: RowBinding,
  columns?: readonly RowColumnChoice[],
):
  | {
      step: RecordedFlowStep;
      correction: TargetCorrection;
      proposal: CorrectionProposal;
      created: CreatedRowVariable[];
    }
  | { error: string } {
  const item = flow.steps.find((entry) => entry.id === stepId);
  if (!item) return { error: `step ${stepId} not found` };
  if (!hasTarget(item.step)) return { error: `step ${stepId} (${item.step.kind}) has no target to correct` };
  const proposal = proposeCorrection(
    picked.element,
    useOfStep(item.step.kind),
    language,
    { ...context, previous: item.step.target },
    picked.rowCells ?? [],
  );
  const chosen = chosenTarget(proposal, option, binding, columns, context);
  if ('error' in chosen) return chosen;
  const next = chosen.target;
  const correction: TargetCorrection = {
    at,
    previous: item.step.target,
    next,
    label: proposal.label,
    by: 'USER',
  };
  item.step = { ...item.step, target: next } as FlowStep;
  item.quality = proposal.quality;
  item.userDecision = 'TARGET_CORRECTED_BY_USER';
  item.targetValidation = { status: 'USER_CORRECTED', repaired: false, requiresReplayValidation: false };
  item.corrections = [...(item.corrections ?? []), correction];
  item.explanation = `${item.explanation} — target corrected by the user in the browser: ${describeTarget(correction.previous)} → ${describeTarget(correction.next)}`;
  return { step: item, correction, proposal, created: chosen.created };
}

/**
 * Les cellules de la ligne ENREGISTRÉES avec l'action (colonne → texte, sans la cellule de l'élément) :
 * la ligne se modifie en revue sans rouvrir le navigateur.
 */
export function recordedRowCells(
  events: readonly RawRecordedEvent[],
  rawEventIds: readonly string[],
): { column: string; value: string }[] {
  const event = events.find(
    (entry) => rawEventIds.includes(entry.id) && (entry.element?.rowCells?.length ?? 0) > 0,
  );
  return event?.element?.rowCells ? [...event.element.rowCells] : [];
}

/**
 * REVUE, SANS NAVIGATEUR : la ligne visée par l'étape est redéfinie colonne par colonne à partir des
 * cellules enregistrées. Seule la ligne change (l'élément visé dans la ligne reste) ; l'historique garde
 * l'original (« Restaurer l'original »).
 */
export function editFlowRow(
  flow: RecordedFlow,
  stepId: string,
  cells: readonly { column: string; value: string }[],
  variables: readonly { key: string; value: string }[],
  columns: readonly RowColumnChoice[],
  at: number,
  newVariables?: { taken: readonly string[] },
):
  | { step: RecordedFlowStep; correction: TargetCorrection; created: CreatedRowVariable[] }
  | { error: string } {
  const item = flow.steps.find((entry) => entry.id === stepId);
  if (!item) return { error: `step ${stepId} not found` };
  if (!hasTarget(item.step)) return { error: `step ${stepId} (${item.step.kind}) has no target to correct` };
  if (!item.step.target.row) return { error: `step ${stepId} does not target a table row` };
  if (cells.length === 0) return { error: `step ${stepId}: the cells of the row were not recorded` };
  const outcome = rowOfColumns(cells, variables, columns, newVariables);
  if ('error' in outcome) return outcome;
  const next = withRow(item.step.target, outcome.row);
  const correction: TargetCorrection = { at, previous: item.step.target, next, by: 'USER' };
  item.step = { ...item.step, target: next } as FlowStep;
  item.userDecision = 'TARGET_CORRECTED_BY_USER';
  item.targetValidation = { status: 'USER_CORRECTED', repaired: false, requiresReplayValidation: false };
  item.corrections = [...(item.corrections ?? []), correction];
  item.explanation = `${item.explanation} — row edited by the user: ${describeTarget(correction.previous)} → ${describeTarget(correction.next)}`;
  return { step: item, correction, created: outcome.created };
}

/** REVUE : « Restaurer l'original » — la cible redevient celle de l'enregistrement ; l'historique reste. */
export function restoreFlowTarget(
  flow: RecordedFlow,
  stepId: string,
  at: number,
): { step: RecordedFlowStep; restored: FlowTarget } | { error: string } {
  const item = flow.steps.find((entry) => entry.id === stepId);
  if (!item) return { error: `step ${stepId} not found` };
  const first = item.corrections?.[0];
  if (!first || !hasTarget(item.step)) return { error: `step ${stepId} has no correction to restore` };
  const current = item.step.target;
  item.step = { ...item.step, target: first.previous } as FlowStep;
  item.corrections = [
    ...(item.corrections ?? []),
    { at, previous: current, next: first.previous, by: 'USER' },
  ];
  delete item.userDecision;
  delete item.targetValidation;
  item.explanation = `${item.explanation} — original target restored by the user`;
  return { step: item, restored: first.previous };
}

/**
 * ENREGISTREMENT : les événements bruts d'une action reçoivent l'élément désigné (le flow généré à
 * l'arrêt le visera) ; l'ancienne cible est gardée sur chaque événement (`userCorrection`).
 */
export function correctRawEvents(
  events: readonly RawRecordedEvent[],
  rawEventIds: readonly string[],
  picked: PickedElement,
  use: TargetUse,
  at: number,
  language: 'fr' | 'en' = 'fr',
  context: CorrectionContext = {},
  option?: string,
  binding?: RowBinding,
  columns?: readonly RowColumnChoice[],
): { correction: TargetCorrection; proposal: CorrectionProposal; touched: number } | { error: string } {
  const targets = events.filter((event) => rawEventIds.includes(event.id) && event.element !== undefined);
  if (targets.length === 0) return { error: 'the action has no element to correct' };
  const first = targets[0];
  if (!first?.element) return { error: 'the action has no element to correct' };
  const previous = first.userCorrection?.previous ?? resolveRecordedTarget(first.element, use).target;
  const proposal = proposeCorrection(
    picked.element,
    use,
    language,
    { ...context, previous },
    picked.rowCells ?? [],
  );
  // Pendant l'enregistrement le jeu de test n'existe pas encore : aucune nouvelle donnée.
  const { newVariables: _none, ...live } = context;
  const chosen = chosenTarget(proposal, option, binding, columns, live);
  if ('error' in chosen) return chosen;
  const next = chosen.target;
  const correction: TargetCorrection = {
    at,
    previous,
    next,
    label: proposal.label,
    by: 'USER',
  };
  // L'élément brut porte la clé de ligne choisie : le flow généré à l'arrêt la vise (une valeur saisie
  // y est citée comme donnée de test, jamais figée).
  const rowKey = next.row
    ? Object.entries(next.row).map(([column, value]) => ({ column, value }))
    : undefined;
  for (const event of targets) {
    event.element = {
      ...picked.element,
      ...(rowKey ? { rowKey } : {}),
      // La trace du geste reste (balise touchée, composant) : seulement la cible change.
      ...(event.element?.rawTag ? { rawTag: event.element.rawTag } : {}),
      ...(event.element?.componentTag ? { componentTag: event.element.componentTag } : {}),
    };
    event.userCorrection = correction;
    // La validation immédiate visait l'ancienne cible : elle ne vaut plus.
    delete event.targetValidation;
  }
  return { correction, proposal, touched: targets.length };
}

/** ENREGISTREMENT : l'original revient sur les événements bruts (l'historique de la décision reste dans le journal). */
export function restoreRawEvents(
  events: readonly RawRecordedEvent[],
  rawEventIds: readonly string[],
  original: RecordedElement,
): number {
  let touched = 0;
  for (const event of events) {
    if (!rawEventIds.includes(event.id) || !event.userCorrection) continue;
    event.element = original;
    delete event.userCorrection;
    touched += 1;
  }
  return touched;
}
