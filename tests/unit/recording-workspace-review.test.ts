import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { RecordedElement, RecordedFlow, RecordedFlowStep } from '../../src/recording/model.js';
import { emptyQuality } from '../../src/recording/model.js';
import {
  acceptStoredGroupProposals,
  addStoredGroupCheck,
  correctStoredTarget,
  dropFlowStep,
  editStoredRow,
  removeStoredStep,
  restoreStoredTarget,
  reviewStoredIntent,
  storedCorrectionProposal,
  storedIntents,
  storedRowSource,
  storedGroupChecks,
  storedGroupProposals,
  type StoredRecording,
} from '../../src/recording/recording-workspace.js';
import { applyGroupCommand, groupViews } from '../../src/recording/step-groups.js';

/**
 * LA REVUE D'UN ENREGISTREMENT ÉCRIT (ce que le Dashboard fait sans la fenêtre du recorder) : retirer
 * une étape d'action avec ses vérifications, créer les groupes proposés d'après les étapes métier,
 * ajouter la vérification d'un groupe. Chaque opération réécrit le flow sur disque.
 */
const C: Pick<FlowStep, 'allow' | 'optional'> = { allow: [], optional: false };

function step(id: string, action: string, flowStep: FlowStep, label = id): RecordedFlowStep {
  return {
    id,
    step: flowStep,
    label,
    actionIds: [action],
    rawEventIds: [`r-${action}`],
    provenance: 'HUMAN_RECORDED',
    confidence: 0.9,
    explanation: 'fixture',
  };
}

