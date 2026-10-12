import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/config-loader.js';
import {
  discoverFlows,
  findProjectConfigFile,
  loadProjectConfig,
  loadProjectMission,
  projectMission,
} from '../../../src/project/project-config.js';

async function project(configYaml: string, flows: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-project-'));
  await writeFile(path.join(root, 'qa-crawler.config.yaml'), configYaml, 'utf8');
  await mkdir(path.join(root, 'qa-crawler', 'flows'), { recursive: true });
  for (const [name, content] of Object.entries(flows))
    await writeFile(path.join(root, 'qa-crawler', 'flows', name), content, 'utf8');
  return root;
}

const BASE = `qaCrawler:
  application:
    baseUrl: http://localhost:4300
    startAt: /home
    name: demo
  api:
    openapi: ./openapi.yaml
  actors:
    - name: admin
      primary: true
      auth:
        type: form
        loginUrl: /login
        usernameSelector: '#user'
        passwordSelector: '#pass'
        submitSelector: 'button[type=submit]'
        usernameEnv: QA_ADMIN_USER
        passwordEnv: QA_ADMIN_PASSWORD
    - name: reader
      auth:
        type: oidc
        identityProviderOrigin: https://idp.example.test
        usernameSelector: '#idp-user'
        passwordSelector: '#idp-pass'
        submitSelector: '#idp-submit'
        reuseSession: true
      profile:
        roles: [reader]
  persistence:
    provider: file
  reporting:
    language: fr
    failOnSeverity: WARNING
  mission:
    safety:
      allowedActionClasses: [SAFE]
`;

