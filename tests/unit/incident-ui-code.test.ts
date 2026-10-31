import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  CodeSymbol,
  Incident,
  InvestigationScope,
  SourceFileView,
  SourceTree,
} from '../../src/sdk/core/incident-contracts.js';
import {
  codeTarget,
  defaultFileFor,
  emptyCodeUi,
  INCIDENT_CODE_CSS,
  languageOf,
  lineWindow,
  reduceCode,
  renderCodeExcerpt,
  renderLayerCode,
  renderSourceTree,
  renderSourceView,
  selectedLineOf,
  tokenize,
  type CodeToken,
  type CodeUi,
  type TokenLanguage,
} from '../../src/sdk/ui/incident-code.js';
import { workspaceLinks, type WorkspaceSelection } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';

/**
 * L'EXPLORATEUR DE CODE : l'analyse lexicale (Java, TSX, YAML, XML, properties ; sans perte, linéaire,
 * jamais d'exception), le choix du langage, le visualiseur en lecture seule (lignes signalées, ligne
 * sélectionnée, symboles, ce qui mène à la ligne, fenêtre des fichiers longs, échappement), l'arborescence
 * (dossiers, recherche, hors périmètre), les onglets par couche (point de départ), l'extrait et le réducteur.
 */
const at = '2026-10-30T09:00:00.000Z';
const FIXTURE = 'tests/fixtures/incident-app';
const BACKEND_FILE = 'src/main/java/org/example/catalog/books/CatalogBookService.java';
const BFF_SERVICE_FILE = 'src/main/java/org/example/bff/books/BookService.java';
const BFF_CONTROLLER_FILE = 'src/main/java/org/example/bff/books/BookController.java';
const FRONT_FILE = 'src/books/BookForm.tsx';
const backendText = readFileSync(`${FIXTURE}/backend/${BACKEND_FILE}`, 'utf8');
const backendLines = backendText.split('\n');
const lineOfText = (needle: string): number => backendLines.findIndex((line) => line.includes(needle)) + 1;
const REGISTER_LINE = lineOfText('public CatalogBookResponse register');
const LABEL_LINE = lineOfText('setCatalogLabel');
const CLASS_LINE = lineOfText('public class CatalogBookService');

const symbol = (
  applicationId: string,
  layer: CodeSymbol['layer'],
  kind: CodeSymbol['kind'],
  file: string,
  name: string,
  line: number,
  parent?: string,
): CodeSymbol => ({
  id: `${applicationId}:${file}#${name}`,
  applicationId,
  layer,
  kind,
  name,
  file,
  line,
  ...(parent ? { parent } : {}),
});

const backendClass = symbol('backend', 'BACKEND', 'SERVICE', BACKEND_FILE, 'CatalogBookService', CLASS_LINE);
const register = symbol(
  'backend',
  'BACKEND',
  'SERVICE',
  BACKEND_FILE,
  'CatalogBookService.register',
  REGISTER_LINE,
  backendClass.id,
);
const duplicate = symbol(
  'backend',
  'BACKEND',
  'EXCEPTION',
  'src/main/java/org/example/catalog/books/DuplicateIsbnException.java',
  'DuplicateIsbnException',
  5,
);
const bffController = symbol('bff', 'BFF', 'ENDPOINT', BFF_CONTROLLER_FILE, 'BookController.create', 21);
const bffService = symbol('bff', 'BFF', 'SERVICE', BFF_SERVICE_FILE, 'BookService.create', 18);
const onSave = symbol('front', 'FRONTEND', 'EVENT_HANDLER', FRONT_FILE, 'BookForm.onSave', 20);

const scope: InvestigationScope = {
  mode: 'GUIDED',
  applications: [
    {
      id: 'front',
      name: 'books-front',
      layer: 'FRONTEND',
      repository: { root: '/repos/front', include: [] },
    },
    { id: 'bff', name: 'books-bff', layer: 'BFF', repository: { root: '/repos/bff', include: [] } },
    {
      id: 'backend',
      name: 'catalog-service',
      layer: 'BACKEND',
      repository: { root: '/repos/backend', include: [] },
    },
  ],
  scenarios: ['Créer un livre'],
  steps: [],
  endpoints: [],
  depth: 3,
  allowedHosts: [],
  logRoots: [],
  allowedCommands: [],
  permissions: {
    readSources: true,
    navigate: true,
    httpRequests: 'READ_ONLY',
    runTests: 'UNIT',
    localCommands: false,
    readLogs: false,
    openshift: 'NONE',
    sideEffects: false,
  },
  limits: { maxFiles: 500, maxFileBytes: 200000, maxDurationMs: 600000, maxRequests: 50, maxExperiments: 5 },
  extensions: [],
};

const OBSERVED = 'exception:observed:r1:NullPointerException';

