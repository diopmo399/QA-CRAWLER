import type { RememberedFieldMapping } from '../knowledge/functional-knowledge-store.js';
import { NO_TARGET, type CrawlRunRecord, type RunTransitionRecord } from '../persistence/model.js';
import type { KnowledgeCenterContext } from './context.js';
import type {
  ActivityEntry,
  ApplicationSummary,
  FlowsDto,
  GraphDto,
  HistoryDto,
  KnowledgeItem,
  LedgerEntry,
  MemoryStateDto,
  Metric,
  OverviewDto,
  Page,
  PersistenceStateDto,
  QualityDto,
  ReliabilityStatus,
  ReviewDecision,
  RunSummary,
  SearchQuery,
  StateSummary,
  TransitionSummary,
  VariablesDto,
} from './model.js';
import { KNOWLEDGE_ORIGINS, KNOWLEDGE_TYPES, RELIABILITY_STATUSES } from './model.js';
import { readRecordings, recordingFlowSummary, variablesOf, type LoadedRecording } from './recordings.js';
import type { ReliabilityOptions } from './reliability.js';
import type { DecisionInput } from './review-ledger.js';
import {
  knowledgeFileApplications,
  readFunctionalFile,
  readKnowledgeFile,
  readKnowledgeFileRaw,
  readPersistence,
  readRulesFile,
  type ApplicationIdentity,
  type ReaderWarning,
} from './sources.js';

/**
 * LE SERVICE APPLICATIF DU KNOWLEDGE CENTER : consultation et gestion, au-dessus des lecteurs
 * (sources.ts), de la persistance réelle et du registre de revue. Aucun SQL, aucune valeur inventée :
 * ce qui n'est pas disponible est rendu « non disponible » avec la raison.
 *
 * Les connaissances d'une application sont lues à la demande, gardées quelques secondes en mémoire
 * du serveur (jamais envoyées en bloc au navigateur : recherche, critères et pages sont côté serveur).
 */
const CACHE_TTL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const RECENT_RUNS = 20;

interface Loaded {
  at: number;
  identity: ApplicationIdentity;
  items: KnowledgeItem[];
  warnings: ReaderWarning[];
  mappings: RememberedFieldMapping[];
}

export class KnowledgeNotFoundError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'KnowledgeNotFoundError';
  }
}

export class ReadOnlyError extends Error {
  constructor() {
    super('the Knowledge Center runs read-only: no decision, import or restore is possible');
    this.name = 'ReadOnlyError';
  }
}

export class KnowledgeCenterService {
  private readonly cache = new Map<string, Loaded>();
  private recordings?: { at: number; recordings: LoadedRecording[]; warnings: ReaderWarning[] };
  private readonly started = new Date().toISOString();

  constructor(readonly context: KnowledgeCenterContext) {}

  private get reliability(): ReliabilityOptions {
    return {
      minObservations: this.context.config.knowledge.minObservations,
      staleAfterDays: this.context.options.staleAfterDays,
      now: this.context.now(),
    };
  }

  /** Oublie ce qui est en cache : la prochaine lecture relit le stockage. */
  refresh(): void {
    this.cache.clear();
    this.recordings = undefined;
  }

  /* ───────────────────────── applications ───────────────────────── */

  async applications(): Promise<ApplicationSummary[]> {
    const byId = new Map<string, ApplicationSummary>();
    const add = (
      id: string,
      application: string,
      environment: string | undefined,
      source: ApplicationSummary['sources'][number],
    ): void => {
      const found = byId.get(id);
      if (found) {
        if (!found.sources.includes(source)) found.sources.push(source);
        return;
      }
      byId.set(id, {
        id,
        application,
        ...(environment ? { environment } : {}),
        sources: [source],
        current: id === this.context.current.applicationId,
      });
    };
    const { current } = this.context;
    byId.set(current.applicationId, {
      id: current.applicationId,
      application: current.application,
      ...(current.environment ? { environment: current.environment } : {}),
      sources: [],
      current: true,
    });
    const provider = this.context.persistence.provider;
    if (provider?.inventory)
      for (const inventory of await provider.inventory.applications().catch(() => []))
        add(inventory.applicationId, ...splitApplicationId(inventory.applicationId), 'PERSISTENCE');
    try {
      const content = await readKnowledgeFileRaw(this.context.knowledgeFile);
      if (content)
        for (const found of knowledgeFileApplications(content))
          add(
            found.environment ? `${found.application}@${found.environment}` : found.application,
            found.application,
            found.environment,
            'KNOWLEDGE_FILE',
          );
    } catch {
      // un fichier illisible est rapporté par le lecteur de l'application
    }
    return [...byId.values()].sort(
      (a, b) => Number(b.current) - Number(a.current) || a.id.localeCompare(b.id),
    );
  }

