import type {
  ActionRow,
  ConditionRow,
  ElementCondition,
  ElementSheet,
  Evidence,
  MapConfidence,
  MapEdge,
  MapNode,
  MapPage,
  MapStructure,
  MapSubgraph,
  MapTrace,
  StructureItem,
  TabSheet,
} from '../core/cartography.js';
import { MAP_EDGE_KINDS, MAP_LAYERS, TRACE_DIRECTIONS } from '../core/cartography.js';
import { investigationModal } from './dashboard-cartography-investigation.js';
import type { ApiViewHelpers } from './dashboard-cartography-apis.js';
import { breakable, shortPath } from './dashboard-cartography-graph.js';
import type { MapStrings } from './dashboard-cartography-i18n.js';
import {
  laneLegend,
  laneModel,
  lanesView,
  laneSelection,
  shownExpression,
  type LaneInput,
} from './dashboard-cartography-lanes.js';
import type { CartographyUi } from './dashboard-cartography.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * L'ÉCRAN « STRUCTURE & CONDITIONS » : à gauche l'arbre d'une fonctionnalité (écran, composant,
 * conteneurs, champs, boutons, badges de condition), au centre le graphe en couloirs de l'élément choisi
 * (sa condition, la chaîne jusqu'à la décision Backend, ses actions et leur aval) avec ses tableaux, ou la
 * liste des conditions et celle des actions du projet ; à droite la fiche de l'élément. Tout vient du scan :
 * une décision non atteinte est dite « non déterminée », avec sa cause.
 */

export const STRUCT_TABS = ['graph', 'conditions', 'actions'] as const;
export type StructTab = (typeof STRUCT_TABS)[number];
export const SHEET_TABS = ['details', 'conditions', 'apis', 'code', 'scenarios'] as const;
export type SheetTab = (typeof SHEET_TABS)[number];
export const BOTTOM_TABS = ['elements', 'conditions', 'apis', 'data', 'evidence'] as const;
export type BottomTab = (typeof BOTTOM_TABS)[number];

const KIND_ICON: Record<string, string> = {
  ROUTE: 'file',
  COMPONENT: 'cube',
  CONTAINER: 'grid',
  FIELD: 'text',
  BUTTON: 'pointer',
  CONDITION: 'diamond',
  TAB: 'layers',
  TAB_GROUP: 'layers',
};
/** La sorte affichée : un conteneur qui est un onglet ou un groupe d'onglets est dit comme tel. */
const kindKey = (kind: string, tab: unknown): string =>
  tab === 'TAB' ? 'TAB' : tab === 'GROUP' ? 'TAB_GROUP' : kind;

/** Les indicateurs de l'écran : comptes du scan (pages, conteneurs, champs, boutons, API, conditions). */
export function structureKpis(m: MapStrings, structure: MapStructure | undefined): string {
  const k = structure?.kpis;
  const tile = (name: string, value: number | undefined, label: string, tone: string): string =>
    `<article class="map-kpi st-kpi ${tone}">${icon(name)}<span><b>${value === undefined ? '—' : String(value)}</b><small>${esc(label)}</small></span></article>`;
  return `<section class="map-kpis st-kpis" aria-label="${esc(m.st.title)}">${tile('file', k?.pages, m.st.kpi.pages ?? '', 'g')}${tile('grid', k?.containers, m.st.kpi.containers ?? '', 'v')}${tile('text', k?.fields, m.st.kpi.fields ?? '', 'g')}${tile('pointer', k?.buttons, m.st.kpi.buttons ?? '', 'r')}${tile('code', k?.internalApis, m.st.kpi.internal ?? '', 'b')}${tile('cloud', k?.externalApis, m.st.kpi.external ?? '', 'v')}${tile('merge', k?.conditions, m.st.kpi.conditions ?? '', 'g')}</section>`;
}

const condText = (m: MapStrings, c: { aspect: string; expression: string; whenTrue: boolean }): string =>
  `${c.aspect === 'ENABLED' ? m.st.enabledIf : m.st.visibleIf} ${shownExpression(c)}`;

const matches = (item: StructureItem, q: string): boolean =>
  !q ||
  item.name.toLowerCase().includes(q) ||
  item.conditions.some((c) => c.expression.toLowerCase().includes(q)) ||
  item.children.some((child) => matches(child, q));

function treeItem(m: MapStrings, ui: CartographyUi, item: StructureItem, q: string): string {
  if (!matches(item, q)) return '';
  const closed = ui.structClosed.includes(item.id) && !q;
  const selectable = item.kind === 'CONTAINER' || item.kind === 'FIELD' || item.kind === 'BUTTON';
  const toggle = item.children.length
    ? `<button class="st-tg" data-action="map-st-toggle" data-id="${esc(item.id)}" aria-expanded="${String(!closed)}" aria-label="${esc(item.name)}">${icon(closed ? 'right' : 'down')}</button>`
    : '<span class="st-tg-s"></span>';
  const badges = item.conditions
    .map(
      (c) =>
        `<small class="st-cond ${c.aspect === 'ENABLED' ? 'en' : 'vi'}" title="${esc(condText(m, c))}">${esc(condText(m, c))}</small>`,
    )
    .join('');
  const key = kindKey(item.kind, item.tab);
  const label = `<span class="st-ic k-${key.toLowerCase()}">${icon(KIND_ICON[key] ?? 'layers')}</span><span class="st-tx"><b>${esc(item.name)}</b>${item.sub ? ` <small class="mu">(${esc(item.sub)})</small>` : ''}${badges ? `<br>${badges}` : ''}</span>`;
  const row = selectable
    ? `<button class="st-row${ui.element === item.id ? ' sel' : ''}" data-action="map-st-el" data-id="${esc(item.id)}" data-nav="struct" title="${esc(m.st.kinds[key] ?? item.kind)}">${label}</button>`
    : `<span class="st-row st-static">${label}</span>`;
  const children = closed ? '' : item.children.map((child) => treeItem(m, ui, child, q)).join('');
  return `<li>${toggle}${row}${children ? `<ul>${children}</ul>` : ''}</li>`;
}

function treeCard(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  const structure = ui.structure;
  const features = ui.features?.items ?? [];
  const select = `<label class="st-feat"><span class="mu small">${esc(m.st.feature)}</span><select data-map="struct-feature"><option value="">${esc(m.st.allProject)}</option>${features
    .map(
      (f) =>
        `<option value="${esc(f.id)}" ${ui.structFeature === f.id ? 'selected' : ''}>${esc(f.name)}</option>`,
    )
    .join('')}</select></label>`;
  const q = ui.structQ.trim().toLowerCase();
  const body = ui.loading.structure
    ? h.spinner()
    : h.paneError(ui.errors.structure) ||
      (structure?.roots.length
        ? `<ul class="st-tree" role="tree">${structure.roots.map((r) => treeItem(m, ui, r, q)).join('')}</ul>`
        : `<p class="mu small">${esc(m.st.noTree)}</p>`);
  const legend = `<div class="st-legend"><b>${esc(m.st.legendTitle)}</b><span>${(
    ['ROUTE', 'CONTAINER', 'FIELD', 'BUTTON', 'CONDITION'] as const
  )
    .map(
      (k) =>
        `<span class="st-ic k-${k.toLowerCase()}">${icon(KIND_ICON[k] ?? 'layers')}</span>${esc(m.st.kinds[k] ?? k)}`,
    )
    .join('')}</span></div>`;
  return `<section class="card st-left"><h2>${esc(m.st.treeTitle)}</h2>${select}<label class="st-search">${icon('search')}<input type="search" data-map="struct-q" value="${esc(ui.structQ)}" placeholder="${esc(m.st.search)}" aria-label="${esc(m.st.search)}"></label>${body}${legend}</section>`;
}

const layerTypeOf = (m: MapStrings, node: MapNode): string => {
  if (node.kind === 'CONTAINER' || node.kind === 'BUTTON') return m.st.types.ui ?? '';
  if (node.kind === 'CONDITION') return m.st.types.condition ?? '';
  if (node.kind === 'ENTITY' || node.kind === 'COLUMN') return m.st.types.db ?? '';
  if (node.kind === 'FIELD') return `${m.st.types.field ?? ''} (${m.layers[node.layer] ?? node.layer})`;
  if (node.kind === 'API') return (node.layer === 'BFF' ? m.st.types.bff : m.st.types.backend) ?? '';
  if (node.kind === 'STREAM') return m.st.types.stream ?? '';
  if (node.layer === 'FRONTEND' && node.detail.role === 'STORE') return m.st.types.store ?? '';
  if (node.layer === 'FRONTEND') return m.st.types.front ?? '';
  return (node.layer === 'BFF' ? m.st.types.bffService : m.st.types.service) ?? '';
};

const where = (node: MapNode): Evidence | undefined => node.evidence.find((e) => e.file) ?? node.evidence[0];

/** Les éléments du parcours, dans l'ordre : l'élément, ses conditions et leur chaîne, ses actions et leur aval. */
function pathRows(sheet: ElementSheet): { node: MapNode; status: MapConfidence }[] {
  const rows = new Map<string, { node: MapNode; status: MapConfidence }>();
  const put = (node: MapNode, status: MapConfidence): void => {
    if (!rows.has(node.id)) rows.set(node.id, { node, status });
  };
  put(sheet.element, 'CONFIRMED');
  for (const c of sheet.conditions)
    for (const n of c.chain.nodes) put(n, c.status === 'UNKNOWN' ? 'UNKNOWN' : c.status);
  for (const a of sheet.actions) {
    for (const n of a.via ?? []) put(n, a.status);
    for (const n of a.triggers) put(n, 'CONFIRMED');
    for (const n of a.endpoints) put(n, a.status);
  }
  for (const n of sheet.graph.nodes) if (n.kind === 'ENTITY') put(n, 'CONFIRMED');
  return [...rows.values()];
}

function bottomTabs(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers, sheet: ElementSheet): string {
  const rows = pathRows(sheet);
  const externals = sheet.outbound;
  const endpoints = [...new Map(sheet.actions.flatMap((a) => a.endpoints).map((e) => [e.id, e])).values()];
  const data = sheet.graph.nodes.filter((n) => n.kind === 'FIELD' || n.kind === 'COLUMN');
  const evidence = [
    ...rows.map((r) => ({ node: r.node, ev: where(r.node) })),
    ...sheet.conditions.flatMap((c) =>
      c.chain.edges.map((e) => ({ node: undefined, ev: e.evidence.find((x) => x.file) })),
    ),
  ].filter((x): x is { node: MapNode | undefined; ev: Evidence } => x.ev !== undefined);
  const uniqueEvidence = [
    ...new Map(
      evidence.map((x) => [`${x.ev.sourceId ?? ''}:${x.ev.file ?? ''}:${String(x.ev.line ?? '')}`, x]),
    ).values(),
  ];
  const counts: Record<BottomTab, number> = {
    elements: rows.length,
    conditions: sheet.conditions.length,
    apis: endpoints.length + externals.length,
    data: data.length,
    evidence: uniqueEvidence.length,
  };
  const tabs = `<div class="tabs st-btabs" role="tablist">${BOTTOM_TABS.map((t) => `<button role="tab" data-action="map-st-bottom" data-tab="${t}" aria-selected="${String(ui.bottomTab === t)}">${esc(m.st.bottomTabs[t](counts[t]))}</button>`).join('')}</div>`;
  let body = '';
  if (ui.bottomTab === 'elements')
    body = `<table class="tbl map-tbl st-tbl"><thead><tr><th class="num">#</th><th>${esc(m.st.colElement)}</th><th>${esc(m.st.colType)}</th><th>${esc(m.st.colStatus)}</th></tr></thead><tbody>${rows
      .map((r, i) => {
        const ev = where(r.node);
        return `<tr><td class="num">${String(i + 1)}</td><td><span class="st-el"><span class="st-ic k-${r.node.kind.toLowerCase()}">${icon(KIND_ICON[r.node.kind] ?? (r.node.kind === 'ENTITY' ? 'data' : r.node.kind === 'API' ? 'code' : 'gear'))}</span><span>${breakable(r.node.label ?? r.node.name)}${ev?.file ? `<br><small class="mu st-loc">${esc(shortPath(ev.file, ev.line))}</small>` : ''}</span></span></td><td><span class="st-type">${esc(layerTypeOf(m, r.node))}</span></td><td>${h.conf(r.status)}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  else if (ui.bottomTab === 'conditions')
    body = sheet.conditions.length
      ? `<table class="tbl map-tbl st-tbl"><thead><tr><th>${esc(m.st.colAspect)}</th><th>${esc(m.st.colExpression)}</th><th>${esc(m.st.colSource)}</th><th>${esc(m.st.colDecision)}</th><th>${esc(m.st.colStatus)}</th></tr></thead><tbody>${sheet.conditions
          .map(
            (c) =>
              `<tr><td>${esc(m.st.aspect[c.aspect] ?? c.aspect)}${c.inherited ? `<br><small class="mu">${esc(m.st.inherited(c.inherited))}</small>` : ''}</td><td><code>${esc(shownExpression(c))}</code></td><td class="small">${c.sources.map((s) => `${esc(s.member)} : ${esc(m.st.sources[s.kind] ?? s.kind)}`).join('<br>')}</td><td>${c.decision ? `<code>${breakable(c.decision.method.name)}()</code>` : `<span class="warn-t small">${esc(m.st.undetermined)} — ${esc(c.undetermined ?? '')}</span>`}</td><td>${h.conf(c.status)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<p class="mu small">${esc(m.st.noConditions)}</p>`;
  else if (ui.bottomTab === 'apis')
    body = `<table class="tbl map-tbl st-tbl"><thead><tr><th>${esc(m.st.colElement)}</th><th>${esc(m.st.colType)}</th><th>${esc(m.st.colDetail)}</th></tr></thead><tbody>${
      [
        ...endpoints.map(
          (e) =>
            `<tr><td><code>${esc(e.name)}</code></td><td><span class="st-type">${esc(layerTypeOf(m, e))}</span></td><td class="small">${esc(typeof e.detail.handler === 'string' ? e.detail.handler : '')}</td></tr>`,
        ),
        ...externals.map(
          (o) =>
            `<tr><td><code>${esc(`${o.method ?? '?'} ${o.path ?? '?'}`)}</code></td><td><span class="st-type ext">${esc(m.st.types.external ?? '')}</span></td><td class="small">${esc(o.provider ?? o.name)} ${h.conf(o.confidence)}</td></tr>`,
        ),
      ].join('') || `<tr><td colspan="3" class="mu">${esc(m.st.noApiCalls)}</td></tr>`
    }</tbody></table>`;
  else if (ui.bottomTab === 'data')
    body = `<table class="tbl map-tbl st-tbl"><thead><tr><th>${esc(m.st.colElement)}</th><th>${esc(m.st.colContainer)}</th><th>${esc(m.st.colLayer)}</th></tr></thead><tbody>${data
      .map(
        (n) =>
          `<tr><td><code>${esc(typeof n.detail.field === 'string' ? n.detail.field : n.name)}</code></td><td>${esc(typeof n.detail.container === 'string' ? n.detail.container : '—')}</td><td>${esc(m.layers[n.layer] ?? n.layer)}</td></tr>`,
      )
      .join('')}</tbody></table>`;
  else
    body = `<ul class="st-evl">${uniqueEvidence
      .map(
        (x) =>
          `<li>${h.where(x.ev)}${x.node ? ` <small class="mu">${esc(x.node.label ?? x.node.name)}</small>` : ''} ${h.evidence(x.ev)}</li>`,
      )
      .join('')}</ul>`;
  return `<section class="st-bottom">${tabs}<div class="tbl-w">${body}</div></section>`;
}

/** Le parcours affiché : celui demandé pour l'élément (ou le point recentré), dans le sens choisi. */
export function shownTrace(ui: CartographyUi, sheet: ElementSheet): MapTrace | undefined {
  const start = ui.traceFrom ?? sheet.element.id;
  return ui.traceDir !== 'SHEET' && ui.trace?.start === start && ui.trace.direction === ui.traceDir
    ? ui.trace
    : undefined;
}

const nodeIcon = (node: MapNode): string =>
  KIND_ICON[node.kind] ?? (node.kind === 'ENTITY' ? 'data' : node.kind === 'API' ? 'code' : 'gear');

/** Le sens du parcours (fiche, amont, aval, complet), les critères, le bilan, la frontière et les ruptures. */
function traceBar(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers, trace: MapTrace | undefined): string {
  const dirs = `<div class="st-dirs" role="group" aria-label="${esc(m.st.dirLabel)}">${(
    ['SHEET', ...TRACE_DIRECTIONS] as const
  )
    .map(
      (d) =>
        `<button class="chip small" data-action="map-st-dir" data-dir="${d}" aria-pressed="${String(ui.traceDir === d)}">${esc(m.st.dirs[d] ?? d)}</button>`,
    )
    .join('')}</div>`;
  const investigate = `<button class="btn small" data-action="map-inv-open" ${h.canRun ? '' : 'disabled'}>${icon('search')}<span>${esc(m.inv.open)}</span></button>`;
  if (ui.traceDir === 'SHEET')
    return `<div class="st-tbar"><div class="st-dirs">${dirs}${investigate}</div></div>`;
  if (!trace)
    return `<div class="st-tbar">${dirs}${ui.errors.trace ? h.paneError(ui.errors.trace) : h.spinner()}</div>`;
  const name = (id: string): string => {
    const n = trace.nodes.find((x) => x.id === id);
    return n ? (n.label ?? n.name) : id;
  };
  const confirmed = trace.edges.filter((e) => e.confidence === 'CONFIRMED').length;
  const layers = MAP_LAYERS.filter(
    (l) => ui.traceLayers.includes(l) || trace.nodes.some((n) => n.layer === l),
  );
  const kinds = MAP_EDGE_KINDS.filter(
    (k) => ui.traceKinds.includes(k) || trace.edges.some((e) => e.kind === k),
  );
  const chip = (action: string, attr: string, value: string, label: string, on: boolean): string =>
    `<button class="chip small" data-action="${action}" data-${attr}="${esc(value)}" aria-pressed="${String(on)}">${esc(label)}</button>`;
  const criteria = `<div class="st-crit"><span class="mu small">${esc(m.st.layersLabel)}</span>${layers.map((l) => chip('map-st-tl', 'layer', l, m.layers[l] ?? l, ui.traceLayers.includes(l))).join('')}<span class="mu small">${esc(m.st.kindsLabel)}</span>${kinds.map((k) => chip('map-st-tk', 'kind', k, m.edgeKinds[k] ?? m.st.kinds[k] ?? k.toLowerCase(), ui.traceKinds.includes(k))).join('')}${ui.traceLayers.length || ui.traceKinds.length ? `<button class="btn small ghost" data-action="map-st-tclear">${esc(m.st.clearCriteria)}</button>` : ''}</div>`;
  const stats = `<p class="small st-tstats" data-trace-stats>${esc(m.st.traceStats(trace.nodes.length, trace.edges.length, confirmed, trace.edges.length - confirmed))}</p>`;
  const truncated = trace.truncated
    ? `<p class="warn-t small" role="status" data-trace-truncated>${esc(m.st.truncatedNote(trace.limit))}</p>`
    : '';
  const frontier = trace.frontier.length
    ? `<details class="st-front"><summary class="small">${esc(m.st.frontierNote(trace.frontier.length))}</summary><ul class="st-list">${trace.frontier
        .slice(0, 40)
        .map(
          (f) =>
            `<li>${breakable(name(f.node))} <small class="mu">${esc(m.st.frontierReasons[f.reason] ?? f.reason)}</small> <button class="btn small ghost" data-action="map-st-recenter" data-id="${esc(f.node)}">${esc(m.st.recenter)}</button></li>`,
        )
        .join('')}</ul></details>`
    : '';
  const breaks = `<div class="st-breaks" data-trace-breaks><h4 class="small">${esc(m.st.breaksTitle(trace.breaks.length))}</h4>${
    trace.breaks.length
      ? `<ul class="st-list">${trace.breaks
          .slice(0, 30)
          .map(
            (b) =>
              `<li>${h.conf(b.status)} <code>${esc(`${b.method} ${b.path}`)}</code> <small class="mu">${esc(name(b.node))} — ${esc(b.causes[0]?.message ?? '')}</small> <button class="btn small ghost" data-action="map-st-detail" data-id="${esc(b.node)}">${esc(m.st.detailsBtn)}</button></li>`,
          )
          .join('')}</ul>`
      : `<p class="mu small">${esc(m.st.noBreaks)}</p>`
  }</div>`;
  return `<div class="st-tbar"><div class="st-dirs">${dirs}${investigate}</div>${criteria}${stats}${truncated}${frontier}${breaks}</div>`;
}

/** Le chemin du point de départ à un nœud, par les liens du parcours (le plus court). */
function pathTo(graph: MapSubgraph, start: string, target: string): { node: string; edge?: MapEdge }[] {
  const prev = new Map<string, { from: string; edge: MapEdge }>();
  const seen = new Set([start]);
  let wave = [start];
  while (wave.length && !seen.has(target)) {
    const next: string[] = [];
    for (const id of wave)
      for (const edge of graph.edges) {
        const other = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;
        if (!other || seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { from: id, edge });
        next.push(other);
      }
    wave = next;
  }
  if (!seen.has(target)) return [];
  const out: { node: string; edge?: MapEdge }[] = [{ node: target }];
  for (let cur = target; cur !== start;) {
    const p = prev.get(cur);
    if (!p) break;
    const head = out[0];
    if (head) head.edge = p.edge;
    out.unshift({ node: p.from });
    cur = p.from;
  }
  return out;
}

/**
 * La fenêtre de détail d'un élément du graphe : description (les liens qui l'y relient), conditions, appels
 * d'API, lectures et écritures, preuves et code, diagnostics des ruptures, chemin depuis le départ. Elle se
 * superpose au graphe sans toucher au zoom ni à la position.
 */
function detailModal(
  m: MapStrings,
  ui: CartographyUi,
  h: ApiViewHelpers,
  graph: MapSubgraph & { outbound: ElementSheet['outbound'] },
  trace: MapTrace | undefined,
  start: string,
): string {
  const id = ui.detailNode ?? '';
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return '';
  const d = m.st.detail;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const label = (nid: string): string => {
    const n = byId.get(nid);
    return n ? (n.label ?? n.name) : nid;
  };
  const touching = graph.edges.filter((e) => e.from === id || e.to === id);
  const edgeRow = (e: MapEdge): string =>
    `<li>${h.conf(e.confidence)} <b>${esc(m.edgeKinds[e.kind] ?? m.st.kinds[e.kind] ?? e.kind)}</b> ${breakable(label(e.from === id ? e.to : e.from))}<br><small class="mu">${esc(e.reason)}</small>${e.detail?.condition ? `<br><code>${esc(e.detail.condition)}</code>` : ''}</li>`;
  const list = (items: string[]): string =>
    items.length ? `<ul class="st-list">${items.join('')}</ul>` : `<p class="mu small">${esc(d.none)}</p>`;
  const section = (title: string, body: string, key: string): string =>
    `<section class="st-sec" data-detail="${key}"><h4>${esc(title)}</h4>${body}</section>`;
  const conditions = touching.filter(
    (e) =>
      e.kind === 'VISIBLE_WHEN' ||
      e.kind === 'ENABLED_WHEN' ||
      e.kind === 'CONTROLLED_BY' ||
      e.detail?.condition !== undefined ||
      (node.kind === 'CONDITION' && e.kind === 'DEPENDS_ON'),
  );
  const apis = touching.filter(
    (e) => e.kind === 'CALLS' && byId.get(e.from === id ? e.to : e.from)?.kind === 'API',
  );
  const outbound = graph.outbound.filter((o) => o.from === id);
  const data = touching.filter((e) => e.kind === 'READS' || e.kind === 'WRITES');
  const where = node.evidence.find((e) => e.file) ?? node.evidence[0];
  const breaks = trace?.breaks.filter((b) => b.node === id) ?? [];
  const diag = (b: MapTrace['breaks'][number]): string => {
    const g = b.diagnostic;
    const rows: [string, string[]][] = g
      ? [
          [d.start, [g.start]],
          [d.lastDemonstrated, [g.lastDemonstrated]],
          [d.sought, [g.sought]],
          [d.examined, g.examined],
          [d.missing, g.missing],
          [d.limits, g.limits],
          [d.suggestions, g.suggestions],
        ]
      : [];
    return `<div class="st-cblock"><div class="st-chead">${h.conf(b.status)} <code>${esc(`${b.method} ${b.path}`)}</code></div><ul class="st-list">${b.causes.map((c) => `<li><b>${esc(c.code)}</b> — ${esc(c.message)}</li>`).join('')}</ul>${rows
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `<p class="small"><b>${esc(k)}</b> : ${v.map((x) => esc(x)).join(' · ')}</p>`)
      .join('')}</div>`;
  };
  const path = pathTo(graph, start, id);
  const level = trace?.levels[id];
  const kind = layerTypeOf(m, node);
  const head = `<div class="st-shead"><span class="st-ic big k-${node.kind.toLowerCase()}">${icon(nodeIcon(node))}</span><div><h2 id="st-detail-t">${breakable(node.label ?? node.name)}</h2><p class="small mu">${esc(d.kind)} : ${esc(kind)}${level !== undefined ? ` · ${esc(d.level(level))}` : ''}</p></div><button class="btn small ghost icon-only" data-action="map-st-detail-close" aria-label="${esc(d.close)}" title="${esc(d.close)}">${icon('close')}</button></div>`;
  const body = [
    section(d.description, list(touching.slice(0, 12).map(edgeRow)), 'description'),
    section(d.conditions, list(conditions.map(edgeRow)), 'conditions'),
    section(
      d.apis,
      list([
        ...apis.map(edgeRow),
        ...outbound.map(
          (o) =>
            `<li>${h.conf(o.confidence)} <code>${esc(`${o.method ?? '?'} ${o.path ?? '?'}`)}</code> <small class="mu">${esc(o.provider ?? o.name)}</small></li>`,
        ),
      ]),
      'apis',
    ),
    section(
      d.data,
      list(
        data.map(
          (e) =>
            `<li>${h.conf(e.confidence)} <b>${esc(m.edgeKinds[e.kind] ?? e.kind)}</b> ${breakable(label(e.from === id ? e.to : e.from))}${e.detail?.operation ? ` <span class="st-type">${esc(e.detail.operation)}</span>` : ''}${e.detail?.statement ? `<br><code>${esc(e.detail.statement)}</code>` : ''}<br><small class="mu">${esc(e.reason)}</small></li>`,
        ),
      ),
      'data',
    ),
    section(
      d.evidence,
      list(node.evidence.slice(0, 10).map((e) => `<li>${h.where(e)} ${h.evidence(e)}</li>`)),
      'evidence',
    ),
    section(d.code, where ? `<p class="small">${h.where(where)} ${h.evidence(where)}</p>` : list([]), 'code'),
    section(d.diagnostics, breaks.length ? breaks.map(diag).join('') : list([]), 'diagnostics'),
    section(
      d.path,
      path.length
        ? `<ol class="st-list st-pre">${path.map((p) => `<li>${breakable(label(p.node))}${p.edge ? ` <small class="mu">← ${esc(m.edgeKinds[p.edge.kind] ?? p.edge.kind)}</small> ${h.conf(p.edge.confidence)}` : ''}</li>`).join('')}</ol>`
        : list([]),
      'path',
    ),
  ].join('');
  const recenter =
    ui.traceDir !== 'SHEET' && id !== start
      ? `<button class="btn small" data-action="map-st-recenter" data-id="${esc(id)}">${esc(m.st.recenter)}</button>`
      : '';
  return `<div class="lib-sheet-bg" data-action="map-st-detail-close"></div><aside class="lib-sheet st-detail" role="dialog" aria-modal="true" aria-labelledby="st-detail-t" tabindex="-1" data-st-detail>${head}${recenter}${body}</aside>`;
}

function graphPane(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers, sheet: ElementSheet): string {
  const trace = shownTrace(ui, sheet);
  const input: LaneInput = trace
    ? {
        graph: trace,
        outbound: trace.outbound,
        ownNodes: [trace.start],
        extraKinds: ['TRANSFORMS'],
        scanId: trace.scanId,
      }
    : {
        graph: sheet.graph,
        outbound: sheet.outbound,
        ownNodes: [sheet.element.id],
        extraKinds: ['TRANSFORMS'],
        scanId: sheet.scanId,
      };
  const model = laneModel(input, 'architecture', ui.apiFilters);
  const selection =
    ui.graphSel?.kind === 'node' && !model.cards.has(ui.graphSel.id) ? undefined : ui.graphSel;
  const options = {
    m,
    ...(h.summary ? { summary: h.summary } : {}),
    sheet: input,
    model,
    openCards: new Set(ui.lnCards),
    openBundles: new Set(ui.lnBundles),
    ...(selection ? { selection } : {}),
  };
  const drawn = lanesView(options);
  const height = Math.min(640, Math.max(280, Math.round(drawn.height * ui.zoom) + 40));
  const btn = (action: string, label: string, name: string, extra = ''): string =>
    `<button class="btn small icon-only" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}"${extra}>${icon(name)}</button>`;
  const kind = m.st.kinds[sheet.element.kind] ?? sheet.element.kind;
  const sub = trace ? (m.st.dirSubs[trace.direction] ?? m.st.traceSub) : m.st.traceSub;
  const head = `<div class="map-gtitle st-gtitle"><div><h3><span class="st-ic k-${sheet.element.kind.toLowerCase()}">${icon(KIND_ICON[sheet.element.kind] ?? 'layers')}</span>${esc(m.st.traceOf(kind, sheet.element.label ?? sheet.element.name))}</h3><p class="mu small">${esc(sub)}</p></div><div class="map-gtools"><span class="map-gbtns">${btn('map-g-full', ui.fullscreen ? m.g.exitFullscreen : m.g.fullscreen, ui.fullscreen ? 'minimize' : 'maximize', ` aria-pressed="${String(ui.fullscreen)}"`)}${btn('map-g-fit', m.g.fit, 'scan')}${btn('map-g-zoom', m.g.zoomOut, 'minus', ' data-dir="-1"')}<output class="map-gzoom" aria-live="polite">${esc(m.g.zoomLevel(ui.zoom))}</output>${btn('map-g-zoom', m.g.zoomIn, 'plus', ' data-dir="1"')}</span></div></div>`;
  const canvas = `<div class="map-canvas full lanes" data-map-canvas tabindex="0" style="--ln-h:${String(height)}px" aria-label="${esc(m.st.traceOf(kind, sheet.element.name))}"><div class="map-canvas-in" style="transform:translate(${String(ui.panX)}px,${String(ui.panY)}px) scale(${String(ui.zoom)})">${drawn.html}</div></div>`;
  // La carte choisie regroupe un ou plusieurs éléments : chacun ouvre sa fenêtre de détail.
  const card = ui.graphSel?.kind === 'node' ? model.cards.get(ui.graphSel.id) : undefined;
  const inGraph = new Map(input.graph.nodes.map((n) => [n.id, n]));
  const pickedNodes = (card?.nodes ?? []).flatMap((id) => {
    const n = inGraph.get(id);
    return n ? [n] : [];
  });
  const details = pickedNodes.length
    ? `<p class="st-pickd">${pickedNodes
        .slice(0, 8)
        .map(
          (n) =>
            `<button class="btn small" data-action="map-st-detail" data-id="${esc(n.id)}">${icon('info')} ${esc(m.st.detailsBtn)} · ${esc(n.label ?? n.name)}</button>`,
        )
        .join('')}</p>`
    : '';
  const modal = ui.detailNode
    ? detailModal(
        m,
        ui,
        h,
        { ...input.graph, outbound: input.outbound },
        trace,
        trace?.start ?? sheet.element.id,
      )
    : '';
  return `<div class="map-trace ln-wrap st-trace${ui.fullscreen ? ' full' : ''}" data-map-trace>${head}${traceBar(m, ui, h, trace)}${canvas}${laneLegend(m, model)}${laneSelection({ ...options, conf: h.conf, evidence: h.evidence, where: h.where })}${details}${bottomTabs(m, ui, h, sheet)}</div>${modal}`;
}

