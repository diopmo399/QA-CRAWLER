import type { BlockSourceComparison, LibraryBlockDetails, LibraryBlockView } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import { kindOf, keys, originText, stateBadge } from './dashboard-library.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA FICHE D'UN BLOC (panneau latéral à onglets) : vue d'ensemble, étapes, contrat, données,
 * dépendances (un graphe simple : qui produit ses entrées, qui lit ses sorties, quels scénarios le
 * rejouent), versions, provenance (comparaison avec la source, mise à jour demandée explicitement).
 * Les étapes, groupes internes et stratégies de données viennent du serveur (`library.details`) ;
 * jamais une valeur de donnée. Des fonctions pures : l'état est tenu par le contrôleur.
 */
export const SHEET_TABS = [
  'overview',
  'steps',
  'contract',
  'data',
  'dependencies',
  'versions',
  'provenance',
] as const;
export type SheetTab = (typeof SHEET_TABS)[number];

export interface BlockSheet {
  block: string;
  tab: SheetTab;
  details?: LibraryBlockDetails;
  loading?: boolean;
  error?: string;
  comparison?: BlockSourceComparison;
  comparing?: boolean;
  confirmUpdate?: boolean;
  updating?: boolean;
}

const date = (state: DashboardState, iso?: string): string =>
  iso ? new Date(iso).toLocaleString(state.t.locale) : '—';

function loading(state: DashboardState, sheet: BlockSheet): string {
  if (sheet.error) return `<p class="err" role="alert">${esc(sheet.error)}</p>`;
  return `<p class="mu" role="status"><span class="spin" aria-hidden="true"></span> ${esc(state.t.lib.sheetLoading)}</p>`;
}

function overviewTab(state: DashboardState, block: LibraryBlockView, publish: boolean): string {
  const l = state.t.lib;
  const disabled = state.lib.busy ? 'disabled' : '';
  const groups = block.groups ?? [];
  return `${block.description ? `<p class="lib-desc">${esc(block.description)}</p>` : ''}
<dl class="lib-dl"><dt>${esc(l.kindLabel)}</dt><dd>${esc(kindOf(block) === 'composite' ? l.kindComposite(groups.length) : l.kindStandalone)}</dd><dt>${esc(l.stepsLabel)}</dt><dd>${esc(l.steps(block.steps))}${block.startAt ? ` · ${esc(l.startAt(block.startAt))}` : ''}</dd>${groups.length > 0 ? `<dt>${esc(l.internalGroups)}</dt><dd>${esc(groups.map((group) => group.name).join(' · '))}</dd>` : ''}<dt>${esc(l.versionLabel)}</dt><dd>${esc(l.version(block.version))}</dd><dt>${esc(l.stateLabel)}</dt><dd>${stateBadge(state, block.state)}</dd><dt>${esc(l.originLabel)}</dt><dd>${esc(originText(state, block))}</dd><dt>${esc(l.updated)}</dt><dd>${esc(date(state, block.updatedAt ?? block.createdAt))}</dd><dt>${esc(l.dependents)}</dt><dd>${esc(l.usedIn(block.usedBy.length))}</dd></dl>
<div class="lib-ios">${keys(state, l.inputsLabel, block.contract.inputs)}${keys(state, l.outputsLabel, block.contract.outputs)}</div>
<p class="mu">${esc(l.assertions(block.assertions))}</p>
${
  block.problems.length > 0
    ? `<div class="lib-problems" role="note"><b>${esc(l.problems)}</b><ul class="plain tight">${block.problems.map((problem) => `<li>${esc(problem)}</li>`).join('')}</ul>${publish && block.state === 'CHANGED' ? `<button class="btn small" data-action="lib-validate-version" data-block="${esc(block.name)}" ${disabled}>${esc(l.validateVersion)}</button>` : ''}</div>`
    : ''
}`;
}

