import {
  validateFlowMemoryRecord,
  validateKeyedRecord,
  type FlowMemoryRecord,
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
  ApplicationInventory,
  FlowMemoryRepository,
  InventoryRepository,
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
  memory: FlowMemoryRecord[];
}

export function emptyTables(): MemoryTables {
  return { runs: [], states: [], transitions: [], knowledge: [], evolution: [], anomalies: [], memory: [] };
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

  /** Une ligne par (applicationId, kind, key), remplacée sur place ; recherche filtrée en mémoire. */
  readonly memory: FlowMemoryRepository = {
    save: (records) =>
      this.write('memory', () => {
        records.forEach(validateFlowMemoryRecord);
        const byKey = new Map(
          this.tables.memory.map((record) => [
            `${record.applicationId}|${record.kind}|${record.key}`,
            record,
          ]),
        );
        for (const record of records)
          byKey.set(`${record.applicationId}|${record.kind}|${record.key}`, structuredClone(record));
        this.tables.memory = [...byKey.values()];
      }),
    search: (query) =>
      Promise.resolve(
        this.tables.memory
          .filter(
            (record) =>
              record.applicationId === query.applicationId &&
              (query.kind === undefined || record.kind === query.kind) &&
              (query.status === undefined || record.status === query.status) &&
              (query.keyPrefix === undefined || record.key.startsWith(query.keyPrefix)),
          )
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.key.localeCompare(b.key))
          .slice(0, query.limit)
          .map((record) => structuredClone(record)),
      ),
  };

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

  /** Les applications et leurs comptages, calculés sur les tables (les états et transitions par leur run). */
  readonly inventory: InventoryRepository = {
    applications: () => {
      const byApp = new Map<string, ApplicationInventory>();
      const of = (applicationId: string): ApplicationInventory => {
        const found = byApp.get(applicationId);
        if (found) return found;
        const created: ApplicationInventory = {
          applicationId,
          counts: { runs: 0, states: 0, transitions: 0, knowledge: 0, evolution: 0, anomalies: 0, memory: 0 },
        };
        byApp.set(applicationId, created);
        return created;
      };
      const seen = (inventory: ApplicationInventory, at: string): void => {
        if (!inventory.lastSeenAt || at > inventory.lastSeenAt) inventory.lastSeenAt = at;
      };
      const runApp = new Map(this.tables.runs.map((run) => [run.id, run.applicationId]));
      for (const run of this.tables.runs) {
        const inventory = of(run.applicationId);
        inventory.counts.runs += 1;
        seen(inventory, run.startedAt);
      }
      for (const state of this.tables.states) {
        const app = runApp.get(state.runId);
        if (app) of(app).counts.states += 1;
      }
      for (const transition of this.tables.transitions) {
        const app = runApp.get(transition.runId);
        if (app) of(app).counts.transitions += 1;
      }
      for (const row of this.tables.knowledge) {
        const inventory = of(row.applicationId);
        inventory.counts.knowledge += 1;
        seen(inventory, row.lastSeenAt);
      }
      for (const row of this.tables.evolution) of(row.applicationId).counts.evolution += 1;
      for (const row of this.tables.anomalies) of(row.applicationId).counts.anomalies += 1;
      for (const row of this.tables.memory) of(row.applicationId).counts.memory += 1;
      return Promise.resolve(
        [...byApp.values()].sort((a, b) => a.applicationId.localeCompare(b.applicationId)),
      );
    },
  };

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
