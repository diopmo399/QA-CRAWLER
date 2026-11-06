import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyModel, MavenArtifactStatus } from '../../src/sdk/core/cartography.js';
import { runScan } from '../../src/cartography/scan.js';
import { resolveContracts, type MavenOptions } from '../../src/cartography/maven-resolve.js';
import { readClassFile, methodTypes } from '../../src/cartography/classfile.js';
import { analyzeJava } from '../../src/cartography/analyze-java.js';
import { parseJava } from '../../src/incident/code/java-parser.js';
import { openZip } from '../../src/requirements/connectors/zip.js';
import type { ReadFile } from '../../src/cartography/files.js';
import { parseSdkServerArgs } from '../../src/cli/sdk-server-command.js';
import { startSdkServer } from '../../src/sdk/server/server.js';

/**
 * Contrats d'API portés par des dépendances Maven : un contrôleur implémente une interface absente des sources,
 * annotée seulement dans un jar (sources ou classes compilées). La fixture `maven-contracts` (rebâtie par
 * `build/build.sh`) a un dépôt local (`m2/`) et un dépôt distant de test (`remote/`, servi ici en HTTP de
 * boucle, avec authentification) ; aucun service externe n'est contacté.
 *
 * - BFF : orders-api 1.0.0 (version du BOM importé, jar de sources), common-api (dépendance de dépendance,
 *   version tirée d'une propriété du parent), orders-client (dépôt distant, interface @HttpExchange),
 *   missing-api (introuvable) ; un homonyme `com.acme.legacy.api.OrdersApi`.
 * - Backend : orders-api 2.0.0 (propriété du parent lu dans le dépôt, classes compilées seulement).
 * - Front : trois appels servis par le BFF, un négatif (`/archive`).
 */
const F = path.resolve('tests/fixtures/maven-contracts');
const M2 = path.join(F, 'm2');
const SECRET = 's3cret-pa55';
const AUTH = `Basic ${Buffer.from(`reader:${SECRET}`).toString('base64')}`;

interface TestRepo {
  url: string;
  hits: string[];
  close: () => Promise<void>;
}
/** Le dépôt distant de test : `remote/` servi en HTTP de boucle, Basic exigé ; `slow` : chemins retardés. */
async function serveRemote(slow?: RegExp): Promise<TestRepo> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    hits.push(url);
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401).end();
      return;
    }
    const send = (): void => {
      readFile(path.join(F, 'remote', decodeURIComponent(url)))
        .then((data) => res.writeHead(200, { 'content-length': data.length }).end(data))
        .catch(() => res.writeHead(404).end());
    };
    if (slow?.test(url)) setTimeout(send, 1500);
    else send();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

const remoteOf = (repo: TestRepo): MavenOptions['remote'] => [
  { id: 'test-repo', url: repo.url, usernameEnv: 'TEST_REPO_USER', passwordEnv: 'TEST_REPO_PASS' },
];
const ENV = { TEST_REPO_USER: 'reader', TEST_REPO_PASS: SECRET };

const SOURCES = (['front', 'bff', 'backend'] as const).map((id) => ({
  id,
  name: id,
  layer: id === 'front' ? ('FRONTEND' as const) : id === 'bff' ? ('BFF' as const) : ('BACKEND' as const),
  path: path.join(F, 'apps', id),
  include: [],
  enabled: true,
}));
async function scan(maven: MavenOptions | undefined): Promise<CartographyModel> {
  const { model } = await runScan({
    config: { schema: 1, sources: SOURCES } as never,
    allowedRoots: [F],
    incremental: false,
    ...(maven ? { maven } : {}),
  });
  return model;
}
const deps = (model: CartographyModel, source: string): MavenArtifactStatus[] =>
  model.scan.sources.find((s) => s.sourceId === source)?.dependencies ?? [];
