import type {
  ApiCatalog,
  ApiFeatureUse,
  ApiRow,
  ApiScenarioUse,
  ApiService,
  ApiSheet,
  CartographyModel,
  ConceptRow,
  Feature,
  FeatureCoverage,
  FeatureDetail,
  FeatureRow,
  FieldConcept,
  FieldImpact,
  FieldIssue,
  FieldRow,
  FieldScenario,
  FieldSheet,
  FieldTestState,
  ImpactItems,
  MapConfidence,
  MapDecision,
  MapEdge,
  MapEdgeKind,
  MapLayer,
  MapListQuery,
  MapNode,
  MapPage,
  MapSubgraph,
  ScenarioLink,
} from '../sdk/core/cartography.js';
import type { LastRun } from './coverage.js';

/**
 * L'EXPLORATION PROGRESSIVE : un index du graphe d'un scan, construit une fois (puis gardé en cache par le
 * serveur), et des requêtes BORNÉES — une page de fonctionnalités, les champs d'une seule fonctionnalité,
 * la fiche d'un seul champ avec son sous-graphe limité en profondeur et en nombre de nœuds. Rien ne parcourt
 * le graphe sans borne ; aucune requête ne renvoie le graphe entier.
 */
const RANK: Record<MapConfidence, number> = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };
const weakest = (a: MapConfidence, b: MapConfidence): MapConfidence => (RANK[a] <= RANK[b] ? a : b);
const LAYERS: readonly MapLayer[] = ['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE', 'EVENTS', 'OTHER'];
const layerRank = (layer: MapLayer | undefined): number => (layer ? LAYERS.indexOf(layer) : LAYERS.length);
const FIELD_EDGES: ReadonlySet<MapEdgeKind> = new Set(['SENDS', 'TRANSFORMS', 'DEPENDS_ON', 'READS']);
export const MAX_PAGE = 100;
export const MAX_SUBGRAPH = 300;
export const MAX_DEPTH = 6;

export interface MapIndex {
  scanId: string;
  buildMs: number;
  model: CartographyModel;
  nodes: Map<string, MapNode>;
  out: Map<string, MapEdge[]>;
  in: Map<string, MapEdge[]>;
  features: Feature[];
  featureById: Map<string, Feature>;
  conceptById: Map<string, FieldConcept>;
  conceptByNode: Map<string, FieldConcept>;
  /** Les concepts touchés par chaque fonctionnalité (ses champs regroupés). */
  featureConcepts: Map<string, FieldConcept[]>;
  /** Le texte cherché d'un concept : noms, libellés, conteneurs, colonnes, écrans, API, services, tables. */
  conceptText: Map<string, string>;
  fieldCount: number;
  mergedEvidence: number;
  /** Les fonctionnalités consommatrices de chaque API, calculées à la première demande. */
  apiUses?: Map<string, ApiFeatureUse[]>;
  /** Les champs et colonnes de chaque conteneur (« source|Conteneur »), calculés à la première demande. */
  members?: Map<string, string[]>;
}

export function buildIndex(model: CartographyModel): MapIndex {
  const started = performance.now();
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const out = new Map<string, MapEdge[]>();
  const inc = new Map<string, MapEdge[]>();
  let mergedEvidence = 0;
  for (const edge of model.edges) {
    let list = out.get(edge.from);
    if (!list) out.set(edge.from, (list = []));
    list.push(edge);
    let back = inc.get(edge.to);
    if (!back) inc.set(edge.to, (back = []));
    back.push(edge);
    mergedEvidence += Math.max(0, edge.evidence.length - 1);
  }
  const conceptById = new Map(model.concepts.map((c) => [c.id, c]));
  const conceptByNode = new Map<string, FieldConcept>();
  for (const concept of model.concepts) for (const id of concept.fields) conceptByNode.set(id, concept);
  const featureConcepts = new Map<string, FieldConcept[]>();
  for (const feature of model.features) {
    const seen = new Map<string, FieldConcept>();
    for (const id of feature.fields) {
      const concept = conceptByNode.get(id);
      if (concept) seen.set(concept.id, concept);
    }
    featureConcepts.set(feature.id, [...seen.values()]);
  }
  const featureById = new Map(model.features.map((f) => [f.id, f]));
  const conceptText = new Map<string, string>();
  for (const concept of model.concepts) {
    const text: string[] = [concept.name];
    for (const id of concept.fields) {
      const node = nodes.get(id);
      if (!node) continue;
      text.push(
        node.name,
        node.label ?? '',
        String(node.detail.container ?? ''),
        String(node.detail.column ?? ''),
      );
      if (node.parent) text.push(nodes.get(node.parent)?.name ?? '');
    }
    for (const featureId of concept.features) {
      const feature = featureById.get(featureId);
      if (!feature) continue;
      text.push(feature.name);
      for (const id of feature.nodes) {
        const node = nodes.get(id);
        if (
          node &&
          (node.kind === 'ROUTE' || node.kind === 'API' || node.kind === 'SERVICE' || node.kind === 'ENTITY')
        )
          text.push(node.name);
      }
    }
    conceptText.set(concept.id, text.join(' ').toLowerCase());
  }
  return {
    scanId: model.scan.id,
    buildMs: Math.round((performance.now() - started) * 10) / 10,
    model,
    nodes,
    out,
    in: inc,
    features: model.features,
    featureById,
    conceptById,
    conceptByNode,
    featureConcepts,
    conceptText,
    fieldCount: model.nodes.filter((n) => n.kind === 'FIELD' || n.kind === 'COLUMN').length,
    mergedEvidence,
  };
}

/** Ce que la couverture apporte aux requêtes : associations, couverture, dernières exécutions, décisions. */
export interface CoverageContext {
  links: ScenarioLink[];
  coverage: Map<string, FeatureCoverage>;
  issues: FieldIssue[];
  lastRuns: ReadonlyMap<string, LastRun>;
  decisions: readonly MapDecision[];
}

const clampPage = (query: MapListQuery): { page: number; size: number } => ({
  page: Math.max(1, Math.trunc(query.page ?? 1) || 1),
  size: Math.min(MAX_PAGE, Math.max(1, Math.trunc(query.size ?? 20) || 20)),
});

