import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { testDataSetDocument, type TestDataSet } from '../../src/data/test-data-set.js';
import type { AssertionProposal, RecordedFlow, RecordedFlowStep } from '../../src/recording/model.js';
import { emptyQuality } from '../../src/recording/model.js';
import {
  bindStoredTestData,
  loadStoredRecording,
  storedTestData,
  type StoredRecording,
} from '../../src/recording/recording-workspace.js';
import { verdictOfAssertionStatus, verdictOfReplayOutcome } from '../../src/sdk/core/verdicts.js';
import { assertionVerdicts } from '../../src/sdk/server/recordings.js';
import { layoutStudio } from '../../src/sdk/ui/studio-layout.js';
import { studioStrings } from '../../src/sdk/ui/studio-i18n.js';
import { renderPanel, type StudioState } from '../../src/sdk/ui/studio-view.js';

/**
 * DONNÉES ET ASSERTIONS DU SDK, sur un enregistrement écrit sur disque : la lignée des données, la
 * source de chaque saisie, la liaison faite par le moteur (fichiers réécrits, décision consignée),
 * les données citées sans origine, et le verdict des assertions lu dans le dernier rejeu — jamais
 * supposé.
 */
const C: Pick<FlowStep, 'allow' | 'optional'> = { allow: [], optional: false };

