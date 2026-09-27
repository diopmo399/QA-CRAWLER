import { actionLabel, type DiscoveredAction } from '../model/discovered-action.js';
import { normalizeText } from '../policies/keywords.js';

/**
 * Signatures stables d'un run à l'autre (les id d'état et d'action sont des empreintes
 * qui changent avec la page) : « click:creer-utilisateur », « users-list ». Les nombres
 * sont masqués, jamais une valeur saisie n'y entre.
 */
export function actionSignature(
  action: Pick<DiscoveredAction, 'type' | 'text' | 'label' | 'name' | 'elementType' | 'href'>,
): string {
  const label = slug(actionLabel(action)) || slug(hrefPath(action.href)) || action.elementType;
  return `${action.type}:${label}`;
}

/** La signature d'un écran : son libellé d'état (« utilisateurs », « users-list »), déjà sans nombres. */
export function stateSignature(stateLabel: string): string {
  return slug(stateLabel) || 'home';
}

export function slug(text: string): string {
  return normalizeText(text)
    .replace(/\d+/g, '#')
    .replace(/[^a-z#]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function hrefPath(href: string | undefined): string {
  if (!href) return '';
  try {
    return new URL(href).pathname;
  } catch {
    return href;
  }
}
