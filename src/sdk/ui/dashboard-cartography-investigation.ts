import type {
  Investigation,
  InvestigationGoal,
  InvestigationPath,
  MapEdge,
  MapLayer,
  MapNode,
} from '../core/cartography.js';
import { INVESTIGATION_GOALS, MAP_LAYERS, TRACE_DIRECTIONS } from '../core/cartography.js';
import type { ApiViewHelpers } from './dashboard-cartography-apis.js';
import { breakable, shortPath } from './dashboard-cartography-graph.js';
import type { MapStrings } from './dashboard-cartography-i18n.js';
import { laneModel, lanesView, type LaneInput } from './dashboard-cartography-lanes.js';
import type { CartographyUi } from './dashboard-cartography.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * LA FENÊTRE D'INVESTIGATION : l'objectif, le point de départ, l'état et le budget consommé ; les chemins
 * démontrables regroupés par issue (aboutis, partiels, rompus), jamais fusionnés ; pour le chemin choisi, ses
 * étapes (relation, confiance, conditions, preuve) et son graphe ; en bas, les ruptures, les hypothèses, la
 * frontière (« Explorer cette branche »), les recherches faites, les cycles et les limites. Rien n'y est
 * déduit côté navigateur : tout vient de l'investigation menée par le serveur.
 */

export const INV_TABS = ['breaks', 'hypotheses', 'frontier', 'attempts', 'cycles', 'limits'] as const;
export type InvTab = (typeof INV_TABS)[number];

const kindIcon = (kind: string): string =>
  ({
    BUTTON: 'pointer',
    CONTAINER: 'grid',
    CONDITION: 'diamond',
    ROUTE: 'file',
    COMPONENT: 'cube',
    API: 'code',
    ENTITY: 'data',
    COLUMN: 'data',
    FIELD: 'text',
    STREAM: 'layers',
  })[kind] ?? 'gear';

/** Les chemins montrés : critères de confiance, de couche et recherche (texte des étapes). */
export function shownPaths(ui: CartographyUi, inv: Investigation): InvestigationPath[] {
  const byId = new Map(inv.nodes.map((n) => [n.id, n]));
  const q = ui.invQ.trim().toLowerCase();
  return inv.paths.filter((p) => {
    if (ui.invConf === 'CONFIRMED' && p.confidence !== 'CONFIRMED') return false;
    if (ui.invLayers.length && !p.nodes.some((id) => ui.invLayers.includes(byId.get(id)?.layer as MapLayer)))
      return false;
    if (!q) return true;
    return p.nodes.some((id) => {
      const n = byId.get(id);
      return `${n?.name ?? id} ${n?.label ?? ''}`.toLowerCase().includes(q);
    });
  });
}

function stepsOf(m: MapStrings, h: ApiViewHelpers, inv: Investigation, path: InvestigationPath): string {
  const byId = new Map(inv.nodes.map((n) => [n.id, n]));
  const edges = new Map(inv.edges.map((e) => [e.id, e]));
  const q = m.inv;
  return `<ol class="inv-steps" data-inv-steps>${path.nodes
    .map((id, i) => {
      const n = byId.get(id);
      const e: MapEdge | undefined = i > 0 ? edges.get(path.edges[i - 1] ?? '') : undefined;
      const ev = n?.evidence.find((x) => x.file) ?? n?.evidence[0];
      const nature = e ? (inv.natures[e.id] ?? '') : '';
      const relation = e
        ? `<span class="inv-rel"><span class="inv-nat n-${nature.toLowerCase()}">${esc(q.natures[nature] ?? nature)}</span> ${esc(m.edgeKinds[e.kind] ?? e.kind)} ${h.conf(e.confidence)}${e.detail?.condition ? ` <code class="inv-cond">${esc(e.detail.condition)}</code>` : ''}${e.detail?.async ? ` <small class="mu">${esc(e.detail.async)}</small>` : ''}</span>`
        : `<span class="inv-rel mu small">${esc(q.start)}</span>`;
      const b = inv.breaks.filter((x) => x.at === id);
      return `<li class="inv-step${b.length ? ' broken' : ''}" data-node="${esc(id)}">${relation}<div class="inv-node"><span class="st-ic k-${(n?.kind ?? 'other').toLowerCase()}">${icon(kindIcon(n?.kind ?? ''))}</span><b>${breakable(n?.label ?? n?.name ?? id)}</b> <small class="mu">${esc(n ? `${n.kind} · ${m.layers[n.layer] ?? n.layer}` : '')}</small>${ev?.file ? ` <small class="mu st-loc">${esc(shortPath(ev.file, ev.line))}</small> ${h.evidence(ev)}` : ''}</div>${b.map((x) => `<p class="inv-break small"><b>${esc(x.code)}</b> — ${esc(x.message)}</p>`).join('')}${e ? `<small class="mu inv-why">${esc(e.reason)}</small>` : ''}</li>`;
    })
    .join('')}</ol>`;
}