function step(id: string, action: string, flowStep: FlowStep, label: string): RecordedFlowStep {
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

const proposal = (patch: Partial<AssertionProposal> & Pick<AssertionProposal, 'id'>): AssertionProposal => ({
  origin: 'OBSERVED',
  category: 'UI_CONTENT',
  description: `check ${patch.id}`,
  why: 'seen after the action',
  afterActionId: 'a3',
  sourceObservationIds: [],
  evidence: ['the text was visible'],
  verificationMethod: 'UI_EXPECT',
  limits: [],
  confidence: 0.8,
  needsConfirmation: false,
  recommended: true,
  status: 'APPROVED',
  ...patch,
});

function flow(): RecordedFlow {
  return {
    name: 'create then find',
    recordingSessionId: 'rec-data',
    startAt: '/items',
    steps: [
      step(
        's1',
        'a1',
        { ...C, kind: 'click', target: { strategy: 'role', role: 'link', name: 'New' } },
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
      step('s4', 'a3', { ...C, kind: 'expect', expect: { text: 'Saved' } }, 'saved is shown'),
      step(
        's5',
        'a4',
        {
          ...C,
          kind: 'fill',
          target: { strategy: 'label', value: 'Search' },
          value: { testData: 'item.title' },
        },
        'search the title',
      ),
      step('s6', 'a4', { ...C, kind: 'expect', expect: { text: '${testData:item.title}' } }, 'title listed'),
      step('s7', 'a5', { ...C, kind: 'expect', expect: { text: '${testData:order.ref}' } }, 'order listed'),
    ],
    assertions: [],
    proposals: [
      proposal({ id: 'p-ui', expect: { text: 'Saved' } }),
      proposal({
        id: 'p-business',
        verificationMethod: 'BUSINESS_ASSERTION',
        assertion: { id: 'ba-1', description: 'the item exists' } as never,
      }),
      proposal({
        id: 'p-silent',
        verificationMethod: 'BUSINESS_ASSERTION',
        assertion: { id: 'ba-2', description: 'the count grew' } as never,
      }),
      proposal({ id: 'p-rejected', status: 'REJECTED', recommended: false, expect: { text: 'Nope' } }),
      // Rangée par le recorder sous une autre action : retrouvée par son contenu, seul de son espèce.
      proposal({ id: 'p-moved', afterActionId: 'a9', expect: { text: '${testData:order.ref}' } }),
    ],
    intent: { transitions: [], confidence: 0, evidence: [] },
    negative: false,
    quality: emptyQuality(),
  };
}

const set: TestDataSet = {
  id: 'rec-data',
  name: 'create then find',
  source: 'HUMAN_RECORDING',
  values: {
    'item.title': { key: 'item.title', strategy: 'RECORDED_LITERAL', value: 'Blue chair', sensitive: false },
  },
};

let dir: string;

async function stored(): Promise<StoredRecording> {
  const loaded = await loadStoredRecording(dir);
  if (!loaded) throw new Error('fixture not loaded');
  return loaded;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qa-data-'));
  await writeFile(path.join(dir, 'recorded-flow.json'), JSON.stringify(flow()));
  await writeFile(
    path.join(dir, 'raw-recording.json'),
    JSON.stringify({ startedAt: '2026-01-01T00:00:00.000Z' }),
  );
  await writeFile(path.join(dir, 'generated.flow.yaml'), 'name: x\n');
  await writeFile(path.join(dir, 'test-data.yaml'), stringifyYaml(testDataSetDocument(set)));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('verdict tables — engine words to SDK words, never a guess', () => {
  it('maps the business assertion engine statuses', () => {
    expect(verdictOfAssertionStatus('PASS')).toBe('VERIFIED_PASS');
    expect(verdictOfAssertionStatus('FAIL')).toBe('VERIFIED_FAIL');
    expect(verdictOfAssertionStatus('BLOCKED')).toBe('BLOCKED');
    expect(verdictOfAssertionStatus('INCONCLUSIVE')).toBe('INCONCLUSIVE');
    expect(verdictOfAssertionStatus('UNVERIFIABLE')).toBe('INCONCLUSIVE');
    expect(verdictOfAssertionStatus(undefined)).toBe('NOT_EXECUTED');
    expect(verdictOfAssertionStatus('SOMETHING_NEW')).toBe('NOT_EXECUTED');
  });

  it('maps the replay outcome of a check step: only MATCHED passes, only a mismatch fails', () => {
    expect(verdictOfReplayOutcome('MATCHED')).toBe('VERIFIED_PASS');
    expect(verdictOfReplayOutcome('ASSERTION_MISMATCH')).toBe('VERIFIED_FAIL');
    expect(verdictOfReplayOutcome('BLOCKED_BY_POLICY')).toBe('BLOCKED');
    for (const outcome of ['AMBIGUOUS', 'NOT_FOUND', 'NOT_VERIFIED'] as const)
      expect(verdictOfReplayOutcome(outcome)).toBe('INCONCLUSIVE');
    expect(verdictOfReplayOutcome(undefined)).toBe('NOT_EXECUTED');
  });
});

describe('test data of a stored recording', () => {
  it('gives the lineage, the source of each input and the data used with no origin', async () => {
    const data = await storedTestData(await stored());
    const title = data.lineage.find((entry) => entry.key === 'item.title');
    expect(title?.producedBy?.stepId).toBe('s2');
    // La lignée du moteur compte les étapes d'action (les vérifications ne sont pas des usages).
    expect(title?.usedBy.map((use) => [use.stepId, use.how])).toEqual([['s5', 'INPUT']]);
    const search = data.inputs.find((input) => input.stepId === 's5');
    expect(search?.binding).toMatchObject({ source: 'REFERENCE', reference: 'item.title' });
    expect(search?.binding.options.map((option) => option.key)).toEqual(['item.title']);
    // order.ref est cité mais ni produit ni dans le jeu : le rejeu en inventerait une valeur.
    expect(data.missing).toEqual([{ key: 'order.ref', stepIds: ['s7'] }]);
  });

  it('binds an input to a generated value: the engine rewrites the data set, the flow and the decision ledger', async () => {
    const outcome = await bindStoredTestData(
      await stored(),
      { stepId: 's2', source: 'GENERATED', variable: 'item.title', generator: 'text' },
      'en',
    );
    expect(outcome).toMatchObject({
      decision: { stepId: 's2', source: 'GENERATED', variable: 'item.title' },
    });
    expect(await readFile(path.join(dir, 'test-data.yaml'), 'utf8')).toMatch(/generator: text/);
    const ledger = JSON.parse(await readFile(path.join(dir, 'human-review.json'), 'utf8')) as {
      bindings: { stepId: string }[];
    };
    expect(ledger.bindings.map((binding) => binding.stepId)).toEqual(['s2']);
    const after = await storedTestData(await stored());
    expect(after.inputs.find((input) => input.stepId === 's2')?.binding).toMatchObject({
      source: 'GENERATED',
      generator: 'text',
      manual: true,
    });
  });

  it('refuses to reuse a data that is only produced later, and changes nothing', async () => {
    const before = await readFile(path.join(dir, 'recorded-flow.json'), 'utf8');
    const outcome = await bindStoredTestData(
      await stored(),
      { stepId: 's2', source: 'REFERENCE', variable: 'item.title' },
      'en',
    );
    expect(outcome).toMatchObject({
      error: expect.stringContaining('only an earlier data can be reused') as unknown,
    });
    expect(await readFile(path.join(dir, 'recorded-flow.json'), 'utf8')).toBe(before);
  });
});

describe('assertion verdicts read from the last replay', () => {
  it('without any replay, every assertion is NOT_EXECUTED', async () => {
    const verdicts = await assertionVerdicts(await stored());
    expect([...verdicts.values()].every((entry) => entry.verdict.status === 'NOT_EXECUTED')).toBe(true);
    expect(verdicts.get('p-ui')?.stepId).toBe('s4');
    expect(verdicts.get('p-moved')?.stepId).toBe('s7');
  });

  it('takes the replay outcome of the check step and the business engine status, and nothing else', async () => {
    const run = path.join(dir, 'replay', 'dry-run', 'run-1');
    await mkdir(path.join(run, 'exploration'), { recursive: true });
    await writeFile(
      path.join(run, 'reconciliation.json'),
      JSON.stringify({
        status: 'PARTIALLY_MATCHED',
        findings: [{ intentId: 'f#4', outcome: 'ASSERTION_MISMATCH', reasons: ['saw “Error”'] }],
      }),
    );
    await writeFile(
      path.join(run, 'exploration', 'quality-verification.json'),
      JSON.stringify({
        flows: [
          {
            assertions: [
              { id: 'ba-1', status: 'PASS', observed: 'item found', reasons: [], evidence: ['ev1'] },
            ],
          },
        ],
      }),
    );
    const past = new Date(Date.now() - 60_000);
    await utimes(path.join(dir, 'recorded-flow.json'), past, past);
    const verdicts = await assertionVerdicts(await stored());
    expect(verdicts.get('p-ui')?.verdict).toMatchObject({
      status: 'VERIFIED_FAIL',
      source: 'REPLAY_STEP',
      engineStatus: 'ASSERTION_MISMATCH',
      reasons: ['saw “Error”'],
      stale: false,
    });
    expect(verdicts.get('p-business')?.verdict).toMatchObject({
      status: 'VERIFIED_PASS',
      source: 'QUALITY_ENGINE',
      observed: 'item found',
      evidence: ['ev1'],
    });
    expect(verdicts.get('p-silent')?.verdict.status).toBe('NOT_EXECUTED');
    expect(verdicts.get('p-rejected')?.verdict).toEqual({
      status: 'NOT_EXECUTED',
      reasons: ['not in the flow'],
    });
  });
});

describe('Studio panels for data and assertions', () => {
  const base = (patch: Partial<StudioState>): StudioState => {
    const view = {
      name: 'x',
      startAt: '/',
      steps: [
        {
          id: 's2',
          position: 2,
          kind: 'fill',
          description: 'type the title',
          consumes: [],
          produces: ['item.title'],
        },
        {
          id: 's5',
          position: 5,
          kind: 'fill',
          description: 'search',
          consumes: ['item.title'],
          produces: [],
        },
      ],
      groups: [],
      dependencies: [],
      violations: [],
    };
    return {
      t: studioStrings('fr'),
      phase: 'ready',
      view,
      layout: layoutStudio(view),
      viewport: { x: 0, y: 0, k: 1 },
      selected: [],
      query: '',
      matches: [],
      matchIndex: 0,
      busy: false,
      moved: false,
      tab: 'flow',
      data: {
        variables: [
          {
            key: 'item.title',
            strategy: 'RECORDED_LITERAL',
            producedBy: { stepId: 's2', position: 2, label: 'type the title' },
            usedBy: [{ stepId: 's5', position: 5, label: 'search', how: 'INPUT' }],
          },
        ],
        inputs: [
          {
            stepId: 's2',
            position: 2,
            label: 'type the title',
            source: 'FIXED',
            key: 'item.title',
            recordedValue: 'Blue <chair>',
            options: [],
            manual: false,
          },
          {
            stepId: 's5',
            position: 5,
            label: 'search',
            source: 'REFERENCE',
            key: 'item.title',
            reference: 'item.title',
            options: [
              {
                stepId: 's2',
                position: 2,
                label: 'type the title',
                key: 'item.title',
                strategy: 'RECORDED_LITERAL',
              },
            ],
            manual: true,
          },
        ],
        missing: [{ key: 'order.ref', stepIds: ['s7'], message: 'x' }],
        generators: ['text', 'email'],
      },
      assertions: [
        {
          id: 'p-ui',
          origin: 'OBSERVED',
          category: 'UI_CONTENT',
          description: 'saved is shown',
          why: 'seen',
          verificationMethod: 'UI_EXPECT',
          evidence: ['e'],
          limits: [],
          confidence: 0.8,
          needsConfirmation: false,
          recommended: true,
          status: 'APPROVED',
          inFlow: true,
          stepId: 's4',
          verdict: { status: 'VERIFIED_FAIL', source: 'REPLAY_STEP', reasons: ['saw “Error”'], stale: true },
        },
      ],
      ...patch,
    };
  };

  it('the input panel offers fixed, generated and reused sources; reuse only lists earlier data', () => {
    const first = renderPanel(base({ selected: ['s2'] }));
    expect(first).toContain('Source de la valeur');
    expect(first).toMatch(/value="REFERENCE" disabled/);
    expect(first).toContain('Aucune donnée produite avant cette étape.');
    expect(first).toContain('value="Blue &lt;chair&gt;"');
    const second = renderPanel(base({ selected: ['s5'] }));
    expect(second).toMatch(/value="REFERENCE" checked/);
    expect(second).toContain('<option value="item.title" selected>item.title — Étape 2</option>');
    expect(second).toContain('choix humain');
  });

  it('the data tab shows the lineage and alerts on data used with no origin', () => {
    const html = renderPanel(base({ tab: 'data' }));
    expect(html).toMatch(/data-tab="data" aria-selected="true"[^>]*>Données/);
    expect(html).toContain('<code>item.title</code>');
    expect(html).toContain('Produite par');
    expect(html).toMatch(/role="alert"><b>Données citées sans origine/);
    expect(html).toContain('<code>order.ref</code>');
  });

  it('the assertions tab shows the verdict from the run, its staleness, and the human decisions', () => {
    const html = renderPanel(base({ tab: 'assertions' }));
    expect(html).toContain('data-verdict="VERIFIED_FAIL">vérifiée, non conforme');
    expect(html).toContain('le parcours a changé depuis cette exécution');
    expect(html).toContain('saw “Error”');
    for (const decision of ['ACCEPT', 'REJECT', 'DISABLE', 'RESET'])
      expect(html).toContain(`data-decide="${decision}"`);
    expect(html).toContain('data-select-step="s4"');
    const editing = renderPanel(base({ tab: 'assertions', editingAssertion: 'p-ui' }));
    expect(editing).toContain('data-form="modify"');
  });
});
