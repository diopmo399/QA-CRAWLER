import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiDecisionRecord } from '../ai/audit-trail.js';
import { IntelligenceContextBuilder, type DiscoveredCandidate } from '../ai/context-builder.js';
import type { IntelligenceGateway } from '../ai/gateway.js';
import type { IntelligenceMode, IntelligenceProposal } from '../ai/model.js';
import { normalize } from '../flows/action-effect-verifier.js';
import type { RecordingResult } from './process-recording.js';

/**
 * RECORDING INTELLIGENCE ENRICHER — PRESERVE FIRST, UNDERSTAND SECOND, OPTIMIZE LAST.
 *
 *   HumanRecorder → RawHumanTimeline → ActionCorrelation → SemanticHumanJourney
 *     → enrichissement déterministe → ambiguïté ? → (Copilot) → RecordingKnowledgeCandidate
 *
 * L'IA intervient dans UNDERSTAND, jamais dans PRESERVE : elle ne supprime, ne réordonne,
 * n'invente ni ne modifie aucune action humaine, aucune valeur, aucune classification, et ne
 * déclare aucune causalité CONFIRMÉE. Ce qu'elle propose reste un CANDIDAT (origin AI_PROPOSAL,
 * runtimeConfirmed=false), que seul le rejeu pourra confirmer.
 */

export const RECORDING_CANDIDATE_KINDS = [
  'FUNCTIONAL_GOAL',
  'WORKFLOW_PHASE',
  'BUSINESS_INTENT',
  'SEMANTIC_CHECKPOINT',
  'PRECONDITION',
  'CAUSAL',
  'INVARIANT',
] as const;
export type RecordingCandidateKind = (typeof RECORDING_CANDIDATE_KINDS)[number];

export interface RecordingKnowledgeCandidate {
  id: string;
  kind: RecordingCandidateKind;
  statement: string;
  origin: 'DETERMINISTIC' | 'AI_PROPOSAL';
  sourceRecording: string;
  aiDecisionId?: string;
  /** Les étapes du flow concernées (jamais modifiées). */
  relatedSteps: string[];
  evidenceIds: string[];
  /** Toujours faux ici : seul le rejeu peut confirmer. */
  runtimeConfirmed: false;
  status: 'PROPOSED';
  /** ASSIST : connaissance shadow ; HYBRID : hypothèse utilisable par le raisonnement (jamais une vérité). */
  usage: 'SHADOW' | 'HYPOTHESIS';
  /** Une relation observable au rejeu : l'action et le contrôle qu'elle doit faire apparaître. */
  observable?: { action: string; effect: string };
}

export interface RecordingIntelligence {
  recordingId: string;
  mode: IntelligenceMode;
  humanActions: number;
  preserved: number;
  /** L'empreinte des étapes humaines est identique avant et après l'enrichissement. */
  preservationVerified: boolean;
  ambiguities: string[];
  aiCalls: number;
  candidates: RecordingKnowledgeCandidate[];
  summary: {
    functionalGoals: number;
    phases: number;
    preconditions: number;
    causalHypotheses: number;
    checkpoints: number;
    runtimeConfirmed: number;
    pendingConfirmation: number;
  };
  decisions: AiDecisionRecord[];
}

/** L'empreinte des actions humaines : ordre, type, cible, provenance (jamais la valeur saisie elle-même). */
export function humanActionsFingerprint(result: RecordingResult): string {
  const steps = result.flow.steps.map((step) => ({
    id: step.id,
    kind: step.step.kind,
    label: step.label,
    actions: step.actionIds,
    raw: step.rawEventIds,
    provenance: step.provenance,
    step: JSON.stringify(step.step),
  }));
  const kept = result.normalized.kept.map(
    (action) => `${action.id}|${action.type}|${action.classification ?? ''}`,
  );
  return createHash('sha256').update(JSON.stringify({ steps, kept })).digest('hex');
}

const STEP_KINDS = new Set(['click', 'check', 'uncheck', 'select', 'fill']);

/**
 * Enrichir un enregistrement terminé : d'abord le déterministe (phases, dépendances, intention),
 * puis — seulement si le sens reste ambigu et que l'intelligence est active — le conseiller.
 */
