import { access, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createQaCrawler, QaCrawlerError, type QaCrawlerClient } from '../sdk/core/client.js';
import type {
  Environment,
  ExecutionDetail,
  ExecutionRecord,
  ExplorationSnapshot,
  ProjectSummary,
} from '../sdk/core/contracts.js';
import { isTerminal } from '../sdk/core/lifecycle.js';
import { openQaCrawler, type QaCrawlerNode } from '../sdk/server/node.js';
import { REPORTS_DIR } from '../sdk/server/project.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import { junitXmlOf } from '../reporting/junit-reporter.js';
import { UsageError } from './args.js';
import { logger } from './logger.js';

/**
 * LA CLI DE LA PLATEFORME : les projets, environnements, scénarios, exécutions et la vue d'ensemble
 * d'un espace de travail du SDK. Aucune logique propre : chaque commande appelle le client du SDK,
 * soit sur le service ouvert dans la CLI même (`--workspace`), soit sur un `qa-crawler sdk-server`
 * déjà lancé (`--endpoint`, jeton lu dans une variable d'environnement, jamais affiché). Les règles
 * (SafetyPolicy, environnements, archivage, confirmation) sont celles du serveur, pour toutes les
 * interfaces.
 */
export const PLATFORM_COMMANDS = ['project', 'env', 'scenario', 'run', 'overview', 'doctor'] as const;
export type PlatformCommand = (typeof PLATFORM_COMMANDS)[number];

/** 0 réussi · 1 échec QA · 2 usage ou configuration · 3 outil ou infrastructure · 130 annulé (Ctrl+C). */
export const PLATFORM_EXIT = { OK: 0, FAILED: 1, USAGE: 2, RUNTIME: 3, CANCELLED: 130 } as const;

export const PLATFORM_HELP = `qa-crawler — the SDK workspace from the command line (projects, environments, scenarios, runs)

Usage:
  qa-crawler project list [--archived]
  qa-crawler project show <project>
  qa-crawler env list <project>
  qa-crawler env show <project> <environment>
  qa-crawler env validate <project> <environment> [--reach]   ready to run: rules, secrets present, URL (--reach)
  qa-crawler scenario list <project>
  qa-crawler scenario promote <project> <recording>
  qa-crawler run start <project> [--env <environment>] [--scenario <name>]... [--junit <file>] [--detach]
  qa-crawler run list <project>
  qa-crawler run results <project> <run>
  qa-crawler run status <execution id>          (with --endpoint: a live execution)
  qa-crawler run cancel <execution id>          (with --endpoint: a live execution)
  qa-crawler overview [--days <n>]
  qa-crawler doctor

<project> and <environment>: a name or an identifier.

Connection (one of):
      --workspace <dir>     The SDK workspace; the service opens inside the CLI (127.0.0.1, free port)
      --endpoint <url>      A running qa-crawler sdk-server
      --token-env <NAME>    With --endpoint: the variable holding the API token (default: QA_SDK_TOKEN)

Options:
      --json                One JSON document on stdout (errors too: {"error": {...}})
      --env <environment>   run start: the target environment (default: the project's own target)
      --scenario <name>     run start: a scenario to replay (repeatable; default: all)
      --junit <file>        run start, run results (with --workspace): also write the run as JUnit XML
      --detach              run start (with --endpoint): print the execution and return at once
      --reach               env validate: also check that the base URL answers
      --days <n>            overview: the period (default: 7)
      --archived            project list: archived projects too
      --language <fr|en>    With --workspace: language of the engine reports (default: en)
  -h, --help                This help

Ctrl+C during run start: the first one cancels (the engine stops before the next action and writes its
report), a second one exits at once.

Exit codes: 0 success · 1 QA failure (verdict FAILED) · 2 usage or configuration error
            3 infrastructure/tool error, or no verdict · 130 cancelled
`;

interface PlatformArgs {
  sub?: string;
  positionals: string[];
  workspace?: string;
  endpoint?: string;
  tokenEnv: string;
  json: boolean;
  env?: string;
  scenarios: string[];
  junit?: string;
  detach: boolean;
  reach: boolean;
  days?: number;
  archived: boolean;
  language: 'fr' | 'en';
  help: boolean;
}

