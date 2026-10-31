import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvestigationScope } from '../../src/incident/model.js';
import {
  automation,
  decideExtension,
  defaultScope,
  requestExtension,
  ScopeExtensionError,
  validateScope,
} from '../../src/incident/scope.js';

/**
 * LE PÉRIMÈTRE : valeurs sûres par défaut, validation (dépôts réels sur disque), extensions demandées
 * puis décidées — seule une approbation modifie le périmètre, et une décision est définitive.
 */
let workspace: string;
let frontend: string;
let bff: string;
const NOW = new Date('2026-10-01T09:00:00.000Z');
const LATER = new Date('2026-10-01T09:05:00.000Z');

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'qa-incident-scope-')));
  frontend = path.join(workspace, 'books-front');
  bff = path.join(workspace, 'books-bff');
  await mkdir(path.join(frontend, 'src/books'), { recursive: true });
  await writeFile(path.join(frontend, 'package.json'), '{"name":"books-front"}', 'utf8');
  await mkdir(path.join(bff, 'src/main/java'), { recursive: true });
  await mkdir(path.join(workspace, 'elsewhere'), { recursive: true });
  await mkdir(path.join(workspace, 'books-admin'), { recursive: true });
  await writeFile(path.join(workspace, 'books-admin/package.json'), '{"name":"books-admin"}', 'utf8');
  await symlink(path.join(workspace, 'elsewhere'), path.join(bff, 'linked'));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function validScope(): InvestigationScope {
  return defaultScope({
    applications: [
      {
        id: 'front',
        name: 'Books front',
        layer: 'FRONTEND',
        repository: { root: frontend, include: ['src/books'] },
        baseUrl: 'http://localhost:3000',
      },
      {
        id: 'bff',
        name: 'Books BFF',
        layer: 'BFF',
        repository: { root: bff, include: ['src/main/java'], classes: ['BookController'] },
        logFiles: ['logs/bff.log'],
        openshift: { namespace: 'books-test', selector: 'app=books-bff' },
      },
    ],
    scenarios: ['Créer un livre'],
    steps: [1, 3],
    endpoints: ['POST /api/books', 'GET /api/books/{id}'],
    allowedHosts: ['catalog.test', 'localhost:8081', '[::1]:8080'],
    logRoots: [path.join(workspace, 'logs')],
  });
}

describe('defaultScope', () => {
  it('is safe by default', () => {
    const scope = defaultScope();
    expect(scope.mode).toBe('GUIDED');
    expect(scope.depth).toBe(3);
    expect(scope.permissions).toEqual({
      readSources: true,
      navigate: true,
      httpRequests: 'NONE',
      runTests: 'NONE',
      localCommands: false,
      readLogs: false,
      openshift: 'NONE',
      sideEffects: false,
    });
    expect(scope.limits).toEqual({
      maxFiles: 2000,
      maxFileBytes: 524288,
      maxDurationMs: 600000,
      maxRequests: 200,
      maxExperiments: 20,
    });
    expect(scope.applications).toEqual([]);
    expect(scope.extensions).toEqual([]);
  });

  it('merges permissions and limits field by field and never shares arrays', () => {
    const partial = {
      depth: 4,
      permissions: { readLogs: true } as unknown as InvestigationScope['permissions'],
      limits: { maxFiles: 10 } as unknown as InvestigationScope['limits'],
      scenarios: ['Créer un livre'],
      mode: undefined,
    } as Partial<InvestigationScope>;
    const scope = defaultScope(partial);
    expect(scope.depth).toBe(4);
    expect(scope.mode).toBe('GUIDED');
    expect(scope.permissions.readLogs).toBe(true);
    expect(scope.permissions.sideEffects).toBe(false);
    expect(scope.limits).toMatchObject({ maxFiles: 10, maxRequests: 200 });
    scope.scenarios.push('Autre');
    expect(partial.scenarios).toEqual(['Créer un livre']);
    defaultScope().allowedHosts.push('x.test');
    expect(defaultScope().allowedHosts).toEqual([]);
  });
});

