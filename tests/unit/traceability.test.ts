import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  businessRuleSchema,
  requirementSchema,
  type BusinessRuleConfig,
  type RequirementConfig,
} from '../../src/config/quality-schema.js';
import { requirementTagsOf } from '../../src/flows/gherkin/gherkin-loader.js';
import { parseOpenApi } from '../../src/oracles/api-contract.js';
import type { AssertionResult, AssertionStatus, FlowQualityReport } from '../../src/quality/model.js';
import {
  buildTraceability,
  loadHistory,
  saveHistory,
  updateHistory,
  type TraceabilityInput,
  type TraceFlow,
} from '../../src/quality/traceability.js';

/**
 * LA TRAÇABILITÉ : exigence → règle → flow → assertion → résultat → preuve. Une exigence sans
 * assertion exécutée n'est jamais « vérifiée », et un agrégat ne masque jamais un échec critique.
 */
const NOW = new Date('2026-10-17T12:00:00.000Z');

const requirement = (raw: Record<string, unknown>): RequirementConfig => requirementSchema.parse(raw);
const rule = (raw: Record<string, unknown>): BusinessRuleConfig => businessRuleSchema.parse(raw);

function result(id: string, status: AssertionStatus, extra: Partial<AssertionResult> = {}): AssertionResult {
  return {
    id,
    description: id,
    flow: 'Create request',
    kind: 'value',
    criticality: 'HIGH',
    mandatory: true,
    status,
    entities: [],
    expected: 'expected',
    observed: 'observed',
    reasons: [],
    evidence: [`Create request#${id}#e1`],
    attempts: 1,
    durationMs: 3,
    ...extra,
  };
}

function quality(assertions: AssertionResult[]): FlowQualityReport {
  return { verdict: 'PASS', assertions, consistency: [], evidence: [], networkObserved: true, durationMs: 5 };
}

function flow(name: string, extra: Partial<TraceFlow> = {}): TraceFlow {
  return { name, requirements: [], assertions: [], executed: true, status: 'PASSED', ...extra };
}

function build(partial: Partial<TraceabilityInput>): ReturnType<typeof buildTraceability> {
  return buildTraceability({
    runId: 'run-7',
    requirements: [],
    rules: [],
    flows: [],
    evidenceMaxAgeDays: 30,
    now: NOW,
    ...partial,
  });
}

