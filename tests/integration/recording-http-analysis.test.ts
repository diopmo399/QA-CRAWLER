import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetworkObservation } from '../../src/functional/model.js';
import type { RecordingAnalysis } from '../../src/recording/analysis/recording-analysis.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * L'ANALYSE MÉTIER DES REQUÊTES HTTP, dans un vrai navigateur : une application dont la recherche
 * envoie un ARBRE de conditions (noms de champs et format différents de tout exemple), la pagination
 * dans l'URL, et qui interroge un compteur en arrière-plan. Le Recorder doit tenir un journal réseau
 * chronologique, relier chaque requête à son geste (ou la dire indépendante), reconnaître la
 * recherche, ses critères, son tri et sa pagination, et apprendre le lien libellé ↔ propriété.
 */
interface Session {
  directory: string;
  journal: NetworkObservation[];
  analysis: {
    journal: string;
    consolidated: RecordingAnalysis;
    live?: { mode: string; summary: RecordingAnalysis['summary'] };
  };
  rawJournal: string;
}

describe('Recording — business analysis of HTTP requests (live + consolidated)', () => {
  let app: CompanyRecordingApp;
  let dir: string;
  const sessions: Record<string, Session> = {};

  const record = async (
    name: string,
    knowledge: boolean,
    drive: (page: Page) => Promise<void>,
  ): Promise<Session> => {
    app.reset();
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: http-${name} }
target: { baseUrl: ${app.url}, startAt: / }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
recording: { knowledge: ${String(knowledge)} }
`,
    );
    const outcome = await runRecording({
      name: `http-${name}`,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, name, 'reports') },
      env: {},
      language: 'en',
      drive: async ({ page }) => {
        await drive(page);
      },
    });
    const read = (file: string): Promise<string> => readFile(path.join(outcome.directory, file), 'utf8');
    const [journal, analysis] = await Promise.all([read('network-journal.json'), read('http-analysis.json')]);
    return {
      directory: outcome.directory,
      journal: (JSON.parse(journal) as { requests: NetworkObservation[] }).requests,
      analysis: JSON.parse(analysis) as Session['analysis'],
      rawJournal: journal,
    };
  };
  const pause = (page: Page, ms = 500): Promise<void> => page.waitForTimeout(ms);
  const search = async (page: Page): Promise<void> => {
    await page.getByLabel('Search companies').fill('Company Test QA');
    await pause(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await pause(page, 800);
  };
  const journey = async (page: Page): Promise<void> => {
    await page.getByRole('button', { name: 'New company' }).click();
    await pause(page);
    await page.getByLabel('Company name').fill('Company Test QA');
    await page.getByLabel('Address').fill('123 Main Street');
    await pause(page);
    await page.getByRole('button', { name: 'Save' }).click();
    await pause(page, 900);
    await page.getByRole('button', { name: 'Tasks' }).click();
    await pause(page);
    await search(page);
    // La même recherche, une seconde fois : la correspondance libellé ↔ propriété se confirme.
    await page.getByLabel('Search companies').fill('');
    await search(page);
    await page.getByRole('button', { name: 'Company Test QA' }).click();
    await pause(page, 1500);
  };

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    app.tree = true;
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-http-'));
    sessions.remembered = await record('remembered', true, journey);
    sessions.forgotten = await record('forgotten', false, journey);
    app.tree = false;
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  const searches = (session: Session | undefined): RecordingAnalysis['business'] =>
    (session?.analysis.consolidated.business ?? []).filter(
      (entry) => entry.api === 'POST /api/companies/query',
    );

  it('the network journal is chronological, numbered and structured — never a typed value', () => {
    const journal = sessions.remembered?.journal ?? [];
    expect(journal.length).toBeGreaterThan(3);
    expect(journal.map((entry) => entry.id)).toEqual(journal.map((_, index) => `n${index + 1}`));
    const starts = journal.map((entry) => entry.startedAt);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    const query = journal.find((entry) => entry.path === '/api/companies/query');
    expect(query).toMatchObject({ method: 'POST', status: 200 });
    expect(query?.durationMs).toBeGreaterThanOrEqual(0);
    expect(query?.request?.criteria.length).toBeGreaterThan(0);
    // Ni la saisie (nom, adresse), ni en clair, ni sous une autre casse.
    expect(sessions.remembered?.rawJournal).not.toContain('Company Test QA');
    expect(sessions.remembered?.rawJournal.toLowerCase()).not.toContain('123 main street');
  });

  it('the tree search is a SEARCH: AND group, criterion CONTAINS, sort and URL pagination', () => {
    const [first] = searches(sessions.remembered);
    expect(first?.operation).toBe('SEARCH');
    expect(first?.groups[0]?.operator).toBe('AND');
    expect(first?.criteria).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'companyName', operator: 'CONTAINS' })]),
    );
    expect(first?.sort).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'companyName', direction: 'ASC' })]),
    );
    expect(first?.pagination).toMatchObject({ index: { value: 0 }, size: { value: 25 } });
    expect(first?.options.some((option) => option.includes('includeAssigned'))).toBe(true);
  });

  it('each search request is tied to its Search click; the background counter is independent', () => {
    const consolidated = sessions.remembered?.analysis.consolidated;
    const ids = new Set(searches(sessions.remembered).map((entry) => entry.networkId));
    expect(ids.size).toBe(2);
    const triggered = (consolidated?.correlations ?? []).filter((correlation) =>
      correlation.networkIds.some((id) => ids.has(id)),
    );
    expect(triggered).toHaveLength(2);
    for (const correlation of triggered) expect(correlation.kind).toBe('TRIGGERED');
    const counter = (sessions.remembered?.journal ?? [])
      .filter((entry) => entry.path === '/api/notifications/count')
      .map((entry) => entry.id);
    expect(counter.length).toBeGreaterThanOrEqual(3);
    const independent = (consolidated?.independent ?? []).map((entry) => entry.networkId);
    for (const id of counter) expect(independent).toContain(id);
  });

  it('the label ↔ property mapping is learned, VALIDATED after two consistent searches', () => {
    const mapping = sessions.remembered?.analysis.consolidated.fieldMappings.find(
      (entry) => entry.uiLabel === 'Search companies',
    );
    expect(mapping).toMatchObject({ property: 'companyName', state: 'VALIDATED', operation: 'SEARCH' });
    expect(mapping?.occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('create then search by the same data: SEARCH_AFTER_CREATE, and live converges with consolidated', () => {
    const [first] = searches(sessions.remembered);
    expect(first?.relations.map((relation) => relation.type)).toContain('SEARCH_AFTER_CREATE');
    const analysis = sessions.remembered?.analysis;
    expect(analysis?.journal).toBe('network-journal.json');
    expect(analysis?.consolidated.mode).toBe('CONSOLIDATED');
    expect(analysis?.consolidated.status).not.toBe('FAILED');
    expect(analysis?.live?.mode).toBe('LIVE');
    expect(analysis?.live?.summary.operations.SEARCH).toBe(analysis?.consolidated.summary.operations.SEARCH);
  });

  it('validated mappings go to the application knowledge only when recording.knowledge is on', async () => {
    const knowledgeOf = async (name: string): Promise<string> => {
      const folder = path.join(dir, name, 'knowledge', 'functional');
      const files = await readdir(folder).catch(() => [] as string[]);
      const contents = await Promise.all(files.map((file) => readFile(path.join(folder, file), 'utf8')));
      return contents.join('\n');
    };
    const remembered = await knowledgeOf('remembered');
    expect(remembered).toContain('"fieldMappings"');
    expect(remembered).toContain('Search companies');
    expect(remembered).not.toContain('Company Test QA');
    expect(await knowledgeOf('forgotten')).not.toContain('Search companies');
  });
});
