import { describe, expect, it } from 'vitest';
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopResult,
  AgentRunContext,
  EvidencePack,
  ToolRegistry,
  ToolResult,
} from '../../src/incident/ai/agent.js';
import { DATA_DELIMITER_END, DATA_DELIMITER_START } from '../../src/incident/ai/agent.js';
import {
  CONTESTED_AGENTS,
  CONTRADICTION_HUNTER_DEFAULTS,
  CONTRADICTION_HUNTER_TOOLS,
  contradictionHunterAgent,
  contradictionHunterPacks,
  contradictionHunterUserMessage,
  contradictionRefLookup,
  createContradictionHunterAgent,
  hasHypothesesToContest,
  previousConclusionsText,
  previousHypothesisIds,
} from '../../src/incident/ai/agents/contradiction-hunter.js';
import type { InvestigationModelClient } from '../../src/incident/ai/model-client.js';
import {
  CONTRADICTION_KIND_GUIDE,
  CONTRADICTION_SYSTEM_PROMPT,
} from '../../src/incident/ai/prompts/contradiction.js';
import type { ContradictionFindings } from '../../src/incident/ai/schemas/contradiction.js';
import {
  CONTRADICTION_FINDINGS_JSON_SCHEMA,
  CONTRADICTION_LIMITS,
  ContradictionFindingsSchema,
  collectContradictionRefs,
  contestedHypothesisIds,
  validateContradictionFindings,
} from '../../src/incident/ai/schemas/contradiction.js';
import {
  AI_AGENTS,
  CONTRADICTION_KINDS,
  type AiBudget,
  type AiRef,
  type AiToolCall,
} from '../../src/sdk/core/incident-ai-contracts.js';
import type { Incident } from '../../src/sdk/core/incident-contracts.js';
import { demoIncident } from '../../src/sdk/ui/incident-demo.js';
import {
  agentKeyOf,
  finalTurn,
  scriptedModelClient,
  toolCallsTurn,
} from '../fixtures/scripted-model-client.js';

/**
 * Le chasseur de contradictions décrit ; une boucle minimale (locale au test) exécute avec le client scripté
 * partagé. L'exemple : l'incident de démonstration (NullPointerException sur CatalogBook.getPublisher() après un
 * POST /api/books sans publisherId). Le chasseur vérifie que le champ manquait vraiment (get_request sur la
 * requête en échec), que le BFF ne l'a pas perdu (BookMapper), qu'il n'y a pas un autre null ou une autre ligne
 * (search_code, CatalogBookService), et que le même point d'entrée passe ailleurs (rep_2). Une référence
 * inventée est rejetée (une relance, puis FAILED) ; une question ouverte est gardée comme telle.
 */

const FAILING_REQUEST = 'rep_1:req-3-1';
const PASSING_REQUEST = 'rep_2:req-4-1';
const MAPPER_FILE = 'src/main/java/org/example/bff/books/BookMapper.java';
const SERVICE_FILE = 'src/main/java/org/example/catalog/books/CatalogBookService.java';
const MAPPER_SYMBOL = `bff:${MAPPER_FILE}#BookMapper.toCatalog`;
const REGISTER_SYMBOL = `catalog:${SERVICE_FILE}#CatalogBookService.register`;
const GET_PUBLISHER_SYMBOL =
  'catalog:src/main/java/org/example/catalog/books/CatalogBook.java#CatalogBook.getPublisher';
const CONFIG_FILE = 'src/main/resources/application.yml';

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

const ZERO_USAGE = {
  iterations: 0,
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCost: 0,
  durationMs: 0,
  files: 0,
  commands: 0,
  experiments: 0,
};

function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  if (item === undefined) throw new Error(`expected an item at index ${String(index)}`);
  return item;
}

function pack(section: string, refs: AiRef[] = [], omitted: string[] = []): EvidencePack {
  return { text: `${DATA_DELIMITER_START}\n[${section}]\n${DATA_DELIMITER_END}`, refs, omitted };
}

