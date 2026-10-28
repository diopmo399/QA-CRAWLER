import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { hostMatches } from '../../config/config-loader.js';
import type { ScenarioConfig } from '../../config/config.js';
import type { ExplorationResult } from '../../model/exploration-result.js';
import type { FlowRunReport } from '../../model/flow-run.js';
import { loadProjectConfig } from '../../project/project-config.js';
import type {
  Environment,
  EnvironmentCheck,
  EnvironmentInput,
  ExecutionDetail,
  ExecutionFlowView,
  ExecutionKind,
  ExecutionRecord,
  ExecutionVerdict,
  ExplorationIssue,
  OverviewAlert,
  OverviewView,
  ReportKind,
  ScenarioHistoryView,
  ScenarioRunStatus,
  ScenarioView,
  Severity,
} from '../core/contracts.js';
import { ENV_NAME_PATTERN, ENVIRONMENT_KINDS, REPORT_KINDS, SEVERITIES } from '../core/contracts.js';
import { stepLabel } from './explorations.js';
import { PROJECT_FILE } from './project.js';

/**
 * LA PLATEFORME, côté serveur : les environnements d'un projet, ses scénarios (les flows du moteur),
 * ses exécutions (les runs écrits par le moteur) et la vue d'ensemble. Tout est lu ou écrit dans le
 * dossier du projet ; rien n'est recalculé de ce que le moteur a déjà écrit, rien n'est estimé.
 */

export const ENVIRONMENTS_FILE = 'sdk-environments.json';
/** La fiche d'une exécution lancée par le SDK, posée dans le dossier du run avant que le moteur ne joue. */
export const EXECUTION_META_FILE = 'sdk-execution.json';
const RESULT_FILE = 'result.json';
const RUN_PREFIX = 'run-';
const MAX_ISSUES = 200;

/** Un nom de variable qui ressemble à un secret : il va dans `secretEnv`, jamais dans `variables`. */
const SECRET_LIKE = /(pass(word|wd)?|secret|token|api[-_]?key|credential|cookie|session|private)/i;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), 'must start with http:// or https://')
  .refine((value) => URL.canParse(value), 'is not a valid URL');

export const environmentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(ENVIRONMENT_KINDS),
    baseUrl: httpUrl,
    allowedDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(HOST_PATTERN, 'must be a host name (example.org or *.example.org), without scheme or path'),
      )
      .max(20)
      .optional(),
    variables: z
      .record(
        z.string().regex(ENV_NAME_PATTERN, 'must be an environment variable name (A-Z, 0-9, _)'),
        z.string().max(2000),
      )
      .optional(),
    secretEnv: z
      .array(z.string().regex(ENV_NAME_PATTERN, 'must be an environment variable name (A-Z, 0-9, _)'))
      .max(20)
      .optional(),
    limits: z
      .object({
        actionTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
        maxDurationMinutes: z.number().int().min(1).max(240).optional(),
        maxStates: z.number().int().min(1).max(5000).optional(),
        maxActions: z.number().int().min(1).max(50_000).optional(),
      })
      .strict()
      .optional(),
    mutations: z
      .object({ enabled: z.boolean(), maxPerRun: z.number().int().min(1).max(100).optional() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * La forme d'un environnement et les règles du moteur : nom unique dans le projet, domaines qui
 * contiennent l'hôte de la cible (sinon le moteur n'explorerait rien), variables non secrètes,
 * secrets nommés seulement, lisibles par ce serveur.
 */
export function checkEnvironmentShape(
  raw: unknown,
  existing: readonly Environment[],
  options: { selfId?: string; envNames: RegExp; env: NodeJS.ProcessEnv },
): { input?: EnvironmentInput; check: EnvironmentCheck } {
  const parsed = environmentInputSchema.safeParse(raw);
  if (!parsed.success)
    return {
      check: {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'environment',
          message: issue.message,
        })),
        secrets: {},
      },
    };
  const input = parsed.data;
  const issues: EnvironmentCheck['issues'] = [];
  if (
    existing.some(
      (other) => other.id !== options.selfId && other.name.toLowerCase() === input.name.toLowerCase(),
    )
  )
    issues.push({ field: 'name', message: `an environment named "${input.name}" already exists` });
  const host = new URL(input.baseUrl).hostname.toLowerCase();
  if (
    input.allowedDomains &&
    input.allowedDomains.length > 0 &&
    !input.allowedDomains.some((d) => hostMatches(host, d))
  )
    issues.push({
      field: 'allowedDomains',
      message: `the allowed domains do not include the target host "${host}": nothing would be explored`,
    });
  for (const name of Object.keys(input.variables ?? {})) {
    if (SECRET_LIKE.test(name))
      issues.push({
        field: `variables.${name}`,
        message: `${name} looks like a secret: name it in secretEnv (read on the server), never as a value`,
      });
    if (input.secretEnv?.includes(name))
      issues.push({ field: `variables.${name}`, message: `${name} is both a variable and a secret` });
  }
  const secrets: Record<string, boolean> = {};
  for (const name of input.secretEnv ?? []) {
    if (!options.envNames.test(name)) {
      issues.push({
        field: 'secretEnv',
        message: `the QA-CRAWLER server only reads environment variables matching ${options.envNames.source}: ${name}`,
      });
      continue;
    }
    secrets[name] = typeof options.env[name] === 'string' && options.env[name] !== '';
  }
  return { input, check: { ok: issues.length === 0, issues, secrets } };
}

