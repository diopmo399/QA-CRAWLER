import { describe, expect, it } from 'vitest';
import type {
  CodeIndex,
  Diagnosis,
  Incident,
  InvestigationGraph,
  InvestigationScope,
  RegressionTestProposal,
  ReproductionRun,
} from '../../src/incident/model.js';
import { buildReport, escapeMarkdown, reportMarkdown } from '../../src/incident/report.js';

/**
 * LE RAPPORT de l'incident fictif du catalogue : chronologie ordonnée, requêtes masquées, code retenu
 * par le graphe, limites dites honnêtement, Markdown en français sans échappement cassé.
 */

const now = new Date('2026-10-30T12:00:00.000Z');

function scope(): InvestigationScope {
  return {
    mode: 'GUIDED',
    applications: [
      {
        id: 'bff',
        name: 'BFF | livres',
        layer: 'BFF',
        repository: { root: '/repos/books-bff', include: ['src/main/java'] },
      },
    ],
    scenarios: ['creer-livre'],
    steps: [],
    endpoints: ['POST /api/books'],
    depth: 3,
    allowedHosts: [],
    logRoots: [],
    allowedCommands: [],
    permissions: {
      readSources: true,
      navigate: true,
      httpRequests: 'NONE',
      runTests: 'NONE',
      localCommands: false,
      readLogs: false,
      openshift: 'NONE',
      sideEffects: false,
    },
    limits: {
      maxFiles: 2000,
      maxFileBytes: 524288,
      maxDurationMs: 600000,
      maxRequests: 200,
      maxExperiments: 20,
    },
    extensions: [],
  };
}

function reproduction(): ReproductionRun {
  return {
    id: 'rep_1',
    startedAt: '2026-10-30T09:00:00.000Z',
    status: 'COMPLETED',
    target: 'LOCAL',
    baseUrl: 'http://catalogue.test',
    scenario: 'creer-livre',
    reproduced: true,
    symptomMatch: 'observé : HTTP 500',
    actions: [
      {
        index: 1,
        kind: 'goto',
        description: 'goto /books/new',
        status: 'PASSED',
        startedAt: '2026-10-30T09:00:00.000Z',
        durationMs: 1000,
        requestIds: [],
      },
      {
        index: 3,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        startedAt: '2026-10-30T09:00:02.000Z',
        durationMs: 1000,
        requestIds: ['rep_1:req-3-1'],
      },
    ],
    requests: [
      {
        id: 'rep_1:req-3-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 500,
        resourceType: 'fetch',
        startedAt: '2026-10-30T09:00:02.100Z',
        step: 3,
        correlation: 'OBSERVED',
        requestBody: '{"title":"Le Petit Atlas","token":"abc123456789"}',
        responseBody: '{"status":500,"message":"Catalog error ``` boom"}',
      },
      {
        id: 'rep_1:req-x-1',
        method: 'GET',
        url: '/api/stats',
        path: '/api/stats',
        status: 503,
        resourceType: 'unknown',
        startedAt: '2026-10-30T09:00:01.500Z',
        correlation: 'UNKNOWN',
      },
    ],
    evidence: [
      { id: 'rep_1:ev-action-3', kind: 'ACTION', summary: 'étape 3', source: { step: 3 } },
      {
        id: 'rep_1:ev-js',
        kind: 'JS_ERROR',
        at: '2026-10-30T09:00:02.500Z',
        summary: 'PAGE_ERROR: TypeError | x',
        source: { step: 3 },
      },
      {
        id: 'rep_1:ev-assert',
        kind: 'ASSERTION',
        summary: "attente non satisfaite à l'étape 4",
        source: { step: 4 },
      },
    ],
    screenshots: [],
  };
}

const graph: InvestigationGraph = {
  nodes: [
    {
      id: 'request:rep_1:req-3-1',
      kind: 'REQUEST',
      label: 'POST /api/books → 500',
      layer: 'NETWORK',
      evidence: ['rep_1:req-3-1'],
    },
    {
      id: 'code:bff:BookController.java#BookController.create',
      kind: 'BFF_ENDPOINT',
      label: 'POST /api/books (BookController.create)',
      layer: 'BFF',
      evidence: ['bff:BookController.java#BookController.create'],
      symbolId: 'bff:BookController.java#BookController.create',
      file: 'BookController.java',
      line: 24,
    },
  ],
  edges: [
    {
      from: 'request:rep_1:req-3-1',
      to: 'code:bff:BookController.java#BookController.create',
      status: 'STATICALLY_RESOLVED',
      reason: 'POST /api/books (bff) correspond à POST /api/books',
      evidence: ['rep_1:req-3-1'],
    },
  ],
};

const code: CodeIndex = {
  applications: [{ id: 'bff', layer: 'BFF', files: 2, skipped: 0 }],
  symbols: [
    {
      id: 'bff:BookController.java#BookController.create',
      applicationId: 'bff',
      layer: 'BFF',
      kind: 'ENDPOINT',
      name: 'BookController.create',
      file: 'BookController.java',
      line: 24,
    },
    {
      id: 'bff:Unrelated.java#Unrelated',
      applicationId: 'bff',
      layer: 'BFF',
      kind: 'SERVICE',
      name: 'Unrelated',
      file: 'Unrelated.java',
      line: 1,
    },
  ],
  endpoints: [],
  outgoing: [],
  calls: [],
  denied: [{ path: '/repos/books-bff/.env', reason: 'sensitive file' }],
  truncated: [],
};

