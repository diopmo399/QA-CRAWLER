import { describe, expect, it } from 'vitest';
import type { AiFinding, AiSuggestedRelation } from '../../src/sdk/core/incident-ai-contracts.js';
import { MAX_AI_HYPOTHESIS_CONFIDENCE } from '../../src/sdk/core/incident-ai-contracts.js';
import type {
  CodeIndex,
  CodeSymbol,
  Experiment,
  ExperimentKind,
  Hypothesis,
  HttpExchange,
  Incident,
  InvestigationGraph,
  ReproductionRun,
} from '../../src/sdk/core/incident-contracts.js';
import { applyExperiment, meetsConfirmation, proposeHypotheses } from '../../src/incident/hypotheses.js';
import { diagnose } from '../../src/incident/root-cause.js';
import {
  AI_RELATION_PREFIX,
  assignHypothesisIds,
  contradicts,
  crossLayerFindings,
  evidenceFindings,
  incidentRefLookup,
  mergeHypotheses,
  nextAiHypothesisNumber,
  resolveContradictions,
  sameHypothesis,
  toGraphRelations,
  toHypotheses,
  toProposals,
  validateCitations,
} from '../../src/incident/ai/merge.js';
import type {
  EvidenceAnalysis,
  HypothesisProposal,
  HypothesisProposals,
  VerificationPlan,
} from '../../src/incident/ai/schemas/analysis.js';

/**
 * LA FUSION DES SORTIES IA : identifiants `hyp-ai-<n>`, origine, PROPOSED, confiance plafonnée, références
 * validées, dédoublonnage où l'hypothèse de règle gagne, propositions exécutables, arêtes INFERRED entre nœuds
 * existants, contradictions signalées. Et la preuve que le chemin déterministe reste le seul juge : une
 * hypothèse IA monte par `applyExperiment` comme une hypothèse de règle, et `diagnose` ne la confirme jamais
 * sans deux vérifications de sortes différentes.
 */

const CATALOG = 'src/main/java/org/example/catalog/books';
const BFF = 'src/main/java/org/example/bff/books';
const BFF_ERROR = String.raw`{"status":500,"error":"Internal Server Error","path":"/api/books","message":"Catalog error: 500 : \"{\"exception\":\"java.lang.NullPointerException\",\"message\":\"Cannot invoke \\\"org.example.catalog.books.Publisher.getName()\\\" because the return value of \\\"org.example.catalog.books.CatalogBook.getPublisher()\\\" is null\",\"path\":\"/catalog/books\"}\""}`;

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
  request: symbol('bff', 'BFF', 'DTO', `${BFF}/CreateBookRequest.java`, 'CreateBookRequest', 7, {
    detail: { fields: ['title', 'isbn', 'publisherId'] },
  }),
  client: symbol('bff', 'BFF', 'HTTP_CLIENT', `${BFF}/CatalogClient.java`, 'CatalogClient.register', 27),
  catalogService: symbol(
    'catalog',
    'BACKEND',
    'SERVICE',
    `${CATALOG}/CatalogBookService.java`,
    'CatalogBookService.register',
    31,
    { detail: { dereferences: ['book.getPublisher().getName()'] } },
  ),
};

function code(): CodeIndex {
  return {
    applications: [
      { id: 'bff', layer: 'BFF', files: 7, skipped: 0 },
      { id: 'catalog', layer: 'BACKEND', files: 8, skipped: 0 },
    ],
    symbols: Object.values(S),
    endpoints: [],
    outgoing: [],
    calls: [],
    denied: [],
    truncated: [],
  };
}

function exchange(
  partial: Partial<HttpExchange> & Pick<HttpExchange, 'id' | 'method' | 'path'>,
): HttpExchange {
  return { url: partial.path, resourceType: 'fetch', correlation: 'OBSERVED', ...partial };
}

function reproduction(): ReproductionRun {
  return {
    id: 'rep_1',
    startedAt: '2026-10-30T09:00:00.000Z',
    status: 'COMPLETED',
    target: 'LOCAL',
    scenario: 'creer-livre',
    reproduced: true,
    symptomMatch: 'observé : HTTP 500 : POST /api/books → 500 (étape 3)',
    actions: [],
    requests: [
      exchange({
        id: 'rep_1:req-3-1',
        method: 'POST',
        path: '/api/books',
        status: 500,
        step: 3,
        requestBody: '{"title":"Le Petit Atlas","isbn":"978-2-0000-0000-1"}',
        responseBody: BFF_ERROR,
      }),
    ],
    evidence: [
      {
        id: 'rep_1:ev-issue-1',
        kind: 'REQUEST',
        summary: 'POST /api/books → 500',
        source: { reproduction: 'rep_1', step: 3 },
      },
    ],
    screenshots: [],
  };
}

