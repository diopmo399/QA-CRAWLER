import { StaticAnalysisCache, type StaticAnalysisIdentity } from './cache.js';
import type { GraphBuildOptions, StaticAnalysisFeatures } from './graph-builder.js';
import { buildGraphOffThread } from './graph-runner.js';
import {
  STATIC_ANALYZER_VERSION,
  type StaticAnalysisMode,
  type StaticApplicationGraph,
  type StaticFramework,
} from './model.js';
import { collectSources, type SourceBudget, type SourceSet } from './source-set.js';
import type { SourceDiscoveryEvent } from './sources/model.js';

export type StaticAnalysisEvent =
  | 'STATIC_ANALYSIS_STARTED'
  | 'STATIC_ANALYSIS_COMPLETED'
  | 'STATIC_ANALYSIS_CACHE_HIT'
  | 'STATIC_ANALYSIS_CACHE_MISS'
  | 'STATIC_ANALYSIS_BUDGET_EXHAUSTED'
  | 'STATIC_ANALYSIS_UNAVAILABLE'
  | 'STATIC_ROUTE_DISCOVERED'
  | 'STATIC_FORM_DISCOVERED'
  | 'STATIC_FIELD_DISCOVERED'
  | 'STATIC_DATA_FLOW_DISCOVERED'
  | 'STATIC_HTTP_CALL_DISCOVERED'
  | 'SEMANTIC_EVIDENCE_ADDED'
  | 'SEMANTIC_EVIDENCE_CONFLICT'
  | 'STATIC_PATH_SUGGESTED'
  | 'STATIC_PATH_CONFIRMED'
  | 'STATIC_PATH_REJECTED'
  | SourceDiscoveryEvent;

export type StaticEventSink = (event: StaticAnalysisEvent, message: string) => void;

/**
 * Un analyseur par famille d'applications. Angular et JavaScript/TypeScript générique
 * aujourd'hui ; React et Vue pourront s'ajouter sans toucher au reste.
 */
export interface FrameworkStaticAnalyzer {
  readonly framework: StaticFramework;
  supports(framework: StaticFramework): boolean;
}

export const ANGULAR_STATIC_ANALYZER: FrameworkStaticAnalyzer = {
  framework: 'ANGULAR',
  supports: (framework) => framework === 'ANGULAR',
};
export const GENERIC_JS_STATIC_ANALYZER: FrameworkStaticAnalyzer = {
  framework: 'GENERIC',
  supports: (framework) => framework !== 'UNKNOWN',
};

export interface StaticAnalyzerOptions {
  applicationId: string;
  version?: string;
  commit?: string;
  features: StaticAnalysisFeatures;
  analyzers: { angular: boolean; genericJs: boolean };
  budgets: SourceBudget & { maxAstNodes: number };
  /** Dossier du cache ; absent : pas de cache. */
  cacheDirectory?: string;
  onEvent?: StaticEventSink;
  now?: () => number;
  /** Analyse dans un worker thread (défaut) ; false : sur le fil principal. */
  worker?: boolean;
}

export interface StaticAnalysisOutcome {
  graph: StaticApplicationGraph;
  cache: 'HIT' | 'MISS' | 'DISABLED';
}

/**
 * STATIC APPLICATION ANALYZER. Source → empreinte → cache (HIT : la connaissance
 * connue ; MISS : analyse, puis mise en cache). Jamais d'exécution du code analysé.
 * Tout échec rend une analyse UNAVAILABLE avec un avertissement : le crawler continue
 * avec le DOM, l'accessibilité, l'exécution et l'historique.
 */
export class StaticApplicationAnalyzer {
  private readonly cache: StaticAnalysisCache | undefined;

  constructor(private readonly options: StaticAnalyzerOptions) {
    this.cache = options.cacheDirectory ? new StaticAnalysisCache(options.cacheDirectory) : undefined;
  }

  /** SOURCE_MODE : le dépôt de l'application. */
  async analyzeSource(root: string): Promise<StaticAnalysisOutcome> {
    const emit = this.options.onEvent ?? (() => undefined);
    emit('STATIC_ANALYSIS_STARTED', `source analysis of ${this.options.applicationId}`);
    let sources: SourceSet;
    try {
      sources = await collectSources(root, this.options.budgets, this.options.now);
    } catch (error) {
      return {
        graph: this.unavailable('SOURCE', `sources not readable: ${(error as Error).message}`),
        cache: 'DISABLED',
      };
    }
    return this.analyzeSet(sources, 'SOURCE');
  }

  private baseIdentity(): Omit<StaticAnalysisIdentity, 'mode' | 'sourceHash'> {
    return {
      application: this.options.applicationId,
      ...(this.options.version ? { version: this.options.version } : {}),
      ...(this.options.commit ? { commit: this.options.commit } : {}),
      analyzerVersion: STATIC_ANALYZER_VERSION,
    };
  }

