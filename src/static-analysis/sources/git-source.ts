import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactText } from '../../security/redactor.js';

/**
 * GIT SOURCE — le code de l'application lu depuis son dépôt, pour l'analyse statique.
 *
 *  - LECTURE SEULE : clone léger (`--depth 1`, une seule branche, sans tags), mis à jour à chaque run
 *    (fetch + checkout forcé sur la révision distante) ; aucun commit, aucun push, aucun hook exécuté
 *    (`core.hooksPath` vide), aucun sous-module.
 *  - SECRETS : le jeton vient d'une variable d'environnement ; il passe par un en-tête HTTP de la
 *    commande (`http.extraHeader`), jamais dans l'URL, jamais écrit dans `.git/config`, jamais journalisé.
 *    Aucune invite interactive (GIT_TERMINAL_PROMPT=0) ; TLS jamais désactivé.
 *  - PLUSIEURS DÉPÔTS (micro-frontends : le shell + chaque application) : chacun dans son dossier,
 *    sous un dossier propre à cet ensemble de dépôts ; la racine analysée est ce dossier.
 *  - ÉCHEC : le run continue (l'analyse se rabat sur les source maps / bundles) ; la raison est notée.
 */
export interface GitRepository {
  url: string;
  ref?: string | undefined;
  path?: string | undefined;
  name?: string | undefined;
  tokenEnv?: string | undefined;
  usernameEnv?: string | undefined;
}

export interface GitSourceResult {
  /** La racine à analyser (un dépôt, son sous-dossier, ou le dossier qui les réunit). */
  root?: string;
  repositories: {
    name: string;
    url: string;
    ref: string;
    commit?: string;
    status: 'CLONED' | 'UPDATED' | 'FAILED';
    reason?: string;
  }[];
  notes: string[];
}

const SAFE_URL = /^(https:\/\/|ssh:\/\/|file:\/\/|git@[\w.-]+:)/i;

/** Une URL lisible dans un journal : sans identifiant ni paramètre. */
export function displayGitUrl(url: string): string {
  return redactText(url.replace(/(\/\/)[^/@\s]+@/, '$1').replace(/\?.*$/, ''));
}

function nameOf(repo: GitRepository): string {
  if (repo.name) return repo.name;
  const last =
    repo.url
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .at(-1) ?? 'repository';
  const clean = last.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'repository';
  const hash = createHash('sha256').update(repo.url).digest('hex').slice(0, 8);
  return `${clean}-${hash}`;
}

interface GitRun {
  stdout: string;
}

