import type { AiDecisionRecord } from '../ai/audit-trail.js';
import { IntelligenceContextBuilder, type DiscoveredCandidate } from '../ai/context-builder.js';
import type { IntelligenceGateway } from '../ai/gateway.js';
import type { IntelligenceProposal } from '../ai/model.js';
import type { Evidence } from '../cognitive/evidence.js';
import type { ScenarioConfig } from '../config/config.js';
import { describeTarget } from '../config/flow-schema.js';
import { normalize } from '../flows/action-effect-verifier.js';
import type { RecordedElement, SemanticRecordedAction } from './model.js';
import type { TargetAuditAdvisor } from './target-validator.js';
import type { RecordingResult } from './process-recording.js';

/**
 * RECORDING SEMANTIC AUDITOR — le conseiller RELIT, il n'écrit pas.
 *
 *   capture humaine (déterministe, jamais l'IA) → interprétation déterministe
 *     → déclencheurs (cible ambiguë, localisateur fragile, interaction inconnue, glisser douteux…)
 *     → (IntelligenceGateway existant, contexte RECORDING, avis seulement)
 *     → RecordingAuditArbiter → CONFIRMED / SUSPICIOUS / DISAGREEMENT / INCONCLUSIVE
 *
 * L'interprétation FINALE reste la déterministe : une lecture différente proposée par l'IA est
 * gardée comme HYPOTHÈSE (origin AI_PROPOSAL, runtimeConfirmed=false) et signalée pour revue ;
 * seul le rejeu pourra la confirmer. Aucune valeur saisie, aucun secret n'est envoyé.
 */

export type RecordingAuditMode = 'OFF' | 'SUSPICIOUS_ONLY' | 'FULL';

export type RecordingAuditTrigger =
  | 'AMBIGUOUS_TARGET'
  | 'FRAGILE_LOCATOR'
  | 'LOW_SEMANTIC_CONFIDENCE'
  | 'UNKNOWN_INTERACTION'
  | 'POSSIBLE_DRAG_AND_DROP'
  | 'NORMALIZATION_LOSS'
  | 'CONTEXT_MISMATCH'
  | 'SUSPICIOUS_MERGE'
  | 'FULL_AUDIT';

export type AiAssessment = 'CONFIRMED' | 'SUSPICIOUS' | 'DISAGREEMENT' | 'INCONCLUSIVE' | 'NOT_AUDITED';

/** Ce que le déterministe a compris d'une action humaine. */
export interface SemanticInterpretation {
  interaction: string;
  /** Le libellé humain de la cible (« Search », « Status »). */
  target: string;
  section?: string;
  semanticId?: string;
  /** Le localisateur de rejeu (role=…, label=…, css=…). */
  locator?: string;
  quality?: string;
  /** Glisser-déposer : zones et effet observé. */
  drag?: { from?: string; to?: string; moved: boolean };
}

export interface SemanticAuditEntry {
  /** L'identifiant STABLE de l'action humaine (h001…), du brut au flow généré. */
  humanActionId: string;
  actionId?: string;
  flowStep?: number;
  deterministicInterpretation: SemanticInterpretation;
  deterministicConfidence: number;
  auditTrigger: RecordingAuditTrigger[];
  aiDecisionId?: string;
  aiAssessment: AiAssessment;
  /** La lecture de l'IA : toujours une HYPOTHÈSE, jamais appliquée. */
  aiProposal?: {
    target?: string;
    interaction?: string;
    intent?: string;
    effects: string[];
    confidence: number;
    origin: 'AI_PROPOSAL';
    runtimeConfirmed: false;
  };
  /** Les preuves montrées au conseiller (E1…), et celles qu'il a citées. */
  evidence: { id: string; summary: string }[];
  citedEvidence: string[];
  disagreement?: string;
  /** Toujours l'interprétation déterministe : l'IA ne réécrit jamais une action humaine. */
  finalInterpretation: SemanticInterpretation;
  reviewRequired: boolean;
  decisionReason: string;
  /** Le rejeu confirmera (ou contredira) : jamais confirmé à l'enregistrement. */
  runtimeConfirmation: 'PENDING';
}

