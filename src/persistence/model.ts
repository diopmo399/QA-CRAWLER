/**
 * Modèle de données V1 de la persistance : des données simples, identiques pour tous
 * les providers (mémoire, fichier, base de données). Aucun secret, aucune valeur
 * saisie : seulement des signatures, des libellés, des compteurs et des dates ISO.
 */

/** Version du schéma de données (le nombre de migrations de la base). */
export const PERSISTENCE_SCHEMA_VERSION = 2;

/** Cible d'une transition sans nouvel état (bloquée, échouée) : la clé de connaissance reste non nulle. */
export const NO_TARGET = '(none)';

export type CrawlRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

/** Un lancement de QA-CRAWLER. */
export interface CrawlRunRecord {
  id: string;
  applicationId: string;
  missionName: string;
  environment?: string;
  branch?: string;
  commitSha?: string;
  crawlerVersion?: string;
  mode: string;
  startedAt: string;
  finishedAt?: string;
  status: CrawlRunStatus;
  statesCount: number;
  actionsCount: number;
  transitionsCount: number;
  anomaliesCount: number;
}

export type CrawlRunUpdate = Partial<
  Pick<
    CrawlRunRecord,
    'finishedAt' | 'status' | 'statesCount' | 'actionsCount' | 'transitionsCount' | 'anomaliesCount'
  >
>;

/** Un état découvert pendant un run. `stateSignature` vient du StateDetector (via knowledge/signatures). */
export interface RunStateRecord {
  id: string;
  runId: string;
  stateSignature: string;
  stateId: string;
  routePattern: string;
  urlNormalized: string;
  title?: string;
  heading?: string;
  depth: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Données normalisées et non sensibles (voir sanitize.ts). */
  context: Record<string, unknown>;
}

export type TransitionStatus = 'SUCCESS' | 'FAILED' | 'BLOCKED';

