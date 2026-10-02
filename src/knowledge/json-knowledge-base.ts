import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeConfig } from '../config/config.js';
import type { CognitiveKnowledge } from '../cognitive/cognitive-engine.js';
import { writeFileAtomic } from '../memory/atomic-write.js';
import { normalizeText } from '../policies/keywords.js';
import {
  KNOWLEDGE_SCHEMA_VERSION,
  type ActionKnowledge,
  type ActionResultInput,
  type ApiKnowledge,
  type HistoricalExpectation,
  type KnowledgeBase,
  type KnowledgeData,
  type KnowledgeIdentity,
  type LearnedHint,
  type ObservedKnowledgeContext,
  type PerformanceKnowledge,
  type RecoveryInput,
  type RecoveryKnowledge,
  type TransitionInput,
  type TransitionKnowledge,
} from './knowledge-model.js';
import { decayFactor } from './statistics.js';

/** Une ligne d'historique préchargée (même forme que transition_knowledge de la persistance). */
export interface HistoricalTransitionRecord {
  fromStateSignature: string;
  actionSignature: string;
  toStateSignature: string;
  successCount: number;
  failureCount: number;
  blockedCount: number;
  averageDurationMs?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastContext?: ObservedKnowledgeContext;
}

/** Destination d'une transition sans nouvel état (bloquée, échouée) dans l'historique. */
export const NO_HISTORY_TARGET = '(none)';

/** Durées gardées par clé (les plus récentes). */
const MAX_DURATIONS = 50;

export interface KnowledgeOptions {
  halfLifeDays: number;
  minObservations: number;
  dominance: number;
  now?: () => Date;
}

/** Le fichier : une entrée par application + environnement, jamais mélangées. */
interface KnowledgeFile {
  schemaVersion: number;
  applications: Record<string, KnowledgeData>;
}

/**
 * KnowledgeBase dans un fichier JSON versionné (écriture atomique). Une entrée par
 * application et environnement ; l'historique n'est jamais supprimé parce qu'il est
 * vieux : il compte moins (demi-vie). Aucune valeur saisie, aucun corps de requête,
 * aucun en-tête n'y entre — seulement des signatures, des compteurs et des durées.
 */
export class JsonKnowledgeBase implements KnowledgeBase {
  private file: KnowledgeFile = { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, applications: {} };
  private data: KnowledgeData;
  private readonly now: () => Date;

  constructor(
    private readonly location: string | undefined,
    readonly identity: KnowledgeIdentity,
    private readonly options: KnowledgeOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.data = emptyData(identity, this.stamp());
  }

  /** Base en mémoire seulement (tests, knowledge.enabled: false). */
  static inMemory(
    identity: Partial<KnowledgeIdentity> = {},
    options: Partial<KnowledgeOptions> = {},
  ): JsonKnowledgeBase {
    return new JsonKnowledgeBase(
      undefined,
      { application: 'app', schemaVersion: KNOWLEDGE_SCHEMA_VERSION, ...identity },
      { halfLifeDays: 30, minObservations: 3, dominance: 0.8, ...options },
    );
  }

  async load(): Promise<void> {
    if (!this.location) return;
    let text: string;
    try {
      text = await readFile(this.location, 'utf8');
    } catch {
      return; // premier run
    }
    const migrated = migrateKnowledge(JSON.parse(text) as unknown);
    if (!migrated) return; // format inconnu (plus récent) : on repart de zéro sans l'écraser tant qu'on n'a rien appris
    this.file = migrated;
    const existing = this.file.applications[keyOf(this.identity)];
    if (existing) this.data = { ...existing, identity: { ...existing.identity, ...this.identity } };
  }

  async save(): Promise<void> {
    if (!this.location) return;
    this.data.updatedAt = this.stamp();
    this.file.applications[keyOf(this.identity)] = this.data;
    this.file.schemaVersion = KNOWLEDGE_SCHEMA_VERSION;
    await mkdir(path.dirname(this.location), { recursive: true });
    await writeFileAtomic(this.location, `${JSON.stringify(this.file, null, 2)}\n`);
  }

  /** Un run de plus. */
  startRun(): void {
    this.data.runs += 1;
  }

  get snapshot(): Readonly<KnowledgeData> {
    return this.data;
  }

