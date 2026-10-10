import type { ExchangeRecord, FunctionalExchange } from '../../functional/model.js';
import type { RawRecordedEvent, SemanticRecordedAction } from '../model.js';
import { technicalCategoryOf } from './entity-classifier.js';
import { IDENTITY_CONFIDENCE, type EntityEvidence, type EntityIdentity } from './entity-evidence.js';
import {
  WRITE,
  collectionOf,
  identifierTokens,
  identityInPath,
  isListRead,
  labelOf,
  queryEvidenceOf,
  round,
  sameValue,
} from './signals.js';

/**
 * ENTITY CORRELATION : une même entité retrouvée par ses DONNÉES MÉTIER, sans exiger qu'un
 * identifiant soit visible ni réutilisé par l'humain.
 *
 *   CREATE (données saisies / envoyées)  →  SEARCH (critères envoyés, quelle que soit la méthode)
 *     →  RESULT (un enregistrement dont les attributs portent les mêmes données)  →  OPEN
 *
 * Tout se compare par EMPREINTE SALÉE (saisies, corps envoyés, attributs des réponses) : aucune
 * valeur n'est lue ni gardée. Rien n'est déduit d'un nom de champ, d'une méthode HTTP, d'une URL :
 * seulement de valeurs ÉGALES observées à des moments différents du parcours.
 *
 *   - une seule donnée commune (un nom) : confiance faible ; plusieurs données qui convergent (nom +
 *     adresse + numéro) : confiance élevée ; le même identifiant que celui servi à la création : sûr ;
 *   - plusieurs résultats qui correspondent autant (des HOMONYMES) : AMBIGUOUS, aucun n'est choisi ;
 *   - un résultat déjà observé AVANT la création : peut-être un homonyme existant → AMBIGUOUS ;
 *   - l'identité du résultat (son id), inconnue à la création, enrichit l'entité APRÈS COUP.
 */
export type CorrelationStatus = 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNCERTAIN';

export interface CorrelatedAttribute {
  /** Le libellé du champ saisi, ou le chemin du champ envoyé / reçu (filters.name…) : jamais la valeur. */
  label: string;
  /** Où la donnée a été vue : saisie de la création, corps envoyé, critère de recherche, résultat. */
  seenIn: ('CREATE_INPUT' | 'CREATE_REQUEST' | 'SEARCH_CRITERION' | 'RESULT_RECORD')[];
}

export interface EntityCorrelation {
  id: string;
  kind: 'CREATE_SEARCH_RESULT';
  status: CorrelationStatus;
  confidence: number;
  /** La même entité est-elle probable (CONFIRMED / PROBABLE, un seul résultat) ? */
  sameEntityCandidate: boolean;
  creation: { actionId: string; actionIndex: number; api: string; attributes: number };
  query: {
    actionId: string;
    actionIndex: number;
    /** Les actions de la recherche (critères saisis + geste qui l'envoie). */
    actionIds: string[];
    api: string;
    method: string;
    /** Pourquoi cet échange est une RECHERCHE (et non une création), quelle que soit sa méthode. */
    queryEvidence: string[];
    resultCount: number;
  };
  /** Les données de la création retrouvées dans la recherche et / ou le résultat. */
  matched: CorrelatedAttribute[];
  /** Le résultat retenu (un seul), et son identité découverte APRÈS la création. */
  result?: {
    index: number;
    identifiers: { field: string; value?: string; digest: string }[];
    /** L'identifiant servi à la création est le même que celui du résultat. */
    sameIdAsCreation: boolean;
  };
  /** Les résultats qui correspondent autant (homonymes) : aucun n'est choisi. */
  candidates?: number[];
  open?: { actionId: string; actionIndex: number; via: string };
  evidence: string[];
}

/** Les poids fixes de la corrélation : une décision se recalcule à la main. */
export const CORRELATION_WEIGHTS = {
  oneAttribute: 0.5,
  twoAttributes: 0.65,
  threeAttributes: 0.78,
  sameId: 0.95,
  searchedWithCreationData: 0.1,
  uniqueResult: 0.05,
  opened: 0.05,
  ambiguousCap: 0.5,
  confirmed: 0.85,
  probable: 0.6,
} as const;

