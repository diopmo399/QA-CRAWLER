import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CartographyModel, Feature, MapDecision } from '../../src/sdk/core/cartography.js';
import { applyDecisions } from '../../src/cartography/decisions.js';
import { readSource } from '../../src/cartography/files.js';
import {
  appendDecision,
  CartographyStoreError,
  KEEP_SCANS,
  listScans,
  readConfig,
  readDecisions,
  readScan,
  writeConfig,
  writeScan,
} from '../../src/cartography/store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qa-map-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const feature = (id: string, name: string): Feature => ({
  id,
  name,
  proposedName: name,
  status: 'CANDIDATE',
  layers: ['FRONTEND'],
  nodes: [`N:${id}`],
  fields: [],
  chain: [],
  basis: 'test',
  evidence: [],
  reach: { [`N:${id}`]: 'CONFIRMED' },
});

const modelOf = (id: string, startedAt: string, features: Feature[] = []): CartographyModel => ({
  schema: 1,
  scan: {
    id,
    schema: 1,
    startedAt,
    state: 'COMPLETED',
    incremental: false,
    sources: [],
    counts: {},
    edges: 0,
    errors: [],
  },
  nodes: [],
  edges: [],
  features,
  concepts: [],
  issues: [],
});

describe('cartography store', () => {
  it('reads an absent configuration as empty, migrates an unversioned one and refuses a newer schema', async () => {
    expect(await readConfig(dir)).toEqual({ schema: 1, sources: [] });
    await mkdir(path.join(dir, 'cartography'), { recursive: true });
    await writeFile(path.join(dir, 'cartography/config.json'), JSON.stringify({ sources: [{ id: 'a' }] }));
    expect((await readConfig(dir)).sources).toEqual([{ id: 'a' }]);
    await writeFile(path.join(dir, 'cartography/config.json'), JSON.stringify({ schema: 2, sources: [] }));
    await expect(readConfig(dir)).rejects.toBeInstanceOf(CartographyStoreError);
    await writeConfig(dir, { schema: 1, sources: [], updatedAt: '2026-11-04T00:00:00Z' });
    expect((await readConfig(dir)).updatedAt).toBe('2026-11-04T00:00:00Z');
  });

  it('keeps the decision history in order and only the latest scans', async () => {
    await appendDecision(dir, { id: '1', at: '2026-11-04T10:00:00Z', kind: 'CONFIRM', target: 'F' });
    await appendDecision(dir, {
      id: '2',
      at: '2026-11-04T10:01:00Z',
      kind: 'RENAME',
      target: 'F',
      value: 'Create',
    });
    expect((await readDecisions(dir)).map((d) => d.id)).toEqual(['1', '2']);
    for (let index = 0; index < KEEP_SCANS + 2; index += 1) {
      const at = new Date(Date.UTC(2026, 10, 4, 10, index)).toISOString();
      await writeScan(dir, { model: modelOf(`scan-${String(index).padStart(2, '0')}`, at), facts: [] });
    }
    const scans = await listScans(dir);
    expect(scans).toHaveLength(KEEP_SCANS);
    expect(scans[0]?.id).toBe(`scan-${String(KEEP_SCANS + 1)}`);
    expect(await readScan(dir, 'scan-00')).toBeUndefined();
    // Un identifiant qui sortirait du dossier n'est jamais lu.
    expect(await readScan(dir, '../config')).toBeUndefined();
    expect((await readdir(path.join(dir, 'cartography/scans'))).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    );
  });
});

