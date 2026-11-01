import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../../../memory/atomic-write.js';
import { redactText } from '../../../security/redactor.js';
import {
  AI_AGENTS,
  AI_INVESTIGATION_MODES,
  AI_REF_KINDS,
  AI_STOP_REASONS,
  CONTRADICTION_KINDS,
  COVERAGE_DIMENSIONS,
  COVERAGE_STATES,
  HYPOTHESIS_ORIGINS,
  HYPOTHESIS_RELATION_KINDS,
  INVESTIGATION_DEPTHS,
  MAX_CONTRADICTIONS,
  MAX_MEMORY_EVENTS,
  MAX_STRATEGIES,
  MEMORY_EVENT_KINDS,
  RISK_LEVELS,
  STRATEGY_CATEGORIES,
  STRATEGY_EXECUTION_MODES,
  STRATEGY_STATUSES,
  type AiBudget,
  type AiContradiction,
  type AiInvestigationMode,
  type AiRef,
  type AiUsage,
  type CoverageEntry,
  type DeepInvestigationBudget,
  type GeneratedExperiment,
  type HypothesisExploration,
  type InvestigationDepth,
  type InvestigationMemory,
  type InvestigationMemoryEvent,
  type InvestigationPermission,
  type InvestigationStrategy,
  type MemoryEventKind,
  type StrategyStatus,
} from '../../../sdk/core/incident-ai-contracts.js';
import {
  EXPERIMENT_KINDS,
  type ExperimentKind,
  type Incident,
  type ProposedVerification,
} from '../../../sdk/core/incident-contracts.js';

/**
 * LA MÉMOIRE D'INVESTIGATION APPROFONDIE : un fichier JSON structuré par incident
 * (`<projet>/incidents/<id>/ai/memory.json`), écrit atomiquement, borné, validé à la lecture. Elle ne
 * contient jamais une transcription de conversation avec le modèle, un corps de requête ou un secret : des
 * enregistrements structurés avec des références (ids de preuves, de requêtes, de symboles…). Tout texte
 * libre y entre masqué (`redactText`) et borné. Une mémoire illisible ne fait pas échouer une reprise : on
 * repart d'une mémoire neuve en le signalant.
 *
 * Toutes les fonctions d'enregistrement sont pures : elles rendent une mémoire nouvelle, sans modifier
 * celle reçue.
 */

export const MAX_MEMORY_EXPERIMENTS = 120;
export const MAX_MEMORY_PERMISSIONS = 100;
export const MAX_MEMORY_LIMITS = 40;
export const MAX_MEMORY_REMAINING = 60;
export const MAX_MEMORY_EXPLORATIONS = 80;
export const MAX_MEMORY_REFS = 40;
export const MAX_MEMORY_TEXT_CHARS = 500;
export const MAX_MEMORY_ID_CHARS = 300;
export const MAX_MEMORY_LIST_ITEMS = 40;
/** Taille maximale du fichier écrit ; au-delà, la chronologie est raccourcie avant l'écriture. */
export const MAX_MEMORY_BYTES = 2_000_000;

const MEMORY_STATUSES = ['IDLE', 'RUNNING', 'PAUSED', 'DONE', 'PARTIAL', 'FAILED', 'CANCELLED'] as const;
const MEMORY_STOP_REASONS = [
  ...AI_STOP_REASONS,
  'PAUSED',
  'STRATEGIES_EXHAUSTED',
  'DETERMINISTIC_CONFIRMED',
] as const;
const BUDGET_KEYS = [
  'maxIterations',
  'maxModelCalls',
  'maxToolCalls',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCost',
  'maxDurationMs',
  'maxFiles',
  'maxCommands',
  'maxExperiments',
] as const satisfies readonly (keyof AiBudget)[];
const LIMIT_KEYS = [...BUDGET_KEYS, 'STRATEGIES'] as const;
const CODE_LAYERS = ['FRONTEND', 'BFF', 'BACKEND', 'DATABASE'] as const;
const EXPLORATION_ROLES = [
  'CONFIRMED_CAUSE',
  'PROBABLE_CAUSE',
  'CONTRIBUTING_FACTOR',
  'REFUTED',
  'UNVERIFIED',
  'UNKNOWN',
] as const;
const VERIFICATION_EFFECTS = ['SUPPORTS', 'CONTRADICTS', 'NEUTRAL'] as const;
const CONTRADICTION_STATUSES = ['OPEN', 'RESOLVED_SUPPORTS', 'RESOLVED_CONTRADICTS', 'DISMISSED'] as const;
const PROPOSAL_STATUSES = ['PROPOSED', 'PLANNED', 'REFUSED', 'DONE'] as const;

// ── Schéma (validation à la lecture et avant l'écriture) ─────────────────────────────────────

const text = z.string().max(MAX_MEMORY_TEXT_CHARS);
const id = z.string().min(1).max(MAX_MEMORY_ID_CHARS);
const isoDate = z.string().min(1).max(64);
const nonNegative = z.number().min(0);
const texts = (max: number) => z.array(text).max(max);

const refSchema = z.object({ kind: z.enum(AI_REF_KINDS), id });
const refs = z.array(refSchema).max(MAX_MEMORY_REFS);

const locationSchema = z.object({
  applicationId: id,
  file: z.string().max(1024),
  line: z.number().int().nonnegative().optional(),
  symbol: id.optional(),
});

const budgetSchema = z.object({
  maxIterations: nonNegative,
  maxModelCalls: nonNegative,
  maxToolCalls: nonNegative,
  maxInputTokens: nonNegative,
  maxOutputTokens: nonNegative,
  maxCost: nonNegative,
  maxDurationMs: nonNegative,
  maxFiles: nonNegative,
  maxCommands: nonNegative,
  maxExperiments: nonNegative,
});
const partialBudgetSchema = budgetSchema.partial();
const deepBudgetSchema = budgetSchema.extend({
  maxConcurrentAgents: nonNegative,
  extensions: z
    .array(z.object({ at: isoDate, by: text, added: partialBudgetSchema }))
    .max(MAX_MEMORY_LIST_ITEMS),
});

const usageSchema = z.object({
  iterations: nonNegative,
  modelCalls: nonNegative,
  toolCalls: nonNegative,
  inputTokens: nonNegative,
  outputTokens: nonNegative,
  estimatedCost: nonNegative,
  durationMs: nonNegative,
  files: nonNegative,
  commands: nonNegative,
  experiments: nonNegative,
});

