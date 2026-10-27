import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { pdfjsModule, type RequirementsRepository } from '../../src/requirements/index.js';

/**
 * LA DÉMONSTRATION DES EXIGENCES (examples/requirements-demo/demo.mjs) lancée comme un vrai programme,
 * sur les documents fictifs de data/ : chaque étape donne ce que la documentation annonce.
 */
const run = promisify(execFile);
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
/** pdf.js : la dépendance facultative, et Node 22.13 ou plus (sinon l'étape PDF échoue en le disant). */
const pdfReadable = pdfjsModule() !== null && (major > 22 || (major === 22 && minor >= 13));
const workspaces: string[] = [];

interface DemoReport {
  steps: {
    title: string;
    status?: string;
    skipped?: string;
    items?: { externalId?: string; kind: string; duplicate: string; parent?: string }[];
    issues?: string[];
    missingFromSource?: string[];
    published?: { created: number; updated: number; merged: number; links: number };
  }[];
  repository: { entities: number; links: number; versions: Record<string, number> };
}

async function demo(args: string[]): Promise<{ stdout: string; workspace: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'qa-req-demo-'));
  workspaces.push(workspace);
  const { stdout } = await run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './tests/fixtures/source-packages.ts',
      'examples/requirements-demo/demo.mjs',
      '--workspace',
      workspace,
      ...args,
    ],
    { cwd: process.cwd(), env: { ...process.env, CI: '1' }, timeout: 60_000 },
  );
  return { stdout, workspace };
}

afterAll(async () => {
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
});

describe('requirements demo', () => {
  it(
    'imports Word, Excel and PDF, publishes, and re-imports a new version',
    { timeout: 90_000 },
    async () => {
      const { stdout, workspace } = await demo(['--json']);
      const report = JSON.parse(stdout) as DemoReport;
      const [word, excel, pdf, again] = report.steps;
      const item = (step: DemoReport['steps'][number] | undefined, id: string) =>
        step?.items?.find((candidate) => candidate.externalId === id);

      expect(word?.published).toEqual({ created: 10, updated: 0, merged: 0, links: 5 });
      expect(item(word, 'CA-101')?.parent).toBe('RG-11');

      expect(item(excel, 'REQ-102')?.duplicate).toBe('SAME_ID_OTHER_SOURCE');
      expect(excel?.items?.some((candidate) => candidate.duplicate === 'SIMILAR')).toBe(true);
      expect(item(excel, 'CA-105')?.parent).toBe('REQ-105');
      expect(excel?.published).toEqual({ created: 4, updated: 0, merged: 1, links: 2 });

      if (pdfReadable) {
        expect(pdf?.items?.map((candidate) => candidate.externalId).filter(Boolean)).toEqual([
          'ENF-01',
          'ENF-02',
          'ENF-03',
        ]);
        expect(pdf?.published?.created).toBe(3);
      } else if (pdfjsModule()) expect(pdf?.status).toBe('FAILED');
      else expect(pdf?.skipped).toBe('pdfjs-dist not installed');

      expect(item(again, 'REQ-101')?.duplicate).toBe('UNCHANGED');
      expect(item(again, 'REQ-103')?.duplicate).toBe('SOURCE_CHANGED');
      expect(item(again, 'REQ-107')?.duplicate).toBe('NEW');
      expect(again?.missingFromSource).toHaveLength(1);
      expect(again?.published).toEqual({ created: 1, updated: 1, merged: 0, links: 0 });

      expect(report.repository.versions).toMatchObject({
        'REQ-101': 2,
        'REQ-103': 2,
        'CA-103': 1,
        'REQ-107': 1,
      });
      expect(report.repository.entities).toBe(pdfReadable ? 18 : 15);
      expect(report.repository.links).toBe(7);

      // Des fichiers JSON lisibles : le référentiel, un lot par importation, le profil.
      const repository = JSON.parse(
        await readFile(path.join(workspace, 'repository.json'), 'utf8'),
      ) as RequirementsRepository;
      expect(repository.entities).toHaveLength(report.repository.entities);
      expect(repository.links.every((link) => link.validation === 'PROPOSED')).toBe(true);
      expect(await readdir(path.join(workspace, 'imports'))).toHaveLength(pdfjsModule() ? 4 : 3);
      expect(await readdir(path.join(workspace, 'profiles'))).toEqual(['portail-excel.json']);
    },
  );

  it('prints a readable walkthrough', { timeout: 90_000 }, async () => {
    const { stdout: text } = await demo([]);
    expect(text).toContain('━━ 1. Spécification Word v1');
    expect(text).toContain('CONFLIT : identifiant déjà pris par une autre source');
    expect(text).toContain('doublon probable');
    expect(text).toContain('absents de la nouvelle version (signalés, jamais supprimés) : CA-103');
    expect(text).toContain('décisions (démonstration)');
  });
});
