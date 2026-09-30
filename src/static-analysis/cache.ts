import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../memory/atomic-write.js';
import { STATIC_ANALYZER_VERSION, type StaticAnalysisMode, type StaticApplicationGraph } from './model.js';
import { sha256 } from './source-set.js';

/** Ce qui identifie une analyse : si l'un change, l'ancienne n'est jamais réutilisée. */
export interface StaticAnalysisIdentity {
  application: string;
  mode: StaticAnalysisMode;
  /** Empreinte des sources (SOURCE) ou des bundles (BUNDLE). */
  sourceHash: string;
  version?: string;
  commit?: string;
  analyzerVersion?: string;
}

export function cacheKeyOf(identity: StaticAnalysisIdentity): string {
  return sha256(
    [
      identity.analyzerVersion ?? STATIC_ANALYZER_VERSION,
      identity.application,
      identity.mode,
      identity.version ?? '',
      identity.commit ?? '',
      identity.sourceHash,
    ].join('\n'),
  ).slice(0, 32);
}

export type CacheOutcome = 'HIT' | 'MISS';

/**
 * STATIC ANALYSIS CACHE : un fichier JSON par identité (application, version, commit,
 * empreinte des sources, version de l'analyseur) dans un dossier gardé hors du dépôt.
 * Pas de base de données : un artefact JSON suffit à rechercher par identité.
 */
export class StaticAnalysisCache {
  constructor(private readonly directory: string) {}

  fileOf(identity: StaticAnalysisIdentity): string {
    return path.join(this.directory, `static-${cacheKeyOf(identity)}.json`);
  }

  async get(identity: StaticAnalysisIdentity): Promise<StaticApplicationGraph | undefined> {
    const text = await readFile(this.fileOf(identity), 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const graph = JSON.parse(text) as StaticApplicationGraph;
      // Double contrôle : un fichier d'une autre version de l'analyseur n'est jamais repris.
      if (
        graph.analyzerVersion !== (identity.analyzerVersion ?? STATIC_ANALYZER_VERSION) ||
        graph.sourceHash !== identity.sourceHash
      )
        return undefined;
      return graph;
    } catch {
      return undefined;
    }
  }

  async put(identity: StaticAnalysisIdentity, graph: StaticApplicationGraph): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(this.fileOf(identity), `${JSON.stringify(graph)}\n`);
  }
}