export interface CorrelationInput {
  actions: readonly SemanticRecordedAction[];
  rawEvents: readonly RawRecordedEvent[];
  typedValues?: ReadonlyMap<string, string>;
  digest?: (value: string) => string;
}

interface Datum {
  digest: string;
  label: string;
  source: 'INPUT' | 'REQUEST';
}

export function correlateEntities(input: CorrelationInput): EntityCorrelation[] {
  const W = CORRELATION_WEIGHTS;
  const actions = input.actions;
  const rawById = new Map(input.rawEvents.map((event) => [event.id, event]));

  /** L'empreinte de la valeur saisie (jamais la valeur), d'un champ non sensible. */
  const typedDigest = (action: SemanticRecordedAction): string | undefined => {
    for (const id of [...action.rawEventIds].reverse()) {
      const facts = rawById.get(id)?.value;
      if (facts?.sensitive) return undefined;
      if (facts?.digest) return facts.digest;
      const text = input.typedValues?.get(id);
      if (text !== undefined && text.trim() !== '' && input.digest) return input.digest(text);
    }
    return undefined;
  };
  const businessWrite = (exchange: FunctionalExchange): boolean =>
    WRITE.has(exchange.method) &&
    exchange.status !== undefined &&
    exchange.status >= 200 &&
    exchange.status < 300 &&
    !isListRead(exchange) &&
    technicalCategoryOf(exchange.path) === undefined;
  const queryOf = (exchange: FunctionalExchange): boolean =>
    isListRead(exchange) &&
    exchange.status !== undefined &&
    exchange.status < 400 &&
    technicalCategoryOf(exchange.path) === undefined;

  // ------------------------------------------------------------ créations, recherches (dans l'ordre)
  const creations: {
    index: number;
    action: SemanticRecordedAction;
    exchange: FunctionalExchange;
    data: Datum[];
  }[] = [];
  const queries: {
    index: number;
    action: SemanticRecordedAction;
    exchange: FunctionalExchange;
    criteria: Datum[];
    actionIds: string[];
  }[] = [];
  /** Les saisies depuis le dernier geste qui a envoyé quelque chose (un formulaire, une recherche). */
  let group: { action: SemanticRecordedAction; digest: string }[] = [];
  for (const [index, action] of actions.entries()) {
    if (action.type === 'FILL') {
      const digest = typedDigest(action);
      if (digest)
        group = [
          ...group.filter((entry) => entry.action.target?.label !== action.target?.label),
          { action, digest },
        ];
    }
    const inputs = (): Datum[] =>
      group.map((entry) => ({
        digest: entry.digest,
        label: labelOf(entry.action),
        source: 'INPUT' as const,
      }));
    const write = action.type !== 'FILL' ? action.network.find(businessWrite) : undefined;
    // Une CRÉATION : un geste de l'utilisateur, une écriture métier acceptée sur une collection.
    if (write && !identityInPath(write.path)) {
      creations.push({
        index,
        action,
        exchange: write,
        data: dedupe([
          ...inputs(),
          ...(write.requestCriteria ?? []).map((entry) => ({
            digest: entry.digest,
            label: entry.field,
            source: 'REQUEST' as const,
          })),
        ]),
      });
    }
    const query = action.network.find(queryOf);
    if (query) {
      queries.push({
        index,
        action,
        exchange: query,
        criteria: dedupe([
          ...inputs(),
          ...(query.requestCriteria ?? []).map((entry) => ({
            digest: entry.digest,
            label: entry.field,
            source: 'REQUEST' as const,
          })),
        ]),
        actionIds: [...group.map((entry) => entry.action.id), action.id],
      });
    }
    if (write || query || (action.navigation?.routes.length ?? 0) > 0) group = [];
  }

  /** Les empreintes d'identifiants observées avant une action (un homonyme qui existait déjà). */
  const seenBefore = (digests: ReadonlySet<string>, before: number): string | undefined => {
    for (const [index, action] of actions.entries()) {
      if (index >= before) return undefined;
      for (const exchange of action.network) {
        const ids = [
          ...(exchange.identifiers ?? []),
          ...(exchange.records ?? []).flatMap((record) => record.identifiers),
        ];
        const hit = ids.find((id) => digests.has(id.digest));
        if (hit) return `${exchange.method} ${exchange.path} (${action.id})`;
      }
    }
    return undefined;
  };

  // ------------------------------------------------------------ chaque recherche après une création
  const correlations: EntityCorrelation[] = [];
  for (const query of queries) {
    const creation = [...creations]
      .reverse()
      .find((entry) => entry.index < query.index && entry.data.length > 0);
    if (!creation) continue;
    const createdIds = new Set(
      (creation.exchange.identifiers ?? [])
        .filter((id) => id.source === 'response' || id.source === 'location')
        .map((id) => id.digest),
    );
    // Recherchée PAR SON IDENTIFIANT (servi à la création, affiché, ou celui d'un résultat) : le lien
    // d'identité est direct (la mémoire des entités le fait) ; aucune corrélation par données
    // métier n'est nécessaire.
    const searched = new Set(query.criteria.map((datum) => datum.digest));
    if (
      [...createdIds].some((digest) => searched.has(digest)) ||
      (query.exchange.records ?? []).some((record) =>
        record.identifiers.some((id) => searched.has(id.digest)),
      )
    )
      continue;
    const created = new Map(creation.data.map((datum) => [datum.digest, datum]));
    const criteria = query.criteria.filter((datum) => created.has(datum.digest));
    const records = query.exchange.records ?? [];
    const scored = records.map((record) => {
      const attributes = new Set((record.attributes ?? []).map((entry) => entry.digest));
      const shared = [...created.values()].filter((datum) => attributes.has(datum.digest));
      const sameId = record.identifiers.some((id) => createdIds.has(id.digest));
      return { record, shared, sameId };
    });
    const matching = scored.filter((entry) => entry.sameId || entry.shared.length > 0);
    if (criteria.length === 0 && matching.length === 0) continue;

    const scoreOf = (entry: (typeof scored)[number]): number => {
      if (entry.sameId) return W.sameId;
      const distinct = new Set(entry.shared.map((datum) => datum.label)).size;
      let score = distinct >= 3 ? W.threeAttributes : distinct === 2 ? W.twoAttributes : W.oneAttribute;
      if (criteria.length > 0) score += W.searchedWithCreationData;
      return score;
    };
    const evidence: string[] = [
      `creation ${creation.action.id}: ${creation.exchange.method} ${creation.exchange.path} → ${String(creation.exchange.status)} with ${String(creation.data.length)} business value(s) (digests)`,
      `search ${query.action.id}: ${query.exchange.method} ${query.exchange.path} — ${queryEvidenceOf(query.exchange).reasons.join('; ')}`,
      ...(criteria.length
        ? [
            `searched with the creation data: ${criteria.map((datum) => `"${created.get(datum.digest)?.label ?? datum.label}" (as "${datum.label}")`).join(', ')} (same salted digests)`,
          ]
        : []),
    ];
    const best = matching.length ? Math.max(...matching.map(scoreOf)) : 0;
    const top = matching.filter((entry) => scoreOf(entry) === best);
    const base = {
      id: `c${String(correlations.length + 1)}`,
      kind: 'CREATE_SEARCH_RESULT' as const,
      creation: {
        actionId: creation.action.id,
        actionIndex: creation.index,
        api: `${creation.exchange.method} ${creation.exchange.path}`,
        attributes: creation.data.length,
      },
      query: {
        actionId: query.action.id,
        actionIndex: query.index,
        actionIds: query.actionIds,
        api: `${query.exchange.method} ${query.exchange.path}`,
        method: query.exchange.method,
        queryEvidence: queryEvidenceOf(query.exchange).reasons,
        resultCount: query.exchange.listSize ?? records.length,
      },
    };
    const matched = (shared: readonly Datum[]): CorrelatedAttribute[] =>
      dedupeLabels([
        ...shared.map((datum) => ({
          label: datum.label,
          seenIn: [
            datum.source === 'INPUT' ? ('CREATE_INPUT' as const) : ('CREATE_REQUEST' as const),
            ...(criteria.some((entry) => entry.digest === datum.digest)
              ? (['SEARCH_CRITERION'] as const)
              : []),
            'RESULT_RECORD' as const,
          ],
        })),
        ...criteria
          .filter((datum) => !shared.some((entry) => entry.digest === datum.digest))
          .map((datum) => ({
            label: created.get(datum.digest)?.label ?? datum.label,
            seenIn: ['CREATE_INPUT' as const, 'SEARCH_CRITERION' as const],
          })),
      ]);

    // Des HOMONYMES : plusieurs résultats correspondent autant → aucun n'est choisi.
    if (top.length > 1) {
      correlations.push({
        ...base,
        status: 'AMBIGUOUS',
        confidence: round(Math.min(best, W.ambiguousCap)),
        sameEntityCandidate: false,
        matched: matched(top[0]?.shared ?? []),
        candidates: top.map((entry) => entry.record.index),
        evidence: [
          ...evidence,
          `${String(top.length)} results carry the same creation data (homonyms): none is chosen`,
        ],
      });
      continue;
    }
    const chosen = top[0];
    // La recherche a utilisé les données de la création, mais aucun attribut de résultat n'est lisible :
    // un résultat UNIQUE reste un candidat faible.
    const fallback =
      !chosen && records.length === 1 && records[0] && !(records[0].attributes ?? []).length
        ? records[0]
        : undefined;
    const record: ExchangeRecord | undefined = chosen?.record ?? fallback;
    let confidence = chosen ? scoreOf(chosen) : fallback ? W.oneAttribute : W.oneAttribute - 0.1;
    if (record && (query.exchange.listSize ?? records.length) === 1) confidence += W.uniqueResult;
    if (chosen && matching.length === 1 && records.length > 1) confidence += W.uniqueResult;
    const open = record ? openedAfter(actions, query.index, record) : undefined;
    if (open) confidence += W.opened;
    confidence = round(Math.min(0.97, confidence));
    const prior = record
      ? seenBefore(new Set(record.identifiers.map((id) => id.digest)), creation.index)
      : undefined;
    if (chosen)
      evidence.push(
        chosen.sameId
          ? `result #${String(chosen.record.index)} carries the identifier served by the creation`
          : `result #${String(chosen.record.index)} carries ${String(new Set(chosen.shared.map((datum) => datum.label)).size)} creation value(s): ${[...new Set(chosen.shared.map((datum) => `"${datum.label}"`))].join(', ')}`,
      );
    else if (fallback) evidence.push('a single result, its attributes unreadable: a weak candidate');
    if (chosen && matching.length > 1)
      evidence.push(
        `${String(matching.length)} results carry creation data; only result #${String(chosen.record.index)} carries the most (the others are homonyms with fewer common values)`,
      );
    if (open) evidence.push(`the result was opened: ${open.via} (${open.actionId})`);
    if (prior)
      evidence.push(`the result was observed BEFORE the creation (${prior}): maybe an existing homonym`);
    const status: CorrelationStatus = prior
      ? 'AMBIGUOUS'
      : confidence >= W.confirmed
        ? 'CONFIRMED'
        : confidence >= W.probable
          ? 'PROBABLE'
          : 'UNCERTAIN';
    correlations.push({
      ...base,
      status,
      confidence: prior ? Math.min(confidence, W.ambiguousCap) : confidence,
      sameEntityCandidate: status === 'CONFIRMED' || status === 'PROBABLE',
      matched: matched(chosen?.shared ?? []),
      ...(record
        ? {
            result: {
              index: record.index,
              identifiers: record.identifiers.map((id) => ({
                field: id.field,
                ...(id.value !== undefined ? { value: id.value } : {}),
                digest: id.digest,
              })),
              sameIdAsCreation: chosen?.sameId ?? false,
            },
          }
        : {}),
      ...(open ? { open } : {}),
      evidence,
    });
  }
  return correlations;
}

