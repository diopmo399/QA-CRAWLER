import { describe, expect, it } from 'vitest';
import { classifyValueLoss, restorableValueLoss } from '../../src/flows/action-effect-verifier.js';

/**
 * VALUE_RESTORED_AFTER_APPLICATION_RESET : seule une valeur retirée du BON champ par l'application
 * (vidée, écrasée, élément re-rendu) peut être refaite — une fois. Tout le reste reste une divergence.
 */
describe('restorableValueLoss', () => {
  const loss = (probe: Parameters<typeof classifyValueLoss>[0]['probe'], wrongTarget = false) =>
    classifyValueLoss({ expected: 'ACME', probe, wrongTarget });

  it('emptied, overwritten or re-rendered by the application: restorable', () => {
    expect(restorableValueLoss(loss({ attached: true, value: '' }))).toBe(true);
    expect(restorableValueLoss(loss({ attached: true, value: 'Default Inc' }))).toBe(true);
    expect(restorableValueLoss(loss({ attached: false, rerenderedValue: '' }))).toBe(true);
  });

  it('another field, a vanished field, a rejected or truncated value, or an unreadable one: never restored', () => {
    expect(restorableValueLoss(loss({ attached: true, value: '' }, true))).toBe(false);
    expect(restorableValueLoss(loss({ attached: false }))).toBe(false);
    expect(restorableValueLoss(loss({ attached: true, value: 'AC', invalid: true }))).toBe(false);
    expect(restorableValueLoss(loss({ attached: true, value: 'AC' }))).toBe(false);
    expect(restorableValueLoss(loss(undefined))).toBe(false);
    expect(restorableValueLoss(undefined)).toBe(false);
  });
});
