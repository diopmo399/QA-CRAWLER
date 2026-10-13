import { describe, expect, it } from 'vitest';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedFlow,
  RecordedFlowStep,
} from '../../src/recording/model.js';
import {
  correctFlowTarget,
  correctRawEvents,
  describeTarget,
  proposalTarget,
  proposeCorrection,
  restoreFlowTarget,
  restoreRawEvents,
  useOfStep,
} from '../../src/recording/target-correction.js';
import { reviewSteps } from '../../src/recording/panel-state.js';

/**
 * CORRECTION MANAGER : la cible désignée par l'humain dans la page remplace celle de l'action — avec le
 * même résolveur que l'enregistrement, un historique qui garde l'original, et jamais une devinette.
 */
function element(overrides: Partial<RecordedElement>): RecordedElement {
  return {
    tag: 'button',
    role: 'button',
    name: 'Search',
    css: 'form > button',
    cssStable: false,
    inForm: true,
    isSubmit: false,
    inNavigation: false,
    inDialog: false,
    sameRoleName: 1,
    roleNameIndex: 0,
    sameLabel: 0,
    ...overrides,
  };
}

function clickStep(id: string, name: string): RecordedFlowStep {
  return {
    id,
    step: { kind: 'click', target: { strategy: 'css', value: '#oldButton' }, allow: [], optional: false },
    label: name,
    actionIds: [`a-${id}`],
    rawEventIds: [`r-${id}`],
    provenance: 'HUMAN_RECORDED',
    confidence: 1,
    explanation: 'recorded click',
  };
}

function flowOf(steps: RecordedFlowStep[]): RecordedFlow {
  return {
    name: 'demo',
    recordingSessionId: 'rec-1',
    startAt: '/',
    steps,
    assertions: [],
    intent: { confidence: 0, evidence: [], transitions: [] },
    negative: false,
    quality: {} as RecordedFlow['quality'],
  };
}

describe('target correction: proposal', () => {
  it('a picked button is proposed like the recorder would: role + accessible name first, its test id and CSS as fallbacks', () => {
    const proposal = proposeCorrection(element({ name: 'Search', testId: 'search' }), 'click', 'en');
    expect(proposal.target).toEqual({ strategy: 'role', role: 'button', name: 'Search' });
    expect(proposal.order[0]).toBe('role + accessible name');
    expect(proposal.order).toContain('testId');
    expect(proposal.order.at(-1)).toBe('CSS');
    expect(proposal.alternatives).toContainEqual({ strategy: 'testId', value: 'search' });
    expect(proposal.traits).toMatchObject({ role: 'button', name: 'Search', testId: 'search' });
    expect(describeTarget(proposal.target)).toBe('button "Search"');
    expect(describeTarget({ strategy: 'testId', value: 'search' })).toBe('testId "search"');
    expect(describeTarget({ strategy: 'label', value: 'Value', section: 'Secondary' })).toBe(
      'label "Value" (section Secondary)',
    );
  });

  it('a picked field uses the field resolver: its label, in its section when the label repeats', () => {
    const proposal = proposeCorrection(
      element({
        tag: 'input',
        role: 'textbox',
        name: 'Value',
        label: 'Value',
        sameLabel: 2,
        sectionPath: ['Secondary'],
        sameLabelInSection: 1,
        css: '#valueInput',
      }),
      useOfStep('fill'),
      'fr',
    );
    // Le libellé se répète : la section le rend unique, c'est elle qui passe en premier.
    expect(proposal.target).toEqual({ strategy: 'label', value: 'Value', section: 'Secondary' });
    expect(proposal.order).toEqual(['libellé + section', 'CSS']);
    expect(proposal.traits.section).toBe('Secondary');
  });

  it('useOfStep maps clicks, fields and checkboxes', () => {
    expect(useOfStep('click')).toBe('click');
    expect(useOfStep('fill')).toBe('field');
    expect(useOfStep('select')).toBe('field');
    expect(useOfStep('check')).toBe('check');
    expect(useOfStep('uncheck')).toBe('check');
  });
});

