import type { FlowTarget, TargetFingerprint } from '../config/flow-schema.js';
import { describeTarget } from '../config/flow-schema.js';
import { normalize } from '../flows/action-effect-verifier.js';
import type { PreActionContext } from './model.js';
import type { ElementTraits } from './semantic-dom.js';

/**
 * RECORDING INTELLIGENCE CONTEXT — CONTEXT BEFORE DECISION.
 *
 * Le conseiller ne reçoit jamais « voici des éléments, choisis » : il reçoit OÙ est l'humain
 * (écran, fenêtre, section, composant), CE QU'IL FAIT (action, actions d'avant et d'après,
 * configuration en cours), CE QUE DIT LE RUNTIME (cible réelle, candidats avec leur identité
 * fonctionnelle et leur similarité, contradictions, effets), et les indices statiques ou
 * historiques — marqués comme tels. Une fenêtre de contexte PERTINENTE, jamais le DOM entier.
 */

/** Une action humaine résumée pour le contexte (jamais une valeur saisie : seulement son type). */
export interface ContextAction {
  id: string;
  type: string;
  target: string;
  /** Un choix d'interface (option, case) — jamais une saisie libre. */
  value?: string;
  /** Le type sémantique d'une saisie (email, number, text…), jamais sa valeur. */
  valueType?: string;
  section?: string;
  dialog?: string;
  at: number;
}

/** Un indice d'analyse statique : une piste, jamais une vérité runtime. */
export interface StaticHint {
  id: string;
  type: string;
  component?: string;
  formControl?: string;
  possibleConcept?: string;
  confidence: number;
}

/** Une expérience passée (mapping, rejeu, réparation) : de l'expérience, pas la vérité courante. */
export interface HistoricalHint {
  id: string;
  type: string;
  statement: string;
  confidence: number;
}

/** Ce qui peut fournir des indices statiques et historiques (aucun par défaut pendant l'enregistrement). */
export interface EvidenceSources {
  staticEvidence?: (target: { label?: string; formControl?: string; section?: string }) => StaticHint[];
  historicalEvidence?: (target: { label?: string; section?: string }) => HistoricalHint[];
}

export interface ContextCandidate {
  key: string;
  target: FlowTarget;
  identity?: { role?: string; tag?: string; name?: string; section?: string; traits?: ElementTraits };
  /** Ce que la représentation trouve à l'écran (1 élément, 3 éléments, rien). */
  found: string;
}

export interface RecordingContextInput {
  flowName: string;
  event: { id: string; type: string; at: number; valueType?: string };
  original: {
    role?: string;
    tag?: string;
    name?: string;
    label?: string;
    section?: string;
    traits?: ElementTraits;
  };
  fingerprint?: TargetFingerprint;
  recordedTarget: FlowTarget;
  validation: {
    status: string;
    reason: string;
    confidence: number;
    candidateCount: number;
    differences: { property: string; expected?: string; actual?: string }[];
  };
  candidates: ContextCandidate[];
  pre?: PreActionContext;
  effects: string[];
  history: ContextAction[];
  next: ContextAction[];
  sources?: EvidenceSources;
}

