import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { slug } from '../../knowledge/signatures.js';
import { loadProjectMission, projectConfigSchema } from '../../project/project-config.js';
import { runMission } from '../../orchestrator.js';
import { inFlow } from '../../recording/assertion-proposals.js';
import {
  replayRecordedFlow,
  runRecording,
  type RecordedFlowReplay,
} from '../../recording/record-orchestrator.js';
import type { ReplayOutcome } from '../../recording/recording-report.js';
import { loadConfigFile } from '../../config/config-loader.js';
import { CorrectionBusyError, CorrectionManager, type CorrectionRuntime } from './corrections.js';
import {
  acceptStoredGroupProposals,
  addStoredGroupCheck,
  bindStoredTestData,
  editStoredRow,
  restoreStoredTarget,
  reviewStoredIntent,
  storedIntents,
  storedRowSource,
  decideStoredProposal,
  editStoredGroups,
  FLOW_FILES,
  generateStoredTests,
  loadStoredRecording,
  removeStoredStep,
  storedGroupChecks,
  storedGroupProposals,
  storedGroups,
  storedTestData,
  type StoredRecording,
} from '../../recording/recording-workspace.js';
import type { GroupCommand, GroupProposal } from '../../recording/step-groups.js';
import { redactText } from '../../security/redactor.js';
import { readCoreVersion } from '../../tool-identity.js';
import type {
  AssertionProposalView,
  Capabilities,
  DraftIssue,
  ErrorBody,
  ExplorationEvent,
  GenerationResult,
  GroupProposalView,
  RecordingReplayView,
  RowColumnInput,
  DataBindingResult,
  GroupViewDto,
  Project,
  TestDataView,
  ProposalDecisionType,
  RecordingSnapshot,
  RecordingStreamEvent,
  ReportEntryKind,
  ReportLink,
  UrlCheck,
  Environment,
  ProjectDetail,
  ProjectSummary,
  AccessMe,
  JournalKind,
} from '../core/contracts.js';
import {
  JOURNAL_KINDS,
  ROLE_RIGHTS,
  AUTH_TYPES,
  DATA_SOURCES,
  EXTENSION_NAMES,
  FRAMEWORKS,
  GENERATION_FORMATS,
  RECORDING_CONTROLS,
  RECORDING_NAME_PATTERN,
  SDK_API_VERSION,
} from '../core/contracts.js';
import { isTerminal } from '../core/lifecycle.js';
import { ExplorationManager, type MissionRunner } from './explorations.js';
import {
  RecordingBusyError,
  RecordingManager,
  assertionVerdicts,
  flowView,
  graphView,
  recordingsDir,
  reportEntries,
  storedRecordingNames,
  storedSummary,
  studioView,
  type RecordRunner,
} from './recordings.js';
import { compareRuns, regressionView, traceabilityView } from './runs.js';
import {
  applyEnvironment,
  checkEnvironmentShape,
  computeOverview,
  executionDetail,
  flowsDirOf,
  isRunName,
  listExecutions,
  listScenarios,
  scenarioHistory,
  newEnvironmentId,
  promoteRecording,
  readEnvironments,
  writeEnvironments,
  writeExecutionMeta,
} from './platform.js';
import {
  addLink,
  decide,
  decideLink,
  PipelineError,
  publish,
  type DecisionInput,
} from '../../requirements/pipeline.js';
import { DECISION_ACTIONS, LINK_TYPES, type LinkType } from '../../requirements/model.js';
import {
  computeIndicators,
  computeTrends,
  connectorViews,
  FILE_CONNECTORS,
  importConfluence,
  importFile,
  matrixCsv,
  matrixOf,
  maxFileBytes,
  pendingCandidates,
  RequirementsInputError,
  storeOf,
  summaryOf,
  type FileConnectorKind,
} from './requirements.js';
import { AccessError, AccessStore, actionOf, can, rightFor, roleIn, type Identity } from './access.js';
import { dashboardPage, flowStudioHtml, runComparePage, runMonitorPage, sdkStandalonePage } from './page.js';
import {
  ALWAYS_BLOCKED_RISKS,
  PROJECT_FILE,
  REPORTS_DIR,
  engineDefaults,
  readProject,
  setProjectState,
  updateProject,
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
  /** La correction de cible : navigateur visible par défaut ; les tests la pilotent sans fenêtre. */
  correction?: CorrectionRuntime;
  /** Le rejeu de validation d'un enregistrement ; `replayRecordedFlow` par défaut (remplaçable pour les tests). */
  replayRecording?: (input: RecordedFlowReplay) => Promise<ReplayOutcome>;
  /** Explorations simultanées (défaut 1). */
  concurrency?: number;
  /**
   * `single` (défaut) : le jeton du service, que les pages servies portent. `named` : des jetons
   * nominatifs (rôles, journal) ; les pages ne portent aucun jeton, chacun se connecte avec le sien.
   */
  access?: 'single' | 'named';
  /** Durée de vie d'un lien vers les rapports (défaut 10 min). */
  reportLinkTtlMs?: number;
  /** Délai de la vérification d'accès à une URL (défaut 10 s). */
  urlCheckTimeoutMs?: number;
  /**
   * À l'arrêt du serveur, les explorations en cours sont annulées : combien de temps attendre que le
   * moteur se soit arrêté et ait écrit son rapport (défaut 30 s).
   */
  closeGraceMs?: number;
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
  const corrections = new CorrectionManager(options.correction);
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
    replays: new Map(),
    corrections,
    engineVersion,
    options,
    sseClients,
    access: new AccessStore(workspace),
    mode: options.access ?? 'single',
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
    close: async () => {
      corrections.closeAll();
      // Arrêt contrôlé : rien n'est laissé tourner, les rapports des explorations arrêtées sont écrits.
      if (explorations.cancelAll() > 0) {
        const settled = await explorations.idle(options.closeGraceMs ?? 30_000);
        if (!settled) options.onWarning?.('an exploration was still stopping when the server closed');
      }
      await new Promise<void>((resolve, reject) => {
        for (const client of sseClients) client.end();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    },
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
  /** Les rejeux de validation lancés depuis le SDK, par enregistrement (projet/nom). */
  replays: Map<string, RecordingReplayView>;
  /** La session de correction de cible ouverte (une à la fois). */
  corrections: CorrectionManager;
  engineVersion: string;
  options: SdkServerOptions;
  sseClients: Set<ServerResponse>;
  access: AccessStore;
  mode: 'single' | 'named';
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
    const studio = segments.length === 1 && segments[0] === 'studio';
    const runs = segments.length === 1 && segments[0] === 'runs';
    const monitor = segments.length === 1 && segments[0] === 'monitor';
    const dashboard = segments.length === 1 && segments[0] === 'dashboard';
    if (segments.length > 0 && segments[0] !== 'index.html' && !studio && !runs && !monitor && !dashboard)
      throw new HttpError(404, 'NOT_FOUND', 'not found');
    const nonce = randomBytes(16).toString('base64');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
    });
    response.end(
      method === 'HEAD'
        ? undefined
        : (studio
            ? flowStudioHtml
            : runs
              ? runComparePage
              : monitor
                ? runMonitorPage
                : dashboard
                  ? dashboardPage
                  : sdkStandalonePage)({
            token: ctx.mode === 'named' ? null : ctx.token,
            nonce,
            language: ctx.options.language ?? 'en',
          }),
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
  const identity = await authorize(ctx, request);
  IDENTITIES.set(request, identity);
  const [, resource, id, sub] = segments;
  checkRight(ctx, identity, segments, method, response);
  const json = (body: unknown, status = 200): void => {
    response.writeHead(status, { 'content-type': JSON_TYPE });
    response.end(JSON.stringify(body));
  };

  if (resource === 'capabilities' && method === 'GET') {
    json(capabilities(ctx));
    return;
  }
  if (resource === 'access') {
    await handleAccess(ctx, identity, segments, method, request, url, json);
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
  if (await handlePlatform(ctx, segments, method, request, url, json)) return;
  if (resource === 'projects' && id && sub === 'explorations' && method === 'POST') {
    const project = await projectOf(ctx, id);
    refuseArchived(project);
    const body = await readOptionalJson(request);
    const environment = await environmentOf(project, body.environmentId);
    requireWrites(request, project.id, environment);
    const loaded = await projectMission(ctx, project, 'explore', { ...(environment ? { environment } : {}) });
    const reportsDir = path.join(
      project.dir,
      REPORTS_DIR,
      `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
    await writeExecutionMeta(reportsDir, {
      kind: 'EXPLORATION',
      startedAt: new Date().toISOString(),
      ...(environment ? { environment: { id: environment.id, name: environment.name } } : {}),
    });
    const exploration = ctx.explorations.start({
      projectId: project.id,
      config: loaded.config,
      reportsDir,
      kind: 'EXPLORATION',
      env: missionEnv(ctx, environment),
    });
    json(exploration.snapshot(), 202);
    return;
  }
  if (resource === 'projects' && id && sub === 'requirements') {
    await handleRequirements(
      ctx,
      await projectOf(ctx, id),
      segments.slice(4),
      method,
      request,
      url,
      response,
    );
    return;
  }
  if (resource === 'trends' && id === undefined && method === 'GET') {
    const projectId = url.searchParams.get('projectId') ?? undefined;
    const projects = projectId
      ? [await projectOf(ctx, projectId)]
      : (await workspaceProjects(ctx)).filter((project) => project.state !== 'ARCHIVED');
    const inputs = await Promise.all(
      projects.map(async (project) => ({
        id: project.id,
        name: project.name,
        reportsDir: path.join(project.dir, REPORTS_DIR),
        repository: await storeOf(project.dir).readRepository(),
      })),
    );
    json(
      await computeTrends(inputs, {
        weeks: Number(url.searchParams.get('weeks') ?? '8'),
        ...(projectId ? { projectId } : {}),
      }),
    );
    return;
  }
  if (resource === 'projects' && id && sub === 'recordings') {
    await handleRecordings(ctx, await projectOf(ctx, id), segments.slice(4), method, request, url, response);
    return;
  }
  if (resource === 'projects' && id && sub === 'reports') {
    await handleReports(ctx, await projectOf(ctx, id), segments.slice(4), method, request, url, response);
    return;
  }
  if (resource === 'explorations' && id) {
    if (!ID_PATTERN.test(id)) throw new HttpError(404, 'NOT_FOUND', 'exploration not found');
    const exploration = ctx.explorations.get(id);
    if (!exploration) throw new HttpError(404, 'NOT_FOUND', 'exploration not found');
    if (sub === 'cancel' && method === 'POST') {
      // L'annulation contrôlée : jamais lancée si elle attend, arrêt du moteur sinon (rapport écrit).
      if (!ctx.explorations.cancel(id))
        throw new HttpError(409, 'NOT_CANCELLABLE', `the exploration is already ${exploration.status}`);
      json(exploration.snapshot(), 202);
      return;
    }
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
  command: 'explore' | 'record' | 'replay',
  extra: { flows?: string[]; extraFlows?: Record<string, unknown>[]; environment?: Environment } = {},
): Promise<Awaited<ReturnType<typeof loadProjectMission>>> {
  const stored = await readProject(project.dir);
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'project not found');
  const missing = [...referencedEnv(stored.draft), ...(extra.environment?.secretEnv ?? [])].filter(
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
    {
      command,
      missionName: stored.name,
      ...(extra.flows ? { flows: extra.flows } : {}),
      ...(extra.extraFlows ? { extraFlows: extra.extraFlows } : {}),
    },
    {},
    missionEnv(ctx, extra.environment),
  );
  // L'environnement choisi : cible, domaines, délais et limites ; ses variables passent par `env`.
  if (extra.environment) applyEnvironment(loaded.config, extra.environment);
  return loaded;
}

/** Les variables d'environnement d'exécution d'une mission : celles du serveur, plus les variables non secrètes choisies. */
function missionEnv(ctx: Context, environment: Environment | undefined): NodeJS.ProcessEnv {
  return environment?.variables ? { ...ctx.env, ...environment.variables } : ctx.env;
}

function refuseArchived(project: StoredProject): void {
  if (project.state === 'ARCHIVED')
    throw new HttpError(
      409,
      'PROJECT_ARCHIVED',
      'the project is archived: restore it before running anything',
    );
}

async function environmentOf(project: StoredProject, raw: unknown): Promise<Environment | undefined> {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'environmentId must be a string');
  const environment = (await readEnvironments(project.dir)).find((entry) => entry.id === raw);
  if (!environment) throw new HttpError(404, 'NOT_FOUND', `environment ${raw} not found`);
  return environment;
}

/** Un corps JSON facultatif : vide (ou sans type) vaut `{}`, comme avant l'ajout des options. */
async function readOptionalJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const length = Number(request.headers['content-length'] ?? '0');
  const type = request.headers['content-type'] ?? '';
  if (
    !type.toLowerCase().startsWith('application/json') ||
    (length === 0 && !request.headers['transfer-encoding'])
  )
    return {};
  return readJson(request);
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
  if (
    action !== undefined &&
    (RECORDING_CONTROLS as readonly string[]).includes(action) &&
    method === 'POST'
  ) {
    if (live?.status !== 'RECORDING')
      throw new HttpError(409, 'NOT_RECORDING', `the recording ${name} is not in progress`);
    const body = await readOptionalJson(request);
    const actionId = (): string => {
      const value = textOf(body.actionId, 80);
      if (!value) throw new HttpError(400, 'BAD_REQUEST', 'actionId is required');
      return value;
    };
    const command =
      action === 'checkpoint'
        ? {
            type: 'checkpoint' as const,
            ...(textOf(body.label, 80) ? { label: textOf(body.label, 80) } : {}),
          }
        : action === 'resolve'
          ? {
              type: 'resolve' as const,
              actionId: actionId(),
              candidate: Number.isInteger(body.candidate)
                ? (body.candidate as number)
                : (() => {
                    throw new HttpError(400, 'BAD_REQUEST', 'candidate must be an integer');
                  })(),
            }
          : action === 'ignore'
            ? { type: 'ignore' as const, actionId: actionId() }
            : { type: action as 'pause' | 'resume' | 'undo' };
    const outcome = await ctx.recordings.control(live, command);
    if ('error' in outcome)
      throw new HttpError(409, outcome.error, `the recorder refused ${action}: ${outcome.error}`);
    sendJson(response, live.snapshot());
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
    sendJson(response, await flowView(await storedRecordingOf(ctx, project, name), language));
    return;
  }
  if (action === 'assertions' && itemId === undefined && method === 'GET') {
    sendJson(response, await proposalViews(await storedRecordingOf(ctx, project, name)));
    return;
  }
  if (action === 'data' && itemId === undefined && method === 'GET') {
    sendJson(response, await dataView(await storedRecordingOf(ctx, project, name)));
    return;
  }
  if (action === 'data' && itemId === 'bindings' && method === 'POST') {
    const body = await readJson(request);
    const stepId = textOf(body.stepId, 80);
    const source = body.source;
    if (!stepId || typeof source !== 'string' || !(DATA_SOURCES as readonly string[]).includes(source))
      throw new HttpError(400, 'BAD_REQUEST', `stepId and source (${DATA_SOURCES.join(', ')}) are required`);
    const optional = (key: string, max: number): string | undefined => {
      const value = body[key];
      if (value === undefined) return undefined;
      const text = textOf(value, max);
      if (text === undefined)
        throw new HttpError(400, 'BAD_REQUEST', `${key} must be a text of ${String(max)} characters at most`);
      return text;
    };
    const variable = optional('variable', 120);
    const generator = optional('generator', 40);
    const value = optional('value', 500);
    const result = await editRecording(ctx, project, name, async (stored): Promise<DataBindingResult> => {
      const outcome = await bindStoredTestData(
        stored,
        {
          stepId,
          source: source as DataBindingResult['decision']['source'],
          ...(variable ? { variable } : {}),
          ...(generator ? { generator } : {}),
          ...(value !== undefined ? { value } : {}),
        },
        language,
      );
      if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
      const { decision } = outcome;
      return {
        decision: {
          id: decision.id,
          stepId: decision.stepId,
          source: decision.source,
          variable: decision.variable,
          ...(decision.previousKey ? { previousKey: decision.previousKey } : {}),
          at: decision.at,
        },
        data: await dataView(stored),
      };
    });
    sendJson(response, result);
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
      return await proposalViews(stored);
    });
    sendJson(response, views);
    return;
  }
  if (action === 'studio' && itemId === undefined && method === 'GET') {
    const stored = await storedRecordingOf(ctx, project, name);
    sendJson(response, await studioView(stored, groupDtos(stored), language));
    return;
  }
  if (action === 'intents' && itemId === undefined) {
    if (method === 'GET') {
      sendJson(response, await storedIntents(await storedRecordingOf(ctx, project, name), language));
      return;
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const actionId = textOf(body.actionId, 80);
      const type = body.type;
      if (!actionId || (type !== 'CORRECT' && type !== 'CONFIRM' && type !== 'RESET'))
        throw new HttpError(400, 'BAD_REQUEST', 'actionId and type (CORRECT, CONFIRM, RESET) are required');
      const intent = textOf(body.intent, 40);
      const reason = textOf(body.reason, 500);
      const view = await editRecording(ctx, project, name, async (stored) => {
        const outcome = await reviewStoredIntent(stored, {
          actionId,
          type,
          ...(intent ? { intent } : {}),
          ...(reason ? { reason } : {}),
        });
        if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
        return storedIntents(stored, language);
      });
      sendJson(response, view);
      return;
    }
  }
  if (action === 'steps' && itemId === 'row') {
    if (method === 'GET') {
      const stepId = textOf(url.searchParams.get('stepId'), 80);
      if (!stepId) throw new HttpError(400, 'BAD_REQUEST', 'stepId is required');
      const source = await storedRowSource(await storedRecordingOf(ctx, project, name), stepId);
      if ('error' in source) throw new HttpError(422, 'REFUSED', source.error);
      sendJson(response, source);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const stepId = textOf(body.stepId, 80);
      if (!stepId) throw new HttpError(400, 'BAD_REQUEST', 'stepId is required');
      const columns = rowColumnsOf(body.columns);
      const view = await editRecording(ctx, project, name, async (stored) => {
        const outcome = await editStoredRow(stored, { stepId, columns }, language);
        if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
        return studioView(stored, groupDtos(stored), language);
      });
      sendJson(response, view);
      return;
    }
  }
  if (action === 'steps' && itemId === 'restore' && method === 'POST') {
    const stepId = textOf((await readJson(request)).stepId, 80);
    if (!stepId) throw new HttpError(400, 'BAD_REQUEST', 'stepId is required');
    const view = await editRecording(ctx, project, name, async (stored) => {
      const outcome = await restoreStoredTarget(stored, stepId, language);
      if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
      return studioView(stored, groupDtos(stored), language);
    });
    sendJson(response, view);
    return;
  }
  if (action === 'correction') {
    await handleCorrection(ctx, project, name, itemId, method, request, response);
    return;
  }
  if (action === 'steps' && itemId === 'remove' && method === 'POST') {
    const body = await readJson(request);
    const stepId = textOf(body.stepId, 80);
    if (!stepId) throw new HttpError(400, 'BAD_REQUEST', 'stepId is required');
    const view = await editRecording(ctx, project, name, async (stored) => {
      const outcome = await removeStoredStep(stored, stepId, language);
      if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
      return studioView(stored, groupDtos(stored), language);
    });
    sendJson(response, view);
    return;
  }
  if (action === 'groups' && itemId === 'proposals') {
    if (method === 'GET') {
      const stored = await storedRecordingOf(ctx, project, name);
      sendJson(response, (await storedGroupProposals(stored, language)).map(groupProposalView));
      return;
    }
    if (method === 'POST') {
      const result = await editRecording(ctx, project, name, async (stored) => {
        const outcome = await acceptStoredGroupProposals(stored, language);
        if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
        return { groups: groupDtos(stored), warnings: outcome.warnings };
      });
      sendJson(response, result);
      return;
    }
  }
  if (action === 'groups' && itemId === 'checks') {
    if (method === 'GET') {
      sendJson(response, storedGroupChecks(await storedRecordingOf(ctx, project, name)));
      return;
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const groupId = textOf(body.groupId, 80);
      const key = textOf(body.key, 80);
      if (!groupId || !key) throw new HttpError(400, 'BAD_REQUEST', 'groupId and key are required');
      const views = await editRecording(ctx, project, name, async (stored) => {
        const outcome = await addStoredGroupCheck(stored, { groupId, key }, language);
        if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
        return await proposalViews(stored);
      });
      sendJson(response, views);
      return;
    }
  }
  if (action === 'replay' && itemId === undefined) {
    if (method === 'GET') {
      sendJson(response, await replayView(ctx, project, name));
      return;
    }
    if (method === 'POST') {
      refuseArchived(project);
      sendJson(response, await startReplay(ctx, project, name), 202);
      return;
    }
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

/** La mission du projet écrite en fichier (le recorder et son rejeu la lisent comme la CLI). */
async function recordMission(ctx: Context, project: StoredProject): Promise<string> {
  const loaded = await projectMission(ctx, project, 'record');
  const derived = path.join(project.dir, '.derived');
  await mkdir(derived, { recursive: true });
  const missionFile = path.join(derived, 'record.mission.yaml');
  await writeFile(
    missionFile,
    `# Derived by the SDK server from ${PROJECT_FILE} — regenerated at each recording.\n${loaded.missionYaml}`,
    'utf8',
  );
  return missionFile;
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
  const missionFile = await recordMission(ctx, project);
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

async function proposalViews(stored: StoredRecording): Promise<AssertionProposalView[]> {
  const verdicts = await assertionVerdicts(stored);
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
    ...(verdicts.get(proposal.id)?.stepId ? { stepId: verdicts.get(proposal.id)?.stepId } : {}),
    verdict: verdicts.get(proposal.id)?.verdict ?? { status: 'NOT_EXECUTED', reasons: [] },
  }));
}

/** Les données de test d'un enregistrement, sans aucun secret ni valeur sensible. */
async function dataView(stored: StoredRecording): Promise<TestDataView> {
  const data = await storedTestData(stored);
  const ref = (entry: { stepId: string; stepIndex: number; label: string }) => ({
    stepId: entry.stepId,
    position: entry.stepIndex,
    label: entry.label,
  });
  return {
    variables: data.lineage.map((entry) => ({
      key: entry.key,
      strategy: entry.strategy,
      ...(entry.generator ? { generator: entry.generator } : {}),
      ...(entry.producedBy ? { producedBy: ref(entry.producedBy) } : {}),
      usedBy: entry.usedBy.map((use) => ({ ...ref(use), how: use.how })),
    })),
    inputs: data.inputs.map((input) => ({
      stepId: input.stepId,
      position: input.position,
      label: input.label,
      source: input.binding.source,
      ...(input.binding.key ? { key: input.binding.key } : {}),
      ...(input.binding.generator ? { generator: input.binding.generator } : {}),
      ...(input.binding.reference ? { reference: input.binding.reference } : {}),
      ...(input.binding.recordedValue !== undefined && input.binding.source !== 'SENSITIVE'
        ? { recordedValue: input.binding.recordedValue }
        : {}),
      options: input.binding.options.map((option) => ({
        ...ref(option),
        key: option.key,
        strategy: option.strategy,
      })),
      manual: input.binding.manual,
    })),
    missing: data.missing.map((entry) => ({
      key: entry.key,
      stepIds: entry.stepIds,
      message: `testData.${entry.key} is used but no earlier step produces it and the data set does not hold it: a replay would make one up`,
    })),
    generators: data.generators,
  };
}

/** Les colonnes d'une ligne, vérifiées champ par champ (le moteur vérifie ensuite les cellules et les données). */
function rowColumnsOf(raw: unknown): RowColumnInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20)
    throw new HttpError(400, 'BAD_REQUEST', 'columns must be a list of 1 to 20 columns');
  return raw.map((entry: unknown) => {
    const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const column = textOf(value.column, 120);
    const source = value.source;
    if (
      !column ||
      (source !== 'recorded' && source !== 'value' && source !== 'variable' && source !== 'new-variable')
    )
      throw new HttpError(400, 'BAD_REQUEST', 'each column needs a name and a source');
    const text = textOf(value.value, 200);
    const key = textOf(value.key, 120);
    return {
      column,
      source,
      ...(text !== undefined ? { value: text } : {}),
      ...(key ? { key } : {}),
      ...(value.match === 'contains' || value.match === 'exact' ? { match: value.match } : {}),
    };
  });
}

