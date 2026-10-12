import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveStaticApp, type StaticApp } from '../fixtures/packaging/static-server.js';

/**
 * PACKAGING : le dépôt est construit, les deux paquets sont empaquetés avec `npm pack`, installés
 * depuis leurs tarballs dans une copie de chaque fixture (sans les dépendances optionnelles), puis
 * `npx qa-crawler` est exécuté comme le ferait un projet consommateur. Aucun chemin du dépôt
 * n'est visible du projet installé : seul le tarball compte.
 */
const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'packaging');
const ENV = {
  ...process.env,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  NO_COLOR: '1',
  npm_config_loglevel: 'error',
};

interface Consumer {
  root: string;
  app: StaticApp;
  qa(args: string[], options?: { env?: Record<string, string> }): Promise<{ code: number; out: string }>;
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

let tarballs: { core: string; cli: string };
const consumers: Consumer[] = [];

async function build(): Promise<{ core: string; cli: string }> {
  await run('npm', ['run', '-s', 'build'], { cwd: REPO, env: ENV, maxBuffer: 64 * 1024 * 1024 });
  const destination = await mkdtemp(path.join(tmpdir(), 'qa-pack-'));
  await run(
    'npm',
    [
      'pack',
      '--workspace',
      'packages/core',
      '--workspace',
      'packages/cli',
      '--pack-destination',
      destination,
    ],
    { cwd: REPO, env: ENV, maxBuffer: 64 * 1024 * 1024 },
  );
  const files = await readdir(destination);
  const core = files.find((file) => file.startsWith('qa-crawler-core-'));
  const cli = files.find((file) => file.startsWith('qa-crawler-cli-'));
  if (!core || !cli) throw new Error(`npm pack produced ${files.join(', ')}`);
  return { core: path.join(destination, core), cli: path.join(destination, cli) };
}

async function consumer(fixture: string): Promise<Consumer> {
  const root = await mkdtemp(path.join(tmpdir(), `qa-consumer-${fixture}-`));
  await cp(path.join(FIXTURES, fixture), root, { recursive: true });
  if (!(await exists(path.join(root, 'package.json'))))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: fixture, private: true }),
      'utf8',
    );
  await run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--omit=optional', '-D', tarballs.core, tarballs.cli],
    {
      cwd: root,
      env: ENV,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const app = await serveStaticApp(root);
  const bin = path.join(root, 'node_modules', '.bin', 'qa-crawler');
  const qa: Consumer['qa'] = async (args, options = {}) => {
    try {
      const { stdout, stderr } = await run(bin, args, {
        cwd: root,
        env: { ...ENV, ...options.env },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, out: `${stdout}\n${stderr}` };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 3,
        out: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      };
    }
  };
  const created = { root, app, qa };
  consumers.push(created);
  return created;
}

beforeAll(async () => {
  tarballs = await build();
}, 600_000);

