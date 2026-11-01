import type {
  CodeIndex,
  Incident,
  PolicyDecision,
  PolicyOperation,
} from '../../sdk/core/incident-contracts.js';
import type {
  AngularModel,
  IncidentBrief,
  ScopeGraph,
  ScopeResource,
  ScopeResourceKind,
  ScopeResourceStatus,
} from '../../sdk/core/incident-trigger-contracts.js';
import { routesOf } from '../code/angular.js';

/**
 * LA DÉCOUVERTE DU PÉRIMÈTRE : à partir de la zone fonctionnelle connue (mots-clés de la description), les
 * ressources candidates — routes et pages Angular, scénarios de la bibliothèque, composants, templates,
 * formulaires, services, API, endpoints BFF et backend, dépôts — trouvées par le texte, l'analyse statique,
 * les scénarios, les observations réseau. Chaque ressource est DISCOVERED, puis AUTHORIZED, DENIED ou
 * INACCESSIBLE d'après le Scope Policy Engine ; PROPOSED quand elle est plausible mais hors du périmètre.
 * Découvrir n'autorise jamais : le périmètre reste celui de l'incident, étendu seulement par une personne.
 */
export interface DiscoveryInput {
  incident: Incident;
  brief: IncidentBrief;
  code?: CodeIndex;
  angular?: AngularModel[];
  scenarios?: { name: string; file: string; text?: string }[];
  /** Les routes vues pendant la navigation (observations). */
  observedRoutes?: string[];
  /** Les chemins d'API vus sur le réseau. */
  observedApis?: string[];
  check: (operation: PolicyOperation) => Promise<PolicyDecision>;
  baseUrl?: string;
  now?: string;
}

const MAX_RESOURCES = 160;

const score = (text: string, keywords: readonly string[]): number => {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits = keywords.filter((word) => lower.includes(word)).length;
  return Math.min(1, hits / Math.min(keywords.length, 4));
};

const matched = (text: string, keywords: readonly string[]): string[] => {
  const lower = text.toLowerCase();
  return keywords.filter((word) => lower.includes(word));
};

