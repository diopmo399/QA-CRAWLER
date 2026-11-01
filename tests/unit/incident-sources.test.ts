import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskSource } from '../../src/incident/service.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import type { Incident } from '../../src/sdk/core/incident-contracts.js';
import { workspaceLinks, relatedKeys } from '../../src/sdk/ui/incident-links.js';
import { evidenceChips, workspaceContext } from '../../src/sdk/ui/incident-parts.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * L'EXPLORATEUR DE CODE ET LES CAPTURES, CÔTÉ SERVEUR : seuls les fichiers du périmètre se lisent
 * (droit RUN), en lecture seule, valeurs sensibles masquées, avec les lignes que l'investigation désigne ;
 * une capture n'est rendue que si la reproduction l'a enregistrée, dans son propre dossier.
 */
let workspace: string;
let repos: string;
let server: RunningSdkServer;
let service: QaCrawlerClient;
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
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-sources-ws-'));
  repos = await mkdtemp(path.join(tmpdir(), 'incident-sources-repos-'));
  await cp(path.join(import.meta.dirname, '../fixtures/incident-app'), repos, { recursive: true });
  // Un secret de configuration, un lien qui sort du dépôt : ni l'un ni l'autre ne doit fuir.
  await writeFile(
    path.join(repos, 'backend/src/main/resources/application-local.yml'),
    'spring:\n  datasource:\n    url: jdbc:postgresql://db:5432/catalog\n    password: s3cr3t-value\n    username: catalog\n',
  );
  await mkdir(path.join(repos, 'outside'), { recursive: true });
  await writeFile(path.join(repos, 'outside', 'private.txt'), 'outside the scope');
  await symlink(path.join(repos, 'outside', 'private.txt'), path.join(repos, 'backend/src/main/escape.txt'));
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  service = as(server.token);
  reader = as((await service.access.createMember({ name: 'Lecteur fictif', role: 'READER' })).token);
  project = await service.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  incident = await service.incidents.create(project.id, {
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après Enregistrer, une erreur HTTP 500.',
    observed: 'Erreur HTTP 500',
    expected: 'Livre créé',
    severity: 'HIGH',
    scenario: 'Créer un livre sans éditeur',
    scope: {
      applications: [
        {
          id: 'front',
          name: 'Frontend',
          layer: 'FRONTEND',
          repository: { root: path.join(repos, 'frontend'), include: ['src'] },
        },
        {
          id: 'catalog',
          name: 'Catalogue',
          layer: 'BACKEND',
          repository: { root: path.join(repos, 'backend'), include: ['src/main'] },
        },
      ],
    },
  });
  incident = await service.incidents.analyze(project.id, incident.id);
});

afterAll(async () => {
  for (const client of clients) client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(repos, { recursive: true, force: true });
});

describe('Incident Reconstruction — reading the code within the scope', () => {
  it('lists the readable files of each application, never what escapes the repository', async () => {
    const tree = await service.incidents.sourceTree(project.id, incident.id);
    const front = tree.applications.find((entry) => entry.applicationId === 'front');
    const catalog = tree.applications.find((entry) => entry.applicationId === 'catalog');
    expect(front?.files).toContain('src/books/BookForm.tsx');
    expect(catalog?.files.some((file) => file.endsWith('CatalogBookService.java'))).toBe(true);
    expect(catalog?.files.some((file) => file.includes('escape'))).toBe(false);
  });

  it('returns a file read-only, its symbols and the lines the investigation points at, values masked', async () => {
    const service_ = 'src/main/java/org/example/catalog/books/CatalogBookService.java';
    const view = await service.incidents.source(project.id, incident.id, 'catalog', service_);
    expect(view.language).toBe('java');
    expect(view.text).toContain('getPublisher()');
    expect(view.symbols.some((symbol) => symbol.name === 'CatalogBookService.register')).toBe(true);
    const config = await service.incidents.source(
      project.id,
      incident.id,
      'catalog',
      'src/main/resources/application-local.yml',
    );
    expect(config.text).not.toContain('s3cr3t-value');
    expect(config.text).toContain('password: [REDACTED]');
    expect(config.text).toContain('username: catalog');
  });

  it('refuses what is outside the scope: traversal, symlink escape, unknown application, a reader', async () => {
    expect(
      await refusal(service.incidents.source(project.id, incident.id, 'catalog', '../outside/private.txt')),
    ).toBe('403 OUT_OF_SCOPE');
    expect(
      await refusal(service.incidents.source(project.id, incident.id, 'catalog', 'src/main/escape.txt')),
    ).toBe('403 OUT_OF_SCOPE');
    expect(await refusal(service.incidents.source(project.id, incident.id, 'ghost', 'a.java'))).toBe(
      '404 NOT_FOUND',
    );
    // Lire le code demande le droit d'investiguer (RUN) : un lecteur voit l'incident, pas les dépôts.
    expect(await refusal(reader.incidents.sourceTree(project.id, incident.id))).toBe('403 FORBIDDEN');
    expect((await reader.incidents.get(project.id, incident.id)).id).toBe(incident.id);
  });

  it('never returns a screenshot that no reproduction recorded', async () => {
    expect(
      await refusal(service.incidents.screenshot(project.id, incident.id, 'rep_1', '../../etc/passwd')),
    ).toBe('404 NOT_FOUND');
  });
});

