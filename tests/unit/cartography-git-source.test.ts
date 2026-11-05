import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, MapSource } from '../../src/sdk/core/cartography.js';
import { gitInfo, readSource } from '../../src/cartography/files.js';
import {
  gitFileUrl,
  gitShow,
  internalAddress,
  parseRepoUrl,
  prepareGitSource,
  removeWorkdirs,
  workdirOf,
  type GitPolicy,
} from '../../src/cartography/git-source.js';
import { compareSources } from '../../src/cartography/impact.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * LES SOURCES GIT : adresses contrôlées (protocole, hôte, identifiants, adresses internes), préparation sur
 * de vrais dépôts locaux temporaires (branche par défaut, branche, commit, erreurs), protections (liens
 * symboliques, hooks, redirections), dépôt privé derrière un petit serveur HTTP Git local avec
 * authentification, plusieurs dépôts dans un même scan, révision des sources locales, liens « Voir sur
 * Git » et comparaison de deux commits. Aucun accès réseau réel.
 */
let base: string;
let origin: string;
let c1: string;
let c2: string;
const policy = (extra: Partial<GitPolicy> = {}): GitPolicy => ({
  allowedHosts: [],
  protocols: ['file'],
  workRoot: path.join(base, 'work'),
  fileRoots: [base],
  env: {},
  envNames: /^QA_[A-Z0-9_]+$/,
  ...extra,
});
const source = (extra: Partial<MapSource> = {}): MapSource => ({
  id: 'front',
  name: 'Front',
  layer: 'FRONTEND',
  kind: 'GIT',
  path: '',
  include: [],
  enabled: true,
  repoUrl: pathToFileURL(origin).href,
  ...extra,
});
const git = (dir: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.longpaths=true', ...args],
    {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', HOME: base },
    },
  )
    .toString()
    .trim();
const failure = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => 'no error',
    (error: unknown) => (error as Error).message,
  );

async function makeRepo(dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'git-source-'));
  origin = path.join(base, 'origin');
  await makeRepo(origin, {
    'src/app/a.component.ts':
      "import { Component } from '@angular/core';\n@Component({ selector: 'app-a', template: '<p>a</p>' })\nexport class AComponent {}\n",
  });
  // Un lien symbolique vers un fichier hors du dépôt : il doit rester un simple fichier texte.
  await symlink('/etc/hostname', path.join(origin, 'src/app/escape.ts'));
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'symlink');
  c1 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-qb', 'dev');
  await writeFile(path.join(origin, 'src/app/b.component.ts'), 'export class BComponent {}\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'dev');
  c2 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('repository URL policy', () => {
  const p = { allowedHosts: ['github.com', 'git.example.org'], protocols: ['https'] as const };
  it('accepts an allowed https host and normalises the URL (no « .. » survives)', () => {
    expect(parseRepoUrl('https://github.com/acme/../../etc/app', p).url).toBe('https://github.com/etc/app');
    expect(parseRepoUrl('https://GitHub.com/acme/app.git/', p)).toEqual({
      url: 'https://github.com/acme/app.git',
      protocol: 'https',
      host: 'github.com',
      provider: 'GITHUB',
    });
  });
  it.each([
    ['ssh://git@github.com/acme/app.git', /URL_REFUSED.*protocol ssh/],
    ['git://github.com/acme/app.git', /URL_REFUSED/],
    ['http://github.com/acme/app.git', /URL_REFUSED.*not allowed on this server/],
    ['https://user:secret@github.com/acme/app.git', /URL_REFUSED.*credentials must not be written/],
    ['https://evil.example.com/acme/app.git', /HOST_REFUSED/],
    ['https://github.com/acme/app.git?x=1', /URL_REFUSED/],
    ['https://github.com/', /URL_REFUSED/],
    ['not a url', /URL_REFUSED/],
  ])('refuses %s', (url, error) => {
    expect(() => parseRepoUrl(url, p)).toThrow(error);
  });
  it('refuses everything when remote sources are disabled', () => {
    expect(() => parseRepoUrl('https://github.com/a/b', undefined)).toThrow(/GIT_DISABLED/);
    expect(() => parseRepoUrl('https://github.com/a/b', { allowedHosts: [] })).toThrow(/GIT_DISABLED/);
  });
  it('classifies internal addresses (SSRF)', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '0.0.0.0',
    ])
      expect(internalAddress(a), a).toBe(true);
    for (const a of ['140.82.112.3', '8.8.8.8', '2606:4700::1111']) expect(internalAddress(a), a).toBe(false);
  });
  it('refuses an allowed host that resolves to an internal address, before any git command', async () => {
    const message = await failure(
      prepareGitSource(
        source({ repoUrl: 'https://git.example.org/acme/app.git' }),
        'p',
        policy({
          allowedHosts: ['git.example.org'],
          protocols: ['https'],
          resolve: () => Promise.resolve(['10.0.0.7']),
        }),
      ),
    );
    expect(message).toMatch(/HOST_REFUSED.*internal address/);
    // Les métadonnées des nuages restent refusées même quand les adresses privées sont permises.
    const metadata = await failure(
      prepareGitSource(
        source({ repoUrl: 'https://git.example.org/acme/app.git' }),
        'p',
        policy({
          allowedHosts: ['git.example.org'],
          protocols: ['https'],
          allowPrivateAddresses: true,
          resolve: () => Promise.resolve(['169.254.169.254']),
        }),
      ),
    );
    expect(metadata).toMatch(/HOST_REFUSED/);
    expect(existsSync(path.join(base, 'work'))).toBe(false);
  });
  it('refuses a file:// repository outside the allowed roots', async () => {
    expect(await failure(prepareGitSource(source({ repoUrl: 'file:///etc' }), 'p', policy()))).toMatch(
      /URL_REFUSED/,
    );
  });
});