export async function discoverScope(input: DiscoveryInput): Promise<ScopeGraph> {
  const { incident, brief } = input;
  const keywords = [
    ...new Set([
      ...brief.keywords,
      ...(brief.functionalArea
        ? brief.functionalArea.text
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length >= 3)
        : []),
    ]),
  ];
  const resources = new Map<string, ScopeResource>();
  const edges: ScopeGraph['edges'] = [];
  const add = (resource: Omit<ScopeResource, 'status'> & { status?: ScopeResourceStatus }): ScopeResource => {
    const existing = resources.get(resource.id);
    if (existing) {
      existing.relevance = Math.max(existing.relevance, resource.relevance);
      for (const by of resource.foundBy) if (!existing.foundBy.includes(by)) existing.foundBy.push(by);
      return existing;
    }
    const entry: ScopeResource = { status: 'DISCOVERED', ...resource };
    if (resources.size < MAX_RESOURCES) resources.set(entry.id, entry);
    return entry;
  };
  const edge = (from: string, to: string, kind: ScopeGraph['edges'][number]['kind']): void => {
    if (!edges.some((item) => item.from === from && item.to === to && item.kind === kind))
      edges.push({ from, to, kind });
  };

  // Dépôts du périmètre : autorisés ou refusés par la politique (lecture de la racine).
  for (const application of incident.scope.applications) {
    const decision = await input.check({
      kind: 'LIST_DIR',
      path: application.repository.root,
      applicationId: application.id,
    });
    add({
      id: `repo:${application.id}`,
      kind: 'REPOSITORY',
      label: `${application.name} (${application.layer})`,
      ref: application.repository.root,
      applicationId: application.id,
      status: decision.allowed ? 'AUTHORIZED' : 'DENIED',
      foundBy: ['STATIC'],
      relevance: application.layer === 'FRONTEND' ? 0.6 : 0.3,
      ...(decision.allowed ? {} : { detail: decision.reason }),
    });
  }

  // Scénarios de la bibliothèque : par leur nom et leur contenu.
  for (const scenario of input.scenarios ?? []) {
    const text = `${scenario.name} ${scenario.text ?? ''}`;
    const relevance = Math.max(score(scenario.name, keywords) * 1.2, score(text, keywords));
    const known = incident.scenario === scenario.name;
    if (relevance === 0 && !known) continue;
    add({
      id: `scenario:${scenario.name}`,
      kind: 'SCENARIO',
      label: scenario.name,
      ref: scenario.file,
      status: 'AUTHORIZED',
      foundBy: ['SCENARIO', 'TEXT'],
      relevance: known ? 1 : Math.min(1, relevance),
      reason: known ? 'scénario de l’incident' : `mots-clés : ${matched(text, keywords).join(', ')}`,
    });
  }

  // Code Angular : routes, composants, templates, formulaires, services, API.
  for (const model of input.angular ?? []) {
    const app = incident.scope.applications.find((item) => item.id === model.applicationId);
    const repoStatus = resources.get(`repo:${model.applicationId}`)?.status ?? 'DISCOVERED';
    const inherit = (): ScopeResourceStatus => (repoStatus === 'DENIED' ? 'DENIED' : 'AUTHORIZED');
    const kindOf: Partial<Record<AngularModel['nodes'][number]['kind'], ScopeResourceKind>> = {
      COMPONENT: 'COMPONENT',
      TEMPLATE: 'TEMPLATE',
      FORM: 'FORM',
      SERVICE: 'SERVICE',
      API: 'API',
      INTERCEPTOR: 'SERVICE',
      ERROR_HANDLER: 'SERVICE',
    };
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    const relevant = new Set<string>();
    for (const node of model.nodes) {
      const kind = kindOf[node.kind];
      if (!kind) continue;
      const text = `${node.name} ${node.file} ${JSON.stringify(node.detail ?? {})}`;
      const relevance = score(text, keywords);
      if (relevance > 0) relevant.add(node.id);
    }
    // Propagation : un composant pertinent entraîne son template, ses services et ses API ; une API entraîne son service.
    for (const link of model.links) {
      if (relevant.has(link.from) && byId.get(link.to)?.kind !== 'HANDLER') relevant.add(link.to);
    }
    for (const node of model.nodes) {
      const kind = kindOf[node.kind];
      if (!kind || !relevant.has(node.id)) continue;
      const text = `${node.name} ${node.file}`;
      add({
        id: node.id,
        kind,
        label: node.name,
        // Une API se désigne par sa méthode et son chemin ; le reste par son emplacement dans le code.
        ref: node.kind === 'API' ? node.name : `${node.file}:${String(node.line)}`,
        applicationId: model.applicationId,
        status: inherit(),
        foundBy: ['STATIC', ...(score(text, keywords) > 0 ? (['TEXT'] as const) : [])],
        relevance: Math.max(0.2, score(text, keywords)),
        ...(score(text, keywords) > 0
          ? { reason: `mots-clés : ${matched(text, keywords).join(', ')}` }
          : { reason: 'relié à une ressource pertinente' }),
      });
      if (node.kind === 'COMPONENT') {
        for (const route of routesOf(model).filter((item) => item.componentId === node.id)) {
          const path = `/${route.path}`.replace(/\/+/g, '/');
          const navigation = input.baseUrl
            ? await input.check({ kind: 'NAVIGATE', url: new URL(path, input.baseUrl).toString() })
            : undefined;
          const resource = add({
            id: `route:${path}`,
            kind: 'ROUTE',
            label: path,
            ref: path,
            applicationId: model.applicationId,
            status: navigation ? (navigation.allowed ? 'AUTHORIZED' : 'DENIED') : 'DISCOVERED',
            foundBy: ['STATIC'],
            relevance: Math.max(0.5, score(node.name, keywords)),
            ...(navigation && !navigation.allowed ? { detail: navigation.reason } : {}),
          });
          edge(resource.id, node.id, 'ROUTES_TO');
        }
      }
    }
    for (const link of model.links) {
      if (!resources.has(link.from) || !resources.has(link.to)) continue;
      const kind = link.kind === 'BINDS' ? 'RENDERS' : link.kind === 'TARGETS' ? 'CALLS' : 'USES';
      edge(link.from, link.to, kind);
    }
    if (app && model.denied.length > 0)
      add({
        id: `denied:${model.applicationId}`,
        kind: 'REPOSITORY',
        label: `${app.name} : fichiers refusés`,
        ref: model.denied.slice(0, 3).join(' ; '),
        applicationId: model.applicationId,
        status: 'DENIED',
        foundBy: ['STATIC'],
        relevance: 0.1,
        detail: `${String(model.denied.length)} fichier(s) refusé(s) par le périmètre`,
      });
  }

  // Endpoints BFF et backend de l'index de code : reliés aux API appelées par le frontend.
  for (const endpoint of input.code?.endpoints ?? []) {
    const symbol = input.code?.symbols.find((item) => item.id === endpoint.symbolId);
    const app = incident.scope.applications.find((item) => item.id === symbol?.applicationId);
    if (!app) continue;
    const label = `${endpoint.method} ${endpoint.path}`;
    const apiMatches = [...resources.values()].filter(
      (resource) => resource.kind === 'API' && pathsMatch(resource.label, label),
    );
    const relevance = Math.max(score(label, keywords), apiMatches.length > 0 ? 0.5 : 0);
    if (relevance === 0) continue;
    const resource = add({
      id: `endpoint:${app.id}:${label}`,
      kind: app.layer === 'BFF' ? 'BFF' : 'BACKEND',
      label,
      ref: symbol ? `${symbol.file}:${String(symbol.line)}` : label,
      applicationId: app.id,
      status: resources.get(`repo:${app.id}`)?.status === 'DENIED' ? 'DENIED' : 'AUTHORIZED',
      foundBy: ['STATIC'],
      relevance,
    });
    for (const api of apiMatches) edge(api.id, resource.id, 'SERVES');
  }

  // Observations : routes et API vues pendant la navigation ou sur le réseau.
  for (const route of input.observedRoutes ?? [])
    add({
      id: `route:${route}`,
      kind: 'PAGE',
      label: route,
      ref: route,
      status: 'AUTHORIZED',
      foundBy: ['NAVIGATION'],
      relevance: 0.4,
    });
  for (const api of input.observedApis ?? [])
    add({
      id: `observed-api:${api}`,
      kind: 'API',
      label: api,
      ref: api,
      status: 'DISCOVERED',
      foundBy: ['NETWORK'],
      relevance: 0.4,
    });

  // Les hôtes hors périmètre cités par la description : proposés, jamais autorisés d'office.
  for (const item of brief.environment) {
    const host = /^[a-z0-9.-]+\.[a-z]{2,}$/i.exec(item.text)?.[0];
    if (host && !incident.scope.allowedHosts.includes(host))
      add({
        id: `host:${host}`,
        kind: 'DEPENDENCY',
        label: host,
        ref: host,
        status: 'PROPOSED',
        foundBy: ['TEXT'],
        relevance: 0.2,
        detail: 'cité par la description ; hors du périmètre tant qu’une personne ne l’ajoute pas',
      });
  }

  const list = [...resources.values()].sort(
    (a, b) => b.relevance - a.relevance || a.label.localeCompare(b.label),
  );
  return { resources: list, edges, discoveredAt: input.now ?? new Date().toISOString() };
}

/** « POST /api/dossiers » et « POST /api/dossiers/{id} » : même méthode et même chemin à un paramètre près. */
export function pathsMatch(left: string, right: string): boolean {
  const normalize = (text: string): string =>
    text
      .trim()
      .toUpperCase()
      .replace(/\{[^}]*\}|:\w+|\$\{[^}]*\}/g, '*')
      .replace(/\/+$/, '');
  const [lm, lp] = normalize(left).split(/\s+/);
  const [rm, rp] = normalize(right).split(/\s+/);
  if (lm !== rm) return false;
  const l = (lp ?? '').split('/');
  const r = (rp ?? '').split('/');
  if (l.length !== r.length) return false;
  return l.every((part, index) => part === '*' || r[index] === '*' || part === r[index]);
}
