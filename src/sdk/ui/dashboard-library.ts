import type { LibraryBlockView, ScenarioView } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import { header, icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA BIBLIOTHÈQUE DE SCÉNARIOS : des blocs réutilisables (jamais exécutés seuls) que d'autres
 * scénarios rejouent. On y ajoute un scénario (ou, depuis la revue, un groupe d'un enregistrement),
 * on compose un nouveau parcours à partir de blocs, on retire un bloc qu'aucun scénario ne rejoue.
 * L'insertion d'un bloc dans un scénario existant se fait depuis l'écran Scénarios. Des fonctions pures.
 */
export interface LibraryUi {
  blocks?: LibraryBlockView[];
  /** Ajouter un scénario : lequel, sous quel nom. */
  add: { scenario: string; name: string; description: string };
  /** Composer un parcours : son nom, les blocs choisis dans l'ordre, le bloc en cours de choix. */
  compose: { name: string; parts: string[]; pick: string };
  /** Insérer un bloc dans le scénario affiché (écran Scénarios). */
  insert: { block: string; at: 'start' | 'end' };
  /** Le groupe d'un enregistrement en cours d'ajout (revue), et le nom proposé. */
  group?: { id: string; name: string };
  confirmRemove?: string;
  busy?: boolean;
  error?: string;
  notice?: string;
}

export const emptyLibraryUi = (): LibraryUi => ({
  add: { scenario: '', name: '', description: '' },
  compose: { name: '', parts: [], pick: '' },
  insert: { block: '', at: 'start' },
});

/** Les scénarios qu'on lance : les blocs de la bibliothèque n'en sont pas (jamais exécutés seuls). */
export const runnableScenarios = (scenarios: readonly ScenarioView[]): ScenarioView[] =>
  scenarios.filter((scenario) => !scenario.reusable);

function blockCard(state: DashboardState, block: LibraryBlockView, publish: boolean): string {
  const l = state.t.lib;
  const ui = state.lib;
  const disabled = ui.busy ? 'disabled' : '';
  const origin = block.origin
    ? block.origin.kind === 'scenario'
      ? l.fromScenario(block.origin.name)
      : l.fromRecording(block.origin.name, block.origin.group ?? '')
    : '';
  const tags = [
    ...block.inputs.map((key) => `<span class="tag prod">◆ ${esc(l.inputs)} <code>${esc(key)}</code></span>`),
    ...block.citations.map(
      (key) => `<span class="tag cons">◇ ${esc(l.citations)} <code>${esc(key)}</code></span>`,
    ),
  ].join('');
  const remove = !publish
    ? ''
    : block.usedBy.length > 0
      ? `<small class="mu">${esc(l.usedNote)}</small>`
      : ui.confirmRemove === block.name
        ? `<span class="confirm" role="group"><small>${esc(l.removeConfirm)}</small><button class="btn small danger" data-action="lib-remove-yes" data-block="${esc(block.name)}" ${disabled}>${esc(l.remove)}</button><button class="btn small ghost" data-action="lib-remove-no">${esc(state.t.review.cancel)}</button></span>`
        : `<button class="btn small ghost" data-action="lib-remove" data-block="${esc(block.name)}" ${disabled}>${esc(l.remove)}</button>`;
  return `<li class="lib-block"><div class="row-line"><b>${esc(block.name)}</b><small class="mu">${esc(l.steps(block.steps))}${block.startAt ? ` · <code>${esc(block.startAt)}</code>` : ''}</small></div>${
    block.description ? `<p class="mu">${esc(block.description)}</p>` : ''
  }${origin ? `<small class="mu">${esc(origin)}</small>` : ''}${tags ? `<span class="tags">${tags}</span>` : ''}<small class="mu">${esc(block.usedBy.length > 0 ? l.usedBy(block.usedBy.join(', ')) : l.unused)}</small><code class="mu small-code">${esc(block.file)}</code>${remove}</li>`;
}

export function libraryView(state: DashboardState): string {
  const t = state.t;
  const l = t.lib;
  const p = state.project;
  if (!p)
    return `${header(esc(t.nav.library))}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const ui = state.lib;
  const blocks = ui.blocks ?? [];
  const publish = can(state, 'PUBLISH') && p.state !== 'ARCHIVED';
  const disabled = ui.busy ? 'disabled' : '';
  const list =
    blocks.length === 0
      ? `<p class="mu">${esc(l.none)}</p>`
      : `<ul class="plain lib-blocks">${blocks.map((block) => blockCard(state, block, publish)).join('')}</ul>`;
  const scenarios = runnableScenarios(p.scenarios).filter((scenario) => scenario.format === 'yaml');
  const add =
    publish && scenarios.length > 0
      ? `<section class="card"><h2>${esc(l.addTitle)}</h2><form class="col" data-action="lib-add"><div class="fields"><label class="field">${esc(l.addScenario)}<select data-lib="add.scenario">${scenarios
          .map(
            (scenario) =>
              `<option value="${esc(scenario.name)}" ${ui.add.scenario === scenario.name ? 'selected' : ''}>${esc(scenario.name)}</option>`,
          )
          .join(
            '',
          )}</select></label><label class="field">${esc(l.blockName)}<input data-lib="add.name" value="${esc(ui.add.name)}" maxlength="80" required autocomplete="off"></label></div><label class="field">${esc(l.description)}<input data-lib="add.description" value="${esc(ui.add.description)}" maxlength="500" autocomplete="off"></label><div class="form-acts start"><button type="submit" class="btn primary" ${disabled}>${esc(l.add)}</button></div></form></section>`
      : '';
  const parts = ui.compose.parts
    .map(
      (part, index) =>
        `<li class="row-line"><span class="n" aria-hidden="true">${String(index + 1)}</span><b>${esc(part)}</b><span class="row-acts push"><button type="button" class="btn small ghost icon-only" data-action="lib-part-move" data-index="${String(index)}" data-direction="up" aria-label="${esc(t.review.moveUp)}" title="${esc(t.review.moveUp)}">↑</button><button type="button" class="btn small ghost icon-only" data-action="lib-part-move" data-index="${String(index)}" data-direction="down" aria-label="${esc(t.review.moveDown)}" title="${esc(t.review.moveDown)}">↓</button><button type="button" class="btn small ghost" data-action="lib-part-remove" data-index="${String(index)}">${esc(l.removePart)}</button></span></li>`,
    )
    .join('');
  const compose =
    publish && blocks.length > 0
      ? `<section class="card"><h2>${esc(l.composeTitle)}</h2><p class="mu">${esc(l.composeNote)}</p><form class="col" data-action="lib-compose"><label class="field">${esc(l.composeName)}<input data-lib="compose.name" value="${esc(ui.compose.name)}" maxlength="80" required autocomplete="off"></label><div class="lib-pick"><label class="field">${esc(l.pickBlock)}<select data-lib="compose.pick">${blocks
          .map(
            (block) =>
              `<option value="${esc(block.name)}" ${(ui.compose.pick || blocks[0]?.name) === block.name ? 'selected' : ''}>${esc(block.name)}</option>`,
          )
          .join(
            '',
          )}</select></label><button type="button" class="btn" data-action="lib-part-add">${esc(l.addPart)}</button></div>${
          parts ? `<ol class="plain lib-parts">${parts}</ol>` : `<p class="mu">${esc(l.noPart)}</p>`
        }<div class="form-acts start"><button type="submit" class="btn primary" ${disabled || ui.compose.parts.length === 0 ? 'disabled' : ''}>${esc(l.compose)}</button></div></form></section>`
      : '';
  const messages = `${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ''}${ui.notice ? `<p class="notice ok" role="status">${icon('check')}<span>${esc(ui.notice)}</span></p>` : ''}`;
  return `${header(esc(t.nav.library), { sub: esc(l.sub(p.name, blocks.length)) })}<p class="mu">${esc(l.intro)}</p>${messages}<div class="split"><div class="col"><section class="card"><h2>${esc(l.blocksTitle)}</h2>${list}</section></div><div class="col narrow">${compose}${add}</div></div>`;
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
  return `<form class="col lib-insert" data-action="lib-insert" data-scenario="${esc(scenario.name)}"><h3 class="section-t">${esc(l.insertTitle)}</h3><div class="fields"><label class="field">${esc(l.pickBlock)}<select data-lib="insert.block">${blocks
    .map(
      (block) =>
        `<option value="${esc(block.name)}" ${(ui.insert.block || blocks[0]?.name) === block.name ? 'selected' : ''}>${esc(block.name)}</option>`,
    )
    .join(
      '',
    )}</select></label><label class="field">${esc(l.insertAt)}<select data-lib="insert.at"><option value="start" ${ui.insert.at === 'start' ? 'selected' : ''}>${esc(l.atStart)}</option><option value="end" ${ui.insert.at === 'end' ? 'selected' : ''}>${esc(l.atEnd)}</option></select></label></div><div class="form-acts start"><button type="submit" class="btn" ${disabled}>${esc(l.insert)}</button></div></form>`;
}
