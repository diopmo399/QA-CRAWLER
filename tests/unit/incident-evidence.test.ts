import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import type { Issue } from '../../src/model/issue.js';
import {
  quotedTextsIn,
  reproductionFromResult,
  statusesIn,
  symptomMatch,
} from '../../src/incident/evidence.js';

/**
 * LES PREUVES d'une reproduction de l'incident fictif du catalogue : « après Enregistrer, l'application
 * affiche une erreur HTTP 500 » (POST /api/books → 500 quand l'éditeur est laissé vide).
 */

const BFF_ERROR = String.raw`{"timestamp":"2026-10-30T09:00:03Z","status":500,"error":"Internal Server Error","path":"/api/books","message":"Catalog error: 500 : \"{\"status\":500,\"error\":\"Internal Server Error\",\"exception\":\"java.lang.NullPointerException\",\"message\":\"Cannot invoke \\\"org.example.catalog.books.Publisher.getName()\\\" because the return value of \\\"org.example.catalog.books.CatalogBook.getPublisher()\\\" is null\",\"path\":\"/catalog/books\"}\""}`;

let runDir: string;

beforeAll(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), 'incident-evidence-'));
  await mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  await writeFile(path.join(runDir, 'trace.zip'), 'zip');
});

afterAll(async () => {
  await rm(runDir, { recursive: true, force: true });
});

function flow(): FlowRunReport {
  return {
    name: 'creer-livre',
    status: 'FAILED',
    startedAt: '2026-10-30T09:00:00.000Z',
    durationMs: 4000,
    states: [],
    issueIds: [],
    explored: false,
    steps: [
      {
        index: 1,
        kind: 'goto',
        description: 'goto /books/new',
        status: 'PASSED',
        optional: false,
        url: 'http://catalogue.test/books/new?session=abc',
        durationMs: 1000,
        network: {
          requests: [{ method: 'GET', path: '/api/publishers', status: 200, resourceType: 'fetch' }],
          writes: 0,
          errors: 0,
        },
      },
      {
        index: 2,
        kind: 'fill',
        description: 'fill "Titre" = Le Petit Atlas',
        status: 'PASSED',
        optional: false,
        url: 'http://catalogue.test/books/new?session=abc',
        durationMs: 1000,
      },
      {
        index: 3,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        optional: false,
        url: 'http://catalogue.test/books/new',
        durationMs: 1000,
        screenshot: path.join(runDir, 'screenshots', '003-save.png'),
        network: {
          requests: [
            {
              method: 'post',
              path: '/api/books',
              status: 500,
              durationMs: 85,
              resourceType: 'fetch',
              startedAt: '2026-10-30T09:00:02.100Z',
              requestBody: '{"title":"Le Petit Atlas","isbn":"978-2-0000-0000-1","password":"hunter22"}',
              responseBody: BFF_ERROR,
            },
          ],
          writes: 1,
          errors: 1,
        },
      },
      {
        index: 4,
        kind: 'expect',
        description: 'expect text "Livre créé"',
        status: 'FAILED',
        optional: false,
        reason: 'text "Livre créé" not found; token=abcdef123456 in page',
        durationMs: 1000,
      },
    ],
  };
}

function issue(partial: Partial<Issue> & Pick<Issue, 'id' | 'type' | 'message' | 'timestamp'>): Issue {
  return {
    severity: 'ERROR',
    pageUrl: 'http://catalogue.test/books/new',
    pages: [],
    states: [],
    occurrences: 1,
    ...partial,
  };
}

function result(issues: Issue[] = []): ExplorationResult {
  return { flows: [flow()], issues } as unknown as ExplorationResult;
}

const baseInput = {
  id: 'rep_1',
  scenario: 'creer-livre',
  target: 'LOCAL' as const,
  baseUrl: 'http://catalogue.test',
  run: 'run-2026-10-30',
  startedAt: '2026-10-30T08:59:59.000Z',
  observed: "Après avoir cliqué sur Enregistrer, l'application affiche une erreur HTTP 500.",
};

