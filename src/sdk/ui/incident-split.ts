import { icon } from './dashboard-parts.js';
import { isGraphLayout, type GraphLayoutMode } from './incident-graph.js';
import type { Lang } from './incident-parts.js';
import { esc } from './view.js';

/**
 * LA DISPOSITION EN PANNEAUX DE L'ESPACE D'INVESTIGATION (façon IDE, sans défilement de la page) : des
 * panneaux redimensionnables (séparateurs au pointeur et au clavier), agrandis, réduits à leur barre de
 * titre, masqués puis rappelés ; un seul panneau à la fois sur un écran étroit. Tout est pur : l'état
 * (`SplitUi`) est tenu par le contrôleur, les tailles sont des fractions (0..1) de position des
 * séparateurs, la grille CSS est construite de ces fractions avec des minimums en pixels (`minmax`), si
 * bien que le navigateur ne dépasse jamais l'espace de travail. Les préférences (tailles, panneaux, onglet,
 * mode compact…) se lisent et s'écrivent ici sur un stockage passé en argument : chaque champ est validé.
 */

// ── Identifiants ─────────────────────────────────────────────────────────────────────────────

export const PANE_IDS = ['primary', 'details', 'tree', 'editor', 'evidence', 'content'] as const;
export type PaneId = (typeof PANE_IDS)[number];

export const SPLITTER_IDS = [
  'top-bottom',
  'primary-details',
  'tree-editor',
  'editor-evidence',
  'content-details',
] as const;
export type SplitterId = (typeof SPLITTER_IDS)[number];

export type PaneMode = 'normal' | 'min' | 'hidden';
const PANE_MODES: readonly PaneMode[] = ['normal', 'min', 'hidden'];

/** `trace` : onglet Traçabilité ; `code` : onglet Code (zone haute réduite par défaut) ; `document` : contenu | détails. */
export type SplitLayout = 'trace' | 'code' | 'document';

export const isPaneId = (value: string | undefined): value is PaneId =>
  (PANE_IDS as readonly string[]).includes(value ?? '');
export const isSplitterId = (value: string | undefined): value is SplitterId =>
  (SPLITTER_IDS as readonly string[]).includes(value ?? '');

// ── État ─────────────────────────────────────────────────────────────────────────────────────

export interface SplitUi {
  /** La position de chaque séparateur, en fraction de sa zone (0..1, mesurée depuis le début de la zone). */
  sizes: Record<SplitterId, number>;
  /** Le mode de chaque panneau (absent : normal). */
  panes: Partial<Record<PaneId, PaneMode>>;
  /** Le panneau qui remplit tout l'espace de travail (Échap le rétablit). */
  maximized?: PaneId;
  /** Le panneau affiché sur un écran étroit (un seul à la fois). */
  mobilePane?: PaneId;
  /** Onglet Code : la zone haute (graphe et détails) est ouverte ; fermée (réduite à ses barres) par défaut. */
  codeTop: boolean;
}

/**
 * Les positions par défaut : zone haute 58 % de la hauteur ; graphe 70 % de la largeur ; arborescence
 * 20 % (environ 220 px à 1440 × 900 : les noms de fichiers se lisent), éditeur jusqu'à 74 % (preuves
 * au-delà) ; contenu 68 % des onglets de document.
 */
export const DEFAULT_SIZES: Readonly<Record<SplitterId, number>> = {
  'top-bottom': 0.58,
  'primary-details': 0.7,
  'tree-editor': 0.2,
  'editor-evidence': 0.74,
  'content-details': 0.68,
};

export function emptySplitUi(): SplitUi {
  return { sizes: { ...DEFAULT_SIZES }, panes: {}, codeTop: false };
}

/** Les minimums lisibles de chaque panneau (largeur ; la zone haute et la zone basse ont leur hauteur). */
export const PANE_MIN_PX: Readonly<Record<PaneId, number>> = {
  primary: 320,
  details: 260,
  tree: 180,
  editor: 300,
  evidence: 200,
  content: 360,
};
export const ZONE_MIN_PX = { top: 200, bottom: 160 } as const;
/**
 * L'épaisseur d'un séparateur (sa piste dans la grille), et celle d'un panneau réduit placé entre deux
 * panneaux. La zone de saisie au pointeur déborde de la piste (`SPLITTER_HIT_PX`, pseudo-élément) sans
 * prendre de place aux panneaux.
 */
export const SPLITTER_PX = 6;
export const SPLITTER_HIT_PX = 12;
export const STRIP_PX = 40;

/** Un pas du clavier (2 %), avec Maj (10 %). */
export const SPLIT_STEP = 0.02;
export const SPLIT_STEP_BIG = 0.1;
/** Les bornes d'une position, sans connaître la taille réelle de la zone. */
export const SPLIT_MIN = 0.08;
export const SPLIT_MAX = 0.92;
/** L'écart minimal entre les deux séparateurs de la zone basse (la largeur de l'éditeur). */
const EDITOR_GAP = 0.12;

/** Ce que sépare chaque séparateur : l'axe, le panneau qu'il commande (le premier), le second. */
export const SPLITTERS: Readonly<
  Record<
    SplitterId,
    { axis: 'x' | 'y'; first: PaneId; second: PaneId; orientation: 'vertical' | 'horizontal' }
  >