function pathGraph(m: MapStrings, ui: CartographyUi, inv: Investigation, path: InvestigationPath): string {
  const ids = new Set(path.nodes);
  const edgeIds = new Set(path.edges);
  const input: LaneInput = {
    graph: {
      nodes: inv.nodes.filter((n) => ids.has(n.id)),
      edges: inv.edges.filter((e) => edgeIds.has(e.id)),
      depth: path.nodes.length,
      limit: path.nodes.length,
      truncated: false,
    },
    outbound: [],
    ownNodes: [inv.request.start],
    extraKinds: ['TRANSFORMS'],
    scanId: inv.scanId,
  };
  const model = laneModel(input, 'architecture');
  const drawn = lanesView({ m, sheet: input, model, openCards: new Set(), openBundles: new Set() });
  return `<div class="inv-canvas" data-inv-canvas tabindex="0"><div class="inv-canvas-in" style="transform:scale(${String(ui.invZoom)})">${drawn.html}</div></div>`;
}

export function investigationModal(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  if (!ui.invOpen) return '';
  const q = m.inv;
  const inv = ui.inv;
  const start = inv?.request.start ?? ui.invStart ?? '';
  const startNode: MapNode | undefined = inv?.nodes.find((n) => n.id === start);
  const startName = startNode?.label ?? startNode?.name ?? ui.invStartName ?? start;
  const goal = `<label class="inv-field"><span class="mu small">${esc(q.goal)}</span><select data-map="inv-goal">${INVESTIGATION_GOALS.map((g) => `<option value="${g}" ${g === ui.invGoal ? 'selected' : ''}>${esc(q.goals[g] ?? g)}</option>`).join('')}</select></label>`;
  const dirs = `<div class="st-dirs" role="group" aria-label="${esc(m.st.dirLabel)}">${TRACE_DIRECTIONS.map((d) => `<button class="chip small" data-action="map-inv-dir" data-dir="${d}" aria-pressed="${String(ui.invDir === d)}">${esc(m.st.dirs[d] ?? d)}</button>`).join('')}</div>`;
  const mode = `<label class="inv-field"><span class="mu small">${esc(q.mode)}</span><select data-map="inv-mode">${(['FOCUSED', 'EXHAUSTIVE'] as const).map((x) => `<option value="${x}" ${x === ui.invMode ? 'selected' : ''}>${esc(q.modes[x])}</option>`).join('')}</select></label>`;
  const run = `<button class="btn primary small" data-action="map-inv-run" ${h.canRun && start ? '' : 'disabled'}>${icon('play')}<span>${esc(q.run)}</span></button>`;
  const history = ui.invList?.length
    ? `<label class="inv-field"><span class="mu small">${esc(q.history)}</span><select data-map="inv-load"><option value="">—</option>${ui.invList
        .slice(0, 20)
        .map(
          (x) =>
            `<option value="${esc(x.id)}" ${x.id === inv?.id ? 'selected' : ''}>${esc(`${x.startName} · ${m.st.dirs[x.direction] ?? x.direction} · ${q.goals[x.goal] ?? x.goal}${x.state === 'STALE' ? ` · ${q.states.STALE}` : ''}`)}</option>`,
        )
        .join('')}</select></label>`
    : '';
  const tools = `<div class="inv-gbtns"><button class="btn small icon-only" data-action="map-inv-full" aria-pressed="${String(ui.invFull)}" aria-label="${esc(ui.invFull ? m.g.exitFullscreen : m.g.fullscreen)}" title="${esc(ui.invFull ? m.g.exitFullscreen : m.g.fullscreen)}">${icon(ui.invFull ? 'minimize' : 'maximize')}</button><button class="btn small icon-only" data-action="map-inv-close" aria-label="${esc(q.close)}" title="${esc(q.close)}">${icon('close')}</button></div>`;
  const head = `<div class="inv-head"><div><h2 id="inv-title">${esc(q.title(startName))}</h2>${inv ? `<p class="small"><span class="st-type inv-state s-${inv.state.toLowerCase()}">${esc(q.states[inv.state])}</span> ${esc(q.goals[inv.request.goal] ?? inv.request.goal)} · ${esc(m.st.dirs[inv.request.direction] ?? inv.request.direction)} · ${esc(q.modes[inv.request.mode])}</p><p class="small mu" data-inv-metrics>${esc(q.metrics(inv.metrics))}</p>` : `<p class="small mu">${esc(q.intro)}</p>`}</div>${tools}</div>`;
  const controls = `<div class="inv-controls">${goal}${dirs}${mode}${run}${history}${inv?.state === 'STALE' ? `<button class="btn small" data-action="map-inv-rerun">${icon('refresh')}<span>${esc(q.rerun)}</span></button>` : ''}</div>`;
  if (!inv) {
    const body = ui.loading.investigation
      ? h.spinner()
      : ui.errors.investigation
        ? h.paneError(ui.errors.investigation)
        : `<p class="mu">${esc(q.empty)}</p>`;
    return wrap(ui, `${head}${controls}<div class="inv-body one">${body}</div>`);
  }
  const paths = shownPaths(ui, inv);
  const chosen = paths.find((p) => p.id === ui.invPath) ?? paths[0];
  const layers = MAP_LAYERS.filter((l) => inv.nodes.some((n) => n.layer === l));
  const criteria = `<div class="inv-crit"><label class="st-search">${icon('search')}<input type="search" data-map="inv-q" value="${esc(ui.invQ)}" placeholder="${esc(q.search)}" aria-label="${esc(q.search)}"></label><span class="st-dirs">${(['ALL', 'CONFIRMED'] as const).map((c) => `<button class="chip small" data-action="map-inv-conf" data-conf="${c}" aria-pressed="${String(ui.invConf === c)}">${esc(q.conf[c])}</button>`).join('')}</span><span class="st-dirs">${layers.map((l) => `<button class="chip small" data-action="map-inv-layer" data-layer="${l}" aria-pressed="${String(ui.invLayers.includes(l))}">${esc(m.layers[l] ?? l)}</button>`).join('')}</span></div>`;
  const groups = (['COMPLETE', 'PARTIAL', 'BROKEN'] as const)
    .map((status) => {
      const list = paths.filter((p) => p.status === status);
      if (!list.length) return '';
      return `<h4 class="inv-gh">${esc(q.pathGroups[status](list.length))}</h4><ul class="inv-paths">${list
        .map((p) => {
          const last = inv.nodes.find((n) => n.id === p.nodes.at(-1));
          return `<li><button class="inv-path${p.id === chosen?.id ? ' sel' : ''}" data-action="map-inv-path" data-id="${esc(p.id)}" aria-pressed="${String(p.id === chosen?.id)}"><span>${esc(q.ends[p.end] ?? p.end)} · ${esc(last?.label ?? last?.name ?? '')}</span><small class="mu">${esc(q.steps(p.nodes.length))}${p.conditions.length ? ` · ${esc(q.conditions(p.conditions.length))}` : ''}</small>${h.conf(p.confidence)}</button></li>`;
        })
        .join('')}</ul>`;
    })
    .join('');
  const left = `<section class="inv-left">${criteria}${groups || `<p class="mu small">${esc(q.noPath)}</p>`}${inv.pathsTruncated ? `<p class="warn-t small">${esc(q.pathsTruncated)}</p>` : ''}</section>`;
  const center = chosen
    ? `<section class="inv-center"><div class="inv-ctools"><h3>${esc(q.pathTitle(chosen.id))} ${h.conf(chosen.confidence)}</h3><span class="map-gbtns"><button class="btn small icon-only" data-action="map-inv-zoom" data-dir="-1" aria-label="${esc(m.g.zoomOut)}">${icon('minus')}</button><output class="map-gzoom">${esc(m.g.zoomLevel(ui.invZoom))}</output><button class="btn small icon-only" data-action="map-inv-zoom" data-dir="1" aria-label="${esc(m.g.zoomIn)}">${icon('plus')}</button><button class="btn small" data-action="map-inv-home">${icon('scan')}<span>${esc(q.home)}</span></button></span></div>${chosen.conditions.length ? `<p class="small">${esc(q.conditionsTitle)} : ${chosen.conditions.map((c) => `<code class="inv-cond">${esc(c)}</code>`).join(' ')}</p>` : ''}${pathGraph(m, ui, inv, chosen)}${stepsOf(m, h, inv, chosen)}</section>`
    : `<section class="inv-center"><p class="mu">${esc(q.noPath)}</p></section>`;
  return wrap(ui, `${head}${controls}<div class="inv-body">${left}${center}</div>${bottom(m, ui, h, inv)}`);
}

