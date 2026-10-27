import { describe, expect, it } from 'vitest';
import type {
  ExecutionDetail,
  ExplorationSnapshot,
  OverviewView,
  ProjectDetail,
} from '../../src/sdk/core/contracts.js';
import { PASS_RATE_DEFINITION } from '../../src/sdk/server/platform.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import {
  KNOWN_PASS_RATE_DEFINITION,
  liveSteps,
  renderDashboard,
  type DashboardState,
} from '../../src/sdk/ui/dashboard-view.js';

/**
 * LE RENDU DU DASHBOARD (fonctions pures) : chiffres du SDK tels quels, taux avec numérateur,
 * dénominateur et exclusions, échappement, secrets jamais affichés, actions confirmées dans la page,
 * annulation seulement quand le serveur l'offre. L'élément dans Chromium avec le vrai moteur :
 * tests/integration/sdk-dashboard.test.ts.
 */
const at = '2026-10-27T10:00:00.000Z';

const base = (extra: Partial<DashboardState> = {}): DashboardState => ({
  t: dashboardStrings('fr'),
  phase: 'ready',
  route: { view: 'overview' },
  days: 7,
  showArchived: false,
  launch: { environmentId: '', scenarios: [], busy: false },
  cancellation: true,
  ...extra,
});

const overview: OverviewView = {
  generatedAt: at,
  period: { days: 7, from: at, to: at },
  projects: { active: 2, archived: 1 },
  scenarios: 3,
  recordings: 1,
  executions: { total: 5, byKind: { REPLAY: 4, EXPLORATION: 1 } },
  replays: { finished: 3, passed: 2, failed: 1, passRate: 2 / 3, definition: PASS_RATE_DEFINITION },
  issues: { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 1 },
  recent: [
    {
      run: 'run-b',
      projectId: 'prj_a',
      projectName: '<b>Shop</b>',
      kind: 'REPLAY',
      createdAt: at,
      verdict: 'CANCELLED',
      flows: { total: 1, passed: 0, failed: 0 },
      issues: 0,
    },
  ],
  alerts: [
    {
      kind: 'EXECUTION_FAILED',
      message: 'Shop: the last execution failed',
      projectName: 'Shop',
      projectId: 'prj_a',
      run: 'run-a',
    },
  ],
  trend: [{ day: '2026-10-27', passed: 2, failed: 1 }],
};

const project: ProjectDetail = {
  id: 'prj_a',
  name: 'Shop',
  targetUrl: 'http://127.0.0.1:9/app',
  framework: 'vue',
  createdAt: at,
  status: 'PROJECT_CREATED',
  state: 'ACTIVE',
  counts: { environments: 1, scenarios: 1, recordings: 0, executions: 0 },
  draft: {} as ProjectDetail['draft'],
  environments: [
    {
      id: 'env_1',
      name: 'Recette',
      kind: 'TEST',
      baseUrl: 'http://127.0.0.2:9',
      secretEnv: ['QA_PASSWORD'],
      variables: { QA_LOCALE: 'fr' },
      mutations: { enabled: true, maxPerRun: 5 },
      createdAt: at,
      updatedAt: at,
    },
  ],
  scenarios: [{ name: 'checkout', file: 'checkout.flow.yaml', format: 'yaml', steps: 3 }],
};

