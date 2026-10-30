import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { flowSchema } from '../../src/config/flow-schema.js';
import { codeOutline } from '../../src/sdk/editor/code-outline.js';
import { editFlow, parseFlow, type FlowEditResult } from '../../src/sdk/editor/flow-document.js';
import { editFeature, parseFeature, type GherkinEditResult } from '../../src/sdk/editor/gherkin-document.js';

/**
 * LES MODÈLES DE L'ÉDITEUR, sur de vrais fichiers générés (fixtures) : le plan de chaque format avec
 * ses lignes ; les éditions structurées qui ne changent que ce qu'elles visent (commentaires de
 * provenance, effets, empreintes, langue gardés) ; les positions des groupes et des assertions qui
 * suivent les étapes ; un résultat toujours valide pour le schéma du moteur.
 */
const fixture = (name: string): string =>
  readFileSync(path.join('tests', 'fixtures', 'generated-tests', name), 'utf8');
const FLOW = fixture('ouvrir-une-fiche.flow.yaml');
const FEATURE = fixture('ouvrir-une-fiche.feature');
const SPEC = fixture('ouvrir-une-fiche.spec.ts.txt');
const JAVA = fixture('OuvrirUneFicheTest.java.txt');

const textOf = (result: FlowEditResult | GherkinEditResult): string => {
  if ('error' in result) throw new Error(result.error);
  return result.text;
};
const schemaOk = (text: string): boolean => {
  const { testData: _testData, ...document } = parseYaml(text) as Record<string, unknown>;
  return flowSchema.safeParse(document).success;
};

