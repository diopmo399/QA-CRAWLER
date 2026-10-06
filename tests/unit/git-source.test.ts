import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runSourcesCli } from '../../src/cli/sources-command.js';
import { loadConfigFile, parseConfig } from '../../src/config/config-loader.js';
import { readPreparedKnowledge } from '../../src/static-analysis/sources/prepared-source.js';
import { fetchGitSources } from '../../src/static-analysis/sources/git-source.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { staticAnalyzerOptions } from '../helpers.js';

/**
 * GIT SOURCE : le code lu depuis de vrais dépôts Git (locaux, file://) — clone léger, mise à jour,
 * branche, sous-dossier, plusieurs dépôts ; jamais de jeton dans une URL, un journal ou un résultat.
 */
const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString();

let base: string;
const repository = async (name: string, files: Record<string, string>): Promise<string> => {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'init');
  return dir;
};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'qa-git-source-'));
});

describe('fetchGitSources (real git, file:// repositories)', () => {
  it('clones once (CLONED), then updates to the new remote revision (UPDATED) — the analysed root follows', async () => {
    const remote = await repository('shell', { 'src/main.ts': 'export const version = 1;' });
    const directory = path.join(base, 'cache-1');
    const first = await fetchGitSources({
      repositories: [{ url: `file://${remote}` }],
      directory,
      env: {},
      timeoutMs: 30_000,
    });
    expect(first.repositories[0]).toMatchObject({ status: 'CLONED' });
    expect(await readFile(path.join(first.root ?? '', 'src/main.ts'), 'utf8')).toContain('version = 1');
    await writeFile(path.join(remote, 'src/main.ts'), 'export const version = 2;');
    run(remote, 'commit', '-q', '-am', 'v2');
    const second = await fetchGitSources({
      repositories: [{ url: `file://${remote}` }],
      directory,
      env: {},
      timeoutMs: 30_000,
    });
    expect(second.repositories[0]).toMatchObject({ status: 'UPDATED' });
    expect(second.root).toBe(first.root);
    expect(await readFile(path.join(second.root ?? '', 'src/main.ts'), 'utf8')).toContain('version = 2');
  });

  it('a branch (ref) and a sub-folder (path, monorepo)', async () => {
    const remote = await repository('mono', { 'apps/tasks/src/a.ts': 'export const branch = "main";' });
    run(remote, 'checkout', '-q', '-b', 'release');
    await writeFile(path.join(remote, 'apps/tasks/src/a.ts'), 'export const branch = "release";');
    run(remote, 'commit', '-q', '-am', 'release');
    run(remote, 'checkout', '-q', 'main');
    const result = await fetchGitSources({
      repositories: [{ url: `file://${remote}`, ref: 'release', path: 'apps/tasks' }],
      directory: path.join(base, 'cache-2'),
      env: {},
      timeoutMs: 30_000,
    });
    expect(result.root?.endsWith(path.join('apps', 'tasks'))).toBe(true);
    expect(await readFile(path.join(result.root ?? '', 'src/a.ts'), 'utf8')).toContain('release');
  });

  it('MICRO-FRONTENDS: several repositories are analysed together (one root holding each clone)', async () => {
    const shell = await repository('mf-shell', { 'src/root.ts': 'export const shell = 1;' });
    const app = await repository('mf-app', { 'src/app.ts': 'export const app = 1;' });
    const result = await fetchGitSources({
      repositories: [
        { url: `file://${shell}`, name: 'shell' },
        { url: `file://${app}`, name: 'task-list' },
      ],
      directory: path.join(base, 'cache-3'),
      env: {},
      timeoutMs: 30_000,
    });
    expect((await readdir(result.root ?? '')).sort()).toEqual(['shell', 'task-list']);
  });

  it('failures never stop the run and never expose a secret: missing token variable, token over a non-https url, unreachable host, bad url', async () => {
    const token = 'secret-token-value-123';
    const result = await fetchGitSources({
      repositories: [
        { url: 'https://git.example.invalid/group/app.git', tokenEnv: 'MISSING_TOKEN' },
        { url: `file://${base}/shell`, tokenEnv: 'GIT_TOKEN' },
        { url: 'https://127.0.0.1:1/group/app.git', tokenEnv: 'GIT_TOKEN', name: 'unreachable' },
        { url: 'ftp://example.test/app.git' },
      ],
      directory: path.join(base, 'cache-4'),
      env: { GIT_TOKEN: token },
      timeoutMs: 30_000,
    });
    expect(result.root).toBeUndefined();
    expect(result.repositories.map((repo) => repo.status)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED']);
    expect(result.repositories[0]?.reason).toBe('environment variable MISSING_TOKEN is not set');
    expect(result.repositories[1]?.reason).toBe('a token is only sent over https://');
    expect(result.repositories[3]?.reason).toMatch(/unsupported url/);
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
  });

  it('configuration: one repository or a list; credentials inside the url are refused (use tokenEnv)', () => {
    const parse = (git: string) =>
      parseConfig(
        `mission: { name: g }\ntarget: { baseUrl: "http://app.test" }\nstaticAnalysis: { enabled: true, source: { git: ${git} } }\n`,
        {},
        {},
      );
    expect(
      parse('{ url: "https://git.example.test/app.git", ref: main }').config.staticAnalysis.source.git,
    ).toHaveLength(1);
    expect(
      parse('[{ url: "git@git.example.test:group/app.git" }, { url: "ssh://git@git.example.test/x.git" }]')
        .config.staticAnalysis.source.git,
    ).toHaveLength(2);
    expect(() => parse('{ url: "https://user:pass@git.example.test/app.git" }')).toThrow(
      /no credentials in the git url/,
    );
  });
});

it('RULES: the application rules are read from the cloned code (same rules as a local source.root)', async () => {
  const fixture = path.resolve('tests/fixtures/static-apps/accounts');
  const dir = path.join(base, 'accounts-repo');
  await cp(fixture, path.join(dir, 'web'), { recursive: true });
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'init');
  const fetched = await fetchGitSources({
    repositories: [{ url: `file://${dir}`, ref: 'main', path: 'web' }],
    directory: path.join(base, 'rules-sources'),
    env: {},
    timeoutMs: 60_000,
  });
  expect(fetched.root).toBeDefined();
  const analyzer = new StaticApplicationAnalyzer(staticAnalyzerOptions());
  const cloned = (await analyzer.analyzeSource(fetched.root ?? '')).graph.rules ?? [];
  const local = (await analyzer.analyzeSource(fixture)).graph.rules ?? [];
  const names = cloned.map((rule) => rule.name);
  expect(names).toContain('ACCOUNT_TYPE_BUSINESS_REQUIRES_COMPANY_NUMBER');
  expect(names).toContain('COUNTRY_CA_REQUIRES_PROVINCE');
  expect(names.sort()).toEqual(local.map((rule) => rule.name).sort());
});