function graph(): InvestigationGraph {
  return {
    nodes: [
      {
        id: 'req:rep_1:req-3-1',
        kind: 'REQUEST',
        label: 'POST /api/books',
        layer: 'NETWORK',
        evidence: ['rep_1:req-3-1'],
      },
      {
        id: 'sym:bff-client',
        kind: 'BFF_SERVICE',
        label: 'CatalogClient.register',
        layer: 'BFF',
        evidence: [],
        symbolId: S.client.id,
        file: S.client.file,
      },
      {
        id: 'sym:catalog-service',
        kind: 'BACKEND_SERVICE',
        label: 'CatalogBookService.register',
        layer: 'BACKEND',
        evidence: [],
        symbolId: S.catalogService.id,
        file: S.catalogService.file,
      },
    ],
    edges: [
      {
        from: 'req:rep_1:req-3-1',
        to: 'sym:bff-client',
        status: 'OBSERVED',
        reason: 'endpoint observé',
        evidence: ['rep_1:req-3-1'],
      },
    ],
  };
}

function incident(partial: Partial<Incident['investigation']> = {}): Incident {
  return {
    id: 'inc_catalogue01',
    projectId: 'catalogue',
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après Enregistrer, erreur HTTP 500.',
    observed: 'erreur HTTP 500 après Enregistrer',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'creer-livre',
    execution: { target: 'LOCAL' },
    scope: {
      mode: 'GUIDED',
      applications: [
        { id: 'bff', name: 'BFF', layer: 'BFF', repository: { root: '/repo/bff', include: [] } },
        {
          id: 'catalog',
          name: 'Catalogue',
          layer: 'BACKEND',
          repository: { root: '/repo/catalog', include: [] },
          logFiles: ['logs/app.log'],
        },
      ],
      scenarios: ['creer-livre', 'creer-livre-avec-editeur'],
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
    },
    state: 'INVESTIGATING',
    revision: 1,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
    createdBy: 'analyste',
    history: [],
    investigation: {
      reproductions: [reproduction()],
      code: code(),
      graph: graph(),
      hypotheses: [],
      experiments: [],
      ...partial,
    },
  };
}

const NOW = '2026-10-31T10:00:00.000Z';
const RUN = 'ai_run_1';

function proposal(partial: Partial<HypothesisProposal> = {}): Omit<HypothesisProposal, 'id'> {
  return {
    title: 'Mapping du champ publisherId perdu dans CatalogClient',
    description: 'Le client HTTP du BFF reconstruit le corps sans publisherId.',
    suspectedCause: 'CatalogClient.register omet publisherId lors de la conversion du DTO.',
    layer: 'BFF',
    locations: [{ applicationId: 'bff', file: S.client.file, line: 28 }],
    supporting: [
      { ref: { kind: 'request', id: 'rep_1:req-3-1' }, fact: 'POST /api/books → 500 sans publisherId' },
      { ref: { kind: 'symbol', id: S.client.id }, fact: 'CatalogClient.register construit le corps' },
    ],
    contradicting: [],
    confidence: 0.95,
    verificationHints: [
      {
        kind: 'CHECK_VALIDATION',
        description: 'vérifier publisherId dans CreateBookRequest',
        params: { applicationId: 'bff', file: S.request.file, field: 'publisherId' },
      },
    ],
    ...partial,
  };
}

const proposals = (...items: Omit<HypothesisProposal, 'id'>[]): HypothesisProposals => ({
  hypotheses: items as HypothesisProposal[],
  existing: [],
  gaps: [],
});

let sequence = 0;
function experiment(kind: ExperimentKind, hypothesisId: string, outcome: Experiment['outcome']): Experiment {
  sequence += 1;
  return {
    id: `exp_${String(sequence)}`,
    kind,
    hypothesisId,
    description: `${kind} check`,
    params: {},
    status: 'DONE',
    sideEffects: false,
    decisions: [],
    ...(outcome ? { outcome } : {}),
    summary: `${kind} → ${outcome ?? 'none'}`,
    evidence: [],
  };
}

