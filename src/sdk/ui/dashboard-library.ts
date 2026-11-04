import type { BlockState, LibraryBlockView, ScenarioView } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import {
  emptyJourneyUi,
  journeyActions,
  journeyComposer,
  journeyDiagnostics,
  journeySide,
  journeyText,
  type JourneyUi,
} from './dashboard-journey.js';
import { blockSheet, type BlockSheet } from './dashboard-library-sheet.js';
import {
  catalogCard,
  catalogText,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  pageOf,
  pager,
} from './dashboard-library-catalog.js';
import { header, icon, visibleBrowserControl } from './dashboard-parts.js';
import { wizardView, type WizardUi } from './dashboard-library-wizard.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA BIBLIOTHÈQUE DE SCÉNARIOS : un catalogue de blocs réutilisables (jamais exécutés seuls) et, sous lui,
 * le compositeur visuel de parcours (dashboard-journey : palette, mode linéaire ou diagramme, propriétés
 * et diagnostics). Le catalogue (grille ou liste, regroupé par origine, récemment ouverts) se cherche et se
 * trie sur les données réelles des blocs (type autonome ou composé, origine, état du contrat,
 * utilisation) ; chaque carte compacte dit la version, les étapes, les groupes internes, les entrées et
 * sorties, l'origine et la date. La fiche d'un bloc s'ouvre dans un panneau à onglets
 * (dashboard-library-sheet). L'ajout
 * d'un scénario se fait dans un panneau latéral, avec l'aperçu de la source. L'insertion d'un bloc dans
 * un scénario existant reste dans l'écran Scénarios. Des fonctions pures.
 */
export type OriginChoice = 'ALL' | 'scenario' | 'recording' | 'none';
export type UsageChoice = 'ALL' | 'used' | 'free';
export type SortChoice = 'name' | 'steps' | 'usage' | 'updated';
export type KindChoice = 'ALL' | 'standalone' | 'composite';
export type LayoutChoice = 'grid' | 'list';
export type GroupChoice = 'none' | 'origin';

/** Les blocs ouverts récemment (noms), gardés par le navigateur de chaque personne. */
export const RECENT_MAX = 5;

export interface LibraryUi {
  blocks?: LibraryBlockView[];
  /** Recherche et critères du catalogue. */
  query: string;
  origin: OriginChoice;
  state: 'ALL' | BlockState;
  usage: UsageChoice;
  sort: SortChoice;
  kind: KindChoice;
  layout: LayoutChoice;
  groupBy: GroupChoice;
  /** La page du catalogue (1…n) et le nombre de blocs par page. */
  page: number;
  pageSize: number;
  recent: string[];
  /** La fiche ouverte (panneau à onglets). */
  sheet?: BlockSheet;
  /** Le compositeur visuel : le parcours édité (mode linéaire ou diagramme), sa vérification, son historique. */
  journey: JourneyUi;
  /** L'onglet de la page : le catalogue, le compositeur (par défaut) ou les diagnostics du parcours. */
  tab: 'catalog' | 'composer' | 'diagnostics';
  /** Les panneaux latéraux : absents = selon la largeur de l'écran ; vrai/faux = choix de l'utilisateur. */
  recentOpen?: boolean;
  propsOpen?: boolean;
  /** Le compositeur agrandi : les deux panneaux latéraux réduits. */
  wide?: boolean;
  /** La fenêtre « Ajouter un bloc » (assistant en quatre étapes). */
  wizard?: WizardUi;

  /** La déclaration du contrat d'un bloc en cours (listes de clés et de conditions, en texte). */
  contract?: {
    block: string;
    required: string;
    optional: string;
    outputs: string;
    pre: string;
    post: string;
  };
  /** Insérer un bloc dans le scénario affiché (écran Scénarios). */
  insert: { block: string; at: 'start' | 'end' };
  /** Le dernier parcours créé par le compositeur : il se rejoue d'ici (navigateur visible au choix). */
  composed?: string;
  /** Le groupe d'un enregistrement en cours d'ajout (revue), et le nom proposé. */
  group?: { id: string; name: string };
  confirmRemove?: string;
  busy?: boolean;
  error?: string;
  /** Les raisons détaillées d'un refus du serveur (une par ligne). */
  details?: string[];
  notice?: string;
}

