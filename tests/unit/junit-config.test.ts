import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';
import { parseProjectArgs } from '../../src/cli/project-command.js';
import { parseConfig } from '../../src/config/config-loader.js';
import { loadProjectConfig, projectMission } from '../../src/project/project-config.js';

/**
 * NON-RÉGRESSION : le rapport JUnit est une option, désactivée par défaut. Une mission, une
 * configuration de projet ou une ligne de commande d'avant donnent exactement la même
 * configuration effective ; seule une demande explicite l'active.
 */
const LEGACY = `
mission: { name: legacy }
target: { baseUrl: http://app.test }
report: { failOnSeverity: WARNING, language: fr }
`;

const DECLARED = `
mission: { name: declared }
target: { baseUrl: http://app.test }
report:
  failOnSeverity: WARNING
  junit: { enabled: true, file: ci/results.xml, required: true }
`;

const FILE_ONLY = `
mission: { name: file-only }
target: { baseUrl: http://app.test }
report:
  junit: { file: ci.xml }
`;

describe('JUnit report configuration', () => {
  it('a mission without report.junit keeps its reporting unchanged, JUnit off', () => {
    const { config } = parseConfig(LEGACY, {}, {});
    expect(config.report).toEqual({
      failOnSeverity: 'WARNING',
      language: 'fr',
      junit: { enabled: false, file: 'junit.xml', required: false },
    });
    expect(config.output).toMatchObject({ json: true, html: true, flowGraphHtml: true, overviewHtml: true });
  });

  it('report.junit is declared in the mission, with its file and required flag', () => {
    const { config } = parseConfig(DECLARED, {}, {});
    expect(config.report.junit).toEqual({ enabled: true, file: 'ci/results.xml', required: true });
    expect(config.report.language).toBe('en');
  });

  it('--junit enables it from the command line and keeps the file of the mission', () => {
    expect(parseCliArgs(['mission.yaml', '--junit']).junit).toBe(true);
    expect(parseCliArgs(['mission.yaml']).junit).toBeUndefined();
    // La CLI projet le transmet à la CLI de mission ; sans l'option, rien n'est transmis de plus.
    expect(parseProjectArgs('analyze', ['--junit']).passthrough).toEqual(['--junit']);
    expect(parseProjectArgs('analyze', []).passthrough).toEqual([]);
    const { config } = parseConfig(FILE_ONLY, { junit: true }, {});
    expect(config.report.junit).toEqual({ enabled: true, file: 'ci.xml', required: false });
    // Sans l'option, la mission reste telle quelle.
    expect(parseConfig(FILE_ONLY, {}, {}).config.report.junit.enabled).toBe(false);
  });

  it('the project configuration adds junit through reporting.format, html and json unchanged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qa-junit-project-'));
    await mkdir(path.join(root, 'qa-crawler', 'flows'), { recursive: true });
    await writeFile(
      path.join(root, 'qa-crawler', 'flows', 'home.flow.yaml'),
      'name: home\nsteps:\n  - expect:\n      url: /\n',
    );
    const configure = async (format: string): Promise<string> => {
      const file = path.join(root, 'qa-crawler.config.yaml');
      await writeFile(
        file,
        `qaCrawler:\n  application:\n    baseUrl: http://localhost:4300\n  reporting:\n    format: ${format}\n`,
      );
      return file;
    };
    const legacy = await projectMission(await loadProjectConfig(await configure('[html, json]')), {
      command: 'analyze',
    });
    expect(legacy.mission.output).toMatchObject({ html: true, json: true });
    expect(legacy.mission.report).toEqual({ language: 'en', failOnSeverity: 'ERROR' });
    const withJunit = await projectMission(await loadProjectConfig(await configure('[html, json, junit]')), {
      command: 'analyze',
    });
    expect(withJunit.mission.output).toMatchObject({ html: true, json: true });
    expect(withJunit.mission.report).toEqual({
      language: 'en',
      failOnSeverity: 'ERROR',
      junit: { enabled: true },
    });
  });
});