describe('validateScope', () => {
  it('accepts a complete scope', async () => {
    expect(await validateScope(validScope())).toEqual({ ok: true, issues: [] });
  });

  it('reports every invalid field', async () => {
    const scope = validScope();
    const [front, back] = scope.applications;
    if (!front || !back) throw new Error('applications attendues');
    scope.applications.push({ ...structuredClone(back), name: 'Copie' });
    front.repository.root = 'relative/front';
    back.repository.include = ['../escape', 'missing', 'linked'];
    back.repository.classes = ['Book Controller'];
    back.openshift = { namespace: 'Books_Test', selector: 'app=books-bff' };
    back.logFiles = ['/var/log/elsewhere.log'];
    scope.endpoints.push('post api/books', 'FETCH /api/books');
    scope.allowedHosts.push('http://catalog.test', 'bad host', 'catalog.test:70000');
    scope.depth = 6;
    scope.logRoots.push('relative/logs');
    scope.limits.maxFiles = 0;
    scope.limits.maxFileBytes = 1e12;
    scope.steps.push(0);
    const { ok, issues } = await validateScope(scope);
    expect(ok).toBe(false);
    const fields = issues.map((issue) => issue.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'applications[0].repository.root',
        'applications[1].repository.include[0]',
        'applications[1].repository.include[1]',
        'applications[1].repository.include[2]',
        'applications[1].repository.classes[0]',
        'applications[1].openshift.namespace',
        'applications[1].logFiles[0]',
        'applications[2].id',
        'endpoints[2]',
        'endpoints[3]',
        'allowedHosts[3]',
        'allowedHosts[4]',
        'allowedHosts[5]',
        'depth',
        'logRoots[1]',
        'limits.maxFiles',
        'limits.maxFileBytes',
        'steps[2]',
      ]),
    );
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true);
    expect(issues.find((issue) => issue.field === 'applications[1].repository.include[2]')?.message).toMatch(
      /hors de la racine/,
    );
  });

  it('refuses a root that does not exist and duplicate extension ids', async () => {
    const scope = validScope();
    const [front] = scope.applications;
    if (!front) throw new Error('application attendue');
    front.repository.root = path.join(workspace, 'nowhere');
    const extension = requestExtension(
      scope,
      { kind: 'ADD_HOST', target: 'a.test', reason: 'r' },
      'qa',
      NOW,
    ).extension;
    scope.extensions.push(extension, extension);
    const fields = (await validateScope(scope)).issues.map((issue) => issue.field);
    expect(fields).toContain('applications[0].repository.root');
    expect(fields).toContain('extensions[1].id');
  });
});

