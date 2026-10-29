import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { redactText } from '../../security/redactor.js';
import type {
  GenerationFormatName,
  TestCaseView,
  TestRunStatus,
  TestRunView,
  TestRunnerView,
} from '../core/contracts.js';

/**
 * LES EXÉCUTIONS DES TESTS GÉNÉRÉS : un test généré n'est déclaré réussi que si un outil réel l'a joué
 * et a rapporté ses cas. Trois chemins :
 *   - YAML et Gherkin : le rejeu du moteur QA-CRAWLER, avec la mission du projet (SafetyPolicy,
 *     authentification, environnement) — le lanceur est fourni par le serveur ;
 *   - Playwright : Playwright Test avec la configuration générée, résultats lus dans le JUnit XML ;
 *   - Java : `mvn test`, résultats lus dans les rapports Surefire (JUnit XML).
 * Chaque exécution travaille sur une COPIE des fichiers générés (`test-runs/<id>/`) : une nouvelle
 * génération pendant l'exécution ne change pas ce qui est joué. Un outil absent donne UNAVAILABLE,
 * jamais un succès.
 */

export const TEST_RUNS_DIR = 'test-runs';
export const RUN_FILE = 'run.json';
export const TEST_RUN_ID = /^tr-[0-9TZ-]+-[a-z0-9]{6}$/;

const MAX_OUTPUT = 12_000;
const MAX_MESSAGE = 500;
const MAX_RUNS_LISTED = 20;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Ce qu'un lanceur rend : des cas observés, ou la raison de leur absence. */
export interface TestRunOutcome {
  status: Extract<TestRunStatus, 'PASSED' | 'FAILED' | 'ERROR' | 'CANCELLED' | 'UNAVAILABLE'>;
  cases: TestCaseView[];
  message?: string;
  report?: string;
  /** Dry Run : le verdict du moteur (FULLY_MATCHED, PARTIALLY_MATCHED…). */
  dryRunStatus?: string;
}

export interface TestRunTask {
  projectId: string;
  recording: string;
  format: GenerationFormatName;
  kind: 'ENGINE' | 'EXTERNAL';
  tool: string;
  target: string;
  environment?: { id: string; name: string };
  /** Les fichiers joués qui avaient été modifiés à la main. */
  edited?: string[];
  mode?: 'RUN' | 'DRY_RUN';
  /** Joué depuis un brouillon non enregistré (Dry Run seulement). */
  draft?: boolean;
  /** Le dossier de l'exécution (la copie des fichiers, la sortie, run.json). */
  directory: string;
  execute(context: { signal: AbortSignal; log: (text: string) => void }): Promise<TestRunOutcome>;
}

export class TestRun {
  readonly id: string;
  readonly queuedAt = new Date().toISOString();
  status: TestRunStatus = 'QUEUED';
  startedAt?: string;
  finishedAt?: string;
  cases: TestCaseView[] = [];
  message?: string;
  report?: string;
  dryRunStatus?: string;
  output = '';
  readonly abort = new AbortController();

  constructor(
    readonly task: TestRunTask,
    id = newRunId(),
  ) {
    this.id = id;
  }

  get terminal(): boolean {
    return !['QUEUED', 'RUNNING'].includes(this.status);
  }

  log(text: string): void {
    this.output = tail(this.output + redactText(text.replace(ANSI, '')), MAX_OUTPUT);
  }

  view(): TestRunView {
    return {
      id: this.id,
      recording: this.task.recording,
      format: this.task.format,
      status: this.status,
      tool: this.task.tool,
      kind: this.task.kind,
      target: this.task.target,
      ...(this.task.environment ? { environment: this.task.environment } : {}),
      queuedAt: this.queuedAt,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.finishedAt ? { finishedAt: this.finishedAt } : {}),
      ...(this.startedAt && this.finishedAt
        ? { durationMs: Date.parse(this.finishedAt) - Date.parse(this.startedAt) }
        : {}),
      cases: this.cases,
      counts: countsOf(this.cases),
      ...(this.message ? { message: this.message } : {}),
      output: this.output,
      ...(this.report ? { report: this.report } : {}),
      ...(this.task.edited ? { edited: this.task.edited } : {}),
      mode: this.task.mode ?? 'RUN',
      ...(this.dryRunStatus ? { dryRunStatus: this.dryRunStatus } : {}),
      ...(this.task.draft ? { draft: true } : {}),
    };
  }
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = Array.from(randomBytes(6), (byte) => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join(
    '',
  );
  return `tr-${stamp}-${suffix}`;
}