export async function readEnvironments(projectDir: string): Promise<Environment[]> {
  try {
    const stored = JSON.parse(await readFile(path.join(projectDir, ENVIRONMENTS_FILE), 'utf8')) as {
      environments?: Environment[];
    };
    return Array.isArray(stored.environments) ? stored.environments : [];
  } catch {
    return [];
  }
}

/** Écrit la liste (fichier temporaire puis renommage : jamais un fichier à moitié écrit). */
export async function writeEnvironments(
  projectDir: string,
  environments: readonly Environment[],
): Promise<void> {
  const file = path.join(projectDir, ENVIRONMENTS_FILE);
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ environments }, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export function newEnvironmentId(): string {
  return `env_${randomBytes(9).toString('base64url')}`;
}

/**
 * Un environnement appliqué à la mission d'un projet : la cible, les domaines, les délais et les
 * limites. Les variables et les secrets passent par les variables d'environnement d'exécution du moteur.
 */
export function applyEnvironment(config: ScenarioConfig, environment: EnvironmentInput): void {
  config.target.baseUrl = environment.baseUrl.replace(/\/+$/, '');
  const host = new URL(environment.baseUrl).hostname.toLowerCase();
  config.safety.allowedHosts =
    environment.allowedDomains && environment.allowedDomains.length > 0
      ? [...environment.allowedDomains]
      : [host];
  const limits = environment.limits ?? {};
  if (limits.actionTimeoutMs !== undefined) config.exploration.actionTimeoutMs = limits.actionTimeoutMs;
  if (limits.maxDurationMinutes !== undefined)
    config.exploration.maxDurationMinutes = limits.maxDurationMinutes;
  if (limits.maxStates !== undefined) config.exploration.maxStates = limits.maxStates;
  if (limits.maxActions !== undefined) config.exploration.maxActions = limits.maxActions;
  // Les écritures : l'environnement décide quand il le dit (bornées ; jamais les actions DANGEROUS),
  // sinon la mission du projet garde son réglage.
  if (environment.mutations)
    config.safety.mutations = environment.mutations.enabled
      ? { enabled: true, maxPerRun: environment.mutations.maxPerRun ?? 10 }
      : { ...config.safety.mutations, enabled: false };
}

// ── Scénarios ───────────────────────────────────────────────────────────────────────────────

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Le dossier des flows du projet (`paths.flows` de qa-crawler.config.yaml). */
export async function flowsDirOf(projectDir: string): Promise<string> {
  const project = await loadProjectConfig(path.join(projectDir, PROJECT_FILE));
  return path.resolve(projectDir, project.config.paths.flows);
}

