import type {
  ConditionRow,
  Evidence,
  FeatureCategory,
  FeatureGroup,
  FeatureLane,
  FeatureMap,
  FeatureMapBundle,
  FeatureMapGap,
  FeatureMapItem,
  FeatureMapQuery,
  FeatureMapRelation,
  FeatureTreeNode,
  MapConfidence,
  MapEdge,
  MapEdgeKind,
  MapLayer,
  MapNode,
} from '../sdk/core/cartography.js';
import {
  FEATURE_CATEGORIES,
  FEATURE_GROUP_CARDS,
  FEATURE_GROUPS,
  FEATURE_LANES,
} from '../sdk/core/cartography.js';
import { featureDetail, MAX_PAGE, outboundOf, type CoverageContext, type MapIndex } from './explorer.js';
import { conditionRow } from './structure.js';

/**
 * LA CARTE D'UNE FONCTIONNALITÉ (Parcours & Graphe) : ses éléments rangés en quatre couloirs dans un ordre
 * fixe (interface Angular, BFF, backend avec sa persistance Hibernate/JPA, API externes), groupés par nature
 * (pages, conteneurs, champs, boutons, stores, services SPA ; contrôleurs, endpoints, contrats, DTO ;
 * services, règles, persistance ; services tiers et appels), et ses relations, toutes conservées, classées
 * en catégories (contient, visible si, dépend de, appelle, flux de données, persistance, API externe) puis
 * réunies en faisceaux comptés exactement entre deux groupes. Rien n'est ajouté : chaque élément et chaque
 * relation viennent du scan (ou d'un appel sortant qu'il a établi) ; une couche que la fonctionnalité
 * n'atteint pas reste vide, et ce qui manque est dit (lacunes) avec sa cause, jamais comblé.
 */

/** Au-delà, les relations de la fonctionnalité sont coupées (et la carte le dit). */
export const MAX_FEATURE_EDGES = 20_000;

const CATEGORY_OF: Partial<Record<MapEdgeKind, FeatureCategory>> = {
  CONTAINS: 'CONTAINS',
  VISIBLE_WHEN: 'CONDITION',
  ENABLED_WHEN: 'CONDITION',
  DEPENDS_ON: 'DEPENDS',
  CONTROLLED_BY: 'DEPENDS',
  CALLS: 'CALLS',
  TRIGGERS: 'CALLS',
  DISPLAYS: 'DATA',
  INPUTS: 'DATA',
  SENDS: 'DATA',
  TRANSFORMS: 'DATA',
  REUSES: 'DATA',
  READS: 'DATA',
  WRITES: 'DATA',
};

