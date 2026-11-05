import type {
  ActionRow,
  ApiFeatureUse,
  ConditionRow,
  ElementAction,
  ElementCondition,
  ElementSheet,
  MapConfidence,
  MapEdge,
  MapListQuery,
  MapNode,
  MapPage,
  MapStructure,
  StructureItem,
  StructureKpis,
  TabSheet,
} from '../sdk/core/cartography.js';
import { apiScenarios, MAX_PAGE, outboundOf, type CoverageContext, type MapIndex } from './explorer.js';

/**
 * LA STRUCTURE CONDITIONNELLE : l'arbre d'une page (écran → composant → conteneurs → champs et boutons),
 * la fiche d'un élément (ses conditions d'affichage et d'activation, héritées ou propres, et la chaîne qui
 * relie chacune à la méthode Backend qui la calcule ; ses actions et leur aval), et les listes paginées des
 * conditions et des actions. Seuls des liens du scan sont suivis ; une décision non atteinte est dite
 * « non déterminée », avec sa cause.
 */

const RANK: Record<MapConfidence, number> = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };
const weakest = (list: readonly MapConfidence[]): MapConfidence =>
  list.reduce<MapConfidence>((w, c) => (RANK[c] < RANK[w] ? c : w), 'CONFIRMED');
const out = (index: MapIndex, id: string, kind: string): MapEdge[] =>
  (index.out.get(id) ?? []).filter((e) => e.kind === kind);
const into = (index: MapIndex, id: string, kind: string): MapEdge[] =>
  (index.in.get(id) ?? []).filter((e) => e.kind === kind);
const MAX_CHAIN = 20;

export function structureKpis(index: MapIndex): StructureKpis {
  let pages = 0;
  let containers = 0;
  let fields = 0;
  let buttons = 0;
  let internalApis = 0;
  let conditions = 0;
  for (const node of index.nodes.values()) {
    if (node.kind === 'ROUTE') pages += 1;
    else if (node.kind === 'CONTAINER') containers += 1;
    else if (node.kind === 'FIELD' && node.layer === 'FRONTEND') fields += 1;
    else if (node.kind === 'BUTTON') buttons += 1;
    else if (node.kind === 'API' && (node.layer === 'BFF' || node.layer === 'BACKEND')) internalApis += 1;
    else if (node.kind === 'CONDITION') conditions += 1;
  }
  const externalApis = (index.model.apis ?? []).filter((api) => api.scope === 'EXTERNAL').length;
  return { pages, containers, fields, buttons, internalApis, externalApis, conditions };
}

function conditionsOf(index: MapIndex, id: string): StructureItem['conditions'] {
  return [...out(index, id, 'VISIBLE_WHEN'), ...out(index, id, 'ENABLED_WHEN')]
    .map((e) => index.nodes.get(e.to))
    .filter((n): n is MapNode => n !== undefined)
    .map((n) => ({
      aspect: n.detail.aspect === 'ENABLED' ? ('ENABLED' as const) : ('VISIBLE' as const),
      expression: typeof n.detail.expression === 'string' ? n.detail.expression : n.name,
      whenTrue: n.detail.whenTrue !== false,
    }));
}

