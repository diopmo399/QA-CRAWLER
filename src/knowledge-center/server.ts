import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redactText } from '../security/redactor.js';
import { ReviewConflictError } from './review-ledger.js';
import {
  ImportValidationError,
  KnowledgeExchange,
  parseKnowledgeExport,
  DEFAULT_IMPORT_POLICY,
  type ImportPolicy,
} from './exchange.js';
import type {
  KnowledgeOrigin,
  KnowledgeSource,
  KnowledgeType,
  ReliabilityStatus,
  SearchQuery,
} from './model.js';
import { KNOWLEDGE_ORIGINS, KNOWLEDGE_TYPES, RELIABILITY_STATUSES } from './model.js';
import { knowledgeCenterPage } from './page.js';
import { KnowledgeNotFoundError, ReadOnlyError, type KnowledgeCenterService } from './service.js';

/**
 * LE SERVEUR DU KNOWLEDGE CENTER : `node:http`, aucune dépendance, lié à 127.0.0.1 par défaut. Une
 * page (page.ts) et une API JSON locale. Les opérations d'écriture exigent :
 *   - un en-tête personnalisé (`X-QA-Knowledge-Center: 1`) — un formulaire d'un autre site ne peut
 *     pas l'envoyer ;
 *   - le jeton de session (`Authorization: Bearer …`), généré au démarrage et porté par la page ;
 *   - une origine, quand le navigateur l'envoie, égale à celle du serveur ;
 *   - un serveur qui n'est pas en lecture seule.
 * Aucune donnée de configuration n'est modifiable par l'API : elle est lue, montrée, jamais écrite.
 */
export interface ServerOptions {
  host: string;
  port: number;
  /** Le jeton des opérations d'écriture ; généré quand absent. */
  token?: string;
  /** Lien proposé dans la page vers la documentation. */
  docsUrl?: string;
}

