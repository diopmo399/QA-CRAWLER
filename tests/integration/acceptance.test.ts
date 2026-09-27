import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import {
  ACCEPTANCE_PASSWORD,
  ACCEPTANCE_USER,
  startAcceptanceApp,
  type AcceptanceApp,
} from '../fixtures/acceptance-app.js';

/**
 * La mission d'acceptation de la spécification : objectifs, formulaires et un budget
 * de modifications — aucun flow, aucun clic écrit à la main. Apprise une fois sur la
 * variante A, puis explorée sur la variante B (un écran modifié).
 */
describe('acceptance: autonomous exploration of the local application', () => {
  let app: AcceptanceApp;
  let learned: ExplorationResult;
  let result: ExplorationResult;
  let outputDir = '';
  const env = { QA_USERNAME: ACCEPTANCE_USER, QA_PASSWORD: ACCEPTANCE_PASSWORD };

  const mission = (reportsDir: string): string => `
mission:
  name: explore-users
  mode: explore
target:
  baseUrl: ${app.url}
goals:
  keywords: [users, utilisateurs]
forms:
  autoFill: true
  validationTesting: true
safety:
  mutations: { enabled: true, maxPerRun: 10 }
auth:
  type: form
  loginUrl: /login
  usernameSelector: '#user'
  passwordSelector: '#pass'
  submitSelector: '#go'
  successUrlContains: /
exploration: { maxStates: 40, maxActions: 120, maxStatesPerRoute: 3, actionTimeoutMs: 2000, settleTimeMs: 50 }
testData: { runId: acc }
baseline: { dir: ${path.join(outputDir, 'baseline')} }
output:
  reportsDir: ${reportsDir}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`;

  beforeAll(async () => {
    app = await startAcceptanceApp();
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-acceptance-'));
    const learn = parseConfig(mission(path.join(outputDir, 'learn')), {}, {}).config;
    learned = (await runMission(learn, { env, mode: 'learn' })).result;
    app.setVariant('B');
    const explore = parseConfig(mission(path.join(outputDir, 'reports')), {}, {}).config;
    result = (await runMission(explore, { env, mode: 'explore' })).result;
  });
  afterAll(async () => {
    await app.close();
  });

  const labels = (): string[] => result.states.map((state) => state.label);
  const createForm = () => result.formReports?.find((form) => form.name === 'Create user');

  it('1. discovers the form', () => {
    const form = createForm();
    expect(form?.fields.map((field) => field.label)).toEqual(['First name', 'Last name', 'Email', 'Role']);
    expect(form?.fields.find((field) => field.label === 'Email')).toMatchObject({
      type: 'email',
      required: true,
    });
  });

  it('2. generates the data (tagged with the run) and 3. fills the fields', () => {
    const fields = createForm()?.fields ?? [];
    expect(fields.every((field) => !field.error)).toBe(true);
    expect(fields.find((field) => field.label === 'Email')?.filled).toBe(
      'fill "qa-crawler-acc@example.test"',
    );
    // Les noms suivent les valeurs par défaut (QA / Crawler) ; l'e-mail porte le marqueur du run.
    expect(fields.find((field) => field.label === 'Last name')?.filled).toBe('fill "Crawler"');
    // L'option d'invite n'est jamais choisie.
    expect(fields.find((field) => field.label === 'Role')?.filled).toMatch(/select "(Reader|Editor)"/);
    // Le formulaire a été envoyé (modifications permises) avec des données marquées : POST /api/users.
    const sent = app.posts.filter((post) => post.path === '/api/users');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((post) => post.body.toLowerCase().includes('qa-crawler-acc'))).toBe(true);
    expect(
      result.createdData?.some((record) => record.requests.some((request) => request.status === 201)),
    ).toBe(true);
  });

  it('4. follows the wizard to its confirmation', () => {
    const confirmation = result.states.find(
      (state) => state.route === '/wizard' && /confirmation/i.test(state.subtitle ?? state.label),
    );
    expect(confirmation).toBeDefined();
  });

  it('5. detects HTTP 500 and 6. the TechnicalOracle says FAIL', () => {
    expect(result.issues.some((issue) => issue.type === 'HTTP' && issue.status === 500)).toBe(true);
    const failed = result.transitions.find((edge) =>
      edge.oracle?.results.some(
        (entry) => entry.oracle === 'technical' && entry.reasons.some((reason) => reason.code === 'http-5xx'),
      ),
    );
    expect(failed?.oracle?.status).toBe('FAIL');
    // Une erreur JavaScript est aussi un échec.
    expect(
      result.transitions.some((edge) =>
        edge.oracle?.results.some((entry) =>
          entry.reasons.some((reason) => reason.code === 'uncaught-exception'),
        ),
      ),
    ).toBe(true);
    // Résultat métier : jamais inventé.
    expect(
      result.transitions
        .filter((edge) => edge.oracle)
        .every((edge) => edge.oracle?.assertions.includes('? business result unknown')),
    ).toBe(true);
  });

  it('7. detects a difference with the baseline', () => {
    expect(learned.learnedBaseline).toBeDefined();
    const regressions = result.issues.filter((issue) => issue.type === 'REGRESSION');
    expect(regressions.some((issue) => issue.message.includes('expected user-detail'))).toBe(true);
  });

  it('8. recovers after problems (failed action, expired session)', () => {
    const events = result.recovery?.events ?? [];
    expect(events.some((event) => event.failure === 'action-failed' && event.success)).toBe(true);
    expect(result.recovery?.reauthentications).toBeGreaterThan(0);
    expect(events.some((event) => event.strategy === 'reauthenticate' && event.success)).toBe(true);
  });

  it('9. avoids the endless pagination loop', () => {
    expect(result.states.filter((state) => state.route === '/pages').length).toBeLessThanOrEqual(3);
    expect(result.stopReason).toBe('exhausted');
  });

  it('10. goes on exploring after a broken branch', () => {
    expect(
      result.issues.some(
        (issue) =>
          issue.type === 'BROKEN_LINK' &&
          issue.status === 500 &&
          (issue.requestUrl ?? '').includes('/history'),
      ),
    ).toBe(true);
    for (const screen of ['dashboard', 'users', 'settings', 'dialog', 'statistics'])
      expect(labels()).toContain(screen);
    // Les actions destructives ne sont jamais exécutées.
    expect(
      result.transitions.some((edge) => edge.action.text === 'Delete user' && edge.result !== 'BLOCKED'),
    ).toBe(false);
  });

  it('never writes the password, a cookie or an Authorization header in any artifact', async () => {
    const files = await readdir(outputDir, { recursive: true, withFileTypes: true });
    const written = files.filter((entry) => entry.isFile() && !entry.name.endsWith('.png'));
    const names = written.map((entry) => entry.name);
    for (const name of ['result.json', 'flow-graph.json', 'index.html', 'engine-log.jsonl'])
      expect(names).toContain(name);
    const texts = await Promise.all(
      written.map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
    );
    const all = texts.join('\n');
    expect(all).not.toContain(ACCEPTANCE_PASSWORD);
    expect(all).not.toMatch(/sid=s\d/);
    expect(all).not.toMatch(/authorization:|bearer /i);
    expect(all).not.toMatch(/set-cookie/i);
  });
});
