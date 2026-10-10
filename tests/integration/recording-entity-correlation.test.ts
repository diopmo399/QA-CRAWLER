import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplicationInteractionModel } from '../../src/recording/application/model.js';
import type { BusinessEvent, BusinessFlowModel } from '../../src/recording/business/model.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { startCompanyRecordingApp, type CompanyRecordingApp } from '../fixtures/company-recording-app.js';

/**
 * CRÉATION PUIS RECHERCHE, dans un vrai navigateur : on crée une société (l'identifiant n'est
 * jamais montré ni renvoyé), on revient à la liste, on la retrouve par une recherche POST avec un
 * JSON de critères, on ouvre le résultat. Le Recorder doit y voir UN parcours fonctionnel :
 * CREATE → RETRIEVE → CORRELATE → OPEN, sur la même entité, dont l'identité est découverte après coup.
 */
interface Session {
  model: ApplicationInteractionModel;
  flow: BusinessFlowModel & { events: BusinessEvent[] };
  raw: string;
}

describe('Create → search by business data (POST + JSON filters) → result → open', () => {
  let app: CompanyRecordingApp;
  let dir: string;
  const sessions: Record<string, Session> = {};

  const record = async (name: string, drive: (page: Page) => Promise<void>): Promise<Session> => {
    app.reset();
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: company-${name} }
target: { baseUrl: ${app.url}, startAt: / }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
`,
    );
    const outcome = await runRecording({
      name: `company-${name}`,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'en',
      drive: async ({ page }) => {
        await drive(page);
      },
    });
    const read = (file: string): Promise<string> => readFile(path.join(outcome.directory, file), 'utf8');
    const [model, flow] = await Promise.all([read('application-model.json'), read('business-flow.json')]);
    return {
      model: JSON.parse(model) as ApplicationInteractionModel,
      flow: JSON.parse(flow) as Session['flow'],
      raw: `${model}\n${flow}`,
    };
  };
  const pause = (page: Page, ms = 500): Promise<void> => page.waitForTimeout(ms);
  const create = async (page: Page): Promise<void> => {
    await page.getByRole('button', { name: 'New company' }).click();
    await pause(page);
    await page.getByLabel('Company name').fill('Company Test QA');
    await page.getByLabel('Address').fill('123 Main Street');
    await pause(page);
    await page.getByRole('button', { name: 'Save' }).click();
    await pause(page, 900);
  };
  const searchAndOpen = async (page: Page): Promise<void> => {
    await page.getByRole('button', { name: 'Tasks' }).click();
    await pause(page);
    await page.getByLabel('Search companies').fill('Company Test QA');
    await pause(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await pause(page, 800);
  };

  beforeAll(async () => {
    app = await startCompanyRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-company-'));
    sessions.created = await record('created', async (page) => {
      await create(page);
      await searchAndOpen(page);
      await page.getByRole('button', { name: 'Company Test QA' }).click();
      await pause(page, 900);
    });
    // Une société existante, sans création dans l'enregistrement : DISCOVERED.
    sessions.existing = await record('existing', async (page) => {
      await page.evaluate(async () => {
        await fetch('/api/companies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ companyName: 'Company Test QA', address: '1 First Street' }),
        });
      });
      await searchAndOpen(page);
      await page.getByRole('button', { name: 'Company Test QA' }).click();
      await pause(page, 900);
    });
    // Un homonyme existait déjà : la recherche rend deux sociétés du même nom → AMBIGUOUS.
    app.seedHomonym = true;
    sessions.homonym = await record('homonym', async (page) => {
      await create(page);
      await searchAndOpen(page);
      await page.getByRole('button', { name: 'Company Test QA' }).first().click();
      await pause(page, 900);
    });
    app.seedHomonym = false;
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  const entityEvents = (session: Session | undefined, key: string): string[] =>
    (session?.flow.events ?? []).filter((event) => event.entityKey === key).map((event) => event.type);

  it('the search POST with JSON filters is a SEARCH (query evidence), never a creation', () => {
    const correlation = sessions.created?.model.correlations[0];
    expect(correlation?.query).toMatchObject({ method: 'POST', api: 'POST /api/companies/search' });
    expect(correlation?.query.queryEvidence.join(' ')).toMatch(/collection.*criteria container.*pagination/);
    expect(
      (sessions.created?.flow.events ?? [])
        .filter((event) => /CREATE/.test(event.type))
        .map((event) => event.actionIds),
    ).toHaveLength(1);
  });

  it('CREATE → RETRIEVE → CORRELATE → OPEN on one entity; its id, never shown, is discovered in the search result', () => {
    const session = sessions.created;
    const correlation = session?.model.correlations[0];
    expect(correlation).toMatchObject({
      sameEntityCandidate: true,
      result: { identifiers: [{ field: 'id', value: '123456' }], sameIdAsCreation: false },
    });
    expect(['CONFIRMED', 'PROBABLE']).toContain(correlation?.status);
    // Nom + adresse envoyés à la création et lus dans le résultat ; le nom aussi dans les critères.
    expect(correlation?.matched.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['Company name', 'Address']),
    );
    expect(correlation?.matched.find((entry) => entry.label === 'Company name')?.seenIn).toEqual(
      expect.arrayContaining(['CREATE_INPUT', 'SEARCH_CRITERION', 'RESULT_RECORD']),
    );
    expect(entityEvents(session, 'entity:company:123456')).toEqual([
      'ENTITY_CREATED',
      'ENTITY_RETRIEVED',
      'ENTITY_CORRELATED',
      'ENTITY_OPENED',
    ]);
    const entity = session?.model.entities.find((candidate) => candidate.key === 'entity:company:123456');
    expect(entity?.provenance.classification).toBe('CREATED_DURING_RECORDING');
    expect(entity?.classification.classification).toBe('BUSINESS_ENTITY');
    expect(session?.model.businessContext.entityKeys).toEqual(['entity:company:123456']);
    expect(session?.model.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SEARCH_MATCH', source: 'entity:company:123456' }),
      ]),
    );
    // Les SAISIES ne sont jamais écrites : l'adresse nulle part ; le nom seulement comme libellé du
    // bouton cliqué (le texte que l'application affiche, qui sert de localisateur), jamais ailleurs.
    expect(session?.raw).not.toContain('123 Main Street');
    expect(JSON.stringify(session?.flow)).not.toContain('Company Test QA');
    expect(JSON.stringify({ ...session?.model, actions: [] })).not.toContain('Company Test QA');
  });

  it('no creation in the recording: search → result → open is DISCOVERED_DURING_RECORDING', () => {
    const session = sessions.existing;
    expect(session?.model.correlations).toEqual([]);
    const entity = session?.model.entities.find((candidate) => candidate.key === 'entity:company:123456');
    expect(entity?.provenance.classification).toBe('DISCOVERED_DURING_RECORDING');
    expect(entityEvents(session, 'entity:company:123456')).not.toContain('ENTITY_CREATED');
  });

  it('a homonym existed already (same name, other address): the address disambiguates — the created one is chosen', () => {
    const session = sessions.homonym;
    const correlation = session?.model.correlations[0];
    expect(correlation).toMatchObject({
      sameEntityCandidate: true,
      result: { identifiers: [{ field: 'id', value: '123456' }] },
    });
    expect(correlation?.evidence.join(' ')).toMatch(/2 results carry creation data.*homonym/);
    expect(correlation?.matched.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['Company name', 'Address']),
    );
  });
});
