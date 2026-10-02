import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startWorkflowApp, type WorkflowApp } from '../fixtures/workflow-app.js';

/** Le parcours démontré sur la version 1 (effets appris compris). */
const FLOW = `      - click: { role: button, name: Tasks }
        effects: { appears: ["button:Enterprise interview"] }
      - click: { role: button, name: Enterprise interview }
        effects: { appears: ["checkbox:EUR"] }
      - check: { label: EUR }
        effects: { appears: ["button:Company information"] }
      - click: { role: button, name: Company information }
        effects: { appears: ["textbox:Company name", "textbox:Business number"] }
      - fill: { label: Company name, value: Alpha }
      - fill: { label: Business number, value: "1234567890" }`;

interface HypothesisRow {
  proposition: string;
  status: string;
}

/**
 * Lots J–L de bout en bout : décisions raisonnées (WHY / WHY NOT), rapport cognitif, et une
 * application qui CHANGE de version (§105–§106) — le crawler garde l'objectif fonctionnel,
 * répare le plan, reconfirme ce qui tient, rend obsolète (STALE) ce qui n'est plus revu, et
 * voit l'invariant violé.
 */
describe('Cognitive reasoning and learning across application versions', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-cognitive-reason-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const run = async (
    shared: string,
    name: string,
    query: string,
    extra = '',
    exploration = '{ actionTimeoutMs: 3000, settleTimeMs: 100, maxActions: 12 }',
  ): Promise<{ result: ExplorationResult; reportsDir: string; read: <T>(file: string) => Promise<T> }> => {
    const reportsDir = path.join(dir, shared, `reports-${name}`);
    await mkdir(reportsDir, { recursive: true });
    const { config } = parseConfig(
      `mission: { name: reasoning }
target: { baseUrl: ${app.url}, startAt: "/${query}" }
exploration: ${exploration}
report: { failOnSeverity: NONE }
cognitive:
  invariants: { multiple: 1, supported: 2, confirmed: 3, runsForSupported: 1, runsForConfirmed: 2 }
${extra}
output: { reportsDir: ${reportsDir} }
flows:
  - name: Create request
    steps:
${FLOW}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    return {
      result,
      reportsDir,
      read: async <T>(file: string) =>
        JSON.parse(await readFile(path.join(reportsDir, 'cognitive', file), 'utf8')) as T,
    };
  };

  it('§38–§43 / §81 / §83: exploration after the flow is reasoned — decisions with WHY / WHY NOT, reported', async () => {
    const { result, read, reportsDir } = await run(
      'explore',
      'run',
      '?v=1',
      'knowledge: { appVersion: "1" }',
    );
    const reasoning = await read<{
      decisions: {
        status: string;
        reason?: string;
        why: string[];
        alternatives: { reasons: string[] }[];
        narration: string[];
      }[];
    }>('reasoning.json');
    const decided = reasoning.decisions.filter((decision) => decision.status === 'DECIDED');
    expect(decided.length).toBeGreaterThan(0);
    for (const decision of decided) {
      expect(['GOAL', 'COVERAGE', 'HYPOTHESIS', 'RECOVERY', 'CONTRADICTION', 'INVARIANT']).toContain(
        decision.reason,
      );
      expect(decision.why.length).toBeGreaterThan(0);
      expect(decision.narration.length).toBeGreaterThan(0);
    }
    // Les mutations sont toujours listées comme écartées (jamais choisies par le raisonnement).
    const rejections = reasoning.decisions.flatMap((decision) =>
      decision.alternatives.flatMap((alternative) => alternative.reasons),
    );
    expect(rejections.length).toBeGreaterThan(0);
    expect(result.cognitive?.decisions.length).toBeGreaterThan(0);
    expect(result.cognitive?.mission).toBe('CREATE_REQUEST');
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('Cognitive engine');
    expect(html).toContain('Reasoning decisions (WHY / WHY NOT)');
    expect(await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8')).toContain(
      'REASONING_DECISION_CREATED',
    );
  }, 180_000);

  it('§105 / §106: V1 learned over runs; V2 (renamed, tab, new prerequisite, looser validation) keeps the goal, repairs the plan, reconfirms, marks stale, sees the violation', async () => {
    const v1 = 'knowledge: { appVersion: "1" }';
    const replayOnly = '{ autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }';
    await run('versions', 'v1-a', '?v=1&strict=1', v1, replayOnly);
    const learned = await run('versions', 'v1-b', '?v=1&strict=1', v1, replayOnly);
    const before = await learned.read<{ hypotheses: HypothesisRow[] }>('hypotheses.json');
    const status = (rows: HypothesisRow[], proposition: string) =>
      rows.find((row) => row.proposition === proposition)?.status;
    expect(status(before.hypotheses, 'check eur REVEALS button:company information')).toBe(
      'RUNTIME_CONFIRMED',
    );
    expect(status(before.hypotheses, 'click enterprise interview REVEALS checkbox:eur')).toBe(
      'RUNTIME_CONFIRMED',
    );

    const v2 = await run('versions', 'v2', '?v=4&strict=0', 'knowledge: { appVersion: "2" }', replayOnly);
    expect(v2.result.flows[0]?.status).toBe('PASSED');
    const after = await v2.read<{ hypotheses: HypothesisRow[] }>('hypotheses.json');
    // Ce qui tient sur la nouvelle version est reconfirmé ; ce qui n'est plus revu devient STALE.
    expect(status(after.hypotheses, 'click enterprise interview REVEALS checkbox:eur')).toBe(
      'RUNTIME_CONFIRMED',
    );
    expect(status(after.hypotheses, 'check eur REVEALS button:company information')).toBe('STALE');
    // L'objectif fonctionnel est maintenu : même checkpoint, plan réparé.
    const plan = await v2.read<{
      flows: { repair?: { status: string } }[];
      checkpoints: { id: string; status: string }[];
    }>('plan.json');
    expect(plan.flows[0]?.repair?.status).toBe('REPAIRED');
    expect(
      plan.checkpoints.find((checkpoint) => checkpoint.id === 'COMPANY_INFORMATION_COMPLETE')?.status,
    ).toBe('CONFIRMED');
    // La règle de validation a changé : l'invariant appris sur V1 est violé (avec sa provenance).
    const invariants = await v2.read<{ invariants: { statement: string; status: string }[] }>(
      'invariants.json',
    );
    expect(
      invariants.invariants.find((invariant) => invariant.statement.includes('submit disabled UNTIL'))
        ?.status,
    ).toBe('VIOLATED');
    expect(v2.result.cognitive?.recoveredPlans.length).toBeGreaterThan(0);
  }, 300_000);
});
