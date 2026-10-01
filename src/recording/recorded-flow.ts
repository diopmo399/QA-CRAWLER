import type { FlowAllowance, FlowStep, FlowTarget, FlowValue } from '../config/flow-schema.js';
import type { SuggestedFlowGraph } from '../dry-run/reconciliation-model.js';
import { suggestedFeature, suggestedFlowYaml } from '../dry-run/suggested-flow.js';
import type { GherkinIntent } from '../semantics/resolution/intent.js';
import {
  emptyQuality,
  type AssertionCandidate,
  type RecordedFlow,
  type RecordedFlowStep,
  type RecordedIntent,
  type RecordingWarning,
  type SemanticRecordedAction,
} from './model.js';
import { isWrite, protectedAction, type NormalizationStats } from './normalizer.js';
import { selectedExpectations } from './outcomes.js';
import { readable } from './recorded-target.js';

const SENTENCE_ROLES = new Set(['button', 'link', 'tab', 'menuitem']);

export interface BuildRecordedFlowInput {
  name: string;
  recordingSessionId: string;
  startRoute: string;
  kept: readonly SemanticRecordedAction[];
  assertions: AssertionCandidate[];
  intent: RecordedIntent;
  negative: boolean;
  stats: NormalizationStats;
}

/**
 * SEMANTIC → FINAL : le RecordedFlow, la représentation intermédiaire UNIQUE. Chaque
 * étape est une étape du schéma des flows imposés (goto / click / fill / select / check /
 * expect), avec une cible qu'une phrase Gherkin sait dire (libellé, rôle + nom, texte) ;
 * sinon une intention (le SemanticResolver la retrouve au rejeu). Les valeurs saisies
 * sont des { testData }, les secrets des { env } : jamais une saisie.
 */
export function buildRecordedFlow(input: BuildRecordedFlowInput): {
  flow: RecordedFlow;
  warnings: RecordingWarning[];
} {
  const steps: RecordedFlowStep[] = [];
  const warnings: RecordingWarning[] = [];
  const quality = emptyQuality();
  quality.removedNoise = input.stats.removedNoise;
  quality.mergedInputs = input.stats.mergedInputs;
  quality.collapsedCorrections = input.stats.collapsedCorrections;
  quality.removedDetours = input.stats.removedDetours;
  quality.values.PREEXISTING_VALUE = input.stats.preexistingValues;
  let first = true;
  const push = (step: RecordedFlowStep): void => {
    steps.push({ ...step, id: `s${String(steps.length + 1)}` });
  };
  for (const action of input.kept) {
    const raw = action.rawEventIds;
    if (action.type === 'NAVIGATE') {
      if (first) {
        first = false;
        continue;
      }
      if (!action.route) continue;
      push({
        id: '',
        step: { kind: 'goto', url: action.route, allow: [], optional: false },
        label: `go to ${action.route}`,
        actionIds: [action.id],
        rawEventIds: raw,
        provenance: action.provenance,
        confidence: action.confidence,
        explanation: `goto generated: ${action.gotoReason ?? 'NO_CAUSAL_ACTION'} · ${action.evidence.slice(1).join('; ') || 'no human action caused this navigation'}`,
      });
      continue;
    }
    first = false;
    const step = stepOf(action);
    if (step) {
      if (action.target) {
        quality.locators[action.target.quality] += 1;
        if (action.target.ambiguous) quality.ambiguousTargets += 1;
        if (action.target.quality === 'FRAGILE') quality.fragileLocators += 1;
      }
      if (action.value && action.value.class !== 'PREEXISTING_VALUE') {
        quality.values[action.value.class] += 1;
        if (action.value.sensitive) quality.sensitiveRedacted += 1;
      }
      if (
        step.kind === 'click' ||
        step.kind === 'fill' ||
        step.kind === 'select' ||
        step.kind === 'check' ||
        step.kind === 'uncheck'
      ) {
        if (!gherkinTarget(step))
          warnings.push({
            code: 'FRAGILE_LOCATOR',
            message: `"${action.target?.label ?? action.type}" can only be located by a selector: the .feature keeps it as a comment`,
            actionId: action.id,
          });
      }
      push({
        id: '',
        step,
        label: labelOf(action),
        actionIds: [action.id],
        rawEventIds: raw,
        provenance: action.provenance,
        confidence: action.confidence,
        ...(action.target ? { quality: action.target.quality } : {}),
        ...(action.value ? { valueClass: action.value.class } : {}),
        explanation: explanationOf(action),
      });
    }
    for (const { candidate, expect } of selectedExpectations(input.assertions, action.id)) {
      push({
        id: '',
        step: { kind: 'expect', expect, allow: [], optional: false },
        label: candidate.description,
        actionIds: [action.id],
        rawEventIds: raw,
        provenance: candidate.provenance,
        confidence: candidate.confidence,
        explanation: `${candidate.kind} · ${candidate.stability} · ${candidate.reason}`,
      });
    }
  }
  quality.steps = steps.length;
  quality.assertions = {
    stable: input.assertions.filter((candidate) => candidate.stability === 'STABLE').length,
    selected: input.assertions.filter((candidate) => candidate.selected).length,
    fragile: input.assertions.filter((candidate) => candidate.stability === 'FRAGILE').length,
  };
  return {
    flow: {
      name: input.name,
      recordingSessionId: input.recordingSessionId,
      startAt: input.startRoute,
      steps,
      assertions: input.assertions,
      intent: input.intent,
      negative: input.negative,
      quality,
    },
    warnings,
  };
}