describe('dashboard rendering', () => {
  it('the server definition of the pass rate is the one the Dashboard explains in fields', () => {
    expect(KNOWN_PASS_RATE_DEFINITION).toBe(PASS_RATE_DEFINITION);
  });

  it('overview: numbers as given, the rate with numerator, denominator and exclusions, escaped', () => {
    const html = renderDashboard(base({ overview }));
    expect(html).toContain('67 %');
    expect(html).toContain('2 réussis sur 3 rejeux terminés');
    expect(html).toContain('Numérateur : rejeux dont chaque flow rejoué est PASSED');
    expect(html).toContain('Dénominateur : rejeux terminés avec un verdict pendant la période');
    expect(html).toContain('Exclus : rejeux annulés, sans résultat ou sans flow');
    expect(html).toContain('&lt;b&gt;Shop&lt;/b&gt;');
    expect(html).not.toContain('<b>Shop</b>');
    expect(html).toContain('>Annulé<');
    expect(html).toContain('aria-label="2026-10-27 : 2 réussis, 1 échoués"');
    expect(html).toContain('data-action="open-run" data-project="prj_a" data-run="run-a"');
  });

  it('overview without a finished replay shows no rate, never 0 %', () => {
    const html = renderDashboard(
      base({
        overview: {
          ...overview,
          replays: { ...overview.replays, finished: 0, passed: 0, failed: 0, passRate: undefined },
        },
      }),
    );
    expect(html).toContain('Aucun rejeu terminé dans la période : pas de taux.');
    expect(html).not.toContain('0 %');
  });

  it('project: environments show secret names only, archiving is confirmed in the page', () => {
    const route = { view: 'project', projectId: 'prj_a' } as const;
    const html = renderDashboard(base({ route, project, executions: [] }));
    expect(html).toContain('<code>QA_PASSWORD</code>');
    expect(html).toContain('permises, 5 au plus par run');
    expect(html).toContain('data-action="archive"');
    expect(html).not.toContain('data-action="archive-confirm"');
    const confirming = renderDashboard(base({ route, project, executions: [], confirm: 'archive' }));
    expect(confirming).toContain('data-action="archive-confirm"');
    expect(confirming).toContain('Rien n’est supprimé');
    const archived = renderDashboard(
      base({ route, project: { ...project, state: 'ARCHIVED' }, executions: [] }),
    );
    expect(archived).toContain('Projet archivé : lecture seule');
    expect(archived).not.toContain('form class="launch"');
    expect(archived).toContain('data-action="restore"');
  });

  it('a running execution offers cancellation only when the server does, after a confirmation', () => {
    const snapshot = { id: 'exp_1', status: 'RUNNING' } as ExplorationSnapshot;
    const route = { view: 'execution', projectId: 'prj_a', run: 'run-c', explorationId: 'exp_1' } as const;
    const steps = liveSteps([], {
      seq: 1,
      at,
      type: 'flow-step',
      flow: 'checkout',
      index: 1,
      kind: 'fill',
      label: 'fill label "Title"',
      status: 'PASSED',
      durationMs: 12,
    });
    const live = { snapshot, steps, phase: 'Writing the reports', cancelRequested: false };
    const html = renderDashboard(base({ route, live }));
    expect(html).toContain('data-action="cancel"');
    expect(html).toContain('Écriture des rapports');
    expect(html).toContain('1. fill label &quot;Title&quot;');
    expect(renderDashboard(base({ route, live, confirm: 'cancel' }))).toContain(
      'data-action="cancel-confirm"',
    );
    expect(renderDashboard(base({ route, live: { ...live, cancelRequested: true } }))).toContain(
      'Annulation demandée',
    );
    const without = renderDashboard(base({ route, live, cancellation: false }));
    expect(without).not.toContain('data-action="cancel"');
    expect(without).toContain('Ce serveur n’offre pas l’annulation.');
  });

  it('a finished execution: verdict, translated step and assertion statuses, keys of the test data', () => {
    const execution = {
      run: 'run-c',
      projectId: 'prj_a',
      kind: 'REPLAY',
      createdAt: at,
      verdict: 'FAILED',
      durationMs: 2300,
      flows: { total: 1, passed: 0, failed: 1 },
      issues: 1,
      environment: { id: 'env_1', name: 'Recette' },
      scenarios: ['checkout'],
      reports: { html: 'index.html' },
      flowsDetail: [
        {
          name: 'checkout',
          status: 'FAILED',
          durationMs: 2000,
          steps: [
            {
              index: 1,
              kind: 'fill',
              label: 'fill label "Title"',
              status: 'FAILED',
              durationMs: 5,
              reason: 'not found',
            },
          ],
          divergence: { stepIndex: 1, reason: 'NOT_FOUND' },
          assertions: [{ id: 'A1', description: 'the item is created', status: 'FAIL' }],
          testData: ['item.title'],
        },
      ],
    } as unknown as ExecutionDetail;
    const route = { view: 'execution', projectId: 'prj_a', run: 'run-c' } as const;
    const html = renderDashboard(base({ route, execution }));
    expect(html).toContain('>Échoué<');
    expect(html).toContain('0/1 flow(s) réussi(s)');
    expect(html).toContain('Première divergence : étape 1 — NOT_FOUND');
    expect(html).toContain('>En échec<');
    expect(html).toContain('<code>item.title</code>');
    expect(html).toContain('data-action="report"');
  });

  it('English strings, and an error state that says the server is unreachable', () => {
    expect(renderDashboard(base({ t: dashboardStrings('en'), overview }))).toContain(
      '2 passed out of 3 finished replays',
    );
    const error = renderDashboard(base({ phase: 'error', error: 'connect ECONNREFUSED' }));
    expect(error).toContain('Serveur QA-CRAWLER injoignable');
    expect(error).toContain('data-action="retry"');
  });
});
