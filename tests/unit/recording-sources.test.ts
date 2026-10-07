import { describe, expect, it } from 'vitest';
import type { RecordedElement } from '../../src/recording/model.js';
import { resolveRecordedTarget } from '../../src/recording/recorded-target.js';
import {
  consistentWithTouched,
  parsePlaywrightSelector,
  usableEvidence,
  type PlaywrightTargetEvidence,
} from '../../src/recording/sources/playwright-locator.js';
import {
  RecordingCoordinator,
  effectiveRecordingMode,
  sameUserAction,
} from '../../src/recording/sources/recording-coordinator.js';
import type { SourceObservation } from '../../src/recording/sources/recording-source.js';

const element = (overrides: Partial<RecordedElement> = {}): RecordedElement => ({
  tag: 'button',
  role: 'button',
  name: 'Continuer',
  css: 'div.actions > button:nth-of-type(2)',
  cssStable: false,
  sameRoleName: 1,
  sameLabel: 1,
  roleNameIndex: 0,
  inForm: false,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  ...overrides,
});

const evidence = (
  selector: string,
  overrides: Partial<PlaywrightTargetEvidence> = {},
): PlaywrightTargetEvidence => {
  const parsed = parsePlaywrightSelector(selector);
  return {
    status: 'RESOLVED',
    selector,
    strategy: parsed.strategy,
    matchCount: 1,
    sameElement: true,
    ...(parsed.target ? { target: parsed.target } : {}),
    ...overrides,
  };
};

const click = (id: string, source: 'current' | 'playwright', at: number, target = {}): SourceObservation => ({
  id,
  source,
  origin: 'BROWSER_USER_EVENT',
  type: 'click',
  at,
  page: 'http://app.test/dossier',
  frame: 'main',
  target: { role: 'button', name: 'Continuer', ...target },
});

describe('Playwright locator (what Playwright says about the touched element)', () => {
  it('reads the Playwright selector forms and keeps only stable ones as flow targets', () => {
    expect(parsePlaywrightSelector('internal:role=button[name="Continuer"i]')).toEqual({
      strategy: 'role',
      target: { strategy: 'role', role: 'button', name: 'Continuer' },
    });
    expect(parsePlaywrightSelector('internal:testid=[data-testid="save"s]').target).toEqual({
      strategy: 'testId',
      value: 'save',
    });
    expect(parsePlaywrightSelector('internal:label="Nom"i').target).toEqual({
      strategy: 'label',
      value: 'Nom',
    });
    expect(parsePlaywrightSelector('internal:attr=[placeholder="Votre nom"i]').target).toEqual({
      strategy: 'css',
      value: '[placeholder="Votre nom"]',
    });
    expect(parsePlaywrightSelector('internal:text="Ouvrir la tuile"i').target).toEqual({
      strategy: 'text',
      value: 'Ouvrir la tuile',
    });
    // Position, chaîne, cadre : jamais une cible (le recorder actuel garde ce dernier recours).
    expect(parsePlaywrightSelector('internal:role=button[name="Supprimer"i] >> nth=1')).toEqual({
      strategy: 'chained',
    });
    expect(parsePlaywrightSelector('div:nth-child(3)')).toEqual({ strategy: 'chained' });
    expect(parsePlaywrightSelector('internal:role=button')).toEqual({ strategy: 'role' });
  });

  it('is usable only when unique, on the touched element itself, in a stable form', () => {
    expect(usableEvidence(evidence('internal:role=button[name="Continuer"i]'))).toBe(true);
    expect(usableEvidence(evidence('internal:role=button[name="Continuer"i]', { matchCount: 2 }))).toBe(
      false,
    );
    expect(usableEvidence(evidence('internal:role=button[name="Continuer"i]', { sameElement: false }))).toBe(
      false,
    );
    expect(usableEvidence({ status: 'UNAVAILABLE', reason: 'gone' })).toBe(false);
  });

  it('a locator read AFTER the gesture that no longer describes the element is refused', () => {
    // Le bouton « Confirmer » devenu « Confirmé » après le clic : Playwright lit la page après coup.
    const after = parsePlaywrightSelector('internal:role=button[name="Confirmé"i]').target;
    expect(after && consistentWithTouched(after, { role: 'button', name: 'Confirmer' })).toBe(false);
    const before = parsePlaywrightSelector('internal:role=button[name="Confirmer"i]').target;
    expect(before && consistentWithTouched(before, { role: 'button', name: 'Confirmer' })).toBe(true);
    // Un libellé qui avale les options de la liste n'est pas le libellé du champ.
    const select = parsePlaywrightSelector('internal:label="Pays —CanadaFrance"i').target;
    expect(select && consistentWithTouched(select, { role: 'combobox', name: 'Pays', label: 'Pays' })).toBe(
      false,
    );
  });
});

