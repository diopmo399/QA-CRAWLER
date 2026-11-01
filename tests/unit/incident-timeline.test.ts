import { describe, expect, it } from 'vitest';
import type { Experiment, Incident, ReproductionRun } from '../../src/incident/model.js';
import { buildTimeline, exchangeStatus } from '../../src/incident/timeline.js';

/**
 * LA CHRONOLOGIE UNIFIÉE de l'incident fictif du catalogue : « après Enregistrer, erreur HTTP 500 »
 * (POST /api/books → 500). Reproduction de référence, rejeu de vérification, journaux INSPECT_LOGS,
 * vérifications terminées et historique : un ordre, des identifiants stables, des statuts, des heures
 * estimées signalées.
 */

const T = (time: string): string => `2026-10-30T${time}Z`;

function reference(): ReproductionRun {
  return {
    id: 'rep_1',
    startedAt: T('08:59:59.000'),
    finishedAt: T('09:00:05.000'),
    status: 'COMPLETED',
    target: 'LOCAL',
    scenario: 'creer-livre',
    run: 'run-1',
    reproduced: true,
    actions: [
      {
        index: 1,
        kind: 'goto',
        description: 'goto /books/new',
        status: 'PASSED',
        startedAt: T('09:00:00.000'),
        durationMs: 1000,
        requestIds: ['rep_1:req-1-1'],
      },
      {
        index: 2,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        startedAt: T('09:00:01.000'),
        durationMs: 1000,
        screenshot: 'screenshots/002.png',
        requestIds: ['rep_1:req-2-1', 'rep_1:req-2-2', 'rep_1:req-x-1'],
      },
      {
        index: 3,
        kind: 'expect',
        description: 'expect text "Livre créé"',
        status: 'FAILED',
        reason: 'text "Livre créé" not found',
        startedAt: T('09:00:02.000'),
        durationMs: 1000,
        requestIds: [],
      },
    ],
    requests: [
      {
        id: 'rep_1:req-1-1',
        method: 'GET',
        url: '/api/publishers',
        path: '/api/publishers',
        status: 200,
        resourceType: 'fetch',
        step: 1,
        correlation: 'OBSERVED',
      },
      {
        id: 'rep_1:req-2-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 500,
        durationMs: 85,
        resourceType: 'fetch',
        startedAt: T('09:00:01.100'),
        step: 2,
        correlation: 'OBSERVED',
        responseBody: '{"status":500,"error":"Internal Server Error"}',
      },
      {
        id: 'rep_1:req-2-2',
        method: 'GET',
        url: '/api/covers',
        path: '/api/covers',
        failure: 'net::ERR_CONNECTION_REFUSED',
        resourceType: 'fetch',
        step: 2,
        correlation: 'OBSERVED',
      },
      {
        id: 'rep_1:req-x-1',
        method: 'GET',
        url: 'http://catalogue.test/api/stats',
        path: '/api/stats',
        status: 404,
        resourceType: 'xhr',
        startedAt: T('09:00:01.500'),
        step: 2,
        correlation: 'INFERRED',
      },
    ],
    evidence: [
      {
        id: 'rep_1:ev-action-1',
        kind: 'ACTION',
        at: T('09:00:00.000'),
        summary: 'étape 1',
        source: { reproduction: 'rep_1', step: 1 },
      },
      {
        id: 'rep_1:ev-page-1',
        kind: 'PAGE',
        at: T('09:00:00.000'),
        summary: 'page /books/new après l’étape 1',
        source: { reproduction: 'rep_1', step: 1 },
      },
      {
        id: 'rep_1:ev-action-2',
        kind: 'ACTION',
        at: T('09:00:01.000'),
        summary: 'étape 2',
        source: { reproduction: 'rep_1', step: 2 },
      },
      {
        id: 'rep_1:ev-screenshot-2',
        kind: 'SCREENSHOT',
        at: T('09:00:01.000'),
        summary: 'capture après l’étape 2',
        source: { reproduction: 'rep_1', step: 2, file: 'screenshots/002.png' },
      },
      {
        id: 'rep_1:ev-issue-ISSUE-0001',
        kind: 'CONSOLE',
        at: T('09:00:01.300'),
        summary: 'CONSOLE : save failed, Authorization: Bearer abcdefghijklmnop',
        source: { reproduction: 'rep_1', step: 2 },
        data: { issueId: 'ISSUE-0001', severity: 'ERROR' },
      },
      {
        id: 'rep_1:ev-issue-ISSUE-0002',
        kind: 'JS_ERROR',
        at: T('09:00:01.400'),
        summary: 'PAGE_ERROR : TypeError: publisher is undefined',
        source: { reproduction: 'rep_1', step: 2 },
        data: { issueId: 'ISSUE-0002', severity: 'ERROR' },
      },
      {
        id: 'rep_1:ev-action-3',
        kind: 'ACTION',
        at: T('09:00:02.000'),
        summary: 'étape 3',
        source: { reproduction: 'rep_1', step: 3 },
      },
      {
        id: 'rep_1:ev-assertion-3',
        kind: 'ASSERTION',
        at: T('09:00:02.000'),
        summary: 'attente non satisfaite',
        source: { reproduction: 'rep_1', step: 3 },
      },
      {
        id: 'rep_1:ev-trace',
        kind: 'TRACE',
        summary: 'Trace Playwright',
        source: { reproduction: 'rep_1', file: 'trace.zip' },
      },
    ],
    screenshots: ['screenshots/002.png'],
    trace: 'trace.zip',
  };
}