function makeIncident(overrides: Partial<Incident['investigation']> = {}): Incident {
  return {
    id: 'inc_1',
    projectId: 'prj_books',
    title: 'Erreur 500 après Enregistrer',
    description: 'La création d’un livre sans éditeur échoue.',
    observed: 'erreur HTTP 500',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'Créer un livre',
    execution: { target: 'LOCAL' },
    scope,
    state: 'INVESTIGATING',
    revision: 3,
    createdAt: at,
    updatedAt: at,
    createdBy: 'qa',
    history: [],
    investigation: {
      reproductions: [
        {
          id: 'rep1',
          startedAt: at,
          finishedAt: at,
          status: 'COMPLETED',
          target: 'LOCAL',
          scenario: 'Créer un livre',
          reproduced: true,
          actions: [
            {
              index: 1,
              kind: 'click',
              description: 'click button "Enregistrer"',
              status: 'failed',
              durationMs: 120,
              requestIds: ['r1'],
            },
          ],
          requests: [
            {
              id: 'r1',
              method: 'post',
              url: 'http://books.test/api/books',
              path: '/api/books',
              status: 500,
              resourceType: 'fetch',
              step: 1,
              correlation: 'OBSERVED',
            },
          ],
          evidence: [],
          screenshots: [],
        },
      ],
      code: {
        applications: [
          { id: 'front', layer: 'FRONTEND', files: 5, skipped: 0 },
          { id: 'bff', layer: 'BFF', files: 10, skipped: 0 },
          { id: 'backend', layer: 'BACKEND', files: 10, skipped: 0 },
        ],
        symbols: [backendClass, register, duplicate, bffController, bffService, onSave],
        endpoints: [],
        outgoing: [],
        calls: [],
        denied: [],
        truncated: [],
      },
      graph: {
        nodes: [
          { id: 'incident', kind: 'INCIDENT', label: 'Incident', layer: 'UNKNOWN', evidence: [] },
          { id: 'action:1', kind: 'ACTION', label: 'Enregistrer', layer: 'FRONTEND', evidence: [] },
          { id: 'request:r1', kind: 'REQUEST', label: 'POST /api/books', layer: 'NETWORK', evidence: ['r1'] },
          {
            id: 'bff-endpoint',
            kind: 'BFF_ENDPOINT',
            label: 'POST /api/books (BFF)',
            layer: 'BFF',
            evidence: [],
            symbolId: bffController.id,
          },
          {
            id: 'bff-service',
            kind: 'BFF_SERVICE',
            label: 'BookService.create',
            layer: 'BFF',
            evidence: [],
            symbolId: bffService.id,
          },
          {
            id: 'backend-service',
            kind: 'BACKEND_SERVICE',
            label: 'CatalogBookService.register',
            layer: 'BACKEND',
            evidence: [],
            symbolId: register.id,
          },
          {
            id: `exception:code:${duplicate.id}`,
            kind: 'EXCEPTION',
            label: 'DuplicateIsbnException',
            layer: 'BACKEND',
            evidence: [duplicate.id],
            symbolId: duplicate.id,
          },
          {
            id: OBSERVED,
            kind: 'EXCEPTION',
            label: 'NullPointerException',
            layer: 'BACKEND',
            evidence: ['r1'],
          },
        ],
        edges: [
          { from: 'incident', to: 'action:1', status: 'OBSERVED', reason: 'scénario', evidence: [] },
          { from: 'action:1', to: 'request:r1', status: 'OBSERVED', reason: 'clic', evidence: ['r1'] },
          {
            from: 'request:r1',
            to: 'bff-endpoint',
            status: 'STATICALLY_RESOLVED',
            reason: 'route',
            evidence: [],
          },
          {
            from: 'bff-endpoint',
            to: 'bff-service',
            status: 'STATICALLY_RESOLVED',
            reason: 'appel',
            evidence: [],
          },
          {
            from: 'bff-service',
            to: 'backend-service',
            status: 'INFERRED',
            reason: 'client HTTP',
            evidence: [],
          },
          {
            from: 'backend-service',
            to: `exception:code:${duplicate.id}`,
            status: 'STATICALLY_RESOLVED',
            reason: 'lève',
            evidence: [],
          },
          { from: 'request:r1', to: OBSERVED, status: 'OBSERVED', reason: 'corps', evidence: ['r1'] },
          { from: 'backend-service', to: OBSERVED, status: 'INFERRED', reason: 'déréférence', evidence: [] },
        ],
      },
      hypotheses: [
        {
          id: 'h1',
          title: 'Éditeur absent non vérifié',
          description: 'getPublisher() renvoie null quand aucun éditeur n’est choisi.',
          suspectedCause: 'déréférencement',
          layer: 'BACKEND',
          files: [BACKEND_FILE],
          supporting: [{ ref: register.id, fact: 'déréférence getPublisher()' }],
          contradicting: [],
          confidence: 0.7,
          verifications: [],
          status: 'SUPPORTED',
        },
      ],
      experiments: [],
      timeline: [
        {
          id: 'ev-500',
          order: 2,
          layer: 'BACKEND',
          kind: 'RESPONSE',
          status: 'ERROR',
          summary: 'Réponse 500 de POST /api/books',
          evidence: ['r1'],
          requestId: 'r1',
          step: 1,
          reproduction: 'rep1',
          source: { applicationId: 'backend', layer: 'BACKEND', file: BACKEND_FILE, line: LABEL_LINE },
        },
      ],
      ...overrides,
    },
  };
}

function context(
  selection?: WorkspaceSelection,
  incident: Incident = makeIncident(),
  options: { lang?: 'fr' | 'en'; can?: boolean } = {},
): WorkspaceContext {
  return workspaceContext({
    incident,
    lang: options.lang ?? 'fr',
    links: workspaceLinks(incident),
    demo: false,
    can: () => options.can ?? true,
    ...(selection ? { selection } : {}),
  });
}

const backendView = (overrides: Partial<SourceFileView> = {}): SourceFileView => ({
  applicationId: 'backend',
  layer: 'BACKEND',
  file: BACKEND_FILE,
  language: 'java',
  text: backendText,
  symbols: [backendClass, register],
  highlights: [
    {
      line: LABEL_LINE,
      kind: 'ERROR',
      reason: 'NullPointerException : getPublisher() renvoie null',
      refs: [OBSERVED],
    },
    {
      line: REGISTER_LINE,
      kind: 'PATH',
      reason: 'Appelé par BookService.create (déduit)',
      refs: ['backend-service'],
    },
    {
      line: REGISTER_LINE + 4,
      endLine: REGISTER_LINE + 6,
      kind: 'HYPOTHESIS',
      reason: 'Hypothèse h1',
      refs: ['h1'],
    },
    { line: CLASS_LINE, kind: 'SYMBOL', reason: 'Service du catalogue', refs: [backendClass.id] },
  ],
  ...overrides,
});

const tree: SourceTree = {
  applications: [
    {
      applicationId: 'front',
      name: 'books-front',
      layer: 'FRONTEND',
      files: ['src/books/BookForm.tsx', 'src/books/books-api.ts', 'src/books/types.ts', 'package.json'],
      truncated: false,
    },
    {
      applicationId: 'bff',
      name: 'books-bff',
      layer: 'BFF',
      files: [BFF_CONTROLLER_FILE, BFF_SERVICE_FILE, 'src/main/resources/application.yml', 'pom.xml'],
      truncated: false,
    },
    {
      applicationId: 'backend',
      name: 'catalog-service',
      layer: 'BACKEND',
      files: [
        BACKEND_FILE,
        'src/main/java/org/example/catalog/books/DuplicateIsbnException.java',
        'src/main/java/org/example/catalog/CatalogApplication.java',
        'src/main/resources/application.properties',
      ],
      truncated: true,
    },
  ],
  denied: [{ path: '/repos/backend/../secrets/vault.yml', reason: 'Hors de la racine du dépôt (READ_FILE)' }],
};

