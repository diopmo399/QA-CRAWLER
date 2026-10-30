import type {
  ExtractionBlockPlan,
  ExtractionDependency,
  ExtractionInput,
  ExtractionMode,
  ExtractionPlan,
  GroupViewDto,
  StudioStep,
} from '../core/contracts.js';
import { can } from './dashboard-access.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * PUBLIER DES GROUPES MÉTIER DANS LA BIBLIOTHÈQUE (onglet de la revue d'un enregistrement). Les groupes
 * sont ceux du Recorder ; on en coche un, plusieurs ou tous (ou une partie des étapes d'un groupe), on
 * voit leurs données et leurs dépendances, puis l'aperçu de chaque bloc calculé par le serveur (plan :
 * étapes, données restreintes, contrat, validation) avant de publier tout ou rien. Des fonctions pures :
 * l'état est tenu par le contrôleur.
 */
export interface PublishUi {
  /** Les groupes cochés (identifiants du Recorder). */
  selected: string[];
  /** Une partie d'un groupe : ses étapes cochées (absent : toutes). */
  parts: Record<string, string[]>;
  mode: ExtractionMode;
  /** Nom et description de chaque bloc prévu (clé : groupId, ou `composite`). */
  names: Record<string, { name?: string; description?: string }>;
  navigate: boolean;
  /** Les valeurs fournies explicitement pour des données que la sélection consomme sans les produire. */
  provided: Record<string, string>;
  /** La saisie d'une valeur en cours (clé), et son texte. */
  providing?: { key: string; value: string };
  /** Le groupe dont le détail est ouvert dans le panneau latéral. */
  focus?: string;
  plan?: ExtractionPlan;
  planFor?: string;
  planning?: boolean;
  /** L'aperçu des blocs (panneau de publication). */
  preview: boolean;
  busy?: boolean;
  error?: string;
  details?: string[];
  notice?: string;
  published?: string[];
}

export const emptyPublishUi = (): PublishUi => ({
  selected: [],
  parts: {},
  mode: 'separate',
  names: {},
  navigate: false,
  provided: {},
  preview: false,
});

/** Ce que le serveur reçoit pour la sélection en cours (l'ordre des groupes : celui de l'enregistrement). */
export function extractionInputOf(ui: PublishUi): ExtractionInput {
  const names = Object.fromEntries(
    Object.entries(ui.names)
      .map(
        ([key, value]) =>
          [
            key,
            {
              ...(value.name?.trim() ? { name: value.name.trim() } : {}),
              ...(value.description?.trim() ? { description: value.description.trim() } : {}),
            },
          ] as const,
      )
      .filter(([, value]) => Object.keys(value).length > 0),
  );
  return {
    selection: ui.selected.map((groupId) => ({
      groupId,
      ...(ui.parts[groupId] && ui.parts[groupId].length > 0 ? { stepIds: ui.parts[groupId] } : {}),
    })),
    mode: ui.mode,
    ...(Object.keys(names).length > 0 ? { names } : {}),
    ...(ui.navigate ? { navigate: true } : {}),
    ...(Object.keys(ui.provided).length > 0 ? { provided: { ...ui.provided } } : {}),
  };
}

/** Le plan ne vaut que pour cette sélection exacte. */
export const planKey = (ui: PublishUi): string => JSON.stringify(extractionInputOf(ui));

/** Les groupes non cochés dont un groupe coché reçoit une donnée (la sélection ne serait pas autonome). */
export function missingProducers(
  groups: readonly GroupViewDto[],
  selected: readonly string[],
): { group: GroupViewDto; key: string; from: GroupViewDto }[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  return groups
    .filter((group) => selected.includes(group.id))
    .flatMap((group) =>
      (group.data?.inputs ?? []).flatMap((input) => {
        const from = input.producerGroupId ? byId.get(input.producerGroupId) : undefined;
        return from && !selected.includes(from.id) ? [{ group, key: input.key, from }] : [];
      }),
    );
}

