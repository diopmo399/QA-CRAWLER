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
  canReproduce,
  emptyApplicationForm,
  emptyIncidentForm,
  emptyIncidentsUi,
  graphLayout,
  incidentFormProblems,
  incidentInputOf,
  needsPolling,
  parseParams,
  regressionVerdict,
  scopeFormOf,
  scopeOf,
  shortRef,
  type IncidentsUi,
} from '../../src/sdk/ui/dashboard-incidents.js';
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
 * déclaration, la page d'un incident par onglets (périmètre et extensions, reproduction, graphe et
 * statuts des relations, vérifications et approbation explicite, non-régression jamais « réussie »
 * sans exécution), les droits (un lecteur voit sans agir), le suivi d'une reproduction en cours.
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
  it('shortens an evidence id to its file or symbol, the full id staying in the tooltip', () => {
    expect(
      shortRef(
        'catalog:src/main/java/org/example/catalog/books/CatalogBookService.java#CatalogBookService.register',
      ),
    ).toBe('CatalogBookService.register');
    expect(shortRef('front:src/books/books-api.ts')).toBe('books-api.ts');
    expect(shortRef('req_3')).toBe('req_3');
  });

  it('the declaration form: required fields, ARO details, LOCAL/REMOTE/ARO execution config', () => {
    const form = emptyIncidentForm(project);
    expect(form.scenario).toBe('Créer un livre');
    expect(form.environmentId).toBe('env_test');
    expect(incidentFormProblems(form)).toEqual(['title', 'observed', 'expected']);
    const filled = { ...form, title: ' T ', observed: 'HTTP 500', expected: 'créé' };
    expect(incidentFormProblems(filled)).toEqual([]);
    expect(incidentInputOf(filled)).toMatchObject({ title: 'T', execution: { target: 'LOCAL' } });
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

  it('parameters, reproduction availability, polling and the regression verdict', () => {
    expect(
      parseParams(
        'field=publisherId\nexpect=missing\nretries=2\nflag=true\npatterns=NullPointerException|/catalog\nbad',
      ),
    ).toEqual({
      field: 'publisherId',
      expect: 'missing',
      retries: 2,
      flag: true,
      patterns: ['NullPointerException', '/catalog'],
    });
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
    const layout = graphLayout(graph);
    const x = (id: string): number => layout.nodes.find((node) => node.id === id)?.x ?? -1;
    expect(x('n_inc')).toBeLessThan(x('n_req'));
    expect(x('n_req')).toBeLessThan(x('n_bff'));
    expect(x('n_bff')).toBeLessThan(x('n_svc'));
    expect(layout.edges.map((edge) => edge.status)).toEqual(['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED']);
    expect(layout.dangling).toBe(1);
  });
});

