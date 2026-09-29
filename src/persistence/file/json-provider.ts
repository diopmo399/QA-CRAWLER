import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../../memory/atomic-write.js';
import { PERSISTENCE_SCHEMA_VERSION, type PersistenceHealth } from '../model.js';
import { emptyTables, InMemoryPersistenceProvider, type MemoryTables } from '../memory/in-memory-provider.js';
import type { PersistenceKind } from '../persistence-provider.js';

/** Un fichier JSON par table, avec la version du schéma. */
interface TableFile<T> {
  schemaVersion: number;
  rows: T[];
}

const FILES: Record<keyof MemoryTables, string> = {
  runs: 'crawl-runs.json',
  states: 'run-states.json',
  transitions: 'run-transitions.json',
  knowledge: 'transition-knowledge.json',
  evolution: 'flow-evolution.json',
  anomalies: 'anomaly-lifecycle.json',
};

/**
 * Provider fichier : les tables du provider en mémoire, enregistrées dans un dossier
 * (un fichier JSON par table, écriture atomique : fichier temporaire + renommage, comme
 * le graphe des flows et la base de connaissances). Chaque écriture enregistre sa table
 * tout de suite : un crash ne perd que ce qui n'avait pas encore été écrit.
 * Adapté à un poste ou à la CI ; pour de gros historiques partagés, une base de données.
 */
export class JsonPersistenceProvider extends InMemoryPersistenceProvider {
  override readonly kind: PersistenceKind = 'file';
  override readonly description = 'file';

  constructor(readonly directory: string) {
    super();
  }

  override async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const tables = emptyTables();
    for (const table of Object.keys(FILES) as (keyof MemoryTables)[]) {
      const file = path.join(this.directory, FILES[table]);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue; // premier run
      }
      const parsed = JSON.parse(text) as Partial<TableFile<unknown>>;
      if (typeof parsed.schemaVersion !== 'number' || parsed.schemaVersion > PERSISTENCE_SCHEMA_VERSION)
        throw new Error(`${file}: unknown persistence schema version ${String(parsed.schemaVersion)}`);
      (tables[table] as unknown[]) = Array.isArray(parsed.rows) ? parsed.rows : [];
    }
    this.tables = tables;
  }

  override async healthCheck(): Promise<PersistenceHealth> {
    const started = Date.now();
    try {
      await mkdir(this.directory, { recursive: true });
      return {
        status: 'CONNECTED',
        latencyMs: Date.now() - started,
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      };
    } catch (error) {
      return { status: 'UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  protected override async afterWrite(table: keyof MemoryTables): Promise<void> {
    const content: TableFile<unknown> = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      rows: this.tables[table],
    };
    await writeFileAtomic(path.join(this.directory, FILES[table]), `${JSON.stringify(content, null, 2)}\n`);
  }
}
