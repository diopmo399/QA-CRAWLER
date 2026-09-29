import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { flowSchema } from '../../src/config/flow-schema.js';
import type { DryRunEvent } from '../../src/dry-run/dry-run-engine.js';
import { runDryRun, type DryRunResult } from '../../src/dry-run/dry-run-orchestrator.js';
import { startDryRunApp, type DryRunApp } from '../fixtures/dry-run-app.js';

const FEATURE = `# language: fr
@mutation
Fonctionnalité: Utilisateurs
  Scénario: Créer un utilisateur
    Étant donné que je suis connecté
    Quand je vais dans Utilisateurs
    Et je crée un utilisateur
    Alors l'utilisateur apparaît dans la liste
`;

const FLOW = `name: Créer un utilisateur
steps:
  - goto: /login
  - fill: { label: Identifiant, value: qa }
  - fill: { label: Mot de passe, value: { env: DRYRUN_PASSWORD } }
  - click: { role: button, name: Se connecter }
    allow: MUTATION
  - click: { role: link, name: Utilisateurs }
  - click: { role: link, name: Créer un utilisateur }
    allow: MUTATION
  - expect: { text: Utilisateur créé }
`;

const mission = (url: string, reportsDir: string): string => `mission: { name: dry-run-e2e }
target: { baseUrl: ${url}, startAt: /login }
exploration: { actionTimeoutMs: 3000, settleTimeMs: 50 }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
gherkin:
  semanticResolution: { enabled: true }
  steps:
    - pattern: je suis connecté
      steps:
        - goto: /login
        - fill: { label: Identifiant, value: qa }
        - fill: { label: Mot de passe, value: { env: DRYRUN_PASSWORD } }
        - click: { role: button, name: Se connecter }
    - pattern: je crée un utilisateur
      step: { click: { role: link, name: Créer un utilisateur } }
    - pattern: l'utilisateur apparaît dans la liste
      step: { expect: { text: Utilisateur créé } }
report: { language: fr, failOnSeverity: NONE }
output:
  reportsDir: ${reportsDir}
`;

const env = { ...process.env, DRYRUN_PASSWORD: 'motdepasse-de-test' };

/**
 * DRY RUN de bout en bout, dans Chromium : le scénario dit « connecté → Utilisateurs →
 * créer → la liste », l'application passe par le tableau de bord, l'administration et un
 * assistant en trois écrans. QA-CRAWLER ne s'arrête pas, explore, retrouve chaque
 * intention, découvre les étapes intermédiaires et propose le flow complet — une fois.
 */
