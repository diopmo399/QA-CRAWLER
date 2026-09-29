import type { FlowStep } from '../src/config/flow-schema.js';
import type {
  DryRunCandidate,
  DryRunDriver,
  KnownPath,
  PerformResult,
  ProbeResult,
  TakeResult,
} from '../src/dry-run/dry-run-driver.js';
import type { FlowIntent, FlowIntentGraph, FlowIntentType } from '../src/dry-run/flow-intent-graph.js';
import type { ObservedState } from '../src/dry-run/reconciliation-model.js';
import { slug } from '../src/knowledge/signatures.js';
import type { ActionCategory, ActionClassification } from '../src/model/discovered-action.js';

/**
 * APPLICATION SYNTHÉTIQUE pour le Dry Run : des écrans, des actions qui mènent d'un
 * écran à l'autre, des textes visibles. Implémente DryRunDriver comme le fait le
 * FlowExplorer, sans navigateur ; garde la trace de chaque action exécutée.
 */
export interface SyntheticAction {
  label: string;
  to: string;
  category?: ActionCategory;
  classification?: ActionClassification;
  role?: string;
  /** Refusée par la SafetyPolicy, avec cette raison. */
  blocked?: string;
  formFields?: string[];
}

export interface SyntheticScreen {
  label: string;
  actions?: SyntheticAction[];
  texts?: string[];
  fields?: string[];
}

export class SyntheticApp implements DryRunDriver {
  /** Libellés des actions réellement exécutées, dans l'ordre. */
  readonly executed: string[] = [];
  private screen: string;
  private clock = 0;

  constructor(
    private readonly screens: Record<string, SyntheticScreen>,
    private readonly startScreen: string,
    private readonly options: {
      history?: Record<string, KnownPath[]>;
      msPerAction?: number;
      historicalObservations?: Record<string, number>;
    } = {},
  ) {
    this.screen = startScreen;
    // La mémoire n'existe que si le test en donne une (sinon : mémoire désactivée).
    const history = options.historicalObservations;
    if (history) this.historicalObservations = (target) => history[target.semanticTarget] ?? 0;
  }

  historicalObservations?: (target: FlowIntent) => number;

  start(): Promise<ObservedState | undefined> {
    this.screen = this.startScreen;
    return Promise.resolve(this.current());
  }

  current(): ObservedState {
    const screen = this.screens[this.screen];
    return {
      id: this.screen,
      signature: slug(screen?.label ?? this.screen),
      label: screen?.label ?? '',
      url: `/${this.screen}`,
    };
  }

  probe(intent: FlowIntent): Promise<ProbeResult> {
    const screen = this.screens[this.screen];
    if (!screen) return Promise.resolve({ status: 'NOT_FOUND', reason: 'no screen', confidence: 0 });
    if (intent.type === 'ASSERT') {
      const visible = (screen.texts ?? []).some((text) => slug(text) === intent.semanticTarget);
      return Promise.resolve(
        visible
          ? { status: 'RESOLVED', target: intent.label, reason: 'text visible', confidence: 1 }
          : { status: 'NOT_FOUND', reason: 'text not visible', confidence: 0 },
      );
    }
    if (intent.type === 'FILL' || intent.type === 'SELECT' || intent.type === 'CHECK') {
      const found = (screen.fields ?? []).some((field) => slug(field) === intent.semanticTarget);
      return Promise.resolve(
        found
          ? { status: 'RESOLVED', target: intent.label, reason: 'field found', confidence: 0.95 }
          : { status: 'NOT_FOUND', reason: 'no such field', confidence: 0 },
      );
    }
    // Une adresse (goto) : toujours possible, elle ramène à l'écran de départ.
    if (intent.type === 'NAVIGATE' && intent.label.startsWith('/'))
      return Promise.resolve({ status: 'RESOLVED', target: intent.label, reason: 'address', confidence: 1 });
    if (intent.type === 'NAVIGATE' && slug(screen.label) === intent.semanticTarget)
      return Promise.resolve({
        status: 'RESOLVED',
        target: screen.label,
        reason: 'already there',
        confidence: 1,
      });
    const matches = (screen.actions ?? []).filter((action) => slug(action.label) === intent.semanticTarget);
    if (matches.length > 1)
      return Promise.resolve({
        status: 'AMBIGUOUS',
        reason: `${String(matches.length)} controls named "${intent.label}"`,
        confidence: 0.5,
      });
    const [match] = matches;
    if (!match) return Promise.resolve({ status: 'NOT_FOUND', reason: 'not on this screen', confidence: 0 });
    if (match.blocked)
      return Promise.resolve({
        status: 'BLOCKED',
        target: match.label,
        reason: match.blocked,
        confidence: 0.9,
      });
    return Promise.resolve({
      status: 'RESOLVED',
      target: match.label,
      reason: 'control found',
      confidence: 0.97,
    });
  }

