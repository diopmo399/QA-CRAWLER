import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hypothesis } from '../cognitive/hypothesis-engine.js';
import type { DiscoveredInvariant } from '../cognitive/invariants-failures.js';
import type { FlowRunMemory } from '../flows/flow-run-comparison.js';
import type { LearnedKnowledge } from '../functional/runtime-learning.js';
import {
  functionalKnowledgeFile,
  type RememberedFieldMapping,
  type RememberedFunctional,
  type RememberedIntentDecision,
  type RememberedIntentPattern,
} from '../knowledge/functional-knowledge-store.js';
import { migrateKnowledge } from '../knowledge/json-knowledge-base.js';
import type {
  ActionKnowledge,
  ApiKnowledge,
  KnowledgeData,
  LearnedHint,
  PerformanceKnowledge,
  RecoveryKnowledge,
  TargetResolutionKnowledge,
  TransitionKnowledge,
} from '../knowledge/knowledge-model.js';
import { ruleKnowledgeFile, type RememberedRule } from '../knowledge/rule-knowledge-store.js';
import {
  NO_TARGET,
  type KeyedRecord,
  type FlowMemoryRecord,
  type TransitionKnowledgeRecord,
} from '../persistence/model.js';
import type { PersistenceProvider } from '../persistence/persistence-provider.js';
import { isSemanticSignature } from '../semantics/resolution/semantic-knowledge.js';
import { sha256 } from '../static-analysis/source-set.js';
import type {
  KnowledgeEvidence,
  KnowledgeItem,
  KnowledgeOrigin,
  KnowledgeSource,
  KnowledgeType,
} from './model.js';
import { assessReliability, type ReliabilityOptions } from './reliability.js';

/**
 * LES LECTEURS : chaque lieu réel de la Knowledge traduit en KnowledgeItem, sans rien copier ni
 * reconstituer. Une ligne illisible est un avertissement (rapporté), jamais une valeur inventée.
 */

export interface ReaderWarning {
  location: string;
  message: string;
}

export interface ReadResult {
  items: KnowledgeItem[];
  warnings: ReaderWarning[];
}

export interface ApplicationIdentity {
  /** `application@environment` : la clé de la persistance (applicationIdOf). */
  applicationId: string;
  application: string;
  environment?: string;
  /** L'application telle que les stores fonctionnel et des règles la nomment (le nom de la mission). */
  functionalApplication: string;
}

/** Identifiant stable d'une connaissance : dérivé de sa clé réelle, jamais d'un compteur. */
export function itemId(
  source: KnowledgeSource,
  type: KnowledgeType,
  application: string,
  environment: string | undefined,
  key: string,
): string {
  return `${type.toLowerCase().replace(/_/g, '-')}-${sha256([source, type, application, environment ?? '', key].join('\u001f')).slice(0, 16)}`;
}

type Partial_<T> = Omit<T, 'id' | 'reliability' | 'evidence' | 'application' | 'environment' | 'source'> & {
  evidence?: KnowledgeEvidence;
  hypothesis?: boolean;
};

function build(
  source: KnowledgeSource,
  identity: Pick<ApplicationIdentity, 'application' | 'environment'>,
  options: ReliabilityOptions,
  partial: Partial_<KnowledgeItem>,
): KnowledgeItem {
  const { hypothesis, evidence = {}, ...rest } = partial;
  return {
    ...rest,
    id: itemId(source, partial.type, identity.application, identity.environment, partial.key),
    source,
    application: identity.application,
    ...(identity.environment ? { environment: identity.environment } : {}),
    evidence,
    reliability: assessReliability(evidence, partial.updatedAt, options, hypothesis ?? false),
  };
}

/* ───────────────────────── persistance ───────────────────────── */

