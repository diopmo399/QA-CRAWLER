import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { generateGherkinFeature } from '../../src/platform/gherkin-feature-generator.js';
import {
  applyExecution,
  planGeneration,
  planSummary,
  validateArtifacts,
  writeArtifacts,
} from '../../src/platform/generation-plan.js';
import { decideProposal } from '../../src/recording/assertion-proposals.js';
import { GherkinStepDictionary } from '../../src/flows/gherkin/gherkin-steps.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import {
  emptyQuality,
  type RecordedFlow,
  type RecordedFlowStep,
  type RecordingSession,
} from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';
import { applyGroupCommand } from '../../src/recording/step-groups.js';

/**
 * LE PLAN DE GÉNÉRATION : du flow enregistré (groupes, propositions acceptées) aux artefacts des
 * formats demandés, chacun avec un statut honnête (généré, validé statiquement par un outil réel,
 * non validé quand l'outil manque, exécuté seulement d'après une exécution réelle) ; un groupe qui
 * dépend de données produites ailleurs n'est pas généré seul sans le dire.
 */
const { config } = parseConfig(
  'mission: { name: rec }\ntarget: { baseUrl: "http://app.test", startAt: /items }\n',
  {},
  {},
);

function element(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: 'input',
    role: 'textbox',
    name,
    label: name,
    css: `input.${name.toLowerCase()}`,
    cssStable: false,
    inForm: true,
    isSubmit: false,
    inNavigation: false,
    inDialog: false,
    sameRoleName: 1,
    roleNameIndex: 0,
    sameLabel: 1,
    ...extra,
  };
}

function recording(): ReturnType<typeof processRecording> {
  const session = {
    id: 'rec-plan',
    name: 'Create then find',
    startedAt: '2026-01-01T00:00:00.000Z',
    startUrl: 'http://app.test/items',
    status: 'PROCESSING',
    rawEvents: [
      { id: 'r1', sequence: 1, type: 'navigation', at: 100, url: 'http://app.test/items', stateAfter: 'o1' },
      {
        id: 'r2',
        sequence: 2,
        type: 'change',
        at: 2000,
        url: 'http://app.test/items/new',
        element: element('Title'),
        value: { empty: false, length: 8, shape: 'text', digest: 'abcdef0123456789' },
        stateAfter: 'o2',
      },
      {
        id: 'r3',
        sequence: 3,
        type: 'click',
        at: 4000,
        url: 'http://app.test/items/new',
        element: {
          tag: 'button',
          role: 'button',
          name: 'Save',
          text: 'Save',
          css: 'button',
          cssStable: false,
          inForm: true,
          isSubmit: true,
          inNavigation: false,
          inDialog: false,
          sameRoleName: 1,
          roleNameIndex: 0,
          sameLabel: 1,
        },
        stateAfter: 'o3',
        network: [{ method: 'POST', path: '/api/items', status: 201 }],
      },
      {
        id: 'r4',
        sequence: 4,
        type: 'change',
        at: 6000,
        url: 'http://app.test/items',
        element: element('Search'),
        value: { empty: false, length: 8, shape: 'text', digest: 'abcdef0123456789' },
        stateAfter: 'o4',
        network: [{ method: 'GET', path: '/api/items?q=x', status: 200, listSize: 1 }],
      },
    ],
    semanticActions: [],
    checkpoints: [],
    states: [
      {
        id: 'o1',
        stateId: 'items',
        label: '/items',
        route: '/items',
        url: 'http://app.test/items',
        title: 'Items',
        headings: [],
        alerts: [],
        invalidFields: 0,
        dialogs: [],
        controls: ['button:New item'],
      },
      {
        id: 'o2',
        stateId: 'new',
        label: '/items/new',
        route: '/items/new',
        url: 'http://app.test/items/new',
        title: 'New',
        headings: [],
        alerts: [],
        invalidFields: 0,
        dialogs: [],
        controls: ['button:Save'],
      },
      {
        id: 'o3',
        stateId: 'items2',
        label: '/items',
        route: '/items',
        url: 'http://app.test/items',
        title: 'Items',
        headings: [],
        alerts: [],
        invalidFields: 0,
        dialogs: [],
        controls: ['button:New item'],
        statuses: ['Item created'],
        tableRows: 3,
      },
      {
        id: 'o4',
        stateId: 'items3',
        label: '/items',
        route: '/items',
        url: 'http://app.test/items',
        title: 'Items',
        headings: [],
        alerts: [],
        invalidFields: 0,
        dialogs: [],
        controls: ['button:New item'],
        tableRows: 1,
      },
    ],
    initialStateId: 'o1',
    warnings: [],
    droppedEvents: 0,
  } as unknown as RecordingSession;
  return processRecording(session, config, { language: 'fr' });
}

