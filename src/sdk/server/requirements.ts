import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult } from '../../model/exploration-result.js';
import type { ClassifyOptions } from '../../requirements/classify.js';
import type { ConnectorDescription, SourceConnector } from '../../requirements/connector.js';
import { ConfluenceConnector, type ConfluenceInput } from '../../requirements/connectors/confluence.js';
import { ExcelConnector } from '../../requirements/connectors/excel.js';
import type { FileInput } from '../../requirements/connectors/files.js';
import { PdfConnector } from '../../requirements/connectors/pdf.js';
import { WordConnector } from '../../requirements/connectors/word.js';
import type {
  CanonicalEntity,
  ImportBatch,
  ImportProfile,
  LinkType,
  RequirementsRepository,
  TraceabilityLink,
} from '../../requirements/model.js';
import { importSource } from '../../requirements/pipeline.js';
import { RequirementsStore } from '../../requirements/repository.js';
import type {
  ImportSummary,
  MatrixLinkCell,
  MatrixRow,
  Ratio,
  RequirementConnectorView,
  RequirementsIndicators,
  Severity,
  TrendsView,
  TrendWeek,
} from '../core/contracts.js';
import { ENV_NAME_PATTERN, SEVERITIES } from '../core/contracts.js';
import type * as Wire from '../core/requirements-contracts.js';
import { listExecutions, scenarioHistory } from './platform.js';

/**
 * LES EXIGENCES, côté serveur : le référentiel d'un projet (`<projet>/requirements/`), ses imports, la
 * matrice de traçabilité, les indicateurs et les tendances. Le pipeline (src/requirements) décide de
 * tout ce qui touche au référentiel ; ce module ne fait que le brancher sur l'API et compter.
 *
 * Rien n'est estimé : un indicateur qui demande la corrélation automatique (phase 5) est rendu
 * indisponible ; une semaine sans donnée n'a pas de valeur.
 */
/**
 * Le côté navigateur du SDK n'importe pas le modèle : il décrit les mêmes données dans
 * core/requirements-contracts.ts. Ce contrôle, à la compilation, garantit que le modèle leur reste
 * assignable (un champ renommé ou retiré d'un côté fait échouer `tsc`).
 */
type Assignable<From extends To, To> = [From, To];
export type WireCheck = [
  Assignable<ImportBatch, Wire.ImportBatch>,
  Assignable<CanonicalEntity, Wire.CanonicalEntity>,
  Assignable<TraceabilityLink, Wire.TraceabilityLink>,
  Assignable<ImportProfile, Wire.ImportProfile>,
  Assignable<ConnectorDescription, Wire.ConnectorDescription>,
];

export const REQUIREMENTS_DIR = 'requirements';
export const FILE_CONNECTORS = ['WORD', 'EXCEL', 'PDF'] as const;
export type FileConnectorKind = (typeof FILE_CONNECTORS)[number];

export function storeOf(projectDir: string): RequirementsStore {
  return new RequirementsStore(path.join(projectDir, REQUIREMENTS_DIR));
}

const CONNECTORS = {
  CONFLUENCE: new ConfluenceConnector(),
  WORD: new WordConnector(),
  EXCEL: new ExcelConnector(),
  PDF: new PdfConnector(),
};

/** La plus grande entrée acceptée par un connecteur de fichier (le corps d'un envoi est borné par elle). */
export function maxFileBytes(kind: FileConnectorKind): number {
  return CONNECTORS[kind].describe().maxBytes;
}

export function connectorViews(): RequirementConnectorView[] {
  return [
    { ...CONNECTORS.CONFLUENCE.describe(), transport: 'CONFLUENCE' },
    ...FILE_CONNECTORS.map((kind) => ({ ...CONNECTORS[kind].describe(), transport: 'FILE' as const })),
  ];
}

/** Une entrée refusée avant tout accès à la source. */
export class RequirementsInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequirementsInputError';
  }
}

const toDecide = (item: ImportBatch['items'][number]): boolean =>
  item.kind !== 'INFORMATION' && item.duplicate.status !== 'UNCHANGED' && !item.published && !item.decision;

