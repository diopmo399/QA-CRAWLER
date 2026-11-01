import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { environmentAdapter, type ProcessRunner } from '../../src/incident/environments.js';
import {
  javaFieldValidations,
  planExperiment,
  runExperiment,
  testCounts,
  tsFieldValidations,
  type ExperimentContext,
} from '../../src/incident/experiments.js';
import type {
  Experiment,
  ExperimentKind,
  ExecutionEnvironmentConfig,
  HttpExchange,
  Incident,
  InvestigationScope,
  ReproductionRun,
} from '../../src/incident/model.js';
import { defaultScope } from '../../src/incident/scope.js';
import { ScopePolicy } from '../../src/incident/scope-policy.js';

/**
 * L'EXPERIMENT RUNNER sur l'incident fictif du catalogue de livres : dépôts temporaires, lanceur de
 * commandes SIMULÉ (il consigne ses appels, ne lance rien) et rejeu simulé. Chaque refus est vérifié
 * sans exécution ; chaque genre de vérification produit des preuves masquées et un verdict.
 */
let workspace: string;
let frontendRoot: string;
let bffRoot: string;
let backendRoot: string;
let logs: string;

const NOW = new Date('2026-10-30T10:05:00Z');
const BASE_URL = 'http://books.example.test:8080';

const NPE_BODY = JSON.stringify({
  status: 500,
  error: 'Internal Server Error',
  path: '/api/books',
  message:
    'Catalog error: 500 : "{\\"exception\\":\\"java.lang.NullPointerException\\",\\"message\\":\\"Cannot invoke \\\\\\"org.example.catalog.books.Publisher.getName()\\\\\\" because the return value of \\\\\\"org.example.catalog.books.CatalogBook.getPublisher()\\\\\\" is null\\"}"',
});

function exchange(
  id: string,
  status: number,
  body: Record<string, unknown>,
  responseBody?: string,
): HttpExchange {
  return {
    id,
    method: 'POST',
    url: `${BASE_URL}/api/books`,
    path: '/api/books',
    status,
    resourceType: 'fetch',
    step: 4,
    correlation: 'OBSERVED',
    requestBody: JSON.stringify(body),
    ...(responseBody ? { responseBody } : {}),
  };
}

function run(
  id: string,
  reproduced: boolean | null,
  requests: HttpExchange[],
  status: ReproductionRun['status'] = 'COMPLETED',
): ReproductionRun {
  return {
    id,
    startedAt: '2026-10-30T10:00:00Z',
    finishedAt: '2026-10-30T10:00:10Z',
    status,
    target: 'LOCAL',
    baseUrl: BASE_URL,
    scenario: 'Créer un livre',
    reproduced,
    actions: [],
    requests,
    evidence: [],
    screenshots: [],
  };
}

const failingRun = (): ReproductionRun =>
  run('rep_1', true, [
    exchange(
      'req_1',
      500,
      { title: 'Le Jardin des Cartes', isbn: '978-0-00-000001-1', publisherId: '' },
      NPE_BODY,
    ),
  ]);
const passingRun = (id = 'rep_2'): ReproductionRun =>
  run(id, false, [
    exchange(
      'req_2',
      201,
      { title: 'Le Jardin des Cartes', isbn: '978-0-00-000001-1', publisherId: 12 },
      '{"id":7}',
    ),
  ]);

