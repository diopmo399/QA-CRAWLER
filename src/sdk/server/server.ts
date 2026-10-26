import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadProjectMission, projectConfigSchema } from '../../project/project-config.js';
import { runMission } from '../../orchestrator.js';
import { redactText } from '../../security/redactor.js';
import { readCoreVersion } from '../../tool-identity.js';
import type {
  Capabilities,
  DraftIssue,
  ErrorBody,
  ExplorationEvent,
  Project,
  ReportLink,
  UrlCheck,
} from '../core/contracts.js';
import { AUTH_TYPES, EXTENSION_NAMES, FRAMEWORKS, SDK_API_VERSION } from '../core/contracts.js';
import { ExplorationManager, type MissionRunner } from './explorations.js';
import { sdkStandalonePage } from './page.js';
import {
  PROJECT_FILE,
  REPORTS_DIR,
  engineDefaults,
  readProject,
  referencedEnv,
  validateDraft,
  writeProject,
  type ProjectRules,
  type StoredProject,
} from './project.js';

/**
 * LE SERVEUR DU SDK : l'adaptateur entre l'assistant (navigateur) et le moteur QA-CRAWLER (Node).
 * `node:http`, aucune dépendance, lié à 127.0.0.1 par défaut.
 *
 * Sécurité :
 *   - toute l'API exige le jeton (`Authorization: Bearer …`), comparé en temps constant ;
 *   - une requête qui porte un en-tête Origin n'est acceptée que de la même origine ou d'une
 *     origine listée (`allowedOrigins`), qui reçoit alors les en-têtes CORS ;
 *   - les variables d'environnement ne sont lues que si leur nom correspond à `envNames` (QA_* par
 *     défaut) et seule leur présence est renvoyée, jamais leur valeur ;
 *   - les rapports s'ouvrent par un lien de courte durée, servis dans un bac à sable (CSP sandbox) ;
 *   - la politique de sécurité du moteur (chemins exclus, écritures interdites) n'est pas réglable
 *     depuis l'assistant.
 */
export interface SdkServerOptions {
  /** Où les projets sont écrits (un dossier par projet). */
  workspace: string;
  host?: string;
  port?: number;
  /** Le jeton de l'API ; généré au démarrage quand absent. */
  token?: string;
  /** Les origines des applications hôtes autorisées (https://portail.example). */
  allowedOrigins?: string[];
  /** Dossiers sous lesquels un code source Angular peut être lu ; vide (défaut) : analyse statique refusée. */
  allowedSourceRoots?: string[];
  /** Les noms de variables d'environnement que le serveur accepte de consulter (défaut : QA_*). */
  envNames?: RegExp;
  env?: NodeJS.ProcessEnv;
  /** Langue de la page autonome et des rapports du moteur. */
  language?: 'fr' | 'en';
  /** L'adresse publique du serveur (derrière un proxy) ; par défaut, l'hôte de la requête. */
  publicUrl?: string;
  /** Le moteur ; `runMission` par défaut (remplaçable seulement pour les tests). */
  run?: MissionRunner;
  /** Explorations simultanées (défaut 1). */
  concurrency?: number;
  /** Durée de vie d'un lien vers les rapports (défaut 10 min). */
  reportLinkTtlMs?: number;
  /** Délai de la vérification d'accès à une URL (défaut 10 s). */
  urlCheckTimeoutMs?: number;
  onWarning?: (message: string) => void;
}

