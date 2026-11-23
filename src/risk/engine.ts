import { createHash } from 'node:crypto';
import type { CartographyModel } from '../sdk/core/cartography.js';
import {
  RISK_ENGINE,
  type Risk,
  type RiskEvidence,
  type RiskReport,
  type RiskStatus,
  type RiskSuppression,
  type RiskVerification,
} from '../sdk/core/risk.js';
import type { SourceFacts } from '../cartography/facts.js';
import { componentOf, indexGraph } from './impact.js';
import { RULES, ruleInfo, type Draft, type RiskRule, type SourceRisk } from './rules.js';
import { simulate } from './verify.js';

/**
 * LE MOTEUR DE RISQUES. Il ne relit aucun fichier : il part des faits de risque gardés avec le scan et du
 * graphe de la cartographie, exécute les règles activées, calcule la confiance et le statut de chaque
 * risque, son impact, puis rejoue (simulation) les plus prioritaires dans un budget borné. Aucun appel à un
 * modèle de langage. Le rapport d'un scan est déterministe pour les mêmes faits, les mêmes règles et le même
 * état (suppressions, vérifications déclarées).
 */

/** Ce que les utilisateurs ont décidé, gardé d'un scan à l'autre (par identifiant de risque). */
export interface RiskState {
  schema: 1;
  disabled: string[];
  suppressions: Record<string, RiskSuppression>;
  verifications: Record<string, RiskVerification[]>;
}

export const emptyRiskState = (): RiskState => ({
  schema: 1,
  disabled: [],
  suppressions: {},
  verifications: {},
});

