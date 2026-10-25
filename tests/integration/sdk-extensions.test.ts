import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording, type RecordRequest } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  type Project,
  type ProjectDraft,
  type QaCrawlerClient,
  type RecordingStreamEvent,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * LES EXTENSIONS DU SDK AVEC LE VRAI MOTEUR : un enregistrement lancé par l'API (le vrai recorder,
 * un humain joué par Playwright), puis ce que la revue du recorder fait — décider une proposition
 * d'assertion, créer un groupe métier, générer les tests — et le graphe, la liste des rapports et le
 * lien vers le rapport HTML. Seul l'humain est simulé : le recorder, le flow, la génération sont réels.
 */
let site: TestSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
/** Ce que « l'humain » fait dans le navigateur ouvert par le serveur, par nom d'enregistrement. */
const humans = new Map<string, NonNullable<RecordRequest['drive']>>();

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-extensions-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    // Le vrai recorder ; seul l'humain est joué (et sans écran : la CI n'en a pas).
    record: (request) =>
      runRecording({
        ...request,
        overrides: { ...request.overrides, headless: true },
        drive: humans.get(request.name),
      }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  const draft: ProjectDraft = {
    ...engineDefaults(),
    project: { name: 'Site de démo', targetUrl: `${site.url}/`, framework: 'other' },
  };
  project = await client.projects.create(draft);
}, 60_000);

