import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import type { Incident } from '../../src/sdk/core/incident-contracts.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LES ROUTES DU SCÉNARIO D'ACCÈS : `POST …/access` enregistre (masqué), `POST …/access/analyze` analyse,
 * `POST …/access/locate | prepare | explore` localisent l'écran cible, l'atteignent et lancent le moteur.
 * Un lecteur est refusé (droit RUN) ; un enregistrement inconnu est refusé (404) ; sans écran cible,
 * sans localisation ou sans écran atteint, rien n'est lancé (422). Aucune route de vidéo n'existe.
 */
let workspace: string;
let server: RunningSdkServer;
let admin: QaCrawlerClient;
let reader: QaCrawlerClient;
let project: Project;
let incident: Incident;
const clients: QaCrawlerClient[] = [];

const as = (token: string): QaCrawlerClient => {
  const client = createQaCrawler({ endpoint: `${server.url}/api`, token });
  clients.push(client);
  return client;
};

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof QaCrawlerError ? `${String(error.status)} ${error.code}` : String(error);
  }
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-access-route-'));
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  admin = as(server.token);
  reader = as((await admin.access.createMember({ name: 'Lecteur fictif', role: 'READER' })).token);
  project = await admin.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  incident = await admin.incidents.create(project.id, {
    title: 'Blocage après Enregistrer',
    description: 'd',
    observed: 'o',
    expected: 'e',
    severity: 'HIGH',
  });
});

afterAll(async () => {
  for (const client of clients) client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('routes du scénario d’accès', () => {
  it('enregistre, analyse, refuse ce qui manque ; le lecteur est refusé', async () => {
    const saved = await admin.incidents.saveAccess(project.id, incident.id, {
      narrative:
        'J’ouvre le menu Dossiers puis je clique sur Enregistrer. Après cette action, tout se bloque.',
      testData: 'token: abc123',
    });
    expect(saved.access?.narrative).toMatch(/menu Dossiers/);
    expect(saved.access?.testData).toBe('token: [masqué]');
    expect(await refusal(admin.incidents.saveAccess(project.id, incident.id, { recording: 'absent' }))).toBe(
      '404 NOT_FOUND',
    );
    expect(await refusal(reader.incidents.saveAccess(project.id, incident.id, { narrative: 'x' }))).toMatch(
      /^403/,
    );

    const analyzed = await admin.incidents.analyzeAccess(project.id, incident.id);
    expect(analyzed.access?.analysis?.path.map((step) => step.action)).toEqual(['OPEN', 'SAVE']);
    // Aucune application dans le périmètre : la limite est dite, rien n'est inventé.
    expect(analyzed.access?.analysis?.candidates).toEqual([]);
    expect(analyzed.access?.analysis?.limits.join(' ')).toMatch(/Aucune application dans le périmètre/);

    // Localiser sans écran cible : refusé ; préparer ou lancer sans localisation : refusé.
    expect(await refusal(admin.incidents.locateAccessTarget(project.id, incident.id))).toBe('422 INVALID');
    expect(await refusal(admin.incidents.prepareAccessTarget(project.id, incident.id))).toBe('422 INVALID');
    expect(await refusal(admin.incidents.exploreAccessTarget(project.id, incident.id))).toBe('422 INVALID');
    expect(await refusal(reader.incidents.locateAccessTarget(project.id, incident.id))).toMatch(/^403/);
    // Un écran cible sans application lue : localisé sans candidat, la limite est dite.
    await admin.incidents.saveAccess(project.id, incident.id, {
      target: 'création d’un dossier',
      mode: 'AUTO',
    });
    const located = await admin.incidents.locateAccessTarget(project.id, incident.id);
    expect(located.access?.location?.chosen).toBeUndefined();
    expect(located.access?.location?.limits.join(' ')).toMatch(/aucune route Angular/);
    // Aucune route de vidéo.
    const video = await fetch(
      `${server.url}/api/projects/${project.id}/incidents/${incident.id}/access/demo`,
      { method: 'GET', headers: { authorization: `Bearer ${server.token}` } },
    );
    expect(video.status).toBe(404);
  });
});
