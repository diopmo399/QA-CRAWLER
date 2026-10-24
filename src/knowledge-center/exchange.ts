import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { functionalKnowledgeFile } from '../knowledge/functional-knowledge-store.js';
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeData } from '../knowledge/knowledge-model.js';
import { ruleKnowledgeFile } from '../knowledge/rule-knowledge-store.js';
import { writeFileAtomic } from '../memory/atomic-write.js';
import {
  PERSISTENCE_SCHEMA_VERSION,
  type CrawlRunRecord,
  type FlowMemoryRecord,
  type KeyedRecord,
  type RunStateRecord,
  type RunTransitionRecord,
  type TransitionKnowledgeRecord,
  type TransitionObservation,
} from '../persistence/model.js';
import type { KnowledgeCenterContext } from './context.js';
import { KNOWLEDGE_EXPORT_FORMAT, KNOWLEDGE_EXPORT_VERSION, type LedgerEntry } from './model.js';
import { ReadOnlyError } from './service.js';
import { knowledgeFileKey, readKnowledgeFileRaw, type ApplicationIdentity } from './sources.js';

/**
 * EXPORT, IMPORT, SAUVEGARDE, RESTAURATION — seulement ce que les repositories savent faire :
 * - `transition_knowledge` ne sait qu'AJOUTER des observations (`record`) : une ligne importée n'est
 *   écrite que si sa clé est absente (sinon elle serait recomptée) ; une clé présente est un conflit,
 *   listé, jamais fusionné en silence ;
 * - `flow_evolution`, `anomaly_lifecycle`, `flow_memory` remplacent par clé (`save`) : remplacés
 *   seulement sur choix explicite (`replaceable: replace`), sinon ignorés ;
 * - les runs (et leurs états / transitions) sont ajoutés quand leur id est absent ;
 * - les fichiers (base de connaissances, fonctionnel, règles) sont remplacés seulement sur choix explicite.
 * Chaque opération écrit une entrée du registre avec ce qui a été fait et ce qui a échoué.
 */

export interface KnowledgeExport {
  format: typeof KNOWLEDGE_EXPORT_FORMAT;
  version: typeof KNOWLEDGE_EXPORT_VERSION;
  exportedAt: string;
  crawlerVersion: string;
  application: { id: string; application: string; environment?: string; functionalApplication: string };
  persistence?: {
    provider: string;
    schemaVersion: number;
    runs: CrawlRunRecord[];
    states: RunStateRecord[];
    transitions: RunTransitionRecord[];
    knowledge: TransitionKnowledgeRecord[];
    evolution: KeyedRecord[];
    anomalies: KeyedRecord[];
    memory: FlowMemoryRecord[];
  };
  knowledgeFile?: { schemaVersion: number; key: string; data: KnowledgeData };
  functional?: { content: unknown };
  rules?: { content: unknown };
  review: LedgerEntry[];
}

export interface ImportPolicy {
  /** evolution, anomalies, flow memory : remplacer une clé déjà présente, ou l'ignorer. */
  replaceable: 'skip' | 'replace';
  /** base de connaissances, fonctionnel, règles : remplacer le fichier (l'entrée de l'application), ou l'ignorer. */
  files: 'skip' | 'replace';
  /** Faire une sauvegarde avant d'importer. */
  backupFirst: boolean;
}

export const DEFAULT_IMPORT_POLICY: ImportPolicy = { replaceable: 'skip', files: 'skip', backupFirst: true };

export interface SectionPreview {
  section: string;
  total: number;
  added: number;
  identical: number;
  conflicts: number;
  skipped: number;
  /** Ce que la politique fera des conflits. */
  onConflict: 'skip' | 'replace' | 'never-replaced';
  samples: string[];
  note?: string;
}

export interface ImportPreview {
  application: KnowledgeExport['application'];
  targetApplicationId: string;
  compatible: boolean;
  problems: string[];
  sections: SectionPreview[];
}

