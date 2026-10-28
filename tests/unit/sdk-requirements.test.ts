import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import type { RequirementsRepository, TraceabilityLink } from '../../src/requirements/model.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import {
  computeTrends,
  coverageAt,
  isoWeek,
  matrixCsv,
  matrixOf,
} from '../../src/sdk/server/requirements.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { buildDocx, buildXlsx, wp } from '../fixtures/office-builder.js';

/**
 * LES EXIGENCES PAR LE SDK, contre le vrai serveur et de vrais fichiers (.docx, .xlsx écrits par le
 * test, contenu fictif) : import, candidats, décisions humaines, publication, matrice (et son CSV
 * protégé), liens confirmés ou rejetés, indicateurs, tendances ; les refus (projet archivé, fichier trop
 * grand, profil d'un autre connecteur, variable que le serveur ne lit pas, secret absent).
 */
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;

const SPEC = buildDocx(
  [
    wp('Gestion des demandes', { style: 'Heading1' }),
    wp('Exigences', { style: 'Heading2' }),
    wp('REQ-501 Le système doit enregistrer une demande avec son titre.'),
    wp('Critères d’acceptation', { style: 'Heading2' }),
    wp('CA-51 Étant donné un titre vide, quand on enregistre, alors la demande est refusée.'),
  ].join(''),
  { title: 'Spécification fictive', modified: '2026-10-20T08:30:00Z' },
);

const SHEET = buildXlsx(
  [
    {
      name: 'Exigences',
      rows: [
        ['ID', 'Titre', 'Priorité'],
        ['REQ-601', '=SOMME(A1:A2) Rechercher une demande', 'Haute'],
      ],
    },
  ],
  { title: 'Liste fictive' },
);

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-requirements-'));
  server = await startSdkServer({ workspace, language: 'fr', env: { QA_WIKI_TOKEN: 'not-a-real-token' } });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
});

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

const refusal = async (call: Promise<unknown>): Promise<string> => {
  const error = await call.catch((caught: unknown) => caught);
  return error instanceof QaCrawlerError ? `${String(error.status)} ${error.code}` : 'accepted';
};