export function countsOf(cases: readonly TestCaseView[]): TestRunView['counts'] {
  return {
    passed: cases.filter((entry) => entry.status === 'PASSED').length,
    failed: cases.filter((entry) => entry.status === 'FAILED' || entry.status === 'BLOCKED').length,
    skipped: cases.filter((entry) => entry.status === 'SKIPPED' || entry.status === 'MANUAL').length,
    total: cases.length,
  };
}

/** Le verdict d'un ensemble de cas : FAILED dès un échec, ERROR sans aucun cas joué. */
export function verdictOf(cases: readonly TestCaseView[]): 'PASSED' | 'FAILED' | 'ERROR' {
  if (cases.length === 0) return 'ERROR';
  if (cases.some((entry) => entry.status === 'FAILED' || entry.status === 'BLOCKED')) return 'FAILED';
  return cases.some((entry) => entry.status === 'PASSED') ? 'PASSED' : 'ERROR';
}

const tail = (text: string, max: number): string =>
  text.length > max ? text.slice(text.length - max) : text;

/** Les codes de couleur et de curseur d'un terminal : illisibles dans une page. */
// eslint-disable-next-line no-control-regex -- le caractère d'échappement est ce qui est cherché
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export const shortMessage = (text: string): string => {
  const clean = redactText(text.replace(ANSI, '')).trim();
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
};

export interface TestRunManagerOptions {
  /** Exécutions simultanées (défaut 1 : un navigateur à la fois). */
  concurrency?: number;
}

/** La file des exécutions : une à la fois par défaut ; chacune écrit run.json à chaque changement. */
export class TestRunManager {
  private readonly runs = new Map<string, TestRun>();
  private readonly queue: TestRun[] = [];
  private running = 0;
  private readonly concurrency: number;

