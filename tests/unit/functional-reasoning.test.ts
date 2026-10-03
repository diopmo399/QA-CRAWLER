import { describe, expect, it } from 'vitest';
import { CognitiveEngine } from '../../src/cognitive/cognitive-engine.js';
import { analyzeBlockedGoal, firstFunctionalDivergence } from '../../src/cognitive/functional-reasoning.js';
import type { FlowConfig } from '../../src/config/flow-schema.js';
import type { FlowStepReport } from '../../src/model/flow-run.js';
import type { UiElement, UiSnapshot } from '../../src/model/ui-snapshot.js';

const NOW = '2026-10-02T12:00:00Z';
const step = (kind: string, target: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ kind, target, optional: false, allow: [], ...extra }) as unknown as FlowConfig['steps'][number];
/** Le parcours démontré : choisir EUR, ouvrir la section entreprise, remplir, envoyer. */
const FLOW = {
  name: 'Create request',
  steps: [
    step('check', { strategy: 'label', value: 'EUR' }),
    step('click', { strategy: 'role', role: 'button', name: 'Company information' }),
    step('fill', { strategy: 'label', value: 'Company name' }, { value: 'x' }),
    step('fill', { strategy: 'label', value: 'Business number' }, { value: 'x' }),
    step('click', { strategy: 'role', role: 'button', name: 'Submit' }, { allow: ['MUTATION'] }),
  ],
};

const element = (role: string, name: string, extra: Partial<UiElement> = {}): UiElement =>
  ({
    index: 0,
    tag: role === 'textbox' ? 'input' : role === 'checkbox' ? 'input' : 'button',
    role,
    name,
    text: name,
    visible: true,
    disabled: false,
    readOnly: false,
    hasPopup: false,
    required: role === 'textbox',
    ...(role === 'checkbox' ? { inputType: 'checkbox' } : {}),
    ...extra,
  }) as UiElement;
const snapshot = (elements: UiElement[]): UiSnapshot => ({
  url: 'http://app.test/request',
  title: 'Request',
  headings: [],
  dialogs: [],
  selectedTabs: [],
  currentItems: [],
  textExcerpt: '',
  elements,
  forms: [],
});
/** L'écran prêt à l'envoi : EUR coché, champs remplis, bouton d'envoi actif. */
const READY = snapshot([
  element('checkbox', 'EUR', { checked: true, label: 'EUR' }),
  element('button', 'Company information'),
  element('textbox', 'Company name', { label: 'Company name', hasValue: true }),
  element('textbox', 'Business number', { label: 'Business number', hasValue: true }),
  element('button', 'Submit', { isSubmit: true }),
]);

function engine(): CognitiveEngine {
  const cognitive = new CognitiveEngine({
    runTag: 't',
    runtimeObservationsToConfirm: 2,
    maxHypotheses: 50,
    now: () => NOW,
  });
  cognitive.learnFlow(FLOW);
  return cognitive;
}

const report = (index: number, extra: Partial<FlowStepReport> = {}): FlowStepReport => ({
  index,
  kind: 'click',
  description: `step ${String(index)}`,
  status: 'PASSED',
  optional: false,
  durationMs: 1,
  ...extra,
});
const effect = (
  status: NonNullable<FlowStepReport['effect']>['status'],
  expected: string[] = [],
  observed: string[] = [],
) => ({
  execution: 'EXECUTED' as const,
  status,
  expected,
  observed,
  reasons: [`effect ${status}`],
  recovery: [],
});

