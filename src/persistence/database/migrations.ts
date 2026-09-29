import type { DatabaseAdapter, SqlDialect } from './database-adapter.js';

/**
 * MIGRATIONS VERSIONNÉES : chacune n'est appliquée qu'une fois, dans une transaction, et
 * enregistrée dans qa_schema_migrations. Elles ne font qu'ajouter (tables, index) :
 * jamais de suppression ni de modification destructive au démarrage. La version du
 * schéma est le nombre de migrations appliquées.
 */
export interface Migration {
  id: string;
  statements(dialect: SqlDialect): string[];
}

export const MIGRATIONS_TABLE = 'qa_schema_migrations';

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_initial_schema',
    statements: (d) => [
      d.createTableIfMissing(
        'crawl_run',
        `id ${d.types.id} NOT NULL PRIMARY KEY,
        application_id ${d.types.signature} NOT NULL,
        mission_name ${d.types.name} NOT NULL,
        environment ${d.types.name} NULL,
        branch ${d.types.name} NULL,
        commit_sha ${d.types.name} NULL,
        crawler_version ${d.types.name} NULL,
        mode ${d.types.name} NOT NULL,
        started_at ${d.types.timestamp} NOT NULL,
        finished_at ${d.types.timestamp} NULL,
        status ${d.types.name} NOT NULL,
        states_count ${d.types.int} NOT NULL,
        actions_count ${d.types.int} NOT NULL,
        transitions_count ${d.types.int} NOT NULL,
        anomalies_count ${d.types.int} NOT NULL`,
      ),
      d.createIndexIfMissing(
        'ix_crawl_run_application',
        'crawl_run',
        ['application_id', 'started_at'],
        false,
      ),
      d.createTableIfMissing(
        'run_state',
        `id ${d.types.id} NOT NULL PRIMARY KEY,
        run_id ${d.types.id} NOT NULL REFERENCES crawl_run (id),
        state_signature ${d.types.signature} NOT NULL,
        state_id ${d.types.signature} NOT NULL,
        route_pattern ${d.types.url} NOT NULL,
        url_normalized ${d.types.url} NOT NULL,
        title ${d.types.label} NULL,
        heading ${d.types.label} NULL,
        depth ${d.types.int} NOT NULL,
        first_seen_at ${d.types.timestamp} NOT NULL,
        last_seen_at ${d.types.timestamp} NOT NULL,
        context_json ${d.types.json} NOT NULL`,
      ),
      d.createIndexIfMissing('ux_run_state_run_state', 'run_state', ['run_id', 'state_id'], true),
      d.createTableIfMissing(
        'run_transition',
        `id ${d.types.id} NOT NULL PRIMARY KEY,
        run_id ${d.types.id} NOT NULL REFERENCES crawl_run (id),
        from_state_id ${d.types.signature} NOT NULL,
        to_state_id ${d.types.signature} NULL,
        action_id ${d.types.signature} NOT NULL,
        action_signature ${d.types.signature} NOT NULL,
        action_type ${d.types.name} NOT NULL,
        action_label ${d.types.label} NOT NULL,
        status ${d.types.name} NOT NULL,
        safety_class ${d.types.name} NOT NULL,
        safety_decision ${d.types.name} NOT NULL,
        oracle_status ${d.types.name} NULL,
        duration_ms ${d.types.int} NULL,
        started_at ${d.types.timestamp} NOT NULL,
        finished_at ${d.types.timestamp} NOT NULL`,
      ),
      d.createIndexIfMissing('ix_run_transition_run', 'run_transition', ['run_id'], false),
    ],
  },
  {
    id: '002_add_transition_knowledge',
    statements: (d) => [
      d.createTableIfMissing(
        'transition_knowledge',
        `id ${d.types.id} NOT NULL PRIMARY KEY,
        application_id ${d.types.signature} NOT NULL,
        from_state_signature ${d.types.signature} NOT NULL,
        action_signature ${d.types.signature} NOT NULL,
        to_state_signature ${d.types.signature} NOT NULL,
        seen_count ${d.types.int} NOT NULL,
        success_count ${d.types.int} NOT NULL,
        failure_count ${d.types.int} NOT NULL,
        blocked_count ${d.types.int} NOT NULL,
        average_duration_ms ${d.types.double} NULL,
        first_seen_at ${d.types.timestamp} NOT NULL,
        last_seen_at ${d.types.timestamp} NOT NULL`,
      ),
      // Une ligne par destination : plusieurs lignes pour un même écran + une même action.
      d.createIndexIfMissing(
        'ux_transition_knowledge_key',
        'transition_knowledge',
        ['application_id', 'from_state_signature', 'action_signature', 'to_state_signature'],
        true,
      ),
      d.createIndexIfMissing(
        'ix_transition_knowledge_recent',
        'transition_knowledge',
        ['application_id', 'last_seen_at'],
        false,
      ),
    ],
  },
];

export interface MigrationResult {
  version: number;
  applied: string[];
}

export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

/** Les migrations déjà appliquées (aucune si la table de suivi n'existe pas encore). */
export async function appliedMigrations(adapter: DatabaseAdapter): Promise<string[]> {
  try {
    const rows = await adapter.query(`SELECT id FROM ${MIGRATIONS_TABLE}`);
    return rows.map((row) => String(row.id));
  } catch {
    return [];
  }
}

/**
 * Amène le schéma à la version de ce crawler. `apply: false` (persistence.database.migrate:
 * false) ne modifie rien : une base en retard est une erreur claire. Une base plus récente
 * que ce crawler n'est jamais touchée.
 */
export async function migrate(
  adapter: DatabaseAdapter,
  options: { apply: boolean },
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationResult> {
  let applied = await appliedMigrations(adapter);
  const known = new Set(migrations.map((migration) => migration.id));
  const unknown = applied.filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new SchemaVersionError(
      `the database schema is newer than this crawler (unknown migrations: ${unknown.join(', ')}): upgrade QA-CRAWLER`,
    );
  const pending = migrations.filter((migration) => !applied.includes(migration.id));
  if (pending.length === 0) return { version: applied.length, applied: [] };
  if (!options.apply)
    throw new SchemaVersionError(
      `the database schema is at version ${applied.length}, this crawler needs ${migrations.length} (pending: ${pending
        .map((migration) => migration.id)
        .join(
          ', ',
        )}): set persistence.database.migrate: true, or apply them with a user allowed to create tables`,
    );
  const { dialect } = adapter;
  await adapter.query(
    dialect.createTableIfMissing(
      MIGRATIONS_TABLE,
      `id ${dialect.types.name} NOT NULL PRIMARY KEY, applied_at ${dialect.types.timestamp} NOT NULL`,
    ),
  );
  const done: string[] = [];
  for (const migration of pending) {
    try {
      await adapter.transaction(async (tx) => {
        for (const statement of migration.statements(dialect)) await tx.query(statement);
        await tx.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (${dialect.param(1)}, ${dialect.param(2)})`,
          [migration.id, new Date().toISOString()],
        );
      });
      done.push(migration.id);
    } catch (error) {
      // Un autre crawler l'a appliquée au même moment : ce n'est pas une erreur.
      applied = await appliedMigrations(adapter);
      if (!applied.includes(migration.id)) throw error;
    }
  }
  return { version: (await appliedMigrations(adapter)).length, applied: done };
}
