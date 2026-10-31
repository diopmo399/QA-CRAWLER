import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeIndex, CodeSymbol, InvestigationScope } from '../../src/incident/model.js';
import {
  analyzeCode,
  matchEndpoint,
  normalizePath,
  resolveCalls,
  type GuardedFiles,
} from '../../src/incident/code/index.js';
import { guardedFiles } from '../../src/incident/guarded-fs.js';
import { ScopePolicy } from '../../src/incident/scope-policy.js';
import { defaultScope } from '../../src/incident/scope.js';

/**
 * LE CODE INVESTIGATION ENGINE de bout en bout sur l'application fictive du catalogue (frontend,
 * BFF, backend), lue à travers le vrai Scope Policy Engine : chaîne d'appels reliée avec des statuts
 * honnêtes, endpoints appariés, refus et limites du périmètre remontés dans l'index.
 */

const FIXTURE = path.resolve('tests/fixtures/incident-app');
let workspace: string;
let outside: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-code-'));
  outside = await mkdtemp(path.join(tmpdir(), 'incident-code-outside-'));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function fixtureScope(partial: Partial<InvestigationScope> = {}): InvestigationScope {
  return defaultScope({
    applications: [
      {
        id: 'web',
        name: 'Interface',
        layer: 'FRONTEND',
        repository: { root: FIXTURE, include: ['frontend/src'] },
      },
      { id: 'bff', name: 'BFF', layer: 'BFF', repository: { root: FIXTURE, include: ['bff'] } },
      {
        id: 'catalog',
        name: 'Catalogue',
        layer: 'BACKEND',
        repository: { root: FIXTURE, include: ['backend'] },
      },
    ],
    ...partial,
  });
}

function byName(index: CodeIndex, app: string, name: string): CodeSymbol {
  const found = index.symbols.find((s) => s.applicationId === app && s.name === name);
  if (!found) throw new Error(`symbole absent : ${app} ${name}`);
  return found;
}

function call(index: CodeIndex, from: string, text: string): CodeIndex['calls'][number] {
  const found = index.calls.find((c) => c.from.endsWith(`#${from}`) && c.text === text);
  if (!found) throw new Error(`appel absent : ${from} → ${text}`);
  return found;
}

