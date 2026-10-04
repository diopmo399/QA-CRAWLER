import type { AiDecisionRecord } from '../ai/audit-trail.js';
import { IntelligenceContextBuilder, type DiscoveredCandidate } from '../ai/context-builder.js';
import type { IntelligenceGateway } from '../ai/gateway.js';
import type { Evidence } from '../cognitive/evidence.js';
import { describeTarget, type FlowStep } from '../config/flow-schema.js';
import type { RecordedFlowStep, RecordedState, SemanticRecordedAction } from './model.js';
import type { RecordingResult } from './process-recording.js';

/**
 * FLOW AUDITOR — relire le FLOW GÉNÉRÉ dans son ensemble, pas seulement chaque cible :
 *
 *   règles déterministes (toujours, sans coût) : étapes consécutives identiques, clic sans effet
 *   avant le même clic qui a l'effet, double écriture, saisies jamais envoyées, aucune vérification
 *   finale, cible ambiguë / fragile, intention non comprise, cible absente de l'écran observé ;
 *     → (IntelligenceGateway existant, contexte RECORDING, avis seulement) : le conseiller CONFIRME
 *       ou CONTESTE chaque constat, puis relit tout le flow et signale ce que les règles n'ont pas vu ;
 *     → flow-audit.json / flow-audit.txt, et un commentaire « FLOW AUDIT » au-dessus de chaque étape
 *       concernée dans generated.flow.yaml.
 *
 * L'IA NE MODIFIE JAMAIS LE FLOW : une proposition est une hypothèse (AI_PROPOSAL), à revoir par
 * l'humain ; le rejeu reste la vérité. Aucune valeur saisie, aucun secret n'est envoyé.
 */

export type FlowAuditRule =
  | 'CONSECUTIVE_DUPLICATE_STEP'
  | 'EFFECTLESS_CLICK_BEFORE_SAME_TARGET'
  | 'DOUBLE_MUTATION_RISK'
  | 'TRAILING_INPUT_NOT_SUBMITTED'
  | 'NO_FINAL_CHECK'
  | 'AMBIGUOUS_TARGET'
  | 'FRAGILE_TARGET'
  | 'UNRESOLVED_STEP'
  | 'TARGET_NOT_SEEN_ON_SCREEN'
  | 'AI_FINDING';

export type FlowAuditSeverity = 'INFO' | 'WARNING' | 'ERROR';

export type FlowAuditAssessment =
  /** Le conseiller confirme le constat. */
  | 'AI_CONFIRMED'
  /** Le conseiller ne le confirme pas (le constat déterministe reste, à revoir). */
  | 'AI_DISPUTED'
  /** Aucune réponse exploitable. */
  | 'AI_INCONCLUSIVE'
  /** Un constat du conseiller seul : une hypothèse. */
  | 'AI_PROPOSAL'
  | 'NOT_AUDITED';

export interface FlowAuditFinding {
  id: string;
  rule: FlowAuditRule;
  severity: FlowAuditSeverity;
  /** Les étapes concernées (1 = la première étape du flow). */
  steps: number[];
  message: string;
  suggestion: string;
  evidence: string[];
  origin: 'DETERMINISTIC' | 'AI_PROPOSAL';
  assessment: FlowAuditAssessment;
  aiDecisionId?: string;
  aiStatement?: string;
  aiConfidence?: number;
  /** Jamais appliqué automatiquement : à revoir par l'humain. */
  reviewRequired: boolean;
}

export interface FlowAuditReport {
  recordingId: string;
  flow: string;
  steps: number;
  intelligenceMode: string;
  aiCalls: number;
  findings: FlowAuditFinding[];
  summary: { errors: number; warnings: number; infos: number; aiConfirmed: number; aiProposals: number };
  /** Le flow n'est jamais modifié par l'audit. */
  flowModified: false;
  decisions: AiDecisionRecord[];
}

