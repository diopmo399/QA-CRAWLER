import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { RecordedFlow, RecordedFlowStep } from '../../src/recording/model.js';
import { emptyQuality } from '../../src/recording/model.js';
import {
  acceptStoredGroupProposals,
  addStoredGroupCheck,
  dropFlowStep,
  removeStoredStep,
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
