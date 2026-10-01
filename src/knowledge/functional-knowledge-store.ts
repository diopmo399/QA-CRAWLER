import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../memory/atomic-write.js';
import { sha256 } from '../static-analysis/source-set.js';
import type { RuleIdentity } from './rule-knowledge-store.js';

/** Ce qu'un run précédent a appris d'une connaissance fonctionnelle (transition, workflow, objectif…). */
export interface RememberedFunctional {
  /** STATE_TRANSITION:REGISTRATION:PENDING>APPROVED:approve, WORKFLOW:CREATE:USER… */
  id: string;
  kind: 'TRANSITION' | 'WORKFLOW' | 'INVARIANT' | 'ERROR_PATH' | 'GOAL';
  status: string;
  confirmations: number;
  failures: number;
  /** La route où l'objectif a été réalisé et le nombre d'étapes (chemin historique du planificateur). */
  route?: string;
  steps?: number;
  lastSeenAt?: string;
  version?: string;
  commit?: string;
  environment?: string;
}

/**
 * FUNCTIONAL KNOWLEDGE : transitions métier, workflows, invariants, chemins d'erreur et
 * objectifs, gardés d'un run à l'autre (knowledge/functional/, un JSON par application
 * et environnement), à côté de la connaissance des règles.
 *
 * L'HISTORIQUE N'EST JAMAIS UNE PREUVE : il aide à PLANIFIER (un chemin déjà emprunté)
 * et à afficher (« confirmée en 1.4.0 ») ; une transition reste non vérifiée tant que
 * le runtime courant ne l'a pas observée. Aucune valeur saisie n'est gardée.
 */
export class FunctionalKnowledgeStore {
  private remembered = new Map<string, RememberedFunctional>();

  constructor(
    private readonly directory: string,
    private readonly identity: RuleIdentity,
  ) {}

  private file(): string {
    const key = sha256(`${this.identity.application}\n${this.identity.environment ?? ''}`).slice(0, 24);
    return path.join(this.directory, `functional-${key}.json`);
  }

  async load(): Promise<void> {
    const text = await readFile(this.file(), 'utf8').catch(() => undefined);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { entries?: RememberedFunctional[] };
      this.remembered = new Map((parsed.entries ?? []).map((entry) => [entry.id, entry]));
    } catch {
      this.remembered = new Map();
    }
  }

  recall(id: string): (RememberedFunctional & { sameVersion: boolean }) | undefined {
    const entry = this.remembered.get(id);
    if (!entry) return undefined;
    const mine = this.identity.commit ?? this.identity.version ?? this.identity.sourceHash;
    const theirs = entry.commit ?? entry.version;
    return { ...entry, sameVersion: mine !== undefined && theirs === mine };
  }

  /** Un run précédent a atteint cette route (étapes) : une piste pour le planificateur. */
  routeSteps(route: string): number | undefined {
    let best: number | undefined;
    for (const entry of this.remembered.values())
      if (entry.route === route && entry.steps !== undefined)
        best = Math.min(best ?? entry.steps, entry.steps);
    return best;
  }

  /** Les statuts de ce run ; ce qui n'a pas été revu garde son historique. */
  async save(
    entries: readonly Omit<RememberedFunctional, 'confirmations' | 'failures' | 'lastSeenAt'>[],
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const entry of entries) {
      const previous = this.remembered.get(entry.id);
      const confirmed = /CONFIRMED|VERIFIED/.test(entry.status);
      const failed = /CONTRADICTED|VIOLATED|FAILED/.test(entry.status);
      const runtime = confirmed || failed || entry.status === 'RUNTIME_OBSERVED';
      this.remembered.set(entry.id, {
        ...(previous ?? {}),
        id: entry.id,
        kind: entry.kind,
        status: runtime || !previous ? entry.status : previous.status,
        confirmations: (previous?.confirmations ?? 0) + (confirmed ? 1 : 0),
        failures: (previous?.failures ?? 0) + (failed ? 1 : 0),
        ...(entry.route ? { route: entry.route } : {}),
        ...(entry.steps !== undefined ? { steps: entry.steps } : {}),
        ...(runtime
          ? {
              lastSeenAt: now,
              ...(this.identity.version ? { version: this.identity.version } : {}),
              ...(this.identity.commit ? { commit: this.identity.commit } : {}),
              ...(this.identity.environment ? { environment: this.identity.environment } : {}),
            }
          : {}),
      });
    }
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(
      this.file(),
      `${JSON.stringify({ application: this.identity.application, entries: [...this.remembered.values()].slice(-3000) }, null, 2)}\n`,
    );
  }
}
