import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodeSymbol } from '../../src/incident/model.js';
import {
  analyzeJavaSource,
  readSpringProperties,
  resolvePlaceholders,
} from '../../src/incident/code/index.js';
import { tokenizeJava } from '../../src/incident/code/java-lexer.js';
import { parseJava } from '../../src/incident/code/java-parser.js';

/**
 * L'ANALYSE JAVA de l'Incident Reconstruction : le lexeur (commentaires, littéraux, blocs de texte,
 * lignes), le parseur (génériques, annotations, records, interfaces, types imbriqués) et la lecture
 * Spring (routes, DTO et validations, clients HTTP sortants et `@Value`, repositories, transactions,
 * SQL, exceptions, déréférencements). Aucune relation lue dans le code n'est OBSERVED.
 */

const FIXTURE = path.resolve('tests/fixtures/incident-app');

function symbol(symbols: CodeSymbol[], name: string): CodeSymbol {
  const found = symbols.find((s) => s.name === name);
  if (!found)
    throw new Error(`symbole absent : ${name} (présents : ${symbols.map((s) => s.name).join(', ')})`);
  return found;
}

describe('lexeur Java', () => {
  it('ignore commentaires et littéraux piégeux, garde les lignes', () => {
    const source = [
      'class A { // une accolade } dans un commentaire',
      '  /* bloc { } "faux" */ String s = "texte avec } et // et \\" guillemet";',
      "  char c = '{'; char q = '\\'';",
      '  String block = """',
      '      SELECT *',
      '        FROM livre -- }',
      '      """;',
      '  int n = 1_000; double d = 1.5e-3; long h = 0x1F;',
      '}',
    ].join('\n');
    const tokens = tokenizeJava(source);
    const strings = tokens.filter((t) => t.kind === 'string');
    expect(strings.map((t) => t.value)).toEqual([
      'texte avec } et // et " guillemet',
      'SELECT *\n  FROM livre -- }\n',
    ]);
    expect(strings[1]?.textBlock).toBe(true);
    expect(tokens.filter((t) => t.kind === 'char').map((t) => t.value)).toEqual(['{', "'"]);
    expect(tokens.filter((t) => t.text === '{' || t.text === '}').map((t) => t.text)).toEqual(['{', '}']);
    expect(tokens.find((t) => t.text === 'block')?.line).toBe(4);
    expect(tokens.find((t) => t.text === 'n')?.line).toBe(8);
    expect(tokens.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['1_000', '1.5e-3', '0x1F']);
  });

  it('découpe les fermetures de génériques en `>` isolés', () => {
    const tokens = tokenizeJava('Map<String, List<Long>> m;');
    expect(tokens.map((t) => t.text)).toEqual([
      'Map',
      '<',
      'String',
      ',',
      'List',
      '<',
      'Long',
      '>',
      '>',
      'm',
      ';',
    ]);
  });
});

