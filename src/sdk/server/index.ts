/**
 * @qa-crawler/core/sdk/server — l'adaptateur Node entre l'assistant SDK et le moteur QA-CRAWLER.
 */
export { startSdkServer, type RunningSdkServer, type SdkServerOptions } from './server.js';
export { openQaCrawler, type OpenQaCrawlerOptions, type QaCrawlerNode } from './node.js';
export { ExplorationManager, Exploration, summarize, type MissionRunner } from './explorations.js';
export {
  ALWAYS_IGNORED_PATHS,
  engineDefaults,
  projectDocument,
  projectDraftSchema,
  renderProjectFile,
  validateDraft,
  type ProjectRules,
} from './project.js';