export interface SemanticAuditReport {
  recordingId: string;
  enabled: boolean;
  mode: RecordingAuditMode;
  /** ai.mode : OFF → zéro appel, quoi que dise intelligenceAudit. */
  intelligenceMode: string;
  aiCalls: number;
  entries: SemanticAuditEntry[];
  summary: {
    humanActions: number;
    audited: number;
    confirmed: number;
    suspicious: number;
    disagreements: number;
    inconclusive: number;
    notAudited: number;
    reviewRequired: number;
  };
  decisions: AiDecisionRecord[];
}

type AuditSettings = ScenarioConfig['recording']['intelligenceAudit'];

const TRIGGER_SETTING: Record<
  Exclude<RecordingAuditTrigger, 'FULL_AUDIT'>,
  keyof AuditSettings['triggers']
> = {
  AMBIGUOUS_TARGET: 'ambiguousTarget',
  FRAGILE_LOCATOR: 'fragileLocator',
  LOW_SEMANTIC_CONFIDENCE: 'lowSemanticConfidence',
  UNKNOWN_INTERACTION: 'unknownInteraction',
  POSSIBLE_DRAG_AND_DROP: 'possibleDragAndDrop',
  NORMALIZATION_LOSS: 'normalizationLoss',
  CONTEXT_MISMATCH: 'contextMismatch',
  SUSPICIOUS_MERGE: 'suspiciousMerge',
};

/** Le texte de l'élément ne part jamais s'il pourrait être une saisie : libellés d'interface seulement. */
function interpretationOf(action: SemanticRecordedAction): SemanticInterpretation {
  const target = action.target;
  const fingerprint = target?.fingerprint;
  const section = target?.target.section ?? fingerprint?.section;
  return {
    interaction: action.type,
    target: action.drag?.item ?? target?.label ?? action.type,
    ...(section ? { section } : {}),
    ...(fingerprint?.semanticId ? { semanticId: fingerprint.semanticId } : {}),
    ...(target ? { locator: describeTarget(target.target), quality: target.quality } : {}),
    ...(action.drag
      ? {
          drag: {
            ...(action.drag.source ? { from: action.drag.source.section ?? action.drag.source.label } : {}),
            ...(action.drag.destination
              ? { to: action.drag.destination.section ?? action.drag.destination.label }
              : {}),
            moved: action.drag.moved,
          },
        }
      : {}),
  };
}

/** Les déclencheurs DÉTERMINISTES d'une action (avant toute question à l'IA). */
export function auditTriggersOf(
  action: SemanticRecordedAction,
  elements: readonly RecordedElement[],
): Exclude<RecordingAuditTrigger, 'FULL_AUDIT'>[] {
  const triggers: Exclude<RecordingAuditTrigger, 'FULL_AUDIT'>[] = [];
  const target = action.target;
  if (target?.ambiguous) triggers.push('AMBIGUOUS_TARGET');
  if (target && (target.quality === 'FRAGILE' || target.target.strategy === 'css'))
    triggers.push('FRAGILE_LOCATOR');
  if (action.confidence < 0.7) triggers.push('LOW_SEMANTIC_CONFIDENCE');
  if (action.semanticStatus === 'UNRESOLVED') triggers.push('UNKNOWN_INTERACTION');
  if (action.type === 'DRAG_AND_DROP' && action.drag && !action.drag.moved)
    triggers.push('POSSIBLE_DRAG_AND_DROP');
  // Le même libellé ailleurs, et une cible qui ne dit pas sa section : le contexte peut se perdre.
  const element = elements.at(-1);
  if (element && element.sameLabel > 1 && !target?.target.section && target?.target.strategy === 'label')
    triggers.push('CONTEXT_MISMATCH');
  // Une fusion qui réunit des éléments DIFFÉRENTS n'est pas une simple frappe.
  if (action.merged && new Set(elements.map((candidate) => candidate.css)).size > 1)
    triggers.push('SUSPICIOUS_MERGE');
  return triggers;
}

