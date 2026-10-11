import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import type { AuthSessionConfig } from '../config/config.js';

/**
 * AUTHENTICATION SESSION PROVIDER : la session d'un acteur (cookies, stockage local — le
 * storageState de Playwright) survit d'un run à l'autre dans un fichier, hors du dépôt.
 *
 *   SESSION_NEW      aucune session gardée : connexion, puis enregistrement ;
 *   SESSION_REUSE    une session valide a été rechargée, aucune connexion n'a été faite ;
 *   SESSION_RECORD   la connexion vient d'être faite et la session enregistrée ;
 *   SESSION_EXPIRED  la session gardée était trop vieille ou refusée par l'application :
 *                    connexion à nouveau, puis enregistrement.
 *
 * Le fichier contient des cookies de session : il n'est jamais écrit dans un rapport, jamais
 * journalisé, et son contenu n'est jamais lu par le crawler (seulement passé à Playwright).
 */
export const SESSION_STATUSES = [
  'SESSION_NEW',
  'SESSION_REUSE',
  'SESSION_RECORD',
  'SESSION_EXPIRED',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionReport {
  status: SessionStatus;
  /** Chemin du fichier (jamais son contenu). */
  file: string;
  ageMinutes?: number;
  reason?: string;
}

export class AuthenticationSessionProvider {
  readonly file: string;
  private status: SessionStatus = 'SESSION_NEW';
  private ageMinutes: number | undefined;
  private reason: string | undefined;
  private reusable = false;

  constructor(
    private readonly config: AuthSessionConfig,
    actor: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file =
      config.file ?? path.join('.qa-crawler', 'sessions', `${actor.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  /** Options du contexte : la session gardée, quand elle existe et n'a pas expiré. */
  async contextOptions(): Promise<BrowserContextOptions> {
    if (!this.config.reuse) return {};
    try {
      const info = await stat(this.file);
      this.ageMinutes = Math.round((this.now() - info.mtimeMs) / 60_000);
      if (this.ageMinutes > this.config.maxAgeMinutes) {
        this.status = 'SESSION_EXPIRED';
        this.reason = `stored session is ${String(this.ageMinutes)} min old (max ${String(this.config.maxAgeMinutes)})`;
        return {};
      }
      // Le fichier est lu seulement pour vérifier qu'il est un JSON : son contenu reste opaque.
      JSON.parse(await readFile(this.file, 'utf8'));
      this.reusable = true;
      this.status = 'SESSION_REUSE';
      return { storageState: this.file };
    } catch {
      this.status = 'SESSION_NEW';
      return {};
    }
  }

  /** La session rechargée est-elle candidate à la réutilisation (connexion à éviter) ? */
  get canReuse(): boolean {
    return this.reusable;
  }

  /** L'application a renvoyé vers la connexion malgré la session rechargée. */
  markExpired(reason: string): void {
    this.reusable = false;
    this.status = 'SESSION_EXPIRED';
    this.reason = reason;
  }

  /** Après une connexion réussie : la session est enregistrée pour le run suivant. */
  async save(page: Page): Promise<void> {
    if (!this.config.reuse) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    await page.context().storageState({ path: this.file });
    if (this.status === 'SESSION_REUSE') return;
    this.status = this.status === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : 'SESSION_RECORD';
  }

  report(): SessionReport {
    return {
      status: this.status,
      file: this.file,
      ...(this.ageMinutes !== undefined ? { ageMinutes: this.ageMinutes } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}

/** Écrit un storageState vide (tests, amorçage) sans passer par un navigateur. */
export async function writeEmptySession(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
}
