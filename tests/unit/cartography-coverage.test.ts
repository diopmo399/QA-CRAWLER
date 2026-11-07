import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel, MapDecision } from '../../src/sdk/core/cartography.js';
import type { ExecutionFlowView } from '../../src/sdk/core/contracts.js';
import {
  applyLinkDecisions,
  computeCoverage,
  proposeLinks,
  type LastRun,
  type ScenarioInput,
} from '../../src/cartography/coverage.js';
import { computeImpact, diffModels } from '../../src/cartography/impact.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * Couverture et impact sur le graphe réel du mini-projet : les scénarios sont des flows écrits comme ceux
 * du projet (étapes goto / fill / expect), les exécutions sont des détails d'exécution du SDK.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography');
const configFor = (root: string): CartographyConfig => ({
  schema: 1,
  sources: [
    {
      id: 'front',
      name: 'Front',
      layer: 'FRONTEND',
      path: path.join(root, 'front'),
      include: [],
      enabled: true,
    },
    { id: 'bff', name: 'BFF', layer: 'BFF', path: path.join(root, 'bff'), include: [], enabled: true },
    {
      id: 'backend',
      name: 'Backend',
      layer: 'BACKEND',
      path: path.join(root, 'backend'),
      include: [],
      enabled: true,
    },
    {
      id: 'contracts',
      name: 'Contracts',
      layer: 'API',
      path: path.join(root, 'contracts'),
      include: [],
      enabled: true,
    },
  ],
});

const createScenario: ScenarioInput = {
  name: 'Create a request',
  file: 'requests.yaml',
  revision: 'abc123',
  flow: {
    name: 'Create a request',
    steps: [
      { goto: 'http://localhost:4200/requests/new' },
      { fill: { label: 'Company name', value: { testData: 'company' } } },
      { fill: { label: 'Contact email', value: { testData: 'email' } } },
      { click: { role: 'button', name: 'Save' }, allow: 'MUTATION' },
      { expect: { response: { method: 'POST', url: '/api/requests', status: 201 } } },
    ],
  },
};
const rejectedScenario: ScenarioInput = {
  name: 'Refuse an empty company',
  file: 'requests.yaml',
  flow: {
    name: 'Refuse an empty company',
    startAt: '/requests/new',
    steps: [
      { fill: { label: 'Contact email', value: 'x' } },
      { expect: { response: { method: 'POST', url: '/api/requests', status: '4xx' } } },
    ],
  },
};
// Un libellé seul, sur un autre écran : aucune association n'est proposée.
const unrelated: ScenarioInput = {
  name: 'Open the company form',
  file: 'companies.yaml',
  flow: { name: 'Open the company form', steps: [{ fill: { label: 'Contact email', value: 'x' } }] },
};

const flowRun = (name: string, status: string, steps: [number, string][]): ExecutionFlowView => ({
  name,
  status,
  durationMs: 10,
  steps: steps.map(([index, stepStatus]) => ({
    index,
    kind: 'x',
    label: `step ${String(index)}`,
    status: stepStatus,
    durationMs: 1,
  })),
  assertions: [],
  testData: [],
});

