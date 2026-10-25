import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UsageError } from '../../src/cli/args.js';
import { runCli } from '../../src/cli/cli.js';
import {
  knowledgeCenterConfig,
  parseKnowledgeCenterArgs,
  runKnowledgeCenterCli,
} from '../../src/cli/knowledge-center-command.js';
import { PROJECT_HELP } from '../../src/cli/project-command.js';

/** `qa-crawler knowledge-center` : les arguments, la configuration (projet ou mission), le serveur. */
describe('qa-crawler knowledge-center: arguments', () => {
  it('defaults, every option, and what it refuses', () => {
    expect(parseKnowledgeCenterArgs([])).toMatchObject({
      host: '127.0.0.1',
      port: 4190,
      readOnly: false,
      quiet: false,
      help: false,
    });
    expect(
      parseKnowledgeCenterArgs([
        '-c',
        'm.yaml',
        '--port',
        '0',
        '--host',
        '0.0.0.0',
        '--read-only',
        '--stale-days',
        '30',
        '--limit',
        '500',
        '--language',
        'fr',
        '--token',
        't',
        '--quiet',
        '--reports-dir',
        'out',
      ]),
    ).toMatchObject({
      configPath: 'm.yaml',
      port: 0,
      host: '0.0.0.0',
      readOnly: true,
      staleDays: 30,
      limit: 500,
      language: 'fr',
      token: 't',
      quiet: true,
      reportsDir: 'out',
    });
    expect(() => parseKnowledgeCenterArgs(['--port', 'abc'])).toThrow(UsageError);
    expect(() => parseKnowledgeCenterArgs(['--stale-days', '0'])).toThrow(UsageError);
    expect(() => parseKnowledgeCenterArgs(['--language', 'de'])).toThrow(UsageError);
    expect(() => parseKnowledgeCenterArgs(['--unknown'])).toThrow(UsageError);
    expect(() => parseKnowledgeCenterArgs(['extra'])).toThrow(UsageError);
  });

  it('the command is reachable from the CLI, with its help, and listed in the project help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runCli(['knowledge-center', '--help'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('qa-crawler knowledge-center');
      expect(await runCli(['knowledge-center', '--port', 'x'])).toBe(2);
      expect(PROJECT_HELP).toContain('knowledge-center');
      expect(await runCli(['--help'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('knowledge-center  Serve the Knowledge Center');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('qa-crawler knowledge-center: configuration and server', () => {
  it('without a project nor a mission: a clear configuration error (exit code 2)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kc-cli-empty-'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runKnowledgeCenterCli(['--cwd', dir])).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('No qa-crawler.config.yaml found');
    } finally {
      error.mockRestore();
    }
  });

  it('a project configuration gives the same effective mission as the runs (paths, persistence)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kc-cli-project-'));
    await mkdir(path.join(root, 'qa-crawler', 'flows'), { recursive: true });
    await writeFile(
      path.join(root, 'qa-crawler.config.yaml'),
      `qaCrawler:\n  application: { name: shop, baseUrl: http://localhost:4200 }\n  persistence: { enabled: true, provider: file }\n`,
    );
    const { config, source } = await knowledgeCenterConfig({ cwd: path.join(root, 'qa-crawler') }, {});
    expect(source).toBe(path.join(root, 'qa-crawler.config.yaml'));
    expect(config.persistence).toMatchObject({
      enabled: true,
      provider: 'file',
      file: { directory: path.join(root, 'qa-crawler', 'memory') },
    });
    expect(config.knowledge.file).toBe(path.join(root, 'qa-crawler', 'knowledge', 'knowledge-base.json'));
  });

  it('starts the server on a mission file, prints the URL, stops when asked', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kc-cli-mission-'));
    const mission = path.join(dir, 'mission.yaml');
    await writeFile(
      mission,
      `mission: { name: cli }\ntarget: { baseUrl: http://localhost:4200 }\npersistence: { enabled: true, provider: memory }\n`,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let url = '';
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    try {
      const exit = runKnowledgeCenterCli(['-c', mission, '--port', '0', '--read-only'], {
        env: {},
        waitForStop: () => stopped,
        onStarted: (running) => {
          url = running.url;
        },
      });
      await vi.waitFor(() => {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      });
      const meta = (await (await fetch(`${url}/api/meta`)).json()) as {
        options: { readOnly: boolean };
        mission: string;
      };
      expect(meta).toMatchObject({ mission: 'cli', options: { readOnly: true } });
      const refused = await fetch(`${url}/api/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-qa-knowledge-center': '1' },
        body: '{}',
      });
      expect(refused.status).toBe(403);
      stop();
      expect(await exit).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('read-only');
      await expect(fetch(`${url}/api/meta`)).rejects.toThrow();
    } finally {
      stop();
      log.mockRestore();
    }
  });
});