function wrap(ui: CartographyUi, content: string): string {
  return `<div class="lib-sheet-bg" data-action="map-inv-close"></div><div class="inv-modal${ui.invFull ? ' full' : ''}" role="dialog" aria-modal="true" aria-labelledby="inv-title" tabindex="-1" data-inv-modal>${content}</div>`;
}

function bottom(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers, inv: Investigation): string {
  const q = m.inv;
  const name = (id: string): string => {
    const n = inv.nodes.find((x) => x.id === id);
    return n?.label ?? n?.name ?? id;
  };
  const frontierOf = new Set(inv.frontier.map((f) => f.node));
  const explore = (id: string): string =>
    frontierOf.has(id) && inv.state !== 'STALE'
      ? ` <button class="btn small" data-action="map-inv-expand" data-id="${esc(id)}">${icon('arrowRight')}<span>${esc(q.explore)}</span></button>`
      : '';
  const counts: Record<(typeof INV_TABS)[number], number> = {
    breaks: inv.breaks.length,
    hypotheses: inv.hypotheses.length,
    frontier: inv.frontier.length,
    attempts: inv.attempts.length,
    cycles: inv.cycles.length,
    limits: inv.limitations.length,
  };
  const tabs = `<div class="tabs st-btabs" role="tablist">${INV_TABS.map((t) => `<button role="tab" data-action="map-inv-tab" data-tab="${t}" aria-selected="${String(ui.invTab === t)}">${esc(q.tabs[t](counts[t]))}</button>`).join('')}</div>`;
  const list = (items: string[]): string =>
    items.length ? `<ul class="st-list">${items.join('')}</ul>` : `<p class="mu small">${esc(q.none)}</p>`;
  let body = '';
  if (ui.invTab === 'breaks')
    body = list(
      inv.breaks.map(
        (b) =>
          `<li class="inv-bk"><b>${esc(b.code)}</b> · ${breakable(name(b.at))}${explore(b.at)}<br>${esc(b.message)}${b.hints.length ? `<br><small class="mu">${esc(q.hints)} : ${b.hints.map((x) => esc(x)).join(' · ')}</small>` : ''}${b.resolutions.length ? `<br><small>${esc(q.resolutions)} : ${b.resolutions.map((x) => esc(x)).join(' · ')}</small>` : ''}</li>`,
      ),
    );
  else if (ui.invTab === 'hypotheses')
    body = list(
      inv.hypotheses.map(
        (x) =>
          `<li><span class="st-type inv-h h-${x.status.toLowerCase()}">${esc(q.hypothesis[x.status])}</span> ${esc(x.claim)}${x.candidates.length ? `<br><small>${esc(q.candidates)} : ${x.candidates.map((c) => esc(name(c))).join(', ')}</small>` : ''}${x.evidence.length ? `<br><small class="mu">${x.evidence.map((e) => esc(e)).join(' · ')}</small>` : ''}</li>`,
      ),
    );
  else if (ui.invTab === 'frontier')
    body = list(
      inv.frontier.map(
        (f) =>
          `<li>${breakable(name(f.node))} <small class="mu">${esc(q.reasons[f.reason] ?? f.reason)} · ${esc(q.pending(f.pending))} · ${esc(m.st.dirs[f.direction] ?? f.direction)}</small>${explore(f.node)}</li>`,
      ),
    );
  else if (ui.invTab === 'attempts')
    body = list(
      inv.attempts.map(
        (a) =>
          `<li><b>${esc(q.strategies[a.strategy] ?? a.strategy)}</b> · ${breakable(name(a.at))} → <span class="st-type">${esc(q.outcomes[a.outcome])}</span><br><small class="mu">${esc(a.detail)}</small></li>`,
      ),
    );
  else if (ui.invTab === 'cycles')
    body = list(
      inv.cycles.map(
        (c) =>
          `<li><b>${esc(q.cycleNatures[c.nature])}</b> : ${c.nodes.map((x) => esc(name(x))).join(' ⇄ ')}${c.exits.length ? `<br><small>${esc(q.exits)} : ${c.exits.map((x) => esc(name(x))).join(', ')}</small>` : ''}</li>`,
      ),
    );
  else body = list(inv.limitations.map((l) => `<li>${esc(l)}</li>`));
  return `<section class="st-bottom inv-bottom">${tabs}<div class="inv-bbody">${body}</div></section>`;
}