function itemOf(
  index: MapIndex,
  node: MapNode,
  depth: number,
  path: ReadonlySet<string> = new Set(),
): StructureItem {
  // Imbrication variable (onglets dans des onglets, composants dans des composants) : bornée, sans cycle.
  const inside = new Set([...path, node.id]);
  const children =
    depth > 12
      ? []
      : out(index, node.id, 'CONTAINS')
          .map((e) => index.nodes.get(e.to))
          .filter((n): n is MapNode => n !== undefined && !inside.has(n.id))
          .sort((a, b) =>
            a.kind === 'COMPONENT' || b.kind === 'COMPONENT'
              ? 0
              : (a.evidence[0]?.line ?? 0) - (b.evidence[0]?.line ?? 0),
          )
          .map((n) => itemOf(index, n, depth + 1, inside));
  const tab = node.detail.tab === 'GROUP' || node.detail.tab === 'TAB' ? node.detail.tab : undefined;
  const tabSub = tab
    ? [
        typeof node.detail.repeat === 'string'
          ? `${node.detail.repeat}${Array.isArray(node.detail.items) ? ` : ${node.detail.items.join(', ')}` : ''}`
          : '',
        node.detail.lazy === 'ROUTE' && typeof node.detail.route === 'string'
          ? `route ${node.detail.route}`
          : node.detail.lazy
            ? 'chargé à la sélection'
            : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const sub =
    node.kind === 'FIELD'
      ? typeof node.detail.type === 'string'
        ? node.detail.type
        : undefined
      : node.kind === 'BUTTON'
        ? typeof node.detail.handler === 'string'
          ? `${node.detail.handler}()`
          : undefined
        : undefined;
  return {
    id: node.id,
    kind: node.kind as StructureItem['kind'],
    ...(tab ? { tab } : {}),
    name: node.label ?? node.name,
    ...(sub || tabSub ? { sub: sub ?? tabSub } : {}),
    conditions: conditionsOf(index, node.id),
    children,
  };
}

/** L'arbre d'une fonctionnalité (ses composants), ou de tout le projet, avec les comptes du scan. */
export function structureOf(index: MapIndex, featureId?: string): MapStructure | undefined {
  const feature = featureId ? index.featureById.get(featureId) : undefined;
  if (featureId && !feature) return undefined;
  const components = [...index.nodes.values()].filter(
    (n) =>
      n.kind === 'COMPONENT' &&
      (!feature ||
        feature.nodes.includes(n.id) ||
        feature.fields.some((f) => index.nodes.get(f)?.parent === n.id)),
  );
  const roots: StructureItem[] = [];
  for (const component of components.sort((a, b) => a.name.localeCompare(b.name))) {
    const routes = into(index, component.id, 'DISPLAYS')
      .map((e) => index.nodes.get(e.from))
      .filter((n): n is MapNode => n?.kind === 'ROUTE');
    // Un composant affiché dans un autre (onglet, conteneur) apparaît sous lui, pas à la racine.
    if (!routes.length && into(index, component.id, 'CONTAINS').length) continue;
    const item = itemOf(index, component, 0);
    roots.push(
      routes.length
        ? {
            id: routes[0]?.id ?? component.id,
            kind: 'ROUTE',
            name: routes.map((r) => r.name).join(', '),
            conditions: [],
            children: [item],
          }
        : item,
    );
  }
  return {
    ...(feature ? { feature: { id: feature.id, name: feature.name } } : {}),
    roots,
    kpis: structureKpis(index),
  };
}

/** La chaîne d'une condition jusqu'à sa décision : réponse lue, champs pilotés, mappings, méthode. */
function resolveCondition(index: MapIndex, condition: MapNode): Omit<ElementCondition, 'inherited'> {
  const nodes = new Map<string, MapNode>([[condition.id, condition]]);
  const edges: MapEdge[] = [];
  let decision: MapNode | undefined;
  let frontier = [condition.id];
  for (let depth = 0; depth < MAX_CHAIN && frontier.length > 0 && !decision; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      // En avant : piloté par, dépend de (la réponse) ; en arrière : le champ qui alimente par mapping.
      const steps = [
        ...out(index, id, 'CONTROLLED_BY').map((e) => ({ e, to: e.to })),
        // Une condition, ou un flux RxJS : ce dont la valeur dépend (flux sources, réponse poussée).
        ...(index.nodes.get(id)?.kind === 'CONDITION' || index.nodes.get(id)?.kind === 'STREAM'
          ? out(index, id, 'DEPENDS_ON').map((e) => ({ e, to: e.to }))
          : []),
        ...(index.nodes.get(id)?.kind === 'FIELD'
          ? into(index, id, 'TRANSFORMS').map((e) => ({ e, to: e.from }))
          : []),
      ];
      for (const { e, to } of steps) {
        const target = index.nodes.get(to);
        if (!target || nodes.has(to)) continue;
        nodes.set(to, target);
        edges.push(e);
        if (target.detail.decision === true) decision = target;
        // Un appel front n'est qu'un repère (la réponse) : la chaîne continue par les champs pilotés.
        if (target.kind !== 'METHOD') next.push(to);
      }
    }
    frontier = next;
  }
  // La décision et ce qu'elle lit (entités).
  if (decision)
    for (const e of out(index, decision.id, 'READS')) {
      const entity = index.nodes.get(e.to);
      if (entity && !nodes.has(entity.id)) {
        nodes.set(entity.id, entity);
        edges.push(e);
      }
    }
  const sources = (Array.isArray(condition.detail.sources) ? condition.detail.sources : []).map((s) => {
    const [member = '', kind = 'UNKNOWN'] = s.split(':');
    return { member, kind };
  });
  const toDecision = decision ? edges.filter((e) => e.kind !== 'READS') : [];
  const status: MapConfidence = decision ? weakest(toDecision.map((e) => e.confidence)) : 'UNKNOWN';
  const local = sources.filter((s) => s.kind !== 'RESPONSE');
  // Des flux suivis jusqu'à une réponse HTTP (ou une propriété d'un DTO du serveur) : la valeur vient du
  // serveur, mais aucune méthode qui la calcule n'y est démontrée.
  const response = [...nodes.values()].find(
    (n) => (n.kind === 'FIELD' && n.layer !== 'FRONTEND') || n.detail.httpMethod !== undefined,
  );
  const undetermined = decision
    ? undefined
    : response && sources.some((s) => s.kind === 'STREAM')
      ? `la valeur suit des flux RxJS jusqu’à la réponse (${response.label ?? response.name}) ; aucune méthode Backend qui la calcule n’est démontrée`
      : local.length && local.length === sources.length
        ? `valeur calculée dans le frontal (${local.map((s) => `${s.member} : ${s.kind.toLowerCase()}`).join(', ')}) : aucune décision Backend`
        : sources.some((s) => s.kind === 'RESPONSE')
          ? 'la réponse lue n’est reliée à aucune méthode Backend démontrée (champ non trouvé ou mapping non suivi)'
          : 'origine des membres lus non trouvée dans le composant';
  return {
    id: condition.id,
    aspect: condition.detail.aspect === 'ENABLED' ? 'ENABLED' : 'VISIBLE',
    expression:
      typeof condition.detail.expression === 'string' ? condition.detail.expression : condition.name,
    how: typeof condition.detail.how === 'string' ? condition.detail.how : '',
    whenTrue: condition.detail.whenTrue !== false,
    sources,
    chain: { nodes: [...nodes.values()], edges },
    ...(decision
      ? {
          decision: {
            method: decision,
            loops: typeof decision.detail.loops === 'number' ? decision.detail.loops : 0,
            predicates: Array.isArray(decision.detail.predicates)
              ? decision.detail.predicates.map(String)
              : [],
            reads: Array.isArray(decision.detail.reads) ? decision.detail.reads.map(String) : [],
          },
        }
      : {}),
    status,
    ...(undetermined ? { undetermined } : {}),
  };
}