export interface RunningSdkServer {
  url: string;
  token: string;
  server: Server;
  explorations: ExplorationManager;
  close(): Promise<void>;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { details?: string[]; issues?: DraftIssue[] } = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface ReportTicket {
  reportsDir: string;
  expiresAt: number;
}

export async function startSdkServer(options: SdkServerOptions): Promise<RunningSdkServer> {
  const token = options.token ?? randomBytes(24).toString('base64url');
  const env = options.env ?? process.env;
  const envNames = options.envNames ?? /^QA_[A-Z0-9_]+$/;
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => new URL(origin).origin));
  const rules: ProjectRules = {
    allowedSourceRoots: options.allowedSourceRoots ?? [],
    reportLanguage: options.language ?? 'en',
  };
  const workspace = path.resolve(options.workspace);
  const projects = new Map<string, StoredProject>();
  const tickets = new Map<string, ReportTicket>();
  const explorations = new ExplorationManager({
    run: options.run ?? runMission,
    env,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
  });
  const engineVersion = await readCoreVersion();
  const sseClients = new Set<ServerResponse>();

  const context: Context = {
    token,
    env,
    envNames,
    allowedOrigins,
    rules,
    workspace,
    projects,
    tickets,
    explorations,
    engineVersion,
    options,
    sseClients,
  };

  const server = createServer((request, response) => {
    handle(context, request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
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
    explorations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of sseClients) client.end();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

interface Context {
  token: string;
  env: NodeJS.ProcessEnv;
  envNames: RegExp;
  allowedOrigins: Set<string>;
  rules: ProjectRules;
  workspace: string;
  projects: Map<string, StoredProject>;
  tickets: Map<string, ReportTicket>;
  explorations: ExplorationManager;
  engineVersion: string;
  options: SdkServerOptions;
  sseClients: Set<ServerResponse>;
}

async function handle(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');

  if (segments[0] === 'sdk') return serveModule(segments.slice(1), method, response);
  if (segments[0] === 'reports') return serveReport(ctx, segments.slice(1), method, response);
  if (segments[0] !== 'api') {
    if (method !== 'GET' && method !== 'HEAD')
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    if (segments.length > 0 && segments[0] !== 'index.html')
      throw new HttpError(404, 'NOT_FOUND', 'not found');
    const nonce = randomBytes(16).toString('base64');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
    });
    response.end(
      method === 'HEAD'
        ? undefined
        : sdkStandalonePage({ token: ctx.token, nonce, language: ctx.options.language ?? 'en' }),
    );
    return;
  }

  const origin = checkOrigin(ctx, request, response);
  if (method === 'OPTIONS') {
    if (!origin) throw new HttpError(403, 'ORIGIN_REFUSED', 'origin not allowed');
    response.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-qa-crawler-sdk, last-event-id',
      'access-control-max-age': '600',
    });
    response.end();
    return;
  }
  authorize(ctx, request);
  const [, resource, id, sub] = segments;
  const json = (body: unknown, status = 200): void => {
    response.writeHead(status, { 'content-type': JSON_TYPE });
    response.end(JSON.stringify(body));
  };

  if (resource === 'capabilities' && method === 'GET') {
    json(capabilities(ctx));
    return;
  }
  if (resource === 'checks' && id === 'url' && method === 'POST') {
    const body = await readJson(request);
    json(
      await checkUrl(typeof body.url === 'string' ? body.url : '', ctx.options.urlCheckTimeoutMs ?? 10_000),
    );
    return;
  }
  if (resource === 'checks' && id === 'env' && method === 'POST') {
    const body = await readJson(request);
    const names = Array.isArray(body.names)
      ? body.names.filter((name): name is string => typeof name === 'string')
      : [];
    if (names.length > 20) throw new HttpError(400, 'TOO_MANY', 'at most 20 variable names');
    const refused = names.filter((name) => !ctx.envNames.test(name));
    if (refused.length > 0)
      throw new HttpError(
        400,
        'ENV_NAME_REFUSED',
        `the server does not read these variables: ${refused.join(', ')}`,
      );
    json(
      Object.fromEntries(
        names.map((name) => [name, typeof ctx.env[name] === 'string' && ctx.env[name] !== '']),
      ),
    );
    return;
  }
  if (resource === 'projects' && id === 'validate' && method === 'POST') {
    const body = await readJson(request);
    const { report } = await validate(ctx, body.draft, path.join(ctx.workspace, 'prj_validation'));
    json(report);
    return;
  }
  if (resource === 'projects' && id === undefined && method === 'POST') {
    const body = await readJson(request);
    const projectId = `prj_${randomBytes(9).toString('base64url')}`;
    const dir = path.join(ctx.workspace, projectId);
    const { report, draft } = await validate(ctx, body.draft, dir);
    if (!report.ok || !draft)
      throw new HttpError(422, 'DRAFT_INVALID', 'the project is not valid', { issues: report.blocking });
    const stored = await writeProject(dir, projectId, draft, ctx.rules);
    ctx.projects.set(projectId, stored);
    json(publicProject(stored), 201);
    return;
  }
  if (resource === 'projects' && id && sub === undefined && method === 'GET') {
    json(publicProject(await projectOf(ctx, id)));
    return;
  }
  if (resource === 'projects' && id && sub === 'explorations' && method === 'POST') {
    const project = await projectOf(ctx, id);
    const stored = await readProject(project.dir);
    if (!stored) throw new HttpError(404, 'NOT_FOUND', 'project not found');
    // Revalider au lancement : une variable d'environnement a pu disparaître depuis la création.
    const missing = referencedEnv(stored.draft).filter(
      (name) => !(typeof ctx.env[name] === 'string' && ctx.env[name] !== ''),
    );
    if (missing.length > 0)
      throw new HttpError(
        422,
        'ENV_MISSING',
        `missing environment variables on the server: ${missing.join(', ')}`,
        {
          issues: missing.map((name) => ({
            step: 'environment' as const,
            field: 'auth',
            message: `${name} is not defined`,
          })),
        },
      );
    const document = parseYaml(await readFile(path.join(project.dir, PROJECT_FILE), 'utf8')) as {
      qaCrawler?: unknown;
    };
    const parsed = projectConfigSchema.parse(document.qaCrawler);
    const loaded = await loadProjectMission(
      { file: path.join(project.dir, PROJECT_FILE), root: project.dir, config: parsed },
      { command: 'explore', missionName: stored.name },
      {},
      ctx.env,
    );
    const exploration = ctx.explorations.start({
      projectId: project.id,
      config: loaded.config,
      reportsDir: path.join(
        project.dir,
        REPORTS_DIR,
        `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      ),
    });
    json(exploration.snapshot(), 202);
    return;
  }
  if (resource === 'explorations' && id) {
    if (!ID_PATTERN.test(id)) throw new HttpError(404, 'NOT_FOUND', 'exploration not found');
    const exploration = ctx.explorations.get(id);
    if (!exploration) throw new HttpError(404, 'NOT_FOUND', 'exploration not found');
    if (sub === undefined && method === 'GET') {
      json(exploration.snapshot());
      return;
    }
    if (sub === 'result' && method === 'GET') {
      if (!exploration.summary)
        throw new HttpError(
          409,
          'NOT_COMPLETED',
          `the exploration is ${exploration.status}, it has no result yet`,
        );
      json(exploration.summary);
      return;
    }
    if (sub === 'events' && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0) || 0;
      streamEvents(ctx, exploration, after, response);
      return;
    }
    if (sub === 'report-links' && method === 'POST') {
      if (!exploration.summary)
        throw new HttpError(
          409,
          'NOT_COMPLETED',
          `the exploration is ${exploration.status}, it has no report yet`,
        );
      const ticket = randomBytes(24).toString('base64url');
      const ttl = ctx.options.reportLinkTtlMs ?? 10 * 60_000;
      ctx.tickets.set(ticket, { reportsDir: exploration.reportsDir, expiresAt: Date.now() + ttl });
      const base = (ctx.options.publicUrl ?? `http://${request.headers.host ?? 'localhost'}`).replace(
        /\/+$/,
        '',
      );
      const entry =
        exploration.summary.reports.html ?? exploration.summary.reports.overviewHtml ?? 'index.html';
      const link: ReportLink = {
        url: `${base}/reports/${ticket}/${entry}`,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      };
      json(link, 201);
      return;
    }
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found');
}

function capabilities(ctx: Context): Capabilities {
  return {
    apiVersion: SDK_API_VERSION,
    engineVersion: ctx.engineVersion,
    browsers: ['chromium'],
    frameworks: FRAMEWORKS,
    authTypes: AUTH_TYPES,
    defaults: engineDefaults(),
    staticAnalysis: ctx.rules.allowedSourceRoots.length > 0,
    cancellation: false,
    extensions: Object.fromEntries(
      EXTENSION_NAMES.map((name) => [name, false]),
    ) as Capabilities['extensions'],
  };
}

async function validate(ctx: Context, raw: unknown, dir: string): ReturnType<typeof validateDraft> {
  const outcome = await validateDraft(raw, ctx.rules, ctx.env, dir);
  if (outcome.draft) {
    // Les noms de variables que le serveur refuse de lire sont un problème bloquant, pas une absence.
    const refused = referencedEnv(outcome.draft).filter((name) => !ctx.envNames.test(name));
    if (refused.length > 0) {
      const issues = refused.map((name) => ({
        step: 'environment' as const,
        field: 'auth',
        message: `the QA-CRAWLER server only reads environment variables matching ${ctx.envNames.source}: ${name}`,
      }));
      const blocking = [
        ...outcome.report.blocking.filter((issue) => !refused.some((name) => issue.message.includes(name))),
        ...issues,
      ];
      const environment = Object.fromEntries(
        Object.entries(outcome.report.environment).filter(([name]) => !refused.includes(name)),
      );
      const { projectFile: _hidden, ...rest } = outcome.report;
      return { ...outcome, report: { ...rest, ok: false, blocking, environment } };
    }
  }
  return outcome;
}

async function projectOf(ctx: Context, id: string): Promise<StoredProject> {
  if (!ID_PATTERN.test(id)) throw new HttpError(404, 'NOT_FOUND', 'project not found');
  const known = ctx.projects.get(id);
  if (known) return known;
  const stored = await readProject(path.join(ctx.workspace, id));
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'project not found');
  ctx.projects.set(id, stored);
  return stored;
}