export interface SectionResult {
  section: string;
  added: number;
  replaced: number;
  skipped: number;
  errors: string[];
}

export interface ImportResult {
  applied: boolean;
  sections: SectionResult[];
  errors: string[];
  backup?: BackupInfo;
  entry: LedgerEntry;
}

export interface BackupInfo {
  id: string;
  file: string;
  at: string;
  applicationId: string;
  bytes: number;
}

export class ImportValidationError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

const BACKUPS_DIR = 'backups';

/* ───────────────────────── validation ───────────────────────── */

const isoDate = z.string().min(1);
const keyed = z
  .object({
    applicationId: z.string().min(1),
    key: z.string().min(1).max(200),
    status: z.string().min(1).max(200),
    firstSeenAt: isoDate,
    lastSeenAt: isoDate,
    data: z.record(z.unknown()),
  })
  .passthrough();

const exportSchema = z
  .object({
    format: z.literal(KNOWLEDGE_EXPORT_FORMAT),
    version: z.literal(KNOWLEDGE_EXPORT_VERSION),
    exportedAt: isoDate,
    crawlerVersion: z.string(),
    application: z.object({
      id: z.string().min(1),
      application: z.string().min(1),
      environment: z.string().optional(),
      functionalApplication: z.string().min(1),
    }),
    persistence: z
      .object({
        provider: z.string(),
        schemaVersion: z.number().int().nonnegative(),
        runs: z.array(
          z
            .object({ id: z.string().min(1), applicationId: z.string().min(1), startedAt: isoDate })
            .passthrough(),
        ),
        states: z.array(
          z
            .object({ id: z.string().min(1), runId: z.string().min(1), stateId: z.string().min(1) })
            .passthrough(),
        ),
        transitions: z.array(z.object({ id: z.string().min(1), runId: z.string().min(1) }).passthrough()),
        knowledge: z.array(
          z
            .object({
              applicationId: z.string().min(1),
              fromStateSignature: z.string().min(1).max(200),
              actionSignature: z.string().min(1).max(200),
              toStateSignature: z.string().min(1).max(200),
              seenCount: z.number().int().nonnegative(),
              successCount: z.number().int().nonnegative(),
              failureCount: z.number().int().nonnegative(),
              blockedCount: z.number().int().nonnegative(),
              averageDurationMs: z.number().nonnegative().optional(),
              firstSeenAt: isoDate,
              lastSeenAt: isoDate,
            })
            .passthrough(),
        ),
        evolution: z.array(keyed),
        anomalies: z.array(keyed),
        memory: z.array(keyed.extend({ kind: z.string().min(1) })),
      })
      .optional(),
    knowledgeFile: z
      .object({
        schemaVersion: z.number().int(),
        key: z.string().min(1),
        data: z.object({ identity: z.object({ application: z.string() }).passthrough() }).passthrough(),
      })
      .optional(),
    functional: z.object({ content: z.unknown() }).optional(),
    rules: z.object({ content: z.unknown() }).optional(),
    review: z
      .array(z.object({ id: z.string(), at: isoDate, operation: z.string() }).passthrough())
      .default([]),
  })
  .passthrough();

export function parseKnowledgeExport(raw: unknown): KnowledgeExport {
  if (raw && typeof raw === 'object' && (raw as { format?: unknown }).format !== KNOWLEDGE_EXPORT_FORMAT)
    throw new ImportValidationError(
      `not a QA-CRAWLER knowledge export (format "${String((raw as { format?: unknown }).format)}")`,
    );
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success)
    throw new ImportValidationError(
      'invalid knowledge export',
      parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  const document = parsed.data as unknown as KnowledgeExport;
  const problems: string[] = [];
  if (document.persistence && document.persistence.schemaVersion > PERSISTENCE_SCHEMA_VERSION)
    problems.push(
      `persistence schema ${String(document.persistence.schemaVersion)} is newer than this crawler (${String(PERSISTENCE_SCHEMA_VERSION)})`,
    );
  if (document.knowledgeFile && document.knowledgeFile.schemaVersion > KNOWLEDGE_SCHEMA_VERSION)
    problems.push(
      `knowledge file schema ${String(document.knowledgeFile.schemaVersion)} is newer than this crawler (${String(KNOWLEDGE_SCHEMA_VERSION)})`,
    );
  if (problems.length > 0)
    throw new ImportValidationError(`incompatible knowledge export: ${problems.join('; ')}`, problems);
  return document;
}

