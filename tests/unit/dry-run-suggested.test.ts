import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { flowSchema } from '../../src/config/flow-schema.js';
import { DryRunEngine } from '../../src/dry-run/dry-run-engine.js';
import type { FlowIntentGraph } from '../../src/dry-run/flow-intent-graph.js';
import { reconcile } from '../../src/dry-run/flow-reconciliation.js';
import type { SuggestedFlowGraph } from '../../src/dry-run/reconciliation-model.js';
import { loadDryRunScenario } from '../../src/dry-run/scenario-input.js';
import { buildSuggestedFlow, suggestedFeature, suggestedFlowYaml } from '../../src/dry-run/suggested-flow.js';
import { SyntheticApp, UNLIMITED, type SyntheticScreen } from '../dry-run-app.js';

/** L'application de référence : Connexion → Tableau de bord → Administration → Utilisateurs → assistant → liste. */
const SCREENS: Record<string, SyntheticScreen> = {
  dash: {
    label: 'Tableau de bord',
    actions: [
      { label: 'Rapports', to: 'reports', role: 'link' },
      { label: 'Administration', to: 'admin', role: 'link' },
    ],
  },
  reports: { label: 'Rapports' },
  admin: { label: 'Administration', actions: [{ label: 'Utilisateurs', to: 'users', role: 'link' }] },
  users: {
    label: 'Utilisateurs',
    actions: [{ label: 'Créer un utilisateur', to: 'personal', role: 'button' }],
  },
  personal: {
    label: 'Informations personnelles',
    actions: [
      { label: 'Suivant', to: 'role', category: 'form-step', role: 'button', formFields: ['Prénom', 'Nom'] },
    ],
  },
  role: {
    label: 'Choix du rôle',
    actions: [
      { label: 'Continuer', to: 'confirm', category: 'form-step', role: 'button', formFields: ['Rôle'] },
    ],
  },
  confirm: {
    label: 'Confirmation',
    actions: [
      { label: 'Confirmer', to: 'list', category: 'submit', classification: 'MUTATION', role: 'button' },
    ],
  },
  list: { label: 'Utilisateurs', texts: ['Utilisateur créé'] },
};

const FEATURE = `# language: fr
@mutation
Fonctionnalité: Utilisateurs
  Scénario: Créer un utilisateur
    Étant donné que je suis sur "/"
    Quand je clique sur le lien "Utilisateurs"
    Et je clique sur le lien "Paramètres"
    Et je clique sur le bouton "Créer un utilisateur"
    Alors je vois "Utilisateur créé"
`;

const FLOW = `name: Créer un utilisateur
steps:
  - goto: /
  - click: { role: link, name: Utilisateurs }
  - click: { role: link, name: Paramètres }
  - click: { role: button, name: Créer un utilisateur }
    allow: MUTATION
  - expect: { text: Utilisateur créé }
`;

const MISSION = `target: { baseUrl: http://localhost:4200 }
gherkin: { semanticResolution: { enabled: true } }
`;

async function suggest(graph: FlowIntentGraph): Promise<SuggestedFlowGraph> {
  const app = new SyntheticApp(SCREENS, 'dash');
  const engine = new DryRunEngine(app, { budget: UNLIMITED, continueAfterMismatch: true });
  const { observed, findings } = await engine.run(graph);
  return buildSuggestedFlow(graph, observed, reconcile(graph, observed, findings));
}

