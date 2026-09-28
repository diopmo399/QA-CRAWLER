import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { resolveFlowRuns } from '../../src/flows/flow-includes.js';
import { responseFailure } from '../../src/flows/flow-step-executor.js';
import { GherkinStepDictionary } from '../../src/flows/gherkin/gherkin-steps.js';

describe('team sentences: several steps, unquoted values, manual checks', () => {
  const dictionary = new GherkinStepDictionary([
    {
      pattern: "l'utilisateur modifie le code de {ancien:mot} à {nouveau:mot}",
      steps: [
        { fill: { label: 'Code', value: '{nouveau}' } },
        { click: { role: 'button', name: 'Valider le code' } },
      ],
      allow: 'MUTATION',
    },
    { pattern: 'le libellé {libellé:texte} est affiché', step: { expect: { text: '{libellé}' } } },
    { pattern: 'aucune autre donnée du dossier n’est modifiée', manual: true },
  ]);

  it('{x:mot} takes a value with or without quotes; allow is added to every step', () => {
    expect(dictionary.translate("l'utilisateur modifie le code de 11111 à 22222")).toEqual([
      { fill: { label: 'Code', value: '22222' }, allow: ['MUTATION'] },
      { click: { role: 'button', name: 'Valider le code' }, allow: ['MUTATION'] },
    ]);
    expect(dictionary.translate('l\'utilisateur modifie le code de "11111" à "2 2"')?.[0]).toMatchObject({
      fill: { value: '2 2' },
    });
    // Un mot, pas une phrase : « 11111 et plus » ne correspond pas.
    expect(dictionary.translate("l'utilisateur modifie le code de 11111 et plus à 2")).toBeUndefined();
  });

  it('{x:texte} takes any text', () => {
    expect(dictionary.translate('le libellé Production de miel est affiché')).toEqual([
      { expect: { text: 'Production de miel' } },
    ]);
  });

  it('manual: true keeps the sentence as a check to do by hand', () => {
    expect(dictionary.translate("aucune autre donnée du dossier n'est modifiée")).toEqual([
      { manual: "aucune autre donnée du dossier n'est modifiée" },
    ]);
  });

  it('built-in: no error message, request succeeds / responds', () => {
    const builtin = new GherkinStepDictionary();
    expect(builtin.translate("aucun message d'erreur n'est affiché à l'utilisateur")).toEqual([
      { expect: { noError: true } },
    ]);
    expect(builtin.translate('la requête PUT "/api/dossiers/*/code" réussit')).toEqual([
      { expect: { response: { method: 'PUT', url: '/api/dossiers/*/code' } } },
    ]);
    expect(builtin.translate('the request "/api/users" responds 201')).toEqual([
      { expect: { response: { url: '/api/users', status: 201 } } },
    ]);
  });
});