function conditionsTable(
  m: MapStrings,
  ui: CartographyUi,
  h: ApiViewHelpers,
  page: MapPage<ConditionRow> | undefined,
): string {
  const search = `<label class="st-search">${icon('search')}<input type="search" data-map="cond-q" value="${esc(ui.condCriteria.q)}" placeholder="${esc(m.st.searchRows)}" aria-label="${esc(m.st.searchRows)}"></label>`;
  if (ui.loading.conditions && !page) return `${search}${h.spinner()}`;
  if (!page?.items.length)
    return `${search}${h.paneError(ui.errors.conditions)}<p class="mu small">${esc(m.st.noConditions)}</p>`;
  return `${search}<div class="tbl-w"><table class="tbl map-tbl st-tbl"><thead><tr><th>${esc(m.st.colElement)}</th><th>${esc(m.st.colAspect)}</th><th>${esc(m.st.colExpression)}</th><th>${esc(m.st.colSource)}</th><th>${esc(m.st.colDecision)}</th><th>${esc(m.st.colStatus)}</th></tr></thead><tbody>${page.items
    .map(
      (r) =>
        `<tr><td><button class="lnk" data-action="map-st-el" data-id="${esc(r.element.id)}">${icon(KIND_ICON[r.element.kind] ?? 'grid')} ${esc(r.element.name)}</button>${r.component ? `<br><small class="mu">${esc(r.component)}</small>` : ''}</td><td>${esc(m.st.aspect[r.aspect] ?? r.aspect)}</td><td><code class="st-code">${breakable(shownExpression(r))}</code></td><td class="small">${r.sources.map((s) => `${esc(s.member)} : ${esc(m.st.sources[s.kind] ?? s.kind)}`).join('<br>')}</td><td>${r.decision ? `<code>${breakable(r.decision)}()</code>` : `<span class="warn-t small">${esc(m.st.undetermined)}${r.undetermined ? ` — ${esc(r.undetermined)}` : ''}</span>`}</td><td>${h.conf(r.status)}</td></tr>`,
    )
    .join('')}</tbody></table></div>${h.pager('conditions', page, [10, 25, 50])}`;
}