function paged<T>(items: T[], query: MapListQuery): MapPage<T> {
  const { page, size } = clampPage(query);
  const last = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, last);
  return {
    items: items.slice((current - 1) * size, current * size),
    total: items.length,
    page: current,
    size,
  };
}

const counted = (link: ScenarioLink): boolean =>
  link.status !== 'REJECTED' && (link.status === 'VALIDATED' || link.confidence === 'CONFIRMED');

// ── Niveau 1 : les fonctionnalités ────────────────────────────────────────────────────────────────

export function featureRow(index: MapIndex, cov: CoverageContext, feature: Feature): FeatureRow {
  const concepts = index.featureConcepts.get(feature.id) ?? [];
  const coverage = cov.coverage.get(feature.id);
  return {
    id: feature.id,
    name: feature.name,
    ...(feature.module ? { module: feature.module } : {}),
    status: feature.status,
    layers: feature.layers,
    fields: concepts.length,
    scenarios: cov.links.filter((l) => l.feature === feature.id && l.status !== 'REJECTED').length,
    reuse: concepts.filter((c) => c.features.length > 1).length,
    ...(coverage
      ? {
          coverage: {
            status: coverage.status,
            met: coverage.met,
            applicable: coverage.applicable,
            formula: coverage.formula,
            criteria: coverage.criteria.map((c) => ({
              id: c.id,
              ...(c.met !== undefined ? { met: c.met } : {}),
              detail: c.detail,
            })),
          },
        }
      : {}),
  };
}