/**
 * LA CORRECTION D'UNE CIBLE : ouvrir (le serveur rejoue jusqu'à l'étape dans un navigateur sur sa
 * machine), suivre, désigner à nouveau, valider, reprendre le rejeu, fermer. Rien n'est écrit avant
 * la validation.
 */
async function handleCorrection(
  ctx: Context,
  project: StoredProject,
  name: string,
  sub: string | undefined,
  method: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const key = `${project.id}/${name}`;
  const language = ctx.rules.reportLanguage;
  const refuse = (error: unknown): never => {
    throw new HttpError(409, 'CORRECTION_REFUSED', error instanceof Error ? error.message : String(error));
  };
  if (sub === undefined && method === 'GET') {
    const view = ctx.corrections.view(key);
    if (!view) throw new HttpError(404, 'NOT_FOUND', 'no correction is open for this recording');
    sendJson(response, view);
    return;
  }
  if (sub === undefined && method === 'POST') {
    refuseArchived(project);
    const stepId = textOf((await readJson(request)).stepId, 80);
    if (!stepId) throw new HttpError(400, 'BAD_REQUEST', 'stepId is required');
    if (ctx.recordings.active())
      throw new HttpError(409, 'RECORDING_ACTIVE', 'a recording is in progress: one browser at a time');
    const recording = await storedRecordingOf(ctx, project, name);
    const missionFile = await recordMission(ctx, project);
    const overrides = { reportsDir: reportsDirOf(project) };
    const { config } = await loadConfigFile(missionFile, overrides, ctx.env);
    try {
      sendJson(
        response,
        ctx.corrections.start({
          key,
          recording,
          stepId,
          missionFile,
          overrides,
          env: ctx.env,
          language,
          config,
        }),
        202,
      );
    } catch (error) {
      if (error instanceof CorrectionBusyError) throw new HttpError(409, 'CORRECTION_ACTIVE', error.message);
      throw new HttpError(422, 'REFUSED', error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  if (sub === 'pick') {
    const recording = await storedRecordingOf(ctx, project, name);
    sendJson(
      response,
      await Promise.resolve()
        .then(() => ctx.corrections.pickAgain(key, recording))
        .catch(refuse),
    );
    return;
  }
  if (sub === 'apply') {
    const body = await readJson(request);
    const option = textOf(body.option, 20);
    const raw = body.binding as Record<string, unknown> | undefined;
    const column = raw && typeof raw === 'object' ? textOf(raw.column, 120) : undefined;
    const bound = raw && typeof raw === 'object' ? textOf(raw.key, 120) : undefined;
    const view = await editRecording(ctx, project, name, (stored) =>
      ctx.corrections
        .apply(key, stored, {
          ...(option ? { option } : {}),
          ...(column && bound ? { binding: { column, key: bound } } : {}),
        })
        .catch(refuse),
    );
    sendJson(response, view);
    return;
  }
  if (sub === 'resume') {
    sendJson(response, await ctx.corrections.resume(key).catch(refuse));
    return;
  }
  if (sub === 'close') {
    ctx.corrections.close(key);
    sendJson(response, { closed: true });
    return;
  }
  throw new HttpError(404, 'NOT_FOUND', 'unknown correction action');
}

function groupProposalView(proposal: GroupProposal): GroupProposalView {
  return {
    name: proposal.name,
    stepIds: proposal.stepIds,
    from: proposal.from,
    to: proposal.to,
    action: proposal.action,
    confidence: proposal.confidence,
  };
}

/** Le rejeu en cours ou le dernier de cette session, et le dernier écrit sur disque. */
async function replayView(ctx: Context, project: StoredProject, name: string): Promise<RecordingReplayView> {
  const stored = await storedRecordingOf(ctx, project, name);
  const job = ctx.replays.get(`${project.id}/${name}`);
  const last = (await studioView(stored, [], ctx.rules.reportLanguage)).replay;
  return { ...(job ?? { status: 'NONE' as const }), ...(last ? { last } : {}) };
}

/**
 * LE REJEU DE VALIDATION d'un enregistrement écrit : le flow généré est rejoué (dry run, sans fenêtre,
 * mémoire isolée) avec la mission du projet ; la politique de sécurité s'applique. Un seul à la fois
 * par enregistrement ; la page suit sa progression par GET.
 */
async function startReplay(ctx: Context, project: StoredProject, name: string): Promise<RecordingReplayView> {
  const key = `${project.id}/${name}`;
  if (ctx.replays.get(key)?.status === 'RUNNING')
    throw new HttpError(409, 'REPLAY_RUNNING', `the recording ${name} is already being replayed`);
  const stored = await storedRecordingOf(ctx, project, name);
  const yaml = await readFile(path.join(stored.directory, FLOW_FILES.yaml), 'utf8').catch(() => undefined);
  if (yaml === undefined)
    throw new HttpError(422, 'REFUSED', `recording "${name}" has no generated flow (YAML) to replay`);
  const missionFile = await recordMission(ctx, project);
  const total = stored.flow.steps.filter((item) => item.step.kind !== 'expect').length;
  const job: RecordingReplayView = {
    status: 'RUNNING',
    executed: 0,
    total,
    startedAt: new Date().toISOString(),
  };
  ctx.replays.set(key, job);
  const replay = ctx.options.replayRecording ?? replayRecordedFlow;
  void replay({
    directory: stored.directory,
    flow: stored.flow,
    yaml,
    missionFile,
    overrides: { reportsDir: reportsDirOf(project) },
    env: ctx.env,
    headless: true,
    onStep: (executed, steps) => {
      job.executed = executed;
      job.total = steps;
    },
  })
    .then((outcome) => {
      job.status = outcome.status === 'REPLAY_CONFIRMED' ? 'REPLAY_CONFIRMED' : 'REPLAY_FAILED';
      if (outcome.dryRunStatus) job.dryRunStatus = outcome.dryRunStatus;
      if (outcome.reason) job.reason = redactText(outcome.reason);
    })
    .catch((error: unknown) => {
      job.status = 'REPLAY_FAILED';
      job.reason = redactText(error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
  return { ...job };
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
    data: group.data,
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
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const [kind, rawName, action, extra] = rest;
  if (kind === undefined && method === 'GET') {
    sendJson(response, await reportEntries(reportsDirOf(project)));
    return;
  }
  // Deux explorations du projet, comparées par le moteur (compareFlowRuns) ; rien n'est rejoué.
  if (kind === 'compare' && rawName === undefined && method === 'GET') {
    const base = url.searchParams.get('base') ?? '';
    const head = url.searchParams.get('head') ?? '';
    if (!base || !head)
      throw new HttpError(400, 'BAD_REQUEST', 'base and head (exploration runs) are required');
    if (base === head) throw new HttpError(400, 'BAD_REQUEST', 'base and head are the same run');
    const comparison = await compareRuns(
      { dir: await reportDirOf(project, 'exploration', base), run: base },
      { dir: await reportDirOf(project, 'exploration', head), run: head },
    );
    if (!comparison) throw new HttpError(404, 'NOT_FOUND', 'a run has no result.json');
    sendJson(response, comparison);
    return;
  }
  if (rawName === undefined || extra !== undefined) throw new HttpError(404, 'NOT_FOUND', 'not found');
  const name = decodeURIComponent(rawName);
  const directory = await reportDirOf(project, kind as ReportEntryKind, name);
  if (kind === 'exploration' && action === 'traceability' && method === 'GET') {
    const view = await traceabilityView(directory, name);
    if (!view)
      throw new HttpError(
        404,
        'NOT_FOUND',
        'no quality-verification.json in this run: the mission declares no requirements',
      );
    sendJson(response, view);
    return;
  }
  if (kind === 'exploration' && action === 'regression' && method === 'GET') {
    const view = await regressionView(directory, name);
    if (!view) throw new HttpError(404, 'NOT_FOUND', 'no regression-analysis.json in this run');
    sendJson(response, view);
    return;
  }
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
    cancellation: true,
    safety: { blocked: [...ALWAYS_BLOCKED_RISKS] },
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

// ── La plateforme : cycle de vie des projets, environnements, scénarios, exécutions, vue d'ensemble ──

/** Les projets de l'espace de travail (dossiers `prj_…` qui portent une fiche du SDK). */
async function workspaceProjects(ctx: Context): Promise<StoredProject[]> {
  let entries: string[];
  try {
    entries = (await readdir(ctx.workspace, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('prj_') && entry.name !== 'prj_validation',
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const projects: StoredProject[] = [];
  for (const name of entries.sort()) {
    if (!ID_PATTERN.test(name)) continue;
    const stored = await readProject(path.join(ctx.workspace, name));
    if (!stored) continue;
    ctx.projects.set(stored.id, stored);
    projects.push(stored);
  }
  return projects;
}

/** Un nombre lu sur disque ; un projet dont la configuration ne se lit plus compte 0, sans casser la liste. */
async function counted<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

async function projectSummary(project: StoredProject): Promise<ProjectSummary> {
  const reportsDir = path.join(project.dir, REPORTS_DIR);
  const executions = await counted(() => listExecutions(project.id, reportsDir));
  const last = executions.find((execution) => execution.verdict !== 'INCOMPLETE');
  return {
    ...publicProject(project),
    state: project.state ?? 'ACTIVE',
    ...(project.updatedAt ? { updatedAt: project.updatedAt } : {}),
    ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
    counts: {
      environments: (await readEnvironments(project.dir)).length,
      scenarios: (await counted(() => listScenarios(project.dir))).length,
      recordings: (await counted(() => storedRecordingNames(reportsDir))).length,
      executions: executions.length,
    },
    ...(last ? { lastExecution: last } : {}),
  };
}

async function projectDetail(project: StoredProject): Promise<ProjectDetail> {
  const stored = await readProject(project.dir);
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'project not found');
  return {
    ...(await projectSummary(stored)),
    draft: stored.draft,
    environments: await readEnvironments(project.dir),
    scenarios: await counted(() => listScenarios(project.dir)),
  };
}

function stringList(raw: unknown, field: string, max: number): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string') || raw.length > max)
    throw new HttpError(400, 'BAD_REQUEST', `${field} must be a list of at most ${String(max)} names`);
  return raw as string[];
}

/** Les routes de la plateforme ; `false` : la requête n'en est pas une. */
async function handlePlatform(
  ctx: Context,
  segments: string[],
  method: string,
  request: IncomingMessage,
  url: URL,
  json: (body: unknown, status?: number) => void,
): Promise<boolean> {
  const [, resource, id, sub, item, action] = segments;
  if (resource === 'overview' && id === undefined && method === 'GET') {
    const days = Number(url.searchParams.get('days') ?? '30');
    const projects = await workspaceProjects(ctx);
    const inputs = await Promise.all(
      projects.map(async (project) => {
        const reportsDir = path.join(project.dir, REPORTS_DIR);
        return {
          id: project.id,
          name: project.name,
          archived: project.state === 'ARCHIVED',
          reportsDir,
          scenarios: (await counted(() => listScenarios(project.dir))).length,
          recordings: (await counted(() => storedRecordingNames(reportsDir))).length,
          environments: await readEnvironments(project.dir),
        };
      }),
    );
    json(await computeOverview(inputs, { days: Number.isFinite(days) ? days : 30, env: ctx.env }));
    return true;
  }
  if (resource !== 'projects') return false;
  if (id === undefined && method === 'GET') {
    const archived = url.searchParams.get('archived') === 'true';
    const projects = (await workspaceProjects(ctx)).filter(
      (project) => archived || project.state !== 'ARCHIVED',
    );
    json(await Promise.all(projects.map((project) => projectSummary(project))));
    return true;
  }
  if (!id || id === 'validate') return false;
  if (sub === 'detail' && item === undefined && method === 'GET') {
    json(await projectDetail(await projectOf(ctx, id)));
    return true;
  }
  if (sub === 'config' && item === undefined && method === 'POST') {
    const project = await projectOf(ctx, id);
    refuseArchived(project);
    const body = await readJson(request);
    const { report, draft } = await validate(ctx, body.draft, project.dir);
    if (!report.ok || !draft)
      throw new HttpError(422, 'DRAFT_INVALID', 'the project is not valid', { issues: report.blocking });
    const updated = await updateProject(project.dir, draft, ctx.rules);
    ctx.projects.set(id, updated);
    json(await projectDetail(updated));
    return true;
  }
  if (sub === 'duplicate' && item === undefined && method === 'POST') {
    const project = await projectOf(ctx, id);
    const stored = await readProject(project.dir);
    if (!stored) throw new HttpError(404, 'NOT_FOUND', 'project not found');
    const body = await readJson(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200)
      throw new HttpError(400, 'BAD_REQUEST', 'the copy needs a name (1 to 200 characters)');
    const copyId = `prj_${randomBytes(9).toString('base64url')}`;
    const dir = path.join(ctx.workspace, copyId);
    const { report, draft } = await validate(
      ctx,
      { ...stored.draft, project: { ...stored.draft.project, name } },
      dir,
    );
    if (!report.ok || !draft)
      throw new HttpError(422, 'DRAFT_INVALID', 'the copy is not valid', { issues: report.blocking });
    const copy = await writeProject(dir, copyId, draft, ctx.rules);
    // Les environnements (sans valeur secrète : des noms seulement) et les scénarios ; jamais les runs.
    await writeEnvironments(
      dir,
      (await readEnvironments(project.dir)).map((environment) => ({
        ...environment,
        id: newEnvironmentId(),
      })),
    );
    const source = path.join(project.dir, 'qa-crawler', 'flows');
    const isDirectory = await stat(source).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (isDirectory) await cp(source, path.join(dir, 'qa-crawler', 'flows'), { recursive: true });
    ctx.projects.set(copyId, copy);
    json(await projectDetail(copy), 201);
    return true;
  }
  if ((sub === 'archive' || sub === 'restore') && item === undefined && method === 'POST') {
    const project = await projectOf(ctx, id);
    const updated = await setProjectState(project.dir, sub === 'archive' ? 'ARCHIVED' : 'ACTIVE');
    ctx.projects.set(id, updated);
    json(await projectDetail(updated));
    return true;
  }
  if (sub === 'environments') {
    const project = await projectOf(ctx, id);
    const environments = await readEnvironments(project.dir);
    const shape = (raw: unknown, selfId?: string): ReturnType<typeof checkEnvironmentShape> =>
      checkEnvironmentShape(raw, environments, {
        ...(selfId ? { selfId } : {}),
        envNames: ctx.envNames,
        env: ctx.env,
      });
    if (item === undefined && method === 'GET') {
      json(environments);
      return true;
    }
    if (item === 'check' && method === 'POST') {
      const body = await readJson(request);
      const { input, check } = shape(
        body.environment,
        typeof body.selfId === 'string' ? body.selfId : undefined,
      );
      json(
        input && body.reach === true
          ? { ...check, url: await checkUrl(input.baseUrl, ctx.options.urlCheckTimeoutMs ?? 10_000) }
          : check,
      );
      return true;
    }
    refuseArchived(project);
    if (item === undefined && method === 'POST') {
      const body = await readJson(request);
      const { input, check } = shape(body.environment);
      if (!input || !check.ok)
        throw new HttpError(422, 'ENVIRONMENT_INVALID', 'the environment is not valid', {
          details: check.issues.map((issue) => `${issue.field}: ${issue.message}`),
        });
      if (environments.length >= 20)
        throw new HttpError(409, 'TOO_MANY', 'at most 20 environments per project');
      const now = new Date().toISOString();
      const environment: Environment = { ...input, id: newEnvironmentId(), createdAt: now, updatedAt: now };
      await writeEnvironments(project.dir, [...environments, environment]);
      json(environment, 201);
      return true;
    }
    const existing = environments.find((entry) => entry.id === item);
    if (!existing) throw new HttpError(404, 'NOT_FOUND', `environment ${item ?? ''} not found`);
    if (action === undefined && method === 'POST') {
      const body = await readJson(request);
      const { input, check } = shape(body.environment, existing.id);
      if (!input || !check.ok)
        throw new HttpError(422, 'ENVIRONMENT_INVALID', 'the environment is not valid', {
          details: check.issues.map((issue) => `${issue.field}: ${issue.message}`),
        });
      const environment: Environment = {
        ...input,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await writeEnvironments(
        project.dir,
        environments.map((entry) => (entry.id === existing.id ? environment : entry)),
      );
      json(environment);
      return true;
    }
    if (action === 'remove' && method === 'POST') {
      const body = await readJson(request);
      if (body.confirm !== true)
        throw new HttpError(
          409,
          'CONFIRMATION_REQUIRED',
          'removing an environment cannot be undone: send { "confirm": true }',
        );
      await writeEnvironments(
        project.dir,
        environments.filter((entry) => entry.id !== existing.id),
      );
      json({ removed: existing.id });
      return true;
    }
    return false;
  }
  if (sub === 'scenarios' && item === 'history' && method === 'GET') {
    const project = await projectOf(ctx, id);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10));
    json(await scenarioHistory(project.id, path.join(project.dir, REPORTS_DIR), limit));
    return true;
  }
  if (sub === 'scenarios' && item === undefined) {
    const project = await projectOf(ctx, id);
    if (method === 'GET') {
      json(await listScenarios(project.dir));
      return true;
    }
    if (method === 'POST') {
      refuseArchived(project);
      const body = await readJson(request);
      const name = typeof body.recording === 'string' ? body.recording : '';
      if (!RECORDING_NAME_PATTERN.test(name))
        throw new HttpError(400, 'BAD_REQUEST', 'recording must be a recording name');
      const outcome = await promoteRecording(
        project.dir,
        path.join(recordingsDir(path.join(project.dir, REPORTS_DIR)), name),
        name,
      );
      if ('error' in outcome) throw new HttpError(422, 'REFUSED', outcome.error);
      json(outcome.scenario, 201);
      return true;
    }
    return false;
  }
  if (sub === 'executions') {
    const project = await projectOf(ctx, id);
    const reportsDir = path.join(project.dir, REPORTS_DIR);
    if (item === undefined && method === 'GET') {
      json(await listExecutions(project.id, reportsDir));
      return true;
    }
    if (item !== undefined && action === undefined && method === 'GET') {
      if (!isRunName(item)) throw new HttpError(404, 'NOT_FOUND', 'execution not found');
      const detail = await executionDetail(project.id, reportsDir, item);
      if (!detail) throw new HttpError(404, 'NOT_FOUND', 'execution not found');
      json(detail);
      return true;
    }
    if (item === undefined && method === 'POST') {
      refuseArchived(project);
      const body = await readOptionalJson(request);
      const environment = await environmentOf(project, body.environmentId);
      requireWrites(request, project.id, environment);
      const wanted = stringList(body.scenarios, 'scenarios', 50);
      const known = await listScenarios(project.dir);
      if (known.length === 0)
        throw new HttpError(
          409,
          'NO_SCENARIO',
          'the project has no scenario: promote a recording or add a flow under qa-crawler/flows',
        );
      const unknown = (wanted ?? []).filter((name) => !known.some((scenario) => scenario.name === name));
      if (unknown.length > 0)
        throw new HttpError(404, 'NOT_FOUND', `unknown scenario(s): ${unknown.join(', ')}`);
      const flowsDir = await flowsDirOf(project.dir);
      const selected = wanted ? known.filter((scenario) => wanted.includes(scenario.name)) : undefined;
      const loaded = await projectMission(ctx, project, 'replay', {
        ...(selected
          ? {
              flows: selected
                .filter((scenario) => scenario.format === 'yaml')
                .map((scenario) => scenario.name),
              extraFlows: selected
                .filter((scenario) => scenario.format === 'gherkin')
                .map((scenario) => ({ gherkin: path.join(flowsDir, scenario.file) })),
            }
          : {}),
        ...(environment ? { environment } : {}),
      });
      const runDir = path.join(reportsDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await writeExecutionMeta(runDir, {
        kind: 'REPLAY',
        startedAt: new Date().toISOString(),
        ...(environment ? { environment: { id: environment.id, name: environment.name } } : {}),
        scenarios: (selected ?? known).map((scenario) => scenario.name),
      });
      const execution = ctx.explorations.start({
        projectId: project.id,
        config: loaded.config,
        reportsDir: runDir,
        kind: 'REPLAY',
        env: missionEnv(ctx, environment),
      });
      json(execution.snapshot(), 202);
      return true;
    }
    return false;
  }
  return false;
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
    (event: ExplorationEvent) => event.type === 'status' && isTerminal(event.status),
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

/** Les identités des requêtes en cours (posées par `authorize`). */
const IDENTITIES = new WeakMap<IncomingMessage, Identity>();

const SERVICE: Identity = { id: 'service', name: 'service', kind: 'SERVICE', role: 'ADMIN', projects: {} };

/** Qui appelle : le jeton du service (administrateur) ou un jeton nominatif non révoqué. */
async function authorize(ctx: Context, request: IncomingMessage): Promise<Identity> {
  const header = request.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(given);
  const b = Buffer.from(ctx.token);
  if (a.length === b.length && timingSafeEqual(a, b)) return SERVICE;
  const member = given ? await ctx.access.resolve(given) : undefined;
  if (!member) throw new HttpError(401, 'UNAUTHORIZED', 'missing or invalid token');
  return member;
}

function identityOf(request: IncomingMessage): Identity {
  return IDENTITIES.get(request) ?? SERVICE;
}

/** L'auteur d'une décision : le nom d'un membre ; rien pour le jeton du service (ce n'est personne). */
function authorOf(request: IncomingMessage): { by?: string } {
  const identity = identityOf(request);
  return identity.kind === 'MEMBER' ? { by: identity.name } : {};
}

/** Le projet que la requête touche (ses rôles propres s'y appliquent). */
function projectScope(ctx: Context, segments: readonly string[]): string | undefined {
  const [, resource, id] = segments;
  if (resource === 'projects' && id && id !== 'validate' && ID_PATTERN.test(id)) return id;
  if (resource === 'explorations' && id) return ctx.explorations.get(id)?.projectId;
  return undefined;
}

/**
 * Le droit de la route, vérifié à chaque appel. Une écriture et un refus vont au journal : qui, quoi,
 * où, résultat ; jamais un corps, une valeur ou un jeton.
 */
function checkRight(
  ctx: Context,
  identity: Identity,
  segments: readonly string[],
  method: string,
  response: ServerResponse,
): void {
  const projectId = projectScope(ctx, segments);
  const right = rightFor(segments, method);
  const { action, kind } = actionOf(segments);
  const record = (status: number): void => {
    ctx.access
      .record({
        at: new Date().toISOString(),
        who: { id: identity.id, name: identity.name },
        role: roleIn(identity, projectId),
        method,
        action,
        kind,
        path: `/${segments.join('/')}`,
        ...(projectId ? { projectId } : {}),
        status,
        outcome: status === 401 || status === 403 ? 'DENIED' : status < 400 ? 'OK' : 'FAILED',
      })
      .catch(() => undefined);
  };
  if (!can(identity, right, projectId)) {
    record(403);
    throw new HttpError(403, 'FORBIDDEN', `the role ${roleIn(identity, projectId)} does not allow ${right}`);
  }
  if (method !== 'GET' && method !== 'HEAD')
    response.once('finish', () => {
      record(response.statusCode);
    });
}

/** Une exécution qui permet les écritures demande le droit de les permettre (RUN_WRITES). */
function requireWrites(
  request: IncomingMessage,
  projectId: string,
  environment: Environment | undefined,
): void {
  if (!environment?.mutations?.enabled) return;
  const identity = identityOf(request);
  if (!can(identity, 'RUN_WRITES', projectId))
    throw new HttpError(
      403,
      'FORBIDDEN',
      `the role ${roleIn(identity, projectId)} does not allow a run with writes (environment ${environment.name})`,
    );
}

/** LES ACCÈS (`/api/access/…`) : qui je suis ; les membres, leurs rôles, leurs jetons ; le journal. */
async function handleAccess(
  ctx: Context,
  identity: Identity,
  segments: readonly string[],
  method: string,
  request: IncomingMessage,
  url: URL,
  json: (body: unknown, status?: number) => void,
): Promise<void> {
  const [, , part, id, action] = segments;
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AccessError)
        throw new HttpError(error.code === 'NOT_FOUND' ? 404 : 400, error.code, error.message);
      throw error;
    }
  };
  if (part === 'me' && id === undefined && method === 'GET') {
    const projectId = url.searchParams.get('projectId') ?? undefined;
    if (projectId) await projectOf(ctx, projectId);
    const override = projectId ? identity.projects[projectId] : undefined;
    const me: AccessMe = {
      id: identity.id,
      name: identity.name,
      kind: identity.kind,
      role: identity.role,
      ...(override ? { projectRole: override } : {}),
      rights: [...ROLE_RIGHTS[roleIn(identity, projectId)]],
      mode: ctx.mode,
    };
    json(me);
    return;
  }
  if (part === 'members' && id === undefined && method === 'GET') {
    json(await ctx.access.list());
    return;
  }
  if (part === 'members' && id === undefined && method === 'POST') {
    const body = await readJson(request);
    json(await call(() => ctx.access.create({ name: body.name, role: body.role })), 201);
    return;
  }
  if (part === 'members' && id && action === undefined && method === 'POST') {
    const body = await readJson(request);
    const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
    if (projectId) await projectOf(ctx, projectId);
    json(await call(() => ctx.access.setRole(id, body.role, projectId)));
    return;
  }
  if (part === 'members' && id && action === 'revoke' && method === 'POST') {
    json(await call(() => ctx.access.revoke(id)));
    return;
  }
  if (part === 'journal' && id === undefined && method === 'GET') {
    const kind = url.searchParams.get('kind') ?? undefined;
    if (kind !== undefined && !(JOURNAL_KINDS as readonly string[]).includes(kind))
      throw new HttpError(400, 'INVALID_INPUT', `kind must be one of ${JOURNAL_KINDS.join(', ')}`);
    const projectId = url.searchParams.get('projectId') ?? undefined;
    json(
      await ctx.access.journal({
        ...(projectId ? { projectId } : {}),
        ...(kind ? { kind: kind as JournalKind } : {}),
        limit: Number(url.searchParams.get('limit') ?? '200'),
      }),
    );
    return;
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found');
}

/** Le corps brut d'un envoi de fichier, borné AVANT d'être lu en entier. */
async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (declared > maxBytes)
    throw new HttpError(413, 'TOO_LARGE', `the file is larger than ${String(maxBytes)} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes)
      throw new HttpError(413, 'TOO_LARGE', `the file is larger than ${String(maxBytes)} bytes`);
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const PIPELINE_STATUS: Record<PipelineError['code'], number> = {
  NOT_FOUND: 404,
  INVALID_DECISION: 422,
  ALREADY_PUBLISHED: 409,
  CONFLICT_REQUIRES_MERGE: 409,
  PARTIAL_NOT_ACKNOWLEDGED: 409,
  NOTHING_TO_PUBLISH: 409,
};

/** Une erreur du pipeline ou une entrée refusée devient une réponse dite, jamais une erreur interne. */
async function requirementsCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PipelineError)
      throw new HttpError(PIPELINE_STATUS[error.code], error.code, error.message);
    if (error instanceof RequirementsInputError) throw new HttpError(400, error.code, error.message);
    throw error;
  }
}

const BATCH_PATTERN = /^imp_[A-Za-z0-9_-]{6,64}$/;
const LINK_PATTERN = /^lnk_[A-Za-z0-9_-]{6,64}$/;
const LINK_ENDS = /^[A-Z_]{2,40}$/;

/**
 * LES EXIGENCES D'UN PROJET (`/api/projects/:id/requirements/…`). Toute écriture est refusée sur un
 * projet archivé ; une décision n'est jamais prise par le serveur ; l'auteur n'est pas enregistré
 * tant que l'identité des personnes n'est pas définie (Q1).
 */
async function handleRequirements(
  ctx: Context,
  project: StoredProject,
  rest: string[],
  method: string,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const [part, item, action] = rest;
  const store = storeOf(project.dir);
  const json = (body: unknown, status = 200): void => {
    response.writeHead(status, { 'content-type': JSON_TYPE });
    response.end(JSON.stringify(body));
  };
  const write = (): void => {
    refuseArchived(project);
  };
  if (part === undefined && method === 'GET') {
    const repository = await store.readRepository();
    json({ entities: repository.entities, links: repository.links, pending: await pendingCandidates(store) });
    return;
  }
  if (part === 'connectors' && item === undefined && method === 'GET') {
    json(connectorViews());
    return;
  }
  if (part === 'profiles' && item === undefined && method === 'GET') {
    json(await store.listProfiles());
    return;
  }
  if (part === 'matrix' && item === undefined && method === 'GET') {
    const rows = matrixOf(await store.readRepository());
    if (url.searchParams.get('format') === 'csv') {
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="traceability-${project.id}.csv"`,
      });
      response.end(matrixCsv(rows));
      return;
    }
    json(rows);
    return;
  }
  if (part === 'indicators' && item === undefined && method === 'GET') {
    json(
      await computeIndicators(
        await store.readRepository(),
        await store.listBatches(),
        path.join(project.dir, REPORTS_DIR),
        project.id,
        { days: Number(url.searchParams.get('days') ?? '30') },
      ),
    );
    return;
  }
  if (part === 'imports' && item === undefined && method === 'GET') {
    json((await store.listBatches()).map(summaryOf));
    return;
  }
  if (part === 'imports' && item === undefined && method === 'POST') {
    write();
    const body = await readJson(request);
    json(
      await requirementsCall(() =>
        importConfluence(store, body, { env: ctx.env, envNames: ctx.envNames, now: new Date() }),
      ),
      201,
    );
    return;
  }
  if (part === 'imports' && item === 'file' && action === undefined && method === 'POST') {
    write();
    const kind = url.searchParams.get('connector') ?? '';
    if (!(FILE_CONNECTORS as readonly string[]).includes(kind))
      throw new HttpError(400, 'INVALID_INPUT', `connector must be one of ${FILE_CONNECTORS.join(', ')}`);
    const type = (request.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/octet-stream'))
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'expected application/octet-stream');
    const data = await readBytes(request, maxFileBytes(kind as FileConnectorKind));
    const profile = url.searchParams.get('profile') ?? undefined;
    json(
      await requirementsCall(() =>
        importFile(store, kind as FileConnectorKind, url.searchParams.get('name') ?? '', data, {
          ...(profile ? { profile } : {}),
          env: ctx.env,
          now: new Date(),
        }),
      ),
      201,
    );
    return;
  }
  if (part === 'imports' && item) {
    if (!BATCH_PATTERN.test(item)) throw new HttpError(404, 'NOT_FOUND', 'import not found');
    if (action === undefined && method === 'GET') {
      const batch = await store.readBatch(item);
      if (!batch) throw new HttpError(404, 'NOT_FOUND', 'import not found');
      json(batch);
      return;
    }
    if (action === 'decisions' && method === 'POST') {
      write();
      const body = await readJson(request);
      const decisions = Array.isArray(body.decisions) ? (body.decisions as DecisionInput[]) : [];
      if (decisions.length === 0 || decisions.length > 500)
        throw new HttpError(400, 'INVALID_INPUT', 'between 1 and 500 decisions');
      for (const entry of decisions) {
        const decision = (entry as Partial<DecisionInput>).decision;
        if (
          typeof entry !== 'object' ||
          typeof entry.itemId !== 'string' ||
          !decision ||
          !(DECISION_ACTIONS as readonly string[]).includes(decision.action)
        )
          throw new HttpError(400, 'INVALID_INPUT', 'each decision needs an itemId and an action');
        // L'auteur est celui du jeton, jamais ce que l'appelant déclare.
        delete (decision as { by?: string }).by;
        Object.assign(decision, authorOf(request));
      }
      json(await requirementsCall(() => decide(store, item, decisions, new Date())));
      return;
    }
    if (action === 'publish' && method === 'POST') {
      write();
      const body = await readJson(request);
      const result = await requirementsCall(() =>
        publish(store, item, new Date(), {
          acknowledgePartial: body.acknowledgePartial === true,
          ...authorOf(request),
        }),
      );
      json({ created: result.created, updated: result.updated, merged: result.merged, links: result.links });
      return;
    }
  }
  if (part === 'links' && item === undefined && method === 'POST') {
    write();
    const body = await readJson(request);
    const end = (value: unknown, field: string): { kind: string; id: string } => {
      const candidate = (value ?? {}) as Record<string, unknown>;
      if (
        typeof candidate.kind !== 'string' ||
        !LINK_ENDS.test(candidate.kind) ||
        typeof candidate.id !== 'string' ||
        candidate.id.trim() === '' ||
        candidate.id.length > 300
      )
        throw new HttpError(400, 'INVALID_INPUT', `${field} needs a kind and an id`);
      return { kind: candidate.kind, id: candidate.id.trim() };
    };
    if (!(LINK_TYPES as readonly string[]).includes(String(body.type)))
      throw new HttpError(400, 'INVALID_INPUT', `type must be one of ${LINK_TYPES.join(', ')}`);
    const justification = Array.isArray(body.justification)
      ? body.justification.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
      : [];
    json(
      await requirementsCall(() =>
        addLink(
          store,
          {
            type: body.type as LinkType,
            from: end(body.from, 'from'),
            to: end(body.to, 'to'),
            justification,
            ...authorOf(request),
          },
          new Date(),
        ),
      ),
      201,
    );
    return;
  }
  if (part === 'links' && item && action === undefined && method === 'POST') {
    write();
    if (!LINK_PATTERN.test(item)) throw new HttpError(404, 'NOT_FOUND', 'link not found');
    const body = await readJson(request);
    if (body.action !== 'CONFIRM' && body.action !== 'REJECT')
      throw new HttpError(400, 'INVALID_INPUT', 'action must be CONFIRM or REJECT');
    const note =
      typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : undefined;
    json(
      await requirementsCall(() =>
        decideLink(store, item, body.action as 'CONFIRM' | 'REJECT', new Date(), {
          ...(note ? { note } : {}),
          ...authorOf(request),
        }),
      ),
    );
    return;
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found');
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
