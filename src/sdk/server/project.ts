import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../../config/config-loader.js';
import { scenarioSchema, type ScenarioConfig } from '../../config/config.js';
import {
  loadProjectMission,
  projectConfigSchema,
  type ProjectConfigFile,
} from '../../project/project-config.js';
import type {
  DraftIssue,
  DraftStep,
  Framework,
  Project,
  ProjectDraft,
  ProjectState,
  ValidationReport,
} from '../core/contracts.js';
import { ENV_NAME_PATTERN, FRAMEWORKS } from '../core/contracts.js';

/**
 * LE BROUILLON → LE PROJET DU MOTEUR. Le brouillon de l'assistant devient un vrai projet QA-CRAWLER
 * (qa-crawler.config.yaml, le format de `qa-crawler init`), validé par les schémas du moteur
 * lui-même : aucune règle de validation n'est réécrite ici.
 *
 * Aucun champ du brouillon ne peut porter un secret : le schéma est strict, l'authentification ne
 * reçoit que des noms de variables d'environnement, et le chargeur de missions refuse en plus tout
 * identifiant écrit en clair.
 */

export const PROJECT_FILE = 'qa-crawler.config.yaml';
export const PROJECT_META_FILE = 'sdk-project.json';
export const REPORTS_DIR = 'qa-reports';

const text = z.string().trim().min(1).max(500);
const envName = z.string().regex(ENV_NAME_PATTERN, 'must be an environment variable name (A-Z, 0-9, _)');
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), 'must start with http:// or https://')
  .refine((value) => URL.canParse(value), 'is not a valid URL');

const authDraftSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z
    .object({
      type: z.literal('form'),
      loginUrl: text,
      usernameSelector: text,
      passwordSelector: text,
      submitSelector: text,
      usernameEnv: envName,
      passwordEnv: envName,
      successUrlContains: text.optional(),
      successSelector: text.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('http'),
      usernameEnv: envName,
      passwordEnv: envName,
      origin: httpUrl.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sso'),
      identityProviderOrigin: httpUrl,
      usernameSelector: text,
      passwordSelector: text,
      submitSelector: text,
      nextSelector: text.optional(),
      usernameEnv: envName,
      passwordEnv: envName,
      successUrlContains: text.optional(),
    })
    .strict(),
]);

