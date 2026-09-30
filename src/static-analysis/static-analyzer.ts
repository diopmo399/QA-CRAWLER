import { StaticAnalysisCache, type StaticAnalysisIdentity } from './cache.js';
import { buildStaticGraph, type GraphBuildOptions, type StaticAnalysisFeatures } from './graph-builder.js';
import {
  STATIC_ANALYZER_VERSION,
  type StaticAnalysisMode,
  type StaticApplicationGraph,
  type StaticFramework,
} from './model.js';
import { collectSources, type SourceBudget, type SourceSet } from './source-set.js';
import { loadTypeScript } from './typescript-loader.js';

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
  | 'STATIC_PATH_REJECTED';

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

  /** Un ensemble de sources déjà lu (bundle, source maps, tests). */
  async analyzeSet(sources: SourceSet, mode: StaticAnalysisMode): Promise<StaticAnalysisOutcome> {
    const emit = this.options.onEvent ?? (() => undefined);
    const identity: StaticAnalysisIdentity = {
      application: this.options.applicationId,
      mode,
      sourceHash: sources.hash,
      ...(this.options.version ? { version: this.options.version } : {}),
      ...(this.options.commit ? { commit: this.options.commit } : {}),
      analyzerVersion: STATIC_ANALYZER_VERSION,
    };
    if (this.cache) {
      const cached = await this.cache.get(identity);
      if (cached) {
        emit(
          'STATIC_ANALYSIS_CACHE_HIT',
          `static knowledge reused (${String(cached.fields.length)} field(s))`,
        );
        return { graph: cached, cache: 'HIT' };
      }
      emit('STATIC_ANALYSIS_CACHE_MISS', `no static knowledge for this source hash: analysing`);
    }
    const ts = await loadTypeScript();
    if (!ts) {
      emit('STATIC_ANALYSIS_UNAVAILABLE', 'the TypeScript parser is not installed');
      return {
        graph: this.unavailable(mode, 'the TypeScript parser is not installed', sources.hash),
        cache: 'DISABLED',
      };
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
    let graph: StaticApplicationGraph;
    try {
      graph = buildStaticGraph(ts, sources, buildOptions);
    } catch (error) {
      return {
        graph: this.unavailable(mode, `analysis failed: ${(error as Error).message}`, sources.hash),
        cache: 'DISABLED',
      };
    }
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
      `${graph.framework} ${graph.coverage}: ${String(graph.routes.length)} route(s), ${String(graph.fields.length)} field(s), ${String(graph.apiCalls.length)} API call(s) in ${String(graph.stats.durationMs)} ms`,
    );
    if (this.cache && graph.coverage !== 'UNAVAILABLE')
      await this.cache.put(identity, graph).catch(() => undefined);
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
