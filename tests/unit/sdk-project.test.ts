import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectDraft } from '../../src/sdk/core/contracts.js';
import {
  ALWAYS_IGNORED_PATHS,
  engineDefaults,
  projectDocument,
  readProject,
  renderProjectFile,
  sourceRootAllowed,
  validateDraft,
  writeProject,
  type ProjectRules,
} from '../../src/sdk/server/project.js';

const rules: ProjectRules = { allowedSourceRoots: [], reportLanguage: 'en' };
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function draft(overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  const defaults = engineDefaults();
  return {
    project: { name: 'Demo', targetUrl: 'https://app.example.test/start?tab=1', framework: 'react' },
    environment: defaults.environment,
    exploration: { ...defaults.exploration, ignoredPaths: ['/admin'] },
    ...overrides,
  };
}

describe('SDK project draft', () => {
  it('starts from the engine defaults (budgets, timeouts, logout paths)', () => {
    const defaults = engineDefaults();
    expect(defaults.exploration).toMatchObject({
      maxStates: 100,
      maxActions: 500,
      maxDurationMinutes: 15,
      maxDepth: 10,
    });
    expect(defaults.environment).toMatchObject({ actionTimeoutMs: 10_000, navigationTimeoutMs: 15_000 });
    expect(defaults.exploration.ignoredPaths).toEqual(expect.arrayContaining(['/logout']));
  });

  it('becomes a project file in the engine format: origin + start path, budgets, merged exclusions', () => {
    const document = projectDocument(draft(), rules) as {
      qaCrawler: Record<string, Record<string, unknown>>;
    };
    const project = document.qaCrawler;
    expect(project.application).toMatchObject({
      baseUrl: 'https://app.example.test',
      startAt: '/start?tab=1',
      framework: 'react',
    });
    expect(project.browser).toMatchObject({ browser: 'chromium', headless: true });
    const mission = project.mission as {
      safety: { ignoredPaths: string[] };
      exploration: Record<string, number>;
    };
    // Les chemins de déconnexion du moteur restent exclus, même retirés du brouillon.
    expect(mission.safety.ignoredPaths).toEqual(expect.arrayContaining([...ALWAYS_IGNORED_PATHS, '/admin']));
    expect(mission.exploration).toMatchObject({ maxStates: 100, actionTimeoutMs: 10_000 });
    expect(project.staticAnalysis).toEqual({ enabled: false });
  });

  it('never contains a credential: only the names of environment variables', async () => {
    const withAuth = draft({
      environment: {
        ...engineDefaults().environment,
        auth: {
          type: 'form',
          loginUrl: '/login',
          usernameSelector: '#user',
          passwordSelector: '#pass',
          submitSelector: 'button[type=submit]',
          usernameEnv: 'QA_USERNAME',
          passwordEnv: 'QA_PASSWORD',
        },
      },
    });
    const env = { QA_USERNAME: 'jane.roe', QA_PASSWORD: 'p4ssw0rd-value' };
    const { report } = await validateDraft(withAuth, rules, env, '/tmp/sdk-project');
    expect(report.ok).toBe(true);
    expect(report.environment).toEqual({ QA_USERNAME: true, QA_PASSWORD: true });
    const file = report.projectFile ?? '';
    expect(file).toContain('QA_PASSWORD');
    expect(file).not.toContain('p4ssw0rd-value');
    expect(file).not.toContain('jane.roe');
    expect(JSON.stringify(report)).not.toContain('p4ssw0rd-value');
  });

  it('refuses any field the draft does not declare (no place for a secret)', async () => {
    const tampered = { ...draft(), environment: { ...draft().environment, password: 'x' } };
    const { report } = await validateDraft(tampered, rules, {}, '/tmp/sdk-project');
    expect(report.ok).toBe(false);
    expect(report.blocking[0]?.step).toBe('environment');
  });

  it('blocks when a referenced environment variable is missing on the server', async () => {
    const withHttp = draft({
      environment: {
        ...engineDefaults().environment,
        auth: { type: 'http', usernameEnv: 'QA_USERNAME', passwordEnv: 'QA_PASSWORD' },
      },
    });
    const { report } = await validateDraft(withHttp, rules, { QA_USERNAME: 'a' }, '/tmp/sdk-project');
    expect(report.ok).toBe(false);
    expect(report.environment).toEqual({ QA_USERNAME: true, QA_PASSWORD: false });
    expect(report.blocking.map((issue) => issue.message)).toEqual([
      'the environment variable QA_PASSWORD is not defined on the QA-CRAWLER server',
    ]);
    // Sans origine, l'avertissement dit où les identifiants pourraient partir.
    expect(report.warnings.map((issue) => issue.field)).toContain('auth.origin');
  });

  it('rejects a non-http target and reports it on the project step', async () => {
    const { report } = await validateDraft(
      draft({ project: { name: 'X', targetUrl: 'ftp://files.example.test', framework: 'other' } }),
      rules,
      {},
      '/tmp/sdk-project',
    );
    expect(report.ok).toBe(false);
    expect(report.blocking[0]).toMatchObject({ step: 'project', field: 'targetUrl' });
  });

  it('reads an Angular source folder only under a folder the server allows', async () => {
    const angular = (sourceRoot: string): ProjectDraft =>
      draft({
        project: { name: 'Ng', targetUrl: 'https://ng.example.test', framework: 'angular', sourceRoot },
      });
    const refused = await validateDraft(
      angular('/etc'),
      { ...rules, allowedSourceRoots: ['/srv/apps'] },
      {},
      '/tmp/p',
    );
    expect(refused.report.ok).toBe(false);
    expect(refused.report.blocking[0]?.field).toBe('sourceRoot');
    expect(sourceRootAllowed('/srv/apps/portal', ['/srv/apps'])).toBe(true);
    expect(sourceRootAllowed('/srv/apps-other', ['/srv/apps'])).toBe(false);
    const document = projectDocument(angular('/srv/apps/portal'), rules) as {
      qaCrawler: { staticAnalysis: unknown };
    };
    expect(document.qaCrawler.staticAnalysis).toEqual({ enabled: true, source: '/srv/apps/portal' });
  });

  it('validates with the engine itself: the derived mission loads', async () => {
    const outcome = await validateDraft(draft(), rules, {}, '/tmp/sdk-project');
    expect(outcome.report.ok).toBe(true);
    expect(outcome.config?.target.baseUrl).toBe('https://app.example.test');
    expect(outcome.config?.exploration.maxStates).toBe(100);
    expect(outcome.config?.safety.mutations.enabled).toBe(false);
  });

  it('writes the project folder and reads it back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sdk-project-'));
    dirs.push(dir);
    const stored = await writeProject(dir, 'prj_test1', draft(), rules);
    expect(stored).toMatchObject({ id: 'prj_test1', name: 'Demo', status: 'PROJECT_CREATED' });
    const yaml = parse(await readFile(path.join(dir, 'qa-crawler.config.yaml'), 'utf8')) as {
      qaCrawler: unknown;
    };
    expect(yaml.qaCrawler).toEqual(projectDocument(draft(), rules).qaCrawler);
    const back = await readProject(dir);
    expect(back?.draft.project.name).toBe('Demo');
    expect(renderProjectFile(draft(), rules)).toMatch(/^# QA-Crawler project created by the SDK wizard/);
  });

  it('turns the Salesforce Lightning type into the engine platform profile (and only that type)', async () => {
    const lightning = draft({
      project: {
        name: 'Org',
        targetUrl: 'https://org.example.test/lightning/page/home',
        framework: 'salesforce',
      },
    });
    const document = projectDocument(lightning, rules) as {
      qaCrawler: { application: Record<string, unknown> };
    };
    expect(document.qaCrawler.application).toMatchObject({
      framework: 'salesforce',
      platform: 'salesforce-lightning',
    });
    const outcome = await validateDraft(lightning, rules, {}, '/tmp/sdk-project');
    expect(outcome.report.ok).toBe(true);
    expect(outcome.config?.target.platform).toBe('salesforce-lightning');
    expect(
      (projectDocument(draft(), rules) as { qaCrawler: { application: Record<string, unknown> } }).qaCrawler
        .application,
    ).not.toHaveProperty('platform');
  });
});
