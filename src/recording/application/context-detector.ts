import type { RecordedState } from '../model.js';
import { routePattern } from '../business/signals.js';

/**
 * CONTEXT DETECTOR : dans quel contexte applicatif est l'écran ? Par sa STRUCTURE seulement, quelle
 * que soit la technologie du micro-frontend (iframe, élément personnalisé, Module Federation, route
 * de SPA, composant chargé) :
 *
 *   1. un cadre visible (iframe) : son origine et son chemin ;
 *   2. sinon les éléments personnalisés de grande taille qui ne sont PAS le shell (le shell est ce
 *      qui est présent sur tous les écrans observés) ;
 *   3. sinon le motif de la route (identifiants remplacés par :id).
 *
 * Aucun nom n'est connu à l'avance : « items-create » ou « /tasks » sont des noms OBSERVÉS.
 */
export interface ContextSignature {
  key: string;
  kind: 'FRAME' | 'HOST' | 'ROUTE';
  name: string;
  route: string;
  origin?: string;
  frame?: string;
  hosts: string[];
}

/** Les éléments du shell : présents sur tous les écrans (au moins deux écrans observés). */
export function shellHostsOf(states: readonly RecordedState[]): string[] {
  const withHosts = states.filter((state) => (state.hosts ?? []).length > 0);
  if (states.length < 2 || withHosts.length < states.length) return [];
  const [first, ...others] = withHosts;
  return (first?.hosts ?? []).filter((host) => others.every((state) => (state.hosts ?? []).includes(host)));
}

export function signatureOf(state: RecordedState, shell: readonly string[]): ContextSignature {
  const route = pathOf(state.url);
  const pattern = routePattern(route);
  const origin = originOf(state.url);
  const hosts = (state.hosts ?? []).filter((host) => !shell.includes(host));
  const frame = state.frames?.[0];
  if (frame)
    return {
      key: `frame:${routePattern(frame.replace(/^[a-z]+:\/\/[^/]+/i, ''))}@${originOf(frame) ?? ''}`,
      kind: 'FRAME',
      name: routePattern(frame.replace(/^[a-z]+:\/\/[^/]+/i, '')),
      route,
      ...(origin ? { origin } : {}),
      frame,
      hosts,
    };
  if (hosts.length > 0)
    return {
      key: `host:${hosts.join('+')}`,
      kind: 'HOST',
      name: hosts.at(-1) ?? hosts.join('+'),
      route,
      ...(origin ? { origin } : {}),
      hosts,
    };
  return {
    key: `route:${pattern}`,
    kind: 'ROUTE',
    name: pattern,
    route,
    ...(origin ? { origin } : {}),
    hosts,
  };
}

/** Ce qui a changé entre deux contextes : la preuve d'un changement de contexte. */
export function contextChange(before: ContextSignature, after: ContextSignature): string {
  const parts: string[] = [];
  if (before.frame !== after.frame)
    parts.push(after.frame ? `frame ${after.frame} loaded` : `frame ${before.frame ?? ''} left`);
  const appeared = after.hosts.filter((host) => !before.hosts.includes(host));
  const gone = before.hosts.filter((host) => !after.hosts.includes(host));
  if (appeared.length) parts.push(`<${appeared.join('>, <')}> appeared`);
  if (gone.length) parts.push(`<${gone.join('>, <')}> gone`);
  if (routePattern(before.route) !== routePattern(after.route))
    parts.push(`route ${before.route} → ${after.route}`);
  return parts.join('; ') || `${before.key} → ${after.key}`;
}

export function pathOf(url: string): string {
  try {
    return new URL(url, 'http://local.invalid').pathname;
  } catch {
    return url;
  }
}

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}