const ruleHypotheses = (): Hypothesis[] => {
  const inc = incident();
  return proposeHypotheses({ incident: inc, reproduction: reproduction(), code: code(), graph: graph() });
};

describe('incidentRefLookup / validateCitations', () => {
  it('knows requests, evidence, symbols, files, nodes, edges, hypotheses and experiments of the incident', () => {
    const lookup = incidentRefLookup(
      incident({
        hypotheses: ruleHypotheses(),
        experiments: [experiment('REPLAY', 'hyp-null-relation', 'SUPPORTS')],
      }),
    );
    expect(lookup.has({ kind: 'request', id: 'rep_1:req-3-1' })).toBe(true);
    expect(lookup.has({ kind: 'evidence', id: 'rep_1:ev-issue-1' })).toBe(true);
    expect(lookup.has({ kind: 'symbol', id: S.catalogService.id })).toBe(true);
    expect(lookup.has({ kind: 'file', id: `catalog:${S.catalogService.file}` })).toBe(true);
    expect(lookup.has({ kind: 'file', id: S.catalogService.file })).toBe(true);
    expect(lookup.has({ kind: 'node', id: 'sym:bff-client' })).toBe(true);
    expect(lookup.has({ kind: 'edge', id: 'req:rep_1:req-3-1->sym:bff-client' })).toBe(true);
    expect(lookup.has({ kind: 'hypothesis', id: 'hyp-null-relation' })).toBe(true);
    expect(lookup.has({ kind: 'experiment', id: 'exp_1' })).toBe(true);
    expect(lookup.hasLocation({ applicationId: 'bff', file: S.client.file })).toBe(true);
    expect(lookup.has({ kind: 'request', id: 'rep_9:req-1-1' })).toBe(false);
    expect(lookup.hasLocation({ applicationId: 'bff', file: 'src/main/java/Invented.java' })).toBe(false);
  });

  it('accepts extra refs (evidence packs) and files read during the run, and names each unknown reference', () => {
    const lookup = incidentRefLookup(incident(), {
      extra: [{ kind: 'step', id: 'step-1' }],
      files: [{ applicationId: 'catalog', file: './src/test/java/CatalogBookServiceTest.java' }],
    });
    expect(lookup.has({ kind: 'step', id: 'step-1' })).toBe(true);
    expect(
      lookup.hasLocation({ applicationId: 'catalog', file: 'src/test/java/CatalogBookServiceTest.java' }),
    ).toBe(true);
    const reasons = validateCitations(
      lookup,
      [
        { kind: 'request', id: 'rep_1:req-3-1' },
        { kind: 'evidence', id: 'ghost' },
      ],
      [{ applicationId: 'bff', file: 'nope.java' }],
    );
    expect(reasons).toEqual([
      'unknown evidence reference "ghost": cite only existing ids',
      'unknown file "bff:nope.java": cite only files of the code index or files you read',
    ]);
  });
});