describe('parseur Java', () => {
  it('lit package, imports, types imbriqués, records, enums, interfaces et membres', () => {
    const java = parseJava(`
      package org.example.books;

      import java.util.List;
      import static java.util.Objects.requireNonNull;

      @SuppressWarnings({"unchecked", "rawtypes"})
      public sealed class Shelf<T extends Comparable<T>> extends Base<T> implements Named, Sized permits Special {
        private static final String PREFIX = "/shelf" + "/v1";
        private final Map<String, List<Book>> byAuthor = new HashMap<String, List<Book>>(), other;
        @Deprecated(since = "2", forRemoval = true) int count;

        public Shelf(@Qualifier("main") List<Book> books) { super(books); }

        public <R> List<R> map(Function<? super T, ? extends R> f, String... names) throws IOException, BookException {
          if (names.length > 0) { return List.of(); }
          return new ArrayList<>();
        }

        public record Entry(@NotNull String title, int year) {
          public Entry { requireNonNull(title); }
          String label() { return title + year; }
        }

        enum Kind { NOVEL("n") { @Override String code() { return "x"; } }, ESSAY("e"); private final String c; Kind(String c) { this.c = c; } String code() { return c; } }

        interface Named { String name(); default String upper() { return name().toUpperCase(); } }
      }
    `);
    expect(java.package).toBe('org.example.books');
    expect(java.imports).toEqual(['java.util.List']);
    expect(java.staticImports).toEqual(['java.util.Objects.requireNonNull']);
    expect(java.types.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'class:Shelf',
      'record:Shelf.Entry',
      'enum:Shelf.Kind',
      'interface:Shelf.Named',
    ]);
    const shelf = java.types[0];
    expect(shelf?.qualifiedName).toBe('org.example.books.Shelf');
    expect(shelf?.extends.map((e) => e.text)).toEqual(['Base<T>']);
    expect(shelf?.implements.map((e) => e.name)).toEqual(['Named', 'Sized']);
    expect(shelf?.annotations[0]?.args.value?.map((v) => v.text)).toEqual(['"unchecked"', '"rawtypes"']);
    expect(shelf?.fields.map((f) => `${f.name}:${f.type.text}`)).toEqual([
      'PREFIX:String',
      'byAuthor:Map<String,List<Book>>',
      'other:Map<String,List<Book>>',
      'count:int',
    ]);
    expect(shelf?.fields[3]?.annotations[0]?.args.forRemoval?.[0]?.text).toBe('true');
    const ctor = shelf?.methods.find((m) => m.constructor);
    expect(ctor?.params[0]?.annotations[0]?.name).toBe('Qualifier');
    const map = shelf?.methods.find((m) => m.name === 'map');
    expect(map?.returnType?.text).toBe('List<R>');
    expect(map?.params.map((p) => `${p.type.text} ${p.name}`)).toEqual([
      'Function<? super T,? extends R> f',
      'String... names',
    ]);
    expect(map?.throws).toEqual(['IOException', 'BookException']);
    expect(map?.line).toBe(15);
    expect(map?.endLine).toBe(18);
    const entry = java.types[1];
    expect(entry?.components.map((c) => `${c.name}:${c.type.text}`)).toEqual(['title:String', 'year:int']);
    expect(entry?.components[0]?.annotations[0]?.name).toBe('NotNull');
    expect(entry?.methods.map((m) => m.name)).toEqual(['Entry', 'label']);
    expect(java.types[2]?.enumConstants).toEqual(['NOVEL', 'ESSAY']);
    expect(java.types[2]?.methods.map((m) => m.name)).toEqual(['Kind', 'code']);
    expect(java.types[3]?.methods.map((m) => `${m.name}:${m.body ? 'body' : 'abstract'}`)).toEqual([
      'name:abstract',
      'upper:body',
    ]);
  });

  it('lit une déclaration d’annotation sans se perdre', () => {
    const java = parseJava(`
      @Retention(RUNTIME) public @interface Audited { String value() default ""; int level() default 1; }
      class After { void run() {} }
    `);
    expect(java.types.map((t) => `${t.kind}:${t.name}`)).toEqual(['annotation:Audited', 'class:After']);
    expect(java.types[1]?.methods[0]?.name).toBe('run');
  });
});

