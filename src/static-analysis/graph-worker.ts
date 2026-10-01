import { parentPort, workerData } from 'node:worker_threads';
import { buildStaticGraph, type GraphBuildOptions } from './graph-builder.js';
import type { SourceSet } from './source-set.js';
import { loadTypeScript } from './typescript-loader.js';

/**
 * Le calcul du graphe statique, hors du fil principal : l'analyse d'un gros bundle
 * (plusieurs Mo, des millions de nœuds d'AST) est synchrone et ne doit jamais empêcher
 * le navigateur d'être servi pendant ce temps (connexion SSO, popups, dialogues).
 */
const input = workerData as { sources: SourceSet; options: Omit<GraphBuildOptions, 'now'> };
const ts = await loadTypeScript();
if (!ts) parentPort?.postMessage({ unavailable: 'the TypeScript parser is not installed' });
else {
  try {
    parentPort?.postMessage({ graph: buildStaticGraph(ts, input.sources, input.options) });
  } catch (error) {
    parentPort?.postMessage({ error: (error as Error).message });
  }
}
