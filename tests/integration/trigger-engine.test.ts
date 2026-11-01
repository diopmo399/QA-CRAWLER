import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeAngular } from '../../src/incident/code/angular.js';
import { guardedFiles } from '../../src/incident/guarded-fs.js';
import type { Incident } from '../../src/incident/model.js';
import { ScopePolicy } from '../../src/incident/scope-policy.js';
import { defaultScope } from '../../src/incident/scope.js';
import { interpretBrief } from '../../src/incident/trigger/brief.js';
import {
  TriggerEngine,
  type TriggerEngineInput,
  type TriggerEngineOutcome,
} from '../../src/incident/trigger/engine.js';
import type { AngularModel, TriggerRun } from '../../src/sdk/core/incident-trigger-contracts.js';
import { isFactorAction } from '../../src/incident/trigger/model.js';
import { startAngularSite, type AngularSite } from '../fixtures/angular-site.js';

/**
 * LE MOTEUR DE DÉCOUVERTE DES DÉCLENCHEURS SUR UNE VRAIE PAGE (Chromium) : l'application « Dossiers » dont le
 * défaut ne se déclenche que par la combinaison « Code vidé » puis « dialogue Notes ouvert et fermé » avant
 * « Enregistrer ». La description ne cite aucune de ces conditions. Le moteur doit : établir la référence,
 * écarter les faux positifs (un seul des deux facteurs ne reproduit pas), reproduire, répéter, minimiser,
 * dériver les conditions, analyser la première défaillance et la perte de données, proposer des hypothèses et
 * des vérifications (dont une jouée sans effet de bord), et générer un test de non-régression PROPOSÉ.
 */
const APP_ROOT = path.resolve('tests/fixtures/angular-app');
const DESCRIPTION =
  'Dans la création de dossier, après une erreur JavaScript survenue dans des circonstances inconnues, le bouton Enregistrer ne fait plus rien : aucune validation, aucun chargement, aucune requête HTTP. Un rafraîchissement (F5) remet tout en état mais la saisie est perdue.';

let site: AngularSite;
let browser: Browser;
let angular: AngularModel;
let policy: ScopePolicy;
let incident: Incident;

