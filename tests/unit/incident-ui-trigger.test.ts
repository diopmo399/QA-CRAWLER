import { describe, expect, it } from 'vitest';
import type { Right } from '../../src/sdk/core/contracts.js';
import type { Incident } from '../../src/sdk/core/incident-contracts.js';
import type { TriggerRun } from '../../src/sdk/core/incident-trigger-contracts.js';
import { demoIncident } from '../../src/sdk/ui/incident-demo.js';
import { workspaceLinks } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type Lang, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';
import {
  TRIGGER_SECTIONS,
  emptyTriggerUi,
  reduceTrigger,
  renderTriggerSection,
  shownTriggerRun,
  triggerActive,
  type TriggerUi,
} from '../../src/sdk/ui/incident-trigger.js';
import { DEMO_DISABLED_ACTIONS, disableForDemo } from '../../src/sdk/ui/incident-workspace.js';

/**
 * L'ONGLET « DÉCLENCHEURS » : chaque section se rend sans run (invitation), puis avec un run : état, budget,
 * provenance de la description, statuts du périmètre, matrice, chronologie d'un essai, séquence minimale,
 * hypothèses PROPOSED avec leurs vérifications à trancher (DECIDE), test proposé jamais « validé ». Le réducteur
 * ne touche qu'à l'état d'affichage ; en démonstration, les opérations serveur sont désactivées.
 */
const ALL: Right[] = ['RUN', 'DECIDE', 'PUBLISH', 'RUN_WRITES'];

