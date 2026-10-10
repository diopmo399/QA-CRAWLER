import type { ExchangeIdentifier } from '../../functional/model.js';
import type { RawRecordedEvent, SemanticRecordedAction } from '../model.js';
import {
  SEARCH_LABEL,
  identifierTokens,
  identityInPath,
  isListRead,
  labelOf,
  routePattern,
  sameValue,
} from '../business/signals.js';
import { ROLE_WEIGHTS } from '../business/identity-role.js';
import type { CollectionRecord, IdentityCandidate, IdentityType, WorkCollection } from './model.js';

/**
 * COLLECTION OBSERVER : les ensembles d'enregistrements identifiables que l'application montre — lus
 * (une réponse de lecture qui sert une liste : un BFF, une API) ou affichés (des lignes du DOM) — et
 * la SÉLECTION d'un enregistrement par l'humain. Les noms des champs (taskId, businessKey…) sont des
 * indices pour typer une identité, jamais des règles : deux identités d'un même enregistrement
 * restent deux identités distinctes.
 */

/** Le type d'une identité, d'après son champ (indice) et sa forme. */
/**
 * La FORME d'une identité (uuid, nombre, code) et sa place (principale) : jamais le nom du champ —
 * « id », « …Key » ou « …Ref » ne disent rien de son rôle (voir identity-role.ts).
 */
export function identityTypeOf(value: string | undefined, primary: boolean): IdentityType {
  if (value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    return 'UUID';
  if (primary) return 'ID';
  if (value !== undefined && /^\d+$/.test(value)) return 'ID';
  return 'CODE';
}

/**
 * Les identités d'un enregistrement, dans l'ordre de la réponse. Le rôle de chacune est INCONNU
 * tant que le parcours ne dit rien d'elle (montrée, saisie, identité d'une autre entité…).
 */
export function candidatesOf(identifiers: readonly ExchangeIdentifier[]): IdentityCandidate[] {
  return identifiers.map((id, index) => ({
    type: identityTypeOf(id.value, index === 0),
    field: id.field,
    ...(id.value !== undefined ? { value: id.value } : {}),
    digest: id.digest,
    source: id.source === 'path' ? ('NETWORK_PATH' as const) : ('NETWORK_RESPONSE' as const),
    confidence: id.value !== undefined ? 0.9 : 0.8,
    semanticRole: 'UNKNOWN' as const,
    roleConfidence: ROLE_WEIGHTS.unknown,
    roleEvidence: [`field "${id.field}" in a response: a field name is never a role`],
  }));
}

/** Les collections lues pendant le parcours (lectures réussies qui servent des enregistrements identifiables). */
export function observeCollections(
  actions: readonly SemanticRecordedAction[],
  evidenceOf: (description: string, action: SemanticRecordedAction) => string,
): WorkCollection[] {
  const collections = new Map<string, WorkCollection>();
  for (const [index, action] of actions.entries()) {
    for (const exchange of action.network) {
      // Une lecture (GET), ou une liste servie par une écriture HTTP (POST de recherche d'un BFF).
      if (!exchange.records?.length || (exchange.method !== 'GET' && !isListRead(exchange))) continue;
      if (exchange.status === undefined || exchange.status >= 400) continue;
      const key = `collection:${exchange.method} ${routePattern(exchange.path, 6)}`;
      // Un enregistrement sans identifiant (seulement des attributs) ne se sélectionne pas comme une task.
      const records: CollectionRecord[] = exchange.records
        .filter((record) => record.identifiers.length > 0)
        .map((record) => ({
          index: record.index,
          identityCandidates: candidatesOf(record.identifiers),
          ...(record.state ? { state: record.state } : {}),
        }));
      const previous = actions[index - 1];
      const search =
        SEARCH_LABEL.test(labelOf(action)) ||
        (previous?.type === 'FILL' && SEARCH_LABEL.test(`${labelOf(previous)} ${labelOf(action)}`));
      const evidenceId = evidenceOf(
        `${exchange.method} ${exchange.path} → ${String(exchange.status)}: ${String(records.length)} identifiable record(s)${
          records[0]
            ? ` (e.g. ${records[0].identityCandidates
                .map((candidate) => `${candidate.field ?? '?'}=${candidate.value ?? '(digest)'}`)
                .join(', ')})`
            : ''
        }`,
        action,
      );
      const existing = collections.get(key);
      if (existing) {
        // Une relecture : les enregistrements du dernier passage remplacent les précédents (la liste
        // évolue), chaque passage reste une observation.
        existing.records = mergeRecords(existing.records, records);
        existing.observations.push({
          actionId: action.id,
          actionIndex: index,
          recordCount: records.length,
          evidenceId,
        });
        existing.searchResults = existing.searchResults && search;
        continue;
      }
      collections.set(key, {
        key,
        source: { type: 'NETWORK', method: exchange.method, path: routePattern(exchange.path, 6) },
        records,
        observations: [{ actionId: action.id, actionIndex: index, recordCount: records.length, evidenceId }],
        searchResults: search,
      });
    }
  }
  return [...collections.values()];
}

function mergeRecords(a: readonly CollectionRecord[], b: readonly CollectionRecord[]): CollectionRecord[] {
  const merged = [...a];
  for (const record of b) {
    const head = record.identityCandidates[0];
    const same = merged.findIndex((entry) => entry.identityCandidates[0]?.digest === head?.digest);
    if (same >= 0) merged[same] = record;
    else merged.push(record);
  }
  return merged.map((record, index) => ({ ...record, index }));
}

/** Ce que montre l'élément cliqué : son libellé, son texte, la clé de sa ligne, son lien. */
export function shownValuesOf(action: SemanticRecordedAction, raw: RawRecordedEvent | undefined): string[] {
  const element = raw?.element;
  const texts = [
    labelOf(action),
    element?.text ?? '',
    element?.row ?? '',
    ...(element?.rowKey ?? []).map((key) => key.value),
  ];
  const values = new Set<string>();
  for (const text of texts) for (const token of identifierTokens(text)) values.add(token);
  for (const key of element?.rowKey ?? []) if (key.value.trim()) values.add(key.value.trim());
  const linked = element?.href ? identityInPath(element.href) : undefined;
  if (linked) values.add(linked.value);
  return [...values];
}

/** L'enregistrement d'une collection que l'élément cliqué montre (par valeur ou empreinte). */
export function selectedRecord(
  shown: readonly string[],
  collection: WorkCollection,
  digest?: (value: string) => string,
): { record: CollectionRecord; candidate: IdentityCandidate; value: string } | undefined {
  for (const record of collection.records)
    for (const candidate of record.identityCandidates)
      for (const value of shown)
        if (
          (candidate.value !== undefined && sameValue(candidate.value, value)) ||
          (digest !== undefined && candidate.digest !== undefined && digest(value) === candidate.digest)
        )
          return { record, candidate, value };
  return undefined;
}
