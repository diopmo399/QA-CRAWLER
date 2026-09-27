import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';
import { startFlowApp, type FlowApp } from '../fixtures/flow-app.js';

/**
 * Flows imposés sur le mini back-office : la mission liste les étapes, l'explorateur
 * les exécute dans l'ordre — et la SafetyPolicy a toujours le dernier mot.
 */
describe('Imposed flows', () => {
  let app: FlowApp;
  let outputDir: string;

  beforeAll(async () => {
    app = await startFlowApp();
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-imposed-'));
  });

  afterAll(async () => {
    await app.close();
  });

  const WIZARD_STEPS = `
      - click: { role: link, name: Nouveau dossier }
      - fill: { label: Titre, value: Dossier QA }
      - fill: { label: Email du demandeur, value: { env: QA_FLOW_EMAIL } }
      - click: { role: button, name: Suivant }
      - expect: { text: Étape 2 — Détails }
      - fill: { label: Montant, value: 250 }
      - select: { label: Catégorie, option: Subvention }
      - check: { label: J'accepte les conditions }
      - click: { role: button, name: Suivant }
      - expect: { text: Étape 3 — Confirmation }
      - screenshot: confirmation`;

  async function run(name: string, yaml: string, autonomous = true): Promise<ExplorationResult> {
    const dir = path.join(outputDir, name);
    const { config } = parseConfig(
      `
mission:
  name: ${name}
target:
  baseUrl: ${app.url}
exploration:
  maxStates: 40
  maxActions: 150
  maxDurationMinutes: 3
  actionTimeoutMs: 3000
  settleTimeMs: 100
  autonomous: ${autonomous}
output:
  reportsDir: ${path.join(dir, 'reports')}
  screenshotsDir: ${path.join(dir, 'screenshots')}
${yaml}`,
      {},
      {},
    );
    const hitsBefore = app.dangerousHits.length;
    const { result } = await runMission(config, {
      env: { QA_FLOW_EMAIL: 'demandeur@example.test', QA_FLOW_PASSWORD: 'S3cret-Flow!' },
    });
    lastHits = app.dangerousHits.slice(hitsBefore);
    return result;
  }
  let lastHits: string[] = [];
  const flow = (result: ExplorationResult, name: string): FlowRunReport => {
    const found = result.flows.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`flow ${name} not reported`);
    return found;
  };

  it('runs a wizard flow step by step, then stops (flows only)', async () => {
    const result = await run(
      'wizard',
      `
flows:
  - name: nouveau-dossier
    startAt: /dossiers
    steps:${WIZARD_STEPS}
`,
      false,
    );
    const report = flow(result, 'nouveau-dossier');
    expect(report.steps.map((step) => step.status)).toEqual(Array(11).fill('PASSED'));
    expect(report.status).toBe('PASSED');
    expect(result.stats.flowsPassed).toBe(1);
    // Le flow est passé par les trois étapes de l'assistant (même URL, trois états).
    const headings = report.states.flatMap(
      (id) => result.states.find((state) => state.id === id)?.headings ?? [],
    );
    expect(headings).toEqual(expect.arrayContaining(['Étape 2 — Détails', 'Étape 3 — Confirmation']));
    // Les transitions portent le nom du flow dans le graphe.
    expect(
      result.transitions.filter((edge) => edge.flow === 'nouveau-dossier').length,
    ).toBeGreaterThanOrEqual(6);
    // La capture nommée existe.
    const shot = report.steps[10]?.screenshot;
    expect(shot).toBeDefined();
    await access(shot ?? '');
    expect(result.stopReason).toBe('flows-only');
    expect(lastHits).toEqual([]);
    // La valeur lue dans l'environnement n'apparaît jamais dans les rapports.
    const json = await readFile(path.join(outputDir, 'wizard', 'reports', 'result.json'), 'utf8');
    expect(json).not.toContain('demandeur@example.test');
    expect(json).toContain('${env:QA_FLOW_EMAIL}');
  });

  it('stops before a MUTATION step without "allow: MUTATION"', async () => {
    const result = await run(
      'mutation-blocked',
      `
flows:
  - name: enregistrer
    startAt: /dossiers
    steps:${WIZARD_STEPS}
      - click: { role: button, name: Enregistrer le dossier }
      - expect: { text: Dossier enregistré }
`,
      false,
    );
    const report = flow(result, 'enregistrer');
    expect(report.status).toBe('BLOCKED');
    expect(report.steps[11]?.status).toBe('BLOCKED');
    expect(report.steps[11]?.classification).toBe('MUTATION');
    expect(report.steps[11]?.reason).toContain('allow: MUTATION');
    expect(report.steps[12]?.status).toBe('SKIPPED');
    const issue = result.issues.find((candidate) => candidate.type === 'FLOW');
    expect(issue?.severity).toBe('ERROR');
    expect(issue?.message).toContain('Enregistrer le dossier');
    expect(lastHits).toEqual([]);
  });

  it('executes a MUTATION step when the step allows it', async () => {
    const result = await run(
      'mutation-allowed',
      `
flows:
  - name: enregistrer
    startAt: /dossiers
    steps:${WIZARD_STEPS}
      - click: { role: button, name: Enregistrer le dossier }
        allow: MUTATION
`,
      false,
    );
    expect(flow(result, 'enregistrer').status).toBe('PASSED');
    expect(lastHits).toEqual(['POST /api/danger/save-dossier']);
  });

  it('fills a password only from an environment variable, never logged', async () => {
    const result = await run(
      'login',
      `
flows:
  - name: connexion
    startAt: /login
    steps:
      - fill: { label: Identifiant, value: agent.qa }
      - fill: { label: Mot de passe, value: { env: QA_FLOW_PASSWORD } }
      - click: { role: button, name: Se connecter }
      - expect: { text: Bienvenue agent.qa }
  - name: connexion-en-clair
    startAt: /login
    steps:
      - fill: { label: Mot de passe, value: motdepasse-en-clair }
`,
      false,
    );
    expect(flow(result, 'connexion').status).toBe('PASSED');
    const clear = flow(result, 'connexion-en-clair');
    expect(clear.status).toBe('BLOCKED');
    expect(clear.steps[0]?.reason).toContain('environment variable');
    expect(clear.steps[0]?.description).toBe('fill label="Mot de passe" = "***"');
    const json = await readFile(path.join(outputDir, 'login', 'reports', 'result.json'), 'utf8');
    const html = await readFile(path.join(outputDir, 'login', 'reports', 'index.html'), 'utf8');
    for (const text of [json, html]) {
      expect(text).not.toContain('S3cret-Flow!');
      expect(text).not.toContain('motdepasse-en-clair');
    }
  });

  it('targets the element of the open dialog when the page behind has the same label', async () => {
    const result = await run(
      'dialog',
      `
flows:
  - name: membre
    startAt: /equipe
    steps:
      - fill: { label: Nom, value: Awa Diop }
      - expect: { text: "Aperçu : Awa Diop" }
`,
      false,
    );
    expect(flow(result, 'membre').status).toBe('PASSED');
  });

  it('does not execute a DANGEROUS step the mission does not allow, whatever the step says', async () => {
    const result = await run(
      'dangerous',
      `
flows:
  - name: supprimer
    startAt: /users/1
    steps:
      - click: { role: button, name: Supprimer l'utilisateur }
        allow: [MUTATION, UNKNOWN]
`,
      false,
    );
    const report = flow(result, 'supprimer');
    expect(report.status).toBe('BLOCKED');
    expect(report.steps[0]?.classification).toBe('DANGEROUS');
    expect(report.steps[0]?.reason).toContain('not allowed by the mission');
    expect(lastHits).toEqual([]);
  });

  it('never fills a payment field, and reports failed expectations with a screenshot', async () => {
    const result = await run(
      'failures',
      `
report:
  language: fr
flows:
  - name: carte
    startAt: /dossiers/create
    steps:
      - fill: { label: Titre, value: Dossier QA }
      - fill: { label: Email du demandeur, value: qa@example.test }
      - click: { role: button, name: Suivant }
      - fill: { label: Numéro de carte bancaire, value: "4111111111111111" }
        optional: true
      - expect: { text: Ce texte n'existe pas }
        timeoutMs: 500
      - click: { role: button, name: Précédent }
`,
      false,
    );
    const report = flow(result, 'carte');
    expect(report.steps[3]?.status).toBe('BLOCKED');
    expect(report.steps[3]?.reason).toContain('payment');
    expect(report.steps[4]?.status).toBe('FAILED');
    expect(report.steps[4]?.screenshot).toBeDefined();
    expect(report.steps[5]?.status).toBe('SKIPPED');
    expect(report.status).toBe('FAILED');
    const severities = result.issues.filter((issue) => issue.type === 'FLOW').map((issue) => issue.severity);
    expect(severities.sort()).toEqual(['ERROR', 'WARNING']);
    const json = await readFile(path.join(outputDir, 'failures', 'reports', 'result.json'), 'utf8');
    expect(json).not.toContain('4111111111111111'.slice(4));
    // report.language: fr — le HTML est en français, result.json reste en anglais.
    const html = await readFile(path.join(outputDir, 'failures', 'reports', 'index.html'), 'utf8');
    expect(html).toContain('<html lang="fr">');
    for (const text of [
      'Flows imposés',
      'BLOQUÉ',
      'ÉCHOUÉ',
      'IGNORÉ',
      'champ de paiement',
      'Échecs des flows',
    ]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain('Imposed flows');
    expect(json).toContain('"status": "BLOCKED"');
    const graph = await readFile(path.join(outputDir, 'failures', 'reports', 'flow-graph.html'), 'utf8');
    expect(graph).toContain('Carte de l&#39;application');
  });

  it('explores the last screen of a flow (thenExplore), then the whole application', async () => {
    const result = await run(
      'then-explore',
      `
flows:
  - name: fiche-utilisateur
    startAt: /users
    thenExplore: true
    steps:
      - click: { role: link, name: Voir, nth: 2 }
      - expect: { url: /users/3 }
`,
    );
    const report = flow(result, 'fiche-utilisateur');
    expect(report.status).toBe('PASSED');
    expect(report.explored).toBe(true);
    // L'onglet Historique de la page utilisateur a été exploré juste après le flow…
    expect(
      result.states.some((state) => state.route === '/users/:id' && state.subtitle?.includes('Historique')),
    ).toBe(true);
    // …et l'exploration autonome a couvert le reste de l'application.
    expect(result.states.some((state) => state.headings.includes('Journal'))).toBe(true);
    expect(result.states[0]?.url).toBe(`${app.url}/`);
    expect(lastHits).toEqual([]);
  });

  it('keeps thenExplore on the flow screen: no global menu, even with autonomous false', async () => {
    const result = await run(
      'then-explore-scope',
      `
flows:
  - name: fiche-utilisateur
    startAt: /users
    thenExplore: true
    steps:
      - click: { role: link, name: Voir, nth: 2 }
`,
      false,
    );
    const report = flow(result, 'fiche-utilisateur');
    expect(report.explored).toBe(true);
    expect(result.stopReason).toBe('flows-only');
    // Les onglets de /users/3 ont été explorés…
    const user = result.states.filter((state) => state.route === '/users/:id');
    expect(user.some((state) => state.subtitle?.includes('Historique'))).toBe(true);
    // …mais rien de ce que le flow n'atteignait pas : seulement la page de départ, les pages du flow et /users/3.
    const executed = result.transitions.filter(
      (edge) => edge.result === 'SUCCESS' && edge.flow === undefined,
    );
    expect(executed.length).toBeGreaterThan(0);
    for (const edge of executed) {
      expect(result.states.find((state) => state.id === edge.to)?.route, edge.action.text).toBe('/users/:id');
    }
    expect(result.states.some((state) => ['/settings', '/admin', '/dossiers'].includes(state.route))).toBe(
      false,
    );
    expect(lastHits).toEqual([]);
  });
});
