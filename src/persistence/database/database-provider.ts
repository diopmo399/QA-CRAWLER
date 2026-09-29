import {
  validateKeyedRecord,
  type KeyedRecord,
  combineObservations,
  mergeObservation,
  PERSISTENCE_SCHEMA_VERSION,
  validateObservation,
  type CrawlRunRecord,
  type CrawlRunUpdate,
  type PersistenceHealth,
  type RunStateRecord,
  type RunTransitionRecord,
  type TransitionKnowledgeRecord,
  type TransitionObservation,
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
import type { DatabaseAdapter, SqlExecutor, SqlRow, SqlValue } from './database-adapter.js';
import { appliedMigrations, migrate } from './migrations.js';
import { isNull, textOf } from './values.js';
import { randomUUID } from 'node:crypto';

/** Nouvelles tentatives d'une transaction qui a croisé une écriture concurrente de la même ligne. */
const UNIQUE_RETRIES = 3;

/**
 * Provider de base de données : les repositories écrits une seule fois, avec les pièces
 * du dialecte (paramètres, types, limite, blocage). Les écritures de connaissance lisent
 * la ligne en la bloquant (lock), la fusionnent en TypeScript (mergeObservation : la même règle que
 * les autres providers) puis la mettent à jour ou l'insèrent, le tout dans une transaction.
 */
export class DatabasePersistenceProvider implements PersistenceProvider {
  readonly kind: PersistenceKind = 'database';

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly options: { migrate: boolean },
  ) {}

  get description(): string {
    return this.adapter.dialect.label;
  }

  async initialize(): Promise<void> {
    await this.adapter.connect();
    try {
      await migrate(this.adapter, { apply: this.options.migrate });
    } catch (error) {
      await this.adapter.disconnect().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    return this.adapter.disconnect();
  }

  async healthCheck(): Promise<PersistenceHealth> {
    const started = Date.now();
    try {
      const ok = await this.adapter.healthCheck();
      const latencyMs = Date.now() - started;
      if (!ok) return { status: 'UNAVAILABLE', latencyMs, detail: 'health query failed' };
      return {
        status: 'CONNECTED',
        latencyMs,
        schemaVersion: (await appliedMigrations(this.adapter)).length,
      };
    } catch (error) {
      return { status: 'UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private p(index: number): string {
    return this.adapter.dialect.param(index);
  }

  /** INSERT INTO table (colonnes…) VALUES (paramètres…). */
  private insert(table: string, row: Record<string, SqlValue>): { sql: string; params: SqlValue[] } {
    const columns = Object.keys(row);
    return {
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, index) => this.p(index + 1)).join(', ')})`,
      params: Object.values(row),
    };
  }

  /** Rejoue la transaction quand une autre écriture a créé la même ligne entre-temps. */
  private async transactionWithRetry(operation: (tx: SqlExecutor) => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.adapter.transaction(operation);
        return;
      } catch (error) {
        if (attempt >= UNIQUE_RETRIES || !this.adapter.dialect.isUniqueViolation(error)) throw error;
      }
    }
  }

  readonly runs: RunRepository = {
    create: async (run) => {
      const { sql, params } = this.insert('crawl_run', runRow(run));
      await this.adapter.query(sql, params);
    },
    update: async (id, update: CrawlRunUpdate) => {
      const columns: Record<string, SqlValue> = {};
      if (update.finishedAt !== undefined) columns.finished_at = update.finishedAt;
      if (update.status !== undefined) columns.status = update.status;
      if (update.statesCount !== undefined) columns.states_count = update.statesCount;
      if (update.actionsCount !== undefined) columns.actions_count = update.actionsCount;
      if (update.transitionsCount !== undefined) columns.transitions_count = update.transitionsCount;
      if (update.anomaliesCount !== undefined) columns.anomalies_count = update.anomaliesCount;
      const names = Object.keys(columns);
      if (names.length === 0) return;
      await this.adapter.query(
        `UPDATE crawl_run SET ${names.map((name, index) => `${name} = ${this.p(index + 1)}`).join(', ')} WHERE id = ${this.p(names.length + 1)}`,
        [...Object.values(columns), id],
      );
    },
    get: async (id) => {
      const [row] = await this.adapter.query(`SELECT * FROM crawl_run WHERE id = ${this.p(1)}`, [id]);
      return row ? this.runOf(row) : undefined;
    },
    list: async (applicationId, limit) => {
      const rows = await this.adapter.query(
        this.adapter.dialect.limit(
          `SELECT * FROM crawl_run WHERE application_id = ${this.p(1)} ORDER BY started_at DESC`,
          limit,
        ),
        [applicationId],
      );
      return rows.map((row) => this.runOf(row));
    },
  };

  readonly states: StateRepository = {
    save: (states) =>
      this.transactionWithRetry(async (tx) => {
        const { dialect } = this.adapter;
        for (const state of states) {
          const [existing] = await tx.query(
            `SELECT id FROM ${dialect.lockedTable('run_state')} WHERE run_id = ${this.p(1)} AND state_id = ${this.p(2)}${dialect.lockSuffix}`,
            [state.runId, state.stateId],
          );
          if (existing) {
            await tx.query(
              `UPDATE run_state SET state_signature = ${this.p(1)}, route_pattern = ${this.p(2)}, url_normalized = ${this.p(3)}, title = ${this.p(4)}, heading = ${this.p(5)}, depth = ${this.p(6)}, last_seen_at = ${this.p(7)}, context_json = ${this.p(8)} WHERE id = ${this.p(9)}`,
              [
                state.stateSignature,
                state.routePattern,
                state.urlNormalized,
                state.title ?? null,
                state.heading ?? null,
                state.depth,
                state.lastSeenAt,
                JSON.stringify(state.context),
                textOf(existing.id),
              ],
            );
          } else {
            const { sql, params } = this.insert('run_state', stateRow(state));
            await tx.query(sql, params);
          }
        }
      }),
    listByRun: async (runId) => {
      const rows = await this.adapter.query(
        `SELECT * FROM run_state WHERE run_id = ${this.p(1)} ORDER BY first_seen_at, state_id`,
        [runId],
      );
      return rows.map((row) => this.stateOf(row));
    },
  };

  readonly transitions: TransitionRepository = {
    add: (transitions) =>
      this.adapter.transaction(async (tx) => {
        for (const transition of transitions) {
          const { sql, params } = this.insert('run_transition', transitionRow(transition));
          await tx.query(sql, params);
        }
      }),
    listByRun: async (runId) => {
      const rows = await this.adapter.query(
        `SELECT * FROM run_transition WHERE run_id = ${this.p(1)} ORDER BY started_at, id`,
        [runId],
      );
      return rows.map((row) => this.transitionOf(row));
    },
  };

  readonly knowledge: KnowledgeRepository = {
    record: async (observations: readonly TransitionObservation[]) => {
      observations.forEach(validateObservation);
      const combined = combineObservations(observations);
      if (combined.length === 0) return;
      const { dialect } = this.adapter;
      await this.transactionWithRetry(async (tx) => {
        for (const observation of combined) {
          const [row] = await tx.query(
            `SELECT * FROM ${dialect.lockedTable('transition_knowledge')} WHERE application_id = ${this.p(1)} AND from_state_signature = ${this.p(2)} AND action_signature = ${this.p(3)} AND to_state_signature = ${this.p(4)}${dialect.lockSuffix}`,
            [
              observation.applicationId,
              observation.fromStateSignature,
              observation.actionSignature,
              observation.toStateSignature,
            ],
          );
          const existing = row ? this.knowledgeOf(row) : undefined;
          const merged = mergeObservation(existing, observation);
          if (row) {
            await tx.query(
              `UPDATE transition_knowledge SET seen_count = ${this.p(1)}, success_count = ${this.p(2)}, failure_count = ${this.p(3)}, blocked_count = ${this.p(4)}, average_duration_ms = ${this.p(5)}, first_seen_at = ${this.p(6)}, last_seen_at = ${this.p(7)}, last_context_json = ${this.p(8)} WHERE id = ${this.p(9)}`,
              [
                merged.seenCount,
                merged.successCount,
                merged.failureCount,
                merged.blockedCount,
                merged.averageDurationMs ?? null,
                merged.firstSeenAt,
                merged.lastSeenAt,
                merged.lastContext ? JSON.stringify(merged.lastContext) : null,
                textOf(row.id),
              ],
            );
          } else {
            const { sql, params } = this.insert('transition_knowledge', {
              id: randomUUID(),
              ...knowledgeRow(merged),
            });
            await tx.query(sql, params);
          }
        }
      });
    },
    load: async (applicationId, limit) => {
      const rows = await this.adapter.query(
        this.adapter.dialect.limit(
          `SELECT * FROM transition_knowledge WHERE application_id = ${this.p(1)} ORDER BY last_seen_at DESC, id`,
          limit,
        ),
        [applicationId],
      );
      return rows.map((row) => this.knowledgeOf(row));
    },
    find: async (applicationId, fromStateSignature, actionSignature) => {
      const rows = await this.adapter.query(
        `SELECT * FROM transition_knowledge WHERE application_id = ${this.p(1)} AND from_state_signature = ${this.p(2)} AND action_signature = ${this.p(3)} ORDER BY seen_count DESC, to_state_signature`,
        [applicationId, fromStateSignature, actionSignature],
      );
      return rows.map((row) => this.knowledgeOf(row));
    },
  };

  readonly evolution: KeyedRepository = this.keyed('flow_evolution');
  readonly anomalies: KeyedRepository = this.keyed('anomaly_lifecycle');

  /**
   * Une ligne par (application, clé) : lue en la bloquant, remplacée ou insérée, dans une
   * transaction (la même règle que les autres providers : la dernière écriture l'emporte).
   */
  private keyed(table: 'flow_evolution' | 'anomaly_lifecycle'): KeyedRepository {
    return {
      save: async (records) => {
        records.forEach(validateKeyedRecord);
        if (records.length === 0) return;
        const { dialect } = this.adapter;
        await this.transactionWithRetry(async (tx) => {
          for (const record of records) {
            const [row] = await tx.query(
              `SELECT id FROM ${dialect.lockedTable(table)} WHERE application_id = ${this.p(1)} AND record_key = ${this.p(2)}${dialect.lockSuffix}`,
              [record.applicationId, record.key],
            );
            const values = {
              status: record.status,
              first_seen_at: record.firstSeenAt,
              last_seen_at: record.lastSeenAt,
              record_json: JSON.stringify(record.data),
            };
            if (row)
              await tx.query(
                `UPDATE ${table} SET status = ${this.p(1)}, first_seen_at = ${this.p(2)}, last_seen_at = ${this.p(3)}, record_json = ${this.p(4)} WHERE id = ${this.p(5)}`,
                [
                  values.status,
                  values.first_seen_at,
                  values.last_seen_at,
                  values.record_json,
                  textOf(row.id),
                ],
              );
            else {
              const { sql, params } = this.insert(table, {
                id: randomUUID(),
                application_id: record.applicationId,
                record_key: record.key,
                ...values,
              });
              await tx.query(sql, params);
            }
          }
        });
      },
      load: async (applicationId, limit) => {
        const rows = await this.adapter.query(
          this.adapter.dialect.limit(
            `SELECT * FROM ${table} WHERE application_id = ${this.p(1)} ORDER BY last_seen_at DESC, record_key`,
            limit,
          ),
          [applicationId],
        );
        return rows.map((row): KeyedRecord => ({
          applicationId: textOf(row.application_id),
          key: textOf(row.record_key),
          status: textOf(row.status),
          firstSeenAt: this.adapter.dialect.fromTimestamp(row.first_seen_at),
          lastSeenAt: this.adapter.dialect.fromTimestamp(row.last_seen_at),
          data: this.adapter.dialect.fromJson(row.record_json),
        }));
      },
    };
  }

  // ---- lignes → enregistrements (les colonnes NULL deviennent des champs absents)

  private runOf(row: SqlRow): CrawlRunRecord {
    const fromTimestamp = this.adapter.dialect.fromTimestamp;
    return {
      id: textOf(row.id),
      applicationId: textOf(row.application_id),
      missionName: textOf(row.mission_name),
      ...optional('environment', row.environment),
      ...optional('branch', row.branch),
      ...optional('commitSha', row.commit_sha),
      ...optional('crawlerVersion', row.crawler_version),
      mode: textOf(row.mode),
      startedAt: fromTimestamp(row.started_at),
      ...(isNull(row.finished_at) ? {} : { finishedAt: fromTimestamp(row.finished_at) }),
      status: textOf(row.status) as CrawlRunRecord['status'],
      statesCount: Number(row.states_count),
      actionsCount: Number(row.actions_count),
      transitionsCount: Number(row.transitions_count),
      anomaliesCount: Number(row.anomalies_count),
    };
  }

  private stateOf(row: SqlRow): RunStateRecord {
    const { fromTimestamp, fromJson } = this.adapter.dialect;
    return {
      id: textOf(row.id),
      runId: textOf(row.run_id),
      stateSignature: textOf(row.state_signature),
      stateId: textOf(row.state_id),
      routePattern: textOf(row.route_pattern),
      urlNormalized: textOf(row.url_normalized),
      ...optional('title', row.title),
      ...optional('heading', row.heading),
      depth: Number(row.depth),
      firstSeenAt: fromTimestamp(row.first_seen_at),
      lastSeenAt: fromTimestamp(row.last_seen_at),
      context: fromJson(row.context_json),
    };
  }

  private transitionOf(row: SqlRow): RunTransitionRecord {
    const fromTimestamp = this.adapter.dialect.fromTimestamp;
    return {
      id: textOf(row.id),
      runId: textOf(row.run_id),
      fromStateId: textOf(row.from_state_id),
      toStateId: isNull(row.to_state_id) ? null : textOf(row.to_state_id),
      actionId: textOf(row.action_id),
      actionSignature: textOf(row.action_signature),
      actionType: textOf(row.action_type),
      actionLabel: textOf(row.action_label),
      status: textOf(row.status) as RunTransitionRecord['status'],
      safetyClass: textOf(row.safety_class),
      safetyDecision: textOf(row.safety_decision) as RunTransitionRecord['safetyDecision'],
      ...optional('oracleStatus', row.oracle_status),
      ...(isNull(row.duration_ms) ? {} : { durationMs: Number(row.duration_ms) }),
      startedAt: fromTimestamp(row.started_at),
      finishedAt: fromTimestamp(row.finished_at),
    };
  }

  private knowledgeOf(row: SqlRow): TransitionKnowledgeRecord {
    const fromTimestamp = this.adapter.dialect.fromTimestamp;
    return {
      applicationId: textOf(row.application_id),
      fromStateSignature: textOf(row.from_state_signature),
      actionSignature: textOf(row.action_signature),
      toStateSignature: textOf(row.to_state_signature),
      seenCount: Number(row.seen_count),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      blockedCount: Number(row.blocked_count),
      ...(isNull(row.average_duration_ms) ? {} : { averageDurationMs: Number(row.average_duration_ms) }),
      firstSeenAt: fromTimestamp(row.first_seen_at),
      lastSeenAt: fromTimestamp(row.last_seen_at),
      ...(isNull(row.last_context_json)
        ? {}
        : { lastContext: this.adapter.dialect.fromJson(row.last_context_json) }),
    };
  }
}

/** Version du schéma attendue par ce crawler (pour les rapports). */
export const DATABASE_SCHEMA_VERSION = PERSISTENCE_SCHEMA_VERSION;

function optional<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return isNull(value) ? {} : ({ [key]: textOf(value) } as Record<K, string>);
}

function runRow(run: CrawlRunRecord): Record<string, SqlValue> {
  return {
    id: run.id,
    application_id: run.applicationId,
    mission_name: run.missionName,
    environment: run.environment ?? null,
    branch: run.branch ?? null,
    commit_sha: run.commitSha ?? null,
    crawler_version: run.crawlerVersion ?? null,
    mode: run.mode,
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? null,
    status: run.status,
    states_count: run.statesCount,
    actions_count: run.actionsCount,
    transitions_count: run.transitionsCount,
    anomalies_count: run.anomaliesCount,
  };
}

function stateRow(state: RunStateRecord): Record<string, SqlValue> {
  return {
    id: state.id,
    run_id: state.runId,
    state_signature: state.stateSignature,
    state_id: state.stateId,
    route_pattern: state.routePattern,
    url_normalized: state.urlNormalized,
    title: state.title ?? null,
    heading: state.heading ?? null,
    depth: state.depth,
    first_seen_at: state.firstSeenAt,
    last_seen_at: state.lastSeenAt,
    context_json: JSON.stringify(state.context),
  };
}

function transitionRow(transition: RunTransitionRecord): Record<string, SqlValue> {
  return {
    id: transition.id,
    run_id: transition.runId,
    from_state_id: transition.fromStateId,
    to_state_id: transition.toStateId,
    action_id: transition.actionId,
    action_signature: transition.actionSignature,
    action_type: transition.actionType,
    action_label: transition.actionLabel,
    status: transition.status,
    safety_class: transition.safetyClass,
    safety_decision: transition.safetyDecision,
    oracle_status: transition.oracleStatus ?? null,
    duration_ms: transition.durationMs ?? null,
    started_at: transition.startedAt,
    finished_at: transition.finishedAt,
  };
}

function knowledgeRow(record: TransitionKnowledgeRecord): Record<string, SqlValue> {
  return {
    application_id: record.applicationId,
    from_state_signature: record.fromStateSignature,
    action_signature: record.actionSignature,
    to_state_signature: record.toStateSignature,
    seen_count: record.seenCount,
    success_count: record.successCount,
    failure_count: record.failureCount,
    blocked_count: record.blockedCount,
    average_duration_ms: record.averageDurationMs ?? null,
    first_seen_at: record.firstSeenAt,
    last_seen_at: record.lastSeenAt,
    last_context_json: record.lastContext ? JSON.stringify(record.lastContext) : null,
  };
}
