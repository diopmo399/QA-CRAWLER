import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * LA LECTURE GARDÉE D'UNE SOURCE : seulement sous une racine autorisée (chemin réel, liens symboliques
 * résolus), jamais un fichier de secrets, dans des limites de nombre, de taille et de durée, et interrompue
 * dès qu'une annulation est demandée. Rien n'est exécuté ni importé : le texte est seulement lu.
 */
export interface ReadFile {
  /** Relatif à la racine de la source, séparateur « / ». */
  path: string;
  text: string;
  hash: string;
  bytes: number;
}

export interface ReadResult {
  root: string;
  files: ReadFile[];
  skipped: number;
  secretsExcluded: number;
  /** L'empreinte de l'ensemble lu (chemins + contenus). */
  hash: string;
  limits: string[];
}

export interface ReadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxDurationMs: number;
}

export const DEFAULT_LIMITS: ReadLimits = {
  // Une application Angular de 500 000 lignes compte près de 9 000 fichiers (gabarits et tests compris).
  maxFiles: 20_000,
  maxFileBytes: 512 * 1024,
  maxDurationMs: 60_000,
};

export class SourceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAccessError';
  }
}

/** Jamais parcourus : dépendances, sorties de build, caches, outils. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  'coverage',
  '.angular',
  '.git',
  '.idea',
  '.vscode',
  '.gradle',
  '.mvn',
  '.next',
  '.nuxt',
]);

/** Les fichiers de secrets : jamais lus, comptés. */
const SECRET_FILE =
  /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|crt|cer)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\..*)?|secrets?(\..*)?|.*-secrets?\.(ya?ml|json|properties))$/i;

/** Les fichiers utiles à la cartographie. */
const USEFUL =
  /\.(ts|tsx|js|jsx|vue|html|java|kt|cs|csproj|graphql|gql|sql|ya?ml|json|properties|xml|gradle|kts|conf)$/i;
const IGNORED_FILE =
  /\.(spec|test|stories|d)\.(ts|tsx|js|jsx)$|\.min\.js$|Test\.java$|Tests\.java$|IT\.java$/;
/** Les fichiers lock des dépendances : générés, souvent très gros, sans rien pour la cartographie. */
const LOCK_FILE = /^(package-lock|npm-shrinkwrap)\.json$|^pnpm-lock\.ya?ml$/;
/** Combien de fichiers trop gros sont nommés dans la note du scan. */
const NAMED_LARGE = 5;
/**
 * Les manifestes et la configuration (modules, dépendances, préfixes, proxys) : lus avant tout. Testé sur un
 * chemin du système : séparateur `/` ou `\` (Windows).
 */
const MANIFEST =
  /(^|[\\/])(pom\.xml|package\.json|angular\.json|tsconfig[\w.-]*\.json|[\w-]*\.gradle(\.kts)?|application[\w-]*\.(ya?ml|properties)|bootstrap[\w-]*\.(ya?ml|properties)|proxy[\w.-]*\.(json|js|conf))$/i;
/** Le code et les gabarits : lus avant les autres fichiers de données (traductions, exemples…). */
const CODE = /\.(ts|tsx|js|jsx|vue|html|java|kt|cs|graphql|gql|sql)$/i;
/** L'ordre de lecture sous une limite : manifestes, puis code, puis données ; puis le chemin (déterministe). */
const tierOf = (file: string): number => (MANIFEST.test(file) ? 0 : CODE.test(file) ? 1 : 2);

/** Un fichier qu'une lecture de la cartographie ne rend jamais (secret, ou sans intérêt pour elle). */
export const isReadableFile = (name: string): boolean =>
  !SECRET_FILE.test(path.basename(name)) && USEFUL.test(name);

