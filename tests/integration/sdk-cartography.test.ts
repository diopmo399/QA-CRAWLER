import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  QaCrawlerError,
  type CartographyView,
  type Environment,
  type ExplorationSnapshot,
  type MapSource,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startCartographyApp, type CartographyApp } from '../fixtures/cartography-app.js';

/**
 * LA CARTOGRAPHIE DE BOUT EN BOUT, avec le vrai serveur et le vrai moteur. Le mini-projet Front (Angular)
 * → BFF (Spring) → Backend (Spring, JPA) → contrat (OpenAPI) est copié sous la racine que le serveur
 * autorise ; ses sources sont configurées, scannées en arrière-plan ; le champ « Company name » est suivi
 * de l'écran à la colonne. Deux scénarios (création, refus) sont associés d'après leurs étapes, rejoués
 * par le moteur sur l'application de l'écran ; la couverture est lue sur ces exécutions. Puis le champ est
 * modifié dans le code, un second scan est lancé, et l'impact désigne la fonctionnalité et les scénarios.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography');
let app: CartographyApp;
let server: RunningSdkServer;
let workspace: string;
let sourcesRoot: string;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;

const CREATE = `name: Create a request
startAt: /requests/new
steps:
  - fill: { label: Company name, value: Example Ltd }
  - fill: { label: Contact email, value: contact@example.test }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { response: { method: POST, url: /api/requests, status: 201 } }
`;
const REFUSE = `name: Refuse an empty company
startAt: /requests/new
steps:
  - fill: { label: Contact email, value: contact@example.test }
  - click: { role: button, name: Save }
    allow: MUTATION
  - expect: { response: { method: POST, url: /api/requests, status: 400 } }
`;

const sources = (): MapSource[] => [
  {
    id: 'front',
    name: 'Front',
    layer: 'FRONTEND',
    path: path.join(sourcesRoot, 'front'),
    include: [],
    enabled: true,
  },
  { id: 'bff', name: 'BFF', layer: 'BFF', path: path.join(sourcesRoot, 'bff'), include: [], enabled: true },
  {
    id: 'backend',
    name: 'Backend',
    layer: 'BACKEND',
    path: path.join(sourcesRoot, 'backend'),
    include: [],
    enabled: true,
  },
  {
    id: 'contracts',
    name: 'Contracts',
    layer: 'API',
    path: path.join(sourcesRoot, 'contracts'),
    include: [],
    enabled: true,
  },
  {
    id: 'other',
    name: 'Other',
    layer: 'OTHER',
    path: path.join(sourcesRoot, 'other'),
    include: [],
    enabled: true,
  },
];

async function settled(): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await client.cartography.currentScan(project.id);
    if (state.state !== 'RUNNING') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the scan did not finish in time');
}

async function replayed(snapshot: ExplorationSnapshot): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const subscription = client.explorations.subscribe(snapshot.id, (event) => {
      if (event.type === 'completed' || event.type === 'failed') {
        subscription.close();
        resolve();
      }
    });
    setTimeout(() => {
      reject(new Error('the replay did not finish in time'));
    }, 120_000);
  });
}

const featureNamed = (view: CartographyView, name: string): string =>
  view.model?.features.find((feature) => feature.proposedName === name)?.id ?? '';

beforeAll(async () => {
  app = await startCartographyApp();
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-cartography-'));
  sourcesRoot = await mkdtemp(path.join(tmpdir(), 'sdk-cartography-sources-'));
  await cp(FIXTURE, sourcesRoot, { recursive: true });
  server = await startSdkServer({ workspace, language: 'fr', env: {}, allowedSourceRoots: [sourcesRoot] });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Requests', targetUrl: `${app.url}/`, framework: 'angular' },
  });
  const flows = path.join(workspace, project.id, 'qa-crawler', 'flows');
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, 'create-request.yaml'), CREATE);
  await writeFile(path.join(flows, 'refuse-request.yaml'), REFUSE);
  environment = await client.environments.create(project.id, {
    name: 'Test',
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
  await rm(sourcesRoot, { recursive: true, force: true });
});

describe('SDK cartography — real server, real engine', () => {
  it('says « non calculable » before any scan, and refuses a source outside the allowed roots', async () => {
    const empty = await client.cartography.get(project.id);
    expect(empty.allowedRoots).toEqual([sourcesRoot]);
    expect(empty.supported).toEqual(['ANGULAR', 'SPRING', 'JPA', 'OPENAPI']);
    expect(empty.model).toBeUndefined();
    expect(empty.summary.percent).toBeUndefined();
    expect(empty.summary.formula).toContain('non calculable');
    const refused = await client.cartography
      .saveConfig(project.id, {
        sources: sources()
          .slice(0, 1)
          .map((source) => ({ ...source, path: FIXTURE })),
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(QaCrawlerError);
    expect((refused as QaCrawlerError).status).toBe(422);
    const noScan = await client.cartography.scan(project.id).catch((error: unknown) => error);
    expect((noScan as QaCrawlerError).status).toBe(409);
    // L'exploration progressive avant tout scan : un résumé sans scan, des pages vides, aucune fiche.
    const summary = await client.cartography.summary(project.id);
    expect(summary.scan).toBeUndefined();
    expect(summary.kpis.features).toBe(0);
    expect((await client.cartography.features(project.id)).total).toBe(0);
    const noFeature = await client.cartography
      .feature(project.id, 'FEATURE:x')
      .catch((error: unknown) => error);
    expect((noFeature as QaCrawlerError).status).toBe(409);
  });

  it('scans the configured sources in the background and follows the field across the layers', async () => {
    const config = await client.cartography.saveConfig(project.id, { sources: sources() });
    expect(config.sources).toHaveLength(5);
    const started = await client.cartography.scan(project.id);
    expect(started.state).toBe('RUNNING');
    await settled();
    const view = await client.cartography.get(project.id);
    // En cas d'échec, l'état du scan (et ses erreurs) dit pourquoi.
    expect(view.scans, JSON.stringify(await client.cartography.currentScan(project.id))).toHaveLength(1);
    expect(view.model?.scan.state).toBe('COMPLETED');
    const other = view.model?.scan.sources.find((source) => source.sourceId === 'other');
    expect(other?.technologies.map((t) => t.note)).toEqual(
      expect.arrayContaining([expect.stringContaining('connecteur manquant : DOTNET')]),
    );
    const concept = view.model?.concepts.find(
      (c) => c.id === 'CONCEPT:FIELD:front:RequestCreateComponent#form.companyName',
    );
    expect(concept?.layers).toEqual(
      expect.arrayContaining(['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE']),
    );
    expect(concept?.fields).toContain('COLUMN:backend:Request.organizationName');
    // La preuve se lit : quelques lignes du fichier, sous la source ; jamais un secret, jamais hors de la source.
    const mapping = view.model?.edges.find(
      (e) =>
        e.kind === 'TRANSFORMS' &&
        e.to === 'COLUMN:backend:Request.organizationName' &&
        e.from.includes('CreateRequestCommand'),
    );
    const evidence = mapping?.evidence[0];
    const excerpt = await client.cartography.evidence(project.id, {
      source: 'backend',
      file: evidence?.file ?? '',
      line: evidence?.line ?? 1,
    });
    expect(excerpt.lines.join('\n')).toContain('setOrganizationName(command.getOrganizationName())');
    for (const file of ['credentials.properties', '../front/package.json'])
      expect(
        (
          (await client.cartography
            .evidence(project.id, { source: 'backend', file })
            .catch((e: unknown) => e)) as QaCrawlerError
        ).status,
      ).toBe(400);
  }, 60_000);

  it('associates the scenarios from their steps and measures the coverage on real executions', async () => {
    let view = await client.cartography.get(project.id);
    const create = featureNamed(view, 'Request create');
    const proposed = view.links.filter((link) => link.feature === create);
    expect(proposed.map((link) => [link.scenario, link.status, link.confidence, link.path]).sort()).toEqual([
      ['Create a request', 'PROPOSED', 'CONFIRMED', 'POSITIVE'],
      ['Refuse an empty company', 'PROPOSED', 'CONFIRMED', 'NEGATIVE'],
    ]);
    // Jamais exécutés : associés, mais ni traversés, ni vérifiés, ni réussis.
    expect(view.coverage.find((c) => c.feature === create)?.status).toBe('PARTIAL');
    const started = await client.executions.start(project.id, { environmentId: environment.id });
    await replayed(started);
    const detail = await client.executions.get(project.id, started.run ?? '');
    expect(detail.flowsDetail.map((flow) => [flow.name, flow.status]).sort()).toEqual([
      ['Create a request', 'PASSED'],
      ['Refuse an empty company', 'PASSED'],
    ]);
    expect(app.accepted()).toEqual(['Example Ltd']);
    view = await client.cartography.get(project.id);
    const coverage = view.coverage.find((c) => c.feature === create);
    expect(coverage?.status).toBe('COVERED');
    expect(coverage?.criteria.every((criterion) => criterion.met === true)).toBe(true);
    expect(coverage?.scenarios.find((row) => row.scenario === 'Create a request')).toMatchObject({
      traversed: true,
      passed: true,
      lastRun: { run: started.run },
    });
    expect(view.summary.numerator).toBe(1);
    expect(view.summary.denominator).toBe(view.model?.features.length);
    // Une décision : renommée et confirmée, l'historique garde l'auteur absent (jeton du service).
    await client.cartography.decide(project.id, {
      kind: 'RENAME',
      target: create,
      value: 'Create a request',
    });
    const decisions = await client.cartography.decide(project.id, { kind: 'CONFIRM', target: create });
    expect(decisions.map((d) => d.kind)).toEqual(['RENAME', 'CONFIRM']);
    view = await client.cartography.get(project.id);
    expect(view.model?.features.find((f) => f.id === create)).toMatchObject({
      name: 'Create a request',
      status: 'CONFIRMED',
    });
    const unknown = await client.cartography
      .decide(project.id, { kind: 'CONFIRM', target: 'FEATURE:nothing' })
      .catch((e: unknown) => e);
    expect((unknown as QaCrawlerError).status).toBe(404);
  }, 180_000);

  it('after a change of the field in the code, the impact names the feature and the scenarios to replay', async () => {
    const component = path.join(sourcesRoot, 'front/src/app/requests/request-create.component.ts');
    await writeFile(
      component,
      (await readFile(component, 'utf8')).replace('Validators.maxLength(120)', 'Validators.maxLength(100)'),
    );
    await client.cartography.scan(project.id);
    await settled();
    const view = await client.cartography.get(project.id);
    expect(view.scans).toHaveLength(2);
    expect(view.model?.scan.sources.find((s) => s.sourceId === 'front')?.state).toBe('SCANNED');
    expect(view.model?.scan.sources.find((s) => s.sourceId === 'backend')?.state).toBe('REUSED');
    const report = await client.cartography.impact(project.id);
    expect(
      report.changes.find((c) => c.node === 'FIELD:front:RequestCreateComponent#form.companyName')?.detail,
    ).toContain('maxLength : 120 → 100');
    expect(report.features.find((f) => f.name === 'Create a request')?.confidence).toBe('CONFIRMED');
    expect(report.scenarios.map((s) => [s.scenario, s.confidence]).sort()).toEqual([
      ['Create a request', 'CONFIRMED'],
      ['Refuse an empty company', 'CONFIRMED'],
    ]);
  }, 60_000);

  it('the progressive API answers page by page from an index built once, invalidated by a decision or a scan', async () => {
    const COMPANY = 'FIELD:front:RequestCreateComponent#form.companyName';
    const summary = await client.cartography.summary(project.id);
    expect(summary.kpis.features).toBe(4);
    expect(summary.performance.indexedFields).toBeGreaterThan(10);
    // Niveau 1 : une page bornée, la suivante, la recherche et le tri côté serveur.
    const first = await client.cartography.features(project.id, { size: 2 });
    const second = await client.cartography.features(project.id, { size: 2, page: 2 });
    expect([first.total, first.items.length, second.items.length]).toEqual([4, 2, 2]);
    expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(4);
    const create = (await client.cartography.features(project.id, { q: 'create a request' })).items;
    expect(create.map((row) => row.name)).toEqual(['Create a request']);
    const createId = create[0]?.id ?? '';
    // Niveau 2 : les champs de cette fonctionnalité seulement, une page à la fois.
    const fields = await client.cartography.featureFields(project.id, createId, { q: 'company' });
    expect(fields.items.map((row) => row.id)).toEqual([COMPANY]);
    expect(fields.items[0]?.layers).toEqual(
      expect.arrayContaining(['FRONTEND', 'BFF', 'BACKEND', 'DATABASE']),
    );
    // Niveau 3 : la fiche du champ et un sous-graphe borné ; un voisinage s'ajoute à la demande.
    const sheet = await client.cartography.field(project.id, COMPANY, { feature: createId, limit: 4 });
    expect(sheet.graph.nodes).toHaveLength(4);
    expect(sheet.graph.truncated).toBe(true);
    expect(sheet.reuse.map((r) => r.name)).toEqual(expect.arrayContaining(['Create a request']));
    expect(sheet.coverage.denominator).toBeGreaterThan(0);
    const around = await client.cartography.neighbors(project.id, COMPANY, { depth: 1, limit: 3 });
    expect(around.nodes.length).toBeLessThanOrEqual(3);
    expect(
      (await client.cartography.concepts(project.id, { q: 'organization_name' })).items.map((c) => c.id),
    ).toContain(`CONCEPT:${COMPANY}`);
    expect((await client.cartography.issues(project.id, { size: 1 })).items.length).toBeLessThanOrEqual(1);
    // Ce qui n'existe pas est dit (404), jamais inventé.
    // Chaque requête est lancée puis attendue tour à tour (aucun refus laissé sans réponse).
    for (const missing of [
      () => client.cartography.feature(project.id, 'FEATURE:none'),
      () => client.cartography.featureFields(project.id, 'FEATURE:none'),
      () => client.cartography.field(project.id, 'FIELD:none'),
      () => client.cartography.neighbors(project.id, 'FIELD:none'),
    ])
      expect(((await missing().catch((error: unknown) => error)) as QaCrawlerError).status).toBe(404);
    // Le cache : les requêtes suivantes réutilisent l'index (aucune reconstruction).
    const cached = (await client.cartography.summary(project.id)).performance.cache;
    await client.cartography.features(project.id, { page: 2, size: 1 });
    const again = (await client.cartography.summary(project.id)).performance.cache;
    expect(again.misses).toBe(cached.misses);
    expect(again.hits).toBeGreaterThan(cached.hits);
    // Une association manuelle d'un scénario au champ invalide l'index ; des requêtes concurrentes ne le
    // reconstruisent qu'une fois, et la fiche montre l'association, d'origine manuelle.
    await client.cartography.decide(project.id, {
      kind: 'LINK_FIELD',
      target: COMPANY,
      value: 'Refuse an empty company',
    });
    const [, , linked] = await Promise.all([
      client.cartography.features(project.id),
      client.cartography.featureFields(project.id, createId),
      client.cartography.field(project.id, COMPANY),
      client.cartography.concepts(project.id),
    ]);
    const rebuilt = (await client.cartography.summary(project.id)).performance.cache;
    expect(rebuilt.misses).toBe(again.misses + 1);
    expect(linked.scenarios.find((s) => s.scenario === 'Refuse an empty company')?.origin).toBe('MANUAL');
    const badLink = await client.cartography
      .decide(project.id, { kind: 'LINK_FIELD', target: COMPANY, value: 'No such scenario' })
      .catch((error: unknown) => error);
    expect((badLink as QaCrawlerError).status).toBeGreaterThanOrEqual(400);
    // Un nouveau scan change la version : l'index est reconstruit pour lui.
    const before = await client.cartography.summary(project.id);
    await client.cartography.scan(project.id);
    await settled();
    const after = await client.cartography.summary(project.id);
    expect(after.scan?.id).not.toBe(before.scan?.id);
    expect(after.performance.cache.misses).toBe(before.performance.cache.misses + 1);
    // Une requête annulée par l'écran ne revient pas.
    const controller = new AbortController();
    controller.abort();
    const aborted = await client.cartography
      .summary(project.id, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect((aborted as QaCrawlerError).code).toBe('ABORTED');
  }, 60_000);

  it('an evidence whose file changed after the scan is said to be stale', async () => {
    const sheet = await client.cartography.field(
      project.id,
      'FIELD:front:RequestCreateComponent#form.companyName',
    );
    const evidence = sheet.node.evidence[0];
    expect(evidence?.file).toBeTruthy();
    const fresh = await client.cartography.evidence(project.id, {
      source: evidence?.sourceId ?? '',
      file: evidence?.file ?? '',
      line: evidence?.line ?? 1,
    });
    expect(fresh.stale).toBeUndefined();
    const file = path.join(sourcesRoot, 'front', evidence?.file ?? '');
    // Un instant plus tard que la fin du scan, pour que la date du fichier la dépasse sûrement.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(file, `${await readFile(file, 'utf8')}\n`);
    const stale = await client.cartography.evidence(project.id, {
      source: evidence?.sourceId ?? '',
      file: evidence?.file ?? '',
      line: evidence?.line ?? 1,
    });
    expect(stale.stale).toBeTruthy();
  });
  it('the APIs & Services catalog: real counts, a sheet, a business rename and a manual classification', async () => {
    const catalog = await client.cartography.apis(project.id, { size: 3 });
    expect(catalog.available).toBe(true);
    expect(catalog.counts).toEqual({ all: 6, internal: 4, external: 1, unclassified: 1 });
    expect(catalog.items).toHaveLength(3);
    expect(catalog.kpis.endpoints).toBe(11);
    const external = (await client.cartography.apis(project.id, { scope: 'EXTERNAL' })).items[0];
    expect(external).toMatchObject({
      provider: 'api.partner.example',
      firstEndpoint: 'POST /v1/companies/verify',
    });
    const sheet = await client.cartography.api(project.id, external?.id ?? '');
    expect(sheet.api.baseUrl).toBe('https://api.partner.example');
    expect(sheet.features.map((f) => f.name)).toEqual(['Company form']);
    expect([...new Set(sheet.path.nodes.map((n) => n.layer))]).toEqual(['FRONTEND', 'BFF', 'BACKEND']);
    // Renommer : un nom métier, sans toucher au code ni à l'identifiant.
    await client.cartography.decide(project.id, {
      kind: 'RENAME_API',
      target: external?.id ?? '',
      value: 'Company verification',
    });
    const renamed = await client.cartography.api(project.id, external?.id ?? '');
    expect(renamed.api).toMatchObject({
      name: 'Company verification',
      technicalName: 'PartnerVerificationClient',
    });
    // Classer à la main l'appel indéterminé.
    const unknown = (await client.cartography.apis(project.id, { scope: 'UNCLASSIFIED' })).items[0];
    await client.cartography.decide(project.id, {
      kind: 'CLASSIFY_API',
      target: unknown?.id ?? '',
      value: 'EXTERNAL',
    });
    expect((await client.cartography.apis(project.id)).counts).toMatchObject({
      external: 2,
      unclassified: 0,
    });
    // Ce qui n'existe pas, ou une valeur hors liste, est refusé.
    const refusals = [
      () => client.cartography.api(project.id, 'API:none'),
      () => client.cartography.decide(project.id, { kind: 'RENAME_API', target: 'API:none', value: 'x' }),
      () =>
        client.cartography.decide(project.id, {
          kind: 'CLASSIFY_API',
          target: external?.id ?? '',
          value: 'ELSEWHERE',
        }),
    ];
    const statuses: number[] = [];
    for (const refused of refusals)
      statuses.push(((await refused().catch((error: unknown) => error)) as QaCrawlerError).status);
    expect(statuses).toEqual([404, 404, 400]);
  });
});
