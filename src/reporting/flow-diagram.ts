import type { FlowRunReport } from '../model/flow-run.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowEdge } from '../model/flow.js';
import { buildFlowTree, displayName, type FlowTreeNode } from './flow-tree.js';
import { esc } from './html-common.js';

/**
 * Diagrammes SVG statiques du rapport (aucun JavaScript, aucune ressource externe) :
 * la carte des flows découverts (boîtes = écrans, flèches = actions, couleur = verdict
 * des oracles) et la chaîne des étapes de chaque flow imposé.
 */

const NODE_WIDTH = 190;
const NODE_HEIGHT = 46;
const COLUMN_GAP = 110;
const ROW_GAP = 26;
const MARGIN = 20;
/** Au-delà, la carte deviendrait illisible : les écrans suivants sont listés dans l'arbre. */
const MAX_NODES = 80;
/** Liens hors de l'arbre (retours, raccourcis) dessinés au plus. */
const MAX_LINKS = 60;

const COLORS = {
  PASS: '#2e7d32',
  FAIL: '#c62828',
  WARNING: '#ef6c00',
  UNKNOWN: '#78909c',
  node: '#f8fafc',
  border: '#94a3b8',
  text: '#1f2937',
  muted: '#64748b',
};

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function edgeColor(edge: FlowEdge | undefined): string {
  if (!edge) return COLORS.UNKNOWN;
  if (edge.result === 'FAILED') return COLORS.FAIL;
  const status = edge.oracle?.status;
  return status === 'FAIL' || status === 'WARNING' || status === 'PASS' ? COLORS[status] : COLORS.UNKNOWN;
}

interface Placed {
  id: string;
  x: number;
  y: number;
}

/** Arbre « rangé » : chaque feuille prend une ligne, un parent se place au milieu de ses enfants. */
function layout(tree: FlowTreeNode): { placed: Map<string, Placed>; width: number; height: number } {
  const placed = new Map<string, Placed>();
  let nextRow = 0;
  let maxDepth = 0;
  const visit = (node: FlowTreeNode, depth: number): number => {
    if (placed.size >= MAX_NODES) return nextRow;
    maxDepth = Math.max(maxDepth, depth);
    const rows = node.children.filter(() => placed.size < MAX_NODES).map((child) => visit(child, depth + 1));
    const row = rows.length > 0 ? ((rows[0] ?? 0) + (rows[rows.length - 1] ?? 0)) / 2 : nextRow++;
    placed.set(node.node.id, {
      id: node.node.id,
      x: MARGIN + depth * (NODE_WIDTH + COLUMN_GAP),
      y: MARGIN + row * (NODE_HEIGHT + ROW_GAP),
    });
    return row;
  };
  visit(tree, 0);
  return {
    placed,
    width: MARGIN * 2 + (maxDepth + 1) * NODE_WIDTH + maxDepth * COLUMN_GAP,
    height: MARGIN * 2 + Math.max(1, nextRow) * (NODE_HEIGHT + ROW_GAP),
  };
}

function arrowHead(id: string, color: string): string {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
}

