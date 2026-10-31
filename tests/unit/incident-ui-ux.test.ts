import { describe, expect, it } from 'vitest';
import type {
  EnvironmentCapabilities,
  Incident,
  InvestigationScope,
  ReproductionRun,
} from '../../src/sdk/core/incident-contracts.js';
import { workspaceLinks } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';
import {
  emptyUxUi,
  environmentDirty,
  executionOf,
  INCIDENT_UX_CSS,
  reduceUx,
  renderEnvironmentSelector,
  renderOverview,
  renderStepper,
  renderTabPanel,
  renderTabs,
  renderWorkspaceHeader,
  rovingTarget,
  workspaceProgress,
  workspaceTabs,
  type UxUi,
  type WorkspaceStage,
} from '../../src/sdk/ui/incident-ux.js';

/**
 * LA STRUCTURE DE L'ESPACE D'INVESTIGATION : la progression déduite des données (brouillon, reproduit,
 * diagnostic probable, annulé), la liste des étapes accessible, la vue d'ensemble qui ne dit « confirmé »
 * que pour un diagnostic CONFIRMED, le choix LOCAL / REMOTE / ARO en groupe radio, le réducteur et
 * l'échappement des textes saisis.
 */
const at = '2026-10-30T09:00:00.000Z';

const scope = (withApplication: boolean): InvestigationScope => ({
  mode: 'GUIDED',
  applications: withApplication
    ? [{ id: 'bff', name: 'BFF livres', layer: 'BFF', repository: { root: '/repos/bff', include: [] } }]
    : [],
  scenarios: [],
  steps: [],
  endpoints: [],
  depth: 3,
  allowedHosts: [],
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
  limits: { maxFiles: 100, maxFileBytes: 1000, maxDurationMs: 1000, maxRequests: 10, maxExperiments: 5 },
  extensions: [],
});

const run = (overrides: Partial<ReproductionRun> = {}): ReproductionRun => ({
  id: 'rep_1',
  startedAt: at,
  finishedAt: at,
  status: 'COMPLETED',
  target: 'LOCAL',
  scenario: 'Créer un livre',
  reproduced: true,
  symptomMatch: 'HTTP 500 sur POST /api/books',
  actions: [
    {
      index: 1,
      kind: 'click',
      description: 'click button "Enregistrer"',
      status: 'PASSED',
      durationMs: 120,
      requestIds: ['rep_1:req-1-1'],
    },
  ],
  requests: [
    {
      id: 'rep_1:req-1-1',
      method: 'POST',
      url: '/api/books',
      path: '/api/books',
      status: 500,
      resourceType: 'fetch',
      step: 1,
      correlation: 'OBSERVED',
    },
    {
      id: 'rep_1:req-1-2',
      method: 'GET',
      url: '/api/books',
      path: '/api/books',
      status: 200,
      resourceType: 'fetch',
      step: 1,
      correlation: 'OBSERVED',
    },
  ],
  evidence: [
    {
      id: 'rep_1:ev-issue-ISSUE-0001',
      kind: 'JS_ERROR',
      summary: "TypeError: Cannot read properties of undefined (reading 'isbn')",
      source: { reproduction: 'rep_1', step: 1 },
    },
  ],
  screenshots: [],
  ...overrides,
});

const draft = (overrides: Partial<Incident> = {}): Incident => ({
  id: 'inc_abc123def456',
  projectId: 'prj_books',
  title: 'Erreur 500 après Enregistrer',
  description: 'La création d’un livre échoue.',
  observed: 'Une erreur HTTP 500 s’affiche après Enregistrer.',
  expected: 'Le livre est créé.',
  severity: 'HIGH',
  scenario: 'Créer un livre',
  environmentId: 'env_test',
  execution: { target: 'LOCAL' },
  scope: scope(false),
  state: 'DRAFT',
  revision: 1,
  createdAt: at,
  updatedAt: at,
  createdBy: 'lecteur',
  history: [],
  investigation: { reproductions: [], hypotheses: [], experiments: [] },
  ...overrides,
});