describe('scope extensions', () => {
  it('records a pending request without changing the scope', () => {
    const scope = validScope();
    const { scope: next, extension } = requestExtension(
      scope,
      { kind: 'ADD_ENDPOINT', target: 'put   /api/books/{id}', reason: 'Modification observée' },
      'analyst',
      NOW,
    );
    expect(extension).toMatchObject({
      kind: 'ADD_ENDPOINT',
      target: 'PUT /api/books/{id}',
      status: 'PENDING',
      requestedBy: 'analyst',
      requestedAt: NOW.toISOString(),
    });
    expect(extension.id).toMatch(/^ext_[\w-]{12}$/);
    expect(next.endpoints).toEqual(scope.endpoints);
    expect(next.extensions).toHaveLength(1);
    expect(scope.extensions).toHaveLength(0);
    // La même demande encore en attente n'est pas dupliquée.
    const again = requestExtension(
      next,
      { kind: 'ADD_ENDPOINT', target: 'PUT /api/books/{id}', reason: 'x' },
      'qa',
      LATER,
    );
    expect(again.extension.id).toBe(extension.id);
    expect(again.scope.extensions).toHaveLength(1);
  });

  it('refuses invalid requests', () => {
    const scope = validScope();
    const ask =
      (kind: Parameters<typeof requestExtension>[1]['kind'], target: string, applicationId?: string) => () =>
        requestExtension(
          scope,
          { kind, target, reason: 'motif', ...(applicationId ? { applicationId } : {}) },
          'qa',
          NOW,
        );
    expect(ask('ADD_PATH', '../secrets', 'bff')).toThrow(ScopeExtensionError);
    expect(ask('ADD_PATH', 'src/test')).toThrow(/application/);
    expect(ask('ADD_CLASS', 'BookService')).toThrow(ScopeExtensionError);
    expect(ask('ADD_CLASS', 'Book Service', 'bff')).toThrow(ScopeExtensionError);
    expect(ask('ADD_ENDPOINT', '/api/books')).toThrow(ScopeExtensionError);
    expect(ask('ADD_HOST', 'not a host')).toThrow(ScopeExtensionError);
    expect(ask('ADD_APPLICATION', 'relative/repo')).toThrow(ScopeExtensionError);
    expect(ask('ADD_APPLICATION', '/repos/x', 'bff')).toThrow(/existe déjà/);
    expect(ask('ADD_APPLICATION', `FRONTEND:${frontend}`)).toThrow(/déjà le dépôt/);
    expect(ask('ALLOW_COMMAND', 'rm')).toThrow(/toujours refusée/);
    expect(ask('ALLOW_COMMAND', 'mvn; rm')).toThrow(ScopeExtensionError);
    expect(ask('ADD_HOST', '   ')).toThrow(ScopeExtensionError);
    expect(() =>
      requestExtension(scope, { kind: 'ADD_HOST', target: 'a.test', reason: '  ' }, 'qa', NOW),
    ).toThrow(/motivée/);
    expect(() =>
      requestExtension({ ...scope, depth: 5 }, { kind: 'RAISE_DEPTH', target: '6', reason: 'r' }, 'qa', NOW),
    ).toThrow(/maximum/);
  });

  it('applies each approved extension to the scope', () => {
    let scope = validScope();
    const approve = (
      kind: Parameters<typeof requestExtension>[1]['kind'],
      target: string,
      applicationId?: string,
    ): void => {
      const requested = requestExtension(
        scope,
        { kind, target, reason: 'utile', ...(applicationId ? { applicationId } : {}) },
        'analyst',
        NOW,
      );
      scope = decideExtension(requested.scope, requested.extension.id, true, 'lead', LATER);
    };
    approve('ADD_PATH', 'src/main/resources', 'bff');
    approve('ADD_PATH', path.join(frontend, 'src/shared'));
    approve('ADD_CLASS', 'BookService', 'bff');
    approve('ADD_ENDPOINT', 'delete /api/books/{id}');
    approve('ADD_HOST', 'https://covers.test:8443/img');
    approve('RAISE_DEPTH', 'x');
    approve('ALLOW_SIDE_EFFECTS', 'POST /api/books');
    approve('ALLOW_COMMAND', './mvnw');
    approve('ADD_APPLICATION', `BACKEND:${path.join(workspace, 'catalog')}`, 'catalog');
    approve('ADD_APPLICATION', path.join(workspace, 'books-admin'));

    const bffApp = scope.applications.find((application) => application.id === 'bff');
    const frontApp = scope.applications.find((application) => application.id === 'front');
    expect(bffApp?.repository.include).toEqual(['src/main/java', 'src/main/resources']);
    expect(bffApp?.repository.classes).toEqual(['BookController', 'BookService']);
    expect(frontApp?.repository.include).toEqual(['src/books', 'src/shared']);
    expect(scope.endpoints).toContain('DELETE /api/books/{id}');
    expect(scope.allowedHosts).toContain('covers.test:8443');
    expect(scope.depth).toBe(4);
    expect(scope.permissions.sideEffects).toBe(true);
    expect(scope.permissions.localCommands).toBe(true);
    expect(scope.allowedCommands).toEqual(['./mvnw']);
    expect(scope.applications.find((application) => application.id === 'catalog')).toMatchObject({
      layer: 'BACKEND',
      repository: { root: path.join(workspace, 'catalog'), include: [] },
    });
    // Sans couche indiquée : package.json → FRONTEND, avec un identifiant libre.
    expect(scope.applications.at(-1)).toMatchObject({ id: 'books-admin', layer: 'FRONTEND' });
    expect(scope.extensions.every((extension) => extension.status === 'APPROVED')).toBe(true);
    expect(scope.extensions[0]).toMatchObject({ decidedBy: 'lead', decidedAt: LATER.toISOString() });
  });

  it('leaves the scope unchanged on rejection and never decides twice', () => {
    const scope = validScope();
    const requested = requestExtension(
      scope,
      { kind: 'ALLOW_SIDE_EFFECTS', target: 'tests', reason: 'r' },
      'qa',
      NOW,
    );
    const rejected = decideExtension(requested.scope, requested.extension.id, false, 'lead', LATER);
    expect(rejected.permissions.sideEffects).toBe(false);
    expect(rejected.extensions[0]?.status).toBe('REJECTED');
    expect(requested.scope.extensions[0]?.status).toBe('PENDING');
    expect(() => decideExtension(rejected, requested.extension.id, true, 'lead', LATER)).toThrow(
      /déjà été décidée/,
    );
    expect(() => decideExtension(rejected, 'ext_unknown', true, 'lead', LATER)).toThrow(ScopeExtensionError);
  });

  it('does not narrow a whole-root include nor an all-classes scope', () => {
    const scope = defaultScope({
      applications: [{ id: 'bff', name: 'BFF', layer: 'BFF', repository: { root: bff, include: [] } }],
    });
    const path1 = requestExtension(
      scope,
      { kind: 'ADD_PATH', target: 'src', applicationId: 'bff', reason: 'r' },
      'qa',
      NOW,
    );
    const afterPath = decideExtension(path1.scope, path1.extension.id, true, 'lead', NOW);
    expect(afterPath.applications[0]?.repository.include).toEqual([]);
    const cls = requestExtension(
      afterPath,
      { kind: 'ADD_CLASS', target: 'BookMapper', applicationId: 'bff', reason: 'r' },
      'qa',
      NOW,
    );
    const afterClass = decideExtension(cls.scope, cls.extension.id, true, 'lead', NOW);
    expect(afterClass.applications[0]?.repository.classes).toBeUndefined();
  });
});

describe('automation', () => {
  it('describes what each mode does on its own', () => {
    expect(automation('MANUAL')).toEqual({
      proposeExtensions: false,
      autoRunExperiments: false,
      askBeforeEachStep: true,
    });
    expect(automation('GUIDED')).toEqual({
      proposeExtensions: true,
      autoRunExperiments: false,
      askBeforeEachStep: false,
    });
    expect(automation('AUTO_WITHIN_SCOPE')).toEqual({
      proposeExtensions: false,
      autoRunExperiments: true,
      askBeforeEachStep: false,
    });
  });
});
