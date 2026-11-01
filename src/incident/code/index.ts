import path from 'node:path';
import type { CodeIndex, InvestigationScope, ScopeApplication } from '../model.js';
import type { GuardedFiles } from './files.js';
import { analyzeFrontendSource } from './frontend.js';
import { analyzeJavaSource } from './java.js';
import { matchEndpoint, normalizePath } from './paths.js';
import { readSpringProperties } from './properties.js';
import { resolveCalls } from './resolve.js';

/**
 * CODE INVESTIGATION ENGINE : l'index du code des applications du périmètre (frontend, BFF,
 * backend). Chaque fichier est listé et lu par `GuardedFiles` — donc par le Scope Policy Engine :
 * un refus est consigné (`denied`), une limite atteinte aussi (`truncated`), jamais contournée.
 * L'index décrit le code LU : aucune relation n'y est OBSERVED.
 */

export { analyzeFrontendSource } from './frontend.js';
export { analyzeJavaSource } from './java.js';
export { readSpringProperties, resolvePlaceholders } from './properties.js';
export { resolveCalls } from './resolve.js';
export { matchEndpoint, normalizePath } from './paths.js';
export type { GuardedFiles } from './files.js';

const FRONTEND_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue'];
const JAVA_EXTENSIONS = ['.java', '.yml', '.yaml', '.properties'];
const SPRING_CONFIG = /^application(-[\w.-]+)?\.(ya?ml|properties)$/i;

export async function analyzeCode(
  scope: InvestigationScope,
  files: GuardedFiles,
  options: { endpoints?: string[] } = {},
): Promise<CodeIndex> {
  const index: CodeIndex = {
    applications: [],
    symbols: [],
    endpoints: [],
    outgoing: [],
    calls: [],
    denied: [],
    truncated: [],
  };
  const localDenied: { path: string; reason: string }[] = [];
  for (const app of scope.applications) {
    const summary = { id: app.id, layer: app.layer, files: 0, skipped: 0 };
    index.applications.push(summary);
    const listed = await listFiles(app, files, localDenied);
    const read = async (absolute: string): Promise<string | undefined> => {
      try {
        return await files.readText(absolute);
      } catch (error) {
        summary.skipped++;
        const decision = (error as { decision?: { reason?: string } } | undefined)?.decision;
        if (decision)
          localDenied.push({ path: absolute, reason: decision.reason ?? 'refusé par le périmètre' });
        else localDenied.push({ path: absolute, reason: `lecture impossible : ${errorMessage(error)}` });
        return undefined;
      }
    };
    const relative = (absolute: string): string =>
      path.relative(app.repository.root, absolute).split(path.sep).join('/');

    if (app.layer === 'FRONTEND') {
      for (const absolute of listed) {
        const text = await read(absolute);
        if (text === undefined) continue;
        summary.files++;
        const result = analyzeFrontendSource(app.id, relative(absolute), text);
        index.symbols.push(...result.symbols);
        index.outgoing.push(...result.outgoing);
        index.calls.push(...result.calls);
      }
      continue;
    }

    // BFF / backend : la configuration d'abord (base, puis profils en repli), puis les sources Java.
    const configs = listed
      .filter((f) => SPRING_CONFIG.test(path.basename(f)))
      .sort((a, b) => configRank(a) - configRank(b));
    const properties: Record<string, string> = {};
    for (const absolute of configs) {
      const text = await read(absolute);
      if (text === undefined) continue;
      summary.files++;
      for (const [key, value] of Object.entries(readSpringProperties(absolute, text))) {
        if (!(key in properties)) properties[key] = value;
      }
    }
    const classes = app.repository.classes ?? [];
    for (const absolute of listed.filter((f) => f.endsWith('.java'))) {
      if (classes.length > 0 && !matchesClass(relative(absolute), classes)) {
        summary.skipped++;
        continue;
      }
      const text = await read(absolute);
      if (text === undefined) continue;
      summary.files++;
      const result = analyzeJavaSource(app.id, app.layer, relative(absolute), text, properties);
      index.symbols.push(...result.symbols);
      index.endpoints.push(...result.endpoints);
      index.outgoing.push(...result.outgoing);
      index.calls.push(...result.calls);
    }
  }
  markRequestBodies(index);
  const resolved = resolveCalls(index);

  const targets = options.endpoints ?? scope.endpoints;
  for (const target of targets) {
    const match = /^([A-Za-z]+)\s+(\S+)$/.exec(target.trim());
    if (!match) continue;
    const endpoint = matchEndpoint(resolved, match[1] ?? '', match[2] ?? '');
    const symbol = endpoint ? resolved.symbols.find((s) => s.id === endpoint.symbolId) : undefined;
    if (symbol) symbol.detail = { ...(symbol.detail ?? {}), targeted: true };
    else if (!endpoint)
      resolved.truncated.push(
        `Endpoint ciblé introuvable dans le code lu : ${target} (${normalizePath(match[2] ?? '')}).`,
      );
  }

  resolved.denied = dedupe([...files.denied, ...localDenied]);
  resolved.truncated = [...new Set([...files.truncated, ...resolved.truncated])];
  return resolved;
}