  constructor(options: TestRunManagerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  get(id: string): TestRun | undefined {
    return this.runs.get(id);
  }

  async start(task: TestRunTask): Promise<TestRun> {
    const run = new TestRun(task, path.basename(task.directory));
    this.runs.set(run.id, run);
    await persist(run);
    this.queue.push(run);
    this.pump();
    return run;
  }

  /** En file : jamais lancée ; en cours : l'outil est arrêté. Terminée : `false`. */
  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.terminal) return false;
    const queued = this.queue.indexOf(run);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      run.status = 'CANCELLED';
      run.message = 'cancelled before it started';
      run.finishedAt = new Date().toISOString();
      void persist(run);
      return true;
    }
    if (!run.abort.signal.aborted) {
      run.abort.abort();
      run.log('\n[qa-crawler] cancellation requested\n');
    }
    return true;
  }

  cancelAll(): number {
    let cancelled = 0;
    for (const run of this.runs.values()) if (this.cancel(run.id)) cancelled += 1;
    return cancelled;
  }

  async idle(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running > 0 || this.queue.length > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.running += 1;
      void this.execute(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async execute(run: TestRun): Promise<void> {
    run.status = 'RUNNING';
    run.startedAt = new Date().toISOString();
    await persist(run);
    try {
      const outcome = await run.task.execute({
        signal: run.abort.signal,
        log: (text) => {
          run.log(text);
        },
      });
      run.cases = outcome.cases;
      run.status =
        run.abort.signal.aborted && outcome.status !== 'UNAVAILABLE' ? 'CANCELLED' : outcome.status;
      if (outcome.message) run.message = shortMessage(outcome.message);
      if (outcome.report) run.report = outcome.report;
      if (outcome.dryRunStatus) run.dryRunStatus = outcome.dryRunStatus;
    } catch (error) {
      run.status = run.abort.signal.aborted ? 'CANCELLED' : 'ERROR';
      run.message = shortMessage(error instanceof Error ? error.message : String(error));
    }
    run.finishedAt = new Date().toISOString();
    await persist(run);
  }
}

/** run.json, écrit d'un bloc (fichier temporaire puis renommage). */
async function persist(run: TestRun): Promise<void> {
  await mkdir(run.task.directory, { recursive: true });
  const target = path.join(run.task.directory, RUN_FILE);
  const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run.view(), null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

/**
 * Les exécutions d'un enregistrement, les plus récentes d'abord : celles en mémoire (à jour), puis
 * celles relues sur disque. Une exécution restée QUEUED ou RUNNING sur disque sans être en mémoire a
 * été interrompue par l'arrêt du serveur : ERROR, dit tel quel.
 */
export async function listTestRuns(
  recordingDir: string,
  live: (id: string) => TestRun | undefined,
): Promise<TestRunView[]> {
  const root = path.join(recordingDir, TEST_RUNS_DIR);
  const names = (await readdir(root).catch(() => [] as string[]))
    .filter((name) => TEST_RUN_ID.test(name))
    .sort()
    .reverse()
    .slice(0, MAX_RUNS_LISTED);
  const views = await Promise.all(names.map(async (name) => readTestRun(recordingDir, name, live)));
  return views.filter((view): view is TestRunView => view !== undefined);
}

export async function readTestRun(
  recordingDir: string,
  id: string,
  live: (id: string) => TestRun | undefined,
): Promise<TestRunView | undefined> {
  if (!TEST_RUN_ID.test(id)) return undefined;
  const current = live(id);
  if (current) return current.view();
  const text = await readFile(path.join(recordingDir, TEST_RUNS_DIR, id, RUN_FILE), 'utf8').catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  try {
    const view = JSON.parse(text) as TestRunView;
    if (view.status === 'QUEUED' || view.status === 'RUNNING')
      return { ...view, status: 'ERROR', message: 'interrupted: the server stopped during the run' };
    return view;
  } catch {
    return undefined;
  }
}

// ── JUnit XML ─────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  if (!match) return undefined;
  return decode(match[2] ?? match[3] ?? '');
}

/**
 * Les cas d'un rapport JUnit XML (Playwright Test, Surefire) : un `<testcase>` par test ; un enfant
 * `<failure>` ou `<error>` le dit en échec, `<skipped>` sauté ; sinon réussi. Le message vient de
 * l'attribut `message` (ou du texte de l'élément), masqué et tronqué.
 */
export function junitCases(xml: string): TestCaseView[] {
  const cases: TestCaseView[] = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const head = match[1] ?? '';
    const body = match[3] ?? '';
    const name = attribute(head, 'name') ?? 'test';
    const classname = attribute(head, 'classname');
    const time = Number(attribute(head, 'time'));
    const problem = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b([^>]*?)(\/>|>([\s\S]*?)<\/skipped>)/.exec(body);
    const detail = problem
      ? errorOf(attribute(problem[2] ?? '', 'message'), decode(stripCdata(problem[4] ?? '')))
      : skipped
        ? (attribute(skipped[1] ?? '', 'message') ?? decode(stripCdata(skipped[3] ?? '')))
        : undefined;
    const message = detail?.trim() ? shortMessage(detail) : undefined;
    cases.push({
      name: redactText(classname && javaClass(classname) ? `${shortClass(classname)} › ${name}` : name),
      status: problem ? 'FAILED' : skipped ? 'SKIPPED' : 'PASSED',
      ...(Number.isFinite(time) ? { durationMs: Math.round(time * 1000) } : {}),
      ...(message ? { message } : {}),
    });
  }
  return cases;
}

/**
 * Le message d'un échec : la ligne d'erreur du texte quand il en a une (Playwright Test ne met que
 * l'emplacement du test dans l'attribut `message`), sinon l'attribut, sinon le texte.
 */