/** Les objectifs proposés selon l'élément : un bouton vers l'aval, une table vers l'amont. */
export function defaultGoal(kind: string | undefined): { goal: InvestigationGoal; direction: 'UP' | 'DOWN' } {
  if (kind === 'ENTITY' || kind === 'COLUMN' || kind === 'API')
    return { goal: 'ENTRY_POINTS', direction: 'UP' };
  if (kind === 'CONTAINER' || kind === 'CONDITION') return { goal: 'CONDITIONS', direction: 'UP' };
  return { goal: 'JOURNEY', direction: 'DOWN' };
}

export const INVESTIGATION_CSS = `
.inv-modal{position:fixed;inset:4vh 3vw;z-index:41;background:var(--qa-color-surface);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:10px;padding:14px 16px;overflow:hidden}
.inv-modal>*{flex:none}.inv-modal>.inv-body{flex:1 1 auto;min-height:180px;overflow:hidden}
.inv-left,.inv-center{overflow:auto;max-height:100%}
.inv-modal.full{inset:0;border-radius:0}
.inv-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.inv-head h2{margin:0 0 4px;font-size:17px}.inv-head p{margin:2px 0}
.inv-gbtns{display:flex;gap:6px}
.inv-controls,.inv-crit{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.inv-field{display:flex;flex-direction:column;gap:2px}.inv-field select{font:inherit;padding:4px 6px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface)}
.inv-crit .chip,.inv-controls .chip{min-height:28px;padding:0 10px;font-size:12px}
.inv-body{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:12px;min-height:0}.inv-body.one{display:block}
@media (max-width:900px){.inv-body{grid-template-columns:minmax(0,1fr)}}
.inv-left,.inv-center{min-width:0;display:flex;flex-direction:column;gap:8px}
.inv-gh{margin:6px 0 2px;font-size:13px}
.inv-paths{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.inv-path{display:flex;flex-direction:column;gap:2px;align-items:flex-start;width:100%;text-align:left;border:1px solid var(--qa-color-border);border-radius:8px;padding:6px 8px;background:var(--qa-color-surface);cursor:pointer;font:inherit;color:inherit;overflow-wrap:anywhere}
.inv-path.sel{box-shadow:inset 0 0 0 2px var(--qa-color-primary,#15803d)}
.inv-ctools{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.inv-ctools h3{margin:0;font-size:14px;display:flex;gap:6px;align-items:center}
.inv-canvas{max-height:360px;overflow:auto;border:1px solid var(--qa-color-border);border-radius:10px}.inv-canvas-in{transform-origin:0 0}
.inv-steps{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.inv-step{overflow-wrap:anywhere}.inv-step.broken{background:#fdecef33}
.inv-rel{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11.5px}
.inv-nat{font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:999px;background:var(--qa-color-surface-2)}.inv-nat.n-causal{color:#15803d}.inv-nat.n-data{color:#2563eb}.inv-nat.n-control{color:#b45309}.inv-nat.n-structure{color:#7c3aed}.inv-nat.n-contract{color:#0e7490}
.inv-node{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.inv-cond{font-size:11px;color:#b45309}
.inv-break{margin:2px 0;color:#be123c}
.inv-why{display:block}
.inv-bottom{max-height:30vh;overflow:auto;margin-top:0}
.inv-state.s-complete{color:#15803d}.inv-state.s-partial{color:#b45309}.inv-state.s-stale{color:#be123c}
.inv-h.h-supported{color:#15803d}.inv-h.h-contradictory{color:#be123c}.inv-h.h-candidate{color:#b45309}
`;
