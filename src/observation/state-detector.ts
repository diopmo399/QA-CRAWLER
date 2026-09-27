import { createHash } from 'node:crypto';
import type { QueryParamMode } from '../config/config.js';
import { routeKey } from '../crawler/route-normalizer.js';
import { normalizeUrl } from '../crawler/url-normalizer.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';

/** Ce qui distingue un état sur son écran : fenêtre ouverte, onglet sélectionné, ou second titre (étape d'assistant). */
export function stateSubtitle(snapshot: UiSnapshot): string | undefined {
  return snapshot.dialogs[0] ?? snapshot.overlay ?? snapshot.selectedTabs[0] ?? snapshot.headings[1];
}

export interface DetectedState {
  /** Id stable : slug lisible + empreinte, par exemple "users-list-3fa2c1d0". */
  stateId: string;
  /** Partie lisible, par exemple "users-list". */
  label: string;
  route: string;
  /** Tout ce qui a servi à l'empreinte (gardé pour le débogage). */
  signature: string[];
}

/** Rôles dont la présence et les noms décrivent ce qu'*est* un écran (liens exclus : ce sont surtout des données). */
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
 * Décide si deux observations sont le même état fonctionnel.
 *
 * L'URL seule ne suffit pas : /dossiers/create peut montrer les étapes 1, 2 et 3
 * sans changer, et un changement d'onglet ou une fenêtre change l'écran mais pas
 * la route. L'empreinte combine :
 *   modèle de route · titre · titres · fenêtres ouvertes · onglets sélectionnés ·
 *   éléments aria-current · contrôles visibles (rôle + nom) · champs de formulaire
 * avec les nombres masqués : /users/1 et /users/2 (« Utilisateur 1/2 ») sont un seul
 * état, alors que « Étape 1 » et « Étape 2 » d'un assistant diffèrent par leurs
 * champs et leurs boutons.
 */
export class StateDetector {
  constructor(
    private readonly queryParamMode: QueryParamMode,
    /** Paramètres de suivi / anti-cache ignorés en comparant des URL (utm_*…). */
    private readonly ignoredParams: readonly string[] = [],
  ) {}

  detect(snapshot: UiSnapshot): DetectedState {
    const route = safeRouteKey(snapshot.url, this.queryParamMode, this.ignoredParams);
    const controls = [
      ...new Set(
        snapshot.elements
          .filter(
            // Toasts, zones live et minuteurs vont et viennent : ils ne font pas un autre écran.
            (element) => STRUCTURAL_ROLES.has(element.role) && !element.inNavigation && !element.transient,
          )
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
      // Seulement quand il y en a un : les états sans calque gardent leur id.
      ...(snapshot.overlay !== undefined ? [`overlay=${mask(snapshot.overlay)}`] : []),
    ];
    const hash = createHash('sha1').update(signature.join('\n')).digest('hex').slice(0, 8);
    const label = stateLabel(snapshot, route);
    return { stateId: `${label}-${hash}`, label, route, signature };
  }
}

/**
 * Ne garde que ce qui nomme un écran : les id générés (UUID, empreintes, jetons),
 * e-mails, dates, heures, compteurs et id d'enregistrement sont masqués, pour que le
 * même écran ait la même empreinte quelles que soient les données qu'il affiche.
 */
export function mask(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b(?=[a-z0-9_-]*\d)[a-z0-9_-]{16,}\b/g, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeRouteKey(url: string, mode: QueryParamMode, ignoredParams: readonly string[]): string {
  try {
    return routeKey(normalizeUrl(url, { queryParamMode: mode, ignoredParams }), mode);
  } catch {
    return url;
  }
}

/** "Utilisateurs" + onglet "Profil" → "utilisateurs-profil" ; à défaut, la route. */
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
    // Id d'enregistrement, UUID, compteurs, e-mails : les mots qui contiennent des chiffres ou @ ne nomment pas un écran.
    .split(/\s+/)
    .filter((word) => !/\d/.test(word) && !word.includes('@'))
    .join(' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'home';
}