function errorOf(attributeMessage: string | undefined, text: string): string {
  const line = text
    .replace(ANSI, '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /^[\w.$]*(Error|Exception)\b/.test(entry));
  return line ?? attributeMessage ?? text;
}

const stripCdata = (text: string): string => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const shortClass = (classname: string): string => classname.split('.').pop() ?? classname;
/** Une classe Java (Surefire) nomme le cas ; un fichier (Playwright Test : `x.spec.ts`) non. */
const javaClass = (classname: string): boolean =>
  /^[\w$]+(\.[\w$]+)*$/.test(classname) && /^[A-Z]/.test(shortClass(classname));

// ── Les outils externes ───────────────────────────────────────────────────────────────────────

export interface ProcessResult {
  code: number | null;
  /** L'outil n'a pas pu démarrer (absent du PATH). */
  missing: boolean;
  timedOut: boolean;
}

/** Lance un outil ; sa sortie part dans `log` ; le signal (ou le délai) l'arrête. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    log: (text: string) => void;
    timeoutMs?: number;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', stop);
      resolve(result);
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === 'win32' && !command.includes(path.sep),
    });
    const stop = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      options.log(
        `\n[qa-crawler] time limit reached (${String(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)} ms)\n`,
      );
      stop();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
    if (options.signal.aborted) stop();
    options.signal.addEventListener('abort', stop);
    child.stdout.on('data', (chunk: Buffer) => {
      options.log(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      options.log(chunk.toString());
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      options.log(`${error.message}\n`);
      finish({ code: null, missing: error.code === 'ENOENT', timedOut });
    });
    child.on('close', (code) => {
      finish({ code, missing: false, timedOut });
    });
  });
}

/** Playwright Test installé à côté de QA-CRAWLER : son CLI et sa version, ou la raison de son absence. */
export async function playwrightTestTool(): Promise<
  { cli: string; version: string; nodeModules: string } | { reason: string }
> {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('@playwright/test/package.json');
    const directory = path.dirname(manifest);
    const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version?: string };
    return {
      cli: path.join(directory, 'cli.js'),
      version: version ?? 'unknown',
      // node_modules/@playwright/test → node_modules
      nodeModules: path.dirname(path.dirname(directory)),
    };
  } catch {
    return {
      reason: 'Playwright Test (@playwright/test) is not installed next to QA-CRAWLER on this server',
    };
  }
}

let mavenProbe: Promise<{ version: string } | { reason: string }> | undefined;

/** Maven sur le serveur (`mvn -v`, une fois) : sa version, ou la raison de son absence. */
export function mavenTool(env: NodeJS.ProcessEnv): Promise<{ version: string } | { reason: string }> {
  mavenProbe ??= (async () => {
    let output = '';
    const result = await runProcess('mvn', ['-v'], {
      cwd: process.cwd(),
      env,
      signal: new AbortController().signal,
      log: (text) => {
        output += text;
      },
      timeoutMs: 60_000,
    });
    if (result.missing || result.code !== 0) return { reason: 'Maven (mvn) is not available on this server' };
    return { version: /Apache Maven ([^\s]+)/.exec(output)?.[1] ?? 'unknown' };
  })();
  return mavenProbe;
}

/** Les outils des formats externes, vus par ce serveur. */
export async function externalRunners(env: NodeJS.ProcessEnv): Promise<TestRunnerView[]> {
  const [playwright, maven] = await Promise.all([playwrightTestTool(), mavenTool(env)]);
  return [
    'reason' in playwright
      ? {
          format: 'playwright',
          kind: 'EXTERNAL',
          tool: 'Playwright Test',
          available: false,
          reason: playwright.reason,
        }
      : {
          format: 'playwright',
          kind: 'EXTERNAL',
          tool: `Playwright Test ${playwright.version}`,
          available: true,
        },
    'reason' in maven
      ? { format: 'java', kind: 'EXTERNAL', tool: 'Apache Maven', available: false, reason: maven.reason }
      : { format: 'java', kind: 'EXTERNAL', tool: `Apache Maven ${maven.version}`, available: true },
  ];
}

