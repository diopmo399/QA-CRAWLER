import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopResult,
  AgentRunContext,
  EvidencePack,
  InvestigationToolName,
  ToolRegistry,
  ToolResult,
} from '../../src/incident/ai/agent.js';
import {
  DATA_DELIMITER_END,
  DATA_DELIMITER_START,
  INVESTIGATION_TOOL_NAMES,
} from '../../src/incident/ai/agent.js';
import type {
  InvestigationModelClient,
  ModelMessage,
  ModelTurn,
  ToolSpec,
} from '../../src/incident/ai/model-client.js';
import type { AiToolCall, AiUsage } from '../../src/sdk/core/incident-ai-contracts.js';
import type { AiBudget, AiRef, CodeLayer, Incident } from '../../src/sdk/core/incident-contracts.js';

/**
 * LE BANC D'ESSAI DES AGENTS DE COUCHE JAVA : un registre d'outils factice qui lit les VRAIES sources Java de
 * `tests/fixtures/incident-app` (avec une garde de chemin qui refuse la traversée, l'absolu et les fichiers
 * sensibles), une boucle minimale fidèle au contrat (tours, dispatch des outils, délimiteurs, parse du schéma,
 * validation des références, une relance), et un contexte de run avec des paquets de preuves simples. Aucun
 * réseau, aucun SDK : le client de modèle est le client scripté de `scripted-model-client.ts`.
 */

export const FIXTURE_APP_ROOT = path.join(import.meta.dirname, 'incident-app');

/** Les applications de l'incident de démonstration et leur dossier dans la fixture. */
export const FIXTURE_DIRS: Record<string, string> = {
  front: 'frontend',
  bff: 'bff',
  catalog: 'backend',
};

export const NO_USAGE: AiUsage = {
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

export const TEST_BUDGET: AiBudget = {
  maxIterations: 4,
  maxModelCalls: 24,
  maxToolCalls: 60,
  maxInputTokens: 400_000,
  maxOutputTokens: 40_000,
  maxCost: 0,
  maxDurationMs: 300_000,
  maxFiles: 40,
  maxCommands: 0,
  maxExperiments: 2,
};

// ── Registre d'outils factice ────────────────────────────────────────────────────────────────

const SENSITIVE = /(^|\/)(application-local\.ya?ml|\.env|.*\.(pem|key|p12))$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** La garde de chemin : relatif, sans « .. », sous la racine du dépôt de l'application, jamais un fichier sensible. */
export function guardedPath(
  applicationId: string,
  file: string,
): { ok: true; absolute: string } | { ok: false; error: string; rule: string } {
  const dir = FIXTURE_DIRS[applicationId];
  if (dir === undefined)
    return { ok: false, error: `unknown application ${applicationId}`, rule: 'scope.application' };
  if (path.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file)) {
    return { ok: false, error: 'absolute paths are refused', rule: 'path.absolute' };
  }
  if (file.split(/[\\/]/).includes('..'))
    return { ok: false, error: 'path traversal is refused', rule: 'path.traversal' };
  const root = path.join(FIXTURE_APP_ROOT, dir);
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(root + path.sep))
    return { ok: false, error: 'outside the repository', rule: 'path.outside' };
  if (SENSITIVE.test(file)) return { ok: false, error: 'sensitive file', rule: 'file.sensitive' };
  return { ok: true, absolute };
}