/** Le contexte envoyé au conseiller (dans `recordingContext`, assaini par le même sanitizer). */
export interface RecordingAuditContext {
  mission: { type: 'RECORDING_TARGET_AUDIT'; objective: string; constraints: string[] };
  workflow: {
    flowName: string;
    currentPhase?: string;
    currentGoal?: { statement: string; authority: 'HYPOTHESIS' };
  };
  screen: {
    route?: string;
    pageTitle?: string;
    dialog?: string;
    section?: string;
    component?: string;
    activeTab?: string;
    visibleRelevantHeadings: string[];
  };
  action: {
    humanActionId: string;
    type: string;
    semanticIntent?: { statement: string; authority: 'HYPOTHESIS' };
    targetDescription: string;
    valueType?: string;
    generatedFingerprint?: TargetFingerprint;
    recordedTarget: string;
    validationStatus: string;
  };
  originalTarget: {
    tag?: string;
    role?: string;
    accessibleName?: string;
    label?: string;
    section?: string;
    component?: string;
    dialog?: string;
    nearbyText?: string;
    stableAttributes: Record<string, string>;
  };
  previousActions: ContextAction[];
  nextActions: { actions: ContextAction[]; authority: 'EVIDENCE_NOT_TRUTH' };
  businessContext?: { configuration: Record<string, string>; observedPattern: string };
  formState: Record<string, { value?: string; state: 'SELECTED' | 'USER_EDITABLE' }>;
  dependencies: { source: string; target: string; relation: string }[];
  effects: { observed: string[]; navigationChanged: boolean };
  runtimeEvidence: {
    targetVisible?: boolean;
    actualRole?: string;
    actualTag?: string;
    accessibleName?: string;
    candidateCount: number;
    loadingBefore: boolean;
  };
  candidates: {
    id: string;
    tag?: string;
    role?: string;
    label?: string;
    section?: string;
    dialog?: string;
    nearbyText?: string;
    visible?: boolean;
    focused?: boolean;
    locatorEvidence: { locator: string; found: string; stableAttributes: Record<string, string> };
    runtimeMatch: { originalTargetSimilarity: number };
  }[];
  contradictions: {
    id: string;
    property: string;
    recorded?: string;
    runtime?: string;
    severity: 'HIGH' | 'MEDIUM';
  }[];
  confidence: { validation: number; candidates: Record<string, number>; authority: 'EVIDENCE_NOT_TRUTH' };
  staticEvidence: (StaticHint & { authority: 'SUPPORTING_EVIDENCE' })[];
  historicalEvidence: (HistoricalHint & { authority: 'EXPERIENCE' })[];
  temporalContext: { actionSequence: string[]; timeSincePreviousActionMs?: number; loadingBefore: boolean };
}

/**
 * CONTEXT RELEVANCE SELECTOR : la fenêtre utile — les 3 à 5 actions précédentes de la même
 * fenêtre / section (sinon les plus récentes), les actions suivantes connues, les candidats
 * les plus proches de l'original. Jamais tout l'historique, jamais le DOM.
 */
export class ContextRelevanceSelector {
  constructor(private readonly limits = { previous: 5, next: 2, candidates: 8 }) {}

  previous(
    history: readonly ContextAction[],
    original: RecordingContextInput['original'],
    dialog?: string,
  ): ContextAction[] {
    const recent = history.slice(-12);
    const sameArea = recent.filter(
      (action) =>
        (dialog !== undefined && action.dialog === dialog) ||
        (original.section !== undefined && action.section === original.section),
    );
    const chosen = sameArea.length >= 2 ? sameArea : recent;
    return chosen.slice(-this.limits.previous);
  }

  next(next: readonly ContextAction[]): ContextAction[] {
    return next.slice(0, this.limits.next);
  }

  candidates<T extends { similarity: number }>(candidates: readonly T[]): T[] {
    return [...candidates].sort((a, b) => b.similarity - a.similarity).slice(0, this.limits.candidates);
  }
}

