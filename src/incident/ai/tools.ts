import path from 'node:path';
import { z } from 'zod';
import { IntelligenceContextSanitizer } from '../../ai/sanitizer.js';
import type { AiToolCall } from '../../sdk/core/incident-ai-contracts.js';
import { redactText } from '../../security/redactor.js';
import {
  EVIDENCE_KINDS,
  EXPERIMENT_KINDS,
  GRAPH_NODE_KINDS,
  LAYERS,
  type CodeLayer,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type HttpExchange,
  type PolicyOperation,
  type ScopeExtensionKind,
} from '../model.js';
import { ScopeDeniedError } from '../scope-policy.js';
import { maskSource } from '../service.js';
import {
  EXECUTION_VERB,
  INVESTIGATION_TOOL_NAMES,
  type InvestigationTool,
  type InvestigationToolName,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
} from './agent.js';
import type { ToolSpec } from './model-client.js';
import { RefIndex, type RefIndexFile } from './refs.js';
import {
  MAX_CONTEXT_LINES,
  MAX_QUERY_CHARS,
  MAX_SEARCH_HITS,
  searchCode,
  type SearchTarget,
} from './tools/search.js';

/**
 * LE REGISTRE DES OUTILS DE L'INVESTIGATION IA : la liste fermée (`INVESTIGATION_TOOL_NAMES`), chaque appel
 * du modèle passant par : validation zod → `tool.operations()` → `policy.check()` de CHAQUE opération →
 * `tool.read()` → masquage (`maskSource` pour le code, `redactText`, puis le sanitizer IA) → bornes
 * (caractères, éléments) → résultat typé, tracé (nom, cible, décision, durée : jamais la charge utile).
 *
 * Rien ne s'exécute : les deux seules écritures (`propose_experiment`, `request_scope_extension`) sont des
 * propositions déléguées à `ctx.proposals`, qui suivent le chemin d'une personne (PROPOSED /
 * APPROVAL_REQUIRED, PENDING). Un nom à verbe d'exécution est refusé à la création du registre. Un refus
 * est un `ToolResult { ok: false, error, rule }` : le registre ne lève jamais.
 */
export interface ToolRegistryOptions {
  /** Longueur maximale (caractères JSON) d'un résultat rendu au modèle. */
  maxResultChars: number;
  onCall?: (trace: AiToolCall, result: ToolResult) => void;
  /** Outils injectés (investigation approfondie) : même pipeline, même garde de nom ; le nom doit être de la liste fermée. */
  extra?: InvestigationTool[];
  /** Valeurs secrètes connues (`secretValuesOf(env)`) : retirées de tout résultat. */
  secretValues?: readonly string[];
  /** Libellés de champs sensibles : leur contenu est masqué. */
  sensitiveFields?: readonly string[];
  /** L'index des références du run : les fichiers lus par les outils y deviennent citables. */
  refs?: RefIndex;
  /** Éléments au plus dans une liste rendue (défaut 50). */
  maxItems?: number;
  /** Fichiers lus au plus par une recherche textuelle (défaut 40). */
  maxSearchFiles?: number;
  now?: () => string;
}

export interface InvestigationToolRegistry extends ToolRegistry {
  /** Les fichiers (relatifs) lus par les outils depuis la création du registre. */
  readonly filesRead: readonly RefIndexFile[];
  /** Les noms réellement disponibles pour cet agent. */
  readonly names: readonly InvestigationToolName[];
}

export const DEFAULT_MAX_ITEMS = 50;
export const DEFAULT_MAX_SEARCH_FILES = 40;
export const MAX_READ_LINES = 400;
const DEFAULT_READ_LINES = 200;
const MAX_TARGET_CHARS = 120;
const MAX_TEXT = 2_000;

/** Ce que l'explorateur lit par couche (mêmes extensions que l'analyse de code). */
export const SOURCE_EXTENSIONS: Readonly<Record<CodeLayer, readonly string[]>> = Object.freeze({
  FRONTEND: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json'],
  BFF: ['.java', '.yml', '.yaml', '.properties', '.xml'],
  BACKEND: ['.java', '.yml', '.yaml', '.properties', '.xml', '.sql'],
});

/** Les extensions demandables au modèle (jamais un fichier de clés ou d'environnement). */
export const EXTENSION_PATTERN = /^\.?[a-z0-9]{1,8}$/i;
/** Les extensions de périmètre qu'un agent peut demander : jamais les effets de bord ni les commandes. */
export const MODEL_SCOPE_EXTENSION_KINDS = [
  'ADD_APPLICATION',
  'ADD_PATH',
  'ADD_CLASS',
  'ADD_ENDPOINT',
  'ADD_HOST',
  'RAISE_DEPTH',
] as const satisfies readonly ScopeExtensionKind[];

const CODE_LAYERS = ['FRONTEND', 'BFF', 'BACKEND'] as const;

// ── Garde des noms ─────────────────────────────────────────────────────────────────────────────

/** Lève si le nom n'est pas de la liste fermée ou porte un verbe d'exécution. */
export function assertSafeToolName(name: string): InvestigationToolName {
  if (EXECUTION_VERB.test(name)) throw new Error(`Nom d'outil refusé (verbe d'exécution) : « ${name} ».`);
  if (!(INVESTIGATION_TOOL_NAMES as readonly string[]).includes(name))
    throw new Error(`Nom d'outil hors de la liste fermée : « ${name} ».`);
  return name as InvestigationToolName;
}

// ── Masquage et bornes ─────────────────────────────────────────────────────────────────────────

export interface Masker {
  text(value: string): string;
  value(value: unknown): unknown;
}