describe('toHypotheses', () => {
  it('maps a proposal to a PROPOSED AI hypothesis with hyp-ai id, origin, run id, capped confidence and validated refs', () => {
    const inc = incident();
    const { hypotheses, dropped } = toHypotheses(proposals(proposal()), incidentRefLookup(inc), RUN, NOW, {
      incident: inc,
    });
    expect(dropped).toEqual([]);
    expect(hypotheses).toHaveLength(1);
    const [ai] = hypotheses;
    expect(ai).toMatchObject({
      id: 'hyp-ai-1',
      origin: 'AI',
      aiRunId: RUN,
      status: 'PROPOSED',
      layer: 'BFF',
      files: [S.client.file],
      confidence: MAX_AI_HYPOTHESIS_CONFIDENCE,
    });
    expect(ai?.supporting).toEqual([
      { ref: 'rep_1:req-3-1', fact: 'POST /api/books → 500 sans publisherId' },
      { ref: S.client.id, fact: 'CatalogClient.register construit le corps' },
    ]);
    expect(ai?.verifications).toEqual([
      {
        kind: 'CHECK_VALIDATION',
        description: 'vérifier publisherId dans CreateBookRequest',
        params: { applicationId: 'bff', file: S.request.file, field: 'publisherId' },
      },
    ]);
  });

  it('numbers after the existing AI hypotheses, drops unknown refs and files, and drops a hypothesis left without support', () => {
    const inc = incident();
    const existing: Hypothesis[] = [
      { ...ruleHypotheses()[0], id: 'hyp-ai-4' } as Hypothesis,
      ...ruleHypotheses(),
    ];
    const { hypotheses, dropped } = toHypotheses(
      proposals(
        proposal({
          supporting: [
            { ref: { kind: 'request', id: 'rep_1:req-3-1' }, fact: 'ok' },
            { ref: { kind: 'evidence', id: 'invented' }, fact: 'nope' },
          ],
          locations: [{ applicationId: 'bff', file: 'Invented.java' }],
        }),
        proposal({
          title: 'Sans preuve',
          suspectedCause: 'autre',
          supporting: [{ ref: { kind: 'symbol', id: 'nope' }, fact: 'x' }],
        }),
      ),
      incidentRefLookup(inc),
      RUN,
      NOW,
      { existing, incident: inc },
    );
    expect(hypotheses.map((item) => item.id)).toEqual(['hyp-ai-5']);
    expect(hypotheses[0]?.files).toEqual([]);
    expect(hypotheses[0]?.supporting).toEqual([{ ref: 'rep_1:req-3-1', fact: 'ok' }]);
    expect(dropped).toEqual([
      'hyp-ai-5: supporting reference "evidence:invented" unknown, dropped',
      'hyp-ai-5: file "bff:Invented.java" unknown, dropped',
      'hyp-ai-6: supporting reference "symbol:nope" unknown, dropped',
      'hyp-ai-6: no valid supporting reference, hypothesis dropped (Sans preuve)',
    ]);
    expect(nextAiHypothesisNumber(['hyp-ai-4', 'hyp-null-relation', 'hyp-ai-x'])).toBe(5);
    expect(assignHypothesisIds([{ a: 1 }, { a: 2 }], ['hyp-ai-2']).map((item) => item.id)).toEqual([
      'hyp-ai-3',
      'hyp-ai-4',
    ]);
  });

  it('takes the verifications from the plan (valid params only, one per kind) before the hints', () => {
    const inc = incident();
    const plan: VerificationPlan = {
      proposals: [
        {
          hypothesisId: 'hyp-ai-1',
          kind: 'COMPARE_WITH_PASSING',
          objective: 'o',
          description: 'comparer avec un scénario qui réussit',
          params: { passingScenario: 'creer-livre-avec-editeur', field: 'publisherId' },
          resources: [],
          permissions: ['navigate'],
          risks: [],
          sideEffects: false,
          expected: 'e',
          confirmIf: 'c',
          refuteIf: 'r',
          priority: 1,
        },
        {
          hypothesisId: 'hyp-ai-1',
          kind: 'UNIT_TEST',
          objective: 'o',
          description: 'test',
          params: { bogus: 'x' },
          resources: [],
          permissions: [],
          risks: [],
          sideEffects: false,
          expected: 'e',
          confirmIf: 'c',
          refuteIf: 'r',
          priority: 2,
        },
        {
          hypothesisId: 'hyp-ai-1',
          kind: 'CHECK_VALIDATION',
          objective: 'o',
          description: 'planifié',
          params: { applicationId: 'bff', file: S.request.file, field: 'publisherId' },
          resources: [],
          permissions: [],
          risks: [],
          sideEffects: false,
          expected: 'e',
          confirmIf: 'c',
          refuteIf: 'r',
          priority: 3,
        },
      ],
      gaps: [],
    };
    const { hypotheses } = toHypotheses(proposals(proposal()), incidentRefLookup(inc), RUN, NOW, {
      incident: inc,
      plan,
    });
    expect(hypotheses[0]?.verifications.map((item) => [item.kind, item.description])).toEqual([
      ['COMPARE_WITH_PASSING', 'comparer avec un scénario qui réussit'],
      ['CHECK_VALIDATION', 'planifié'],
    ]);
  });

  it('keeps an id already carried by the proposal (an existing hypothesis it overlaps)', () => {
    const inc = incident();
    const { hypotheses } = toHypotheses(
      { hypotheses: [{ ...proposal(), id: 'hyp-null-relation' }], existing: [], gaps: [] },
      incidentRefLookup(inc),
      RUN,
      NOW,
    );
    expect(hypotheses[0]?.id).toBe('hyp-null-relation');
    expect(hypotheses[0]?.status).toBe('PROPOSED');
  });
});

