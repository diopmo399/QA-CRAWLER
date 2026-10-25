/**
 * @qa-crawler/core/sdk — le cœur du SDK embarquable : contrats, client HTTP + flux d'événements,
 * cycle de vie. Utilisable dans un navigateur (aucune dépendance Node).
 */
export * from './contracts.js';
export * from './lifecycle.js';
export {
  createQaCrawler,
  isCompatible,
  readEventStream,
  QaCrawlerError,
  type ClientOptions,
  type QaCrawlerClient,
  type RecordingStartInput,
  type SubscribeOptions,
  type Subscription,
} from './client.js';
