import { ConnectorError, type ExtractionContext, type SourceConnector } from './connector.js';
import { classify, type ClassifyOptions } from './classify.js';
import type { ExtractedDocument } from './document.js';
import { fingerprint, similarity, SIMILARITY_THRESHOLD } from './fingerprint.js';
import type {
  AcceptanceCriterion,
  BusinessRule,
  CanonicalEntity,
  Confidence,
  DuplicateCheck,
  ExtractedItem,
  ImportBatch,
  ImportIssue,
  ImportStatus,
  ItemDecision,
  LinkDecision,
  LinkEnd,
  LinkOrigin,
  LinkType,
  Requirement,
  RequirementsRepository,
  Revision,
  TraceabilityLink,
} from './model.js';
import { newId, type RequirementsStore } from './repository.js';

/**
 * LE PIPELINE D'IMPORTATION, commun à toutes les sources :
 *
 *   validation de l'entrée → extraction (connecteur) → normalisation (classify) → doublons et
 *   conflits (contre le référentiel) → lot VALIDATION_REQUIRED → décisions humaines → publication.
 *
 * Rien n'entre dans le référentiel sans décision. Une lecture partielle n'est publiée qu'avec un
 * accord explicite. Une suggestion automatique n'écrase jamais une décision humaine.
 */
export class PipelineError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'INVALID_DECISION'
      | 'ALREADY_PUBLISHED'
      | 'CONFLICT_REQUIRES_MERGE'
      | 'PARTIAL_NOT_ACKNOWLEDGED'
      | 'NOTHING_TO_PUBLISH',
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

export interface ImportOptions {
  classify?: ClassifyOptions;
}

