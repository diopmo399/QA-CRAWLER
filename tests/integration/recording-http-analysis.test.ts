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
  /** Le texte de l'onglet Analyse de la fenêtre (revue). */
  panel?: string;
  /** Ce que la fenêtre montre (pistes A–E de la refonte). */
  ui?: Record<string, string | boolean | number>;
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
    let panelText: string | undefined;
    const ui: Record<string, string | boolean | number> = {};
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: http-${name} }
target: { baseUrl: ${app.url}, startAt: / }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
recording: { knowledge: ${String(knowledge)}${knowledge ? '' : ', panelLayout: compact'} }
`,
    );
    const outcome = await runRecording({
      name: `http-${name}`,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, name, 'reports') },
      env: {},
      language: 'fr',
      drive: async ({ page, panel }) => {
        await drive(page);
        // A · la recherche reconnue en direct ; E · la disposition demandée (mini-dock sombre).
        if (panel) {
          await panel
            .locator('#livesearch:not([hidden])')
            .waitFor({ timeout: 10_000 })
            .catch(() => undefined);
          ui.liveSearch = await panel
            .locator('#livesearch')
            .innerText()
            .catch(() => '');
          ui.compact = await panel.evaluate(() => document.body.classList.contains('compact'));
        }
      },
      reviewDriver: async ({ panel }) => {
        await panel.getByText('Enregistrement terminé ✓').waitFor({ timeout: 60_000 });
        await panel.getByRole('tab', { name: 'Analyse' }).click();
        await panel.getByText('Intents métier').waitFor({ timeout: 60_000 });
        panelText = await panel.locator('#panel-analysis').innerText();
        // B · les étapes métier en cartes ; C · la requête reliée à l'action ; recherche et « À vérifier seulement ».
        await panel.getByRole('tab', { name: 'Enregistrement', exact: true }).click({ timeout: 10_000 });
        ui.story = await panel.locator('#story').innerText();
        ui.timeline = await panel.locator('#timeline').innerText();
        await panel
          .locator('#timeline .item', { hasText: 'Search companies' })
          .first()
          .click({ timeout: 10_000 });
        ui.linked = await panel.locator('#details').innerText();
        await panel.getByLabel('Chercher une action').fill('Search companies');
        ui.filtered = await panel.locator('#timeline > li:not(.group)').count();
        await panel.getByLabel('Chercher une action').fill('');
        ui.groups = await panel.locator('#timeline > li.group').count();
        await panel.getByRole('button', { name: 'À vérifier seulement' }).click();
        ui.attentionOnly = await panel.locator('#timeline').innerText();
      },
    });
    const read = (file: string): Promise<string> => readFile(path.join(outcome.directory, file), 'utf8');
    const [journal, analysis] = await Promise.all([read('network-journal.json'), read('http-analysis.json')]);
    return {
      directory: outcome.directory,
      journal: (JSON.parse(journal) as { requests: NetworkObservation[] }).requests,
      analysis: JSON.parse(analysis) as Session['analysis'],
      rawJournal: journal,
      ...(panelText !== undefined ? { panel: panelText } : {}),
      ui,
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

  it('the search criterion: field label → API property, operator, AND, dynamic value; sort and technical parameters apart', () => {
    const [first] = searches(sessions.remembered);
    expect(first?.searchCriteria).toEqual([
      expect.objectContaining({
        propertyName: 'companyName',
        operator: 'CONTAINS',
        logicalGroup: expect.objectContaining({ operator: 'AND' }) as unknown,
        sourceJsonPath: 'condition.conditions[0].val',
        ui: expect.objectContaining({ label: 'Search companies', match: 'EXACT' }) as unknown,
        state: 'VALIDATED',
      }),
    ]);
    const roles = Object.fromEntries(
      (first?.parameters ?? []).map((parameter) => [parameter.path, parameter.role]),
    );
    expect(roles).toMatchObject({
      '?batch': 'PAGINATION',
      '?batchSize': 'PAGINATION',
      '?includeAssigned': 'OPTION',
      'ordering.prop': 'SORT',
    });
    expect(first?.interpretation).toMatch(
      /^search where companyName CONTAINS the value typed in "Search companies"/,
    );
    expect(first?.interpretation).toMatch(/sorted by companyName ASC$/);
  });

  it('the window shows the search as a business intent (criteria, logic, sort, technical parameters)', () => {
    const panel = sessions.remembered?.panel ?? '';
    expect(panel).toContain('Critères détectés');
    // D · la recherche en tableau : champ de l'écran, propriété API, opérateur.
    expect(panel).toContain('Champ de l’écran');
    expect(panel).toMatch(/Search companies\s+companyName\s+CONTAINS/);
    expect(panel).toContain('Logique : AND');
    expect(panel).toContain('Tri : companyName ASC');
    expect(panel).toMatch(/Paramètres techniques : .*pagination/);
    expect(panel).not.toContain('Aucun intent métier');
  });

  it('the redesigned window: live search chip, compact dock on demand, business-step cards, linked request, search and filter', () => {
    const full = sessions.remembered?.ui ?? {};
    const compact = sessions.forgotten?.ui ?? {};
    expect(String(full.liveSearch)).toMatch(
      /recherche détectée : SEARCH POST \/api\/companies\/query · "Search companies" → companyName CONTAINS/,
    );
    expect(full.compact).toBe(false);
    expect(compact.compact).toBe(true);
    expect(String(full.story)).toContain('Le parcours en étapes métier');
    expect(String(full.linked)).toMatch(
      /Requête liée[\s\S]*POST \/api\/companies\/query[\s\S]*"Search companies" → companyName CONTAINS · AND/,
    );
    expect(full.filtered).toBeGreaterThanOrEqual(1);
    expect(full.groups).toBeGreaterThanOrEqual(1);
    expect(String(full.attentionOnly)).not.toMatch(/Cliquer sur "Save"/);
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