export function queryFeatures(
  index: MapIndex,
  cov: CoverageContext,
  query: MapListQuery,
): MapPage<FeatureRow> {
  const q = query.q?.trim().toLowerCase() ?? '';
  const rows = index.features
    .filter((f) => (query.status ? f.status === query.status : f.status !== 'REJECTED'))
    .filter((f) => !query.module || f.module === query.module)
    .filter((f) => !query.layer || f.layers.includes(query.layer as MapLayer))
    .filter((f) => !query.coverage || cov.coverage.get(f.id)?.status === query.coverage)
    .filter((f) => !q || f.name.toLowerCase().includes(q) || (f.module ?? '').toLowerCase().includes(q))
    .map((f) => featureRow(index, cov, f));
  const by = query.sort ?? 'name';
  const ratio = (r: FeatureRow): number =>
    r.coverage && r.coverage.applicable > 0 ? r.coverage.met / r.coverage.applicable : -1;
  rows.sort((a, b) =>
    by === 'fields'
      ? b.fields - a.fields || a.name.localeCompare(b.name)
      : by === 'scenarios'
        ? b.scenarios - a.scenarios || a.name.localeCompare(b.name)
        : by === 'reuse'
          ? b.reuse - a.reuse || a.name.localeCompare(b.name)
          : by === 'coverage'
            ? ratio(b) - ratio(a) || a.name.localeCompare(b.name)
            : a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  return paged(rows, query);
}

const UI_FLOW = new Set(['TRIGGERS', 'CALLS', 'READS', 'WRITES']);

/** Les éléments d'interface d'une fonctionnalité et les chemins qu'ils déclenchent (bornés). */
function uiEntries(
  index: MapIndex,
  reached: ReadonlySet<string>,
  budget: number,
): { edges: MapEdge[]; truncated: boolean } {
  const edges: MapEdge[] = [];
  let truncated = false;
  const push = (e: MapEdge): boolean => {
    if (edges.length >= Math.max(0, budget)) {
      truncated = true;
      return false;
    }
    edges.push(e);
    return true;
  };
  // Descendre des composants vers leurs conteneurs et éléments interactifs ; ne garder un conteneur que s'il
  // mène à un élément interactif ou à un composant affiché.
  const keep = new Map<string, boolean>();
  const leads = (id: string, depth: number): boolean => {
    const known = keep.get(id);
    if (known !== undefined) return known;
    keep.set(id, false);
    if (depth > 14) return false;
    let ok = false;
    for (const e of index.out.get(id) ?? []) {
      if (e.kind !== 'CONTAINS') continue;
      const kind = index.nodes.get(e.to)?.kind;
      if (kind === 'BUTTON' || kind === 'COMPONENT' || (kind === 'CONTAINER' && leads(e.to, depth + 1)))
        ok = true;
    }
    keep.set(id, ok);
    return ok;
  };
  const buttons: string[] = [];
  const walk = (id: string, depth: number): void => {
    for (const e of index.out.get(id) ?? []) {
      if (e.kind !== 'CONTAINS') continue;
      const kind = index.nodes.get(e.to)?.kind;
      if (kind === 'BUTTON') {
        if (!push(e)) return;
        buttons.push(e.to);
      } else if (kind === 'CONTAINER' && leads(e.to, depth + 1)) {
        if (!push(e)) return;
        walk(e.to, depth + 1);
      } else if (kind === 'COMPONENT' && reached.has(e.to)) {
        if (!push(e)) return;
      }
    }
  };
  for (const id of reached) if (index.nodes.get(id)?.kind === 'COMPONENT') walk(id, 0);
  // Les conditions des boutons, puis ce qu'ils déclenchent, jusqu'aux nœuds déjà dans la fonctionnalité.
  const seen = new Set<string>(reached);
  const queue: string[] = [];
  for (const b of buttons)
    for (const e of index.out.get(b) ?? []) {
      if (e.kind === 'VISIBLE_WHEN' || e.kind === 'ENABLED_WHEN' || e.kind === 'TRIGGERS') {
        if (!push(e)) break;
        if (e.kind === 'TRIGGERS' && !seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
  for (let visits = 0; queue.length > 0 && visits < 400; visits += 1) {
    const cur = queue.shift() ?? '';
    for (const e of index.out.get(cur) ?? []) {
      if (!UI_FLOW.has(e.kind)) continue;
      if (!push(e)) return { edges, truncated };
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return { edges, truncated };
}

export function featureDetail(
  index: MapIndex,
  cov: CoverageContext,
  id: string,
  edgeLimit = 400,
): FeatureDetail | undefined {
  const feature = index.featureById.get(id);
  if (!feature) return undefined;
  const { nodes: reached, reach: _reach, fields, ...rest } = feature;
  const set = new Set(reached);
  const edges: MapEdge[] = [];
  let truncated = false;
  for (const nodeId of reached)
    for (const edge of index.out.get(nodeId) ?? [])
      if (set.has(edge.to)) {
        if (edges.length >= edgeLimit) {
          truncated = true;
          break;
        }
        edges.push(edge);
      }
  // Les points d'entrée de l'interface : onglets, conteneurs et éléments interactifs des composants de la
  // fonctionnalité (seulement sur le chemin d'un élément interactif ou d'un composant affiché), leurs
  // conditions, et ce qu'ils déclenchent (y compris une méthode vue dans le contexte des valeurs du gabarit).
  const ui = uiEntries(index, set, edgeLimit - edges.length);
  for (const e of ui.edges) if (!edges.some((x) => x.id === e.id)) edges.push(e);
  if (ui.truncated) truncated = true;
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  const related = new Map<string, { id: string; name: string; via: string[] }>();
  for (const concept of index.featureConcepts.get(feature.id) ?? [])
    for (const other of concept.features) {
      if (other === feature.id) continue;
      const f = index.featureById.get(other);
      if (!f || f.status === 'REJECTED') continue;
      const entry = related.get(other) ?? { id: other, name: f.name, via: [] };
      if (!entry.via.includes(concept.name)) entry.via.push(concept.name);
      related.set(other, entry);
    }
  const coverage = cov.coverage.get(feature.id);
  return {
    feature: { ...rest, nodeCount: reached.length, fieldCount: fields.length },
    ...(coverage ? { coverage } : {}),
    links: cov.links.filter((l) => l.feature === feature.id),
    related: [...related.values()],
    edges,
    nodes: [...used]
      .map((nid) => index.nodes.get(nid))
      .filter((n): n is MapNode => n !== undefined)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        layer: n.layer,
        name: n.name,
        ...(n.label ? { label: n.label } : {}),
        ...(typeof n.detail.tab === 'string' ? { tab: n.detail.tab } : {}),
        ...(n.kind === 'CONDITION' && n.detail.whenTrue === false ? { negated: true as const } : {}),
        ...(n.kind === 'BUTTON' && typeof n.detail.unresolved === 'string'
          ? { unresolved: n.detail.unresolved }
          : {}),
      })),
    truncated,
  };
}

// ── Niveau 2 : les champs d'une fonctionnalité ────────────────────────────────────────────────────

/** Le champ qui représente un concept dans une fonctionnalité : le contrôle saisi d'abord, sinon la couche la plus haute. */
function representative(index: MapIndex, feature: Feature, concept: FieldConcept): MapNode | undefined {
  const own = new Set(feature.fields);
  const candidates = concept.fields
    .filter((id) => own.has(id))
    .map((id) => index.nodes.get(id))
    .filter((n): n is MapNode => n !== undefined);
  candidates.sort(
    (a, b) =>
      (a.parent?.startsWith('COMPONENT:') ? 0 : 1) - (b.parent?.startsWith('COMPONENT:') ? 0 : 1) ||
      layerRank(a.layer) - layerRank(b.layer) ||
      a.id.localeCompare(b.id),
  );
  return candidates[0];
}

/** Ce que les scénarios ont fait d'un champ dans une fonctionnalité : associé, exécuté, vérifié par assertion. */
function testState(cov: CoverageContext, featureId: string, concept: FieldConcept): FieldTestState {
  const members = new Set(concept.fields);
  const coverage = cov.coverage.get(featureId);
  let state: FieldTestState = 'NONE';
  const rank: Record<FieldTestState, number> = { NONE: 0, ASSOCIATED: 1, EXECUTED: 2, VERIFIED: 3 };
  const raise = (next: FieldTestState): void => {
    if (rank[next] > rank[state]) state = next;
  };
  for (const link of cov.links) {
    if (link.feature !== featureId || !counted(link) || !link.fields.some((f) => members.has(f))) continue;
    raise('ASSOCIATED');
    const row = coverage?.scenarios.find((s) => s.scenario === link.scenario);
    if (row?.traversed) raise(row.asserted ? 'VERIFIED' : 'EXECUTED');
  }
  // Une association manuelle compte au moins comme « associé » (raise ne descend jamais).
  if (manualLinks(cov.decisions, concept.fields).length > 0) raise('ASSOCIATED');
  return state;
}

/** Les associations manuelles champ ↔ scénario encore en vigueur (dans l'ordre des décisions). */
function manualLinks(
  decisions: readonly MapDecision[],
  members: readonly string[],
): { field: string; scenario: string }[] {
  const set = new Set(members);
  const live = new Map<string, { field: string; scenario: string }>();
  for (const decision of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!set.has(decision.target) || !decision.value) continue;
    const key = `${decision.target}\u0000${decision.value}`;
    if (decision.kind === 'LINK_FIELD') live.set(key, { field: decision.target, scenario: decision.value });
    else if (decision.kind === 'UNLINK_FIELD') live.delete(key);
  }
  return [...live.values()];
}

export function featureFields(
  index: MapIndex,
  cov: CoverageContext,
  featureId: string,
  query: MapListQuery,
): MapPage<FieldRow> | undefined {
  const feature = index.featureById.get(featureId);
  if (!feature) return undefined;
  const q = query.q?.trim().toLowerCase() ?? '';
  const rows: FieldRow[] = [];
  for (const concept of index.featureConcepts.get(feature.id) ?? []) {
    const node = representative(index, feature, concept);
    if (!node) continue;
    const type = typeof node.detail.type === 'string' ? node.detail.type : undefined;
    rows.push({
      id: node.id,
      concept: concept.id,
      name: node.name,
      ...(node.label ? { label: node.label } : {}),
      ...(type ? { type } : {}),
      layers: concept.layers,
      reuse: concept.features.length,
      status: concept.status,
      tested: testState(cov, feature.id, concept),
    });
  }
  const filtered = rows
    .filter(
      (r) =>
        !q ||
        `${r.name} ${r.label ?? ''} ${index.conceptText.get(r.concept) ?? ''}`.toLowerCase().includes(q),
    )
    .filter((r) => !query.type || (r.type ?? '').toLowerCase() === query.type.toLowerCase())
    .filter((r) => !query.layer || r.layers.includes(query.layer as MapLayer))
    .filter((r) => !query.status || r.status === query.status)
    .filter((r) => !query.concept || r.concept === query.concept);
  const by = query.sort ?? 'layer';
  filtered.sort((a, b) =>
    by === 'name'
      ? (a.label ?? a.name).localeCompare(b.label ?? b.name)
      : by === 'reuse'
        ? b.reuse - a.reuse || a.name.localeCompare(b.name)
        : // Par défaut : les champs saisis d'abord, puis par couche, puis par nom.
          layerRank(index.nodes.get(a.id)?.layer) - layerRank(index.nodes.get(b.id)?.layer) ||
          (a.label ? 0 : 1) - (b.label ? 0 : 1) ||
          a.name.localeCompare(b.name),
  );
  return paged(filtered, query);
}

// ── Niveau 3 : un champ ───────────────────────────────────────────────────────────────────────────

function neighboursOf(index: MapIndex, id: string): { node: string; edge?: MapEdge }[] {
  const out: { node: string; edge?: MapEdge }[] = [];
  for (const edge of index.out.get(id) ?? []) out.push({ node: edge.to, edge });
  for (const edge of index.in.get(id) ?? []) out.push({ node: edge.from, edge });
  const node = index.nodes.get(id);
  if (node?.parent) out.push({ node: node.parent });
  return out;
}

/** Un sous-graphe borné autour de nœuds de départ : profondeur et nombre de nœuds limités, sans doublon ni cycle. */
export function subgraph(
  index: MapIndex,
  seeds: readonly string[],
  options: { depth?: number; limit?: number } = {},
): MapSubgraph {
  const depth = Math.min(MAX_DEPTH, Math.max(0, Math.trunc(options.depth ?? 2)));
  const limit = Math.min(MAX_SUBGRAPH, Math.max(1, Math.trunc(options.limit ?? 60)));
  const included = new Set<string>();
  let truncated = false;
  let frontier: string[] = [];
  for (const seed of seeds) {
    if (!index.nodes.has(seed) || included.has(seed)) continue;
    if (included.size >= limit) {
      truncated = true;
      break;
    }
    included.add(seed);
    frontier.push(seed);
  }
  for (let level = 0; level < depth && frontier.length > 0 && !truncated; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      // Un service mène à toutes ses méthodes, une fonctionnalité à tout : on ne s'y étend pas.
      if (index.nodes.get(id)?.kind === 'SERVICE') continue;
      for (const { node } of neighboursOf(index, id)) {
        if (included.has(node) || !index.nodes.has(node)) continue;
        if (included.size >= limit) {
          truncated = true;
          break;
        }
        included.add(node);
        next.push(node);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  const edges: MapEdge[] = [];
  for (const id of included)
    for (const edge of index.out.get(id) ?? []) if (included.has(edge.to)) edges.push(edge);
  return {
    nodes: [...included].map((id) => index.nodes.get(id)).filter((n): n is MapNode => n !== undefined),
    edges,
    depth,
    limit,
    truncated,
  };
}

const emptyItems = (): ImpactItems => ({
  features: [],
  components: [],
  dtos: [],
  services: [],
  endpoints: [],
  tables: [],
  scenarios: [],
});

/**
 * L'impact d'une modification d'un champ : les champs reliés (par les seuls liens de données), avec la
 * confiance du chemin ; puis ce qui les porte ou les sert. Démontré : tout le chemin est confirmé.
 */
export function fieldImpact(
  index: MapIndex,
  cov: CoverageContext,
  nodeId: string,
  maxDepth = MAX_DEPTH,
): FieldImpact {
  const reached = new Map<string, { confidence: MapConfidence; depth: number }>([
    [nodeId, { confidence: 'CONFIRMED', depth: 0 }],
  ]);
  const files = new Set<string>();
  const services = new Map<string, MapConfidence>();
  let queue = [nodeId];
  let depth = 0;
  while (queue.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const id of queue) {
      const here = reached.get(id);
      if (!here) continue;
      for (const edge of [...(index.out.get(id) ?? []), ...(index.in.get(id) ?? [])]) {
        if (!FIELD_EDGES.has(edge.kind)) continue;
        const other = edge.from === id ? edge.to : edge.from;
        const kind = index.nodes.get(other)?.kind;
        if (kind !== 'FIELD' && kind !== 'COLUMN') continue;
        const confidence = weakest(here.confidence, edge.confidence);
        for (const evidence of edge.evidence) {
          if (evidence.file) files.add(`${evidence.sourceId ?? ''}:${evidence.file}`);
          if (edge.kind === 'TRANSFORMS' && evidence.symbol) services.set(evidence.symbol, confidence);
        }
        const known = reached.get(other);
        if (known && RANK[known.confidence] >= RANK[confidence]) continue;
        reached.set(other, { confidence, depth: here.depth + 1 });
        next.push(other);
      }
    }
    queue = next;
    depth += 1;
  }
  const demonstrated = emptyItems();
  const potential = emptyItems();
  const put = (
    bucket: keyof Omit<ImpactItems, 'features'>,
    value: string,
    confidence: MapConfidence,
  ): void => {
    const target = confidence === 'CONFIRMED' ? demonstrated : potential;
    if (confidence !== 'CONFIRMED' && demonstrated[bucket].includes(value)) return;
    if (!target[bucket].includes(value)) target[bucket].push(value);
    if (confidence === 'CONFIRMED') potential[bucket] = potential[bucket].filter((v) => v !== value);
  };
  const featureConfidence = new Map<string, MapConfidence>();
  for (const [id, { confidence }] of reached) {
    const node = index.nodes.get(id);
    if (!node) continue;
    for (const evidence of node.evidence)
      if (evidence.file) files.add(`${evidence.sourceId ?? ''}:${evidence.file}`);
    const parent = node.parent ? index.nodes.get(node.parent) : undefined;
    if (parent?.kind === 'COMPONENT') put('components', parent.name, confidence);
    if (parent?.kind === 'DTO') {
      put('dtos', parent.name, confidence);
      for (const edge of index.in.get(parent.id) ?? [])
        if (edge.kind === 'READS' && index.nodes.get(edge.from)?.kind === 'API')
          put(
            'endpoints',
            index.nodes.get(edge.from)?.name ?? edge.from,
            weakest(confidence, edge.confidence),
          );
    }
    if (node.kind === 'COLUMN') put('tables', node.name, confidence);
    for (const edge of index.out.get(id) ?? [])
      if (edge.kind === 'SENDS' && index.nodes.get(edge.to)?.kind === 'METHOD')
        put('services', index.nodes.get(edge.to)?.name ?? edge.to, weakest(confidence, edge.confidence));
    const concept = index.conceptByNode.get(id);
    for (const featureId of concept?.features ?? []) {
      const feature = index.featureById.get(featureId);
      if (!feature || feature.status === 'REJECTED' || !feature.fields.includes(id)) continue;
      const via = weakest(confidence, feature.reach[id] ?? 'PROBABLE');
      const known = featureConfidence.get(featureId);
      if (!known || RANK[via] > RANK[known]) featureConfidence.set(featureId, via);
    }
  }
  for (const [symbol, confidence] of services) put('services', symbol, confidence);
  for (const [featureId, confidence] of featureConfidence) {
    const name = index.featureById.get(featureId)?.name ?? featureId;
    (confidence === 'CONFIRMED' ? demonstrated : potential).features.push({ id: featureId, name });
    for (const link of cov.links)
      if (link.feature === featureId && link.status !== 'REJECTED') {
        const via = weakest(confidence, link.status === 'VALIDATED' ? 'CONFIRMED' : link.confidence);
        put('scenarios', link.scenario, via === 'UNKNOWN' ? 'PROBABLE' : via);
      }
  }
  return {
    demonstrated,
    potential,
    depth: Math.max(0, ...[...reached.values()].map((r) => r.depth)),
    files: [...files].sort(),
  };
}

export function fieldSheet(
  index: MapIndex,
  cov: CoverageContext,
  nodeId: string,
  options: { feature?: string; depth?: number; limit?: number } = {},
): FieldSheet | undefined {
  const node = index.nodes.get(nodeId);
  const concept = index.conceptByNode.get(nodeId);
  if (!node || !concept) return undefined;
  const members = [...concept.fields].sort(
    (a, b) => layerRank(index.nodes.get(a)?.layer) - layerRank(index.nodes.get(b)?.layer),
  );
  // Le sous-graphe : le champ, puis les champs de son concept (le parcours de la donnée), puis leur contexte.
  const graph = subgraph(index, [nodeId, ...members.filter((m) => m !== nodeId)], {
    depth: options.depth ?? 1,
    limit: options.limit ?? 60,
  });
  const set = new Set(concept.fields);
  const sequence = concept.fields
    .flatMap((id) => (index.out.get(id) ?? []).filter((e) => FIELD_EDGES.has(e.kind) && set.has(e.to)))
    .sort(
      (a, b) =>
        layerRank(index.nodes.get(a.from)?.layer) - layerRank(index.nodes.get(b.from)?.layer) ||
        layerRank(index.nodes.get(a.to)?.layer) - layerRank(index.nodes.get(b.to)?.layer) ||
        a.id.localeCompare(b.id),
    );
  const reuse = concept.features
    .map((id) => index.featureById.get(id))
    .filter((f): f is Feature => f !== undefined && f.status !== 'REJECTED')
    .map((f) => {
      const touched = f.fields.filter((id) => set.has(id)).map((id) => f.reach[id] ?? 'UNKNOWN');
      const confidence = touched.reduce<MapConfidence>(
        (best, c) => (RANK[c] > RANK[best] ? c : best),
        'UNKNOWN',
      );
      return { id: f.id, name: f.name, ...(f.module ? { module: f.module } : {}), confidence };
    });
  // Les scénarios : déduits des étapes (saisie du champ), et ceux associés à la main au champ.
  const scenarios: FieldScenario[] = [];
  for (const link of cov.links) {
    if (
      !concept.features.includes(link.feature) ||
      link.status === 'REJECTED' ||
      !link.fields.some((f) => set.has(f))
    )
      continue;
    const row = cov.coverage.get(link.feature)?.scenarios.find((s) => s.scenario === link.scenario);
    scenarios.push({
      scenario: link.scenario,
      feature: link.feature,
      origin: 'INFERRED',
      associated: true,
      executed: row?.traversed === true,
      verified: row?.traversed === true && row.asserted === true,
      ...(row?.lastRun ? { lastRun: row.lastRun } : {}),
      reasons: link.reasons.filter((r) => /saisit/.test(r)).slice(0, 3),
    });
  }
  for (const manual of manualLinks(cov.decisions, concept.fields)) {
    if (scenarios.some((s) => s.scenario === manual.scenario)) continue;
    const last = cov.lastRuns.get(manual.scenario);
    scenarios.push({
      scenario: manual.scenario,
      origin: 'MANUAL',
      associated: true,
      executed: last?.flow?.status === 'PASSED',
      // Une association à la main ne prouve aucune assertion sur ce champ.
      verified: false,
      ...(last
        ? { lastRun: { run: last.run, verdict: last.flow?.status ?? 'NOT_PLAYED', at: last.at } }
        : {}),
      reasons: [],
    });
  }
  const tested = new Set(scenarios.filter((s) => s.feature).map((s) => s.feature));
  const denominator = reuse.length;
  const numerator = reuse.filter((f) => tested.has(f.id)).length;
  const homonyms = concept.homonyms
    .map((id) => index.conceptById.get(id))
    .filter((c): c is FieldConcept => c !== undefined)
    .map((c) => ({ id: c.id, name: c.name, layers: c.layers }));
  const issues = [...index.model.issues, ...cov.issues].filter(
    (i) => i.concept === concept.id || i.fields.some((f) => set.has(f)),
  );
  const feature = options.feature ? index.featureById.get(options.feature) : undefined;
  return {
    node,
    ...(feature ? { feature: { id: feature.id, name: feature.name } } : {}),
    concept: {
      id: concept.id,
      name: concept.name,
      status: concept.status,
      layers: concept.layers,
      gaps: concept.gaps,
      homonyms,
    },
    graph,
    sequence,
    reuse,
    scenarios,
    impact: fieldImpact(index, cov, nodeId),
    issues,
    coverage: {
      numerator,
      denominator,
      ...(denominator > 0 ? { percent: Math.round((numerator / denominator) * 100) } : {}),
      formula:
        denominator > 0
          ? `fonctionnalités utilisant ce champ dont un scénario associé le saisit (${String(numerator)}) / fonctionnalités utilisant ce champ (${String(denominator)})`
          : 'non calculable : aucune fonctionnalité n’utilise ce champ',
    },
    scanId: index.scanId,
  };
}

// ── Concepts et anomalies (onglet Champs & Réutilisations) ────────────────────────────────────────

export function queryConcepts(
  index: MapIndex,
  cov: CoverageContext,
  query: MapListQuery,
): MapPage<ConceptRow> {
  const q = query.q?.trim().toLowerCase() ?? '';
  const scenariosOf = new Map<string, string>();
  if (q)
    for (const link of cov.links)
      if (link.status !== 'REJECTED')
        scenariosOf.set(
          link.feature,
          `${scenariosOf.get(link.feature) ?? ''} ${link.scenario.toLowerCase()}`,
        );
  const rows = index.model.concepts
    .filter((c) => !query.layer || c.layers.includes(query.layer as MapLayer))
    .filter((c) => !query.status || c.status === query.status)
    .filter(
      (c) =>
        !q ||
        (index.conceptText.get(c.id) ?? '').includes(q) ||
        c.features.some((f) => (scenariosOf.get(f) ?? '').includes(q)),
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      layers: c.layers,
      fields: c.fields.length,
      features: c.features.length,
    }))
    .sort(
      (a, b) =>
        b.features - a.features ||
        b.fields - a.fields ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  return paged(rows, query);
}

export function queryIssues(index: MapIndex, cov: CoverageContext, query: MapListQuery): MapPage<FieldIssue> {
  const all = [...index.model.issues, ...cov.issues].filter((i) => !query.type || i.kind === query.type);
  return paged(all, query);
}

/** Les voisins d'un nœud, pour étendre un graphe affiché à la demande. */
export function neighbours(
  index: MapIndex,
  nodeId: string,
  options: { depth?: number; limit?: number } = {},
): MapSubgraph | undefined {
  if (!index.nodes.has(nodeId)) return undefined;
  return subgraph(index, [nodeId], { depth: options.depth ?? 1, limit: options.limit ?? 40 });
}

// ── API & Services ────────────────────────────────────────────────────────────────────────────────

/** Les nœuds en amont d'une API (qui l'appelle, de proche en proche), avec la confiance la plus faible du chemin. */
function upstreamOf(
  index: MapIndex,
  starts: readonly string[],
  maxDepth = 10,
): Map<string, { confidence: MapConfidence; next?: string; edge?: MapEdge }> {
  const seen = new Map<string, { confidence: MapConfidence; next?: string; edge?: MapEdge }>();
  for (const id of starts) seen.set(id, { confidence: 'CONFIRMED' });
  let frontier = [...starts];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      const here = seen.get(id);
      if (!here) continue;
      for (const e of index.in.get(id) ?? []) {
        // Remonter : appels, et l'endpoint qui délègue à sa méthode (lien « sert »).
        const fromNode = index.nodes.get(e.from);
        const serving =
          e.kind === 'DEPENDS_ON' && fromNode?.kind === 'API' && index.nodes.get(id)?.kind === 'METHOD';
        if (e.kind !== 'CALLS' && !serving) continue;
        const confidence = RANK[e.confidence] < RANK[here.confidence] ? e.confidence : here.confidence;
        const known = seen.get(e.from);
        if (known && RANK[known.confidence] >= RANK[confidence]) continue;
        seen.set(e.from, { confidence, next: id, edge: e });
        nextFrontier.push(e.from);
      }
    }
    frontier = nextFrontier;
  }
  return seen;
}

