import type { FlowStudioView, StudioStep } from '../core/contracts.js';

/**
 * LA DISPOSITION DU FLOW STUDIO, sans DOM : chaque suite d'étapes contiguës d'un même groupe forme une
 * colonne (le groupe est un cadre, les étapes de petites cartes), les étapes hors groupe forment leurs
 * propres colonnes, sans cadre. Une colonne trop haute se replie en plusieurs sous-colonnes : le graphe
 * s'étend en largeur, qu'on parcourt en déplaçant la vue. Un groupe replié ne montre qu'une carte de
 * résumé. Les positions déplacées à la main sont un réglage d'affichage, jamais un ordre d'exécution.
 */
export const NODE_WIDTH = 216;
export const NODE_HEIGHT = 34;
const ROW_GAP = 10;
const COLUMN_GAP = 64;
const SUB_GAP = 18;
const PAD = 14;
const HEADER = 40;
const MARGIN = 32;
export const MAX_ROWS = 10;

export interface Offset {
  dx: number;
  dy: number;
}

export interface LaidStep {
  id: string;
  step: StudioStep;
  x: number;
  y: number;
}

/** Une carte qui remplace les étapes d'un groupe replié. */
export interface LaidSummary {
  id: string;
  groupId: string;
  count: number;
  stepIds: string[];
  x: number;
  y: number;
}

