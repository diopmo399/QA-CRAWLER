import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { MirrorStatus } from '../sdk/core/contracts.js';
import type { ObjectStore } from './object-store.js';

export type { MirrorStatus };
import type { MirrorEntry, WorkspaceRepository } from './workspace-repository.js';

/**
 * Les dossiers jamais copiés : caches reconstructibles (copies Git, dépôt Maven, dépendances,
 * sorties de compilation). Ils peuvent peser des Go et se refont seuls.
 */
export const MIRROR_IGNORED_DIRECTORIES: readonly string[] = [
  '.git-sources',
  '.maven-cache',
  '.git',
  'node_modules',
  'target',
  '.cache',
];

export interface WorkspaceMirrorOptions {
  /** Le dossier de travail (le cache local du conteneur). */
  root: string;
  repository: WorkspaceRepository;
  objects: ObjectStore;
  /** Au-delà, un fichier texte va dans le stockage objet (défaut 256 Kio). */
  maxDocumentBytes?: number;
  /** Intervalle des envois (défaut 10 s). */
  intervalMs?: number;
  /** Un fichier modifié il y a moins que ça est en cours d'écriture : il attend l'envoi suivant (défaut 500 ms). */
  settleMs?: number;
  /** Reprendre le bail d'un serveur arrêté brutalement. */
  takeover?: boolean;
  /** Fichiers à ne jamais copier (chemins absolus) : par exemple la base SQLite si elle est dans le dossier. */
  ignorePaths?: string[];
  onWarning?: (message: string) => void;
  /** Identité du serveur dans le bail (défaut : hôte, pid, aléa). */
  holder?: string;
}

interface LocalFile {
  size: number;
  mtimeMs: number;
  sha256: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Le texte d'un fichier s'il est de l'UTF-8 valide, sans octet nul, et qu'il se relit à l'identique. */
export function documentText(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    return Buffer.from(text, 'utf8').equals(data) ? text : undefined;
  } catch {
    return undefined;
  }
}

async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * STOCKAGE HYBRIDE : le miroir durable du dossier de travail. Le disque du conteneur n'est qu'un cache :
 * au démarrage il est reconstruit depuis la base (fichiers texte) et le stockage objet (fichiers lourds ou
 * binaires) ; ensuite, chaque passage envoie ce qui a été ajouté, modifié ou supprimé ; à l'arrêt, un
 * dernier passage. Un seul serveur écrit un espace à la fois (bail en base). Les objets sont rangés par
 * empreinte : un contenu identique n'est stocké qu'une fois, et un objet n'est supprimé que lorsque plus
 * aucun fichier ne le désigne.
 */
export class WorkspaceMirror {
  readonly root: string;
  private readonly options: WorkspaceMirrorOptions;
  private readonly holder: string;
  private readonly remote = new Map<string, MirrorEntry>();
  private readonly local = new Map<string, LocalFile>();
  private readonly ignored: Set<string>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private leased = false;
  private readonly current: MirrorStatus;

  constructor(options: WorkspaceMirrorOptions) {
    this.options = options;
    this.root = path.resolve(options.root);
    this.holder = options.holder ?? `${hostname()}:${String(process.pid)}:${randomBytes(4).toString('hex')}`;
    this.ignored = new Set((options.ignorePaths ?? []).map((file) => path.resolve(file)));
    this.current = {
      space: options.repository.space,
      objects: options.objects.describe(),
      state: 'STARTING',
      restored: { documents: 0, objects: 0, missing: 0 },
      stored: { documents: 0, objects: 0, bytes: 0 },
      uploaded: 0,
      deleted: 0,
      pending: 0,
    };
  }

  private get intervalMs(): number {
    return this.options.intervalMs ?? 10_000;
  }

  private get leaseMs(): number {
    return Math.max(60_000, this.intervalMs * 6);
  }

  status(): MirrorStatus {
    let documents = 0;
    let objects = 0;
    let bytes = 0;
    for (const entry of this.remote.values()) {
      if (entry.kind === 'document') documents += 1;
      else objects += 1;
      bytes += entry.size;
    }
    return { ...this.current, stored: { documents, objects, bytes }, restored: { ...this.current.restored } };
  }

  private warn(message: string): void {
    this.options.onWarning?.(message);
  }

  private file(relative: string): string {
    return path.join(this.root, ...relative.split('/'));
  }