const joined = (tokens: readonly CodeToken[]): string => tokens.map((token) => token.text).join('');
const ofType = (tokens: readonly CodeToken[], type: CodeToken['type']): string[] =>
  tokens.filter((token) => token.type === type).map((token) => token.text);
const rows = (html: string): string[] =>
  [...html.matchAll(/data-code-line="(\d+)"/g)].map((match) => match[1] ?? '');

describe('tokenize', () => {
  it('Java: annotations, strings with escapes, char literals, text blocks, comments, numbers, types', () => {
    const source = [
      '/** Javadoc */',
      '@RestController',
      '@RequestMapping("/api/books")',
      'public class BookController { // fin de ligne',
      '  private static final long LIMIT = 10_000L;',
      '  String quote = "il dit \\"bonjour\\" puis \\\\";',
      "  char c = '\\'';",
      '  String sql = """',
      '      SELECT * FROM book WHERE title = "x"',
      '      """;',
      '  public @interface Marker {}',
      '  Object none = null; boolean yes = true;',
      '}',
    ].join('\n');
    const tokens = tokenize(source, 'java');
    expect(joined(tokens)).toBe(source);
    expect(ofType(tokens, 'annotation')).toEqual(['@RestController', '@RequestMapping']);
    expect(ofType(tokens, 'comment')).toEqual(['/** Javadoc */', '// fin de ligne']);
    const strings = ofType(tokens, 'string');
    expect(strings).toContain('"/api/books"');
    expect(strings).toContain('"il dit \\"bonjour\\" puis \\\\"');
    expect(strings).toContain("'\\''");
    expect(strings).toContain('"""\n      SELECT * FROM book WHERE title = "x"\n      """');
    expect(ofType(tokens, 'number')).toEqual(['10_000L', 'null', 'true']);
    expect(ofType(tokens, 'keyword')).toEqual(
      expect.arrayContaining(['public', 'class', 'private', 'static', 'final', 'long', 'char', '@interface']),
    );
    expect(ofType(tokens, 'type')).toEqual(expect.arrayContaining(['BookController', 'String', 'Object']));
    // Les constantes en capitales ne sont pas des types.
    expect(ofType(tokens, 'type')).not.toContain('LIMIT');
  });

  it('Java: unterminated strings, comments and text blocks stop cleanly', () => {
    const unterminatedString = 'String a = "pas fermé\nint b = 2;';
    const tokens = tokenize(unterminatedString, 'java');
    expect(joined(tokens)).toBe(unterminatedString);
    expect(ofType(tokens, 'string')).toEqual(['"pas fermé']);
    expect(ofType(tokens, 'keyword')).toContain('int');
    for (const broken of ['/* jamais fermé\nclass A {}', 'String s = """\nsans fin', "char c = '\\", '@'])
      expect(joined(tokenize(broken, 'java'))).toBe(broken);
    expect(tokenize('/* jamais fermé\nclass A {}', 'java')).toEqual([
      { type: 'comment', text: '/* jamais fermé\nclass A {}' },
    ]);
  });

  it('TSX: tags, attributes, JSX text, expressions, templates and regexes; generics are not tags', () => {
    const source = [
      "import { useState } from 'react';",
      'const ISBN = /^(97[89])?\\d{9}[\\dX]$/;',
      'export function BookForm({ title }: { title: string }) {',
      '  const [values] = useState<BookFormValues>(EMPTY);',
      '  const label = `Livre « ${title.trim()} » enregistré`;',
      '  return (',
      '    <form onSubmit={onSave} aria-label="Nouveau livre">',
      "      <p>L'ISBN</p>",
      '      {errors.title && <p className="error">{errors.title}</p>}',
      '      <Button disabled={saving} />',
      '    </form>',
      '  );',
      '}',
    ].join('\n');
    const tokens = tokenize(source, 'typescript');
    expect(joined(tokens)).toBe(source);
    const tags = ofType(tokens, 'tag');
    expect(tags).toEqual(['<form', '>', '<p>', '</p>', '<p', '>', '</p>', '<Button', '/>', '</form>']);
    expect(ofType(tokens, 'type')).toEqual(
      expect.arrayContaining([
        'onSubmit',
        'aria-label',
        'className',
        'disabled',
        'BookFormValues',
        'BookForm',
      ]),
    );
    const strings = ofType(tokens, 'string');
    expect(strings).toContain('/^(97[89])?\\d{9}[\\dX]$/');
    expect(strings).toContain('`Livre « ');
    expect(strings).toContain(' » enregistré`');
    expect(strings).toContain('"Nouveau livre"');
    // L'apostrophe du texte JSX n'ouvre pas de chaîne.
    expect(strings.some((text) => text.includes("'ISBN"))).toBe(false);
    expect(tokens.some((token) => token.type === 'plain' && token.text.includes("L'ISBN"))).toBe(true);
    expect(ofType(tokens, 'keyword')).toEqual(
      expect.arrayContaining(['import', 'from', 'export', 'const', 'return']),
    );
  });

  it('TypeScript without JSX: `<T>` stays a generic, division is not a regex', () => {
    const source = 'const id = <T,>(x: T): T => x;\nconst half = total / 2 / 3;';
    const tokens = tokenize(source, 'typescript', { jsx: false });
    expect(joined(tokens)).toBe(source);
    expect(ofType(tokens, 'tag')).toEqual([]);
    expect(ofType(tokens, 'string')).toEqual([]);
  });

  it('YAML: keys, comments, numbers, placeholders, documents, block scalars, sequences', () => {
    const source = [
      'server:',
      '  port: 8080 # le port',
      'catalog:',
      '  url: ${CATALOG_URL:http://localhost:8081}',
      '  name: "books-bff"',
      '  enabled: true',
      '---',
      'notes: |',
      '  ligne: pas une clé',
      '  # pas un commentaire',
      'items:',
      '  - first',
      '  - key: value',
      'anchor: &base {a: 1}',
    ].join('\n');
    const tokens = tokenize(source, 'yaml');
    expect(joined(tokens)).toBe(source);
    expect(ofType(tokens, 'keyword')).toEqual([
      'server',
      'port',
      'catalog',
      'url',
      'name',
      'enabled',
      '---',
      'notes',
      'items',
      'key',
      'anchor',
    ]);
    expect(ofType(tokens, 'comment')).toEqual(['# le port']);
    expect(ofType(tokens, 'number')).toEqual(['8080', 'true', '1']);
    expect(ofType(tokens, 'annotation')).toEqual(['${CATALOG_URL:http://localhost:8081}', '&base']);
    expect(ofType(tokens, 'string')).toEqual([
      '"books-bff"',
      '\n  ligne: pas une clé\n  # pas un commentaire',
    ]);
  });

  it('properties: key=value colouring, comments, placeholders, continued lines', () => {
    const source = readFileSync(`${FIXTURE}/backend/src/main/resources/application.properties`, 'utf8');
    const tokens = tokenize(source, 'properties');
    expect(joined(tokens)).toBe(source);
    expect(ofType(tokens, 'keyword')).toContain('server.error.include-message');
    expect(ofType(tokens, 'string')).toContain('jdbc:h2:mem:catalog');
    expect(ofType(tokens, 'number')).toEqual(['8081', 'true']);
    expect(ofType(tokens, 'comment')).toHaveLength(1);
    const continued = tokenize('a.url = ${BASE}/x \\\n  /suite\nb=1', 'properties');
    expect(ofType(continued, 'annotation')).toEqual(['${BASE}']);
    expect(ofType(continued, 'keyword')).toEqual(['a.url', 'b']);
  });

  it('XML: declaration, comments, tags, attributes, CDATA, entities', () => {
    const source = readFileSync(`${FIXTURE}/bff/pom.xml`, 'utf8');
    const tokens = tokenize(source, 'xml');
    expect(joined(tokens)).toBe(source);
    expect(ofType(tokens, 'annotation')[0]).toMatch(/^<\?xml/);
    expect(ofType(tokens, 'tag')).toEqual(expect.arrayContaining(['<project', '<dependency>', '</project>']));
    const small = tokenize('<!-- c --><a href="x &amp; y">t &lt; u<![CDATA[<raw>]]></a>', 'xml');
    expect(ofType(small, 'comment')).toEqual(['<!-- c -->']);
    expect(ofType(small, 'type')).toEqual(['href']);
    expect(ofType(small, 'string')).toEqual(['"x &amp; y"', '<![CDATA[<raw>]]>']);
    expect(ofType(small, 'annotation')).toEqual(['&lt;']);
  });

  it('the fixture sources are tokenized without loss', () => {
    const files: [string, TokenLanguage][] = [
      [`${FIXTURE}/frontend/src/books/BookForm.tsx`, 'typescript'],
      [`${FIXTURE}/frontend/src/books/validation.ts`, 'typescript'],
      [`${FIXTURE}/bff/src/main/java/org/example/bff/books/GlobalExceptionHandler.java`, 'java'],
      [`${FIXTURE}/backend/${BACKEND_FILE}`, 'java'],
      [`${FIXTURE}/bff/src/main/resources/application.yml`, 'yaml'],
    ];
    for (const [file, language] of files) {
      const text = readFileSync(file, 'utf8');
      const tokens = tokenize(text, language);
      expect(joined(tokens), file).toBe(text);
      expect(tokens.every((token) => token.text.length > 0)).toBe(true);
    }
  });

  it('never throws on garbage, stays lossless, and runs in linear time on pathological input', () => {
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = '<>/{}()[]"\'`$@#*!&|:=-.\\\n\t aZ09é 😀';
    const languages: TokenLanguage[] = ['typescript', 'java', 'yaml', 'xml', 'properties', 'text'];
    for (let round = 0; round < 300; round += 1) {
      const length = Math.floor(random() * 120);
      let text = '';
      for (let index = 0; index < length; index += 1)
        text += alphabet.charAt(Math.floor(random() * alphabet.length));
      for (const language of languages) {
        const tokens = tokenize(text, language);
        expect(joined(tokens)).toBe(text);
      }
    }
    expect(tokenize('', 'java')).toEqual([]);
    const pathological = ['(/'.repeat(60000), '"'.repeat(120000), '<a '.repeat(40000), '`${'.repeat(40000)];
    const started = Date.now();
    for (const text of pathological)
      for (const language of languages) expect(joined(tokenize(text, language)).length).toBe(text.length);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('languageOf', () => {
  it('maps extensions to the viewer languages', () => {
    const cases: [string, string][] = [
      ['src/books/BookForm.tsx', 'typescript'],
      ['src/a.ts', 'typescript'],
      ['src/a.js', 'typescript'],
      ['src/a.jsx', 'typescript'],
      ['src/a.mjs', 'typescript'],
      ['src/a.cjs', 'typescript'],
      ['src/App.vue', 'typescript'],
      ['src/main/java/A.java', 'java'],
      ['application.yml', 'yaml'],
      ['config/app.YAML', 'yaml'],
      ['pom.xml', 'xml'],
      ['pom', 'xml'],
      ['application.properties', 'text'],
      ['README.md', 'text'],
      ['Dockerfile', 'text'],
    ];
    for (const [file, language] of cases) expect(languageOf(file), file).toBe(language);
  });
});

describe('renderSourceView', () => {
  it('renders a read-only viewer: breadcrumb, gutter, token classes, no editing control', () => {
    const html = renderSourceView(context(), emptyCodeUi(), backendView());
    expect(html).toContain('Lecture seule');
    expect(html).toContain('catalog-service');
    expect(html).toContain('<span class="ws-code-layer">Backend</span>');
    expect(html).toContain('<li aria-current="page"><b>CatalogBookService.java</b></li>');
    expect(html).toContain('<td class="ws-code-num" aria-hidden="true">1</td>');
    expect(html).toContain('<span class="ws-code-a">@Service</span>');
    expect(html).toContain('<span class="ws-code-k">public</span>');
    expect(html).toContain('<span class="ws-code-c">// Le libellé du catalogue');
    expect(rows(html)).toHaveLength(backendLines.length - 1);
    expect(html).not.toMatch(/<textarea|contenteditable|<input/);
  });

  it('flags highlighted lines with distinct classes, gutter markers and reasons', () => {
    const html = renderSourceView(context(), emptyCodeUi(), backendView());
    const row = (line: number): string =>
      new RegExp(`<tr class="([^"]*)" data-code-line="${String(line)}"([^>]*)>`)
        .exec(html)
        ?.slice(1)
        .join(' ') ?? '';
    expect(row(LABEL_LINE)).toContain('ws-code-hl-error');
    expect(row(LABEL_LINE)).toContain('title="Erreur : NullPointerException : getPublisher() renvoie null"');
    expect(row(REGISTER_LINE)).toContain('ws-code-hl-path');
    for (const line of [REGISTER_LINE + 4, REGISTER_LINE + 5, REGISTER_LINE + 6])
      expect(row(line)).toContain('ws-code-hl-hypothesis');
    expect(row(REGISTER_LINE + 7)).not.toContain('ws-code-hl-hypothesis');
    expect(row(CLASS_LINE)).toContain('ws-code-hl-symbol');
    expect(html).toContain('<span class="ws-code-m">!</span>');
    expect(html).toContain('<span class="ws-code-m">?</span>');
    // La liste des lignes signalées : des boutons « aller à la ligne ».
    expect(html).toContain('Lignes signalées');
    expect(html).toContain(
      `data-action="ws-code-goto" data-app="backend" data-file="${BACKEND_FILE}" data-line="${String(LABEL_LINE)}"`,
    );
    // Le chemin analysé n'est pas présenté comme une trace d'exécution.
    expect(html).toContain('pas une trace d’exécution');
  });

  it('the selected line comes from the shared selection (sourceOf) or from a local goto', () => {
    const ui = emptyCodeUi();
    // Rien de sélectionné, rien d'ouvert : le point de départ de la couche (register) est la ligne visée.
    expect(selectedLineOf(context(), ui, backendView())).toBe(REGISTER_LINE);
    // L'événement de la chronologie pointe la ligne de l'erreur.
    const ctx = context({ kind: 'event', id: 'ev-500' });
    const html = renderSourceView(ctx, ui, backendView());
    expect(html).toMatch(new RegExp(`class="[^"]*ws-code-sel[^"]*" data-code-line="${String(LABEL_LINE)}"`));
    expect(html.match(/ws-code-sel/g)).toHaveLength(1);
    expect(html).toContain(`Ligne ${String(LABEL_LINE)}, ligne sélectionnée`);
    // Un « aller à la ligne » sous cette sélection l'emporte…
    const moved = reduceCode(ui, 'ws-code-goto', {
      app: 'backend',
      file: BACKEND_FILE,
      line: '3',
      sel: 'event:ev-500',
    });
    expect(moved).toBeDefined();
    expect(selectedLineOf(ctx, moved ?? ui, backendView())).toBe(3);
    // … jusqu'à ce que la sélection change : l'endroit de la nouvelle sélection reprend la main.
    expect(selectedLineOf(context({ kind: 'symbol', id: register.id }), moved ?? ui, backendView())).toBe(
      REGISTER_LINE,
    );
    // Une sélection hors de ce fichier laisse la ligne choisie.
    expect(selectedLineOf(context({ kind: 'symbol', id: onSave.id }), moved ?? ui, backendView())).toBe(3);
  });

  it('lists the symbols of the file: selectable symbol and goto buttons', () => {
    const html = renderSourceView(context({ kind: 'symbol', id: register.id }), emptyCodeUi(), backendView());
    expect(html).toContain('Symboles du fichier');
    expect(html).toContain(
      `data-action="ws-select" data-kind="symbol" data-ref="${register.id}" data-ws-state="selected" aria-pressed="true"`,
    );
    expect(html).toContain(
      `data-action="ws-code-goto" data-app="backend" data-file="${BACKEND_FILE}" data-line="${String(REGISTER_LINE)}" data-sel="symbol:${register.id}"`,
    );
    expect(html).toContain(`>:${String(REGISTER_LINE)}</button>`);
    expect(html).toContain('ws-code-sym ws-code-child ws-code-on');
    // Les symboles cités par l'investigation sont marqués.
    expect(html).toContain('concerné');
    const none = renderSourceView(context(), emptyCodeUi(), backendView({ symbols: [] }));
    expect(none).toContain('Aucun symbole indexé dans ce fichier.');
  });

  it('shows what leads to the selected line: graph nodes, hypotheses, timeline, requests', () => {
    const html = renderSourceView(context({ kind: 'event', id: 'ev-500' }), emptyCodeUi(), backendView());
    expect(html).toContain(`Ce qui mène à la ligne ${String(LABEL_LINE)}`);
    expect(html).toContain('Symbole englobant');
    expect(html).toContain('NullPointerException : getPublisher() renvoie null');
    expect(html).toContain(`data-kind="node" data-ref="${OBSERVED}"`);
    expect(html).toContain('data-kind="node" data-ref="backend-service"');
    expect(html).toContain('data-kind="hypothesis" data-ref="h1"');
    expect(html).toContain('Étayée');
    expect(html).toContain('data-kind="event" data-ref="ev-500"');
    expect(html).toContain('data-kind="request" data-ref="r1"');
    expect(html).toContain('<code>POST /api/books</code>');
    // Sans ligne visée, le panneau invite à en choisir une et cite les hypothèses du fichier.
    const loose = renderSourceView(
      context(undefined, makeIncident({ graph: { nodes: [], edges: [] } })),
      emptyCodeUi(),
      backendView({ highlights: [] }),
    );
    expect(loose).toContain('Sélectionnez une ligne signalée ou un symbole');
    expect(loose).toContain('Hypothèses qui citent ce fichier');
  });

  it('escapes the code, the paths and the reasons', () => {
    const view = backendView({
      file: 'src/<img src=x onerror=alert(1)>.ts',
      language: 'typescript',
      text: 'const a = "</pre><script>alert(1)</script>";\n<script>evil()</script>\n',
      symbols: [],
      highlights: [{ line: 1, kind: 'ERROR', reason: '<b onclick="x">', refs: [] }],
    });
    const html = renderSourceView(context(), emptyCodeUi(), view);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b onclick');
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b onclick=&quot;x&quot;&gt;');
    expect(renderCodeExcerpt(context(), view, 2)).not.toContain('<script>');
  });

  it('renders at most 2000 lines around the target of a long file, with a notice', () => {
    const text = Array.from(
      { length: 5000 },
      (_, index) => `int v${String(index + 1)} = ${String(index)};`,
    ).join('\n');
    const view = backendView({ text, symbols: [], highlights: [] });
    const ui = reduceCode(emptyCodeUi(), 'ws-code-open', {
      app: 'backend',
      file: BACKEND_FILE,
      line: '4000',
    });
    const html = renderSourceView(context(), ui ?? emptyCodeUi(), view);
    const shown = rows(html);
    expect(shown).toHaveLength(2000);
    expect(shown[0]).toBe('3000');
    expect(shown.at(-1)).toBe('4999');
    expect(html).toContain('Fichier long : lignes 3000 à 4999 sur 5000');
    expect(html).toContain('ws-code-sel');
    expect(lineWindow(5000, 4990)).toEqual({ from: 3001, to: 5000 });
    expect(lineWindow(5000, 1)).toEqual({ from: 1, to: 2000 });
    expect(lineWindow(12, 9)).toEqual({ from: 1, to: 12 });
  });

  it('panel states: loading, error with retry, no file, denied, empty file; English texts', () => {
    expect(renderSourceView(context(), emptyCodeUi(), undefined, 'loading')).toContain('aria-busy="true"');
    const error = renderSourceView(context(), emptyCodeUi(), undefined, { error: 'Fichier hors périmètre' });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Fichier hors périmètre');
    expect(error).toContain('data-action="ws-code-reload"');
    expect(renderSourceView(context(), emptyCodeUi(), undefined)).toContain('Sélectionnez un fichier');
    expect(
      renderSourceView(context(undefined, makeIncident(), { can: false }), emptyCodeUi(), backendView()),
    ).toContain('ne permet pas de lire le code');
    expect(renderSourceView(context(), emptyCodeUi(), backendView({ text: '' }))).toContain(
      'Ce fichier est vide.',
    );
    const english = renderSourceView(
      context(undefined, makeIncident(), { lang: 'en' }),
      emptyCodeUi(),
      backendView(),
    );
    expect(english).toContain('Read only');
    expect(english).toContain('Flagged lines');
  });
});

describe('renderSourceTree', () => {
  it('lists applications with layer, compact collapsible folders, files to open and their state', () => {
    const html = renderSourceTree(context({ kind: 'event', id: 'ev-500' }), emptyCodeUi(), tree);
    expect(html).toContain('books-front');
    expect(html).toContain('<span class="ws-code-layer">BFF</span>');
    // Une chaîne de dossiers sans fichier se lit d'un trait.
    // Le nom complet reste dans `title` : l'affichage peut l'abréger par des points de suspension.
    expect(html).toContain('title="java/org/example/catalog"><svg class="ico"');
    expect(html).toContain('<span class="ws-code-fname">java/org/example/catalog</span>');
    expect(html).toContain(
      'data-action="ws-code-folder" data-folder="backend:src/main/java/org/example/catalog"',
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(
      `data-action="ws-code-open" data-app="backend" data-file="${BACKEND_FILE}" data-layer="BACKEND"`,
    );
    // Le fichier affiché (celui de la sélection) et l'état de sélection `file`.
    expect(html).toMatch(/class="ws-code-file ws-code-cur ws-related"[^>]*aria-current="true"/);
    // Les fichiers cités par l'investigation sont « concernés ».
    const backendItem = html.slice(html.indexOf(`data-file="${BACKEND_FILE}"`));
    expect(backendItem.slice(0, backendItem.indexOf('</li>'))).toContain('concerné');
    // Liste partielle signalée.
    expect(html).toContain('Liste partielle');
    expect(html).toContain('data-ws-field="code-search"');
  });

  it('folders follow the explicit state of the reducer', () => {
    const key = 'backend:src/main/java/org/example/catalog';
    const collapsed = reduceCode(emptyCodeUi(), 'ws-code-folder', { folder: key, open: 'true' });
    expect(collapsed?.folders[key]).toBe(false);
    const html = renderSourceTree(context(), collapsed ?? emptyCodeUi(), tree);
    expect(html).toContain(`data-folder="${key}" data-open="false" aria-expanded="false"`);
    expect(html).not.toContain(`data-file="${BACKEND_FILE}"`);
    expect(html).toContain('Déplier le dossier java/org/example/catalog');
  });

  it('the search narrows files by name (or by path with a slash)', () => {
    const ui: CodeUi = { ...emptyCodeUi(), search: 'service' };
    const html = renderSourceTree(context(), ui, tree);
    expect(html).toContain(`data-file="${BACKEND_FILE}"`);
    expect(html).toContain(`data-file="${BFF_SERVICE_FILE}"`);
    expect(html).not.toContain(`data-file="${BFF_CONTROLLER_FILE}"`);
    expect(html).toContain('2 fichier(s) trouvé(s)');
    // Texte d'état simple : pas de zone live recréée à chaque dessin.
    expect(html).not.toContain('aria-live');
    expect(html).toContain('data-action="ws-code-search-clear"');
    expect(html).toContain('value="service"');
    const byPath = renderSourceTree(context(), { ...emptyCodeUi(), search: 'resources/' }, tree);
    expect(byPath).toContain('application.yml');
    expect(byPath).toContain('application.properties');
    expect(byPath).not.toContain('BookForm.tsx');
    expect(renderSourceTree(context(), { ...emptyCodeUi(), search: 'zzz' }, tree)).toContain(
      'Aucun fichier ne correspond à la recherche.',
    );
  });

  it('lists the paths refused by the scope with their reason, and restricts to a layer', () => {
    const html = renderSourceTree(context(), emptyCodeUi(), tree);
    expect(html).toContain('Hors périmètre (1)');
    expect(html).toContain('/repos/backend/../secrets/vault.yml');
    expect(html).toContain('Hors de la racine du dépôt (READ_FILE)');
    const bff = renderSourceTree(context(), emptyCodeUi(), tree, undefined, 'BFF');
    expect(bff).toContain('books-bff');
    expect(bff).not.toContain('catalog-service');
    expect(bff).not.toContain('books-front');
    expect(renderSourceTree(context(), emptyCodeUi(), undefined)).toContain('aria-busy="true"');
    expect(renderSourceTree(context(), emptyCodeUi(), undefined, { error: 'refus' })).toContain('refus');
  });
});

describe('layer tabs', () => {
  it('defaultFileFor: the deepest node of the layer on the error path, else the first one', () => {
    const ctx = context();
    // Le backend : le service qui déréférence (la DuplicateIsbnException lue dans le code n'est pas sur le chemin).
    expect(defaultFileFor(ctx, 'BACKEND')).toMatchObject({
      applicationId: 'backend',
      file: BACKEND_FILE,
      line: REGISTER_LINE,
    });
    expect(defaultFileFor(ctx, 'BFF')).toMatchObject({
      applicationId: 'bff',
      file: BFF_SERVICE_FILE,
      line: 18,
    });
    // Sans exception : le premier nœud de la couche.
    const graph = makeIncident().investigation.graph;
    const noException = makeIncident({
      graph: {
        nodes: (graph?.nodes ?? []).filter((node) => node.kind !== 'EXCEPTION'),
        edges: (graph?.edges ?? []).filter((edge) => !edge.to.startsWith('exception:')),
      },
    });
    expect(defaultFileFor(context(undefined, noException), 'BFF')).toMatchObject({
      file: BFF_CONTROLLER_FILE,
    });
    // Le frontend : aucun nœud de code, la traçabilité frontend donne le handler.
    expect(defaultFileFor(ctx, 'FRONTEND')).toBeUndefined();
    const traced = makeIncident({
      frontendTrace: {
        reproduction: 'rep1',
        limitations: [],
        steps: [
          {
            index: 1,
            action: { kind: 'click', description: 'Enregistrer', status: 'failed', evidence: [] },
            handler: {
              label: 'onSave',
              status: 'INFERRED',
              reason: 'gestionnaire du formulaire',
              evidence: [],
              symbolId: onSave.id,
              source: { applicationId: 'front', layer: 'FRONTEND', file: FRONT_FILE, line: 20 },
            },
            services: [],
            httpClients: [],
            requests: [],
            console: [],
            jsErrors: [],
          },
        ],
      },
    });
    expect(defaultFileFor(context(undefined, traced), 'FRONTEND')).toMatchObject({
      file: FRONT_FILE,
      line: 20,
    });
  });

  it('codeTarget: the opened file while the selection is unchanged, else the selection, else the start', () => {
    expect(codeTarget(context(), emptyCodeUi(), 'BACKEND', tree)).toMatchObject({ line: REGISTER_LINE });
    const opened = reduceCode(emptyCodeUi(), 'ws-code-open', {
      app: 'backend',
      file: 'src/main/resources/application.properties',
      sel: '',
    });
    expect(codeTarget(context(), opened ?? emptyCodeUi(), 'BACKEND', tree)).toMatchObject({
      file: 'src/main/resources/application.properties',
      line: 1,
    });
    // Une autre couche n'est pas touchée.
    expect(codeTarget(context(), opened ?? emptyCodeUi(), 'BFF', tree)).toMatchObject({
      file: BFF_SERVICE_FILE,
    });
    // Une nouvelle sélection dans le backend reprend la main.
    expect(
      codeTarget(context({ kind: 'event', id: 'ev-500' }), opened ?? emptyCodeUi(), 'BACKEND', tree),
    ).toMatchObject({ file: BACKEND_FILE, line: LABEL_LINE });
  });

  it('renderLayerCode: involved items, restricted tree, viewer on the target file', () => {
    const ctx = context();
    const html = renderLayerCode(ctx, emptyCodeUi(), 'BACKEND', tree, backendView());
    expect(html).toContain('Code Backend');
    expect(html).toContain('En jeu dans l’investigation');
    expect(html).toContain('data-kind="node" data-ref="backend-service"');
    expect(html).toContain('Point de départ');
    expect(html).toContain('catalog-service');
    expect(html).not.toContain('books-bff');
    expect(html).toContain(
      `data-file="${BACKEND_FILE}" aria-label="Code source de ${BACKEND_FILE} (lecture seule)"`,
    );
    expect(html).toContain('ws-code-sel');
    // Sans fichier lu : le point de départ à ouvrir.
    const waiting = renderLayerCode(ctx, emptyCodeUi(), 'BFF', tree, undefined);
    expect(waiting).toContain(
      `data-action="ws-code-open" data-app="bff" data-file="${BFF_SERVICE_FILE}" data-line="18"`,
    );
    expect(waiting).toContain('Point de départ : BookService.java, ligne 18');
    // Un fichier d'une autre couche n'est pas affiché dans cet onglet.
    expect(renderLayerCode(ctx, emptyCodeUi(), 'BFF', tree, backendView())).not.toContain('ws-code-table');
    expect(renderLayerCode(ctx, emptyCodeUi(), 'BFF', tree, undefined, 'loading')).toContain(
      'Lecture du fichier…',
    );
    // Une couche absente du périmètre.
    const noFront = makeIncident();
    noFront.scope = {
      ...scope,
      applications: scope.applications.filter((entry) => entry.layer !== 'FRONTEND'),
    };
    const frontless: SourceTree = {
      ...tree,
      applications: tree.applications.filter((entry) => entry.layer !== 'FRONTEND'),
    };
    expect(
      renderLayerCode(context(undefined, noFront), emptyCodeUi(), 'FRONTEND', frontless, undefined),
    ).toContain('Aucune application Frontend dans le périmètre.');
  });
});

describe('renderCodeExcerpt', () => {
  it('shows a few lines around the location, bounded by the file', () => {
    const ctx = context();
    const view = backendView();
    const middle = renderCodeExcerpt(ctx, view, LABEL_LINE, 2);
    expect(rows(middle)).toEqual(
      [LABEL_LINE - 2, LABEL_LINE - 1, LABEL_LINE, LABEL_LINE + 1, LABEL_LINE + 2].map(String),
    );
    expect(middle).toMatch(
      new RegExp(`ws-code-hl-error ws-code-sel" data-code-line="${String(LABEL_LINE)}"`),
    );
    expect(middle).toContain(
      `data-action="ws-code-open" data-app="backend" data-file="${BACKEND_FILE}" data-line="${String(LABEL_LINE)}"`,
    );
    expect(middle).toContain('Lecture seule');
    expect(rows(renderCodeExcerpt(ctx, view, 1))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    const total = backendLines.length - 1;
    expect(rows(renderCodeExcerpt(ctx, view, 9999)).at(-1)).toBe(String(total));
    expect(rows(renderCodeExcerpt(ctx, view, 9999))).toHaveLength(7);
    expect(rows(renderCodeExcerpt(ctx, view, -5, 0))).toEqual(['1']);
    expect(renderCodeExcerpt(ctx, undefined, 3)).toBe('');
  });
});

describe('reduceCode', () => {
  it('opens files (one per application, most recent first), goes to lines, toggles folders, searches', () => {
    let ui: CodeUi = emptyCodeUi();
    ui = reduceCode(ui, 'ws-code-open', { app: 'backend', file: 'A.java', line: '12', sel: 'node:x' }) ?? ui;
    expect(ui.open).toEqual([{ applicationId: 'backend', file: 'A.java', line: 12, anchor: 'node:x' }]);
    ui = reduceCode(ui, 'ws-code', { app: 'bff', file: 'B.java', line: '3' }) ?? ui;
    ui = reduceCode(ui, 'ws-code-open', { app: 'backend', file: 'C.java' }) ?? ui;
    expect(ui.open.map((cursor) => `${cursor.applicationId}:${cursor.file}:${String(cursor.line)}`)).toEqual([
      'backend:C.java:undefined',
      'bff:B.java:3',
    ]);
    ui = reduceCode(ui, 'ws-code-goto', { line: '40' }) ?? ui;
    expect(ui.open[0]).toMatchObject({ applicationId: 'backend', file: 'C.java', line: 40 });
    ui = reduceCode(ui, 'ws-code-goto', { app: 'bff', file: 'B.java', line: '7', sel: 'symbol:s' }) ?? ui;
    expect(ui.open[0]).toEqual({ applicationId: 'bff', file: 'B.java', line: 7, anchor: 'symbol:s' });
    // Données invalides : l'état ne change pas.
    expect(reduceCode(ui, 'ws-code-goto', { line: 'abc' })).toBe(ui);
    expect(reduceCode(ui, 'ws-code-goto', { line: '0' })).toBe(ui);
    expect(reduceCode(ui, 'ws-code-open', { app: 'bff' })).toBe(ui);
    expect(reduceCode(emptyCodeUi(), 'ws-code-goto', { line: '4' })).toEqual(emptyCodeUi());
    ui = reduceCode(ui, 'ws-code-folder', { folder: 'bff:src', open: 'false' }) ?? ui;
    expect(ui.folders['bff:src']).toBe(true);
    ui = reduceCode(ui, 'ws-code-folder', { folder: 'bff:src', open: 'true' }) ?? ui;
    expect(ui.folders['bff:src']).toBe(false);
    ui = reduceCode(ui, 'ws-code-search', { value: 'Book' }) ?? ui;
    expect(ui.search).toBe('Book');
    ui = reduceCode(ui, 'ws-code-search-clear', {}) ?? ui;
    expect(ui.search).toBe('');
    expect(reduceCode(ui, 'ws-select', { kind: 'node', ref: 'x' })).toBeUndefined();
    expect(reduceCode(ui, 'ws-code-reload', {})).toBeUndefined();
    // Au plus huit fichiers retenus.
    let many = emptyCodeUi();
    for (let index = 0; index < 12; index += 1)
      many = reduceCode(many, 'ws-code-open', { app: `app${String(index)}`, file: 'f.ts' }) ?? many;
    expect(many.open).toHaveLength(8);
    expect(many.open[0]?.applicationId).toBe('app11');
  });
});

describe('module hygiene', () => {
  it('styles use theme tokens only, and no live region is recreated on repaint', () => {
    expect(INCIDENT_CODE_CSS).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
    expect(INCIDENT_CODE_CSS).toContain('--qa-color-danger');
    const source0 = readFileSync('src/sdk/ui/incident-code.ts', 'utf8');
    expect(source0).not.toContain('aria-live');
  });
});

describe('readability (QA review): contrast, file names, long lines', () => {
  const rule = (selector: string): string => {
    const start = INCIDENT_CODE_CSS.indexOf(`\n${selector}{`);
    if (start < 0) throw new Error(`no rule ${selector}`);
    return INCIDENT_CODE_CSS.slice(start + 1, INCIDENT_CODE_CSS.indexOf('}', start) + 1);
  };

  it('line numbers and coloured texts reach AA: muted gutter, status colours mixed with the text colour', () => {
    expect(rule('.ws-code-num')).toContain('color:var(--qa-color-muted)');
    expect(INCIDENT_CODE_CSS).not.toMatch(/[;{]color:var\(--qa-color-faint\)/);
    // Aucun texte coloré avec un jeton de statut brut (2,5 à 4,4:1 en thème clair).
    // (Les icônes .ico, éléments graphiques, gardent le jeton : 3:1 suffit.)
    expect(INCIDENT_CODE_CSS.replace(/[^}\n]*\.ico\{[^}]*\}/g, '')).not.toMatch(
      /[;{]color:var\(--qa-color-(danger|success|warning|primary)\)/,
    );
    for (const selector of [
      '.ws-code-hit',
      '.ws-code-hk-error',
      '.ws-code-hk-symbol',
      '.ws-code-s',
      '.ws-code-k',
      '.ws-code-n',
      '.ws-code-g',
    ])
      expect(rule(selector)).toMatch(
        /color:color-mix\(in srgb,var\(--qa-color-[a-z]+\) \d+%,var\(--qa-color-text\)\)/,
      );
  });

  it('file and folder names are never broken mid-word: one line, ellipsis, full name in title', () => {
    expect(rule('.ws-code-fname')).toContain('text-overflow:ellipsis');
    expect(rule('.ws-code-fname')).toContain('white-space:nowrap');
    expect(INCIDENT_CODE_CSS).not.toMatch(/overflow-wrap:anywhere/);
    expect(rule('.ws-code-layer-tree')).toContain('min-width:min(100%,260px)');
    const html = renderSourceTree(context(), emptyCodeUi(), tree);
    expect(html).toMatch(/class="ws-code-file[^"]*"[^>]*title="Ouvrir [^"]+"/);
  });

  it('long lines scroll horizontally in the code area, with a sticky readable gutter', () => {
    expect(rule('.ws-code-scroll')).toContain('overflow-x:auto');
    // Une ombre au bord droit signale les lignes qui continuent hors du cadre.
    expect(rule('.ws-code-scroll')).toContain('no-repeat local');
    expect(rule('.ws-code-num')).toContain('position:sticky;left:0');
    expect(rule('.ws-code-src pre')).toContain('white-space:pre');
  });
});
