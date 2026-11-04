import type { BlockState, LibraryBlockView } from '../core/contracts.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LE CATALOGUE DE BLOCS : la carte d'un bloc (nom, version, statut réel du contrat, nombre d'étapes, d'entrées
 * et de sorties, groupes métier, dernière modification) et la pagination. Tout vient de la bibliothèque du
 * serveur : un nombre absent reste absent, rien n'est codé en dur. Des fonctions pures.
 */
export const PAGE_SIZES = [12, 24, 48, 96] as const;
export const DEFAULT_PAGE_SIZE = 24;

const FR = {
  open: 'Ouvrir',
  openHint: (name: string) => `Ouvrir la fiche de « ${name} »`,
  steps: (count: number) => `${String(count)} étape${count > 1 ? 's' : ''}`,
  inputs: (count: number) => `${String(count)} entrée${count > 1 ? 's' : ''}`,
  outputs: (count: number) => `${String(count)} sortie${count > 1 ? 's' : ''}`,
  modified: (date: string) => `Modifié le ${date}`,
  noDate: 'Date de modification inconnue',
  pageLabel: 'Pagination du catalogue',
  page: (page: number) => `Page ${String(page)}`,
  previous: 'Page précédente',
  next: 'Page suivante',
  perPage: (size: number) => `${String(size)} / page`,
  perPageLabel: 'Blocs par page',
  range: (from: number, to: number, total: number) =>
    `${String(from)}–${String(to)} sur ${String(total)} bloc${total > 1 ? 's' : ''}`,
  found: (count: number) => `${String(count)} bloc${count > 1 ? 's' : ''} trouvé${count > 1 ? 's' : ''}`,
  loading: 'Lecture du catalogue…',
  error: 'Le catalogue n’a pas pu être lu.',
  retry: 'Réessayer',
};
type Text = typeof FR;

const EN: Text = {
  open: 'Open',
  openHint: (name) => `Open the sheet of “${name}”`,
  steps: (count) => `${String(count)} step${count > 1 ? 's' : ''}`,
  inputs: (count) => `${String(count)} input${count > 1 ? 's' : ''}`,
  outputs: (count) => `${String(count)} output${count > 1 ? 's' : ''}`,
  modified: (date) => `Modified ${date}`,
  noDate: 'Modification date unknown',
  pageLabel: 'Catalogue pages',
  page: (page) => `Page ${String(page)}`,
  previous: 'Previous page',
  next: 'Next page',
  perPage: (size) => `${String(size)} / page`,
  perPageLabel: 'Blocks per page',
  range: (from, to, total) =>
    `${String(from)}–${String(to)} of ${String(total)} block${total > 1 ? 's' : ''}`,
  found: (count) => `${String(count)} block${count > 1 ? 's' : ''} found`,
  loading: 'Reading the catalogue…',
  error: 'The catalogue could not be read.',
  retry: 'Retry',
};

export const catalogText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

/** La page affichée (1…n), ramenée dans les bornes quand le nombre de blocs visibles change. */
export function pageOf<T>(
  items: readonly T[],
  page: number,
  size: number,
): { items: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (current - 1) * size;
  const shown = items.slice(start, start + size);
  return {
    items: shown,
    page: current,
    pages,
    from: shown.length > 0 ? start + 1 : 0,
    to: start + shown.length,
  };
}

/** Les numéros de pages montrés : la première, la dernière, et celles autour de la page courante. */
export function pageNumbers(page: number, pages: number): (number | 'gap')[] {
  const wanted = new Set(
    [1, pages, page - 1, page, page + 1].filter((value) => value >= 1 && value <= pages),
  );
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (typeof last === 'number' && value - last > 1) out.push('gap');
    out.push(value);
  }
  return out;
}

const STATE_TONE: Record<BlockState, string> = { VALID: 'ok', CHANGED: 'warn', INVALID: 'ko' };

