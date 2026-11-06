import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel, MapCorrelation } from '../../src/sdk/core/cartography.js';
import { analyzeMaven, parseXml } from '../../src/cartography/analyze-maven.js';
import { analyzeOpenApi } from '../../src/cartography/analyze-openapi.js';
import {
  apiNamesOf,
  compareRoute,
  matchCall,
  segmentsOf,
  type Target,
} from '../../src/cartography/correlate.js';
import { buildIndex, featureDetail, type CoverageContext } from '../../src/cartography/explorer.js';
import type { SourceFacts } from '../../src/cartography/facts.js';
import { ANALYZERS, runScan } from '../../src/cartography/scan.js';

/**
 * ANGULAR → OPENAPI → BFF → BACKEND, par indices multiples. Quatre sources : un dépôt de contrats Maven
 * (parent + module, contrat YAML à références locales et vers un fichier voisin), un frontal (client
 * généré à BASE_PATH injecté, service maison, enveloppe HTTP, store RxJS, environment), un BFF contract-first
 * (interface générée absente, interface générée versionnée, implémentation indirecte, context-path, client
 * Java généré vers le Backend) et un Backend code-first (contrat produit depuis le code, autre version).
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-contract');
const configFor = (root: string): CartographyConfig => ({
  schema: 1,
  sources: [
    {
      id: 'front',
      name: 'Front',
      layer: 'FRONTEND',
      path: path.join(root, 'front'),
      include: [],
      enabled: true,
    },
    { id: 'bff', name: 'BFF', layer: 'BFF', path: path.join(root, 'bff'), include: [], enabled: true },
    {
      id: 'backend',
      name: 'Backend',
      layer: 'BACKEND',
      path: path.join(root, 'backend'),
      include: [],
      enabled: true,
    },
    {
      id: 'contracts',
      name: 'Contrats',
      layer: 'API',
      path: path.join(root, 'contracts'),
      include: [],
      enabled: true,
    },
  ],
});
let model: CartographyModel;
let facts: SourceFacts[];
const of = (id: string) => facts.find((f) => f.sourceId === id);
const corr = (from: string): MapCorrelation | undefined => model.correlations?.find((c) => c.from === from);
const front = (call: string) => corr(`METHOD:front:${call}`);
const callsFrom = (from: string) =>
  model.edges.filter(
    (e) => e.from === from && e.kind === 'CALLS' && model.nodes.find((n) => n.id === e.to)?.kind === 'API',
  );
const call = (id: string) => of('front')?.ui?.calls.find((c) => c.id === id);
const scan = (root: string) => runScan({ config: configFor(root), allowedRoots: [root], incremental: false });
/** Une copie modifiable de la fixture. */
async function variant(
  edit: (root: string) => Promise<void>,
): Promise<{ model: CartographyModel; facts: SourceFacts[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-contract-'));
  copies.push(root);
  await cp(FIXTURE, root, { recursive: true });
  await edit(root);
  return scan(root);
}
const copies: string[] = [];

beforeAll(async () => {
  ({ model, facts } = await scan(FIXTURE));
});
afterAll(async () => {
  await Promise.all(copies.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('contracts', () => {
  it('1 + 3 — a YAML contract: path-level and component parameters, a schema in a neighbour file, servers', () => {
    const ops = of('contracts')?.openapi?.operations ?? [];
    expect(ops).toHaveLength(7);
    const validate = ops.find((o) => o.operationId === 'validerDemande');
    expect(validate).toMatchObject({
      method: 'POST',
      route: '/demandes/{demandeId}/validation',
      bases: ['/api'],
      request: 'Decision',
    });
    expect(validate?.params).toEqual([{ name: 'demandeId', in: 'path', required: true, type: 'integer' }]);
    expect(validate?.extensions).toEqual({ 'x-audit': 'obligatoire' });
    expect(ops.find((o) => o.operationId === 'lireDemande')?.params?.map((p) => `${p.in}:${p.name}`)).toEqual(
      ['path:demandeId', 'query:details'],
    );
    // Le schéma référencé dans le fichier voisin est lu ; la référence vers un fichier absent est dite.
    expect(
      of('contracts')
        ?.openapi?.schemas.find((s) => s.name === 'Decision')
        ?.properties.map((p) => p.name),
    ).toEqual(['motif', 'accepte']);
    const doc = of('contracts')?.openapi?.documents?.[0];
    expect(doc?.refs).toEqual(['demandes-api/src/main/resources/openapi/schemas.yaml']);
    expect(doc?.unresolved).toEqual([
      {
        ref: './commun.yaml#/components/parameters/Id',
        cause: 'fichier absent de la source (demandes-api/src/main/resources/openapi/commun.yaml)',
      },
    ]);
  });

  it('2 — a JSON contract is read the same way', () => {
    expect(of('backend')?.openapi?.operations.map((o) => o.id)).toEqual([
      'POST /decisions',
      'GET /decisions/{id}',
    ]);
  });

  it('references are never followed outside the source or over the network', () => {
    const facts2 = analyzeOpenApi([
      {
        path: 'api.yaml',
        hash: '',
        bytes: 0,
        text: `openapi: 3.0.0
info: { title: T, version: '1' }
paths:
  /a:
    get:
      parameters:
        - $ref: 'https://example.test/params.yaml#/P'
        - $ref: '../outside.yaml#/P'
      responses: { '200': { description: ok } }
`,
      },
    ]);
    expect(facts2.documents?.[0]?.unresolved?.map((u) => u.cause)).toEqual([
      'référence distante non suivie (aucun accès réseau)',
      'fichier hors de la source analysée',
    ]);
  });

  it('a contract read by a generator is GENERATOR_INPUT, one produced from the code is PRODUCED_FROM_CODE', () => {
    const contracts = new Map(model.contracts?.map((c) => [c.file, c]));
    expect(contracts.get('demandes-api/src/main/resources/openapi/demandes.yaml')).toMatchObject({
      role: 'GENERATOR_INPUT',
      consumers: [
        {
          module: 'com.ex:demandes-bff',
          execution: 'serveur-demandes',
          generator: 'spring',
          side: 'SERVER',
          version: '2.1.0',
        },
      ],
    });
    expect(contracts.get('src/main/resources/backend-client.json')?.consumers[0]?.side).toBe('CLIENT');
    expect(contracts.get('src/main/resources/backend.json')?.role).toBe('PRODUCED_FROM_CODE');
  });
});

describe('Maven', () => {
  it('8 + 9 — modules inherit their identity from the parent; versions come from properties and dependencyManagement', () => {
    const modules = of('contracts')?.maven?.modules ?? [];
    expect(modules.map((m) => `${m.groupId}:${m.artifactId}:${m.version}`).sort()).toEqual([
      'com.ex.contrats:contrats-parent:2.1.0',
      'com.ex.contrats:demandes-api:2.1.0',
    ]);
    const bff = of('bff')?.maven?.modules[0];
    expect(bff?.dependencies.find((d) => d.artifactId === 'demandes-api')).toMatchObject({
      version: '2.1.0',
      managed: true,
    });
    expect(bff?.generations.map((g) => [g.execution, g.generator, g.apiPackage, g.spec])).toEqual([
      [
        'serveur-demandes',
        'spring',
        'com.ex.demandes.api',
        { artifact: 'demandes-api', resource: 'openapi/demandes.yaml' },
      ],
      [
        'client-backend',
        'java',
        'com.ex.backend.client.api',
        { file: 'src/main/resources/backend-client.json' },
      ],
    ]);
  });

  it('an inputSpec that is remote or not readable is said, never guessed', () => {
    const pom = (spec: string) => `<project><artifactId>m</artifactId><build><plugins><plugin>
      <artifactId>openapi-generator-maven-plugin</artifactId>
      <configuration><inputSpec>${spec}</inputSpec><generatorName>spring</generatorName></configuration>
    </plugin></plugins></build></project>`;
    const read = (spec: string) =>
      analyzeMaven([{ path: 'pom.xml', text: pom(spec), hash: '', bytes: 0 }]).modules[0]?.generations[0]
        ?.spec;
    expect(read('https://example.test/api.yaml')?.unresolved).toMatch(/contrat distant non suivi/);
    expect(read('${contract.dir}/api.yaml')?.unresolved).toMatch(/propriété non résolue/);
    expect(read('src/main/resources/missing.yaml')?.unresolved).toMatch(/fichier de contrat absent/);
    expect(
      parseXml('<project><!-- <artifactId>x</artifactId> --><artifactId><![CDATA[y]]></artifactId></project>')
        ?.children[0]?.text,
    ).toBe('y');
  });
});

describe('Java routes', () => {
  it('4 + 5 + 6 + 7 — a route declared by a committed generated interface is served by the concrete controller', () => {
    const endpoint = of('bff')?.java?.endpoints.find((e) => e.id === 'GET /dossiers/{dossierId}');
    expect(endpoint).toMatchObject({
      handlerName: 'BaseDossiersController.lireDossier',
      controller: 'DossiersController',
      via: { type: 'DossiersApi' },
    });
  });

  it('an interface generated at build time is noted as absent, with the methods that implement it', () => {
    const impl = of('bff')?.java?.implementations?.find((i) => i.controller === 'DemandesController');
    expect(impl?.missing).toEqual([{ name: 'DemandesApi', qualified: 'com.ex.demandes.api.DemandesApi' }]);
    expect(impl?.methods.map((m) => m.name)).toEqual(['validerDemande', 'lireDemande', 'archiverDemande']);
    expect(of('bff')?.java?.exposure).toEqual([
      {
        key: 'server.servlet.context-path',
        value: '/api',
        file: 'src/main/resources/application.yml',
        line: 3,
      },
    ]);
  });

  it('negative: an @Override method that no operation of the contract names gets no route', () => {
    expect(model.nodes.some((n) => n.id.startsWith('API:bff:') && n.name.includes('archiv'))).toBe(false);
    const handler = model.nodes.find((n) => n.id.endsWith('DemandesController.archiverDemande'));
    expect(handler?.detail.correlation).toMatch(/aucune opération du contrat .* operationId archiverDemande/);
  });
});

describe('Angular calls', () => {
  it('11 — a generated client: its basePath comes from the BASE_PATH provider, not from its default', () => {
    expect(call('DemandesService#validerDemande')).toMatchObject({
      method: 'POST',
      path: '/api/demandes/{param}/validation',
    });
    expect(call('DemandesService#validerDemande')?.base).toContain('this.basePath vient du jeton BASE_PATH');
  });

  it('12 + 13 — a wrapper and a template string: the base comes from every environment file that agrees', () => {
    expect(call('HistoriqueService#archiver')).toMatchObject({
      path: '/api/demandes/{param}/archive',
      via: 'ApiClient#post',
    });
    expect(call('HistoriqueService#historique')?.base).toBe(
      "environment.apiBase = '/api' (src/environments/environment.prod.ts, src/environments/environment.ts)",
    );
  });

  it('negative: environment files that disagree leave the base unknown', async () => {
    const other = await variant(async (root) => {
      await writeFile(
        path.join(root, 'front/src/environments/environment.prod.ts'),
        "export const environment = { production: true, apiBase: '/v2' };\n",
      );
    });
    const historique = other.facts
      .find((f) => f.sourceId === 'front')
      ?.ui?.calls.find((c) => c.id === 'HistoriqueService#historique');
    expect(historique?.path).toBe('{base}/{param}/historique');
    expect(historique?.base).toBeUndefined();
  });
});

describe('correlation', () => {
  it('14 + 15 + 17 — a context-path, a parameterised route and an operationId different from the Java name: confirmed', () => {
    const c = front('HistoriqueService#dossier');
    expect(c).toMatchObject({
      status: 'CONFIRMED',
      target: 'API:bff:GET /dossiers/{dossierId}',
      contract: 'API:contracts:GET /dossiers/{dossierId}',
    });
    // Le proxy (`/api` → localhost:8081) est une étape ; aucune source ne déclare ce port : rien n'est restreint.
    expect(c?.steps.map((s) => s.kind)).toEqual([
      'CALL',
      'BASE',
      'PROXY',
      'DESTINATION',
      'INTERFACE',
      'ENDPOINT',
      'CONTRACT',
    ]);
    expect(c?.steps.find((s) => s.kind === 'DESTINATION')?.label).toContain('destination indéterminée');
    expect(c?.steps.find((s) => s.kind === 'ENDPOINT')?.label).toContain(
      'préfixe server.servlet.context-path = /api',
    );
    expect(callsFrom('METHOD:front:HistoriqueService#dossier')[0]?.confidence).toBe('CONFIRMED');
  });

  it('the generated server interface is absent: the endpoint is deduced from the contract, probable, with every step', () => {
    const c = front('DemandesService#validerDemande');
    expect(c).toMatchObject({
      status: 'PROBABLE',
      target: 'API:bff:POST /demandes/{demandeId}/validation',
      contract: 'API:contracts:POST /demandes/{demandeId}/validation',
    });
    // requestMappingMode n'est pas déclaré : le préfixe de type reste indéterminé (aucun n'est inventé).
    expect(c?.causes.map((x) => x.code)).toEqual([
      'GENERATED_INTERFACE_ABSENT',
      'GENERATION_OPTIONS_INSUFFICIENT',
    ]);
    expect(c?.steps.map((s) => s.kind)).toEqual([
      'CALL',
      'BASE',
      'PROXY',
      'DESTINATION',
      'MODULE',
      'GENERATION',
      'CONTRACT',
      'INTERFACE',
      'IMPLEMENTATION',
      'ENDPOINT',
      'CONTRACT',
    ]);
    expect(c?.steps.find((s) => s.kind === 'CONTRACT')?.label).toBe(
      'artefact demandes-api:2.1.0 → demandes-api/src/main/resources/openapi/demandes.yaml (contracts)',
    );
    expect(callsFrom('METHOD:front:DemandesService#validerDemande')[0]?.confidence).toBe('PROBABLE');
  });

  it('16 — an incompatible HTTP method is said; nothing is linked', () => {
    const c = front('HistoriqueService#remplacer');
    expect(c?.status).toBe('UNDEMONSTRATED');
    expect(c?.causes[0]).toEqual({
      code: 'METHOD_MISMATCH',
      message: '/api/demandes/{param}/validation existe en POST, pas en PUT',
    });
    expect(callsFrom('METHOD:front:HistoriqueService#remplacer')).toEqual([]);
  });

  it('18 — several endpoints match a dynamic segment: none is chosen, all are listed', () => {
    const c = front('HistoriqueService#historique');
    expect(c?.status).toBe('UNDEMONSTRATED');
    expect(c?.causes[0]?.code).toBe('AMBIGUOUS');
    expect(c?.candidates.map((x) => x.path)).toEqual(
      expect.arrayContaining(['/api/demandes/historique', '/api/dossiers/historique']),
    );
    expect(c?.candidates.every((x) => x.rejected)).toBe(true);
    expect(callsFrom('METHOD:front:HistoriqueService#historique')).toEqual([]);
  });

  it('19 — a contract operation that nothing implements: said on the call and on the operation', () => {
    const c = front('HistoriqueService#rapport');
    expect(c).toMatchObject({ status: 'UNDEMONSTRATED', target: 'API:contracts:GET /rapports/{id}' });
    expect(c?.causes).toEqual([
      {
        code: 'CONTRACT_NOT_IMPLEMENTED',
        message:
          'aucun contrôleur du module com.ex:demandes-bff n’implémente lireRapport (GET /rapports/{id})',
      },
      // Le paramètre de cette opération renvoie vers un fichier absent : dit sur l'appel qui la vise.
      {
        code: 'REF_UNRESOLVED',
        message:
          'GET /rapports/{id} : références du contrat non suivies (./commun.yaml#/components/parameters/Id) — paramètres ou schémas incomplets',
      },
    ]);
    expect(
      model.nodes.find((n) => n.id === 'API:contracts:DELETE /demandes/{demandeId}/brouillon')?.detail,
    ).toMatchObject({
      implemented: false,
      implementation: 'DemandesController implémente DemandesApi sans méthode pour supprimerBrouillon',
    });
  });

  it('a call that nothing describes: no endpoint, no link', () => {
    expect(front('HistoriqueService#archiver')?.causes[0]?.code).toBe('NO_ENDPOINT');
  });

  it('10 + 20 — the BFF calls the Backend through a generated Java client; contract versions are compared', () => {
    const c = model.correlations?.find((x) => x.from.endsWith('DecisionGateway.transmettre'));
    expect(c).toMatchObject({
      status: 'PROBABLE',
      target: 'API:backend:POST /decisions',
      contract: 'API:backend:contract:POST /decisions',
    });
    expect(c?.steps.slice(0, 2).map((s) => s.kind)).toEqual(['OUTGOING', 'GENERATION']);
    expect(c?.causes).toContainEqual({
      code: 'CONTRACT_VERSION_UNKNOWN',
      message:
        'versions différentes (1.3.0 côté client, 1.4.0 côté serveur) : l’opération POST /decisions existe dans les deux',
    });
    const diff = model.contractDiffs?.find((d) => d.title === 'Backend API');
    expect(diff).toMatchObject({
      identical: false,
      removed: ['GET /decisions/legacy'],
      added: ['GET /decisions/{}'],
      changed: [],
    });
    // Un type importé qu'aucune génération cliente ne produit n'est pas un appel HTTP.
    expect(model.correlations?.some((x) => x.steps.some((s) => s.label.includes('Horloge')))).toBe(false);
  });

  it('21 — the journey through the RxJS store carries the correlation of its HTTP call', () => {
    expect(
      model.edges.some(
        (e) =>
          e.from === 'METHOD:front:DemandeStore#valider' &&
          e.to === 'METHOD:front:DemandesService#validerDemande',
      ),
    ).toBe(true);
    const cov: CoverageContext = {
      links: [],
      coverage: new Map(),
      issues: [],
      lastRuns: new Map(),
      decisions: [],
    };
    const feature = model.features.find((f) => f.name === 'Demande');
    const detail = featureDetail(buildIndex(model), cov, feature?.id ?? '');
    expect(detail?.correlations?.map((c) => c.from)).toEqual(
      expect.arrayContaining([
        'METHOD:front:DemandesService#validerDemande',
        'METHOD:bff:src/main/java/com/ex/bff/DecisionGateway.java#DecisionGateway.transmettre',
      ]),
    );
  });

  it('14 — a gateway prefix is removed only when the proxy configuration rewrites it', async () => {
    const noContext = async (root: string) =>
      writeFile(path.join(root, 'bff/src/main/resources/application.yml'), 'server:\n  port: 8081\n');
    const rewritten = await variant(async (root) => {
      await noContext(root);
      await writeFile(
        path.join(root, 'front/proxy.conf.json'),
        JSON.stringify({ '/api': { target: 'http://localhost:8081', pathRewrite: { '^/api': '' } } }),
      );
    });
    const ok = rewritten.model.correlations?.find((c) => c.from === 'METHOD:front:HistoriqueService#dossier');
    expect(ok).toMatchObject({ status: 'CONFIRMED', target: 'API:bff:GET /dossiers/{dossierId}' });
    expect(
      ok?.steps.some(
        (s) => s.kind === 'PROXY' && s.label.includes('réécriture « ^/api » → «  » : /dossiers/'),
      ),
    ).toBe(true);
    // Le port de la cible est celui du BFF : la destination est démontrée, seule cette source est candidate.
    expect(ok?.steps.find((s) => s.kind === 'DESTINATION')?.label).toBe('port 8081 = server.port de BFF');
    // Sans réécriture ni context-path, /api n'est jamais retiré pour forcer la correspondance.
    const bare = await variant(noContext);
    const no = bare.model.correlations?.find((c) => c.from === 'METHOD:front:HistoriqueService#dossier');
    expect(no?.target).not.toBe('API:bff:GET /dossiers/{dossierId}');
    expect(no?.status).toBe('UNDEMONSTRATED');
  });
});

describe('the matcher on its own (negatives)', () => {
  const t = (method: string, p: string, kind: Target['kind'] = 'SERVED'): Target => ({
    node: `${method} ${p}`,
    layer: 'BFF',
    kind,
    method,
    path: p,
    why: [],
  });
  it('a literal call and a parameter: the most literal endpoint wins; equal ones stay ambiguous', () => {
    expect(
      matchCall({ method: 'GET', path: '/a/latest', baseUnknown: false }, [
        t('GET', '/a/{id}'),
        t('GET', '/a/latest'),
      ]).target?.path,
    ).toBe('/a/latest');
    expect(
      matchCall({ method: 'GET', path: '/a/{p}', baseUnknown: false }, [
        t('GET', '/a/{id}'),
        t('GET', '/a/{key}'),
      ]).causes[0]?.code,
    ).toBe('AMBIGUOUS');
  });
  it('an unknown base compares the end of the path only, and is never confirmed', () => {
    const m = matchCall({ method: 'GET', path: '{base}/x/{p}', baseUnknown: true }, [
      t('GET', '/svc/x/{id}'),
    ]);
    expect(m).toMatchObject({ status: 'PROBABLE', how: 'SUFFIX' });
  });
  it('a different number of segments, or a missing segment, is never matched', () => {
    expect(compareRoute(segmentsOf('/api/a'), segmentsOf('/a'), false)).toBeUndefined();
    expect(
      matchCall({ method: 'GET', path: '/api/a', baseUnknown: false }, [t('GET', '/a')]).target,
    ).toBeUndefined();
  });
  it('a deduced endpoint is never confirmed', () => {
    expect(
      matchCall({ method: 'GET', path: '/a', baseUnknown: false }, [t('GET', '/a', 'INFERRED')]).status,
    ).toBe('PROBABLE');
  });
  it('interface names follow the generator: tag-based for clients, both forms for Spring without useTags', () => {
    const op = {
      id: 'GET /dossiers/{id}',
      method: 'GET',
      path: '/dossiers/{id}',
      route: '/dossiers/{id}',
      tags: ['Archives'],
      loc: { file: '', line: 1 },
    };
    expect([...apiNamesOf(op, { plugin: 'openapi-generator', generator: 'java', line: 1 })]).toEqual([
      'ArchivesApi',
    ]);
    expect([...apiNamesOf(op, { plugin: 'openapi-generator', generator: 'spring', line: 1 })].sort()).toEqual(
      ['ArchivesApi', 'DossiersApi'],
    );
    expect([
      ...apiNamesOf(op, { plugin: 'openapi-generator', generator: 'spring', useTags: true, line: 1 }),
    ]).toEqual(['ArchivesApi']);
  });
});

describe('22 — incremental scans after an analyser change', () => {
  it('facts written by an older analyser are read again; the new facts carry the current version', async () => {
    expect(facts.every((f) => f.analyzer === ANALYZERS)).toBe(true);
    expect(Number(/cartography-(\d+)/.exec(ANALYZERS)?.[1])).toBeGreaterThanOrEqual(5);
    const older = facts.map((f) => ({ ...f, analyzer: 'cartography-4;rxjs-3' }));
    const again = await runScan({
      config: configFor(FIXTURE),
      allowedRoots: [FIXTURE],
      incremental: true,
      previous: { facts: older, sources: model.scan.sources },
    });
    expect(again.model.scan.sources.map((s) => s.state)).toEqual([
      'SCANNED',
      'SCANNED',
      'SCANNED',
      'SCANNED',
    ]);
    const reused = await runScan({
      config: configFor(FIXTURE),
      allowedRoots: [FIXTURE],
      incremental: true,
      previous: { facts: again.facts, sources: again.model.scan.sources },
    });
    expect(reused.model.scan.sources.map((s) => s.state)).toEqual(['REUSED', 'REUSED', 'REUSED', 'REUSED']);
    expect(reused.model.correlations?.length).toBe(model.correlations?.length);
    expect(await readFile(path.join(FIXTURE, 'bff/src/main/resources/application.yml'), 'utf8')).toContain(
      'context-path',
    );
  });
});
