import { describe, expect, it } from 'vitest';
import { defaultScope } from '../../src/incident/scope.js';
import type {
  AccessAnalysis,
  AccessCandidate,
  Incident,
  IncidentAccess,
  TargetLocation,
  TargetPreparation,
} from '../../src/sdk/core/incident-contracts.js';
import { MAX_ACCESS_STEPS } from '../../src/sdk/core/incident-contracts.js';
import type { TriggerRun, TriggerTrial } from '../../src/sdk/core/incident-trigger-contracts.js';
import {
  accessDirty,
  accessEditable,
  accessInputOf,
  actionText,
  canExplore,
  draftOf,
  emptyAccessUi,
  explorationView,
  extensionFor,
  INCIDENT_ACCESS_CSS,
  reduceAccess,
  renderAccess,
  renderAccessSummary,
  sessionName,
} from '../../src/sdk/ui/incident-access.js';
import type { ScopeContext } from '../../src/sdk/ui/incident-scope.js';

/**
 * LA CARTE « SCÉNARIO D'ACCÈS ET EXPLORATION » : brouillon (mode, écran cible, étapes), ce qui part au
 * serveur, actions disponibles selon l'avancement (localiser, préparer, lancer), candidats et parcours,
 * écran atteint et inventaire, progression calculée sur le run réel (aucun pourcentage), résultats
 * (séquence, conditions, preuves, hypothèses jamais confirmées par le moteur seul), démonstration par
 * enregistrement seulement, lecture seule, résumé.
 */
const at = '2026-11-02T10:00:00.000Z';

const incidentOf = (access?: IncidentAccess, over: Partial<Incident> = {}): Incident => ({
  id: 'inc_1',
  projectId: 'prj_books',
  title: 'Blocage après Enregistrer',
  description: '',
  observed: 'aucune réaction',
  expected: 'dossier enregistré',
  severity: 'HIGH',
  execution: { target: 'LOCAL' },
  scope: defaultScope(),
  state: 'DRAFT',
  revision: 1,
  createdAt: at,
  updatedAt: at,
  createdBy: 'analyste',
  history: [],
  investigation: { reproductions: [], hypotheses: [], experiments: [] },
  ...(access ? { access } : {}),
  ...over,
});

const ctxOf = (incident: Incident, options: { runner?: boolean; demo?: boolean; lang?: 'fr' | 'en' } = {}) =>
  ({
    incident,
    lang: options.lang ?? 'fr',
    demo: options.demo ?? false,
    can: () => options.runner ?? true,
  }) satisfies ScopeContext;

const candidate = (over: Partial<AccessCandidate> = {}): AccessCandidate => ({
  id: 'web:component:DossierComponent',
  kind: 'COMPONENT',
  label: 'DossierComponent',
  ref: 'src/app/dossier/dossier.component.ts:12',
  applicationId: 'web',
  confidence: 0.5,
  match: 'MATCHED',
  status: 'AUTHORIZED',
  reasons: ['mots-clés : dossier'],
  ...over,
});

const analysis: AccessAnalysis = {
  analyzedAt: '2026-11-02T10:05:00.000Z',
  analyzedBy: 'alice',
  sources: ['TEXT', 'STEPS'],
  path: [
    {
      index: 1,
      text: 'j’ouvre le menu Dossiers',
      source: 'TEXT',
      action: 'OPEN',
      target: 'Dossiers',
      element: 'MENU',
      critical: false,
    },
    {
      index: 2,
      text: 'je clique sur Enregistrer',
      source: 'TEXT',
      action: 'SAVE',
      target: 'Enregistrer',
      element: 'BUTTON',
      critical: true,
    },
  ],
  interpretations: [
    { kind: 'AREA', value: 'Dossiers', confidence: 0.8, from: 'j’ouvre le menu Dossiers' },
    { kind: 'ACTION', value: 'SAVE', confidence: 0.7, from: 'je clique sur Enregistrer' },
  ],
  elements: [{ kind: 'MENU', label: 'Dossiers' }],
  anomalies: ['GLOBAL_ACTION_FAILURE'],
  conditions: [],
  keywords: ['dossier'],
  candidates: [
    candidate(),
    candidate({
      id: 'svc:auth',
      kind: 'SERVICE',
      label: 'authInterceptor',
      ref: 'src/app/shared/auth.interceptor.ts:3',
      match: 'UNCERTAIN',
      confidence: 0.3,
      transversal: true,
      reasons: ['intercepteur HTTP'],
    }),
    candidate({
      id: 'denied',
      kind: 'SERVICE',
      label: 'NotesStore',
      ref: 'libs/notes/notes.store.ts:4',
      match: 'UNCERTAIN',
      status: 'DENIED',
      reasons: ['refusé par le périmètre'],
    }),
  ],
  leads: [
    { kind: 'ERROR_HANDLER', label: 'Gestionnaire d’erreurs global', why: 'Une erreur avalée…', refs: [] },
  ],
  limits: ['Aucun enregistrement associé : le parcours vient du texte.'],
};

