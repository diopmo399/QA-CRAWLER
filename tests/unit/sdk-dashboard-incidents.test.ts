import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQaCrawler, QaCrawlerError, type QaCrawlerClient } from '../../src/sdk/core/client.js';
import type { ProjectDetail } from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import type {
  Experiment,
  Incident,
  InvestigationGraph,
  InvestigationScope,
  ReproductionRun,
} from '../../src/incident/model.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { emptyEditorUi } from '../../src/sdk/ui/dashboard-editor.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import {
  IncidentsController,
  INCIDENT_POLL_MS,
  type IncidentsHost,
} from '../../src/sdk/ui/dashboard-incidents-controller.js';
import {
  applicationOf,
  applicationSuggestions,
  attachmentTypeOf,
  base64Of,
  canReproduce,
  emptyApplicationForm,
  emptyIncidentForm,
  emptyIncidentsUi,
  groupCounts,
  incidentFormProblems,
  incidentInputOf,
  incidentsCsv,
  needsPolling,
  scopeFormOf,
  scopeOf,
  sizeText,
  sortAttachments,
  visibleIncidents,
  type IncidentsUi,
} from '../../src/sdk/ui/dashboard-incidents.js';
import type { IncidentSummary } from '../../src/sdk/core/incident-contracts.js';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../../src/sdk/core/incident-contracts.js';
import { emptyCodeUi, revealInCode } from '../../src/sdk/ui/incident-code.js';
import { planInputOf, regressionVerdict } from '../../src/sdk/ui/incident-diagnosis.js';
import { graphLayout2 } from '../../src/sdk/ui/incident-graph.js';
import { evidenceChips } from '../../src/sdk/ui/incident-parts.js';
import { emptyWorkspaceUi, workspaceCtx, type WorkspaceUi } from '../../src/sdk/ui/incident-workspace.js';
import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import {
  activeNav,
  renderDashboard,
  type DashboardRoute,
  type DashboardState,
} from '../../src/sdk/ui/dashboard-view.js';

/**
 * LES INCIDENTS DANS LE DASHBOARD ET LE CLIENT DU SDK : les routes appelées, la liste et la
 * déclaration, l'espace d'investigation d'un incident par onglets (périmètre et extensions,
 * reproduction depuis l'en-tête, graphe et statuts des relations, expériences et approbation explicite,
 * non-régression jamais « réussie » sans exécution), les droits (un lecteur voit sans agir), le suivi
 * d'une reproduction en cours. Le détail de l'espace (sélection, panneau, code, démonstration) est
 * couvert par incident-ui-workspace.test.ts.
 */
const at = '2026-10-30T09:00:00.000Z';
const t = dashboardStrings('fr');

const project = {
  id: 'prj_books',
  name: 'Catalogue',
  targetUrl: 'http://127.0.0.1:9/',
  framework: 'other',
  createdAt: at,
  status: 'PROJECT_CREATED',
  state: 'ACTIVE',
  counts: { environments: 1, scenarios: 2, recordings: 0, executions: 0 },
  draft: { exploration: { ignoredPaths: [] } },
  environments: [
    {
      id: 'env_test',
      name: 'Recette',
      kind: 'TEST',
      baseUrl: 'http://books.test/',
      createdAt: at,
      updatedAt: at,
    },
  ],
  scenarios: [
    { name: 'Créer un livre', file: 'books/create.flow.yaml', format: 'yaml', steps: 4 },
    { name: 'Bloc connexion', file: 'library/login.flow.yaml', format: 'yaml', steps: 2, reusable: true },
  ],
} as unknown as ProjectDetail;

const scope: InvestigationScope = {
  mode: 'GUIDED',
  applications: [
    {
      id: 'bff',
      name: 'BFF livres',
      layer: 'BFF',
      repository: { root: '/repos/bff', include: ['src/main/java'], classes: ['BookController'] },
      baseUrl: 'http://bff.test',
    },
  ],
  scenarios: ['Créer un livre'],
  steps: [],
  endpoints: ['POST /api/books'],
  depth: 3,
  allowedHosts: ['books.test'],
  logRoots: [],
  allowedCommands: [],
  permissions: {
    readSources: true,
    navigate: true,
    httpRequests: 'NONE',
    runTests: 'NONE',
    localCommands: false,
    readLogs: false,
    openshift: 'NONE',
    sideEffects: false,
  },
  limits: {
    maxFiles: 2000,
    maxFileBytes: 524288,
    maxDurationMs: 600000,
    maxRequests: 200,
    maxExperiments: 20,
  },
  extensions: [
    {
      id: 'ext_1',
      kind: 'ADD_PATH',
      target: 'src/main/java/org/example/bff/books',
      applicationId: 'bff',
      reason: 'le controller <BookController> est hors du dossier inclus',
      status: 'PENDING',
      requestedAt: at,
      requestedBy: 'analyste',
    },
  ],
};

const reproduction: ReproductionRun = {
  id: 'rep_1',
  startedAt: at,
  finishedAt: at,
  status: 'COMPLETED',
  target: 'LOCAL',
  scenario: 'Créer un livre',
  run: 'run-20261030',
  reproduced: true,
  symptomMatch: 'HTTP 500 observé sur POST /api/books',
  actions: [
    {
      index: 1,
      kind: 'click',
      description: 'Cliquer sur Enregistrer',
      status: 'PASSED',
      durationMs: 120,
      requestIds: ['req_1'],
    },
  ],
  requests: [
    {
      id: 'req_1',
      method: 'POST',
      url: 'http://books.test/api/books',
      path: '/api/books',
      status: 500,
      durationMs: 80,
      resourceType: 'fetch',
      step: 1,
      correlation: 'OBSERVED',
      responseBody: '{"status":500,"message":"Catalog error"}',
    },
  ],
  evidence: [],
  screenshots: ['step-1.png'],
};

const graph: InvestigationGraph = {
  nodes: [
    { id: 'n_inc', kind: 'INCIDENT', label: 'Erreur 500', layer: 'UNKNOWN', evidence: [] },
    { id: 'n_req', kind: 'REQUEST', label: 'POST /api/books', layer: 'FRONTEND', evidence: ['req_1'] },
    { id: 'n_bff', kind: 'BFF_ENDPOINT', label: 'BookController.create', layer: 'BFF', evidence: [] },
    {
      id: 'n_svc',
      kind: 'BACKEND_SERVICE',
      label: 'CatalogBookService.register',
      layer: 'BACKEND',
      evidence: [],
    },
  ],
  edges: [
    {
      from: 'n_inc',
      to: 'n_req',
      status: 'OBSERVED',
      reason: 'vue pendant la reproduction',
      evidence: ['req_1'],
    },
    { from: 'n_req', to: 'n_bff', status: 'STATICALLY_RESOLVED', reason: 'méthode et chemin', evidence: [] },
    { from: 'n_bff', to: 'n_svc', status: 'INFERRED', reason: 'par le chemin seul', evidence: [] },
    { from: 'n_svc', to: 'n_repo', status: 'UNKNOWN', reason: 'appel dynamique', evidence: [] },
  ],
};

const experiment = (over: Partial<Experiment> = {}): Experiment => ({
  id: 'exp_1',
  kind: 'INTEGRATION_TEST',
  hypothesisId: 'hyp_1',
  description: 'Créer un livre sans éditeur contre le backend',
  params: { command: 'mvn', args: ['test', '-Dtest=CatalogBookServiceTest'] },
  status: 'APPROVAL_REQUIRED',
  sideEffects: true,
  decisions: [],
  evidence: [],
  ...over,
});

const incidentOf = (over: Partial<Incident> = {}): Incident => ({
  id: 'inc_abc123def456',
  projectId: 'prj_books',
  title: 'Erreur 500 à la création d’un <livre>',
  description: 'Lors de la création d’un livre, après Enregistrer, une erreur HTTP 500 apparaît.',
  observed: 'erreur HTTP 500 après Enregistrer',
  expected: 'le livre est créé',
  severity: 'HIGH',
  scenario: 'Créer un livre',
  environmentId: 'env_test',
  execution: { target: 'LOCAL' },
  scope,
  state: 'REPRODUCED',
  revision: 4,
  createdAt: at,
  updatedAt: at,
  createdBy: 'analyste',
  history: [{ at, actor: 'analyste', kind: 'CREATED', message: 'incident déclaré' }],
  investigation: {
    reproductions: [reproduction],
    graph,
    hypotheses: [
      {
        id: 'hyp_1',
        title: 'Éditeur absent non validé',
        description: 'publisherId vide arrive jusqu’au backend',
        suspectedCause: 'book.getPublisher().getName() sur un éditeur null',
        layer: 'BACKEND',
        files: ['src/main/java/org/example/catalog/books/CatalogBookService.java'],
        supporting: [{ ref: 'req_1', fact: 'NullPointerException dans la réponse' }],
        contradicting: [],
        confidence: 0.6,
        verifications: [
          {
            kind: 'COMPARE_WITH_PASSING',
            description: 'Comparer avec un éditeur choisi',
            params: { field: 'publisherId' },
          },
        ],
        status: 'PROPOSED',
      },
    ],
    experiments: [],
  },
  ...over,
});

const summary = (over: Partial<IncidentSummary> = {}): IncidentSummary => ({
  id: 'inc_1',
  title: 'Erreur',
  severity: 'HIGH',
  state: 'DRAFT',
  target: 'LOCAL',
  createdAt: at,
  updatedAt: at,
  ...over,
});

const role = (name: 'READER' | 'ANALYST' | 'PILOT') => ({
  me: {
    id: 'm',
    name: 'N',
    kind: 'MEMBER' as const,
    role: name,
    rights: [...ROLE_RIGHTS[name]],
    mode: 'named' as const,
  },
});

/** L'état de l'espace d'investigation d'un incident (sélection, vues, fichiers lus). */
const wsOf = (over: Partial<WorkspaceUi> = {}, id = 'inc_abc123def456'): WorkspaceUi => ({
  ...emptyWorkspaceUi(id),
  ...over,
});

const base = (route: DashboardRoute, inc: Partial<IncidentsUi> = {}, extra: Partial<DashboardState> = {}) =>
  ({
    t,
    phase: 'ready',
    route,
    days: 7,
    showArchived: false,
    launch: { kind: 'REPLAY', environmentId: '', scenarios: [], busy: false },
    projectId: 'prj_books',
    menuOpen: false,
    checks: {},
    cancellation: true,
    picked: [],
    severity: 'ALL',
    project,
    req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
    signIn: false,
    access: emptyAccessUi(),
    recs: emptyRecordingsUi(),
    lib: emptyLibraryUi(),
    tst: emptyTestsUi(),
    ed: emptyEditorUi(),
    inc: { ...emptyIncidentsUi(), ...inc },
    ...extra,
  }) as DashboardState;

const page = (
  tab: NonNullable<Extract<DashboardRoute, { view: 'incident' }>['tab']>,
  incident = incidentOf(),
) => ({ view: 'incident', projectId: 'prj_books', incidentId: incident.id, tab }) as const;