/** Un chemin réel sous l'une des racines autorisées ; sinon un refus expliqué. */
export async function allowedPath(candidate: string, roots: readonly string[]): Promise<string> {
  if (roots.length === 0)
    throw new SourceAccessError('no allowed source root is configured on the server (allowedSourceRoots)');
  if (!path.isAbsolute(candidate))
    throw new SourceAccessError(`the source path must be absolute: ${candidate}`);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new SourceAccessError(`the source path does not exist or is not readable: ${candidate}`);
  }
  for (const root of roots) {
    const allowed = await realpath(root).catch(() => path.resolve(root));
    const relative = path.relative(allowed, real);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return real;
  }
  throw new SourceAccessError(`the source path is outside the allowed source roots: ${candidate}`);
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Lit les fichiers utiles d'une source (ou de ses sous-dossiers `include`). */
export async function readSource(
  root: string,
  include: readonly string[],
  limits: ReadLimits = DEFAULT_LIMITS,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<ReadResult> {
  const started = now();
  const candidates: string[] = [];
  let secretsExcluded = 0;
  const limitNotes = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    if (signal?.aborted) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      // Les liens symboliques ne sont jamais suivis : ils pourraient sortir de la racine autorisée.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(full);
      } else if (entry.isFile()) {
        if (SECRET_FILE.test(entry.name)) secretsExcluded++;
        else if (USEFUL.test(entry.name) && !IGNORED_FILE.test(entry.name) && !LOCK_FILE.test(entry.name))
          candidates.push(full);
      }
    }
  };
  const starts = include.length > 0 ? include.map((dir) => path.resolve(root, dir)) : [root];
  for (const start of starts) {
    const relative = path.relative(root, start);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      limitNotes.add(`include outside the source ignored: ${relative}`);
      continue;
    }
    await walk(start);
  }
  const files: ReadFile[] = [];
  let skipped = 0;
  const large: string[] = [];
  /** Les fichiers écartés par une limite (nombre, durée) : nommés dans la note, jamais perdus en silence. */
  const cut: string[] = [];
  // Sous une limite, ce qui structure l'analyse (manifestes, code) passe avant les données.
  const ordered = [...new Set(candidates)].sort(
    (a, b) => tierOf(a) - tierOf(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const file of ordered) {
    if (signal?.aborted) break;
    if (files.length >= limits.maxFiles) {
      skipped++;
      cut.push(path.relative(root, file).split(path.sep).join('/'));
      limitNotes.add(`file limit reached (${String(limits.maxFiles)})`);
      continue;
    }
    if (now() - started > limits.maxDurationMs) {
      skipped++;
      cut.push(path.relative(root, file).split(path.sep).join('/'));
      limitNotes.add(`duration limit reached (${String(limits.maxDurationMs)} ms)`);
      continue;
    }
    const info = await stat(file).catch(() => undefined);
    if (!info || info.size > limits.maxFileBytes) {
      skipped++;
      if (info) large.push(path.relative(root, file).split(path.sep).join('/'));
      continue;
    }
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) {
      skipped++;
      continue;
    }
    files.push({
      path: path.relative(root, file).split(path.sep).join('/'),
      text,
      hash: sha(text),
      bytes: info.size,
    });
  }
  if (cut.length > 0)
    limitNotes.add(
      `files not read because of a limit (${String(cut.length)}): ${cut.slice(0, NAMED_LARGE).join(', ')}${cut.length > NAMED_LARGE ? ', …' : ''}`,
    );
  // L'ordre rendu reste celui des chemins : l'empreinte d'un même ensemble ne dépend pas de la priorité.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (large.length > 0) {
    // La note nomme les premiers fichiers écartés, pour qu'on sache ce qui manque à l'analyse.
    const names = large.slice(0, NAMED_LARGE).join(', ') + (large.length > NAMED_LARGE ? ', …' : '');
    limitNotes.add(
      `files larger than ${String(limits.maxFileBytes)} bytes skipped (${String(large.length)}): ${names}`,
    );
  }
  return {
    root,
    files,
    skipped,
    secretsExcluded,
    hash: sha(files.map((file) => `${file.path}\0${file.hash}`).join('\n')),
    limits: [...limitNotes],
  };
}