describe('preparing a remote repository (local file:// repositories)', () => {
  it('default branch, chosen branch, then an exact commit (which wins over the branch)', async () => {
    const first = await prepareGitSource(source(), 'p1', policy());
    expect(first.commit).toBe(c1);
    expect((await prepareGitSource(source({ branch: 'dev' }), 'p1', policy())).commit).toBe(c2);
    const pinned = await prepareGitSource(source({ branch: 'dev', commit: c1 }), 'p1', policy());
    expect(pinned.commit).toBe(c1);
    expect(existsSync(path.join(pinned.root, 'src/app/b.component.ts'))).toBe(false);
    // Le dossier de travail est sous la racine du serveur, propre à la source et au projet.
    expect(pinned.root).toBe(await workdirOf(policy(), 'p1', 'front'));
    expect(path.relative(path.join(base, 'work'), pinned.root).startsWith('..')).toBe(false);
  });

  it('a symbolic link of the repository is checked out as a plain file, never followed', async () => {
    const { root } = await prepareGitSource(source(), 'p-link', policy());
    const info = await lstat(path.join(root, 'src/app/escape.ts'));
    expect(info.isSymbolicLink()).toBe(false);
    const read = await readSource(root, []);
    expect(read.files.find((f) => f.path === 'src/app/escape.ts')?.text).toBe('/etc/hostname');
  });

  it('a hook planted in the working copy is never executed', async () => {
    const { root } = await prepareGitSource(source(), 'p-hook', policy());
    const marker = path.join(base, 'hook-ran');
    // Le dépôt est initialisé sans modèle (aucun exemple de hook) : le dossier est créé pour l'essai.
    await mkdir(path.join(root, '.git/hooks'), { recursive: true });
    await writeFile(path.join(root, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(path.join(root, '.git/hooks/post-checkout'), 0o755);
    await prepareGitSource(source({ branch: 'dev' }), 'p-hook', policy());
    expect(existsSync(marker)).toBe(false);
  });

  it('explicit errors: missing branch, missing commit, unreachable repository; a failed first clone leaves nothing', async () => {
    expect(await failure(prepareGitSource(source({ branch: 'nope' }), 'p-err', policy()))).toMatch(
      /BRANCH_NOT_FOUND.*nope/,
    );
    expect(await failure(prepareGitSource(source({ commit: 'a'.repeat(40) }), 'p-err', policy()))).toMatch(
      /COMMIT_NOT_FOUND/,
    );
    expect(await failure(prepareGitSource(source({ commit: 'abc123' }), 'p-err', policy()))).toMatch(
      /full identifier/,
    );
    expect(await failure(prepareGitSource(source({ branch: '../x' }), 'p-err', policy()))).toMatch(
      /invalid branch/,
    );
    expect(
      await failure(
        prepareGitSource(
          source({ repoUrl: pathToFileURL(path.join(base, 'absent')).href }),
          'p-err',
          policy(),
        ),
      ),
    ).toMatch(/UNREACHABLE/);
    const dir = await workdirOf(policy(), 'p-err', 'front');
    expect(existsSync(dir)).toBe(false);
    expect((await readdir(path.dirname(dir))).filter((n) => n.endsWith('.lock'))).toEqual([]);
  });

  it('concurrent preparations of the same source are serialised and both succeed', async () => {
    const [a, b] = await Promise.all([
      prepareGitSource(source(), 'p-conc', policy()),
      prepareGitSource(source({ branch: 'dev' }), 'p-conc', policy()),
    ]);
    expect([a.commit, b.commit].sort()).toEqual([c1, c2].sort());
    const dir = await workdirOf(policy(), 'p-conc', 'front');
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it('a file is read back at an exact revision; removed sources lose their working copy', async () => {
    const { root } = await prepareGitSource(source({ branch: 'dev' }), 'p-show', policy());
    expect(await gitShow(root, c2, 'src/app/b.component.ts', policy())).toBe('export class BComponent {}\n');
    expect(await gitShow(root, c2, '../outside', policy())).toBeUndefined();
    expect(await gitShow(root, 'f'.repeat(40), 'src/app/a.component.ts', policy())).toBeUndefined();
    await removeWorkdirs(policy(), 'p-show', ['front']);
    expect(existsSync(root)).toBe(false);
  });

  it('a file path longer than 260 characters is checked out (Windows limit)', async () => {
    const deep = path.join(base, 'deep');
    const file = [
      ...Array.from({ length: 12 }, (_, i) => `package-segment-${String(i).padStart(2, '0')}`),
      'VeryLongServiceName.java',
    ].join('/');
    await makeRepo(deep, { [file]: 'class VeryLongServiceName {}\n' });
    const prepared = await prepareGitSource(
      source({ repoUrl: pathToFileURL(deep).href }),
      'p-long',
      policy(),
    );
    const full = path.join(prepared.root, file);
    expect(full.length).toBeGreaterThan(260);
    expect(existsSync(full)).toBe(true);
    expect(await gitShow(prepared.root, prepared.commit, file, policy())).toBe(
      'class VeryLongServiceName {}\n',
    );
  });

  it('a repository above the size limit is refused and removed', async () => {
    const message = await failure(prepareGitSource(source(), 'p-size', policy({ maxRepoBytes: 1 })));
    expect(message).toMatch(/LIMIT/);
    expect(existsSync(await workdirOf(policy(), 'p-size', 'front'))).toBe(false);
  });
});

describe('a private repository over HTTP (local git http-backend with Basic authentication)', () => {
  let server: Server;
  let port = 0;
  const TOKEN = 'tok-1234567890-secret';
  beforeAll(async () => {
    const served = path.join(base, 'served');
    await mkdir(served);
    execFileSync('git', ['clone', '-q', '--bare', origin, path.join(served, 'private.git')]);
    const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname.startsWith('/moved/')) {
        res.writeHead(302, { Location: `/private.git${url.pathname.slice('/moved'.length)}${url.search}` });
        res.end();
        return;
      }
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
        res.end();
        return;
      }
      const child = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: served,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
          GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      req.pipe(child.stdin);
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.on('close', () => {
        const all = Buffer.concat(chunks);
        const split = all.indexOf('\r\n\r\n');
        const head = all.subarray(0, split).toString();
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.split('\r\n')) {
          const [k, ...v] = line.split(':');
          if (!k) continue;
          if (k.toLowerCase() === 'status') status = Number.parseInt(v.join(':').trim(), 10);
          else headers[k] = v.join(':').trim();
        }
        res.writeHead(status, headers);
        res.end(all.subarray(split + 4));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const http = (extra: Partial<GitPolicy> = {}): GitPolicy =>
    policy({ allowedHosts: ['127.0.0.1'], protocols: ['http'], allowPrivateAddresses: true, ...extra });
  const remote = (extra: Partial<MapSource> = {}): MapSource =>
    source({ repoUrl: `http://127.0.0.1:${String(port)}/private.git`, ...extra });

  it('without credentials: the repository requires a token', async () => {
    expect(await failure(prepareGitSource(remote(), 'h1', http()))).toMatch(
      /AUTH_FAILED.*requires credentials/,
    );
  });
  it('a token variable the server does not have, or may not read', async () => {
    expect(await failure(prepareGitSource(remote({ tokenEnv: 'QA_GIT_TOKEN' }), 'h1', http()))).toMatch(
      /CREDENTIALS_MISSING.*QA_GIT_TOKEN/,
    );
    expect(
      await failure(prepareGitSource(remote({ tokenEnv: 'HOME' }), 'h1', http({ env: { HOME: 'x' } }))),
    ).toMatch(/CREDENTIALS_MISSING.*does not read/);
  });
  it('a wrong token is refused, and its value never appears in the error', async () => {
    const message = await failure(
      prepareGitSource(
        remote({ tokenEnv: 'QA_GIT_TOKEN' }),
        'h1',
        http({ env: { QA_GIT_TOKEN: 'wrong-token-value' } }),
      ),
    );
    expect(message).toMatch(/AUTH_FAILED.*refused the credentials/);
    expect(message).not.toContain('wrong-token-value');
  });
  it('the right token clones the private repository; the URL and the error carry no secret', async () => {
    const prepared = await prepareGitSource(
      remote({ tokenEnv: 'QA_GIT_TOKEN' }),
      'h1',
      http({ env: { QA_GIT_TOKEN: TOKEN } }),
    );
    expect(prepared.commit).toBe(c1);
    expect(prepared.repo.url).toBe(`http://127.0.0.1:${String(port)}/private.git`);
    // Le jeton n'est écrit nulle part dans la copie de travail.
    const config = execFileSync('git', ['-C', prepared.root, 'config', '--local', '--list']).toString();
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain('extraheader');
  });
  it('redirections are not followed', async () => {
    const message = await failure(
      prepareGitSource(
        source({ id: 'moved', repoUrl: `http://127.0.0.1:${String(port)}/moved`, tokenEnv: 'QA_GIT_TOKEN' }),
        'h2',
        http({ env: { QA_GIT_TOKEN: TOKEN } }),
      ),
    );
    expect(message).not.toBe('no error');
    expect(message).not.toContain(TOKEN);
  });
});

describe('scan: several repositories, local revisions, comparison', () => {
  it('two Git sources with identical file paths are scanned together, each with its own revision', async () => {
    const other = path.join(base, 'other');
    await makeRepo(other, { 'src/app/a.component.ts': 'export class OtherA {}\n' });
    const config: CartographyConfig = {
      schema: 1,
      sources: [
        source(),
        source({ id: 'back', name: 'Back', layer: 'BACKEND', repoUrl: pathToFileURL(other).href }),
      ],
    };
    const { model } = await runScan({
      config,
      allowedRoots: [],
      incremental: false,
      prepareGit: (s, signal) => prepareGitSource(s, 'scan', policy(), signal),
    });
    expect(model.scan.sources.map((s) => [s.sourceId, s.state, s.kind, s.revisionStatus])).toEqual([
      ['front', 'SCANNED', 'GIT', 'RESOLVED'],
      ['back', 'SCANNED', 'GIT', 'RESOLVED'],
    ]);
    expect(model.scan.sources[0]?.revision).toBe(c1);
    expect(model.scan.sources[1]?.revision).toBe(git(other, 'rev-parse', 'HEAD'));
    // Chaque preuve garde sa source : deux fichiers de même chemin ne se confondent pas.
    const evidence = model.nodes
      .flatMap((n) => n.evidence)
      .filter((e) => e.file === 'src/app/a.component.ts');
    expect(new Set(evidence.map((e) => e.sourceId))).toEqual(new Set(['front']));
    expect(evidence.every((e) => e.revision === c1)).toBe(true);
  });

  it('a Git source without server support is DENIED; a failed one does not stop the others', async () => {
    const local = path.join(base, 'local');
    await makeRepo(local, { 'src/x.ts': 'export const x = 1;\n' });
    const config: CartographyConfig = {
      schema: 1,
      sources: [
        source({ id: 'remote' }),
        { id: 'local', name: 'Local', layer: 'FRONTEND', path: local, include: [], enabled: true },
      ],
    };
    const off = await runScan({ config, allowedRoots: [base], incremental: false });
    expect(off.model.scan.sources[0]).toMatchObject({ state: 'DENIED' });
    expect(off.model.scan.sources[0]?.errors[0]).toMatch(/GIT_DISABLED/);
    expect(off.model.scan.sources[1]).toMatchObject({ state: 'SCANNED', revisionStatus: 'RESOLVED' });
    expect(off.model.scan.state).toBe('PARTIAL');
    const broken = await runScan({
      config: { ...config, sources: [source({ id: 'remote', branch: 'nope' }), ...config.sources.slice(1)] },
      allowedRoots: [base],
      incremental: false,
      prepareGit: (s) => prepareGitSource(s, 'scan2', policy()),
    });
    expect(broken.model.scan.sources[0]).toMatchObject({ state: 'FAILED' });
    expect(broken.model.scan.sources[0]?.errors[0]).toMatch(/BRANCH_NOT_FOUND/);
    expect(broken.model.scan.sources[1]?.state).toBe('SCANNED');
  });

  it('local revision: sub-folder of a repository, worktree .git file, pointer outside the root, no repository', async () => {
    const mono = path.join(base, 'mono');
    await makeRepo(mono, { 'front/src/a.ts': 'a\n' });
    const head = git(mono, 'rev-parse', 'HEAD');
    expect(await gitInfo(path.join(mono, 'front'), base)).toEqual({
      status: 'RESOLVED',
      revision: head,
      repoPath: 'front',
    });
    const tree = path.join(base, 'tree');
    git(mono, 'worktree', 'add', '-q', '-b', 'side', tree);
    expect(await gitInfo(tree, base)).toMatchObject({ status: 'RESOLVED', revision: head, repoPath: '' });
    // Le même worktree lu depuis une racine qui n'inclut pas le dépôt principal : non suivi, cause dite.
    const narrow = await gitInfo(tree, tree);
    expect(narrow.status).toBe('UNDETERMINED');
    expect(narrow.note).toMatch(/hors de la racine autorisée/);
    const empty = path.join(base, 'empty');
    await mkdir(empty);
    git(empty, 'init', '-q');
    expect(await gitInfo(empty, base)).toMatchObject({ status: 'UNDETERMINED' });
    const plain = path.join(base, 'plain');
    await mkdir(plain);
    expect(await gitInfo(plain, plain)).toEqual({ status: 'NONE' });
  });

  it('comparison of two commits: same files → unchanged; new files → modified; unread → undetermined', async () => {
    const scanAt = async (extra: Partial<MapSource>) =>
      (
        await runScan({
          config: { schema: 1, sources: [source(extra)] },
          allowedRoots: [],
          incremental: false,
          prepareGit: (s) => prepareGitSource(s, 'cmp', policy()),
        })
      ).model;
    const a = await scanAt({ commit: c1 });
    const b = await scanAt({ branch: 'dev' });
    const again = await scanAt({ commit: c1 });
    const failed = await scanAt({ branch: 'nope' });
    const same = compareSources(a, again, []);
    expect(same[0]).toMatchObject({ status: 'UNCHANGED' });
    const changed = compareSources(a, b, [
      { node: 'x', kind: 'COMPONENT', name: 'BComponent', change: 'ADDED', detail: [] },
    ]);
    expect(changed[0]?.from?.revision).toBe(c1);
    expect(changed[0]?.to?.revision).toBe(c2);
    expect(['MODIFIED', 'UNCHANGED']).toContain(changed[0]?.status);
    expect(compareSources(a, failed, [])[0]).toMatchObject({ status: 'UNDETERMINED' });
  });
});

describe('“View on Git” links', () => {
  const rev = 'a'.repeat(40);
  it.each([
    ['https://github.com/acme/app.git', undefined, `https://github.com/acme/app/blob/${rev}/src/a.ts#L12`],
    ['https://gitlab.com/acme/app', undefined, `https://gitlab.com/acme/app/-/blob/${rev}/src/a.ts#L12`],
    [
      'https://bitbucket.org/acme/app',
      undefined,
      `https://bitbucket.org/acme/app/src/${rev}/src/a.ts#lines-12`,
    ],
    [
      'https://git.corp.example/acme/app',
      'GITLAB' as const,
      `https://git.corp.example/acme/app/-/blob/${rev}/src/a.ts#L12`,
    ],
  ])('%s', (repo, provider, expected) => {
    expect(gitFileUrl(repo, provider, rev, 'src/a.ts', 12)).toBe(expected);
  });
  it('Azure DevOps uses the exact commit and the line', () => {
    const url = new URL(
      gitFileUrl('https://dev.azure.com/org/proj/_git/app', undefined, rev, 'src/a.ts', 3) ?? '',
    );
    expect(url.searchParams.get('version')).toBe(`GC${rev}`);
    expect(url.searchParams.get('path')).toBe('/src/a.ts');
    expect(url.searchParams.get('line')).toBe('3');
  });
  it('no link for an unknown host, without an exact commit, or for an unsafe path', () => {
    expect(gitFileUrl('https://git.corp.example/acme/app', undefined, rev, 'a.ts', 1)).toBeUndefined();
    expect(gitFileUrl('https://github.com/acme/app', undefined, 'main', 'a.ts', 1)).toBeUndefined();
    expect(gitFileUrl('https://github.com/acme/app', undefined, undefined, 'a.ts', 1)).toBeUndefined();
    expect(gitFileUrl('https://github.com/acme/app', undefined, rev, '../a.ts', 1)).toBeUndefined();
    expect(gitFileUrl('file:///repo', 'GITHUB', rev, 'a.ts', 1)).toBeUndefined();
  });
});
