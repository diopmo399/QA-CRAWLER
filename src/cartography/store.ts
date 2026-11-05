import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CartographyConfig,
  CartographyModel,
  MapDecision,
  ScanRecord,
} from '../sdk/core/cartography.js';
import type { SourceFacts } from './facts.js';

/**
 * LA PERSISTANCE DE LA CARTOGRAPHIE, dans le dossier du projet (`cartography/`) : la configuration des
 * sources, les décisions (historique, jamais réécrit), et les scans (le modèle et les faits de chaque
 * source, pour la comparaison et le scan incrémental). Chaque document porte son schéma ; un document
 * plus ancien est migré à la lecture, sans réécrire le fichier ; un schéma inconnu est refusé.
 * Écriture atomique (fichier temporaire puis renommage). Seuls les derniers scans sont gardés.
 */
export const CARTOGRAPHY_DIR = 'cartography';
export const KEEP_SCANS = 20;
const SCHEMA = 1;

export class CartographyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CartographyStoreError';
  }
}

const dir = (projectDir: string): string => path.join(projectDir, CARTOGRAPHY_DIR);
const scansDir = (projectDir: string): string => path.join(dir(projectDir), 'scans');

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CartographyStoreError(
      `unreadable cartography file ${path.basename(file)}: ${(error as Error).message}`,
    );
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

/** Le schéma d'un document : absent = 1 (les premiers documents) ; plus récent que le code = refusé. */
function migrate<T extends { schema?: number }>(
  value: T | undefined,
  what: string,
): (T & { schema: 1 }) | undefined {
  if (value === undefined) return undefined;
  const schema = value.schema ?? 1;
  if (schema > SCHEMA)
    throw new CartographyStoreError(
      `${what} uses schema ${String(schema)}, newer than this version (${String(SCHEMA)})`,
    );
  return { ...value, schema: 1 };
}

export async function readConfig(projectDir: string): Promise<CartographyConfig> {
  const raw = (await readJson(path.join(dir(projectDir), 'config.json'))) as
    Partial<CartographyConfig> | undefined;
  const config = migrate(raw, 'the cartography configuration');
  return {
    schema: 1,
    sources: config?.sources ?? [],
    ...(config?.updatedAt ? { updatedAt: config.updatedAt } : {}),
  };
}

export async function writeConfig(projectDir: string, config: CartographyConfig): Promise<void> {
  await writeJson(path.join(dir(projectDir), 'config.json'), config);
}

export async function readDecisions(projectDir: string): Promise<MapDecision[]> {
  const raw = (await readJson(path.join(dir(projectDir), 'decisions.json'))) as
    { schema?: number; decisions?: MapDecision[] } | undefined;
  return migrate(raw, 'the cartography decisions')?.decisions ?? [];
}

export async function appendDecision(projectDir: string, decision: MapDecision): Promise<MapDecision[]> {
  const decisions = [...(await readDecisions(projectDir)), decision];
  await writeJson(path.join(dir(projectDir), 'decisions.json'), { schema: SCHEMA, decisions });
  return decisions;
}

export interface StoredScan {
  model: CartographyModel;
  facts: SourceFacts[];
}

export async function writeScan(projectDir: string, scan: StoredScan): Promise<void> {
  await writeJson(path.join(scansDir(projectDir), `${scan.model.scan.id}.json`), { schema: SCHEMA, ...scan });
  // Seuls les derniers scans sont gardés (les plus anciens d'abord retirés).
  const records = await listScans(projectDir);
  for (const old of records.slice(KEEP_SCANS))
    await rm(path.join(scansDir(projectDir), `${old.id}.json`), { force: true });
}

export async function readScan(projectDir: string, id: string): Promise<StoredScan | undefined> {
  if (!/^scan-[\w-]{1,80}$/.test(id)) return undefined;
  const raw = (await readJson(path.join(scansDir(projectDir), `${id}.json`))) as
    (Partial<StoredScan> & { schema?: number }) | undefined;
  const stored = migrate(raw, `the scan ${id}`);
  if (!stored?.model) return undefined;
  return { model: stored.model, facts: stored.facts ?? [] };
}

/** Les scans enregistrés, les plus récents d'abord (le relevé seulement). */
export async function listScans(projectDir: string): Promise<ScanRecord[]> {
  let names: string[];
  try {
    names = await readdir(scansDir(projectDir));
  } catch {
    return [];
  }
  const records: ScanRecord[] = [];
  for (const name of names.filter((entry) => /^scan-[\w-]+\.json$/.test(entry))) {
    const stored = await readScan(projectDir, name.replace(/\.json$/, '')).catch(() => undefined);
    if (stored) records.push(stored.model.scan);
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}
