import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from '../../src/sdk/core/index.js';
import * as server from '../../src/sdk/server/index.js';

/**
 * LA COMPATIBILITÉ DU CONTRAT PUBLIC. Une application hôte écrite pour la version 1 du contrat doit
 * continuer de fonctionner : ce qui figure ici ne disparaît ni ne change de nom ni de valeur. Les
 * ajouts sont permis (le test vérifie un sous-ensemble). Retirer ou renommer exige une nouvelle
 * version de contrat (`SDK_API_VERSION`), annoncée par `capabilities.apiVersion`.
 */
const CORE_EXPORTS = [
  'SDK_API_VERSION',
  'FRAMEWORKS',
  'AUTH_TYPES',
  'ENV_NAME_PATTERN',
  'EXTENSION_NAMES',
  'EXPLORATION_STATUSES',
  'SEVERITIES',
  'REPORT_KINDS',
  'RECORDING_STATUSES',
  'RECORDING_NAME_PATTERN',
  'GENERATION_FORMATS',
  'WIZARD_EVENTS',
  'STUDIO_EVENTS',
  'STEP_REPLAY_OUTCOMES',
  'ASSERTION_VERDICTS',
  'DATA_SOURCES',
  'verdictOfAssertionStatus',
  'verdictOfReplayOutcome',
  'canTransition',
  'isTerminal',
  'emptyCounters',
  'applyEvent',
  'totalIssues',
  'createQaCrawler',
  'isCompatible',
  'readEventStream',
  'QaCrawlerError',
];

const SERVER_EXPORTS = [
  'startSdkServer',
  'ExplorationManager',
  'Exploration',
  'summarize',
  'ALWAYS_IGNORED_PATHS',
  'engineDefaults',
  'projectDocument',
  'projectDraftSchema',
  'renderProjectFile',
  'validateDraft',
];

const CLIENT_SURFACE: Record<string, string[]> = {
  checks: ['url', 'env'],
  projects: ['validate', 'create', 'get'],
  explorations: ['start', 'status', 'result', 'subscribe', 'reportLink'],
  recordings: ['start', 'list', 'get', 'stop', 'subscribe', 'flow', 'studio'],
  assertions: ['list', 'decide'],
  data: ['get', 'bind'],
  groups: ['list', 'edit'],
  generation: ['run'],
  graph: ['exploration', 'of'],
  reports: ['list', 'link'],
};

describe('SDK public contract, version 1', () => {
  it('keeps every published export of the core and the server', () => {
    expect(Object.keys(core)).toEqual(expect.arrayContaining(CORE_EXPORTS));
    expect(Object.keys(server)).toEqual(expect.arrayContaining(SERVER_EXPORTS));
    expect(core.SDK_API_VERSION).toBe(1);
  });

  it('keeps the values hosts compare against (statuses, kinds, formats, DOM event names)', () => {
    expect(core.EXPLORATION_STATUSES).toEqual(
      expect.arrayContaining(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']),
    );
    expect(core.RECORDING_STATUSES).toEqual(
      expect.arrayContaining(['RECORDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'STORED']),
    );
    expect(core.SEVERITIES).toEqual(expect.arrayContaining(['INFO', 'WARNING', 'ERROR', 'CRITICAL']));
    expect(core.REPORT_KINDS).toEqual(
      expect.arrayContaining(['html', 'json', 'flowGraphHtml', 'overviewHtml']),
    );
    expect(core.GENERATION_FORMATS).toEqual(
      expect.arrayContaining(['yaml', 'gherkin', 'playwright', 'java']),
    );
    expect(core.EXTENSION_NAMES).toEqual(
      expect.arrayContaining(['recordings', 'groups', 'graph', 'assertions', 'generation', 'reports']),
    );
    expect(core.FRAMEWORKS).toEqual(
      expect.arrayContaining(['angular', 'react', 'vue', 'salesforce', 'other']),
    );
    expect(core.AUTH_TYPES).toEqual(expect.arrayContaining(['none', 'form', 'http', 'sso']));
    expect(core.WIZARD_EVENTS).toMatchObject({
      projectCreated: 'qa-project-created',
      explorationStarted: 'qa-exploration-started',
      explorationProgress: 'qa-exploration-progress',
      explorationCompleted: 'qa-exploration-completed',
      explorationFailed: 'qa-exploration-failed',
      error: 'qa-error',
    });
  });

  it('keeps the client namespaces and their methods', () => {
    const client = core.createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: () => Promise.resolve(new Response('{}')),
    });
    expect(typeof client.capabilities).toBe('function');
    expect(typeof client.connect).toBe('function');
    expect(typeof client.dispose).toBe('function');
    for (const [namespace, methods] of Object.entries(CLIENT_SURFACE)) {
      const value = (client as unknown as Record<string, Record<string, unknown>>)[namespace];
      for (const method of methods) expect(typeof value?.[method], `${namespace}.${method}`).toBe('function');
    }
    client.dispose();
  });
});

describe('SDK browser side', () => {
  it('core and ui import nothing but each other: no Node module, no Playwright, no engine class', async () => {
    const root = path.resolve('src/sdk');
    for (const part of ['core', 'ui']) {
      const directory = path.join(root, part);
      for (const file of (await readdir(directory)).filter((name) => name.endsWith('.ts'))) {
        const text = await readFile(path.join(directory, file), 'utf8');
        for (const [, specifier] of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
          const target = path.resolve(directory, specifier ?? '');
          const inside = ['core', 'ui'].some((allowed) =>
            target.startsWith(path.join(root, allowed) + path.sep),
          );
          expect(inside, `${part}/${file} imports ${String(specifier)}`).toBe(true);
        }
      }
    }
  });
});