function packs(): AgentRunContext['packs'] {
  return {
    incident: () => pack('incident'),
    reproduction: () => pack('reproduction rep_1'),
    requests: (options) =>
      pack(
        `requests ${options?.errorsOnly ? 'errorsOnly' : 'all'}`,
        [
          { kind: 'request', id: FAILING_REQUEST },
          { kind: 'request', id: PASSING_REQUEST },
        ],
        ['HTTP bodies not sent (data policy)'],
      ),
    graph: () => pack('graph'),
    code: () => pack('code'),
    hypotheses: () => pack('hypotheses'),
    experiments: () => pack('experiments'),
  };
}

/** Un registre fictif : requêtes de l'incident, fichiers connus ; les autres outils rendent un objet vide. */
function fakeRegistry(
  incident: Incident,
  sources: Record<string, string>,
): ToolRegistry & { calls: AiToolCall[] } {
  const calls: AiToolCall[] = [];
  return {
    calls,
    specs: (names) => names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    call(name, input) {
      const args = (input ?? {}) as { applicationId?: string; file?: string; id?: string; query?: string };
      let result: ToolResult;
      let target = name;
      if (name === 'read_source') {
        target = `${args.applicationId ?? '?'}:${args.file ?? '?'}`;
        const text = args.file ? sources[`${args.applicationId ?? ''}:${args.file}`] : undefined;
        result =
          text === undefined
            ? { ok: false, error: 'file outside the authorised scope', rule: 'scope.files' }
            : { ok: true, data: { file: args.file, text } };
      } else if (name === 'get_request') {
        target = args.id ?? '?';
        const request = incident.investigation.reproductions
          .flatMap((run) => run.requests)
          .find((item) => item.id === args.id);
        result = request
          ? { ok: true, data: { id: request.id, status: request.status, body: request.requestBody ?? null } }
          : { ok: false, error: 'unknown request' };
      } else if (name === 'search_code') {
        target = args.query ?? '?';
        result = {
          ok: true,
          data: { hits: [{ file: 'src/main/java/org/example/catalog/books/CatalogBook.java', line: 61 }] },
        };
      } else {
        result = { ok: true, data: {} };
      }
      const trace: AiToolCall = {
        at: 'now',
        name,
        target,
        allowed: result.ok,
        ...(result.rule ? { rule: result.rule } : {}),
      };
      calls.push(trace);
      return Promise.resolve({ result, trace });
    },
  };
}

/** La boucle minimale du test : tours, outils, délimiteurs, schéma, validation des références, une relance. */
function miniLoop(client: InvestigationModelClient, registry: ToolRegistry): AgentLoop {
  return async <Output>(input: AgentLoopInput<Output>): Promise<AgentLoopResult<Output>> => {
    const messages: AgentLoopResult<Output>['messages'] = [{ role: 'user', content: input.user }];
    const toolCalls: AiToolCall[] = [];
    let turns = 0;
    let retried = false;
    let reasons: string[] = [];
    const base = { toolCalls, usage: ZERO_USAGE, messages };
    while (turns < input.maxTurns) {
      turns++;
      const turn = await client.complete(
        {
          system: input.system,
          messages,
          tools: registry.specs(input.tools),
          outputSchema: input.outputSchema,
          maxOutputTokens: 4000,
        },
        { signal: new AbortController().signal, timeoutMs: 1000 },
      );
      if (turn.kind === 'tool_calls') {
        messages.push({ role: 'assistant', content: JSON.stringify(turn.calls) });
        for (const call of turn.calls) {
          if (toolCalls.length >= input.maxToolCalls) break;
          const allowed = (input.tools as readonly string[]).includes(call.name);
          const { result, trace } = allowed
            ? await registry.call(call.name, call.input)
            : {
                result: { ok: false, error: 'tool not allowed for this agent' },
                trace: { at: 'now', name: call.name, target: call.name, allowed: false, rule: 'agent.tools' },
              };
          toolCalls.push(trace);
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: `${DATA_DELIMITER_START}\n${JSON.stringify(result)}\n${DATA_DELIMITER_END}`,
          });
        }
        continue;
      }
      const parsed = input.schema.safeParse(turn.raw);
      if (parsed.success) {
        reasons = input.validate(parsed.data);
        if (reasons.length === 0) return { ...base, output: parsed.data, turns, reasons, status: 'DONE' };
      } else {
        reasons = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      }
      if (retried) return { ...base, turns, reasons, status: 'FAILED' };
      retried = true;
      messages.push({ role: 'assistant', content: JSON.stringify(turn.raw) });
      messages.push({
        role: 'user',
        content: `Your output was rejected:\n- ${reasons.join('\n- ')}\nReturn a corrected JSON object.`,
      });
    }
    return { ...base, turns, reasons: [...reasons, 'maxTurns reached'], status: 'BUDGET' };
  };
}

