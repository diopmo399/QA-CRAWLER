import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { fetchGitSources } from '../../src/static-analysis/sources/git-source.js';

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