const strategySchema = z.object({
  id,
  name: text,
  category: z.enum(STRATEGY_CATEGORIES),
  applicableLayers: z.array(z.enum(CODE_LAYERS)).max(CODE_LAYERS.length),
  prerequisites: texts(MAX_MEMORY_LIST_ITEMS),
  requiredCapabilities: texts(MAX_MEMORY_LIST_ITEMS),
  estimatedCost: nonNegative,
  estimatedRisk: z.enum(RISK_LEVELS),
  expectedInformationGain: z.number().min(0).max(1),
  executionMode: z.enum(STRATEGY_EXECUTION_MODES),
  status: z.enum(STRATEGY_STATUSES),
  reason: text.optional(),
  hypothesisIds: z.array(id).max(MAX_MEMORY_LIST_ITEMS),
  via: z.object({
    agent: z.enum(AI_AGENTS).optional(),
    experimentKind: z.enum(EXPERIMENT_KINDS).optional(),
  }),
  attempts: z.number().int().nonnegative(),
  lastAttemptAt: isoDate.optional(),
  outcomeRefs: refs,
});

const relationSchema = z.object({
  from: id,
  to: id,
  kind: z.enum(HYPOTHESIS_RELATION_KINDS),
  reason: text,
});

const verificationResultSchema = z.object({
  experimentId: id,
  at: isoDate,
  effect: z.enum(VERIFICATION_EFFECTS),
  summary: text,
  refs,
});

const explorationSchema = z.object({
  hypothesisId: id,
  origin: z.enum(HYPOTHESIS_ORIGINS),
  unknowns: texts(MAX_MEMORY_LIST_ITEMS),
  locations: z.array(locationSchema).max(MAX_MEMORY_LIST_ITEMS),
  contributors: z.array(z.enum(AI_AGENTS)).max(AI_AGENTS.length),
  verifications: z.array(verificationResultSchema).max(MAX_MEMORY_LIST_ITEMS),
  nextProposalIds: z.array(id).max(MAX_MEMORY_LIST_ITEMS),
  relations: z.array(relationSchema).max(MAX_MEMORY_LIST_ITEMS),
  role: z.enum(EXPLORATION_ROLES),
});

const contradictionSchema = z.object({
  id,
  hypothesisId: id,
  kind: z.enum(CONTRADICTION_KINDS),
  summary: text,
  refs,
  openQuestion: z.boolean(),
  proposalId: id.optional(),
  status: z.enum(CONTRADICTION_STATUSES),
  foundBy: z.enum(AI_AGENTS),
  at: isoDate,
});

const paramValue = z.union([
  z.string().max(2048),
  z.number(),
  z.boolean(),
  z.array(z.string().max(2048)).max(200),
]);
const paramsSchema = z.record(z.string().max(100), paramValue);

const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('READ_FILE'), path: z.string().max(4096), applicationId: id.optional() }),
  z.object({ kind: z.literal('LIST_DIR'), path: z.string().max(4096), applicationId: id.optional() }),
  z.object({ kind: z.literal('READ_LOG'), path: z.string().max(4096) }),
  z.object({ kind: z.literal('NAVIGATE'), url: z.string().max(2048) }),
  z.object({ kind: z.literal('HTTP'), method: z.string().max(16), url: z.string().max(2048) }),
  z.object({
    kind: z.literal('RUN_TEST'),
    level: z.enum(['UNIT', 'INTEGRATION']),
    command: z.string().max(200),
    args: z.array(z.string().max(1024)).max(100),
    cwd: z.string().max(4096),
  }),
  z.object({
    kind: z.literal('COMMAND'),
    command: z.string().max(200),
    args: z.array(z.string().max(1024)).max(100),
    cwd: z.string().max(4096),
  }),
  z.object({
    kind: z.literal('OPENSHIFT'),
    verb: z.string().max(32),
    resource: z.string().max(300),
    namespace: z.string().max(253),
  }),
]);

const experimentSchema = z.object({
  id,
  hypothesisId: id,
  kind: z.enum(EXPERIMENT_KINDS),
  objective: text,
  verification: z.object({ kind: z.enum(EXPERIMENT_KINDS), description: text, params: paramsSchema }),
  resources: texts(MAX_MEMORY_LIST_ITEMS),
  permissions: texts(MAX_MEMORY_LIST_ITEMS),
  risks: texts(MAX_MEMORY_LIST_ITEMS),
  sideEffects: z.boolean(),
  expected: text,
  confirmIf: text,
  refuteIf: text,
  experimentId: id.optional(),
  status: z.enum(PROPOSAL_STATUSES),
  refusal: text.optional(),
  strategyId: id.optional(),
  requiredEvidence: refs,
  prerequisites: texts(MAX_MEMORY_LIST_ITEMS),
  operations: z.array(operationSchema).max(MAX_MEMORY_LIST_ITEMS),
  estimatedCost: nonNegative,
  risk: z.enum(RISK_LEVELS),
  differential: z
    .object({
      withData: z.record(z.string().max(100), z.string().max(2048)),
      withoutData: z.array(z.string().max(100)).max(100),
    })
    .optional(),
  impact: z
    .array(z.object({ hypothesisId: id, effect: z.enum(VERIFICATION_EFFECTS) }))
    .max(MAX_MEMORY_LIST_ITEMS)
    .optional(),
});

const coverageSchema = z.object({
  dimension: z.enum(COVERAGE_DIMENSIONS),
  state: z.enum(COVERAGE_STATES),
  examined: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  denominator: text.optional(),
  reason: text.optional(),
  refs,
});

const permissionSchema = z.object({
  id,
  at: isoDate,
  by: text,
  experimentId: id.optional(),
  operation: text,
  parameters: z.record(z.string().max(100), z.string().max(2048)),
  decision: z.enum(['APPROVED', 'REFUSED']),
  reason: text.optional(),
});

const eventSchema = z.object({
  id,
  at: isoDate,
  kind: z.enum(MEMORY_EVENT_KINDS),
  agent: z.enum(AI_AGENTS).optional(),
  actor: text.optional(),
  summary: text,
  refs,
  hypothesisId: id.optional(),
  strategyId: id.optional(),
  experimentId: id.optional(),
});