export function parsePlatformArgs(argv: readonly string[]): PlatformArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        workspace: { type: 'string' },
        endpoint: { type: 'string' },
        'token-env': { type: 'string' },
        json: { type: 'boolean' },
        env: { type: 'string' },
        scenario: { type: 'string', multiple: true },
        junit: { type: 'string' },
        detach: { type: 'boolean' },
        reach: { type: 'boolean' },
        days: { type: 'string' },
        archived: { type: 'boolean' },
        language: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.workspace !== undefined && values.endpoint !== undefined)
    throw new UsageError('--workspace and --endpoint cannot be used together');
  if (values.endpoint !== undefined && !/^https?:\/\//i.test(values.endpoint))
    throw new UsageError('--endpoint must be an http(s) URL');
  let days: number | undefined;
  if (values.days !== undefined) {
    days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 366)
      throw new UsageError('--days must be an integer from 1 to 366');
  }
  const language = values.language ?? 'en';
  if (language !== 'fr' && language !== 'en') throw new UsageError('--language must be fr or en');
  const [sub, ...rest] = positionals;
  return {
    ...(sub !== undefined ? { sub } : {}),
    positionals: rest,
    ...(values.workspace !== undefined ? { workspace: path.resolve(values.workspace) } : {}),
    ...(values.endpoint !== undefined ? { endpoint: values.endpoint } : {}),
    tokenEnv: values['token-env'] ?? 'QA_SDK_TOKEN',
    json: values.json ?? false,
    ...(values.env !== undefined ? { env: values.env } : {}),
    scenarios: values.scenario ?? [],
    ...(values.junit !== undefined ? { junit: path.resolve(values.junit) } : {}),
    detach: values.detach ?? false,
    reach: values.reach ?? false,
    ...(days !== undefined ? { days } : {}),
    archived: values.archived ?? false,
    language,
    help: values.help ?? false,
  };
}

export interface PlatformRuntime {
  env?: NodeJS.ProcessEnv;
  /** Une ligne de résultat (stdout) ; masquée comme toute sortie de la CLI. */
  out?: (line: string) => void;
  /** Un message d'erreur ou de suivi (stderr). */
  err?: (line: string) => void;
  /** Ouvre le service local (tests : un moteur simulé). */
  open?: (workspace: string, language: 'fr' | 'en') => Promise<QaCrawlerNode>;
  /** La source de Ctrl+C (tests). */
  signals?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
  /** Quitter tout de suite (second Ctrl+C). */
  exit?: (code: number) => void;
}

interface Session {
  client: QaCrawlerClient;
  /** L'espace de travail lu sur disque (mode local) ; absent avec --endpoint. */
  workspace?: string;
  close(): Promise<void>;
}

class PlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number,
  ) {
    super(message);
  }
}

const usage = (message: string): PlatformError => new PlatformError('USAGE', message, PLATFORM_EXIT.USAGE);

export async function runPlatformCli(
  command: PlatformCommand,
  argv: string[],
  runtime: PlatformRuntime = {},
): Promise<number> {
  const out =
    runtime.out ??
    ((line: string) => {
      logger.info(line);
    });
  const err =
    runtime.err ??
    ((line: string) => {
      logger.error(line);
    });
  let args: PlatformArgs;
  try {
    args = parsePlatformArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`Error: ${error.message}\n`);
      err(PLATFORM_HELP);
      return PLATFORM_EXIT.USAGE;
    }
    throw error;
  }
  if (args.help) {
    out(PLATFORM_HELP);
    return PLATFORM_EXIT.OK;
  }
  const fail = (error: PlatformError): number => {
    if (args.json) out(JSON.stringify({ error: { code: error.code, message: error.message } }));
    else err(`Error: ${error.message}`);
    return error.exit;
  };

  let session: Session | undefined;
  try {
    if (command === 'doctor') return await doctor(args, runtime, out);
    session = await openSession(args, runtime);
    const context: CommandContext = { args, session, out, err, runtime };
    switch (command) {
      case 'project':
        return await projectCommand(context);
      case 'env':
        return await envCommand(context);
      case 'scenario':
        return await scenarioCommand(context);
      case 'run':
        return await runCommand(context);
      case 'overview':
        return await overviewCommand(context);
      default:
        throw usage(`unknown command: ${String(command)}`);
    }
  } catch (error) {
    return fail(asPlatformError(error));
  } finally {
    await session?.close();
  }
}

function asPlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  if (error instanceof QaCrawlerError) {
    // Le serveur décide : un refus (4xx) est un problème d'usage ou de configuration, le reste de l'infrastructure.
    if (error.status === 0) return new PlatformError(error.code, error.message, PLATFORM_EXIT.RUNTIME);
    const exit = error.status >= 400 && error.status < 500 ? PLATFORM_EXIT.USAGE : PLATFORM_EXIT.RUNTIME;
    return new PlatformError(error.code, error.message, exit);
  }
  return new PlatformError(
    'RUNTIME',
    error instanceof Error ? error.message : String(error),
    PLATFORM_EXIT.RUNTIME,
  );
}

async function openSession(args: PlatformArgs, runtime: PlatformRuntime): Promise<Session> {
  if (args.endpoint) {
    const token = (runtime.env ?? process.env)[args.tokenEnv];
    if (!token) throw usage(`the environment variable ${args.tokenEnv} must hold the API token`);
    const base = args.endpoint.replace(/\/+$/, '');
    const client = createQaCrawler({ endpoint: base.endsWith('/api') ? base : `${base}/api`, token });
    // La version du contrat d'abord : un serveur d'une autre version est refusé (API_VERSION_MISMATCH).
    await client.connect();
    return {
      client,
      close: () => {
        client.dispose();
        return Promise.resolve();
      },
    };
  }
  if (!args.workspace) throw usage('--workspace <dir> or --endpoint <url> is required');
  if (!(await isDirectory(args.workspace))) throw usage(`the workspace does not exist: ${args.workspace}`);
  const node = await (runtime.open ?? defaultOpen)(args.workspace, args.language);
  return { client: node.client, workspace: args.workspace, close: () => node.close() };
}

const defaultOpen = (workspace: string, language: 'fr' | 'en'): Promise<QaCrawlerNode> =>
  openQaCrawler({
    workspace,
    language,
    onWarning: (message) => {
      logger.warn(message);
    },
  });

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

interface CommandContext {
  args: PlatformArgs;
  session: Session;
  out: (line: string) => void;
  err: (line: string) => void;
  runtime: PlatformRuntime;
}

function positional(context: CommandContext, index: number, name: string): string {
  const value = context.args.positionals[index];
  if (value === undefined || value === '') throw usage(`<${name}> is required`);
  return value;
}

function unknownSub(command: string, sub: string | undefined, known: string[]): PlatformError {
  return usage(
    sub === undefined
      ? `qa-crawler ${command} needs a command: ${known.join(', ')}`
      : `unknown command: qa-crawler ${command} ${sub} (known: ${known.join(', ')})`,
  );
}

async function projectOf(context: CommandContext, key: string): Promise<ProjectSummary> {
  const projects = await context.session.client.projects.list({ archived: true });
  const byId = projects.find((project) => project.id === key);
  if (byId) return byId;
  const byName = projects.filter((project) => project.name === key);
  if (byName.length > 1) throw usage(`several projects are named "${key}": use the identifier`);
  const found = byName[0];
  if (!found) throw usage(`project not found: ${key}`);
  return found;
}

async function environmentOf(context: CommandContext, projectId: string, key: string): Promise<Environment> {
  const environments = await context.session.client.environments.list(projectId);
  const found =
    environments.find((environment) => environment.id === key) ??
    environments.find((environment) => environment.name === key);
  if (!found) throw usage(`environment not found: ${key}`);
  return found;
}

function emit(context: CommandContext, payload: unknown, text: () => string[]): void {
  if (context.args.json) context.out(JSON.stringify(payload, null, 2));
  else for (const line of text()) context.out(line);
}

/** Un tableau en colonnes alignées (texte seulement). */
function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  return rows.map((row) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}