  /**
   * Ajoute à la mémoire de travail l'historique préchargé depuis la persistance (une ligne
   * par destination). Les transitions réussies donnent les cibles connues ; succès, échecs,
   * blocages et durées donnent les statistiques des actions. Rien n'est écrit ailleurs.
   */
  importHistory(records: readonly HistoricalTransitionRecord[]): void {
    for (const record of records) {
      if (record.successCount > 0 && record.toStateSignature !== NO_HISTORY_TARGET) {
        const key = `${record.fromStateSignature}::${record.actionSignature}`;
        const entry = (this.data.transitions[key] ??= {
          fromStateSignature: record.fromStateSignature,
          actionSignature: record.actionSignature,
          targets: {},
          executionCount: 0,
          successCount: 0,
          failureCount: 0,
          firstSeenAt: record.firstSeenAt,
          lastSeenAt: record.lastSeenAt,
        });
        entry.targets[record.toStateSignature] =
          (entry.targets[record.toStateSignature] ?? 0) + record.successCount;
        entry.executionCount += record.successCount;
        entry.successCount += record.successCount;
        if (record.firstSeenAt < entry.firstSeenAt) entry.firstSeenAt = record.firstSeenAt;
        if (record.lastSeenAt >= entry.lastSeenAt) {
          entry.lastSeenAt = record.lastSeenAt;
          if (record.lastContext) entry.lastContext = { ...record.lastContext };
        }
      }
      const action = (this.data.actions[record.actionSignature] ??= {
        actionSignature: record.actionSignature,
        seenCount: 0,
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        blockedCount: 0,
        weightedSuccess: 0,
        weightedFailure: 0,
      });
      const executed = record.successCount + record.failureCount;
      if (record.averageDurationMs !== undefined && executed > 0)
        action.averageDurationMs = Math.round(
          ((action.averageDurationMs ?? 0) * action.executionCount + record.averageDurationMs * executed) /
            (action.executionCount + executed),
        );
      action.executionCount += executed;
      action.successCount += record.successCount;
      action.failureCount += record.failureCount;
      action.blockedCount += record.blockedCount;
      action.weightedSuccess = (action.weightedSuccess ?? 0) + record.successCount;
      action.weightedFailure = (action.weightedFailure ?? 0) + record.failureCount;
      if (!action.lastExecutedAt || record.lastSeenAt > action.lastExecutedAt)
        action.lastExecutedAt = record.lastSeenAt;
      if (!action.lastSeenAt || record.lastSeenAt > action.lastSeenAt) action.lastSeenAt = record.lastSeenAt;
    }
  }

  getActionKnowledge(actionSignature: string): ActionKnowledge | undefined {
    return this.data.actions[actionSignature];
  }

  getTransitionKnowledge(
    fromStateSignature: string,
    actionSignature: string,
  ): TransitionKnowledge | undefined {
    return this.data.transitions[`${fromStateSignature}::${actionSignature}`];
  }

  recordActionResult(input: ActionResultInput): void {
    const at = input.at ?? this.stamp();
    const entry = (this.data.actions[input.actionSignature] ??= {
      actionSignature: input.actionSignature,
      seenCount: 0,
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
      blockedCount: 0,
      weightedSuccess: 0,
      weightedFailure: 0,
    });
    entry.lastSeenAt = at;
    if (input.result === 'SEEN') {
      entry.seenCount += 1;
      return;
    }
    if (input.result === 'BLOCKED') {
      entry.blockedCount += 1;
      return;
    }
    // Décroissance appliquée avant d'ajouter : le récent compte plus que l'ancien.
    const decay = decayFactor(entry.lastExecutedAt, at, this.options.halfLifeDays);
    entry.weightedSuccess = (entry.weightedSuccess ?? 0) * decay;
    entry.weightedFailure = (entry.weightedFailure ?? 0) * decay;
    entry.executionCount += 1;
    entry.lastExecutedAt = at;
    if (input.durationMs !== undefined) {
      const previous = entry.averageDurationMs ?? input.durationMs;
      entry.averageDurationMs = Math.round(previous + (input.durationMs - previous) / entry.executionCount);
    }
    const version = this.version();
    if (input.result === 'SUCCESS') {
      entry.successCount += 1;
      entry.weightedSuccess += 1;
      entry.failuresOnVersion = 0;
    } else {
      entry.failureCount += 1;
      entry.weightedFailure += 1;
      entry.failuresOnVersion = entry.failureVersion === version ? (entry.failuresOnVersion ?? 0) + 1 : 1;
      entry.failureVersion = version;
    }
  }

  /** Contexte des observations de ce run (stampé sur chaque transition enregistrée). */
  private observationContext: ObservedKnowledgeContext | undefined;

  setObservationContext(context: ObservedKnowledgeContext | undefined): void {
    this.observationContext = context;
  }