export async function enrichRecording(input: {
  result: RecordingResult;
  mode: IntelligenceMode;
  gateway?: IntelligenceGateway;
  /** Appels au conseiller au plus (un par phase ambiguë). */
  maxCalls?: number;
  context?: { maxActions: number; maxEvidence: number; maxHypotheses: number };
}): Promise<RecordingIntelligence> {
  const { result } = input;
  const recordingId = result.session.id;
  const before = humanActionsFingerprint(result);
  // ASSIST : des candidats shadow ; HYBRID : des hypothèses que le raisonnement peut utiliser (jamais une vérité).
  const usage: RecordingKnowledgeCandidate['usage'] = input.mode === 'HYBRID' ? 'HYPOTHESIS' : 'SHADOW';
  const candidates: RecordingKnowledgeCandidate[] = [];
  const add = (
    candidate: Omit<
      RecordingKnowledgeCandidate,
      'id' | 'sourceRecording' | 'runtimeConfirmed' | 'status' | 'usage'
    >,
  ): void => {
    const key = `${candidate.kind}|${normalize(candidate.statement)}`;
    if (candidates.some((known) => `${known.kind}|${normalize(known.statement)}` === key)) return;
    candidates.push({
      id: `RK-${String(candidates.length + 1)}`,
      sourceRecording: recordingId,
      runtimeConfirmed: false,
      status: 'PROPOSED',
      usage,
      ...candidate,
    });
  };
  const stepOfAction = new Map<string, string>();
  for (const step of result.flow.steps) for (const id of step.actionIds) stepOfAction.set(id, step.id);
  const stepById = new Map(result.flow.steps.map((step) => [step.id, step]));

  // ---- enrichissement DÉTERMINISTE : ce que le parcours montre déjà
  const intent = result.flow.intent;
  if (intent.workflow)
    add({
      kind: 'BUSINESS_INTENT',
      statement: intent.workflow,
      origin: 'DETERMINISTIC',
      relatedSteps: [],
      evidenceIds: [],
    });
  for (const phase of result.journey.phases)
    add({
      kind: 'WORKFLOW_PHASE',
      statement: `phase ${String(phase.index)}: ${phase.label}`,
      origin: 'DETERMINISTIC',
      relatedSteps: result.journey.accounts
        .filter(
          (account) => phase.interactionIds.includes(account.interactionId) && account.flowStep !== undefined,
        )
        .map((account) => result.flow.steps[(account.flowStep ?? 1) - 1]?.id ?? '')
        .filter(Boolean),
      evidenceIds: [],
    });
  for (const dependency of result.journey.dependencies) {
    const from = stepById.get(stepOfAction.get(dependency.from) ?? '');
    const to = stepById.get(stepOfAction.get(dependency.to) ?? '');
    if (!from || !to) continue;
    add({
      kind: 'CAUSAL',
      statement:
        `${from.step.kind} "${from.label}" makes "${to.label}" available (${dependency.evidence}: ${dependency.reason})`.slice(
          0,
          300,
        ),
      origin: 'DETERMINISTIC',
      relatedSteps: [from.id, to.id],
      evidenceIds: [],
    });
  }
  for (const checkpoint of result.session.checkpoints)
    add({
      kind: 'SEMANTIC_CHECKPOINT',
      statement: checkpoint.label,
      origin: 'DETERMINISTIC',
      relatedSteps: checkpoint.afterActionId
        ? [stepOfAction.get(checkpoint.afterActionId) ?? ''].filter(Boolean)
        : [],
      evidenceIds: [],
    });

  // ---- AMBIGUÏTÉ : ce que le déterministe ne comprend pas
  const ambiguities: string[] = [];
  const unresolved = result.flow.steps.filter((step) => step.semanticStatus === 'UNRESOLVED');
  if (unresolved.length > 0)
    ambiguities.push(
      `${String(unresolved.length)} human action(s) whose role is not understood: ${unresolved
        .map((step) => step.label)
        .slice(0, 5)
        .join(', ')}`,
    );
  if (!intent.workflow) ambiguities.push('no business intent inferred (no business write observed)');
  const openers = result.flow.steps.filter(
    (step) =>
      step.step.kind === 'click' &&
      !result.journey.dependencies.some((dependency) => stepOfAction.get(dependency.from) === step.id),
  );
  if (openers.length > 0 && result.journey.dependencies.length === 0)
    ambiguities.push('no dependency between the human actions was observed');

  const decisions: AiDecisionRecord[] = [];
  let aiCalls = 0;
  const gateway = input.gateway;
  if (gateway && input.mode !== 'OFF' && ambiguities.length > 0) {
    const builder = new IntelligenceContextBuilder({
      maxActions: input.context?.maxActions ?? 40,
      maxEvidence: input.context?.maxEvidence ?? 0,
      maxHypotheses: input.context?.maxHypotheses ?? 0,
      maxPlanSteps: 10,
    });
    const classification = new Map(
      result.normalized.kept.map((action) => [action.id, action.classification]),
    );
    // Une copie des étapes : le conseiller ne voit QUE des libellés et des types (aucune valeur saisie).
    const actionable = result.flow.steps.filter((step) => STEP_KINDS.has(step.step.kind));
    const candidatesOf = (steps: typeof actionable): DiscoveredCandidate[] =>
      steps.map((step) => {
        const safety = step.actionIds.map((id) => classification.get(id)).find(Boolean) ?? 'SAFE';
        const target = 'target' in step.step ? step.step.target : undefined;
        return {
          key: step.id,
          kind: step.step.kind === 'uncheck' ? 'check' : (step.step.kind as DiscoveredCandidate['kind']),
          ...(target?.role ? { role: target.role } : {}),
          name: step.label,
          safety,
          allowed: true,
        };
      });
    const phases =
      result.journey.phases.length > 0
        ? result.journey.phases
        : [{ index: 1, label: result.flow.name, interactionIds: [] }];
    for (const phase of phases.slice(0, input.maxCalls ?? 4)) {
      const trigger = gateway.evaluate({ deterministicConfidence: 0, recordingAmbiguity: true });
      if (!trigger.shouldInvoke || !trigger.reason) break;
      const built = builder.build(trigger.reason, {
        mission: result.flow.name,
        workflow: {
          previous: [],
          next: actionable.map((step) => `${step.step.kind} ${step.label}`),
          requiredFields: actionable.filter((step) => step.step.kind === 'fill').map((step) => step.label),
          ...(intent.workflow ? { intent: intent.workflow } : {}),
        },
        candidates: candidatesOf(actionable),
        evidence: [],
        hypotheses: [],
        contradictions: [],
        functional: {
          satisfiedPreconditions: [],
          missingPreconditions: [],
          blockingReasons: [],
          causalRelations: candidates
            .filter((candidate) => candidate.kind === 'CAUSAL')
            .map((candidate) => candidate.statement)
            .slice(0, 10),
          previousConfirmedActions: [],
          nextExpectedActions: actionable.map((step) => `${step.step.kind} ${step.label}`).slice(0, 10),
          nextActionTargets: [],
          functionalCoverage: [],
          question: `A human recorded this journey (actions in order, IDs A1..An). Focus on phase "${phase.label}". Ambiguities: ${ambiguities.join('; ')}. Propose the functional goal, the workflow phase, the business intent, a semantic checkpoint, a possible precondition or a causal relationship (selectedActionId + expectedEffects), using only these action IDs. Never remove, reorder, add or change an action.`,
        },
      });
      const consulted = await gateway.consult({
        context: 'RECORDING',
        request: built.request,
        scope: { divergence: `recording|${recordingId}|${String(phase.index)}` },
        deterministic: { confidence: 0 },
        safety: () => ({
          allowed: false,
          classification: 'ADVISORY',
          reason: 'recording enrichment never executes',
        }),
        knownEvidence: () => false,
        advisory: true,
      });
      decisions.push(consulted.record);
      if (consulted.record.lifecycle.call) aiCalls += 1;
      const proposal = consulted.validation?.valid ? consulted.validation.proposal : undefined;
      if (proposal) addProposal(proposal, consulted.record.id, (id) => built.keyOf(id), stepById, add);
    }
  }

  // PRESERVE FIRST : rien de ce que l'humain a fait n'a changé.
  const preservationVerified = humanActionsFingerprint(result) === before;
  const count = (kind: RecordingCandidateKind): number =>
    candidates.filter((candidate) => candidate.kind === kind).length;
  const summary = result.journey.summary;
  return {
    recordingId,
    mode: input.mode,
    humanActions: summary.meaningful,
    preserved: summary.preserved + summary.unresolvedPreserved,
    preservationVerified,
    ambiguities,
    aiCalls,
    candidates,
    summary: {
      functionalGoals: count('FUNCTIONAL_GOAL'),
      phases: count('WORKFLOW_PHASE'),
      preconditions: count('PRECONDITION'),
      causalHypotheses: count('CAUSAL'),
      checkpoints: count('SEMANTIC_CHECKPOINT'),
      runtimeConfirmed: 0,
      pendingConfirmation: candidates.filter((candidate) => candidate.origin === 'AI_PROPOSAL').length,
    },
    decisions,
  };
}