describe('requirements through the SDK', () => {
  let batchId = '';

  it('lists the connectors with their formats and limits', async () => {
    const connectors = await client.requirements.connectors(project.id);
    expect(connectors.map((connector) => [connector.kind, connector.transport])).toEqual([
      ['CONFLUENCE', 'CONFLUENCE'],
      ['WORD', 'FILE'],
      ['EXCEL', 'FILE'],
      ['PDF', 'FILE'],
    ]);
    expect(connectors.find((connector) => connector.kind === 'WORD')?.maxBytes).toBe(25 * 1024 * 1024);
  });

  it('imports a Word file into candidates; nothing is published before a decision', async () => {
    const batch = await client.requirements.importFile(project.id, {
      connector: 'WORD',
      name: 'spec.docx',
      data: new Uint8Array(SPEC),
    });
    batchId = batch.id;
    expect(batch.status).toBe('VALIDATION_REQUIRED');
    expect(batch.items.filter((item) => item.externalId).map((item) => [item.externalId, item.kind])).toEqual(
      [
        ['REQ-501', 'REQUIREMENT'],
        ['CA-51', 'ACCEPTANCE_CRITERION'],
      ],
    );
    expect((await client.requirements.get(project.id)).entities).toEqual([]);
    const [summary] = await client.requirements.imports(project.id);
    expect(summary).toMatchObject({
      id: batch.id,
      connector: 'WORD',
      candidates: 2,
      toDecide: 2,
      published: 0,
    });
    expect((await client.requirements.get(project.id)).pending).toBe(2);
  });

  it('records the decisions, refuses an unknown candidate, then publishes', async () => {
    const batch = await client.requirements.importBatch(project.id, batchId);
    const requirement = batch.items.find((item) => item.externalId === 'REQ-501');
    const criterion = batch.items.find((item) => item.externalId === 'CA-51');
    expect(
      await refusal(
        client.requirements.decide(project.id, batchId, [
          { itemId: 'itm_9999', decision: { action: 'ACCEPT' } },
        ]),
      ),
    ).toBe('404 NOT_FOUND');
    const decided = await client.requirements.decide(project.id, batchId, [
      { itemId: requirement?.id ?? '', decision: { action: 'ACCEPT' } },
      { itemId: criterion?.id ?? '', decision: { action: 'ACCEPT', parent: 'REQ-501' } },
    ]);
    // L'auteur n'est pas enregistré : l'identité des personnes n'est pas encore définie.
    expect(decided.items.every((item) => !item.decision || item.decision.by === undefined)).toBe(true);
    const published = await client.requirements.publish(project.id, batchId);
    expect(published.created).toHaveLength(2);
    expect(published.links).toHaveLength(1);
    const repository = await client.requirements.get(project.id);
    expect(repository.entities.map((entity) => entity.externalId)).toEqual(['REQ-501', 'CA-51']);
    expect(repository.links[0]).toMatchObject({ type: 'HAS_CRITERION', validation: 'CONFIRMED' });
    expect(repository.pending).toBe(0);
  });

  it('the matrix, a manual test link, its rejection, and the indicators with their counts', async () => {
    const repository = await client.requirements.get(project.id);
    const requirement = repository.entities.find((entity) => entity.externalId === 'REQ-501');
    let rows = await client.requirements.matrix(project.id);
    expect(rows.find((row) => row.id === requirement?.id)?.children).toHaveLength(1);
    // La cible se lit par son identifiant de la source, pas par l'identifiant interne.
    expect(rows.find((row) => row.id === requirement?.id)?.children[0]?.label).toBe('CA-51');
    expect(
      await refusal(
        client.requirements.addLink(project.id, {
          type: 'TESTED_BY',
          from: { kind: 'REQUIREMENT', id: requirement?.id ?? '' },
          to: { kind: 'TEST', id: 'create-request' },
          justification: [],
        }),
      ),
    ).toBe('422 INVALID_DECISION');
    const link = await client.requirements.addLink(project.id, {
      type: 'TESTED_BY',
      from: { kind: 'REQUIREMENT', id: requirement?.id ?? '' },
      to: { kind: 'TEST', id: 'create-request' },
      justification: ['the scenario create-request saves a request with its title'],
    });
    expect(link.validation).toBe('CONFIRMED');
    rows = await client.requirements.matrix(project.id);
    expect(rows.find((row) => row.id === requirement?.id)?.verifiedBy[0]?.target).toEqual({
      kind: 'TEST',
      id: 'create-request',
    });
    let indicators = await client.requirements.indicators(project.id, { days: 7 });
    expect(indicators.published).toEqual({ total: 2, requirements: 1, rules: 0, criteria: 1 });
    expect(indicators.coverage).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(indicators.links).toMatchObject({ confirmed: 2, proposed: 0, rejected: 0 });
    expect(indicators.recentEvidence).toEqual({ available: false, reason: 'CORRELATION_NOT_AVAILABLE' });
    expect(indicators.replays).toMatchObject({ numerator: 0, denominator: 0 });
    expect(indicators.replays.value).toBeUndefined();
    expect(indicators.gaps).toMatchObject({ withoutImplementation: 2, withoutTest: 1, pendingCandidates: 0 });

    const rejected = await client.requirements.decideLink(project.id, link.id, 'REJECT', {
      note: 'wrong scenario',
    });
    expect(rejected.decisions.map((decision) => decision.action)).toEqual(['ADD', 'REJECT']);
    indicators = await client.requirements.indicators(project.id);
    expect(indicators.coverage).toMatchObject({ numerator: 0, denominator: 2 });
    expect(indicators.links).toMatchObject({ confirmed: 1, rejected: 1 });
  });

  it('exports the matrix as CSV, a cell starting with "=" never read as a formula', async () => {
    const batch = await client.requirements.importFile(project.id, {
      connector: 'EXCEL',
      name: 'liste.xlsx',
      data: new Uint8Array(SHEET),
    });
    const item = batch.items.find((candidate) => candidate.externalId === 'REQ-601');
    await client.requirements.decide(project.id, batch.id, [
      {
        itemId: item?.id ?? '',
        decision: { action: 'ACCEPT', title: '=SOMME(A1:A2) Rechercher une demande' },
      },
    ]);
    await client.requirements.publish(project.id, batch.id);
    const csv = await client.requirements.matrixCsv(project.id);
    expect(csv.split('\r\n')[0]).toBe(
      '"id","external_id","kind","title","version","sources","children","implemented_by","verified_by","other"',
    );
    expect(csv).toContain(`"'=SOMME(A1:A2) Rechercher une demande"`);
    expect(csv).not.toContain(`,"=SOMME`);
    expect(csv).toMatch(/"ACCEPTANCE_CRITERION:CA-51 \[acc_[A-Za-z0-9]+\] \(CONFIRMED\)"/);
  });

  it('refuses: too large, a profile of another connector, an unread variable; a missing secret fails the import', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    expect(
      await refusal(
        client.requirements.importFile(project.id, { connector: 'PDF', name: 'big.pdf', data: big }),
      ),
    ).toBe('413 TOO_LARGE');
    const profiles = path.join(workspace, project.id, 'requirements', 'profiles');
    await mkdir(profiles, { recursive: true });
    await writeFile(
      path.join(profiles, 'tableur.json'),
      JSON.stringify({
        name: 'tableur',
        connector: 'EXCEL',
        classify: {},
        options: {},
        createdAt: '',
        updatedAt: '',
      }),
    );
    expect((await client.requirements.profiles(project.id)).map((profile) => profile.name)).toEqual([
      'tableur',
    ]);
    expect(
      await refusal(
        client.requirements.importFile(project.id, {
          connector: 'WORD',
          name: 'spec.docx',
          data: new Uint8Array(SPEC),
          profile: 'tableur',
        }),
      ),
    ).toBe('400 PROFILE_MISMATCH');
    expect(
      await refusal(
        client.requirements.importConfluence(project.id, {
          baseUrl: 'https://wiki.example.org',
          page: '123',
          auth: { tokenEnv: 'HOME' },
        }),
      ),
    ).toBe('400 ENV_NAME_REFUSED');
    const failed = await client.requirements.importConfluence(project.id, {
      baseUrl: 'https://wiki.example.org',
      page: '123',
      variant: 'datacenter',
      auth: { tokenEnv: 'QA_ABSENT_TOKEN' },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.issues.map((issue) => issue.code)).toEqual(['AUTHENTICATION']);
    expect(JSON.stringify(failed)).not.toContain('not-a-real-token');
  });

  it('an archived project refuses every write, and still reads', async () => {
    await client.projects.archive(project.id);
    expect(
      await refusal(
        client.requirements.importFile(project.id, {
          connector: 'WORD',
          name: 'spec.docx',
          data: new Uint8Array(SPEC),
        }),
      ),
    ).toBe('409 PROJECT_ARCHIVED');
    expect(await refusal(client.requirements.publish(project.id, batchId))).toBe('409 PROJECT_ARCHIVED');
    expect((await client.requirements.get(project.id)).entities).toHaveLength(3);
    await client.projects.restore(project.id);
  });

  it('trends through the API: one entry per ISO week, the coverage only from the first publication', async () => {
    const trends = await client.trends.get({ weeks: 3, projectId: project.id });
    expect(trends.weeks).toHaveLength(3);
    expect(trends.weeks[2]?.coverage).toMatchObject({ numerator: 0, denominator: 3 });
    expect(trends.weeks[2]?.replays).toEqual({ numerator: 0, denominator: 0 });
  });
});

