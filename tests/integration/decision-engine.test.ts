import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startDecisionApp, type DecisionApp } from '../fixtures/decision-app.js';

/**
 * Le moteur de décision de bout en bout, sur une application en français :
 * mission « users » avec les objectifs users et create-user.
 */
describe('decision engine: goals, patterns, best-first, knowledge, invariants, write guard', () => {
  let app: DecisionApp;
  let root: string;
  let first: ExplorationResult;
  let second: ExplorationResult;

  const mission = (name: string): string => `
mission: { name: users, mode: explore }
target: { baseUrl: ${app.url} }
goals: [users, create-user]
exploration: { maxStates: 25, maxActions: 60, actionTimeoutMs: 2000, settleTimeMs: 100 }
propertyTesting: { enabled: true, maxCasesPerForm: 6 }
testData: { fields: { Agence: '1000' } }
knowledge: { minObservations: 1 }
logging: { decisionTrace: true }
report: { language: fr, failOnSeverity: NONE }
invariants:
  - id: USER-CREATE
    description: « Nouvel utilisateur » ouvre un formulaire de création
    severity: WARNING
    when: { actionMatches: [nouvel utilisateur] }
    expect: { resultingPattern: [CREATE_FORM] }
output:
  reportsDir: ${path.join(root, name, 'reports')}
  screenshotsDir: ${path.join(root, name, 'screenshots')}
knowledge_placeholder: x
`;

  const run = async (name: string): Promise<ExplorationResult> => {
    const yaml = mission(name)
      .replace('knowledge_placeholder: x\n', '')
      // Les deux runs partagent la même base de connaissances.
      .replace(
        'knowledge: { minObservations: 1 }',
        `knowledge: { minObservations: 1, file: ${path.join(root, 'knowledge.json')} }`,
      );
    const { config } = parseConfig(yaml, {}, {});
    return (await runMission(config)).result;
  };

  beforeAll(async () => {
    app = await startDecisionApp();
    root = await mkdtemp(path.join(tmpdir(), 'qa-decision-'));
    first = await run('first');
    second = await run('second');
  }, 240_000);
  afterAll(async () => {
    await app.close();
  });

  const labelOf = (result: ExplorationResult, stateId: string): string =>
    result.states.find((state) => state.id === stateId)?.label ?? stateId;
  const patternsOn = (result: ExplorationResult, label: string): string[] => {
    const state = result.states.find((candidate) => candidate.label === label);
    return (
      (state ? result.intelligence?.patterns[state.id] : undefined)?.map((pattern) => pattern.type) ?? []
    );
  };

  it('1. the dashboard is observed and recognised; the users list is a CRUD list with a search', () => {
    expect(first.states[0]?.label).toBe('tableau-de-bord');
    expect(patternsOn(first, 'tableau-de-bord')).toContain('DASHBOARD');
    expect(patternsOn(first, 'utilisateurs')).toEqual(expect.arrayContaining(['CRUD_LIST', 'SEARCH']));
    expect(patternsOn(first, 'nouvel-utilisateur')).toContain('CREATE_FORM');
    expect(patternsOn(first, 'rapports')).toContain('EMPTY_STATE');
  });

  it('2. the planner turns the goals into sub-goals; each one is REACHED with observable evidence', () => {
    const goals = first.intelligence?.goals ?? [];
    const status = Object.fromEntries(goals.map((goal) => [goal.id, goal.status]));
    expect(status).toMatchObject({
      users: 'REACHED',
      'find:user': 'REACHED',
      'explore:user': 'REACHED',
      'create-user': 'REACHED',
      'action:create-user': 'REACHED',
      'reach:create-user': 'REACHED',
    });
    const reach = goals.find((goal) => goal.id === 'reach:create-user');
    expect(reach?.evidence.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['pattern']));
  });

  it('3. best-first, goal-directed: « Utilisateurs » first, each decision explained', () => {
    const [firstDecision] = first.intelligence?.decisions ?? [];
    expect(firstDecision?.label).toBe('Utilisateurs');
    expect(firstDecision?.breakdown?.reasons.some((reason) => reason.includes('goal relevance'))).toBe(true);
    expect(first.intelligence?.strategy).toBe('best-first');
    const created = first.intelligence?.decisions.find((decision) => decision.label === 'Nouvel utilisateur');
    expect(created?.breakdown?.details.map((reason) => reason.factor)).toEqual(
      expect.arrayContaining(['base', 'goal', 'pattern']),
    );
  });

  it('4. write guard: typing in a field never writes on the server; reported as a side effect', () => {
    expect(app.writes).toEqual([]);
    expect(first.blockedWrites?.[0]).toMatchObject({ method: 'PUT' });
    expect(first.blockedWrites?.[0]?.url).toContain('/api/users/draft/');
    expect(first.blockedWrites?.[0]?.during).toContain('Nouvel utilisateur');
    expect(first.issues.some((issue) => issue.type === 'WRITE_BLOCKED')).toBe(true);
  });

  it('5. forms: the autocomplete suggestion is chosen; property cases from the constraints', () => {
    const form = first.formReports?.find((report) => report.name === 'Nouvel utilisateur');
    const agency = form?.fields.find((field) => field.label.startsWith('Agence'));
    // La valeur configurée (« 1000 ») correspond aux suggestions : la première qui la contient est choisie.
    expect(agency?.filled).toBe('fill "1000" → "10001 — Agence Nord"');
    const cases = form?.propertyCases ?? [];
    expect(cases.length).toBeGreaterThan(2);
    expect(cases.some((entry) => entry.description.startsWith('Âge: <18') && entry.verdict === 'PASS')).toBe(
      true,
    );
  });

  it('6. invariants and verdict categories: the broken flow is a confirmed failure, explained', () => {
    const noServerError = (first.invariants ?? []).filter((entry) => entry.invariantId === 'NO-SERVER-ERROR');
    expect(
      noServerError.some((entry) => entry.status === 'FAIL' && entry.observed.includes('/api/broken → 500')),
    ).toBe(true);
    expect(
      (first.invariants ?? []).some(
        (entry) => entry.invariantId === 'USER-CREATE' && entry.status === 'PASS',
      ),
    ).toBe(true);
    expect(first.transitions.some((edge) => edge.oracle?.categories.includes('CONFIRMED_FAILURE'))).toBe(
      true,
    );
    expect(first.issues.some((issue) => issue.type === 'INVARIANT')).toBe(true);
  });

  it('7. options of a group are tried once per run; the revealed question is still explored', () => {
    const checks = first.transitions.filter((edge) => edge.action.type === 'check');
    const counts = new Map<string, number>();
    for (const edge of checks) {
      const key = `${labelOf(first, edge.from).split('-')[0] ?? ''}|${edge.action.text ?? ''}|${edge.actionId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
  });

  it('8. knowledge: the second run learns from the first (historical expectations met)', async () => {
    expect(second.intelligence?.knowledge?.runs).toBe(2);
    const historical = second.transitions
      .flatMap((edge) => edge.oracle?.results ?? [])
      .filter((opinion) => opinion.oracle === 'historical' && opinion.status === 'PASS');
    expect(historical.length).toBeGreaterThan(0);
    const saved = JSON.parse(await readFile(path.join(root, 'knowledge.json'), 'utf8')) as {
      schemaVersion: number;
      applications: Record<
        string,
        { runs: number; api: Record<string, { statuses: Record<string, number> }> }
      >;
    };
    expect(saved.schemaVersion).toBe(1);
    const entry = Object.values(saved.applications)[0];
    expect(entry?.runs).toBe(2);
    expect(entry?.api['GET /api/broken']?.statuses['500']).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toMatch(/Alice|Bruno|Chloé/); // aucune donnée affichée
  });

  it('9. the French report explains it all; the decision trace is written', async () => {
    const html = await readFile(path.join(root, 'first', 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Moteur de décision');
    expect(html).toContain('Objectifs');
    expect(html).toContain('ATTEINT');
    expect(html).toContain('pertinence pour l’objectif');
    expect(html).toContain('Requêtes d’écriture bloquées');
    const trace = JSON.parse(
      await readFile(path.join(root, 'first', 'reports', 'decision-trace.json'), 'utf8'),
    ) as {
      candidates: unknown[];
    }[];
    expect(trace.length).toBeGreaterThan(3);
    expect(trace[0]?.candidates.length).toBeGreaterThan(1);
  });
});
