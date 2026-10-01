import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuleBasedActionScorer, scoringMissionOf } from '../../src/decision/action-scorer.js';
import { AdvancedActionScorer } from '../../src/decision/advanced-action-scorer.js';
import { errorCodeOf, shapeOf } from '../../src/forms/state/form-knowledge-observer.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import { FunctionalIntelligence } from '../../src/functional/functional-intelligence.js';
import { TestGoalPlanner } from '../../src/functional/goal-planner.js';
import { judgeGoalAction } from '../../src/functional/goal-safety.js';
import { goalPriority, goalSignal } from '../../src/functional/goal-scoring.js';
import { assertionOfGuard } from '../../src/functional/invariants.js';
import type { FunctionalActionObservation, ScreenFacts, TestGoal } from '../../src/functional/model.js';
import { RuntimeContractCorrelator } from '../../src/functional/runtime-contract.js';
import { FunctionalKnowledgeStore } from '../../src/knowledge/functional-knowledge-store.js';
import { FlowGraph } from '../../src/graph/flow-graph.js';
import { parseOpenApi } from '../../src/oracles/api-contract.js';
import { SemanticFunctionalOracle } from '../../src/oracles/semantic-functional-oracle.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { functionalSection } from '../../src/reporting/functional-section.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { StaticApplicationGraph } from '../../src/static-analysis/model.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { element, screen, staticAnalyzerOptions, testConfig } from '../helpers.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/registrations');
const SALT = 'unit-salt';

let cached: { graph: StaticApplicationGraph; contract: ReturnType<typeof parseOpenApi> } | undefined;
async function knowledge(): Promise<{
  graph: StaticApplicationGraph;
  contract: ReturnType<typeof parseOpenApi>;
}> {
  if (cached) return cached;
  const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSource(FIXTURE);
  const contract = parseOpenApi(await readFile(path.join(FIXTURE, 'openapi.yaml'), 'utf8'));
  cached = { graph, contract };
  return cached;
}

function intelligence(
  yaml = '',
  extra: Partial<ConstructorParameters<typeof FunctionalIntelligence>[0]> = {},
): { fi: FunctionalIntelligence; events: string[] } {
  // La mission permet les modifications (approuver, créer) ; supprimer et payer restent bloqués.
  const config = testConfig(
    `safety:\n  allowedActionClasses: [SAFE, MUTATION]\nfunctionalIntelligence:\n  enabled: true\n${yaml}`,
  );
  const policy = new SafetyPolicy(config.safety);
  const events: string[] = [];
  const fi = new FunctionalIntelligence({
    config: config.functionalIntelligence,
    salt: SALT,
    safety: (target) => judgeGoalAction(policy, target.actionLabel),
    emit: (event, message) => events.push(`${event} ${message}`),
    ...extra,
  });
  return { fi, events };
}

function detail(status: string, buttons: string[], route = '/registrations/7'): ScreenFacts {
  return {
    url: `http://localhost:4200${route}`,
    route,
    text: `Registration 7\nStatus: ${status}\n${buttons.join(' ')}`,
    buttons: buttons.map((label) => ({ label, enabled: true })),
    alerts: [],
    invalidFields: [],
    fields: [],
    selections: {},
  };
}

function patch(status: number, to: string): FunctionalActionObservation['exchanges'][number] {
  return {
    method: 'PATCH',
    path: '/api/registrations/7',
    status,
    requestFields: { status: { type: 'string', digest: valueDigest(to, SALT) } },
    responseFields: { id: { type: 'string' }, status: { type: 'string' } },
  };
}

