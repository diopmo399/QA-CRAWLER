import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildStaticGraph, type GraphBuildOptions } from './graph-builder.js';
import type { StaticApplicationGraph } from './model.js';
import type { SourceSet } from './source-set.js';
import { loadTypeScript } from './typescript-loader.js';

export type GraphRunResult =
  { graph: StaticApplicationGraph; thread: 'worker' | 'main' } | { unavailable: string } | { error: string };

type WorkerMessage = { graph: StaticApplicationGraph } | { unavailable: string } | { error: string };

/**
 * Construit le graphe statique dans un worker thread : le fil principal reste libre
 * pour Playwright (réponse aux fenêtres de connexion, popups, renouvellement de
 * session) pendant toute l'analyse. Si un worker ne peut pas démarrer (environnement
 * qui ne charge pas le fichier), le calcul se fait sur le fil principal, comme avant.
 */
export async function buildGraphOffThread(
  sources: SourceSet,
  options: GraphBuildOptions,
  settings: { worker?: boolean } = {},
): Promise<GraphRunResult> {
  const { now: _now, ...serializable } = options;
  // Une horloge injectée (tests, budgets) ne traverse pas un worker : calcul sur le fil principal.
  if (settings.worker !== false && !options.now) {
    const result = await inWorker(sources, serializable).catch(() => undefined);
    if (result) return 'graph' in result ? { graph: result.graph, thread: 'worker' } : result;
  }
  const ts = await loadTypeScript();
  if (!ts) return { unavailable: 'the TypeScript parser is not installed' };
  try {
    return { graph: buildStaticGraph(ts, sources, options), thread: 'main' };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function inWorker(sources: SourceSet, options: Omit<GraphBuildOptions, 'now'>): Promise<WorkerMessage> {
  const typescriptSources = import.meta.url.endsWith('.ts');
  const file = new URL(`./graph-worker.${typescriptSources ? 'ts' : 'js'}`, import.meta.url);
  // Exécuté depuis les sources (.ts, via tsx ou vitest) : le worker enregistre le chargeur de tsx, puis charge son fichier.
  const worker = typescriptSources
    ? new Worker(
        `(async () => { const api = await import(${JSON.stringify(tsxEsmApi())}); api.register(); await import(${JSON.stringify(file.href)}); })();`,
        { eval: true, workerData: { sources, options } },
      )
    : new Worker(file, { workerData: { sources, options } });
  return new Promise((resolve, reject) => {
    let settled = false;
    worker.once('message', (message: WorkerMessage) => {
      settled = true;
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', (error) => {
      if (!settled) reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`static analysis worker exited (${String(code)})`));
    });
  });
}

/** Le point d'entrée ESM de l'API de tsx (son export « import »), pour le worker lancé depuis les sources. */
function tsxEsmApi(): string {
  const manifest = createRequire(import.meta.url).resolve('tsx/package.json');
  return pathToFileURL(path.join(path.dirname(manifest), 'dist', 'esm', 'api', 'index.mjs')).href;
}
