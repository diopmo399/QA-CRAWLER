import type { StaticAnalysisMode } from '../model.js';
import { sha256 } from '../source-set.js';
import type { SourceDiscoverySink, StaticSourceDiscoverySummary } from './model.js';
import type { RepositorySourceProvider, RuntimeBundleSourceProvider } from './source-providers.js';
import { VirtualSourceWorkspace, type WorkspaceBudget } from './virtual-workspace.js';

/**
 * auto        dépôt si disponible, sinon source maps du déploiement, sinon bundles ;
 * source      le dépôt seulement ;
 * source-map  les source maps du déploiement (repli sur le bundle si permis) ;
 * bundle      les bundles minifiés seulement ;
 * hybrid      le dépôt ET le déploiement : le build déployé l'emporte là où ils divergent.
 */
export type SourceStrategy = 'auto' | 'source' | 'source-map' | 'bundle' | 'hybrid';

export interface SourceDiscoveryOptions {
  strategy: SourceStrategy;
  repository?: RepositorySourceProvider;
  runtime?: RuntimeBundleSourceProvider;
  workspace: WorkspaceBudget;
  /** Réglages qui changent le résultat (inline, external, repli…) : ils entrent dans la clé de cache. */
  settingsKey: string;
  onEvent?: SourceDiscoverySink;
}

/**
 * STATIC SOURCE DISCOVERY : choisit et enchaîne les fournisseurs de sources, remplit le
 * workspace virtuel, puis le rend à l'analyseur existant. En deux temps :
 *
 *   prepare()   dépôt + inventaire des bundles (empreintes) → alias de cache ;
 *   complete()  extraction des source maps (seulement si le cache n'a pas répondu).
 *
 * enrich() ajoute les chunks chargés depuis (routes à la demande).
 */
export class StaticSourceDiscovery {
  readonly workspace: VirtualSourceWorkspace;
  private runtimeUsed = false;
  private announced = false;

  constructor(private readonly options: SourceDiscoveryOptions) {
    this.workspace = new VirtualSourceWorkspace(options.workspace);
  }

  private emit(event: Parameters<SourceDiscoverySink>[0], message: string): void {
    this.options.onEvent?.(event, message);
  }

  async prepare(): Promise<void> {
    const { strategy, repository, runtime } = this.options;
    if (repository && (strategy === 'auto' || strategy === 'source' || strategy === 'hybrid'))
      await repository.provide(this.workspace);
    const needRuntime =
      strategy === 'hybrid' ||
      strategy === 'source-map' ||
      strategy === 'bundle' ||
      (strategy === 'auto' && this.workspace.size === 0);
    if (needRuntime && runtime) {
      await runtime.inventoryPending();
      this.runtimeUsed = true;
    }
  }

  /**
   * Identifie ce qui sera analysé AVANT l'extraction : sources du dépôt + ensemble des
   * bundles déployés + réglages. Même alias, même connaissance : aucune source map à
   * télécharger.
   */
  alias(): string | undefined {
    if (!this.runtimeUsed || !this.options.runtime) return undefined;
    return sha256(
      [
        this.options.strategy,
        this.options.settingsKey,
        this.workspace.toSourceSet().hash,
        this.options.runtime.bundleSetHash(),
      ].join('\n'),
    );
  }

  async complete(): Promise<void> {
    if (this.runtimeUsed && this.options.runtime) await this.options.runtime.extractPending(this.workspace);
    if (!this.announced) {
      this.announced = true;
      this.emit(
        'VIRTUAL_WORKSPACE_CREATED',
        `${String(this.workspace.size)} file(s) from ${[...this.workspace.origins()].join(' + ') || 'nothing'}`,
      );
    }
  }

  /** Des chunks chargés depuis la dernière lecture attendent. */
  hasPending(): boolean {
    return this.runtimeUsed && (this.options.runtime?.hasPending() ?? false);
  }

  /** Ajoute au workspace les chunks chargés depuis ; true si le workspace a changé. */
  async enrich(): Promise<boolean> {
    const runtime = this.options.runtime;
    if (!this.runtimeUsed || !runtime) return false;
    const before = this.workspace.version;
    const size = this.workspace.size;
    await runtime.inventoryPending();
    await runtime.extractPending(this.workspace);
    this.announced = true;
    if (this.workspace.version === before) return false;
    this.emit(
      'VIRTUAL_WORKSPACE_ENRICHED',
      `${String(this.workspace.size - size)} new file(s), ${String(this.workspace.size)} in total`,
    );
    return true;
  }

  /** Le mode d'analyse que donnent les origines réellement lues. */
  analysisMode(): StaticAnalysisMode {
    const origins = this.workspace.origins();
    const repository = origins.has('REPOSITORY');
    if (repository && (origins.has('SOURCE_MAP') || origins.has('BUNDLE'))) return 'HYBRID';
    if (repository) return 'SOURCE';
    if (origins.has('SOURCE_MAP')) return 'SOURCE_MAP';
    return 'BUNDLE';
  }

  summary(): StaticSourceDiscoverySummary {
    const runtime = this.runtimeUsed ? this.options.runtime : undefined;
    const bundles = runtime?.inventory.all() ?? [];
    const origins = [...this.workspace.origins()].sort();
    return {
      strategy: this.options.strategy,
      origins,
      bundles: bundles.filter((bundle) => bundle.contentHash).length,
      lazyBundles: bundles.filter((bundle) => bundle.lazy).length,
      sourceMaps: {
        referenced: runtime?.counters.referenced ?? 0,
        loaded: runtime?.counters.loaded ?? 0,
        partial: runtime?.counters.partial ?? 0,
        rejected: runtime?.counters.rejected ?? 0,
      },
      extractedSources: this.workspace.provenance().filter((file) => file.origin === 'SOURCE_MAP').length,
      bundleOnly: bundles.filter((bundle) => bundle.status === 'BUNDLE_ONLY').length,
      conflicts: [...this.workspace.conflicts].slice(0, 20),
      mismatches: [...this.workspace.mismatches].slice(0, 20),
      ...(runtime ? { bundleSetHash: runtime.bundleSetHash() } : {}),
      entries: bundles.slice(0, 30).map((bundle) => ({
        url: bundle.url,
        status: bundle.status,
        lazy: bundle.lazy,
        ...(bundle.sourceMap ? { sourceMap: bundle.sourceMap.url } : {}),
        extracted: bundle.extracted,
        ...(bundle.reason ? { reason: bundle.reason } : {}),
      })),
    };
  }
}