export async function readPersistence(
  provider: PersistenceProvider,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
  limit: number,
): Promise<ReadResult> {
  const warnings: ReaderWarning[] = [];
  const items: KnowledgeItem[] = [];
  const read = async <T>(table: string, work: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await work();
    } catch (error) {
      warnings.push({ location: table, message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  };
  for (const row of await read('transition_knowledge', () =>
    provider.knowledge.load(identity.applicationId, limit),
  ))
    items.push(transitionItem(row, identity, options));
  for (const row of await read('flow_evolution', () =>
    provider.evolution.load(identity.applicationId, limit),
  ))
    items.push(keyedItem('EVOLUTION', 'flow_evolution', row, identity, options));
  for (const row of await read('anomaly_lifecycle', () =>
    provider.anomalies.load(identity.applicationId, limit),
  ))
    items.push(keyedItem('ANOMALY', 'anomaly_lifecycle', row, identity, options));
  for (const row of await read('flow_memory', () =>
    provider.memory.search({ applicationId: identity.applicationId, limit }),
  ))
    items.push(flowMemoryItem(row, identity, options));
  return { items, warnings };
}

function transitionItem(
  row: TransitionKnowledgeRecord,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
): KnowledgeItem {
  const semantic = isSemanticSignature(row.actionSignature);
  const to = row.toStateSignature === NO_TARGET ? '(no new screen)' : row.toStateSignature;
  return build('PERSISTENCE', identity, options, {
    type: 'TRANSITION',
    origin: semantic ? 'REPLAY' : 'EXPLORATION',
    title: `${row.fromStateSignature} —${row.actionSignature}→ ${to}`,
    description: semantic
      ? 'a recorded intent resolved to a target during a replay (semantic resolution)'
      : 'an action tried from a screen and where it led',
    key: [row.fromStateSignature, row.actionSignature, row.toStateSignature].join('␟'),
    data: {
      fromStateSignature: row.fromStateSignature,
      actionSignature: row.actionSignature,
      toStateSignature: row.toStateSignature,
      seenCount: row.seenCount,
      successCount: row.successCount,
      failureCount: row.failureCount,
      blockedCount: row.blockedCount,
      ...(row.averageDurationMs !== undefined ? { averageDurationMs: row.averageDurationMs } : {}),
      ...(row.lastContext ? { lastContext: row.lastContext } : {}),
    },
    createdAt: row.firstSeenAt,
    updatedAt: row.lastSeenAt,
    ...(row.lastContext?.version ? { appVersion: row.lastContext.version } : {}),
    evidence: {
      seen: row.seenCount,
      successes: row.successCount,
      failures: row.failureCount,
      blocked: row.blockedCount,
    },
    location: 'transition_knowledge',
  });
}

function keyedItem(
  type: 'EVOLUTION' | 'ANOMALY',
  table: string,
  row: KeyedRecord,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
): KnowledgeItem {
  const history = Array.isArray(row.data.history) ? (row.data.history as unknown[]) : [];
  const runIds = history
    .map((event) => (event && typeof event === 'object' ? (event as { runId?: unknown }).runId : undefined))
    .filter((id): id is string => typeof id === 'string');
  return build('PERSISTENCE', identity, options, {
    type,
    origin: 'EXPLORATION',
    title: `${row.key} · ${row.status}`,
    description:
      type === 'EVOLUTION'
        ? 'how a state, action or transition evolved from one run to the next'
        : 'the lifecycle of an anomaly (NEW, KNOWN, RESOLVED, REOPENED, FLAKY)',
    key: row.key,
    data: { status: row.status, ...row.data },
    createdAt: row.firstSeenAt,
    updatedAt: row.lastSeenAt,
    evidence: {
      seen: Math.max(1, history.length),
      ...(runIds.length > 0 ? { runIds: [...new Set(runIds)] } : {}),
      ...(type === 'ANOMALY' && ['NEW', 'REOPENED', 'FLAKY'].includes(row.status)
        ? { failures: 1, successes: 0 }
        : {}),
    },
    location: table,
  });
}

function flowMemoryItem(
  row: FlowMemoryRecord,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
): KnowledgeItem {
  const runId = typeof row.data.runId === 'string' ? row.data.runId : undefined;
  return build('PERSISTENCE', identity, options, {
    type: 'FLOW_MEMORY',
    origin: row.kind === 'actor' || row.kind === 'recovery' ? 'REPLAY' : 'EXPLORATION',
    title: `${row.kind} · ${row.key} · ${row.status}`,
    description: `flow memory of kind "${row.kind}" (one row per element, replaced in place)`,
    key: `${row.kind}|${row.key}`,
    data: { kind: row.kind, status: row.status, ...row.data },
    createdAt: row.firstSeenAt,
    updatedAt: row.lastSeenAt,
    evidence: { seen: 1, ...(runId ? { runIds: [runId] } : {}) },
    location: 'flow_memory',
  });
}

/* ───────────────────────── base de connaissances fichier ───────────────────────── */

export interface KnowledgeFileContent {
  schemaVersion: number;
  applications: Record<string, KnowledgeData>;
}

export async function readKnowledgeFileRaw(file: string): Promise<KnowledgeFileContent | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const migrated = migrateKnowledge(JSON.parse(text) as unknown);
  return migrated
    ? { schemaVersion: migrated.schemaVersion, applications: migrated.applications }
    : undefined;
}

/** Les applications d'un fichier de connaissances (clé `application@environnement`). */
export function knowledgeFileApplications(
  content: KnowledgeFileContent,
): { application: string; environment?: string }[] {
  return Object.values(content.applications).map((data) => ({
    application: data.identity.application,
    ...(data.identity.environment ? { environment: data.identity.environment } : {}),
  }));
}

export function knowledgeFileKey(identity: Pick<ApplicationIdentity, 'application' | 'environment'>): string {
  return [identity.application, identity.environment ?? 'default'].join('@');
}

export async function readKnowledgeFile(
  file: string,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
): Promise<ReadResult> {
  const warnings: ReaderWarning[] = [];
  let content: KnowledgeFileContent | undefined;
  try {
    content = await readKnowledgeFileRaw(file);
  } catch (error) {
    warnings.push({ location: file, message: error instanceof Error ? error.message : String(error) });
    return { items: [], warnings };
  }
  const data = content?.applications[knowledgeFileKey(identity)];
  if (!data) return { items: [], warnings };
  const items: KnowledgeItem[] = [];
  const add = (partial: Partial_<KnowledgeItem>): void => {
    items.push(build('KNOWLEDGE_FILE', identity, options, { ...partial, location: file }));
  };
  for (const [key, action] of Object.entries(data.actions)) add(actionItem(key, action));
  for (const [key, transition] of Object.entries(data.transitions)) add(fileTransitionItem(key, transition));
  for (const [key, api] of Object.entries(data.api)) add(apiItem(key, api));
  for (const [key, performance] of Object.entries(data.performance)) add(performanceItem(key, performance));
  for (const [key, hint] of Object.entries(data.hints)) add(hintItem(key, hint));
  for (const [key, recovery] of Object.entries(data.recoveries ?? {}))
    items.push(...recoveryItems(key, recovery, identity, options, file));
  for (const [key, resolution] of Object.entries(data.targetResolutions ?? {}))
    items.push(...resolutionItems(key, resolution, identity, options, file));
  for (const hypothesis of data.cognitive?.hypotheses ?? []) add(hypothesisItem(hypothesis));
  for (const invariant of data.cognitive?.invariants ?? []) add(invariantItem(invariant));
  for (const [name, run] of Object.entries(data.flowRuns ?? {})) add(flowRunItem(name, run));
  return { items, warnings };
}

function actionItem(key: string, action: ActionKnowledge): Partial_<KnowledgeItem> {
  return {
    type: 'ACTION',
    origin: 'EXPLORATION',
    title: action.actionSignature || key,
    description: 'how often an action was seen, executed, and with what result',
    key,
    data: { ...action },
    ...(action.lastSeenAt ? { updatedAt: action.lastSeenAt } : {}),
    ...(action.failureVersion ? { appVersion: action.failureVersion } : {}),
    evidence: {
      seen: action.seenCount,
      successes: action.successCount,
      failures: action.failureCount,
      blocked: action.blockedCount,
    },
    location: '',
  };
}

function fileTransitionItem(key: string, transition: TransitionKnowledge): Partial_<KnowledgeItem> {
  const targets = Object.entries(transition.targets).sort((a, b) => b[1] - a[1]);
  const top = targets[0];
  return {
    type: 'TRANSITION',
    origin: isSemanticSignature(transition.actionSignature) ? 'REPLAY' : 'EXPLORATION',
    title: `${transition.fromStateSignature} —${transition.actionSignature}→ ${top ? top[0] : '?'}${targets.length > 1 ? ` (+${String(targets.length - 1)})` : ''}`,
    description: 'where an action leads from a screen, across runs (one row, several destinations)',
    key,
    data: { ...transition },
    createdAt: transition.firstSeenAt,
    updatedAt: transition.lastSeenAt,
    ...(transition.lastContext?.version ? { appVersion: transition.lastContext.version } : {}),
    evidence: {
      seen: transition.executionCount,
      successes: transition.successCount,
      failures: transition.failureCount,
    },
    location: '',
  };
}

function apiItem(key: string, api: ApiKnowledge): Partial_<KnowledgeItem> {
  const total = Object.values(api.statuses).reduce((sum, count) => sum + count, 0);
  const errors = Object.entries(api.statuses)
    .filter(([status]) => /^[45]/.test(status))
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    type: 'API',
    origin: 'EXPLORATION',
    title: api.operation || key,
    description: 'HTTP statuses observed for an API operation (never a body)',
    key,
    data: { ...api },
    updatedAt: api.lastSeenAt,
    evidence: { seen: total, successes: total - errors, failures: errors },
    location: '',
  };
}

