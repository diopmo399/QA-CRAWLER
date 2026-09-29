import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startDecisionApp, type DecisionApp } from '../fixtures/decision-app.js';

/**
 * NON-RÉGRESSION : memory.enabled: false et intelligence.enabled: false gardent exactement
 * les décisions d'avant (mêmes actions, mêmes scores, mêmes raisons). L'intelligence
 * activée sans historique ne change pas non plus les décisions : elle n'agit que sur
 * l'interprétation de l'historique.
 */
describe('non-regression: memory and intelligence disabled keep the current decisions', () => {
  let app: DecisionApp;
  let root: string;
  const results: Record<string, ExplorationResult> = {};

  const run = async (name: string, extra: string): Promise<ExplorationResult> => {
    const { config } = parseConfig(
      `
mission: { name: users, mode: explore }
target: { baseUrl: ${app.url} }
goals: [users, create-user]
exploration: { maxStates: 15, maxActions: 30, actionTimeoutMs: 2000, settleTimeMs: 100 }
knowledge: { file: ${path.join(root, name, 'knowledge.json')} }
report: { language: en, failOnSeverity: NONE }
output:
  reportsDir: ${path.join(root, name, 'reports')}
  screenshotsDir: ${path.join(root, name, 'screenshots')}
${extra}`,
      {},
      {},
    );
    return (await runMission(config)).result;
  };

  beforeAll(async () => {
    app = await startDecisionApp();
    root = await mkdtemp(path.join(tmpdir(), 'qa-non-regression-'));
    results.defaults = await run('defaults', '');
    results.disabled = await run('disabled', 'memory: { enabled: false }\nintelligence: { enabled: false }');
    results.enabled = await run('enabled', 'memory: { enabled: false }\nintelligence: { enabled: true }');
  }, 240_000);
  afterAll(async () => {
    await app.close();
  });

  const decisions = (result: ExplorationResult | undefined): unknown[] =>
    (result?.intelligence?.decisions ?? []).map((decision) => ({
      label: decision.label,
      score: decision.score,
      factors: decision.breakdown?.details.map((detail) => [detail.factor, detail.points, detail.code]),
      reasons: decision.breakdown?.reasons,
    }));

  it('the same decisions with the defaults, with memory and intelligence off, and with intelligence on', () => {
    const reference = decisions(results.defaults);
    expect(reference.length).toBeGreaterThan(3);
    expect(decisions(results.disabled)).toEqual(reference);
    expect(decisions(results.enabled)).toEqual(reference);
    expect(results.disabled?.issues.map((issue) => `${issue.type} ${issue.severity}`).sort()).toEqual(
      results.defaults?.issues.map((issue) => `${issue.type} ${issue.severity}`).sort(),
    );
  });

  it('snapshot of the decisions (intelligence off)', () => {
    expect(
      (results.disabled?.intelligence?.decisions ?? []).map(
        (decision) => `${decision.label} ${decision.score}`,
      ),
    ).toMatchSnapshot();
  });

  it('intelligence off: no historical knowledge section; on: the knowledge evaluated, explained', async () => {
    expect(results.disabled?.intelligence?.historicalKnowledge).toBeUndefined();
    const historical = results.enabled?.intelligence?.historicalKnowledge;
    expect(historical?.transitions).toBeGreaterThan(0);
    expect(historical?.context).toMatchObject({ browser: 'chromium', viewportClass: 'desktop' });
    expect(historical?.entries[0]?.confidence.reasons.map((reason) => reason.factor)).toEqual([
      'sample',
      'stability',
      'recency',
      'context',
    ]);
    const html = await readFile(path.join(root, 'enabled', 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Historical knowledge (confidence)');
    const plain = await readFile(path.join(root, 'disabled', 'reports', 'index.html'), 'utf8');
    expect(plain).not.toContain('Historical knowledge (confidence)');
  });
});