function stepsTab(state: DashboardState, sheet: BlockSheet): string {
  const l = state.t.lib;
  const details = sheet.details;
  if (!details) return loading(state, sheet);
  const groupAt = new Map<number, string>();
  for (const group of details.groups) {
    const first = Math.min(...group.positions);
    if (Number.isFinite(first)) groupAt.set(first, group.name);
  }
  const rows = details.steps
    .map((step) => {
      const head = groupAt.get(step.position);
      return `${head ? `<li class="lib-sgroup">${icon('library')}<span>${esc(head)}</span></li>` : ''}<li class="pub-step${step.kind === 'expect' ? ' is-check' : ''}"><span class="pub-pos">${String(step.position)}</span><span>${esc(step.label)}</span></li>`;
    })
    .join('');
  return details.steps.length === 0
    ? `<p class="mu">${esc(l.noSteps)}</p>`
    : `<ol class="plain pub-steps lib-fsteps" aria-label="${esc(l.tabs.steps)}">${rows}</ol>`;
}

function contractTab(state: DashboardState, block: LibraryBlockView, publish: boolean): string {
  const l = state.t.lib;
  const ui = state.lib;
  const disabled = ui.busy ? 'disabled' : '';
  const contract = block.contract;
  const editing = ui.contract?.block === block.name ? ui.contract : undefined;
  const form = editing
    ? `<form class="col lib-contract" data-action="lib-contract" data-block="${esc(block.name)}"><p class="mu">${esc(l.keysHint)}</p><label class="field">${esc(l.contractRequired)}<input data-lib="contract.required" value="${esc(editing.required)}" autocomplete="off"></label><label class="field">${esc(l.contractOptional)}<input data-lib="contract.optional" value="${esc(editing.optional)}" autocomplete="off"></label><label class="field">${esc(l.contractOutputs)}<input data-lib="contract.outputs" value="${esc(editing.outputs)}" autocomplete="off"></label><label class="field">${esc(l.contractPre)}<textarea data-lib="contract.pre" rows="2">${esc(editing.pre)}</textarea></label><label class="field">${esc(l.contractPost)}<textarea data-lib="contract.post" rows="2">${esc(editing.post)}</textarea></label><div class="form-acts start"><button type="submit" class="btn small primary" ${disabled}>${esc(l.saveContract)}</button>${contract.source === 'DECLARED' ? `<button type="button" class="btn small ghost" data-action="lib-contract-reset" data-block="${esc(block.name)}" ${disabled}>${esc(l.resetContract)}</button>` : ''}<button type="button" class="btn small ghost" data-action="lib-contract-cancel">${esc(state.t.review.cancel)}</button></div></form>`
    : '';
  const conditions = (title: string, items: readonly string[]): string =>
    `<h4>${esc(title)}</h4>${items.length > 0 ? `<ul class="plain tight">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p class="mu">${esc(l.none)}</p>`}`;
  return `<p class="mu">${esc(contract.source === 'DECLARED' ? l.contractDeclaredNote : l.contractDerivedNote)}</p>
<div class="lib-ios lib-ios-col">${keys(state, l.inputsLabel, contract.inputs)}${keys(state, l.outputsLabel, contract.outputs)}</div>
${conditions(l.preconditions, contract.preconditions)}${conditions(l.postconditions, contract.postconditions)}
<p class="mu">${esc(l.assertions(block.assertions))}</p>
${block.problems.length > 0 ? `<ul class="plain tight pub-diag">${block.problems.map((problem) => `<li class="warn">${esc(problem)}</li>`).join('')}</ul>` : ''}
${publish && !editing ? `<button class="btn small" data-action="lib-contract-edit" data-block="${esc(block.name)}">${esc(l.declareContract)}</button>` : ''}${form}`;
}

function dataTab(state: DashboardState, sheet: BlockSheet): string {
  const l = state.t.lib;
  const details = sheet.details;
  if (!details) return loading(state, sheet);
  if (details.data.length === 0) return `<p class="mu">${esc(l.noData)}</p>`;
  return `<table class="tbl lib-data"><thead><tr><th scope="col">${esc(l.dataKey)}</th><th scope="col">${esc(l.dataStrategy)}</th></tr></thead><tbody>${details.data
    .map(
      (entry) =>
        `<tr><td><code>${esc(entry.key)}</code></td><td>${esc(l.strategies[entry.strategy] ?? entry.strategy)}${entry.detail ? ` <code>${esc(entry.detail)}</code>` : ''}${entry.dynamic ? ` <small class="mu">· ${esc(l.dynamic)}</small>` : ''}</td></tr>`,
    )
    .join('')}</tbody></table><p class="mu small">${esc(l.valuesNote)}</p>`;
}

