import { describe, expect, it } from 'vitest';
import {
  healingCandidates,
  isFragileTarget,
  matchFingerprint,
  observeEffects,
  present,
  requestMatches,
  routeMatches,
  verifyEffects,
} from '../../src/flows/action-effect-verifier.js';
import { learnExpectedEffects } from '../../src/recording/human-journey.js';
import type { RecordedState, SemanticRecordedAction } from '../../src/recording/model.js';

const controls = (...items: string[]): Set<string> => new Set(items.map((item) => item.toLowerCase()));

describe('TargetFingerprintMatcher', () => {
  it('a structural CSS that now designates "Settings" instead of "Tasks" is a MISMATCH', () => {
    expect(
      matchFingerprint(
        { role: 'button', name: 'Tasks', tag: 'button' },
        { role: 'button', name: 'Settings', tag: 'button' },
      ).verdict,
    ).toBe('MISMATCH');
    expect(
      matchFingerprint(
        { role: 'button', name: 'Tasks', tag: 'button' },
        { role: 'button', name: 'Tasks', tag: 'button' },
      ).verdict,
    ).toBe('EXACT_MATCH');
    expect(matchFingerprint({ role: 'button', name: 'Tasks' }, { role: 'link', name: 'Tasks' }).verdict).toBe(
      'WEAK_MATCH',
    );
    expect(matchFingerprint({ testId: 'tasks' }, { testId: 'settings', name: 'Tasks' }).verdict).toBe(
      'MISMATCH',
    );
  });

  it('healing candidates follow the fingerprint (role + name, test id, text), never "any clickable element"', () => {
    expect(
      healingCandidates(
        { role: 'button', name: 'Tasks', testId: 'tasks-btn' },
        { strategy: 'css', value: 'main > div' },
      ),
    ).toEqual([
      { strategy: 'role', role: 'button', name: 'Tasks' },
      { strategy: 'testId', value: 'tasks-btn' },
      { strategy: 'text', value: 'Tasks' },
    ]);
    expect(isFragileTarget({ strategy: 'css', value: 'main > div:nth-of-type(3) > button' })).toBe(true);
    expect(isFragileTarget({ strategy: 'css', value: '[data-qa="tasks"]' })).toBe(false);
  });
});

