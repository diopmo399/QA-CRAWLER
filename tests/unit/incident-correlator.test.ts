import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  citedPaths,
  exceptionsIn,
  matchEndpoint,
  normalizePath,
  nullDereferenceIn,
  pathMatches,
  weakest,
} from '../../src/incident/correlator.js';
import type {
  CodeIndex,
  CodeSymbol,
  HttpExchange,
  InvestigationGraph,
  ReproductionRun,
} from '../../src/incident/model.js';

/**
 * LE CORRÉLATEUR sur l'incident fictif du catalogue : la requête observée POST /api/books → 500 est
 * reliée au BFF (BookController), au client du catalogue, puis au backend (CatalogBookService) qui
 * déréférence l'éditeur null. Un chemin lu dans le code n'est jamais OBSERVED.
 */

const BFF_ERROR = String.raw`{"timestamp":"2026-10-30T09:00:03Z","status":500,"error":"Internal Server Error","path":"/api/books","message":"Catalog error: 500 : \"{\"status\":500,\"error\":\"Internal Server Error\",\"exception\":\"java.lang.NullPointerException\",\"message\":\"Cannot invoke \\\"org.example.catalog.books.Publisher.getName()\\\" because the return value of \\\"org.example.catalog.books.CatalogBook.getPublisher()\\\" is null\",\"path\":\"/catalog/books\"}\""}`;

const FRONT = 'frontend/src/books';
const BFF = 'src/main/java/org/example/bff/books';
const CATALOG = 'src/main/java/org/example/catalog/books';

function symbol(
  applicationId: string,
  layer: CodeSymbol['layer'],
  kind: CodeSymbol['kind'],
  file: string,
  name: string,
  line: number,
  detail?: CodeSymbol['detail'],
): CodeSymbol {
  return {
    id: `${applicationId}:${file}#${name}`,
    applicationId,
    layer,
    kind,
    name,
    file,
    line,
    ...(detail ? { detail } : {}),
  };
}

const S = {
  onSave: symbol('front', 'FRONTEND', 'EVENT_HANDLER', `${FRONT}/BookForm.tsx`, 'onSave', 21),
  createBook: symbol('front', 'FRONTEND', 'FUNCTION', `${FRONT}/books-api.ts`, 'createBook', 8),
  controller: symbol('bff', 'BFF', 'ENDPOINT', `${BFF}/BookController.java`, 'BookController.create', 24, {
    requestBody: 'CreateBookRequest',
  }),
  service: symbol('bff', 'BFF', 'SERVICE', `${BFF}/BookService.java`, 'BookService.create', 19),
  mapper: symbol('bff', 'BFF', 'MAPPER', `${BFF}/BookMapper.java`, 'BookMapper.toCatalog', 12),
  client: symbol('bff', 'BFF', 'HTTP_CLIENT', `${BFF}/CatalogClient.java`, 'CatalogClient.register', 27),
  catalogController: symbol(
    'catalog',
    'BACKEND',
    'ENDPOINT',
    `${CATALOG}/CatalogBookController.java`,
    'CatalogBookController.register',
    22,
    { requestBody: 'NewCatalogBook' },
  ),
  catalogService: symbol(
    'catalog',
    'BACKEND',
    'SERVICE',
    `${CATALOG}/CatalogBookService.java`,
    'CatalogBookService.register',
    31,
    {
      transactional: true,
      dereferences: ['book.getPublisher().getName()'],
    },
  ),
  publisherRepository: symbol(
    'catalog',
    'BACKEND',
    'REPOSITORY',
    `${CATALOG}/PublisherRepository.java`,
    'PublisherRepository',
    6,
  ),
  catalogBook: symbol('catalog', 'BACKEND', 'DTO', `${CATALOG}/CatalogBook.java`, 'CatalogBook', 9),
  thrown: symbol('bff', 'BFF', 'EXCEPTION', `${BFF}/CatalogClient.java`, 'CatalogUnavailableException', 33),
};
S.thrown.parent = S.client.id;