export const projectDraftSchema = z
  .object({
    project: z
      .object({
        name: z.string().trim().min(1, 'is required').max(120),
        description: z.string().trim().max(2000).optional(),
        targetUrl: httpUrl,
        framework: z.enum(FRAMEWORKS),
        sourceRoot: z.string().trim().min(1).max(1000).optional(),
      })
      .strict(),
    environment: z
      .object({
        viewport: z
          .object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) })
          .strict(),
        locale: z
          .string()
          .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'must look like fr-FR')
          .optional(),
        actionTimeoutMs: z.number().int().min(1000).max(120_000),
        navigationTimeoutMs: z.number().int().min(1000).max(180_000),
        auth: authDraftSchema,
      })
      .strict(),
    exploration: z
      .object({
        maxStates: z.number().int().min(1).max(5000),
        maxActions: z.number().int().min(1).max(50_000),
        maxDurationMinutes: z
          .number()
          .min(1)
          .max(24 * 60),
        maxDepth: z.number().int().min(0).max(100),
        allowedHosts: z.array(z.string().trim().min(1).max(253)).max(50),
        ignoredPaths: z.array(z.string().trim().min(1).max(500)).max(200),
        checks: z
          .object({ pageErrors: z.boolean(), network: z.boolean(), screenshots: z.boolean() })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** Les chemins de déconnexion du moteur : toujours exclus, quoi que le brouillon contienne. */
export const ALWAYS_IGNORED_PATHS: readonly string[] = scenarioSchema.parse({
  target: { baseUrl: 'http://localhost/' },
}).safety.ignoredPaths;

/** Les valeurs par défaut du moteur, pour pré-remplir l'assistant. */
export function engineDefaults(): ProjectDraft {
  const defaults: ScenarioConfig = scenarioSchema.parse({ target: { baseUrl: 'http://localhost/' } });
  return {
    project: { name: '', targetUrl: '', framework: 'other' },
    environment: {
      viewport: { ...defaults.browser.viewport },
      actionTimeoutMs: defaults.exploration.actionTimeoutMs,
      navigationTimeoutMs: defaults.exploration.navigationTimeoutMs,
      auth: { type: 'none' },
    },
    exploration: {
      maxStates: defaults.exploration.maxStates,
      maxActions: defaults.exploration.maxActions,
      maxDurationMinutes: defaults.exploration.maxDurationMinutes,
      maxDepth: defaults.exploration.maxDepth,
      allowedHosts: [],
      ignoredPaths: [...defaults.safety.ignoredPaths],
      checks: {
        pageErrors: defaults.checks.pageErrors,
        network: defaults.checks.httpErrors,
        screenshots: defaults.checks.screenshots,
      },
    },
  };
}

export interface ProjectRules {
  /** Dossiers sous lesquels un code source peut être lu (analyse statique). Vide : refusé. */
  allowedSourceRoots: string[];
  /** Langue des rapports du moteur. */
  reportLanguage: 'fr' | 'en';
}

/** Le document qa-crawler.config.yaml (format projet) qui correspond au brouillon. */
export function projectDocument(draft: ProjectDraft, rules: ProjectRules): Record<string, unknown> {
  const target = new URL(draft.project.targetUrl);
  const startAt = `${target.pathname}${target.search}` || '/';
  const auth = draft.environment.auth;
  const ignored = [...new Set([...ALWAYS_IGNORED_PATHS, ...draft.exploration.ignoredPaths])];
  const checks = draft.exploration.checks;
  const source = draft.project.framework === 'angular' ? draft.project.sourceRoot : undefined;
  return {
    qaCrawler: {
      application: {
        baseUrl: target.origin,
        startAt,
        name: draft.project.name,
        framework: draft.project.framework,
        // Salesforce Lightning : le profil du moteur (lectures Aura/GraphQL admises par la garde d'écriture).
        ...(draft.project.framework === 'salesforce' ? { platform: 'salesforce-lightning' } : {}),
      },
      browser: {
        browser: 'chromium',
        headless: true,
        viewport: { ...draft.environment.viewport },
        ...(draft.environment.locale ? { locale: draft.environment.locale } : {}),
      },
      staticAnalysis: source ? { enabled: true, source } : { enabled: false },
      actors: [{ name: 'primary', primary: true, auth: { ...auth } }],
      intelligence: { enabled: false, mode: 'OFF' },
      reporting: { format: ['html', 'json'], language: rules.reportLanguage, dir: REPORTS_DIR },
      mission: {
        ...(draft.project.description ? { mission: { description: draft.project.description } } : {}),
        exploration: {
          maxStates: draft.exploration.maxStates,
          maxActions: draft.exploration.maxActions,
          maxDurationMinutes: draft.exploration.maxDurationMinutes,
          maxDepth: draft.exploration.maxDepth,
          actionTimeoutMs: draft.environment.actionTimeoutMs,
          navigationTimeoutMs: draft.environment.navigationTimeoutMs,
        },
        safety: { allowedHosts: draft.exploration.allowedHosts, ignoredPaths: ignored },
        checks: {
          consoleErrors: checks.pageErrors,
          pageErrors: checks.pageErrors,
          httpErrors: checks.network,
          requestFailures: checks.network,
          brokenLinks: checks.network,
          screenshots: checks.screenshots,
        },
      },
    },
  };
}

export function renderProjectFile(draft: ProjectDraft, rules: ProjectRules): string {
  const header = [
    '# QA-Crawler project created by the SDK wizard (@qa-crawler/core/sdk).',
    '# Credentials are never written here: the actor reads them from the environment variables it names.',
    '',
  ].join('\n');
  return `${header}${stringify(projectDocument(draft, rules), { lineWidth: 0 })}`;
}

/** Les variables d'environnement que le brouillon cite (authentification). */
export function referencedEnv(draft: ProjectDraft): string[] {
  const auth = draft.environment.auth;
  return auth.type === 'none' ? [] : [auth.usernameEnv, auth.passwordEnv];
}

const STEP_OF: Record<string, DraftStep> = {
  project: 'project',
  environment: 'environment',
  exploration: 'exploration',
};

/**
 * Valide un brouillon : forme (schéma du SDK), puis projet et mission (schémas du moteur), puis
 * les variables d'environnement côté serveur. Les avertissements ne bloquent pas.
 */
export async function validateDraft(
  raw: unknown,
  rules: ProjectRules,
  env: NodeJS.ProcessEnv,
  projectDir: string,
): Promise<{ report: ValidationReport; draft?: ProjectDraft; config?: ScenarioConfig }> {
  const shape = projectDraftSchema.safeParse(raw);
  if (!shape.success) {
    const blocking = shape.error.issues.map((issue): DraftIssue => ({
      step: STEP_OF[String(issue.path[0])] ?? 'project',
      field: issue.path.slice(1).join('.'),
      message: `${issue.path.slice(1).join('.') || String(issue.path[0])} ${issue.message}`,
    }));
    return { report: { ok: false, blocking, warnings: [], environment: {} } };
  }
  const draft = shape.data;
  const blocking: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];

  if (draft.project.sourceRoot !== undefined) {
    if (draft.project.framework !== 'angular') {
      blocking.push({
        step: 'project',
        field: 'sourceRoot',
        message: 'a source folder is only read for Angular applications',
      });
    } else if (!sourceRootAllowed(draft.project.sourceRoot, rules.allowedSourceRoots)) {
      blocking.push({
        step: 'project',
        field: 'sourceRoot',
        message: 'this source folder is not under a folder the QA-CRAWLER server allows (allowedSourceRoots)',
      });
    }
  }

  const environment: Record<string, boolean> = {};
  for (const name of referencedEnv(draft)) {
    environment[name] = typeof env[name] === 'string' && env[name] !== '';
    if (!environment[name])
      blocking.push({
        step: 'environment',
        field: 'auth',
        message: `the environment variable ${name} is not defined on the QA-CRAWLER server`,
      });
  }

  const projectFile = renderProjectFile(draft, rules);
  let config: ScenarioConfig | undefined;
  const parsedProject = projectConfigSchema.safeParse(projectDocument(draft, rules).qaCrawler);
  if (!parsedProject.success) {
    for (const issue of parsedProject.error.issues)
      blocking.push({
        step: 'project',
        field: issue.path.join('.'),
        message: `${issue.path.join('.')} ${issue.message}`,
      });
  } else {
    const project: ProjectConfigFile = {
      file: path.join(projectDir, PROJECT_FILE),
      root: projectDir,
      config: parsedProject.data,
    };
    try {
      // Les variables d'environnement manquantes sont déjà signalées : le chargeur reçoit des
      // valeurs fictives pour ces seuls noms, afin de valider tout le reste de la mission.
      const filled = Object.fromEntries(
        referencedEnv(draft).map((name) => [name, env[name] || 'placeholder']),
      );
      config = (await loadProjectMission(project, { command: 'explore' }, {}, { ...env, ...filled })).config;
    } catch (error) {
      if (error instanceof ConfigError) {
        for (const detail of error.details.length > 0 ? error.details : [error.message])
          blocking.push({ step: stepOfDetail(detail), message: detail });
      } else throw error;
    }
  }

  if (draft.exploration.maxDurationMinutes > 120)
    warnings.push({
      step: 'exploration',
      field: 'maxDurationMinutes',
      message: 'the exploration may run for more than two hours; the server stays busy meanwhile',
    });
  if (draft.environment.auth.type === 'http' && !draft.environment.auth.origin)
    warnings.push({
      step: 'environment',
      field: 'auth.origin',
      message: 'without an origin, the browser sends the credentials to any host that asks for them',
    });

  const ok = blocking.length === 0;
  return {
    report: { ok, blocking, warnings, environment, ...(ok ? { projectFile } : {}) },
    draft,
    ...(config ? { config } : {}),
  };
}

function stepOfDetail(detail: string): DraftStep {
  if (/^(auth|browser)/.test(detail)) return 'environment';
  if (/^(exploration|safety|checks)/.test(detail)) return 'exploration';
  return 'project';
}

export function sourceRootAllowed(candidate: string, allowed: string[]): boolean {
  const resolved = path.resolve(candidate);
  return allowed.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}

export interface StoredProject extends Project {
  dir: string;
  /** Absent : ACTIVE (fiches écrites avant le cycle de vie). */
  state?: ProjectState;
  updatedAt?: string;
  archivedAt?: string;
}

type StoredMeta = Project & {
  draft: ProjectDraft;
  state?: ProjectState;
  updatedAt?: string;
  archivedAt?: string;
};

async function writeMeta(dir: string, meta: StoredMeta): Promise<void> {
  await writeFile(path.join(dir, PROJECT_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/**
 * La configuration d'un projet remplacée : un brouillon déjà validé par le moteur réécrit
 * qa-crawler.config.yaml ; l'identifiant, la date de création et l'état restent.
 */
export async function updateProject(
  dir: string,
  draft: ProjectDraft,
  rules: ProjectRules,
): Promise<StoredProject & { draft: ProjectDraft }> {
  const stored = await readProject(dir);
  if (!stored) throw new Error('project not found');
  const { dir: _dir, ...previous } = stored;
  const meta: StoredMeta = {
    ...previous,
    name: draft.project.name,
    framework: draft.project.framework,
    targetUrl: draft.project.targetUrl,
    draft,
    updatedAt: new Date().toISOString(),
  };
  if (draft.project.description) meta.description = draft.project.description;
  else delete meta.description;
  await writeFile(path.join(dir, PROJECT_FILE), renderProjectFile(draft, rules), 'utf8');
  await writeMeta(dir, meta);
  return { ...meta, dir };
}

/** ACTIVE ↔ ARCHIVED : seule la fiche change ; aucun fichier du projet n'est supprimé. */
export async function setProjectState(
  dir: string,
  state: ProjectState,
): Promise<StoredProject & { draft: ProjectDraft }> {
  const stored = await readProject(dir);
  if (!stored) throw new Error('project not found');
  const { dir: _dir, ...previous } = stored;
  const now = new Date().toISOString();
  const meta: StoredMeta = { ...previous, state, updatedAt: now };
  if (state === 'ARCHIVED') meta.archivedAt = now;
  else delete meta.archivedAt;
  await writeMeta(dir, meta);
  return { ...meta, dir };
}

/** Écrit le projet : qa-crawler.config.yaml, le dossier des flows et la fiche du SDK. */
export async function writeProject(
  dir: string,
  id: string,
  draft: ProjectDraft,
  rules: ProjectRules,
): Promise<StoredProject> {
  await mkdir(path.join(dir, 'qa-crawler', 'flows'), { recursive: true });
  await writeFile(path.join(dir, PROJECT_FILE), renderProjectFile(draft, rules), 'utf8');
  const project: Project = {
    id,
    name: draft.project.name,
    ...(draft.project.description ? { description: draft.project.description } : {}),
    framework: draft.project.framework,
    targetUrl: draft.project.targetUrl,
    createdAt: new Date().toISOString(),
    status: 'PROJECT_CREATED',
  };
  await writeFile(
    path.join(dir, PROJECT_META_FILE),
    `${JSON.stringify({ ...project, draft }, null, 2)}\n`,
    'utf8',
  );
  return { ...project, dir };
}

export async function readProject(
  dir: string,
): Promise<(StoredProject & { draft: ProjectDraft }) | undefined> {
  try {
    const stored = JSON.parse(await readFile(path.join(dir, PROJECT_META_FILE), 'utf8')) as StoredMeta;
    return { ...stored, dir };
  } catch {
    return undefined;
  }
}

export function frameworkOf(value: string): Framework {
  return (FRAMEWORKS as readonly string[]).includes(value) ? (value as Framework) : 'other';
}
