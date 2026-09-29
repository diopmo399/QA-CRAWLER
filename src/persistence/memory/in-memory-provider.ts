import {
  validateKeyedRecord,
  type KeyedRecord,
  combineObservations,
  knowledgeKey,
  mergeObservation,
  type CrawlRunRecord,
  type CrawlRunUpdate,
  type PersistenceHealth,
  type RunStateRecord,
  type RunTransitionRecord,
  type TransitionKnowledgeRecord,
  type TransitionObservation,
  validateObservation,
} from '../model.js';
import type {
  KeyedRepository,
  KnowledgeRepository,
  PersistenceKind,
  PersistenceProvider,
  RunRepository,
  StateRepository,
  TransitionRepository,
} from '../persistence-provider.js';

/** Les « tables » d'un provider sans base de données : sérialisables telles quelles en JSON. */
export interface MemoryTables {
  runs: CrawlRunRecord[];
  states: RunStateRecord[];
  transitions: RunTransitionRecord[];
  knowledge: TransitionKnowledgeRecord[];
  evolution: KeyedRecord[];
  anomalies: KeyedRecord[];
}

export function emptyTables(): MemoryTables {
  return { runs: [], states: [], transitions: [], knowledge: [], evolution: [], anomalies: [] };
}

/**
 * Provider en mémoire : rien ne survit au processus. Sert aux tests, et de repli
 * ultime. Les copies (structuredClone) empêchent l'appelant de modifier ce qui est
 * « stocké » par accident — le même comportement qu'une vraie base.
 */
export class InMemoryPersistenceProvider implements PersistenceProvider {
  readonly kind: PersistenceKind = 'memory';
  readonly description: string = 'in-memory';
  protected tables: MemoryTables = emptyTables();

  readonly runs: RunRepository = {
    create: (run) =>
      this.write('runs', () => {
        if (this.tables.runs.some((existing) => existing.id === run.id))
          throw new Error(`run ${run.id} already exists`);
        this.tables.runs.push(structuredClone(run));
      }),
    update: (id, update: CrawlRunUpdate) =>
      this.write('runs', () => {
        const run = this.tables.runs.find((existing) => existing.id === id);
        if (!run) throw new Error(`unknown run ${id}`);
        Object.assign(run, structuredClone(update));
      }),
    get: (id) => Promise.resolve(clone(this.tables.runs.find((run) => run.id === id))),
    list: (applicationId, limit) =>
      Promise.resolve(
        this.tables.runs
          .filter((run) => run.applicationId === applicationId)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, limit)
          .map((run) => structuredClone(run)),
      ),
  };

  readonly states: StateRepository = {
    save: (states) =>
      this.write('states', () => {
        for (const state of states) {
          const existing = this.tables.states.find(
            (candidate) => candidate.runId === state.runId && candidate.stateId === state.stateId,
          );
          if (existing)
            Object.assign(
              existing,
              structuredClone({ ...state, id: existing.id, firstSeenAt: existing.firstSeenAt }),
            );
          else this.tables.states.push(structuredClone(state));
        }
      }),
    listByRun: (runId) =>
      Promise.resolve(
        this.tables.states.filter((state) => state.runId === runId).map((state) => structuredClone(state)),
      ),
  };

  readonly transitions: TransitionRepository = {
    add: (transitions) =>
      this.write('transitions', () => {
        this.tables.transitions.push(...transitions.map((transition) => structuredClone(transition)));
      }),
    listByRun: (runId) =>
      Promise.resolve(
        this.tables.transitions
          .filter((transition) => transition.runId === runId)
          .map((transition) => structuredClone(transition)),
      ),
  };

  readonly knowledge: KnowledgeRepository = {
    record: (observations: readonly TransitionObservation[]) =>
      this.write('knowledge', () => {
        // Tout ou rien : tout est validé, puis les nouvelles lignes remplacent les anciennes.
        observations.forEach(validateObservation);
        const byKey = new Map(this.tables.knowledge.map((record) => [knowledgeKey(record), record]));
        for (const observation of combineObservations(observations))
          byKey.set(
            knowledgeKey(observation),
            mergeObservation(byKey.get(knowledgeKey(observation)), observation),
          );
        this.tables.knowledge = [...byKey.values()];
      }),
    load: (applicationId, limit) =>
      Promise.resolve(
        this.tables.knowledge
          .filter((record) => record.applicationId === applicationId)
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
          .slice(0, limit)
          .map((record) => structuredClone(record)),
      ),
    find: (applicationId, fromStateSignature, actionSignature) =>
      Promise.resolve(
        this.tables.knowledge
          .filter(
            (record) =>
              record.applicationId === applicationId &&
              record.fromStateSignature === fromStateSignature &&
              record.actionSignature === actionSignature,
          )
          .map((record) => structuredClone(record)),
      ),
  };

  readonly evolution: KeyedRepository = this.keyed('evolution');
  readonly anomalies: KeyedRepository = this.keyed('anomalies');

  /** Une ligne par (applicationId, key), remplacée sur place ; tout ou rien. */
  private keyed(table: 'evolution' | 'anomalies'): KeyedRepository {
    return {
      save: (records) =>
        this.write(table, () => {
          records.forEach(validateKeyedRecord);
          const byKey = new Map(
            this.tables[table].map((record) => [`${record.applicationId}|${record.key}`, record]),
          );
          for (const record of records)
            byKey.set(`${record.applicationId}|${record.key}`, structuredClone(record));
          this.tables[table] = [...byKey.values()];
        }),
      load: (applicationId, limit) =>
        Promise.resolve(
          this.tables[table]
            .filter((record) => record.applicationId === applicationId)
            .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.key.localeCompare(b.key))
            .slice(0, limit)
            .map((record) => structuredClone(record)),
        ),
    };
  }

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  healthCheck(): Promise<PersistenceHealth> {
    return Promise.resolve({ status: 'CONNECTED', latencyMs: 0 });
  }

  /**
   * Applique une modification sur une copie des tables, puis la remplace : une erreur
   * au milieu ne laisse rien à moitié écrit. Les sous-classes enregistrent ensuite (fichier).
   */
  protected async write(table: keyof MemoryTables, change: () => void): Promise<void> {
    const before = this.tables;
    this.tables = { ...before, [table]: structuredClone(before[table]) };
    try {
      change();
    } catch (error) {
      this.tables = before;
      throw error;
    }
    try {
      await this.afterWrite(table);
    } catch (error) {
      this.tables = before;
      throw error;
    }
  }

  protected afterWrite(_table: keyof MemoryTables): Promise<void> {
    return Promise.resolve();
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
