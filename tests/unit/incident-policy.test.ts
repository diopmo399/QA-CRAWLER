import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFiles } from '../../src/incident/guarded-fs.js';
import type { InvestigationScope, PolicyDecision, PolicyOperation } from '../../src/incident/model.js';
import { defaultScope, decideExtension, requestExtension } from '../../src/incident/scope.js';
import { forbiddenAddress, ScopeDeniedError, ScopePolicy } from '../../src/incident/scope-policy.js';

/**
 * LE SCOPE POLICY ENGINE sur un vrai dépôt temporaire (BFF du catalogue de livres) : remontées « .. »,
 * liens symboliques qui sortent du dépôt, fichiers sensibles, hôtes et adresses de métadonnées,
 * commandes et métacaractères, OpenShift en lecture seule, budgets, et extension approuvée qui
 * rend permise une opération refusée.
 */
let workspace: string;
let repo: string;
let outside: string;
let logs: string;
const NOW = new Date('2026-10-01T10:00:00.000Z');

async function put(file: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'qa-incident-policy-')));
  repo = path.join(workspace, 'books-bff');
  outside = path.join(workspace, 'elsewhere');
  logs = path.join(workspace, 'logs');
  const java = path.join(repo, 'src/main/java/org/example/bff/books');
  await put(path.join(java, 'BookController.java'), 'class BookController {}');
  await put(path.join(java, 'BookService.java'), 'class BookService {}');
  await put(path.join(repo, 'src/main/resources/application.yml'), 'catalog:\n  url: http://catalog.test\n');
  await put(path.join(repo, 'src/main/resources/.env'), 'CATALOG_PASSWORD=hidden');
  await put(path.join(repo, 'src/main/resources/.env.local'), 'X=1');
  await put(path.join(repo, 'src/main/resources/server.pem'), 'pem');
  await put(path.join(repo, 'src/main/resources/catalog-credentials.json'), '{}');
  await put(path.join(repo, 'src/main/resources/id_rsa'), 'key');
  await put(path.join(repo, 'src/main/resources/huge.yml'), 'a'.repeat(5000));
  await put(path.join(repo, 'src/main/java/.git/config'), '[core]');
  await put(path.join(repo, 'src/main/java/node_modules/lib/Ignored.java'), 'class Ignored {}');
  await put(path.join(repo, 'docs/Notes.java'), 'class Notes {}');
  await put(path.join(repo, 'logs/bff.log'), 'INFO started\n');
  await put(path.join(outside, 'Hidden.java'), 'class Hidden {}');
  await put(path.join(logs, 'catalog.log'), 'ERROR NullPointerException\n');
  await put(path.join(workspace, 'other.log'), 'nope');
  await symlink(path.join(outside, 'Hidden.java'), path.join(java, 'Escape.java'));
  await symlink(outside, path.join(java, 'escape-dir'));
  await symlink(path.join(java, 'BookService.java'), path.join(java, 'Alias.java'));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function scope(partial: Partial<InvestigationScope> = {}): InvestigationScope {
  return defaultScope({
    applications: [
      {
        id: 'bff',
        name: 'Books BFF',
        layer: 'BFF',
        repository: { root: repo, include: ['src/main/java', 'src/main/resources'] },
        baseUrl: 'http://localhost:8081',
        logFiles: ['logs/bff.log'],
        openshift: { namespace: 'books-test', selector: 'app=books-bff' },
      },
    ],
    limits: { maxFiles: 50, maxFileBytes: 1000, maxDurationMs: 60_000, maxRequests: 2, maxExperiments: 1 },
    ...partial,
  });
}

const java = (name: string): string => path.join(repo, 'src/main/java/org/example/bff/books', name);
const read = (file: string): PolicyOperation => ({ kind: 'READ_FILE', path: file });

async function denied(policy: ScopePolicy, operation: PolicyOperation): Promise<PolicyDecision> {
  const decision = await policy.check(operation);
  expect(decision.allowed, `${decision.rule} ${decision.reason}`).toBe(false);
  expect(decision.reason).not.toBe('');
  return decision;
}

