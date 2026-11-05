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
  // Chaque changement porte sa source, sa couche, sa preuve et les fonctionnalités qui l'atteignent.
  const nodes = new Map([...from.nodes, ...to.nodes].map((n) => [n.id, n]));
  const reached = (id: string): { id: string; name: string }[] => {
    const out = new Map<string, string>();
    for (const model of [to, from])
      for (const feature of model.features)
        if (feature.status !== 'REJECTED' && feature.reach[id] && feature.reach[id] !== 'UNKNOWN')
          out.set(feature.id, feature.name);
    return [...out].map(([id, name]) => ({ id, name }));
  };
  const enriched = changes.map((change) => {
    const node = nodes.get(change.node);
    const evidence = node?.evidence.find((e) => e.file);
    const source = sourceOf(node);
    const hit = reached(change.node);
    return {
      ...change,
      ...(source ? { source } : {}),
      ...(node ? { layer: node.layer } : {}),
      ...(hit.length ? { features: hit } : {}),
      ...(evidence ? { evidence } : {}),
    };
  });
  const tabs = impactedTabs([to, from], changed, definite);
  const actions = impactedActions([to, from], changed, definite);
  return {
    from: from.scan.id,
    to: to.scan.id,
    sources: compareSources(from, to, changes),
    ...(tabs.length ? { tabs } : {}),
    ...(actions.length ? { actions } : {}),
    changes: enriched,
    features: [...features.values()]
      .map((entry) => ({ ...entry, confidence: definite(entry.confidence) }))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.name.localeCompare(b.name)),
    scenarios: [...scenarios.values()]
      .map((entry) => ({ ...entry, confidence: definite(entry.confidence) }))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.scenario.localeCompare(b.scenario)),
  };
}

const ACTION_FLOW = new Set(['TRIGGERS', 'CALLS', 'READS', 'WRITES']);
const MAX_ACTION_VISITS = 5000;

/**
 * Les actions touchées : depuis chaque bouton (et chaque méthode appelée par un gabarit ou le cycle de vie),
 * le chemin de déclenchement le plus court jusqu'à un élément modifié. Un flux atteint par déclenchement ne
 * mène pas à ses sources de données ; une dépendance partagée sans chemin depuis l'action n'est pas citée.
 */
