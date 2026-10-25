import type { ConsistencyConfig } from '../config/quality-schema.js';
import { foldValue } from '../functional/http-structure.js';
import type { BusinessProofReport } from '../flows/business-proof.js';
import type { FlowTestDataEntry } from '../model/flow-run.js';
import type { ConsistencyResult, ConsistencyRule, ConsistencyStatus, QualityEvidence } from './model.js';
import {
  WRITE_METHODS,
  digestMatch,
  exchangeMatches,
  fieldMatches,
  isAccepted,
  recordHas,
  resolveValue,
  shortDigest,
  type ExtractedValue,
  type ObservedExchange,
  type ResolvedValue,
  type ValueSources,
} from './values.js';

/**
 * LE MOTEUR DE COHÉRENCE DES DONNÉES : une donnée du run suivie à travers le workflow —
 *
 *   saisie (UI) → requête envoyée → réponse → écran final → recherche ultérieure
 *
 * plus les règles déclarées (relations, clés uniques, effets de bord). Tout se compare sur des
 * empreintes salées du run ; aucune corrélation n'est tirée de la seule proximité dans le temps (une
 * valeur est reliée à une requête parce que la requête la PORTE). Une observation partielle le dit
 * (`limits`) et une corrélation incertaine reste incertaine.
 */

export interface ConsistencyInput {
  runId: string;
  flow: string;
  salt?: string;
  networkObserved: boolean;
  exchanges: readonly ObservedExchange[];
  testData: readonly FlowTestDataEntry[];
  runValue(key: string): { value: string; displayable: boolean } | undefined;
  extracted(name: string): ExtractedValue | undefined;
  /** Le texte de l'écran final (lecture seule), s'il a pu être lu. */
  uiText?: string;
  businessProof?: BusinessProofReport;
  /** Les règles déclarées sur le flow (absentes : vérifications automatiques seulement). */
  config?: ConsistencyConfig;
  showValues: boolean;
}

export interface ConsistencyOutput {
  results: ConsistencyResult[];
  evidence: QualityEvidence[];
}

const PARTIAL = 'only the browser traffic of this flow is observed (server-side processing is not visible)';