describe('analyzeCode sur l’application du catalogue (Scope Policy Engine réel)', () => {
  let index: CodeIndex;
  beforeAll(async () => {
    const scope = fixtureScope({ endpoints: ['POST /api/books', 'DELETE /api/books/{id}'] });
    index = await analyzeCode(scope, guardedFiles(new ScopePolicy(scope)));
  });

  it('lit chaque application du périmètre, configuration comprise, sans refus', () => {
    expect(index.applications).toEqual([
      { id: 'web', layer: 'FRONTEND', files: 5, skipped: 0 },
      { id: 'bff', layer: 'BFF', files: 12, skipped: 0 },
      { id: 'catalog', layer: 'BACKEND', files: 13, skipped: 0 },
    ]);
    expect(index.denied).toEqual([]);
    expect(index.symbols.every((s) => !s.file.startsWith('/') && !s.file.includes('\\'))).toBe(true);
    expect(byName(index, 'web', 'BookForm').file).toBe('frontend/src/books/BookForm.tsx');
  });

  it('frontend : onSave → validateBook, toCreateBookPayload, createBook reliés par les imports', () => {
    const onSave = 'BookForm.onSave';
    expect(call(index, onSave, 'validateBook(values)')).toMatchObject({
      status: 'STATICALLY_RESOLVED',
      to: 'web:frontend/src/books/validation.ts#validateBook',
    });
    expect(call(index, onSave, 'toCreateBookPayload(values)')).toMatchObject({
      status: 'STATICALLY_RESOLVED',
      to: 'web:frontend/src/books/payload.ts#toCreateBookPayload',
    });
    expect(call(index, onSave, 'createBook(toCreateBookPayload(values))')).toMatchObject({
      status: 'STATICALLY_RESOLVED',
      to: 'web:frontend/src/books/books-api.ts#createBook',
    });
    const outgoing = index.outgoing.find(
      (o) => o.symbolId === 'web:frontend/src/books/books-api.ts#createBook',
    );
    expect(outgoing).toMatchObject({ method: 'POST', path: '/api/books', status: 'STATICALLY_RESOLVED' });
    // L'appel du frontend aboutit à l'endpoint du BFF.
    expect(matchEndpoint(index, 'POST', outgoing?.path ?? '', 'BFF')?.symbolId).toBe(
      'bff:bff/src/main/java/org/example/bff/books/BookController.java#BookController.create',
    );
  });

  it('BFF : controller → service → mapper / client, appel sortant résolu par application.yml', () => {
    expect(call(index, 'BookController.create', 'bookService.create(request)')).toMatchObject({
      status: 'STATICALLY_RESOLVED',
      to: 'bff:bff/src/main/java/org/example/bff/books/BookService.java#BookService.create',
    });
    expect(call(index, 'BookService.create', 'bookMapper.toCatalog(request)').status).toBe(
      'STATICALLY_RESOLVED',
    );
    expect(call(index, 'BookService.create', 'catalogClient.register(payload)')).toMatchObject({
      status: 'STATICALLY_RESOLVED',
      to: 'bff:bff/src/main/java/org/example/bff/books/CatalogClient.java#CatalogClient.register',
    });
    const register = index.outgoing.find((o) => o.symbolId.endsWith('#CatalogClient.register'));
    expect(register).toMatchObject({
      layer: 'BFF',
      method: 'POST',
      path: '/catalog/books',
      status: 'INFERRED',
      line: 22,
    });
    expect(byName(index, 'bff', 'CatalogClient.register').detail?.http).toEqual([
      'POST http://localhost:8081/catalog/books',
    ]);
    // L'appel sortant du BFF aboutit à l'endpoint du backend.
    expect(matchEndpoint(index, 'POST', register?.path ?? '', 'BACKEND')?.symbolId).toBe(
      'catalog:backend/src/main/java/org/example/catalog/books/CatalogBookController.java#CatalogBookController.register',
    );
    const request = byName(index, 'bff', 'CreateBookRequest');
    expect(request).toMatchObject({
      kind: 'DTO',
      detail: { requestBody: true, unvalidatedFields: ['publisherId'] },
    });
    expect(byName(index, 'bff', 'GlobalExceptionHandler.catalogFailure').detail).toMatchObject({
      handles: ['HttpServerErrorException'],
      responseStatus: 500,
    });
  });

  it('backend : service transactionnel, repositories (déclaré, hérité), déréférencement suspect', () => {
    expect(call(index, 'CatalogBookController.register', 'catalogBookService.register(body)').status).toBe(
      'STATICALLY_RESOLVED',
    );
    const service = 'CatalogBookService.register';
    expect(call(index, service, 'catalogBookRepository.findByIsbn(body.isbn())')).toMatchObject({
      status: 'STATICALLY_RESOLVED',
      to: 'catalog:backend/src/main/java/org/example/catalog/books/CatalogBookRepository.java#CatalogBookRepository.findByIsbn',
    });
    // findById / save : hérités de JpaRepository, donc déduits (la cible est le repository).
    expect(call(index, service, 'publisherRepository.findById(body.publisherId())')).toMatchObject({
      status: 'INFERRED',
      to: 'catalog:backend/src/main/java/org/example/catalog/books/PublisherRepository.java#PublisherRepository',
    });
    expect(call(index, service, 'catalogBookRepository.save(book)').status).toBe('INFERRED');
    expect(call(index, 'CatalogBookService.find', 'CatalogBookResponse::from').status).toBe(
      'STATICALLY_RESOLVED',
    );
    expect(byName(index, 'catalog', service).detail).toMatchObject({
      transactional: true,
      nullable: ['publisher'],
    });
    expect(byName(index, 'catalog', service).detail?.dereferences).toContain('book.getPublisher().getName()');
    expect(byName(index, 'catalog', 'NewCatalogBook').detail).toMatchObject({
      requestBody: true,
      unvalidatedFields: ['publisherId'],
    });
    expect(byName(index, 'catalog', 'CatalogBookServiceTest').detail?.test).toBe(true);
  });

  it('aucune relation lue dans le code n’est OBSERVED ; endpoint ciblé marqué, endpoint absent signalé', () => {
    expect(JSON.stringify(index)).not.toContain('OBSERVED');
    expect(byName(index, 'bff', 'BookController.create').detail?.targeted).toBe(true);
    expect(index.truncated).toEqual([
      'Endpoint ciblé introuvable dans le code lu : DELETE /api/books/{id} (/api/books/{}).',
    ]);
  });

  it('les classes ciblées limitent la lecture ; ce qui n’est pas lu n’est pas relié', async () => {
    const scope = defaultScope({
      applications: [
        {
          id: 'bff',
          name: 'BFF',
          layer: 'BFF',
          repository: {
            root: FIXTURE,
            include: ['bff'],
            classes: ['BookService', 'org.example.bff.books.CatalogClient'],
          },
        },
      ],
    });
    const partial = await analyzeCode(scope, guardedFiles(new ScopePolicy(scope)));
    expect(partial.applications).toEqual([{ id: 'bff', layer: 'BFF', files: 3, skipped: 9 }]);
    expect([...new Set(partial.symbols.map((s) => s.file.split('/').pop()))]).toEqual([
      'BookService.java',
      'CatalogClient.java',
    ]);
    expect(call(partial, 'BookService.create', 'catalogClient.register(payload)').status).toBe(
      'STATICALLY_RESOLVED',
    );
    // BookMapper n'est pas lu : l'appel reste UNKNOWN, sans cible inventée.
    const toCatalog = call(partial, 'BookService.create', 'bookMapper.toCatalog(request)');
    expect(toCatalog.status).toBe('UNKNOWN');
    expect(toCatalog.to).toBeUndefined();
  });
});