const reproduced = (): Incident =>
  draft({
    state: 'REPRODUCED',
    scope: scope(true),
    investigation: { reproductions: [run()], hypotheses: [], experiments: [] },
  });

const diagnosedProbable = (): Incident =>
  draft({
    state: 'DIAGNOSED',
    scope: scope(true),
    investigation: {
      reproductions: [run()],
      code: {
        applications: [],
        symbols: [],
        endpoints: [],
        outgoing: [],
        calls: [],
        denied: [],
        truncated: [],
      },
      graph: { nodes: [], edges: [] },
      hypotheses: [
        {
          id: 'hyp-null-isbn',
          title: 'ISBN absent',
          description: 'Le BFF ne transmet pas l’ISBN.',
          suspectedCause: 'Champ non mappé',
          layer: 'BFF',
          files: [],
          supporting: [],
          contradicting: [],
          confidence: 0.7,
          verifications: [],
          status: 'SUPPORTED',
        },
        {
          id: 'hyp-db',
          title: 'Base indisponible',
          description: 'La base ne répond pas.',
          suspectedCause: 'Réseau',
          layer: 'DATABASE',
          files: [],
          supporting: [],
          contradicting: [],
          confidence: 0.1,
          verifications: [],
          status: 'REFUTED',
        },
      ],
      experiments: [
        {
          id: 'exp_1',
          kind: 'REPLAY',
          description: 'Rejouer le scénario',
          params: {},
          status: 'DONE',
          sideEffects: false,
          decisions: [],
          evidence: [],
        },
      ],
      diagnosis: {
        status: 'PROBABLE',
        rootCause: {
          hypothesisId: 'hyp-null-isbn',
          statement: 'Le mapper du BFF omet le champ isbn.',
          layer: 'BFF',
          files: [],
        },
        alternatives: [],
        missing: ['Un test unitaire du mapper'],
        recommendations: [],
        generatedAt: at,
      },
    },
  });

const contextOf = (
  incident: Incident,
  options: { demo?: boolean; runner?: boolean } = {},
): WorkspaceContext =>
  workspaceContext({
    incident,
    lang: 'fr',
    links: workspaceLinks(incident),
    demo: options.demo ?? false,
    can: () => options.runner ?? true,
  });

const statusOf = (incident: Incident): Record<WorkspaceStage, string> =>
  Object.fromEntries(workspaceProgress(incident).stages.map((stage) => [stage.key, stage.status])) as Record<
    WorkspaceStage,
    string
  >;

