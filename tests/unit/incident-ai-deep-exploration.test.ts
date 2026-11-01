import { describe, expect, it } from 'vitest';
import {
  applyVerificationResult,
  buildExplorations,
  causeFamily,
  effectOf,
  locationsOf,
  relateHypotheses,
  reportRoles,
  rolesOf,
  rootHypothesisId,
  uncertaintiesOf,
  verificationResultOf,
} from '../../src/incident/ai/deep/exploration.js';
import { applyExperiment, meetsConfirmation } from '../../src/incident/hypotheses.js';
import type {
  CodeIndex,
  CodeSymbol,
  Experiment,
  ExperimentKind,
  Hypothesis,
  Incident,
  InvestigationScope,
} from '../../src/incident/model.js';
import { diagnose } from '../../src/incident/root-cause.js';
import type {
  AiContradiction,
  AiExperimentProposal,
  AiFinding,
  AiInvestigationRun,
  HypothesisExploration,
  InvestigationMemory,
} from '../../src/sdk/core/incident-ai-contracts.js';

/**
 * L'EXPLORATION DES HYPOTHÈSES sur l'incident fictif du catalogue : l'éditeur laissé vide n'est validé nulle part,
 * le backend déréférence `book.getPublisher().getName()` → 500. Les rôles suivent le moteur déterministe
 * (`applyExperiment`, `meetsConfirmation`, `diagnose`) : CONFIRMED_CAUSE seulement quand il dit CONFIRMED.
 */

const BFF = 'src/main/java/org/example/bff/books';
const CATALOG = 'src/main/java/org/example/catalog/books';
const REQUEST = 'rep_1:req-3-1';
const PASSING = 'rep_1:req-5-1';
const NOW = new Date('2026-10-30T10:00:00.000Z');

function symbol(
  applicationId: string,
  layer: CodeSymbol['layer'],
  kind: CodeSymbol['kind'],
  file: string,
  name: string,
  line: number,
): CodeSymbol {
  return { id: `${applicationId}:${file}#${name}`, applicationId, layer, kind, name, file, line };
}

const S = {
  request: symbol('bff', 'BFF', 'DTO', `${BFF}/CreateBookRequest.java`, 'CreateBookRequest', 7),
  handler: symbol(
    'bff',
    'BFF',
    'EXCEPTION_HANDLER',
    `${BFF}/GlobalExceptionHandler.java`,
    'GlobalExceptionHandler.handleCatalog',
    14,
  ),
  catalogService: symbol(
    'catalog',
    'BACKEND',
    'SERVICE',
    `${CATALOG}/CatalogBookService.java`,
    'CatalogBookService.register',
    31,
  ),
};