describe('Traceability', () => {
  it('1. a requirement without any test is NOT_COVERED, and a cited one stays visible', () => {
    const report = build({
      requirements: [requirement({ id: 'REQ-1', description: 'A request can be created' })],
      flows: [flow('Search', { requirements: ['REQ-9'] })],
    });
    const byId = Object.fromEntries(report.requirements.map((entry) => [entry.id, entry]));
    expect(byId['REQ-1']).toMatchObject({ status: 'NOT_COVERED', declared: true });
    // REQ-9 n'est pas déclarée : elle apparaît quand même, signalée.
    expect(byId['REQ-9']).toMatchObject({ declared: false, flows: ['Search'] });
    expect(report.warnings).toContain(
      'requirement "REQ-9" is referenced but not declared under requirements',
    );
    expect(report.summary.byStatus.NOT_COVERED).toBe(1);
  });

  it('2. covered but not executed in this run is COVERED_NOT_EXECUTED, never verified', () => {
    const report = build({
      requirements: [requirement({ id: 'REQ-1', description: 'Create' })],
      flows: [flow('Create request', { requirements: ['REQ-1'], assertions: ['saved'], executed: false })],
    });
    expect(report.requirements[0]).toMatchObject({
      status: 'COVERED_NOT_EXECUTED',
      assertions: [{ id: 'saved', status: 'NOT_EXECUTED' }],
    });
    expect(report.summary.passRate).toBeNull();
  });

  it('3. assertions decide: all mandatory PASS → VERIFIED_PASS, one FAIL → VERIFIED_FAIL, evidence kept', () => {
    const requirements = [
      requirement({ id: 'REQ-1', description: 'Create', criticality: 'CRITICAL' }),
      requirement({ id: 'REQ-2', description: 'Search' }),
    ];
    const report = build({
      requirements,
      rules: [
        rule({
          id: 'RULE-search',
          description: 'Search finds it',
          requirementIds: ['REQ-2'],
          assertions: ['found'],
        }),
      ],
      flows: [
        flow('Create request', {
          requirements: ['REQ-1'],
          assertions: ['saved', 'title'],
          status: 'FAILED',
          quality: quality([result('saved', 'PASS'), result('title', 'FAIL'), result('found', 'PASS')]),
        }),
        flow('Search', {
          assertions: ['found'],
          quality: quality([result('found', 'PASS', { flow: 'Search', evidence: ['Search#found#e1'] })]),
        }),
      ],
    });
    const byId = Object.fromEntries(report.requirements.map((entry) => [entry.id, entry]));
    expect(byId['REQ-1']?.status).toBe('VERIFIED_FAIL');
    expect(byId['REQ-1']?.reasons).toContain('Create request#title: FAIL');
    expect(byId['REQ-1']?.evidence).toEqual(['Create request#saved#e1', 'Create request#title#e1']);
    expect(byId['REQ-2']).toMatchObject({ status: 'VERIFIED_PASS', rules: ['RULE-search'] });
    expect(report.rules[0]?.status).toBe('VERIFIED_PASS');
    // Lien rule VERIFIES requirement et flow COVERS requirement.
    expect(report.links).toContainEqual({
      type: 'VERIFIES',
      from: { kind: 'RULE', id: 'RULE-search' },
      to: { kind: 'REQUIREMENT', id: 'REQ-2' },
      origin: 'YAML',
    });
    // L'échec est trié en tête.
    expect(report.requirements[0]?.id).toBe('REQ-1');
  });

  it('4. BLOCKED, UNVERIFIABLE and a flow without assertion are never a pass', () => {
    const report = build({
      requirements: [
        requirement({ id: 'REQ-A', description: 'a' }),
        requirement({ id: 'REQ-B', description: 'b' }),
        requirement({ id: 'REQ-C', description: 'c' }),
      ],
      flows: [
        flow('A', { requirements: ['REQ-A'], assertions: ['x'], quality: quality([result('x', 'BLOCKED')]) }),
        flow('B', {
          requirements: ['REQ-B'],
          assertions: ['y'],
          quality: quality([result('y', 'UNVERIFIABLE')]),
        }),
        flow('C', { requirements: ['REQ-C'] }),
      ],
    });
    const byId = Object.fromEntries(report.requirements.map((entry) => [entry.id, entry]));
    expect(byId['REQ-A']?.status).toBe('BLOCKED');
    expect(byId['REQ-B']?.status).toBe('INCONCLUSIVE');
    expect(byId['REQ-C']?.status).toBe('INCONCLUSIVE');
    expect(byId['REQ-C']?.reasons[0]).toContain('a technical success does not verify the requirement');
    expect(report.summary.passRate).toBe(0);
  });

  it('5. evidence older than the threshold is STALE_EVIDENCE; the history keeps the last verification', async () => {
    const requirements = [requirement({ id: 'REQ-1', description: 'Create' })];
    const notRun = [
      flow('Create request', { requirements: ['REQ-1'], assertions: ['saved'], executed: false }),
    ];
    const old = {
      version: 1 as const,
      requirements: {
        'REQ-1': { status: 'VERIFIED_PASS' as const, at: '2026-08-01T00:00:00.000Z', runId: 'run-1' },
      },
    };
    const stale = build({ requirements, flows: notRun, history: old });
    expect(stale.requirements[0]?.status).toBe('STALE_EVIDENCE');
    expect(stale.requirements[0]?.reasons[0]).toMatch(
      /last verified 77 day\(s\) ago \(VERIFIED_PASS\), beyond 30/,
    );

    const fresh = build({
      requirements,
      flows: notRun,
      history: {
        version: 1,
        requirements: { 'REQ-1': { ...old.requirements['REQ-1'], at: '2026-10-10T00:00:00.000Z' } },
      },
    });
    expect(fresh.requirements[0]?.status).toBe('COVERED_NOT_EXECUTED');

    // Un run qui vérifie l'exigence met l'historique à jour ; un run qui ne l'exécute pas le garde.
    const verified = build({
      requirements,
      flows: [
        flow('Create request', {
          requirements: ['REQ-1'],
          assertions: ['saved'],
          quality: quality([result('saved', 'PASS')]),
        }),
      ],
      history: old,
    });
    const history = updateHistory(old, verified);
    expect(history.requirements['REQ-1']).toEqual({
      status: 'VERIFIED_PASS',
      at: NOW.toISOString(),
      runId: 'run-7',
    });
    expect(updateHistory(history, stale).requirements['REQ-1']?.runId).toBe('run-7');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-'));
    try {
      const file = path.join(dir, 'nested', 'traceability-history.json');
      expect(await loadHistory(file)).toBeUndefined();
      await saveHistory(file, history);
      expect(await loadHistory(file)).toEqual(history);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('6. aggregation never hides a critical failure, and keeps each individual result', () => {
    const many = Array.from({ length: 9 }, (_, index) => `REQ-${String(index + 1)}`);
    const report = build({
      requirements: [
        ...many.map((id) => requirement({ id, description: id, criticality: 'LOW' })),
        requirement({ id: 'REQ-PAY', description: 'Payment', criticality: 'CRITICAL' }),
        requirement({ id: 'REQ-NOTIFY', description: 'Notify', dependsOn: ['REQ-PAY'] }),
      ],
      flows: [
        ...many.map((id) =>
          flow(id, {
            requirements: [id],
            assertions: ['ok'],
            quality: quality([result('ok', 'PASS', { flow: id })]),
          }),
        ),
        flow('Pay', {
          requirements: ['REQ-PAY'],
          assertions: ['paid'],
          quality: quality([result('paid', 'FAIL')]),
        }),
        flow('Notify', {
          requirements: ['REQ-NOTIFY'],
          assertions: ['sent'],
          quality: quality([result('sent', 'PASS')]),
        }),
      ],
    });
    expect(report.summary.passRate).toBeCloseTo(10 / 11);
    expect(report.summary.criticalFailures).toEqual(['REQ-PAY']);
    expect(report.summary.byStatus).toMatchObject({ VERIFIED_PASS: 10, VERIFIED_FAIL: 1 });
    expect(report.requirements).toHaveLength(11);
    // Le résultat propre de REQ-NOTIFY est gardé, sa dépendance en échec est dite.
    const notify = report.requirements.find((entry) => entry.id === 'REQ-NOTIFY');
    expect(notify?.status).toBe('VERIFIED_PASS');
    expect(notify?.reasons).toContain('depends on REQ-PAY, which is VERIFIED_FAIL');
  });

  it('imports requirements from Gherkin tags and OpenAPI x-requirements', () => {
    expect(
      requirementTagsOf(['@REQ-12', '@req:CHK-4', '@ticket:ABC-7', '@smoke', '@requirement:R.9', '@REQ-12']),
    ).toEqual(['REQ-12', 'CHK-4', 'ABC-7', 'R.9']);
    const contract = parseOpenApi(
      [
        'openapi: 3.0.0',
        'paths:',
        '  /api/requests/{id}:',
        '    get:',
        '      x-requirements: [REQ-READ]',
        '      responses: { "200": { description: ok } }',
        '  /api/requests:',
        '    post:',
        '      x-requirements: REQ-CREATE',
        '      responses: { "201": { description: created } }',
      ].join('\n'),
    );
    expect(contract.operations.map((operation) => operation.requirements)).toEqual([
      ['REQ-READ'],
      ['REQ-CREATE'],
    ]);
    const report = build({
      operations: contract.operations,
      flows: [
        flow('Read', {
          fromGherkin: true,
          requirements: ['REQ-12'],
          assertions: ['contract-ok'],
          quality: quality([
            result('contract-ok', 'PASS', {
              kind: 'contract',
              expected: 'GET /api/requests/REQ-1001 follows the OpenAPI contract',
            }),
          ]),
        }),
      ],
    });
    const byId = Object.fromEntries(report.requirements.map((entry) => [entry.id, entry]));
    expect(byId['REQ-READ']).toMatchObject({
      status: 'VERIFIED_PASS',
      operations: ['GET /api/requests/{id}'],
    });
    expect(byId['REQ-CREATE']?.status).toBe('NOT_COVERED');
    expect(byId['REQ-CREATE']?.reasons[0]).toContain('declared by the OpenAPI');
    expect(report.links.find((link) => link.to.id === 'REQ-12')?.origin).toBe('GHERKIN');
    expect(report.links.find((link) => link.to.id === 'REQ-READ')?.origin).toBe('OPENAPI');
  });

  it('flags unknown references and conflicting rules that both pass', () => {
    const report = build({
      rules: [
        rule({ id: 'R1', description: 'one', assertions: ['a'], conflictsWith: ['R2'] }),
        rule({
          id: 'R2',
          description: 'two',
          assertions: ['b'],
          conflictsWith: ['R1', 'R404'],
          derivedFrom: ['POST /api/requests'],
        }),
        rule({ id: 'R3', description: 'three', assertions: ['missing'] }),
      ],
      flows: [
        flow('F', { assertions: ['a', 'b'], quality: quality([result('a', 'PASS'), result('b', 'PASS')]) }),
      ],
    });
    expect(report.rules[0]?.reasons[0]).toContain('conflicts with R2, which also passes');
    expect(report.rules[2]?.status).toBe('NOT_COVERED');
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        'businessRules.R3: assertion "missing" is not declared by any flow',
        'businessRules.R2: conflicts with unknown rule "R404"',
      ]),
    );
    expect(report.links).toContainEqual({
      type: 'DERIVED_FROM',
      from: { kind: 'RULE', id: 'R2' },
      to: { kind: 'OPERATION', id: 'POST /api/requests' },
      origin: 'YAML',
    });
  });
});