/** Carte des flows découverts : écrans en colonnes par profondeur, actions sur les flèches. */
export function renderFlowMap(result: ExplorationResult, language: 'en' | 'fr' = 'en'): string {
  const tree = buildFlowTree(result.states, result.transitions, result.states[0]?.id);
  if (!tree || result.states.length === 0) return '';
  const { placed, width, height } = layout(tree);
  const issuesOf = (stateId: string): 'ERROR' | 'WARNING' | undefined => {
    const issues = result.issues.filter((issue) => issue.states.includes(stateId));
    if (issues.some((issue) => issue.severity === 'ERROR' || issue.severity === 'CRITICAL')) return 'ERROR';
    return issues.some((issue) => issue.severity === 'WARNING') ? 'WARNING' : undefined;
  };
  const byId = new Map(result.states.map((state) => [state.id, state]));
  // Le verdict d'une transition : sa dernière exécution entre ces deux écrans.
  const lastEdge = new Map<string, FlowEdge>();
  for (const edge of result.transitions) lastEdge.set(`${edge.from}→${edge.to}`, edge);

  const curve = (from: Placed, to: Placed): string => {
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_HEIGHT / 2;
    if (x2 > x1) {
      const mid = (x1 + x2) / 2;
      return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
    }
    // Retour vers la gauche ou la même colonne : un arc par-dessous.
    const bottom = Math.max(from.y, to.y) + NODE_HEIGHT + ROW_GAP * 0.8;
    return `M${from.x + NODE_WIDTH / 2},${from.y + NODE_HEIGHT} C${from.x + NODE_WIDTH / 2},${bottom} ${to.x + NODE_WIDTH / 2},${bottom} ${to.x + NODE_WIDTH / 2},${to.y + NODE_HEIGHT}`;
  };

  const treeEdges: string[] = [];
  const labels: string[] = [];
  const treeLinks = new Set<string>();
  const walk = (node: FlowTreeNode): void => {
    for (const child of node.children) {
      const from = placed.get(node.node.id);
      const to = placed.get(child.node.id);
      if (from && to) {
        const edge = child.via ? (lastEdge.get(`${child.via.from}→${child.via.to}`) ?? child.via) : undefined;
        const color = edgeColor(edge);
        const marker = `m-${color.slice(1)}`;
        treeLinks.add(`${node.node.id}→${child.node.id}`);
        treeEdges.push(
          `<path d="${curve(from, to)}" fill="none" stroke="${color}" stroke-width="1.8" marker-end="url(#${marker})"/>`,
        );
        const text = child.via
          ? cut(child.via.action.text ?? child.via.action.label ?? child.via.action.type, 22)
          : '';
        if (text) {
          const lx = (from.x + NODE_WIDTH + to.x) / 2;
          const ly = (from.y + to.y) / 2 + NODE_HEIGHT / 2 - 6;
          labels.push(
            `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="11" fill="${COLORS.text}" paint-order="stroke" stroke="#ffffff" stroke-width="4">${esc(text)}</text>`,
          );
        }
      }
      walk(child);
    }
  };
  walk(tree);

  // Les autres transitions réussies entre deux écrans (retours, raccourcis) : en pointillé.
  const links: string[] = [];
  for (const edge of lastEdge.values()) {
    if (links.length >= MAX_LINKS) break;
    if (edge.result !== 'SUCCESS' || edge.from === edge.to || treeLinks.has(`${edge.from}→${edge.to}`))
      continue;
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    links.push(
      `<path d="${curve(from, to)}" fill="none" stroke="${edgeColor(edge)}" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.6"/>`,
    );
  }

  const nodes = [...placed.values()].map((position) => {
    const state = byId.get(position.id);
    if (!state) return '';
    const severity = issuesOf(position.id);
    const stroke =
      severity === 'ERROR' ? COLORS.FAIL : severity === 'WARNING' ? COLORS.WARNING : COLORS.border;
    return `<g><title>${esc(displayName(state))} — ${esc(state.url)}</title>
      <rect x="${position.x}" y="${position.y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="8" fill="${COLORS.node}" stroke="${stroke}" stroke-width="${severity ? 2.2 : 1.2}"/>
      <text x="${position.x + 10}" y="${position.y + 19}" font-size="12.5" font-weight="600" fill="${COLORS.text}">${esc(cut(displayName(state), 26))}</text>
      <text x="${position.x + 10}" y="${position.y + 36}" font-size="10.5" fill="${COLORS.muted}">${esc(cut(state.route, 30))}</text></g>`;
  });

  const markers = [COLORS.PASS, COLORS.FAIL, COLORS.WARNING, COLORS.UNKNOWN]
    .map((color) => arrowHead(`m-${color.slice(1)}`, color))
    .join('');
  const legend =
    language === 'fr'
      ? [
          'Actions : ',
          ['PASS', 'réussie'],
          ['WARNING', 'avertissement'],
          ['FAIL', 'échec'],
          ['UNKNOWN', 'non jugée'],
          ' · bordure rouge/orange : anomalies sur l’écran · pointillés : autres liens',
        ]
      : [
          'Actions: ',
          ['PASS', 'passed'],
          ['WARNING', 'warning'],
          ['FAIL', 'failed'],
          ['UNKNOWN', 'not judged'],
          ' · red/orange border: issues on the screen · dotted: other links',
        ];
  const legendHtml = legend
    .map((part) =>
      typeof part === 'string'
        ? esc(part)
        : `<span style="display:inline-block;width:18px;height:3px;background:${COLORS[part[0] as 'PASS']};vertical-align:middle;margin:0 4px 0 10px"></span>${esc(part[1] ?? '')}`,
    )
    .join('');
  const hidden = result.states.length - placed.size;
  return `<div class="flow-diagram" style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:8px;background:#fff;padding:6px">
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${language === 'fr' ? 'Carte des flows' : 'Flow map'}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
      <defs>${markers}</defs>${links.join('')}${treeEdges.join('')}${nodes.join('')}${labels.join('')}
    </svg></div>
    <p class="muted" style="font-size:12px">${legendHtml}${hidden > 0 ? ` · ${hidden} ${language === 'fr' ? 'écran(s) de plus dans l’arbre ci-dessous' : 'more screen(s) in the tree below'}` : ''}</p>`;
}

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