describe('routes Spring', () => {
  const source = `
    package org.example.bff.books;

    @RestController
    @RequestMapping(path = {"/api/books", "/api/v2/books"})
    public class BookController {
      private static final String BY_ID = "/{id}";

      @GetMapping
      public List<BookView> list() { return List.of(); }

      @GetMapping(BY_ID)
      public BookView get(@PathVariable Long id) { return null; }

      @PostMapping(value = "/", consumes = "application/json")
      @ResponseStatus(HttpStatus.CREATED)
      public BookView create(@Valid @RequestBody CreateBookRequest request) { return null; }

      @PutMapping(path = "/{id}")
      public BookView update(@PathVariable("id") Long id, @RequestBody CreateBookRequest request) { return null; }

      @DeleteMapping("/{id}") public void delete(@PathVariable Long id) {}

      @PatchMapping({"/{id}/title", "/{id}/name"}) public void rename(@PathVariable Long id, @RequestParam String title) {}

      @RequestMapping(value = "/search", method = {RequestMethod.GET, RequestMethod.HEAD})
      public List<BookView> search(@RequestParam("q") String q) { return List.of(); }

      @RequestMapping("/\${books.legacy-prefix}/all")
      public List<BookView> legacy() { return List.of(); }

      private void helper() {}
    }
  `;
  const result = analyzeJavaSource('bff', 'BFF', 'src/main/java/BookController.java', source, {
    'books.legacy-prefix': 'old',
  });
  const routes = result.endpoints.map((e) => `${e.method} ${e.path} → ${e.symbolId.split('#')[1] ?? ''}`);

  it('combine préfixes de classe et chaque style de mapping', () => {
    expect(routes).toEqual([
      'GET /api/books → BookController.list',
      'GET /api/v2/books → BookController.list',
      'GET /api/books/{id} → BookController.get',
      'GET /api/v2/books/{id} → BookController.get',
      'POST /api/books → BookController.create',
      'POST /api/v2/books → BookController.create',
      'PUT /api/books/{id} → BookController.update',
      'PUT /api/v2/books/{id} → BookController.update',
      'DELETE /api/books/{id} → BookController.delete',
      'DELETE /api/v2/books/{id} → BookController.delete',
      'PATCH /api/books/{id}/title → BookController.rename',
      'PATCH /api/books/{id}/name → BookController.rename',
      'PATCH /api/v2/books/{id}/title → BookController.rename',
      'PATCH /api/v2/books/{id}/name → BookController.rename',
      'GET /api/books/search → BookController.search',
      'GET /api/v2/books/search → BookController.search',
      'HEAD /api/books/search → BookController.search',
      'HEAD /api/v2/books/search → BookController.search',
      '* /api/books/old/all → BookController.legacy',
      '* /api/v2/books/old/all → BookController.legacy',
    ]);
  });

  it('décrit le controller et ses endpoints (corps, validation, statut, paramètres)', () => {
    const controller = symbol(result.symbols, 'BookController');
    expect(controller.kind).toBe('CONTROLLER');
    expect(controller.detail?.basePaths).toEqual(['/api/books', '/api/v2/books']);
    const create = symbol(result.symbols, 'BookController.create');
    expect(create.kind).toBe('ENDPOINT');
    expect(create.parent).toBe(controller.id);
    expect(create.detail).toMatchObject({
      requestBody: 'CreateBookRequest',
      validated: true,
      responseStatus: 201,
    });
    expect(symbol(result.symbols, 'BookController.update').detail).toMatchObject({
      requestBody: 'CreateBookRequest',
      validated: false,
      pathVariables: ['id'],
    });
    expect(symbol(result.symbols, 'BookController.search').detail?.requestParams).toEqual(['q']);
    expect(symbol(result.symbols, 'BookController.helper').kind).toBe('FUNCTION');
    expect(result.endpoints.some((e) => e.symbolId.endsWith('helper'))).toBe(false);
  });
});

describe('DTO et validations', () => {
  it('lit les contraintes par champ (record et classe) et les champs sans validation', () => {
    const result = analyzeJavaSource(
      'bff',
      'BFF',
      'Dto.java',
      `
      public record CreateBookRequest(
        @NotBlank @Size(max = 200) String title,
        @NotBlank @Pattern(regexp = "^\\\\d{13}$") String isbn,
        Long publisherId) {}

      public class AuthorForm {
        @NotNull @Email private String email;
        @Min(1) @Max(5) private int stars;
        private String note;
        public String getEmail() { return email; }
      }
    `,
    );
    const request = symbol(result.symbols, 'CreateBookRequest');
    expect(request.kind).toBe('DTO');
    expect(request.detail).toMatchObject({
      validatedFields: ['title', 'isbn'],
      unvalidatedFields: ['publisherId'],
      requiredFields: ['title', 'isbn'],
      optionalFields: ['publisherId'],
    });
    const isbn = symbol(result.symbols, 'CreateBookRequest.isbn');
    expect(isbn.kind).toBe('VALIDATION');
    expect(isbn.detail?.constraints).toEqual(['@NotBlank', '@Pattern(regexp = "^\\\\d{13}$")']);
    expect(isbn.line).toBe(4);
    expect(result.symbols.some((s) => s.name === 'CreateBookRequest.publisherId')).toBe(false);
    const form = symbol(result.symbols, 'AuthorForm');
    expect(form.kind).toBe('DTO');
    expect(form.detail?.validations).toEqual(['email: @NotNull @Email', 'stars: @Min(1) @Max(5)']);
    expect(form.detail?.optionalFields).toEqual(['note']);
  });
});

