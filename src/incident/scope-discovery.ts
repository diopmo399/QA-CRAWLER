import path from 'node:path';
import {
  SCOPE_DISCOVERY_DEPTH,
  SCOPE_DISCOVERY_MAX_MANIFESTS,
  SCOPE_DISCOVERY_MAX_NODES,
  SCOPE_DISCOVERY_TREE_DEPTH,
  type CodeLayer,
  type DiscoveredApplication,
  type DiscoveredModule,
  type DiscoveryProblem,
  type DiscoveryRelation,
  type ScopeApplication,
  type ScopeDiscovery,
} from '../sdk/core/incident-contracts.js';
import type { DirectoryListing, DirectoryNode, GuardedFiles } from './guarded-fs.js';
import { ScopeDeniedError } from './scope-policy.js';

/**
 * LA DÉCOUVERTE AUTOMATIQUE DU PÉRIMÈTRE : à partir d'un chemin de dépôt, les applications qu'il contient
 * (manifestes package.json, angular.json, pom.xml, build.gradle, pyproject.toml, go.mod, *.csproj), leurs
 * cadres et langages, leur couche probable (frontend, BFF, backend), leurs modules (dossiers), points
 * d'entrée, fichiers de configuration, services notables, les relations entre elles (dépendances d'espace
 * de travail, proxy de développement, ports de configuration) et la structure du dépôt (application
 * seule, monorepo, plusieurs applications). Tout est lu par `GuardedFiles`, donc par le Scope Policy
 * Engine : fichiers sensibles refusés, liens symboliques jamais suivis, nombre et taille des fichiers
 * bornés ; rien n'est écrit. La pertinence pour l'incident vient de ses mots : une application proposée
 * est un point de départ, jamais une limite définitive (le périmètre s'étend par extension approuvée).
 * Chaque détection cite sa preuve ; ce qui n'est pas déterminable devient une question.
 */
export interface RepositoryDiscoveryInput {
  root: string;
  files: GuardedFiles;
  /** Les mots de l'incident (titre, description, symptôme) : la pertinence de chaque application. */
  keywords: readonly string[];
  /** L'application nommée par l'incident (« Catalogue »). */
  application?: string;
  /** Les applications déjà dans le périmètre (même racine : signalée, jamais proposée deux fois). */
  existing: readonly ScopeApplication[];
  now?: string;
}

const MANIFEST_EXTENSIONS = [
  '.json',
  '.xml',
  '.gradle',
  '.kts',
  '.yaml',
  '.yml',
  '.toml',
  '.mod',
  '.csproj',
  '.txt',
  '.properties',
];
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.java', '.kt', '.py', '.go', '.cs'];
const APP_MANIFESTS = new Set([
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
]);
const WORKSPACE_MANIFESTS = new Set([
  'pnpm-workspace.yaml',
  'nx.json',
  'lerna.json',
  'turbo.json',
  'settings.gradle',
  'settings.gradle.kts',
  'angular.json',
  'proxy.conf.json',
]);
/** Les fichiers d'outillage d'un monorepo et l'outil qu'ils désignent. */
const WORKSPACE_TOOLS: Record<string, string> = {
  'pnpm-workspace.yaml': 'pnpm workspaces',
  'nx.json': 'Nx',
  'lerna.json': 'Lerna',
  'turbo.json': 'Turborepo',
};
const SPRING_CONFIG = /^application(-[\w.-]+)?\.(ya?ml|properties)$/i;
const OTHER_CONFIGS = new Set([
  'angular.json',
  'nx.json',
  'proxy.conf.json',
  'tsconfig.json',
  'docker-compose.yml',
  'docker-compose.yaml',
]);
/** Les dossiers qui ne contiennent pas une application à investiguer (jeux d'essai, exemples, documentation). */
const NOISE_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  'fixture',
  'fixtures',
  'e2e',
  'example',
  'examples',
  'docs',
  'doc',
  '.github',
  '.vscode',
  'scripts',
]);
/** Les dossiers qui ne sont pas des modules (ressources, outillage, sorties). */
const NOT_MODULES = new Set([
  ...NOISE_DIRECTORIES,
  'assets',
  'environments',
  'styles',
  'i18n',
  'public',
  'static',
  'spec',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'resources',
  'webapp',
  'migrations',
  'img',
  'images',
  'fonts',
  'locales',
]);
const MAX_MODULES = 40;
const MAX_ENTRY_POINTS = 6;
const ENTRY_FILES = new Set([
  'main.ts',
  'main.tsx',
  'main.js',
  'index.ts',
  'index.tsx',
  'index.js',
  'server.ts',
  'server.js',
  'app.ts',
  'app.js',
  'main.py',
  'app.py',
  'manage.py',
  'main.go',
  'Program.cs',
]);

