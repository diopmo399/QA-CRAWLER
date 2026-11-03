import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFiles } from '../../src/incident/guarded-fs.js';
import { discoverRepository, hostsOf, serverPortOf, tokensOf } from '../../src/incident/scope-discovery.js';
import { ScopePolicy } from '../../src/incident/scope-policy.js';
import { DEFAULT_PERMISSIONS, defaultScope } from '../../src/incident/scope.js';
import type { ScopeApplication, ScopeDiscovery } from '../../src/sdk/core/incident-contracts.js';

/**
 * LA DÉCOUVERTE AUTOMATIQUE DU PÉRIMÈTRE : un projet Angular seul, un service Spring Boot, un monorepo
 * (workspaces + Nx), un dépôt à plusieurs applications sans outil d'espace de travail, un dépôt reconnu
 * partiellement (code sans manifeste), un chemin invalide ou inaccessible ; la pertinence d'après les mots
 * de l'incident, les dépendances transversales proposées, les preuves citées, rien d'inventé.
 */
let repos: string;

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

const pkg = (name: string, deps: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, version: '1.0.0', dependencies: deps, ...extra });

const pom = (artifactId: string, deps: string[], extra = ''): string => `<?xml version="1.0"?>
<project>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.0</version></parent>
  <groupId>com.acme</groupId>
  <artifactId>${artifactId}</artifactId>
  ${extra}
  <dependencies>
    ${deps.map((dep) => `<dependency><groupId>org.springframework.boot</groupId><artifactId>${dep}</artifactId></dependency>`).join('\n')}
  </dependencies>
</project>`;

