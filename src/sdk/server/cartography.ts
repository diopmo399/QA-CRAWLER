import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  applyLinkDecisions,
  computeCoverage,
  proposeLinks,
  type LastRun,
  type ScenarioInput,
} from '../../cartography/coverage.js';
import { applyDecisions } from '../../cartography/decisions.js';
import { featureMap } from '../../cartography/feature-map.js';
import { allowedPath, isReadableFile, SourceAccessError } from '../../cartography/files.js';
import {
  gitFileUrl,
  gitShow,
  GitSourceError,
  isBranchName,
  isCommitId,
  parseRepoUrl,
  prepareGitSource,
  removeWorkdirs,
  workdirOf,
  type GitPolicy,
} from '../../cartography/git-source.js';
import { computeImpact } from '../../cartography/impact.js';
import type { MavenOptions } from '../../cartography/maven-resolve.js';
import {
  apiSheet,
  buildIndex,
  featureDetail,
  featureFields,
  fieldSheet,
  neighbours,
  queryConcepts,
  queryFeatures,
  queryApis,
  queryIssues,
  traceOf,
  unresolvedOf,
  type CoverageContext,
  type MapIndex,
} from '../../cartography/explorer.js';
import { expandInvestigation, investigate, InvestigationStaleError } from '../../cartography/investigate.js';
import { runScan } from '../../cartography/scan.js';
import { actionRows, conditionRows, elementSheet, structureOf } from '../../cartography/structure.js';
import {
  appendDecision,
  CartographyStoreError,
  listInvestigations,
  listScans,
  readInvestigation,
  writeInvestigation,
  readConfig,
  readDecisions,
  readScan,
  writeConfig,
  writeScan,
  type StoredScan,
} from '../../cartography/store.js';
import {
  DECISION_KINDS,
  FEATURE_CATEGORIES,
  FEATURE_LANES,
  GIT_PROVIDERS,
  INVESTIGATION_GOALS,
  MAP_EDGE_KINDS,
  MAP_LAYERS,
  TRACE_DIRECTIONS,
  SUPPORTED_TECHNOLOGIES,
  type ActionRow,
  type ApiCatalog,
  type ApiSheet,
  type ConditionRow,
  type ElementSheet,
  type MapEdgeKind,
  type MapLayer,
  type Investigation,
  type InvestigationBudget,
  type InvestigationRequest,
  type InvestigationSummary,
  type MapTrace,
  type TraceDirection,
  type MapStructure,
  type CartographyConfig,
  type CartographyView,
  type ConceptRow,
  type CoverageSummary,
  type DecisionKind,
  type EvidenceExcerpt,
  type FeatureDetail,
  type FeatureMap,
  type FeatureMapQuery,
  type FeatureRow,
  type FieldIssue,
  type FieldRow,
  type FieldSheet,
  type ImpactReport,
  type MapDecision,
  type MapListQuery,
  type UnresolvedPage,
  type MapPage,
  type MapSource,
  type MetadataRoot,
  type MapSubgraph,
  type MapSummary,
  type ScanRecord,
} from '../core/cartography.js';
import type { ScenarioView } from '../core/contracts.js';
import { flowEntries } from './library.js';
import { executionDetail, listExecutions, listScenarios, runDigest } from './platform.js';
import { REPORTS_DIR } from './project.js';

/**
 * LA CARTOGRAPHIE D'UN PROJET, côté serveur : la configuration des sources (sous les racines que le
 * serveur autorise), un scan à la fois par projet (en arrière-plan, annulable), la vue (dernier scan,
 * décisions rejouées, associations aux scénarios, couverture d'après les exécutions réelles), les
 * décisions (historique, jamais réécrit), l'impact entre deux scans et l'extrait de code d'une preuve.
 */
export class CartographyInputError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CartographyInputError';
  }
}

export interface CartographyProject {
  id: string;
  dir: string;
}

interface Job {
  record: ScanRecord;
  controller: AbortController;
  done: Promise<void>;
}

/** Les scans en cours, par dossier de projet (un seul à la fois). */
const JOBS = new Map<string, Job>();
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MAX_SOURCES = 30;
const MAX_TEXT = 300;

const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : undefined;