export async function importSource<Input>(
  store: RequirementsStore,
  connector: SourceConnector<Input>,
  input: Input,
  context: ExtractionContext,
  options: ImportOptions = {},
): Promise<ImportBatch> {
  const now = context.now.toISOString();
  const batch: ImportBatch = {
    id: newId('imp'),
    connector: connector.kind,
    status: 'RUNNING',
    createdAt: now,
    updatedAt: now,
    source: { sourceId: '', title: '' },
    completeness: 'EMPTY',
    items: [],
    issues: [],
    missingFromSource: [],
  };
  const invalid = connector.validate(input, context);
  if (invalid.some((issue) => issue.severity === 'ERROR')) {
    batch.status = 'FAILED';
    batch.issues = invalid;
    await store.update(() => store.writeBatch(batch));
    return batch;
  }
  let document: ExtractedDocument;
  try {
    document = await connector.extract(input, context);
  } catch (error) {
    batch.status = 'FAILED';
    batch.issues = [
      ...invalid,
      {
        severity: 'ERROR',
        code: error instanceof ConnectorError ? error.code : 'EXTRACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    await store.update(() => store.writeBatch(batch));
    return batch;
  }
  const { items, issues } = classify(document, now, options.classify);
  return store.update(async () => {
    const repository = await store.readRepository();
    for (const item of items) item.duplicate = duplicateOf(repository, item);
    batch.source = { ...document.source };
    batch.completeness = document.completeness;
    batch.items = items;
    batch.issues = [...invalid, ...document.issues, ...issues];
    batch.missingFromSource = missingFrom(repository, document.source.sourceId, items);
    batch.status = statusOf(batch);
    batch.updatedAt = now;
    await store.writeBatch(batch);
    return batch;
  });
}

/** Ce que le référentiel sait déjà de ce candidat. */
export function duplicateOf(repository: RequirementsRepository, item: ExtractedItem): DuplicateCheck {
  if (item.kind === 'INFORMATION') return { status: 'NEW' };
  if (item.externalId) {
    const same = repository.entities.filter((entity) => entity.externalId === item.externalId);
    const fromThisSource = same.find((entity) =>
      entity.sources.some((source) => source.sourceId === item.source.sourceId),
    );
    if (fromThisSource) {
      const previous = fromThisSource.sources.find((source) => source.sourceId === item.source.sourceId);
      if (previous?.fingerprint === item.source.fingerprint)
        return { status: 'UNCHANGED', entityId: fromThisSource.id };
      const edited = [...fromThisSource.history].reverse().find((revision) => revision.edited);
      return {
        status: 'SOURCE_CHANGED',
        entityId: fromThisSource.id,
        note: `${item.externalId} changed in its source since version ${String(fromThisSource.version)}${edited ? `; its text was corrected by a person in version ${String(edited.version)}: accepting replaces that text` : ''}`,
      };
    }
    const other = same[0];
    if (other)
      return {
        status: 'SAME_ID_OTHER_SOURCE',
        entityId: other.id,
        note: `${item.externalId} already comes from ${other.sources.map((source) => source.title).join(', ')}`,
      };
  }
  // Sans identifiant : même source et même lieu, puis même empreinte, puis texte proche (proposition).
  const located = repository.entities.find((entity) =>
    entity.sources.some(
      (source) =>
        source.sourceId === item.source.sourceId &&
        source.location.block === item.source.location.block &&
        source.location.row === item.source.location.row,
    ),
  );
  if (located && !located.externalId) {
    const previous = located.sources.find((source) => source.sourceId === item.source.sourceId);
    if (previous?.fingerprint === item.source.fingerprint)
      return { status: 'UNCHANGED', entityId: located.id };
  }
  const same = repository.entities.find((entity) =>
    entity.sources.some((source) => source.fingerprint === item.source.fingerprint),
  );
  if (same) return { status: 'UNCHANGED', entityId: same.id };
  let best: { entity: CanonicalEntity; score: number } | undefined;
  for (const entity of repository.entities) {
    if (entity.kind !== item.kind) continue;
    const score = similarity(entity.description, item.description);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { entity, score };
  }
  if (best)
    return {
      status: 'SIMILAR',
      entityId: best.entity.id,
      similarity: Math.round(best.score * 100) / 100,
      note: 'close text without a common identifier: merge only if it is the same requirement',
    };
  return { status: 'NEW' };
}

/** Les entités venues de cette source et absentes de sa nouvelle version (signalées, jamais supprimées). */
function missingFrom(repository: RequirementsRepository, sourceId: string, items: ExtractedItem[]): string[] {
  const ids = new Set(items.map((item) => item.externalId).filter(Boolean));
  const prints = new Set(items.map((item) => item.source.fingerprint));
  return repository.entities
    .filter((entity) => entity.sources.some((source) => source.sourceId === sourceId))
    .filter((entity) =>
      entity.externalId
        ? !ids.has(entity.externalId)
        : !entity.sources.some((source) => source.sourceId === sourceId && prints.has(source.fingerprint)),
    )
    .map((entity) => entity.id);
}

const toDecide = (item: ExtractedItem): boolean =>
  item.kind !== 'INFORMATION' && item.duplicate.status !== 'UNCHANGED' && !item.published;

export function statusOf(batch: ImportBatch): ImportStatus {
  if (batch.issues.some((issue) => issue.severity === 'ERROR') && batch.items.length === 0) return 'FAILED';
  if (batch.completeness === 'PARTIAL') return 'PARTIAL';
  if (batch.items.some(toDecide)) return 'VALIDATION_REQUIRED';
  return batch.issues.some((issue) => issue.severity !== 'INFO') ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
}

export interface DecisionInput {
  itemId: string;
  decision: Omit<ItemDecision, 'at'>;
}

/** Enregistrer des décisions humaines sur les candidats d'un lot (rien n'est encore publié). */
export function decide(
  store: RequirementsStore,
  batchId: string,
  decisions: DecisionInput[],
  now: Date,
): Promise<ImportBatch> {
  return store.update(async () => {
    const batch = await store.readBatch(batchId);
    if (!batch) throw new PipelineError('NOT_FOUND', `import ${batchId} not found`);
    const repository = await store.readRepository();
    for (const { itemId, decision } of decisions) {
      const item = batch.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new PipelineError('NOT_FOUND', `candidate ${itemId} not found in ${batchId}`);
      if (item.published) throw new PipelineError('ALREADY_PUBLISHED', `${itemId} is already published`);
      if (decision.action === 'ACCEPT') {
        const kind =
          decision.kind ??
          (item.kind === 'INFORMATION' || item.kind === 'UNCLASSIFIED' ? undefined : item.kind);
        if (!kind)
          throw new PipelineError('INVALID_DECISION', `${itemId} is ${item.kind}: accepting it needs a kind`);
        if (item.duplicate.status === 'SAME_ID_OTHER_SOURCE')
          throw new PipelineError(
            'CONFLICT_REQUIRES_MERGE',
            `${item.externalId ?? itemId} already exists from another source: merge it, or reject it and fix the source`,
          );
      }
      if (decision.action === 'MERGE') {
        const target = repository.entities.find((entity) => entity.id === decision.mergeInto);
        if (!target)
          throw new PipelineError(
            'INVALID_DECISION',
            `${itemId}: merge target ${String(decision.mergeInto)} not found`,
          );
      }
      item.decision = { ...decision, at: now.toISOString() };
    }
    batch.updatedAt = now.toISOString();
    await store.writeBatch(batch);
    return batch;
  });
}

export interface PublishOptions {
  by?: string;
  /** Publier depuis une lecture PARTIELLE de la source : un accord explicite. */
  acknowledgePartial?: boolean;
}

export interface PublishResult {
  batch: ImportBatch;
  created: string[];
  updated: string[];
  merged: string[];
  links: string[];
}

const ORDER: Record<string, number> = { REQUIREMENT: 0, BUSINESS_RULE: 1, ACCEPTANCE_CRITERION: 2 };

/** Publier les candidats décidés d'un lot dans le référentiel. */
export function publish(
  store: RequirementsStore,
  batchId: string,
  now: Date,
  options: PublishOptions = {},
): Promise<PublishResult> {
  return store.update(async () => {
    const batch = await store.readBatch(batchId);
    if (!batch) throw new PipelineError('NOT_FOUND', `import ${batchId} not found`);
    if (batch.completeness === 'PARTIAL' && !options.acknowledgePartial)
      throw new PipelineError(
        'PARTIAL_NOT_ACKNOWLEDGED',
        `${batchId} was read partially (see its issues): publishing needs an explicit acknowledgement`,
      );
    const repository = await store.readRepository();
    const at = now.toISOString();
    const result: PublishResult = { batch, created: [], updated: [], merged: [], links: [] };
    const pending = batch.items
      .filter((item) => item.decision && item.decision.action !== 'REJECT' && !item.published)
      .sort((a, b) => (ORDER[kindOf(a)] ?? 3) - (ORDER[kindOf(b)] ?? 3));
    if (pending.length === 0 && !batch.items.some((item) => item.decision?.action === 'REJECT'))
      throw new PipelineError('NOTHING_TO_PUBLISH', `${batchId}: no decided candidate to publish`);
    for (const item of pending) {
      const decision = item.decision as ItemDecision;
      const by = decision.by ?? options.by;
      let entity: CanonicalEntity;
      if (decision.action === 'MERGE') {
        entity = repository.entities.find(
          (candidate) => candidate.id === decision.mergeInto,
        ) as CanonicalEntity;
        mergeInto(entity, item, batch.id, at, by, decision);
        result.merged.push(entity.id);
      } else if (item.duplicate.status === 'SOURCE_CHANGED' || item.duplicate.status === 'UNCHANGED') {
        entity = repository.entities.find(
          (candidate) => candidate.id === item.duplicate.entityId,
        ) as CanonicalEntity;
        if (item.duplicate.status === 'SOURCE_CHANGED') {
          reviseFrom(entity, item, batch.id, at, by, decision);
          markLinksStale(repository, entity, at);
          result.updated.push(entity.id);
        }
      } else {
        entity = create(item, batch.id, at, by, decision);
        repository.entities.push(entity);
        result.created.push(entity.id);
      }
      item.published = { entityId: entity.id, version: entity.version, at };
      const link = parentLink(repository, entity, item, decision, at, by, batch);
      if (link) result.links.push(link.id);
    }
    batch.status = statusOf(batch);
    batch.updatedAt = at;
    await store.writeRepository(repository);
    await store.writeBatch(batch);
    return result;
  });
}

function kindOf(item: ExtractedItem): string {
  return item.decision?.kind ?? item.kind;
}

function create(
  item: ExtractedItem,
  batchId: string,
  at: string,
  by: string | undefined,
  decision: ItemDecision,
): CanonicalEntity {
  const kind = (decision.kind ?? item.kind) as CanonicalEntity['kind'];
  const title = decision.title ?? item.title;
  const description = decision.description ?? item.description;
  const revision: Revision = {
    version: 1,
    at,
    change: 'CREATED',
    batchId,
    ...(by ? { by } : {}),
    ...(decision.note ? { note: decision.note } : {}),
    fingerprint: fingerprint(`${title}\n${description}`),
    ...(decision.title !== undefined || decision.description !== undefined ? { edited: true } : {}),
  };
  const base = {
    id: newId(kind === 'REQUIREMENT' ? 'req' : kind === 'BUSINESS_RULE' ? 'rul' : 'acc'),
    ...(item.externalId ? { externalId: item.externalId } : {}),
    title,
    description,
    sources: [item.source],
    version: 1,
    history: [revision],
    createdAt: at,
    updatedAt: at,
    validation: 'VALIDATED' as const,
  };
  if (kind === 'BUSINESS_RULE')
    return {
      ...base,
      kind,
      preconditions: [],
      conditions: [],
      exceptions: [],
      constraints: [],
    } satisfies BusinessRule;
  if (kind === 'ACCEPTANCE_CRITERION')
    return {
      ...base,
      kind,
      ...(item.criterion ? { structure: item.criterion } : {}),
      observables: [],
    } satisfies AcceptanceCriterion;
  const type = /non.?functional|non.?fonctionnel|nfr/i.test(item.attributes.type ?? '')
    ? 'NON_FUNCTIONAL'
    : 'UNSPECIFIED';
  return {
    ...base,
    kind: 'REQUIREMENT',
    type,
    ...(item.attributes.priority ? { priority: item.attributes.priority } : {}),
    ...(item.attributes.status ? { status: item.attributes.status } : {}),
    dependsOn: [],
  } satisfies Requirement;
}

/** La source a changé et une personne l'a accepté : nouvelle version, l'ancien texte dans l'historique. */
function reviseFrom(
  entity: CanonicalEntity,
  item: ExtractedItem,
  batchId: string,
  at: string,
  by: string | undefined,
  decision: ItemDecision,
): void {
  const previous = { title: entity.title, description: entity.description };
  entity.title = decision.title ?? item.title;
  entity.description = decision.description ?? item.description;
  entity.sources = [
    ...entity.sources.filter((source) => source.sourceId !== item.source.sourceId),
    item.source,
  ];
  entity.version += 1;
  entity.updatedAt = at;
  entity.history.push({
    version: entity.version,
    at,
    change: 'UPDATED',
    batchId,
    ...(by ? { by } : {}),
    ...(decision.note ? { note: decision.note } : {}),
    fingerprint: fingerprint(`${entity.title}\n${entity.description}`),
    ...(decision.title !== undefined || decision.description !== undefined ? { edited: true } : {}),
    previous,
  });
}

/** Le candidat est le même élément qu'une entité existante : sa provenance s'ajoute, le texte ne change que sur décision. */
function mergeInto(
  entity: CanonicalEntity,
  item: ExtractedItem,
  batchId: string,
  at: string,
  by: string | undefined,
  decision: ItemDecision,
): void {
  const previous = { title: entity.title, description: entity.description };
  const changesText = decision.title !== undefined || decision.description !== undefined;
  if (decision.title !== undefined) entity.title = decision.title;
  if (decision.description !== undefined) entity.description = decision.description;
  entity.sources = [
    ...entity.sources.filter(
      (source) =>
        !(source.sourceId === item.source.sourceId && source.location.block === item.source.location.block),
    ),
    item.source,
  ];
  entity.version += 1;
  entity.updatedAt = at;
  entity.history.push({
    version: entity.version,
    at,
    change: 'MERGED',
    batchId,
    ...(by ? { by } : {}),
    note:
      decision.note ?? `merged from ${item.source.title}${item.externalId ? ` (${item.externalId})` : ''}`,
    fingerprint: fingerprint(`${entity.title}\n${entity.description}`),
    ...(changesText ? { previous, edited: true } : {}),
  });
}

/** Une exigence modifiée : ses liens sont à réexaminer (fraîcheur), sans être supprimés ni invalidés. */
function markLinksStale(repository: RequirementsRepository, entity: CanonicalEntity, at: string): void {
  for (const link of repository.links)
    if ((link.from.id === entity.id || link.to.id === entity.id) && link.validation !== 'REJECTED') {
      link.freshness = 'POSSIBLY_STALE';
      link.updatedAt = at;
      link.justification = [
        ...link.justification,
        `${entity.externalId ?? entity.id} changed (version ${String(entity.version)}): review this link`,
      ];
    }
}

/** Le lien d'une règle ou d'un critère vers son parent : confirmé si la personne l'a donné, proposé sinon. */
function parentLink(
  repository: RequirementsRepository,
  entity: CanonicalEntity,
  item: ExtractedItem,
  decision: ItemDecision,
  at: string,
  by: string | undefined,
  batch: ImportBatch,
): TraceabilityLink | undefined {
  if (entity.kind === 'REQUIREMENT') return undefined;
  const key = decision.parent ?? item.parentExternalId;
  if (!key) return undefined;
  const parent = repository.entities.find(
    (candidate) =>
      candidate.id !== entity.id &&
      (candidate.id === key || candidate.externalId === key) &&
      (candidate.kind === 'REQUIREMENT' ||
        (entity.kind === 'ACCEPTANCE_CRITERION' && candidate.kind === 'BUSINESS_RULE')),
  );
  if (!parent) {
    batch.issues.push({
      severity: 'INFO',
      code: 'PARENT_NOT_FOUND',
      message: `${entity.externalId ?? entity.id}: parent ${key} is not in the repository (no link created)`,
      location: item.source.location,
    });
    return undefined;
  }
  const confirmed = decision.parent !== undefined;
  const fromRow = !confirmed && item.parentBasis === 'TABLE_ROW';
  const where = item.source.location.row !== undefined ? ` (row ${String(item.source.location.row)})` : '';
  return upsertLink(repository, {
    type: entity.kind === 'BUSINESS_RULE' ? 'HAS_RULE' : 'HAS_CRITERION',
    from: { kind: parent.kind, id: parent.id, version: String(parent.version) },
    to: { kind: entity.kind, id: entity.id, version: String(entity.version) },
    origin: 'IMPORT',
    justification: confirmed
      ? [`parent given by a person when publishing ${batch.id}`]
      : fromRow
        ? [`given by the same table row of « ${item.source.title} »${where}`]
        : [
            `follows ${key} in the same section of « ${item.source.title} » (block ${String(item.source.location.block)})`,
          ],
    confidence: confirmed || fromRow ? 'HIGH' : 'MEDIUM',
    at,
    ...(confirmed ? { confirmBy: by ?? '' } : {}),
  });
}

export interface LinkProposal {
  type: LinkType;
  from: LinkEnd;
  to: LinkEnd;
  origin: LinkOrigin;
  justification: string[];
  confidence: Confidence;
  at: string;
  /** Présent : le lien est confirmé par cette personne (ajout manuel, parent donné). */
  confirmBy?: string;
}

/**
 * Proposer ou ajouter un lien. Un lien déjà CONFIRMÉ ou REJETÉ par une personne n'est jamais modifié
 * par une proposition automatique ; un lien encore PROPOSÉ voit sa justification et sa confiance
 * mises à jour.
 */
export function upsertLink(repository: RequirementsRepository, proposal: LinkProposal): TraceabilityLink {
  const existing = repository.links.find(
    (link) =>
      link.type === proposal.type && link.from.id === proposal.from.id && link.to.id === proposal.to.id,
  );
  const decision: LinkDecision =
    proposal.confirmBy !== undefined
      ? {
          action: proposal.origin === 'MANUAL' ? 'ADD' : 'CONFIRM',
          at: proposal.at,
          ...(proposal.confirmBy ? { by: proposal.confirmBy } : {}),
        }
      : { action: 'PROPOSE', at: proposal.at };
  if (existing) {
    if (existing.validation !== 'PROPOSED' && proposal.confirmBy === undefined) return existing;
    existing.justification = proposal.justification;
    existing.confidence = proposal.confidence;
    existing.from = proposal.from;
    existing.to = proposal.to;
    existing.freshness = 'CURRENT';
    existing.updatedAt = proposal.at;
    if (proposal.confirmBy !== undefined) existing.validation = 'CONFIRMED';
    existing.decisions.push(decision);
    return existing;
  }
  const link: TraceabilityLink = {
    id: newId('lnk'),
    type: proposal.type,
    from: proposal.from,
    to: proposal.to,
    origin: proposal.origin,
    justification: proposal.justification,
    confidence: proposal.confidence,
    validation: proposal.confirmBy !== undefined ? 'CONFIRMED' : 'PROPOSED',
    freshness: 'CURRENT',
    decisions: [decision],
    createdAt: proposal.at,
    updatedAt: proposal.at,
  };
  repository.links.push(link);
  return link;
}

/** Confirmer ou rejeter un lien (décision humaine, gardée dans l'historique du lien). */
export function decideLink(
  store: RequirementsStore,
  linkId: string,
  action: 'CONFIRM' | 'REJECT',
  now: Date,
  options: { by?: string; note?: string } = {},
): Promise<TraceabilityLink> {
  return store.update(async () => {
    const repository = await store.readRepository();
    const link = repository.links.find((candidate) => candidate.id === linkId);
    if (!link) throw new PipelineError('NOT_FOUND', `link ${linkId} not found`);
    link.validation = action === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED';
    link.updatedAt = now.toISOString();
    link.decisions.push({
      action,
      at: link.updatedAt,
      ...(options.by ? { by: options.by } : {}),
      ...(options.note ? { note: options.note } : {}),
    });
    await store.writeRepository(repository);
    return link;
  });
}

/** Ajouter un lien à la main : il est confirmé par son auteur. */
export function addLink(
  store: RequirementsStore,
  input: { type: LinkType; from: LinkEnd; to: LinkEnd; justification: string[]; by?: string },
  now: Date,
): Promise<TraceabilityLink> {
  return store.update(async () => {
    const repository = await store.readRepository();
    for (const end of [input.from, input.to])
      if (
        ['REQUIREMENT', 'BUSINESS_RULE', 'ACCEPTANCE_CRITERION'].includes(end.kind) &&
        !repository.entities.some((entity) => entity.id === end.id)
      )
        throw new PipelineError('NOT_FOUND', `${end.kind} ${end.id} not found`);
    if (input.justification.length === 0)
      throw new PipelineError('INVALID_DECISION', 'a manual link needs a justification');
    const link = upsertLink(repository, {
      ...input,
      origin: 'MANUAL',
      confidence: 'HIGH',
      at: now.toISOString(),
      confirmBy: input.by ?? '',
    });
    await store.writeRepository(repository);
    return link;
  });
}

export type { ImportIssue };