const dep = (model: CartographyModel, source: string, artifact: string): MavenArtifactStatus | undefined =>
  deps(model, source).find((d) => d.coordinates.split(':')[1] === artifact);
const apis = (model: CartographyModel, source: string): string[] =>
  model.nodes
    .filter((n) => n.kind === 'API' && n.id.startsWith(`API:${source}:`))
    .map((n) => n.id.slice(`API:${source}:`.length))
    .sort();
const correlation = (model: CartographyModel, method: string, pathPrefix: string) =>
  model.correlations?.find((c) => c.method === method && c.path.startsWith(pathPrefix));
const pomText = (dependencies: string): ReadFile => {
  const text = `<project><modelVersion>4.0.0</modelVersion><groupId>com.test</groupId><artifactId>app</artifactId><version>1.0.0</version><dependencies>${dependencies}</dependencies></project>`;
  return { path: 'pom.xml', text, hash: createHash('sha1').update(text).digest('hex'), bytes: text.length };
};
const dependency = (g: string, a: string, v: string, extra = ''): string =>
  `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version>${extra}</dependency>`;

let workRoot: string;
beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), 'qa-maven-contracts-'));
});
afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});
const cacheDir = async (): Promise<string> => mkdtemp(path.join(workRoot, 'cache-'));

describe('contrats Maven : sans résolution (état de départ)', () => {
  it('sans jar lu, un contrôleur qui implémente une interface externe n’expose aucun endpoint', async () => {
    const model = await scan(undefined);
    expect(apis(model, 'bff')).toEqual([]);
    expect(apis(model, 'backend')).toEqual([]);
    expect(correlation(model, 'GET', '/api/orders/')?.status).not.toBe('CONFIRMED');
  });
});

