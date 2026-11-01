import { describe, expect, it } from 'vitest';
import type { AgentRunContext, EvidencePack, ToolRegistry, ToolResult } from '../../src/incident/ai/agent.js';
import { DATA_DELIMITER_END, DATA_DELIMITER_START } from '../../src/incident/ai/agent.js';
import {
  VERIFICATION_TOOLS,
  candidateHypotheses,
  createVerificationPlanningAgent,
  scopeDigest,
  validatePlan,
  verificationPlanningAgent,
} from '../../src/incident/ai/agents/verification-planning.js';
import { createBudgetTracker } from '../../src/incident/ai/budget.js';
import { createAgentLoop } from '../../src/incident/ai/loop.js';
import { toProposals } from '../../src/incident/ai/merge.js';
import type { InvestigationModelClient } from '../../src/incident/ai/model-client.js';
import { VERIFICATION_SYSTEM } from '../../src/incident/ai/prompts/verification.js';
import {
  VERIFICATION_PARAMS,
  VERIFICATION_PLAN_JSON_SCHEMA,
  verificationParamsProblems,
  type HypothesisProposals,
  type VerificationPlan,
} from '../../src/incident/ai/schemas/analysis.js';
import type { ExperimentContext } from '../../src/incident/experiments.js';
import { planExperiment, runExperiment } from '../../src/incident/experiments.js';
import { proposeHypotheses } from '../../src/incident/hypotheses.js';
import type { AiBudget, AiToolCall } from '../../src/sdk/core/incident-ai-contracts.js';
import {
  EXPERIMENT_KINDS,
  type CodeIndex,
  type CodeSymbol,
  type Hypothesis,
  type Incident,
  type ReproductionRun,
} from '../../src/sdk/core/incident-contracts.js';
import { finalTurn, scriptedModelClient } from '../fixtures/scripted-model-client.js';

const firstOf = <T>(items: readonly T[]): T => {
  const [first] = items;
  if (first === undefined) throw new Error('liste vide');
  return first;
};
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('valeur absente');
  return value;
};

/**
 * L'AGENT DE PLANIFICATION DES VÉRIFICATIONS par la vraie boucle : les hypothèses candidates (règles + IA du
 * run) et le périmètre comme données, des propositions aux paramètres réels de chaque sorte, un plan fautif
 * relancé une fois, et la preuve qu'une proposition passe par le chemin ordinaire (`planExperiment` puis
 * `runExperiment`) sans que l'IA n'exécute rien elle-même.
 */

const NOW = '2026-10-31T10:00:00.000Z';
const CATALOG = 'src/main/java/org/example/catalog/books';
const BFF = 'src/main/java/org/example/bff/books';
const BFF_ERROR = String.raw`{"status":500,"error":"Internal Server Error","path":"/api/books","message":"Catalog error: 500 : \"{\"exception\":\"java.lang.NullPointerException\",\"message\":\"Cannot invoke \\\"org.example.catalog.books.Publisher.getName()\\\" because the return value of \\\"org.example.catalog.books.CatalogBook.getPublisher()\\\" is null\",\"path\":\"/catalog/books\"}\""}`;
const BUDGET: AiBudget = {
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
};

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
  service: symbol(
    'catalog',
    'BACKEND',
    'SERVICE',
    `${CATALOG}/CatalogBookService.java`,
    'CatalogBookService.register',
    31,
    { detail: { dereferences: ['book.getPublisher().getName()'] } },
  ),
};
const code = (): CodeIndex => ({
  applications: [
    { id: 'bff', layer: 'BFF', files: 3, skipped: 0 },
    { id: 'catalog', layer: 'BACKEND', files: 3, skipped: 0 },
  ],
  symbols: Object.values(S),
  endpoints: [],
  outgoing: [],
  calls: [],
  denied: [],
  truncated: [],
});
const reproduction = (): ReproductionRun => ({
  id: 'rep_1',
  startedAt: '2026-10-30T09:00:00.000Z',
  status: 'COMPLETED',
  target: 'LOCAL',
  scenario: 'creer-livre',
  reproduced: true,
  actions: [],
  requests: [
    {
      id: 'rep_1:req-3-1',
      method: 'POST',
      path: '/api/books',
      url: '/api/books',
      resourceType: 'fetch',
      correlation: 'OBSERVED',
      status: 500,
      step: 3,
      requestBody: '{"title":"Le Petit Atlas","isbn":"978-2-0000-0000-1"}',
      responseBody: BFF_ERROR,
    },
  ],
  evidence: [],
  screenshots: [],
});