const FRONTEND_FRAMEWORKS: Record<string, string> = {
  '@angular/core': 'Angular',
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@ionic/angular': 'Ionic',
};
const NODE_SERVER_FRAMEWORKS: Record<string, string> = {
  '@nestjs/core': 'NestJS',
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  '@hapi/hapi': 'hapi',
};
const NODE_SERVICES: Record<string, string> = {
  rxjs: 'RxJS',
  '@ngrx/store': 'NgRx',
  axios: 'HTTP (axios)',
  typeorm: 'Base de données (TypeORM)',
  prisma: 'Base de données (Prisma)',
  '@prisma/client': 'Base de données (Prisma)',
  mongoose: 'MongoDB (mongoose)',
  sequelize: 'Base de données (Sequelize)',
  kafkajs: 'Kafka',
  amqplib: 'AMQP',
  ioredis: 'Redis',
  redis: 'Redis',
  graphql: 'GraphQL',
  'socket.io': 'WebSocket (socket.io)',
  passport: 'Authentification (passport)',
  'keycloak-js': 'OIDC (Keycloak)',
  'angular-oauth2-oidc': 'OIDC',
};
/** Dépendances Java (sous-chaîne de l'artifactId, ou du texte Gradle) → cadre ou service. */
const JAVA_FRAMEWORKS: [RegExp, string][] = [
  [/spring-boot/, 'Spring Boot'],
  [/quarkus/, 'Quarkus'],
  [/micronaut/, 'Micronaut'],
];
const JAVA_SERVICES: [RegExp, string][] = [
  [/spring-cloud-starter-gateway/, 'Passerelle (Spring Cloud Gateway)'],
  [/spring-boot-starter-webflux/, 'HTTP réactif (WebFlux)'],
  [/spring-boot-starter-web(?!flux)|spring-webmvc/, 'HTTP (Spring MVC)'],
  [/spring-boot-starter-data-jpa|hibernate-core/, 'JPA'],
  [/spring-boot-starter-data-mongodb/, 'MongoDB'],
  [/spring-boot-starter-data-redis/, 'Redis'],
  [/spring-kafka|kafka-clients/, 'Kafka'],
  [/spring-boot-starter-amqp/, 'AMQP'],
  [/spring-cloud-starter-openfeign/, 'Clients REST (Feign)'],
  [/spring-boot-starter-security/, 'Sécurité (Spring Security)'],
  [/oauth2/, 'OAuth2'],
  [/liquibase/, 'Migrations (Liquibase)'],
  [/flyway/, 'Migrations (Flyway)'],
  [/graphql/, 'GraphQL'],
  [/jersey|jakarta\.ws\.rs|javax\.ws\.rs/, 'JAX-RS'],
  [/thymeleaf/, 'Templates (Thymeleaf)'],
];
const PYTHON_FRAMEWORKS: [RegExp, string][] = [
  [/\bfastapi\b/i, 'FastAPI'],
  [/\bdjango\b/i, 'Django'],
  [/\bflask\b/i, 'Flask'],
];
const GO_FRAMEWORKS: [RegExp, string][] = [
  [/gin-gonic\/gin/, 'Gin'],
  [/labstack\/echo/, 'Echo'],
  [/gofiber\/fiber/, 'Fiber'],
];
const BFF_NAME = /(^|[^a-z])(bff|gateway|edge|proxy)([^a-z]|$)/i;
const BACKEND_NAME = /(^|[^a-z])(api|server|backend|back|service|services|core)([^a-z]|$)/i;
const FRONTEND_NAME = /(^|[^a-z])(web|front|frontend|ui|app|client|portal|site)([^a-z]|$)/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>,;)]+/g;
const MAX_CONFIGS_READ = 3;

type Manifest = { relative: string; absolute: string; name: string; dir: string };

interface NodePackage {
  name?: string;
  private?: boolean;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Candidate {
  /** Relatif à la racine analysée (« » : la racine). */
  dir: string;
  name: string;
  /** Le nom du paquet ou l'artifactId (relations). */
  packageName?: string;
  frameworks: string[];
  languages: Set<string>;
  services: string[];
  configs: string[];
  evidence: string[];
  questions: string[];
  layer?: CodeLayer;
  /** Une bibliothèque partagée (sans cadre d'application) : proposée seulement si une application proposée en dépend. */
  library: boolean;
  /** Un dossier de code sans manifeste reconnu. */
  unrecognized: boolean;
  /** Les dépendances déclarées (noms de paquets ou artifactIds), pour les relations. */
  dependencies: string[];
  /** Le port HTTP de la configuration (server.port), pour relier un proxy ou une URL. */
  port?: number;
  /** Les cibles de proxy et URLs de configuration : « hôte:port » ou nom d'hôte. */
  targets: { ref: string; evidence: string }[];
}

const posix = (value: string): string => value.split(path.sep).join('/');
const depthOf = (relative: string): number => (relative === '' ? 0 : relative.split('/').length);
const isNoise = (relative: string): boolean =>
  relative.split('/').some((segment) => NOISE_DIRECTORIES.has(segment));
const under = (child: string, parent: string): boolean =>
  parent === '' ? true : child === parent || child.startsWith(`${parent}/`);
const uniq = <T>(items: Iterable<T>): T[] => [...new Set(items)];

/** Les mots d'un nom ou d'un chemin (minuscules, séparés par tout ce qui n'est pas une lettre ou un chiffre, casse chameau coupée). */
export function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

/** Un mot de l'incident retrouvé dans un nom : égal, ou préfixe de l'autre (« dossier » / « dossiers ») quand il est assez long. */
function matches(keyword: string, token: string): boolean {
  if (keyword === token) return true;
  if (keyword.length < 4 || token.length < 4) return false;
  return token.startsWith(keyword) || keyword.startsWith(token);
}

function matchedKeywords(keywords: readonly string[], tokens: readonly string[]): string[] {
  return keywords.filter((keyword) => tokens.some((token) => matches(keyword, token)));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function applicationIdOf(wanted: string, taken: Set<string>): string {
  const base =
    wanted
      .replace(/^@[^/]+\//, '')
      .toLowerCase()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 48) || 'app';
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

/** Les descendants d'un nœud de l'arborescence, par chemin relatif. */
function nodeAt(listing: DirectoryListing, relative: string): DirectoryNode | undefined {
  if (relative === '') return listing.root;
  let node: DirectoryNode = listing.root;
  for (const segment of relative.split('/')) {
    const child = node.children.find((entry) => entry.name === segment);
    if (!child) return undefined;
    node = child;
  }
  return node;
}

// ── Manifestes ───────────────────────────────────────────────────────────────────────────────

function parsePom(text: string): {
  artifactId?: string;
  packaging: string;
  modules: string[];
  dependencies: string[];
  parent?: string;
  mainClass?: string;
} {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(stripped)?.[1] ?? '';
  const own = stripped
    .replace(/<parent>[\s\S]*?<\/parent>/, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '');
  const dependencies = [...stripped.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)].map(
    (m) => m[1] ?? '',
  );
  return {
    ...(own.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1]
      ? { artifactId: /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(own)?.[1] }
      : {}),
    packaging: /<packaging>\s*([^<\s]+)\s*<\/packaging>/.exec(own)?.[1] ?? 'jar',
    modules: [...stripped.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map((m) => m[1] ?? ''),
    dependencies,
    ...(/<artifactId>\s*([^<\s]+)/.exec(parent)?.[1]
      ? { parent: /<artifactId>\s*([^<\s]+)/.exec(parent)?.[1] }
      : {}),
    ...(/<mainClass>\s*([^<\s]+)/.exec(stripped)?.[1]
      ? { mainClass: /<mainClass>\s*([^<\s]+)/.exec(stripped)?.[1] }
      : {}),
  };
}

/** Le port HTTP d'une configuration Spring (`server.port`), en YAML ou en propriétés. */
export function serverPortOf(name: string, text: string): number | undefined {
  const properties = /\.properties$/i.test(name)
    ? /^\s*server\.port\s*[=:]\s*(\d{2,5})\s*$/m.exec(text)
    : (/^server:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+port:\s*(\d{2,5})\s*$/m.exec(text) ??
      /^\s*server\.port\s*[=:]\s*(\d{2,5})\s*$/m.exec(text));
  const port = properties?.[1] ? Number(properties[1]) : undefined;
  return port !== undefined && port > 0 && port < 65536 ? port : undefined;
}

/** Les « hôte:port » des URLs d'un texte, sans identifiants, chemin ni paramètres. */
export function hostsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    try {
      const url = new URL(match[0].replace(/\$\{[^}]*\}/g, 'placeholder'));
      if (url.hostname && url.hostname !== 'placeholder')
        out.push(url.port ? `${url.hostname}:${url.port}` : url.hostname);
    } catch {
      // une URL illisible n'est pas une cible
    }
  }
  return uniq(out).slice(0, 20);
}

