import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FunctionalKnowledgeStore } from '../../src/knowledge/functional-knowledge-store.js';
import {
  REVIEWABLE_INTENTS,
  applyHumanReview,
  emptyLedger,
  finalIntentOf,
  recordIntentDecision,
} from '../../src/recording/application/human-review.js';
import {
  BUSINESS_ACTION_KINDS,
  type ActionView,
  type ApplicationInteractionModel,
} from '../../src/recording/application/model.js';

/**
 * LA REVUE HUMAINE DES INTENTIONS : une décision s'AJOUTE à l'interprétation automatique, jamais ne
 * la remplace ; le registre est en ajout seul ; une décision humaine en vigueur l'emporte sur toute
 * nouvelle analyse (règles ou IA), qui ne reste qu'une proposition.
 */
function modelWith(
  interpretation: ActionView['interpretation'] = ['FILTER'],
  confidence = 0.6,
): ApplicationInteractionModel {
  return {
    actions: [
      {
        actionId: 'a7',
        type: 'click',
        label: 'Search',
        stepIds: ['s7'],
        recorded: true,
        validation: 'VALIDATED',
        validationStatus: 'VALIDATED_PRE_ACTION',
        interpretation,
        confidence,
      },
      {
        actionId: 'a8',
        type: 'fill',
        stepIds: ['s8'],
        recorded: true,
        validation: 'VALIDATED',
        interpretation: ['UNKNOWN'],
      },
    ],
    evidence: [
      {
        id: 'e1',
        source: 'NETWORK',
        description: 'POST /api/items/query 200',
        actionIds: ['a7'],
        rawEventIds: ['r9'],
        stateIds: [],
      },
    ],
    summary: { actions: { recorded: 2, validated: 2, interpreted: 1, uninterpreted: 1 } },
  } as unknown as ApplicationInteractionModel;
}
const context = { page: '/workbench', element: 'button "Search"', role: 'button', selector: '#run' };
const at = (minute: number): string => `2026-10-10T13:${String(minute).padStart(2, '0')}:00.000Z`;

