import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  type ExplorationEvent,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults, REPORTS_DIR } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startQualityApp, type QualityApp } from '../fixtures/quality-app.js';

/**
 * L'ANNULATION AVEC LE VRAI MOTEUR. Un rejeu lancé par le SDK est annulé dès sa première étape : le
 * moteur s'arrête avant l'étape suivante (les autres sont SKIPPED), ferme le navigateur, écrit son
 * résultat avec `stopReason: cancelled`, et l'exécution passe CANCELLED. Rien n'a été enregistré :
 * l'étape qui écrit n'a pas été jouée.
 */
let app: QualityApp;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;

const FLOW = `name: create-request
startAt: /
steps:
  - expect: { url: / }
  - click: { role: button, name: New request }
    allow: MUTATION
  - fill: { label: Title, value: Cancelled run }
  - click: { role: button, name: Save }
    allow: MUTATION
`;

beforeAll(async () => {
  app = await startQualityApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-cancel-'));
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: `${app.url}/`, framework: 'other' },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'create-request.flow.yaml'), FLOW);
  await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: app.url,
    allowedDomains: [new URL(app.url).hostname],
    mutations: { enabled: true, maxPerRun: 5 },
  });
}, 60_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await app.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('SDK cancellation — real engine', () => {
  it('stops a running replay before its next step and records it as cancelled', async () => {
    const environment = (await client.environments.list(project.id))[0];
    const started = await client.executions.start(project.id, { environmentId: environment?.id ?? '' });
    const events: ExplorationEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      let asked = false;
      const subscription = client.explorations.subscribe(started.id, (event) => {
        events.push(event);
        if (event.type === 'flow-step' && !asked) {
          asked = true;
          void client.explorations.cancel(started.id).catch(reject);
        }
        if (event.type === 'completed' || event.type === 'failed') {
          subscription.close();
          resolve();
        }
      });
      setTimeout(() => {
        reject(new Error('the replay did not stop in time'));
      }, 120_000);
    });

    const last = await client.explorations.status(started.id);
    expect(last.status).toBe('CANCELLED');
    expect(events.some((event) => event.type === 'phase' && event.phase === 'cancellation requested')).toBe(
      true,
    );
    // L'écriture n'a pas eu lieu : le moteur s'est arrêté avant.
    expect(app.records()).toHaveLength(0);

    const run = started.run ?? '';
    const stored = JSON.parse(
      await readFile(path.join(workspace, project.id, REPORTS_DIR, run, 'result.json'), 'utf8'),
    ) as { stopReason: string };
    expect(stored.stopReason).toBe('cancelled');
    const detail = await client.executions.get(project.id, run);
    expect(detail.verdict).toBe('CANCELLED');
    const statuses = detail.flowsDetail[0]?.steps.map((step) => step.status) ?? [];
    // L'arrêt a lieu avant une étape : la première est jouée, la dernière (l'écriture) ne l'est pas.
    expect(statuses[0]).toBe('PASSED');
    expect(statuses.at(-1)).toBe('SKIPPED');
  }, 150_000);
});
