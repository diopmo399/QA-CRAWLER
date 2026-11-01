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
import type { Incident } from '../../src/sdk/core/incident-contracts.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LES ROUTES DE LA DÉCOUVERTE DU PÉRIMÈTRE : `POST …/scope/discover` analyse un dépôt (droit RUN, lecture
 * seule, mots de l'incident et application nommée pris en compte, chemin invalide expliqué sans erreur HTTP),
 * `GET …/scope/repositories` liste les dépôts connus (périmètre de l'incident, autres incidents du projet) ;
 * un lecteur est refusé ; l'extension ADD_APPLICATION « COUCHE:racine » (celle que le bloc demande une fois
 * l'investigation commencée) ajoute l'application avec sa couche une fois approuvée.
 */
let workspace: string;
let repos: string;
let server: RunningSdkServer;
let admin: QaCrawlerClient;
let reader: QaCrawlerClient;
let project: Project;
let incident: Incident;
let other: Incident;
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

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-discover-ws-'));
  repos = await mkdtemp(path.join(tmpdir(), 'incident-discover-repos-'));
  await write(path.join(repos, 'catalogue-web'), {
    'package.json': JSON.stringify({ name: 'catalogue-web', dependencies: { '@angular/core': '^18' } }),
    'src/main.ts': '',
    'src/app/livres/livre.component.ts': '',
    'src/app/auteurs/auteur.component.ts': '',
  });
  await write(path.join(repos, 'bff'), {
    'pom.xml':
      '<project><artifactId>livres-bff</artifactId><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
    'src/main/java/org/example/LivresApplication.java': '',
  });
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  admin = as(server.token);
  reader = as((await admin.access.createMember({ name: 'Lecteur fictif', role: 'READER' })).token);
  project = await admin.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  other = await admin.incidents.create(project.id, {
    title: 'Autre incident',
    description: 'd',
    observed: 'o',
    expected: 'e',
    severity: 'LOW',
    scope: {
      applications: [
        {
          id: 'bff',
          name: 'BFF livres',
          layer: 'BFF',
          repository: { root: path.join(repos, 'bff'), include: [] },
        },
      ],
    },
  });
  incident = await admin.incidents.create(project.id, {
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après « Enregistrer », la page des livres reste figée.',
    observed: 'HTTP 500',
    expected: 'livre créé',
    severity: 'HIGH',
    application: 'Catalogue',
  });
});

afterAll(async () => {
  for (const client of clients) client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(repos, { recursive: true, force: true });
});

describe('scope discovery — routes', () => {
  it('analyzes a repository with the words of the incident, read only (RUN right)', async () => {
    const before = await admin.incidents.get(project.id, incident.id);
    const result = await admin.incidents.discoverScope(
      project.id,
      incident.id,
      path.join(repos, 'catalogue-web'),
    );
    expect(result.status).toBe('OK');
    expect(result.structure).toBe('SINGLE');
    expect(result.keywords).toContain('livre');
    expect(result.keywords).toContain('catalogue');
    expect(result.applications).toHaveLength(1);
    const app = result.applications[0];
    expect(app?.application).toMatchObject({
      id: 'catalogue-web',
      layer: 'FRONTEND',
      repository: { root: path.join(repos, 'catalogue-web'), include: [] },
    });
    expect(app?.frameworks).toEqual(['Angular']);
    expect(app?.modules.map((module) => module.name)).toEqual(['auteurs', 'livres']);
    expect(app?.modules.find((module) => module.name === 'livres')?.matched).toContain('livre');
    expect(app?.suggested).toBe(true);
    expect(app?.reasons[0]).toBe('application nommée par l’incident (« Catalogue »)');
    // Rien n'est écrit : même révision, même périmètre.
    const after = await admin.incidents.get(project.id, incident.id);
    expect(after.revision).toBe(before.revision);
    expect(after.scope.applications).toEqual([]);
    expect(await refusal(reader.incidents.discoverScope(project.id, incident.id, repos))).toBe(
      '403 FORBIDDEN',
    );
  });

  it('explains an invalid or missing path as a result, and refuses an empty body', async () => {
    const relative = await admin.incidents.discoverScope(project.id, incident.id, 'repos/front');
    expect(relative.status).toBe('FAILED');
    expect(relative.problems[0]).toMatchObject({ code: 'ROOT_RELATIVE' });
    const missing = await admin.incidents.discoverScope(project.id, incident.id, path.join(repos, 'nowhere'));
    expect(missing.problems[0]).toMatchObject({ code: 'ROOT_MISSING' });
    expect(await refusal(admin.incidents.discoverScope(project.id, incident.id, '   '))).toBe(
      '400 BAD_REQUEST',
    );
  });

  it('lists the repositories known to the environment: this scope, other incidents of the project', async () => {
    const known = await admin.incidents.knownRepositories(project.id, incident.id);
    expect(known.repositories).toEqual([
      {
        root: path.join(repos, 'bff'),
        label: 'BFF livres (Autre incident)',
        source: 'INCIDENT',
        incidentId: other.id,
      },
    ]);
    const own = await admin.incidents.knownRepositories(project.id, other.id);
    expect(own.repositories).toEqual([
      { root: path.join(repos, 'bff'), label: 'BFF livres', source: 'SCOPE' },
    ]);
    expect(await refusal(reader.incidents.knownRepositories(project.id, incident.id))).toBe('403 FORBIDDEN');
  });

  it('once the investigation started, an ADD_APPLICATION extension « LAYER:root » adds the application after approval', async () => {
    // Le périmètre défini puis l'investigation commencée (reproduction impossible ici : état par mise à jour du périmètre).
    const scoped = await admin.incidents.update(project.id, incident.id, incident.revision, {
      scope: {
        applications: [
          {
            id: 'catalogue-web',
            name: 'catalogue-web',
            layer: 'FRONTEND',
            repository: { root: path.join(repos, 'catalogue-web'), include: [] },
            origin: {
              kind: 'DISCOVERED',
              at: '2026-11-01T10:00:00.000Z',
              analyzedRoot: path.join(repos, 'catalogue-web'),
            },
          },
        ],
      },
    });
    expect(scoped.scope.applications[0]?.origin?.kind).toBe('DISCOVERED');
    const requested = await admin.incidents.requestExtension(project.id, incident.id, {
      kind: 'ADD_APPLICATION',
      target: `BFF:${path.join(repos, 'bff')}`,
      applicationId: 'livres-bff',
      reason: 'Découverte automatique : pom.xml : projet Maven « livres-bff »',
    });
    const extension = requested.scope.extensions.find((entry) => entry.status === 'PENDING');
    expect(extension).toMatchObject({ kind: 'ADD_APPLICATION', applicationId: 'livres-bff' });
    const approved = await admin.incidents.decideExtension(
      project.id,
      incident.id,
      extension?.id ?? '',
      true,
    );
    expect(
      approved.scope.applications.map((application) => `${application.id}:${application.layer}`),
    ).toEqual(['catalogue-web:FRONTEND', 'livres-bff:BFF']);
    // Une discovery ultérieure signale ce qui est déjà dans le périmètre.
    const again = await admin.incidents.discoverScope(project.id, incident.id, path.join(repos, 'bff'));
    expect(again.applications[0]).toMatchObject({ alreadyInScope: 'livres-bff', suggested: false });
  });
});