/** Similarité fonctionnelle d'un candidat avec l'élément réellement utilisé (0..1) — un indice. */
export function targetSimilarity(
  original: RecordingContextInput['original'],
  candidate: ContextCandidate['identity'],
): number {
  if (!candidate) return 0;
  let score = 0;
  if (original.role && candidate.role === original.role) score += 0.15;
  if (original.tag && candidate.tag === original.tag) score += 0.1;
  const wanted = normalize(original.label ?? original.name);
  const found = normalize(candidate.name);
  if (wanted && found && (wanted === found || found.includes(wanted) || wanted.includes(found)))
    score += 0.25;
  if (original.section && candidate.section && normalize(original.section) === normalize(candidate.section))
    score += 0.2;
  const a = original.traits;
  const b = candidate.traits;
  if (a && b) {
    if (a.dialog && a.dialog === b.dialog) score += 0.05;
    for (const key of ['formControl', 'name', 'id', 'placeholder'] as const)
      if (a[key] && a[key] === b[key]) score += 0.05;
    if (a.nearText && a.nearText === b.nearText) score += 0.1;
    if (b.focused) score += 0.1;
    if (!b.visible) score -= 0.2;
  }
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

const stableAttributes = (traits: ElementTraits | undefined): Record<string, string> => ({
  ...(traits?.formControl ? { formControl: traits.formControl } : {}),
  ...(traits?.name ? { name: traits.name } : {}),
  ...(traits?.id ? { id: traits.id } : {}),
  ...(traits?.placeholder ? { placeholder: traits.placeholder } : {}),
  ...(traits?.testId ? { testId: traits.testId } : {}),
});

/**
 * RECORDING INTELLIGENCE CONTEXT BUILDER : compact mais riche. `ids` donne l'identifiant public
 * (A1…) de chaque candidate dans la requête — le seul que le conseiller peut citer.
 */
export class RecordingIntelligenceContextBuilder {
  private readonly selector = new ContextRelevanceSelector();

  build(input: RecordingContextInput, ids: ReadonlyMap<string, string>): RecordingAuditContext {
    const { original, pre } = input;
    const dialog = original.traits?.dialog ?? pre?.dialog;
    const previous = this.selector.previous(input.history, original, dialog);
    const next = this.selector.next(input.next);
    // La configuration en cours : des choix faits juste avant dans la même fenêtre / section.
    const choices = previous.filter(
      (action) => action.value !== undefined && (action.type === 'change' || action.type === 'SELECT'),
    );
    const configuration: Record<string, string> = {};
    for (const action of choices.slice(-3)) configuration[action.target] = action.value ?? '';
    const human =
      original.label ?? original.name ?? original.traits?.nearText ?? original.traits?.placeholder;
    const scored = input.candidates.map((candidate) => ({
      candidate,
      similarity: targetSimilarity(original, candidate.identity),
    }));
    const candidates = this.selector.candidates(scored);
    const contradictions = input.validation.differences
      .filter((difference) => difference.property !== 'element')
      .map((difference, index) => ({
        id: `C${String(index + 1)}`,
        property: difference.property,
        ...(difference.expected ? { recorded: difference.expected } : {}),
        ...(difference.actual ? { runtime: difference.actual } : {}),
        severity: difference.property === 'name' ? ('MEDIUM' as const) : ('HIGH' as const),
      }));
    const formState: RecordingAuditContext['formState'] = {};
    for (const entry of pre?.selected ?? [])
      formState[entry.label] = { value: entry.value, state: 'SELECTED' };
    if (human) formState[human] = { state: 'USER_EDITABLE' };
    const previousAction = input.history.at(-1);
    const hint = {
      ...(human ? { label: human } : {}),
      ...(original.section ? { section: original.section } : {}),
    };
    return {
      mission: {
        type: 'RECORDING_TARGET_AUDIT',
        objective:
          'Determine which provided runtime candidate corresponds to the element actually manipulated by the human, and whether the recorded representation correctly represents it.',
        constraints: [
          'do not invent targets, labels or workflow steps',
          'only reference provided candidate IDs and evidence IDs',
          'runtime evidence has priority over static and historical evidence',
          'do not execute actions',
          'do not bypass the SafetyPolicy',
          'return INCONCLUSIVE when the evidence does not decide',
        ],
      },
      workflow: {
        flowName: input.flowName,
        ...(Object.keys(configuration).length > 0 ? { currentPhase: 'CONFIGURATION' } : {}),
        ...(Object.keys(configuration).length > 0 && human
          ? {
              currentGoal: {
                statement: `provide "${human}" after choosing ${Object.entries(configuration)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ')}`,
                authority: 'HYPOTHESIS' as const,
              },
            }
          : {}),
      },
      screen: {
        ...(pre?.route ? { route: pre.route } : {}),
        ...(pre?.title ? { pageTitle: pre.title } : {}),
        ...(dialog ? { dialog } : {}),
        ...(original.section ? { section: original.section } : {}),
        ...(original.traits?.component ? { component: original.traits.component } : {}),
        ...(pre?.activeTab ? { activeTab: pre.activeTab } : {}),
        visibleRelevantHeadings: pre?.headings ?? [],
      },
      action: {
        humanActionId: input.event.id,
        type: input.event.type.toUpperCase(),
        ...(choices.length >= 2 && input.event.type !== 'click'
          ? {
              semanticIntent: {
                statement: `value of the configuration ${Object.keys(configuration).join(' / ')}`,
                authority: 'HYPOTHESIS' as const,
              },
            }
          : {}),
        targetDescription: `${original.role ?? original.tag ?? 'element'} "${human ?? ''}"${original.section ? ` in "${original.section}"` : ''}${dialog ? ` (dialog "${dialog}")` : ''}`,
        ...(input.event.valueType ? { valueType: input.event.valueType } : {}),
        ...(input.fingerprint ? { generatedFingerprint: input.fingerprint } : {}),
        recordedTarget: describeTarget(input.recordedTarget),
        validationStatus: `${input.validation.status}: ${input.validation.reason}`.slice(0, 200),
      },
      originalTarget: {
        ...(original.tag ? { tag: original.tag } : {}),
        ...(original.role ? { role: original.role } : {}),
        ...(original.name ? { accessibleName: original.name } : {}),
        ...(original.label ? { label: original.label } : {}),
        ...(original.section ? { section: original.section } : {}),
        ...(original.traits?.component ? { component: original.traits.component } : {}),
        ...(dialog ? { dialog } : {}),
        ...(original.traits?.nearText ? { nearbyText: original.traits.nearText } : {}),
        stableAttributes: stableAttributes(original.traits),
      },
      previousActions: previous,
      nextActions: { actions: next, authority: 'EVIDENCE_NOT_TRUTH' },
      ...(choices.length > 0
        ? {
            businessContext: {
              configuration,
              observedPattern: [
                ...choices.map((action) => `${action.type.toUpperCase()} ${action.target}`),
                `${input.event.type.toUpperCase()} ${human ?? '?'}`,
                ...next.map((action) => `${action.type.toUpperCase()} ${action.target}`),
              ].join(' → '),
            },
          }
        : {}),
      formState,
      dependencies: human
        ? choices.slice(-3).map((action) => ({
            source: action.target,
            target: human,
            relation: 'CONFIGURES (observed sequence)',
          }))
        : [],
      effects: {
        observed: input.effects,
        navigationChanged: input.effects.some((effect) => effect.startsWith('route ')),
      },
      runtimeEvidence: {
        ...(original.traits ? { targetVisible: original.traits.visible } : {}),
        ...(original.role ? { actualRole: original.role } : {}),
        ...(original.tag ? { actualTag: original.tag } : {}),
        ...(original.name ? { accessibleName: original.name } : {}),
        candidateCount: input.validation.candidateCount,
        loadingBefore: pre?.loading ?? false,
      },
      candidates: candidates.map(({ candidate, similarity }) => ({
        id: ids.get(candidate.key) ?? candidate.key,
        ...(candidate.identity?.tag ? { tag: candidate.identity.tag } : {}),
        ...(candidate.identity?.role ? { role: candidate.identity.role } : {}),
        ...(candidate.identity?.name ? { label: candidate.identity.name } : {}),
        ...(candidate.identity?.section ? { section: candidate.identity.section } : {}),
        ...(candidate.identity?.traits?.dialog ? { dialog: candidate.identity.traits.dialog } : {}),
        ...(candidate.identity?.traits?.nearText ? { nearbyText: candidate.identity.traits.nearText } : {}),
        ...(candidate.identity?.traits
          ? { visible: candidate.identity.traits.visible, focused: candidate.identity.traits.focused }
          : {}),
        locatorEvidence: {
          locator: describeTarget(candidate.target).slice(0, 80),
          found: candidate.found,
          stableAttributes: stableAttributes(candidate.identity?.traits),
        },
        runtimeMatch: { originalTargetSimilarity: similarity },
      })),
      contradictions,
      confidence: {
        validation: input.validation.confidence,
        candidates: Object.fromEntries(
          candidates.map(({ candidate, similarity }) => [
            ids.get(candidate.key) ?? candidate.key,
            similarity,
          ]),
        ),
        authority: 'EVIDENCE_NOT_TRUTH',
      },
      staticEvidence: (
        input.sources?.staticEvidence?.({
          ...hint,
          ...(original.traits?.formControl ? { formControl: original.traits.formControl } : {}),
        }) ?? []
      )
        .slice(0, 3)
        .map((entry) => ({ ...entry, authority: 'SUPPORTING_EVIDENCE' as const })),
      historicalEvidence: (input.sources?.historicalEvidence?.(hint) ?? [])
        .slice(0, 3)
        .map((entry) => ({ ...entry, authority: 'EXPERIENCE' as const })),
      temporalContext: {
        actionSequence: [
          ...previous.map((action) => `${action.type} ${action.target}`),
          `${input.event.type} ${human ?? '?'} (current)`,
        ],
        ...(previousAction
          ? { timeSincePreviousActionMs: Math.max(0, input.event.at - previousAction.at) }
          : {}),
        loadingBefore: pre?.loading ?? false,
      },
    };
  }
}