function replay(): ReproductionRun {
  return {
    id: 'rep_2',
    startedAt: T('09:10:00.000'),
    finishedAt: T('09:10:02.000'),
    status: 'COMPLETED',
    target: 'LOCAL',
    scenario: 'creer-livre-avec-editeur',
    reproduced: false,
    actions: [
      {
        index: 1,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        startedAt: T('09:10:00.000'),
        durationMs: 800,
        requestIds: ['rep_2:req-1-1'],
      },
    ],
    requests: [
      {
        id: 'rep_2:req-1-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 201,
        durationMs: 40,
        resourceType: 'fetch',
        startedAt: T('09:10:00.100'),
        step: 1,
        correlation: 'OBSERVED',
      },
    ],
    evidence: [],
    screenshots: [],
  };
}

function experiments(): Experiment[] {
  return [
    {
      id: 'exp_1',
      kind: 'INSPECT_LOGS',
      hypothesisId: 'hyp_1',
      description: 'Chercher NullPointerException',
      params: { patterns: ['NullPointerException'] },
      status: 'DONE',
      sideEffects: false,
      decisions: [],
      outcome: 'SUPPORTS',
      summary: 'NullPointerException trouvé(s) dans les journaux',
      startedAt: T('09:12:00.000'),
      finishedAt: T('09:12:05.000'),
      evidence: [
        {
          id: 'exp_1:ev1',
          kind: 'LOG_LINE',
          at: T('09:12:04.000'),
          summary: '2026-10-30 09:00:01.150 ERROR BookController - java.lang.NullPointerException',
          source: { experiment: 'exp_1', file: 'logs/bff.log' },
          data: { source: 'logs/bff.log', pattern: 'NullPointerException', at: T('09:00:01.150') },
        },
        {
          id: 'exp_1:ev2',
          kind: 'LOG_LINE',
          at: T('09:12:04.500'),
          summary: '09:00:01.120 WARN CatalogService - slow query',
          source: { experiment: 'exp_1' },
          data: {
            source: 'openshift catalogue app=catalog-api',
            pattern: 'CatalogService',
            at: T('09:00:01.120'),
          },
        },
        {
          id: 'exp_1:ev3',
          kind: 'LOG_LINE',
          at: T('09:12:04.600'),
          summary: '\tat org.example.catalog.CatalogService.create(CatalogService.java:42)',
          source: { experiment: 'exp_1' },
          data: { source: 'openshift catalogue app=catalog-api', pattern: 'CatalogService' },
        },
        {
          id: 'exp_1:ev4',
          kind: 'EXPERIMENT',
          at: T('09:12:05.000'),
          summary: '400 ligne(s) lue(s), 3 correspondance(s)',
          source: { experiment: 'exp_1' },
        },
      ],
    },
    {
      id: 'exp_2',
      kind: 'COMPARE_WITH_PASSING',
      hypothesisId: 'hyp_1',
      description: 'Rejouer le scénario qui réussit',
      params: { scenario: 'creer-livre-avec-editeur' },
      status: 'ERROR',
      sideEffects: false,
      decisions: [],
      summary: 'la comparaison a échoué',
      startedAt: T('09:10:00.000'),
      finishedAt: T('09:10:03.000'),
      evidence: [
        {
          id: 'exp_2:ev1',
          kind: 'EXPERIMENT',
          at: T('09:10:03.000'),
          summary: 'Rejeu',
          source: { experiment: 'exp_2', reproduction: 'rep_2' },
        },
      ],
    },
    {
      id: 'exp_3',
      kind: 'UNIT_TEST',
      description: 'Lancer BookServiceTest',
      params: {},
      status: 'PROPOSED',
      sideEffects: false,
      decisions: [],
      evidence: [],
    },
  ];
}

