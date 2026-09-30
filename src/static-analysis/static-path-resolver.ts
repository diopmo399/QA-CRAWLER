import type { StaticPathHint } from '../dry-run/dry-run-driver.js';
import { normalizeForMatch, tokenOverlap } from '../semantics/resolution/normalize.js';
import type { SemanticDictionary } from '../semantics/semantic-dictionary.js';
import type { StaticRouteNode } from './model.js';
import type { StaticKnowledge } from './static-knowledge.js';

/**
 * STATIC PATH RESOLVER : dans le graphe statique, les routes qui mènent de l'écran
 * courant à une intention (« Users » depuis le tableau de bord → /administration →
 * /administration/users). Le résultat est un INDICE (source STATIC_CODE,
 * runtimeConfirmed=false) : l'exploration guidée l'utilise pour choisir quoi essayer,
 * puis Playwright confirme — ou non — chaque étape. Jamais page.goto vers la route.
 */
export class StaticPathResolver {
  constructor(
    private readonly knowledge: StaticKnowledge,
    private readonly dictionary?: SemanticDictionary,
  ) {}

  suggest(fromPathname: string, targetLabel: string): StaticPathHint | undefined {
    const routes = this.knowledge.graph.routes.filter((route) => !route.redirectTo);
    let best: { route: StaticRouteNode; score: number } | undefined;
    for (const route of routes) {
      const score = this.similarity(route, targetLabel);
      if (
        score >= 0.6 &&
        (!best || score > best.score || (score === best.score && route.path.length < best.route.path.length))
      )
        best = { route, score };
    }
    if (!best) return undefined;
    const currentComponent = this.knowledge.componentAt(fromPathname);
    const current =
      (currentComponent ? this.knowledge.routesOf(currentComponent)[0]?.path : undefined) ??
      normalizePath(fromPathname);
    const from = current.split('/').filter(Boolean);
    const to = best.route.path.split('/').filter(Boolean);
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
    const segments = to.slice(common).filter((segment) => !segment.startsWith(':'));
    if (segments.length === 0) return undefined;
    // Le code navigue-t-il lui-même depuis cet écran vers la cible (ou vers un parent) ?
    const navigates = this.knowledge.graph.navigation.some(
      (edge) =>
        edge.fromComponent === currentComponent &&
        (best.route.path.startsWith(normalizePath(edge.target)) ||
          normalizePath(edge.target).startsWith(best.route.path)),
    );
    const guards =
      best.route.guards.length > 0 ||
      routes.some(
        (route) => best.route.path.startsWith(route.path) && route.guards.length > 0 && route.path !== '/',
      );
    const confidence = Math.min(0.85, 0.6 + (navigates ? 0.15 : 0) + (best.score >= 0.99 ? 0.1 : 0));
    return {
      segments,
      route: best.route.path,
      source: 'STATIC_CODE',
      confidence: Math.round(confidence * 100) / 100,
      runtimeConfirmed: false,
      description: `${current} → ${best.route.path}${navigates ? ' (router navigation in the code)' : ''}${guards ? ' (guarded route)' : ''}`,
    };
  }

  private similarity(route: StaticRouteNode, label: string): number {
    const wanted = normalizeForMatch(label).tokens;
    const segment = route.path.split('/').filter(Boolean).at(-1) ?? '';
    const names = [segment, route.component?.replace(/Component$/, '') ?? ''].filter(Boolean);
    let score = 0;
    for (const name of names) {
      const tokens = normalizeForMatch(name).tokens;
      score = Math.max(score, tokenOverlap(wanted, tokens).ratio);
      if (this.dictionary) {
        const shared = this.dictionary
          .conceptsIn(label)
          .filter((concept) => this.dictionary?.match(concept, name) !== undefined);
        if (shared.length > 0) score = Math.max(score, 0.7);
      }
    }
    return score;
  }
}

function normalizePath(path: string): string {
  const clean = `/${path.split('/').filter(Boolean).join('/')}`;
  return clean === '/' ? '/' : clean;
}