/** Une proposition VALIDE → des candidats (jamais une modification du flow). */
function addProposal(
  proposal: IntelligenceProposal,
  decisionId: string,
  keyOf: (actionId: string) => string | undefined,
  stepById: ReadonlyMap<string, RecordingResult['flow']['steps'][number]>,
  add: (
    candidate: Omit<
      RecordingKnowledgeCandidate,
      'id' | 'sourceRecording' | 'runtimeConfirmed' | 'status' | 'usage'
    >,
  ) => void,
): void {
  const evidenceIds = proposal.supportingEvidenceIds;
  const selected = proposal.selectedActionId
    ? stepById.get(keyOf(proposal.selectedActionId) ?? '')
    : undefined;
  const related = selected ? [selected.id] : [];
  const base = {
    origin: 'AI_PROPOSAL' as const,
    aiDecisionId: decisionId,
    evidenceIds,
    relatedSteps: related,
  };
  if (proposal.proposedGoal)
    add({
      ...base,
      kind: 'FUNCTIONAL_GOAL',
      statement: `${proposal.proposedGoal.id}${proposal.proposedGoal.description ? ` — ${proposal.proposedGoal.description}` : ''}`,
    });
  if (proposal.workflowPhase) add({ ...base, kind: 'WORKFLOW_PHASE', statement: proposal.workflowPhase });
  if (proposal.intent) add({ ...base, kind: 'BUSINESS_INTENT', statement: proposal.intent });
  if (proposal.missingPrecondition)
    add({ ...base, kind: 'PRECONDITION', statement: proposal.missingPrecondition });
  if (proposal.hypothesis) {
    const type = proposal.hypothesis.type;
    const kind: RecordingCandidateKind =
      type === 'WORKFLOW_PRECONDITION'
        ? 'PRECONDITION'
        : type === 'SEMANTIC_CHECKPOINT'
          ? 'SEMANTIC_CHECKPOINT'
          : type === 'INVARIANT'
            ? 'INVARIANT'
            : type === 'FUNCTIONAL_GOAL'
              ? 'FUNCTIONAL_GOAL'
              : 'CAUSAL';
    add({
      ...base,
      kind,
      statement: proposal.hypothesis.statement,
      evidenceIds: [...evidenceIds, ...proposal.hypothesis.evidenceIds],
    });
  }
  for (const effect of proposal.expectedEffects ?? []) {
    if (effect.kind === 'CHECKPOINT') {
      add({ ...base, kind: 'SEMANTIC_CHECKPOINT', statement: effect.value });
      continue;
    }
    // « click Company information » doit faire apparaître « Company name » : une relation OBSERVABLE au rejeu.
    if (
      !selected ||
      !['VISIBLE_FIELD', 'VISIBLE_CONTROL', 'NEXT_ACTION_TARGET_AVAILABLE'].includes(effect.kind)
    )
      continue;
    const role = effect.kind === 'VISIBLE_CONTROL' ? 'button' : 'textbox';
    const action = `${selected.step.kind} ${normalize(selected.label)}`;
    add({
      ...base,
      kind: 'CAUSAL',
      statement: `${selected.step.kind} "${selected.label}" reveals "${effect.value}"`,
      observable: { action, effect: `${role}:${normalize(effect.value)}` },
    });
  }
}

/** Les candidats HYBRID, gardés hors du dépôt pour le rejeu (il pourra les confirmer ou les contredire). */
export function recordingCandidatesFile(reportsDir: string): string {
  return path.join(path.dirname(path.resolve(reportsDir)), 'knowledge', 'ai-recording-candidates.json');
}

export async function rememberRecordingCandidates(
  file: string,
  candidates: readonly RecordingKnowledgeCandidate[],
): Promise<void> {
  const kept = candidates.filter(
    (candidate) => candidate.origin === 'AI_PROPOSAL' && candidate.usage === 'HYPOTHESIS',
  );
  if (kept.length === 0) return;
  const existing = await loadRecordingCandidates(file);
  const merged = [
    ...existing.filter(
      (known) => !kept.some((candidate) => candidate.sourceRecording === known.sourceRecording),
    ),
    ...kept,
  ].slice(-500);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ candidates: merged }, null, 2)}\n`, 'utf8');
}

export async function loadRecordingCandidates(file: string): Promise<RecordingKnowledgeCandidate[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { candidates?: RecordingKnowledgeCandidate[] };
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch {
    return [];
  }
}