/** Une configuration reçue : chaque source contrôlée, son dossier sous une racine autorisée. */
export async function saveConfig(
  project: CartographyProject,
  input: unknown,
  allowedRoots: readonly string[],
  now = new Date(),
  git?: GitPolicy,
): Promise<CartographyConfig> {
  const raw = input && typeof input === 'object' ? (input as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(raw)) throw new CartographyInputError(400, 'INVALID_INPUT', 'sources must be an array');
  if (raw.length > MAX_SOURCES)
    throw new CartographyInputError(400, 'INVALID_INPUT', `${String(MAX_SOURCES)} sources at most`);
  const sources: MapSource[] = [];
  for (const [index, entry] of (raw as unknown[]).entries()) {
    const source = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const where = `sources[${String(index)}]`;
    const id = typeof source.id === 'string' && SOURCE_ID.test(source.id) ? source.id : undefined;
    if (!id)
      throw new CartographyInputError(
        400,
        'INVALID_INPUT',
        `${where}.id: letters, digits, - and _ (40 at most)`,
      );
    if (sources.some((other) => other.id === id))
      throw new CartographyInputError(400, 'INVALID_INPUT', `${where}.id: duplicate source ${id}`);
    const name = text(source.name, 80);
    if (!name)
      throw new CartographyInputError(
        400,
        'INVALID_INPUT',
        `${where}.name is required (80 characters at most)`,
      );
    const layer = MAP_LAYERS.find((candidate) => candidate === source.layer);
    if (!layer)
      throw new CartographyInputError(
        400,
        'INVALID_INPUT',
        `${where}.layer must be one of ${MAP_LAYERS.join(', ')}`,
      );
    if (source.kind !== undefined && source.kind !== 'LOCAL' && source.kind !== 'GIT')
      throw new CartographyInputError(400, 'INVALID_INPUT', `${where}.kind must be LOCAL or GIT`);
    const remote = source.kind === 'GIT';
    const provider =
      source.provider === undefined || source.provider === ''
        ? undefined
        : GIT_PROVIDERS.find((candidate) => candidate === source.provider);
    if (source.provider !== undefined && source.provider !== '' && !provider)
      throw new CartographyInputError(
        400,
        'INVALID_INPUT',
        `${where}.provider must be one of ${GIT_PROVIDERS.join(', ')}`,
      );
    const folder = remote ? '' : text(source.path, 1024);
    if (folder === undefined)
      throw new CartographyInputError(400, 'INVALID_INPUT', `${where}.path is required`);
    const remoteFields = gitFields(source, where, remote, git);
    const include: unknown[] = Array.isArray(source.include) ? (source.include as unknown[]) : [];
    if (
      include.length > 20 ||
      include.some(
        (value) =>
          !text(value, 300) || path.isAbsolute(String(value)) || String(value).split(/[\\/]/).includes('..'),
      )
    )
      throw new CartographyInputError(
        400,
        'INVALID_INPUT',
        `${where}.include: 20 relative folders at most, inside the source`,
      );
    const enabled = source.enabled !== false;
    // Le dossier est vérifié à l'enregistrement (sous une racine autorisée, sans lien qui en sorte).
    if (enabled && !remote)
      try {
        await allowedPath(folder, allowedRoots);
      } catch (error) {
        throw new CartographyInputError(
          422,
          'SOURCE_DENIED',
          `${where}.path: ${error instanceof SourceAccessError ? error.message : String(error)}`,
        );
      }
    sources.push({
      id,
      name,
      layer,
      ...(remote ? { kind: 'GIT' as const } : {}),
      path: folder,
      include: include.map((value) => String(value).trim()),
      enabled,
      ...remoteFields,
      ...(provider ? { provider } : {}),
    });
  }
  // Les racines de métadonnées de dépendances : locales, sous une racine autorisée (vérifiée ici et au scan).
  const rawMeta = input && typeof input === 'object' ? (input as { metadata?: unknown }).metadata : undefined;
  if (rawMeta !== undefined && !Array.isArray(rawMeta))
    throw new CartographyInputError(400, 'INVALID_INPUT', 'metadata must be an array');
  const metadata: MetadataRoot[] = [];
  for (const [index, entry] of ((rawMeta as unknown[] | undefined) ?? []).entries()) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const where = `metadata[${String(index)}]`;
    const id = typeof item.id === 'string' && SOURCE_ID.test(item.id) ? item.id : undefined;
    const name = text(item.name, 80);
    const folder = text(item.path, 1000);
    if (!id || !name || !folder || metadata.some((m) => m.id === id))
      throw new CartographyInputError(
        400,
        'INVALID_INPUT',
        `${where}: id (unique), name and path are required`,
      );
    const enabled = item.enabled !== false;
    if (enabled)
      try {
        await allowedPath(folder, allowedRoots);
      } catch (error) {
        throw new CartographyInputError(
          422,
          'SOURCE_DENIED',
          `${where}.path: ${error instanceof SourceAccessError ? error.message : String(error)}`,
        );
      }
    metadata.push({ id, name, path: folder, enabled });
  }
  const before = await readConfig(project.dir);
  const config: CartographyConfig = {
    schema: 1,
    sources,
    ...(metadata.length ? { metadata } : {}),
    updatedAt: now.toISOString(),
  };
  await writeConfig(project.dir, config);
  // Les copies de travail des sources GIT retirées (ou devenues locales) sont effacées.
  if (git) {
    const kept = new Set(sources.filter((s) => s.kind === 'GIT').map((s) => s.id));
    await removeWorkdirs(
      git,
      project.dir,
      before.sources.filter((s) => s.kind === 'GIT' && !kept.has(s.id)).map((s) => s.id),
    );
  }
  return config;
}

/**
 * Les champs Git d'une source : pour une source GIT, l'adresse contrôlée (protocole, hôte autorisé, sans
 * identifiants), la branche, le commit et le nom de la variable du jeton ; pour une source locale, une
 * adresse facultative qui ne sert qu'aux liens « Voir sur Git » (aucune requête réseau).
 */
function gitFields(
  source: Record<string, unknown>,
  where: string,
  remote: boolean,
  git: GitPolicy | undefined,
): Pick<MapSource, 'repoUrl' | 'branch' | 'commit' | 'tokenEnv'> {
  const url = text(source.repoUrl, 500);
  if (!remote) {
    if (!url) return {};
    try {
      const parsed = parseRepoUrl(url, {
        allowedHosts: [new URL(url).hostname.toLowerCase()],
        protocols: ['https', 'http'],
      });
      return { repoUrl: parsed.url };
    } catch (error) {
      throw new CartographyInputError(400, 'INVALID_INPUT', `${where}.repoUrl: ${(error as Error).message}`);
    }
  }
  if (!url)
    throw new CartographyInputError(400, 'INVALID_INPUT', `${where}.repoUrl is required for a GIT source`);
  let repoUrl: string;
  try {
    repoUrl = parseRepoUrl(url, git).url;
  } catch (error) {
    throw new CartographyInputError(
      422,
      'SOURCE_DENIED',
      `${where}.repoUrl: ${error instanceof GitSourceError ? error.message : String(error)}`,
    );
  }
  const branch = text(source.branch, 200);
  if (branch && !isBranchName(branch))
    throw new CartographyInputError(400, 'INVALID_INPUT', `${where}.branch is not a valid branch name`);
  const commit = text(source.commit, 64)?.toLowerCase();
  if (commit && !isCommitId(commit))
    throw new CartographyInputError(
      400,
      'INVALID_INPUT',
      `${where}.commit must be a full commit identifier (40 hexadecimal characters)`,
    );
  const tokenEnv = text(source.tokenEnv, 100);
  if (tokenEnv && !(git?.envNames ?? /^QA_[A-Z0-9_]+$/).test(tokenEnv))
    throw new CartographyInputError(
      400,
      'INVALID_INPUT',
      `${where}.tokenEnv: the server does not read this variable (its name must match the allowed names)`,
    );
  return {
    repoUrl,
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
  };
}

