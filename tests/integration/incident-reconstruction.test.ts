import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Incident, InvestigationReport, IncidentSummary } from '../../src/incident/model.js';
import {
  createQaCrawler,
  type Environment,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startIncidentSite, type IncidentSite } from '../fixtures/incident-site.js';

/**
 * L'INCIDENT CONNU, DE BOUT EN BOUT, AVEC LE VRAI MOTEUR : « Lors de la création d'un livre, après avoir
 * cliqué sur Enregistrer, l'application affiche une erreur HTTP 500. » Déclarer → Délimiter → Reproduire
 * (Playwright, Chromium) → Observer (la requête POST /api/books en 500, rattachée au clic) → Inspecter le
 * code (frontend TypeScript, BFF Java, backend Spring Boot de tests/fixtures/incident-app) → Corréler →
 * Vérifier (comparaison avec le scénario qui réussit, validation absente) → Diagnostiquer → Rapporter →
 * Générer le test de non-régression, puis l'exécuter réellement (il échoue : le défaut est toujours là).
 */
let site: IncidentSite;
let server: RunningSdkServer;
let workspace: string;
let repos: string;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;

const FAILING = 'Créer un livre sans éditeur';
const PASSING = 'Créer un livre avec éditeur';

const flow = (name: string, publisher?: string): string => `name: ${name}
startAt: /books/new
steps:
  - fill: { label: Titre, value: Les Marées du Nord }
  - fill: { label: ISBN, value: 978-2-0000-0000-1 }
${publisher ? `  - select: { label: Éditeur, option: ${publisher} }\n` : ''}  - click: { role: button, name: Enregistrer }
    allow: MUTATION
  - expect: { text: Livre créé }
`;

async function api<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server.url}/api/projects/${project.id}/incidents${route}`, {
    method,
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} → ${String(response.status)} ${text}`);
  return JSON.parse(text) as T;
}

async function until(
  id: string,
  done: (incident: Incident) => boolean,
  timeoutMs = 150_000,
): Promise<Incident> {
  const started = Date.now();
  for (;;) {
    const incident = await api<Incident>('GET', `/${id}`);
    if (done(incident)) return incident;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out; state ${incident.state}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

beforeAll(async () => {
  site = await startIncidentSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-ws-'));
  repos = await mkdtemp(path.join(tmpdir(), 'incident-repos-'));
  await cp(path.join(import.meta.dirname, '../fixtures/incident-app'), repos, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr' });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: `${site.url}/books`, framework: 'other' },
  });
  environment = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: site.url,
    mutations: { enabled: true, maxPerRun: 5 },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows', 'books');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'sans-editeur.flow.yaml'), flow(FAILING));
  await writeFile(path.join(flows, 'avec-editeur.flow.yaml'), flow(PASSING, 'Éditions du Nord'));
}, 120_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(repos, { recursive: true, force: true });
});