/** L'aval d'un bouton : appels déclenchés, endpoints servis, méthodes, appels sortants, entités. */
function actionOf(
  index: MapIndex,
  button: MapNode,
  included: Map<string, MapNode>,
  edges: MapEdge[],
): ElementAction {
  const triggers = out(index, button.id, 'TRIGGERS');
  const endpoints: MapNode[] = [];
  // Les appels HTTP atteints, et les étapes du frontal traversées (méthode du composant, store, flux).
  const calls: MapNode[] = [];
  const via: MapNode[] = [];
  const front = (node: MapNode | undefined): void => {
    if (!node || node.layer !== 'FRONTEND' || (node.kind !== 'METHOD' && node.kind !== 'STREAM')) return;
    const list = node.detail.httpMethod !== undefined ? calls : via;
    if (!list.includes(node)) list.push(node);
  };
  const entities = new Map<string, 'READ' | 'WRITE'>();
  const confidences: MapConfidence[] = [];
  const add = (e: MapEdge, to: string): boolean => {
    const target = index.nodes.get(to);
    if (!target) return false;
    edges.push(e);
    if (included.has(to)) return false;
    included.set(to, target);
    return true;
  };
  let frontier: string[] = [];
  for (const e of triggers) {
    front(index.nodes.get(e.to));
    if (add(e, e.to)) frontier.push(e.to);
  }
  for (let depth = 0; depth < MAX_CHAIN && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier)
      for (const e of index.out.get(id) ?? []) {
        const from = index.nodes.get(id);
        const serving = e.kind === 'DEPENDS_ON' && from?.kind === 'API';
        if (e.kind === 'CALLS' || serving) {
          confidences.push(e.confidence);
          const target = index.nodes.get(e.to);
          if (
            target?.kind === 'API' &&
            (target.layer === 'BFF' || target.layer === 'BACKEND') &&
            !endpoints.includes(target)
          )
            endpoints.push(target);
          front(target);
          if (add(e, e.to)) next.push(e.to);
        } else if ((e.kind === 'WRITES' || e.kind === 'READS') && index.nodes.get(e.to)?.kind === 'ENTITY') {
          const entity = index.nodes.get(e.to);
          if (entity)
            entities.set(entity.name, e.kind === 'WRITES' ? 'WRITE' : (entities.get(entity.name) ?? 'READ'));
          add(e, e.to);
        }
      }
    frontier = next;
  }
  return {
    ...(typeof button.detail.handler === 'string' ? { handler: button.detail.handler } : {}),
    triggers: calls,
    ...(via.length ? { via } : {}),
    endpoints,
    outbound: [],
    entities: [...entities].map(([name, access]) => ({ name, access })),
    status: triggers.length ? weakest(confidences.length ? confidences : ['CONFIRMED']) : 'UNKNOWN',
  };
}

