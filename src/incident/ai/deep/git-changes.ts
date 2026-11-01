import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { redactText } from '../../../security/redactor.js';
import type {
  InvestigationScope,
  PolicyOperation,
  ScopeApplication,
} from '../../../sdk/core/incident-contracts.js';
import { isSafeRelativePath } from '../../scope.js';
import { isSensitivePath } from '../../scope-policy.js';
import type { InvestigationTool, ToolContext, ToolResult } from '../agent.js';

/**
 * LES CHANGEMENTS GIT, EN LECTURE SEULE : le binaire `git` lancé sans interpréteur de commandes, avec des
 * arguments FIXES (journal, différences, statistiques, détail d'un commit), dans la racine du dépôt d'une
 * application du périmètre et nulle part ailleurs, un environnement minimal, un délai, une sortie bornée et
 * masquée. Jamais fetch, pull, checkout ni aucune écriture.
 *
 * Deux portes, toutes deux nécessaires : `scope.permissions.readSources` ET `scope.permissions.readGitHistory`
 * (faux par défaut) ; et `git` dans `scope.allowedCommands`. L'opération déclarée est un `COMMAND` que le
 * Scope Policy Engine juge aussi (commande permise, `cwd` dans un dépôt, arguments sans métacaractère) : le
 * registre la vérifie avant `read`, et `read` la revérifie lui-même avant de lancer quoi que ce soit.
 */

export const GIT_COMMANDS = ['log', 'diff-stat', 'diff', 'show'] as const;
export type GitCommand = (typeof GIT_COMMANDS)[number];

export const MAX_GIT_COMMITS = 50;
export const DEFAULT_GIT_COMMITS = 20;
export const MAX_GIT_PATHS = 20;
export const MAX_GIT_OUTPUT_CHARS = 12_000;
export const DEFAULT_GIT_TIMEOUT_MS = 15_000;
export const MAX_GIT_TIMEOUT_MS = 60_000;

/** Une référence Git sûre : jamais une option (« - » initial), jamais une plage « .. », caractères bornés. */
const GIT_REF = /^[A-Za-z0-9][\w./^~-]{0,119}$/;
/** Une date ISO (jour, ou jour et heure) pour `--since`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/;
const RECORD_SEPARATOR = '\u001f';

const safeRef = (value: string): boolean =>
  GIT_REF.test(value) && !value.includes('..') && !value.endsWith('.lock') && !value.includes('@{');
/** Un chemin de dépôt : relatif, sans « .. », sans magie de pathspec (« : ») ni option (« - »), non sensible. */
const safePath = (value: string): boolean =>
  isSafeRelativePath(value) &&
  !value.startsWith('-') &&
  !value.startsWith(':') &&
  !value.includes('\n') &&
  !isSensitivePath(value);

export const GitChangesInputSchema = z
  .object({
    command: z.enum(GIT_COMMANDS),
    /** L'application dont le dépôt est lu (obligatoire quand le périmètre en a plusieurs). */
    applicationId: z.string().min(1).max(64).optional(),
    /** Des chemins relatifs au dépôt qui restreignent la lecture. */
    paths: z
      .array(
        z
          .string()
          .min(1)
          .max(400)
          .refine(safePath, 'a repository path: relative, without "..", not sensitive'),
      )
      .max(MAX_GIT_PATHS)
      .optional(),
    /** `show` : le commit ; `diff`, `diff-stat` : la base (défaut HEAD~1). */
    ref: z.string().min(1).max(120).refine(safeRef, 'a git reference without options or ranges').optional(),
    /** `diff`, `diff-stat` : la cible (défaut HEAD). */
    to: z.string().min(1).max(120).refine(safeRef, 'a git reference without options or ranges').optional(),
    /** `log` : ne garder que les commits depuis cette date ISO. */
    since: z.string().regex(ISO_DATE, 'an ISO date (YYYY-MM-DD)').optional(),
    /** `log` : nombre de commits (1 à 50, défaut 20). */
    maxCommits: z.number().int().min(1).max(MAX_GIT_COMMITS).optional(),
  })
  .strict();
export type GitChangesInput = z.infer<typeof GitChangesInputSchema>;

export interface GitRefusal {
  error: string;
  rule: string;
}

/** Pourquoi le périmètre refuse toute lecture Git ; undefined quand les deux portes sont ouvertes. */
export function gitHistoryRefusal(scope: InvestigationScope): GitRefusal | undefined {
  if (!scope.permissions.readSources)
    return { rule: 'permissions.readSources', error: 'reading sources is not allowed by the scope' };
  if (scope.permissions.readGitHistory !== true)
    return {
      rule: 'permissions.readGitHistory',
      error: 'reading the Git history is not allowed by the scope (permissions.readGitHistory is false)',
    };
  if (!scope.allowedCommands.includes('git'))
    return { rule: 'allowedCommands.git', error: '"git" is not among the allowed commands of the scope' };
  return undefined;
}