function incident(hypotheses: Hypothesis[] = []): Incident {
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
    investigation: { reproductions: [reproduction()], code: code(), hypotheses, experiments: [] },
  };
}
const rules = (): Hypothesis[] =>
  proposeHypotheses({ incident: incident(), reproduction: reproduction(), code: code() });

const AI_PROPOSALS: HypothesisProposals = {
  hypotheses: [
    {
      id: 'hyp-ai-1',
      title: 'Mapping du champ publisherId perdu dans CatalogClient',
      description: 'd',
      suspectedCause: 'CatalogClient.register omet publisherId.',
      layer: 'BFF',
      locations: [{ applicationId: 'bff', file: S.client.file }],
      supporting: [{ ref: { kind: 'request', id: 'rep_1:req-3-1' }, fact: 'f' }],
      contradicting: [],
      confidence: 0.6,
      verificationHints: [{ kind: 'CHECK_VALIDATION', description: 'lire CatalogClient', params: {} }],
    },
  ],
  existing: [],
  gaps: [],
};

const pack = (label: string, refs: EvidencePack['refs']): EvidencePack => ({
  text: `${label}\n${DATA_DELIMITER_START}\n${refs.map((ref) => ref.id).join('\n')}\n${DATA_DELIMITER_END}`,
  refs,
  omitted: [],
});
function packsOf(inc: Incident): AgentRunContext['packs'] {
  return {
    incident: () => pack('Incident', []),
    reproduction: () => pack('Reproduction', []),
    requests: () => pack('Requests', []),
    graph: () => pack('Graph', []),
    code: () => pack('Code', []),
    hypotheses: () =>
      pack(
        'Hypotheses',
        inc.investigation.hypotheses.map((item) => ({ kind: 'hypothesis' as const, id: item.id })),
      ),
    experiments: () => pack('Experiments', []),
  };
}
function registry(): ToolRegistry {
  const calls: AiToolCall[] = [];
  return {
    calls,
    specs: (names) => names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    call(name, input) {
      const result: ToolResult = { ok: false, error: `tool ${name} refused`, rule: 'test.refused' };
      const trace: AiToolCall = {
        at: NOW,
        name,
        target: JSON.stringify(input),
        allowed: false,
        rule: 'test.refused',
      };
      calls.push(trace);
      return Promise.resolve({ result, trace });
    },
  };
}
function context(
  inc: Incident,
  client: InvestigationModelClient,
  previous: AgentRunContext['previous'] = {},
): AgentRunContext {
  const signal = new AbortController().signal;
  const tools = registry();
  return {
    mode: 'AI_ASSISTED',
    incident: inc,
    tools,
    loop: createAgentLoop({
      client,
      tools,
      budget: createBudgetTracker(BUDGET),
      signal,
      timeoutMs: 5000,
      dataPolicy: {
        allowExternal: true,
        sendSourceCode: true,
        sendHttpBodies: true,
        sendLogs: false,
        sendScreenshots: false,
        maxSnippetChars: 4000,
      },
    }),
    budget: BUDGET,
    packs: packsOf(inc),
    previous,
    signal,
    now: () => NOW,
  };
}

type Item = VerificationPlan['proposals'][number];
const item = (partial: Partial<Item>): Item => ({
  hypothesisId: 'hyp-ai-1',
  kind: 'COMPARE_WITH_PASSING',
  objective: 'montrer que publisherId manque seulement dans l’exécution en échec',
  description: 'rejouer « creer-livre-avec-editeur » et comparer POST /api/books',
  params: { passingScenario: 'creer-livre-avec-editeur', field: 'publisherId' },
  resources: ['navigateur', 'environnement LOCAL'],
  permissions: ['navigate'],
  risks: [],
  sideEffects: false,
  expected: 'publisherId présent côté réussite, absent côté échec',
  confirmIf: 'MISSING_LEFT sur publisherId',
  refuteIf: 'corps identiques',
  priority: 1,
  ...partial,
});
const plan = (proposals: Item[], extra: Partial<VerificationPlan> = {}): VerificationPlan => ({
  proposals,
  gaps: [],
  ...extra,
});

