import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import { describe, expect, it } from 'vitest';
import type {
  Environment,
  ExecutionDetail,
  ExecutionRecord,
  GraphView,
  ProjectDetail,
  RecordingSnapshot,
  RunComparisonView,
  ScenarioHistoryView,
} from '../../src/sdk/core/contracts.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { environmentForm, environmentInputOf, scenarioTag } from '../../src/sdk/ui/dashboard-ops.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
/**
 * LES ÉCRANS D'EXPLOITATION DU DASHBOARD (fonctions pures) : historique et comparaison, scénarios
 * (stabilité, promotion), environnements (formulaire, secrets par leur nom, suppression confirmée),
 * explorations (carte, anomalies par gravité). L'élément dans Chromium : sdk-dashboard (intégration).
 */
const at = '2026-10-27T10:00:00.000Z';
const t = dashboardStrings('fr');

const recette: Environment = {
  id: 'env_1',
  name: 'Recette',
  kind: 'TEST',
  baseUrl: 'http://127.0.0.2:9',
  allowedDomains: ['127.0.0.2'],
  secretEnv: ['QA_PASSWORD'],
  variables: { QA_LOCALE: 'fr' },
  mutations: { enabled: true, maxPerRun: 5 },
  limits: { maxStates: 40 },
  createdAt: at,
  updatedAt: at,
};

const project: ProjectDetail = {
  id: 'prj_a',
  name: 'Shop',
  targetUrl: 'http://127.0.0.1:9/app',
  framework: 'vue',
  createdAt: at,
  status: 'PROJECT_CREATED',
  state: 'ACTIVE',
  counts: { environments: 1, scenarios: 2, recordings: 2, executions: 3 },
  draft: {} as ProjectDetail['draft'],
  environments: [recette],
  scenarios: [
    { name: 'checkout', file: 'checkout.flow.yaml', format: 'yaml', steps: 3 },
    { name: 'search', file: 'search/search.flow.yaml', format: 'yaml', steps: 4, fromRecording: 'search' },
  ],
};

const record = (
  run: string,
  kind: ExecutionRecord['kind'],
  verdict: ExecutionRecord['verdict'],
): ExecutionRecord => ({
  run,
  projectId: 'prj_a',
  kind,
  createdAt: at,
  verdict,
  durationMs: 3100,
  flows: { total: 1, passed: verdict === 'PASSED' ? 1 : 0, failed: verdict === 'PASSED' ? 0 : 1 },
  issues: 1,
  environment: { id: 'env_1', name: 'Recette' },
});

const executions = [
  record('run-3', 'REPLAY', 'FAILED'),
  record('run-2', 'REPLAY', 'PASSED'),
  record('run-1', 'EXPLORATION', 'NO_FLOW'),
];

const base = (extra: Partial<DashboardState> = {}): DashboardState => ({
  t,
  phase: 'ready',
  route: { view: 'overview' },
  days: 7,
  showArchived: false,
  launch: { kind: 'REPLAY', environmentId: '', scenarios: [], busy: false },
  projectId: 'prj_a',
  menuOpen: false,
  checks: {},
  cancellation: true,
  picked: [],
  severity: 'ALL',
  req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
  signIn: false,
  access: emptyAccessUi(),
  recs: emptyRecordingsUi(),
  lib: emptyLibraryUi(),
  tst: emptyTestsUi(),
  project,
  executions,
  ...extra,
});

const comparison: RunComparisonView = {
  base: { run: 'run-2', at },
  head: { run: 'run-3', at },
  flows: [
    {
      name: 'checkout',
      presence: 'BOTH',
      baseStatus: 'PASSED',
      headStatus: 'FAILED',
      verdict: 'CHANGED',
      durationDeltaMs: 600,
      changes: [{ kind: 'STEP_STATUS', step: 4, detail: '<b>Save</b> PASSED → FAILED' }],
    },
  ],
  requirements: [],
  traceability: { base: false, head: false },
  summary: {
    flows: 1,
    changed: 1,
    same: 0,
    onlyBase: 0,
    onlyHead: 0,
    newlyFailing: ['checkout'],
    newlyPassing: [],
    requirementsChanged: 0,
  },
};