/* ───────────────────────── export ───────────────────────── */

export class KnowledgeExchange {
  constructor(private readonly context: KnowledgeCenterContext) {}

  private identityOf(applicationId: string): ApplicationIdentity {
    if (applicationId === this.context.current.applicationId) return this.context.current;
    const at = applicationId.lastIndexOf('@');
    const application = at <= 0 ? applicationId : applicationId.slice(0, at);
    const environment = at <= 0 ? undefined : applicationId.slice(at + 1);
    return {
      applicationId,
      application,
      ...(environment ? { environment } : {}),
      functionalApplication: application,
    };
  }

  private get backupsDir(): string {
    return path.join(this.context.knowledgeDir, 'knowledge-center', BACKUPS_DIR);
  }

  async exportApplication(
    applicationId: string,
    options: { record?: boolean } = {},
  ): Promise<KnowledgeExport> {
    const identity = this.identityOf(applicationId);
    const provider = this.context.persistence.provider;
    const { limit } = this.context.options;
    const document: KnowledgeExport = {
      format: KNOWLEDGE_EXPORT_FORMAT,
      version: KNOWLEDGE_EXPORT_VERSION,
      exportedAt: this.context.now().toISOString(),
      crawlerVersion: this.context.crawlerVersion,
      application: {
        id: identity.applicationId,
        application: identity.application,
        ...(identity.environment ? { environment: identity.environment } : {}),
        functionalApplication: identity.functionalApplication,
      },
      review: (await this.context.ledger.entries()).filter(
        (entry) => !entry.application || entry.application === applicationId,
      ),
    };
    if (provider) {
      const runs = await provider.runs.list(applicationId, limit);
      const states: RunStateRecord[] = [];
      const transitions: RunTransitionRecord[] = [];
      for (const run of runs) {
        states.push(...(await provider.states.listByRun(run.id)));
        transitions.push(...(await provider.transitions.listByRun(run.id)));
      }
      document.persistence = {
        provider: provider.description,
        schemaVersion: this.context.persistence.status.schemaVersion ?? PERSISTENCE_SCHEMA_VERSION,
        runs,
        states,
        transitions,
        knowledge: await provider.knowledge.load(applicationId, limit),
        evolution: await provider.evolution.load(applicationId, limit),
        anomalies: await provider.anomalies.load(applicationId, limit),
        memory: await provider.memory.search({ applicationId, limit }),
      };
    }
    const content = await readKnowledgeFileRaw(this.context.knowledgeFile).catch(() => undefined);
    const key = knowledgeFileKey(identity);
    const data = content?.applications[key];
    if (content && data) document.knowledgeFile = { schemaVersion: content.schemaVersion, key, data };
    const functional = await readJson(
      functionalKnowledgeFile(this.context.functionalDir, storeIdentity(identity)),
    );
    if (functional !== undefined) document.functional = { content: functional };
    const rules = await readJson(ruleKnowledgeFile(this.context.rulesDir, storeIdentity(identity)));
    if (rules !== undefined) document.rules = { content: rules };
    if (options.record !== false)
      await this.context.ledger.record('EXPORT', summaryOf(document), { application: applicationId });
    return document;
  }

  /* ───────────────────────── import ───────────────────────── */