const SOURCES: Record<string, string> = {
  [`bff:${MAPPER_FILE}`]:
    'class BookMapper { CatalogBookPayload toCatalog(CreateBookRequest r) { return new CatalogBookPayload(r.title(), r.isbn(), r.publisherId()); } }',
  [`catalog:${SERVICE_FILE}`]:
    'class CatalogBookService { CatalogBook register(NewCatalogBook b) { book.setCatalogLabel(book.getPublisher().getName()); } }',
  [`bff:${CONFIG_FILE}`]: 'catalog:\n  base-url: http://localhost:8081',
};

function context(
  loop: AgentLoop,
  tools: ToolRegistry,
  overrides: Partial<AgentRunContext> = {},
): AgentRunContext {
  return {
    mode: 'AI_AGENTIC',
    incident: demoIncident(),
    tools,
    loop,
    budget: BUDGET,
    packs: packs(),
    previous: {},
    signal: new AbortController().signal,
    now: () => '2026-10-31T10:00:00.000Z',
    ...overrides,
  };
}

/** La sortie attendue sur l'exemple NPE : quatre angles d'attaque, trois cités, une question ouverte. */
function goodOutput(): ContradictionFindings {
  return {
    contradictions: [
      {
        hypothesisId: 'hyp-null-relation',
        kind: 'PASSING_SCENARIO',
        summary:
          'La même création réussit dans rep_2 avec publisherId renseigné : la condition suspectée (champ absent) est bien la différence, mais rien ne montre encore que le BFF transmet le champ quand il est présent.',
        refs: [
          { kind: 'request', id: FAILING_REQUEST },
          { kind: 'request', id: PASSING_REQUEST },
        ],
        openQuestion: false,
        decisiveVerification: {
          kind: 'COMPARE_REQUESTS',
          description: 'comparer les requêtes POST /api/books de rep_1 et rep_2 sur publisherId',
          params: { left: 'rep_1', right: 'rep_2', field: 'publisherId' },
        },
      },
      {
        hypothesisId: 'hyp-null-relation',
        kind: 'ALTERNATIVE_EXPLANATION',
        summary:
          'BookMapper.toCatalog recopie publisherId tel quel : si le BFF le perdait, la relation serait nulle même avec un champ présent ; le code lu ne le montre pas, l’explication alternative reste à écarter par une preuve.',
        refs: [
          { kind: 'symbol', id: MAPPER_SYMBOL },
          { kind: 'file', id: `bff:${MAPPER_FILE}` },
        ],
        openQuestion: false,
      },
      {
        hypothesisId: 'hyp-null-relation',
        kind: 'INCOMPATIBLE_CODE_PATH',
        summary:
          'Le déréférencement lu dans CatalogBookService.register est getPublisher().getName() : aucune autre valeur nulle sur ce chemin, mais la ligne exacte citée par la trace reste à rapprocher du code lu.',
        refs: [
          { kind: 'symbol', id: REGISTER_SYMBOL },
          { kind: 'symbol', id: GET_PUBLISHER_SYMBOL },
        ],
        openQuestion: false,
      },
      {
        hypothesisId: 'hyp-backend-propagated',
        kind: 'MISSING_EVIDENCE',
        summary:
          'Aucun journal du backend dans l’investigation : impossible de savoir si une autre exception a précédé la NullPointerException.',
        refs: [],
        openQuestion: true,
      },
    ],
  };
}