/**
 * Les PREUVES qu'une corrélation retenue apporte au suivi des entités : l'identité du résultat
 * (découverte après coup) est attachée à la création, à la recherche et à l'ouverture. Seulement
 * pour une corrélation CONFIRMED / PROBABLE dont le résultat porte une identité.
 */
export function correlationEvidence(
  correlations: readonly EntityCorrelation[],
  actions: readonly SemanticRecordedAction[],
  nextId: () => string,
): EntityEvidence[] {
  const evidence: EntityEvidence[] = [];
  for (const correlation of correlations) {
    if (!correlation.sameEntityCandidate || !correlation.result) continue;
    const primary = correlation.result.identifiers[0];
    if (!primary) continue;
    const identity: EntityIdentity = {
      ...(primary.value !== undefined ? { value: primary.value } : {}),
      digest: primary.digest,
      source: 'NETWORK_RESPONSE',
      field: primary.field,
      confidence: IDENTITY_CONFIDENCE.NETWORK_RESPONSE,
    };
    const openAction = correlation.open ? actions[correlation.open.actionIndex] : undefined;
    const openPath = openAction?.network.find((exchange) => identityInPath(exchange.path))?.path;
    const resource =
      (openPath ? identityInPath(openPath)?.resource : undefined) ??
      collectionOf(correlation.creation.api.split(' ')[1] ?? '');
    const object = `correlation:${correlation.id}`;
    const common = {
      identity,
      ...(resource ? { resource } : {}),
      object,
      details: {
        correlation: correlation.id,
        confidence: correlation.confidence,
        ...(actions[correlation.creation.actionIndex]
          ? { label: labelOf(actions[correlation.creation.actionIndex] as SemanticRecordedAction) }
          : {}),
      },
    };
    const creationAction = actions[correlation.creation.actionIndex];
    evidence.push({
      id: nextId(),
      type: 'CORRELATED_CREATION',
      actionIndex: correlation.creation.actionIndex,
      ...(creationAction
        ? { actionId: creationAction.id, rawEventIds: creationAction.rawEventIds }
        : { rawEventIds: [] }),
      ...common,
      description: `${correlation.id}: the entity created by ${correlation.creation.actionId} (${correlation.creation.api}) is retrieved by its business data in ${correlation.query.actionId}; its identity ${primary.value ?? '(digest)'} is discovered there (${correlation.status} ${String(correlation.confidence)})`,
    });
    for (const actionId of correlation.query.actionIds) {
      const index = actions.findIndex((action) => action.id === actionId);
      const action = actions[index];
      if (!action) continue;
      evidence.push({
        id: nextId(),
        type: 'SEARCH_RESULT',
        actionIndex: index,
        actionId,
        rawEventIds: action.rawEventIds,
        ...common,
        description: `${correlation.id}: ${correlation.query.api} returns a result carrying the creation data (${correlation.matched.map((entry) => `"${entry.label}"`).join(', ') || 'a single result'})`,
      });
    }
  }
  return evidence;
}