describe('workspaceProgress', () => {
  it('a draft without application: description done, scope current, the rest to do', () => {
    const progress = workspaceProgress(draft());
    expect(progress.stages.map((stage) => stage.key)).toEqual([
      'description',
      'scope',
      'environment',
      'reproduction',
      'evidence',
      'code',
      'traceability',
      'diagnosis',
      'report',
      'regression',
    ]);
    const status = statusOf(draft());
    expect(status.description).toBe('DONE');
    expect(status.scope).toBe('CURRENT');
    expect(status.environment).toBe('DONE');
    expect(status.reproduction).toBe('TODO');
    expect(progress.current).toBe('scope');
    expect(progress.running).toBeUndefined();
  });

  it('an ARO target without its required fields keeps the environment to do', () => {
    const incident = draft({ scope: scope(true), execution: { target: 'ARO' } });
    expect(workspaceProgress(incident).current).toBe('environment');
  });

  it('a reproduced incident: reproduction and evidence done, code analysis current', () => {
    const status = statusOf(reproduced());
    expect(status.scope).toBe('DONE');
    expect(status.reproduction).toBe('DONE');
    expect(status.evidence).toBe('DONE');
    expect(status.code).toBe('CURRENT');
    expect(workspaceProgress(reproduced()).done).toBe(5);
  });

  it('a reproduction without request nor evidence leaves the evidence stage current', () => {
    const incident = draft({
      scope: scope(true),
      state: 'NOT_REPRODUCED',
      investigation: {
        reproductions: [run({ requests: [], evidence: [], reproduced: false })],
        hypotheses: [],
        experiments: [],
      },
    });
    expect(workspaceProgress(incident).current).toBe('evidence');
  });

  it('the reference reproduction only: a replay of another scenario does not count', () => {
    const incident = draft({
      scope: scope(true),
      investigation: {
        reproductions: [run({ id: 'rep_2', scenario: 'Scénario qui réussit' })],
        hypotheses: [],
        experiments: [],
      },
    });
    expect(statusOf(incident).reproduction).toBe('CURRENT');
  });

  it('a probable diagnosis: diagnosis and report done, non-regression current', () => {
    const status = statusOf(diagnosedProbable());
    expect(status.code).toBe('DONE');
    expect(status.traceability).toBe('DONE');
    expect(status.diagnosis).toBe('DONE');
    expect(status.report).toBe('DONE');
    expect(status.regression).toBe('CURRENT');
  });

  it('non-regression is done only once an execution exists', () => {
    const incident = diagnosedProbable();
    incident.investigation.regression = {
      name: 'Non-régression',
      basedOn: 'Créer un livre',
      flowYaml: 'steps: []',
      expected: 'Livre créé',
      status: 'ACCEPTED',
    };
    expect(statusOf(incident).regression).toBe('CURRENT');
    incident.investigation.regression.execution = { run: 'run-1', passed: false, at };
    const progress = workspaceProgress(incident);
    expect(progress.current).toBeUndefined();
    expect(progress.done).toBe(10);
  });

  it('a cancelled incident blocks its current stage', () => {
    const incident = { ...reproduced(), state: 'CANCELLED' as const, cancelledFrom: 'REPRODUCED' as const };
    const status = statusOf(incident);
    expect(status.code).toBe('BLOCKED');
    expect(status.traceability).toBe('TODO');
    expect(status.reproduction).toBe('DONE');
  });

  it('a running reproduction or experiment is reported as running', () => {
    expect(workspaceProgress(draft({ scope: scope(true), state: 'REPRODUCING' })).running).toBe(
      'reproduction',
    );
    const incident = diagnosedProbable();
    const experiment = incident.investigation.experiments[0];
    if (experiment) experiment.status = 'RUNNING';
    expect(workspaceProgress(incident).running).toBe('diagnosis');
  });
});

describe('renderStepper', () => {
  it('an ordered list of stage buttons, aria-current="step" on the current one only', () => {
    const html = renderStepper(contextOf(reproduced()));
    expect(html).toContain('<nav class="ws-ux-stepper" aria-label="Progression de l’investigation">');
    expect(html).toContain('<ol>');
    expect(html.match(/data-action="ws-ux-stage"/g)).toHaveLength(10);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/data-stage="code" aria-current="step"/);
    expect(html).toContain('5 étape(s) terminée(s) sur 10');
    expect(html).toContain('Analyse du code');
    expect(html).toContain('ws-ux-s-done');
  });

  it('a blocked stage says so in text, not only in colour', () => {
    const html = renderStepper(contextOf({ ...reproduced(), state: 'CANCELLED' }));
    expect(html).toContain('ws-ux-s-blocked');
    expect(html).toContain('Bloquée');
  });

  it('a fully done investigation has no current step', () => {
    const incident = diagnosedProbable();
    incident.investigation.regression = {
      name: 'n',
      basedOn: 'b',
      flowYaml: '',
      expected: '',
      status: 'ACCEPTED',
      execution: { run: 'run-1', passed: true, at },
    };
    expect(renderStepper(contextOf(incident))).not.toContain('aria-current');
  });
});

