import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { slug } from '../../knowledge/signatures.js';
import { loadProjectMission, projectConfigSchema } from '../../project/project-config.js';
import { runMission } from '../../orchestrator.js';
import { inFlow } from '../../recording/assertion-proposals.js';
import { runRecording } from '../../recording/record-orchestrator.js';
import {
  decideStoredProposal,
  editStoredGroups,
  generateStoredTests,
  loadStoredRecording,
  storedGroups,
  type StoredRecording,
} from '../../recording/recording-workspace.js';
import type { GroupCommand } from '../../recording/step-groups.js';
import { redactText } from '../../security/redactor.js';
import { readCoreVersion } from '../../tool-identity.js';
import type {
  AssertionProposalView,
  Capabilities,
  DraftIssue,
  ErrorBody,
  ExplorationEvent,
  GenerationResult,
  GroupViewDto,
  Project,
  ProposalDecisionType,
  RecordingSnapshot,
  RecordingStreamEvent,
  ReportEntryKind,
  ReportLink,
  UrlCheck,
} from '../core/contracts.js';
import {
  AUTH_TYPES,
  EXTENSION_NAMES,
  FRAMEWORKS,
  GENERATION_FORMATS,
  RECORDING_NAME_PATTERN,
  SDK_API_VERSION,
} from '../core/contracts.js';
import { ExplorationManager, type MissionRunner } from './explorations.js';
import {
  RecordingBusyError,
  RecordingManager,
  flowView,
  graphView,
  recordingsDir,
  reportEntries,
  storedRecordingNames,
  storedSummary,
  type RecordRunner,
} from './recordings.js';
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
  /** Le recorder ; `runRecording` par défaut (remplaçable seulement pour les tests, qui y jouent l'humain). */
  record?: RecordRunner;
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
  recordings: RecordingManager;
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
  const recordings = new RecordingManager({
    record: options.record ?? runRecording,
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
    recordings,
    edits: new Map(),
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
    recordings,
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
  recordings: RecordingManager;
  /** Une modification à la fois par enregistrement (décisions, groupes, génération écrivent les mêmes fichiers). */
  edits: Map<string, Promise<unknown>>;
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
    const loaded = await projectMission(ctx, project, 'explore');
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
  if (resource === 'projects' && id && sub === 'recordings') {
    await handleRecordings(ctx, await projectOf(ctx, id), segments.slice(4), method, request, url, response);
    return;
  }
  if (resource === 'projects' && id && sub === 'reports') {
    await handleReports(ctx, await projectOf(ctx, id), segments.slice(4), method, request, response);
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
      streamEvents(ctx, exploration, afterOf(url, request), response);
      return;
    }
    if (sub === 'graph' && method === 'GET') {
      if (!exploration.summary)
        throw new HttpError(
          409,
          'NOT_COMPLETED',
          `the exploration is ${exploration.status}: its graph is written at the end`,
        );
      const graph = await graphView(exploration.reportsDir);
      if (!graph) throw new HttpError(404, 'NOT_FOUND', 'the engine wrote no flow-graph.json for this run');
      json(graph);
      return;
    }
    if (sub === 'report-links' && method === 'POST') {
      if (!exploration.summary)
        throw new HttpError(
          409,
          'NOT_COMPLETED',
          `the exploration is ${exploration.status}, it has no report yet`,
        );
      const entry =
        exploration.summary.reports.html ?? exploration.summary.reports.overviewHtml ?? 'index.html';
      json(reportLink(ctx, request, exploration.reportsDir, entry), 201);
      return;
    }
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found');
}

const reportsDirOf = (project: StoredProject): string => path.join(project.dir, REPORTS_DIR);

const afterOf = (url: URL, request: IncomingMessage): number =>
  Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0) || 0;

/**
 * La mission du projet pour une commande du moteur. Les variables d'identifiants sont revérifiées :
 * une variable a pu disparaître du serveur depuis la création du projet.
 */
async function projectMission(
  ctx: Context,
  project: StoredProject,
  command: 'explore' | 'record',
): Promise<Awaited<ReturnType<typeof loadProjectMission>>> {
  const stored = await readProject(project.dir);
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'project not found');
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
  return loadProjectMission(
    { file: path.join(project.dir, PROJECT_FILE), root: project.dir, config: parsed },
    { command, missionName: stored.name },
    {},
    ctx.env,
  );
}

