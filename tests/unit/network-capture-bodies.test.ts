import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from 'playwright';
import { describe, expect, it } from 'vitest';
import { scenarioSchema } from '../../src/config/config.js';
import {
  capturedFieldsOf,
  isTextualContentType,
  MAX_CAPTURED_BODY,
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
}): FakeExchange {
  const request = {
    method: () => input.method,
    url: () => input.url,
    resourceType: () => input.resourceType,
    postData: () => input.body ?? null,
    headers: () => (input.type ? { 'content-type': input.type } : {}),
    failure: () => null,
  } as unknown as Request;
  return {
    request,
    response: (status, body, type = 'application/json') =>
      ({
        request: () => request,
        status: () => status,
        headers: () => ({ 'content-type': type }),
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