function publicProject(project: StoredProject): Project {
  return {
    id: project.id,
    name: project.name,
    ...(project.description ? { description: project.description } : {}),
    framework: project.framework,
    targetUrl: project.targetUrl,
    createdAt: project.createdAt,
    status: 'PROJECT_CREATED',
  };
}

function streamEvents(
  ctx: Context,
  exploration: NonNullable<ReturnType<ExplorationManager['get']>>,
  after: number,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  ctx.sseClients.add(response);
  const write = (event: ExplorationEvent): void => {
    response.write(`id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  let unsubscribe = (): void => undefined;
  const finish = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    ctx.sseClients.delete(response);
    response.end();
  };
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
  for (const event of exploration.eventsAfter(after)) write(event);
  if (exploration.terminal) {
    finish();
    return;
  }
  unsubscribe = exploration.subscribe((event) => {
    write(event);
    if (event.type === 'status' && (event.status === 'COMPLETED' || event.status === 'FAILED')) finish();
  });
  response.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    ctx.sseClients.delete(response);
  });
}

async function checkUrl(raw: string, timeoutMs: number): Promise<UrlCheck> {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value))
    return { format: { ok: false, message: 'the address must start with http:// or https://' } };
  const started = Date.now();
  try {
    const answer = await fetch(value, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await answer.body?.cancel().catch(() => undefined);
    return {
      format: { ok: true },
      reachable: { ok: answer.status < 500, status: answer.status, durationMs: Date.now() - started },
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      format: { ok: true },
      reachable: {
        ok: false,
        durationMs: Date.now() - started,
        message: timedOut
          ? `no answer within ${String(Math.round(timeoutMs / 1000))} s`
          : redactText(
              error instanceof Error
                ? error.cause instanceof Error
                  ? error.cause.message
                  : error.message
                : String(error),
            ),
      },
    };
  }
}

/** L'origine de la requête : même origine, ou listée. Renvoie l'origine acceptée (ou la même origine implicite). */
function checkOrigin(ctx: Context, request: IncomingMessage, response: ServerResponse): string | undefined {
  const origin = request.headers.origin;
  if (!origin) return 'same-origin';
  const own = `http://${request.headers.host ?? ''}`;
  const publicOrigin = ctx.options.publicUrl ? new URL(ctx.options.publicUrl).origin : undefined;
  if (origin === own || origin === publicOrigin) return origin;
  if (ctx.allowedOrigins.has(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    return origin;
  }
  throw new HttpError(403, 'ORIGIN_REFUSED', 'origin not allowed');
}

function authorize(ctx: Context, request: IncomingMessage): void {
  const header = request.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(given);
  const b = Buffer.from(ctx.token);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new HttpError(401, 'UNAUTHORIZED', 'missing or invalid token');
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = request.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'TOO_LARGE', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new HttpError(400, 'BAD_REQUEST', 'expected a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'BAD_REQUEST', 'invalid JSON body');
  }
}

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_CACHE = new Map<string, string>();

/** Les modules navigateur du SDK (core/*, ui/*) : le .js compilé, ou le .ts transpilé à la volée en développement. */
async function serveModule(parts: string[], method: string, response: ServerResponse): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD')
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  const [folder, file] = parts;
  if (parts.length !== 2 || (folder !== 'core' && folder !== 'ui') || !file || !/^[a-z0-9-]+\.js$/.test(file))
    throw new HttpError(404, 'NOT_FOUND', 'not found');
  const key = `${folder}/${file}`;
  let code = MODULE_CACHE.get(key);
  if (code === undefined) {
    const compiled = path.join(SDK_ROOT, folder, file);
    const source = path.join(SDK_ROOT, folder, file.replace(/\.js$/, '.ts'));
    if (await exists(compiled)) code = await readFile(compiled, 'utf8');
    else if (await exists(source)) {
      const ts = (await import('typescript')).default;
      code = ts.transpileModule(await readFile(source, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, sourceMap: false },
        fileName: source,
      }).outputText;
    } else throw new HttpError(404, 'NOT_FOUND', 'not found');
    MODULE_CACHE.set(key, code);
  }
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    // Du code public, sans secret : chargeable par toute application hôte.
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'no-cache',
  });
  response.end(method === 'HEAD' ? undefined : code);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': JSON_TYPE,
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
};