async function projectCommand(context: CommandContext): Promise<number> {
  const { client } = context.session;
  switch (context.args.sub) {
    case 'list': {
      const projects = await client.projects.list(context.args.archived ? { archived: true } : {});
      emit(context, projects, () =>
        projects.length === 0
          ? ['No project in this workspace.']
          : table([
              ['ID', 'NAME', 'STATE', 'ENVS', 'SCENARIOS', 'RUNS', 'LAST RUN'],
              ...projects.map((project) => [
                project.id,
                project.name,
                project.state,
                String(project.counts.environments),
                String(project.counts.scenarios),
                String(project.counts.executions),
                project.lastExecution
                  ? `${project.lastExecution.verdict} ${project.lastExecution.createdAt}`
                  : '-',
              ]),
            ]),
      );
      return PLATFORM_EXIT.OK;
    }
    case 'show': {
      const summary = await projectOf(context, positional(context, 0, 'project'));
      const detail = await client.projects.detail(summary.id);
      emit(context, detail, () => [
        `${detail.name} (${detail.id}) — ${detail.state}`,
        `  Target       : ${detail.targetUrl}`,
        `  Created      : ${detail.createdAt}${detail.updatedAt ? ` · updated ${detail.updatedAt}` : ''}`,
        `  Environments : ${detail.environments.map((environment) => `${environment.name} [${environment.kind}]`).join(', ') || '-'}`,
        `  Scenarios    : ${detail.scenarios.map((scenario) => scenario.name).join(', ') || '-'}`,
        `  Runs         : ${String(detail.counts.executions)}${detail.lastExecution ? ` · last ${detail.lastExecution.verdict} (${detail.lastExecution.run})` : ''}`,
      ]);
      return PLATFORM_EXIT.OK;
    }
    default:
      throw unknownSub('project', context.args.sub, ['list', 'show']);
  }
}

function environmentLines(environment: Environment): string[] {
  return [
    `${environment.name} (${environment.id}) — ${environment.kind}`,
    `  Base URL     : ${environment.baseUrl}`,
    `  Domains      : ${(environment.allowedDomains ?? []).join(', ') || '(the base URL host)'}`,
    `  Writes       : ${environment.mutations?.enabled ? `allowed, at most ${String(environment.mutations.maxPerRun ?? '-')} per run` : 'none'}`,
    // Les noms des variables secrètes seulement : leur valeur reste sur le serveur.
    `  Secrets      : ${(environment.secretEnv ?? []).join(', ') || '-'}`,
    `  Variables    : ${Object.keys(environment.variables ?? {}).join(', ') || '-'}`,
  ];
}

async function envCommand(context: CommandContext): Promise<number> {
  const { client } = context.session;
  const sub = context.args.sub;
  if (sub !== 'list' && sub !== 'show' && sub !== 'validate')
    throw unknownSub('env', sub, ['list', 'show', 'validate']);
  const project = await projectOf(context, positional(context, 0, 'project'));
  if (sub === 'list') {
    const environments = await client.environments.list(project.id);
    emit(context, environments, () =>
      environments.length === 0
        ? [`No environment in ${project.name}.`]
        : table([
            ['ID', 'NAME', 'KIND', 'BASE URL', 'WRITES'],
            ...environments.map((environment) => [
              environment.id,
              environment.name,
              environment.kind,
              environment.baseUrl,
              environment.mutations?.enabled ? 'allowed' : 'none',
            ]),
          ]),
    );
    return PLATFORM_EXIT.OK;
  }
  const environment = await environmentOf(context, project.id, positional(context, 1, 'environment'));
  if (sub === 'show') {
    emit(context, environment, () => environmentLines(environment));
    return PLATFORM_EXIT.OK;
  }
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = environment;
  const check = await client.environments.check(project.id, input, {
    reach: context.args.reach,
    selfId: environment.id,
  });
  // Prêt à lancer : la forme et les règles du moteur (ok), chaque secret cité présent, l'URL qui répond (--reach).
  const ready =
    check.ok &&
    Object.values(check.secrets).every(Boolean) &&
    (check.url?.reachable === undefined || check.url.reachable.ok);
  emit(context, { ...check, ready }, () => [
    `${environment.name}: ${ready ? 'READY' : 'NOT READY'}`,
    ...check.issues.map((issue) => `  ✗ ${issue.field}: ${issue.message}`),
    ...Object.entries(check.secrets).map(
      ([name, present]) =>
        `  ${present ? '✓' : '✗'} ${name} ${present ? 'defined' : 'missing'} on the server`,
    ),
    ...(check.url?.reachable
      ? [
          `  ${check.url.reachable.ok ? '✓' : '✗'} ${environment.baseUrl} ${check.url.reachable.ok ? 'answers' : 'does not answer'}`,
        ]
      : []),
  ]);
  return ready ? PLATFORM_EXIT.OK : PLATFORM_EXIT.USAGE;
}