export interface FlowAuditSettings {
  enabled: boolean;
  /** Le conseiller (si ai.mode ≠ OFF) relit le flow. */
  ai: boolean;
  maxCalls: number;
}

const norm = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** « click role=button[name="Save"] » : une étape, lisible, jamais une valeur saisie. */
function describeStepOf(step: FlowStep): string {
  if ('target' in step) return `${step.kind} ${describeTarget(step.target)}`;
  if (step.kind === 'expect') return 'expect';
  if (step.kind === 'goto') return `goto ${step.url}`;
  return step.kind;
}

/** L'identité d'une cible d'étape : localisateur + contexte (ligne, section, fenêtre). */
function targetKey(step: FlowStep): string | undefined {
  if (!('target' in step)) return undefined;
  const fingerprint = step.fingerprint;
  return [
    step.kind,
    describeTarget(step.target),
    norm(fingerprint?.row),
    norm(fingerprint?.section ?? step.target.section),
    norm(fingerprint?.dialog),
  ].join('|');
}

interface StepFacts {
  index: number;
  recorded: RecordedFlowStep;
  actions: SemanticRecordedAction[];
  effect: boolean;
  writes: string[];
  before?: RecordedState;
}

/** Les constats DÉTERMINISTES sur le flow généré. */
export function deterministicFlowFindings(result: RecordingResult): FlowAuditFinding[] {
  const byId = new Map(result.normalized.actions.map((action) => [action.id, action]));
  const states = new Map(result.session.states.map((state) => [state.id, state]));
  const facts: StepFacts[] = result.flow.steps.map((recorded, position) => {
    const actions = recorded.actionIds
      .map((id) => byId.get(id))
      .filter((action): action is SemanticRecordedAction => action !== undefined);
    const writes = actions.flatMap((action) =>
      action.network
        .filter((exchange) => /^(POST|PUT|PATCH|DELETE)$/i.test(exchange.method))
        .map((exchange) => `${exchange.method.toUpperCase()} ${exchange.path}`),
    );
    const first = actions[0];
    const before = first?.stateBefore ? states.get(first.stateBefore) : undefined;
    return {
      index: position + 1,
      recorded,
      actions,
      effect: actions.some(
        (action) =>
          (action.domEffects ?? []).length > 0 ||
          action.navigation !== undefined ||
          action.network.length > 0,
      ),
      writes,
      ...(before ? { before } : {}),
    };
  });
  const findings: Omit<FlowAuditFinding, 'id'>[] = [];
  const add = (finding: Omit<FlowAuditFinding, 'id' | 'origin' | 'assessment' | 'reviewRequired'>): void => {
    findings.push({ ...finding, origin: 'DETERMINISTIC', assessment: 'NOT_AUDITED', reviewRequired: true });
  };

  for (const [position, current] of facts.entries()) {
    const step = current.recorded.step;
    const previous = facts[position - 1];
    const key = targetKey(step);
    // 1. Deux étapes consécutives identiques (même action, même cible, même contexte).
    if (previous && key && key === targetKey(previous.recorded.step)) {
      const clickPair = step.kind === 'click';
      const effectless = clickPair && !previous.effect && current.effect;
      add({
        rule: effectless ? 'EFFECTLESS_CLICK_BEFORE_SAME_TARGET' : 'CONSECUTIVE_DUPLICATE_STEP',
        severity: 'WARNING',
        steps: [previous.index, current.index],
        message: effectless
          ? `steps ${String(previous.index)} and ${String(current.index)} click the same target "${current.recorded.label}"; the first had no observed effect, the second produced it`
          : `steps ${String(previous.index)} and ${String(current.index)} repeat "${describeStepOf(step)}" on the same target`,
        suggestion: effectless
          ? `remove step ${String(previous.index)} (a click that did nothing: at replay it may already trigger the effect, leaving step ${String(current.index)} without a target)`
          : clickPair
            ? 'keep both only if the repetition is intended (a counter, a pagination); otherwise remove one'
            : 'keep the last one if it is a correction',
        evidence: [
          `step ${String(previous.index)}: ${previous.effect ? 'effect observed' : 'no effect observed'}`,
          `step ${String(current.index)}: ${current.effect ? 'effect observed' : 'no effect observed'}`,
        ],
      });
    }
    // 2. Une écriture envoyée deux fois de suite (double mutation au rejeu) — par deux étapes d'ACTION
    //    distinctes : une vérification déduite de la même action n'écrit rien.
    if (
      previous &&
      'target' in step &&
      'target' in previous.recorded.step &&
      !current.recorded.actionIds.some((id) => previous.recorded.actionIds.includes(id)) &&
      current.writes.length > 0 &&
      current.writes.some((write) => previous.writes.includes(write))
    )
      add({
        rule: 'DOUBLE_MUTATION_RISK',
        severity: 'ERROR',
        steps: [previous.index, current.index],
        message: `steps ${String(previous.index)} and ${String(current.index)} both send ${current.writes.find((write) => previous.writes.includes(write)) ?? ''}`,
        suggestion: 'check that the second write is intended: at replay the data is written twice',
        evidence: [`writes: ${previous.writes.join(', ')} / ${current.writes.join(', ')}`],
      });
    // 3. Qualité de la cible.
    if (current.recorded.quality === 'FRAGILE')
      add({
        rule: 'FRAGILE_TARGET',
        severity: 'WARNING',
        steps: [current.index],
        message: `step ${String(current.index)} targets a position in the page (${describeStepOf(step)})`,
        suggestion: 're-record with a labelled element, or add a data-testid to the application',
        evidence: ['locator quality FRAGILE'],
      });
    if (current.actions.some((action) => action.target?.ambiguous))
      add({
        rule: 'AMBIGUOUS_TARGET',
        severity: 'WARNING',
        steps: [current.index],
        message: `step ${String(current.index)}: the recorded target is ambiguous (${current.recorded.label})`,
        suggestion:
          'the replay will refuse to choose arbitrarily; check the fingerprint (section, dialog, row)',
        evidence: current.actions.flatMap((action) => action.target?.reasons ?? []).slice(0, 3),
      });
    // 4. Une cible de clic absente des contrôles observés juste avant (un écran déjà quitté ?).
    if (
      step.kind === 'click' &&
      'target' in step &&
      step.target.strategy === 'role' &&
      step.target.name &&
      current.before &&
      current.before.controls.length > 0 &&
      !current.before.controls.some(
        (control) => norm(control.slice(control.indexOf(':') + 1)) === norm(step.target.name),
      )
    )
      add({
        rule: 'TARGET_NOT_SEEN_ON_SCREEN',
        severity: 'INFO',
        steps: [current.index],
        message: `step ${String(current.index)}: "${step.target.name}" was not among the controls observed on "${current.before.label}" before the click`,
        suggestion: 'check the order of the steps (a target of another screen, or a control rendered late)',
        evidence: [
          `${String(current.before.controls.length)} control(s) observed on ${current.before.route}`,
        ],
      });
  }
  // Une intention non comprise, que rien d'autre n'explique déjà.
  for (const current of facts)
    if (
      current.recorded.semanticStatus === 'UNRESOLVED' &&
      !findings.some((entry) => entry.steps.includes(current.index))
    )
      add({
        rule: 'UNRESOLVED_STEP',
        severity: 'INFO',
        steps: [current.index],
        message: `step ${String(current.index)} "${current.recorded.label}" had no observed effect: its role in the journey is not understood`,
        suggestion: 'keep it if it prepares the next step; otherwise remove it',
        evidence: ['no screen change, navigation or request observed'],
      });
  // 5. Des saisies à la fin, jamais envoyées.
  const elements = facts.filter((entry) => 'target' in entry.recorded.step);
  const trailing: StepFacts[] = [];
  for (const entry of [...elements].reverse()) {
    if (entry.recorded.step.kind !== 'fill' && entry.recorded.step.kind !== 'select') break;
    trailing.unshift(entry);
  }
  if (trailing.length > 0)
    add({
      rule: 'TRAILING_INPUT_NOT_SUBMITTED',
      severity: 'WARNING',
      steps: trailing.map((entry) => entry.index),
      message: `the flow ends with ${String(trailing.length)} input step(s) never submitted`,
      suggestion: 'record the save / search action, or add a checkpoint on the filled values',
      evidence: trailing.map((entry) => describeStepOf(entry.recorded.step)),
    });
  // 6. Aucune vérification finale.
  const checks = result.flow.steps.filter((entry) => entry.step.kind === 'expect').length;
  if (checks === 0 && result.flow.steps.length > 0)
    add({
      rule: 'NO_FINAL_CHECK',
      severity: 'WARNING',
      steps: [result.flow.steps.length],
      message:
        'the flow verifies nothing at the end: a replay that reaches the last step passes even if the result is wrong',
      suggestion: 'add a checkpoint during the recording (expected text, route, request)',
      evidence: [`${String(result.flow.assertions.length)} assertion candidate(s), none selected`],
    });
  return findings.map((finding, index) => ({ ...finding, id: `F${String(index + 1)}` }));
}

