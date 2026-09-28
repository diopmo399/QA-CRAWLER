import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config/config-loader.js';
import { GherkinStepDictionary } from '../../src/flows/gherkin/gherkin-steps.js';

describe('Gherkin sentences → flow steps', () => {
  const dictionary = new GherkinStepDictionary();
  const one = (text: string, table?: string[][]): unknown => dictionary.translate(text, table)?.[0];

  it('French: navigate, click (with or without an element type), fill, select, check', () => {
    expect(one('je suis sur "/clients"')).toEqual({ goto: '/clients' });
    expect(one('Je clique sur le bouton "Enregistrer"')).toEqual({
      click: { role: 'button', name: 'Enregistrer' },
    });
    expect(one("je clique sur l'onglet « Profil »")).toEqual({ click: { role: 'tab', name: 'Profil' } });
    expect(one('je clique sur "Aide"')).toEqual({ click: { text: 'Aide' } });
    expect(one('je saisis "Dupont" dans "Nom"')).toEqual({ fill: { label: 'Nom', value: 'Dupont' } });
    expect(one('je remplis le champ "Ville" avec "Lyon"')).toEqual({
      fill: { label: 'Ville', value: 'Lyon' },
    });
    expect(one('je choisis "Oui" dans la liste "Déjà client ?"')).toEqual({
      select: { label: 'Déjà client ?', option: 'Oui' },
    });
    expect(one('je coche la case "J\'accepte"')).toEqual({ check: { role: 'checkbox', name: "J'accepte" } });
    expect(one('je décoche "Newsletter"')).toEqual({ uncheck: { label: 'Newsletter' } });
  });

  it('French: checks and screenshots', () => {
    expect(one('je vois "Client créé"')).toEqual({ expect: { text: 'Client créé' } });
    expect(one('le bouton "Supprimer" est visible')).toEqual({
      expect: { visible: { role: 'button', name: 'Supprimer' } },
    });
    expect(one('je ne vois pas "Erreur"')).toEqual({ expect: { hidden: { text: 'Erreur' } } });
    expect(one('l\'URL contient "/confirmation"')).toEqual({ expect: { url: '/confirmation' } });
    expect(one('je prends une capture "après création"')).toEqual({ screenshot: 'après création' });
  });

  it('English sentences', () => {
    expect(one('I am on "/users"')).toEqual({ goto: '/users' });
    expect(one('I click the link "Users"')).toEqual({ click: { role: 'link', name: 'Users' } });
    expect(one('I fill in "Email" with "a@b.test"')).toEqual({ fill: { label: 'Email', value: 'a@b.test' } });
    expect(one('I select "Admin" from "Role"')).toEqual({ select: { label: 'Role', option: 'Admin' } });
    expect(one('I should see "Saved"')).toEqual({ expect: { text: 'Saved' } });
    expect(one('the URL contains "/users/"')).toEqual({ expect: { url: '/users/' } });
  });

  it('a data table fills one field per row; a secret comes from the environment', () => {
    expect(
      dictionary.translate('je remplis le formulaire :', [
        ['champ', 'valeur'],
        ['Nom', 'Dupont'],
        ['Mot de passe', '<env:APP_PASSWORD>'],
      ]),
    ).toEqual([
      { fill: { label: 'Nom', value: 'Dupont' } },
      { fill: { label: 'Mot de passe', value: { env: 'APP_PASSWORD' } } },
    ]);
  });

  it('an unknown sentence is not guessed', () => {
    expect(dictionary.translate('je fais quelque chose de vague')).toBeUndefined();
    expect(dictionary.translate('je clique partout')).toBeUndefined();
  });

  it('team sentences from the mission come first', () => {
    const custom = new GherkinStepDictionary([
      { pattern: "j'ouvre le dossier {numéro}", step: { click: { role: 'link', name: 'Dossier {numéro}' } } },
      { pattern: 'je me connecte avec {secret}', step: { fill: { label: 'Code', value: '{secret}' } } },
    ]);
    expect(custom.translate('j\'ouvre le dossier "A-12"')).toEqual([
      { click: { role: 'link', name: 'Dossier A-12' } },
    ]);
    expect(custom.translate('je me connecte avec "<env:CODE>"')).toEqual([
      { fill: { label: 'Code', value: { env: 'CODE' } } },
    ]);
  });
});