export const emptyLibraryUi = (): LibraryUi => ({
  query: '',
  origin: 'ALL',
  state: 'ALL',
  usage: 'ALL',
  sort: 'name',
  kind: 'ALL',
  layout: 'grid',
  groupBy: 'none',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  recent: [],
  journey: emptyJourneyUi(),
  tab: 'composer',
  insert: { block: '', at: 'start' },
});

/** « Navigateur visible » et son ralenti, à côté d'un Rejouer (le même choix que le lancement d'une exécution). */
export function replayVisibility(state: DashboardState): string {
  return visibleBrowserControl(
    state.t.visibleBrowser,
    { headed: state.launch.headed === true, slowMoMs: state.launch.slowMoMs ?? 0 },
    {
      attr: 'data-bind',
      available: state.capabilities?.visibleBrowser === true,
      disabled: state.launch.busy,
    },
  );
}

/** Les scénarios qu'on lance : les blocs de la bibliothèque n'en sont pas (jamais exécutés seuls). */
export const runnableScenarios = (scenarios: readonly ScenarioView[]): ScenarioView[] =>
  scenarios.filter((scenario) => !scenario.reusable);

const originOf = (block: LibraryBlockView): Exclude<OriginChoice, 'ALL'> => block.origin?.kind ?? 'none';

/** Un bloc composé garde plusieurs groupes métier ; les autres sont autonomes. */
export const kindOf = (block: LibraryBlockView): Exclude<KindChoice, 'ALL'> =>
  (block.groups?.length ?? 0) > 1 || block.origin?.mode === 'composite' ? 'composite' : 'standalone';

/** Les blocs du catalogue, cherchés et triés sur leurs données réelles. */
export function visibleBlocks(ui: LibraryUi): LibraryBlockView[] {
  const query = ui.query.trim().toLowerCase();
  const shown = (ui.blocks ?? []).filter(
    (block) =>
      (!query ||
        block.name.toLowerCase().includes(query) ||
        (block.description ?? '').toLowerCase().includes(query) ||
        (block.origin?.name ?? '').toLowerCase().includes(query) ||
        (block.groups ?? []).some((group) => group.name.toLowerCase().includes(query))) &&
      (ui.kind === 'ALL' || kindOf(block) === ui.kind) &&
      (ui.origin === 'ALL' || originOf(block) === ui.origin) &&
      (ui.state === 'ALL' || block.state === ui.state) &&
      (ui.usage === 'ALL' || (ui.usage === 'used') === block.usedBy.length > 0),
  );
  const by: Record<SortChoice, (a: LibraryBlockView, b: LibraryBlockView) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    steps: (a, b) => b.steps - a.steps || a.name.localeCompare(b.name),
    usage: (a, b) => b.usedBy.length - a.usedBy.length || a.name.localeCompare(b.name),
    updated: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name),
  };
  return [...shown].sort(by[ui.sort]);
}

const STATE_TONE: Record<BlockState, string> = { VALID: 'ok', CHANGED: 'warn', INVALID: 'ko' };

export function stateBadge(state: DashboardState, value: BlockState): string {
  return `<span class="lib-state ${STATE_TONE[value]}">${esc(state.t.lib.states[value])}</span>`;
}

export function keys(
  state: DashboardState,
  label: string,
  items: readonly { key: string; required?: boolean; dynamic?: boolean }[],
): string {
  const l = state.t.lib;
  const chips = items
    .slice(0, 4)
    .map(
      (item) =>
        `<code class="lib-key${item.required === false ? ' opt' : ''}"${item.required === false ? ` title="${esc(l.optional)}"` : item.dynamic ? ` title="${esc(l.dynamic)}"` : ''}>${esc(item.key)}${item.dynamic ? ' ⟳' : ''}</code>`,
    )
    .join('');
  const more = items.length > 4 ? `<small class="mu">+${String(items.length - 4)}</small>` : '';
  return `<span class="lib-io">${label ? `<span class="lib-io-l">${esc(label)}</span>` : ''}${chips || `<small class="mu">${esc(l.none)}</small>`}${more}</span>`;
}

