import { buildApis } from './apis.js';
import { randomUUID } from 'node:crypto';
import type { CartographyConfig, CartographyModel, ScanRecord, SourceScan } from '../sdk/core/cartography.js';
import { analyzeAngular } from './analyze-angular.js';
import { analyzeJava } from './analyze-java.js';
import { analyzeOpenApi } from './analyze-openapi.js';
import { detectTechnologies, technologyStatuses } from './detect.js';
import type { SourceFacts } from './facts.js';
import {
  allowedPath,
  DEFAULT_LIMITS,
  gitRevision,
  readSource,
  SourceAccessError,
  type ReadLimits,
} from './files.js';
import { buildGraph } from './graph.js';

/**
 * LE SCAN D'UN PROJET : chaque source activée est lue (sous une racine autorisée, sans secrets, dans des
 * limites), ses technologies détectées, ses analyseurs pris en charge lancés ; puis le graphe est construit
 * à partir des faits de toutes les sources. Une erreur sur une source n'arrête pas les autres (scan
 * PARTIAL) ; une annulation arrête tout (CANCELLED). Incrémental : une source dont l'empreinte n'a pas
 * changé depuis le scan précédent reprend ses faits sans être réanalysée (REUSED).
 */
export interface ScanOptions {
  config: CartographyConfig;
  allowedRoots: readonly string[];
  incremental: boolean;
  previous?: { facts: readonly SourceFacts[]; sources: readonly SourceScan[] };
  limits?: ReadLimits;
  signal?: AbortSignal;
  now?: () => Date;
  onProgress?: (record: ScanRecord) => void;
}

export const newScanId = (now: Date): string =>
  `scan-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;

export async function runScan(
  options: ScanOptions,
): Promise<{ model: CartographyModel; facts: SourceFacts[] }> {
  const now = options.now ?? (() => new Date());
  const record: ScanRecord = {
    id: newScanId(now()),
    schema: 1,
    startedAt: now().toISOString(),
    state: 'RUNNING',
    incremental: options.incremental,
    sources: [],
    counts: {},
    edges: 0,
    errors: [],
  };
  const facts: SourceFacts[] = [];
  for (const source of options.config.sources) {
    if (options.signal?.aborted) break;
    const scan: SourceScan = {
      sourceId: source.id,
      name: source.name,
      layer: source.layer,
      state: 'SCANNED',
      technologies: [],
      files: 0,
      skipped: 0,
      secretsExcluded: 0,
      errors: [],
    };
    record.sources.push(scan);
    if (!source.enabled) {
      scan.state = 'DISABLED';
      continue;
    }
    let root: string;
    try {
      root = await allowedPath(source.path, options.allowedRoots);
    } catch (error) {
      scan.state = 'DENIED';
      scan.errors.push(error instanceof SourceAccessError ? error.message : String(error));
      continue;
    }
    try {
      const read = await readSource(root, source.include, options.limits ?? DEFAULT_LIMITS, options.signal);
      scan.files = read.files.length;
      scan.skipped = read.skipped;
      scan.secretsExcluded = read.secretsExcluded;
      scan.hash = read.hash;
      scan.errors.push(...read.limits);
      const allowedRoot = options.allowedRoots.find((candidate) => root.startsWith(candidate)) ?? root;
      const revision = await gitRevision(root, allowedRoot);
      if (revision) scan.revision = revision;
      const found = detectTechnologies(read.files);
      scan.technologies = technologyStatuses(found);
      const before = options.incremental
        ? options.previous?.sources.find((entry) => entry.sourceId === source.id)
        : undefined;
      const reused =
        before?.hash === read.hash
          ? options.previous?.facts.find((entry) => entry.sourceId === source.id)
          : undefined;
      if (reused) {
        scan.state = 'REUSED';
        facts.push({ ...reused, layer: source.layer, ...(revision ? { revision } : {}) });
        continue;
      }
      const sourceFacts: SourceFacts = {
        sourceId: source.id,
        layer: source.layer,
        ...(revision ? { revision } : {}),
      };
      if (found.has('ANGULAR')) {
        sourceFacts.ui = await analyzeAngular(root, read.files);
        scan.errors.push(...sourceFacts.ui.warnings.slice(0, 20));
      }
      if (found.has('SPRING') || found.has('JPA')) {
        sourceFacts.java = analyzeJava(source.id, source.layer === 'BFF' ? 'BFF' : 'BACKEND', read.files);
        scan.errors.push(...sourceFacts.java.warnings.slice(0, 20));
      }
      if (found.has('OPENAPI')) {
        sourceFacts.openapi = analyzeOpenApi(read.files);
        scan.errors.push(...sourceFacts.openapi.warnings.slice(0, 20));
      }
      if (read.limits.length > 0) scan.state = 'PARTIAL';
      if (found.size === 0) scan.errors.push('aucune technologie reconnue dans cette source');
      facts.push(sourceFacts);
    } catch (error) {
      scan.state = 'FAILED';
      scan.errors.push((error as Error).message);
    }
    options.onProgress?.({ ...record, sources: [...record.sources] });
  }
  const graph = buildGraph({ sources: options.config.sources, facts });
  const counts: ScanRecord['counts'] = {};
  for (const node of graph.nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  counts.FEATURE = graph.features.length;
  const failed = record.sources.filter((entry) => entry.state === 'FAILED' || entry.state === 'DENIED');
  const finished: ScanRecord = {
    ...record,
    finishedAt: now().toISOString(),
    state: options.signal?.aborted
      ? 'CANCELLED'
      : failed.length > 0 &&
          failed.length === record.sources.filter((entry) => entry.state !== 'DISABLED').length
        ? 'FAILED'
        : failed.length > 0 || record.sources.some((entry) => entry.state === 'PARTIAL')
          ? 'PARTIAL'
          : 'COMPLETED',
    counts,
    edges: graph.edges.length,
  };
  const base = { schema: 1 as const, scan: finished, ...graph };
  return { model: { ...base, apis: buildApis(base, facts) }, facts };
}