async function listFiles(
  app: ScopeApplication,
  files: GuardedFiles,
  denied: { path: string; reason: string }[],
): Promise<string[]> {
  const extensions = app.layer === 'FRONTEND' ? FRONTEND_EXTENSIONS : JAVA_EXTENSIONS;
  const roots =
    app.repository.include.length > 0
      ? app.repository.include.map((dir) => path.resolve(app.repository.root, dir))
      : [app.repository.root];
  const all = new Set<string>();
  for (const root of roots) {
    try {
      for (const file of await files.list(root, { extensions })) all.add(file);
    } catch (error) {
      const decision = (error as { decision?: { reason?: string } } | undefined)?.decision;
      denied.push({ path: root, reason: decision?.reason ?? `liste impossible : ${errorMessage(error)}` });
    }
  }
  return [...all]
    .filter((f) => app.layer === 'FRONTEND' || f.endsWith('.java') || SPRING_CONFIG.test(path.basename(f)))
    .sort();
}

function configRank(file: string): number {
  const base = path.basename(file);
  const profile = /^application-/.test(base) ? 10 : 0;
  // src/main avant src/test : la configuration de test ne remplace pas celle de l'application.
  const test = /[\\/]src[\\/]test[\\/]/.test(file) ? 100 : 0;
  return profile + test + (/\.properties$/.test(base) ? 1 : 0);
}

/** Classes ciblées : nom simple (`BookService`) ou qualifié (`org.example.bff.books.BookService`). */
function matchesClass(file: string, classes: string[]): boolean {
  const stem = file.replace(/\.java$/, '');
  const simple = stem.split('/').pop() ?? stem;
  return classes.some((c) => {
    const name = c.trim().replace(/\.java$/, '');
    if (!name.includes('.')) return name === simple;
    return stem.endsWith(name.split('.').join('/'));
  });
}

/** Un type reçu en `@RequestBody` est un DTO, même sans nom ni annotation qui le disent. */
function markRequestBodies(index: CodeIndex): void {
  const bodies = new Map<string, Set<string>>();
  for (const symbol of index.symbols) {
    const body = symbol.detail?.requestBody;
    if (symbol.kind === 'ENDPOINT' && typeof body === 'string') {
      const set = bodies.get(symbol.applicationId) ?? new Set<string>();
      set.add(body);
      bodies.set(symbol.applicationId, set);
    }
  }
  for (const symbol of index.symbols) {
    const simple = symbol.name.split('.').pop() ?? symbol.name;
    if (
      symbol.kind === 'FUNCTION' &&
      symbol.detail?.declaration &&
      bodies.get(symbol.applicationId)?.has(simple)
    ) {
      symbol.kind = 'DTO';
    }
    if (symbol.kind === 'DTO' && bodies.get(symbol.applicationId)?.has(simple)) {
      symbol.detail = { ...(symbol.detail ?? {}), requestBody: true };
    }
  }
}

/** Un refus par chemin : celui de GuardedFiles (avec sa règle) l'emporte sur la trace locale. */
function dedupe(list: { path: string; reason: string }[]): { path: string; reason: string }[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    if (seen.has(d.path)) return false;
    seen.add(d.path);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