afterAll(async () => {
  for (const { app, root } of consumers) {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
  await rm(path.dirname(tarballs.core), { recursive: true, force: true });
});

describe('the packages', () => {
  it('ship only what a consumer needs (no sources, tests or scenarios) and declare their entry points', async () => {
    const { stdout } = await run('npm', ['run', '-s', 'pack:check'], { cwd: REPO, env: ENV });
    expect(stdout).toMatch(/@qa-crawler\/core@\d+\.\d+\.\d+: \d+ file\(s\)/);
    expect(stdout).toMatch(/@qa-crawler\/cli@\d+\.\d+\.\d+: \d+ file\(s\)/);
    const corePkg = JSON.parse(
      await readFile(path.join(REPO, 'packages', 'core', 'package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      exports: Record<string, unknown>;
      optionalDependencies: Record<string, string>;
      engines: { node: string };
    };
    const cliPkg = JSON.parse(await readFile(path.join(REPO, 'packages', 'cli', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(corePkg.name).toBe('@qa-crawler/core');
    expect(cliPkg.name).toBe('@qa-crawler/cli');
    expect(cliPkg.version).toBe(corePkg.version);
    expect(cliPkg.dependencies['@qa-crawler/core']).toBe(corePkg.version);
    expect(cliPkg.bin['qa-crawler']).toBe('./bin/qa-crawler.js');
    expect(Object.keys(corePkg.exports)).toEqual(expect.arrayContaining(['.', './cli', './package.json']));
    expect(Object.keys(corePkg.optionalDependencies)).toEqual(
      expect.arrayContaining(['pg', 'mssql', '@github/copilot-sdk']),
    );
    expect(corePkg.engines.node).toBe('>=20');
  });
});

describe('an Angular project (TypeScript, playwright.config, YAML + Gherkin flows)', () => {
  let project: Consumer;
  beforeAll(async () => {
    project = await consumer('angular-app');
  }, 300_000);

  it('installs locally without the optional providers, and answers --version / --help', async () => {
    expect(
      await exists(path.join(project.root, 'node_modules', '@qa-crawler', 'core', 'dist', 'index.js')),
    ).toBe(true);
    expect(
      await exists(
        path.join(project.root, 'node_modules', '@qa-crawler', 'core', 'domain-packs', 'generic.yaml'),
      ),
    ).toBe(true);
    expect(await exists(path.join(project.root, 'node_modules', 'pg'))).toBe(false);
    expect(await exists(path.join(project.root, 'node_modules', '@github', 'copilot-sdk'))).toBe(false);
    const version = await project.qa(['--version']);
    expect(version.code).toBe(0);
    expect(version.out).toMatch(/^qa-crawler \d+\.\d+\.\d+ \(core \d+\.\d+\.\d+, node v\d+/);
    const help = await project.qa(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('qa-crawler init');
    // npm exec works as well as the bin link.
    const { stdout } = await run('npm', ['exec', '--no', '--', 'qa-crawler', '--version'], {
      cwd: project.root,
      env: ENV,
    });
    expect(stdout).toMatch(/^qa-crawler \d+\.\d+\.\d+/);
  });

  it('init detects the project and writes the configuration without touching the existing flows', async () => {
    const init = await project.qa(['init']);
    expect(init.code).toBe(0);
    expect(init.out).toContain('angular');
    expect(init.out).toMatch(/playwright\.config\.ts/);
    const config = await readFile(path.join(project.root, 'qa-crawler.config.yaml'), 'utf8');
    expect(config).toContain('framework: angular');
    expect(config).toContain('config: ./playwright.config.ts');
    expect(config).toContain('baseUrl: http://localhost:4200');
    expect(await exists(path.join(project.root, 'qa-crawler', 'flows', 'catalog.flow.yaml'))).toBe(true);
    expect(await exists(path.join(project.root, 'qa-crawler', 'flows', 'about.feature'))).toBe(true);
    expect(await exists(path.join(project.root, 'qa-reports'))).toBe(true);
    const again = await project.qa(['init']);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already exists: kept/);
  }, 60_000);

  it('replay runs the YAML and Gherkin flows from the project folder and writes the reports in the project', async () => {
    const replay = await project.qa(['replay', '--base-url', project.app.url, '--quiet'], {
      env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
    });
    expect(replay.out).toContain('open-catalog');
    expect(replay.code, replay.out).toBe(0);
    const result = JSON.parse(
      await readFile(path.join(project.root, 'qa-reports', 'result.json'), 'utf8'),
    ) as {
      flows: { name: string; status: string }[];
      tool: { coreVersion: string; cliVersion: string; projectVersion?: string; node: string };
      target: { baseUrl: string };
    };
    const statuses = result.flows.map((flow) => [flow.name, flow.status]);
    expect(statuses).toHaveLength(3); // the two project flows + the example written by init
    expect(statuses).toContainEqual(['open-catalog', 'PASSED']);
    expect(statuses).toContainEqual(['home-loads', 'PASSED']);
    expect(statuses.find(([name]) => /about page/i.test(name ?? ''))?.[1]).toBe('PASSED');
    expect(result.tool.coreVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.tool.cliVersion).toBe(result.tool.coreVersion);
    expect(result.tool.projectVersion).toBe('2.4.0');
    expect(result.target.baseUrl.replace(/\/$/, '')).toBe(project.app.url);
    expect(await exists(path.join(project.root, 'qa-reports', 'index.html'))).toBe(true);
    expect(await exists(path.join(project.root, 'qa-crawler', 'knowledge', 'knowledge-base.json'))).toBe(
      true,
    );
    expect(await exists(path.join(project.root, 'qa-crawler', 'memory', 'crawl-runs.json'))).toBe(true);
    const derived = await readFile(
      path.join(project.root, 'qa-crawler', '.derived', 'replay.mission.yaml'),
      'utf8',
    );
    expect(derived).toContain('viewport:'); // reused from playwright.config.ts
    expect(project.app.requests).toContain('GET /catalog.html');
  }, 240_000);
});

describe('a React project (Vite)', () => {
  let project: Consumer;
  beforeAll(async () => {
    project = await consumer('react-app');
  }, 300_000);

  it('analyze passes and generate-tests writes Playwright specs', async () => {
    expect((await project.qa(['init', '--no-example'])).code).toBe(0);
    expect(await readFile(path.join(project.root, 'qa-crawler.config.yaml'), 'utf8')).toContain(
      'framework: react',
    );
    const analyze = await project.qa(['analyze', '--base-url', project.app.url, '--quiet'], {
      env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
    });
    expect(analyze.code, analyze.out).toBe(0);
    expect(analyze.out).toMatch(/Overall status: PASS/);
    const run = JSON.parse(await readFile(path.join(project.root, 'qa-reports', 'run.json'), 'utf8')) as {
      overallStatus: string;
      execution: { flows: unknown[] };
    };
    expect(run.overallStatus).toBe('PASS');
    expect(run.execution.flows).toHaveLength(2);
    for (const artifact of [
      'run-analysis.json',
      'anomalies.json',
      'workflow-graph.json',
      'functional-coverage.json',
      'reproductions.json',
    ])
      expect(await exists(path.join(project.root, 'qa-reports', artifact)), artifact).toBe(true);

    const generated = await project.qa(['generate-tests', '--base-url', project.app.url, '--quiet'], {
      env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
    });
    expect(generated.code, generated.out).toBe(0);
    const specs = await readdir(path.join(project.root, 'qa-crawler', 'generated-tests'));
    expect(specs).toEqual(expect.arrayContaining(['add-note.spec.ts', 'history.spec.ts']));
    expect(
      await readFile(path.join(project.root, 'qa-crawler', 'generated-tests', 'history.spec.ts'), 'utf8'),
    ).toContain("import { test, expect } from '@playwright/test'");
  }, 300_000);
});

describe('a web application without framework or package.json', () => {
  let project: Consumer;
  beforeAll(async () => {
    project = await consumer('generic-web-app');
  }, 300_000);

  it('a failing flow makes analyze exit with 1 (QA failure), a missing configuration with 2', async () => {
    const before = await project.qa(['analyze', '--base-url', project.app.url]);
    expect(before.code).toBe(2);
    expect((await project.qa(['init', '--no-example'])).code).toBe(0);
    const analyze = await project.qa(['analyze', '--base-url', project.app.url, '--quiet'], {
      env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
    });
    expect(analyze.code, analyze.out).toBe(1);
    expect(analyze.out).toMatch(/Overall status: FAIL/);
    const run = JSON.parse(await readFile(path.join(project.root, 'qa-reports', 'run.json'), 'utf8')) as {
      overallStatus: string;
      execution: { flows: { name: string; status: string }[] };
    };
    expect(run.overallStatus).toBe('FAIL');
    expect(run.execution.flows.find((flow) => flow.name === 'help-page')?.status).toBe('PASSED');
    expect(run.execution.flows.find((flow) => flow.name === 'broken-link')?.status).toBe('FAILED');
    // Only the selected flow runs with --flow.
    const only = await project.qa(
      ['replay', '--flow', 'help-page', '--base-url', project.app.url, '--quiet'],
      {
        env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
      },
    );
    expect(only.code, only.out).toBe(0);
    expect((await project.qa(['replay', '--flow', 'nope', '--base-url', project.app.url])).code).toBe(2);
  }, 300_000);
});

describe('a project with an OpenAPI contract', () => {
  let project: Consumer;
  beforeAll(async () => {
    project = await consumer('openapi-app');
  }, 300_000);

  it('init finds the contract and test-api exercises it against the served API', async () => {
    const init = await project.qa(['init', '--no-example']);
    expect(init.code).toBe(0);
    expect(init.out).toMatch(/OpenAPI contract found: openapi\.yaml/);
    expect(await readFile(path.join(project.root, 'qa-crawler.config.yaml'), 'utf8')).toContain(
      'openapi: ./openapi.yaml',
    );
    const api = await project.qa(['test-api', '--base-url', project.app.url, '--quiet'], {
      env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
    });
    expect(api.code, api.out).toBe(0);
    const analysis = await readFile(path.join(project.root, 'qa-reports', 'api-analysis.json'), 'utf8');
    expect(analysis).toContain('GET /items');
    expect(project.app.requests.some((request) => request.startsWith('GET /api/items'))).toBe(true);
  }, 300_000);
});