function groupRow(
  state: DashboardState,
  group: GroupViewDto,
  index: number,
  steps: readonly StudioStep[],
  publish: boolean,
): string {
  const p = state.t.pub;
  const ui = state.review?.publish ?? emptyPublishUi();
  const chosen = ui.selected.includes(group.id);
  const members = steps.filter((step) => step.groupId === group.id);
  const actions = members.filter((step) => step.kind !== 'expect');
  const checks = members.length - actions.length;
  const partial = chosen && (ui.parts[group.id]?.length ?? 0) > 0;
  const produces = (group.data?.outputs ?? []).map((output) => output.key);
  const consumes = group.data?.inputs ?? [];
  const names = new Map((state.review?.studio?.groups ?? []).map((entry) => [entry.id, entry.name]));
  const lacking = consumes.filter(
    (input) => input.producerGroupId !== undefined && chosen && !ui.selected.includes(input.producerGroupId),
  );
  const data = [
    ...produces.map(
      (key) =>
        `<span class="pub-key out" title="${esc(p.produces)}">${icon('up')}<code>${esc(key)}</code></span>`,
    ),
    ...consumes.map(
      (input) =>
        `<span class="pub-key in" title="${esc(input.producerGroupId ? p.consumesFrom(names.get(input.producerGroupId) ?? input.producerGroupId) : p.consumes)}">${icon('down')}<code>${esc(input.key)}</code></span>`,
    ),
  ].join('');
  return `<li class="pub-group${chosen ? ' on' : ''}${ui.focus === group.id ? ' focus' : ''}" data-group="${esc(group.id)}">
<label class="pub-check"><input type="checkbox" data-pub="group" value="${esc(group.id)}" ${chosen ? 'checked' : ''} ${publish ? '' : 'disabled'} aria-label="${esc(p.choose(group.name))}"></label>
<span class="pub-n" aria-hidden="true">${String(index + 1)}</span>
<button class="pub-main" data-action="pub-focus" data-group="${esc(group.id)}" aria-pressed="${ui.focus === group.id ? 'true' : 'false'}">
<span class="pub-name"><b>${esc(group.name)}</b>${partial ? `<span class="pub-tag">${esc(p.partial(ui.parts[group.id]?.length ?? 0, members.length))}</span>` : ''}</span>
<span class="pub-meta">${esc(p.counts(actions.length, checks, group.assertionIds.length))} · <code>${esc(group.startAt)}</code>${group.runnableAlone.ok ? '' : ` · <span class="warn-t">${esc(p.notAlone)}</span>`}</span>
${
  actions.length > 0
    ? `<span class="pub-acts">${actions
        .slice(0, 3)
        .map((step) => esc(step.description))
        .join(' · ')}${actions.length > 3 ? ` · ${esc(p.more(actions.length - 3))}` : ''}</span>`
    : ''
}
${data ? `<span class="pub-data">${data}</span>` : ''}
</button>
${
  lacking.length > 0
    ? `<p class="pub-warn" role="note">${icon('alert')}<span class="pub-warn-t">${esc(p.lacking(group.name, lacking.map((input) => input.key).join(', '), lacking.map((input) => names.get(input.producerGroupId ?? '') ?? '').join(', ')))}</span>${lacking
        .map((input) => input.producerGroupId)
        .filter((id, at, all): id is string => publish && id !== undefined && all.indexOf(id) === at)
        .map(
          (id) =>
            `<button class="btn small" data-action="pub-add-group" data-group="${esc(id)}">${esc(p.addProducer(names.get(id) ?? id))}</button>`,
        )
        .join('')}</p>`
    : ''
}
</li>`;
}

