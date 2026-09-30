import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  describeFlowIntent,
  sameIntent,
  type FlowIntent,
  type FlowIntentGraph,
} from '../../src/dry-run/flow-intent-graph.js';
import { loadDryRunScenario } from '../../src/dry-run/scenario-input.js';

const FEATURE = `# language: fr
@mutation
Fonctionnalité: Utilisateurs
  Scénario: Créer un utilisateur
    Étant donné que je suis sur "/"
    Quand je clique sur le lien "Utilisateurs"
    Et je clique sur le bouton "Créer un utilisateur"
    Et je saisis "test@example.com" dans "Courriel"
    Et je choisis "Administrateur" dans "Rôle"
    Et je prends une capture "formulaire"
    Et je clique sur le bouton "Valider"
    Alors je vois "Utilisateur créé"
`;

const FLOW_YAML = `name: Créer un utilisateur
steps:
  - goto: /
  - click: { role: link, name: Utilisateurs }
  - click: { role: button, name: Créer un utilisateur }
  - fill: { label: Courriel, value: test@example.com }
  - select: { label: Rôle, option: Administrateur }
  - screenshot: formulaire
  - click: { role: button, name: Valider }
    allow: MUTATION
  - expect: { text: Utilisateur créé }
`;

/** Les mêmes intentions, écrites comme le métier les écrit (résolution sémantique). */
const SEMANTIC = `# language: fr
@mutation
Fonctionnalité: Utilisateurs
  Plan du scénario: Créer un utilisateur
    Étant donné que je suis sur "/"
    Quand l'utilisateur accède à "Utilisateurs"
    Et il clique sur créer un utilisateur
    Et renseigne le courriel avec "<courriel>"
    Et valide le formulaire
    Alors un message de confirmation est affiché
    Et je vérifie le libellé du rôle manuellement

    Exemples:
      | courriel         |
      | test@example.com |
`;

const MISSION = `target: { baseUrl: http://localhost:4200 }
gherkin:
  semanticResolution: { enabled: true }
  steps:
    - pattern: je vérifie le libellé du rôle manuellement
      manual: true
flows:
  - name: accueil
    steps: [{ goto: / }]
`;

const shape = (intent: FlowIntent) => ({
  type: intent.type,
  semanticTarget: intent.semanticTarget,
  value: intent.value,
});

describe('FlowIntentGraph: the expected flow, whatever its syntax', () => {
  let dir: string;
  let gherkin: FlowIntentGraph;
  let yaml: FlowIntentGraph;
  let semantic: FlowIntentGraph;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-dry-run-intents-'));
    await writeFile(path.join(dir, 'create-user.feature'), FEATURE);
    await writeFile(path.join(dir, 'create-user.flow.yaml'), FLOW_YAML);
    await writeFile(path.join(dir, 'semantic.feature'), SEMANTIC);
    await writeFile(path.join(dir, 'mission.yaml'), MISSION);
    const load = (file: string) =>
      loadDryRunScenario({ scenarioFile: path.join(dir, file), missionFile: path.join(dir, 'mission.yaml') });
    [gherkin] = load('create-user.feature').graphs as [FlowIntentGraph];
    [yaml] = load('create-user.flow.yaml').graphs as [FlowIntentGraph];
    [semantic] = load('semantic.feature').graphs as [FlowIntentGraph];
  });

  it('Gherkin → FlowIntentGraph: one intent per sentence, with its type and semantic target', () => {
    expect(gherkin.source.type).toBe('GHERKIN');
    expect(gherkin.name).toBe('Créer un utilisateur');
    expect(gherkin.intents.map(shape)).toEqual([
      { type: 'NAVIGATE', semanticTarget: 'home', value: undefined },
      { type: 'CLICK', semanticTarget: 'utilisateurs', value: undefined },
      { type: 'CLICK', semanticTarget: 'creer-un-utilisateur', value: undefined },
      { type: 'FILL', semanticTarget: 'courriel', value: 'test@example.com' },
      { type: 'SELECT', semanticTarget: 'role', value: 'Administrateur' },
      { type: 'SUBMIT', semanticTarget: 'valider', value: undefined },
      { type: 'ASSERT', semanticTarget: 'utilisateur-cree', value: undefined },
    ]);
  });

  it('YAML → FlowIntentGraph: the same intents give the same internal representation', () => {
    expect(yaml.source.type).toBe('YAML');
    expect(yaml.intents.map(shape)).toEqual(gherkin.intents.map(shape));
    yaml.intents.forEach((intent, index) => {
      const twin = gherkin.intents[index];
      expect(twin && sameIntent(intent, twin)).toBe(true);
    });
  });

  it('every intent keeps its origin: file, line, position, text, and the executable step', () => {
    const [start, users] = gherkin.intents;
    expect(start?.sourceReference).toMatchObject({ line: 5, step: 1 });
    expect(users?.sourceReference).toMatchObject({
      line: 6,
      step: 2,
      text: 'Quand je clique sur le lien "Utilisateurs"',
    });
    expect(users?.step).toMatchObject({ kind: 'click', target: { strategy: 'role', role: 'link' } });
    // La capture n'est pas une intention : la position suivante garde son numéro d'étape.
    expect(gherkin.intents.find((intent) => intent.type === 'SUBMIT')?.sourceReference.step).toBe(7);
    // @mutation : la permission du scénario suit l'intention.
    expect(gherkin.intents.every((intent) => intent.allow.includes('MUTATION'))).toBe(true);
    expect(yaml.intents.find((intent) => intent.type === 'SUBMIT')?.allow).toEqual(['MUTATION']);
  });

  it('semantic sentences (third person, outline) become intents too; manual checks are not required', () => {
    expect(semantic.name).toBe('Créer un utilisateur [test@example.com]');
    expect(semantic.intents.map(shape)).toEqual([
      { type: 'NAVIGATE', semanticTarget: 'home', value: undefined },
      { type: 'NAVIGATE', semanticTarget: 'utilisateurs', value: undefined },
      { type: 'CLICK', semanticTarget: 'creer-un-utilisateur', value: undefined },
      { type: 'FILL', semanticTarget: 'courriel', value: 'test@example.com' },
      { type: 'SUBMIT', semanticTarget: 'valider', value: undefined },
      { type: 'ASSERT', semanticTarget: 'message', value: undefined },
      { type: 'CUSTOM', semanticTarget: 'je-verifie-le-libelle-du-role-manuellement', value: undefined },
    ]);
    expect(semantic.intents.at(-1)?.required).toBe(false);
    expect(semantic.intents.slice(0, -1).every((intent) => intent.required)).toBe(true);
    // Plan du scénario : la ligne du modèle, valeurs d'exemples comprises.
    expect(semantic.intents[3]?.sourceReference.line).toBe(8);
  });

  it('only the scenario is checked: the other flows of the mission are left out', () => {
    const loaded = loadDryRunScenario({
      scenarioFile: path.join(dir, 'create-user.feature'),
      missionFile: path.join(dir, 'mission.yaml'),
    });
    expect(loaded.config.flows.map((flow) => flow.name)).toEqual(['Créer un utilisateur']);
  });

  it('the source files are only read, never written', async () => {
    const before = await readFile(path.join(dir, 'create-user.feature'), 'utf8');
    loadDryRunScenario({
      scenarioFile: path.join(dir, 'create-user.feature'),
      missionFile: path.join(dir, 'mission.yaml'),
    });
    expect(await readFile(path.join(dir, 'create-user.feature'), 'utf8')).toBe(before);
  });

  it('a value is never printed', () => {
    const fill = gherkin.intents.find((intent) => intent.type === 'FILL');
    expect(fill && describeFlowIntent(fill)).toBe('FILL "Courriel" = "…"');
    expect(describeFlowIntent({ type: 'FILL', label: 'Mot de passe', value: { env: 'QA_PASSWORD' } })).toBe(
      'FILL "Mot de passe" = ${env}',
    );
  });

  it('a file that is neither a feature nor a flow is refused with an explanation', async () => {
    await writeFile(path.join(dir, 'other.yaml'), 'target: { baseUrl: http://localhost }\n');
    expect(() => loadDryRunScenario({ scenarioFile: path.join(dir, 'other.yaml') })).toThrow(
      /Not a flow file/,
    );
  });
});