describe('target correction: review (generated flow)', () => {
  it('replaces the target of the step, marks the human decision and keeps the original in the history', () => {
    const flow = flowOf([clickStep('s1', 'Search'), clickStep('s2', 'Open')]);
    const outcome = correctFlowTarget(
      flow,
      's1',
      { element: element({ name: 'Rechercher', testId: 'search' }) },
      1_700_000_000_000,
      'fr',
    );
    expect('error' in outcome).toBe(false);
    if ('error' in outcome) return;
    const step = flow.steps[0];
    const target = { strategy: 'role', role: 'button', name: 'Rechercher' };
    expect(step?.step.kind === 'click' && step.step.target).toEqual(target);
    expect(step?.userDecision).toBe('TARGET_CORRECTED_BY_USER');
    expect(step?.targetValidation).toEqual({
      status: 'USER_CORRECTED',
      repaired: false,
      requiresReplayValidation: false,
    });
    expect(step?.corrections).toHaveLength(1);
    expect(step?.corrections?.[0]).toMatchObject({
      previous: { strategy: 'css', value: '#oldButton' },
      next: target,
      by: 'USER',
    });
    // L'autre étape ne bouge pas.
    expect(flow.steps[1]?.step.kind === 'click' && flow.steps[1].step.target).toEqual({
      strategy: 'css',
      value: '#oldButton',
    });
  });

  it('restores the original target; the history keeps both moves; a step without correction cannot be restored', () => {
    const flow = flowOf([clickStep('s1', 'Search')]);
    correctFlowTarget(flow, 's1', { element: element({ name: 'Rechercher', testId: 'search' }) }, 1, 'fr');
    const restored = restoreFlowTarget(flow, 's1', 2);
    expect('error' in restored).toBe(false);
    const step = flow.steps[0];
    expect(step?.step.kind === 'click' && step.step.target).toEqual({ strategy: 'css', value: '#oldButton' });
    expect(step?.userDecision).toBeUndefined();
    expect(step?.corrections).toHaveLength(2);
    expect(restoreFlowTarget(flowOf([clickStep('s9', 'X')]), 's9', 3)).toEqual({
      error: 'step s9 has no correction to restore',
    });
  });

  it('refuses a step without a target and an unknown step', () => {
    const flow = flowOf([
      { ...clickStep('g1', 'Go'), step: { kind: 'goto', url: '/x' } } as unknown as RecordedFlowStep,
    ]);
    expect(correctFlowTarget(flow, 'g1', { element: element({}) }, 1)).toEqual({
      error: 'step g1 (goto) has no target to correct',
    });
    expect(correctFlowTarget(flow, 'nope', { element: element({}) }, 1)).toEqual({
      error: 'step nope not found',
    });
  });

  it('the review window shows the corrected step as confirmed, with the readable targets and the history', () => {
    const flow = flowOf([clickStep('s1', 'Search')]);
    correctFlowTarget(flow, 's1', { element: element({ name: 'Rechercher', testId: 'search' }) }, 1, 'fr');
    const review = reviewSteps(flow, [], 'fr');
    const step = review.actions[0];
    expect(step?.status).toBe('CONFIRMED');
    expect(step?.statusText).toBe("Cible corrigée par l'utilisateur");
    expect(step?.resolution).toBe('CORRECTED');
    expect(step?.correctable).toBe(true);
    expect(step?.correction).toEqual({
      current: 'button "Rechercher"',
      original: 'css "#oldButton"',
      corrected: true,
      history: [{ at: 1, from: 'css "#oldButton"', to: 'button "Rechercher"' }],
    });
  });
});