/** ÉTAT A --ACTION--> ÉTAT B (B absent quand aucun nouvel état n'a été atteint). */
export interface RunTransitionRecord {
  id: string;
  runId: string;
  fromStateId: string;
  toStateId: string | null;
  actionId: string;
  actionSignature: string;
  actionType: string;
  actionLabel: string;
  status: TransitionStatus;
  safetyClass: string;
  safetyDecision: 'ALLOW' | 'BLOCK';
  oracleStatus?: string;
  durationMs?: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * MÉMOIRE HISTORIQUE (pas une vérité métier) : une ligne par destination observée. Une
 * même action depuis un même écran peut avoir plusieurs lignes (plusieurs destinations).
 */
export interface TransitionKnowledgeRecord {
  applicationId: string;
  fromStateSignature: string;
  actionSignature: string;
  toStateSignature: string;
  seenCount: number;
  successCount: number;
  failureCount: number;
  blockedCount: number;
  averageDurationMs?: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Des observations à ajouter à la mémoire historique (des incréments, jamais des totaux). */
export interface TransitionObservation {
  applicationId: string;
  fromStateSignature: string;
  actionSignature: string;
  toStateSignature: string;
  seen: number;
  success: number;
  failure: number;
  blocked: number;
  /** Somme et nombre des durées observées (pour la moyenne pondérée). */
  durationTotalMs: number;
  durationCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PersistenceHealth {
  status: 'CONNECTED' | 'UNAVAILABLE';
  latencyMs?: number;
  /** Version du schéma de la base (providers de base de données). */
  schemaVersion?: number;
  /** Raison lisible, jamais d'identifiants. */
  detail?: string;
}

/** Longueurs maximales des colonnes texte (les mêmes pour toutes les bases). */
export const LIMITS = {
  id: 64,
  signature: 200,
  label: 500,
  url: 2000,
  name: 200,
} as const;

/** Tronque un texte à la longueur de sa colonne. */
export function fit(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : text.length > max ? text.slice(0, max) : text;
}

/**
 * Refuse une observation invalide AVANT toute écriture : tous les providers la rejettent
 * de la même façon, et un lot qui en contient une n'est pas appliqué du tout.
 */
export function validateObservation(observation: TransitionObservation): void {
  for (const key of ['applicationId', 'fromStateSignature', 'actionSignature', 'toStateSignature'] as const) {
    const value = observation[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.signature)
      throw new Error(`invalid knowledge observation: ${key} must be 1..${LIMITS.signature} characters`);
  }
  for (const key of ['seen', 'success', 'failure', 'blocked', 'durationCount'] as const)
    if (!Number.isInteger(observation[key]) || observation[key] < 0)
      throw new Error(`invalid knowledge observation: ${key} must be a non-negative integer`);
  if (!Number.isFinite(observation.durationTotalMs) || observation.durationTotalMs < 0)
    throw new Error('invalid knowledge observation: durationTotalMs must be a non-negative number');
}

/** Clé logique d'une ligne de connaissance. */
export function knowledgeKey(
  record: Pick<
    TransitionKnowledgeRecord,
    'applicationId' | 'fromStateSignature' | 'actionSignature' | 'toStateSignature'
  >,
): string {
  return [
    record.applicationId,
    record.fromStateSignature,
    record.actionSignature,
    record.toStateSignature,
  ].join('␟');
}

/**
 * Ajoute des observations à une ligne existante (ou en crée une). La même règle pour tous
 * les providers : la moyenne des durées est pondérée par le nombre d'exécutions (succès + échecs).
 */
export function mergeObservation(
  existing: TransitionKnowledgeRecord | undefined,
  observation: TransitionObservation,
): TransitionKnowledgeRecord {
  const executed = existing ? existing.successCount + existing.failureCount : 0;
  const previousAverage = existing?.averageDurationMs;
  let averageDurationMs = previousAverage;
  if (observation.durationCount > 0) {
    const weight = previousAverage === undefined ? 0 : executed;
    averageDurationMs =
      ((previousAverage ?? 0) * weight + observation.durationTotalMs) / (weight + observation.durationCount);
    averageDurationMs = Math.round(averageDurationMs * 100) / 100;
  }
  return {
    applicationId: observation.applicationId,
    fromStateSignature: observation.fromStateSignature,
    actionSignature: observation.actionSignature,
    toStateSignature: observation.toStateSignature,
    seenCount: (existing?.seenCount ?? 0) + observation.seen,
    successCount: (existing?.successCount ?? 0) + observation.success,
    failureCount: (existing?.failureCount ?? 0) + observation.failure,
    blockedCount: (existing?.blockedCount ?? 0) + observation.blocked,
    ...(averageDurationMs !== undefined ? { averageDurationMs } : {}),
    firstSeenAt:
      existing && existing.firstSeenAt < observation.firstSeenAt
        ? existing.firstSeenAt
        : observation.firstSeenAt,
    lastSeenAt:
      existing && existing.lastSeenAt > observation.lastSeenAt ? existing.lastSeenAt : observation.lastSeenAt,
  };
}

/** Regroupe les observations d'une même clé (un seul accès par clé et par écriture). */
export function combineObservations(observations: readonly TransitionObservation[]): TransitionObservation[] {
  const byKey = new Map<string, TransitionObservation>();
  for (const observation of observations) {
    const key = knowledgeKey(observation);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...observation });
      continue;
    }
    current.seen += observation.seen;
    current.success += observation.success;
    current.failure += observation.failure;
    current.blocked += observation.blocked;
    current.durationTotalMs += observation.durationTotalMs;
    current.durationCount += observation.durationCount;
    if (observation.firstSeenAt < current.firstSeenAt) current.firstSeenAt = observation.firstSeenAt;
    if (observation.lastSeenAt > current.lastSeenAt) current.lastSeenAt = observation.lastSeenAt;
  }
  return [...byKey.values()];
}
