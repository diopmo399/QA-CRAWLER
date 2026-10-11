import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { IntelligenceRequest } from '../../src/ai/model.js';
import { parseManifestArgs } from '../../src/cli/manifest-command.js';
import { InMemoryPersistenceProvider } from '../../src/persistence/memory/in-memory-provider.js';
import { adviseOnAmbiguities, ambiguousAnomalies } from '../../src/platform/ambiguity-advisor.js';
import { jobConfig, jobsPerActor, runExplorationJobs } from '../../src/platform/exploration-jobs.js';
import { flowMemoryRecordsOf, rememberRun } from '../../src/platform/flow-memory.js';
import { renderQaJobManifest } from '../../src/platform/kubernetes-manifest.js';
import type { RunAnomaly } from '../../src/platform/model.js';
import {
  GitHubPullRequestReporter,
  PR_COMMENT_MARKER,
  renderPullRequestComment,
} from '../../src/platform/pull-request-reporter.js';
import { buildRunWorkflowAnalysis } from '../../src/platform/run-workflow-analysis.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';
import { flow, result, step } from '../fixtures/qa-platform-results.js';

/**
 * QA PLATFORM — phases 12 à 17 : la mémoire des flows par sorte (sans SQL dans le métier), les jobs
 * d'exploration isolés et parallèles, le manifeste Kubernetes (secrets par référence), le
 * commentaire de pull request (créé puis mis à jour, jeton jamais exposé) et le conseiller
 * d'ambiguïté (désactivé, indisponible, rejeté, avis).
 */
const failing = () =>
  result([
    flow('create-item', [
      step(1, 'click Items', { stateId: 'S1' }),
      step(2, 'click Save', { stateId: 'S2', status: 'FAILED', reason: 'something odd happened' }),
    ]),
  ]);

describe('QA platform — flow memory', () => {
  it('one record per element and kind, searchable by kind, status and prefix through any provider', async () => {
    const report = buildRunWorkflowAnalysis(failing());
    const records = flowMemoryRecordsOf({ applicationId: 'app', result: failing(), report });
    const kinds = [...new Set(records.map((record) => record.kind))].sort();
    expect(kinds).toEqual(['action', 'anomaly', 'performance', 'run', 'state', 'transition']);
    expect(records.find((record) => record.kind === 'run')).toMatchObject({ key: 'run-1', status: 'FAIL' });
    expect(records.filter((record) => record.kind === 'anomaly')[0]).toMatchObject({
      key: 'UNKNOWN_FAILURE|create-item|2',
      data: { symptom: expect.stringContaining('step 2') as string, severity: 'ERROR' },
    });
    expect(JSON.stringify(records)).not.toMatch(/password|cookie|token/i);
    const provider = new InMemoryPersistenceProvider();
    await provider.initialize();
    expect(await rememberRun(provider.memory, { applicationId: 'app', result: failing(), report })).toBe(
      records.length,
    );
    expect((await provider.memory.search({ applicationId: 'app', kind: 'anomaly', limit: 10 })).length).toBe(
      1,
    );
    expect(
      (
        await provider.memory.search({
          applicationId: 'app',
          kind: 'action',
          keyPrefix: 'create-item|2',
          limit: 10,
        })
      ).length,
    ).toBe(1);
    expect(await rememberRun(undefined, { applicationId: 'app', result: failing(), report })).toBe(0);
  });
});

