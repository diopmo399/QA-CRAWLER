import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { TestDataSet } from '../../src/data/test-data-set.js';
import type { RecordedFlow, RecordedFlowStep } from '../../src/recording/model.js';
import { emptyQuality } from '../../src/recording/model.js';
import { generateFlowFiles } from '../../src/recording/recorded-flow.js';
import { applyGroupCommand } from '../../src/recording/step-groups.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import {
  checkCompositionOf,
  compareWithSource,
  listLibrary,
  publishGroupExtraction,
  updateFromSource,
  validateVersion,
  blockDetails,
  LibraryError,
} from '../../src/sdk/server/library.js';
import {
  planExtraction,
  revisionOfText,
  validateBlockFlow,
  type ExtractionSource,
} from '../../src/sdk/server/library-extract.js';
import { flowsDirOf } from '../../src/sdk/server/platform.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * L'EXTRACTION DE GROUPES MÉTIER VERS LA BIBLIOTHÈQUE, sur un enregistrement à trois groupes dont les
 * données passent de l'un à l'autre (« Create » produit item.title ; « Find » et « Open » le
 * consomment). Un groupe, plusieurs, tous ; un bloc par groupe ou un bloc composé ; une partie d'un
 * groupe ; une valeur fournie ; la navigation ajoutée ; la validation localisée ; la publication tout ou
 * rien, sa provenance, sa version ; la comparaison avec la source et la mise à jour contrôlée.
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

function recordedFlow(): RecordedFlow {
  const flow: RecordedFlow = {
    name: 'create then find',
    recordingSessionId: 'rec-extract',
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
      step('s4', 'a3', { ...C, kind: 'expect', expect: { text: 'Saved' } }, 'saved'),
      step('s5', 'a4', { ...C, kind: 'goto', url: '/items' }, 'back to the list'),
      step(
        's6',
        'a5',
        {
          ...C,
          kind: 'fill',
          target: { strategy: 'label', value: 'Search' },
          value: '${testData:item.title}',
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
        { ...C, kind: 'click', target: { strategy: 'role', role: 'link', name: '${testData:item.title}' } },
        'open the item',
      ),
    ],
    assertions: [],
    intent: { transitions: [], confidence: 0, evidence: [] },
    negative: false,
    quality: emptyQuality(),
  };
  expect(
    applyGroupCommand(flow, { op: 'create', name: 'Create the item', stepIds: ['s1', 's2', 's3'] }),
  ).toMatchObject({ ok: true });
  expect(
    applyGroupCommand(flow, { op: 'create', name: 'Find the item', stepIds: ['s5', 's6'] }),
  ).toMatchObject({ ok: true });
  expect(applyGroupCommand(flow, { op: 'create', name: 'Open the item', stepIds: ['s8'] })).toMatchObject({
    ok: true,
  });
  return flow;
}

const DATA: TestDataSet = {
  id: 'rec',
  name: 'rec',
  source: 'HUMAN_RECORDING',
  values: {
    'item.title': { key: 'item.title', strategy: 'GENERATE_AT_REPLAY', generator: 'words', sensitive: false },
    'unused.note': {
      key: 'unused.note',
      strategy: 'BUSINESS_LITERAL',
      value: 'never typed',
      sensitive: false,
    },
  },
};

function sourceOf(flow = recordedFlow(), patch?: (yaml: Record<string, unknown>) => void): ExtractionSource {
  const text = generateFlowFiles(flow, { language: 'en', recordedAt: '2026-01-01T00:00:00.000Z' }).yaml;
  const yaml = parseYaml(text) as Record<string, unknown>;
  patch?.(yaml);
  return { name: 'create-then-find', flow, yaml, data: DATA, revision: revisionOfText(JSON.stringify(yaml)) };
}

const plan = (input: Parameters<typeof planExtraction>[1], source = sourceOf(), taken: string[] = []) =>
  planExtraction(source, input, { taken });