function incident(): Incident {
  return {
    id: 'inc_1',
    projectId: 'prj_books',
    title: 'Erreur 500 à l’enregistrement d’un livre',
    description: 'Après Enregistrer, une erreur s’affiche.',
    observed: 'erreur HTTP 500 après Enregistrer',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'creer-livre',
    execution: { target: 'LOCAL' },
    scope: {
      mode: 'GUIDED',
      applications: [
        {
          id: 'bff',
          name: 'BFF du catalogue',
          layer: 'BFF',
          repository: { root: '/repos/bff', include: [] },
          logFiles: ['logs/bff.log'],
        },
        {
          id: 'catalog',
          name: 'API du catalogue',
          layer: 'BACKEND',
          repository: { root: '/repos/catalog', include: [] },
          openshift: { namespace: 'catalogue', selector: 'app=catalog-api' },
        },
      ],
      scenarios: ['creer-livre'],
      steps: [],
      endpoints: [],
      depth: 3,
      allowedHosts: [],
      logRoots: [],
      allowedCommands: [],
      permissions: {
        readSources: true,
        navigate: true,
        httpRequests: 'NONE',
        runTests: 'NONE',
        localCommands: false,
        readLogs: true,
        openshift: 'READ',
        sideEffects: false,
      },
      limits: {
        maxFiles: 2000,
        maxFileBytes: 524288,
        maxDurationMs: 600000,
        maxRequests: 50,
        maxExperiments: 10,
      },
      extensions: [],
    },
    state: 'INVESTIGATING',
    revision: 7,
    createdAt: T('08:58:00.000'),
    updatedAt: T('09:12:05.000'),
    createdBy: 'lecteur',
    history: [
      { at: T('08:58:00.000'), actor: 'lecteur', kind: 'CREATED', message: 'incident déclaré' },
      { at: T('08:59:58.000'), actor: 'lecteur', kind: 'STATE', message: 'SCOPED → REPRODUCING' },
      { at: T('08:59:58.000'), actor: 'lecteur', kind: 'REPRODUCTION', message: 'rep_1: run run-1 started' },
      {
        at: T('09:00:06.000'),
        actor: 'lecteur',
        kind: 'STATE',
        message: 'REPRODUCING → REPRODUCED : HTTP 500',
      },
      { at: T('09:20:00.000'), actor: 'lecteur', kind: 'STATE', message: 'INVESTIGATING → FAILED' },
    ],
    investigation: {
      // Le rejeu de vérification arrive après la référence : il ne la remplace jamais.
      reproductions: [reference(), replay()],
      hypotheses: [
        {
          id: 'hyp_1',
          title: 'Éditeur absent',
          description: 'L’éditeur laissé vide provoque une NullPointerException.',
          suspectedCause: 'getPublisher() null',
          layer: 'BACKEND',
          files: [],
          supporting: [],
          contradicting: [],
          confidence: 0.7,
          verifications: [],
          status: 'SUPPORTED',
        },
      ],
      experiments: experiments(),
    },
  };
}

