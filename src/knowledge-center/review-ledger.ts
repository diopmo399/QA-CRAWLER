import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../memory/atomic-write.js';
import type { LedgerEntry, ReviewDecision } from './model.js';

/**
 * LE REGISTRE DE REVUE DU KNOWLEDGE CENTER : un fichier JSON, en AJOUT SEUL, dans le dossier de la
 * base de connaissances (`<knowledge>/knowledge-center/review-ledger.json`). Il garde chaque opération
 * de gestion (validation, invalidation, export, import, sauvegarde, restauration) avec sa date, son
 * motif, et pour une décision, la version précédente et la suivante.
 *
 * Il ne remplace aucune connaissance et le moteur ne le lit pas : une décision humaine est une
 * annotation montrée et exportée, jamais une règle imposée au rejeu. Le contrôle des modifications
 * concurrentes est optimiste : une décision porte la version attendue ; une version différente est
 * refusée (ReviewConflictError) et rien n'est écrit.
 */
export const REVIEW_LEDGER_FILE = 'review-ledger.json';
export const REVIEW_LEDGER_DIR = 'knowledge-center';

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

export class ReviewConflictError extends Error {
  constructor(
    readonly itemId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `knowledge ${itemId} changed since it was read (version ${String(actual)}, expected ${String(expected)})`,
    );
    this.name = 'ReviewConflictError';
  }
}

export interface DecisionInput {
  itemId: string;
  itemTitle: string;
  application?: string;
  operation: 'VALIDATE' | 'INVALIDATE' | 'RESET';
  note?: string;
  reason?: string;
  /** La version lue par l'appelant (0 quand aucune décision n'existait). */
  expectedVersion: number;
}

export class ReviewLedger {
  private file: LedgerFile = { version: 1, entries: [] };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly location: string | undefined,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  static inDirectory(knowledgeDir: string | undefined, now?: () => string): ReviewLedger {
    return new ReviewLedger(
      knowledgeDir ? path.join(knowledgeDir, REVIEW_LEDGER_DIR, REVIEW_LEDGER_FILE) : undefined,
      now,
    );
  }

  async load(): Promise<void> {
    this.loaded = true;
    if (!this.location) return;
    let text: string;
    try {
      text = await readFile(this.location, 'utf8');
    } catch {
      return;
    }
    const parsed = JSON.parse(text) as Partial<LedgerFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries))
      throw new Error(`${this.location}: unknown review ledger format`);
    this.file = { version: 1, entries: parsed.entries };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** Toutes les opérations, la plus récente d'abord. */
  async entries(): Promise<LedgerEntry[]> {
    await this.ensureLoaded();
    return [...this.file.entries].reverse();
  }

  /** La décision courante de chaque connaissance (la dernière écrite ; RESET l'efface). */
  async decisions(): Promise<Map<string, ReviewDecision>> {
    await this.ensureLoaded();
    const current = new Map<string, ReviewDecision>();
    for (const entry of this.file.entries) {
      if (!entry.itemId) continue;
      if (entry.operation === 'RESET') current.delete(entry.itemId);
      else if (entry.after) current.set(entry.itemId, entry.after);
    }
    return current;
  }

  /** Le nombre de décisions prises sur une connaissance (sa version). */
  async versionOf(itemId: string): Promise<number> {
    await this.ensureLoaded();
    return this.file.entries.filter(
      (entry) => entry.itemId === itemId && ['VALIDATE', 'INVALIDATE', 'RESET'].includes(entry.operation),
    ).length;
  }

  /** Une décision humaine : vérifie la version, écrit l'entrée, rend la décision courante (ou aucune). */
  decide(input: DecisionInput): Promise<{ entry: LedgerEntry; current?: ReviewDecision }> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const version = await this.versionOf(input.itemId);
      if (version !== input.expectedVersion)
        throw new ReviewConflictError(input.itemId, input.expectedVersion, version);
      const before = (await this.decisions()).get(input.itemId);
      const after: ReviewDecision | undefined =
        input.operation === 'RESET'
          ? undefined
          : {
              status: input.operation === 'VALIDATE' ? 'VALIDATED' : 'INVALIDATED',
              ...(input.note ? { note: input.note } : {}),
              at: this.now(),
              version: version + 1,
            };
      const entry: LedgerEntry = {
        id: randomUUID(),
        at: this.now(),
        operation: input.operation,
        ...(input.application ? { application: input.application } : {}),
        itemId: input.itemId,
        itemTitle: input.itemTitle,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        origin: 'KNOWLEDGE_CENTER',
      };
      await this.append(entry);
      return { entry, ...(after ? { current: after } : {}) };
    });
  }

  /** Une opération de gestion (export, import, sauvegarde, restauration), avec ses détails et ses erreurs. */
  record(
    operation: LedgerEntry['operation'],
    details: Record<string, unknown>,
    options: { application?: string; reason?: string; errors?: string[] } = {},
  ): Promise<LedgerEntry> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const entry: LedgerEntry = {
        id: randomUUID(),
        at: this.now(),
        operation,
        ...(options.application ? { application: options.application } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        origin: 'KNOWLEDGE_CENTER',
        details,
        ...(options.errors && options.errors.length > 0 ? { errors: options.errors } : {}),
      };
      await this.append(entry);
      return entry;
    });
  }

  private async append(entry: LedgerEntry): Promise<void> {
    const next: LedgerFile = { version: 1, entries: [...this.file.entries, entry] };
    if (this.location) {
      await mkdir(path.dirname(this.location), { recursive: true });
      await writeFileAtomic(this.location, `${JSON.stringify(next, null, 2)}\n`);
    }
    this.file = next;
  }

  /** Une écriture à la fois : deux décisions simultanées sont appliquées l'une après l'autre. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