function allowOf(action: SemanticRecordedAction): FlowAllowance[] {
  const writes = action.network.some((exchange) => isWrite(exchange.method)) || protectedAction(action);
  if (action.classification === 'DANGEROUS') return ['DANGEROUS'];
  if (action.classification === 'MUTATION' || action.type === 'SUBMIT' || writes) return ['MUTATION'];
  if (action.classification === 'UNKNOWN') return ['UNKNOWN'];
  return [];
}

/** Une action → une étape de flow (undefined : rien à rejouer, comme un dialogue du navigateur). */
function stepOf(action: SemanticRecordedAction): FlowStep | undefined {
  const target = action.target?.target;
  const common = { allow: allowOf(action), optional: false };
  const label = labelOf(action);
  // Un élément sans nom (« input ») : son sélecteur, jamais une intention vide de sens.
  const named = action.target?.named === true;
  switch (action.type) {
    case 'CLICK':
    case 'SUBMIT': {
      if (!target) return undefined;
      const step: FlowStep = { ...common, kind: 'click', target };
      return gherkinTarget(step) || !named || !readable(label)
        ? step
        : intentStep(common, { kind: 'CLICK', target: label });
    }
    case 'FILL': {
      if (!target || !action.value) return undefined;
      const value = valueOf(action);
      const step: FlowStep = { ...common, allow: [], kind: 'fill', target, value };
      return gherkinTarget(step) || !named || !readable(label)
        ? step
        : intentStep({ ...common, allow: [] }, { kind: 'FILL', field: label, value });
    }
    case 'SELECT': {
      if (!target || action.option === undefined) return undefined;
      const step: FlowStep = { ...common, kind: 'select', target, option: action.option };
      return gherkinTarget(step) || !named || !readable(label)
        ? step
        : intentStep(common, { kind: 'SELECT', field: label, option: action.option });
    }
    case 'CHECK':
    case 'UNCHECK': {
      if (!target) return undefined;
      const step: FlowStep = { ...common, kind: action.type === 'CHECK' ? 'check' : 'uncheck', target };
      return gherkinTarget(step) || !named || !readable(label)
        ? step
        : intentStep(common, { kind: 'CHECK', field: label, checked: action.type === 'CHECK' });
    }
    case 'UPLOAD':
      return named && readable(label)
        ? intentStep(common, { kind: 'UPLOAD', field: label, file: '' })
        : undefined;
    default:
      return undefined;
  }
}

function intentStep(common: { allow: FlowAllowance[]; optional: boolean }, intent: GherkinIntent): FlowStep {
  return { ...common, kind: 'intent', intent };
}

function valueOf(action: SemanticRecordedAction): FlowValue {
  const value = action.value;
  if (!value) return '';
  if (value.env) return { env: value.env };
  if (value.testData) return { testData: value.testData };
  return value.literal ?? '';
}