describe('refus et limites du périmètre remontés dans l’index', () => {
  it('fichier sensible, lien symbolique qui sort du dépôt, fichier trop gros', async () => {
    const root = path.join(workspace, 'web');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'api.ts'), "export const load = () => fetch('/api/books');\n");
    await writeFile(path.join(root, 'src', 'credentials.ts'), 'export const value = 1;\n');
    await writeFile(path.join(root, 'src', 'big.ts'), `export const big = '${'x'.repeat(4096)}';\n`);
    await writeFile(path.join(outside, 'escape.ts'), 'export const escaped = true;\n');
    await symlink(path.join(outside, 'escape.ts'), path.join(root, 'src', 'escape.ts'));
    const scope = defaultScope({
      applications: [{ id: 'web', name: 'Web', layer: 'FRONTEND', repository: { root, include: ['src'] } }],
      limits: {
        maxFiles: 100,
        maxFileBytes: 1024,
        maxDurationMs: 60_000,
        maxRequests: 10,
        maxExperiments: 5,
      },
    });
    const index = await analyzeCode(scope, guardedFiles(new ScopePolicy(scope)));
    const denied = index.denied.map((d) => path.basename(d.path)).sort();
    expect(denied).toEqual(['big.ts', 'credentials.ts', 'escape.ts']);
    expect(index.denied.every((d) => d.reason.length > 0)).toBe(true);
    expect(index.symbols.map((s) => s.name)).toEqual(['load']);
    expect(index.symbols.some((s) => s.file.includes('escape'))).toBe(false);
  });

  it('budget de fichiers épuisé : analyse partielle déclarée', async () => {
    const root = path.join(workspace, 'many');
    await mkdir(path.join(root, 'src'), { recursive: true });
    for (const n of [1, 2, 3, 4])
      await writeFile(path.join(root, 'src', `f${n}.ts`), `export function f${n}() {}\n`);
    const scope = defaultScope({
      applications: [{ id: 'web', name: 'Web', layer: 'FRONTEND', repository: { root, include: [] } }],
      limits: { maxFiles: 2, maxFileBytes: 4096, maxDurationMs: 60_000, maxRequests: 10, maxExperiments: 5 },
    });
    const index = await analyzeCode(scope, guardedFiles(new ScopePolicy(scope)));
    expect(index.symbols.map((s) => s.name)).toEqual(['f1', 'f2']);
    expect(index.truncated.length).toBeGreaterThan(0);
  });

  it('fonctionne avec toute implémentation de GuardedFiles (refus levé, refus et limites consignés)', async () => {
    const root = path.join(workspace, 'stub');
    const files: Record<string, string> = {
      [path.join(root, 'bff/src/main/resources/application.properties')]: 'catalog.url=http://catalog:8081\n',
      [path.join(root, 'bff/src/main/java/Client.java')]:
        'class Client { @Value("${catalog.url}") String url; RestTemplate restTemplate;' +
        ' void f() { restTemplate.getForObject(url + "/catalog/books", String.class); } }',
      [path.join(root, 'bff/src/main/java/Secret.java')]: 'class Secret {}',
    };
    const stub: GuardedFiles = {
      denied: [{ path: path.join(root, 'bff/.git'), reason: 'path.sensitive : dossier sensible' }],
      truncated: ['limite de test'],
      list(dir) {
        return Promise.resolve(
          Object.keys(files)
            .filter((f) => f.startsWith(dir))
            .sort(),
        );
      },
      readText(file) {
        if (file.endsWith('Secret.java'))
          return Promise.reject(
            Object.assign(new Error('refus'), { decision: { reason: 'classe hors périmètre' } }),
          );
        const text = files[file];
        return text === undefined ? Promise.reject(new Error('absent')) : Promise.resolve(text);
      },
    };
    const scope = defaultScope({
      applications: [{ id: 'bff', name: 'BFF', layer: 'BFF', repository: { root, include: ['bff'] } }],
    });
    const index = await analyzeCode(scope, stub);
    expect(index.applications).toEqual([{ id: 'bff', layer: 'BFF', files: 2, skipped: 1 }]);
    expect(index.denied).toEqual([
      { path: path.join(root, 'bff/.git'), reason: 'path.sensitive : dossier sensible' },
      { path: path.join(root, 'bff/src/main/java/Secret.java'), reason: 'classe hors périmètre' },
    ]);
    expect(index.truncated).toEqual(['limite de test']);
    expect(index.outgoing).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/catalog/books',
        status: 'INFERRED',
        file: 'bff/src/main/java/Client.java',
      }),
    ]);
  });
});