/**
 * Le conseiller relit le flow : il CONFIRME ou CONTESTE chaque constat (le constat déterministe reste
 * toujours, seul son statut d'avis change), puis signale l'étape la plus douteuse que les règles n'ont
 * pas vue (AI_PROPOSAL). Jamais appliqué.
 */
export async function auditGeneratedFlow(input: {
  result: RecordingResult;
  settings: FlowAuditSettings;
  intelligenceMode: string;
  gateway?: IntelligenceGateway;
  minProposalConfidence?: number;
}): Promise<FlowAuditReport> {
  const { result, settings } = input;
  const findings = settings.enabled ? deterministicFlowFindings(result) : [];
  const decisions: AiDecisionRecord[] = [];
  let aiCalls = 0;
  const minConfidence = input.minProposalConfidence ?? 0.6;
  const gateway =
    settings.enabled && settings.ai && input.intelligenceMode !== 'OFF' ? input.gateway : undefined;

  if (gateway && result.flow.steps.length > 0) {
    // Les étapes sont les candidates (A1…) ; les preuves, des faits d'interface (jamais une saisie).
    const candidates: DiscoveredCandidate[] = result.flow.steps.map((entry, position) => ({
      key: `step:${String(position + 1)}`,
      kind: entry.step.kind === 'fill' || entry.step.kind === 'select' ? 'fill' : 'click',
      name: `${String(position + 1)}. ${describeStepOf(entry.step)}${entry.semanticStatus === 'UNRESOLVED' ? ' (no observed effect)' : ''}`.slice(
        0,
        160,
      ),
      safety: 'SAFE',
      allowed: true,
    }));
    const evidence: Evidence[] = result.flow.steps.map((entry, position) => ({
      id: `E${String(position + 1)}`,
      type: 'HUMAN_RECORDING',
      source: `step ${String(position + 1)}`,
      confidence: 0.9,
      details: {
        step: describeStepOf(entry.step).slice(0, 160),
        provenance: entry.provenance,
        ...(entry.semanticStatus === 'UNRESOLVED' ? { effect: 'none observed' } : {}),
        ...('effects' in entry.step && entry.step.effects?.route ? { route: entry.step.effects.route } : {}),
      },
    }));
    const known = new Set(evidence.map((entry) => entry.id));
    const builder = new IntelligenceContextBuilder({
      maxActions: 40,
      maxEvidence: 40,
      maxHypotheses: 0,
      maxPlanSteps: 5,
    });
    const ask = async (
      question: string,
      scope: string,
    ): Promise<
      | { step?: number; statement?: string; confidence: number; status: string; record: AiDecisionRecord }
      | undefined
    > => {
      if (aiCalls >= settings.maxCalls) return undefined;
      const trigger = gateway.evaluate({ deterministicConfidence: 0.5, recordingAmbiguity: true });
      if (!trigger.shouldInvoke || !trigger.reason) return undefined;
      const built = builder.build(trigger.reason, {
        mission: result.flow.name,
        workflow: {
          previous: [],
          next: [],
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
          question,
        },
      });
      const consulted = await gateway.consult({
        context: 'RECORDING',
        request: built.request,
        scope: { action: `flow-audit|${result.session.id}|${scope}` },
        deterministic: { confidence: 0.5 },
        safety: () => ({ allowed: false, classification: 'ADVISORY', reason: 'a flow audit never executes' }),
        knownEvidence: (id) => known.has(id),
        advisory: true,
      });
      decisions.push(consulted.record);
      if (consulted.record.lifecycle.call) aiCalls += 1;
      const proposal = consulted.validation?.valid ? consulted.validation.proposal : undefined;
      if (!proposal) return { confidence: 0, status: 'INVALID', record: consulted.record };
      const key = proposal.selectedActionId ? built.keyOf(proposal.selectedActionId) : undefined;
      const step = key?.startsWith('step:') ? Number(key.slice(5)) : undefined;
      const statement = proposal.hypothesis?.statement ?? proposal.uncertainties.join('; ');
      return {
        ...(step !== undefined && Number.isInteger(step) ? { step } : {}),
        ...(statement ? { statement: statement.slice(0, 300) } : {}),
        confidence: proposal.confidence,
        status: proposal.status,
        record: consulted.record,
      };
    };

    // 1. Chaque constat sérieux : confirmé ou contesté (jamais retiré).
    for (const finding of findings.filter((entry) => entry.severity !== 'INFO')) {
      const answer = await ask(
        `AUDIT of a recorded test flow (never change it). A deterministic check reports ${finding.rule} on step(s) ${finding.steps.join(', ')}: ${finding.message}. If this is a real defect of the flow, select the step that should be changed (selectedActionId) and explain the defect and the fix in hypothesis.statement citing evidence IDs; if the flow is correct as recorded, answer INCONCLUSIVE.`,
        finding.id,
      );
      if (!answer) continue;
      finding.aiDecisionId = answer.record.id;
      finding.aiConfidence = answer.confidence;
      if (answer.statement) finding.aiStatement = answer.statement;
      finding.assessment =
        answer.status === 'PROPOSAL' &&
        answer.confidence >= minConfidence &&
        answer.step !== undefined &&
        finding.steps.includes(answer.step)
          ? 'AI_CONFIRMED'
          : answer.status === 'PROPOSAL' && answer.confidence >= minConfidence
            ? 'AI_DISPUTED'
            : 'AI_INCONCLUSIVE';
    }
    // 2. Une relecture globale : ce que les règles n'ont pas vu.
    const global = await ask(
      `AUDIT of a whole recorded test flow (never change it): ${String(result.flow.steps.length)} step(s), given as action IDs in order with their evidence. Look for incoherences: a step repeated for nothing, a step that cannot follow the previous one (target of another screen), a missing step (an input never submitted, a dialog never closed), a wrong order, a missing final check. Select the single most problematic step (selectedActionId) and describe the defect and the fix in hypothesis.statement citing evidence IDs; if the flow is coherent, answer INCONCLUSIVE.`,
      'global',
    );
    if (
      global?.status === 'PROPOSAL' &&
      global.step !== undefined &&
      global.confidence >= minConfidence &&
      !findings.some((finding) => finding.steps.includes(global.step ?? -1) && finding.severity !== 'INFO')
    )
      findings.push({
        id: `F${String(findings.length + 1)}`,
        rule: 'AI_FINDING',
        severity: 'WARNING',
        steps: [global.step],
        message: `the advisor flags step ${String(global.step)}: ${global.statement ?? 'no explanation'}`,
        suggestion: 'review this step: an AI hypothesis, never applied automatically',
        evidence: [],
        origin: 'AI_PROPOSAL',
        assessment: 'AI_PROPOSAL',
        aiDecisionId: global.record.id,
        aiConfidence: global.confidence,
        ...(global.statement ? { aiStatement: global.statement } : {}),
        reviewRequired: true,
      });
  }

  const count = (severity: FlowAuditSeverity): number =>
    findings.filter((finding) => finding.severity === severity).length;
  return {
    recordingId: result.session.id,
    flow: result.flow.name,
    steps: result.flow.steps.length,
    intelligenceMode: input.intelligenceMode,
    aiCalls,
    findings,
    summary: {
      errors: count('ERROR'),
      warnings: count('WARNING'),
      infos: count('INFO'),
      aiConfirmed: findings.filter((finding) => finding.assessment === 'AI_CONFIRMED').length,
      aiProposals: findings.filter((finding) => finding.origin === 'AI_PROPOSAL').length,
    },
    flowModified: false,
    decisions,
  };
}