/** Le graphe simple : les blocs qui produisent ses entrées → le bloc → les blocs qui lisent ses sorties. */
function dependenciesTab(state: DashboardState, block: LibraryBlockView): string {
  const l = state.t.lib;
  const others = (state.lib.blocks ?? []).filter((entry) => entry.name !== block.name);
  const inputs = block.contract.inputs.map((input) => input.key);
  const outputs = block.contract.outputs.map((output) => output.key);
  const producers = inputs.map((key) => ({
    key,
    blocks: others.filter((entry) => entry.contract.outputs.some((output) => output.key === key)),
  }));
  const consumers = outputs.map((key) => ({
    key,
    blocks: others.filter((entry) => entry.contract.inputs.some((input) => input.key === key)),
  }));
  const node = (name: string): string =>
    `<button class="lib-gnode" data-action="lib-open" data-block="${esc(name)}">${esc(name)}</button>`;
  const column = (
    title: string,
    rows: { key: string; blocks: LibraryBlockView[] }[],
    lacking: (key: string) => string,
  ): string =>
    `<div class="lib-gcol"><h4>${esc(title)}</h4>${
      rows.length === 0
        ? `<p class="mu">${esc(l.none)}</p>`
        : `<ul class="plain lib-gedges">${rows
            .map(
              (row) =>
                `<li><code class="lib-key">${esc(row.key)}</code>${row.blocks.length > 0 ? row.blocks.map((entry) => node(entry.name)).join('') : `<small class="mu">${esc(lacking(row.key))}</small>`}</li>`,
            )
            .join('')}</ul>`
    }</div>`;
  const pins = block.usedBy
    .map((scenario) => {
      const pin = block.pinnedBy.find((entry) => entry.scenario === scenario);
      return `<li><button class="lnk" data-action="lib-open-scenario" data-name="${esc(scenario)}">${esc(scenario)}</button>${pin ? ` <small class="${pin.current ? 'mu' : 'warn-t'}">${esc(l.pinned(pin.version, pin.current))}</small>` : ` <small class="mu">${esc(l.notPinned)}</small>`}</li>`;
    })
    .join('');
  return `<figure class="lib-graph" aria-label="${esc(l.graphLabel)}">${column(l.producers, producers, l.noProducer)}<div class="lib-gmid" aria-hidden="true">→</div><div class="lib-gcol lib-gself"><span class="lib-gnode self">${esc(block.name)}</span><small class="mu">${esc(l.version(block.version))}</small></div><div class="lib-gmid" aria-hidden="true">→</div>${column(l.consumers, consumers, l.noConsumer)}</figure>
<h4>${esc(l.dependents)}</h4>${pins ? `<ul class="plain tight">${pins}</ul>` : `<p class="mu">${esc(l.usedIn(0))}</p>`}`;
}

function versionsTab(state: DashboardState, block: LibraryBlockView): string {
  const l = state.t.lib;
  return `<dl class="lib-dl"><dt>${esc(l.versionLabel)}</dt><dd>${esc(l.version(block.version))} · <code title="${esc(l.hashHint)}">${esc(block.hash)}</code></dd><dt>${esc(l.created)}</dt><dd>${esc(date(state, block.createdAt))}</dd><dt>${esc(l.updated)}</dt><dd>${esc(date(state, block.updatedAt))}</dd></dl>
<ol class="plain lib-history lib-timeline">${[...block.history]
    .reverse()
    .map(
      (entry) =>
        `<li><b>${esc(l.version(entry.version))}</b><span>${esc(l.change(entry.change))}</span>${entry.at ? `<small class="mu">${esc(date(state, entry.at))}</small>` : ''}</li>`,
    )
    .join('')}</ol>`;
}

