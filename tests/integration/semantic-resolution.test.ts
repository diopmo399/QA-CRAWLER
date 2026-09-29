import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';
import { startSemanticApp, type SemanticApp } from '../fixtures/semantic-app.js';

const FEATURES = path.resolve(import.meta.dirname, '../fixtures/features');

/**
 * RÉSOLUTION SÉMANTIQUE de bout en bout : des scénarios Gherkin sans sélecteur, sur une
 * application dont les attributs ne ressemblent pas aux mots du scénario.
 */
describe('Gherkin semantic resolution, end to end', () => {
  let app: SemanticApp;
  let root: string;
  let first: ExplorationResult;
  let second: ExplorationResult;
  let english: ExplorationResult;

  const run = async (name: string, feature: string): Promise<ExplorationResult> => {
    const { config } = parseConfig(
      `
mission: { name: semantic, mode: explore }
target: { baseUrl: ${app.url} }
exploration: { autonomous: false, actionTimeoutMs: 4000, settleTimeMs: 150 }
gherkin: { semanticResolution: { enabled: true } }
knowledge: { file: ${path.join(root, 'knowledge.json')} }
flows:
  - gherkin: ${path.join(FEATURES, feature)}
report: { language: fr, failOnSeverity: NONE }
logging: { level: debug }
output:
  reportsDir: ${path.join(root, name, 'reports')}
  screenshotsDir: ${path.join(root, name, 'screenshots')}
`,
      {},
      {},
    );
    return (await runMission(config)).result;
  };

  beforeAll(async () => {
    app = await startSemanticApp();
    root = await mkdtemp(path.join(tmpdir(), 'qa-semantic-e2e-'));
    first = await run('first', 'semantic-users.feature');
    second = await run('second', 'semantic-users.feature');
    english = await run('english', 'semantic-users-en.feature');
  }, 300_000);
  afterAll(async () => {
    await app.close();
  });

  const flow = (result: ExplorationResult, name: string) => {
    const found = result.flows.find((entry) => entry.name === name);
    if (!found) throw new Error(`no flow ${name}: ${result.flows.map((entry) => entry.name).join(', ')}`);
    return found;
  };
  const describeSteps = (result: ExplorationResult, name: string): string =>
    flow(result, name)
      .steps.map((step) => `${step.index} ${step.status} ${step.description} ${step.reason ?? ''}`)
      .join('\n');

  it('the reference scenario runs without CSS, XPath, DOM id or locator', () => {
    const creation = flow(first, 'Création utilisateur');
    expect(creation.status, describeSteps(first, 'Création utilisateur')).toBe('PASSED');
    expect(
      creation.steps.every((step) => step.status === 'PASSED'),
      describeSteps(first, 'Création utilisateur'),
    ).toBe(true);
  });

  it('the server received exactly what the scenario meant (givenName, familyName, electronicMail, accountType…)', () => {
    const user = app.created.find((entry) => entry.givenName === 'Mohamed');
    expect(user).toEqual({
      givenName: 'Mohamed',
      familyName: 'Diop',
      electronicMail: 'mohamed@example.com',
      accountType: 'ADMIN',
      dob: '1990-05-17',
      kids: '2',
      preferredLocale: 'fr',
      contactFrequency: 'yearly',
      isActive: 'yes',
      remarks: 'Créé par le scénario',
    });
  });

  it('every resolution is explained: target, confidence, reasons, candidates', () => {
    const steps = flow(first, 'Création utilisateur').steps;
    const email = steps.find((step) => step.description.includes('courriel'));
    expect(email?.resolution).toMatchObject({
      status: 'RESOLVED',
      selected: 'Adresse électronique',
      valueType: 'EMAIL',
    });
    expect(email?.resolution?.reasons.join('\n')).toContain('semantic alias "courriel" → email');
    expect(email?.resolution?.explanation?.join('\n')).not.toContain('mohamed@example.com');
    const role = steps.find((step) => step.description.includes('comme rôle'));
    expect(role?.resolution?.selected).toBe('Rôle');
    const submit = steps.find((step) => step.description.includes('je valide le formulaire'));
    expect(submit?.resolution?.selected).toBe('Créer');
    expect(submit?.resolution?.reasons).toEqual(
      expect.arrayContaining(['+35 button[type=submit] of its form']),
    );
  });

  it('a whole table, then the checks of the outcome (write request, page)', () => {
    expect(flow(first, 'Création par tableau').status, describeSteps(first, 'Création par tableau')).toBe(
      'PASSED',
    );
    expect(app.created.find((entry) => entry.givenName === 'Awa')).toMatchObject({
      familyName: 'Ndiaye',
      electronicMail: 'awa@example.com',
      accountType: 'VOLUNTEER',
    });
  });

  it('navigation and the next step of a wizard', () => {
    expect(
      flow(first, 'Inscription en deux étapes').status,
      describeSteps(first, 'Inscription en deux étapes'),
    ).toBe('PASSED');
  });

  it('English sentences on a French screen', () => {
    expect(flow(english, 'Create a user').status, describeSteps(english, 'Create a user')).toBe('PASSED');
    expect(app.created.find((entry) => entry.givenName === 'Lina')).toMatchObject({
      familyName: 'Haddad',
      accountType: 'USER',
    });
  });

  it('the second run remembers: historical matches add to the confidence, explained', () => {
    const steps = flow(second, 'Création utilisateur').steps;
    expect(flow(second, 'Création utilisateur').status).toBe('PASSED');
    const email = steps.find((step) => step.description.includes('courriel'));
    expect(
      email?.resolution?.reasons.some((reason) => /historical match \d+\/\d+ successful/.test(reason)),
    ).toBe(true);
  });

  it('engine log and report: SEMANTIC_RESOLUTION events, the explanation in the HTML, no secret', async () => {
    const log = await readFile(path.join(root, 'first', 'reports', 'engine-log.jsonl'), 'utf8');
    expect(log).toContain('SEMANTIC_RESOLUTION_SUCCEEDED');
    expect(log).not.toContain('mohamed@example.com');
    const html = await readFile(path.join(root, 'first', 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Résolution Gherkin');
    expect(html).toContain('FIELD MATCH');
  });
});