describe('contrats Maven : dépôt local et dépôt distant de test', () => {
  let model: CartographyModel;
  let repo: TestRepo;
  let cache: string;
  beforeAll(async () => {
    repo = await serveRemote();
    cache = await cacheDir();
    model = await scan({
      local: [M2],
      remote: remoteOf(repo),
      cacheDir: cache,
      allowLoopbackHttp: true,
      env: ENV,
    });
  });
  afterAll(async () => repo.close());

  it('1. le BFF expose les routes de son contrat (version du BOM importé, jar de sources)', () => {
    expect(apis(model, 'bff')).toEqual([
      'GET /api/orders/health',
      'GET /api/orders/search',
      'GET /api/orders/search/page',
      'GET /api/orders/{id}',
      'GET /legacy/orders/{id}',
      'POST /api/orders',
    ]);
    const api = dep(model, 'bff', 'orders-api');
    expect(api).toMatchObject({
      coordinates: 'com.acme:orders-api:1.0.0',
      state: 'RESOLVED',
      origin: 'LOCAL',
    });
    expect(api?.read).toContain('SOURCES_JAR');
    expect(api?.types).toEqual(expect.arrayContaining(['com.acme.orders.api.OrdersApi']));
    // La provenance : le fichier du jar de sources.
    const node = model.nodes.find((n) => n.id === 'API:bff:GET /api/orders/{id}');
    expect(node?.evidence.map((e) => e.file)).toContain(
      'com.acme:orders-api:1.0.0!/com/acme/orders/api/OrdersApi.java',
    );
  });

  it('2 et 11. le Backend a son propre contrat, dans une autre version (propriété du parent du dépôt)', () => {
    expect(apis(model, 'backend')).toEqual([
      'DELETE /api/v2/orders/{id}',
      'GET /api/v2/orders/{id}',
      'PUT /api/v2/orders/{id}',
    ]);
    expect(dep(model, 'backend', 'orders-api')?.coordinates).toBe('com.acme:orders-api:2.0.0');
    expect(dep(model, 'bff', 'orders-api')?.coordinates).toBe('com.acme:orders-api:1.0.0');
    // Rien du contrat 1.0.0 ne fuit dans le Backend, ni l’inverse.
    expect(apis(model, 'backend').some((a) => a.includes('/api/orders'))).toBe(false);
    expect(apis(model, 'bff').some((a) => a.includes('/api/v2/'))).toBe(false);
  });

  it('3, 4 et 6. annotations sur l’interface compilée seulement, contrôleur sans annotation répétée', () => {
    const backend = dep(model, 'backend', 'orders-api');
    expect(backend?.read).toEqual(['POM', 'CLASS']);
    const node = model.nodes.find((n) => n.id === 'API:backend:PUT /api/v2/orders/{id}');
    expect(node?.detail).toMatchObject({ controller: 'OrdersBackendController', declaredBy: 'OrdersApi' });
    expect(node?.evidence.map((e) => e.file)).toContain(
      'com.acme:orders-api:2.0.0!/com/acme/orders/api/OrdersApi.class',
    );
  });

  it('5 et 7. jar de sources lu depuis le dépôt local ; dépendance de dépendance lue en classes', () => {
    expect(dep(model, 'bff', 'orders-api')?.read).toEqual(['POM', 'SOURCES_JAR']);
    expect(dep(model, 'bff', 'common-api')).toMatchObject({
      coordinates: 'com.acme:common-api:1.0.0',
      depth: 2,
      requestedBy: 'com.acme:orders-api:1.0.0',
      origin: 'LOCAL',
      read: ['POM', 'CLASS'],
      types: ['com.acme.common.api.HealthApi'],
    });
    // Ni la dépendance de test ni l’optionnelle du contrat ne sont suivies.
    expect(dep(model, 'bff', 'test-kit')).toBeUndefined();
    expect(dep(model, 'bff', 'optional-extras')).toBeUndefined();
  });

  it('8. un artefact absent des dépôts locaux est téléchargé du dépôt autorisé, empreinte vérifiée', () => {
    const client = dep(model, 'bff', 'orders-client');
    expect(client).toMatchObject({ state: 'RESOLVED', origin: 'REMOTE', repository: 'test-repo' });
    expect(client?.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.hits).toContain('/com/acme/orders-client/1.0.0/orders-client-1.0.0.jar.sha1');
    // Aucun jar déjà présent localement n’est demandé au dépôt distant.
    expect(repo.hits.some((h) => h.includes('/orders-api/'))).toBe(false);
  });

  it('10. une dépendance introuvable est signalée, sans être tenue pour résolue', () => {
    expect(dep(model, 'bff', 'missing-api')).toMatchObject({
      coordinates: 'com.acme:missing-api:9.9.9',
      state: 'NOT_FOUND',
    });
    expect(dep(model, 'bff', 'spring-boot-starter-web')?.state).toBe('LIBRARY');
  });

  it('12. méthodes surchargées et route héritée d’une interface parente (autre jar)', () => {
    expect(apis(model, 'bff')).toEqual(
      expect.arrayContaining([
        'GET /api/orders/search',
        'GET /api/orders/search/page',
        'GET /api/orders/health',
      ]),
    );
    const health = model.nodes.find((n) => n.id === 'API:bff:GET /api/orders/health');
    expect(health?.detail).toMatchObject({ declaredBy: 'HealthApi', controller: 'OrdersBffController' });
  });

  it('13. deux interfaces homonymes de paquets différents restent séparées', () => {
    const legacy = model.nodes.find((n) => n.id === 'API:bff:GET /legacy/orders/{id}');
    expect(legacy?.detail).toMatchObject({ controller: 'LegacyController' });
    const orders = model.nodes.find((n) => n.id === 'API:bff:GET /api/orders/{id}');
    expect(orders?.detail).toMatchObject({ controller: 'OrdersBffController' });
  });

  it('14. BFF → Backend : appel par l’interface du client distant, probable car l’adresse n’est pas lue', () => {
    const corr = correlation(model, 'GET', '/api/v2/orders/');
    expect(corr).toMatchObject({ status: 'PROBABLE', target: 'API:backend:GET /api/v2/orders/{id}' });
    const edge = model.edges.find(
      (e) =>
        e.kind === 'CALLS' &&
        e.from.endsWith('OrdersBffController.getOrder') &&
        e.to.startsWith('API:backend:'),
    );
    expect(edge?.confidence).toBe('PROBABLE');
  });

  it('15 et 16. Front → BFF confirmé ; aucun lien inventé', () => {
    expect(correlation(model, 'GET', '/api/orders/{')).toMatchObject({
      status: 'CONFIRMED',
      target: 'API:bff:GET /api/orders/{id}',
    });
    expect(correlation(model, 'POST', '/api/orders')?.target).toBe('API:bff:POST /api/orders');
    expect(correlation(model, 'GET', '/api/orders/search')?.target).toBe('API:bff:GET /api/orders/search');
    const archive = correlation(model, 'POST', '/api/orders/{param}/archive');
    expect(archive?.status).toBe('UNDEMONSTRATED');
    expect(archive?.target).toBeUndefined();
    // Le Front ne joint jamais le Backend (autre version de contrat), ni la route homonyme.
    const frontTargets = (model.correlations ?? [])
      .filter((c) => c.from.includes(':front:'))
      .map((c) => c.target ?? '');
    expect(frontTargets.some((t) => t.startsWith('API:backend:') || t.includes('/legacy/'))).toBe(false);
  });

  it('aucun identifiant du dépôt n’apparaît dans le modèle', () => {
    const json = JSON.stringify(model);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(AUTH.slice('Basic '.length));
    expect(json).not.toContain(repo.url);
  });

  it('17. une seconde analyse réutilise le cache : aucun jar retéléchargé', async () => {
    const before = repo.hits.length;
    const again = await scan({
      local: [M2],
      remote: remoteOf(repo),
      cacheDir: cache,
      allowLoopbackHttp: true,
      env: ENV,
    });
    const newHits = repo.hits.slice(before);
    expect(dep(again, 'bff', 'orders-client')).toMatchObject({ state: 'RESOLVED', origin: 'CACHE' });
    expect(newHits.filter((h) => h.includes('/orders-client/'))).toEqual([]);
    expect(apis(again, 'bff')).toEqual(apis(model, 'bff'));
  });
});