describe('appels HTTP sortants', () => {
  it('RestTemplate et @Value (champ, constructeur, variable locale, exchange) résolus par la configuration', () => {
    const source = `
      @Component
      public class CatalogClient {
        private static final String BOOKS = "/catalog/books";
        @Value("\${catalog.url}") private String catalogUrl;
        @Value("\${missing.url}") private String missingUrl;
        private final RestTemplate restTemplate;
        private final String reportsUrl;

        public CatalogClient(RestTemplate restTemplate, @Value("\${reports.url:http://reports:9000}") String reportsUrl) {
          this.restTemplate = restTemplate;
          this.reportsUrl = reportsUrl;
        }

        public CatalogBookView register(CatalogBookPayload body) {
          return restTemplate.postForObject(catalogUrl + BOOKS, body, CatalogBookView.class);
        }
        public void remove(long id) {
          String url = catalogUrl + BOOKS + "/" + id;
          restTemplate.delete(url);
        }
        public Report report() {
          return restTemplate.exchange(reportsUrl + "/reports/{year}", HttpMethod.GET, null, Report.class, 2024).getBody();
        }
        public void ping() { restTemplate.getForObject(missingUrl + "/health", String.class); }
        public void literal() { restTemplate.put("http://catalog/catalog/books/{id}", null, 1); }
        public void dynamic(String target) { restTemplate.postForEntity(target, null, Void.class); }
      }
    `;
    const result = analyzeJavaSource('bff', 'BFF', 'CatalogClient.java', source, {
      'catalog.url': 'http://localhost:8081',
    });
    const calls = result.outgoing.map(
      (o) => `${o.status} ${o.method ?? '?'} ${o.path ?? '?'} ${o.symbolId.split('#')[1] ?? ''}`,
    );
    expect(calls).toEqual([
      'INFERRED POST /catalog/books CatalogClient.register',
      'INFERRED DELETE /catalog/books/{id} CatalogClient.remove',
      'INFERRED GET /reports/{year} CatalogClient.report',
      'INFERRED GET /health CatalogClient.ping',
      'STATICALLY_RESOLVED PUT /catalog/books/{id} CatalogClient.literal',
      'UNKNOWN POST ? CatalogClient.dynamic',
    ]);
    expect(result.outgoing.every((o) => o.status !== 'OBSERVED')).toBe(true);
    const register = symbol(result.symbols, 'CatalogClient.register');
    expect(register.kind).toBe('BACKEND_CALL');
    expect(register.detail).toMatchObject({
      http: ['POST http://localhost:8081/catalog/books'],
      httpClient: 'RestTemplate',
      properties: ['catalog.url'],
    });
    expect(symbol(result.symbols, 'CatalogClient.report').detail?.http).toEqual([
      'GET http://reports:9000/reports/{year}',
    ]);
    expect(symbol(result.symbols, 'CatalogClient').kind).toBe('HTTP_CLIENT');
    // Aucun appel de bibliothèque (restTemplate.x) ne devient une relation entre symboles.
    expect(result.calls).toEqual([]);
  });

  it('WebClient, RestClient (baseUrl construit dans la classe) et clients Feign', () => {
    const source = `
      @Service
      public class StockGateway {
        private final WebClient webClient;
        private final RestClient restClient;
        public StockGateway(WebClient.Builder builder, RestClient.Builder rest, @Value("\${stock.url}") String stockUrl) {
          this.webClient = builder.baseUrl(stockUrl).build();
          this.restClient = rest.baseUrl("http://stock/api").build();
        }
        public Mono<Stock> stock(long id) {
          return webClient.get().uri("/stocks/{id}", id).retrieve().bodyToMono(Stock.class);
        }
        public void reserve(Reservation r) {
          restClient.post().uri("/reservations").body(r).retrieve().toBodilessEntity();
        }
        public void release(long id) {
          webClient.method(HttpMethod.DELETE).uri(b -> b.path("/reservations/{id}").build(id)).retrieve();
        }
      }

      @FeignClient(name = "pricing", url = "\${pricing.url}", path = "/pricing")
      public interface PricingClient {
        @GetMapping("/books/{isbn}") Price price(@PathVariable String isbn);
        @PostMapping Price create(@RequestBody Price price);
      }
    `;
    const result = analyzeJavaSource('bff', 'BFF', 'Clients.java', source, {
      'stock.url': 'http://stock:8080',
    });
    const calls = result.outgoing.map(
      (o) => `${o.status} ${o.method ?? '?'} ${o.path ?? '?'} ${o.symbolId.split('#')[1] ?? ''}`,
    );
    expect(calls).toEqual([
      'INFERRED GET /stocks/{id} StockGateway.stock',
      'INFERRED POST /api/reservations StockGateway.reserve',
      'INFERRED DELETE /reservations/{id} StockGateway.release',
      'STATICALLY_RESOLVED GET /pricing/books/{isbn} PricingClient.price',
      'STATICALLY_RESOLVED POST /pricing PricingClient.create',
    ]);
    expect(symbol(result.symbols, 'StockGateway').kind).toBe('HTTP_CLIENT');
    expect(symbol(result.symbols, 'StockGateway.stock').detail?.http).toEqual([
      'GET http://stock:8080/stocks/{id}',
    ]);
    const pricing = symbol(result.symbols, 'PricingClient');
    expect(pricing.kind).toBe('HTTP_CLIENT');
    expect(pricing.detail).toMatchObject({ feignName: 'pricing', baseUrl: '${pricing.url}' });
    expect(symbol(result.symbols, 'PricingClient.price').kind).toBe('BACKEND_CALL');
    // Un client Feign déclare des appels, il ne sert pas d'endpoint.
    expect(result.endpoints).toEqual([]);
  });

  it('masque les identifiants d’une URL de configuration dans le détail', () => {
    const result = analyzeJavaSource(
      'bff',
      'BFF',
      'C.java',
      `class C { @Value("\${u}") String u; RestTemplate restTemplate; void f() { restTemplate.getForObject(u + "/x", String.class); } }`,
      { u: 'https://user:hidden@host' },
    );
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(result.outgoing[0]?.path).toBe('/x');
  });
});

