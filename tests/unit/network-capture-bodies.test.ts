import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from 'playwright';
import { describe, expect, it } from 'vitest';
import { scenarioSchema } from '../../src/config/config.js';
import { reproductionFromResult } from '../../src/incident/evidence.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import {
  CAPTURED_HEADERS,
  capturedFieldsOf,
  filterHeaders,
  isTextualContentType,
  MAX_CAPTURED_BODY,
  MAX_HEADER_VALUE,
  NetworkTraceRecorder,
  redactBody,
  type CapturedNetworkExchange,
} from '../../src/observers/network-trace-recorder.js';

/**
 * network.captureBodies : désactivé par défaut (aucun corps), activé il garde l'heure de départ et,
 * pour les erreurs et les écritures xhr/fetch, les corps JSON/texte masqués et tronqués.
 */

interface FakeExchange {
  request: Request;
  response: (status: number, body: string, type?: string) => Response;
}

function fakeExchange(input: {
  method: string;
  url: string;
  resourceType: string;
  body?: string;
  type?: string;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}): FakeExchange {
  const request = {
    method: () => input.method,
    url: () => input.url,
    resourceType: () => input.resourceType,
    postData: () => input.body ?? null,
    headers: () => ({ ...(input.type ? { 'content-type': input.type } : {}), ...input.headers }),
    failure: () => null,
  } as unknown as Request;
  return {
    request,
    response: (status, body, type = 'application/json') =>
      ({
        request: () => request,
        status: () => status,
        headers: () => ({ 'content-type': type, ...input.responseHeaders }),
        text: () => Promise.resolve(body),
      }) as unknown as Response,
  };
}