function approve(current: InvestigationScope, decision: PolicyDecision): InvestigationScope {
  expect(decision.extension).toBeDefined();
  const { extension } = decision;
  if (!extension) throw new Error('extension attendue');
  const requested = requestExtension(
    current,
    {
      kind: extension.kind,
      target: extension.target,
      ...(extension.applicationId ? { applicationId: extension.applicationId } : {}),
      reason: 'utile au diagnostic',
    },
    'reviewer',
    NOW,
  );
  return decideExtension(requested.scope, requested.extension.id, true, 'reviewer', NOW);
}

describe('ScopePolicy — fichiers', () => {
  it('allows a file inside an included folder and reports its real path', async () => {
    const policy = new ScopePolicy(scope());
    const decision = await policy.check(read(java('BookController.java')));
    expect(decision.allowed).toBe(true);
    expect(decision.resolvedPath).toBe(java('BookController.java'));
    const alias = await policy.check(read(java('Alias.java')));
    expect(alias.allowed).toBe(true);
    expect(alias.resolvedPath).toBe(java('BookService.java'));
  });

  it('refuses relative paths and ../ traversal even when it would land back in the repository', async () => {
    const policy = new ScopePolicy(scope());
    expect((await denied(policy, read('src/main/java/x.java'))).rule).toBe('path.absolute');
    const escape = `${repo}/src/main/java/../../../elsewhere/Hidden.java`;
    expect((await denied(policy, read(escape))).rule).toBe('path.traversal');
    const back = `${repo}/src/main/java/../java/org/example/bff/books/BookService.java`;
    expect((await denied(policy, read(back))).rule).toBe('path.traversal');
    expect((await denied(policy, read(`${repo}/src/\0x`))).rule).toBe('path.invalid');
  });

  it('refuses a symlink that resolves outside the repository (file and directory)', async () => {
    const policy = new ScopePolicy(scope());
    const file = await denied(policy, read(java('Escape.java')));
    expect(file.rule).toBe('path.symlink-escape');
    expect(file.resolvedPath).toBe(path.join(outside, 'Hidden.java'));
    expect(file.extension).toBeUndefined();
    const dir = await denied(policy, { kind: 'LIST_DIR', path: java('escape-dir') });
    expect(dir.rule).toBe('path.symlink-escape');
  });

  it('refuses sensitive files whatever the scope says', async () => {
    const policy = new ScopePolicy(scope());
    const resources = path.join(repo, 'src/main/resources');
    for (const name of ['.env', '.env.local', 'server.pem', 'catalog-credentials.json', 'id_rsa']) {
      expect((await denied(policy, read(path.join(resources, name)))).rule).toBe('path.sensitive');
    }
    expect((await denied(policy, read(path.join(repo, 'src/main/java/.git/config')))).rule).toBe(
      'path.sensitive',
    );
    expect(
      (await denied(policy, { kind: 'LIST_DIR', path: path.join(repo, 'src/main/java/.git') })).rule,
    ).toBe('path.sensitive');
  });

  it('refuses files larger than maxFileBytes and paths outside every repository', async () => {
    const policy = new ScopePolicy(scope());
    expect((await denied(policy, read(path.join(repo, 'src/main/resources/huge.yml')))).rule).toBe(
      'limits.maxFileBytes',
    );
    const elsewhere = await denied(policy, read(path.join(outside, 'Hidden.java')));
    expect(elsewhere.rule).toBe('path.outside-scope');
    expect(elsewhere.extension).toEqual({ kind: 'ADD_APPLICATION', target: outside });
    expect((await denied(policy, read(path.join(repo, 'src/main/java/Missing.java')))).rule).toBe(
      'path.missing',
    );
  });

  it('refuses everything when readSources is off', async () => {
    const policy = new ScopePolicy(
      scope({ permissions: { ...defaultScope().permissions, readSources: false } }),
    );
    expect((await denied(policy, read(java('BookController.java')))).rule).toBe('permissions.readSources');
  });

  it('refuses a folder outside include, suggests ADD_PATH, and allows it once the extension is approved', async () => {
    const initial = scope();
    const policy = new ScopePolicy(initial);
    const decision = await denied(policy, read(path.join(repo, 'docs/Notes.java')));
    expect(decision.rule).toBe('path.outside-include');
    expect(decision.extension).toEqual({ kind: 'ADD_PATH', target: 'docs', applicationId: 'bff' });
    // Le dossier racine se parcourt (parent d'un dossier inclus), pas un dossier voisin.
    expect((await policy.check({ kind: 'LIST_DIR', path: repo })).rule).toBe('path.include-ancestor');
    expect((await denied(policy, { kind: 'LIST_DIR', path: path.join(repo, 'docs') })).rule).toBe(
      'path.outside-include',
    );

    const extended = approve(initial, decision);
    expect(extended.applications[0]?.repository.include).toContain('docs');
    const after = await new ScopePolicy(extended).check(read(path.join(repo, 'docs/Notes.java')));
    expect(after.allowed).toBe(true);
  });

  it('keeps every decision for the audit and throws ScopeDeniedError from require()', async () => {
    const policy = new ScopePolicy(scope());
    await policy.check(read(java('BookController.java')));
    await expect(policy.require(read(java('Escape.java')))).rejects.toBeInstanceOf(ScopeDeniedError);
    try {
      await policy.require(read(path.join(repo, 'src/main/resources/.env')));
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeDeniedError);
      expect((error as ScopeDeniedError).decision.rule).toBe('path.sensitive');
    }
    expect(policy.decisions.map((decision) => decision.allowed)).toEqual([true, false, false]);
    const unknown = await policy.check({ kind: 'DELETE_EVERYTHING' } as unknown as PolicyOperation);
    expect(unknown.allowed).toBe(false);
    expect(unknown.rule).toBe('operation.unknown');
  });
});