const LANE_RANK = new Map<FeatureLane, number>(FEATURE_LANES.map((l, i) => [l, i]));
const GROUP_RANK = new Map<FeatureGroup, number>(FEATURE_GROUPS.map((g, i) => [g, i]));
const PERSISTENCE_GROUPS: ReadonlySet<FeatureGroup> = new Set(['REPOSITORY', 'ENTITY']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const simple = (name: string): string => name.split(/[.#]/).filter(Boolean).pop() ?? name;
const sourceOf = (id: string): string => id.split(':')[1] ?? '';

/** Le couloir et le groupe d'un nœud, d'après sa sorte, sa couche et son rôle (lus par l'analyseur). */
function place(
  node: MapNode,
  sourceLayer: (src: string) => MapLayer | undefined,
): { lane: FeatureLane; group: FeatureGroup } | undefined {
  const role = str(node.detail.role);
  const backLane = (layer: MapLayer): FeatureLane | undefined =>
    layer === 'BFF'
      ? 'BFF'
      : layer === 'BACKEND' || layer === 'DATABASE' || layer === 'EVENTS'
        ? 'BACKEND'
        : undefined;
  if (node.layer === 'FRONTEND') {
    switch (node.kind) {
      case 'ROUTE':
      case 'SCREEN':
        return { lane: 'FRONTEND', group: 'PAGE' };
      case 'COMPONENT':
        return { lane: 'FRONTEND', group: 'COMPONENT' };
      case 'CONTAINER':
      case 'BUTTON':
      case 'CONDITION':
        return { lane: 'FRONTEND', group: node.kind };
      case 'FIELD':
        return {
          lane: 'FRONTEND',
          group: node.parent?.startsWith('DTO:') ? 'MODEL' : 'FIELD',
        };
      case 'DTO':
        return { lane: 'FRONTEND', group: 'MODEL' };
      case 'STREAM':
      case 'METHOD':
      case 'SERVICE':
        return {
          lane: 'FRONTEND',
          group: role === 'STORE' ? 'STORE' : role === 'COMPONENT' ? 'COMPONENT' : 'SPA_SERVICE',
        };
      default:
        return undefined;
    }
  }
  if (node.layer === 'API') {
    // Une opération de contrat : dans le couloir de la source qui porte le contrat.
    const lane = backLane(sourceLayer(sourceOf(node.id)) ?? 'BACKEND') ?? 'BACKEND';
    return { lane, group: 'CONTRACT' };
  }
  const lane = backLane(node.layer);
  if (!lane) return undefined;
  switch (node.kind) {
    case 'API':
      return { lane, group: 'ENDPOINT' };
    case 'DTO':
      return { lane, group: 'DTO' };
    case 'ENTITY':
    case 'COLUMN':
      return { lane: 'BACKEND', group: 'ENTITY' };
    case 'FIELD':
      return {
        lane,
        group: node.parent?.startsWith('ENTITY:') ? 'ENTITY' : 'DTO',
      };
    case 'SERVICE':
    case 'METHOD':
      if (role === 'CONTROLLER') return { lane, group: 'CONTROLLER' };
      if (role === 'REPOSITORY') return { lane, group: 'REPOSITORY' };
      if (role === 'ENTITY') return { lane, group: 'ENTITY' };
      if (role === 'CLIENT') return { lane, group: 'CLIENT' };
      if (role === 'DTO') return { lane, group: 'DTO' };
      if (node.detail.decision === true) return { lane, group: 'RULE' };
      if (role === 'SERVICE') return { lane, group: 'SERVICE' };
      return { lane, group: 'METHOD' };
    case 'EVENT':
      return { lane, group: 'METHOD' };
    default:
      return undefined;
  }
}

/** La carte d'un élément : la classe (ou le DTO, l'entité, le store) qui le porte. */
function cardOf(index: MapIndex, node: MapNode): { card: string; title: string } {
  const owner = str(node.detail.owner);
  // Une méthode de composant : dans la carte du composant lui-même (une seule carte par composant).
  if (node.kind === 'METHOD' && node.parent?.startsWith('COMPONENT:') && index.nodes.has(node.parent))
    return { card: node.parent, title: index.nodes.get(node.parent)?.name ?? owner ?? simple(node.parent) };
  if ((node.kind === 'METHOD' || node.kind === 'STREAM') && owner)
    return { card: `${sourceOf(node.id)}|${owner}`, title: owner };
  if ((node.kind === 'FIELD' || node.kind === 'COLUMN' || node.kind === 'METHOD') && node.parent) {
    const parent = index.nodes.get(node.parent);
    return { card: node.parent, title: parent?.label ?? parent?.name ?? simple(node.parent) };
  }
  return { card: node.id, title: node.label ?? node.name };
}

const subOf = (node: MapNode): string | undefined => {
  const method = str(node.detail.httpMethod);
  const path = str(node.detail.path);
  if (method && path) return `${method} ${path}`;
  const type = str(node.detail.type);
  if (type) return type;
  const table = str(node.detail.table);
  if (table) return table;
  return undefined;
};

const firstEvidence = (list: readonly Evidence[] | undefined): Evidence | undefined => list?.[0];

const emptyStatuses = (): Record<MapConfidence, number> => ({ CONFIRMED: 0, PROBABLE: 0, UNKNOWN: 0 });

/**
 * La carte d'une fonctionnalité. `query` restreint et pagine le tableau des relations ; les faisceaux, les
 * compteurs et les lacunes portent toujours sur toutes les relations de la fonctionnalité.
 */
export function featureMap(
  index: MapIndex,
  cov: CoverageContext,
  featureId: string,
  query: FeatureMapQuery = {},
): FeatureMap | undefined {
  const feature = index.featureById.get(featureId);
  const detail = featureDetail(index, cov, featureId, MAX_FEATURE_EDGES);
  if (!feature || !detail) return undefined;
  const sources = new Map(index.model.scan.sources.map((s) => [s.sourceId, s]));
  const sourceLayer = (src: string): MapLayer | undefined => sources.get(src)?.layer;

  // ── Les éléments ──
  const items = new Map<string, FeatureMapItem>();
  const ids = new Set([...feature.nodes, ...detail.nodes.map((n) => n.id)]);
  for (const id of ids) {
    const node = index.nodes.get(id);
    if (!node) continue;
    const where = place(node, sourceLayer);
    if (!where) continue;
    const { card, title } = cardOf(index, node);
    const precise = subOf(node);
    const sub = precise && precise !== node.name && precise !== node.label ? precise : undefined;
    const evidence = firstEvidence(node.evidence);
    items.set(id, {
      id,
      lane: where.lane,
      group: where.group,
      kind: node.kind,
      name: node.name,
      ...(node.label ? { label: node.label } : {}),
      ...(sub ? { sub } : {}),
      card,
      cardTitle: title,
      links: 0,
      ...(PERSISTENCE_GROUPS.has(where.group) ? { persistence: true } : {}),
      ...(evidence ? { evidence } : {}),
    });
  }

  // ── Les relations ──
  const relations: FeatureMapRelation[] = [];
  const persistent = (id: string): boolean => items.get(id)?.persistence === true;
  const relation = (edge: MapEdge): FeatureMapRelation | undefined => {
    const from = items.get(edge.from);
    const to = items.get(edge.to);
    const base = CATEGORY_OF[edge.kind];
    if (!from || !to || !base) return undefined;
    const category: FeatureCategory =
      (edge.kind === 'READS' || edge.kind === 'WRITES') && (persistent(edge.to) || persistent(edge.from))
        ? 'PERSISTENCE'
        : base;
    const evidence = firstEvidence(edge.evidence);
    return {
      id: edge.id,
      kind: edge.kind,
      category,
      from: from.id,
      to: to.id,
      fromName: from.label ?? from.name,
      toName: to.label ?? to.name,
      fromLane: from.lane,
      toLane: to.lane,
      fromGroup: from.group,
      toGroup: to.group,
      status: edge.confidence,
      reason: edge.reason,
      ...(evidence ? { evidence } : {}),
    };
  };
  const seen = new Set<string>();
  for (const edge of detail.edges) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    const r = relation(edge);
    if (r) relations.push(r);
  }

  // ── Les API externes : services tiers et appels établis par le scan (jamais un endpoint interne) ──
  const graph = {
    nodes: [...items.keys()].map((id) => index.nodes.get(id)).filter((n): n is MapNode => n !== undefined),
    edges: [],
    depth: 0,
    limit: 0,
    truncated: false,
  };
  const unclassified: string[] = [];
  for (const out of outboundOf(index, graph)) {
    const label = [out.method, out.path].filter(Boolean).join(' ') || out.endpoint;
    if (out.scope !== 'EXTERNAL') {
      unclassified.push(`${label} (${out.name})`);
      continue;
    }
    const serviceId = `EXT:${out.api}`;
    if (!items.has(serviceId))
      items.set(serviceId, {
        id: serviceId,
        lane: 'EXTERNAL',
        group: 'EXTERNAL_SERVICE',
        kind: 'EXTERNAL',
        name: out.name,
        ...(out.provider ? { sub: out.provider } : {}),
        card: serviceId,
        cardTitle: out.name,
        links: 0,
      });
    const callId = `EXT:${out.endpoint}`;
    if (!items.has(callId)) {
      const evidence = firstEvidence(out.evidence);
      items.set(callId, {
        id: callId,
        lane: 'EXTERNAL',
        group: 'EXTERNAL_CALL',
        kind: 'EXTERNAL',
        name: label,
        ...(out.client ? { sub: out.client } : {}),
        card: serviceId,
        cardTitle: out.name,
        links: 0,
        ...(evidence ? { evidence } : {}),
      });
    }
    const from = items.get(out.from);
    const to = items.get(callId);
    if (!from || !to) continue;
    const evidence = firstEvidence(out.evidence);
    relations.push({
      id: `EXT|${out.from}|${out.endpoint}`,
      kind: 'EXTERNAL_CALL',
      category: 'EXTERNAL',
      from: from.id,
      to: to.id,
      fromName: from.label ?? from.name,
      toName: label,
      fromLane: from.lane,
      toLane: 'EXTERNAL',
      fromGroup: from.group,
      toGroup: 'EXTERNAL_CALL',
      status: out.confidence,
      reason: out.how,
      ...(evidence ? { evidence } : {}),
    });
  }
  // Une relation dans chaque sens au plus une fois (deux appels sortants identiques ne font qu'un).
  const unique = [...new Map(relations.map((r) => [r.id, r])).values()];

  // ── Compteurs, faisceaux ──
  const categories = Object.fromEntries(FEATURE_CATEGORIES.map((c) => [c, 0])) as Record<
    FeatureCategory,
    number
  >;
  const statuses = emptyStatuses();
  const bundles = new Map<string, FeatureMapBundle>();
  for (const r of unique) {
    categories[r.category] += 1;
    statuses[r.status] += 1;
    const from = items.get(r.from);
    const to = items.get(r.to);
    if (from) from.links += 1;
    if (to && to !== from) to.links += 1;
    const key = `${r.category}|${r.fromLane}|${r.fromGroup}|${r.toLane}|${r.toGroup}`;
    const bundle = bundles.get(key) ?? {
      key,
      category: r.category,
      fromLane: r.fromLane,
      fromGroup: r.fromGroup,
      toLane: r.toLane,
      toGroup: r.toGroup,
      count: 0,
      statuses: emptyStatuses(),
    };
    bundle.count += 1;
    bundle.statuses[r.status] += 1;
    bundles.set(key, bundle);
  }
  // Un service externe compte les relations de ses appels.
  for (const item of items.values())
    if (item.group === 'EXTERNAL_SERVICE')
      item.links = [...items.values()]
        .filter((i) => i.group === 'EXTERNAL_CALL' && i.card === item.id)
        .reduce((sum, i) => sum + i.links, 0);

  const sorted = [...items.values()].sort(
    (a, b) =>
      (LANE_RANK.get(a.lane) ?? 9) - (LANE_RANK.get(b.lane) ?? 9) ||
      (GROUP_RANK.get(a.group) ?? 99) - (GROUP_RANK.get(b.group) ?? 99) ||
      a.cardTitle.localeCompare(b.cardTitle) ||
      (a.label ?? a.name).localeCompare(b.label ?? b.name),
  );
  // ── Les cartes renvoyées : par groupe, les plus reliées (et celle de l'élément demandé) ──
  const groupCards = new Map<string, Map<string, number>>();
  const groupCount = new Map<string, number>();
  for (const i of sorted) {
    const g = `${i.lane}|${i.group}`;
    const cards = groupCards.get(g) ?? new Map<string, number>();
    cards.set(i.card, (cards.get(i.card) ?? 0) + i.links);
    groupCards.set(g, cards);
    groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  }
  const wanted = query.item ? (items.get(query.item)?.card ?? query.item) : undefined;
  const shownCards = new Map<string, Set<string>>();
  for (const [g, cards] of groupCards) {
    // Tri stable : à liens égaux, l'ordre alphabétique des cartes est gardé.
    const ranked = [...cards].sort((a, b) => b[1] - a[1]).slice(0, FEATURE_GROUP_CARDS);
    const set = new Set(ranked.map(([card]) => card));
    if (wanted && cards.has(wanted)) set.add(wanted);
    shownCards.set(g, set);
  }
  const shown = sorted.filter((i) => shownCards.get(`${i.lane}|${i.group}`)?.has(i.card));
  const lanes = FEATURE_LANES.map((lane) => {
    const groups: FeatureMap['lanes'][number]['groups'] = [];
    for (const [g, cards] of groupCards) {
      const [l, group] = g.split('|') as [FeatureLane, FeatureGroup];
      if (l !== lane) continue;
      groups.push({
        group,
        count: groupCount.get(g) ?? 0,
        cards: cards.size,
        shown: shownCards.get(g)?.size ?? 0,
      });
    }
    return { lane, present: groups.length > 0, groups };
  });

  // ── Les conditions de la fonctionnalité ──
  const conditions: ConditionRow[] = sorted
    .filter((i) => i.kind === 'CONDITION')
    .map((i) => index.nodes.get(i.id))
    .filter((n): n is MapNode => n !== undefined)
    .map((n) => conditionRow(index, n));

  // ── L'arborescence de l'interface ──
  const tree = treeOf(index, shown, unique);

  // ── Les lacunes, avec leur cause ──
  const gaps = gapsOf(index, feature, items, sorted, unclassified, detail.truncated, featureId);

  // ── Le tableau des relations, filtré et paginé ──
  const q = query.q?.trim().toLowerCase() ?? '';
  const filtered = unique
    .filter((r) => !query.category || r.category === query.category)
    .filter((r) => !query.lane || r.fromLane === query.lane || r.toLane === query.lane)
    .filter((r) => !query.status || r.status === query.status)
    .filter(
      (r) =>
        !query.item ||
        r.from === query.item ||
        r.to === query.item ||
        items.get(r.from)?.card === query.item ||
        items.get(r.to)?.card === query.item,
    )
    .filter((r) => !q || `${r.fromName} ${r.toName} ${r.reason} ${r.kind}`.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        FEATURE_CATEGORIES.indexOf(a.category) - FEATURE_CATEGORIES.indexOf(b.category) ||
        (LANE_RANK.get(a.fromLane) ?? 9) - (LANE_RANK.get(b.fromLane) ?? 9) ||
        a.fromName.localeCompare(b.fromName) ||
        a.toName.localeCompare(b.toName),
    );
  const size = Math.min(MAX_PAGE, Math.max(1, Math.trunc(query.size ?? 25)));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(pages, Math.max(1, Math.trunc(query.page ?? 1)));

  const coverage = cov.coverage.get(feature.id);
  return {
    feature: {
      id: feature.id,
      name: feature.name,
      status: feature.status,
      ...(feature.module ? { module: feature.module } : {}),
      ...(coverage
        ? { coverage: { status: coverage.status, met: coverage.met, applicable: coverage.applicable } }
        : {}),
      scenarios: new Set(
        cov.links.filter((l) => l.feature === feature.id && l.status !== 'REJECTED').map((l) => l.scenario),
      ).size,
    },
    items: shown,
    lanes,
    itemCount: sorted.length,
    tree,
    bundles: [...bundles.values()].sort(
      (a, b) =>
        FEATURE_CATEGORIES.indexOf(a.category) - FEATURE_CATEGORIES.indexOf(b.category) || b.count - a.count,
    ),
    categories,
    statuses,
    conditions,
    gaps,
    relations: { items: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, size },
    relationCount: unique.length,
    truncated: detail.truncated,
    scanId: index.scanId,
  };
}

/** L'arborescence de l'interface : pages, composants, conteneurs, puis boutons et champs (liens « contient »). */
function treeOf(
  index: MapIndex,
  items: readonly FeatureMapItem[],
  relations: readonly FeatureMapRelation[],
): FeatureTreeNode[] {
  const UI: ReadonlySet<FeatureGroup> = new Set(['PAGE', 'COMPONENT', 'CONTAINER', 'BUTTON', 'FIELD']);
  const ui = items.filter(
    (i) => i.lane === 'FRONTEND' && UI.has(i.group) && i.kind !== 'METHOD' && i.kind !== 'STREAM',
  );
  const known = new Set(ui.map((i) => i.id));
  const pages = new Set(ui.filter((i) => i.group === 'PAGE').map((i) => i.id));
  const parent = new Map<string, string>();
  for (const r of relations)
    if (r.kind === 'CONTAINS' && known.has(r.from) && known.has(r.to) && !parent.has(r.to) && r.from !== r.to)
      parent.set(r.to, r.from);
  for (const i of ui) {
    if (parent.has(i.id)) continue;
    const node = index.nodes.get(i.id);
    // Un champ sans conteneur : sous son composant. Un composant : sous la route qui l'affiche.
    if (node?.parent && known.has(node.parent) && node.parent !== i.id) parent.set(i.id, node.parent);
    else if (i.group === 'COMPONENT') {
      const route = relations.find((r) => r.to === i.id && pages.has(r.from));
      if (route) parent.set(i.id, route.from);
    }
  }
  // Aucun cycle : un parent qui descend de l'enfant est ignoré.
  const ancestors = (id: string): Set<string> => {
    const out = new Set<string>();
    for (let cur = parent.get(id); cur && !out.has(cur); cur = parent.get(cur)) out.add(cur);
    return out;
  };
  for (const [child] of [...parent]) if (ancestors(child).has(child)) parent.delete(child);
  const children = new Map<string, FeatureMapItem[]>();
  for (const i of ui) {
    const p = parent.get(i.id);
    if (!p) continue;
    const list = children.get(p);
    if (list) list.push(i);
    else children.set(p, [i]);
  }
  const build = (i: FeatureMapItem, depth: number): FeatureTreeNode => ({
    id: i.id,
    kind: i.kind as FeatureTreeNode['kind'],
    name: i.label ?? i.name,
    children: depth > 12 ? [] : (children.get(i.id) ?? []).map((c) => build(c, depth + 1)),
  });
  return ui.filter((i) => !parent.has(i.id)).map((i) => build(i, 0));
}

function gapsOf(
  index: MapIndex,
  feature: { diagnostics?: string[] },
  items: ReadonlyMap<string, FeatureMapItem>,
  sorted: readonly FeatureMapItem[],
  unclassified: readonly string[],
  truncated: boolean,
  featureId: string,
): FeatureMapGap[] {
  const gaps: FeatureMapGap[] = [];
  const scanSources = index.model.scan.sources;
  const present = new Set(sorted.map((i) => i.lane));
  for (const lane of ['FRONTEND', 'BFF', 'BACKEND'] as const) {
    if (present.has(lane)) continue;
    const configured = scanSources.filter(
      (s) => s.layer === lane || (lane === 'BACKEND' && s.layer === 'DATABASE'),
    );
    gaps.push(
      configured.length === 0
        ? {
            code: 'LANE_NO_SOURCE',
            lane,
            items: [],
            detail: 'aucune source de cette couche n’est configurée',
          }
        : {
            code: 'LANE_NOT_REACHED',
            lane,
            items: configured.map((s) => s.name),
            detail: 'la fonctionnalité n’atteint aucun élément de cette couche dans le scan',
          },
    );
  }
  if (present.has('FRONTEND') && !sorted.some((i) => i.group === 'STORE'))
    gaps.push({
      code: 'NO_STORE',
      lane: 'FRONTEND',
      items: [],
      detail:
        'aucun store atteint : l’analyseur reconnaît une classe à état par ses Subject/BehaviorSubject ; un état tenu autrement n’apparaît pas comme store',
    });
  // Les éléments non reliés : rangés à part, avec ce que le scan permet d'en dire.
  const isolated = sorted.filter((i) => i.links === 0 && i.group !== 'EXTERNAL_SERVICE');
  if (isolated.length > 0)
    gaps.push({
      code: 'ISOLATED',
      items: isolated
        .slice(0, 40)
        .map(
          (i) =>
            `${i.cardTitle !== (i.label ?? i.name) ? `${i.cardTitle}.` : ''}${i.label ?? i.name} — ${isolationCause(index, i)}`,
        ),
      detail: `${String(isolated.length)} élément(s) sans relation dans cette fonctionnalité`,
    });
  // Un appel vers un service tiers établi n'a pas d'endpoint dans les sources : ce n'est pas une rupture.
  const external = new Set(sorted.filter((i) => i.group === 'EXTERNAL_CALL').map((i) => i.name));
  const broken = (index.model.correlations ?? []).filter(
    (c) =>
      items.has(c.from) &&
      (c.status === 'UNDEMONSTRATED' || c.status === 'BLOCKED') &&
      !external.has(`${c.method} ${c.path}`),
  );
  if (broken.length > 0)
    gaps.push({
      code: 'BROKEN_CORRELATION',
      items: broken
        .slice(0, 20)
        .map((c) => `${c.method} ${c.path} — ${c.causes.map((x) => x.message).join(' ; ') || c.status}`),
      detail: 'appels dont la cible n’est pas démontrée',
    });
  if (unclassified.length > 0)
    gaps.push({
      code: 'UNCLASSIFIED_CALL',
      lane: 'EXTERNAL',
      items: unclassified.slice(0, 20),
      detail: 'appels sortants dont la cible n’est ni un endpoint interne connu ni un service tiers établi',
    });
  const lanesUsed = new Set<string>(sorted.map((i) => (i.lane === 'EXTERNAL' ? 'BACKEND' : i.lane)));
  for (const s of scanSources) {
    if (!lanesUsed.has(s.layer) && !(s.layer === 'DATABASE' && lanesUsed.has('BACKEND'))) continue;
    const missing = (s.dependencies ?? []).filter((d) => d.state !== 'RESOLVED' && d.state !== 'LIBRARY');
    if (missing.length > 0 || (s.unresolvedTypes ?? []).length > 0)
      gaps.push({
        code: 'DEPENDENCY_UNAVAILABLE',
        items: [
          ...missing.slice(0, 15).map((d) => `${d.coordinates} — ${d.state}${d.note ? ` (${d.note})` : ''}`),
          ...(s.unresolvedTypes ?? []).slice(0, 15).map((t) => `${t} — type introuvable`),
        ],
        detail: `${s.name} : dépendances Maven ou contrats non lus`,
      });
    if (s.state === 'PARTIAL' || s.skipped > 0)
      gaps.push({
        code: 'SOURCE_PARTIAL',
        items: [s.name],
        detail: `${s.name} : ${String(s.skipped)} fichier(s) non lu(s)`,
      });
  }
  if ((feature.diagnostics ?? []).length > 0)
    gaps.push({
      code: 'CHAIN_BREAK',
      items: (feature.diagnostics ?? []).slice(0, 20),
      detail: 'ruptures relevées dans les écrans',
    });
  if (truncated)
    gaps.push({
      code: 'TRUNCATED',
      items: [featureId],
      detail: `relations coupées au-delà de ${String(MAX_FEATURE_EDGES)}`,
    });
  return gaps;
}

/** Ce que le scan dit d'un élément sans relation (jamais une cause supposée). */
function isolationCause(index: MapIndex, item: FeatureMapItem): string {
  const node = index.nodes.get(item.id);
  const source = index.model.scan.sources.find((s) => s.sourceId === sourceOf(item.id));
  if (source && (source.state === 'PARTIAL' || source.skipped > 0)) return 'source lue partiellement';
  if (node?.parent) {
    // Le conteneur (DTO, entité) est relié ailleurs, mais aucune lecture ni écriture de ce membre n'est démontrée.
    const owner = node.parent;
    const ownerLinked = (index.in.get(owner)?.length ?? 0) + (index.out.get(owner)?.length ?? 0) > 0;
    const memberLinked = (index.in.get(item.id)?.length ?? 0) + (index.out.get(item.id)?.length ?? 0) > 0;
    if (memberLinked) return 'relié hors de cette fonctionnalité seulement';
    if (ownerLinked)
      return 'son conteneur est relié, aucune lecture ni écriture de ce membre n’est démontrée';
  }
  const anywhere = (index.in.get(item.id)?.length ?? 0) + (index.out.get(item.id)?.length ?? 0);
  return anywhere > 0 ? 'relié hors de cette fonctionnalité seulement' : 'aucune relation dans le scan';
}