export function summaryOf(batch: ImportBatch): ImportSummary {
  const byDuplicate: ImportSummary['byDuplicate'] = {};
  for (const item of batch.items)
    if (item.kind !== 'INFORMATION')
      byDuplicate[item.duplicate.status] = (byDuplicate[item.duplicate.status] ?? 0) + 1;
  const problems = batch.issues.filter((issue) => issue.severity !== 'INFO');
  const first = problems.find((issue) => issue.severity === 'ERROR') ?? problems[0];
  return {
    id: batch.id,
    connector: batch.connector,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    source: {
      title: batch.source.title,
      ...(batch.source.uri ? { uri: batch.source.uri } : {}),
      ...(batch.source.version ? { version: batch.source.version } : {}),
    },
    completeness: batch.completeness,
    candidates: batch.items.filter((item) => item.kind !== 'INFORMATION').length,
    toDecide: batch.items.filter(toDecide).length,
    decided: batch.items.filter((item) => item.decision && !item.published).length,
    published: batch.items.filter((item) => item.published).length,
    byDuplicate,
    issues: {
      errors: batch.issues.filter((issue) => issue.severity === 'ERROR').length,
      warnings: batch.issues.filter((issue) => issue.severity === 'WARNING').length,
      ...(first ? { first: first.message } : {}),
    },
    missingFromSource: batch.missingFromSource.length,
  };
}

/** Les candidats qui attendent une décision, tous lots confondus. */
export async function pendingCandidates(store: RequirementsStore): Promise<number> {
  return (await store.listBatches()).reduce((sum, batch) => sum + batch.items.filter(toDecide).length, 0);
}