describe('ScopePolicy — journaux', () => {
  it('needs readLogs and a log root or a declared log file', async () => {
    expect(
      (await denied(new ScopePolicy(scope()), { kind: 'READ_LOG', path: path.join(logs, 'catalog.log') }))
        .rule,
    ).toBe('permissions.readLogs');
    const policy = new ScopePolicy(
      scope({ logRoots: [logs], permissions: { ...defaultScope().permissions, readLogs: true } }),
    );
    expect((await policy.check({ kind: 'READ_LOG', path: path.join(logs, 'catalog.log') })).allowed).toBe(
      true,
    );
    expect((await policy.check({ kind: 'READ_LOG', path: path.join(repo, 'logs/bff.log') })).allowed).toBe(
      true,
    );
    expect((await denied(policy, { kind: 'READ_LOG', path: path.join(workspace, 'other.log') })).rule).toBe(
      'log.outside-scope',
    );
    expect((await denied(policy, { kind: 'READ_LOG', path: `${logs}/../other.log` })).rule).toBe(
      'path.traversal',
    );
  });
});

describe('ScopePolicy — réseau', () => {
  it('allows application, declared and environment hosts only, over http(s)', async () => {
    const policy = new ScopePolicy(scope({ allowedHosts: ['catalog.test:8082'] }), {
      extraHosts: ['http://localhost:3000'],
    });
    expect((await policy.check({ kind: 'NAVIGATE', url: 'http://localhost:3000/books/new' })).allowed).toBe(
      true,
    );
    expect((await policy.check({ kind: 'NAVIGATE', url: 'http://localhost:8081/api/books' })).allowed).toBe(
      true,
    );
    expect((await policy.check({ kind: 'NAVIGATE', url: 'http://catalog.test:8082/x' })).allowed).toBe(true);
    expect((await denied(policy, { kind: 'NAVIGATE', url: 'http://catalog.test:9999/x' })).rule).toBe(
      'network.host',
    );
    expect((await denied(policy, { kind: 'NAVIGATE', url: 'file:///etc/passwd' })).rule).toBe(
      'navigate.protocol',
    );
    expect((await denied(policy, { kind: 'NAVIGATE', url: 'javascript:alert(1)' })).rule).toBe(
      'navigate.protocol',
    );
    expect((await denied(policy, { kind: 'NAVIGATE', url: 'not a url' })).rule).toBe('navigate.url');
  });

  it('refuses cloud metadata and link-local addresses in every numeric form, even when allow-listed', async () => {
    const policy = new ScopePolicy(
      scope({ allowedHosts: ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'] }),
    );
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://2852039166/',
      'http://0xA9FEA9FE/',
      'http://0251.0376.0251.0376/',
      'http://169.254.1.1:8080/',
      'http://[::ffff:169.254.169.254]/',
      'http://[fe80::1]/',
      'http://[fd00:ec2::254]/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://METADATA.GOOGLE.INTERNAL./',
      'http://100.100.100.200/',
    ]) {
      expect((await denied(policy, { kind: 'NAVIGATE', url })).rule, url).toBe('network.metadata');
    }
    expect(forbiddenAddress('10.0.0.1')).toBeUndefined();
    expect(forbiddenAddress('::1')).toBeUndefined();
  });

  it('checks resolved addresses when a resolver is given', async () => {
    const policy = new ScopePolicy(scope({ allowedHosts: ['rebind.test'] }), {
      resolveHost: () => Promise.resolve(['169.254.169.254']),
    });
    expect((await denied(policy, { kind: 'NAVIGATE', url: 'http://rebind.test/' })).rule).toBe(
      'network.metadata',
    );
  });

  it('suggests ADD_HOST and allows the host once approved', async () => {
    const initial = scope();
    const decision = await denied(new ScopePolicy(initial), {
      kind: 'NAVIGATE',
      url: 'https://covers.test/img',
    });
    expect(decision.extension).toEqual({ kind: 'ADD_HOST', target: 'covers.test' });
    const extended = approve(initial, decision);
    expect(
      (await new ScopePolicy(extended).check({ kind: 'NAVIGATE', url: 'https://covers.test/img' })).allowed,
    ).toBe(true);
  });

  it('applies the HTTP levels and side effects', async () => {
    const base = defaultScope().permissions;
    const none = new ScopePolicy(scope());
    expect(
      (await denied(none, { kind: 'HTTP', method: 'GET', url: 'http://localhost:8081/api/books' })).rule,
    ).toBe('permissions.httpRequests');
    const readOnly = new ScopePolicy(scope({ permissions: { ...base, httpRequests: 'READ_ONLY' } }));
    expect(
      (await readOnly.check({ kind: 'HTTP', method: 'get', url: 'http://localhost:8081/api/books' })).allowed,
    ).toBe(true);
    expect(
      (await denied(readOnly, { kind: 'HTTP', method: 'POST', url: 'http://localhost:8081/api/books' })).rule,
    ).toBe('http.read-only');
    expect(
      (await denied(readOnly, { kind: 'HTTP', method: 'GET', url: 'http://169.254.169.254/' })).rule,
    ).toBe('network.metadata');
    const initial = scope({ permissions: { ...base, httpRequests: 'ALL' } });
    const all = new ScopePolicy(initial);
    expect((await denied(all, { kind: 'HTTP', method: 'TRACE', url: 'http://localhost:8081/' })).rule).toBe(
      'http.method',
    );
    const write = await denied(all, { kind: 'HTTP', method: 'POST', url: 'http://localhost:8081/api/books' });
    expect(write.rule).toBe('permissions.sideEffects');
    expect(write.extension?.kind).toBe('ALLOW_SIDE_EFFECTS');
    const extended = approve(initial, write);
    expect(
      (
        await new ScopePolicy(extended).check({
          kind: 'HTTP',
          method: 'POST',
          url: 'http://localhost:8081/api/books',
        })
      ).allowed,
    ).toBe(true);
  });

  it('refuses navigation when the permission is off', async () => {
    const policy = new ScopePolicy(
      scope({ permissions: { ...defaultScope().permissions, navigate: false } }),
    );
    expect((await denied(policy, { kind: 'NAVIGATE', url: 'http://localhost:8081/' })).rule).toBe(
      'permissions.navigate',
    );
  });
});

