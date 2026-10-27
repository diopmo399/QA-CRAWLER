import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startQualityApp, type QualityApp } from '../fixtures/quality-app.js';

/**
 * CTRL+C DANS LA CLI, avec le vrai moteur et un vrai programme lancé à part. Le premier SIGINT pendant le flow
 * demande l'arrêt contrôlé : le moteur s'arrête avant l'action suivante, ferme le navigateur, écrit
 * son résultat (`stopReason: cancelled`), et la CLI sort avec le code 130. L'écriture finale du flow
 * n'est pas jouée.
 */
let app: QualityApp;
let dir = '';

beforeAll(async () => {
  app = await startQualityApp();
  dir = await mkdtemp(path.join(tmpdir(), 'qa-cli-cancel-'));
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('CLI — Ctrl+C during a mission', () => {
  it('stops before the next action, writes the report and exits with 130', async () => {
    const mission = path.join(dir, 'mission.yaml');
    await writeFile(
      mission,
      `mission: { name: cli-cancel }
target: { baseUrl: ${app.url}, startAt: / }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 400 }
safety:
  mutations: { enabled: true, maxPerRun: 5 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'reports')}, screenshotsDir: ${path.join(dir, 'shots')} }
knowledge: { file: ${path.join(dir, 'knowledge.json')} }
flows:
  - name: create-request
    startAt: /
    steps:
      - expect: { url: / }
      - click: { role: button, name: New request }
        allow: MUTATION
      - fill: { label: Title, value: Cancelled from the terminal }
      - click: { role: button, name: Save }
        allow: MUTATION
`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'explore', mission], {
      cwd: process.cwd(),
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    let output = '';
    let interrupted = false;
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      // La première étape du flow est jouée : Ctrl+C.
      if (!interrupted && /^\s+✓\s+1\. /m.test(output)) {
        interrupted = true;
        child.kill('SIGINT');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });

    expect(interrupted, output).toBe(true);
    expect(code, output).toBe(130);
    expect(output).toContain('Interruption requested');
    expect(output).toContain('CANCELLED');
    const result = JSON.parse(await readFile(path.join(dir, 'reports', 'result.json'), 'utf8')) as {
      stopReason: string;
      flows: { steps: { status: string }[] }[];
    };
    expect(result.stopReason).toBe('cancelled');
    expect(result.flows[0]?.steps.map((step) => step.status)[0]).toBe('PASSED');
    expect(result.flows[0]?.steps.at(-1)?.status).toBe('SKIPPED');
    expect(app.records()).toHaveLength(0);
  }, 150_000);
});