function impactedActions(
  models: readonly CartographyModel[],
  changed: ReadonlySet<string>,
  definite: (c: MapConfidence) => 'CONFIRMED' | 'PROBABLE',
): NonNullable<ImpactReport['actions']> {
  const found = new Map<string, NonNullable<ImpactReport['actions']>[number]>();
  for (const model of models) {
    const nodes = new Map(model.nodes.map((n) => [n.id, n]));
    const outOf = new Map<string, MapEdge[]>();
    for (const e of model.edges)
      if (ACTION_FLOW.has(e.kind)) outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
    const name = (id: string): string => {
      const n = nodes.get(id);
      return n?.label ?? n?.name ?? id;
    };
    const starts = model.nodes.filter(
      (n) =>
        n.kind === 'BUTTON' ||
        (n.kind === 'METHOD' &&
          n.layer === 'FRONTEND' &&
          (n.detail.entry === 'TEMPLATE' || n.detail.entry === 'LIFECYCLE') &&
          // Une méthode déjà déclenchée par un bouton est représentée par ce bouton.
          !model.edges.some((e) => e.kind === 'TRIGGERS' && e.to === n.id)),
    );
    for (const start of starts) {
      const back = new Map<string, MapEdge>();
      const queue = [start.id];
      const seen = new Set(queue);
      let visits = 0;
      while (queue.length > 0 && (visits += 1) < MAX_ACTION_VISITS) {
        const cur = queue.shift() ?? '';
        for (const e of outOf.get(cur) ?? []) {
          if (seen.has(e.to) || e.confidence === 'UNKNOWN') continue;
          if (nodes.get(cur)?.kind === 'STREAM' && e.kind !== 'CALLS') continue;
          seen.add(e.to);
          back.set(e.to, e);
          queue.push(e.to);
        }
      }
      for (const id of changed) {
        if (!back.has(id) || found.has(`${start.id}|${id}`)) continue;
        const path: string[] = [];
        const conditions: string[] = [];
        let confidence: MapConfidence = 'CONFIRMED';
        for (let cur: string | undefined = id, guard = 0; cur && cur !== start.id && guard < 60; guard += 1) {
          const e = back.get(cur);
          if (!e) break;
          path.unshift(name(cur));
          if (e.detail?.condition) conditions.unshift(e.detail.condition);
          confidence = weakest(confidence, e.confidence);
          cur = e.from;
        }
        path.unshift(name(start.id));
        const owner =
          typeof start.detail.component === 'string'
            ? start.detail.component
            : typeof start.detail.owner === 'string'
              ? start.detail.owner
              : undefined;
        found.set(`${start.id}|${id}`, {
          action: start.id,
          name: name(start.id),
          ...(owner ? { component: owner } : {}),
          element: id,
          elementName: name(id),
          confidence: definite(confidence),
          path,
          conditions,
        });
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => RANK[b.confidence] - RANK[a.confidence] || a.name.localeCompare(b.name),
  );
}

/**
 * Les onglets touchés : pour chaque élément modifié, l'onglet le plus imbriqué qui le contient (sûr), qui le
 * déclenche par ses boutons et composants (selon le chemin), ou dont les conditions en lisent la valeur
 * (potentiel). Rien n'est supposé : sans chemin dans le graphe, l'onglet n'est pas cité.
 */
function impactedTabs(
  models: readonly CartographyModel[],
  changed: ReadonlySet<string>,
  definite: (c: MapConfidence) => 'CONFIRMED' | 'PROBABLE',
): NonNullable<ImpactReport['tabs']> {
  type Hit = NonNullable<ImpactReport['tabs']>[number] & { inside: ReadonlySet<string> };
  const hits = new Map<string, Hit[]>();
  for (const model of models) {
    const nodes = new Map(model.nodes.map((n) => [n.id, n]));
    const outOf = new Map<string, MapEdge[]>();
    const inOf = new Map<string, MapEdge[]>();
    for (const e of model.edges) {
      outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
      inOf.set(e.to, [...(inOf.get(e.to) ?? []), e]);
    }
    const pageOf = (id: string): string | undefined => {
      let cursor: string | undefined = id;
      for (let guard = 0; cursor && guard < 40; guard += 1) {
        const route = (inOf.get(cursor) ?? []).find(
          (e) => e.kind === 'DISPLAYS' && nodes.get(e.from)?.kind === 'ROUTE',
        );
        if (route) return nodes.get(route.from)?.name;
        cursor = (inOf.get(cursor) ?? []).find((e) => e.kind === 'CONTAINS' || e.kind === 'DISPLAYS')?.from;
      }
      return undefined;
    };
    for (const tab of model.nodes) {
      if (tab.kind !== 'CONTAINER' || tab.detail.tab !== 'TAB') continue;
      // Contenu (CONTAINS), déclenchement (bouton, cycle de vie → appels), lecture (conditions → flux).
      const reach = new Map<string, { confidence: MapConfidence; how: 'CONTAINS' | 'TRIGGERS' | 'READS' }>();
      const visit = (
        start: string[],
        how: 'CONTAINS' | 'TRIGGERS' | 'READS',
        kinds: ReadonlySet<string>,
        base: MapConfidence,
      ): void => {
        const queue = start.map((id) => [id, base] as const);
        while (queue.length > 0 && reach.size < 5000) {
          const [cur, confidence] = queue.shift() ?? ['', 'UNKNOWN'];
          for (const e of outOf.get(cur) ?? []) {
            if (!kinds.has(e.kind) || reach.has(e.to)) continue;
            // Un flux atteint par déclenchement ne mène pas à ses sources de données.
            if (how === 'TRIGGERS' && nodes.get(cur)?.kind === 'STREAM' && e.kind !== 'CALLS') continue;
            const next = weakest(confidence, e.confidence);
            if (next === 'UNKNOWN') continue;
            reach.set(e.to, { confidence: how === 'READS' ? 'PROBABLE' : next, how });
            queue.push([e.to, next]);
          }
        }
      };
      visit([tab.id], 'CONTAINS', new Set(['CONTAINS']), 'CONFIRMED');
      const content = [tab.id, ...reach.keys()];
      const starts = content.flatMap((id) =>
        (outOf.get(id) ?? [])
          .filter((e) => e.kind === 'TRIGGERS' || (e.kind === 'CALLS' && nodes.get(id)?.kind === 'COMPONENT'))
          .map((e) => e.from),
      );
      visit(
        [...new Set(starts)],
        'TRIGGERS',
        new Set(['TRIGGERS', 'CALLS', 'DEPENDS_ON', 'READS', 'WRITES']),
        'CONFIRMED',
      );
      visit(
        content,
        'READS',
        new Set(['VISIBLE_WHEN', 'ENABLED_WHEN', 'CONTROLLED_BY', 'DEPENDS_ON']),
        'PROBABLE',
      );
      const inside = new Set(content);
      const owner = typeof tab.detail.component === 'string' ? tab.detail.component : '';
      const feature = model.features.find(
        (f) =>
          f.status !== 'REJECTED' &&
          f.nodes.some((n) => n.endsWith(`:${owner}`) && n.startsWith('COMPONENT:')),
      );
      for (const id of changed) {
        const hit = reach.get(id);
        if (!hit || hit.confidence === 'UNKNOWN') continue;
        const list = hits.get(id) ?? [];
        if (list.some((h) => h.tab === tab.id)) continue;
        const page = pageOf(tab.id);
        const element = nodes.get(id);
        list.push({
          ...(page ? { page } : {}),
          tab: tab.id,
          tabName:
            typeof tab.detail.tabLabel === 'string'
              ? tab.detail.tabLabel
              : typeof tab.detail.repeat === 'string'
                ? tab.detail.repeat
                : tab.name,
          ...(feature ? { feature: feature.name } : {}),
          element: id,
          elementName: element?.label ?? element?.name ?? id,
          confidence: definite(hit.confidence),
          how: hit.how,
          inside,
        });
        hits.set(id, list);
      }
    }
  }
  // Un onglet parent n'est pas cité quand un onglet qu'il contient l'est déjà pour le même élément.
  return [...hits.values()]
    .flatMap((list) => list.filter((h) => !list.some((other) => other !== h && h.inside.has(other.tab))))
    .map(({ inside: _inside, ...entry }) => entry)
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.tabName.localeCompare(b.tabName));
}