const limitSchema = z.object({
  at: isoDate,
  limit: z.enum(LIMIT_KEYS),
  remaining: texts(MAX_MEMORY_REMAINING),
  proposedExtension: partialBudgetSchema.optional(),
});

/** Le schéma complet ; les champs inconnus sont ignorés (une version future reste lisible). */
export const InvestigationMemorySchema = z.object({
  version: z.literal(1),
  incidentId: id,
  depth: z.enum(INVESTIGATION_DEPTHS),
  mode: z.enum(AI_INVESTIGATION_MODES),
  status: z.enum(MEMORY_STATUSES),
  stopReason: z.enum(MEMORY_STOP_REASONS).optional(),
  startedAt: isoDate.optional(),
  updatedAt: isoDate,
  budget: deepBudgetSchema,
  usage: usageSchema,
  strategies: z.array(strategySchema).max(MAX_STRATEGIES),
  explorations: z.array(explorationSchema).max(MAX_MEMORY_EXPLORATIONS),
  contradictions: z.array(contradictionSchema).max(MAX_CONTRADICTIONS),
  experiments: z.array(experimentSchema).max(MAX_MEMORY_EXPERIMENTS),
  coverage: z.array(coverageSchema).max(COVERAGE_DIMENSIONS.length),
  permissions: z.array(permissionSchema).max(MAX_MEMORY_PERMISSIONS),
  timeline: z.array(eventSchema).max(MAX_MEMORY_EVENTS),
  limits: z.array(limitSchema).max(MAX_MEMORY_LIMITS),
  remaining: texts(MAX_MEMORY_REMAINING),
  resumePoint: z.object({ iteration: z.number().int().nonnegative(), planStepId: id.optional() }).optional(),
});

/** Lit un JSON de mémoire ; `undefined` quand il est illisible ou ne respecte pas le schéma. */
export function parseMemory(raw: string): InvestigationMemory | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = InvestigationMemorySchema.safeParse(value);
  return result.success ? result.data : undefined;
}

// ── Le dépôt ─────────────────────────────────────────────────────────────────────────────────

/** Où la mémoire est rangée : injecté (fichier en production, tableau en mémoire vive dans les tests). */
export interface MemoryStore {
  read(incidentId: string): Promise<string | undefined>;
  write(incidentId: string, json: string): Promise<void>;
  remove(incidentId: string): Promise<void>;
}

/** Un identifiant d'incident sûr pour un chemin : jamais un dossier, jamais une remontée. */
const SAFE_INCIDENT_ID = /^inc_[A-Za-z0-9_-]{1,64}$/;

export function isSafeMemoryIncidentId(incidentId: string): boolean {
  return SAFE_INCIDENT_ID.test(incidentId);
}

/** Le dossier IA d'un incident (`<projet>/incidents/<id>/ai`). */
export function memoryDir(projectDir: string, incidentId: string): string {
  return path.join(projectDir, 'incidents', incidentId, 'ai');
}

/** Le fichier de mémoire d'un incident (`<projet>/incidents/<id>/ai/memory.json`). */
export function memoryFile(projectDir: string, incidentId: string): string {
  return path.join(memoryDir(projectDir, incidentId), 'memory.json');
}

/**
 * Le dépôt fichier : écriture atomique (fichier temporaire puis renommage), lecture tolérante (absent ⇒
 * `undefined`), `remove` retire le dossier IA de l'incident (rétention : la mémoire part avec l'incident).
 */
