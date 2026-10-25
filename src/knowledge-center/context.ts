import path from 'node:path';
import type { ScenarioConfig } from '../config/config.js';
import { applicationIdOf } from '../intelligence/intelligence.js';
import { knowledgeFileOf, knowledgeIdentityOf } from '../knowledge/json-knowledge-base.js';
import type { KnowledgeIdentity } from '../knowledge/knowledge-model.js';
import type { MemoryReport } from '../model/persistence-report.js';
import { openPersistence, type PersistenceSession } from '../persistence/persistence-manager.js';
import { readCoreVersion } from '../tool-identity.js';
import { ReviewLedger } from './review-ledger.js';
import { knowledgeDirectoriesOf, type ApplicationIdentity } from './sources.js';

/**
 * LE CONTEXTE DU KNOWLEDGE CENTER : la mission effective (le même chargeur que les runs), la
 * persistance ouverte exactement comme l'orchestrateur l'ouvre (`openPersistence` : repli, santé,
 * nettoyage), les mêmes fichiers et dossiers que le moteur écrit. Rien n'est activé en plus :
 * `persistence.enabled: false` → aucun provider ; `memory.enabled` est lu, jamais changé.
 */
export interface KnowledgeCenterOptions {
  /** Au-delà de cet âge sans nouvelle observation, une connaissance est STALE. */
  staleAfterDays: number;
  /** Lignes lues au plus par table (jamais toute la base). */
  limit: number;
  /** Aucune opération d'écriture (décisions, import, restauration). */
  readOnly: boolean;
  language: 'fr' | 'en';
}

export const DEFAULT_OPTIONS: KnowledgeCenterOptions = {
  staleAfterDays: 90,
  limit: 20_000,
  readOnly: false,
  language: 'en',
};

export interface KnowledgeCenterContext {
  config: ScenarioConfig;
  persistence: PersistenceSession;
  /** Avertissements du chargement (repli de la persistance…). */
  warnings: string[];
  identity: KnowledgeIdentity;
  current: ApplicationIdentity;
  memoryMode: MemoryReport['mode'];
  knowledgeFile: string;
  knowledgeDir: string;
  functionalDir: string;
  rulesDir: string;
  recordingsDir: string;
  ledger: ReviewLedger;
  options: KnowledgeCenterOptions;
  crawlerVersion: string;
  now: () => Date;
  close(): Promise<void>;
}

export async function openKnowledgeCenter(
  config: ScenarioConfig,
  options: Partial<KnowledgeCenterOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<KnowledgeCenterContext> {
  const effective: KnowledgeCenterOptions = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];
  const persistence = await openPersistence(config.persistence, env, {
    warn: (message) => warnings.push(message),
  });
  const crawlerVersion = await readCoreVersion();
  const identity = knowledgeIdentityOf(config.knowledge, config.target.baseUrl, env, crawlerVersion);
  const knowledgeFile = knowledgeFileOf(config);
  const directories = knowledgeDirectoriesOf(config.output.reportsDir, knowledgeFile);
  const current: ApplicationIdentity = {
    applicationId: applicationIdOf(identity),
    application: identity.application,
    ...(identity.environment ? { environment: identity.environment } : {}),
    functionalApplication: config.mission.name,
  };
  const ledger = ReviewLedger.inDirectory(directories.knowledgeDir, () => now().toISOString());
  await ledger.load();
  return {
    config,
    persistence,
    warnings,
    identity,
    current,
    memoryMode: memoryModeOf(config, persistence),
    knowledgeFile: path.resolve(knowledgeFile),
    ...directories,
    ledger,
    options: effective,
    crawlerVersion,
    now,
    close: async () => {
      await persistence.provider?.close().catch(() => undefined);
    },
  };
}

/** La même règle que l'orchestrateur (memoryModeOf) : lue, jamais modifiée. */
export function memoryModeOf(config: ScenarioConfig, persistence: PersistenceSession): MemoryReport['mode'] {
  if (config.memory.enabled === undefined) return 'legacy';
  if (!config.memory.enabled) return 'isolated';
  return persistence.provider && config.memory.historicalKnowledge ? 'historical' : 'current-run';
}
