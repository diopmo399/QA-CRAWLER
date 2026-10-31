import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  defaultProcessRunner,
  EnvironmentError,
  environmentAdapter,
  investigationJobManifest,
  ocLogsArgs,
  type ProcessRunner,
} from '../../src/incident/environments.js';
import type {
  ExecutionEnvironmentConfig,
  InvestigationScope,
  ScopePermissions,
} from '../../src/incident/model.js';
import { defaultScope } from '../../src/incident/scope.js';
import { ScopeDeniedError, ScopePolicy } from '../../src/incident/scope-policy.js';

/**
 * L'ENVIRONNEMENT D'EXÉCUTION : un seul contrat pour LOCAL, REMOTE et ARO. Les outils sont lancés par
 * un lanceur SIMULÉ qui consigne ses appels (aucun programme réel) ; les capacités se lisent dans le
 * PATH et dans un dossier de ServiceAccount temporaire.
 */
let workspace: string;
let repos: string;
let backendRoot: string;
let logs: string;
let tools: string;
let emptyBin: string;
let serviceAccount: string;

interface RecordedCall {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function fakeRunner(result: { code: number | null; output: string; timedOut?: boolean; missing?: boolean }): {
  run: ProcessRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const run: ProcessRunner = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
    return Promise.resolve({
      code: result.code,
      output: result.output,
      timedOut: result.timedOut ?? false,
      missing: result.missing ?? false,
    });
  };
  return { run, calls };
}

function scope(
  permissions: Partial<ScopePermissions>,
  extra: Partial<InvestigationScope> = {},
): InvestigationScope {
  return defaultScope({
    applications: [
      {
        id: 'catalog-backend',
        name: 'Catalogue',
        layer: 'BACKEND',
        repository: { root: backendRoot, include: [] },
        openshift: { namespace: 'catalog-dev', selector: 'app=catalog-backend' },
      },
    ],
    logRoots: [logs],
    permissions: { ...defaultScope().permissions, ...permissions },
    ...extra,
  });
}

const signal = new AbortController().signal;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-incident-env-'));
  repos = path.join(workspace, 'repos');
  backendRoot = path.join(repos, 'catalog-backend');
  await mkdir(path.join(backendRoot, 'src', 'main', 'java'), { recursive: true });
  await writeFile(path.join(backendRoot, 'pom.xml'), '<project/>');
  await writeFile(
    path.join(backendRoot, 'src', 'main', 'java', 'CatalogBookService.java'),
    'class CatalogBookService {}\n',
  );
  logs = path.join(workspace, 'logs');
  await mkdir(logs);
  await writeFile(
    path.join(logs, 'catalog.log'),
    [
      '2026-10-30T10:00:00Z INFO started',
      '2026-10-30T10:00:05Z ERROR java.lang.NullPointerException password=hunter2',
      '2026-10-30T10:00:06Z INFO done',
    ].join('\n') + '\n',
  );
  tools = path.join(workspace, 'bin');
  emptyBin = path.join(workspace, 'empty-bin');
  await mkdir(tools);
  await mkdir(emptyBin);
  for (const tool of ['mvn', 'npm', 'oc']) {
    await writeFile(path.join(tools, tool), '#!/bin/false\n');
    await chmod(path.join(tools, tool), 0o755);
  }
  serviceAccount = path.join(workspace, 'serviceaccount');
  await mkdir(serviceAccount);
  await writeFile(path.join(serviceAccount, 'namespace'), 'qa-crawler\n');
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const aroConfig = (): ExecutionEnvironmentConfig => ({
  target: 'ARO',
  aro: {
    namespace: 'qa-crawler',
    serviceAccount: 'qa-crawler-investigator',
    image: 'registry.example.test/qa-crawler:1.0.0',
    repositoriesMount: repos,
  },
});