/** Le profil d'importation nommé : sa normalisation et les réglages du connecteur. */
async function profileOf(
  store: RequirementsStore,
  name: string | undefined,
  kind: string,
): Promise<{ classify?: ClassifyOptions; options: Record<string, unknown> }> {
  if (!name) return { options: {} };
  let profile;
  try {
    profile = await store.readProfile(name);
  } catch (error) {
    throw new RequirementsInputError(
      'INVALID_PROFILE',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!profile) throw new RequirementsInputError('PROFILE_NOT_FOUND', `import profile ${name} not found`);
  if (profile.connector !== kind)
    throw new RequirementsInputError(
      'PROFILE_MISMATCH',
      `import profile ${name} is for ${profile.connector}, not ${kind}`,
    );
  return { classify: profile.classify, options: profile.options };
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw new RequirementsInputError('INVALID_INPUT', `${field} is required`);
  return value.trim();
};

/** Lire une page Confluence : les identifiants sont des NOMS de variables, lues par le serveur seul. */
export async function importConfluence(
  store: RequirementsStore,
  body: Record<string, unknown>,
  options: { env: NodeJS.ProcessEnv; envNames: RegExp; now: Date },
): Promise<ImportBatch> {
  const auth = (body.auth ?? {}) as Record<string, unknown>;
  const names = [text(auth.tokenEnv, 'auth.tokenEnv')];
  if (auth.userEnv !== undefined && auth.userEnv !== '') names.push(text(auth.userEnv, 'auth.userEnv'));
  for (const name of names)
    if (!ENV_NAME_PATTERN.test(name) || !options.envNames.test(name))
      throw new RequirementsInputError('ENV_NAME_REFUSED', `the server does not read the variable ${name}`);
  const variant = body.variant;
  if (variant !== undefined && variant !== 'cloud' && variant !== 'datacenter')
    throw new RequirementsInputError('INVALID_INPUT', 'variant must be cloud or datacenter');
  const profileName = typeof body.profile === 'string' && body.profile ? body.profile : undefined;
  const profile = await profileOf(store, profileName, 'CONFLUENCE');
  const input: ConfluenceInput = {
    baseUrl: text(body.baseUrl, 'baseUrl'),
    page: text(body.page, 'page'),
    ...(variant ? { variant } : {}),
    auth: { tokenEnv: names[0] ?? '', ...(names[1] ? { userEnv: names[1] } : {}) },
  };
  return importSource(
    store,
    CONNECTORS.CONFLUENCE,
    input,
    { now: options.now, env: options.env },
    profile.classify ? { classify: profile.classify } : {},
  );
}

const FILE_NAME = /^[^/\\\0]{1,200}$/;

/** Lire un fichier envoyé (contenu en mémoire ; rien n'est écrit sur le disque). */
export async function importFile(
  store: RequirementsStore,
  kind: FileConnectorKind,
  name: string,
  data: Uint8Array,
  options: { profile?: string; env: NodeJS.ProcessEnv; now: Date },
): Promise<ImportBatch> {
  if (!FILE_NAME.test(name)) throw new RequirementsInputError('INVALID_INPUT', 'invalid file name');
  const profile = await profileOf(store, options.profile, kind);
  const input = { ...profile.options, data, name } as FileInput;
  return importSource(
    store,
    CONNECTORS[kind] as SourceConnector<FileInput>,
    input,
    { now: options.now, env: options.env },
    profile.classify ? { classify: profile.classify } : {},
  );
}

// ── Matrice de traçabilité ─────────────────────────────────────────────────────────────────────

const TEST_LINKS: readonly LinkType[] = ['TESTED_BY', 'VERIFIED_BY'];

function cellOf(link: TraceabilityLink, entityId: string, labels: Map<string, string>): MatrixLinkCell {
  const target = link.from.id === entityId ? link.to : link.from;
  const label = labels.get(target.id);
  return {
    linkId: link.id,
    type: link.type,
    target,
    ...(label ? { label } : {}),
    validation: link.validation,
    freshness: link.freshness,
    confidence: link.confidence,
  };
}

const touches = (link: TraceabilityLink, id: string): boolean => link.from.id === id || link.to.id === id;

export function matrixOf(repository: Pick<RequirementsRepository, 'entities' | 'links'>): MatrixRow[] {
  const labels = new Map(
    repository.entities.flatMap((entity) =>
      entity.externalId ? [[entity.id, entity.externalId] as const] : [],
    ),
  );
  return repository.entities.map((entity) => {
    const links = repository.links.filter((link) => touches(link, entity.id));
    const children = links.filter(
      (link) => (link.type === 'HAS_RULE' || link.type === 'HAS_CRITERION') && link.from.id === entity.id,
    );
    const implemented = links.filter((link) => link.type === 'IMPLEMENTED_BY');
    const verified = links.filter((link) => TEST_LINKS.includes(link.type));
    const other = links.filter(
      (link) => !children.includes(link) && !implemented.includes(link) && !verified.includes(link),
    );
    return {
      id: entity.id,
      ...(entity.externalId ? { externalId: entity.externalId } : {}),
      kind: entity.kind,
      title: entity.title,
      version: entity.version,
      sources: [...new Set(entity.sources.map((source) => source.kind))],
      children: children.map((link) => cellOf(link, entity.id, labels)),
      implementedBy: implemented.map((link) => cellOf(link, entity.id, labels)),
      verifiedBy: verified.map((link) => cellOf(link, entity.id, labels)),
      other: other.map((link) => cellOf(link, entity.id, labels)),
    };
  });
}

/** Une cellule CSV : entre guillemets, et jamais lue comme une formule par un tableur. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

const cellsText = (cells: MatrixLinkCell[]): string =>
  cells
    .map(
      (cell) =>
        `${cell.target.kind}:${cell.label ? `${cell.label} [${cell.target.id}]` : cell.target.id} (${cell.validation})`,
    )
    .join('; ');

export function matrixCsv(rows: MatrixRow[]): string {
  const header = [
    'id',
    'external_id',
    'kind',
    'title',
    'version',
    'sources',
    'children',
    'implemented_by',
    'verified_by',
    'other',
  ];
  const lines = rows.map((row) =>
    [
      row.id,
      row.externalId ?? '',
      row.kind,
      row.title,
      String(row.version),
      row.sources.join(' '),
      cellsText(row.children),
      cellsText(row.implementedBy),
      cellsText(row.verifiedBy),
      cellsText(row.other),
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
}

// ── Indicateurs ────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const ratio = (numerator: number, denominator: number): Ratio => ({
  numerator,
  denominator,
  ...(denominator > 0 ? { value: numerator / denominator } : {}),
});

const covered = (repository: Pick<RequirementsRepository, 'links'>, entity: CanonicalEntity): boolean =>
  repository.links.some(
    (link) => TEST_LINKS.includes(link.type) && link.validation === 'CONFIRMED' && touches(link, entity.id),
  );

export async function computeIndicators(
  repository: Pick<RequirementsRepository, 'entities' | 'links'>,
  batches: ImportBatch[],
  reportsDir: string,
  projectId: string,
  options: { days: number; now?: Date },
): Promise<RequirementsIndicators> {
  const now = options.now ?? new Date();
  const days = Math.min(Math.max(Math.trunc(options.days) || 30, 1), 365);
  const from = new Date(now.getTime() - days * DAY_MS);
  const entities = repository.entities;
  const live = repository.links.filter((link) => link.validation !== 'REJECTED');
  const coveredCount = entities.filter((entity) => covered(repository, entity)).length;
  const proposedOnly = entities.filter(
    (entity) =>
      !covered(repository, entity) &&
      live.some((link) => TEST_LINKS.includes(link.type) && touches(link, entity.id)),
  ).length;

  let finished = 0;
  let passed = 0;
  let cancelled = 0;
  let withoutVerdict = 0;
  for (const execution of await listExecutions(projectId, reportsDir)) {
    const at = Date.parse(execution.createdAt);
    if (execution.kind !== 'REPLAY' || !Number.isFinite(at) || at < from.getTime() || at > now.getTime())
      continue;
    if (execution.verdict === 'PASSED' || execution.verdict === 'FAILED') {
      finished += 1;
      if (execution.verdict === 'PASSED') passed += 1;
    } else if (execution.verdict === 'CANCELLED') cancelled += 1;
    else withoutVerdict += 1;
  }

  const confirmed = live.filter((link) => link.validation === 'CONFIRMED').length;
  const stale = live.filter((link) => link.freshness === 'POSSIBLY_STALE').length;
  return {
    generatedAt: now.toISOString(),
    period: { days, from: from.toISOString(), to: now.toISOString() },
    published: {
      total: entities.length,
      requirements: entities.filter((entity) => entity.kind === 'REQUIREMENT').length,
      rules: entities.filter((entity) => entity.kind === 'BUSINESS_RULE').length,
      criteria: entities.filter((entity) => entity.kind === 'ACCEPTANCE_CRITERION').length,
    },
    coverage: { ...ratio(coveredCount, entities.length), proposedOnly },
    recentEvidence: { available: false, reason: 'CORRELATION_NOT_AVAILABLE' },
    replays: { ...ratio(passed, finished), cancelled, withoutVerdict },
    links: {
      ...ratio(confirmed, live.length),
      confirmed,
      proposed: live.filter((link) => link.validation === 'PROPOSED').length,
      possiblyStale: stale,
      rejected: repository.links.length - live.length,
    },
    gaps: {
      withoutImplementation: entities.filter(
        (entity) => !live.some((link) => link.type === 'IMPLEMENTED_BY' && touches(link, entity.id)),
      ).length,
      withoutTest: entities.filter(
        (entity) => !live.some((link) => TEST_LINKS.includes(link.type) && touches(link, entity.id)),
      ).length,
      staleLinks: stale,
      pendingCandidates: batches.reduce((sum, batch) => sum + batch.items.filter(toDecide).length, 0),
    },
  };
}

// ── Tendances ──────────────────────────────────────────────────────────────────────────────────

/** Le lundi 00:00 UTC de la semaine ISO d'une date. */
function mondayOf(date: Date): Date {
  const day = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
}

/** L'année et le numéro de semaine ISO (2026-W43). */
export function isoWeek(date: Date): string {
  const thursday = new Date(mondayOf(date).getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = mondayOf(new Date(Date.UTC(year, 0, 4))).getTime() + 3 * DAY_MS;
  const week = 1 + Math.round((thursday.getTime() - firstThursday) / (7 * DAY_MS));
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}

/** Un lien de test était-il confirmé à cet instant ? Les décisions sont rejouées dans l'ordre. */
function confirmedAt(link: TraceabilityLink, at: number): boolean {
  let state = false;
  for (const decision of [...link.decisions].sort((a, b) => a.at.localeCompare(b.at))) {
    if (Date.parse(decision.at) > at) break;
    if (decision.action === 'CONFIRM' || decision.action === 'ADD') state = true;
    else if (decision.action === 'REJECT') state = false;
  }
  return state;
}

/** La couverture à un instant : éléments publiés à cette date, et ceux qu'un lien de test confirmé couvrait. */
export function coverageAt(
  repository: Pick<RequirementsRepository, 'entities' | 'links'>,
  at: number,
): Ratio | undefined {
  const entities = repository.entities.filter((entity) => Date.parse(entity.createdAt) <= at);
  if (entities.length === 0) return undefined;
  const count = entities.filter((entity) =>
    repository.links.some(
      (link) => TEST_LINKS.includes(link.type) && touches(link, entity.id) && confirmedAt(link, at),
    ),
  ).length;
  return ratio(count, entities.length);
}

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

async function issuesOf(reportsDir: string, run: string): Promise<Partial<Record<Severity, number>>> {
  try {
    const result = JSON.parse(
      await readFile(path.join(reportsDir, run, 'result.json'), 'utf8'),
    ) as ExplorationResult;
    return result.stats.issuesBySeverity;
  } catch {
    return {};
  }
}

export interface TrendProject {
  id: string;
  name: string;
  reportsDir: string;
  repository?: Pick<RequirementsRepository, 'entities' | 'links'>;
}

export async function computeTrends(
  projects: readonly TrendProject[],
  options: { weeks: number; now?: Date; projectId?: string },
): Promise<TrendsView> {
  const now = options.now ?? new Date();
  const count = Math.min(Math.max(Math.trunc(options.weeks) || 8, 1), 52);
  const current = mondayOf(now).getTime();
  const weeks = Array.from({ length: count }, (_, index) => {
    const start = current - (count - 1 - index) * 7 * DAY_MS;
    const end = Math.min(start + 7 * DAY_MS, now.getTime());
    return {
      start,
      end,
      passed: 0,
      finished: 0,
      durations: [] as number[],
      issues: Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>,
    };
  });
  const unstable: TrendsView['unstable'] = [];
  for (const project of projects) {
    for (const execution of await listExecutions(project.id, project.reportsDir)) {
      const at = Date.parse(execution.createdAt);
      const week = weeks.find(
        (entry) => at >= entry.start && at < entry.start + 7 * DAY_MS && at <= now.getTime(),
      );
      if (!week) continue;
      const bySeverity = await issuesOf(project.reportsDir, execution.run);
      for (const severity of SEVERITIES) week.issues[severity] += bySeverity[severity] ?? 0;
      if (execution.kind === 'REPLAY' && (execution.verdict === 'PASSED' || execution.verdict === 'FAILED')) {
        week.finished += 1;
        if (execution.verdict === 'PASSED') week.passed += 1;
        if (execution.durationMs !== undefined) week.durations.push(execution.durationMs);
      }
    }
    for (const scenario of await scenarioHistory(project.id, project.reportsDir, 10))
      if (scenario.flips > 0)
        unstable.push({
          projectId: project.id,
          projectName: project.name,
          name: scenario.name,
          flips: scenario.flips,
          runs: scenario.runs.length,
        });
  }
  unstable.sort((a, b) => b.flips - a.flips || a.name.localeCompare(b.name));
  const result: TrendWeek[] = weeks.map((week) => {
    let numerator = 0;
    let denominator = 0;
    for (const project of projects) {
      const coverage = project.repository ? coverageAt(project.repository, week.end) : undefined;
      if (!coverage) continue;
      numerator += coverage.numerator;
      denominator += coverage.denominator;
    }
    const middle = median(week.durations);
    return {
      week: isoWeek(new Date(week.start)),
      from: new Date(week.start).toISOString(),
      to: new Date(week.end).toISOString(),
      replays: ratio(week.passed, week.finished),
      issues: week.issues,
      ...(middle === undefined ? {} : { medianReplayMs: middle }),
      ...(denominator > 0 ? { coverage: ratio(numerator, denominator) } : {}),
    };
  });
  return {
    generatedAt: now.toISOString(),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    weeks: result,
    unstable: unstable.slice(0, 5),
  };
}
