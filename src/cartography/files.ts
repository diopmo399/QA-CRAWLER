import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
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
  maxFiles: 4_000,
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
  /\.(ts|tsx|js|jsx|vue|html|java|kt|cs|csproj|graphql|gql|sql|ya?ml|json|properties|xml|gradle|kts)$/i;
const IGNORED_FILE =
  /\.(spec|test|stories|d)\.(ts|tsx|js|jsx)$|\.min\.js$|Test\.java$|Tests\.java$|IT\.java$/;

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
        else if (USEFUL.test(entry.name) && !IGNORED_FILE.test(entry.name)) candidates.push(full);
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
  for (const file of [...new Set(candidates)].sort()) {
    if (signal?.aborted) break;
    if (files.length >= limits.maxFiles) {
      skipped++;
      limitNotes.add(`file limit reached (${String(limits.maxFiles)})`);
      continue;
    }
    if (now() - started > limits.maxDurationMs) {
      skipped++;
      limitNotes.add(`duration limit reached (${String(limits.maxDurationMs)} ms)`);
      continue;
    }
    const info = await stat(file).catch(() => undefined);
    if (!info || info.size > limits.maxFileBytes) {
      skipped++;
      if (info) limitNotes.add(`files larger than ${String(limits.maxFileBytes)} bytes skipped`);
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
  return {
    root,
    files,
    skipped,
    secretsExcluded,
    hash: sha(files.map((file) => `${file.path}\0${file.hash}`).join('\n')),
    limits: [...limitNotes],
  };
}

/**
 * La révision Git (commit) d'un dossier, lue dans `.git` sans lancer git ; absente si illisible. La recherche
 * remonte au plus jusqu'à `stopAt` (la racine autorisée) : rien n'est lu au-dessus.
 */
export async function gitRevision(directory: string, stopAt: string): Promise<string | undefined> {
  let current = directory;
  for (let depth = 0; depth < 8; depth++) {
    const git = path.join(current, '.git');
    const head = await readFile(path.join(git, 'HEAD'), 'utf8').catch(() => undefined);
    if (head !== undefined) {
      const text = head.trim();
      if (/^[0-9a-f]{40}$/.test(text)) return text;
      const ref = /^ref:\s*(\S+)$/.exec(text)?.[1];
      if (!ref) return undefined;
      const loose = await readFile(path.join(git, ref), 'utf8').catch(() => undefined);
      if (loose && /^[0-9a-f]{40}/.test(loose.trim())) return loose.trim().slice(0, 40);
      const packed = await readFile(path.join(git, 'packed-refs'), 'utf8').catch(() => undefined);
      const line = packed?.split('\n').find((entry) => entry.endsWith(` ${ref}`));
      return line ? line.slice(0, 40) : undefined;
    }
    const parent = path.dirname(current);
    if (parent === current || current === stopAt || path.relative(stopAt, parent).startsWith('..'))
      return undefined;
    current = parent;
  }
  return undefined;
}