const access = (over: Partial<IncidentAccess> = {}): IncidentAccess => ({
  narrative: 'J’ouvre le menu Dossiers puis je clique sur Enregistrer.',
  steps: [{ id: 'st_aaaa1111', text: 'Ouvrir Dossiers' }],
  updatedAt: '2026-11-02T10:00:00.000Z',
  updatedBy: 'alice',
  ...over,
});

const location: TargetLocation = {
  locatedAt: '2026-11-02T10:06:00.000Z',
  locatedBy: 'alice',
  query: 'nouveau dossier',
  candidates: [
    {
      route: '/dossiers/nouveau',
      applicationId: 'web',
      component: 'DossierComponent',
      confidence: 0.95,
      evidence: ['lien « Nouveau dossier » vers cet écran (src/app/dossier/dossier-list.component.ts:2)'],
      nameOnly: false,
      guards: [],
    },
    {
      route: '/dossiers',
      applicationId: 'web',
      component: 'DossierListComponent',
      confidence: 0.4,
      evidence: ['nom du composant DossierListComponent (« dossier »)'],
      nameOnly: true,
      guards: ['authGuard'],
    },
  ],
  chosen: '/dossiers/nouveau',
  entry: '/dossiers',
  path: [
    { kind: 'NAVIGATE', target: '/dossiers', label: '/dossiers', route: '/dossiers', source: 'LINKS' },
    {
      kind: 'CLICK',
      target: 'link:Nouveau dossier',
      label: 'Nouveau dossier',
      route: '/dossiers/nouveau',
      source: 'LINKS',
      evidence: 'src/app/dossier/dossier-list.component.ts:2',
    },
  ],
  guards: [],
  limits: [],
};

const preparation = (over: Partial<TargetPreparation> = {}): TargetPreparation => ({
  preparedAt: '2026-11-02T10:07:00.000Z',
  preparedBy: 'alice',
  route: '/dossiers/nouveau',
  reached: true,
  finalUrl: '/dossiers/nouveau',
  title: 'Nouveau dossier',
  steps: [
    { summary: 'naviguer vers /dossiers', ok: true },
    { summary: 'cliquer Nouveau dossier', ok: true },
  ],
  inventory: {
    buttons: ['Enregistrer', 'Notes'],
    fields: ['Code', 'Libellé'],
    links: ['Liste des dossiers'],
    selects: [],
    disabled: [],
    dialogs: 0,
    overlays: 0,
    messages: [],
    loading: false,
  },
  requests: ['GET /dossiers', 'GET /dossiers/nouveau'],
  errors: [],
  blockers: [],
  screenshot: 'prepare-1.png',
  durationMs: 1800,
  ...over,
});

const trial = (over: Partial<TriggerTrial> = {}): TriggerTrial => ({
  id: 't1',
  strategy: 'GUIDED',
  factors: {},
  actions: [
    { kind: 'CLEAR', target: 'label:Code' },
    { kind: 'CLICK', target: 'button:Enregistrer', origin: 'probe' },
  ],
  probes: [1],
  startedAt: at,
  status: 'DONE',
  failures: [],
  events: [],
  snapshots: {},
  key: 'k1',
  cost: { actions: 2, durationMs: 900 },
  screenshots: [],
  ...over,
});