/** `redactText` sur chaque chaîne, puis le sanitizer IA (secrets connus, adresses, clés sensibles). */
export function createMasker(
  options: { secretValues?: readonly string[]; sensitiveFields?: readonly string[] } = {},
): Masker {
  const sanitizer = new IntelligenceContextSanitizer({
    secretValues: options.secretValues ?? [],
    sensitiveFields: options.sensitiveFields ?? [],
  });
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redact(entry)]),
      );
    return value;
  };
  return {
    text: (value) => {
      const masked = sanitizer.sanitizeValue(redactText(value));
      return typeof masked === 'string' ? masked : String(masked);
    },
    value: (value) => sanitizer.sanitizeValue(redact(value)),
  };
}

export const clipText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Borne un résultat : listes réduites de moitié tour après tour, puis texte coupé en dernier recours. */
export function boundData(data: unknown, maxChars: number): { data: unknown; truncated: boolean } {
  let json = JSON.stringify(data ?? null);
  if (json.length <= maxChars) return { data, truncated: false };
  let current = data;
  for (let round = 0; round < 16; round += 1) {
    current = shrink(current, Math.max(200, Math.floor(maxChars / 4)));
    json = JSON.stringify(current ?? null);
    if (json.length <= maxChars) return { data: current, truncated: true };
  }
  return { data: { partial: `${json.slice(0, Math.max(0, maxChars - 40))}…` }, truncated: true };
}

function shrink(value: unknown, maxString: number): unknown {
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (Array.isArray(value)) {
    const kept = value.length > 1 ? value.slice(0, Math.ceil(value.length / 2)) : value;
    return kept.map((entry) => shrink(entry, maxString));
  }
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, shrink(entry, maxString)]),
    );
  return value;
}

// ── Schémas d'entrée ───────────────────────────────────────────────────────────────────────────

const id = z.string().trim().min(1).max(300);
const text = z.string().trim().min(1).max(500);
const limit = (max: number, fallback: number): z.ZodDefault<z.ZodNumber> =>
  z.number().int().min(1).max(max).default(fallback);
const relativeFile = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine((value) => !value.includes('\0'), 'chemin invalide');
const extensions = z.array(z.string().regex(EXTENSION_PATTERN)).max(12).optional();
const paramValue = z.union([
  z.string().max(2_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(500)).max(50),
]);

const NoInput = z.object({}).strict();
const GetEvidenceInput = z
  .object({
    id: id.optional(),
    kind: z.enum(EVIDENCE_KINDS).optional(),
    reproductionId: id.optional(),
    limit: limit(100, 30),
  })
  .strict();
const GetRequestInput = z.object({ id, bodies: z.boolean().default(true) }).strict();
const GetTraceGraphInput = z
  .object({
    layer: z.enum(LAYERS).optional(),
    kind: z.enum(GRAPH_NODE_KINDS).optional(),
    limit: limit(300, 100),
  })
  .strict();
const GetGraphNeighboursInput = z
  .object({
    nodeId: id,
    direction: z.enum(['in', 'out', 'both']).default('both'),
    depth: z.number().int().min(1).max(3).default(1),
    limit: limit(100, 40),
  })
  .strict();
const FindSymbolInput = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
    applicationId: id.optional(),
    layer: z.enum(CODE_LAYERS).optional(),
    kind: z.string().trim().min(1).max(40).optional(),
    limit: limit(100, 25),
  })
  .strict();
const FindReferencesInput = z
  .object({ symbolId: id, textual: z.boolean().default(true), limit: limit(MAX_SEARCH_HITS, 20) })
  .strict();
const SearchCodeInput = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
    regex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    applicationId: id.optional(),
    layer: z.enum(CODE_LAYERS).optional(),
    maxHits: limit(MAX_SEARCH_HITS, 20),
    contextLines: z.number().int().min(0).max(MAX_CONTEXT_LINES).default(1),
    extensions,
  })
  .strict();
const ReadSourceInput = z
  .object({
    applicationId: id.optional(),
    file: relativeFile,
    startLine: z.number().int().min(1).default(1),
    endLine: z.number().int().min(1).optional(),
  })
  .strict();
const ListFilesInput = z
  .object({ applicationId: id, directory: relativeFile.optional(), extensions, limit: limit(500, 100) })
  .strict();
const ProposeExperimentInput = z
  .object({
    hypothesisId: id,
    kind: z.enum(EXPERIMENT_KINDS),
    objective: text,
    description: text.optional(),
    params: z.record(z.string().max(60), paramValue).default({}),
    resources: z.array(text).max(20).default([]),
    permissions: z.array(text).max(20).default([]),
    risks: z.array(text).max(20).default([]),
    sideEffects: z.boolean().default(false),
    expected: text,
    confirmIf: text,
    refuteIf: text,
  })
  .strict();
const RequestScopeExtensionInput = z
  .object({
    kind: z.enum(MODEL_SCOPE_EXTENSION_KINDS),
    target: id,
    applicationId: id.optional(),
    reason: text,
  })
  .strict();

export type ProposeExperimentArgs = z.output<typeof ProposeExperimentInput>;
export type RequestScopeExtensionArgs = z.output<typeof RequestScopeExtensionInput>;

// ── Aides ──────────────────────────────────────────────────────────────────────────────────────

const refused = (error: string, rule: string): ToolResult => ({ ok: false, error, rule });
const okResult = (data: unknown, truncated = false): ToolResult => ({
  ok: true,
  data,
  ...(truncated ? { truncated } : {}),
});

type Repository = ToolContext['repositories'][number];

const includeOf = (ctx: ToolContext, applicationId: string): string[] => {
  for (const application of ctx.incident.scope.applications)
    if (application.id === applicationId) return [...application.repository.include];
  return [];
};

