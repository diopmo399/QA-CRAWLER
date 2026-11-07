import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CartographyConfig,
  CartographyModel,
  Investigation,
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

async function writeJson(file: string, value: unknown, compact = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(temporary, `${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
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

/**
 * Un scan est écrit en JSON compact (le fichier complet ne se lit qu'à l'ouverture de son index), et son
 * relevé (quelques ko) à côté : lister les scans ne relit jamais les modèles et les faits.
 */
export async function writeScan(projectDir: string, scan: StoredScan): Promise<void> {
  await writeJson(
    path.join(scansDir(projectDir), `${scan.model.scan.id}.json`),
    { schema: SCHEMA, ...scan },
    true,
  );
  await writeRecord(projectDir, scan.model.scan);
  // Seuls les derniers scans sont gardés (les plus anciens d'abord retirés).
  const records = await listScans(projectDir);
  for (const old of records.slice(KEEP_SCANS)) {
    await rm(path.join(scansDir(projectDir), `${old.id}.json`), { force: true });
    await rm(recordFile(projectDir, old.id), { force: true });
  }
}

const recordFile = (projectDir: string, id: string): string =>
  path.join(scansDir(projectDir), `${id}.record.json`);

async function writeRecord(projectDir: string, record: ScanRecord): Promise<void> {
  await writeJson(recordFile(projectDir, record.id), { schema: SCHEMA, record }, true);
}

/** Le relevé d'un scan : son fichier léger ; un scan d'avant ce relevé est lu une fois, puis son relevé écrit. */
async function readRecord(projectDir: string, id: string): Promise<ScanRecord | undefined> {
  const raw = (await readJson(recordFile(projectDir, id)).catch(() => undefined)) as
    { schema?: number; record?: ScanRecord } | undefined;
  if (raw?.record?.id === id) return raw.record;
  const stored = await readScan(projectDir, id);
  if (!stored) return undefined;
  await writeRecord(projectDir, stored.model.scan).catch(() => undefined);
  return stored.model.scan;
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
    const record = await readRecord(projectDir, name.replace(/\.json$/, '')).catch(() => undefined);
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

// ── Investigations : leur frontière est gardée, une reprise repart d'elle ───────────────────────────

export const KEEP_INVESTIGATIONS = 50;
const investigationsDir = (projectDir: string): string => path.join(dir(projectDir), 'investigations');
const INVESTIGATION_ID = /^inv-[a-z0-9-]{1,60}$/;

export async function writeInvestigation(projectDir: string, investigation: Investigation): Promise<void> {
  if (!INVESTIGATION_ID.test(investigation.id)) throw new CartographyStoreError('invalid investigation id');
  await writeJson(path.join(investigationsDir(projectDir), `${investigation.id}.json`), {
    schema: SCHEMA,
    investigation,
  });
  const all = await listInvestigations(projectDir);
  for (const old of all.slice(KEEP_INVESTIGATIONS))
    await rm(path.join(investigationsDir(projectDir), `${old.id}.json`), { force: true });
}

export async function readInvestigation(projectDir: string, id: string): Promise<Investigation | undefined> {
  if (!INVESTIGATION_ID.test(id)) return undefined;
  const raw = (await readJson(path.join(investigationsDir(projectDir), `${id}.json`))) as
    { schema?: number; investigation?: Investigation } | undefined;
  return migrate(raw, `the investigation ${id}`)?.investigation;
}

/** Les investigations enregistrées, les plus récemment mises à jour d'abord. */
export async function listInvestigations(projectDir: string): Promise<Investigation[]> {
  let names: string[];
  try {
    names = await readdir(investigationsDir(projectDir));
  } catch {
    return [];
  }
  const out: Investigation[] = [];
  for (const name of names.filter((entry) => /^inv-[a-z0-9-]+\.json$/.test(entry))) {
    const inv = await readInvestigation(projectDir, name.replace(/\.json$/, '')).catch(() => undefined);
    if (inv) out.push(inv);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}