  async preview(document: KnowledgeExport, policy: ImportPolicy): Promise<ImportPreview> {
    const targetApplicationId = document.application.id;
    const identity = this.identityOf(targetApplicationId);
    const provider = this.context.persistence.provider;
    const problems: string[] = [];
    const sections: SectionPreview[] = [];
    const { limit } = this.context.options;
    if (document.persistence) {
      if (!provider)
        problems.push(
          'the export carries persisted rows but the persistence is disabled here: they will be skipped',
        );
      else {
        const existingRuns = new Set(
          (await provider.runs.list(targetApplicationId, limit)).map((run) => run.id),
        );
        const newRuns = document.persistence.runs.filter((run) => !existingRuns.has(run.id));
        sections.push({
          section: 'runs',
          total: document.persistence.runs.length,
          added: newRuns.length,
          identical: document.persistence.runs.length - newRuns.length,
          conflicts: 0,
          skipped: document.persistence.runs.length - newRuns.length,
          onConflict: 'never-replaced',
          samples: newRuns.slice(0, 5).map((run) => run.id),
          note: 'a run already present (same id) is never rewritten; its states and transitions are skipped with it',
        });
        const newRunIds = new Set(newRuns.map((run) => run.id));
        sections.push(
          simpleSection(
            'states',
            document.persistence.states.filter((state) => newRunIds.has(state.runId)).length,
            document.persistence.states.length,
          ),
        );
        sections.push(
          simpleSection(
            'transitions',
            document.persistence.transitions.filter((transition) => newRunIds.has(transition.runId)).length,
            document.persistence.transitions.length,
          ),
        );
        const existing = await provider.knowledge.load(targetApplicationId, limit);
        const byKey = new Map(existing.map((row) => [knowledgeRowKey(row), row]));
        let added = 0;
        let identical = 0;
        let conflicts = 0;
        const samples: string[] = [];
        for (const row of document.persistence.knowledge) {
          const found = byKey.get(knowledgeRowKey(row));
          if (!found) added += 1;
          else if (sameCounters(found, row)) identical += 1;
          else {
            conflicts += 1;
            if (samples.length < 5) samples.push(knowledgeRowKey(row));
          }
        }
        sections.push({
          section: 'knowledge',
          total: document.persistence.knowledge.length,
          added,
          identical,
          conflicts,
          skipped: identical + conflicts,
          onConflict: 'never-replaced',
          samples,
          note: 'transition knowledge only accepts increments: a row whose key already exists is never recounted nor replaced',
        });
        sections.push(
          await this.keyedPreview(
            'evolution',
            document.persistence.evolution,
            await provider.evolution.load(targetApplicationId, limit),
            policy,
          ),
        );
        sections.push(
          await this.keyedPreview(
            'anomalies',
            document.persistence.anomalies,
            await provider.anomalies.load(targetApplicationId, limit),
            policy,
          ),
        );
        sections.push(
          await this.keyedPreview(
            'memory',
            document.persistence.memory,
            await provider.memory.search({ applicationId: targetApplicationId, limit }),
            policy,
            (record) => `${(record as FlowMemoryRecord).kind}|${record.key}`,
          ),
        );
      }
    }
    if (document.knowledgeFile) {
      const content = await readKnowledgeFileRaw(this.context.knowledgeFile).catch(() => undefined);
      const key = knowledgeFileKey(identity);
      const current = content?.applications[key];
      sections.push(fileSection('knowledgeFile', current, document.knowledgeFile.data, policy));
    }
    if (document.functional)
      sections.push(
        fileSection(
          'functional',
          await readJson(functionalKnowledgeFile(this.context.functionalDir, storeIdentity(identity))),
          document.functional.content,
          policy,
        ),
      );
    if (document.rules)
      sections.push(
        fileSection(
          'rules',
          await readJson(ruleKnowledgeFile(this.context.rulesDir, storeIdentity(identity))),
          document.rules.content,
          policy,
        ),
      );
    return { application: document.application, targetApplicationId, compatible: true, problems, sections };
  }