/** L'ouverture du résultat : une lecture de son identité, ou un élément cliqué qui la montre. */
function openedAfter(
  actions: readonly SemanticRecordedAction[],
  after: number,
  record: ExchangeRecord,
): { actionId: string; actionIndex: number; via: string } | undefined {
  const digests = new Set(record.identifiers.map((id) => id.digest));
  const values = record.identifiers.flatMap((id) => (id.value !== undefined ? [id.value] : []));
  for (const [index, action] of actions.entries()) {
    if (index <= after) continue;
    for (const exchange of action.network) {
      const hit = (exchange.identifiers ?? []).find((id) => id.source === 'path' && digests.has(id.digest));
      if (hit) return { actionId: action.id, actionIndex: index, via: `${exchange.method} ${exchange.path}` };
    }
    for (const route of action.navigation?.routes ?? []) {
      const found = identityInPath(route);
      if (found && values.some((value) => sameValue(value, found.value)))
        return { actionId: action.id, actionIndex: index, via: `route ${route}` };
    }
    if (
      action.type === 'CLICK' &&
      identifierTokens(labelOf(action)).some((token) => values.some((value) => sameValue(value, token)))
    )
      return {
        actionId: action.id,
        actionIndex: index,
        via: `the clicked "${labelOf(action).slice(0, 60)}" shows it`,
      };
  }
  return undefined;
}

function dedupe(data: readonly Datum[]): Datum[] {
  const seen = new Map<string, Datum>();
  for (const datum of data) if (!seen.has(datum.digest)) seen.set(datum.digest, datum);
  return [...seen.values()];
}

function dedupeLabels(entries: readonly CorrelatedAttribute[]): CorrelatedAttribute[] {
  const seen = new Map<string, CorrelatedAttribute>();
  for (const entry of entries) {
    const known = seen.get(entry.label);
    if (known) known.seenIn = [...new Set([...known.seenIn, ...entry.seenIn])];
    else seen.set(entry.label, { ...entry, seenIn: [...entry.seenIn] });
  }
  return [...seen.values()];
}
