import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IntelligenceContextBuilder,
  toolContextOf,
  type ContextSources,
} from '../../src/ai/context-builder.js';
import { validateIntelligenceProposal } from '../../src/ai/proposal-validator.js';
import { CopilotIntelligenceProvider } from '../../src/ai/providers/copilot-provider.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';

/**
 * CONTRAT avec le VRAI GitHub Copilot (§102) — désactivé par défaut : la CI normale n'appelle
 * jamais Copilot. À lancer à la main, avec un compte Copilot connecté (ou un jeton dans la
 * variable nommée par QA_COPILOT_TOKEN_ENV) :
 *
 *   QA_COPILOT_LIVE=1 npx vitest run --project integration tests/integration/copilot-live.test.ts
 */
const live = process.env.QA_COPILOT_LIVE === '1';

describe.skipIf(!live)('GitHub Copilot SDK — live contract (opt-in)', () => {
  it('answers a structured request with a proposal that passes QA-Crawler validation', async () => {
    const sources: ContextSources = {
      mission: 'CREATE_REQUEST',
      goal: {
        id: 'COMPANY_INFORMATION_AVAILABLE',
        conditions: ['field Company name', 'field Business number'],
      },
      workflow: {
        previous: ['click Tasks', 'check EUR'],
        next: ['fill Company name', 'fill Business number'],
        requiredFields: ['Company name', 'Business number'],
        intent: 'OPEN_COMPANY_INFORMATION',
      },
      candidates: [
        { key: 'tab', kind: 'click', role: 'tab', name: 'Enterprise Details', safety: 'SAFE', allowed: true },
        { key: 'link', kind: 'click', role: 'link', name: 'Company Profile', safety: 'SAFE', allowed: true },
        {
          key: 'remove',
          kind: 'click',
          role: 'button',
          name: 'Remove company information',
          safety: 'DANGEROUS',
          allowed: false,
        },
      ],
      evidence: [
        {
          id: 'E31',
          type: 'STATIC_SOURCE',
          source: 'CompanyForm component',
          confidence: 0.6,
          details: { fields: ['Company name', 'Business number'], tab: 'Enterprise Details' },
        },
      ],
      hypotheses: [],
      contradictions: [],
    };
    const built = new IntelligenceContextBuilder({
      maxActions: 10,
      maxEvidence: 5,
      maxHypotheses: 5,
      maxPlanSteps: 5,
    }).build('AMBIGUOUS_TARGET', sources);
    const sanitizer = new IntelligenceContextSanitizer();
    const tokenEnv = process.env.QA_COPILOT_TOKEN_ENV;
    const provider = new CopilotIntelligenceProvider({
      models: {
        selection: {
          mode: process.env.QA_COPILOT_MODEL ? 'EXPLICIT' : 'ADAPTIVE',
          ...(process.env.QA_COPILOT_MODEL ? { model: process.env.QA_COPILOT_MODEL } : {}),
          defaultProfile: 'BALANCED',
          profiles: {
            FAST: { models: [], autoTier: 'efficiency' },
            BALANCED: { models: [], autoTier: 'balance' },
            INTELLIGENCE: { models: [], autoTier: 'intelligence' },
          },
        },
        reasoning: {
          mode: 'ADAPTIVE',
          default: 'MEDIUM',
          lowComplexity: 'LOW',
          mediumComplexity: 'MEDIUM',
          highComplexity: 'HIGH',
          veryHighComplexity: 'HIGH',
        },
        fallback: { enabled: true, strategy: 'AUTO' },
        discovery: { cache: true, ttlMs: 600_000, refreshOnUnavailableModel: true },
      },
      sessionReuse: true,
      tools: true,
      timeoutMs: 90_000,
      startTimeoutMs: 60_000,
      baseDirectory: await mkdtemp(path.join(tmpdir(), 'qa-copilot-live-')),
      ...(tokenEnv ? { tokenEnv } : {}),
      env: process.env,
      sanitize: (value) => sanitizer.sanitizeValue(value),
    });
    try {
      expect(await provider.isAvailable(), provider.unavailableReason()).toBe(true);
      const result = await provider.analyze(sanitizer.sanitize(built.request).request, {
        signal: new AbortController().signal,
        maxToolCalls: 3,
        tools: toolContextOf(built, sources),
      });
      const validation = validateIntelligenceProposal(result.raw, built.request, (id) => id === 'E31');
      expect(validation.valid, JSON.stringify(validation)).toBe(true);
      if (validation.valid && validation.proposal.selectedActionId)
        expect(built.candidateOf(validation.proposal.selectedActionId)?.safety).toBe('SAFE');
    } finally {
      await provider.close();
    }
  }, 180_000);
});