describe('backend du catalogue (fixture)', () => {
  const read = (file: string): Promise<string> => readFile(path.join(FIXTURE, file), 'utf8');

  it('repository, @Query, @Transactional, exceptions, déréférencements et valeurs nulles', async () => {
    const dir = 'backend/src/main/java/org/example/catalog/books/';
    const service = analyzeJavaSource(
      'catalog',
      'BACKEND',
      dir + 'CatalogBookService.java',
      await read(dir + 'CatalogBookService.java'),
    );
    const register = symbol(service.symbols, 'CatalogBookService.register');
    expect(register.kind).toBe('TRANSACTION');
    expect(register.line).toBe(18);
    expect(register.detail).toMatchObject({
      transactional: true,
      transaction: '@Transactional',
      throws: ['DuplicateIsbnException'],
    });
    expect(register.detail?.dereferences).toContain('book.getPublisher().getName()');
    expect(register.detail?.dereferences).toContain(
      'publisherRepository.findById(body.publisherId()).orElse(null)',
    );
    expect(register.detail?.nullable).toEqual(['publisher']);
    const find = symbol(service.symbols, 'CatalogBookService.find');
    expect(find.detail).toMatchObject({ readOnly: true, throws: ['CatalogBookNotFoundException'] });
    // Appels vers les champs : laissés UNKNOWN ici, reliés par resolveCalls avec tout l'index.
    expect(service.calls.map((c) => `${c.status} ${c.text}`)).toEqual([
      'UNKNOWN catalogBookRepository.findByIsbn(body.isbn())',
      'UNKNOWN publisherRepository.findById(body.publisherId())',
      'UNKNOWN catalogBookRepository.save(book)',
      'UNKNOWN CatalogBookResponse.from(saved)',
      'UNKNOWN catalogBookRepository.findById(id)',
      'UNKNOWN CatalogBookResponse::from',
    ]);

    const repository = analyzeJavaSource(
      'catalog',
      'BACKEND',
      dir + 'CatalogBookRepository.java',
      await read(dir + 'CatalogBookRepository.java'),
    );
    expect(symbol(repository.symbols, 'CatalogBookRepository')).toMatchObject({
      kind: 'REPOSITORY',
      detail: { repositoryBase: 'JpaRepository', entity: 'CatalogBook', idType: 'Long' },
    });
    expect(symbol(repository.symbols, 'CatalogBookRepository.findByIsbn')).toMatchObject({
      kind: 'SQL_QUERY',
      line: 11,
      detail: {
        sql: 'select b from CatalogBook b where b.isbn = :isbn',
        nativeQuery: false,
        queryParams: [':isbn'],
      },
    });

    const response = analyzeJavaSource(
      'catalog',
      'BACKEND',
      dir + 'CatalogBookResponse.java',
      await read(dir + 'CatalogBookResponse.java'),
    );
    // `x == null ? … : x.getY()` : protégé, pas un déréférencement à risque.
    expect(symbol(response.symbols, 'CatalogBookResponse.from').detail).toMatchObject({
      guardedDereferences: ['book.getPublisher().getName()'],
    });
    expect(symbol(response.symbols, 'CatalogBookResponse.from').detail?.dereferences).toBeUndefined();

    const entity = analyzeJavaSource(
      'catalog',
      'BACKEND',
      dir + 'CatalogBook.java',
      await read(dir + 'CatalogBook.java'),
    );
    expect(symbol(entity.symbols, 'CatalogBook').detail).toMatchObject({
      entity: true,
      table: 'catalog_book',
      nullableRelations: ['publisher'],
    });
    const duplicate = analyzeJavaSource(
      'catalog',
      'BACKEND',
      dir + 'DuplicateIsbnException.java',
      await read(dir + 'DuplicateIsbnException.java'),
    );
    expect(symbol(duplicate.symbols, 'DuplicateIsbnException')).toMatchObject({
      kind: 'EXCEPTION',
      detail: { responseStatus: 409, extends: ['RuntimeException'] },
    });
  });

  it('repository natif, transaction de classe, requêtes dérivées et handler d’exceptions', () => {
    const result = analyzeJavaSource(
      'catalog',
      'BACKEND',
      'Misc.java',
      `
      @Repository
      public interface PublisherQueries extends CrudRepository<Publisher, Long> {
        @Modifying
        @Query(value = """
            update publisher
               set name = :name
             where id = :id
            """, nativeQuery = true)
        int rename(@Param("id") Long id, @Param("name") String name);
        List<Publisher> findByNameContaining(String name);
      }

      @Service
      @Transactional
      public class PublisherService {
        public void touch() {}
        private void internal() {}
      }

      @ControllerAdvice
      class Errors {
        @ExceptionHandler({IllegalStateException.class, IllegalArgumentException.class})
        ResponseEntity<String> bad(RuntimeException ex) {
          return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body("Requête refusée");
        }
        @ExceptionHandler
        @ResponseStatus(HttpStatus.NOT_FOUND)
        String missing(NoSuchElementException ex) { return "absent"; }
      }
    `,
    );
    expect(symbol(result.symbols, 'PublisherQueries').kind).toBe('REPOSITORY');
    expect(symbol(result.symbols, 'PublisherQueries.rename').detail).toMatchObject({
      sql: 'update publisher set name = :name where id = :id',
      nativeQuery: true,
      modifying: true,
      queryParams: [':name', ':id'],
    });
    expect(symbol(result.symbols, 'PublisherQueries.findByNameContaining').detail?.derivedQuery).toBe(true);
    expect(symbol(result.symbols, 'PublisherService.touch')).toMatchObject({
      kind: 'TRANSACTION',
      detail: { transactional: true, transactionSource: 'class' },
    });
    expect(symbol(result.symbols, 'PublisherService.internal').detail?.transactional).toBeUndefined();
    expect(symbol(result.symbols, 'Errors').kind).toBe('EXCEPTION_HANDLER');
    expect(symbol(result.symbols, 'Errors.bad')).toMatchObject({
      kind: 'EXCEPTION_HANDLER',
      detail: {
        handles: ['IllegalStateException', 'IllegalArgumentException'],
        responseStatus: 422,
        messages: ['Requête refusée'],
      },
    });
    expect(symbol(result.symbols, 'Errors.missing').detail).toMatchObject({
      handles: ['NoSuchElementException'],
      responseStatus: 404,
    });
  });

  it('BFF : le handler global transforme l’erreur du catalogue en 500', async () => {
    const file = 'bff/src/main/java/org/example/bff/books/GlobalExceptionHandler.java';
    const result = analyzeJavaSource('bff', 'BFF', file, await read(file));
    expect(symbol(result.symbols, 'GlobalExceptionHandler.catalogFailure').detail).toMatchObject({
      handles: ['HttpServerErrorException'],
      responseStatus: 500,
      messages: ['Catalog error:'],
    });
    // Appel interne à la classe : relié sans attendre l'index.
    expect(result.calls[0]).toMatchObject({
      status: 'STATICALLY_RESOLVED',
      to: `bff:${file}#GlobalExceptionHandler.error`,
    });
  });

  it('un source illisible ne lève jamais d’exception', () => {
    expect(() => analyzeJavaSource('x', 'BACKEND', 'Broken.java', 'class { void (( } } @ "')).not.toThrow();
    expect(analyzeJavaSource('x', 'BACKEND', 'Empty.java', '').symbols).toEqual([]);
  });
});