describe('QA platform — parallel exploration jobs', () => {
  const { config } = parseConfig(
    `mission: { name: jobs }
target: { baseUrl: http://app.test, startAt: / }
output: { reportsDir: out/reports, screenshotsDir: out/shots }
actors:
  - name: reader
    auth: { type: form, loginUrl: /login, usernameSelector: '#u', passwordSelector: '#p', submitSelector: '#s', usernameEnv: READER_USER, passwordEnv: READER_PASSWORD }
flows:
  - name: a
    steps: [{ click: { role: button, name: A } }]
  - name: b
    steps: [{ click: { role: button, name: B } }]
`,
    {},
    {},
  );

  it('each job gets isolated outputs, its actor as the primary login and its own flows', () => {
    const reader = jobConfig(config, { id: 'reader', actor: 'reader', flows: ['b'] });
    expect(reader.auth.type).toBe('form');
    expect(reader.flows.map((entry) => entry.name)).toEqual(['b']);
    expect(reader.actors).toEqual([]);
    expect(reader.authorization.primaryActor).toBe('reader');
    expect(reader.output.reportsDir).toMatch(/out[\\/]reports[\\/]reader$/);
    expect(reader.memory.file).toMatch(/reader[\\/]flow-graph\.json$/);
    expect(config.output.reportsDir).toBe('out/reports');
    expect(() => jobConfig(config, { id: 'x', actor: 'nobody' })).toThrow(/unknown actor/);
    expect(() => jobConfig(config, { id: 'x', flows: ['zzz'] })).toThrow(/unknown flow/);
    expect(jobsPerActor(config).map((job) => job.id)).toEqual(['primary', 'reader']);
  });

  it('jobs run concurrently (bounded), each in its own run, and the worst status wins', async () => {
    let running = 0;
    let peak = 0;
    const report = await runExplorationJobs(config, jobsPerActor(config), {
      concurrency: 2,
      runner: async (derived) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        if (derived.authorization.primaryActor === 'reader') throw new Error('browser crashed');
        const outcome = result([flow('a', [step(1, 'click A')])]);
        outcome.workflowAnalysis = buildRunWorkflowAnalysis(outcome);
        return { result: outcome, failingIssues: [], regressions: 0, passed: true };
      },
    });
    expect(peak).toBe(2);
    expect(report.jobs.map((job) => [job.id, job.status, job.overallStatus ?? job.error])).toEqual([
      ['primary', 'COMPLETED', 'PASS'],
      ['reader', 'FAILED', 'browser crashed'],
    ]);
    expect(report.overallStatus).toBe('FAIL');
  });
});

describe('QA platform — Kubernetes manifest', () => {
  it('renders a Job with the mission ConfigMap, secrets by reference, resources and volumes', () => {
    const manifest = renderQaJobManifest({
      name: 'qa-nightly',
      namespace: 'qa',
      image: 'registry.example.test/qa-crawler:1.0',
      mission: { configMap: 'qa-missions', file: 'shop.yaml' },
      command: 'verify',
      baseUrl: 'https://shop.example.test',
      secrets: [
        { env: 'QA_USERNAME', secretName: 'qa-credentials', key: 'username' },
        { env: 'QA_PASSWORD', secretName: 'qa-credentials', key: 'password' },
      ],
      env: { QA_ENVIRONMENT: 'staging' },
      reports: { claimName: 'qa-reports' },
      parallelism: 2,
    });
    expect(manifest).toContain('kind: Job');
    expect(manifest).toContain('namespace: qa');
    expect(manifest).toContain('secretKeyRef');
    expect(manifest).toContain('name: qa-credentials');
    expect(manifest).toContain('claimName: qa-reports');
    expect(manifest).toContain('completionMode: Indexed');
    expect(manifest).toContain('QA_JOB_INDEX');
    expect(manifest).toContain('- verify');
    expect(manifest).toContain('/missions/shop.yaml');
    expect(manifest).not.toMatch(/value: .*(secret|password)/i);
    const cron = renderQaJobManifest({
      name: 'n',
      image: 'i',
      mission: { configMap: 'c', file: 'm.yaml' },
      secrets: [],
      schedule: '0 3 * * *',
    });
    expect(cron).toContain('kind: CronJob');
    expect(cron).toContain('schedule: 0 3 * * *');
    expect(() =>
      renderQaJobManifest({
        name: 'n',
        image: 'i',
        mission: { configMap: 'c', file: 'm.yaml' },
        secrets: [],
        env: { QA_PASSWORD: 'hunter' },
      }),
    ).toThrow(/looks like a secret/);
  });

  it('the CLI parses its flags and refuses malformed secrets', () => {
    const args = parseManifestArgs([
      '--name',
      'job',
      '--image',
      'img',
      '--config-map',
      'cm',
      '--mission',
      'm.yaml',
      '--secret',
      'QA_PASSWORD=qa-credentials/password',
      '--env',
      'QA_ENVIRONMENT=staging',
      '--parallelism',
      '3',
      '--out',
      'job.yaml',
    ]);
    expect(args.options).toMatchObject({
      name: 'job',
      parallelism: 3,
      env: { QA_ENVIRONMENT: 'staging' },
      secrets: [{ env: 'QA_PASSWORD', secretName: 'qa-credentials', key: 'password' }],
    });
    expect(args.out).toBe('job.yaml');
    expect(() => parseManifestArgs(['--name', 'job'])).toThrow(/--image is required/);
    expect(() =>
      parseManifestArgs([
        '--name',
        'j',
        '--image',
        'i',
        '--config-map',
        'c',
        '--mission',
        'm',
        '--secret',
        'oops',
      ]),
    ).toThrow(/ENV=secretName\/key/);
  });
});