export interface BuildOptions {
  model: CartographyModel;
  facts: readonly SourceFacts[];
  previous?: RiskReport;
  state?: RiskState;
  /** Le budget des vérifications automatiques (les plus prioritaires d'abord). */
  verify?: { max: number; timeMs: number };
  now?: () => Date;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * LA CONFIANCE (0 à 1), séparée de la sévérité. Règles :
 *  - un motif reconnu par une règle : 0,15 ;
 *  - chaque preuve qui SOUTIENT : +0,20 (fiabilité haute), +0,12 (moyenne), +0,06 (basse) ;
 *  - chaque preuve qui AFFAIBLIT : −0,25 / −0,15 / −0,08 ;
 *  - chaque inconnue : −0,10 (au plus −0,30) ;
 *  - un chemin démontré jusqu'à un consommateur : +0,10 ;
 *  - borne : 0,05 à 0,90 pour une analyse statique (seule une reproduction dépasse 0,90, une réfutation
 *    ramène à 0,10 au plus).
 */
export function riskConfidence(
  evidence: readonly RiskEvidence[],
  unknowns: readonly string[],
  provenPath: boolean,
): { value: number; why: string[] } {
  const support = { HIGH: 0.2, MEDIUM: 0.12, LOW: 0.06 } as const;
  const weaken = { HIGH: 0.25, MEDIUM: 0.15, LOW: 0.08 } as const;
  const why = ['motif reconnu : +0,15'];
  let value = 0.15;
  for (const e of evidence) {
    if (e.relation === 'SUPPORTS') {
      value += support[e.reliability];
      why.push(
        `preuve (${e.reliability.toLowerCase()}) : +${support[e.reliability].toFixed(2).replace('.', ',')} — ${e.text}`,
      );
    } else if (e.relation === 'WEAKENS') {
      value -= weaken[e.reliability];
      why.push(
        `contre-indice (${e.reliability.toLowerCase()}) : −${weaken[e.reliability].toFixed(2).replace('.', ',')} — ${e.text}`,
      );
    }
  }
  const unknownPenalty = Math.min(0.3, unknowns.length * 0.1);
  if (unknownPenalty > 0) {
    value -= unknownPenalty;
    why.push(`${String(unknowns.length)} inconnue(s) : −${unknownPenalty.toFixed(2).replace('.', ',')}`);
  }
  if (provenPath) {
    value += 0.1;
    why.push('chemin démontré jusqu’à un consommateur : +0,10');
  }
  const bounded = Math.max(0.05, Math.min(0.9, value));
  if (bounded !== value) why.push(`borné à ${bounded.toFixed(2).replace('.', ',')} (analyse statique)`);
  return { value: Math.round(bounded * 100) / 100, why };
}

/** Le statut après une vérification : une reproduction ou une réfutation l'emportent, une simulation corrobore. */
export function applyOutcome(status: RiskStatus, outcome: RiskStatus): RiskStatus {
  if (outcome === 'REPRODUCED' || outcome === 'REFUTED') return outcome;
  if (outcome === 'CORROBORATED' && (status === 'POTENTIAL' || status === 'INCONCLUSIVE'))
    return 'CORROBORATED';
  return status;
}

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

/** La priorité de vérification : sévérité, fonctionnalités touchées, qualité des preuves, coût (simulable). */
export function priorityOf(risk: Risk): number {
  return (
    SEVERITY_RANK[risk.severity] * 10 +
    Math.min(5, risk.affectedFeatures.length) * 3 +
    risk.confidence * 10 +
    (risk.verifiable ? 5 : 0)
  );
}

function toRisk(rule: RiskRule, draft: Draft, scanId: string, sources: Map<string, SourceRisk>): Risk {
  const src = sources.get(draft.sourceId);
  const unknowns = [...draft.unknowns];
  let blocking = draft.blocking;
  // Une source lue partiellement : une absence ne prouve rien.
  if (src?.partial && rule.absence) {
    unknowns.push('La source a été lue partiellement : l’absence constatée peut venir des fichiers non lus.');
    blocking ??= 'source partielle';
  }
  // Les consommateurs ne sont reliés que par des liens non démontrés.
  if (draft.impact?.onlyUncertain) {
    unknowns.push('Les lecteurs ne sont reliés que par des liens non démontrés.');
    blocking ??= 'liens non démontrés';
  }
  const provenPath = draft.impact?.provenPath ?? false;
  const { value, why } = riskConfidence(draft.evidence, unknowns, provenPath);
  const status: RiskStatus = blocking ? 'INCONCLUSIVE' : draft.corroborated ? 'CORROBORATED' : 'POTENTIAL';
  const features = draft.features ?? draft.impact?.features ?? [];
  const id = `R-${hash(`${draft.ruleId}|${draft.sourceId}|${draft.entity}|${draft.anchor}`).slice(0, 16)}`;
  const fingerprint = hash(
    JSON.stringify([draft.loc.file, draft.conditions, draft.evidence.map((e) => e.text), draft.title]),
  ).slice(0, 16);
  return {
    id,
    ruleId: draft.ruleId,
    category: rule.category,
    type: rule.type,
    title: draft.title,
    description: draft.description,
    cause: draft.cause,
    entity: draft.entity,
    ...(draft.node ? { node: draft.node } : {}),
    layer: draft.layer,
    sourceId: draft.sourceId,
    file: draft.loc.file,
    line: draft.loc.line,
    trigger: draft.trigger,
    conditions: draft.conditions,
    propagation: draft.impact?.propagation ?? [],
    affectedFeatures: features,
    evidence: draft.evidence,
    assumptions: draft.assumptions,
    unknowns,
    limits: rule.limits,
    severity: draft.severity ?? rule.severity,
    confidence: value,
    confidenceWhy: why,
    status,
    suggestion: draft.suggestion,
    verifiable: draft.scenario !== undefined,
    ...(draft.testPlan ? { testPlan: draft.testPlan } : {}),
    verifications: [],
    fingerprint,
    ...(draft.scenario ? { scenario: draft.scenario } : {}),
    ...(draft.impact ? { impact: draft.impact.impact } : {}),
    firstSeen: scanId,
  };
}

/** Une vérification déclarée sur une version antérieure du risque : gardée, mais plus prise en compte. */
function withVerifications(risk: Risk, declared: readonly RiskVerification[]): Risk {
  let { status, confidence } = risk;
  const verifications = declared.map((v) => {
    const stale = v.fingerprint !== undefined && v.fingerprint !== risk.fingerprint;
    if (!stale) {
      status = applyOutcome(status, v.outcome);
      if (v.outcome === 'REPRODUCED') confidence = Math.max(confidence, 0.95);
      if (v.outcome === 'REFUTED') confidence = Math.min(confidence, 0.1);
      if (v.outcome === 'CORROBORATED')
        confidence = Math.min(0.9, Math.round((confidence + 0.1) * 100) / 100);
    }
    return stale ? { ...v, stale: true } : v;
  });
  return { ...risk, status, confidence, verifications };
}

export function buildRiskReport(options: BuildOptions): RiskReport {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const state = options.state ?? emptyRiskState();
  const disabled = new Set(state.disabled);
  const index = indexGraph(options.model);
  const scanId = options.model.scan.id;
  const sources = new Map<string, SourceRisk>();
  const withoutFacts: string[] = [];
  let files = 0;
  for (const fact of options.facts) {
    if (!fact.risk) {
      // Une source sans faits de risque (scan d'avant le moteur, ou source sans TypeScript ni Java).
      if (fact.ui || fact.java) withoutFacts.push(fact.sourceId);
      continue;
    }
    files += fact.risk.files;
    sources.set(fact.sourceId, { fact, risk: fact.risk, partial: (fact.partial?.length ?? 0) > 0 });
  }
  const ctx = { index, sources: [...sources.values()] };
  const enabled = RULES.filter((r) => !disabled.has(r.id));
  const drafts: { rule: RiskRule; draft: Draft }[] = [];
  for (const rule of enabled) for (const draft of rule.detect(ctx)) drafts.push({ rule, draft });
  // Une erreur non traitée déjà expliquée par un risque asynchrone plus précis sur la même méthode n'est pas
  // répétée.
  const explained = new Set(drafts.filter((d) => d.rule.category === 'ASYNC').map((d) => d.draft.node));
  const byId = new Map<string, Risk>();
  for (const { rule, draft } of drafts) {
    if (rule.id === 'RISK-ERR-001' && explained.has(draft.node)) continue;
    // Sans parcours d'impact : les fonctionnalités qui atteignent le composant (ou la méthode) concerné.
    if (!draft.features && (draft.impact?.features.length ?? 0) === 0 && draft.node) {
      const component = componentOf(index, draft.node);
      const features = [
        ...new Map(
          [component, draft.node]
            .flatMap((id) => (id ? (index.reach.get(id) ?? []) : []))
            .map((f) => [f.id, { id: f.id, name: f.name, confidence: f.confidence, direct: true }] as const),
        ).values(),
      ];
      if (features.length) draft.features = features;
    }
    const risk = toRisk(rule, draft, scanId, sources);
    if (!byId.has(risk.id)) byId.set(risk.id, risk);
  }
  // Face au scan précédent : nouveau, inchangé, changé ; premier scan où il a été vu.
  const before = new Map((options.previous?.risks ?? []).map((r) => [r.id, r]));
  const base = [...byId.values()].map((risk) => {
    const prev = before.get(risk.id);
    const change: Risk['change'] = !options.previous
      ? undefined
      : !prev
        ? 'NEW'
        : prev.fingerprint === risk.fingerprint
          ? 'UNCHANGED'
          : 'CHANGED';
    const suppressed = state.suppressions[risk.id];
    return {
      ...risk,
      firstSeen: prev?.firstSeen ?? scanId,
      ...(change ? { change } : {}),
      ...(suppressed ? { suppressed } : {}),
    };
  });
  // Les vérifications déclarées (gardées avec leur empreinte), puis les simulations automatiques : seulement
  // les plus prioritaires, dans le budget (nombre, durée). Chaque vérification n'est faite qu'une fois.
  const declared = new Map(base.map((r) => [r.id, [...(state.verifications[r.id] ?? [])]]));
  const budget = options.verify ?? { max: 20, timeMs: 2_000 };
  const verifyStart = Date.now();
  const queue = base
    .map((r) => withVerifications(r, declared.get(r.id) ?? []))
    .filter((r) => r.verifiable && !r.suppressed && r.status !== 'REPRODUCED' && r.status !== 'REFUTED')
    .filter((r) => !r.verifications.some((v) => v.method === 'STATE_SIMULATION' && !v.stale))
    .sort((a, b) => priorityOf(b) - priorityOf(a))
    .slice(0, budget.max);
  for (const risk of queue) {
    if (Date.now() - verifyStart > budget.timeMs) break;
    declared.get(risk.id)?.push(simulate(risk, {}, now()));
  }
  const risks = base.map((r) => withVerifications(r, declared.get(r.id) ?? []));
  risks.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.confidence - a.confidence ||
      a.title.localeCompare(b.title),
  );
  const current = new Set(risks.map((r) => r.id));
  return {
    schema: 1,
    engine: RISK_ENGINE,
    scanId,
    generatedAt: now().toISOString(),
    ...(options.previous ? { previousScanId: options.previous.scanId } : {}),
    rules: RULES.map((r) => ruleInfo(r, !disabled.has(r.id))),
    risks,
    resolved: [...before.keys()].filter((id) => !current.has(id)),
    metrics: {
      durationMs: Date.now() - started,
      sources: options.facts.length,
      sourcesWithoutFacts: withoutFacts,
      filesExamined: files,
      rulesRun: enabled.length,
      risks: risks.length,
      pathsExplored: [...index.memo.values()].reduce((sum, r) => sum + r.impact.explored, 0),
      reusedSources: options.model.scan.sources.filter((s) => s.state === 'REUSED').length,
      verificationsMs: Date.now() - verifyStart,
    },
  };
}

/** Une vérification à la demande (simulation ou résultat d'un test exécuté dans le projet). */
export function verifyRisk(
  risk: Risk,
  input: {
    method?: 'STATE_SIMULATION' | 'EXTERNAL_TEST';
    outcome?: RiskStatus;
    observed?: string;
    expected?: string;
    note?: string;
    by?: string;
  },
  now: Date,
): RiskVerification {
  if (input.method === 'EXTERNAL_TEST') {
    return {
      id: `V-${hash(`${risk.id}|${now.toISOString()}|${input.observed ?? ''}`).slice(0, 12)}`,
      at: now.toISOString(),
      method: 'EXTERNAL_TEST',
      outcome: input.outcome ?? 'INCONCLUSIVE',
      steps: risk.testPlan ?? [],
      observed: input.observed ?? '',
      ...(input.expected ? { expected: input.expected } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.by ? { by: input.by } : {}),
      durationMs: 0,
      fingerprint: risk.fingerprint,
    };
  }
  return simulate(risk, { ...(input.expected ? { expected: input.expected } : {}) }, now);
}