beforeAll(async () => {
  repos = await realpath(await mkdtemp(path.join(tmpdir(), 'qa-scope-discovery-')));
  // (a) Un projet Angular seul, avec un proxy de développement vers un BFF local.
  await write(path.join(repos, 'front'), {
    'package.json': pkg(
      'catalogue-web',
      { '@angular/core': '^18', rxjs: '^7', '@ngrx/store': '^18' },
      { devDependencies: { typescript: '^5' } },
    ),
    'angular.json': JSON.stringify({
      projects: { 'catalogue-web': { projectType: 'application', root: '', sourceRoot: 'src' } },
    }),
    'proxy.conf.json': JSON.stringify({ '/api': { target: 'http://localhost:8080' } }),
    'src/main.ts': 'bootstrapApplication(App);',
    'src/app/app.routes.ts': 'export const routes = [];',
    'src/app/dossiers/dossier.component.ts': 'export class DossierComponent {}',
    'src/app/notes/notes.service.ts': 'export class NotesService {}',
    'src/assets/logo.svg': '<svg/>',
    'src/environments/environment.ts': 'export const environment = {};',
    '.env': 'SECRET=never-read',
  });
  // (b) Un service Spring Boot, avec son port et une URL vers un autre service.
  await write(path.join(repos, 'billing-api'), {
    'pom.xml': pom('billing-api', [
      'spring-boot-starter-web',
      'spring-boot-starter-data-jpa',
      'spring-kafka',
    ]),
    'src/main/java/com/acme/billing/BillingApplication.java': 'public class BillingApplication {}',
    'src/main/java/com/acme/billing/invoice/InvoiceController.java': 'class InvoiceController {}',
    'src/main/java/com/acme/billing/payment/PaymentService.java': 'class PaymentService {}',
    'src/main/resources/application.yml':
      'server:\n  port: 8080\nbilling:\n  notes:\n    url: http://notes-svc:9090/api\n',
    'src/main/resources/application-prod.yml': 'server:\n  port: 8443\n',
    'src/test/java/com/acme/billing/BillingApplicationTests.java': 'class BillingApplicationTests {}',
  });
  // (c) Un monorepo : workspaces npm + Nx, une application Angular, un BFF NestJS, une bibliothèque partagée.
  await write(path.join(repos, 'mono'), {
    'package.json': pkg('mono', {}, { private: true, workspaces: ['apps/*', 'packages/*'] }),
    'nx.json': '{}',
    'apps/web/package.json': pkg('web', { '@angular/core': '^18', '@mono/shared': 'workspace:*' }),
    'apps/web/src/main.ts': '',
    'apps/web/src/app/dossiers/list.component.ts': '',
    'apps/web/src/app/profil/profil.component.ts': '',
    'apps/bff/package.json': pkg('bff', { '@nestjs/core': '^10', axios: '^1' }),
    'apps/bff/src/main.ts': '',
    'apps/bff/src/dossiers/dossiers.controller.ts': '',
    'packages/shared/package.json': pkg('@mono/shared', { rxjs: '^7' }),
    'packages/shared/src/index.ts': '',
    'packages/tools/package.json': pkg('@mono/tools', {}),
    'packages/tools/src/index.ts': '',
  });
  // (d) Plusieurs applications sans outil d'espace de travail : un frontend React et un backend Spring, reliés par le proxy et le port.
  await write(path.join(repos, 'multi'), {
    'frontend/package.json': pkg('shop-frontend', { react: '^18', 'react-dom': '^18' }),
    'frontend/proxy.conf.json': JSON.stringify([{ context: ['/api'], target: 'http://localhost:8081' }]),
    'frontend/src/index.tsx': '',
    'frontend/src/features/cart/Cart.tsx': '',
    'backend/pom.xml': pom('shop-backend', ['spring-boot-starter-web']),
    'backend/src/main/resources/application.properties': 'server.port=8081\n',
    'backend/src/main/java/com/shop/ShopApplication.java': '',
    'backend/src/main/java/com/shop/cart/CartController.java': '',
    'backend/src/main/java/com/shop/order/OrderService.java': '',
  });
  // (e) Reconnu partiellement : un module Go reconnu, un dossier Java sans pom.xml.
  await write(path.join(repos, 'partial'), {
    'api/go.mod': 'module github.com/acme/api\n\nrequire github.com/gin-gonic/gin v1.9.0\n',
    'api/main.go': 'package main',
    'api/internal/orders/handler.go': 'package orders',
    'legacy/src/com/acme/Legacy.java': 'class Legacy {}',
    Makefile: 'all:\n\techo ok\n',
  });
  // (f) Un dossier vide et un fichier, un dossier sensible.
  await mkdir(path.join(repos, 'empty'), { recursive: true });
  await write(path.join(repos, 'secrets', '.ssh'), { id_rsa: 'never' });
});

afterAll(async () => {
  await rm(repos, { recursive: true, force: true });
});

const discover = (
  root: string,
  keywords: string[] = [],
  over: { application?: string; existing?: ScopeApplication[] } = {},
): Promise<ScopeDiscovery> => {
  const probe: ScopeApplication = {
    id: 'discovery',
    name: 'probe',
    layer: 'BACKEND',
    repository: { root, include: [] },
  };
  const policy = new ScopePolicy(defaultScope({ applications: [probe] }));
  return discoverRepository({
    root,
    files: guardedFiles(policy),
    keywords,
    existing: over.existing ?? [],
    now: '2026-11-01T10:00:00.000Z',
    ...(over.application ? { application: over.application } : {}),
  });
};

const appOf = (result: ScopeDiscovery, id: string) => {
  const found = result.applications.find((entry) => entry.application.id === id);
  if (!found)
    throw new Error(
      `application ${id} not found in ${result.applications.map((e) => e.application.id).join(', ')}`,
    );
  return found;
};

describe('helpers', () => {
  it('tokens, server port and hosts', () => {
    expect(tokensOf('catalogue-web/apps/DossierClient')).toEqual([
      'catalogue',
      'web',
      'apps',
      'dossier',
      'client',
    ]);
    expect(serverPortOf('application.yml', 'server:\n  port: 8080\n')).toBe(8080);
    expect(serverPortOf('application.properties', 'server.port=8081\n')).toBe(8081);
    expect(serverPortOf('application.yml', 'spring:\n  port: 1\n')).toBeUndefined();
    // Jamais les identifiants, le chemin ni les paramètres d'une URL.
    expect(
      hostsOf('url: http://user:secret@notes-svc:9090/api?token=x and https://acme.example/path'),
    ).toEqual(['notes-svc:9090', 'acme.example']);
  });
});