function performanceItem(key: string, performance: PerformanceKnowledge): Partial_<KnowledgeItem> {
  return {
    type: 'PERFORMANCE',
    origin: 'EXPLORATION',
    title: `${performance.kind} · ${performance.key}`,
    description: 'observed durations (ms), the last 50',
    key,
    data: { ...performance },
    updatedAt: performance.lastSeenAt,
    evidence: { seen: performance.durations.length },
    location: '',
  };
}

function hintItem(key: string, hint: LearnedHint): Partial_<KnowledgeItem> {
  return {
    type: 'HINT',
    origin: 'EXPLORATION',
    title: `"${hint.label}" usually means ${hint.pattern}`,
    description: 'a learned heuristic (label → pattern); never a safety rule',
    key,
    data: { ...hint },
    evidence: { seen: hint.total, successes: hint.count, failures: hint.total - hint.count },
    location: '',
  };
}

function recoveryItems(
  key: string,
  recovery: RecoveryKnowledge,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
  file: string,
): KnowledgeItem[] {
  return Object.entries(recovery.paths).map(([pathKey, found]) =>
    build('KNOWLEDGE_FILE', identity, options, {
      type: 'RECOVERY',
      origin: 'REPLAY',
      title: `${recovery.actionSignature} → ${recovery.goal}: ${found.actions.map((action) => `${action.kind} ${action.role} "${action.name}"`).join(', ')}`,
      description: 'a recovery path tried during a replay (successes and failures kept)',
      key: `${key}|${pathKey}`,
      data: { ...recovery, path: found },
      createdAt: found.firstSeenAt,
      updatedAt: found.lastSeenAt,
      ...(found.version ? { appVersion: found.version } : {}),
      evidence: { successes: found.successes, failures: found.failures },
      location: file,
    }),
  );
}

