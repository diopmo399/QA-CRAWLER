import { describe, expect, it } from 'vitest';
import type { AgentRunContext, EvidencePack, ToolRegistry, ToolResult } from '../../src/incident/ai/agent.js';
import { DATA_DELIMITER_END, DATA_DELIMITER_START } from '../../src/incident/ai/agent.js';
import {
  HYPOTHESIS_TOOLS,
  createHypothesisAgent,
  hypothesesDigest,
  hypothesisAgent,
  identifyProposals,
  validateHypotheses,
} from '../../src/incident/ai/agents/hypothesis.js';
import { createBudgetTracker } from '../../src/incident/ai/budget.js';
import { createAgentLoop } from '../../src/incident/ai/loop.js';
import { incidentRefLookup, mergeHypotheses, toHypotheses } from '../../src/incident/ai/merge.js';
import type { InvestigationModelClient } from '../../src/incident/ai/model-client.js';
import { HYPOTHESIS_SYSTEM } from '../../src/incident/ai/prompts/hypothesis.js';
import {
  HYPOTHESIS_PROPOSALS_JSON_SCHEMA,
  type HypothesisProposalsModel,
} from '../../src/incident/ai/schemas/analysis.js';
import { proposeHypotheses } from '../../src/incident/hypotheses.js';
import type { AiBudget, AiToolCall } from '../../src/sdk/core/incident-ai-contracts.js';
import type {
  CodeIndex,
  CodeSymbol,
  Hypothesis,
  Incident,
  ReproductionRun,
} from '../../src/sdk/core/incident-contracts.js';
import { finalTurn, scriptedModelClient } from '../fixtures/scripted-model-client.js';

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('valeur absente');
  return value;
};