/**
 * RECORDING AUDIT ARBITER : la lecture de l'IA face à la lecture déterministe. Même cible → CONFIRMED ;
 * une autre cible → DISAGREEMENT (hypothèse) ; rien de clair → INCONCLUSIVE ; la même cible mais
 * des doutes exprimés → SUSPICIOUS. L'interprétation finale reste TOUJOURS la déterministe.
 */
export function arbitrateAudit(input: {
  proposal: IntelligenceProposal | undefined;
  /** La clé de la candidate choisie par l'IA (undefined si aucune, ou un identifiant inconnu). */
  selectedKey: string | undefined;
  deterministicKey: string;
  minConfidence: number;
}): { assessment: Exclude<AiAssessment, 'NOT_AUDITED'>; reason: string } {
  const { proposal } = input;
  if (!proposal)
    return {
      assessment: 'INCONCLUSIVE',
      reason: 'no valid AI answer: the deterministic interpretation is kept',
    };
  if (proposal.status !== 'PROPOSAL' || proposal.confidence < input.minConfidence)
    return {
      assessment: 'INCONCLUSIVE',
      reason: `AI answer ${proposal.status === 'PROPOSAL' ? `below the confidence threshold (${String(proposal.confidence)})` : proposal.status}: the deterministic interpretation is kept`,
    };
  if (input.selectedKey === undefined)
    return {
      assessment: proposal.uncertainties.length > 0 ? 'SUSPICIOUS' : 'INCONCLUSIVE',
      reason:
        proposal.uncertainties.length > 0
          ? `AI raised doubts without choosing another target: ${proposal.uncertainties.slice(0, 2).join('; ')}`
          : 'AI chose no target: the deterministic interpretation is kept',
    };
  if (input.selectedKey !== input.deterministicKey)
    return {
      assessment: 'DISAGREEMENT',
      reason:
        'AI reads another target: kept as a hypothesis (AI_PROPOSAL, runtimeConfirmed=false) and flagged for review; the deterministic interpretation stays final',
    };
  if (proposal.uncertainties.length > 0 && proposal.confidence < 0.75)
    return {
      assessment: 'SUSPICIOUS',
      reason: `AI agrees with the target but doubts it: ${proposal.uncertainties.slice(0, 2).join('; ')}`,
    };
  return { assessment: 'CONFIRMED', reason: 'AI agrees with the deterministic interpretation' };
}

/**
 * Auditer un enregistrement terminé. Le flow, le journal humain et les fichiers générés ne
 * changent JAMAIS ici : le rapport (semantic-audit.json) s'ajoute à côté.
 */
