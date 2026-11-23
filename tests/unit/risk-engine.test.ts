import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel } from '../../src/sdk/core/cartography.js';
import type { Risk, RiskReport } from '../../src/sdk/core/risk.js';
import type { SourceFacts } from '../../src/cartography/facts.js';
import { ANALYZERS, runScan } from '../../src/cartography/scan.js';
import {
  applyOutcome,
  buildRiskReport,
  emptyRiskState,
  riskConfidence,
  verifyRisk,
} from '../../src/risk/engine.js';
import { RULES } from '../../src/risk/rules.js';
import { simulate } from '../../src/risk/verify.js';

/**
 * LE MOTEUR DE RISQUES D'ANOMALIES sur la fixture `tests/fixtures/risk` (front Angular + backend Spring),
 * lue par le vrai scanner : les cas A à L du cahier (positifs ET négatifs), la confiance séparée de la
 * sévérité, les statuts, la vérification par simulation, le test déclaré, la suppression, les règles
 * désactivées et le scan incrémental (sources reprises, identifiants stables, risque résolu après correction).
 */
const FIXTURE = path.resolve('tests/fixtures/risk');
const configOf = (root: string): CartographyConfig => ({
  schema: 1,
  sources: (
    [
      ['front', 'FRONTEND'],
      ['backend', 'BACKEND'],
    ] as const
  ).map(([id, layer]) => ({ id, name: id, layer, path: path.join(root, id), include: [], enabled: true })),
});

let model: CartographyModel;
let facts: SourceFacts[];
let report: RiskReport;
const find = (rule: string, text: string): Risk[] =>
  report.risks.filter((r) => r.ruleId === rule && `${r.title} ${r.entity}`.includes(text));
const one = (rule: string, text: string): Risk => {
  const found = find(rule, text);
  expect(found, `${rule} ${text}`).toHaveLength(1);
  return found[0] as Risk;
};

beforeAll(async () => {
  ({ model, facts } = await runScan({
    config: configOf(FIXTURE),
    allowedRoots: [FIXTURE],
    incremental: false,
  }));
  report = buildRiskReport({ model, facts, now: () => new Date('2026-11-23T10:00:00Z') });
}, 60_000);

describe('risk facts', () => {
  it('records the risk analyzer in the facts and its version in the analyzer chain', () => {
    expect(ANALYZERS).toContain('risk-1');
    const front = facts.find((f) => f.sourceId === 'front');
    expect(front?.risk?.holders.some((h) => h.owner === 'ClientStore' && h.member === 'selected')).toBe(true);
    expect(front?.risk?.holders.find((h) => h.owner === 'ScopedStore')?.scope).toBe('COMPONENT');
    expect(front?.risk?.holders.find((h) => h.owner === 'PrefsStore')?.persisted).toBe('localStorage');
    expect(
      facts.find((f) => f.sourceId === 'backend')?.risk?.java?.mutable.some((m) => m.field === 'lastClient'),
    ).toBe(true);
  });

  it('runs every enabled rule and measures the computation', () => {
    expect(report.metrics.rulesRun).toBe(RULES.length);
    expect(report.metrics.filesExamined).toBeGreaterThan(10);
    expect(report.metrics.sourcesWithoutFacts).toEqual([]);
    expect(report.engine).toBe('risk-engine-1');
  });
});