const entriesOf = (api: ApiService): string[] => [
  ...new Set([
    ...api.endpoints.map((ep) => ep.node).filter((id): id is string => Boolean(id)),
    ...api.calls.map((c) => (api.scope === 'INTERNAL' ? '' : c.from)).filter(Boolean),
  ]),
];

/** Les fonctionnalités qui consomment l'API : un de leurs nœuds est en amont de l'API (chemin démontré). */
function apiFeatures(index: MapIndex, api: ApiService): ApiFeatureUse[] {
  index.apiUses ??= new Map();
  const cached = index.apiUses.get(api.id);
  if (cached) return cached;
  const up = upstreamOf(index, entriesOf(api));
  const uses: ApiFeatureUse[] = [];
  for (const feature of index.features) {
    if (feature.status === 'REJECTED') continue;
    let best: { id: string; confidence: MapConfidence } | undefined;
    for (const id of feature.nodes) {
      const hit = up.get(id);
      if (hit && (!best || RANK[hit.confidence] > RANK[best.confidence]))
        best = { id, confidence: hit.confidence };
    }
    if (!best) continue;
    // Le chemin jusqu'à l'API, et l'endpoint qu'il atteint.
    const via: string[] = [];
    let cursor: string | undefined = best.id;
    let reached = best.id;
    for (let guard = 0; cursor && guard < 20; guard += 1) {
      via.push(index.nodes.get(cursor)?.label ?? index.nodes.get(cursor)?.name ?? cursor);
      reached = cursor;
      cursor = up.get(cursor)?.next;
    }
    const endpoint =
      api.endpoints.find((ep) => ep.node === reached) ??
      api.endpoints.find((ep) => api.calls.some((c) => c.from === reached && c.endpoint === ep.id));
    uses.push({
      id: feature.id,
      name: feature.name,
      ...(feature.module ? { module: feature.module } : {}),
      usage: endpoint ? [`${endpoint.method ?? '?'} ${endpoint.path ?? '?'}`] : [],
      confidence: best.confidence,
      via,
    });
  }
  uses.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.name.localeCompare(b.name));
  index.apiUses.set(api.id, uses);
  return uses;
}