async function scenarioCommand(context: CommandContext): Promise<number> {
  const { client } = context.session;
  const sub = context.args.sub;
  if (sub !== 'list' && sub !== 'promote') throw unknownSub('scenario', sub, ['list', 'promote']);
  const project = await projectOf(context, positional(context, 0, 'project'));
  if (sub === 'list') {
    const scenarios = await client.scenarios.list(project.id);
    emit(context, scenarios, () =>
      scenarios.length === 0
        ? [`No scenario in ${project.name}.`]
        : table([
            ['NAME', 'FORMAT', 'STEPS', 'FILE', 'FROM RECORDING'],
            ...scenarios.map((scenario) => [
              scenario.name,
              scenario.format,
              scenario.steps === undefined ? '-' : String(scenario.steps),
              scenario.file,
              scenario.fromRecording ?? '-',
            ]),
          ]),
    );
    return PLATFORM_EXIT.OK;
  }
  const scenario = await client.scenarios.promote(project.id, positional(context, 1, 'recording'));
  emit(context, scenario, () => [`Scenario ${scenario.name} added (${scenario.file}).`]);
  return PLATFORM_EXIT.OK;
}

const VERDICT_EXIT: Record<ExecutionRecord['verdict'], number> = {
  PASSED: PLATFORM_EXIT.OK,
  FAILED: PLATFORM_EXIT.FAILED,
  CANCELLED: PLATFORM_EXIT.CANCELLED,
  NO_FLOW: PLATFORM_EXIT.RUNTIME,
  INCOMPLETE: PLATFORM_EXIT.RUNTIME,
};

function detailLines(detail: ExecutionDetail): string[] {
  return [
    ...detail.flowsDetail.flatMap((flow) => [
      `▶ ${flow.name}: ${flow.status}`,
      ...flow.steps.map(
        (step) =>
          `   ${step.status.padEnd(7)} ${String(step.index)}. ${step.label}${step.reason ? ` — ${step.reason}` : ''}`,
      ),
      ...flow.assertions.map((assertion) => `   ${assertion.status.padEnd(7)} assertion ${assertion.id}`),
    ]),
    `■ ${detail.verdict} — ${String(detail.flows.passed)}/${String(detail.flows.total)} flow(s) passed · run ${detail.run}${detail.environment ? ` · ${detail.environment.name}` : ''}`,
  ];
}