> = {
  'top-bottom': { axis: 'y', first: 'primary', second: 'editor', orientation: 'horizontal' },
  'primary-details': { axis: 'x', first: 'primary', second: 'details', orientation: 'vertical' },
  'tree-editor': { axis: 'x', first: 'tree', second: 'editor', orientation: 'vertical' },
  'editor-evidence': { axis: 'x', first: 'editor', second: 'evidence', orientation: 'vertical' },
  'content-details': { axis: 'x', first: 'content', second: 'details', orientation: 'vertical' },
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Les bornes d'une position : générales, ou tirées des minimums en pixels quand la taille de la zone est connue. */
export function splitBounds(
  id: SplitterId,
  sizes: Record<SplitterId, number>,
  totalPx?: number,
): { min: number; max: number } {
  const px = (value: number): number => (totalPx && totalPx > 0 ? value / totalPx : 0);
  let min = SPLIT_MIN;
  let max = SPLIT_MAX;
  switch (id) {
    case 'top-bottom':
      min = Math.max(min, px(ZONE_MIN_PX.top));
      max = Math.min(max, 1 - px(ZONE_MIN_PX.bottom));
      break;
    case 'primary-details':
      min = Math.max(min, px(PANE_MIN_PX.primary));
      max = Math.min(max, 1 - px(PANE_MIN_PX.details));
      break;
    case 'content-details':
      min = Math.max(min, px(PANE_MIN_PX.content));
      max = Math.min(max, 1 - px(PANE_MIN_PX.details));
      break;
    case 'tree-editor':
      min = Math.max(min, px(PANE_MIN_PX.tree));
      max = Math.min(max, sizes['editor-evidence'] - Math.max(EDITOR_GAP, px(PANE_MIN_PX.editor)));
      break;
    case 'editor-evidence':
      min = Math.max(min, sizes['tree-editor'] + Math.max(EDITOR_GAP, px(PANE_MIN_PX.editor)));
      max = Math.min(max, 1 - px(PANE_MIN_PX.evidence));
      break;
  }
  // Une zone trop petite pour les deux minimums : la position reste au milieu de ce qui est possible.
  if (min > max) {
    const middle = (min + max) / 2;
    return { min: middle, max: middle };
  }
  return { min, max };
}

/** Une position bornée (et arrondie au dix-millième, pour un état stable). */
export function clampSplit(
  id: SplitterId,
  value: number,
  sizes: Record<SplitterId, number>,
  totalPx?: number,
): number {
  if (!Number.isFinite(value)) return sizes[id];
  const { min, max } = splitBounds(id, sizes, totalPx);
  return Math.round(clamp(value, min, max) * 10_000) / 10_000;
}

/** Le premier panneau d'un séparateur (Entrée le réduit ou le rétablit). */
const firstPaneOf = (id: SplitterId): PaneId => SPLITTERS[id].first;

/** Les panneaux de chaque disposition, dans l'ordre du document. */
export const LAYOUT_PANES: Readonly<Record<SplitLayout, readonly PaneId[]>> = {
  trace: ['primary', 'details', 'tree', 'editor', 'evidence'],
  code: ['primary', 'details', 'tree', 'editor', 'evidence'],
  document: ['content', 'details'],
};

/** Le mode affiché d'un panneau : sur l'onglet Code, la zone haute fermée réduit graphe et détails. */
export function paneMode(ui: SplitUi, layout: SplitLayout, pane: PaneId): PaneMode {
  const mode = ui.panes[pane] ?? 'normal';
  if (mode === 'hidden') return mode;
  if (layout === 'code' && (pane === 'primary' || pane === 'details') && !ui.codeTop) return 'min';
  return mode;
}

const isLayout = (value: string | undefined): value is SplitLayout =>
  value === 'trace' || value === 'code' || value === 'document';

/**
 * Le réducteur pur de la disposition. Actions :
 * - `ws-pane` : `pane`, `op` (`max` | `restore` | `min` | `hide` | `show`), `layout?` ;
 * - `ws-pane-focus` : `pane` — le panneau affiché sur un écran étroit ;
 * - `ws-split-set` : `splitter`, `value` (fraction), `total?` (taille de la zone en px, pour les minimums) ;
 * - `ws-split-key` : `splitter`, `key` (flèches, Début, Fin, Entrée), `shift` (« true ») , `total?`, `layout?` ;
 * - `ws-split-reset` : `splitter?` — la position par défaut (sans séparateur : toute la disposition).
 * Rend `undefined` pour une autre action.
 */
export function reduceSplit(
  ui: SplitUi,
  action: string,
  dataset: Record<string, string | undefined>,
): SplitUi | undefined {
  switch (action) {
    case 'ws-pane': {
      const pane = dataset.pane;
      if (!isPaneId(pane)) return ui;
      const layout = isLayout(dataset.layout) ? dataset.layout : 'trace';
      const top = pane === 'primary' || pane === 'details';
      let panes: SplitUi['panes'] = { ...ui.panes };
      const unmax = ui.maximized === pane ? undefined : ui.maximized;
      const normal = (): SplitUi['panes'] =>
        Object.fromEntries(Object.entries(ui.panes).filter(([key]) => key !== pane));
      const next = (over: Partial<SplitUi>): SplitUi => {
        const result: SplitUi = { ...ui, panes, ...over };
        if (result.maximized === undefined) delete result.maximized;
        if (result.mobilePane === undefined) delete result.mobilePane;
        return result;
      };
      switch (dataset.op) {
        case 'max':
          if (paneMode(ui, layout, pane) === 'hidden') return ui;
          return next({ maximized: pane });
        case 'restore':
          if (ui.maximized === pane) return next({ maximized: undefined });
          panes = normal();
          return next(layout === 'code' && top ? { codeTop: true } : {});
        case 'min':
          panes[pane] = 'min';
          return next({ maximized: unmax });
        case 'hide':
          panes[pane] = 'hidden';
          return next({ maximized: unmax, ...(ui.mobilePane === pane ? { mobilePane: undefined } : {}) });
        case 'show':
          panes = normal();
          return next(layout === 'code' && top ? { codeTop: true } : {});
        default:
          return ui;
      }
    }
    case 'ws-pane-focus': {
      const pane = dataset.pane;
      if (!isPaneId(pane)) return ui;
      return { ...ui, mobilePane: pane };
    }
    case 'ws-split-set': {
      const splitter = dataset.splitter;
      if (!isSplitterId(splitter)) return ui;
      const value = Number(dataset.value);
      const total = Number(dataset.total);
      return {
        ...ui,
        sizes: {
          ...ui.sizes,
          [splitter]: clampSplit(splitter, value, ui.sizes, Number.isFinite(total) ? total : undefined),
        },
      };
    }
    case 'ws-split-key': {
      const splitter = dataset.splitter;
      if (!isSplitterId(splitter)) return ui;
      const total = Number(dataset.total);
      const px = Number.isFinite(total) && total > 0 ? total : undefined;
      // La position de départ est celle RENDUE (bornée par la place réelle) : la première flèche bouge
      // visiblement, même quand la position mémorisée dépasse ce que la zone permet.
      const current = px ? clampSplit(splitter, ui.sizes[splitter], ui.sizes, px) : ui.sizes[splitter];
      const step = dataset.shift === 'true' ? SPLIT_STEP_BIG : SPLIT_STEP;
      const bounds = splitBounds(splitter, ui.sizes, px);
      let value: number;
      switch (dataset.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          value = current - step;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          value = current + step;
          break;
        case 'Home':
          value = bounds.min;
          break;
        case 'End':
          value = bounds.max;
          break;
        case 'Enter': {
          const pane = firstPaneOf(splitter);
          const layout = isLayout(dataset.layout) ? dataset.layout : 'trace';
          const mode = paneMode(ui, layout, pane);
          return reduceSplit(ui, 'ws-pane', { pane, layout, op: mode === 'min' ? 'restore' : 'min' });
        }
        default:
          return ui;
      }
      return { ...ui, sizes: { ...ui.sizes, [splitter]: clampSplit(splitter, value, ui.sizes, px) } };
    }
    case 'ws-split-reset': {
      const splitter = dataset.splitter;
      if (isSplitterId(splitter))
        return { ...ui, sizes: { ...ui.sizes, [splitter]: DEFAULT_SIZES[splitter] } };
      return { ...emptySplitUi(), ...(ui.mobilePane ? { mobilePane: ui.mobilePane } : {}) };
    }
    default:
      return undefined;
  }
}

// ── Grille ───────────────────────────────────────────────────────────────────────────────────

/** La part (fraction) de chaque panneau dans sa zone, tirée des positions des séparateurs. */
export function paneFractions(sizes: Record<SplitterId, number>): Record<PaneId, number> {
  const primary = sizes['primary-details'];
  const tree = sizes['tree-editor'];
  const evidenceStart = Math.max(sizes['editor-evidence'], tree + 0.01);
  const content = sizes['content-details'];
  return {
    primary,
    details: 1 - primary,
    tree,
    editor: evidenceStart - tree,
    evidence: 1 - evidenceStart,
    content,
  };
}

/**
 * Une part en `fr`, à l'échelle 100 : une somme de parts inférieure à 1 ne prendrait qu'une partie de la
 * place libre (règle des grilles CSS), d'où des parts entières.
 */
const fr = (value: number): string => `${String(Math.max(1, Math.round(value * 1000) / 10))}fr`;

/** Le séparateur entre deux panneaux voisins, s'il existe. */
function splitterBetween(a: PaneId, b: PaneId): SplitterId | undefined {
  if (a === 'primary' && b === 'details') return 'primary-details';
  if (a === 'tree' && b === 'editor') return 'tree-editor';
  if (a === 'editor' && b === 'evidence') return 'editor-evidence';
  if (a === 'content' && b === 'details') return 'content-details';
  return undefined;
}

/** Une piste de la grille d'une zone : un panneau (avec son mode) ou un séparateur. */
export type ZoneTrack =
  { kind: 'pane'; pane: PaneId; mode: PaneMode } | { kind: 'splitter'; splitter: SplitterId };

/**
 * Les pistes d'une zone : les panneaux visibles dans l'ordre, un séparateur entre deux panneaux normaux
 * qui en ont un. `collapsed` : aucun panneau normal (la zone se réduit à ses barres de titre).
 */
export function zoneTracks(
  ui: SplitUi,
  layout: SplitLayout,
  panes: readonly PaneId[],
): { tracks: ZoneTrack[]; template: string; collapsed: boolean } {
  const visible = panes
    .map((pane) => ({ pane, mode: paneMode(ui, layout, pane) }))
    .filter((entry) => entry.mode !== 'hidden');
  const collapsed = visible.every((entry) => entry.mode === 'min');
  const fractions = paneFractions(ui.sizes);
  // Les détails d'un document se partagent la largeur avec le contenu, pas avec le graphe.
  if (layout === 'document') fractions.details = 1 - fractions.content;
  const tracks: ZoneTrack[] = [];
  const sizes: string[] = [];
  visible.forEach((entry, index) => {
    const previous = visible[index - 1];
    if (previous && previous.mode === 'normal' && entry.mode === 'normal') {
      const splitter = splitterBetween(previous.pane, entry.pane);
      if (splitter) {
        tracks.push({ kind: 'splitter', splitter });
        sizes.push(`${String(SPLITTER_PX)}px`);
      }
    }
    tracks.push({ kind: 'pane', pane: entry.pane, mode: entry.mode });
    sizes.push(
      collapsed
        ? 'minmax(0,1fr)'
        : entry.mode === 'min'
          ? `${String(STRIP_PX)}px`
          : `minmax(${String(Math.min(PANE_MIN_PX[entry.pane], 9999))}px,${fr(fractions[entry.pane])})`,
    );
  });
  return { tracks, template: sizes.join(' '), collapsed };
}

/** Les gabarits CSS d'une disposition (lignes de la disposition, colonnes de chaque zone). */
export interface SplitTemplates {
  rows?: string;
  top?: string;
  bottom?: string;
  doc?: string;
}

export function splitTemplates(
  ui: SplitUi,
  layout: SplitLayout,
  present: readonly PaneId[] = LAYOUT_PANES[layout],
): SplitTemplates {
  const only = (panes: readonly PaneId[]): PaneId[] => panes.filter((pane) => present.includes(pane));
  if (layout === 'document') return { doc: zoneTracks(ui, layout, only(['content', 'details'])).template };
  const top = zoneTracks(ui, layout, only(['primary', 'details']));
  const bottom = zoneTracks(ui, layout, only(['tree', 'editor', 'evidence']));
  return { rows: rowsTemplate(ui, top, bottom), top: top.template, bottom: bottom.template };
}

/** Les lignes d'une disposition en deux zones (une zone réduite prend la hauteur de ses barres). */
function rowsTemplate(
  ui: SplitUi,
  top: { tracks: ZoneTrack[]; collapsed: boolean },
  bottom: { tracks: ZoneTrack[]; collapsed: boolean },
): string {
  if (top.tracks.length === 0 || bottom.tracks.length === 0) return 'minmax(0,1fr)';
  if (top.collapsed && bottom.collapsed) return 'auto 6px minmax(0,1fr)';
  if (top.collapsed) return 'auto 6px minmax(0,1fr)';
  if (bottom.collapsed) return 'minmax(0,1fr) 6px auto';
  const split = ui.sizes['top-bottom'];
  return `minmax(${String(ZONE_MIN_PX.top)}px,${fr(split)}) ${String(SPLITTER_PX)}px minmax(${String(ZONE_MIN_PX.bottom)}px,${fr(1 - split)})`;
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    max: (title: string) => `Agrandir « ${title} » à tout l’espace (Échap rétablit)`,
    restoreMax: (title: string) => `Rétablir « ${title} » dans la disposition`,
    min: (title: string) => `Réduire « ${title} » à sa barre de titre`,
    open: (title: string) => `Déplier « ${title} »`,
    hide: (title: string) => `Masquer « ${title} »`,
    show: (title: string) => `Afficher « ${title} »`,
    splitter: (a: string, b: string) => `Redimensionner : ${a} et ${b}`,
    splitterHint:
      'Flèches : 2 % ; Maj + flèches : 10 % ; Début, Fin : minimum, maximum ; Entrée : réduire ou déplier ; double clic : taille par défaut.',
    mobile: 'Panneau affiché',
    hidden: 'Panneaux masqués',
    reset: 'Réinitialiser la disposition',
    short: {
      primary: 'Graphe',
      details: 'Détails',
      tree: 'Fichiers',
      editor: 'Code',
      evidence: 'Preuves',
      content: 'Contenu',
    } as Record<PaneId, string>,
  },
  en: {
    max: (title: string) => `Maximize “${title}” to the whole space (Escape restores)`,
    restoreMax: (title: string) => `Restore “${title}” in the layout`,
    min: (title: string) => `Collapse “${title}” to its title bar`,
    open: (title: string) => `Expand “${title}”`,
    hide: (title: string) => `Hide “${title}”`,
    show: (title: string) => `Show “${title}”`,
    splitter: (a: string, b: string) => `Resize: ${a} and ${b}`,
    splitterHint:
      'Arrows: 2%; Shift + arrows: 10%; Home, End: minimum, maximum; Enter: collapse or expand; double click: default size.',
    mobile: 'Shown panel',
    hidden: 'Hidden panels',
    reset: 'Reset the layout',
    short: {
      primary: 'Graph',
      details: 'Details',
      tree: 'Files',
      editor: 'Code',
      evidence: 'Evidence',
      content: 'Content',
    } as Record<PaneId, string>,
  },
};

