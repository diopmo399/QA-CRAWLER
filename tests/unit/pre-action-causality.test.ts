import { describe, expect, it } from 'vitest';
import { classifyEffects, PRE_ACTION_CONTROLS_CAP } from '../../src/recording/effect-causality.js';
import type { SemanticRecordedAction } from '../../src/recording/model.js';

/**
 * La capture PRÉ-ACTION (l'écran au début d'un geste) est une preuve indépendante : un contrôle déjà
 * là avant CETTE action n'est pas son effet ; un écart avec le début du geste suivant, quand
 * l'observation n'a pas été fermée par lui, reste AMBIGU — jamais attribué au hasard du temps.
 */
const action = (id: string, extra: Partial<SemanticRecordedAction> = {}): SemanticRecordedAction => ({
  id,
  type: 'CLICK',
  rawEventIds: [`r-${id}`],
  at: 0,
  url: 'http://app.test/requests',
  network: [],
  provenance: 'HUMAN_RECORDED',
  confidence: 0.9,
  evidence: [],
  ...extra,
});
const classify = (
  current: SemanticRecordedAction,
  learned: { appears?: string[]; disappears?: string[] },
  next?: SemanticRecordedAction,
) =>
  classifyEffects({
    action: current,
    learned,
    ownsScreen: true,
    screenShared: false,
    ...(next ? { next } : {}),
  }).map((candidate) => [candidate.effect, candidate.classification]);

describe('Pre-action evidence in effect causality', () => {
  it('a control ALREADY present before this action is never its effect (AMBIGUOUS)', () => {
    expect(
      classify(action('a1', { preActionControls: ['save', 'details'] }), { appears: ['button:Details'] }),
    ).toEqual([['+ button:Details', 'AMBIGUOUS']]);
  });

  it('a control ALREADY absent before this action did not disappear because of it — only when the capture is complete', () => {
    expect(classify(action('a1', { preActionControls: ['save'] }), { disappears: ['button:Close'] })).toEqual(
      [['- button:Close', 'AMBIGUOUS']],
    );
    // Une capture pleine (bornée) ne prouve aucune absence : la disparition reste à l'action.
    const full = Array.from({ length: PRE_ACTION_CONTROLS_CAP }, (_, index) => `control ${String(index)}`);
    expect(classify(action('a1', { preActionControls: full }), { disappears: ['button:Close'] })).toEqual([
      ['- button:Close', 'STRONGLY_CORRELATED'],
    ]);
  });

  it('absent at the start of the next gesture, observation closed by it: BELONGS_TO_NEXT_ACTION; closed by a timer: AMBIGUOUS', () => {
    const next = action('a2', { preActionControls: ['save'] });
    expect(
      classify(action('a1', { observationClosedBy: 'a2' }), { appears: ['dialog:Confirm'] }, next),
    ).toEqual([['+ dialog:Confirm', 'BELONGS_TO_NEXT_ACTION']]);
    expect(classify(action('a1'), { appears: ['dialog:Confirm'] }, next)).toEqual([
      ['+ dialog:Confirm', 'AMBIGUOUS'],
    ]);
  });

  it('still present at the start of the next gesture: closed by it → next action; otherwise AMBIGUOUS', () => {
    const next = action('a2', { preActionControls: ['spinner'] });
    expect(
      classify(action('a1', { observationClosedBy: 'a2' }), { disappears: ['status:Spinner'] }, next),
    ).toEqual([['- status:Spinner', 'BELONGS_TO_NEXT_ACTION']]);
    expect(classify(action('a1'), { disappears: ['status:Spinner'] }, next)).toEqual([
      ['- status:Spinner', 'AMBIGUOUS'],
    ]);
  });

  it('without pre-action evidence nothing changes: the most recent gesture owns its screen', () => {
    expect(classify(action('a1'), { appears: ['button:Details'] })).toEqual([
      ['+ button:Details', 'STRONGLY_CORRELATED'],
    ]);
  });
});
