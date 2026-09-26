import { createHash } from 'node:crypto';
import type { QueryParamMode } from '../config/config.js';
import { routeKey } from '../crawler/route-normalizer.js';
import { normalizeUrl } from '../crawler/url-normalizer.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';

/** What distinguishes a state on its screen: open dialog, selected tab, or second heading (wizard step). */
export function stateSubtitle(snapshot: UiSnapshot): string | undefined {
  return snapshot.dialogs[0] ?? snapshot.selectedTabs[0] ?? snapshot.headings[1];
}

export interface DetectedState {
  /** Stable id: readable slug + fingerprint hash, e.g. "users-list-3fa2c1d0". */
  stateId: string;
  /** Readable part, e.g. "users-list". */
  label: string;
  route: string;
  /** Everything that went into the fingerprint (kept for debugging). */
  signature: string[];
}

/** Roles whose presence and names describe what a screen *is* (links excluded: they are mostly data). */
const STRUCTURAL_ROLES = new Set([
  'button',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'checkbox',
  'radio',
  'slider',
]);

/**
 * Decides whether two observations are the same functional state.
 *
 * The URL alone is not enough: /dossiers/create can show step 1, 2 and 3
 * without changing, and a tab switch or a dialog changes the screen but not
 * the route. The fingerprint combines:
 *   route pattern · title · headings · open dialogs · selected tabs ·
 *   aria-current items · visible controls (role + name) · form fields
 * with numbers masked, so /users/1 and /users/2 ("Utilisateur 1/2") are one
 * state while "Étape 1" and "Étape 2" of a wizard differ through their
 * fields and buttons.
 */
export class StateDetector {
  constructor(
    private readonly queryParamMode: QueryParamMode,
    /** Tracking/cache-buster params ignored when comparing URLs (utm_*…). */
    private readonly ignoredParams: readonly string[] = [],
  ) {}

  detect(snapshot: UiSnapshot): DetectedState {
    const route = safeRouteKey(snapshot.url, this.queryParamMode, this.ignoredParams);
    const controls = [
      ...new Set(
        snapshot.elements
          .filter((element) => STRUCTURAL_ROLES.has(element.role) && !element.inNavigation)
          .map(
            (element) => `${element.role}:${mask(element.name || element.fieldName || element.label || '')}`,
          ),
      ),
    ].sort();
    const signature = [
      `route=${route}`,
      `title=${mask(snapshot.title)}`,
      `headings=${snapshot.headings.slice(0, 6).map(mask).join('|')}`,
      `dialogs=${snapshot.dialogs.map(mask).join('|')}`,
      `tabs=${snapshot.selectedTabs.map(mask).join('|')}`,
      `current=${snapshot.currentItems.map(mask).join('|')}`,
      `controls=${controls.join('|')}`,
    ];
    const hash = createHash('sha1').update(signature.join('\n')).digest('hex').slice(0, 8);
    const label = stateLabel(snapshot, route);
    return { stateId: `${label}-${hash}`, label, route, signature };
  }
}

/** Masks digits so record ids, counters and dates do not create new states. */
function mask(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function safeRouteKey(url: string, mode: QueryParamMode, ignoredParams: readonly string[]): string {
  try {
    return routeKey(normalizeUrl(url, { queryParamMode: mode, ignoredParams }), mode);
  } catch {
    return url;
  }
}

/** "Utilisateurs" + tab "Profil" → "utilisateurs-profil"; falls back on the route. */
function stateLabel(snapshot: UiSnapshot, route: string): string {
  const base = snapshot.headings[0] ?? snapshot.title;
  const parts = [base || route.replace(/[/:?&]+/g, ' ')];
  const subtitle = stateSubtitle(snapshot);
  if (subtitle && subtitle !== base) parts.push(subtitle);
  const slug = parts
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Record ids, UUIDs, counters: words containing digits do not name a screen.
    .split(/\s+/)
    .filter((word) => !/\d/.test(word))
    .join(' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'home';
}
