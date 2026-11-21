import type { FieldSheet, MapConfidence, MapLayer, MapNode } from '../core/cartography.js';
import { MAP_LAYERS } from '../core/cartography.js';
import { type ArrowRole, arrowMarkers, arrowSvg, orthPath } from './dashboard-cartography-arrows.js';
import type { MapStrings } from './dashboard-cartography-i18n.js';
import { esc } from './view.js';

/**
 * « Champs & Réutilisations » en diagrammes Archify. Pour le concept choisi : le parcours de la donnée, une
 * région par couche (Front, BFF, Backend, API, base de données), un nœud par champ du concept dans son
 * conteneur (composant, DTO, entité), une flèche par lien justifié (transmet, transforme, écrit…) ; puis sa
 * réutilisation, le concept relié à chaque fonctionnalité qui l'emploie ; enfin ses homonymes, montrés à part
 * et sans flèche : un même nom ne fait pas un lien. Tout vient de la fiche renvoyée par le serveur, rien n'est
 * ajouté.
 */

/** Un nœud mis en page. `attrs` : ce qui rend le nœud cliquable (action et données), déjà échappé. */
interface CfNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: string;
  title: string;
  sub: string;
  cls?: string;
  attrs: string;
  tip: string;
}

interface CfEdge {
  from: string;
  to: string;
  role: ArrowRole;
  label?: string;
  sides: 'rl' | 'bt' | 'rr';
  c?: number;
}

interface CfRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

const LAYER_TONE: Record<string, string> = {
  FRONTEND: 'fe',
  BFF: 'bff',
  BACKEND: 'be',
  API: 'ext',
  DATABASE: 'db',
  EVENTS: 'bus',
};

/** La classe de flèche d'un lien : démontré (vert, comète), probable (tirets), non démontré (pointillés). */
const roleOf = (c: MapConfidence | 'VALIDATED'): ArrowRole =>
  c === 'CONFIRMED' || c === 'VALIDATED' ? 'emphasis' : c === 'PROBABLE' ? 'dashed' : 'gap';

/**
 * Le rendu d'un diagramme : régions, flèches à angle droit (comète sur le démontré), étiquettes sur fond
 * plein, nœuds. Le nœud mis en avant s'allume avec ses voisins, le reste s'estompe.
 */
function stage(
  prefix: string,
  nodes: readonly CfNode[],
  edges: readonly CfEdge[],
  regions: readonly CfRegion[],
  spot?: string,
): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lit = new Set<CfEdge>();
  const near = new Set<string>();
  const active = spot && byId.has(spot) ? spot : undefined;
  if (active)
    for (const e of edges)
      if (e.from === active || e.to === active) {
        lit.add(e);
        near.add(e.from === active ? e.to : e.from);
      }
  const width = Math.max(0, ...nodes.map((n) => n.x + n.w), ...regions.map((r) => r.x + r.w)) + 16;
  const height = Math.max(0, ...nodes.map((n) => n.y + n.h), ...regions.map((r) => r.y + r.h)) + 16;
  let comet = 0;
  const labels: string[] = [];
  const arrows = edges
    .map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return '';
      const { d, mid } =
        e.sides === 'bt'
          ? orthPath({ x: a.x + a.w / 2, y: a.y + a.h }, { x: b.x + b.w / 2, y: b.y - 1 }, 'v')
          : orthPath(
              { x: a.x + a.w, y: a.y + a.h / 2 },
              { x: e.sides === 'rl' ? b.x - 1 : b.x + b.w + 1, y: b.y + b.h / 2 },
              'h',
              e.c,
            );
      const on = active ? (lit.has(e) ? 'on' : 'off') : undefined;
      if (e.label)
        labels.push(
          `<span class="dg-lb r-${e.role}${on ? ` ${on}` : ''}" style="left:${String(Math.round(mid.x))}px;top:${String(Math.round(mid.y))}px">${esc(e.label)}</span>`,
        );
      return arrowSvg(prefix, {
        d,
        role: e.role,
        ...(on ? { state: on } : {}),
        ...(e.role === 'emphasis' ? { comet: comet++ } : {}),
        data: ` data-from="${esc(e.from)}" data-to="${esc(e.to)}"`,
      });
    })
    .join('');
  const state = (id: string): string =>
    !active ? '' : id === active ? ' sel' : near.has(id) ? ' near' : ' dim';
  const zones = regions
    .map(
      (r) =>
        `<div class="cf-region" style="left:${String(r.x)}px;top:${String(r.y)}px;width:${String(r.w)}px;height:${String(r.h)}px"><span class="ar-rl">${esc(r.label)}</span></div>`,
    )
    .join('');
  const boxes = nodes
    .map(
      (n) =>
        `<button class="dg-n ar-box t-${n.tone}${n.cls ? ` ${n.cls}` : ''}${state(n.id)}" ${n.attrs} data-cf="${esc(n.id)}" style="left:${String(n.x)}px;top:${String(n.y)}px;width:${String(n.w)}px;height:${String(n.h)}px" title="${esc(n.tip)}"><span class="ar-t">${esc(n.title)}</span><span class="ar-s">${esc(n.sub)}</span></button>`,
    )
    .join('');
  return `<div class="ar-scroll"><div class="dg-stage cf-stage" data-cf-stage="${prefix}" data-w="${String(width)}" style="width:${String(width)}px;height:${String(height)}px">${zones}<svg class="dg-links" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" aria-hidden="true" focusable="false">${arrowMarkers(prefix)}${arrows}</svg>${labels.join('')}${boxes}</div></div>`;
}

