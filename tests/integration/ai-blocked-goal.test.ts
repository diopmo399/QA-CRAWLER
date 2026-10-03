import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IntelligenceDecisionEntry } from '../../src/ai/decision-report.js';
import type { AiLifecycleSummary } from '../../src/ai/audit-trail.js';
import type { IntelligenceRequest } from '../../src/ai/model.js';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

/**
 * Le cas réel (§47) : le formulaire est PRÊT (submission READY), l'envoi est cliqué… et rien ne
 * se passe, parce qu'une action « Apply » cachée doit d'abord valider la saisie. L'objectif reste
 * bloqué, la cause est inconnue du moteur déterministe : UNKNOWN_BLOCKING_PRECONDITION.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request</title>
<style>.hidden{display:none}</style></head><body><main>
<h1>New request</h1>
<label><input type="checkbox" id="eur"> EUR</label>
<button type="button" id="open" class="hidden">Company information</button>
<section id="company" class="hidden">
  <label>Company name <input id="name" required></label>
  <label>Business number <input id="number" required></label>
  <button type="button" id="apply">Apply</button>
</section>
<button type="submit" id="submit">Submit</button>
<p id="done" class="hidden">Request created</p>
</main><script>
  let applied = false;
  document.getElementById('eur').addEventListener('change', (event) => {
    document.getElementById('open').classList.toggle('hidden', !event.target.checked);
  });
  document.getElementById('open').addEventListener('click', () => {
    document.getElementById('company').classList.remove('hidden');
  });
  document.getElementById('apply').addEventListener('click', () => { applied = true; });
  document.getElementById('submit').addEventListener('click', async () => {
    if (!applied) return;
    await fetch('/api/requests', { method: 'POST', body: '{}' });
    document.getElementById('done').classList.remove('hidden');
  });
</script></body></html>`;

/** Copilot (simulé) : sur un objectif bloqué, une précondition manquante plausible ; sinon rien de sûr. */
const answer = (request: IntelligenceRequest): unknown => {
  if (request.trigger !== 'UNKNOWN_BLOCKING_PRECONDITION')
    return {
      status: 'INCONCLUSIVE',
      supportingEvidenceIds: [],
      uncertainties: ['not my question'],
      confidence: 0,
    };
  const apply = request.availableActions.find((action) => action.name === 'Apply');
  return {
    status: 'PROPOSAL',
    ...(apply ? { selectedActionId: apply.id } : {}),
    missingPrecondition: 'FINAL_APPLY_REQUIRED',
    hypothesis: {
      type: 'WORKFLOW_PRECONDITION',
      statement: 'An Apply action may be required before the request can be created.',
      evidenceIds: [],
    },
    expectedEffects: [{ kind: 'CHECKPOINT', value: 'CREATE_REQUEST_DONE' }],
    supportingEvidenceIds: [],
    uncertainties: [],
    confidence: 0.74,
  };
};

