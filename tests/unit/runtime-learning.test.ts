import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stateCodeOf } from '../../src/forms/state/form-knowledge-observer.js';
import { FunctionalIntelligence } from '../../src/functional/functional-intelligence.js';
import { judgeGoalAction } from '../../src/functional/goal-safety.js';
import type { FunctionalActionObservation, ScreenFacts } from '../../src/functional/model.js';
import { RuntimeLearner, apiTemplate, intentOf } from '../../src/functional/runtime-learning.js';
import { FunctionalKnowledgeStore } from '../../src/knowledge/functional-knowledge-store.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

const screen = (status: string, buttons: string[]): ScreenFacts => ({
  url: 'http://localhost/dossiers/42',
  route: '/dossiers/42',
  text: `Dossier 42\nStatut : ${status}`,
  buttons: buttons.map((label) => ({ label, enabled: true })),
  alerts: [],
  invalidFields: [],
  fields: [],
  selections: {},
});

/** Ouvrir le dossier (GET : PENDING), puis « Approuver » (PATCH accepté : APPROVED). */
function approveSequence(responseAfter = 'APPROVED'): FunctionalActionObservation[] {
  return [
    {
      actionId: 'open',
      label: 'Dossier 42',
      type: 'click',
      exchanges: [
        {
          method: 'GET',
          path: '/api/dossiers/42',
          status: 200,
          responseState: { field: 'status', code: 'PENDING' },
        },
      ],
      after: screen('PENDING', ['Approuver', 'Refuser']),
    },
    {
      actionId: 'approve',
      label: 'Approuver',
      type: 'click',
      before: screen('PENDING', ['Approuver', 'Refuser']),
      after: screen(responseAfter, responseAfter === 'APPROVED' ? ['Annuler'] : ['Approuver', 'Refuser']),
      exchanges: [
        {
          method: 'PATCH',
          path: '/api/dossiers/42',
          status: 200,
          requestFields: { status: { type: 'string' } },
          requestState: { field: 'status', code: 'APPROVED' },
          responseState: { field: 'status', code: responseAfter },
        },
      ],
    },
  ];
}

function intelligence(store?: FunctionalKnowledgeStore, yaml = ''): FunctionalIntelligence {
  const config = testConfig(
    `safety:\n  allowedActionClasses: [SAFE, MUTATION]\nfunctionalIntelligence:\n  enabled: true\n${yaml}`,
  );
  const policy = new SafetyPolicy(config.safety);
  return new FunctionalIntelligence({
    config: config.functionalIntelligence,
    salt: 'salt',
    safety: (target) => judgeGoalAction(policy, target.actionLabel),
    emit: () => undefined,
    ...(store ? { store } : {}),
  });
}