function comparisonBox(
  state: DashboardState,
  block: LibraryBlockView,
  sheet: BlockSheet,
  publish: boolean,
): string {
  const l = state.t.lib;
  const result = sheet.comparison;
  if (!result) return '';
  const tone = result.status === 'SAME' ? 'ok' : result.status === 'DIFFERENT' ? 'warn' : 'ko';
  const revision = result.revision
    ? `<p class="mu small">${esc(l.revisions(result.revision.extracted ?? '—', result.revision.current ?? '—'))}</p>`
    : '';
  const changes =
    result.changes.length > 0
      ? `<ul class="plain tight">${result.changes.map((change) => `<li>${esc(change)}</li>`).join('')}</ul>`
      : '';
  const update =
    publish && result.status === 'DIFFERENT'
      ? sheet.confirmUpdate
        ? `<div class="confirm col" role="group"><p>${esc(l.updateConfirm)}</p><span class="row"><button class="btn small primary" data-action="lib-update-yes" data-block="${esc(block.name)}" ${sheet.updating ? 'disabled' : ''} aria-busy="${String(Boolean(sheet.updating))}">${esc(sheet.updating ? l.updating : l.updateFromSource)}</button><button class="btn small ghost" data-action="lib-update-no">${esc(state.t.review.cancel)}</button></span></div>`
        : `<button class="btn small" data-action="lib-update-ask">${esc(l.updateFromSource)}</button>`
      : '';
  return `<div class="lib-compare ${tone}" role="status"><b>${esc(l.compareStatus[result.status])}</b>${revision}${changes}${update}</div>`;
}

function provenanceTab(
  state: DashboardState,
  block: LibraryBlockView,
  sheet: BlockSheet,
  publish: boolean,
): string {
  const l = state.t.lib;
  const origin = block.origin;
  const row = (label: string, value: string | undefined): string =>
    value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '';
  const codes = (items: readonly string[] | undefined): string | undefined =>
    items && items.length > 0 ? items.map((item) => `<code>${esc(item)}</code>`).join(' ') : undefined;
  const fromRecording = origin?.kind === 'recording';
  const facts = origin
    ? `${row(l.originLabel, esc(origin.kind === 'recording' ? l.origins.recording : l.origins.scenario))}${row(fromRecording ? l.recordingLabel : l.scenarioLabel, `<code>${esc(origin.name)}</code>`)}${row(l.groupsOrigin, origin.groups && origin.groups.length > 0 ? esc(origin.groups.join(' · ')) : origin.group ? esc(origin.group) : undefined)}${row(l.groupIds, codes(origin.groupIds))}${row(l.stepIdsLabel, codes(origin.stepIds))}${row(l.modeLabel, origin.mode ? esc(l.modes[origin.mode]) : undefined)}${row(l.session, origin.sessionId ? `<code>${esc(origin.sessionId)}</code>` : undefined)}${row(l.revision, origin.revision ? `<code>${esc(origin.revision)}</code>` : undefined)}${row(l.extractedAt, origin.extractedAt ? esc(date(state, origin.extractedAt)) : undefined)}${row(l.author, origin.author ? esc(origin.author) : undefined)}${row(l.providedKeys, codes(origin.provided))}${row(l.transformationsLabel, origin.transformations && origin.transformations.length > 0 ? esc(origin.transformations.join(' · ')) : origin.navigate ? esc(l.navigateYes) : undefined)}`
    : `<dt>${esc(l.originLabel)}</dt><dd>${esc(l.unknownOrigin)}</dd>`;
  return `<dl class="lib-dl">${facts}<dt>${esc(l.file)}</dt><dd><code>${esc(block.file)}</code></dd><dt>${esc(l.id)}</dt><dd><code>${esc(block.id)}</code></dd></dl>
${fromRecording ? `<div class="row"><button class="btn small" data-action="lib-compare" data-block="${esc(block.name)}" ${sheet.comparing ? 'disabled' : ''} aria-busy="${String(Boolean(sheet.comparing))}">${esc(sheet.comparing ? l.comparing : l.compare)}</button><button class="lnk" data-action="nav-recording" data-name="${esc(origin.name)}">${esc(l.openSource)}</button></div><p class="mu small">${esc(l.compareNote)}</p>` : ''}
${comparisonBox(state, block, sheet, publish)}`;
}