function actionsTable(
  m: MapStrings,
  ui: CartographyUi,
  h: ApiViewHelpers,
  page: MapPage<ActionRow> | undefined,
): string {
  const search = `<label class="st-search">${icon('search')}<input type="search" data-map="act-q" value="${esc(ui.actCriteria.q)}" placeholder="${esc(m.st.searchRows)}" aria-label="${esc(m.st.searchRows)}"></label>`;
  if (ui.loading.actions && !page) return `${search}${h.spinner()}`;
  if (!page?.items.length)
    return `${search}${h.paneError(ui.errors.actions)}<p class="mu small">${esc(m.st.noActions)}</p>`;
  const list = (items: string[]): string =>
    items.map((x) => `<code class="st-code">${breakable(x)}</code>`).join('<br>') ||
    '<span class="mu">—</span>';
  return `${search}<div class="tbl-w"><table class="tbl map-tbl st-tbl"><thead><tr><th>${esc(m.st.colElement)}</th><th>${esc(m.st.colHandler)}</th><th>${esc(m.st.colCalls)}</th><th>${esc(m.st.colEndpoints)}</th><th>${esc(m.st.colExternals)}</th><th>${esc(m.st.colEntities)}</th><th>${esc(m.st.colStatus)}</th></tr></thead><tbody>${page.items
    .map(
      (r) =>
        `<tr><td><button class="lnk" data-action="map-st-el" data-id="${esc(r.id)}">${icon('pointer')} ${esc(r.name)}</button>${r.component ? `<br><small class="mu">${esc(r.component)}</small>` : ''}</td><td>${r.handler ? `<code class="st-code">${breakable(`${r.handler}()`)}</code>` : '<span class="mu">—</span>'}</td><td class="small">${list(r.calls)}</td><td class="small">${list(r.endpoints)}</td><td class="small">${list(r.externals)}</td><td class="small">${list(r.entities)}</td><td>${h.conf(r.status)}</td></tr>`,
    )
    .join('')}</tbody></table></div>${h.pager('actions', page, [10, 25, 50])}`;
}