describe('Functional reasoning: blocked goal, progress, first divergence, knowledge', () => {
  it('§47 CURRENT CASE: mission ready (submission READY) but still blocked — the engine says WHY, then UNKNOWN when the submit ran without effect', () => {
    const cognitive = engine();
    cognitive.observeScreen(READY, '/request');
    const pending = cognitive.blockedGoal();
    expect(pending).toMatchObject({
      goal: 'CREATE_REQUEST',
      node: 'CREATE_REQUEST_DONE',
      state: 'BLOCKED',
      unknownPrecondition: false,
      missingPreconditions: ['CREATE_REQUEST_SUBMITTED'],
    });
    expect(pending?.satisfiedPreconditions).toContain('CREATE_REQUEST_READY');
    expect(pending?.blockingReasons[0]).toMatch(
      /submit action "Submit" has not been executed and confirmed yet/,
    );
    expect(pending?.lastConfirmedCheckpoint).toBeDefined();
    // L'envoi a été fait, sans écriture acceptée : le moteur ne sait pas ce qui manque → UNKNOWN.
    cognitive.submissionAttempted({
      step: 'step 5',
      label: 'Submit',
      outcome: 'UNCONFIRMED',
      detail: 'no write observed',
    });
    const unknown = cognitive.blockedGoal();
    expect(unknown).toMatchObject({
      state: 'BLOCKED',
      unknownPrecondition: true,
      missingPreconditions: ['UNKNOWN'],
    });
    expect(unknown?.blockingReasons[0]).toMatch(
      /submission READY and "Submit" executed at step 5, but no accepted write/,
    );
    expect(unknown?.confidence).toBeLessThan(0.6);
    // Ce que le conseiller recevra : l'état fonctionnel, pas seulement « blocked ».
    const functional = cognitive.functionalContext({ question: 'why?' });
    expect(functional).toMatchObject({
      currentGoal: 'CREATE_REQUEST_DONE',
      missingPreconditions: ['UNKNOWN'],
      unknownPrecondition: true,
      question: 'why?',
    });
    expect(functional.satisfiedPreconditions).toContain('CREATE_REQUEST_READY');
    expect(functional.goalProgress).toBeGreaterThan(0.5);
    expect(functional.goalProgress).toBeLessThan(1);
  });

  it('an accepted submission ACHIEVES the mission: the goal is no longer blocked (before: blocked forever)', () => {
    const cognitive = engine();
    cognitive.observeScreen(READY, '/request');
    cognitive.submissionSucceeded('step 5', 'Submit');
    expect(cognitive.blockedGoal()?.state).toBe('SATISFIED');
    expect(cognitive.goalProgress()?.progress).toBe(1);
  });

  it('§18-19 GOAL PROGRESS: preconditions and checkpoints, not the URL — 0 → partial → ready', () => {
    const cognitive = engine();
    cognitive.observeScreen(
      snapshot([element('checkbox', 'EUR', { checked: false, label: 'EUR' })]),
      '/request',
    );
    const start = cognitive.goalProgress()?.progress ?? 0;
    cognitive.observeScreen(
      snapshot([
        element('checkbox', 'EUR', { checked: true, label: 'EUR' }),
        element('button', 'Company information'),
        element('textbox', 'Company name', { label: 'Company name', hasValue: true }),
        element('textbox', 'Business number', { label: 'Business number', hasValue: false }),
        element('button', 'Submit', { isSubmit: true, disabled: true }),
      ]),
      '/request',
    );
    const partial = cognitive.goalProgress()?.progress ?? 0;
    cognitive.observeScreen(READY, '/request');
    const ready = cognitive.goalProgress()?.progress ?? 0;
    expect(partial).toBeGreaterThan(start);
    expect(ready).toBeGreaterThan(partial);
    expect(cognitive.summary().progressTimeline.length).toBeGreaterThanOrEqual(2);
  });

  it('§31 FIRST FUNCTIONAL DIVERGENCE: step 4 failed, but step 2 expected the company section and it never came', () => {
    const steps = [
      report(1, { effect: effect('CONFIRMED') }),
      report(2, {
        description: 'click "Company information"',
        effect: effect('NO_EFFECT', ['textbox:company name'], []),
      }),
      report(3, { effect: effect('NOT_REQUIRED') }),
      report(4, { status: 'FAILED', reason: 'element not found: Business number' }),
    ];
    expect(firstFunctionalDivergence(steps)).toMatchObject({
      step: 2,
      kind: 'EFFECT_MISSING',
      expected: ['textbox:company name'],
      lastFailedStep: 4,
      lastConfirmedStep: 1,
      rootBeforeSymptom: true,
    });
    // Sans divergence plus tôt, l'échec lui-même est la divergence.
    expect(
      firstFunctionalDivergence([report(1), report(2, { status: 'FAILED', reason: 'x' })]),
    ).toMatchObject({
      step: 2,
      kind: 'STEP_FAILED',
      rootBeforeSymptom: false,
    });
    expect(firstFunctionalDivergence([report(1), report(2)])).toBeUndefined();
  });

  it('§30 FAILURE CONTEXT: a classified failure is linked to the goal, the checkpoint reached and the one expected', () => {
    const cognitive = engine();
    cognitive.observeScreen(READY, '/request');
    cognitive.understand({ effectMissing: true, message: 'nothing created' }, 'step 5 "Submit"');
    const failure = cognitive.summary().failures[0];
    expect(failure).toMatchObject({
      class: 'FUNCTIONAL_FAILURE',
      context: { affectedGoal: 'CREATE_REQUEST' },
    });
    expect(failure?.context?.observed).toMatch(/submission READY/);
  });

  it('§17 / §27 an AI hypothesis stays a hypothesis (origin AI_PROPOSAL, capped); runtime evidence supports or contradicts it', () => {
    const cognitive = engine();
    const hypothesis = cognitive.recordAiHypothesis(
      'A final Apply action may still be required before creation.',
      [],
      'AI-00017',
      {
        type: 'WORKFLOW_PRECONDITION',
      },
    );
    expect(hypothesis.status).toBe('HYPOTHESIS');
    expect(hypothesis.confidence).toBeLessThanOrEqual(0.3);
    const detail = cognitive.hypothesisDetails().find((entry) => entry.id === hypothesis.id);
    expect(detail).toMatchObject({
      type: 'WORKFLOW_PRECONDITION',
      origin: 'AI_PROPOSAL',
      aiDecisionId: 'AI-00017',
      runtimeConfirmed: false,
      status: 'HYPOTHESIS',
    });
    expect(detail?.createdAt).toBe(NOW);
    const contradicted = cognitive.aiHypothesisRuntime(
      hypothesis.id,
      false,
      'expected CREATE_REQUEST_DONE; nothing changed',
    );
    expect(['CONTRADICTED', 'REJECTED']).toContain(contradicted?.status);
    // §28 : contredite, elle ne disparaît pas — pourquoi, alternatives, investigation.
    const analysis = cognitive.contradictedAnalysis().find((entry) => entry.id === hypothesis.id);
    expect(analysis?.why).toMatch(/nothing changed/);
    expect(analysis?.alternatives).toEqual([]);
    expect(analysis?.needsAnalysis).toBe(true);
  });

  it('§39 RECORDING CANDIDATE on replay: observed → supported by runtime evidence; absent → contradicted', () => {
    const cognitive = engine();
    const confirmed = cognitive.registerRecordingCandidate({
      id: 'RK-1',
      statement: 'click "Company information" reveals "Company name"',
      sourceRecording: 'rec-1',
      aiDecisionId: 'AI-00002',
      observable: { action: 'click company information', effect: 'textbox:company name' },
    });
    const missed = cognitive.registerRecordingCandidate({
      id: 'RK-2',
      statement: 'check "EUR" reveals "Tax code"',
      sourceRecording: 'rec-1',
      observable: { action: 'check eur', effect: 'textbox:tax code' },
    });
    expect(confirmed.status).toBe('HYPOTHESIS');
    cognitive.observeAction({
      kind: 'click',
      label: 'Company information',
      before: snapshot([element('button', 'Company information')]),
      after: snapshot([
        element('button', 'Company information'),
        element('textbox', 'Company name', { label: 'Company name' }),
      ]),
      beforeRoute: '/request',
      afterRoute: '/request',
      requests: [],
      source: 'replay',
    });
    cognitive.observeAction({
      kind: 'check',
      label: 'EUR',
      before: snapshot([]),
      after: snapshot([element('button', 'Company information')]),
      beforeRoute: '/request',
      afterRoute: '/request',
      requests: [],
      source: 'replay',
    });
    const results = Object.fromEntries(
      cognitive.recordingConfirmations().map((entry) => [entry.candidate, entry.result]),
    );
    expect(results).toEqual({ 'RK-1': 'RUNTIME_CONFIRMED', 'RK-2': 'CONTRADICTED' });
    const details = new Map(cognitive.hypothesisDetails().map((entry) => [entry.id, entry]));
    expect(details.get(confirmed.id)).toMatchObject({
      origin: 'AI_PROPOSAL',
      sourceRecording: 'rec-1',
      runtimeConfirmed: true,
    });
    // Jamais « confirmée » sur la foi de l'IA seule : soutenue par le runtime, au mieux.
    expect(details.get(confirmed.id)?.status).not.toBe('HYPOTHESIS');
    expect(['CONTRADICTED', 'REJECTED']).toContain(details.get(missed.id)?.status);
  });

  it('analyzeBlockedGoal without a demonstrated submit: the precondition is UNKNOWN', () => {
    const cognitive = new CognitiveEngine({
      runTag: 't',
      runtimeObservationsToConfirm: 2,
      maxHypotheses: 50,
      now: () => NOW,
    });
    cognitive.learnFlow({ name: 'Create request', steps: FLOW.steps.slice(0, 4) });
    cognitive.observeScreen(READY, '/request');
    const analysis = analyzeBlockedGoal({
      graph: cognitive.goalGraph(),
      context: { achieved: new Set() },
      checkpoints: new Map(),
      hypotheses: [],
      submits: [],
      failures: [],
    });
    // Sans écran connu ici, le moteur avoue ne pas savoir.
    expect(analysis?.unknownPrecondition).toBe(true);
    expect(analysis?.missingPreconditions).toContain('UNKNOWN');
  });
});