/** Lancer un scan (incrémental par défaut) ; un seul à la fois par projet. */
export async function startScan(
  project: CartographyProject,
  allowedRoots: readonly string[],
  options: { incremental?: unknown },
  git?: GitPolicy,
  /** La résolution des contrats Maven (absente : désactivée). */
  maven?: MavenOptions,
): Promise<ScanRecord> {
  if (JOBS.has(project.dir))
    throw new CartographyInputError(409, 'SCAN_RUNNING', 'a scan is already running for this project');
  const config = await readConfig(project.dir);
  if (config.sources.filter((source) => source.enabled).length === 0)
    throw new CartographyInputError(409, 'NO_SOURCE', 'no enabled source is configured');
  if (allowedRoots.length === 0 && config.sources.some((source) => source.enabled && source.kind !== 'GIT'))
    throw new CartographyInputError(
      409,
      'NO_ALLOWED_ROOT',
      'the server allows no source folder (allowedSourceRoots)',
    );
  const incremental = options.incremental !== false;
  const [latest] = await listScans(project.dir);
  const previous = incremental && latest ? await readScan(project.dir, latest.id) : undefined;
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const job: Job = {
    controller,
    record: {
      id: 'pending',
      schema: 1,
      startedAt,
      state: 'RUNNING',
      incremental,
      sources: [],
      counts: {},
      edges: 0,
      errors: [],
    },
    done: Promise.resolve(),
  };
  JOBS.set(project.dir, job);
  job.done = (async () => {
    try {
      const result = await runScan({
        config,
        allowedRoots,
        incremental,
        ...(previous
          ? {
              previous: {
                facts: previous.facts,
                sources: previous.model.scan.sources,
                model: previous.model,
              },
            }
          : {}),
        signal: controller.signal,
        ...(maven ? { maven } : {}),
        ...(git
          ? {
              prepareGit: (source: MapSource, signal?: AbortSignal) =>
                prepareGitSource(source, project.dir, git, signal),
            }
          : {}),
        onProgress: (record) => {
          job.record = record;
        },
      });
      // Un scan annulé n'est pas gardé : il ne remplace jamais le dernier scan complet. L'état final n'est
      // annoncé qu'une fois le scan écrit : qui le lit « terminé » trouve aussi le scan enregistré.
      if (result.model.scan.state !== 'CANCELLED') await writeScan(project.dir, result);
      job.record = result.model.scan;
    } catch (error) {
      job.record = {
        ...job.record,
        state: 'FAILED',
        finishedAt: new Date().toISOString(),
        errors: [...job.record.errors, (error as Error).message],
      };
    } finally {
      JOBS.delete(project.dir);
      LAST.set(project.dir, job.record);
    }
  })();
  return job.record;
}

/** Le dernier état d'un scan terminé (annulé ou échoué compris), tant que le serveur tourne. */
const LAST = new Map<string, ScanRecord>();

export function runningScan(project: CartographyProject): ScanRecord | undefined {
  return JOBS.get(project.dir)?.record;
}

export function lastScanState(project: CartographyProject): ScanRecord | undefined {
  return JOBS.get(project.dir)?.record ?? LAST.get(project.dir);
}

/** Attendre la fin du scan en cours (tests, arrêt du serveur). */
export async function scanSettled(project: CartographyProject): Promise<void> {
  await JOBS.get(project.dir)?.done;
}

export function cancelScan(project: CartographyProject): boolean {
  const job = JOBS.get(project.dir);
  if (!job) return false;
  job.controller.abort();
  return true;
}

/** Les scénarios du projet tels qu'écrits (flows YAML), et la résolution des blocs `run:`. */
async function scenariosOf(project: CartographyProject): Promise<{
  scenarios: ScenarioInput[];
  resolve: (name: string) => ScenarioInput['flow'] | undefined;
}> {
  const [{ entries }, views] = await Promise.all([flowEntries(project.dir), listScenarios(project.dir)]);
  const revisions = new Map(views.map((view) => [`${view.file}\u0000${view.name}`, view.revision]));
  const scenarios: ScenarioInput[] = entries.map((entry) => {
    const revision = revisions.get(`${entry.relative}\u0000${entry.name}`);
    return { name: entry.name, file: entry.relative, ...(revision ? { revision } : {}), flow: entry.flow };
  });
  const byName = new Map(entries.map((entry) => [entry.name, entry.flow]));
  return { scenarios, resolve: (name) => byName.get(name) };
}

/** La dernière exécution de chaque scénario (parmi les 50 plus récentes), lue dans les résultats du moteur. */
async function lastRunsOf(project: CartographyProject, names: Set<string>): Promise<Map<string, LastRun>> {
  const reportsDir = path.join(project.dir, REPORTS_DIR);
  const records = (await listExecutions(project.id, reportsDir)).slice(0, 50);
  const found = new Map<string, LastRun>();
  for (const record of records) {
    if (found.size === names.size) break;
    const { flows } = await runDigest(project.id, reportsDir, record.run);
    const wanted = flows.filter((flow) => names.has(flow.name) && !found.has(flow.name));
    if (wanted.length === 0) continue;
    const detail = await executionDetail(project.id, reportsDir, record.run);
    for (const flow of wanted)
      found.set(flow.name, {
        run: record.run,
        at: record.createdAt,
        verdict: record.verdict,
        ...(detail?.flowsDetail.find((entry) => entry.name === flow.name)
          ? { flow: detail.flowsDetail.find((entry) => entry.name === flow.name) }
          : {}),
      });
  }
  return found;
}

/** La vue du tableau de bord : le scan demandé (sinon le dernier), décisions rejouées, couverture calculée. */
export async function cartographyView(
  project: CartographyProject,
  allowedRoots: readonly string[],
  scanId?: string,
): Promise<CartographyView> {
  const [config, decisions, scans] = await Promise.all([
    readConfig(project.dir),
    readDecisions(project.dir),
    listScans(project.dir),
  ]);
  const chosen = scanId ?? scans[0]?.id;
  const stored = chosen ? await readScan(project.dir, chosen) : undefined;
  if (scanId && !stored) throw new CartographyInputError(404, 'NOT_FOUND', 'scan not found');
  const running = runningScan(project);
  const base = {
    config,
    allowedRoots: [...allowedRoots],
    supported: SUPPORTED_TECHNOLOGIES,
    scans,
    ...(running ? { running } : {}),
    decisions,
  };
  if (!stored) {
    return {
      ...base,
      links: [],
      coverage: [],
      summary: {
        counts: { COVERED: 0, PARTIAL: 0, NOT_COVERED: 0, TO_CONFIRM: 0, OUT_OF_SCOPE: 0 },
        numerator: 0,
        denominator: 0,
        formula: 'non calculable : aucun scan',
      },
    };
  }
  const state = await stateOf(project, stored.model.scan.id, decisions, () => Promise.resolve(stored));
  const model = state.index.model;
  return {
    ...base,
    model: { ...model, issues: [...model.issues, ...state.cov.issues] },
    links: state.cov.links,
    coverage: [...state.cov.coverage.values()],
    summary: state.summary,
  };
}

