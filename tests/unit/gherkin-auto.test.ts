import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import {
  expectedValues,
  findByName,
  mentionsOf,
  planAutoStep,
  valueFor,
} from '../../src/flows/gherkin/auto-step.js';
import { actionLabel } from '../../src/model/discovered-action.js';
import { button, field, link, screen } from '../helpers.js';

const page = screen({
  elements: [
    button('Étape 2', { role: 'tab' }),
    button('Profil', { role: 'tab' }),
    button('Informations générales'),
    link('Aide', 'http://localhost:4200/aide'),
    field('Code postal'),
    field('Code'),
    field('Ville'),
    field('Pays', { tag: 'select', role: 'combobox', inputType: undefined }),
    field("J'accepte les conditions", { role: 'checkbox', inputType: 'checkbox' }),
  ],
});
const label = (plan: ReturnType<typeof planAutoStep>): string | undefined =>
  plan.kind === 'field' ? actionLabel(plan.field) : undefined;

describe('automatic mode: sentences interpreted on the screen', () => {
  it('names quoted in the sentence, with the element type written before them', () => {
    expect(
      mentionsOf(
        'l\'utilisateur accède à l\'étape "Étape 2", à l\'onglet "Profil" et à la section « Adresse »',
      ),
    ).toEqual([{ text: 'Étape 2' }, { text: 'Profil', role: 'tab' }, { text: 'Adresse' }]);
  });

  it('navigation: a verb and quoted names → clicks, in order', () => {
    expect(
      planAutoStep(
        'l\'utilisateur accède à l\'onglet "Profil" et à la section "Informations générales"',
        'Action',
        page.actions,
      ),
    ).toEqual({
      kind: 'navigate',
      mentions: [{ text: 'Profil', role: 'tab' }, { text: 'Informations générales' }],
    });
  });

  it('a field named in the sentence (the longest label) and a value → fill', () => {
    const plan = planAutoStep('And modifie le code postal de 11111 à 22222', 'Action', page.actions);
    expect(plan).toMatchObject({ kind: 'field', action: 'fill', value: '22222' });
    expect(label(plan)).toBe('Code postal');
    expect(planAutoStep('je renseigne la ville avec "Lyon"', 'Action', page.actions)).toMatchObject({
      kind: 'field',
      action: 'fill',
      value: 'Lyon',
    });
  });

  it('select and check', () => {
    const select = planAutoStep('l\'utilisateur choisit "Canada" comme pays', 'Action', page.actions);
    expect(select).toMatchObject({ kind: 'field', action: 'select', value: 'Canada' });
    expect(label(select)).toBe('Pays');
    const check = planAutoStep("l'utilisateur coche j'accepte les conditions", 'Action', page.actions);
    expect(check).toMatchObject({ kind: 'field', action: 'check' });
  });

  it('Then: values quoted, with digits, or after « demeure / reste »; no error; success', () => {
    expect(planAutoStep('le code 455219 est affiché dans la demande', 'Outcome', page.actions)).toEqual({
      kind: 'verify',
      texts: ['455219'],
      hidden: [],
      noError: false,
      lastWriteOk: false,
    });
    expect(expectedValues('le domaine principal demeure Production de miel')).toEqual(['Production de miel']);
    expect(expectedValues('le pourcentage demeure à 60')).toEqual(['60']);
    expect(
      planAutoStep("aucun message d'erreur n'est affiché à l'utilisateur", 'Outcome', page.actions),
    ).toMatchObject({
      kind: 'verify',
      texts: [],
      noError: true,
    });
    expect(planAutoStep('le code est mis à jour avec succès', 'Outcome', page.actions)).toMatchObject({
      kind: 'verify',
      noError: true,
      lastWriteOk: true,
    });
    expect(planAutoStep('le message "Erreur" n\'est pas affiché', 'Outcome', page.actions)).toMatchObject({
      kind: 'verify',
      hidden: ['Erreur'],
    });
  });

  it('nothing sure → manual with the reason, never a guessed action', () => {
    expect(planAutoStep('une demande est créée avec succès', 'Context', page.actions)).toMatchObject({
      kind: 'manual',
      reason: expect.stringMatching(/precondition not automated/) as unknown,
    });
    expect(planAutoStep("aucune autre donnée n'est modifiée", 'Outcome', page.actions)).toMatchObject({
      kind: 'manual',
    });
    expect(planAutoStep("quitte l'écran afin d'enregistrer", 'Action', page.actions)).toMatchObject({
      kind: 'manual',
    });
  });

  it('value of a field: quoted, after the last « à / avec / to », or the last word with digits', () => {
    expect(valueFor('modifie le code de 112310 à 455219', 'Code')).toBe('455219');
    expect(valueFor('I set the city to "Paris"', 'City')).toBe('Paris');
    expect(valueFor('saisit le code 42', 'Code')).toBe('42');
  });

  it('finding an element: exact name first, the suggested role breaks ties, ambiguity gives nothing', () => {
    expect(findByName(page.actions, { text: 'profil', role: 'tab' })?.role).toBe('tab');
    expect(findByName(page.actions, { text: 'Informations' })?.text).toBe('Informations générales');
    const twins = screen({ elements: [button('Voir détail'), button('Voir historique')] });
    expect(findByName(twins.actions, { text: 'Voir' })).toBeUndefined();
  });
});

describe('gherkin.auto in the mission', () => {
  it('on: unknown sentences become automatic steps (with their Gherkin type and the tags); off: an error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-auto-config-'));
    await writeFile(
      path.join(dir, 'a.feature'),
      `Feature: F
  @mutation
  Scenario: S
    Given I am on "/"
    When l'utilisateur accède à l'onglet "Profil"
    Then le code 42 est affiché
`,
    );
    const mission = (extra: string): string => `
mission: { name: auto }
target: { baseUrl: http://localhost:4200 }
flows:
  - gherkin: ./a.feature
${extra}`;
    const source = path.join(dir, 'mission.yaml');
    const { config } = parseConfig(mission('gherkin: { auto: true }'), {}, {}, source);
    expect(
      config.flows[0]?.steps.map((step) => [step.kind, step.kind === 'auto' ? step.type : '', step.allow]),
    ).toEqual([
      ['goto', '', ['MUTATION']],
      ['auto', 'Action', ['MUTATION']],
      ['auto', 'Outcome', ['MUTATION']],
    ]);
    expect(() => parseConfig(mission(''), {}, {}, source)).toThrow(/or set gherkin.auto: true/);
    // Par fichier : auto sur l'entrée du flow.
    expect(
      parseConfig(
        mission('').replace('- gherkin: ./a.feature', '- gherkin: ./a.feature\n    auto: true'),
        {},
        {},
        source,
      ).config.flows[0]?.steps[1]?.kind,
    ).toBe('auto');
  });
});