export async function auditRecordingSemantics(input: {
  result: RecordingResult;
  settings: AuditSettings;
  intelligenceMode: string;
  gateway?: IntelligenceGateway;
  minProposalConfidence?: number;
}): Promise<SemanticAuditReport> {
  const { result, settings } = input;
  const mode: RecordingAuditMode = settings.enabled ? settings.mode : 'OFF';
  const rawById = new Map(result.session.rawEvents.map((event) => [event.id, event]));
  const stateById = new Map(result.session.states.map((state) => [state.id, state]));
  const accountOf = new Map(
    result.journey.accounts
      .filter((account) => account.actionId)
      .map((account) => [account.actionId, account]),
  );
  const entries: SemanticAuditEntry[] = [];
  const decisions: AiDecisionRecord[] = [];
  let aiCalls = 0;
  let evidenceCounter = 0;
  const builder = new IntelligenceContextBuilder({
    maxActions: 30,
    maxEvidence: 12,
    maxHypotheses: 0,
    maxPlanSteps: 5,
  });
  const minConfidence = input.minProposalConfidence ?? 0.6;
  // OFF (ai.mode ou intelligenceAudit) : aucun appel, jamais.
  const gateway = mode !== 'OFF' && input.intelligenceMode !== 'OFF' ? input.gateway : undefined;

  for (const action of result.normalized.kept) {
    if (action.type === 'NAVIGATE') continue;
    const account = accountOf.get(action.id);
    const elements = action.rawEventIds
      .map((id) => rawById.get(id)?.element)
      .filter((element): element is RecordedElement => element !== undefined);
    const deterministic = interpretationOf(action);
    const triggers = auditTriggersOf(action, elements).filter(
      (trigger) => settings.triggers[TRIGGER_SETTING[trigger]],
    );
    const audited: RecordingAuditTrigger[] =
      mode === 'FULL'
        ? triggers.length > 0
          ? triggers
          : ['FULL_AUDIT']
        : mode === 'SUSPICIOUS_ONLY'
          ? triggers
          : [];
    const base = {
      humanActionId: account?.interactionId ?? action.id,
      actionId: action.id,
      ...(account?.flowStep !== undefined ? { flowStep: account.flowStep } : {}),
      deterministicInterpretation: deterministic,
      deterministicConfidence: action.confidence,
      auditTrigger: audited.length > 0 ? audited : triggers,
      finalInterpretation: deterministic,
      runtimeConfirmation: 'PENDING' as const,
      citedEvidence: [] as string[],
    };
    if (audited.length === 0 || !gateway || aiCalls >= settings.maxCalls) {
      entries.push({
        ...base,
        aiAssessment: 'NOT_AUDITED',
        evidence: [],
        reviewRequired: triggers.length > 0,
        decisionReason:
          audited.length === 0
            ? triggers.length > 0
              ? `deterministic triggers (${triggers.join(', ')}), audit mode ${mode}: not sent`
              : 'deterministic interpretation, no audit trigger'
            : !gateway
              ? 'intelligence OFF or unavailable: deterministic interpretation kept (no call)'
              : `audit budget reached (${String(settings.maxCalls)} call(s)): deterministic interpretation kept`,
      });
      continue;
    }

    // ---- les preuves (E…) : des faits d'interface, jamais une valeur saisie.
    const evidence: Evidence[] = [];
    const prove = (source: string, details: Record<string, string>): void => {
      evidenceCounter += 1;
      evidence.push({
        id: `E${String(evidenceCounter)}`,
        type: 'HUMAN_RECORDING',
        source,
        confidence: 0.9,
        details,
      });
    };
    const element = elements.at(-1);
    prove(`human ${action.type.toLowerCase()} ${account?.interactionId ?? action.id}`, {
      interaction: action.type,
      target: deterministic.target,
      ...(deterministic.section ? { section: deterministic.section } : {}),
    });
    if (element?.label || element?.guessedLabel)
      prove('field label', { label: element.label ?? element.guessedLabel ?? '', tag: element.tag });
    if (element?.sectionPath?.length)
      prove('section path', { section: element.sectionPath.join(' > '), target: deterministic.target });
    if (element?.formControlName)
      prove('form control binding', { formControl: element.formControlName, target: deterministic.target });
    if (action.drag)
      prove('drag and drop', {
        item: action.drag.item,
        from: action.drag.source?.section ?? action.drag.source?.label ?? '?',
        to: action.drag.destination?.section ?? action.drag.destination?.label ?? '?',
        moved: String(action.drag.moved),
      });
    const known = new Set(evidence.map((entry) => entry.id));

    // ---- les candidates : les contrôles de l'écran AVANT l'action, et la cible enregistrée.
    const before = action.stateBefore ? stateById.get(action.stateBefore) : undefined;
    const deterministicKey = `${element?.role ?? ''}:${normalize(deterministic.target)}`;
    const kindOf = (role: string): DiscoveredCandidate['kind'] =>
      ['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(role)
        ? 'fill'
        : role === 'checkbox' || role === 'radio' || role === 'switch'
          ? 'check'
          : 'click';
    const candidates: DiscoveredCandidate[] = [
      {
        key: deterministicKey,
        kind: kindOf(element?.role ?? ''),
        ...(element?.role ? { role: element.role } : {}),
        name: deterministic.section
          ? `${deterministic.target} (${deterministic.section})`
          : deterministic.target,
        safety: action.classification ?? 'SAFE',
        allowed: true,
        score: action.confidence,
      },
    ];
    for (const control of before?.controls ?? []) {
      const colon = control.indexOf(':');
      const role = control.slice(0, colon);
      const name = control.slice(colon + 1);
      const key = `${role}:${normalize(name)}`;
      if (candidates.some((candidate) => candidate.key === key) || candidates.length >= 25) continue;
      candidates.push({ key, kind: kindOf(role), role, name, safety: 'SAFE', allowed: true });
    }

    const trigger = gateway.evaluate({
      deterministicConfidence: action.confidence,
      recordingAmbiguity: true,
    });
    if (!trigger.shouldInvoke || !trigger.reason) {
      entries.push({
        ...base,
        aiAssessment: 'NOT_AUDITED',
        evidence: evidence.map((entry) => ({ id: entry.id, summary: summaryOf(entry) })),
        reviewRequired: triggers.length > 0,
        decisionReason: `AI not consulted (${trigger.skippedBecause ?? 'trigger policy'}): deterministic interpretation kept`,
      });
      continue;
    }
    const built = builder.build(trigger.reason, {
      mission: result.flow.name,
      workflow: {
        previous: [],
        next: [`${action.type} ${deterministic.target}`],
        requiredFields: [],
        ...(result.flow.intent.workflow ? { intent: result.flow.intent.workflow } : {}),
      },
      candidates,
      evidence,
      hypotheses: [],
      contradictions: [],
      functional: {
        satisfiedPreconditions: [],
        missingPreconditions: [],
        blockingReasons: [],
        causalRelations: [],
        previousConfirmedActions: [],
        nextExpectedActions: [],
        nextActionTargets: [],
        functionalCoverage: [],
        question: `AUDIT of one recorded human action (never change it). The deterministic recorder read: ${action.type} on "${deterministic.target}"${deterministic.section ? ` in section "${deterministic.section}"` : ''}${deterministic.drag ? ` (drag to "${deterministic.drag.to ?? '?'}", moved=${String(deterministic.drag.moved)})` : ''}. Triggers: ${audited.join(', ')}. Using only the action IDs and evidence IDs given, select the action ID of the element the human most likely interacted with (selectedActionId), the intent, the expected effects, and list your uncertainties. If you agree, select the same element.`,
      },
    });
    const consulted = await gateway.consult({
      context: 'RECORDING',
      request: built.request,
      scope: { action: `audit|${result.session.id}|${action.id}` },
      deterministic: { confidence: action.confidence },
      safety: () => ({
        allowed: false,
        classification: 'ADVISORY',
        reason: 'a recording audit never executes',
      }),
      knownEvidence: (id) => known.has(id),
      advisory: true,
    });
    decisions.push(consulted.record);
    if (consulted.record.lifecycle.call) aiCalls += 1;
    const proposal = consulted.validation?.valid ? consulted.validation.proposal : undefined;
    const selectedKey = proposal?.selectedActionId ? built.keyOf(proposal.selectedActionId) : undefined;
    const verdict = arbitrateAudit({ proposal, selectedKey, deterministicKey, minConfidence });
    const proposedTarget = selectedKey
      ? candidates.find((candidate) => candidate.key === selectedKey)?.name
      : undefined;
    entries.push({
      ...base,
      aiDecisionId: consulted.record.id,
      aiAssessment: verdict.assessment,
      ...(proposal
        ? {
            aiProposal: {
              ...(proposedTarget ? { target: proposedTarget } : {}),
              ...(selectedKey
                ? { interaction: candidates.find((c) => c.key === selectedKey)?.kind ?? '' }
                : {}),
              ...(proposal.intent ? { intent: proposal.intent } : {}),
              effects: (proposal.expectedEffects ?? []).map((effect) => `${effect.kind}: ${effect.value}`),
              confidence: proposal.confidence,
              origin: 'AI_PROPOSAL' as const,
              runtimeConfirmed: false as const,
            },
          }
        : {}),
      evidence: evidence.map((entry) => ({ id: entry.id, summary: summaryOf(entry) })),
      citedEvidence: proposal?.supportingEvidenceIds.filter((id) => known.has(id)) ?? [],
      ...(verdict.assessment === 'DISAGREEMENT'
        ? { disagreement: `deterministic "${deterministic.target}" vs AI "${proposedTarget ?? '?'}"` }
        : {}),
      reviewRequired: verdict.assessment === 'DISAGREEMENT' || verdict.assessment === 'SUSPICIOUS',
      decisionReason: verdict.reason,
    });
  }

  // NORMALIZATION LOSS : une interaction humaine sans compte est TOUJOURS signalée (jamais envoyée sans action).
  if (settings.triggers.normalizationLoss)
    for (const account of result.journey.accounts.filter((entry) => entry.status === 'UNACCOUNTED')) {
      const lost: SemanticInterpretation = {
        interaction: account.type,
        target: account.target ?? account.type,
      };
      entries.push({
        humanActionId: account.interactionId,
        deterministicInterpretation: lost,
        deterministicConfidence: 0,
        auditTrigger: ['NORMALIZATION_LOSS'],
        aiAssessment: 'NOT_AUDITED',
        evidence: [],
        citedEvidence: [],
        finalInterpretation: lost,
        reviewRequired: true,
        decisionReason: 'a human interaction without accounting: never silently lost',
        runtimeConfirmation: 'PENDING',
      });
    }

  const count = (assessment: AiAssessment): number =>
    entries.filter((entry) => entry.aiAssessment === assessment).length;
  return {
    recordingId: result.session.id,
    enabled: settings.enabled,
    mode,
    intelligenceMode: input.intelligenceMode,
    aiCalls,
    entries,
    summary: {
      humanActions: entries.length,
      audited: entries.length - count('NOT_AUDITED'),
      confirmed: count('CONFIRMED'),
      suspicious: count('SUSPICIOUS'),
      disagreements: count('DISAGREEMENT'),
      inconclusive: count('INCONCLUSIVE'),
      notAudited: count('NOT_AUDITED'),
      reviewRequired: entries.filter((entry) => entry.reviewRequired).length,
    },
    decisions,
  };
}

function summaryOf(evidence: Evidence): string {
  return `${evidence.source}: ${Object.entries(evidence.details)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)
    .join(', ')}`.slice(0, 200);
}

/**
 * Le conseiller de la VALIDATION IMMÉDIATE (même gateway, même builder, contexte RECORDING) :
 * « la représentation proposée désigne-t-elle bien la cible de l'humain ? quelle candidate T…
 * la représente le mieux ? ». Il choisit une candidate fournie ; QA-CRAWLER la résout ensuite et
 * la compare à l'original — une proposition qui ne retrouve pas la cible est rejetée.
 */
export function targetAuditAdvisor(
  gateway: IntelligenceGateway,
  options: { maxCalls: number },
): TargetAuditAdvisor {
  let calls = 0;
  let counter = 0;
  const builder = new IntelligenceContextBuilder({
    maxActions: 10,
    maxEvidence: 12,
    maxHypotheses: 0,
    maxPlanSteps: 3,
  });
  return async ({ event, original, check, candidates, previousActions }) => {
    if (calls >= options.maxCalls) return { outcome: 'INCONCLUSIVE', citedEvidence: [] };
    const trigger = gateway.evaluate({ deterministicConfidence: 0, recordingAmbiguity: true });
    if (!trigger.shouldInvoke || !trigger.reason) return { outcome: 'UNAVAILABLE', citedEvidence: [] };
    const evidence: Evidence[] = [];
    const prove = (source: string, details: Record<string, string>): void => {
      counter += 1;
      evidence.push({ id: `E${String(counter)}`, type: 'HUMAN_RECORDING', source, confidence: 0.9, details });
    };
    prove('original human target', {
      action: event.type,
      ...(original.role ? { role: original.role } : {}),
      ...(original.tag ? { tag: original.tag } : {}),
      ...(original.label ? { label: original.label } : {}),
      ...(original.name ? { name: original.name } : {}),
      ...(original.section ? { section: original.section } : {}),
    });
    prove('validation result', {
      status: check.status,
      reason: check.reason.slice(0, 160),
      candidates: String(check.candidateCount),
    });
    for (const entry of check.candidates ?? [])
      prove(`runtime candidate ${String(entry.index + 1)}`, {
        ...(entry.role ? { role: entry.role } : {}),
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.section ? { section: entry.section } : {}),
      });
    if (previousActions.length > 0)
      prove('previous human actions', { actions: previousActions.join(' ; ').slice(0, 200) });
    const known = new Set(evidence.map((entry) => entry.id));
    const keys = new Set(candidates.map((candidate) => candidate.key));
    const built = builder.build(trigger.reason, {
      mission: 'recording target validation',
      workflow: {
        previous: previousActions,
        next: [`${event.type} ${original.label ?? original.name ?? ''}`],
        requiredFields: [],
      },
      candidates: candidates.map((candidate) => ({
        key: candidate.key,
        kind: event.type === 'click' || event.type === 'submit' ? 'click' : 'fill',
        name: candidate.description,
        safety: 'SAFE' as const,
        allowed: true,
      })),
      evidence,
      hypotheses: [],
      contradictions: [],
      functional: {
        satisfiedPreconditions: [],
        missingPreconditions: [],
        blockingReasons: [],
        causalRelations: [],
        previousConfirmedActions: previousActions,
        nextExpectedActions: [],
        nextActionTargets: [],
        functionalCoverage: [],
        question: `RECORDING TARGET VALIDATION (never execute anything). The human just used: ${describeOriginal(original)}. Validation: ${check.status} (${check.reason}). Does the proposed representation correctly represent the target actually manipulated by the human? Which provided candidate (action ID) best represents the human target? Use only the given action IDs and evidence IDs.`,
      },
    });
    const consulted = await gateway.consult({
      context: 'RECORDING',
      request: built.request,
      scope: { action: `target-validation|${event.id}` },
      deterministic: { confidence: check.confidence },
      safety: () => ({
        allowed: false,
        classification: 'ADVISORY',
        reason: 'a target validation never executes',
      }),
      knownEvidence: (id) => known.has(id),
      advisory: true,
    });
    if (consulted.record.lifecycle.call) calls += 1;
    const decisionId = consulted.record.id;
    const proposal = consulted.validation?.valid ? consulted.validation.proposal : undefined;
    if (!proposal)
      return {
        decisionId,
        outcome: consulted.record.lifecycle.call ? 'INCONCLUSIVE' : 'UNAVAILABLE',
        citedEvidence: [],
      };
    const selectedKey = proposal.selectedActionId ? built.keyOf(proposal.selectedActionId) : undefined;
    return {
      decisionId,
      ...(selectedKey && keys.has(selectedKey) ? { selectedKey } : {}),
      outcome: proposal.status === 'PROPOSAL' && selectedKey ? 'PROPOSAL' : 'INCONCLUSIVE',
      citedEvidence: proposal.supportingEvidenceIds.filter((id) => known.has(id)),
    };
  };
}

function describeOriginal(original: {
  role?: string;
  tag?: string;
  label?: string;
  name?: string;
  section?: string;
}): string {
  return `${original.role ?? original.tag ?? 'element'} "${original.label ?? original.name ?? ''}"${original.section ? ` in section "${original.section}"` : ''}`;
}