describe('cases A–L', () => {
  it('A — a store reset on destroy is not reported as stale state', () => {
    expect(find('RISK-STATE-001', 'OrderStore.current')).toHaveLength(0);
  });

  it('B — a root store kept between journeys is corroborated, with its readers, features and path', () => {
    const r = one('RISK-STATE-001', 'ClientStore.selected');
    expect(r.status).toBe('CORROBORATED');
    expect(r.severity).toBe('HIGH');
    const features = r.affectedFeatures.map((f) => f.name);
    expect(features).toEqual(expect.arrayContaining(['Contrat', 'Client detail']));
    // Le composant qui écrit la donnée n'est pas compté comme impacté.
    expect(features).not.toContain('Client list');
    expect(r.propagation.join(' → ')).toContain('GET /api/contracts');
    expect(r.impact?.edges.some((e) => e.link === 'PROVEN')).toBe(true);
    expect(r.evidence.every((e) => e.method.length > 0 && e.reliability.length > 0)).toBe(true);
    // Sans attendu métier, la simulation ne conclut pas.
    expect(r.verifications.at(-1)?.outcome).toBe('INCONCLUSIVE');
    expect(r.testPlan?.length).toBeGreaterThan(0);
  });

  it('C — a subscription released with takeUntil / unsubscribe is not reported', () => {
    expect(
      report.risks.filter((r) => r.category === 'CLEANUP' && r.title.includes('SafeComponent')),
    ).toHaveLength(0);
  });

  it('D — leaked subscriptions, listener and interval, and a duplicated subscription are reported', () => {
    expect(find('RISK-CLEAN-001', 'LeakyComponent')).toHaveLength(2);
    expect(find('RISK-CLEAN-002', 'LeakyComponent')).toHaveLength(2);
    expect(one('RISK-ASYNC-007', 'LeakyComponent#watch').status).toBe('CORROBORATED');
  });

  it('E — out-of-order responses and a race on the same target are reported', () => {
    expect(find('RISK-ASYNC-002', 'SearchComponent').length).toBeGreaterThanOrEqual(2);
    expect(one('RISK-ASYNC-001', 'SearchComponent.results').status).toBe('CORROBORATED');
  });

  it('F — a loading flag never reset on error is corroborated; the finalize variant is not reported', () => {
    expect(one('RISK-ASYNC-006', 'OrderPageComponent.loading').status).toBe('CORROBORATED');
    expect(find('RISK-ASYNC-006', 'saveSafely')).toHaveLength(0);
  });

  it('G — a stream without inner catchError stops at the first error', () => {
    const r = one('RISK-ASYNC-004', 'OrderStore.saved$');
    expect(r.severity).toBe('HIGH');
    expect(r.verifications.at(-1)?.outcome).toBe('CORROBORATED');
  });

  it('H — a filter shared by two tabs of the same screen is reported', () => {
    const r = one('RISK-STATE-005', 'FilterStore.filter');
    expect(r.affectedFeatures.map((f) => f.name)).toContain('Dossier');
  });

  it('I — a store never read, and a store scoped to its component, are not reported', () => {
    expect(report.risks.filter((r) => r.entity.includes('DraftStore'))).toHaveLength(0);
    expect(report.risks.filter((r) => r.entity.includes('ScopedStore'))).toHaveLength(0);
  });

  it('K — a value persisted in localStorage is not reported as stale state', () => {
    expect(report.risks.filter((r) => r.entity.includes('PrefsStore'))).toHaveLength(0);
  });

  it('L — a public holder (writers unknown) stays inconclusive', () => {
    const r = one('RISK-STATE-001', 'SessionStore.user');
    expect(r.status).toBe('INCONCLUSIVE');
    expect(r.unknowns.length).toBeGreaterThan(0);
  });

  it('backend — shared mutable singleton state, swallowed exception, writes without transaction', () => {
    expect(one('RISK-BE-001', 'lastClient').status).toBe('CORROBORATED');
    expect(one('RISK-BE-002', 'ContractService.read').status).toBe('POTENTIAL');
    expect(one('RISK-BE-003', 'ContractService.attach').status).toBe('POTENTIAL');
    expect(find('RISK-BE-003', 'transfer')).toHaveLength(0);
  });

  it('keeps confidence separate from severity and orders by severity then confidence', () => {
    const swallowed = one('RISK-BE-002', 'ContractService.read');
    expect(swallowed.severity).toBe('MEDIUM');
    expect(swallowed.confidence).toBeLessThan(0.5);
    const ranks = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
    for (let i = 1; i < report.risks.length; i += 1) {
      const a = report.risks[i - 1] as Risk;
      const b = report.risks[i] as Risk;
      expect(
        ranks[a.severity] > ranks[b.severity] || (a.severity === b.severity && a.confidence >= b.confidence),
      ).toBe(true);
    }
  });
});