describe('extraction plan — selection and dependencies', () => {
  it('lists the groups of the recording with their steps, data produced and consumed, and their producer', () => {
    const { plan: result } = plan({ selection: [{ groupId: 'g2' }], mode: 'separate' });
    expect(result.groups.map((group) => [group.id, group.name, group.steps, group.runnableAlone])).toEqual([
      ['g1', 'Create the item', 4, true],
      ['g2', 'Find the item', 3, false],
      ['g3', 'Open the item', 1, false],
    ]);
    expect(result.groups[0]?.produces).toEqual(['item.title']);
    expect(result.groups[1]?.consumes).toEqual([
      { key: 'item.title', groupId: 'g1', groupName: 'Create the item' },
    ]);
  });

  it('one group whose input comes from an unselected group: a required input, said, never a copied value', () => {
    const { plan: result, drafts } = plan({ selection: [{ groupId: 'g2' }], mode: 'separate' });
    const block = result.blocks[0];
    expect(block?.name).toBe('Find the item');
    expect(block?.data).toEqual([]);
    expect(drafts[0]?.data).toBeUndefined();
    expect(block?.contract.inputs).toEqual([{ key: 'item.title', required: true }]);
    expect(block?.dependencies).toEqual([
      { key: 'item.title', source: 'UNSELECTED_GROUP', group: { id: 'g1', name: 'Create the item' } },
    ]);
    expect(block?.validation.ok).toBe(true);
    expect(block?.validation.warnings.join(' ')).toContain(
      'produced by the group "Create the item", which is not chosen',
    );
    expect(result.summary.external).toEqual(['item.title']);
    expect(result.ok).toBe(true);
  });

  it('several groups, one block each: the producer keeps the data, the consumer depends on that block', () => {
    const { plan: result, drafts } = plan({
      selection: [{ groupId: 'g2' }, { groupId: 'g1' }],
      mode: 'separate',
    });
    // Dans l'ordre de l'enregistrement, quel que soit l'ordre choisi.
    expect(result.blocks.map((block) => block.name)).toEqual(['Create the item', 'Find the item']);
    expect(result.blocks[0]?.data).toEqual([{ key: 'item.title', dynamic: true }]);
    expect(result.blocks[0]?.produces).toEqual(['item.title']);
    expect(Object.keys(drafts[0]?.data?.values ?? {})).toEqual(['item.title']);
    expect(result.blocks[1]?.dependencies).toEqual([
      { key: 'item.title', source: 'BLOCK', block: 'Create the item' },
    ]);
    expect(result.summary).toMatchObject({ groups: 2, steps: 7, produced: 1, consumed: 1, external: [] });
  });

  it('all the groups, one composed block: the internal groups and their ids are kept, no dependency left', () => {
    const { plan: result, drafts } = plan({
      selection: [{ groupId: 'g1' }, { groupId: 'g2' }, { groupId: 'g3' }],
      mode: 'composite',
      names: { composite: { name: 'Create and find an item', description: 'The whole journey' } },
    });
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0];
    expect(block).toMatchObject({ name: 'Create and find an item', composite: true, dependencies: [] });
    expect(block?.groups.map((group) => group.id)).toEqual(['g1', 'g2', 'g3']);
    expect(drafts[0]?.flow.groups).toEqual([
      { id: 'g1', name: 'Create the item', steps: [1, 2, 3, 4] },
      { id: 'g2', name: 'Find the item', steps: [5, 6, 7] },
      { id: 'g3', name: 'Open the item', steps: [8] },
    ]);
    expect(drafts[0]?.stepIds).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    // Une donnée jamais utilisée par les étapes ne suit pas.
    expect(Object.keys(drafts[0]?.data?.values ?? {})).toEqual(['item.title']);
    expect(block?.validation).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('a part of a group: refused when a check would lose its action, accepted otherwise', () => {
    const broken = plan({ selection: [{ groupId: 'g1', stepIds: ['s1', 's4'] }], mode: 'separate' }).plan;
    expect(broken.ok).toBe(false);
    expect(broken.errors.join(' ')).toContain(
      'the check "saved" follows the action "save", which is not chosen',
    );
    const part = plan({ selection: [{ groupId: 'g1', stepIds: ['s1', 's2'] }], mode: 'separate' }).plan;
    expect(part.ok).toBe(true);
    expect(part.blocks[0]?.groups[0]).toMatchObject({ id: 'g1', partial: true, steps: 2 });
    expect(part.blocks[0]?.steps.map((entry) => entry.stepId)).toEqual(['s1', 's2']);
  });

  it('a value provided explicitly for an input: kept, said, and refused for a sensitive key', () => {
    const { plan: result } = plan({
      selection: [{ groupId: 'g3' }],
      mode: 'separate',
      provided: { 'item.title': 'Lamp' },
    });
    expect(result.blocks[0]?.data).toEqual([{ key: 'item.title', dynamic: false, provided: true }]);
    expect(result.blocks[0]?.dependencies).toEqual([{ key: 'item.title', source: 'PROVIDED' }]);
    expect(result.blocks[0]?.transformations).toContain('value of item.title provided at publication');
    expect(result.blocks[0]?.contract.inputs).toEqual([]);
    const secret = recordedFlow();
    const s8 = secret.steps[7];
    if (s8)
      s8.step = {
        ...C,
        kind: 'click',
        target: { strategy: 'role', role: 'link', name: '${testData:user.password}' },
      };
    const refused = plan(
      { selection: [{ groupId: 'g3' }], mode: 'separate', provided: { 'user.password': 'x' } },
      sourceOf(secret),
    ).plan;
    expect(refused.ok).toBe(false);
    expect(refused.errors.join(' ')).toContain('user.password is sensitive');
  });

  it('navigation: a block that starts mid-recording says so; asked, it starts with a goto (a noted transformation)', () => {
    const plain = plan({ selection: [{ groupId: 'g3' }], mode: 'separate' }).plan.blocks[0];
    expect(plain?.validation.warnings.join(' ')).toContain('its start page /items is not visited');
    expect(plain?.midway).toBe(true);
    const { plan: result, drafts } = plan({
      selection: [{ groupId: 'g3' }],
      mode: 'separate',
      navigate: true,
    });
    const steps = drafts[0]?.flow.steps as Record<string, unknown>[];
    expect(steps[0]).toEqual({ goto: '/items' });
    expect(Object.keys(steps[1] ?? {})).toContain('click');
    expect(steps).toHaveLength(2);
    expect(result.blocks[0]?.transformations).toContain('starts with goto /items (its start page)');
    expect(result.blocks[0]?.midway).toBe(false);
    expect(result.blocks[0]?.steps[1]).toMatchObject({ position: 2, source: 8, stepId: 's8' });
  });
});

describe('extraction plan — validation before publication', () => {
  it('an invalid step is located (its rank and kind), a taken or duplicated name is refused', () => {
    const broken = sourceOf(undefined, (yaml) => {
      const steps = yaml.steps as Record<string, unknown>[];
      steps[5] = { fill: { placeholder: 'Search', value: '${testData:item.title}' } };
    });
    const result = plan({ selection: [{ groupId: 'g2' }], mode: 'separate' }, broken).plan;
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.validation.errors.join(' ')).toMatch(/step 2 \(fill\)/);
    const taken = plan({ selection: [{ groupId: 'g1' }], mode: 'separate' }, sourceOf(), [
      'Create the item',
    ]).plan;
    expect(taken.blocks[0]?.validation.errors).toContain(
      'a scenario or a block is already named "Create the item"',
    );
    const twice = plan({
      selection: [{ groupId: 'g1' }, { groupId: 'g2' }],
      mode: 'separate',
      names: { g1: { name: 'Same' }, g2: { name: 'Same' } },
    }).plan;
    expect(twice.blocks[0]?.validation.errors).toContain('two blocks of this publication are named "Same"');
    expect(plan({ selection: [{ groupId: 'nope' }], mode: 'separate' }).plan.errors).toContain(
      'no group nope in the recording create-then-find',
    );
  });

  it('validateBlockFlow: the flow schema, a run step left to the library, the test data', () => {
    expect(
      validateBlockFlow({ name: 'ok', reusable: true, steps: [{ goto: '/a' }, { run: 'Other' }] }),
    ).toEqual([]);
    expect(validateBlockFlow({ name: 'ko', steps: [{ click: { placeholder: 'x' } }] })[0]).toMatch(
      /^step 1 \(click\)/,
    );
  });
});