async function serveReport(
  ctx: Context,
  parts: string[],
  method: string,
  response: ServerResponse,
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD')
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  const [ticket, ...rest] = parts;
  const entry = ticket ? ctx.tickets.get(ticket) : undefined;
  if (!entry || entry.expiresAt < Date.now()) {
    if (ticket) ctx.tickets.delete(ticket);
    throw new HttpError(
      404,
      'LINK_EXPIRED',
      'this report link has expired; open the report again from the wizard',
    );
  }
  const relative = rest.map(decodeURIComponent).join('/');
  const file = path.resolve(entry.reportsDir, relative);
  if (!file.startsWith(`${path.resolve(entry.reportsDir)}${path.sep}`) || !(await exists(file)))
    throw new HttpError(404, 'NOT_FOUND', 'not found');
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) throw new HttpError(404, 'NOT_FOUND', 'not found');
  response.writeHead(200, {
    'content-type': type,
    // Le rapport s'exécute dans un bac à sable : aucun accès à l'origine du serveur ni à ses jetons.
    'content-security-policy':
      "sandbox allow-scripts allow-popups; default-src 'self' 'unsafe-inline' data: blob:",
  });
  response.end(method === 'HEAD' ? undefined : await readFile(file));
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

function sendError(response: ServerResponse, error: unknown): void {
  const http = error instanceof HttpError ? error : undefined;
  const status = http?.status ?? 500;
  const body: ErrorBody = {
    error: redactText(error instanceof Error ? error.message : String(error)),
    status,
    code: http?.code ?? 'INTERNAL',
    ...(http?.extra.details ? { details: http.extra.details } : {}),
    ...(http?.extra.issues ? { issues: http.extra.issues } : {}),
  };
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': JSON_TYPE });
  response.end(JSON.stringify(body));
}
