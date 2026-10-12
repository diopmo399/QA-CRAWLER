import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  missionOverridesOf,
  parsePlaywrightConfigText,
  readPlaywrightConfig,
} from '../../../src/project/playwright-config.js';

describe("the project's Playwright configuration", () => {
  it('is read textually (TypeScript) : baseURL, headless, viewport, storageState', () => {
    const settings = parsePlaywrightConfigText(
      'playwright.config.ts',
      `import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: { baseURL: 'http://localhost:4300', headless: false, viewport: { width: 1440, height: 900 }, storageState: 'auth/user.json' },
});`,
    );
    expect(settings).toMatchObject({
      source: 'text',
      baseURL: 'http://localhost:4300',
      headless: false,
      viewport: { width: 1440, height: 900 },
      storageState: 'auth/user.json',
    });
    expect(missionOverridesOf(settings)).toEqual({
      baseUrl: 'http://localhost:4300',
      headless: false,
      viewport: { width: 1440, height: 900 },
    });
    expect(parsePlaywrightConfigText('x.ts', 'export default {};')).toEqual({ file: 'x.ts', source: 'text' });
    expect(missionOverridesOf({ file: 'x.ts', source: 'text' })).toEqual({});
  });

  it('is imported when it is JavaScript (the exported `use` block wins)', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qa-pw-'));
    const file = path.join(directory, 'playwright.config.mjs');
    await writeFile(
      file,
      "export default { use: { baseURL: 'http://localhost:5555', viewport: { width: 1024, height: 768 } } };\n",
      'utf8',
    );
    const settings = await readPlaywrightConfig(file);
    expect(settings).toMatchObject({
      source: 'import',
      baseURL: 'http://localhost:5555',
      viewport: { width: 1024, height: 768 },
    });
    expect(settings.headless).toBeUndefined();
  });

  it('a missing file is an error that names it', async () => {
    await expect(readPlaywrightConfig('/nowhere/playwright.config.ts')).rejects.toThrow(
      /playwright\.config\.ts/,
    );
  });
});