/** Le panneau latéral : le détail du groupe choisi (étapes, données, départ, diagnostics). */
function sidePanel(
  state: DashboardState,
  groups: readonly GroupViewDto[],
  steps: readonly StudioStep[],
): string {
  const p = state.t.pub;
  const ui = state.review?.publish ?? emptyPublishUi();
  const group =
    groups.find((entry) => entry.id === ui.focus) ?? groups.find((entry) => ui.selected.includes(entry.id));
  if (!group) return `<aside class="card pub-side"><p class="mu">${esc(p.sideEmpty)}</p></aside>`;
  const chosen = ui.selected.includes(group.id);
  const members = steps.filter((step) => step.groupId === group.id);
  const part = ui.parts[group.id];
  const names = new Map(groups.map((entry) => [entry.id, entry.name]));
  const block = ui.plan?.blocks.find((entry) => entry.groups.some((inner) => inner.id === group.id));
  const list = members
    .map((step) => {
      const on = !part || part.length === 0 || part.includes(step.id);
      return `<li class="pub-step${step.kind === 'expect' ? ' is-check' : ''}">${
        chosen
          ? `<input type="checkbox" data-pub="step" data-group="${esc(group.id)}" value="${esc(step.id)}" ${on ? 'checked' : ''} aria-label="${esc(p.keepStep(step.description))}">`
          : ''
      }<span class="pub-pos">${String(step.position)}</span><span>${esc(step.description)}</span>${step.produces.length > 0 ? `<code class="pub-mini out">${esc(step.produces.join(', '))}</code>` : ''}${step.consumes.length > 0 ? `<code class="pub-mini in">${esc(step.consumes.join(', '))}</code>` : ''}</li>`;
    })
    .join('');
  const inputs = (group.data?.inputs ?? [])
    .map(
      (input) =>
        `<li><code>${esc(input.key)}</code> <span class="mu">${esc(input.producerGroupId ? p.fromGroup(names.get(input.producerGroupId) ?? input.producerGroupId) : p.fromOutside)}</span></li>`,
    )
    .join('');
  const outputs = (group.data?.outputs ?? [])
    .map(
      (output) =>
        `<li><code>${esc(output.key)}</code> <span class="mu">${esc(p.usedLater(output.consumerStepIds.length))}</span></li>`,
    )
    .join('');
  const diagnostics = block
    ? [
        ...block.validation.errors.map((text) => ['ko', text] as const),
        ...block.dependencies
          .filter((dependency) => dependency.source !== 'BLOCK' && dependency.source !== 'PROVIDED')
          .map((dependency) => ['warn', dependencyWords(p, dependency)] as const),
        ...(block.midway ? [['warn', p.midway(block.startAt)] as const] : []),
      ]
    : [];
  return `<aside class="card pub-side" aria-label="${esc(group.name)}">
<div class="pub-side-h"><h3>${esc(group.name)}</h3>${group.runnableAlone.ok ? `<span class="pub-tag ok">${esc(p.alone)}</span>` : `<span class="pub-tag warn">${esc(p.notAlone)}</span>`}</div>
${group.description ? `<p class="mu">${esc(group.description)}</p>` : ''}
<dl class="pub-dl"><dt>${esc(p.startPage)}</dt><dd><code>${esc(group.startAt)}</code></dd><dt>${esc(p.checksLabel)}</dt><dd>${esc(String(members.filter((step) => step.kind === 'expect').length))}</dd><dt>${esc(p.assertionsLabel)}</dt><dd>${esc(String(group.assertionIds.length))}</dd></dl>
<h4>${esc(p.stepsTitle)}${chosen ? ` <small class="mu">${esc(p.partHint)}</small>` : ''}</h4><ol class="plain pub-steps">${list}</ol>
<div class="pub-io"><div><h4>${esc(p.consumesTitle)}</h4>${inputs ? `<ul class="plain tight">${inputs}</ul>` : `<p class="mu">${esc(p.none)}</p>`}</div><div><h4>${esc(p.producesTitle)}</h4>${outputs ? `<ul class="plain tight">${outputs}</ul>` : `<p class="mu">${esc(p.none)}</p>`}</div></div>
${diagnostics.length > 0 ? `<h4>${esc(p.diagnostics)}</h4><ul class="plain tight pub-diag">${diagnostics.map(([tone, text]) => `<li class="${tone}">${esc(text)}</li>`).join('')}</ul>` : ''}
</aside>`;
}

/** Une dépendance dite dans la langue du Dashboard (le serveur la donne structurée). */
function dependencyWords(p: DashboardState['t']['pub'], dependency: ExtractionDependency): string {
  return dependency.source === 'BLOCK'
    ? p.depBlock(dependency.key, dependency.block ?? '')
    : dependency.source === 'UNSELECTED_GROUP'
      ? p.depGroup(dependency.key, dependency.group?.name ?? '')
      : dependency.source === 'PROVIDED'
        ? p.depProvided(dependency.key)
        : dependency.source === 'OUTSIDE_GROUPS'
          ? p.depOutside(dependency.key)
          : p.depNowhere(dependency.key);
}

