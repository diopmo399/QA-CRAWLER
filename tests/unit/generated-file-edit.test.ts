import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  editGeneratedFile,
  generationManifest,
  ORIGINALS_DIR,
} from '../../src/recording/recording-workspace.js';

/**
 * MODIFIER UN FICHIER GÉNÉRÉ À LA MAIN (sans navigateur) : vérifié avec l'outil de son format avant
 * d'être écrit ; refusé sans rien écrire ; la version générée gardée une fois, puis remise ; aucun
 * chemin hors de generated/. Le parcours par le serveur et l'écran : sdk-generated-test-runs et
 * sdk-dashboard-tests (intégration).
 */
const FLOW = 'name: Ouvrir une fiche\nsteps:\n  - click: { role: link, name: Utilisateurs }\n';
const SPEC =
  "import { test } from '@playwright/test';\n\ntest('ouvrir', async ({ page }) => {\n  await page.goto('http://127.0.0.1:9/');\n});\n";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'qa-edit-'));
  await mkdir(path.join(directory, 'generated', 'playwright'), { recursive: true });
  await writeFile(path.join(directory, 'generated', 'ouvrir.flow.yaml'), FLOW);
  await writeFile(path.join(directory, 'generated', 'playwright', 'ouvrir.spec.ts'), SPEC);
  const artifact = (format: string, file: string) => ({
    format,
    path: file,
    status: 'STATICALLY_VALIDATED',
    validation: { method: 'check', ok: true, messages: [] },
    assertions: [],
    limits: [],
  });
  await writeFile(
    path.join(directory, 'generation.json'),
    JSON.stringify({
      generatedAt: '2026-10-28T10:00:00.000Z',
      flow: 'Ouvrir une fiche',
      summary: { kept: true },
      warnings: [],
      artifacts: [artifact('yaml', 'ouvrir.flow.yaml'), artifact('playwright', 'playwright/ouvrir.spec.ts')],
    }),
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const failure = (outcome: Awaited<ReturnType<typeof editGeneratedFile>>): string =>
  'error' in outcome ? outcome.error : '';

const onDisk = (file: string): Promise<string> => readFile(path.join(directory, 'generated', file), 'utf8');

describe('editing a generated file', () => {
  it('saves a change that passes the check of its format, marks it, and keeps the generated version', async () => {
    const changed = `${FLOW}  - click: { role: link, name: Utilisateur 1 }\n`;
    const outcome = await editGeneratedFile(directory, 'ouvrir.flow.yaml', { content: changed });
    expect('error' in outcome).toBe(false);
    if ('error' in outcome) return;
    expect(outcome.artifact).toMatchObject({ status: 'STATICALLY_VALIDATED', validation: { ok: true } });
    expect(outcome.artifact.editedAt).toBeDefined();
    expect(await onDisk('ouvrir.flow.yaml')).toBe(changed);
    expect(await readFile(path.join(directory, ORIGINALS_DIR, 'ouvrir.flow.yaml'), 'utf8')).toBe(FLOW);
    const manifest = await generationManifest(directory);
    expect(manifest?.artifacts.find((entry) => entry.path === 'ouvrir.flow.yaml')?.editedAt).toBeDefined();
    // Le reste de generation.json est gardé.
    const raw = JSON.parse(await readFile(path.join(directory, 'generation.json'), 'utf8')) as {
      summary: unknown;
    };
    expect(raw.summary).toEqual({ kept: true });
    // Aucune copie de travail laissée.
    expect((await readdir(directory)).filter((name) => name.startsWith('.edit-'))).toEqual([]);
  });

  it('refuses a change that fails the check, with the reasons, and writes nothing', async () => {
    const outcome = await editGeneratedFile(directory, 'ouvrir.flow.yaml', {
      content: 'name: x\nsteps: 12\n',
    });
    expect(failure(outcome)).toContain('nothing was saved');
    if (!('error' in outcome)) return;
    expect(outcome.messages.length).toBeGreaterThan(0);
    expect(await onDisk('ouvrir.flow.yaml')).toBe(FLOW);
    await expect(readFile(path.join(directory, ORIGINALS_DIR, 'ouvrir.flow.yaml'))).rejects.toThrow();
    const broken = await editGeneratedFile(directory, 'playwright/ouvrir.spec.ts', {
      content: "test('x', async () => { await ;\n",
    });
    expect('error' in broken).toBe(true);
    expect(await onDisk('playwright/ouvrir.spec.ts')).toBe(SPEC);
  });

  it('keeps the generated version of the first edit, and restores it', async () => {
    await editGeneratedFile(directory, 'playwright/ouvrir.spec.ts', {
      content: SPEC.replace('ouvrir', 'premier'),
    });
    await editGeneratedFile(directory, 'playwright/ouvrir.spec.ts', {
      content: SPEC.replace('ouvrir', 'second'),
    });
    expect(await readFile(path.join(directory, ORIGINALS_DIR, 'playwright', 'ouvrir.spec.ts'), 'utf8')).toBe(
      SPEC,
    );
    const restored = await editGeneratedFile(directory, 'playwright/ouvrir.spec.ts', { restore: true });
    expect('error' in restored).toBe(false);
    if ('error' in restored) return;
    expect(restored.artifact.editedAt).toBeUndefined();
    expect(await onDisk('playwright/ouvrir.spec.ts')).toBe(SPEC);
    await expect(
      readFile(path.join(directory, ORIGINALS_DIR, 'playwright', 'ouvrir.spec.ts')),
    ).rejects.toThrow();
    expect(
      failure(await editGeneratedFile(directory, 'playwright/ouvrir.spec.ts', { restore: true })),
    ).toContain('has not been edited');
  });

  it('only edits a file described by generation.json, never outside generated/', async () => {
    expect(failure(await editGeneratedFile(directory, '../generation.json', { content: '{}' }))).toContain(
      'is not a generated file',
    );
    expect(failure(await editGeneratedFile(directory, 'other.flow.yaml', { content: FLOW }))).toContain(
      'is not a generated file',
    );
  });
});
