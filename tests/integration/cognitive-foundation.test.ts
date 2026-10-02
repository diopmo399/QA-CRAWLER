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
      - fill: { label: Company name, value: Alpha }`;

interface HypothesisRow {
  id: string;
  proposition: string;
  kind: string;
  status: string;
  confidence: number;
  evidenceFor: { id: string; type: string }[];
}

/**
 * QA COGNITIVE ENGINE — fondations (lots A–C) de bout en bout : une observation reste une
 * hypothèse ; le même effet vu à nouveau au runtime (run suivant), avec l'intention
 * démontrée par l'humain, devient RUNTIME_CONFIRMED ; l'état métier de l'écran est lu.
 */
describe('Cognitive foundation (evidence, business state, causal hypotheses)', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-cognitive-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const run = async (name: string, extra = ''): Promise<string> => {
    const reportsDir = path.join(dir, 'shared', `reports-${name}`);
    await mkdir(reportsDir, { recursive: true });
    const { config } = parseConfig(
      `mission: { name: cognitive }
target: { baseUrl: ${app.url}, startAt: "/?v=1" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
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
    expect(result.flows[0]?.status).toBe('PASSED');
    return reportsDir;
  };
  const hypotheses = async (reportsDir: string): Promise<HypothesisRow[]> =>
    (
      JSON.parse(await readFile(path.join(reportsDir, 'cognitive', 'hypotheses.json'), 'utf8')) as {
        hypotheses: HypothesisRow[];
      }
    ).hypotheses;

  it('§91 / §92 / §16: run 1 makes hypotheses; run 2 confirms the demonstrated, re-observed relation', async () => {
    const first = await run('1');
    const before = await hypotheses(first);
    const eur = (rows: HypothesisRow[]) =>
      rows.find((row) => row.proposition === 'check eur REVEALS button:company information');
    // Une observation runtime + l'intention démontrée : soutenue, pas encore confirmée.
    expect(eur(before)?.status).toBe('SUPPORTED');
    expect(
      eur(before)
        ?.evidenceFor.map((reference) => reference.type)
        .sort(),
    ).toEqual(['HUMAN_RECORDING', 'RUNTIME']);
    // Une relation seulement observée (aucune autre source) reste une hypothèse.
    const observedOnly = before.filter(
      (row) =>
        row.status === 'HYPOTHESIS' && row.evidenceFor.every((reference) => reference.type === 'RUNTIME'),
    );
    expect(observedOnly.length).toBeGreaterThan(0);

    const second = await run('2');
    const after = await hypotheses(second);
    expect(eur(after)?.status).toBe('RUNTIME_CONFIRMED');
    expect(eur(after)?.evidenceFor.filter((reference) => reference.type === 'RUNTIME')).toHaveLength(2);
    const causal = JSON.parse(
      await readFile(path.join(second, 'cognitive', 'causal-graph.json'), 'utf8'),
    ) as {
      links: { cause: string; relation: string; effect: string; status: string }[];
    };
    expect(causal.links).toContainEqual(
      expect.objectContaining({
        cause: 'check eur',
        relation: 'REVEALS',
        effect: 'button:company information',
        status: 'RUNTIME_CONFIRMED',
      }),
    );
    // Run 1 crée les hypothèses ; run 2 les reprend (connaissance persistée) et confirme.
    expect(await readFile(path.join(first, 'engine-log.jsonl'), 'utf8')).toContain('HYPOTHESIS_CREATED');
    const log = await readFile(path.join(second, 'engine-log.jsonl'), 'utf8');
    for (const event of ['CAUSAL_RELATION_CONFIRMED', 'BUSINESS_STATE_UPDATED'])
      expect(log, event).toContain(event);
  }, 120_000);

  it('§8 / §89: the business state of the last screen and the functional model of the demonstrated journey', async () => {
    const reportsDir = await run('state');
    const { situation, functionalState } = JSON.parse(
      await readFile(path.join(reportsDir, 'cognitive', 'business-state.json'), 'utf8'),
    ) as {
      situation: {
        mission: string;
        phase: string;
        phases: { phase: string; status: string; missing: string[] }[];
      };
      functionalState: { blockedGoals: { goal: string }[] };
    };
    expect(situation).toMatchObject({ mission: 'CREATE_REQUEST', phase: 'COMPANY_INFORMATION' });
    expect(situation.phases).toContainEqual({
      phase: 'COMPANY_INFORMATION',
      status: 'INCOMPLETE',
      missing: ['Business number'],
      invalid: [],
    });
    expect(functionalState.blockedGoals.map((goal) => goal.goal)).toContain('COMPANY_INFORMATION_COMPLETE');
    const model = JSON.parse(
      await readFile(path.join(reportsDir, 'cognitive', 'functional-model.json'), 'utf8'),
    ) as {
      phases: { id: string; fields: string[] }[];
    };
    expect(model.phases[0]).toMatchObject({ id: 'COMPANY_INFORMATION', fields: ['Company name'] });
  }, 90_000);

  it('cognitive.enabled: false writes nothing and changes nothing', async () => {
    const reportsDir = await run('off', 'cognitive: { enabled: false }');
    await expect(readFile(path.join(reportsDir, 'cognitive', 'hypotheses.json'), 'utf8')).rejects.toThrow();
  }, 90_000);
});
