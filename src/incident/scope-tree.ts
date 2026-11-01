import path from 'node:path';
import type { DirectoryNode, DirectoryListing } from './guarded-fs.js';
import type { ScopeApplication, ScopeTree, ScopeTreeNode } from './model.js';

/**
 * L'ARBORESCENCE POUR CHOISIR LE PÉRIMÈTRE : les dossiers lus (par le Scope Policy Engine, voir
 * guarded-fs.listDirectories) et, pour chacun, s'il est déjà inclus — lui-même ou un dossier parent
 * figure dans `repository.include` ; une liste vide inclut toute la racine.
 */

/** Un dossier inclus, normalisé (« / », sans « ./ » ni « / » final) ; « » pour toute la racine. */
export function normalizeInclude(entry: string): string {
  const normalized = path.posix.normalize(entry.replace(/\\/g, '/')).replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

export function isIncluded(relative: string, include: readonly string[]): boolean {
  if (include.length === 0) return true;
  return include
    .map(normalizeInclude)
    .some((entry) => entry === '' || relative === entry || relative.startsWith(`${entry}/`));
}

export function scopeTreeOf(
  application: ScopeApplication,
  listing: DirectoryListing,
  depth: number,
): ScopeTree {
  const include = application.repository.include;
  const convert = (node: DirectoryNode): ScopeTreeNode => ({
    path: node.path,
    name: node.name,
    included: isIncluded(node.path, include),
    children: node.children.map(convert),
    ...(node.truncated ? { truncated: true } : {}),
  });
  return {
    applicationId: application.id,
    root: convert(listing.root),
    depth,
    ...(listing.capped ? { capped: true } : {}),
  };
}