function reportLink(ctx: Context, request: IncomingMessage, directory: string, entry: string): ReportLink {
  const ticket = randomBytes(24).toString('base64url');
  const ttl = ctx.options.reportLinkTtlMs ?? 10 * 60_000;
  ctx.tickets.set(ticket, { reportsDir: directory, expiresAt: Date.now() + ttl });
  const base = (ctx.options.publicUrl ?? `http://${request.headers.host ?? 'localhost'}`).replace(/\/+$/, '');
  return {
    url: `${base}/reports/${ticket}/${entry}`,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  };
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': JSON_TYPE });
  response.end(JSON.stringify(body));
}

const textOf = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : undefined;

// ── Enregistrements ───────────────────────────────────────────────────────────────────────────

async function handleRecordings(
  ctx: Context,
  project: StoredProject,
  rest: string[],
  method: string,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const [rawName, action, itemId, extra] = rest;
  if (rawName === undefined) {
    if (method === 'POST') {
      sendJson(response, await startRecording(ctx, project, await readJson(request)), 202);
      return;
    }
    if (method === 'GET') {
      sendJson(response, await listRecordings(ctx, project));
      return;
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  }
  const name = decodeURIComponent(rawName);
  if (!RECORDING_NAME_PATTERN.test(name) || extra !== undefined)
    throw new HttpError(404, 'NOT_FOUND', 'recording not found');
  const live = ctx.recordings.get(project.id, name);
  if (action === undefined && method === 'GET') {
    if (live) {
      sendJson(response, live.snapshot());
      return;
    }
    const stored = await storedRecordingOf(ctx, project, name);
    sendJson(response, await storedSnapshot(project, stored));
    return;
  }
  if (action === 'stop' && method === 'POST') {
    if (live?.status !== 'RECORDING')
      throw new HttpError(409, 'NOT_RECORDING', `the recording ${name} is not in progress`);
    ctx.recordings.stop(live);
    sendJson(response, live.snapshot(), 202);
    return;
  }
  if (action === 'events' && method === 'GET') {
    if (!live)
      throw new HttpError(
        404,
        'NOT_LIVE',
        'no session of this recording ran on this server since it started',
      );
    streamSse(
      ctx,
      live,
      afterOf(url, request),
      response,
      (event: RecordingStreamEvent) =>
        event.type === 'status' && (event.status === 'COMPLETED' || event.status === 'FAILED'),
    );
    return;
  }
  const language = ctx.rules.reportLanguage;
  if (action === 'flow' && method === 'GET') {
    sendJson(response, await flowView(await storedRecordingOf(ctx, project, name)));
    return;
  }
  if (action === 'assertions' && itemId === undefined && method === 'GET') {
    sendJson(response, proposalViews(await storedRecordingOf(ctx, project, name)));
    return;
  }
  if (action === 'assertions' && itemId !== undefined && method === 'POST') {
    const body = await readJson(request);
    const decision = body.decision;
    if (
      typeof decision !== 'string' ||
      !['ACCEPT', 'REJECT', 'DISABLE', 'RESET', 'MODIFY'].includes(decision)
    )
      throw new HttpError(400, 'BAD_REQUEST', 'decision must be ACCEPT, REJECT, DISABLE, RESET or MODIFY');
    const criticality = body.criticality;
    if (
      criticality !== undefined &&
      (typeof criticality !== 'string' || !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(criticality))
    )
      throw new HttpError(400, 'BAD_REQUEST', 'criticality must be LOW, MEDIUM, HIGH or CRITICAL');
    const description = textOf(body.description, 500);
    const note = textOf(body.note, 500);
    const proposalId = decodeURIComponent(itemId);
    const views = await editRecording(ctx, project, name, async (stored) => {
      const outcome = await decideStoredProposal(
        stored,
        {
          id: proposalId,
          decision: decision as ProposalDecisionType,
          ...(description ? { description } : {}),
          ...(typeof body.mandatory === 'boolean' ? { mandatory: body.mandatory } : {}),
          ...(criticality ? { criticality: criticality as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' } : {}),
          ...(note ? { note } : {}),
        },
        language,
      );
      if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
      return proposalViews(stored);
    });
    sendJson(response, views);
    return;
  }
  if (action === 'groups' && itemId === undefined && method === 'GET') {
    sendJson(response, groupDtos(await storedRecordingOf(ctx, project, name)));
    return;
  }
  if (action === 'groups' && itemId === undefined && method === 'POST') {
    const body = await readJson(request);
    const command = groupCommandOf(body.command);
    const result = await editRecording(ctx, project, name, async (stored) => {
      const outcome = await editStoredGroups(stored, command, { force: body.force === true }, language);
      if ('error' in outcome)
        throw new HttpError(422, 'REFUSED', outcome.error, {
          details: (outcome.violations ?? []).map((violation) => JSON.stringify(violation)),
        });
      return { groups: groupDtos(stored), warnings: outcome.warnings };
    });
    sendJson(response, result);
    return;
  }
  if (action === 'generation' && itemId === undefined && method === 'POST') {
    const body = await readJson(request);
    const formats = Array.isArray(body.formats)
      ? body.formats.filter((format): format is string => typeof format === 'string')
      : [];
    const unknown = formats.filter((format) => !(GENERATION_FORMATS as readonly string[]).includes(format));
    if (formats.length === 0 || unknown.length > 0)
      throw new HttpError(400, 'BAD_REQUEST', `formats must be among ${GENERATION_FORMATS.join(', ')}`);
    const groupIds = Array.isArray(body.groupIds)
      ? body.groupIds.filter((groupId): groupId is string => typeof groupId === 'string')
      : undefined;
    const result = await editRecording(ctx, project, name, async (stored): Promise<GenerationResult> => {
      const outcome = await generateStoredTests(
        stored,
        { formats, ...(groupIds ? { groupIds } : {}), ...(body.force === true ? { force: true } : {}) },
        { baseUrl: new URL(project.targetUrl).origin, language },
      );
      if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
      return {
        warnings: outcome.warnings,
        files: outcome.artifacts.map((artifact) => ({
          format: artifact.format,
          path: artifact.path,
          status: artifact.status,
          ...(artifact.validation ? { validation: artifact.validation } : {}),
          assertions: artifact.assertions,
          limits: artifact.limits,
          content: artifact.content,
        })),
      };
    });
    sendJson(response, result);
    return;
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found');
}

async function startRecording(
  ctx: Context,
  project: StoredProject,
  body: Record<string, unknown>,
): Promise<RecordingSnapshot> {
  const label = textOf(body.name, 80);
  const name = label ? slug(label) : '';
  if (!label || !name)
    throw new HttpError(400, 'BAD_REQUEST', 'name is required (letters, up to 80 characters)');
  const startPath = body.startPath;
  if (
    startPath !== undefined &&
    (typeof startPath !== 'string' || !/^\/(?!\/)[^\s]*$/.test(startPath) || startPath.length > 500)
  )
    throw new HttpError(400, 'BAD_REQUEST', 'startPath must be a path of the application, starting with /');
  const active = ctx.recordings.active();
  if (active)
    throw new HttpError(
      409,
      'RECORDING_ACTIVE',
      `a recording is already in progress (${active.name}): one at a time`,
    );
  const taken =
    (await storedRecordingNames(reportsDirOf(project))).includes(name) ||
    ctx.recordings.get(project.id, name)?.status === 'COMPLETED';
  if (taken)
    throw new HttpError(409, 'NAME_TAKEN', `a recording named ${name} already exists in this project`);
  const loaded = await projectMission(ctx, project, 'record');
  // La CLI rejoue la mission depuis un fichier : le recorder la lit de la même façon.
  const derived = path.join(project.dir, '.derived');
  await mkdir(derived, { recursive: true });
  const missionFile = path.join(derived, 'record.mission.yaml');
  await writeFile(
    missionFile,
    `# Derived by the SDK server from ${PROJECT_FILE} — regenerated at each recording.\n${loaded.missionYaml}`,
    'utf8',
  );
  try {
    const session = ctx.recordings.start({
      projectId: project.id,
      name,
      request: {
        name: label,
        missionFile,
        ...(typeof startPath === 'string' ? { url: startPath } : {}),
        // Un humain joue le parcours : le navigateur est visible, sur la machine du serveur.
        overrides: { headless: false, reportsDir: reportsDirOf(project) },
        env: ctx.env,
        outputFormat: 'both',
        validate: body.validate === true,
        language: ctx.rules.reportLanguage,
        review: false,
      },
    });
    return session.snapshot();
  } catch (error) {
    if (error instanceof RecordingBusyError) throw new HttpError(409, 'RECORDING_ACTIVE', error.message);
    throw error;
  }
}

async function listRecordings(ctx: Context, project: StoredProject): Promise<RecordingSnapshot[]> {
  const live = ctx.recordings.forProject(project.id);
  const names = new Set(live.map((session) => session.name));
  const stored: RecordingSnapshot[] = [];
  for (const name of await storedRecordingNames(reportsDirOf(project))) {
    if (names.has(name)) continue;
    const recording = await loadStoredRecording(path.join(recordingsDir(reportsDirOf(project)), name));
    if (recording) stored.push(await storedSnapshot(project, recording));
  }
  return [...live.map((session) => session.snapshot()), ...stored];
}

async function storedSnapshot(
  project: StoredProject,
  recording: StoredRecording,
): Promise<RecordingSnapshot> {
  return {
    name: path.basename(recording.directory),
    projectId: project.id,
    status: 'STORED',
    ...(recording.startedAt ? { startedAt: recording.startedAt } : {}),
    serverTime: new Date().toISOString(),
    lastSeq: 0,
    summary: await storedSummary(recording),
  };
}

/** L'enregistrement écrit sur disque ; jamais pendant qu'une session l'écrit. */
async function storedRecordingOf(
  ctx: Context,
  project: StoredProject,
  name: string,
): Promise<StoredRecording> {
  const live = ctx.recordings.get(project.id, name);
  if (live && !live.terminal)
    throw new HttpError(409, 'RECORDING_IN_PROGRESS', `the recording ${name} is ${live.status}`);
  const stored = await loadStoredRecording(path.join(recordingsDir(reportsDirOf(project)), name));
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'recording not found');
  return stored;
}

/** Une modification à la fois par enregistrement : chacune relit les fichiers écrits par la précédente. */
async function editRecording<T>(
  ctx: Context,
  project: StoredProject,
  name: string,
  edit: (stored: StoredRecording) => Promise<T>,
): Promise<T> {
  const key = `${project.id}/${name}`;
  const previous = ctx.edits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => edit(await storedRecordingOf(ctx, project, name)));
  ctx.edits.set(key, next);
  try {
    return await next;
  } finally {
    if (ctx.edits.get(key) === next) ctx.edits.delete(key);
  }
}

function proposalViews(stored: StoredRecording): AssertionProposalView[] {
  return (stored.flow.proposals ?? []).map((proposal) => ({
    id: proposal.id,
    origin: proposal.origin,
    category: proposal.category,
    description: proposal.description,
    why: proposal.why,
    verificationMethod: proposal.verificationMethod,
    evidence: proposal.evidence,
    limits: proposal.limits,
    confidence: proposal.confidence,
    needsConfirmation: proposal.needsConfirmation,
    recommended: proposal.recommended,
    status: proposal.status,
    inFlow: inFlow(proposal),
    ...(proposal.afterStepId ? { afterStepId: proposal.afterStepId } : {}),
    ...(proposal.decidedAt ? { decidedAt: proposal.decidedAt } : {}),
    ...(proposal.note ? { note: proposal.note } : {}),
    ...(proposal.conflictsWith ? { conflictsWith: proposal.conflictsWith } : {}),
  }));
}

function groupDtos(stored: StoredRecording): GroupViewDto[] {
  return storedGroups(stored).map((group) => ({
    id: group.id,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    stepIds: group.stepIds,
    positions: group.positions,
    ...(group.collapsed !== undefined ? { collapsed: group.collapsed } : {}),
    startAt: group.startAt,
    checks: group.checks,
    assertionIds: group.assertionIds,
    runnableAlone: group.runnableAlone,
  }));
}

/** La commande de groupe, vérifiée champ par champ (le moteur vérifie ensuite les étapes et les dépendances). */
function groupCommandOf(raw: unknown): GroupCommand {
  const bad = (message: string): HttpError => new HttpError(400, 'BAD_REQUEST', `command: ${message}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('an object is required');
  const value = raw as Record<string, unknown>;
  const text = (key: string, max = 200): string => {
    const field = textOf(value[key], max);
    if (field === undefined) throw bad(`${key} is required`);
    return field;
  };
  const ids = (key: string): string[] => {
    const field = value[key];
    if (!Array.isArray(field) || field.some((item) => typeof item !== 'string') || field.length > 500)
      throw bad(`${key} must be a list of step ids`);
    return field as string[];
  };
  const direction = (): 'up' | 'down' => {
    if (value.direction !== 'up' && value.direction !== 'down') throw bad('direction must be up or down');
    return value.direction;
  };
  switch (value.op) {
    case 'create':
      return {
        op: 'create',
        name: text('name'),
        ...(textOf(value.description, 1000) ? { description: textOf(value.description, 1000) } : {}),
        ...(value.stepIds !== undefined ? { stepIds: ids('stepIds') } : {}),
      };
    case 'rename':
      return { op: 'rename', groupId: text('groupId'), name: text('name') };
    case 'describe':
      return { op: 'describe', groupId: text('groupId'), description: text('description', 1000) };
    case 'assign':
      return { op: 'assign', groupId: text('groupId'), stepIds: ids('stepIds') };
    case 'detach':
      return { op: 'detach', stepIds: ids('stepIds') };
    case 'move-step':
      return { op: 'move-step', stepId: text('stepId'), direction: direction() };
    case 'reorder-steps':
      return { op: 'reorder-steps', groupId: text('groupId'), stepIds: ids('stepIds') };
    case 'move-group':
      return { op: 'move-group', groupId: text('groupId'), direction: direction() };
    case 'collapse':
      if (typeof value.collapsed !== 'boolean') throw bad('collapsed must be true or false');
      return { op: 'collapse', groupId: text('groupId'), collapsed: value.collapsed };
    case 'delete':
      return {
        op: 'delete',
        groupId: text('groupId'),
        ...(typeof value.keepSteps === 'boolean' ? { keepSteps: value.keepSteps } : {}),
      };
    default:
      throw bad('unknown op');
  }
}

// ── Rapports d'un projet ──────────────────────────────────────────────────────────────────────

async function handleReports(
  ctx: Context,
  project: StoredProject,
  rest: string[],
  method: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const [kind, rawName, action, extra] = rest;
  if (kind === undefined && method === 'GET') {
    sendJson(response, await reportEntries(reportsDirOf(project)));
    return;
  }
  if (rawName === undefined || extra !== undefined) throw new HttpError(404, 'NOT_FOUND', 'not found');
  const directory = await reportDirOf(project, kind as ReportEntryKind, decodeURIComponent(rawName));
  if (action === 'graph' && method === 'GET') {
    const graph = await graphView(directory);
    if (!graph) throw new HttpError(404, 'NOT_FOUND', 'no flow-graph.json in this report');
    sendJson(response, graph);
    return;
  }
  if (action === 'links' && method === 'POST') {
    if (!(await exists(path.join(directory, 'index.html'))))
      throw new HttpError(404, 'NOT_FOUND', 'this report has no index.html');
    sendJson(response, reportLink(ctx, request, directory, 'index.html'), 201);
    return;
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found');
}

async function reportDirOf(project: StoredProject, kind: ReportEntryKind, name: string): Promise<string> {
  const directory =
    kind === 'exploration' && /^run-[A-Za-z0-9-]{1,80}$/.test(name)
      ? path.join(reportsDirOf(project), name)
      : kind === 'recording' && RECORDING_NAME_PATTERN.test(name)
        ? path.join(recordingsDir(reportsDirOf(project)), name)
        : undefined;
  const isDir = directory
    ? await stat(directory).then(
        (info) => info.isDirectory(),
        () => false,
      )
    : false;
  if (!directory || !isDir) throw new HttpError(404, 'NOT_FOUND', 'report not found');
  return directory;
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
    extensions: Object.fromEntries(EXTENSION_NAMES.map((name) => [name, true])) as Capabilities['extensions'],
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

interface EventSource<T> {
  terminal: boolean;
  eventsAfter(after: number): T[];
  subscribe(listener: (event: T) => void): () => void;
}

function streamEvents(
  ctx: Context,
  exploration: NonNullable<ReturnType<ExplorationManager['get']>>,
  after: number,
  response: ServerResponse,
): void {
  streamSse(
    ctx,
    exploration,
    after,
    response,
    (event: ExplorationEvent) =>
      event.type === 'status' && (event.status === 'COMPLETED' || event.status === 'FAILED'),
  );
}

/** Un flux SSE numéroté : rejoue après `after`, puis suit jusqu'à l'événement de fin. */
function streamSse<T extends { seq: number; type: string }>(
  ctx: Context,
  source: EventSource<T>,
  after: number,
  response: ServerResponse,
  isEnd: (event: T) => boolean,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  ctx.sseClients.add(response);
  const write = (event: T): void => {
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
  for (const event of source.eventsAfter(after)) write(event);
  if (source.terminal) {
    finish();
    return;
  }
  unsubscribe = source.subscribe((event) => {
    write(event);
    if (isEnd(event)) finish();
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
  '.yml': 'text/plain; charset=utf-8',
  '.feature': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
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
