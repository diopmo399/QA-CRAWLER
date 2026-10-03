import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSummary } from '../../src/ai/audit-trail.js';
import { createCopilotProvider } from '../../src/ai/factory.js';
import type { SdkModelInfo } from '../../src/ai/models/capability-resolver.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { fakeSdk, type FakeSdkState } from '../fixtures/fake-copilot-sdk.js';
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

/** Ce que le compte « voit » (forme du ModelInfo du SDK ; identifiants neutres). */
const MODELS: SdkModelInfo[] = [
  {
    id: 'model-fast',
    capabilities: {
      supports: { vision: false, reasoningEffort: false },
      limits: { max_context_window_tokens: 64_000 },
    },
    policy: { state: 'enabled' },
  },
  {
    id: 'model-deep',
    capabilities: {
      supports: { vision: false, reasoningEffort: true },
      limits: { max_context_window_tokens: 200_000 },
    },
    policy: { state: 'enabled' },
    supportedReasoningEfforts: ['low', 'medium', 'high'],
  },
];

/** Copilot (simulé) : l'onglet qui mène aux champs, avec une hypothèse sur la cause. */
const answer = (prompt: string): string => {
  const json = prompt.split('\n').find((line) => line.startsWith('{')) ?? '{}';
  const request = JSON.parse(json) as { availableActions?: { id: string; name: string }[] };
  const tab = request.availableActions?.find((action) => action.name === 'Enterprise Details');
  return JSON.stringify({
    status: tab ? 'PROPOSAL' : 'INCONCLUSIVE',
    ...(tab ? { selectedActionId: tab.id } : {}),
    intent: 'OPEN_COMPANY_INFORMATION',
    hypothesis: { statement: 'The company section moved behind the Enterprise Details tab', evidenceIds: [] },
    expectedEffects: [{ kind: 'VISIBLE_FIELD', value: 'Company name' }],
    supportingEvidenceIds: [],
    uncertainties: [],
    confidence: tab ? 0.9 : 0,
  });
};

/**
 * COPILOT MODEL MANAGEMENT de bout en bout (§74) : explorateur → récupération déterministe
 * épuisée → ReasoningComplexityAnalyzer → ModelSelectionPolicy (modèles DÉCOUVERTS) → session
 * au modèle et à l'effort choisis → proposition → validation → SafetyPolicy → exécution →
 * objectif vérifié au runtime → audit par modèle → hypothèse IA (plafonnée).
 * Le SDK est simulé (forme réelle de @github/copilot-sdk) ; navigateur et crawler sont réels.
 */