describe('contrats Maven : modes et refus', () => {
  it('9. hors ligne : aucun dépôt contacté, les dépôts locaux et le cache restent lus', async () => {
    const repo = await serveRemote();
    try {
      const model = await scan({
        local: [M2],
        remote: remoteOf(repo),
        cacheDir: await cacheDir(),
        offline: true,
        allowLoopbackHttp: true,
        env: ENV,
      });
      expect(repo.hits).toEqual([]);
      expect(dep(model, 'bff', 'orders-client')?.state).toBe('OFFLINE');
      expect(dep(model, 'bff', 'orders-api')?.state).toBe('RESOLVED');
      expect(apis(model, 'bff')).toContain('GET /api/orders/{id}');
      // Sans le client, l’appel BFF → Backend n’est pas reconstruit (aucune relation inventée).
      expect(correlation(model, 'GET', '/api/v2/orders/')).toBeUndefined();
      expect(model.scan.sources.find((s) => s.sourceId === 'bff')?.unresolvedTypes).toContain(
        'com.acme.orders.client.OrdersBackendClient',
      );
    } finally {
      await repo.close();
    }
  });

  it('identifiants refusés : DENIED, rien n’est gardé dans le cache, le secret n’est pas affiché', async () => {
    const repo = await serveRemote();
    try {
      const cache = await cacheDir();
      const model = await scan({
        local: [M2],
        remote: remoteOf(repo),
        cacheDir: cache,
        allowLoopbackHttp: true,
        env: { TEST_REPO_USER: 'reader', TEST_REPO_PASS: 'wrong-password' },
      });
      const client = dep(model, 'bff', 'orders-client');
      expect(client?.state).toBe('DENIED');
      expect(client?.note).toContain('401');
      expect(JSON.stringify(model)).not.toContain('wrong-password');
      const cached = await readFile(
        path.join(cache, 'com/acme/orders-client/1.0.0/orders-client-1.0.0.pom'),
      ).catch(() => undefined);
      expect(cached).toBeUndefined();
    } finally {
      await repo.close();
    }
  });

  it('variable d’identifiants absente : aucune requête sans authentification', async () => {
    const repo = await serveRemote();
    try {
      const model = await scan({
        local: [M2],
        remote: remoteOf(repo),
        cacheDir: await cacheDir(),
        allowLoopbackHttp: true,
        env: {},
      });
      expect(repo.hits).toEqual([]);
      expect(dep(model, 'bff', 'orders-client')?.state).toBe('DENIED');
    } finally {
      await repo.close();
    }
  });

  it('seul https est accepté vers un hôte qui n’est pas l’adresse de boucle', async () => {
    const calls: string[] = [];
    const fetchSpy = ((input: URL | RequestInfo) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch;
    const result = await resolveContracts({
      sourceId: 'bff',
      poms: [pomText(dependency('com.acme', 'orders-client', '1.0.0'))],
      needed: ['com.acme.orders.client.OrdersBackendClient'],
      known: new Set(),
      options: {
        local: [],
        remote: [{ id: 'plain', url: 'http://repo.example.test/maven2' }],
        cacheDir: await cacheDir(),
        allowLoopbackHttp: true,
        fetch: fetchSpy,
      },
    });
    expect(calls).toEqual([]);
    expect(result.artifacts[0]).toMatchObject({ state: 'DENIED' });
    expect(result.artifacts[0]?.note).toContain('https');
  });

  it('empreinte SHA-1 publiée différente : le jar est refusé et n’est pas gardé', async () => {
    const repo = await serveRemote();
    try {
      const cache = await cacheDir();
      const result = await resolveContracts({
        sourceId: 'app',
        poms: [pomText(dependency('com.acme', 'tampered', '1.0.0'))],
        needed: ['com.acme.tampered.TamperedApi'],
        known: new Set(),
        options: { local: [], remote: remoteOf(repo), cacheDir: cache, allowLoopbackHttp: true, env: ENV },
      });
      expect(result.artifacts[0]).toMatchObject({
        coordinates: 'com.acme:tampered:1.0.0',
        state: 'INTEGRITY',
      });
      expect(result.external).toEqual([]);
      expect(result.unresolved).toEqual(['com.acme.tampered.TamperedApi']);
      const kept = await readFile(path.join(cache, 'com/acme/tampered/1.0.0/tampered-1.0.0.jar')).catch(
        () => undefined,
      );
      expect(kept).toBeUndefined();
    } finally {
      await repo.close();
    }
  });

  it('la plus proche l’emporte, l’autre version est notée en conflit ; exclusions suivies', async () => {
    const options: MavenOptions = { local: [M2], remote: [] };
    const nearest = await resolveContracts({
      sourceId: 'app',
      poms: [
        pomText(
          dependency('com.acme', 'common-api', '0.9.0') + dependency('com.acme', 'orders-api', '1.0.0'),
        ),
      ],
      needed: ['com.acme.orders.api.OrdersApi'],
      known: new Set(),
      options,
    });
    const common = nearest.artifacts.find((a) => a.coordinates.startsWith('com.acme:common-api'));
    expect(common).toMatchObject({
      coordinates: 'com.acme:common-api:0.9.0',
      state: 'NOT_FOUND',
      conflicts: ['1.0.0'],
    });
    // La route héritée (HealthApi) n’est pas lue : sa version retenue est introuvable.
    expect(nearest.unresolved).toEqual(['com.acme.common.api.HealthApi']);

    const excluded = await resolveContracts({
      sourceId: 'app',
      poms: [
        pomText(
          dependency(
            'com.acme',
            'orders-api',
            '1.0.0',
            '<exclusions><exclusion><groupId>com.acme</groupId><artifactId>common-api</artifactId></exclusion></exclusions>',
          ),
        ),
      ],
      needed: ['com.acme.orders.api.OrdersApi'],
      known: new Set(),
      options,
    });
    expect(excluded.artifacts.map((a) => a.coordinates)).toEqual(['com.acme:orders-api:1.0.0']);
    expect(excluded.unresolved).toEqual(['com.acme.common.api.HealthApi']);
  });

  it('un type des sources n’est jamais remplacé par celui d’un jar', async () => {
    const result = await resolveContracts({
      sourceId: 'app',
      poms: [pomText(dependency('com.acme', 'orders-api', '2.0.0'))],
      needed: ['com.acme.orders.api.OrdersApi'],
      known: new Set(['com.acme.orders.api.OrdersApi']),
      options: { local: [M2], remote: [] },
    });
    expect(result.external).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe('contrats Maven : limites', () => {
  it('18a. taille maximale : un fichier trop gros n’est ni lu ni téléchargé en entier', async () => {
    const repo = await serveRemote();
    try {
      const result = await resolveContracts({
        sourceId: 'bff',
        poms: [pomText(dependency('com.acme', 'orders-client', '1.0.0'))],
        needed: ['com.acme.orders.client.OrdersBackendClient'],
        known: new Set(),
        options: {
          local: [],
          remote: remoteOf(repo),
          cacheDir: await cacheDir(),
          allowLoopbackHttp: true,
          env: ENV,
          limits: { maxFileBytes: 600 },
        },
      });
      expect(result.artifacts[0]).toMatchObject({
        coordinates: 'com.acme:orders-client:1.0.0',
        state: 'TOO_LARGE',
      });
      expect(result.external).toEqual([]);
    } finally {
      await repo.close();
    }
  });

  it('18b. nombre de jars ouverts limité : les suivants sont notés « budget »', async () => {
    const result = await resolveContracts({
      sourceId: 'bff',
      poms: [pomText(dependency('com.acme', 'orders-api', '1.0.0'))],
      needed: ['com.acme.orders.api.OrdersApi'],
      known: new Set(),
      options: { local: [M2], remote: [], limits: { maxJars: 1 } },
    });
    expect(result.external.map((e) => e.artifact)).toEqual(['com.acme:orders-api:1.0.0']);
    expect(result.unresolved).toEqual(['com.acme.common.api.HealthApi']);
    expect(result.artifacts.find((a) => a.coordinates.startsWith('com.acme:common-api'))?.note).toContain(
      'budget',
    );
  });

  it('18c. délai d’une requête et durée totale bornés', async () => {
    const repo = await serveRemote(/orders-client-1\.0\.0\.pom$/);
    try {
      const started = Date.now();
      const slow = await resolveContracts({
        sourceId: 'bff',
        poms: [pomText(dependency('com.acme', 'orders-client', '1.0.0'))],
        needed: ['com.acme.orders.client.OrdersBackendClient'],
        known: new Set(),
        options: {
          local: [],
          remote: remoteOf(repo),
          cacheDir: await cacheDir(),
          allowLoopbackHttp: true,
          env: ENV,
          limits: { requestTimeoutMs: 200 },
        },
      });
      expect(Date.now() - started).toBeLessThan(1400);
      expect(slow.artifacts[0]).toMatchObject({ state: 'ERROR' });
      expect(slow.artifacts[0]?.note).toContain('délai');

      const expired = await resolveContracts({
        sourceId: 'bff',
        poms: [pomText(dependency('com.acme', 'orders-api', '1.0.0'))],
        needed: ['com.acme.orders.api.OrdersApi'],
        known: new Set(),
        options: { local: [M2], remote: [], limits: { maxDurationMs: -1 } },
      });
      expect(expired.artifacts[0]).toMatchObject({ state: 'BUDGET' });
      expect(expired.external).toEqual([]);
    } finally {
      await repo.close();
    }
  });
});

describe('lecture du bytecode (sans chargement de classe)', () => {
  const jar = openZip(readFileSync(path.join(M2, 'com/acme/orders-api/2.0.0/orders-api-2.0.0.jar')));
  it('lit une interface, ses annotations de type, de méthode et de paramètre', () => {
    const data = jar.bytes('com/acme/orders/api/OrdersApi.class');
    expect(data).toBeDefined();
    const { decl, internalName } = readClassFile(data ?? new Uint8Array());
    expect(internalName).toBe('com/acme/orders/api/OrdersApi');
    expect(decl).toMatchObject({
      kind: 'interface',
      name: 'OrdersApi',
      qualifiedName: 'com.acme.orders.api.OrdersApi',
    });
    expect(decl.annotations.map((a) => a.text)).toEqual(['@RequestMapping(value = "/api/v2/orders")']);
    const update = decl.methods.find((m) => m.name === 'updateOrder');
    expect(update?.annotations.map((a) => a.text)).toEqual(['@PutMapping(value = "/{id}")']);
    expect(update?.params.map((p) => [p.type.text, p.annotations.map((a) => a.name)])).toEqual([
      ['java.lang.String', ['PathVariable']],
      ['com.acme.orders.api.OrderDto', ['RequestBody']],
    ]);
  });
  it('les noms de paramètres viennent de MethodParameters quand le jar les porte', () => {
    const v1 = openZip(readFileSync(path.join(M2, 'com/acme/orders-api/1.0.0/orders-api-1.0.0.jar')));
    const { decl } = readClassFile(v1.bytes('com/acme/orders/api/OrdersApi.class') ?? new Uint8Array());
    expect(decl.methods.find((m) => m.name === 'getOrder')?.params.map((p) => p.name)).toEqual(['id']);
  });
  it('décode les descripteurs (tableaux, génériques effacés, primitifs)', () => {
    const types = methodTypes('(Ljava/lang/String;[IJ)Ljava/util/List;');
    expect(types.params.map((t) => [t.text, t.name, t.array])).toEqual([
      ['java.lang.String', 'String', false],
      ['int[]', 'int', true],
      ['long', 'long', false],
    ]);
    expect(types.returns.text).toBe('java.util.List');
  });
  it('refuse un fichier qui n’est pas une classe', () => {
    expect(() => readClassFile(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe('client Feign déclaré dans un jar de contrat', () => {
  const controller = (client: string): ReadFile => {
    const text = `package com.x.bff;\nimport com.x.client.${client};\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class StockController {\n  private final ${client} stock;\n  StockController(${client} stock) { this.stock = stock; }\n  @GetMapping("/stock/{sku}") public String get(@PathVariable String sku) { return stock.level(sku); }\n}\n`;
    return { path: 'src/main/java/com/x/bff/StockController.java', text, hash: 'h', bytes: text.length };
  };
  const external = (source: string) => ({
    file: 'com.x:stock-client:1.0.0!/com/x/client/StockClient.java',
    java: parseJava(source),
    artifact: 'com.x:stock-client:1.0.0',
    read: 'SOURCES_JAR' as const,
  });
  it('adresse lue dans une propriété : appel sortant résolu, préfixe `path` compris', () => {
    const facts = analyzeJava(
      'bff',
      'BFF',
      [controller('StockClient')],
      [
        external(
          'package com.x.client;\nimport org.springframework.cloud.openfeign.FeignClient;\nimport org.springframework.web.bind.annotation.*;\n@FeignClient(name = "stock", url = "${stock.url}", path = "/inventory")\npublic interface StockClient { @GetMapping("/levels/{sku}") String level(@PathVariable("sku") String sku); }\n',
        ),
      ],
    );
    const out = facts.outgoing.find((o) => o.from.endsWith('StockController.get'));
    expect(out).toMatchObject({ method: 'GET', path: '/inventory/levels/{sku}', properties: ['stock.url'] });
    expect(out?.addressUnknown).toBeUndefined();
    expect(out?.client).toContain('com.x:stock-client:1.0.0');
  });
  it('sans adresse lue : l’appel est gardé, marqué « adresse inconnue »', () => {
    const facts = analyzeJava(
      'bff',
      'BFF',
      [controller('StockClient')],
      [
        external(
          'package com.x.client;\nimport org.springframework.cloud.openfeign.FeignClient;\nimport org.springframework.web.bind.annotation.*;\n@FeignClient(name = "stock")\npublic interface StockClient { @GetMapping("/levels/{sku}") String level(@PathVariable("sku") String sku); }\n',
        ),
      ],
    );
    const out = facts.outgoing.find((o) => o.from.endsWith('StockController.get'));
    expect(out).toMatchObject({ method: 'GET', path: '/levels/{sku}', addressUnknown: true });
  });
  it('une interface du jar sans annotation HTTP ne produit aucun appel sortant', () => {
    const facts = analyzeJava(
      'bff',
      'BFF',
      [controller('StockClient')],
      [external('package com.x.client;\npublic interface StockClient { String level(String sku); }\n')],
    );
    expect(facts.outgoing.filter((o) => o.from.endsWith('StockController.get'))).toEqual([]);
  });
});

describe('réglage du serveur et de la ligne de commande', () => {
  it('désactivé par défaut ; dépôts, identifiants par nom de variable, hors ligne', () => {
    expect(parseSdkServerArgs(['--workspace', 'w']).maven).toBeUndefined();
    const args = parseSdkServerArgs([
      '--workspace',
      'w',
      '--maven-repo',
      'm2',
      '--maven-remote',
      'corp=https://repo.example.test/maven2',
      '--maven-auth',
      'corp=QA_MAVEN_USER:QA_MAVEN_PASS',
      '--maven-offline',
    ]);
    expect(args.maven).toEqual({
      localRepositories: [path.resolve('m2')],
      remotes: [
        {
          id: 'corp',
          url: 'https://repo.example.test/maven2',
          usernameEnv: 'QA_MAVEN_USER',
          passwordEnv: 'QA_MAVEN_PASS',
        },
      ],
      offline: true,
    });
    expect(
      parseSdkServerArgs([
        '--workspace',
        'w',
        '--maven-remote',
        'corp=https://repo.example.test',
        '--maven-auth',
        'corp=token:QA_MAVEN_TOKEN',
      ]).maven?.remotes?.[0]?.tokenEnv,
    ).toBe('QA_MAVEN_TOKEN');
  });
  it('refuse http, un dépôt inconnu pour --maven-auth et --maven-offline sans dépôt', () => {
    expect(() =>
      parseSdkServerArgs(['--workspace', 'w', '--maven-remote', 'x=http://repo.example.test']),
    ).toThrow('--maven-remote');
    expect(() =>
      parseSdkServerArgs(['--workspace', 'w', '--maven-repo', 'm2', '--maven-auth', 'other=A_USER:A_PASS']),
    ).toThrow('--maven-auth');
    expect(() => parseSdkServerArgs(['--workspace', 'w', '--maven-offline'])).toThrow('--maven-offline');
  });
  it('le serveur refuse une variable d’identifiants hors des noms autorisés', async () => {
    await expect(
      startSdkServer({
        workspace: await cacheDir(),
        port: 0,
        mavenContracts: {
          localRepositories: [M2],
          remotes: [{ id: 'corp', url: 'https://repo.example.test', tokenEnv: 'HOME' }],
        },
      }),
    ).rejects.toThrow('does not match the allowed names');
  });
});