function catalogueCode(): CodeIndex {
  return {
    applications: [
      { id: 'front', layer: 'FRONTEND', files: 4, skipped: 0 },
      { id: 'bff', layer: 'BFF', files: 7, skipped: 0 },
      { id: 'catalog', layer: 'BACKEND', files: 8, skipped: 0 },
    ],
    symbols: Object.values(S),
    endpoints: [
      { applicationId: 'bff', layer: 'BFF', method: 'POST', path: '/api/books', symbolId: S.controller.id },
      {
        applicationId: 'bff',
        layer: 'BFF',
        method: 'GET',
        path: '/api/books/{id}',
        symbolId: S.controller.id,
      },
      {
        applicationId: 'catalog',
        layer: 'BACKEND',
        method: 'POST',
        path: '/catalog/books',
        symbolId: S.catalogController.id,
      },
    ],
    outgoing: [
      {
        applicationId: 'front',
        layer: 'FRONTEND',
        symbolId: S.createBook.id,
        method: 'POST',
        path: '/api/books',
        status: 'STATICALLY_RESOLVED',
        file: S.createBook.file,
        line: 9,
      },
      {
        applicationId: 'bff',
        layer: 'BFF',
        symbolId: S.client.id,
        method: 'POST',
        path: '/catalog/books',
        status: 'INFERRED',
        file: S.client.file,
        line: 28,
      },
    ],
    calls: [
      {
        from: S.onSave.id,
        to: S.createBook.id,
        text: 'createBook(payload)',
        status: 'STATICALLY_RESOLVED',
        file: S.onSave.file,
        line: 25,
      },
      {
        from: S.controller.id,
        to: S.service.id,
        text: 'bookService.create(request)',
        status: 'STATICALLY_RESOLVED',
        file: S.controller.file,
        line: 25,
      },
      {
        from: S.service.id,
        to: S.mapper.id,
        text: 'bookMapper.toCatalog(request)',
        status: 'STATICALLY_RESOLVED',
        file: S.service.file,
        line: 20,
      },
      {
        from: S.service.id,
        to: S.client.id,
        text: 'catalogClient.register(body)',
        status: 'STATICALLY_RESOLVED',
        file: S.service.file,
        line: 21,
      },
      {
        from: S.client.id,
        text: 'restTemplate.postForObject(...)',
        status: 'UNKNOWN',
        file: S.client.file,
        line: 28,
      },
      {
        from: S.catalogController.id,
        to: S.catalogService.id,
        text: 'service.register(body)',
        status: 'STATICALLY_RESOLVED',
        file: S.catalogController.file,
        line: 23,
      },
      {
        from: S.catalogService.id,
        to: S.publisherRepository.id,
        text: 'publisherRepository.findById(body.publisherId())',
        status: 'INFERRED',
        file: S.catalogService.file,
        line: 32,
      },
    ],
    denied: [],
    truncated: [],
  };
}

function exchange(
  partial: Partial<HttpExchange> & Pick<HttpExchange, 'id' | 'method' | 'path'>,
): HttpExchange {
  return { url: partial.path, resourceType: 'fetch', correlation: 'OBSERVED', ...partial };
}

function catalogueReproduction(requests?: HttpExchange[]): ReproductionRun {
  return {
    id: 'rep_1',
    startedAt: '2026-10-30T09:00:00.000Z',
    status: 'COMPLETED',
    target: 'LOCAL',
    scenario: 'creer-livre',
    reproduced: true,
    symptomMatch: 'observé : HTTP 500 : POST /api/books → 500 (étape 3)',
    actions: [
      {
        index: 1,
        kind: 'goto',
        description: 'goto /books/new',
        status: 'PASSED',
        durationMs: 900,
        requestIds: [],
      },
      {
        index: 3,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        durationMs: 800,
        requestIds: ['rep_1:req-3-1'],
      },
    ],
    requests: requests ?? [
      exchange({
        id: 'rep_1:req-3-1',
        method: 'POST',
        path: '/api/books',
        status: 500,
        step: 3,
        requestBody: '{"title":"Le Petit Atlas","isbn":"978-2-0000-0000-1"}',
        responseBody: BFF_ERROR,
      }),
      exchange({
        id: 'rep_1:req-1-1',
        method: 'GET',
        path: '/books/new',
        status: 200,
        step: 1,
        resourceType: 'document',
      }),
    ],
    evidence: [
      {
        id: 'rep_1:ev-action-1',
        kind: 'ACTION',
        summary: 'étape 1',
        source: { reproduction: 'rep_1', step: 1 },
      },
      {
        id: 'rep_1:ev-action-3',
        kind: 'ACTION',
        summary: 'étape 3',
        source: { reproduction: 'rep_1', step: 3 },
      },
    ],
    screenshots: [],
  };
}

const incident = {
  id: 'inc_catalogue01',
  title: 'Erreur 500 à la création d’un livre',
  scenario: 'creer-livre',
};

function edge(graph: InvestigationGraph, from: string, to: string) {
  return graph.edges.find((item) => item.from === from && item.to === to);
}
const code = (symbolId: string): string => `code:${symbolId}`;

