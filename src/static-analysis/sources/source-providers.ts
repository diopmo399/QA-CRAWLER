import { collectSources, sha256, type SourceBudget } from '../source-set.js';
import { BundleInventory, type BundleDescriptor } from './bundle-inventory.js';
import { displayUrl, type SourceDiscoverySink, type StaticSourceOrigin } from './model.js';
import { normalizeSourcePath } from './path-normalizer.js';
import {
  decodeInlineSourceMap,
  findSourceMapReference,
  readSourceMap,
  type SourceMapReference,
} from './source-map-reader.js';
import type { VirtualSourceWorkspace } from './virtual-workspace.js';

/**
 * STATIC SOURCE PROVIDER : une manière d'obtenir des sources pour l'analyseur existant.
 * Chaque fournisseur remplit le même VirtualSourceWorkspace ; l'analyseur ne sait pas
 * d'où viennent les fichiers (la provenance les accompagne pour le rapport).
 */
export interface StaticSourceProvider {
  readonly origin: StaticSourceOrigin;
  provide(workspace: VirtualSourceWorkspace): Promise<void>;
}

/** REPOSITORY : le dépôt de l'application, lu comme avant (mêmes exclusions, même budget). */
export class RepositorySourceProvider implements StaticSourceProvider {
  readonly origin = 'REPOSITORY' as const;

  constructor(
    private readonly root: string,
    private readonly budget: SourceBudget,
    private readonly now?: () => number,
  ) {}

  async provide(workspace: VirtualSourceWorkspace): Promise<void> {
    const set = await collectSources(this.root, this.budget, this.now);
    for (const file of set.files) workspace.add({ path: file.path, text: file.text, origin: 'REPOSITORY' });
    if (set.budgetExhausted)
      workspace.note(`STATIC_ANALYSIS_BUDGET_EXHAUSTED: ${String(set.skipped.length)} file(s) not read`);
  }
}

/** Un script lu : son texte et ses en-têtes (clés en minuscules). */
export interface ScriptResource {
  text: string;
  headers: Readonly<Record<string, string>>;
}

/** Pourquoi une adresse n'a pas été lue : statut HTTP, redirection, taille, délai (jamais un corps). */
export interface ScriptFetchFailure {
  failure: string;
}

/**
 * Lit une adresse déjà autorisée, sans suivre de redirection (une redirection pourrait
 * mener hors des hôtes autorisés), dans la limite de maxBytes. undefined ou failure : illisible.
 */
export type ScriptFetcher = (
  url: string,
  maxBytes: number,
) => Promise<ScriptResource | ScriptFetchFailure | undefined>;

/** La raison d'un échec de lecture, pour le rapport. */
function failureOf(resource: ScriptResource | ScriptFetchFailure | undefined): string | undefined {
  if (!resource) return 'not readable';
  return 'failure' in resource ? resource.failure : undefined;
}

export interface RuntimeSourceBudgets {
  maxBundles: number;
  maxSourceMaps: number;
  maxSourceMapBytes: number;
  /** Taille maximale d'un bundle lu. */
  maxFileSizeBytes: number;
}

export interface RuntimeSourceOptions {
  fetch: ScriptFetcher;
  /** AllowedOriginPolicy de la mission : un bundle ou une source map d'un autre hôte n'est jamais lu. */
  isAllowedUrl: (url: string) => boolean;
  sourceMaps: { enabled: boolean; inline: boolean; external: boolean };
  /** BUNDLE_ONLY : sans source map utilisable, le bundle lui-même est analysé. */
  bundleFallback: boolean;
  budgets: RuntimeSourceBudgets;
  onEvent?: SourceDiscoverySink;
}

/** Un bundle lu, pas encore extrait (la source map n'est lue qu'au besoin). */
interface InventoriedBundle {
  url: string;
  display: string;
  text: string;
  hash: string;
  lazy: boolean;
  reference?: SourceMapReference;
}