function incident(
  scopePatch: Partial<InvestigationScope> = {},
  execution: ExecutionEnvironmentConfig = { target: 'LOCAL' },
): Incident {
  const base = defaultScope();
  return {
    id: 'inc_test00000001',
    projectId: 'catalogue',
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après Enregistrer, erreur HTTP 500',
    observed: 'erreur HTTP 500 après Enregistrer',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'Créer un livre',
    execution,
    scope: defaultScope({
      applications: [
        {
          id: 'books-frontend',
          name: 'Frontend',
          layer: 'FRONTEND',
          repository: { root: frontendRoot, include: [] },
        },
        { id: 'books-bff', name: 'BFF', layer: 'BFF', repository: { root: bffRoot, include: [] } },
        {
          id: 'catalog-backend',
          name: 'Catalogue',
          layer: 'BACKEND',
          repository: { root: backendRoot, include: [] },
          openshift: { namespace: 'catalog-dev', selector: 'app=catalog-backend' },
        },
      ],
      allowedHosts: ['books.example.test:8080'],
      logRoots: [logs],
      ...scopePatch,
      permissions: { ...base.permissions, ...scopePatch.permissions },
      limits: { ...base.limits, ...scopePatch.limits },
    }),
    state: 'INVESTIGATING',
    revision: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    createdBy: 'tester',
    history: [],
    investigation: { reproductions: [failingRun(), passingRun()], hypotheses: [], experiments: [] },
  };
}

interface Harness {
  context: ExperimentContext;
  calls: { command: string; args: readonly string[]; cwd: string }[];
  replays: string[];
}