describe('renderWorkspaceHeader', () => {
  it('title, severity, state, environment, scenario, update and the actions slot', () => {
    const html = renderWorkspaceHeader(contextOf(reproduced()), '<button data-action="x">Agir</button>');
    expect(html).toContain('<h1 id="ws-ux-title">Erreur 500 après Enregistrer</h1>');
    expect(html).toContain('<span class="sr">Gravité : </span>Haute');
    expect(html).toContain('Reproduit');
    expect(html).toContain('<b>Local</b>');
    expect(html).toContain('environnement du projet env_test');
    expect(html).toContain('Créer un livre');
    expect(html).toContain(`datetime="${at}"`);
    expect(html).toContain('<button data-action="x">Agir</button>');
    expect(html).not.toContain('ws-demo');
  });

  it('shows the demo banner, the cancelled origin and the running reproduction', () => {
    const demo = renderWorkspaceHeader(contextOf(reproduced(), { demo: true }), '');
    expect(demo).toContain('Données de démonstration');
    const cancelled = renderWorkspaceHeader(
      contextOf({ ...reproduced(), state: 'CANCELLED', cancelledFrom: 'REPRODUCED' }),
      '',
    );
    expect(cancelled).toContain('Annulé (annulé à l’état « Reproduit »)');
    const running = renderWorkspaceHeader(contextOf(draft({ scope: scope(true), state: 'REPRODUCING' })), '');
    expect(running).toContain('ws-ux-run');
  });

  it('the diagnosis pill tells its exact status', () => {
    const html = renderWorkspaceHeader(contextOf(diagnosedProbable()), '');
    expect(html).toContain('Cause probable, à vérifier');
    expect(html).not.toMatch(/confirm/i);
  });
});

describe('renderTabs', () => {
  it('an accessible tablist with roving tabindex and counts', () => {
    const ctx = contextOf(diagnosedProbable());
    const tabs = workspaceTabs(ctx);
    expect(tabs.map((tab) => tab.key)).toContain('overview');
    expect(tabs.find((tab) => tab.key === 'requests')?.count).toBe(2);
    expect(tabs.find((tab) => tab.key === 'hypotheses')?.count).toBe(2);
    const html = renderTabs(ctx, tabs, 'hypotheses');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(tabs.length);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain(
      'id="ws-ux-tab-hypotheses" data-action="ws-ux-tab" data-tab="hypotheses" aria-selected="true"',
    );
    expect(html).toContain('<span class="sr">2 élément(s)</span>');
    expect(renderTabPanel('hypotheses', '<p>x</p>')).toContain(
      'role="tabpanel" aria-labelledby="ws-ux-tab-hypotheses"',
    );
  });

  it('arrow keys, Home and End move within the list', () => {
    const keys = ['a', 'b', 'c'] as const;
    expect(rovingTarget(keys, 'a', 'ArrowRight')).toBe('b');
    expect(rovingTarget(keys, 'a', 'ArrowLeft')).toBe('c');
    expect(rovingTarget(keys, 'c', 'ArrowDown')).toBe('a');
    expect(rovingTarget(keys, 'b', 'Home')).toBe('a');
    expect(rovingTarget(keys, 'a', 'End')).toBe('c');
    expect(rovingTarget(keys, 'a', 'Enter')).toBeUndefined();
  });
});

