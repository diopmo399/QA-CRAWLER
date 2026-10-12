import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject } from '../../../src/project/detect.js';
import { initProject, renderProjectConfig } from '../../../src/project/init.js';
import { loadProjectConfig } from '../../../src/project/project-config.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-detect-'));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content, 'utf8');
  }
  return root;
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe('project detection', () => {
  it('an Angular project with Playwright, TypeScript, OpenAPI, Git, GitHub Actions, Docker and K8s', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({
        name: 'shop',
        version: '3.1.0',
        dependencies: { '@angular/core': '^18.0.0' },
        devDependencies: { '@playwright/test': '^1.48.0', typescript: '^5.5.0' },
      }),
      'tsconfig.json': '{}',
      'playwright.config.ts': "export default { use: { baseURL: 'http://localhost:4300' } };",
      'openapi.yaml': 'openapi: 3.0.0',
      '.git/HEAD': 'ref: refs/heads/main',
      '.github/workflows/ci.yml': 'on: push',
      Dockerfile: 'FROM node:22',
      'k8s/deployment.yaml': 'kind: Deployment',
      'dist/main.js.map': '{}',
      'pnpm-lock.yaml': '',
    });
    const detection = await detectProject(root);
    expect(detection).toMatchObject({
      name: 'shop',
      version: '3.1.0',
      framework: 'angular',
      devUrl: 'http://localhost:4200',
      typescript: true,
      playwright: { installed: true, version: '^1.48.0', config: 'playwright.config.ts' },
      openapi: 'openapi.yaml',
      sourceMaps: true,
      git: true,
      github: true,
      docker: true,
      kubernetes: true,
      packageManager: 'pnpm',
    });
    expect(detection.ci).toContain('github-actions');
    expect(detection.existingConfig).toBeUndefined();
  });

  it('React (Vite), Vue and a project without package.json', async () => {
    const react = await detectProject(
      await fixture({
        'package.json': JSON.stringify({
          dependencies: { react: '^18.3.0' },
          devDependencies: { vite: '^5.0.0' },
        }),
        'yarn.lock': '',
      }),
    );
    expect(react).toMatchObject({
      framework: 'react',
      devUrl: 'http://localhost:5173',
      packageManager: 'yarn',
    });
    const cra = await detectProject(
      await fixture({ 'package.json': JSON.stringify({ dependencies: { react: '^18.3.0' } }) }),
    );
    expect(cra.devUrl).toBe('http://localhost:3000');
    const vue = await detectProject(
      await fixture({
        'package.json': JSON.stringify({
          dependencies: { vue: '^3.4.0' },
          devDependencies: { vite: '^5.0.0' },
        }),
      }),
    );
    expect(vue).toMatchObject({ framework: 'vue', devUrl: 'http://localhost:5173', packageManager: 'npm' });
    const bare = await detectProject(await fixture({ 'index.html': '<!doctype html>' }));
    expect(bare).toMatchObject({
      framework: 'other',
      typescript: false,
      playwright: { installed: false },
      git: false,
    });
  });
});

describe('qa-crawler init', () => {
  it('creates the configuration, the folders, the example flow and the .gitignore entries; never overwrites silently', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0' } }),
      '.git/HEAD': 'ref: refs/heads/main',
      '.gitignore': 'node_modules/\n',
    });
    const first = await initProject({ root, baseUrl: 'http://localhost:3333' });
    expect(first.created).toEqual(
      expect.arrayContaining([
        'qa-crawler.config.yaml',
        path.join('qa-crawler', 'flows'),
        path.join('qa-crawler', 'actors'),
        path.join('qa-crawler', 'memory'),
        'qa-reports',
        path.join('qa-crawler', 'flows', 'example.flow.yaml'),
        '.gitignore (entries added)',
      ]),
    );
    expect(first.kept).toEqual([]);
    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('qa-reports/');
    expect(gitignore).toContain('qa-crawler/actors/*.json');
    expect(await exists(path.join(root, 'qa-crawler', 'knowledge', '.gitkeep'))).toBe(true);

    // The generated file is a valid project configuration with what was detected.
    const loaded = await loadProjectConfig(first.configFile);
    expect(loaded.config.application.baseUrl).toBe('http://localhost:3333');
    expect(loaded.config.application.framework).toBe('react');
    expect(loaded.config.actors[0]).toMatchObject({ name: 'primary', primary: true, auth: { type: 'none' } });

    // A second init keeps everything, and says so.
    await writeFile(
      first.configFile,
      `${await readFile(first.configFile, 'utf8')}# edited by the team\n`,
      'utf8',
    );
    const second = await initProject({ root });
    expect(second.created).toEqual([]);
    expect(second.kept).toEqual(expect.arrayContaining(['qa-crawler.config.yaml', '.gitignore']));
    expect(second.notes.join('\n')).toMatch(/already exists: kept/);
    expect(await readFile(first.configFile, 'utf8')).toContain('# edited by the team');

    // --force regenerates the configuration only.
    const forced = await initProject({ root, force: true, example: false });
    expect(forced.created).toEqual(['qa-crawler.config.yaml']);
    expect(await readFile(first.configFile, 'utf8')).not.toContain('# edited by the team');
  });

  it('renders the Playwright config, the OpenAPI contract and the dev URL of the framework', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({
        dependencies: { '@angular/core': '^18.0.0' },
        devDependencies: { playwright: '1.0.0' },
      }),
      'playwright.config.ts': 'export default {};',
      'swagger.json': '{}',
    });
    const text = renderProjectConfig(await detectProject(root));
    expect(text).toContain('baseUrl: http://localhost:4200');
    expect(text).toContain('config: ./playwright.config.ts');
    expect(text).toContain('openapi: ./swagger.json');
    expect(text).toContain('framework: angular');
    expect(text).not.toMatch(/password\s*:/i);
  });
});