/** La carte d'un bloc (grille et liste). `compact` : la liste réduite à côté de la fiche ouverte. */
export function catalogCard(
  state: DashboardState,
  block: LibraryBlockView,
  options: {
    publish: boolean;
    opened: boolean;
    inJourney: number;
    compact?: boolean;
    /** L'origine, courte, et son détail (au survol). */
    origin: { text: string; title: string };
  },
): string {
  const l = state.t.lib;
  const c = catalogText(state);
  const when = block.updatedAt ?? block.createdAt;
  const stateLabel = l.states[block.state];
  // Le statut réel du contrat : une coche discrète (et son libellé) quand il est valide.
  const status =
    block.state === 'VALID'
      ? `<span class="lib-state ok"><span class="lib-ok" title="${esc(stateLabel)}">${icon('check')}</span>${esc(stateLabel)}</span>`
      : `<span class="lib-state ${STATE_TONE[block.state]}">${esc(stateLabel)}</span>`;
  const counts = `<p class="lib-counts"><span title="${esc(l.stepsLabel)}">${icon('rows')}${esc(c.steps(block.steps))}</span><span title="${esc(l.inputsLabel)}">${icon('down')}${esc(c.inputs(block.contract.inputs.length))}</span><span title="${esc(l.outputsLabel)}">${icon('up')}${esc(c.outputs(block.contract.outputs.length))}</span></p>`;
  // Les « catégories » réelles d'un bloc : son origine et ses groupes métier (jamais des étiquettes inventées).
  const groups = (block.groups ?? []).map((group) => group.name).slice(0, 3);
  const tags = `<p class="lib-tags"><span class="lib-tag origin lib-origin" title="${esc(options.origin.title)}">${esc(options.origin.text)}</span>${groups.map((name) => `<span class="lib-tag">${esc(name)}</span>`).join('')}</p>`;
  const date = when
    ? `<small class="lib-when">${icon('history')}${esc(c.modified(new Date(when).toLocaleDateString(state.t.locale)))}</small>`
    : `<small class="lib-when mu">${esc(c.noDate)}</small>`;
  const add = options.publish
    ? `<button class="btn small ghost lib-add" data-action="lib-part-add" data-block="${esc(block.name)}" title="${esc(l.addToJourney)}" aria-label="${esc(l.addToJourney)}">${icon('plus')}${options.inJourney > 0 ? `<span class="lib-count" aria-label="${esc(l.inJourney(options.inJourney))}">${String(options.inJourney)}</span>` : ''}</button>`
    : '';
  const used =
    block.usedBy.length > 0 ? `<small class="mu lib-used">${esc(l.usedIn(block.usedBy.length))}</small>` : '';
  return `<li class="lib-card${options.opened ? ' open' : ''}${options.compact ? ' compact' : ''}" data-block="${esc(block.name)}">
<div class="lib-card-h"><span class="lib-cube" aria-hidden="true">${icon('cube')}</span><h3><button class="lib-title" data-action="lib-open" data-block="${esc(block.name)}" aria-haspopup="dialog"${options.opened ? ' aria-current="true"' : ''}>${esc(block.name)}</button></h3><span class="lib-ver" title="${esc(l.versionLabel)}">${esc(l.version(block.version))}</span></div>
${block.description && !options.compact ? `<p class="lib-desc">${esc(block.description)}</p>` : ''}
${options.compact ? '' : status}
${counts}
${options.compact ? '' : tags}
<div class="lib-card-f">${options.compact ? used : `${date}${used}`}<span class="lib-card-acts">${add}${options.compact ? '' : `<button class="btn small primary lib-openb" data-action="lib-open" data-block="${esc(block.name)}" title="${esc(c.openHint(block.name))}">${esc(c.open)}</button>`}</span></div></li>`;
}

/** La pagination : précédente, numéros, suivante, et le nombre de blocs par page. */
export function pager(state: DashboardState, page: number, pages: number, size: number): string {
  const c = catalogText(state);
  const numbers = pageNumbers(page, pages)
    .map((value) =>
      value === 'gap'
        ? '<span class="lib-gap" aria-hidden="true">…</span>'
        : `<button type="button" class="lib-pg${value === page ? ' on' : ''}" data-action="lib-page" data-page="${String(value)}" aria-label="${esc(c.page(value))}"${value === page ? ' aria-current="page"' : ''}>${String(value)}</button>`,
    )
    .join('');
  return `<nav class="lib-pager" aria-label="${esc(c.pageLabel)}"><button type="button" class="lib-pg" data-action="lib-page" data-page="${String(page - 1)}" aria-label="${esc(c.previous)}"${page <= 1 ? ' disabled' : ''}>‹</button>${numbers}<button type="button" class="lib-pg" data-action="lib-page" data-page="${String(page + 1)}" aria-label="${esc(c.next)}"${page >= pages ? ' disabled' : ''}>›</button><label class="lib-psize"><span class="sr">${esc(c.perPageLabel)}</span><select data-lib="pageSize">${PAGE_SIZES.map((value) => `<option value="${String(value)}"${value === size ? ' selected' : ''}>${esc(c.perPage(value))}</option>`).join('')}</select></label></nav>`;
}