export const splitText = (lang: Lang): (typeof TEXT)['fr'] => TEXT[lang];

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────

/** Un panneau : son titre (court sur le sélecteur mobile), son contenu, des outils dans sa barre. */
export interface PaneSpec {
  title: string;
  body: string;
  /** Le libellé court (sélecteur d'un écran étroit, liste des panneaux masqués). */
  short?: string;
  /** Une icône de la barre de titre (`icon()`). */
  icon?: string;
  /** Des outils propres au panneau, avant ses boutons de disposition. */
  tools?: string;
  /** Le contenu remplit la hauteur du panneau (graphe, éditeur) plutôt que de défiler en document. */
  fill?: boolean;
}

export interface SplitOptions {
  lang: Lang;
  layout: SplitLayout;
  /** Le panneau affiché d'abord sur un écran étroit. */
  mobileDefault: PaneId;
  /** Écran étroit : un lien vers le panneau des détails (« Voir le détail »), quand une sélection existe. */
  detailsHint?: string;
}

const paneTitle = (id: PaneId, spec: PaneSpec | undefined, lang: Lang): string =>
  spec?.title ?? TEXT[lang].short[id];

/** Le panneau affiché sur un écran étroit : le choix de l'utilisateur s'il est visible, sinon le défaut. */
export function mobilePaneOf(
  ui: SplitUi,
  layout: SplitLayout,
  present: readonly PaneId[],
  fallback: PaneId,
): PaneId {
  const shown = present.filter((pane) => paneMode(ui, layout, pane) !== 'hidden');
  if (ui.mobilePane && shown.includes(ui.mobilePane)) return ui.mobilePane;
  if (shown.includes(fallback)) return fallback;
  return shown[0] ?? fallback;
}