/**
 * SOURCE MAP + BUNDLE PROVIDER : les scripts que le navigateur a réellement chargés.
 *
 * 1. INVENTAIRE : chaque script (hôte autorisé) est lu une fois, son empreinte calculée,
 *    sa référence de source map relevée (en-tête, commentaire, inline) — jamais devinée.
 *    L'empreinte de l'ensemble (bundleSetHash) permet au cache de répondre AVANT de
 *    télécharger une seule source map.
 * 2. EXTRACTION : les sourcesContent deviennent des fichiers du workspace virtuel ; une
 *    source map absente, illisible ou rejetée laisse place au bundle lui-même
 *    (BUNDLE_FALLBACK), sans jamais faire échouer le run.
 *
 * Les chunks chargés plus tard (routes à la demande) s'ajoutent par observe() puis
 * extractPending() : le workspace s'enrichit, l'analyse est refaite sur l'ensemble.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export class RuntimeBundleSourceProvider implements StaticSourceProvider {
  readonly origin = 'SOURCE_MAP' as const;
  readonly inventory = new BundleInventory();
  private readonly toExtract: InventoriedBundle[] = [];
  private mapsRead = 0;
  private initialDone = false;
  private budgetNoted = false;
  readonly counters = { referenced: 0, loaded: 0, partial: 0, rejected: 0, lazy: 0 };

  constructor(private readonly options: RuntimeSourceOptions) {}

  private emit(event: Parameters<SourceDiscoverySink>[0], message: string): void {
    this.options.onEvent?.(event, message);
  }

  /** Un script vu par le navigateur. Après la première lecture, c'est un chunk à la demande. */
  observe(url: string): boolean {
    if (!/^https?:/i.test(url)) return false;
    const lazy = this.initialDone;
    const fresh = this.inventory.observe(url, lazy);
    if (fresh && lazy) {
      this.counters.lazy += 1;
      this.emit('LAZY_BUNDLE_DISCOVERED', displayUrl(url));
    }
    return fresh;
  }

  /** Des scripts attendent d'être lus (chunks chargés depuis la dernière lecture). */
  hasPending(): boolean {
    return this.inventory.pending().length > 0 || this.toExtract.length > 0;
  }

  /** Étape 1 : lit les scripts vus et relève leurs références, sans lire une seule source map. */
  async inventoryPending(): Promise<void> {
    for (const { url, lazy } of this.inventory.pending()) {
      try {
        await this.inventoryOne(url, lazy);
      } catch (error) {
        this.inventory.record(this.descriptor(url, lazy, 'SKIPPED', `unreadable: ${(error as Error).name}`));
      }
    }
    this.initialDone = true;
  }

  bundleSetHash(): string {
    return this.inventory.bundleSetHash();
  }

  async provide(workspace: VirtualSourceWorkspace): Promise<void> {
    await this.inventoryPending();
    await this.extractPending(workspace);
  }

  /** Étape 2 : chaque bundle inventorié donne ses sources d'origine, sinon lui-même. */
  async extractPending(workspace: VirtualSourceWorkspace): Promise<void> {
    while (this.toExtract.length > 0) {
      const bundle = this.toExtract.shift();
      if (!bundle) break;
      try {
        await this.extractOne(bundle, workspace);
      } catch (error) {
        this.fallback(bundle, workspace, `extraction failed: ${(error as Error).name}`);
      }
    }
  }

  private descriptor(
    url: string,
    lazy: boolean,
    status: BundleDescriptor['status'],
    reason?: string,
  ): BundleDescriptor {
    return {
      url: displayUrl(url),
      loadedAtRuntime: true,
      lazy,
      status,
      extracted: 0,
      ...(reason ? { reason } : {}),
    };
  }

  private allowed(url: string): boolean {
    try {
      return /^https?:/i.test(url) && this.options.isAllowedUrl(url);
    } catch {
      return false;
    }
  }

  private async inventoryOne(url: string, lazy: boolean): Promise<void> {
    const { budgets } = this.options;
    if (!this.allowed(url)) {
      this.inventory.record(
        this.descriptor(
          url,
          lazy,
          'SKIPPED',
          `origin not allowed: ${hostOf(url)} (add it to staticAnalysis.bundle.allowedHosts to read its code)`,
        ),
      );
      return;
    }
    const read = this.inventory.all().filter((bundle) => bundle.contentHash).length;
    if (read >= budgets.maxBundles) {
      if (!this.budgetNoted)
        this.emit('BUNDLE_DISCOVERED', `maxBundles (${String(budgets.maxBundles)}) reached`);
      this.budgetNoted = true;
      this.inventory.record(this.descriptor(url, lazy, 'SKIPPED', 'maxBundles reached'));
      return;
    }
    const resource = await this.options.fetch(url, budgets.maxFileSizeBytes);
    if (!resource || 'failure' in resource) {
      this.inventory.record(this.descriptor(url, lazy, 'SKIPPED', failureOf(resource) ?? 'not readable'));
      return;
    }
    const display = displayUrl(url);
    const hash = sha256(resource.text);
    this.emit(
      'BUNDLE_DISCOVERED',
      `${display} (${String(Buffer.byteLength(resource.text, 'utf8'))} bytes${lazy ? ', lazy' : ''})`,
    );
    const reference = this.options.sourceMaps.enabled
      ? findSourceMapReference(resource.text, url, resource.headers)
      : undefined;
    if (reference) {
      this.counters.referenced += 1;
      this.emit(
        'SOURCE_MAP_REFERENCE_DISCOVERED',
        `${display} → ${reference.kind === 'INLINE' ? 'inline' : displayUrl(reference.url)}`,
      );
    }
    this.inventory.record({
      ...this.descriptor(url, lazy, 'SKIPPED'),
      contentHash: hash,
      bytes: Buffer.byteLength(resource.text, 'utf8'),
      ...(reference
        ? {
            sourceMap: {
              kind: reference.kind,
              url: reference.kind === 'INLINE' ? 'inline' : displayUrl(reference.url),
            },
          }
        : {}),
    });
    this.toExtract.push({
      url,
      display,
      text: resource.text,
      hash,
      lazy,
      ...(reference ? { reference } : {}),
    });
  }

  private update(bundle: InventoriedBundle, patch: Partial<BundleDescriptor>): void {
    const current = this.inventory.all().find((entry) => entry.url === bundle.display);
    if (current) this.inventory.record({ ...current, ...patch });
  }

  private async extractOne(bundle: InventoriedBundle, workspace: VirtualSourceWorkspace): Promise<void> {
    const { sourceMaps, budgets } = this.options;
    const reference = bundle.reference;
    if (!sourceMaps.enabled) {
      this.fallback(bundle, workspace, 'source maps disabled', false);
      return;
    }
    if (!reference) {
      this.fallback(bundle, workspace, 'no source map reference');
      return;
    }
    if (reference.kind === 'INLINE' ? !sourceMaps.inline : !sourceMaps.external) {
      this.reject(bundle, workspace, `${reference.kind.toLowerCase()} source maps disabled`);
      return;
    }
    if (this.mapsRead >= budgets.maxSourceMaps) {
      this.reject(bundle, workspace, `maxSourceMaps (${String(budgets.maxSourceMaps)}) reached`);
      return;
    }
    this.mapsRead += 1;
    const mapLabel = reference.kind === 'INLINE' ? 'inline' : displayUrl(reference.url);
    this.emit('SOURCE_MAP_LOADING_STARTED', `${bundle.display} → ${mapLabel}`);
    let text: string;
    if (reference.kind === 'INLINE') {
      const decoded = decodeInlineSourceMap(reference.dataUri, budgets.maxSourceMapBytes);
      if ('rejected' in decoded) {
        this.reject(bundle, workspace, decoded.rejected);
        return;
      }
      text = decoded.text;
    } else {
      if (!this.allowed(reference.url)) {
        this.reject(bundle, workspace, 'source map origin not allowed');
        return;
      }
      const resource = await this.options.fetch(reference.url, budgets.maxSourceMapBytes);
      if (!resource || 'failure' in resource) {
        this.reject(bundle, workspace, `source map ${failureOf(resource) ?? 'not readable'}`);
        return;
      }
      text = resource.text;
    }
    const map = readSourceMap(text, budgets.maxSourceMapBytes);
    if (map.status === 'REJECTED') {
      this.reject(bundle, workspace, map.reason);
      return;
    }
    const mapHash = sha256(text);
    let usable = 0;
    let extracted = 0;
    let missing = 0;
    let unsafe = 0;
    for (const entry of map.entries) {
      const normalized = normalizeSourcePath(entry.source, map.sourceRoot);
      if (normalized.status === 'IGNORED') continue;
      if (normalized.status === 'REJECTED') {
        unsafe += 1;
        continue;
      }
      if (entry.content === undefined) {
        missing += 1;
        continue;
      }
      const outcome = workspace.add({
        path: normalized.path,
        text: entry.content,
        origin: 'SOURCE_MAP',
        bundleUrl: bundle.display,
        bundleHash: bundle.hash,
        sourceMapUrl: mapLabel,
        mapHash,
        originalPath: normalized.original,
      });
      if (outcome === 'BUDGET' || outcome === 'TOO_LARGE') {
        missing += 1;
        continue;
      }
      usable += 1;
      if (outcome === 'ADDED') {
        extracted += 1;
        this.emit('SOURCE_EXTRACTED', normalized.path);
      } else if (outcome === 'CONFLICT')
        this.emit('SOURCE_CONTENT_CONFLICT', `${normalized.path}: two source maps disagree (first kept)`);
      else if (outcome === 'MISMATCH')
        this.emit(
          'SOURCE_BUILD_MISMATCH',
          `${normalized.path}: the repository differs from the deployed build (deployed build used)`,
        );
    }
    if (unsafe > 0)
      workspace.note(`SOURCE_MAP_PARTIAL: ${mapLabel}: ${String(unsafe)} unsafe path(s) rejected`);
    for (const note of map.notes) workspace.note(`SOURCE_MAP_PARTIAL: ${mapLabel}: ${note}`);
    if (usable === 0 && missing > 0) {
      this.reject(bundle, workspace, 'no sourcesContent for application sources');
      return;
    }
    const partial = missing > 0 || unsafe > 0 || map.notes.length > 0;
    if (partial) {
      this.counters.partial += 1;
      workspace.note(`SOURCE_MAP_PARTIAL: ${mapLabel}: ${String(missing)} source(s) without content`);
      this.emit(
        'SOURCE_MAP_PARTIAL',
        `${mapLabel}: ${String(extracted)} source(s) extracted, ${String(missing)} without content`,
      );
    } else {
      this.counters.loaded += 1;
      this.emit('SOURCE_MAP_LOADED', `${mapLabel}: ${String(extracted)} source(s) extracted`);
    }
    this.update(bundle, {
      status: partial ? 'SOURCE_MAP_PARTIAL' : 'SOURCE_MAP',
      extracted,
      sourceMap: {
        kind: reference.kind,
        url: mapLabel,
        hash: mapHash,
        bytes: Buffer.byteLength(text, 'utf8'),
      },
    });
  }

  /** SOURCE_MAP_REJECTED : jamais d'échec du run, le bundle prend le relais si permis. */
  private reject(bundle: InventoriedBundle, workspace: VirtualSourceWorkspace, reason: string): void {
    this.counters.rejected += 1;
    this.emit('SOURCE_MAP_REJECTED', `${bundle.display}: ${reason}`);
    this.fallback(bundle, workspace, reason);
  }

  private fallback(
    bundle: InventoriedBundle,
    workspace: VirtualSourceWorkspace,
    reason: string,
    announce = true,
  ): void {
    if (!this.options.bundleFallback) {
      this.update(bundle, { status: 'SKIPPED', reason });
      if (announce) workspace.note(`SOURCE_MAP_REJECTED: ${bundle.display}: ${reason}`);
      return;
    }
    if (announce) {
      this.emit('BUNDLE_FALLBACK_STARTED', `${bundle.display}: ${reason}`);
      workspace.note(`BUNDLE_ONLY: ${bundle.display}: ${reason}`);
    }
    let pathname: string;
    try {
      pathname = new URL(bundle.url).pathname.replace(/^\/+/, '') || 'index.js';
    } catch {
      pathname = 'bundle.js';
    }
    if (!/\.(m?js|cjs)$/.test(pathname)) pathname = `${pathname}.js`;
    // Micro-frontends : chaque application a SON main.js sur SON hôte. Le même chemin déjà pris par un
    // autre bundle : le chemin est qualifié par l'hôte (jamais un conflit qui écarterait une application).
    let path = `bundle/${pathname}`;
    const taken = workspace.hashOf(path);
    if (taken !== undefined && taken !== sha256(bundle.text)) {
      let host = 'other-host';
      try {
        host = new URL(bundle.url).hostname || host;
      } catch {
        // garde le nom générique
      }
      path = `bundle/${host}/${pathname}`;
    }
    const outcome = workspace.add({
      path,
      text: bundle.text,
      origin: 'BUNDLE',
      bundleUrl: bundle.display,
      bundleHash: bundle.hash,
    });
    this.update(bundle, {
      status: outcome === 'ADDED' || outcome === 'DUPLICATE' ? 'BUNDLE_ONLY' : 'SKIPPED',
      extracted: outcome === 'ADDED' ? 1 : 0,
      reason,
    });
  }
}
