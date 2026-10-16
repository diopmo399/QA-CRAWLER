import { describe, expect, it } from 'vitest';
import type { RawRecordedEvent, RecordedElement, RecordedFlow } from '../../src/recording/model.js';
import {
  correctFlowTarget,
  correctRawEvents,
  editFlowRow,
  proposalTarget,
  proposeCorrection,
  recordedRowCells,
  rowOfColumns,
} from '../../src/recording/target-correction.js';

/**
 * LA LIGNE PAR SES COLONNES : toutes les cellules de la ligne sont gardées dès l'enregistrement ; chaque
 * colonne choisie prend sa valeur d'une source (valeur lue, valeur modifiée, donnée du run, nouvelle
 * donnée de test) ; plusieurs colonnes se combinent ; la ligne se modifie en revue sans navigateur.
 */
const link: RecordedElement = {
  tag: 'a',
  role: 'link',
  name: 'Open',
  css: 'table a',
  cssStable: false,
  inForm: false,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  sameRoleName: 3,
  roleNameIndex: 1,
  sameLabel: 0,
  rowKey: [{ column: 'Reference', value: 'R-3027' }],
};
const cells = [
  { column: 'Reference', value: 'R-3027' },
  { column: 'Workflow', value: 'Ouverture de dossier' },
  { column: 'Status', value: 'Nouvelle' },
  { column: 'Client', value: 'Aïssatou Ba' },
];
const variables = [{ key: 'client.name', value: 'Aïssatou Ba' }];

const flow = (): RecordedFlow => ({
  name: 'demo',
  recordingSessionId: 'rec-1',
  startAt: '/',
  steps: [
    {
      id: 's1',
      step: {
        kind: 'click',
        target: { strategy: 'role', role: 'link', name: 'Open', row: { Reference: 'R-3024' } },
        allow: [],
        optional: false,
      },
      label: 'Open',
      actionIds: ['a1'],
      rawEventIds: ['r1'],
      provenance: 'HUMAN_RECORDED',
      confidence: 1,
      explanation: 'recorded click',
    },
  ],
  assertions: [],
  intent: { confidence: 0, evidence: [], transitions: [] },
  negative: false,
  quality: {} as RecordedFlow['quality'],
});