describe('ContradictionFindings schema', () => {
  it('accepts a complete output and rejects unknown keys, kinds and empty strings', () => {
    expect(ContradictionFindingsSchema.safeParse(goodOutput()).success).toBe(true);
    expect(ContradictionFindingsSchema.safeParse({ ...goodOutput(), extra: 1 }).success).toBe(false);
    expect(ContradictionFindingsSchema.safeParse({}).success).toBe(false);
    const wrongKind = goodOutput();
    wrongKind.contradictions[0] = {
      ...at(wrongKind.contradictions, 0),
      kind: 'SOMETHING' as 'PASSING_SCENARIO',
    };
    expect(ContradictionFindingsSchema.safeParse(wrongKind).success).toBe(false);
    const empty = goodOutput();
    empty.contradictions[0] = { ...at(empty.contradictions, 0), summary: '  ' };
    expect(ContradictionFindingsSchema.safeParse(empty).success).toBe(false);
    const badHint = goodOutput();
    badHint.contradictions[0] = {
      ...at(badHint.contradictions, 0),
      decisiveVerification: { kind: 'DROP_TABLE' as 'REPLAY', description: 'x', params: {} },
    };
    expect(ContradictionFindingsSchema.safeParse(badHint).success).toBe(false);
    expect(ContradictionFindingsSchema.safeParse({ contradictions: [] }).success).toBe(true);
  });

  it('bounds the number of items and the JSON Schema mirrors the zod schema', () => {
    const tooMany = {
      contradictions: Array.from({ length: CONTRADICTION_LIMITS.maxContradictions + 1 }, () =>
        at(goodOutput().contradictions, 3),
      ),
    };
    expect(ContradictionFindingsSchema.safeParse(tooMany).success).toBe(false);
    const root = CONTRADICTION_FINDINGS_JSON_SCHEMA as {
      required?: string[];
      additionalProperties?: boolean;
      properties: Record<
        string,
        { items?: { required?: string[]; properties: Record<string, { enum?: string[] }> } }
      >;
    };
    expect(root.required).toEqual(['contradictions']);
    expect(root.additionalProperties).toBe(false);
    const item = at([root.properties['contradictions']?.items], 0);
    if (!item) throw new Error('items expected');
    expect(Object.keys(item.properties).sort()).toEqual([
      'decisiveVerification',
      'hypothesisId',
      'kind',
      'openQuestion',
      'refs',
      'summary',
    ]);
    expect(item.required).toEqual(['hypothesisId', 'kind', 'summary', 'refs', 'openQuestion']);
    expect(item.properties['kind']?.enum).toEqual([...CONTRADICTION_KINDS]);
  });

  it('collects refs without duplicates and the contested hypotheses in order', () => {
    const output = goodOutput();
    output.contradictions.push({ ...at(output.contradictions, 0) });
    expect(collectContradictionRefs(output)).toHaveLength(6);
    expect(contestedHypothesisIds(output)).toEqual(['hyp-null-relation', 'hyp-backend-propagated']);
  });

  it('validateContradictionFindings names unknown hypotheses, unknown refs and findings without refs', () => {
    const known = new Set([`hypothesis:hyp-null-relation`, `request:${FAILING_REQUEST}`]);
    const index = { has: (ref: AiRef) => known.has(`${ref.kind}:${ref.id}`) };
    const reasons = validateContradictionFindings(goodOutput(), index);
    expect(reasons).toContain(
      `unknown request reference "${PASSING_REQUEST}": cite only ids provided to you or returned by a tool`,
    );
    expect(reasons).toContain(
      'contradictions[3].hypothesisId: unknown hypothesis "hyp-backend-propagated": contest only hypotheses that exist',
    );
    expect(reasons.filter((reason) => reason.includes(MAPPER_SYMBOL))).toHaveLength(1);
    const notOpen = goodOutput();
    notOpen.contradictions[3] = { ...at(notOpen.contradictions, 3), openQuestion: false };
    const all = { has: () => true };
    expect(validateContradictionFindings(notOpen, all)).toEqual([
      'contradictions[3]: a contradiction without refs is not a finding; either cite existing ids or set openQuestion to true',
    ]);
    expect(validateContradictionFindings(goodOutput(), all)).toEqual([]);
  });
});