function harness(
  target: Incident,
  options: {
    output?: { code: number | null; output: string; timedOut?: boolean; missing?: boolean };
    replay?: (scenario: string) => Promise<ReproductionRun>;
    signal?: AbortSignal;
    policy?: ScopePolicy;
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const replays: string[] = [];
  const runner: ProcessRunner = (command, args, runOptions) => {
    calls.push({ command, args, cwd: runOptions.cwd });
    const result = options.output ?? { code: 0, output: '' };
    return Promise.resolve({ timedOut: false, missing: false, ...result });
  };
  const policy = options.policy ?? new ScopePolicy(target.scope, { execution: target.execution });
  const adapter = environmentAdapter(target.execution, { run: runner, env: { PATH: '' } });
  return {
    calls,
    replays,
    context: {
      incident: target,
      policy,
      adapter,
      files: adapter.files(policy),
      replay: (scenario) => {
        replays.push(scenario);
        return options.replay ? options.replay(scenario) : Promise.resolve(failingRun());
      },
      signal: options.signal ?? new AbortController().signal,
      actor: 'tester',
      now: () => NOW,
    },
  };
}

const plan = (kind: ExperimentKind, params: Experiment['params'] = {}): Experiment =>
  planExperiment({ kind, params, hypothesisId: 'hyp_1' }, NOW);

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-incident-exp-'));
  frontendRoot = path.join(workspace, 'frontend');
  bffRoot = path.join(workspace, 'bff');
  backendRoot = path.join(workspace, 'backend');
  logs = path.join(workspace, 'logs');
  await mkdir(path.join(frontendRoot, 'src', 'books'), { recursive: true });
  await mkdir(path.join(bffRoot, 'src', 'main', 'java', 'org', 'example', 'bff', 'books'), {
    recursive: true,
  });
  await mkdir(backendRoot, { recursive: true });
  await mkdir(logs);
  await writeFile(
    path.join(frontendRoot, 'src', 'books', 'validation.ts'),
    `import type { BookDraft } from './types';

// Vérifie le titre et l'ISBN ; publisherId n'est pas contrôlé.
export function validateBook(book: BookDraft): string[] {
  const errors: string[] = [];
  if (!book.title.trim()) errors.push('title');
  if (!/^[0-9-]{10,17}$/.test(book.isbn)) errors.push('isbn');
  return errors;
}

export function saveBook(book: BookDraft): void {
  validateBook(book);
  send({ publisherId: book.publisherId });
}
`,
  );
  await writeFile(
    path.join(bffRoot, 'src', 'main', 'java', 'org', 'example', 'bff', 'books', 'CreateBookRequest.java'),
    `package org.example.bff.books;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** publisherId : aucune contrainte. */
public record CreateBookRequest(
    @NotBlank @Size(min = 1, max = 200) String title,
    @NotBlank String isbn,
    Long publisherId) {
}
`,
  );
  await writeFile(path.join(bffRoot, '.env'), 'CATALOG_PASSWORD=hunter2\n');
  await writeFile(path.join(backendRoot, 'pom.xml'), '<project/>');
  await writeFile(
    path.join(logs, 'catalog.log'),
    [
      '2026-10-29T08:00:00Z ERROR java.lang.NullPointerException (older)',
      '2026-10-30T10:00:04Z INFO POST /catalog/books token=abcdef123456',
      '2026-10-30T10:00:05Z ERROR Request processing failed: java.lang.NullPointerException',
      '\tat org.example.catalog.books.CatalogBookService.register(CatalogBookService.java:42)',
      '2026-10-30T10:00:06Z INFO done',
    ].join('\n') + '\n',
  );
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('planExperiment', () => {
  it('propose sans effet de bord, exige une approbation sinon', () => {
    const replay = plan('REPLAY');
    expect(replay.id).toMatch(/^exp_/);
    expect(replay).toMatchObject({
      status: 'PROPOSED',
      sideEffects: false,
      hypothesisId: 'hyp_1',
      decisions: [],
      evidence: [],
    });
    expect(replay.description).toBeTruthy();
    expect(plan('INTEGRATION_TEST')).toMatchObject({ status: 'APPROVAL_REQUIRED', sideEffects: true });
    expect(plan('UNIT_TEST', { sideEffects: true })).toMatchObject({
      status: 'APPROVAL_REQUIRED',
      sideEffects: true,
    });
    expect(plan('REPLAY').id).not.toBe(replay.id);
  });
});

describe('REPLAY', () => {
  it('SUPPORTS quand le symptôme se reproduit, REFUTES sinon, NEUTRAL sans résultat', async () => {
    const target = incident();
    const supports = harness(target);
    const done = await runExperiment(plan('REPLAY'), supports.context);
    expect(done).toMatchObject({ status: 'DONE', outcome: 'SUPPORTS' });
    expect(supports.replays).toEqual(['Créer un livre']);
    expect(done.decisions.map((decision) => decision.operation.kind)).toEqual(['NAVIGATE']);
    expect(done.evidence[0]).toMatchObject({
      kind: 'EXPERIMENT',
      source: { experiment: done.id, reproduction: 'rep_1' },
    });

    const refutes = await runExperiment(
      plan('REPLAY'),
      harness(target, { replay: () => Promise.resolve(passingRun('rep_3')) }).context,
    );
    expect(refutes.outcome).toBe('REFUTES');
    const neutral = await runExperiment(
      plan('REPLAY', { scenario: 'Créer un livre (variante)' }),
      harness(target, { replay: () => Promise.resolve(run('rep_4', null, [], 'FAILED')) }).context,
    );
    expect(neutral.outcome).toBe('NEUTRAL');
  });

  it('REFUSED quand l’hôte n’est pas dans le périmètre : rien n’est rejoué', async () => {
    const target = incident({ allowedHosts: [] });
    const h = harness(target);
    const done = await runExperiment(plan('REPLAY'), h.context);
    expect(done.status).toBe('REFUSED');
    expect(done.decisions[0]?.allowed).toBe(false);
    expect(done.summary).toMatch(/refus du périmètre/);
    expect(h.replays).toEqual([]);
  });

  it('CANCELLED à l’arrêt, ERROR à la limite de durée', async () => {
    const controller = new AbortController();
    const cancelled = runExperiment(
      plan('REPLAY'),
      harness(incident(), {
        signal: controller.signal,
        replay: () => new Promise<ReproductionRun>(() => undefined),
      }).context,
    );
    controller.abort();
    expect((await cancelled).status).toBe('CANCELLED');
    const slow = await runExperiment(
      plan('REPLAY'),
      harness(incident({ limits: { ...defaultScope().limits, maxDurationMs: 30 } }), {
        replay: () => new Promise<ReproductionRun>(() => undefined),
      }).context,
    );
    expect(slow).toMatchObject({ status: 'ERROR' });
    expect(slow.summary).toMatch(/limite de durée/);
  });
});

describe('COMPARE_REQUESTS / COMPARE_RESPONSES', () => {
  it('champ manquant côté échec : SUPPORTS, sans recopier les valeurs', async () => {
    const done = await runExperiment(
      plan('COMPARE_REQUESTS', { left: 'rep_1', right: 'rep_2', expectMissingField: 'publisherId' }),
      harness(incident()).context,
    );
    expect(done).toMatchObject({ status: 'DONE', outcome: 'SUPPORTS' });
    expect(done.summary).toMatch(/publisherId manque dans la requête en échec \(chaîne vide\)/);
    const text = JSON.stringify(done.evidence);
    expect(text).toContain('publisherId');
    expect(text).not.toContain('Le Jardin des Cartes');
    expect(text).not.toContain('978-0-00-000001-1');
  });

  it('champ présent des deux côtés : REFUTES ; sans attente, la différence explique l’échec', async () => {
    const target = incident();
    const refutes = await runExperiment(
      plan('COMPARE_REQUESTS', { left: 'rep_1', right: 'rep_2', expectMissingField: 'title' }),
      harness(target).context,
    );
    expect(refutes.outcome).toBe('REFUTES');
    const implicit = await runExperiment(
      plan('COMPARE_REQUESTS', { left: 'rep_2', right: 'rep_1', endpoint: 'POST /api/books' }),
      harness(target).context,
    );
    expect(implicit.outcome).toBe('SUPPORTS');
    expect(implicit.summary).toMatch(/diffère sur publisherId \(chaîne vide \/ nombre\)/);
  });

  it('réponses : message et exception de la réponse en échec', async () => {
    const done = await runExperiment(
      plan('COMPARE_RESPONSES', { left: 'rep_1', right: 'rep_2', expectMessage: 'NullPointerException' }),
      harness(incident()).context,
    );
    expect(done.outcome).toBe('SUPPORTS');
    expect(JSON.stringify(done.evidence)).toContain('java.lang.NullPointerException');
    const status = await runExperiment(
      plan('COMPARE_RESPONSES', { left: 'rep_1', right: 'rep_2', expectStatus: 400 }),
      harness(incident()).context,
    );
    expect(status.outcome).toBe('REFUTES');
  });

  it('reproduction inconnue : ERROR', async () => {
    const done = await runExperiment(
      plan('COMPARE_REQUESTS', { left: 'rep_1', right: 'rep_9' }),
      harness(incident()).context,
    );
    expect(done.status).toBe('ERROR');
    expect(done.summary).toMatch(/rep_9 not found/);
  });
});

describe('COMPARE_WITH_PASSING', () => {
  it('SUPPORTS : le scénario qui réussit envoie le champ absent de l’échec', async () => {
    const h = harness(incident(), { replay: () => Promise.resolve(passingRun('rep_3')) });
    const done = await runExperiment(
      plan('COMPARE_WITH_PASSING', { passingScenario: 'Créer un livre avec éditeur' }),
      h.context,
    );
    expect(h.replays).toEqual(['Créer un livre avec éditeur']);
    expect(done.outcome).toBe('SUPPORTS');
    expect(done.summary).toMatch(/publisherId/);
    const withField = await runExperiment(
      plan('COMPARE_WITH_PASSING', { passingScenario: 'Créer un livre avec éditeur', field: 'publisherId' }),
      harness(incident(), { replay: () => Promise.resolve(passingRun('rep_3')) }).context,
    );
    expect(withField.outcome).toBe('SUPPORTS');
  });

  it('NEUTRAL quand le scénario de référence échoue aussi', async () => {
    const done = await runExperiment(
      plan('COMPARE_WITH_PASSING', { passingScenario: 'Créer un livre avec éditeur' }),
      harness(incident(), {
        replay: () => Promise.resolve({ ...failingRun(), id: 'rep_3' }),
      }).context,
    );
    expect(done.outcome).toBe('NEUTRAL');
  });
});

describe('UNIT_TEST / INTEGRATION_TEST', () => {
  const surefireFailure = [
    '[INFO] Running org.example.catalog.books.CatalogBookServiceTest',
    '[ERROR] registerWithoutPublisher  Time elapsed: 0.02 s  <<< ERROR!',
    'java.lang.NullPointerException: Cannot invoke "Publisher.getName()"',
    '[ERROR] Tests run: 2, Failures: 0, Errors: 1, Skipped: 0',
    '[INFO] BUILD FAILURE',
  ].join('\n');

  it('refusé par le périmètre (runTests NONE) : rien n’est lancé', async () => {
    const h = harness(incident());
    const done = await runExperiment(
      plan('UNIT_TEST', { applicationId: 'catalog-backend', test: 'CatalogBookServiceTest' }),
      h.context,
    );
    expect(done.status).toBe('REFUSED');
    expect(done.decisions[0]).toMatchObject({ allowed: false, operation: { kind: 'RUN_TEST' } });
    expect(h.calls).toEqual([]);
  });

  it('refuse des arguments dangereux', async () => {
    const h = harness(incident({ permissions: { ...defaultScope().permissions, runTests: 'UNIT' } }));
    const done = await runExperiment(
      plan('UNIT_TEST', { applicationId: 'catalog-backend', command: 'mvn', args: ['test', '-Dx=`id`'] }),
      h.context,
    );
    expect(done.status).toBe('REFUSED');
    expect(h.calls).toEqual([]);
  });

  it('SUPPORTS : le test attendu en échec échoue avec l’exception recherchée', async () => {
    const target = incident({ permissions: { ...defaultScope().permissions, runTests: 'UNIT' } });
    const h = harness(target, { output: { code: 1, output: surefireFailure } });
    const done = await runExperiment(
      plan('UNIT_TEST', {
        applicationId: 'catalog-backend',
        test: 'CatalogBookServiceTest',
        expect: 'fail',
        patterns: ['NullPointerException'],
      }),
      h.context,
    );
    expect(h.calls).toEqual([
      { command: 'mvn', args: ['-B', 'test', '-Dtest=CatalogBookServiceTest'], cwd: backendRoot },
    ]);
    expect(done).toMatchObject({ status: 'DONE', outcome: 'SUPPORTS' });
    expect(done.evidence[0]?.data).toMatchObject({ code: 1, counts: { run: 2, failed: 1 } });
  });

  it('REFUTES quand le test passe, NEUTRAL sur une erreur de compilation, ERROR sans outil', async () => {
    const target = incident({ permissions: { ...defaultScope().permissions, runTests: 'UNIT' } });
    const params = { applicationId: 'catalog-backend', test: 'CatalogBookServiceTest' };
    const passed = await runExperiment(
      plan('UNIT_TEST', params),
      harness(target, { output: { code: 0, output: 'Tests run: 2, Failures: 0, Errors: 0, Skipped: 0' } })
        .context,
    );
    expect(passed.outcome).toBe('REFUTES');
    const compile = await runExperiment(
      plan('UNIT_TEST', params),
      harness(target, { output: { code: 1, output: '[ERROR] COMPILATION ERROR' } }).context,
    );
    expect(compile.outcome).toBe('NEUTRAL');
    const missing = await runExperiment(
      plan('UNIT_TEST', params),
      harness(target, { output: { code: null, output: 'spawn mvn ENOENT', missing: true } }).context,
    );
    expect(missing.status).toBe('ERROR');
  });

  it('frontend : npm test par défaut', async () => {
    const target = incident({ permissions: { ...defaultScope().permissions, runTests: 'UNIT' } });
    const h = harness(target, { output: { code: 0, output: ' Tests  3 passed (3)' } });
    const done = await runExperiment(
      plan('UNIT_TEST', { applicationId: 'books-frontend', expect: 'pass' }),
      h.context,
    );
    expect(h.calls[0]).toMatchObject({ command: 'npm', args: ['test'], cwd: frontendRoot });
    expect(done.outcome).toBe('SUPPORTS');
  });

  it('INTEGRATION_TEST : approbation, sideEffects, environnement non production', async () => {
    const permissions = { ...defaultScope().permissions, runTests: 'INTEGRATION' as const };
    const params = { applicationId: 'catalog-backend', test: 'CatalogBookIT', environmentKind: 'DEV' };
    const allowed = incident({ permissions: { ...permissions, sideEffects: true } });

    const notApproved = harness(allowed);
    const refused = await runExperiment(plan('INTEGRATION_TEST', params), notApproved.context);
    expect(refused.status).toBe('REFUSED');
    expect(refused.summary).toMatch(/approbation explicite/);

    const noPermission = harness(incident({ permissions: { ...permissions, sideEffects: false } }));
    const refusedScope = await runExperiment(plan('INTEGRATION_TEST', params), noPermission.context, {
      approvedBy: 'lead',
    });
    expect(refusedScope.status).toBe('REFUSED');

    const production = await runExperiment(
      plan('INTEGRATION_TEST', { ...params, environmentKind: 'PRODUCTION' }),
      harness(allowed).context,
      { approvedBy: 'lead' },
    );
    expect(production.status).toBe('REFUSED');
    expect(production.summary).toMatch(/PRODUCTION/);
    const unknownKind = await runExperiment(
      plan('INTEGRATION_TEST', { applicationId: 'catalog-backend', test: 'CatalogBookIT' }),
      harness(allowed).context,
      { approvedBy: 'lead' },
    );
    expect(unknownKind.status).toBe('REFUSED');
    expect(notApproved.calls.length + noPermission.calls.length).toBe(0);

    const ok = harness(allowed, {
      output: { code: 1, output: 'Tests run: 1, Failures: 1, Errors: 0, Skipped: 0' },
    });
    const done = await runExperiment(plan('INTEGRATION_TEST', params), ok.context, { approvedBy: 'lead' });
    expect(done).toMatchObject({
      status: 'DONE',
      outcome: 'SUPPORTS',
      approvedBy: 'lead',
      sideEffects: true,
    });
    expect(ok.calls).toHaveLength(1);
  });

  it('budget des vérifications épuisé : REFUSED, rien n’est lancé', async () => {
    const target = incident({
      permissions: { ...defaultScope().permissions, runTests: 'UNIT' },
      limits: { ...defaultScope().limits, maxExperiments: 1 },
    });
    const policy = new ScopePolicy(target.scope);
    const first = harness(target, {
      policy,
      output: { code: 0, output: 'Tests run: 1, Failures: 0, Errors: 0' },
    });
    expect(
      (await runExperiment(plan('UNIT_TEST', { applicationId: 'catalog-backend' }), first.context)).status,
    ).toBe('DONE');
    const second = harness(target, { policy });
    const done = await runExperiment(plan('UNIT_TEST', { applicationId: 'catalog-backend' }), second.context);
    expect(done.status).toBe('REFUSED');
    expect(done.summary).toMatch(/budget des vérifications épuisé/);
    expect(second.calls).toEqual([]);
  });

  it('testCounts lit Surefire, Vitest et Jest', () => {
    expect(testCounts('Tests run: 5, Failures: 1, Errors: 1, Skipped: 0')).toEqual({
      run: 5,
      failed: 2,
      passed: 3,
    });
    expect(testCounts(' Tests  1 failed | 4 passed (5)')).toEqual({ run: 5, failed: 1, passed: 4 });
    expect(testCounts('Tests:       2 failed, 3 passed, 5 total')).toEqual({ run: 5, failed: 2, passed: 3 });
    expect(testCounts('BUILD FAILURE')).toBeUndefined();
  });
});

describe('INSPECT_LOGS', () => {
  it('fichier : SUPPORTS dans la fenêtre de la reproduction, lignes masquées', async () => {
    const target = incident({ permissions: { ...defaultScope().permissions, readLogs: true } });
    const done = await runExperiment(
      plan('INSPECT_LOGS', {
        path: path.join(logs, 'catalog.log'),
        patterns: ['NullPointerException', 'CatalogBookService'],
      }),
      harness(target).context,
    );
    expect(done).toMatchObject({ status: 'DONE', outcome: 'SUPPORTS' });
    const lines = done.evidence.filter((evidence) => evidence.kind === 'LOG_LINE');
    expect(lines).toHaveLength(2);
    expect(lines[1]?.summary).toContain('CatalogBookService.register');
    const summary = done.evidence.find((evidence) => evidence.kind === 'EXPERIMENT');
    expect(summary?.data).toMatchObject({ matches: 2, outsideWindow: 1 });
    expect(JSON.stringify(done.evidence)).not.toContain('abcdef123456');
  });

  it('motifs par défaut tirés de la réponse en erreur ; hors fenêtre : NEUTRAL', async () => {
    const target = incident({ permissions: { ...defaultScope().permissions, readLogs: true } });
    const byDefault = await runExperiment(
      plan('INSPECT_LOGS', { path: path.join(logs, 'catalog.log') }),
      harness(target).context,
    );
    expect(byDefault.outcome).toBe('SUPPORTS');
    expect(byDefault.evidence.find((evidence) => evidence.kind === 'EXPERIMENT')?.data).toMatchObject({
      patterns: ['NullPointerException'],
    });
    const later = await runExperiment(
      plan('INSPECT_LOGS', {
        path: path.join(logs, 'catalog.log'),
        patterns: ['NullPointerException'],
        since: '2026-10-31T00:00:00Z',
      }),
      harness(target).context,
    );
    expect(later.outcome).toBe('NEUTRAL');
  });

  it('refusé sans readLogs : rien n’est lu', async () => {
    const done = await runExperiment(
      plan('INSPECT_LOGS', { path: path.join(logs, 'catalog.log'), patterns: ['NullPointerException'] }),
      harness(incident()).context,
    );
    expect(done.status).toBe('REFUSED');
    expect(done.evidence).toEqual([]);
  });

  it('OpenShift (REMOTE) : oc logs avec --since calculé depuis la reproduction', async () => {
    const target = incident(
      { permissions: { ...defaultScope().permissions, openshift: 'READ' } },
      { target: 'REMOTE', remote: { openshift: { namespace: 'catalog-dev' } } },
    );
    const h = harness(target, {
      output: { code: 0, output: '2026-10-30T10:00:05Z ERROR java.lang.NullPointerException\n' },
    });
    const done = await runExperiment(
      plan('INSPECT_LOGS', { applicationId: 'catalog-backend', patterns: ['NullPointerException'] }),
      h.context,
    );
    expect(h.calls[0]?.command).toBe('oc');
    expect(h.calls[0]?.args).toEqual([
      'logs',
      '-n',
      'catalog-dev',
      '-l',
      'app=catalog-backend',
      '--tail',
      '2000',
      '--since=480s',
    ]);
    expect(done.outcome).toBe('SUPPORTS');
    expect(done.decisions[0]).toMatchObject({
      allowed: true,
      operation: { kind: 'OPENSHIFT', verb: 'logs' },
    });
  });

  it('OpenShift en LOCAL sans connexion : REFUSED, rien n’est lancé', async () => {
    const target = incident({ permissions: { ...defaultScope().permissions, openshift: 'READ' } });
    const h = harness(target);
    const done = await runExperiment(
      plan('INSPECT_LOGS', { applicationId: 'catalog-backend', patterns: ['x'] }),
      h.context,
    );
    expect(done.status).toBe('REFUSED');
    expect(done.summary).toMatch(/no OpenShift connection/);
    expect(h.calls).toEqual([]);
  });
});

describe('CHECK_VALIDATION', () => {
  const javaFile = (): string =>
    path.join(bffRoot, 'src', 'main', 'java', 'org', 'example', 'bff', 'books', 'CreateBookRequest.java');

  it('Java : publisherId sans contrainte → SUPPORTS ; title @NotBlank → REFUTES', async () => {
    const missing = await runExperiment(
      plan('CHECK_VALIDATION', {
        applicationId: 'books-bff',
        file: path.relative(bffRoot, javaFile()),
        field: 'publisherId',
      }),
      harness(incident()).context,
    );
    expect(missing).toMatchObject({ status: 'DONE', outcome: 'SUPPORTS' });
    expect(missing.evidence[0]).toMatchObject({
      kind: 'CODE',
      source: { file: 'src/main/java/org/example/bff/books/CreateBookRequest.java', line: 10 },
    });
    const present = await runExperiment(
      plan('CHECK_VALIDATION', { file: javaFile(), field: 'title' }),
      harness(incident()).context,
    );
    expect(present.outcome).toBe('REFUTES');
    expect(present.summary).toMatch(/@NotBlank, title validé|@NotBlank/);
  });

  it('TypeScript : validateBook ne contrôle pas publisherId', async () => {
    const file = path.join(frontendRoot, 'src', 'books', 'validation.ts');
    const missing = await runExperiment(
      plan('CHECK_VALIDATION', { file, field: 'publisherId' }),
      harness(incident()).context,
    );
    expect(missing.outcome).toBe('SUPPORTS');
    const present = await runExperiment(
      plan('CHECK_VALIDATION', { file, field: 'title', expect: 'missing' }),
      harness(incident()).context,
    );
    expect(present.outcome).toBe('REFUTES');
    expect(present.summary).toMatch(/validateBook\(\) vérifie title/);
  });

  it('fichier sensible ou hors du périmètre : REFUSED ; paramètres manquants : ERROR', async () => {
    const sensitive = await runExperiment(
      plan('CHECK_VALIDATION', { file: path.join(bffRoot, '.env'), field: 'x' }),
      harness(incident()).context,
    );
    expect(sensitive.status).toBe('REFUSED');
    const outside = await runExperiment(
      plan('CHECK_VALIDATION', { file: '/etc/hostname', field: 'x' }),
      harness(incident()).context,
    );
    expect(outside.status).toBe('REFUSED');
    const traversal = await runExperiment(
      plan('CHECK_VALIDATION', {
        applicationId: 'books-bff',
        file: '../frontend/src/books/validation.ts',
        field: 'x',
      }),
      harness(incident()).context,
    );
    expect(traversal.status).toBe('ERROR');
    const noFile = await runExperiment(plan('CHECK_VALIDATION', { field: 'x' }), harness(incident()).context);
    expect(noFile.status).toBe('ERROR');
  });

  it('analyse Java : déclarations seulement, annotations avec arguments', () => {
    const source = `class CatalogBook {
  @NotNull(message = "requis") @Column(name = "publisher_id")
  private Long publisherId;
  private String note = "publisherId;";
  void apply(Long other) { this.publisherId = other; use(publisherId); }
  Long publisherId() { return publisherId; }
}`;
    expect(javaFieldValidations(source, 'publisherId')).toEqual([
      { line: 3, annotations: ['NotNull', 'Column'] },
    ]);
  });

  it('analyse TS : schémas zod et appels ignorés', () => {
    const source = `const schema = z.object({ title: z.string().min(1), publisherId: z.number().optional() });
validateBook(book);
const isValidIsbn = (value: string): boolean => /^[0-9-]+$/.test(value);`;
    expect(tsFieldValidations(source, 'title')).toHaveLength(1);
    expect(tsFieldValidations(source, 'publisherId')).toEqual([]);
  });
});
