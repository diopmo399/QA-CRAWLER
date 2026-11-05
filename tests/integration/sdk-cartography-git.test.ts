import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type Project,
  type QaCrawlerClient,
  type QaCrawlerError,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LES SOURCES GIT AVEC LE VRAI SERVEUR : un dépôt distant (file://, préparé par le serveur dans son dossier
 * de travail) et un dossier local dans le même scan, la révision de chacun, « Voir le code » à la révision
 * exacte (même après un nouveau commit), « Voir sur Git » pour l'hébergeur connu, la comparaison de deux
 * commits, le nettoyage des copies de travail, et le refus quand le serveur n'autorise aucune source distante.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-graph');
let server: RunningSdkServer;
let workspace: string;
let roots: string;
let client: QaCrawlerClient;
let project: Project;
let c1: string;
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    .toString()
    .trim();
const settle = async (): Promise<void> => {
  for (let i = 0; i < 600; i += 1) {
    if ((await client.cartography.currentScan(project.id)).state !== 'RUNNING') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const error = async (work: Promise<unknown>): Promise<QaCrawlerError> =>
  (await work.then(
    () => undefined,
    (e: unknown) => e,
  )) as QaCrawlerError;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-carto-git-'));
  roots = await mkdtemp(path.join(tmpdir(), 'sdk-carto-git-src-'));
  for (const part of ['front', 'bff']) {
    await cp(path.join(FIXTURE, part), path.join(roots, part), { recursive: true });
    git(path.join(roots, part), 'init', '-q', '-b', 'main');
    git(path.join(roots, part), 'add', '-A');
    git(path.join(roots, part), 'commit', '-qm', 'init');
  }
  c1 = git(path.join(roots, 'front'), 'rev-parse', 'HEAD');
  server = await startSdkServer({
    workspace,
    language: 'fr',
    env: { QA_GIT_TOKEN: 'never-returned-token-value' },
    allowedSourceRoots: [roots],
    gitSources: { allowedHosts: [], protocols: ['file'] },
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Git sources', targetUrl: 'http://127.0.0.1:9/', framework: 'angular' },
  });
}, 60_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(roots, { recursive: true, force: true });
});