describe('verification planning agent', () => {
  it('applies when a hypothesis exists in the incident or was proposed in the run; candidates merge both', () => {
    const client = scriptedModelClient();
    expect(createVerificationPlanningAgent().applies(context(incident(), client))).toBe(false);
    expect(verificationPlanningAgent.applies(context(incident(), client, { HYPOTHESIS: AI_PROPOSALS }))).toBe(
      true,
    );
    const candidates = candidateHypotheses({
      incident: incident(rules()),
      previous: { HYPOTHESIS: AI_PROPOSALS },
    });
    expect(candidates.map((candidate) => [candidate.id, candidate.origin])).toEqual([
      ['hyp-null-relation', 'RULE'],
      ['hyp-missing-validation', 'RULE'],
      ['hyp-backend-propagated', 'RULE'],
      ['hyp-ai-1', 'AI'],
    ]);
    expect(candidates[3]?.files).toEqual([S.client.file]);
  });

  it('plans executable verifications with the real params of each kind, from candidates and scope given as data', async () => {
    const client = scriptedModelClient({
      turns: [
        finalTurn(
          plan([
            item({}),
            item({
              hypothesisId: 'hyp-null-relation',
              kind: 'UNIT_TEST',
              params: {
                applicationId: 'catalog',
                test: 'CatalogBookServiceTest',
                patterns: ['NullPointerException'],
              },
              permissions: ['runTests UNIT'],
              priority: 2,
            }),
            item({
              kind: 'CHECK_VALIDATION',
              params: { applicationId: 'bff', file: S.request.file, field: 'publisherId' },
              priority: 3,
            }),
            item({
              hypothesisId: 'hyp-null-relation',
              kind: 'INSPECT_LOGS',
              params: { applicationId: 'catalog', patterns: ['NullPointerException'] },
              permissions: ['readLogs'],
              priority: 4,
            }),
            item({
              hypothesisId: 'hyp-backend-propagated',
              kind: 'INTEGRATION_TEST',
              params: { applicationId: 'bff', environmentKind: 'CI' },
              sideEffects: true,
              priority: 5,
            }),
          ]),
        ),
      ],
    });
    const inc = incident(rules());
    const outcome = await verificationPlanningAgent.run(context(inc, client, { HYPOTHESIS: AI_PROPOSALS }));
    expect(outcome.result.status).toBe('DONE');
    expect(outcome.result.output?.proposals).toHaveLength(5);
    expect(outcome.limitations).toEqual([]);

    const first = client.calls[0];
    expect(first?.input.tools.map((tool) => tool.name)).toEqual([...VERIFICATION_TOOLS]);
    expect(first?.input.tools.map((tool) => tool.name)).not.toContain('propose_experiment');
    expect(first?.input.system).toContain(VERIFICATION_SYSTEM.trim());
    for (const kind of EXPERIMENT_KINDS)
      expect(first?.input.system).toContain(`- ${kind}: ${VERIFICATION_PARAMS[kind].summary}`);
    expect(first?.input.outputSchema).toEqual(VERIFICATION_PLAN_JSON_SCHEMA);
    const user = first?.input.messages[0]?.content ?? '';
    expect(user).toContain('Hypotheses to verify (ids)');
    expect(user).toContain('"id": "hyp-ai-1"');
    expect(user).toContain('Scope: what is permitted');
    expect(user).toContain('"runTests": "NONE"');
    expect(user).toContain('creer-livre-avec-editeur');
    expect(scopeDigest(inc)).toMatchObject({
      executionTarget: 'LOCAL',
      incidentScenario: 'creer-livre',
      reproductions: [{ id: 'rep_1', failingRequests: ['POST /api/books'] }],
    });

    const all = [...rules(), { ...firstOf(rules()), id: 'hyp-ai-1', title: 'ia', suspectedCause: 'ia' }];
    const { proposals, dropped } = toProposals(must(outcome.result.output), all, inc, 'ai_run_1');
    expect(dropped).toEqual([]);
    expect(
      proposals.map((proposal) => [
        proposal.kind,
        proposal.hypothesisId,
        proposal.sideEffects,
        proposal.status,
      ]),
    ).toEqual([
      ['COMPARE_WITH_PASSING', 'hyp-ai-1', false, 'PROPOSED'],
      ['UNIT_TEST', 'hyp-null-relation', false, 'PROPOSED'],
      ['CHECK_VALIDATION', 'hyp-ai-1', false, 'PROPOSED'],
      ['INSPECT_LOGS', 'hyp-null-relation', false, 'PROPOSED'],
      ['INTEGRATION_TEST', 'hyp-backend-propagated', true, 'PROPOSED'],
    ]);
  });

  it('rejects an unknown hypothesis and params the runner would refuse, with one retry', async () => {
    const client = scriptedModelClient({
      turns: [
        finalTurn(
          plan([
            item({ hypothesisId: 'hyp-ghost' }),
            item({ kind: 'COMPARE_REQUESTS', params: { left: 'rep_1', right: 'rep_2', bogus: 'x' } }),
          ]),
        ),
        finalTurn(
          plan([item({})], { noUsefulVerification: 'les tests ne sont pas permis dans ce périmètre' }),
        ),
      ],
    });
    const outcome = await verificationPlanningAgent.run(
      context(incident(rules()), client, { HYPOTHESIS: AI_PROPOSALS }),
    );
    expect(outcome.result.status).toBe('DONE');
    expect(outcome.result.reasons).toEqual([
      'first answer rejected: unknown hypothesis "hyp-ghost": use one of hyp-null-relation, hyp-missing-validation, hyp-backend-propagated, hyp-ai-1',
      'first answer rejected: COMPARE_REQUESTS: unknown param "bogus"',
      'first answer rejected: COMPARE_REQUESTS: params.right is not a reproduction id',
    ]);
    expect(outcome.limitations).toEqual([
      'Aucune vérification utile : les tests ne sont pas permis dans ce périmètre',
    ]);
    expect(
      validatePlan(
        plan([item({})]),
        candidateHypotheses({ incident: incident(), previous: { HYPOTHESIS: AI_PROPOSALS } }),
        incident(),
      ),
    ).toEqual([]);
    expect(verificationParamsProblems('REPLAY', {}, incident())).toEqual([]);
    expect(
      verificationParamsProblems('COMPARE_WITH_PASSING', { passingScenario: 'creer-livre' }, incident()),
    ).toEqual(['COMPARE_WITH_PASSING: passingScenario must differ from the incident scenario']);
  });

  it('a planned proposal goes through the ordinary path: planExperiment then runExperiment, with the policy deciding', async () => {
    const inc = incident(rules());
    const { proposals } = toProposals(
      plan([
        item({
          kind: 'CHECK_VALIDATION',
          params: { applicationId: 'bff', file: S.request.file, field: 'publisherId' },
        }),
      ]),
      [{ ...firstOf(rules()), id: 'hyp-ai-1' }],
      inc,
      'ai_run_1',
    );
    const proposal = firstOf(proposals);
    const experiment = planExperiment(
      {
        kind: proposal.kind,
        params: proposal.verification.params,
        hypothesisId: proposal.hypothesisId,
        description: proposal.verification.description,
      },
      new Date(NOW),
    );
    expect(experiment.status).toBe('PROPOSED');
    expect(experiment.hypothesisId).toBe('hyp-ai-1');

    const decisions: string[] = [];
    const policy = {
      check: (operation: { kind: string }) => {
        decisions.push(operation.kind);
        return Promise.resolve({ allowed: true, reason: 'ok', rule: 'test', operation });
      },
      consume: () => true,
    };
    const context: ExperimentContext = {
      incident: inc,
      policy: policy as unknown as ExperimentContext['policy'],
      adapter: {} as ExperimentContext['adapter'],
      files: {
        readText: () =>
          Promise.resolve(
            'public class CreateBookRequest {\n  @NotBlank private String title;\n  private Long publisherId;\n}\n',
          ),
      } as unknown as ExperimentContext['files'],
      replay: () => Promise.reject(new Error('never')),
      signal: new AbortController().signal,
      actor: 'orchestrateur',
      now: () => new Date(NOW),
    };
    const done = await runExperiment(experiment, context);
    expect(decisions).toEqual(['READ_FILE']);
    expect(done.status).toBe('DONE');
    expect(done.outcome).toBe('SUPPORTS');
    expect(done.hypothesisId).toBe('hyp-ai-1');
    expect(done.evidence.length).toBeGreaterThan(0);
  });
});