describe('ActionEffectVerifier', () => {
  const base = { afterRoute: '/simulator', mutation: false, writes: [] };

  it('CONFIRMED when the learned control appeared, even with the same state fingerprint (§25)', () => {
    const after = controls('button:company interview', 'button:tasks');
    const verification = verifyEffects({
      ...base,
      effects: { appears: ['button:Company interview'] },
      observed: observeEffects(controls('button:tasks'), after, '/simulator', '/simulator', []),
      afterControls: after,
    });
    expect(verification.status).toBe('CONFIRMED');
  });

  it('NO_EFFECT when nothing changed (§26), WRONG_EFFECT when something else opened (§27)', () => {
    const same = controls('button:tasks');
    expect(
      verifyEffects({
        ...base,
        effects: { appears: ['button:Company interview'] },
        observed: observeEffects(same, same, '/s', '/s', []),
        afterControls: same,
      }).status,
    ).toBe('NO_EFFECT');
    const other = controls('button:tasks', 'heading:settings panel');
    expect(
      verifyEffects({
        ...base,
        effects: { appears: ['button:Company interview'] },
        observed: observeEffects(same, other, '/s', '/s', []),
        afterControls: other,
      }).status,
    ).toBe('WRONG_EFFECT');
  });

  it('the next step target, absent before and present after, confirms an action nothing else describes (§7)', () => {
    const same = controls('button:tasks');
    expect(
      verifyEffects({
        ...base,
        observed: observeEffects(same, same, '/s', '/s', []),
        afterControls: same,
        nextTarget: { label: 'Next', before: false, after: true },
      }).status,
    ).toBe('CONFIRMED');
    expect(
      verifyEffects({
        ...base,
        observed: observeEffects(same, same, '/s', '/s', []),
        afterControls: same,
        nextTarget: { label: 'Next', before: false, after: false },
      }).status,
    ).toBe('NO_EFFECT');
    // L'écran a changé sans montrer la cible suivante : écran intermédiaire possible, pas d'échec ici.
    expect(
      verifyEffects({
        ...base,
        observed: observeEffects(same, controls('link:administration'), '/login', '/home', []),
        afterControls: controls('link:administration'),
        nextTarget: { label: 'Next', before: false, after: false },
      }).status,
    ).toBe('NOT_VERIFIED');
    // La cible était déjà là, rien d'appris : rien à exiger (pas « same state = échec »).
    expect(
      verifyEffects({
        ...base,
        observed: observeEffects(same, same, '/s', '/s', []),
        afterControls: same,
        nextTarget: { label: 'Next', before: true, after: true },
      }).status,
    ).toBe('NOT_REQUIRED');
  });

  it('a write without a clear answer is AMBIGUOUS (never retried); a refused write never confirms a request', () => {
    const same = controls('button:submit');
    const observed = observeEffects(same, same, '/s', '/s', ['POST /api/submit 500']);
    expect(
      verifyEffects({
        ...base,
        mutation: true,
        effects: { request: 'POST /api/submit' },
        observed,
        afterControls: same,
        writes: [{ request: 'POST /api/submit', status: 500 }],
      }).status,
    ).toBe('AMBIGUOUS');
    expect(requestMatches('POST /api/submit', ['POST /api/submit 500'])).toBeUndefined();
    expect(requestMatches('POST /api/submit', ['POST /api/submit 201'])).toBe('POST /api/submit 201');
    expect(requestMatches('GET /api/requests/{id}', ['GET /api/requests/42 200'])).toBe(
      'GET /api/requests/42 200',
    );
  });

  it('routes and controls are compared by meaning, not by exact strings', () => {
    expect(routeMatches('/requests/{id}', '/requests/42')).toBe(true);
    expect(routeMatches('/requests/{id}', '/requests')).toBe(false);
    expect(present(controls('link:company interview'), 'button:Company interview')).toBe(true);
    expect(present(controls('button:tasks'), 'Company interview')).toBe(false);
  });

  it('the role is respected: a "Filter" BUTTON never satisfies the "Filter" DIALOG; a compatible role still does', () => {
    expect(present(controls('button:filter'), 'dialog:Filter')).toBe(false);
    expect(present(controls('alertdialog:filter'), 'dialog:Filter')).toBe(true);
    expect(present(controls('combobox:value'), 'textbox:Value')).toBe(true);
    expect(present(controls('tab:filter'), 'button:Filter')).toBe(false);
    expect(present(controls('button:filter'), 'Filter')).toBe(true);
  });

  it('an expected appearance must APPEAR: a control already on the screen before the action is not its effect', () => {
    const verify = (before: Set<string>, after: Set<string>) =>
      verifyEffects({
        effects: { appears: ['dialog:Filter'] },
        observed: observeEffects(before, after, '/', '/', []),
        afterControls: after,
        afterRoute: '/',
        mutation: false,
        writes: [],
      }).status;
    // Le bouton « Filter » est là avant et après : rien n'est apparu, le dialogue n'est pas venu.
    expect(verify(controls('button:filter'), controls('button:filter'))).toBe('NO_EFFECT');
    // Le dialogue était DÉJÀ ouvert : il n'est pas l'effet de cette action.
    expect(verify(controls('dialog:filter'), controls('dialog:filter', 'button:apply'))).not.toBe(
      'CONFIRMED',
    );
    // Le dialogue apparaît : confirmé.
    expect(verify(controls('button:filter'), controls('button:filter', 'dialog:filter'))).toBe('CONFIRMED');
  });
});

describe('expectation learning during the recording (§8 / §9)', () => {
  const state = (id: string, route: string, controlsList: string[]): RecordedState => ({
    id,
    stateId: id,
    label: route,
    route,
    url: `http://app.test${route}`,
    title: route,
    headings: [],
    alerts: [],
    invalidFields: 0,
    dialogs: [],
    controls: controlsList,
  });
  const action = (extra: Partial<SemanticRecordedAction> = {}): SemanticRecordedAction => ({
    id: 'a1',
    type: 'CLICK',
    rawEventIds: ['r1'],
    at: 1,
    url: 'http://app.test/tasks',
    network: [],
    provenance: 'HUMAN_RECORDED',
    confidence: 0.9,
    evidence: [],
    ...extra,
  });

  it('keeps stable named controls, never timestamps, counters or loading indicators', () => {
    const effects = learnExpectedEffects(
      state('o1', '/tasks', ['button:Task list']),
      state('o2', '/tasks', [
        'button:Task list',
        'button:Company interview',
        'status:Updated 10:42',
        'status:Loading…',
        'text:Ref 2026001',
      ]),
      action(),
    );
    expect(effects).toEqual({ appears: ['button:Company interview'] });
  });

  it('learns the route reached and the request sent (with stable ids)', () => {
    const effects = learnExpectedEffects(
      state('o1', '/requests', []),
      state('o2', '/requests/:id', []),
      action({ network: [{ method: 'POST', path: '/api/requests', status: 201 }] }),
    );
    expect(effects).toEqual({ route: '/requests/{id}', request: 'POST /api/requests' });
    expect(learnExpectedEffects(state('o1', '/a', []), state('o2', '/requests/42', []), action())).toEqual({
      route: '/requests/{id}',
    });
  });
});
