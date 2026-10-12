import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageError } from '../../../src/cli/args.js';
import { EXIT, runCli } from '../../../src/cli/cli.js';
import { PROJECT_COMMANDS, parseProjectArgs, runProjectCli } from '../../../src/cli/project-command.js';
import * as core from '../../../src/index.js';
import { readCoreVersion, setToolIdentity, toolIdentity } from '../../../src/tool-identity.js';

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe('project command line: arguments', () => {
  it('parses the project options and keeps the mission options as passthrough', () => {
    const args = parseProjectArgs('analyze', [
      '--cwd',
      '/tmp/app',
      '--base-url',
      'http://localhost:4300',
      '--headed',
      '--flow',
      'login',
      '--flow',
      'checkout',
      '--reports-dir',
      'out',
      '--intelligence',
      'ASSIST',
      '--max-states',
      '12',
      '--no-persistence',
      '--quiet',
    ]);
    expect(args).toMatchObject({
      command: 'analyze',
      cwd: '/tmp/app',
      baseUrl: 'http://localhost:4300',
      headless: false,
      flows: ['login', 'checkout'],
      reportsDir: 'out',
      passthrough: ['--intelligence', 'ASSIST', '--max-states', '12', '--no-persistence', '--quiet'],
      help: false,
    });
    expect(parseProjectArgs('init', ['--force', '--no-example']).force).toBe(true);
    expect(parseProjectArgs('init', ['--force', '--no-example']).example).toBe(false);
    expect(parseProjectArgs('reproduce', ['ANOM-3']).positional).toBe('ANOM-3');
    expect(parseProjectArgs('replay', ['-h']).help).toBe(true);
    expect(() => parseProjectArgs('replay', ['--unknown-option'])).toThrow(UsageError);
    expect(() => parseProjectArgs('replay', ['--headless', '--headed'])).toThrow(UsageError);
  });

  it('lists the commands of the package', () => {
    expect([...PROJECT_COMMANDS]).toEqual([
      'init',
      'replay',
      'explore',
      'analyze',
      'test-api',
      'reproduce',
      'generate-tests',
    ]);
  });
});

