import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScenarioConfig } from '../../config/config.js';
import { writeFileAtomic } from '../../memory/atomic-write.js';
import { STATIC_ANALYZER_VERSION, type StaticApplicationGraph } from '../model.js';
import {
  StaticApplicationAnalyzer,
  type StaticAnalysisEvent,
  type StaticAnalyzerOptions,
} from '../static-analyzer.js';
import { fetchGitSources, gitSetDirectory, type GitSourceResult } from './git-source.js';

/**
 * PREPARED GIT SOURCE — récupérer et analyser le code UNE fois, hors du run.
 *
 * `qa-crawler sources <mission>` clone / met à jour les dépôts `staticAnalysis.source.git`, les analyse
 * et écrit la connaissance obtenue (le graphe statique : champs, formulaires, routes, règles) dans
 * `<dossier des clones>/<ensemble>.knowledge.json`. Le run la lit telle quelle : aucun appel git, aucune
 * lecture ni analyse du code — le temps de récupération et d'analyse n'est jamais payé pendant un test.
 * La connaissance n'est jamais reprise si elle vient d'une autre version de l'analyseur.
 */
export interface PreparedKnowledge {
  format: 1;
  analyzerVersion: string;
  application: string;
  preparedAt: string;
  durationMs: number;
  repositories: GitSourceResult['repositories'];
  graph: StaticApplicationGraph;
}

export type PreparedRead =
  | { status: 'READY'; knowledge: PreparedKnowledge; file: string }
  | { status: 'MISSING' | 'STALE'; reason: string; file: string };

/** Dossier des clones : `gitDirectory`, sinon `.qa-crawler/sources` à côté du dossier des rapports. */
export function gitDirectoryOf(config: ScenarioConfig): string {
  return (
    config.staticAnalysis.source.gitDirectory ??
    path.join(path.dirname(path.resolve(config.output.reportsDir)), '.qa-crawler', 'sources')
  );
}

export function preparedKnowledgeFile(config: ScenarioConfig): string {
  return `${gitSetDirectory(config.staticAnalysis.source.git, gitDirectoryOf(config))}.knowledge.json`;
}

/** Les options de l'analyseur pour une mission (partagées par le run et la commande). */
export function staticAnalyzerOptionsOf(
  config: ScenarioConfig,
  env: Record<string, string | undefined>,
  onEvent?: (event: StaticAnalysisEvent, message: string) => void,
): StaticAnalyzerOptions {
  const settings = config.staticAnalysis;
  const version = settings.version ?? env.QA_VERSION;
  const commit = settings.commit ?? env.QA_COMMIT;
  return {
    applicationId: config.mission.name,
    ...(version ? { version } : {}),
    ...(commit ? { commit } : {}),
    features: settings.features,
    analyzers: settings.analyzers,
    budgets: settings.budgets,
    ...(settings.cache.enabled
      ? {
          cacheDirectory:
            settings.cache.directory ??
            path.join(path.dirname(path.resolve(config.output.reportsDir)), 'knowledge', 'static'),
        }
      : {}),
    ...(onEvent ? { onEvent } : {}),
  };
}

export interface PrepareOutcome {
  fetch: GitSourceResult;
  /** Écrite seulement si au moins un dépôt est lisible et l'analyse a abouti. */
  knowledge?: PreparedKnowledge;
  file: string;
  /** Pourquoi rien n'a été écrit (la connaissance précédente est gardée). */
  reason?: string;
}

/** Récupère les dépôts, les analyse, écrit la connaissance préparée. */
export async function prepareGitSources(input: {
  config: ScenarioConfig;
  env: Record<string, string | undefined>;
  onEvent?: (event: StaticAnalysisEvent, message: string) => void;
  now?: () => number;
}): Promise<PrepareOutcome> {
  const { config } = input;
  const now = input.now ?? Date.now;
  const source = config.staticAnalysis.source;
  const file = preparedKnowledgeFile(config);
  const started = now();
  const fetch = await fetchGitSources({
    repositories: source.git,
    directory: gitDirectoryOf(config),
    env: input.env,
    timeoutMs: source.gitTimeoutMs,
  });
  if (!fetch.root) return { fetch, file, reason: 'no repository could be read' };
  const analyzer = new StaticApplicationAnalyzer(staticAnalyzerOptionsOf(config, input.env, input.onEvent));
  const { graph } = await analyzer.analyzeSource(fetch.root);
  if (graph.coverage === 'UNAVAILABLE')
    return {
      fetch,
      file,
      reason: `analysis unavailable: ${graph.warnings.join('; ') || 'no readable source'}`,
    };
  const knowledge: PreparedKnowledge = {
    format: 1,
    analyzerVersion: STATIC_ANALYZER_VERSION,
    application: config.mission.name,
    preparedAt: new Date(now()).toISOString(),
    durationMs: now() - started,
    repositories: fetch.repositories,
    graph,
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(knowledge)}\n`);
  return { fetch, knowledge, file };
}

/** La connaissance préparée pour cette mission, si elle existe et vient de cet analyseur. */
export async function readPreparedKnowledge(config: ScenarioConfig): Promise<PreparedRead> {
  const file = preparedKnowledgeFile(config);
  const text = await readFile(file, 'utf8').catch(() => undefined);
  const hint = 'run `qa-crawler sources <mission>` first';
  if (text === undefined)
    return { status: 'MISSING', file, reason: `the git source is not prepared: ${hint}` };
  try {
    // Un fichier sur disque : jamais cru sur parole (format, version de l'analyseur, graphe présent).
    const knowledge = JSON.parse(text) as Partial<PreparedKnowledge>;
    if (knowledge.format !== 1 || knowledge.analyzerVersion !== STATIC_ANALYZER_VERSION || !knowledge.graph)
      return {
        status: 'STALE',
        file,
        reason: `the git source was prepared by another analyzer version (${knowledge.analyzerVersion ?? 'unknown'}): ${hint}`,
      };
    return { status: 'READY', knowledge: knowledge as PreparedKnowledge, file };
  } catch {
    return { status: 'MISSING', file, reason: `the prepared git source is unreadable: ${hint}` };
  }
}

/** Une ligne lisible : dépôts, commits, âge. */
export function describePrepared(knowledge: PreparedKnowledge, now: number = Date.now()): string {
  const repositories = knowledge.repositories
    .filter((repo) => repo.status !== 'FAILED')
    .map((repo) => `${repo.url} (${repo.ref}) @ ${repo.commit ?? '?'}`)
    .join(', ');
  const hours = Math.max(0, Math.round((now - Date.parse(knowledge.preparedAt)) / 3_600_000));
  return `${repositories} — prepared ${hours === 0 ? 'less than an hour' : `${String(hours)} h`} ago`;
}