/** La cible se dit-elle en Gherkin (et redonne-t-elle la même cible à la relecture) ? */
export function gherkinTarget(step: FlowStep): boolean {
  if (!('target' in step)) return true;
  const target: FlowTarget = step.target;
  if (target.nth !== undefined || target.exact !== undefined) return false;
  switch (step.kind) {
    case 'click':
      return (
        (target.strategy === 'role' && SENTENCE_ROLES.has(target.role ?? '') && target.name !== undefined) ||
        target.strategy === 'text'
      );
    case 'fill':
    case 'select':
      return target.strategy === 'label';
    case 'check':
    case 'uncheck':
      return (
        target.strategy === 'label' ||
        (target.strategy === 'role' && (target.role === 'checkbox' || target.role === 'radio'))
      );
    default:
      return true;
  }
}

function labelOf(action: SemanticRecordedAction): string {
  return action.target?.label ?? action.route ?? action.type;
}

function explanationOf(action: SemanticRecordedAction): string {
  const parts = [
    `${action.type} from ${String(action.rawEventIds.length)} raw event(s)`,
    ...(action.target ? [`target ${action.target.quality}: ${action.target.reasons[0] ?? ''}`] : []),
    ...(action.value ? [`value ${action.value.class}: ${action.value.reason}`] : []),
    ...(action.merged ? [`normalized: ${action.merged}`] : []),
    ...(action.navigation
      ? [
          `navigation effect → ${action.navigation.routes.join(' → ')} (${action.navigation.confidence}: ${action.navigation.reasons.join(', ')})`,
        ]
      : []),
    ...(action.classification && action.classification !== 'SAFE'
      ? [`safety: ${action.classification}`]
      : []),
  ];
  return parts.join(' · ');
}

/** Le RecordedFlow vu comme un flow suggéré : les générateurs YAML et Gherkin existants en font les fichiers. */
export function toSuggestedFlow(flow: RecordedFlow): SuggestedFlowGraph {
  return {
    name: flow.name,
    source: { type: 'YAML' },
    startAt: flow.startAt,
    // Un flow enregistré n'est pas une réconciliation : le statut n'est pas affiché (chaque étape a son commentaire).
    status: 'FULLY_MATCHED',
    steps: flow.steps.map((item) => ({
      provenance: item.provenance,
      status: 'MATCHED',
      step: item.step,
      label: item.label,
      comment: [
        item.provenance,
        ...(item.quality ? [item.quality] : []),
        ...(item.valueClass ? [item.valueClass] : []),
        `raw ${item.rawEventIds.join(',')}`,
      ].join(' · '),
    })),
  };
}

export interface GeneratedFiles {
  yaml: string;
  feature: string;
}

/** flow.yaml et .feature, depuis la même représentation. */
export function generateFlowFiles(
  flow: RecordedFlow,
  options: { language: 'fr' | 'en'; recordedAt: string; testDataFile?: string },
): GeneratedFiles {
  const suggested = toSuggestedFlow(flow);
  const header = [
    `Recorded by QA-CRAWLER (human flow recorder), session ${flow.recordingSessionId}, ${options.recordedAt}`,
    options.testDataFile
      ? `Data in ${options.testDataFile} (recorded, generated at replay or business literals); secrets come from { env }, never from the file.`
      : 'Typed values are never recorded: { testData } is a valid value chosen at replay, secrets come from { env }.',
    ...(flow.intent.workflow
      ? [`Intent: ${flow.intent.workflow}${flow.intent.api ? ` (${flow.intent.api})` : ''}`]
      : []),
    ...(flow.negative ? ['Negative validation flow: the refusal was shown on purpose (checkpoint).'] : []),
    'Review before use. The safety policy still applies when it is replayed.',
  ];
  return {
    yaml: suggestedFlowYaml(suggested, header, options.testDataFile),
    // `# testData: …` en tête du .feature : le même jeu de données que le flow YAML.
    feature: suggestedFeature(suggested, {
      language: options.language,
      header: options.testDataFile ? [`testData: ${options.testDataFile}`, ...header] : header,
    }),
  };
}