async function runCommand(context: CommandContext): Promise<number> {
  const { client } = context.session;
  const sub = context.args.sub;
  switch (sub) {
    case 'start':
      return startRun(context);
    case 'list': {
      const project = await projectOf(context, positional(context, 0, 'project'));
      const executions = await client.executions.list(project.id);
      emit(context, executions, () =>
        executions.length === 0
          ? [`No run in ${project.name}.`]
          : table([
              ['RUN', 'KIND', 'VERDICT', 'FLOWS', 'ENVIRONMENT', 'CREATED'],
              ...executions.map((execution) => [
                execution.run,
                execution.kind,
                execution.verdict,
                `${String(execution.flows.passed)}/${String(execution.flows.total)}`,
                execution.environment?.name ?? '-',
                execution.createdAt,
              ]),
            ]),
      );
      return PLATFORM_EXIT.OK;
    }
    case 'results': {
      const project = await projectOf(context, positional(context, 0, 'project'));
      const detail = await client.executions.get(project.id, positional(context, 1, 'run'));
      await writeJunit(context, project.id, detail.run);
      emit(context, detail, () => detailLines(detail));
      return VERDICT_EXIT[detail.verdict];
    }
    case 'status':
    case 'cancel': {
      // L'état vivant d'une exécution est dans le serveur qui la joue : pas dans un service ouvert pour une commande.
      if (context.session.workspace)
        throw usage(`run ${sub} needs --endpoint (the server that plays the execution)`);
      const id = positional(context, 0, 'execution id');
      const snapshot =
        sub === 'cancel' ? await client.explorations.cancel(id) : await client.explorations.status(id);
      emit(context, snapshot, () => [
        `${snapshot.id}: ${snapshot.status}${snapshot.run ? ` · run ${snapshot.run}` : ''}${snapshot.error ? ` — ${snapshot.error}` : ''}`,
      ]);
      return PLATFORM_EXIT.OK;
    }
    default:
      throw unknownSub('run', sub, ['start', 'list', 'results', 'status', 'cancel']);
  }
}

async function startRun(context: CommandContext): Promise<number> {
  const { client } = context.session;
  const { args } = context;
  if (args.detach && context.session.workspace)
    throw usage('--detach needs --endpoint: a service opened by the CLI closes with it');
  if (args.junit && !context.session.workspace)
    throw usage('--junit needs --workspace (the run is read on disk)');
  const project = await projectOf(context, positional(context, 0, 'project'));
  const environment = args.env ? await environmentOf(context, project.id, args.env) : undefined;
  const started = await client.executions.start(project.id, {
    ...(environment ? { environmentId: environment.id } : {}),
    ...(args.scenarios.length > 0 ? { scenarios: args.scenarios } : {}),
  });
  if (args.detach) {
    emit(context, started, () => [`${started.id}: ${started.status} · run ${started.run ?? '-'}`]);
    return PLATFORM_EXIT.OK;
  }
  if (!args.json)
    context.err(
      `▶ ${project.name}${environment ? ` · ${environment.name}` : ''} · run ${started.run ?? '-'}`,
    );
  const last = await follow(context, started);
  if (last.status === 'FAILED' || !started.run)
    throw new PlatformError(
      'EXECUTION_FAILED',
      `the execution could not run: ${last.error ?? last.status}`,
      PLATFORM_EXIT.RUNTIME,
    );
  const detail = await client.executions.get(project.id, started.run);
  await writeJunit(context, project.id, detail.run);
  emit(context, detail, () => [
    `■ ${detail.verdict} — ${String(detail.flows.passed)}/${String(detail.flows.total)} flow(s) passed · run ${detail.run}`,
  ]);
  return VERDICT_EXIT[detail.verdict];
}