  recordTransition(input: TransitionInput): void {
    const at = input.at ?? this.stamp();
    const key = `${input.fromStateSignature}::${input.actionSignature}`;
    const entry = (this.data.transitions[key] ??= {
      fromStateSignature: input.fromStateSignature,
      actionSignature: input.actionSignature,
      targets: {},
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
      firstSeenAt: at,
      lastSeenAt: at,
    });
    entry.executionCount += 1;
    if (input.success) entry.successCount += 1;
    else entry.failureCount += 1;
    entry.targets[input.toStateSignature] = (entry.targets[input.toStateSignature] ?? 0) + 1;
    entry.lastSeenAt = at;
    if (this.observationContext) entry.lastContext = { ...this.observationContext };
  }

  recordApiCall(operation: string, status: number, durationMs?: number, at = this.stamp()): void {
    const entry = (this.data.api[operation] ??= { operation, statuses: {}, durations: [], lastSeenAt: at });
    entry.statuses[String(status)] = (entry.statuses[String(status)] ?? 0) + 1;
    if (durationMs !== undefined) pushDuration(entry.durations, durationMs);
    entry.lastSeenAt = at;
  }

  getApiKnowledge(operation: string): ApiKnowledge | undefined {
    return this.data.api[operation];
  }

  recordDuration(
    kind: PerformanceKnowledge['kind'],
    key: string,
    durationMs: number,
    at = this.stamp(),
  ): void {
    const entry = (this.data.performance[`${kind}:${key}`] ??= { key, kind, durations: [], lastSeenAt: at });
    pushDuration(entry.durations, durationMs);
    entry.lastSeenAt = at;
  }

  getPerformance(kind: PerformanceKnowledge['kind'], key: string): PerformanceKnowledge | undefined {
    return this.data.performance[`${kind}:${key}`];
  }

  recordRecovery(input: RecoveryInput): void {
    const at = input.at ?? this.stamp();
    const recoveries = (this.data.recoveries ??= {});
    const entry = (recoveries[input.key] ??= {
      key: input.key,
      actionSignature: input.actionSignature,
      goal: input.goal,
      ...(input.route ? { route: input.route } : {}),
      ...(input.workflow ? { workflow: input.workflow } : {}),
      originalTarget: input.originalTarget,
      paths: {},
    });
    const signature = input.actions
      .map((action) => `${action.kind} ${action.role}:${action.name}`)
      .join(' → ');
    const path = (entry.paths[signature] ??= {
      actions: input.actions.map((action) => ({ kind: action.kind, role: action.role, name: action.name })),
      successes: 0,
      failures: 0,
      firstSeenAt: at,
      lastSeenAt: at,
    });
    if (input.result === 'SUCCESS') {
      path.successes += 1;
      path.lastSuccessAt = at;
    } else path.failures += 1;
    path.lastSeenAt = at;
    if (input.version) path.version = input.version;
    if (input.context) path.context = input.context;
  }

  recoveryKnowledge(key: string): RecoveryKnowledge | undefined {
    return this.data.recoveries?.[key];
  }

  cognitiveKnowledge(): CognitiveKnowledge | undefined {
    return this.data.cognitive;
  }

  saveCognitiveKnowledge(knowledge: CognitiveKnowledge): void {
    this.data.cognitive = knowledge;
  }

  recordOutcomePatterns(label: string, patterns: readonly string[]): void {
    const normalized = normalizeText(label);
    if (!normalized) return;
    const totalKey = `${normalized}|*`;
    const total = (this.data.hints[totalKey] ??= { label: normalized, pattern: '*', count: 0, total: 0 });
    total.count += 1;
    for (const pattern of new Set(patterns)) {
      const entry = (this.data.hints[`${normalized}|${pattern}`] ??= {
        label: normalized,
        pattern,
        count: 0,
        total: 0,
      });
      entry.count += 1;
    }
    for (const entry of Object.values(this.data.hints))
      if (entry.label === normalized) entry.total = total.count;
  }

  /**
   * « Ajouter » a mené 12 fois sur 13 à un CREATE_FORM : un indice historique (au moins
   * 3 observations, 60 % des cas). Jamais transformé en règle de sécurité.
   */
  hintFor(label: string): LearnedHint | undefined {
    const normalized = normalizeText(label);
    const candidates = Object.values(this.data.hints).filter(
      (entry) =>
        entry.label === normalized &&
        entry.pattern !== '*' &&
        entry.count >= 3 &&
        entry.count / entry.total >= 0.6,
    );
    return candidates.sort((a, b) => b.count - a.count)[0];
  }