// ── Découverte ───────────────────────────────────────────────────────────────────────────────

function problemOf(error: unknown, root: string): DiscoveryProblem {
  const rule = error instanceof ScopeDeniedError ? error.decision.rule : '';
  const reason =
    error instanceof ScopeDeniedError
      ? error.decision.reason
      : error instanceof Error
        ? error.message
        : String(error);
  switch (rule) {
    case 'path.missing':
      return {
        code: 'ROOT_MISSING',
        message: `Chemin introuvable : « ${root} ».`,
        hint: 'Vérifiez le chemin : absolu, sur la machine qui investigue (pas votre poste), sans faute de frappe. Un dépôt connu de l’environnement peut être réutilisé d’un clic.',
      };
    case 'path.not-directory':
      return {
        code: 'ROOT_NOT_DIRECTORY',
        message: `« ${root} » n’est pas un dossier.`,
        hint: 'Indiquez le dossier racine du dépôt (celui qui contient package.json, pom.xml…), pas un fichier.',
      };
    case 'permissions.readSources':
      return {
        code: 'READ_SOURCES_DENIED',
        message: 'Le périmètre de l’incident interdit la lecture des sources.',
        hint: 'La découverte lit des manifestes du dépôt : autorisez la lecture des sources dans le périmètre (extension approuvée) avant de relancer.',
      };
    default:
      return {
        code: 'ROOT_DENIED',
        message: `Lecture refusée : ${reason}`,
        hint:
          rule === 'path.sensitive'
            ? 'Ce dossier est protégé (clés, secrets, métadonnées de gestion de versions) : indiquez la racine du dépôt lui-même.'
            : rule === 'path.symlink-escape'
              ? 'Le chemin est un lien qui mène ailleurs : indiquez le dossier réel du dépôt.'
              : 'Vérifiez le chemin et les droits de lecture de la machine qui investigue.',
      };
  }
}

const failed = (
  root: string,
  problem: DiscoveryProblem,
  keywords: readonly string[],
  now: string,
): ScopeDiscovery => ({
  root,
  status: 'FAILED',
  structure: 'UNKNOWN',
  tools: [],
  applications: [],
  relations: [],
  problems: [problem],
  denied: [],
  truncated: [],
  keywords: [...keywords],
  read: [],
  discoveredAt: now,
});