function resolutionItems(
  key: string,
  resolution: TargetResolutionKnowledge,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
  file: string,
): KnowledgeItem[] {
  return Object.entries(resolution.resolutions).map(([resolvedKey, learned]) =>
    build('KNOWLEDGE_FILE', identity, options, {
      type: 'TARGET_RESOLUTION',
      origin: 'REPLAY',
      title: `"${resolution.original}" → ${learned.role} "${learned.name}" (${learned.how})`,
      description: 'a recorded target resolved to another element during a replay',
      key: `${key}|${resolvedKey}`,
      data: { ...resolution, resolution: learned },
      createdAt: learned.firstSeenAt,
      updatedAt: learned.lastSeenAt,
      ...(learned.version ? { appVersion: learned.version } : {}),
      evidence: { successes: learned.successes, failures: learned.failures },
      location: file,
    }),
  );
}

function hypothesisItem(hypothesis: Hypothesis): Partial_<KnowledgeItem> {
  const confirmed = ['SUPPORTED', 'CONFIRMED', 'VERIFIED'].includes(hypothesis.status);
  const refuted = ['REFUTED', 'CONTRADICTED', 'REJECTED'].includes(hypothesis.status);
  return {
    type: 'HYPOTHESIS',
    origin: 'ANALYSIS',
    title: `${hypothesis.proposition.subject} ${hypothesis.proposition.relation} ${hypothesis.proposition.object}`,
    description: `${hypothesis.proposition.kind} hypothesis, status ${hypothesis.status}`,
    key: hypothesis.id,
    data: { ...hypothesis },
    createdAt: hypothesis.createdAt,
    updatedAt: hypothesis.updatedAt,
    ...(hypothesis.lastRuntimeVersion ? { appVersion: hypothesis.lastRuntimeVersion } : {}),
    evidence: {
      confirmations: hypothesis.evidenceFor.length,
      contradictions: hypothesis.evidenceAgainst.length,
    },
    hypothesis: !confirmed && !refuted,
    location: '',
  };
}

