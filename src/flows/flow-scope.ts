import { effectivePath } from '../crawler/url-normalizer.js';
import type { DiscoveredAction } from '../model/discovered-action.js';

/**
 * Where `thenExplore` may go: the flow's last screen and the pages below it
 * (/admin/fideles → /admin/fideles, /admin/fideles/12…). The global menu and
 * links elsewhere are left to the autonomous exploration.
 */
export interface ExplorationScope {
  /** Path prefix, without trailing slash ('' for the site root). */
  path: string;
}

export function scopeOf(url: string): ExplorationScope {
  return { path: pathOf(url).replace(/\/+$/, '') };
}

export function isInScope(scope: ExplorationScope, url: string): boolean {
  const path = pathOf(url).replace(/\/+$/, '');
  return path === scope.path || path.startsWith(`${scope.path}/`);
}

/** Actions that keep the exploration inside the scope: in-page controls and links to pages below it. */
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