export interface LaidGroup {
  /** L'identifiant du cadre (`groupId`, suivi de `~2`… si le groupe est coupé en plusieurs suites). */
  key: string;
  groupId: string;
  name: string;
  collapsed: boolean;
  continued: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidEdge {
  from: string;
  to: string;
  kind: 'sequence' | 'data' | 'violation';
  key?: string;
  path: string;
  /** Le milieu du trait (où poser le nom de la donnée). */
  mid: { x: number; y: number };
}

export interface StudioLayout {
  steps: LaidStep[];
  summaries: LaidSummary[];
  groups: LaidGroup[];
  edges: LaidEdge[];
  width: number;
  height: number;
  /** La carte qui montre une étape (elle-même, ou le résumé de son groupe replié). */
  nodeOf: Record<string, string>;
}

interface Segment {
  groupId?: string;
  steps: StudioStep[];
}

function segments(steps: StudioStep[]): Segment[] {
  const result: Segment[] = [];
  for (const step of steps) {
    const last = result.at(-1);
    if (last && last.groupId === step.groupId) last.steps.push(step);
    else result.push({ ...(step.groupId ? { groupId: step.groupId } : {}), steps: [step] });
  }
  return result;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

const right = (x: number, y: number): [number, number] => [x + NODE_WIDTH, y + NODE_HEIGHT / 2];
const left = (x: number, y: number): [number, number] => [x, y + NODE_HEIGHT / 2];

function curve(from: [number, number], to: [number, number], lift = 0): string {
  const [x1, y1] = from;
  const [x2, y2] = to;
  if (Math.abs(x1 - x2) < 1) return `M${x1} ${y1}L${x2} ${y2}`;
  const bend = Math.max(36, Math.abs(x2 - x1) / 2);
  return `M${x1} ${y1}C${x1 + bend} ${y1 - lift} ${x2 - bend} ${y2 - lift} ${x2} ${y2}`;
}

function middle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  lift: number,
): { x: number; y: number } {
  return { x: (a.x + NODE_WIDTH + b.x) / 2, y: (a.y + b.y + NODE_HEIGHT) / 2 - lift * 0.75 };
}

export function layoutStudio(
  view: Pick<FlowStudioView, 'steps' | 'groups' | 'dependencies' | 'violations'>,
  options: { collapsed?: Record<string, boolean>; offsets?: Record<string, Offset>; maxRows?: number } = {},
): StudioLayout {
  const maxRows = Math.max(1, options.maxRows ?? MAX_ROWS);
  const offsets = options.offsets ?? {};
  const groupById = new Map(view.groups.map((group) => [group.id, group]));
  const isCollapsed = (groupId: string): boolean =>
    options.collapsed?.[groupId] ?? groupById.get(groupId)?.collapsed ?? false;
  const laidSteps: LaidStep[] = [];
  const summaries: LaidSummary[] = [];
  const groups: LaidGroup[] = [];
  const nodeOf: Record<string, string> = {};
  const seen = new Map<string, number>();
  let x = MARGIN;
  let height = 0;
  for (const segment of segments(view.steps)) {
    const group = segment.groupId ? groupById.get(segment.groupId) : undefined;
    const top = MARGIN + (group ? HEADER : 0);
    const inner = group ? PAD : 0;
    let width: number;
    let bottom: number;
    let key = '';
    if (group) {
      const count = (seen.get(group.id) ?? 0) + 1;
      seen.set(group.id, count);
      key = count === 1 ? group.id : `${group.id}~${String(count)}`;
    }
    const shift = group ? (offsets[key] ?? { dx: 0, dy: 0 }) : { dx: 0, dy: 0 };
    if (group && isCollapsed(group.id)) {
      const id = `summary:${key}`;
      const own = offsets[id] ?? { dx: 0, dy: 0 };
      summaries.push({
        id,
        groupId: group.id,
        count: segment.steps.length,
        stepIds: segment.steps.map((step) => step.id),
        x: x + inner + shift.dx + own.dx,
        y: top + shift.dy + own.dy,
      });
      for (const step of segment.steps) nodeOf[step.id] = id;
      width = NODE_WIDTH + inner * 2;
      bottom = top + NODE_HEIGHT;
    } else {
      const columns = chunks(segment.steps, maxRows);
      columns.forEach((column, columnIndex) => {
        column.forEach((step, row) => {
          const own = offsets[step.id] ?? { dx: 0, dy: 0 };
          laidSteps.push({
            id: step.id,
            step,
            x: x + inner + columnIndex * (NODE_WIDTH + SUB_GAP) + shift.dx + own.dx,
            y: top + row * (NODE_HEIGHT + ROW_GAP) + shift.dy + own.dy,
          });
          nodeOf[step.id] = step.id;
        });
      });
      width = columns.length * NODE_WIDTH + (columns.length - 1) * SUB_GAP + inner * 2;
      const rows = Math.min(segment.steps.length, maxRows);
      bottom = top + rows * NODE_HEIGHT + (rows - 1) * ROW_GAP;
    }
    if (group)
      groups.push({
        key,
        groupId: group.id,
        name: group.name,
        collapsed: isCollapsed(group.id),
        continued: key !== group.id,
        x: x + shift.dx,
        y: MARGIN + shift.dy,
        width,
        height: bottom - MARGIN + PAD,
      });
    height = Math.max(height, bottom + PAD + Math.max(0, shift.dy));
    x += width + COLUMN_GAP;
  }
  const position = new Map<string, { x: number; y: number }>();
  for (const step of laidSteps) position.set(step.id, step);
  for (const summary of summaries) position.set(summary.id, summary);
  const edges: LaidEdge[] = [];
  const order = view.steps.map((step) => nodeOf[step.id] ?? step.id);
  for (let index = 1; index < order.length; index += 1) {
    const from = order[index - 1];
    const to = order[index];
    if (!from || !to || from === to) continue;
    const a = position.get(from);
    const b = position.get(to);
    if (!a || !b) continue;
    const sameColumn = Math.abs(a.x - b.x) < 1 && b.y > a.y;
    edges.push({
      from,
      to,
      kind: 'sequence',
      mid: middle(a, b, 0),
      path: sameColumn
        ? `M${a.x + NODE_WIDTH / 2} ${a.y + NODE_HEIGHT}L${b.x + NODE_WIDTH / 2} ${b.y}`
        : curve(right(a.x, a.y), left(b.x, b.y)),
    });
  }
  const violating = new Set(view.violations.map((violation) => `${violation.stepId}|${violation.key}`));
  for (const dependency of view.dependencies) {
    const from = nodeOf[dependency.from];
    const to = nodeOf[dependency.to];
    if (!from || !to || from === to) continue;
    const a = position.get(from);
    const b = position.get(to);
    if (!a || !b) continue;
    edges.push({
      from,
      to,
      kind: violating.has(`${dependency.to}|${dependency.key}`) ? 'violation' : 'data',
      key: dependency.key,
      mid: middle(a, b, 46),
      path: curve(right(a.x, a.y), left(b.x, b.y), 46),
    });
  }
  const extentX = Math.max(
    x - COLUMN_GAP + MARGIN,
    ...laidSteps.map((step) => step.x + NODE_WIDTH + MARGIN),
    ...summaries.map((summary) => summary.x + NODE_WIDTH + MARGIN),
  );
  const extentY = Math.max(
    height + MARGIN,
    ...laidSteps.map((step) => step.y + NODE_HEIGHT + MARGIN),
    ...summaries.map((summary) => summary.y + NODE_HEIGHT + MARGIN),
  );
  return { steps: laidSteps, summaries, groups, edges, width: extentX, height: extentY, nodeOf };
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.5;

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** La vue qui montre tout le graphe dans un cadre de `width` × `height` (jamais au-delà de 100 %). */
export function fitView(
  layout: Pick<StudioLayout, 'width' | 'height'>,
  width: number,
  height: number,
): Viewport {
  const k = clampZoom(Math.min(1, (width - 24) / layout.width, (height - 24) / layout.height));
  return { k, x: (width - layout.width * k) / 2, y: (height - layout.height * k) / 2 };
}

/** Zoomer autour d'un point du cadre (le point sous le pointeur ne bouge pas). */
export function zoomAt(view: Viewport, factor: number, at: { x: number; y: number }): Viewport {
  const k = clampZoom(view.k * factor);
  const ratio = k / view.k;
  return { k, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}

/** Centrer la vue sur un point du graphe, à l'échelle courante. */
export function centerOn(
  view: Viewport,
  point: { x: number; y: number },
  width: number,
  height: number,
): Viewport {
  return { k: view.k, x: width / 2 - point.x * view.k, y: height / 2 - point.y * view.k };
}

/** Les étapes et groupes qui correspondent à une recherche (texte, identifiant, clé de donnée, groupe). */
export function searchStudio(view: Pick<FlowStudioView, 'steps' | 'groups'>, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const groupName = new Map(view.groups.map((group) => [group.id, group.name.toLowerCase()]));
  return view.steps
    .filter((step) =>
      [
        step.description,
        step.id,
        step.kind,
        ...step.consumes,
        ...step.produces,
        step.groupId ? (groupName.get(step.groupId) ?? '') : '',
      ].some((text) => text.toLowerCase().includes(needle)),
    )
    .map((step) => step.id);
}
