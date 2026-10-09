import type { ExchangeIdentifier } from '../../functional/model.js';
import type { RawRecordedEvent, SemanticRecordedAction } from '../model.js';
import {
  SEARCH_LABEL,
  identifierTokens,
  identityInPath,
  labelOf,
  routePattern,
  sameValue,
} from '../business/signals.js';
import type { CollectionRecord, IdentityCandidate, IdentityType, WorkCollection } from './model.js';

/**
 * COLLECTION OBSERVER : les ensembles d'enregistrements identifiables que l'application montre — lus
 * (une réponse de lecture qui sert une liste : un BFF, une API) ou affichés (des lignes du DOM) — et
 * la SÉLECTION d'un enregistrement par l'humain. Les noms des champs (taskId, businessKey…) sont des
 * indices pour typer une identité, jamais des règles : deux identités d'un même enregistrement
 * restent deux identités distinctes.
 */

/** Le type d'une identité, d'après son champ (indice) et sa forme. */
export function identityTypeOf(
  field: string | undefined,
  value: string | undefined,
  primary: boolean,
): IdentityType {
  const name = (field ?? '').split('.').at(-1) ?? '';
  if (value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    return 'UUID';
  if (primary) return 'ID';
  if (/(key|code)$/i.test(name)) return 'BUSINESS_KEY';
  if (/(ref|reference|number|numero|no)$/i.test(name)) return 'REFERENCE';
  if (/[a-z](Id|ID|_id)$/.test(name)) return 'FOREIGN_ID';
  if (value !== undefined && /^\d+$/.test(value)) return 'ID';
  return 'CODE';
}

/** L'identifiant principal d'un enregistrement : un champ « id » d'abord, sinon le premier. */
function primaryIndex(identifiers: readonly ExchangeIdentifier[]): number {
  const own = identifiers.findIndex((id) => /^(id|uuid|guid)$/i.test(id.field.split('.').at(-1) ?? ''));
  if (own >= 0) return own;
  const suffixed = identifiers.findIndex((id) => /[a-z](Id|ID|Uuid)$/.test(id.field.split('.').at(-1) ?? ''));
  return suffixed >= 0 ? suffixed : 0;
}

export function candidatesOf(identifiers: readonly ExchangeIdentifier[]): IdentityCandidate[] {
  const primary = primaryIndex(identifiers);
  const candidates = identifiers.map((id, index) => ({
    type: identityTypeOf(id.field, id.value, index === primary),
    field: id.field,
    ...(id.value !== undefined ? { value: id.value } : {}),
    digest: id.digest,
    source: id.source === 'path' ? ('NETWORK_PATH' as const) : ('NETWORK_RESPONSE' as const),
    confidence: id.value !== undefined ? 0.9 : 0.8,
  }));
  // Le principal d'abord.
  const [head] = candidates.splice(primary, 1);
  return head ? [head, ...candidates] : candidates;
}

/** Les collections lues pendant le parcours (lectures réussies qui servent des enregistrements identifiables). */
export function observeCollections(
  actions: readonly SemanticRecordedAction[],
  evidenceOf: (description: string, action: SemanticRecordedAction) => string,
): WorkCollection[] {
  const collections = new Map<string, WorkCollection>();
  for (const [index, action] of actions.entries()) {
    for (const exchange of action.network) {
      if (exchange.method !== 'GET' || !exchange.records?.length) continue;
      if (exchange.status === undefined || exchange.status >= 400) continue;
      const key = `collection:GET ${routePattern(exchange.path, 6)}`;
      const records: CollectionRecord[] = exchange.records.map((record) => ({
        index: record.index,
        identityCandidates: candidatesOf(record.identifiers),
        ...(record.state ? { state: record.state } : {}),
      }));
      const previous = actions[index - 1];
      const search =
        SEARCH_LABEL.test(labelOf(action)) ||
        (previous?.type === 'FILL' && SEARCH_LABEL.test(`${labelOf(previous)} ${labelOf(action)}`));
      const evidenceId = evidenceOf(
        `GET ${exchange.path} → ${String(exchange.status)}: ${String(records.length)} identifiable record(s)${
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
        source: { type: 'NETWORK', method: 'GET', path: routePattern(exchange.path, 6) },
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
