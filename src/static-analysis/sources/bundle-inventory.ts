import { sha256 } from '../source-set.js';
import { displayUrl } from './model.js';

export type BundleSourceStatus =
  /** Les sources d'origine ont été extraites de la source map. */
  | 'SOURCE_MAP'
  /** Source map lue en partie (certaines sources sans sourcesContent). */
  | 'SOURCE_MAP_PARTIAL'
  /** Pas de source map utilisable : le bundle lui-même est analysé. */
  | 'BUNDLE_ONLY'
  /** Ni source map ni repli : rien n'a été lu (budget, erreur, repli désactivé). */
  | 'SKIPPED';

/** Un script chargé par l'application, tel qu'inventorié (jamais son contenu). */
export interface BundleDescriptor {
  /** Adresse sans paramètres. */
  url: string;
  contentHash?: string;
  bytes?: number;
  /** Vu chargé par le navigateur pendant le run (pas deviné). */
  loadedAtRuntime: boolean;
  /** Chargé après la première lecture (chunk à la demande). */
  lazy: boolean;
  sourceMap?: { kind: 'EXTERNAL' | 'HEADER' | 'INLINE'; url: string; hash?: string; bytes?: number };
  status: BundleSourceStatus;
  /** Sources extraites de ce bundle. */
  extracted: number;
  /** Pourquoi la source map n'a pas servi (sans contenu). */
  reason?: string;
}

/**
 * BUNDLE INVENTORY : les scripts que l'application a réellement chargés, leur empreinte,
 * leur source map et ce qui en a été tiré. Son empreinte d'ensemble (bundleSetHash)
 * identifie un déploiement : même ensemble de bundles, même connaissance statique.
 */
export class BundleInventory {
  private readonly byUrl = new Map<string, BundleDescriptor>();
  /** Adresses complètes vues au runtime, pas encore lues. */
  private readonly seen = new Map<string, boolean>();

  /** Un script vu par le navigateur. true s'il est nouveau (jamais vu, jamais lu). */
  observe(url: string, lazy: boolean): boolean {
    if (this.seen.has(url) || this.byUrl.has(displayUrl(url))) return false;
    this.seen.set(url, lazy);
    return true;
  }

  /** Les scripts vus mais pas encore lus, dans l'ordre d'arrivée. */
  pending(): { url: string; lazy: boolean }[] {
    return [...this.seen.entries()]
      .filter(([url]) => !this.byUrl.has(displayUrl(url)))
      .map(([url, lazy]) => ({ url, lazy }));
  }

  has(url: string): boolean {
    return this.byUrl.has(displayUrl(url));
  }

  record(descriptor: BundleDescriptor): void {
    this.byUrl.set(descriptor.url, descriptor);
    for (const url of this.seen.keys()) if (displayUrl(url) === descriptor.url) this.seen.delete(url);
  }

  all(): BundleDescriptor[] {
    return [...this.byUrl.values()];
  }

  get size(): number {
    return this.byUrl.size;
  }

  /** Empreinte de l'ensemble des bundles lus (adresse + contenu), stable quel que soit l'ordre. */
  bundleSetHash(): string {
    return sha256(
      this.all()
        .filter((bundle) => bundle.contentHash)
        .map((bundle) => `${bundle.url}\n${bundle.contentHash ?? ''}`)
        .sort()
        .join('\n'),
    );
  }
}