describe('dry run, end to end', () => {
  let app: DryRunApp;
  let dir: string;
  let gherkin: DryRunResult;
  let yaml: DryRunResult;
  let remembered: DryRunResult;
  const events: DryRunEvent[] = [];
  let createdByGherkin = 0;

  beforeAll(async () => {
    app = await startDryRunApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-dry-run-e2e-'));
    await writeFile(path.join(dir, 'create-user.feature'), FEATURE);
    await writeFile(path.join(dir, 'create-user.flow.yaml'), FLOW);
    // Deux dossiers de rapports : le Gherkin et le YAML ne partagent pas de mémoire.
    await writeFile(path.join(dir, 'mission.yaml'), mission(app.url, path.join(dir, 'reports')));
    await writeFile(path.join(dir, 'mission-yaml.yaml'), mission(app.url, path.join(dir, 'reports-yaml')));
    gherkin = await runDryRun({
      scenarioFile: path.join(dir, 'create-user.feature'),
      missionFile: path.join(dir, 'mission.yaml'),
      outputFormat: 'both',
      onEvent: (event) => events.push(event),
      run: { env },
    });
    createdByGherkin = app.created.length;
    yaml = await runDryRun({
      scenarioFile: path.join(dir, 'create-user.flow.yaml'),
      missionFile: path.join(dir, 'mission-yaml.yaml'),
      outputFormat: 'both',
      run: { env },
    });
    // Le même scénario une deuxième fois : la mémoire du premier propose le chemin, l'application le confirme.
    remembered = await runDryRun({
      scenarioFile: path.join(dir, 'create-user.feature'),
      missionFile: path.join(dir, 'mission.yaml'),
      run: { env },
    });
  }, 360_000);

  afterAll(async () => {
    await app.close();
  });

  const rows = (result: DryRunResult): string[] =>
    (result.flows[0]?.reconciliation.entries ?? []).map(
      (entry) => `${entry.expectedIntent?.label ?? entry.observedTarget?.label ?? '?'} ${entry.status}`,
    );

  it('Gherkin: never stops, finds every intent, discovers the steps in between', () => {
    expect(rows(gherkin)).toEqual([
      '/login MATCHED',
      'Identifiant MATCHED',
      'Mot de passe MATCHED',
      'Se connecter MATCHED',
      'Administration INSERTED',
      'Utilisateurs MATCHED',
      'Créer un utilisateur MATCHED',
      'Suivant INSERTED',
      'Suivant INSERTED',
      'Confirmer la création INSERTED',
      'Utilisateur créé MATCHED',
    ]);
    expect(gherkin.status).toBe('PARTIALLY_MATCHED');
    expect(gherkin.flows[0]?.reconciliation.summary).toMatchObject({
      originalIntents: 7,
      matched: 7,
      inserted: 4,
    });
  });

  it('the application was really used: one user created, the logout never followed', () => {
    expect(createdByGherkin).toBe(1);
    expect(app.requests).not.toContain('GET /logout');
  });

  it('YAML: the same application, the same suggested flow (semantically)', () => {
    expect(rows(yaml)).toEqual([
      '/login MATCHED',
      'Identifiant MATCHED',
      'Mot de passe MATCHED',
      'Se connecter MATCHED',
      'Administration INSERTED',
      'Utilisateurs MATCHED',
      'Créer un utilisateur MATCHED',
      'Suivant INSERTED',
      'Suivant INSERTED',
      'Confirmer la création INSERTED',
      'Utilisateur créé MATCHED',
    ]);
    const shape = (result: DryRunResult) =>
      (result.flows[0]?.suggested.steps ?? []).map((step) => [
        step.label,
        step.status,
        step.provenance,
        step.fillFormBefore ?? false,
      ]);
    expect(shape(yaml)).toEqual(shape(gherkin));
  });

  it('memory proposes, the application confirms: the second run replays the known path', () => {
    const entries = remembered.flows[0]?.reconciliation.entries ?? [];
    const administration = entries.find((entry) => entry.observedTarget?.label === 'Administration');
    expect(administration?.status).toBe('INSERTED');
    expect(administration?.evidence).toContain('provenance HISTORICAL_CONFIRMED');
    expect(
      remembered.flows[0]?.suggested.steps.find((step) => step.label === 'Administration')?.provenance,
    ).toBe('HISTORICAL_CONFIRMED');
    expect(remembered.status).toBe('PARTIALLY_MATCHED');
  });

  it('one report, one complete suggested flow in both formats; the source files are unchanged', async () => {
    const flow = gherkin.flows[0];
    expect(flow?.directory).toBe(path.join(dir, 'reports', 'dry-run', 'create-user'));
    expect(Object.keys(flow?.files ?? {})).toEqual(
      expect.arrayContaining([
        'expected-flow.json',
        'observed-flow.json',
        'suggested-flow.json',
        'reconciliation.json',
        'suggested.feature',
        'suggested.flow.yaml',
        'index.html',
      ]),
    );
    const directory = flow?.directory ?? '';
    const feature = await readFile(path.join(directory, 'suggested.feature'), 'utf8');
    expect(feature).toContain('Quand je clique sur le lien "Administration"');
    expect(feature).toContain('Et je remplis le formulaire');
    expect(feature).toContain('Et je clique sur le bouton "Confirmer la création"');
    expect(feature).toContain("Alors l'utilisateur apparaît dans la liste");
    expect(feature).not.toMatch(/css=|xpath|\[data-/i);
    const suggestedYaml = await readFile(path.join(directory, 'suggested.flow.yaml'), 'utf8');
    expect(flowSchema.safeParse(parseYaml(suggestedYaml)).success, suggestedYaml).toBe(true);
    const html = await readFile(path.join(directory, 'index.html'), 'utf8');
    expect(html).toContain('PARTIALLY_MATCHED');
    expect(html).toContain('Administration');
    // Aucune valeur secrète dans les fichiers produits.
    for (const file of Object.keys(flow?.files ?? {}).filter(
      (name) => !name.includes('/') && name !== 'exploration report',
    )) {
      const content = await readFile(path.join(directory, file), 'utf8');
      expect(content, file).not.toContain('motdepasse-de-test');
    }
    expect(await readFile(path.join(dir, 'create-user.feature'), 'utf8')).toBe(FEATURE);
    expect(await readFile(path.join(dir, 'create-user.flow.yaml'), 'utf8')).toBe(FLOW);
  });

  it('events tell the story, and nothing is suggested before the end', () => {
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('DRY_RUN_STARTED');
    expect(types).toEqual(
      expect.arrayContaining([
        'INTENT_MISMATCH',
        'GUIDED_EXPLORATION_STARTED',
        'PATH_DISCOVERED',
        'FLOW_STEP_INSERTED',
      ]),
    );
    const reconciled = types.indexOf('FLOW_RECONCILIATION_COMPLETED');
    expect(reconciled).toBeGreaterThan(types.lastIndexOf('INTENT_MATCHED'));
    expect(types.indexOf('SUGGESTED_FLOW_GENERATED')).toBeGreaterThan(reconciled);
    expect(types.at(-1)).toBe('DRY_RUN_COMPLETED');
    expect(JSON.stringify(events)).not.toContain('motdepasse-de-test');
  });
});