export function checkConsistency(input: ConsistencyInput): ConsistencyOutput {
  const results: ConsistencyResult[] = [];
  const evidence: QualityEvidence[] = [];
  let sequence = 0;
  const sources: ValueSources = {
    ...(input.salt !== undefined ? { salt: input.salt } : {}),
    runValue: (key) => input.runValue(key),
    extracted: (name) => input.extracted(name),
  };
  const label = (exchange: ObservedExchange): string =>
    `${exchange.method} ${exchange.path}${exchange.status !== undefined ? ` → ${String(exchange.status)}` : ''}`;
  const proof = (
    exchange: ObservedExchange,
    details: Record<string, string | number | boolean>,
    step?: number,
  ): string => {
    sequence += 1;
    const id = `${input.flow}#consistency#e${String(sequence)}`;
    evidence.push({
      id,
      type: 'NETWORK',
      source: label(exchange),
      confidence: 0.95,
      runId: input.runId,
      flow: input.flow,
      ...((step ?? exchange.step) !== undefined ? { step: step ?? exchange.step } : {}),
      ...(exchange.observationId ? { correlationId: exchange.observationId } : {}),
      details: { method: exchange.method, path: exchange.path, ...details },
    });
    return id;
  };
  const domProof = (details: Record<string, string | number | boolean>): string => {
    sequence += 1;
    const id = `${input.flow}#consistency#e${String(sequence)}`;
    evidence.push({
      id,
      type: 'DOM',
      source: 'final screen',
      confidence: 0.85,
      runId: input.runId,
      flow: input.flow,
      details,
    });
    return id;
  };
  const add = (
    rule: ConsistencyRule,
    status: ConsistencyStatus,
    fields: Omit<
      ConsistencyResult,
      'id' | 'flow' | 'rule' | 'status' | 'limits' | 'evidence' | 'declared' | 'confidence'
    > &
      Partial<Pick<ConsistencyResult, 'limits' | 'evidence' | 'declared' | 'confidence'>>,
  ): void => {
    results.push({
      id: `${rule}-${String(results.length + 1)}`,
      flow: input.flow,
      rule,
      status,
      confidence: fields.confidence ?? (status === 'CONSISTENT' || status === 'INCONSISTENT' ? 0.9 : 0.5),
      limits: fields.limits ?? [],
      evidence: fields.evidence ?? [],
      declared: fields.declared ?? input.config !== undefined,
      ...fields,
    });
  };
  const show = (value: ResolvedValue): string =>
    input.showValues && value.displayable && value.text !== undefined
      ? `"${value.text}" (${value.label})`
      : value.label;

  const config = input.config;
  const wanted = config?.keys ? new Set(config.keys) : undefined;
  const tracked = input.testData.filter(
    (entry) => !entry.sensitive && entry.producedAt !== undefined && (!wanted || wanted.has(entry.key)),
  );
  const accepted = (exchange: ObservedExchange): boolean =>
    WRITE_METHODS.has(exchange.method.toUpperCase()) && isAccepted(exchange);

  // A + B : SAISIE → REQUÊTE → RÉPONSE, pour chaque donnée du run saisie dans l'interface.
  for (const entry of tracked) {
    const resolved = resolveValue({ testData: entry.key }, sources);
    if (!resolved.ok) continue;
    const value = resolved.value;
    const produced = entry.producedAt ?? 0;
    const transform = config?.transforms[entry.key];
    if (!input.networkObserved || value.digest === undefined) {
      add('UI_TO_REQUEST', 'NOT_OBSERVABLE', {
        key: entry.key,
        sources: [`UI input step ${String(produced)}`],
        limits: ['the network of this flow was not observed in values'],
      });
      continue;
    }
    // La soumission : la première écriture acceptée à partir de la saisie (la fenêtre de la donnée).
    const submit = input.exchanges.find((exchange) => (exchange.step ?? 0) >= produced && accepted(exchange));
    const window = input.exchanges.filter(
      (exchange) =>
        (exchange.step ?? 0) >= produced &&
        (submit?.step === undefined || (exchange.step ?? 0) <= submit.step),
    );
    let carrier: { exchange: ObservedExchange; field: string; match: 'exact' | 'normalized' } | undefined;
    for (const exchange of window) {
      for (const digest of exchange.requestCriteria ?? []) {
        const match = digestMatch(digest, value, true);
        if (match && (!carrier || (accepted(exchange) && !accepted(carrier.exchange))))
          carrier = { exchange, field: digest.field, match };
      }
    }
    const inputSource = `UI input step ${String(produced)}`;
    if (carrier)
      add('UI_TO_REQUEST', 'CONSISTENT', {
        key: entry.key,
        field: carrier.field,
        sources: [inputSource, `${label(carrier.exchange)} (request)`],
        ...(carrier.match === 'normalized'
          ? { normalization: 'case, accents or spaces normalized by the application' }
          : {}),
        expected: show(value),
        confidence: carrier.match === 'exact' ? 0.95 : 0.85,
        evidence: [proof(carrier.exchange, { field: carrier.field, match: carrier.match, side: 'request' })],
      });
    else if (transform)
      add('UI_TO_REQUEST', 'CONSISTENT', {
        key: entry.key,
        sources: [inputSource, submit ? `${label(submit)} (request)` : 'no request'],
        normalization: `documented transformation: ${transform}`,
        expected: show(value),
        confidence: 0.5,
        limits: ['the transformed value is not compared (documented transformation)'],
      });
    else if (submit)
      add('UI_TO_REQUEST', 'MISSING_DATA', {
        key: entry.key,
        sources: [inputSource, `${label(submit)} (request)`],
        expected: show(value),
        difference: `the value typed at step ${String(produced)} is not in the submitted request`,
        confidence: 0.6,
        limits: [
          'the field may be UI-only, or transformed before sending: declare it in consistency.transforms if expected',
        ],
        evidence: [proof(submit, { key: entry.key, carried: false })],
      });
    else
      add('UI_TO_REQUEST', 'NOT_OBSERVABLE', {
        key: entry.key,
        sources: [inputSource],
        limits: ['no request after the input carried a value'],
      });

    // B : ce qui a été ENVOYÉ est-il ce qui a été RETOURNÉ (enregistré) ?
    if (!carrier || !accepted(carrier.exchange)) continue;
    const returned = carrier.exchange.responseValues ?? [];
    const sameField = returned.filter(
      (digest) =>
        digest.field === carrier.field || fieldMatches(digest.field, carrier.field.split('.').at(-1)),
    );
    const anywhere = returned.find((digest) => digestMatch(digest, value, true));
    const fieldMatch = sameField
      .map((digest) => ({ digest, match: digestMatch(digest, value, true) }))
      .find((entryMatch) => entryMatch.match);
    const sources2 = [
      `${label(carrier.exchange)} (request ${carrier.field})`,
      `${label(carrier.exchange)} (response)`,
    ];
    if (fieldMatch)
      add('REQUEST_TO_RESPONSE', 'CONSISTENT', {
        key: entry.key,
        field: fieldMatch.digest.field,
        sources: sources2,
        ...(fieldMatch.match === 'normalized'
          ? { normalization: 'case, accents or spaces normalized by the server' }
          : {}),
        expected: show(value),
        evidence: [
          proof(carrier.exchange, {
            field: fieldMatch.digest.field,
            match: fieldMatch.match ?? 'exact',
            side: 'response',
          }),
        ],
      });
    else if (sameField.length > 0 && !transform)
      add('REQUEST_TO_RESPONSE', 'INCONSISTENT', {
        key: entry.key,
        field: sameField[0]?.field,
        sources: sources2,
        expected: show(value),
        observed: `another value (${shortDigest(sameField[0]?.digest)})`,
        difference: `the server returned a different ${sameField[0]?.field ?? 'value'} than the one sent`,
        evidence: [
          proof(carrier.exchange, { field: sameField[0]?.field ?? '', match: 'differs', side: 'response' }),
        ],
      });
    else if (anywhere)
      add('REQUEST_TO_RESPONSE', 'CONSISTENT', {
        key: entry.key,
        field: anywhere.field,
        sources: sources2,
        normalization: `returned under another field (${carrier.field} → ${anywhere.field})`,
        expected: show(value),
        confidence: 0.75,
        evidence: [proof(carrier.exchange, { field: anywhere.field, side: 'response' })],
      });
    else
      add('REQUEST_TO_RESPONSE', transform ? 'CONSISTENT' : 'NOT_OBSERVABLE', {
        key: entry.key,
        sources: sources2,
        ...(transform ? { normalization: `documented transformation: ${transform}` } : {}),
        limits: ['the response does not echo this value: the stored value is not observable from it'],
      });
  }

  // C : RÉPONSE → ÉCRAN, les valeurs que l'écran final doit montrer (l'entité ouverte).
  const displayed = new Set(config?.displayed ?? []);
  if (!config && input.businessProof?.open && input.businessProof.key) displayed.add(input.businessProof.key);
  for (const key of displayed) {
    const resolved = resolveValue({ testData: key }, sources);
    if (!resolved.ok || resolved.value.text === undefined) {
      add('RESPONSE_TO_UI', 'NOT_OBSERVABLE', {
        key,
        sources: ['final screen'],
        limits: [resolved.ok ? 'no displayable value' : resolved.reason],
        declared: displayed.size > 0 && !!config,
      });
      continue;
    }
    if (input.uiText === undefined) {
      add('RESPONSE_TO_UI', 'NOT_OBSERVABLE', {
        key,
        sources: ['final screen'],
        limits: ['the final screen could not be read'],
        declared: !!config,
      });
      continue;
    }
    const shown = foldValue(input.uiText).includes(foldValue(resolved.value.text));
    add('RESPONSE_TO_UI', shown ? 'CONSISTENT' : 'INCONSISTENT', {
      key,
      sources: ['run value', 'final screen'],
      expected: show(resolved.value),
      ...(shown
        ? {}
        : {
            difference:
              'the final screen does not show the value of this run (lost, stale, or another entity)',
          }),
      confidence: 0.8,
      limits: ['the text is searched on the whole screen, not in a given field'],
      evidence: [domProof({ key, shown })],
      declared: !!config,
    });
  }

  // D : CRÉATION → RECHERCHE : la recherche retrouve-t-elle l'entité créée, et elle seule ?
  const business = input.businessProof;
  if (business?.key && business.creation && business.search) {
    const search = business.search;
    const resolved = resolveValue({ testData: business.key }, sources);
    const creationWrite = input.exchanges.find(
      (exchange) => exchange.step === business.creation?.step && accepted(exchange),
    );
    const createdIds = (creationWrite?.identifiers ?? []).filter((identifier) =>
      /(^|\.)(id|.*Id|reference|ref|number|code)$/i.test(identifier.field),
    );
    const searchEnd = business.open?.step ?? Number.POSITIVE_INFINITY;
    const reads = input.exchanges.filter(
      (exchange) =>
        (exchange.step ?? 0) >= search.step &&
        (exchange.step ?? 0) < searchEnd &&
        (exchange.records !== undefined || exchange.listSize !== undefined),
    );
    const sourcesD = [
      `creation step ${String(business.creation.step)}`,
      `search step ${String(search.step)}`,
    ];
    if (!resolved.ok || resolved.value.digest === undefined || !input.networkObserved)
      add('CREATE_TO_SEARCH', 'NOT_OBSERVABLE', {
        key: business.key,
        sources: sourcesD,
        limits: ['the network of this flow was not observed in values'],
      });
    else if (reads.length === 0)
      add('CREATE_TO_SEARCH', 'NOT_OBSERVABLE', {
        key: business.key,
        sources: sourcesD,
        limits: ['no search response (list) was observed'],
      });
    else {
      const last = reads.at(-1) as ObservedExchange;
      const records = last.records ?? [];
      const matching = records.filter((record) => recordHas(record, undefined, resolved.value) !== undefined);
      const byId =
        createdIds.length > 0
          ? matching.filter((record) =>
              record.identifiers.some((identifier) =>
                createdIds.some((created) => created.digest === identifier.digest),
              ),
            )
          : [];
      const ev = [
        proof(last, { records: records.length, matching: matching.length, byIdentifier: byId.length }),
      ];
      if (matching.length === 1 && (createdIds.length === 0 || byId.length === 1))
        add('CREATE_TO_SEARCH', 'CONSISTENT', {
          key: business.key,
          sources: sourcesD,
          expected: show(resolved.value),
          evidence: ev,
          ...(createdIds.length === 0
            ? { confidence: 0.75, limits: ['the creation returned no identifier: matched by value only'] }
            : {}),
        });
      else if (matching.length === 1 && byId.length === 0)
        add('CREATE_TO_SEARCH', 'INCONSISTENT', {
          key: business.key,
          sources: sourcesD,
          expected: show(resolved.value),
          difference:
            'the search returned another entity carrying the same value (not the created identifier)',
          evidence: ev,
        });
      else if (matching.length > 1)
        add('CREATE_TO_SEARCH', byId.length === 1 ? 'CONSISTENT' : 'AMBIGUOUS_ENTITY', {
          key: business.key,
          sources: sourcesD,
          expected: show(resolved.value),
          ...(byId.length === 1
            ? {
                limits: [
                  `${String(matching.length)} similar records; the created one is identified by its identifier`,
                ],
              }
            : {
                difference: `${String(matching.length)} records carry the value: the created entity is not identified without ambiguity`,
              }),
          confidence: byId.length === 1 ? 0.85 : 0.5,
          evidence: ev,
        });
      else
        add('CREATE_TO_SEARCH', config?.eventual ? 'PENDING_EVENTUAL_CONSISTENCY' : 'INCONSISTENT', {
          key: business.key,
          sources: sourcesD,
          expected: show(resolved.value),
          difference:
            records.length === 0 && (last.listSize ?? 0) === 0
              ? 'the search returned nothing'
              : 'the search returned other entities, not the created one',
          ...(config?.eventual
            ? { limits: ['declared eventually consistent: the search may index the entity later'] }
            : {}),
          evidence: ev,
        });
    }
  }

  // E : RELATIONS déclarées (la référence portée par l'entité retrouvée).
  const allRecords = input.exchanges.flatMap((exchange) =>
    (exchange.records ?? []).map((record) => ({ exchange, record })),
  );
  for (const relation of config?.relations ?? []) {
    const entity = resolveValue(relation.entity.value, sources);
    const target = resolveValue(relation.expected, sources);
    const ruleId = relation.id ?? relation.field;
    if (!entity.ok || !target.ok) {
      add('RELATION', 'NOT_OBSERVABLE', {
        key: ruleId,
        field: relation.field,
        sources: [],
        limits: [!entity.ok ? entity.reason : !target.ok ? target.reason : ''],
        declared: true,
      });
      continue;
    }
    const found = allRecords.filter(
      ({ record }) => recordHas(record, relation.entity.field, entity.value) !== undefined,
    );
    if (found.length === 0) {
      add('RELATION', 'NOT_OBSERVABLE', {
        key: ruleId,
        field: relation.field,
        sources: ['observed reads'],
        limits: ['the entity was never read during the flow'],
        declared: true,
      });
      continue;
    }
    const distinct = new Set(
      found.map(({ record }) => record.identifiers.map((identifier) => identifier.digest).join(',')),
    );
    if (distinct.size > 1) {
      add('RELATION', 'AMBIGUOUS_ENTITY', {
        key: ruleId,
        field: relation.field,
        sources: ['observed reads'],
        difference: `${String(distinct.size)} entities carry the key`,
        declared: true,
      });
      continue;
    }
    const { exchange, record } = found.at(-1) as (typeof found)[number];
    const ok = recordHas(record, relation.field, target.value) !== undefined;
    const carries = [...(record.attributes ?? []), ...record.identifiers].some((digest) =>
      fieldMatches(digest.field, relation.field),
    );
    add('RELATION', ok ? 'CONSISTENT' : carries ? 'INCONSISTENT' : 'NOT_OBSERVABLE', {
      key: ruleId,
      field: relation.field,
      sources: [`${label(exchange)} (record)`],
      expected: `${show(entity.value)} → ${relation.field} = ${show(target.value)}`,
      ...(ok ? {} : carries ? { difference: `${relation.field} references another entity` } : {}),
      ...(carries ? {} : { limits: [`the observed record does not carry ${relation.field}`] }),
      evidence: [
        proof(exchange, { field: relation.field, match: ok ? 'exact' : carries ? 'differs' : 'absent' }),
      ],
      declared: true,
    });
  }

  // F : DOUBLONS, seulement par une clé métier DÉCLARÉE unique (jamais sur un nom seul).
  for (const unique of config?.uniqueKeys ?? []) {
    const value = resolveValue(unique.value, sources);
    if (!value.ok) {
      add('DUPLICATE', 'NOT_OBSERVABLE', {
        key: unique.field,
        field: unique.field,
        sources: [],
        limits: [value.reason],
        declared: true,
      });
      continue;
    }
    let worst: { exchange: ObservedExchange; count: number } | undefined;
    for (const exchange of input.exchanges) {
      if (!exchange.records) continue;
      const count = exchange.records.filter(
        (record) => recordHas(record, unique.field, value.value, false) !== undefined,
      ).length;
      if (!worst || count > worst.count) worst = { exchange, count };
    }
    if (!worst || worst.count === 0)
      add('DUPLICATE', 'NOT_OBSERVABLE', {
        key: unique.field,
        field: unique.field,
        sources: ['observed reads'],
        limits: ['no observed list carries this key'],
        declared: true,
      });
    else
      add('DUPLICATE', worst.count > 1 ? 'INCONSISTENT' : 'CONSISTENT', {
        key: unique.field,
        field: unique.field,
        sources: [`${label(worst.exchange)} (records)`],
        expected: `one record with ${unique.field} = ${show(value.value)}`,
        observed: `${String(worst.count)} record(s)`,
        ...(worst.count > 1
          ? { difference: `${String(worst.count)} records share the unique key ${unique.field}: duplicate` }
          : {}),
        evidence: [proof(worst.exchange, { field: unique.field, records: worst.count })],
        declared: true,
      });
  }

  // G : EFFETS DE BORD déclarés : écritures hors liste, créations en trop, lignes ajoutées à une liste relue.
  const side = config?.sideEffects;
  if (side) {
    if (!input.networkObserved)
      add('SIDE_EFFECT', 'NOT_OBSERVABLE', {
        sources: [],
        limits: ['the network of this flow was not observed'],
        declared: true,
      });
    else {
      const writes = input.exchanges.filter(accepted);
      const unexpected =
        side.allowedWrites.length === 0
          ? []
          : writes.filter(
              (exchange) =>
                !side.allowedWrites.some((allowed) =>
                  exchangeMatches(exchange, allowed.method, allowed.path),
                ),
            );
      const creations = writes.filter(
        (exchange) =>
          exchange.method.toUpperCase() === 'POST' &&
          (exchange.status === 201 || (exchange.identifiers?.length ?? 0) > 0),
      );
      // La même liste relue avant et après : les identifiants apparus.
      const firstCreate = creations[0]?.step;
      let added = 0;
      let listEvidence: string | undefined;
      if (firstCreate !== undefined) {
        const reads = input.exchanges.filter(
          (exchange) => exchange.method.toUpperCase() === 'GET' && exchange.records,
        );
        for (const before of reads.filter((exchange) => (exchange.step ?? 0) < firstCreate)) {
          const after = reads
            .filter((exchange) => (exchange.step ?? 0) > firstCreate && exchange.path === before.path)
            .at(-1);
          if (!after) continue;
          const known = new Set(
            (before.records ?? []).flatMap((record) =>
              record.identifiers.map((identifier) => identifier.digest),
            ),
          );
          const fresh = (after.records ?? []).filter(
            (record) =>
              record.identifiers.length > 0 &&
              !record.identifiers.some((identifier) => known.has(identifier.digest)),
          ).length;
          if (fresh > added) {
            added = fresh;
            listEvidence = proof(after, { addedRecords: fresh, comparedWith: before.path });
          }
        }
      }
      const max = side.maxCreated;
      const problems = [
        ...unexpected.map((exchange) => `unexpected write ${label(exchange)}`),
        ...(max !== undefined && creations.length > max
          ? [`${String(creations.length)} creation(s) for at most ${String(max)}`]
          : []),
        ...(max !== undefined && added > max
          ? [`${String(added)} record(s) appeared in the list for at most ${String(max)} creation(s)`]
          : []),
      ];
      add('SIDE_EFFECT', problems.length > 0 ? 'INCONSISTENT' : 'CONSISTENT', {
        sources: ['accepted writes of the flow', ...(listEvidence ? ['list read before / after'] : [])],
        observed: `${String(writes.length)} accepted write(s), ${String(creations.length)} creation(s)${listEvidence ? `, ${String(added)} new record(s) in the list` : ''}`,
        ...(problems.length > 0 ? { difference: problems.join('; ') } : {}),
        limits: [PARTIAL],
        evidence: [
          ...unexpected.slice(0, 4).map((exchange) => proof(exchange, { write: true })),
          ...(listEvidence ? [listEvidence] : []),
        ],
        declared: true,
      });
    }
  }
  return { results, evidence };
}