const FEATURE_DECISIONS = new Set<DecisionKind>([
  'CONFIRM',
  'RENAME',
  'MERGE',
  'REJECT',
  'RESTORE',
  'OUT_OF_SCOPE',
  'IN_SCOPE',
]);
const LINK_DECISIONS = new Set<DecisionKind>([
  'LINK_SCENARIO',
  'VALIDATE_LINK',
  'REJECT_LINK',
  'UNLINK_SCENARIO',
]);

/** Une décision d'une personne : contrôlée contre le dernier scan, ajoutée à l'historique. */
export async function addDecision(
  project: CartographyProject,
  input: unknown,
  author: { by?: string },
  now = new Date(),
): Promise<MapDecision[]> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = DECISION_KINDS.find((candidate) => candidate === body.kind);
  if (!kind)
    throw new CartographyInputError(400, 'INVALID_INPUT', `kind must be one of ${DECISION_KINDS.join(', ')}`);
  const target = text(body.target);
  if (!target) throw new CartographyInputError(400, 'INVALID_INPUT', 'target is required');
  const value = text(body.value, kind === 'RENAME' || kind === 'RENAME_API' ? 120 : MAX_TEXT);
  const fieldLink = kind === 'LINK_FIELD' || kind === 'UNLINK_FIELD';
  if ((kind === 'RENAME' || kind === 'MERGE' || LINK_DECISIONS.has(kind) || fieldLink) && !value)
    throw new CartographyInputError(400, 'INVALID_INPUT', `value is required for ${kind}`);
  const pathKind = body.path === 'NEGATIVE' || body.path === 'POSITIVE' ? body.path : undefined;
  const note = text(body.note, 500);
  const [latest] = await listScans(project.dir);
  const stored = latest ? await readScan(project.dir, latest.id) : undefined;
  if (!stored) throw new CartographyInputError(409, 'NO_SCAN', 'no scan yet: nothing to decide on');
  const features = new Set(stored.model.features.map((feature) => feature.id));
  if ((FEATURE_DECISIONS.has(kind) || LINK_DECISIONS.has(kind)) && !features.has(target))
    throw new CartographyInputError(404, 'NOT_FOUND', `unknown feature ${target}`);
  if (kind === 'MERGE' && (!value || !features.has(value) || value === target))
    throw new CartographyInputError(
      400,
      'INVALID_INPUT',
      'MERGE needs another feature of the latest scan as value',
    );
  if (
    (kind === 'RENAME_API' || kind === 'CLASSIFY_API') &&
    !(stored.model.apis ?? []).some((api) => api.id === target)
  )
    throw new CartographyInputError(404, 'NOT_FOUND', `unknown API ${target}`);
  if (kind === 'RENAME_API' && !value)
    throw new CartographyInputError(
      400,
      'INVALID_INPUT',
      'value (the business name) is required for RENAME_API',
    );
  if (kind === 'CLASSIFY_API' && value !== 'INTERNAL' && value !== 'EXTERNAL')
    throw new CartographyInputError(400, 'INVALID_INPUT', 'CLASSIFY_API needs INTERNAL or EXTERNAL as value');
  if (kind === 'VALIDATE_CONCEPT' && !stored.model.concepts.some((concept) => concept.id === target))
    throw new CartographyInputError(404, 'NOT_FOUND', `unknown concept ${target}`);
  if (
    fieldLink &&
    !stored.model.nodes.some((n) => n.id === target && (n.kind === 'FIELD' || n.kind === 'COLUMN'))
  )
    throw new CartographyInputError(404, 'NOT_FOUND', `unknown field ${target}`);
  let revision: string | undefined;
  if (LINK_DECISIONS.has(kind) || fieldLink) {
    const scenario = (await listScenarios(project.dir)).find((entry) => entry.name === value);
    if (!scenario) throw new CartographyInputError(404, 'NOT_FOUND', `unknown scenario ${value ?? ''}`);
    revision = scenario.revision;
  }
  const decision: MapDecision = {
    id: `dec_${randomBytes(8).toString('base64url')}`,
    at: now.toISOString(),
    ...(author.by ? { by: author.by } : {}),
    kind,
    target,
    ...(value ? { value } : {}),
    ...(pathKind ? { path: pathKind } : {}),
    ...(revision ? { revision } : {}),
    ...(note ? { note } : {}),
  };
  return appendDecision(project.dir, decision);
}

/** L'impact entre deux scans gardés (par défaut : l'avant-dernier et le dernier). */
export async function impactOf(project: CartographyProject, input: unknown): Promise<ImpactReport> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const scans = await listScans(project.dir);
  const toId = text(body.to) ?? scans[0]?.id;
  const fromId =
    text(body.from) ??
    scans.find(
      (scan) => scan.id !== toId && scan.startedAt <= (scans.find((s) => s.id === toId)?.startedAt ?? ''),
    )?.id;
  if (!toId || !fromId)
    throw new CartographyInputError(409, 'NOT_ENOUGH_SCANS', 'two scans are needed to compare');
  const [from, to] = await Promise.all([readScan(project.dir, fromId), readScan(project.dir, toId)]);
  if (!from || !to) throw new CartographyInputError(404, 'NOT_FOUND', 'scan not found');
  const decisions = await readDecisions(project.dir);
  const decidedTo = applyDecisions(to.model, decisions);
  const { scenarios, resolve } = await scenariosOf(project);
  const links = applyLinkDecisions(proposeLinks(decidedTo, scenarios, resolve), decisions);
  return computeImpact(applyDecisions(from.model, decisions), decidedTo, links);
}