/** Le rapport, en texte (flow-audit.txt). */
export function flowAuditText(report: FlowAuditReport): string[] {
  return [
    `FLOW AUDIT — ${report.flow} (${String(report.steps)} step(s), ${String(report.aiCalls)} AI call(s), flow never modified)`,
    `${String(report.summary.errors)} error(s), ${String(report.summary.warnings)} warning(s), ${String(report.summary.infos)} info(s); AI confirmed ${String(report.summary.aiConfirmed)}, AI proposals ${String(report.summary.aiProposals)}`,
    '',
    ...report.findings.flatMap((finding) => [
      `${finding.id} [${finding.severity}] ${finding.rule} — step(s) ${finding.steps.join(', ')} (${finding.origin}, ${finding.assessment})`,
      `  ${finding.message}`,
      `  → ${finding.suggestion}`,
      ...(finding.aiStatement ? [`  AI: ${finding.aiStatement}`] : []),
      '',
    ]),
  ];
}

/**
 * Les constats, en COMMENTAIRES au-dessus des étapes concernées du YAML (le contenu du flow ne change
 * pas : seules des lignes « # FLOW AUDIT … » s'ajoutent).
 */
export function annotateFlowYaml(yaml: string, report: FlowAuditReport): string {
  if (report.findings.length === 0) return yaml;
  const lines = yaml.split('\n');
  const stepsAt = lines.findIndex((line) => /^steps:\s*$/.test(line));
  if (stepsAt < 0) return yaml;
  // Le début de chaque étape : sa ligne « - kind: », remontée à ses commentaires.
  const starts: number[] = [];
  for (let index = stepsAt + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\S/.test(line)) break;
    if (/^ {2}- /.test(line)) {
      let start = index;
      while (start - 1 > stepsAt && /^ {2}#/.test(lines[start - 1] ?? '')) start -= 1;
      starts.push(start);
    }
  }
  const notes = new Map<number, string[]>();
  for (const finding of report.findings) {
    const first = finding.steps[0];
    if (first === undefined) continue;
    const line =
      `  # FLOW AUDIT ${finding.id} [${finding.severity}] ${finding.rule}${finding.assessment !== 'NOT_AUDITED' ? ` (${finding.assessment})` : ''}: ${finding.suggestion}`.replace(
        /\s+$/,
        '',
      );
    notes.set(first, [...(notes.get(first) ?? []), line]);
  }
  const out = [...lines];
  for (const step of [...notes.keys()].sort((a, b) => b - a)) {
    const at = starts[step - 1];
    if (at === undefined) continue;
    out.splice(at, 0, ...(notes.get(step) ?? []));
  }
  return out.join('\n');
}
