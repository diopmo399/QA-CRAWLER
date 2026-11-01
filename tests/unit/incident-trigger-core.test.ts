import { describe, expect, it } from 'vitest';
import type { Incident } from '../../src/incident/model.js';
import { defaultScope } from '../../src/incident/scope.js';
import {
  analyzeDataLoss,
  analyzeFirstFailure,
  deriveConditions,
  proposeRootCauses,
} from '../../src/incident/trigger/analysis.js';
import { interpretBrief, withInferred } from '../../src/incident/trigger/brief.js';
import { ddmin } from '../../src/incident/trigger/minimize.js';
import {
  boundaryValues,
  buildCatalog,
  isFactorAction,
  type Factor,
} from '../../src/incident/trigger/model.js';
import {
  detectSilentFailures,
  judge,
  reactionOf,
  type ProbeObservation,
} from '../../src/incident/trigger/oracle.js';
import { buildTriggerRegression } from '../../src/incident/trigger/regression.js';
import { buildTriggerReport } from '../../src/incident/trigger/report.js';
import { describeAction, sequenceKey } from '../../src/incident/trigger/session.js';
import { actionsOf, planTrials, strategiesFor } from '../../src/incident/trigger/strategies.js';
import type { ActionOutcome } from '../../src/incident/trigger/session.js';
import type {
  ReactionSignature,
  RuntimeEvent,
  TriggerAction,
  TriggerRun,
  TriggerTrial,
  UiSnapshot,
} from '../../src/sdk/core/incident-trigger-contracts.js';

/**
 * LES BRIQUES DE LA DÉCOUVERTE DES DÉCLENCHEURS, sans navigateur : l'interprète (provenance USER_REPORTED,
 * jamais une preuve), le catalogue d'actions (sondes, remplissages, facteurs par dimension), les stratégies
 * (jamais un produit cartésien complet, la priorité la plus haute l'emporte), l'oracle (une seule sonde muette
 * ne suffit pas ; une erreur Playwright n'est pas un défaut applicatif), la minimisation (delta debugging),
 * les conditions (taux avec / sans), la régression (flow proposé, jamais « validé ») et le rapport.
 */
const snapshot = (over: Partial<UiSnapshot> = {}): UiSnapshot => ({
  url: '/dossiers/nouveau',
  title: 'Nouveau dossier',
  elements: [
    { key: 'button:Enregistrer', role: 'button', name: 'Enregistrer', enabled: true, visible: true },
    { key: 'button:Actualiser', role: 'button', name: 'Actualiser', enabled: true, visible: true },
    { key: 'button:Notes', role: 'button', name: 'Notes', enabled: true, visible: true },
    { key: 'button:Supprimer', role: 'button', name: 'Supprimer', enabled: true, visible: true },
    { key: 'textbox:Code', role: 'textbox', name: 'Code', enabled: true, visible: true, value: '' },
    { key: 'textbox:Titre', role: 'textbox', name: 'Titre', enabled: true, visible: true, value: '' },
    {
      key: 'combobox:Catégorie',
      role: 'combobox',
      name: 'Catégorie',
      enabled: true,
      visible: true,
      options: ['Courant', 'Archive'],
    },
    {
      key: 'checkbox:Urgent',
      role: 'checkbox',
      name: 'Urgent',
      enabled: true,
      visible: true,
      value: 'false',
    },
    { key: 'link:Liste', role: 'link', name: 'Liste des dossiers', enabled: true, visible: true },
  ],
  overlays: 0,
  messages: [],
  loading: false,
  ...over,
});

const event = (
  kind: RuntimeEvent['kind'],
  summary: string,
  extra: Partial<RuntimeEvent> = {},
): RuntimeEvent => ({
  id: `ev_${summary.replace(/\W+/g, '_')}`,
  t: 100,
  at: '2026-10-31T10:00:00.000Z',
  kind,
  summary,
  ...extra,
});

const outcome = (over: Partial<ActionOutcome> = {}): ActionOutcome => ({
  ok: true,
  events: [],
  before: snapshot(),
  after: snapshot(),
  durationMs: 50,
  ...over,
});

