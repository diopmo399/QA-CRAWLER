import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isIncluded, normalizeInclude } from '../../src/incident/scope-tree.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import {
  SCOPE_TREE_MAX_NODES,
  type Incident,
  type ScopeTreeNode,
} from '../../src/sdk/core/incident-contracts.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * L'ARBORESCENCE DU PÉRIMÈTRE : les dossiers d'un dépôt (jamais le contenu des fichiers), lus par le Scope
 * Policy Engine sur toute la racine, sans suivre les liens symboliques (ni sortie du dépôt, ni boucle),
 * sans dépendances ni sorties de build, profondeur et nombre de dossiers bornés, `included` calculé
 * d'après `include` ; droit RUN.
 */
let workspace: string;
let repos: string;
let server: RunningSdkServer;
let admin: QaCrawlerClient;
let reader: QaCrawlerClient;
let project: Project;
let incident: Incident;
const clients: QaCrawlerClient[] = [];

const as = (token: string): QaCrawlerClient => {
  const client = createQaCrawler({ endpoint: `${server.url}/api`, token });
  clients.push(client);
  return client;
};

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof QaCrawlerError ? `${String(error.status)} ${error.code}` : String(error);
  }
};

const names = (node: ScopeTreeNode | undefined): string[] =>
  (node?.children ?? []).map((child) => child.name);
const child = (node: ScopeTreeNode | undefined, name: string): ScopeTreeNode | undefined =>
  node?.children.find((entry) => entry.name === name);
const count = (node: ScopeTreeNode): number =>
  node.children.reduce((total, entry) => total + 1 + count(entry), 0);

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-tree-ws-'));
  repos = await mkdtemp(path.join(tmpdir(), 'incident-tree-repos-'));
  const front = path.join(repos, 'front');
  for (const dir of [
    'src/main/java/org/example',
    'src/test',
    'docs',
    'node_modules/left-pad',
    '.git/objects',
    'target/classes',
    'dist',
    'build',
    '.idea',
    'coverage',
  ])
    await mkdir(path.join(front, dir), { recursive: true });
  await writeFile(path.join(front, 'src/main/App.tsx'), 'export const secret = "never read";');
  // Un lien qui sort du dépôt, un lien qui y reste : aucun n'est suivi.
  await mkdir(path.join(repos, 'outside/private'), { recursive: true });
  await symlink(path.join(repos, 'outside'), path.join(front, 'linked-out'));
  await symlink(path.join(front, 'src'), path.join(front, 'linked-in'));
  const big = path.join(repos, 'big');
  for (let index = 0; index < SCOPE_TREE_MAX_NODES + 50; index += 1)
    await mkdir(path.join(big, `d${String(index).padStart(3, '0')}`), { recursive: true });

  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  admin = as(server.token);
  reader = as((await admin.access.createMember({ name: 'Lecteur fictif', role: 'READER' })).token);
  project = await admin.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  incident = await admin.incidents.create(project.id, {
    title: 'Erreur 500',
    description: 'd',
    observed: 'o',
    expected: 'e',
    severity: 'HIGH',
    scope: {
      applications: [
        {
          id: 'front',
          name: 'Frontend',
          layer: 'FRONTEND',
          repository: { root: front, include: ['src/main/'] },
        },
        { id: 'big', name: 'Gros dépôt', layer: 'BACKEND', repository: { root: big, include: [] } },
      ],
    },
  });
});

afterAll(async () => {
  for (const client of clients) client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(repos, { recursive: true, force: true });
});

describe('scope tree — inclusion', () => {
  it('normalizes include entries and computes inclusion by prefix', () => {
    expect(normalizeInclude('./src/main/')).toBe('src/main');
    expect(normalizeInclude('src\\main')).toBe('src/main');
    expect(normalizeInclude('.')).toBe('');
    expect(isIncluded('src/main/java', ['src/main/'])).toBe(true);
    expect(isIncluded('src/mainframe', ['src/main'])).toBe(false);
    expect(isIncluded('src', ['src/main'])).toBe(false);
    expect(isIncluded('anything', [])).toBe(true);
    expect(isIncluded('', ['.'])).toBe(true);
  });
});