  private keyedPreview(
    section: string,
    rows: KeyedRecord[],
    existing: KeyedRecord[],
    policy: ImportPolicy,
    keyOf: (record: KeyedRecord) => string = (record) => record.key,
  ): Promise<SectionPreview> {
    const byKey = new Map(existing.map((row) => [keyOf(row), row]));
    let added = 0;
    let identical = 0;
    let conflicts = 0;
    const samples: string[] = [];
    for (const row of rows) {
      const found = byKey.get(keyOf(row));
      if (!found) added += 1;
      else if (found.status === row.status && JSON.stringify(found.data) === JSON.stringify(row.data))
        identical += 1;
      else {
        conflicts += 1;
        if (samples.length < 5) samples.push(keyOf(row));
      }
    }
    return Promise.resolve({
      section,
      total: rows.length,
      added,
      identical,
      conflicts,
      skipped: identical + (policy.replaceable === 'replace' ? 0 : conflicts),
      onConflict: policy.replaceable,
      samples,
    });
  }

  async apply(document: KnowledgeExport, policy: ImportPolicy, reason?: string): Promise<ImportResult> {
    if (this.context.options.readOnly) throw new ReadOnlyError();
    const targetApplicationId = document.application.id;
    const identity = this.identityOf(targetApplicationId);
    const provider = this.context.persistence.provider;
    const results: SectionResult[] = [];
    const errors: string[] = [];
    let backup: BackupInfo | undefined;
    if (policy.backupFirst) {
      try {
        backup = await this.backup(targetApplicationId, 'before import');
      } catch (error) {
        errors.push(`backup failed: ${messageOf(error)}; nothing was imported`);
        const entry = await this.context.ledger.record(
          'IMPORT',
          { targetApplicationId, policy, applied: false },
          { application: targetApplicationId, reason, errors },
        );
        return { applied: false, sections: [], errors, entry };
      }
    }
    const { limit } = this.context.options;
    if (document.persistence && provider) {
      const existingRuns = new Set(
        (await provider.runs.list(targetApplicationId, limit)).map((run) => run.id),
      );
      const runs = document.persistence.runs.filter((run) => !existingRuns.has(run.id));
      const runResult: SectionResult = {
        section: 'runs',
        added: 0,
        replaced: 0,
        skipped: document.persistence.runs.length - runs.length,
        errors: [],
      };
      const stateResult: SectionResult = { section: 'states', added: 0, replaced: 0, skipped: 0, errors: [] };
      const transitionResult: SectionResult = {
        section: 'transitions',
        added: 0,
        replaced: 0,
        skipped: 0,
        errors: [],
      };
      for (const run of runs) {
        try {
          await provider.runs.create({ ...run, applicationId: targetApplicationId });
          runResult.added += 1;
          const states = document.persistence.states.filter((state) => state.runId === run.id);
          const transitions = document.persistence.transitions.filter(
            (transition) => transition.runId === run.id,
          );
          if (states.length > 0) {
            await provider.states.save(states);
            stateResult.added += states.length;
          }
          if (transitions.length > 0) {
            await provider.transitions.add(transitions);
            transitionResult.added += transitions.length;
          }
        } catch (error) {
          runResult.errors.push(`run ${run.id}: ${messageOf(error)}`);
        }
      }
      results.push(runResult, stateResult, transitionResult);
      const existing = new Set(
        (await provider.knowledge.load(targetApplicationId, limit)).map(knowledgeRowKey),
      );
      const observations: TransitionObservation[] = document.persistence.knowledge
        .filter((row) => !existing.has(knowledgeRowKey(row)))
        .map((row) => observationOf(row, targetApplicationId));
      const knowledgeResult: SectionResult = {
        section: 'knowledge',
        added: 0,
        replaced: 0,
        skipped: document.persistence.knowledge.length - observations.length,
        errors: [],
      };
      if (observations.length > 0)
        try {
          await provider.knowledge.record(observations);
          knowledgeResult.added = observations.length;
        } catch (error) {
          knowledgeResult.errors.push(messageOf(error));
        }
      results.push(knowledgeResult);
      results.push(
        await applyKeyed(
          'evolution',
          document.persistence.evolution,
          await provider.evolution.load(targetApplicationId, limit),
          policy,
          (rows) => provider.evolution.save(rows),
          targetApplicationId,
        ),
      );
      results.push(
        await applyKeyed(
          'anomalies',
          document.persistence.anomalies,
          await provider.anomalies.load(targetApplicationId, limit),
          policy,
          (rows) => provider.anomalies.save(rows),
          targetApplicationId,
        ),
      );
      results.push(
        await applyKeyed(
          'memory',
          document.persistence.memory,
          await provider.memory.search({ applicationId: targetApplicationId, limit }),
          policy,
          (rows) => provider.memory.save(rows as FlowMemoryRecord[]),
          targetApplicationId,
          (record) => `${(record as FlowMemoryRecord).kind}|${record.key}`,
        ),
      );
    } else if (document.persistence)
      results.push({
        section: 'persistence',
        added: 0,
        replaced: 0,
        skipped: 1,
        errors: ['persistence is disabled here: persisted rows were not imported'],
      });
    if (document.knowledgeFile)
      results.push(await this.applyKnowledgeFile(identity, document.knowledgeFile.data, policy));
    if (document.functional)
      results.push(
        await applyFile(
          'functional',
          functionalKnowledgeFile(this.context.functionalDir, storeIdentity(identity)),
          document.functional.content,
          policy,
        ),
      );
    if (document.rules)
      results.push(
        await applyFile(
          'rules',
          ruleKnowledgeFile(this.context.rulesDir, storeIdentity(identity)),
          document.rules.content,
          policy,
        ),
      );
    for (const result of results) errors.push(...result.errors.map((error) => `${result.section}: ${error}`));
    const entry = await this.context.ledger.record(
      'IMPORT',
      {
        targetApplicationId,
        policy,
        sections: results,
        ...(backup ? { backup: backup.id } : {}),
        exportedAt: document.exportedAt,
      },
      { application: targetApplicationId, reason, errors },
    );
    return { applied: true, sections: results, errors, ...(backup ? { backup } : {}), entry };
  }