/** Copie un dossier de tests générés, sans ce qu'un outil y a produit (dépendances, résultats). */
export async function copyGenerated(from: string, to: string): Promise<void> {
  const skip = new Set(['node_modules', 'test-results', 'playwright-report', 'target']);
  await cp(from, to, {
    recursive: true,
    filter: (source) => !skip.has(path.basename(source)),
  });
}

/**
 * Playwright Test sur la copie du dossier `playwright/` : le test importe `@playwright/test`, résolu
 * par un lien vers le node_modules de QA-CRAWLER (comme un projet de l'équipe qui l'aurait installé).
 */
export async function runPlaywrightTests(
  directory: string,
  context: { signal: AbortSignal; log: (text: string) => void; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<TestRunOutcome> {
  const tool = await playwrightTestTool();
  if ('reason' in tool) return { status: 'UNAVAILABLE', cases: [], message: tool.reason };
  const cwd = path.join(directory, 'playwright');
  await symlink(
    tool.nodeModules,
    path.join(cwd, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await runProcess(process.execPath, [tool.cli, 'test', '--config', 'playwright.config.ts'], {
    cwd,
    env: { ...context.env, CI: '1', FORCE_COLOR: '0' },
    signal: context.signal,
    log: context.log,
    ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
  });
  const xml = await readFile(path.join(cwd, 'test-results', 'junit.xml'), 'utf8').catch(() => undefined);
  return outcomeOf(result, xml === undefined ? [] : junitCases(xml), context.signal, 'Playwright Test');
}

/** `mvn -q -B test` sur la copie du projet Java ; QA_BASE_URL vise l'application. */
export async function runMavenTests(
  directory: string,
  context: {
    signal: AbortSignal;
    log: (text: string) => void;
    env: NodeJS.ProcessEnv;
    baseUrl: string;
    timeoutMs?: number;
  },
): Promise<TestRunOutcome> {
  const tool = await mavenTool(context.env);
  if ('reason' in tool) return { status: 'UNAVAILABLE', cases: [], message: tool.reason };
  const cwd = path.join(directory, 'java');
  const result = await runProcess('mvn', ['-q', '-B', 'test'], {
    cwd,
    env: { ...context.env, QA_BASE_URL: context.baseUrl, QA_HEADLESS: 'true' },
    signal: context.signal,
    log: context.log,
    ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
  });
  if (result.missing)
    return { status: 'UNAVAILABLE', cases: [], message: 'Maven (mvn) is not available on this server' };
  const reports = path.join(cwd, 'target', 'surefire-reports');
  const files = (await readdir(reports).catch(() => [] as string[])).filter(
    (name) => name.startsWith('TEST-') && name.endsWith('.xml'),
  );
  const cases = (
    await Promise.all(
      files.sort().map(async (name) => junitCases(await readFile(path.join(reports, name), 'utf8'))),
    )
  ).flat();
  return outcomeOf(result, cases, context.signal, 'Maven');
}

function outcomeOf(
  result: ProcessResult,
  cases: TestCaseView[],
  signal: AbortSignal,
  tool: string,
): TestRunOutcome {
  if (signal.aborted) return { status: 'CANCELLED', cases, message: 'cancelled' };
  if (result.missing) return { status: 'UNAVAILABLE', cases: [], message: `${tool} could not be started` };
  if (result.timedOut) return { status: 'ERROR', cases, message: `${tool} exceeded its time limit` };
  const verdict = verdictOf(cases);
  if (verdict === 'ERROR')
    return {
      status: 'ERROR',
      cases,
      message: `${tool} reported no test result (exit code ${String(result.code)})`,
    };
  // Une sortie en erreur sans aucun cas en échec : l'outil a échoué ailleurs (compilation, configuration).
  if (verdict === 'PASSED' && result.code !== 0)
    return { status: 'ERROR', cases, message: `${tool} exited with code ${String(result.code)}` };
  return { status: verdict, cases };
}

/** Le dossier d'une nouvelle exécution sous l'enregistrement. */
export function runDirectory(recordingDir: string, id = newRunId()): string {
  return path.join(recordingDir, TEST_RUNS_DIR, id);
}