const repositoryById = (ctx: ToolContext, applicationId: string): Repository | undefined => {
  for (const repository of ctx.repositories)
    if (repository.applicationId === applicationId) return repository;
  return undefined;
};

/** L'application visée par un outil de code : celle demandée, sinon la seule du périmètre. */
function resolveRepository(ctx: ToolContext, applicationId: string | undefined): Repository | ToolResult {
  if (applicationId !== undefined) {
    const found = repositoryById(ctx, applicationId);
    return found ?? refused(`Application inconnue « ${applicationId} ».`, 'application.unknown');
  }
  const [only, second] = ctx.repositories;
  if (only && !second) return only;
  const ids: string[] = [];
  for (const repository of ctx.repositories) ids.push(repository.applicationId);
  return refused(
    `Précisez applicationId (${ids.join(', ') || 'aucune application dans le périmètre'}).`,
    'application.required',
  );
}

const isResult = (value: Repository | ToolResult): value is ToolResult => 'ok' in value;

/** Le chemin demandé tel quel (jamais normalisé : « .. » doit arriver au Scope Policy Engine, qui le refuse). */
const requestedPath = (root: string, file: string): string =>
  path.isAbsolute(file)
    ? file
    : `${root}${root.endsWith(path.sep) ? '' : path.sep}${file.replace(/\//g, path.sep)}`;

const relativeTo = (root: string, file: string): string => {
  if (!path.isAbsolute(file)) return file.replace(/\\/g, '/').replace(/^\.\//, '');
  return path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join('/');
};

const targetsOf = (
  ctx: ToolContext,
  applicationId: string | undefined,
  layer: CodeLayer | undefined,
): SearchTarget[] => {
  const targets: SearchTarget[] = [];
  for (const repository of ctx.repositories) {
    if (applicationId !== undefined && repository.applicationId !== applicationId) continue;
    if (layer !== undefined && repository.layer !== layer) continue;
    targets.push({
      applicationId: repository.applicationId,
      root: repository.root,
      include: includeOf(ctx, repository.applicationId),
    });
  }
  return targets;
};

/** Les dossiers listés d'une cible : les dossiers inclus (chemin demandé tel quel), sinon la racine. */
const listedDirs = (target: SearchTarget): string[] => {
  const include = target.include ?? [];
  return include.length === 0 ? [target.root] : include.map((dir) => requestedPath(target.root, dir));
};

const listOperations = (targets: readonly SearchTarget[]): PolicyOperation[] => {
  const operations: PolicyOperation[] = [];
  for (const target of targets)
    for (const dir of listedDirs(target))
      operations.push({ kind: 'LIST_DIR', path: dir, applicationId: target.applicationId });
  return operations;
};

const extensionsFor = (layer: CodeLayer, requested: string[] | undefined): string[] =>
  (requested ?? [...SOURCE_EXTENSIONS[layer]]).map((extension) =>
    (extension.startsWith('.') ? extension : `.${extension}`).toLowerCase(),
  );

const allEvidence = (ctx: ToolContext): (Evidence & { origin: string })[] => {
  const found: (Evidence & { origin: string })[] = [];
  for (const reproduction of ctx.incident.investigation.reproductions)
    for (const evidence of reproduction.evidence) found.push({ ...evidence, origin: reproduction.id });
  for (const experiment of ctx.incident.investigation.experiments)
    for (const evidence of experiment.evidence) found.push({ ...evidence, origin: experiment.id });
  return found;
};

const allRequests = (ctx: ToolContext): HttpExchange[] => {
  const found: HttpExchange[] = [];
  for (const reproduction of ctx.incident.investigation.reproductions) found.push(...reproduction.requests);
  if (
    ctx.reproduction &&
    !ctx.incident.investigation.reproductions.some((run) => run.id === ctx.reproduction?.id)
  )
    found.push(...ctx.reproduction.requests);
  return found;
};

const graphOf = (ctx: ToolContext) => ctx.graph ?? ctx.incident.investigation.graph;
const codeOf = (ctx: ToolContext) => ctx.code ?? ctx.incident.investigation.code;

/** Une preuve telle que transmise : journaux et captures selon la politique, corps HTTP selon la politique. */
function evidenceView(
  evidence: Evidence & { origin: string },
  ctx: ToolContext,
): Record<string, unknown> | undefined {
  const policy = ctx.dataPolicy;
  if (evidence.kind === 'LOG_LINE' && !policy.sendLogs) return undefined;
  const view: Record<string, unknown> = {
    id: evidence.id,
    kind: evidence.kind,
    ...(evidence.at !== undefined ? { at: evidence.at } : {}),
    summary: clipText(evidence.summary, policy.maxSnippetChars),
    source: evidence.source,
    origin: evidence.origin,
  };
  if (evidence.kind === 'SCREENSHOT') return view;
  if (evidence.data) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(evidence.data)) {
      if (!policy.sendHttpBodies && /body/i.test(key)) continue;
      if (!policy.sendSourceCode && /^(text|source|snippet|code)$/i.test(key)) continue;
      data[key] = typeof value === 'string' ? clipText(value, policy.maxSnippetChars) : value;
    }
    view.data = data;
  }
  return view;
}

function requestView(request: HttpExchange, ctx: ToolContext, bodies: boolean): Record<string, unknown> {
  const policy = ctx.dataPolicy;
  const view: Record<string, unknown> = { ...request };
  const withBodies = bodies && policy.sendHttpBodies;
  if (!withBodies) {
    delete view.requestBody;
    delete view.responseBody;
    view.bodiesOmitted = policy.sendHttpBodies ? 'not requested' : 'data policy (sendHttpBodies=false)';
  } else {
    if (request.requestBody !== undefined)
      view.requestBody = clipText(request.requestBody, policy.maxSnippetChars);
    if (request.responseBody !== undefined)
      view.responseBody = clipText(request.responseBody, policy.maxSnippetChars);
  }
  return view;
}