function incident(partial: Partial<Incident['investigation']> = {}): Incident {
  return {
    id: 'inc_catalogue01',
    projectId: 'catalogue',
    title: 'Erreur 500 | création d’un livre',
    description: 'Après Enregistrer : erreur HTTP 500. password=hunter22',
    observed: 'erreur HTTP 500 après Enregistrer',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'creer-livre',
    execution: { target: 'LOCAL' },
    scope: scope(),
    state: 'DIAGNOSED',
    revision: 4,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T11:00:00.000Z',
    createdBy: 'analyste',
    history: [],
    investigation: {
      reproductions: [reproduction()],
      code,
      graph,
      hypotheses: [],
      experiments: [],
      ...partial,
    },
  };
}

describe('buildReport', () => {
  it('orders the timeline and keeps only the code retained by the graph', () => {
    const report = buildReport(incident(), now);
    expect(report.version).toBe(1);
    expect(report.generatedAt).toBe(now.toISOString());
    expect(report.timeline.map((entry) => entry.ref)).toEqual([
      'rep_1:ev-action-1',
      'rep_1:req-x-1',
      'rep_1:ev-action-3',
      'rep_1:req-3-1',
      'rep_1:ev-js',
      'rep_1:ev-assert',
    ]);
    expect(report.code.files).toEqual(['BookController.java']);
    expect(report.code.symbols.map((symbol) => symbol.name)).toEqual(['BookController.create']);
    expect(report.code.denied).toHaveLength(1);
    expect(report.environment).toMatchObject({
      execution: { target: 'LOCAL' },
      baseUrl: 'http://catalogue.test',
    });
  });

  it('redacts and states its limitations honestly', () => {
    const report = buildReport(incident(), now);
    const text = JSON.stringify(report);
    expect(text).not.toContain('abc123456789');
    expect(text).not.toContain('hunter22');
    const limitations = report.limitations.join('\n');
    expect(limitations).toContain('UNKNOWN');
    expect(limitations).toContain('STATICALLY_RESOLVED');
    expect(limitations).toContain("Aucune vérification n'a été exécutée");
    expect(limitations).toContain("Aucun diagnostic n'a été établi");
    expect(limitations).toContain('trace Playwright');
    expect(limitations).toContain('1 chemin(s) refusé(s)');

    const empty = buildReport(incident({ reproductions: [], code: undefined, graph: undefined }), now);
    expect(empty.timeline).toEqual([]);
    expect(empty.requests).toEqual([]);
    expect(empty.limitations.join('\n')).toContain('Aucune reproduction');
    expect(empty.limitations.join('\n')).toContain("Le code n'a pas été analysé");
  });
});

describe('reportMarkdown', () => {
  const diagnosis: Diagnosis = {
    status: 'PROBABLE',
    rootCause: {
      hypothesisId: 'hyp-null-relation',
      statement: 'CatalogBookService.register déréférence book.getPublisher().getName()',
      layer: 'BACKEND',
      files: ['CatalogBookService.java'],
    },
    alternatives: [],
    missing: ['une seconde vérification'],
    recommendations: ['Vérifier la relation avant de la déréférencer'],
    generatedAt: now.toISOString(),
  };
  const regression: RegressionTestProposal = {
    name: 'Non-régression — Erreur 500',
    basedOn: 'creer-livre',
    flowYaml: 'flows:\n  - name: x\n    steps:\n      - goto: /books/new\n',
    expected: 'POST /api/books répond en 2xx',
    status: 'PROPOSED',
  };

  it('renders French sections, a mermaid graph and escaped cells', () => {
    const markdown = reportMarkdown(buildReport(incident({ diagnosis, regression }), now));
    for (const heading of [
      "# Rapport d'investigation — Erreur 500 \\| création d’un livre",
      '## Incident',
      '## Chronologie',
      '## Requêtes',
      '## Code inspecté',
      "## Graphe d'investigation",
      '## Hypothèses',
      '## Vérifications',
      '## Diagnostic',
      '## Test de non-régression',
      '## Limites',
    ])
      expect(markdown).toContain(heading);
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('-->|STATICALLY_RESOLVED|');
    expect(markdown).toContain('BFF \\| livres');
    expect(markdown).toContain('TypeError \\| x');
    expect(markdown).toContain('Cause racine (non confirmée)');
    // Jamais « réussi » sans exécution.
    expect(markdown).toContain('pas encore exécuté');
    expect(markdown).not.toContain('réussi');
    // Un corps qui contient ``` ne ferme pas le bloc de code.
    expect(markdown).not.toContain('Catalog error ``` boom');
    expect(markdown).not.toContain('hunter22');
  });

  it('shows a real execution result when there is one', () => {
    const markdown = reportMarkdown(
      buildReport(
        incident({
          regression: { ...regression, execution: { run: 'run-1', passed: true, at: now.toISOString() } },
        }),
        now,
      ),
    );
    expect(markdown).toContain('réussi (run run-1');
  });

  it('escapes inline Markdown', () => {
    expect(escapeMarkdown('a|b *c* [d](e)\nf')).toBe('a\\|b \\*c\\* \\[d\\](e) f');
  });
});