const W = 168;
const H = 60;
const GX = 96;
const GY = 44;
const PAD = 16;
/** La marge d'une région autour de ses nœuds, et la hauteur de son titre. */
const INSET = 14;
const HEAD = 30;

/** Le nom du conteneur d'un champ : son nœud parent s'il est dans la fiche, sinon le conteneur relevé. */
function container(m: MapStrings, node: MapNode, nodes: ReadonlyMap<string, MapNode>): string {
  const parent = node.parent ? nodes.get(node.parent) : undefined;
  const name = parent?.name ?? (typeof node.detail.container === 'string' ? node.detail.container : '');
  const kind = parent ? (m.cf.containers[parent.kind] ?? '') : '';
  return [kind, name].filter(Boolean).join(' ');
}

/** Le parcours du concept : une région par couche, un nœud par champ, une flèche par lien justifié. */
function flowDiagram(m: MapStrings, sheet: FieldSheet, spot?: string): string {
  const nodes = new Map(sheet.graph.nodes.map((n) => [n.id, n]));
  nodes.set(sheet.node.id, sheet.node);
  const ids = [
    ...new Set(
      [sheet.node.id, ...sheet.sequence.flatMap((e) => [e.from, e.to])].filter((id) => nodes.has(id)),
    ),
  ];
  const rank = (id: string): number => MAP_LAYERS.indexOf(nodes.get(id)?.layer ?? 'OTHER');
  const layers = MAP_LAYERS.filter((l) => ids.some((id) => nodes.get(id)?.layer === l));
  const col = (id: string): number => layers.indexOf(nodes.get(id)?.layer ?? 'OTHER');
  // Mise en place gloutonne le long des liens : un champ prend la rangée de celui d'où il vient (la suivante
  // dans la même couche), ou la première libre au-dessous ; la donnée reste sur sa ligne d'une couche à l'autre.
  const out = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const e of sheet.sequence) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    incoming.add(e.to);
  }
  const taken = layers.map(() => new Set<number>());
  const row = new Map<string, number>();
  const put = (id: string, want: number): void => {
    if (row.has(id) || !nodes.has(id)) return;
    const used = taken[col(id)] ?? new Set<number>();
    let r = want;
    while (used.has(r)) r++;
    used.add(r);
    row.set(id, r);
    for (const next of out.get(id) ?? []) put(next, col(next) === col(id) ? r + 1 : r);
  };
  const roots = [...ids].sort((a, b) => rank(a) - rank(b)).filter((id) => !incoming.has(id));
  for (const id of roots) put(id, 0);
  for (const id of ids) put(id, 0);
  const rows = Math.max(1, ...[...row.values()].map((r) => r + 1));
  const x = (c: number): number => PAD + INSET + c * (W + GX);
  const y = (r: number): number => PAD + HEAD + r * (H + GY);
  const regions: CfRegion[] = layers.map((l, c) => ({
    x: x(c) - INSET,
    y: PAD,
    w: W + 2 * INSET,
    h: HEAD + rows * (H + GY) - GY + INSET,
    label: m.layers[l] ?? l,
  }));
  const cfNodes: CfNode[] = ids.map((id) => {
    const n = nodes.get(id) as MapNode;
    const type = typeof n.detail.type === 'string' ? n.detail.type : '';
    const sub = [container(m, n, nodes), type, n.detail.required === true ? m.cf.required : '']
      .filter(Boolean)
      .join(' · ');
    return {
      id,
      x: x(col(id)),
      y: y(row.get(id) ?? 0),
      w: W,
      h: H,
      tone: LAYER_TONE[n.layer] ?? 'ext',
      title: n.label ?? n.name,
      sub,
      ...(id === sheet.node.id ? { cls: 'cf-own' } : {}),
      attrs: `data-action="map-cf-spot" data-spot="${esc(id)}" aria-pressed="${String(spot === id)}"`,
      tip: `${m.layers[n.layer] ?? n.layer} · ${n.name}${sub ? ` — ${sub}` : ''}`,
    };
  });
  // Les coudes d'un même intervalle sont décalés par source : deux flèches ne partagent pas leur montant.
  const lanes = new Map<string, number>();
  const offset = (gap: number, src: string): number => {
    const key = `${String(gap)}|${src}`;
    let v = lanes.get(key);
    if (v === undefined) {
      v = [...lanes.keys()].filter((k) => k.startsWith(`${String(gap)}|`)).length;
      lanes.set(key, v);
    }
    return (v % 4) * 12;
  };
  const edges: CfEdge[] = sheet.sequence
    .filter((e) => row.has(e.from) && row.has(e.to))
    .map((e) => {
      const ca = col(e.from);
      const cb = col(e.to);
      const role = roleOf(e.confidence);
      const label = m.edgeKinds[e.kind] ?? e.kind;
      if (ca < cb)
        return { from: e.from, to: e.to, role, label, sides: 'rl', c: x(ca) + W + 18 + offset(ca, e.from) };
      if (ca === cb && (row.get(e.to) ?? 0) - (row.get(e.from) ?? 0) === 1)
        return { from: e.from, to: e.to, role, label, sides: 'bt' };
      return { from: e.from, to: e.to, role, sides: 'rr', c: x(ca) + W + 14 + offset(ca, e.from) / 2 };
    });
  return stage('cf-flow', cfNodes, edges, regions, spot);
}