describe('buildTimeline', () => {
  it('is pure and deterministic: same input, same output, input untouched', () => {
    const input = incident();
    const snapshot = JSON.stringify(input);
    const first = buildTimeline(input);
    expect(buildTimeline(input)).toEqual(first);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(first.map((event) => event.order)).toEqual(first.map((_, index) => index));
    expect(new Set(first.map((event) => event.id)).size).toBe(first.length);
  });

  it('builds stable ids from the reproduction, the kind and the evidence', () => {
    const ids = buildTimeline(incident()).map((event) => event.id);
    expect(ids).toContain('rep_1:ACTION:rep_1:ev-action-2');
    expect(ids).toContain('rep_1:REQUEST:rep_1:req-2-1');
    expect(ids).toContain('rep_1:RESPONSE:rep_1:req-2-1');
    expect(ids).toContain('rep_1:CONSOLE:rep_1:ev-issue-ISSUE-0001');
    expect(ids).toContain('rep_1:TRACE:rep_1:ev-trace');
    expect(ids).toContain('rep_2:ACTION:rep_2:ev-action-1');
    expect(ids).toContain('experiment:exp_1:LOG:exp_1:ev1');
    expect(ids).toContain('experiment:exp_1');
    expect(ids).toContain('history:0');
    expect(ids).toContain('history:4');
    // L'action ne réutilise pas une preuve qui n'existe pas (rep_2 n'en a aucune).
    const replayAction = buildTimeline(incident()).find(
      (event) => event.id === 'rep_2:ACTION:rep_2:ev-action-1',
    );
    expect(replayAction?.evidence).toEqual([]);
  });

  it('orders by time, then source, step and kind; actions before their requests', () => {
    const events = buildTimeline(incident());
    const position = (id: string): number => events.findIndex((event) => event.id === id);
    const order = [
      'history:0',
      'history:1',
      'history:2',
      'rep_1:ACTION:rep_1:ev-action-1',
      'rep_1:PAGE:rep_1:ev-page-1',
      'rep_1:REQUEST:rep_1:req-1-1',
      'rep_1:ACTION:rep_1:ev-action-2',
      'rep_1:REQUEST:rep_1:req-2-1',
      'experiment:exp_1:LOG:exp_1:ev2',
      'experiment:exp_1:LOG:exp_1:ev1',
      'rep_1:RESPONSE:rep_1:req-2-1',
      'rep_1:CONSOLE:rep_1:ev-issue-ISSUE-0001',
      'rep_1:JS_ERROR:rep_1:ev-issue-ISSUE-0002',
      'rep_1:REQUEST:rep_1:req-x-1',
      'rep_1:ACTION:rep_1:ev-action-3',
      'rep_1:ASSERTION:rep_1:ev-assertion-3',
      'rep_1:TRACE:rep_1:ev-trace',
      'history:3',
      'rep_2:ACTION:rep_2:ev-action-1',
      'rep_2:REQUEST:rep_2:req-1-1',
      'rep_2:RESPONSE:rep_2:req-1-1',
      'experiment:exp_2',
      'experiment:exp_1',
      'history:4',
    ];
    const positions = order.map(position);
    expect(positions.every((value) => value >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    // À heure égale, la référence passe avant l'historique ; la ligne de journal sans heure est classée
    // au début de sa vérification.
    expect(position('experiment:exp_1:LOG:exp_1:ev3')).toBeLessThan(position('experiment:exp_1'));
    expect(position('experiment:exp_1:LOG:exp_1:ev3')).toBeGreaterThan(position('experiment:exp_2'));
  });

  it('gives each exchange a REQUEST and a RESPONSE with a status from the HTTP code', () => {
    const events = buildTimeline(incident());
    const byId = new Map(events.map((event) => [event.id, event]));
    const response = byId.get('rep_1:RESPONSE:rep_1:req-2-1');
    expect(response).toMatchObject({
      kind: 'RESPONSE',
      status: 'ERROR',
      layer: 'NETWORK',
      reproduction: 'rep_1',
      step: 2,
      requestId: 'rep_1:req-2-1',
      evidence: ['rep_1:req-2-1'],
      at: T('09:00:01.185'),
    });
    expect(response?.estimated).toBeUndefined();
    expect(response?.summary).toBe('POST /api/books → 500 (85 ms)');
    expect(byId.get('rep_1:REQUEST:rep_1:req-2-1')).toMatchObject({ at: T('09:00:01.100'), status: 'ERROR' });
    expect(byId.get('rep_1:RESPONSE:rep_1:req-x-1')).toMatchObject({ status: 'WARNING' });
    expect(byId.get('rep_1:RESPONSE:rep_1:req-x-1')?.summary).toContain('[INFERRED]');
    expect(byId.get('rep_1:RESPONSE:rep_1:req-1-1')?.status).toBe('OK');
    // Un échec réseau : une requête en erreur, aucune réponse.
    expect(byId.get('rep_1:REQUEST:rep_1:req-2-2')).toMatchObject({ status: 'ERROR', kind: 'REQUEST' });
    expect(byId.get('rep_1:REQUEST:rep_1:req-2-2')?.summary).toContain('ERR_CONNECTION_REFUSED');
    expect(byId.has('rep_1:RESPONSE:rep_1:req-2-2')).toBe(false);
    expect(exchangeStatus({ status: 302 })).toBe('OK');
    expect(exchangeStatus({ status: 409 })).toBe('WARNING');
    expect(exchangeStatus({ status: 503 })).toBe('ERROR');
    expect(exchangeStatus({})).toBe('WARNING');
  });

  it('flags estimated times: actions, uncaptured requests, step evidence; never anomalies or captured requests', () => {
    const byId = new Map(buildTimeline(incident()).map((event) => [event.id, event]));
    expect(byId.get('rep_1:ACTION:rep_1:ev-action-1')).toMatchObject({
      at: T('09:00:00.000'),
      estimated: true,
    });
    expect(byId.get('rep_1:REQUEST:rep_1:req-1-1')).toMatchObject({ at: T('09:00:00.000'), estimated: true });
    expect(byId.get('rep_1:RESPONSE:rep_1:req-1-1')?.estimated).toBe(true);
    expect(byId.get('rep_1:ASSERTION:rep_1:ev-assertion-3')).toMatchObject({
      estimated: true,
      status: 'ERROR',
    });
    expect(byId.get('rep_1:SCREENSHOT:rep_1:ev-screenshot-2')?.estimated).toBe(true);
    expect(byId.get('rep_1:CONSOLE:rep_1:ev-issue-ISSUE-0001')?.estimated).toBeUndefined();
    expect(byId.get('rep_1:REQUEST:rep_1:req-2-1')?.estimated).toBeUndefined();
    // La trace n'a ni heure ni étape : aucune heure inventée.
    expect(byId.get('rep_1:TRACE:rep_1:ev-trace')?.at).toBeUndefined();
  });

  it('maps evidence kinds to timeline kinds, statuses and the FRONTEND layer, redacted', () => {
    const events = buildTimeline(incident());
    const byId = new Map(events.map((event) => [event.id, event]));
    expect(byId.get('rep_1:ACTION:rep_1:ev-action-3')).toMatchObject({
      kind: 'ACTION',
      status: 'ERROR',
      layer: 'FRONTEND',
      step: 3,
      evidence: ['rep_1:ev-action-3'],
    });
    expect(byId.get('rep_1:ACTION:rep_1:ev-action-3')?.summary).toContain('not found');
    expect(byId.get('rep_1:ACTION:rep_1:ev-action-1')?.status).toBe('OK');
    expect(byId.get('rep_1:CONSOLE:rep_1:ev-issue-ISSUE-0001')).toMatchObject({
      status: 'ERROR',
      layer: 'FRONTEND',
    });
    expect(byId.get('rep_1:JS_ERROR:rep_1:ev-issue-ISSUE-0002')?.status).toBe('ERROR');
    expect(byId.get('rep_1:PAGE:rep_1:ev-page-1')?.status).toBe('INFO');
    expect(byId.get('rep_1:SCREENSHOT:rep_1:ev-screenshot-2')?.status).toBe('INFO');
    expect(JSON.stringify(events)).not.toContain('abcdefghijklmnop');
    // Aucune preuve ACTION n'a de ligne à part : l'action la porte.
    expect(events.filter((event) => event.id.includes(':ACTION:rep_1:ev-action-')).length).toBe(3);
  });

  it('tags the reference and the verification replays by reproduction', () => {
    const events = buildTimeline(incident());
    const replayEvents = events.filter((event) => event.reproduction === 'rep_2');
    expect(replayEvents.map((event) => event.kind)).toEqual(['ACTION', 'REQUEST', 'RESPONSE']);
    expect(replayEvents.find((event) => event.kind === 'RESPONSE')?.status).toBe('OK');
    // Un rejeu listé AVANT la référence ne passe pas devant elle à heure égale.
    const input = incident();
    input.investigation.reproductions.reverse();
    expect(buildTimeline(input).filter((event) => event.reproduction === 'rep_1').length).toBe(
      events.filter((event) => event.reproduction === 'rep_1').length,
    );
  });

  it('adds log lines with their layer, finished verifications and the incident history', () => {
    const byId = new Map(buildTimeline(incident()).map((event) => [event.id, event]));
    expect(byId.get('experiment:exp_1:LOG:exp_1:ev1')).toMatchObject({
      kind: 'LOG',
      layer: 'BFF',
      status: 'ERROR',
      at: T('09:00:01.150'),
      evidence: ['exp_1:ev1'],
    });
    expect(byId.get('experiment:exp_1:LOG:exp_1:ev2')).toMatchObject({ layer: 'BACKEND', status: 'WARNING' });
    expect(byId.get('experiment:exp_1:LOG:exp_1:ev2')?.reproduction).toBeUndefined();
    // Sans heure dans la ligne : pas d'heure (jamais celle de la lecture).
    expect(byId.get('experiment:exp_1:LOG:exp_1:ev3')?.at).toBeUndefined();
    expect(byId.get('experiment:exp_1')).toMatchObject({
      kind: 'EXPERIMENT',
      status: 'OK',
      layer: 'BACKEND',
      at: T('09:12:05.000'),
      evidence: ['exp_1:ev4'],
    });
    expect(byId.get('experiment:exp_1')?.summary).toContain('INSPECT_LOGS DONE (SUPPORTS)');
    expect(byId.get('experiment:exp_2')?.status).toBe('ERROR');
    expect(byId.has('experiment:exp_3')).toBe(false);
    expect(byId.get('history:0')).toMatchObject({
      kind: 'STATE',
      layer: 'UNKNOWN',
      status: 'INFO',
      evidence: [],
    });
    expect(byId.get('history:2')?.layer).toBe('ENVIRONMENT');
    expect(byId.get('history:3')?.status).toBe('OK');
    expect(byId.get('history:4')?.status).toBe('ERROR');
    expect(byId.get('history:1')?.summary).toBe('STATE : SCOPED → REPRODUCING');
  });

  it('works without any reproduction: only history and verifications', () => {
    const input = incident();
    input.investigation.reproductions = [];
    const events = buildTimeline(input);
    expect(events.every((event) => event.reproduction === undefined)).toBe(true);
    expect(events.some((event) => event.kind === 'STATE')).toBe(true);
  });
});