export function fileMemoryStore(projectDir: string): MemoryStore {
  return {
    async read(incidentId) {
      if (!isSafeMemoryIncidentId(incidentId)) return undefined;
      try {
        return await readFile(memoryFile(projectDir, incidentId), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(incidentId, json) {
      if (!isSafeMemoryIncidentId(incidentId)) {
        throw new Error(`Identifiant d'incident refusé pour la mémoire : ${incidentId}`);
      }
      await mkdir(memoryDir(projectDir, incidentId), { recursive: true });
      await writeFileAtomic(memoryFile(projectDir, incidentId), json);
    },
    async remove(incidentId) {
      if (!isSafeMemoryIncidentId(incidentId)) return;
      await rm(memoryDir(projectDir, incidentId), { recursive: true, force: true });
    },
  };
}

/** Un dépôt en mémoire vive (tests, prévisualisation) : même contrat, rien sur le disque. */
export function inMemoryStore(
  initial: Record<string, string> = {},
): MemoryStore & { readonly files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (incidentId) => Promise.resolve(files.get(incidentId)),
    write: (incidentId, json) => {
      files.set(incidentId, json);
      return Promise.resolve();
    },
    remove: (incidentId) => {
      files.delete(incidentId);
      return Promise.resolve();
    },
  };
}

// ── Création, chargement, sauvegarde ─────────────────────────────────────────────────────────

const nowIso = (): string => new Date().toISOString();

export function emptyUsage(): AiUsage {
  return {
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
}

export function createMemory(
  incident: Pick<Incident, 'id'>,
  depth: InvestigationDepth,
  mode: AiInvestigationMode,
  budget: DeepInvestigationBudget,
  at: string = nowIso(),
): InvestigationMemory {
  return {
    version: 1,
    incidentId: incident.id,
    depth,
    mode,
    status: 'IDLE',
    updatedAt: at,
    budget: structuredClone(budget),
    usage: emptyUsage(),
    strategies: [],
    explorations: [],
    contradictions: [],
    experiments: [],
    coverage: [],
    permissions: [],
    timeline: [],
    limits: [],
    remaining: [],
  };
}

export interface MemoryFallback {
  depth: InvestigationDepth;
  mode: AiInvestigationMode;
  budget: DeepInvestigationBudget;
  at?: string;
}

export interface LoadedMemory {
  memory: InvestigationMemory;
  /** Vrai quand rien d'utilisable n'existait : la mémoire rendue est neuve. */
  fresh: boolean;
  /** Une mémoire existait mais était illisible : la raison, à reporter dans les limitations du run. */
  limitation?: string;
}

/**
 * Charge la mémoire d'un incident. Absente ⇒ mémoire neuve. Illisible ou invalide (JSON cassé, schéma non
 * respecté, autre incident, dépôt en erreur) ⇒ mémoire neuve, avec une limitation et un événement DECISION
 * qui le disent.
 */
export async function loadMemory(
  store: MemoryStore,
  incidentId: string,
  fallback: MemoryFallback,
): Promise<LoadedMemory> {
  const at = fallback.at ?? nowIso();
  let raw: string | undefined;
  try {
    raw = await store.read(incidentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return damaged(incidentId, fallback, at, `lecture impossible : ${message}`);
  }
  if (raw === undefined) {
    return {
      memory: createMemory({ id: incidentId }, fallback.depth, fallback.mode, fallback.budget, at),
      fresh: true,
    };
  }
  const parsed = parseMemory(raw);
  if (!parsed) return damaged(incidentId, fallback, at, 'contenu illisible ou hors schéma');
  if (parsed.incidentId !== incidentId) {
    return damaged(incidentId, fallback, at, `elle décrit l'incident ${parsed.incidentId}`);
  }
  return { memory: parsed, fresh: false };
}

function damaged(incidentId: string, fallback: MemoryFallback, at: string, why: string): LoadedMemory {
  const limitation = `Mémoire d'investigation de ${incidentId} inutilisable (${why}) : l'investigation repart d'une mémoire neuve.`;
  const fresh = createMemory({ id: incidentId }, fallback.depth, fallback.mode, fallback.budget, at);
  return {
    memory: recordEvent(fresh, { kind: 'DECISION', actor: 'system', summary: limitation, at }),
    fresh: true,
    limitation,
  };
}

/**
 * Sauvegarde : borne, valide (une mémoire invalide est une erreur de programme, jamais écrite), sérialise et
 * écrit par le dépôt. Si le JSON dépasse `MAX_MEMORY_BYTES`, la chronologie est raccourcie par moitiés.
 * Rend la mémoire telle qu'écrite.
 */
export async function saveMemory(
  store: MemoryStore,
  memory: InvestigationMemory,
): Promise<InvestigationMemory> {
  let bounded = boundMemory(memory);
  let json = serialize(bounded);
  while (json.length > MAX_MEMORY_BYTES && bounded.timeline.length > 0) {
    bounded = { ...bounded, timeline: bounded.timeline.slice(Math.ceil(bounded.timeline.length / 2)) };
    json = serialize(bounded);
  }
  if (json.length > MAX_MEMORY_BYTES) {
    throw new Error(`Mémoire d'investigation trop volumineuse (${json.length} caractères).`);
  }
  await store.write(memory.incidentId, json);
  return bounded;
}

function serialize(memory: InvestigationMemory): string {
  const result = InvestigationMemorySchema.safeParse(memory);
  if (!result.success) {
    const issue = result.error.issues[0];
    const detail = issue ? `${issue.path.join('.') || '(racine)'} : ${issue.message}` : 'schéma non respecté';
    throw new Error(`Mémoire d'investigation invalide : ${detail}.`);
  }
  return `${JSON.stringify(result.data, null, 2)}\n`;
}

/** Les bornes : la chronologie et les journaux perdent leur tête, les catalogues leur queue. */
export function boundMemory(memory: InvestigationMemory): InvestigationMemory {
  const seen = new Set<string>();
  const coverage = memory.coverage.filter((entry) => {
    if (seen.has(entry.dimension)) return false;
    seen.add(entry.dimension);
    return true;
  });
  return {
    ...memory,
    strategies: memory.strategies.slice(0, MAX_STRATEGIES),
    explorations: memory.explorations.slice(0, MAX_MEMORY_EXPLORATIONS),
    contradictions: memory.contradictions.slice(-MAX_CONTRADICTIONS),
    experiments: memory.experiments.slice(-MAX_MEMORY_EXPERIMENTS),
    coverage,
    permissions: memory.permissions.slice(-MAX_MEMORY_PERMISSIONS),
    timeline: memory.timeline.slice(-MAX_MEMORY_EVENTS),
    limits: memory.limits.slice(-MAX_MEMORY_LIMITS),
    remaining: memory.remaining.slice(0, MAX_MEMORY_REMAINING),
  };
}

// ── Masquage et bornage des textes libres ────────────────────────────────────────────────────

/** Un texte libre tel qu'il entre en mémoire : masqué, sur une ligne, borné. */
export function memoryText(value: string, max: number = MAX_MEMORY_TEXT_CHARS): string {
  const clean = redactText(value).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const memoryTexts = (values: readonly string[], max: number = MAX_MEMORY_LIST_ITEMS): string[] =>
  values.slice(0, max).map((value) => memoryText(value));

const memoryRefs = (values: readonly AiRef[] | undefined): AiRef[] =>
  (values ?? [])
    .slice(0, MAX_MEMORY_REFS)
    .map((ref) => ({ kind: ref.kind, id: ref.id.slice(0, MAX_MEMORY_ID_CHARS) }));

const optionalText = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : memoryText(value);

/** Les champs optionnels absents ne sont pas écrits (JSON plus court, égalité structurelle simple). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function nextId(prefix: string, existing: readonly { id: string }[]): string {
  let max = 0;
  for (const item of existing) {
    if (!item.id.startsWith(prefix)) continue;
    const n = Number(item.id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

// ── Enregistrements ──────────────────────────────────────────────────────────────────────────

export type MemoryEventInput = Omit<InvestigationMemoryEvent, 'id' | 'at' | 'refs'> & {
  id?: string;
  at?: string;
  refs?: AiRef[];
};

/** Ajoute un événement à la chronologie (texte masqué et borné) ; la chronologie reste bornée. */
export function recordEvent(memory: InvestigationMemory, event: MemoryEventInput): InvestigationMemory {
  const at = event.at ?? nowIso();
  const entry: InvestigationMemoryEvent = compact({
    id: event.id ?? nextId('mem-ev-', memory.timeline),
    at,
    kind: event.kind,
    agent: event.agent,
    actor: optionalText(event.actor),
    summary: memoryText(event.summary),
    refs: memoryRefs(event.refs),
    hypothesisId: event.hypothesisId,
    strategyId: event.strategyId,
    experimentId: event.experimentId,
  });
  return { ...memory, updatedAt: at, timeline: [...memory.timeline, entry].slice(-MAX_MEMORY_EVENTS) };
}

export type PermissionInput = Omit<InvestigationPermission, 'id' | 'at'> & { id?: string; at?: string };

/** Une permission accordée ou refusée, liée à une opération et à ses paramètres précis ; plus l'événement. */
export function recordPermission(
  memory: InvestigationMemory,
  permission: PermissionInput,
): InvestigationMemory {
  const at = permission.at ?? nowIso();
  const entry: InvestigationPermission = compact({
    id: permission.id ?? nextId('perm-', memory.permissions),
    at,
    by: memoryText(permission.by),
    experimentId: permission.experimentId,
    operation: memoryText(permission.operation),
    parameters: Object.fromEntries(
      Object.entries(permission.parameters)
        .slice(0, MAX_MEMORY_LIST_ITEMS)
        .map(([key, value]) => [key.slice(0, 100), memoryText(value, 2048)]),
    ),
    decision: permission.decision,
    reason: optionalText(permission.reason),
  });
  const verb = entry.decision === 'APPROVED' ? 'accordée' : 'refusée';
  const next = { ...memory, permissions: [...memory.permissions, entry].slice(-MAX_MEMORY_PERMISSIONS) };
  return recordEvent(next, {
    kind: 'PERMISSION',
    actor: entry.by,
    at,
    summary: `Permission ${verb} : ${entry.operation}${entry.reason ? ` (${entry.reason})` : ''}`,
    refs: entry.experimentId ? [{ kind: 'experiment', id: entry.experimentId }] : [],
    experimentId: entry.experimentId,
  });
}

export interface LimitInput {
  limit: keyof AiBudget | 'STRATEGIES';
  /** Les pistes restantes (texte libre, masqué) : ce qu'une prolongation permettrait. */
  remaining: string[];
  proposedExtension?: Partial<AiBudget>;
  at?: string;
}

/** Une limite atteinte : enregistrée avec les pistes restantes et la prolongation proposée ; plus l'événement. */
export function recordLimit(memory: InvestigationMemory, limit: LimitInput): InvestigationMemory {
  const at = limit.at ?? nowIso();
  const remaining = memoryTexts(limit.remaining, MAX_MEMORY_REMAINING);
  const entry: InvestigationMemory['limits'][number] = compact({
    at,
    limit: limit.limit,
    remaining,
    proposedExtension: limit.proposedExtension ? { ...limit.proposedExtension } : undefined,
  });
  const next: InvestigationMemory = {
    ...memory,
    limits: [...memory.limits, entry].slice(-MAX_MEMORY_LIMITS),
    remaining: mergeRemaining(memory.remaining, remaining),
  };
  const extension = entry.proposedExtension
    ? ` ; prolongation proposée : ${describeBudget(entry.proposedExtension)}`
    : '';
  return recordEvent(next, {
    kind: 'LIMIT',
    at,
    summary: `Limite atteinte : ${entry.limit} ; ${remaining.length} piste(s) restante(s)${extension}`,
  });
}

function describeBudget(added: Partial<AiBudget>): string {
  return (
    Object.entries(added)
      .map(([key, value]) => `${key} +${String(value)}`)
      .join(', ') || 'aucun changement'
  );
}

function mergeRemaining(current: readonly string[], added: readonly string[]): string[] {
  const merged = [...current];
  for (const item of added) if (!merged.includes(item)) merged.push(item);
  return merged.slice(0, MAX_MEMORY_REMAINING);
}

/** Enregistre ou met à jour une stratégie (par id) et l'événement STRATEGY ; au plafond, une nouvelle est écartée. */
export function markStrategy(
  memory: InvestigationMemory,
  strategy: InvestigationStrategy,
  at: string = nowIso(),
): InvestigationMemory {
  const entry = cleanStrategy(strategy);
  const index = memory.strategies.findIndex((item) => item.id === entry.id);
  if (index < 0 && memory.strategies.length >= MAX_STRATEGIES) {
    return recordEvent(memory, {
      kind: 'DECISION',
      at,
      summary: `Stratégie écartée : ${entry.name} (plafond de ${MAX_STRATEGIES} stratégies atteint)`,
      strategyId: entry.id,
    });
  }
  const strategies =
    index < 0
      ? [...memory.strategies, entry]
      : memory.strategies.map((item, i) => (i === index ? entry : item));
  const next = refreshRemaining({ ...memory, strategies });
  return recordEvent(next, {
    kind: 'STRATEGY',
    at,
    agent: entry.via.agent,
    summary: `Stratégie ${entry.name} : ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`,
    refs: entry.outcomeRefs,
    strategyId: entry.id,
    hypothesisId: entry.hypothesisIds[0],
  });
}

function cleanStrategy(strategy: InvestigationStrategy): InvestigationStrategy {
  return compact({
    ...strategy,
    name: memoryText(strategy.name),
    prerequisites: memoryTexts(strategy.prerequisites),
    requiredCapabilities: memoryTexts(strategy.requiredCapabilities),
    reason: optionalText(strategy.reason),
    hypothesisIds: strategy.hypothesisIds.slice(0, MAX_MEMORY_LIST_ITEMS),
    via: compact({ ...strategy.via }),
    outcomeRefs: memoryRefs(strategy.outcomeRefs),
  });
}

/** Les paramètres sous une forme canonique (clés triées) : deux expériences identiques ont la même clé. */
export function experimentKey(
  kind: ExperimentKind,
  params: ProposedVerification['params'],
  hypothesisId: string,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => [key, params[key]]);
  return JSON.stringify([kind, hypothesisId, sorted]);
}

/** L'expérience identique déjà en mémoire (même nature, mêmes paramètres, même hypothèse), la plus récente. */
export function findIdenticalExperiment(
  memory: InvestigationMemory,
  kind: ExperimentKind,
  params: ProposedVerification['params'],
  hypothesisId: string,
): GeneratedExperiment | undefined {
  const key = experimentKey(kind, params, hypothesisId);
  for (let index = memory.experiments.length - 1; index >= 0; index -= 1) {
    const candidate = memory.experiments[index];
    if (
      candidate &&
      experimentKey(candidate.kind, candidate.verification.params, candidate.hypothesisId) === key
    ) {
      return candidate;
    }
  }
  return undefined;
}

export interface AddExperimentResult {
  memory: InvestigationMemory;
  /** Faux quand une expérience identique existait déjà et qu'aucune justification n'était donnée. */
  accepted: boolean;
  duplicateOf?: GeneratedExperiment;
}

const EVENT_BY_PROPOSAL_STATUS: Record<GeneratedExperiment['status'], MemoryEventKind> = {
  PROPOSED: 'EXPERIMENT_PROPOSED',
  PLANNED: 'EXPERIMENT_APPROVED',
  REFUSED: 'EXPERIMENT_REFUSED',
  DONE: 'EXPERIMENT_RUN',
};

/**
 * Ajoute une expérience générée ou met à jour celle qui porte le même id (statut, impact). Une expérience
 * identique à une autre déjà en mémoire (nature, paramètres, hypothèse) n'est pas ajoutée sans justification ;
 * justifiée, elle l'est et la justification reste dans la chronologie.
 */
export function addExperiment(
  memory: InvestigationMemory,
  experiment: GeneratedExperiment,
  options: { justification?: string; at?: string } = {},
): AddExperimentResult {
  const at = options.at ?? nowIso();
  const entry = cleanExperiment(experiment);
  const index = memory.experiments.findIndex((item) => item.id === entry.id);
  const refs: AiRef[] = [{ kind: 'hypothesis', id: entry.hypothesisId }];
  if (entry.experimentId) refs.push({ kind: 'experiment', id: entry.experimentId });
  const duplicate =
    index < 0
      ? findIdenticalExperiment(memory, entry.kind, entry.verification.params, entry.hypothesisId)
      : undefined;
  if (duplicate) {
    const justification = options.justification === undefined ? undefined : memoryText(options.justification);
    if (!justification) {
      const refused = recordEvent(memory, {
        kind: 'DECISION',
        at,
        summary: `Expérience ${entry.kind} non répétée : identique à ${duplicate.id} pour ${entry.hypothesisId}`,
        refs,
        hypothesisId: entry.hypothesisId,
        experimentId: duplicate.experimentId,
      });
      return { memory: refused, accepted: false, duplicateOf: duplicate };
    }
    const next = refreshRemaining({
      ...memory,
      experiments: [...memory.experiments, entry].slice(-MAX_MEMORY_EXPERIMENTS),
    });
    return {
      memory: recordEvent(next, {
        kind: EVENT_BY_PROPOSAL_STATUS[entry.status],
        at,
        summary: `Expérience ${entry.kind} répétée (identique à ${duplicate.id}) ; justification : ${justification}`,
        refs,
        hypothesisId: entry.hypothesisId,
        strategyId: entry.strategyId,
        experimentId: entry.experimentId,
      }),
      accepted: true,
      duplicateOf: duplicate,
    };
  }
  const experiments =
    index < 0
      ? [...memory.experiments, entry].slice(-MAX_MEMORY_EXPERIMENTS)
      : memory.experiments.map((item, i) => (i === index ? entry : item));
  const next = refreshRemaining({ ...memory, experiments });
  const impact = entry.impact?.map((item) => `${item.hypothesisId} ${item.effect}`).join(', ');
  const detail =
    entry.status === 'REFUSED' && entry.refusal
      ? ` ; refus : ${entry.refusal}`
      : impact
        ? ` ; impact : ${impact}`
        : '';
  return {
    memory: recordEvent(next, {
      kind: EVENT_BY_PROPOSAL_STATUS[entry.status],
      at,
      summary: `Expérience ${entry.kind} ${entry.status} pour ${entry.hypothesisId} : ${entry.objective}${detail}`,
      refs,
      hypothesisId: entry.hypothesisId,
      strategyId: entry.strategyId,
      experimentId: entry.experimentId,
    }),
    accepted: true,
  };
}

function cleanExperiment(experiment: GeneratedExperiment): GeneratedExperiment {
  return compact({
    ...experiment,
    objective: memoryText(experiment.objective),
    verification: {
      kind: experiment.verification.kind,
      description: memoryText(experiment.verification.description),
      params: structuredClone(experiment.verification.params),
    },
    resources: memoryTexts(experiment.resources),
    permissions: memoryTexts(experiment.permissions),
    risks: memoryTexts(experiment.risks),
    expected: memoryText(experiment.expected),
    confirmIf: memoryText(experiment.confirmIf),
    refuteIf: memoryText(experiment.refuteIf),
    refusal: optionalText(experiment.refusal),
    requiredEvidence: memoryRefs(experiment.requiredEvidence),
    prerequisites: memoryTexts(experiment.prerequisites),
    operations: structuredClone(experiment.operations.slice(0, MAX_MEMORY_LIST_ITEMS)),
    differential: experiment.differential ? structuredClone(experiment.differential) : undefined,
    impact: experiment.impact?.slice(0, MAX_MEMORY_LIST_ITEMS).map((item) => ({ ...item })),
  });
}

/**
 * Ajoute une contradiction ou met à jour celle qui porte le même id (statut). Une contradiction de même
 * hypothèse, même nature et même résumé qu'une autre n'est pas dupliquée (ses références s'ajoutent).
 */
export function addContradiction(
  memory: InvestigationMemory,
  contradiction: AiContradiction,
): InvestigationMemory {
  const entry = cleanContradiction(contradiction);
  const byId = memory.contradictions.findIndex((item) => item.id === entry.id);
  const same = (item: AiContradiction): boolean =>
    item.hypothesisId === entry.hypothesisId &&
    item.kind === entry.kind &&
    item.summary.toLowerCase() === entry.summary.toLowerCase();
  const index = byId >= 0 ? byId : memory.contradictions.findIndex(same);
  if (index < 0 && memory.contradictions.length >= MAX_CONTRADICTIONS) {
    return recordEvent(memory, {
      kind: 'DECISION',
      at: entry.at,
      agent: entry.foundBy,
      summary: `Contradiction écartée : plafond de ${MAX_CONTRADICTIONS} atteint (${entry.kind} sur ${entry.hypothesisId})`,
      hypothesisId: entry.hypothesisId,
    });
  }
  const contradictions =
    index < 0
      ? [...memory.contradictions, entry]
      : memory.contradictions.map((item, i) =>
          i === index ? mergeContradiction(item, entry, byId >= 0) : item,
        );
  const kept = contradictions[index >= 0 ? index : contradictions.length - 1] ?? entry;
  const nature = kept.openQuestion ? 'question ouverte' : kept.kind;
  return recordEvent(
    { ...memory, contradictions },
    {
      kind: 'CONTRADICTION',
      at: entry.at,
      agent: entry.foundBy,
      summary: `Contradiction ${kept.status} (${nature}) sur ${kept.hypothesisId} : ${kept.summary}`,
      refs: kept.refs,
      hypothesisId: kept.hypothesisId,
    },
  );
}

/** Même id : la nouvelle l'emporte ; même contenu : l'ancienne garde son id, prend le statut et les références. */
function mergeContradiction(
  current: AiContradiction,
  incoming: AiContradiction,
  sameId: boolean,
): AiContradiction {
  const base = sameId
    ? incoming
    : { ...current, status: incoming.status, proposalId: incoming.proposalId ?? current.proposalId };
  const refs = [...current.refs];
  for (const ref of incoming.refs) {
    if (!refs.some((known) => known.kind === ref.kind && known.id === ref.id)) refs.push(ref);
  }
  return compact({
    ...base,
    refs: refs.slice(0, MAX_MEMORY_REFS),
    openQuestion: base.openQuestion && refs.length === 0,
  });
}

function cleanContradiction(contradiction: AiContradiction): AiContradiction {
  const refs = memoryRefs(contradiction.refs);
  return compact({
    ...contradiction,
    summary: memoryText(contradiction.summary),
    refs,
    // Sans référence, une contradiction est une question ouverte, jamais un constat.
    openQuestion: contradiction.openQuestion || refs.length === 0,
  });
}

/** Les explorations d'hypothèses (textes masqués, listes bornées) ; remplace l'ensemble. */
export function setExplorations(
  memory: InvestigationMemory,
  explorations: readonly HypothesisExploration[],
  at: string = nowIso(),
): InvestigationMemory {
  return {
    ...memory,
    updatedAt: at,
    explorations: explorations.slice(0, MAX_MEMORY_EXPLORATIONS).map((exploration) => ({
      ...exploration,
      unknowns: memoryTexts(exploration.unknowns),
      locations: exploration.locations
        .slice(0, MAX_MEMORY_LIST_ITEMS)
        .map((location) => compact({ ...location })),
      contributors: [...new Set(exploration.contributors)],
      verifications: exploration.verifications.slice(0, MAX_MEMORY_LIST_ITEMS).map((verification) => ({
        ...verification,
        summary: memoryText(verification.summary),
        refs: memoryRefs(verification.refs),
      })),
      nextProposalIds: exploration.nextProposalIds.slice(0, MAX_MEMORY_LIST_ITEMS),
      relations: exploration.relations
        .slice(0, MAX_MEMORY_LIST_ITEMS)
        .map((relation) => ({ ...relation, reason: memoryText(relation.reason) })),
    })),
  };
}

/** La couverture par dimension (une entrée par dimension, la dernière l'emporte). */
export function setCoverage(
  memory: InvestigationMemory,
  coverage: readonly CoverageEntry[],
  at: string = nowIso(),
): InvestigationMemory {
  const byDimension = new Map<CoverageEntry['dimension'], CoverageEntry>();
  for (const entry of coverage) {
    byDimension.set(
      entry.dimension,
      compact({
        ...entry,
        denominator: optionalText(entry.denominator),
        reason: optionalText(entry.reason),
        refs: memoryRefs(entry.refs),
      }),
    );
  }
  return { ...memory, updatedAt: at, coverage: [...byDimension.values()] };
}

export function setUsage(
  memory: InvestigationMemory,
  usage: AiUsage,
  at: string = nowIso(),
): InvestigationMemory {
  return { ...memory, updatedAt: at, usage: { ...usage } };
}

/** Le statut (et la raison d'arrêt) ; `startedAt` est posé au premier passage en RUNNING. */
export function setStatus(
  memory: InvestigationMemory,
  status: InvestigationMemory['status'],
  stopReason?: InvestigationMemory['stopReason'],
  at: string = nowIso(),
): InvestigationMemory {
  const next: InvestigationMemory = { ...memory, status, updatedAt: at };
  if (stopReason === undefined) delete next.stopReason;
  else next.stopReason = stopReason;
  if (status === 'RUNNING' && memory.startedAt === undefined) next.startedAt = at;
  return next;
}

/** Une prolongation de budget accordée par une personne : les plafonds montent, la trace reste. */
export function extendBudget(
  memory: InvestigationMemory,
  added: Partial<AiBudget>,
  by: string,
  at: string = nowIso(),
): InvestigationMemory {
  const budget: DeepInvestigationBudget = { ...memory.budget, extensions: [...memory.budget.extensions] };
  const clean: Partial<AiBudget> = {};
  for (const key of BUDGET_KEYS) {
    const value = added[key];
    if (value === undefined || !Number.isFinite(value) || value <= 0) continue;
    clean[key] = value;
    budget[key] = memory.budget[key] + value;
  }
  budget.extensions = [...budget.extensions, { at, by: memoryText(by), added: clean }].slice(
    -MAX_MEMORY_LIST_ITEMS,
  );
  return recordEvent(
    { ...memory, budget },
    { kind: 'DECISION', at, actor: by, summary: `Budget prolongé : ${describeBudget(clean)}` },
  );
}

/** Le point de reprise : l'itération et l'étape du plan où tout s'est arrêté. */
export function setResumePoint(
  memory: InvestigationMemory,
  point: { iteration: number; planStepId?: string },
  at: string = nowIso(),
): InvestigationMemory {
  return refreshRemaining({ ...memory, updatedAt: at, resumePoint: compact({ ...point }) });
}

/** Une investigation reprend quand elle a été interrompue (pause, limite, panne) avec un point de reprise. */
export function canResume(memory: InvestigationMemory): boolean {
  if (memory.resumePoint === undefined) return false;
  return (
    memory.status === 'PAUSED' ||
    memory.status === 'PARTIAL' ||
    memory.status === 'RUNNING' ||
    memory.status === 'FAILED'
  );
}

/** Ce qui reste : stratégies disponibles ou bloquées, expériences proposées ou planifiées, pistes des limites. */
export function computeRemaining(memory: InvestigationMemory): string[] {
  const items: string[] = [];
  for (const strategy of memory.strategies) {
    if (strategy.status === 'AVAILABLE') items.push(`Stratégie disponible : ${strategy.name}`);
    else if (strategy.status === 'BLOCKED') {
      items.push(`Stratégie bloquée : ${strategy.name}${strategy.reason ? ` (${strategy.reason})` : ''}`);
    }
  }
  for (const experiment of memory.experiments) {
    if (experiment.status === 'PROPOSED' || experiment.status === 'PLANNED') {
      items.push(`Expérience ${experiment.status} : ${experiment.kind} pour ${experiment.hypothesisId}`);
    }
  }
  for (const limit of memory.limits) for (const lead of limit.remaining) items.push(lead);
  return [...new Set(items.map((item) => memoryText(item)))].slice(0, MAX_MEMORY_REMAINING);
}

function refreshRemaining(memory: InvestigationMemory): InvestigationMemory {
  return { ...memory, remaining: computeRemaining(memory) };
}

// ── Le résumé pour le rapport et l'outil `get_investigation_memory` ──────────────────────────

export interface InvestigationMemorySummary {
  incidentId: string;
  depth: InvestigationDepth;
  mode: AiInvestigationMode;
  status: InvestigationMemory['status'];
  stopReason?: InvestigationMemory['stopReason'];
  startedAt?: string;
  updatedAt: string;
  resumable: boolean;
  resumePoint?: InvestigationMemory['resumePoint'];
  usage: AiUsage;
  budget: DeepInvestigationBudget;
  strategies: {
    total: number;
    byStatus: Record<StrategyStatus, number>;
    tried: {
      id: string;
      name: string;
      category: InvestigationStrategy['category'];
      status: StrategyStatus;
      attempts: number;
      reason?: string;
    }[];
  };
  experiments: {
    total: number;
    byStatus: Record<GeneratedExperiment['status'], number>;
    items: {
      id: string;
      kind: ExperimentKind;
      hypothesisId: string;
      status: GeneratedExperiment['status'];
      sideEffects: boolean;
      experimentId?: string;
      impact?: GeneratedExperiment['impact'];
    }[];
  };
  contradictions: {
    total: number;
    open: number;
    resolved: number;
    dismissed: number;
    openQuestions: number;
    items: {
      id: string;
      hypothesisId: string;
      kind: AiContradiction['kind'];
      status: AiContradiction['status'];
      openQuestion: boolean;
      summary: string;
    }[];
  };
  explorations: {
    hypothesisId: string;
    role: HypothesisExploration['role'];
    verifications: number;
    unknowns: number;
  }[];
  permissions: { approved: number; refused: number; items: InvestigationPermission[] };
  limits: InvestigationMemory['limits'];
  remaining: string[];
  coverage: CoverageEntry[];
  timeline: {
    events: number;
    firstAt?: string;
    lastAt?: string;
    byKind: Partial<Record<MemoryEventKind, number>>;
  };
}

function countBy<K extends string, T extends object>(
  keys: readonly K[],
  items: readonly T[],
  field: keyof T,
): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const item of items) {
    const value: unknown = item[field];
    if (typeof value === 'string' && value in counts) counts[value as K] += 1;
  }
  return counts;
}

/** La vue structurée de la mémoire : comptes, stratégies tentées, expériences menées, contradictions, limites, reste. */
export function summarizeForReport(memory: InvestigationMemory): InvestigationMemorySummary {
  const byKind: Partial<Record<MemoryEventKind, number>> = {};
  for (const event of memory.timeline) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  const first = memory.timeline[0];
  const last = memory.timeline[memory.timeline.length - 1];
  return compact({
    incidentId: memory.incidentId,
    depth: memory.depth,
    mode: memory.mode,
    status: memory.status,
    stopReason: memory.stopReason,
    startedAt: memory.startedAt,
    updatedAt: memory.updatedAt,
    resumable: canResume(memory),
    resumePoint: memory.resumePoint,
    usage: { ...memory.usage },
    budget: structuredClone(memory.budget),
    strategies: {
      total: memory.strategies.length,
      byStatus: countBy(STRATEGY_STATUSES, memory.strategies, 'status'),
      tried: memory.strategies
        .filter((strategy) => strategy.attempts > 0 || strategy.status !== 'AVAILABLE')
        .map((strategy) =>
          compact({
            id: strategy.id,
            name: strategy.name,
            category: strategy.category,
            status: strategy.status,
            attempts: strategy.attempts,
            reason: strategy.reason,
          }),
        ),
    },
    experiments: {
      total: memory.experiments.length,
      byStatus: countBy(PROPOSAL_STATUSES, memory.experiments, 'status'),
      items: memory.experiments.map((experiment) =>
        compact({
          id: experiment.id,
          kind: experiment.kind,
          hypothesisId: experiment.hypothesisId,
          status: experiment.status,
          sideEffects: experiment.sideEffects,
          experimentId: experiment.experimentId,
          impact: experiment.impact,
        }),
      ),
    },
    contradictions: {
      total: memory.contradictions.length,
      open: memory.contradictions.filter((item) => item.status === 'OPEN').length,
      resolved: memory.contradictions.filter(
        (item) => item.status === 'RESOLVED_SUPPORTS' || item.status === 'RESOLVED_CONTRADICTS',
      ).length,
      dismissed: memory.contradictions.filter((item) => item.status === 'DISMISSED').length,
      openQuestions: memory.contradictions.filter((item) => item.openQuestion).length,
      items: memory.contradictions.map((item) => ({
        id: item.id,
        hypothesisId: item.hypothesisId,
        kind: item.kind,
        status: item.status,
        openQuestion: item.openQuestion,
        summary: item.summary,
      })),
    },
    explorations: memory.explorations.map((exploration) => ({
      hypothesisId: exploration.hypothesisId,
      role: exploration.role,
      verifications: exploration.verifications.length,
      unknowns: exploration.unknowns.length,
    })),
    permissions: {
      approved: memory.permissions.filter((item) => item.decision === 'APPROVED').length,
      refused: memory.permissions.filter((item) => item.decision === 'REFUSED').length,
      items: memory.permissions.map((item) => ({ ...item, parameters: { ...item.parameters } })),
    },
    limits: memory.limits.map((limit) => ({ ...limit, remaining: [...limit.remaining] })),
    remaining: [...memory.remaining],
    coverage: memory.coverage.map((entry) => ({ ...entry, refs: [...entry.refs] })),
    timeline: compact({ events: memory.timeline.length, firstAt: first?.at, lastAt: last?.at, byKind }),
  });
}
