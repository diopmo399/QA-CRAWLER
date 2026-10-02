import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';
import { startWorkflowApp, type WorkflowApp } from '../fixtures/workflow-app.js';

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

interface PlanFile {
  flows: {
    flow: string;
    plans: { kind: string; steps: { kind: string; label: string; role?: string; source: string }[] }[];
    repair?: { status: string; explanation: string[] };
  }[];
  checkpoints: { id: string; status: string }[];
}

/**
 * Lots D–E de bout en bout : objectifs, préconditions, plans et checkpoints sémantiques.
 * Le checkpoint métier est le même que l'interface ait un bouton (V1) ou un onglet (V3) ;
 * le plan réparé remplace l'étape, le plan enregistré reste intact.
 */
describe('Cognitive planning (goals, checkpoints, plan repair)', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-cognitive-plan-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const run = async (
    name: string,
    version: string,
  ): Promise<{ plan: PlanFile; log: string; status: string }> => {
    const reportsDir = path.join(dir, name, 'reports');
    await mkdir(reportsDir, { recursive: true });
    const { config } = parseConfig(
      `mission: { name: plan-${name} }
target: { baseUrl: ${app.url}, startAt: "/?v=${version}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
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
      plan: JSON.parse(await readFile(path.join(reportsDir, 'cognitive', 'plan.json'), 'utf8')) as PlanFile,
      log: await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8'),
      status: result.flows[0]?.status ?? '?',
    };
  };

  it('§97 / §35: the business checkpoint is reached on V1 (button) and V3 (tab) alike', async () => {
    for (const version of ['1', '3']) {
      const { plan, log, status } = await run(`checkpoint-v${version}`, version);
      expect(status, version).toBe('PASSED');
      expect(
        plan.checkpoints.find((checkpoint) => checkpoint.id === 'COMPANY_INFORMATION_COMPLETE')?.status,
        version,
      ).toBe('CONFIRMED');
      expect(log, version).toContain('SEMANTIC_CHECKPOINT_REACHED');
      expect(log, version).toContain('GOAL_CREATED');
    }
  }, 180_000);

  it('§31 / §32 / §96: recorded, current and repaired plans; the repaired plan replaces the step, the recorded one is intact', async () => {
    const { plan, log } = await run('repair', '3');
    const [flow] = plan.flows;
    expect(flow?.plans.map((candidate) => candidate.kind)).toEqual([
      'RECORDED_PLAN',
      'CURRENT_PLAN',
      'RECOVERED_PLAN',
      'SUGGESTED_PLAN',
    ]);
    const recorded = flow?.plans[0];
    const recovered = flow?.plans[2];
    expect(recorded?.steps[3]).toMatchObject({
      kind: 'click',
      label: 'Company information',
      source: 'RECORDED',
    });
    expect(recovered?.steps[3]).toMatchObject({
      kind: 'click',
      role: 'tab',
      label: 'Company',
      source: 'RECOVERY',
    });
    expect(recovered?.steps).toHaveLength(recorded?.steps.length ?? 0);
    expect(flow?.repair?.status).toBe('REPAIRED');
    expect(log).toContain('PLAN_REPAIRED');
  }, 120_000);

  it('§26 / §28: when the goal is blocked, the missing precondition and its action are reported', async () => {
    const { log } = await run('blocked', '1');
    // L'envoi n'est jamais fait par ce flow : la mission reste bloquée sur sa dernière précondition.
    expect(log).toMatch(/GOAL_BLOCKED/);
    expect(log).toMatch(/PRECONDITION_DISCOVERED/);
  }, 120_000);
});