describe('dry run of a business scenario: unknown sentences never block the analysis', () => {
  const BUSINESS = `Feature: Code de catégorie
  Scenario Outline: Modifier le code de catégorie
    Given un dossier est créé avec succès
    When l'utilisateur accède à l'étape "Analyse", à l'onglet "Détails" et à la section "Activité"
    And modifie le code de catégorie de 111 à <Nouveau code>
    And quitte l'onglet afin d'enregistrer les modifications
    Then le code <Nouveau code> est affiché dans le dossier

    Examples:
      | Nouveau code |
      | 222          |
      | 333          |
      | 444          |
`;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-dry-run-business-'));
    await writeFile(path.join(dir, 'code.feature'), BUSINESS);
    await writeFile(path.join(dir, 'mission.yaml'), 'target: { baseUrl: http://localhost:4200 }\n');
    await writeFile(
      path.join(dir, 'strict.yaml'),
      'target: { baseUrl: http://localhost:4200 }\ngherkin: { auto: false }\n',
    );
  });

  it('auto mode and semantic resolution are on by default: every example becomes a flow', () => {
    const { graphs } = loadDryRunScenario({
      scenarioFile: path.join(dir, 'code.feature'),
      missionFile: path.join(dir, 'mission.yaml'),
    });
    expect(graphs).toHaveLength(3);
    expect(graphs[0]?.intents.map((intent) => `${intent.type} ${intent.label}`)).toEqual([
      'CUSTOM un dossier est créé avec succès',
      'NAVIGATE Analyse',
      'NAVIGATE Détails',
      'NAVIGATE Activité',
      'FILL code de catégorie',
      "CUSTOM quitte l'onglet afin d'enregistrer les modifications",
      'CUSTOM le code 222 est affiché dans le dossier',
    ]);
    expect(graphs[2]?.intents[4]?.value).toBe('444');
  });

  it('a mission that says gherkin.auto: false is respected; each unknown sentence is listed once', () => {
    let message = '';
    try {
      loadDryRunScenario({
        scenarioFile: path.join(dir, 'code.feature'),
        missionFile: path.join(dir, 'strict.yaml'),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Unrecognised Gherkin sentence');
    expect(message.match(/quitte l'onglet/g)).toHaveLength(1);
  });

  it('without a mission nor an address: a clear message, not a schema error', () => {
    expect(() => loadDryRunScenario({ scenarioFile: path.join(dir, 'code.feature'), env: {} })).toThrow(
      /No target application for the dry run/,
    );
  });
});
