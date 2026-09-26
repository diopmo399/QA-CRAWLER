import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, hostMatches, loadConfigFile, parseConfig } from '../../src/config/config-loader.js';

const minimal = 'target:\n  baseUrl: http://localhost:4200\n';

describe('parseConfig', () => {
  it('applies sensible defaults to a minimal mission (just a URL)', () => {
    const { config, warnings } = parseConfig(minimal, {}, {});
    expect(config.mission.name).toBe('explore-application');
    expect(config.target.startAt).toBe('/');
    expect(config.browser.headless).toBe(true);
    expect(config.exploration).toMatchObject({
      maxStates: 100,
      maxActions: 500,
      maxDepth: 10,
      maxDurationMinutes: 15,
      actionTimeoutMs: 10000,
      maxStatesPerRoute: 3,
    });
    expect(config.goals).toEqual({
      discoverNavigation: true,
      discoverForms: true,
      discoverFlows: true,
      detectErrors: true,
    });
    expect(config.http.failOnStatus).toBe(400);
    expect(config.safety.allowedHosts).toEqual(['localhost']);
    expect(config.safety.allowedActionClasses).toEqual(['SAFE']);
    expect(config.safety.allow).toContain('tabs');
    expect(config.safety.block).toEqual(
      expect.arrayContaining(['delete', 'payment', 'logout', 'external-navigation', 'sensitive-data']),
    );
    expect(config.auth).toEqual({ type: 'none' });
    expect(config.output).toMatchObject({
      reportsDir: 'reports',
      screenshotsDir: 'screenshots',
      flowGraphHtml: true,
    });
    expect(config.memory.resume).toBe(false);
    expect(config.report.failOnSeverity).toBe('ERROR');
    expect(warnings).toEqual([]);
  });

  it('reads a mission without any list of steps', () => {
    const yaml = `
mission:
  name: explore-application
target: { baseUrl: http://localhost:4200, startAt: / }
exploration: { maxStates: 100, maxActions: 500, maxDepth: 10, maxDurationMinutes: 15, actionTimeoutMs: 10000 }
goals: { discoverNavigation: true, discoverForms: false, discoverFlows: true, detectErrors: true }
safety:
  allow: [navigation, search, filter, pagination, tabs]
  block: [delete, payment, external-navigation]
`;
    const { config, warnings } = parseConfig(yaml, {}, {});
    expect(config.mission.name).toBe('explore-application');
    expect(config.goals.discoverForms).toBe(false);
    expect(config.safety.allow).toEqual(['navigation', 'search', 'filter', 'pagination', 'tabs']);
    expect(config.safety.block).toEqual(['delete', 'payment', 'external-navigation']);
    expect(warnings).toEqual([]);
  });

  it('migrates first-version scenarios with deprecation warnings', () => {
    const yaml = `
name: smoke-test
target: { baseUrl: http://localhost:4200, startAt: / }
exploration: { maxPages: 10, maxDepth: 2, maxUrlsPerRoute: 4, clickSafeActions: true }
checks: { screenshots: false }
`;
    const { config, warnings } = parseConfig(yaml, {}, {});
    expect(config.mission.name).toBe('smoke-test');
    expect(config.exploration.maxStates).toBe(10);
    expect(config.exploration.maxStatesPerRoute).toBe(4);
    expect(config.checks.screenshots).toBe(false);
    expect(warnings.join('\n')).toMatch(
      /name.*deprecated[\s\S]*maxPages is deprecated[\s\S]*clickSafeActions is obsolete/,
    );
  });

  it('applies CLI overrides, then the QA_BASE_URL environment variable', () => {
    const fromEnv = parseConfig(minimal, {}, { QA_BASE_URL: 'https://pr-42.example.com' }).config;
    expect(fromEnv.target.baseUrl).toBe('https://pr-42.example.com');
    expect(fromEnv.safety.allowedHosts).toEqual(['pr-42.example.com']);

    const fromCli = parseConfig(
      minimal,
      { baseUrl: 'http://127.0.0.1:8080', maxStates: 3, maxActions: 7, headless: false },
      { QA_BASE_URL: 'https://ignored.example.com' },
    ).config;
    expect(fromCli.target.baseUrl).toBe('http://127.0.0.1:8080');
    expect(fromCli.exploration.maxStates).toBe(3);
    expect(fromCli.exploration.maxActions).toBe(7);
    expect(fromCli.browser.headless).toBe(false);
  });

  it('normalizes startAt', () => {
    expect(parseConfig(`${minimal}  startAt: dashboard\n`, {}, {}).config.target.startAt).toBe('/dashboard');
  });

  it('rejects invalid values with a readable path', () => {
    expect(() => parseConfig('target:\n  baseUrl: not-a-url\n', {}, {})).toThrowError(/target\.baseUrl/);
    expect(() => parseConfig(`${minimal}exploration:\n  maxStates: -1\n`, {}, {})).toThrowError(
      /exploration\.maxStates/,
    );
    expect(() => parseConfig(`${minimal}safety:\n  block: [nuke]\n`, {}, {})).toThrowError(/safety\.block/);
    expect(() => parseConfig('target:\n  baseUrl: ftp://x.test\n', {}, {})).toThrowError(/http or https/);
    expect(() => parseConfig('mission:\n  name: x\n', {}, {})).toThrowError(ConfigError);
  });

  it('rejects unknown keys and hints that credentials belong in environment variables', () => {
    expect(() => parseConfig(`${minimal}explorations: {}\n`, {}, {})).toThrowError(
      /unknown key\(s\) "explorations"/,
    );
    const withPassword = `${minimal}auth:\n  type: form\n  loginUrl: /login\n  usernameSelector: '#u'\n  passwordSelector: '#p'\n  submitSelector: button\n  password: hunter2\n`;
    expect(() => parseConfig(withPassword, {}, {})).toThrowError(/environment variables/);
  });

  it('rejects malformed YAML and non-mapping documents', () => {
    expect(() => parseConfig('target: [unclosed', {}, {})).toThrowError(/Invalid YAML/);
    expect(() => parseConfig('- a\n- b\n', {}, {})).toThrowError(/mapping/);
  });

  it('warns about risky settings', () => {
    const { warnings } = parseConfig(
      `${minimal}safety:\n  allowedActionClasses: [SAFE, DANGEROUS]\n  allowedHosts: [other.test]\n`,
      {},
      {},
    );
    expect(warnings.some((warning) => warning.includes('DANGEROUS'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('does not include the target host'))).toBe(true);
  });

  it('parses form authentication with environment variable names only', () => {
    const yaml = `${minimal}auth:\n  type: form\n  loginUrl: /login\n  usernameSelector: '#u'\n  passwordSelector: '#p'\n  submitSelector: button\n  successUrlContains: /home\n`;
    const { config } = parseConfig(yaml, {}, {});
    expect(config.auth).toMatchObject({
      type: 'form',
      usernameEnv: 'QA_USERNAME',
      passwordEnv: 'QA_PASSWORD',
    });
  });
});

describe('loadConfigFile', () => {
  it('loads a file from disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-config-'));
    const file = path.join(dir, 'mission.yaml');
    await writeFile(file, `mission:\n  name: from-file\n${minimal}`);
    const loaded = await loadConfigFile(file, {}, {});
    expect(loaded.config.mission.name).toBe('from-file');
    expect(loaded.source).toBe(file);
  });

  it('reports a missing file clearly', async () => {
    await expect(loadConfigFile('does/not/exist.yaml', {}, {})).rejects.toThrowError(
      /Scenario file not found/,
    );
  });

  it('accepts the bundled missions without warnings', async () => {
    for (const file of [
      'scenarios/smoke.yaml',
      'scenarios/example.yaml',
      'scenarios/demo.yaml',
      'scenarios/demo-traps.yaml',
    ]) {
      const loaded = await loadConfigFile(file, {}, {});
      expect(loaded.warnings, file).toEqual([]);
    }
  });
});