function dependencyLine(state: DashboardState, block: ExtractionBlockPlan, publish: boolean): string {
  const p = state.t.pub;
  const ui = state.review?.publish ?? emptyPublishUi();
  return block.dependencies
    .map((dependency) => {
      const words = dependencyWords(p, dependency);
      const tone = dependency.source === 'BLOCK' || dependency.source === 'PROVIDED' ? 'ok' : 'warn';
      const providing = ui.providing?.key === dependency.key;
      const actions = !publish
        ? ''
        : dependency.source === 'PROVIDED'
          ? `<button class="lnk" data-action="pub-unprovide" data-key="${esc(dependency.key)}">${esc(p.unprovide)}</button>`
          : dependency.source === 'BLOCK'
            ? ''
            : `${dependency.source === 'UNSELECTED_GROUP' && dependency.group ? `<button class="btn small" data-action="pub-add-group" data-group="${esc(dependency.group.id)}">${esc(p.addProducer(dependency.group.name))}</button>` : ''}${
                providing
                  ? `<span class="pub-provide"><label class="sr" for="pub-v-${esc(dependency.key)}">${esc(p.valueFor(dependency.key))}</label><input id="pub-v-${esc(dependency.key)}" data-pub="provide" value="${esc(ui.providing?.value ?? '')}" maxlength="200" placeholder="${esc(p.valuePlaceholder)}" autocomplete="off"><button class="btn small primary" data-action="pub-provide-ok" data-key="${esc(dependency.key)}">${esc(p.provideOk)}</button><button class="btn small ghost" data-action="pub-provide-cancel">${esc(state.t.review.cancel)}</button></span>`
                  : `<button class="btn small ghost" data-action="pub-provide" data-key="${esc(dependency.key)}">${esc(p.provide)}</button>`
              }<small class="mu">${esc(p.asInput)}</small>`;
      return `<li class="pub-dep ${tone}"><span>${esc(words)}</span>${actions ? `<span class="pub-dep-a">${actions}</span>` : ''}</li>`;
    })
    .join('');
}

function blockPreview(state: DashboardState, block: ExtractionBlockPlan, publish: boolean): string {
  const p = state.t.pub;
  const ui = state.review?.publish ?? emptyPublishUi();
  const name = ui.names[block.key]?.name ?? block.name;
  const description = ui.names[block.key]?.description ?? block.description ?? '';
  const io = (label: string, keys: readonly string[]): string =>
    `<span class="lib-io"><span class="lib-io-l">${esc(label)}</span>${keys.length > 0 ? keys.map((key) => `<code class="lib-key">${esc(key)}</code>`).join('') : `<small class="mu">${esc(p.none)}</small>`}</span>`;
  const status = block.validation.ok
    ? `<span class="pub-tag ok">${icon('check')}${esc(p.valid)}</span>`
    : `<span class="pub-tag ko">${icon('alert')}${esc(p.invalid(block.validation.errors.length))}</span>`;
  return `<li class="pub-block${block.validation.ok ? '' : ' ko'}">
<div class="pub-block-h">${status}<span class="mu">${esc(block.composite ? p.compositeOf(block.groups.length) : p.standalone)} · ${esc(p.stepsCount(block.steps.length))}${block.checks > 0 ? ` · ${esc(p.checksCount(block.checks))}` : ''}${block.assertions > 0 ? ` · ${esc(p.assertionsCount(block.assertions))}` : ''}</span></div>
<div class="fields"><label class="field">${esc(p.blockName)}<input data-pub="name" data-key="${esc(block.key)}" value="${esc(name)}" maxlength="80" autocomplete="off" ${publish ? '' : 'disabled'}></label><label class="field">${esc(p.description)}<input data-pub="description" data-key="${esc(block.key)}" value="${esc(description)}" maxlength="500" autocomplete="off" ${publish ? '' : 'disabled'}></label></div>
<p class="mu small">${esc(p.groupsLine(block.groups.map((group) => (group.partial ? p.partialGroup(group.name, group.steps) : group.name)).join(' · ')))} · ${esc(p.startAtLine(block.startAt))}</p>
<div class="lib-ios">${io(
    p.inputs,
    block.contract.inputs.map((input) => input.key),
  )}${io(
    p.outputs,
    block.contract.outputs.map((output) => output.key),
  )}${io(
    p.dataLabel,
    block.data.map((entry) => entry.key),
  )}</div>
${block.dependencies.length > 0 ? `<ul class="plain pub-deps">${dependencyLine(state, block, publish)}</ul>` : ''}
${block.transformations.length > 0 ? `<p class="mu small">${esc(p.transformations(block.transformations.join(' · ')))}</p>` : ''}
${block.validation.errors.length > 0 ? `<ul class="plain tight pub-diag">${block.validation.errors.map((text) => `<li class="ko">${esc(text)}</li>`).join('')}</ul>` : ''}
${block.midway ? `<p class="pub-diag warn small">${esc(p.midway(block.startAt))}</p>` : ''}${block.gaps.map((gap) => `<p class="pub-diag warn small">${esc(p.gap(gap.group, gap.after, gap.startAt))}</p>`).join('')}
<details class="pub-more"><summary>${esc(p.showSteps(block.steps.length))}</summary><ol class="plain pub-steps">${block.steps.map((step) => `<li class="pub-step${step.kind === 'expect' ? ' is-check' : ''}"><span class="pub-pos">${String(step.position)}</span><span>${esc(step.label)}</span></li>`).join('')}</ol></details>
</li>`;
}