describe('renderOverview', () => {
  it('key facts of the reference reproduction: verdict, failing requests, first JS error', () => {
    const html = renderOverview(contextOf(reproduced()));
    expect(html).toContain('Symptôme observé');
    expect(html).toContain('<code>POST /api/books</code>');
    expect(html).toContain('500');
    expect(html).not.toContain('rep_1:req-1-2');
    expect(html).toContain('data-kind="request" data-ref="rep_1:req-1-1"');
    expect(html).toContain('data-kind="evidence" data-ref="rep_1:ev-issue-ISSUE-0001"');
    expect(html).toContain('Pas encore de diagnostic.');
    expect(html).toContain('Lancer l’analyse du code du périmètre.');
    expect(html).toContain('data-action="ws-ux-stage" data-stage="code"');
  });

  it('never says confirmed for a probable diagnosis', () => {
    const html = renderOverview(contextOf(diagnosedProbable()));
    expect(html).toContain('Cause probable, à vérifier');
    expect(html).toContain('Cause la plus probable');
    expect(html).toContain('Le mapper du BFF omet le champ isbn.');
    expect(html).toContain('Un test unitaire du mapper');
    expect(html).not.toMatch(/confirm/i);
    expect(html).toContain('Étayées');
    expect(html).toContain('Réfutées');
    expect(html).toContain('Terminées');
    expect(html).toContain('Pas encore proposé');
  });

  it('says confirmed only for a CONFIRMED diagnosis', () => {
    const incident = diagnosedProbable();
    if (incident.investigation.diagnosis) incident.investigation.diagnosis.status = 'CONFIRMED';
    const html = renderOverview(contextOf(incident));
    expect(html).toContain('Cause racine confirmée');
  });

  it('a non-regression test is passed only on a real passing execution', () => {
    const incident = diagnosedProbable();
    incident.investigation.regression = {
      name: 'n',
      basedOn: 'b',
      flowYaml: '',
      expected: '',
      status: 'ACCEPTED',
    };
    expect(renderOverview(contextOf(incident))).toContain('Proposé, pas encore exécuté');
    incident.investigation.regression.execution = { run: 'run-1', passed: false, at };
    const failed = renderOverview(contextOf(incident));
    expect(failed).toContain('Exécuté : en échec');
    expect(failed).not.toContain('réussi');
  });

  it('empty, running and cancelled states', () => {
    expect(renderOverview(contextOf(draft()))).toContain(
      'Aucune reproduction terminée du scénario de l’incident.',
    );
    const running = renderOverview(contextOf(draft({ scope: scope(true), state: 'REPRODUCING' })));
    expect(running).toContain('aria-busy="true"');
    expect(renderOverview(contextOf({ ...reproduced(), state: 'CANCELLED' }))).toContain(
      'Investigation annulée : la reprendre pour continuer.',
    );
  });
});

