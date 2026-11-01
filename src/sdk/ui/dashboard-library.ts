import type {
  BlockState,
  CompositionCheck,
  LibraryBlockView,
  LibrarySourcePreview,
  ScenarioView,
} from '../core/contracts.js';
import { can } from './dashboard-access.js';
import { blockSheet, type BlockSheet } from './dashboard-library-sheet.js';
import { header, icon, visibleBrowserControl } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA BIBLIOTHÈQUE DE SCÉNARIOS : un catalogue de blocs réutilisables (jamais exécutés seuls) et un
 * compositeur de parcours, en trois colonnes : le catalogue, le parcours, son contrat et ses
 * diagnostics. Le catalogue (grille ou liste, regroupé par origine, récemment ouverts) se cherche et se
 * trie sur les données réelles des blocs (type autonome ou composé, origine, état du contrat,
 * utilisation) ; chaque carte compacte dit la version, les étapes, les groupes internes, les entrées et
 * sorties, l'origine et la date. La fiche d'un bloc s'ouvre dans un panneau à onglets
 * (dashboard-library-sheet). Le compositeur garde l'ordre des blocs, montre d'où vient chaque entrée et
 * la vérification du serveur (dry run de composition) à chaque changement, avant la création. L'ajout
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
  recent: string[];
  /** La fiche ouverte (panneau à onglets). */
  sheet?: BlockSheet;
  /** Composer un parcours : son nom, les blocs choisis dans l'ordre. */
  compose: { name: string; parts: string[] };
  /** La dernière vérification du serveur, et pour quelle composition (nom et blocs). */
  check?: CompositionCheck;
  checkedFor?: string;
  checking?: boolean;
  creating?: boolean;
  /** Le panneau d'ajout d'un bloc (scénario source, nom, description) et l'aperçu de la source. */
  panel?: {
    scenario: string;
    name: string;
    description: string;
    preview?: LibrarySourcePreview;
    previewFor?: string;
    loading?: boolean;
    error?: string;
    busy?: boolean;
  };
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
  recent: [],
  compose: { name: '', parts: [] },
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

/** La composition vérifiée : la vérification ne vaut que pour ce nom et ces blocs, dans cet ordre. */
export const compositionKey = (compose: LibraryUi['compose']): string =>
  JSON.stringify([compose.name.trim(), compose.parts]);

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
    ? block.origin.kind === 'scenario'
      ? l.fromScenario(block.origin.name)
      : (block.origin.groups?.length ?? 0) > 1
        ? l.fromRecordingGroups(block.origin.name, block.origin.groups ?? [])
        : l.fromRecording(block.origin.name, block.origin.group ?? '')
    : l.unknownOrigin;
}