const probe = (
  index: number,
  target: string,
  out: ActionOutcome,
  reference: ReactionSignature | undefined,
): ProbeObservation => ({
  index,
  action: { kind: 'CLICK', target, origin: 'probe' },
  outcome: out,
  reference,
});

const REFERENCE: ReactionSignature = {
  request: { method: 'POST', path: '/api/dossiers' },
  domChange: true,
  message: 'Dossier créé',
};
const REFRESH: ReactionSignature = {
  request: { method: 'GET', path: '/api/dossiers/recents' },
  domChange: true,
};
const REQUEST = event('REQUEST', 'POST /api/dossiers', {
  data: { method: 'POST', path: '/api/dossiers', resourceType: 'fetch' },
});

describe('brief interpreter', () => {
  it('reads a French description: area, action, symptoms, unknown conditions, data loss, suspected failures — all USER_REPORTED', () => {
    const brief = interpretBrief(
      'Dans la création de dossier, après une erreur JavaScript survenue dans des circonstances inconnues, le bouton Enregistrer ne fait plus rien : aucune validation, aucun chargement, aucune requête HTTP. Un rafraîchissement (F5) remet tout en état mais la saisie est perdue.',
      { title: 'Enregistrer ne réagit plus', now: '2026-10-31T10:00:00.000Z' },
    );
    expect(brief.language).toBe('fr');
    expect(brief.symptoms.length).toBeGreaterThan(0);
    expect(brief.unknownConditions.length).toBeGreaterThan(0);
    expect(brief.dataLoss?.text).toMatch(/perdue/);
    expect(brief.suspectedFailures).toEqual(expect.arrayContaining(['HTTP_REQUEST_NOT_EMITTED']));
    const everything = [
      ...brief.symptoms,
      ...brief.knownConditions,
      ...brief.unknownConditions,
      ...brief.environment,
    ];
    expect(everything.every((item) => item.source === 'USER_REPORTED')).toBe(true);
    expect(brief.keywords).toEqual(expect.arrayContaining(['enregistrer']));
  });

  it('reads an English description and keeps inferred elements apart from what the person said', () => {
    const brief = interpretBrief(
      'On the order form, after a JS error, the Save button does nothing anymore. Refreshing the page restores it.',
    );
    expect(brief.language).toBe('en');
    const inferred = withInferred(brief, { conditions: ['the order has no customer'], keywords: ['save'] });
    expect(inferred.unknownConditions.at(-1)).toEqual({
      text: 'the order has no customer',
      source: 'AI_INFERRED',
    });
    expect(brief.unknownConditions.every((item) => item.source === 'USER_REPORTED')).toBe(true);
    expect(inferred.rawText).toBe(brief.rawText);
  });
});

describe('action catalog', () => {
  it('finds the probes, the reference fills, the factors per dimension and never plays destructive buttons', () => {
    const catalog = buildCatalog(snapshot(), { keywords: ['enregistrer', 'code'] });
    expect(catalog.probes.map((action) => action.target)).toEqual([
      'button:Enregistrer',
      'button:Actualiser',
    ]);
    expect(catalog.fills.map((action) => action.target)).toEqual(
      expect.arrayContaining(['label:Code', 'label:Titre', 'label:Catégorie']),
    );
    expect(catalog.destructive.map((action) => action.target)).toEqual(['button:Supprimer']);
    expect(catalog.factors.some((factor) => factor.id === 'action:click:button:Supprimer')).toBe(false);
    const dimensions = new Set(catalog.factors.map((factor) => factor.dimension));
    expect([...dimensions].sort()).toEqual(['ACTIONS', 'DATA', 'STATES', 'TIMING']);
    expect(
      catalog.factors
        .find((factor) => factor.id === 'state:dialog:button:Notes')
        ?.actions.map((action) => action.kind),
    ).toEqual(['OPEN_DIALOG', 'CLOSE_DIALOG']);
    expect(catalog.factors.some((factor) => factor.id === 'data:select:label:Catégorie=Archive')).toBe(true);
    // Les facteurs qui touchent la zone décrite passent devant.
    const code = catalog.factors.find((factor) => factor.id === 'data:empty:label:Code');
    const titre = catalog.factors.find((factor) => factor.id === 'data:empty:label:Titre');
    expect((code?.priority ?? 0) > (titre?.priority ?? 0)).toBe(true);
    expect(
      boundaryValues({
        key: 'textbox:Code',
        role: 'textbox',
        name: 'Code',
        enabled: true,
        visible: true,
      }).map((item) => item.label),
    ).toContain('texte long (256)');
  });
});

