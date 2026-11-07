import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel, MapCorrelation } from '../../src/sdk/core/cartography.js';
import { analyzeMaven } from '../../src/cartography/analyze-maven.js';
import { ConfigResolver, DEFAULT_VARIANT, readSpringConfig } from '../../src/cartography/config.js';
import { ContractIndex, generatedPrefix } from '../../src/cartography/correlate.js';
import type { MavenGeneration, SourceFacts } from '../../src/cartography/facts.js';
import {
  destinationOf,
  readGateways,
  routedPath,
  routeMatches,
  servicesOf,
} from '../../src/cartography/gateway.js';
import { readMetadata } from '../../src/cartography/metadata.js';
import { runScan } from '../../src/cartography/scan.js';
import { buildZip } from '../fixtures/office-builder.js';

/**
 * CONFIGURATIONS ET DÉPENDANCES. La fixture cartography-config : un frontal Angular (angular.json à trois
 * configurations, proxy JS statique et proxy JSON, fichiers environment), une passerelle Spring Cloud Gateway
 * (trois routes), un BFF (base injectée par profil, base fournie à l'exécution, propriété absente, client
 * généré réglé par un bean) et trois backends (deux exposent la même route). Les cas sans fixture lisent des
 * fichiers écrits en mémoire. Rien n'est exécuté ni téléchargé.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-config');
const ids = ['front', 'passerelle', 'bff', 'backend', 'archives', 'referentiel'] as const;
const layers = {
  front: 'FRONTEND',
  passerelle: 'OTHER',
  bff: 'BFF',
  backend: 'BACKEND',
  archives: 'BACKEND',
  referentiel: 'BACKEND',
} as const;
const config: CartographyConfig = {
  schema: 1,
  sources: ids.map((id) => ({
    id,
    name: id,
    layer: layers[id],
    path: path.join(FIXTURE, id),
    include: [],
    enabled: true,
  })),
};
let model: CartographyModel;
let facts: SourceFacts[];
const corr = (from: string): MapCorrelation | undefined => model.correlations?.find((c) => c.from === from);
const front = (method: string) => corr(`METHOD:front:DossiersService#${method}`);
const bff = (file: string, method: string) =>
  corr(`METHOD:bff:src/main/java/com/ex/bff/${file}.java#${file}.${method}`);
const codes = (c?: MapCorrelation) => c?.causes.map((x) => x.code) ?? [];
const file = (p: string, text: string) => ({ path: p, text, hash: '', bytes: text.length });

beforeAll(async () => {
  const result = await runScan({ incremental: false, allowedRoots: [FIXTURE], config });
  model = result.model;
  facts = result.facts;
}, 120_000);

describe('générations : interface absente et préfixe', () => {
  const gen = (options?: Record<string, string>, interfaceOnly?: boolean): MavenGeneration => ({
    plugin: 'openapi-generator',
    generator: 'spring',
    version: '7.5.0',
    ...(options ? { options } : {}),
    ...(interfaceOnly !== undefined ? { interfaceOnly } : {}),
    line: 1,
  });

  it('1 — interface absente avec contrat : la route est reconstruite depuis le contrat, jamais présentée comme lue', async () => {
    const root = path.resolve('tests/fixtures/cartography-contract');
    const sources = [
      ['front', 'FRONTEND'],
      ['bff', 'BFF'],
      ['backend', 'BACKEND'],
      ['contracts', 'API'],
    ] as const;
    const { model: m } = await runScan({
      incremental: false,
      allowedRoots: [root],
      config: {
        schema: 1,
        sources: sources.map(([id, layer]) => ({
          id,
          name: id,
          layer,
          path: path.join(root, id),
          include: [],
          enabled: true,
        })),
      },
    });
    const c = m.correlations?.find((x) => x.from === 'METHOD:front:DemandesService#validerDemande');
    expect(c?.status).toBe('PROBABLE');
    expect(codes(c)).toContain('GENERATED_INTERFACE_ABSENT');
    const node = m.nodes.find((n) => n.id === c?.target);
    expect(node?.detail.routeOrigin).toBe('RECONSTRUCTED');
  }, 120_000);

  it('2 — préfixe déterminable : le contrôleur, requestMappingMode=none, controller + interfaceOnly, api_interface', () => {
    expect(generatedPrefix(gen(), '/v2', ['/api'], [])).toMatchObject({
      status: 'DETERMINED',
      prefixes: ['/v2'],
    });
    expect(generatedPrefix(gen({ requestMappingMode: 'none' }), undefined, ['/api'], [])).toMatchObject({
      status: 'DETERMINED',
      prefixes: [''],
    });
    expect(
      generatedPrefix(gen({ requestMappingMode: 'controller' }, true), undefined, ['/api'], []),
    ).toMatchObject({
      status: 'DETERMINED',
      prefixes: [''],
    });
    const viaProperty = generatedPrefix(
      gen({ requestMappingMode: 'api_interface' }),
      undefined,
      ['/api'],
      [{ key: 'openapi.dossiers.base-path', value: '/v1' }],
    );
    expect(viaProperty).toMatchObject({ status: 'DETERMINED', prefixes: ['/v1'] });
    expect(viaProperty.rule).toContain('openapi.dossiers.base-path');
  });

  it('3 — préfixe indéterminé : les possibilités sont gardées, aucune n’est inventée', () => {
    const none = generatedPrefix(gen(), undefined, ['/api'], []);
    expect(none.status).toBe('UNDETERMINED');
    expect(none.prefixes).toEqual(['', '/api']);
    expect(none.rule).toContain('non déclaré');
    const two = generatedPrefix(
      gen({ requestMappingMode: 'api_interface' }),
      undefined,
      ['/api'],
      [
        { key: 'openapi.a.base-path', value: '/a' },
        { key: 'openapi.b.base-path', value: '/b' },
      ],
    );
    expect(two).toMatchObject({ status: 'UNDETERMINED', prefixes: ['/a', '/b'] });
  });
});

describe('profils et propriétés', () => {
  it('4 — plusieurs profils Maven : activation, propriétés et génération propres à chacun', () => {
    const pom = `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.ex</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
  <properties><api.version>1.0.0</api.version></properties>
  <profiles>
    <profile>
      <id>local</id>
      <activation><activeByDefault>true</activeByDefault></activation>
      <properties><api.version>1.1.0</api.version></properties>
    </profile>
    <profile>
      <id>ci</id>
      <activation><property><name>env</name><value>ci</value></property></activation>
      <properties><api.version>2.0.0</api.version></properties>
      <build><plugins><plugin>
        <groupId>org.openapitools</groupId>
        <artifactId>openapi-generator-maven-plugin</artifactId>
        <version>7.5.0</version>
        <executions><execution><id>gen-ci</id><goals><goal>generate</goal></goals><configuration>
          <inputSpec>\${project.basedir}/api-\${api.version}.yaml</inputSpec>
          <generatorName>spring</generatorName>
          <apiPackage>com.ex.api</apiPackage>
          <configOptions><requestMappingMode>none</requestMappingMode></configOptions>
        </configuration></execution></executions>
      </plugin></plugins></build>
    </profile>
  </profiles>
</project>`;
    const module = analyzeMaven([file('pom.xml', pom)]).modules[0];
    expect(module?.profiles).toEqual(['local', 'ci']);
    const local = module?.profileDetails?.find((p) => p.id === 'local');
    const ci = module?.profileDetails?.find((p) => p.id === 'ci');
    expect(local?.activation).toContain('activeByDefault');
    expect(ci?.activation).toContain('env');
    expect(ci?.properties['api.version']).toBe('2.0.0');
    // La génération du profil lit les propriétés de ce profil, jamais celles d'un autre.
    const g = module?.generations.find((x) => x.execution === 'gen-ci');
    expect(g?.profile).toBe('ci');
    // Le contrat de ce profil (api-2.0.0.yaml) n'est pas dans la source : il est dit absent, jamais remplacé.
    expect(g?.inputSpec).toBe('/api-2.0.0.yaml');
    expect(g?.spec?.unresolved).toContain('api-2.0.0.yaml');
    expect(g?.options?.requestMappingMode).toBe('none');
    expect(g?.version).toBe('7.5.0');
  });

  it('5 — profils Spring incompatibles : chacun est une variante, jamais fusionnée avec une autre', () => {
    const yml = [
      'server:',
      '  port: 8080',
      'service:',
      '  url: http://localhost:9000',
      '---',
      'spring:',
      '  config:',
      '    activate:',
      '      on-profile: aws',
      'service:',
      '  url: http://service-aws:9000',
      '---',
      'spring:',
      '  config:',
      '    activate:',
      '      on-profile: onprem',
      'server:',
      '  port: 8443',
    ].join('\n');
    const resolver = new ConfigResolver(readSpringConfig([file('src/main/resources/application.yml', yml)]));
    expect(resolver.variants()).toEqual([DEFAULT_VARIANT, 'aws', 'onprem']);
    expect(resolver.resolve('service.url', 'aws').value).toBe('http://service-aws:9000');
    // onprem ne voit jamais la valeur d'aws : il garde celle du défaut.
    expect(resolver.resolve('service.url', 'onprem').value).toBe('http://localhost:9000');
    expect(resolver.resolve('server.port', 'aws').value).toBe('8080');
    expect(resolver.resolve('server.port', 'onprem').value).toBe('8443');
    expect(resolver.alternatives('server.port').map((r) => `${r.variant}=${r.value ?? ''}`)).toEqual([
      'default=8080',
      'aws=8080',
      'onprem=8443',
    ]);
  });

  it('6 — propriété remplacée : la valeur du profil gagne, celle qu’elle remplace est gardée, et le graphe le montre', () => {
    const bffConfig = facts.find((f) => f.sourceId === 'bff')?.config;
    const resolver = new ConfigResolver(bffConfig ?? { entries: [], profiles: [] });
    const recette = resolver.resolve('backend.url', 'recette');
    expect(recette.value).toBe('http://localhost:8083');
    expect(recette.from[0]?.file).toBe('src/main/resources/application-recette.yml');
    expect(recette.overrides.map((e) => e.value)).toEqual(['http://localhost:8082']);
    expect(resolver.resolve('backend.url').value).toBe('http://localhost:8082');
    const overrides = model.configGraph?.edges.filter((e) => e.kind === 'OVERRIDES') ?? [];
    expect(overrides).toEqual([
      expect.objectContaining({
        from: 'PROFILE:bff:recette',
        to: 'PROPERTY:bff:backend.url',
        variant: 'recette',
        file: 'src/main/resources/application-recette.yml',
        line: 2,
      }),
    ]);
  });
});

describe('dépendances externes et métadonnées locales', () => {
  const bffPom = `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.ex</groupId>
  <artifactId>bff</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency><groupId>com.ex.contrats</groupId><artifactId>referentiel-api</artifactId><version>3.0.0</version></dependency>
  </dependencies>
  <build><plugins>
    <plugin>
      <artifactId>maven-dependency-plugin</artifactId>
      <executions><execution><id>contrats</id><goals><goal>unpack</goal></goals><configuration>
        <artifactItems><artifactItem>
          <groupId>com.ex.contrats</groupId><artifactId>referentiel-api</artifactId>
          <outputDirectory>\${project.build.directory}/contrats</outputDirectory>
        </artifactItem></artifactItems>
      </configuration></execution></executions>
    </plugin>
    <plugin>
      <groupId>org.openapitools</groupId>
      <artifactId>openapi-generator-maven-plugin</artifactId>
      <version>7.5.0</version>
      <executions><execution><id>client</id><goals><goal>generate</goal></goals><configuration>
        <inputSpec>\${project.build.directory}/contrats/openapi/referentiel.yaml</inputSpec>
        <generatorName>java</generatorName>
        <apiPackage>com.ex.referentiel.client.api</apiPackage>
      </configuration></execution></executions>
    </plugin>
  </plugins></build>
</project>`;
  const bffFacts: SourceFacts = {
    sourceId: 'bff',
    layer: 'BFF',
    maven: analyzeMaven([file('pom.xml', bffPom)]),
  };
  const resolve = (all: SourceFacts[]) => {
    const index = new ContractIndex(all);
    const module = bffFacts.maven?.modules[0];
    const g = module?.generations.find((x) => x.execution === 'client');
    if (!module || !g) throw new Error('fixture');
    return index.resolveSpec('bff', module, g);
  };
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qa-meta-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('7 — dépendance Maven externe absente : identifiants complets, cause précise, rien de téléchargé', () => {
    const r = resolve([bffFacts]);
    expect(r.contract).toBeUndefined();
    expect(r.causes).toEqual([
      expect.objectContaining({
        code: 'MAVEN_MODULE_MISSING',
        message: expect.stringContaining('com.ex.contrats:referentiel-api:3.0.0') as string,
      }),
    ]);
  });

  it('8 — métadonnées locales autorisées : le pom et le contrat dans le jar sont lus ; secrets et liens ignorés', async () => {
    const dir = path.join(root, 'com/ex/contrats/referentiel-api/3.0.0');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'referentiel-api-3.0.0.pom'),
      '<project><modelVersion>4.0.0</modelVersion><groupId>com.ex.contrats</groupId><artifactId>referentiel-api</artifactId><version>3.0.0</version></project>',
    );
    const contract = [
      'openapi: 3.0.1',
      'info: { title: Referentiel API, version: 3.0.0 }',
      'paths:',
      '  /codes/{code}:',
      '    get:',
      '      operationId: lireCode',
      '      responses: { "200": { description: ok } }',
    ].join('\n');
    await writeFile(
      path.join(dir, 'referentiel-api-3.0.0.jar'),
      buildZip([
        { name: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0\n' },
        { name: 'openapi/referentiel.yaml', content: contract },
      ]),
    );
    await writeFile(path.join(root, 'settings.xml'), '<settings><password>jamais-lu</password></settings>');
    await symlink(dir, path.join(root, 'lien'));
    const meta = await readMetadata('local', root);
    expect(meta.facts.sourceId).toBe('meta:local');
    expect(
      meta.facts.maven?.modules.map((m) => `${m.groupId ?? ''}:${m.artifactId}:${m.version ?? ''}`),
    ).toEqual(['com.ex.contrats:referentiel-api:3.0.0']);
    expect(meta.facts.openapi?.operations.map((o) => o.operationId)).toEqual(['lireCode']);
    expect(meta.skipped).toEqual(
      expect.arrayContaining(['settings.xml : fichier de secret non lu', 'lien : lien symbolique non suivi']),
    );
    expect(JSON.stringify(meta.facts)).not.toContain('jamais-lu');
    const r = resolve([bffFacts, meta.facts]);
    expect(r.contract?.sourceId).toBe('meta:local');
    expect(r.steps.map((s) => s.label)).toEqual([
      'artefact referentiel-api:3.0.0 → com/ex/contrats/referentiel-api/3.0.0/referentiel-api-3.0.0.jar!/openapi/referentiel.yaml (meta:local)',
    ]);
    // Une racine configurée qui ne contient pas l'artefact : la cause le dit, avec les racines consultées.
    const empty = resolve([bffFacts, { sourceId: 'meta:vide', layer: 'API' }]);
    expect(empty.causes[0]?.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(empty.causes[0]?.message).toContain('vide');
  });
});

describe('proxys Angular', () => {
  const proxies = () => facts.find((f) => f.sourceId === 'front')?.ui?.proxies ?? [];

  it('9 — proxy JSON d’une configuration : cible, réécriture, secure, variante', () => {
    expect(proxies().find((p) => p.file === 'proxy.recette.json')).toEqual({
      context: '/api',
      target: 'http://localhost:8081',
      rewrite: { pattern: '^/api', replacement: '' },
      file: 'proxy.recette.json',
      line: 2,
      variant: 'recette',
      secure: false,
    });
  });

  it('10 — proxy JS statique : constante, fonction de réécriture lue par l’arbre syntaxique, jamais exécutée', () => {
    expect(proxies().find((p) => p.file === 'proxy.conf.js' && p.context === '/api')).toEqual({
      context: '/api',
      target: 'http://localhost:8090',
      rewrite: { pattern: '^\\/api', replacement: '' },
      file: 'proxy.conf.js',
      line: 5,
      variant: 'default',
      secure: false,
      changeOrigin: true,
    });
  });

  it('11 — proxy JS dynamique : la règle reste non résolue, aucune destination n’est déduite', () => {
    expect(proxies().find((p) => p.context === '/legacy')?.dynamic).toBe('target = process.env.LEGACY_URL');
    const c = front('anciens');
    expect(c?.status).toBe('UNDEMONSTRATED');
    expect(c?.target).toBeUndefined();
    expect(codes(c)).toEqual(['PROXY_DYNAMIC']);
    expect(
      model.edges.some((e) => e.from === 'METHOD:front:DossiersService#anciens' && e.kind === 'CALLS'),
    ).toBe(false);
  });

  it('12 — réécriture de chemin : proxy puis transformation de passerelle, chaque étape prouvée', () => {
    const c = front('lire');
    expect(c).toMatchObject({
      status: 'CONFIRMED',
      target: 'API:bff:GET /dossiers/{id}',
      path: '/bff/dossiers/{param}',
    });
    const labels = c?.steps.map((s) => `${s.kind} ${s.label}`) ?? [];
    expect(labels).toContain(
      'PROXY proxy.conf.js « /api » → http://localhost:8090 ; réécriture « ^\\/api » → «  » : /dossiers/{param}',
    );
    expect(labels.find((l) => l.startsWith('GATEWAY'))).toContain(
      'PrefixPath=/bff : /dossiers/{param} → /bff/dossiers/{param}',
    );
    expect(c?.steps.find((s) => s.kind === 'PROXY')?.evidence).toMatchObject({
      file: 'proxy.conf.js',
      line: 5,
    });
  });
});

describe('passerelles', () => {
  it('13 — passerelle à plusieurs routes : la première par ordre qui correspond (méthode, chemin) est suivie', () => {
    const gatewayOf = (c?: MapCorrelation) => c?.steps.find((s) => s.kind === 'GATEWAY')?.label ?? '';
    expect(gatewayOf(front('lire'))).toContain('route dossiers-lecture');
    // POST n'est pas admis par dossiers-lecture (Method=GET) : la route par défaut (order 10) le reçoit.
    const creer = front('creer');
    expect(gatewayOf(creer)).toContain('route bff-defaut');
    expect(gatewayOf(creer)).toContain('RewritePath');
    expect(creer).toMatchObject({ status: 'CONFIRMED', target: 'API:bff:POST /dossiers' });
    expect(gatewayOf(front('rapports'))).toContain('route rapports');
    // Les routes lues, avec leur ligne propre.
    expect(
      facts.find((f) => f.sourceId === 'passerelle')?.gateway?.routes.map((r) => [r.id, r.line, r.order]),
    ).toEqual([
      ['dossiers-lecture', 10, 0],
      ['rapports', 17, 0],
      ['bff-defaut', 21, 10],
    ]);
  });

  it('13 bis — adaptateurs NGINX et Ingress : même modèle (route, transformation, destination)', () => {
    const nginx = [
      'upstream dossiers_pool { server localhost:8082; server localhost:8083; }',
      'server {',
      '  listen 8070;',
      '  location /api/ {',
      '    proxy_pass http://dossiers_pool/;',
      '  }',
      '  location /v1/ {',
      '    rewrite ^/v1/(.*)$ /api/$1 break;',
      '    proxy_pass http://localhost:8082;',
      '  }',
      '}',
    ].join('\n');
    const ingress = [
      'apiVersion: networking.k8s.io/v1',
      'kind: Ingress',
      'metadata:',
      '  name: dossiers',
      '  annotations:',
      '    nginx.ingress.kubernetes.io/rewrite-target: /$2',
      'spec:',
      '  rules:',
      '    - host: dossiers.exemple.test',
      '      http:',
      '        paths:',
      '          - path: /bff(/|$)(.*)',
      '            pathType: ImplementationSpecific',
      '            backend:',
      '              service:',
      '                name: bff',
      '                port:',
      '                  number: 8081',
    ].join('\n');
    const gw = readGateways([file('deploy/nginx.conf', nginx), file('k8s/ingress.yaml', ingress)]);
    const [api, v1, k8s] = gw?.routes ?? [];
    expect(gw?.listens).toEqual([{ port: 8070, file: 'deploy/nginx.conf', line: 3 }]);
    expect(api).toMatchObject({ adapter: 'NGINX', upstream: ['localhost:8082', 'localhost:8083'] });
    expect(api && routedPath(api, '/api/dossiers/1').path).toBe('/dossiers/1');
    expect(v1 && routedPath(v1, '/v1/dossiers/1').path).toBe('/api/dossiers/1');
    expect(k8s).toMatchObject({ adapter: 'INGRESS', uri: 'bff:8081', match: 'REGEX' });
    expect(k8s && routeMatches(k8s, 'GET', '/bff/dossiers/{id}')).toBe(true);
    expect(k8s && routedPath(k8s, '/bff/dossiers/7').path).toBe('/dossiers/7');
    // Un upstream à deux serveurs désigne deux sources : plusieurs destinations, aucune n'est choisie.
    const services = servicesOf(
      facts.map((f) => ({
        sourceId: f.sourceId,
        name: f.sourceId,
        serves: !!f.java,
        ...(f.config ? { config: f.config } : {}),
      })),
    );
    expect(destinationOf(api?.uri ?? '', services, DEFAULT_VARIANT, api?.upstream).sources.sort()).toEqual([
      'archives',
      'backend',
    ]);
    expect(destinationOf('bff:8081', services).sources).toEqual(['bff']);
  });

  it('14 — passerelle externe absente : diagnostic dans la variante, sans lien inventé', () => {
    const production = front('lire')?.variants?.find((v) => v.variant === 'production');
    expect(production?.status).toBe('UNDEMONSTRATED');
    expect(production?.target).toBeUndefined();
    expect(production?.causes.map((x) => x.code)).toContain('GATEWAY_EXTERNAL');
    expect(production?.chain).toContain('https://api.exemple.test ne désigne aucune source analysée');
  });
});

describe('clients Java', () => {
  it('15 — client Java à base injectée : la propriété résolue désigne la source, seule candidate', () => {
    const c = bff('BackendClient', 'dossier');
    expect(c).toMatchObject({ status: 'CONFIRMED', target: 'API:backend:GET /api/dossiers/{id}' });
    expect(c?.steps.filter((s) => s.kind === 'DESTINATION').map((s) => s.label)).toEqual([
      'backend.url = http://localhost:8082 (src/main/resources/application.yml:9)',
      'port 8082 = server.port de backend',
    ]);
  });

  it('16 — client généré configuré par un bean : base du bean, contrat, destination', () => {
    const c = corr('METHOD:bff:src/main/java/com/ex/bff/ReferentielService.java#ReferentielService.code');
    expect(c).toMatchObject({ status: 'PROBABLE', target: 'API:referentiel:GET /codes/{code}' });
    const labels = c?.steps.map((s) => s.label) ?? [];
    expect(labels).toContain('ApiClient réglé par un bean : base ${referentiel.url}');
    expect(labels).toContain('port 8084 = server.port de referentiel');
    expect(facts.find((f) => f.sourceId === 'bff')?.java?.clientBases).toEqual([
      {
        type: 'ApiClient',
        property: 'referentiel.url',
        loc: { file: 'src/main/java/com/ex/bff/ClientsConfig.java', line: 14 },
      },
    ]);
  });

  it('17 — URL fournie seulement à l’exécution : symbolique, jamais inventée', () => {
    const c = bff('CatalogueClient', 'items');
    expect(c?.status).toBe('UNDEMONSTRATED');
    expect(c?.target).toBeUndefined();
    expect(codes(c)[0]).toBe('DESTINATION_SYMBOLIC');
    expect(c?.causes[0]?.message).toContain('CATALOGUE_URL');
    // Même règle derrière la passerelle : la route rapports mène à ${RAPPORTS_URL}.
    expect(codes(front('rapports'))).toEqual(['DESTINATION_SYMBOLIC']);
    expect(model.configGraph?.edges.find((e) => e.to === 'ADDRESS:${RAPPORTS_URL}')?.confidence).toBe(
      'UNKNOWN',
    );
  });
});

describe('variantes et ambiguïtés', () => {
  it('18 — environnements multiples : une issue par variante, jamais fusionnée', () => {
    const c = bff('BackendClient', 'dossier');
    expect(codes(c)).toContain('ENVIRONMENT_INCONSISTENT');
    expect(c?.variants).toEqual([
      expect.objectContaining({
        variant: 'recette',
        status: 'CONFIRMED',
        target: 'API:archives:GET /api/dossiers/{id}',
        chain: expect.stringContaining('application-recette.yml:2, profil recette') as string,
      }),
    ]);
    // Le frontal : la configuration recette appelle le BFF sans son context-path, production un hôte externe.
    const lire = front('lire');
    expect(lire?.variants?.map((v) => [v.variant, v.status])).toEqual([
      ['recette', 'UNDEMONSTRATED'],
      ['production', 'UNDEMONSTRATED'],
    ]);
    expect(codes(lire)).toContain('ENVIRONMENT_INCONSISTENT');
  });

  it('19 — correspondances ambiguës : sans destination, deux endpoints identiques ne sont pas départagés', () => {
    const c = bff('PartenaireClient', 'dossier');
    expect(c?.status).toBe('UNDEMONSTRATED');
    expect(c?.target).toBeUndefined();
    expect(codes(c)).toEqual(['PROPERTY_UNRESOLVED', 'AMBIGUOUS']);
    expect(c?.candidates.map((x) => x.node).sort()).toEqual([
      'API:archives:GET /api/dossiers/{id}',
      'API:backend:GET /api/dossiers/{id}',
    ]);
  });

  it('20 — aucun faux lien entre services : la destination prouvée écarte la route identique d’un autre service', () => {
    const calls = (from: string) =>
      model.edges.filter((e) => e.from === from && e.kind === 'CALLS').map((e) => e.to);
    expect(calls('METHOD:bff:src/main/java/com/ex/bff/BackendClient.java#BackendClient.dossier')).toEqual([
      'API:backend:GET /api/dossiers/{id}',
    ]);
    expect(
      calls('METHOD:bff:src/main/java/com/ex/bff/PartenaireClient.java#PartenaireClient.dossier'),
    ).toEqual([]);
    expect(calls('METHOD:bff:src/main/java/com/ex/bff/CatalogueClient.java#CatalogueClient.items')).toEqual(
      [],
    );
    expect(calls('METHOD:front:DossiersService#lire')).toEqual(['API:bff:GET /dossiers/{id}']);
  });
});

describe('graphe de configuration et sécurité', () => {
  it('relations typées, provenance, variante, sans doublon ; aucune valeur sensible', () => {
    const g = model.configGraph;
    const keys = g?.edges.map((e) => `${e.from}|${e.to}|${e.kind}|${e.variant}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    expect([...new Set(g?.edges.map((e) => e.kind))].sort()).toEqual([
      'CONFIGURES',
      'DECLARES',
      'DEPENDS_ON',
      'GENERATES',
      'OVERRIDES',
      'REFERENCES',
      'REWRITES_TO',
      'ROUTES_TO',
    ]);
    expect(
      g?.edges.find((e) => e.kind === 'REFERENCES' && e.to === 'VARIABLE:bff:CATALOGUE_URL'),
    ).toMatchObject({
      from: 'PROPERTY:bff:catalogue.url',
      detail: 'fournie à l’exécution',
    });
    expect(g?.edges.find((e) => e.to === 'PROPERTY:bff:referentiel.token')?.detail).toBe('***');
    expect(JSON.stringify(model)).not.toContain('jeton-fictif-a-masquer');
  });
});