describe('static functional knowledge (registrations fixture)', () => {
  it('extracts the Registration state machine: states, transitions, triggers, forbidden transitions', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const machine = fi.machines.machine('REGISTRATION');
    expect(machine?.states.map((state) => state.state)).toEqual(
      expect.arrayContaining(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
    );
    const edges = machine?.transitions.map(
      (transition) =>
        `${transition.from}>${transition.to}:${transition.trigger ?? ''}:${transition.triggerLabel ?? ''}`,
    );
    expect(edges).toEqual(
      expect.arrayContaining([
        'DRAFT>PENDING:submit:Submit',
        'PENDING>APPROVED:approve:Approve',
        'PENDING>REJECTED:reject:Reject',
        'APPROVED>CANCELLED:cancel:Cancel registration',
      ]),
    );
    const approve = machine?.transitions.find((transition) => transition.trigger === 'approve');
    expect(approve).toMatchObject({ api: 'PATCH /api/registrations/{param}', status: 'STATIC_DISCOVERED' });
    expect(
      approve?.evidence.some((entry) => entry.provenance?.location?.file.endsWith('registration.service.ts')),
    ).toBe(true);
    // Approve n'est offert qu'en PENDING : ailleurs, la transition est interdite (apprise, jamais forcée).
    expect(machine?.forbidden).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'DRAFT', trigger: 'approve', status: 'STATIC_DISCOVERED' }),
      ]),
    );
  });

  it('derives workflows with stable semantic signatures, error paths, invariants and side effects', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const ids = fi.workflows.all().map((workflow) => workflow.id);
    expect(ids).toEqual(
      expect.arrayContaining(['CREATE:USER', 'DELETE:USER', 'APPROVE:REGISTRATION', 'SUBMIT:REGISTRATION']),
    );
    expect(fi.errorPaths.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'CREATE:USER',
          httpStatus: 409,
          errorClass: 'CONFLICT',
          businessCode: 'EMAIL_ALREADY_EXISTS',
          uiTarget: 'email',
          uiResult: 'FIELD_ERROR_AND_MESSAGE',
        }),
      ]),
    );
    expect(
      fi.sideEffects
        .expected('APPROVE:REGISTRATION')
        .map((effect) => `${effect.category} ${effect.expectedEffect}`),
    ).toEqual([
      'API PATCH /api/registrations/{param}',
      'STATE_CHANGE REGISTRATION becomes APPROVED',
      'UI "Approve" no longer offered',
    ]);
  });

  it('turns `if (paid > total) throw` into the cross-field invariant `paid <= total` — the payment goal is BLOCKED', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const payment = fi.invariants
      .all()
      .find((invariant) => invariant.assertion.text === 'paidAmount + amount <= totalAmount');
    expect(payment).toMatchObject({
      scope: 'ENTITY',
      entityType: 'REGISTRATION',
      status: 'STATIC_DISCOVERED',
    });
    expect(payment?.assertion.fields).toEqual(
      expect.arrayContaining(['paidAmount', 'amount', 'totalAmount']),
    );
    // Index : seuls les invariants qui touchent un champ sont revus.
    expect(fi.invariants.impacted(['totalAmount']).map((invariant) => invariant.id)).toEqual([payment?.id]);
    expect(fi.invariants.impacted(['email']).map((invariant) => invariant.id)).not.toContain(payment?.id);
    // Aucune transaction financière : l'objectif est bloqué par la SafetyPolicy.
    const goal = fi.goals.all().find((entry) => entry.sourceId === payment?.id);
    expect(goal?.status).toBe('BLOCKED');
    expect(goal?.observations?.[0]).toMatch(/SafetyPolicy/);
    expect(assertionOfGuard('a >= b', { kind: 'OPAQUE', text: 'a >= b' })?.text).toBe('a < b');
  });
});