describe('resolveCalls', () => {
  const sym = (partial: Partial<CodeSymbol> & Pick<CodeSymbol, 'name' | 'file'>): CodeSymbol => ({
    id: `app:${partial.file}#${partial.name}`,
    applicationId: 'app',
    layer: 'BACKEND',
    kind: 'FUNCTION',
    line: 1,
    ...partial,
  });
  const emptyIndex = (symbols: CodeSymbol[], calls: CodeIndex['calls']): CodeIndex => ({
    applications: [],
    symbols,
    endpoints: [],
    outgoing: [],
    calls,
    denied: [],
    truncated: [],
  });

  it('surcharges (arité), Lombok, types homonymes ambigus, interface → implémentation unique', () => {
    const caller = sym({
      name: 'Caller',
      file: 'a/Caller.java',
      detail: {
        declaration: 'class',
        package: 'a',
        fields: ['repo:Store', 'dup:Twin', 'data:Book', 'api:Port'],
        imports: [],
      },
    });
    const run = sym({ name: 'Caller.run', file: 'a/Caller.java', parent: caller.id });
    const store = sym({
      name: 'Store',
      file: 'a/Store.java',
      detail: { declaration: 'class', package: 'a' },
    });
    const put1 = sym({
      name: 'Store.put(String)',
      file: 'a/Store.java',
      parent: store.id,
      detail: { params: ['String k'] },
    });
    const put2 = sym({
      name: 'Store.put(String,int)',
      file: 'a/Store.java',
      parent: store.id,
      detail: { params: ['String k', 'int v'] },
    });
    const twinB = sym({ name: 'Twin', file: 'b/Twin.java', detail: { declaration: 'class', package: 'b' } });
    const twinC = sym({ name: 'Twin', file: 'c/Twin.java', detail: { declaration: 'class', package: 'c' } });
    const book = sym({
      name: 'Book',
      file: 'a/Book.java',
      kind: 'DTO',
      detail: { declaration: 'class', package: 'a', lombok: ['Data'], fields: ['title:String'] },
    });
    const port = sym({
      name: 'Port',
      file: 'a/Port.java',
      detail: { declaration: 'interface', package: 'a' },
    });
    const send = sym({
      name: 'Port.send',
      file: 'a/Port.java',
      parent: port.id,
      detail: { params: ['String m'] },
    });
    const adapter = sym({
      name: 'PortAdapter',
      file: 'a/PortAdapter.java',
      detail: { declaration: 'class', package: 'a', implements: ['Port'] },
    });
    const adapterSend = sym({
      name: 'PortAdapter.send',
      file: 'a/PortAdapter.java',
      parent: adapter.id,
      detail: { params: ['String m'] },
    });
    const at = (text: string): CodeIndex['calls'][number] => ({
      from: run.id,
      text,
      status: 'UNKNOWN',
      file: run.file,
      line: 3,
    });
    const index = emptyIndex(
      [caller, run, store, put1, put2, twinB, twinC, book, port, send, adapter, adapterSend],
      [
        at('repo.put("k", 1)'),
        at('repo.put(key)'),
        at('dup.go()'),
        at('data.getTitle()'),
        at('data.getAuthor()'),
        at('api.send(m)'),
      ],
    );
    const resolved = resolveCalls(index);
    const summary = resolved.calls.map((c) => `${c.status} ${c.text} → ${c.to?.split('#')[1] ?? '∅'}`);
    expect(summary).toEqual([
      'STATICALLY_RESOLVED repo.put("k", 1) → Store.put(String,int)',
      'STATICALLY_RESOLVED repo.put(key) → Store.put(String)',
      'UNKNOWN dup.go() → ∅',
      'INFERRED data.getTitle() → Book',
      'UNKNOWN data.getAuthor() → ∅',
      'STATICALLY_RESOLVED api.send(m) → Port.send',
      'INFERRED PortAdapter.send (implémentation unique de Port.send) → PortAdapter.send',
    ]);
    // Idempotent : une seconde résolution n'ajoute rien.
    expect(resolveCalls(resolved).calls).toEqual(resolved.calls);
  });

  it('frontend : import relatif (certain), alias @/ (déduit), paquet (inconnu)', () => {
    const fe = (partial: Partial<CodeSymbol> & Pick<CodeSymbol, 'name' | 'file'>): CodeSymbol =>
      sym({ layer: 'FRONTEND', ...partial });
    const handler = fe({
      name: 'Form.onSave',
      file: 'src/ui/Form.tsx',
      kind: 'EVENT_HANDLER',
      detail: {
        imports: [
          'save=../api/books.js#save',
          'api=@/api/books#*',
          'helper=@/missing#helper',
          'lib=some-lib#lib',
        ],
      },
    });
    const save = fe({ name: 'save', file: 'src/api/books.ts' });
    const remove = fe({ name: 'remove', file: 'src/api/books.ts' });
    const at = (text: string): CodeIndex['calls'][number] => ({
      from: handler.id,
      text,
      status: 'UNKNOWN',
      file: handler.file,
      line: 2,
    });
    const resolved = resolveCalls(
      emptyIndex(
        [handler, save, remove],
        [at('save(book)'), at('api.remove(id)'), at('helper()'), at('lib()')],
      ),
    );
    expect(resolved.calls.map((c) => `${c.status} ${c.text} → ${c.to?.split('#')[1] ?? '∅'}`)).toEqual([
      'STATICALLY_RESOLVED save(book) → save',
      'INFERRED api.remove(id) → remove',
      'UNKNOWN helper() → ∅',
      'UNKNOWN lib() → ∅',
    ]);
  });
});