describe('renderEnvironmentSelector', () => {
  const capabilities: EnvironmentCapabilities = {
    target: 'LOCAL',
    playwright: 'LOCAL_PROCESS',
    repositories: 'LOCAL',
    tests: false,
    logs: 'FILES',
    kubernetesJobs: false,
    limitations: ['mvn introuvable dans le PATH'],
  };

  it('three cards in a radio group, the saved one checked, LOCAL marked as default', () => {
    const html = renderEnvironmentSelector(contextOf(reproduced()), emptyUxUi(), capabilities);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/data-target="LOCAL" aria-checked="true" tabindex="0"/);
    expect(html).toMatch(/data-target="REMOTE" aria-checked="false" tabindex="-1"/);
    expect(html).toMatch(/data-target="ARO" aria-checked="false" tabindex="-1"/);
    expect(html).toContain('Par défaut');
    expect(html).toContain('Capacités mesurées');
    expect(html).toContain('Programme local');
    expect(html).toContain('Indisponibles');
    expect(html).toContain('mvn introuvable dans le PATH');
    expect(html).toContain('Conteneur dans le cluster');
    expect(html).toMatch(/data-action="ws-ux-target-save"[^>]*disabled/);
    expect(html).not.toContain('data-ws-field');
  });

  it('ARO shows its four required fields; REMOTE its optional OpenShift fields', () => {
    const ctx = contextOf(reproduced());
    const aro = renderEnvironmentSelector(ctx, { ...emptyUxUi(), target: 'ARO' }, capabilities);
    for (const field of ['aro.namespace', 'aro.serviceAccount', 'aro.image', 'aro.repositoriesMount'])
      expect(aro).toMatch(
        new RegExp(`data-ws-field="${field.replace('.', '\\.')}"[^>]*required aria-required="true"`),
      );
    expect(aro).toContain('data-ws-field="aro.apiServer"');
    expect(aro).toMatch(/data-target="ARO" aria-checked="true"/);
    expect(aro).toContain('Capacités mesurées pour la cible enregistrée (Local)');
    expect(aro).toContain('Modifications non enregistrées.');
    expect(aro).toContain('data-action="ws-ux-target-reset"');
    expect(aro).not.toMatch(/data-action="ws-ux-target-save"[^>]*disabled/);
    const remote = renderEnvironmentSelector(ctx, { ...emptyUxUi(), target: 'REMOTE' });
    expect(remote).toContain('data-ws-field="remote.namespace"');
    expect(remote).not.toMatch(/data-ws-field="remote\.namespace"[^>]*required/);
  });

  it('flags invalid fields and shows saved values, read-only without the RUN right', () => {
    const incident = draft({
      scope: scope(true),
      execution: {
        target: 'ARO',
        aro: { namespace: 'books-qa', serviceAccount: '', image: 'qa:1', repositoriesMount: '/repos' },
      },
    });
    const ui: UxUi = { ...emptyUxUi(), invalid: ['aro.serviceAccount'] };
    const html = renderEnvironmentSelector(contextOf(incident), ui);
    expect(html).toContain('value="books-qa"');
    expect(html).toMatch(/data-ws-field="aro\.serviceAccount"[^>]*aria-invalid="true"/);
    expect(html).toContain('role="alert"');
    // Le champ refusé porte son propre message, lié par aria-describedby ; les autres n'en ont pas.
    expect(html).toMatch(
      /id="ws-ux-f-aro\.serviceAccount"[^>]*aria-describedby="ws-ux-f-aro\.serviceAccount-e"/,
    );
    expect(html).toMatch(/<small id="ws-ux-f-aro\.serviceAccount-e" class="err[^"]*">.*Champ obligatoire\./);
    expect(html).not.toContain('ws-ux-f-aro.namespace-e');
    // Un champ refusé qui a aussi une indication : le message puis l'indication.
    const mount = renderEnvironmentSelector(contextOf(incident), {
      ...emptyUxUi(),
      invalid: ['aro.repositoriesMount'],
    });
    expect(mount).toContain(
      'aria-describedby="ws-ux-f-aro.repositoriesMount-e ws-ux-f-aro.repositoriesMount-h"',
    );
    const reader = renderEnvironmentSelector(contextOf(incident, { runner: false }), emptyUxUi());
    expect(reader).toContain('Lecture seule');
    expect(reader).not.toContain('ws-ux-target-save');
    expect(reader).toMatch(/data-ws-field="aro\.namespace"[^>]*disabled/);
  });

  it('executionOf builds the configuration and lists the missing ARO fields', () => {
    const incident = reproduced();
    const missing = executionOf(incident, {
      ...emptyUxUi(),
      target: 'ARO',
      fields: { 'aro.namespace': ' books-qa ' },
    });
    expect(missing.invalid).toEqual(['aro.serviceAccount', 'aro.image', 'aro.repositoriesMount']);
    expect(missing.execution.aro?.namespace).toBe('books-qa');
    const remote = executionOf(incident, {
      ...emptyUxUi(),
      target: 'REMOTE',
      fields: { 'remote.namespace': 'books' },
    });
    expect(remote).toEqual({
      execution: { target: 'REMOTE', remote: { openshift: { namespace: 'books' } } },
      invalid: [],
    });
    expect(
      executionOf(incident, { ...emptyUxUi(), target: 'REMOTE', fields: { 'remote.context': 'c' } }).invalid,
    ).toEqual(['remote.namespace']);
    expect(executionOf(incident, emptyUxUi())).toEqual({ execution: { target: 'LOCAL' }, invalid: [] });
    expect(environmentDirty(incident, emptyUxUi())).toBe(false);
    expect(environmentDirty(incident, { ...emptyUxUi(), target: 'REMOTE' })).toBe(true);
  });
});