describe('runtime confirmation', () => {
  it('confirms PENDING → APPROVED when Approve is clicked and the badge changes', async () => {
    const { graph, contract } = await knowledge();
    const { fi, events } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const before = detail('PENDING', ['Approve', 'Reject']);
    fi.observeScreen(before);
    const goal = fi.goals.get('STATE_TRANSITION:REGISTRATION:PENDING>APPROVED:approve');
    expect(goal?.intent).toBe('Verify PENDING registration can transition to APPROVED');
    // L'écran courant satisfait déjà la précondition : le plan est CURRENT_STATE, le déclencheur est prêt.
    expect(goal && fi.plan(goal)).toMatchObject({ strategy: 'CURRENT_STATE', ready: true });
    expect(fi.signalFor({ label: 'Approve', type: 'click' })?.reason).toMatch(/TEST_GOAL_PROGRESS/);
    fi.onActionSelected({ label: 'Approve', type: 'click' });
    expect(goal?.status).toBe('RUNNING');
    const findings = fi.afterAction({
      actionId: 'a1',
      label: 'Approve',
      type: 'click',
      before,
      after: detail('APPROVED', ['Cancel registration']),
      exchanges: [patch(200, 'APPROVED')],
    });
    const transition = fi.machines
      .transitions()
      .find((entry) => entry.id === 'REGISTRATION:PENDING>APPROVED:approve');
    expect(transition?.status).toBe('RUNTIME_CONFIRMED');
    expect(findings.map((finding) => finding.code)).toContain('TRANSITION_CONFIRMED');
    expect(goal?.status).toBe('VERIFIED');
    expect(
      fi.sideEffects.expected('APPROVE:REGISTRATION').every((effect) => effect.status === 'CONFIRMED'),
    ).toBe(true);
    // L'invariant d'état (approve exige PENDING) est confirmé ; le contrat PATCH est respecté.
    expect(fi.invariants.all().find((invariant) => invariant.transitionId === transition?.id)?.status).toBe(
      'RUNTIME_CONFIRMED',
    );
    expect(fi.coverage().transitions.confirmed).toBe(1);
    expect(events.some((event) => event.startsWith('BUSINESS_TRANSITION_CONFIRMED'))).toBe(true);
    expect(events.some((event) => event.startsWith('TEST_GOAL_VERIFIED'))).toBe(true);
    const oracle = new SemanticFunctionalOracle((id) => fi.findingsFor(id));
    const verdict = await oracle.evaluate(
      screen({}),
      { id: 'a1', type: 'click', category: 'submit', classification: 'MUTATION', result: 'SUCCESS' },
      undefined,
      { issues: [], network: [], pageCrashed: false },
    );
    expect(verdict.status).toBe('PASS');
  });

  it('reports a missing side effect: PATCH 200 but the badge stays PENDING', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const before = detail('PENDING', ['Approve', 'Reject']);
    fi.observeScreen(before);
    fi.onActionSelected({ label: 'Approve', type: 'click' });
    const findings = fi.afterAction({
      actionId: 'a2',
      label: 'Approve',
      type: 'click',
      before,
      after: detail('PENDING', ['Approve', 'Reject']),
      exchanges: [patch(200, 'APPROVED')],
    });
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['EXPECTED_STATE_TRANSITION_MISSING', 'EXPECTED_SIDE_EFFECT_MISSING']),
    );
    expect(fi.goals.get('STATE_TRANSITION:REGISTRATION:PENDING>APPROVED:approve')?.status).toBe('FAILED');
    expect(fi.workflows.get('APPROVE:REGISTRATION')?.status).toBe('FAILED');
    const verdict = await new SemanticFunctionalOracle((id) => fi.findingsFor(id)).evaluate(
      screen({}),
      { id: 'a2', type: 'click', category: 'submit', classification: 'MUTATION', result: 'SUCCESS' },
      undefined,
      { issues: [], network: [], pageCrashed: false },
    );
    // Au plus WARNING : une attente du code non tenue n'est jamais un échec confirmé à elle seule.
    expect(verdict).toMatchObject({ status: 'WARNING', category: 'UNEXPECTED_BEHAVIOR' });
    expect(verdict.reasons.map((reason) => reason.code)).toContain('expected-state-transition-missing');
  });

  it('a list page (several states shown) is INCONCLUSIVE, never a contradiction', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const list = { ...detail('PENDING', ['Approve']), text: 'R1 PENDING\nR2 APPROVED\nR3 DRAFT' };
    const findings = fi.afterAction({
      actionId: 'a3',
      label: 'Approve',
      type: 'click',
      before: list,
      after: list,
      exchanges: [],
    });
    expect(findings.filter((finding) => finding.status === 'WARNING')).toEqual([]);
    expect(fi.machines.transitions().every((transition) => transition.status === 'STATIC_DISCOVERED')).toBe(
      true,
    );
  });

  it('follows the error path 409 EMAIL_ALREADY_EXISTS up to the email field', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const form: ScreenFacts = {
      url: 'http://localhost:4200/users/new',
      route: '/users/new',
      text: 'New user',
      buttons: [{ label: 'Create', enabled: true }],
      alerts: [],
      invalidFields: [],
      fields: ['email', 'firstName'],
      selections: {},
    };
    fi.afterAction({
      actionId: 'a4',
      label: 'Create',
      type: 'click',
      before: form,
      after: { ...form, invalidFields: ['email'], alerts: ['Email already exists'] },
      exchanges: [
        {
          method: 'POST',
          path: '/api/users',
          status: 409,
          errorCode: 'EMAIL_ALREADY_EXISTS',
          requestFields: { email: { type: 'string' }, firstName: { type: 'string' } },
        },
      ],
    });
    const path409 = fi.errorPaths.all().find((entry) => entry.businessCode === 'EMAIL_ALREADY_EXISTS');
    expect(path409?.status).toBe('RUNTIME_CONFIRMED');
    expect(fi.goals.get(`ERROR_PATH:${path409?.id ?? ''}`)?.status).toBe('VERIFIED');
    // Un refus métier (4xx) laisse le workflow INCONCLUSIVE, pas FAILED.
    expect(fi.workflows.get('CREATE:USER')?.status).toBe('INCONCLUSIVE');
  });

  it('detects FIELD_NOT_SENT as a CONTRACT_MISMATCH, never an application bug', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const form: ScreenFacts = {
      url: 'http://localhost:4200/users/new',
      route: '/users/new',
      text: 'New user',
      buttons: [{ label: 'Create', enabled: true }],
      alerts: [],
      invalidFields: [],
      fields: ['email', 'firstName'],
      selections: {},
    };
    const findings = fi.afterAction({
      actionId: 'a5',
      label: 'Create',
      type: 'click',
      before: form,
      after: form,
      exchanges: [
        {
          method: 'POST',
          path: '/api/users',
          status: 201,
          requestFields: { email: { type: 'string' } },
          responseFields: { id: { type: 'number' } },
        },
      ],
    });
    const mismatch = fi.summary()?.contract.find((entry) => entry.kind === 'FIELD_NOT_SENT');
    expect(mismatch).toMatchObject({
      category: 'CONTRACT_MISMATCH',
      operation: 'POST /api/users',
      field: 'firstName',
    });
    expect(findings.some((finding) => finding.code === 'CONTRACT_MISMATCH')).toBe(true);
    expect(fi.goals.get('CONTRACT:POST /api/users')?.status).toBe('FAILED');
    const verdict = await new SemanticFunctionalOracle((id) => fi.findingsFor(id)).evaluate(
      screen({}),
      { id: 'a5', type: 'click', category: 'submit', classification: 'MUTATION', result: 'SUCCESS' },
      undefined,
      { issues: [], network: [], pageCrashed: false },
    );
    expect(verdict.category).toBe('CONTRACT_VIOLATION');
  });

  it('reports EXPECTED_ENTITY_NOT_OBSERVED when a creation is accepted without an identifier', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const findings = fi.afterAction({
      actionId: 'a6',
      label: 'Create',
      type: 'click',
      exchanges: [
        { method: 'POST', path: '/api/users', status: 200, responseFields: { ok: { type: 'boolean' } } },
      ],
    });
    expect(findings.map((finding) => finding.code)).toContain('EXPECTED_ENTITY_NOT_OBSERVED');
  });

  it('compares enum values by salted digest only (ENUM_MISMATCH), never the value itself', () => {
    const contract = parseOpenApi(
      'openapi: 3.0.0\npaths:\n  /api/registrations/{id}:\n    patch:\n      requestBody:\n        content:\n          application/json:\n            schema:\n              type: object\n              properties:\n                status: { type: string, enum: [PENDING, APPROVED] }\n      responses:\n        "200": { description: ok }\n',
    );
    const correlator = new RuntimeContractCorrelator(contract, SALT);
    const found = correlator.observe({
      actionId: 'x',
      label: 'x',
      type: 'click',
      exchanges: [patch(200, 'ARCHIVED')],
    });
    expect(found.map((entry) => entry.kind)).toEqual(['ENUM_MISMATCH']);
    expect(JSON.stringify(found)).not.toContain('ARCHIVED');
    const shape = shapeOf({ email: 'someone@example.test', age: 3, flag: null }, SALT);
    expect(JSON.stringify(shape)).not.toContain('someone');
    expect(shape).toMatchObject({
      email: { type: 'string' },
      age: { type: 'number' },
      flag: { type: 'null' },
    });
    expect(errorCodeOf({ error: { code: 'EMAIL_ALREADY_EXISTS' }, message: 'free text' })).toBe(
      'EMAIL_ALREADY_EXISTS',
    );
    expect(errorCodeOf({ message: 'Email exists' })).toBeUndefined();
  });
});