/** La carte compacte d'un bloc : de quoi le choisir sans ouvrir sa fiche. */
function blockCard(state: DashboardState, block: LibraryBlockView, publish: boolean): string {
  const l = state.t.lib;
  const ui = state.lib;
  const opened = ui.sheet?.block === block.name;
  const kind = kindOf(block);
  const when = block.updatedAt ?? block.createdAt;
  const inJourney = ui.compose.parts.filter((part) => part === block.name).length;
  // Un contrat valide est l'état attendu : une coche discrète ; à revalider ou invalide se voit.
  const status =
    block.state === 'VALID'
      ? `<span class="lib-ok" title="${esc(l.states.VALID)}">${icon('check')}<span class="sr">${esc(l.states.VALID)}</span></span>`
      : stateBadge(state, block.state);
  const origin = block.origin
    ? block.origin.kind === 'recording'
      ? l.originRecording(block.origin.name)
      : l.originScenario(block.origin.name)
    : l.unknownOrigin;
  const io = (label: string, items: readonly { key: string; required?: boolean }[]): string =>
    items.length > 0
      ? `<span class="lib-io"><span class="lib-io-l">${esc(label)}</span>${items.map((item) => `<code class="lib-key${item.required === false ? ' opt' : ''}">${esc(item.key)}</code>`).join('')}</span>`
      : '';
  const ios = `${io(l.inputsLabel, block.contract.inputs)}${io(l.outputsLabel, block.contract.outputs)}`;
  return `<li class="lib-card ${kind}${opened ? ' open' : ''}" data-block="${esc(block.name)}">
<div class="lib-card-h"><h3><button class="lib-title" data-action="lib-open" data-block="${esc(block.name)}" aria-haspopup="dialog">${esc(block.name)}</button></h3><span class="lib-ver" title="${esc(l.versionLabel)}">${esc(l.version(block.version))}</span>${status}</div>
${block.description ? `<p class="lib-desc">${esc(block.description)}</p>` : ''}
<p class="lib-meta"><span class="lib-kind ${kind}">${esc(kind === 'composite' ? l.kindComposite(block.groups?.length ?? 0) : l.kindStandalone)}</span><span>${esc(l.steps(block.steps))}</span>${ui.groupBy === 'origin' ? '' : `<span class="lib-origin" title="${esc(originText(state, block))}">${esc(origin)}</span>`}</p>
${ios ? `<div class="lib-ios">${ios}</div>` : `<p class="lib-noio">${esc(l.noIo)}</p>`}
<div class="lib-card-f"><small class="mu">${[
    ...(when ? [l.updatedOn(new Date(when).toLocaleDateString(state.t.locale))] : []),
    ...(block.usedBy.length > 0 ? [l.usedIn(block.usedBy.length)] : []),
  ]
    .map(esc)
    .join(' · ')}</small>${
    publish
      ? `<button class="btn small lib-add" data-action="lib-part-add" data-block="${esc(block.name)}" title="${esc(l.addToJourney)}">${icon('plus')}<span>${esc(l.addShort)}</span>${inJourney > 0 ? `<span class="lib-count" aria-label="${esc(l.inJourney(inJourney))}">${String(inJourney)}</span>` : ''}</button>`
      : ''
  }</div></li>`;
}

