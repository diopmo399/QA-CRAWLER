import { buildApis } from './apis.js';
import { randomUUID } from 'node:crypto';
import type {
  CartographyConfig,
  CartographyModel,
  MapSource,
  ScanRecord,
  SourceScan,
} from '../sdk/core/cartography.js';
import { analyzeAngular } from './analyze-angular.js';
import { analyzeJava } from './analyze-java.js';
import { analyzeMaven } from './analyze-maven.js';
import { analyzeOpenApi } from './analyze-openapi.js';
import { RXJS_ANALYZER } from './analyze-rxjs.js';
import { detectTechnologies, technologyStatuses } from './detect.js';
import type { SourceFacts } from './facts.js';
import {
  allowedPath,
  DEFAULT_LIMITS,
  gitInfo,
  readSource,
  SourceAccessError,
  type ReadLimits,
} from './files.js';
import { GitSourceError, type PreparedGit } from './git-source.js';
import { buildGraph } from './graph.js';

/**
 * LE SCAN D'UN PROJET : chaque source activée est lue (sous une racine autorisée, sans secrets, dans des
 * limites), ses technologies détectées, ses analyseurs pris en charge lancés ; puis le graphe est construit
 * à partir des faits de toutes les sources. Une erreur sur une source n'arrête pas les autres (scan
 * PARTIAL) ; une annulation arrête tout (CANCELLED). Incrémental : une source dont l'empreinte n'a pas
 * changé depuis le scan précédent reprend ses faits sans être réanalysée (REUSED).
 */
/**
 * La version des analyseurs : à changer quand un analyseur produit d'autres faits. Les faits d'une autre
 * version (ou d'avant, sans version) ne sont jamais repris par un scan incrémental.
 */
// 3 : onglets (groupes, libellés, chargement différé, routes) et composants affichés dans d'autres.
// 4 : éléments interactifs (liens, input, sorties de composants, ngSubmit) reliés à leur cible et contexte.
// 5 : contrats ($ref, servers, paramètres), modules Maven et générations, routes héritées, bases d'URL.
export const ANALYZERS = `cartography-5;${RXJS_ANALYZER}`;

export interface ScanOptions {
  config: CartographyConfig;
  allowedRoots: readonly string[];
  incremental: boolean;
  previous?: { facts: readonly SourceFacts[]; sources: readonly SourceScan[] };
  limits?: ReadLimits;
  signal?: AbortSignal;
  now?: () => Date;
  onProgress?: (record: ScanRecord) => void;
  /**
   * Prépare une source GIT (clone ou mise à jour) et rend son dossier et son commit vérifié ; absent : le
   * serveur n'accepte pas de source distante. Le reste du scan ne voit qu'un dossier.
   */
  prepareGit?: (source: MapSource, signal?: AbortSignal) => Promise<PreparedGit>;
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
    const remote = source.kind === 'GIT';
    if (remote) {
      scan.kind = 'GIT';
      if (source.branch) scan.branch = source.branch;
      if (source.commit) scan.requestedCommit = source.commit;
    }
    if (source.repoUrl) scan.repoUrl = source.repoUrl;
    if (source.provider) scan.provider = source.provider;
    record.sources.push(scan);
    if (!source.enabled) {
      scan.state = 'DISABLED';
      continue;
    }
    let root: string;
    let prepared: PreparedGit | undefined;
    try {
      if (remote) {
        if (!options.prepareGit)
          throw new GitSourceError('GIT_DISABLED', 'remote Git sources are not enabled on this server');
        prepared = await options.prepareGit(source, options.signal);
        root = prepared.root;
        scan.repoUrl = prepared.repo.url;
        if (prepared.repo.provider) scan.provider = prepared.repo.provider;
      } else root = await allowedPath(source.path, options.allowedRoots);
    } catch (error) {
      // Une adresse ou un dossier refusé : DENIED ; un dépôt qui n'a pas pu être préparé : FAILED. Les autres
      // sources continuent.
      const refused =
        !(error instanceof GitSourceError) ||
        ['GIT_DISABLED', 'URL_REFUSED', 'HOST_REFUSED'].includes(error.code);
      scan.state = refused ? 'DENIED' : 'FAILED';
      scan.errors.push(error instanceof SourceAccessError ? error.message : String(error));
      options.onProgress?.({ ...record, sources: [...record.sources] });
      continue;
    }
    try {
      const read = await readSource(root, source.include, options.limits ?? DEFAULT_LIMITS, options.signal);
      scan.files = read.files.length;
      scan.skipped = read.skipped;
      scan.secretsExcluded = read.secretsExcluded;
      scan.hash = read.hash;
      scan.errors.push(...read.limits);
      let revision: string | undefined;
      if (prepared) {
        revision = prepared.commit;
        scan.revisionStatus = 'RESOLVED';
        scan.repoPath = '';
      } else {
        const allowedRoot = options.allowedRoots.find((candidate) => root.startsWith(candidate)) ?? root;
        const git = await gitInfo(root, allowedRoot);
        revision = git.revision;
        scan.revisionStatus = git.status;
        if (git.repoPath !== undefined) scan.repoPath = git.repoPath;
        if (git.note) scan.errors.push(`révision Git indéterminée : ${git.note}`);
      }
      if (revision) scan.revision = revision;
      const found = detectTechnologies(read.files);
      scan.technologies = technologyStatuses(found);
      const before = options.incremental
        ? options.previous?.sources.find((entry) => entry.sourceId === source.id)
        : undefined;
      // Une source inchangée reprend ses faits, seulement s'ils viennent des analyseurs actuels : une
      // évolution d'un analyseur fait relire la source (de nouvelles relations peuvent apparaître).
      const previous =
        before?.hash === read.hash
          ? options.previous?.facts.find((entry) => entry.sourceId === source.id)
          : undefined;
      const reused = previous?.analyzer === ANALYZERS ? previous : undefined;
      if (reused) {
        scan.state = 'REUSED';
        facts.push({ ...reused, layer: source.layer, ...(revision ? { revision } : {}) });
        continue;
      }
      const sourceFacts: SourceFacts = {
        sourceId: source.id,
        layer: source.layer,
        analyzer: ANALYZERS,
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
      // Les modules Maven : identité, dépendances et générations de code depuis un contrat (un module de
      // contrats sans Java en est un aussi).
      if (read.files.some((file) => file.path.split('/').pop() === 'pom.xml')) {
        sourceFacts.maven = analyzeMaven(read.files);
        scan.errors.push(...sourceFacts.maven.warnings.slice(0, 20));
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
