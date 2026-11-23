import { createHash } from 'node:crypto';
import { applyDecisions } from '../../cartography/decisions.js';
import {
  listScans,
  readDecisions,
  readRiskReport,
  readRiskState,
  readScan,
  writeRiskReport,
  writeRiskState,
} from '../../cartography/store.js';
import { buildRiskReport, verifyRisk, type RiskState } from '../../risk/engine.js';
import { impactOf, indexGraph, type GraphIndex } from '../../risk/impact.js';
import type { CartographyModel } from '../core/cartography.js';
import {
  RISK_CATEGORIES,
  RISK_ENGINE,
  RISK_SEVERITIES,
  RISK_STATUSES,
  type Risk,
  type RiskImpact,
  type RiskPage,
  type RiskQuery,
  type RiskReport,
  type RiskSummary,
  type RiskVerification,
} from '../core/risk.js';
import { MAP_LAYERS } from '../core/cartography.js';
import { CartographyInputError, type CartographyProject } from './cartography.js';

/**
 * LES RISQUES D'ANOMALIES D'UN PROJET (`/api/projects/:id/cartography/risks…`). Le rapport d'un scan est
 * calculé une fois à partir des faits gardés avec le scan (aucun fichier relu, aucun code exécuté), écrit à
 * côté du scan, et recalculé quand les décisions changent (suppression, vérification, règles). Une requête
 * concurrente attend le même calcul.
 */
interface Entry {
  key: string;
  report: Promise<RiskReport>;
  model: Promise<CartographyModel>;
  index?: GraphIndex;
}

const CACHE = new Map<string, Entry>();
const MAX_CACHE = 8;

const stateKey = (state: RiskState, decisions: number): string =>
  createHash('sha256').update(JSON.stringify(state)).update(String(decisions)).digest('hex').slice(0, 16);

async function entryOf(project: CartographyProject, scanId?: string): Promise<Entry> {
  const scans = await listScans(project.dir);
  const chosen = scanId ?? scans[0]?.id;
  if (!chosen) throw new CartographyInputError(409, 'NO_SCAN', 'no scan yet');
  const at = scans.findIndex((s) => s.id === chosen);
  if (at < 0) throw new CartographyInputError(404, 'NOT_FOUND', 'scan not found');
  const [state, decisions] = await Promise.all([readRiskState(project.dir), readDecisions(project.dir)]);
  const key = `${chosen}|${stateKey(state, decisions.length)}`;
  const cached = CACHE.get(project.dir);
  if (cached?.key === key) return cached;
  const stored = readScan(project.dir, chosen).then((s) => {
    if (!s) throw new CartographyInputError(404, 'NOT_FOUND', 'scan not found');
    return s;
  });
  const model = stored.then((s) => applyDecisions(s.model, decisions));
  const report = (async (): Promise<RiskReport> => {
    const persisted = await readRiskReport(project.dir, chosen);
    // Le rapport écrit est repris s'il vient de ce moteur et du même état (décisions des utilisateurs).
    if (persisted?.engine === RISK_ENGINE && persisted.stateKey === key) return persisted;
    const previousId = scans[at + 1]?.id;
    const previous = previousId ? await readRiskReport(project.dir, previousId) : undefined;
    const s = await stored;
    const built: RiskReport = {
      ...buildRiskReport({ model: await model, facts: s.facts, state, ...(previous ? { previous } : {}) }),
      stateKey: key,
    };
    await writeRiskReport(project.dir, built);
    return built;
  })();
  const entry: Entry = { key, report, model };
  report.catch(() => {
    if (CACHE.get(project.dir) === entry) CACHE.delete(project.dir);
  });
  CACHE.delete(project.dir);
  CACHE.set(project.dir, entry);
  while (CACHE.size > MAX_CACHE) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    CACHE.delete(oldest);
  }
  return entry;
}

const count = <K extends string>(items: readonly Risk[], key: (r: Risk) => K): Partial<Record<K, number>> => {
  const out: Partial<Record<K, number>> = {};
  for (const r of items) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
};