const nodeView = (node: GraphNode): Record<string, unknown> => ({
  id: node.id,
  kind: node.kind,
  label: node.label,
  layer: node.layer,
  evidence: node.evidence,
  ...(node.symbolId !== undefined ? { symbolId: node.symbolId } : {}),
  ...(node.file !== undefined ? { file: node.file } : {}),
  ...(node.line !== undefined ? { line: node.line } : {}),
  ...(node.source ? { source: node.source } : {}),
});

const edgeView = (edge: GraphEdge): Record<string, unknown> => ({
  id: `${edge.from}->${edge.to}`,
  from: edge.from,
  to: edge.to,
  status: edge.status,
  reason: edge.reason,
  evidence: edge.evidence,
});

// ── Les douze outils ───────────────────────────────────────────────────────────────────────────

const define = <Input>(tool: InvestigationTool<Input>): InvestigationTool => tool;

const getIncidentSummary = define<z.output<typeof NoInput>>({
  name: 'get_incident_summary',
  description:
    'The incident as declared (title, description, observed vs expected, severity, scenario), its scope (applications, permissions, limits) and the ids of its reproductions, hypotheses and experiments.',
  input: NoInput,
  operations: () => [],
  read: (_args, ctx) => {
    const { incident } = ctx;
    const applications = incident.scope.applications.map((application) => ({
      id: application.id,
      name: application.name,
      layer: application.layer,
      include: application.repository.include,
      ...(application.baseUrl !== undefined ? { baseUrl: application.baseUrl } : {}),
    }));
    return Promise.resolve(
      okResult({
        id: incident.id,
        title: incident.title,
        description: clipText(incident.description, MAX_TEXT),
        observed: clipText(incident.observed, MAX_TEXT),
        expected: clipText(incident.expected, MAX_TEXT),
        severity: incident.severity,
        ...(incident.kind !== undefined ? { kind: incident.kind } : {}),
        ...(incident.scenario !== undefined ? { scenario: incident.scenario } : {}),
        state: incident.state,
        scope: {
          mode: incident.scope.mode,
          applications,
          endpoints: incident.scope.endpoints,
          depth: incident.scope.depth,
          permissions: incident.scope.permissions,
          limits: incident.scope.limits,
          extensions: incident.scope.extensions.map((extension) => ({
            id: extension.id,
            kind: extension.kind,
            target: extension.target,
            status: extension.status,
          })),
        },
        reproductions: incident.investigation.reproductions.map((run) => ({
          id: run.id,
          status: run.status,
          reproduced: run.reproduced,
          requests: run.requests.length,
          evidence: run.evidence.length,
          actions: run.actions.length,
        })),
        hypotheses: incident.investigation.hypotheses.map((hypothesis) => ({
          id: hypothesis.id,
          title: hypothesis.title,
          status: hypothesis.status,
          confidence: hypothesis.confidence,
          ...(hypothesis.origin !== undefined ? { origin: hypothesis.origin } : {}),
        })),
        experiments: incident.investigation.experiments.map((experiment) => ({
          id: experiment.id,
          kind: experiment.kind,
          status: experiment.status,
          ...(experiment.hypothesisId !== undefined ? { hypothesisId: experiment.hypothesisId } : {}),
          ...(experiment.outcome !== undefined ? { outcome: experiment.outcome } : {}),
        })),
        attachments: (incident.attachments ?? []).map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          type: attachment.type,
        })),
      }),
    );
  },
});

const getEvidence = define<z.output<typeof GetEvidenceInput>>({
  name: 'get_evidence',
  description:
    'Evidence collected by reproductions and experiments (actions, pages, console, JS errors, assertions, requests, code, logs when permitted). Narrow by id, kind or reproduction.',
  input: GetEvidenceInput,
  operations: () => [],
  read: (args, ctx) => {
    const items: Record<string, unknown>[] = [];
    let total = 0;
    let omitted = 0;
    for (const evidence of allEvidence(ctx)) {
      if (args.id !== undefined && evidence.id !== args.id) continue;
      if (args.kind !== undefined && evidence.kind !== args.kind) continue;
      if (args.reproductionId !== undefined && evidence.origin !== args.reproductionId) continue;
      total += 1;
      const view = evidenceView(evidence, ctx);
      if (!view) {
        omitted += 1;
        continue;
      }
      if (items.length < args.limit) items.push(view);
    }
    if (args.id !== undefined && total === 0)
      return Promise.resolve(refused(`Preuve inconnue « ${args.id} ».`, 'evidence.unknown'));
    return Promise.resolve(
      okResult(
        {
          evidence: items,
          total,
          ...(omitted > 0
            ? { omitted: `${omitted} log line(s) withheld by the data policy (sendLogs=false)` }
            : {}),
        },
        total - omitted > items.length,
      ),
    );
  },
});

const getRequest = define<z.output<typeof GetRequestInput>>({
  name: 'get_request',
  description:
    'One HTTP exchange observed during a reproduction (method, path, status, timing, step, headers already allow-listed; bodies when the data policy permits).',
  input: GetRequestInput,
  operations: () => [],
  read: (args, ctx) => {
    for (const request of allRequests(ctx))
      if (request.id === args.id) return Promise.resolve(okResult(requestView(request, ctx, args.bodies)));
    return Promise.resolve(refused(`Requête inconnue « ${args.id} ».`, 'request.unknown'));
  },
});