/** L'extrait de code d'une preuve : sous la source configurée, jamais un secret, 20 lignes autour. */
export async function evidenceExcerpt(
  project: CartographyProject,
  allowedRoots: readonly string[],
  query: {
    source?: string | null;
    file?: string | null;
    line?: string | null;
    revision?: string | null;
    scan?: string | null;
  },
  git?: GitPolicy,
): Promise<EvidenceExcerpt> {
  const config = await readConfig(project.dir);
  const source = config.sources.find((entry) => entry.id === query.source);
  if (!source) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown source');
  const file = query.file ?? '';
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !isReadableFile(file))
    throw new CartographyInputError(
      400,
      'INVALID_INPUT',
      'file must be a relative path to a readable source file',
    );
  const requested = query.revision?.trim().toLowerCase();
  if (requested && !isCommitId(requested))
    throw new CartographyInputError(400, 'INVALID_INPUT', 'revision must be a full commit identifier');
  // Le scan de la preuve (celui demandé, sinon le dernier) : sa révision, son dépôt, la couche.
  const scans = await listScans(project.dir);
  const record = (query.scan ? scans.find((s) => s.id === query.scan) : undefined) ?? scans[0];
  const scanned = record?.sources.find((s) => s.sourceId === source.id);
  const revision = requested ?? scanned?.revision;
  const repoFile = scanned?.repoPath ? `${scanned.repoPath}/${file}` : file;
  const gitUrl = gitFileUrl(
    scanned?.repoUrl ?? source.repoUrl,
    scanned?.provider ?? source.provider,
    revision,
    repoFile,
    Number.parseInt(query.line ?? '', 10) || undefined,
  );
  const context = {
    source: source.id,
    file,
    layer: source.layer,
    ...(record ? { scanId: record.id } : {}),
    ...(revision ? { revision } : {}),
    ...(gitUrl ? { gitUrl } : {}),
  };
  const unavailable = (reason: string): EvidenceExcerpt => ({
    ...context,
    line: Math.max(Number.parseInt(query.line ?? '1', 10) || 1, 1),
    start: 1,
    lines: [],
    unavailable: reason,
  });
  let content: string | undefined;
  let modified: string | undefined;
  if (source.kind === 'GIT') {
    // Une source distante se lit dans sa copie de travail, à la révision exacte du scan.
    if (!git) return unavailable('les sources Git distantes ne sont pas activées sur ce serveur');
    if (!revision) return unavailable('la révision analysée est inconnue');
    content = await gitShow(await workdirOf(git, project.dir, source.id), revision, file, git);
    if (content === undefined)
      return unavailable(
        `le fichier ou la révision ${revision.slice(0, 12)} n’est plus dans la copie de travail : relancez un scan`,
      );
  } else {
    let real: string;
    try {
      const root = await allowedPath(source.path, allowedRoots);
      real = await allowedPath(path.join(root, file), [root]);
    } catch (error) {
      if (error instanceof SourceAccessError && /does not exist/.test(error.message))
        return unavailable('le fichier n’existe plus dans le dossier de la source');
      throw new CartographyInputError(
        422,
        'SOURCE_DENIED',
        error instanceof SourceAccessError ? error.message : String(error),
      );
    }
    try {
      content = await readFile(real, 'utf8');
      modified = (await stat(real)).mtime.toISOString();
    } catch {
      return unavailable('le fichier n’est pas lisible');
    }
  }
  const all = content.split(/\r?\n/);
  const line = Math.min(Math.max(Number.parseInt(query.line ?? '1', 10) || 1, 1), all.length);
  const start = Math.max(1, line - 10);
  // Une preuve locale est périmée si le fichier a changé depuis le scan qui l'a relevée.
  const scannedAt = record?.finishedAt ?? record?.startedAt;
  return {
    ...context,
    line,
    start,
    lines: all.slice(start - 1, start + 19).map((entry) => entry.slice(0, 400)),
    ...(scannedAt && modified && modified > scannedAt
      ? {
          stale: `le fichier a été modifié le ${modified}, après le scan du ${scannedAt} : relancez un scan pour mettre la preuve à jour`,
        }
      : {}),
  };
}

export function cartographyError(error: unknown): CartographyInputError | undefined {
  if (error instanceof CartographyInputError) return error;
  if (error instanceof CartographyStoreError)
    return new CartographyInputError(409, 'STORE_ERROR', error.message);
  return undefined;
}

// ── Exploration progressive : index, cache et requêtes bornées ──────────────────────────────────────

interface ProgressiveState {
  index: MapIndex;
  cov: CoverageContext;
  summary: CoverageSummary;
  scenarios: ScenarioView[];
}

interface CacheEntry {
  indexKey: string;
  index: Promise<MapIndex>;
  covKey?: string;
  state?: Promise<ProgressiveState>;
}

/**
 * LE CACHE : l'index d'un scan (décisions rejouées) est construit une fois ; la couverture est recalculée
 * quand les scénarios ou les exécutions changent. Une requête concurrente attend le même calcul (aucun
 * double travail). Un nouveau scan, une décision, un scénario modifié ou une nouvelle exécution changent la
 * clé : l'ancien résultat n'est plus jamais servi.
 */
const CACHE = new Map<string, CacheEntry>();
const MAX_CACHE = 16;
const STATS = { hits: 0, misses: 0 };

export function cacheStats(): { hits: number; misses: number } {
  return { ...STATS };
}

async function stateOf(
  project: CartographyProject,
  scanId: string,
  decisions: readonly MapDecision[],
  load: () => Promise<StoredScan>,
): Promise<ProgressiveState> {
  const indexKey = `${scanId}|${String(decisions.length)}|${decisions.at(-1)?.id ?? ''}`;
  let entry = CACHE.get(project.dir);
  if (!entry || entry.indexKey !== indexKey) {
    STATS.misses += 1;
    // Le scan (modèle et faits) n'est relu que pour construire l'index : un index en cache le dispense.
    entry = {
      indexKey,
      index: load().then((stored) => buildIndex(applyDecisions(stored.model, decisions))),
    };
    // Une lecture en échec n'est pas gardée : la requête suivante la refait.
    const failed = entry;
    failed.index.catch(() => {
      if (CACHE.get(project.dir) === failed) CACHE.delete(project.dir);
    });
    CACHE.delete(project.dir);
    CACHE.set(project.dir, entry);
    while (CACHE.size > MAX_CACHE) {
      const oldest = CACHE.keys().next().value;
      if (oldest === undefined) break;
      CACHE.delete(oldest);
    }
  } else STATS.hits += 1;
  const current = entry;
  const views = await listScenarios(project.dir);
  const runs = (await listExecutions(project.id, path.join(project.dir, REPORTS_DIR))).slice(0, 50);
  const covKey = `${views.map((v) => `${v.file}:${v.name}:${v.revision ?? ''}`).join('|')}#${runs.map((r) => `${r.run}:${r.verdict}`).join('|')}`;
  if (current.covKey !== covKey || !current.state) {
    current.covKey = covKey;
    current.state = (async (): Promise<ProgressiveState> => {
      const index = await current.index;
      const { scenarios, resolve } = await scenariosOf(project);
      const links = applyLinkDecisions(proposeLinks(index.model, scenarios, resolve), decisions);
      const lastRuns = await lastRunsOf(
        project,
        new Set([
          ...links.map((link) => link.scenario),
          ...decisions.filter((d) => d.kind === 'LINK_FIELD' && d.value).map((d) => d.value ?? ''),
        ]),
      );
      const result = computeCoverage(index.model, links, lastRuns, decisions, scenarios, resolve);
      return {
        index,
        cov: {
          links,
          coverage: new Map(result.coverage.map((c) => [c.feature, c])),
          issues: result.issues,
          lastRuns,
          decisions,
        },
        summary: result.summary,
        scenarios: views,
      };
    })();
    // Un calcul en échec n'est pas gardé : la requête suivante le refait.
    current.state.catch(() => {
      if (CACHE.get(project.dir) === current) current.state = undefined;
    });
  }
  return current.state;
}