export function summaryOf(report: RiskReport): RiskSummary {
  const active = report.risks.filter((r) => !r.suppressed);
  const features = new Set(active.flatMap((r) => r.affectedFeatures.map((f) => f.id)));
  const changed = active.filter((r) => r.change !== undefined);
  return {
    scanId: report.scanId,
    ...(report.previousScanId ? { previousScanId: report.previousScanId } : {}),
    total: active.length,
    critical: active.filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH').length,
    corroborated: active.filter((r) => r.status === 'CORROBORATED').length,
    reproduced: active.filter((r) => r.status === 'REPRODUCED').length,
    suppressed: report.risks.length - active.length,
    features: features.size,
    byCategory: count(active, (r) => r.category),
    byLayer: count(active, (r) => r.layer),
    byStatus: count(active, (r) => r.status),
    bySeverity: count(active, (r) => r.severity),
    ...(report.previousScanId && changed.length
      ? {
          diff: {
            added: active.filter((r) => r.change === 'NEW').length,
            resolved: report.resolved.length,
            unchanged: active.filter((r) => r.change === 'UNCHANGED').length,
          },
        }
      : {}),
    metrics: report.metrics,
    rules: report.rules,
  };
}

/** Une ligne de liste : sans le graphe d'impact ni le détail des preuves (le panneau les demande). */
const listItem = (r: Risk): Risk => {
  const { impact: _impact, ...rest } = r;
  return rest;
};

export function riskQuery(params: URLSearchParams): RiskQuery {
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const value = params.get(key);
    if (value === null || value === '') return undefined;
    if (!(allowed as readonly string[]).includes(value))
      throw new CartographyInputError(400, 'BAD_QUERY', `unknown ${key}: ${value.slice(0, 40)}`);
    return value as T;
  };
  const num = (key: string): number | undefined => {
    const v = params.get(key);
    const n = v ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const category = pick('category', RISK_CATEGORIES);
  const severity = pick('severity', RISK_SEVERITIES);
  const status = pick('status', RISK_STATUSES);
  const layer = pick('layer', MAP_LAYERS);
  const q = params.get('q');
  const feature = params.get('feature');
  const source = params.get('source');
  const scan = params.get('scan');
  const minConfidence = num('minConfidence');
  const page = num('page');
  const size = num('size');
  return {
    ...(q && q.length <= 200 ? { q } : {}),
    ...(category ? { category } : {}),
    ...(severity ? { severity } : {}),
    ...(status ? { status } : {}),
    ...(layer ? { layer } : {}),
    ...(feature && feature.length <= 300 ? { feature } : {}),
    ...(source && source.length <= 100 ? { source } : {}),
    ...(scan && /^scan-[\w-]{1,80}$/.test(scan) ? { scan } : {}),
    ...(minConfidence !== undefined ? { minConfidence: Math.max(0, Math.min(1, minConfidence)) } : {}),
    ...(params.get('suppressed') === 'true' ? { suppressed: true } : {}),
    ...(page !== undefined ? { page: Math.max(1, Math.floor(page)) } : {}),
    ...(size !== undefined ? { size: Math.max(1, Math.min(200, Math.floor(size))) } : {}),
  };
}

export async function listRisks(project: CartographyProject, query: RiskQuery): Promise<RiskPage> {
  const report = await (await entryOf(project, query.scan)).report;
  const q = query.q?.toLowerCase();
  const items = report.risks.filter(
    (r) =>
      (query.suppressed || !r.suppressed) &&
      (!query.category || r.category === query.category) &&
      (!query.severity || r.severity === query.severity) &&
      (!query.status || r.status === query.status) &&
      (!query.layer || r.layer === query.layer) &&
      (!query.source || r.sourceId === query.source) &&
      (!query.feature || r.affectedFeatures.some((f) => f.id === query.feature)) &&
      (query.minConfidence === undefined || r.confidence >= query.minConfidence) &&
      (!q || `${r.title} ${r.entity} ${r.ruleId} ${r.file}`.toLowerCase().includes(q)),
  );
  const size = query.size ?? 25;
  const page = query.page ?? 1;
  return {
    items: items.slice((page - 1) * size, page * size).map(listItem),
    total: items.length,
    page,
    size,
    summary: summaryOf(report),
  };
}

async function riskOf(project: CartographyProject, id: string, scan?: string): Promise<Risk> {
  const report = await (await entryOf(project, scan)).report;
  const risk = report.risks.find((r) => r.id === id);
  if (!risk) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown risk');
  return risk;
}

export const riskDetail = (project: CartographyProject, id: string, scan?: string): Promise<Risk> =>
  riskOf(project, id, scan);

export async function riskEvidence(
  project: CartographyProject,
  id: string,
): Promise<Pick<Risk, 'evidence' | 'assumptions' | 'unknowns' | 'limits' | 'confidence' | 'confidenceWhy'>> {
  const r = await riskOf(project, id);
  return {
    evidence: r.evidence,
    assumptions: r.assumptions,
    unknowns: r.unknowns,
    limits: r.limits,
    confidence: r.confidence,
    confidenceWhy: r.confidenceWhy,
  };
}