describe('a single Angular project', () => {
  it('detects the framework, layer, modules, entry point, configs and services, never the .env file', async () => {
    const result = await discover(path.join(repos, 'front'), ['dossier', 'enregistrer', 'erreur'], {
      application: 'Catalogue',
    });
    expect(result.status).toBe('OK');
    expect(result.structure).toBe('SINGLE');
    expect(result.applications).toHaveLength(1);
    const app = appOf(result, 'catalogue-web');
    expect(app.application).toMatchObject({
      id: 'catalogue-web',
      name: 'catalogue-web',
      layer: 'FRONTEND',
      repository: { root: path.join(repos, 'front'), include: [] },
      origin: { kind: 'DISCOVERED', analyzedRoot: path.join(repos, 'front') },
    });
    expect(app.frameworks).toEqual(['Angular']);
    expect(app.languages).toEqual(['TypeScript']);
    expect(app.confidence).toBe('HIGH');
    expect(app.modules.map((module) => module.name)).toEqual(['dossiers', 'notes']);
    expect(app.modules[0]?.matched).toEqual(['dossier']);
    expect(app.entryPoints).toEqual(['src/main.ts']);
    expect(app.configs).toEqual(['angular.json', 'proxy.conf.json']);
    expect(app.services).toEqual(['RxJS', 'NgRx']);
    expect(app.suggested).toBe(true);
    expect(app.relevance).toBeGreaterThanOrEqual(0.9);
    expect(app.reasons).toEqual([
      'application nommée par l’incident (« Catalogue »)',
      'mots de l’incident dans les modules : dossiers',
    ]);
    expect(app.evidence).toContain('package.json : dépendance Angular → frontend');
    expect(app.questions).toEqual([]);
    // Le fichier .env n'est ni lu ni listé ; aucun contenu de configuration n'est exposé.
    expect(result.read).toEqual(['angular.json', 'package.json', 'proxy.conf.json']);
    expect(JSON.stringify(result)).not.toContain('never-read');
    expect(result.keywords).toEqual(['dossier', 'enregistrer', 'erreur']);
    expect(Number.isInteger(result.durationMs) && result.durationMs >= 0).toBe(true);
  });

  it('is suggested alone when no word of the incident is found, and flagged when already in the scope', async () => {
    const root = path.join(repos, 'front');
    const none = await discover(root, ['paiement']);
    expect(appOf(none, 'catalogue-web').suggested).toBe(true);
    expect(appOf(none, 'catalogue-web').reasons).toEqual([
      'aucun mot de l’incident retrouvé : les applications du dépôt sont proposées (trois au plus)',
    ]);
    const known = await discover(root, [], {
      existing: [{ id: 'front', name: 'Front', layer: 'FRONTEND', repository: { root, include: [] } }],
    });
    const app = appOf(known, 'catalogue-web');
    expect(app.alreadyInScope).toBe('front');
    expect(app.suggested).toBe(false);
    expect(app.reasons).toContain('déjà dans le périmètre (« front »)');
  });
});

