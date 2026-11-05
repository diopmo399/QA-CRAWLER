import type {
  CartographyModel,
  MapConfidence,
  ImpactReport,
  MapChange,
  MapEdge,
  MapNode,
  ScenarioLink,
  SourceComparison,
} from '../sdk/core/cartography.js';

/**
 * L'IMPACT D'UNE MODIFICATION : deux scans comparés nœud par nœud (ajouté, retiré, signature changée :
 * type, validations, chemin, colonne…) et lien par lien ; puis la propagation, par les seuls liens du
 * graphe, vers les fonctionnalités qui atteignent l'élément modifié et les scénarios qui les couvrent.
 * Un impact est CONFIRMÉ quand tout le chemin est démontré, PROBABLE sinon ; rien n'est déduit du nom.
 * Le corps d'une méthode n'est pas comparé (seule sa signature l'est) : c'est une limite affichée.
 */
const RANK: Record<MapConfidence, number> = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };
const weakest = (a: MapConfidence, b: MapConfidence): MapConfidence => (RANK[a] <= RANK[b] ? a : b);
const strongest = (a: MapConfidence, b: MapConfidence): MapConfidence => (RANK[a] >= RANK[b] ? a : b);

function describe(before: MapNode, after: MapNode): string[] {
  const keys = new Set([...Object.keys(before.detail), ...Object.keys(after.detail)]);
  const out: string[] = [];
  for (const key of [...keys].sort()) {
    if (key === 'line' || key === 'file') continue;
    const show = (value: unknown): string => (value === undefined ? '—' : JSON.stringify(value));
    const a = show(before.detail[key]);
    const b = show(after.detail[key]);
    if (a !== b) out.push(`${key} : ${a} → ${b}`);
  }
  if (before.name !== after.name) out.push(`nom : ${before.name} → ${after.name}`);
  return out;
}

const edgeLabel = (edge: MapEdge, nodes: ReadonlyMap<string, MapNode>): string =>
  `${edge.kind} ${nodes.get(edge.from)?.name ?? edge.from} → ${nodes.get(edge.to)?.name ?? edge.to}`;

export function diffModels(from: CartographyModel, to: CartographyModel): MapChange[] {
  const before = new Map(from.nodes.map((n) => [n.id, n]));
  const after = new Map(to.nodes.map((n) => [n.id, n]));
  const changes = new Map<string, MapChange>();
  for (const [id, node] of after) {
    const old = before.get(id);
    if (!old) changes.set(id, { node: id, kind: node.kind, name: node.name, change: 'ADDED', detail: [] });
    else if (old.signature !== node.signature || old.name !== node.name)
      changes.set(id, {
        node: id,
        kind: node.kind,
        name: node.name,
        change: 'CHANGED',
        detail: describe(old, node),
      });
  }
  for (const [id, node] of before)
    if (!after.has(id))
      changes.set(id, { node: id, kind: node.kind, name: node.name, change: 'REMOVED', detail: [] });
  // Un lien apparu ou disparu (un mapping réécrit, un appel déplacé) change son point de départ.
  const edgesBefore = new Map(from.edges.map((e) => [e.id, e]));
  const edgesAfter = new Map(to.edges.map((e) => [e.id, e]));
  const touch = (edge: MapEdge, what: string, nodes: ReadonlyMap<string, MapNode>): void => {
    const node = nodes.get(edge.from);
    if (!node) return;
    const change = changes.get(node.id) ?? {
      node: node.id,
      kind: node.kind,
      name: node.name,
      change: 'CHANGED' as const,
      detail: [],
    };
    change.detail.push(`${what} : ${edgeLabel(edge, nodes)}`);
    changes.set(node.id, change);
  };
  for (const [id, edge] of edgesAfter)
    if (!edgesBefore.has(id)) touch(edge, 'lien ajouté', after);
    else if (edgesBefore.get(id)?.confidence !== edge.confidence)
      touch(edge, `lien ${edgesBefore.get(id)?.confidence ?? ''} → ${edge.confidence}`, after);
  for (const [id, edge] of edgesBefore) if (!edgesAfter.has(id)) touch(edge, 'lien retiré', before);
  // Les conteneurs (DTO, entités, composants) changent avec leurs champs : seul le champ est gardé.
  return [...changes.values()].filter(
    (change) => !(change.change === 'CHANGED' && change.detail.length === 0),
  );
}