/** L'application visée : la seule du périmètre, ou celle de `applicationId`. */
export function repositoryOf(
  scope: InvestigationScope,
  applicationId: string | undefined,
): ScopeApplication | GitRefusal {
  const apps = scope.applications;
  if (applicationId !== undefined) {
    const app = apps.find((entry) => entry.id === applicationId);
    return (
      app ?? { rule: 'application.unknown', error: `application "${applicationId}" is not in the scope` }
    );
  }
  if (apps.length === 1 && apps[0]) return apps[0];
  return {
    rule: 'application.required',
    error: `applicationId is required (${String(apps.length)} applications in the scope)`,
  };
}

/** Les arguments FIXES de chaque commande ; l'entrée (déjà validée) ne fournit que des valeurs sûres. */
export function gitArguments(input: GitChangesInput): string[] {
  const paths = input.paths?.length ? ['--', ...input.paths] : [];
  switch (input.command) {
    case 'log':
      return [
        '--no-pager',
        'log',
        '--no-color',
        '--no-decorate',
        `--format=%H${RECORD_SEPARATOR}%aI${RECORD_SEPARATOR}%an${RECORD_SEPARATOR}%s`,
        `--max-count=${String(input.maxCommits ?? DEFAULT_GIT_COMMITS)}`,
        ...(input.since ? [`--since=${input.since}`] : []),
        ...(input.ref ? [input.ref] : []),
        ...paths,
      ];
    case 'diff-stat':
      return [
        '--no-pager',
        'diff',
        '--no-color',
        '--numstat',
        input.ref ?? 'HEAD~1',
        input.to ?? 'HEAD',
        ...paths,
      ];
    case 'diff':
      return [
        '--no-pager',
        'diff',
        '--no-color',
        '--unified=3',
        '--no-ext-diff',
        input.ref ?? 'HEAD~1',
        input.to ?? 'HEAD',
        ...paths,
      ];
    case 'show':
      return [
        '--no-pager',
        'show',
        '--no-color',
        '--no-ext-diff',
        '--stat',
        '--patch',
        '--unified=3',
        '--format=commit %H%nauthor %an%ndate %aI%n%n    %s%n',
        input.ref ?? 'HEAD',
        ...paths,
      ];
  }
}

/** L'opération que le Scope Policy Engine juge : une commande `git`, dans la racine du dépôt. */
export function gitOperation(root: string, args: readonly string[]): PolicyOperation {
  return { kind: 'COMMAND', command: 'git', args: [...args], cwd: root };
}

/** Une ligne de configuration ou de code dont la clé ressemble à un secret : sa valeur est masquée. */
const SECRET_ASSIGNMENT =
  /^([+-]?\s*(?:export\s+)?["']?[\w.-]*(?:pass(?:word|wd)?|secret|token|api[-_.]?key|credential|private[-_.]?key|client[-_.]?secret)[\w.-]*["']?\s*[:=]\s*)(.+)$/i;

/** Masque la sortie de git : affectations de secrets (dans les différences aussi), puis le masquage commun. */
export function maskGitOutput(text: string): string {
  const lines = text.split('\n').map((line) => {
    const match = SECRET_ASSIGNMENT.exec(line);
    return match?.[1] !== undefined && !/^\$\{[^}]*\}$/.test(match[2]?.trim() ?? '')
      ? `${match[1]}[REDACTED]`
      : line;
  });
  return redactText(lines.join('\n'));
}

/** L'environnement minimal transmis à git : le PATH, rien d'autre de l'hôte ; aucune configuration de l'utilisateur. */
export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: 'echo',
    LC_ALL: 'C',
  };
  for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'])
    if (env[name] !== undefined) minimal[name] = env[name];
  return minimal;
}

export interface GitRunResult {
  code: number | null;
  /** Sortie masquée et bornée (début conservé : le haut d'une différence porte le sens). */
  output: string;
  timedOut: boolean;
  truncated: boolean;
  /** Le binaire est absent. */
  missing: boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

export interface GitRunnerDeps {
  /** Le lanceur (tests : un enregistreur) ; par défaut `child_process.spawn`, toujours `shell: false`. */
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Le binaire (défaut `git`, cherché dans le PATH). */
  binary?: string;
}

/** Lance `git <args>` dans `cwd` : jamais de shell, environnement minimal, délai, sortie bornée et masquée. */
export function runGit(
  request: { args: readonly string[]; cwd: string },
  options: { signal?: AbortSignal } = {},
  deps: GitRunnerDeps = {},
): Promise<GitRunResult> {
  const spawnFn: SpawnFn =
    deps.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
  const timeoutMs = Math.max(1, Math.min(deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, MAX_GIT_TIMEOUT_MS));
  const maxChars = Math.max(200, deps.maxOutputChars ?? MAX_GIT_OUTPUT_CHARS);
  const binary = deps.binary ?? 'git';
  return new Promise((resolve) => {
    let raw = '';
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    const finish = (code: number | null, missing: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      const masked = maskGitOutput(raw);
      const truncated = overflow || masked.length > maxChars;
      resolve({
        code,
        output: truncated
          ? `${masked.slice(0, maxChars)}\n[…output truncated at ${String(maxChars)} characters]`
          : masked,
        timedOut,
        truncated,
        missing,
      });
    };
    const stop = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();
    const collect = (chunk: Buffer | string): void => {
      if (raw.length >= maxChars * 2) {
        overflow = true;
        return;
      }
      raw += chunk.toString();
    };
    try {
      child = spawnFn(binary, request.args, {
        cwd: request.cwd,
        env: gitEnvironment(deps.env ?? process.env),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      raw = error instanceof Error ? error.message : String(error);
      clearTimeout(timer);
      finish(null, false);
      return;
    }
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error: NodeJS.ErrnoException) => {
      raw += `${error.message}\n`;
      finish(null, error.code === 'ENOENT');
    });
    child.on('close', (code) => {
      finish(code, false);
    });
  });
}

export interface GitCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

export interface GitFileStat {
  file: string;
  added: number | null;
  deleted: number | null;
}

/** Les commits d'une sortie `log` au format fixé. */
export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of output.split('\n')) {
    const [hash, date, author, ...subject] = line.split(RECORD_SEPARATOR);
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash) || date === undefined || author === undefined) continue;
    commits.push({ hash, date, author, subject: subject.join(RECORD_SEPARATOR).slice(0, 200) });
  }
  return commits;
}

