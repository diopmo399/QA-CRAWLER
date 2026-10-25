import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema } from '../../src/config/flow-schema.js';
import { translateAssertion, translateAssertions } from '../../src/platform/assertion-translation.js';
import { generateJavaJUnitPlaywrightProject } from '../../src/platform/java-junit-playwright-generator.js';
import { generatePlaywrightTest } from '../../src/platform/playwright-test-generator.js';
import { decideProposal } from '../../src/recording/assertion-proposals.js';
import { generateFlowFiles } from '../../src/recording/recorded-flow.js';
import { GherkinStepDictionary } from '../../src/flows/gherkin/gherkin-steps.js';
import type { RecordingSession } from '../../src/recording/model.js';

/**
 * LA TRADUCTION COMMUNE DES ASSERTIONS : une seule règle (native sur l'écran, sinon rejeu seulement)
 * appliquée par les trois générateurs ; les mêmes assertions donnent des artefacts cohérents ; une
 * assertion que le test autonome ne peut pas vérifier est dite, jamais omise, jamais réussie ; les
 * groupes deviennent des en-têtes ; sans assertion ni groupe, la sortie d'avant est inchangée.
 */
const MISSION = `
mission: { name: translation }
target: { baseUrl: http://app.test }
flows:
  - name: create an item
    startAt: /items
    steps:
      - click: { role: link, name: New item }
      - fill: { label: Title, value: { testData: item.title } }
      - click: { role: button, name: Save }
      - expect: { text: Item created }
    groups:
      - { id: g1, name: Create, description: the form, steps: [1, 2, 3] }
      - { id: g2, name: Check, steps: [4] }
    assertions:
      - id: ASSERT-TITLE-SHOWN
        description: the title is displayed on the screen
        after: 3
        check: { kind: value, source: ui, expected: { testData: item.title } }
      - id: ASSERT-NO-DUPLICATE
        description: the title is not listed twice
        after: 4
        check: { kind: entity, source: ui, by: { value: Duplicate }, expect: absent }
      - id: ASSERT-REQUEST
        description: the title reaches the API
        mandatory: false
        criticality: HIGH
        after: 3
        evidence: [NETWORK]
        check: { kind: value, source: request, path: /api/items, expected: { testData: item.title } }
      - id: ASSERT-STATE
        description: the item is pending
        check: { kind: state, source: response, expected: PENDING, path: /api/items }
`;

function flow(): ReturnType<typeof parseConfig>['config']['flows'][number] {
  const { config } = parseConfig(MISSION, {}, {});
  const first = config.flows[0];
  if (!first) throw new Error('fixture flow missing');
  return first;
}