describe('Copilot model selection end to end (fake SDK, real browser)', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-ai-models-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const run = async (
    name: string,
    copilot: string,
  ): Promise<{
    result: ExplorationResult;
    reportsDir: string;
    state: FakeSdkState;
    audit: () => Promise<AiSummary>;
  }> => {
    const reportsDir = path.join(dir, name);
    await mkdir(reportsDir, { recursive: true });
    const { config } = parseConfig(
      `mission: { name: models-${name} }
target: { baseUrl: ${app.url}, startAt: "/?v=ai" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay:
  effectTimeoutMs: 1200
  intelligentRecovery: { budgets: { maxRecoveryActions: 1 } }
ai:
  enabled: true
  mode: HYBRID
  copilot:
${copilot}
output: { reportsDir: ${reportsDir} }
flows:
  - name: Create request
    steps:
${FLOW}
`,
      {},
      {},
    );
    const { state, load } = fakeSdk(answer, {
      models: MODELS,
      usageModel: (session) => session.model ?? 'unknown',
    });
    const provider = createCopilotProvider(config.ai, { env: {}, sanitize: (value) => value, loadSdk: load });
    const { result } = await runMission(config, { env: {}, intelligenceProvider: provider });
    return {
      result,
      reportsDir,
      state,
      audit: async () =>
        JSON.parse(await readFile(path.join(reportsDir, 'ai', 'intelligence.json'), 'utf8')) as AiSummary,
    };
  };

  it('§74 ADAPTIVE: a deep divergence selects the INTELLIGENCE profile model with HIGH effort; the runtime confirms', async () => {
    const { result, reportsDir, state, audit } = await run(
      'adaptive',
      `    modelSelection:
      mode: ADAPTIVE
      profiles: { INTELLIGENCE: { models: [model-deep] } }`,
    );
    expect(result.flows[0]?.status).toBe('PASSED');
    // La session a été ouverte au modèle choisi et à l'effort qu'il déclare — rien d'autre.
    expect(state.sessionRequests).toHaveLength(1);
    expect(state.sessionRequests[0]).toMatchObject({ model: 'model-deep', reasoningEffort: 'high' });
    const summary = await audit();
    const decision = summary.decisions.find((entry) => entry.context === 'RECOVERY');
    expect(decision?.modelContext).toMatchObject({
      selectionMode: 'ADAPTIVE',
      profile: 'INTELLIGENCE',
      selectedModel: 'model-deep',
      effectiveModel: 'model-deep',
      requestedReasoningEffort: 'HIGH',
      sentReasoningEffort: 'HIGH',
      effectiveReasoningEffort: 'HIGH',
      fallbackApplied: false,
    });
    expect(['HIGH', 'VERY_HIGH']).toContain(decision?.modelContext?.complexity);
    expect(decision?.complexity?.reasons.join(' ')).toMatch(/workflow divergence/);
    expect(decision?.runtimeResult).toBe('GOAL_CONFIRMED');
    expect(summary.models).toEqual([
      expect.objectContaining({
        model: 'model-deep',
        calls: 1,
        accepted: 1,
        runtimeConfirmed: 1,
        recoverySolved: 1,
      }),
    ]);
    expect(summary.modelSelection).toMatchObject({
      selectionMode: 'ADAPTIVE',
      defaultProfile: 'BALANCED',
      discovery: { status: 'OK', available: 2, listed: 2 },
    });
    const log = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    for (const event of [
      'AI_MODEL_DISCOVERY_COMPLETED',
      'AI_MODEL_SELECTED',
      'AI_EFFECTIVE_MODEL_OBSERVED',
      'AI_RUNTIME_CONFIRMED',
    ])
      expect(log).toContain(event);
    expect(log).toMatch(
      /\[AI\] trigger=RECOVERY_EXHAUSTED complexity=(HIGH|VERY_HIGH) mode=ADAPTIVE profile=INTELLIGENCE model=model-deep reasoning=HIGH/,
    );
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('Models used (observed, not ranked)');
    expect(html).toContain('model-deep');
    // L'hypothèse de Copilot reste une hypothèse (preuve LLM, plafonnée), avec son origine.
    const hypotheses = JSON.parse(
      await readFile(path.join(reportsDir, 'cognitive', 'hypotheses.json'), 'utf8'),
    ) as {
      hypotheses: { proposition: string; status: string; confidence: number }[];
    };
    const claimed = hypotheses.hypotheses.find((entry) =>
      entry.proposition.includes('Enterprise Details tab'),
    );
    expect(claimed?.status).toBe('HYPOTHESIS');
    expect(claimed?.confidence).toBeLessThanOrEqual(0.3);
  }, 180_000);

  it('§65 / §71 EXPLICIT unavailable model: visible fallback, requested ≠ selected, the workflow still completes', async () => {
    const { result, reportsDir, state, audit } = await run(
      'explicit-missing',
      `    modelSelection: { mode: EXPLICIT, model: NON_EXISTENT_MODEL }`,
    );
    expect(result.flows[0]?.status).toBe('PASSED');
    // Jamais de session au modèle inexistant.
    expect(state.sessionRequests.map((config) => config.model)).toEqual(['auto']);
    const decision = (await audit()).decisions.find((entry) => entry.context === 'RECOVERY');
    expect(decision?.modelContext).toMatchObject({
      requestedModel: 'NON_EXISTENT_MODEL',
      selectedModel: 'auto',
      fallbackApplied: true,
      fallbackReason: 'MODEL_NOT_AVAILABLE',
    });
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('NON_EXISTENT_MODEL → auto');
    expect(html).toContain('fallback MODEL_NOT_AVAILABLE');
    expect(await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8')).toContain('AI_MODEL_FALLBACK');
  }, 180_000);
});