const run = (over: Partial<TriggerRun> = {}): TriggerRun => ({
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
  usage: { durationMs: 61_000, trials: 7, actions: 40, repeats: 2, experiments: 1, events: 120, aiCalls: 0 },
  brief: {
    language: 'fr',
    rawText: 'Après une erreur JS, Enregistrer ne fait plus rien.',
    functionalArea: { text: 'création de dossier', source: 'USER_REPORTED' },
    symptoms: [{ text: 'Enregistrer ne fait plus rien', source: 'USER_REPORTED' }],
    knownConditions: [],
    unknownConditions: [{ text: 'circonstances inconnues', source: 'USER_REPORTED' }],
    environment: [],
    suspectedFailures: ['GLOBAL_ACTION_FAILURE'],
    keywords: ['enregistrer'],
    interpretedAt: '2026-10-31T10:00:00.000Z',
  },
  scope: {
    resources: [
      {
        id: 'route:/dossiers/nouveau',
        kind: 'ROUTE',
        label: '/dossiers/nouveau',
        ref: '/dossiers/nouveau',
        status: 'AUTHORIZED',
        foundBy: ['STATIC'],
        relevance: 0.8,
      },
      {
        id: 'host:x',
        kind: 'DEPENDENCY',
        label: 'api.externe.test',
        ref: 'api.externe.test',
        status: 'DENIED',
        foundBy: ['TEXT'],
        relevance: 0.2,
        detail: 'hôte hors périmètre',
      },
    ],
    edges: [],
    discoveredAt: '2026-10-31T10:00:01.000Z',
  },
  strategies: [
    { strategy: 'REFERENCE', trials: 1, reproduced: 0 },
    { strategy: 'CODE_GUIDED', trials: 1, reproduced: 1 },
  ],
  trials: [
    {
      id: 'tr_001',
      strategy: 'REFERENCE',
      factors: {},
      actions: [],
      probes: [],
      startedAt: '2026-10-31T10:00:02.000Z',
      status: 'DONE',
      verdict: 'INCONCLUSIVE',
      failures: [],
      events: [],
      snapshots: {},
      key: 'k1',
      cost: { actions: 5, durationMs: 3000 },
      screenshots: [],
    },
    {
      id: 'tr_002',
      strategy: 'CODE_GUIDED',
      factors: {
        'data:empty:label:Code': 'vider « Code »',
        'state:dialog:button:Notes': 'ouvrir puis fermer « Notes »',
      },
      actions: [
        { kind: 'NAVIGATE', target: 'http://app.test/dossiers/nouveau', origin: 'reference' },
        { kind: 'FILL', target: 'label:Code', value: '', origin: 'data:empty:label:Code' },
        { kind: 'CLICK', target: 'button:Enregistrer', origin: 'probe' },
      ],
      probes: [2],
      startedAt: '2026-10-31T10:00:10.000Z',
      status: 'DONE',
      verdict: 'FAILURE_REPRODUCED',
      reason: 'aucune requête POST /api/dossiers',
      failures: [{ kind: 'GLOBAL_ACTION_FAILURE', summary: '2 sondes muettes', eventIds: [], reactions: [] }],
      firstError: { eventId: 'ev_3', t: 900, summary: 'TypeError: Cannot read properties of null' },
      events: [
        {
          id: 'ev_3',
          t: 900,
          at: '2026-10-31T10:00:11.000Z',
          kind: 'PAGE_ERROR',
          summary: 'TypeError: Cannot read properties of null',
          level: 'error',
          action: 2,
        },
      ],
      snapshots: {},
      repeats: { total: 3, reproduced: 3 },
      key: 'k2',
      cost: { actions: 6, durationMs: 4000 },
      screenshots: [],
    },
  ],
  reference: { 'button:Enregistrer': { request: { method: 'POST', path: '/api/dossiers' } } },
  conditions: [
    {
      id: 'cond:data:empty:label:Code',
      description: 'vider « Code »',
      actions: [],
      role: 'NECESSARY',
      withCondition: { reproduced: 3, total: 4 },
      withoutCondition: { reproduced: 0, total: 2 },
      source: 'EXPERIMENT_VERIFIED',
      trialIds: ['tr_002'],
    },
  ],
  minimal: {
    actions: [
      { kind: 'FILL', target: 'label:Code', value: '', origin: 'data:empty:label:Code' },
      { kind: 'OPEN_DIALOG', target: 'button:Notes', origin: 'state:dialog:button:Notes' },
      { kind: 'CLOSE_DIALOG', origin: 'state:dialog:button:Notes' },
      { kind: 'CLICK', target: 'button:Enregistrer', origin: 'probe' },
    ],
    preconditions: ['page d’entrée : /dossiers/nouveau'],
    frequency: { reproduced: 3, total: 3 },
    fromTrialId: 'tr_002',
    reducedFrom: 2,
    trialIds: ['tr_002'],
    note: 'd’autres séquences minimales peuvent exister',
  },
  firstFailure: {
    propagation: ['erreur de page à t+900 ms'],
    onlyInFailing: [],
    note: 'Chronologie observée',
  },
  dataLoss: {
    unsavedFields: ['Titre'],
    persistenceFound: [],
    lossFactors: ['le rechargement réinitialise l’état'],
    note: 'aucune récupération automatique n’est promise',
  },
  hypothesisIds: ['hyp_trig_trg_1_1'],
  pendingExperimentIds: ['exp_trig_trg_1_1_1'],
  coverage: [
    { dimension: 'DATA', explored: 2, known: 9 },
    { dimension: 'SEQUENCES', explored: 6, known: 40, note: 'jamais un produit cartésien complet' },
  ],
  limitations: ['essais tronqués'],
  ...over,
});

