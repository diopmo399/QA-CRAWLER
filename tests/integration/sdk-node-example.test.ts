import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { openQaCrawler } from '../../src/sdk/server/node.js';
import { startQualityApp, type QualityApp } from '../fixtures/quality-app.js';

/**
 * LE SDK DANS UN PROGRAMME NODE, avec le vrai moteur. La façade `openQaCrawler` prépare le projet
 * (comme un outil interne le ferait), puis l'exemple `examples/sdk-node/replay.mjs` est lancé comme
 * un vrai programme : il rejoue le scénario dans l'environnement choisi et sort avec le code de son
 * verdict (0 réussi, 1 échoué, 130 annulé par Ctrl+C, 2 usage).
 */
let app: QualityApp;
let workspace = '';

const FLOW = `name: create-request
startAt: /
steps:
  - expect: { url: / }
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Title, value: Example title }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { url: /requests/ }
assertions:
  - id: title-saved
    description: The server returns the title typed
    check: { kind: value, source: response, method: POST, path: /api/requests, field: title, expected: { value: Example title } }
`;

function example(args: string[], onOutput?: (output: string, kill: () => void) => void) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './tests/fixtures/source-packages.ts',
      'examples/sdk-node/replay.mjs',
      '--workspace',
      workspace,
      ...args,
    ],
    { cwd: process.cwd(), env: { ...process.env, CI: '1' } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    onOutput?.(stdout, () => child.kill('SIGINT'));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  app = await startQualityApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-node-'));
  // La façade dans le programme : la même API que le Dashboard, sans serveur à lancer à part.
  const qa = await openQaCrawler({ workspace, language: 'fr' });
  try {
    const project = await qa.client.projects.create({
      ...engineDefaults(),
      project: { name: 'Demandes', targetUrl: `${app.url}/`, framework: 'other' },
    });
    const flows = path.join(workspace, project.id, 'qa-crawler', 'flows');
    await mkdir(flows, { recursive: true });
    await writeFile(path.join(flows, 'create-request.flow.yaml'), FLOW);
    await qa.client.environments.create(project.id, {
      name: 'Recette',
      kind: 'TEST',
      baseUrl: app.url,
      allowedDomains: [new URL(app.url).hostname],
      mutations: { enabled: true, maxPerRun: 5 },
    });
    expect(qa.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await qa.close();
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK in a Node program — examples/sdk-node', () => {
  it('replays in the chosen environment and exits 0 with the verdict as JSON', async () => {
    const { code, stdout, stderr } = await example(['--project', 'Demandes', '--env', 'Recette', '--json']);
    expect(code, stderr).toBe(0);
    const summary = JSON.parse(stdout.trim()) as {
      verdict: string;
      environment: { name: string };
      assertions: { id: string; status: string }[];
    };
    expect(summary.verdict).toBe('PASSED');
    expect(summary.environment.name).toBe('Recette');
    expect(summary.assertions).toEqual([{ flow: 'create-request', id: 'title-saved', status: 'PASS' }]);
    expect(app.records()).toHaveLength(1);
    // Le jeton du service n'est jamais écrit.
    expect(stdout + stderr).not.toMatch(/token/i);
  }, 150_000);

  it('exits 1 when the business assertion fails', async () => {
    app.bugs.wrongTitle = true;
    try {
      const { code, stdout } = await example(['--project', 'Demandes', '--env', 'Recette', '--json']);
      expect(code).toBe(1);
      expect((JSON.parse(stdout.trim()) as { verdict: string }).verdict).toBe('FAILED');
    } finally {
      app.bugs.wrongTitle = false;
    }
  }, 150_000);

  it('cancels on Ctrl+C and exits 130', async () => {
    const before = app.records().length;
    let interrupted = false;
    const { code, stdout } = await example(['--project', 'Demandes', '--env', 'Recette'], (output, kill) => {
      if (!interrupted && /PASSED\s+1\. /.test(output)) {
        interrupted = true;
        kill();
      }
    });
    expect(interrupted, stdout).toBe(true);
    expect(code, stdout).toBe(130);
    expect(stdout).toContain('■ CANCELLED');
    expect(app.records()).toHaveLength(before);
  }, 150_000);

  it('exits 2 for an unknown project', async () => {
    const { code, stderr } = await example(['--project', 'Inconnu']);
    expect(code).toBe(2);
    expect(stderr).toContain('project not found');
  }, 60_000);
});
