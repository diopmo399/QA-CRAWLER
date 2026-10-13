import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Chaque fichier d'intégration lance un Chromium et des missions complètes qui n'occupent qu'une
 * fraction d'un cœur (attentes d'écran, réseau local) : un worker par cœur (8 au plus) garde la
 * machine occupée sans l'affamer. Une machine modeste (portable, antivirus sous Windows) :
 * QA_TEST_WORKERS=2.
 */
const workers = Number(process.env.QA_TEST_WORKERS) || Math.max(1, Math.min(8, cpus().length));

export default defineConfig({
  test: {
    maxWorkers: workers,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          // Le runner Windows est lent (clones git, SQLite) : le délai par défaut de 5 s y fait échouer
          // des tests qui passent partout ailleurs ; Linux et macOS gardent le délai par défaut.
          testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
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
      {
        test: {
          name: 'packaging',
          include: ['tests/packaging/**/*.test.ts'],
          environment: 'node',
          // Build + npm pack + installation du tarball dans chaque fixture : des minutes, en série.
          testTimeout: 300_000,
          hookTimeout: 600_000,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