  private objectKey(hash: string): string {
    return `${this.options.repository.space}/objects/${hash.slice(0, 2)}/${hash}`;
  }

  /**
   * Prendre le bail, vérifier le stockage objet, reconstruire le dossier, puis envoyer périodiquement.
   * Le dossier est restauré AVANT que le serveur ne lise quoi que ce soit.
   */
  async start(): Promise<void> {
    const repository = this.options.repository;
    await repository.acquireLease(this.holder, this.leaseMs, this.options.takeover ?? false);
    this.leased = true;
    await this.options.objects.healthCheck();
    await mkdir(this.root, { recursive: true });
    await this.restore();
    this.current.state = 'RUNNING';
    this.timer = setInterval(() => {
      void this.sync();
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Le dossier depuis le contenu durable : le contenu durable l'emporte sur un fichier local différent. */
  private async restore(): Promise<void> {
    const entries = await this.options.repository.list();
    for (const entry of entries) this.remote.set(entry.path, entry);
    await mapLimited(entries, 8, async (entry) => {
      const target = this.file(entry.path);
      const existing = await readFile(target).catch(() => undefined);
      if (existing && existing.length === entry.size && sha256(existing) === entry.sha256) {
        const info = await stat(target);
        this.local.set(entry.path, { size: info.size, mtimeMs: info.mtimeMs, sha256: entry.sha256 });
        return;
      }
      let data: Buffer | undefined;
      if (entry.kind === 'document') {
        const full = await this.options.repository.read(entry.path);
        data = full?.content !== undefined ? Buffer.from(full.content, 'utf8') : undefined;
      } else if (entry.objectKey) data = await this.options.objects.get(entry.objectKey);
      if (!data || sha256(data) !== entry.sha256) {
        this.current.restored.missing += 1;
        this.warn(
          `storage: ${entry.path} could not be restored (${data ? 'content differs' : 'content missing'})`,
        );
        return;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomBytes(4).toString('hex')}.restore`;
      await writeFile(temporary, data);
      await rename(temporary, target);
      const info = await stat(target);
      this.local.set(entry.path, { size: info.size, mtimeMs: info.mtimeMs, sha256: entry.sha256 });
      if (entry.kind === 'document') this.current.restored.documents += 1;
      else this.current.restored.objects += 1;
    });
  }

  /** Les fichiers du dossier (chemins relatifs « / »), sans les caches ni les liens symboliques. */
  private async walk(): Promise<{ files: string[]; complete: boolean }> {
    const files: string[] = [];
    let complete = true;
    const visit = async (directory: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        complete = false;
        this.warn(`storage: ${prefix || '.'} could not be read (${(error as Error).message})`);
        return;
      }
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (this.ignored.has(absolute)) continue;
        if (entry.isDirectory()) {
          if (!MIRROR_IGNORED_DIRECTORIES.includes(entry.name)) await visit(absolute, relative);
        } else if (entry.isFile() && !/\.(restore|tmp)$/.test(entry.name)) files.push(relative);
      }
    };
    await visit(this.root, '');
    return { files, complete };
  }

  /**
   * Un passage : envoyer les fichiers nouveaux ou modifiés, supprimer ceux qui ont disparu. `now` (demande
   * explicite) : aussi les fichiers modifiés à l'instant, sans attendre qu'ils se stabilisent.
   */
  async sync(options: { now?: boolean } = {}): Promise<void> {
    if (this.running) await this.running;
    if (this.running) return this.running;
    this.running = this.pass(options.now ?? false).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** `final` (arrêt) : tout est envoyé, même un fichier modifié à l'instant. */
  private async pass(final = false): Promise<void> {
    if (this.current.state === 'LEASE_LOST' || this.current.state === 'STOPPED') return;
    const started = Date.now();
    const repository = this.options.repository;
    try {
      if (!(await repository.holdsLease(this.holder))) {
        this.current.state = 'LEASE_LOST';
        this.current.lastError =
          'the write lease was taken by another server: this server no longer saves its workspace';
        this.warn(`storage: ${this.current.lastError}`);
        return;
      }
      await repository.acquireLease(this.holder, this.leaseMs);
      const { files, complete } = await this.walk();
      const seen = new Set(files);
      const settle = final ? 0 : (this.options.settleMs ?? 500);
      let pending = 0;
      const errors: string[] = [];
      for (const relative of files) {
        try {
          const absolute = this.file(relative);
          const info = await stat(absolute);
          const known = this.local.get(relative);
          if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) {
            if (this.remote.get(relative)?.sha256 === known.sha256) continue;
          }
          if (Date.now() - info.mtimeMs < settle) {
            pending += 1;
            continue;
          }
          const data = await readFile(absolute);
          const hash = sha256(data);
          this.local.set(relative, { size: info.size, mtimeMs: info.mtimeMs, sha256: hash });
          const previous = this.remote.get(relative);
          if (previous?.sha256 === hash) continue;
          await this.upload(relative, data, hash, previous);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          errors.push(`${relative}: ${(error as Error).message}`);
        }
      }
      // Une suppression n'est envoyée que si le dossier a été lu en entier (jamais sur une lecture partielle).
      if (complete)
        for (const [relative, entry] of [...this.remote]) {
          if (seen.has(relative) || this.isIgnored(relative)) continue;
          try {
            await repository.remove(relative);
            this.remote.delete(relative);
            this.local.delete(relative);
            this.current.deleted += 1;
            if (entry.kind === 'object' && entry.objectKey) await this.collect(entry.objectKey);
          } catch (error) {
            errors.push(`${relative}: ${(error as Error).message}`);
          }
        }
      this.current.pending = pending;
      this.current.lastSyncAt = new Date().toISOString();
      this.current.lastSyncMs = Date.now() - started;
      if (errors.length > 0) {
        this.current.lastError = `${String(errors.length)} file(s) not saved: ${errors.slice(0, 3).join('; ')}`;
        this.warn(`storage: ${this.current.lastError}`);
      } else delete this.current.lastError;
    } catch (error) {
      this.current.lastError = (error as Error).message;
      this.warn(`storage: sync failed (${this.current.lastError})`);
    }
  }

  private isIgnored(relative: string): boolean {
    return relative.split('/').some((segment) => MIRROR_IGNORED_DIRECTORIES.includes(segment));
  }

  private async upload(relative: string, data: Buffer, hash: string, previous?: MirrorEntry): Promise<void> {
    const repository = this.options.repository;
    const text =
      data.length <= (this.options.maxDocumentBytes ?? 256 * 1024) ? documentText(data) : undefined;
    let entry: MirrorEntry;
    if (text !== undefined) {
      entry = {
        path: relative,
        kind: 'document',
        sha256: hash,
        size: data.length,
        content: text,
        updatedAt: new Date().toISOString(),
      };
      await repository.upsert(entry);
    } else {
      const key = this.objectKey(hash);
      const type = CONTENT_TYPES[path.extname(relative).toLowerCase()] ?? 'application/octet-stream';
      // L'objet d'abord, l'index ensuite : l'index ne désigne jamais un objet absent.
      await this.options.objects.put(key, data, type);
      entry = {
        path: relative,
        kind: 'object',
        sha256: hash,
        size: data.length,
        objectKey: key,
        updatedAt: new Date().toISOString(),
      };
      await repository.upsert(entry);
    }
    const { content: _content, ...indexed } = entry;
    this.remote.set(relative, indexed);
    this.current.uploaded += 1;
    if (previous?.kind === 'object' && previous.objectKey && previous.objectKey !== entry.objectKey)
      await this.collect(previous.objectKey);
  }

  /** Supprimer un objet que plus aucun fichier de l'espace ne désigne. */
  private async collect(objectKey: string): Promise<void> {
    if ((await this.options.repository.objectReferences(objectKey)) === 0)
      await this.options.objects.delete(objectKey);
  }

  /**
   * Arrêt : dernier passage complet, bail rendu, base fermée. Si le dernier passage n'a pas tout
   * enregistré, l'erreur est levée après la fermeture (le serveur ne s'arrête pas en silence).
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.running) await this.running;
    let failure: string | undefined;
    if (this.current.state === 'RUNNING') {
      await this.pass(true);
      failure = this.current.lastError;
    }
    // Aussi après un démarrage manqué : le bail pris est rendu tout de suite (pas d'attente d'expiration).
    if (this.leased && this.current.state !== 'LEASE_LOST')
      await this.options.repository.releaseLease(this.holder).catch(() => undefined);
    this.leased = false;
    if (this.current.state !== 'STOPPED')
      this.current.state = this.current.state === 'LEASE_LOST' ? 'LEASE_LOST' : 'STOPPED';
    await this.options.repository.close().catch(() => undefined);
    if (failure) throw new Error(`the last save before stopping is incomplete: ${failure}`);
  }
}
