import type { FlowStep, FlowTarget } from '../config/flow-schema.js';
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
}

/**
 * COMMENT IDENTIFIER LA LIGNE : `bound`, par une colonne dont la valeur est une donnée du run (la
 * ligne créée pendant le run se retrouve au prochain rejeu) ; `key`, par la clé lue dans le tableau
 * (`fixed` quand elle est propre à ce run : l'ancienne cible avait la même colonne, une autre valeur).
 */
export interface RowOption {
  id: 'bound' | 'key';
  row: Record<string, string>;
  /** bound : la donnée citée (sa clé, ou sa valeur littérale pendant l'enregistrement). */
  via?: string;
  fixed?: boolean;
}

/** La proposition de correction : la nouvelle cible, ses replis et l'ordre de résolution au rejeu. */
export interface CorrectionProposal {
  target: FlowTarget;
  /** La cible est dans une ligne de tableau : les façons d'identifier la ligne (la première est celle de `target`). */
  rowOptions?: RowOption[];
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
  return {
    target,
    ...(rowOptions.length > 0 ? { rowOptions } : {}),
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

const same = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

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
  const known = context.known ?? [];
  const bound = rowCells
    .map((cell) => {
      const match = known.find((entry) => entry.value.trim() && same(entry.value, cell.value));
      return match ? { cell, match } : undefined;
    })
    .find((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (bound)
    options.push({
      id: 'bound',
      row: { [bound.cell.column]: bound.match.key ? `\${testData:${bound.match.key}}` : bound.cell.value },
      via: bound.match.key ?? bound.cell.value,
    });
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

/** La cible de la proposition pour l'option de ligne choisie (la première par défaut). */
export function proposalTarget(proposal: CorrectionProposal, option?: string): FlowTarget {
  const chosen = option ? proposal.rowOptions?.find((entry) => entry.id === option) : undefined;
  return chosen ? withRow(proposal.target, chosen.row) : proposal.target;
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
):
  { step: RecordedFlowStep; correction: TargetCorrection; proposal: CorrectionProposal } | { error: string } {
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
  const next = proposalTarget(proposal, option);
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
  return { step: item, correction, proposal };
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
  const next = proposalTarget(proposal, option);
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