/** Les ancêtres d'un élément (conteneurs, composant), du plus proche au plus lointain. */
function ancestorsOf(index: MapIndex, id: string): MapNode[] {
  const list: MapNode[] = [];
  let cursor = into(index, id, 'CONTAINS')[0]?.from;
  for (let guard = 0; cursor && guard < 20; guard += 1) {
    const node = index.nodes.get(cursor);
    if (!node) break;
    list.push(node);
    cursor = into(index, cursor, 'CONTAINS')[0]?.from;
  }
  return list;
}

/** La fiche d'un élément (conteneur, bouton, champ) : conditions, chaîne de décision, actions, sous-graphe. */
export function elementSheet(index: MapIndex, cov: CoverageContext, id: string): ElementSheet | undefined {
  const element = index.nodes.get(id);
  if (!element || !['CONTAINER', 'BUTTON', 'FIELD'].includes(element.kind)) return undefined;
  const ancestors = ancestorsOf(index, id);
  const included = new Map<string, MapNode>([[id, element]]);
  const edges: MapEdge[] = [];
  const conditions: ElementCondition[] = [];
  // Les conditions propres, puis celles héritées des conteneurs (un enfant n'est visible que si son parent l'est).
  for (const [owner, inherited] of [
    [element, undefined] as const,
    ...ancestors.map((a) => [a, a.label ?? a.name] as const),
  ]) {
    for (const e of [
      ...out(index, owner.id, 'VISIBLE_WHEN'),
      ...(owner === element ? out(index, owner.id, 'ENABLED_WHEN') : []),
    ]) {
      const condition = index.nodes.get(e.to);
      if (!condition) continue;
      const resolved = resolveCondition(index, condition);
      conditions.push({ ...resolved, ...(inherited ? { inherited } : {}) });
      if (!included.has(owner.id)) included.set(owner.id, owner);
      edges.push(e);
      for (const n of resolved.chain.nodes) included.set(n.id, n);
      edges.push(...resolved.chain.edges);
    }
  }
  const content = element.detail.tab ? contentOf(index, id) : undefined;
  const actions =
    element.kind === 'BUTTON'
      ? [actionOf(index, element, included, edges)]
      : (content
          ? [...content].map((n) => index.nodes.get(n))
          : out(index, id, 'CONTAINS').map((e) => index.nodes.get(e.to))
        )
          .filter((n): n is MapNode => n?.kind === 'BUTTON')
          .map((button) => {
            included.set(button.id, button);
            return actionOf(index, button, included, edges);
          });
  const children = out(index, id, 'CONTAINS')
    .map((e) => index.nodes.get(e.to))
    .filter((n): n is MapNode => n !== undefined);
  const unique = [...new Map(edges.map((e) => [e.id, e])).values()].filter(
    (e) => included.has(e.from) && included.has(e.to),
  );
  const graph = {
    nodes: [...included.values()],
    edges: unique,
    depth: MAX_CHAIN,
    limit: 300,
    truncated: false,
  };
  const outbound = outboundOf(index, graph);
  for (const action of actions) {
    const reached = new Set([...action.triggers, ...action.endpoints].map((n) => n.id));
    for (const e of unique) if (reached.has(e.from)) reached.add(e.to);
    action.outbound = outbound.filter((o) => reached.has(o.from));
  }
  // Les fonctionnalités qui contiennent un nœud de l'élément ou de son aval ; leurs scénarios associés.
  const touched = new Set(graph.nodes.map((n) => n.id));
  const features: ApiFeatureUse[] = index.features
    .filter((f) => f.status !== 'REJECTED' && f.nodes.some((n) => touched.has(n)))
    .map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.module ? { module: f.module } : {}),
      usage: [],
      confidence: weakest(f.nodes.filter((n) => touched.has(n)).map((n) => f.reach[n] ?? 'CONFIRMED')),
      via: [],
    }));
  return {
    element,
    ancestors,
    children,
    conditions,
    actions,
    graph,
    outbound,
    features,
    scenarios: apiScenarios(cov, features),
    ...(content ? { tab: tabSheetOf(index, element, content) } : {}),
    scanId: index.scanId,
    ...(index.model.scan.finishedAt ? { scannedAt: index.model.scan.finishedAt } : {}),
  };
}