describe('confidence, statuses and verification', () => {
  it('computes the documented confidence formula, bounded for static analysis', () => {
    const e = (relation: 'SUPPORTS' | 'WEAKENS', reliability: 'HIGH' | 'MEDIUM' | 'LOW') => ({
      kind: 'STATIC_FACT' as const,
      method: 'AST',
      reliability,
      relation,
      text: 't',
    });
    expect(riskConfidence([e('SUPPORTS', 'HIGH')], [], false).value).toBe(0.35);
    expect(riskConfidence([e('SUPPORTS', 'HIGH'), e('WEAKENS', 'MEDIUM')], ['u'], true).value).toBe(0.2);
    expect(
      riskConfidence(
        Array.from({ length: 8 }, () => e('SUPPORTS', 'HIGH')),
        [],
        true,
      ).value,
    ).toBe(0.9);
    expect(riskConfidence([e('WEAKENS', 'HIGH')], ['a', 'b', 'c', 'd'], false).value).toBe(0.05);
  });

  it('lets only a reproduction or a refutation override the status', () => {
    expect(applyOutcome('POTENTIAL', 'CORROBORATED')).toBe('CORROBORATED');
    expect(applyOutcome('CORROBORATED', 'INCONCLUSIVE')).toBe('CORROBORATED');
    expect(applyOutcome('CORROBORATED', 'REPRODUCED')).toBe('REPRODUCED');
    expect(applyOutcome('REPRODUCED', 'REFUTED')).toBe('REFUTED');
  });

  it('corroborates a stale state only when the business expectation is stated, and never reproduces by simulation', () => {
    const r = one('RISK-STATE-001', 'ClientStore.selected');
    const now = new Date('2026-11-23T10:00:00Z');
    expect(simulate(r, {}, now).outcome).toBe('INCONCLUSIVE');
    expect(simulate(r, { expected: 'Le détail est vide à l’arrivée.' }, now).outcome).toBe('CORROBORATED');
    for (const risk of report.risks)
      expect(simulate(risk, { expected: 'x' }, now).outcome).not.toBe('REPRODUCED');
  });

  it('records a declared external test, marks it stale when the code changes, and suppresses with a reason', () => {
    const r = one('RISK-STATE-001', 'ClientStore.selected');
    const declared = verifyRisk(
      r,
      { method: 'EXTERNAL_TEST', outcome: 'REPRODUCED', observed: 'Ancien contrat affiché.', by: 'qa' },
      new Date('2026-11-23T11:00:00Z'),
    );
    const state = emptyRiskState();
    state.verifications[r.id] = [declared, { ...declared, id: 'V-old', fingerprint: 'other-code' }];
    state.suppressions[one('RISK-BE-002', 'ContractService.read').id] = {
      by: 'qa',
      at: '2026-11-23T11:00:00Z',
      reason: 'Comportement voulu.',
    };
    const next = buildRiskReport({ model, facts, state });
    const again = next.risks.find((x) => x.id === r.id);
    expect(again?.status).toBe('REPRODUCED');
    expect(again?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(again?.verifications.find((v) => v.id === 'V-old')?.stale).toBe(true);
    expect(next.risks.find((x) => x.ruleId === 'RISK-BE-002')?.suppressed?.reason).toBe(
      'Comportement voulu.',
    );
  });

  it('does not run a disabled rule', () => {
    const state = { ...emptyRiskState(), disabled: ['RISK-CLEAN-002'] };
    const next = buildRiskReport({ model, facts, state });
    expect(next.risks.some((r) => r.ruleId === 'RISK-CLEAN-002')).toBe(false);
    expect(next.rules.find((r) => r.id === 'RISK-CLEAN-002')?.enabled).toBe(false);
    expect(next.metrics.rulesRun).toBe(RULES.length - 1);
  });
});

describe('J — incremental scan', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'risk-incremental-'));
    await cp(FIXTURE, root, { recursive: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reuses unchanged sources with identical risk ids, then resolves a risk once the code resets the value', async () => {
    const config = configOf(root);
    const first = await runScan({ config, allowedRoots: [root], incremental: false });
    const r1 = buildRiskReport(first);
    const second = await runScan({
      config,
      allowedRoots: [root],
      incremental: true,
      previous: { facts: first.facts, sources: first.model.scan.sources, model: first.model },
    });
    expect(second.model.scan.sources.every((s) => s.state === 'REUSED')).toBe(true);
    const r2 = buildRiskReport({ ...second, previous: r1 });
    expect(r2.metrics.reusedSources).toBe(2);
    expect(r2.risks.map((r) => r.id).sort()).toEqual(r1.risks.map((r) => r.id).sort());
    expect(r2.risks.every((r) => r.change === 'UNCHANGED')).toBe(true);

    const file = path.join(root, 'front/src/app/dossier/filter.store.ts');
    const code = await readFile(file, 'utf8');
    await writeFile(
      file,
      code.replace(/\n}\s*$/, "\n\n  clear(): void {\n    this.filter.next('');\n  }\n}\n"),
    );
    const third = await runScan({
      config,
      allowedRoots: [root],
      incremental: true,
      previous: { facts: second.facts, sources: second.model.scan.sources, model: second.model },
    });
    expect(third.model.scan.sources.find((s) => s.sourceId === 'front')?.state).toBe('SCANNED');
    expect(third.model.scan.sources.find((s) => s.sourceId === 'backend')?.state).toBe('REUSED');
    const r3 = buildRiskReport({ ...third, previous: r2 });
    const stale = r2.risks.find((r) => r.ruleId === 'RISK-STATE-001' && r.entity.includes('FilterStore'));
    expect(stale).toBeDefined();
    expect(r3.resolved).toContain(stale?.id);
    expect(r3.risks.some((r) => r.ruleId === 'RISK-STATE-001' && r.entity.includes('FilterStore'))).toBe(
      false,
    );
  }, 60_000);
});
