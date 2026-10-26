/**
 * SALESFORCE LIGHTNING : ce que le profil de plateforme `salesforce-lightning` change dans le moteur.
 *
 * Lightning Experience parle au serveur par le framework Aura : presque toutes ses LECTURES sont des
 * `POST /aura` (une liste d'actions dans le paramètre `message`). Sans ce profil, la garde
 * d'écriture annule ces POST et les écrans restent sans données. Avec lui, un `POST /aura` passe
 * seulement quand TOUTES ses actions sont des lectures, reconnues au nom de la méthode
 * (`getRecordWithFields`, `getListUi`, `loadItems`…) ; une écriture (`updateRecord`, `createRecord`,
 * `saveX`, `submitX`), une méthode au nom inconnu ou un corps illisible restent bloqués et signalés.
 *
 * C'est une heuristique sur les noms : une méthode Apex nommée `getX` qui écrirait passerait. Les
 * écritures attendues s'autorisent explicitement (`safety.writeGuard.allow`) ; les autres apparaissent
 * dans le rapport des écritures bloquées.
 *
 * Construit à partir du fonctionnement documenté de Lightning, vérifié sur une application locale qui
 * l'imite (tests/fixtures/lightning-app.ts) : JAMAIS validé sur une vraie organisation Salesforce.
 */

export const PLATFORMS = ['generic', 'salesforce-lightning'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** `/aura` (Lightning Experience) et `/s/sfsites/aura`, `/sfsites/aura` (sites Experience Cloud). */
const AURA_PATH = /(^|\/)(sfsites\/)?aura\/?$/i;
/** L'API GraphQL de l'UI API : `query` lit, `mutation` écrit. */
const GRAPHQL_PATH = /^\/services\/data\/v\d+(\.\d+)?\/graphql\/?$/i;
/** Une méthode d'action qui lit : le verbe d'en-tête, suivi d'une majuscule, d'un « _ » ou de rien. */
const READ_METHOD =
  /^(get|load|fetch|search|find|query|list|retrieve|describe|count|lookup|read|has|is|check|resolve)(?=[A-Z0-9_]|$)/;

export interface AuraAction {
  descriptor: string;
  /** Le nom de la méthode (après `ACTION$`), vide si le descripteur n'en porte pas. */
  method: string;
  read: boolean;
}

/** Les actions d'un corps `POST /aura` ; undefined si le corps n'en est pas un (illisible : bloqué). */
export function auraActions(body: string | null | undefined): AuraAction[] | undefined {
  if (!body) return undefined;
  let message: string | null;
  try {
    message = new URLSearchParams(body).get('message');
  } catch {
    return undefined;
  }
  if (!message) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  const actions = (parsed as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return undefined;
  const result: AuraAction[] = [];
  for (const action of actions) {
    const descriptor = (action as { descriptor?: unknown } | null)?.descriptor;
    if (typeof descriptor !== 'string') return undefined;
    const method = descriptor.split('ACTION$')[1] ?? '';
    result.push({ descriptor, method, read: READ_METHOD.test(method) });
  }
  return result;
}

/** Une requête GraphQL qui ne déclare que des lectures (aucune opération `mutation`). */
export function isGraphqlRead(body: string | null | undefined): boolean {
  if (!body) return false;
  let query: unknown;
  try {
    query = (JSON.parse(body) as { query?: unknown } | null)?.query;
  } catch {
    return false;
  }
  if (typeof query !== 'string') return false;
  const code = query.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return !/(^|[\s}])mutation\b/.test(code);
}

/**
 * Le POST de lecture de Lightning que la garde d'écriture laisse passer : `/aura` dont toutes les
 * actions lisent, ou une requête GraphQL sans mutation. Tout le reste est décidé par la garde.
 */
export function lightningReadOnlyPost(pathname: string, body: string | null | undefined): boolean {
  if (AURA_PATH.test(pathname)) {
    const actions = auraActions(body);
    return actions !== undefined && actions.every((action) => action.read);
  }
  if (GRAPHQL_PATH.test(pathname)) return isGraphqlRead(body);
  return false;
}

/** Le POST de lecture admis par la plateforme, quand elle en a un. */
export function readOnlyPostOf(
  platform: Platform,
): ((pathname: string, body: string | null | undefined) => boolean) | undefined {
  return platform === 'salesforce-lightning' ? lightningReadOnlyPost : undefined;
}
