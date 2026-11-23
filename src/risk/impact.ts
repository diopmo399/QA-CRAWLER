import type { CartographyModel, MapConfidence, MapEdge, MapNode } from '../sdk/core/cartography.js';
import type { RiskFeature, RiskImpact, RiskImpactEdge, RiskImpactNode } from '../sdk/core/risk.js';

/**
 * LE PARCOURS D'IMPACT D'UN RISQUE, sur le graphe déjà construit par la cartographie (rien n'est recalculé ni
 * dupliqué). Il ne suit que les liens qui PROPAGENT une donnée : un lecteur (READS, DEPENDS_ON vers la donnée,
 * CONTROLLED_BY), une émission vers ses rappels (CALLS sortant d'un flux), puis les appels faits par un
 * consommateur (CALLS, SENDS) vers l'aval (HTTP, BFF, backend). La structure (CONTAINS…) et l'amont (qui
 * écrit la donnée) ne propagent pas. Exploration bornée en profondeur et en nombre de nœuds, cycles évités.
 */
export interface GraphIndex {
  model: CartographyModel;
  nodes: Map<string, MapNode>;
  out: Map<string, MapEdge[]>;
  in: Map<string, MapEdge[]>;
  /** Les fonctionnalités qui atteignent chaque nœud (et avec quelle confiance). */
  reach: Map<string, { id: string; name: string; confidence: MapConfidence }[]>;
  /** Mémoïsation des parcours (même départ, même borne). */
  memo: Map<string, ImpactResult>;
}

export interface ImpactResult {
  impact: RiskImpact;
  features: RiskFeature[];
  /** Le chemin lisible vers le consommateur le plus proche, puis l'aval. */
  propagation: string[];
  /** Les consommateurs rencontrés (composants), et s'ils sont atteints par un lien démontré. */
  consumers: { component: string; proven: boolean; via: string }[];
  /** Au moins un lien démontré mène de la source à un consommateur. */
  provenPath: boolean;
  /** Les liens vers les consommateurs ne sont tous que non démontrés. */
  onlyUncertain: boolean;
}

export function indexGraph(model: CartographyModel): GraphIndex {
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const out = new Map<string, MapEdge[]>();
  const inn = new Map<string, MapEdge[]>();
  for (const e of model.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    inn.set(e.to, [...(inn.get(e.to) ?? []), e]);
  }
  const reach = new Map<string, { id: string; name: string; confidence: MapConfidence }[]>();
  for (const f of model.features) {
    if (f.status === 'REJECTED') continue;
    for (const [id, confidence] of Object.entries(f.reach)) {
      if (confidence === 'UNKNOWN') continue;
      reach.set(id, [...(reach.get(id) ?? []), { id: f.id, name: f.name, confidence }]);
    }
    for (const id of f.nodes)
      if (!reach.get(id)?.some((x) => x.id === f.id))
        reach.set(id, [...(reach.get(id) ?? []), { id: f.id, name: f.name, confidence: 'CONFIRMED' }]);
  }
  return { model, nodes, out, in: inn, reach, memo: new Map() };
}

const linkOf = (c: MapConfidence): RiskImpactEdge['link'] =>
  c === 'CONFIRMED' ? 'PROVEN' : c === 'PROBABLE' ? 'INFERRED' : 'UNCERTAIN';
const rank: Record<MapConfidence, number> = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };
const weakest = (a: MapConfidence, b: MapConfidence): MapConfidence => (rank[a] <= rank[b] ? a : b);

