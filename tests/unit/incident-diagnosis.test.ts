import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/incident/correlator.js';
import {
  applyExperiment,
  meetsConfirmation,
  proposeHypotheses,
  ruleOf,
} from '../../src/incident/hypotheses.js';
import type {
  CodeIndex,
  CodeSymbol,
  Experiment,
  ExperimentKind,
  HttpExchange,
  Hypothesis,
  Incident,
  InvestigationScope,
  ReproductionRun,
} from '../../src/incident/model.js';
import { diagnose } from '../../src/incident/root-cause.js';

/**
 * HYPOTHÈSES ET CAUSE RACINE sur l'incident fictif du catalogue : l'éditeur laissé vide n'est validé
 * nulle part, le backend déréférence `book.getPublisher().getName()` → NullPointerException → 500.
 * CONFIRMED exige deux vérifications indépendantes de sortes différentes, dont une dynamique.
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
  extra: Partial<CodeSymbol> = {},
): CodeSymbol {
  return { id: `${applicationId}:${file}#${name}`, applicationId, layer, kind, name, file, line, ...extra };
}

const S = {
  onSave: symbol('front', 'FRONTEND', 'EVENT_HANDLER', `${FRONT}/BookForm.tsx`, 'onSave', 21),
  validateBook: symbol('front', 'FRONTEND', 'VALIDATION', `${FRONT}/validation.ts`, 'validateBook', 3),
  toPayload: symbol(
    'front',
    'FRONTEND',
    'PAYLOAD_TRANSFORM',
    `${FRONT}/payload.ts`,
    'toCreateBookPayload',
    5,
  ),
  createBook: symbol('front', 'FRONTEND', 'FUNCTION', `${FRONT}/books-api.ts`, 'createBook', 8),
  controller: symbol('bff', 'BFF', 'ENDPOINT', `${BFF}/BookController.java`, 'BookController.create', 24, {
    detail: { params: ['@Valid @RequestBody CreateBookRequest request'] },
  }),
  request: symbol('bff', 'BFF', 'DTO', `${BFF}/CreateBookRequest.java`, 'CreateBookRequest', 7, {
    detail: { fields: ['title', 'isbn', 'publisherId'] },
  }),
  service: symbol('bff', 'BFF', 'SERVICE', `${BFF}/BookService.java`, 'BookService.create', 19),
  client: symbol('bff', 'BFF', 'HTTP_CLIENT', `${BFF}/CatalogClient.java`, 'CatalogClient.register', 27),
  handler: symbol(
    'bff',
    'BFF',
    'EXCEPTION_HANDLER',
    `${BFF}/GlobalExceptionHandler.java`,
    'GlobalExceptionHandler.handleCatalog',
    14,
  ),
  catalogController: symbol(
    'catalog',
    'BACKEND',
    'ENDPOINT',
    `${CATALOG}/CatalogBookController.java`,
    'CatalogBookController.register',
    22,
    {
      detail: { requestBody: 'NewCatalogBook' },
    },
  ),
  newBook: symbol('catalog', 'BACKEND', 'DTO', `${CATALOG}/NewCatalogBook.java`, 'NewCatalogBook', 5, {
    detail: { fields: ['title', 'isbn', 'publisherId'] },
  }),
  catalogService: symbol(
    'catalog',
    'BACKEND',
    'SERVICE',
    `${CATALOG}/CatalogBookService.java`,
    'CatalogBookService.register',
    31,
    {
      detail: { dereferences: ['book.getPublisher().getName()'] },
    },
  ),
  catalogBook: symbol('catalog', 'BACKEND', 'DTO', `${CATALOG}/CatalogBook.java`, 'CatalogBook', 9),
};
const V = {
  title: symbol('bff', 'BFF', 'VALIDATION', `${BFF}/CreateBookRequest.java`, 'CreateBookRequest.title', 8, {
    parent: S.request.id,
    detail: { field: 'title', annotation: '@NotBlank' },
  }),
  isbn: symbol('bff', 'BFF', 'VALIDATION', `${BFF}/CreateBookRequest.java`, 'CreateBookRequest.isbn', 9, {
    parent: S.request.id,
    detail: { field: 'isbn', annotation: '@NotBlank' },
  }),
};

function catalogueCode(): CodeIndex {
  return {
    applications: [
      { id: 'front', layer: 'FRONTEND', files: 4, skipped: 0 },
      { id: 'bff', layer: 'BFF', files: 7, skipped: 0 },
      { id: 'catalog', layer: 'BACKEND', files: 8, skipped: 0 },
    ],
    symbols: [...Object.values(S), ...Object.values(V)],
    endpoints: [
      { applicationId: 'bff', layer: 'BFF', method: 'POST', path: '/api/books', symbolId: S.controller.id },
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
        to: S.validateBook.id,
        text: 'validateBook(form)',
        status: 'STATICALLY_RESOLVED',
        file: S.onSave.file,
        line: 22,
      },
      {
        from: S.onSave.id,
        to: S.toPayload.id,
        text: 'toCreateBookPayload(form)',
        status: 'STATICALLY_RESOLVED',
        file: S.onSave.file,
        line: 24,
      },
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
        to: S.client.id,
        text: 'catalogClient.register(body)',
        status: 'STATICALLY_RESOLVED',
        file: S.service.file,
        line: 21,
      },
      {
        from: S.catalogController.id,
        to: S.catalogService.id,
        text: 'service.register(body)',
        status: 'STATICALLY_RESOLVED',
        file: S.catalogController.file,
        line: 23,
      },
    ],
    denied: [],
    truncated: [],
  };
}

const SAVE = '{"title":"Le Petit Atlas","isbn":"978-2-0000-0000-1"}';

function exchange(
  partial: Partial<HttpExchange> & Pick<HttpExchange, 'id' | 'method' | 'path'>,
): HttpExchange {
  return { url: partial.path, resourceType: 'fetch', correlation: 'OBSERVED', ...partial };
}

function reproduction(partial: Partial<ReproductionRun> = {}): ReproductionRun {
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
        index: 3,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        durationMs: 800,
        requestIds: ['rep_1:req-3-1'],
      },
    ],
    requests: [
      exchange({
        id: 'rep_1:req-3-1',
        method: 'POST',
        path: '/api/books',
        status: 500,
        step: 3,
        requestBody: SAVE,
        responseBody: BFF_ERROR,
      }),
    ],
    evidence: [],
    screenshots: [],
    ...partial,
  };
}

function scope(): InvestigationScope {
  return {
    mode: 'GUIDED',
    applications: [],
    scenarios: ['creer-livre'],
    steps: [],
    endpoints: [],
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

function incident(): Incident {
  return {
    id: 'inc_catalogue01',
    projectId: 'catalogue',
    title: 'Erreur 500 à la création d’un livre',
    description:
      "Lors de la création d'un livre, après avoir cliqué sur Enregistrer, l'application affiche une erreur HTTP 500.",
    observed: 'erreur HTTP 500 après Enregistrer',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'creer-livre',
    execution: { target: 'LOCAL' },
    scope: scope(),
    state: 'INVESTIGATING',
    revision: 1,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
    createdBy: 'analyste',
    history: [],
    investigation: { reproductions: [], hypotheses: [], experiments: [] },
  };
}

/** `null` : sans reproduction, ou sans code. */
function propose(given?: ReproductionRun | null, givenCode?: CodeIndex | null): Hypothesis[] {
  const run = given === null ? undefined : (given ?? reproduction());
  const code = givenCode === null ? undefined : (givenCode ?? catalogueCode());
  const graph = buildGraph({
    incident: incident(),
    ...(run ? { reproduction: run } : {}),
    ...(code ? { code } : {}),
    depth: 3,
  });
  return proposeHypotheses({
    incident: incident(),
    ...(run ? { reproduction: run } : {}),
    ...(code ? { code } : {}),
    graph,
  });
}