export const CATALOG_CSS = `
.lib-catalog{display:flex;flex-direction:column;gap:12px;min-width:0}
.lib-found{margin:0;font-size:13px;color:var(--qa-color-muted)}
.lib-cards.grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))}
.lib-card{gap:8px}
.lib-card-h{display:flex;align-items:center;gap:8px;min-width:0}
.lib-card-h h3{margin:0;flex:1;min-width:0;font-size:14.5px}
.lib-card-h .lib-title{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.lib-cube{display:inline-flex;color:#5B4BCF;flex:none}
.lib-cube .ico{width:20px;height:20px}
.lib-card .lib-desc{margin:0;font-size:12.5px;color:var(--qa-color-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lib-card>.lib-state{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;padding:2px 9px}
.lib-card>.lib-state .lib-ok{display:inline-flex}
.lib-card>.lib-state .ico{width:13px;height:13px}
.lib-counts{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;font-size:12.5px;color:var(--qa-color-text)}
.lib-counts span{display:inline-flex;align-items:center;gap:4px}
.lib-counts .ico{width:14px;height:14px;color:var(--qa-color-muted)}
.lib-tags{display:flex;flex-wrap:wrap;gap:6px;margin:0}
.lib-tag{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11.5px;background:color-mix(in srgb,var(--qa-color-border) 45%,transparent);color:var(--qa-color-text);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lib-tag.origin{background:color-mix(in srgb,#5B4BCF 12%,transparent);color:#4338CA}
.lib-card-f{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:8px;border-top:1px solid var(--qa-color-border)}
.lib-when{display:inline-flex;align-items:center;gap:4px;color:var(--qa-color-muted)}
.lib-when .ico{width:13px;height:13px}
.lib-card-acts{display:inline-flex;gap:6px;align-items:center;margin-left:auto}
.lib-card.open{border-color:var(--qa-color-primary);box-shadow:0 0 0 2px var(--qa-color-primary-soft)}
.lib-card.compact{padding:8px 10px;gap:4px}
.lib-card.compact .lib-counts{font-size:11.5px;gap:2px 10px}
.lib-card.compact .lib-card-f{padding-top:4px}
.lib-cards.list .lib-state,.lib-cards.list .lib-tags{display:none}
.lib-cards.list .lib-counts{grid-column:1}
.lib-pager{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.lib-pg{min-width:32px;height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);color:var(--qa-color-text);cursor:pointer;font:inherit}
.lib-pg.on{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:#fff;font-weight:600}
.lib-pg:disabled{opacity:.45;cursor:default}
.lib-gap{color:var(--qa-color-muted)}
.lib-psize{margin-left:auto}
.lib-psize select{height:32px;border-radius:8px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);color:var(--qa-color-text);padding:0 8px;font:inherit}
.lib-split{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:14px;align-items:start;min-width:0}
.lib-split-list{display:flex;flex-direction:column;gap:8px;min-width:0;max-height:calc(100vh - 260px);overflow:auto;padding-right:2px}
.lib-split-list .lib-cards{display:flex;flex-direction:column;gap:8px}
.lib-sheet.docked{position:static;inset:auto;width:auto;max-width:none;height:auto;max-height:calc(100vh - 220px);overflow:auto;box-shadow:none;border:1px solid var(--qa-color-border);border-radius:12px;transform:none;animation:none;z-index:auto}
.lib-sheet.docked>*{flex-shrink:0}
@media (max-width: 900px){.lib-split{grid-template-columns:1fr}.lib-split-list{max-height:none}}
`;