describe('QA platform — pull request reporter', () => {
  const comment = () =>
    renderPullRequestComment({ result: failing(), report: buildRunWorkflowAnalysis(failing()) });

  it('renders the structured result as a deterministic Markdown comment with its marker', () => {
    const text = comment();
    expect(text.startsWith(PR_COMMENT_MARKER)).toBe(true);
    expect(text).toContain('QA-CRAWLER — FAIL');
    expect(text).toContain('| UNKNOWN_FAILURE | create-item step 2 |');
    expect(text).toContain('blocking defect');
    expect(comment()).toBe(text);
  });

  it('creates the comment, then updates the existing one; a missing token or a refused call never throws', async () => {
    const calls: { url: string; method: string; auth: string | undefined; body?: string }[] = [];
    let existing: { id: number; body: string }[] = [];
    const fakeFetch = ((url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        auth: headers?.Authorization,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if ((init?.method ?? 'GET') === 'GET')
        return Promise.resolve(new Response(JSON.stringify(existing), { status: 200 }));
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { body: string };
      const id = init?.method === 'PATCH' ? Number(url.split('/').pop()) : 42;
      existing = [{ id, body: body.body }];
      return Promise.resolve(
        new Response(JSON.stringify({ id, html_url: `https://github.example.test/c/${String(id)}` }), {
          status: init?.method === 'POST' ? 201 : 200,
        }),
      );
    }) as unknown as typeof fetch;
    const reporter = new GitHubPullRequestReporter({
      owner: 'o',
      repo: 'r',
      pullNumber: 7,
      tokenEnv: 'QA_GH_TOKEN',
      env: { QA_GH_TOKEN: 'tok-secret' },
      fetch: fakeFetch,
    });
    expect(await reporter.publish(comment())).toEqual({
      posted: true,
      action: 'created',
      url: 'https://github.example.test/c/42',
    });
    expect(await reporter.publish(comment())).toEqual({
      posted: true,
      action: 'updated',
      url: 'https://github.example.test/c/42',
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET', 'PATCH']);
    expect(calls.every((call) => call.auth === 'Bearer tok-secret' && !call.url.includes('tok-secret'))).toBe(
      true,
    );
    const noToken = new GitHubPullRequestReporter({
      owner: 'o',
      repo: 'r',
      pullNumber: 7,
      tokenEnv: 'QA_GH_TOKEN',
      env: {},
      fetch: fakeFetch,
    });
    expect(await noToken.publish(comment())).toMatchObject({
      posted: false,
      action: 'skipped',
      reason: expect.stringContaining('QA_GH_TOKEN') as string,
    });
    const refused = new GitHubPullRequestReporter({
      owner: 'o',
      repo: 'r',
      pullNumber: 7,
      tokenEnv: 'T',
      env: { T: 'x' },
      fetch: () => Promise.resolve(new Response('', { status: 403 })),
    });
    expect(await refused.publish(comment())).toMatchObject({
      posted: false,
      reason: expect.stringContaining('403') as string,
    });
    const broken = new GitHubPullRequestReporter({
      owner: 'o',
      repo: 'r',
      pullNumber: 7,
      tokenEnv: 'T',
      env: { T: 'x' },
      fetch: () => Promise.reject(new Error('ECONNRESET')),
    });
    const outcome = await broken.publish(comment());
    expect(outcome.posted).toBe(false);
    expect(outcome.reason).not.toContain('x');
  });
});

describe('QA platform — ambiguity advisor (LLM as adviser, never executor)', () => {
  const anomaly = (category: RunAnomaly['category'], confidence: number): RunAnomaly => ({
    id: `A-${category}`,
    category,
    severity: 'ERROR',
    symptom: `step failed with ${category}`,
    evidence: ['reason: odd', 'password=secret-value-1234'],
    confidence,
    source: 'RUNTIME',
    location: { flow: 'f', step: 2 },
    issueIds: [],
  });
  const options = {
    enabled: true,
    maxCalls: 5,
    minConfidence: 0.5,
    timeoutMs: 1000,
    secretValues: ['secret-value-1234'],
  };

  it('only unexplained or low-confidence anomalies are consulted; LLM disabled → DISABLED, nothing sent', async () => {
    const anomalies = [
      anomaly('UNKNOWN_FAILURE', 0.3),
      anomaly('API_FAILURE', 0.9),
      anomaly('UI_FAILURE', 0.4),
    ];
    expect(ambiguousAnomalies(anomalies, 0.5).map((entry) => entry.category)).toEqual([
      'UNKNOWN_FAILURE',
      'UI_FAILURE',
    ]);
    const provider = new FakeIntelligenceProvider(() => ({}));
    const summary = await adviseOnAmbiguities(anomalies, provider, { ...options, enabled: false });
    expect(summary).toMatchObject({ mode: 'DISABLED', consulted: 0 });
    expect(provider.requests).toHaveLength(0);
    expect(anomalies[0]?.advisory?.status).toBe('DISABLED');
    expect(anomalies[1]?.advisory).toBeUndefined();
  });

  it('unavailable provider → UNAVAILABLE with its reason; the category and the verdict never change', async () => {
    const anomalies = [anomaly('UNKNOWN_FAILURE', 0.3)];
    const provider = new FakeIntelligenceProvider(() => ({}), {
      available: false,
      reason: 'SDK not installed',
    });
    expect(await adviseOnAmbiguities(anomalies, provider, options)).toMatchObject({
      mode: 'UNAVAILABLE',
      reason: 'SDK not installed',
    });
    expect(anomalies[0]).toMatchObject({
      category: 'UNKNOWN_FAILURE',
      advisory: { status: 'UNAVAILABLE', reason: 'SDK not installed' },
    });
  });

  it('a schema-conforming answer becomes an ADVISORY text; a malformed one is REJECTED; secrets never leave; the budget bounds the calls', async () => {
    const anomalies = [
      anomaly('UNKNOWN_FAILURE', 0.3),
      anomaly('UI_FAILURE', 0.2),
      anomaly('DATA_FAILURE', 0.1),
    ];
    let call = 0;
    const provider = new FakeIntelligenceProvider((request: IntelligenceRequest) => {
      call += 1;
      expect(JSON.stringify(request)).not.toContain('secret-value-1234');
      expect(request.availableActions).toEqual([]);
      return call === 1
        ? {
            status: 'INCONCLUSIVE',
            summary: 'the server rejected the write; the screen shows no message',
            failureCategory: 'FUNCTIONAL_FAILURE',
            nextInvestigation: 'check the response body',
            uncertainties: ['no network body captured'],
            confidence: 0.6,
          }
        : { nonsense: true };
    });
    const summary = await adviseOnAmbiguities(anomalies, provider, { ...options, maxCalls: 2 });
    expect(summary).toMatchObject({
      mode: 'ACTIVE',
      provider: 'fake',
      consulted: 2,
      advisory: 1,
      rejected: 1,
    });
    expect(anomalies[0]?.advisory).toMatchObject({
      status: 'ADVISORY',
      text: expect.stringContaining('suggested category (advice only): FUNCTIONAL_FAILURE') as string,
    });
    expect(anomalies[0]?.category).toBe('UNKNOWN_FAILURE');
    expect(anomalies[1]?.advisory).toMatchObject({ status: 'REJECTED' });
    expect(anomalies[2]?.advisory).toMatchObject({
      status: 'DISABLED',
      reason: expect.stringContaining('budget') as string,
    });
    expect(provider.requests[0]?.failure?.symptom).toContain('UNKNOWN_FAILURE');
  });
});
