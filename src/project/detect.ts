import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * PROJECT DETECTION (`qa-crawler init`) : ce que le projet consommateur contient déjà — cadre
 * d'interface (Angular, React, Vue), Playwright et sa configuration, TypeScript, contrat OpenAPI,
 * source maps, git, GitHub, CI, Docker, Kubernetes — pour proposer une configuration juste.
 * Lecture seule : rien n'est modifié ici.
 */
export type Framework = 'angular' | 'react' | 'vue' | 'other';

export interface ProjectDetection {
  root: string;
  name?: string;
  version?: string;
  framework: Framework;
  /** Le port de développement habituel du cadre (4200, 5173, 3000). */
  devUrl: string;
  typescript: boolean;
  playwright: { installed: boolean; version?: string; config?: string };
  openapi?: string;
  sourceMaps: boolean;
  git: boolean;
  github: boolean;
  ci: string[];
  docker: boolean;
  kubernetes: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  /** Une configuration qa-crawler existe déjà. */
  existingConfig?: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const OPENAPI_CANDIDATES = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
  'api/openapi.yaml',
  'api/openapi.json',
  'docs/openapi.yaml',
  'docs/openapi.json',
];

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function firstExisting(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await exists(path.join(root, candidate))) return candidate;
  return undefined;
}

async function hasSourceMaps(root: string): Promise<boolean> {
  for (const directory of ['dist', 'build', '.next', 'out'])
    if (await exists(path.join(root, directory)))
      try {
        const entries = await readdir(path.join(root, directory), { recursive: true });
        if (entries.some((entry) => entry.endsWith('.js.map'))) return true;
      } catch {
        // dossier illisible : pas de source map connue
      }
  return false;
}

/** Détecte le projet du dossier `root`. */
export async function detectProject(root: string): Promise<ProjectDetection> {
  let pkg: PackageJson = {};
  try {
    pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    // pas de package.json : application web générique
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework: Framework = deps['@angular/core']
    ? 'angular'
    : deps.react || deps.next
      ? 'react'
      : deps.vue || deps.nuxt
        ? 'vue'
        : 'other';
  const vite = Boolean(deps.vite);
  const devUrl =
    framework === 'angular'
      ? 'http://localhost:4200'
      : vite
        ? 'http://localhost:5173'
        : framework === 'react'
          ? 'http://localhost:3000'
          : 'http://localhost:8080';
  const playwrightVersion = deps['@playwright/test'] ?? deps.playwright;
  const playwrightConfig = await firstExisting(root, [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ]);
  const workflows = path.join(root, '.github', 'workflows');
  const ci: string[] = [];
  if (await exists(workflows)) ci.push('github-actions');
  if (await exists(path.join(root, '.gitlab-ci.yml'))) ci.push('gitlab-ci');
  if (await exists(path.join(root, 'azure-pipelines.yml'))) ci.push('azure-pipelines');
  if (await exists(path.join(root, 'Jenkinsfile'))) ci.push('jenkins');
  const kubernetes =
    (await exists(path.join(root, 'k8s'))) ||
    (await exists(path.join(root, 'kubernetes'))) ||
    (await exists(path.join(root, 'helm')));
  const existingConfig = await firstExisting(root, ['qa-crawler.config.yaml', 'qa-crawler.config.yml']);
  const openapi = await firstExisting(root, OPENAPI_CANDIDATES);
  return {
    root,
    ...(pkg.name ? { name: pkg.name } : {}),
    ...(pkg.version ? { version: pkg.version } : {}),
    framework,
    devUrl,
    typescript: Boolean(deps.typescript) || (await exists(path.join(root, 'tsconfig.json'))),
    playwright: {
      installed: playwrightVersion !== undefined,
      ...(playwrightVersion ? { version: playwrightVersion } : {}),
      ...(playwrightConfig ? { config: playwrightConfig } : {}),
    },
    ...(openapi ? { openapi } : {}),
    sourceMaps: await hasSourceMaps(root),
    git: await exists(path.join(root, '.git')),
    github: (await exists(path.join(root, '.github'))) || (await exists(workflows)),
    ci,
    docker:
      (await exists(path.join(root, 'Dockerfile'))) || (await exists(path.join(root, 'docker-compose.yml'))),
    kubernetes,
    packageManager: (await exists(path.join(root, 'pnpm-lock.yaml')))
      ? 'pnpm'
      : (await exists(path.join(root, 'yarn.lock')))
        ? 'yarn'
        : 'npm',
    ...(existingConfig ? { existingConfig } : {}),
  };
}