/** Ce que le scan sait de Git pour un dossier : la révision, ou pourquoi elle manque. */
export interface GitInfo {
  revision?: string;
  status: 'RESOLVED' | 'UNDETERMINED' | 'NONE';
  /** Le dossier dans son dépôt, « / » comme séparateur ; vide : la racine du dépôt. */
  repoPath?: string;
  note?: string;
}

const HEX_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** La référence `ref` lue dans un dossier Git (référence libre, puis `packed-refs`). */
async function readRef(dirs: readonly string[], ref: string): Promise<string | undefined> {
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.split('/').includes('..')) return undefined;
  for (const dir of dirs) {
    const loose = (await readFile(path.join(dir, ref), 'utf8').catch(() => undefined))?.trim();
    if (loose && HEX_ID.test(loose)) return loose;
  }
  for (const dir of dirs) {
    const packed = await readFile(path.join(dir, 'packed-refs'), 'utf8').catch(() => undefined);
    const line = packed?.split('\n').find((entry) => entry.endsWith(` ${ref}`));
    const id = line?.split(' ')[0];
    if (id && HEX_ID.test(id)) return id;
  }
  return undefined;
}

/**
 * La révision Git (commit) d'un dossier, lue dans `.git` sans lancer git. La recherche remonte au plus
 * jusqu'à `stopAt` (la racine autorisée) : rien n'est lu au-dessus, et un fichier `.git` (worktree,
 * sous-module) qui renvoie hors de cette racine n'est pas suivi. Une révision illisible est dite
 * indéterminée, avec sa cause ; aucune n'est inventée.
 */
export async function gitInfo(directory: string, stopAt: string): Promise<GitInfo> {
  const top = await realpath(stopAt).catch(() => path.resolve(stopAt));
  // Les deux chemins sont comparés résolus (noms courts de Windows, liens du dossier temporaire).
  const start = await realpath(directory).catch(() => path.resolve(directory));
  let current = start;
  for (let depth = 0; depth < 12; depth++) {
    const marker = path.join(current, '.git');
    const info = await lstat(marker).catch(() => undefined);
    if (info) {
      const repoPath = path.relative(current, start).split(path.sep).join('/');
      const undetermined = (note: string): GitInfo => ({ status: 'UNDETERMINED', repoPath, note });
      let gitDir = marker;
      if (info.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(marker, 'utf8').catch(() => ''))?.[1]?.trim();
        if (!pointer) return undetermined('fichier .git illisible');
        const target = await realpath(path.resolve(current, pointer)).catch(() => undefined);
        if (!target) return undetermined('le fichier .git renvoie vers un dossier absent');
        if (!inside(top, target)) return undetermined('le fichier .git renvoie hors de la racine autorisée');
        gitDir = target;
      } else if (!info.isDirectory()) return undetermined('.git n’est ni un dossier ni un fichier');
      const common = (await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => undefined))?.trim();
      let commonDir = gitDir;
      if (common) {
        const target = await realpath(path.resolve(gitDir, common)).catch(() => undefined);
        if (!target || !inside(top, target))
          return undetermined('le dossier Git commun est absent ou hors de la racine autorisée');
        commonDir = target;
      }
      const head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => undefined))?.trim();
      if (!head) return undetermined('HEAD illisible');
      if (HEX_ID.test(head)) return { status: 'RESOLVED', revision: head, repoPath };
      const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
      if (!ref) return undetermined('HEAD de forme inconnue');
      const revision = await readRef([gitDir, commonDir], ref);
      return revision
        ? { status: 'RESOLVED', revision, repoPath }
        : undetermined(`la référence ${ref} n’a pas de commit (dépôt vide ou référence absente)`);
    }
    const parent = path.dirname(current);
    if (parent === current || !inside(top, parent)) break;
    current = parent;
  }
  return { status: 'NONE' };
}

/** La seule révision (compatibilité) : absente si illisible. */
export async function gitRevision(directory: string, stopAt: string): Promise<string | undefined> {
  return (await gitInfo(directory, stopAt)).revision;
}
