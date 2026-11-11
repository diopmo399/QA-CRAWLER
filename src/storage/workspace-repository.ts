import { createHash } from 'node:crypto';
import type { DatabaseAdapter, SqlRow } from '../persistence/database/database-adapter.js';
import { migrate } from '../persistence/database/migrations.js';

/** Une entrée du miroir : un fichier du dossier de travail, son texte en base ou sa clé d'objet. */
export interface MirrorEntry {
  path: string;
  kind: 'document' | 'object';
  sha256: string;
  size: number;
  /** Le texte d'un document. */
  content?: string;
  /** La clé d'un objet dans le stockage objet. */
  objectKey?: string;
  updatedAt: string;
}

/** Le bail est tenu par un autre serveur, encore vivant. */
export class StorageLeaseError extends Error {
  constructor(
    message: string,
    readonly holder: string,
    readonly expiresAt: string,
  ) {
    super(message);
    this.name = 'StorageLeaseError';
  }
}

const id = (space: string, path: string): string =>
  createHash('sha256').update(`${space}\u0000${path}`).digest('hex');

/**
 * L'index du miroir et le bail d'écriture, en base (PostgreSQL, SQL Server ou SQLite), par les
 * adaptateurs existants : aucun SQL propre à un moteur. Le schéma est créé par les migrations
 * additives communes (006_add_workspace_mirror).
 */
export class WorkspaceRepository {
  constructor(
    readonly adapter: DatabaseAdapter,
    readonly space: string,
  ) {}

  private p(index: number): string {
    return this.adapter.dialect.param(index);
  }

  async open(options: { migrate: boolean }): Promise<void> {
    await this.adapter.connect();
    await migrate(this.adapter, { apply: options.migrate });
  }

  async close(): Promise<void> {
    await this.adapter.disconnect();
  }

  private entry(row: SqlRow): MirrorEntry {
    const kind = row.kind === 'object' ? 'object' : 'document';
    return {
      path: String(row.file_path),
      kind,
      sha256: String(row.sha256),
      size: Number(row.size_bytes),
      ...(typeof row.content === 'string' ? { content: row.content } : {}),
      ...(typeof row.object_key === 'string' ? { objectKey: row.object_key } : {}),
      updatedAt: this.adapter.dialect.fromTimestamp(row.updated_at),
    };
  }

  /** Toutes les entrées, sans le texte des documents (l'index). */
  async list(): Promise<MirrorEntry[]> {
    const rows = await this.adapter.query(
      `SELECT file_path, kind, sha256, size_bytes, object_key, updated_at FROM workspace_file WHERE space = ${this.p(1)}`,
      [this.space],
    );
    return rows.map((row) => this.entry(row));
  }

  /** Une entrée avec son texte. */
  async read(path: string): Promise<MirrorEntry | undefined> {
    const rows = await this.adapter.query(
      `SELECT file_path, kind, sha256, size_bytes, content, object_key, updated_at FROM workspace_file WHERE id = ${this.p(1)}`,
      [id(this.space, path)],
    );
    return rows[0] ? this.entry(rows[0]) : undefined;
  }

  async upsert(entry: Omit<MirrorEntry, 'updatedAt'>): Promise<void> {
    const key = id(this.space, entry.path);
    const values = [
      entry.kind,
      entry.sha256,
      entry.size,
      entry.content ?? null,
      entry.objectKey ?? null,
      new Date().toISOString(),
    ];
    await this.adapter.transaction(async (tx) => {
      const exists = await tx.query(`SELECT id FROM workspace_file WHERE id = ${this.p(1)}`, [key]);
      if (exists.length > 0)
        await tx.query(
          `UPDATE workspace_file SET kind = ${this.p(1)}, sha256 = ${this.p(2)}, size_bytes = ${this.p(3)}, content = ${this.p(4)}, object_key = ${this.p(5)}, updated_at = ${this.p(6)} WHERE id = ${this.p(7)}`,
          [...values, key],
        );
      else
        await tx.query(
          `INSERT INTO workspace_file (id, space, file_path, kind, sha256, size_bytes, content, object_key, updated_at) VALUES (${[
            1, 2, 3, 4, 5, 6, 7, 8, 9,
          ]
            .map((i) => this.p(i))
            .join(', ')})`,
          [key, this.space, entry.path, ...values],
        );
    });
  }

  async remove(path: string): Promise<void> {
    await this.adapter.query(`DELETE FROM workspace_file WHERE id = ${this.p(1)}`, [id(this.space, path)]);
  }

  /** Combien d'entrées de cet espace désignent encore cet objet (un objet n'est supprimé qu'à zéro). */
  async objectReferences(objectKey: string): Promise<number> {
    const rows = await this.adapter.query(
      `SELECT COUNT(*) AS n FROM workspace_file WHERE space = ${this.p(1)} AND object_key = ${this.p(2)}`,
      [this.space, objectKey],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Prendre ou renouveler le bail d'écriture de l'espace : refusé si un autre serveur le tient et
   * n'a pas expiré, sauf `takeover` (reprise volontaire après l'arrêt brutal d'un serveur).
   */
  async acquireLease(holder: string, ttlMs: number, takeover = false): Promise<void> {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    await this.adapter.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT holder, expires_at FROM ${this.adapter.dialect.lockedTable('workspace_lease')} WHERE space = ${this.p(1)}${this.adapter.dialect.lockSuffix}`,
        [this.space],
      );
      const current = rows[0];
      if (!current) {
        await tx.query(
          `INSERT INTO workspace_lease (space, holder, expires_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)})`,
          [this.space, holder, expires],
        );
        return;
      }
      const other = String(current.holder);
      const until = this.adapter.dialect.fromTimestamp(current.expires_at);
      if (other !== holder && new Date(until).getTime() > now.getTime() && !takeover)
        throw new StorageLeaseError(
          `the workspace "${this.space}" is held by another server (${other}) until ${until}; stop it, or start with --storage-takeover if it crashed`,
          other,
          until,
        );
      await tx.query(
        `UPDATE workspace_lease SET holder = ${this.p(1)}, expires_at = ${this.p(2)} WHERE space = ${this.p(3)}`,
        [holder, expires, this.space],
      );
    });
  }

  /** Le bail est-il toujours à nous ? (Un autre serveur l'a peut-être repris.) */
  async holdsLease(holder: string): Promise<boolean> {
    const rows = await this.adapter.query(`SELECT holder FROM workspace_lease WHERE space = ${this.p(1)}`, [
      this.space,
    ]);
    return rows[0] !== undefined && String(rows[0].holder) === holder;
  }

  async releaseLease(holder: string): Promise<void> {
    await this.adapter.query(
      `DELETE FROM workspace_lease WHERE space = ${this.p(1)} AND holder = ${this.p(2)}`,
      [this.space, holder],
    );
  }
}
