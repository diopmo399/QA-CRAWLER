import type { FlowRunReport } from '../model/flow-run.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowEdge } from '../model/flow.js';
import {
  CARD,
  cardRows,
  layoutFlowMap,
  textWidth,
  type LayoutOptions,
  type MapLink,
  type MapScreen,
  type Point,
  type ScreenStatus,
} from './flow-map-layout.js';
import { displayName } from './flow-tree.js';
import { classPill, esc } from './html-common.js';
import { translateReason, valueLabel } from './i18n.js';

/**
 * Diagrammes SVG du rapport (aucune ressource externe) : la carte des écrans visités (cartes = écrans,
 * flèches = transitions exécutées, couleur = verdict des oracles) et la chaîne des étapes de chaque flow
 * imposé. Le fragment de la carte ne contient aucun script : il se lit tel quel (défilement, détails par
 * ancre) ; FLOW_MAP_SCRIPT, inclus par la page, ajoute le zoom, l'ajustement, la sélection et la mise en avant par statut.
 * La géométrie (disposition, routage des flèches) est dans flow-map-layout.ts.
 */

const MARGIN = 20;

const COLORS = {
  PASS: '#2e7d32',
  FAIL: '#c62828',
  WARNING: '#ef6c00',
  UNKNOWN: '#78909c',
  node: 'var(--surface-2, #f8fafc)',
  border: 'var(--border-strong, #94a3b8)',
  text: 'var(--text, #1f2937)',
  muted: 'var(--muted, #64748b)',
};

/** Le statut d'un écran, dans les couleurs du thème du rapport. */
const STATUS_COLOR: Record<ScreenStatus, string> = {
  PASS: 'var(--ok, #16a34a)',
  FAIL: 'var(--red, #dc2626)',
  WARNING: 'var(--warn, #f59e0b)',
  UNKNOWN: 'var(--muted, #64748b)',
};

const RESULT_COLOR: Record<string, string> = {
  SUCCESS: STATUS_COLOR.PASS,
  FAILED: STATUS_COLOR.FAIL,
  BLOCKED: STATUS_COLOR.WARNING,
};

const pill = (text: string, color: string): string =>
  `<span class="fm-pill" style="--fm-st:${color}">${esc(text)}</span>`;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function edgeColor(edge: FlowEdge | undefined): string {
  if (!edge) return COLORS.UNKNOWN;
  if (edge.result === 'FAILED') return COLORS.FAIL;
  const status = edge.oracle?.status;
  return status === 'FAIL' || status === 'WARNING' || status === 'PASS' ? COLORS[status] : COLORS.UNKNOWN;
}

function arrowHead(id: string, color: string): string {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
}

