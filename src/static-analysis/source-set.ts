import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { StaticSourceProvenance } from './sources/model.js';

/** Un fichier lu pour l'analyse (jamais exécuté). */
export interface SourceFile {
  /** Chemin relatif à la racine, séparateurs « / ». */
  path: string;
  text: string;
  hash: string;
  bytes: number;
}

export interface SourceSet {
  root: string;
  files: SourceFile[];
  /** Empreinte de l'ensemble : chemins + contenus. Change dès qu'un fichier change. */
  hash: string;
  bytes: number;
  /** Fichiers laissés de côté (budget, taille) : l'analyse est alors PARTIAL. */
  skipped: string[];
  budgetExhausted: boolean;
  /** Limites de la lecture (source map partielle ou rejetée, conflit…) : l'analyse est PARTIAL. */
  notes?: string[];
  /** D'où vient chaque fichier (dépôt, source map, bundle), sans contenu. */
  provenance?: StaticSourceProvenance[];
}

export interface SourceBudget {
  maxFiles: number;
  maxFileSizeBytes: number;
  maxDurationMs: number;
}

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html']);
/** Jamais lus : dépendances, sorties de build, tests, caches. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.angular',
  '.git',
  '.next',
  '.nuxt',
  'e2e',
  'cypress',
  'playwright',
  '__tests__',
]);
const IGNORED_FILES = /\.(spec|test|stories|d)\.(ts|tsx|js|jsx)$|\.min\.js$/;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Lit les sources d'un dépôt dans la limite d'un budget : les fichiers les plus petits
 * d'abord ne sont pas privilégiés — l'ordre est celui des chemins, pour que deux runs
 * sur le même code lisent les mêmes fichiers (empreinte stable).
 */
export async function collectSources(
  root: string,
  budget: SourceBudget,
  now: () => number = Date.now,
): Promise<SourceSet> {
  const started = now();
  const absoluteRoot = path.resolve(root);
  const candidates: string[] = [];
  const skipped: string[] = [];
  let budgetExhausted = false;

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(full);
      } else if (
        entry.isFile() &&
        (EXTENSIONS.has(path.extname(entry.name)) || entry.name === 'package.json') &&
        !IGNORED_FILES.test(entry.name)
      )
        candidates.push(full);
    }
  };
  await walk(absoluteRoot);

  const files: SourceFile[] = [];
  let bytes = 0;
  for (const file of candidates) {
    const relative = path.relative(absoluteRoot, file).split(path.sep).join('/');
    if (files.length >= budget.maxFiles || now() - started > budget.maxDurationMs) {
      budgetExhausted = true;
      skipped.push(relative);
      continue;
    }
    const info = await stat(file).catch(() => undefined);
    if (!info || info.size > budget.maxFileSizeBytes) {
      skipped.push(relative);
      continue;
    }
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    files.push({ path: relative, text, hash: sha256(text), bytes: info.size });
    bytes += info.size;
  }
  return {
    root: absoluteRoot,
    files,
    hash: setHash(files),
    bytes,
    skipped,
    budgetExhausted,
  };
}

/** Empreinte d'un ensemble de fichiers déjà en mémoire (mode bundle, tests). */
export function sourceSetOf(root: string, entries: { path: string; text: string }[]): SourceSet {
  const files = entries
    .map((entry) => ({
      path: entry.path,
      text: entry.text,
      hash: sha256(entry.text),
      bytes: entry.text.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    root,
    files,
    hash: setHash(files),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    skipped: [],
    budgetExhausted: false,
  };
}

function setHash(files: readonly SourceFile[]): string {
  return sha256(files.map((file) => `${file.path}\n${file.hash}`).join('\n'));
}
