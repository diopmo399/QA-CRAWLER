import { effectivePath } from '../crawler/url-normalizer.js';
import type { DiscoveredAction } from '../model/discovered-action.js';

/**
 * Où `thenExplore` peut aller : le dernier écran du flow et les pages sous lui
 * (/admin/fideles → /admin/fideles, /admin/fideles/12…). Le menu global et les
 * liens ailleurs sont laissés à l'exploration autonome.
 */
export interface ExplorationScope {
  /** Préfixe de chemin, sans barre oblique finale ('' pour la racine du site). */
  path: string;
}

export function scopeOf(url: string): ExplorationScope {
  return { path: pathOf(url).replace(/\/+$/, '') };
}

export function isInScope(scope: ExplorationScope, url: string): boolean {
  const path = pathOf(url).replace(/\/+$/, '');
  return path === scope.path || path.startsWith(`${scope.path}/`);
}

/** Actions qui gardent l'exploration dans le périmètre : contrôles de la page et liens vers les pages sous lui. */
export function actionsInScope(
  scope: ExplorationScope,
  actions: readonly DiscoveredAction[],
): DiscoveredAction[] {
  return actions.filter((action) => {
    if (action.category === 'menu') return false;
    if (action.type !== 'navigate') return true;
    return action.href !== undefined && isInScope(scope, action.href);
  });
}

function pathOf(url: string): string {
  try {
    return effectivePath(url);
  } catch {
    return url;
  }
}
