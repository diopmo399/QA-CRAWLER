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

  it('Maven: an error repeated by the failure summary is said once, with its symbol and location', () => {
    const file = '/tmp/.edit-x/java/src/test/java/qa/generated/OuvrirUneFicheTest.java';
    const diagnostics = mavenDiagnostics([
      '[ERROR] COMPILATION ERROR : ',
      `[ERROR] ${file}:[29,61] cannot find symbol`,
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:testCompile: Compilation failure',
      `[ERROR] ${file}:[29,61] cannot find symbol`,
      '[ERROR]   symbol:   method clique()',
      '[ERROR]   location: interface com.microsoft.playwright.Locator',
      '[ERROR] -> [Help 1]',
      '[ERROR] ',
      '[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.',
      '[ERROR] Re-run Maven using the -X switch to enable full debug logging.',
      '[ERROR] For more information about the errors and possible solutions, please read the following articles:',
      '[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException',
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        message:
          'cannot find symbol — symbol: method clique() — location: interface com.microsoft.playwright.Locator',
        file: 'java/src/test/java/qa/generated/OuvrirUneFicheTest.java',
        line: 29,
        column: 61,
      }),
    ]);
  });

  it('Maven: without a located error, the meaningful lines only (a missing dependency)', () => {
    const diagnostics = mavenDiagnostics([
      '[ERROR] Failed to execute goal on project generated: Could not resolve dependencies for project qa:generated:jar:1.0',
      '[ERROR] -> [Help 1]',
      '[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/DependencyResolutionException',
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ category: 'dependencies', source: 'mvn test-compile' });
    expect(diagnostics[0]?.line).toBeUndefined();
  });
});
