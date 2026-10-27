import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openQaCrawler } from '../../src/sdk/server/node.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startQualityApp, type QualityApp } from '../fixtures/quality-app.js';

/**
 * LA CLI DE LA PLATEFORME avec le vrai moteur, lancée comme un vrai programme (`qa-crawler run …`,
 * `env validate`, `doctor`) sur un espace de travail du SDK : le rejeu dans l'environnement choisi,
 * le verdict en JSON et en code de sortie, le JUnit XML pour la CI, Ctrl+C → 130.
 */
let app: QualityApp;
let workspace = '';

const FLOW = `name: create-request
startAt: /
steps:
  - expect: { url: / }
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Title, value: Title from the CLI }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { url: /requests/ }
assertions:
  - id: title-saved
    description: The server returns the title typed
    check: { kind: value, source: response, method: POST, path: /api/requests, field: title, expected: { value: Title from the CLI } }
`;

function qaCrawler(args: string[], onStderr?: (stderr: string, interrupt: () => void) => void) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/main.ts', ...args, '--workspace', workspace],
    {
      cwd: process.cwd(),
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    onStderr?.(stderr, () => child.kill('SIGINT'));
  });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  app = await startQualityApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'cli-platform-'));
  const qa = await openQaCrawler({ workspace });
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
  } finally {
    await qa.close();
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('CLI platform — real engine', () => {
  let run = '';

  it('doctor and env validate --reach report a ready workspace', async () => {
    const doctor = await qaCrawler(['doctor', '--json']);
    const report = JSON.parse(doctor.stdout) as { ok: boolean; checks: { name: string; ok: boolean }[] };
    expect(report.checks.map((check) => [check.name, check.ok])).toEqual([
      ['node', true],
      ['chromium', true],
      ['workspace', true],
      ['service', true],
    ]);
    expect(doctor.code).toBe(0);
    const validated = await qaCrawler(['env', 'validate', 'Demandes', 'Recette', '--reach']);
    expect(validated.code, validated.stdout + validated.stderr).toBe(0);
    expect(validated.stdout).toContain('Recette: READY');
  }, 60_000);

  it('run start replays in the environment, exits 0, and writes JUnit XML', async () => {
    const junit = path.join(workspace, 'ci', 'junit.xml');
    const { code, stdout, stderr } = await qaCrawler([
      'run',
      'start',
      'Demandes',
      '--env',
      'Recette',
      '--junit',
      junit,
      '--json',
    ]);
    expect(code, stderr).toBe(0);
    const detail = JSON.parse(stdout) as {
      run: string;
      verdict: string;
      flowsDetail: { assertions: { id: string; status: string }[] }[];
    };
    expect(detail.verdict).toBe('PASSED');
    expect(detail.flowsDetail[0]?.assertions).toEqual([
      expect.objectContaining({ id: 'title-saved', status: 'PASS' }),
    ]);
    expect(app.records()).toHaveLength(1);
    run = detail.run;
    const xml = await readFile(junit, 'utf8');
    expect(xml).toMatch(/<testsuites[^>]*tests="\d+"[^>]*failures="0"/);
    expect(xml).toContain('create-request');
  }, 150_000);

  it('run results and run list read the run back; a failing assertion exits 1', async () => {
    const results = await qaCrawler(['run', 'results', 'Demandes', run]);
    expect(results.code).toBe(0);
    expect(results.stdout).toContain('■ PASSED');
    app.bugs.wrongTitle = true;
    try {
      const failed = await qaCrawler(['run', 'start', 'Demandes', '--env', 'Recette']);
      expect(failed.code, failed.stderr).toBe(1);
      expect(failed.stdout).toContain('■ FAILED');
    } finally {
      app.bugs.wrongTitle = false;
    }
    const listed = await qaCrawler(['run', 'list', 'Demandes', '--json']);
    expect((JSON.parse(listed.stdout) as { verdict: string }[]).map((entry) => entry.verdict)).toEqual([
      'FAILED',
      'PASSED',
    ]);
  }, 150_000);

  it('Ctrl+C during run start cancels and exits 130, without the final write', async () => {
    const before = app.records().length;
    let interrupted = false;
    const { code, stdout, stderr } = await qaCrawler(
      ['run', 'start', 'Demandes', '--env', 'Recette'],
      (output, interrupt) => {
        if (!interrupted && /PASSED\s+1\. /.test(output)) {
          interrupted = true;
          interrupt();
        }
      },
    );
    expect(interrupted, stderr).toBe(true);
    expect(code, stderr).toBe(130);
    expect(stdout).toContain('■ CANCELLED');
    expect(app.records()).toHaveLength(before);
  }, 150_000);
});