afterAll(async () => {
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

async function recordUntilDone(name: string): Promise<RecordingStreamEvent[]> {
  const events: RecordingStreamEvent[] = [];
  await client.recordings.subscribe(project.id, name, (event) => events.push(event)).done;
  return events;
}

describe('SDK extensions — real recorder, assertions, groups, generation, graph, reports', () => {
  it('records a journey played by a human and exposes the flow the engine built', async () => {
    humans.set('Ouvrir un utilisateur', async ({ page }) => {
      const pause = (): Promise<void> => page.waitForTimeout(600);
      await pause();
      await page.getByRole('link', { name: 'Utilisateurs' }).click();
      await page.waitForURL('**/users');
      await pause();
      await page.getByRole('link', { name: 'Utilisateur 1', exact: true }).click();
      await page.waitForURL('**/users/1');
      await pause();
      await page.getByRole('link', { name: 'Modifier' }).click();
      await page.waitForURL('**/users/1/edit');
      await pause();
    });
    const started = await client.recordings.start(project.id, { name: 'Ouvrir un utilisateur' });
    expect(started).toMatchObject({ name: 'ouvrir-un-utilisateur', status: 'RECORDING' });
    // Un seul enregistrement à la fois : un humain, un navigateur.
    await expect(client.recordings.start(project.id, { name: 'Autre' })).rejects.toMatchObject({
      status: 409,
      code: 'RECORDING_ACTIVE',
    });

    const events = await recordUntilDone('ouvrir-un-utilisateur');
    const statuses = events.flatMap((event) => (event.type === 'status' ? [event.status] : []));
    expect(statuses).toEqual(['RECORDING', 'PROCESSING', 'COMPLETED']);
    expect(events.some((event) => event.type === 'recorder' && event.event === 'RECORDING_STARTED')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'phase')).toBe(true);

    const done = await client.recordings.get(project.id, 'ouvrir-un-utilisateur');
    expect(done.status).toBe('COMPLETED');
    expect(done.summary?.steps).toBeGreaterThanOrEqual(3);
    expect(done.summary?.files).toEqual(
      expect.arrayContaining(['generated.flow.yaml', 'recorded-flow.json']),
    );

    const flow = await client.recordings.flow(project.id, 'ouvrir-un-utilisateur');
    expect(flow.yaml).toContain('Utilisateur 1');
    expect(flow.feature).toBeDefined();
    expect(flow.steps.length).toBe(done.summary?.steps);

    // Le même nom ne remplace jamais un enregistrement existant.
    await expect(
      client.recordings.start(project.id, { name: 'Ouvrir un utilisateur' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'NAME_TAKEN',
    });
  }, 180_000);

  it('applies a human decision on an assertion proposal and rewrites the flow', async () => {
    const proposals = await client.assertions.list(project.id, 'ouvrir-un-utilisateur');
    expect(proposals.length).toBeGreaterThan(0);
    const target = proposals.find((proposal) => proposal.verificationMethod !== 'REPORT_ONLY');
    expect(target).toBeDefined();
    const decision = target?.inFlow ? 'REJECT' : 'ACCEPT';
    const after = await client.assertions.decide(project.id, 'ouvrir-un-utilisateur', target?.id ?? '', {
      decision,
      note: 'décidé depuis le SDK',
    });
    const decided = after.find((proposal) => proposal.id === target?.id);
    expect(decided).toMatchObject({
      status: decision === 'ACCEPT' ? 'APPROVED' : 'REJECTED',
      inFlow: decision === 'ACCEPT',
      note: 'décidé depuis le SDK',
    });
    // Les fichiers du dossier portent la décision (la même règle que la revue du recorder).
    const file = JSON.parse(
      await readFile(
        path.join(
          workspace,
          project.id,
          'qa-reports',
          'recordings',
          'ouvrir-un-utilisateur',
          'assertion-proposals.json',
        ),
        'utf8',
      ),
    ) as { proposals: { id: string; status: string }[] };
    expect(file.proposals.find((proposal) => proposal.id === target?.id)?.status).toBe(decided?.status);
    await expect(
      client.assertions.decide(project.id, 'ouvrir-un-utilisateur', 'p-unknown', { decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('creates a business group of steps, written into the flow YAML', async () => {
    const flow = await client.recordings.flow(project.id, 'ouvrir-un-utilisateur');
    const stepIds = flow.steps
      .filter((step) => step.kind !== 'expect')
      .map((step) => step.id)
      .slice(0, 2);
    const edited = await client.groups.edit(project.id, 'ouvrir-un-utilisateur', {
      op: 'create',
      name: 'Aller à la liste',
      stepIds,
    });
    expect(edited.groups).toHaveLength(1);
    // Le moteur garde avec une action la vérification d'écran qui la suit (étape `expect` ancrée).
    expect(edited.groups[0]?.name).toBe('Aller à la liste');
    expect(edited.groups[0]?.stepIds).toEqual(expect.arrayContaining(stepIds));
    expect((await client.recordings.flow(project.id, 'ouvrir-un-utilisateur')).yaml).toContain(
      'Aller à la liste',
    );
    await expect(
      client.groups.edit(project.id, 'ouvrir-un-utilisateur', {
        op: 'rename',
        groupId: 'g-unknown',
        name: 'X',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'REFUSED' });
  });

  it('generates tests that are statically validated, never claimed as executed', async () => {
    const result = await client.generation.run(project.id, 'ouvrir-un-utilisateur', {
      formats: ['yaml', 'gherkin', 'playwright'],
    });
    // Le .feature et la mission qui le joue ; le test Playwright et sa configuration.
    expect(result.files.map((file) => file.format).sort()).toEqual([
      'gherkin',
      'gherkin',
      'playwright',
      'playwright',
      'yaml',
    ]);
    for (const file of result.files) {
      expect(file.content.length).toBeGreaterThan(0);
      expect(['EXECUTED', 'PASSED']).not.toContain(file.status);
      await access(
        path.join(
          workspace,
          project.id,
          'qa-reports',
          'recordings',
          'ouvrir-un-utilisateur',
          'generated',
          file.path,
        ),
      );
    }
    expect(result.files.find((file) => file.format === 'playwright')?.content).toContain('@playwright/test');
    await expect(
      client.generation.run(project.id, 'ouvrir-un-utilisateur', { formats: ['cobol' as never] }),
    ).rejects.toMatchObject({ status: 400 });
  }, 120_000);

  it('lists the reports, reads the graph and opens the HTML report through a short link', async () => {
    const reports = await client.reports.list(project.id);
    const entry = reports.find(
      (report) => report.kind === 'recording' && report.name === 'ouvrir-un-utilisateur',
    );
    expect(entry).toMatchObject({ recording: { steps: expect.any(Number) as number }, hasGraph: true });
    const graph = await client.graph.of(project.id, 'recording', 'ouvrir-un-utilisateur');
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    const link = await client.reports.link(project.id, 'recording', 'ouvrir-un-utilisateur');
    const html = await fetch(link.url);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    const listed = await client.recordings.list(project.id);
    expect(listed.map((recording) => recording.name)).toContain('ouvrir-un-utilisateur');
  });

  it('stops a recording from the API, like the stop button of the recording bar', async () => {
    humans.set('Arrêt par API', async ({ page, recorder }) => {
      await page.waitForTimeout(500);
      await page.getByRole('link', { name: 'Utilisateurs' }).click();
      await page.waitForURL('**/users');
      await page.waitForTimeout(500);
      // L'humain continue jusqu'à ce que quelqu'un arrête : ici, l'application hôte par l'API.
      await recorder.stopped;
    });
    await client.recordings.start(project.id, { name: 'Arrêt par API' });
    const events: RecordingStreamEvent[] = [];
    const subscription = client.recordings.subscribe(project.id, 'arret-par-api', (event) =>
      events.push(event),
    );
    await expect
      .poll(() => events.some((event) => event.type === 'recorder' && event.event === 'RECORDING_STARTED'), {
        timeout: 30_000,
      })
      .toBe(true);
    await expect
      .poll(() => events.filter((event) => event.type === 'recorder').length, { timeout: 30_000 })
      .toBeGreaterThan(2);
    const stopped = await client.recordings.stop(project.id, 'arret-par-api');
    expect(stopped.name).toBe('arret-par-api');
    await subscription.done;
    const final = await client.recordings.get(project.id, 'arret-par-api');
    expect(final.status).toBe('COMPLETED');
    expect(final.summary?.stopReason).toBe('api');
    await expect(client.recordings.stop(project.id, 'arret-par-api')).rejects.toMatchObject({
      status: 409,
      code: 'NOT_RECORDING',
    });
  }, 180_000);
});