describe('AI decision lifecycle end to end: blocked goal with an unknown precondition (real browser, fake Copilot)', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url?.startsWith('/api/')) {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('§47 the blocked goal is analyzed, UNKNOWN_BLOCKING_PRECONDITION is sent with the functional context, every call is classified', async () => {
    const reportsDir = await mkdtemp(path.join(tmpdir(), 'qa-ai-blocked-'));
    const { config } = parseConfig(
      `mission: { name: blocked-goal }
target: { baseUrl: ${url}, startAt: "/" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay: { effectTimeoutMs: 800 }
ai: { enabled: true, mode: ASSIST, provider: deterministic }
output: { reportsDir: ${reportsDir} }
flows:
  - name: Create request
    steps:
      - check: { label: EUR }
      - click: { role: button, name: Company information }
      - fill: { label: Company name, value: Alpha }
      - fill: { label: Business number, value: "1234567890" }
      - click: { role: button, name: Submit }
        allow: [MUTATION]
      - expect: { text: Request created }
`,
      {},
      {},
    );
    const provider = new FakeIntelligenceProvider(answer);
    const { result } = await runMission(config, { env: {}, intelligenceProvider: provider });
    expect(result.flows[0]?.status).toBe('FAILED');

    // PRECONDITION RESOLVER : prêt à l'envoi, envoi fait sans effet → cause inconnue.
    const blocked = result.cognitive?.blockedGoal;
    expect(blocked).toMatchObject({ goal: 'CREATE_REQUEST', state: 'BLOCKED', unknownPrecondition: true });
    expect(blocked?.missingPreconditions).toContain('UNKNOWN');
    expect(blocked?.blockingReasons.join(' ')).toMatch(/"Submit" executed/);

    // COPILOT a reçu le contexte fonctionnel, pas seulement « blocked ».
    const asked = provider.requests.find((request) => request.trigger === 'UNKNOWN_BLOCKING_PRECONDITION');
    expect(asked?.functionalContext).toMatchObject({
      missingPreconditions: ['UNKNOWN'],
      unknownPrecondition: true,
    });
    expect(asked?.functionalContext?.question).toMatch(/remains blocked/);
    expect(asked?.mission).toBe('CREATE_REQUEST');

    // Chaque appel a UNE issue, et la décision d'analyse est SHADOW_ONLY (ASSIST), jamais un repli.
    const artifact = JSON.parse(
      await readFile(path.join(reportsDir, 'intelligence-decisions.json'), 'utf8'),
    ) as {
      lifecycle: AiLifecycleSummary;
      decisions: IntelligenceDecisionEntry[];
    };
    const lifecycle = artifact.lifecycle;
    expect(lifecycle.consistent).toBe(true);
    const calls = artifact.decisions.filter((decision) =>
      ['PROPOSAL', 'INCONCLUSIVE', 'NEED_MORE_EVIDENCE', 'INVALID_RESPONSE', 'TIMEOUT', 'ERROR'].includes(
        decision.response,
      ),
    );
    expect(calls).toHaveLength(lifecycle.calls);
    expect(provider.requests).toHaveLength(lifecycle.calls);
    const decision = artifact.decisions.find((entry) => entry.trigger === 'UNKNOWN_BLOCKING_PRECONDITION');
    expect(decision).toMatchObject({
      context: 'BLOCKED_GOAL',
      response: 'PROPOSAL',
      terminal: 'SHADOW_ONLY',
      executionResult: { acceptedForExecution: false, notExecutedReason: 'ASSIST_MODE' },
      functionalContextSummary: {
        goal: 'CREATE_REQUEST_DONE',
        missingPreconditions: ['UNKNOWN'],
        unknownPrecondition: true,
      },
      knowledgeImpact: { impact: 'AI_PROPOSED_HYPOTHESIS' },
    });
    expect(decision?.fallbackReason).toBeUndefined();
    expect(decision?.proposal).toMatchObject({
      missingPrecondition: 'FINAL_APPLY_REQUIRED',
      hypothesisType: 'WORKFLOW_PRECONDITION',
    });
    // Les replis éventuels ont tous une raison et citent leur décision.
    const fallbackIds = Object.values(lifecycle.fallbacks.decisionIds).flat();
    expect(fallbackIds).toHaveLength(lifecycle.fallbacks.total);

    // La proposition devient une HYPOTHÈSE (origine IA), jamais une vérité.
    const hypothesis = result.cognitive?.hypothesisDetails.find(
      (detail) => detail.aiDecisionId === decision?.decisionId,
    );
    expect(hypothesis).toMatchObject({
      origin: 'AI_PROPOSAL',
      type: 'WORKFLOW_PRECONDITION',
      runtimeConfirmed: false,
    });
    expect(['HYPOTHESIS', 'CONTRADICTED']).toContain(hypothesis?.status);

    // FIRST FUNCTIONAL DIVERGENCE et rapport.
    expect(result.cognitive?.divergences[0]?.divergence.step).toBeLessThanOrEqual(6);
    const html = await readFile(path.join(reportsDir, 'index.html'), 'utf8');
    expect(html).toContain('AI decisions — lifecycle');
    expect(html).toContain('Blocked goal analysis');
    expect(html).toContain('UNKNOWN_BLOCKING_PRECONDITION');
    const log = await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8');
    expect(log).toMatch(
      /\[AI AI-\d{5}\] trigger=UNKNOWN_BLOCKING_PRECONDITION context=BLOCKED_GOAL mission=CREATE_REQUEST/,
    );
    expect(log).toContain('BLOCKED_GOAL_ANALYZED');
  }, 120_000);
});