/** La fiche ouverte (panneau latéral modal), ou rien. */
export function blockSheet(state: DashboardState): string {
  const ui = state.lib;
  const sheet = ui.sheet;
  const block = sheet ? (ui.blocks ?? []).find((entry) => entry.name === sheet.block) : undefined;
  if (!sheet || !block) return '';
  const l = state.t.lib;
  const publish = can(state, 'PUBLISH') && state.project?.state !== 'ARCHIVED';
  const disabled = ui.busy ? 'disabled' : '';
  const body =
    sheet.tab === 'overview'
      ? overviewTab(state, block, publish)
      : sheet.tab === 'steps'
        ? stepsTab(state, sheet)
        : sheet.tab === 'contract'
          ? contractTab(state, block, publish)
          : sheet.tab === 'data'
            ? dataTab(state, sheet)
            : sheet.tab === 'dependencies'
              ? dependenciesTab(state, block)
              : sheet.tab === 'versions'
                ? versionsTab(state, block)
                : provenanceTab(state, block, sheet, publish);
  const tabs = SHEET_TABS.map(
    (tab) =>
      `<button role="tab" id="lib-tab-${tab}" data-action="lib-sheet-tab" data-tab="${tab}" aria-selected="${String(tab === sheet.tab)}" aria-controls="lib-tabpanel" tabindex="${tab === sheet.tab ? '0' : '-1'}">${esc(l.tabs[tab])}</button>`,
  ).join('');
  const remove = !publish
    ? ''
    : block.usedBy.length > 0
      ? `<small class="mu">${esc(l.usedNote)}</small>`
      : ui.confirmRemove === block.name
        ? `<span class="confirm" role="group"><small>${esc(l.removeConfirm)}</small><button class="btn small danger" data-action="lib-remove-yes" data-block="${esc(block.name)}" ${disabled}>${esc(l.remove)}</button><button class="btn small ghost" data-action="lib-remove-no">${esc(state.t.review.cancel)}</button></span>`
        : `<button class="btn small ghost" data-action="lib-remove" data-block="${esc(block.name)}" ${disabled}>${esc(l.remove)}</button>`;
  const messages = `${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ''}${ui.notice ? `<p class="notice ok" role="status">${icon('check')}<span>${esc(ui.notice)}</span></p>` : ''}`;
  return `<div class="lib-sheet-bg" data-action="lib-sheet-close"></div><aside class="lib-sheet lib-fiche" role="dialog" aria-modal="true" aria-labelledby="lib-fiche-t" tabindex="-1">
<div class="lib-sheet-h"><h2 id="lib-fiche-t">${esc(block.name)}</h2><button class="btn small ghost icon-only" data-action="lib-sheet-close" aria-label="${esc(l.close)}" title="${esc(l.close)}">✕</button></div>
<p class="lib-fiche-m"><span class="lib-ver">${esc(l.version(block.version))}</span>${stateBadge(state, block.state)}<span class="lib-kind ${kindOf(block)}">${esc(kindOf(block) === 'composite' ? l.kindComposite(block.groups?.length ?? 0) : l.kindStandalone)}</span><small class="mu">${esc(originText(state, block))}</small></p>
${messages}
<div class="tabs lib-ftabs" role="tablist" aria-label="${esc(block.name)}">${tabs}</div>
<section id="lib-tabpanel" class="lib-fbody" role="tabpanel" aria-labelledby="lib-tab-${sheet.tab}">${body}</section>
<div class="form-acts start lib-fiche-f">${publish ? `<button class="btn small primary" data-action="lib-part-add" data-block="${esc(block.name)}">${icon('plus')}<span>${esc(l.addToJourney)}</span></button>` : ''}${remove}</div>
</aside>`;
}