describe('target correction: table rows (dynamic row key)', () => {
  // Un lien « Open » dans la ligne d'un tableau : la clé lue (N° 3027) est renvoyée par le serveur, elle
  // change à chaque run ; la colonne « Name » porte la valeur saisie à l'étape de création.
  const link = element({
    tag: 'a',
    role: 'link',
    name: 'Open',
    css: 'table a',
    inForm: false,
    sameRoleName: 3,
    roleNameIndex: 1,
    rowKey: [{ column: 'N°', value: '3027' }],
  });
  const cells = [
    { column: 'N°', value: '3027' },
    { column: 'Name', value: 'Northwind' },
    { column: 'Created', value: '2026-01-02' },
  ];
  const previousRow = { strategy: 'role', role: 'link', name: 'Open', row: { 'N°': '3024' } } as const;

  it('review: the row is bound to the run data (cited by its key) first; the table key stays offered, marked run-specific', () => {
    const proposal = proposeCorrection(
      link,
      'click',
      'fr',
      { known: [{ key: 'request.name', value: 'Northwind' }], previous: previousRow },
      cells,
    );
    expect(proposal.target).toEqual({
      strategy: 'role',
      role: 'link',
      name: 'Open',
      row: { Name: '${testData:request.name}' },
    });
    expect(proposal.rowOptions).toEqual([
      { id: 'bound', row: { Name: '${testData:request.name}' }, via: 'request.name' },
      { id: 'key', row: { 'N°': '3027' }, fixed: true },
    ]);
    expect(proposalTarget(proposal, 'key')).toEqual({ ...previousRow, row: { 'N°': '3027' } });
    expect(describeTarget(proposal.target)).toBe('link "Open" (row ${testData:request.name})');
  });

  it('recording: the typed value has no key yet — the row cites the literal (the stop cites it as test data)', () => {
    const proposal = proposeCorrection(link, 'click', 'fr', { known: [{ value: 'northwind' }] }, cells);
    expect(proposal.rowOptions?.[0]).toEqual({ id: 'bound', row: { Name: 'Northwind' }, via: 'Northwind' });
    // Sans ancienne cible sur la même colonne, la clé n'est pas dite propre au run.
    expect(proposal.rowOptions?.[1]).toEqual({ id: 'key', row: { 'N°': '3027' } });
  });

  it('no known value in the row: only the table key, the target is the resolver one', () => {
    const proposal = proposeCorrection(link, 'click', 'fr', { known: [{ key: 'x', value: 'Other' }] }, cells);
    expect(proposal.target.row).toEqual({ 'N°': '3027' });
    expect(proposal.rowOptions).toEqual([{ id: 'key', row: { 'N°': '3027' } }]);
    // Hors d'un tableau : aucune option de ligne.
    expect(
      proposeCorrection(element({}), 'click', 'fr', { known: [{ value: 'Search' }] }).rowOptions,
    ).toBeUndefined();
  });

  it('review: the chosen option is written on the step; the default is the bound row', () => {
    const open = (): RecordedFlowStep => ({
      ...clickStep('s1', 'Open'),
      step: { kind: 'click', target: previousRow, allow: [], optional: false },
    });
    const picked = { element: link, rowCells: cells };
    const known = [{ key: 'request.name', value: 'Northwind' }];
    const bound = flowOf([open()]);
    correctFlowTarget(bound, 's1', picked, 1, 'fr', { known });
    expect(bound.steps[0]?.step.kind === 'click' && bound.steps[0].step.target.row).toEqual({
      Name: '${testData:request.name}',
    });
    const key = flowOf([open()]);
    const outcome = correctFlowTarget(key, 's1', picked, 1, 'fr', { known }, 'key');
    expect(key.steps[0]?.step.kind === 'click' && key.steps[0].step.target.row).toEqual({ 'N°': '3027' });
    expect(!('error' in outcome) && outcome.proposal.rowOptions?.[1]?.fixed).toBe(true);
  });

  it('recording: the raw element carries the chosen row key (bound: the typed literal)', () => {
    const events: RawRecordedEvent[] = [
      { id: 'r1', sequence: 1, type: 'click', at: 1, url: 'http://app/', element: element({ name: 'Open' }) },
    ];
    const outcome = correctRawEvents(events, ['r1'], { element: link, rowCells: cells }, 'click', 2, 'fr', {
      known: [{ value: 'Northwind' }],
    });
    expect(!('error' in outcome) && outcome.correction.next.row).toEqual({ Name: 'Northwind' });
    expect(events[0]?.element?.rowKey).toEqual([{ column: 'Name', value: 'Northwind' }]);
    const asKey = correctRawEvents(
      events,
      ['r1'],
      { element: link, rowCells: cells },
      'click',
      3,
      'fr',
      {},
      'key',
    );
    expect(!('error' in asKey) && asKey.correction.next.row).toEqual({ 'N°': '3027' });
    expect(events[0]?.element?.rowKey).toEqual([{ column: 'N°', value: '3027' }]);
  });
});

describe('target correction: recording (raw events)', () => {
  function rawClick(id: string, el: RecordedElement): RawRecordedEvent {
    return { id, sequence: Number(id.slice(1)), type: 'click', at: 1, url: 'http://app/', element: el };
  }

  it('puts the picked element on every raw event of the action, keeps the old target, drops the stale validation', () => {
    const original = element({ name: 'Action 7', css: 'nav > button:nth-of-type(7)' });
    const events = [
      { ...rawClick('r1', original), targetValidation: { status: 'VALIDATED' } as never },
      rawClick('r2', element({ name: 'Other' })),
    ];
    const outcome = correctRawEvents(
      events,
      ['r1'],
      { element: element({ name: 'Action 8' }) },
      'click',
      5,
      'fr',
    );
    expect('error' in outcome).toBe(false);
    if ('error' in outcome) return;
    expect(outcome.touched).toBe(1);
    expect(events[0]?.element?.name).toBe('Action 8');
    expect(events[0]?.targetValidation).toBeUndefined();
    expect(events[0]?.userCorrection).toMatchObject({
      previous: { strategy: 'role', role: 'button', name: 'Action 7' },
      next: { strategy: 'role', role: 'button', name: 'Action 8' },
      by: 'USER',
    });
    expect(events[1]?.element?.name).toBe('Other');
    // Restauration : l'original revient, la décision disparaît de l'événement.
    expect(restoreRawEvents(events, ['r1'], original)).toBe(1);
    expect(events[0]?.element?.name).toBe('Action 7');
    expect(events[0]?.userCorrection).toBeUndefined();
  });

  it('an action without element cannot be corrected', () => {
    const events: RawRecordedEvent[] = [
      { id: 'r1', sequence: 1, type: 'navigation', at: 1, url: 'http://app/' },
    ];
    expect(correctRawEvents(events, ['r1'], { element: element({}) }, 'click', 1)).toEqual({
      error: 'the action has no element to correct',
    });
  });
});