describe('mergeHypotheses', () => {
  it('lets the rule hypothesis win over an AI duplicate (title or cause) and adds the AI refs and files to it', () => {
    const rules = ruleHypotheses();
    const nullRelation = rules.find((item) => item.id === 'hyp-null-relation');
    if (!nullRelation) throw new Error('expected hyp-null-relation');
    const inc = incident();
    const duplicate = toHypotheses(
      proposals(
        proposal({
          title: nullRelation.title.toUpperCase(),
          suspectedCause: 'autre formulation',
          supporting: [
            { ref: { kind: 'request', id: 'rep_1:req-3-1' }, fact: 'déjà connue' },
            { ref: { kind: 'evidence', id: 'rep_1:ev-issue-1' }, fact: 'nouvelle preuve' },
          ],
          locations: [{ applicationId: 'bff', file: S.client.file }],
          confidence: 0.2,
        }),
        proposal({
          title: 'Autre titre',
          suspectedCause: nullRelation.suspectedCause,
          supporting: [{ ref: { kind: 'symbol', id: S.client.id }, fact: 'par la cause' }],
        }),
        proposal({ title: 'Nouvelle piste', suspectedCause: 'cause inédite' }),
      ),
      incidentRefLookup(inc),
      RUN,
      NOW,
    ).hypotheses;
    const merged = mergeHypotheses(rules, duplicate);
    expect(merged.map((item) => item.id)).toEqual([...rules.map((item) => item.id), 'hyp-ai-3']);
    const kept = merged.find((item) => item.id === 'hyp-null-relation');
    expect(kept?.origin).toBeUndefined();
    expect(kept?.confidence).toBe(nullRelation.confidence);
    expect(kept?.status).toBe('PROPOSED');
    expect(kept?.supporting.map((item) => item.ref)).toEqual([
      ...nullRelation.supporting.map((item) => item.ref),
      'rep_1:ev-issue-1',
      S.client.id,
    ]);
    expect(kept?.files).toEqual([...nullRelation.files, S.client.file]);
    expect(
      sameHypothesis(
        { title: 'Éditeur  manquant', suspectedCause: 'a' },
        { title: 'editeur manquant', suspectedCause: 'b' },
      ),
    ).toBe(true);
  });

  it('merges incoming duplicates between themselves and never changes an existing status', () => {
    const existing: Hypothesis[] = ruleHypotheses().map((item) =>
      item.id === 'hyp-null-relation' ? { ...item, status: 'SUPPORTED' } : item,
    );
    const inc = incident();
    const incoming = toHypotheses(
      proposals(
        proposal(),
        proposal({
          suspectedCause: 'CatalogClient.register OMET publisherId lors de la conversion du DTO.',
          supporting: [{ ref: { kind: 'evidence', id: 'rep_1:ev-issue-1' }, fact: 'idem' }],
        }),
      ),
      incidentRefLookup(inc),
      RUN,
      NOW,
    ).hypotheses;
    const merged = mergeHypotheses(existing, incoming);
    expect(merged.filter((item) => item.origin === 'AI')).toHaveLength(1);
    expect(merged.find((item) => item.origin === 'AI')?.supporting.map((item) => item.ref)).toEqual([
      'rep_1:req-3-1',
      S.client.id,
      'rep_1:ev-issue-1',
    ]);
    expect(merged.find((item) => item.id === 'hyp-null-relation')?.status).toBe('SUPPORTED');
  });
});