/** Suit l'exécution jusqu'à son état final ; Ctrl+C l'annule (le second quitte). */
async function follow(context: CommandContext, started: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  const { client } = context.session;
  const signals = context.runtime.signals ?? process;
  const exit = context.runtime.exit ?? ((code: number) => process.exit(code));
  let cancelling = false;
  const onSignal = (): void => {
    if (cancelling) {
      context.err('Second interruption: exiting now (the report may be incomplete).');
      exit(PLATFORM_EXIT.CANCELLED);
      return;
    }
    cancelling = true;
    context.err('Interruption requested: stopping before the next action (Ctrl+C again to exit now)…');
    client.explorations.cancel(started.id).catch((error: unknown) => {
      context.err(`Cancellation refused: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  signals.on('SIGINT', onSignal);
  try {
    if (!isTerminal(started.status))
      await new Promise<void>((resolve, reject) => {
        const subscription = client.explorations.subscribe(
          started.id,
          (event) => {
            if (event.type === 'flow-step' && !context.args.json)
              context.err(`   ${event.status.padEnd(7)} ${String(event.index)}. ${event.label}`);
            if (event.type === 'completed' || event.type === 'failed') {
              subscription.close();
              resolve();
            }
          },
          {
            onError: (error) => {
              reject(error);
            },
          },
        );
      });
    // L'état final : le flux s'arrête sur l'événement de fin, le statut suit juste après.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = await client.explorations.status(started.id);
      if (isTerminal(snapshot.status)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await client.explorations.status(started.id);
  } finally {
    signals.off('SIGINT', onSignal);
  }
}

/** --junit : le run lu sur disque (mode local), écrit en JUnit XML ; le verdict reste celui des flows. */
async function writeJunit(context: CommandContext, projectId: string, run: string): Promise<void> {
  const file = context.args.junit;
  if (!file) return;
  const workspace = context.session.workspace;
  if (!workspace) throw usage('--junit needs --workspace (the run is read on disk)');
  const source = path.join(workspace, projectId, REPORTS_DIR, run, 'result.json');
  let result: ExplorationResult;
  try {
    result = JSON.parse(await readFile(source, 'utf8')) as ExplorationResult;
  } catch {
    throw new PlatformError('RESULT_MISSING', `no engine result for ${run}`, PLATFORM_EXIT.RUNTIME);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, junitXmlOf(result, { failOnSeverity: 'NONE' }).xml, 'utf8');
  if (!context.args.json) context.err(`JUnit XML: ${file}`);
}

async function overviewCommand(context: CommandContext): Promise<number> {
  const overview = await context.session.client.overview.get(
    context.args.days !== undefined ? { days: context.args.days } : {},
  );
  emit(context, overview, () => [
    `Overview — last ${String(overview.period.days)} day(s)`,
    `  Projects     : ${String(overview.projects.active)} active, ${String(overview.projects.archived)} archived`,
    `  Scenarios    : ${String(overview.scenarios)} · recordings ${String(overview.recordings)}`,
    `  Executions   : ${String(overview.executions.total)} (${String(overview.executions.byKind.REPLAY)} replay, ${String(overview.executions.byKind.EXPLORATION)} exploration)`,
    `  Replays      : ${String(overview.replays.passed)} passed / ${String(overview.replays.finished)} finished${overview.replays.passRate === undefined ? ' — no pass rate (nothing finished)' : ` — pass rate ${String(Math.round(overview.replays.passRate * 100))}%`}`,
    `                 (${overview.replays.definition})`,
    ...overview.alerts.map((alert) => `  ! ${alert.kind} ${alert.message}`),
  ]);
  return PLATFORM_EXIT.OK;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Le diagnostic : Node, Chromium, l'espace de travail ou le serveur, la version du contrat. */
async function doctor(
  args: PlatformArgs,
  runtime: PlatformRuntime,
  out: (line: string) => void,
): Promise<number> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    ok: major >= 20,
    detail: `Node ${process.versions.node} (20 or later required)`,
  });
  try {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();
    await access(executable, constants.X_OK);
    checks.push({ name: 'chromium', ok: true, detail: 'Chromium installed' });
  } catch {
    checks.push({
      name: 'chromium',
      ok: false,
      detail: 'Chromium is not installed: npx playwright install chromium',
    });
  }
  if (args.workspace) {
    let writable = false;
    try {
      await access(args.workspace, constants.W_OK);
      writable = await isDirectory(args.workspace);
    } catch {
      writable = false;
    }
    checks.push({
      name: 'workspace',
      ok: writable,
      detail: writable
        ? `workspace ${args.workspace} writable`
        : `workspace ${args.workspace} missing or not writable`,
    });
  }
  if (args.workspace || args.endpoint) {
    let session: Session | undefined;
    try {
      session = await openSession(args, runtime);
      const capabilities = await session.client.connect();
      checks.push({
        name: 'service',
        ok: true,
        detail: `SDK API v${String(capabilities.apiVersion)} · engine ${capabilities.engineVersion} · cancellation ${capabilities.cancellation ? 'yes' : 'no'}`,
      });
    } catch (error) {
      checks.push({ name: 'service', ok: false, detail: asPlatformError(error).message });
    } finally {
      await session?.close();
    }
  }
  const ok = checks.every((check) => check.ok);
  if (args.json) out(JSON.stringify({ ok, checks }, null, 2));
  else for (const check of checks) out(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(10)} ${check.detail}`);
  return ok ? PLATFORM_EXIT.OK : PLATFORM_EXIT.RUNTIME;
}