/**
 * La réutilisation : le concept à gauche, une flèche vers chaque fonctionnalité qui l'emploie, de la force du
 * lien démontré ; puis les homonymes, à part et sans flèche.
 */
function reuseDiagram(m: MapStrings, sheet: FieldSheet): string {
  const features = sheet.reuse;
  const fh = 52;
  const gap = 20;
  const total = Math.max(fh, features.length * (fh + gap) - gap);
  const concept: CfNode = {
    id: 'concept',
    x: PAD,
    y: PAD + (total - H) / 2,
    w: W,
    h: H,
    tone: 'db',
    title: sheet.concept.name,
    sub: sheet.concept.layers.map((l) => m.layers[l] ?? l).join(' → '),
    cls: 'cf-concept',
    attrs: 'tabindex="-1"',
    tip: m.cf.concept,
  };
  const fx = PAD + W + 120;
  const nodes: CfNode[] = [
    concept,
    ...features.map((f, k) => ({
      id: f.id,
      x: fx,
      y: PAD + k * (fh + gap),
      w: W + 24,
      h: fh,
      tone: 'fe',
      title: f.name,
      sub: [f.module ? `${m.cf.module} ${f.module}` : '', m.confidence[f.confidence] ?? f.confidence]
        .filter(Boolean)
        .join(' · '),
      attrs: `data-action="map-feature" data-feature="${esc(f.id)}"`,
      tip: f.name,
    })),
  ];
  const edges: CfEdge[] = features.map((f) => ({
    from: 'concept',
    to: f.id,
    role: roleOf(f.confidence),
    label: m.cf.uses,
    sides: 'rl',
    c: PAD + W + 46,
  }));
  return stage('cf-reuse', nodes, edges, []);
}