describe('the deterministic path stays the only judge of an AI hypothesis', () => {
  const aiHypothesis = (): Hypothesis => {
    const inc = incident();
    const [ai] = toHypotheses(proposals(proposal()), incidentRefLookup(inc), RUN, NOW, {
      incident: inc,
    }).hypotheses;
    if (!ai) throw new Error('expected an AI hypothesis');
    return ai;
  };

  it('applyExperiment raises an AI hypothesis to SUPPORTED like a rule one, and diagnose says PROBABLE', () => {
    const all = mergeHypotheses(ruleHypotheses(), [aiHypothesis()]);
    const first = experiment('COMPARE_WITH_PASSING', 'hyp-ai-1', 'SUPPORTS');
    const after = applyExperiment(all, first);
    const ai = after.find((item) => item.id === 'hyp-ai-1');
    expect(ai?.status).toBe('SUPPORTED');
    expect(ai?.origin).toBe('AI');
    expect(ai?.confidence).toBeGreaterThan(MAX_AI_HYPOTHESIS_CONFIDENCE);
    expect(ai?.supporting.map((item) => item.ref)).toContain(`experiment:COMPARE_WITH_PASSING:${first.id}`);
    const diagnosis = diagnose(
      { hypotheses: after, experiments: [first], reproduction: reproduction(), code: code() },
      new Date(NOW),
    );
    expect(diagnosis.status).toBe('PROBABLE');
    expect(diagnosis.rootCause?.hypothesisId).toBe('hyp-ai-1');
    expect(diagnosis.missing.some((item) => item.includes('seconde vérification d’une autre sorte'))).toBe(
      true,
    );
  });

  it('two experiments of the same kind never confirm it; two different kinds (one dynamic) do, through meetsConfirmation', () => {
    const base = mergeHypotheses(ruleHypotheses(), [aiHypothesis()]);
    const sameKind = [
      experiment('REPLAY', 'hyp-ai-1', 'SUPPORTS'),
      experiment('REPLAY', 'hyp-ai-1', 'SUPPORTS'),
    ];
    const afterSame = sameKind.reduce(applyExperiment, base);
    const stillSupported = afterSame.find((item) => item.id === 'hyp-ai-1');
    expect(stillSupported?.status).toBe('SUPPORTED');
    expect(meetsConfirmation(stillSupported as Hypothesis)).toBe(false);
    expect(
      diagnose(
        { hypotheses: afterSame, experiments: sameKind, reproduction: reproduction(), code: code() },
        new Date(NOW),
      ).status,
    ).toBe('PROBABLE');

    const differentKinds = [
      experiment('COMPARE_WITH_PASSING', 'hyp-ai-1', 'SUPPORTS'),
      experiment('CHECK_VALIDATION', 'hyp-ai-1', 'SUPPORTS'),
    ];
    const afterDifferent = differentKinds.reduce(applyExperiment, base);
    const confirmed = afterDifferent.find((item) => item.id === 'hyp-ai-1');
    expect(confirmed?.status).toBe('CONFIRMED');
    expect(meetsConfirmation(confirmed as Hypothesis)).toBe(true);
    expect(
      diagnose(
        {
          hypotheses: afterDifferent,
          experiments: differentKinds,
          reproduction: reproduction(),
          code: code(),
        },
        new Date(NOW),
      ).status,
    ).toBe('CONFIRMED');
  });

  it('a proposal that claims CONFIRMED or a high confidence is born PROPOSED and capped; a refuting experiment refutes it', () => {
    const inc = incident();
    const [ai] = toHypotheses(
      proposals({ ...proposal(), confidence: 1 }),
      incidentRefLookup(inc),
      RUN,
      NOW,
    ).hypotheses;
    expect(ai?.status).toBe('PROPOSED');
    expect(ai?.confidence).toBe(MAX_AI_HYPOTHESIS_CONFIDENCE);
    const refuted = applyExperiment([ai as Hypothesis], experiment('REPLAY', 'hyp-ai-1', 'REFUTES'));
    expect(refuted[0]?.status).toBe('REFUTED');
    expect(
      diagnose({ hypotheses: refuted, experiments: [], reproduction: reproduction() }, new Date(NOW)).status,
    ).toBe('INCONCLUSIVE');
  });
});

