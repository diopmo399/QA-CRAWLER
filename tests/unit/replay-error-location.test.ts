import { describe, expect, it } from 'vitest';
import { codeLocationOf } from '../../src/recording/record-orchestrator.js';

/** Un rejeu qui plante (erreur de programme) dit OÙ, pas seulement quoi. */
describe('codeLocationOf', () => {
  it('names the first frame in the project code, skipping dependencies (POSIX and Windows paths)', () => {
    const posix = [
      "TypeError: Cannot read properties of undefined (reading 'enabled')",
      '    at Object.helper (/app/node_modules/lib/index.js:10:3)',
      '    at FlowExplorer.run (/app/src/explorer/flow-explorer.ts:4271:7)',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    expect(codeLocationOf(posix)).toBe('src/explorer/flow-explorer.ts:4271');
    const windows = [
      "TypeError: Cannot read properties of undefined (reading 'enabled')",
      '    at runMission (C:\\Users\\alex\\qa crawler\\dist\\orchestrator.js:565:20)',
    ].join('\n');
    expect(codeLocationOf(windows)).toBe('dist/orchestrator.js:565');
    expect(codeLocationOf(undefined)).toBeUndefined();
  });
});