function code(): CodeIndex {
  return {
    applications: [
      { id: 'front', layer: 'FRONTEND', files: 4, skipped: 0 },
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

function scope(): InvestigationScope {
  const application = (
    id: string,
    layer: 'FRONTEND' | 'BFF' | 'BACKEND',
  ): InvestigationScope['applications'][number] => ({
    id,
    name: id,
    layer,
    repository: { root: `/repos/${id}`, include: [] },
  });
  return {
    mode: 'GUIDED',
    applications: [
      application('front', 'FRONTEND'),
      application('bff', 'BFF'),
      application('catalog', 'BACKEND'),
    ],
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

function hypothesis(partial: Partial<Hypothesis> & Pick<Hypothesis, 'id' | 'title' | 'layer'>): Hypothesis {
  return {
    description: partial.title,
    suspectedCause: partial.title,
    files: [],
    supporting: [{ ref: REQUEST, fact: 'POST /api/books → 500' }],
    contradicting: [],
    confidence: 0.5,
    verifications: [],
    status: 'PROPOSED',
    ...partial,
  };
}

/** Les quatre hypothèses : trois règles et une hypothèse IA qui précise le déréférencement. */
function hypotheses(): Hypothesis[] {
  return [
    hypothesis({
      id: 'hyp-null-relation',
      title: 'NullPointerException sur book.getPublisher().getName()',
      suspectedCause: 'Le backend déréférence la relation publisher absente.',
      layer: 'BACKEND',
      files: [S.catalogService.file],
      supporting: [
        { ref: REQUEST, fact: 'POST /api/books → 500' },
        { ref: S.catalogService.id, fact: 'déréférence book.getPublisher().getName()' },
      ],
      confidence: 0.6,
      verifications: [
        {
          kind: 'COMPARE_WITH_PASSING',
          description: 'Comparer avec un enregistrement qui passe',
          params: {},
        },
        {
          kind: 'UNIT_TEST',
          description: 'Test ciblé du service',
          params: { class: 'CatalogBookServiceTest' },
        },
      ],
    }),
    hypothesis({
      id: 'hyp-missing-validation',
      title: 'Champ publisherId sans validation',
      suspectedCause: 'Aucune couche ne valide publisherId.',
      layer: 'BFF',
      files: [S.request.file],
      confidence: 0.55,
      verifications: [
        {
          kind: 'CHECK_VALIDATION',
          description: 'Vérifier l’absence de @NotNull',
          params: { file: S.request.file, field: 'publisherId', expect: 'missing' },
        },
      ],
    }),
    hypothesis({
      id: 'hyp-backend-propagated',
      title: 'Erreur backend renvoyée telle quelle par le BFF',
      suspectedCause: 'Le BFF propage la 500 du catalogue.',
      layer: 'BFF',
      files: [S.handler.file],
      confidence: 0.5,
    }),
    hypothesis({
      id: 'hyp-ai-1',
      title: 'Déréférencement null du publisher dans CatalogBookService.register',
      suspectedCause: 'book.getPublisher() renvoie null quand publisherId manque dans la charge.',
      layer: 'BACKEND',
      files: [S.catalogService.file],
      confidence: 0.6,
      origin: 'AI',
      aiRunId: 'run_1',
    }),
  ];
}

function incident(given: Hypothesis[] = hypotheses(), experiments: Experiment[] = []): Incident {
  return {
    id: 'inc_catalogue01',
    projectId: 'catalogue',
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après Enregistrer, erreur HTTP 500.',
    observed: 'erreur HTTP 500 après Enregistrer',
    expected: 'le livre est créé',
    severity: 'HIGH',
    execution: { target: 'LOCAL' },
    scope: scope(),
    state: 'INVESTIGATING',
    revision: 1,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T09:30:00.000Z',
    createdBy: 'analyste',
    history: [],
    investigation: { reproductions: [], code: code(), hypotheses: given, experiments },
  };
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
    evidence: outcome
      ? [{ id: `ev_${String(sequence)}`, kind: 'REQUEST', summary: 'réponse', source: {} }]
      : [],
    startedAt: '2026-10-30T09:40:00.000Z',
    finishedAt: `2026-10-30T09:4${String(sequence % 10)}:00.000Z`,
  };
}

/** Exécute une expérience par le chemin du moteur et répercute son effet sur les explorations. */
function run(
  state: { hypotheses: Hypothesis[]; explorations: HypothesisExploration[]; experiments: Experiment[] },
  kind: ExperimentKind,
  hypothesisId: string,
  outcome: Experiment['outcome'],
): Experiment {
  const done = experiment(kind, hypothesisId, outcome);
  state.experiments.push(done);
  state.hypotheses = applyExperiment(state.hypotheses, done);
  const diagnosis = diagnose({ hypotheses: state.hypotheses, experiments: state.experiments }, NOW);
  state.explorations = applyVerificationResult(state.explorations, done, state.hypotheses, diagnosis);
  return done;
}

const roleOf = (
  explorations: HypothesisExploration[],
  id: string,
): HypothesisExploration['role'] | undefined => explorations.find((item) => item.hypothesisId === id)?.role;
const ids = (explorations: HypothesisExploration[]): string[] =>
  explorations.map((item) => item.hypothesisId);

function proposal(
  id: string,
  hypothesisId: string,
  status: AiExperimentProposal['status'] = 'PROPOSED',
): AiExperimentProposal {
  return {
    id,
    hypothesisId,
    kind: 'COMPARE_WITH_PASSING',
    objective: 'Comparer',
    verification: { kind: 'COMPARE_WITH_PASSING', description: 'Comparer', params: {} },
    resources: [],
    permissions: [],
    risks: [],
    sideEffects: false,
    expected: 'Une 201 sans publisher',
    confirmIf: 'la 201 contient un publisher',
    refuteIf: 'la 201 passe sans publisher',
    status,
  };
}

function aiRun(partial: Partial<AiInvestigationRun> = {}): AiInvestigationRun {
  return {
    id: 'run_1',
    mode: 'AI_AGENTIC',
    status: 'DONE',
    startedAt: NOW.toISOString(),
    startedBy: 'analyste',
    budget: {
      maxIterations: 4,
      maxModelCalls: 24,
      maxToolCalls: 60,
      maxInputTokens: 400000,
      maxOutputTokens: 40000,
      maxCost: 0,
      maxDurationMs: 300000,
      maxFiles: 40,
      maxCommands: 0,
      maxExperiments: 2,
    },
    usage: {
      iterations: 1,
      modelCalls: 3,
      toolCalls: 4,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0,
      durationMs: 1000,
      files: 2,
      commands: 0,
      experiments: 0,
    },
    plan: [],
    steps: [],
    findings: [],
    hypothesisIds: ['hyp-ai-1'],
    relations: [],
    proposals: [],
    scopeRequests: [],
    limitations: [],
    ...partial,
  };
}

function memory(partial: Partial<InvestigationMemory> = {}): InvestigationMemory {
  return {
    version: 1,
    incidentId: 'inc_catalogue01',
    depth: 'DEEP',
    mode: 'AI_AGENTIC',
    status: 'RUNNING',
    updatedAt: NOW.toISOString(),
    budget: { ...aiRun().budget, maxConcurrentAgents: 3, extensions: [] },
    usage: aiRun().usage,
    strategies: [],
    explorations: [],
    contradictions: [],
    experiments: [],
    coverage: [],
    permissions: [],
    timeline: [],
    limits: [],
    remaining: [],
    ...partial,
  };
}

describe('buildExplorations', () => {
  it('builds one exploration per hypothesis, rule and AI alike, with origin, locations, unknowns and roles', () => {
    const explorations = buildExplorations(incident());
    expect(ids(explorations)).toEqual([
      'hyp-null-relation',
      'hyp-missing-validation',
      'hyp-backend-propagated',
      'hyp-ai-1',
    ]);
    expect(explorations.map((item) => item.origin)).toEqual(['RULE', 'RULE', 'RULE', 'AI']);
    expect(explorations.every((item) => item.role === 'UNVERIFIED')).toBe(true);
    expect(explorations.every((item) => item.verifications.length === 0)).toBe(true);

    const nullRelation = explorations[0];
    expect(nullRelation?.locations).toEqual([
      {
        applicationId: 'catalog',
        file: S.catalogService.file,
        line: 31,
        symbol: 'CatalogBookService.register',
      },
    ]);
    expect(nullRelation?.unknowns.some((item) => item.includes('Aucune vérification exécutée'))).toBe(true);
    expect(nullRelation?.contributors).toEqual([]);

    const validation = explorations[1];
    expect(validation?.locations).toEqual([{ applicationId: 'bff', file: S.request.file }]);

    const ai = explorations[3];
    expect(ai?.contributors).toEqual(['HYPOTHESIS']);
    expect(ai?.unknowns.some((item) => item.includes('origine IA non éprouvée'))).toBe(true);
  });

  it('relates hypotheses: the AI one refines the rule of the same family, the two BFF ones compete', () => {
    const explorations = buildExplorations(incident());
    const ai = explorations.find((item) => item.hypothesisId === 'hyp-ai-1');
    expect(ai?.relations).toContainEqual(
      expect.objectContaining({ from: 'hyp-ai-1', to: 'hyp-null-relation', kind: 'REFINES' }),
    );
    const validation = explorations.find((item) => item.hypothesisId === 'hyp-missing-validation');
    expect(validation?.relations).toContainEqual(
      expect.objectContaining({
        from: 'hyp-missing-validation',
        to: 'hyp-backend-propagated',
        kind: 'COMPETES',
      }),
    );
    // Rien ne contribue encore : aucune hypothèse n'est soutenue.
    expect(explorations.flatMap((item) => item.relations).some((item) => item.kind === 'CONTRIBUTES')).toBe(
      false,
    );
  });

  it('never fabricates a location: a file whose application cannot be told apart is left out', () => {
    const orphan = hypothesis({
      id: 'hyp-ai-2',
      title: 'Autre cause',
      layer: 'UNKNOWN',
      files: ['somewhere/Unknown.java'],
      supporting: [],
      origin: 'AI',
    });
    const [exploration] = buildExplorations(incident([orphan]));
    expect(exploration?.locations).toEqual([]);
    expect(exploration?.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining('Couche inconnue')]),
    );
    expect(locationsOf(incident(), orphan)).toEqual([]);
  });

  it('takes pending proposals, open contradictions and contributors from the run and the memory', () => {
    const finding: AiFinding = {
      id: 'finding-backend-1',
      agent: 'BACKEND',
      layer: 'BACKEND',
      title: 'getPublisher() peut être null',
      summary: 'Aucun garde avant getName().',
      refs: [{ kind: 'symbol', id: S.catalogService.id }],
      locations: [{ applicationId: 'catalog', file: S.catalogService.file, line: 33 }],
      basis: 'STATICALLY_RESOLVED',
      hypothesisId: 'hyp-null-relation',
    };
    const contradiction: AiContradiction = {
      id: 'contra-1',
      hypothesisId: 'hyp-null-relation',
      kind: 'PASSING_SCENARIO',
      summary: 'Un enregistrement sans éditeur a-t-il déjà réussi ?',
      refs: [],
      openQuestion: true,
      proposalId: 'prop-2',
      status: 'OPEN',
      foundBy: 'CONTRADICTION_HUNTER',
      at: NOW.toISOString(),
    };
    const explorations = buildExplorations(
      incident(),
      memory({ contradictions: [contradiction] }),
      aiRun({
        findings: [finding],
        proposals: [
          proposal('prop-1', 'hyp-null-relation'),
          proposal('prop-done', 'hyp-null-relation', 'DONE'),
        ],
      }),
    );
    const nullRelation = explorations[0];
    expect(nullRelation?.contributors).toEqual(['BACKEND', 'CONTRADICTION_HUNTER']);
    expect(nullRelation?.nextProposalIds).toEqual(['prop-1', 'prop-2']);
    expect(nullRelation?.locations).toContainEqual({
      applicationId: 'catalog',
      file: S.catalogService.file,
      line: 33,
    });
    expect(nullRelation?.unknowns).toContainEqual(
      expect.stringContaining('Question ouverte (PASSING_SCENARIO)'),
    );
    expect(
      uncertaintiesOf(explorations).find((item) => item.hypothesisId === 'hyp-null-relation'),
    ).toMatchObject({
      decisiveProposalIds: ['prop-1', 'prop-2'],
    });
  });

  it('keeps the verifications, contributors and relations a previous memory recorded', () => {
    const previous: HypothesisExploration = {
      hypothesisId: 'hyp-backend-propagated',
      origin: 'RULE',
      unknowns: ['ancienne inconnue'],
      locations: [{ applicationId: 'bff', file: S.handler.file, line: 14 }],
      contributors: ['BFF'],
      verifications: [
        {
          experimentId: 'exp_old',
          at: '2026-10-29T10:00:00.000Z',
          effect: 'NEUTRAL',
          summary: 'journaux muets',
          refs: [{ kind: 'experiment', id: 'exp_old' }],
        },
      ],
      nextProposalIds: [],
      relations: [
        { from: 'hyp-backend-propagated', to: 'hyp-null-relation', kind: 'IMPLIES', reason: 'mémoire' },
      ],
      role: 'UNKNOWN',
    };
    const explorations = buildExplorations(incident(), memory({ explorations: [previous] }));
    const propagated = explorations.find((item) => item.hypothesisId === 'hyp-backend-propagated');
    expect(propagated?.contributors).toEqual(['BFF']);
    expect(propagated?.verifications.map((item) => item.experimentId)).toEqual(['exp_old']);
    expect(propagated?.locations).toContainEqual({ applicationId: 'bff', file: S.handler.file, line: 14 });
    expect(propagated?.relations).toContainEqual(expect.objectContaining({ kind: 'IMPLIES' }));
    // Les inconnues sont recalculées d'après l'état réel, jamais recopiées.
    expect(propagated?.unknowns).not.toContain('ancienne inconnue');
    // Une vérification neutre sans décision du moteur : on ne sait pas.
    expect(propagated?.role).toBe('UNKNOWN');
  });
});

describe('applyVerificationResult', () => {
  it('a supported hypothesis keeps its competitors: nothing is removed, roles move only for the one verified', () => {
    const state = {
      hypotheses: hypotheses(),
      explorations: buildExplorations(incident()),
      experiments: [] as Experiment[],
    };
    const done = run(state, 'COMPARE_WITH_PASSING', 'hyp-null-relation', 'SUPPORTS');

    expect(ids(state.explorations)).toEqual(ids(buildExplorations(incident())));
    expect(state.hypotheses.find((item) => item.id === 'hyp-null-relation')?.status).toBe('SUPPORTED');
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('PROBABLE_CAUSE');
    expect(roleOf(state.explorations, 'hyp-missing-validation')).toBe('UNVERIFIED');
    expect(roleOf(state.explorations, 'hyp-backend-propagated')).toBe('UNVERIFIED');
    expect(roleOf(state.explorations, 'hyp-ai-1')).toBe('UNVERIFIED');

    const nullRelation = state.explorations[0];
    expect(nullRelation?.verifications).toEqual([
      {
        experimentId: done.id,
        at: done.finishedAt,
        effect: 'SUPPORTS',
        summary: done.summary,
        refs: [
          { kind: 'experiment', id: done.id },
          { kind: 'evidence', id: done.evidence[0]?.id },
        ],
      },
    ]);
    // Les concurrentes gardent leurs relations et leurs vérifications à faire.
    expect(
      state.explorations.find((item) => item.hypothesisId === 'hyp-missing-validation')?.relations,
    ).toContainEqual(expect.objectContaining({ kind: 'COMPETES' }));
    expect(nullRelation?.unknowns).toContainEqual(expect.stringContaining('Confirmation incomplète'));
  });

  it('a refutation flips the role to REFUTED and the next supported lead becomes the probable cause', () => {
    const state = {
      hypotheses: hypotheses(),
      explorations: buildExplorations(incident()),
      experiments: [] as Experiment[],
    };
    run(state, 'COMPARE_WITH_PASSING', 'hyp-null-relation', 'SUPPORTS');
    run(state, 'CHECK_VALIDATION', 'hyp-missing-validation', 'SUPPORTS');
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('PROBABLE_CAUSE');
    expect(roleOf(state.explorations, 'hyp-missing-validation')).toBe('CONTRIBUTING_FACTOR');

    run(state, 'UNIT_TEST', 'hyp-null-relation', 'REFUTES');
    expect(state.hypotheses.find((item) => item.id === 'hyp-null-relation')?.status).toBe('REFUTED');
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('REFUTED');
    expect(roleOf(state.explorations, 'hyp-missing-validation')).toBe('PROBABLE_CAUSE');
    expect(ids(state.explorations)).toHaveLength(4);
    // Une hypothèse réfutée ne laisse plus d'incertitude à lever.
    expect(
      uncertaintiesOf(state.explorations).some((item) => item.hypothesisId === 'hyp-null-relation'),
    ).toBe(false);
    expect(state.explorations[0]?.verifications.map((item) => item.effect)).toEqual([
      'SUPPORTS',
      'CONTRADICTS',
    ]);
  });

  it('several contributing causes coexist next to a confirmed cause', () => {
    const state = {
      hypotheses: hypotheses(),
      explorations: buildExplorations(incident()),
      experiments: [] as Experiment[],
    };
    run(state, 'COMPARE_WITH_PASSING', 'hyp-null-relation', 'SUPPORTS');
    run(state, 'CHECK_VALIDATION', 'hyp-missing-validation', 'SUPPORTS');
    run(state, 'INSPECT_LOGS', 'hyp-backend-propagated', 'SUPPORTS');
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('PROBABLE_CAUSE');
    expect(roleOf(state.explorations, 'hyp-missing-validation')).toBe('CONTRIBUTING_FACTOR');
    expect(roleOf(state.explorations, 'hyp-backend-propagated')).toBe('CONTRIBUTING_FACTOR');

    run(state, 'UNIT_TEST', 'hyp-null-relation', 'SUPPORTS');
    const confirmed = state.hypotheses.find((item) => item.id === 'hyp-null-relation');
    expect(confirmed?.status).toBe('CONFIRMED');
    expect(meetsConfirmation(confirmed as Hypothesis)).toBe(true);
    expect(diagnose({ hypotheses: state.hypotheses, experiments: state.experiments }, NOW).status).toBe(
      'CONFIRMED',
    );
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('CONFIRMED_CAUSE');
    expect(roleOf(state.explorations, 'hyp-missing-validation')).toBe('CONTRIBUTING_FACTOR');
    expect(roleOf(state.explorations, 'hyp-backend-propagated')).toBe('CONTRIBUTING_FACTOR');
    expect(roleOf(state.explorations, 'hyp-ai-1')).toBe('UNVERIFIED');

    const relations = relateHypotheses(state.hypotheses);
    expect(relations).toContainEqual(
      expect.objectContaining({
        from: 'hyp-missing-validation',
        to: 'hyp-null-relation',
        kind: 'CONTRIBUTES',
      }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({
        from: 'hyp-missing-validation',
        to: 'hyp-backend-propagated',
        kind: 'COMPETES',
      }),
    );

    const report = reportRoles(state.explorations, state.hypotheses);
    expect(report.confirmed.map((item) => item.hypothesisId)).toEqual(['hyp-null-relation']);
    expect(report.contributing.map((item) => item.hypothesisId)).toEqual([
      'hyp-missing-validation',
      'hyp-backend-propagated',
    ]);
    expect(report.unverified.map((item) => item.hypothesisId)).toEqual(['hyp-ai-1']);
    expect(report.probable).toEqual([]);
    expect(report.confirmed[0]?.verifications).toEqual({ supports: 2, contradicts: 0, neutral: 0 });
    expect(report.confirmed[0]?.status).toBe('CONFIRMED');
  });

  it('a late contradiction changes the role: a confirmed cause falls back to probable, a late refutation to refuted', () => {
    const state = {
      hypotheses: hypotheses(),
      explorations: buildExplorations(incident()),
      experiments: [] as Experiment[],
    };
    run(state, 'COMPARE_WITH_PASSING', 'hyp-null-relation', 'SUPPORTS');
    run(state, 'UNIT_TEST', 'hyp-null-relation', 'SUPPORTS');
    run(state, 'CHECK_VALIDATION', 'hyp-missing-validation', 'SUPPORTS');
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('CONFIRMED_CAUSE');

    // Une preuve contraire arrive après coup (un enregistrement sans éditeur qui passe) : le moteur ne la tient
    // plus pour confirmée, le rôle suit sans qu'aucun statut ne soit réécrit ici.
    state.hypotheses = state.hypotheses.map((item) =>
      item.id === 'hyp-null-relation'
        ? { ...item, contradicting: [{ ref: PASSING, fact: 'POST /api/books → 201 sans publisher' }] }
        : item,
    );
    const diagnosis = diagnose({ hypotheses: state.hypotheses, experiments: state.experiments }, NOW);
    expect(diagnosis.status).toBe('PROBABLE');
    const after = rolesOf(state.explorations, diagnosis, state.hypotheses);
    expect(roleOf(after, 'hyp-null-relation')).toBe('PROBABLE_CAUSE');
    expect(roleOf(after, 'hyp-missing-validation')).toBe('CONTRIBUTING_FACTOR');
    expect(ids(after)).toHaveLength(4);
    state.explorations = after;

    // Puis une expérience la réfute : REFUTED, et la validation manquante devient la cause probable.
    run(state, 'REPLAY', 'hyp-null-relation', 'REFUTES');
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('REFUTED');
    expect(roleOf(state.explorations, 'hyp-missing-validation')).toBe('PROBABLE_CAUSE');
    expect(state.explorations[0]?.unknowns.length).toBe(0);
  });

  it('CONFIRMED_CAUSE comes only from the engine: a hand-written CONFIRMED or a high confidence is not enough', () => {
    const forged = hypotheses().map((item) =>
      item.id === 'hyp-null-relation'
        ? { ...item, status: 'CONFIRMED' as const, confidence: 0.99 }
        : item.id === 'hyp-missing-validation'
          ? { ...item, status: 'SUPPORTED' as const, confidence: 0.95 }
          : item,
    );
    const explorations = buildExplorations(incident(forged));
    expect(roleOf(explorations, 'hyp-null-relation')).toBe('PROBABLE_CAUSE');
    expect(roleOf(explorations, 'hyp-missing-validation')).toBe('CONTRIBUTING_FACTOR');
    expect(explorations.some((item) => item.role === 'CONFIRMED_CAUSE')).toBe(false);
    expect(rootHypothesisId(forged)).toBe('hyp-null-relation');

    // Une seule sorte d'expérience, deux fois : le moteur ne confirme pas, le rôle non plus.
    const state = {
      hypotheses: hypotheses(),
      explorations: buildExplorations(incident()),
      experiments: [] as Experiment[],
    };
    run(state, 'COMPARE_WITH_PASSING', 'hyp-null-relation', 'SUPPORTS');
    run(state, 'COMPARE_WITH_PASSING', 'hyp-null-relation', 'SUPPORTS');
    expect(state.hypotheses[0]?.status).toBe('SUPPORTED');
    expect(roleOf(state.explorations, 'hyp-null-relation')).toBe('PROBABLE_CAUSE');
  });

  it('a neutral result leaves the hypothesis UNKNOWN, a missing hypothesis is UNKNOWN, a pending experiment changes nothing', () => {
    const state = {
      hypotheses: hypotheses(),
      explorations: buildExplorations(incident()),
      experiments: [] as Experiment[],
    };
    run(state, 'INSPECT_LOGS', 'hyp-backend-propagated', 'NEUTRAL');
    expect(state.hypotheses.find((item) => item.id === 'hyp-backend-propagated')?.status).toBe(
      'INCONCLUSIVE',
    );
    expect(roleOf(state.explorations, 'hyp-backend-propagated')).toBe('UNKNOWN');
    expect(
      state.explorations.find((item) => item.hypothesisId === 'hyp-backend-propagated')?.unknowns,
    ).toContainEqual(expect.stringContaining('rien tranché'));

    const pending = experiment('REPLAY', 'hyp-null-relation', undefined, 'APPROVAL_REQUIRED');
    const unchanged = applyVerificationResult(state.explorations, pending, state.hypotheses);
    expect(unchanged.map((item) => item.verifications.length)).toEqual(
      state.explorations.map((item) => item.verifications.length),
    );
    expect(verificationResultOf(pending)).toBeUndefined();

    const gone = rolesOf(
      state.explorations,
      undefined,
      state.hypotheses.filter((item) => item.id !== 'hyp-ai-1'),
    );
    expect(roleOf(gone, 'hyp-ai-1')).toBe('UNKNOWN');
    expect(ids(gone)).toHaveLength(4);

    // Une hypothèse apparue entre-temps reçoit son exploration.
    const extra = hypothesis({
      id: 'hyp-ai-2',
      title: 'Configuration du client HTTP',
      layer: 'BFF',
      origin: 'AI',
    });
    const withExtra = applyVerificationResult(state.explorations, pending, [...state.hypotheses, extra]);
    expect(withExtra.at(-1)).toMatchObject({ hypothesisId: 'hyp-ai-2', origin: 'AI', role: 'UNVERIFIED' });
  });

  it('records the same experiment once', () => {
    const state = {
      hypotheses: hypotheses(),
      explorations: buildExplorations(incident()),
      experiments: [] as Experiment[],
    };
    const done = run(state, 'COMPARE_WITH_PASSING', 'hyp-null-relation', 'SUPPORTS');
    const again = applyVerificationResult(state.explorations, done, state.hypotheses);
    expect(again[0]?.verifications).toHaveLength(1);
  });
});

describe('relateHypotheses', () => {
  it('EXCLUDES when the evidence that supports one refutes the other, and keeps known relations between existing ids', () => {
    const [nullRelation, validation] = hypotheses();
    const refuted: Hypothesis = {
      ...(validation as Hypothesis),
      contradicting: [{ ref: PASSING, fact: 'une 201 sans validation' }],
      status: 'REFUTED',
    };
    const supporter: Hypothesis = {
      ...(nullRelation as Hypothesis),
      supporting: [
        ...(nullRelation as Hypothesis).supporting,
        { ref: PASSING, fact: 'la 201 porte un éditeur' },
      ],
    };
    const relations = relateHypotheses(
      [supporter, refuted],
      [],
      [
        { from: supporter.id, to: 'hyp-elsewhere', kind: 'IMPLIES', reason: 'id inconnu : écartée' },
        { from: refuted.id, to: supporter.id, kind: 'IMPLIES', reason: 'connue : conservée' },
      ],
    );
    expect(relations).toContainEqual(
      expect.objectContaining({ from: supporter.id, to: refuted.id, kind: 'EXCLUDES' }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({ kind: 'IMPLIES', reason: 'connue : conservée' }),
    );
    expect(relations.some((item) => item.to === 'hyp-elsewhere')).toBe(false);
    // Une hypothèse réfutée n'entre plus en concurrence.
    expect(relations.some((item) => item.kind === 'COMPETES')).toBe(false);
  });

  it('REFINES from a finding that ties one hypothesis to another, deduplicated', () => {
    const finding: AiFinding = {
      id: 'finding-cross-1',
      agent: 'CROSS_LAYER',
      layer: 'BFF',
      title: 'Le champ absent du DTO explique le null',
      summary: '',
      refs: [{ kind: 'hypothesis', id: 'hyp-null-relation' }],
      locations: [],
      basis: 'INFERRED',
      hypothesisId: 'hyp-missing-validation',
    };
    const relations = relateHypotheses(hypotheses(), [finding, finding]);
    expect(
      relations.filter((item) => item.kind === 'REFINES' && item.from === 'hyp-missing-validation'),
    ).toEqual([
      {
        from: 'hyp-missing-validation',
        to: 'hyp-null-relation',
        kind: 'REFINES',
        reason: 'Constat finding-cross-1 (CROSS_LAYER) : Le champ absent du DTO explique le null',
      },
    ]);
  });

  it('reads the cause family from the rule id or from the text of an AI hypothesis', () => {
    expect(causeFamily({ id: 'hyp-missing-validation-2', title: '', suspectedCause: '' })).toBe(
      'missing-validation',
    );
    expect(
      causeFamily({ id: 'hyp-ai-3', title: 'Mapping DTO perdu entre BFF et backend', suspectedCause: '' }),
    ).toBe('mapping');
    expect(
      causeFamily({ id: 'hyp-ai-4', title: 'Autre chose', suspectedCause: 'sans mot connu' }),
    ).toBeUndefined();
    expect(effectOf('REFUTES')).toBe('CONTRADICTS');
  });
});