describe('Incident Reconstruction — masking and selection links', () => {
  it('masks secret-looking configuration values, keeps placeholders and ordinary values', () => {
    const masked = maskSource(
      'application.properties',
      'catalog.url=http://localhost:8081\nspring.datasource.password=abc123\napi.key=${API_KEY}\n',
    );
    expect(masked).toContain('catalog.url=http://localhost:8081');
    expect(masked).toContain('spring.datasource.password=[REDACTED]');
    expect(masked).toContain('api.key=${API_KEY}');
    expect(maskSource('Book.java', 'String password = input;')).toContain('String password');
  });

  it('links a request to its step, its graph nodes and their code, two hops away', () => {
    const linked: Incident = {
      ...incident,
      investigation: {
        ...incident.investigation,
        reproductions: [
          {
            id: 'rep_1',
            startedAt: '2026-10-31T10:00:00.000Z',
            status: 'COMPLETED',
            target: 'LOCAL',
            scenario: incident.scenario ?? '',
            reproduced: true,
            actions: [
              {
                index: 3,
                kind: 'click',
                description: 'click Enregistrer',
                status: 'FAILED',
                durationMs: 10,
                requestIds: ['rep_1:req-3-0'],
              },
            ],
            requests: [
              {
                id: 'rep_1:req-3-0',
                method: 'POST',
                url: '/api/books',
                path: '/api/books',
                status: 500,
                resourceType: 'fetch',
                step: 3,
                correlation: 'OBSERVED',
              },
            ],
            evidence: [],
            screenshots: [],
          },
        ],
        graph: {
          nodes: [
            {
              id: 'request:rep_1:req-3-0',
              kind: 'REQUEST',
              label: 'POST /api/books → 500',
              layer: 'NETWORK',
              evidence: ['rep_1:req-3-0'],
            },
            {
              id: 'bff:create',
              kind: 'BFF_ENDPOINT',
              label: 'POST /api/books',
              layer: 'BFF',
              evidence: [],
              source: { applicationId: 'bff', layer: 'BFF', file: 'BookController.java', line: 28 },
            },
          ],
          edges: [
            {
              from: 'request:rep_1:req-3-0',
              to: 'bff:create',
              status: 'STATICALLY_RESOLVED',
              reason: 'route',
              evidence: [],
            },
          ],
        },
      },
    };
    const links = workspaceLinks(linked);
    const related = relatedKeys(links, { kind: 'request', id: 'rep_1:req-3-0' });
    expect(related.has('step:rep_1#3')).toBe(true);
    expect(related.has('node:request:rep_1:req-3-0')).toBe(true);
    expect(related.has('edge:request:rep_1:req-3-0->bff:create')).toBe(true);
    // La relation mène au nœud BFF, et le nœud BFF à son fichier : la sélection d'une requête ouvre son code.
    expect(
      relatedKeys(links, { kind: 'edge', id: 'request:rep_1:req-3-0->bff:create' }).has(
        'file:bff:BookController.java',
      ),
    ).toBe(true);
  });

  it('turns each evidence reference into a chip of its real kind, and an unknown one into plain text', () => {
    const symbol = incident.investigation.code?.symbols.find(
      (entry) => entry.name === 'CatalogBookService.register',
    );
    expect(symbol).toBeDefined();
    const ctx = workspaceContext({
      incident,
      lang: 'fr',
      links: workspaceLinks(incident),
      demo: false,
      can: () => true,
    });
    const html = evidenceChips(ctx, [symbol?.id ?? '', 'rep_9'], 4);
    expect(html).toContain(`data-kind="symbol" data-ref="${symbol?.id ?? ''}"`);
    // L'identifiant d'une reproduction ne désigne rien de sélectionnable : pas de bouton, pas de « n'existe plus ».
    expect(html).not.toContain('data-ref="rep_9"');
    expect(html).toContain('class="ws-chip static"');
  });
});