describe('flow YAML model', () => {
  it('outlines the steps with their lines, provenance, groups and assertions', () => {
    const parsed = parseFlow(FLOW);
    if (!parsed.ok) throw new Error('fixture does not parse');
    const { steps, groups, assertions } = parsed.outline;
    expect(schemaOk(FLOW)).toBe(true);
    expect(steps.map((step) => step.action)).toEqual(['click', 'click', 'expect']);
    expect(steps[0]).toMatchObject({
      position: 1,
      label: 'Cliquer sur le lien « Utilisateurs »',
      target: { strategy: 'role', value: 'link', name: 'Utilisateurs' },
      intent: { name: 'NAVIGATE', status: 'CONFIRMED' },
      group: 'g-liste',
      line: 8,
    });
    expect(steps[0]?.provenance).toContain('HUMAN_RECORDED');
    expect(steps[1]).toMatchObject({
      hasEffects: true,
      hasFingerprint: true,
      assertions: ['fiche-ouverte'],
      group: 'g-fiche',
    });
    expect(steps[2]).toMatchObject({
      action: 'expect',
      expect: { url: '/users/' },
      label: 'Vérifier url « /users/ »',
    });
    expect(FLOW.split('\n')[(steps[2]?.line ?? 0) - 1]).toContain('- expect:');
    expect(groups.map((group) => [group.id, group.steps])).toEqual([
      ['g-liste', [1]],
      ['g-fiche', [2, 3]],
    ]);
    expect(assertions).toEqual([expect.objectContaining({ id: 'fiche-ouverte', after: 2 })]);
  });

  it('reports a YAML syntax error with its line, without an outline', () => {
    const parsed = parseFlow('name: x\nsteps:\n  - click: { role: link\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostics[0]).toMatchObject({ severity: 'error', category: 'syntax', source: 'yaml' });
    expect(parsed.diagnostics[0]?.line).toBeGreaterThan(0);
  });

  it('updates a step: only its own lines change, comments and other keys stay', () => {
    const text = textOf(
      editFlow(FLOW, {
        op: 'update',
        index: 0,
        patch: { target: { name: 'Membres' }, optional: true, name: 'Aller aux membres' },
      }),
    );
    const before = FLOW.split('\n');
    const after = text.split('\n');
    expect(after.filter((line) => line.includes('#'))).toEqual(before.filter((line) => line.includes('#')));
    expect(text).toContain('name: Membres');
    expect(text).toContain('optional: true');
    expect(text).toContain('name: Aller aux membres');
    // Les étapes suivantes sont identiques, ligne pour ligne.
    const tail = (lines: string[]): string[] => lines.slice(lines.findIndex((line) => line.includes('h002')));
    expect(tail(after)).toEqual(tail(before));
    expect(schemaOk(text)).toBe(true);
  });

  it('changes how an element is found, and refuses a field the step does not have', () => {
    const text = textOf(
      editFlow(FLOW, {
        op: 'update',
        index: 0,
        patch: { target: { strategy: 'text', value: 'Utilisateurs' } },
      }),
    );
    const parsed = parseFlow(text);
    if (!parsed.ok) throw new Error('no outline');
    expect(parsed.outline.steps[0]?.target).toMatchObject({ strategy: 'text', value: 'Utilisateurs' });
    expect(parsed.outline.steps[0]?.target?.name).toBeUndefined();
    expect(schemaOk(text)).toBe(true);
    expect(editFlow(FLOW, { op: 'update', index: 0, patch: { option: 'x' } })).toEqual({
      error: 'only a select step has an option',
    });
  });

  it('moves a step: its provenance comment follows it, groups and assertions are renumbered', () => {
    const text = textOf(editFlow(FLOW, { op: 'move', from: 0, to: 1 }));
    const parsed = parseFlow(text);
    if (!parsed.ok) throw new Error('no outline');
    const [first, second] = parsed.outline.steps;
    expect(first?.target?.name).toBe('Utilisateur 1');
    expect(first?.provenance).toContain('h002');
    expect(second?.target?.name).toBe('Utilisateurs');
    expect(second?.provenance).toContain('h001');
    expect(parsed.outline.groups.map((group) => [group.id, group.steps])).toEqual([
      ['g-liste', [2]],
      ['g-fiche', [1, 3]],
    ]);
    expect(parsed.outline.assertions[0]?.after).toBe(1);
    expect(schemaOk(text)).toBe(true);
    // Le retour à l'ordre d'origine redonne le fichier d'origine.
    expect(textOf(editFlow(text, { op: 'move', from: 1, to: 0 }))).toBe(FLOW);
  });

  it('adds, duplicates and removes steps with groups kept consistent', () => {
    const added = textOf(
      editFlow(FLOW, { op: 'add', after: 0, step: { action: 'expect', text: 'Utilisateurs' } }),
    );
    let parsed = parseFlow(added);
    if (!parsed.ok) throw new Error('no outline');
    expect(parsed.outline.steps.map((step) => step.action)).toEqual(['click', 'expect', 'click', 'expect']);
    expect(parsed.outline.groups.map((group) => group.steps)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(parsed.outline.assertions[0]?.after).toBe(3);
    expect(schemaOk(added)).toBe(true);

    const duplicated = textOf(editFlow(FLOW, { op: 'duplicate', index: 1 }));
    parsed = parseFlow(duplicated);
    if (!parsed.ok) throw new Error('no outline');
    expect(parsed.outline.steps.map((step) => step.target?.name ?? step.action)).toEqual([
      'Utilisateurs',
      'Utilisateur 1',
      'Utilisateur 1',
      'expect',
    ]);
    // La copie n'a pas de commentaire de provenance : elle n'a pas été enregistrée.
    expect(parsed.outline.steps[2]?.provenance).toBeUndefined();
    expect(parsed.outline.groups.map((group) => group.steps)).toEqual([[1], [2, 3, 4]]);

    const removed = editFlow(FLOW, { op: 'remove', index: 0 });
    if ('error' in removed) throw new Error(removed.error);
    expect(removed.notes).toEqual(['group “Aller à la liste” has no step left: it was removed']);
    parsed = parseFlow(removed.text);
    if (!parsed.ok) throw new Error('no outline');
    expect(parsed.outline.groups.map((group) => [group.id, group.steps])).toEqual([['g-fiche', [1, 2]]]);
    expect(parsed.outline.assertions[0]?.after).toBe(1);
    expect(schemaOk(removed.text)).toBe(true);
  });

  it('moves a step to another group, and refuses to empty a group that way', () => {
    const text = textOf(editFlow(FLOW, { op: 'group', index: 2, group: 'g-liste' }));
    const parsed = parseFlow(text);
    if (!parsed.ok) throw new Error('no outline');
    expect(parsed.outline.groups.map((group) => group.steps)).toEqual([[1, 3], [2]]);
    expect(editFlow(FLOW, { op: 'group', index: 0, group: 'g-fiche' })).toEqual({
      error: 'the group “Aller à la liste” would have no step left',
    });
    expect(editFlow(FLOW, { op: 'group', index: 0, group: 'nope' })).toEqual({ error: 'no group nope' });
  });

  it('writes inline lists the way the file writes them', () => {
    const tight =
      'name: x\nsteps:\n  - goto: /\n  - click: {text: Ok}\ngroups:\n  - id: g\n    name: G\n    steps: [1, 2]\n';
    const moved = textOf(editFlow(tight, { op: 'move', from: 0, to: 1 }));
    expect(moved).toContain('  - click: {text: Ok}\n  - goto: /');
    expect(moved).toContain('steps: [1, 2]');
    const padded = tight.replace('{text: Ok}', '{ text: Ok }').replace('[1, 2]', '[ 1, 2 ]');
    expect(textOf(editFlow(padded, { op: 'update', index: 0, patch: { url: '/home' } }))).toBe(
      padded.replace('goto: /', 'goto: /home'),
    );
  });

  it('refuses an edit of a file that does not parse, and keeps at least one step', () => {
    expect(editFlow('steps: [', { op: 'remove', index: 0 })).toEqual({
      error: 'the YAML does not parse: fix it in the source view first',
    });
    expect(editFlow('name: x\nsteps:\n  - goto: /\n', { op: 'remove', index: 0 })).toEqual({
      error: 'a flow keeps at least one step',
    });
  });
});

describe('Gherkin model', () => {
  it('outlines the scenario and its steps, in the language of the file', () => {
    const parsed = parseFeature(FEATURE);
    if (!parsed.ok) throw new Error('fixture does not parse');
    expect(parsed.outline.language).toBe('fr');
    expect(parsed.outline.feature?.name).toBe('Ouvrir une fiche');
    const [scenario] = parsed.outline.scenarios;
    expect(scenario?.steps.map((step) => `${step.keyword}${step.text}`)).toEqual([
      'Quand je clique sur le lien "Utilisateurs"',
      'Et je clique sur le lien "Utilisateur 1"',
      'Alors l\'URL contient "/users/"',
    ]);
    expect(scenario?.steps[0]?.provenance).toContain('h001');
    expect(parsed.outline.keywords.then).toContain('Alors ');
  });

  it('reports a syntax error with its line', () => {
    const parsed = parseFeature(
      '# language: fr\nFonctionnalité: x\n  Scénario: y\n    Quand a\n  Ceci est faux\n',
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostics[0]).toMatchObject({ category: 'syntax', line: 5 });
  });

  it('edits one line, moves and removes whole blocks, and never touches the rest', () => {
    const updated = textOf(
      editFeature(FEATURE, {
        op: 'update',
        scenario: 0,
        index: 1,
        text: 'je clique sur le lien "Utilisateur 2"',
      }),
    );
    expect(updated.split('\n').filter((line, index) => line !== FEATURE.split('\n')[index])).toEqual([
      '    Et je clique sur le lien "Utilisateur 2"',
    ]);
    expect(editFeature(FEATURE, { op: 'update', scenario: 0, index: 0, keyword: 'Then ' })).toEqual({
      error: '“Then” is not a step keyword of this language',
    });
    const moved = textOf(editFeature(FEATURE, { op: 'move', scenario: 0, from: 2, to: 0 }));
    const parsed = parseFeature(moved);
    if (!parsed.ok) throw new Error('no outline');
    expect(parsed.outline.scenarios[0]?.steps[0]?.text).toBe('l\'URL contient "/users/"');
    // Son commentaire de provenance l'a suivie.
    expect(parsed.outline.scenarios[0]?.steps[0]?.provenance).toContain('INFERRED_OUTCOME');
    expect(textOf(editFeature(moved, { op: 'move', scenario: 0, from: 0, to: 2 }))).toBe(FEATURE);
    const removed = textOf(editFeature(FEATURE, { op: 'remove', scenario: 0, index: 2 }));
    expect(removed).not.toContain('INFERRED_OUTCOME');
    expect(removed).not.toContain('/users/');
    const added = textOf(
      editFeature(FEATURE, {
        op: 'add',
        scenario: 0,
        after: 2,
        keyword: 'Et ',
        text: 'je vois le texte "Utilisateur 1"',
      }),
    );
    expect(added.split('\n')).toContain('    Et je vois le texte "Utilisateur 1"');
    const duplicated = parseFeature(textOf(editFeature(FEATURE, { op: 'duplicate', scenario: 0, index: 0 })));
    expect(duplicated.ok && duplicated.outline.scenarios[0]?.steps.length).toBe(4);
  });
});

describe('code outline', () => {
  it('Playwright TypeScript: the suite, the test and the generated steps with their lines', () => {
    const outline = codeOutline(SPEC, 'typescript');
    expect(outline.map((entry) => [entry.kind, entry.label])).toEqual([
      ['suite', 'Ouvrir une fiche'],
      ['test', 'Ouvrir une fiche'],
      ['step', 'Étape 1'],
      ['step', 'Étape 2'],
      ['step', 'Étape 3'],
    ]);
    const step2 = outline.find((entry) => entry.label === 'Étape 2');
    expect(SPEC.split('\n')[(step2?.line ?? 0) - 1]?.trim()).toBe('// step 2');
    expect(step2?.actions).toBe(4);
  });

  it('Java JUnit 5: the class, the @Test method by its display name, the steps', () => {
    const outline = codeOutline(JAVA, 'java');
    expect(outline.map((entry) => [entry.kind, entry.label])).toEqual([
      ['suite', 'Ouvrir une fiche'],
      ['test', 'Ouvrir une fiche'],
      ['step', 'Étape 1'],
      ['step', 'Étape 2'],
      ['step', 'Étape 3'],
    ]);
  });
});