describe('reproductionFromResult', () => {
  it('turns the scenario steps into actions with their OBSERVED requests', () => {
    const run = reproductionFromResult({ ...baseInput, runDir, result: result() });
    expect(run.status).toBe('COMPLETED');
    expect(run.actions.map((action) => action.index)).toEqual([1, 2, 3, 4]);
    const save = run.requests.find((request) => request.path === '/api/books');
    expect(save).toMatchObject({
      method: 'POST',
      status: 500,
      step: 3,
      correlation: 'OBSERVED',
      startedAt: '2026-10-30T09:00:02.100Z',
      resourceType: 'fetch',
    });
    expect(save?.responseBody).toContain('NullPointerException');
    expect(run.actions[2]?.requestIds).toEqual([save?.id]);
    // Les heures d'étape suivent le début du flow et les durées.
    expect(run.actions[0]?.startedAt).toBe('2026-10-30T09:00:00.000Z');
    expect(run.actions[2]?.startedAt).toBe('2026-10-30T09:00:02.000Z');
  });

  it('collects pages, failed expectations, screenshots (relative to the run) and the trace', () => {
    const run = reproductionFromResult({ ...baseInput, runDir, result: result() });
    const kinds = run.evidence.map((item) => item.kind);
    expect(kinds.filter((kind) => kind === 'ACTION')).toHaveLength(4);
    expect(kinds).toContain('PAGE');
    expect(kinds).toContain('TRACE');
    const assertion = run.evidence.find((item) => item.kind === 'ASSERTION');
    expect(assertion?.source.step).toBe(4);
    expect(run.screenshots).toEqual(['screenshots/003-save.png']);
    expect(run.actions[2]?.screenshot).toBe('screenshots/003-save.png');
    expect(run.trace).toBe('trace.zip');
    expect(run.evidence.every((item) => item.id.startsWith('rep_1:'))).toBe(true);
  });

  it('redacts bodies, URLs and texts', () => {
    const run = reproductionFromResult({
      ...baseInput,
      runDir,
      result: result([
        issue({
          id: 'i-console',
          type: 'CONSOLE',
          message: 'Failed to save: Authorization: Bearer abcdefghijklmnopq',
          timestamp: '2026-10-30T09:00:02.300Z',
        }),
      ]),
    });
    const text = JSON.stringify(run);
    expect(text).not.toContain('hunter22');
    expect(text).not.toContain('abcdef123456');
    expect(text).not.toContain('abcdefghijklmnopq');
    expect(text).not.toContain('session=abc');
  });

  it('turns console and JavaScript errors into evidence tied to a step by their timestamp', () => {
    const run = reproductionFromResult({
      ...baseInput,
      runDir,
      result: result([
        issue({
          id: 'i-js',
          type: 'PAGE_ERROR',
          message: 'TypeError: publisher is undefined',
          timestamp: '2026-10-30T09:00:02.500Z',
        }),
        issue({
          id: 'i-con',
          type: 'CONSOLE',
          message: 'console.error: save failed',
          timestamp: '2026-10-30T09:00:02.600Z',
        }),
        issue({
          id: 'i-a11y',
          type: 'ACCESSIBILITY',
          message: 'button without name',
          timestamp: '2026-10-30T09:00:01.000Z',
        }),
      ]),
    });
    const js = run.evidence.find((item) => item.kind === 'JS_ERROR');
    expect(js?.source.step).toBe(3);
    expect(js?.data?.correlation).toBe('INFERRED');
    expect(run.evidence.some((item) => item.kind === 'CONSOLE')).toBe(true);
    // Le bruit sans rapport avec l'incident n'est pas une preuve.
    expect(run.evidence.some((item) => item.summary.includes('button without name'))).toBe(false);
  });

  it('adds failed requests seen only as issues: INFERRED by timestamp, else UNKNOWN', () => {
    const run = reproductionFromResult({
      ...baseInput,
      runDir,
      result: result([
        issue({
          id: 'i-http',
          type: 'HTTP',
          message: 'GET /api/books/12/cover 502',
          requestUrl: 'http://catalogue.test/api/books/12/cover?token=xyz',
          method: 'GET',
          status: 502,
          timestamp: '2026-10-30T09:00:02.400Z',
        }),
        issue({
          id: 'i-late',
          type: 'REQUEST_FAILED',
          message: 'net::ERR_CONNECTION_REFUSED',
          requestUrl: 'http://catalogue.test/api/stats',
          method: 'POST',
          timestamp: '2026-10-30T10:00:00.000Z',
        }),
        // Déjà vue dans la fenêtre de l'étape 3 : pas en double.
        issue({
          id: 'i-dup',
          type: 'HTTP',
          message: 'POST /api/books 500',
          requestUrl: 'http://catalogue.test/api/books',
          method: 'POST',
          status: 500,
          timestamp: '2026-10-30T09:00:02.200Z',
        }),
      ]),
    });
    const cover = run.requests.find((request) => request.path === '/api/books/12/cover');
    expect(cover).toMatchObject({ correlation: 'INFERRED', step: 3, status: 502 });
    expect(cover?.url).not.toContain('xyz');
    expect(run.actions[2]?.requestIds).toContain(cover?.id);
    const stats = run.requests.find((request) => request.path === '/api/stats');
    expect(stats?.correlation).toBe('UNKNOWN');
    expect(stats?.step).toBeUndefined();
    expect(stats?.failure).toContain('ERR_CONNECTION_REFUSED');
    expect(run.requests.filter((request) => request.path === '/api/books')).toHaveLength(1);
  });

  it('decides `reproduced` from the observed description', () => {
    const run = reproductionFromResult({ ...baseInput, runDir, result: result() });
    expect(run.reproduced).toBe(true);
    expect(run.symptomMatch).toContain('POST /api/books → 500 (étape 3)');
  });

  it('reports a run without result as not concluded', () => {
    const run = reproductionFromResult({ ...baseInput, result: undefined });
    expect(run.status).toBe('FAILED');
    expect(run.reproduced).toBeNull();
    expect(run.actions).toEqual([]);
    expect(run.error).toBeDefined();
  });
});

describe('symptomMatch', () => {
  let run: ReturnType<typeof reproductionFromResult>;
  beforeAll(() => {
    run = reproductionFromResult({ ...baseInput, result: result() });
  });

  it('extracts statuses and quoted texts', () => {
    expect(statusesIn('erreur 500 puis HTTP 404, parfois 5xx')).toEqual(['500', '404', '5xx']);
    expect(statusesIn('le livre numéro 120 est créé')).toEqual([]);
    expect(quotedTextsIn('message « Livre créé » ou "Erreur inattendue"')).toEqual([
      'Livre créé',
      'Erreur inattendue',
    ]);
  });

  it('matches a status class and a quoted error text', () => {
    expect(symptomMatch('une erreur 5xx', run).reproduced).toBe(true);
    const text = symptomMatch('la page indique « Catalog error »', run);
    expect(text.reproduced).toBe(true);
    expect(text.match).toContain('texte « Catalog error »');
  });

  it('explains what is missing when the symptom is not observed', () => {
    const missing = symptomMatch('erreur HTTP 503', run);
    expect(missing.reproduced).toBe(false);
    expect(missing.match).toContain('non observé : HTTP 503');
    expect(missing.match).toContain('statuts vus : 200, 500');
    const vague = symptomMatch("l'application ne marche pas", run);
    expect(vague.reproduced).toBe(false);
    expect(vague.match).toContain('ne peut pas être comparé');
  });
});