/**
 * L'AGENT D'HYPOTHÈSES par la vraie boucle : les hypothèses de règle sont transmises comme données à ne pas
 * dupliquer, une proposition qui les recoupe reprend leur identifiant (la fusion lui ajoute ses références),
 * les nouvelles reçoivent `hyp-ai-<n>` à la suite, références et fichiers inconnus rejetés, ré-évaluation.
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
  evidence: [
    {
      id: 'rep_1:ev-issue-1',
      kind: 'REQUEST',
      summary: 'POST /api/books → 500',
      source: { reproduction: 'rep_1', step: 3 },
    },
  ],
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
        },
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

const pack = (label: string, refs: EvidencePack['refs']): EvidencePack => ({
  text: `${label}\n${DATA_DELIMITER_START}\n${refs.map((ref) => `${ref.kind} ${ref.id}`).join('\n')}\n${DATA_DELIMITER_END}`,
  refs,
  omitted: [],
});
function packsOf(inc: Incident): AgentRunContext['packs'] {
  return {
    incident: () => pack('Incident', []),
    reproduction: () => pack('Reproduction', []),
    requests: () => pack('Requests', [{ kind: 'request', id: 'rep_1:req-3-1' }]),
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

const fresh = (): HypothesisProposalsModel['hypotheses'][number] => ({
  title: 'Mapping du champ publisherId perdu dans CatalogClient',
  description: 'Le client HTTP du BFF reconstruit le corps sans publisherId.',
  suspectedCause: 'CatalogClient.register omet publisherId lors de la conversion du DTO.',
  layer: 'BFF',
  locations: [{ applicationId: 'bff', file: S.client.file, line: 28 }],
  supporting: [
    { ref: { kind: 'request', id: 'rep_1:req-3-1' }, fact: 'corps sans publisherId' },
    { ref: { kind: 'symbol', id: S.client.id }, fact: 'construit le corps' },
  ],
  contradicting: [],
  confidence: 0.9,
  verificationHints: [
    { kind: 'COMPARE_WITH_PASSING', description: 'comparer avec un scénario qui réussit', params: {} },
  ],
});

const output = (overrides: Partial<HypothesisProposalsModel> = {}): HypothesisProposalsModel => ({
  hypotheses: [fresh()],
  existing: [],
  gaps: [],
  ...overrides,
});

describe('hypothesis agent', () => {
  it('applies when there is a reproduction or a previous output to reason about', () => {
    const client = scriptedModelClient();
    const empty = incident();
    empty.investigation.reproductions = [];
    expect(createHypothesisAgent().applies(context(empty, client))).toBe(false);
    expect(hypothesisAgent.applies(context(empty, client, { CROSS_LAYER: { findings: [] } }))).toBe(true);
    expect(hypothesisAgent.applies(context(incident(), client))).toBe(true);
  });

  it('gives hyp-ai ids to new proposals, reuses the id of an overlapped rule hypothesis, and the merge keeps the rule one', async () => {
    const existing = rules();
    const nullRelation = existing.find((item) => item.id === 'hyp-null-relation');
    if (!nullRelation) throw new Error('expected hyp-null-relation');
    const duplicate = {
      ...fresh(),
      title: nullRelation.title,
      suspectedCause: 'formulation différente',
      supporting: [{ ref: { kind: 'evidence' as const, id: 'rep_1:ev-issue-1' }, fact: 'nouvelle preuve' }],
      locations: [],
    };
    const client = scriptedModelClient({
      turns: [
        finalTurn(
          output({
            hypotheses: [duplicate, fresh()],
            existing: [
              {
                hypothesisId: 'hyp-backend-propagated',
                assessment: 'SUPPORTS',
                summary: 'le BFF convertit en 500 générique',
                refs: [{ kind: 'request', id: 'rep_1:req-3-1' }],
              },
            ],
          }),
        ),
      ],
    });
    const inc = incident(existing);
    const outcome = await hypothesisAgent.run(
      context(inc, client, { CROSS_LAYER: { findings: [{ title: 'champ perdu' }] } }),
    );

    expect(outcome.result.status).toBe('DONE');
    expect(outcome.result.output?.hypotheses.map((item) => item.id)).toEqual([
      'hyp-null-relation',
      'hyp-ai-1',
    ]);
    expect(outcome.result.output?.existing[0]?.assessment).toBe('SUPPORTS');
    expect(outcome.limitations).toEqual([
      `Proposition IA « ${nullRelation.title} » recoupe l'hypothèse hyp-null-relation : ses références lui sont ajoutées, aucun doublon créé.`,
    ]);

    const first = client.calls[0];
    expect(first?.input.tools.map((tool) => tool.name)).toEqual([...HYPOTHESIS_TOOLS]);
    expect(first?.input.system).toContain(HYPOTHESIS_SYSTEM.trim());
    expect(first?.input.system).toContain('between 0 and 0.7');
    expect(first?.input.outputSchema).toEqual(HYPOTHESIS_PROPOSALS_JSON_SCHEMA);
    const user = first?.input.messages[0]?.content ?? '';
    expect(user).toContain('Existing hypotheses (ids to assess, never to duplicate)');
    for (const rule of existing) expect(user).toContain(`"id": "${rule.id}"`);
    expect(user).toContain('Cross-layer findings (previous agent output)');
    expect(user).toContain('champ perdu');
    expect(hypothesesDigest(existing)[0]).toEqual({
      id: 'hyp-null-relation',
      title: nullRelation.title,
      suspectedCause: nullRelation.suspectedCause,
      layer: 'BACKEND',
      status: 'PROPOSED',
      confidence: nullRelation.confidence,
    });

    // La fusion : la règle gagne et reçoit la preuve ; la nouvelle hypothèse IA naît PROPOSED, plafonnée.
    const { hypotheses } = toHypotheses(
      must(outcome.result.output),
      incidentRefLookup(inc),
      'ai_run_1',
      NOW,
      {
        existing,
        incident: inc,
      },
    );
    const merged = mergeHypotheses(existing, hypotheses);
    expect(merged.map((item) => item.id)).toEqual([...existing.map((item) => item.id), 'hyp-ai-1']);
    const kept = merged.find((item) => item.id === 'hyp-null-relation');
    expect(kept?.origin).toBeUndefined();
    expect(kept?.supporting.map((item) => item.ref)).toContain('rep_1:ev-issue-1');
    expect(kept?.confidence).toBe(nullRelation.confidence);
    const ai = merged.find((item) => item.id === 'hyp-ai-1');
    expect(ai).toMatchObject({
      origin: 'AI',
      aiRunId: 'ai_run_1',
      status: 'PROPOSED',
      confidence: 0.7,
      files: [S.client.file],
    });
  });

  it('rejects unknown refs, files and hypothesis ids with one retry, then FAILS', async () => {
    const client = scriptedModelClient({
      turns: [
        finalTurn(
          output({
            hypotheses: [
              {
                ...fresh(),
                supporting: [{ ref: { kind: 'evidence', id: 'ghost' }, fact: 'x' }],
                locations: [{ applicationId: 'bff', file: 'Invented.java' }],
              },
            ],
            existing: [{ hypothesisId: 'hyp-ghost', assessment: 'NEUTRAL', summary: 's', refs: [] }],
          }),
        ),
        finalTurn(output({ hypotheses: [{ ...fresh(), confidence: 2 }] })),
      ],
    });
    const outcome = await hypothesisAgent.run(context(incident(rules()), client));
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.output).toBeUndefined();
    expect(outcome.result.reasons).toEqual([
      'first answer rejected: unknown evidence reference "ghost": cite only existing ids',
      'first answer rejected: unknown file "bff:Invented.java": cite only files of the code index or files you read',
      'first answer rejected: unknown hypothesis "hyp-ghost" in existing: assess only listed hypotheses',
      expect.stringContaining('rejected after retry: hypotheses.0.confidence'),
    ]);
    expect(validateHypotheses(output(), incidentRefLookup(incident()), [])).toEqual([]);
  });

  it('re-evaluation: numbers after the hypotheses proposed earlier in the run and reuses the id of one it overlaps by cause', () => {
    const earlier = { ...fresh(), id: 'hyp-ai-1' };
    const identified = identifyProposals(
      output({
        hypotheses: [
          { ...fresh(), title: 'Autre titre' },
          { ...fresh(), title: 'Nouvelle piste', suspectedCause: 'cause inédite' },
        ],
      }),
      rules(),
      [earlier],
    );
    expect(identified.hypotheses.map((item) => [item.id, item.title])).toEqual([
      ['hyp-ai-1', 'Autre titre'],
      ['hyp-ai-2', 'Nouvelle piste'],
    ]);
  });
});