  async perform(intent: FlowIntent): Promise<PerformResult> {
    const probe = await this.probe(intent);
    if (intent.type === 'CUSTOM')
      return { status: 'NOT_VERIFIED', state: this.current(), reason: 'custom sentence', confidence: 0 };
    if (probe.status === 'BLOCKED')
      return { status: 'BLOCKED', state: this.current(), reason: probe.reason, confidence: 0 };
    if (probe.status !== 'RESOLVED')
      return { status: 'FAILED', state: this.current(), reason: probe.reason, confidence: 0 };
    const action = (this.screens[this.screen]?.actions ?? []).find(
      (candidate) => slug(candidate.label) === intent.semanticTarget,
    );
    if (intent.type === 'NAVIGATE' && intent.label.startsWith('/')) this.screen = this.startScreen;
    else if (action && intent.type !== 'ASSERT' && intent.type !== 'FILL') {
      this.executed.push(action.label);
      this.screen = action.to;
    }
    return {
      status: 'PASSED',
      state: this.current(),
      target: probe.target,
      reason: probe.reason,
      confidence: probe.confidence,
    };
  }

  actions(): DryRunCandidate[] {
    return (this.screens[this.screen]?.actions ?? []).map((action) => ({
      id: `${this.screen}:${action.label}`,
      signature: `click:${slug(action.label)}`,
      label: action.label,
      type: 'click',
      category: action.category ?? 'navigation',
      classification: action.classification ?? 'SAFE',
      ...(action.role ? { role: action.role } : {}),
      verdict: action.blocked ? 'BLOCK' : 'ALLOW',
      reason: action.blocked ?? 'allowed',
      score: 50,
      ...(action.formFields ? { formFields: action.formFields } : {}),
    }));
  }

  take(actionId: string): Promise<TakeResult> {
    const action = (this.screens[this.screen]?.actions ?? []).find(
      (candidate) => `${this.screen}:${candidate.label}` === actionId,
    );
    this.clock += this.options.msPerAction ?? 10;
    if (!action)
      return Promise.resolve({ status: 'FAILED', state: this.current(), reason: 'no such action' });
    // La SafetyPolicy passe avant l'exécution : une action refusée n'est jamais exécutée.
    if (action.blocked)
      return Promise.resolve({ status: 'BLOCKED', state: this.current(), reason: action.blocked });
    this.executed.push(action.label);
    this.screen = action.to;
    return Promise.resolve({
      status: 'SUCCESS',
      state: this.current(),
      ...(action.formFields ? { formFields: action.formFields } : {}),
    });
  }

  restore(stateId: string): Promise<ObservedState | undefined> {
    if (!this.screens[stateId]) return Promise.resolve(undefined);
    this.screen = stateId;
    return Promise.resolve(this.current());
  }

  knownPaths(target: FlowIntent): KnownPath[] {
    return [...(this.options.history?.[`${this.screen}>${target.semanticTarget}`] ?? [])];
  }

  seenDuringRun(target: FlowIntent): boolean {
    return Object.values(this.screens).some((screen) =>
      (screen.actions ?? []).some((action) => slug(action.label) === target.semanticTarget),
    );
  }

  now(): number {
    return this.clock;
  }
}

/** Un flow attendu, écrit directement en intentions (pour les tests du moteur). */
export function expectedFlow(name: string, intents: [FlowIntentType, string][]): FlowIntentGraph {
  return {
    id: slug(name),
    name,
    source: { type: 'YAML' },
    intents: intents.map(([type, label], position) => ({
      id: `${slug(name)}#${String(position + 1)}`,
      index: position + 1,
      type,
      semanticTarget: slug(label),
      label,
      required: true,
      sourceReference: { step: position + 1, text: `${type} ${label}` },
      step: stepFor(type, label),
      allow: [],
    })),
  };
}

function stepFor(type: FlowIntentType, label: string): FlowStep {
  const common = { allow: [], optional: false };
  if (type === 'ASSERT') return { ...common, kind: 'expect', expect: { text: label } };
  if (type === 'FILL')
    return { ...common, kind: 'fill', target: { strategy: 'label', value: label }, value: 'x' };
  return { ...common, kind: 'click', target: { strategy: 'text', value: label } };
}

export const UNLIMITED = {
  maxDepth: 15,
  maxActions: 100,
  maxDurationMs: 120_000,
  maxAlternativePaths: 5,
  useHistoricalKnowledge: true,
};