export async function discoverRepository(input: RepositoryDiscoveryInput): Promise<ScopeDiscovery> {
  const now = input.now ?? new Date().toISOString();
  const root = input.root.trim();
  const keywords = uniq(input.keywords.map((word) => word.toLowerCase())).filter(Boolean);
  if (!path.isAbsolute(root) && !path.win32.isAbsolute(root))
    return failed(
      root,
      {
        code: 'ROOT_RELATIVE',
        message: `Le chemin doit être absolu : « ${root || '(vide)'} ».`,
        hint: 'Indiquez le chemin complet du dépôt sur la machine qui investigue, par exemple /srv/repos/catalogue.',
      },
      keywords,
      now,
    );
  const { files } = input;
  if (!files.listDirectories)
    return failed(
      root,
      {
        code: 'ENVIRONMENT_CANNOT_LIST',
        message: 'Cet environnement d’exécution ne sait pas parcourir les dossiers.',
        hint: 'Choisissez un environnement LOCAL ou ARO (dépôts montés), ou ajoutez l’application à la main dans la section avancée.',
      },
      keywords,
      now,
    );
  let listing: DirectoryListing;
  try {
    listing = await files.listDirectories(root, {
      depth: SCOPE_DISCOVERY_TREE_DEPTH,
      maxNodes: SCOPE_DISCOVERY_MAX_NODES,
    });
  } catch (error) {
    return failed(root, problemOf(error, root), keywords, now);
  }
  const base = path.resolve(root);
  const relativeOf = (absolute: string): string => posix(path.relative(base, absolute));

  // Les manifestes, du moins profond au plus profond ; au plus SCOPE_DISCOVERY_MAX_MANIFESTS lus.
  const manifestFiles = (await files.list(root, { extensions: MANIFEST_EXTENSIONS }))
    .map((absolute): Manifest => {
      const relative = relativeOf(absolute);
      return {
        relative,
        absolute,
        name: path.posix.basename(relative),
        dir: path.posix.dirname(relative).replace(/^\.$/, ''),
      };
    })
    .filter(
      (manifest) =>
        (APP_MANIFESTS.has(manifest.name) ||
          WORKSPACE_MANIFESTS.has(manifest.name) ||
          SPRING_CONFIG.test(manifest.name) ||
          OTHER_CONFIGS.has(manifest.name) ||
          /\.csproj$/i.test(manifest.name)) &&
        depthOf(manifest.dir) <= SCOPE_DISCOVERY_DEPTH &&
        !isNoise(manifest.dir),
    )
    .sort((a, b) => depthOf(a.dir) - depthOf(b.dir) || a.relative.localeCompare(b.relative));
  const read: string[] = [];
  const problems: DiscoveryProblem[] = [];
  const readManifest = async (manifest: Manifest): Promise<string | undefined> => {
    if (read.length >= SCOPE_DISCOVERY_MAX_MANIFESTS) {
      if (!problems.some((problem) => problem.code === 'PARTIAL' && problem.message.includes('manifestes')))
        problems.push({
          code: 'PARTIAL',
          message: `Plus de ${String(SCOPE_DISCOVERY_MAX_MANIFESTS)} manifestes : les suivants n’ont pas été lus.`,
          hint: 'Analysez un sous-dossier du dépôt (une application à la fois) pour une détection complète.',
        });
      return undefined;
    }
    try {
      const text = await files.readText(manifest.absolute);
      read.push(manifest.relative);
      return text;
    } catch {
      // refus ou taille : consigné dans files.denied
      return undefined;
    }
  };

  const tools: string[] = [];
  const candidates: Candidate[] = [];
  const byDir = new Map<string, Candidate>();
  const candidate = (dir: string, name: string): Candidate => {
    const existing = byDir.get(dir);
    if (existing) return existing;
    const created: Candidate = {
      dir,
      name,
      frameworks: [],
      languages: new Set(),
      services: [],
      configs: [],
      evidence: [],
      questions: [],
      library: false,
      unrecognized: false,
      dependencies: [],
      targets: [],
    };
    byDir.set(dir, created);
    candidates.push(created);
    return created;
  };
  const rootName = path.basename(base) || base;
  const nameOfDir = (dir: string): string => (dir === '' ? rootName : path.posix.basename(dir));
  /** Les dossiers qui ne sont pas des applications : agrégateurs (racine d'espace de travail, pom parent). */
  const aggregators = new Set<string>();
  const angularProjects: { dir: string; name: string; kind: 'application' | 'library'; from: string }[] = [];
  const proxies: { dir: string; targets: string[]; from: string }[] = [];
  const configsByDir = new Map<string, Manifest[]>();
  const otherConfigs: Manifest[] = [];

  for (const manifest of manifestFiles) {
    const { name, dir, relative } = manifest;
    if (SPRING_CONFIG.test(name)) {
      configsByDir.set(dir, [...(configsByDir.get(dir) ?? []), manifest]);
      continue;
    }
    if (name === 'package.json') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const pkg = (safeJson(text) ?? {}) as NodePackage;
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      const names = Object.keys(deps);
      const app = candidate(
        dir,
        typeof pkg.name === 'string' && pkg.name ? pkg.name.replace(/^@[^/]+\//, '') : nameOfDir(dir),
      );
      if (typeof pkg.name === 'string' && pkg.name) app.packageName = pkg.name;
      app.dependencies.push(...names);
      app.evidence.push(`${relative} : paquet Node${pkg.name ? ` « ${pkg.name} »` : ''}`);
      const frontend = names
        .filter((dep) => dep in FRONTEND_FRAMEWORKS)
        .map((dep) => FRONTEND_FRAMEWORKS[dep] ?? dep);
      const server = names
        .filter((dep) => dep in NODE_SERVER_FRAMEWORKS)
        .map((dep) => NODE_SERVER_FRAMEWORKS[dep] ?? dep);
      app.frameworks.push(...frontend, ...server);
      app.services.push(
        ...names.filter((dep) => dep in NODE_SERVICES).map((dep) => NODE_SERVICES[dep] ?? dep),
      );
      if (names.includes('typescript')) app.languages.add('TypeScript');
      if (frontend.length > 0) {
        app.layer = 'FRONTEND';
        app.evidence.push(`${relative} : dépendance ${frontend.join(', ')} → frontend`);
      } else if (server.length > 0) {
        app.layer = BACKEND_NAME.test(app.name) && !BFF_NAME.test(app.name) ? 'BACKEND' : 'BFF';
        app.evidence.push(`${relative} : dépendance ${server.join(', ')} → serveur Node (${app.layer})`);
        app.questions.push('Serveur Node : couche BFF proposée, Backend si ce serveur porte les données.');
      } else {
        app.library = true;
      }
      if (pkg.workspaces !== undefined) {
        tools.push('npm/yarn workspaces');
        aggregators.add(dir);
        app.evidence.push(`${relative} : workspaces → racine d’un monorepo`);
      }
      continue;
    }
    if (
      name === 'pnpm-workspace.yaml' ||
      name === 'nx.json' ||
      name === 'lerna.json' ||
      name === 'turbo.json'
    ) {
      tools.push(WORKSPACE_TOOLS[name] ?? name);
      aggregators.add(dir);
      read.push(relative);
      continue;
    }
    if (name === 'angular.json') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const parsed = safeJson(text) as
        | { projects?: Record<string, { projectType?: string; root?: string; sourceRoot?: string }> }
        | undefined;
      const projects = Object.entries(parsed?.projects ?? {});
      for (const [projectName, project] of projects) {
        const projectRoot = posix(path.posix.normalize(project.root ?? ''))
          .replace(/^\.$/, '')
          .replace(/\/$/, '');
        const projectDir = [dir, projectRoot].filter(Boolean).join('/');
        angularProjects.push({
          dir: projectDir,
          name: projectName,
          kind: project.projectType === 'library' ? 'library' : 'application',
          from: relative,
        });
      }
      if (projects.filter(([, project]) => project.projectType !== 'library').length > 1)
        tools.push('Espace de travail Angular (plusieurs projets)');
      otherConfigs.push(manifest);
      continue;
    }
    if (name === 'proxy.conf.json') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const parsed = safeJson(text);
      const entries: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? Object.values(parsed)
          : [];
      const targets = uniq(
        entries.flatMap((entry) => {
          const target = (entry as { target?: unknown } | undefined)?.target;
          return typeof target === 'string' ? hostsOf(target) : [];
        }),
      );
      if (targets.length > 0) proxies.push({ dir, targets, from: relative });
      continue;
    }
    if (name === 'pom.xml') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const pom = parsePom(text);
      const app = candidate(dir, pom.artifactId ?? nameOfDir(dir));
      if (pom.artifactId) app.packageName = pom.artifactId;
      app.languages.add('Java');
      app.dependencies.push(...pom.dependencies);
      app.evidence.push(`${relative} : projet Maven${pom.artifactId ? ` « ${pom.artifactId} »` : ''}`);
      const coordinates = [...pom.dependencies, pom.parent ?? ''].join(' ');
      for (const [pattern, framework] of JAVA_FRAMEWORKS)
        if (pattern.test(coordinates)) app.frameworks.push(framework);
      for (const [pattern, service] of JAVA_SERVICES)
        if (pattern.test(coordinates)) app.services.push(service);
      if (pom.packaging === 'pom' && pom.modules.length > 0) {
        tools.push('Maven multi-module');
        aggregators.add(dir);
        app.evidence.push(`${relative} : packaging pom, modules ${pom.modules.join(', ')}`);
      }
      if (pom.mainClass) app.evidence.push(`${relative} : classe principale ${pom.mainClass}`);
      continue;
    }
    if (name === 'build.gradle' || name === 'build.gradle.kts') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const app = candidate(dir, nameOfDir(dir));
      app.languages.add(/\.kts$/.test(name) || /kotlin/.test(text) ? 'Kotlin' : 'Java');
      app.evidence.push(`${relative} : projet Gradle`);
      for (const [pattern, framework] of JAVA_FRAMEWORKS)
        if (pattern.test(text)) app.frameworks.push(framework);
      for (const [pattern, service] of JAVA_SERVICES) if (pattern.test(text)) app.services.push(service);
      app.dependencies.push(
        ...[...text.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)].map((m) => m[2] ?? ''),
      );
      continue;
    }
    if (name === 'settings.gradle' || name === 'settings.gradle.kts') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const includes = [...text.matchAll(/include\s*\(?\s*((?:["'][^"']+["']\s*,?\s*)+)\)?/g)];
      if (includes.length > 0) {
        tools.push('Gradle multi-projets');
        aggregators.add(dir);
      }
      const rootProject = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
      if (rootProject) {
        const app = byDir.get(dir);
        if (app) app.name = rootProject;
      }
      continue;
    }
    if (name === 'pyproject.toml' || name === 'requirements.txt') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const app = candidate(dir, /name\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? nameOfDir(dir));
      app.languages.add('Python');
      app.evidence.push(`${relative} : projet Python`);
      for (const [pattern, framework] of PYTHON_FRAMEWORKS)
        if (pattern.test(text)) app.frameworks.push(framework);
      if (app.frameworks.length > 0) {
        app.layer = 'BACKEND';
        app.evidence.push(`${relative} : ${app.frameworks.join(', ')} → backend`);
      }
      continue;
    }
    if (name === 'go.mod') {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const module = /^module\s+(\S+)/m.exec(text)?.[1];
      const app = candidate(dir, module ? (module.split('/').at(-1) ?? module) : nameOfDir(dir));
      app.languages.add('Go');
      app.evidence.push(`${relative} : module Go${module ? ` « ${module} »` : ''}`);
      for (const [pattern, framework] of GO_FRAMEWORKS)
        if (pattern.test(text)) app.frameworks.push(framework);
      app.layer = 'BACKEND';
      continue;
    }
    if (/\.csproj$/i.test(name)) {
      const text = await readManifest(manifest);
      if (text === undefined) continue;
      const app = candidate(dir, name.replace(/\.csproj$/i, ''));
      app.languages.add('C#');
      app.evidence.push(`${relative} : projet .NET`);
      if (/Microsoft\.AspNetCore|Microsoft\.NET\.Sdk\.Web/.test(text)) {
        app.frameworks.push('ASP.NET Core');
        app.layer = 'BACKEND';
      }
      continue;
    }
    if (OTHER_CONFIGS.has(name)) otherConfigs.push(manifest);
  }
  // Les autres configurations (angular.json, nx.json, tsconfig.json, docker-compose) : à l'application de leur dossier.
  for (const config of otherConfigs) {
    const app = byDir.get(config.dir);
    if (!app) continue;
    if (config.name === 'tsconfig.json') app.languages.add('TypeScript');
    else app.configs.push(config.relative);
  }

  // Les projets d'un espace de travail Angular : des applications (ou bibliothèques) sans package.json propre.
  for (const project of angularProjects) {
    const app = candidate(project.dir, project.name);
    if (!app.frameworks.includes('Angular')) app.frameworks.push('Angular');
    app.languages.add('TypeScript');
    app.evidence.push(
      `${project.from} : projet Angular « ${project.name} » (${project.kind === 'library' ? 'bibliothèque' : 'application'})`,
    );
    if (project.kind === 'library') app.library = true;
    else {
      app.layer = 'FRONTEND';
      app.library = false;
    }
    const workspaceRoot = path.posix.dirname(project.from).replace(/^\.$/, '');
    if (project.dir !== workspaceRoot) aggregators.add(workspaceRoot);
  }

  // La configuration Spring : les fichiers de l'application la plus proche ; le port et les URLs (hôtes seulement).
  const appDirs = candidates.map((entry) => entry.dir).sort((a, b) => depthOf(b) - depthOf(a));
  const owner = (dir: string): Candidate | undefined => {
    const found = appDirs.find((appDir) => under(dir, appDir));
    return found === undefined ? undefined : byDir.get(found);
  };
  for (const [dir, configs] of configsByDir) {
    const app = owner(dir);
    if (!app) continue;
    app.configs.push(...configs.map((config) => config.relative));
    if (!app.frameworks.includes('Spring Boot') && app.languages.has('Java'))
      app.frameworks.push('Spring Boot');
    let readCount = 0;
    for (const config of configs.sort((a, b) => a.name.length - b.name.length)) {
      if (readCount >= MAX_CONFIGS_READ) break;
      const text = await readManifest(config);
      if (text === undefined) continue;
      readCount += 1;
      const port = serverPortOf(config.name, text);
      if (port !== undefined && app.port === undefined) {
        app.port = port;
        app.evidence.push(`${config.relative} : server.port ${String(port)}`);
      }
      for (const host of hostsOf(text))
        app.targets.push({ ref: host, evidence: `${config.relative} : URL vers ${host}` });
    }
  }
  for (const proxy of proxies) {
    const app = owner(proxy.dir);
    if (!app) continue;
    app.configs.push(proxy.from);
    for (const target of proxy.targets)
      app.targets.push({ ref: target, evidence: `${proxy.from} : proxy de développement vers ${target}` });
  }

  // Les fichiers de code : langages, points d'entrée ; et les dossiers de code sans manifeste (reconnus partiellement).
  const codeFiles = (await files.list(root, { extensions: CODE_EXTENSIONS }))
    .map(relativeOf)
    .filter((relative) => !isNoise(relative));
  const nonAggregators = candidates.filter(
    (entry) => !aggregators.has(entry.dir) || entry.frameworks.length > 0,
  );
  const codeDirs = nonAggregators.map((entry) => entry.dir).sort((a, b) => depthOf(b) - depthOf(a));
  const ownerOfCode = (relative: string): string | undefined => codeDirs.find((dir) => under(relative, dir));
  const unowned = new Map<string, Set<string>>();
  const entries = new Map<string, string[]>();
  for (const relative of codeFiles) {
    const dir = ownerOfCode(relative);
    const extension = path.posix.extname(relative).toLowerCase();
    const language =
      extension === '.java'
        ? 'Java'
        : extension === '.kt'
          ? 'Kotlin'
          : extension === '.py'
            ? 'Python'
            : extension === '.go'
              ? 'Go'
              : extension === '.cs'
                ? 'C#'
                : extension === '.vue'
                  ? 'Vue'
                  : /\.tsx?$/.test(extension)
                    ? 'TypeScript'
                    : 'JavaScript';
    if (dir === undefined) {
      const top = relative.split('/')[0] ?? '';
      if (relative.includes('/') && !NOT_MODULES.has(top))
        unowned.set(top, (unowned.get(top) ?? new Set()).add(language));
      else if (!relative.includes('/')) unowned.set('', (unowned.get('') ?? new Set()).add(language));
      continue;
    }
    const app = byDir.get(dir);
    if (!app) continue;
    app.languages.add(language);
    const inApp = dir === '' ? relative : relative.slice(dir.length + 1);
    const fileName = path.posix.basename(inApp);
    const isEntry =
      (ENTRY_FILES.has(fileName) && depthOf(path.posix.dirname(inApp).replace(/^\.$/, '')) <= 1) ||
      /Application\.(java|kt)$/.test(fileName) ||
      (fileName === 'Main.java' && inApp.includes('src/main/'));
    if (isEntry) entries.set(dir, [...(entries.get(dir) ?? []), inApp]);
  }
  // Un dossier de code sans manifeste : une application reconnue partiellement (la couche est à confirmer).
  if (!byDir.has('')) {
    for (const [top, languages] of unowned) {
      if (candidates.some((entry) => under(top, entry.dir) && entry.dir !== '')) continue;
      const app = candidate(top, nameOfDir(top));
      app.unrecognized = true;
      for (const language of languages) app.languages.add(language);
      app.evidence.push(`${top || '.'} : fichiers ${[...languages].join(', ')} sans manifeste reconnu`);
      app.questions.push(
        'Aucun manifeste reconnu (package.json, pom.xml, build.gradle, pyproject.toml, go.mod, *.csproj) : confirmez qu’il s’agit d’une application et sa couche.',
      );
      app.layer =
        languages.has('Java') ||
        languages.has('Kotlin') ||
        languages.has('Python') ||
        languages.has('Go') ||
        languages.has('C#')
          ? 'BACKEND'
          : 'FRONTEND';
    }
  }

  // Les applications retenues : ni agrégateur pur, ni bibliothèque dont personne ne dépend… (les bibliothèques restent, non proposées).
  const retained = candidates.filter(
    (entry) => !(aggregators.has(entry.dir) && entry.frameworks.length === 0 && !entry.unrecognized),
  );
  if (retained.length === 0) {
    problems.push({
      code: 'NOTHING_RECOGNIZED',
      message: 'Aucune application reconnue dans ce dossier.',
      hint: 'Aucun manifeste (package.json, angular.json, pom.xml, build.gradle, pyproject.toml, go.mod, *.csproj) ni fichier de code trouvé jusqu’à quatre niveaux. Vérifiez que le chemin est la racine du dépôt, ou ajoutez l’application à la main dans la section avancée.',
    });
  }

  // Couche, confiance, modules, identifiants.
  const taken = new Set(input.existing.map((application) => application.id));
  const existingByRoot = new Map(
    input.existing.map((application) => [path.resolve(application.repository.root), application.id] as const),
  );
  const idOf = new Map<Candidate, string>();
  for (const entry of retained) idOf.set(entry, applicationIdOf(entry.name, taken));
  const byPackage = new Map<string, Candidate>();
  for (const entry of retained) if (entry.packageName) byPackage.set(entry.packageName, entry);
  const byPort = new Map<number, Candidate>();
  for (const entry of retained)
    if (entry.port !== undefined && !byPort.has(entry.port)) byPort.set(entry.port, entry);

  // Relations : dépendances déclarées, proxy et URLs vers un port ou un nom connu.
  const relations: DiscoveryRelation[] = [];
  const relate = (
    from: Candidate,
    to: Candidate,
    kind: DiscoveryRelation['kind'],
    status: DiscoveryRelation['status'],
    evidence: string,
  ): void => {
    const fromId = idOf.get(from);
    const toId = idOf.get(to);
    if (!fromId || !toId || fromId === toId) return;
    if (
      relations.some((relation) => relation.from === fromId && relation.to === toId && relation.kind === kind)
    )
      return;
    relations.push({ from: fromId, to: toId, kind, status, evidence });
  };
  for (const entry of retained) {
    for (const dependency of entry.dependencies) {
      const target = byPackage.get(dependency);
      if (target && target !== entry)
        relate(
          entry,
          target,
          'USES',
          'STATICALLY_RESOLVED',
          `${entry.dir || '.'} : dépend de « ${dependency} »`,
        );
    }
    for (const target of entry.targets) {
      const port = Number(target.ref.split(':')[1]);
      const byPortTarget = Number.isInteger(port) ? byPort.get(port) : undefined;
      const host = target.ref.split(':')[0] ?? '';
      const byName = retained.find(
        (other) =>
          other !== entry &&
          tokensOf(other.name).some((token) => token.length >= 4 && tokensOf(host).includes(token)),
      );
      const found = byPortTarget ?? byName;
      if (found && found !== entry)
        relate(
          entry,
          found,
          'CALLS',
          'INFERRED',
          `${target.evidence} (${byPortTarget ? `server.port de « ${found.name} »` : `nom de « ${found.name} »`})`,
        );
    }
  }

  // Pertinence : les mots de l'incident dans le nom, le chemin et les modules ; l'application nommée par l'incident.
  const applicationTokens = input.application ? tokensOf(input.application) : [];
  const applications: DiscoveredApplication[] = [];
  const suggestedIds = new Set<string>();
  const reasonsOf = new Map<string, string[]>();
  for (const entry of retained) {
    const id = idOf.get(entry) ?? entry.name;
    const absoluteDir = entry.dir === '' ? base : path.join(base, ...entry.dir.split('/'));
    const node = nodeAt(listing, entry.dir);
    const modules = modulesOf(entry, node, keywords);
    if (entry.layer === undefined) {
      const text = `${entry.name} ${entry.dir}`;
      if (BFF_NAME.test(text)) entry.layer = 'BFF';
      else if (BACKEND_NAME.test(text) && entry.languages.has('Java')) entry.layer = 'BACKEND';
      else if (
        entry.languages.has('Java') ||
        entry.languages.has('Kotlin') ||
        entry.languages.has('Python') ||
        entry.languages.has('Go') ||
        entry.languages.has('C#')
      )
        entry.layer = 'BACKEND';
      else if (
        FRONTEND_NAME.test(text) ||
        entry.languages.has('TypeScript') ||
        entry.languages.has('JavaScript')
      )
        entry.layer = 'FRONTEND';
      else entry.layer = 'BACKEND';
      if (!entry.unrecognized)
        entry.questions.push(`Couche déduite du nom et du langage (${entry.layer}) : à confirmer.`);
    }
    const nameMatches = matchedKeywords(keywords, [...tokensOf(entry.name), ...tokensOf(entry.dir)]);
    const moduleMatches = modules.filter((module) => (module.matched?.length ?? 0) > 0);
    const named =
      applicationTokens.length > 0 &&
      applicationTokens.some((token) =>
        tokensOf(entry.name).some((candidateToken) => matches(token, candidateToken)),
      );
    const matched = uniq([...nameMatches, ...moduleMatches.flatMap((module) => module.matched ?? [])]);
    let relevance = Math.min(1, matched.length / Math.max(1, Math.min(keywords.length, 3)));
    if (named) relevance = Math.max(relevance, 0.9);
    const reasons: string[] = [];
    if (named) reasons.push(`application nommée par l’incident (« ${input.application ?? ''} »)`);
    if (nameMatches.length > 0) reasons.push(`mots de l’incident dans le nom : ${nameMatches.join(', ')}`);
    if (moduleMatches.length > 0)
      reasons.push(
        `mots de l’incident dans les modules : ${moduleMatches
          .map((module) => module.name)
          .slice(0, 6)
          .join(', ')}`,
      );
    const confidence = entry.unrecognized
      ? 'LOW'
      : entry.frameworks.length > 0 &&
          !entry.questions.some((question) => question.startsWith('Serveur Node'))
        ? 'HIGH'
        : 'MEDIUM';
    const alreadyInScope = existingByRoot.get(path.resolve(absoluteDir));
    const application: ScopeApplication = {
      id,
      name: entry.name,
      layer: entry.layer,
      repository: { root: absoluteDir, include: [] },
      origin: { kind: 'DISCOVERED', at: now, analyzedRoot: base, evidence: entry.evidence.slice(0, 8) },
    };
    applications.push({
      application,
      path: entry.dir,
      frameworks: uniq(entry.frameworks),
      languages: [...entry.languages].sort(),
      modules,
      entryPoints: uniq(entries.get(entry.dir) ?? [])
        .sort()
        .slice(0, MAX_ENTRY_POINTS),
      configs: uniq(entry.configs).sort(),
      services: uniq(entry.services),
      confidence,
      evidence: uniq(entry.evidence),
      questions: uniq(entry.questions),
      relevance,
      reasons,
      suggested: false,
      ...(alreadyInScope !== undefined ? { alreadyInScope } : {}),
    });
    reasonsOf.set(id, reasons);
    if (relevance > 0 && alreadyInScope === undefined && !entry.library) suggestedIds.add(id);
  }
  // Rien de retrouvé : un dépôt de trois applications au plus est proposé en entier ; au-delà, à choisir.
  const selectable = applications.filter(
    (entry) =>
      entry.alreadyInScope === undefined &&
      !retained.find((candidateEntry) => idOf.get(candidateEntry) === entry.application.id)?.library,
  );
  if (suggestedIds.size === 0 && selectable.length > 0) {
    if (selectable.length <= 3)
      for (const entry of selectable) {
        suggestedIds.add(entry.application.id);
        reasonsOf
          .get(entry.application.id)
          ?.push(
            keywords.length === 0
              ? 'aucun mot dans la description de l’incident : toutes les applications sont proposées'
              : 'aucun mot de l’incident retrouvé : les applications du dépôt sont proposées (trois au plus)',
          );
      }
    else
      for (const entry of selectable)
        reasonsOf.get(entry.application.id)?.push('aucun mot de l’incident retrouvé : à choisir');
  }
  // Les dépendances transversales des applications proposées (relations), jusqu'à stabilité : ce qu'une
  // application proposée utilise ou appelle ; et ce qui appelle un service proposé (le symptôme se voit en amont).
  const nameOf = (id: string): string =>
    applications.find((entry) => entry.application.id === id)?.application.name ?? id;
  const propose = (id: string, reason: string): boolean => {
    if (suggestedIds.has(id)) return false;
    const target = applications.find((entry) => entry.application.id === id);
    if (!target || target.alreadyInScope !== undefined) return false;
    suggestedIds.add(id);
    reasonsOf.get(id)?.push(reason);
    return true;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const relation of relations) {
      const how = relation.status === 'INFERRED' ? 'déduit' : 'déclaré';
      if (suggestedIds.has(relation.from))
        grew =
          propose(
            relation.to,
            `dépendance de « ${nameOf(relation.from)} » (${relation.kind === 'USES' ? 'utilisée' : 'appelée'}, ${how})`,
          ) || grew;
      if (relation.kind === 'CALLS' && suggestedIds.has(relation.to))
        grew = propose(relation.from, `appelle « ${nameOf(relation.to)} » (${how})`) || grew;
    }
  }
  for (const entry of applications) {
    entry.suggested = suggestedIds.has(entry.application.id);
    if (entry.alreadyInScope !== undefined)
      entry.reasons.push(`déjà dans le périmètre (« ${entry.alreadyInScope} »)`);
    else if (!entry.suggested && entry.reasons.length === 0)
      entry.reasons.push(
        retained.find((candidateEntry) => idOf.get(candidateEntry) === entry.application.id)?.library
          ? 'bibliothèque partagée : proposée seulement si une application proposée en dépend'
          : 'aucun mot de l’incident retrouvé',
      );
  }
  applications.sort(
    (a, b) =>
      Number(b.suggested) - Number(a.suggested) || b.relevance - a.relevance || a.path.localeCompare(b.path),
  );

  const truncated = [...files.truncated];
  if (listing.capped)
    truncated.push(
      `${root} : plus de ${String(SCOPE_DISCOVERY_MAX_NODES)} dossiers, l’arborescence lue est partielle.`,
    );
  if (truncated.length > 0 && !problems.some((problem) => problem.code === 'PARTIAL'))
    problems.push({
      code: 'PARTIAL',
      message: 'Lecture partielle : la limite de fichiers ou de dossiers a été atteinte.',
      hint: 'Les langages, points d’entrée et modules peuvent manquer. Analysez un sous-dossier du dépôt ou relevez la limite de fichiers du périmètre.',
    });
  const structure: ScopeDiscovery['structure'] =
    retained.length === 0
      ? 'UNKNOWN'
      : tools.length > 0
        ? 'MONOREPO'
        : retained.length > 1
          ? 'MULTI_APP'
          : 'SINGLE';
  const denied = files.denied.filter((entry) => !/^limits\./.test(entry.reason));
  return {
    root,
    status: retained.length === 0 ? 'FAILED' : problems.length > 0 || denied.length > 0 ? 'PARTIAL' : 'OK',
    structure,
    tools: uniq(tools).sort(),
    applications,
    relations,
    problems,
    denied,
    truncated,
    keywords,
    read,
    discoveredAt: now,
  };
}