describe('SuggestedFlowGraph and its two formats', () => {
  let dir: string;
  let fromGherkin: SuggestedFlowGraph;
  let fromYaml: SuggestedFlowGraph;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-dry-run-suggested-'));
    await writeFile(path.join(dir, 'create-user.feature'), FEATURE);
    await writeFile(path.join(dir, 'create-user.flow.yaml'), FLOW);
    await writeFile(path.join(dir, 'mission.yaml'), MISSION);
    const load = (file: string): FlowIntentGraph => {
      const [graph] = loadDryRunScenario({
        scenarioFile: path.join(dir, file),
        missionFile: path.join(dir, 'mission.yaml'),
      }).graphs;
      if (!graph) throw new Error('no graph');
      return graph;
    };
    // La page de départ est le tableau de bord de l'application synthétique : « je suis sur "/" » y est déjà.
    fromGherkin = await suggest(load('create-user.feature'));
    fromYaml = await suggest(load('create-user.flow.yaml'));
  });

  it('every step has a provenance; observed steps are the ones actually seen', () => {
    expect(fromGherkin.steps.map((step) => `${step.label} ${step.status} ${step.provenance}`)).toEqual([
      '/ MATCHED ORIGINAL',
      'Administration INSERTED OBSERVED',
      'Utilisateurs MATCHED ORIGINAL',
      'Paramètres POSSIBLY_OBSOLETE ORIGINAL',
      'Créer un utilisateur MATCHED ORIGINAL',
      'Suivant INSERTED OBSERVED',
      'Continuer INSERTED OBSERVED',
      'Confirmer INSERTED OBSERVED',
      'Utilisateur créé MATCHED ORIGINAL',
    ]);
    // Une étape introuvable est gardée pour revue, jamais supprimée.
    expect(fromGherkin.steps[3]?.review).toMatch(/^to review: not found/);
    // Les champs remplis avec des données de test deviennent « je remplis le formulaire » avant le bouton.
    expect(fromGherkin.steps.filter((step) => step.fillFormBefore).map((step) => step.label)).toEqual([
      'Suivant',
      'Continuer',
    ]);
  });

  it('a Gherkin and a YAML input give the same suggested flow (semantically)', () => {
    const shape = (flow: SuggestedFlowGraph) =>
      flow.steps.map((step) => [step.label, step.status, step.provenance, step.fillFormBefore ?? false]);
    expect(shape(fromYaml)).toEqual(shape(fromGherkin));
  });

  it('suggested.flow.yaml follows the flow schema of the project; the obsolete step is only a comment', () => {
    for (const suggested of [fromGherkin, fromYaml]) {
      const yaml = suggestedFlowYaml(suggested, ['Suggested by QA-CRAWLER dry run']);
      const parsed = flowSchema.safeParse(parseYaml(yaml));
      expect(parsed.success, yaml).toBe(true);
      expect(yaml).toContain('# POSSIBLY_OBSOLETE · ORIGINAL');
      expect(yaml).toContain('  # - click:\n  #     role: link\n  #     name: Paramètres');
      expect(yaml).toContain('- intent:\n      kind: FILL_FORM');
      expect(yaml).toContain('allow: MUTATION');
      expect(yaml).toContain('# Some steps are intents');
      const steps = parsed.success ? parsed.data.steps : [];
      expect(steps.map((step) => step.kind)).toEqual([
        'goto',
        'click',
        'click',
        'click',
        'intent',
        'click',
        'intent',
        'click',
        'click',
        'expect',
      ]);
    }
  });

  it('suggested.feature: project sentences, no selector, the original sentences kept as written', async () => {
    const feature = suggestedFeature(fromGherkin, { header: ['Suggested by QA-CRAWLER dry run'] });
    expect(feature).toContain('@mutation');
    expect(feature).toContain('    Étant donné que je suis sur "/"');
    expect(feature).toContain('    Quand je clique sur le lien "Administration"');
    expect(feature).toContain('    Et je clique sur le lien "Utilisateurs"');
    expect(feature).toContain('    # Et je clique sur le lien "Paramètres"');
    expect(feature).toContain('    Et je remplis le formulaire');
    expect(feature).toContain('    Et je clique sur le bouton "Confirmer"');
    expect(feature).toContain('    Alors je vois "Utilisateur créé"');
    expect(feature).not.toMatch(/css|xpath|#[a-z]+-\d|\[data-/i);

    // Il se relit : le même chargeur donne les intentions du flow suggéré, dans l'ordre.
    await writeFile(path.join(dir, 'suggested.feature'), feature);
    const [reloaded] = loadDryRunScenario({
      scenarioFile: path.join(dir, 'suggested.feature'),
      missionFile: path.join(dir, 'mission.yaml'),
    }).graphs;
    expect(reloaded?.intents.map((intent) => `${intent.type} ${intent.label}`)).toEqual([
      'NAVIGATE /',
      'CLICK Administration',
      'CLICK Utilisateurs',
      'CLICK Créer un utilisateur',
      'FILL form',
      'CLICK Suivant',
      'FILL form',
      'CLICK Continuer',
      'SUBMIT Confirmer',
      'ASSERT Utilisateur créé',
    ]);
  });

  it('from a YAML input, the feature is generated from the steps (English too)', () => {
    const french = suggestedFeature(fromYaml);
    expect(french).toContain('Quand je clique sur le lien "Administration"');
    const english = suggestedFeature(fromYaml, { language: 'en' });
    expect(english).not.toContain('# language: fr');
    expect(english).toContain('    Given I am on "/"');
    expect(english).toContain('    When I click the link "Administration"');
    expect(english).toContain('    Then I should see "Utilisateur créé"');
  });
});