describe('ScopePolicy — tests et commandes', () => {
  const unit = (): ScopePolicy =>
    new ScopePolicy(scope({ permissions: { ...defaultScope().permissions, runTests: 'UNIT' } }));
  const test = (command: string, args: string[], cwd = repo): PolicyOperation => ({
    kind: 'RUN_TEST',
    level: 'UNIT',
    command,
    args,
    cwd,
  });

  it('allows real test invocations only', async () => {
    const policy = unit();
    for (const [command, args] of [
      ['mvn', ['-q', 'test']],
      ['./mvnw', ['-Dtest=BookServiceTest', 'test']],
      ['mvn', ['-pl', 'books', '-Dtest=BookServiceTest#create', 'surefire:test']],
      ['./gradlew', ['test', '--tests', 'org.example.BookServiceTest']],
      ['npm', ['test']],
      ['npm', ['run', 'test:unit', '--', '--reporter=dot']],
      ['pnpm', ['test']],
      ['yarn', ['run', 'test']],
      ['npx', ['vitest', 'run', 'src/books']],
      ['npx', ['jest', 'books']],
    ] as const) {
      const decision = await policy.check(test(command, [...args]));
      expect(decision.allowed, `${command} ${args.join(' ')} → ${decision.reason}`).toBe(true);
    }
  });

  it('refuses publishing, skipped tests, other goals and other tools', async () => {
    const policy = unit();
    for (const [command, args, rule] of [
      ['mvn', ['deploy'], 'test.args'],
      ['mvn', ['install'], 'test.args'],
      ['mvn', ['test', 'release:prepare'], 'test.args'],
      ['mvn', ['site-deploy'], 'test.args'],
      ['mvn', ['test', '-DskipTests'], 'test.args'],
      ['mvn', ['test', 'exec:exec'], 'test.args'],
      ['mvn', ['-s', '/tmp/settings.xml', 'test'], 'test.args'],
      ['mvn', ['compile'], 'test.args'],
      ['mvn', ['verify'], 'test.args'],
      ['./gradlew', ['publish'], 'test.args'],
      ['./gradlew', ['test', '--init-script', 'x.gradle'], 'test.args'],
      ['npm', ['run', 'build'], 'test.args'],
      ['npm', ['install'], 'test.args'],
      ['npx', ['vitest'], 'test.args'],
      ['npx', ['--yes', 'some-tool'], 'test.args'],
      ['bash', ['-c', 'mvn test'], 'test.command'],
      ['/usr/bin/mvn', ['test'], 'test.command'],
      ['mvn', ['test', '-Dtest=A;rm -rf /'], 'command.metacharacters'],
      ['npm', ['test', '--', '$(id)'], 'command.metacharacters'],
    ] as const) {
      const decision = await denied(policy, test(command, [...args]));
      expect(decision.rule, `${command} ${args.join(' ')}`).toBe(rule);
    }
  });

  it('checks the test level, side effects and the working directory', async () => {
    expect((await denied(new ScopePolicy(scope()), test('mvn', ['test']))).rule).toBe('permissions.runTests');
    const integration: PolicyOperation = {
      kind: 'RUN_TEST',
      level: 'INTEGRATION',
      command: 'mvn',
      args: ['verify'],
      cwd: repo,
    };
    expect((await denied(unit(), integration)).rule).toBe('permissions.runTests');
    const initial = scope({ permissions: { ...defaultScope().permissions, runTests: 'INTEGRATION' } });
    const decision = await denied(new ScopePolicy(initial), integration);
    expect(decision.rule).toBe('permissions.sideEffects');
    const extended = approve(initial, decision);
    expect((await new ScopePolicy(extended).check(integration)).allowed).toBe(true);
    const cwd = await denied(unit(), test('mvn', ['test'], outside));
    expect(cwd.rule).toBe('command.cwd');
    expect(cwd.extension?.kind).toBe('ADD_APPLICATION');
  });

  it('always refuses dangerous commands and arguments, even when allow-listed', async () => {
    const policy = new ScopePolicy(
      scope({
        allowedCommands: ['rm', 'bash', 'curl', 'git', 'kubectl', 'find', 'node', 'docker'],
        permissions: { ...defaultScope().permissions, localCommands: true },
      }),
    );
    const command = (name: string, args: string[]): PolicyOperation => ({
      kind: 'COMMAND',
      command: name,
      args,
      cwd: repo,
    });
    for (const [name, args] of [
      ['rm', ['-rf', 'src']],
      ['/bin/rm', ['x']],
      ['bash', ['-c', 'ls']],
      ['curl', ['http://localhost:8081']],
      ['docker', ['ps']],
      ['sudo', ['ls']],
      ['git', ['push', 'origin']],
      ['git', ['reset', '--hard']],
      ['git', ['clean', '-fdx']],
      ['git', ['checkout', '--', '.']],
      ['git', ['rebase', 'main']],
      ['git', ['-c', 'core.pager=less', 'log']],
      ['kubectl', ['delete', 'pod', 'books-bff']],
      ['kubectl', ['get', 'secrets']],
      ['find', ['.', '-delete']],
      ['node', ['-e', '1+1']],
      ['git', ['log', 'sh']],
    ] as const) {
      expect((await denied(policy, command(name, [...args]))).rule, `${name} ${args.join(' ')}`).toBe(
        'command.dangerous',
      );
    }
    for (const arg of ['a;b', 'a|b', 'a&b', '`id`', '$(id)', 'a>b', 'a<b', 'a\nb', '(x)']) {
      expect((await denied(policy, command('git', ['log', arg]))).rule, arg).toBe('command.metacharacters');
    }
    expect((await policy.check(command('git', ['status']))).allowed).toBe(true);
    expect((await policy.check(command('kubectl', ['get', 'pods']))).allowed).toBe(true);
  });

  it('suggests ALLOW_COMMAND for an unknown command and allows it once approved', async () => {
    const initial = scope();
    const op: PolicyOperation = { kind: 'COMMAND', command: 'git', args: ['log', '-n', '5'], cwd: repo };
    const decision = await denied(new ScopePolicy(initial), op);
    expect(decision.rule).toBe('permissions.localCommands');
    expect(decision.extension).toEqual({ kind: 'ALLOW_COMMAND', target: 'git' });
    const extended = approve(initial, decision);
    expect(extended.permissions.localCommands).toBe(true);
    expect((await new ScopePolicy(extended).check(op)).allowed).toBe(true);
    // Approuver « git » n'autorise pas une autre commande.
    expect((await new ScopePolicy(extended).check({ ...op, command: 'grep', args: ['x'] })).rule).toBe(
      'command.not-allowed',
    );
  });
});

