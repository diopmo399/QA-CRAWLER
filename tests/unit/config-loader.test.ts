import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, hostMatches, loadConfigFile, parseConfig } from '../../src/config/config-loader.js';

const minimal = 'target:\n  baseUrl: http://localhost:4200\n';

describe('parseConfig', () => {
  it('applies sensible defaults to a minimal scenario', () => {
    const { config, warnings } = parseConfig(minimal, {}, {});
    expect(config.name).toBe('qa-crawl');
    expect(config.target.startAt).toBe('/');
    expect(config.browser.headless).toBe(true);
    expect(config.exploration).toMatchObject({
      maxPages: 50,
      maxDepth: 5,
      navigationTimeoutMs: 15000,
      maxUrlsPerRoute: 2,
    });
    expect(config.http.failOnStatus).toBe(400);
    expect(config.safety.allowedHosts).toEqual(['localhost']);
    expect(config.safety.allowedActionClasses).toEqual(['SAFE']);
    expect(config.auth).toEqual({ type: 'none' });
    expect(config.output).toMatchObject({ reportsDir: 'reports', screenshotsDir: 'screenshots' });
    expect(config.report.failOnSeverity).toBe('ERROR');
    expect(warnings).toEqual([]);
  });

  it('reads the documented smoke example', () => {
    const yaml = `
name: smoke-test
target: { baseUrl: http://localhost:4200, startAt: / }
exploration: { maxPages: 10, maxDepth: 2 }
checks: { screenshots: false }
http: { failOnStatus: 500 }
safety:
  allowedHosts: [localhost]
  ignoredPaths: [/logout, /payment]
`;
    const { config } = parseConfig(yaml, {}, {});
    expect(config.name).toBe('smoke-test');
    expect(config.exploration.maxPages).toBe(10);
    expect(config.checks.screenshots).toBe(false);
    expect(config.checks.consoleErrors).toBe(true);
    expect(config.http.failOnStatus).toBe(500);
    expect(config.safety.ignoredPaths).toEqual(['/logout', '/payment']);
  });

  it('applies CLI overrides, then the QA_BASE_URL environment variable', () => {
    const fromEnv = parseConfig(minimal, {}, { QA_BASE_URL: 'https://pr-42.example.com' }).config;
    expect(fromEnv.target.baseUrl).toBe('https://pr-42.example.com');
    expect(fromEnv.safety.allowedHosts).toEqual(['pr-42.example.com']);

    const fromCli = parseConfig(
      minimal,
      { baseUrl: 'http://127.0.0.1:8080', maxPages: 3, headless: false },
      {
        QA_BASE_URL: 'https://ignored.example.com',
      },
    ).config;
    expect(fromCli.target.baseUrl).toBe('http://127.0.0.1:8080');
    expect(fromCli.exploration.maxPages).toBe(3);
    expect(fromCli.browser.headless).toBe(false);
  });

  it('normalizes startAt', () => {
    expect(parseConfig(`${minimal}  startAt: dashboard\n`, {}, {}).config.target.startAt).toBe('/dashboard');
  });

  it('rejects invalid values with a readable path', () => {
    expect(() => parseConfig('target:\n  baseUrl: not-a-url\n', {}, {})).toThrowError(/target\.baseUrl/);
    expect(() => parseConfig(`${minimal}exploration:\n  maxPages: -1\n`, {}, {})).toThrowError(
      /exploration\.maxPages/,
    );
    expect(() => parseConfig('target:\n  baseUrl: ftp://x.test\n', {}, {})).toThrowError(/http or https/);
    expect(() => parseConfig('name: x\n', {}, {})).toThrowError(ConfigError);
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
    const file = path.join(dir, 'scenario.yaml');
    await writeFile(file, `name: from-file\n${minimal}`);
    const loaded = await loadConfigFile(file, {}, {});
    expect(loaded.config.name).toBe('from-file');
    expect(loaded.source).toBe(file);
  });

  it('reports a missing file clearly', async () => {
    await expect(loadConfigFile('does/not/exist.yaml', {}, {})).rejects.toThrowError(
      /Scenario file not found/,
    );
  });

  it('accepts the bundled scenarios', async () => {
    for (const file of ['scenarios/smoke.yaml', 'scenarios/example.yaml', 'scenarios/demo.yaml']) {
      await expect(loadConfigFile(file, {}, {})).resolves.toBeDefined();
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