function apiRow(index: MapIndex, api: ApiService): ApiRow {
  const first = api.endpoints[0];
  return {
    id: api.id,
    name: api.name,
    technicalName: api.technicalName,
    scope: api.scope,
    ...(api.owner ? { owner: api.owner } : {}),
    ...(api.provider ? { provider: api.provider } : {}),
    status: api.status,
    confidence: api.confidence,
    endpoints: api.endpoints.length,
    ...(first ? { firstEndpoint: `${first.method ?? '?'} ${first.path ?? '(adresse dynamique)'}` } : {}),
    features: apiFeatures(index, api).length,
  };
}

export function apiScenarios(cov: CoverageContext, features: readonly ApiFeatureUse[]): ApiScenarioUse[] {
  const rows = new Map<string, ApiScenarioUse>();
  for (const use of features)
    for (const link of cov.links) {
      if (link.feature !== use.id || link.status === 'REJECTED' || rows.has(link.scenario)) continue;
      const row = cov.coverage.get(link.feature)?.scenarios.find((s) => s.scenario === link.scenario);
      rows.set(link.scenario, {
        scenario: link.scenario,
        feature: use.id,
        associated: true,
        executed: row?.traversed === true,
        verified: row?.traversed === true && row.asserted === true,
        ...(row?.lastRun ? { lastRun: row.lastRun } : {}),
      });
    }
  return [...rows.values()].sort((a, b) => a.scenario.localeCompare(b.scenario));
}

