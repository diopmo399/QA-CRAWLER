import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Chaque fichier d'intégration lance un Chromium et une mission complète : trop de fichiers
 * en parallèle affament une machine modeste (portable, antivirus sous Windows) et font
 * expirer les préparations. Au plus la moitié des cœurs (4 au plus), réglable avec
 * QA_TEST_WORKERS.
 */
const workers =
  Number(process.env.QA_TEST_WORKERS) || Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));

export default defineConfig({
  test: {
    maxWorkers: workers,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          // Les préparations lancent des missions entières (navigateur, exploration) : plusieurs minutes sur une machine lente.
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