export function originText(state: DashboardState, block: LibraryBlockView): string {
  const l = state.t.lib;
  return block.origin
    ? block.origin.journey
      ? l.fromJourney(block.origin.journey)
      : block.origin.kind === 'scenario'
        ? l.fromScenario(block.origin.name)
        : (block.origin.groups?.length ?? 0) > 1
          ? l.fromRecordingGroups(block.origin.name, block.origin.groups ?? [])
          : l.fromRecording(block.origin.name, block.origin.group ?? '')
    : l.unknownOrigin;
}

/** La carte compacte d'un bloc : de quoi le choisir sans ouvrir sa fiche. */
/** La carte d'un bloc : celle du catalogue (`dashboard-library-catalog`), avec son état dans le parcours. */
function blockCard(
  state: DashboardState,
  block: LibraryBlockView,
  publish: boolean,
  compact = false,
): string {
  const ui = state.lib;
  return catalogCard(state, block, {
    publish,
    opened: ui.sheet?.block === block.name,
    inJourney: ui.journey.journey.graph.nodes.filter((node) => node.block === block.name).length,
    compact,
    origin: {
      text: block.origin
        ? block.origin.kind === 'recording'
          ? state.t.lib.originRecording(block.origin.name)
          : state.t.lib.originScenario(block.origin.name)
        : state.t.lib.unknownOrigin,
      title: originText(state, block),
    },
  });
}

/** Le catalogue, regroupé par origine si demandé (un enregistrement, un scénario, sans origine). */
function catalogList(
  state: DashboardState,
  shown: readonly LibraryBlockView[],
  publish: boolean,
  compact = false,
): string {
  const l = state.t.lib;
  const ui = state.lib;
  const list = (blocks: readonly LibraryBlockView[]): string =>
    `<ul class="plain lib-cards ${compact ? 'list compact' : ui.layout}">${blocks.map((block) => blockCard(state, block, publish, compact)).join('')}</ul>`;
  if (ui.groupBy === 'none' || compact) return list(shown);
  const groups = new Map<string, LibraryBlockView[]>();
  for (const block of shown) {
    const title = block.origin
      ? block.origin.kind === 'recording'
        ? l.originRecording(block.origin.name)
        : l.originScenario(block.origin.name)
      : l.unknownOrigin;
    groups.set(title, [...(groups.get(title) ?? []), block]);
  }
  return [...groups.entries()]
    .map(
      ([title, blocks]) =>
        `<section class="lib-bucket"><h3 class="lib-bucket-t">${esc(title)} <small class="mu">${String(blocks.length)}</small></h3>${list(blocks)}</section>`,
    )
    .join('');
}

function select(
  label: string,
  field: string,
  current: string,
  options: readonly (readonly [string, string])[],
): string {
  // Un critère compact : son nom puis sa valeur, dans une pastille ; marqué quand il restreint le catalogue.
  const narrowed = options[0] !== undefined && current !== options[0][0] && field !== 'sort';
  return `<label class="lib-crit${narrowed ? ' on' : ''}"><span class="lib-crit-l">${esc(label)}</span><select data-lib="${field}">${options
    .map(
      ([value, text]) =>
        `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(text)}</option>`,
    )
    .join('')}</select></label>`;
}