describe('SDK client — incidents', () => {
  it('calls the incident routes of the server, ids encoded, bodies as documented', async () => {
    const calls: string[] = [];
    const fake: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${url}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`);
      return Promise.resolve(
        new Response(url.includes('format=markdown') ? '{"markdown":"# Rapport"}' : '{}', { status: 200 }),
      );
    };
    const client = createQaCrawler({ endpoint: 'http://localhost/api', token: 't', fetch: fake });
    const p = 'prj_1';
    const i = 'inc/1';
    await client.incidents.list(p);
    await client.incidents.create(p, {
      title: 'T',
      description: '',
      observed: 'o',
      expected: 'e',
      severity: 'LOW',
    });
    await client.incidents.get(p, i);
    await client.incidents.update(p, i, 3, { title: 'U' });
    await client.incidents.validateScope(p, i);
    await client.incidents.requestExtension(p, i, { kind: 'ADD_HOST', target: 'books.test', reason: 'r' });
    await client.incidents.decideExtension(p, i, 'ext#1', true);
    await client.incidents.capabilities(p, i);
    await client.incidents.reproduce(p, i, { headed: true });
    await client.incidents.analyze(p, i);
    await client.incidents.planExperiment(p, i, { kind: 'REPLAY', params: {} });
    await client.incidents.runExperiment(p, i, 'exp_1', { approve: true });
    await client.incidents.diagnose(p, i);
    await client.incidents.report(p, i);
    await expect(client.incidents.reportMarkdown(p, i)).resolves.toBe('# Rapport');
    await client.incidents.proposeRegression(p, i);
    await client.incidents.runRegression(p, i);
    await client.incidents.acceptRegression(p, i);
    await client.incidents.rejectRegression(p, i);
    await client.incidents.cancel(p, i);
    await client.incidents.resume(p, i);
    const root = 'http://localhost/api/projects/prj_1/incidents';
    expect(calls).toEqual([
      `GET ${root}`,
      `POST ${root} {"title":"T","description":"","observed":"o","expected":"e","severity":"LOW"}`,
      `GET ${root}/inc%2F1`,
      `POST ${root}/inc%2F1/update {"revision":3,"patch":{"title":"U"}}`,
      `POST ${root}/inc%2F1/scope/validate {}`,
      `POST ${root}/inc%2F1/scope/extensions {"kind":"ADD_HOST","target":"books.test","reason":"r"}`,
      `POST ${root}/inc%2F1/scope/extensions/ext%231/decision {"approve":true}`,
      `GET ${root}/inc%2F1/capabilities`,
      `POST ${root}/inc%2F1/reproduce {"headed":true}`,
      `POST ${root}/inc%2F1/analyze {}`,
      `POST ${root}/inc%2F1/experiments {"kind":"REPLAY","params":{}}`,
      `POST ${root}/inc%2F1/experiments/exp_1/run {"approve":true}`,
      `POST ${root}/inc%2F1/diagnose {}`,
      `GET ${root}/inc%2F1/report?format=json`,
      `GET ${root}/inc%2F1/report?format=markdown`,
      `POST ${root}/inc%2F1/regression {}`,
      `POST ${root}/inc%2F1/regression/run {}`,
      `POST ${root}/inc%2F1/regression/accept {}`,
      `POST ${root}/inc%2F1/regression/reject {}`,
      `POST ${root}/inc%2F1/cancel {}`,
      `POST ${root}/inc%2F1/resume {}`,
    ]);
  });

  it('a stale revision is refused as a QaCrawlerError 409 with its code', async () => {
    const client = createQaCrawler({
      endpoint: 'http://localhost/api',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'revision 3 is stale', status: 409, code: 'CONFLICT' }), {
            status: 409,
          }),
        ),
    });
    const failure = await client.incidents.update('p', 'i', 3, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QaCrawlerError);
    expect(failure).toMatchObject({ status: 409, code: 'CONFLICT', message: 'revision 3 is stale' });
  });
});

describe('dashboard — incidents: pure helpers', () => {
  it('evidence is shown by its short name, the full id staying in the tooltip (shared chips)', () => {
    const incident = incidentOf();
    const ctx = workspaceCtx(incident, wsOf(), 'fr', () => true);
    const chips = evidenceChips(ctx, [
      'catalog:src/main/java/org/example/catalog/books/CatalogBookService.java#CatalogBookService.register',
      'req_1',
    ]);
    // Une référence que l'investigation ne connaît pas (ici, aucun symbole déclaré) reste du texte : son
    // nom court affiché, l'identifiant complet dans l'infobulle, rien à sélectionner.
    expect(chips).toContain(
      'title="catalog:src/main/java/org/example/catalog/books/CatalogBookService.java#CatalogBookService.register — référence sans élément sélectionnable dans l’investigation">CatalogBookService.register</span>',
    );
    // Une requête connue se sélectionne comme requête.
    expect(chips).toContain('data-kind="request" data-ref="req_1"');
    expect(chips).not.toContain('data-kind="evidence"');
  });

  it('the declaration form: required fields, ARO details, LOCAL/REMOTE/ARO execution config', () => {
    const form = emptyIncidentForm(project);
    expect(form.scenario).toBe('Créer un livre');
    expect(form.environmentId).toBe('env_test');
    expect(form.kind).toBe('FUNCTIONAL');
    expect(form.application).toBe('');
    expect(incidentFormProblems(form)).toEqual([
      'title',
      'description',
      'application',
      'expected',
      'observed',
    ]);
    const filled = {
      ...form,
      title: ' T ',
      description: 'D',
      application: ' Catalogue ',
      observed: 'HTTP 500',
      expected: 'créé',
    };
    expect(incidentFormProblems(filled)).toEqual([]);
    expect(incidentFormProblems({ ...filled, application: 'x'.repeat(121) })).toEqual(['application']);
    expect(incidentInputOf(filled)).toMatchObject({
      title: 'T',
      application: 'Catalogue',
      kind: 'FUNCTIONAL',
      execution: { target: 'LOCAL' },
    });
    expect(incidentInputOf({ ...filled, application: '  ', kind: 'DATA' })).not.toHaveProperty('application');
    expect(incidentInputOf({ ...filled, kind: 'DATA' }).kind).toBe('DATA');
    expect(incidentFormProblems({ ...filled, target: 'ARO' })).toEqual([
      'namespace',
      'serviceAccount',
      'image',
      'repositoriesMount',
    ]);
    expect(
      incidentInputOf({
        ...filled,
        target: 'ARO',
        namespace: 'qa',
        serviceAccount: 'qa-crawler',
        image: 'registry/qa:1',
        repositoriesMount: '/workspace',
      }).execution,
    ).toEqual({
      target: 'ARO',
      aro: {
        namespace: 'qa',
        serviceAccount: 'qa-crawler',
        image: 'registry/qa:1',
        repositoriesMount: '/workspace',
      },
    });
    expect(incidentInputOf({ ...filled, target: 'REMOTE' }).execution).toEqual({ target: 'REMOTE' });
    expect(incidentInputOf({ ...filled, target: 'REMOTE', namespace: 'books' }).execution).toEqual({
      target: 'REMOTE',
      remote: { openshift: { namespace: 'books' } },
    });
  });

  it('the scope edit keeps permissions, limits and extensions (they change only by an approved extension)', () => {
    const form = scopeFormOf(scope);
    const added = applicationOf(
      { ...emptyApplicationForm(), id: 'catalog', root: '/repos/catalog', include: 'src/main, src/test' },
      form.applications,
    );
    expect(added).toMatchObject({ id: 'catalog', name: 'catalog', layer: 'BACKEND' });
    expect(applicationOf({ ...emptyApplicationForm(), id: 'bff', root: '/x' }, form.applications)).toBe(
      'duplicate',
    );
    expect(applicationOf({ ...emptyApplicationForm(), id: 'x', root: 'repos/x' }, form.applications)).toBe(
      'relative',
    );
    expect(applicationOf(emptyApplicationForm(), form.applications)).toBe('missing');
    if (typeof added === 'string') throw new Error('expected an application');
    const next = scopeOf(
      {
        ...form,
        mode: 'MANUAL',
        depth: '4',
        steps: '2, 3, x',
        endpoints: 'POST /api/books\nGET /api/books/{id}',
        applications: [...form.applications, added],
      },
      { ...scope, permissions: { ...scope.permissions, sideEffects: true } },
    );
    expect(next.mode).toBe('MANUAL');
    expect(next.depth).toBe(4);
    expect(next.steps).toEqual([2, 3]);
    expect(next.endpoints).toEqual(['POST /api/books', 'GET /api/books/{id}']);
    expect(next.applications.map((app) => app.id)).toEqual(['bff', 'catalog']);
    expect(next.applications[1]?.repository.include).toEqual(['src/main', 'src/test']);
    expect(next.permissions.sideEffects).toBe(true);
    expect(next.extensions).toEqual(scope.extensions);
    expect(next.limits).toEqual(scope.limits);
  });

  it('plan parameters, reproduction availability, polling and the regression verdict', () => {
    // Les paramètres d'une expérience planifiée dans la page : clés en double ou vides refusées.
    expect(
      planInputOf({
        kind: 'INSPECT_LOGS',
        hypothesisId: 'hyp_1',
        params: [
          { key: 'field', value: 'publisherId' },
          { key: 'retries', value: '2' },
          { key: 'flag', value: 'true' },
        ],
      }),
    ).toEqual({
      ok: true,
      input: {
        kind: 'INSPECT_LOGS',
        hypothesisId: 'hyp_1',
        params: { field: 'publisherId', retries: 2, flag: true },
      },
    });
    expect(
      planInputOf({
        kind: 'REPLAY',
        hypothesisId: '',
        params: [
          { key: 'a', value: '1' },
          { key: 'a', value: '2' },
        ],
      }).ok,
    ).toBe(false);
    expect(canReproduce({ state: 'SCOPED' })).toBe(true);
    expect(canReproduce({ state: 'DRAFT' })).toBe(false);
    expect(canReproduce({ state: 'REPRODUCING' })).toBe(false);
    expect(canReproduce({ state: 'CANCELLED' })).toBe(false);
    expect(needsPolling(incidentOf({ state: 'REPRODUCING' }))).toBe(true);
    expect(needsPolling(incidentOf())).toBe(false);
    expect(regressionVerdict(undefined)).toBe('NOT_RUN');
    expect(regressionVerdict({})).toBe('NOT_RUN');
    expect(regressionVerdict({ execution: { run: 'run-1', passed: false, at } })).toBe('FAILED');
    expect(regressionVerdict({ execution: { run: 'run-1', passed: true, at } })).toBe('PASSED');
  });

  it('the graph is laid out in layers: incident, then frontend, BFF, backend; a missing end is never drawn', () => {
    const layout = graphLayout2(graph);
    const x = (id: string): number => layout.nodes.find((laid) => laid.node.id === id)?.x ?? -1;
    expect(x('n_inc')).toBeLessThan(x('n_req'));
    expect(x('n_req')).toBeLessThan(x('n_bff'));
    expect(x('n_bff')).toBeLessThan(x('n_svc'));
    expect(layout.edges.map((laid) => laid.status)).toEqual(['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED']);
    expect(layout.dangling).toBe(1);
  });
});

describe('dashboard — incidents: screens', () => {
  it('menu: an Investigate section with Incidents; the incident page belongs to it', () => {
    const html = renderDashboard(base({ view: 'incidents', projectId: 'prj_books' }, { list: [] }));
    expect(html).toContain('>Investiguer<');
    expect(html).toContain('data-action="nav" data-view="incidents" aria-current="page"');
    expect(activeNav(page('traceability'))).toBe('incidents');
    expect(activeNav({ view: 'incidents', projectId: 'p' })).toBe('incidents');
    // « Investigations » à côté d'« Incidents », dans la même section.
    expect(html).toContain('data-action="nav" data-view="investigations"');
    expect(activeNav({ view: 'investigations', projectId: 'p' })).toBe('investigations');
  });

  it('the list: group tabs with counts, search, ID / title / severity / application / status / creation date', () => {
    const list: IncidentSummary[] = [
      summary({
        id: 'inc_1',
        title: 'Erreur <500>',
        severity: 'CRITICAL',
        state: 'DIAGNOSED',
        diagnosis: 'PROBABLE',
      }),
      summary({
        id: 'inc_2',
        title: 'Timeout API',
        state: 'DRAFT',
        application: 'Commande',
        createdAt: '2026-10-31T08:00:00.000Z',
      }),
      summary({ id: 'inc_3', title: 'Page blanche', state: 'REPRODUCING', severity: 'LOW' }),
    ];
    const html = renderDashboard(base({ view: 'incidents', projectId: 'prj_books' }, { list }));
    expect(html).toContain('<h1>Incidents</h1>');
    expect(html).toContain('Catalogue · 3 incident(s)');
    expect(html).toContain('<button class="btn primary" data-action="inc-new">');
    expect(html).toContain('<span>Nouvel incident</span>');
    // Onglets : Tous, Ouverts, En investigation, Résolus, Fermés, avec leur nombre.
    expect(html).toContain('<div class="tabs inc-l-tabs" role="tablist" aria-label="Afficher :">');
    expect(html).toMatch(
      /id="inc-l-tab-ALL" data-action="inc-group" data-group="ALL" data-index="ALL" aria-selected="true" aria-controls="inc-l-panel" tabindex="0">Tous <span class="inc-l-n"><span aria-hidden="true">3<\/span><span class="sr">3 incident\(s\)<\/span>/,
    );
    for (const [group, text, count] of [
      ['OPEN', 'Ouverts', 1],
      ['INVESTIGATING', 'En investigation', 1],
      ['RESOLVED', 'Résolus', 1],
      ['CLOSED', 'Fermés', 0],
    ] as const)
      expect(html).toMatch(
        new RegExp(
          `data-group="${group}"[^>]*aria-selected="false"[^>]*tabindex="-1">${text} <span class="inc-l-n"><span aria-hidden="true">${String(count)}<`,
        ),
      );
    expect(html).toContain('<div id="inc-l-panel" role="tabpanel" aria-labelledby="inc-l-tab-ALL">');
    // La recherche a un libellé ; le nombre affiché lui est relié.
    expect(html).toContain(
      '<span class="sr">Rechercher un incident (identifiant, titre, application, scénario)</span><input type="search" id="inc-l-q" data-inc="list.query" value="" placeholder="Rechercher un incident…"',
    );
    expect(html).toContain('<p id="inc-l-shown" class="mu inc-l-shown">3 incident(s) affiché(s) sur 3</p>');
    expect(html).toContain('data-action="inc-refresh" aria-label="Actualiser"');
    expect(html).toContain('data-action="inc-export" aria-label="Exporter les lignes affichées (CSV)"');
    for (const col of ['ID', 'Titre', 'Sévérité', 'Application', 'Statut', 'Date de création'])
      expect(html).toContain(`<th scope="col">${col}</th>`);
    // La ligne entière ouvre l'incident ; le titre est le bouton du clavier.
    expect(html).toContain('<tr class="inc-l-row" data-action="inc-open" data-incident="inc_1">');
    expect(html).toContain(
      'data-action="inc-open" data-incident="inc_1" title="Ouvrir l’incident Erreur &lt;500&gt;">Erreur &lt;500&gt;</button>',
    );
    expect(html).toContain(
      '<span class="pill ko inc-sev"><span class="inc-dot inc-dot-critical" aria-hidden="true"></span>Critique</span>',
    );
    expect(html).toContain('<span class="pill ok">Diagnostiqué</span>');
    expect(html).toContain('<td>Commande</td>');
    // Le plus récent d'abord.
    expect(html.indexOf('data-incident="inc_2"')).toBeLessThan(html.indexOf('data-incident="inc_1"'));
    const reader = renderDashboard(
      base({ view: 'incidents', projectId: 'prj_books' }, { list }, role('READER')),
    );
    expect(reader).not.toContain('data-action="inc-new"');
    expect(reader).toContain('Lecture seule');
    const empty = renderDashboard(base({ view: 'incidents', projectId: 'prj_books' }, { list: [] }));
    expect(empty).toContain('Aucun incident déclaré pour ce projet.');
    expect(empty).toMatch(/data-action="inc-export"[^>]*disabled/);
    // Un onglet et une recherche sans résultat : dit, avec le retour à tout.
    const none = renderDashboard(
      base({ view: 'incidents', projectId: 'prj_books' }, { list, group: 'CLOSED', query: 'zzz' }),
    );
    expect(none).toContain('Aucun incident ne correspond à « zzz » dans cet onglet.');
    expect(none).toContain('data-action="inc-list-reset"');
    expect(none).toContain('aria-labelledby="inc-l-tab-CLOSED"');
    // La lecture en échec : dite, avec « Réessayer ».
    const failed = renderDashboard(
      base({ view: 'incidents', projectId: 'prj_books' }, { listError: 'serveur injoignable' }),
    );
    expect(failed).toContain('La liste des incidents n’a pas pu être lue : serveur injoignable');
    expect(failed).toContain('data-action="inc-refresh">Réessayer');
    const loading = renderDashboard(base({ view: 'incidents', projectId: 'prj_books' }));
    expect(loading).toContain('aria-busy="true"');
  });

  it('list helpers: groups of states, search without accents, newest first, CSV without formulas', () => {
    const list: IncidentSummary[] = [
      summary({
        id: 'inc_a',
        title: 'Échec de connexion',
        state: 'FAILED',
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      summary({ id: 'inc_b', title: '=HYPERLINK("x")', state: 'INCONCLUSIVE', application: 'Portail' }),
      summary({
        id: 'inc_c',
        title: 'Erreur',
        state: 'SCOPED',
        scenario: 'Créer un livre',
        createdAt: '2026-10-31T00:00:00.000Z',
      }),
    ];
    expect(groupCounts(list)).toEqual({ ALL: 3, OPEN: 1, INVESTIGATING: 0, RESOLVED: 1, CLOSED: 1 });
    expect(visibleIncidents(list, 'ALL', '').map((row) => row.id)).toEqual(['inc_c', 'inc_b', 'inc_a']);
    expect(visibleIncidents(list, 'CLOSED', '').map((row) => row.id)).toEqual(['inc_a']);
    expect(visibleIncidents(list, 'ALL', 'echec').map((row) => row.id)).toEqual(['inc_a']);
    expect(visibleIncidents(list, 'ALL', 'portail').map((row) => row.id)).toEqual(['inc_b']);
    expect(visibleIncidents(list, 'ALL', 'LIVRE créer').map((row) => row.id)).toEqual(['inc_c']);
    expect(visibleIncidents(list, 'ALL', 'INC_A').map((row) => row.id)).toEqual(['inc_a']);
    expect(visibleIncidents(list, 'OPEN', 'portail')).toEqual([]);
    const csv = incidentsCsv(
      visibleIncidents(list, 'ALL', ''),
      {
        columns: ['ID', 'Titre', 'Sévérité', 'Application', 'Statut', 'Date de création'],
        severities: t.inc.severities,
        states: t.inc.states,
      },
      'fr',
    );
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]).toBe('"ID";"Titre";"Sévérité";"Application";"Statut";"Date de création"');
    expect(lines[2]).toBe(`"inc_b";"'=HYPERLINK(""x"")";"Haute";"Portail";"Inconclusif";"${at}"`);
    expect(lines).toHaveLength(4);
    expect(
      incidentsCsv([], { columns: ['a', 'b', 'c', 'd', 'e', 'f'], severities: {}, states: {} }, 'en'),
    ).toContain('"a","b"');
    expect(applicationSuggestions('Catalogue', list)).toEqual(['Catalogue', 'Portail']);
    expect(applicationSuggestions(undefined)).toEqual([]);
  });

  it('attachments: accepted types and sizes, the count limit, base64 and readable sizes', () => {
    expect(attachmentTypeOf('a.png', 'image/png')).toBe('image/png');
    expect(attachmentTypeOf('server.log', '')).toBe('text/plain');
    expect(attachmentTypeOf('data.json', 'application/octet-stream')).toBe('application/json');
    expect(attachmentTypeOf('capture.JPG', '')).toBe('image/jpeg');
    expect(attachmentTypeOf('script.sh', 'application/x-sh')).toBeUndefined();
    expect(attachmentTypeOf('page.html', 'text/html')).toBeUndefined();
    expect(attachmentTypeOf('vector.svg', 'image/svg+xml')).toBeUndefined();
    const sorted = sortAttachments(MAX_ATTACHMENTS - 1, [
      { name: 'a.png', type: 'image/png', size: 10 },
      { name: 'big.png', type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 },
      { name: 'b.txt', type: 'text/plain', size: 5 },
      { name: 'empty.txt', type: 'text/plain', size: 0 },
      { name: 'x.exe', type: 'application/x-msdownload', size: 5 },
    ]);
    expect(sorted.accepted).toEqual([{ index: 0, type: 'image/png' }]);
    expect(sorted.rejected).toEqual([
      { name: 'big.png', reason: 'size' },
      { name: 'b.txt', reason: 'count' },
      { name: 'empty.txt', reason: 'empty' },
      { name: 'x.exe', reason: 'type' },
    ]);
    expect(base64Of(new TextEncoder().encode('Erreur 500 ✓'))).toBe(
      Buffer.from('Erreur 500 ✓').toString('base64'),
    );
    const large = new Uint8Array(100_000).map((_, index) => index % 251);
    expect(base64Of(large)).toBe(Buffer.from(large).toString('base64'));
    expect(sizeText(512, 'fr')).toBe('512 o');
    expect(sizeText(2048, 'fr')).toBe('2 Kio');
    expect(sizeText(5 * 1024 * 1024, 'fr')).toBe('5,0 Mio');
    expect(sizeText(5 * 1024 * 1024, 'en')).toBe('5.0 MiB');
  });

  it('the creation form: labelled fields, inline errors described, kinds, severity dot, attachments, options', () => {
    const form = { ...emptyIncidentForm(project), target: 'ARO' as const, application: 'x'.repeat(130) };
    const html = renderDashboard(
      base(
        { view: 'incidents', projectId: 'prj_books', create: true },
        {
          list: [summary({ application: 'Portail' })],
          form,
          invalid: ['title', 'application', 'image'],
        },
      ),
    );
    expect(html).toContain(
      '<nav class="inc-cf-crumbs" aria-label="Fil d’Ariane"><ol><li><button type="button" class="lnk" data-action="inc-create-cancel">Incidents</button></li><li aria-current="page">Nouvel incident</li></ol></nav>',
    );
    expect(html).toContain('<h1>Créer un incident</h1>');
    expect(html).toContain('<form class="inc-cf-form inc-form" data-action="inc-create" novalidate>');
    // Chaque champ refusé : aria-invalid, et son message relié par aria-describedby.
    expect(html).toContain(
      '<label class="inc-cf-l" for="inc-f-title">Titre <span aria-hidden="true">*</span></label><div class="inc-cf-c"><input id="inc-f-title" data-inc="title" required aria-required="true" aria-invalid="true" aria-describedby="inc-f-title-e"',
    );
    expect(html).toMatch(/<small id="inc-f-title-e" class="err inc-cf-err">.*Champ obligatoire\./);
    expect(html).toContain(
      'id="inc-f-application" data-inc="application" required aria-required="true" aria-invalid="true" aria-describedby="inc-f-application-e inc-f-application-h"',
    );
    expect(html).toContain('<span>120 caractères au plus.</span>');
    expect(html).toContain('list="inc-f-apps"');
    expect(html).toContain(
      '<datalist id="inc-f-apps"><option value="Catalogue"></option><option value="Portail"></option></datalist>',
    );
    expect(html).toContain('id="inc-f-description" data-inc="description" required aria-required="true"');
    expect(html).toContain('<option value="FUNCTIONAL" selected>Fonctionnel</option>');
    for (const kind of ['Technique', 'Performance', 'Sécurité', 'Données'])
      expect(html).toContain(`>${kind}</option>`);
    expect(html).toContain(
      '<span class="inc-cf-sev inc-cf-sev-medium"><span class="inc-dot inc-dot-medium" aria-hidden="true"></span><select id="inc-f-severity" data-inc="severity"',
    );
    expect(html).toContain('<label class="inc-cf-l" for="inc-f-scenario">Scénario associé</label>');
    expect(html).toContain('<option value="Créer un livre" selected>Créer un livre</option>');
    // Un bloc réutilisable ne mène pas seul à un symptôme.
    expect(html).not.toContain('Bloc connexion');
    expect(html).toContain('Résultat attendu');
    expect(html).toContain('Résultat observé');
    // Les pièces jointes : un vrai sélecteur de fichiers, les types et limites dits.
    expect(html).toContain(
      '<input type="file" id="inc-f-files" class="inc-cf-file" data-inc="files" multiple accept="image/png,image/jpeg,image/webp,text/plain,application/json,.png,.jpg,.jpeg,.webp,.txt,.log,.json" aria-labelledby="inc-f-files-l inc-f-files-b" aria-describedby="inc-f-files-h">',
    );
    expect(html).toContain('10 fichiers au plus, 5,0 Mio chacun. Envoyés après la création.');
    // ARO choisi (ou un champ ARO refusé) : le volet des options est ouvert.
    expect(html).toContain('<details class="inc-cf-opts" open><summary data-action="inc-options-toggle">');
    expect(html).toContain('<option value="env_test" selected>Recette</option>');
    expect(html).toContain('data-inc="target" value="ARO" checked');
    expect(html).toContain(
      'id="inc-f-image" data-inc="image" required aria-required="true" aria-invalid="true"',
    );
    expect(html).toContain('<p class="err" role="alert">');
    expect(html).toContain('3 champ(s) à compléter.');
    expect(html).toContain('data-action="inc-create-cancel">Annuler</button>');
    expect(html).toMatch(
      /<button type="submit" class="btn primary"[^>]*><span>Créer et investiguer<\/span><svg/,
    );
    const local = renderDashboard(
      base(
        { view: 'incidents', projectId: 'prj_books', create: true },
        {
          list: [],
          form: {
            ...emptyIncidentForm(project),
            severity: 'HIGH',
            attachments: [{ name: 'capture <1>.png', type: 'image/png', bytes: 2048, dataBase64: 'AA==' }],
            rejected: [{ name: 'outil.exe', reason: 'type' }],
          },
        },
      ),
    );
    expect(local).not.toContain('data-inc="image"');
    expect(local).toContain('<details class="inc-cf-opts"><summary');
    expect(local).not.toContain('aria-invalid');
    expect(local).toContain('inc-cf-sev-high');
    expect(local).toContain(
      '<span class="inc-cf-att-n" title="capture &lt;1&gt;.png">capture &lt;1&gt;.png</span><small class="mu">2 Kio</small>',
    );
    expect(local).toContain(
      'data-action="inc-att-remove" data-index="0" aria-label="Retirer capture &lt;1&gt;.png"',
    );
    expect(local).toContain(
      '<div class="inc-cf-rej" role="alert"><p class="err"><b>Fichiers écartés</b></p><ul class="plain tight"><li><code>outil.exe</code> — type non accepté</li>',
    );
    // Dix pièces jointes : le sélecteur est désactivé.
    const full = renderDashboard(
      base(
        { view: 'incidents', projectId: 'prj_books', create: true },
        {
          list: [],
          form: {
            ...emptyIncidentForm(project),
            attachments: Array.from({ length: MAX_ATTACHMENTS }, (_, index) => ({
              name: `f${String(index)}.txt`,
              type: 'text/plain' as const,
              bytes: 1,
              dataBase64: 'AA==',
            })),
          },
        },
      ),
    );
    expect(full).toMatch(/data-inc="files"[^>]*disabled>/);
  });

  it('the investigation workspace: compact header, progress, main and sub tabs, panes; cancel is confirmed in the page', () => {
    const incident = incidentOf();
    const html = renderDashboard(base(page('overview'), { incident, ws: wsOf() }));
    expect(html).toContain(
      '<h1 id="ws-ux-title" title="Erreur 500 à la création d’un &lt;livre&gt;">Erreur 500 à la création d’un &lt;livre&gt;</h1>',
    );
    expect(html).toContain('<span class="sr">Gravité : </span>Haute');
    expect(html).toContain(
      '<nav class="ws-ux-stepper ws-ux-stepper-row" aria-label="Progression de l’investigation">',
    );
    expect(html.match(/<li class="ws-ux-sr /g)).toHaveLength(10);
    expect(html).toContain(
      '<div class="tabs ws-ux-tabs" role="tablist" aria-label="Sections de l’investigation"',
    );
    expect(html).toContain(
      'id="ws-ux-tab-overview" data-action="ws-ux-tab" data-tab="overview" aria-selected="true" aria-controls="ws-ux-panel" tabindex="0"',
    );
    for (const tab of ['timeline', 'traceability', 'code', 'diagnosis', 'report'])
      expect(html).toContain(`data-tab="${tab}" aria-selected="false"`);
    expect(html).toContain(
      'id="ws-ux-sub-summary" data-action="ws-ux-sub" data-sub="summary" aria-selected="true"',
    );
    for (const sub of ['scope', 'environment'])
      expect(html).toContain(`data-sub="${sub}" aria-selected="false"`);
    expect(html).toContain(
      '<div id="ws-ux-panel" class="ws-ux-panel ws-body" role="tabpanel" aria-labelledby="ws-ux-sub-summary"',
    );
    // Le contenu de l'onglet et le panneau des détails, côte à côte et redimensionnables.
    expect(html).toContain('data-ws-layout="document"');
    expect(html).toContain('id="ws-pane-content" data-ws-pane="content"');
    expect(html).toContain('id="ws-pane-details" data-ws-pane="details"');
    expect(html).toContain('data-ws-splitter="content-details"');
    expect(html).toContain('<dd>erreur HTTP 500 après Enregistrer</dd>');
    expect(html).toContain('data-action="inc-cancel"');
    // Sans message, ni paragraphe de message ni zone des remarques vide (la zone live est permanente,
    // hors de la partie redessinée : le Dashboard la crée une fois).
    expect(html).not.toContain('inc-live');
    expect(html).not.toContain('class="inc-msg"');
    expect(html).not.toContain('class="ws-notes"');
    const noticed = renderDashboard(
      base(page('overview'), { incident, ws: wsOf(), notice: 'Vérification planifiée.' }),
    );
    expect(noticed).toContain(
      '<div class="ws-notes"><p class="inc-msg"><span>Vérification planifiée.</span></p>',
    );
    expect(noticed).not.toContain('aria-live');
    const confirming = renderDashboard(base(page('overview'), { incident, confirmCancel: true, ws: wsOf() }));
    expect(confirming).toContain('data-action="inc-cancel-yes"');
    expect(confirming).toContain('data-action="inc-cancel-no"');
    const cancelled = renderDashboard(
      base(page('overview'), {
        incident: incidentOf({ state: 'CANCELLED', cancelledFrom: 'REPRODUCED' }),
        ws: wsOf(),
      }),
    );
    expect(cancelled).toContain('data-action="inc-resume"');
    expect(cancelled).not.toContain('data-action="inc-cancel"');
    expect(cancelled).toContain('Investigation annulée à l’état « Reproduit »');
    // Traçabilité : le graphe, le détail, puis les fichiers, le code et les preuves, en panneaux.
    const trace = renderDashboard(base(page('traceability'), { incident, ws: wsOf() }));
    expect(trace).toContain('data-ws-layout="trace"');
    for (const pane of ['primary', 'details', 'tree', 'editor', 'evidence'])
      expect(trace).toContain(`data-ws-pane="${pane}"`);
    expect(trace.match(/class="ws-graph[ "]/g)).toHaveLength(1);
    // Pendant le chargement : l'incident d'une autre page n'est jamais montré.
    const loading = renderDashboard(
      base({ view: 'incident', projectId: 'prj_books', incidentId: 'inc_other' }, { incident }),
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('Erreur 500 à la création');
    // Une lecture refusée (403) ou en échec : dite, avec « Réessayer » pour l'échec.
    const denied = renderDashboard(
      base(
        { view: 'incident', projectId: 'prj_books', incidentId: 'inc_other' },
        { loadError: { message: 'forbidden', denied: true } },
      ),
    );
    expect(denied).toContain('Votre rôle ne permet pas de voir cet incident.');
    expect(denied).not.toContain('data-action="inc-refresh">Réessayer');
    const failed = renderDashboard(
      base(
        { view: 'incident', projectId: 'prj_books', incidentId: 'inc_other' },
        { loadError: { message: 'server down', denied: false } },
      ),
    );
    expect(failed).toContain('<div class="ws-state" role="alert"><p class="err">server down</p>');
    expect(failed).toContain('data-action="inc-refresh">Réessayer</button>');
  });

  it('scope tab: applications, permissions, limits, pending extensions decided with DECIDE, validation issues', () => {
    const incident = incidentOf();
    const html = renderDashboard(
      base(page('scope'), {
        incident,
        ws: wsOf(),
        validation: {
          ok: false,
          issues: [{ field: 'applications[0].repository.root', message: 'does not exist' }],
        },
      }),
    );
    // L'écran « Définition du périmètre » en tête, puis les autres paramètres.
    expect(html).toContain('<h2 id="inc-sc-t" class="fl">Définition du périmètre</h2>');
    expect(html.indexOf('inc-sc-t')).toBeLessThan(html.indexOf('Autres paramètres du périmètre'));
    expect(html).toMatch(/data-action="inc-scope-mode" data-mode="GUIDED"[^>]*aria-checked="true"/);
    expect(html).toContain('data-action="inc-scope-toggle" data-block="bff" data-index=""');
    // Pas encore d'arborescence lue : la lecture est en cours (le contrôleur la lance).
    expect(html).toContain('Lecture des dossiers…');
    expect(html).toContain('Éléments inclus (1)');
    expect(html).toContain('data-action="inc-scope-next"');
    expect(html).toContain('<b>BFF livres</b>');
    expect(html).toContain('<code>/repos/bff</code>');
    expect(html).toContain('<code>BookController</code>');
    expect(html).toContain('<code>POST /api/books</code>');
    expect(html).toContain('<b>Effets de bord</b><span>Refusé</span>');
    expect(html).toContain('<b>Requêtes HTTP directes</b><span>Aucune</span>');
    expect(html).toContain('le controller &lt;BookController&gt; est hors du dossier inclus');
    expect(html).toContain('data-action="inc-ext-approve" data-block="ext_1"');
    expect(html).toContain('data-action="inc-ext-reject" data-block="ext_1"');
    expect(html).toContain(
      '<div role="alert" class="inc-sc-issues"><p class="err"><b>1 problème(s) dans le périmètre</b>',
    );
    expect(html).toContain('data-action="inc-validate"');
    expect(html).toContain('data-action="inc-ext-request"');
    const reader = renderDashboard(base(page('scope'), { incident }, role('READER')));
    expect(reader).toContain('Lecture seule : votre rôle ne permet pas de modifier le périmètre.');
    expect(reader).not.toContain('data-action="inc-scope-next"');
    expect(reader).toContain('data-action="ws-ux-stage" data-stage="environment"');
    expect(reader).not.toContain('data-action="inc-ext-approve"');
    expect(reader).not.toContain('data-action="inc-validate"');
    expect(reader).not.toContain('data-action="inc-ext-request"');
    expect(reader).not.toContain('data-action="inc-cancel"');
    expect(reader).toContain('Décider d’une extension demande le droit de décision.');
    const editing = renderDashboard(base(page('scope'), { incident, scopeForm: scopeFormOf(scope) }));
    expect(editing).toContain('data-action="inc-scope-save"');
    expect(editing).toContain(
      'data-action="inc-app-remove" data-index="0" aria-label="Retirer l’application BFF livres"',
    );
    // La profondeur et le mode se règlent dans l'écran du périmètre, plus dans ce formulaire.
    expect(editing).not.toContain('data-inc="scope.depth"');
    expect(editing).toContain('data-inc="scope.range" min="1" max="5"');
  });

  it('environment tab: LOCAL / REMOTE / ARO selector with the measured capabilities and the save action', () => {
    const incident = incidentOf();
    const html = renderDashboard(
      base(page('environment'), {
        incident,
        ws: wsOf({
          capabilities: {
            target: 'LOCAL',
            playwright: 'LOCAL_PROCESS',
            repositories: 'LOCAL',
            tests: false,
            logs: 'NONE',
            kubernetesJobs: false,
            limitations: ['mvn is not installed'],
          },
        }),
      }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(
      /role="radio" class="ws-ux-target" data-action="ws-ux-target" data-target="LOCAL" aria-checked="true"/,
    );
    expect(html).toContain('data-target="ARO" aria-checked="false"');
    expect(html).toContain('mvn is not installed');
    expect(html).toContain('Configuration sélectionnée : LOCAL');
    expect(html).toContain('data-action="ws-ux-check"');
    expect(html).toContain('data-action="ws-ux-stage" data-stage="reproduction"');
    const dirty = renderDashboard(
      base(page('environment'), { incident, ws: wsOf({ ux: { ...wsOf().ux, target: 'REMOTE' } }) }),
    );
    expect(dirty).toContain('data-action="ws-ux-target-save"');
    const failed = renderDashboard(
      base(page('environment'), { incident, ws: wsOf({ capabilitiesState: { error: 'refused' } }) }),
    );
    expect(failed).toContain('Capacités non lues : refused');
    // Un lecteur voit les cibles, sans enregistrer.
    const reader = renderDashboard(base(page('environment'), { incident, ws: wsOf() }, role('READER')));
    expect(reader).not.toContain('data-action="ws-ux-target-save"');
  });

  it('reproduction from the header: launch with RUN, disabled with its reason, live state while REPRODUCING', () => {
    const html = renderDashboard(base(page('overview'), { incident: incidentOf(), ws: wsOf() }));
    expect(html).toContain('data-action="inc-reproduce"');
    expect(html).toContain('Reproduire de nouveau');
    expect(html).toContain('HTTP 500 observé sur POST /api/books');
    expect(html).toContain('Symptôme observé');
    const running = renderDashboard(
      base(page('overview'), { incident: incidentOf({ state: 'REPRODUCING' }), ws: wsOf() }),
    );
    expect(running).toContain('Reproduction en cours : la page suit son avancement.');
    expect(running).toMatch(/data-action="inc-reproduce"[^>]*disabled/);
    const draft = renderDashboard(
      base(page('overview'), {
        incident: incidentOf({
          state: 'DRAFT',
          investigation: { ...incidentOf().investigation, reproductions: [] },
        }),
        ws: wsOf(),
      }),
    );
    expect(draft).toContain('Reproduire l’incident');
    expect(draft).toMatch(
      /data-action="inc-reproduce"[^>]*disabled[^>]*title="Le périmètre doit d’abord être complet/,
    );
    expect(
      renderDashboard(base(page('overview'), { incident: incidentOf(), ws: wsOf() }, role('READER'))),
    ).not.toContain('data-action="inc-reproduce"');
  });

  it('timeline tab: the unified timeline of the investigation, grouped by step, its request selectable', () => {
    const incident = incidentOf({
      investigation: {
        ...incidentOf().investigation,
        timeline: [
          {
            id: 'rep_1:ACTION:1',
            order: 1,
            at,
            reproduction: 'rep_1',
            step: 1,
            layer: 'FRONTEND',
            kind: 'ACTION',
            status: 'OK',
            summary: 'Cliquer sur Enregistrer',
            evidence: [],
          },
          {
            id: 'rep_1:REQUEST:req_1',
            order: 2,
            at,
            reproduction: 'rep_1',
            step: 1,
            layer: 'NETWORK',
            kind: 'REQUEST',
            status: 'ERROR',
            summary: 'POST /api/books → 500',
            evidence: ['req_1'],
            requestId: 'req_1',
          },
        ],
      },
    });
    const html = renderDashboard(base(page('timeline'), { incident, ws: wsOf() }));
    expect(html.indexOf('Cliquer sur Enregistrer')).toBeLessThan(html.indexOf('POST /api/books → 500'));
    expect(html).toContain('data-action="ws-select" data-kind="event" data-ref="rep_1:REQUEST:req_1"');
    expect(html).toContain('data-kind="request" data-ref="req_1"');
    expect(html).toContain(
      'id="ws-ux-tab-timeline" data-action="ws-ux-tab" data-tab="timeline" aria-selected="true"',
    );
  });

  it('traceability tab: every relation shows its status, with a legend; a static path is never called observed', () => {
    const html = renderDashboard(base(page('traceability'), { incident: incidentOf(), ws: wsOf() }));
    expect(html).toContain('data-ws-graph="canvas"');
    expect(html).toContain('class="ws-graph-edge ws-ge-observed');
    expect(html).toContain('class="ws-graph-edge ws-ge-statically_resolved');
    expect(html).toContain('class="ws-graph-edge ws-ge-inferred');
    expect(html).toContain('<ul class="ws-legend" aria-label="Légende des relations">');
    for (const text of ['Observée', 'Lue dans le code', 'Déduite', 'Inconnue'])
      expect(html).toContain(`<b>${text}</b>`);
    expect(html).toContain('appel dynamique');
    expect(html).toContain('n’est pas une trace d’exécution');
    const none = renderDashboard(
      base(page('traceability'), {
        incident: incidentOf({ investigation: { ...incidentOf().investigation, graph: undefined } }),
        ws: wsOf(),
      }),
    );
    expect(none).toContain('Le graphe apparaît après l’analyse du code de l’incident.');
    expect(none).not.toContain('data-ws-zone="graph"');
  });

  it('code views: the scope tree, the file read from the server in the editor, its line targeted', () => {
    const file = 'src/main/java/org/example/bff/books/BookController.java';
    const incident = incidentOf({
      investigation: {
        ...incidentOf().investigation,
        code: {
          applications: [{ id: 'bff', layer: 'BFF', files: 7, skipped: 1 }],
          symbols: [
            {
              id: `bff:${file}#BookController.create`,
              applicationId: 'bff',
              layer: 'BFF',
              kind: 'ENDPOINT',
              name: 'BookController.create',
              file,
              line: 3,
            },
          ],
          endpoints: [],
          outgoing: [],
          calls: [],
          denied: [{ path: '/repos/bff/.env', reason: 'sensitive file' }],
          truncated: [],
        },
        graph: {
          nodes: [
            ...graph.nodes,
            {
              id: 'n_ctrl',
              kind: 'BFF_ENDPOINT',
              label: 'BookController.create',
              layer: 'BFF',
              evidence: [],
              symbolId: `bff:${file}#BookController.create`,
              source: { applicationId: 'bff', layer: 'BFF', file, line: 3 },
            },
          ],
          edges: graph.edges,
        },
      },
    });
    const view = {
      applicationId: 'bff',
      layer: 'BFF' as const,
      file,
      language: 'java' as const,
      text: 'class BookController {\n  // créer\n  BookView create(CreateBookRequest request) {\n    return service.create(request);\n  }\n}',
      symbols: [],
      highlights: [{ line: 3, kind: 'PATH' as const, reason: 'BookController.create', refs: ['n_ctrl'] }],
    };
    const tree = {
      applications: [
        { applicationId: 'bff', name: 'BFF livres', layer: 'BFF' as const, files: [file], truncated: false },
      ],
      denied: [{ path: '.env', reason: 'sensitive file' }],
    };
    // Le fichier ouvert dans l'éditeur (le contrôleur l'y montre en entrant dans la vue de la couche).
    const code = revealInCode(emptyCodeUi(), { applicationId: 'bff', layer: 'BFF', file, line: 3 }, '');
    const html = renderDashboard(
      base(page('bff'), {
        incident,
        ws: wsOf({ tree, code, sources: { [`bff:${file}`]: { view, revision: incident.revision } } }),
      }),
    );
    expect(html).toContain('data-ws-pane="editor"');
    expect(html).toContain('data-focus="BFF"');
    expect(html).toContain('BookController.java');
    expect(html).toContain('ws-code-target');
    expect(html).toContain('Lecture seule');
    // Lecture refusée par le serveur (403) : panneau « accès refusé », sans contenu.
    const denied = renderDashboard(base(page('bff'), { incident, ws: wsOf({ treeState: 'denied' }) }));
    expect(denied).toContain('Votre rôle ne permet pas de lire le code du périmètre.');
    expect(denied).not.toContain('class BookController');
  });

  it('hypotheses tab: status, confidence, supporting evidence, verifications to plan (RUN only)', () => {
    const html = renderDashboard(
      base(page('hypotheses'), {
        incident: incidentOf(),
        ws: wsOf({ dx: { ...wsOf().dx, expanded: ['hyp_1'] } }),
      }),
    );
    expect(html).toContain('Éditeur absent non validé');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="60"');
    expect(html).toContain('NullPointerException dans la réponse');
    expect(html).toContain('data-action="ws-dx-plan" data-hypothesis="hyp_1" data-index="0"');
    expect(html).toContain('data-action="ws-dx-analyze"');
    const reader = renderDashboard(
      base(
        page('hypotheses'),
        { incident: incidentOf(), ws: wsOf({ dx: { ...wsOf().dx, expanded: ['hyp_1'] } }) },
        role('READER'),
      ),
    );
    expect(reader).not.toContain('data-action="ws-dx-plan"');
    expect(reader).not.toContain('data-action="ws-dx-analyze"');
  });

  it('experiments: side effects need an explicit approval in the page, with RUN_WRITES; refusals show their reason', () => {
    const refused = experiment({
      id: 'exp_2',
      kind: 'INSPECT_LOGS',
      status: 'REFUSED',
      sideEffects: false,
      decisions: [
        {
          allowed: false,
          reason: 'readLogs is not allowed by the scope',
          rule: 'READ_LOG.permission',
          operation: { kind: 'READ_LOG', path: '/var/log/bff.log' },
        },
      ],
    });
    const investigation = { ...incidentOf().investigation, experiments: [experiment(), refused] };
    const incident = incidentOf({ investigation });
    const html = renderDashboard(base(page('experiments'), { incident, ws: wsOf() }));
    expect(html).toContain('data-action="ws-dx-run" data-experiment="exp_1" data-approval="required"');
    expect(html).not.toContain('data-action="ws-dx-approve"');
    expect(html).toContain('readLogs is not allowed by the scope');
    expect(html).not.toContain('data-action="ws-dx-run" data-experiment="exp_2"');
    expect(html).toContain('data-action="ws-dx-plan-submit"');
    // L'analyste (sans RUN_WRITES) voit l'approbation sans pouvoir la donner.
    const approving = wsOf({ dx: { ...wsOf().dx, approving: 'exp_1' } });
    const analyst = renderDashboard(base(page('experiments'), { incident, ws: approving }, role('ANALYST')));
    expect(analyst).toContain('class="ws-dx-approve" role="group"');
    expect(analyst).not.toContain('data-action="ws-dx-approve"');
    const pilot = renderDashboard(base(page('experiments'), { incident, ws: approving }, role('PILOT')));
    expect(pilot).toContain('data-action="ws-dx-approve" data-experiment="exp_1"');
    expect(pilot).toContain('data-action="ws-dx-approve-cancel" data-experiment="exp_1"');
  });

  it('diagnosis and report: a probable cause is never called confirmed; exports through the report route', () => {
    const incident = incidentOf({
      state: 'DIAGNOSED',
      investigation: {
        ...incidentOf().investigation,
        diagnosis: {
          status: 'PROBABLE',
          rootCause: {
            hypothesisId: 'hyp_1',
            statement: 'publisherId vide déréférencé',
            layer: 'BACKEND',
            files: ['CatalogBookService.java'],
          },
          alternatives: [],
          missing: ['un test unitaire qui échoue sans éditeur'],
          recommendations: ['valider publisherId côté BFF'],
          generatedAt: at,
        },
      },
    });
    const diagnosis = renderDashboard(base(page('diagnosis'), { incident, ws: wsOf() }));
    expect(diagnosis).toContain('Cause probable');
    expect(diagnosis).not.toMatch(/Cause racine confirmée/);
    expect(diagnosis).toContain('<b>publisherId vide déréférencé</b>');
    expect(diagnosis).toContain('un test unitaire qui échoue sans éditeur');
    expect(diagnosis).toContain('valider publisherId côté BFF');
    const report = renderDashboard(
      base(page('report'), { incident, ws: wsOf({ reportState: { error: 'not found' } }) }),
    );
    expect(report).toContain('data-action="ws-dx-export" data-format="json"');
    expect(report).toContain('data-action="ws-dx-export" data-format="markdown"');
    expect(report).toContain('not found');
  });

  it('non-regression: never "Réussi" without a real execution; accept needs PUBLISH, reject DECIDE', () => {
    const proposal = {
      name: 'Non-régression — Erreur 500',
      basedOn: 'Créer un livre',
      flowYaml: 'flows:\n  - name: "Non-régression"\n',
      expected: 'le livre est créé',
      status: 'PROPOSED' as const,
    };
    const without = incidentOf({ investigation: { ...incidentOf().investigation, regression: proposal } });
    const html = renderDashboard(base(page('regression'), { incident: without, ws: wsOf() }, role('PILOT')));
    expect(html).toContain('data-verdict="NOT_RUN"');
    expect(html).not.toContain('Réussi');
    expect(html).toContain('data-action="ws-dx-regression" data-op="run"');
    expect(html).toContain('data-action="ws-dx-regression" data-op="accept"');
    expect(html).toContain('data-action="ws-dx-regression" data-op="reject"');
    expect(html).toContain('flows:\n  - name: &quot;Non-régression&quot;');
    const analyst = renderDashboard(
      base(page('regression'), { incident: without, ws: wsOf() }, role('ANALYST')),
    );
    // Sans le droit PUBLISH, « Ajouter au catalogue » reste visible mais désactivé, avec sa raison.
    expect(analyst).toMatch(/data-op="accept" disabled aria-describedby="ws-dx-rt-why"/);
    expect(analyst).toContain('data-op="reject"');
    expect(analyst).not.toMatch(/data-op="reject" disabled/);
    const failed = incidentOf({
      investigation: {
        ...incidentOf().investigation,
        regression: { ...proposal, execution: { run: 'run-9', passed: false, at } },
      },
    });
    const failedHtml = renderDashboard(base(page('regression'), { incident: failed, ws: wsOf() }));
    expect(failedHtml).toContain('data-verdict="FAILED"');
    expect(failedHtml).not.toContain('Réussi');
    const passed = incidentOf({
      investigation: {
        ...incidentOf().investigation,
        regression: { ...proposal, execution: { run: 'run-9', passed: true, at } },
      },
    });
    expect(renderDashboard(base(page('regression'), { incident: passed, ws: wsOf() }))).toContain(
      'data-verdict="PASSED"',
    );
  });

  it('every screen exists in English too', () => {
    const en = dashboardStrings('en');
    const html = renderDashboard({
      ...base(page('traceability'), { incident: incidentOf(), ws: wsOf() }),
      t: en,
    });
    expect(html).toContain('>Investigate<');
    expect(html).toContain('>Investigations<');
    expect(html).toContain('Relation legend');
    expect(html).toContain('Read in the code');
    expect(html).toContain('Selection detail');
  });
});