let sequence = 0;
function experiment(
  kind: ExperimentKind,
  hypothesisId: string,
  outcome: Experiment['outcome'],
  status: Experiment['status'] = 'DONE',
): Experiment {
  sequence += 1;
  return {
    id: `exp_${String(sequence)}`,
    kind,
    hypothesisId,
    description: `${kind} check`,
    params: {},
    status,
    sideEffects: false,
    decisions: [],
    ...(outcome ? { outcome } : {}),
    summary: `${kind} → ${outcome ?? 'none'}`,
    evidence: [],
  };
}

const byRule = (hypotheses: Hypothesis[], rule: string): Hypothesis | undefined =>
  hypotheses.find((hypothesis) => ruleOf(hypothesis) === rule);

describe('proposeHypotheses', () => {
  it('proposes the null relation, the missing validation and the propagated backend failure', () => {
    const hypotheses = propose();
    expect(hypotheses.map((hypothesis) => hypothesis.id)).toEqual([
      'hyp-null-relation',
      'hyp-missing-validation',
      'hyp-backend-propagated',
    ]);
    for (const hypothesis of hypotheses) {
      expect(hypothesis.status).toBe('PROPOSED');
      expect(hypothesis.confidence).toBeLessThanOrEqual(0.7);
      expect(hypothesis.supporting.length).toBeGreaterThan(0);
      expect(Array.isArray(hypothesis.contradicting)).toBe(true);
      expect(hypothesis.verifications.length).toBeGreaterThan(0);
    }

    const nullRelation = byRule(hypotheses, 'null-relation');
    expect(nullRelation?.layer).toBe('BACKEND');
    expect(nullRelation?.files).toContain(S.catalogService.file);
    expect(nullRelation?.suspectedCause).toContain('book.getPublisher().getName()');
    expect(nullRelation?.supporting.map((item) => item.ref)).toEqual(
      expect.arrayContaining(['rep_1:req-3-1', S.catalogService.id]),
    );
    expect(nullRelation?.verifications.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['COMPARE_WITH_PASSING', 'UNIT_TEST', 'INSPECT_LOGS', 'REPLAY']),
    );

    const validation = byRule(hypotheses, 'missing-validation');
    expect(validation?.layer).toBe('BFF');
    expect(validation?.title).toContain('publisherId');
    expect(validation?.files).toEqual(
      expect.arrayContaining([S.request.file, S.newBook.file, S.validateBook.file, S.toPayload.file]),
    );
    expect(validation?.supporting.some((item) => item.fact.includes('sans @NotNull'))).toBe(true);
    const check = validation?.verifications.find((item) => item.kind === 'CHECK_VALIDATION');
    expect(check?.params).toMatchObject({ file: S.request.file, field: 'publisherId', expect: 'missing' });

    const propagated = byRule(hypotheses, 'backend-propagated');
    expect(propagated?.supporting[0]?.fact).toContain('/catalog/books');
    expect(propagated?.files).toContain(S.handler.file);
  });

  it('lowers confidence with contradicting evidence: a passing save without the publisher', () => {
    const run = reproduction();
    run.requests.push(
      exchange({
        id: 'rep_1:req-5-1',
        method: 'POST',
        path: '/api/books',
        status: 201,
        step: 5,
        requestBody: SAVE,
      }),
    );
    const hypotheses = propose(run);
    const nullRelation = byRule(hypotheses, 'null-relation');
    const baseline = byRule(propose(), 'null-relation');
    expect(nullRelation?.contradicting.map((item) => item.ref)).toEqual(['rep_1:req-5-1']);
    expect(nullRelation?.confidence ?? 1).toBeLessThan(baseline?.confidence ?? 0);
    expect(byRule(hypotheses, 'missing-validation')?.contradicting).toHaveLength(1);
  });

  it('stays grounded without code: no invented file', () => {
    const hypotheses = propose(reproduction(), null);
    const nullRelation = byRule(hypotheses, 'null-relation');
    expect(nullRelation?.files).toEqual([]);
    expect(nullRelation?.layer).toBe('UNKNOWN');
    expect(nullRelation?.suspectedCause).toContain('non localisé');
    expect(byRule(hypotheses, 'missing-validation')?.files).toEqual([]);
  });

  it('covers client errors, network failures, JavaScript errors and a symptom not reproduced', () => {
    const client = propose(
      reproduction({
        requests: [
          exchange({
            id: 'r1',
            method: 'POST',
            path: '/api/books',
            status: 400,
            step: 3,
            responseBody: '{"message":"title must not be blank"}',
          }),
        ],
      }),
    );
    expect(byRule(client, 'client-error')?.layer).toBe('BFF');
    const network = propose(
      reproduction({
        requests: [
          exchange({
            id: 'r2',
            method: 'POST',
            path: '/api/books',
            failure: 'net::ERR_CONNECTION_REFUSED',
            step: 3,
          }),
        ],
      }),
    );
    expect(byRule(network, 'network-failure')?.layer).toBe('ENVIRONMENT');
    const script = propose(
      reproduction({
        requests: [],
        evidence: [
          {
            id: 'e1',
            kind: 'JS_ERROR',
            summary: 'PAGE_ERROR: TypeError: form.publisher is undefined',
            source: { step: 3 },
          },
        ],
      }),
    );
    expect(byRule(script, 'frontend-error')?.layer).toBe('FRONTEND');
    const notReproduced = propose(
      reproduction({ reproduced: false, requests: [], symptomMatch: 'non observé : HTTP 500' }),
    );
    expect(notReproduced.map((hypothesis) => hypothesis.layer).sort()).toEqual(['ENVIRONMENT', 'TEST_DATA']);
    expect(propose(null)).toEqual([]);
  });
});