describe('expect.response', () => {
  const network = [
    { method: 'GET', url: 'http://app.test/api/dossiers/1', status: 200, resourceType: 'fetch' },
    { method: 'PUT', url: 'http://app.test/api/dossiers/1/code', status: 422, resourceType: 'fetch' },
  ];

  it('the last matching request must have the expected status (2xx by default)', () => {
    expect(responseFailure({ url: '/api/dossiers/1', status: '2xx' }, network.slice(0, 1))).toBeUndefined();
    expect(responseFailure({ method: 'PUT', url: '/api/dossiers/*/code', status: '2xx' }, network)).toBe(
      'PUT "/api/dossiers/*/code" answered 422 (expected 2xx)',
    );
    expect(
      responseFailure({ method: 'PUT', url: '/api/dossiers/*/code', status: 422 }, network),
    ).toBeUndefined();
    expect(responseFailure({ method: 'DELETE', url: '/api/x', status: '2xx' }, network)).toMatch(
      /^no request DELETE "\/api\/x" seen during the flow \(last: GET \/api\/dossiers\/1, PUT/,
    );
  });
});

describe('run: another flow as a precondition', () => {
  it('its steps are copied in place, named after the step; reusable flows do not run alone', () => {
    const flows = resolveFlowRuns([
      {
        name: 'creer',
        reusable: true,
        steps: [
          { click: { role: 'button', name: 'Nouveau' } },
          { name: 'nom', fill: { label: 'Nom', value: 'x' } },
        ],
      },
      {
        name: 'modifier',
        steps: [{ run: 'creer', name: 'Given un dossier existe' }, { click: { text: 'Modifier' } }],
      },
    ]) as { name: string; steps: { name?: string }[] }[];
    expect(flows.map((flow) => flow.name)).toEqual(['modifier']);
    expect(flows[0]?.steps.map((step) => step.name)).toEqual([
      'Given un dossier existe › click "Nouveau"',
      'Given un dossier existe › nom',
      undefined,
    ]);
  });

  it('an unknown flow or a loop is an explicit error', () => {
    expect(() => resolveFlowRuns([{ name: 'a', steps: [{ run: 'nope' }] }])).toThrow(/no flow has this name/);
    expect(() =>
      resolveFlowRuns([
        { name: 'a', steps: [{ run: 'b' }] },
        { name: 'b', steps: [{ run: 'a' }] },
      ]),
    ).toThrow(/"run" loop "a" → "b" → "a"/);
  });
});

describe('Gherkin file with preconditions, outlines and team sentences', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-glue-'));
    await writeFile(
      path.join(dir, 'code.feature'),
      `Feature: Code
  Scenario Outline: Modifier le code
    Given un dossier est créé avec succès
    When l'utilisateur modifie le code de <ancien> à <nouveau>
    Then la requête PUT "/api/dossiers/*/code" réussit
    And aucun message d'erreur n'est affiché
    And aucune autre donnée du dossier n'est modifiée

    Examples:
      | ancien | nouveau |
      | 11111  | 22222   |
`,
    );
    await writeFile(path.join(dir, 'headless.feature'), `Given I am on "/"\n`);
  });

  it('becomes one flow per example; the precondition flow is replayed first', () => {
    const { config } = parseConfig(
      `
mission: { name: glue }
target: { baseUrl: http://localhost:4200 }
flows:
  - name: creer-dossier
    reusable: true
    steps:
      - click: { role: button, name: Nouveau dossier }
      - click: { role: button, name: Enregistrer }
        allow: MUTATION
  - gherkin: ./code.feature
gherkin:
  steps:
    - pattern: un dossier est créé avec succès
      steps: [{ run: creer-dossier }]
    - pattern: "l'utilisateur modifie le code de {ancien:mot} à {nouveau:mot}"
      steps:
        - fill: { label: Code, value: "{nouveau}" }
        - click: { role: button, name: Valider le code }
      allow: MUTATION
    - pattern: aucune autre donnée du dossier n'est modifiée
      manual: true
`,
      {},
      {},
      path.join(dir, 'mission.yaml'),
    );
    expect(config.flows.map((flow) => flow.name)).toEqual(['Modifier le code [11111, 22222]']);
    const steps = config.flows[0]?.steps ?? [];
    expect(steps.map((step) => [step.kind, step.name])).toEqual([
      ['click', 'Given un dossier est créé avec succès › click "Nouveau dossier"'],
      ['click', 'Given un dossier est créé avec succès › click "Enregistrer"'],
      ['fill', "When l'utilisateur modifie le code de 11111 à 22222 (Code)"],
      ['click', 'When l\'utilisateur modifie le code de 11111 à 22222 (click "Valider le code")'],
      ['expect', 'Then la requête PUT "/api/dossiers/*/code" réussit'],
      ['expect', "And aucun message d'erreur n'est affiché"],
      ['manual', "And aucune autre donnée du dossier n'est modifiée"],
    ]);
    // Les droits du flow rejoué sont les siens ; ceux de la phrase d'équipe s'appliquent à ses étapes.
    expect(steps.map((step) => step.allow)).toEqual([
      [],
      ['MUTATION'],
      ['MUTATION'],
      ['MUTATION'],
      [],
      [],
      [],
    ]);
  });

  it('a file without "Feature:" says so', () => {
    expect(() =>
      parseConfig(
        `
mission: { name: glue }
target: { baseUrl: http://localhost:4200 }
flows:
  - gherkin: ./headless.feature
`,
        {},
        {},
        path.join(dir, 'mission.yaml'),
      ),
    ).toThrow(/must start with "Feature:"/);
  });
});