function centerCard(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  const tabs = `<div class="tabs map-sheet-t st-ctabs" role="tablist">${STRUCT_TABS.map((t) => `<button role="tab" data-action="map-st-tab" data-tab="${t}" aria-selected="${String(ui.structTab === t)}">${icon(t === 'graph' ? 'traceability' : t === 'conditions' ? 'merge' : 'play')}<span>${esc(m.st.centerTabs[t] ?? t)}</span></button>`).join('')}</div>`;
  let body: string;
  if (ui.structTab === 'conditions') body = conditionsTable(m, ui, h, ui.conditionsPage);
  else if (ui.structTab === 'actions') body = actionsTable(m, ui, h, ui.actionsPage);
  else {
    const sheet = ui.elementSheet && ui.elementSheet.element.id === ui.element ? ui.elementSheet : undefined;
    body = ui.loading.element
      ? h.spinner()
      : h.paneError(ui.errors.element) ||
        (sheet ? graphPane(m, ui, h, sheet) : `<p class="mu st-pick">${esc(m.st.pick)}</p>`);
  }
  return `<section class="card st-center">${tabs}<div class="st-cbody">${body}</div></section>`;
}

function conditionBlock(m: MapStrings, h: ApiViewHelpers, c: ElementCondition): string {
  const decision = c.decision
    ? `<p class="small">${esc(m.st.computedBy)} : <code>${breakable(c.decision.method.name)}()</code> ${h.evidence(where(c.decision.method))}</p><p class="small mu">${esc(m.st.loops(c.decision.loops))}${c.decision.predicates.length ? ` · ${c.decision.predicates.map((p) => esc(p)).join(' · ')}` : ''}</p>${c.decision.reads.length ? `<p class="small">${esc(m.st.dataRead)} : ${c.decision.reads.map((r) => `<code>${esc(r)}</code>`).join(', ')}</p>` : ''}`
    : `<p class="small warn-t">${esc(m.st.undetermined)} — ${esc(c.undetermined ?? '')}</p>`;
  return `<div class="st-cblock"><div class="st-chead"><code class="st-expr">${esc(shownExpression(c))}</code><small class="mu">${esc(c.aspect === 'ENABLED' ? m.st.enabledIf : m.st.visibleIf)}</small>${h.conf(c.status)}</div>${c.inherited ? `<p class="small mu">${esc(m.st.inherited(c.inherited))}</p>` : ''}<p class="small mu">${c.sources.map((s) => `${esc(s.member)} : ${esc(m.st.sources[s.kind] ?? s.kind)}`).join(' · ')}</p>${decision}</div>`;
}

