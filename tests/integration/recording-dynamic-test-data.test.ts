import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDryRun } from '../../src/dry-run/dry-run-orchestrator.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * DONNÉES DE TEST DYNAMIQUES ET CORRÉLATION MÉTIER, dans un vrai navigateur. On enregistre une fois :
 * créer une société (« Company Test QA »), la rechercher, ouvrir le résultat. Puis on REJOUE le flow
 * généré plusieurs fois, contre une application qui refuse les doublons : chaque rejeu génère un
 * nouveau nom, le saisit à la création, recherche CE nom (un autre champ, un autre sélecteur) et
 * ouvre le résultat qui porte CE nom — CREATE → SEARCH → OPEN, une seule identité métier.
 */
interface Replay {
  status: string;
  steps: { index: number; label: string; outcome: string; reasons: string[] }[];
}

describe('Recording — dynamic test data and CREATE → SEARCH → OPEN correlation (real browser)', () => {
  let app: CompanyRecordingApp;
  let dir = '';
  let recorded = '';
  let missionFile = '';
  let replays = 0;

  const replay = async (options: { runId?: string; flowFile?: string } = {}): Promise<Replay> => {
    replays += 1;
    const work = path.join(dir, `replay-${String(replays)}`);
    const scenarioFile = path.join(dir, `replay-${String(replays)}.flow.yaml`);
    await copyFile(options.flowFile ?? path.join(recorded, 'generated.flow.yaml'), scenarioFile);
    await copyFile(path.join(recorded, 'test-data.yaml'), path.join(dir, 'test-data.yaml'));
    const mission = options.runId
      ? await writeMission(`fixed-${String(replays)}`, `testData: { runId: ${options.runId} }\n`)
      : missionFile;
    const outcome = await runDryRun({
      scenarioFile,
      missionFile: mission,
      overrides: { headless: true, reportsDir: work },
      env: {},
      useHistory: false,
      isolatedMemory: true,
      outputFormat: 'yaml',
    });
    const flow = outcome.flows[0];
    return {
      status: outcome.status,
      steps: (flow?.graph.intents ?? []).map((intent) => {
        const finding = flow?.outcome.findings.find((entry) => entry.intentId === intent.id);
        return {
          index: intent.index,
          label: intent.label,
          outcome: finding?.outcome ?? 'NOT_VERIFIED',
          reasons: finding?.reasons ?? [],
        };
      }),
    };
  };
  const writeMission = async (name: string, extra = ''): Promise<string> => {
    const file = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      file,
      `mission: { name: ${name} }\ntarget: { baseUrl: ${app.url}, startAt: / }\nsafety:\n  mutations: { enabled: true, maxPerRun: 20 }\n${extra}`,
    );
    return file;
  };
  const generated = (): string[] => app.names().filter((name) => name !== 'Company Test QA');

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-dynamic-data-'));
    missionFile = await writeMission('dynamic');
    const outcome = await runRecording({
      name: 'create-and-find-company',
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page }) => {
        const pause = (ms = 500): Promise<void> => page.waitForTimeout(ms);
        await page.getByRole('button', { name: 'New company' }).click();
        await pause();
        await page.getByLabel('Company name').fill('Company Test QA');
        await page.getByLabel('Address').fill('123 Main Street');
        await pause();
        await page.getByRole('button', { name: 'Save' }).click();
        await pause(900);
        await page.getByRole('button', { name: 'Tasks' }).click();
        await pause();
        await page.getByLabel('Search companies').fill('Company Test QA');
        await pause();
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await pause(900);
        await page.getByRole('button', { name: 'Company Test QA' }).click();
        await pause(900);
      },
    });
    recorded = outcome.directory;
  }, 180_000);

  beforeEach(() => {
    app.rejectDuplicates = true;
    app.refuseCreate = false;
    app.uppercaseNames = false;
  });

  afterAll(async () => {
    await app.close();
  });

  it('the recording separates the data: generated name, search referencing it, OPEN citing it — never the demo value', async () => {
    const data = parseYaml(await readFile(path.join(recorded, 'test-data.yaml'), 'utf8')) as {
      values: Record<string, Record<string, { strategy: string; generator?: string; reference?: string }>>;
    };
    expect(data.values.company?.companyName).toMatchObject({ strategy: 'generated', generator: 'company' });
    expect(data.values.search?.q).toMatchObject({ strategy: 'reference', reference: 'company.companyName' });
    const flow = parseYaml(await readFile(path.join(recorded, 'generated.flow.yaml'), 'utf8')) as {
      steps: Record<string, unknown>[];
    };
    const fills = flow.steps.filter((step) => 'fill' in step).map((step) => step.fill);
    expect(fills).toContainEqual({ label: 'Company name', value: { testData: 'company.companyName' } });
    expect(fills).toContainEqual({ label: 'Search companies', value: { testData: 'search.q' } });
    const open = flow.steps.at(-2) as { click?: { role?: string; name?: string } };
    expect(open.click).toEqual({ role: 'button', name: '${testData:company.companyName}' });
    // Les actions restent classées comme avant : clic, saisie (jamais UNKNOWN à cause d'une donnée).
    expect(flow.steps.filter((step) => 'click' in step)).toHaveLength(5);
    expect(JSON.stringify(flow.steps.filter((step) => 'click' in step || 'fill' in step))).not.toContain(
      'Company Test QA',
    );
  });

  it('replay: a NEW name is created, searched with exactly that value and the matching result is opened (A, C, D, J)', async () => {
    const before = generated().length;
    // La recherche de l'application compare le nom EXACT : un résultat ouvert prouve que la recherche a
    // utilisé exactement la valeur saisie à la création.
    const result = await replay();
    expect(result.status).toBe('FULLY_MATCHED');
    expect(result.steps.find((step) => step.label === '${testData:company.companyName}')?.outcome).toBe(
      'MATCHED',
    );
    const created = generated().slice(before);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/QA-CRAWLER-/);
    // La société enregistrée n'a pas été recréée : un doublon aurait été refusé (409).
    expect(app.names().filter((name) => name === 'Company Test QA')).toHaveLength(1);
  });

  it('two replays never share a runtime context: two different names, each consistent within its run (E)', async () => {
    const before = generated().length;
    const first = await replay();
    const second = await replay();
    expect([first.status, second.status]).toEqual(['FULLY_MATCHED', 'FULLY_MATCHED']);
    const created = generated().slice(before);
    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
  });

  it('two replays run at the same time do not interfere (H)', async () => {
    const before = generated().length;
    const results = await Promise.all([replay(), replay()]);
    expect(results.map((result) => result.status)).toEqual(['FULLY_MATCHED', 'FULLY_MATCHED']);
    const created = generated().slice(before);
    expect(new Set(created).size).toBe(2);
  });

  it('the application refuses the creation: never counted as created, the search/open never succeed (I)', async () => {
    app.refuseCreate = true;
    const before = app.names().length;
    const result = await replay();
    expect(result.status).not.toBe('FULLY_MATCHED');
    const created = result.steps.find((step) => step.label === '/api/companies');
    expect(created?.outcome).not.toBe('MATCHED');
    expect(result.steps.find((step) => step.label === '${testData:company.companyName}')?.outcome).not.toBe(
      'MATCHED',
    );
    expect(app.names()).toHaveLength(before);
  });

  it('the application normalizes the name (upper case): the correlated result is still found and opened', async () => {
    app.uppercaseNames = true;
    const result = await replay();
    expect(result.status).toBe('FULLY_MATCHED');
  });

  it('two results carry the generated name: the result is never picked arbitrarily', async () => {
    // Le nom généré se retrouve à partir du runId (Test Company QA-CRAWLER-<runId>) : un homonyme déjà là.
    const runId = `fixed${String(Date.now())}`;
    app.rejectDuplicates = false;
    app.seed([`Test Company QA-CRAWLER-${runId}`]);
    const result = await replay({ runId });
    expect(result.status).not.toBe('FULLY_MATCHED');
    const open = result.steps.find((step) => step.label === '${testData:company.companyName}');
    expect(open?.outcome).toBe('AMBIGUOUS');
    expect(open?.reasons.join(' ')).toMatch(
      /AMBIGUOUS_CORRELATION: 2 elements carry testData\.company\.companyName/,
    );
  });

  it('an unknown test data reference fails explicitly, never typed as an empty value (G)', async () => {
    const flow = (await readFile(path.join(recorded, 'generated.flow.yaml'), 'utf8')).replace(
      'name: ${testData:company.companyName}',
      'name: ${testData:company.unknownKey}',
    );
    const broken = path.join(dir, 'broken.flow.yaml');
    await writeFile(broken, flow);
    const result = await replay({ flowFile: broken });
    expect(result.status).not.toBe('FULLY_MATCHED');
    const open = result.steps.find((step) => step.label === '${testData:company.unknownKey}');
    expect(open?.outcome).not.toBe('MATCHED');
    expect(open?.reasons.join(' ')).toContain('company.unknownKey');
  });

  it('a historical static flow (no test data) replays exactly as before (F)', async () => {
    app.seed(['Static Company']);
    const flowFile = path.join(dir, 'static.flow.yaml');
    await writeFile(
      flowFile,
      [
        'name: static',
        'startAt: /',
        'steps:',
        '  - click: { role: button, name: Tasks }',
        '  - fill: { label: Search companies, value: Static Company }',
        '  - click: { role: button, name: Search, exact: true }',
        '    allow: MUTATION',
        '  - click: { role: button, name: Static Company }',
        '    allow: MUTATION',
        '  - expect: { url: /companies/ }',
        '',
      ].join('\n'),
    );
    const result = await replay({ flowFile });
    expect(result.status).toBe('FULLY_MATCHED');
  });
});
