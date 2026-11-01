import path from 'node:path';
import type { GuardedFiles } from '../../guarded-fs.js';
import { ScopeDeniedError } from '../../scope-policy.js';
import { maskSource } from '../../service.js';

/**
 * LA RECHERCHE TEXTUELLE BORNÉE dans le code du périmètre : les fichiers viennent de `GuardedFiles.list`
 * (chaque dossier passe par LIST_DIR), chaque lecture passe par `GuardedFiles.readText` (READ_FILE,
 * décomptée du budget de fichiers du périmètre), les lignes rendues sont masquées (`maskSource`), le nombre
 * de fichiers lus, d'occurrences et de lignes de contexte est plafonné. Aucun chemin n'est fabriqué : les
 * occurrences portent le chemin relatif à la racine de l'application.
 */
export interface SearchTarget {
  applicationId: string;
  /** Racine absolue du dépôt. */
  root: string;
  /** Dossiers inspectés, relatifs à la racine ; vide : la racine. */
  include?: string[];
}

export interface SearchCodeOptions {
  query: string;
  /** La requête est une expression régulière (sinon un texte littéral). */
  regex?: boolean;
  caseSensitive?: boolean;
  maxHits: number;
  contextLines: number;
  /** Fichiers lus au plus pour cette recherche (en plus du budget du périmètre). */
  maxFiles: number;
  extensions: string[];
  /** Longueur maximale d'une ligne rendue. */
  maxLineChars?: number;
  signal?: AbortSignal;
  /** Un fichier a été lu (il devient citable). */
  onFileRead?: (applicationId: string, file: string) => void;
}

export interface SearchHit {
  applicationId: string;
  /** Relatif à la racine du dépôt, séparateur « / ». */
  file: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface SearchCodeResult {
  hits: SearchHit[];
  filesListed: number;
  filesRead: number;
  filesDenied: number;
  /** La recherche est partielle (fichiers ou occurrences plafonnés). */
  truncated: boolean;
  reasons: string[];
}

export const MAX_QUERY_CHARS = 200;
export const MAX_SEARCH_HITS = 50;
export const MAX_CONTEXT_LINES = 5;
const DEFAULT_LINE_CHARS = 300;

/** Un motif aux quantificateurs imbriqués (« (a+)+ », « .*.* ») : refusé, le coût n'est pas borné. */
const NESTED_QUANTIFIER = /[*+}][*+{]|\([^)]*[*+][^)]*\)[*+{]/;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Le motif d'une requête ; undefined quand elle est vide, trop longue ou invalide. */
export function compilePattern(
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean } = {},
): RegExp | undefined {
  const text = query.trim();
  if (text === '' || text.length > MAX_QUERY_CHARS) return undefined;
  const flags = options.caseSensitive ? '' : 'i';
  if (!options.regex) return new RegExp(escapeRegex(text), flags);
  if (NESTED_QUANTIFIER.test(text)) return undefined;
  try {
    return new RegExp(text, flags);
  } catch {
    return undefined;
  }
}

/** Les dossiers à parcourir d'une cible (les dossiers inclus, sinon la racine). */
export function searchRoots(target: SearchTarget): string[] {
  const include = target.include ?? [];
  if (include.length === 0) return [path.resolve(target.root)];
  const roots: string[] = [];
  for (const dir of include) roots.push(path.resolve(target.root, dir));
  return roots;
}

const relativeOf = (root: string, file: string): string =>
  path.relative(path.resolve(root), file).split(path.sep).join('/');

const clip = (line: string, max: number): string => (line.length > max ? `${line.slice(0, max)}…` : line);

export async function searchCode(
  files: GuardedFiles,
  targets: readonly SearchTarget[],
  options: SearchCodeOptions,
): Promise<SearchCodeResult> {
  const result: SearchCodeResult = {
    hits: [],
    filesListed: 0,
    filesRead: 0,
    filesDenied: 0,
    truncated: false,
    reasons: [],
  };
  const pattern = compilePattern(options.query, options);
  if (!pattern) {
    result.reasons.push('Requête vide, trop longue ou motif refusé.');
    return result;
  }
  const maxHits = Math.max(1, Math.min(options.maxHits, MAX_SEARCH_HITS));
  const context = Math.max(0, Math.min(options.contextLines, MAX_CONTEXT_LINES));
  const maxLine = options.maxLineChars ?? DEFAULT_LINE_CHARS;
  const candidates: { applicationId: string; root: string; file: string }[] = [];

  for (const target of targets) {
    for (const root of searchRoots(target)) {
      if (options.signal?.aborted) break;
      const listed = await files.list(root, { extensions: options.extensions });
      result.filesListed += listed.length;
      for (const file of listed)
        candidates.push({ applicationId: target.applicationId, root: target.root, file });
    }
  }

  let stop = false;
  for (const candidate of candidates) {
    if (stop || options.signal?.aborted) break;
    if (result.filesRead >= options.maxFiles) {
      result.truncated = true;
      result.reasons.push(`Plafond de ${options.maxFiles} fichiers lus atteint : recherche partielle.`);
      break;
    }
    let text: string;
    try {
      text = await files.readText(candidate.file);
    } catch (error) {
      result.filesDenied += 1;
      if (error instanceof ScopeDeniedError && error.decision.rule.startsWith('limits.')) {
        result.truncated = true;
        result.reasons.push(error.decision.reason);
        break;
      }
      continue;
    }
    result.filesRead += 1;
    const relative = relativeOf(candidate.root, candidate.file);
    options.onFileRead?.(candidate.applicationId, relative);
    const lines = maskSource(relative, text).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      pattern.lastIndex = 0;
      if (!pattern.test(line)) continue;
      if (result.hits.length >= maxHits) {
        result.truncated = true;
        result.reasons.push(`Plafond de ${maxHits} occurrences atteint : recherche partielle.`);
        stop = true;
        break;
      }
      result.hits.push({
        applicationId: candidate.applicationId,
        file: relative,
        line: index + 1,
        text: clip(line, maxLine),
        before: lines.slice(Math.max(0, index - context), index).map((entry) => clip(entry, maxLine)),
        after: lines.slice(index + 1, index + 1 + context).map((entry) => clip(entry, maxLine)),
      });
    }
  }
  if (options.signal?.aborted) {
    result.truncated = true;
    result.reasons.push('Recherche interrompue (annulation).');
  }
  return result;
}
