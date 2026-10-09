import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessFlowModel } from '../../src/recording/business/model.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startItemRecordingApp, type ItemRecordingApp } from '../fixtures/item-recording-app.js';

/**
 * LA PROVENANCE DES ENTITÉS de bout en bout, sur une application que le Recorder ne connaît pas
 * (des « items ») : la même mécanique distingue CRÉER de RECHERCHER → OUVRIR, sans aucune règle
 * propre à l'application.
 */
type BusinessFile = BusinessFlowModel & { evidence: { type: string }[] };

describe('Entity provenance (generic « items » application)', () => {
  let app: ItemRecordingApp;
  let dir: string;
  const files: Record<string, BusinessFile> = {};

  const record = async (
    name: string,
    startAt: string,
    drive: (page: Page) => Promise<void>,
  ): Promise<BusinessFile> => {
    app.reset();
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: provenance-${name} }
target: { baseUrl: ${app.url}, startAt: ${startAt} }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
`,
    );
    const outcome = await runRecording({
      name: `provenance-${name}`,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'en',
      drive: async ({ page }) => {
        await drive(page);
      },
    });
    return JSON.parse(
      await readFile(path.join(outcome.directory, 'business-flow.json'), 'utf8'),
    ) as BusinessFile;
  };
  const pause = (page: Page, ms = 450): Promise<void> => page.waitForTimeout(ms);
  const search = async (page: Page, id: string): Promise<void> => {
    await page.getByRole('button', { name: 'Search items' }).click();
    await pause(page);
    await page.getByLabel('Number').fill(id);
    await pause(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await pause(page, 700);
    await page.getByRole('link', { name: `item ${id}` }).click();
    await pause(page, 900);
  };

  beforeAll(async () => {
    app = await startItemRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-provenance-'));
    // CAS A (+ modification) : un item EXISTANT recherché, ouvert, modifié, enregistré.
    files.searched = await record('searched', '/', async (page) => {
      await search(page, '123');
      await page.getByLabel('Description').fill('Updated by Alex');
      await pause(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await pause(page, 700);
    });
    // CAS B + C : créé, puis recherché et ouvert.
    files.created = await record('created', '/', async (page) => {
      await page.getByRole('button', { name: 'New item' }).click();
      await pause(page);
      await page.getByLabel('Name').fill('Martin');
      await pause(page);
      await page.getByRole('button', { name: 'Create' }).click();
      await pause(page, 900);
      await search(page, '456');
    });
    // CAS E : ouvert depuis la liste.
    files.listed = await record('listed', '/', async (page) => {
      await page.getByRole('button', { name: 'Items', exact: true }).click();
      await pause(page, 700);
      await page.getByRole('link', { name: 'item 123' }).click();
      await pause(page, 900);
    });
    // CAS D bis : l'enregistrement COMMENCE sur la page de l'item.
    files.started = await record('started', '/items/123', async (page) => {
      await page.getByLabel('Description').fill('Seen at start');
      await pause(page);
    });
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  const entity = (file: BusinessFile | undefined, key: string) =>
    file?.entities.find((entry) => entry.key === key);

  it('CAS A — an existing item, searched then opened: DISCOVERED_DURING_RECORDING, never created', () => {
    const item = entity(files.searched, 'entity:item:123');
    expect(item?.provenance?.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(item?.references).toEqual([]);
    expect(files.searched?.steps.some((step) => step.action === 'create')).toBe(false);
    expect(
      files.searched?.entities.some(
        (entry) => entry.provenance?.classification === 'CREATED_DURING_RECORDING',
      ),
    ).toBe(false);
  });

  it('search → open → update → save: one entity, its lifecycle and business steps, each linked to recorded steps', () => {
    const item = entity(files.searched, 'entity:item:123');
    expect(item?.lifecycle?.map((step) => step.kind)).toEqual(['SEARCH', 'OPEN', 'UPDATE', 'SAVE']);
    expect(files.searched?.steps.map((step) => step.action)).toEqual(['search', 'open', 'update', 'save']);
    expect(files.searched?.steps.every((step) => step.entityKey === 'entity:item:123')).toBe(true);
    expect(files.searched?.steps.every((step) => step.recordedActions.length > 0)).toBe(true);
  });

  it('CAS B + C — created (POST → 201 → new id), then searched and opened: the same identity all along', () => {
    const item = entity(files.created, 'entity:item:456');
    expect(item?.provenance).toMatchObject({
      classification: 'CREATED_DURING_RECORDING',
      rules: expect.arrayContaining(['R1 explicit creation']) as unknown,
    });
    expect(item?.lifecycle?.map((step) => step.kind)).toEqual(['CREATE', 'SEARCH', 'OPEN']);
    expect(files.created?.steps.map((step) => `${step.action} ${step.entityKey ?? ''}`)).toEqual([
      'create entity:item:456',
      'search entity:item:456',
      'open entity:item:456',
    ]);
    expect(item?.references).toEqual(['$created.item.id']);
  });

  it('CAS E — opened from a list: not a creation', () => {
    const item = entity(files.listed, 'entity:item:123');
    expect(item?.provenance?.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(item?.provenance?.rules).toContain('R5 opening from a list is not a creation');
  });

  it('CAS D bis — displayed on the starting screen: CONFIRMED_EXISTING (the only proof of prior existence)', () => {
    const item = entity(files.started, 'entity:item:123');
    expect(item?.provenance?.classification).toBe('CONFIRMED_EXISTING');
    expect(item?.provenance?.evidence).toContain('INITIAL_STATE');
  });

  it('every decision is explained: classification, confidence, reason, evidence and rules', () => {
    for (const file of Object.values(files))
      for (const entry of file.entities.filter((candidate) => candidate.provenance))
        expect(entry.provenance).toMatchObject({
          classification: expect.any(String) as unknown,
          confidence: expect.any(Number) as unknown,
          reason: expect.any(String) as unknown,
          evidence: expect.any(Array) as unknown,
          rules: expect.any(Array) as unknown,
        });
    // Les saisies ne sont jamais écrites (seules des empreintes).
    expect(JSON.stringify(files.searched)).not.toContain('Updated by Alex');
  });
});
