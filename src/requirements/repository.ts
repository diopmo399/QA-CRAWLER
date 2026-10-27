import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImportBatch, RequirementsRepository } from './model.js';

/**
 * LA PERSISTANCE DU RÉFÉRENTIEL (décision D1) : des fichiers JSON dans le dossier du projet.
 *
 *   <dir>/repository.json         le référentiel publié (entités, liens, historiques)
 *   <dir>/imports/<lot>.json      chaque lot d'importation (candidats, problèmes, décisions)
 *
 * Écriture atomique (fichier temporaire puis renommage) et écritures en série dans le programme :
 * un lecteur ne voit jamais un fichier à moitié écrit. Rien n'est supprimé : un lot reste, une
 * entité garde son historique.
 */
const BATCH_ID = /^imp_[A-Za-z0-9_-]{6,64}$/;

export class RequirementsStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  private get repositoryFile(): string {
    return path.join(this.dir, 'repository.json');
  }

  private batchFile(id: string): string {
    if (!BATCH_ID.test(id)) throw new Error(`invalid import identifier: ${id}`);
    return path.join(this.dir, 'imports', `${id}.json`);
  }

  /** Les modifications passent l'une après l'autre (lecture, changement, écriture). */
  update<T>(change: () => Promise<T>): Promise<T> {
    const next = this.chain.then(change, change);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async readRepository(): Promise<RequirementsRepository> {
    const raw = await readOptional(this.repositoryFile);
    if (raw === undefined) return { formatVersion: 1, entities: [], links: [] };
    const parsed = JSON.parse(raw) as Partial<RequirementsRepository>;
    if (parsed.formatVersion !== 1 || !Array.isArray(parsed.entities) || !Array.isArray(parsed.links))
      throw new Error(`${this.repositoryFile}: not a requirements repository (formatVersion 1)`);
    return parsed as RequirementsRepository;
  }

  writeRepository(repository: RequirementsRepository): Promise<void> {
    return writeAtomic(this.repositoryFile, repository);
  }

  async readBatch(id: string): Promise<ImportBatch | undefined> {
    const raw = await readOptional(this.batchFile(id));
    return raw === undefined ? undefined : (JSON.parse(raw) as ImportBatch);
  }

  writeBatch(batch: ImportBatch): Promise<void> {
    return writeAtomic(this.batchFile(batch.id), batch);
  }

  /** Les lots, du plus récent au plus ancien. */
  async listBatches(): Promise<ImportBatch[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.dir, 'imports'));
    } catch {
      return [];
    }
    const batches: ImportBatch[] = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !BATCH_ID.test(id)) continue;
      const batch = await this.readBatch(id);
      if (batch) batches.push(batch);
    }
    return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'x')}`;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}