/** Les fichiers d'une sortie `--numstat` (« - » pour un binaire). */
export function parseNumstat(output: string): GitFileStat[] {
  const files: GitFileStat[] = [];
  for (const line of output.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match?.[3]) continue;
    files.push({
      file: match[3],
      added: match[1] === '-' ? null : Number(match[1]),
      deleted: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return files;
}

const refused = (refusal: GitRefusal): ToolResult => ({
  ok: false,
  error: refusal.error,
  rule: refusal.rule,
});

/** L'outil `git_changes`, à injecter au registre (`createToolRegistry(ctx, allow, { extra: [gitChangesTool()] })`). */
export function gitChangesTool(deps: GitRunnerDeps = {}): InvestigationTool<GitChangesInput> {
  return {
    name: 'git_changes',
    description:
      'Read-only Git history of one application repository of the scope: "log" (recent commits, optionally since an ISO date and restricted to paths), "diff-stat" (files changed between two refs, default HEAD~1..HEAD), "diff" (the patch, bounded), "show" (one commit with its patch, bounded). Needs scope.permissions.readGitHistory and "git" among allowedCommands; never fetches, pulls or checks out.',
    input: GitChangesInputSchema,
    operations(args, ctx) {
      const app = repositoryOf(ctx.policy.scope, args.applicationId);
      if ('rule' in app) return [];
      return [gitOperation(app.repository.root, gitArguments(args))];
    },
    async read(args, ctx): Promise<ToolResult> {
      const scope = ctx.policy.scope;
      const gate = gitHistoryRefusal(scope);
      if (gate) return refused(gate);
      const app = repositoryOf(scope, args.applicationId);
      if ('rule' in app) return refused(app);
      const operation = gitOperation(app.repository.root, gitArguments(args));
      // Le registre a déjà jugé l'opération ; l'outil ne lance rien sans sa propre décision favorable.
      const decision = await ctx.policy.check(operation);
      if (!decision.allowed) return { ok: false, error: decision.reason, rule: decision.rule };
      const timeoutMs = Math.min(
        deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        Math.max(1, scope.limits.maxDurationMs),
      );
      const result = await runGit(
        { args: operation.kind === 'COMMAND' ? operation.args : [], cwd: path.resolve(app.repository.root) },
        { signal: ctx.signal },
        { ...deps, timeoutMs },
      );
      if (result.missing)
        return { ok: false, error: 'git is not installed on this server', rule: 'git.missing' };
      if (result.timedOut)
        return {
          ok: false,
          error: `git ${args.command} exceeded ${String(timeoutMs)} ms`,
          rule: 'git.timeout',
        };
      if (result.code !== 0)
        return {
          ok: false,
          error: `git ${args.command} failed (code ${String(result.code)}): ${result.output.trim().slice(0, 500)}`,
          rule: 'git.failed',
        };
      const base = {
        command: args.command,
        applicationId: app.id,
        repository: path.basename(app.repository.root),
      };
      switch (args.command) {
        case 'log': {
          const commits = parseGitLog(result.output);
          return { ok: true, data: { ...base, commits, count: commits.length }, truncated: result.truncated };
        }
        case 'diff-stat': {
          const files = parseNumstat(result.output);
          return {
            ok: true,
            data: { ...base, from: args.ref ?? 'HEAD~1', to: args.to ?? 'HEAD', files, count: files.length },
            truncated: result.truncated,
          };
        }
        case 'diff':
          return {
            ok: true,
            data: { ...base, from: args.ref ?? 'HEAD~1', to: args.to ?? 'HEAD', patch: result.output },
            truncated: result.truncated,
          };
        case 'show':
          return {
            ok: true,
            data: { ...base, ref: args.ref ?? 'HEAD', text: result.output },
            truncated: result.truncated,
          };
      }
    },
  };
}

export type { ToolContext as GitToolContext };