/** Les scénarios : un par flow YAML nommé, un par fichier .feature (désigné par son chemin). */
export async function listScenarios(projectDir: string): Promise<ScenarioView[]> {
  const root = await flowsDirOf(projectDir);
  if (!(await exists(root))) return [];
  const files = (await readdir(root, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  const origin = await promotedOrigins(projectDir);
  const scenarios: ScenarioView[] = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (file.endsWith('.feature')) {
      scenarios.push({ name: relative, file: relative, format: 'gherkin' });
      continue;
    }
    if (!/\.ya?ml$/.test(file) || path.basename(file).includes('test-data')) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const document = parsed as Record<string, unknown>;
    const flows = Array.isArray(document.flows)
      ? (document.flows as Record<string, unknown>[])
      : 'steps' in document
        ? [document]
        : [];
    for (const flow of flows) {
      if (typeof flow.name !== 'string') continue;
      const from = origin[relative];
      const runs = Array.isArray(flow.steps)
        ? (flow.steps as unknown[])
            .map((step) => (step && typeof step === 'object' ? (step as { run?: unknown }).run : undefined))
            .filter((run): run is string => typeof run === 'string')
        : [];
      scenarios.push({
        name: flow.name,
        file: relative,
        format: 'yaml',
        ...(Array.isArray(flow.steps) ? { steps: flow.steps.length } : {}),
        ...(from ? { fromRecording: from } : {}),
        ...(typeof flow.description === 'string' ? { description: flow.description } : {}),
        ...(flow.reusable === true ? { reusable: true } : {}),
        ...(runs.length > 0 ? { uses: runs } : {}),
      });
    }
  }
  return scenarios;
}

const PROMOTED_FILE = 'sdk-scenarios.json';

async function promotedOrigins(projectDir: string): Promise<Record<string, string>> {
  try {
    return (
      (
        JSON.parse(await readFile(path.join(projectDir, PROMOTED_FILE), 'utf8')) as {
          origins?: Record<string, string>;
        }
      ).origins ?? {}
    );
  } catch {
    return {};
  }
}

/**
 * UN ENREGISTREMENT DEVIENT UN SCÉNARIO : son flow YAML et son jeu de données copiés dans le dossier
 * des flows (comme « Sauvegarder » dans la fenêtre du recorder). Le flow rejoué est celui-là, tel quel.
 */
export async function promoteRecording(
  projectDir: string,
  recordingDir: string,
  name: string,
): Promise<{ scenario: ScenarioView } | { error: string }> {
  const yamlFile = path.join(recordingDir, 'generated.flow.yaml');
  if (!(await exists(yamlFile))) return { error: `recording "${name}" has no generated flow (YAML)` };
  const base = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'recording';
  const root = await flowsDirOf(projectDir);
  const target = path.join(root, base);
  await mkdir(target, { recursive: true });
  await copyFile(yamlFile, path.join(target, `${base}.flow.yaml`));
  const data = path.join(recordingDir, 'test-data.yaml');
  if (await exists(data)) await copyFile(data, path.join(target, 'test-data.yaml'));
  const relative = `${base}/${base}.flow.yaml`;
  const origins = { ...(await promotedOrigins(projectDir)), [relative]: name };
  await writeFile(path.join(projectDir, PROMOTED_FILE), `${JSON.stringify({ origins }, null, 2)}\n`, 'utf8');
  const scenario = (await listScenarios(projectDir)).find((entry) => entry.file === relative);
  return scenario
    ? { scenario }
    : { error: `the flow of "${name}" has no name: it cannot be replayed by name` };
}

// ── Exécutions ──────────────────────────────────────────────────────────────────────────────

export interface ExecutionMeta {
  kind: ExecutionKind;
  startedAt: string;
  environment?: { id: string; name: string };
  scenarios?: string[];
}

export async function writeExecutionMeta(runDir: string, meta: ExecutionMeta): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, EXECUTION_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** La date d'un run : celle de sa fiche, de son résultat, sinon celle de son nom (`run-2026-10-24T09-00-00-000Z`). */
function runDate(run: string, meta?: ExecutionMeta, result?: ExplorationResult): string {
  if (meta?.startedAt) return meta.startedAt;
  if (result?.startedAt) return result.startedAt;
  const match = /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(run);
  return match
    ? `${match[1] ?? ''}T${match[2] ?? ''}:${match[3] ?? ''}:${match[4] ?? ''}.${match[5] ?? ''}Z`
    : '';
}

/** Le verdict, lu dans les flows du résultat (voir EXECUTION_VERDICTS). */
export function verdictOf(result: ExplorationResult | undefined): ExecutionVerdict {
  if (!result) return 'INCOMPLETE';
  if (result.stopReason === 'cancelled') return 'CANCELLED';
  if (result.flows.length === 0) return 'NO_FLOW';
  return result.flows.every((flow) => flow.status === 'PASSED') ? 'PASSED' : 'FAILED';
}

function recordOf(
  projectId: string,
  run: string,
  meta?: ExecutionMeta,
  result?: ExplorationResult,
): ExecutionRecord {
  const flows = result?.flows ?? [];
  const passed = flows.filter((flow) => flow.status === 'PASSED').length;
  // Sans fiche du SDK (CLI, runs plus anciens) : un run qui n'a joué que des flows est un rejeu.
  const kind: ExecutionKind = meta?.kind ?? (result?.stopReason === 'flows-only' ? 'REPLAY' : 'EXPLORATION');
  return {
    run,
    projectId,
    kind,
    createdAt: runDate(run, meta, result),
    verdict: verdictOf(result),
    ...(result ? { durationMs: result.durationMs } : {}),
    flows: { total: flows.length, passed, failed: flows.length - passed },
    issues: result?.issues.length ?? 0,
    ...(meta?.environment ? { environment: meta.environment } : {}),
    ...(meta?.scenarios ? { scenarios: meta.scenarios } : {}),
  };
}

const RUN_NAME = /^run-[A-Za-z0-9-]{1,80}$/;

export function isRunName(run: string): boolean {
  return RUN_NAME.test(run);
}

/** Les exécutions d'un projet, les plus récentes d'abord (dossiers `run-…` des rapports). */
export async function listExecutions(projectId: string, reportsDir: string): Promise<ExecutionRecord[]> {
  if (!(await exists(reportsDir))) return [];
  const runs = (await readdir(reportsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_PREFIX) && isRunName(entry.name))
    .map((entry) => entry.name);
  const records = await Promise.all(
    runs.map(async (run) => {
      const directory = path.join(reportsDir, run);
      return recordOf(
        projectId,
        run,
        await readJson<ExecutionMeta>(path.join(directory, EXECUTION_META_FILE)),
        await readJson<ExplorationResult>(path.join(directory, RESULT_FILE)),
      );
    }),
  );
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.run.localeCompare(a.run));
}