function invariantItem(invariant: DiscoveredInvariant): Partial_<KnowledgeItem> {
  return {
    type: 'INVARIANT',
    origin: 'ANALYSIS',
    title: invariant.statement,
    description: `discovered invariant (${invariant.template}), status ${invariant.status}`,
    key: invariant.id,
    data: { ...invariant },
    ...(invariant.counterexamples[invariant.counterexamples.length - 1]?.at
      ? { updatedAt: invariant.counterexamples[invariant.counterexamples.length - 1]?.at }
      : {}),
    evidence: {
      confirmations: invariant.observations,
      contradictions: invariant.counterexamples.length,
      runIds: invariant.runs,
    },
    location: '',
  };
}

function flowRunItem(name: string, run: FlowRunMemory): Partial_<KnowledgeItem> {
  return {
    type: 'FLOW_RUN',
    origin: 'REPLAY',
    title: `${name} · ${run.status} · ${String(run.steps.length)} step(s)`,
    description: 'the last replay of an imposed flow (status, durations, locators; never a value)',
    key: name,
    data: { name, ...run },
    updatedAt: run.at,
    evidence: {
      successes: run.status === 'PASSED' ? 1 : 0,
      failures: run.status === 'FAILED' || run.status === 'BLOCKED' ? 1 : 0,
      runIds: [run.runId],
    },
    location: '',
  };
}

/* ───────────────────────── connaissance fonctionnelle ───────────────────────── */

interface FunctionalFile {
  entries?: RememberedFunctional[];
  learned?: Partial<LearnedKnowledge>;
  fieldMappings?: RememberedFieldMapping[];
  intentDecisions?: RememberedIntentDecision[];
  intentPatterns?: RememberedIntentPattern[];
}

export async function readFunctionalFile(
  directory: string,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
): Promise<ReadResult & { mappings: RememberedFieldMapping[] }> {
  const file = functionalKnowledgeFile(directory, {
    application: identity.functionalApplication,
    ...(identity.environment ? { environment: identity.environment } : {}),
  });
  const warnings: ReaderWarning[] = [];
  let parsed: FunctionalFile | undefined;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as FunctionalFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      warnings.push({ location: file, message: error instanceof Error ? error.message : String(error) });
    return { items: [], warnings, mappings: [] };
  }
  const items: KnowledgeItem[] = [];
  const add = (partial: Partial_<KnowledgeItem>): void => {
    items.push(build('FUNCTIONAL_FILE', identity, options, { ...partial, location: file }));
  };
  for (const entry of parsed.entries ?? [])
    add({
      type: 'FUNCTIONAL',
      origin: 'NETWORK_LEARNING',
      title: `${entry.kind} · ${entry.id} · ${entry.status}`,
      description:
        'a functional fact (transition, workflow, invariant, error path, goal) remembered from runs',
      key: entry.id,
      data: { ...entry },
      ...(entry.lastSeenAt ? { updatedAt: entry.lastSeenAt } : {}),
      ...((entry.version ?? entry.commit) ? { appVersion: entry.version ?? entry.commit } : {}),
      evidence: { confirmations: entry.confirmations, contradictions: entry.failures },
      location: '',
    });
  for (const workflow of parsed.learned?.workflows ?? [])
    add({
      type: 'LEARNED_WORKFLOW',
      origin: workflow.provenance === 'HUMAN_RECORDED' ? 'RECORDING' : 'NETWORK_LEARNING',
      title: `${workflow.id} · ${workflow.api}`,
      description: 'a workflow learned from accepted writes on the network',
      key: `${workflow.id}|${workflow.api}`,
      data: { ...workflow },
      evidence: { seen: 1 },
      location: '',
    });
  for (const state of parsed.learned?.states ?? [])
    add({
      type: 'LEARNED_STATE',
      origin: 'NETWORK_LEARNING',
      title: `${state.entityType}.${state.stateField} = ${state.state}`,
      description: 'a business state read in responses',
      key: `${state.entityType}|${state.state}`,
      data: { ...state },
      evidence: { seen: 1 },
      location: '',
    });
  for (const transition of parsed.learned?.transitions ?? [])
    add({
      type: 'LEARNED_TRANSITION',
      origin: 'NETWORK_LEARNING',
      title: `${transition.entityType}: ${transition.from} → ${transition.to} (${transition.trigger})`,
      description: 'a business state transition learned from the network',
      key: `${transition.entityType}|${transition.from}|${transition.to}|${transition.trigger}`,
      data: { ...transition },
      evidence: { seen: 1 },
      location: '',
    });
  for (const mapping of parsed.fieldMappings ?? [])
    add({
      type: 'FIELD_MAPPING',
      origin: 'RECORDING',
      title: `"${mapping.uiLabel}" ↔ ${mapping.property} (${mapping.api})`,
      description: 'a screen field ↔ API property mapping validated by a recording',
      key: mapping.key,
      data: { ...mapping },
      updatedAt: mapping.lastSeenAt,
      evidence: { confirmations: mapping.confirmations },
      location: '',
    });
  for (const decision of parsed.intentDecisions ?? [])
    add({
      type: 'INTENT_DECISION',
      origin: 'HUMAN',
      title: `${decision.context.page ?? '?'} · ${decision.context.element ?? decision.context.label ?? '?'} → ${decision.intent} (${decision.status})`,
      description: 'a human decision on the intent of an action, kept with its context',
      key: decision.key,
      data: { ...decision },
      updatedAt: decision.lastSeenAt,
      evidence: { confirmations: decision.confirmations },
      location: '',
    });
  for (const pattern of parsed.intentPatterns ?? [])
    add({
      type: 'INTENT_PATTERN',
      origin: 'RECORDING',
      title: `${pattern.intent} (${pattern.generic})`,
      description: 'an intent pattern confirmed by recordings (a hint, never a rule)',
      key: pattern.key,
      data: { ...pattern },
      updatedAt: pattern.lastSeenAt,
      evidence: { confirmations: pattern.confirmations },
      location: '',
    });
  return { items, warnings, mappings: parsed.fieldMappings ?? [] };
}