describe('cartography with remote Git and local sources', () => {
  it('saves a remote source (no secret stored) next to a local one with a repository URL', async () => {
    const config = await client.cartography.saveConfig(project.id, {
      sources: [
        {
          id: 'front',
          name: 'Front',
          layer: 'FRONTEND',
          kind: 'GIT',
          path: '',
          include: [],
          enabled: true,
          repoUrl: `file://${path.join(roots, 'front')}`,
          tokenEnv: 'QA_GIT_TOKEN',
        },
        {
          id: 'bff',
          name: 'BFF',
          layer: 'BFF',
          path: path.join(roots, 'bff'),
          include: [],
          enabled: true,
          repoUrl: 'https://github.com/acme/bff.git',
        },
      ],
    });
    expect(config.sources.map((s) => [s.id, s.kind ?? 'LOCAL', s.path === '' ? '' : 'path'])).toEqual([
      ['front', 'GIT', ''],
      ['bff', 'LOCAL', 'path'],
    ]);
    expect(JSON.stringify(await client.cartography.get(project.id))).not.toContain(
      'never-returned-token-value',
    );
    const summary = await client.cartography.summary(project.id);
    expect(summary.gitHosts).toEqual([]);
  });

  it('refuses unsafe or unsupported remote sources', async () => {
    const save = (extra: Record<string, unknown>) =>
      client.cartography.saveConfig(project.id, {
        sources: [
          {
            id: 'x',
            name: 'X',
            layer: 'FRONTEND',
            kind: 'GIT',
            path: '',
            include: [],
            enabled: true,
            ...extra,
          },
        ],
      });
    expect((await error(save({ repoUrl: 'https://github.com/acme/app' }))).status).toBe(422);
    expect((await error(save({ repoUrl: 'https://u:p@github.com/a/b' }))).status).toBe(422);
    expect((await error(save({ repoUrl: `file://${roots}/front`, commit: 'abc' }))).status).toBe(400);
    expect((await error(save({ repoUrl: `file://${roots}/front`, tokenEnv: 'HOME' }))).status).toBe(400);
    expect((await error(save({}))).status).toBe(400);
  });

  it('scans both sources together; each keeps its exact revision; evidence reads the analysed revision', async () => {
    await client.cartography.scan(project.id, { incremental: false });
    await settle();
    const summary = await client.cartography.summary(project.id);
    expect(summary.scan?.state).toBe('COMPLETED');
    const [front, bff] = summary.scan?.sources ?? [];
    expect(front).toMatchObject({ sourceId: 'front', kind: 'GIT', revision: c1, revisionStatus: 'RESOLVED' });
    expect(bff).toMatchObject({ sourceId: 'bff', revisionStatus: 'RESOLVED', repoPath: '' });
    expect(bff?.revision).toBe(git(path.join(roots, 'bff'), 'rev-parse', 'HEAD'));
    const excerpt = await client.cartography.evidence(project.id, {
      source: 'front',
      file: 'src/app/app.routes.ts',
      line: 1,
    });
    expect(excerpt.lines.length).toBeGreaterThan(0);
    expect(excerpt).toMatchObject({ revision: c1, layer: 'FRONTEND' });
    expect(excerpt.gitUrl).toBeUndefined();
    const linked = await client.cartography.evidence(project.id, { source: 'bff', file: 'pom.xml', line: 3 });
    expect(linked.gitUrl).toBe(`https://github.com/acme/bff/blob/${bff?.revision ?? ''}/pom.xml#L3`);
  });

  it('after a new commit: the old revision stays readable, the comparison names both commits', async () => {
    const front = path.join(roots, 'front');
    await writeFile(path.join(front, 'src/app/app.routes.ts'), '// changed\nexport const routes = [];\n');
    git(front, 'commit', '-qam', 'change');
    const c2 = git(front, 'rev-parse', 'HEAD');
    await client.cartography.scan(project.id, { incremental: false });
    await settle();
    const old = await client.cartography.evidence(project.id, {
      source: 'front',
      file: 'src/app/app.routes.ts',
      line: 1,
      revision: c1,
    });
    expect(old.lines.join('\n')).not.toContain('// changed');
    const fresh = await client.cartography.evidence(project.id, {
      source: 'front',
      file: 'src/app/app.routes.ts',
      line: 1,
    });
    expect(fresh).toMatchObject({ revision: c2 });
    expect(fresh.lines[0]).toBe('// changed');
    const impact = await client.cartography.impact(project.id);
    const compared = impact.sources?.find((s) => s.sourceId === 'front');
    expect(compared?.from?.revision).toBe(c1);
    expect(compared?.to?.revision).toBe(c2);
    expect(compared?.status).toBe('MODIFIED');
    expect(impact.sources?.find((s) => s.sourceId === 'bff')?.status).toBe('UNCHANGED');
  });

  it('a file absent from a local source is said unavailable, not invented', async () => {
    await rm(path.join(roots, 'bff', 'pom.xml'));
    const gone = await client.cartography.evidence(project.id, { source: 'bff', file: 'pom.xml', line: 1 });
    expect(gone.lines).toEqual([]);
    expect(gone.unavailable).toMatch(/n’existe plus/);
  });

  it('removing the remote source removes its working copy', async () => {
    const workRoot = path.join(workspace, '.git-sources');
    const before = await readdir(workRoot, { recursive: true });
    expect(before.some((entry) => entry.endsWith('front'))).toBe(true);
    const config = await client.cartography.get(project.id);
    await client.cartography.saveConfig(project.id, {
      sources: config.config.sources.filter((s) => s.id !== 'front'),
    });
    const after = await readdir(workRoot, { recursive: true });
    expect(after.some((entry) => entry.endsWith('front'))).toBe(false);
  });
});

describe('a server without remote Git sources', () => {
  it('refuses a GIT source and keeps local sources working', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'sdk-carto-nogit-'));
    const plain = await startSdkServer({
      workspace: ws,
      language: 'fr',
      env: {},
      allowedSourceRoots: [roots],
    });
    const c = createQaCrawler({ endpoint: `${plain.url}/api`, token: plain.token });
    try {
      const p = await c.projects.create({
        ...engineDefaults(),
        project: { name: 'No git', targetUrl: 'http://127.0.0.1:9/', framework: 'angular' },
      });
      const refused = await error(
        c.cartography.saveConfig(p.id, {
          sources: [
            {
              id: 'r',
              name: 'R',
              layer: 'FRONTEND',
              kind: 'GIT',
              path: '',
              include: [],
              enabled: true,
              repoUrl: `file://${roots}/front`,
            },
          ],
        }),
      );
      expect(refused.status).toBe(422);
      expect(refused.message).toMatch(/GIT_DISABLED/);
      // Une configuration d'avant (sans type) reste une source locale.
      const legacy = await c.cartography.saveConfig(p.id, {
        sources: [
          {
            id: 'l',
            name: 'L',
            layer: 'FRONTEND',
            path: path.join(roots, 'front'),
            include: [],
            enabled: true,
          },
        ],
      });
      expect(legacy.sources[0]?.kind).toBeUndefined();
      expect((await c.cartography.summary(p.id)).gitHosts).toBeUndefined();
      expect(existsSync(path.join(ws, '.git-sources'))).toBe(false);
    } finally {
      c.dispose();
      await plain.close();
      await rm(ws, { recursive: true, force: true });
    }
  });
});
