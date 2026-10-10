import type { NetworkObservation } from '../../functional/model.js';
import type { Criterion, HttpStructure, StructuredValue } from '../../functional/http-structure.js';
import type { EntityCorrelation } from '../business/entity-correlation.js';
import { technicalCategoryOf } from '../business/entity-classifier.js';
import { identityInPath, round, routePattern } from '../business/signals.js';
import type { RawRecordedEvent } from '../model.js';

/**
 * L'ANALYSE MÉTIER DES REQUÊTES HTTP DU RECORDING — UN SEUL MOTEUR, DEUX MODES :
 *
 *   LIVE          pendant l'enregistrement, sur ce qui a été collecté jusque-là (provisoire) ;
 *   CONSOLIDATED  après l'arrêt, sur tout le journal ; il RÉVISE le live (révisions justifiées).
 *
 *   événements utilisateur + journal réseau
 *     → corrélation actions / requêtes (confiance, candidats, requêtes indépendantes)
 *     → opérations métier (recherche, création, modification…) d'après les PREUVES, jamais la méthode
 *     → critères, groupes logiques, tri, pagination (structure de la requête)
 *     → correspondances champ d'interface ↔ propriété technique (FieldMapping)
 *     → relations entre opérations (création puis recherche), incohérences
 *     → états de connaissance (OBSERVED, INFERRED, PROVISIONAL, VALIDATED, REJECTED, SUPERSEDED)
 *
 * Pure et déterministe : les événements bruts ne sont jamais modifiés (l'analyse en est une lecture).
 * Aucune valeur saisie n'y figure en clair : seulement des empreintes, des chemins et des noms de
 * propriétés. Une proposition d'IA (facultative) reste une hypothèse, jamais une connaissance validée.
 */
export type KnowledgeState =
  'OBSERVED' | 'INFERRED' | 'PROVISIONAL' | 'VALIDATED' | 'REJECTED' | 'SUPERSEDED';
export type AnalysisMode = 'LIVE' | 'CONSOLIDATED';
export type BusinessOperation =
  'SEARCH' | 'LIST' | 'READ' | 'CREATE' | 'UPDATE' | 'DELETE' | 'TECHNICAL' | 'UNKNOWN';

export interface ActionNetworkCorrelation {
  id: string;
  actionId: string;
  networkIds: string[];
  /** TRIGGERED : déclenchées par l'action ; CANDIDATE : probable ; AMBIGUOUS : plusieurs actions possibles. */
  kind: 'TRIGGERED' | 'CANDIDATE' | 'AMBIGUOUS';
  confidence: number;
  state: KnowledgeState;
  evidence: string[];
  /** AMBIGUOUS : les autres actions possibles. */
  candidates?: string[];
  /** Requêtes de la même fenêtre, plus faiblement liées que la requête déclenchée : jamais une preuve. */
  secondary?: string[];
}

export interface BusinessObservation {
  id: string;
  networkId: string;
  /** Les actions corrélées (vide : une requête indépendante). */
  actionIds: string[];
  api: string;
  operation: BusinessOperation;
  /** TECHNICAL : l'opération de protocole (TOKEN_ACQUISITION…). */
  technicalOperation?: string;
  criteria: {
    property: string;
    operator?: string;
    valuePath: string;
    value: StructuredValue;
    group?: string;
    form: Criterion['form'];
  }[];
  groups: HttpStructure['groups'];
  sort: HttpStructure['sort'];
  pagination?: HttpStructure['pagination'];
  options: string[];
  result?: { status?: number; count?: number; empty?: boolean; newIdentity?: boolean; failure?: string };
  relations: {
    type: 'SEARCH_AFTER_CREATE' | 'RESULT_MATCHES_CREATE' | 'ENTITY_CORRELATION';
    target: string;
    match?: 'EXACT' | 'NORMALIZED';
    properties?: string[];
    extraCriteria?: string[];
    confidence: number;
    evidence: string[];
  }[];
  confidence: number;
  state: KnowledgeState;
  evidence: string[];
}