describe('publication, provenance, comparison with the source (project on disk)', () => {
  let workspace: string;
  let server: RunningSdkServer;
  let client: QaCrawlerClient;
  let project: Project;
  let projectDir: string;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'qa-extract-'));
    server = await startSdkServer({ workspace, language: 'en' });
    client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    project = await client.projects.create({
      ...engineDefaults(),
      project: { name: 'Extraction', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
    });
    projectDir = path.join(workspace, project.id);
  });

  afterAll(async () => {
    client.dispose();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it('all or nothing: one invalid block of the publication, no block written', async () => {
    const broken = sourceOf(undefined, (yaml) => {
      const steps = yaml.steps as Record<string, unknown>[];
      steps[5] = { fill: { placeholder: 'Search', value: '${testData:item.title}' } };
    });
    await expect(
      publishGroupExtraction(projectDir, broken, {
        selection: [{ groupId: 'g1' }, { groupId: 'g2' }],
        mode: 'separate',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await listLibrary(projectDir)).toEqual([]);
  });

  it('publishes one block per group: version 1, provenance kept, data restricted, composable in order only', async () => {
    const blocks = await publishGroupExtraction(
      projectDir,
      sourceOf(),
      { selection: [{ groupId: 'g1' }, { groupId: 'g2' }], mode: 'separate' },
      'Alex',
    );
    expect(blocks.map((block) => [block.name, block.version, block.state])).toEqual([
      ['Create the item', 1, 'VALID'],
      ['Find the item', 1, 'VALID'],
    ]);
    expect(blocks[0]?.origin).toMatchObject({
      kind: 'recording',
      name: 'create-then-find',
      group: 'Create the item',
      groupIds: ['g1'],
      stepIds: ['s1', 's2', 's3', 's4'],
      mode: 'separate',
      sessionId: 'rec-extract',
      author: 'Alex',
    });
    expect(blocks[0]?.origin?.extractedAt).toBeDefined();
    expect(blocks[1]?.contract.inputs).toEqual([{ key: 'item.title', required: true }]);
    const flows = await flowsDirOf(projectDir);
    const data = await readFile(path.join(flows, 'library', 'create-the-item', 'test-data.yaml'), 'utf8');
    expect(data).toContain('title');
    expect(data).not.toContain('unused');
    expect(await readdir(path.join(flows, 'library', 'find-the-item'))).toEqual(['find-the-item.flow.yaml']);
    expect(
      (await checkCompositionOf(projectDir, { name: 'Journey', parts: ['Create the item', 'Find the item'] }))
        .ok,
    ).toBe(true);
    const reversed = await checkCompositionOf(projectDir, {
      name: 'Journey',
      parts: ['Find the item', 'Create the item'],
    });
    expect(reversed.errors.join(' ')).toContain('needs item.title, produced only later by #2');
    const details = await blockDetails(projectDir, 'Find the item');
    expect(details.steps.map((entry) => entry.kind)).toEqual(['goto', 'fill', 'expect']);
    expect(details.data).toEqual([]);
  });

  it('publishes a composed block that keeps its groups; the details show them', async () => {
    const [block] = await publishGroupExtraction(projectDir, sourceOf(), {
      selection: [{ groupId: 'g2' }, { groupId: 'g3' }],
      mode: 'composite',
      names: { composite: { name: 'Find and open' } },
    });
    expect(block?.groups).toEqual([
      { id: 'g2', name: 'Find the item', steps: 3 },
      { id: 'g3', name: 'Open the item', steps: 1 },
    ]);
    const details = await blockDetails(projectDir, 'Find and open');
    expect(details.groups.map((group) => [group.id, group.positions])).toEqual([
      ['g2', [1, 2, 3]],
      ['g3', [4]],
    ]);
    expect(details.steps.map((entry) => entry.groupId)).toEqual(['g2', 'g2', 'g2', 'g3']);
  });

  it('compares with the recording, never changes silently, updates on demand into a version to validate', async () => {
    const load = (flow: RecordedFlow) => (name: string) =>
      Promise.resolve(name === 'create-then-find' ? sourceOf(flow) : undefined);
    expect(await compareWithSource(projectDir, 'Create the item', load(recordedFlow()))).toMatchObject({
      status: 'SAME',
    });
    const edited = recordedFlow();
    const s3 = edited.steps[2];
    if (s3)
      s3.step = { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Save the item' } };
    const comparison = await compareWithSource(projectDir, 'Create the item', load(edited));
    expect(comparison.status).toBe('DIFFERENT');
    expect(comparison.changes.join(' ')).toContain('step 3 changed');
    // Rien n'a bougé dans le bloc tant que la mise à jour n'est pas demandée.
    expect((await listLibrary(projectDir)).find((block) => block.name === 'Create the item')?.state).toBe(
      'VALID',
    );
    const updated = await updateFromSource(projectDir, 'Create the item', load(edited));
    expect(updated.state).toBe('CHANGED');
    expect(updated.history.at(-1)?.change).toContain(
      'content taken again from the recording create-then-find',
    );
    expect((await validateVersion(projectDir, 'Create the item')).version).toBe(2);
    expect(await compareWithSource(projectDir, 'Create the item', load(edited))).toMatchObject({
      status: 'SAME',
    });
    const missing = await compareWithSource(projectDir, 'Create the item', () => Promise.resolve(undefined));
    expect(missing.status).toBe('SOURCE_MISSING');
    await expect(updateFromSource(projectDir, 'Create the item', load(edited))).rejects.toBeInstanceOf(
      LibraryError,
    );
  });

  it('an existing block whose flow breaks the schema is INVALID (it no longer composes)', async () => {
    const flows = await flowsDirOf(projectDir);
    await mkdir(path.join(flows, 'library', 'broken'), { recursive: true });
    await writeFile(
      path.join(flows, 'library', 'broken', 'broken.flow.yaml'),
      'name: Broken\nreusable: true\nsteps:\n  - fill: { placeholder: Search, value: x }\n',
    );
    const broken = (await listLibrary(projectDir)).find((block) => block.name === 'Broken');
    expect(broken?.state).toBe('INVALID');
    expect(broken?.problems.join(' ')).toMatch(/step 1 \(fill\)/);
    expect((await checkCompositionOf(projectDir, { name: 'X', parts: ['Broken'] })).ok).toBe(false);
  });
});