const incident = (over: Partial<Incident> = {}, runs: TriggerRun[] = [run()]): Incident => {
  const base = demoIncident();
  return {
    ...base,
    investigation: {
      ...base.investigation,
      hypotheses: [
        ...base.investigation.hypotheses,
        {
          id: 'hyp_trig_trg_1_1',
          title: 'Indicateur d’occupation resté actif',
          description: 'Après la séquence…',
          suspectedCause: 'indicateur jamais remis à faux',
          layer: 'FRONTEND',
          files: [],
          supporting: [],
          contradicting: [],
          confidence: 0.5,
          verifications: [],
          status: 'PROPOSED',
          origin: 'RULE',
        },
      ],
      experiments: [
        ...base.investigation.experiments,
        {
          id: 'exp_trig_trg_1_1_1',
          kind: 'REPLAY',
          hypothesisId: 'hyp_trig_trg_1_1',
          description: 'Rejouer la séquence minimale',
          params: {},
          status: 'APPROVAL_REQUIRED',
          sideEffects: true,
          decisions: [],
          evidence: [],
        },
      ],
      regression: {
        name: 'Non-régression — déclencheur',
        basedOn: 'trigger:trg_1',
        flowYaml: 'flows:\n  - name: x\n    steps: []\n',
        expected: 'POST /api/dossiers répond en 2xx',
        status: 'PROPOSED',
      },
      trigger: { brief: runs[0]?.brief, runs },
    },
    ...over,
  };
};

const ctxOf = (
  inc: Incident,
  options: { rights?: Right[]; lang?: Lang; demo?: boolean } = {},
): WorkspaceContext => {
  const rights = options.rights ?? ALL;
  return workspaceContext({
    incident: inc,
    lang: options.lang ?? 'fr',
    links: workspaceLinks(inc),
    demo: options.demo ?? false,
    can: (right) => rights.includes(right),
  });
};

const ui = (over: Partial<TriggerUi> = {}): TriggerUi => ({ ...emptyTriggerUi(), ...over });

describe('trigger tab — rendering', () => {
  it('renders every section without a run as an invitation to start', () => {
    const ctx = ctxOf(incident({}, []));
    for (const section of TRIGGER_SECTIONS) {
      const html = renderTriggerSection(ctx, ui(), section);
      expect(html, section).toContain(`data-section="${section}"`);
      expect(html, section).not.toContain('undefined');
    }
    expect(renderTriggerSection(ctx, ui(), 'brief')).toContain('data-action="ws-trg-start"');
    expect(renderTriggerSection(ctx, ui(), 'matrix')).toContain('Aucun run');
  });

  it('shows the brief with provenance pills, the run state, the budget usage and the scope statuses', () => {
    const ctx = ctxOf(incident());
    const brief = renderTriggerSection(ctx, ui(), 'brief');
    expect(brief).toContain('création de dossier');
    expect(brief).toContain('>déclaré<');
    expect(brief).toContain('Terminé');
    expect(brief).toContain('7 / 60');
    expect(brief).toContain('essais tronqués');
    expect(brief).toContain('data-action="ws-trg-extend"');
    const discovery = renderTriggerSection(ctx, ui(), 'discovery');
    expect(discovery).toContain('data-status="AUTHORIZED"');
    expect(discovery).toContain('data-status="DENIED"');
    expect(discovery).toContain('hôte hors périmètre');
    expect(discovery).toContain('Découvrir une ressource n’accorde aucun droit');
  });

  it('shows the matrix, the trial timeline, the minimal sequence, the causes with decisions and the proposed test', () => {
    const ctx = ctxOf(incident());
    const matrix = renderTriggerSection(ctx, ui(), 'matrix');
    expect(matrix).toContain('data-action="ws-trg-trial" data-trial="tr_002"');
    expect(matrix).toContain('data-verdict="FAILURE_REPRODUCED"');
    expect(matrix).toContain('3/3');
    const events = renderTriggerSection(ctx, ui({ trialId: 'tr_002' }), 'events');
    expect(events).toContain('TypeError');
    expect(events).toContain('data-kind="PAGE_ERROR"');
    const minimal = renderTriggerSection(ctx, ui(), 'minimal');
    expect(minimal).toContain('Code = «vide»');
    expect(minimal).toContain('ouvrir « Notes »');
    expect(minimal).toContain('aucune récupération automatique');
    const explorer = renderTriggerSection(ctx, ui(), 'explorer');
    expect(explorer).toContain('data-role="NECESSARY"');
    expect(explorer).toContain('3/4');
    expect(explorer).toContain('jamais un produit cartésien complet');
    const causes = renderTriggerSection(ctx, ui(), 'causes');
    expect(causes).toContain('Indicateur d’occupation resté actif');
    expect(causes).toContain('data-status="PROPOSED"');
    expect(causes).toContain('data-action="ws-trg-approve" data-experiment="exp_trig_trg_1_1_1"');
    expect(causes).toContain('effets de bord');
    expect(causes).not.toContain('confirmée');
    const proposal = renderTriggerSection(ctx, ui(), 'proposal');
    expect(proposal).toContain('Non-régression — déclencheur');
    expect(proposal).toContain('>GENERATED<');
    expect(proposal).toContain('jamais « validé » sans exécution');
  });

  it('disables decisions without DECIDE, and every server operation in demonstration', () => {
    const noDecide = renderTriggerSection(ctxOf(incident(), { rights: ['RUN'] }), ui(), 'causes');
    expect(noDecide).toMatch(/data-action="ws-trg-approve"[^>]*disabled/);
    const demo = disableForDemo(renderTriggerSection(ctxOf(incident(), { demo: true }), ui(), 'brief'), 'fr');
    expect(demo).toMatch(/<button disabled[^>]*data-action="ws-trg-start"/);
    expect(DEMO_DISABLED_ACTIONS).toEqual(
      expect.arrayContaining(['ws-trg-start', 'ws-trg-approve', 'ws-trg-describe']),
    );
  });

  it('shows pause/cancel while active and reads English labels', () => {
    const active = incident({}, [run({ state: 'EXPLORING_TRIGGERS' })]);
    expect(triggerActive(active)).toBe(true);
    const html = renderTriggerSection(ctxOf(active, { lang: 'en' }), ui(), 'live');
    expect(html).toContain('data-action="ws-trg-pause"');
    expect(html).toContain('data-action="ws-trg-cancel"');
    expect(html).toContain('Exploring triggers');
    expect(shownTriggerRun(active, { runId: 'nope' })?.id).toBe('trg_1');
  });
});