describe('dashboard — incidents: controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const fakeRoot = { querySelector: () => null, activeElement: null } as unknown as ShadowRoot;
  const element = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement;

  function setup(state: DashboardState, incidents: Partial<QaCrawlerClient['incidents']>) {
    // Les dépôts connus (bloc « Applications et dépôts ») : lus à l'ouverture du périmètre, jamais résolus ici.
    const defaults = { knownRepositories: () => new Promise<never>(() => undefined) };
    const api = { incidents: { ...defaults, ...incidents } } as unknown as QaCrawlerClient;
    let paints = 0;
    const host = {
      root: fakeRoot,
      api: () => api,
      paint: () => {
        paints += 1;
      },
      navigate: (route: DashboardRoute) => {
        controller.leave(route);
        state.route = route;
      },
      refresh: () => Promise.resolve(),
    };
    Object.defineProperty(host, 'state', { get: () => state });
    const controller = new IncidentsController(host as unknown as IncidentsHost);
    return { controller, paints: () => paints };
  }

  it('follows a reproduction until its state changes, then stops; leaving the page stops the following', async () => {
    vi.useFakeTimers();
    const running = incidentOf({ state: 'REPRODUCING', revision: 5 });
    const answers = [running, incidentOf({ state: 'REPRODUCED', revision: 6 })];
    const get = vi.fn((_projectId: string, _incidentId: string) =>
      Promise.resolve(answers.shift() ?? running),
    );
    const state = base(page('overview'));
    const { controller } = setup(state, { get });
    await controller.load({ incidents: { get } } as unknown as QaCrawlerClient, state.route, () => true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(controller.polling).toBe(true);
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS);
    expect(get).toHaveBeenCalledTimes(2);
    expect(state.inc?.incident?.state).toBe('REPRODUCED');
    expect(state.inc?.notice).toBe('Reproduction terminée : Reproduit.');
    expect(controller.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS * 3);
    expect(get).toHaveBeenCalledTimes(2);

    // Une autre reproduction suivie, puis la page quittée : plus aucune lecture.
    const again = vi.fn(() => Promise.resolve(incidentOf({ state: 'REPRODUCING' })));
    const state2 = base(page('overview'));
    const second = setup(state2, { get: again });
    await second.controller.load(
      { incidents: { get: again } } as unknown as QaCrawlerClient,
      state2.route,
      () => true,
    );
    expect(second.controller.polling).toBe(true);
    const leaving: DashboardRoute = { view: 'incidents', projectId: 'prj_books' };
    second.controller.leave(leaving);
    state2.route = leaving;
    expect(second.controller.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(INCIDENT_POLL_MS * 3);
    expect(again).toHaveBeenCalledTimes(1);
    expect(state2.inc?.incident).toBeUndefined();
  });

  it('a side-effect experiment waits for the approval in the page; only RUN_WRITES approves', async () => {
    const investigation = { ...incidentOf().investigation, experiments: [experiment()] };
    const incident = incidentOf({ investigation });
    const done = incidentOf({
      revision: 5,
      investigation: {
        ...investigation,
        experiments: [experiment({ status: 'DONE', approvedBy: 'pilote', outcome: 'SUPPORTS' })],
      },
    });
    const runExperiment = vi.fn(() => Promise.resolve(done));
    const state = base(page('experiments'), { incident, ws: wsOf() }, role('PILOT'));
    const { controller } = setup(state, { runExperiment });
    controller.click('ws-dx-run', element({ experiment: 'exp_1', approval: 'required' }));
    expect(state.inc?.ws.dx.approving).toBe('exp_1');
    expect(runExperiment).not.toHaveBeenCalled();
    controller.click('ws-dx-approve', element({ experiment: 'exp_1' }));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(runExperiment).toHaveBeenCalledWith('prj_books', incident.id, 'exp_1', { approve: true });
    expect(state.inc?.ws.dx.approving).toBeUndefined();
    expect(state.inc?.ws.dx.busy).toBeUndefined();
    expect(state.inc?.notice).toBe('Vérification : Terminée.');

    // Sans RUN_WRITES : l'approbation n'est pas envoyée.
    const analystRun = vi.fn(() => Promise.resolve(done));
    const analystState = base(page('experiments'), { incident, ws: wsOf() }, role('ANALYST'));
    const analyst = setup(analystState, { runExperiment: analystRun });
    analyst.controller.click('ws-dx-run', element({ experiment: 'exp_1', approval: 'required' }));
    analyst.controller.click('ws-dx-approve', element({ experiment: 'exp_1' }));
    expect(analystRun).not.toHaveBeenCalled();
  });

  it('an experiment without side effects runs on click; a server refusal is said at its place', async () => {
    const plain = experiment({ id: 'exp_3', kind: 'REPLAY', status: 'PROPOSED', sideEffects: false });
    const incident = incidentOf({ investigation: { ...incidentOf().investigation, experiments: [plain] } });
    const runExperiment = vi.fn(() =>
      Promise.reject(
        new QaCrawlerError({
          error: 'the experiment budget is exhausted',
          status: 422,
          code: 'REFUSED',
          details: ['maxExperiments: 20'],
        }),
      ),
    );
    const state = base(page('experiments'), { incident, ws: wsOf() });
    const { controller } = setup(state, { runExperiment });
    controller.click('ws-dx-run', element({ experiment: 'exp_3' }));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(runExperiment).toHaveBeenCalledWith('prj_books', incident.id, 'exp_3');
    expect(state.inc?.ws.dx.errors['experiment:exp_3']).toBe('the experiment budget is exhausted');
    expect(renderDashboard(state)).toContain(
      '<div class="err-box ws-dx-err" role="alert"><p class="err">the experiment budget is exhausted</p>',
    );
  });

  it('saving the scope sends the read revision; a 409 re-reads the incident and says so', async () => {
    const incident = incidentOf();
    const fresh = incidentOf({ revision: 9 });
    const update = vi.fn(() =>
      Promise.reject(new QaCrawlerError({ error: 'stale revision', status: 409, code: 'CONFLICT' })),
    );
    const get = vi.fn(() => Promise.resolve(fresh));
    const state = base(page('scope'), { incident, scopeForm: { ...scopeFormOf(scope), depth: '5' } });
    const { controller } = setup(state, { update, get });
    controller.submit({ dataset: { action: 'inc-scope-save' } } as unknown as HTMLFormElement);
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(update).toHaveBeenCalledWith('prj_books', incident.id, 4, {
      scope: expect.objectContaining({ depth: 5, permissions: scope.permissions }) as unknown,
    });
    expect(state.inc?.error).toBe(t.inc.conflict);
    expect(state.inc?.incident?.revision).toBe(9);
    // Le brouillon reste : la modification peut être refaite sur la nouvelle version.
    expect(state.inc?.scopeForm?.depth).toBe('5');
  });

  it('declaring: missing fields are marked without calling the server; a valid form creates and opens the incident', async () => {
    const created = incidentOf({ id: 'inc_new', state: 'DRAFT' });
    const create = vi.fn(() => Promise.resolve(created));
    const state = base(
      { view: 'incidents', projectId: 'prj_books', create: true },
      { list: [], form: emptyIncidentForm(project) },
    );
    const { controller } = setup(state, { create });
    controller.submit({ dataset: { action: 'inc-create' } } as unknown as HTMLFormElement);
    expect(create).not.toHaveBeenCalled();
    expect(state.inc?.invalid).toEqual(['title', 'description', 'application', 'expected', 'observed']);
    const form = state.inc?.form;
    if (!form) throw new Error('form expected');
    controller.input({ dataset: { inc: 'title' }, value: 'Erreur 500' } as unknown as HTMLInputElement);
    controller.input({
      dataset: { inc: 'description' },
      value: 'Après Enregistrer',
    } as unknown as HTMLInputElement);
    controller.input({ dataset: { inc: 'application' }, value: 'Catalogue' } as unknown as HTMLInputElement);
    controller.input({ dataset: { inc: 'kind' }, value: 'TECHNICAL' } as unknown as HTMLInputElement);
    controller.input({ dataset: { inc: 'observed' }, value: 'HTTP 500' } as unknown as HTMLInputElement);
    controller.input({ dataset: { inc: 'expected' }, value: 'créé' } as unknown as HTMLInputElement);
    controller.submit({ dataset: { action: 'inc-create' } } as unknown as HTMLFormElement);
    await vi.waitFor(() => {
      expect(state.route.view).toBe('incident');
    });
    expect(create).toHaveBeenCalledWith(
      'prj_books',
      expect.objectContaining({
        title: 'Erreur 500',
        description: 'Après Enregistrer',
        application: 'Catalogue',
        kind: 'TECHNICAL',
        scenario: 'Créer un livre',
        execution: { target: 'LOCAL' },
      }),
    );
    expect(state.route).toEqual({
      view: 'incident',
      projectId: 'prj_books',
      incidentId: 'inc_new',
      tab: 'scope',
    });
    expect(state.inc?.notice).toBe('Incident « Erreur 500 à la création d’un <livre> » déclaré.');
  });

  it('the list: group tabs (click and arrow keys), search, reset, a failed read said with retry', async () => {
    const list = [
      summary({ id: 'inc_1', state: 'DRAFT', title: 'Timeout API' }),
      summary({ id: 'inc_2', state: 'DIAGNOSED', title: 'Erreur 500' }),
    ];
    const state = base({ view: 'incidents', projectId: 'prj_books' }, { list });
    const { controller, paints } = setup(state, {});
    controller.click('inc-group', element({ group: 'RESOLVED' }));
    expect(state.inc?.group).toBe('RESOLVED');
    controller.click('inc-group', element({ group: 'NOPE' }));
    expect(state.inc?.group).toBe('RESOLVED');
    const key = (name: string) => {
      let prevented = false;
      const handled = controller.keydown({
        key: name,
        target: { dataset: { action: 'inc-group' } },
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as KeyboardEvent);
      return { handled, prevented };
    };
    expect(key('ArrowRight')).toEqual({ handled: true, prevented: true });
    expect(state.inc?.group).toBe('CLOSED');
    key('Home');
    expect(state.inc?.group).toBe('ALL');
    expect(key('a').handled).toBe(false);
    const before = paints();
    controller.input({ dataset: { inc: 'list.query' }, value: 'timeout' } as unknown as HTMLInputElement);
    expect(state.inc?.query).toBe('timeout');
    expect(paints()).toBe(before + 1);
    expect(renderDashboard(state)).toContain('1 incident(s) affiché(s) sur 2');
    if (state.inc) state.inc.group = 'CLOSED';
    controller.click('inc-list-reset', element({}));
    expect(state.inc?.group).toBe('ALL');
    expect(state.inc?.query).toBe('');

    const failing = vi.fn(() => Promise.reject(new Error('serveur injoignable')));
    const failedState = base({ view: 'incidents', projectId: 'prj_books' });
    const failed = setup(failedState, { list: failing });
    await failed.controller.load(
      { incidents: { list: failing } } as unknown as QaCrawlerClient,
      failedState.route,
      () => true,
    );
    expect(failedState.inc?.listError).toBe('serveur injoignable');
    expect(renderDashboard(failedState)).toContain(
      'La liste des incidents n’a pas pu être lue : serveur injoignable',
    );
  });

  it('exports the shown rows as a CSV file downloaded by the page', () => {
    const list = [summary({ id: 'inc_1', title: 'Erreur 500', application: 'Catalogue' })];
    const state = base({ view: 'incidents', projectId: 'prj_books' }, { list });
    const clicked: { href: string; download: string }[] = [];
    const link = {
      href: '',
      download: '',
      hidden: false,
      click: () => clicked.push({ href: link.href, download: link.download }),
      remove: vi.fn(),
    };
    const root = {
      querySelector: () => null,
      activeElement: null,
      ownerDocument: { createElement: () => link, body: { append: vi.fn() } },
    } as unknown as ShadowRoot;
    const blobs: Blob[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:csv';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const host = {
      root,
      api: () => ({}) as QaCrawlerClient,
      paint: () => undefined,
      navigate: () => undefined,
      refresh: () => Promise.resolve(),
    };
    Object.defineProperty(host, 'state', { get: () => state });
    const controller = new IncidentsController(host as unknown as IncidentsHost);
    controller.click('inc-export', element({}));
    expect(create).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.href).toBe('blob:csv');
    expect(clicked[0]?.download).toMatch(/^incidents-prj_books-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(blobs[0]?.type).toBe('text/csv;charset=utf-8');
    expect(state.inc?.notice).toMatch(/^1 incident\(s\) exporté\(s\) : incidents-prj_books-/);
    vi.restoreAllMocks();
  });

  it('declaring with attachments: created, then each attachment sent; a refused one is said, the others go on', async () => {
    const created = incidentOf({ id: 'inc_new', state: 'DRAFT' });
    const create = vi.fn(() => Promise.resolve(created));
    const addAttachment = vi.fn((_p: string, _i: string, input: { name: string }) =>
      input.name === 'bad.png'
        ? Promise.reject(
            new QaCrawlerError({ error: 'content is not a PNG image', status: 422, code: 'INVALID' }),
          )
        : Promise.resolve(created),
    );
    const form = {
      ...emptyIncidentForm(project),
      title: 'Erreur 500',
      description: 'Après Enregistrer',
      application: 'Catalogue',
      observed: 'HTTP 500',
      expected: 'créé',
      attachments: [
        { name: 'bad.png', type: 'image/png' as const, bytes: 3, dataBase64: 'AAAA' },
        { name: 'server.log', type: 'text/plain' as const, bytes: 3, dataBase64: 'b2sK' },
      ],
    };
    const state = base({ view: 'incidents', projectId: 'prj_books', create: true }, { list: [], form });
    const { controller } = setup(state, { create, addAttachment });
    controller.submit({ dataset: { action: 'inc-create' } } as unknown as HTMLFormElement);
    await vi.waitFor(() => {
      expect(state.route.view).toBe('incident');
    });
    expect(addAttachment).toHaveBeenNthCalledWith(1, 'prj_books', 'inc_new', {
      name: 'bad.png',
      type: 'image/png',
      dataBase64: 'AAAA',
    });
    expect(addAttachment).toHaveBeenNthCalledWith(2, 'prj_books', 'inc_new', {
      name: 'server.log',
      type: 'text/plain',
      dataBase64: 'b2sK',
    });
    expect(state.inc?.notice).toBe(
      'Incident « Erreur 500 à la création d’un <livre> » déclaré. 1 pièce(s) jointe(s) envoyée(s).',
    );
    expect(state.inc?.error).toBe(
      '1 pièce(s) jointe(s) non envoyée(s) : l’incident est créé, les raisons suivent.',
    );
    expect(state.inc?.details).toEqual(['bad.png : content is not a PNG image']);
  });

  it('chosen files are sorted, read and kept until creation; one can be removed', async () => {
    const state = base(
      { view: 'incidents', projectId: 'prj_books', create: true },
      { list: [], form: emptyIncidentForm(project) },
    );
    const { controller } = setup(state, {});
    const files = [
      new File(['Erreur 500'], 'server.log', { type: '' }),
      new File(['x'], 'tool.exe', { type: 'application/x-msdownload' }),
      new File([new Uint8Array([137, 80, 78, 71])], 'capture.png', { type: 'image/png' }),
    ];
    const input = { dataset: { inc: 'files' }, files, value: 'C:\\fakepath\\server.log' };
    expect(controller.input(input as unknown as HTMLInputElement)).toBe(true);
    controller.change(input as unknown as HTMLInputElement);
    await vi.waitFor(() => {
      expect(state.inc?.form?.attachments).toHaveLength(2);
    });
    expect(input.value).toBe('');
    expect(state.inc?.form?.attachments).toEqual([
      {
        name: 'server.log',
        type: 'text/plain',
        bytes: 10,
        dataBase64: Buffer.from('Erreur 500').toString('base64'),
      },
      { name: 'capture.png', type: 'image/png', bytes: 4, dataBase64: 'iVBORw==' },
    ]);
    expect(state.inc?.form?.rejected).toEqual([{ name: 'tool.exe', reason: 'type' }]);
    controller.click('inc-att-remove', element({ index: '0' }));
    expect(state.inc?.form?.attachments.map((file) => file.name)).toEqual(['capture.png']);
    // Le volet des options garde son état d'un dessin à l'autre.
    controller.click('inc-options-toggle', {
      dataset: {},
      parentElement: { open: false },
    } as unknown as HTMLElement);
    expect(state.inc?.form?.optionsOpen).toBe(true);
  });

  it('scope screen: trees read per application, folders toggled, « Étape suivante » saves, checks and opens Environnement', async () => {
    const incident = incidentOf({ state: 'SCOPED' });
    const saved = incidentOf({ state: 'SCOPED', revision: 5 });
    const tree = {
      applicationId: 'bff',
      root: {
        path: '',
        name: 'bff',
        included: true,
        children: [{ path: 'src', name: 'src', included: true, children: [] }],
      },
    };
    const scopeTree = vi.fn(() => Promise.resolve(tree));
    const update = vi.fn(() => Promise.resolve(saved));
    const validateScope = vi.fn(() => Promise.resolve({ ok: true, issues: [] }));
    const capabilities = vi.fn(() => new Promise<never>(() => undefined));
    const state = base(page('scope'), { incident, ws: wsOf() });
    const { controller } = setup(state, { scopeTree, update, validateScope, capabilities });
    controller.beforePaint();
    expect(scopeTree).toHaveBeenCalledWith('prj_books', incident.id, 'bff');
    expect(state.inc?.scopeTrees.bff).toEqual({ state: 'loading', root: '/repos/bff' });
    await vi.waitFor(() => {
      expect(state.inc?.scopeTrees.bff?.tree).toEqual(tree);
    });
    controller.beforePaint();
    expect(scopeTree).toHaveBeenCalledTimes(1);
    expect(renderDashboard(state)).toContain(
      'data-action="inc-scope-toggle" data-block="bff" data-index="src"',
    );

    controller.click('inc-scope-toggle', element({ block: 'bff', index: '' }));
    expect(state.inc?.scope.selection.bff).toEqual({ whole: true, paths: [] });
    controller.click('inc-scope-mode', element({ mode: 'MANUAL' }));
    controller.input({
      dataset: { inc: 'scope.range' },
      value: '5',
      setAttribute: vi.fn(),
    } as unknown as HTMLInputElement);
    controller.input({
      dataset: { inc: 'scope.limit.memory' },
      value: '2048',
    } as unknown as HTMLInputElement);
    expect(state.inc?.scope).toMatchObject({ mode: 'MANUAL', depth: 5, limits: { memory: '2048' } });
    controller.click('inc-scope-next', element({}));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(update).toHaveBeenCalledWith('prj_books', incident.id, 4, {
      scope: expect.objectContaining({
        mode: 'MANUAL',
        depth: 5,
        limits: expect.objectContaining({ maxMemoryMb: 2048 }) as unknown,
        applications: [
          expect.objectContaining({ repository: expect.objectContaining({ include: [] }) as unknown }),
        ],
        permissions: scope.permissions,
      }) as unknown,
    });
    expect(validateScope).toHaveBeenCalledWith('prj_books', incident.id);
    expect(state.inc?.incident?.revision).toBe(5);
    expect(state.inc?.scope.selection).toEqual({});
    expect(state.route).toMatchObject({ view: 'incident', tab: 'environment' });
    expect(state.inc?.notice).toBe('Périmètre enregistré.');
  });

  it('applications and repositories: known repositories read once, a repository analyzed, applications checked and added; extensions once started', async () => {
    const incident = incidentOf({ state: 'SCOPED' });
    const saved = incidentOf({ state: 'SCOPED', revision: 4 });
    const discovered = (id: string, layer: 'FRONTEND' | 'BFF', suggested: boolean) => ({
      application: { id, name: id, layer, repository: { root: `/repos/mono/apps/${id}`, include: [] } },
      path: `apps/${id}`,
      frameworks: [layer === 'FRONTEND' ? 'Angular' : 'NestJS'],
      languages: ['TypeScript'],
      modules: [],
      entryPoints: [],
      configs: [],
      services: [],
      confidence: 'HIGH' as const,
      evidence: [`apps/${id}/package.json : paquet Node`],
      questions: [],
      relevance: suggested ? 1 : 0,
      reasons: [],
      suggested,
    });
    const result = {
      root: '/repos/mono',
      status: 'OK' as const,
      structure: 'MONOREPO' as const,
      tools: ['Nx'],
      applications: [discovered('web', 'FRONTEND', true), discovered('api', 'BFF', false)],
      relations: [],
      problems: [],
      denied: [],
      truncated: [],
      keywords: ['livre'],
      read: ['package.json'],
      discoveredAt: at,
      durationMs: 320,
    };
    const knownRepositories = vi.fn(() =>
      Promise.resolve({
        repositories: [{ root: '/repos/mono', label: 'Mono (Autre)', source: 'INCIDENT' as const }],
      }),
    );
    const discoverScope = vi.fn(() => Promise.resolve(result));
    const update = vi.fn(() => Promise.resolve(saved));
    const requestExtension = vi.fn(() => Promise.resolve(saved));
    const scopeTree = vi.fn(() => new Promise<never>(() => undefined));
    const state = base(page('scope'), { incident, ws: wsOf() });
    const { controller } = setup(state, {
      knownRepositories,
      discoverScope,
      update,
      requestExtension,
      scopeTree,
    });
    controller.beforePaint();
    expect(knownRepositories).toHaveBeenCalledWith('prj_books', incident.id);
    await vi.waitFor(() => {
      expect(state.inc?.discovery.known).toHaveLength(1);
    });
    controller.beforePaint();
    expect(knownRepositories).toHaveBeenCalledTimes(1);
    expect(renderDashboard(state)).toContain('data-action="inc-disc-known" data-root="/repos/mono"');
    // Un chemin vide ne part jamais au serveur.
    controller.submit({ dataset: { action: 'inc-disc-run' } } as unknown as HTMLFormElement);
    expect(discoverScope).not.toHaveBeenCalled();
    // Un dépôt connu : analysé d'un clic ; les applications proposées sont cochées.
    controller.click('inc-disc-known', element({ root: '/repos/mono' }));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(discoverScope).toHaveBeenCalledWith('prj_books', incident.id, '/repos/mono');
    expect(state.inc?.discovery.result).toEqual(result);
    expect(state.inc?.discovery.selected).toEqual({ web: true, api: false });
    const html = renderDashboard(state);
    expect(html).toContain('2 application(s) détectée(s), 1 proposée(s) pour cet incident');
    expect(html).toContain('Ajouter 1 application(s) au périmètre');
    // Cocher l'autre, corriger sa couche, ajouter : le périmètre complété d'un seul envoi, permissions gardées.
    controller.change({ dataset: { inc: 'disc.app.api' }, value: 'on' } as unknown as HTMLInputElement);
    controller.change({
      dataset: { inc: 'disc.layer.api' },
      value: 'BACKEND',
    } as unknown as HTMLSelectElement);
    expect(state.inc?.discovery.selected).toEqual({ web: true, api: true });
    controller.click('inc-disc-apply', element({}));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(update).toHaveBeenCalledWith('prj_books', incident.id, incident.revision, {
      scope: expect.objectContaining({
        applications: [
          expect.objectContaining({ id: 'bff' }),
          expect.objectContaining({ id: 'web', layer: 'FRONTEND' }),
          expect.objectContaining({ id: 'api', layer: 'BACKEND' }),
        ],
        permissions: scope.permissions,
      }) as unknown,
    });
    expect(state.inc?.notice).toBe('2 application(s) ajoutée(s) au périmètre.');
    expect(state.inc?.discovery.result).toBeUndefined();
    expect(state.inc?.incident?.revision).toBe(4);

    // L'investigation commencée : le chemin saisi, analysé ; l'ajout devient une demande d'extension à décider.
    const started = incidentOf({ state: 'INVESTIGATING', revision: 7 });
    const startedState = base(page('scope'), { incident: started, ws: wsOf() });
    const second = setup(startedState, {
      knownRepositories,
      discoverScope,
      update,
      requestExtension,
      scopeTree,
    });
    second.controller.input({
      dataset: { inc: 'disc.root' },
      value: ' /repos/mono ',
    } as unknown as HTMLInputElement);
    second.controller.submit({ dataset: { action: 'inc-disc-run' } } as unknown as HTMLFormElement);
    await vi.waitFor(() => {
      expect(startedState.inc?.discovery.result).toBeDefined();
    });
    expect(discoverScope).toHaveBeenLastCalledWith('prj_books', started.id, '/repos/mono');
    expect(renderDashboard(startedState)).toContain('Demander l’extension du périmètre (1)');
    second.controller.click('inc-disc-apply', element({}));
    await vi.waitFor(() => {
      expect(startedState.inc?.busy).toBeUndefined();
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(requestExtension).toHaveBeenCalledWith('prj_books', started.id, {
      kind: 'ADD_APPLICATION',
      target: 'FRONTEND:/repos/mono/apps/web',
      applicationId: 'web',
      reason: 'Découverte automatique de « /repos/mono » : web',
    });
    expect(startedState.inc?.notice).toBe(
      '1 extension(s) du périmètre demandée(s) : chacune attend une décision.',
    );
  });

  it('scope screen: refused drafts never reach the server; issues of the check keep the page on the scope', async () => {
    const incident = incidentOf({ state: 'SCOPED' });
    const update = vi.fn(() => Promise.resolve(incident));
    const validateScope = vi.fn(() =>
      Promise.resolve({
        ok: false,
        issues: [{ field: 'applications[0].repository.root', message: 'introuvable' }],
      }),
    );
    const scopeTree = vi.fn(() =>
      Promise.reject(new QaCrawlerError({ error: 'forbidden', status: 403, code: 'FORBIDDEN' })),
    );
    const state = base(page('scope'), { incident, ws: wsOf() });
    const { controller } = setup(state, { update, validateScope, scopeTree });
    controller.beforePaint();
    await vi.waitFor(() => {
      expect(state.inc?.scopeTrees.bff?.state).toBe('denied');
    });
    // Toute l'application décochée : rien n'est envoyé, la case est signalée.
    controller.click('inc-scope-toggle', element({ block: 'bff', index: 'src/main/java' }));
    controller.click('inc-scope-toggle', element({ block: 'bff', index: '' }));
    controller.click('inc-scope-toggle', element({ block: 'bff', index: '' }));
    expect(state.inc?.scope.selection.bff).toEqual({ whole: false, paths: [] });
    controller.click('inc-scope-next', element({}));
    expect(update).not.toHaveBeenCalled();
    expect(state.inc?.scope.invalid).toEqual(['app:bff']);
    controller.click('inc-scope-reset', element({}));
    expect(state.inc?.scope.selection).toEqual({});
    // Rien de modifié : la vérification seule ; ses problèmes restent affichés sur le périmètre.
    controller.click('inc-scope-next', element({}));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(update).not.toHaveBeenCalled();
    expect(validateScope).toHaveBeenCalledTimes(1);
    expect(state.route).toMatchObject({ tab: 'scope' });
    expect(renderDashboard(state)).toContain('<code>applications[0].repository.root</code> introuvable');
    // Un lecteur : « Étape suivante » navigue seulement (rendu en ws-ux-stage), un clic de brouillon ne change rien.
    const readerState = base(page('scope'), { incident, ws: wsOf() }, role('READER'));
    const reader = setup(readerState, { update });
    reader.controller.click('inc-scope-toggle', element({ block: 'bff', index: '' }));
    expect(readerState.inc?.scope.selection).toEqual({});
  });
});