const getTraceGraph = define<z.output<typeof GetTraceGraphInput>>({
  name: 'get_trace_graph',
  description:
    'The investigation graph (incident → scenario → actions → requests → frontend code → BFF → backend → repository) with the status of each relation (OBSERVED, STATICALLY_RESOLVED, INFERRED, UNKNOWN). Narrow by layer or node kind.',
  input: GetTraceGraphInput,
  operations: () => [],
  read: (args, ctx) => {
    const graph = graphOf(ctx);
    if (!graph)
      return Promise.resolve(
        refused('Aucun graphe : la corrélation n’a pas encore été calculée.', 'graph.missing'),
      );
    const nodes: GraphNode[] = [];
    for (const node of graph.nodes) {
      if (args.layer !== undefined && node.layer !== args.layer) continue;
      if (args.kind !== undefined && node.kind !== args.kind) continue;
      nodes.push(node);
    }
    const kept = nodes.slice(0, args.limit);
    const ids = new Set(kept.map((node) => node.id));
    const edges: Record<string, unknown>[] = [];
    for (const edge of graph.edges) if (ids.has(edge.from) || ids.has(edge.to)) edges.push(edgeView(edge));
    return Promise.resolve(
      okResult(
        {
          nodes: kept.map(nodeView),
          edges: edges.slice(0, args.limit * 2),
          totalNodes: graph.nodes.length,
          totalEdges: graph.edges.length,
        },
        kept.length < nodes.length,
      ),
    );
  },
});

const getGraphNeighbours = define<z.output<typeof GetGraphNeighboursInput>>({
  name: 'get_graph_neighbours',
  description:
    'A graph node with its neighbours (incoming, outgoing or both) up to a small depth, and the edges between them.',
  input: GetGraphNeighboursInput,
  operations: () => [],
  read: (args, ctx) => {
    const graph = graphOf(ctx);
    if (!graph)
      return Promise.resolve(
        refused('Aucun graphe : la corrélation n’a pas encore été calculée.', 'graph.missing'),
      );
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const start = byId.get(args.nodeId);
    if (!start) return Promise.resolve(refused(`Nœud inconnu « ${args.nodeId} ».`, 'node.unknown'));
    const visited = new Set<string>([start.id]);
    const edges = new Map<string, GraphEdge>();
    let frontier = [start.id];
    for (let depth = 0; depth < args.depth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const edge of graph.edges) {
        const outgoing = args.direction !== 'in' && frontier.includes(edge.from);
        const incoming = args.direction !== 'out' && frontier.includes(edge.to);
        if (!outgoing && !incoming) continue;
        edges.set(`${edge.from}->${edge.to}`, edge);
        const other = outgoing ? edge.to : edge.from;
        if (!visited.has(other) && visited.size < args.limit) {
          visited.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }
    const nodes: Record<string, unknown>[] = [];
    for (const nodeId of visited) {
      const node = byId.get(nodeId);
      if (node) nodes.push(nodeView(node));
    }
    return Promise.resolve(
      okResult(
        { node: nodeView(start), nodes, edges: [...edges.values()].map(edgeView) },
        visited.size >= args.limit,
      ),
    );
  },
});

const findSymbol = define<z.output<typeof FindSymbolInput>>({
  name: 'find_symbol',
  description:
    'Symbols of the code index (components, handlers, controllers, services, DTOs, repositories, validations…) whose id, name or file contains the query; also matching endpoints. Returns ids usable with find_references and read_source.',
  input: FindSymbolInput,
  operations: () => [],
  read: (args, ctx) => {
    const code = codeOf(ctx);
    if (!code)
      return Promise.resolve(
        refused('Aucun index de code : l’analyse du code n’a pas encore été faite.', 'code.missing'),
      );
    const needle = args.query.toLowerCase();
    const symbols: Record<string, unknown>[] = [];
    let total = 0;
    for (const symbol of code.symbols) {
      if (args.applicationId !== undefined && symbol.applicationId !== args.applicationId) continue;
      if (args.layer !== undefined && symbol.layer !== args.layer) continue;
      if (args.kind !== undefined && symbol.kind !== args.kind.toUpperCase()) continue;
      const haystack = `${symbol.id} ${symbol.name} ${symbol.file}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      total += 1;
      if (symbols.length < args.limit)
        symbols.push({
          id: symbol.id,
          applicationId: symbol.applicationId,
          layer: symbol.layer,
          kind: symbol.kind,
          name: symbol.name,
          file: symbol.file,
          line: symbol.line,
          ...(symbol.parent !== undefined ? { parent: symbol.parent } : {}),
          ...(symbol.detail && ctx.dataPolicy.sendSourceCode ? { detail: symbol.detail } : {}),
        });
    }
    const endpoints: Record<string, unknown>[] = [];
    for (const endpoint of code.endpoints) {
      if (args.applicationId !== undefined && endpoint.applicationId !== args.applicationId) continue;
      if (args.layer !== undefined && endpoint.layer !== args.layer) continue;
      if (
        `${endpoint.method} ${endpoint.path} ${endpoint.symbolId}`.toLowerCase().includes(needle) &&
        endpoints.length < args.limit
      )
        endpoints.push({ ...endpoint });
    }
    return Promise.resolve(okResult({ symbols, endpoints, total }, total > symbols.length));
  },
});

const findReferences = define<z.output<typeof FindReferencesInput>>({
  name: 'find_references',
  description:
    'Where a symbol is used: callers and callees from the code index, its outgoing HTTP calls and endpoints, plus a bounded textual search of its simple name in the same application (each file read is counted and permitted by the scope).',
  input: FindReferencesInput,
  operations: (args, ctx) => {
    if (!args.textual) return [];
    const code = codeOf(ctx);
    const symbol = code?.symbols.find((entry) => entry.id === args.symbolId);
    if (!symbol) return [];
    return listOperations(targetsOf(ctx, symbol.applicationId, undefined));
  },
  read: async (args, ctx) => {
    const code = codeOf(ctx);
    if (!code)
      return refused('Aucun index de code : l’analyse du code n’a pas encore été faite.', 'code.missing');
    const symbol = code.symbols.find((entry) => entry.id === args.symbolId);
    if (!symbol) return refused(`Symbole inconnu « ${args.symbolId} ».`, 'symbol.unknown');
    const callers: Record<string, unknown>[] = [];
    const callees: Record<string, unknown>[] = [];
    for (const call of code.calls) {
      if (call.to === symbol.id && callers.length < args.limit) callers.push({ ...call });
      if (call.from === symbol.id && callees.length < args.limit) callees.push({ ...call });
    }
    const outgoing: Record<string, unknown>[] = [];
    for (const call of code.outgoing) if (call.symbolId === symbol.id) outgoing.push({ ...call });
    const endpoints: Record<string, unknown>[] = [];
    for (const endpoint of code.endpoints)
      if (endpoint.symbolId === symbol.id) endpoints.push({ ...endpoint });
    const data: Record<string, unknown> = {
      symbol: {
        id: symbol.id,
        kind: symbol.kind,
        name: symbol.name,
        file: symbol.file,
        line: symbol.line,
        applicationId: symbol.applicationId,
      },
      callers,
      callees,
      outgoing,
      endpoints,
    };
    let truncated = false;
    if (args.textual) {
      const simple = symbol.name.split('.').at(-1) ?? symbol.name;
      const repository = repositoryById(ctx, symbol.applicationId);
      if (repository && simple !== '') {
        const search = await searchCode(ctx.files, targetsOf(ctx, symbol.applicationId, undefined), {
          query: `\\b${simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          regex: true,
          caseSensitive: true,
          maxHits: args.limit,
          contextLines: 0,
          maxFiles: registryState(ctx).maxSearchFiles,
          extensions: [...SOURCE_EXTENSIONS[repository.layer]],
          signal: ctx.signal,
          onFileRead: registryState(ctx).onFileRead,
        });
        truncated = search.truncated;
        data.textual = {
          query: simple,
          hits: search.hits.map((hit) =>
            ctx.dataPolicy.sendSourceCode
              ? hit
              : { applicationId: hit.applicationId, file: hit.file, line: hit.line },
          ),
          filesRead: search.filesRead,
          filesDenied: search.filesDenied,
          ...(search.reasons.length > 0 ? { notes: search.reasons } : {}),
        };
      }
    }
    return okResult(data, truncated);
  },
});