/** Le catalogue : recherche, périmètre, tri et pagination côté serveur, comptes et indicateurs réels. */
export function queryApis(index: MapIndex, cov: CoverageContext, query: MapListQuery): ApiCatalog {
  const all = index.model.apis ?? [];
  const q = query.q?.trim().toLowerCase() ?? '';
  const searched = q
    ? all.filter((api) =>
        [
          api.name,
          api.technicalName,
          api.provider ?? '',
          ...api.endpoints.map((ep) => `${ep.method ?? ''} ${ep.path ?? ''}`),
        ]
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : all;
  const counts = {
    all: searched.length,
    internal: searched.filter((a) => a.scope === 'INTERNAL').length,
    external: searched.filter((a) => a.scope === 'EXTERNAL').length,
    unclassified: searched.filter((a) => a.scope === 'UNCLASSIFIED').length,
  };
  const scoped = query.scope ? searched.filter((a) => a.scope === query.scope) : searched;
  const rows = scoped.map((api) => apiRow(index, api));
  const sort = query.sort ?? 'name';
  rows.sort((a, b) =>
    sort === 'endpoints'
      ? b.endpoints - a.endpoints || a.name.localeCompare(b.name)
      : sort === 'features'
        ? b.features - a.features || a.name.localeCompare(b.name)
        : a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
  );
  const featureIds = new Set(all.flatMap((api) => apiFeatures(index, api).map((f) => f.id)));
  const scenarioNames = new Set(
    cov.links.filter((l) => featureIds.has(l.feature) && l.status !== 'REJECTED').map((l) => l.scenario),
  );
  return {
    ...paged(rows, query),
    available: index.model.apis !== undefined,
    counts,
    kpis: {
      apis: all.length,
      internal: all.filter((a) => a.scope === 'INTERNAL').length,
      external: all.filter((a) => a.scope === 'EXTERNAL').length,
      endpoints: all.reduce((sum, a) => sum + a.endpoints.length, 0),
      features: featureIds.size,
      scenarios: scenarioNames.size,
    },
  };
}

/** La fiche d'une API : fonctionnalités, scénarios, parcours d'intégration démontré, impact, criticité. */
/** La source d'un nœud : le deuxième segment de son identifiant (« SORTE:source:… »). */
const sourceOf = (id: string): string => id.split(':')[1] ?? '';

function membersOf(index: MapIndex, source: string, container: string): string[] {
  if (!index.members) {
    const members = new Map<string, string[]>();
    for (const node of index.nodes.values()) {
      if (node.kind !== 'FIELD' && node.kind !== 'COLUMN') continue;
      const owner = typeof node.detail.container === 'string' ? node.detail.container : '';
      if (!owner) continue;
      const key = `${sourceOf(node.id)}|${owner}`;
      members.set(key, [...(members.get(key) ?? []), node.id]);
    }
    index.members = members;
  }
  return index.members.get(`${source}|${container}`) ?? [];
}

/** Les liens par lesquels un élément est rattaché à ce qui l'utilise (champs, DTO, tables, services). */
const ATTACH_EDGES: ReadonlySet<MapEdgeKind> = new Set([
  'INPUTS',
  'DISPLAYS',
  'SENDS',
  'TRANSFORMS',
  'READS',
  'WRITES',
  'DEPENDS_ON',
]);
const ATTACH_KINDS: ReadonlySet<string> = new Set([
  'FIELD',
  'DTO',
  'ENTITY',
  'COLUMN',
  'SERVICE',
  'COMPONENT',
  'API',
  'METHOD',
]);
const MEMBER_LIMIT = 24;

/**
 * Le graphe complet d'une API, borné : l'amont démontré (déjà calculé), l'aval de ses endpoints (méthode
 * servie, appels, persistance), puis ce qui est rattaché à ces éléments (champs saisis, DTO lus, tables
 * écrites, colonnes et propriétés de ces conteneurs). Aucun lien n'est créé : seuls des liens du scan.
 */
function apiGraph(
  index: MapIndex,
  api: ApiService,
  entries: readonly string[],
  up: ReadonlyMap<string, unknown>,
  limit = MAX_SUBGRAPH,
): MapSubgraph {
  const ordered: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const add = (id: string): boolean => {
    if (seen.has(id) || !index.nodes.has(id)) return false;
    if (seen.size >= limit) {
      truncated = true;
      return false;
    }
    seen.add(id);
    ordered.push(id);
    return true;
  };
  for (const id of entries) add(id);
  for (const id of up.keys()) add(id);
  for (const call of api.calls) add(call.from);
  // L'aval des endpoints servis : la méthode qui le sert, puis ses appels (profondeur bornée).
  let frontier = [...entries];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier)
      for (const edge of index.out.get(id) ?? []) {
        const from = index.nodes.get(id);
        const serving = edge.kind === 'DEPENDS_ON' && from?.kind === 'API';
        if ((edge.kind === 'CALLS' || serving) && add(edge.to)) next.push(edge.to);
      }
    frontier = next;
  }
  // Ce qui est rattaché : un saut, par les seuls liens de rattachement.
  for (const id of [...ordered]) {
    for (const edge of [...(index.out.get(id) ?? []), ...(index.in.get(id) ?? [])]) {
      if (!ATTACH_EDGES.has(edge.kind)) continue;
      const other = edge.from === id ? edge.to : edge.from;
      const kind = index.nodes.get(other)?.kind;
      if (!kind || !ATTACH_KINDS.has(kind)) continue;
      // Une méthode n'est rattachée que par son service (pas par un autre chemin de données).
      if (kind === 'METHOD' && !(edge.kind === 'DEPENDS_ON' && edge.to === other)) continue;
      if (kind === 'API' && edge.kind !== 'DEPENDS_ON') continue;
      add(other);
    }
  }
  // Les colonnes d'une table, les propriétés d'un DTO : les membres de ces conteneurs, bornés.
  for (const id of [...ordered]) {
    const node = index.nodes.get(id);
    if (node?.kind !== 'ENTITY' && node?.kind !== 'DTO') continue;
    const container =
      node.kind === 'ENTITY' && typeof node.detail.entity === 'string' ? node.detail.entity : node.name;
    for (const member of membersOf(index, sourceOf(id), container).slice(0, MEMBER_LIMIT)) add(member);
  }
  const edges: MapEdge[] = [];
  for (const id of ordered)
    for (const edge of index.out.get(id) ?? []) if (seen.has(edge.to)) edges.push(edge);
  return {
    nodes: ordered.map((id) => index.nodes.get(id)).filter((n): n is MapNode => n !== undefined),
    edges,
    depth: MAX_DEPTH,
    limit,
    truncated,
  };
}

