import path from 'node:path';
import { languageOf } from './model.js';

export type NormalizedSourcePath =
  | { status: 'OK'; path: string; original: string }
  /** Hors du code de l'application (dépendances, runtime du bundler, styles) : laissé de côté. */
  | { status: 'IGNORED'; reason: string; original: string }
  /** Chemin inutilisable ou hostile : jamais repris. */
  | { status: 'REJECTED'; reason: string; original: string };

const MAX_PATH_LENGTH = 400;

/** Code qui n'est pas celui de l'application. */
const IGNORED =
  /(^|\/)node_modules\/|^\(webpack\)|(^|\/)webpack\/(runtime|bootstrap)|^external |^ignored\||(^|\/)__vite|^\.?vite\//;

/**
 * SOURCE PATH NORMALIZER : un chemin de source map (webpack:///./src/…,
 * webpack://app/./src/…, ng:///…, file:///…, ../../src/…) devient un chemin relatif du
 * workspace virtuel (src/app/…). Le chemin est une donnée NON FIABLE :
 *
 * - les « .. » de tête sont bornés à la racine : un chemin ne sort jamais du workspace ;
 * - un chemin absolu de la machine de build est réduit à partir de « src/ » (ou à son
 *   seul nom), pour ne jamais exposer l'arborescence d'un poste ;
 * - octets nuls, caractères de contrôle et chemins démesurés sont rejetés ;
 * - sourceRoot, tout aussi peu fiable, suit les mêmes règles.
 */
export function normalizeSourcePath(source: string, sourceRoot?: string): NormalizedSourcePath {
  const original = displayablePath(source);
  if (source.length === 0 || source.length > MAX_PATH_LENGTH)
    return { status: 'REJECTED', reason: 'empty or oversized path', original };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(source) || (sourceRoot && /[\u0000-\u001f\u007f]/.test(sourceRoot)))
    return { status: 'REJECTED', reason: 'control characters in path', original };

  let candidate = source;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(candidate);
  const root = sourceRoot?.trim();
  if (root && !hasScheme && !candidate.startsWith('/'))
    candidate = `${root.replace(/\/+$/, '')}/${candidate}`;

  candidate = candidate.replace(/\\/g, '/').replace(/[?#].*$/, '');
  if (/^data:/i.test(candidate)) return { status: 'REJECTED', reason: 'data URI as a path', original };
  let absolute = false;
  if (/^webpack:\/\//i.test(candidate)) candidate = candidate.replace(/^webpack:\/\/[^/]*\//i, '');
  else if (/^ng:\/\//i.test(candidate)) candidate = candidate.replace(/^ng:\/\/\/?/i, '');
  else if (/^file:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^file:\/\/[^/]*/i, '');
    absolute = true;
  } else if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return { status: 'REJECTED', reason: 'unreadable URL', original };
    }
  } else if (hasScheme && !/^[a-z]:\//i.test(candidate))
    return { status: 'REJECTED', reason: 'unsupported scheme', original };
  if (/^[a-z]:\//i.test(candidate)) {
    candidate = candidate.slice(2);
    absolute = true;
  }
  if (candidate.startsWith('/') && !hasScheme) absolute = true;

  if (IGNORED.test(candidate)) return { status: 'IGNORED', reason: 'not application code', original };

  let normalized = path.posix.normalize(`/${candidate}`).replace(/^\/+/, '');
  // Le « / » ajouté en tête borne tous les « .. » : normalize ne remonte jamais au-dessus.
  if (absolute) {
    const marker = normalized.search(/(^|\/)src\//);
    normalized =
      marker >= 0 ? normalized.slice(marker).replace(/^\//, '') : (normalized.split('/').pop() ?? '');
  }
  if (!normalized || normalized === '.' || normalized.split('/').includes('..'))
    return { status: 'REJECTED', reason: 'path escapes the workspace', original };
  if (!languageOf(normalized)) return { status: 'IGNORED', reason: 'not a script or template', original };
  if (/\.(spec|test|stories)\.(ts|tsx|js|jsx)$|\.d\.ts$/.test(normalized))
    return { status: 'IGNORED', reason: 'test or declaration file', original };
  return { status: 'OK', path: normalized, original };
}

/** Un chemin tel qu'il peut apparaître dans un rapport : borné, sans caractère de contrôle. */
function displayablePath(source: string): string {
  // eslint-disable-next-line no-control-regex
  return source.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
}