describe('cartography coverage', () => {
  let model: CartographyModel;
  let createFeature: string;
  beforeAll(async () => {
    ({ model } = await runScan({ config: configFor(FIXTURE), allowedRoots: [FIXTURE], incremental: false }));
    createFeature = model.features.find((f) => f.name === 'Request create')?.id ?? '';
  });

  it('proposes associations from the steps, with their evidence, and never validates them', () => {
    const links = proposeLinks(model, [createScenario, rejectedScenario, unrelated]);
    const create = links.find((l) => l.scenario === 'Create a request' && l.feature === createFeature);
    expect(create).toMatchObject({
      origin: 'AUTO',
      status: 'PROPOSED',
      confidence: 'CONFIRMED',
      path: 'POSITIVE',
    });
    expect(create?.fields).toEqual([
      'FIELD:front:RequestCreateComponent#form.companyName',
      'FIELD:front:RequestCreateComponent#form.contactEmail',
    ]);
    expect(create?.reasons[0]).toContain('l’étape 1 ouvre /requests/new');
    expect(create?.evidence.every((e) => e.kind === 'SCENARIO_STEP' && e.file === 'requests.yaml')).toBe(
      true,
    );
    expect(
      links.find((l) => l.scenario === 'Refuse an empty company' && l.feature === createFeature)?.path,
    ).toBe('NEGATIVE');
    expect(links.some((l) => l.scenario === 'Open the company form')).toBe(false);
    // L'écran de modification n'est pas ouvert par ces scénarios.
    const edit = model.features.find((f) => f.name === 'Request edit')?.id;
    expect(links.some((l) => l.feature === edit && l.scenario === 'Create a request')).toBe(false);
  });

  it('measures each criterion from the executions, with the formula and the denominator visible', () => {
    const links = proposeLinks(model, [createScenario, rejectedScenario]);
    const runs = new Map<string, LastRun>([
      [
        'Create a request',
        {
          run: 'run-1',
          at: '2026-11-04T10:00:00Z',
          verdict: 'PASSED',
          flow: flowRun('Create a request', 'PASSED', [
            [1, 'PASSED'],
            [2, 'PASSED'],
            [3, 'PASSED'],
            [4, 'PASSED'],
            [5, 'PASSED'],
          ]),
        },
      ],
      [
        'Refuse an empty company',
        {
          run: 'run-1',
          at: '2026-11-04T10:00:00Z',
          verdict: 'PASSED',
          flow: flowRun('Refuse an empty company', 'PASSED', [
            [1, 'PASSED'],
            [2, 'PASSED'],
          ]),
        },
      ],
    ]);
    const { coverage, summary, issues } = computeCoverage(
      model,
      links,
      runs,
      [],
      [createScenario, rejectedScenario],
    );
    const create = coverage.find((c) => c.feature === createFeature);
    expect(create?.status).toBe('COVERED');
    expect(create?.criteria.map((c) => [c.id, c.met])).toEqual([
      ['LINKED', true],
      ['TRAVERSED', true],
      ['ASSERTED', true],
      ['PASSED', true],
      ['CRITICAL_FIELDS', true],
      ['NEGATIVE_PATH', true],
    ]);
    expect(create?.formula).toBe('6 critère(s) rempli(s) sur 6 applicable(s)');
    // Sans scénario, sans exécution : non couvertes, et les champs obligatoires sont signalés.
    expect(coverage.find((c) => c.feature !== createFeature && c.status !== 'NOT_COVERED')).toBeUndefined();
    expect(
      issues.some(
        (i) => i.kind === 'UNTESTED' && i.fields[0] === 'FIELD:front:RequestEditComponent#form.companyName',
      ),
    ).toBe(true);
    expect(summary).toMatchObject({ numerator: 1, denominator: model.features.length });
    expect(summary.percent).toBe(Math.round((1 / model.features.length) * 1000) / 10);
  });

  it('keeps an association proposed by label alone « à confirmer », and follows the decisions', () => {
    const byLabel: ScenarioInput = {
      name: 'Fill the request',
      file: 'requests.yaml',
      flow: {
        name: 'Fill the request',
        steps: [
          { fill: { label: 'Company name', value: 'x' } },
          { fill: { label: 'Contact email', value: 'y' } },
        ],
      },
    };
    const links = proposeLinks(model, [byLabel]);
    const proposed = links.find((l) => l.feature === createFeature);
    expect(proposed?.confidence).toBe('PROBABLE');
    const before = computeCoverage(model, links, new Map(), [], [byLabel]);
    expect(before.coverage.find((c) => c.feature === createFeature)?.status).toBe('TO_CONFIRM');
    const decisions: MapDecision[] = [
      {
        id: 'd1',
        at: '2026-11-04T10:00:00Z',
        kind: 'VALIDATE_LINK',
        target: createFeature,
        value: 'Fill the request',
      },
      {
        id: 'd2',
        at: '2026-11-04T10:01:00Z',
        kind: 'OUT_OF_SCOPE',
        target: model.features.find((f) => f.name === 'Company form')?.id ?? '',
      },
    ];
    const decided = applyLinkDecisions(links, decisions);
    expect(decided.find((l) => l.feature === createFeature)?.status).toBe('VALIDATED');
    const after = computeCoverage(model, decided, new Map(), decisions, [byLabel]);
    // Validée mais jamais exécutée : partielle, pas couverte.
    expect(after.coverage.find((c) => c.feature === createFeature)?.status).toBe('PARTIAL');
    expect(after.summary.counts.OUT_OF_SCOPE).toBe(1);
    expect(after.summary.denominator).toBe(model.features.length - 1);
    const rejected = applyLinkDecisions(decided, [
      {
        id: 'd3',
        at: '2026-11-04T10:02:00Z',
        kind: 'REJECT_LINK',
        target: createFeature,
        value: 'Fill the request',
      },
    ]);
    expect(
      computeCoverage(model, rejected, new Map(), [], [byLabel]).coverage.find(
        (c) => c.feature === createFeature,
      )?.status,
    ).toBe('NOT_COVERED');
  });

  it('says « non calculable » when no feature is in scope', () => {
    const empty: CartographyModel = { ...model, features: [] };
    const { summary } = computeCoverage(empty, [], new Map(), [], []);
    expect(summary.percent).toBeUndefined();
    expect(summary.formula).toContain('non calculable');
  });
});

describe('cartography impact', () => {
  let copy: string;
  beforeAll(async () => {
    copy = await mkdtemp(path.join(tmpdir(), 'qa-map-impact-'));
    await cp(FIXTURE, copy, { recursive: true });
  });
  afterAll(async () => {
    await rm(copy, { recursive: true, force: true });
  });

  it('compares two scans and propagates a field change to the features and scenarios through proven links', async () => {
    const before = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const component = path.join(copy, 'front/src/app/requests/request-create.component.ts');
    await writeFile(
      component,
      (await readFile(component, 'utf8')).replace('Validators.maxLength(120)', 'Validators.maxLength(100)'),
    );
    const after = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: false });
    const changes = diffModels(before.model, after.model);
    const field = changes.find((c) => c.node === 'FIELD:front:RequestCreateComponent#form.companyName');
    expect(field?.change).toBe('CHANGED');
    expect(field?.detail).toContain('maxLength : 120 → 100');
    const links = proposeLinks(after.model, [createScenario, unrelated]);
    const report = computeImpact(before.model, after.model, links);
    const create = report.features.find((f) => f.name === 'Request create');
    expect(create?.confidence).toBe('CONFIRMED');
    expect(create?.via.join(' ')).toContain('chemin démontré');
    // L'écran de modification partage la donnée par des liens dont un est probable : impact probable.
    expect(report.features.find((f) => f.name === 'Request edit')?.confidence).toBe('PROBABLE');
    expect(report.features.some((f) => f.name === 'Company form')).toBe(false);
    expect(report.scenarios).toEqual([
      expect.objectContaining({ scenario: 'Create a request', confidence: 'CONFIRMED' }),
    ]);
    // La divergence de longueur demeure : le BFF accepte encore 120 caractères.
    const divergence = after.model.issues.find((i) => i.message.includes('longueurs maximales différentes'));
    expect(divergence?.message).toBe('Company name : longueurs maximales différentes (100 / 120)');
    expect(divergence?.fields).toContain('FIELD:bff:CreateRequestDto.companyName');
  });
});