describe('project command line: dispatch', () => {
  const logs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
  });
  const capture = (): void => {
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void logs.push(parts.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => void logs.push(parts.join(' ')));
  };

  it('--version names the cli, the core and node; --help shows both the project and the mission help', async () => {
    capture();
    expect(await runCli(['--version'], { cliVersion: '9.9.9' })).toBe(EXIT.OK);
    expect(logs.join('\n')).toMatch(/^qa-crawler 9\.9\.9 \(core \d+\.\d+\.\d+, node v\d+/);
    logs.length = 0;
    expect(await runCli(['-v'])).toBe(EXIT.OK);
    expect(logs.join('\n')).toMatch(/^qa-crawler (\d+\.\d+\.\d+) \(core \1,/);
    logs.length = 0;
    expect(await runCli([])).toBe(EXIT.OK);
    expect(logs.join('\n')).toContain('qa-crawler init');
    expect(logs.join('\n')).toContain('autonomous, deterministic QA flow explorer');
  });

  it('init creates a project; the other commands refuse to run without a configuration (exit 2)', async () => {
    capture();
    const root = await mkdtemp(path.join(tmpdir(), 'qa-cli-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }), 'utf8');
    expect(await runCli(['init', '--cwd', root, '--base-url', 'http://localhost:7777'])).toBe(EXIT.OK);
    expect(await exists(path.join(root, 'qa-crawler.config.yaml'))).toBe(true);
    expect(await exists(path.join(root, 'qa-crawler', 'flows', 'example.flow.yaml'))).toBe(true);
    expect(await readFile(path.join(root, 'qa-crawler.config.yaml'), 'utf8')).toContain(
      'http://localhost:7777',
    );

    const empty = await mkdtemp(path.join(tmpdir(), 'qa-cli-empty-'));
    expect(await runCli(['analyze', '--cwd', empty])).toBe(EXIT.USAGE);
    expect(logs.join('\n')).toMatch(/run `npx qa-crawler init` first/);
    expect(await runCli(['reproduce', '--cwd', empty])).toBe(EXIT.USAGE);
  });

  it('a project command derives a mission and hands it to the mission CLI with the flags', async () => {
    capture();
    const root = await mkdtemp(path.join(tmpdir(), 'qa-cli-run-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }), 'utf8');
    await writeFile(
      path.join(root, 'playwright.config.ts'),
      "export default { use: { baseURL: 'http://localhost:4300', viewport: { width: 1200, height: 700 } } };",
      'utf8',
    );
    expect(await runCli(['init', '--cwd', root, '--no-example'])).toBe(EXIT.OK);
    await writeFile(
      path.join(root, 'qa-crawler', 'flows', 'home.yaml'),
      'name: home\nsteps:\n  - expect:\n      url: /\n',
      'utf8',
    );
    const calls: string[][] = [];
    const runtime = {
      runMissionCli: (argv: string[]) => {
        calls.push(argv);
        return Promise.resolve(0);
      },
      runRecordCli: () => Promise.resolve(0),
    };
    expect(
      await runProjectCli(
        'replay',
        ['--cwd', root, '--base-url', 'http://localhost:8080', '--quiet'],
        runtime,
      ),
    ).toBe(0);
    expect(calls).toHaveLength(1);
    const [mode, file, ...flags] = calls[0] ?? [];
    expect(mode).toBe('explore');
    expect(file).toBe(path.join(root, 'qa-crawler', '.derived', 'replay.mission.yaml'));
    expect(flags).toEqual(['--base-url', 'http://localhost:8080', '--quiet']);
    const derived = await readFile(file ?? '', 'utf8');
    expect(derived).toContain('baseUrl: http://localhost:4300'); // from the project's playwright.config
    expect(derived).toContain('viewport:');
    expect(derived).toContain('name: home');
    expect(derived.match(/^browser:/gm)).toHaveLength(1);
    expect((await toolIdentity()).projectVersion).toBe('1.2.3');

    // record: without a project it is the historical command, untouched.
    const recorded: string[][] = [];
    const empty = await mkdtemp(path.join(tmpdir(), 'qa-cli-rec-'));
    await runProjectCli('record', ['--cwd', empty, '--url', 'http://localhost:1'], {
      ...runtime,
      runRecordCli: (argv) => {
        recorded.push(argv);
        return Promise.resolve(0);
      },
    });
    expect(recorded[0]).toEqual(['--cwd', empty, '--url', 'http://localhost:1']);

    // reproduce with nothing to reproduce is not a failure; an unknown anomaly is a usage error.
    await mkdir(path.join(root, 'qa-reports'), { recursive: true });
    await writeFile(
      path.join(root, 'qa-reports', 'reproductions.json'),
      JSON.stringify({ artifacts: [] }),
      'utf8',
    );
    expect(await runProjectCli('reproduce', ['--cwd', root], runtime)).toBe(0);
    expect(await runProjectCli('reproduce', ['ANOM-9', '--cwd', root], runtime)).toBe(2);
  });

  it('the historical mission CLI is untouched: a YAML argument or -c selects it', async () => {
    capture();
    expect(await runCli(['explore', 'does-not-exist.yaml'])).not.toBe(EXIT.OK);
    expect(logs.join('\n')).not.toContain('run `npx qa-crawler init` first');
  });
});

describe('tool identity and public API', () => {
  it('reports the versions of the core, the cli and the project', async () => {
    const version = await readCoreVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    setToolIdentity({ cliVersion: '1.0.0-test' });
    const identity = await toolIdentity();
    expect(identity).toMatchObject({ coreVersion: version, cliVersion: '1.0.0-test', node: process.version });
  });

  it('@qa-crawler/core exposes the engines, the analyses and the extension points', () => {
    for (const name of [
      'runMission',
      'loadConfigFile',
      'parseConfig',
      'runRecording',
      'generateFlows',
      'buildRunAnalysis',
      'buildRunWorkflowAnalysis',
      'runApiTests',
      'analyzeVisual',
      'analyzeRegression',
      'planReproductions',
      'generatePlaywrightTests',
      'renderQaJobManifest',
      'PixelVisualComparator',
      'createAuthenticator',
      'detectProject',
      'initProject',
      'loadProjectConfig',
      'projectMission',
      'runCli',
      'EXIT',
    ])
      expect(typeof (core as Record<string, unknown>)[name], name).not.toBe('undefined');
  });
});