export interface FieldMapping {
  /** La clé de la correspondance : écran + libellé + chemin (sans index). */
  key: string;
  uiLabel: string;
  /** La propriété technique : le nom porté par le critère, ou la clé de la feuille. */
  property: string;
  jsonPath: string;
  source: 'QUERY' | 'BODY';
  screen: string;
  api: string;
  operation: BusinessOperation;
  /** EXACT : même valeur ; NORMALIZED : même valeur à la casse, aux espaces, aux accents près. */
  transformation: 'EXACT' | 'NORMALIZED';
  occurrences: string[];
  confidence: number;
  state: KnowledgeState;
  evidence: string[];
  /** Une signification proposée (IA) : toujours une hypothèse. */
  meaning?: { text: string; source: 'AI'; state: 'PROVISIONAL'; confidence: number };
  /** Plusieurs propriétés possibles pour la même saisie : aucune n'est choisie. */
  candidates?: string[];
}

export interface Inconsistency {
  kind:
    | 'HTTP_ERROR'
    | 'TRANSPORT_FAILURE'
    | 'MISSING_RESPONSE'
    | 'NO_RESULT_AFTER_CREATE'
    | 'MAPPING_CONFLICT'
    | 'AMBIGUOUS_CORRELATION';
  message: string;
  refs: string[];
}

export interface KnowledgeRevision {
  ref: string;
  subject: 'CORRELATION' | 'BUSINESS' | 'FIELD_MAPPING';
  from: string;
  to: string;
  reason: string;
}

export interface RecordingAnalysis {
  version: 1;
  mode: AnalysisMode;
  status: 'COMPLETE' | 'FAILED';
  errors: string[];
  summary: {
    events: number;
    userActions: number;
    network: number;
    correlated: number;
    independent: number;
    ambiguous: number;
    pending: number;
    operations: Partial<Record<BusinessOperation, number>>;
    fieldMappings: Partial<Record<KnowledgeState, number>>;
    hypotheses: number;
    inconsistencies: number;
    revisions: number;
  };
  correlations: ActionNetworkCorrelation[];
  independent: { networkId: string; reason: string }[];
  business: BusinessObservation[];
  fieldMappings: FieldMapping[];
  inconsistencies: Inconsistency[];
  revisions: KnowledgeRevision[];
}

export interface AnalysisInput {
  mode: AnalysisMode;
  events: readonly RawRecordedEvent[];
  network: readonly NetworkObservation[];
  /** La dernière analyse (live) : la consolidation en trace les révisions. */
  previous?: RecordingAnalysis;
  /** CONSOLIDATED : les corrélations d'entités par données métier (business/entity-correlation.ts). */
  entityCorrelations?: readonly EntityCorrelation[];
  /** Des significations proposées (IA facultative), par clé de correspondance : des hypothèses. */
  meaningProposals?: ReadonlyMap<string, string>;
  /** Des opérations proposées (IA facultative) pour une opération UNKNOWN, par requête : des hypothèses. */
  operationProposals?: ReadonlyMap<string, BusinessOperation>;
}

/** Les opérations qu'une proposition (IA) peut choisir : jamais TECHNICAL ni UNKNOWN. */
export const PROPOSABLE_OPERATIONS: readonly BusinessOperation[] = [
  'SEARCH',
  'LIST',
  'READ',
  'CREATE',
  'UPDATE',
  'DELETE',
];

/** Les poids fixes de la corrélation action → requête : une décision se recalcule à la main. */
export const ANALYSIS_WEIGHTS = {
  gap300: 0.55,
  gap1000: 0.45,
  gap3000: 0.3,
  gap10000: 0.1,
  openWindow: 0.35,
  latest: 0.05,
  triggered: 0.75,
  candidate: 0.4,
  ambiguityMargin: 0.15,
  mappingOnce: 0.75,
  mappingNormalized: 0.65,
  mappingRepeated: 0.9,
} as const;

const USER_ACTIONS: ReadonlySet<RawRecordedEvent['type']> = new Set([
  'click',
  'input',
  'change',
  'submit',
  'keydown',
  'navigation',
  'drag',
]);