export function libraryView(state: DashboardState): string {
  const t = state.t;
  const l = t.lib;
  const p = state.project;
  if (!p)
    return `${header(esc(l.title))}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const ui = state.lib;
  const all = ui.blocks ?? [];
  const publish = can(state, 'PUBLISH') && p.state !== 'ARCHIVED';
  const shown = visibleBlocks(ui);
  // Seuls les choix que les données permettent : une origine, un état qui existent.
  const origins = (['scenario', 'recording', 'none'] as const).filter((origin) =>
    all.some((block) => originOf(block) === origin),
  );
  const states = (['VALID', 'CHANGED', 'INVALID'] as const).filter((value) =>
    all.some((block) => block.state === value),
  );
  const kinds = (['standalone', 'composite'] as const).filter((value) =>
    all.some((block) => kindOf(block) === value),
  );
  const sheetOpen = ui.sheet !== undefined && all.some((block) => block.name === ui.sheet?.block);
  const recent = ui.recent
    .map((name) => all.find((block) => block.name === name))
    .filter((block): block is LibraryBlockView => block !== undefined);
  const toolbar =
    all.length === 0
      ? ''
      : `<div class="lib-bar" role="search"><label class="lib-search">${icon('search')}<span class="sr">${esc(l.search)}</span><input type="search" data-lib="query" value="${esc(ui.query)}" placeholder="${esc(l.searchPlaceholder)}" autocomplete="off"></label><div class="lib-crits">${select(
          l.originLabel,
          'origin',
          ui.origin,
          [['ALL', l.origins.ALL], ...origins.map((origin) => [origin, l.origins[origin]] as const)],
        )}${select(l.stateLabel, 'state', ui.state, [
          ['ALL', l.statesAll],
          ...states.map((value) => [value, l.states[value]] as const),
        ])}${
          kinds.length > 1
            ? select(l.kindLabel, 'kind', ui.kind, [
                ['ALL', l.kinds.ALL],
                ...kinds.map((value) => [value, l.kinds[value]] as const),
              ])
            : ''
        }${select(l.usageLabel, 'usage', ui.usage, [
          ['ALL', l.usages.ALL],
          ['used', l.usages.used],
          ['free', l.usages.free],
        ])}${select(l.sortLabel, 'sort', ui.sort, [
          ['name', l.sorts.name],
          ['steps', l.sorts.steps],
          ['usage', l.sorts.usage],
          ['updated', l.sorts.updated],
        ])}${select(l.groupByLabel, 'groupBy', ui.groupBy, [
          ['none', l.groupBys.none],
          ['origin', l.groupBys.origin],
        ])}</div>${
          ui.tab === 'catalog'
            ? `<span class="ed-seg lib-layouts" role="radiogroup" aria-label="${esc(l.layoutLabel)}">${(
                ['grid', 'list'] as const
              )
                .map(
                  (value) =>
                    `<button role="radio" aria-checked="${String(ui.layout === value)}" data-action="lib-layout" data-layout="${value}">${esc(value === 'grid' ? l.layoutGrid : l.layoutList)}</button>`,
                )
                .join('')}</span>`
            : ''
        }<small class="mu lib-shown" role="status">${esc(l.shown(shown.length, all.length))}</small></div>`;
  // La page du catalogue (la fiche ouverte à côté garde la même page, la même recherche et les mêmes critères).
  const c = catalogText(state);
  const paged = pageOf(shown, ui.page, ui.pageSize);
  const docked = sheetOpen && ui.tab === 'catalog' && ui.sheet?.docked === true;
  // La pagination dès qu'un catalogue dépasse la plus petite page (le nombre par page reste réglable).
  const pageable = shown.length > PAGE_SIZES[0];
  const catalog =
    ui.blocks === undefined
      ? ui.error
        ? `<div class="lib-blank"><p class="err" role="alert">${esc(c.error)} ${esc(ui.error)}</p><button class="btn small" data-action="lib-reload">${esc(c.retry)}</button></div>`
        : `<div class="lib-blank" role="status"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(c.loading)}</p></div>`
      : all.length === 0
        ? `<div class="lib-blank"><p>${esc(l.empty)}</p>${publish ? `<button class="btn primary" data-action="lib-panel-open">${icon('plus')}<span>${esc(l.addBlock)}</span></button>` : ''}</div>`
        : shown.length === 0
          ? `<div class="lib-blank"><p class="mu">${esc(l.noMatch)}</p><button class="btn small ghost" data-action="lib-clear">${esc(l.clear)}</button></div>`
          : `<p class="lib-found" role="status">${esc(paged.pages > 1 ? c.range(paged.from, paged.to, shown.length) : c.found(shown.length))}</p>${
              docked
                ? `<div class="lib-split"><div class="lib-split-list">${catalogList(state, paged.items, publish, true)}${pageable ? pager(state, paged.page, paged.pages, ui.pageSize) : ''}</div>${blockSheet(state, { docked: true })}</div>`
                : `${catalogList(state, paged.items, publish)}${pageable ? pager(state, paged.page, paged.pages, ui.pageSize) : ''}`
            }`;
  const details = ui.details ?? [];
  // Le parcours tout juste créé se rejoue d'ici, avec ou sans navigateur visible.
  const composed =
    ui.composed && runnableScenarios(p.scenarios).some((scenario) => scenario.name === ui.composed)
      ? ui.composed
      : undefined;
  const replay =
    composed && can(state, 'RUN') && p.state !== 'ARCHIVED'
      ? `<div class="form-acts start lib-replay"><button class="btn primary" data-action="replay-scenario" data-name="${esc(composed)}" ${state.launch.busy ? 'disabled' : ''} aria-busy="${String(state.launch.busy)}">${icon('play')}<span>${esc(l.replayComposed(composed))}</span></button>${replayVisibility(state)}</div>${state.launch.error && state.launch.scenarios.includes(composed) ? `<p class="err" role="alert">${esc(state.launch.error)}</p>` : ''}`
      : '';
  const messages = `${ui.error ? `<div class="err" role="alert"><p>${esc(ui.error)}</p>${details.length > 1 ? `<ul class="plain tight">${details.map((detail) => `<li>${esc(detail)}</li>`).join('')}</ul>` : ''}</div>` : ''}${ui.notice ? `<p class="notice ok" role="status">${icon('check')}<span>${esc(ui.notice)}</span></p>` : ''}${replay}`;
  const actions = publish
    ? `<button class="btn primary" data-action="lib-panel-open">${icon('plus')}<span>${esc(l.addBlock)}</span></button>`
    : '';
  const jt = journeyText(state);
  const current = all.length === 0 ? 'catalog' : ui.tab;
  const tabs = (
    [
      ['catalog', 'library', jt.tabCatalog],
      ['composer', 'cube', jt.tabComposer],
      ['diagnostics', 'tests', jt.tabDiagnostics],
    ] as const
  )
    .map(
      ([tab, ico, label]) =>
        `<button type="button" role="tab" id="lib-tab-${tab}" class="lib-tab" data-action="jn-tab" data-tab="${tab}" aria-selected="${String(current === tab)}" aria-controls="lib-tabpanel"${current === tab ? '' : ' tabindex="-1"'}>${icon(ico)}<span>${esc(label)}</span></button>`,
    )
    .join('');
  // Une bibliothèque vide s'ouvre sur le catalogue : son état vide propose d'ajouter un premier bloc.
  const tab = all.length === 0 ? 'catalog' : ui.tab;
  const main =
    tab === 'catalog'
      ? `<section class="lib-catalog" aria-label="${esc(l.blocksTitle)}">${catalog}</section>`
      : tab === 'diagnostics'
        ? journeyDiagnostics(state)
        : journeyComposer(state, publish);
  // Les panneaux latéraux : réduits à un rail sur demande, ou selon la largeur (classes « auto »).
  const recentState = ui.wide
    ? 'closed'
    : ui.recentOpen === undefined
      ? 'auto'
      : ui.recentOpen
        ? 'open'
        : 'closed';
  // Dans l'onglet Catalogue, les propriétés du parcours n'ont rien à montrer : ni panneau ni rail, le
  // catalogue (et la fiche ouverte à côté) prend la largeur.
  const propsState = ui.wide || tab === 'catalog' ? 'closed' : ui.propsOpen === false ? 'closed' : 'open';
  const recentCard = recent[0];
  const recentCol = `<aside class="lib-recent-col" aria-labelledby="lib-rec-t"><div class="lib-col-h"><h3 id="lib-rec-t">${esc(l.recentTitle)}</h3><button type="button" class="btn small ghost icon-only" data-action="jn-panel" data-panel="recent" data-open="0" aria-label="${esc(jt.recentHide)}" title="${esc(jt.recentHide)}">${icon('back')}</button></div>${
    recent.length > 0
      ? `<nav class="lib-recent" aria-label="${esc(l.recentTitle)}">${recent.map((block) => `<button class="chip" data-action="lib-open" data-block="${esc(block.name)}">${esc(block.name)}</button>`).join('')}</nav>${recentCard ? `<ul class="plain lib-cards mini">${blockCard(state, recentCard, publish, true)}</ul>` : ''}`
      : `<p class="mu small">${esc(l.recentEmpty)}</p>`
  }</aside><div class="lib-rail recent"><button type="button" class="btn small ghost icon-only" data-action="jn-panel" data-panel="recent" data-open="1" aria-label="${esc(jt.recentShow)}" title="${esc(jt.recentShow)}">${icon('chevron')}</button></div>`;
  const side =
    tab === 'catalog'
      ? ''
      : propsState === 'open'
        ? journeySide(state, publish)
        : `<div class="lib-rail props"><button type="button" class="btn small ghost icon-only" data-action="jn-panel" data-panel="props" data-open="1" aria-label="${esc(jt.propsShow)}" title="${esc(jt.propsShow)}">${icon('back')}</button></div>`;
  const top = `<div class="lib-top">${toolbar}${journeyActions(state, publish)}</div>`;
  return `${header(esc(l.title), { sub: esc(l.sub(p.name, all.length)), actions })}<p class="mu lib-intro">${esc(l.intro)}</p>${sheetOpen ? '' : messages}<div class="jn" id="lib-composer" data-mode="${ui.journey.journey.mode}">${top}<div class="lib-shell recent-${recentState} props-${propsState}">${recentCol}<section class="lib-main"><div class="lib-tabs" role="tablist" aria-label="${esc(l.title)}">${tabs}</div><div class="lib-tabpanel" id="lib-tabpanel" role="tabpanel" aria-labelledby="lib-tab-${tab}">${main}</div></section>${side}</div></div>${wizardView(state)}${ui.sheet?.docked ? '' : blockSheet(state)}`;
}

/** L'insertion d'un bloc dans le scénario affiché (écran Scénarios). */
export function insertBlockForm(state: DashboardState, scenario: ScenarioView): string {
  const l = state.t.lib;
  const ui = state.lib;
  const blocks = (ui.blocks ?? []).filter((block) => block.name !== scenario.name);
  if (
    !can(state, 'PUBLISH') ||
    state.project?.state === 'ARCHIVED' ||
    blocks.length === 0 ||
    scenario.format !== 'yaml'
  )
    return '';
  const disabled = ui.busy ? 'disabled' : '';
  return `<form class="col lib-insert" data-action="lib-insert" data-scenario="${esc(scenario.name)}"${scenario.revision ? ` data-revision="${esc(scenario.revision)}"` : ''}><h3 class="section-t">${esc(l.insertTitle)}</h3><div class="fields"><label class="field">${esc(l.pickBlock)}<select data-lib="insert.block">${blocks
    .map(
      (block) =>
        `<option value="${esc(block.name)}" ${(ui.insert.block || blocks[0]?.name) === block.name ? 'selected' : ''}>${esc(block.name)}</option>`,
    )
    .join(
      '',
    )}</select></label><label class="field">${esc(l.insertAt)}<select data-lib="insert.at"><option value="start" ${ui.insert.at === 'start' ? 'selected' : ''}>${esc(l.atStart)}</option><option value="end" ${ui.insert.at === 'end' ? 'selected' : ''}>${esc(l.atEnd)}</option></select></label></div><div class="form-acts start"><button type="submit" class="btn" ${disabled}>${esc(l.insert)}</button></div></form>`;
}

/** Un parcours suivi dont un bloc a changé : le dire, et proposer d'accepter la nouvelle version. */
export function scenarioDrift(state: DashboardState, scenario: ScenarioView): string {
  const l = state.t.lib;
  const changed = (state.lib.blocks ?? []).flatMap((block) =>
    block.pinnedBy
      .filter((pin) => pin.scenario === scenario.name && !pin.current)
      .map((pin) => ({ block, pin })),
  );
  if (changed.length === 0) return '';
  const publish = can(state, 'PUBLISH') && state.project?.state !== 'ARCHIVED';
  const pending = changed.some(({ block }) => block.state !== 'VALID');
  return `<div class="lib-drift" role="note">${icon('alert')}<div><b>${esc(l.driftTitle)}</b><ul class="plain tight">${changed
    .map(
      ({ block, pin }) =>
        `<li>${esc(block.state === 'VALID' ? l.driftLine(block.name, pin.version, block.version) : l.driftPending(block.name, pin.version))}</li>`,
    )
    .join('')}</ul>${
    pending
      ? `<small class="mu">${esc(l.driftValidateFirst)}</small>`
      : publish
        ? `<button class="btn small" data-action="lib-accept" data-name="${esc(scenario.name)}" ${state.lib.busy ? 'disabled' : ''}>${esc(l.accept)}</button>`
        : ''
  }</div></div>`;
}
