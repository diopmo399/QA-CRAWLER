import type {
  KeyedRecord,
  CrawlRunRecord,
  CrawlRunUpdate,
  PersistenceHealth,
  RunStateRecord,
  RunTransitionRecord,
  TransitionKnowledgeRecord,
  TransitionObservation,
} from './model.js';

/**
 * COUCHE DE PERSISTANCE : OÙ les informations sont stockées (mémoire, fichier, base de
 * données). Le moteur (FlowExplorer, DecisionEngine, FlowGraph, oracles, SafetyPolicy)
 * n'en dépend pas : il écrit par un listener (persistence-recorder.ts) et lit la mémoire
 * historique dans la Working Memory (knowledge-service.ts). Aucun composant métier
 * n'importe un pilote de base de données.
 */

export interface RunRepository {
  create(run: CrawlRunRecord): Promise<void>;
  update(id: string, update: CrawlRunUpdate): Promise<void>;
  get(id: string): Promise<CrawlRunRecord | undefined>;
  /** Les runs d'une application, les plus récents d'abord. */
  list(applicationId: string, limit: number): Promise<CrawlRunRecord[]>;
}

export interface StateRepository {
  /** Crée ou met à jour (clé : runId + stateId ; l'id et firstSeenAt d'une ligne existante sont gardés). */
  save(states: readonly RunStateRecord[]): Promise<void>;
  listByRun(runId: string): Promise<RunStateRecord[]>;
}

export interface TransitionRepository {
  add(transitions: readonly RunTransitionRecord[]): Promise<void>;
  listByRun(runId: string): Promise<RunTransitionRecord[]>;
}

export interface KnowledgeRepository {
  /** Ajoute des observations (incréments), atomiquement : toutes ou aucune. */
  record(observations: readonly TransitionObservation[]): Promise<void>;
  /** La connaissance la plus récente d'une application, au plus `limit` lignes (dernière observation d'abord). */
  load(applicationId: string, limit: number): Promise<TransitionKnowledgeRecord[]>;
  /** Toutes les destinations connues d'une action depuis un écran. */
  find(
    applicationId: string,
    fromStateSignature: string,
    actionSignature: string,
  ): Promise<TransitionKnowledgeRecord[]>;
}

/**
 * Une ligne par élément, mise à jour sur place (évolution des flows, anomalies) :
 * `save` crée ou remplace par (applicationId, key), tout ou rien.
 */
export interface KeyedRepository {
  save(records: readonly KeyedRecord[]): Promise<void>;
  /** Les enregistrements d'une application, les plus récemment vus d'abord, au plus `limit`. */
  load(applicationId: string, limit: number): Promise<KeyedRecord[]>;
}

export type PersistenceKind = 'memory' | 'file' | 'database';

export interface PersistenceProvider {
  readonly kind: PersistenceKind;
  /** Nom lisible : « in-memory », « file », « PostgreSQL », « SQL Server »… (jamais d'identifiants). */
  readonly description: string;
  /** Connexion, migrations, chargement : lève une erreur si le stockage n'est pas utilisable. */
  initialize(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<PersistenceHealth>;
  readonly runs: RunRepository;
  readonly states: StateRepository;
  readonly transitions: TransitionRepository;
  readonly knowledge: KnowledgeRepository;
  /** Évolution des états, transitions et flows d'une version à l'autre (une ligne par élément). */
  readonly evolution: KeyedRepository;
  /** Cycle de vie des anomalies : NEW, KNOWN, RESOLVED, REOPENED, FLAKY (une ligne par anomalie). */
  readonly anomalies: KeyedRepository;
}