/** Les appels sortants (externes ou à classifier) faits depuis un nœud du graphe : tels que le scan les établit. */
export function outboundOf(index: MapIndex, graph: MapSubgraph): ApiSheet['outbound'] {
  const inGraph = new Set(graph.nodes.map((n) => n.id));
  const out: ApiSheet['outbound'] = [];
  for (const api of index.model.apis ?? []) {
    if (api.scope === 'INTERNAL' && api.endpoints.some((ep) => ep.node)) continue;
    for (const call of api.calls) {
      if (!inGraph.has(call.from)) continue;
      const endpoint = api.endpoints.find((ep) => ep.id === call.endpoint);
      out.push({
        api: api.id,
        name: api.name,
        scope: api.scope,
        ...(api.provider ? { provider: api.provider } : {}),
        endpoint: call.endpoint ?? `${api.id}|?`,
        ...((endpoint?.method ?? call.method) ? { method: endpoint?.method ?? call.method } : {}),
        ...((endpoint?.path ?? call.path) ? { path: endpoint?.path ?? call.path } : {}),
        from: call.from,
        ...(call.client ? { client: call.client } : {}),
        confidence: call.confidence,
        how: call.how,
        evidence: call.evidence,
      });
    }
  }
  return out;
}

export function apiSheet(index: MapIndex, cov: CoverageContext, id: string): ApiSheet | undefined {
  const api = (index.model.apis ?? []).find((entry) => entry.id === id);
  if (!api) return undefined;
  const features = apiFeatures(index, api);
  const scenarios = apiScenarios(cov, features);
  // Le parcours : depuis l'entrée de l'API, on remonte par le meilleur chemin jusqu'au plus en amont.
  const entries = entriesOf(api);
  const up = upstreamOf(index, entries);
  let start: string | undefined;
  for (const [nodeId, hit] of up) {
    const node = index.nodes.get(nodeId);
    if (!node || entries.includes(nodeId)) continue;
    const better =
      !start ||
      layerRank(node.layer) < layerRank(index.nodes.get(start)?.layer) ||
      (layerRank(node.layer) === layerRank(index.nodes.get(start)?.layer) &&
        RANK[hit.confidence] > RANK[up.get(start)?.confidence ?? 'UNKNOWN']);
    if (better) start = nodeId;
  }
  const chain: MapNode[] = [];
  const chainEdges: MapEdge[] = [];
  let cursor = start ?? entries[0];
  for (let guard = 0; cursor && guard < 30; guard += 1) {
    const node = index.nodes.get(cursor);
    if (node) chain.push(node);
    const hit = up.get(cursor);
    if (hit?.edge) chainEdges.push(hit.edge);
    cursor = hit?.next;
  }
  const graph = apiGraph(index, api, entries, up);
  const demonstrated = features.filter((f) => f.confidence === 'CONFIRMED');
  const potential = features.filter((f) => f.confidence !== 'CONFIRMED');
  const scenariosOf = (uses: readonly ApiFeatureUse[]): string[] => [
    ...new Set(scenarios.filter((s) => uses.some((u) => u.id === s.feature)).map((s) => s.scenario)),
  ];
  const components = (confirmedOnly: boolean): string[] => [
    ...new Set(
      [...up.entries()]
        .filter(([, hit]) =>
          confirmedOnly ? hit.confidence === 'CONFIRMED' : hit.confidence !== 'CONFIRMED',
        )
        .map(([nodeId]) => index.nodes.get(nodeId))
        .filter(
          (n): n is MapNode =>
            n !== undefined && (n.kind === 'COMPONENT' || n.kind === 'METHOD' || n.kind === 'SERVICE'),
        )
        .map((n) => {
          const owner = typeof n.detail.container === 'string' ? n.detail.container : (n.parent ?? '');
          return owner && !n.name.includes(owner) ? `${owner}.${n.name}` : n.name;
        }),
    ),
  ];
  const dtos = [
    ...new Set(
      api.endpoints.flatMap((ep) => [ep.requestType, ep.responseType]).filter((t): t is string => Boolean(t)),
    ),
  ];
  const writes = api.endpoints.filter((ep) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(ep.method ?? ''),
  ).length;
  const level: 'LOW' | 'MEDIUM' | 'HIGH' =
    features.length >= 3 || (writes > 0 && features.length >= 2)
      ? 'HIGH'
      : features.length >= 1
        ? 'MEDIUM'
        : 'LOW';
  const reason = `${String(features.length)} fonctionnalité(s) consommatrice(s) · ${String(writes)} opération(s) d’écriture${api.scope === 'EXTERNAL' ? ' · dépendance externe' : ''}`;
  return {
    api,
    features,
    scenarios,
    path: { nodes: chain, edges: chainEdges },
    graph,
    outbound: outboundOf(index, graph),
    impact: {
      demonstrated: {
        features: demonstrated.map((f) => f.name),
        scenarios: scenariosOf(demonstrated),
        components: components(true),
        dtos,
      },
      potential: {
        features: potential.map((f) => f.name),
        scenarios: scenariosOf(potential),
        components: components(false),
        dtos: [],
      },
    },
    criticality: { level, reason },
    scanId: index.scanId,
    ...(index.model.scan.finishedAt ? { scannedAt: index.model.scan.finishedAt } : {}),
  };
}