describe('exploration strategies', () => {
  const catalog = buildCatalog(snapshot(), { keywords: ['enregistrer'] });
  const ctx = (depth: 'QUICK' | 'STANDARD' | 'DEEP') => ({
    depth,
    catalog,
    trials: [] as TriggerTrial[],
    errorFactors: new Set<string>(),
    reproducingFactors: new Set<string>(),
    played: new Set<string>(),
  });

  it('orders strategies by depth, plans one factor at a time first, and never a full cartesian product', () => {
    expect(strategiesFor('QUICK')).toEqual(['GUIDED', 'CODE_GUIDED']);
    expect(strategiesFor('DEEP')).toContain('AI_GUIDED');
    const quick = planTrials(ctx('QUICK'));
    expect(quick.every((plan) => plan.factors.length === 1)).toBe(true);
    const standard = planTrials(ctx('STANDARD'));
    const pairs = standard.filter((plan) => plan.factors.length === 2);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThan(catalog.factors.length * (catalog.factors.length - 1));
    expect(
      pairs
        .filter((plan) => plan.factors[0]?.target !== undefined && plan.factors[1]?.target !== undefined)
        .every((plan) => plan.factors[0]?.target !== plan.factors[1]?.target),
    ).toBe(true);
    const keys = standard.map((plan) => plan.factors.map((factor) => factor.id).join('→'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the highest priority when two strategies propose the same sequence (AI proposals are played first, judged like the others)', () => {
    const code = catalog.factors.find((factor) => factor.id === 'data:empty:label:Code') as Factor;
    const notes = catalog.factors.find((factor) => factor.id === 'state:dialog:button:Notes') as Factor;
    const plans = planTrials({ ...ctx('DEEP'), aiProposals: [[code, notes]] });
    const first = plans[0];
    expect(first?.strategy).toBe('AI_GUIDED');
    expect(first?.factors.map((factor) => factor.id)).toEqual([code.id, notes.id]);
  });

  it('builds a trial: entry, reference fills (minus the overridden field), factor actions tagged by factor, then probes with the primary one replayed', () => {
    const code = catalog.factors.find((factor) => factor.id === 'data:empty:label:Code') as Factor;
    const { actions, probes } = actionsOf({ strategy: 'GUIDED', factors: [code], priority: 1 }, catalog, [
      { kind: 'NAVIGATE', target: 'http://app.test/dossiers/nouveau' },
    ]);
    expect(actions[0]).toMatchObject({ kind: 'NAVIGATE', origin: 'reference' });
    expect(
      actions.filter((action) => action.target === 'label:Code' && action.origin === 'reference'),
    ).toHaveLength(0);
    expect(actions.filter(isFactorAction).map((action) => action.origin)).toEqual([code.id]);
    expect(probes.map((index) => actions[index]?.target)).toEqual([
      'button:Enregistrer',
      'button:Actualiser',
      'button:Enregistrer',
    ]);
    expect(sequenceKey(actions)).toContain('CLICK|button:Enregistrer');
    expect(describeAction({ kind: 'FILL', target: 'label:Code', value: '' })).toContain('«vide»');
  });
});

describe('failure oracle', () => {
  it('judges NOT_REPRODUCED when every probe reacts like the reference', () => {
    const reacting = outcome({ events: [REQUEST], after: snapshot({ messages: ['Dossier créé'] }) });
    const result = judge({
      probes: [probe(4, 'button:Enregistrer', reacting, REFERENCE)],
      preparationErrors: [],
      events: [REQUEST],
    });
    expect(result.verdict).toBe('FAILURE_NOT_REPRODUCED');
    expect(reactionOf(reacting).request).toEqual({ method: 'POST', path: '/api/dossiers' });
  });

  it('does not call a single silent probe a reproduction, but does when two independent probes are silent (global failure)', () => {
    const silent = outcome();
    const one = judge({
      probes: [
        probe(4, 'button:Enregistrer', silent, REFERENCE),
        probe(
          5,
          'button:Actualiser',
          outcome({
            events: [
              event('REQUEST', 'GET /api/dossiers/recents', {
                data: { method: 'GET', path: '/api/dossiers/recents', resourceType: 'fetch' },
              }),
            ],
          }),
          REFRESH,
        ),
      ],
      preparationErrors: [],
      events: [],
    });
    expect(one.verdict).toBe('INCONCLUSIVE');
    expect(one.reason).toContain('une seule sonde');
    const two = judge({
      probes: [
        probe(4, 'button:Enregistrer', silent, REFERENCE),
        probe(5, 'button:Actualiser', silent, REFRESH),
      ],
      preparationErrors: [],
      events: [],
    });
    expect(two.verdict).toBe('FAILURE_REPRODUCED');
    const kinds = two.failures.map((failure) => failure.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'HTTP_REQUEST_NOT_EMITTED',
        'FORM_SUBMISSION_NOT_TRIGGERED',
        'NO_FUNCTIONAL_REACTION_AFTER_ACTION',
        'GLOBAL_ACTION_FAILURE',
        'POSSIBLE_CHANGE_DETECTION_FAILURE',
      ]),
    );
    expect(kinds).not.toContain('POSSIBLE_EVENT_INTERCEPTION');
  });

  it('reads a page error during a probe as an exception, ignores a spinner already shown, and flags an overlay as possible interception', () => {
    const error = event('PAGE_ERROR', "TypeError: Cannot read properties of null (reading '0')", {
      level: 'error',
    });
    const crashed = outcome({ events: [error], after: snapshot({ loading: true }) });
    const stuck = outcome({
      before: snapshot({ loading: true, overlays: 1 }),
      after: snapshot({ loading: true, overlays: 1 }),
    });
    const { failures } = detectSilentFailures([
      probe(4, 'button:Enregistrer', crashed, REFERENCE),
      probe(5, 'button:Actualiser', stuck, REFRESH),
    ]);
    const kinds = failures.map((failure) => failure.kind);
    expect(kinds).toContain('EVENT_HANDLER_EXCEPTION');
    expect(kinds).toContain('UI_STATE_STUCK');
    expect(kinds).toContain('POSSIBLE_EVENT_INTERCEPTION');
    expect(kinds).toContain('GLOBAL_ACTION_FAILURE');
    expect(failures.find((failure) => failure.kind === 'EVENT_HANDLER_EXCEPTION')?.eventIds).toEqual([
      error.id,
    ]);
  });

  it('never confuses a Playwright error or a dead environment with an application defect', () => {
    const infra = judge({
      probes: [
        probe(
          4,
          'button:Enregistrer',
          outcome({ ok: false, error: 'locator.click: Timeout 5000ms exceeded' }),
          REFERENCE,
        ),
      ],
      preparationErrors: [],
      events: [],
    });
    expect(infra.verdict).toBe('TEST_INFRASTRUCTURE_FAILURE');
    const prep = judge({ probes: [], preparationErrors: ['saisir label:Code : cible absente'], events: [] });
    expect(prep.verdict).toBe('TEST_INFRASTRUCTURE_FAILURE');
    const down = judge({
      probes: [probe(4, 'button:Enregistrer', outcome(), REFERENCE)],
      preparationErrors: [],
      events: [event('RESPONSE', 'GET / 503', { data: { resourceType: 'document', status: 503 } })],
    });
    expect(down.verdict).toBe('ENVIRONMENT_FAILURE');
    const noReference = judge({
      probes: [probe(4, 'button:Enregistrer', outcome(), undefined)],
      preparationErrors: [],
      events: [],
    });
    expect(noReference.verdict).toBe('INCONCLUSIVE');
  });
});