  private async applyKnowledgeFile(
    identity: ApplicationIdentity,
    data: KnowledgeData,
    policy: ImportPolicy,
  ): Promise<SectionResult> {
    const result: SectionResult = { section: 'knowledgeFile', added: 0, replaced: 0, skipped: 0, errors: [] };
    try {
      const key = knowledgeFileKey(identity);
      const existing = await readKnowledgeFileRaw(this.context.knowledgeFile);
      const file = existing ?? { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, applications: {} };
      if (file.applications[key]) {
        if (policy.files !== 'replace') {
          result.skipped = 1;
          return result;
        }
        result.replaced = 1;
      } else result.added = 1;
      file.applications[key] = data;
      await mkdir(path.dirname(this.context.knowledgeFile), { recursive: true });
      await writeFileAtomic(this.context.knowledgeFile, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      result.added = 0;
      result.replaced = 0;
      result.errors.push(messageOf(error));
    }
    return result;
  }

  /* ───────────────────────── sauvegardes ───────────────────────── */

  async backup(applicationId: string, reason?: string): Promise<BackupInfo> {
    if (this.context.options.readOnly) throw new ReadOnlyError();
    const document = await this.exportApplication(applicationId, { record: false });
    await mkdir(this.backupsDir, { recursive: true });
    const stamp = document.exportedAt.replace(/[:.]/g, '-');
    // Un identifiant unique même quand deux sauvegardes tombent dans la même milliseconde.
    const id = `${stamp}-${randomUUID().slice(0, 8)}-${applicationId.replace(/[^A-Za-z0-9_.-]+/g, '_')}.json`;
    const file = path.join(this.backupsDir, id);
    const text = `${JSON.stringify(document, null, 2)}\n`;
    await writeFileAtomic(file, text);
    const info: BackupInfo = {
      id,
      file,
      at: document.exportedAt,
      applicationId,
      bytes: Buffer.byteLength(text),
    };
    await this.context.ledger.record(
      'BACKUP',
      { id, file, bytes: info.bytes, ...summaryOf(document) },
      { application: applicationId, reason },
    );
    return info;
  }

  async backups(): Promise<BackupInfo[]> {
    let names: string[];
    try {
      names = (await readdir(this.backupsDir))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
    const found: BackupInfo[] = [];
    for (const name of names) {
      const file = path.join(this.backupsDir, name);
      try {
        const info = await stat(file);
        const at = name
          .slice(0, 24)
          .replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1-$2-$3T$4:$5:$6.$7Z');
        found.push({
          id: name,
          file,
          at,
          applicationId: name.slice(25).replace(/\.json$/, ''),
          bytes: info.size,
        });
      } catch {
        // une sauvegarde disparue entre temps
      }
    }
    return found;
  }

  async readBackup(id: string): Promise<KnowledgeExport> {
    if (!/^[A-Za-z0-9_.@-]+\.json$/.test(id) || id.includes('..'))
      throw new ImportValidationError(`invalid backup id ${id}`);
    const file = path.join(this.backupsDir, id);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new ImportValidationError(`cannot read backup ${id}: ${messageOf(error)}`);
    }
    return parseKnowledgeExport(raw);
  }

  /**
   * Restaure une sauvegarde : une sauvegarde de l'état courant d'abord, puis l'import avec remplacement
   * des lignes remplaçables et des fichiers. Le résultat dit, section par section, ce qui a été restauré et
   * ce qui ne l'a pas été (les lignes de transition_knowledge déjà présentes ne sont jamais recomptées).
   */
  async restore(id: string, reason?: string): Promise<ImportResult & { restoredFrom: string }> {
    if (this.context.options.readOnly) throw new ReadOnlyError();
    const document = await this.readBackup(id);
    const result = await this.apply(
      document,
      { replaceable: 'replace', files: 'replace', backupFirst: true },
      reason ?? `restore ${id}`,
    );
    await this.context.ledger.record(
      'RESTORE',
      {
        backup: id,
        targetApplicationId: document.application.id,
        sections: result.sections,
        ...(result.backup ? { backupBefore: result.backup.id } : {}),
      },
      { application: document.application.id, reason, errors: result.errors },
    );
    return { ...result, restoredFrom: id };
  }
}

/* ───────────────────────── helpers ───────────────────────── */

/** Les stores fonctionnel et des règles nomment l'application par la mission (pas par l'hôte). */
function storeIdentity(identity: ApplicationIdentity): { application: string; environment?: string } {
  return {
    application: identity.functionalApplication,
    ...(identity.environment ? { environment: identity.environment } : {}),
  };
}

function knowledgeRowKey(
  row: Pick<TransitionKnowledgeRecord, 'fromStateSignature' | 'actionSignature' | 'toStateSignature'>,
): string {
  return [row.fromStateSignature, row.actionSignature, row.toStateSignature].join('␟');
}

function sameCounters(a: TransitionKnowledgeRecord, b: TransitionKnowledgeRecord): boolean {
  return (
    a.seenCount === b.seenCount &&
    a.successCount === b.successCount &&
    a.failureCount === b.failureCount &&
    a.blockedCount === b.blockedCount
  );
}

function observationOf(row: TransitionKnowledgeRecord, applicationId: string): TransitionObservation {
  const executed = row.successCount + row.failureCount;
  return {
    applicationId,
    fromStateSignature: row.fromStateSignature,
    actionSignature: row.actionSignature,
    toStateSignature: row.toStateSignature,
    seen: row.seenCount,
    success: row.successCount,
    failure: row.failureCount,
    blocked: row.blockedCount,
    durationTotalMs: row.averageDurationMs !== undefined ? row.averageDurationMs * executed : 0,
    durationCount: row.averageDurationMs !== undefined ? executed : 0,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    ...(row.lastContext ? { lastContext: row.lastContext } : {}),
  };
}

async function applyKeyed(
  section: string,
  rows: KeyedRecord[],
  existing: KeyedRecord[],
  policy: ImportPolicy,
  save: (rows: KeyedRecord[]) => Promise<void>,
  applicationId: string,
  keyOf: (record: KeyedRecord) => string = (record) => record.key,
): Promise<SectionResult> {
  const byKey = new Map(existing.map((row) => [keyOf(row), row]));
  const result: SectionResult = { section, added: 0, replaced: 0, skipped: 0, errors: [] };
  const toWrite: KeyedRecord[] = [];
  for (const row of rows) {
    const found = byKey.get(keyOf(row));
    if (!found) {
      toWrite.push({ ...row, applicationId });
      result.added += 1;
    } else if (found.status === row.status && JSON.stringify(found.data) === JSON.stringify(row.data))
      result.skipped += 1;
    else if (policy.replaceable === 'replace') {
      toWrite.push({ ...row, applicationId });
      result.replaced += 1;
    } else result.skipped += 1;
  }
  if (toWrite.length > 0)
    try {
      await save(toWrite);
    } catch (error) {
      result.errors.push(messageOf(error));
      result.added = 0;
      result.replaced = 0;
    }
  return result;
}

function fileSection(
  section: string,
  current: unknown,
  incoming: unknown,
  policy: ImportPolicy,
): SectionPreview {
  const exists = current !== undefined;
  const identical = exists && JSON.stringify(current) === JSON.stringify(incoming);
  return {
    section,
    total: 1,
    added: exists ? 0 : 1,
    identical: identical ? 1 : 0,
    conflicts: exists && !identical ? 1 : 0,
    skipped: identical || (exists && policy.files !== 'replace') ? 1 : 0,
    onConflict: policy.files,
    samples: [],
  };
}

async function applyFile(
  section: string,
  file: string,
  content: unknown,
  policy: ImportPolicy,
): Promise<SectionResult> {
  const result: SectionResult = { section, added: 0, replaced: 0, skipped: 0, errors: [] };
  try {
    const current = await readJson(file);
    if (current !== undefined) {
      if (JSON.stringify(current) === JSON.stringify(content) || policy.files !== 'replace') {
        result.skipped = 1;
        return result;
      }
      result.replaced = 1;
    } else result.added = 1;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(content, null, 2)}\n`);
  } catch (error) {
    result.added = 0;
    result.replaced = 0;
    result.errors.push(messageOf(error));
  }
  return result;
}

function simpleSection(section: string, added: number, total: number): SectionPreview {
  return {
    section,
    total,
    added,
    identical: 0,
    conflicts: 0,
    skipped: total - added,
    onConflict: 'never-replaced',
    samples: [],
  };
}

function summaryOf(document: KnowledgeExport): Record<string, unknown> {
  return {
    applicationId: document.application.id,
    exportedAt: document.exportedAt,
    ...(document.persistence
      ? {
          runs: document.persistence.runs.length,
          states: document.persistence.states.length,
          transitions: document.persistence.transitions.length,
          knowledge: document.persistence.knowledge.length,
          evolution: document.persistence.evolution.length,
          anomalies: document.persistence.anomalies.length,
          memory: document.persistence.memory.length,
        }
      : { persistence: 'disabled' }),
    knowledgeFile: document.knowledgeFile !== undefined,
    functional: document.functional !== undefined,
    rules: document.rules !== undefined,
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