const searchCodeTool = define<z.output<typeof SearchCodeInput>>({
  name: 'search_code',
  description:
    'Bounded text search (literal or regular expression) in the source files of the scope. Each file read is permitted by the scope and counted; hits carry file, line and a few context lines. Narrow by application or layer.',
  input: SearchCodeInput,
  operations: (args, ctx) => listOperations(targetsOf(ctx, args.applicationId, args.layer)),
  read: async (args, ctx) => {
    const targets = targetsOf(ctx, args.applicationId, args.layer);
    if (targets.length === 0)
      return refused('Aucune application correspondante dans le périmètre.', 'application.unknown');
    const extensionSet = new Set<string>();
    for (const target of targets) {
      const repository = repositoryById(ctx, target.applicationId);
      for (const extension of extensionsFor(repository?.layer ?? 'BACKEND', args.extensions))
        extensionSet.add(extension);
    }
    const state = registryState(ctx);
    const search = await searchCode(ctx.files, targets, {
      query: args.query,
      regex: args.regex,
      caseSensitive: args.caseSensitive,
      maxHits: args.maxHits,
      contextLines: args.contextLines,
      maxFiles: state.maxSearchFiles,
      extensions: [...extensionSet],
      signal: ctx.signal,
      onFileRead: state.onFileRead,
    });
    const hits = search.hits.map((hit) =>
      ctx.dataPolicy.sendSourceCode
        ? hit
        : { applicationId: hit.applicationId, file: hit.file, line: hit.line },
    );
    return okResult(
      {
        hits,
        filesListed: search.filesListed,
        filesRead: search.filesRead,
        filesDenied: search.filesDenied,
        ...(ctx.dataPolicy.sendSourceCode
          ? {}
          : { note: 'source text withheld by the data policy (sendSourceCode=false)' }),
        ...(search.reasons.length > 0 ? { notes: search.reasons } : {}),
      },
      search.truncated,
    );
  },
});