describe('dashboard — incidents: screens', () => {
  it('menu: an Investigate section with Incidents; the incident page belongs to it', () => {
    const html = renderDashboard(base({ view: 'incidents', projectId: 'prj_books' }, { list: [] }));
    expect(html).toContain('>Investiguer<');
    expect(html).toContain('data-action="nav" data-view="incidents" aria-current="page"');
    expect(activeNav(page('graph'))).toBe('incidents');
    expect(activeNav({ view: 'incidents', projectId: 'p' })).toBe('incidents');
  });

  it('the list: escaped titles, severity, state, target and diagnosis; declaring needs the RUN right', () => {
    const list = [
      {
        id: 'inc_1',
        title: 'Erreur <500>',
        severity: 'CRITICAL' as const,
        state: 'DIAGNOSED' as const,
        scenario: 'Créer un livre',
        target: 'ARO' as const,
        updatedAt: at,
        diagnosis: 'PROBABLE' as const,
      },
    ];
    const html = renderDashboard(base({ view: 'incidents', projectId: 'prj_books' }, { list }));
    expect(html).toContain('<h1>Incidents</h1>');
    expect(html).toContain('Catalogue · 1 incident(s)');
    expect(html).toContain('data-action="inc-open" data-incident="inc_1">Erreur &lt;500&gt;</button>');
    expect(html).toContain('<span class="pill ko">Critique</span>');
    expect(html).toContain('<span class="pill ok">Diagnostiqué</span>');
    expect(html).toContain('Azure Red Hat OpenShift');
    expect(html).toContain('<span class="pill warn">Probable</span>');
    expect(html).toContain('data-action="inc-new"');
    const reader = renderDashboard(
      base({ view: 'incidents', projectId: 'prj_books' }, { list }, role('READER')),
    );
    expect(reader).not.toContain('data-action="inc-new"');
    expect(reader).toContain('Lecture seule');
    expect(renderDashboard(base({ view: 'incidents', projectId: 'prj_books' }, { list: [] }))).toContain(
      'Aucun incident déclaré pour ce projet.',
    );
  });

  it('the declaration form: labelled fields, library scenarios only, project environments, targets; errors on submit', () => {
    const form = { ...emptyIncidentForm(project), target: 'ARO' as const };
    const html = renderDashboard(
      base(
        { view: 'incidents', projectId: 'prj_books', create: true },
        { list: [], form, invalid: ['title', 'image'] },
      ),
    );
    expect(html).toContain('<form class="col inc-form" data-action="inc-create" novalidate>');
    expect(html).toMatch(
      /<label class="field" for="inc-f-title">Titre <span aria-hidden="true">\*<\/span><input id="inc-f-title" data-inc="title" required aria-required="true" aria-invalid="true"/,
    );
    expect(html).toContain('<option value="Créer un livre" selected>Créer un livre</option>');
    // Un bloc réutilisable ne mène pas seul à un symptôme.
    expect(html).not.toContain('Bloc connexion');
    expect(html).toContain('<option value="env_test" selected>Recette</option>');
    expect(html).toContain('data-inc="target" value="ARO" checked');
    expect(html).toContain(
      'id="inc-f-image" data-inc="image" required aria-required="true" aria-invalid="true"',
    );
    expect(html).toContain('<p class="err" role="alert">Les champs marqués * sont obligatoires.</p>');
    const local = renderDashboard(
      base(
        { view: 'incidents', projectId: 'prj_books', create: true },
        { list: [], form: emptyIncidentForm(project) },
      ),
    );
    expect(local).not.toContain('data-inc="image"');
    expect(local).not.toContain('role="alert"');
  });

  it('the incident page: header, accessible tabs, the symptom; cancel is confirmed in the page', () => {
    const incident = incidentOf();
    const html = renderDashboard(base(page('scope'), { incident }));
    expect(html).toContain(
      'Erreur 500 à la création d’un &lt;livre&gt; <span class="pill warn">Reproduit</span>',
    );
    expect(html).toContain(
      '<div class="tabs inc-tabs" role="tablist" aria-label="Étapes de l’investigation">',
    );
    expect(html).toContain(
      '<button role="tab" id="inc-tab-scope" data-action="inc-tab" data-tab="scope" aria-selected="true" aria-controls="inc-panel" tabindex="0">Périmètre <span class="inc-count">1</span></button>',
    );
    expect(html).toContain('id="inc-tab-graph" data-action="inc-tab" data-tab="graph" aria-selected="false"');
    expect(html).toContain('<div id="inc-panel" role="tabpanel" aria-labelledby="inc-tab-scope"');
    expect(html).toContain('<dd>erreur HTTP 500 après Enregistrer</dd>');
    expect(html).toContain('data-action="inc-cancel"');
    expect(html).toContain('<p class="inc-live" role="status" aria-live="polite">');
    const confirming = renderDashboard(base(page('scope'), { incident, confirmCancel: true }));
    expect(confirming).toContain('data-action="inc-cancel-yes"');
    expect(confirming).toContain('data-action="inc-cancel-no"');
    const cancelled = renderDashboard(base(page('scope'), { incident: incidentOf({ state: 'CANCELLED' }) }));
    expect(cancelled).toContain('data-action="inc-resume"');
    expect(cancelled).not.toContain('data-action="inc-cancel"');
    // Pendant le chargement : l'incident d'une autre page n'est jamais montré.
    const loading = renderDashboard(
      base({ view: 'incident', projectId: 'prj_books', incidentId: 'inc_other' }, { incident }),
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('Erreur 500 à la création');
  });

  it('scope tab: applications, permissions, limits, pending extensions decided with DECIDE, validation issues', () => {
    const incident = incidentOf();
    const html = renderDashboard(
      base(page('scope'), {
        incident,
        validation: {
          ok: false,
          issues: [{ field: 'applications[0].repository.root', message: 'does not exist' }],
        },
      }),
    );
    expect(html).toContain('<b>BFF livres</b>');
    expect(html).toContain('<code>/repos/bff</code>');
    expect(html).toContain('<code>BookController</code>');
    expect(html).toContain('<code>POST /api/books</code>');
    expect(html).toContain('Guidé');
    expect(html).toContain('<b>Effets de bord</b><span>Refusé</span>');
    expect(html).toContain('<b>Requêtes HTTP directes</b><span>Aucune</span>');
    expect(html).toContain('le controller &lt;BookController&gt; est hors du dossier inclus');
    expect(html).toContain('data-action="inc-ext-approve" data-block="ext_1"');
    expect(html).toContain('data-action="inc-ext-reject" data-block="ext_1"');
    expect(html).toContain('<div role="alert"><p class="err"><b>1 problème(s) dans le périmètre</b>');
    expect(html).toContain('data-action="inc-validate"');
    expect(html).toContain('data-action="inc-ext-request"');
    const reader = renderDashboard(base(page('scope'), { incident }, role('READER')));
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
    expect(editing).toContain('data-inc="scope.depth" type="number" min="1" max="5"');
  });

  it('environment tab: the target and the capabilities read from the server, limitations said', () => {
    const incident = incidentOf();
    const html = renderDashboard(
      base(page('environment'), {
        incident,
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
    );
    expect(html).toContain('<b>Local</b>');
    expect(html).toContain('Recette <code>http://books.test/</code>');
    expect(html).toContain('<dt>Tests</dt><dd>Indisponible</dd>');
    expect(html).toContain('mvn is not installed');
    const failed = renderDashboard(base(page('environment'), { incident, capabilitiesError: 'refused' }));
    expect(failed).toContain('<section class="card" role="alert">');
  });

  it('reproduction tab: launch with RUN, live state while REPRODUCING, actions and requests with their correlation', () => {
    const html = renderDashboard(base(page('reproduction'), { incident: incidentOf() }));
    expect(html).toContain('data-action="inc-reproduce"');
    expect(html).toContain('Reproduire de nouveau');
    expect(html).toContain('<span class="pill warn">Symptôme observé</span>');
    expect(html).toContain('HTTP 500 observé sur POST /api/books');
    expect(html).toContain('Cliquer sur Enregistrer');
    expect(html).toContain('<tr class="inc-ko"><td><code>POST /api/books</code>');
    expect(html).toContain('<span class="pill ok">Observée</span>');
    expect(html).toContain('{&quot;status&quot;:500,&quot;message&quot;:&quot;Catalog error&quot;}');
    const running = renderDashboard(
      base(page('reproduction'), { incident: incidentOf({ state: 'REPRODUCING' }) }),
    );
    expect(running).toContain('Reproduction en cours : la page suit son avancement.');
    expect(running).toMatch(/data-action="inc-reproduce"[^>]*disabled/);
    const draft = renderDashboard(
      base(page('reproduction'), {
        incident: incidentOf({
          state: 'DRAFT',
          investigation: { ...incidentOf().investigation, reproductions: [] },
        }),
      }),
    );
    expect(draft).toContain('Le périmètre doit d’abord être complet');
    expect(
      renderDashboard(base(page('reproduction'), { incident: incidentOf() }, role('READER'))),
    ).not.toContain('data-action="inc-reproduce"');
  });

  it('timeline tab: the ordered evidence of the report and the incident log', () => {
    const incident = incidentOf();
    const html = renderDashboard(
      base(page('timeline'), {
        incident,
        report: {
          version: 1,
          generatedAt: at,
          incident,
          environment: { execution: incident.execution },
          scope,
          timeline: [
            { at, step: 1, kind: 'ACTION', summary: 'Cliquer sur Enregistrer', ref: 'act_1' },
            { at, step: 1, kind: 'REQUEST', summary: 'POST /api/books → 500', ref: 'req_1' },
          ],
          requests: reproduction.requests,
          code: { files: [], symbols: [], denied: [], truncated: [] },
          hypotheses: [],
          experiments: [],
          limitations: [],
        },
      }),
    );
    expect(html).toContain('<ol class="inc-timeline">');
    expect(html.indexOf('Cliquer sur Enregistrer')).toBeLessThan(html.indexOf('POST /api/books → 500'));
    expect(html).toContain('étape 1');
    expect(html).toContain('Journal de l’incident');
    expect(html).toContain('incident déclaré');
  });

  it('graph tab: every relation shows its status, with a legend; a static path is never called observed', () => {
    const html = renderDashboard(base(page('graph'), { incident: incidentOf() }));
    expect(html).toContain('role="img" aria-labelledby="inc-graph-desc"');
    expect(html).toContain(
      '4 nœud(s), 4 relation(s) : 1 observée(s), 1 lue(s) dans le code, 1 déduite(s), 1 inconnue(s).',
    );
    expect(html).toContain('class="edge e-obs"');
    expect(html).toContain('class="edge e-stat"');
    expect(html).toContain('class="edge e-inf"');
    expect(html).toContain('<ul class="inc-legend" aria-label="Légende des relations">');
    for (const text of ['Observée', 'Lue dans le code', 'Déduite', 'Inconnue'])
      expect(html).toContain(`<b>${text}</b>`);
    expect(html).toContain('<span class="pill live">Lue dans le code</span>');
    expect(html).toContain('n_repo (absent du graphe)');
    expect(html).toContain('appel dynamique');
    expect(html).toContain('n’est pas une trace d’exécution');
    const none = renderDashboard(
      base(page('graph'), {
        incident: incidentOf({ investigation: { ...incidentOf().investigation, graph: undefined } }),
      }),
    );
    expect(none).toContain('Le graphe apparaît après l’analyse');
  });

  it('code tab: symbols by layer, endpoints, outgoing calls with status, scope refusals', () => {
    const incident = incidentOf({
      investigation: {
        ...incidentOf().investigation,
        code: {
          applications: [{ id: 'bff', layer: 'BFF', files: 7, skipped: 1 }],
          symbols: [
            {
              id: 'bff:BookController.java#BookController.create',
              applicationId: 'bff',
              layer: 'BFF',
              kind: 'ENDPOINT',
              name: 'BookController.create',
              file: 'src/main/java/org/example/bff/books/BookController.java',
              line: 21,
            },
          ],
          endpoints: [
            { applicationId: 'bff', layer: 'BFF', method: 'POST', path: '/api/books', symbolId: 's' },
          ],
          outgoing: [
            {
              applicationId: 'bff',
              layer: 'BFF',
              symbolId: 's',
              method: 'POST',
              path: '/catalog/books',
              status: 'INFERRED',
              file: 'CatalogClient.java',
              line: 14,
            },
          ],
          calls: [],
          denied: [{ path: '/repos/bff/.env', reason: 'sensitive file' }],
          truncated: [],
        },
      },
    });
    const html = renderDashboard(base(page('code'), { incident }));
    expect(html).toContain('BFF · 1 symbole(s) dans 1 fichier(s)');
    expect(html).toContain('<code>src/main/java/org/example/bff/books/BookController.java:21</code>');
    expect(html).toContain('<code>POST /catalog/books</code> <span class="pill warn">Déduite</span>');
    expect(html).toContain('<code>/repos/bff/.env</code> sensitive file');
    expect(html).toContain('7 fichier(s) lu(s), 1 ignoré(s)');
  });

  it('hypotheses tab: status, confidence, supporting evidence, verifications to plan (RUN only)', () => {
    const html = renderDashboard(base(page('hypotheses'), { incident: incidentOf() }));
    expect(html).toContain('Éditeur absent non validé');
    expect(html).toContain(
      '<meter min="0" max="1" low="0.34" high="0.67" optimum="1" value="0.6" aria-label="Confiance">60 %</meter>',
    );
    expect(html).toContain('Preuves favorables (1)');
    expect(html).toContain('NullPointerException dans la réponse');
    expect(html).toContain('Preuves contraires (0)');
    expect(html).toContain('data-action="inc-plan" data-block="hyp_1" data-index="0"');
    expect(html).toContain('data-action="inc-analyze"');
    const reader = renderDashboard(base(page('hypotheses'), { incident: incidentOf() }, role('READER')));
    expect(reader).not.toContain('data-action="inc-plan"');
    expect(reader).not.toContain('data-action="inc-analyze"');
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
    const html = renderDashboard(base(page('experiments'), { incident }));
    expect(html).toContain('data-action="inc-run" data-block="exp_1"');
    expect(html).toContain('Examiner avant d’exécuter');
    expect(html).not.toContain('data-action="inc-approve-yes"');
    expect(html).toContain('readLogs is not allowed by the scope');
    expect(html).toContain('1 opération(s) refusée(s) par le périmètre');
    expect(html).not.toContain('data-action="inc-run" data-block="exp_2"');
    // L'analyste (sans RUN_WRITES) voit l'approbation sans pouvoir la donner.
    const analyst = renderDashboard(
      base(page('experiments'), { incident, approving: 'exp_1' }, role('ANALYST')),
    );
    expect(analyst).toContain('role="group" aria-labelledby="inc-ap-exp_1"');
    expect(analyst).not.toContain('data-action="inc-approve-yes"');
    expect(analyst).toContain('Approuver demande le droit de permettre les écritures.');
    const pilot = renderDashboard(base(page('experiments'), { incident, approving: 'exp_1' }, role('PILOT')));
    expect(pilot).toContain('data-action="inc-approve-yes" data-block="exp_1"');
    expect(pilot).toContain('Le périmètre n’autorise pas encore les effets de bord');
    expect(pilot).toContain('data-action="inc-approve-no" data-block="exp_1"');
    expect(html).toContain('data-action="inc-plan-form"');
  });

  it('diagnosis and report: root cause, what is missing; exports through the report route', () => {
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
    const diagnosis = renderDashboard(base(page('diagnosis'), { incident }));
    expect(diagnosis).toContain('<span class="pill warn">Probable</span>');
    expect(diagnosis).toContain('<b>publisherId vide déréférencé</b>');
    expect(diagnosis).toContain('un test unitaire qui échoue sans éditeur');
    expect(diagnosis).toContain('valider publisherId côté BFF');
    const report = renderDashboard(base(page('report'), { incident, reportError: 'not found' }));
    expect(report).toContain('data-action="inc-export-json"');
    expect(report).toContain('data-action="inc-export-markdown"');
    expect(report).toContain('<p class="err" role="alert">not found</p>');
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
    const html = renderDashboard(base(page('regression'), { incident: without }, role('PILOT')));
    expect(html).toContain('Pas encore exécuté');
    expect(html).not.toContain('Réussi');
    expect(html).toContain('data-action="inc-reg-run"');
    expect(html).toContain('data-action="inc-reg-accept"');
    expect(html).toContain('data-action="inc-reg-reject"');
    expect(html).toContain('flows:\n  - name: &quot;Non-régression&quot;');
    const analyst = renderDashboard(base(page('regression'), { incident: without }, role('ANALYST')));
    expect(analyst).not.toContain('data-action="inc-reg-accept"');
    expect(analyst).toContain('data-action="inc-reg-reject"');
    const failed = incidentOf({
      investigation: {
        ...incidentOf().investigation,
        regression: { ...proposal, execution: { run: 'run-9', passed: false, at } },
      },
    });
    const failedHtml = renderDashboard(base(page('regression'), { incident: failed }));
    expect(failedHtml).toContain('<span class="pill ko">Échoué</span>');
    expect(failedHtml).not.toContain('Réussi');
    const passed = incidentOf({
      investigation: {
        ...incidentOf().investigation,
        regression: { ...proposal, execution: { run: 'run-9', passed: true, at } },
      },
    });
    expect(renderDashboard(base(page('regression'), { incident: passed }))).toContain(
      '<span class="pill ok">Réussi</span>',
    );
  });

  it('every screen exists in English too', () => {
    const en = dashboardStrings('en');
    const html = renderDashboard({ ...base(page('graph'), { incident: incidentOf() }), t: en });
    expect(html).toContain('>Investigate<');
    expect(html).toContain('Relations legend');
    expect(html).toContain('Read in the code');
  });
});

describe('dashboard — incidents: controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const fakeRoot = { querySelector: () => null, activeElement: null } as unknown as ShadowRoot;
  const element = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement;

  function setup(state: DashboardState, incidents: Partial<QaCrawlerClient['incidents']>) {
    const api = { incidents } as unknown as QaCrawlerClient;
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
    const state = base(page('reproduction'));
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
    const state2 = base(page('reproduction'));
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

  it('a side-effect verification waits for the approval in the page; only RUN_WRITES approves', async () => {
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
    const state = base(page('experiments'), { incident }, role('PILOT'));
    const { controller } = setup(state, { runExperiment });
    controller.click('inc-run', element({ block: 'exp_1' }));
    expect(state.inc?.approving).toBe('exp_1');
    expect(runExperiment).not.toHaveBeenCalled();
    controller.click('inc-approve-yes', element({ block: 'exp_1' }));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(runExperiment).toHaveBeenCalledWith('prj_books', incident.id, 'exp_1', { approve: true });
    expect(state.inc?.approving).toBeUndefined();
    expect(state.inc?.notice).toBe('Vérification : Terminée.');

    // Sans RUN_WRITES : l'approbation n'est pas envoyée.
    const analystRun = vi.fn(() => Promise.resolve(done));
    const analystState = base(page('experiments'), { incident }, role('ANALYST'));
    const analyst = setup(analystState, { runExperiment: analystRun });
    analyst.controller.click('inc-run', element({ block: 'exp_1' }));
    analyst.controller.click('inc-approve-yes', element({ block: 'exp_1' }));
    expect(analystRun).not.toHaveBeenCalled();
  });

  it('a verification without side effects runs on click; a server refusal is said in the page', async () => {
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
    const state = base(page('experiments'), { incident });
    const { controller } = setup(state, { runExperiment });
    controller.click('inc-run', element({ block: 'exp_3' }));
    await vi.waitFor(() => {
      expect(state.inc?.busy).toBeUndefined();
    });
    expect(runExperiment).toHaveBeenCalledWith('prj_books', incident.id, 'exp_3');
    expect(state.inc?.error).toBe('the experiment budget is exhausted');
    expect(state.inc?.details).toEqual(['maxExperiments: 20']);
    expect(renderDashboard(state)).toContain(
      '<div class="err-box" role="alert"><p class="err"><b>the experiment budget is exhausted</b>',
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
    expect(state.inc?.invalid).toEqual(['title', 'observed', 'expected']);
    const form = state.inc?.form;
    if (!form) throw new Error('form expected');
    controller.input({ dataset: { inc: 'title' }, value: 'Erreur 500' } as unknown as HTMLInputElement);
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
});