describe('project configuration', () => {
  it('finds qa-crawler.config.yaml from a sub-directory, with or without the qaCrawler root key', async () => {
    const root = await project(BASE);
    await mkdir(path.join(root, 'src', 'app'), { recursive: true });
    expect(await findProjectConfigFile(path.join(root, 'src', 'app'))).toBe(
      path.join(root, 'qa-crawler.config.yaml'),
    );
    expect(await findProjectConfigFile(await mkdtemp(path.join(tmpdir(), 'qa-empty-')))).toBeUndefined();
    const loaded = await loadProjectConfig(path.join(root, 'qa-crawler.config.yaml'));
    expect(loaded.root).toBe(root);
    expect(loaded.config.application.baseUrl).toBe('http://localhost:4300');
    expect(loaded.config.paths.flows).toBe('qa-crawler/flows');

    const direct = await project('application:\n  baseUrl: http://localhost:9999\n');
    expect(
      (await loadProjectConfig(path.join(direct, 'qa-crawler.config.yaml'))).config.application.baseUrl,
    ).toBe('http://localhost:9999');
  });

  it('refuses an invalid project configuration with the path of the error', async () => {
    const root = await project('qaCrawler:\n  reporting:\n    language: de\n');
    await expect(loadProjectConfig(path.join(root, 'qa-crawler.config.yaml'))).rejects.toThrow(ConfigError);
    await expect(loadProjectConfig(path.join(root, 'qa-crawler.config.yaml'))).rejects.toThrow(/language/);
  });

  it('discovers YAML flows (one flow, or a flows list) and Gherkin features', async () => {
    const root = await project(BASE, {
      'home.flow.yaml': 'name: home\nstartAt: /\nsteps:\n  - expect:\n      url: /\n',
      'many.yaml': 'flows:\n  - name: a\n    steps: []\n  - name: b\n    steps: []\n',
      'login.feature': 'Feature: Login\n  Scenario: ok\n    Given I am on "/"\n',
      'notes.txt': 'ignored',
    });
    const { flows, files } = await discoverFlows(path.join(root, 'qa-crawler', 'flows'));
    expect(files.map((file) => path.basename(file))).toEqual([
      'home.flow.yaml',
      'login.feature',
      'many.yaml',
    ]);
    expect(flows.map((flow) => flow.name ?? flow.gherkin)).toEqual([
      'home',
      path.join(root, 'qa-crawler', 'flows', 'login.feature'),
      'a',
      'b',
    ]);
    const { flows: none } = await discoverFlows(path.join(root, 'missing'));
    expect(none).toEqual([]);
  });

  it('translates the project into a mission: actors, paths, OpenAPI, reporting and the mission passthrough', async () => {
    const root = await project(BASE, { 'home.flow.yaml': 'name: home\nsteps:\n  - expect:\n      url: /\n' });
    const loaded = await loadProjectConfig(path.join(root, 'qa-crawler.config.yaml'));
    const { mission, flowFiles } = await projectMission(loaded, { command: 'analyze' });
    expect(flowFiles).toHaveLength(1);
    expect(mission).toMatchObject({
      mission: { name: 'demo', mode: 'explore' },
      target: { baseUrl: 'http://localhost:4300', startAt: '/home' },
      exploration: { autonomous: false },
      auth: {
        type: 'form',
        loginUrl: '/login',
        usernameEnv: 'QA_ADMIN_USER',
        passwordEnv: 'QA_ADMIN_PASSWORD',
      },
      actors: [
        {
          name: 'reader',
          auth: { type: 'sso', identityProviderOrigin: 'https://idp.example.test' },
          profile: { roles: ['reader'] },
        },
      ],
      authorization: { primaryActor: 'admin' },
      output: { reportsDir: path.join(root, 'qa-reports'), html: true, json: true },
      report: { language: 'fr', failOnSeverity: 'WARNING' },
      knowledge: { file: path.join(root, 'qa-crawler', 'knowledge', 'knowledge-base.json') },
      baseline: { dir: path.join(root, 'qa-crawler', 'baselines') },
      persistence: {
        enabled: true,
        provider: 'file',
        file: { directory: path.join(root, 'qa-crawler', 'memory') },
      },
      openapi: { enabled: true, source: path.join(root, 'openapi.yaml') },
      apiTesting: { enabled: true },
      ai: { enabled: false, mode: 'OFF' },
      safety: { allowedActionClasses: ['SAFE'] },
      platform: { generatedTests: { enabled: false } },
    });
    const actors = mission.actors as { auth: { session?: { reuse: boolean; file?: string } } }[];
    expect(actors[0]?.auth.session).toEqual({
      reuse: true,
      file: path.join(root, 'qa-crawler', 'actors', 'reader.json'),
    });

    const explore = await projectMission(loaded, { command: 'explore' });
    expect(explore.mission.exploration).toEqual({ autonomous: true });
    const record = await projectMission(loaded, { command: 'record' });
    expect(record.mission.apiTesting).toEqual({ enabled: false });
    const generate = await projectMission(loaded, { command: 'generate-tests' });
    expect(
      (generate.mission.platform as { generatedTests: { enabled: boolean } }).generatedTests.enabled,
    ).toBe(true);
  });

  it('keeps only the requested flows, refuses an unknown one and accepts an overlay', async () => {
    const root = await project(BASE, {
      'a.yaml': 'name: a\nsteps: []\n',
      'b.yaml': 'name: b\nsteps: []\n',
    });
    const loaded = await loadProjectConfig(path.join(root, 'qa-crawler.config.yaml'));
    const { mission } = await projectMission(loaded, {
      command: 'replay',
      flows: ['b'],
      missionOverlay: { browser: { viewport: { width: 800, height: 600 } } },
    });
    expect((mission.flows as { name: string }[]).map((flow) => flow.name)).toEqual(['b']);
    expect(mission.browser).toEqual({ headless: true, viewport: { width: 800, height: 600 } });
    await expect(projectMission(loaded, { command: 'replay', flows: ['zz'] })).rejects.toThrow(
      /Unknown flow "zz"/,
    );
  });

  it('the derived mission is a valid mission: command line > environment > project file', async () => {
    const root = await project(BASE, { 'a.yaml': 'name: a\nsteps:\n  - expect:\n      url: /\n' });
    const loaded = await loadProjectConfig(path.join(root, 'qa-crawler.config.yaml'));
    const fromFile = await loadProjectMission(loaded, { command: 'replay' }, {}, {});
    expect(fromFile.config.target.baseUrl).toBe('http://localhost:4300');
    expect(fromFile.config.flows).toHaveLength(1);
    expect(fromFile.missionYaml).toContain('baseUrl: http://localhost:4300');

    const fromEnv = await loadProjectMission(
      loaded,
      { command: 'replay' },
      {},
      { QA_BASE_URL: 'http://env:1' },
    );
    expect(fromEnv.config.target.baseUrl).toBe('http://env:1');

    const fromCli = await loadProjectMission(
      loaded,
      { command: 'replay' },
      { baseUrl: 'http://cli:2', headless: false },
      { QA_BASE_URL: 'http://env:1' },
    );
    expect(fromCli.config.target.baseUrl).toBe('http://cli:2');
    expect(fromCli.config.browser.headless).toBe(false);
  });
});