describe('path helpers', () => {
  it('normalizes and matches templates', () => {
    expect(normalizePath('http://catalog:8081/catalog/books/?x=1#top')).toBe('/catalog/books');
    expect(normalizePath('/catalog/books/${id}')).toBe('/catalog/books/{}');
    expect(normalizePath('/api/books/:id')).toBe('/api/books/{}');
    expect(normalizePath('${catalogUrl}/catalog/books')).toBe('{}/catalog/books');
    expect(pathMatches('/api/books/{id}', '/api/books/12')).toBe(true);
    expect(pathMatches('/api/books/{id}', '/api/books')).toBe(false);
    expect(pathMatches('/api/books/', '/api/books')).toBe(true);
  });

  it('matches endpoints by method and path, path only, or the end of an unresolved URL', () => {
    const index = catalogueCode();
    expect(matchEndpoint(index, 'POST', '/api/books')?.status).toBe('STATICALLY_RESOLVED');
    expect(matchEndpoint(index, 'GET', '/api/books/12')?.endpoint.path).toBe('/api/books/{id}');
    expect(matchEndpoint(index, 'PUT', '/api/books')?.status).toBe('INFERRED');
    expect(matchEndpoint(index, 'POST', '${catalogUrl}/catalog/books', ['BACKEND'])?.status).toBe('INFERRED');
    expect(matchEndpoint(index, 'DELETE', '/api/authors')).toBeUndefined();
  });

  it('reads exceptions, null dereferences and cited paths from a response body', () => {
    expect(exceptionsIn(BFF_ERROR).map((item) => item.qualified)).toEqual(['java.lang.NullPointerException']);
    const npe = nullDereferenceIn(BFF_ERROR);
    expect(npe?.nullFrom).toMatchObject({ className: 'CatalogBook', method: 'getPublisher' });
    expect(npe?.invoked).toMatchObject({ className: 'Publisher', method: 'getName' });
    expect(npe?.relation).toBe('publisher');
    expect(citedPaths(BFF_ERROR)).toEqual(['/api/books', '/catalog/books']);
    expect(weakest('OBSERVED', 'INFERRED', 'STATICALLY_RESOLVED')).toBe('INFERRED');
  });
});