describe('toProposals', () => {
  const plan = (items: Partial<VerificationPlan['proposals'][number]>[]): VerificationPlan => ({
    proposals: items.map((item, index) => ({
      hypothesisId: 'hyp-null-relation',
      kind: 'REPLAY',
      objective: 'rejouer',
      description: 'rejouer le scénario',
      params: {},
      resources: ['navigateur'],
      permissions: ['navigate'],
      risks: [],
      sideEffects: false,
      expected: '500 de nouveau',
      confirmIf: '500',
      refuteIf: '201',
      priority: index + 1,
      ...item,
    })),
    gaps: [],
  });

  it('keeps executable proposals (real params per kind), orders by priority, forces sideEffects for INTEGRATION_TEST', () => {
    const inc = incident();
    const { proposals: out, dropped } = toProposals(
      plan([
        {
          kind: 'INTEGRATION_TEST',
          params: { applicationId: 'catalog', environmentKind: 'CI', test: 'CatalogBookIT' },
          priority: 2,
        },
        {
          kind: 'COMPARE_WITH_PASSING',
          params: { passingScenario: 'creer-livre-avec-editeur', field: 'publisherId' },
          priority: 1,
        },
        {
          kind: 'INSPECT_LOGS',
          params: { applicationId: 'catalog', patterns: ['NullPointerException'] },
          priority: 3,
        },
        {
          kind: 'CHECK_VALIDATION',
          params: { applicationId: 'bff', file: S.request.file, field: 'publisherId' },
          priority: 4,
        },
      ]),
      ruleHypotheses(),
      inc,
      RUN,
    );
    expect(dropped).toEqual([]);
    expect(out.map((item) => [item.id, item.kind, item.sideEffects, item.status])).toEqual([
      [`${RUN}:prop-1`, 'COMPARE_WITH_PASSING', false, 'PROPOSED'],
      [`${RUN}:prop-2`, 'INTEGRATION_TEST', true, 'PROPOSED'],
      [`${RUN}:prop-3`, 'INSPECT_LOGS', false, 'PROPOSED'],
      [`${RUN}:prop-4`, 'CHECK_VALIDATION', false, 'PROPOSED'],
    ]);
    expect(out[0]?.verification).toEqual({
      kind: 'COMPARE_WITH_PASSING',
      description: 'rejouer le scénario',
      params: { passingScenario: 'creer-livre-avec-editeur', field: 'publisherId' },
    });
  });

  it('drops an unknown hypothesis, params the runner would refuse, and a duplicate kind, with reasons', () => {
    const inc = incident();
    const { proposals: out, dropped } = toProposals(
      plan([
        { hypothesisId: 'hyp-ghost' },
        { kind: 'COMPARE_WITH_PASSING', params: {} },
        { kind: 'COMPARE_REQUESTS', params: { left: 'rep_1', right: 'rep_9' } },
        { kind: 'UNIT_TEST', params: {} },
        { kind: 'CHECK_VALIDATION', params: { applicationId: 'bff', file: '../etc/passwd', field: 'x' } },
        { kind: 'INTEGRATION_TEST', params: { applicationId: 'catalog' } },
        { kind: 'REPLAY', params: { scenario: 'creer-livre' } },
        { kind: 'REPLAY', params: {} },
      ]),
      ruleHypotheses(),
      inc,
      RUN,
    );
    expect(out.map((item) => item.kind)).toEqual(['REPLAY']);
    expect(dropped).toEqual([
      'REPLAY for hyp-ghost: unknown hypothesis, dropped',
      'COMPARE_WITH_PASSING for hyp-null-relation: COMPARE_WITH_PASSING: params.passingScenario is required',
      'COMPARE_REQUESTS for hyp-null-relation: COMPARE_REQUESTS: params.right is not a reproduction id',
      'UNIT_TEST for hyp-null-relation: UNIT_TEST: params.applicationId is required (2 applications in the scope)',
      'CHECK_VALIDATION for hyp-null-relation: CHECK_VALIDATION: params.file must be relative to the repository, without ".."',
      'INTEGRATION_TEST for hyp-null-relation: INTEGRATION_TEST: params.environmentKind is required for a LOCAL execution target',
      'REPLAY for hyp-null-relation: duplicate kind for the same hypothesis, dropped',
    ]);
  });
});

describe('toGraphRelations', () => {
  const relations: AiSuggestedRelation[] = [
    {
      from: 'sym:bff-client',
      to: 'sym:catalog-service',
      reason: 'appel HTTP vers /catalog/books',
      refs: [
        { kind: 'request', id: 'rep_1:req-3-1' },
        { kind: 'symbol', id: S.client.id },
      ],
    },
    { from: 'sym:bff-client', to: 'sym:ghost', reason: 'inventé', refs: [] },
    { from: 'req:rep_1:req-3-1', to: 'sym:bff-client', reason: 'déjà là', refs: [] },
    { from: 'sym:bff-client', to: 'sym:catalog-service', reason: 'doublon', refs: [] },
  ];

  it('writes INFERRED edges prefixed « IA : » only between existing, not yet linked nodes', () => {
    const { edges, skipped } = toGraphRelations(relations, graph());
    expect(edges).toEqual([
      {
        from: 'sym:bff-client',
        to: 'sym:catalog-service',
        status: 'INFERRED',
        reason: `${AI_RELATION_PREFIX}appel HTTP vers /catalog/books`,
        evidence: ['rep_1:req-3-1'],
      },
    ]);
    expect(skipped).toEqual([
      'sym:bff-client → sym:ghost: unknown node',
      'req:rep_1:req-3-1 → sym:bff-client: already linked',
      'sym:bff-client → sym:catalog-service: already linked',
    ]);
    expect(edges.every((edge) => edge.status === 'INFERRED')).toBe(true);
  });

  it('writes nothing without a graph', () => {
    expect(toGraphRelations(relations.slice(0, 1), undefined)).toEqual({
      edges: [],
      skipped: ['sym:bff-client → sym:catalog-service: no graph'],
    });
  });
});