function git(args: string[], options: { cwd?: string; timeoutMs: number; header?: string }): Promise<GitRun> {
  const config = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'protocol.file.allow=always',
    '-c',
    'credential.helper=',
    ...(options.header ? ['-c', `http.extraHeader=${options.header}`] : []),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...config, ...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Le message de git, sans jeton ni identifiant (l'en-tête n'y figure jamais, l'URL est expurgée).
          // La ligne utile (fatal: / error:), pas la progression (« Cloning into… »).
          const lines = (stderr || error.message).split('\n').filter((line) => line.trim());
          const detail =
            lines.find((line) => /^(fatal|error):/i.test(line.trim())) ??
            (error.killed ? `git timed out after ${String(options.timeoutMs)} ms` : lines.at(-1)) ??
            'git failed';
          reject(new Error(redactText(detail.replace(/(\/\/)[^/@\s]+@/g, '$1')).slice(0, 300)));
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Un dossier par ENSEMBLE de dépôts (URL, ref, path) : la racine d'analyse ne contient que les dépôts
 * de cette mission ; la connaissance préparée de cet ensemble est à côté (`<dossier>.knowledge.json`).
 */
export function gitSetDirectory(repositories: GitRepository[], directory: string): string {
  const set = createHash('sha256')
    .update(repositories.map((repo) => `${repo.url}#${repo.ref ?? ''}#${repo.path ?? ''}`).join('\n'))
    .digest('hex')
    .slice(0, 12);
  return path.join(directory, set);
}

/** Clone (ou met à jour) chaque dépôt ; renvoie la racine à analyser. */
export async function fetchGitSources(input: {
  repositories: GitRepository[];
  directory: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  onEvent?: (message: string) => void;
}): Promise<GitSourceResult> {
  const result: GitSourceResult = { repositories: [], notes: [] };
  if (input.repositories.length === 0) return result;
  const directory = gitSetDirectory(input.repositories, input.directory);
  await mkdir(directory, { recursive: true });
  const roots: { name: string; root: string }[] = [];
  for (const repo of input.repositories) {
    const name = nameOf(repo);
    const url = displayGitUrl(repo.url);
    const ref = repo.ref ?? 'HEAD';
    const fail = (reason: string): void => {
      result.repositories.push({ name, url, ref, status: 'FAILED', reason });
      result.notes.push(`GIT_SOURCE_FAILED: ${url} (${ref}): ${reason}`);
      input.onEvent?.(`git source ${url} failed: ${reason}`);
    };
    if (!SAFE_URL.test(repo.url)) {
      fail('unsupported url (https://, ssh://, git@host:… or file://)');
      continue;
    }
    let header: string | undefined;
    if (repo.tokenEnv) {
      const token = input.env[repo.tokenEnv];
      if (!token) {
        fail(`environment variable ${repo.tokenEnv} is not set`);
        continue;
      }
      if (!/^https:\/\//i.test(repo.url)) {
        fail('a token is only sent over https://');
        continue;
      }
      const user = (repo.usernameEnv ? input.env[repo.usernameEnv] : undefined) ?? 'x-access-token';
      header = `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
    }
    const target = path.join(directory, name);
    const options = { timeoutMs: input.timeoutMs, ...(header ? { header } : {}) };
    try {
      let status: 'CLONED' | 'UPDATED';
      if (await exists(path.join(target, '.git'))) {
        // Mise à jour : la révision distante, telle quelle (les modifications locales sont écrasées).
        await git(['remote', 'set-url', 'origin', repo.url], { cwd: target, timeoutMs: input.timeoutMs });
        await git(['fetch', '--depth', '1', '--no-tags', 'origin', ...(repo.ref ? [repo.ref] : [])], {
          ...options,
          cwd: target,
        });
        await git(['checkout', '--force', '--detach', 'FETCH_HEAD'], {
          cwd: target,
          timeoutMs: input.timeoutMs,
        });
        status = 'UPDATED';
      } else {
        await rm(target, { recursive: true, force: true });
        await git(
          [
            'clone',
            '--depth',
            '1',
            '--single-branch',
            '--no-tags',
            '--no-recurse-submodules',
            ...(repo.ref ? ['--branch', repo.ref] : []),
            repo.url,
            target,
          ],
          options,
        );
        status = 'CLONED';
      }
      const commit = (
        await git(['rev-parse', 'HEAD'], { cwd: target, timeoutMs: input.timeoutMs })
      ).stdout.trim();
      const root = repo.path ? path.join(target, repo.path) : target;
      if (!path.resolve(root).startsWith(path.resolve(target)) || !(await exists(root))) {
        fail(`path "${repo.path ?? ''}" not found in the repository`);
        continue;
      }
      roots.push({ name, root });
      result.repositories.push({ name, url, ref, commit: commit.slice(0, 12), status });
      input.onEvent?.(
        `git source ${url} ${status === 'CLONED' ? 'cloned' : 'updated'} at ${commit.slice(0, 12)}`,
      );
    } catch (error) {
      fail((error as Error).message);
    }
  }
  // Un dépôt : sa racine (ou son sous-dossier) ; plusieurs : le dossier qui les réunit.
  if (roots.length === 1) result.root = roots[0]?.root;
  else if (roots.length > 1) {
    result.root = directory;
    if (input.repositories.some((repo) => repo.path))
      result.notes.push(
        'GIT_SOURCE_PATH_IGNORED: several repositories are analysed whole (path applies to one repository)',
      );
  }
  return result;
}