describe('delta debugging', () => {
  it('finds a two-factor subset of five, replays each candidate through the oracle and caches identical candidates', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    const tested: string[] = [];
    const result = await ddmin(items, (candidate) => {
      tested.push(candidate.map((item) => item.id).join(''));
      const ids = new Set(candidate.map((item) => item.id));
      return Promise.resolve(ids.has('b') && ids.has('d'));
    });
    expect(result.minimal.map((item) => item.id).sort()).toEqual(['b', 'd']);
    expect(result.tests).toBe(tested.length);
    expect(new Set(tested).size).toBe(tested.length);
    expect(result.tests).toBeLessThan(2 ** 5);
  });

  it('stops at the budget and keeps the last reproducing candidate', async () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    const result = await ddmin(items, () => Promise.resolve(true), { maxTests: 1 });
    expect(result.tests).toBe(1);
    expect(result.minimal.length).toBeLessThanOrEqual(2);
  });
});

const trial = (
  id: string,
  factors: Record<string, string>,
  verdict: TriggerTrial['verdict'],
  over: Partial<TriggerTrial> = {},
): TriggerTrial => ({
  id,
  strategy: 'GUIDED',
  factors,
  actions: [
    { kind: 'NAVIGATE', target: 'http://app.test/dossiers/nouveau', origin: 'reference' },
    { kind: 'FILL', target: 'label:Titre', value: 'Valeur', origin: 'reference' },
    ...Object.keys(factors).map((factor): TriggerAction =>
      factor.startsWith('data:empty')
        ? { kind: 'FILL', target: 'label:Code', value: '', origin: factor }
        : { kind: 'OPEN_DIALOG', target: 'button:Notes', origin: factor },
    ),
    { kind: 'CLICK', target: 'button:Enregistrer', origin: 'probe' },
    { kind: 'CLICK', target: 'button:Actualiser', origin: 'probe' },
  ],
  probes: [2 + Object.keys(factors).length, 3 + Object.keys(factors).length],
  startedAt: '2026-10-31T10:00:00.000Z',
  finishedAt: '2026-10-31T10:00:05.000Z',
  status: 'DONE',
  verdict,
  failures: [],
  events: [],
  snapshots: {},
  key: `${id}-key`,
  cost: { actions: 5, durationMs: 5000 },
  screenshots: [],
  ...over,
});