describe('Incident Reconstruction — the known incident with the real engine', () => {
  let incident: Incident;

  it('declares the incident, with a GUIDED scope on the three repositories, persisted', async () => {
    incident = await api<Incident>('POST', '', {
      title: 'Erreur 500 à la création d’un livre',
      description:
        'Lors de la création d’un livre, après avoir cliqué sur Enregistrer, l’application affiche une erreur HTTP 500.',
      observed: 'Erreur HTTP 500 après Enregistrer',
      expected: 'Livre créé',
      severity: 'HIGH',
      scenario: FAILING,
      environmentId: environment.id,
      scope: {
        applications: [
          {
            id: 'front',
            name: 'Frontend',
            layer: 'FRONTEND',
            repository: { root: path.join(repos, 'frontend'), include: ['src'] },
          },
          {
            id: 'bff',
            name: 'BFF',
            layer: 'BFF',
            repository: { root: path.join(repos, 'bff'), include: ['src/main'] },
          },
          {
            id: 'catalog',
            name: 'Catalogue',
            layer: 'BACKEND',
            repository: { root: path.join(repos, 'backend'), include: ['src/main'] },
          },
        ],
        scenarios: [FAILING, PASSING],
      },
    });
    expect(incident.scope.mode).toBe('GUIDED');
    expect(incident.execution.target).toBe('LOCAL');
    expect(incident.history[0]?.kind).toBe('CREATED');
    const listed = await api<IncidentSummary[]>('GET', '');
    expect(listed.map((entry) => entry.id)).toContain(incident.id);
    expect((await api<{ ok: boolean; issues: unknown[] }>('POST', `/${incident.id}/scope/validate`)).ok).toBe(
      true,
    );
  });

  it('reproduces it with Playwright: the 500 of POST /api/books, observed on the click on Enregistrer', async () => {
    await api<Incident>('POST', `/${incident.id}/reproduce`);
    incident = await until(incident.id, (current) => current.state !== 'REPRODUCING');
    expect(incident.state).toBe('REPRODUCED');
    const reproduction = incident.investigation.reproductions.at(-1);
    expect(reproduction?.reproduced).toBe(true);
    const failing = reproduction?.requests.find(
      (request) => request.path === '/api/books' && request.method === 'POST',
    );
    expect(failing?.status).toBe(500);
    expect(failing?.correlation).toBe('OBSERVED');
    const click = reproduction?.actions.find((action) => action.description.includes('Enregistrer'));
    expect(failing?.step).toBe(click?.index);
    expect(failing?.responseBody).toContain('NullPointerException');
    // Le site a bien reçu la requête sans éditeur.
    expect(site.calls.some((call) => !call.body.includes('publisherId'))).toBe(true);
  }, 180_000);

  it('inspects the code and correlates: request → BFF → backend, each link with its status', async () => {
    incident = await api<Incident>('POST', `/${incident.id}/analyze`);
    const code = incident.investigation.code;
    expect(
      code?.endpoints.some(
        (endpoint) =>
          endpoint.layer === 'BFF' && endpoint.method === 'POST' && endpoint.path === '/api/books',
      ),
    ).toBe(true);
    expect(
      code?.endpoints.some((endpoint) => endpoint.layer === 'BACKEND' && endpoint.path === '/catalog/books'),
    ).toBe(true);
    const graph = incident.investigation.graph;
    expect(graph?.nodes.some((node) => node.kind === 'BFF_ENDPOINT')).toBe(true);
    expect(
      graph?.nodes.some((node) => node.kind === 'BACKEND_SERVICE' || node.kind === 'BACKEND_ENDPOINT'),
    ).toBe(true);
    // Ce qui vient du code n'est jamais présenté comme observé.
    const codeNodes = new Set(
      (graph?.nodes ?? []).filter((node) => node.symbolId !== undefined).map((node) => node.id),
    );
    for (const edge of graph?.edges ?? [])
      if (codeNodes.has(edge.from) && codeNodes.has(edge.to)) expect(edge.status).not.toBe('OBSERVED');
    expect(incident.investigation.hypotheses.length).toBeGreaterThan(0);
    // La validation manquante vise le champ absent de la requête, dans les DTO de requête (jamais ceux de réponse).
    const validation = incident.investigation.hypotheses.find(
      (entry) => entry.id === 'hyp-missing-validation',
    );
    expect(validation?.title).toContain('publisherId');
    expect(validation?.files.some((file) => file.endsWith('CreateBookRequest.java'))).toBe(true);
    expect(validation?.files.some((file) => /BookView|CatalogBookResponse/.test(file))).toBe(false);
    expect(incident.investigation.hypotheses.every((hypothesis) => hypothesis.status === 'PROPOSED')).toBe(
      true,
    );
  });

  it('refuses what the scope does not allow, and runs what it allows', async () => {
    // Les tests unitaires ne sont pas permis par le périmètre par défaut : refus, rien n'est exécuté.
    incident = await api<Incident>('POST', `/${incident.id}/experiments`, {
      kind: 'UNIT_TEST',
      params: {
        applicationId: 'catalog',
        command: 'mvn',
        args: ['-q', 'test', '-Dtest=CatalogBookServiceTest'],
      },
    });
    const unit = incident.investigation.experiments.at(-1);
    await api('POST', `/${incident.id}/experiments/${unit?.id ?? ''}/run`);
    incident = await until(incident.id, (current) =>
      current.investigation.experiments.some((entry) => entry.id === unit?.id && entry.status !== 'RUNNING'),
    );
    expect(incident.investigation.experiments.find((entry) => entry.id === unit?.id)?.status).toBe('REFUSED');
  });

  it('verifies against the passing scenario, then diagnoses from the evidence', async () => {
    const hypothesis = incident.investigation.hypotheses[0];
    incident = await api<Incident>('POST', `/${incident.id}/experiments`, {
      kind: 'COMPARE_WITH_PASSING',
      params: { passingScenario: PASSING, field: 'publisherId' },
      ...(hypothesis ? { hypothesisId: hypothesis.id } : {}),
    });
    const compare = incident.investigation.experiments.at(-1);
    await api('POST', `/${incident.id}/experiments/${compare?.id ?? ''}/run`);
    incident = await until(incident.id, (current) =>
      current.investigation.experiments.some(
        (entry) => entry.id === compare?.id && entry.status !== 'RUNNING' && entry.status !== 'PROPOSED',
      ),
    );
    const done = incident.investigation.experiments.find((entry) => entry.id === compare?.id);
    expect(done?.status).toBe('DONE');
    expect(done?.outcome).toBe('SUPPORTS');
    incident = await api<Incident>('POST', `/${incident.id}/diagnose`);
    const diagnosis = incident.investigation.diagnosis;
    expect(diagnosis?.status).not.toBe('INCONCLUSIVE');
    expect(JSON.stringify(diagnosis)).toMatch(/publisher/i);
  }, 180_000);

  it('produces the report (JSON and Markdown) and a regression test that really runs, and fails', async () => {
    const report = await api<InvestigationReport>('GET', `/${incident.id}/report?format=json`);
    expect(report.requests.some((request) => request.status === 500)).toBe(true);
    expect(report.timeline.length).toBeGreaterThan(0);
    const { markdown } = await api<{ markdown: string }>('GET', `/${incident.id}/report?format=markdown`);
    expect(markdown).toContain('/api/books');
    incident = await api<Incident>('POST', `/${incident.id}/regression`);
    expect(incident.investigation.regression?.status).toBe('PROPOSED');
    expect(incident.investigation.regression?.execution).toBeUndefined();
    await api('POST', `/${incident.id}/regression/run`);
    incident = await until(
      incident.id,
      (current) => current.investigation.regression?.execution !== undefined,
    );
    // Le défaut est toujours là : le test de non-régression échoue, et le dit.
    expect(incident.investigation.regression?.execution?.passed).toBe(false);
    // Rien n'entre dans la bibliothèque sans validation.
    expect(
      (await client.scenarios.list(project.id)).some(
        (scenario) => scenario.name === incident.investigation.regression?.name,
      ),
    ).toBe(false);
  }, 180_000);

  it('shows the investigation in the Dashboard (Chromium): workspace, synchronized selection, code, diagnosis, demo', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('response', (response) => {
        if (response.url().includes('/sdk/') && response.status() >= 400)
          failures.push(`${String(response.status())} ${response.url()}`);
      });
      await page.goto(`${server.url}/dashboard`);
      const dashboard = page.locator('qa-crawler-dashboard');
      await dashboard.locator('select[data-action="project-context"]').selectOption(project.id);
      await dashboard.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
      await dashboard.locator('[data-action="inc-open"]', { hasText: 'Erreur 500' }).click();
      // L'espace d'investigation : en-tête, progression, onglets, graphe full-stack à côté du contenu.
      await dashboard.locator('#ws-ux-tab-overview[aria-selected="true"]').waitFor();
      const graph = dashboard.locator('[data-ws-zone="graph"] svg.ws-graph-svg');
      await graph.waitFor();
      expect(await graph.locator('.ws-graph-node').count()).toBeGreaterThan(5);
      // La requête en échec, sélectionnée dans « Requêtes HTTP » : le graphe met en évidence ses nœuds,
      // le panneau contextuel montre son détail.
      await dashboard.locator('#ws-ux-tab-requests').click();
      await dashboard.locator('.ws-timeline-path', { hasText: '/api/books' }).click();
      await dashboard
        .locator('[data-ws-zone="graph"] .ws-graph-node[data-ws-state="related"]')
        .first()
        .waitFor();
      expect(
        await dashboard
          .locator(
            '[data-ws-zone="graph"] .ws-graph-node[data-ws-state="selected"], [data-ws-zone="graph"] .ws-graph-node.ws-related',
          )
          .count(),
      ).toBeGreaterThan(0);
      const aside = dashboard.locator('[data-ws-zone="aside"]');
      await aside.locator('.ws-timeline-detail').waitFor();
      const detail = (await aside.textContent()) ?? '';
      expect(detail).toContain('/api/books');
      expect(detail).toContain('500');
      expect(detail).toMatch(/NullPointerException/);
      // Le code du backend, lu dans le périmètre : CatalogBookService, la ligne visée mise en évidence.
      await dashboard.locator('#ws-ux-tab-backend').click();
      const code = dashboard.locator('[data-ws-zone="main"] .ws-code');
      await code.locator('.ws-code-sel').waitFor();
      expect(await code.getAttribute('data-file')).toMatch(/CatalogBookService\.java$/);
      expect(await code.textContent()).toContain('CatalogBookService');
      // Le diagnostic : une cause probable n'est jamais présentée comme confirmée.
      await dashboard.locator('#ws-ux-tab-diagnosis').click();
      const diagnosis = (await dashboard.locator('#ws-ux-panel').textContent()) ?? '';
      expect(diagnosis).toMatch(/publisher/i);
      expect(diagnosis).toContain('Cause probable');
      expect(diagnosis).not.toContain('Cause racine confirmée');
      expect(await dashboard.locator('#ws-ux-panel .ws-dx-diag').getAttribute('data-status')).toBe(
        'PROBABLE',
      );
      // La démonstration, depuis la liste : bandeau « Données de démonstration », actions désactivées.
      await dashboard.locator('[data-action="back"][data-to="incidents"]').click();
      await dashboard.locator('[data-action="inc-demo"]').first().click();
      await dashboard.locator('#ws-demo-why').waitFor();
      expect(await dashboard.locator('.ws-demo').first().textContent()).toContain('Données de démonstration');
      expect(await dashboard.locator('[data-action="inc-reproduce"]').isDisabled()).toBe(true);
      expect(failures).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 90_000);

  it('cancels and resumes; LOCAL, REMOTE and ARO share one investigation contract', async () => {
    incident = await api<Incident>('POST', `/${incident.id}/cancel`);
    expect(incident.state).toBe('CANCELLED');
    incident = await api<Incident>('POST', `/${incident.id}/resume`);
    expect(incident.state).not.toBe('CANCELLED');
    for (const target of ['LOCAL', 'REMOTE', 'ARO'] as const) {
      const execution =
        target === 'ARO'
          ? {
              target,
              aro: {
                namespace: 'qa-crawler',
                serviceAccount: 'qa-crawler',
                image: 'qa-crawler:latest',
                repositoriesMount: '/repos',
              },
            }
          : { target };
      incident = await api<Incident>('POST', `/${incident.id}/update`, {
        revision: incident.revision,
        patch: { execution },
      });
      const capabilities = await api<{ target: string; limitations: string[] }>(
        'GET',
        `/${incident.id}/capabilities`,
      );
      expect(capabilities.target).toBe(target);
    }
  });
});