function fixture(): RecordedFlow {
  return {
    name: 'create then find',
    recordingSessionId: 'rec-review',
    startAt: '/items',
    steps: [
      step('s1', 'a1', { ...C, kind: 'click', target: { strategy: 'role', role: 'link', name: 'New item' } }),
      step('s2', 'a2', {
        ...C,
        kind: 'fill',
        target: { strategy: 'label', value: 'Title' },
        value: { testData: 'item.title' },
      }),
      step('s3', 'a3', { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Save' } }),
      step('s4', 'a3', { ...C, kind: 'expect', expect: { url: '/items/' } }),
      step('s5', 'a4', {
        ...C,
        kind: 'fill',
        target: { strategy: 'label', value: 'Search' },
        value: { testData: 'item.title' },
      }),
      step('s6', 'a5', { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Find' } }),
    ],
    assertions: [],
    intent: { transitions: [], confidence: 0, evidence: [] },
    negative: false,
    quality: emptyQuality(),
  };
}

let dir: string;
let recording: StoredRecording;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qa-review-'));
  recording = { directory: dir, flow: fixture(), startedAt: '2026-10-28T10:00:00.000Z', format: 'yaml' };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('review of a stored recording', () => {
  it('removes an action step with its own checks, never a check alone, and rewrites the flow', async () => {
    const flow = fixture();
    expect(dropFlowStep(flow, 's4')).toBe(false);
    expect(dropFlowStep(flow, 'nope')).toBe(false);
    expect(dropFlowStep(flow, 's3')).toBe(true);
    expect(flow.steps.map((item) => item.id)).toEqual(['s1', 's2', 's5', 's6']);
    // Un groupe ne garde jamais une étape retirée (ni la vérification partie avec elle).
    const grouped = fixture();
    grouped.groups = [{ id: 'g1', name: 'Tout', stepIds: ['s1', 's2', 's3', 's4'] }];
    expect(dropFlowStep(grouped, 's3')).toBe(true);
    expect(grouped.groups[0]?.stepIds).toEqual(['s1', 's2']);

    expect(await removeStoredStep(recording, 's4', 'fr')).toEqual({ error: 'no action step s4' });
    expect(await removeStoredStep(recording, 's6', 'fr')).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(dir, 'recorded-flow.json'), 'utf8')) as RecordedFlow;
    expect(written.steps.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(await readFile(path.join(dir, 'generated.flow.yaml'), 'utf8')).not.toContain('Find');
  });

  it('proposes groups from the business steps, creates them on decision, never twice', async () => {
    expect(await storedGroupProposals(recording, 'fr')).toEqual([]);
    await writeFile(
      path.join(dir, 'business-flow.json'),
      JSON.stringify({
        steps: [
          {
            action: 'create',
            entity: 'item',
            status: 'CONFIRMED',
            confidence: 0.9,
            businessEventId: 'b1',
            recordedActions: ['s3'],
          },
          {
            action: 'search',
            entity: 'item',
            status: 'PROBABLE',
            confidence: 0.7,
            businessEventId: 'b2',
            recordedActions: ['s6'],
          },
        ],
      }),
    );
    const proposals = await storedGroupProposals(recording, 'fr');
    expect(proposals.map((proposal) => [proposal.name, proposal.from, proposal.to])).toEqual([
      ['Création — item', 1, 3],
      ['Recherche — item', 4, 5],
    ]);
    const outcome = await acceptStoredGroupProposals(recording, 'fr');
    expect(outcome).toMatchObject({ ok: true });
    expect(groupViews(recording.flow).map((group) => group.name)).toEqual([
      'Création — item',
      'Recherche — item',
    ]);
    expect(await readFile(path.join(dir, 'generated.flow.yaml'), 'utf8')).toContain('groups:');
    expect(await storedGroupProposals(recording, 'fr')).toEqual([]);
    expect(await acceptStoredGroupProposals(recording, 'fr')).toEqual({ error: 'no group to propose' });
  });

  it('suggests the check of a group that receives data, adds it as an accepted proposal', async () => {
    applyGroupCommand(recording.flow, { op: 'create', name: 'Create', stepIds: ['s1', 's2', 's3'] });
    applyGroupCommand(recording.flow, { op: 'create', name: 'Find', stepIds: ['s5', 's6'] });
    const [suggestion] = storedGroupChecks(recording);
    expect(suggestion).toMatchObject({ groupName: 'Find', key: 'item.title', afterStepId: 's6' });
    const groupId = suggestion?.groupId ?? '';
    expect(await addStoredGroupCheck(recording, { groupId: 'g-none', key: 'item.title' }, 'fr')).toEqual({
      error: 'unknown group g-none',
    });
    const added = await addStoredGroupCheck(recording, { groupId, key: 'item.title' }, 'fr');
    expect(added).toMatchObject({ ok: true, groupName: 'Find' });
    const last = recording.flow.steps.at(-1);
    expect(last?.step).toMatchObject({ kind: 'expect', expect: { text: '${testData:item.title}' } });
    expect(recording.flow.proposals?.at(-1)).toMatchObject({ origin: 'EXPLICIT', status: 'APPROVED' });
    expect(storedGroupChecks(recording)).toEqual([]);
  });
});

describe('review of a stored recording — targets and intents', () => {
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
  };
  const cells = [
    { column: 'Reference', value: 'R-3027' },
    { column: 'Status', value: 'Nouvelle' },
  ];
  const rowFlow = (): RecordedFlow => ({
    ...fixture(),
    steps: [
      {
        ...step('s1', 'a1', {
          ...C,
          kind: 'click',
          target: { strategy: 'role', role: 'link', name: 'Open', row: { Reference: 'R-3024' } },
        }),
        rawEventIds: ['r1'],
      },
      step('s2', 'a2', { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Save' } }),
    ],
  });

  it('redefines the row from the recorded cells, then restores the original target', async () => {
    recording.flow = rowFlow();
    await writeFile(
      path.join(dir, 'raw-recording.json'),
      JSON.stringify({
        startedAt: '2026-10-28T10:00:00.000Z',
        rawEvents: [{ id: 'r1', element: { ...link, rowCells: cells } }],
      }),
    );
    const source = await storedRowSource(recording, 's1');
    expect(source).toMatchObject({ cells, variables: [] });
    expect(await storedRowSource(recording, 'nope')).toEqual({ error: 'step nope not found' });
    const edited = await editStoredRow(
      recording,
      { stepId: 's1', columns: [{ column: 'Reference', source: 'value', value: 'R-3027' }] },
      'fr',
    );
    expect(edited).toEqual({ ok: true, added: [] });
    expect(recording.flow.steps[0]?.step).toMatchObject({ target: { row: { Reference: 'R-3027' } } });
    expect(recording.flow.steps[0]?.userDecision).toBe('TARGET_CORRECTED_BY_USER');
    // Une nouvelle donnée demande un jeu de test : refusée sans lui, rien n'est écrit.
    expect(
      await editStoredRow(
        recording,
        {
          stepId: 's1',
          columns: [{ column: 'Status', source: 'new-variable', key: 'case.status', value: 'Nouvelle' }],
        },
        'fr',
      ),
    ).toEqual({ error: 'a new variable is created during the review only' });
    expect(await restoreStoredTarget(recording, 's1', 'fr')).toEqual({ ok: true });
    expect(recording.flow.steps[0]?.step).toMatchObject({ target: { row: { Reference: 'R-3024' } } });
    expect(recording.flow.steps[0]?.userDecision).toBeUndefined();
    expect(await restoreStoredTarget(recording, 's2', 'fr')).toEqual({
      error: 'step s2 has no correction to restore',
    });
  });

  it('proposes then applies the element picked in the browser: only the target changes', async () => {
    recording.flow = rowFlow();
    const picked = {
      element: { ...link, tag: 'button', role: 'button', name: 'Enregistrer', css: 'form button' },
    };
    const proposal = storedCorrectionProposal(recording, 's2', picked, [], 'fr');
    expect(proposal).toMatchObject({ target: { role: 'button', name: 'Enregistrer' } });
    expect(recording.flow.steps[1]?.step).toMatchObject({ target: { name: 'Save' } });
    const applied = await correctStoredTarget(recording, { stepId: 's2', picked, known: [] }, 'fr');
    expect(applied).toMatchObject({ ok: true });
    expect(recording.flow.steps[1]?.step).toMatchObject({ kind: 'click', target: { name: 'Enregistrer' } });
    expect(await readFile(path.join(dir, 'generated.flow.yaml'), 'utf8')).toContain('Enregistrer');
    expect(await correctStoredTarget(recording, { stepId: 'nope', picked, known: [] }, 'fr')).toEqual({
      error: 'step nope not found',
    });
  });

  it('reviews an intent: confirm, correct with a reason, reset; the ledger keeps everything', async () => {
    expect((await storedIntents(recording, 'fr')).rows).toEqual([]);
    expect(await reviewStoredIntent(recording, { actionId: 'a1', type: 'CONFIRM' })).toEqual({
      error: 'no application model to review',
    });
    await writeFile(
      path.join(dir, 'application-model.json'),
      JSON.stringify({
        actions: [
          {
            actionId: 'a1',
            type: 'CLICK',
            label: 'New item',
            stepIds: ['s1'],
            recorded: true,
            validation: 'VALIDATED',
            interpretation: ['CREATE'],
            confidence: 0.8,
          },
          {
            actionId: 'a3',
            type: 'CLICK',
            label: 'Save',
            stepIds: ['s3'],
            recorded: true,
            validation: 'VALIDATED',
            interpretation: ['UNKNOWN'],
          },
        ],
        evidence: [],
        summary: { actions: { recorded: 2, validated: 2, interpreted: 1 } },
      }),
    );
    const before = await storedIntents(recording, 'fr');
    expect(before.choices).toContain('SAVE');
    expect(before.rows[0]).toMatchObject({
      actionId: 'a1',
      label: 'Cliquer sur "New item"',
      intent: 'CREATE',
      status: 'INFERRED',
      source: 'SYSTEM',
      confidence: 0.8,
    });
    expect(await reviewStoredIntent(recording, { actionId: 'a1', type: 'CONFIRM' })).toEqual({ ok: true });
    expect(
      await reviewStoredIntent(recording, {
        actionId: 'a3',
        type: 'CORRECT',
        intent: 'SAVE',
        reason: 'le bouton enregistre',
      }),
    ).toEqual({ ok: true });
    expect(
      await reviewStoredIntent(recording, { actionId: 'a3', type: 'CORRECT', intent: 'DANCE' }),
    ).toMatchObject({
      error: expect.stringContaining('unknown intent DANCE') as string,
    });
    const after = await storedIntents(recording, 'fr');
    expect(after.rows.map((row) => [row.actionId, row.intent, row.status, row.source])).toEqual([
      ['a1', 'CREATE', 'HUMAN_CONFIRMED', 'HUMAN'],
      ['a3', 'SAVE', 'HUMAN_CORRECTED', 'HUMAN'],
    ]);
    expect(after.rows[1]).toMatchObject({ original: 'UNKNOWN', reason: 'le bouton enregistre' });
    expect(await reviewStoredIntent(recording, { actionId: 'a3', type: 'RESET' })).toEqual({ ok: true });
    expect((await storedIntents(recording, 'fr')).rows[1]).toMatchObject({
      intent: 'UNKNOWN',
      status: 'INFERRED',
    });
    const ledger = JSON.parse(await readFile(path.join(dir, 'human-review.json'), 'utf8')) as {
      decisions: unknown[];
    };
    expect(ledger.decisions).toHaveLength(3);
  });
});