const page = <T>(items: T[], query: MapListQuery): MapPage<T> => {
  const size = Math.min(MAX_PAGE, Math.max(1, query.size ?? 25));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(pages, Math.max(1, query.page ?? 1));
  return {
    items: items.slice((current - 1) * size, current * size),
    total: items.length,
    page: current,
    size,
  };
};

const owning = (index: MapIndex, id: string): string | undefined => {
  const node = index.nodes.get(id);
  return typeof node?.detail.component === 'string' ? node.detail.component : undefined;
};

/** Toutes les conditions du projet, avec leur décision résolue (ou la cause), filtrables par texte. */
export function conditionRows(index: MapIndex, query: MapListQuery): MapPage<ConditionRow> {
  const q = query.q?.trim().toLowerCase() ?? '';
  const rows: ConditionRow[] = [];
  for (const node of index.nodes.values()) {
    if (node.kind !== 'CONDITION') continue;
    const elementId = typeof node.detail.element === 'string' ? node.detail.element : '';
    const element = index.nodes.get(elementId);
    const resolved = resolveCondition(index, node);
    const row: ConditionRow = {
      id: node.id,
      element: {
        id: elementId,
        name: element?.label ?? element?.name ?? elementId,
        kind: element?.kind ?? '',
      },
      ...(owning(index, elementId) ? { component: owning(index, elementId) } : {}),
      aspect: resolved.aspect,
      expression: resolved.expression,
      whenTrue: resolved.whenTrue,
      sources: resolved.sources.map((s) => ({ member: s.member, kind: s.kind })),
      ...(resolved.decision ? { decision: resolved.decision.method.name } : {}),
      status: resolved.status,
      ...(resolved.undetermined ? { undetermined: resolved.undetermined } : {}),
    };
    if (
      q &&
      ![row.element.name, row.expression, row.decision ?? '', row.component ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
      continue;
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      (a.component ?? '').localeCompare(b.component ?? '') || a.element.name.localeCompare(b.element.name),
  );
  return page(rows, query);
}

/** Toutes les actions (boutons) du projet : gestionnaire, appels, endpoints, API externes, tables. */
export function actionRows(index: MapIndex, query: MapListQuery): MapPage<ActionRow> {
  const q = query.q?.trim().toLowerCase() ?? '';
  const rows: ActionRow[] = [];
  for (const node of index.nodes.values()) {
    if (node.kind !== 'BUTTON') continue;
    const included = new Map<string, MapNode>([[node.id, node]]);
    const edges: MapEdge[] = [];
    const action = actionOf(index, node, included, edges);
    const outbound = outboundOf(index, {
      nodes: [...included.values()],
      edges,
      depth: MAX_CHAIN,
      limit: 300,
      truncated: false,
    });
    const row: ActionRow = {
      id: node.id,
      name: node.label ?? node.name,
      ...(owning(index, node.id) ? { component: owning(index, node.id) } : {}),
      ...(action.handler ? { handler: action.handler } : {}),
      calls: action.triggers.map((t) => t.name),
      endpoints: action.endpoints.map((e) => `${e.layer} ${e.name}`),
      externals: [
        ...new Set(outbound.map((o) => `${o.method ?? '?'} ${o.path ?? '?'} (${o.provider ?? o.name})`)),
      ],
      entities: action.entities.map((e) => `${e.name} (${e.access === 'WRITE' ? 'écriture' : 'lecture'})`),
      status: action.status,
    };
    if (
      q &&
      ![row.name, row.handler ?? '', row.component ?? '', ...row.endpoints]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
      continue;
    rows.push(row);
  }
  rows.sort((a, b) => (a.component ?? '').localeCompare(b.component ?? '') || a.name.localeCompare(b.name));
  return page(rows, query);
}

/** Le contenu d'un onglet : éléments et composants imbriqués (borné, sans cycle). */
function contentOf(index: MapIndex, id: string): Set<string> {
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0 && seen.size < 2000) {
    const cur = queue.shift() ?? '';
    for (const e of out(index, cur, 'CONTAINS'))
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
  }
  return seen;
}

const tabNameOf = (n: MapNode): string =>
  typeof n.detail.tabLabel === 'string'
    ? n.detail.tabLabel
    : typeof n.detail.repeat === 'string'
      ? `${n.detail.repeat}${Array.isArray(n.detail.items) ? ` (${n.detail.items.join(', ')})` : ''}`
      : (n.label ?? n.name);

/** La fiche d'onglet : contenu, appels atteints, stores, dépendances entre onglets, préconditions. */
function tabSheetOf(index: MapIndex, tab: MapNode, content: ReadonlySet<string>): TabSheet {
  const nodes = [...content].map((id) => index.nodes.get(id)).filter((n): n is MapNode => n !== undefined);
  // Les appels atteints : boutons et gestionnaires (déclenchement), cycle de vie des composants affichés.
  const starts: string[] = [];
  for (const n of nodes)
    for (const e of index.out.get(n.id) ?? [])
      if (e.kind === 'TRIGGERS' || (e.kind === 'CALLS' && n.kind === 'COMPONENT')) starts.push(e.to);
  const seen = new Set(starts);
  const queue = [...starts];
  const apis = new Map<string, MapNode>();
  const stores = new Set<string>();
  while (queue.length > 0 && seen.size < 5000) {
    const cur = queue.shift() ?? '';
    const node = index.nodes.get(cur);
    if (node?.kind === 'API' && (node.layer === 'BFF' || node.layer === 'BACKEND')) apis.set(node.id, node);
    if (node?.detail.role === 'STORE') stores.add(String(node.detail.owner ?? node.name));
    for (const e of index.out.get(cur) ?? [])
      if (e.kind === 'CALLS' && e.confidence !== 'UNKNOWN' && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
  }
  const link = (e: MapEdge, other: string) => {
    const n = index.nodes.get(other);
    return { id: other, name: n ? tabNameOf(n) : other, reason: e.reason, confidence: e.confidence };
  };
  const isTab = (other: string): boolean => index.nodes.get(other)?.detail.tab === 'TAB';
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    role: tab.detail.tab === 'GROUP' ? 'GROUP' : 'TAB',
    library: str(tab.detail.tabLibrary) ?? '',
    ...(str(tab.detail.tabLabel) ? { label: str(tab.detail.tabLabel) } : {}),
    ...(str(tab.detail.lazy) ? { lazy: str(tab.detail.lazy) } : {}),
    ...(str(tab.detail.repeat) ? { repeat: str(tab.detail.repeat) } : {}),
    ...(Array.isArray(tab.detail.items) ? { items: tab.detail.items } : {}),
    ...(str(tab.detail.route) ? { route: str(tab.detail.route) } : {}),
    ...(str(tab.detail.routeUnresolved) ? { routeUnresolved: str(tab.detail.routeUnresolved) } : {}),
    preconditions: Array.isArray(tab.detail.preconditions) ? tab.detail.preconditions : [],
    selectedBy: out(index, tab.id, 'CONTROLLED_BY')
      .filter((e) => index.nodes.get(e.to)?.kind === 'STREAM')
      .map((e) => ({
        stream: index.nodes.get(e.to)?.name ?? e.to,
        reason: e.reason,
        confidence: e.confidence,
      })),
    dependsOn: out(index, tab.id, 'DEPENDS_ON')
      .filter((e) => isTab(e.to))
      .map((e) => link(e, e.to)),
    usedBy: into(index, tab.id, 'DEPENDS_ON')
      .filter((e) => isTab(e.from))
      .map((e) => link(e, e.from)),
    tabs: out(index, tab.id, 'CONTAINS')
      .map((e) => index.nodes.get(e.to))
      .filter((n): n is MapNode => n?.detail.tab === 'TAB')
      .map((n) => ({ id: n.id, name: tabNameOf(n) })),
    components: nodes
      .filter((n) => n.kind === 'COMPONENT')
      .map((n) => ({
        id: n.id,
        name: n.name,
        reusedIn: Array.isArray(n.detail.reusedIn) ? n.detail.reusedIn : [],
      })),
    fields: nodes.filter((n) => n.kind === 'FIELD').length,
    buttons: nodes.filter((n) => n.kind === 'BUTTON').length,
    apis: [...apis.values()],
    stores: [...stores],
  };
}