/** Le panneau de publication : l'aperçu de chaque bloc calculé par le serveur, puis publier tout ou rien. */
function previewSheet(state: DashboardState, publish: boolean): string {
  const p = state.t.pub;
  const ui = state.review?.publish ?? emptyPublishUi();
  const plan = ui.plan;
  const fresh = plan !== undefined && ui.planFor === planKey(ui);
  const body = !plan
    ? `<p class="mu" role="status"><span class="spin" aria-hidden="true"></span> ${esc(p.planning)}</p>`
    : `${plan.errors.length > 0 ? `<ul class="plain tight pub-diag">${plan.errors.map((text) => `<li class="ko">${esc(text)}</li>`).join('')}</ul>` : ''}<ol class="plain pub-blocks">${plan.blocks.map((block) => blockPreview(state, block, publish)).join('')}</ol>`;
  const ready = publish && fresh && plan.ok && !ui.busy && !ui.planning;
  return `<div class="lib-sheet-bg" data-action="pub-preview-close"></div><aside class="lib-sheet pub-sheet" role="dialog" aria-modal="true" aria-labelledby="pub-sheet-t">
<div class="lib-sheet-h"><h2 id="pub-sheet-t">${esc(p.previewTitle(plan?.blocks.length ?? 0))}</h2><button class="btn small ghost icon-only" data-action="pub-preview-close" aria-label="${esc(state.t.lib.close)}" title="${esc(state.t.lib.close)}">✕</button></div>
<p class="mu">${esc(ui.mode === 'composite' ? p.modeCompositeHint : p.modeSeparateHint)}</p>
${body}
${ui.error ? `<div class="err" role="alert"><p>${esc(ui.error)}</p>${(ui.details ?? []).length > 1 ? `<ul class="plain tight">${(ui.details ?? []).map((detail) => `<li>${esc(detail)}</li>`).join('')}</ul>` : ''}</div>` : ''}
<div class="form-acts start pub-sheet-f"><button class="btn primary" data-action="pub-publish" ${ready ? '' : 'disabled'} aria-busy="${String(Boolean(ui.busy))}">${icon('library')}<span>${esc(ui.busy ? p.publishing : p.publishN(plan?.blocks.length ?? 0))}</span></button><button class="btn ghost" data-action="pub-preview-close">${esc(state.t.review.cancel)}</button>${fresh && !plan.ok ? `<small class="err">${esc(p.fixFirst)}</small>` : ''}${ui.planning ? `<small class="mu">${esc(p.planning)}</small>` : ''}</div>
</aside>`;
}