describe('capabilities (sans effet de bord)', () => {
  it('LOCAL : outils trouvés dans le PATH, sans rien lancer', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' });
    const caps = await environmentAdapter({ target: 'LOCAL' }, { run, env: { PATH: tools } }).capabilities();
    expect(caps).toMatchObject({
      target: 'LOCAL',
      playwright: 'LOCAL_PROCESS',
      repositories: 'LOCAL',
      tests: true,
      logs: 'FILES',
      kubernetesJobs: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('LOCAL sans outils : limitations explicites', async () => {
    const caps = await environmentAdapter({ target: 'LOCAL' }, { env: { PATH: emptyBin } }).capabilities();
    expect(caps.tests).toBe(false);
    expect(caps.limitations.join('\n')).toMatch(/Maven/);
    expect(caps.limitations.join('\n')).toMatch(/npm/);
  });

  it('REMOTE : OpenShift facultatif, lu avec oc quand il est configuré', async () => {
    const configured = await environmentAdapter(
      { target: 'REMOTE', remote: { openshift: { namespace: 'catalog-dev', context: 'dev' } } },
      { env: { PATH: tools } },
    ).capabilities();
    expect(configured.logs).toBe('FILES_AND_OPENSHIFT');
    const missingOc = await environmentAdapter(
      { target: 'REMOTE', remote: { openshift: { namespace: 'catalog-dev' } } },
      { env: { PATH: emptyBin } },
    ).capabilities();
    expect(missingOc.logs).toBe('FILES');
    expect(missingOc.limitations.join('\n')).toMatch(/oc not found/);
    const bare = await environmentAdapter({ target: 'REMOTE' }, { env: { PATH: tools } }).capabilities();
    expect(bare.logs).toBe('FILES');
    expect(bare.limitations.join('\n')).toMatch(/remote\.openshift/);
  });

  it('ARO dans le cluster : conteneur, volume, Jobs et journaux OpenShift', async () => {
    const caps = await environmentAdapter(aroConfig(), {
      env: { PATH: tools, KUBERNETES_SERVICE_HOST: '10.0.0.1' },
      serviceAccountDir: serviceAccount,
    }).capabilities();
    expect(caps).toMatchObject({
      target: 'ARO',
      playwright: 'CONTAINER',
      repositories: 'CLUSTER_VOLUME',
      logs: 'OPENSHIFT',
      kubernetesJobs: true,
      tests: true,
    });
    expect(caps.limitations).toEqual([]);
  });

  it('ARO hors du cluster ou dans un autre namespace : limitations', async () => {
    const outside = await environmentAdapter(aroConfig(), {
      env: { PATH: tools },
      serviceAccountDir: serviceAccount,
    }).capabilities();
    expect(outside.kubernetesJobs).toBe(false);
    expect(outside.logs).toBe('NONE');
    expect(outside.limitations.join('\n')).toMatch(/not running inside a cluster/);
    const config = aroConfig();
    if (config.aro) config.aro.namespace = 'other-ns';
    const mismatch = await environmentAdapter(config, {
      env: { PATH: tools, KUBERNETES_SERVICE_HOST: '10.0.0.1' },
      serviceAccountDir: serviceAccount,
    }).capabilities();
    expect(mismatch.limitations.join('\n')).toMatch(/differs from configured namespace other-ns/);
    const unconfigured = await environmentAdapter({ target: 'ARO' }, { env: { PATH: tools } }).capabilities();
    expect(unconfigured.limitations.join('\n')).toMatch(/without `aro` configuration/);
  });
});

describe('runTest', () => {
  it('refuse sans permission : rien n’est lancé', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' });
    const adapter = environmentAdapter({ target: 'LOCAL' }, { run, env: { PATH: tools } });
    const policy = new ScopePolicy(scope({ runTests: 'NONE' }));
    await expect(
      adapter.runTest(
        policy,
        { kind: 'RUN_TEST', level: 'UNIT', command: 'mvn', args: ['test'], cwd: backendRoot },
        { timeoutMs: 1000, signal },
      ),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    expect(calls).toHaveLength(0);
  });

  it('refuse les arguments dangereux (métacaractères, deploy)', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' });
    const adapter = environmentAdapter({ target: 'LOCAL' }, { run, env: { PATH: tools } });
    const policy = new ScopePolicy(scope({ runTests: 'UNIT' }));
    for (const args of [['test', '-Dx=$(id)'], ['deploy'], ['test', '-DskipTests']])
      await expect(
        adapter.runTest(
          policy,
          { kind: 'RUN_TEST', level: 'UNIT', command: 'mvn', args, cwd: backendRoot },
          { timeoutMs: 1000, signal },
        ),
      ).rejects.toBeInstanceOf(ScopeDeniedError);
    expect(calls).toHaveLength(0);
  });

  it('lance le test autorisé : environnement sans secrets, sortie masquée', async () => {
    const { run, calls } = fakeRunner({
      code: 1,
      output: 'Tests run: 1, Failures: 1, Errors: 0\npassword=hunter2\n',
    });
    const adapter = environmentAdapter(
      { target: 'LOCAL' },
      { run, env: { PATH: tools, JAVA_HOME: '/opt/jdk', QA_API_TOKEN: 'abc123', DB_PASSWORD: 'x' } },
    );
    const policy = new ScopePolicy(scope({ runTests: 'UNIT' }));
    const result = await adapter.runTest(
      policy,
      {
        kind: 'RUN_TEST',
        level: 'UNIT',
        command: 'mvn',
        args: ['-B', 'test', '-Dtest=CatalogBookServiceTest'],
        cwd: backendRoot,
      },
      { timeoutMs: 1234, signal },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'mvn',
      args: ['-B', 'test', '-Dtest=CatalogBookServiceTest'],
      cwd: backendRoot,
      timeoutMs: 1234,
    });
    expect(calls[0]?.env).toEqual({ PATH: tools, JAVA_HOME: '/opt/jdk' });
    expect(result.code).toBe(1);
    expect(result.output).not.toContain('hunter2');
    expect(result.output).toContain('Tests run: 1, Failures: 1');
  });

  it('signale un outil absent', async () => {
    const { run } = fakeRunner({ code: null, output: 'spawn mvn ENOENT', missing: true });
    const adapter = environmentAdapter({ target: 'LOCAL' }, { run, env: { PATH: emptyBin } });
    const result = await adapter.runTest(
      new ScopePolicy(scope({ runTests: 'UNIT' })),
      { kind: 'RUN_TEST', level: 'UNIT', command: 'mvn', args: ['test'], cwd: backendRoot },
      { timeoutMs: 1000, signal },
    );
    expect(result.code).toBeNull();
    expect(result.output).toMatch(/command not found on this LOCAL environment/);
  });
});

describe('readLogs', () => {
  it('fichier : sous les racines autorisées, fin du fichier, masqué', async () => {
    const adapter = environmentAdapter({ target: 'LOCAL' });
    const policy = new ScopePolicy(scope({ readLogs: true }));
    const lines = await adapter.readLogs(
      policy,
      { path: path.join(logs, 'catalog.log') },
      { maxLines: 2, signal },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('NullPointerException');
    expect(lines[0]).not.toContain('hunter2');
  });

  it('fichier : refusé sans permission ou hors des racines', async () => {
    const adapter = environmentAdapter({ target: 'LOCAL' });
    await expect(
      adapter.readLogs(
        new ScopePolicy(scope({ readLogs: false })),
        { path: path.join(logs, 'catalog.log') },
        {
          maxLines: 10,
          signal,
        },
      ),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    await expect(
      adapter.readLogs(
        new ScopePolicy(scope({ readLogs: true })),
        { path: path.join(backendRoot, 'pom.xml') },
        {
          maxLines: 10,
          signal,
        },
      ),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
  });

  it('OpenShift en LOCAL : absent tant qu’aucune connexion n’est configurée', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' });
    const adapter = environmentAdapter({ target: 'LOCAL' }, { run });
    await expect(
      adapter.readLogs(
        new ScopePolicy(scope({ openshift: 'READ' })),
        { openshift: { namespace: 'catalog-dev', selector: 'app=catalog-backend' } },
        { maxLines: 10, signal },
      ),
    ).rejects.toBeInstanceOf(EnvironmentError);
    expect(calls).toHaveLength(0);
  });

  it('OpenShift en REMOTE : oc logs -n -l --tail --since -c --context', async () => {
    const { run, calls } = fakeRunner({
      code: 0,
      output: 'line 1\nAuthorization: Bearer abcdefghijkl\nline 3\n',
    });
    const adapter = environmentAdapter(
      { target: 'REMOTE', remote: { openshift: { namespace: 'catalog-dev', context: 'dev-cluster' } } },
      { run },
    );
    const lines = await adapter.readLogs(
      new ScopePolicy(scope({ openshift: 'READ' })),
      {
        openshift: {
          namespace: 'catalog-dev',
          selector: 'app=catalog-backend',
          container: 'api',
          tail: 500,
          sinceSeconds: 300,
        },
      },
      { maxLines: 50, signal },
    );
    expect(calls[0]?.command).toBe('oc');
    expect(calls[0]?.args).toEqual([
      'logs',
      '-n',
      'catalog-dev',
      '-l',
      'app=catalog-backend',
      '--tail',
      '50',
      '--since=300s',
      '-c',
      'api',
      '--context=dev-cluster',
    ]);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('abcdefghijkl');
  });

  it('OpenShift en ARO : configuration du pod, refus sans permission ou hors namespace', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: 'ok\n' });
    const adapter = environmentAdapter(aroConfig(), { run });
    const source = { openshift: { namespace: 'catalog-dev', selector: 'app=catalog-backend' } };
    await expect(
      adapter.readLogs(new ScopePolicy(scope({ openshift: 'NONE' })), source, { maxLines: 10, signal }),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    await expect(
      adapter.readLogs(
        new ScopePolicy(scope({ openshift: 'READ' })),
        { openshift: { namespace: 'payments', selector: 'app=x' } },
        { maxLines: 10, signal },
      ),
    ).rejects.toBeInstanceOf(ScopeDeniedError);
    expect(calls).toHaveLength(0);
    await adapter.readLogs(new ScopePolicy(scope({ openshift: 'READ' })), source, { maxLines: 10, signal });
    expect(calls[0]?.args).toEqual([
      'logs',
      '-n',
      'catalog-dev',
      '-l',
      'app=catalog-backend',
      '--tail',
      '10',
    ]);
  });

  it('oc logs : sélecteur et conteneur validés', () => {
    expect(() => ocLogsArgs({ namespace: 'catalog-dev', selector: 'app=x;id' }, 10)).toThrow(
      EnvironmentError,
    );
    expect(() => ocLogsArgs({ namespace: 'catalog-dev', selector: 'app=x', container: '-it' }, 10)).toThrow(
      EnvironmentError,
    );
    expect(() => ocLogsArgs({ namespace: 'Bad_NS', selector: 'app=x' }, 10)).toThrow(EnvironmentError);
  });
});

describe('ARO : dépôts sous le montage', () => {
  it('lit sous le montage, refuse au-dehors (fichiers et tests)', async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'qa-incident-outside-'));
    try {
      await writeFile(path.join(outsideRoot, 'Other.java'), 'class Other {}');
      const { run, calls } = fakeRunner({ code: 0, output: '' });
      const adapter = environmentAdapter(aroConfig(), { run });
      const policy = new ScopePolicy(
        scope(
          { runTests: 'UNIT' },
          {
            applications: [
              {
                id: 'catalog-backend',
                name: 'Catalogue',
                layer: 'BACKEND',
                repository: { root: backendRoot, include: [] },
              },
              {
                id: 'elsewhere',
                name: 'Ailleurs',
                layer: 'BACKEND',
                repository: { root: outsideRoot, include: [] },
              },
            ],
          },
        ),
      );
      const files = adapter.files(policy);
      const inside = path.join(backendRoot, 'src', 'main', 'java', 'CatalogBookService.java');
      expect(await files.readText(inside)).toContain('CatalogBookService');
      await expect(files.readText(path.join(outsideRoot, 'Other.java'))).rejects.toBeInstanceOf(
        ScopeDeniedError,
      );
      expect(files.denied.map((entry) => entry.path)).toContain(path.join(outsideRoot, 'Other.java'));
      await expect(
        adapter.runTest(
          policy,
          { kind: 'RUN_TEST', level: 'UNIT', command: 'mvn', args: ['test'], cwd: outsideRoot },
          { timeoutMs: 1000, signal },
        ),
      ).rejects.toBeInstanceOf(ScopeDeniedError);
      expect(calls).toHaveLength(0);
      await adapter.runTest(
        policy,
        { kind: 'RUN_TEST', level: 'UNIT', command: 'mvn', args: ['test'], cwd: backendRoot },
        { timeoutMs: 1000, signal },
      );
      expect(calls).toHaveLength(1);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('LOCAL : les dépôts locaux, sans montage', async () => {
    const files = environmentAdapter({ target: 'LOCAL' }).files(new ScopePolicy(scope({})));
    const listed = await files.list(backendRoot, { extensions: ['.java'] });
    expect(listed).toEqual([path.join(backendRoot, 'src', 'main', 'java', 'CatalogBookService.java')]);
  });
});

describe('investigationJobManifest (ARO)', () => {
  it('Job : ServiceAccount, image, montage, non root, durée bornée, aucun secret', () => {
    const yaml = investigationJobManifest({
      config: aroConfig(),
      incidentId: 'inc_AbC123xyz789',
      command: 'mvn',
      args: ['-B', 'test', '-Dtest=CatalogBookServiceTest'],
      cwd: backendRoot,
    });
    const manifest = parse(yaml.replace(/^#.*\n/, '')) as {
      kind: string;
      metadata: { name: string; namespace: string };
      spec: {
        activeDeadlineSeconds: number;
        ttlSecondsAfterFinished: number;
        backoffLimit: number;
        template: {
          spec: {
            serviceAccountName: string;
            automountServiceAccountToken: boolean;
            securityContext: { runAsNonRoot: boolean };
            containers: {
              image: string;
              command: string[];
              args: string[];
              workingDir: string;
              resources: { limits: { cpu: string; memory: string } };
              securityContext: { allowPrivilegeEscalation: boolean; runAsNonRoot: boolean };
              volumeMounts: { name: string; mountPath: string }[];
            }[];
          };
        };
      };
    };
    expect(manifest.kind).toBe('Job');
    expect(manifest.metadata.namespace).toBe('qa-crawler');
    expect(manifest.metadata.name).toMatch(/^qa-incident-inc-abc123xyz789-[0-9a-f]{8}$/);
    expect(manifest.spec.activeDeadlineSeconds).toBe(1800);
    expect(manifest.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(manifest.spec.backoffLimit).toBe(0);
    const pod = manifest.spec.template.spec;
    expect(pod.serviceAccountName).toBe('qa-crawler-investigator');
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    const container = pod.containers[0];
    expect(container?.image).toBe('registry.example.test/qa-crawler:1.0.0');
    expect(container?.command).toEqual(['mvn']);
    expect(container?.workingDir).toBe(backendRoot);
    expect(container?.resources.limits.memory).toBeTruthy();
    expect(container?.securityContext).toMatchObject({ allowPrivilegeEscalation: false, runAsNonRoot: true });
    expect(container?.volumeMounts).toContainEqual({ name: 'repositories', mountPath: repos });
    expect(yaml).not.toMatch(/secretKeyRef|password|\btoken:/i);
  });

  it('refuse un secret en clair, un shell, un dossier hors montage, une cible non ARO', () => {
    const base = {
      config: aroConfig(),
      incidentId: 'inc_1',
      command: 'mvn',
      args: ['test'],
      cwd: backendRoot,
    };
    expect(() => investigationJobManifest({ ...base, args: ['test', '-Ddb.password=hunter2'] })).toThrow(
      /secret/,
    );
    expect(() => investigationJobManifest({ ...base, command: 'bash', args: ['-c', 'mvn test'] })).toThrow(
      EnvironmentError,
    );
    expect(() => investigationJobManifest({ ...base, cwd: '/etc' })).toThrow(
      /outside the repositories mount/,
    );
    expect(() => investigationJobManifest({ ...base, config: { target: 'LOCAL' } })).toThrow(/ARO/);
  });
});

describe('defaultProcessRunner', () => {
  it('refuse les interpréteurs de commandes et les métacaractères sans rien lancer', async () => {
    const options = { cwd: workspace, env: {}, signal, timeoutMs: 1000 };
    for (const [command, args] of [
      ['sh', ['-c', 'echo hi']],
      ['/bin/bash', ['-c', 'echo hi']],
      ['powershell', ['-Command', 'dir']],
      ['mvn', ['test;id']],
      ['npm', ['test', '$(id)']],
    ] as const) {
      const result = await defaultProcessRunner(command, args, options);
      expect(result).toMatchObject({ code: null, missing: false, timedOut: false });
      expect(result.output).toMatch(/^refused/);
    }
  });
});
