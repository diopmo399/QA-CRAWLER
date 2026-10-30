import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'dist-packages/',
      'packages/*/dist/',
      'packages/*/node_modules/',
      'packages/core/domain-packs/',
      'node_modules/',
      'reports/',
      'screenshots/',
      'coverage/',
      'tests/fixtures/static-apps/',
      'tests/fixtures/packaging/*-app/',
      // Les exemples importent les paquets compilés (dist) : ils se vérifient en les lançant.
      'examples/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs', 'packages/cli/bin/*.js'],
          // Les scripts hors projet TypeScript dépassent la limite par défaut (8).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['eslint.config.js', 'scripts/*.mjs', 'packages/cli/bin/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', URL: 'readonly' },
    },
  },
  prettier,
);