function rightSheet(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  const sheet = ui.elementSheet && ui.elementSheet.element.id === ui.element ? ui.elementSheet : undefined;
  if (!sheet) return '<aside class="st-right"></aside>';
  const el = sheet.element;
  const elKey = kindKey(el.kind, el.detail.tab);
  const kind = m.st.kinds[elKey] ?? el.kind;
  const component = typeof el.detail.component === 'string' ? el.detail.component : (el.parent ?? '');
  const tabs = `<div class="tabs st-stabs" role="tablist">${SHEET_TABS.map((t) => `<button role="tab" data-action="map-st-sheet" data-tab="${t}" aria-selected="${String(ui.sheetTab === t)}">${esc(m.st.sheetTabs[t] ?? t)}</button>`).join('')}</div>`;
  const show = (tab: SheetTab): boolean => ui.sheetTab === 'details' || ui.sheetTab === tab;
  const visible = sheet.conditions.filter((c) => c.aspect === 'VISIBLE');
  const enabled = sheet.conditions.filter((c) => c.aspect === 'ENABLED');
  const parts: string[] = [];
  if (ui.sheetTab === 'details')
    parts.push(
      `<section class="st-sec"><h4>${icon('info')}${esc(m.st.description)}</h4><p class="small">${esc(
        m.st.describe(
          kind,
          component,
          sheet.ancestors
            .filter((a) => a.kind === 'CONTAINER')
            .map((a) => a.label ?? a.name)
            .join(' › '),
        ),
      )}</p>${typeof el.detail.handler === 'string' ? `<p class="small">${esc(m.st.handler)} : <code>${esc(el.detail.handler)}()</code></p>` : ''}${sheet.children.length ? `<p class="small mu">${esc(m.st.children(sheet.children.length))} : ${sheet.children.map((c) => esc(c.label ?? c.name)).join(', ')}</p>` : ''}</section>`,
    );
  // Un onglet : bibliothèque, chargement, préconditions démontrées, dépendances, contenu, stores.
  const tab = sheet.tab;
  if (tab && ui.sheetTab === 'details') {
    const t = m.st.tab;
    const linkList = (list: TabSheet['dependsOn']) =>
      `<ul class="st-list">${list.map((d) => `<li><button class="lnk" data-action="map-st-el" data-id="${esc(d.id)}" data-nav="struct">${esc(d.name)}</button> ${h.conf(d.confidence)}<br><small class="mu">${esc(d.reason)}</small></li>`).join('')}</ul>`;
    parts.push(
      `<section class="st-sec st-tab"><h4>${icon('layers')}${esc(t.title)}</h4><p class="small">${esc(t.library[tab.library] ?? tab.library)} · ${esc(tab.lazy ? (t.lazy[tab.lazy] ?? tab.lazy) : t.eager)}${tab.repeat ? ` · ${esc(t.generated(tab.repeat, (tab.items ?? []).join(', ')))}` : ''}${tab.route ? ` · <code>routerLink="${esc(tab.route)}"</code>` : ''}</p>${tab.routeUnresolved ? `<p class="small warn-t">${esc(tab.routeUnresolved)}</p>` : ''}${tab.role === 'TAB' ? `<p class="small mu">${esc(t.content(tab.fields, tab.buttons))}</p>` : ''}${
        tab.tabs.length
          ? `<p class="small"><b>${esc(t.tabs(tab.tabs.length))}</b> : ${tab.tabs.map((x) => `<button class="lnk" data-action="map-st-el" data-id="${esc(x.id)}" data-nav="struct">${esc(x.name)}</button>`).join(', ')}</p>`
          : ''
      }${tab.selectedBy.map((s) => `<p class="small"><b>${esc(t.selectedBy)}</b> <code>${esc(s.stream)}</code> ${h.conf(s.confidence)}<br><small class="mu">${esc(s.reason)}</small></p>`).join('')}${
        tab.preconditions.length
          ? `<h4>${esc(t.preconditions)}</h4><ol class="st-list st-pre">${tab.preconditions.map((p) => `<li class="small">${esc(p)}</li>`).join('')}</ol>`
          : ''
      }${tab.dependsOn.length ? `<h4>${esc(t.dependsOn)}</h4>${linkList(tab.dependsOn)}` : ''}${tab.usedBy.length ? `<h4>${esc(t.usedBy)}</h4>${linkList(tab.usedBy)}` : ''}${
        tab.role === 'TAB' && !tab.dependsOn.length && !tab.usedBy.length
          ? `<p class="small mu">${esc(t.none)}</p>`
          : ''
      }${
        tab.components.length
          ? `<h4>${esc(t.components)}</h4><ul class="st-list">${tab.components.map((c) => `<li class="small"><code>${esc(c.name)}</code>${c.reusedIn.length > 1 ? ` <small class="mu">— ${esc(t.reused(c.reusedIn.join(', ')))}</small>` : ''}</li>`).join('')}</ul>`
          : ''
      }${tab.stores.length ? `<h4>${esc(t.stores)}</h4><p class="small">${tab.stores.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}</section>`,
    );
  }
  if (show('conditions')) {
    parts.push(
      `<section class="st-sec"><h4>${icon('eye')}${esc(m.st.displayConditions)}</h4>${visible.length ? visible.map((c) => conditionBlock(m, h, c)).join('') : `<p class="small mu">${esc(m.st.alwaysVisible)}</p>`}</section>`,
    );
    if (el.kind === 'BUTTON' || tab)
      parts.push(
        `<section class="st-sec"><h4>${icon('checkCircle')}${esc(m.st.enableConditions)}</h4>${enabled.length ? enabled.map((c) => conditionBlock(m, h, c)).join('') : `<p class="small mu">${esc(m.st.alwaysEnabled)}</p>`}</section>`,
      );
  }
  if (show('apis')) {
    const endpoints = [
      ...new Map(
        [...sheet.actions.flatMap((a) => a.endpoints), ...(tab?.apis ?? [])].map((e) => [e.id, e]),
      ).values(),
    ];
    const items = [
      ...endpoints.map(
        (e) =>
          `<li><code>${esc(e.name)}</code> <span class="st-type">${esc(m.layers[e.layer] ?? e.layer)}</span> <span class="st-type int">${esc(m.st.internal)}</span> ${h.evidence(where(e))}</li>`,
      ),
      ...sheet.outbound.map(
        (o) =>
          `<li><code>${esc(`${o.method ?? '?'} ${o.path ?? '?'}`)}</code> <span class="st-type ext">${esc(m.st.external)}</span> <small class="mu">${esc(o.provider ?? o.name)}</small> ${h.conf(o.confidence)}</li>`,
      ),
    ];
    parts.push(
      `<section class="st-sec"><h4>${icon('network')}${esc(m.st.apiCalls(items.length))}</h4>${items.length ? `<ul class="st-list">${items.join('')}</ul>` : `<p class="small mu">${esc(m.st.noApiCalls)}</p>`}</section>`,
    );
  }
  if (show('code')) {
    const evidence = [el, ...sheet.conditions.flatMap((c) => (c.decision ? [c.decision.method] : []))]
      .map((n) => where(n))
      .filter((e): e is Evidence => e?.file !== undefined);
    parts.push(
      `<section class="st-sec"><h4>${icon('code')}${esc(m.st.evidenceTitle)}</h4><ul class="st-list">${[...new Map(evidence.map((e) => [`${e.file ?? ''}:${String(e.line ?? '')}`, e])).values()].map((e) => `<li>${h.where(e)} ${h.evidence(e)}</li>`).join('')}</ul></section>`,
    );
  }
  if (show('scenarios'))
    parts.push(
      `<section class="st-sec"><h4>${icon('play')}${esc(m.st.scenariosTitle(sheet.scenarios.length))}</h4>${sheet.scenarios.length ? `<ul class="st-list">${sheet.scenarios.map((s) => `<li>${h.chip(s.verified ? 'VERIFIED' : s.executed ? 'EXECUTED' : 'ASSOCIATED', m.p.scenarioState[s.verified ? 'verified' : s.executed ? 'executed' : 'associated'] ?? '')} ${esc(s.scenario)}</li>`).join('')}</ul>` : `<p class="small mu">${esc(m.st.noScenarios)}</p>`}</section>`,
    );
  return `<aside class="st-right"><section class="card st-sheet"><div class="st-shead"><span class="st-ic big k-${elKey.toLowerCase()}">${icon(KIND_ICON[elKey] ?? 'layers')}</span><div><h2>${esc(elKey === 'TAB_GROUP' && el.name.startsWith('Onglets :') ? el.name : `${kind} : ${el.label ?? el.name}`)}</h2><p class="mu small">${esc(component)}</p>${h.chip('CONFIRMED', m.st.detected)}</div></div>${tabs}${parts.join('')}</section></aside>`;
}

/** L'onglet entier : arbre, centre (graphe, conditions, actions), fiche de l'élément. */
export function structureTab(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  return `<div class="st-grid">${treeCard(m, ui, h)}${centerCard(m, ui, h)}${rightSheet(m, ui, h)}</div>${investigationModal(m, ui, h)}`;
}

export const STRUCTURE_CSS = `
.st-grid{display:grid;grid-template-columns:minmax(220px,16fr) minmax(0,58fr) minmax(280px,26fr);grid-template-areas:'tree center sheet';gap:14px;align-items:start}
.st-grid>.st-left{grid-area:tree}.st-grid>.st-center{grid-area:center}.st-grid>.st-right{grid-area:sheet}
@media (max-width:1679px){.st-grid{grid-template-columns:minmax(260px,300px) minmax(0,1fr);grid-template-rows:auto 1fr;grid-template-areas:'tree center' 'sheet center'}}
@media (max-width:860px){.st-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-template-areas:'tree' 'center' 'sheet'}}
.st-left,.st-center,.st-right{min-width:0}
.st-left h2,.st-sheet h2{font-size:14px;margin:0 0 8px}
.st-feat{display:flex;flex-direction:column;gap:2px;margin-bottom:8px}.st-feat select{font:inherit;padding:5px 6px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface)}
.st-search{display:flex;align-items:center;gap:6px;border:1px solid var(--qa-color-border);border-radius:8px;padding:4px 8px;margin-bottom:8px;background:var(--qa-color-surface)}
.st-search .ico{width:14px;height:14px;color:var(--qa-color-muted)}.st-search input{border:0;outline:0;flex:1;font:inherit;background:transparent;min-width:0}
.st-tree{max-height:560px;overflow:auto}
.st-tree,.st-tree ul{list-style:none;margin:0;padding:0}.st-tree ul{padding-left:12px;border-left:1px dashed var(--qa-color-border);margin-left:8px}
.st-tree li{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:start}
.st-tree li>ul{grid-column:1 / -1}
.st-tg{border:0;background:transparent;padding:4px 0;cursor:pointer;color:var(--qa-color-muted)}.st-tg .ico{width:12px;height:12px}.st-tg-s{display:block}
.st-row{display:flex;gap:6px;align-items:flex-start;text-align:left;border:0;background:transparent;padding:4px 6px;border-radius:8px;width:100%;min-width:0;cursor:pointer;font:inherit;color:inherit}
.st-row:hover{background:var(--qa-color-surface-2)}.st-row.sel{background:var(--qa-color-primary-soft,#e8f5ec);box-shadow:inset 0 0 0 1px var(--qa-color-primary,#15803d)}
.st-row.st-static{cursor:default}.st-row.st-static:hover{background:transparent}
.st-tx{min-width:0;font-size:12.5px;line-height:1.35;overflow-wrap:anywhere}.st-tx b{font-weight:600}
.st-cond{display:inline-block;margin-top:2px;font-family:var(--qa-font-mono,ui-monospace,monospace);font-size:11px;color:#15803d;overflow-wrap:anywhere}.st-cond.en{color:#b45309}
.st-ic{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;flex:none}
.st-ic .ico{width:14px;height:14px}.st-ic.big{width:34px;height:34px;border-radius:10px}.st-ic.big .ico{width:20px;height:20px}
.k-route{color:#15803d;background:#e8f5ec}.k-component{color:#7c3aed;background:#f3edfd}.k-container{color:#7c3aed;background:#f3edfd}.k-field{color:#0e7490;background:#e6f4f7}.k-button{color:#be123c;background:#fdecef}.k-tab,.k-tab_group{color:#0f766e;background:#e6f6f3}.st-list.st-pre{list-style:decimal;padding-left:18px}.st-sec.st-tab h4{margin:12px 0 6px}.k-condition{color:#b45309;background:#fdf3e4}.k-entity{color:#c2850c;background:#fdf7e8}.k-api{color:#2563eb;background:#eef4fd}.k-method,.k-service{color:#15803d;background:#eef8f0}
.st-legend{display:flex;flex-direction:column;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid var(--qa-color-border);font-size:12px}.st-legend>span{display:grid;grid-template-columns:20px 1fr 20px 1fr;gap:6px 6px;align-items:center}
.st-ctabs{margin-bottom:10px;flex-wrap:wrap}.st-ctabs button{display:inline-flex;gap:6px;align-items:center}.st-ctabs .ico{width:15px;height:15px}
.st-gtitle h3{display:flex;gap:8px;align-items:center;margin:0;font-size:15px}
.st-pick{padding:30px;text-align:center}
.st-tbar{display:flex;flex-direction:column;gap:6px;margin:6px 0 8px}
.st-dirs,.st-crit{display:flex;flex-wrap:wrap;gap:4px;align-items:center}.st-crit>.mu{margin:0 4px 0 6px}
.st-dirs .chip,.st-crit .chip{min-height:28px;padding:0 10px;font-size:12px}
.st-tstats{margin:0}.st-front summary{cursor:pointer}.st-breaks h4{margin:4px 0}
.st-pickd{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 0}
.st-detail{max-width:560px;width:min(560px,100vw);overflow:auto}
.st-bottom{border:1px solid var(--qa-color-border);border-radius:12px;padding:6px 10px 10px;margin-top:10px}
.st-btabs,.st-stabs{margin-bottom:6px;flex-wrap:wrap;gap:2px}
.st-btabs button,.st-stabs button{padding:6px 8px;font-size:12.5px}.st-stabs button{padding:5px 6px;font-size:12px}
.st-code{white-space:normal;word-break:normal;overflow-wrap:normal}
.st-tbl td{vertical-align:top}.st-tbl code{font-size:11.5px}
.st-el{display:inline-flex;gap:6px;align-items:flex-start;min-width:0}.st-loc{font-family:var(--qa-font-mono,ui-monospace,monospace);font-size:11px;overflow-wrap:anywhere}
.st-type{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--qa-color-surface-2);color:var(--qa-color-muted);white-space:nowrap}
.st-type.ext{background:#f3edfd;color:#6d28d9}.st-type.int{background:#e8f5ec;color:#15803d}
.st-evl,.st-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px;overflow-wrap:anywhere}
.st-shead{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}.st-shead>div{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:4px}.st-shead h2{margin:0}.st-shead p{margin:0}
.st-sec{border-top:1px solid var(--qa-color-border);padding:10px 0 4px}.st-sec h4{display:flex;gap:6px;align-items:center;margin:0 0 6px;font-size:13px}.st-sec h4 .ico{width:15px;height:15px;color:var(--qa-color-muted)}
.st-cblock{border:1px solid var(--qa-color-border);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--qa-color-surface-2);overflow-wrap:anywhere}
.st-chead{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.st-expr{font-size:12px;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:6px;padding:2px 6px}
.st-cblock p{margin:4px 0}
.map-kpis.st-kpis{grid-template-columns:repeat(7,minmax(0,1fr))}
@media (max-width:1300px){.map-kpis.st-kpis{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media (max-width:860px){.map-kpis.st-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