/* ───────────────────────── règles ───────────────────────── */

export async function readRulesFile(
  directory: string,
  identity: ApplicationIdentity,
  options: ReliabilityOptions,
): Promise<ReadResult> {
  const file = ruleKnowledgeFile(directory, {
    application: identity.functionalApplication,
    ...(identity.environment ? { environment: identity.environment } : {}),
  });
  const warnings: ReaderWarning[] = [];
  let rules: RememberedRule[] = [];
  try {
    rules = (JSON.parse(await readFile(file, 'utf8')) as { rules?: RememberedRule[] }).rules ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      warnings.push({ location: file, message: error instanceof Error ? error.message : String(error) });
    return { items: [], warnings };
  }
  return {
    items: rules.map((rule) =>
      build('RULES_FILE', identity, options, {
        type: 'RULE',
        origin: 'STATIC_ANALYSIS',
        title: `${rule.name} · ${rule.status}`,
        description: `application rule (${rule.category}), coverage ${rule.coverage}`,
        key: rule.signature,
        data: { ...rule },
        ...(rule.lastVerifiedAt ? { updatedAt: rule.lastVerifiedAt } : {}),
        ...((rule.version ?? rule.commit) ? { appVersion: rule.version ?? rule.commit } : {}),
        evidence: { confirmations: rule.confirmations, contradictions: rule.contradictions },
        location: file,
      }),
    ),
    warnings,
  };
}

/** Les dossiers dérivés d'une mission, exactement comme le moteur les calcule. */
export function knowledgeDirectoriesOf(
  reportsDir: string,
  knowledgeFile: string,
): {
  knowledgeDir: string;
  functionalDir: string;
  rulesDir: string;
  recordingsDir: string;
} {
  const base = path.join(path.dirname(path.resolve(reportsDir)), 'knowledge');
  return {
    knowledgeDir: path.dirname(path.resolve(knowledgeFile)),
    functionalDir: path.join(base, 'functional'),
    rulesDir: path.join(base, 'rules'),
    recordingsDir: path.join(path.resolve(reportsDir), 'recordings'),
  };
}

export function originLabel(origin: KnowledgeOrigin): string {
  return origin.toLowerCase().replace(/_/g, ' ');
}