  /**
   * ATTENTE HISTORIQUE (et non métier) : la cible qu'une transition a atteinte le plus
   * souvent, quand l'historique est assez fourni (minObservations) et assez net (dominance).
   */
  expectationFor(fromStateSignature: string, actionSignature: string): HistoricalExpectation | undefined {
    const entry = this.getTransitionKnowledge(fromStateSignature, actionSignature);
    if (!entry || entry.executionCount < this.options.minObservations) return undefined;
    const total = Object.values(entry.targets).reduce((sum, count) => sum + count, 0);
    const [target, count] = Object.entries(entry.targets).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!target || count === undefined || total === 0) return undefined;
    const share = count / total;
    if (share < this.options.dominance) return undefined;
    // Plus d'observations et une cible plus nette → plus de confiance (jamais 1 : c'est de l'historique).
    const confidence = Math.min(0.9, share * Math.min(1, total / 10) + 0.1);
    return {
      target,
      share: Math.round(share * 100) / 100,
      observations: total,
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  transitions(): readonly TransitionKnowledge[] {
    return Object.values(this.data.transitions);
  }

  actionsLeadingTo(predicate: (stateSignature: string) => boolean): string[] {
    return (
      Object.values(this.data.transitions)
        // Les résolutions sémantiques (« intent:… ») ne sont pas des actions de l'écran.
        .filter((entry) => !entry.actionSignature.startsWith('intent:'))
        .filter((entry) => Object.keys(entry.targets).some(predicate))
        .sort((a, b) => b.successCount - a.successCount)
        .map((entry) => entry.actionSignature)
    );
  }

  /** La version de l'application testée : commit, sinon version, sinon « unversioned ». */
  version(): string {
    return this.identity.commit ?? this.identity.appVersion ?? 'unversioned';
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}

function pushDuration(durations: number[], value: number): void {
  durations.push(Math.round(value));
  if (durations.length > MAX_DURATIONS) durations.splice(0, durations.length - MAX_DURATIONS);
}

function emptyData(identity: KnowledgeIdentity, at: string): KnowledgeData {
  return {
    identity,
    updatedAt: at,
    runs: 0,
    actions: {},
    transitions: {},
    api: {},
    performance: {},
    hints: {},
  };
}

function keyOf(identity: KnowledgeIdentity): string {
  return [identity.application, identity.environment ?? 'default'].join('@');
}

/**
 * Migre un fichier lu vers le format courant. Un format plus récent que ce crawler
 * n'est pas compris : undefined (le fichier n'est pas touché tant que rien n'est appris).
 */
export function migrateKnowledge(raw: unknown): KnowledgeFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const file = raw as Partial<KnowledgeFile> & Partial<KnowledgeData>;
  const version = typeof file.schemaVersion === 'number' ? file.schemaVersion : 0;
  if (version > KNOWLEDGE_SCHEMA_VERSION) return undefined;
  if (version === 0) {
    // v0 : une seule application à la racine du fichier.
    if (!file.identity) return { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, applications: {} };
    const data = raw as KnowledgeData;
    return {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      applications: {
        [keyOf(data.identity)]: {
          ...emptyData(data.identity, data.updatedAt),
          ...data,
          identity: { ...data.identity, schemaVersion: KNOWLEDGE_SCHEMA_VERSION },
        },
      },
    };
  }
  return { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, applications: file.applications ?? {} };
}

/** Le fichier de la base : knowledge.file, sinon knowledge/knowledge-base.json à côté du dossier des rapports. */
export function knowledgeFileOf(config: {
  knowledge: KnowledgeConfig;
  output: { reportsDir: string };
}): string {
  return (
    config.knowledge.file ??
    path.join(path.dirname(path.resolve(config.output.reportsDir)), 'knowledge', 'knowledge-base.json')
  );
}

/** L'identité de l'application testée : la mission, sinon l'environnement de CI. */
export function knowledgeIdentityOf(
  config: KnowledgeConfig,
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  crawlerVersion?: string,
): KnowledgeIdentity {
  const optional = {
    environment: config.environment ?? env.QA_ENVIRONMENT,
    branch: config.branch ?? env.GITHUB_REF_NAME ?? env.CI_COMMIT_BRANCH ?? env.GIT_BRANCH,
    commit: config.commit ?? env.QA_APP_COMMIT ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? env.GIT_COMMIT,
    appVersion: config.appVersion ?? env.QA_APP_VERSION,
    crawlerVersion,
  };
  const identity: KnowledgeIdentity = {
    application: config.application ?? new URL(baseUrl).host,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
  };
  for (const [key, value] of Object.entries(optional))
    if (value) (identity as unknown as Record<string, string>)[key] = value;
  return identity;
}