describe('requirements — pure computations', () => {
  const at = (iso: string): number => Date.parse(iso);
  const link = (decisions: TraceabilityLink['decisions']): TraceabilityLink => ({
    id: 'lnk_000001',
    type: 'TESTED_BY',
    from: { kind: 'REQUIREMENT', id: 'req_1' },
    to: { kind: 'TEST', id: 'create-request' },
    origin: 'MANUAL',
    justification: ['x'],
    confidence: 'HIGH',
    validation: 'CONFIRMED',
    freshness: 'CURRENT',
    decisions,
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
  });
  const entity = (id: string, createdAt: string) =>
    ({
      id,
      kind: 'REQUIREMENT',
      title: id,
      description: '',
      sources: [],
      version: 1,
      history: [],
      createdAt,
      updatedAt: createdAt,
      validation: 'VALIDATED',
      type: 'FUNCTIONAL',
      dependsOn: [],
    }) as RequirementsRepository['entities'][number];

  it('ISO weeks (a year that starts on a Thursday, the turn of a year)', () => {
    expect(isoWeek(new Date('2026-10-27T10:00:00Z'))).toBe('2026-W44');
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });

  it('the coverage at a date replays the decisions of each test link; nothing before the first publication', () => {
    const repository = {
      entities: [entity('req_1', '2026-10-01T00:00:00Z'), entity('req_2', '2026-10-10T00:00:00Z')],
      links: [
        link([
          { action: 'ADD', at: '2026-10-05T00:00:00Z' },
          { action: 'REJECT', at: '2026-10-20T00:00:00Z' },
        ]),
      ],
    };
    expect(coverageAt(repository, at('2026-09-30T00:00:00Z'))).toBeUndefined();
    expect(coverageAt(repository, at('2026-10-06T00:00:00Z'))).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(coverageAt(repository, at('2026-10-12T00:00:00Z'))).toEqual({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(coverageAt(repository, at('2026-10-21T00:00:00Z'))).toEqual({
      numerator: 0,
      denominator: 2,
      value: 0,
    });
    expect(matrixOf(repository)[0]?.verifiedBy[0]?.target.id).toBe('create-request');
    expect(matrixCsv(matrixOf(repository)).split('\r\n')).toHaveLength(4);
  });

  it('trends from the runs on disk: pass rate, median duration, issues, unstable scenarios per week', async () => {
    const reports = await mkdtemp(path.join(tmpdir(), 'trends-'));
    const replay = async (
      run: string,
      startedAt: string,
      status: string,
      durationMs: number,
      critical = 0,
    ) => {
      const directory = path.join(reports, run);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'sdk-execution.json'),
        JSON.stringify({ kind: 'REPLAY', startedAt }),
      );
      await writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify({
          startedAt,
          durationMs,
          stopReason: 'flows-only',
          flows: [{ name: 'search', status, durationMs, steps: [] }],
          issues: [],
          stats: { issuesBySeverity: { CRITICAL: critical } },
          artifacts: {},
        }),
      );
    };
    await replay('run-a', '2026-10-13T09:00:00.000Z', 'PASSED', 3000);
    await replay('run-b', '2026-10-14T09:00:00.000Z', 'FAILED', 5000, 2);
    await replay('run-c', '2026-10-15T09:00:00.000Z', 'PASSED', 4000);
    await replay('run-d', '2026-10-21T09:00:00.000Z', 'PASSED', 1000);
    try {
      const trends = await computeTrends([{ id: 'prj_a', name: 'Demandes', reportsDir: reports }], {
        weeks: 3,
        now: new Date('2026-10-27T10:00:00Z'),
      });
      expect(trends.weeks.map((week) => week.week)).toEqual(['2026-W42', '2026-W43', '2026-W44']);
      expect(trends.weeks[0]).toMatchObject({
        replays: { numerator: 2, denominator: 3 },
        medianReplayMs: 4000,
        issues: { CRITICAL: 2 },
      });
      expect(trends.weeks[1]).toMatchObject({
        replays: { numerator: 1, denominator: 1 },
        medianReplayMs: 1000,
      });
      expect(trends.weeks[2]?.medianReplayMs).toBeUndefined();
      expect(trends.weeks[2]?.coverage).toBeUndefined();
      expect(trends.unstable).toEqual([
        { projectId: 'prj_a', projectName: 'Demandes', name: 'search', flips: 2, runs: 4 },
      ]);
    } finally {
      await rm(reports, { recursive: true, force: true });
    }
  });
});