describe('Human review of action intents', () => {
  it("one list of intents: the model's business action kinds, plus UNKNOWN — no parallel list", () => {
    expect(REVIEWABLE_INTENTS).toEqual([...BUSINESS_ACTION_KINDS, 'UNKNOWN']);
  });

  it('FILTER → SEARCH: final SEARCH, source HUMAN, status HUMAN_CORRECTED; the automatic interpretation and its confidence stay', () => {
    const model = modelWith();
    const ledger = emptyLedger('rec-1');
    const outcome = recordIntentDecision(ledger, model, {
      actionId: 'a7',
      type: 'CORRECT',
      intent: 'SEARCH',
      reason: 'Le bouton lance la recherche sur les critères saisis.',
      at: at(21),
      context,
    });
    expect('decision' in outcome).toBe(true);
    applyHumanReview(model, ledger);
    const view = model.actions[0];
    expect(view?.interpretation).toEqual(['FILTER']);
    expect(view?.confidence).toBe(0.6);
    expect(view?.review).toMatchObject({
      status: 'HUMAN_CORRECTED',
      source: 'HUMAN',
      finalIntent: 'SEARCH',
      originalIntent: ['FILTER'],
      originalConfidence: 0.6,
      correction: { intent: 'SEARCH', reason: 'Le bouton lance la recherche sur les critères saisis.' },
    });
    // La provenance n'est pas une confiance : aucune confiance 100 % n'est inventée.
    expect(JSON.stringify(view?.review)).not.toContain('"confidence":1');
    expect(finalIntentOf(model, 'a7')).toEqual({
      intent: ['SEARCH'],
      source: 'HUMAN',
      status: 'HUMAN_CORRECTED',
    });
    // La décision est une PREUVE humaine ; les preuves observées restent.
    expect(model.evidence.map((entry) => `${entry.source}:${entry.kind ?? ''}`)).toEqual([
      'NETWORK:',
      'HUMAN:INTENT_CORRECTION',
    ]);
    expect(ledger.decisions[0]).toMatchObject({
      previousIntent: ['FILTER'],
      newIntent: ['SEARCH'],
      systemIntent: ['FILTER'],
      context,
    });
    expect(model.summary.actions).toMatchObject({ humanCorrected: 1, humanConfirmed: 0 });
  });

  it('several corrections FILTER → SEARCH → OPEN → SEARCH: nothing lost, the original stays FILTER', () => {
    const model = modelWith();
    const ledger = emptyLedger();
    for (const [minute, intent] of [
      [21, 'SEARCH'],
      [22, 'OPEN'],
      [23, 'SEARCH'],
    ] as const)
      recordIntentDecision(ledger, model, { actionId: 'a7', type: 'CORRECT', intent, at: at(minute) });
    applyHumanReview(model, ledger);
    expect(
      ledger.decisions.map((decision) => `${decision.previousIntent.join()}→${decision.newIntent.join()}`),
    ).toEqual(['FILTER→SEARCH', 'SEARCH→OPEN', 'OPEN→SEARCH']);
    expect(model.actions[0]?.review?.originalIntent).toEqual(['FILTER']);
    expect(
      model.actions[0]?.review?.history.map((entry) => `${entry.source}:${entry.intent.join()}`),
    ).toEqual(['SYSTEM:FILTER', 'HUMAN:SEARCH', 'HUMAN:OPEN', 'HUMAN:SEARCH']);
    expect(model.evidence.filter((entry) => entry.source === 'HUMAN')).toHaveLength(3);
  });

  it('reset FILTER → SEARCH → RESET → FILTER: the automatic interpretation is back, the history is kept', () => {
    const model = modelWith();
    const ledger = emptyLedger();
    recordIntentDecision(ledger, model, { actionId: 'a7', type: 'CORRECT', intent: 'SEARCH', at: at(21) });
    recordIntentDecision(ledger, model, { actionId: 'a7', type: 'RESET', at: at(25) });
    applyHumanReview(model, ledger);
    expect(model.actions[0]?.review).toMatchObject({
      status: 'INFERRED',
      source: 'SYSTEM',
      finalIntent: 'FILTER',
      originalIntent: ['FILTER'],
    });
    expect(model.actions[0]?.review?.correction).toBeUndefined();
    expect(
      model.actions[0]?.review?.history.map(
        (entry) => `${entry.at.slice(11, 16)} ${entry.source} → ${entry.intent.join()}`,
      ),
    ).toEqual(['13:21 SYSTEM → FILTER', '13:21 HUMAN → SEARCH', '13:25 RESET → FILTER']);
    expect(finalIntentOf(model, 'a7')?.source).toBe('SYSTEM');
    expect(ledger.decisions).toHaveLength(2);
  });

  it('confirm keeps the intent and records the human authority (HUMAN_CONFIRMED)', () => {
    const model = modelWith();
    const ledger = emptyLedger();
    recordIntentDecision(ledger, model, { actionId: 'a7', type: 'CONFIRM', at: at(30) });
    applyHumanReview(model, ledger);
    expect(model.actions[0]?.review).toMatchObject({
      status: 'HUMAN_CONFIRMED',
      source: 'HUMAN',
      finalIntent: 'FILTER',
    });
    expect(model.evidence.at(-1)?.kind).toBe('INTENT_CONFIRMATION');
  });

  it('a new analysis (AI) cannot override a human decision: it stays a proposal', () => {
    const ledger = emptyLedger();
    const first = modelWith();
    recordIntentDecision(ledger, first, { actionId: 'a7', type: 'CONFIRM', at: at(30) });
    // L'analyse est refaite (par exemple par l'IA) et propose OPEN.
    const rebuilt = applyHumanReview(modelWith(['OPEN'], 0.7), ledger, { aiAnalysis: true });
    expect(rebuilt.actions[0]?.interpretation).toEqual(['OPEN']);
    expect(rebuilt.actions[0]?.review).toMatchObject({
      status: 'HUMAN_CONFIRMED',
      finalIntent: 'FILTER',
      proposal: { intent: ['OPEN'], source: 'AI_PROPOSAL' },
    });
    expect(finalIntentOf(rebuilt, 'a7')?.intent).toEqual(['FILTER']);
  });

  it('refusals leave the ledger untouched: unknown intent, unknown action, reset without a decision', () => {
    const model = modelWith();
    const ledger = emptyLedger();
    expect(
      recordIntentDecision(ledger, model, { actionId: 'a7', type: 'CORRECT', intent: 'OTHER' }),
    ).toMatchObject({ error: expect.stringMatching(/unknown intent OTHER/) as unknown });
    expect(recordIntentDecision(ledger, model, { actionId: 'zz', type: 'CONFIRM' })).toMatchObject({
      error: 'unknown action zz',
    });
    expect(recordIntentDecision(ledger, model, { actionId: 'a7', type: 'RESET' })).toMatchObject({
      error: expect.stringMatching(/nothing to reset/) as unknown,
    });
    expect(ledger.decisions).toEqual([]);
    applyHumanReview(model, ledger);
    expect(model.actions[0]?.review).toBeUndefined();
  });

  it('knowledge keeps the decision WITH its context (never a global rule); a reset removes it; persisted with the store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-intent-knowledge-'));
    const store = new FunctionalKnowledgeStore(dir, { application: 'demo' });
    await store.load();
    const base = {
      systemIntent: ['FILTER'],
      source: 'HUMAN' as const,
      scope: 'CONTEXTUAL' as const,
      recordingSessionId: 'rec-1',
      status: 'HUMAN_CORRECTED' as const,
    };
    store.rememberIntentDecisions([
      { ...base, key: '/workbench|button|button "Search"|#run', context, intent: 'SEARCH' },
      {
        ...base,
        key: '/archive|button|button "Search"|#go',
        context: { ...context, page: '/archive', selector: '#go' },
        intent: 'FILTER',
      },
    ]);
    await store.save([]);
    const reloaded = new FunctionalKnowledgeStore(dir, { application: 'demo' });
    await reloaded.load();
    // Même libellé, deux écrans : deux connaissances distinctes, aucune règle « tous les boutons Search ».
    expect(reloaded.intentDecisions().map((entry) => `${entry.context.page ?? ''}:${entry.intent}`)).toEqual([
      '/workbench:SEARCH',
      '/archive:FILTER',
    ]);
    reloaded.rememberIntentDecisions([
      { ...base, key: '/workbench|button|button "Search"|#run', context, intent: 'SEARCH', reset: true },
    ]);
    expect(reloaded.intentDecisions().map((entry) => entry.context.page)).toEqual(['/archive']);
  });
});