describe('flows: - gherkin: file.feature', () => {
  let dir: string;
  const mission = (flows: string, extra = ''): string => `
mission: { name: g }
target: { baseUrl: http://localhost:4200 }
flows:
${flows}
${extra}`;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-gherkin-'));
    await writeFile(
      path.join(dir, 'clients.feature'),
      `# language: fr
@mutation
Fonctionnalité: Clients

  Contexte:
    Étant donné que je suis sur "/clients"

  Scénario: Création simple
    Quand je clique sur le bouton "Nouveau client"
    Et je remplis le formulaire :
      | Nom   | Dupont |
      | Ville | Lyon   |
    Et je clique sur le bouton "Enregistrer"
    Alors je vois "Client créé"
    Et je suis sur "/clients/"
    Et je prends une capture "fiche" (optionnel)

  @explorer
  Plan du scénario: Recherche
    Quand je saisis "<nom>" dans "Rechercher"
    Alors je vois "<résultat>"

    Exemples:
      | nom    | résultat  |
      | Dupont | 1 client  |
      | Zzz    | Aucun     |

  @ignore
  Scénario: Pas encore prêt
    Quand je clique sur "Plus tard"
`,
    );
    await writeFile(
      path.join(dir, 'broken.feature'),
      `Feature: Broken
  Scenario: Vague
    Given I am on "/"
    When I do something clever
    Then I should see "ok"
`,
    );
    await writeFile(path.join(dir, 'mission.yaml'), mission('  - gherkin: ./clients.feature'));
  });

  it('each scenario becomes a flow: background first, one flow per example row, tags applied', () => {
    const { config } = parseConfig(mission(`  - gherkin: ${path.join(dir, 'clients.feature')}`));
    expect(config.flows.map((flow) => flow.name)).toEqual([
      'Création simple',
      'Recherche [Dupont, 1 client]',
      'Recherche [Zzz, Aucun]',
    ]);
    const [creation, search] = config.flows;
    expect(creation?.description).toMatch(/clients\.feature:8$/);
    expect(creation?.steps.map((step) => step.name)).toEqual([
      'Étant donné que je suis sur "/clients"',
      'Quand je clique sur le bouton "Nouveau client"',
      'Et je remplis le formulaire : (Nom)',
      'Et je remplis le formulaire : (Ville)',
      'Et je clique sur le bouton "Enregistrer"',
      'Alors je vois "Client créé"',
      'Et je suis sur "/clients/"',
      'Et je prends une capture "fiche"',
    ]);
    expect(creation?.steps.map((step) => step.kind)).toEqual([
      'goto',
      'click',
      'fill',
      'fill',
      'click',
      'expect',
      // « Alors/Et je suis sur » après un Alors : une vérification d'adresse, pas une navigation.
      'expect',
      'screenshot',
    ]);
    expect(creation?.steps.every((step) => step.allow.includes('MUTATION'))).toBe(true);
    expect(creation?.steps.at(-1)?.optional).toBe(true);
    expect(creation?.thenExplore).toBe(false);
    expect(search?.thenExplore).toBe(true);
    expect(search?.steps[1]).toMatchObject({ kind: 'fill', value: 'Dupont' });
  });

  it('paths are relative to the mission file; scenarios and tags filter', () => {
    const { config } = parseConfig(
      mission('  - gherkin: ./clients.feature\n    scenarios: ["Recherche"]'),
      {},
      {},
      path.join(dir, 'mission.yaml'),
    );
    expect(config.flows).toHaveLength(2);
    const tagged = parseConfig(
      mission('  - gherkin: ./clients.feature\n    tags: ["@explorer"]'),
      {},
      {},
      path.join(dir, 'mission.yaml'),
    );
    expect(tagged.config.flows.map((flow) => flow.name)).toEqual([
      'Recherche [Dupont, 1 client]',
      'Recherche [Zzz, Aucun]',
    ]);
  });

  it('YAML flows and Gherkin flows can be mixed', () => {
    const { config } = parseConfig(
      mission(
        `  - name: accueil
    steps:
      - goto: /
  - gherkin: ${path.join(dir, 'clients.feature')}
    scenarios: ["Création simple"]`,
      ),
    );
    expect(config.flows.map((flow) => flow.name)).toEqual(['accueil', 'Création simple']);
  });

  it('an unrecognised sentence is an error with the file and the line', () => {
    expect(() => parseConfig(mission(`  - gherkin: ${path.join(dir, 'broken.feature')}`))).toThrow(
      /broken\.feature:4: "When I do something clever"/,
    );
  });

  it('team sentences from gherkin.steps make it valid', () => {
    const { config } = parseConfig(
      mission(
        `  - gherkin: ${path.join(dir, 'broken.feature')}`,
        `gherkin:
  steps:
    - pattern: I do something clever
      step: { click: { role: button, name: Clever } }`,
      ),
    );
    expect(config.flows[0]?.steps[1]).toMatchObject({
      kind: 'click',
      target: { strategy: 'role', role: 'button', name: 'Clever' },
    });
  });

  it('a missing file, a missing scenario or an unknown key are explicit errors', () => {
    expect(() => parseConfig(mission('  - gherkin: /nope/x.feature'))).toThrow(ConfigError);
    expect(() =>
      parseConfig(mission(`  - gherkin: ${path.join(dir, 'clients.feature')}\n    scenarios: ["Nope"]`)),
    ).toThrow(/Scenario\(s\) not found/);
    expect(() =>
      parseConfig(mission(`  - gherkin: ${path.join(dir, 'clients.feature')}\n    steps: []`)),
    ).toThrow(/unknown key\(s\) steps/);
  });
});