/** Les modules d'une application : les dossiers de code selon le cadre (src/app en Angular, le paquet Java, src…). */
function modulesOf(
  entry: Candidate,
  node: DirectoryNode | undefined,
  keywords: readonly string[],
): DiscoveredModule[] {
  if (!node) return [];
  const child = (from: DirectoryNode, ...names: string[]): DirectoryNode | undefined => {
    let current: DirectoryNode = from;
    for (const name of names) {
      const next = current.children.find((item) => item.name === name);
      if (!next) return undefined;
      current = next;
    }
    return current;
  };
  let parent: DirectoryNode | undefined;
  if (entry.frameworks.includes('Angular')) parent = child(node, 'src', 'app') ?? child(node, 'src');
  else if (entry.languages.has('Java') || entry.languages.has('Kotlin')) {
    parent =
      child(node, 'src', 'main', entry.languages.has('Kotlin') ? 'kotlin' : 'java') ??
      child(node, 'src', 'main', 'java');
    // Le paquet : descendre tant qu'il n'y a qu'un seul sous-dossier (org/example/app), au plus six niveaux.
    for (let level = 0; parent && parent.children.length === 1 && level < 6; level += 1)
      parent = parent.children[0];
  } else if (entry.languages.has('Go'))
    parent = child(node, 'internal') ?? child(node, 'pkg') ?? child(node, 'cmd');
  else parent = child(node, 'src') ?? node;
  parent ??= node;
  const relativeTo = (module: DirectoryNode): string =>
    entry.dir === '' ? module.path : module.path.slice(entry.dir.length + 1);
  return parent.children
    .filter((module) => !NOT_MODULES.has(module.name) && !module.name.startsWith('.'))
    .slice(0, MAX_MODULES)
    .map((module) => {
      const matched = matchedKeywords(keywords, tokensOf(module.name));
      return { path: relativeTo(module), name: module.name, ...(matched.length > 0 ? { matched } : {}) };
    });
}