describe('ScopePolicy — OpenShift et budgets', () => {
  it('allows read-only verbs on safe resources in declared namespaces only', async () => {
    const off = new ScopePolicy(scope());
    const op = (verb: string, resource: string, namespace = 'books-test'): PolicyOperation => ({
      kind: 'OPENSHIFT',
      verb,
      resource,
      namespace,
    });
    expect((await denied(off, op('get', 'pods'))).rule).toBe('permissions.openshift');
    const policy = new ScopePolicy(
      scope({ permissions: { ...defaultScope().permissions, openshift: 'READ' } }),
      {
        execution: {
          target: 'ARO',
          aro: { namespace: 'qa-tools', serviceAccount: 'qa', image: 'img', repositoriesMount: '/repos' },
        },
      },
    );
    for (const [verb, resource, namespace] of [
      ['get', 'pods', 'books-test'],
      ['logs', 'pod/books-bff-1', 'books-test'],
      ['describe', 'deployments', 'books-test'],
      ['events', 'events', 'books-test'],
      ['get', 'routes', 'qa-tools'],
    ] as const) {
      expect((await policy.check(op(verb, resource, namespace))).allowed, `${verb} ${resource}`).toBe(true);
    }
    expect((await denied(policy, op('delete', 'pods'))).rule).toBe('openshift.verb');
    expect((await denied(policy, op('exec', 'pods'))).rule).toBe('openshift.verb');
    expect((await denied(policy, op('get', 'secrets'))).rule).toBe('openshift.sensitive-resource');
    expect((await denied(policy, op('get', 'configmaps'))).rule).toBe('openshift.sensitive-resource');
    expect((await denied(policy, op('get', 'nodes'))).rule).toBe('openshift.resource');
    expect((await denied(policy, op('get', 'pods', 'other-team'))).rule).toBe('openshift.namespace');
  });

  it('consumes budgets until exhausted', () => {
    const policy = new ScopePolicy(scope());
    expect([policy.consume('request'), policy.consume('request'), policy.consume('request')]).toEqual([
      true,
      true,
      false,
    ]);
    expect([policy.consume('experiment'), policy.consume('experiment')]).toEqual([true, false]);
    expect(policy.usage()).toEqual({ file: 0, request: 2, experiment: 1 });
  });
});