const readSource = define<z.output<typeof ReadSourceInput>>({
  name: 'read_source',
  description:
    'A window of a source file of the scope (relative path, optional startLine/endLine, at most 400 lines), numbered lines, configuration secrets masked. Only files permitted by the scope can be read; each read is counted.',
  input: ReadSourceInput,
  operations: (args, ctx) => {
    const repository = resolveRepository(ctx, args.applicationId);
    if (isResult(repository)) return [];
    return [
      {
        kind: 'READ_FILE',
        path: requestedPath(repository.root, args.file),
        applicationId: repository.applicationId,
      },
    ];
  },
  read: async (args, ctx) => {
    const repository = resolveRepository(ctx, args.applicationId);
    if (isResult(repository)) return repository;
    if (!ctx.dataPolicy.sendSourceCode)
      return refused(
        'Le code source n’est pas transmis au fournisseur (politique de données).',
        'dataPolicy.sendSourceCode',
      );
    const requested = requestedPath(repository.root, args.file);
    const text = await ctx.files.readText(requested);
    const relative = relativeTo(repository.root, args.file);
    registryState(ctx).onFileRead(repository.applicationId, relative);
    const lines = maskSource(relative, text).split('\n');
    const start = Math.min(args.startLine, Math.max(1, lines.length));
    const requestedEnd = args.endLine ?? start + DEFAULT_READ_LINES - 1;
    const end = Math.min(lines.length, Math.max(start, requestedEnd), start + MAX_READ_LINES - 1);
    const width = String(end).length;
    let body = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(width)}| ${line}`)
      .join('\n');
    let truncated = end < lines.length || end < requestedEnd;
    if (body.length > ctx.dataPolicy.maxSnippetChars) {
      body = `${body.slice(0, ctx.dataPolicy.maxSnippetChars)}…`;
      truncated = true;
    }
    return okResult(
      {
        applicationId: repository.applicationId,
        file: relative,
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        text: body,
      },
      truncated,
    );
  },
});

const listFiles = define<z.output<typeof ListFilesInput>>({
  name: 'list_files',
  description:
    'Source files of an application of the scope (relative paths), under an optional directory, by extension (defaults to the layer’s source extensions). Only directories permitted by the scope are listed.',
  input: ListFilesInput,
  operations: (args, ctx) => {
    const repository = repositoryById(ctx, args.applicationId);
    if (!repository) return [];
    const dirs =
      args.directory !== undefined
        ? [requestedPath(repository.root, args.directory)]
        : targetsOf(ctx, args.applicationId, undefined).flatMap(listedDirs);
    return dirs.map((dir) => ({ kind: 'LIST_DIR', path: dir, applicationId: repository.applicationId }));
  },
  read: async (args, ctx) => {
    const repository = repositoryById(ctx, args.applicationId);
    if (!repository) return refused(`Application inconnue « ${args.applicationId} ».`, 'application.unknown');
    const extensionList = extensionsFor(repository.layer, args.extensions);
    const dirs =
      args.directory !== undefined
        ? [requestedPath(repository.root, args.directory)]
        : targetsOf(ctx, args.applicationId, undefined).flatMap(listedDirs);
    const files: string[] = [];
    let total = 0;
    for (const dir of dirs) {
      for (const file of await ctx.files.list(dir, { extensions: extensionList })) {
        total += 1;
        if (files.length < args.limit) files.push(relativeTo(repository.root, file));
      }
    }
    return okResult({ applicationId: repository.applicationId, files, total }, total > files.length);
  },
});

const proposeExperiment = define<ProposeExperimentArgs>({
  name: 'propose_experiment',
  description:
    'Propose a verification (experiment) for a hypothesis. Nothing runs: the proposal is created as PROPOSED (or APPROVAL_REQUIRED when it has side effects) and waits for a person, exactly as if a person had planned it.',
  input: ProposeExperimentInput,
  operations: () => [],
  read: (args, ctx) =>
    ctx.proposals.proposeExperiment({
      ...args,
      verification: { kind: args.kind, description: args.description ?? args.objective, params: args.params },
    }),
});

const requestScopeExtension = define<RequestScopeExtensionArgs>({
  name: 'request_scope_extension',
  description:
    'Ask a person to widen the scope (another application, path, class, endpoint, host or depth). The request stays PENDING until a person decides; side effects and commands can never be requested.',
  input: RequestScopeExtensionInput,
  operations: () => [],
  read: (args, ctx) => ctx.proposals.requestScopeExtension(args),
});

/** Les douze outils intégrés, dans l'ordre de la liste fermée. */
export const INVESTIGATION_TOOLS: readonly InvestigationTool[] = Object.freeze([
  getIncidentSummary,
  getEvidence,
  getRequest,
  getTraceGraph,
  getGraphNeighbours,
  findSymbol,
  findReferences,
  searchCodeTool,
  readSource,
  listFiles,
  proposeExperiment,
  requestScopeExtension,
]);

/** Le résumé d'un argument pour la trace (jamais la charge utile complète). */
export function targetOf(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const keys = [
    'file',
    'id',
    'nodeId',
    'symbolId',
    'query',
    'directory',
    'hypothesisId',
    'target',
    'applicationId',
    'layer',
    'kind',
  ];
  const parts: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '')
      parts.push(key === 'file' || key === 'id' ? value : `${key}=${value}`);
  }
  return clipText(parts.join(' '), MAX_TARGET_CHARS);
}

// ── État partagé des outils de code (par registre) ─────────────────────────────────────────────

interface RegistryState {
  maxSearchFiles: number;
  onFileRead: (applicationId: string, file: string) => void;
}

const STATES = new WeakMap<ToolContext, RegistryState>();

function registryState(ctx: ToolContext): RegistryState {
  return STATES.get(ctx) ?? { maxSearchFiles: DEFAULT_MAX_SEARCH_FILES, onFileRead: () => undefined };
}

// ── Le registre ────────────────────────────────────────────────────────────────────────────────

const issuesOf = (error: z.ZodError): string =>
  clipText(
    error.issues
      .map((issue) => `${issue.path.map(String).join('.') || 'input'} : ${issue.message}`)
      .join(' ; '),
    500,
  );

/** Un JSON Schema d'entrée pour le fournisseur (sans `$schema`, forme d'entrée : les défauts sont facultatifs). */
export function inputSchemaOf(tool: InvestigationTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function createToolRegistry(
  ctx: ToolContext,
  allow: readonly InvestigationToolName[],
  options: ToolRegistryOptions,
): InvestigationToolRegistry {
  const candidates = new Map<string, InvestigationTool>();
  for (const tool of [...INVESTIGATION_TOOLS, ...(options.extra ?? [])]) {
    candidates.set(assertSafeToolName(tool.name), tool);
  }
  const tools = new Map<InvestigationToolName, InvestigationTool>();
  for (const name of allow) {
    if (EXECUTION_VERB.test(name)) throw new Error(`Nom d'outil refusé (verbe d'exécution) : « ${name} ».`);
    const tool = candidates.get(name);
    if (tool) tools.set(name, tool);
  }
  // Une copie du contexte par registre : l'état des outils de code (fichiers lus, plafond de recherche) lui est attaché.
  const scoped: ToolContext = { ...ctx };
  const masker = createMasker(options);
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const now = options.now ?? ((): string => new Date().toISOString());
  const calls: AiToolCall[] = [];
  const filesRead: RefIndexFile[] = [];
  const refs = options.refs ?? new RefIndex(ctx.incident);
  STATES.set(scoped, {
    maxSearchFiles: options.maxSearchFiles ?? DEFAULT_MAX_SEARCH_FILES,
    onFileRead: (applicationId, file) => {
      refs.addFile(applicationId, file);
      if (!filesRead.some((entry) => entry.applicationId === applicationId && entry.file === file))
        filesRead.push({ applicationId, file });
    },
  });

  const finish = (
    name: string,
    target: string,
    startedAt: number,
    result: ToolResult,
    decision?: { allowed: boolean; rule?: string },
  ): { result: ToolResult; trace: AiToolCall } => {
    const allowed = decision?.allowed ?? result.ok;
    const trace: AiToolCall = {
      at: now(),
      name,
      target: clipText(masker.text(target), MAX_TARGET_CHARS),
      allowed,
      ...(!allowed && (decision?.rule ?? result.rule) !== undefined
        ? { rule: decision?.rule ?? result.rule }
        : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    calls.push(trace);
    options.onCall?.(trace, result);
    return { result, trace };
  };

  const limitItems = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.slice(0, maxItems).map(limitItems);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, limitItems(entry)]),
      );
    return value;
  };

  const countItems = (value: unknown): number => {
    if (Array.isArray(value)) return Math.max(value.length, ...value.map(countItems), 0);
    if (value !== null && typeof value === 'object')
      return Math.max(0, ...Object.values(value as Record<string, unknown>).map(countItems));
    return 0;
  };

  async function call(name: string, input: unknown): Promise<{ result: ToolResult; trace: AiToolCall }> {
    const startedAt = Date.now();
    const shownName = clipText(name, 80);
    const tool = (INVESTIGATION_TOOL_NAMES as readonly string[]).includes(shownName)
      ? tools.get(shownName as InvestigationToolName)
      : undefined;
    if (!tool) {
      const known = (INVESTIGATION_TOOL_NAMES as readonly string[]).includes(shownName);
      return finish(
        shownName,
        '',
        startedAt,
        known
          ? refused(`L’outil « ${shownName} » n’est pas permis à cet agent.`, 'tool.not-allowed')
          : refused(`Outil inconnu « ${shownName} ».`, 'tool.unknown'),
      );
    }
    if (scoped.signal.aborted)
      return finish(shownName, '', startedAt, refused('Appel annulé.', 'tool.cancelled'));
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) {
      return finish(
        shownName,
        targetOf(input),
        startedAt,
        refused(`Entrée invalide — ${issuesOf(parsed.error)}`, 'tool.input'),
      );
    }
    const args = parsed.data;
    const target = targetOf(args);
    let operations: PolicyOperation[];
    try {
      operations = tool.operations(args, scoped);
    } catch (error) {
      return finish(
        shownName,
        target,
        startedAt,
        refused(`Opérations impossibles à établir : ${messageOf(error)}`, 'tool.error'),
      );
    }
    for (const operation of operations) {
      const decision = await scoped.policy.check(operation);
      if (!decision.allowed)
        return finish(shownName, target, startedAt, refused(decision.reason, decision.rule), decision);
    }
    let result: ToolResult;
    try {
      result = await tool.read(args, scoped);
    } catch (error) {
      if (error instanceof ScopeDeniedError)
        return finish(
          shownName,
          target,
          startedAt,
          refused(error.decision.reason, error.decision.rule),
          error.decision,
        );
      return finish(
        shownName,
        target,
        startedAt,
        refused(`Lecture impossible : ${messageOf(error)}`, 'tool.error'),
      );
    }
    if (!result.ok) {
      const cleaned: ToolResult = {
        ok: false,
        error: masker.text(result.error ?? 'Refusé.'),
        ...(result.rule !== undefined ? { rule: result.rule } : {}),
      };
      return finish(shownName, target, startedAt, cleaned, { allowed: false, rule: result.rule });
    }
    const limited = limitItems(result.data);
    const bounded = boundData(masker.value(limited), options.maxResultChars);
    const truncated = Boolean(result.truncated) || bounded.truncated || countItems(result.data) > maxItems;
    return finish(shownName, target, startedAt, {
      ok: true,
      data: bounded.data,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  return {
    specs: (names) => {
      const specs: ToolSpec[] = [];
      for (const name of names) {
        const tool = tools.get(name);
        if (tool)
          specs.push({ name: tool.name, description: tool.description, inputSchema: inputSchemaOf(tool) });
      }
      return specs;
    },
    call,
    get calls() {
      return calls;
    },
    get filesRead() {
      return filesRead;
    },
    get names() {
      return [...tools.keys()];
    },
  };
}

const messageOf = (error: unknown): string =>
  clipText(redactText(error instanceof Error ? error.message : String(error)), 300);