describe('Target resolution with the Playwright locator (per mode)', () => {
  it('CURRENT: no Playwright evidence, the target is exactly the one of the current resolver', () => {
    const fragile = element({ name: '', role: 'generic', tag: 'div' });
    expect(resolveRecordedTarget(fragile, 'click').target).toEqual({
      strategy: 'css',
      value: 'div.actions > button:nth-of-type(2)',
    });
  });

  it('PLAYWRIGHT: a unique Playwright locator on the touched element comes first', () => {
    const touched = element({
      name: '',
      role: 'generic',
      tag: 'div',
      text: 'Continuer',
      playwright: { ...evidence('internal:testid=[data-testid="continue"s]'), mode: 'PLAYWRIGHT' },
      testId: 'continue',
    });
    const resolved = resolveRecordedTarget(touched, 'click');
    expect(resolved.target).toEqual({ strategy: 'testId', value: 'continue' });
    expect(resolved.reasons[0]).toMatch(/Playwright locator/);
  });

  it('HYBRID: the best locator by priority wins (test id before role + name; role kept over a weaker one)', () => {
    const named = element({
      playwright: { ...evidence('internal:testid=[data-testid="continue"s]'), mode: 'HYBRID' },
    });
    expect(resolveRecordedTarget(named, 'click').target).toEqual({ strategy: 'testId', value: 'continue' });
    // Le recorder a déjà rôle + nom ; Playwright ne propose que le texte : rôle + nom reste.
    const weaker = element({
      playwright: { ...evidence('internal:text="Continuer"i'), mode: 'HYBRID' },
    });
    expect(resolveRecordedTarget(weaker, 'click').target).toEqual({
      strategy: 'role',
      role: 'button',
      name: 'Continuer',
    });
  });

  it('an unusable Playwright locator (several matches) is never chosen, and the reason is kept', () => {
    const ambiguous = element({
      name: '',
      role: 'generic',
      tag: 'div',
      playwright: {
        ...evidence('internal:text="Supprimer"i', { matchCount: 2, sameElement: false }),
        mode: 'PLAYWRIGHT',
      },
    });
    const resolved = resolveRecordedTarget(ambiguous, 'click');
    expect(resolved.target.strategy).toBe('css');
    expect(resolved.reasons.join(' ')).toMatch(/Playwright locator not used/);
  });
});

describe('Recording coordinator (one user action = one recorded action)', () => {
  it('TEST 13 — the same click seen by both sources is ONE action (references kept)', () => {
    const coordinator = new RecordingCoordinator({ mode: 'HYBRID' });
    expect(coordinator.observe(click('r42', 'current', 1000)).kind).toBe('NEW');
    const second = coordinator.observe(click('p87', 'playwright', 1040));
    expect(second.kind).toBe('DUPLICATE');
    expect(second.correlation).toMatchObject({ primary: 'r42', duplicate: 'p87', sameUserAction: true });
    expect(second.correlation?.evidence.join(' ')).toMatch(/same button "Continuer"/);
    expect(coordinator.summary()).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it('two real clicks of the same source stay two; another element or a later moment is another action', () => {
    const coordinator = new RecordingCoordinator({ mode: 'HYBRID' });
    coordinator.observe(click('r1', 'current', 0));
    expect(coordinator.observe(click('r2', 'current', 10)).kind).toBe('NEW');
    expect(coordinator.observe(click('p1', 'playwright', 20, { name: 'Annuler' })).kind).toBe('NEW');
    expect(sameUserAction(click('r9', 'current', 0), click('p9', 'playwright', 5000))).toBe(false);
  });

  it('TESTS 16 / 18 / 20 — nothing but the browser can feed a recording (flow, intent, memory, discovery, AI)', () => {
    const coordinator = new RecordingCoordinator({ mode: 'HYBRID' });
    for (const origin of ['FLOW', 'INTENT', 'MEMORY', 'ACTION_DISCOVERY', 'AI'])
      expect(
        coordinator.observe({ ...click(`x-${origin}`, 'current', 0), origin } as unknown as SourceObservation)
          .kind,
      ).toBe('REJECTED');
    expect(
      coordinator.observe({ ...click('ai1', 'current', 0), source: 'ai' } as unknown as SourceObservation)
        .kind,
    ).toBe('REJECTED');
    // CURRENT : la source Playwright n'existe pas.
    expect(new RecordingCoordinator({ mode: 'CURRENT' }).observe(click('p1', 'playwright', 0)).kind).toBe(
      'REJECTED',
    );
    expect(coordinator.summary()).toMatchObject({ accepted: 0, rejected: 6 });
  });

  it('the mode is CURRENT unless playwrightRecording is on (backward compatible)', () => {
    expect(effectiveRecordingMode({ mode: 'current', playwrightRecording: false })).toEqual({
      mode: 'CURRENT',
    });
    expect(effectiveRecordingMode({ mode: 'current', playwrightRecording: true })).toEqual({
      mode: 'CURRENT',
    });
    expect(effectiveRecordingMode({ mode: 'hybrid', playwrightRecording: true })).toEqual({ mode: 'HYBRID' });
    expect(effectiveRecordingMode({ mode: 'playwright', playwrightRecording: true })).toEqual({
      mode: 'PLAYWRIGHT',
    });
    const off = effectiveRecordingMode({ mode: 'hybrid', playwrightRecording: false });
    expect(off.mode).toBe('CURRENT');
    expect(off.warning).toMatch(/playwrightRecording: true/);
  });
});