  private identityOf(applicationId: string): ApplicationIdentity {
    if (applicationId === this.context.current.applicationId) return this.context.current;
    const [application, environment] = splitApplicationId(applicationId);
    return {
      applicationId,
      application,
      ...(environment ? { environment } : {}),
      functionalApplication: application,
    };
  }

  /* ───────────────────────── lecture ───────────────────────── */

  async load(applicationId: string): Promise<Loaded> {
    const cached = this.cache.get(applicationId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
    const identity = this.identityOf(applicationId);
    const options = this.reliability;
    const { limit } = this.context.options;
    const provider = this.context.persistence.provider;
    const results = await Promise.all([
      provider ? readPersistence(provider, identity, options, limit) : { items: [], warnings: [] },
      readKnowledgeFile(this.context.knowledgeFile, identity, options),
      readFunctionalFile(this.context.functionalDir, identity, options),
      readRulesFile(this.context.rulesDir, identity, options),
    ]);
    const decisions = await this.context.ledger.decisions();
    const items = results
      .flatMap((result) => result.items)
      .map((item) => {
        const review = decisions.get(item.id);
        return review ? { ...item, review } : item;
      });
    const loaded: Loaded = {
      at: Date.now(),
      identity,
      items,
      warnings: results.flatMap((result) => result.warnings),
      mappings: results[2].mappings,
    };
    this.cache.set(applicationId, loaded);
    return loaded;
  }

  private async loadRecordings(): Promise<{ recordings: LoadedRecording[]; warnings: ReaderWarning[] }> {
    if (this.recordings && Date.now() - this.recordings.at < CACHE_TTL_MS) return this.recordings;
    const read = await readRecordings(this.context.recordingsDir);
    this.recordings = { at: Date.now(), ...read };
    return this.recordings;
  }

  private async runs(applicationId: string, limit = RECENT_RUNS): Promise<CrawlRunRecord[]> {
    const provider = this.context.persistence.provider;
    if (!provider) return [];
    return provider.runs.list(applicationId, limit).catch(() => []);
  }

  /* ───────────────────────── vue d'ensemble ───────────────────────── */

  async overview(applicationId: string): Promise<OverviewDto & { warnings: ReaderWarning[] }> {
    const loaded = await this.load(applicationId);
    const { items } = loaded;
    const applications = await this.applications();
    const application = applications.find((candidate) => candidate.id === applicationId) ?? {
      id: applicationId,
      application: loaded.identity.application,
      ...(loaded.identity.environment ? { environment: loaded.identity.environment } : {}),
      sources: [],
      current: applicationId === this.context.current.applicationId,
    };
    const provider = this.context.persistence.provider;
    const inventory = provider?.inventory
      ? (await provider.inventory.applications().catch(() => [])).find(
          (entry) => entry.applicationId === applicationId,
        )
      : undefined;
    const transitions = items.filter((item) => item.type === 'TRANSITION');
    const states = new Set<string>();
    for (const item of transitions) {
      const from = item.data.fromStateSignature;
      const to = item.data.toStateSignature;
      if (typeof from === 'string') states.add(from);
      if (typeof to === 'string' && to !== NO_TARGET) states.add(to);
    }
    const { recordings } = await this.loadRecordings();
    const flowNames = new Set([
      ...recordings.map((recording) => recording.flow.name || recording.name),
      ...items.filter((item) => item.type === 'FLOW_RUN').map((item) => item.key),
    ]);
    const validated = items.filter((item) => item.review?.status === 'VALIDATED').length;
    const invalidated = items.filter((item) => item.review?.status === 'INVALIDATED').length;
    const toVerify = items.filter(
      (item) =>
        !item.review &&
        ['FRAGILE', 'CONTRADICTED', 'HYPOTHESIS', 'UNVERIFIED'].includes(item.reliability.status),
    ).length;
    const stale = items.filter((item) => item.reliability.status === 'STALE').length;
    const reused = transitions.filter((item) => (item.evidence.seen ?? 0) >= 2).length;
    const lastPersisted = latest(
      items.filter((item) => item.source === 'PERSISTENCE').map((item) => item.updatedAt),
    );
    const lastLearning = latest(items.map((item) => item.updatedAt ?? item.createdAt));
    const ledger = await this.context.ledger.entries();
    const metrics: Record<string, Metric> = {
      total: {
        value: items.length,
        formula:
          'every knowledge row read: persistence tables + knowledge file + functional file + rules file',
      },
      flows: {
        value: flowNames.size,
        formula: 'distinct flow names: recordings + flows replayed (flow run memory)',
      },
      states: {
        value: states.size,
        formula: 'distinct screen signatures appearing in transition knowledge (from and to)',
      },
      transitions: {
        value: transitions.length,
        formula: 'transition knowledge rows (persistence + knowledge file)',
      },
      validated: { value: validated, formula: 'rows with a human decision VALIDATED in the review ledger' },
      invalidated: {
        value: invalidated,
        formula: 'rows with a human decision INVALIDATED in the review ledger',
      },
      toVerify: {
        value: toVerify,
        formula: 'rows FRAGILE, CONTRADICTED, HYPOTHESIS or UNVERIFIED without a human decision',
      },
      stale: {
        value: stale,
        formula: `rows not seen for more than ${String(this.context.options.staleAfterDays)} days`,
      },
      runs: inventory
        ? {
            value: inventory.counts.runs,
            formula: 'rows of crawl_run for this application (provider inventory)',
          }
        : {
            unavailable: true,
            reason: provider ? 'the persistence provider has no inventory' : 'persistence is disabled',
          },
      runsUsingKnowledge: {
        unavailable: true,
        reason:
          'the persistence does not record whether a run preloaded the history; each run reports it in its result.json (persistence.memory.mode)',
      },
      reuseRate: {
        value: transitions.length === 0 ? 0 : Math.round((reused / transitions.length) * 1000) / 10,
        formula: 'transitions seen at least twice / all transitions, in percent',
      },
      lastSave: lastPersisted
        ? { value: lastPersisted, formula: 'most recent lastSeenAt among persisted rows' }
        : {
            unavailable: true,
            reason: provider ? 'no persisted row for this application' : 'persistence is disabled',
          },
      lastLearning: lastLearning
        ? { value: lastLearning, formula: 'most recent updatedAt (or createdAt) among all rows' }
        : { unavailable: true, reason: 'no knowledge row' },
    };
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const item of items) {
      byType[item.type] = (byType[item.type] ?? 0) + 1;
      byStatus[item.reliability.status] = (byStatus[item.reliability.status] ?? 0) + 1;
    }
    const runs = (await this.runs(applicationId, 10)).map(runSummary);
    const entry = (item: KnowledgeItem): ActivityEntry => ({
      id: item.id,
      ...((item.updatedAt ?? item.createdAt) ? { at: item.updatedAt ?? item.createdAt } : {}),
      type: item.type,
      title: item.title,
      status: item.reliability.status,
    });
    const byDate = (a: KnowledgeItem, b: KnowledgeItem): number =>
      (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
    const failedResolutions = items
      .filter(
        (item) => ['TARGET_RESOLUTION', 'RECOVERY'].includes(item.type) && (item.evidence.failures ?? 0) > 0,
      )
      .sort(byDate);
    const errorEntries = ledger.filter((item) => item.errors && item.errors.length > 0);
    return {
      application,
      memory: this.memoryState(),
      metrics,
      byType,
      byStatus,
      activity: {
        recent: [...items].sort(byDate).slice(0, 10).map(entry),
        runs,
        transitions: transitions
          .filter((item) => item.createdAt)
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
          .slice(0, 10)
          .map(entry),
        reused: transitions
          .filter((item) => (item.evidence.seen ?? 0) >= 2)
          .sort(byDate)
          .slice(0, 10)
          .map((item) => ({ ...entry(item), detail: `seen ${String(item.evidence.seen)} times` })),
        resolutionFailures: failedResolutions.slice(0, 10).map((item) => ({
          ...entry(item),
          detail: `${String(item.evidence.failures)} failure(s), ${String(item.evidence.successes ?? 0)} success(es)`,
        })),
        persistenceErrors:
          errorEntries.length > 0
            ? {
                value: errorEntries.length,
                formula:
                  'ledger operations (import, restore) that reported errors; run write errors are in each run report',
              }
            : {
                unavailable: true,
                reason:
                  'write errors of a run are reported in its result.json (persistence.writeErrors), not persisted',
              },
        attention: items
          .filter(
            (item) =>
              item.reliability.status === 'CONTRADICTED' ||
              (item.type === 'ANOMALY' && ['NEW', 'REOPENED', 'FLAKY'].includes(String(item.data.status))),
          )
          .sort(byDate)
          .slice(0, 10)
          .map((item) => ({ ...entry(item), detail: item.reliability.reasons.join('; ') })),
      },
      warnings: loaded.warnings,
    };
  }

  memoryState(): MemoryStateDto {
    const { config } = this.context;
    return {
      mode: this.context.memoryMode,
      memoryEnabled: config.memory.enabled,
      historicalKnowledge: config.memory.historicalKnowledge,
      preload: { ...config.memory.preload },
      knowledgeFile: this.context.knowledgeFile,
      knowledgeFileEnabled: config.knowledge.enabled && this.context.memoryMode === 'legacy',
      persistence: this.persistenceStateSync(),
    };
  }

  private persistenceStateSync(): PersistenceStateDto {
    const { status } = this.context.persistence;
    return {
      enabled: status.enabled,
      status: status.status,
      ...(status.configured ? { configured: status.configured } : {}),
      ...(status.actual ? { actual: status.actual } : {}),
      ...(status.reason ? { reason: status.reason } : {}),
      ...(status.latencyMs !== undefined ? { latencyMs: status.latencyMs } : {}),
      ...(status.schemaVersion !== undefined ? { schemaVersion: status.schemaVersion } : {}),
      providers: PROVIDERS,
      recentErrors: [],
      readOnly: this.context.options.readOnly,
    };
  }

  /** L'état de la persistance, avec une vérification de santé faite maintenant et les comptages. */
  async persistence(applicationId: string): Promise<PersistenceStateDto> {
    const state = this.persistenceStateSync();
    const provider = this.context.persistence.provider;
    if (provider) {
      const checkedAt = this.context.now().toISOString();
      try {
        const health = await provider.healthCheck();
        state.health = {
          status: health.status,
          ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
          ...(health.detail ? { detail: health.detail } : {}),
          checkedAt,
        };
        if (health.status !== 'CONNECTED') state.status = 'UNAVAILABLE';
      } catch (error) {
        state.health = {
          status: 'UNAVAILABLE',
          detail: error instanceof Error ? error.message : String(error),
          checkedAt,
        };
        state.status = 'UNAVAILABLE';
      }
      if (provider.inventory) {
        const inventory = (await provider.inventory.applications().catch(() => [])).find(
          (entry) => entry.applicationId === applicationId,
        );
        if (inventory) {
          state.counts = { ...inventory.counts };
          if (inventory.lastSeenAt) state.lastWriteAt = inventory.lastSeenAt;
        }
      }
    }
    const ledger = await this.context.ledger.entries();
    const backup = ledger.find((entry) => entry.operation === 'BACKUP' && !entry.errors);
    const restore = ledger.find((entry) => entry.operation === 'RESTORE');
    if (backup) state.lastBackupAt = backup.at;
    if (restore) state.lastRestoreAt = restore.at;
    state.recentErrors = ledger
      .filter((entry) => entry.errors && entry.errors.length > 0)
      .slice(0, 10)
      .flatMap((entry) =>
        (entry.errors ?? []).map((message) => ({ at: entry.at, operation: entry.operation, message })),
      );
    for (const warning of this.context.warnings)
      state.recentErrors.push({ at: this.started, operation: 'OPEN', message: warning });
    return state;
  }

  /* ───────────────────────── explorateur ───────────────────────── */

  async search(applicationId: string, query: SearchQuery): Promise<Page<KnowledgeItem>> {
    const { items } = await this.load(applicationId);
    const text = query.text?.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (query.type && item.type !== query.type) return false;
      if (query.status && item.reliability.status !== query.status) return false;
      if (query.origin && item.origin !== query.origin) return false;
      if (query.source && item.source !== query.source) return false;
      if (query.review === 'NONE' && item.review) return false;
      if (
        (query.review === 'VALIDATED' || query.review === 'INVALIDATED') &&
        item.review?.status !== query.review
      )
        return false;
      if (text) {
        const haystack =
          `${item.title}\n${item.key}\n${item.description ?? ''}\n${item.type}\n${item.id}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
    const direction = query.direction === 'asc' ? 1 : -1;
    const sort = query.sort ?? 'updatedAt';
    filtered.sort((a, b) => {
      const value = (item: KnowledgeItem): string | number => {
        switch (sort) {
          case 'title':
            return item.title.toLowerCase();
          case 'type':
            return item.type;
          case 'status':
            return RELIABILITY_STATUSES.indexOf(item.reliability.status);
          case 'evidence':
            return (
              (item.evidence.seen ?? 0) +
              (item.evidence.successes ?? 0) +
              (item.evidence.failures ?? 0) +
              (item.evidence.confirmations ?? 0)
            );
          case 'createdAt':
            return item.createdAt ?? '';
          default:
            return item.updatedAt ?? item.createdAt ?? '';
        }
      };
      const left = value(a);
      const right = value(b);
      const compared =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      return compared * direction || a.id.localeCompare(b.id);
    });
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(pages, Math.max(1, query.page ?? 1));
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      pages,
    };
  }

  /** Une connaissance et sa provenance : les runs qui l'ont observée (transitions des derniers runs). */
  async item(
    applicationId: string,
    id: string,
  ): Promise<{
    item: KnowledgeItem;
    history: LedgerEntry[];
    executions: ExecutionEvidence[];
    executionsNote?: string;
  }> {
    const { items } = await this.load(applicationId);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new KnowledgeNotFoundError(`unknown knowledge ${id}`);
    const history = (await this.context.ledger.entries()).filter((entry) => entry.itemId === id);
    const executions = await this.executionsOf(applicationId, item);
    return {
      item,
      history,
      executions: executions.evidence,
      ...(executions.note ? { executionsNote: executions.note } : {}),
    };
  }

  /** Les exécutions des derniers runs qui concernent une transition (confirmées / contredites), lues dans run_transition. */
  private async executionsOf(
    applicationId: string,
    item: KnowledgeItem,
  ): Promise<{ evidence: ExecutionEvidence[]; note?: string }> {
    const provider = this.context.persistence.provider;
    if (!provider) return { evidence: [], note: 'persistence is disabled: no run to cross-check' };
    if (item.type !== 'TRANSITION' && item.type !== 'ACTION')
      return {
        evidence: [],
        note: 'only transitions and actions are cross-checked against the persisted runs',
      };
    const action = typeof item.data.actionSignature === 'string' ? item.data.actionSignature : undefined;
    if (!action) return { evidence: [] };
    const from = typeof item.data.fromStateSignature === 'string' ? item.data.fromStateSignature : undefined;
    const evidence: ExecutionEvidence[] = [];
    for (const run of await this.runs(applicationId)) {
      let transitions: RunTransitionRecord[];
      try {
        transitions = await provider.transitions.listByRun(run.id);
      } catch {
        continue;
      }
      const matching = transitions.filter((transition) => transition.actionSignature === action);
      if (matching.length === 0) continue;
      const states = from ? await provider.states.listByRun(run.id).catch(() => []) : [];
      const signatures = new Map(states.map((state) => [state.stateId, state.stateSignature]));
      for (const transition of matching) {
        if (from && signatures.size > 0 && signatures.get(transition.fromStateId) !== from) continue;
        evidence.push({
          runId: run.id,
          missionName: run.missionName,
          runStatus: run.status,
          at: transition.finishedAt,
          status: transition.status,
          ...(transition.oracleStatus ? { oracleStatus: transition.oracleStatus } : {}),
          ...(transition.durationMs !== undefined ? { durationMs: transition.durationMs } : {}),
          ...((run.commitSha ?? run.crawlerVersion) ? { version: run.commitSha ?? run.crawlerVersion } : {}),
        });
      }
    }
    return {
      evidence: evidence.sort((a, b) => b.at.localeCompare(a.at)),
      ...(evidence.length === 0
        ? { note: `not found in the last ${String(RECENT_RUNS)} persisted runs` }
        : {}),
    };
  }

  /* ───────────────────────── décisions ───────────────────────── */

  async decide(
    applicationId: string,
    input: Omit<DecisionInput, 'itemTitle' | 'application'>,
  ): Promise<{ item: KnowledgeItem; entry: LedgerEntry }> {
    if (this.context.options.readOnly) throw new ReadOnlyError();
    const { items } = await this.load(applicationId);
    const item = items.find((candidate) => candidate.id === input.itemId);
    if (!item) throw new KnowledgeNotFoundError(`unknown knowledge ${input.itemId}`);
    const { entry, current } = await this.context.ledger.decide({
      ...input,
      itemTitle: item.title,
      application: applicationId,
    });
    this.cache.delete(applicationId);
    const updated: KnowledgeItem = current ? { ...item, review: current } : withoutReview(item);
    return { item: updated, entry };
  }

  /* ───────────────────────── flows, états, transitions ───────────────────────── */

  async flows(applicationId: string): Promise<FlowsDto & { warnings: ReaderWarning[] }> {
    const loaded = await this.load(applicationId);
    const { recordings, warnings } = await this.loadRecordings();
    const flows = recordings.map(recordingFlowSummary);
    for (const item of loaded.items.filter((candidate) => candidate.type === 'FLOW_RUN')) {
      const existing = flows.find((flow) => flow.name === item.key);
      const run = item.data as {
        runId?: string;
        at?: string;
        status?: string;
        durationMs?: number;
        steps?: unknown[];
      };
      const lastRun = {
        runId: run.runId ?? '',
        at: run.at ?? '',
        status: run.status ?? '',
        durationMs: run.durationMs ?? 0,
      };
      if (existing) existing.lastRun = lastRun;
      else
        flows.push({
          name: item.key,
          source: 'FLOW_RUN_MEMORY',
          steps: Array.isArray(run.steps) ? run.steps.length : 0,
          lastRun,
          produces: [],
          consumes: [],
        });
    }
    const { states, transitions } = transitionsOf(loaded.items);
    return {
      runs: (await this.runs(applicationId, 50)).map(runSummary),
      flows,
      states,
      transitions,
      warnings: [...loaded.warnings, ...warnings],
    };
  }

  async graph(applicationId: string, limit = 400): Promise<GraphDto> {
    const { items } = await this.load(applicationId);
    const { states, transitions } = transitionsOf(items);
    const kept = transitions.slice(0, limit);
    const used = new Set<string>();
    for (const transition of kept) {
      used.add(transition.from);
      used.add(transition.to);
    }
    return {
      nodes: states
        .filter((state) => used.has(state.signature))
        .map((state) => ({
          id: state.signature,
          label: state.titles[0] ?? state.signature,
          kind: state.signature === NO_TARGET ? 'none' : 'state',
          outgoing: state.outgoing,
          incoming: state.incoming,
        })),
      edges: kept.map((transition) => ({
        id: transition.id,
        from: transition.from,
        to: transition.to,
        label: transition.action,
        status: transition.status,
        seen: transition.seen,
      })),
      truncated: transitions.length > limit,
    };
  }

  async variables(applicationId: string): Promise<VariablesDto & { warnings: ReaderWarning[] }> {
    const loaded = await this.load(applicationId);
    const { recordings, warnings } = await this.loadRecordings();
    return { ...variablesOf(recordings, loaded.mappings), warnings: [...loaded.warnings, ...warnings] };
  }

  /* ───────────────────────── qualité ───────────────────────── */

  async quality(applicationId: string, perCategory = 20): Promise<QualityDto> {
    const { items } = await this.load(applicationId);
    const byStatus: Record<string, number> = {};
    for (const item of items)
      byStatus[item.reliability.status] = (byStatus[item.reliability.status] ?? 0) + 1;
    const category = (
      status: ReliabilityStatus,
      label: string,
      definition: string,
    ): QualityDto['categories'][number] => {
      const found = items.filter((item) => item.reliability.status === status);
      return { status, label, definition, items: found.slice(0, perCategory), total: found.length };
    };
    const signal = (
      kind: string,
      title: string,
      definition: string,
      found: KnowledgeItem[],
    ): QualityDto['signals'][number] => ({
      kind,
      title,
      definition,
      items: found.slice(0, perCategory),
      total: found.length,
    });
    const mappings = items.filter((item) => item.type === 'FIELD_MAPPING');
    const byLabel = new Map<string, KnowledgeItem[]>();
    for (const mapping of mappings) {
      const label = text(mapping.data.uiLabel).trim().toLowerCase();
      byLabel.set(label, [...(byLabel.get(label) ?? []), mapping]);
    }
    const contradictoryMappings = [...byLabel.values()]
      .filter(
        (group) =>
          new Set(group.map((mapping) => `${text(mapping.data.property)}|${text(mapping.data.jsonPath)}`))
            .size > 1,
      )
      .flat();
    const failedRuns = new Set(
      (await this.runs(applicationId, 50)).filter((run) => run.status === 'FAILED').map((run) => run.id),
    );
    return {
      byStatus,
      categories: [
        category(
          'CONFIRMED',
          'Validated by executions',
          'executed at least minObservations times with at most 10 % failures, or confirmed without contradiction',
        ),
        category('OBSERVED', 'Observed', 'seen, not (or not enough) executed'),
        category(
          'FRAGILE',
          'Fragile',
          'executed with failures (between 10 % and 50 %), or blocked more often than executed',
        ),
        category(
          'CONTRADICTED',
          'Contradicted',
          'failures are the majority, or contradictions outnumber confirmations',
        ),
        category(
          'STALE',
          'Stale',
          `not seen for more than ${String(this.context.options.staleAfterDays)} days`,
        ),
        category('HYPOTHESIS', 'Hypotheses', 'produced by an analysis, never confirmed by an execution'),
        category('UNVERIFIED', 'Unverified', 'no usable evidence'),
      ],
      signals: [
        signal(
          'FAILING_SELECTORS',
          'Target resolutions and recoveries that fail',
          'TARGET_RESOLUTION and RECOVERY rows with at least as many failures as successes',
          items.filter(
            (item) =>
              ['TARGET_RESOLUTION', 'RECOVERY'].includes(item.type) &&
              (item.evidence.failures ?? 0) > 0 &&
              (item.evidence.failures ?? 0) >= (item.evidence.successes ?? 0),
          ),
        ),
        signal(
          'BROKEN_TRANSITIONS',
          'Transitions that no longer work',
          'TRANSITION rows FRAGILE or CONTRADICTED',
          items.filter(
            (item) =>
              item.type === 'TRANSITION' && ['FRAGILE', 'CONTRADICTED'].includes(item.reliability.status),
          ),
        ),
        signal(
          'CONTRADICTORY_MAPPINGS',
          'Contradictory field mappings',
          'the same field label mapped to different properties',
          contradictoryMappings,
        ),
        signal(
          'STALE',
          'Not used for a long time',
          `rows not seen for more than ${String(this.context.options.staleAfterDays)} days`,
          items.filter((item) => item.reliability.status === 'STALE'),
        ),
        signal(
          'CHANGED_RULES',
          'Business rules that changed',
          'RULE rows contradicted at runtime (status RUNTIME_CONTRADICTED or contradictions > 0)',
          items.filter(
            (item) =>
              item.type === 'RULE' &&
              (String(item.data.status) === 'RUNTIME_CONTRADICTED' ||
                (item.evidence.contradictions ?? 0) > 0),
          ),
        ),
        signal(
          'FROM_FAILED_RUNS',
          'Knowledge produced by failed runs',
          'rows whose run ids belong to runs whose status is FAILED (last 50 persisted runs)',
          items.filter((item) => (item.evidence.runIds ?? []).some((runId) => failedRuns.has(runId))),
        ),
        signal(
          'INCONSISTENT_WITH_OBSERVATIONS',
          'Inconsistent with the observed DOM or API contracts',
          'API rows with as many errors (4xx / 5xx) as successes, invariants with counterexamples, rules contradicted',
          items.filter(
            (item) =>
              (item.type === 'API' &&
                (item.evidence.failures ?? 0) > 0 &&
                (item.evidence.failures ?? 0) >= (item.evidence.successes ?? 0)) ||
              (item.type === 'INVARIANT' && (item.evidence.contradictions ?? 0) > 0) ||
              (item.type === 'RULE' && String(item.data.status) === 'RUNTIME_CONTRADICTED'),
          ),
        ),
      ],
    };
  }

  /* ───────────────────────── historique ───────────────────────── */

  async history(applicationId: string, limit = 200): Promise<HistoryDto> {
    const { items } = await this.load(applicationId);
    const entries = (await this.context.ledger.entries()).filter(
      (entry) => !entry.application || entry.application === applicationId,
    );
    const learning: ActivityEntry[] = [
      ...(await this.runs(applicationId, 50)).map((run) => ({
        id: run.id,
        at: run.finishedAt ?? run.startedAt,
        type: 'RUN',
        title: `${run.missionName} · ${run.mode} · ${run.status}`,
        detail: `${String(run.statesCount)} state(s), ${String(run.transitionsCount)} transition(s), ${String(run.anomaliesCount)} anomaly(ies)`,
        status: run.status,
      })),
      ...items
        .filter((item) => item.createdAt ?? item.updatedAt)
        .map((item) => ({
          id: item.id,
          at: item.createdAt ?? item.updatedAt,
          type: item.type,
          title: item.title,
          detail: item.createdAt ? 'first seen' : 'last seen',
          status: item.reliability.status,
        })),
    ]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, limit);
    return { entries: entries.slice(0, limit), learning, total: entries.length };
  }

  /* ───────────────────────── vocabulaires ───────────────────────── */

  vocabulary(): { types: readonly string[]; statuses: readonly string[]; origins: readonly string[] } {
    return { types: KNOWLEDGE_TYPES, statuses: RELIABILITY_STATUSES, origins: KNOWLEDGE_ORIGINS };
  }
}

export interface ExecutionEvidence {
  runId: string;
  missionName: string;
  runStatus: string;
  at: string;
  status: string;
  oracleStatus?: string;
  durationMs?: number;
  version?: string;
}

const PROVIDERS: PersistenceStateDto['providers'] = [
  { kind: 'memory', label: 'in-memory', available: true, note: 'nothing survives the process' },
  { kind: 'file', label: 'file (JSON)', available: true },
  { kind: 'sqlite', label: 'SQLite', available: true },
  { kind: 'postgres', label: 'PostgreSQL', available: true },
  { kind: 'sqlserver', label: 'SQL Server', available: true },
  {
    kind: 'mysql',
    label: 'MySQL',
    available: false,
    note: 'planned by the configuration, not implemented in this version',
  },
  {
    kind: 'http',
    label: 'remote HTTP service',
    available: false,
    note: 'extension point: a provider implementing PersistenceProvider',
  },
  {
    kind: 'grpc',
    label: 'remote gRPC service',
    available: false,
    note: 'extension point: a provider implementing PersistenceProvider',
  },
];

/** Un champ texte d'une ligne (les données réelles sont typées `unknown`). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function splitApplicationId(applicationId: string): [string, string | undefined] {
  const at = applicationId.lastIndexOf('@');
  return at <= 0 ? [applicationId, undefined] : [applicationId.slice(0, at), applicationId.slice(at + 1)];
}

function latest(dates: (string | undefined)[]): string | undefined {
  let found: string | undefined;
  for (const date of dates) if (date && (!found || date > found)) found = date;
  return found;
}

function withoutReview(item: KnowledgeItem): KnowledgeItem {
  const { review: _review, ...rest } = item;
  return rest;
}

export function runSummary(run: CrawlRunRecord): RunSummary {
  return {
    id: run.id,
    missionName: run.missionName,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    statesCount: run.statesCount,
    actionsCount: run.actionsCount,
    transitionsCount: run.transitionsCount,
    anomaliesCount: run.anomaliesCount,
    ...(run.environment ? { environment: run.environment } : {}),
    ...(run.branch ? { branch: run.branch } : {}),
    ...(run.commitSha ? { commitSha: run.commitSha } : {}),
    ...(run.crawlerVersion ? { crawlerVersion: run.crawlerVersion } : {}),
  };
}

/** Les écrans et transitions, tirés des connaissances de transition (persistance et fichier). */
function transitionsOf(items: KnowledgeItem[]): { states: StateSummary[]; transitions: TransitionSummary[] } {
  const states = new Map<string, StateSummary>();
  const state = (signature: string): StateSummary => {
    const found = states.get(signature);
    if (found) return found;
    const created: StateSummary = { signature, routes: [], titles: [], outgoing: 0, incoming: 0 };
    states.set(signature, created);
    return created;
  };
  const transitions: TransitionSummary[] = [];
  for (const item of items) {
    if (item.type !== 'TRANSITION') continue;
    const from = text(item.data.fromStateSignature);
    const action = text(item.data.actionSignature);
    if (item.source === 'PERSISTENCE') {
      const to = text(item.data.toStateSignature) || NO_TARGET;
      transitions.push({
        id: item.id,
        from,
        action,
        to,
        seen: item.evidence.seen ?? 0,
        successes: item.evidence.successes ?? 0,
        failures: item.evidence.failures ?? 0,
        blocked: item.evidence.blocked ?? 0,
        status: item.reliability.status,
        lastSeenAt: item.updatedAt ?? '',
      });
      const source = state(from);
      source.outgoing += 1;
      if (item.updatedAt && (!source.lastSeenAt || item.updatedAt > source.lastSeenAt))
        source.lastSeenAt = item.updatedAt;
      state(to).incoming += 1;
      continue;
    }
    const targets = (item.data.targets ?? {}) as Record<string, number>;
    for (const [to, count] of Object.entries(targets)) {
      transitions.push({
        id: `${item.id}:${to}`,
        from,
        action,
        to,
        seen: count,
        successes: item.evidence.successes ?? 0,
        failures: item.evidence.failures ?? 0,
        blocked: 0,
        status: item.reliability.status,
        lastSeenAt: item.updatedAt ?? '',
      });
      state(from).outgoing += 1;
      state(to).incoming += 1;
    }
  }
  return {
    states: [...states.values()].sort(
      (a, b) => b.outgoing + b.incoming - (a.outgoing + a.incoming) || a.signature.localeCompare(b.signature),
    ),
    transitions: transitions.sort((a, b) => b.seen - a.seen || a.from.localeCompare(b.from)),
  };
}

export type { ReviewDecision };