describe('a Spring Boot service', () => {
  it('detects Maven, Spring Boot, the Java package modules, the application class, the port and the services', async () => {
    const result = await discover(path.join(repos, 'billing-api'), ['facture', 'paiement']);
    expect(result.status).toBe('OK');
    const app = appOf(result, 'billing-api');
    expect(app.application.layer).toBe('BACKEND');
    expect(app.frameworks).toEqual(['Spring Boot']);
    expect(app.languages).toEqual(['Java']);
    expect(app.services).toEqual(['HTTP (Spring MVC)', 'JPA', 'Kafka']);
    expect(app.modules.map((module) => module.name)).toEqual(['invoice', 'payment']);
    expect(app.entryPoints).toEqual(['src/main/java/com/acme/billing/BillingApplication.java']);
    expect(app.configs).toEqual([
      'src/main/resources/application-prod.yml',
      'src/main/resources/application.yml',
    ]);
    expect(app.evidence).toContain('src/main/resources/application.yml : server.port 8080');
    expect(app.confidence).toBe('HIGH');
    // Les tests ne sont ni des modules ni des points d'entrée.
    expect(JSON.stringify(app)).not.toContain('BillingApplicationTests');
    // Aucun mot retrouvé (modules en anglais) : seule application, proposée quand même.
    expect(app.suggested).toBe(true);
  });
});

describe('a monorepo', () => {
  it('recognizes the workspace tools, every application, the shared library and the declared dependency', async () => {
    const result = await discover(path.join(repos, 'mono'), ['dossiers', 'liste']);
    expect(result.structure).toBe('MONOREPO');
    expect(result.tools).toEqual(['Nx', 'npm/yarn workspaces']);
    expect(result.applications.map((entry) => entry.application.id).sort()).toEqual([
      'bff',
      'shared',
      'tools',
      'web',
    ]);
    const web = appOf(result, 'web');
    expect(web.application.layer).toBe('FRONTEND');
    expect(web.application.repository.root).toBe(path.join(repos, 'mono', 'apps', 'web'));
    expect(web.path).toBe('apps/web');
    expect(web.suggested).toBe(true);
    expect(web.modules.map((module) => module.name)).toEqual(['dossiers', 'profil']);
    const bff = appOf(result, 'bff');
    expect(bff.application.layer).toBe('BFF');
    expect(bff.frameworks).toEqual(['NestJS']);
    expect(bff.confidence).toBe('MEDIUM');
    expect(bff.questions).toEqual([
      'Serveur Node : couche BFF proposée, Backend si ce serveur porte les données.',
    ]);
    // Le BFF touche aussi « dossiers » (module) : proposé.
    expect(bff.suggested).toBe(true);
    // La bibliothèque partagée : proposée parce que l'application proposée en dépend (relation déclarée).
    const shared = appOf(result, 'shared');
    expect(shared.suggested).toBe(true);
    expect(shared.reasons).toEqual(['dépendance de « web » (utilisée, déclaré)']);
    expect(result.relations).toEqual([
      {
        from: 'web',
        to: 'shared',
        kind: 'USES',
        status: 'STATICALLY_RESOLVED',
        evidence: 'apps/web : dépend de « @mono/shared »',
      },
    ]);
    // Une bibliothèque dont personne ne dépend : visible, non proposée, et dit pourquoi.
    const tools = appOf(result, 'tools');
    expect(tools.suggested).toBe(false);
    expect(tools.reasons).toEqual([
      'bibliothèque partagée : proposée seulement si une application proposée en dépend',
    ]);
    // La racine (workspaces) n'est pas une application.
    expect(result.applications.some((entry) => entry.path === '')).toBe(false);
  });
});

describe('several applications without workspace tooling', () => {
  it('relates the frontend proxy to the backend port, and suggests the backend as a dependency', async () => {
    const result = await discover(path.join(repos, 'multi'), ['panier', 'cart']);
    expect(result.structure).toBe('MULTI_APP');
    expect(result.tools).toEqual([]);
    const front = appOf(result, 'shop-frontend');
    expect(front.frameworks).toEqual(['React']);
    expect(front.application.layer).toBe('FRONTEND');
    expect(front.modules.map((module) => module.name)).toEqual(['features']);
    // Le frontend ne touche aucun mot (« cart » est un sous-dossier de features) : proposé parce qu'il appelle le backend proposé.
    expect(front.suggested).toBe(true);
    expect(front.reasons).toEqual(['appelle « shop-backend » (déduit)']);
    const back = appOf(result, 'shop-backend');
    expect(back.modules.map((module) => module.name)).toEqual(['cart', 'order']);
    expect(back.suggested).toBe(true);
    expect(result.relations).toEqual([
      {
        from: 'shop-frontend',
        to: 'shop-backend',
        kind: 'CALLS',
        status: 'INFERRED',
        evidence:
          'frontend/proxy.conf.json : proxy de développement vers localhost:8081 (server.port de « shop-backend »)',
      },
    ]);
  });
});