describe('row columns: every column of the row, each with its own source', () => {
  it('combines several columns: recorded value, edited value, run value, contains', () => {
    const outcome = rowOfColumns(cells, variables, [
      { column: 'Workflow', source: 'recorded' },
      { column: 'Status', source: 'value', value: 'En cours' },
      { column: 'Client', source: 'variable', key: 'client.name', match: 'contains' },
    ]);
    expect(outcome).toEqual({
      row: {
        Workflow: 'Ouverture de dossier',
        Status: 'En cours',
        Client: '~${testData:client.name}',
      },
      created: [],
    });
  });

  it('a new test data is created from the cell (review), or from the value typed in the window', () => {
    const outcome = rowOfColumns(
      cells,
      variables,
      [
        { column: 'Workflow', source: 'new-variable', key: 'row.workflow' },
        { column: 'Status', source: 'new-variable', key: 'row.status', value: 'En cours' },
      ],
      { taken: ['client.name'] },
    );
    expect(outcome).toEqual({
      row: { Workflow: '${testData:row.workflow}', Status: '${testData:row.status}' },
      created: [
        { key: 'row.workflow', value: 'Ouverture de dossier', column: 'Workflow' },
        { key: 'row.status', value: 'En cours', column: 'Status' },
      ],
    });
  });

  it('refuses what cannot be trusted: unknown column, unknown run value, a typed value citing a source', () => {
    const error = (choices: Parameters<typeof rowOfColumns>[2], allowNew = true): string => {
      const outcome = rowOfColumns(
        cells,
        variables,
        choices,
        allowNew ? { taken: ['client.name'] } : undefined,
      );
      return 'error' in outcome ? outcome.error : '';
    };
    expect(error([])).toMatch(/at least one column/);
    expect(error([{ column: 'Secret', source: 'recorded' }])).toMatch(/not in the row/);
    expect(error([{ column: 'Client', source: 'variable', key: 'user.password' }])).toMatch(/not a variable/);
    expect(error([{ column: 'Status', source: 'value', value: '${env:SECRET}' }])).toMatch(/cannot cite/);
    expect(error([{ column: 'Status', source: 'value', value: '  ' }])).toMatch(/empty/);
    expect(
      error([
        { column: 'Status', source: 'recorded' },
        { column: 'Status', source: 'value', value: 'x' },
      ]),
    ).toMatch(/twice/);
    // Une nouvelle donnée : nom valide, libre, jamais sensible, et seulement en revue.
    expect(error([{ column: 'Status', source: 'new-variable', key: '9status' }])).toMatch(/valid variable/);
    expect(error([{ column: 'Status', source: 'new-variable', key: 'client.name' }])).toMatch(
      /already exists/,
    );
    expect(error([{ column: 'Status', source: 'new-variable', key: 'user.token' }])).toMatch(/sensitive/);
    expect(error([{ column: 'Status', source: 'new-variable', key: 'row.status' }], false)).toMatch(
      /during the review only/,
    );
  });

  it('the proposal target with the columns option; an invalid choice keeps the proposed target', () => {
    const proposal = proposeCorrection(link, 'click', 'fr', { known: variables }, cells);
    expect(
      proposalTarget(proposal, 'columns', undefined, [
        { column: 'Workflow', source: 'recorded' },
        { column: 'Client', source: 'variable', key: 'client.name' },
      ]).row,
    ).toEqual({ Workflow: 'Ouverture de dossier', Client: '${testData:client.name}' });
    expect(proposalTarget(proposal, 'columns', undefined, [{ column: 'Nope', source: 'recorded' }])).toEqual(
      proposal.target,
    );
  });

  it('review: the correction writes the columns and returns the new test data to add', () => {
    const reviewed = flow();
    const outcome = correctFlowTarget(
      reviewed,
      's1',
      { element: link, rowCells: cells },
      5,
      'fr',
      { known: variables, newVariables: { taken: ['client.name'] } },
      'columns',
      undefined,
      [
        { column: 'Workflow', source: 'new-variable', key: 'row.workflow' },
        { column: 'Client', source: 'variable', key: 'client.name', match: 'contains' },
      ],
    );
    expect('error' in outcome).toBe(false);
    if ('error' in outcome) return;
    expect(outcome.created).toEqual([
      { key: 'row.workflow', value: 'Ouverture de dossier', column: 'Workflow' },
    ]);
    const step = reviewed.steps[0]?.step;
    expect(step?.kind === 'click' && step.target.row).toEqual({
      Workflow: '${testData:row.workflow}',
      Client: '~${testData:client.name}',
    });
    // Un choix refusé ne touche pas au flow.
    const untouched = flow();
    expect(
      correctFlowTarget(
        untouched,
        's1',
        { element: link, rowCells: cells },
        5,
        'fr',
        {},
        'columns',
        undefined,
        [{ column: 'Nope', source: 'recorded' }],
      ),
    ).toEqual({ error: 'column "Nope" is not in the row' });
    expect(untouched.steps[0]?.corrections).toBeUndefined();
  });

  it('recording: no new test data yet; the raw element carries the chosen columns', () => {
    const events: RawRecordedEvent[] = [
      {
        id: 'r1',
        sequence: 1,
        type: 'click',
        at: 1,
        url: 'http://app/',
        element: { ...link, rowCells: cells },
      },
    ];
    const refused = correctRawEvents(
      events,
      ['r1'],
      { element: link, rowCells: cells },
      'click',
      2,
      'fr',
      { newVariables: { taken: [] } },
      'columns',
      undefined,
      [{ column: 'Workflow', source: 'new-variable', key: 'row.workflow' }],
    );
    expect(refused).toEqual({ error: 'a new variable is created during the review only' });
    const outcome = correctRawEvents(
      events,
      ['r1'],
      { element: link, rowCells: cells },
      'click',
      2,
      'fr',
      {},
      'columns',
      undefined,
      [
        { column: 'Workflow', source: 'recorded' },
        { column: 'Status', source: 'value', value: 'Nouvelle', match: 'contains' },
      ],
    );
    expect(!('error' in outcome) && outcome.correction.next.row).toEqual({
      Workflow: 'Ouverture de dossier',
      Status: '~Nouvelle',
    });
    expect(events[0]?.element?.rowKey).toEqual([
      { column: 'Workflow', value: 'Ouverture de dossier' },
      { column: 'Status', value: '~Nouvelle' },
    ]);
  });

  it('review without the browser: the recorded cells redefine the row; the history keeps the original', () => {
    const events: RawRecordedEvent[] = [
      { id: 'r0', sequence: 0, type: 'navigation', at: 0, url: 'http://app/' },
      {
        id: 'r1',
        sequence: 1,
        type: 'click',
        at: 1,
        url: 'http://app/',
        element: { ...link, rowCells: cells },
      },
    ];
    expect(recordedRowCells(events, ['r0', 'r1'])).toEqual(cells);
    expect(recordedRowCells(events, ['r0'])).toEqual([]);
    const reviewed = flow();
    const outcome = editFlowRow(
      reviewed,
      's1',
      recordedRowCells(events, ['r1']),
      variables,
      [
        { column: 'Workflow', source: 'value', value: 'Clôture de dossier' },
        { column: 'Client', source: 'variable', key: 'client.name' },
      ],
      9,
      { taken: ['client.name'] },
    );
    expect('error' in outcome).toBe(false);
    const item = reviewed.steps[0];
    expect(item?.step.kind === 'click' && item.step.target).toEqual({
      strategy: 'role',
      role: 'link',
      name: 'Open',
      row: { Workflow: 'Clôture de dossier', Client: '${testData:client.name}' },
    });
    expect(item?.corrections?.[0]?.previous.row).toEqual({ Reference: 'R-3024' });
    expect(item?.userDecision).toBe('TARGET_CORRECTED_BY_USER');
    // Sans cellules enregistrées, ou une étape hors d'un tableau : refusé.
    expect(editFlowRow(flow(), 's1', [], variables, [{ column: 'Workflow', source: 'recorded' }], 9)).toEqual(
      {
        error: 'step s1: the cells of the row were not recorded',
      },
    );
    expect(
      editFlowRow(flow(), 'nope', cells, variables, [{ column: 'Workflow', source: 'recorded' }], 9),
    ).toEqual({ error: 'step nope not found' });
  });
});
