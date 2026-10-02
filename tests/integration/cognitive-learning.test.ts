import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startWorkflowApp, type WorkflowApp } from '../fixtures/workflow-app.js';

const OPEN = `      - click: { role: button, name: Tasks }
      - click: { role: button, name: Enterprise interview }
      - check: { label: EUR }
      - click: { role: button, name: Company information }
      - fill: { label: Company name, value: Alpha }`;
const SUBMIT = `${OPEN}
      - fill: { label: Business number, value: "1234567890" }
      - click: { role: button, name: Submit }
        allow: MUTATION
        effects: { request: "POST /api/company" }`;

/**
 * Lots F–I de bout en bout : un invariant découvert au fil des runs puis violé par une
 * « nouvelle version », des échecs classés avant d'être rapportés, une couverture
 * fonctionnelle qui montre ce qui n'a pas été testé même quand l'interface l'a été.
 */
describe('Cognitive learning (invariants, failures, functional coverage)', () => {
  let app: WorkflowApp;
  let dir: string;

  beforeAll(async () => {
    app = await startWorkflowApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-cognitive-learn-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const run = async (
    name: string,
    query: string,
    steps: string,
    shared = name,
  ): Promise<{ reportsDir: string; result: ExplorationResult; read: <T>(file: string) => Promise<T> }> => {
    const reportsDir = path.join(dir, shared, `reports-${name}`);
    await mkdir(reportsDir, { recursive: true });
    const { config } = parseConfig(
      `mission: { name: learn }
target: { baseUrl: ${app.url}, startAt: "/${query}" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
safety:
  mutations: { enabled: true, maxPerRun: 5 }
report: { failOnSeverity: NONE }
cognitive:
  invariants: { multiple: 1, supported: 2, confirmed: 3, runsForSupported: 1, runsForConfirmed: 2 }
output: { reportsDir: ${reportsDir} }
flows:
  - name: Create request
    steps:
${steps}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    return {
      reportsDir,
      result,
      read: async <T>(file: string) =>
        JSON.parse(await readFile(path.join(reportsDir, 'cognitive', file), 'utf8')) as T,
    };
  };
  interface InvariantRow {
    statement: string;
    status: string;
    runs: string[];
    counterexamples: { detail: string }[];
  }
  const submitInvariant = (rows: { invariants: InvariantRow[] }) =>
    rows.invariants.find((row) => row.statement.includes('submit disabled UNTIL required fields valid'));

  it('§51–§53 / §98: "submit disabled until required fields valid" grows over runs, then a new version violates it (with provenance)', async () => {
    const first = await run('a', '?v=1&strict=1', OPEN, 'invariant');
    expect(submitInvariant(await first.read('invariants.json'))?.status).not.toBe('CONFIRMED');
    const second = await run('b', '?v=1&strict=1', OPEN, 'invariant');
    const confirmed = submitInvariant(await second.read('invariants.json'));
    expect(confirmed?.status).toBe('CONFIRMED');
    expect(confirmed?.runs.length).toBeGreaterThanOrEqual(2);
    // « Nouvelle version » : l'envoi est actif alors qu'un champ requis est vide.
    const third = await run('c', '?v=1&strict=0', OPEN, 'invariant');
    const violated = submitInvariant(await third.read('invariants.json'));
    expect(violated).toMatchObject({ status: 'VIOLATED' });
    expect(violated?.counterexamples.at(-1)?.detail).toMatch(/submit enabled while missing Business number/);
    expect(
      third.result.issues.some((issue) =>
        /Invariant violated: CREATE_REQUEST: submit disabled UNTIL/.test(issue.message),
      ),
    ).toBe(true);
    const log = await readFile(path.join(third.reportsDir, 'engine-log.jsonl'), 'utf8');
    expect(log).toContain('INVARIANT_VIOLATED');
  }, 240_000);

  it('§55–§57 / §99: a backend 500 on submit is classified TECHNICAL_FAILURE and counted in the submission coverage', async () => {
    const { read, reportsDir } = await run('fail', '?v=1&fail=1', SUBMIT);
    const failures = await read<{ failures: { class: string; step: string; chain: { symptom: string } }[] }>(
      'failures.json',
    );
    expect(failures.failures).toContainEqual(
      expect.objectContaining({
        class: 'TECHNICAL_FAILURE',
        chain: expect.objectContaining({
          symptom: expect.stringMatching(/POST \/api\/company → 500/) as unknown,
        }) as unknown,
      }),
    );
    const coverage = await read<{ items: { id: string; covered: boolean }[] }>('functional-coverage.json');
    expect(coverage.items.find((item) => item.id === 'SUBMISSION:API_UNAVAILABLE')?.covered).toBe(true);
    expect(await readFile(path.join(reportsDir, 'engine-log.jsonl'), 'utf8')).toContain('FAILURE_CLASSIFIED');
  }, 120_000);

  it('§60–§64 / §100: a successful submission is covered, but "invalid Business number" stays a visible gap', async () => {
    const { read } = await run('success', '?v=1', SUBMIT);
    const coverage = await read<{ lines: string[]; gaps: { item: { id: string } }[] }>(
      'functional-coverage.json',
    );
    expect(coverage.lines.find((line) => line.startsWith('Submission'))).toMatch(/✓ success/);
    expect(coverage.lines.find((line) => line.startsWith('Company information'))).toMatch(
      /\? invalid Business number/,
    );
    expect(coverage.gaps.map((gap) => gap.item.id)).toContain('FIELD_INVALID:Business number');
  }, 120_000);
});