describe('a partially recognized repository', () => {
  it('keeps the recognized module, reports the code folder without manifest as a question, and stays PARTIAL-free', async () => {
    const result = await discover(path.join(repos, 'partial'), []);
    expect(result.status).toBe('OK');
    expect(result.structure).toBe('MULTI_APP');
    const api = appOf(result, 'api');
    expect(api.frameworks).toEqual(['Gin']);
    expect(api.languages).toEqual(['Go']);
    expect(api.application.layer).toBe('BACKEND');
    expect(api.modules.map((module) => module.name)).toEqual(['orders']);
    expect(api.entryPoints).toEqual(['main.go']);
    const legacy = appOf(result, 'legacy');
    expect(legacy.confidence).toBe('LOW');
    expect(legacy.frameworks).toEqual([]);
    expect(legacy.languages).toEqual(['Java']);
    expect(legacy.application.layer).toBe('BACKEND');
    expect(legacy.questions[0]).toContain('Aucun manifeste reconnu');
    expect(legacy.evidence).toEqual(['legacy : fichiers Java sans manifeste reconnu']);
    // Deux applications, aucun mot : toutes proposées.
    expect(result.applications.every((entry) => entry.suggested)).toBe(true);
  });

  it('says when nothing is recognized', async () => {
    const result = await discover(path.join(repos, 'empty'));
    expect(result.status).toBe('FAILED');
    expect(result.structure).toBe('UNKNOWN');
    expect(result.problems.map((problem) => problem.code)).toEqual(['NOTHING_RECOGNIZED']);
    expect(result.problems[0]?.hint).toContain('racine du dépôt');
  });
});

describe('an invalid or inaccessible path', () => {
  it('explains a relative path, a missing folder, a file and a protected folder, without reading anything', async () => {
    const relative = await discover('repos/front');
    expect(relative.status).toBe('FAILED');
    expect(relative.problems[0]).toMatchObject({ code: 'ROOT_RELATIVE' });
    expect(relative.problems[0]?.hint).toContain('/srv/repos/catalogue');
    const missing = await discover(path.join(repos, 'nowhere'));
    expect(missing.problems[0]).toMatchObject({ code: 'ROOT_MISSING' });
    expect(missing.problems[0]?.hint).toContain('machine qui investigue');
    const file = await discover(path.join(repos, 'front', 'package.json'));
    expect(file.problems[0]).toMatchObject({ code: 'ROOT_NOT_DIRECTORY' });
    const sensitive = await discover(path.join(repos, 'secrets', '.ssh'));
    expect(sensitive.problems[0]).toMatchObject({ code: 'ROOT_DENIED' });
    expect(sensitive.problems[0]?.hint).toContain('protégé');
    for (const result of [relative, missing, file, sensitive]) {
      expect(result.applications).toEqual([]);
      expect(result.read).toEqual([]);
    }
  });

  it('refuses when the scope forbids reading the sources', async () => {
    const root = path.join(repos, 'front');
    const probe: ScopeApplication = {
      id: 'd',
      name: 'd',
      layer: 'BACKEND',
      repository: { root, include: [] },
    };
    const policy = new ScopePolicy(
      defaultScope({ applications: [probe], permissions: { ...DEFAULT_PERMISSIONS, readSources: false } }),
    );
    const result = await discoverRepository({
      root,
      files: guardedFiles(policy),
      keywords: [],
      existing: [],
    });
    expect(result.status).toBe('FAILED');
    expect(result.problems[0]).toMatchObject({ code: 'READ_SOURCES_DENIED' });
  });
});