describe('cartography decisions', () => {
  it('replays confirm, rename, merge, reject and restore without changing the scan', () => {
    const model = modelOf('scan-a', '2026-11-04T10:00:00Z', [
      feature('A', 'Create'),
      feature('B', 'Create again'),
    ]);
    const decisions: MapDecision[] = [
      { id: '1', at: '2026-11-04T10:00:00Z', kind: 'RENAME', target: 'A', value: '  Create a request ' },
      { id: '2', at: '2026-11-04T10:01:00Z', kind: 'MERGE', target: 'A', value: 'B' },
      { id: '3', at: '2026-11-04T10:02:00Z', kind: 'CONFIRM', target: 'A' },
      { id: '4', at: '2026-11-04T10:03:00Z', kind: 'CONFIRM', target: 'missing' },
    ];
    const decided = applyDecisions(model, decisions);
    expect(decided.features).toHaveLength(1);
    expect(decided.features[0]).toMatchObject({
      name: 'Create a request',
      proposedName: 'Create',
      status: 'CONFIRMED',
      mergedFrom: ['B'],
    });
    expect(decided.features[0]?.nodes).toEqual(['N:A', 'N:B']);
    // Le modèle du scan reste tel qu'il a été calculé.
    expect(model.features).toHaveLength(2);
    const restored = applyDecisions(model, [
      ...decisions,
      { id: '5', at: '2026-11-04T10:04:00Z', kind: 'REJECT', target: 'A' },
      { id: '6', at: '2026-11-04T10:05:00Z', kind: 'RESTORE', target: 'A' },
    ]);
    expect(restored.features[0]).toMatchObject({ status: 'CANDIDATE', name: 'Create' });
  });
});

describe('cartography source reading', () => {
  it('skips secrets, dependencies and symbolic links, and stops at the limits', async () => {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules/lib'), { recursive: true });
    await writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(dir, 'src/b.ts'), 'export const b = 2;\n');
    await writeFile(path.join(dir, '.env'), 'TOKEN=x\n');
    await writeFile(path.join(dir, 'server.pem'), 'x\n');
    await writeFile(path.join(dir, 'node_modules/lib/index.js'), 'x\n');
    await symlink(path.join(dir, 'src/a.ts'), path.join(dir, 'src/link.ts'));
    const read = await readSource(dir, []);
    expect(read.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(read.secretsExcluded).toBe(2);
    expect(read.limits).toEqual([]);
    const limited = await readSource(dir, [], { maxFiles: 1, maxFileBytes: 1024, maxDurationMs: 60_000 });
    expect(limited.files).toHaveLength(1);
    expect(limited.limits.length).toBeGreaterThan(0);
    // Limitée à un sous-dossier : les fichiers d'à côté ne sont pas lus ; un dossier hors de la source est ignoré.
    const scoped = await readSource(dir, ['src', '../elsewhere']);
    expect(scoped.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(scoped.secretsExcluded).toBe(0);
    expect(scoped.limits.join(' ')).toContain('outside the source');
  });

  it('never reads dependency lock files; names the files too large to be read', async () => {
    const big = path.join(dir, 'big');
    await mkdir(path.join(big, 'src/assets'), { recursive: true });
    await writeFile(path.join(big, 'package.json'), '{"name":"app"}\n');
    await writeFile(path.join(big, 'package-lock.json'), `{"lock":"${'x'.repeat(4096)}"}\n`);
    await writeFile(path.join(big, 'pnpm-lock.yaml'), `lock: ${'x'.repeat(4096)}\n`);
    await writeFile(path.join(big, 'src/app.ts'), 'export const app = 1;\n');
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f'])
      await writeFile(path.join(big, `src/assets/${name}.json`), `{"v":"${'x'.repeat(2048)}"}\n`);
    const limits = { maxFiles: 100, maxFileBytes: 1024, maxDurationMs: 60_000 };
    const read = await readSource(big, [], limits);
    expect(read.files.map((f) => f.path).sort()).toEqual(['package.json', 'src/app.ts']);
    expect(read.skipped).toBe(6);
    expect(read.limits).toEqual([
      'files larger than 1024 bytes skipped (6): src/assets/a.json, src/assets/b.json, src/assets/c.json, src/assets/d.json, src/assets/e.json, …',
    ]);
    // Sans fichier trop gros, la source n'a aucune note : les fichiers lock ne la rendent pas partielle.
    await rm(path.join(big, 'src/assets'), { recursive: true });
    expect((await readSource(big, [], limits)).limits).toEqual([]);
  });
});