describe('buildGraph', () => {
  it('links the observed request through the BFF to the backend with honest statuses', () => {
    const graph = buildGraph({
      incident,
      reproduction: catalogueReproduction(),
      code: catalogueCode(),
      depth: 3,
    });
    expect(edge(graph, 'incident:inc_catalogue01', 'scenario:creer-livre')?.status).toBe('OBSERVED');
    expect(edge(graph, 'scenario:creer-livre', 'action:rep_1:3')?.status).toBe('OBSERVED');
    expect(edge(graph, 'action:rep_1:3', 'request:rep_1:req-3-1')?.status).toBe('OBSERVED');
    expect(edge(graph, code(S.createBook.id), 'request:rep_1:req-3-1')?.status).toBe('STATICALLY_RESOLVED');
    expect(edge(graph, 'request:rep_1:req-3-1', code(S.controller.id))?.status).toBe('STATICALLY_RESOLVED');
    expect(edge(graph, code(S.controller.id), code(S.service.id))?.status).toBe('STATICALLY_RESOLVED');
    expect(edge(graph, code(S.service.id), code(S.client.id))?.status).toBe('STATICALLY_RESOLVED');
    const outgoing = `outgoing:${S.client.id}:28`;
    expect(edge(graph, code(S.client.id), outgoing)?.status).toBe('INFERRED');
    // URL lue via @Value : la relation au backend reste INFERRED, même si la réponse cite le chemin.
    const toBackend = edge(graph, outgoing, code(S.catalogController.id));
    expect(toBackend?.status).toBe('INFERRED');
    expect(toBackend?.reason).toContain('cite ce chemin');
    expect(toBackend?.evidence).toContain('rep_1:req-3-1');
    expect(edge(graph, code(S.catalogController.id), code(S.catalogService.id))?.status).toBe(
      'STATICALLY_RESOLVED',
    );
    expect(edge(graph, code(S.catalogService.id), code(S.publisherRepository.id))?.status).toBe('INFERRED');
    expect(graph.nodes.find((node) => node.id === code(S.publisherRepository.id))?.kind).toBe('REPOSITORY');
    // L'exception levée dans le code du client : lue, donc STATICALLY_RESOLVED.
    expect(edge(graph, code(S.client.id), `exception:code:${S.thrown.id}`)?.status).toBe(
      'STATICALLY_RESOLVED',
    );
  });

  it('marks the exception named by the response as OBSERVED and the matching dereference as INFERRED', () => {
    const graph = buildGraph({
      incident,
      reproduction: catalogueReproduction(),
      code: catalogueCode(),
      depth: 3,
    });
    const exceptionId = 'exception:observed:rep_1:req-3-1:NullPointerException';
    const exception = graph.nodes.find((node) => node.id === exceptionId);
    expect(exception?.layer).toBe('BACKEND');
    expect(exception?.evidence).toEqual(['rep_1:req-3-1']);
    expect(edge(graph, 'request:rep_1:req-3-1', exceptionId)?.status).toBe('OBSERVED');
    const dereference = edge(graph, code(S.catalogService.id), exceptionId);
    expect(dereference?.status).toBe('INFERRED');
    expect(dereference?.reason).toContain('getPublisher().getName()');
  });

  it('never labels a relation read in the code as OBSERVED, and every node carries evidence', () => {
    const graph = buildGraph({
      incident,
      reproduction: catalogueReproduction(),
      code: catalogueCode(),
      depth: 5,
    });
    const staticSources = graph.edges.filter(
      (item) => item.from.startsWith('code:') || item.from.startsWith('outgoing:'),
    );
    expect(staticSources.length).toBeGreaterThan(5);
    expect(staticSources.every((item) => item.status !== 'OBSERVED')).toBe(true);
    expect(
      graph.edges.filter((item) => item.status === 'OBSERVED').every((item) => item.evidence.length > 0),
    ).toBe(true);
    for (const node of graph.nodes.filter((item) => item.kind !== 'INCIDENT'))
      expect(node.evidence.length).toBeGreaterThan(0);
    // Pas de doublon de nœud ni d'arête.
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    expect(new Set(graph.edges.map((item) => `${item.from}->${item.to}`)).size).toBe(graph.edges.length);
    // Une page chargée avec succès n'est pas une requête d'intérêt.
    expect(graph.nodes.some((node) => node.id === 'request:rep_1:req-1-1')).toBe(false);
  });

  it('limits method hops by depth', () => {
    const graph = buildGraph({
      incident,
      reproduction: catalogueReproduction(),
      code: catalogueCode(),
      depth: 1,
    });
    expect(graph.nodes.some((node) => node.id === code(S.service.id))).toBe(true);
    expect(graph.nodes.some((node) => node.id === code(S.client.id))).toBe(false);
    expect(graph.nodes.some((node) => node.kind === 'BACKEND_CALL')).toBe(false);
    expect(graph.nodes.some((node) => node.id === code(S.catalogController.id))).toBe(false);
  });

  it('adds UNKNOWN edges with a reason for missing links', () => {
    const index = catalogueCode();
    const client = index.outgoing[1];
    if (client) index.outgoing[1] = { ...client, path: undefined, status: 'UNKNOWN' };
    const reproduction = catalogueReproduction([
      exchange({ id: 'rep_1:req-3-1', method: 'POST', path: '/api/books', status: 500, step: 3 }),
      exchange({ id: 'rep_1:req-3-2', method: 'DELETE', path: '/api/drafts/7', status: 404, step: 3 }),
      exchange({
        id: 'rep_1:req-x-1',
        method: 'GET',
        path: '/api/stats',
        status: 503,
        correlation: 'UNKNOWN',
      }),
    ]);
    const graph = buildGraph({ incident, reproduction, code: index, depth: 3 });
    const drafts = edge(graph, 'request:rep_1:req-3-2', 'unknown:rep_1:req-3-2:endpoint');
    expect(drafts?.status).toBe('UNKNOWN');
    expect(drafts?.reason).toContain('DELETE /api/drafts/7');
    const dynamic = graph.edges.find(
      (item) => item.from === `outgoing:${S.client.id}:28` && item.status === 'UNKNOWN',
    );
    expect(dynamic?.reason).toContain("construite à l'exécution");
    expect(edge(graph, 'scenario:creer-livre', 'request:rep_1:req-x-1')?.status).toBe('UNKNOWN');
    // Sans corps de réponse : aucune exception OBSERVED inventée.
    expect(
      graph.nodes.some((node) => node.kind === 'EXCEPTION' && node.id.startsWith('exception:observed')),
    ).toBe(false);
  });

  it('keeps the chain honest without code or without reproduction', () => {
    const noCode = buildGraph({ incident, reproduction: catalogueReproduction(), depth: 3 });
    expect(noCode.nodes.some((node) => node.symbolId !== undefined)).toBe(false);
    expect(
      edge(noCode, 'request:rep_1:req-3-1', 'exception:observed:rep_1:req-3-1:NullPointerException')?.status,
    ).toBe('OBSERVED');
    const nothing = buildGraph({ incident, code: catalogueCode(), depth: 3 });
    expect(edge(nothing, 'incident:inc_catalogue01', 'scenario:creer-livre')?.status).toBe('INFERRED');
    expect(edge(nothing, 'scenario:creer-livre', 'unknown:inc_catalogue01:request')?.status).toBe('UNKNOWN');
    expect(nothing.edges.some((item) => item.status === 'OBSERVED')).toBe(false);
  });
});
