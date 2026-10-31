import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PolicyDecision } from './model.js';
import { ScopeDeniedError, type ScopePolicy } from './scope-policy.js';

/**
 * LES FICHIERS GARDÉS : le seul accès de l'investigation au code. Chaque lecture et chaque dossier
 * parcouru passent par le Scope Policy Engine ; les refus et les limites atteintes sont conservés
 * pour que l'analyse dise ce qu'elle n'a pas pu voir.
 */
export interface GuardedFiles {
  /** Lecture autorisée (READ_FILE) et décomptée du budget de fichiers ; lève ScopeDeniedError sinon. */
  readText(path: string): Promise<string>;
  /** Fichiers (chemins absolus, triés) portant l'une des extensions, sous `root`, dans le périmètre. */
  list(root: string, options: { extensions: string[] }): Promise<string[]>;
  readonly denied: { path: string; reason: string }[];
  readonly truncated: string[];
}

/** Dossiers jamais parcourus : dépendances, sorties de build, métadonnées de gestion de versions. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'target',
  'build',
  'dist',
  '.gradle',
  '.svn',
  '.hg',
]);

/** Refus attendus pendant un parcours (hors des dossiers inclus) : ils ne sont pas des refus à signaler. */
const SILENT_RULES = new Set(['path.outside-include']);

export function guardedFiles(policy: ScopePolicy): GuardedFiles {
  const denied: { path: string; reason: string }[] = [];
  const truncated: string[] = [];
  const seenDenied = new Set<string>();

  const recordDenied = (file: string, decision: PolicyDecision): void => {
    if (seenDenied.has(file)) return;
    seenDenied.add(file);
    denied.push({ path: file, reason: `${decision.rule} : ${decision.reason}` });
  };
  const recordTruncated = (message: string): void => {
    if (!truncated.includes(message)) truncated.push(message);
  };

  async function readText(file: string): Promise<string> {
    const decision = await policy.check({ kind: 'READ_FILE', path: file });
    if (!decision.allowed) {
      recordDenied(file, decision);
      throw new ScopeDeniedError(decision);
    }
    if (!policy.consume('file')) {
      const budget: PolicyDecision = {
        allowed: false,
        rule: 'limits.maxFiles',
        reason: `Budget de lecture épuisé (${policy.scope.limits.maxFiles} fichiers).`,
        operation: { kind: 'READ_FILE', path: file },
      };
      recordTruncated(budget.reason);
      throw new ScopeDeniedError(budget);
    }
    // Lecture du chemin réel validé (et non du chemin demandé, qui pourrait avoir changé entre-temps).
    const content = await readFile(decision.resolvedPath ?? file);
    if (content.byteLength > policy.scope.limits.maxFileBytes) {
      const tooLarge: PolicyDecision = {
        allowed: false,
        rule: 'limits.maxFileBytes',
        reason: `« ${file} » dépasse la limite de ${policy.scope.limits.maxFileBytes} octets.`,
        operation: { kind: 'READ_FILE', path: file },
      };
      recordDenied(file, tooLarge);
      throw new ScopeDeniedError(tooLarge);
    }
    return content.toString('utf8');
  }

  async function list(root: string, options: { extensions: string[] }): Promise<string[]> {
    const extensions = new Set(
      options.extensions.map((extension) =>
        (extension.startsWith('.') ? extension : `.${extension}`).toLowerCase(),
      ),
    );
    const limit = policy.scope.limits.maxFiles;
    const found: string[] = [];
    const visited = new Set<string>();
    let stopped = false;

    const start = await policy.check({ kind: 'LIST_DIR', path: root });
    if (!start.allowed || start.resolvedPath === undefined) {
      recordDenied(root, start);
      return [];
    }

    const accept = async (file: string): Promise<void> => {
      if (!extensions.has(path.extname(file).toLowerCase())) return;
      const decision = await policy.check({ kind: 'READ_FILE', path: file });
      if (!decision.allowed) {
        if (!SILENT_RULES.has(decision.rule)) recordDenied(file, decision);
        return;
      }
      if (found.length >= limit) {
        stopped = true;
        recordTruncated(`${root} : limite de ${limit} fichiers atteinte, la liste est partielle.`);
        return;
      }
      found.push(file);
    };

    const walk = async (directory: string, real: string): Promise<void> => {
      if (visited.has(real)) return;
      visited.add(real);
      let entries;
      try {
        entries = await readdir(real, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (stopped) return;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
          const decision = await policy.check({ kind: 'LIST_DIR', path: full });
          if (decision.allowed && decision.resolvedPath !== undefined)
            await walk(full, decision.resolvedPath);
          else if (!SILENT_RULES.has(decision.rule)) recordDenied(full, decision);
        } else if (entry.isSymbolicLink()) {
          let target;
          try {
            target = await stat(full);
          } catch {
            continue;
          }
          if (target.isDirectory()) {
            // Un dossier lié n'est pas suivi (boucles, doublons) ; un lien qui sort du périmètre est signalé.
            if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
            const decision = await policy.check({ kind: 'LIST_DIR', path: full });
            if (!decision.allowed && !SILENT_RULES.has(decision.rule)) recordDenied(full, decision);
          } else if (target.isFile()) {
            await accept(full);
          }
        } else if (entry.isFile()) {
          await accept(full);
        }
      }
    };

    await walk(path.resolve(root), start.resolvedPath);
    return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  return {
    readText,
    list,
    get denied() {
      return denied;
    },
    get truncated() {
      return truncated;
    },
  };
}