describe('scope tree — route', () => {
  it('lists directories only, skips dependencies and build outputs, never follows a symbolic link', async () => {
    const tree = await admin.incidents.scopeTree(project.id, incident.id, 'front');
    expect(tree.applicationId).toBe('front');
    expect(tree.depth).toBe(3);
    expect(tree.capped).toBeUndefined();
    expect(tree.root).toMatchObject({ path: '', name: 'front', included: false });
    expect(names(tree.root)).toEqual(['docs', 'src']);
    const src = child(tree.root, 'src');
    expect(src).toMatchObject({ path: 'src', included: false });
    expect(names(src)).toEqual(['main', 'test']);
    expect(child(src, 'main')).toMatchObject({ path: 'src/main', included: true });
    expect(child(src, 'test')?.included).toBe(false);
    // Profondeur 3 : src/main/java est lu, ses sous-dossiers sont signalés, pas listés.
    const java = child(child(src, 'main'), 'java');
    expect(java).toMatchObject({ path: 'src/main/java', included: true, children: [], truncated: true });
    expect(JSON.stringify(tree)).not.toMatch(/never read|App\.tsx|linked|private|node_modules|\.git/);
  });

  it('honours the depth (1..4) and refuses anything else', async () => {
    const shallow = await admin.incidents.scopeTree(project.id, incident.id, 'front', 1);
    expect(names(shallow.root)).toEqual(['docs', 'src']);
    expect(child(shallow.root, 'src')).toMatchObject({ children: [], truncated: true });
    expect(child(shallow.root, 'docs')?.truncated).toBeUndefined();
    const deep = await admin.incidents.scopeTree(project.id, incident.id, 'front', 4);
    expect(names(child(child(child(deep.root, 'src'), 'main'), 'java'))).toEqual(['org']);
    for (const depth of [0, 5, 1.5])
      expect(await refusal(admin.incidents.scopeTree(project.id, incident.id, 'front', depth))).toBe(
        '400 BAD_REQUEST',
      );
  });

  it(`stops at ${String(SCOPE_TREE_MAX_NODES)} directories and says the tree is partial`, async () => {
    const tree = await admin.incidents.scopeTree(project.id, incident.id, 'big', 1);
    expect(count(tree.root)).toBe(SCOPE_TREE_MAX_NODES);
    expect(tree.capped).toBe(true);
    expect(tree.root.truncated).toBe(true);
    expect(tree.root.included).toBe(true);
  });

  it('refuses an unknown application, a reader, and a scope that does not allow reading sources', async () => {
    expect(await refusal(admin.incidents.scopeTree(project.id, incident.id, 'ghost'))).toBe('404 NOT_FOUND');
    expect(await refusal(reader.incidents.scopeTree(project.id, incident.id, 'front'))).toBe('403 FORBIDDEN');
    const current = await admin.incidents.get(project.id, incident.id);
    await admin.incidents.update(project.id, incident.id, current.revision, {
      scope: { permissions: { ...current.scope.permissions, readSources: false } },
    });
    expect(await refusal(admin.incidents.scopeTree(project.id, incident.id, 'front'))).toBe(
      '403 OUT_OF_SCOPE',
    );
  });

  it('reads a repository root declared through a link where it really is, and only its own directories', async () => {
    const linkedRoot = path.join(repos, 'root-link');
    await symlink(path.join(repos, 'outside'), linkedRoot);
    const other = await admin.incidents.create(project.id, {
      title: 'Racine liée',
      description: 'd',
      observed: 'o',
      expected: 'e',
      severity: 'LOW',
      scope: {
        applications: [
          { id: 'linked', name: 'Lié', layer: 'BACKEND', repository: { root: linkedRoot, include: [] } },
        ],
      },
    });
    const tree = await admin.incidents.scopeTree(project.id, other.id, 'linked');
    expect(names(tree.root)).toEqual(['private']);
  });
});