const run = (over: Partial<TriggerRun> = {}): TriggerRun => ({
  id: 'trg_1',
  depth: 'STANDARD',
  state: 'EXPLORING_TRIGGERS',
  startedAt: at,
  updatedAt: at,
  startedBy: 'alice',
  budget: {
    maxDurationMs: 600_000,
    maxTrials: 40,
    maxActions: 400,
    maxRepeats: 3,
    maxExperiments: 10,
    maxEvents: 5000,
    maxAiCalls: 0,
    maxBrowsers: 1,
  },
  usage: { durationMs: 65_000, trials: 7, actions: 30, repeats: 0, experiments: 0, events: 120, aiCalls: 0 },
  strategies: [],
  trials: [trial()],
  reference: {},
  conditions: [],
  hypothesisIds: [],
  pendingExperimentIds: [],
  coverage: [{ dimension: 'STATES', explored: 3, known: 5 }],
  limitations: [],
  ...over,
});

const explored = (runOver: Partial<TriggerRun> = {}, accessOver: Partial<IncidentAccess> = {}): Incident =>
  incidentOf(
    access({
      target: 'nouveau dossier',
      location,
      preparation: preparation(),
      exploration: { runId: 'trg_1', startedAt: at, startedBy: 'alice', route: '/dossiers/nouveau' },
      ...accessOver,
    }),
    {
      investigation: {
        reproductions: [],
        hypotheses: [
          {
            id: 'hyp_1',
            title: 'Erreur avalée par le gestionnaire global',
            description: '',
            suspectedCause: '',
            layer: 'FRONTEND',
            files: ['src/app/core/error-handler.ts'],
            supporting: [],
            contradicting: [],
            confidence: 0.55,
            verifications: [],
            status: 'PROPOSED',
          },
        ],
        experiments: [],
        trigger: { runs: [run(runOver)] },
      },
    },
  );