describe('reduceUx', () => {
  it('selects a target, types a field, saves, fails, resets', () => {
    let ui = emptyUxUi();
    ui = reduceUx(ui, 'ws-ux-target', { target: 'ARO' }) ?? ui;
    expect(ui.target).toBe('ARO');
    expect(reduceUx(ui, 'ws-ux-target', { target: 'MARS' })).toBe(ui);
    ui = reduceUx(ui, 'ws-ux-invalid', { fields: 'aro.namespace, aro.image, nope' }) ?? ui;
    expect(ui.invalid).toEqual(['aro.namespace', 'aro.image']);
    ui = reduceUx(ui, 'ws-ux-field', { field: 'aro.namespace', value: 'books-qa' }) ?? ui;
    expect(ui.fields['aro.namespace']).toBe('books-qa');
    expect(ui.invalid).toEqual(['aro.image']);
    expect(reduceUx(ui, 'ws-ux-field', { field: 'other', value: 'x' })).toBe(ui);
    ui = reduceUx(ui, 'ws-ux-target-save', {}) ?? ui;
    expect(ui.saving).toBe(true);
    expect(ui.invalid).toEqual([]);
    ui = reduceUx(ui, 'ws-ux-error', { message: 'Conflit de révision' }) ?? ui;
    expect(ui.saving).toBe(false);
    expect(ui.error).toBe('Conflit de révision');
    expect(reduceUx(ui, 'ws-ux-saved', {})).toEqual(emptyUxUi());
    expect(reduceUx(ui, 'ws-ux-target-reset', {})).toEqual(emptyUxUi());
  });

  it('leaves navigation and foreign actions to the integration', () => {
    const ui = emptyUxUi();
    expect(reduceUx(ui, 'ws-ux-stage', { stage: 'code' })).toBeUndefined();
    expect(reduceUx(ui, 'ws-ux-tab', { tab: 'overview' })).toBeUndefined();
    expect(reduceUx(ui, 'ws-select', {})).toBeUndefined();
  });
});

describe('layout rules (QA review)', () => {
  it('positioned tab bar and stepper (no screen-reader count escapes), tabs wrap, stage labels never cut mid-word', () => {
    expect(INCIDENT_UX_CSS).toMatch(/\.ws-ux-tabs\{position:relative;flex-wrap:wrap/);
    expect(INCIDENT_UX_CSS).toMatch(/\.ws-ux-stepper ol\{position:relative;/);
    expect(INCIDENT_UX_CSS).not.toMatch(/\.ws-ux-tabs\{[^}]*overflow-x:auto/);
    expect(INCIDENT_UX_CSS).toContain('.ws-ux-stage-t b{font-size:13px;font-weight:600;overflow-wrap:normal');
    // La progression mesure sa propre largeur : 5 colonnes puis 10, défilement (avec ombre) en dessous.
    expect(INCIDENT_UX_CSS).toContain('container:ws-ux-steps / inline-size');
    expect(INCIDENT_UX_CSS).toMatch(/@container ws-ux-steps \(min-width:600px\)\{[^@]*repeat\(5,/);
    expect(INCIDENT_UX_CSS).toMatch(/@container ws-ux-steps \(min-width:1040px\)\{[^@]*repeat\(10,/);
  });

  it('wide screens: the graph is a full-width band above the content and a 340 px panel', () => {
    expect(INCIDENT_UX_CSS).toMatch(
      /@container \(min-width:960px\)\{\s*\.ws-ux-shell\{grid-template-areas:"graph" "main" "aside"\}/,
    );
    expect(INCIDENT_UX_CSS).toMatch(
      /@container \(min-width:1280px\)\{\s*\.ws-ux-shell\{grid-template-columns:minmax\(0,1fr\) 340px;grid-template-areas:"graph graph" "main aside"\}/,
    );
  });
});

describe('escaping and style rules', () => {
  it('escapes every user text', () => {
    const incident = draft({
      title: '<script>alert(1)</script>',
      observed: '<img src=x onerror=alert(1)>',
      expected: '"quoted"',
      description: '<b>gras</b>',
      scenario: '<i>scénario</i>',
    });
    const ctx = contextOf(incident);
    const html = [renderWorkspaceHeader(ctx, ''), renderOverview(ctx), renderStepper(ctx)].join('');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>gras</b>');
    expect(html).not.toContain('<i>scénario</i>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
  });

  it('the styles use the theme tokens only (no literal colour)', () => {
    expect(INCIDENT_UX_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(INCIDENT_UX_CSS).not.toMatch(/rgba?\(/);
    expect(INCIDENT_UX_CSS).toContain('var(--qa-color-primary)');
  });
});