function listFiles(root: string, relative = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, relative)).sort()) {
    const rel = relative === '' ? entry : `${relative}/${entry}`;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

export interface FixtureRegistryOptions {
  maxResultChars?: number;
  /** Les outils servis (les autres rendent un refus « not available »). */
  allow?: readonly InvestigationToolName[];
}

/** Un registre fidèle au contrat : `specs`, `call` (ne lève jamais), `calls` tracés avec la décision. */
export function fixtureRegistry(incident: Incident, options: FixtureRegistryOptions = {}): ToolRegistry {
  const maxChars = options.maxResultChars ?? 12_000;
  const allow = new Set<string>(options.allow ?? INVESTIGATION_TOOL_NAMES);
  const calls: AiToolCall[] = [];
  const code = incident.investigation.code;

  const read = (name: string, input: unknown): ToolResult => {
    const args = asRecord(input);
    switch (name) {
      case 'find_symbol': {
        const query = text(args.query) ?? text(args.name) ?? text(args.id) ?? '';
        if (query === '') return { ok: false, error: 'query is required' };
        const found = (code?.symbols ?? [])
          .filter((symbol) => symbol.id === query || symbol.name === query || symbol.id.includes(query))
          .slice(0, 20)
          .map((symbol) => ({
            id: symbol.id,
            kind: symbol.kind,
            name: symbol.name,
            file: symbol.file,
            line: symbol.line,
            parent: symbol.parent,
            detail: symbol.detail,
          }));
        return { ok: true, data: { symbols: found } };
      }
      case 'find_references': {
        const symbolId = text(args.symbolId) ?? text(args.id) ?? '';
        if (!(code?.symbols ?? []).some((symbol) => symbol.id === symbolId))
          return { ok: false, error: `unknown symbol ${symbolId}` };
        const callers = (code?.calls ?? [])
          .filter((call) => call.to === symbolId)
          .map((call) => ({
            from: call.from,
            text: call.text,
            file: call.file,
            line: call.line,
            status: call.status,
          }));
        const callees = (code?.calls ?? [])
          .filter((call) => call.from === symbolId)
          .map((call) => ({
            to: call.to,
            text: call.text,
            file: call.file,
            line: call.line,
            status: call.status,
          }));
        return { ok: true, data: { symbolId, callers, callees } };
      }
      case 'read_source': {
        const applicationId = text(args.applicationId) ?? '';
        const file = text(args.file) ?? '';
        const guard = guardedPath(applicationId, file);
        if (!guard.ok) return { ok: false, error: guard.error, rule: guard.rule };
        let content: string;
        try {
          content = readFileSync(guard.absolute, 'utf8');
        } catch {
          return { ok: false, error: `no such file ${file}` };
        }
        const lines = content.split('\n').map((line, index) => `${index + 1}: ${line}`);
        return { ok: true, data: { applicationId, file, lines } };
      }
      case 'list_files': {
        const applicationId = text(args.applicationId) ?? '';
        const dir = FIXTURE_DIRS[applicationId];
        if (dir === undefined)
          return { ok: false, error: `unknown application ${applicationId}`, rule: 'scope.application' };
        return { ok: true, data: { applicationId, files: listFiles(path.join(FIXTURE_APP_ROOT, dir)) } };
      }
      case 'get_request': {
        const id = text(args.id) ?? '';
        const request = incident.investigation.reproductions
          .flatMap((rep) => rep.requests)
          .find((req) => req.id === id);
        return request ? { ok: true, data: request } : { ok: false, error: `unknown request ${id}` };
      }
      case 'get_evidence': {
        const id = text(args.id) ?? '';
        const evidence = incident.investigation.reproductions
          .flatMap((rep) => rep.evidence)
          .find((ev) => ev.id === id);
        return evidence ? { ok: true, data: evidence } : { ok: false, error: `unknown evidence ${id}` };
      }
      default:
        return { ok: false, error: `${name} is not available in this harness` };
    }
  };

  const targetOf = (name: string, input: unknown): string => {
    const args = asRecord(input);
    if (name === 'read_source') return `${text(args.applicationId) ?? '?'}:${text(args.file) ?? '?'}`;
    return (
      text(args.symbolId) ??
      text(args.query) ??
      text(args.name) ??
      text(args.id) ??
      text(args.applicationId) ??
      JSON.stringify(input).slice(0, 80)
    );
  };

  return {
    specs(names) {
      return names
        .filter((name) => allow.has(name))
        .map<ToolSpec>((name) => ({
          name,
          description: `${name} (harness)`,
          inputSchema: { type: 'object' },
        }));
    },
    call(name, input) {
      const at = new Date().toISOString();
      const target = targetOf(name, input);
      let result: ToolResult;
      if (!allow.has(name) || !(INVESTIGATION_TOOL_NAMES as readonly string[]).includes(name)) {
        result = { ok: false, error: `unknown or forbidden tool ${name}`, rule: 'tool.closed-list' };
      } else {
        result = read(name, input);
      }
      if (result.ok) {
        const json = JSON.stringify(result.data);
        if (json.length > maxChars)
          result = { ok: true, data: { truncated: json.slice(0, maxChars) }, truncated: true };
      }
      const trace: AiToolCall = {
        at,
        name,
        target,
        allowed: result.ok || result.rule === undefined,
        ...(result.rule ? { rule: result.rule } : {}),
      };
      calls.push(trace);
      return Promise.resolve({ result, trace });
    },
    calls,
  };
}

// ── Boucle minimale ──────────────────────────────────────────────────────────────────────────

export interface TestLoopOptions {
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface TestLoop {
  loop: AgentLoop;
  /** Les entrées reçues (une par agent lancé). */
  inputs: AgentLoopInput<unknown>[];
}

/** Lu via une fonction : le contrôle de flux ne doit pas « prouver » que le signal reste inactif après un await. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function extractJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Une boucle fidèle au contrat : tours bornés, dispatch via le registre, délimiteurs, parse + validate, UNE relance. */
export function testLoop(
  client: InvestigationModelClient,
  tools: ToolRegistry,
  signal: AbortSignal,
  options: TestLoopOptions = {},
): TestLoop {
  const inputs: AgentLoopInput<unknown>[] = [];
  const loop: AgentLoop = async <Output>(input: AgentLoopInput<Output>): Promise<AgentLoopResult<Output>> => {
    inputs.push(input);
    const messages: ModelMessage[] = [{ role: 'user', content: input.user }];
    const toolCalls: AiToolCall[] = [];
    const usage: AiUsage = { ...NO_USAGE };
    const reasons: string[] = [];
    const allowed = new Set<string>(input.tools);
    const refusedTargets = new Set<string>();
    let retried = false;
    let turns = 0;
    const done = (status: AgentLoopResult<Output>['status'], output?: Output): AgentLoopResult<Output> => ({
      output,
      turns,
      toolCalls,
      usage,
      reasons,
      status,
      messages,
    });
    while (turns < input.maxTurns) {
      if (signal.aborted) return done('CANCELLED');
      turns += 1;
      usage.modelCalls += 1;
      let turn: ModelTurn;
      try {
        turn = await client.complete(
          {
            system: input.system,
            // Une copie : ce que le client a reçu à ce tour, pas l'historique mutable de la boucle.
            messages: [...messages],
            tools: tools.specs(input.tools),
            outputSchema: input.outputSchema,
            maxOutputTokens: options.maxOutputTokens ?? 4000,
          },
          { signal, timeoutMs: options.timeoutMs ?? 1000 },
        );
      } catch (error) {
        const cancelled = isAborted(signal);
        reasons.push(cancelled ? 'cancelled' : `provider error: ${(error as Error).message}`);
        return done(cancelled ? 'CANCELLED' : 'FAILED');
      }
      usage.inputTokens += turn.usage.inputTokens;
      usage.outputTokens += turn.usage.outputTokens;
      if (turn.kind === 'tool_calls') {
        messages.push({ role: 'assistant', content: JSON.stringify(turn.calls) });
        for (const call of turn.calls) {
          if (toolCalls.length >= input.maxToolCalls) {
            reasons.push('maxToolCalls reached');
            return done('BUDGET');
          }
          const key = `${call.name}:${JSON.stringify(call.input)}`;
          let payload: ToolResult;
          if (!allowed.has(call.name)) {
            payload = {
              ok: false,
              error: `tool ${call.name} is not allowed for this agent`,
              rule: 'agent.tools',
            };
          } else if (refusedTargets.has(key)) {
            payload = {
              ok: false,
              error: 'this call was already refused; do not repeat it',
              rule: 'loop.no-retry',
            };
          } else {
            const { result: toolResult, trace } = await tools.call(call.name, call.input);
            payload = toolResult;
            toolCalls.push(trace);
            usage.toolCalls += 1;
            if (!toolResult.ok && toolResult.rule) refusedTargets.add(key);
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: `${DATA_DELIMITER_START}\n${JSON.stringify(payload)}\n${DATA_DELIMITER_END}`,
          });
        }
        continue;
      }
      const parsed = input.schema.safeParse(extractJson(turn.raw));
      let problems: string[];
      if (parsed.success) {
        problems = input.validate(parsed.data);
        if (problems.length === 0) return done('DONE', parsed.data);
      } else {
        problems = [
          `output does not match the schema: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
        ];
      }
      reasons.push(...problems);
      if (retried) return done('FAILED');
      retried = true;
      messages.push({
        role: 'assistant',
        content: typeof turn.raw === 'string' ? turn.raw : JSON.stringify(turn.raw),
      });
      messages.push({
        role: 'user',
        content: `Your output was rejected for these reasons; answer again with a corrected JSON object:\n- ${problems.join('\n- ')}`,
      });
    }
    reasons.push('maxTurns reached');
    return done('BUDGET');
  };
  return { loop, inputs };
}

// ── Contexte de run ──────────────────────────────────────────────────────────────────────────

function pack(title: string, lines: string[], refs: AiRef[], omitted: string[] = []): EvidencePack {
  return {
    text: `${title}\n${DATA_DELIMITER_START}\n${lines.join('\n')}\n${DATA_DELIMITER_END}`,
    refs,
    omitted,
  };
}

/** Des paquets simples mais fidèles : délimités, avec les identifiants qu'ils citent. */
export function simplePacks(incident: Incident, omitted: string[] = []): AgentRunContext['packs'] {
  const inv = incident.investigation;
  const requests = inv.reproductions.flatMap((rep) => rep.requests);
  return {
    incident: () =>
      pack(
        'Incident',
        [
          `${incident.id} ${incident.title}`,
          `observed: ${incident.observed}`,
          `expected: ${incident.expected}`,
        ],
        [],
        omitted,
      ),
    reproduction: () =>
      pack(
        'Reproductions',
        inv.reproductions.map((rep) => `${rep.id} ${rep.scenario} reproduced=${String(rep.reproduced)}`),
        inv.reproductions.flatMap((rep) =>
          rep.evidence.map((ev) => ({ kind: 'evidence' as const, id: ev.id })),
        ),
      ),
    requests: (options) => {
      const chosen = options?.errorsOnly ? requests.filter((req) => (req.status ?? 0) >= 400) : requests;
      return pack(
        'Requests',
        chosen.map((req) => `${req.id} ${req.method} ${req.path} -> ${req.status ?? '?'}`),
        chosen.map((req) => ({ kind: 'request' as const, id: req.id })),
      );
    },
    graph: (options) => {
      const nodes = (inv.graph?.nodes ?? []).filter(
        (node) => options?.layer === undefined || node.layer === options.layer,
      );
      return pack(
        'Graph',
        nodes.map((node) => `${node.id} [${node.kind}] ${node.label}`),
        nodes.map((node) => ({ kind: 'node' as const, id: node.id })),
      );
    },
    code: (layer: CodeLayer) => {
      const symbols = (inv.code?.symbols ?? []).filter((symbol) => symbol.layer === layer);
      return pack(
        `Code ${layer}`,
        symbols.map((symbol) => `${symbol.id} [${symbol.kind}] ${symbol.file}:${symbol.line}`),
        symbols.map((symbol) => ({ kind: 'symbol' as const, id: symbol.id })),
        omitted,
      );
    },
    hypotheses: () =>
      pack(
        'Hypotheses',
        inv.hypotheses.map((hyp) => `${hyp.id} ${hyp.title} (${hyp.status})`),
        inv.hypotheses.map((hyp) => ({ kind: 'hypothesis' as const, id: hyp.id })),
      ),
    experiments: () =>
      pack(
        'Experiments',
        inv.experiments.map((exp) => `${exp.id} ${exp.kind} ${exp.status}`),
        inv.experiments.map((exp) => ({ kind: 'experiment' as const, id: exp.id })),
      ),
  };
}

export interface RunContextOptions {
  incident: Incident;
  tools: ToolRegistry;
  loop: AgentLoop;
  mode?: AgentRunContext['mode'];
  signal?: AbortSignal;
  budget?: Partial<AiBudget>;
  previous?: AgentRunContext['previous'];
  omitted?: string[];
}

export function runContext(options: RunContextOptions): AgentRunContext {
  return {
    mode: options.mode ?? 'AI_ASSISTED',
    incident: options.incident,
    tools: options.tools,
    loop: options.loop,
    budget: { ...TEST_BUDGET, ...options.budget },
    packs: simplePacks(options.incident, options.omitted),
    previous: options.previous ?? {},
    signal: options.signal ?? new AbortController().signal,
    now: () => '2026-10-31T10:00:00.000Z',
  };
}
