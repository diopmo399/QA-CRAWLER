import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { gherkinFlows } from '../../src/flows/gherkin/gherkin-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { flowSchema } from '../../src/config/flow-schema.js';
import { addDataCheck, decideProposal } from '../../src/recording/assertion-proposals.js';
import type { RecordedFlow, RecordedFlowStep } from '../../src/recording/model.js';
import { emptyQuality } from '../../src/recording/model.js';
import { generateFlowFiles } from '../../src/recording/recorded-flow.js';
import {
  acceptGroupProposals,
  applyGroupCommand,
  type BusinessStepRef,
  groupCheckSuggestions,
  proposeGroups,
} from '../../src/recording/step-groups.js';

/**
 * ORGANISATION PROPOSÉE : des groupes déduits des étapes métier reconnues (jamais appliqués sans
 * décision, jamais quand l'humain a déjà organisé, l'ordre des étapes intact), et une vérification de
 * groupe (la donnée reçue d'un autre groupe est visible à sa fin) écrite comme une étape `expect` qui
 * CITE la donnée — jamais la valeur enregistrée.
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

/** create (s1–s4) → search (s5–s7) → open (s8) ; s9 : un clic de fin, hors de toute étape métier. */
function fixture(): RecordedFlow {
  return {
    name: 'create then find',
    recordingSessionId: 'rec-proposals',
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
      step('s4', 'a3', { ...C, kind: 'expect', expect: { url: '/items' } }),
      step('s5', 'a4', { ...C, kind: 'goto', url: '/items' }),
      step('s6', 'a5', {
        ...C,
        kind: 'fill',
        target: { strategy: 'label', value: 'Search' },
        value: { testData: 'item.title' },
      }),
      step('s7', 'a6', { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Search' } }),
      step('s8', 'a7', {
        ...C,
        kind: 'click',
        target: { strategy: 'role', role: 'link', name: '${testData:item.title}' },
      }),
      step('s9', 'a8', { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Close' } }),
    ],
    assertions: [],
    intent: { transitions: [], confidence: 0, evidence: [] },
    negative: false,
    quality: emptyQuality(),
  };
}

const business = (
  action: string,
  recordedActions: string[],
  status = 'CONFIRMED',
  entity?: string,
): BusinessStepRef => ({
  action,
  ...(entity ? { entity } : {}),
  status,
  confidence: status === 'CONFIRMED' ? 0.9 : 0.7,
  businessEventId: `b-${action}`,
  recordedActions,
});

const BUSINESS = [
  business('create', ['s3'], 'CONFIRMED', 'item'),
  business('search', ['s7'], 'PROBABLE', 'item'),
  business('open', ['s8'], 'PROBABLE', 'item'),
];

describe('group proposals', () => {
  it('cuts the journey at each reliable business step, in the flow order, steps untouched', () => {
    const flow = fixture();
    const before = flow.steps.map((item) => item.id).join(',');
    const proposals = proposeGroups(flow, BUSINESS, 'fr');
    expect(
      proposals.map((proposal) => [proposal.name, proposal.stepIds, proposal.from, proposal.to]),
    ).toEqual([
      // Numéros des actions (la vérification s4 n'est pas numérotée).
      ['Création — item', ['s1', 's2', 's3'], 1, 3],
      ['Recherche — item', ['s5', 's6', 's7'], 4, 6],
      ['Ouverture — item', ['s8'], 7, 7],
    ]);
    // Proposer ne change rien au flow.
    expect(flow.steps.map((item) => item.id).join(',')).toBe(before);
    expect(flow.groups).toBeUndefined();
    expect(proposeGroups(flow, BUSINESS, 'en').map((proposal) => proposal.name)).toEqual([
      'Creation — item',
      'Search — item',
      'Opening — item',
    ]);
  });

  it('ignores ambiguous or unknown business steps, and steps that are not in the flow', () => {
    const proposals = proposeGroups(
      fixture(),
      [
        business('create', ['s3']),
        business('search', ['s7'], 'AMBIGUOUS'),
        business('open', ['s8'], 'UNKNOWN'),
        business('delete', ['s404']),
      ],
      'fr',
    );
    // Un seul segment ne couvre pas tout : il est proposé, le reste reste hors groupe.
    expect(proposals.map((proposal) => [proposal.name, proposal.stepIds])).toEqual([
      ['Création', ['s1', 's2', 's3']],
    ]);
  });

  it('proposes nothing when the human already organised the flow, or when one segment would cover everything', () => {
    const grouped = fixture();
    applyGroupCommand(grouped, { op: 'create', name: 'Mine', stepIds: ['s1'] });
    expect(proposeGroups(grouped, BUSINESS)).toEqual([]);
    expect(proposeGroups(fixture(), [business('save', ['s9'])])).toEqual([]);
    expect(proposeGroups(fixture(), [])).toEqual([]);
  });

  it('numbers two segments with the same name', () => {
    const names = proposeGroups(
      fixture(),
      [business('search', ['s3']), business('search', ['s7'])],
      'en',
    ).map((proposal) => proposal.name);
    expect(names).toEqual(['Search', 'Search 2']);
  });

  it('a verification follows its action into the proposed group', () => {
    const flow = fixture();
    const outcome = acceptGroupProposals(flow, proposeGroups(flow, BUSINESS, 'fr'));
    expect(outcome).toEqual({ ok: true, warnings: [] });
    expect(flow.groups?.map((group) => [group.name, group.stepIds])).toEqual([
      ['Création — item', ['s1', 's2', 's3', 's4']],
      ['Recherche — item', ['s5', 's6', 's7']],
      ['Ouverture — item', ['s8']],
    ]);
    // L'ordre n'a pas bougé ; s9 reste hors groupe.
    expect(flow.steps.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
    expect(acceptGroupProposals(flow, proposeGroups(fixture(), BUSINESS))).toEqual({
      error: 'the flow already has groups',
    });
    expect(acceptGroupProposals(fixture(), [])).toEqual({ error: 'no group to propose' });
  });
});

describe('group checks', () => {
  const organised = (): RecordedFlow => {
    const flow = fixture();
    acceptGroupProposals(flow, proposeGroups(flow, BUSINESS, 'fr'));
    return flow;
  };

  it('suggests, per group, the data it receives from another group — never the data it produces itself', () => {
    expect(groupCheckSuggestions(organised())).toEqual([
      // La création produit item.title : après « Save », l'écran a changé ; rien n'est suggéré pour elle.
      { groupId: 'g2', groupName: 'Recherche — item', key: 'item.title', role: 'input', afterStepId: 's7' },
      { groupId: 'g3', groupName: 'Ouverture — item', key: 'item.title', role: 'input', afterStepId: 's8' },
    ]);
    expect(groupCheckSuggestions(fixture())).toEqual([]);
  });

  it('writes an expect step that CITES the data after the last action of the group, then stops suggesting it', () => {
    const flow = organised();
    const outcome = addDataCheck(flow, {
      afterStepId: 's7',
      key: 'item.title',
      groupName: 'Recherche — item',
    });
    expect(outcome).toEqual({ ok: true, proposalId: 'p1' });
    const index = flow.steps.findIndex((item) => item.id === 's7');
    const added = flow.steps[index + 1];
    expect(added?.step).toEqual({ ...C, kind: 'expect', expect: { text: '${testData:item.title}' } });
    expect(added?.provenance).toBe('HUMAN_DECISION');
    expect(flow.proposals?.[0]).toMatchObject({
      id: 'p1',
      origin: 'EXPLICIT',
      status: 'APPROVED',
      verificationMethod: 'UI_EXPECT',
      afterStepId: 's7',
    });
    // L'étape rejoint le groupe de son action.
    expect(flow.groups?.find((group) => group.id === 'g2')?.stepIds).toContain(added?.id);
    expect(groupCheckSuggestions(flow).map((entry) => entry.groupId)).toEqual(['g3']);
    // Deux fois la même vérification : refusée.
    expect(addDataCheck(flow, { afterStepId: 's7', key: 'item.title' })).toEqual({
      error: 'testData.item.title is already checked after step s7',
    });
    // Le YAML est valide et cite la donnée ; jamais une valeur enregistrée.
    const files = generateFlowFiles(flow, { language: 'fr', recordedAt: '2026-10-26T00:00:00.000Z' });
    expect(files.yaml).toContain('${testData:item.title}');
    expect(() => flowSchema.parse(parseYaml(files.yaml))).not.toThrow();
    // Le .feature dit la vérification par la donnée citée, et le moteur Gherkin la relit comme telle.
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-group-check-'));
    writeFileSync(path.join(dir, 'flow.feature'), files.feature);
    const [scenario] = gherkinFlows({ gherkin: 'flow.feature' }, dir) as {
      steps: Record<string, unknown>[];
    }[];
    // La phrase garde sa ligne dans le .feature (relie le journal d'un run au fichier).
    expect(scenario?.steps).toContainEqual({
      name: 'Alors je vois "${testData:item.title}"',
      expect: { text: '${testData:item.title}' },
      sourceLine: expect.any(Number) as number,
    });
  });

  it('is removed like any decision, and refuses an unknown step or an invalid key', () => {
    const flow = organised();
    addDataCheck(flow, { afterStepId: 's7', key: 'item.title' });
    const count = flow.steps.length;
    expect(decideProposal(flow, { id: 'p1', decision: 'REJECT' })).toEqual({ ok: true });
    expect(flow.steps.length).toBe(count - 1);
    expect(addDataCheck(flow, { afterStepId: 's4', key: 'item.title' })).toEqual({
      error: 'unknown action step s4',
    });
    expect(addDataCheck(flow, { afterStepId: 's7', key: 'bad key!' })).toEqual({
      error: 'invalid test data key bad key!',
    });
  });
});