/**
 * L'HISTORIQUE DES SCÉNARIOS : pour chacun, le statut de son flow dans les derniers runs qui l'ont joué
 * (du plus récent au plus ancien), lu dans les résultats du moteur. Une bascule est un passage de
 * PASSED à FAILED ou l'inverse entre deux runs consécutifs ; les autres statuts (SKIPPED, BLOCKED) ne
 * comptent ni comme réussite ni comme échec.
 */
export async function scenarioHistory(
  projectId: string,
  reportsDir: string,
  limit: number,
): Promise<ScenarioHistoryView[]> {
  const records = await listExecutions(projectId, reportsDir);
  const byName = new Map<string, ScenarioRunStatus[]>();
  for (const record of records) {
    const result = await readJson<ExplorationResult>(path.join(reportsDir, record.run, RESULT_FILE));
    for (const flow of result?.flows ?? []) {
      const runs = byName.get(flow.name) ?? [];
      if (runs.length >= limit) continue;
      runs.push({ run: record.run, at: record.createdAt, status: flow.status, durationMs: flow.durationMs });
      byName.set(flow.name, runs);
    }
  }
  return [...byName.entries()]
    .map(([name, runs]) => {
      const decided = runs.filter((entry) => entry.status === 'PASSED' || entry.status === 'FAILED');
      let flips = 0;
      for (let index = 1; index < decided.length; index += 1)
        if (decided[index]?.status !== decided[index - 1]?.status) flips += 1;
      return {
        name,
        runs,
        passed: decided.filter((entry) => entry.status === 'PASSED').length,
        failed: decided.filter((entry) => entry.status === 'FAILED').length,
        flips,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function relativeTo(directory: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  const relative = path.relative(path.resolve(directory), path.resolve(directory, file));
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? undefined
    : relative.split(path.sep).join('/');
}

function flowView(flow: FlowRunReport, directory: string): ExecutionFlowView {
  return {
    name: flow.name,
    status: flow.status,
    durationMs: flow.durationMs,
    steps: flow.steps.map((step) => {
      const screenshot = relativeTo(directory, step.screenshot);
      return {
        index: step.index,
        kind: step.kind,
        label: stepLabel(step),
        status: step.status,
        durationMs: step.durationMs,
        // Une raison n'est jamais relayée pour une saisie (elle pourrait citer la valeur).
        ...(step.reason && step.kind !== 'fill' && step.kind !== 'select' ? { reason: step.reason } : {}),
        ...(screenshot ? { screenshot } : {}),
      };
    }),
    ...(flow.divergence
      ? { divergence: { stepIndex: flow.divergence.stepIndex, reason: flow.divergence.reason } }
      : {}),
    assertions: (flow.quality?.assertions ?? []).map((assertion) => ({
      id: assertion.id,
      description: assertion.description,
      status: assertion.status,
    })),
    // Les clés saisies ou citées (rapport des données du moteur, puis citations des étapes) ; jamais les valeurs.
    testData: [
      ...new Set([
        ...(flow.testDataReport?.entries ?? []).map((entry) => entry.key),
        ...flow.steps.flatMap((step) => step.testData ?? []),
      ]),
    ],
  };
}

/** Le détail d'une exécution : flows, étapes, assertions, anomalies, rapports (fichiers du run). */
export async function executionDetail(
  projectId: string,
  reportsDir: string,
  run: string,
): Promise<ExecutionDetail | undefined> {
  if (!isRunName(run)) return undefined;
  const directory = path.join(reportsDir, run);
  if (!(await exists(directory))) return undefined;
  const meta = await readJson<ExecutionMeta>(path.join(directory, EXECUTION_META_FILE));
  const result = await readJson<ExplorationResult>(path.join(directory, RESULT_FILE));
  const reports: Partial<Record<ReportKind, string>> = {};
  for (const kind of REPORT_KINDS) {
    const relative = relativeTo(directory, result?.artifacts[kind]);
    if (relative) reports[kind] = relative;
  }
  const issues: ExplorationIssue[] = (result?.issues ?? []).slice(0, MAX_ISSUES).map((issue) => ({
    id: issue.id,
    severity: issue.severity,
    type: issue.type,
    message: issue.message,
    pageUrl: issue.pageUrl,
  }));
  return {
    ...recordOf(projectId, run, meta, result),
    ...(result ? { stopReason: result.stopReason } : {}),
    flowsDetail: (result?.flows ?? []).map((flow) => flowView(flow, directory)),
    issuesList: issues,
    reports,
  };
}

// ── Vue d'ensemble ──────────────────────────────────────────────────────────────────────────

export interface OverviewProject {
  id: string;
  name: string;
  archived: boolean;
  reportsDir: string;
  scenarios: number;
  recordings: number;
  environments: readonly Environment[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const PASS_RATE_DEFINITION =
  'REPLAY executions finished in the period with a verdict (cancelled ones excluded); passed = every replayed flow PASSED';

/** La vue d'ensemble, calculée sur les runs écrits par le moteur dans la période. */
export async function computeOverview(
  projects: readonly OverviewProject[],
  options: { days: number; now?: Date; env: NodeJS.ProcessEnv },
): Promise<OverviewView> {
  const now = options.now ?? new Date();
  const days = Math.min(Math.max(Math.trunc(options.days), 1), 90);
  const from = new Date(now.getTime() - days * DAY_MS);
  const byKind: Record<ExecutionKind, number> = { EXPLORATION: 0, REPLAY: 0 };
  const issues = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  const trend = new Map<string, { passed: number; failed: number }>();
  for (let offset = days - 1; offset >= 0; offset -= 1)
    trend.set(new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10), { passed: 0, failed: 0 });
  const recent: OverviewView['recent'] = [];
  const alerts: OverviewAlert[] = [];
  let total = 0;
  let finished = 0;
  let passed = 0;
  for (const project of projects) {
    const executions = await listExecutions(project.id, project.reportsDir);
    const inPeriod = executions.filter((execution) => {
      const at = Date.parse(execution.createdAt);
      return Number.isFinite(at) && at >= from.getTime() && at <= now.getTime();
    });
    for (const execution of inPeriod) {
      total += 1;
      byKind[execution.kind] += 1;
      recent.push({ ...execution, projectName: project.name });
      // Un rejeu compte s'il a rendu un verdict : une annulation n'est ni une réussite ni un échec.
      if (execution.kind === 'REPLAY' && (execution.verdict === 'PASSED' || execution.verdict === 'FAILED')) {
        finished += 1;
        if (execution.verdict === 'PASSED') passed += 1;
        const day = trend.get(execution.createdAt.slice(0, 10));
        if (day) {
          if (execution.verdict === 'PASSED') day.passed += 1;
          else day.failed += 1;
        }
      }
      const result = await readJson<ExplorationResult>(
        path.join(project.reportsDir, execution.run, RESULT_FILE),
      );
      const bySeverity = result?.stats.issuesBySeverity as Partial<Record<Severity, number>> | undefined;
      for (const severity of SEVERITIES) issues[severity] += bySeverity?.[severity] ?? 0;
      if (!project.archived && (bySeverity?.CRITICAL ?? 0) > 0)
        alerts.push({
          kind: 'CRITICAL_ISSUES',
          projectId: project.id,
          projectName: project.name,
          run: execution.run,
          message: `${String(bySeverity?.CRITICAL ?? 0)} critical issue(s) in ${execution.run}`,
        });
    }
    const last = executions.find(
      (execution) => execution.verdict !== 'INCOMPLETE' && execution.verdict !== 'CANCELLED',
    );
    if (!project.archived && last?.verdict === 'FAILED')
      alerts.push({
        kind: 'EXECUTION_FAILED',
        projectId: project.id,
        projectName: project.name,
        run: last.run,
        message: `the last execution (${last.run}) failed: ${String(last.flows.failed)}/${String(last.flows.total)} flow(s) not passed`,
      });
    if (!project.archived)
      for (const environment of project.environments)
        for (const name of environment.secretEnv ?? [])
          if (!(typeof options.env[name] === 'string' && options.env[name] !== ''))
            alerts.push({
              kind: 'SECRET_MISSING',
              projectId: project.id,
              projectName: project.name,
              message: `${name} (environment "${environment.name}") is not defined on the server`,
            });
  }
  recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    generatedAt: now.toISOString(),
    period: { days, from: from.toISOString(), to: now.toISOString() },
    projects: {
      active: projects.filter((project) => !project.archived).length,
      archived: projects.filter((project) => project.archived).length,
    },
    scenarios: projects.reduce((sum, project) => sum + project.scenarios, 0),
    recordings: projects.reduce((sum, project) => sum + project.recordings, 0),
    executions: { total, byKind },
    replays: {
      finished,
      passed,
      failed: finished - passed,
      ...(finished > 0 ? { passRate: passed / finished } : {}),
      definition: PASS_RATE_DEFINITION,
    },
    issues,
    recent: recent.slice(0, 10),
    alerts,
    trend: [...trend.entries()].map(([day, counts]) => ({ day, ...counts })),
  };
}