describe('carte du scénario d’accès : état', () => {
  it('le brouillon : mode, écran cible, étapes ajoutées, montées, retirées ; abandon ; profondeur', () => {
    const saved = access();
    let ui = emptyAccessUi('inc_1');
    expect(ui.depth).toBe('STANDARD');
    expect(accessDirty(ui, saved)).toBe(false);
    ui = reduceAccess(ui, saved, 'inc-acc-input', { key: 'target', value: 'nouveau dossier' }) ?? ui;
    ui = reduceAccess(ui, saved, 'inc-acc-input', { key: 'hints', value: 'menu Dossiers' }) ?? ui;
    ui = reduceAccess(ui, saved, 'inc-acc-mode', { mode: 'GUIDED' }) ?? ui;
    expect(reduceAccess(ui, saved, 'inc-acc-mode', { mode: 'VIDEO' })?.draft?.mode).toBe('GUIDED');
    ui = reduceAccess(ui, saved, 'inc-acc-step-add', {}) ?? ui;
    ui = reduceAccess(ui, saved, 'inc-acc-input', { key: 'step.1', value: 'Cliquer sur Enregistrer' }) ?? ui;
    ui = reduceAccess(ui, saved, 'inc-acc-step-up', { index: '1' }) ?? ui;
    expect(ui.draft?.steps.map((step) => step.text)).toEqual(['Cliquer sur Enregistrer', 'Ouvrir Dossiers']);
    expect(accessDirty(ui, saved)).toBe(true);
    const input = accessInputOf(ui.draft ?? draftOf(saved));
    expect(input).toMatchObject({ mode: 'GUIDED', target: 'nouveau dossier', hints: 'menu Dossiers' });
    expect(input.steps).toEqual([
      { text: 'Cliquer sur Enregistrer' },
      { id: 'st_aaaa1111', text: 'Ouvrir Dossiers' },
    ]);
    ui = reduceAccess(ui, saved, 'inc-acc-step-remove', { index: '0' }) ?? ui;
    expect(ui.draft?.steps).toHaveLength(1);
    ui = reduceAccess(ui, saved, 'inc-acc-reset', {}) ?? ui;
    expect(ui.draft).toBeUndefined();
    ui = reduceAccess(ui, saved, 'inc-acc-input', { key: 'depth', value: 'DEEP' }) ?? ui;
    expect(ui.depth).toBe('DEEP');
    expect(reduceAccess(ui, saved, 'inc-acc-input', { key: 'depth', value: 'TOTAL' })?.depth).toBe('DEEP');
    expect(reduceAccess(ui, saved, 'inc-acc-more', {})?.more).toBe(true);
    expect(reduceAccess(ui, saved, 'inc-acc-cancel', {})?.confirmCancel).toBe(true);
    expect(reduceAccess(ui, saved, 'inc-disc-run', {})).toBeUndefined();
    const full = access({
      steps: Array.from({ length: MAX_ACCESS_STEPS }, (_v, i) => ({
        id: `st_${String(i).padStart(4, '0')}`,
        text: 'x',
      })),
    });
    expect(reduceAccess(emptyAccessUi(), full, 'inc-acc-step-add', {})?.draft).toBeUndefined();
  });

  it('extension d’une portion refusée, nom d’un enregistrement, action lisible', () => {
    expect(extensionFor(candidate({ status: 'DENIED', ref: 'libs/notes/notes.store.ts:4' }))).toEqual({
      kind: 'ADD_PATH',
      target: 'libs/notes',
      applicationId: 'web',
    });
    expect(extensionFor(candidate({ kind: 'DEPENDENCY', status: 'PROPOSED', label: 'api.test' }))).toEqual({
      kind: 'ADD_HOST',
      target: 'api.test',
    });
    expect(extensionFor(candidate())).toBeUndefined();
    expect(sessionName('inc_sYE3bK-oM3Xq', 1762056000000)).toMatch(/^parcours-inc-sye3bk-om3xq-[a-z0-9]+$/);
    expect(actionText({ kind: 'CLEAR', target: 'label:Code' }, 'fr')).toBe('Code = « vide »');
    expect(actionText({ kind: 'CLICK', target: 'button:Enregistrer' }, 'fr')).toBe('cliquer « Enregistrer »');
  });

  it('la progression vient du run réel : phases faites, en cours, à venir ; compteurs ; jamais de pourcentage', () => {
    const none = explorationView(incidentOf(access()), 'fr');
    expect(none.phases.every((phase) => phase.status === 'pending')).toBe(true);
    expect(none.counters).toBeUndefined();
    // Localisation en cours (opération), puis localisé sans préparation.
    expect(explorationView(incidentOf(access()), 'fr', 'inc-acc-locate').phases[0]?.status).toBe('current');
    const located = explorationView(incidentOf(access({ location })), 'fr');
    expect(located.phases.slice(0, 3).map((phase) => phase.status)).toEqual(['done', 'done', 'pending']);
    // Une préparation d'un autre écran ne compte pas.
    const other = explorationView(
      incidentOf(access({ location, preparation: preparation({ route: '/dossiers' }) })),
      'fr',
    );
    expect(other.preparation).toBeUndefined();
    const failed = explorationView(
      incidentOf(access({ location, preparation: preparation({ reached: false, blockers: ['x'] }) })),
      'fr',
    );
    expect(failed.phases[2]?.status).toBe('failed');

    const live = explorationView(explored(), 'fr');
    expect(live.live).toBe(true);
    expect(Object.fromEntries(live.phases.map((phase) => [phase.key, phase.status]))).toMatchObject({
      REACHED: 'done',
      INTERACTIONS: 'done',
      COMBINATIONS: 'current',
      SUSPECTED: 'pending',
      CONFIRMED: 'pending',
    });
    expect(live.counters).toEqual({
      sequences: 7,
      states: { explored: 3, known: 5 },
      lastAction: 'cliquer « Enregistrer »',
      anomalies: 0,
      durationMs: 65_000,
      remainingTrials: 33,
      remainingMs: 535_000,
    });
    // Une seule reproduction : suspectée, pas confirmée ; deux sur deux : confirmée.
    const once = explorationView(
      explored({ trials: [trial({ verdict: 'FAILURE_REPRODUCED', repeats: { total: 2, reproduced: 1 } })] }),
      'fr',
    );
    const status = (view: typeof once, key: string) => view.phases.find((phase) => phase.key === key)?.status;
    expect(status(once, 'SUSPECTED')).toBe('done');
    expect(status(once, 'CONFIRMED')).toBe('pending');
    const twice = explorationView(
      explored({
        state: 'WAITING_FOR_APPROVAL',
        trials: [trial({ verdict: 'FAILURE_REPRODUCED', repeats: { total: 2, reproduced: 2 } })],
        hypothesisIds: ['hyp_1'],
      }),
      'fr',
    );
    expect(status(twice, 'CONFIRMED')).toBe('done');
    expect(status(twice, 'DIAGNOSIS')).toBe('done');
    expect(twice.live).toBe(false);
    expect(canExplore(incidentOf(access({ location, preparation: preparation() })))).toBe(true);
    expect(canExplore(explored())).toBe(false);
    expect(canExplore(incidentOf(access({ location })))).toBe(false);
  });
});