describe('applyExperiment', () => {
  it('SUPPORTS → SUPPORTED, then CONFIRMED with a second independent kind including a dynamic one', () => {
    const [first] = propose();
    const id = first?.id ?? '';
    let hypotheses = applyExperiment(propose(), experiment('CHECK_VALIDATION', id, 'SUPPORTS'));
    expect(hypotheses[0]?.status).toBe('SUPPORTED');
    // La même sorte une seconde fois ne suffit pas.
    hypotheses = applyExperiment(hypotheses, experiment('CHECK_VALIDATION', id, 'SUPPORTS'));
    expect(hypotheses[0]?.status).toBe('SUPPORTED');
    hypotheses = applyExperiment(hypotheses, experiment('UNIT_TEST', id, 'SUPPORTS'));
    expect(hypotheses[0]?.status).toBe('CONFIRMED');
    expect(hypotheses[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(meetsConfirmation(hypotheses[0] as Hypothesis)).toBe(true);
    // Les autres hypothèses ne bougent pas.
    expect(hypotheses[1]?.status).toBe('PROPOSED');
  });

  it('never confirms with contradicting evidence, nor with an experiment counted twice', () => {
    const run = reproduction();
    run.requests.push(
      exchange({ id: 'rep_1:req-5-1', method: 'POST', path: '/api/books', status: 201, requestBody: SAVE }),
    );
    const contradicted = propose(run);
    let hypotheses = applyExperiment(contradicted, experiment('REPLAY', 'hyp-null-relation', 'SUPPORTS'));
    hypotheses = applyExperiment(hypotheses, experiment('UNIT_TEST', 'hyp-null-relation', 'SUPPORTS'));
    expect(byRule(hypotheses, 'null-relation')?.status).toBe('SUPPORTED');

    const once = experiment('REPLAY', 'hyp-null-relation', 'SUPPORTS');
    let twice = applyExperiment(propose(), once);
    twice = applyExperiment(twice, once);
    expect(byRule(twice, 'null-relation')?.status).toBe('SUPPORTED');
    expect(
      byRule(twice, 'null-relation')?.supporting.filter((item) => item.ref.includes(once.id)),
    ).toHaveLength(1);
  });

  it('REFUTES → REFUTED, NEUTRAL → INCONCLUSIVE only when nothing else, unfinished experiments ignored', () => {
    const refuted = applyExperiment(
      propose(),
      experiment('COMPARE_WITH_PASSING', 'hyp-null-relation', 'REFUTES'),
    );
    expect(byRule(refuted, 'null-relation')?.status).toBe('REFUTED');
    expect(byRule(refuted, 'null-relation')?.contradicting.length).toBe(1);
    const neutral = applyExperiment(propose(), experiment('INSPECT_LOGS', 'hyp-null-relation', 'NEUTRAL'));
    expect(byRule(neutral, 'null-relation')?.status).toBe('INCONCLUSIVE');
    const supported = applyExperiment(propose(), experiment('REPLAY', 'hyp-null-relation', 'SUPPORTS'));
    expect(
      byRule(
        applyExperiment(supported, experiment('INSPECT_LOGS', 'hyp-null-relation', 'NEUTRAL')),
        'null-relation',
      )?.status,
    ).toBe('SUPPORTED');
    const pending = applyExperiment(
      propose(),
      experiment('REPLAY', 'hyp-null-relation', undefined, 'RUNNING'),
    );
    expect(byRule(pending, 'null-relation')?.status).toBe('PROPOSED');
  });
});

describe('diagnose', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');

  it('CONFIRMED only from a confirmed hypothesis, with alternatives and grounded recommendations', () => {
    let hypotheses = applyExperiment(
      propose(),
      experiment('CHECK_VALIDATION', 'hyp-missing-validation', 'SUPPORTS'),
    );
    hypotheses = applyExperiment(
      hypotheses,
      experiment('COMPARE_WITH_PASSING', 'hyp-missing-validation', 'SUPPORTS'),
    );
    const diagnosis = diagnose(
      { hypotheses, experiments: [], reproduction: reproduction(), code: catalogueCode() },
      now,
    );
    expect(diagnosis.status).toBe('CONFIRMED');
    expect(diagnosis.rootCause?.hypothesisId).toBe('hyp-missing-validation');
    expect(diagnosis.rootCause?.files).toContain(S.request.file);
    expect(diagnosis.missing).toEqual([]);
    expect(diagnosis.alternatives.map((item) => item.hypothesisId)).toEqual(
      expect.arrayContaining(['hyp-null-relation', 'hyp-backend-propagated']),
    );
    expect(diagnosis.recommendations[0]).toContain('publisherId');
    expect(diagnosis.recommendations[0]).toContain(S.request.file);
    expect(diagnosis.generatedAt).toBe(now.toISOString());
  });

  it('PROBABLE from the best supported hypothesis, saying what is missing', () => {
    const hypotheses = applyExperiment(propose(), experiment('REPLAY', 'hyp-null-relation', 'SUPPORTS'));
    const diagnosis = diagnose(
      { hypotheses, experiments: [], reproduction: reproduction(), code: catalogueCode() },
      now,
    );
    expect(diagnosis.status).toBe('PROBABLE');
    expect(diagnosis.rootCause?.hypothesisId).toBe('hyp-null-relation');
    expect(diagnosis.missing.some((item) => item.includes('seconde vérification'))).toBe(true);
  });

  it('refuses a CONFIRMED label that does not meet the evidence threshold', () => {
    const forged = propose().map((hypothesis, index) =>
      index === 0 ? { ...hypothesis, status: 'CONFIRMED' as const } : hypothesis,
    );
    const diagnosis = diagnose({ hypotheses: forged, experiments: [] }, now);
    expect(diagnosis.status).not.toBe('CONFIRMED');
  });

  it('INCONCLUSIVE with what is missing: reproduction, code, experiments, refusals', () => {
    const refused = { ...experiment('UNIT_TEST', 'hyp-null-relation', undefined, 'REFUSED') };
    refused.decisions = [
      {
        allowed: false,
        reason: 'runTests is NONE in the scope',
        rule: 'RUN_TEST.permission',
        operation: { kind: 'RUN_TEST', level: 'UNIT', command: 'mvn', args: ['test'], cwd: '/repos/catalog' },
      },
    ];
    const diagnosis = diagnose({ hypotheses: [], experiments: [refused] }, now);
    expect(diagnosis.status).toBe('INCONCLUSIVE');
    expect(diagnosis.rootCause).toBeUndefined();
    expect(diagnosis.missing.join('\n')).toContain('Aucune reproduction');
    expect(diagnosis.missing.join('\n')).toContain('Code non analysé');
    expect(diagnosis.missing.join('\n')).toContain('runTests is NONE in the scope');
    const allRefuted = applyExperiment(
      propose(),
      experiment('REPLAY', 'hyp-null-relation', 'REFUTES'),
    ).filter((hypothesis) => hypothesis.id === 'hyp-null-relation');
    const refutedOnly = diagnose(
      { hypotheses: allRefuted, experiments: [], reproduction: reproduction(), code: catalogueCode() },
      now,
    );
    expect(refutedOnly.status).toBe('INCONCLUSIVE');
    expect(refutedOnly.missing.join('\n')).toContain('réfutées');
  });
});