const TEXTS = {
  fr: {
    aria: 'Carte des écrans visités',
    tools: 'Commandes de la carte',
    filter: 'Mettre en avant un statut',
    all: 'Tous',
    zoomOut: 'Zoom arrière',
    zoomIn: 'Zoom avant',
    fit: 'Ajuster',
    actual: 'Taille réelle',
    panel: 'Détails de l’écran',
    hint: 'Cliquez un écran pour voir ses actions, ses vérifications et ses anomalies ; faites glisser le fond pour vous déplacer.',
    status: { PASS: 'Validé', FAIL: 'Échec', WARNING: 'Avertissement', UNKNOWN: 'Non jugé' } as Record<
      ScreenStatus,
      string
    >,
    why: {
      PASS: 'au moins une vérification réussie à l’arrivée, aucune anomalie',
      FAIL: 'anomalie bloquante ou vérification en échec à l’arrivée',
      WARNING: 'anomalie ou vérification en avertissement',
      UNKNOWN: 'aucune vérification n’a jugé cet écran',
    } as Record<ScreenStatus, string>,
    counts: (actions: number, checks: number) => `${actions} action(s) · ${checks} vérif.`,
    short: (actions: number, checks: number) => `${actions} act. · ${checks} vérif.`,
    start: 'Écran de départ du parcours.',
    direct: 'Atteint sans transition enregistrée (saut ou rejeu).',
    out: 'Actions depuis cet écran',
    in: 'Arrivées sur cet écran',
    assertions: 'Vérifications à l’arrivée',
    issues: 'Anomalies',
    screenshot: 'Voir la capture d’écran',
    none: 'Aucune',
    close: 'Fermer',
    sameScreen: 'même écran',
    oracle: 'oracles',
    results: { SUCCESS: 'réussie', FAILED: 'échouée', BLOCKED: 'bloquée' } as Record<string, string>,
    verdicts: {
      PASS: 'vérifiée',
      FAIL: 'vérification en échec',
      WARNING: 'avertissement',
      UNKNOWN: 'non jugée',
    } as Record<string, string>,
    legend: [
      'Flèches : ',
      ['PASS', 'vérifiée'],
      ['WARNING', 'avertissement'],
      ['FAIL', 'échec'],
      ['UNKNOWN', 'non jugée'],
      ' · trait plein : premier chemin vers l’écran · tirets : retours et raccourcis · pointillés : atteint sans transition',
    ] as (string | [keyof typeof COLORS, string])[],
    hidden: (count: number) => `${count} écran(s) de plus dans l’arbre ci-dessous`,
  },
  en: {
    aria: 'Map of the visited screens',
    tools: 'Map controls',
    filter: 'Filter by status',
    all: 'All',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    fit: 'Fit',
    actual: 'Actual size',
    panel: 'Screen details',
    hint: 'Click a screen to see its actions, checks and issues; drag the background to move around.',
    status: { PASS: 'Passed', FAIL: 'Failed', WARNING: 'Warning', UNKNOWN: 'Not judged' } as Record<
      ScreenStatus,
      string
    >,
    why: {
      PASS: 'at least one check passed on arrival, no issue',
      FAIL: 'blocking issue or failed check on arrival',
      WARNING: 'issue or check with a warning',
      UNKNOWN: 'no check judged this screen',
    } as Record<ScreenStatus, string>,
    counts: (actions: number, checks: number) => `${actions} action(s) · ${checks} check(s)`,
    short: (actions: number, checks: number) => `${actions} act. · ${checks} chk.`,
    start: 'Start screen of the journey.',
    direct: 'Reached without a recorded transition (jump or replay).',
    out: 'Actions from this screen',
    in: 'Arrivals on this screen',
    assertions: 'Checks on arrival',
    issues: 'Issues',
    screenshot: 'View the screenshot',
    none: 'None',
    close: 'Close',
    sameScreen: 'same screen',
    oracle: 'oracles',
    results: { SUCCESS: 'succeeded', FAILED: 'failed', BLOCKED: 'blocked' } as Record<string, string>,
    verdicts: { PASS: 'checked', FAIL: 'check failed', WARNING: 'warning', UNKNOWN: 'not judged' } as Record<
      string,
      string
    >,
    legend: [
      'Arrows: ',
      ['PASS', 'checked'],
      ['WARNING', 'warning'],
      ['FAIL', 'failed'],
      ['UNKNOWN', 'not judged'],
      ' · solid: first path to the screen · dashed: returns and shortcuts · dotted: reached without a transition',
    ] as (string | [keyof typeof COLORS, string])[],
    hidden: (count: number) => `${count} more screen(s) in the tree below`,
  },
};

const round = (value: number): string => String(Math.round(value * 10) / 10);