describe('qa-crawler sources (the git source prepared once, outside the runs)', () => {
  const missionFile = async (name: string, git: string): Promise<string> => {
    const dir = path.join(base, `mission-${name}`);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'mission.yaml');
    await writeFile(
      file,
      `mission: { name: ${name} }
target: { baseUrl: http://127.0.0.1:9 }
staticAnalysis:
  enabled: true
  source:
    git: ${git}
    gitDirectory: ./clones
output: { reportsDir: ./reports }
`,
    );
    return file;
  };

  it('fetches, analyses, writes the prepared knowledge (exit 0); the run reads it; another analyzer version is never reused', async () => {
    const fixture = path.resolve('tests/fixtures/static-apps/angular');
    const dir = path.join(base, 'cli-repo');
    await cp(fixture, dir, { recursive: true });
    run(dir, 'init', '-q', '-b', 'main');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', 'init');
    const file = await missionFile('cli', JSON.stringify({ url: `file://${dir}`, ref: 'main' }));
    expect(await runSourcesCli([file, '--quiet'], {})).toBe(0);
    const { config } = await loadConfigFile(file, {}, {});
    const read = await readPreparedKnowledge(config);
    expect(read.status).toBe('READY');
    if (read.status !== 'READY') return;
    expect(read.file.startsWith(path.join(path.dirname(file), 'clones'))).toBe(true);
    expect(read.knowledge.graph.fields.length).toBeGreaterThan(0);
    expect(read.knowledge.repositories[0]).toMatchObject({ status: 'CLONED', ref: 'main' });
    // Une seconde préparation met le clone à jour.
    expect(await runSourcesCli(['-c', file, '-q'], {})).toBe(0);
    const again = await readPreparedKnowledge(config);
    expect(again.status === 'READY' && again.knowledge.repositories[0]?.status).toBe('UPDATED');

    await writeFile(read.file, JSON.stringify({ ...read.knowledge, analyzerVersion: '0.0.1' }));
    const stale = await readPreparedKnowledge(config);
    expect(stale).toMatchObject({ status: 'STALE' });
    expect(stale.status !== 'READY' && stale.reason).toContain('qa-crawler sources');
  });

  it('a repository that cannot be read: exit 1, nothing written; no repository configured: exit 2', async () => {
    const file = await missionFile('missing', JSON.stringify({ url: `file://${path.join(base, 'nope')}` }));
    expect(await runSourcesCli([file, '-q'], {})).toBe(1);
    const { config } = await loadConfigFile(file, {}, {});
    expect((await readPreparedKnowledge(config)).status).toBe('MISSING');
    const none = await missionFile('none', '[]');
    expect(await runSourcesCli([none, '-q'], {})).toBe(2);
    expect(await runSourcesCli([], {})).toBe(2);
  });
});