/** La valeur, ou l'échec du test : jamais une assertion non nulle silencieuse. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
}

function control(options: { cancelAfterTrials?: number; run?: () => TriggerRun | undefined } = {}) {
  return {
    cancelled: () =>
      options.cancelAfterTrials !== undefined
        ? (options.run?.()?.usage.trials ?? 0) >= options.cancelAfterTrials
        : false,
    paused: () => false,
    waitWhilePaused: () => Promise.resolve(),
  };
}

function inputs(overrides: Partial<TriggerEngineInput> = {}): TriggerEngineInput {
  return {
    runId: 'trg_test',
    startedBy: 'analyste',
    incident,
    brief: interpretBrief(DESCRIPTION, { title: incident.title, now: new Date().toISOString() }),
    depth: 'STANDARD',
    budget: { maxTrials: 40, maxDurationMs: 5 * 60_000 },
    baseUrl: site.url,
    allowedHosts: [new URL(site.url).host],
    check: (operation) => policy.check(operation),
    angular: [angular],
    existingHypotheses: [],
    browser,
    settleMs: 250,
    control: control(),
    ...overrides,
  };
}

beforeAll(async () => {
  site = await startAngularSite();
  browser = await chromium.launch({ headless: true, handleSIGINT: false });
  const scope = defaultScope({
    applications: [
      {
        id: 'dossiers-web',
        name: 'Dossiers (web)',
        layer: 'FRONTEND',
        repository: { root: APP_ROOT, include: ['src'] },
      },
    ],
    allowedHosts: [new URL(site.url).host],
  });
  policy = new ScopePolicy(scope);
  angular = await analyzeAngular(must(scope.applications[0], 'application'), guardedFiles(policy));
  incident = {
    id: 'inc_dossiers01',
    projectId: 'dossiers',
    title: 'Enregistrer ne réagit plus après une erreur JS',
    description: DESCRIPTION,
    observed: 'les boutons ne déclenchent plus rien',
    expected: 'le dossier est créé',
    severity: 'HIGH',
    application: 'Dossiers',
    execution: { target: 'LOCAL' },
    scope,
    state: 'INVESTIGATING',
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 'analyste',
    history: [],
    investigation: { reproductions: [], hypotheses: [], experiments: [] },
  };
}, 120_000);

afterAll(async () => {
  await browser.close();
  await site.close();
});

describe('trigger discovery engine on the Dossiers application', () => {
  let outcome: TriggerEngineOutcome;

  it('finds the two-factor trigger from a description that names neither condition', async () => {
    const states: string[] = [];
    const engine = new TriggerEngine(
      inputs({
        onProgress: (run) => {
          if (states.at(-1) !== run.state) states.push(run.state);
        },
      }),
    );
    outcome = await engine.execute();
    const { run } = outcome;
    expect(['COMPLETED', 'WAITING_FOR_APPROVAL']).toContain(run.state);
    expect(states).toEqual(
      expect.arrayContaining([
        'DISCOVERING_SCOPE',
        'EXPLORING_TRIGGERS',
        'FAILURE_DETECTED',
        'CONFIRMING_REPRODUCTION',
        'MINIMIZING',
        'ANALYZING_ROOT_CAUSE',
        'VERIFYING_HYPOTHESES',
      ]),
    );
    // La référence : le parcours sain émet la requête d'enregistrement.
    const reference = run.trials.find((trial) => trial.strategy === 'REFERENCE');
    expect(reference?.verdict).toBe('INCONCLUSIVE');
    expect(run.reference['button:Enregistrer']?.request).toEqual({ method: 'POST', path: '/api/dossiers' });
    expect(site.calls.some((call) => call.method === 'POST' && call.path === '/api/dossiers')).toBe(true);
    // Le déclencheur reproduit : les deux facteurs, et ni l'un ni l'autre seul.
    const reproduced = must(
      run.trials.find((trial) => trial.verdict === 'FAILURE_REPRODUCED'),
      'a reproducing trial',
    );
    expect(Object.keys(reproduced.factors)).toEqual(
      expect.arrayContaining(['data:empty:label:Code', 'state:dialog:button:Notes']),
    );
    const codeOnly = run.trials.find(
      (trial) => Object.keys(trial.factors).join() === 'data:empty:label:Code',
    );
    expect(codeOnly?.verdict).toBe('FAILURE_NOT_REPRODUCED');
    expect(reproduced.failures.map((failure) => failure.kind)).toEqual(
      expect.arrayContaining([
        'EVENT_HANDLER_EXCEPTION',
        'HTTP_REQUEST_NOT_EMITTED',
        'GLOBAL_ACTION_FAILURE',
      ]),
    );
    expect(reproduced.firstError?.summary).toMatch(/TypeError|null/);
    // Répétition, minimisation, conditions.
    expect(reproduced.repeats?.total).toBeGreaterThanOrEqual(2);
    const minimal = must(run.minimal, 'minimal reproduction');
    const minimalFactors = new Set(minimal.actions.filter(isFactorAction).map((action) => action.origin));
    expect([...minimalFactors].sort()).toEqual(['data:empty:label:Code', 'state:dialog:button:Notes']);
    expect(minimal.preconditions.join(' | ')).toContain('/dossiers/nouveau');
    const necessary = run.conditions
      .filter((condition) => condition.role === 'NECESSARY')
      .map((condition) => condition.id);
    expect(necessary).toEqual(
      expect.arrayContaining(['cond:data:empty:label:Code', 'cond:state:dialog:button:Notes']),
    );
    // Première défaillance et perte de données.
    expect(run.firstFailure?.firstError?.summary).toMatch(/TypeError|null/);
    expect(run.firstFailure?.propagation.join(' ')).toMatch(
      /sans aucune requête HTTP|HTTP_REQUEST_NOT_EMITTED/,
    );
    expect(run.dataLoss?.unsavedFields).toEqual(expect.arrayContaining(['Titre']));
    expect(run.dataLoss?.lossFactors.join(' ')).toContain('aucune sauvegarde locale');
    // Hypothèses PROPOSED, vérifications : la validation jouée (sans effet de bord), le rejouage en attente.
    expect(outcome.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(outcome.hypotheses.every((hypothesis) => hypothesis.status === 'PROPOSED')).toBe(true);
    expect(
      outcome.hypotheses.some((hypothesis) => /Exception dans un gestionnaire/.test(hypothesis.title)),
    ).toBe(true);
    const check = outcome.experiments.find((experiment) => experiment.kind === 'CHECK_VALIDATION');
    expect(check?.status).toBe('DONE');
    // Le champ « Titre » n'a pas de validation : l'expérience le dit (NEUTRAL) au lieu d'inventer un soutien.
    expect(check?.outcome).toBe('NEUTRAL');
    expect(check?.summary).toContain('non observable');
    expect(check?.evidence).toHaveLength(2);
    expect(
      outcome.experiments.some(
        (experiment) => experiment.kind === 'REPLAY' && experiment.status === 'APPROVAL_REQUIRED',
      ),
    ).toBe(true);
    expect(run.pendingExperimentIds.length).toBeGreaterThan(0);
    // Périmètre découvert, couverture, test de non-régression proposé.
    expect(
      run.scope?.resources.some(
        (resource) =>
          resource.kind === 'ROUTE' &&
          resource.ref === '/dossiers/nouveau' &&
          resource.status === 'AUTHORIZED',
      ),
    ).toBe(true);
    expect(
      run.scope?.resources.some(
        (resource) => resource.kind === 'API' && /\/api\/dossiers/.test(resource.ref),
      ),
    ).toBe(true);
    const sequences = run.coverage.find((item) => item.dimension === 'SEQUENCES');
    // Les séquences distinctes jouées (les rejouages et les expériences ne comptent qu'une fois).
    expect(sequences?.explored).toBe(new Set(run.trials.map((trial) => trial.key)).size);
    expect(must(sequences, 'sequences coverage').known).toBeGreaterThanOrEqual(
      must(sequences, 'sequences coverage').explored,
    );
    expect(outcome.regression?.status).toBe('PROPOSED');
    expect(outcome.regression?.flowYaml).toContain('Enregistrer');
    expect(outcome.regression?.flowYaml).toContain('noError: true');
    expect(outcome.regression?.flowYaml).toContain('Fermer');
    expect(outcome.regression?.execution).toBeUndefined();
  }, 240_000);

  it('stays INCONCLUSIVE, with coverage and limitations, when QUICK exploration without code finds nothing', async () => {
    const engine = new TriggerEngine(inputs({ depth: 'QUICK', angular: [], budget: { maxTrials: 5 } }));
    const { run, hypotheses, regression } = await engine.execute();
    expect(run.state).toBe('INCONCLUSIVE');
    expect(run.stopReason).toMatch(/budget épuisé|aucune séquence/);
    expect(run.trials.some((trial) => trial.verdict === 'FAILURE_REPRODUCED')).toBe(false);
    expect(hypotheses).toEqual([]);
    expect(regression).toBeUndefined();
    expect(run.coverage.length).toBeGreaterThan(0);
    expect(run.brief?.symptoms.every((item) => item.source === 'USER_REPORTED')).toBe(true);
    expect(run.resumePoint).toBeDefined();
  }, 120_000);

  it('resumes an interrupted run from its resume point without replaying the sequences already played', async () => {
    // Sans le code, le budget de deux essais ne suffit pas ; la reprise dispose du code analysé.
    const first = await new TriggerEngine(inputs({ angular: [], budget: { maxTrials: 2 } })).execute();
    expect(first.run.state).toBe('INCONCLUSIVE');
    expect(first.run.usage.trials).toBe(2);
    const resumed = await new TriggerEngine(
      inputs({ budget: { maxTrials: 40 }, resumeFrom: first.run }),
    ).execute();
    const { run } = resumed;
    expect(run.id).toBe(first.run.id);
    expect(run.limitations.some((item) => item.startsWith('reprise le'))).toBe(true);
    expect(run.trials.slice(0, 2).map((trial) => trial.id)).toEqual(
      first.run.trials.map((trial) => trial.id),
    );
    expect(run.trials.filter((trial) => trial.strategy === 'REFERENCE')).toHaveLength(1);
    const keys = run.trials
      .filter((trial) => !['REPETITION', 'MINIMIZATION', 'EXPERIMENT'].includes(trial.strategy))
      .map((trial) => trial.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      run.trials.some((trial) => trial.verdict === 'FAILURE_REPRODUCED'),
      JSON.stringify({
        state: run.state,
        stop: run.stopReason,
        limitations: run.limitations,
        trials: run.trials.length,
      }),
    ).toBe(true);
    expect(run.usage.trials).toBeGreaterThan(first.run.usage.trials);
  }, 240_000);

  it('measures an intermittent defect: frequency below 1 and an explicit correlation limitation', async () => {
    site.flaky = true;
    try {
      const { run } = await new TriggerEngine(inputs({ repeats: 4, budget: { maxTrials: 40 } })).execute();
      const reproduced = run.trials.find((trial) => trial.verdict === 'FAILURE_REPRODUCED' && trial.repeats);
      expect(reproduced?.repeats?.total).toBe(4);
      expect(must(reproduced?.repeats, 'repeats').reproduced).toBeLessThan(4);
      expect(run.limitations.some((item) => /intermittent/.test(item))).toBe(true);
      expect(run.minimal?.frequency.total).toBeGreaterThanOrEqual(1);
    } finally {
      site.flaky = false;
    }
  }, 240_000);

  it('cancels cooperatively and keeps a partial report', async () => {
    let current: TriggerRun | undefined;
    const { run } = await new TriggerEngine(
      inputs({
        control: control({ cancelAfterTrials: 2, run: () => current }),
        onProgress: (progress) => {
          current = progress;
        },
      }),
    ).execute();
    expect(run.state).toBe('CANCELLED');
    expect(run.stopReason).toContain('annulé');
    expect(run.usage.trials).toBeLessThanOrEqual(3);
    expect(run.coverage.length).toBeGreaterThan(0);
    expect(run.finishedAt).toBeDefined();
  }, 120_000);

  it('pauses between trials and resumes when asked', async () => {
    let paused = false;
    let pausedOnce = false;
    const states: string[] = [];
    const { run } = await new TriggerEngine(
      inputs({
        budget: { maxTrials: 40 },
        control: {
          cancelled: () => false,
          paused: () => paused,
          waitWhilePaused: () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                paused = false;
                resolve();
              }, 300);
            }),
        },
        onProgress: (progress) => {
          states.push(progress.state);
          if (progress.usage.trials === 1 && !pausedOnce) {
            pausedOnce = true;
            paused = true;
          }
        },
      }),
    ).execute();
    expect(states).toContain('PAUSED');
    expect(['COMPLETED', 'WAITING_FOR_APPROVAL']).toContain(run.state);
  }, 240_000);

  it('refuses to explore when the Scope Policy Engine denies the navigation', async () => {
    const { run } = await new TriggerEngine(
      inputs({
        check: (operation) =>
          operation.kind === 'NAVIGATE'
            ? Promise.resolve({ allowed: false, reason: 'hôte hors périmètre', rule: 'test', operation })
            : policy.check(operation),
      }),
    ).execute();
    expect(run.state).toBe('INCONCLUSIVE');
    expect(run.stopReason).toContain('périmètre');
    expect(run.trials).toHaveLength(0);
    expect(
      run.scope?.resources
        .filter((resource) => resource.kind === 'ROUTE')
        .every((resource) => resource.status === 'DENIED'),
    ).toBe(true);
  }, 60_000);

  it('keeps going deterministically when the AI hook fails, and records the limitation', async () => {
    const { run } = await new TriggerEngine(
      inputs({
        depth: 'DEEP',
        angular: [],
        budget: { maxTrials: 8 },
        proposeWithAi: () => Promise.reject(new Error('modèle indisponible (401)')),
      }),
    ).execute();
    expect(run.usage.aiCalls).toBe(1);
    expect(run.limitations.some((item) => /IA indisponible/.test(item) && /401/.test(item))).toBe(true);
    expect(run.state).toBe('INCONCLUSIVE');
    expect(run.usage.trials).toBe(8);
  }, 180_000);

  it('plays an AI-proposed sequence like any other and lets the oracle judge it', async () => {
    const asked: string[][] = [];
    const { run, hypotheses } = await new TriggerEngine(
      inputs({
        depth: 'DEEP',
        angular: [],
        budget: { maxTrials: 24 },
        proposeWithAi: (context) => {
          asked.push(context.factors.map((factor) => factor.id));
          return Promise.resolve([
            ['data:empty:label:Code', 'state:dialog:button:Notes'],
            ['facteur:inconnu'],
          ]);
        },
      }),
    ).execute();
    expect(asked).toHaveLength(1);
    const aiTrial = run.trials.find((trial) => trial.strategy === 'AI_GUIDED');
    expect(aiTrial?.verdict).toBe('FAILURE_REPRODUCED');
    expect(run.strategies.find((item) => item.strategy === 'AI_GUIDED')?.reproduced).toBe(1);
    expect(hypotheses.every((hypothesis) => hypothesis.origin === 'RULE')).toBe(true);
  }, 240_000);
});