/** Les homonymes : même nom, aucun lien démontré ; des boîtes en pointillés, sans flèche, cliquables. */
function homonymStrip(m: MapStrings, sheet: FieldSheet): string {
  const list = sheet.concept.homonyms;
  const nodes: CfNode[] = list.map((h, k) => ({
    id: h.id,
    x: PAD + k * (W + 24),
    y: PAD,
    w: W,
    h: 52,
    tone: 'ext',
    cls: 'stop cf-hom',
    title: h.name,
    sub: h.layers.map((l: MapLayer) => m.layers[l] ?? l).join(' → '),
    attrs: `data-action="map-concept" data-concept="${esc(h.id)}"`,
    tip: m.cf.notLinked,
  }));
  return stage('cf-hom', nodes, [], []);
}

/** La légende des flèches employées et des couches présentes. */
function legend(m: MapStrings, sheet: FieldSheet): string {
  const sw = (cls: string, label: string): string =>
    `<span><i class="ar-sw ${cls}" aria-hidden="true"></i>${esc(label)}</span>`;
  const layers = MAP_LAYERS.filter((l) => sheet.concept.layers.includes(l))
    .map((l) => sw(`t-${LAYER_TONE[l] ?? 'ext'}`, m.layers[l] ?? l))
    .join('');
  const roles = new Set(sheet.sequence.map((e) => roleOf(e.confidence)));
  for (const f of sheet.reuse) roles.add(roleOf(f.confidence));
  const lines = (
    [
      ['emphasis', m.cf.legend.demonstrated],
      ['dashed', m.cf.legend.probable],
      ['gap', m.cf.legend.gap],
    ] as const
  )
    .filter(([r]) => roles.has(r))
    .map(([r, label]) => sw(`ln r-${r}`, label))
    .join('');
  return `<div class="ar-legend" aria-label="${esc(m.cf.legend.title)}">${layers}${lines}</div>`;
}

/** Les diagrammes de la fiche d'un concept : parcours, réutilisation, homonymes. */
export function conceptDiagrams(m: MapStrings, sheet: FieldSheet, spot?: string): string {
  const head = `<div class="ar-head"><span class="ar-pulse" aria-hidden="true"></span><p>${esc(m.cf.hint)}</p><button class="btn small" data-action="map-cf-spot" data-spot=""${spot ? '' : ' disabled'}>${esc(m.cf.showAll)}</button></div>`;
  const reuse = sheet.reuse.length
    ? `<h3>${esc(m.cf.reuseTitle(sheet.reuse.length))}</h3>${reuseDiagram(m, sheet)}`
    : `<h3>${esc(m.cf.reuseTitle(0))}</h3><p class="mu small">${esc(m.cf.noReuse)}</p>`;
  const homonyms = sheet.concept.homonyms.length
    ? `<h3>${esc(m.homonyms)}</h3>${homonymStrip(m, sheet)}`
    : '';
  return `<div class="ar cf" data-cf>${head}<h3>${esc(m.cf.flowTitle)}</h3>${flowDiagram(m, sheet, spot)}${legend(m, sheet)}${reuse}${homonyms}</div>`;
}

export const CONCEPT_CSS = `
.ar.cf{border:0;padding:0;gap:10px;background:none}
.ar.cf h3{margin:6px 0 0;font-size:12.5px}
.cf-region{position:absolute;box-sizing:border-box;border:1.5px dashed #d97706;border-radius:8px;background:rgba(251,191,36,.05)}
.cf-region .ar-rl{top:7px;left:10px}
.ar-box.cf-own{box-shadow:0 0 0 3px var(--glow)}
.ar-box.cf-concept{cursor:default;border-width:2px}.ar-box.cf-concept:hover{transform:none;box-shadow:none}
.cf-stage{min-width:0}
`;