/** Le catalogue, regroupé par origine si demandé (un enregistrement, un scénario, sans origine). */
function catalogList(state: DashboardState, shown: readonly LibraryBlockView[], publish: boolean): string {
  const l = state.t.lib;
  const ui = state.lib;
  const list = (blocks: readonly LibraryBlockView[]): string =>
    `<ul class="plain lib-cards ${ui.layout}">${blocks.map((block) => blockCard(state, block, publish)).join('')}</ul>`;
  if (ui.groupBy === 'none') return list(shown);
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

function checkSummary(state: DashboardState, check: CompositionCheck, stale: boolean): string {
  const l = state.t.lib;
  const section = (title: string, items: string[], tone = ''): string =>
    items.length > 0
      ? `<div class="lib-sum ${tone}"><b>${esc(title)}</b><ul class="plain tight">${items.map((item) => `<li>${item}</li>`).join('')}</ul></div>`
      : '';
  // Les erreurs déjà dites par une section (entrée manquante, conflit) ne sont pas répétées.
  const structural = check.errors
    .filter((error) => !error.includes('no earlier block produces it') && !error.startsWith('test data '))
    // Le nom du parcours se donne dans le formulaire : dit dans la langue du Dashboard.
    .map((error) => (error === 'a name of 1 to 80 characters is required' ? l.journeyNameRequired : error));
  // Seul le nom manque (il se donne en dernier) : le parcours tient, ce n'est pas une erreur.
  const nameOnly =
    !check.ok &&
    check.errors.length === 1 &&
    check.errors[0] === 'a name of 1 to 80 characters is required' &&
    check.missing.length === 0 &&
    check.conflicts.length === 0;
  const tone = check.ok ? 'ok' : nameOnly ? 'wait' : 'ko';
  const shown = nameOnly ? [] : structural;
  return `<div class="lib-check ${tone}" role="status">
<p class="lib-check-h">${icon(check.ok || nameOnly ? 'check' : 'alert')}<b>${esc(check.ok ? l.checkOk : nameOnly ? l.checkNeedsName : l.checkKo)}</b></p>
${stale ? `<p class="warn-t">${esc(l.staleCheck)}</p>` : ''}
<p class="mu">${esc(l.summary(check.blocks, check.steps))}${check.order.length > 0 ? ` · ${esc(l.orderLine(check.order.map((entry) => `#${String(entry.position)} ${entry.block}`).join(' → ')))}` : ''}</p>
${section(
  l.deps,
  check.dependencies.map((dep) => esc(l.depLine(dep.key, dep.from, dep.to))),
)}${section(
    l.missingTitle,
    check.missing.map((entry) => esc(l.missingLine(entry.key, entry.block, entry.position))),
    'ko',
  )}${section(
    l.conflictsTitle,
    check.conflicts.map(
      (conflict) =>
        `${esc(l.conflictLine(conflict.key, conflict.blocks))}<br><small class="mu">${esc(conflict.detail)}</small>`,
    ),
    'ko',
  )}${section(l.errorsTitle, shown.map(esc), 'ko')}${section(
    l.sharedTitle,
    check.shared.map((entry) => esc(l.sharedLine(entry.key, entry.blocks))),
  )}${section(
    l.dynamicTitle,
    check.dynamic.map((key) => `<code>${esc(key)}</code>`),
    'inline',
  )}${section(l.warningsTitle, check.warnings.map(esc), 'warn')}</div>`;
}

function composerView(state: DashboardState, publish: boolean): string {
  const l = state.t.lib;
  const t = state.t;
  const ui = state.lib;
  const blocks = ui.blocks ?? [];
  const check = ui.check;
  const fresh = check !== undefined && ui.checkedFor === compositionKey(ui.compose);
  const rows = ui.compose.parts
    .map((part, index) => {
      const block = blocks.find((entry) => entry.name === part);
      const checked = fresh ? check.order[index] : undefined;
      const sources = (checked?.satisfied ?? []).map(
        (entry) =>
          `<li class="lib-src">${esc(typeof entry.from === 'number' ? l.fromBlock(entry.key, entry.from) : l.fromData(entry.key))}</li>`,
      );
      const lacking = (checked?.missing ?? []).map(
        (key) => `<li class="lib-miss">${esc(l.missingInput(key))}</li>`,
      );
      const outputs = block?.contract.outputs ?? [];
      const last = index === ui.compose.parts.length - 1;
      return `<li class="lib-step${lacking.length > 0 ? ' ko' : ''}"><span class="n" aria-hidden="true">${String(index + 1)}</span><div class="lib-step-b"><div class="lib-step-h"><b>${esc(part)}</b>${block ? `<small class="mu">${esc(l.version(block.version))} · ${esc(l.steps(block.steps))}</small>${block.state === 'VALID' ? '' : stateBadge(state, block.state)}` : `<small class="ko-t">${esc(l.unknownBlock)}</small>`}</div>${
        sources.length + lacking.length > 0
          ? `<ul class="plain lib-links">${[...sources, ...lacking].join('')}</ul>`
          : ''
      }${outputs.length > 0 ? `<p class="lib-gives mu">${esc(l.gives(outputs.map((output) => output.key).join(', ')))}</p>` : ''}</div><span class="lib-step-a">${
        publish
          ? `<button type="button" class="btn small ghost icon-only" data-action="lib-part-move" data-index="${String(index)}" data-direction="up" aria-label="${esc(t.review.moveUp)}" title="${esc(t.review.moveUp)}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn small ghost icon-only" data-action="lib-part-move" data-index="${String(index)}" data-direction="down" aria-label="${esc(t.review.moveDown)}" title="${esc(t.review.moveDown)}" ${last ? 'disabled' : ''}>↓</button><button type="button" class="btn small ghost icon-only" data-action="lib-part-remove" data-index="${String(index)}" aria-label="${esc(l.removePart(part))}" title="${esc(l.removePart(part))}">✕</button>`
          : ''
      }</span></li>`;
    })
    .join('');
  const busy = Boolean(ui.creating) || Boolean(ui.checking);
  const canCreate =
    publish && ui.compose.parts.length > 0 && ui.compose.name.trim() !== '' && !busy && (!fresh || check.ok);
  // Le contrat du parcours : ce qu'il reçoit de l'extérieur (données de test, ou manquant) et ce qu'il produit.
  const external = fresh
    ? [
        ...new Set([
          ...check.order.flatMap((entry) => [
            ...entry.satisfied.filter((item) => typeof item.from !== 'number').map((item) => item.key),
            ...entry.missing,
          ]),
          ...check.missing.map((entry) => entry.key),
        ]),
      ]
    : [];
  const produced = [
    ...new Set(
      ui.compose.parts.flatMap(
        (part) =>
          blocks.find((entry) => entry.name === part)?.contract.outputs.map((output) => output.key) ?? [],
      ),
    ),
  ];
  const chips = (items: readonly string[]): string =>
    items.length > 0
      ? items.map((key) => `<code class="lib-key">${esc(key)}</code>`).join('')
      : `<small class="mu">${esc(l.none)}</small>`;
  const journey = `<section class="card lib-composer" id="lib-composer" aria-labelledby="lib-composer-t">
<h2 id="lib-composer-t">${esc(l.composeTitle)}</h2>
<form class="col" data-action="lib-compose">
<label class="field">${esc(l.composeName)}<input data-lib="compose.name" value="${esc(ui.compose.name)}" maxlength="80" autocomplete="off" ${publish ? '' : 'disabled'}></label>
${rows ? `<ol class="plain lib-steps" aria-label="${esc(l.orderLabel)}">${rows}</ol>` : `<p class="mu lib-empty">${esc(l.composeEmpty)}</p>`}
${publish ? `<div class="form-acts start"><button type="button" class="btn" data-action="lib-check" ${ui.compose.parts.length === 0 || busy ? 'disabled' : ''}>${esc(ui.checking ? l.checking : l.check)}</button><button type="submit" class="btn primary" ${canCreate ? '' : 'disabled'} aria-busy="${String(Boolean(ui.creating))}">${esc(ui.creating ? l.creating : l.create)}</button></div>` : ''}
</form></section>`;
  const diagnostics = `<aside class="card lib-diag" aria-labelledby="lib-diag-t" aria-live="polite">
<h2 id="lib-diag-t">${esc(l.diagTitle)}</h2>
${
  ui.compose.parts.length === 0
    ? `<p class="mu">${esc(l.diagEmpty)}</p>`
    : `<div class="lib-ios lib-ios-col"><span class="lib-io"><span class="lib-io-l">${esc(l.journeyNeeds)}</span>${fresh ? chips(external) : `<small class="mu">${esc(l.checking)}</small>`}</span><span class="lib-io"><span class="lib-io-l">${esc(l.journeyGives)}</span>${chips(produced)}</span></div>`
}
${ui.checking ? `<p class="mu" role="status"><span class="spin" aria-hidden="true"></span> ${esc(l.checking)}</p>` : check ? checkSummary(state, check, !fresh) : ''}
</aside>`;
  return `${journey}${diagnostics}`;
}

function addPanel(state: DashboardState): string {
  const l = state.t.lib;
  const t = state.t;
  const panel = state.lib.panel;
  const p = state.project;
  if (!panel || !p) return '';
  const sources = runnableScenarios(p.scenarios).filter((scenario) => scenario.format === 'yaml');
  const taken = new Set(p.scenarios.map((scenario) => scenario.name));
  const name = panel.name.replace(/\s+/g, ' ').trim();
  const nameProblem = !name
    ? l.nameRequired
    : name.length > 80
      ? l.nameTooLong
      : taken.has(name)
        ? l.nameTaken(name)
        : undefined;
  const preview = panel.preview && panel.previewFor === panel.scenario ? panel.preview : undefined;
  const previewBox = panel.loading
    ? `<p class="mu" role="status"><span class="spin" aria-hidden="true"></span> ${esc(l.previewLoading)}</p>`
    : preview
      ? `<div class="lib-preview"><b>${esc(l.previewTitle)}</b><p class="mu">${esc(l.fromScenario(preview.scenario))} · <code>${esc(preview.file)}</code></p><p>${esc(l.steps(preview.steps))}${preview.startAt ? ` · ${esc(l.startAt(preview.startAt))}` : ''}</p>${keys(state, l.inputsLabel, preview.contract.inputs)}${keys(state, l.outputsLabel, preview.contract.outputs)}${preview.data.length > 0 ? keys(state, l.dataDefined, preview.data) : ''}<p class="mu small">${esc(l.copyNote)}</p></div>`
      : '';
  return `<div class="lib-sheet-bg" data-action="lib-panel-close"></div><aside class="lib-sheet" role="dialog" aria-modal="true" aria-labelledby="lib-sheet-t">
<div class="lib-sheet-h"><h2 id="lib-sheet-t">${esc(l.panelTitle)}</h2><button class="btn small ghost icon-only" data-action="lib-panel-close" aria-label="${esc(l.close)}" title="${esc(l.close)}">✕</button></div>
<p class="mu">${esc(l.panelIntro)}</p>
${
  sources.length === 0
    ? `<p class="mu">${esc(l.noSource)}</p>`
    : `<form class="col" data-action="lib-add"><label class="field">${esc(l.addScenario)}<select data-lib="panel.scenario">${sources
        .map(
          (scenario) =>
            `<option value="${esc(scenario.name)}" ${panel.scenario === scenario.name ? 'selected' : ''}>${esc(scenario.name)}</option>`,
        )
        .join(
          '',
        )}</select></label>${previewBox}<label class="field">${esc(l.blockName)}<input data-lib="panel.name" value="${esc(panel.name)}" maxlength="80" required autocomplete="off" aria-invalid="${String(Boolean(panel.name) && nameProblem !== undefined)}" aria-describedby="lib-name-hint"></label><small id="lib-name-hint" class="${panel.name && nameProblem ? 'err' : 'mu'}">${esc(panel.name && nameProblem ? nameProblem : l.nameHint)}</small><label class="field">${esc(l.description)}<textarea data-lib="panel.description" rows="2" maxlength="500">${esc(panel.description)}</textarea></label>${panel.error ? `<p class="err" role="alert">${esc(panel.error)}</p>` : ''}<div class="form-acts start"><button type="submit" class="btn primary" ${nameProblem || panel.busy || !panel.scenario ? 'disabled' : ''} aria-busy="${String(Boolean(panel.busy))}">${esc(panel.busy ? l.adding : l.add)}</button><button type="button" class="btn ghost" data-action="lib-panel-close">${esc(t.review.cancel)}</button></div></form>`
}</aside>`;
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
        ])}</div><span class="ed-seg lib-layouts" role="radiogroup" aria-label="${esc(l.layoutLabel)}">${(
          ['grid', 'list'] as const
        )
          .map(
            (value) =>
              `<button role="radio" aria-checked="${String(ui.layout === value)}" data-action="lib-layout" data-layout="${value}">${esc(value === 'grid' ? l.layoutGrid : l.layoutList)}</button>`,
          )
          .join(
            '',
          )}</span><small class="mu lib-shown" role="status">${esc(l.shown(shown.length, all.length))}</small></div>`;
  const catalog =
    all.length === 0
      ? `<div class="lib-blank"><p>${esc(l.empty)}</p>${publish ? `<button class="btn primary" data-action="lib-panel-open">${icon('plus')}<span>${esc(l.addBlock)}</span></button>` : ''}</div>`
      : shown.length === 0
        ? `<div class="lib-blank"><p class="mu">${esc(l.noMatch)}</p><button class="btn small ghost" data-action="lib-clear">${esc(l.clear)}</button></div>`
        : catalogList(state, shown, publish);
  const recents =
    recent.length > 0
      ? `<nav class="lib-recent" aria-label="${esc(l.recentTitle)}"><span class="lib-io-l">${esc(l.recentTitle)}</span>${recent.map((block) => `<button class="chip" data-action="lib-open" data-block="${esc(block.name)}">${esc(block.name)}</button>`).join('')}</nav>`
      : '';
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
  const jump =
    ui.compose.parts.length > 0
      ? `<button class="btn small lib-jump" data-action="lib-jump">${esc(l.jump(ui.compose.parts.length))}</button>`
      : '';
  return `${header(esc(l.title), { sub: esc(l.sub(p.name, all.length)), actions })}<p class="mu lib-intro">${esc(l.intro)}</p>${sheetOpen ? '' : messages}${toolbar}${recents}${jump}<div class="lib-layout"><section class="lib-catalog" aria-label="${esc(l.blocksTitle)}">${catalog}</section>${composerView(state, publish)}</div>${addPanel(state)}${blockSheet(state)}`;
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
