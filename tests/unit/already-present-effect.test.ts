import { describe, expect, it } from 'vitest';
import { verifyEffects } from '../../src/flows/action-effect-verifier.js';
import { analyzeDivergence } from '../../src/workflow-healing/divergence-analyzer.js';

/**
 * Le cas réel (libellés neutres) : l'étape 10 sélectionne l'onglet « Company », ses boutons
 * apparaissent ; l'étape 11 clique de nouveau l'en-tête des onglets — rien ne bouge, l'état attendu
 * (« + button:Interview », « + button:Company details ») est DÉJÀ là. Ce n'est pas un « aucun effet » ;
 * et un 401 d'un service annexe, pendant que d'autres requêtes réussissent, n'est pas une session perdue.
 */
const nothingChanged = { appeared: [], disappeared: [], requests: [] };

describe('EFFECT_ALREADY_PRESENT', () => {
  it('nothing changed, but the WHOLE expected state is already there: CONFIRMED (EFFECT_ALREADY_PRESENT), not NO_EFFECT', () => {
    const verification = verifyEffects({
      effects: { appears: ['button:Interview', 'button:Company details'] },
      observed: nothingChanged,
      afterControls: new Set(['button:interview', 'button:company details', 'tab:individual']),
      afterRoute: '/request/42',
      nextTarget: { label: 'Individual', before: true, after: true },
      mutation: false,
      writes: [],
    });
    expect(verification.status).toBe('CONFIRMED');
    expect(verification.reasons[0]).toMatch(/^EFFECT_ALREADY_PRESENT/);
  });

  it('a PARTIAL state, a missing expected request, or a wrong route stays a failure', () => {
    const base = {
      observed: nothingChanged,
      afterRoute: '/request/42',
      mutation: false,
      writes: [],
    };
    expect(
      verifyEffects({
        ...base,
        effects: { appears: ['button:Interview', 'button:Company details'] },
        afterControls: new Set(['button:interview']),
      }).status,
    ).toBe('NO_EFFECT');
    expect(
      verifyEffects({
        ...base,
        effects: { appears: ['button:Interview'], request: 'POST /api/interviews' },
        afterControls: new Set(['button:interview']),
      }).status,
    ).toBe('NO_EFFECT');
    expect(
      verifyEffects({
        ...base,
        effects: { appears: ['button:Interview'], route: '/process' },
        afterControls: new Set(['button:interview']),
      }).status,
    ).toBe('NO_EFFECT');
  });
});

describe('AUTH_STATE_CHANGED calibration', () => {
  const base = {
    actionId: 'flow#11',
    stepIndex: 11,
    expected: { label: 'Company', role: 'tab', kind: 'click' },
  };
  const screen = (loginFormVisible: boolean) => ({
    route: '/request/42',
    controls: [{ role: 'button', name: 'Interview', visible: true, disabled: false }],
    text: '',
    loginFormVisible,
  });

  it('a background 401 while other requests succeed and no sign-in form is shown: a weak hint, recovery NOT blocked', () => {
    const analysis = analyzeDivergence({
      ...base,
      symptom: 'NO_EFFECT',
      screen: screen(false),
      network: [
        { request: 'GET /api/feature-toggles', status: 401 },
        { request: 'GET /api/requests/42', status: 200 },
      ],
    });
    const auth = analysis.possibleCauses.find((cause) => cause.category === 'AUTH_STATE_CHANGED');
    expect(auth?.confidence).toBe(0.35);
    expect(auth?.evidence.map((entry) => entry.detail).join(' ')).toMatch(/session is still valid/);
    expect(analysis.recoverable).toBe(true);
  });

  it('a real session loss stays blocking: a sign-in form, or every request refused', () => {
    expect(
      analyzeDivergence({
        ...base,
        symptom: 'NO_EFFECT',
        screen: screen(true),
        network: [{ request: 'GET /api/me', status: 401 }],
      }),
    ).toMatchObject({ category: 'AUTH_STATE_CHANGED', recoverable: false });
    expect(
      analyzeDivergence({
        ...base,
        symptom: 'NO_EFFECT',
        screen: screen(false),
        network: [{ request: 'GET /api/requests/42', status: 401 }],
      }),
    ).toMatchObject({ category: 'AUTH_STATE_CHANGED', recoverable: false });
  });
});