describe('generation plan', () => {
  it('generates the requested formats from the recorded flow, with its groups and accepted assertions, and validates them with real tools', async () => {
    const result = recording();
    const flow = result.flow;
    const carried = (flow.proposals ?? []).find((proposal) => proposal.category === 'DATA_CONSISTENCY');
    if (!carried) throw new Error('fixture proposal missing');
    decideProposal(flow, { id: carried.id, decision: 'ACCEPT' });
    const actions = flow.steps.filter((item) => item.step.kind !== 'expect').map((item) => item.id);
    expect(applyGroupCommand(flow, { op: 'create', name: 'Create', stepIds: actions.slice(0, 2) })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(applyGroupCommand(flow, { op: 'create', name: 'Find', stepIds: actions.slice(2) })).toEqual({
      ok: true,
      warnings: [],
    });

    const plan = planGeneration({
      flow,
      formats: ['yaml', 'gherkin', 'playwright', 'java'],
      baseUrl: 'http://app.test',
      language: 'fr',
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.artifacts.map((artifact) => artifact.format)).toEqual([
      'yaml',
      'gherkin',
      'playwright',
      ...new Array<string>(8).fill('java'),
    ]);
    expect(plan.artifacts.every((artifact) => artifact.status === 'GENERATED')).toBe(true);
    const yaml = plan.artifacts[0];
    const feature = plan.artifacts[1];
    const spec = plan.artifacts[2];
    expect(yaml?.content).toContain('assertions:');
    expect(yaml?.content).toContain('groups:');
    expect(feature?.content).toContain('── group: Create');
    expect(feature?.content).toContain(`business assertion ${carried.assertion?.id ?? ''} — replay only`);
    expect(spec?.content).toContain('// ── group: Create');
    expect(spec?.content).toContain(`business assertion ${carried.assertion?.id ?? ''}`);
    // L'assertion acceptée est portée par chaque artefact : native nulle part (elle lit la requête), rejeu seulement.
    expect(spec?.assertions).toEqual([
      {
        id: carried.assertion?.id,
        description: carried.assertion?.description,
        support: 'REPLAY_ONLY',
        status: 'APPROVED',
      },
    ]);
    expect(spec?.limits.join(' ')).toContain('verified by the QA-CRAWLER replay only');
    const summary = planSummary(plan);
    expect(summary.assertions).toEqual({ native: 0, replayOnly: 1 });

    // Validation statique avec les outils réels : schéma du flow, dictionnaire Gherkin, TypeScript (syntaxe).
    const validated = await validateArtifacts(
      plan.artifacts.filter((artifact) => artifact.format !== 'java'),
    );
    expect(validated.map((artifact) => [artifact.format, artifact.status])).toEqual([
      ['yaml', 'STATICALLY_VALIDATED'],
      ['gherkin', 'STATICALLY_VALIDATED'],
      ['playwright', 'STATICALLY_VALIDATED'],
    ]);
    expect(validated[2]?.validation?.method).toContain('types are not checked');
    // Java sans Maven lancé : NON VALIDÉ, dit tel quel (jamais « validé » par défaut).
    const java = await validateArtifacts(
      plan.artifacts.filter((artifact) => artifact.format === 'java'),
      { maven: false },
    );
    expect(java.every((artifact) => artifact.status === 'NOT_VALIDATED')).toBe(true);
    expect(java[0]?.validation?.messages).toEqual(['not written to disk, or Maven disabled: not validated']);

    // L'exécution réelle seule change le statut en PASSED / FAILED, et celui de chaque assertion.
    const executed = applyExecution(validated, {
      format: 'yaml',
      status: 'PASSED',
      assertions: { [carried.assertion?.id ?? '']: 'PASS' },
    });
    expect(executed[0]).toMatchObject({
      status: 'PASSED',
      assertions: [{ id: carried.assertion?.id, status: 'PASS' }],
    });
    expect(executed[1]?.status).toBe('STATICALLY_VALIDATED');

    // Les fichiers s'écrivent tels quels.
    const directory = await mkdtemp(path.join(tmpdir(), 'qa-generation-'));
    const written = await writeArtifacts(plan.artifacts, directory);
    expect(written.length).toBe(plan.artifacts.length);
    expect(await readFile(path.join(directory, 'java', 'pom.xml'), 'utf8')).toContain(
      '<artifactId>junit-jupiter</artifactId>',
    );
  });

  it('refuses a group that needs data produced outside it, unless forced (and then says it)', () => {
    const C: Pick<FlowStep, 'allow' | 'optional'> = { allow: [], optional: false };
    const step = (id: string, action: string, flowStep: FlowStep, label: string): RecordedFlowStep => ({
      id,
      step: flowStep,
      label,
      actionIds: [action],
      rawEventIds: [`r-${action}`],
      provenance: 'HUMAN_RECORDED',
      confidence: 0.9,
      explanation: 'fixture',
    });
    const flow: RecordedFlow = {
      name: 'create then find',
      recordingSessionId: 'rec-plan-groups',
      startAt: '/items',
      steps: [
        step(
          's1',
          'a1',
          {
            ...C,
            kind: 'fill',
            target: { strategy: 'label', value: 'Title' },
            value: { testData: 'item.title' },
          },
          'type the title',
        ),
        step(
          's2',
          'a2',
          { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Save' } },
          'save',
        ),
        step(
          's3',
          'a3',
          {
            ...C,
            kind: 'fill',
            target: { strategy: 'label', value: 'Search' },
            value: { testData: 'item.title' },
          },
          'search the title',
        ),
      ],
      assertions: [],
      intent: { transitions: [], confidence: 0, evidence: [] },
      negative: false,
      quality: emptyQuality(),
    };
    applyGroupCommand(flow, { op: 'create', name: 'Create', stepIds: ['s1', 's2'] });
    applyGroupCommand(flow, { op: 'create', name: 'Find', stepIds: ['s3'] });
    const find = flow.groups?.[1]?.id ?? '';
    const refused = planGeneration({
      flow,
      formats: ['yaml'],
      baseUrl: 'http://app.test',
      language: 'fr',
      groupIds: [find],
    });
    expect('error' in refused ? refused.error : '').toContain('needs data produced outside it');
    const forced = planGeneration({
      flow,
      formats: ['yaml'],
      baseUrl: 'http://app.test',
      language: 'fr',
      groupIds: [find],
      force: true,
    });
    if ('error' in forced) throw new Error(forced.error);
    expect(forced.flow.steps.map((item) => item.id)).toEqual(['s3']);
    expect(forced.warnings[0]).toContain('data produced outside the selection');
    expect(forced.artifacts[0]?.content).toContain('name: Find');
    // Les deux groupes ensemble : rien ne manque.
    const both = planGeneration({
      flow,
      formats: ['yaml'],
      baseUrl: 'http://app.test',
      language: 'fr',
      groupIds: flow.groups?.map((group) => group.id) ?? [],
    });
    expect('error' in both).toBe(false);
  });

  it('the Gherkin feature of a mission flow reads back through the dictionary, with groups and assertions', () => {
    const { config: mission } = parseConfig(
      `
mission: { name: g }
target: { baseUrl: http://app.test }
flows:
  - name: create an item
    startAt: /items
    steps:
      - click: { role: link, name: New item }
      - fill: { label: Title, value: { testData: item.title } }
      - click: { role: button, name: Save }
      - click: { css: 'div.x > button' }
    groups:
      - { id: g1, name: Create, steps: [1, 2, 3] }
    assertions:
      - id: ASSERT-SHOWN
        description: the title is displayed
        after: 3
        check: { kind: value, source: ui, expected: { testData: item.title } }
      - id: ASSERT-REQUEST
        description: the title reaches the API
        check: { kind: value, source: request, path: /api/items, expected: { testData: item.title } }
`,
      {},
      {},
    );
    const definition = mission.flows[0];
    if (!definition) throw new Error('fixture flow missing');
    const feature = generateGherkinFeature(definition, { language: 'fr' });
    expect(feature.fileName).toBe('create-an-item.feature');
    expect(feature.unsaid).toBe(1);
    expect(feature.replayOnly).toEqual(['ASSERT-REQUEST']);
    expect(feature.content).toContain('# ── group: Create');
    expect(feature.content).toContain(
      '# business assertion ASSERT-SHOWN (mandatory, MEDIUM): the title is displayed',
    );
    expect(feature.content).toContain('# business assertion ASSERT-REQUEST — replay only');
    expect(feature.content).toContain('# (no Gherkin sentence for this step without a selector');
    const dictionary = new GherkinStepDictionary();
    const sentences = feature.content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(Étant donné|Quand|Alors|Et) /.test(line));
    expect(sentences.length).toBe(4);
    for (const sentence of sentences)
      expect(
        dictionary.translate(sentence.replace(/^(Étant donné que |Étant donné |Quand |Alors |Et )/, '')),
        sentence,
      ).toBeDefined();
  });
});