describe('resolveContradictions and finding converters', () => {
  const finding = (partial: Partial<AiFinding> & Pick<AiFinding, 'id' | 'title' | 'summary'>): AiFinding => ({
    agent: 'CROSS_LAYER',
    layer: 'BFF',
    refs: [{ kind: 'request', id: 'rep_1:req-3-1' }],
    locations: [],
    basis: 'INFERRED',
    hypothesisId: 'hyp-null-relation',
    ...partial,
  });

  it('flags opposite statements about the same subject anchored on the same hypothesis or ref, keeps every finding', () => {
    const present = finding({
      id: 'a',
      title: 'publisherId transmis',
      summary: 'Le champ publisherId est présent dans la requête.',
      basis: 'OBSERVED',
      agent: 'EVIDENCE_ANALYSIS',
    });
    const absent = finding({
      id: 'b',
      title: 'publisherId perdu',
      summary: 'Le champ publisherId est absent de la requête envoyée.',
    });
    const unrelated = finding({
      id: 'c',
      title: 'Gestion générique des erreurs',
      summary: 'GlobalExceptionHandler convertit toute erreur en 500.',
      hypothesisId: 'hyp-backend-propagated',
      refs: [{ kind: 'symbol', id: S.client.id }],
    });
    expect(contradicts(present, absent)).toBe(true);
    expect(contradicts(present, unrelated)).toBe(false);
    const { findings, limitations } = resolveContradictions([absent, present, unrelated]);
    expect(findings.map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(limitations).toEqual([
      'Constats contradictoires à arbitrer : « publisherId transmis » (EVIDENCE_ANALYSIS, OBSERVED) et « publisherId perdu » (CROSS_LAYER, INFERRED) sur hyp-null-relation.',
    ]);
  });

  it('converts an evidence analysis and cross-layer findings to AiFinding with stable ids and bases', () => {
    const analysis: EvidenceAnalysis = {
      firstSymptom: { summary: 'POST /api/books → 500', refs: [{ kind: 'request', id: 'rep_1:req-3-1' }] },
      precedingEvents: [],
      inconsistencies: [
        {
          summary: 'Le formulaire affiche un éditeur, la requête n’en envoie pas.',
          refs: [{ kind: 'evidence', id: 'rep_1:ev-issue-1' }],
        },
      ],
      missingEvidence: ['journaux du backend'],
      temporalRelations: [],
      leads: [
        {
          title: 'Déréférencement côté catalogue',
          summary: 'NPE dans CatalogBookService',
          layer: 'BACKEND',
          refs: [{ kind: 'symbol', id: S.catalogService.id }],
        },
      ],
      gaps: [],
    };
    expect(evidenceFindings(analysis).map((item) => [item.id, item.basis, item.layer])).toEqual([
      ['evidence_analysis-1', 'OBSERVED', 'UNKNOWN'],
      ['evidence_analysis-2', 'OBSERVED', 'UNKNOWN'],
      ['evidence_analysis-3', 'INFERRED', 'BACKEND'],
    ]);
    const cross = crossLayerFindings({
      findings: [
        {
          title: 'Champ perdu',
          summary: 'publisherId absent du DTO',
          category: 'FIELD_LOST',
          layers: ['FRONTEND', 'BFF'],
          basis: 'STATICALLY_RESOLVED',
          refs: [{ kind: 'symbol', id: S.request.id }],
          locations: [{ applicationId: 'bff', file: S.request.file }],
          field: 'publisherId',
        },
      ],
      relations: [],
      gaps: [],
    });
    expect(cross).toEqual([
      {
        id: 'cross_layer-1',
        agent: 'CROSS_LAYER',
        layer: 'BFF',
        title: 'Champ perdu',
        summary: 'publisherId absent du DTO (champ : publisherId)',
        refs: [{ kind: 'symbol', id: S.request.id }],
        locations: [{ applicationId: 'bff', file: S.request.file }],
        basis: 'STATICALLY_RESOLVED',
      },
    ]);
  });
});
