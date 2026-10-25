import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { flowSchema } from '../../src/config/flow-schema.js';
import type { RecordedFlow, RecordedFlowStep } from '../../src/recording/model.js';
import { emptyQuality } from '../../src/recording/model.js';
import { generateFlowFiles } from '../../src/recording/recorded-flow.js';
import {
  applyGroupCommand,
  dependencyViolations,
  flowForGroups,
  groupViews,
  groupsForYaml,
  stepDependencies,
} from '../../src/recording/step-groups.js';

/**
 * GROUPES MÉTIER : des objets fonctionnels sur des étapes existantes. Création, renommage, affectation,
 * déplacement, réordonnancement, repli, détachement, suppression (étapes gardées) ; les dépendances de
 * données bloquent un ordre qui citerait une valeur avant sa production ; un groupe se joue seul
 * seulement quand ses entrées sont produites en son sein ; un ancien flow sans groupe reste intact.
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

/** create (fill title, save, expect) → search (fill search citing the title, expect) → open (click row citing the title). */
function fixture(): RecordedFlow {
  return {
    name: 'create then find',
    recordingSessionId: 'rec-groups',
    startAt: '/items',
    steps: [
      step(
        's1',
        'a1',
        { ...C, kind: 'click', target: { strategy: 'role', role: 'link', name: 'New item' } },
        'open the form',
      ),
      step(
        's2',
        'a2',
        {
          ...C,
          kind: 'fill',
          target: { strategy: 'label', value: 'Title' },
          value: { testData: 'item.title' },
        },
        'type the title',
      ),
      step(
        's3',
        'a3',
        { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Save' } },
        'save',
      ),
      step(
        's4',
        'a3',
        { ...C, kind: 'expect', expect: { response: { method: 'POST', url: '/api/items', status: '2xx' } } },
        'POST accepted',
      ),
      step('s5', 'a4', { ...C, kind: 'goto', url: '/items' }, 'back to the list'),
      step(
        's6',
        'a5',
        {
          ...C,
          kind: 'fill',
          target: { strategy: 'label', value: 'Search' },
          value: { testData: 'item.title' },
        },
        'search the title',
      ),
      step(
        's7',
        'a5',
        { ...C, kind: 'expect', expect: { text: '${testData:item.title}' } },
        'the title is listed',
      ),
      step(
        's8',
        'a6',
        {
          ...C,
          kind: 'click',
          target: { strategy: 'role', role: 'cell', name: 'Open', row: { Title: '${testData:item.title}' } },
        },
        'open the item',
      ),
    ],
    assertions: [],
    intent: { transitions: [], confidence: 0, evidence: [] },
    negative: false,
    quality: emptyQuality(),
  };
}

const order = (flow: RecordedFlow): string => flow.steps.map((item) => item.id).join(',');

describe('step groups — dependencies', () => {
  it('finds who produces and who consumes each test data key', () => {
    const dependencies = stepDependencies(fixture());
    expect(dependencies.find((entry) => entry.stepId === 's2')).toEqual({
      stepId: 's2',
      consumes: [],
      produces: ['item.title'],
    });
    expect(dependencies.find((entry) => entry.stepId === 's6')?.consumes).toEqual(['item.title']);
    expect(dependencies.find((entry) => entry.stepId === 's8')?.consumes).toEqual(['item.title']);
    expect(dependencyViolations(fixture().steps)).toEqual([]);
  });
});

describe('step groups — operations', () => {
  it('creates, renames, describes, assigns, collapses, unlinks and deletes while keeping the steps and their ids', () => {
    const flow = fixture();
    expect(
      applyGroupCommand(flow, { op: 'create', name: 'Create the item', stepIds: ['s1', 's2', 's3'] }),
    ).toEqual({ ok: true, warnings: [] });
    expect(applyGroupCommand(flow, { op: 'create', name: 'Find the item', stepIds: ['s6', 's8'] })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(flow.groups?.map((group) => [group.id, group.name, group.stepIds])).toEqual([
      // La vérification s4 suit son action s3 : elle entre avec elle ; s7 avec s6.
      ['g1', 'Create the item', ['s1', 's2', 's3', 's4']],
      ['g2', 'Find the item', ['s6', 's7', 's8']],
    ]);
    expect(applyGroupCommand(flow, { op: 'create', name: 'Find the item' })).toEqual({
      error: 'a group named "Find the item" already exists',
    });
    expect(applyGroupCommand(flow, { op: 'rename', groupId: 'g2', name: 'Search' })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(
      applyGroupCommand(flow, {
        op: 'describe',
        groupId: 'g2',
        description: 'the created item is found again',
      }),
    ).toEqual({ ok: true, warnings: [] });
    expect(flow.groups?.[1]).toMatchObject({
      name: 'Search',
      description: 'the created item is found again',
    });
    // Affecter la navigation au groupe de recherche : l'ordre du flow ne change pas (elle est déjà entre les deux).
    expect(applyGroupCommand(flow, { op: 'assign', groupId: 'g2', stepIds: ['s5'] })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(flow.groups?.[1]?.stepIds).toEqual(['s5', 's6', 's7', 's8']);
    expect(order(flow)).toBe('s1,s2,s3,s4,s5,s6,s7,s8');
    expect(applyGroupCommand(flow, { op: 'collapse', groupId: 'g1', collapsed: true })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(flow.groups?.[0]?.collapsed).toBe(true);
    expect(applyGroupCommand(flow, { op: 'detach', stepIds: ['s1'] })).toEqual({ ok: true, warnings: [] });
    expect(flow.groups?.[0]?.stepIds).toEqual(['s2', 's3', 's4']);
    // Supprimer un groupe garde ses étapes (par défaut) ; les identifiants n'ont jamais changé.
    expect(applyGroupCommand(flow, { op: 'delete', groupId: 'g1' })).toEqual({ ok: true, warnings: [] });
    expect(flow.groups?.map((group) => group.id)).toEqual(['g2']);
    expect(order(flow)).toBe('s1,s2,s3,s4,s5,s6,s7,s8');
    expect(applyGroupCommand(flow, { op: 'delete', groupId: 'g2', keepSteps: false })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(order(flow)).toBe('s1,s2,s3,s4');
    expect(flow.groups).toBeUndefined();
  });

  it('moves a step with its checks, reorders steps and groups, and blocks an order that uses a value before it exists', () => {
    const flow = fixture();
    applyGroupCommand(flow, { op: 'create', name: 'Create', stepIds: ['s1', 's2', 's3'] });
    applyGroupCommand(flow, { op: 'create', name: 'Find', stepIds: ['s5', 's6', 's8'] });
    // Déplacer l'action « save » avant la saisie du titre : rien ne l'interdit (aucune donnée citée).
    expect(applyGroupCommand(flow, { op: 'move-step', stepId: 's3', direction: 'up' })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(order(flow)).toBe('s1,s3,s4,s2,s5,s6,s7,s8');
    expect(applyGroupCommand(flow, { op: 'move-step', stepId: 's3', direction: 'down' })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(order(flow)).toBe('s1,s2,s3,s4,s5,s6,s7,s8');
    // Remonter la recherche (s6, qui cite le titre) au-dessus de la saisie qui le produit : BLOQUÉ, avec la raison.
    const blocked = applyGroupCommand(flow, {
      op: 'reorder-steps',
      groupId: 'g2',
      stepIds: ['s6', 's5', 's8'],
    });
    expect(blocked).toEqual({ ok: true, warnings: [] });
    expect(order(flow)).toBe('s1,s2,s3,s4,s6,s7,s5,s8');
    const swap = applyGroupCommand(flow, { op: 'move-group', groupId: 'g2', direction: 'up' });
    expect('error' in swap ? swap.error : '').toContain('before step s2 produces it');
    expect('violations' in swap && swap.violations?.map((entry) => entry.key)).toEqual([
      'item.title',
      'item.title',
      'item.title',
    ]);
    expect(order(flow)).toBe('s1,s2,s3,s4,s6,s7,s5,s8');
    expect(flow.groups?.map((group) => group.id)).toEqual(['g1', 'g2']);
    // Forcer : l'ordre est appliqué, la violation devient un avertissement.
    const forced = applyGroupCommand(
      flow,
      { op: 'move-group', groupId: 'g2', direction: 'up' },
      { force: true },
    );
    expect('ok' in forced ? forced.warnings.join(' ') : '').toContain('uses testData.item.title before');
    expect(flow.groups?.map((group) => group.id)).toEqual(['g2', 'g1']);
    expect(order(flow)).toBe('s6,s7,s5,s8,s1,s2,s3,s4');
    // Un déplacement entre groupes change l'appartenance.
    expect(applyGroupCommand(flow, { op: 'move-step', stepId: 's1', direction: 'up' })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(flow.groups?.find((group) => group.id === 'g2')?.stepIds).toContain('s1');
    expect(applyGroupCommand(flow, { op: 'move-step', stepId: 's999', direction: 'up' })).toEqual({
      error: 'unknown step s999',
    });
  });
});

describe('step groups — views, YAML and isolated execution', () => {
  it('exposes inputs, outputs, checks and whether a group can run alone', () => {
    const flow = fixture();
    applyGroupCommand(flow, { op: 'create', name: 'Create', stepIds: ['s1', 's2', 's3'] });
    applyGroupCommand(flow, { op: 'create', name: 'Find', stepIds: ['s5', 's6', 's8'] });
    const [create, find] = groupViews(flow);
    expect(create).toMatchObject({
      positions: [1, 2, 3, 4],
      data: { inputs: [], outputs: [{ key: 'item.title', consumerStepIds: ['s6', 's7', 's8'] }] },
      startAt: '/items',
      checks: ['POST accepted'],
      runnableAlone: { ok: true, missing: [] },
    });
    expect(find).toMatchObject({
      data: { inputs: [{ key: 'item.title', producerStepId: 's2', producerGroupId: 'g1' }], outputs: [] },
      startAt: '/items',
      checks: ['the title is listed'],
      runnableAlone: { ok: false, missing: ['testData.item.title (produced by step s2)'] },
    });
    // Jouer « Find » seul : refusé (une entrée manque), sauf en forçant ; les deux ensemble : un flow complet.
    const refused = flowForGroups(flow, ['g2']);
    expect('error' in refused ? refused.error : '').toContain('testData.item.title');
    expect('error' in refused ? refused.missing : []).toEqual(['testData.item.title']);
    const alone = flowForGroups(flow, ['g2'], { force: true });
    expect('flow' in alone && alone.flow.steps.map((item) => item.id)).toEqual(['s5', 's6', 's7', 's8']);
    const both = flowForGroups(flow, ['g1', 'g2']);
    expect('flow' in both && both.flow).toMatchObject({ name: 'Create + Find', startAt: '/items' });
    expect('flow' in both && both.flow.steps.map((item) => item.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
    ]);
  });

  it('writes the groups into the YAML as step positions, valid for the flow schema; a flow without groups is unchanged', async () => {
    const plain = fixture();
    const before = generateFlowFiles(plain, { language: 'en', recordedAt: '2026-01-01T00:00:00.000Z' }).yaml;
    expect(before).not.toContain('groups:');
    expect(groupsForYaml(plain)).toEqual([]);
    const flow = fixture();
    applyGroupCommand(flow, {
      op: 'create',
      name: 'Create',
      description: 'the form',
      stepIds: ['s1', 's2', 's3'],
    });
    applyGroupCommand(flow, { op: 'create', name: 'Find', stepIds: ['s6', 's8'] });
    const files = generateFlowFiles(flow, { language: 'en', recordedAt: '2026-01-01T00:00:00.000Z' });
    expect(files.yaml).toContain('groups:');
    const yaml = (await import('yaml')).parse(files.yaml) as Record<string, unknown>;
    const parsed = flowSchema.parse(yaml);
    expect(parsed.groups).toEqual([
      { id: 'g1', name: 'Create', description: 'the form', steps: [1, 2, 3, 4] },
      { id: 'g2', name: 'Find', steps: [6, 7, 8] },
    ]);
    // Le YAML d'avant les groupes est le même, à la clé `groups` près.
    expect(files.yaml.split('groups:')[0]).toBe(before);
    expect(() => flowSchema.parse({ ...yaml, groups: [{ id: 'g9', name: 'x', steps: [99] }] })).toThrow(
      /beyond the last step/,
    );
  });
});