  /**
   * Le cache interrogé par une empreinte connue avant la lecture des sources (l'ensemble
   * des bundles déployés) : un déploiement déjà analysé ne télécharge aucune source map.
   */
  async cachedByAlias(alias: string): Promise<StaticAnalysisOutcome | undefined> {
    if (!this.cache) return undefined;
    const graph = await this.cache.getByAlias(this.baseIdentity(), alias);
    if (!graph) return undefined;
    (this.options.onEvent ?? (() => undefined))(
      'STATIC_ANALYSIS_CACHE_HIT',
      `static knowledge reused for this deployment (${String(graph.fields.length)} field(s))`,
    );
    return { graph, cache: 'HIT' };
  }

  /**
   * Un ensemble de sources déjà lu (workspace virtuel : source maps, bundles, dépôt).
   * alias : l'empreinte du déploiement, enregistrée pour cachedByAlias().
   */
  async analyzeSet(
    sources: SourceSet,
    mode: StaticAnalysisMode,
    options: { alias?: string } = {},
  ): Promise<StaticAnalysisOutcome> {
    const emit = this.options.onEvent ?? (() => undefined);
    const identity: StaticAnalysisIdentity = { ...this.baseIdentity(), mode, sourceHash: sources.hash };
    const remember = async (): Promise<void> => {
      if (this.cache && options.alias)
        await this.cache.putAlias(identity, options.alias).catch(() => undefined);
    };
    if (this.cache) {
      const cached = await this.cache.get(identity);
      if (cached) {
        emit(
          'STATIC_ANALYSIS_CACHE_HIT',
          `static knowledge reused (${String(cached.fields.length)} field(s))`,
        );
        await remember();
        return { graph: cached, cache: 'HIT' };
      }
      emit('STATIC_ANALYSIS_CACHE_MISS', `no static knowledge for this source hash: analysing`);
    }
    const buildOptions: GraphBuildOptions = {
      applicationId: this.options.applicationId,
      mode,
      ...(this.options.version ? { version: this.options.version } : {}),
      ...(this.options.commit ? { commit: this.options.commit } : {}),
      features: this.options.features,
      analyzers: this.options.analyzers,
      maxAstNodes: this.options.budgets.maxAstNodes,
      maxDurationMs: this.options.budgets.maxDurationMs,
      ...(this.options.now ? { now: this.options.now } : {}),
    };
    // Hors du fil principal : le navigateur reste servi pendant l'analyse (connexion, popups).
    const result = await buildGraphOffThread(sources, buildOptions, {
      ...(this.options.worker !== undefined ? { worker: this.options.worker } : {}),
    });
    if ('unavailable' in result) {
      emit('STATIC_ANALYSIS_UNAVAILABLE', result.unavailable);
      return { graph: this.unavailable(mode, result.unavailable, sources.hash), cache: 'DISABLED' };
    }
    if ('error' in result)
      return {
        graph: this.unavailable(mode, `analysis failed: ${result.error}`, sources.hash),
        cache: 'DISABLED',
      };
    const graph: StaticApplicationGraph = result.graph;
    if (graph.warnings.some((warning) => warning.startsWith('STATIC_ANALYSIS_BUDGET_EXHAUSTED')))
      emit('STATIC_ANALYSIS_BUDGET_EXHAUSTED', 'budget reached: partial static knowledge');
    for (const route of graph.routes.slice(0, 50)) emit('STATIC_ROUTE_DISCOVERED', route.path);
    for (const form of graph.forms)
      emit('STATIC_FORM_DISCOVERED', `${form.id} (${form.controls.join(', ')})`);
    for (const field of graph.fields.slice(0, 200)) emit('STATIC_FIELD_DISCOVERED', field.id);
    for (const call of graph.apiCalls.slice(0, 200))
      emit('STATIC_HTTP_CALL_DISCOVERED', `${call.method} ${call.route} (${call.id})`);
    for (const flow of graph.dataFlows.filter((entry) => entry.status === 'RESOLVED').slice(0, 200))
      emit('STATIC_DATA_FLOW_DISCOVERED', `${flow.field ?? ''} → ${flow.requestProperty ?? ''}`);
    emit(
      'STATIC_ANALYSIS_COMPLETED',
      `${graph.framework} ${graph.coverage}: ${String(graph.routes.length)} route(s), ${String(graph.fields.length)} field(s), ${String(graph.apiCalls.length)} API call(s) in ${String(graph.stats.durationMs)} ms (${result.thread === 'worker' ? 'worker thread' : 'main thread'})`,
    );
    if (this.cache && graph.coverage !== 'UNAVAILABLE') {
      await this.cache.put(identity, graph).catch(() => undefined);
      await remember();
    }
    return { graph, cache: this.cache ? 'MISS' : 'DISABLED' };
  }

  private unavailable(mode: StaticAnalysisMode, reason: string, sourceHash = ''): StaticApplicationGraph {
    return {
      applicationId: this.options.applicationId,
      sourceHash,
      analyzerVersion: STATIC_ANALYZER_VERSION,
      framework: 'UNKNOWN',
      mode,
      coverage: 'UNAVAILABLE',
      routes: [],
      components: [],
      forms: [],
      fields: [],
      apiCalls: [],
      dtos: [],
      navigation: [],
      dataFlows: [],
      warnings: [reason],
      stats: { files: 0, bytes: 0, durationMs: 0 },
      generatedAt: new Date().toISOString(),
    };
  }
}