/**
 * La propagation : une fonctionnalité est touchée si elle atteint un nœud modifié (dans l'un ou l'autre
 * scan), avec la confiance du chemin ; ou si un champ modifié appartient à un concept qu'elle utilise (la
 * donnée circule jusqu'à elle), avec la confiance du concept.
 */
/** La source d'un nœud : celle de sa première preuve de code. */
const sourceOf = (node: MapNode | undefined): string | undefined =>
  node?.evidence.find((e) => e.sourceId)?.sourceId;

/**
 * Les sources des deux scans comparées : un autre commit dont les fichiers lus sont identiques (même
 * empreinte) n'est pas une différence ; une source non lue dans l'un des scans rend la comparaison
 * indéterminée pour elle, sans rien conclure.
 */
export function compareSources(
  from: CartographyModel,
  to: CartographyModel,
  changes: readonly MapChange[],
): SourceComparison[] {
  const before = new Map(from.scan.sources.map((s) => [s.sourceId, s]));
  const after = new Map(to.scan.sources.map((s) => [s.sourceId, s]));
  const nodes = new Map([...from.nodes, ...to.nodes].map((n) => [n.id, n]));
  const counts = new Map<string, SourceComparison['changes']>();
  for (const change of changes) {
    const id = sourceOf(nodes.get(change.node));
    if (!id) continue;
    const count = counts.get(id) ?? { added: 0, removed: 0, changed: 0 };
    if (change.change === 'ADDED') count.added++;
    else if (change.change === 'REMOVED') count.removed++;
    else count.changed++;
    counts.set(id, count);
  }
  const read = (state: string | undefined): boolean =>
    state === 'SCANNED' || state === 'PARTIAL' || state === 'REUSED';
  const out: SourceComparison[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id);
    const b = after.get(id);
    const meta = b ?? a;
    if (!meta) continue;
    const side = (s: typeof a) =>
      s ? { ...(s.revision ? { revision: s.revision } : {}), files: s.files, state: s.state } : undefined;
    const changeCount = counts.get(id) ?? { added: 0, removed: 0, changed: 0 };
    let status: SourceComparison['status'];
    let reason: string;
    if (!a || a.state === 'DISABLED') {
      status = 'ADDED';
      reason = 'source absente du premier scan';
    } else if (!b || b.state === 'DISABLED') {
      status = 'REMOVED';
      reason = 'source absente du second scan';
    } else if (!read(a.state) || !read(b.state)) {
      status = 'UNDETERMINED';
      reason = `source non lue dans l’un des scans (${a.state} → ${b.state})`;
    } else if (a.hash && b.hash && a.hash === b.hash) {
      status = 'UNCHANGED';
      reason =
        a.revision && b.revision && a.revision !== b.revision
          ? 'autre commit, mêmes fichiers lus'
          : 'mêmes fichiers lus';
    } else if (!a.hash || !b.hash) {
      status = 'UNDETERMINED';
      reason = 'empreinte des fichiers absente';
    } else {
      const total = changeCount.added + changeCount.removed + changeCount.changed;
      status = total > 0 ? 'MODIFIED' : 'UNCHANGED';
      reason =
        total > 0
          ? 'éléments du graphe ajoutés, retirés ou modifiés'
          : 'fichiers modifiés sans effet sur les éléments relevés (corps de méthode, commentaires…)';
    }
    const fromSide = side(a);
    const toSide = side(b);
    out.push({
      sourceId: id,
      name: meta.name,
      layer: meta.layer,
      status,
      ...(fromSide ? { from: fromSide } : {}),
      ...(toSide ? { to: toSide } : {}),
      changes: changeCount,
      reason,
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

export function computeImpact(
  from: CartographyModel,
  to: CartographyModel,
  links: readonly ScenarioLink[],
): ImpactReport {
  const changes = diffModels(from, to);
  const changed = new Set(changes.map((change) => change.node));
  const features = new Map<
    string,
    { feature: string; name: string; confidence: MapConfidence; via: string[] }
  >();
  const hit = (feature: { id: string; name: string }, confidence: MapConfidence, via: string): void => {
    if (confidence === 'UNKNOWN') return;
    const entry = features.get(feature.id) ?? {
      feature: feature.id,
      name: feature.name,
      confidence,
      via: [],
    };
    entry.confidence = strongest(entry.confidence, confidence);
    if (!entry.via.includes(via)) entry.via.push(via);
    features.set(feature.id, entry);
  };
  const nameOf = (id: string): string => changes.find((c) => c.node === id)?.name ?? id;
  for (const model of [to, from])
    for (const feature of model.features) {
      if (feature.status === 'REJECTED') continue;
      for (const id of changed) {
        const reach = feature.reach[id];
        if (reach)
          hit(
            feature,
            reach,
            `atteint ${nameOf(id)} (${reach === 'CONFIRMED' ? 'chemin démontré' : 'chemin probable'})`,
          );
      }
    }
  for (const model of [to, from])
    for (const concept of model.concepts) {
      const touched = concept.fields.filter((id) => changed.has(id));
      if (touched.length === 0 || concept.fields.length < 2) continue;
      const confidence: MapConfidence = concept.status === 'VALIDATED' ? 'CONFIRMED' : concept.status;
      for (const featureId of concept.features) {
        const feature = model.features.find((entry) => entry.id === featureId);
        if (feature && feature.status !== 'REJECTED')
          hit(
            feature,
            confidence,
            `la donnée « ${concept.name} » circule jusqu’à elle (${touched.map(nameOf).join(', ')} modifié)`,
          );
      }
    }
  const scenarios = new Map<
    string,
    { scenario: string; confidence: MapConfidence; features: string[]; reason: string }
  >();
  for (const link of links) {
    if (link.status === 'REJECTED') continue;
    const feature = features.get(link.feature);
    if (!feature) continue;
    // Une association proposée et non démontrée ne rend l'impact que probable.
    const linkConfidence: MapConfidence = link.status === 'VALIDATED' ? 'CONFIRMED' : link.confidence;
    const confidence = weakest(feature.confidence, linkConfidence);
    if (confidence === 'UNKNOWN') continue;
    const entry = scenarios.get(link.scenario) ?? {
      scenario: link.scenario,
      confidence,
      features: [],
      reason: '',
    };
    entry.confidence = strongest(entry.confidence, confidence);
    if (!entry.features.includes(feature.feature)) entry.features.push(feature.feature);
    entry.reason = `couvre ${entry.features.map((id) => `« ${features.get(id)?.name ?? id} »`).join(', ')}, touchée(s) par la modification`;
    scenarios.set(link.scenario, entry);
  }
  const definite = (c: MapConfidence): 'CONFIRMED' | 'PROBABLE' =>
    c === 'CONFIRMED' ? 'CONFIRMED' : 'PROBABLE';
  return {
    from: from.scan.id,
    to: to.scan.id,
    sources: compareSources(from, to, changes),
    changes,
    features: [...features.values()]
      .map((entry) => ({ ...entry, confidence: definite(entry.confidence) }))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.name.localeCompare(b.name)),
    scenarios: [...scenarios.values()]
      .map((entry) => ({ ...entry, confidence: definite(entry.confidence) }))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.scenario.localeCompare(b.scenario)),
  };
}