describe('guardedFiles', () => {
  it('lists in-scope files only, skips build folders and reports escaping symlinks', async () => {
    const files = guardedFiles(new ScopePolicy(scope()));
    const listed = await files.list(repo, { extensions: ['.java', 'yml'] });
    const relative = listed.map((file) => path.relative(repo, file));
    expect(relative).toEqual([
      'src/main/java/org/example/bff/books/Alias.java',
      'src/main/java/org/example/bff/books/BookController.java',
      'src/main/java/org/example/bff/books/BookService.java',
      'src/main/resources/application.yml',
    ]);
    const deniedPaths = files.denied.map((entry) => path.relative(repo, entry.path));
    expect(deniedPaths).toContain('src/main/java/org/example/bff/books/Escape.java');
    expect(deniedPaths).toContain('src/main/java/org/example/bff/books/escape-dir');
    expect(deniedPaths).toContain('src/main/resources/huge.yml');
    expect(deniedPaths.some((entry) => entry.includes('docs'))).toBe(false);
    expect(files.truncated).toEqual([]);
  });

  it('reads through the policy, records refusals and stops at the file budget', async () => {
    const files = guardedFiles(new ScopePolicy(scope({ limits: { ...defaultScope().limits, maxFiles: 2 } })));
    expect(await files.readText(java('BookController.java'))).toBe('class BookController {}');
    await expect(files.readText(path.join(repo, 'src/main/resources/.env'))).rejects.toBeInstanceOf(
      ScopeDeniedError,
    );
    expect(files.denied.at(-1)?.reason).toContain('path.sensitive');
    await expect(files.readText(java('Escape.java'))).rejects.toThrow(/symlink-escape/);
    expect(await files.readText(java('BookService.java'))).toBe('class BookService {}');
    await expect(files.readText(java('Alias.java'))).rejects.toThrow(/limits\.maxFiles/);
    expect(files.truncated).toHaveLength(1);

    const listed = await files.list(repo, { extensions: ['.java'] });
    expect(listed).toHaveLength(2);
    expect(files.truncated.some((entry) => entry.includes('limite de 2 fichiers'))).toBe(true);
  });

  it('returns nothing for a root outside the scope', async () => {
    const files = guardedFiles(new ScopePolicy(scope()));
    expect(await files.list(outside, { extensions: ['.java'] })).toEqual([]);
    expect(files.denied[0]?.reason).toContain('path.outside-scope');
  });
});