const CODE = 'data:empty:label:Code';
const NOTES = 'state:dialog:button:Notes';
const FACTORS: Factor[] = [
  {
    id: CODE,
    dimension: 'DATA',
    label: 'vider « Code »',
    actions: [{ kind: 'FILL', target: 'label:Code', value: '' }],
    target: 'label:Code',
    priority: 6,
    origin: 'MODEL',
  },
  {
    id: NOTES,
    dimension: 'STATES',
    label: 'ouvrir puis fermer « Notes »',
    actions: [{ kind: 'OPEN_DIALOG', target: 'button:Notes' }, { kind: 'CLOSE_DIALOG' }],
    target: 'button:Notes',
    priority: 6,
    origin: 'MODEL',
  },
];

describe('post-exploration analysis', () => {
  const reference = trial('tr_001', {}, 'INCONCLUSIVE', { strategy: 'REFERENCE', events: [REQUEST] });
  const codeOnly = trial('tr_002', { [CODE]: 'vider « Code »' }, 'FAILURE_NOT_REPRODUCED');
  const notesOnly = trial('tr_003', { [NOTES]: 'ouvrir puis fermer « Notes »' }, 'FAILURE_NOT_REPRODUCED');
  const error = event('PAGE_ERROR', 'TypeError: Cannot read properties of null', {
    t: 900,
    action: 4,
    level: 'error',
    data: { stack: 'TypeError…\n at enregistrer' },
  });
  const failing = trial(
    'tr_004',
    { [CODE]: 'vider « Code »', [NOTES]: 'ouvrir puis fermer « Notes »' },
    'FAILURE_REPRODUCED',
    {
      strategy: 'CODE_GUIDED',
      events: [
        event('ACTION', 'naviguer', { t: 10, action: 0 }),
        event('RESPONSE', 'GET /dossiers/nouveau 200', { t: 50, data: { status: 200 } }),
        event('ACTION', 'cliquer Enregistrer', { t: 800, action: 4 }),
        error,
        event('ACTION', 'cliquer Actualiser', { t: 1500, action: 5 }),
      ],
      failures: [
        {
          kind: 'EVENT_HANDLER_EXCEPTION',
          summary: 'exception',
          eventIds: [error.id],
          action: 4,
          reactions: [],
        },
        {
          kind: 'HTTP_REQUEST_NOT_EMITTED',
          summary: 'aucune requête',
          eventIds: [],
          action: 4,
          reactions: [],
        },
        { kind: 'GLOBAL_ACTION_FAILURE', summary: '2 sondes muettes', eventIds: [], reactions: [] },
      ],
      repeats: { total: 3, reproduced: 3 },
    },
  );
  const trials = [reference, codeOnly, notesOnly, failing];
  const minimal = {
    actions: failing.actions,
    preconditions: ['page d’entrée'],
    frequency: { reproduced: 3, total: 3 },
    fromTrialId: 'tr_004',
    reducedFrom: 2,
    trialIds: ['tr_004', 'tr_002', 'tr_003'],
    note: 'un seul facteur ne reproduit pas',
  };

  it('derives NECESSARY conditions with their with/without rates from the trials, never from a single run', () => {
    const conditions = deriveConditions(trials, FACTORS, minimal, 0.8);
    const code = conditions.find((condition) => condition.id === `cond:${CODE}`);
    expect(code?.role).toBe('NECESSARY');
    expect(code?.withCondition).toEqual({ reproduced: 1, total: 2 });
    expect(code?.withoutCondition).toEqual({ reproduced: 0, total: 1 });
    expect(code?.source).toBe('EXPERIMENT_VERIFIED');
    expect(conditions.find((condition) => condition.id === `cond:${NOTES}`)?.role).toBe('NECESSARY');
  });

  it('describes the first failure (last request, first error, propagation) and what only failing runs show', () => {
    const first = analyzeFirstFailure(failing, reference, [failing]);
    expect(first?.firstError?.summary).toContain('TypeError');
    expect(first?.firstError?.stack).toContain('enregistrer');
    expect(first?.lastSuccessfulRequest?.summary).toBe('GET /dossiers/nouveau 200');
    expect(first?.propagation.join(' ')).toContain('sans aucune requête HTTP');
    expect(first?.onlyInFailing.some((item) => item.summary.includes('PAGE_ERROR'))).toBe(true);
  });

  it('separates the trigger from the loss factors and never promises a recovery', () => {
    const loss = analyzeDataLoss(
      interpretBrief('la saisie est perdue après F5'),
      failing,
      undefined,
      minimal,
    );
    expect(loss?.unsavedFields).toEqual(expect.arrayContaining(['Titre', 'Code']));
    expect(loss?.triggerSummary).toContain('déclencheur observé');
    expect(loss?.lossFactors.some((item) => item.includes('rechargement'))).toBe(true);
    expect(loss?.note).toContain('aucune récupération automatique');
  });

  it('proposes PROPOSED hypotheses grounded in the observations, each with falsifying verifications (replays need approval)', () => {
    const { hypotheses, experiments } = proposeRootCauses({
      runId: 'trg_1',
      failing,
      reference,
      minimal,
      conditions: [],
      existing: [],
      now: '2026-10-31T10:00:00.000Z',
    });
    expect(hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(
      hypotheses.every(
        (hypothesis) =>
          hypothesis.status === 'PROPOSED' && hypothesis.origin === 'RULE' && hypothesis.confidence < 0.7,
      ),
    ).toBe(true);
    expect(hypotheses[0]?.supporting.some((item) => item.ref.startsWith('trigger:event:'))).toBe(true);
    expect(
      experiments.some(
        (experiment) =>
          experiment.kind === 'REPLAY' && experiment.status === 'APPROVAL_REQUIRED' && experiment.sideEffects,
      ),
    ).toBe(true);
    expect(
      experiments.some(
        (experiment) =>
          experiment.kind === 'CHECK_VALIDATION' &&
          experiment.status === 'PROPOSED' &&
          !experiment.sideEffects,
      ),
    ).toBe(true);
    expect(experiments.every((experiment) => experiment.id.startsWith('exp_trig_trg_1_'))).toBe(true);
    // Un titre déjà présent n'est pas dupliqué.
    const again = proposeRootCauses({
      runId: 'trg_2',
      failing,
      reference,
      minimal,
      conditions: [],
      existing: hypotheses,
      now: '2026-10-31T10:00:00.000Z',
    });
    expect(again.hypotheses).toHaveLength(0);
  });

  const incident = (): Incident => ({
    id: 'inc_1',
    projectId: 'p',
    title: 'Enregistrer ne réagit plus',
    description: 'd',
    observed: 'o',
    expected: 'e',
    severity: 'HIGH',
    execution: { target: 'LOCAL' },
    scope: defaultScope(),
    state: 'INVESTIGATING',
    revision: 1,
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-10-31T10:00:00.000Z',
    createdBy: 'a',
    history: [],
    investigation: { reproductions: [], hypotheses: [], experiments: [] },
  });
  const run = (): TriggerRun => ({
    id: 'trg_1',
    depth: 'STANDARD',
    state: 'COMPLETED',
    startedAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-10-31T10:05:00.000Z',
    startedBy: 'analyste',
    budget: {
      maxDurationMs: 600_000,
      maxTrials: 60,
      maxActions: 900,
      maxRepeats: 3,
      maxExperiments: 6,
      maxEvents: 20_000,
      maxAiCalls: 10,
      maxBrowsers: 1,
    },
    usage: { durationMs: 60_000, trials: 4, actions: 20, repeats: 2, experiments: 0, events: 40, aiCalls: 0 },
    strategies: [
      { strategy: 'REFERENCE', trials: 1, reproduced: 0 },
      { strategy: 'CODE_GUIDED', trials: 1, reproduced: 1 },
    ],
    trials,
    reference: { 'button:Enregistrer': REFERENCE, 'button:Actualiser': REFRESH },
    conditions: deriveConditions(trials, FACTORS, minimal, 0.8),
    minimal,
    hypothesisIds: [],
    pendingExperimentIds: [],
    coverage: [{ dimension: 'DATA', explored: 1, known: 8 }],
    limitations: ['essais tronqués'],
  });

  it('turns the minimal sequence into a PROPOSED library flow: trigger steps, one probe, the reference request in 2xx, no error shown', () => {
    const { proposal, unexpressed } = buildTriggerRegression(incident(), run());
    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.basedOn).toBe('trigger:trg_1');
    expect(proposal.execution).toBeUndefined();
    expect(proposal.flowYaml).toContain('goto: http://app.test/dossiers/nouveau');
    expect(proposal.flowYaml).toContain('label: Code');
    expect(proposal.flowYaml).toContain('name: Notes');
    expect(proposal.flowYaml).toContain('allow: MUTATION');
    expect(proposal.flowYaml).toContain('url: /api/dossiers');
    expect(proposal.flowYaml).toContain('status: 2xx');
    expect(proposal.flowYaml).toContain('noError: true');
    expect(proposal.flowYaml.match(/name: Enregistrer/g)).toHaveLength(1);
    expect(unexpressed).toEqual([]);
  });

  it('writes a report that states observations, rates, coverage and limitations without confirming a cause', () => {
    const report = buildTriggerReport(incident(), run(), '2026-10-31T10:06:00.000Z');
    expect(report.sections.summary?.join(' ')).toContain('Déclencheur reproduit');
    expect(report.sections.conditions?.some((line) => line.startsWith('NECESSARY'))).toBe(true);
    expect(report.sections.coverage).toEqual(['DATA : 1 / 8']);
    expect(report.sections.limitations).toEqual(['essais tronqués']);
    expect(JSON.stringify(report.sections)).not.toMatch(/cause (racine )?confirmée/i);
  });
});