/** Le composant qui porte un nœud (méthode, condition, conteneur), en remontant ses parents. */
export function componentOf(index: GraphIndex, id: string): string | undefined {
  let cur = index.nodes.get(id);
  for (let i = 0; cur && i < 6; i += 1) {
    if (cur.kind === 'COMPONENT') return cur.id;
    if (cur.parent) {
      cur = index.nodes.get(cur.parent);
      continue;
    }
    // Une méthode ou un flux de composant : `METHOD:src:Comp#m`, `STREAM:src:Comp.x`.
    const [, src, sym] = cur.id.split(':');
    const owner = typeof cur.detail.owner === 'string' ? cur.detail.owner : sym?.split(/[#.]/)[0];
    const candidate = `COMPONENT:${src ?? ''}:${owner ?? ''}`;
    return cur.detail.role === 'COMPONENT' && index.nodes.has(candidate) ? candidate : undefined;
  }
  return undefined;
}

const nameOf = (index: GraphIndex, id: string): string => {
  const n = index.nodes.get(id);
  return n ? (n.label ?? n.name) : id.split(':').slice(2).join(':') || id;
};

/**
 * L'impact de `starts` (la donnée et ses formes exposées). `exclude` : composants à ne pas compter comme
 * consommateurs (ceux qui écrivent la donnée eux-mêmes).
 */
export function impactOf(
  index: GraphIndex,
  starts: readonly string[],
  options: { maxDepth?: number; maxNodes?: number; exclude?: ReadonlySet<string>; downstream?: boolean } = {},
): ImpactResult {
  const maxDepth = options.maxDepth ?? 5;
  const maxNodes = options.maxNodes ?? 40;
  const key = `${starts.join('|')}#${String(maxDepth)}#${String(maxNodes)}#${[...(options.exclude ?? [])].join(',')}#${String(options.downstream ?? true)}`;
  const memo = index.memo.get(key);
  if (memo) return memo;
  const present = starts.filter((s) => index.nodes.has(s));
  const nodes = new Map<string, RiskImpactNode>();
  const edges: RiskImpactEdge[] = [];
  const blocked: string[] = [];
  const consumers = new Map<string, { component: string; proven: boolean; via: string }>();
  const pathTo = new Map<string, { conf: MapConfidence; prev?: string }>();
  /** Atteint par l'installation d'une souscription (READS) : la méthode n'exécute pas la suite avec la donnée. */
  const installedOnly = new Set<string>();
  let truncated = false;
  let explored = 0;
  const add = (id: string, role: RiskImpactNode['role'], depth: number): void => {
    if (nodes.has(id)) return;
    const n = index.nodes.get(id);
    nodes.set(id, { id, name: nameOf(index, id), role, ...(n?.layer ? { layer: n.layer } : {}), depth });
  };
  for (const s of present) {
    add(s, nodes.size === 0 ? 'SOURCE' : 'DATA', 0);
    pathTo.set(s, { conf: 'CONFIRMED' });
    // Les formes exposées (asObservable, signal en lecture seule…) sont la même donnée : fait lu dans le code.
    if (present[0] && s !== present[0])
      edges.push({ from: present[0], to: s, link: 'PROVEN', reason: 'forme exposée de la même donnée' });
  }
  let frontier = [...present];
  const seen = new Set(present);
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      explored += 1;
      const node = index.nodes.get(id);
      const isData = node?.kind === 'STREAM' || present.includes(id);
      const candidates: { to: string; edge: MapEdge; reason: string }[] = [];
      // Une méthode qui a seulement installé la souscription : ses autres appels ne portent pas la donnée.
      const carries = !installedOnly.has(id);
      // Les lecteurs d'une donnée (flux, champ).
      if (isData)
        for (const e of index.in.get(id) ?? [])
          if (e.kind === 'READS' || e.kind === 'DEPENDS_ON' || e.kind === 'CONTROLLED_BY')
            candidates.push({ to: e.from, edge: e, reason: e.reason });
      // Une émission propage vers les rappels et flux dérivés ; un consommateur appelle l'aval.
      for (const e of index.out.get(id) ?? []) {
        if (e.kind !== 'CALLS' && e.kind !== 'SENDS') continue;
        if (!isData && (options.downstream === false || !carries)) continue;
        if (e.detail?.timing === 'ON_ERROR') {
          blocked.push(`${nameOf(index, id)} → ${nameOf(index, e.to)} : seulement en cas d’erreur`);
          continue;
        }
        candidates.push({ to: e.to, edge: e, reason: e.reason });
      }
      // Une condition d'affichage : l'élément qu'elle gouverne.
      if (node?.kind === 'CONDITION')
        for (const e of index.in.get(id) ?? [])
          if (e.kind === 'VISIBLE_WHEN' || e.kind === 'ENABLED_WHEN')
            candidates.push({ to: e.from, edge: e, reason: e.reason });
      for (const c of candidates) {
        if (seen.has(c.to)) continue;
        if (nodes.size >= maxNodes) {
          truncated = true;
          continue;
        }
        seen.add(c.to);
        const target = index.nodes.get(c.to);
        const component = componentOf(index, c.to);
        const role: RiskImpactNode['role'] =
          target?.kind === 'STREAM'
            ? 'STATE'
            : component || target?.kind === 'CONDITION' || target?.kind === 'COMPONENT'
              ? 'CONSUMER'
              : 'DOWNSTREAM';
        add(c.to, role, depth);
        if (c.edge.kind === 'READS' && c.edge.to === id) installedOnly.add(c.to);
        const conf = weakest(pathTo.get(id)?.conf ?? 'CONFIRMED', c.edge.confidence);
        pathTo.set(c.to, { conf, prev: id });
        edges.push({
          from: id,
          to: c.to,
          link: linkOf(c.edge.confidence),
          reason: c.reason,
          ...(c.edge.detail?.condition ? { condition: c.edge.detail.condition } : {}),
        });
        if (component && !options.exclude?.has(component)) {
          const prev = consumers.get(component);
          if (!prev || (!prev.proven && conf === 'CONFIRMED'))
            consumers.set(component, { component, proven: conf === 'CONFIRMED', via: c.to });
          if (!nodes.has(component)) {
            add(component, 'CONSUMER', depth);
            edges.push({ from: c.to, to: component, link: 'PROVEN', reason: 'appartient au composant' });
          }
        }
        next.push(c.to);
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) truncated = true;
  // Les fonctionnalités : atteintes par un consommateur ou par l'aval (jamais par la source seule, que
  // les écrivains atteignent aussi).
  const features = new Map<string, RiskFeature>();
  // Seuls les composants consommateurs rattachent une fonctionnalité : une méthode ou une API en aval est
  // aussi atteinte par les fonctionnalités qui écrivent la donnée, sans en être affectées.
  for (const [id, info] of nodes) {
    if (index.nodes.get(id)?.kind !== 'COMPONENT' || options.exclude?.has(id)) continue;
    for (const f of index.reach.get(id) ?? []) {
      const conf = weakest(pathTo.get(id)?.conf ?? f.confidence, f.confidence);
      const prev = features.get(f.id);
      const direct = info.role === 'CONSUMER' && info.depth <= 3;
      if (!prev || rank[conf] > rank[prev.confidence] || (direct && !prev.direct))
        features.set(f.id, {
          id: f.id,
          name: f.name,
          confidence: conf,
          direct: direct || (prev?.direct ?? false),
        });
    }
  }
  for (const f of features.values()) {
    const fid = `FEATURE:${f.id}`;
    nodes.set(fid, { id: fid, name: f.name, role: 'FEATURE', depth: maxDepth + 1 });
    const from = [...nodes.values()].find(
      (n) => index.nodes.get(n.id)?.kind === 'COMPONENT' && index.reach.get(n.id)?.some((x) => x.id === f.id),
    );
    if (from)
      edges.push({
        from: from.id,
        to: fid,
        link: linkOf(f.confidence),
        reason: 'la fonctionnalité atteint ce consommateur',
      });
  }
  // Le chemin lisible : de la source au consommateur le plus proche, puis son aval le plus profond.
  const firstConsumer = [...consumers.values()].sort((a, b) => Number(b.proven) - Number(a.proven))[0];
  const chain = (to: string): string[] => {
    const out: string[] = [];
    for (let cur: string | undefined = to, guard = 0; cur && guard < 12; guard += 1) {
      out.unshift(nameOf(index, cur));
      cur = pathTo.get(cur)?.prev;
    }
    return out;
  };
  const deepest = [...nodes.values()]
    .filter((n) => n.role === 'DOWNSTREAM')
    .sort((a, b) => b.depth - a.depth)[0];
  const propagation = deepest
    ? chain(deepest.id)
    : firstConsumer
      ? chain(firstConsumer.via)
      : present.map((s) => nameOf(index, s));
  const result: ImpactResult = {
    impact: {
      nodes: [...nodes.values()],
      edges,
      blocked: [...new Set(blocked)].slice(0, 10),
      truncated,
      explored,
    },
    features: [...features.values()].sort(
      (a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name),
    ),
    propagation,
    consumers: [...consumers.values()],
    provenPath: [...consumers.values()].some((c) => c.proven),
    onlyUncertain:
      consumers.size > 0 &&
      [...consumers.values()].every((c) => (pathTo.get(c.via)?.conf ?? 'UNKNOWN') === 'UNKNOWN'),
  };
  index.memo.set(key, result);
  return result;
}

/** Les composants qui appellent (directement ou en quelques sauts) une méthode : les écrivains d'une donnée. */
export function callersOf(index: GraphIndex, method: string, maxDepth = 3): Set<string> {
  const out = new Set<string>();
  let frontier = [method];
  const seen = new Set(frontier);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const own = componentOf(index, id);
      if (own) out.add(own);
      for (const e of index.in.get(id) ?? []) {
        if (e.kind !== 'CALLS' || seen.has(e.from) || index.nodes.get(e.from)?.kind === 'STREAM') continue;
        seen.add(e.from);
        next.push(e.from);
      }
    }
    frontier = next;
  }
  for (const id of frontier) {
    const own = componentOf(index, id);
    if (own) out.add(own);
  }
  return out;
}