describe('trigger tab — reducer', () => {
  it('changes depth, run, trial, confirmation and fields; ignores unknown values and foreign actions', () => {
    const base = ui();
    expect(reduceTrigger(base, 'ws-trg-depth', { depth: 'DEEP' })?.depth).toBe('DEEP');
    expect(reduceTrigger(base, 'ws-trg-depth', { depth: 'ULTRA' })).toBeUndefined();
    expect(reduceTrigger(base, 'ws-trg-run', { run: 'trg_2' })).toMatchObject({ runId: 'trg_2' });
    expect(reduceTrigger(base, 'ws-trg-trial', { trial: 'tr_002' })?.trialId).toBe('tr_002');
    expect(reduceTrigger(base, 'ws-trg-cancel', {})?.confirmCancel).toBe(true);
    expect(reduceTrigger({ ...base, confirmCancel: true }, 'ws-trg-cancel-no', {})?.confirmCancel).toBe(
      false,
    );
    expect(
      reduceTrigger({ ...base, errors: { start: 'x' } }, 'ws-trg-dismiss', { slot: 'start' })?.errors,
    ).toEqual({});
    expect(
      reduceTrigger(base, 'ws-trg-field', { field: 'trg.description', value: 'texte' })?.description,
    ).toBe('texte');
    expect(reduceTrigger(base, 'ws-trg-field', { field: 'trg.extendValue', value: '12a' })?.extendValue).toBe(
      '12',
    );
    expect(
      reduceTrigger(base, 'ws-trg-field', { field: 'trg.extendKey', value: 'maxTrials' })?.extendKey,
    ).toBe('maxTrials');
    expect(
      reduceTrigger(base, 'ws-trg-field', { field: 'trg.extendKey', value: 'maxBrowsers' }),
    ).toBeUndefined();
    expect(reduceTrigger(base, 'ws-ai-depth', { depth: 'DEEP' })).toBeUndefined();
  });
});