describe('hostMatches', () => {
  it('supports exact names and sub-domain wildcards', () => {
    expect(hostMatches('LocalHost', 'localhost')).toBe(true);
    expect(hostMatches('app.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('example.com.evil.test', '*.example.com')).toBe(false);
  });
});

describe('auth.type: http', () => {
  const base = 'target:\n  baseUrl: http://localhost:4200\n';
  it('reads credentials from the environment and normalizes the origin', () => {
    const { config, warnings } = parseConfig(
      `${base}auth:\n  type: http\n  origin: https://sso.example.com/siteminder/\n`,
      {},
      {},
    );
    expect(config.auth).toMatchObject({
      type: 'http',
      usernameEnv: 'QA_USERNAME',
      passwordEnv: 'QA_PASSWORD',
      origin: 'https://sso.example.com',
    });
    expect(warnings.some((warning) => warning.includes('auth.origin'))).toBe(false);
  });

  it('warns when the credentials may go to any host, and rejects inline secrets', () => {
    const { warnings } = parseConfig(`${base}auth:\n  type: http\n`, {}, {});
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('auth.origin is not set')]));
    expect(() => parseConfig(`${base}auth:\n  type: http\n  password: x\n`, {}, {})).toThrowError(
      /environment variables/,
    );
    expect(() => parseConfig(`${base}auth:\n  type: http\n  origin: ftp://x\n`, {}, {})).toThrowError(
      /origin/,
    );
  });

  it('forms.submit decides whether buttons that send a form may run', () => {
    const allowed = parseConfig(`${minimal}forms: { submit: true }\n`, {}, {}).config;
    expect(allowed.safety.block).not.toContain('form-submit');
    const refused = parseConfig(
      `${minimal}forms: { submit: false }\nsafety: { block: [delete] }\n`,
      {},
      {},
    ).config;
    expect(refused.safety.block).toEqual(['delete', 'form-submit']);
    const byDefault = parseConfig(minimal, {}, {}).config;
    expect(byDefault.forms).toEqual({ exercise: true });
    expect(byDefault.safety.block).toContain('form-submit');
    expect(byDefault.exploration.maxSimilarActions).toBe(2);
  });
});