describe('dashboard — history and comparison', () => {
  it('ticks two executions and shows the comparison: regressions, escaped differences, replay of the failures', () => {
    const route = { view: 'history', projectId: 'prj_a' } as const;
    expect(renderDashboard(base({ route }))).toContain('Cochez deux exécutions du même projet.');
    const html = renderDashboard(base({ route, picked: ['run-3', 'run-2'], comparison }));
    expect(html).toContain('value="run-3" checked');
    expect(html).toContain('run-2 (avant) → run-3 (maintenant)');
    expect(html).toContain('régression(s) : réussi avant, échoué maintenant');
    expect(html).toContain('&lt;b&gt;Save&lt;/b&gt; PASSED → FAILED');
    expect(html).toContain('+0.6 s');
    expect(html).toContain('data-action="replay-failed"');
    expect(activeNav(route)).toBe('history');
    expect(renderDashboard(base({ route, picked: ['run-3', 'run-2'], comparing: true }))).toContain(
      'Comparaison…',
    );
  });
});

describe('dashboard — scenarios', () => {
  const history: ScenarioHistoryView[] = [
    {
      name: 'checkout',
      runs: [
        { run: 'run-3', at, status: 'FAILED', durationMs: 900 },
        { run: 'run-2', at, status: 'PASSED', durationMs: 800 },
        { run: 'run-1', at, status: 'FAILED', durationMs: 850 },
      ],
      passed: 1,
      failed: 2,
      flips: 2,
    },
  ];
  const recordings = [
    { name: 'search', status: 'COMPLETED', summary: { name: 'search', steps: 4 } },
    { name: 'basket', status: 'STORED', summary: { name: 'basket', steps: 6 } },
    { name: 'live', status: 'RECORDING' },
  ] as RecordingSnapshot[];

  it('tags: unstable from two flips, never replayed without runs, else the last status', () => {
    expect(scenarioTag(history[0])).toBe('FLAKY');
    expect(scenarioTag(undefined)).toBe('NEVER');
    expect(scenarioTag({ ...history[0], flips: 1 } as ScenarioHistoryView)).toBe('FAILED');
  });

  it('lists the scenarios with their stability, and only the recordings still to promote', () => {
    const route = { view: 'scenarios', projectId: 'prj_a', scenario: 'checkout' } as const;
    const html = renderDashboard(base({ route, scenarioHistory: history, recordings }));
    expect(html).toContain('>Instable<');
    expect(html).toContain('>Jamais rejoué<');
    expect(html).toContain('1 réussi(s) sur 3');
    expect(html).toContain('Derniers runs, du plus récent au plus ancien : Échouée, Réussie, Échouée');
    expect(html).toContain('Instable : 2 bascule(s) réussi ↔ échoué sur les 3 derniers runs');
    expect(html).toContain('data-action="promote" data-recording="basket"');
    expect(html).not.toContain('data-recording="search"');
    expect(html).not.toContain('data-recording="live"');
    expect(html).toContain('data-action="replay-scenario" data-name="checkout"');
    expect(html).toContain('2 scénario(s) · 1 enregistrement(s) à promouvoir');
  });
});