export async function riskVerifications(
  project: CartographyProject,
  id: string,
): Promise<{ verifications: RiskVerification[]; testPlan: string[]; verifiable: boolean }> {
  const r = await riskOf(project, id);
  return { verifications: r.verifications, testPlan: r.testPlan ?? [], verifiable: r.verifiable };
}

/**
 * L'impact d'un risque, développé jusqu'à `depth` (borné) : le parcours repart des mêmes sources (la donnée
 * et ses formes exposées) sur le graphe du scan, sans rien recalculer d'autre.
 */
export async function riskImpact(
  project: CartographyProject,
  id: string,
  depth?: number,
): Promise<RiskImpact> {
  const entry = await entryOf(project);
  const risk = (await entry.report).risks.find((r) => r.id === id);
  if (!risk) throw new CartographyInputError(404, 'NOT_FOUND', 'unknown risk');
  const base = risk.impact ?? { nodes: [], edges: [], blocked: [], truncated: false, explored: 0 };
  if (!depth || depth <= 5) return base;
  entry.index ??= indexGraph(await entry.model);
  const starts = base.nodes.filter((n) => n.role === 'SOURCE' || n.role === 'DATA').map((n) => n.id);
  if (starts.length === 0) return base;
  const bounded = Math.min(10, depth);
  return impactOf(entry.index, starts, { maxDepth: bounded, maxNodes: 40 + (bounded - 5) * 20 }).impact;
}

export async function verify(
  project: CartographyProject,
  id: string,
  body: unknown,
  author: string,
): Promise<Risk> {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const method = input.method === 'EXTERNAL_TEST' ? 'EXTERNAL_TEST' : 'STATE_SIMULATION';
  const text = (key: string, max: number): string | undefined =>
    typeof input[key] === 'string' && input[key].trim() ? input[key].trim().slice(0, max) : undefined;
  const outcome = input.outcome;
  if (method === 'EXTERNAL_TEST') {
    if (outcome !== 'REPRODUCED' && outcome !== 'REFUTED' && outcome !== 'INCONCLUSIVE')
      throw new CartographyInputError(
        422,
        'INVALID_VERIFICATION',
        'an external test needs its outcome (REPRODUCED, REFUTED or INCONCLUSIVE)',
      );
    if (!text('observed', 2000))
      throw new CartographyInputError(
        422,
        'INVALID_VERIFICATION',
        'an external test needs what was observed',
      );
  }
  const risk = await riskOf(project, id);
  const expected = text('expected', 500);
  const observed = text('observed', 2000);
  const note = text('note', 500);
  const verification = verifyRisk(
    risk,
    {
      method,
      ...(method === 'EXTERNAL_TEST'
        ? { outcome: outcome as 'REPRODUCED' | 'REFUTED' | 'INCONCLUSIVE' }
        : {}),
      ...(observed ? { observed } : {}),
      ...(expected ? { expected } : {}),
      ...(note ? { note } : {}),
      by: author,
    },
    new Date(),
  );
  const state = await readRiskState(project.dir);
  state.verifications[id] = [...(state.verifications[id] ?? []), { ...verification, by: author }].slice(-20);
  await writeRiskState(project.dir, state);
  return riskOf(project, id);
}

export async function suppress(
  project: CartographyProject,
  id: string,
  body: unknown,
  author: string,
): Promise<Risk> {
  const reason =
    body && typeof body === 'object' && typeof (body as { reason?: unknown }).reason === 'string'
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : undefined;
  if (reason === undefined)
    throw new CartographyInputError(
      422,
      'INVALID_SUPPRESSION',
      'a reason is required (empty to lift the suppression)',
    );
  await riskOf(project, id);
  const state = await readRiskState(project.dir);
  if (reason) state.suppressions[id] = { by: author, at: new Date().toISOString(), reason };
  else
    state.suppressions = Object.fromEntries(Object.entries(state.suppressions).filter(([key]) => key !== id));
  await writeRiskState(project.dir, state);
  return riskOf(project, id);
}

export async function setRules(project: CartographyProject, body: unknown): Promise<RiskSummary> {
  const disabled = body && typeof body === 'object' ? (body as { disabled?: unknown }).disabled : undefined;
  if (
    !Array.isArray(disabled) ||
    !disabled.every((d) => typeof d === 'string' && /^RISK-[A-Z]+-\d{3}$/.test(d))
  )
    throw new CartographyInputError(422, 'INVALID_RULES', 'disabled must list rule identifiers');
  const state = await readRiskState(project.dir);
  state.disabled = [...new Set(disabled as string[])];
  await writeRiskState(project.dir, state);
  return summaryOf(await (await entryOf(project)).report);
}