/** Une polyligne orthogonale aux angles arrondis. */
function pathOf(points: Point[], radius = 8): string {
  const first = points[0];
  if (!first) return '';
  let d = `M${round(first.x)},${round(first.y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1] as Point;
    const corner = points[index] as Point;
    const after = points[index + 1] as Point;
    const lenA = Math.hypot(corner.x - before.x, corner.y - before.y);
    const lenB = Math.hypot(after.x - corner.x, after.y - corner.y);
    const r = Math.min(radius, lenA / 2, lenB / 2);
    const a = {
      x: corner.x + ((before.x - corner.x) / lenA) * r,
      y: corner.y + ((before.y - corner.y) / lenA) * r,
    };
    const b = {
      x: corner.x + ((after.x - corner.x) / lenB) * r,
      y: corner.y + ((after.y - corner.y) / lenB) * r,
    };
    d += ` L${round(a.x)},${round(a.y)} Q${round(corner.x)},${round(corner.y)} ${round(b.x)},${round(b.y)}`;
  }
  const last = points.at(-1) as Point;
  return `${d} L${round(last.x)},${round(last.y)}`;
}

export interface FlowMapOptions extends LayoutOptions {
  /** Lien vers une capture (chemin relatif à la page). */
  href?: (file: string) => string;
}

/** La carte des écrans visités : disposition en couches, flèches orthogonales, détails de chaque écran. */
export function renderFlowMap(
  result: ExplorationResult,
  language: 'en' | 'fr' = 'en',
  options: FlowMapOptions = {},
): string {
  const layout = layoutFlowMap(result, options);
  if (!layout) return '';
  const t = TEXTS[language];
  const href = options.href ?? ((file: string) => file);
  const byId = new Map(result.states.map((state) => [state.id, state]));
  const nameOf = (id: string): string => {
    const state = byId.get(id);
    return state ? displayName(state) : id;
  };
  const indexOf = new Map(layout.screens.map((screen) => [screen.id, screen.index]));

  const markers = [COLORS.PASS, COLORS.FAIL, COLORS.WARNING, COLORS.UNKNOWN]
    .map((color) => arrowHead(`fm-a-${color.slice(1)}`, color))
    .join('');
  const linkSvg = (link: MapLink): string => {
    const color = link.kind === 'direct' ? COLORS.UNKNOWN : edgeColor(link.edge);
    const d = pathOf(link.points);
    const verdict = link.edge
      ? `${t.results[link.edge.result] ?? link.edge.result}${link.edge.oracle ? ` · ${t.verdicts[link.edge.oracle.status] ?? link.edge.oracle.status}` : ''}`
      : t.direct;
    const title = `${nameOf(link.from)} → ${nameOf(link.to)}${link.actions.length > 0 ? ` : ${link.actions.map((text) => `« ${text} »`).join(', ')}` : ''} (${verdict})`;
    const arrow = link.kind === 'direct' ? '' : ` marker-end="url(#fm-a-${color.slice(1)})"`;
    return `<g class="fm-edge fm-${link.kind}" data-from="${String(indexOf.get(link.from))}" data-to="${String(indexOf.get(link.to))}"><title>${esc(title)}</title><path class="fm-hit" d="${d}"/><path class="fm-line" d="${d}" stroke="${color}"${arrow}/></g>`;
  };
  const labelSvg = (link: MapLink): string => {
    const label = link.label;
    if (!label) return '';
    return `<g class="fm-label" data-from="${String(indexOf.get(link.from))}" data-to="${String(indexOf.get(link.to))}"><title>${esc(link.actions.join(' · '))}</title><rect x="${round(label.x)}" y="${round(label.y)}" width="${round(label.width)}" height="${round(label.height)}" rx="10"/><text x="${round(label.x + label.width / 2)}" y="${round(label.y + label.height / 2 + 4)}" text-anchor="middle">${esc(label.text)}</text></g>`;
  };
  const nodeSvg = (screen: MapScreen): string => {
    const rows = cardRows(screen);
    const status = t.status[screen.status];
    const room = screen.width - 2 * CARD.padX - 14 - textWidth(status, CARD.statsSize, { bold: true }) - 10;
    const full = t.counts(screen.actions, screen.assertions);
    const counts =
      textWidth(full, CARD.statsSize) <= room ? full : t.short(screen.actions, screen.assertions);
    const stroke = screen.status === 'FAIL' ? COLORS.FAIL : screen.status === 'WARNING' ? COLORS.WARNING : '';
    const state = byId.get(screen.id);
    return `<a class="fm-node${screen.root ? ' fm-root' : ''}" href="#fm-d-${String(screen.index)}" data-node="${String(screen.index)}" data-status="${screen.status}" aria-label="${esc(`${screen.title} — ${status}`)}"><title>${esc(`${screen.title} — ${state?.url ?? ''}`)}</title>
<rect class="fm-halo" x="${round(screen.x - 4)}" y="${round(screen.y - 4)}" width="${round(screen.width + 8)}" height="${round(screen.height + 8)}" rx="13"/>
<rect class="fm-card" x="${round(screen.x)}" y="${round(screen.y)}" width="${round(screen.width)}" height="${round(screen.height)}" rx="10"${stroke ? ` style="stroke:${stroke};stroke-width:2"` : ''}/>
${screen.titleLines.map((line, index) => `<text class="fm-t" x="${round(screen.x + CARD.padX)}" y="${round(rows.title[index] ?? 0)}">${esc(line)}</text>`).join('')}
${screen.routeLines.map((line, index) => `<text class="fm-r" x="${round(screen.x + CARD.padX)}" y="${round(rows.route[index] ?? 0)}">${esc(line)}</text>`).join('')}
<circle cx="${round(screen.x + CARD.padX + 4)}" cy="${round(rows.stats - 4)}" r="4" fill="${STATUS_COLOR[screen.status]}"/><text class="fm-s" x="${round(screen.x + CARD.padX + 14)}" y="${round(rows.stats)}" fill="${STATUS_COLOR[screen.status]}">${esc(status)}</text><text class="fm-c" x="${round(screen.x + screen.width - CARD.padX)}" y="${round(rows.stats)}" text-anchor="end">${esc(counts)}</text></a>`;
  };

  // Les détails de chaque écran : ce que l'exécution a vraiment fait et constaté.
  const transitionItem = (edge: FlowEdge, towards: 'out' | 'in'): string => {
    const other = towards === 'out' ? edge.to : edge.from;
    const where =
      edge.from === edge.to
        ? `<span class="muted">${esc(t.sameScreen)}</span>`
        : `<b>${esc(nameOf(other))}</b>`;
    const action = `${esc(valueLabel(language, edge.action.type))} « ${esc(edge.action.text ?? edge.action.label ?? '')} »`;
    return `<li>${towards === 'out' ? `${action} → ${where}` : `${where} → ${action}`} ${pill(t.results[edge.result] ?? edge.result, RESULT_COLOR[edge.result] ?? STATUS_COLOR.UNKNOWN)}${edge.oracle ? ` ${pill(t.verdicts[edge.oracle.status] ?? edge.oracle.status, STATUS_COLOR[edge.oracle.status])}` : ''}${edge.reason ? ` <span class="muted">${esc(translateReason(language, edge.reason))}</span>` : ''}</li>`;
  };
  const list = (items: string[]): string =>
    items.length > 0 ? `<ul>${items.join('')}</ul>` : `<p class="muted">${esc(t.none)}</p>`;
  const details = layout.screens
    .map((screen) => {
      const state = byId.get(screen.id);
      const outgoing = result.transitions.filter((edge) => edge.from === screen.id);
      const incoming = result.transitions.filter((edge) => edge.to === screen.id && edge.from !== screen.id);
      const assertions = [
        ...new Set(
          incoming
            .filter((edge) => edge.result === 'SUCCESS')
            .flatMap((edge) => edge.oracle?.assertions ?? []),
        ),
      ];
      const issues = result.issues.filter((issue) => issue.states.includes(screen.id));
      return `<section class="fm-detail" id="fm-d-${String(screen.index)}" data-node="${String(screen.index)}" tabindex="-1">
<div class="fm-dh"><h3>${esc(screen.title)}</h3><a class="fm-close" href="#fm-top" data-fm="close" aria-label="${esc(t.close)}">×</a></div>
<p class="fm-url"><code>${esc(state?.url ?? screen.id)}</code></p>
<p>${pill(t.status[screen.status], STATUS_COLOR[screen.status])} <span class="muted">${esc(t.why[screen.status])}</span></p>
${screen.root ? `<p class="muted">${esc(t.start)}</p>` : ''}${screen.direct ? `<p class="muted">${esc(t.direct)}</p>` : ''}
<h4>${esc(t.out)} (${String(outgoing.length)})</h4>${list(outgoing.map((edge) => transitionItem(edge, 'out')))}
<h4>${esc(t.in)} (${String(incoming.length)})</h4>${list(incoming.map((edge) => transitionItem(edge, 'in')))}
<h4>${esc(t.assertions)} (${String(assertions.length)})</h4>${list(assertions.map((text) => `<li>${esc(text)}</li>`))}
<h4>${esc(t.issues)} (${String(issues.length)})</h4>${list(issues.map((issue) => `<li>${classPill(issue.severity, language)} ${esc(issue.message || issue.type)}</li>`))}
${state?.screenshot ? `<p><a href="${esc(href(state.screenshot))}">${esc(t.screenshot)}</a></p>` : ''}</section>`;
    })
    .join('');

  const counts: Record<ScreenStatus, number> = { PASS: 0, FAIL: 0, WARNING: 0, UNKNOWN: 0 };
  for (const screen of layout.screens) counts[screen.status] += 1;
  const filters = [
    `<button type="button" class="fm-btn" data-fm-filter="ALL" aria-pressed="true">${esc(t.all)} (${String(layout.screens.length)})</button>`,
    ...(['FAIL', 'WARNING', 'PASS', 'UNKNOWN'] as const)
      .filter((status) => counts[status] > 0)
      .map(
        (status) =>
          `<button type="button" class="fm-btn" data-fm-filter="${status}" aria-pressed="false"><i style="background:${STATUS_COLOR[status]}"></i>${esc(t.status[status])} (${String(counts[status])})</button>`,
      ),
  ].join('');
  const tools = `<div class="fm-tools" role="toolbar" aria-label="${esc(t.tools)}"><div class="fm-group" role="group" aria-label="${esc(t.filter)}">${filters}</div><div class="fm-group"><button type="button" class="fm-btn" data-fm="out" aria-label="${esc(t.zoomOut)}" title="${esc(t.zoomOut)}">−</button><output class="fm-scale">100 %</output><button type="button" class="fm-btn" data-fm="in" aria-label="${esc(t.zoomIn)}" title="${esc(t.zoomIn)}">+</button><button type="button" class="fm-btn" data-fm="fit" aria-pressed="false">${esc(t.fit)}</button><button type="button" class="fm-btn" data-fm="reset">${esc(t.actual)}</button></div></div>`;
  const legend = t.legend
    .map((part) =>
      typeof part === 'string'
        ? esc(part)
        : `<span class="fm-key" style="background:${COLORS[part[0]]}"></span>${esc(part[1])}`,
    )
    .join('');
  const links = layout.links.filter((link) => link.kind !== 'tree');
  const tree = layout.links.filter((link) => link.kind === 'tree');
  return `<div class="fm" id="fm-top" data-filter="ALL" data-orientation="${layout.orientation}">
<style>${FLOW_MAP_CSS}</style>
${tools}
<div class="fm-body"><div class="fm-view" tabindex="0" aria-label="${esc(t.aria)}">
<svg xmlns="http://www.w3.org/2000/svg" width="${String(layout.width)}" height="${String(layout.height)}" viewBox="0 0 ${String(layout.width)} ${String(layout.height)}" role="img" aria-label="${esc(t.aria)}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<defs>${markers}</defs><g class="fm-edges">${links.map(linkSvg).join('')}${tree.map(linkSvg).join('')}</g><g class="fm-nodes">${layout.screens.map(nodeSvg).join('')}</g><g class="fm-labels">${layout.links.map(labelSvg).join('')}</g>
</svg></div>
<aside class="fm-panel" aria-label="${esc(t.panel)}" aria-live="polite">${details}</aside></div>
<p class="fm-legend muted">${legend}${layout.hidden > 0 ? ` · ${esc(t.hidden(layout.hidden))}` : ''}</p>
<p class="fm-hint muted">${esc(t.hint)}</p>
</div>`;
}

const FLOW_MAP_CSS = `
.fm{--fm-accent:var(--accent,#4f46e5);display:flex;flex-direction:column;gap:10px;margin:10px 0 16px}
.fm-tools{display:none;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}
.fm.fm-js .fm-tools{display:flex}
.fm-group{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.fm-btn{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 12px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--surface,#fff);color:var(--text-2,#374151);font:inherit;font-size:13px;cursor:pointer}
.fm-btn:hover{border-color:var(--fm-accent)}
.fm-btn[aria-pressed="true"]{background:var(--accent-soft,#eef2ff);border-color:var(--fm-accent);color:var(--accent-ink,#4338ca)}
.fm-btn i{width:9px;height:9px;border-radius:50%;display:inline-block}
.fm-scale{min-width:52px;text-align:center;font-size:12px;color:var(--muted,#64748b);font-variant-numeric:tabular-nums}
.fm-body{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
.fm-view{position:relative;overflow:auto;max-height:min(78vh,920px);min-height:120px;border:1px solid var(--border,#e2e8f0);border-radius:12px;background-color:var(--surface-2,#f8fafc);background-image:radial-gradient(var(--border,#e2e8f0) 1px,transparent 1px);background-size:22px 22px;overscroll-behavior:contain}
.fm.fm-js .fm-view{cursor:grab}
.fm-view.fm-drag{cursor:grabbing;user-select:none}
.fm-view:focus-visible{outline:2px solid var(--fm-accent);outline-offset:2px}
.fm-view svg{display:block;max-width:none}
.fm-card{fill:var(--surface,#fff);stroke:var(--border-strong,#cbd5e1);stroke-width:1.2}
.fm-root .fm-card{stroke:var(--fm-accent);stroke-width:1.6}
.fm-halo{display:none;fill:none;stroke:var(--fm-accent);stroke-width:2.5}
.fm-node{cursor:pointer;outline:none}
.fm-node:hover .fm-card{stroke:var(--fm-accent)}
.fm-node:focus-visible .fm-halo,.fm-node.sel .fm-halo{display:inline}
.fm-t{font-size:13px;font-weight:600;fill:var(--text,#111827)}
.fm-r{font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;fill:var(--muted,#64748b)}
.fm-s{font-size:11px;font-weight:600}
.fm-c{font-size:11px;fill:var(--muted,#64748b)}
.fm-line{fill:none;stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
.fm-link .fm-line{stroke-width:1.4;stroke-dasharray:6 5}
.fm-direct .fm-line{stroke-width:1.2;stroke-dasharray:2 4}
.fm-hit{fill:none;stroke:transparent;stroke-width:10}
.fm-edge:hover .fm-line,.fm-edge.fm-on .fm-line{stroke-width:2.8}
.fm-label rect{fill:var(--surface,#fff);stroke:var(--border,#e2e8f0)}
.fm-label text{font-size:11px;fill:var(--text-2,#374151)}
.fm .fm-dim{opacity:.16}
.fm-panel{display:none;min-width:0;max-height:min(78vh,920px);overflow:auto;padding:14px 16px;border:1px solid var(--border,#e2e8f0);border-radius:12px;background:var(--surface,#fff);font-size:13px}
.fm-panel:has(.fm-detail:target),.fm.fm-sel .fm-panel{display:block}
.fm-detail{display:none}
.fm-detail:target,.fm-detail.on{display:block}
.fm.fm-js .fm-detail:target:not(.on){display:none}
.fm-dh{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}
.fm-detail h3{margin:0;font-size:15px;line-height:1.35;overflow-wrap:anywhere}
.fm-detail h4{margin:14px 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#64748b)}
.fm-detail ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px}
.fm-detail p{margin:6px 0}
.fm-url code{overflow-wrap:anywhere;font-size:12px}
.fm-close{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;color:var(--muted,#64748b);text-decoration:none;font-size:18px}
.fm-close:hover{background:var(--surface-2,#f1f5f9)}
.fm-pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;color:var(--fm-st);border:1px solid var(--fm-st)}
.fm-legend,.fm-hint{margin:0;font-size:12px}
.fm-key{display:inline-block;width:18px;height:3px;vertical-align:middle;margin:0 4px 0 10px}
@media (min-width:1100px){.fm.fm-sel .fm-body,.fm-body:has(.fm-detail:target){grid-template-columns:minmax(0,1fr) 340px}}
`;

/**
 * Le comportement de la carte, inclus une fois par la page : zoom, ajustement à la fenêtre (refait quand le
 * cadre change de taille), déplacement à la souris, sélection d'un écran et de ses transitions, mise en avant par
 * statut. La disposition n'est jamais recalculée : seule l'échelle du SVG change.
 */
export const FLOW_MAP_SCRIPT = `<script>
(function () {
  document.querySelectorAll('.fm').forEach(function (root) {
    var view = root.querySelector('.fm-view');
    var svg = view && view.querySelector('svg');
    if (!svg) return;
    root.classList.add('fm-js');
    var width = Number(svg.getAttribute('width'));
    var height = Number(svg.getAttribute('height'));
    var scale = 1;
    var mode = 'fit';
    var output = root.querySelector('.fm-scale');
    var fitButton = root.querySelector('[data-fm="fit"]');
    function apply(next, keepCenter) {
      var cx = (view.scrollLeft + view.clientWidth / 2) / scale;
      var cy = (view.scrollTop + view.clientHeight / 2) / scale;
      scale = Math.max(0.2, Math.min(2.5, next));
      svg.style.width = Math.round(width * scale) + 'px';
      svg.style.height = Math.round(height * scale) + 'px';
      if (output) output.textContent = Math.round(scale * 100) + ' %';
      if (fitButton) fitButton.setAttribute('aria-pressed', String(mode === 'fit'));
      root.setAttribute('data-mode', mode);
      root.setAttribute('data-scale', String(Math.round(scale * 100)));
      if (keepCenter) {
        view.scrollLeft = cx * scale - view.clientWidth / 2;
        view.scrollTop = cy * scale - view.clientHeight / 2;
      }
    }
    function fitScale() {
      var limit = parseFloat(getComputedStyle(view).maxHeight) || view.clientHeight;
      return Math.min(1, (view.clientWidth - 2) / width, (limit - 2) / height);
    }
    function fit() {
      mode = 'fit';
      apply(fitScale(), false);
    }
    if (fitScale() >= 0.6) fit();
    else {
      // Trop grande pour être ajustée lisiblement : taille réelle, l'écran de départ au centre du cadre.
      mode = 'free';
      apply(1, false);
      var start = root.querySelector('.fm-root .fm-card');
      if (start) {
        var box = start.getBBox();
        view.scrollLeft = Math.max(0, box.x - 24);
        view.scrollTop = Math.max(0, box.y + box.height / 2 - view.clientHeight / 2);
      }
    }
    var lastWidth = view.clientWidth;
    function resized() {
      if (view.clientWidth === lastWidth) return;
      lastWidth = view.clientWidth;
      if (mode === 'fit') fit();
    }
    if (window.ResizeObserver) new ResizeObserver(resized).observe(view);
    else window.addEventListener('resize', resized);

    var nodes = root.querySelectorAll('.fm-node');
    var edges = root.querySelectorAll('.fm-edge, .fm-label');
    function select(index) {
      root.querySelectorAll('.fm-node.sel, .fm-detail.on').forEach(function (el) { el.classList.remove('sel', 'on'); });
      edges.forEach(function (el) { el.classList.remove('fm-on'); });
      if (index === null) {
        root.classList.remove('fm-sel');
        return;
      }
      var node = root.querySelector('.fm-node[data-node="' + index + '"]');
      var detail = root.querySelector('.fm-detail[data-node="' + index + '"]');
      if (!node || !detail) return;
      node.classList.add('sel');
      detail.classList.add('on');
      // Le panneau prend sa place sans rapetisser la carte : l'échelle reste, l'écran choisi reste visible.
      if (mode === 'fit') mode = 'free';
      root.classList.add('fm-sel');
      requestAnimationFrame(function () {
        var box = node.getBoundingClientRect();
        var frame = view.getBoundingClientRect();
        if (box.left < frame.left || box.right > frame.right) view.scrollLeft += box.left - frame.left - (frame.width - box.width) / 2;
        if (box.top < frame.top || box.bottom > frame.bottom) view.scrollTop += box.top - frame.top - (frame.height - box.height) / 2;
      });
      edges.forEach(function (el) {
        if (el.getAttribute('data-from') === index || el.getAttribute('data-to') === index) el.classList.add('fm-on');
      });
      if (window.innerWidth < 1100) detail.scrollIntoView({ block: 'nearest' });
    }
    function filter(status) {
      root.setAttribute('data-filter', status);
      root.querySelectorAll('[data-fm-filter]').forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-fm-filter') === status));
      });
      var shown = {};
      nodes.forEach(function (node) {
        var on = status === 'ALL' || node.getAttribute('data-status') === status;
        node.classList.toggle('fm-dim', !on);
        if (on) shown[node.getAttribute('data-node')] = true;
      });
      edges.forEach(function (el) {
        el.classList.toggle('fm-dim', !(shown[el.getAttribute('data-from')] || shown[el.getAttribute('data-to')]));
      });
    }
    root.addEventListener('click', function (event) {
      var target = event.target;
      var node = target.closest && target.closest('.fm-node');
      if (node) {
        event.preventDefault();
        select(node.getAttribute('data-node'));
        return;
      }
      var control = target.closest && target.closest('[data-fm], [data-fm-filter]');
      if (!control) return;
      event.preventDefault();
      var action = control.getAttribute('data-fm');
      if (control.hasAttribute('data-fm-filter')) filter(control.getAttribute('data-fm-filter'));
      else if (action === 'close') select(null);
      else if (action === 'fit') fit();
      else {
        mode = 'free';
        apply(action === 'in' ? scale * 1.25 : action === 'out' ? scale / 1.25 : 1, true);
      }
    });
    root.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') select(null);
    });
    var drag = null;
    view.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || (event.target.closest && event.target.closest('.fm-node'))) return;
      drag = { x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop, id: event.pointerId };
    });
    view.addEventListener('pointermove', function (event) {
      if (!drag || drag.id !== event.pointerId) return;
      if (!view.classList.contains('fm-drag')) {
        if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) < 4) return;
        view.classList.add('fm-drag');
        view.setPointerCapture(event.pointerId);
      }
      view.scrollLeft = drag.left - (event.clientX - drag.x);
      view.scrollTop = drag.top - (event.clientY - drag.y);
    });
    function endDrag() {
      drag = null;
      view.classList.remove('fm-drag');
    }
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    var match = /^#fm-d-(\\d+)$/.exec(location.hash);
    if (match) select(match[1]);
  });
})();
</script>`;

const STEP_COLORS: Record<string, string> = {
  PASSED: COLORS.PASS,
  FAILED: COLORS.FAIL,
  BLOCKED: COLORS.WARNING,
  SKIPPED: COLORS.UNKNOWN,
  MANUAL: COLORS.WARNING,
};
const STEP_WIDTH = 170;
const STEP_HEIGHT = 50;
const STEP_GAP = 34;
const STEPS_PER_ROW = 5;

/** Chaîne des étapes d'un flow imposé, en lignes de 5, colorées par statut. */
export function renderFlowSteps(flow: FlowRunReport): string {
  if (flow.steps.length === 0) return '';
  const rows = Math.ceil(flow.steps.length / STEPS_PER_ROW);
  const width = MARGIN * 2 + STEPS_PER_ROW * STEP_WIDTH + (STEPS_PER_ROW - 1) * STEP_GAP;
  const height = MARGIN * 2 + rows * STEP_HEIGHT + (rows - 1) * STEP_GAP;
  const boxes = flow.steps.map((step, index) => {
    const column = index % STEPS_PER_ROW;
    const row = Math.floor(index / STEPS_PER_ROW);
    const x = MARGIN + column * (STEP_WIDTH + STEP_GAP);
    const y = MARGIN + row * (STEP_HEIGHT + STEP_GAP);
    const color = STEP_COLORS[step.status] ?? COLORS.UNKNOWN;
    const next =
      index < flow.steps.length - 1
        ? column < STEPS_PER_ROW - 1
          ? `<path d="M${x + STEP_WIDTH},${y + STEP_HEIGHT / 2} L${x + STEP_WIDTH + STEP_GAP - 2},${y + STEP_HEIGHT / 2}" stroke="${COLORS.border}" stroke-width="1.6" marker-end="url(#s-arrow)"/>`
          : `<path d="M${x + STEP_WIDTH / 2},${y + STEP_HEIGHT} C${x + STEP_WIDTH / 2},${y + STEP_HEIGHT + STEP_GAP / 2} ${MARGIN + STEP_WIDTH / 2},${y + STEP_HEIGHT + STEP_GAP / 2} ${MARGIN + STEP_WIDTH / 2},${y + STEP_HEIGHT + STEP_GAP - 2}" fill="none" stroke="${COLORS.border}" stroke-width="1.6" marker-end="url(#s-arrow)"/>`
        : '';
    return `<g><title>${esc(`${step.index}. ${step.description} — ${step.status}${step.reason ? ` (${step.reason})` : ''}`)}</title>
      <rect x="${x}" y="${y}" width="${STEP_WIDTH}" height="${STEP_HEIGHT}" rx="8" fill="${COLORS.node}" stroke="${color}" stroke-width="2"/>
      <rect x="${x}" y="${y}" width="6" height="${STEP_HEIGHT}" rx="3" fill="${color}"/>
      <text x="${x + 14}" y="${y + 20}" font-size="11" font-weight="600" fill="${color}">${step.index}. ${esc(step.status)}</text>
      <text x="${x + 14}" y="${y + 37}" font-size="11" fill="${COLORS.text}">${esc(cut(step.description, 26))}</text></g>${next}`;
  });
  return `<div class="flow-diagram" style="overflow-x:auto;margin:6px 0 10px">
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(flow.name)}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
      <defs>${arrowHead('s-arrow', COLORS.border)}</defs>${boxes.join('')}
    </svg></div>`;
}