describe('runtime learning: the network says what the code does not', () => {
  it('turns concrete paths into templates and derives the intent (verb, entity)', () => {
    expect(apiTemplate('/api/v1/dossiers/42/documents/7f9c2b1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b')).toBe(
      '/api/v1/dossiers/{param}/documents/{param}',
    );
    expect(intentOf('POST', '/api/dossiers/{param}/documents', 'Ajouter')).toEqual({
      verb: 'CREATE',
      entity: 'DOCUMENT',
    });
    expect(intentOf('POST', '/api/dossiers/{param}/approve', '')).toEqual({
      verb: 'APPROVE',
      entity: 'DOSSIER',
    });
    expect(intentOf('PATCH', '/api/dossiers/{param}', 'Approuver')).toEqual({
      verb: 'APPROVE',
      entity: 'DOSSIER',
    });
    expect(intentOf('DELETE', '/api/dossiers/{param}', '')).toEqual({ verb: 'DELETE', entity: 'DOSSIER' });
  });

  it('learns a workflow, the states and the transition from an accepted write', () => {
    const learner = new RuntimeLearner();
    for (const observation of approveSequence()) learner.learn(observation, () => false);
    const knowledge = learner.knowledge();
    expect(knowledge.workflows).toEqual([
      {
        id: 'APPROVE:DOSSIER',
        api: 'PATCH /api/dossiers/{param}',
        entityType: 'DOSSIER',
        triggerLabel: 'Approuver',
        requestLiterals: { status: 'APPROVED' },
      },
    ]);
    expect(knowledge.states.map((state) => state.state)).toEqual(['PENDING', 'APPROVED']);
    expect(knowledge.transitions).toEqual([
      expect.objectContaining({ entityType: 'DOSSIER', from: 'PENDING', to: 'APPROVED', trigger: 'approve' }),
    ]);
    // Aucun identifiant de ressource n'est gardé.
    expect(JSON.stringify(knowledge)).not.toContain('42');
  });

  it('an accepted write that changes nothing (badge still PENDING in the response) learns no transition', () => {
    const learner = new RuntimeLearner();
    for (const observation of approveSequence('PENDING')) learner.learn(observation, () => false);
    expect(learner.knowledge().transitions).toEqual([]);
  });

  it('same route, another state written: another workflow (APPROVE vs REJECT)', async () => {
    const fi = intelligence();
    fi.useStaticKnowledge(undefined);
    for (const observation of approveSequence()) fi.afterAction(observation);
    fi.afterAction({
      actionId: 'reject',
      label: 'Refuser',
      type: 'click',
      exchanges: [
        {
          method: 'PATCH',
          path: '/api/dossiers/43',
          status: 200,
          requestState: { field: 'status', code: 'REJECTED' },
          responseState: { field: 'status', code: 'REJECTED' },
        },
      ],
    });
    expect(
      fi.workflows
        .all()
        .map((workflow) => workflow.id)
        .sort(),
    ).toEqual(['APPROVE:DOSSIER', 'REJECT:DOSSIER']);
    await Promise.resolve();
  });

  it('confirms the learned transition on screen, generates goals, and keeps it as history for the next run', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qa-learning-'));
    const first = intelligence(new FunctionalKnowledgeStore(directory, { application: 'app' }));
    await first.loadHistory();
    first.useStaticKnowledge(undefined);
    for (const observation of approveSequence()) first.afterAction(observation);
    const transition = first.machines
      .transitions()
      .find((entry) => entry.id === 'DOSSIER:PENDING>APPROVED:approve');
    expect(transition?.status).toBe('RUNTIME_CONFIRMED');
    expect(first.workflows.get('APPROVE:DOSSIER')?.origin).toBe('RUNTIME_LEARNED');
    expect(
      first.goals.all().some((goal) => goal.intent === 'Verify PENDING dossier can transition to APPROVED'),
    ).toBe(true);
    await first.persist();

    // Run suivant : rien dans le code, mais l'historique sert de point de départ — jamais de preuve.
    const second = intelligence(new FunctionalKnowledgeStore(directory, { application: 'app' }));
    await second.loadHistory();
    second.useStaticKnowledge(undefined);
    const remembered = second.machines
      .transitions()
      .find((entry) => entry.id === 'DOSSIER:PENDING>APPROVED:approve');
    expect(remembered).toMatchObject({ historical: true, status: 'STATIC_DISCOVERED' });
    expect(second.workflows.get('APPROVE:DOSSIER')?.origin).toBe('HISTORICAL');
    const goal = second.goals.get('STATE_TRANSITION:DOSSIER:PENDING>APPROVED:approve');
    expect(goal?.status).toBe('CANDIDATE');
    // Le moteur de décision favorise « Approuver » quand le dossier est PENDING à l'écran.
    second.observeScreen(screen('PENDING', ['Approuver', 'Refuser']));
    expect(second.signalFor({ label: 'Approuver', type: 'click' })?.reason).toMatch(/TEST_GOAL_PROGRESS/);
  });

  it('runtimeLearning disabled: nothing is learned', () => {
    const fi = intelligence(undefined, '  runtimeLearning: { enabled: false }\n');
    fi.useStaticKnowledge(undefined);
    for (const observation of approveSequence()) fi.afterAction(observation);
    expect(fi.workflows.all()).toEqual([]);
    expect(fi.machines.all()).toEqual([]);
  });

  it('reads a state code only from a status-like key with an identifier value (never free text)', () => {
    expect(stateCodeOf({ id: 4, status: 'PENDING' })).toEqual({ field: 'status', code: 'PENDING' });
    expect(stateCodeOf({ dossierStatus: 'ECHEC_PARTIEL' })).toEqual({
      field: 'dossierStatus',
      code: 'ECHEC_PARTIEL',
    });
    expect(stateCodeOf({ status: 'en attente de validation' })).toBeUndefined();
    expect(stateCodeOf({ name: 'PENDING' })).toBeUndefined();
    expect(stateCodeOf([{ status: 'PENDING' }])).toBeUndefined();
  });
});
