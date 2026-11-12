import type { Evidence, MapPage, UnresolvedCause, UnresolvedPage } from '../core/cartography.js';
import { esc } from './view.js';

/**
 * L'ONGLET « LIENS NON RÉSOLUS » : les relations lues dans le code mais non raccordées au graphe (cible
 * absente des sources, cible non trouvée par le résolveur, relation d'un élément vers lui-même). Elles ne
 * sont jamais présentées comme des liens du parcours : l'onglet dit où une chaîne s'arrête, pourquoi, et
 * où le code l'écrit. Une rupture n'est jamais masquée derrière un parcours artificiellement complet.
 */
export interface UnresolvedUi {
  unresolved?: UnresolvedPage;
  uPage: number;
  uCause: string;
  uQuery: string;
}

export const emptyUnresolved = (): UnresolvedUi => ({ uPage: 1, uCause: '', uQuery: '' });

const CAUSES: readonly UnresolvedCause[] = [
  'TARGET_MISSING',
  'SOURCE_MISSING',
  'BOTH_MISSING',
  'TARGET_UNKNOWN',
  'SELF',
];

const TEXT = {
  fr: {
    title: 'Liens non résolus',
    intro:
      'Relations lues dans le code mais non raccordées au graphe. Elles ne font partie d’aucun parcours ; chacune dit pourquoi et où le code l’écrit.',
    cause: 'Cause',
    all: 'Toutes les causes',
    search: 'Rechercher (origine, cible, raison)',
    kind: 'Relation',
    from: 'Origine',
    to: 'Cible',
    why: 'Pourquoi',
    where: 'Preuve',
    none: 'Aucun lien non résolu dans ce scan.',
    noneFiltered: 'Aucun lien non résolu pour ces critères.',
    total: (n: number) => `${String(n)} lien(s) non résolu(s)`,
    uncounted: (n: number) => `${String(n)} autre(s) seulement compté(s) (au-delà de la limite gardée)`,
    causes: {
      TARGET_MISSING: 'Cible absente des sources',
      SOURCE_MISSING: 'Origine absente des sources',
      BOTH_MISSING: 'Origine et cible absentes',
      TARGET_UNKNOWN: 'Cible non trouvée par le résolveur',
      SELF: 'Relation vers lui-même',
    } satisfies Record<UnresolvedCause, string>,
    unknownTarget: 'inconnue',
  },
  en: {
    title: 'Unresolved links',
    intro:
      'Relations read in the code but not attached to the graph. They belong to no journey; each one says why and where the code writes it.',
    cause: 'Cause',
    all: 'All causes',
    search: 'Search (source, target, reason)',
    kind: 'Relation',
    from: 'Source',
    to: 'Target',
    why: 'Why',
    where: 'Evidence',
    none: 'No unresolved link in this scan.',
    noneFiltered: 'No unresolved link for these criteria.',
    total: (n: number) => `${String(n)} unresolved link(s)`,
    uncounted: (n: number) => `${String(n)} more only counted (beyond the kept limit)`,
    causes: {
      TARGET_MISSING: 'Target not in the sources',
      SOURCE_MISSING: 'Source not in the sources',
      BOTH_MISSING: 'Source and target missing',
      TARGET_UNKNOWN: 'Target not found by the resolver',
      SELF: 'Relation to itself',
    } satisfies Record<UnresolvedCause, string>,
    unknownTarget: 'unknown',
  },
};

/** Le nom lisible d'un identifiant de nœud (`METHOD:front:Store#load` → `Store#load`). */
const shortId = (id: string): string => id.split(':').slice(2).join(':') || id;

export function unresolvedTab(
  ui: UnresolvedUi,
  helpers: {
    locale: 'fr' | 'en';
    evidence: (e: Evidence) => string;
    pager: (list: string, page: MapPage<unknown>, sizes: readonly number[]) => string;
    spinner: () => string;
    loading: boolean;
    error?: string;
    paneError: (error: string) => string;
  },
): string {
  const t = TEXT[helpers.locale];
  const page = ui.unresolved;
  const filters = `<div class="map-filters"><label class="pick">${esc(t.cause)} <select data-map="u-cause"><option value="">${esc(t.all)}</option>${CAUSES.map((c) => `<option value="${c}" ${c === ui.uCause ? 'selected' : ''}>${esc(t.causes[c])}${page?.byCause[c] ? ` (${String(page.byCause[c])})` : ''}</option>`).join('')}</select></label><input type="search" data-map="u-q" value="${esc(ui.uQuery)}" placeholder="${esc(t.search)}" aria-label="${esc(t.search)}"></div>`;
  let body: string;
  if (helpers.error) body = helpers.paneError(helpers.error);
  else if (!page) body = helpers.loading ? helpers.spinner() : '';
  else if (page.total === 0)
    body = `<p class="mu">${esc(ui.uCause || ui.uQuery ? t.noneFiltered : t.none)}</p>`;
  else {
    const rows = page.items
      .map(
        (u) =>
          `<tr data-unresolved="${esc(u.id)}"><td><span class="chip">${esc(u.kind)}</span></td><td class="mono">${esc(shortId(u.from))}</td><td class="mono">${u.to === '?' ? `<em>${esc(t.unknownTarget)}</em>` : esc(shortId(u.to))}</td><td><span class="chip warn">${esc(t.causes[u.cause])}</span><div class="mu small">${esc(u.reason)}</div></td><td>${u.evidence[0] ? helpers.evidence(u.evidence[0]) : ''}${u.evidence.length > 1 ? `<span class="mu small"> +${String(u.evidence.length - 1)}</span>` : ''}</td></tr>`,
      )
      .join('');
    body = `<p class="mu small">${esc(t.total(page.total))}${page.uncounted ? ` · ${esc(t.uncounted(page.uncounted))}` : ''}</p><div class="tablewrap"><table class="map-unresolved"><thead><tr><th>${esc(t.kind)}</th><th>${esc(t.from)}</th><th>${esc(t.to)}</th><th>${esc(t.why)}</th><th>${esc(t.where)}</th></tr></thead><tbody>${rows}</tbody></table></div>${helpers.pager('unresolved', page, [20, 50, 100])}`;
  }
  return `<section class="card map-unresolved-card"><div class="card-h"><h2>${esc(t.title)}</h2></div><p class="mu">${esc(t.intro)}</p>${filters}${body}</section>`;
}
