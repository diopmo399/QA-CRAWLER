import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntelligenceContextBuilder } from '../../src/ai/context-builder.js';
import { AnthropicIntelligenceProvider } from '../../src/ai/providers/anthropic-provider.js';

/**
 * Le fournisseur Anthropic avec le VRAI SDK (`@anthropic-ai/sdk`) contre un faux point d'accès
 * Messages local : le câblage réel (chemin, en-têtes, corps, réponse) sans clé ni appel externe.
 */
describe('Anthropic provider with the real @anthropic-ai/sdk (local Messages endpoint)', () => {
  let server: Server;
  let url: string;
  const seen: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ path: request.url ?? '', headers: request.headers, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'msg_local_1',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'PROPOSAL',
                  selectedActionId: 'A1',
                  supportingEvidenceIds: [],
                  uncertainties: [],
                  confidence: 0.8,
                }),
              },
            ],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 900, output_tokens: 40 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('posts a beta Messages request with the fallback beta, the key header and the structured output format', async () => {
    const request = new IntelligenceContextBuilder({
      maxActions: 5,
      maxEvidence: 5,
      maxHypotheses: 5,
      maxPlanSteps: 5,
    }).build('LOW_DECISION_CONFIDENCE', {
      candidates: [
        { key: 'link:Reports', kind: 'click', role: 'link', name: 'Reports', safety: 'SAFE', allowed: true },
      ],
      evidence: [],
      hypotheses: [],
      contradictions: [],
    }).request;
    const advisor = new AnthropicIntelligenceProvider({
      model: 'model-primary',
      effort: 'medium',
      maxTokens: 16_000,
      timeoutMs: 10_000,
      serverSideFallback: true,
      apiKeyEnv: 'QA_TEST_ANTHROPIC_KEY',
      baseUrl: url,
      env: { QA_TEST_ANTHROPIC_KEY: 'sk-local-test' },
    });
    expect(await advisor.isAvailable()).toBe(true);
    const result = await advisor.analyze(request, { signal: new AbortController().signal, maxToolCalls: 0 });

    expect(result).toMatchObject({
      raw: { status: 'PROPOSAL', selectedActionId: 'A1' },
      model: 'model-primary',
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    const [sent] = seen;
    expect(sent?.path).toMatch(/^\/v1\/messages/);
    expect(sent?.headers['x-api-key']).toBe('sk-local-test');
    expect(String(sent?.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(sent?.body).toMatchObject({
      model: 'model-primary',
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    // Les bêtas voyagent en en-tête, jamais dans le corps.
    expect(sent?.body).not.toHaveProperty('betas');
  });
});