export interface RunningServer {
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export async function startKnowledgeCenterServer(
  service: KnowledgeCenterService,
  options: ServerOptions,
): Promise<RunningServer> {
  const token = options.token ?? randomBytes(24).toString('base64url');
  const exchange = new KnowledgeExchange(service.context);
  const page = knowledgeCenterPage({
    language: service.context.options.language,
    token,
    readOnly: service.context.options.readOnly,
    ...(options.docsUrl ? { docsUrl: options.docsUrl } : {}),
  });
  const server = createServer((request, response) => {
    handle(service, exchange, page, token, request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${String(address.port)}`,
    token,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

async function handle(
  service: KnowledgeCenterService,
  exchange: KnowledgeExchange,
  page: string,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  if (segments[0] !== 'api') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (segments.length > 0 && segments[0] !== 'index.html') throw new HttpError(404, 'not found');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'",
    });
    response.end(method === 'HEAD' ? undefined : page);
    return;
  }
  if (method === 'POST') authorize(request, token, service.context.options.readOnly);
  const [, resource, ...rest] = segments;
  const json = (body: unknown, status = 200): void => {
    response.writeHead(status, { 'content-type': JSON_TYPE });
    response.end(JSON.stringify(body));
  };

  if (resource === 'meta' && method === 'GET') {
    json({
      applications: await service.applications(),
      vocabulary: service.vocabulary(),
      memory: service.memoryState(),
      options: {
        readOnly: service.context.options.readOnly,
        language: service.context.options.language,
        staleAfterDays: service.context.options.staleAfterDays,
        limit: service.context.options.limit,
      },
      crawlerVersion: service.context.crawlerVersion,
      mission: service.context.config.mission.name,
      warnings: service.context.warnings,
    });
    return;
  }
  if (resource === 'refresh' && method === 'POST') {
    service.refresh();
    json({ refreshed: true });
    return;
  }
  if (resource === 'backups') {
    if (method === 'GET' && rest.length === 0) {
      json({ backups: await exchange.backups() });
      return;
    }
    if (method === 'POST' && rest.length === 2 && rest[1] === 'restore') {
      const body = await readJsonBody(request);
      json(await exchange.restore(rest[0] ?? '', optionalString(body, 'reason')));
      return;
    }
    throw new HttpError(404, 'not found');
  }
  if (resource !== 'apps' || rest.length === 0) throw new HttpError(404, 'not found');
  const applicationId = rest[0] ?? '';
  const action = rest[1];
  if (method === 'GET') {
    switch (action) {
      case 'overview':
        json(await service.overview(applicationId));
        return;
      case 'items':
        if (rest[2]) json(await service.item(applicationId, rest[2]));
        else json(await service.search(applicationId, searchQueryOf(url.searchParams)));
        return;
      case 'flows':
        json(await service.flows(applicationId));
        return;
      case 'graph':
        json(await service.graph(applicationId));
        return;
      case 'variables':
        json(await service.variables(applicationId));
        return;
      case 'quality':
        json(await service.quality(applicationId));
        return;
      case 'history':
        json(await service.history(applicationId));
        return;
      case 'persistence':
        json(await service.persistence(applicationId));
        return;
      case 'export': {
        const document = await exchange.exportApplication(applicationId);
        const name = `knowledge-${applicationId.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${document.exportedAt.slice(0, 19).replace(/[:]/g, '-')}.json`;
        response.writeHead(200, {
          'content-type': JSON_TYPE,
          'content-disposition': `attachment; filename="${name}"`,
        });
        response.end(JSON.stringify(document, null, 2));
        return;
      }
      default:
        throw new HttpError(404, 'not found');
    }
  }
  if (method === 'POST') {
    const body = await readJsonBody(request);
    if (action === 'items' && rest[2] && rest[3] === 'decision') {
      const operation = optionalString(body, 'operation');
      if (operation !== 'VALIDATE' && operation !== 'INVALIDATE' && operation !== 'RESET')
        throw new HttpError(400, 'operation must be VALIDATE, INVALIDATE or RESET');
      const expectedVersion = (body as { expectedVersion?: unknown }).expectedVersion;
      if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0)
        throw new HttpError(400, 'expectedVersion must be a non-negative integer');
      json(
        await service.decide(applicationId, {
          itemId: rest[2],
          operation,
          expectedVersion,
          ...(optionalString(body, 'note') ? { note: optionalString(body, 'note')?.slice(0, 2000) } : {}),
          ...(optionalString(body, 'reason')
            ? { reason: optionalString(body, 'reason')?.slice(0, 2000) }
            : {}),
        }),
      );
      return;
    }
    if (action === 'import' && (rest[2] === 'preview' || rest[2] === 'apply')) {
      const document = parseKnowledgeExport((body as { document?: unknown }).document);
      if (document.application.id !== applicationId)
        throw new HttpError(
          400,
          `the export is for application "${document.application.id}", not "${applicationId}"`,
        );
      const policy = policyOf((body as { policy?: unknown }).policy);
      if (rest[2] === 'preview') json(await exchange.preview(document, policy));
      else json(await exchange.apply(document, policy, optionalString(body, 'reason')));
      return;
    }
    if (action === 'backups' && rest.length === 2) {
      json(await exchange.backup(applicationId, optionalString(body, 'reason')));
      return;
    }
  }
  throw new HttpError(404, 'not found');
}

function authorize(request: IncomingMessage, token: string, readOnly: boolean): void {
  if (readOnly)
    throw new HttpError(
      403,
      'the Knowledge Center runs read-only (--read-only): no write operation is possible',
    );
  if (request.headers['x-qa-knowledge-center'] !== '1')
    throw new HttpError(403, 'missing X-QA-Knowledge-Center header');
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin === 'string' && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'invalid origin');
    }
    if (!host || originHost !== host) throw new HttpError(403, 'origin not allowed');
  }
  const authorization = request.headers.authorization ?? '';
  const given = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  const expected = Buffer.from(token);
  const provided = Buffer.from(given);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw new HttpError(401, 'invalid token');
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = request.headers['content-type'] ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `body larger than ${String(MAX_BODY_BYTES)} bytes`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new HttpError(400, 'expected a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid JSON body');
  }
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function policyOf(raw: unknown): ImportPolicy {
  const given = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof ImportPolicy, unknown>>) : {};
  const choice = (value: unknown, fallback: 'skip' | 'replace'): 'skip' | 'replace' =>
    value === 'replace' ? 'replace' : value === 'skip' ? 'skip' : fallback;
  return {
    replaceable: choice(given.replaceable, DEFAULT_IMPORT_POLICY.replaceable),
    files: choice(given.files, DEFAULT_IMPORT_POLICY.files),
    backupFirst:
      typeof given.backupFirst === 'boolean' ? given.backupFirst : DEFAULT_IMPORT_POLICY.backupFirst,
  };
}

function searchQueryOf(params: URLSearchParams): SearchQuery {
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const value = params.get(key);
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
  };
  const integer = (key: string): number | undefined => {
    const value = Number(params.get(key));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const text = params.get('text')?.slice(0, 200);
  const type = pick<KnowledgeType>('type', KNOWLEDGE_TYPES);
  const status = pick<ReliabilityStatus>('status', RELIABILITY_STATUSES);
  const origin = pick<KnowledgeOrigin>('origin', KNOWLEDGE_ORIGINS);
  const source = pick<KnowledgeSource>('source', [
    'PERSISTENCE',
    'KNOWLEDGE_FILE',
    'FUNCTIONAL_FILE',
    'RULES_FILE',
  ]);
  const review = pick('review', ['VALIDATED', 'INVALIDATED', 'NONE'] as const);
  const sort = pick('sort', ['updatedAt', 'createdAt', 'title', 'type', 'status', 'evidence'] as const);
  const direction = pick('direction', ['asc', 'desc'] as const);
  return {
    ...(text ? { text } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(origin ? { origin } : {}),
    ...(source ? { source } : {}),
    ...(review ? { review } : {}),
    ...(sort ? { sort } : {}),
    ...(direction ? { direction } : {}),
    ...(integer('page') !== undefined ? { page: integer('page') } : {}),
    ...(integer('pageSize') !== undefined ? { pageSize: integer('pageSize') } : {}),
  };
}

function sendError(response: ServerResponse, error: unknown): void {
  const status =
    error instanceof HttpError
      ? error.status
      : error instanceof KnowledgeNotFoundError
        ? 404
        : error instanceof ReviewConflictError
          ? 409
          : error instanceof ReadOnlyError
            ? 403
            : error instanceof ImportValidationError
              ? 400
              : 500;
  const details = error instanceof HttpError || error instanceof ImportValidationError ? error.details : [];
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (!response.headersSent) response.writeHead(status, { 'content-type': JSON_TYPE });
  response.end(JSON.stringify({ error: message, status, ...(details.length > 0 ? { details } : {}) }));
}