describe('matchEndpoint et normalizePath', () => {
  const index: Pick<CodeIndex, 'endpoints'> = {
    endpoints: [
      { applicationId: 'bff', layer: 'BFF', method: 'GET', path: '/api/books/{id}', symbolId: 'byId' },
      { applicationId: 'bff', layer: 'BFF', method: 'GET', path: '/api/books/search', symbolId: 'search' },
      { applicationId: 'bff', layer: 'BFF', method: 'POST', path: '/api/books', symbolId: 'create' },
      {
        applicationId: 'bff',
        layer: 'BFF',
        method: '*',
        path: '/api/books/{id}/cover-{size}',
        symbolId: 'cover',
      },
      {
        applicationId: 'cat',
        layer: 'BACKEND',
        method: 'POST',
        path: '/catalog/books',
        symbolId: 'register',
      },
    ],
  };

  it('gabarits, barre finale, requête, chemin littéral préféré, méthode `*` en dernier recours, couche', () => {
    expect(matchEndpoint(index, 'get', '/api/books/12')?.symbolId).toBe('byId');
    expect(matchEndpoint(index, 'GET', 'https://bff.example.test/api/books/search?q=phare')?.symbolId).toBe(
      'search',
    );
    expect(matchEndpoint(index, 'POST', '/api/books/')?.symbolId).toBe('create');
    expect(matchEndpoint(index, 'PUT', '/api/books/12')).toBeUndefined();
    expect(matchEndpoint(index, 'DELETE', '/api/books/12/cover-large')?.symbolId).toBe('cover');
    expect(matchEndpoint(index, 'POST', '/catalog/books')?.symbolId).toBe('register');
    expect(matchEndpoint(index, 'POST', '/catalog/books', 'BFF')).toBeUndefined();
    expect(matchEndpoint(index, 'GET', '/api/books/${id}')?.symbolId).toBe('byId');
    expect(matchEndpoint(index, 'GET', '/api/books/:id')?.symbolId).toBe('byId');
  });

  it('normalise hôte, requête, fragment, paramètres et barres obliques', () => {
    expect(normalizePath('http://localhost:8081/catalog/books/?x=1#top')).toBe('/catalog/books');
    expect(normalizePath('/catalog//books/${id}')).toBe('/catalog/books/{}');
    expect(normalizePath('api/books/{id}/cover-{size}')).toBe('/api/books/{}/cover-{}');
    expect(normalizePath('/api/books/:id')).toBe('/api/books/{}');
    expect(normalizePath('')).toBe('/');
  });
});