function recorder(captureBodies?: boolean): { recorder: NetworkTraceRecorder; page: EventEmitter } {
  const page = new EventEmitter();
  const instance = new NetworkTraceRecorder({
    resourceTypes: ['document', 'xhr', 'fetch'],
    maxRequestsPerAction: 50,
    ...(captureBodies !== undefined ? { captureBodies } : {}),
  });
  instance.attach(page as unknown as Page);
  return { recorder: instance, page };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const SAVE_BODY = JSON.stringify({
  title: 'Le Petit Atlas',
  isbn: '978-2-0000-0000-1',
  password: 'p4ss-word',
});
const ERROR_BODY = JSON.stringify({ status: 500, error: 'Internal Server Error', path: '/api/books' });

describe('network.captureBodies', () => {
  it('is off by default in the configuration, like browser.playwrightTrace', () => {
    const config = scenarioSchema.parse({ target: { baseUrl: 'http://localhost:4100' } });
    expect(config.network.captureBodies).toBe(false);
    expect(config.browser.playwrightTrace).toBe(false);
    const enabled = scenarioSchema.parse({
      target: { baseUrl: 'http://localhost:4100' },
      network: { captureBodies: true },
      browser: { playwrightTrace: true },
    });
    expect(enabled.network.captureBodies).toBe(true);
    expect(enabled.browser.playwrightTrace).toBe(true);
  });

  it('keeps no body nor start time when disabled', async () => {
    const { recorder: instance, page } = recorder();
    instance.start('a1');
    const save = fakeExchange({
      method: 'POST',
      url: 'http://localhost:4100/api/books',
      resourceType: 'fetch',
      body: SAVE_BODY,
      type: 'application/json',
    });
    page.emit('request', save.request);
    page.emit('response', save.response(500, ERROR_BODY));
    page.emit('requestfinished', save.request);
    await flush();
    const trace = instance.stop('a1');
    const exchange = trace?.requests[0] as CapturedNetworkExchange;
    expect(exchange.status).toBe(500);
    expect(exchange.requestBody).toBeUndefined();
    expect(exchange.responseBody).toBeUndefined();
    expect(exchange.startedAt).toBeUndefined();
    expect(capturedFieldsOf(exchange)).toEqual({});
  });

  it('captures redacted bodies of failing writes and nothing for a plain successful read', async () => {
    const { recorder: instance, page } = recorder(true);
    instance.start('a2');
    const save = fakeExchange({
      method: 'POST',
      url: 'http://localhost:4100/api/books',
      resourceType: 'fetch',
      body: SAVE_BODY,
      type: 'application/json',
    });
    const read = fakeExchange({
      method: 'GET',
      url: 'http://localhost:4100/api/publishers',
      resourceType: 'xhr',
    });
    const logo = fakeExchange({
      method: 'GET',
      url: 'http://localhost:4100/missing.json',
      resourceType: 'fetch',
    });
    page.emit('request', save.request);
    page.emit('request', read.request);
    page.emit('request', logo.request);
    page.emit('response', save.response(500, ERROR_BODY));
    page.emit('response', read.response(200, '[{"id":1,"name":"Éditions du Phare"}]'));
    page.emit('response', logo.response(404, 'binary', 'image/png'));
    await flush();
    const trace = instance.stop('a2');
    const [saved, listed, missing] = (trace?.requests ?? []) as CapturedNetworkExchange[];
    expect(saved?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saved?.requestBody).toContain('"title":"Le Petit Atlas"');
    expect(saved?.requestBody).toContain('"password":"[REDACTED]"');
    expect(saved?.requestBody).not.toContain('p4ss-word');
    expect(saved?.responseBody).toBe(ERROR_BODY);
    expect(capturedFieldsOf(saved as CapturedNetworkExchange)).toMatchObject({
      requestBody: saved?.requestBody,
    });
    // Une lecture réussie : seulement l'heure de départ.
    expect(listed?.startedAt).toBeDefined();
    expect(listed?.responseBody).toBeUndefined();
    // Une erreur dont le corps n'est ni JSON ni texte : jamais gardé.
    expect(missing?.status).toBe(404);
    expect(missing?.responseBody).toBeUndefined();
  });

  it('completes the reported exchange when the body is read after the window closed', async () => {
    const { recorder: instance, page } = recorder(true);
    instance.start('a3');
    const save = fakeExchange({
      method: 'PUT',
      url: 'http://localhost:4100/api/books/12',
      resourceType: 'xhr',
      body: '{"title":"Atlas"}',
      type: 'application/json',
    });
    page.emit('request', save.request);
    page.emit('response', save.response(500, '{"error":"boom","token":"abc123456789"}'));
    const trace = instance.stop('a3');
    await flush();
    const reported = trace?.requests[0] as CapturedNetworkExchange;
    expect(reported.responseBody).toBe('{"error":"boom","token":"[REDACTED]"}');
  });
});

describe('redactBody', () => {
  it('masks sensitive JSON keys at any depth and secrets in text', () => {
    const body = JSON.stringify({
      user: { name: 'lecteur', apiKey: 'k-1', session: { id: 's' } },
      items: [{ privateNote: 'x', title: 'Atlas' }],
      message: 'Authorization: Bearer abcdefghijklmnop',
    });
    const redacted = JSON.parse(redactBody(body, 'application/json')) as {
      user: Record<string, unknown>;
      items: Record<string, unknown>[];
      message: string;
    };
    expect(redacted.user.apiKey).toBe('[REDACTED]');
    expect(redacted.user.session).toBe('[REDACTED]');
    expect(redacted.user.name).toBe('lecteur');
    expect(redacted.items[0]?.privateNote).toBe('[REDACTED]');
    expect(redacted.items[0]?.title).toBe('Atlas');
    expect(redacted.message).not.toContain('abcdefghijklmnop');
  });

  it('masks form parameters and plain text, and truncates to 8 KiB', () => {
    expect(redactBody('title=Atlas&credential=s3cret', 'application/x-www-form-urlencoded')).toBe(
      'title=Atlas&credential=[REDACTED]',
    );
    expect(redactBody('error: password=hunter22 refused', 'text/plain')).not.toContain('hunter22');
    const long = redactBody('x'.repeat(MAX_CAPTURED_BODY * 2), 'text/plain');
    expect(long.length).toBeLessThan(MAX_CAPTURED_BODY + 20);
    expect(long.endsWith('…[truncated]')).toBe(true);
  });

  it('recognizes textual content types only', () => {
    expect(isTextualContentType('application/json; charset=utf-8')).toBe(true);
    expect(isTextualContentType('application/problem+json')).toBe(true);
    expect(isTextualContentType('text/html')).toBe(true);
    expect(isTextualContentType('image/png')).toBe(false);
    expect(isTextualContentType('multipart/form-data; boundary=x')).toBe(false);
    expect(isTextualContentType(undefined)).toBe(false);
  });
});

/** Des en-têtes comme les envoie un navigateur connecté : secrets compris, qui ne doivent jamais être gardés. */
const SECRET_REQUEST_HEADERS = {
  authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
  cookie: 'JSESSIONID=s3ss10n-value',
  'proxy-authorization': 'Basic dXNlcjpwYXNz',
  'x-api-key': 'k-123456789',
  'x-auth-token': 'tok-123456789',
  'x-csrf-token': 'csrf-123456789',
  'x-session-id': 'sess-123456789',
  'x-client-secret': 'cs-123456789',
  'x-forwarded-for': '10.0.0.12',
  'user-agent': 'Mozilla/5.0',
};
const SECRET_VALUES = [
  'abcdefghijklmnopqrstuvwxyz',
  's3ss10n-value',
  'dXNlcjpwYXNz',
  'k-123456789',
  'tok-123456789',
  'csrf-123456789',
  'sess-123456789',
  'cs-123456789',
  '10.0.0.12',
  'Mozilla',
];

describe('captured headers (network.captureBodies)', () => {
  it('keeps only the allowlist, lower-cased and sorted, and never a credential', () => {
    const kept = filterHeaders({
      ...SECRET_REQUEST_HEADERS,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Request-Id': 'req-42',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-b3-traceid': '4bf92f3577b34da6',
    });
    expect(kept).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-b3-traceid': '4bf92f3577b34da6',
      'x-request-id': 'req-42',
    });
    const text = JSON.stringify(kept);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
    expect(
      filterHeaders({ 'set-cookie': 'SESSION=abc; HttpOnly', authorization: 'Bearer x' }),
    ).toBeUndefined();
    expect(filterHeaders(undefined)).toBeUndefined();
  });

  it('never allowlists a sensitive name', () => {
    for (const name of CAPTURED_HEADERS)
      expect(name).not.toMatch(/authorization|cookie|^proxy-|api-?key|secret|token|session/);
  });

  it('masks secrets in values, strips control characters, truncates and keeps only the path of a redirect', () => {
    const kept = filterHeaders({
      'x-correlation-id': 'corr-1 password=hunter22',
      'cache-control': `no-cache\r\nset-cookie: injected`,
      'content-type': 'x'.repeat(MAX_HEADER_VALUE * 2),
      location: 'https://catalogue.test/books/12?session=abc&token=xyz#top',
    });
    expect(kept?.['x-correlation-id']).toContain('corr-1');
    expect(kept?.['x-correlation-id']).not.toContain('hunter22');
    expect(kept?.['cache-control']).not.toMatch(/[\r\n]/);
    expect(kept?.['content-type']).toHaveLength(MAX_HEADER_VALUE);
    expect(kept?.['content-type']?.endsWith('…')).toBe(true);
    expect(kept?.location).toBe('/books/12?…');
    // Une seconde passe (relecture d'un result.json) ne change rien.
    expect(filterHeaders(kept)).toEqual(kept);
  });

  it('records allowlisted request and response headers only when captureBodies is on', async () => {
    const exchangeOf = (): FakeExchange =>
      fakeExchange({
        method: 'POST',
        url: 'http://localhost:4100/api/books',
        resourceType: 'fetch',
        body: '{"title":"Atlas"}',
        type: 'application/json',
        headers: { ...SECRET_REQUEST_HEADERS, 'x-request-id': 'req-7' },
        responseHeaders: {
          'set-cookie': 'SESSION=s3ss10n-value; HttpOnly',
          'x-request-id': 'req-7',
          'content-length': '120',
          location: 'http://localhost:4100/books/12?token=abc',
        },
      });
    const off = recorder();
    off.recorder.start('h0');
    const plain = exchangeOf();
    off.page.emit('request', plain.request);
    off.page.emit('response', plain.response(201, '{}'));
    const offExchange = off.recorder.stop('h0')?.requests[0] as CapturedNetworkExchange;
    expect(offExchange.requestHeaders).toBeUndefined();
    expect(offExchange.responseHeaders).toBeUndefined();

    const on = recorder(true);
    on.recorder.start('h1');
    const save = exchangeOf();
    on.page.emit('request', save.request);
    on.page.emit('response', save.response(201, '{"id":12}'));
    await flush();
    const exchange = on.recorder.stop('h1')?.requests[0] as CapturedNetworkExchange;
    expect(exchange.requestHeaders).toEqual({ 'content-type': 'application/json', 'x-request-id': 'req-7' });
    expect(exchange.responseHeaders).toEqual({
      'content-length': '120',
      'content-type': 'application/json',
      location: '/books/12?…',
      'x-request-id': 'req-7',
    });
    const fields = capturedFieldsOf(exchange);
    expect(fields.requestHeaders).toEqual(exchange.requestHeaders);
    expect(fields.responseHeaders).toEqual(exchange.responseHeaders);
    const text = JSON.stringify(fields);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });

  it('maps step headers to HttpExchange headers, re-checking the allowlist', () => {
    const result = {
      issues: [],
      flows: [
        {
          name: 'creer-livre',
          status: 'FAILED',
          startedAt: '2026-10-30T09:00:00.000Z',
          durationMs: 1000,
          states: [],
          issueIds: [],
          explored: false,
          steps: [
            {
              index: 1,
              kind: 'click',
              description: 'click "Enregistrer"',
              status: 'PASSED',
              optional: false,
              durationMs: 1000,
              network: {
                requests: [
                  {
                    method: 'POST',
                    path: '/api/books',
                    status: 500,
                    resourceType: 'fetch',
                    startedAt: '2026-10-30T09:00:00.200Z',
                    // Un result.json ancien ou modifié : l'authentification n'en sort jamais.
                    requestHeaders: {
                      'content-type': 'application/json',
                      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
                      cookie: 'JSESSIONID=s3ss10n-value',
                    },
                    responseHeaders: { 'x-request-id': 'req-9', 'set-cookie': 'SESSION=s3ss10n-value' },
                  },
                  { method: 'GET', path: '/api/publishers', status: 200, resourceType: 'fetch' },
                ],
                writes: 1,
                errors: 1,
              },
            },
          ],
        },
      ],
    } as unknown as ExplorationResult;
    const run = reproductionFromResult({
      id: 'rep_h',
      scenario: 'creer-livre',
      target: 'LOCAL',
      startedAt: '2026-10-30T08:59:59.000Z',
      result,
      observed: 'erreur HTTP 500',
    });
    const [save, list] = run.requests;
    expect(save?.requestHeaders).toEqual({ 'content-type': 'application/json' });
    expect(save?.responseHeaders).toEqual({ 'x-request-id': 'req-9' });
    expect(list?.requestHeaders).toBeUndefined();
    expect(list?.responseHeaders).toBeUndefined();
    const text = JSON.stringify(run);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });
});
