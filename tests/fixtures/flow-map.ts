import type { ExplorationResult } from '../../src/model/exploration-result.js';

/**
 * Des parcours fictifs pour la carte des écrans visités : écrans, transitions exécutées (avec ou sans
 * verdict des oracles) et anomalies. Données neutres.
 */
export const screen = (id: string, heading = id, route = `/${id}`, screenshot?: string) => ({
  id,
  label: id,
  url: `http://app.test${route}`,
  route,
  headings: [heading],
  depth: 0,
  discoveredActions: [],
  actions: {},
  firstSeenAt: '',
  lastSeenAt: '',
  visits: 1,
  issueIds: [],
  ...(screenshot ? { screenshot } : {}),
});

export const move = (
  from: string,
  to: string,
  text: string,
  status?: 'PASS' | 'FAIL' | 'WARNING' | 'UNKNOWN',
  result: 'SUCCESS' | 'FAILED' | 'BLOCKED' = 'SUCCESS',
) => ({
  from,
  to,
  actionId: `${from}>${to}>${text}`,
  action: { type: 'click', category: 'navigation', text, classification: 'SAFE' },
  result,
  timestamp: '',
  issueIds: [],
  ...(status
    ? {
        oracle: {
          status,
          confidence: 1,
          reasons: [],
          results: [],
          assertions:
            status === 'PASS'
              ? ['✓ no HTTP 5xx', '✓ heading shown']
              : ['✗ POST /api/items returned HTTP 500'],
        },
      }
    : {}),
});

export const issue = (
  id: string,
  state: string,
  severity: 'ERROR' | 'WARNING' | 'CRITICAL' | 'INFO',
  message: string,
) => ({
  id,
  type: 'CONSOLE',
  severity,
  states: [state],
  message,
});

export function journeyOf(
  states: ReturnType<typeof screen>[],
  transitions: ReturnType<typeof move>[],
  issues: ReturnType<typeof issue>[] = [],
): ExplorationResult {
  return {
    mission: 'carte',
    target: { startUrl: 'http://app.test/' },
    states,
    transitions,
    issues,
    stats: { states: states.length, actionsBlocked: 0, actionsFailed: 0, maxDepth: 4 },
  } as unknown as ExplorationResult;
}

/** Un parcours linéaire de n écrans. */
export function linear(count: number): ExplorationResult {
  const ids = Array.from({ length: count }, (_, index) => `s${String(index)}`);
  return journeyOf(
    ids.map((id) => screen(id, `Écran ${id}`)),
    ids.slice(1).map((id, index) => move(ids[index] ?? '', id, `Suivant ${id}`, 'PASS')),
  );
}

/**
 * Un parcours ramifié : branches alternatives, plusieurs départs d'un même écran, plusieurs arrivées sur
 * un même écran, retours en arrière, un cycle, des libellés et une adresse longs, tous les statuts.
 */
export function branching(): ExplorationResult {
  return journeyOf(
    [
      screen('home', 'Accueil', '/'),
      screen('items', 'Éléments'),
      screen('item', 'Fiche de l’élément', '/items/42', 'screenshots/item.png'),
      screen('edit', 'Modifier l’élément', '/items/42/edit'),
      screen('orders', 'Commandes'),
      screen(
        'order',
        'Détail de la commande numéro 2024-00017 avec un titre vraiment très long pour la carte',
        '/orders/2024-00017/details/lines?expand=all&sort=desc&page=12',
      ),
      screen('settings', 'Paramètres'),
      screen('profile', 'Profil'),
      screen('security', 'Sécurité'),
      screen('about', 'À propos'),
      screen('help', 'Aide'),
    ],
    [
      move('home', 'items', 'Éléments', 'PASS'),
      move('home', 'orders', 'Commandes', 'PASS'),
      move('home', 'settings', 'Paramètres', 'WARNING'),
      move('home', 'about', 'À propos', 'PASS'),
      move('items', 'item', 'Élément 42', 'PASS'),
      move('item', 'edit', 'Modifier', 'FAIL'),
      move('edit', 'item', 'Annuler', 'PASS'),
      move('item', 'items', 'Retour à la liste', 'PASS'),
      move('orders', 'order', 'Voir la commande 2024-00017 et toutes ses lignes détaillées', 'PASS'),
      move('order', 'item', 'Élément commandé', 'PASS'),
      move('order', 'home', 'Accueil'),
      move('settings', 'profile', 'Profil', 'PASS'),
      move('settings', 'security', 'Sécurité'),
      move('security', 'settings', 'Retour'),
      move('profile', 'home', 'Logo'),
      move('about', 'help', 'Aide', 'PASS'),
      move('help', 'about', 'Retour', 'PASS'),
      move('items', 'items', 'Trier'),
      move('settings', 'settings', 'Supprimer le compte', undefined, 'BLOCKED'),
    ],
    [
      issue('i1', 'edit', 'ERROR', 'PUT /api/items/42 → 500'),
      issue('i2', 'settings', 'WARNING', 'Deprecated API used'),
    ],
  );
}

/** Un grand parcours : un arbre de `count` écrans (4 enfants par écran) et des retours vers la racine. */
export function large(count: number): ExplorationResult {
  const ids = Array.from({ length: count }, (_, index) => `n${String(index)}`);
  const transitions = ids
    .slice(1)
    .map((id, index) => move(ids[Math.floor(index / 4)] ?? '', id, `Ouvrir ${id}`, 'PASS'));
  for (let index = 5; index < count; index += 7) transitions.push(move(ids[index] ?? '', 'n0', 'Accueil'));
  for (let index = 9; index < count; index += 11)
    transitions.push(move(ids[index] ?? '', ids[index - 6] ?? '', 'Raccourci'));
  return journeyOf(
    ids.map((id) => screen(id, `Écran ${id}`, `/section/${id}`)),
    transitions,
  );
}
