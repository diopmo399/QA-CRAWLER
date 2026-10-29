import { describe, expect, it } from 'vitest';
import {
  featureDiagnostics,
  mavenDiagnostics,
  typescriptDiagnostics,
  yamlDiagnostics,
} from '../../src/platform/generated-diagnostics.js';

/**
 * LES DIAGNOSTICS POSITIONNÉS des fichiers générés : chaque outil réel (analyseur YAML, schéma du flow,
 * dictionnaire Gherkin du moteur, TypeScript, sortie de Maven) relu pour dire la ligne, la colonne et
 * l'étape ; rien sans position inventée.
 */
describe('generated file diagnostics', () => {
  it('YAML: a syntax error with its line; a schema error on the line of the step, with the step', () => {
    const syntax = yamlDiagnostics('name: x\nsteps:\n  - click: { role: link\n');
    expect(syntax[0]).toMatchObject({ severity: 'error', category: 'syntax', source: 'yaml' });
    expect(syntax[0]?.line).toBeGreaterThanOrEqual(3);
    const schema = yamlDiagnostics(
      'name: x\nsteps:\n  - goto: /\n  - click:\n      role: link\n      label: Deux\n',
    );
    expect(schema).toEqual([
      expect.objectContaining({ category: 'schema', source: 'flow schema', step: 2, line: 5 }),
    ]);
    expect(schema[0]?.message).toContain('exactly one of');
    expect(yamlDiagnostics('name: x\nsteps:\n  - goto: /\n')).toEqual([]);
  });

  it('Gherkin: a sentence without step definition, on its line', () => {
    const diagnostics = featureDiagnostics(
      '# language: fr\nFonctionnalité: x\n  Scénario: y\n    Quand je clique sur le lien "A"\n    Alors la lune est bleue\n',
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ category: 'references', line: 5, column: 5, source: 'gherkin dictionary' }),
    ]);
  });

  it('TypeScript: a syntax error with its line and column', async () => {
    const diagnostics = await typescriptDiagnostics(
      "import { test } from '@playwright/test';\n\ntest('x', async () => {\n  const = 1;\n});\n",
    );
    expect(diagnostics[0]).toMatchObject({ category: 'syntax', line: 4 });
  });

  it('Maven: the file, line and column of a compilation error; the noise is dropped', () => {
    const diagnostics = mavenDiagnostics([
      '[ERROR] /tmp/run/java/src/test/java/qa/generated/OuvrirUneFicheTest.java:[27,10] cannot find symbol',
      '[ERROR] -> [Help 1]',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin',
    ]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        category: 'compilation',
        message: 'cannot find symbol',
        source: 'mvn test-compile',
        file: 'java/src/test/java/qa/generated/OuvrirUneFicheTest.java',
        line: 27,
        column: 10,
      },
    ]);
  });
});