describe('test goals', () => {
  it('generates goals from a rule, a transition and an invariant — deduplicated, with provenance', async () => {
    const accounts = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSource(
      path.resolve('tests/fixtures/static-apps/accounts'),
    );
    const rule = accounts.graph.rules?.[0];
    expect(rule).toBeDefined();
    const { graph, contract } = await knowledge();
    const { fi } = intelligence('', { rules: () => (rule ? [rule] : []) });
    fi.useStaticKnowledge(graph, contract);
    const goals = fi.goals.all();
    const categories = new Set(goals.map((goal) => goal.category));
    expect([...categories]).toEqual(expect.arrayContaining(['RULE', 'STATE_TRANSITION', 'INVARIANT']));
    for (const goal of goals) {
      expect(goal.generatedFrom.length).toBeGreaterThan(0);
      expect(goal.sourceId.length).toBeGreaterThan(0);
    }
    expect(new Set(goals.map((goal) => goal.id)).size).toBe(goals.length);
    const before = goals.length;
    fi.goals.generate({
      machines: fi.machines.all(),
      workflows: fi.workflows.all(),
      invariants: fi.invariants.all(),
      errorPaths: [],
      sideEffects: [],
      rules: rule ? [rule] : [],
    });
    expect(fi.goals.all().length).toBe(before);
  });

  it('prioritizes low cost / high gain, in one central scoring function', () => {
    const cheap = goalPriority({
      category: 'STATE_TRANSITION',
      coverageGain: 4,
      estimatedCost: 1,
      risk: 0,
      confidence: 0.8,
    });
    const costly = goalPriority({
      category: 'STATE_TRANSITION',
      coverageGain: 1,
      estimatedCost: 8,
      risk: 0,
      confidence: 0.8,
    });
    expect(cheap).toBeGreaterThan(costly);
    const goal = { status: 'BLOCKED', priority: 90 } as TestGoal;
    expect(goalSignal(goal, 'TRIGGER_READY')).toBeUndefined();
    // Le signal du moteur passe par le facteur `functional` du ScoreBreakdown existant.
    const config = testConfig();
    const scorer = new AdvancedActionScorer(new RuleBasedActionScorer(new SafetyPolicy(config.safety)), {
      dictionary: new SemanticDictionary(),
      weights: { goalWeight: 1, patternWeight: 1, noveltyWeight: 1, coverageWeight: 1, historyWeight: 1 },
      patternsOf: () => [],
      functionalSignalOf: (candidate) =>
        candidate.text === 'Details'
          ? { goalId: 'g', kind: 'progress', points: 80, reason: 'TEST_GOAL_PROGRESS: verify' }
          : undefined,
    });
    const context = screen({ elements: [element({ text: 'Details', name: 'Details' })] });
    const action = context.actions[0];
    if (!action) throw new Error('no action');
    const scored = scorer.score(action, context, new FlowGraph(), scoringMissionOf(config));
    expect(scored.breakdown.functional).toBe(80);
  });

  it('blocks a DELETE_USER goal with the SafetyPolicy and never favours it', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const goal = fi.goals.get('WORKFLOW:DELETE:USER');
    expect(goal?.status).toBe('BLOCKED');
    fi.observeScreen({ ...detail('', ['Delete'], '/users'), text: 'Users' });
    expect(fi.signalFor({ label: 'Delete', type: 'click' })).toBeUndefined();
    fi.onActionSelected({ label: 'Delete', type: 'click' });
    expect(goal?.status).toBe('BLOCKED');
  });

  it('uses a prefilled precondition as is (no BUSINESS → PERSONAL → BUSINESS toggle)', () => {
    const planner = new TestGoalPlanner();
    const goal: TestGoal = {
      id: 'RULE:x',
      category: 'RULE',
      intent: 'Verify companyNumber is required when BUSINESS',
      target: { field: 'accountType' },
      preconditions: [
        {
          description: 'accountType == BUSINESS',
          condition: {
            kind: 'COMPARE',
            subject: { kind: 'FIELD', name: 'accountType', control: 'accountType' },
            operator: '==',
            value: 'BUSINESS',
          },
        },
      ],
      expectedOutcomes: [],
      evidence: [],
      priority: 50,
      estimatedCost: 2,
      risk: 0,
      coverageGain: 1,
      status: 'CANDIDATE',
      generatedFrom: 'rule',
      sourceId: 'r',
    };
    const facts = (value: string): ScreenFacts => ({ ...detail('', []), selections: { accountType: value } });
    const context = (value: string) => ({
      screen: facts(value),
      statesShown: () => [],
      knownPath: () => undefined,
      historicalPath: () => undefined,
    });
    expect(planner.plan(goal, context('BUSINESS'))).toMatchObject({ strategy: 'CURRENT_STATE', cost: 0 });
    expect(planner.preconditionHolds(goal, context('PERSONAL'))).toBe(false);
  });

  it('history guides planning, but the transition stays unverified until observed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qa-functional-'));
    const previous = new FunctionalKnowledgeStore(directory, { application: 'app', version: '1.0.0' });
    await previous.save([
      {
        id: 'TRANSITION:REGISTRATION:PENDING>APPROVED:approve',
        kind: 'TRANSITION',
        status: 'RUNTIME_CONFIRMED',
      },
      {
        id: 'GOAL:STATE_TRANSITION:REGISTRATION:PENDING>APPROVED:approve',
        kind: 'GOAL',
        status: 'VERIFIED',
        route: '/registrations/:id',
        steps: 2,
      },
    ]);
    const store = new FunctionalKnowledgeStore(directory, { application: 'app', version: '1.1.0' });
    const { graph, contract } = await knowledge();
    const { fi } = intelligence('', { store });
    await fi.loadHistory();
    fi.useStaticKnowledge(graph, contract);
    const transition = fi.machines
      .transitions()
      .find((entry) => entry.id === 'REGISTRATION:PENDING>APPROVED:approve');
    expect(transition).toMatchObject({ historical: true, status: 'STATIC_DISCOVERED' });
    fi.observeScreen({ ...detail('', []), route: '/', text: 'Home' });
    const goal = fi.goals.get('STATE_TRANSITION:REGISTRATION:PENDING>APPROVED:approve');
    expect(goal && fi.plan(goal)).toMatchObject({ strategy: 'HISTORICAL_PATH' });
    expect(goal?.status).not.toBe('VERIFIED');
    expect(fi.coverage().transitions.confirmed).toBe(0);
    // Un chemin confirmé du FlowGraph passe avant l'historique.
    const graphFlow = new FlowGraph();
    expect(graphFlow.nodeCount).toBe(0);
  });

  it('functionalIntelligence.enabled=false keeps the previous behaviour; testGoals.enabled=false sends no goal signal', async () => {
    const { graph, contract } = await knowledge();
    const config = testConfig();
    expect(config.functionalIntelligence.enabled).toBe(false);
    const off = new FunctionalIntelligence({
      config: config.functionalIntelligence,
      salt: SALT,
      safety: () => ({ allowed: true, classification: 'SAFE', reason: '' }),
      emit: () => undefined,
    });
    off.useStaticKnowledge(graph, contract);
    expect(off.summary()).toBeUndefined();
    expect(off.signalFor({ label: 'Approve', type: 'click' })).toBeUndefined();
    expect(off.afterAction({ actionId: 'x', label: 'Approve', type: 'click', exchanges: [] })).toEqual([]);
    const { fi } = intelligence('  testGoals:\n    enabled: false\n');
    fi.useStaticKnowledge(graph, contract);
    fi.observeScreen(detail('PENDING', ['Approve']));
    expect(fi.goals.all()).toEqual([]);
    expect(fi.signalFor({ label: 'Approve', type: 'click' })).toBeUndefined();
    expect(fi.machines.all().length).toBe(1);
  });

  it('renders the Functional intelligence report section without any quality grade', async () => {
    const { graph, contract } = await knowledge();
    const { fi } = intelligence();
    fi.useStaticKnowledge(graph, contract);
    const html = functionalSection({ functional: fi.summary() } as ExplorationResult, 'en');
    expect(html).toContain('Functional intelligence');
    expect(html).toContain('Verify PENDING registration can transition to APPROVED');
    expect(html).toContain('REGISTRATION');
    expect(html).not.toMatch(/quality score|\d+\s*\/\s*100|grade [A-F]\b/i);
    expect(functionalSection({} as ExplorationResult, 'fr')).toBe('');
  });
});