describe('carte du scénario d’accès : rendu', () => {
  it('sans scénario : titre, trois modes, champs, actions désactivées tant que l’écran manque', () => {
    const html = renderAccess(ctxOf(incidentOf()), emptyAccessUi('inc_1'));
    expect(html).toContain('<h2 id="inc-acc-t" class="fl">Scénario d’accès et exploration</h2>');
    expect(html).toContain('role="radiogroup" aria-label="Mode d’investigation"');
    for (const mode of ['Explorer automatiquement', 'Parcours guidé', 'Démonstration'])
      expect(html).toContain(`<b>${mode}`);
    expect(html).toMatch(/id="inc-acc-mode-AUTO"[^>]*aria-checked="true"/);
    expect(html).toContain('recommandé');
    for (const id of ['inc-acc-target', 'inc-acc-url', 'inc-acc-hints', 'inc-acc-narrative'])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain('Écran ou fonctionnalité cible');
    expect(html).toContain('Description du problème');
    expect(html).toMatch(/id="inc-acc-target"[^>]*aria-required="true"/);
    // « Localiser » reste actif même vide : la frappe ne redessine pas la carte (le serveur dit ce qui manque).
    expect(html).not.toMatch(/data-action="inc-acc-locate"[^>]*disabled/);
    expect(html).toMatch(/data-action="inc-acc-prepare"[^>]*disabled/);
    expect(html).toMatch(/data-action="inc-acc-explore"[^>]*disabled/);
    expect(html).toContain('Indiquez l’écran cible (ou une URL), puis localisez-le');
    expect(html).toContain('Aucun scénario');
    expect(html).not.toContain('inc-acc-prog');
    // Aucune vidéo : ni champ de fichier, ni lecteur.
    expect(html).not.toMatch(/type="file"|<video|vidéo/);
    expect(INCIDENT_ACCESS_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    // Les détails complémentaires se déplient à la demande.
    const more = renderAccess(ctxOf(incidentOf()), { ...emptyAccessUi('inc_1'), more: true });
    for (const id of [
      'inc-acc-start',
      'inc-acc-expected',
      'inc-acc-observed',
      'inc-acc-conditions',
      'inc-acc-testData',
    ])
      expect(more).toContain(`id="${id}"`);
  });

  it('localisé puis atteint : candidats (choisir un autre écran), parcours, inventaire, lancement possible', () => {
    const located = renderAccess(
      ctxOf(incidentOf(access({ target: 'nouveau dossier', location }))),
      emptyAccessUi('inc_1'),
    );
    expect(located).toContain('Écran localisé : /dossiers/nouveau');
    expect(located).toContain('<b class="mono">/dossiers/nouveau</b>');
    expect(located).toContain('95 %');
    expect(located).toContain('nom seul');
    expect(located).toContain('garde : authGuard');
    expect(located).toContain('data-action="inc-acc-choose" data-block="/dossiers"');
    expect(located).not.toContain('data-block="/dossiers/nouveau"');
    expect(located).toContain('Parcours trouvé');
    expect(located).toContain('lien relevé · src/app/dossier/dossier-list.component.ts:2');
    expect(located).not.toMatch(/data-action="inc-acc-prepare"[^>]*disabled/);
    expect(located).toMatch(/data-action="inc-acc-explore"[^>]*disabled/);

    const reached = renderAccess(
      ctxOf(incidentOf(access({ target: 'nouveau dossier', location, preparation: preparation() }))),
      emptyAccessUi('inc_1'),
    );
    expect(reached).toContain('Écran atteint');
    expect(reached).toContain('<b>2</b> boutons');
    expect(reached).toContain('Enregistrer, Notes');
    expect(reached).toContain('Capture gardée : prepare-1.png');
    expect(reached).not.toMatch(/data-action="inc-acc-explore"[^>]*disabled/);
    expect(reached).toMatch(/class="btn primary" data-action="inc-acc-explore"/);

    const blocked = renderAccess(
      ctxOf(
        incidentOf(
          access({
            target: 'nouveau dossier',
            location,
            preparation: preparation({
              reached: false,
              blockers: ['page de connexion : une session autorisée est nécessaire'],
            }),
          }),
        ),
      ),
      emptyAccessUi('inc_1'),
    );
    expect(blocked).toContain('Écran non atteint');
    expect(blocked).toContain('Ce qui empêche l’exploration');
    expect(blocked).toContain('page de connexion');
    expect(blocked).toMatch(/data-action="inc-acc-explore"[^>]*disabled/);
  });

  it('exploration en cours : phases, compteurs réels, pause et annulation ; aucun pourcentage de progression', () => {
    const html = renderAccess(ctxOf(explored()), emptyAccessUi('inc_1'));
    expect(html).toContain('Progression de l’investigation');
    expect(html).toContain('Exploration : Exploration des combinaisons');
    for (const phase of [
      'Recherche de l’écran',
      'Parcours identifié',
      'Écran atteint',
      'Analyse des interactions',
      'Exploration des combinaisons',
      'Anomalie suspectée',
      'Reproduction en cours',
      'Anomalie confirmée',
      'Diagnostic en cours',
    ])
      expect(html).toContain(`<span>${phase}</span>`);
    expect(html).toContain('<dt>Séquences exécutées</dt><dd>7</dd>');
    expect(html).toContain('<dt>États explorés</dt><dd>3 / 5</dd>');
    expect(html).toContain('<dt>Durée</dt><dd>1 min 05 s</dd>');
    expect(html).toContain('<dt>Limites restantes</dt><dd>33 essai(s), 8 min 55 s</dd>');
    expect(html).toContain('data-action="inc-acc-pause"');
    expect(html).toContain('data-action="inc-acc-cancel"');
    expect(html).toMatch(/data-action="inc-acc-explore"[^>]*disabled/);
    expect(html).toContain('Une exploration est déjà en cours.');
    // La progression ne montre aucun pourcentage (les pourcentages restent ceux des confiances).
    const progress = html.slice(html.indexOf('inc-acc-prog'), html.indexOf('inc-acc-loc-t'));
    expect(progress).not.toMatch(/\d+ ?%/);
    const paused = renderAccess(ctxOf(explored({ state: 'PAUSED' })), {
      ...emptyAccessUi('inc_1'),
      confirmCancel: true,
    });
    expect(paused).toContain('data-action="inc-acc-resume"');
    expect(paused).toContain('data-action="inc-acc-cancel-yes"');
  });

  it('résultats : séquence, fréquence, conditions, preuves, hypothèses proposées, actions recommandées', () => {
    const html = renderAccess(
      ctxOf(
        explored({
          state: 'WAITING_FOR_APPROVAL',
          trials: [trial({ verdict: 'FAILURE_REPRODUCED', repeats: { total: 2, reproduced: 2 } })],
          entry: {
            route: '/dossiers/nouveau',
            source: 'TARGET',
            actions: [{ kind: 'NAVIGATE', target: 'http://site/dossiers', origin: 'target' }],
          },
          minimal: {
            actions: [
              { kind: 'NAVIGATE', target: 'http://site/dossiers', origin: 'reference' },
              { kind: 'CLEAR', target: 'label:Code' },
              { kind: 'OPEN_DIALOG', target: 'button:Notes' },
              { kind: 'CLICK', target: 'button:Enregistrer', origin: 'probe' },
            ],
            preconditions: ['page d’entrée : naviguer vers /dossiers'],
            frequency: { reproduced: 1, total: 1 },
            fromTrialId: 't1',
            reducedFrom: 4,
            trialIds: ['t1'],
            note: '',
          },
          conditions: [
            {
              id: 'cond:data:empty:label:Code',
              description: 'Code vide',
              actions: [],
              role: 'NECESSARY',
              withCondition: { reproduced: 3, total: 3 },
              withoutCondition: { reproduced: 0, total: 3 },
              source: 'RUNTIME_OBSERVED',
              trialIds: [],
            },
          ],
          firstFailure: {
            firstError: { trialId: 't1', eventId: 'e1', summary: 'TypeError: cannot read trim', t: 10 },
            propagation: [],
            onlyInFailing: [],
            note: '',
          },
          hypothesisIds: ['hyp_1'],
          pendingExperimentIds: ['exp_1'],
          limitations: ['point d’entrée imposé : écran cible /dossiers/nouveau'],
        }),
      ),
      emptyAccessUi('inc_1'),
    );
    expect(html).toContain(
      'Anomalie reproduite 2 fois sur 2 : le symptôme est confirmé, la cause reste à vérifier.',
    );
    expect(html).toContain('Séquence déclenchante');
    expect(html).toContain('séquence réduite : reproduite 1 fois sur 1');
    expect(html).toContain('<li><span>Code = « vide »</span></li>');
    expect(html).toContain('<li><span>ouvrir « Notes »</span></li>');
    expect(html).not.toContain('aller à http://site/dossiers');
    expect(html).toContain('nécessaire');
    expect(html).toContain('avec : 3/3 · sans : 0/3');
    expect(html).toContain('TypeError: cannot read trim');
    expect(html).toContain('Erreur avalée par le gestionnaire global');
    expect(html).toContain('proposée');
    expect(html).not.toContain('<span class="inc-acc-chip">confirmée</span>');
    expect(html).toContain('Décider des 1 vérification(s) en attente.');
    expect(html).toContain('data-action="ws-ux-tab" data-tab="tminimal"');
    expect(html).toContain('localisation de l’écran : 95 %');

    const nothing = renderAccess(ctxOf(explored({ state: 'INCONCLUSIVE' })), emptyAccessUi('inc_1'));
    expect(nothing).toContain('Aucune reproduction dans le budget : rien n’est conclu.');
  });

  it('démonstration par enregistrement seulement ; analyse du parcours ; lecture seule ; anglais', () => {
    const incident = incidentOf(
      access({
        mode: 'DEMO',
        analysis,
        recording: { name: 'creation-dossier', linkedAt: at, linkedBy: 'alice' },
      }),
    );
    const demo = renderAccess(ctxOf(incident), {
      ...emptyAccessUi('inc_1'),
      recordings: [
        {
          name: 'creation-dossier',
          projectId: 'prj',
          status: 'STORED',
          serverTime: at,
          lastSeq: 0,
          startedAt: at,
        },
        { name: 'en-echec', projectId: 'prj', status: 'FAILED', serverTime: at, lastSeq: 0 },
      ],
    });
    expect(demo).toContain('data-action="inc-acc-rec-start"');
    expect(demo).toContain('data-action="inc-acc-rec-unlink"');
    expect(demo).toMatch(/data-block="en-echec" disabled/);
    expect(demo).not.toMatch(/type="file"|<video/);
    expect(demo).toContain('Enregistrement associé : creation-dossier');
    const running = renderAccess(ctxOf(incident), { ...emptyAccessUi('inc_1'), session: 'parcours-x' });
    expect(running).toContain('Enregistrement en cours : parcours-x');
    // L'analyse du parcours décrit reste disponible.
    expect(demo).toContain('Correspondances (1)');
    expect(demo).toContain('Correspondances incertaines (2)');
    expect(demo).toContain('data-action="inc-acc-ext" data-block="denied"');
    expect(demo).toContain('étape critique');
    const reader = renderAccess(ctxOf(incident, { runner: false }), emptyAccessUi('inc_1'));
    expect(reader).toContain('Lecture seule');
    expect(reader).not.toContain('data-action="inc-acc-locate"');
    expect(reader).toMatch(/id="inc-acc-target"[^>]*disabled/);
    expect(accessEditable(ctxOf(incident, { demo: true }))).toBe(false);
    expect(accessEditable(ctxOf(incidentOf(access(), { state: 'CANCELLED' })))).toBe(false);
    expect(renderAccess(ctxOf(incident, { lang: 'en' }), emptyAccessUi())).toContain(
      'Access scenario and exploration',
    );
  });

  it('le résumé : écran cible, texte, étapes, état de l’exploration ; rien sans scénario', () => {
    expect(renderAccessSummary('fr', undefined)).toBe('');
    expect(renderAccessSummary('fr', access({ narrative: '', steps: [] }))).toBe('');
    const incident = explored({ state: 'COMPLETED' }, { analysis });
    const summary = renderAccessSummary('fr', incident.access, incident);
    expect(summary).toContain('Scénario d’accès');
    expect(summary).toContain('Écran cible : nouveau dossier (/dossiers/nouveau)');
    expect(summary).toContain('<li>Ouvrir Dossiers</li>');
    expect(summary).toContain('Écran atteint');
    expect(summary).toContain('Exploration : Terminée');
    expect(summary).toContain('je clique sur Enregistrer');
  });
});