describe('assertion translation', () => {
  it('turns screen checks into native expectations and everything else into replay-only assertions with a reason', () => {
    const definition = flow();
    const translated = definition.assertions.map(translateAssertion);
    expect(translated.map((assertion) => [assertion.id, assertion.support])).toEqual([
      ['ASSERT-TITLE-SHOWN', 'NATIVE'],
      ['ASSERT-NO-DUPLICATE', 'NATIVE'],
      ['ASSERT-REQUEST', 'REPLAY_ONLY'],
      ['ASSERT-STATE', 'REPLAY_ONLY'],
    ]);
    expect(translated[0]?.expect).toEqual({ text: '${testData:item.title}' });
    expect(translated[1]?.expect).toEqual({ hidden: { strategy: 'text', value: 'Duplicate' } });
    expect(translated[2]?.reason).toContain('request observed by the QA-CRAWLER replay');
    expect(translated[3]?.reason).toContain('response observed');
    const grouped = translateAssertions(definition.assertions, definition.steps.length);
    expect([...grouped.nativeAfter.keys()]).toEqual([3, 4]);
    expect(grouped.replayOnly.map((assertion) => assertion.id)).toEqual(['ASSERT-REQUEST', 'ASSERT-STATE']);
  });

  it('the Playwright TypeScript test carries the native assertions after their step, the groups as headers, the rest as explicit comments', () => {
    const test = generatePlaywrightTest(flow(), undefined, { baseUrl: 'http://app.test' });
    const expected = [
      '// ── group: Create — the form',
      '// step 1',
      '// step 3',
      '// business assertion ASSERT-TITLE-SHOWN (mandatory, MEDIUM): the title is displayed on the screen',
      'await expect(page.getByText(`${testData["item.title"]}`).first()).toBeVisible();',
      '// ── group: Check',
      '// step 4',
      '// business assertion ASSERT-NO-DUPLICATE (mandatory, MEDIUM): the title is not listed twice',
      'await expect(page.getByText("Duplicate")).toBeHidden();',
      '// business assertion ASSERT-REQUEST (optional, HIGH): the title reaches the API — verified by the QA-CRAWLER replay only: needs the request observed by the QA-CRAWLER replay',
      '// business assertion ASSERT-STATE (mandatory, MEDIUM): the item is pending — verified by the QA-CRAWLER replay only',
    ];
    let position = -1;
    for (const line of expected) {
      const index = test.content.indexOf(line, position + 1);
      expect(index, line).toBeGreaterThan(position);
      position = index;
    }
    expect(test.replayOnly).toEqual(['ASSERT-REQUEST', 'ASSERT-STATE']);
    expect(test.assertions).toBe(3);
    expect(test.content).toContain(' *   - ASSERT-REQUEST: the title reaches the API');
  });

  it('the Java test carries the same assertions, the same way', () => {
    const project = generateJavaJUnitPlaywrightProject([flow()], [], { baseUrl: 'http://app.test' });
    const content = project.files.find((file) => file.path.endsWith('CreateAnItemTest.java'))?.content ?? '';
    const expected = [
      '// ── group: Create — the form',
      '// business assertion ASSERT-TITLE-SHOWN (mandatory, MEDIUM): the title is displayed on the screen',
      'assertThat(page.getByText(data.value("item.title")).first()).isVisible();',
      '// ── group: Check',
      '// business assertion ASSERT-NO-DUPLICATE (mandatory, MEDIUM): the title is not listed twice',
      'assertThat(page.getByText("Duplicate")).isHidden();',
      '// business assertion ASSERT-REQUEST (optional, HIGH): the title reaches the API — verified by the QA-CRAWLER replay only',
    ];
    let position = -1;
    for (const line of expected) {
      const index = content.indexOf(line, position + 1);
      expect(index, line).toBeGreaterThan(position);
      position = index;
    }
    expect(project.tests[0]?.assertions).toBe(3);
    expect(project.tests[0]?.notes).toContain(
      'ASSERT-REQUEST: verified by the QA-CRAWLER replay only (needs the request observed by the QA-CRAWLER replay)',
    );
  });

  it('without assertions or groups the generators produce exactly what they produced before', () => {
    const definition = flow();
    const bare = { name: definition.name, startAt: definition.startAt, steps: definition.steps };
    const test = generatePlaywrightTest(bare, undefined, { baseUrl: 'http://app.test' });
    expect(test.content).not.toContain('business assertion');
    expect(test.content).not.toContain('── group');
    expect(test.replayOnly).toBeUndefined();
    const java = generateJavaJUnitPlaywrightProject([bare], [], { baseUrl: 'http://app.test' });
    expect(java.files[0]?.content).not.toContain('business assertion');
    expect(java.tests[0]?.notes).toEqual([]);
  });

  it('the recorded .feature says the native assertions as sentences the dictionary reads back, and the rest as comments', async () => {
    const { processRecording } = await import('../../src/recording/process-recording.js');
    const { parseConfig: parse } = await import('../../src/config/config-loader.js');
    const { config } = parse(
      'mission: { name: rec }\ntarget: { baseUrl: "http://app.test", startAt: /items }\n',
      {},
      {},
    );
    const session: RecordingSession = {
      id: 'rec-feature',
      name: 'Create item',
      startedAt: '2026-01-01T00:00:00.000Z',
      startUrl: 'http://app.test/items',
      status: 'PROCESSING' as const,
      rawEvents: [
        {
          id: 'r1',
          sequence: 1,
          type: 'navigation' as const,
          at: 100,
          url: 'http://app.test/items',
          stateAfter: 'o1',
        },
        {
          id: 'r2',
          sequence: 2,
          type: 'change' as const,
          at: 2000,
          url: 'http://app.test/items/new',
          element: {
            tag: 'input',
            role: 'textbox',
            name: 'Title',
            label: 'Title',
            css: 'input.t',
            cssStable: false,
            inForm: true,
            isSubmit: false,
            inNavigation: false,
            inDialog: false,
            sameRoleName: 1,
            roleNameIndex: 0,
            sameLabel: 1,
          },
          value: { empty: false, length: 8, shape: 'text', digest: 'abcdef0123456789' },
          stateAfter: 'o2',
        },
        {
          id: 'r3',
          sequence: 3,
          type: 'click' as const,
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
        },
      ],
      initialStateId: 'o1',
      warnings: [],
      droppedEvents: 0,
    };
    const result = processRecording(session, config, { language: 'fr' });
    const carried = (result.flow.proposals ?? []).find(
      (proposal) => proposal.category === 'DATA_CONSISTENCY',
    );
    if (!carried) throw new Error('fixture proposal missing');
    decideProposal(result.flow, { id: carried.id, decision: 'ACCEPT' });
    // Une assertion native ajoutée à la main (le titre affiché) : une phrase « Alors » que le dictionnaire relit.
    result.flow.businessAssertions?.push({
      id: 'ASSERT-TITLE-SHOWN',
      description: 'the title is displayed',
      criticality: 'MEDIUM',
      mandatory: true,
      requires: [],
      entities: [],
      timeoutMs: 0,
      pollMs: 500,
      evidence: [],
      check: {
        kind: 'value',
        source: 'ui',
        expected: {
          testData:
            carried.assertion?.check.kind === 'value' && 'testData' in carried.assertion.check.expected
              ? carried.assertion.check.expected.testData
              : 'x',
        },
        match: 'normalized',
      },
    });
    const files = generateFlowFiles(result.flow, { language: 'fr', recordedAt: '2026-01-01T00:00:00.000Z' });
    expect(files.feature).toContain(`# business assertion ${carried.assertion?.id ?? ''}`);
    expect(files.feature).toContain(
      'replay only (declared in the flow YAML, verified by the QA-CRAWLER replay)',
    );
    // La citation ${testData:clé} reste dans la phrase : le rejeu la résout (comme dans le YAML).
    expect(files.feature).toMatch(/(Alors|Et) je vois "\$\{testData:[^"]+\}"/);
    const dictionary = new GherkinStepDictionary();
    const sentences = files.feature
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(Étant donné|Quand|Alors|Et) /.test(line));
    for (const sentence of sentences)
      expect(
        dictionary.translate(sentence.replace(/^(Étant donné que |Étant donné |Quand |Alors |Et )/, '')),
        sentence,
      ).toBeDefined();
    // Le YAML reste valide avec les deux assertions.
    const parsed = flowSchema.parse((await import('yaml')).parse(files.yaml));
    expect(parsed.assertions.map((assertion) => assertion.id)).toEqual([
      carried.assertion?.id,
      'ASSERT-TITLE-SHOWN',
    ]);
  });
});