describe('dashboard — environments', () => {
  it('the form round-trips an environment; a variable line without "=" is refused before sending', () => {
    const form = environmentForm(recette);
    expect(form).toMatchObject({ id: 'env_1', domains: '127.0.0.2', secrets: 'QA_PASSWORD', maxPerRun: '5' });
    const converted = environmentInputOf(form, t);
    expect(converted).toEqual({
      input: {
        name: 'Recette',
        kind: 'TEST',
        baseUrl: 'http://127.0.0.2:9',
        allowedDomains: ['127.0.0.2'],
        variables: { QA_LOCALE: 'fr' },
        secretEnv: ['QA_PASSWORD'],
        limits: { maxStates: 40 },
        mutations: { enabled: true, maxPerRun: 5 },
      },
    });
    expect(environmentInputOf({ ...form, variables: 'NOPE' }, t)).toEqual({
      error: 'Ligne de variable invalide : NOPE (attendu NOM=valeur)',
    });
    const readOnly = environmentInputOf({ ...form, writes: false }, t);
    expect('input' in readOnly && readOnly.input.mutations).toEqual({ enabled: false });
  });

  it('edits an environment: secret names only, a check result, deletion confirmed in the page', () => {
    const route = { view: 'environments', projectId: 'prj_a', environmentId: 'env_1' } as const;
    const envForm = environmentForm(recette);
    const html = renderDashboard(
      base({
        route,
        envForm,
        envCheck: {
          ok: true,
          issues: [],
          secrets: { QA_PASSWORD: false },
          url: { format: { ok: true }, reachable: { ok: true, durationMs: 12 } },
        },
      }),
    );
    expect(html).toContain('Modifier « Recette »');
    expect(html).toContain('data-field="secrets" value="QA_PASSWORD"');
    expect(html).toContain('QA_PASSWORD absent du serveur');
    expect(html).toContain('>Pas prêt<');
    expect(html).toContain('data-action="env-remove"');
    expect(html).not.toContain('data-action="env-remove-confirm"');
    expect(renderDashboard(base({ route, envForm, confirm: 'remove-env' }))).toContain(
      'data-action="env-remove-confirm"',
    );
    const creating = renderDashboard(
      base({
        route: { view: 'environments', projectId: 'prj_a', environmentId: 'new' },
        envForm: environmentForm(),
      }),
    );
    expect(creating).toContain('Nouvel environnement');
    expect(creating).not.toContain('data-action="env-remove"');
  });
});

describe('dashboard — explorations', () => {
  const detail = {
    ...record('run-1', 'EXPLORATION', 'NO_FLOW'),
    stopReason: 'exhausted',
    flowsDetail: [],
    reports: { html: 'index.html' },
    issuesList: [
      {
        id: 'i1',
        severity: 'CRITICAL',
        type: 'http-500',
        message: 'Réponse 500',
        pageUrl: 'http://127.0.0.1:9/item/1',
      },
      {
        id: 'i2',
        severity: 'WARNING',
        type: 'a11y',
        message: 'Champ sans libellé',
        pageUrl: 'http://127.0.0.1:9/',
      },
    ],
  } as ExecutionDetail;
  const graph: GraphView = {
    rootId: 's0',
    nodes: [
      { id: 's0', label: 'Accueil', route: '/', title: 'Accueil', depth: 0 },
      { id: 's1', label: 'Fiche', route: '/item/1', title: 'Fiche', depth: 1 },
    ],
    edges: [
      { from: 's0', to: 's1', action: 'click « Fiche »', type: 'click', result: 'NAVIGATED' },
      { from: 's0', to: 's0', action: 'click « Payer »', type: 'click', result: 'BLOCKED' },
    ],
  };

  it('lists only the explorations of the project', () => {
    const html = renderDashboard(base({ route: { view: 'explorations', projectId: 'prj_a' } }));
    expect(html).toContain('data-action="open-exploration" data-run="run-1"');
    expect(html).not.toContain('data-run="run-2"');
  });

  it('opens one: the map from its graph (start, issues per screen, blocked actions), issues by severity', () => {
    const route = { view: 'explorations', projectId: 'prj_a', run: 'run-1' } as const;
    const html = renderDashboard(base({ route, explored: detail, graph }));
    expect(html).toContain('<span class="tag-s">Départ</span>');
    expect(html).toContain('click « Fiche » → Fiche');
    expect(html).toContain('click « Payer » · bloquée par la politique de sécurité');
    expect(html).toContain('1 anomalie(s)');
    expect(html).toContain('1 bloquée(s)');
    expect(html).toContain('Toutes (2)');
    const critical = renderDashboard(base({ route, explored: detail, graph, severity: 'CRITICAL' }));
    expect(critical).toContain('Réponse 500');
    expect(critical).not.toContain('Champ sans libellé');
    expect(renderDashboard(base({ route, explored: detail }))).toContain('Aucune carte enregistrée');
  });
});
