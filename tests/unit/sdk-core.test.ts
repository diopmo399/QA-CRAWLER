import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  canTransition,
  createQaCrawler,
  emptyCounters,
  isCompatible,
  isTerminal,
  QaCrawlerError,
  readEventStream,
  type ExplorationEvent,
  type ExplorationSummary,
} from '../../src/sdk/core/index.js';

const at = '2026-01-01T00:00:00.000Z';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('SDK lifecycle', () => {
  it('follows QUEUED → RUNNING → COMPLETED | FAILED; CANCELLED is never reachable', () => {
    expect(canTransition('QUEUED', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
    expect(canTransition('RUNNING', 'FAILED')).toBe(true);
    expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    for (const from of ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const)
      expect(canTransition(from, 'CANCELLED')).toBe(false);
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('RUNNING')).toBe(false);
  });

  it('counts only engine events, and the final result replaces the live counters', () => {
    let counters = emptyCounters();
    const events: ExplorationEvent[] = [
      { seq: 1, at, type: 'state', stateId: 'a', label: 'home', route: '/', title: 'Home' },
      { seq: 2, at, type: 'transition', from: 'a', to: 'b', action: 'Users', changed: true },
      { seq: 3, at, type: 'transition', from: 'b', to: 'b', action: 'Sort', changed: false },
      { seq: 4, at, type: 'blocked', stateId: 'b', action: 'Delete', reason: 'delete' },
      { seq: 5, at, type: 'issue', severity: 'WARNING', issueType: 'HTTP', message: '404' },
      { seq: 6, at, type: 'phase', phase: 'Writing the artifacts' },
    ];
    for (const event of events) counters = applyEvent(counters, event);
    expect(counters).toEqual({
      states: 1,
      transitions: 1,
      actions: 2,
      blocked: 1,
      issues: { INFO: 0, WARNING: 1, ERROR: 0, CRITICAL: 0 },
    });
    const summary: ExplorationSummary = {
      stopReason: 'exhausted',
      passed: true,
      durationMs: 1000,
      stats: {
        states: 3,
        transitions: 4,
        actionsExecuted: 7,
        actionsBlocked: 2,
        issuesBySeverity: { INFO: 0, WARNING: 1, ERROR: 0, CRITICAL: 0 },
      },
      issues: [],
      reports: {},
    };
    counters = applyEvent(counters, { seq: 7, at, type: 'completed', summary });
    expect(counters).toEqual({
      states: 3,
      transitions: 4,
      actions: 7,
      blocked: 2,
      issues: { INFO: 0, WARNING: 1, ERROR: 0, CRITICAL: 0 },
    });
  });
});

describe('SDK client', () => {
  it('sends the token and the SDK header, and maps errors to QaCrawlerError', async () => {
    const urlOf = (input: Parameters<typeof fetch>[0]): string =>
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake: typeof fetch = (input, init) => {
      calls.push({ url: urlOf(input), init });
      if (urlOf(input).endsWith('/capabilities'))
        return Promise.resolve(new Response(JSON.stringify({ apiVersion: 1 }), { status: 200 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'the project is not valid',
            status: 422,
            code: 'DRAFT_INVALID',
            issues: [{ step: 'environment', message: 'QA_PASSWORD is not defined' }],
          }),
          { status: 422 },
        ),
      );
    };
    const client = createQaCrawler({
      endpoint: 'https://qa.example/api/',
      token: 'secret-token',
      fetch: fake,
    });
    await expect(client.capabilities()).resolves.toEqual({ apiVersion: 1 });
    expect(calls[0]?.url).toBe('https://qa.example/api/capabilities');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
    expect(headers['x-qa-crawler-sdk']).toBe('1');
    const failure = await client.projects.create({} as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QaCrawlerError);
    expect(failure).toMatchObject({ status: 422, code: 'DRAFT_INVALID' });
    expect((failure as QaCrawlerError).issues[0]?.step).toBe('environment');
  });

  it('reports an unreachable server as status 0, code UNREACHABLE', async () => {
    const client = createQaCrawler({
      endpoint: 'http://127.0.0.1:1/api',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(client.capabilities()).rejects.toMatchObject({ status: 0, code: 'UNREACHABLE' });
  });

  it('calls the extension routes of the server (recordings, assertions, groups, generation, graph, reports)', async () => {
    const calls: string[] = [];
    const fake: typeof fetch = (input, init) => {
      calls.push(
        `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : input instanceof URL ? input.href : input.url}`,
      );
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const client = createQaCrawler({ endpoint: 'http://localhost/api', token: 't', fetch: fake });
    await client.recordings.start('prj_1', { name: 'Ouvrir' });
    await client.recordings.stop('prj_1', 'ouvrir');
    await client.recordings.flow('prj_1', 'ouvrir');
    await client.assertions.decide('prj_1', 'ouvrir', 'p1', { decision: 'ACCEPT' });
    await client.groups.edit('prj_1', 'ouvrir', { op: 'create', name: 'G' }, { force: true });
    await client.generation.run('prj_1', 'ouvrir', { formats: ['yaml'] });
    await client.graph.exploration('exp_1');
    await client.graph.of('prj_1', 'recording', 'ouvrir');
    await client.reports.list('prj_1');
    await client.reports.link('prj_1', 'exploration', 'run-1');
    expect(calls).toEqual([
      'POST http://localhost/api/projects/prj_1/recordings',
      'POST http://localhost/api/projects/prj_1/recordings/ouvrir/stop',
      'GET http://localhost/api/projects/prj_1/recordings/ouvrir/flow',
      'POST http://localhost/api/projects/prj_1/recordings/ouvrir/assertions/p1',
      'POST http://localhost/api/projects/prj_1/recordings/ouvrir/groups',
      'POST http://localhost/api/projects/prj_1/recordings/ouvrir/generation',
      'GET http://localhost/api/explorations/exp_1/graph',
      'GET http://localhost/api/projects/prj_1/reports/recording/ouvrir/graph',
      'GET http://localhost/api/projects/prj_1/reports',
      'POST http://localhost/api/projects/prj_1/reports/exploration/run-1/links',
    ]);
  });

  it('encodes recording names in the path (the engine writes # for digits)', async () => {
    let seen = '';
    const client = createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: (input) => {
        seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(new Response('{}'));
      },
    });
    await client.recordings.get('prj_1', 'etape-#');
    expect(seen).toBe('http://localhost/api/projects/prj_1/recordings/etape-%23');
  });

  it('reads an event stream split across chunks, ignoring comments', async () => {
    const one = { seq: 1, at, type: 'status', status: 'RUNNING' };
    const two = { seq: 2, at, type: 'state', stateId: 's', label: 'home', route: '/', title: 'Home' };
    const text = `: keep-alive\n\nid: 1\nevent: status\ndata: ${JSON.stringify(one)}\n\nid: 2\ndata: ${JSON.stringify(two)}\n\n`;
    const chunks = [text.slice(0, 7), text.slice(7, 40), text.slice(40, 90), text.slice(90)];
    const events: ExplorationEvent[] = [];
    for await (const event of readEventStream(streamOf(chunks))) events.push(event);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({ type: 'state', label: 'home' });
  });

  it('subscribes with the token and resumes after a given event', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fake: typeof fetch = (input, init) => {
      seen = {
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        headers: init?.headers as Record<string, string>,
      };
      const event = { seq: 6, at, type: 'status', status: 'COMPLETED' };
      return Promise.resolve(new Response(streamOf([`data: ${JSON.stringify(event)}\n\n`]), { status: 200 }));
    };
    const client = createQaCrawler({ endpoint: 'http://localhost/api', token: 't', fetch: fake });
    const received: ExplorationEvent[] = [];
    const subscription = client.explorations.subscribe('exp_1', (event) => received.push(event), {
      after: 5,
    });
    await subscription.done;
    expect(seen?.url).toBe('http://localhost/api/explorations/exp_1/events?after=5');
    expect(seen?.headers.authorization).toBe('Bearer t');
    expect(received).toHaveLength(1);
  });

  it('connect checks the contract version the server speaks', async () => {
    const answering = (apiVersion: number) =>
      createQaCrawler({
        endpoint: 'http://localhost/api',
        fetch: () => Promise.resolve(new Response(JSON.stringify({ apiVersion }))),
      });
    await expect(answering(1).connect()).resolves.toMatchObject({ apiVersion: 1 });
    await expect(answering(2).connect()).rejects.toMatchObject({ code: 'API_VERSION_MISMATCH' });
    expect(isCompatible({ apiVersion: 1 })).toBe(true);
    expect(isCompatible({ apiVersion: 2 })).toBe(false);
  });

  const sse = (...events: object[]): string =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const urlOf = (input: RequestInfo | URL): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  it('reopens a stream cut before the end, after the last event, and never repeats an event', async () => {
    const urls: string[] = [];
    const answers = [
      sse({ seq: 1, at, type: 'status', status: 'RUNNING' }, { seq: 2, at, type: 'phase', phase: 'explore' }),
      // Le serveur rejoue à partir de `after` ; un relais peut renvoyer le dernier événement.
      sse(
        { seq: 2, at, type: 'phase', phase: 'explore' },
        { seq: 3, at, type: 'status', status: 'COMPLETED' },
      ),
    ];
    const fake: typeof fetch = (input) => {
      urls.push(urlOf(input));
      return Promise.resolve(new Response(streamOf([answers.shift() ?? '']), { status: 200 }));
    };
    const client = createQaCrawler({ endpoint: 'http://localhost/api', fetch: fake });
    const received: number[] = [];
    const reconnects: [number, number][] = [];
    const errors: Error[] = [];
    const subscription = client.explorations.subscribe('exp_1', (event) => received.push(event.seq), {
      reconnect: { delayMs: 0 },
      onReconnect: (attempt, after) => reconnects.push([attempt, after]),
      onError: (error) => errors.push(error),
    });
    await subscription.done;
    expect(received).toEqual([1, 2, 3]);
    expect(urls).toEqual([
      'http://localhost/api/explorations/exp_1/events',
      'http://localhost/api/explorations/exp_1/events?after=2',
    ]);
    expect(reconnects).toEqual([[1, 2]]);
    expect(errors).toEqual([]);
  });

  it('does not retry a refusal, and gives up after the retries on a server that stays away', async () => {
    let calls = 0;
    const refusing = createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('{"error":"unknown exploration"}', { status: 404 }));
      },
    });
    const refused: unknown[] = [];
    await refusing.explorations.subscribe('exp_x', () => undefined, {
      reconnect: { delayMs: 0 },
      onError: (error) => refused.push(error),
    }).done;
    expect(calls).toBe(1);
    expect(refused[0]).toMatchObject({ code: 'STREAM_REFUSED', status: 404, message: 'unknown exploration' });

    let attempts = 0;
    const away = createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: () => {
        attempts += 1;
        return Promise.reject(new TypeError('fetch failed'));
      },
    });
    const failures: Error[] = [];
    await away.explorations.subscribe('exp_1', () => undefined, {
      reconnect: { retries: 2, delayMs: 0 },
      onError: (error) => failures.push(error),
    }).done;
    expect(attempts).toBe(3);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe('fetch failed');
  });

  it('a stream that ends without its end event is reported once retries are off', async () => {
    const client = createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: () =>
        Promise.resolve(new Response(streamOf([sse({ seq: 1, at, type: 'status', status: 'RUNNING' })]))),
    });
    const failures: unknown[] = [];
    await client.recordings.subscribe('prj_1', 'parcours', () => undefined, {
      reconnect: { retries: 0 },
      onError: (error) => failures.push(error),
    }).done;
    expect(failures[0]).toMatchObject({ code: 'STREAM_CLOSED' });
  });

  it('closing during the wait before a retry stops for good', async () => {
    let calls = 0;
    const client = createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: () => {
        calls += 1;
        return Promise.reject(new TypeError('fetch failed'));
      },
    });
    const failures: Error[] = [];
    const subscription = client.explorations.subscribe('exp_1', () => undefined, {
      reconnect: { delayMs: 60_000 },
      onError: (error) => failures.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    subscription.close();
    await subscription.done;
    expect(calls).toBe(1);
    expect(failures).toEqual([]);
  });

  it('dispose refuses later calls', async () => {
    const client = createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: () => Promise.resolve(new Response('{}')),
    });
    client.dispose();
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});