/** L'analyse, sans jamais lever : une erreur est rapportée, les événements bruts restent intacts. */
export function analyzeRecording(input: AnalysisInput): RecordingAnalysis {
  try {
    return analyze(input);
  } catch (error) {
    return {
      ...emptyAnalysis(input.mode, input.events.length, input.network.length),
      status: 'FAILED',
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function emptyAnalysis(mode: AnalysisMode, events: number, network: number): RecordingAnalysis {
  return {
    version: 1,
    mode,
    status: 'COMPLETE',
    errors: [],
    summary: {
      events,
      userActions: 0,
      network,
      correlated: 0,
      independent: 0,
      ambiguous: 0,
      pending: 0,
      operations: {},
      fieldMappings: {},
      hypotheses: 0,
      inconsistencies: 0,
      revisions: 0,
    },
    correlations: [],
    independent: [],
    business: [],
    fieldMappings: [],
    inconsistencies: [],
    revisions: [],
  };
}

function analyze(input: AnalysisInput): RecordingAnalysis {
  const W = ANALYSIS_WEIGHTS;
  const actions = input.events.filter(
    (event) => USER_ACTIONS.has(event.type) && !event.noise && !event.undone && !event.control,
  );
  const network = [...input.network].sort((a, b) => a.startedAt - b.startedAt);
  const analysis = emptyAnalysis(input.mode, input.events.length, network.length);
  analysis.summary.userActions = actions.length;
  /** Les empreintes saisies par l'humain : une valeur « lisible » qui en est une est re-masquée. */
  const typed = new Set(
    actions.flatMap((event) =>
      [event.value?.digest, event.value?.foldedDigest].filter((d): d is string => !!d),
    ),
  );

  // ------------------------------------------------------------ 1. requêtes périodiques (jamais une action)
  const periodic = new Set<string>();
  const byApi = new Map<string, NetworkObservation[]>();
  for (const entry of network) {
    const key = `${entry.method} ${routePattern(entry.path, 6)}`;
    byApi.set(key, [...(byApi.get(key) ?? []), entry]);
  }
  for (const entries of byApi.values()) {
    if (entries.length < 3) continue;
    const gaps = entries.slice(1).map((entry, index) => entry.startedAt - (entries[index]?.startedAt ?? 0));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const regular = mean >= 500 && gaps.every((gap) => Math.abs(gap - mean) <= mean * 0.25);
    // Un tick peut tomber dans la fenêtre d'un geste : la régularité suffit dès qu'un tick au moins
    // part hors de toute fenêtre (ou que la série est longue), jamais sur la seule proximité d'un clic.
    const unwindowed = entries.some((entry) => entry.openWindows.length === 0) || entries.length >= 5;
    if (regular && unwindowed) for (const entry of entries) periodic.add(entry.id);
  }

  // ------------------------------------------------------------ 2. corrélation action → requêtes
  const assigned = new Map<
    string,
    { action: RawRecordedEvent; score: number; evidence: string[]; others: string[] }
  >();
  for (const entry of network) {
    if (periodic.has(entry.id)) {
      analysis.independent.push({
        networkId: entry.id,
        reason:
          'a periodic request (same API at a regular interval, not started by a gesture): background polling',
      });
      continue;
    }
    const scored = actions
      .filter((action) => action.at <= entry.startedAt + 50 && entry.startedAt - action.at <= 10_000)
      .map((action, _, all) => {
        const gap = Math.max(0, entry.startedAt - action.at);
        const evidence: string[] = [];
        let score = gap <= 300 ? W.gap300 : gap <= 1000 ? W.gap1000 : gap <= 3000 ? W.gap3000 : W.gap10000;
        evidence.push(`started ${String(gap)} ms after the action`);
        if (entry.openWindows.includes(action.id)) {
          score += W.openWindow;
          evidence.push("started while the action's window was open (until its screen settled)");
        }
        const latest = all.filter((other) => other.at <= entry.startedAt).at(-1);
        if (latest?.id === action.id) {
          score += W.latest;
          evidence.push('the last action before the request');
        }
        return { action, score: round(Math.min(0.97, score)), evidence };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < W.candidate) {
      analysis.independent.push({
        networkId: entry.id,
        reason: best
          ? `no action close enough (best ${best.action.id}: ${String(best.score)})`
          : actions.some((action) => action.at <= entry.startedAt)
            ? 'more than 10 s after the last action: an asynchronous or background request'
            : 'before any action: page load',
      });
      continue;
    }
    const rivals = scored
      .slice(1)
      .filter((other) => best.score - other.score < W.ambiguityMargin && other.score >= W.candidate);
    assigned.set(entry.id, { ...best, others: rivals.map((rival) => rival.action.id) });
  }
  const byAction = new Map<string, string[]>();
  for (const [networkId, link] of assigned)
    byAction.set(link.action.id, [...(byAction.get(link.action.id) ?? []), networkId]);
  for (const [actionId, networkIds] of byAction) {
    const all = networkIds.map((id) => assigned.get(id)).filter((link) => link !== undefined);
    // Une requête nettement déclenchée par le geste n'est pas rendue ambiguë par une requête plus
    // faible qui tombe dans la même fenêtre : celle-ci reste un lien secondaire, signalé à part.
    const strong = all.filter((link) => link.score >= W.triggered && link.others.length === 0);
    const links = strong.length > 0 ? strong : all;
    const secondary =
      strong.length > 0 ? networkIds.filter((id) => !strong.some((link) => assigned.get(id) === link)) : [];
    const confidence = Math.min(...links.map((link) => link.score));
    const others = [...new Set(links.flatMap((link) => link.others))];
    const primary = networkIds.filter((id) => !secondary.includes(id));
    const answered = primary.every((id) => network.find((entry) => entry.id === id)?.endedAt !== undefined);
    const windowed = primary.every((id) =>
      network.find((entry) => entry.id === id)?.openWindows.includes(actionId),
    );
    const kind: ActionNetworkCorrelation['kind'] = others.length
      ? 'AMBIGUOUS'
      : confidence >= W.triggered
        ? 'TRIGGERED'
        : 'CANDIDATE';
    const state: KnowledgeState =
      kind === 'TRIGGERED' ? (windowed && answered ? 'VALIDATED' : 'INFERRED') : 'PROVISIONAL';
    analysis.correlations.push({
      id: `ac:${actionId}`,
      actionId,
      networkIds,
      kind,
      confidence,
      state,
      evidence: [
        ...new Set(links.flatMap((link) => link.evidence)),
        ...(answered ? [] : ['a response is still pending']),
        `${String(networkIds.length)} request(s) linked to this action`,
        ...(secondary.length
          ? [`weaker link(s) ${secondary.join(', ')} kept as secondary, not as proof of the trigger`]
          : []),
      ],
      ...(others.length ? { candidates: others } : {}),
      ...(secondary.length ? { secondary } : {}),
    });
    const weakRivals = [
      ...new Set(
        secondary.flatMap((id) => assigned.get(id)?.others ?? []).filter((id) => !others.includes(id)),
      ),
    ];
    if (weakRivals.length)
      analysis.inconsistencies.push({
        kind: 'AMBIGUOUS_CORRELATION',
        message: `secondary requests ${secondary.join(', ')} could also come from ${weakRivals.join(', ')}`,
        refs: [actionId, ...secondary],
      });
    if (others.length)
      analysis.inconsistencies.push({
        kind: 'AMBIGUOUS_CORRELATION',
        message: `requests ${networkIds.join(', ')} could also come from ${others.join(', ')}: kept as a candidate link`,
        refs: [actionId, ...networkIds],
      });
  }

  // ------------------------------------------------------------ 3. opérations métier (preuves, jamais la méthode seule)
  for (const entry of network) {
    const link = assigned.get(entry.id);
    const technical = technicalCategoryOf(entry.path);
    const structure = entry.request;
    const criteria = (structure?.criteria ?? []).map((criterion) => ({
      property: criterion.property,
      ...(criterion.operator ? { operator: criterion.operator } : {}),
      valuePath: criterion.valuePath,
      value: remask(criterion.value, typed),
      ...(criterion.group ? { group: criterion.group } : {}),
      form: criterion.form,
    }));
    const evidence: string[] = [];
    let operation: BusinessOperation = 'UNKNOWN';
    let confidence = 0.4;
    const answered = entry.endedAt !== undefined;
    const list = entry.response?.listSize !== undefined;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(entry.method);
    if (technical) {
      operation = 'TECHNICAL';
      confidence = technical.confidence;
      evidence.push(technical.reason);
    } else if (list && !entry.response?.newIdentity) {
      const searched = criteria.length > 0 || structure?.pagination !== undefined || structure?.sort.length;
      operation = searched ? 'SEARCH' : 'LIST';
      confidence = searched ? 0.85 : 0.75;
      evidence.push(
        `the response is a collection (${String(entry.response?.listSize ?? 0)} item(s)) and serves no new identity`,
        ...(criteria.length ? [`${String(criteria.length)} criterion / criteria sent`] : []),
        ...(structure?.groups.length
          ? [`logical groups: ${structure.groups.map((group) => group.operator).join(', ')}`]
          : []),
        ...(structure?.pagination ? [`pagination (${structure.pagination.evidence.join('; ')})`] : []),
        ...(structure?.sort.length ? ['sorting'] : []),
        ...(write ? [`sent by ${entry.method}: the method is not the intent`] : []),
      );
    } else if (
      !answered &&
      (criteria.some((criterion) => criterion.form === 'STRUCTURE') || structure?.pagination)
    ) {
      operation = 'SEARCH';
      confidence = 0.5;
      evidence.push('criteria / pagination sent; the response is still pending: a provisional search');
    } else if (write && entry.response?.newIdentity) {
      operation = 'CREATE';
      confidence = 0.85;
      evidence.push(`${entry.method} accepted and serves a new identity`);
    } else if (write && entry.method === 'DELETE') {
      operation = 'DELETE';
      confidence = 0.7;
      evidence.push('DELETE accepted');
    } else if (write && identityInPath(entry.path)) {
      operation = 'UPDATE';
      confidence = 0.65;
      evidence.push(`${entry.method} on an identified resource`);
    } else if (write && answered && (entry.status ?? 0) < 300) {
      operation = 'CREATE';
      confidence = 0.55;
      evidence.push(`${entry.method} to a collection accepted, no identity served: a possible creation`);
    } else if (!write && answered) {
      operation = 'READ';
      confidence = 0.6;
      evidence.push('a read that serves no collection');
    }
    // Une proposition (IA) pour une opération INCONNUE seulement, parmi les opérations possibles :
    // une hypothèse (PROVISIONAL), jamais une connaissance validée.
    const proposed = input.operationProposals?.get(entry.id);
    const aiProposed =
      operation === 'UNKNOWN' && proposed !== undefined && PROPOSABLE_OPERATIONS.includes(proposed);
    if (aiProposed) {
      operation = proposed;
      confidence = 0.5;
      evidence.push(`AI proposal among ${PROPOSABLE_OPERATIONS.join(', ')}: a hypothesis, not validated`);
    }
    const failed = entry.failure !== undefined || (entry.status ?? 0) >= 400;
    const state: KnowledgeState =
      !answered || aiProposed
        ? 'PROVISIONAL'
        : failed
          ? 'INFERRED'
          : confidence >= 0.8 && link
            ? 'VALIDATED'
            : confidence >= 0.6
              ? 'INFERRED'
              : 'PROVISIONAL';
    analysis.business.push({
      id: `b:${entry.id}`,
      networkId: entry.id,
      actionIds: link ? [link.action.id] : [],
      api: `${entry.method} ${routePattern(entry.path, 6)}`,
      operation,
      ...(technical ? { technicalOperation: technical.operation } : {}),
      criteria,
      groups: structure?.groups ?? [],
      sort: structure?.sort ?? [],
      ...(structure?.pagination ? { pagination: structure.pagination } : {}),
      options: (structure?.options ?? []).map((option) => option.path),
      result: {
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ...(entry.response?.listSize !== undefined
          ? { count: entry.response.listSize, empty: entry.response.listSize === 0 }
          : {}),
        ...(entry.response?.newIdentity ? { newIdentity: true } : {}),
        ...(entry.failure ? { failure: entry.failure } : {}),
      },
      relations: [],
      confidence: round(confidence),
      state,
      evidence,
    });
    if (entry.failure)
      analysis.inconsistencies.push({
        kind: 'TRANSPORT_FAILURE',
        message: `${entry.method} ${entry.path} failed (${entry.failure})`,
        refs: [entry.id],
      });
    else if ((entry.status ?? 0) >= 400 && operation !== 'TECHNICAL')
      analysis.inconsistencies.push({
        kind: 'HTTP_ERROR',
        message: `${entry.method} ${entry.path} answered ${String(entry.status)}${entry.response?.errorCode ? ` (${entry.response.errorCode})` : ''}`,
        refs: [entry.id, ...(link ? [link.action.id] : [])],
      });
    else if (!answered && input.mode === 'CONSOLIDATED')
      analysis.inconsistencies.push({
        kind: 'MISSING_RESPONSE',
        message: `${entry.method} ${entry.path} never answered before the end of the recording`,
        refs: [entry.id],
      });
  }

  // ------------------------------------------------------------ 4. création puis recherche (données comparées en empreintes)
  const digestsOf = (structure: HttpStructure | undefined): Map<string, string> => {
    const map = new Map<string, string>();
    for (const leaf of structure?.leaves ?? []) {
      if (leaf.value.digest) map.set(leaf.value.digest, leaf.path);
      if (leaf.value.folded) map.set(`~${leaf.value.folded}`, leaf.path);
    }
    return map;
  };
  for (const create of analysis.business.filter((entry) => entry.operation === 'CREATE')) {
    const createEntry = network.find((entry) => entry.id === create.networkId);
    const created = digestsOf(createEntry?.request);
    if (!createEntry || created.size === 0) continue;
    for (const search of analysis.business.filter(
      (entry) =>
        entry.operation === 'SEARCH' &&
        (network.find((n) => n.id === entry.networkId)?.startedAt ?? 0) > createEntry.startedAt,
    )) {
      const matched: string[] = [];
      let match: 'EXACT' | 'NORMALIZED' = 'EXACT';
      const extra: string[] = [];
      for (const criterion of search.criteria) {
        if (criterion.value.digest && created.has(criterion.value.digest)) matched.push(criterion.property);
        else if (criterion.value.folded && created.has(`~${criterion.value.folded}`)) {
          matched.push(criterion.property);
          match = 'NORMALIZED';
        } else extra.push(criterion.property);
      }
      if (matched.length === 0) continue;
      search.relations.push({
        type: 'SEARCH_AFTER_CREATE',
        target: create.id,
        match,
        properties: matched,
        ...(extra.length ? { extraCriteria: extra } : {}),
        confidence: match === 'EXACT' ? 0.8 : 0.65,
        evidence: [
          `the search criteria ${matched.join(', ')} carry data sent by the creation ${create.api} (${match === 'EXACT' ? 'same value' : 'same value up to case / spacing / accents'})`,
          ...(extra.length ? [`additional criteria not from the creation: ${extra.join(', ')}`] : []),
        ],
      });
      const searchEntry = network.find((entry) => entry.id === search.networkId);
      const records = searchEntry?.response?.records ?? [];
      const carrying = records.filter((record) =>
        (record.attributes ?? []).some(
          (attribute) =>
            created.has(attribute.digest) ||
            (attribute.folded !== undefined && created.has(`~${attribute.folded}`)),
        ),
      );
      if (carrying.length > 0)
        search.relations.push({
          type: 'RESULT_MATCHES_CREATE',
          target: create.id,
          confidence: carrying.length === 1 ? 0.75 : 0.5,
          evidence: [
            `${String(carrying.length)} result(s) carry the created data${carrying.length > 1 ? ' (homonyms possible: none chosen)' : ''}`,
          ],
        });
      else if (search.result?.empty)
        analysis.inconsistencies.push({
          kind: 'NO_RESULT_AFTER_CREATE',
          message: `the search ${search.api} made with the created data returned no result — not a defect by itself: ${[
            ...(extra.length ? [`additional criteria (${extra.join(', ')})`] : []),
            ...(search.pagination?.index && search.pagination.index.value > 0
              ? [`pagination index ${String(search.pagination.index.value)}`]
              : []),
            'permissions or indexing delay possible',
          ].join(', ')}`,
          refs: [search.networkId, create.networkId],
        });
    }
  }
  for (const correlation of input.entityCorrelations ?? []) {
    const search = analysis.business.find((entry) => entry.actionIds.includes(correlation.query.actionId));
    if (!search) continue;
    search.relations.push({
      type: 'ENTITY_CORRELATION',
      target: correlation.id,
      confidence: correlation.confidence,
      evidence: [`entity correlation ${correlation.id} (${correlation.status})`],
    });
  }

  // ------------------------------------------------------------ 5. champ d'interface ↔ propriété technique
  const fills = actions.filter(
    (event) => (event.type === 'input' || event.type === 'change') && event.value?.digest,
  );
  const mappings = new Map<string, FieldMapping>();
  const conflicts = new Map<string, Set<string>>();
  for (const business of analysis.business) {
    if (business.operation === 'TECHNICAL' || business.actionIds.length === 0) continue;
    const entry = network.find((candidate) => candidate.id === business.networkId);
    const actionAt =
      actions.find((action) => action.id === business.actionIds[0])?.at ?? entry?.startedAt ?? 0;
    const previousTrigger = Math.max(
      -Infinity,
      ...analysis.business
        .filter((other) => other !== business && other.actionIds.length > 0)
        .map((other) => actions.find((action) => action.id === other.actionIds[0])?.at ?? -Infinity)
        .filter((at) => at < actionAt),
    );
    const group = fills.filter((fill) => fill.at <= actionAt && fill.at > previousTrigger);
    const leaves = (entry?.request?.leaves ?? []).filter((leaf) => leaf.value.digest);
    for (const fill of group) {
      const exact = leaves.filter((leaf) => leaf.value.digest === fill.value?.digest);
      const normalized = exact.length
        ? []
        : leaves.filter((leaf) => fill.value?.foldedDigest && leaf.value.folded === fill.value.foldedDigest);
      const hits = exact.length ? exact : normalized;
      if (hits.length === 0) continue;
      const label = fill.element?.label ?? fill.element?.name ?? fill.element?.text ?? '(unlabelled field)';
      const screen = routePattern(pathOf(fill.url), 6);
      const propertyOf = (path: string): string =>
        entry?.request?.criteria.find((criterion) => criterion.valuePath === path)?.property ??
        path
          .split('.')
          .at(-1)
          ?.replace(/^\?/, '')
          .replace(/\[\d+\]$/, '') ??
        path;
      const properties = [...new Set(hits.map((leaf) => propertyOf(leaf.path)))];
      const path = normalizePath(hits[0]?.path ?? '');
      const key = `${screen}|${label}|${path}`;
      const labelKey = `${screen}|${label}`;
      conflicts.set(labelKey, new Set([...(conflicts.get(labelKey) ?? []), ...properties]));
      const known = mappings.get(key);
      if (known) {
        if (!known.occurrences.includes(fill.id)) known.occurrences.push(fill.id);
        continue;
      }
      const transformation = exact.length ? 'EXACT' : 'NORMALIZED';
      mappings.set(key, {
        key,
        uiLabel: label,
        property: properties[0] ?? path,
        jsonPath: path,
        source: hits[0]?.source ?? 'BODY',
        screen,
        api: business.api,
        operation: business.operation,
        transformation,
        occurrences: [fill.id],
        confidence: transformation === 'EXACT' ? W.mappingOnce : W.mappingNormalized,
        state: 'INFERRED',
        evidence: [
          `the value typed in "${label}" (${fill.id}) is sent as ${hits.map((leaf) => leaf.path).join(', ')} by ${business.api} (${transformation === 'EXACT' ? 'same salted digest' : 'same value up to case / spacing / accents'})`,
        ],
        ...(properties.length > 1 ? { candidates: properties } : {}),
      });
    }
  }
  for (const mapping of mappings.values()) {
    const labelKey = `${mapping.screen}|${mapping.uiLabel}`;
    const rivals = [...(conflicts.get(labelKey) ?? [])].filter((property) => property !== mapping.property);
    if (mapping.candidates || rivals.length) {
      mapping.state = 'PROVISIONAL';
      mapping.confidence = 0.5;
      if (rivals.length) {
        mapping.candidates = [...new Set([mapping.property, ...rivals])];
        analysis.inconsistencies.push({
          kind: 'MAPPING_CONFLICT',
          message: `"${mapping.uiLabel}" on ${mapping.screen} is sent as several properties (${mapping.candidates.join(', ')}): none is validated`,
          refs: mapping.occurrences,
        });
      }
    } else if (mapping.occurrences.length >= 2) {
      // Confirmée par plusieurs observations indépendantes, sans contradiction.
      mapping.state = 'VALIDATED';
      mapping.confidence = W.mappingRepeated;
      mapping.evidence.push(`observed ${String(mapping.occurrences.length)} times, consistently`);
    }
    const proposal = input.meaningProposals?.get(mapping.key);
    if (proposal && mapping.state !== 'REJECTED')
      mapping.meaning = { text: proposal.slice(0, 120), source: 'AI', state: 'PROVISIONAL', confidence: 0.6 };
  }
  analysis.fieldMappings = [...mappings.values()];

  // ------------------------------------------------------------ 6. révisions (consolidation)
  if (input.previous) {
    const revise = (
      subject: KnowledgeRevision['subject'],
      before: readonly { ref: string; label: string; state: string }[],
      after: readonly { ref: string; label: string; state: string }[],
      why: (ref: string) => string,
    ): void => {
      for (const old of before) {
        const now = after.find((entry) => entry.ref === old.ref);
        if (!now)
          analysis.revisions.push({
            ref: old.ref,
            subject,
            from: `${old.label} ${old.state}`,
            to: 'SUPERSEDED',
            reason: 'no longer supported by the complete journal',
          });
        else if (now.label !== old.label || now.state !== old.state)
          analysis.revisions.push({
            ref: old.ref,
            subject,
            from: `${old.label} ${old.state}`,
            to: `${now.label} ${now.state}`,
            reason: why(old.ref),
          });
      }
    };
    revise(
      'CORRELATION',
      input.previous.correlations.map((entry) => ({ ref: entry.id, label: entry.kind, state: entry.state })),
      analysis.correlations.map((entry) => ({ ref: entry.id, label: entry.kind, state: entry.state })),
      (ref) =>
        analysis.correlations
          .find((entry) => entry.id === ref)
          ?.evidence.slice(-2)
          .join('; ') ?? 'more requests or responses observed',
    );
    revise(
      'BUSINESS',
      input.previous.business.map((entry) => ({ ref: entry.id, label: entry.operation, state: entry.state })),
      analysis.business.map((entry) => ({ ref: entry.id, label: entry.operation, state: entry.state })),
      (ref) =>
        analysis.business.find((entry) => entry.id === ref)?.evidence.join('; ') ?? 'response received',
    );
    revise(
      'FIELD_MAPPING',
      input.previous.fieldMappings.map((entry) => ({
        ref: entry.key,
        label: entry.property,
        state: entry.state,
      })),
      analysis.fieldMappings.map((entry) => ({ ref: entry.key, label: entry.property, state: entry.state })),
      (ref) =>
        analysis.fieldMappings.find((entry) => entry.key === ref)?.evidence.at(-1) ?? 'more observations',
    );
  }

  // ------------------------------------------------------------ 7. résumé
  const summary = analysis.summary;
  summary.correlated = assigned.size;
  summary.independent = analysis.independent.length;
  summary.ambiguous = analysis.correlations.filter((entry) => entry.kind === 'AMBIGUOUS').length;
  summary.pending = network.filter((entry) => entry.endedAt === undefined).length;
  for (const business of analysis.business)
    summary.operations[business.operation] = (summary.operations[business.operation] ?? 0) + 1;
  for (const mapping of analysis.fieldMappings)
    summary.fieldMappings[mapping.state] = (summary.fieldMappings[mapping.state] ?? 0) + 1;
  summary.hypotheses =
    analysis.correlations.filter((entry) => entry.state === 'PROVISIONAL').length +
    analysis.business.filter((entry) => entry.state === 'PROVISIONAL').length +
    analysis.fieldMappings.filter((entry) => entry.state === 'PROVISIONAL').length;
  summary.inconsistencies = analysis.inconsistencies.length;
  summary.revisions = analysis.revisions.length;
  return analysis;
}

/**
 * LE JOURNAL À ÉCRIRE : une copie où toute valeur gardée « lisible » (un jeton de structure) qui est
 * en fait une SAISIE de l'humain (un nom en capitales…) est re-masquée. Le journal en mémoire n'est
 * jamais modifié.
 */
export function redactJournal(
  network: readonly NetworkObservation[],
  events: readonly RawRecordedEvent[],
): NetworkObservation[] {
  const typed = new Set(
    events.flatMap((event) =>
      [event.value?.digest, event.value?.foldedDigest].filter((d): d is string => !!d),
    ),
  );
  return network.map((entry) => {
    if (!entry.request) return { ...entry };
    const request = entry.request;
    return {
      ...entry,
      request: {
        ...request,
        leaves: request.leaves.map((leaf) => ({ ...leaf, value: remask(leaf.value, typed) })),
        criteria: request.criteria.map((criterion) => ({
          ...criterion,
          value: remask(criterion.value, typed),
        })),
        options: request.options.map((leaf) => ({ ...leaf, value: remask(leaf.value, typed) })),
        context: request.context.map((leaf) => ({ ...leaf, value: remask(leaf.value, typed) })),
      },
    };
  });
}

/** Une valeur « lisible » qui est en fait une SAISIE de l'humain : re-masquée. */
function remask(value: StructuredValue, typed: ReadonlySet<string>): StructuredValue {
  if (value.clear === undefined || typeof value.clear !== 'string') return value;
  if ((value.digest && typed.has(value.digest)) || (value.folded && typed.has(value.folded))) {
    const { clear: _clear, ...rest } = value;
    return { ...rest, masked: 'USER_INPUT' };
  }
  return value;
}

function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://local.invalid').pathname;
  } catch {
    return url;
  }
}