describe('configuration Spring', () => {
  it('aplatit application.yml (profils écartés) et application.properties', async () => {
    const yml = readSpringProperties(
      'application.yml',
      await readFile(path.join(FIXTURE, 'bff/src/main/resources/application.yml'), 'utf8'),
    );
    expect(yml['catalog.url']).toBe('${CATALOG_URL:http://localhost:8081}');
    expect(yml['server.port']).toBe('8080');
    const props = readSpringProperties(
      'application.properties',
      [
        '# commentaire',
        '! autre',
        'a.b=1',
        'c.d : deux mots',
        'e.f   trois',
        'long=un \\',
        '   deux',
        'esc=x\\=y\\u00e9',
      ].join('\n'),
    );
    expect(props).toEqual({ 'a.b': '1', 'c.d': 'deux mots', 'e.f': 'trois', long: 'un deux', esc: 'x=yé' });
    expect(readSpringProperties('application.yml', 'list:\n  - a\n  - b\nbroken: [')).toEqual({});
    expect(readSpringProperties('application.yml', 'list:\n  - a\n  - b\n')).toEqual({
      'list[0]': 'a',
      'list[1]': 'b',
    });
  });

  it('résout les placeholders : défaut, imbrication, clé absente signalée', () => {
    const props = {
      'catalog.url': '${CATALOG_URL:http://localhost:8081}',
      base: 'http://h',
      nested: '${base}/x',
    };
    expect(resolvePlaceholders('${catalog.url}/catalog', props)).toEqual({
      value: 'http://localhost:8081/catalog',
      resolved: true,
      unresolved: [],
    });
    expect(resolvePlaceholders('${nested}', props).value).toBe('http://h/x');
    expect(resolvePlaceholders('${a:${base}}', props).value).toBe('http://h');
    expect(resolvePlaceholders('${absent}/y', props)).toEqual({
      value: '${absent}/y',
      resolved: false,
      unresolved: ['absent'],
    });
  });
});