/** Le dernier scan (ou celui demandé) et son état progressif ; absent : aucun scan. */
async function progressive(
  project: CartographyProject,
  scanId?: string,
  known?: { scans: readonly ScanRecord[] },
): Promise<ProgressiveState | undefined> {
  const [decisions, scans] = await Promise.all([
    readDecisions(project.dir),
    known ? Promise.resolve(known.scans) : listScans(project.dir),
  ]);
  const chosen = scanId ?? scans[0]?.id;
  if (!chosen) return undefined;
  if (!scans.some((s) => s.id === chosen)) {
    if (scanId) throw new CartographyInputError(404, 'NOT_FOUND', 'scan not found');
    return undefined;
  }
  return stateOf(project, chosen, decisions, async () => {
    const stored = await readScan(project.dir, chosen);
    if (!stored) throw new CartographyInputError(404, 'NOT_FOUND', 'scan not found');
    return stored;
  });
}

async function required(project: CartographyProject, scanId?: string): Promise<ProgressiveState> {
  const state = await progressive(project, scanId);
  if (!state) throw new CartographyInputError(409, 'NO_SCAN', 'no scan yet');
  return state;
}

const number = (value: string | null | undefined): number | undefined => {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Les critères d'une liste, lus dans l'adresse (tout est borné par les requêtes elles-mêmes). */
export function listQuery(params: URLSearchParams): MapListQuery {
  const textOf = (key: string): string | undefined => {
    const value = params.get(key);
    return value && value.length <= 200 ? value : undefined;
  };
  const page = number(params.get('page'));
  const size = number(params.get('size'));
  return {
    ...(textOf('q') ? { q: textOf('q') } : {}),
    ...(textOf('module') ? { module: textOf('module') } : {}),
    ...(textOf('layer') ? { layer: textOf('layer') } : {}),
    ...(textOf('status') ? { status: textOf('status') } : {}),
    ...(textOf('coverage') ? { coverage: textOf('coverage') } : {}),
    ...(textOf('type') ? { type: textOf('type') } : {}),
    ...(params.get('concept') && (params.get('concept') ?? '').length <= 500
      ? { concept: params.get('concept') ?? '' }
      : {}),
    ...(textOf('scope') ? { scope: textOf('scope') } : {}),
    ...(textOf('sort') ? { sort: textOf('sort') } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

/** Les critères du tableau des relations d'une fonctionnalité ; une valeur inconnue est refusée (400). */
export function featureMapQuery(params: URLSearchParams): FeatureMapQuery {
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const value = params.get(key);
    if (value === null || value === '') return undefined;
    if (!(allowed as readonly string[]).includes(value))
      throw new CartographyInputError(400, 'BAD_QUERY', `unknown ${key}: ${value.slice(0, 40)}`);
    return value as T;
  };
  const category = pick('category', FEATURE_CATEGORIES);
  const lane = pick('lane', FEATURE_LANES);
  const status = pick('status', ['CONFIRMED', 'PROBABLE', 'UNKNOWN'] as const);
  const item = params.get('item');
  const q = params.get('q');
  const page = number(params.get('page'));
  const size = number(params.get('size'));
  return {
    ...(category ? { category } : {}),
    ...(lane ? { lane } : {}),
    ...(status ? { status } : {}),
    ...(item && item.length <= 500 ? { item } : {}),
    ...(q && q.length <= 200 ? { q } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

/** La carte d'une fonctionnalité (Parcours & Graphe) : couloirs, faisceaux comptés, lacunes, une page de relations. */
/** Les liens non résolus du dernier scan (page, critères, comptes). */
export async function mapUnresolved(
  project: CartographyProject,
  query: MapListQuery,
): Promise<UnresolvedPage> {
  const state = await required(project);
  return unresolvedOf(state.index, query);
}

export async function mapFeatureMap(
  project: CartographyProject,
  id: string,
  query: FeatureMapQuery,
): Promise<FeatureMap> {
  const state = await required(project);
  const result = featureMap(state.index, state.cov, id, query);
  if (!result) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown feature');
  return result;
}

/** Le résumé du premier affichage : aucun graphe, seulement des comptes et des listes courtes. */
export async function mapSummary(
  project: CartographyProject,
  allowedRoots: readonly string[],
  git?: Pick<GitPolicy, 'allowedHosts'>,
): Promise<MapSummary> {
  const [config, scans] = await Promise.all([readConfig(project.dir), listScans(project.dir)]);
  const running = runningScan(project);
  const state = await progressive(project, undefined, { scans });
  const scan = state?.index.model.scan;
  const index = state?.index;
  const concepts = index?.model.concepts ?? [];
  const features = (index?.features ?? []).filter((f) => f.status !== 'REJECTED');
  const links = state?.cov.links ?? [];
  const stats = cacheStats();
  return {
    config,
    allowedRoots: [...allowedRoots],
    ...(git ? { gitHosts: [...git.allowedHosts] } : {}),
    supported: SUPPORTED_TECHNOLOGIES,
    scans,
    ...(running ? { running } : {}),
    ...(scan ? { scan } : {}),
    stale: Boolean(scan && config.updatedAt && config.updatedAt > (scan.finishedAt ?? scan.startedAt)),
    kpis: {
      features: features.length,
      scenarios: new Set(links.filter((l) => l.status !== 'REJECTED').map((l) => l.scenario)).size,
      fields: index?.fieldCount ?? 0,
      reuse: concepts.filter((c) => c.features.length > 1).length,
      toValidate:
        features.filter((f) => f.status === 'CANDIDATE').length +
        links.filter((l) => l.status === 'PROPOSED').length,
    },
    coverage: state?.summary ?? {
      counts: { COVERED: 0, PARTIAL: 0, NOT_COVERED: 0, TO_CONFIRM: 0, OUT_OF_SCOPE: 0 },
      numerator: 0,
      denominator: 0,
      formula: 'non calculable : aucun scan',
    },
    modules: [...new Set(features.map((f) => f.module).filter((m): m is string => Boolean(m)))].sort(),
    topReuse: concepts
      .filter((c) => c.features.length > 1)
      .sort((a, b) => b.features.length - a.features.length || a.name.localeCompare(b.name))
      .slice(0, 6)
      .map((c) => ({ concept: c.id, name: c.name, features: c.features.length, layers: c.layers })),
    reuseByFeature: features
      .map((f) => ({
        feature: f.id,
        name: f.name,
        concepts: (index?.featureConcepts.get(f.id) ?? []).filter((c) => c.features.length > 1).length,
      }))
      .filter((r) => r.concepts > 0)
      .sort((a, b) => b.concepts - a.concepts || a.name.localeCompare(b.name))
      .slice(0, 6),
    traceability: {
      fieldsLayers: (index?.model.edges ?? []).some((e) => e.kind === 'TRANSFORMS' || e.kind === 'SENDS'),
      featureScenarios: links.some((l) => l.status !== 'REJECTED'),
      impact: scans.length > 1,
    },
    issues: (index?.model.issues.length ?? 0) + (state?.cov.issues.length ?? 0),
    performance: {
      indexedNodes: index?.nodes.size ?? 0,
      indexedFields: index?.fieldCount ?? 0,
      indexedEdges: index?.model.edges.length ?? 0,
      mergedEvidence: index?.mergedEvidence ?? 0,
      ...(index ? { indexBuildMs: index.buildMs } : {}),
      cache: stats,
      ...(scan ? { scanAt: scan.finishedAt ?? scan.startedAt } : {}),
    },
  };
}

export async function mapFeatures(
  project: CartographyProject,
  query: MapListQuery,
): Promise<MapPage<FeatureRow>> {
  const state = await progressive(project);
  if (!state) return { items: [], total: 0, page: 1, size: query.size ?? 20 };
  return queryFeatures(state.index, state.cov, query);
}

export async function mapFeature(project: CartographyProject, id: string): Promise<FeatureDetail> {
  const state = await required(project);
  const detail = featureDetail(state.index, state.cov, id);
  if (!detail) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown feature');
  return detail;
}

export async function mapFeatureFields(
  project: CartographyProject,
  id: string,
  query: MapListQuery,
): Promise<MapPage<FieldRow>> {
  const state = await required(project);
  const page = featureFields(state.index, state.cov, id, query);
  if (!page) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown feature');
  return page;
}

export async function mapField(
  project: CartographyProject,
  id: string,
  options: { feature?: string; depth?: number; limit?: number },
): Promise<FieldSheet> {
  const state = await required(project);
  const sheet = fieldSheet(state.index, state.cov, id, options);
  if (!sheet) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown field');
  return sheet;
}

export async function mapNeighbours(
  project: CartographyProject,
  id: string,
  options: { depth?: number; limit?: number },
): Promise<MapSubgraph> {
  const state = await required(project);
  const graph = neighbours(state.index, id, options);
  if (!graph) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown node');
  return graph;
}

export async function mapConcepts(
  project: CartographyProject,
  query: MapListQuery,
): Promise<MapPage<ConceptRow>> {
  const state = await progressive(project);
  if (!state) return { items: [], total: 0, page: 1, size: query.size ?? 20 };
  return queryConcepts(state.index, state.cov, query);
}

export async function mapIssues(
  project: CartographyProject,
  query: MapListQuery,
): Promise<MapPage<FieldIssue>> {
  const state = await progressive(project);
  if (!state) return { items: [], total: 0, page: 1, size: query.size ?? 20 };
  return queryIssues(state.index, state.cov, query);
}

/** Le catalogue des API et services : une page, ses comptes et ses indicateurs (jamais tout le graphe). */
export async function mapApis(project: CartographyProject, query: MapListQuery): Promise<ApiCatalog> {
  const state = await progressive(project);
  if (!state)
    return {
      items: [],
      total: 0,
      page: 1,
      size: query.size ?? 20,
      available: false,
      counts: { all: 0, internal: 0, external: 0, unclassified: 0 },
      kpis: { apis: 0, internal: 0, external: 0, endpoints: 0, features: 0, scenarios: 0 },
    };
  return queryApis(state.index, state.cov, query);
}

export async function mapApi(project: CartographyProject, id: string): Promise<ApiSheet> {
  const state = await required(project);
  const sheet = apiSheet(state.index, state.cov, id);
  if (!sheet) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown API');
  return sheet;
}

/** La structure d'une fonctionnalité (ou du projet) : écrans, composants, conteneurs, champs, boutons. */
export async function mapStructure(project: CartographyProject, feature?: string): Promise<MapStructure> {
  const state = await progressive(project);
  if (!state)
    return {
      roots: [],
      kpis: {
        pages: 0,
        containers: 0,
        fields: 0,
        buttons: 0,
        internalApis: 0,
        externalApis: 0,
        conditions: 0,
      },
    };
  const structure = structureOf(state.index, feature || undefined);
  if (!structure) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown feature');
  return structure;
}

export async function mapElement(project: CartographyProject, id: string): Promise<ElementSheet> {
  const state = await required(project);
  const sheet = elementSheet(state.index, state.cov, id);
  if (!sheet) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown element');
  return sheet;
}

/** Les critères d'un parcours lus dans la requête : sens, couches et relations connus, sinon refusés. */
export function traceOptions(params: URLSearchParams): {
  direction?: TraceDirection;
  layers?: MapLayer[];
  kinds?: MapEdgeKind[];
} {
  const list = (key: string): string[] =>
    (params.get(key) ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const direction = params.get('direction') ?? undefined;
  if (direction !== undefined && !(TRACE_DIRECTIONS as readonly string[]).includes(direction))
    throw new CartographyInputError(400, 'INVALID_DIRECTION', 'direction must be UP, DOWN or BOTH');
  const layers = list('layers');
  if (layers.some((l) => !(MAP_LAYERS as readonly string[]).includes(l)))
    throw new CartographyInputError(400, 'INVALID_LAYER', 'unknown layer');
  const kinds = list('kinds');
  if (kinds.some((k) => !(MAP_EDGE_KINDS as readonly string[]).includes(k)))
    throw new CartographyInputError(400, 'INVALID_KIND', 'unknown relation kind');
  return {
    ...(direction ? { direction: direction as TraceDirection } : {}),
    ...(layers.length ? { layers: layers as MapLayer[] } : {}),
    ...(kinds.length ? { kinds: kinds as MapEdgeKind[] } : {}),
  };
}

/** Le parcours d'un élément vers l'amont, l'aval ou les deux, borné, avec sa frontière et ses ruptures. */
export async function mapTrace(
  project: CartographyProject,
  id: string,
  options: Parameters<typeof traceOf>[2] = {},
): Promise<MapTrace> {
  const state = await required(project);
  const trace = traceOf(state.index, id, options);
  if (!trace) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown element');
  return trace;
}

// ── Investigations ──────────────────────────────────────────────────────────────────────────────

const BUDGET_KEYS = ['nodes', 'perBranch', 'perNature', 'depth', 'fanOut', 'timeMs'] as const;

/** Le budget demandé : des nombres connus seulement (le moteur les borne). */
function budgetOf(raw: unknown): Partial<InvestigationBudget> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new CartographyInputError(400, 'INVALID_BUDGET', 'budget must be an object');
  const out: Partial<InvestigationBudget> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      !(BUDGET_KEYS as readonly string[]).includes(key) ||
      typeof value !== 'number' ||
      !Number.isFinite(value)
    )
      throw new CartographyInputError(400, 'INVALID_BUDGET', `unknown or invalid budget entry ${key}`);
    out[key as keyof InvestigationBudget] = value;
  }
  return out;
}

/** La demande d'investigation, vérifiée : élément, objectif, sens, mode et budget connus, sinon refusée. */
export function investigationRequest(raw: unknown): InvestigationRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new CartographyInputError(400, 'INVALID_REQUEST', 'body must be an object');
  const body = raw as Record<string, unknown>;
  if (typeof body.start !== 'string' || !body.start || body.start.length > 2_000)
    throw new CartographyInputError(400, 'INVALID_START', 'start must be an element id');
  if (body.goal !== undefined && !(INVESTIGATION_GOALS as readonly unknown[]).includes(body.goal))
    throw new CartographyInputError(400, 'INVALID_GOAL', 'unknown goal');
  if (body.direction !== undefined && !(TRACE_DIRECTIONS as readonly unknown[]).includes(body.direction))
    throw new CartographyInputError(400, 'INVALID_DIRECTION', 'direction must be UP, DOWN or BOTH');
  if (body.mode !== undefined && body.mode !== 'FOCUSED' && body.mode !== 'EXHAUSTIVE')
    throw new CartographyInputError(400, 'INVALID_MODE', 'mode must be FOCUSED or EXHAUSTIVE');
  const budget = budgetOf(body.budget);
  return {
    start: body.start,
    ...(body.goal ? { goal: body.goal as InvestigationRequest['goal'] } : {}),
    ...(body.direction ? { direction: body.direction as TraceDirection } : {}),
    ...(body.mode ? { mode: body.mode } : {}),
    ...(budget ? { budget } : {}),
  };
}

const newInvestigationId = (): string => `inv-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/** Une investigation lue : périmée (STALE) si le dernier scan n'est plus celui sur lequel elle a été menée. */
async function withFreshness(project: CartographyProject, inv: Investigation): Promise<Investigation> {
  const latest = (await listScans(project.dir))[0]?.id;
  return latest && latest !== inv.scanId ? { ...inv, state: 'STALE' } : inv;
}

export async function startInvestigation(project: CartographyProject, raw: unknown): Promise<Investigation> {
  const request = investigationRequest(raw);
  const state = await required(project);
  const inv = investigate(state.index, request, { id: newInvestigationId() });
  if (!inv) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown element');
  await writeInvestigation(project.dir, inv);
  return inv;
}

export async function mapInvestigations(project: CartographyProject): Promise<InvestigationSummary[]> {
  const latest = (await listScans(project.dir))[0]?.id;
  const state = await progressive(project);
  return (await listInvestigations(project.dir)).map((inv) => ({
    id: inv.id,
    scanId: inv.scanId,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    state: latest && latest !== inv.scanId ? 'STALE' : inv.state,
    start: inv.request.start,
    startName:
      state?.index.nodes.get(inv.request.start)?.name ??
      inv.nodes.find((n) => n.id === inv.request.start)?.name ??
      inv.request.start,
    goal: inv.request.goal,
    direction: inv.request.direction,
    paths: inv.paths.length,
    breaks: inv.breaks.length,
  }));
}

async function storedInvestigation(project: CartographyProject, id: string): Promise<Investigation> {
  const inv = await readInvestigation(project.dir, id);
  if (!inv) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown investigation');
  return inv;
}

export async function mapInvestigation(project: CartographyProject, id: string): Promise<Investigation> {
  return withFreshness(project, await storedInvestigation(project, id));
}

/** « Explorer cette branche » : reprise ciblée depuis un nœud de la frontière, sur le même scan seulement. */
export async function expandInvestigationOf(
  project: CartographyProject,
  id: string,
  raw: unknown,
): Promise<Investigation> {
  const previous = await storedInvestigation(project, id);
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof body.node !== 'string' || !body.node)
    throw new CartographyInputError(400, 'INVALID_NODE', 'node must be a frontier element id');
  const state = await required(project);
  try {
    const next = expandInvestigation(state.index, previous, body.node, budgetOf(body.budget));
    if (!next) throw new CartographyInputError(404, 'NOT_IN_FRONTIER', 'this element is not on the frontier');
    await writeInvestigation(project.dir, next);
    return next;
  } catch (error) {
    if (error instanceof InvestigationStaleError)
      throw new CartographyInputError(
        409,
        'STALE',
        'the scan changed since this investigation: run it again',
      );
    throw error;
  }
}

/** Relancer sur le dernier scan : une nouvelle investigation, reliée à la précédente. */
export async function rerunInvestigation(project: CartographyProject, id: string): Promise<Investigation> {
  const previous = await storedInvestigation(project, id);
  const state = await required(project);
  const inv = investigate(state.index, previous.request, { id: newInvestigationId(), previous: previous.id });
  if (!inv)
    throw new CartographyInputError(404, 'NOT_FOUND', 'the starting element is no longer in the scan');
  await writeInvestigation(project.dir, inv);
  return inv;
}

export async function mapConditions(
  project: CartographyProject,
  query: MapListQuery,
): Promise<MapPage<ConditionRow>> {
  const state = await progressive(project);
  return state ? conditionRows(state.index, query) : { items: [], total: 0, page: 1, size: query.size ?? 25 };
}

export async function mapActions(
  project: CartographyProject,
  query: MapListQuery,
): Promise<MapPage<ActionRow>> {
  const state = await progressive(project);
  return state ? actionRows(state.index, query) : { items: [], total: 0, page: 1, size: query.size ?? 25 };
}

export { number as queryNumber };
