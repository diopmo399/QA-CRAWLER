/**
 * LE RÉFÉRENTIEL D'EXIGENCES : modèle canonique, contrat de connecteur, normalisation, doublons,
 * décisions, publication et liens (docs/requirements/AUDIT-ET-CONCEPTION.md).
 */
export * from './model.js';
export * from './document.js';
export * from './connector.js';
export {
  classify,
  criterionOf,
  mapColumns,
  DEFAULT_ID_PREFIXES,
  TABLE_FIELDS,
  type ClassifyOptions,
  type TableField,
} from './classify.js';
export { fingerprint, similarity, SIMILARITY_THRESHOLD } from './fingerprint.js';
export { RequirementsStore } from './repository.js';
export {
  addLink,
  decide,
  decideLink,
  duplicateOf,
  importSource,
  publish,
  statusOf,
  upsertLink,
  PipelineError,
  type DecisionInput,
  type ImportOptions,
  type LinkProposal,
  type PublishOptions,
  type PublishResult,
} from './pipeline.js';
export {
  ConfluenceConnector,
  pageIdOf,
  pageRefOf,
  type PageRef,
  variantOf,
  type ConfluenceInput,
  type ConfluenceVariant,
} from './connectors/confluence.js';
export { storageToBlocks, type StorageResult } from './connectors/confluence-storage.js';