/** Un panneau et sa barre de titre (agrandir / rétablir, réduire / déplier, masquer). */
export function renderPane(
  id: PaneId,
  spec: PaneSpec,
  ui: SplitUi,
  opts: SplitOptions & { mode?: PaneMode; mobileOn?: boolean; strip?: boolean },
): string {
  const t = TEXT[opts.lang];
  const mode = opts.mode ?? paneMode(ui, opts.layout, id);
  const maximized = ui.maximized === id;
  const title = spec.title;
  // Un rail (panneau réduit entre deux panneaux) écrit son titre court à la verticale ; le titre complet
  // reste dans l'infobulle et dans les libellés des boutons.
  const button = (op: string, label: string, glyph: string, state: string): string =>
    `<button type="button" class="ws-pane-btn" data-action="ws-pane" data-pane="${id}" data-op="${op}" data-layout="${opts.layout}" aria-label="${esc(label)}" title="${esc(label)}" ${state}>${icon(glyph)}</button>`;
  const buttons = [
    mode === 'min'
      ? ''
      : button(
          maximized ? 'restore' : 'max',
          maximized ? t.restoreMax(title) : t.max(title),
          maximized ? 'minimize' : 'maximize',
          `aria-pressed="${String(maximized)}"`,
        ),
    maximized
      ? ''
      : button(
          mode === 'min' ? 'restore' : 'min',
          mode === 'min' ? t.open(title) : t.min(title),
          mode === 'min' ? (opts.strip ? 'right' : 'down') : 'up',
          `aria-expanded="${String(mode !== 'min')}" aria-controls="ws-pane-${id}-b"`,
        ),
    maximized ? '' : button('hide', t.hide(title), 'close', ''),
  ].join('');
  const cls = [
    'ws-pane',
    `ws-pane-${id}`,
    mode === 'min' ? 'ws-pane-min' : '',
    opts.strip ? 'ws-pane-strip' : '',
    maximized ? 'ws-pane-max' : '',
    spec.fill ? 'ws-pane-fill' : '',
    opts.mobileOn ? 'ws-m-on' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<section class="${cls}" id="ws-pane-${id}" data-ws-pane="${id}" data-ws-zone="${id}" data-mode="${maximized ? 'max' : mode}" aria-labelledby="ws-pane-${id}-t"><header class="ws-pane-h"><h2 class="ws-pane-t" id="ws-pane-${id}-t" title="${esc(title)}">${spec.icon ?? ''}<span>${esc(opts.strip && spec.short ? spec.short : title)}</span></h2><div class="ws-pane-tools">${mode === 'min' ? '' : (spec.tools ?? '')}<span class="ws-pane-ops">${buttons}</span></div></header><div class="ws-pane-b" id="ws-pane-${id}-b" data-ws-scroll="${id}"${mode === 'min' ? ' hidden' : ''}>${spec.body}</div></section>`;
}

/** Un séparateur accessible (`role="separator"`, valeur en pourcentage, clavier et pointeur). */
export function renderSplitter(
  id: SplitterId,
  ui: SplitUi,
  opts: SplitOptions & { titles?: Partial<Record<PaneId, string>> },
): string {
  const t = TEXT[opts.lang];
  const def = SPLITTERS[id];
  const first = opts.titles?.[def.first] ?? t.short[def.first];
  const second = opts.titles?.[def.second] ?? t.short[def.second];
  const bounds = splitBounds(id, ui.sizes);
  const pct = (value: number): string => String(Math.round(value * 100));
  const label = id === 'top-bottom' ? t.splitter(first, second) : t.splitter(first, second);
  return `<div class="ws-splitter ws-splitter-${def.axis}" role="separator" tabindex="0" aria-orientation="${def.orientation}" aria-valuenow="${pct(ui.sizes[id])}" aria-valuemin="${pct(bounds.min)}" aria-valuemax="${pct(bounds.max)}" aria-label="${esc(label)}" aria-controls="ws-pane-${def.first}" aria-describedby="ws-split-hint" title="${esc(t.splitterHint)}" data-action="ws-split" data-ws-splitter="${id}" data-layout="${opts.layout}"></div>`;
}

/** Le sélecteur d'un écran étroit : un bouton par panneau visible, celui affiché pressé. */
function mobileSwitcher(
  panes: readonly PaneId[],
  specs: Partial<Record<PaneId, PaneSpec>>,
  active: PaneId,
  opts: SplitOptions,
): string {
  const t = TEXT[opts.lang];
  if (panes.length < 2) return '';
  return `<div class="ws-mswitch" role="group" aria-label="${esc(t.mobile)}">${panes
    .map(
      (pane) =>
        `<button type="button" data-action="ws-pane-focus" data-pane="${pane}" aria-pressed="${String(pane === active)}" aria-controls="ws-pane-${pane}">${esc(specs[pane]?.short ?? t.short[pane])}</button>`,
    )
    .join('')}</div>`;
}

/** Les panneaux masqués d'une disposition, à rappeler (barre « Panneaux masqués »). */
export function hiddenPanes(ui: SplitUi, layout: SplitLayout, present: readonly PaneId[]): PaneId[] {
  return present.filter((pane) => paneMode(ui, layout, pane) === 'hidden');
}

/** La barre « Panneaux masqués » (vide s'il n'y en a pas). */
export function renderHiddenBar(
  ui: SplitUi,
  specs: Partial<Record<PaneId, PaneSpec>>,
  opts: SplitOptions,
): string {
  const t = TEXT[opts.lang];
  const present = LAYOUT_PANES[opts.layout].filter((pane) => specs[pane] !== undefined);
  const hidden = hiddenPanes(ui, opts.layout, present);
  if (hidden.length === 0) return '';
  return `<div class="ws-hidden-bar" role="group" aria-label="${esc(t.hidden)}"><span class="mu">${esc(t.hidden)} :</span>${hidden
    .map((pane) => {
      const title = paneTitle(pane, specs[pane], opts.lang);
      return `<button type="button" class="ws-chip-btn" data-action="ws-pane" data-pane="${pane}" data-op="show" data-layout="${opts.layout}" aria-label="${esc(t.show(title))}">${icon('eye')}<span>${esc(specs[pane]?.short ?? title)}</span></button>`;
    })
    .join('')}</div>`;
}

/**
 * LA DISPOSITION : `trace` et `code` en deux zones (haut : primary | details ; bas : tree | editor |
 * evidence) séparées par `top-bottom` ; `document` en une zone (content | details). Un panneau agrandi
 * occupe seul tout l'espace. Sous 720 px de large (requête de conteneur), un seul panneau est affiché,
 * choisi par le sélecteur ; les séparateurs disparaissent.
 */
export function renderSplitLayout(
  specs: Partial<Record<PaneId, PaneSpec>>,
  ui: SplitUi,
  opts: SplitOptions,
): string {
  const t = TEXT[opts.lang];
  const present = LAYOUT_PANES[opts.layout].filter((pane) => specs[pane] !== undefined);
  const visible = present.filter((pane) => paneMode(ui, opts.layout, pane) !== 'hidden');
  const active = mobilePaneOf(ui, opts.layout, present, opts.mobileDefault);
  const titles = Object.fromEntries(present.map((pane) => [pane, specs[pane]?.short ?? t.short[pane]]));
  const hint = `<p id="ws-split-hint" class="sr">${esc(t.splitterHint)}</p>`;
  const hintShown = opts.detailsHint !== undefined && active !== 'details' && visible.includes('details');
  const switcher = `${mobileSwitcher(visible, specs, active, opts)}${
    hintShown
      ? `<button type="button" class="ws-mhint lnk" data-action="ws-pane-focus" data-pane="details" aria-controls="ws-pane-details">${esc(opts.detailsHint ?? '')}</button>`
      : ''
  }`;
  const maximized = ui.maximized && visible.includes(ui.maximized) ? ui.maximized : undefined;
  if (maximized) {
    const spec = specs[maximized];
    if (spec)
      return `<div class="ws-split-host">${hint}<div class="ws-split ws-split-maxed" data-ws-layout="${opts.layout}"><div class="ws-split-one">${renderPane(maximized, spec, ui, { ...opts, mode: 'normal', mobileOn: true })}</div></div></div>`;
  }
  const zone = (name: 'top' | 'bottom' | 'doc', panes: readonly PaneId[]): string => {
    const shown = panes.filter((pane) => specs[pane] !== undefined);
    const { tracks, template, collapsed } = zoneTracks(ui, opts.layout, shown);
    if (tracks.length === 0) return '';
    const items = tracks
      .map((track) => {
        if (track.kind === 'splitter') return renderSplitter(track.splitter, ui, { ...opts, titles });
        const spec = specs[track.pane];
        return spec
          ? renderPane(track.pane, spec, ui, {
              ...opts,
              mode: track.mode,
              mobileOn: track.pane === active,
              strip: track.mode === 'min' && !collapsed,
            })
          : '';
      })
      .join('');
    const has = shown.includes(active) && paneMode(ui, opts.layout, active) !== 'hidden';
    return `<div class="ws-split-zone ws-split-${name}${collapsed ? ' ws-zone-collapsed' : ''}${has ? ' ws-m-has' : ''}" data-ws-grid="${name}" style="grid-template-columns:${template}">${items}</div>`;
  };
  if (opts.layout === 'document')
    return `<div class="ws-split-host">${hint}${switcher}<div class="ws-split ws-split-doc" data-ws-layout="document">${zone('doc', ['content', 'details'])}</div></div>`;
  const topTracks = zoneTracks(
    ui,
    opts.layout,
    (['primary', 'details'] as const).filter((p) => present.includes(p)),
  );
  const bottomTracks = zoneTracks(
    ui,
    opts.layout,
    (['tree', 'editor', 'evidence'] as const).filter((p) => present.includes(p)),
  );
  const top = zone('top', ['primary', 'details']);
  const bottom = zone('bottom', ['tree', 'editor', 'evidence']);
  const between =
    top && bottom
      ? !topTracks.collapsed && !bottomTracks.collapsed
        ? renderSplitter('top-bottom', ui, { ...opts, titles })
        : '<div class="ws-splitter-gap" aria-hidden="true"></div>'
      : '';
  const rows = rowsTemplate(ui, topTracks, bottomTracks);
  return `<div class="ws-split-host">${hint}${switcher}<div class="ws-split ws-split-two" data-ws-layout="${opts.layout}" data-ws-grid="rows" style="grid-template-rows:${rows}">${top}${between}${bottom}</div></div>`;
}

// ── Préférences ──────────────────────────────────────────────────────────────────────────────

/** La clé des préférences (une pour toutes les investigations). */
export const PREFS_KEY = 'qa-crawler:incident-workspace:v2';

export const MAIN_TABS = [
  'overview',
  'timeline',
  'traceability',
  'code',
  'diagnosis',
  'trigger',
  'report',
] as const;
export type MainTab = (typeof MAIN_TABS)[number];

export const SUB_TABS = {
  overview: ['summary', 'scope', 'environment'],
  timeline: ['run', 'evidence', 'events', 'logs'],
  traceability: ['fullstack', 'frontend', 'bff', 'backend', 'http'],
  code: [],
  diagnosis: ['diagnosis', 'hypotheses', 'experiments', 'ai'],
  trigger: [
    'brief',
    'discovery',
    'explorer',
    'live',
    'chronology',
    'matrix',
    'minimal',
    'angular',
    'causes',
    'proposal',
  ],
  report: ['report', 'regression'],
} as const satisfies Record<MainTab, readonly string[]>;
export type SubTab = (typeof SUB_TABS)[MainTab][number];

export const isMainTab = (value: string | undefined): value is MainTab =>
  (MAIN_TABS as readonly string[]).includes(value ?? '');
export const isSubTabOf = (tab: MainTab, value: string | undefined): value is SubTab =>
  (SUB_TABS[tab] as readonly string[]).includes(value ?? '');

export interface WorkspacePrefs {
  sizes: Partial<Record<SplitterId, number>>;
  panes: Partial<Record<PaneId, PaneMode>>;
  maximized?: PaneId;
  tab?: MainTab;
  subs: Partial<Record<MainTab, SubTab>>;
  graphZoom?: number;
  /** La disposition du graphe (« Colonnes » ou « Couloirs horizontaux »). */
  graphLayout?: GraphLayoutMode;
  compact: boolean;
  stepper: boolean;
  treeCollapsed: boolean;
  /** Onglet Code : la zone haute ouverte. */
  codeTop: boolean;
}

export const emptyPrefs = (): WorkspacePrefs => ({
  sizes: {},
  panes: {},
  subs: {},
  compact: false,
  stepper: false,
  treeCollapsed: false,
  codeTop: false,
});

/** Le stockage des préférences (`localStorage`, ou un double de test). */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Les préférences validées d'une valeur quelconque : chaque champ invalide est ignoré. */
export function parsePrefs(raw: unknown): WorkspacePrefs {
  const prefs = emptyPrefs();
  if (!isRecord(raw)) return prefs;
  if (isRecord(raw.sizes))
    for (const id of SPLITTER_IDS) {
      const value = raw.sizes[id];
      if (typeof value === 'number' && Number.isFinite(value) && value >= SPLIT_MIN && value <= SPLIT_MAX)
        prefs.sizes[id] = value;
    }
  // L'éditeur garde sa largeur minimale entre les deux séparateurs de la zone basse.
  const tree = prefs.sizes['tree-editor'];
  const evidence = prefs.sizes['editor-evidence'];
  if (tree !== undefined && evidence !== undefined && evidence - tree < EDITOR_GAP) {
    delete prefs.sizes['tree-editor'];
    delete prefs.sizes['editor-evidence'];
  }
  if (isRecord(raw.panes))
    for (const id of PANE_IDS) {
      const value = raw.panes[id];
      if (
        typeof value === 'string' &&
        (PANE_MODES as readonly string[]).includes(value) &&
        value !== 'normal'
      )
        prefs.panes[id] = value as PaneMode;
    }
  if (typeof raw.maximized === 'string' && isPaneId(raw.maximized)) prefs.maximized = raw.maximized;
  if (typeof raw.tab === 'string' && isMainTab(raw.tab)) prefs.tab = raw.tab;
  if (isRecord(raw.subs))
    for (const tab of MAIN_TABS) {
      const value = raw.subs[tab];
      if (typeof value === 'string' && isSubTabOf(tab, value)) prefs.subs[tab] = value;
    }
  if (
    typeof raw.graphZoom === 'number' &&
    Number.isFinite(raw.graphZoom) &&
    raw.graphZoom >= 0.1 &&
    raw.graphZoom <= 10
  )
    prefs.graphZoom = raw.graphZoom;
  if (isGraphLayout(raw.graphLayout)) prefs.graphLayout = raw.graphLayout;
  for (const flag of ['compact', 'stepper', 'treeCollapsed', 'codeTop'] as const)
    if (typeof raw[flag] === 'boolean') prefs[flag] = raw[flag];
  return prefs;
}

/** Lit les préférences ; un stockage absent, refusé ou illisible donne les préférences par défaut. */
export function readPrefs(storage: PrefsStorage | undefined): WorkspacePrefs {
  if (!storage) return emptyPrefs();
  try {
    const text = storage.getItem(PREFS_KEY);
    if (!text) return emptyPrefs();
    return parsePrefs(JSON.parse(text) as unknown);
  } catch {
    return emptyPrefs();
  }
}

/** Écrit les préférences (validées d'abord) ; rend false si le stockage refuse (quota, navigation privée). */
export function writePrefs(storage: PrefsStorage | undefined, prefs: WorkspacePrefs): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(parsePrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

/** La disposition décrite par des préférences. */
export function splitFromPrefs(prefs: WorkspacePrefs): SplitUi {
  const ui = emptySplitUi();
  ui.sizes = { ...ui.sizes, ...prefs.sizes };
  ui.panes = { ...prefs.panes };
  if (prefs.maximized) ui.maximized = prefs.maximized;
  ui.codeTop = prefs.codeTop;
  return ui;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/**
 * Les styles de la disposition : chaque panneau défile en lui-même (`min-height:0`, `overflow:auto`), la
 * grille est posée par l'attribut `style` (gabarit tiré des fractions) ; sous 720 px de conteneur, un seul
 * panneau. Jetons du thème seulement (clair et sombre).
 */
export const INCIDENT_SPLIT_CSS = `
/* Le bord des panneaux et des commandes de la disposition : au moins 3:1 sur le fond, dans les deux thèmes. */
.ws-root,.ws-split-host{--ws-edge:color-mix(in srgb,var(--qa-color-muted) 60%,var(--qa-color-border-strong))}
.ws-split-host{container:ws-split / inline-size;display:flex;flex-direction:column;min-height:0;min-width:0;height:100%;position:relative}
.ws-split-host>.sr{position:absolute}
.ws-split{display:grid;min-height:0;min-width:0;flex:1 1 auto;gap:0;position:relative}
.ws-split-two{grid-template-columns:minmax(0,1fr)}
.ws-split-doc,.ws-split-maxed{grid-template-rows:minmax(0,1fr);grid-template-columns:minmax(0,1fr)}
.ws-split-zone{display:grid;grid-template-rows:minmax(0,1fr);min-height:0;min-width:0;gap:0;overflow:auto}
.ws-split-zone.ws-zone-collapsed{overflow:hidden}
.ws-split-one{display:grid;min-height:0;min-width:0;grid-template-rows:minmax(0,1fr)}
.ws-pane{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--qa-color-surface);border:1px solid var(--ws-edge);border-radius:10px;overflow:hidden}
.ws-pane-h{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:34px;padding:2px 4px 2px 10px;border-bottom:1px solid var(--qa-color-border);background:var(--qa-color-surface-2)}
.ws-pane-t{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ws-pane-t>span{overflow:hidden;text-overflow:ellipsis}
.ws-pane-t .ico{width:15px;height:15px}
.ws-pane-tools{display:flex;align-items:center;gap:4px;min-width:0;flex-wrap:nowrap}
.ws-pane-ops{display:inline-flex;gap:2px;flex:none}
.ws-pane-btn{width:30px;height:30px;display:inline-grid;place-items:center;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--qa-color-muted);cursor:pointer;padding:0}
.ws-pane-btn:hover{border-color:var(--qa-color-border-strong);color:var(--qa-color-text);background:var(--qa-color-surface)}
.ws-pane-btn[aria-pressed="true"]{color:var(--qa-color-primary)}
.ws-pane-btn .ico{width:15px;height:15px}
.ws-pane-b{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px;overscroll-behavior:contain}
.ws-pane-fill>.ws-pane-b{padding:8px}
.ws-pane-min{border-style:dashed}
.ws-pane-min>.ws-pane-h{border-bottom:0}
.ws-pane-strip{min-width:0}
.ws-pane-strip>.ws-pane-h{flex-direction:column;align-items:center;justify-content:flex-start;height:100%;padding:6px 2px;gap:8px}
.ws-pane-strip .ws-pane-t{writing-mode:vertical-rl;transform:rotate(180deg);order:2}
.ws-pane-strip .ws-pane-t .ico{display:none}
.ws-pane-strip .ws-pane-tools{flex-direction:column;order:1}
.ws-pane-strip .ws-pane-ops{flex-direction:column}
.ws-splitter{position:relative;background:transparent;touch-action:none;z-index:1;outline-offset:-2px}
.ws-splitter::before{content:"";position:absolute}
.ws-splitter::after{content:"";position:absolute;border-radius:2px;background:var(--qa-color-muted)}
.ws-splitter-x{cursor:col-resize;min-width:${String(SPLITTER_PX)}px}
.ws-splitter-x::before{top:0;bottom:0;left:${String((SPLITTER_PX - SPLITTER_HIT_PX) / 2)}px;right:${String((SPLITTER_PX - SPLITTER_HIT_PX) / 2)}px}
.ws-splitter-x::after{top:calc(50% - 16px);height:32px;left:2px;width:2px}
.ws-splitter-y{cursor:row-resize;min-height:${String(SPLITTER_PX)}px}
.ws-splitter-y::before{left:0;right:0;top:${String((SPLITTER_PX - SPLITTER_HIT_PX) / 2)}px;bottom:${String((SPLITTER_PX - SPLITTER_HIT_PX) / 2)}px}
.ws-splitter-y::after{left:calc(50% - 16px);width:32px;top:2px;height:2px}
.ws-splitter:hover::after,.ws-splitter.ws-dragging::after,.ws-splitter:focus-visible::after{background:var(--qa-color-primary);opacity:1}
.ws-splitter-x:hover::after,.ws-splitter-x.ws-dragging::after,.ws-splitter-x:focus-visible::after{top:0;height:100%}
.ws-splitter-y:hover::after,.ws-splitter-y.ws-dragging::after,.ws-splitter-y:focus-visible::after{left:0;width:100%}
.ws-root .ws-splitter:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:-2px}
.ws-splitter-gap{min-height:0}
.ws-split-zone.ws-zone-collapsed+.ws-splitter-gap,.ws-splitter-gap:has(+.ws-zone-collapsed){min-height:6px}
.ws-mswitch,.ws-mhint{display:none}
.ws-hidden-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px}
.ws-chip-btn{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 8px;border:1px dashed var(--ws-edge);border-radius:999px;background:var(--qa-color-surface);color:var(--qa-color-text);cursor:pointer;font-size:12px}
.ws-chip-btn:hover{border-color:var(--qa-color-primary)}
.ws-chip-btn .ico{width:14px;height:14px}
.ws-split.ws-resizing{user-select:none;cursor:col-resize}
.ws-split.ws-resizing-y{cursor:row-resize}
@container ws-split (max-width:719px){
  .ws-mswitch{display:flex;flex-wrap:wrap;gap:4px;padding:0 0 8px;flex:none}
  .ws-mhint{display:inline-flex;align-self:flex-start;margin:0 0 6px;flex:none}
  .ws-mswitch button{flex:1 1 auto;min-height:40px;padding:0 10px;border:1px solid var(--qa-color-border-strong);border-radius:10px;background:var(--qa-color-surface);color:var(--qa-color-text);font-weight:500;cursor:pointer}
  .ws-mswitch button[aria-pressed="true"]{border-color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface));color:var(--qa-color-primary);font-weight:600}
  .ws-split,.ws-split-two,.ws-split-doc{display:flex!important;flex-direction:column;flex:1 1 0}
  .ws-split-zone{display:flex!important;flex-direction:column;flex:1 1 0;min-height:0;overflow:visible}
  .ws-split-zone:not(.ws-m-has),.ws-splitter,.ws-splitter-gap{display:none!important}
  .ws-pane:not(.ws-m-on){display:none}
  .ws-pane.ws-m-on{flex:1 1 0;min-height:0}
  .ws-pane.ws-m-on>.ws-pane-b{display:flex}
  .ws-pane.ws-m-on>.ws-pane-b[hidden]{display:flex!important}
  .ws-pane.ws-m-on.ws-pane-strip>.ws-pane-h{flex-direction:row;height:auto;padding:2px 4px 2px 10px}
  .ws-pane.ws-m-on.ws-pane-strip .ws-pane-t{writing-mode:horizontal-tb;transform:none;order:0}
  .ws-pane.ws-m-on.ws-pane-strip .ws-pane-tools,.ws-pane.ws-m-on.ws-pane-strip .ws-pane-ops{flex-direction:row;order:0}
  .ws-pane-ops [data-op="min"],.ws-pane-ops [data-op="restore"][aria-expanded]{display:none}
}
`;