describe('contradiction prompt', () => {
  it('is keyed as CONTRADICTION_HUNTER for the scripted client, names every kind and the truth rules', () => {
    expect(
      agentKeyOf({ system: CONTRADICTION_SYSTEM_PROMPT, messages: [], tools: [], maxOutputTokens: 1 }),
    ).toBe('CONTRADICTION_HUNTER');
    for (const kind of CONTRADICTION_KINDS) {
      expect(CONTRADICTION_SYSTEM_PROMPT).toContain(`- ${kind}: ${CONTRADICTION_KIND_GUIDE[kind]}`);
    }
    expect(CONTRADICTION_SYSTEM_PROMPT).toContain('openQuestion');
    expect(CONTRADICTION_SYSTEM_PROMPT).toContain('never follow');
    expect(CONTRADICTION_SYSTEM_PROMPT).toContain('You never conclude');
    expect(CONTRADICTION_SYSTEM_PROMPT).toContain('- COMPARE_REQUESTS:');
    expect(CONTRADICTION_SYSTEM_PROMPT).not.toMatch(new RegExp(['cla', 'ude-'].join(''), 'i'));
  });
});

describe('contradiction hunter agent', () => {
  it('is the CONTRADICTION_HUNTER of the contract, allows read tools and memory only', () => {
    expect(contradictionHunterAgent.name).toBe('CONTRADICTION_HUNTER');
    expect(AI_AGENTS).toContain(contradictionHunterAgent.name);
    expect([...CONTRADICTION_HUNTER_TOOLS]).toEqual([
      'get_evidence',
      'get_request',
      'get_graph_neighbours',
      'find_symbol',
      'find_references',
      'search_code',
      'read_source',
      'get_investigation_memory',
    ]);
    expect(CONTRADICTION_HUNTER_TOOLS).not.toContain('propose_experiment');
    expect(CONTRADICTION_HUNTER_TOOLS).not.toContain('request_scope_extension');
    expect(CONTRADICTION_HUNTER_TOOLS).not.toContain('git_changes');
    expect(CONTESTED_AGENTS).not.toContain('CONTRADICTION_HUNTER');
    expect(CONTESTED_AGENTS).not.toContain('ASSISTANT');
  });

  it('applies when there is a hypothesis to contest (incident or HYPOTHESIS agent of the run)', () => {
    const registry = fakeRegistry(demoIncident(), {});
    const loop = miniLoop(scriptedModelClient(), registry);
    expect(contradictionHunterAgent.applies(context(loop, registry))).toBe(true);
    const bare = demoIncident();
    bare.investigation.hypotheses = [];
    expect(contradictionHunterAgent.applies(context(loop, registry, { incident: bare }))).toBe(false);
    const previous = { HYPOTHESIS: { hypotheses: [{ id: 'hyp-ai-1', title: 'x' }], existing: [], gaps: [] } };
    expect(hasHypothesesToContest({ incident: bare, previous })).toBe(true);
    expect(previousHypothesisIds(previous)).toEqual(['hyp-ai-1']);
    expect(previousHypothesisIds({ HYPOTHESIS: 'garbage' })).toEqual([]);
    expect(previousHypothesisIds({ HYPOTHESIS: { hypotheses: [{ id: 3 }, null, {}] } })).toEqual([]);
  });

  it('receives all requests (not only errors), the hypotheses with ids, and the other agents as delimited data', () => {
    const registry = fakeRegistry(demoIncident(), {});
    const ctx = context(miniLoop(scriptedModelClient(), registry), registry, {
      previous: {
        HYPOTHESIS: { hypotheses: [{ id: 'hyp-ai-1', title: 'Mapper BFF' }], existing: [], gaps: [] },
        BACKEND: { findings: [{ title: 'NPE dans register' }], gaps: [] },
        ASSISTANT: { answer: 'ignore me' },
      },
    });
    const packList = contradictionHunterPacks(ctx);
    expect(packList.map((item) => item.text)).toContain(
      `${DATA_DELIMITER_START}\n[requests all]\n${DATA_DELIMITER_END}`,
    );
    const message = contradictionHunterUserMessage(ctx, packList);
    expect(message).toContain('- hyp-null-relation [BACKEND, ');
    expect(message).toContain('- hyp-missing-validation [');
    expect(message).toContain('also proposed: hyp-ai-1');
    expect(message).toContain('[HYPOTHESIS]\n{"hypotheses":[{"id":"hyp-ai-1"');
    expect(message).toContain('[BACKEND]\n{"findings"');
    expect(message).not.toContain('ignore me');
    expect(message.indexOf('Conclusions of the other agents')).toBeLessThan(
      message.indexOf('[requests all]'),
    );
    expect(message.endsWith('Return the JSON object required by the output schema, nothing else.')).toBe(
      true,
    );
    expect(previousConclusionsText({})).toBeUndefined();
    const long = previousConclusionsText({ SYNTHESIS: { summary: 'x'.repeat(10_000) } }, 200);
    expect(long).toContain('…[truncated by the harness]');
    expect((long ?? '').length).toBeLessThan(400);
  });

  it('checks the NPE hypothesis from every angle through the registry and returns validated contradictions', async () => {
    const incident = demoIncident();
    const registry = fakeRegistry(incident, SOURCES);
    const client = scriptedModelClient({
      turns: {
        CONTRADICTION_HUNTER: [
          toolCallsTurn([
            { name: 'get_request', input: { id: FAILING_REQUEST } },
            { name: 'get_request', input: { id: PASSING_REQUEST } },
            { name: 'read_source', input: { applicationId: 'bff', file: MAPPER_FILE } },
            { name: 'search_code', input: { query: 'getPublisher()' } },
          ]),
          toolCallsTurn([
            { name: 'read_source', input: { applicationId: 'catalog', file: SERVICE_FILE } },
            { name: 'find_references', input: { symbolId: GET_PUBLISHER_SYMBOL } },
            { name: 'get_investigation_memory', input: {} },
          ]),
          finalTurn(goodOutput()),
        ],
      },
      fallback: null,
    });
    const ctx = context(miniLoop(client, registry), registry, { incident });
    const outcome = await contradictionHunterAgent.run(ctx);

    expect(outcome.agent).toBe('CONTRADICTION_HUNTER');
    expect(outcome.result.status).toBe('DONE');
    expect(outcome.result.turns).toBe(3);
    expect(outcome.result.output?.contradictions).toHaveLength(4);
    expect(outcome.result.toolCalls.map((call) => `${call.name} ${call.target}`)).toEqual([
      `get_request ${FAILING_REQUEST}`,
      `get_request ${PASSING_REQUEST}`,
      `read_source bff:${MAPPER_FILE}`,
      'search_code getPublisher()',
      `read_source catalog:${SERVICE_FILE}`,
      'find_references find_references',
      'get_investigation_memory get_investigation_memory',
    ]);
    expect(outcome.result.toolCalls.every((call) => call.allowed)).toBe(true);
    expect(outcome.limitations).toEqual(['HTTP bodies not sent (data policy)']);

    // Ce que le modèle a reçu : le marqueur d'agent, les outils permis, les données délimitées.
    const first = at(client.callsFor('CONTRADICTION_HUNTER'), 0);
    expect(first.input.system.startsWith('Agent: CONTRADICTION_HUNTER')).toBe(true);
    expect(first.input.tools.map((tool) => tool.name)).toEqual([...CONTRADICTION_HUNTER_TOOLS]);
    expect(first.input.outputSchema).toBe(CONTRADICTION_FINDINGS_JSON_SCHEMA);
    const third = at(client.callsFor('CONTRADICTION_HUNTER'), 2);
    const toolMessages = third.input.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(7);
    expect(toolMessages.every((message) => message.content.startsWith(DATA_DELIMITER_START))).toBe(true);
    // Le corps de la requête en échec est bien là (chaîne JSON imbriquée), et le champ manquait vraiment.
    expect(at(toolMessages, 0).content).toContain('Les Marées du Nord');
    expect(at(toolMessages, 0).content).not.toContain('publisherId');
    expect(at(toolMessages, 1).content).toContain('publisherId');
    const open = at(outcome.result.output?.contradictions, 3);
    expect(open.openQuestion).toBe(true);
    expect(open.refs).toEqual([]);
  });

  it('rejects an invented request once (with the reason), then accepts the corrected answer', async () => {
    const incident = demoIncident();
    const registry = fakeRegistry(incident, SOURCES);
    const invented = goodOutput();
    invented.contradictions[0] = {
      ...at(invented.contradictions, 0),
      refs: [{ kind: 'request', id: 'rep_9:req-1-1' }],
    };
    const client = scriptedModelClient({
      turns: { CONTRADICTION_HUNTER: [finalTurn(invented), finalTurn(goodOutput())] },
      fallback: null,
    });
    const outcome = await contradictionHunterAgent.run(
      context(miniLoop(client, registry), registry, { incident }),
    );
    expect(outcome.result.status).toBe('DONE');
    expect(outcome.result.turns).toBe(2);
    const retry = at(client.callsFor('CONTRADICTION_HUNTER'), 1).input.messages.at(-1);
    expect(retry?.role).toBe('user');
    expect(retry?.content).toContain('unknown request reference "rep_9:req-1-1"');
  });

  it('fails after a second invented reference, an unknown hypothesis or a finding without refs', async () => {
    const incident = demoIncident();
    const registry = fakeRegistry(incident, SOURCES);
    const inventedSymbol = goodOutput();
    inventedSymbol.contradictions[1] = {
      ...at(inventedSymbol.contradictions, 1),
      refs: [{ kind: 'symbol', id: 'bff:src/main/java/org/example/bff/books/Nowhere.java#Nowhere.drop' }],
    };
    const unknownHypothesis = goodOutput();
    unknownHypothesis.contradictions[0] = {
      ...at(unknownHypothesis.contradictions, 0),
      hypothesisId: 'hyp-made-up',
    };
    const client = scriptedModelClient({
      turns: { CONTRADICTION_HUNTER: [finalTurn(inventedSymbol), finalTurn(unknownHypothesis)] },
      fallback: null,
    });
    const outcome = await contradictionHunterAgent.run(
      context(miniLoop(client, registry), registry, { incident }),
    );
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.output).toBeUndefined();
    expect(outcome.result.reasons).toEqual([
      'contradictions[0].hypothesisId: unknown hypothesis "hyp-made-up": contest only hypotheses that exist',
    ]);

    const notOpen = goodOutput();
    notOpen.contradictions[3] = { ...at(notOpen.contradictions, 3), openQuestion: false };
    const strict = scriptedModelClient({
      turns: { CONTRADICTION_HUNTER: [finalTurn(notOpen), finalTurn(notOpen)] },
    });
    const again = await contradictionHunterAgent.run(
      context(miniLoop(strict, registry), registry, { incident }),
    );
    expect(again.result.status).toBe('FAILED');
    expect(at(again.result.reasons, 0)).toContain('either cite existing ids or set openQuestion to true');
  });

  it('keeps an open question as such and lets the hunter cite a file it read during the run, or a run hypothesis', async () => {
    const incident = demoIncident();
    const registry = fakeRegistry(incident, SOURCES);
    const output: ContradictionFindings = {
      contradictions: [
        {
          hypothesisId: 'hyp-ai-1',
          kind: 'ENVIRONMENT_DIFFERENCE',
          summary:
            'La configuration du BFF lue pointe un backend local : l’environnement de la reproduction diffère peut-être de celui du rapport.',
          refs: [{ kind: 'file', id: `bff:${CONFIG_FILE}` }],
          openQuestion: false,
        },
        {
          hypothesisId: 'hyp-missing-validation',
          kind: 'MISSING_EVIDENCE',
          summary: 'Aucune preuve ne montre une validation frontend tentée : question ouverte.',
          refs: [],
          openQuestion: true,
        },
      ],
    };
    const client = scriptedModelClient({
      turns: {
        CONTRADICTION_HUNTER: [
          toolCallsTurn([{ name: 'read_source', input: { applicationId: 'bff', file: CONFIG_FILE } }]),
          finalTurn(output),
        ],
      },
      fallback: null,
    });
    const previous = { HYPOTHESIS: { hypotheses: [{ id: 'hyp-ai-1' }], existing: [], gaps: [] } };
    const outcome = await contradictionHunterAgent.run(
      context(miniLoop(client, registry), registry, { incident, previous }),
    );
    expect(outcome.result.status).toBe('DONE');
    expect(outcome.result.output?.contradictions.map((item) => item.openQuestion)).toEqual([false, true]);

    // Sans lecture pendant le run, le même fichier (absent de l'index de code) est inconnu.
    const cold = fakeRegistry(incident, SOURCES);
    const lookup = contradictionRefLookup({ incident, previous, tools: cold });
    expect(lookup.has({ kind: 'file', id: `bff:${CONFIG_FILE}` })).toBe(false);
    expect(lookup.has({ kind: 'hypothesis', id: 'hyp-ai-1' })).toBe(true);
    expect(lookup.has({ kind: 'hypothesis', id: 'hyp-null-relation' })).toBe(true);
    expect(lookup.has({ kind: 'symbol', id: MAPPER_SYMBOL })).toBe(true);
    expect(lookup.has({ kind: 'file', id: `bff:${MAPPER_FILE}` })).toBe(true);
    expect(lookup.has({ kind: 'request', id: 'rep_9:req-1-1' })).toBe(false);
    // Un fichier refusé par la politique ne devient pas citable.
    await cold.call('read_source', {
      applicationId: 'bff',
      file: 'src/main/resources/application-local.yml',
    });
    expect(lookup.has({ kind: 'file', id: 'bff:src/main/resources/application-local.yml' })).toBe(false);
  });

  it('bounds turns and tool calls by mode and by the run budget, and honours injected options', async () => {
    const incident = demoIncident();
    const registry = fakeRegistry(incident, SOURCES);
    const seen: { maxTurns: number; maxToolCalls: number; tools: readonly string[] }[] = [];
    const spyLoop: AgentLoop = <Output>(input: AgentLoopInput<Output>) => {
      seen.push({ maxTurns: input.maxTurns, maxToolCalls: input.maxToolCalls, tools: input.tools });
      return Promise.resolve({
        output: input.schema.parse({ contradictions: [] }),
        turns: 1,
        toolCalls: [],
        usage: ZERO_USAGE,
        reasons: [],
        status: 'DONE' as const,
        messages: [],
      });
    };
    await contradictionHunterAgent.run(context(spyLoop, registry, { incident }));
    await contradictionHunterAgent.run(context(spyLoop, registry, { incident, mode: 'AI_ASSISTED' }));
    await contradictionHunterAgent.run(
      context(spyLoop, registry, { incident, budget: { ...BUDGET, maxModelCalls: 3, maxToolCalls: 2 } }),
    );
    const custom = createContradictionHunterAgent({
      maxTurns: { AI_AGENTIC: 5 },
      maxToolCalls: { AI_AGENTIC: 9 },
      refs: { has: () => false },
    });
    await custom.run(context(spyLoop, registry, { incident }));
    expect(seen).toEqual([
      {
        maxTurns: CONTRADICTION_HUNTER_DEFAULTS.maxTurns.AI_AGENTIC,
        maxToolCalls: CONTRADICTION_HUNTER_DEFAULTS.maxToolCalls.AI_AGENTIC,
        tools: CONTRADICTION_HUNTER_TOOLS,
      },
      { maxTurns: 2, maxToolCalls: 6, tools: CONTRADICTION_HUNTER_TOOLS },
      { maxTurns: 3, maxToolCalls: 2, tools: CONTRADICTION_HUNTER_TOOLS },
      { maxTurns: 5, maxToolCalls: 9, tools: CONTRADICTION_HUNTER_TOOLS },
    ]);
    // L'index injecté s'impose : tout est inconnu, la sortie citée est rejetée deux fois.
    const client = scriptedModelClient({
      turns: { CONTRADICTION_HUNTER: [finalTurn(goodOutput()), finalTurn(goodOutput())] },
    });
    const strict = await custom.run(context(miniLoop(client, registry), registry, { incident }));
    expect(strict.result.status).toBe('FAILED');
  });
});
