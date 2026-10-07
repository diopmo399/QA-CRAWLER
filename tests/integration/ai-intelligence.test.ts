import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSummary } from '../../src/ai/audit-trail.js';
import type { IntelligenceProvider } from '../../src/ai/provider.js';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { FakeIntelligenceProvider, proposeByName } from '../fixtures/fake-intelligence-provider.js';
import { startWorkflowApp, type WorkflowApp } from '../fixtures/workflow-app.js';

/** Le parcours enregistré sur la V1 (bouton « Company information »), effets appris compris. */
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

/**
 * AI REASONING ADVISOR de bout en bout (§99–§100, §116) : la V2 remplace le bouton par un
 * onglet « Enterprise Details » à côté d'un lien trompeur « Company Profile ». Le fournisseur
 * est simulé (aucun appel réel à Copilot) ; tout le reste est réel : navigateur, SafetyPolicy,
 * exécuteur, vérification de l'objectif au runtime, rapport.
 */
describe('AI reasoning advisor end to end (fake provider, real browser)', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-ai-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const run = async (
    name: string,
    query: string,
    ai: string,
    provider?: IntelligenceProvider,
    recovery = '',
  ): Promise<{ result: ExplorationResult; reportsDir: string; audit: () => Promise<AiSummary> }> => {
    const reportsDir = path.join(dir, name);
    await mkdir(reportsDir, { recursive: true });
    const { config } = parseConfig(
      `mission: { name: ai-${name} }
target: { baseUrl: ${app.url}, startAt: "/${query}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay:
  effectTimeoutMs: 1200
  intelligentRecovery: { ${recovery} }
${ai}
output: { reportsDir: ${reportsDir} }
flows:
  - name: Create request
    steps:
${FLOW}
`,
      {},
      {},
    );
    const { result } = await runMission(config, {
      env: {},
      ...(provider ? { intelligenceProvider: provider } : {}),
    });
    return {
      result,
      reportsDir,
      audit: async () =>
        JSON.parse(await readFile(path.join(reportsDir, 'ai', 'intelligence.json'), 'utf8')) as AiSummary,
    };
  };

  /** La récupération déterministe n'a droit qu'à UNE action : elle essaie le lien trompeur et s'arrête. */
  const LIMITED = 'budgets: { maxRecoveryActions: 1 }';
  const HYBRID = 'ai: { enabled: true, mode: HYBRID }';
  const ASSIST = 'ai: { enabled: true, mode: ASSIST }';
  const openingStep = (result: ExplorationResult) =>
    result.flows[0]?.steps.find((step) => step.description.includes('Company information'));
  const correct = () =>
    new FakeIntelligenceProvider(
      proposeByName('Enterprise Details', 0.91, {
        intent: 'OPEN_COMPANY_INFORMATION',
        expectedEffects: [
          { kind: 'VISIBLE_FIELD', value: 'Company name' },
          { kind: 'VISIBLE_FIELD', value: 'Business number' },
        ],
      }),
    );

  it('§83 / §118 OFF: no advisor, no audit — the limited deterministic recovery fails as before', async () => {
    const { result, reportsDir } = await run('off', '?v=ai', '', undefined, LIMITED);
    expect(result.ai).toBeUndefined();
    expect(openingStep(result)?.status).toBe('FAILED');
    await expect(readFile(path.join(reportsDir, 'ai', 'intelligence.json'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(reportsDir, 'index.html'), 'utf8')).not.toContain('AI Intelligence');
  }, 180_000);

  it('§99 / §119 HYBRID: the advisor proposes the tab; validated, SAFE, executed, goal verified at runtime — the workflow continues', async () => {
    const provider = correct();
    const { result, reportsDir, audit } = await run('hybrid', '?v=ai', HYBRID, provider, LIMITED);
    const flow = result.flows[0];
    expect(flow?.status).toBe('PASSED');
    const step = openingStep(result);
    expect(step?.recovery?.outcome).toMatchObject({ status: 'GOAL_REACHED', pathSource: 'AI_PROPOSAL' });
    expect(step?.recovery?.outcome.path).toEqual([
      expect.objectContaining({ kind: 'click', role: 'tab', name: 'Enterprise Details' }),
    ]);
    // Le fournisseur n'a reçu qu'une représentation sémantique : but, champs suivants, actions avec leur sûreté.
    const request = provider.requests[0];
    expect(request).toMatchObject({
      trigger: 'RECOVERY_EXHAUSTED',
      workflowContext: { requiredFields: ['Company name', 'Business number'] },
    });
    expect(request?.goal?.id).toMatch(/COMPANY/);
    const offered =
      request?.availableActions.map((action) => `${action.type} ${action.name} ${action.safety}`) ?? [];
    expect(offered).toEqual(
      expect.arrayContaining(['TAB Enterprise Details SAFE', 'LINK Company Profile SAFE']),
    );
    expect(offered.find((entry) => entry.startsWith('BUTTON Remove company information'))).not.toMatch(
      /SAFE$/,
    );
    expect(JSON.stringify(request)).not.toMatch(/<(div|button|section|input)\b|Alpha|1234567890/);
    const summary = await audit();
    expect(summary).toMatchObject({
      mode: 'HYBRID',
      provider: 'fake',
      accepted: 1,
      runtimeConfirmed: 1,
      runtimeContradicted: 0,
      aiAssistedRecoveries: 1,
    });
    expect(summary.decisions[0]).toMatchObject({
      context: 'RECOVERY',
      validation: { status: 'VALID' },
      safety: 'SAFE',
      source: 'AI_PROPOSAL',
      runtimeResult: 'GOAL_CONFIRMED',
      knowledgeCandidate: { origin: 'AI_PROPOSAL', runtimeConfirmed: true },
    });
    const log = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    // PROPOSITION → CANDIDAT → SafetyPolicy → exécution → effet vérifié, dans cet ordre.
    const sequence = [
      'AI_PROPOSAL_RECEIVED',
      'AI_PROPOSAL_VALIDATED',
      'AI_PROPOSAL_CONVERTED_TO_RECOVERY_CANDIDATE',
      'AI_RECOVERY_CANDIDATE_SELECTED',
      'AI_RECOVERY_EXECUTED',
      'AI_RECOVERY_EFFECT_CONFIRMED',
    ];
    const positions = sequence.map((event) => log.indexOf(`"${event}"`));
    expect(
      positions.every((position) => position >= 0),
      JSON.stringify(positions),
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const event of ['AI_TRIGGER_EVALUATED', 'AI_PROPOSAL_ACCEPTED', 'AI_RUNTIME_CONFIRMED'])
      expect(log).toContain(event);
    expect(log).toMatch(
      /AI_RECOVERY_CANDIDATE_SELECTED[^\n]*click tab \\"Enterprise Details\\"[^\n]*SAFETY=SAFE/,
    );
    // UNE consultation pour la divergence : pas d'analyse d'échec en plus.
    expect(provider.requests).toHaveLength(1);
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('AI Intelligence');
    expect(html).toContain('GOAL_CONFIRMED');
    expect(provider.closed).toBe(true);
  }, 180_000);

  it('§100 / §94 HYBRID, wrong proposal: executed, goal NOT reached → runtime contradiction, never PASS, never learned', async () => {
    const provider = new FakeIntelligenceProvider(proposeByName('Company Profile', 0.92));
    const { result, reportsDir, audit } = await run('wrong', '?v=ai', HYBRID, provider, LIMITED);
    expect(result.flows[0]?.status).not.toBe('PASSED');
    expect(openingStep(result)?.status).toBe('FAILED');
    expect(openingStep(result)?.recovery?.outcome.reasons.join(' ')).toMatch(/contradicted at runtime/);
    const summary = await audit();
    expect(summary).toMatchObject({
      accepted: 1,
      runtimeConfirmed: 0,
      runtimeContradicted: 1,
      aiAssistedRecoveries: 0,
    });
    expect(summary.decisions[0]?.knowledgeCandidate).toEqual({
      origin: 'AI_PROPOSAL',
      runtimeConfirmed: false,
    });
    const log = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    expect(log).toContain('AI_RUNTIME_CONTRADICTED');
    // EXÉCUTÉ ≠ CONFIRMÉ : l'effet attendu est absent → contredit, jamais appris.
    expect(log).toContain('AI_RECOVERY_EXECUTED');
    expect(log).toContain('AI_RECOVERY_EFFECT_CONTRADICTED');
    expect(log).not.toContain('AI_RECOVERY_EFFECT_CONFIRMED');
    // Une consultation pour la divergence : l'échec qui suit n'en déclenche pas une seconde.
    expect(provider.requests).toHaveLength(1);
  }, 180_000);

  it('HYBRID: an action given only as the plan, with separate confidences (action 0.87, abstention 0.10) — a real recovery candidate, executed and confirmed', async () => {
    const provider = new FakeIntelligenceProvider((request) => {
      const tab = request.availableActions.find((action) => action.name === 'Enterprise Details');
      return {
        status: 'PROPOSAL',
        intent: 'open company information section',
        plan: { steps: [tab?.id ?? 'A999'] },
        proposedGoal: { id: request.goal?.id ?? 'COMPANY_INFORMATION_AVAILABLE' },
        expectedEffects: [{ kind: 'VISIBLE_FIELD', value: 'Company name' }],
        supportingEvidenceIds: [],
        uncertainties: [],
        confidence: 0.89,
        confidenceBreakdown: { action: 0.87, hypothesis: 0.82, goal: 0.94, abstention: 0.1, overall: 0.89 },
      };
    });
    const { result, reportsDir, audit } = await run('hybrid-plan', '?v=ai', HYBRID, provider, LIMITED);
    expect(result.flows[0]?.status).toBe('PASSED');
    expect(openingStep(result)?.recovery?.outcome).toMatchObject({
      status: 'GOAL_REACHED',
      pathSource: 'AI_PROPOSAL',
    });
    const decision = (await audit()).decisions[0];
    expect(decision).toMatchObject({ source: 'AI_PROPOSAL', runtimeResult: 'GOAL_CONFIRMED' });
    expect(decision?.proposal?.confidences).toMatchObject({ action: 0.87, abstention: 0.1 });
    expect(decision?.lifecycle.notExecutedReason).toBeUndefined();
    const log = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    expect(log).toContain('AI_RECOVERY_EFFECT_CONFIRMED');
    expect(log).not.toContain('ADVISORY_ONLY');
    // La divergence n'est jamais cachée : la récupération est un écart du flow enregistré, qui n'est pas modifié.
    const drift = result.flows[0]?.drift;
    expect(drift?.detected).toBe(true);
    expect(drift?.result).toBe('PASS_WITH_GOAL_RECOVERY');
    expect(drift?.facts.goalRecoveredActions).toBe(1);
    expect(drift?.classification).toMatch(/STRUCTURAL_UI_DRIFT|WORKFLOW_DRIFT/);
  }, 180_000);

  it('§84 / §46 ASSIST: the same good proposal is only measured — nothing is executed on its behalf', async () => {
    const { result, audit } = await run('assist', '?v=ai', ASSIST, correct(), LIMITED);
    expect(openingStep(result)?.status).toBe('FAILED');
    const summary = await audit();
    expect(summary).toMatchObject({ mode: 'ASSIST', accepted: 0, proposals: 1, runtimeConfirmed: 0 });
    expect(summary.decisions[0]).toMatchObject({
      outcome: 'SHADOW',
      source: 'NONE',
      runtimeResult: 'NOT_EXECUTED',
    });
  }, 180_000);

  it('§88 HYBRID, unsafe proposal: the SafetyPolicy refuses it — the writing button is never clicked', async () => {
    const before = app.counts.removed;
    const { result, audit } = await run(
      'unsafe',
      '?v=ai',
      HYBRID,
      new FakeIntelligenceProvider(proposeByName('Remove company information', 0.99)),
      LIMITED,
    );
    expect(app.counts.removed).toBe(before);
    expect(openingStep(result)?.status).toBe('FAILED');
    const summary = await audit();
    expect(summary.accepted).toBe(0);
    expect(summary.decisions[0]?.reasons.join(' ')).toMatch(/SafetyPolicy refuses/);
  }, 180_000);

  it('§87 HYBRID, invented action: rejected before anything reaches the browser', async () => {
    const provider = new FakeIntelligenceProvider(() => ({
      status: 'PROPOSAL',
      selectedActionId: 'A999',
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 0.99,
    }));
    const { result, audit } = await run('invented', '?v=ai', HYBRID, provider, LIMITED);
    expect(openingStep(result)?.status).toBe('FAILED');
    expect((await audit()).decisions[0]?.validation).toMatchObject({
      status: 'REJECTED',
      rejection: 'AI_PROPOSAL_UNKNOWN_ACTION',
    });
  }, 180_000);

  it('§90 / §91 / §92 unavailable, timeout, budget: deterministic fallback, the run completes', async () => {
    const offline = await run(
      'offline',
      '?v=ai',
      HYBRID,
      new FakeIntelligenceProvider(() => ({}), { available: false, reason: 'not signed in' }),
      LIMITED,
    );
    expect(offline.result.ai).toMatchObject({
      available: false,
      unavailableReason: 'not signed in',
      unavailable: 1,
    });
    expect(openingStep(offline.result)?.status).toBe('FAILED');

    const slow = await run(
      'slow',
      '?v=ai',
      'ai: { enabled: true, mode: HYBRID, copilot: { timeoutMs: 1000, maxRetries: 0 } }',
      new FakeIntelligenceProvider(proposeByName('Enterprise Details', 0.9), { delayMs: 4_000 }),
      LIMITED,
    );
    expect(slow.result.ai).toMatchObject({ timeouts: 1, accepted: 0 });

    const broke = new FakeIntelligenceProvider(proposeByName('Enterprise Details', 0.9));
    const budget = await run(
      'budget',
      '?v=ai',
      'ai: { enabled: true, mode: HYBRID, budgets: { maxCallsPerRun: 0 } }',
      broke,
      LIMITED,
    );
    expect(broke.requests).toHaveLength(0);
    expect(budget.result.ai).toMatchObject({ budgetExhausted: 1, accepted: 0 });
  }, 300_000);

  it('§43 / §95 exploration (HYBRID): low-confidence screens are reasoned with the advisor; every retained proposal is verified at runtime', async () => {
    // Le fournisseur propose toujours la première action SÛRE et autorisée.
    const provider = new FakeIntelligenceProvider((request) => {
      const action = request.availableActions.find(
        (candidate) => candidate.safety === 'SAFE' && candidate.allowed,
      );
      return action
        ? {
            status: 'PROPOSAL',
            selectedActionId: action.id,
            supportingEvidenceIds: [],
            uncertainties: [],
            confidence: 0.9,
          }
        : { status: 'INCONCLUSIVE', supportingEvidenceIds: [], uncertainties: [], confidence: 0 };
    });
    const reportsDir = path.join(dir, 'explore');
    await mkdir(reportsDir, { recursive: true });
    const { config } = parseConfig(
      `mission: { name: ai-explore }
target: { baseUrl: ${app.url}, startAt: "/?v=1" }
exploration: { actionTimeoutMs: 3000, settleTimeMs: 100, maxActions: 10 }
report: { failOnSeverity: NONE }
ai: { enabled: true, mode: HYBRID, budgets: { maxCallsPerRun: 4 } }
output: { reportsDir: ${reportsDir} }
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {}, intelligenceProvider: provider });
    const exploration = result.ai?.decisions.filter((decision) => decision.context === 'EXPLORATION') ?? [];
    expect(exploration.length).toBeGreaterThan(0);
    expect(provider.requests.length).toBeLessThanOrEqual(4);
    for (const decision of exploration.filter((candidate) => candidate.accepted))
      expect(['GOAL_CONFIRMED', 'RUNTIME_CONTRADICTED', 'NOT_EXECUTED']).toContain(decision.runtimeResult);
    // Jamais une mutation proposée : chaque action offerte comme « autorisée » est SÛRE.
    for (const request of provider.requests)
      for (const action of request.availableActions.filter(
        (candidate) => candidate.allowed && candidate.safety !== 'SAFE',
      ))
        expect(action.safety).toMatch(/MUTATION|DANGEROUS|UNKNOWN/);
  }, 180_000);
});