/** L'ONGLET PUBLIER : la liste des groupes, le détail du groupe choisi, la barre d'action, l'aperçu. */
export function publishTab(state: DashboardState): string {
  const p = state.t.pub;
  const review = state.review;
  const view = review?.studio;
  if (!review || !view) return `<p class="mu">${esc(state.t.loading)}</p>`;
  const ui = review.publish ?? emptyPublishUi();
  const publish = can(state, 'PUBLISH') && state.project?.state !== 'ARCHIVED';
  const groups = view.groups;
  if (groups.length === 0)
    return `<section class="card pub-empty"><h2>${esc(p.noGroupTitle)}</h2><p class="mu">${esc(p.noGroup)}</p><button class="btn" data-action="review-tab" data-tab="flow">${esc(p.toFlow)}</button></section>`;
  const plan = ui.plan;
  const fresh = plan !== undefined && ui.planFor === planKey(ui);
  const all = groups.every((group) => ui.selected.includes(group.id));
  const toolbar = `<div class="pub-bar" role="toolbar" aria-label="${esc(p.selectionTools)}"><span class="pub-bar-l"><button class="btn small ghost" data-action="pub-all" ${!publish || all ? 'disabled' : ''}>${esc(p.selectAll)}</button><button class="btn small ghost" data-action="pub-none" ${!publish || ui.selected.length === 0 ? 'disabled' : ''}>${esc(p.selectNone)}</button></span><span class="ed-seg" role="radiogroup" aria-label="${esc(p.modeLabel)}"><button role="radio" aria-checked="${ui.mode === 'separate' ? 'true' : 'false'}" data-action="pub-mode" data-mode="separate" ${publish ? '' : 'disabled'}>${esc(p.modeSeparate)}</button><button role="radio" aria-checked="${ui.mode === 'composite' ? 'true' : 'false'}" data-action="pub-mode" data-mode="composite" ${publish ? '' : 'disabled'}>${esc(p.modeComposite)}</button></span><label class="ed-chk pub-nav" title="${esc(p.navigateHint)}"><input type="checkbox" data-pub="navigate" ${ui.navigate ? 'checked' : ''} ${publish ? '' : 'disabled'}><span>${esc(p.navigate)}</span></label></div>`;
  const summary =
    ui.selected.length === 0
      ? `<span class="mu">${esc(p.nothingChosen)}</span>`
      : fresh
        ? `<span><b>${esc(p.chosen(plan.summary.groups))}</b> · ${esc(p.summary(plan.summary.steps, plan.summary.produced, plan.summary.consumed))}</span>${plan.summary.external.length > 0 ? `<span class="warn-t">${esc(p.external(plan.summary.external.join(', ')))}</span>` : `<span class="ok-t">${esc(p.noExternal)}</span>`}${plan.summary.errors > 0 ? `<span class="err">${esc(p.problems(plan.summary.errors))}</span>` : ''}`
        : `<span><b>${esc(p.chosen(ui.selected.length))}</b></span><span class="mu">${esc(p.planning)}</span>`;
  const actionBar = `<div class="pub-foot" role="region" aria-label="${esc(p.footLabel)}">${summary}<span class="pub-foot-a"><button class="btn" data-action="pub-preview" ${ui.selected.length === 0 ? 'disabled' : ''}>${esc(p.preview)}</button><button class="btn primary" data-action="pub-preview" data-then="publish" ${!publish || ui.selected.length === 0 ? 'disabled' : ''}>${icon('library')}<span>${esc(p.publish)}</span></button></span></div>`;
  const messages = `${ui.notice ? `<p class="notice ok" role="status">${icon('check')}<span>${esc(ui.notice)}</span>${ui.published && ui.published.length > 0 ? ` <button class="lnk" data-action="nav" data-view="library">${esc(p.openLibrary)}</button>` : ''}</p>` : ''}${ui.error && !ui.preview ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ''}`;
  return `${messages}<p class="mu pub-intro">${esc(p.intro)}</p>${toolbar}<div class="pub-layout"><ol class="plain pub-groups" aria-label="${esc(p.groupsLabel)}">${groups.map((group, index) => groupRow(state, group, index, view.steps, publish)).join('')}</ol>${sidePanel(state, groups, view.steps)}</div>${actionBar}${ui.preview ? previewSheet(state, publish) : ''}`;
}

/** La barre supérieure de la revue : l'enregistrement en chiffres, et l'action principale. */
export function reviewFacts(state: DashboardState): string {
  const p = state.t.pub;
  const review = state.review;
  const view = review?.studio;
  if (!review || !view) return '';
  const snapshot = (state.recordings ?? []).find((entry) => entry.name === review.name);
  const target = state.project?.targetUrl ? new URL(state.project.targetUrl).host : '';
  const actions = view.steps.filter((step) => step.kind !== 'expect').length;
  const pending = (review.assertions ?? []).filter((proposal) => proposal.status === 'PROPOSED').length;
  const fact = (label: string, value: string): string =>
    `<div class="rv-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const publish = can(state, 'PUBLISH') && state.project?.state !== 'ARCHIVED' && view.groups.length > 0;
  return `<div class="rv-facts"><dl>${fact(p.factApp, `<code>${esc(target)}</code>`)}${snapshot?.startedAt ? fact(p.factRecorded, esc(new Date(snapshot.startedAt).toLocaleString(state.t.locale))) : ''}${fact(p.factSteps, esc(p.factStepsValue(actions, view.steps.length - actions)))}${fact(p.factGroups, esc(String(view.groups.length)))}${fact(p.factStatus, pending > 0 ? `<span class="warn-t">${esc(p.toReview(pending))}</span>` : `<span class="ok-t">${esc(p.reviewed)}</span>`)}</dl>${publish ? `<button class="btn primary" data-action="review-tab" data-tab="publish">${icon('library')}<span>${esc(p.publishToLibrary)}</span></button>` : ''}</div>`;
}
