import type { FlowStudioView, GroupViewDto, StudioStep, StudioViolation } from '../core/contracts.js';
import { NODE_HEIGHT, NODE_WIDTH, type LaidEdge, type StudioLayout, type Viewport } from './studio-layout.js';
import type { StudioStrings } from './studio-i18n.js';
import { esc, icon } from './view.js';

/**
 * LE RENDU DU FLOW STUDIO, en fonctions pures (testables sans navigateur). Le composant
 * (`studio.ts`) garde l'état et les gestes ; ici, seulement du texte échappé.
 */
export interface StudioNotice {
  kind: 'ok' | 'refused' | 'error';
  message: string;
  violations?: StudioViolation[];
}

export interface StudioState {
  t: StudioStrings;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  view?: FlowStudioView;
  layout?: StudioLayout;
  viewport: Viewport;
  /** Les étapes choisies (Maj + clic en ajoute). */
  selected: string[];
  selectedGroup?: string;
  query: string;
  matches: string[];
  matchIndex: number;
  notice?: StudioNotice;
  busy: boolean;
  /** Des cartes ont été déplacées à la main (le bouton « Remettre les positions » apparaît). */
  moved: boolean;
  /** La suppression d'un groupe attend une confirmation (deuxième clic). */
  confirmDelete?: string;
}

const KIND_CLASS: Record<string, string> = {
  goto: 'k-nav',
  click: 'k-act',
  fill: 'k-fill',
  select: 'k-fill',
  check: 'k-fill',
  expect: 'k-exp',
};

function short(text: string, max = 27): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function replayClass(step: StudioStep): string {
  if (!step.replay) return 'r-none';
  return step.replay.outcome === 'MATCHED'
    ? 'r-ok'
    : step.replay.outcome === 'NOT_VERIFIED'
      ? 'r-warn'
      : 'r-ko';
}

function stepLabel(step: StudioStep, group: GroupViewDto | undefined, t: StudioStrings): string {
  const parts = [
    `${t.step} ${String(step.position)} : ${step.description}`,
    `${t.group} : ${group?.name ?? t.noGroup}`,
    `${t.replay} : ${t.outcome(step.replay?.outcome)}`,
  ];
  if (step.produces.length > 0) parts.push(`${t.produces} : ${step.produces.join(', ')}`);
  if (step.consumes.length > 0) parts.push(`${t.consumes} : ${step.consumes.join(', ')}`);
  return parts.join(' — ');
}

function edgeSvg(edge: LaidEdge, highlighted: boolean): string {
  const cls = `e e-${edge.kind}${highlighted ? ' on' : ''}`;
  const marker = edge.kind === 'sequence' ? 'seq' : edge.kind === 'violation' ? 'bad' : 'data';
  const label =
    edge.key && (highlighted || edge.kind === 'violation')
      ? `<text class="ek" x="${String(edge.mid.x)}" y="${String(edge.mid.y)}">${esc(edge.key)}</text>`
      : '';
  return `<path class="${cls}" d="${edge.path}" marker-end="url(#m-${marker})" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}"/>${label}`;
}

/** Le contenu du `<g>` zoomé : cadres des groupes, liens, cartes. */
export function renderGraph(state: StudioState): string {
  const { view, layout, t } = state;
  if (!view || !layout) return '';
  const selected = new Set(state.selected);
  const matches = new Set(state.matches);
  const searching = state.query.trim() !== '';
  const current = state.matches[state.matchIndex];
  const groupById = new Map(view.groups.map((group) => [group.id, group]));
  const focusNodes = new Set(state.selected.map((id) => layout.nodeOf[id] ?? id));
  const frames = layout.groups
    .map((frame) => {
      const group = groupById.get(frame.groupId);
      const on = state.selectedGroup === frame.groupId;
      const count = group?.stepIds.length ?? 0;
      const toggle = frame.collapsed ? t.expand : t.collapse;
      return `<g class="frame${on ? ' on' : ''}${frame.collapsed ? ' folded' : ''}" data-frame="${esc(frame.key)}" data-group="${esc(frame.groupId)}">
<rect x="${String(frame.x)}" y="${String(frame.y)}" width="${String(frame.width)}" height="${String(frame.height)}" rx="14"/>
<g class="fh" data-select-group="${esc(frame.groupId)}" tabindex="0" role="button" aria-pressed="${String(on)}" aria-label="${esc(`${t.group} ${frame.name}${frame.continued ? ' (2)' : ''} — ${String(count)} ${t.steps}`)}">
<rect class="hit" x="${String(frame.x)}" y="${String(frame.y)}" width="${String(frame.width)}" height="34" rx="14"/>
<text class="fn" x="${String(frame.x + 14)}" y="${String(frame.y + 22)}">${esc(short(frame.name, 22))}${frame.continued ? ' ↺' : ''}</text>
<text class="fc" x="${String(frame.x + frame.width - 40)}" y="${String(frame.y + 22)}">${String(count)}</text>
</g>
<g class="tg" data-collapse="${esc(frame.groupId)}" tabindex="0" role="button" aria-label="${esc(`${toggle} ${frame.name}`)}">
<rect class="hit" x="${String(frame.x + frame.width - 26)}" y="${String(frame.y + 8)}" width="18" height="18" rx="5"/>
<path class="chev" d="${frame.collapsed ? `M${String(frame.x + frame.width - 20)} ${String(frame.y + 13)}l4 4 4-4` : `M${String(frame.x + frame.width - 20)} ${String(frame.y + 19)}l4-4 4 4`}"/>
</g>
</g>`;
    })
    .join('');
  const edges = layout.edges
    .filter((edge) => edge.kind === 'sequence')
    .map((edge) => edgeSvg(edge, false))
    .concat(
      layout.edges
        .filter((edge) => edge.kind !== 'sequence')
        .map((edge) => edgeSvg(edge, focusNodes.has(edge.from) || focusNodes.has(edge.to))),
    )
    .join('');
  const nodes = layout.steps
    .map(({ id, step, x, y }) => {
      const group = step.groupId ? groupById.get(step.groupId) : undefined;
      const cls = [
        'node',
        KIND_CLASS[step.kind] ?? 'k-act',
        replayClass(step),
        selected.has(id) ? 'sel' : '',
        searching && !matches.has(id) ? 'dim' : '',
        current === id ? 'cur' : '',
        view.violations.some((violation) => violation.stepId === id) ? 'bad' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const data =
        (step.produces.length > 0 ? `<tspan class="dp">◆${String(step.produces.length)}</tspan>` : '') +
        (step.consumes.length > 0 ? `<tspan class="dc"> ◇${String(step.consumes.length)}</tspan>` : '');
      return `<g class="${cls}" data-node="${esc(id)}" transform="translate(${String(x)} ${String(y)})" tabindex="0" role="button" aria-pressed="${String(selected.has(id))}" aria-label="${esc(stepLabel(step, group, t))}">
<rect class="card" width="${String(NODE_WIDTH)}" height="${String(NODE_HEIGHT)}" rx="9"/>
<rect class="kind" x="0" y="0" width="4" height="${String(NODE_HEIGHT)}" rx="2"/>
<text class="pos" x="12" y="21">${String(step.position)}</text>
<text class="lb" x="34" y="21">${esc(short(step.description))}</text>
<text class="dt" x="${String(NODE_WIDTH - 30)}" y="21">${data}</text>
<circle class="rp" cx="${String(NODE_WIDTH - 9)}" cy="9" r="4"/>
</g>`;
    })
    .join('');
  const summaries = layout.summaries
    .map(
      (
        summary,
      ) => `<g class="node summary${summary.stepIds.some((id) => selected.has(id)) ? ' sel' : ''}" data-summary="${esc(summary.groupId)}" transform="translate(${String(summary.x)} ${String(summary.y)})" tabindex="0" role="button" aria-label="${esc(`${groupById.get(summary.groupId)?.name ?? ''} — ${t.summary(summary.count)}`)}">
<rect class="card" width="${String(NODE_WIDTH)}" height="${String(NODE_HEIGHT)}" rx="9"/>
<text class="lb" x="14" y="21">${esc(t.summary(summary.count))}</text>
</g>`,
    )
    .join('');
  return `${frames}${edges}${nodes}${summaries}`;
}

export function viewportTransform(viewport: Viewport): string {
  return `translate(${viewport.x.toFixed(1)} ${viewport.y.toFixed(1)}) scale(${viewport.k.toFixed(3)})`;
}

function list(values: string[], t: StudioStrings): string {
  return values.length === 0
    ? `<span class="mu">${esc(t.none)}</span>`
    : values.map((value) => `<code>${esc(value)}</code>`).join(' ');
}

function noticeHtml(state: StudioState): string {
  const notice = state.notice;
  const view = state.view;
  if (!notice) return '';
  const describe = (stepId: string): string =>
    view?.steps.find((step) => step.id === stepId)?.description ?? stepId;
  const items = (notice.violations ?? [])
    .map(
      (violation) =>
        `<li>${esc(state.t.violation(violation.key, describe(violation.stepId), describe(violation.producerStepId)))}<br><span class="mu">${esc(state.t.suggestion(describe(violation.producerStepId)))}</span></li>`,
    )
    .join('');
  return `<div class="notice n-${notice.kind}" role="${notice.kind === 'ok' ? 'status' : 'alert'}"><b>${esc(notice.kind === 'refused' ? state.t.refused : notice.kind === 'ok' ? state.t.done : notice.message)}</b>${notice.kind === 'refused' ? `<p>${esc(notice.message)}</p>` : ''}${items ? `<ul>${items}</ul>` : ''}</div>`;
}

function overviewPanel(state: StudioState, view: FlowStudioView): string {
  const t = state.t;
  const replay = view.replay
    ? `<p>${esc(t.replayAt(view.replay.status, new Date(view.replay.at).toLocaleString(t.dateLocale)))}</p>${view.replay.stale ? `<p class="warn">${esc(t.replayStale)}</p>` : ''}`
    : `<p class="mu">${esc(t.replayNone)}</p>`;
  return `<h2>${esc(t.overview)}</h2>
<p class="nm">${esc(view.name)}</p>
<dl><dt>${esc(t.startAt)}</dt><dd><code>${esc(view.startAt)}</code></dd></dl>
<ul class="stats">
<li><b>${String(view.steps.length)}</b> ${esc(t.steps)}</li>
<li><b>${String(view.groups.length)}</b> ${esc(t.groupsWord)}</li>
<li><b>${String(view.dependencies.length)}</b> ${esc(t.dependenciesWord)}</li>
<li class="${view.violations.length > 0 ? 'bad' : ''}"><b>${String(view.violations.length)}</b> ${esc(t.violationsWord)}</li>
</ul>
${replay}
<h3>${esc(t.legend)}</h3>
<ul class="legend">
<li><i class="l-seq"></i>${esc(t.legendSequence)}</li>
<li><i class="l-data"></i>${esc(t.legendData)}</li>
<li><i class="l-bad"></i>${esc(t.legendViolation)}</li>
<li><i class="d r-ok"></i>${esc(t.legendPlayed)}</li>
<li><i class="d r-ko"></i>${esc(t.legendFailed)}</li>
<li><i class="d r-none"></i>${esc(t.legendNotPlayed)}</li>
</ul>
<p class="mu">${esc(t.selectHint)}</p>
<p class="mu">${esc(t.dragHint)}</p>
<p class="mu">${esc(t.positionsNote)}</p>`;
}

function groupOptions(view: FlowStudioView, current: string | undefined, t: StudioStrings): string {
  return `<option value="">${esc(t.choose)}</option>${view.groups
    .filter((group) => group.id !== current)
    .map((group) => `<option value="${esc(group.id)}">${esc(group.name)}</option>`)
    .join('')}`;
}

function stepPanel(state: StudioState, view: FlowStudioView): string {
  const t = state.t;
  const disabled = state.busy ? ' disabled' : '';
  if (state.selected.length > 1) {
    return `<h2>${esc(t.selection(state.selected.length))}</h2>
<ul class="picked">${state.selected
      .map((id) => view.steps.find((step) => step.id === id))
      .filter((step): step is StudioStep => step !== undefined)
      .map((step) => `<li>${String(step.position)}. ${esc(step.description)}</li>`)
      .join('')}</ul>
<form class="col" data-form="create"><label class="sr" for="qa-new-group">${esc(t.groupName)}</label><input id="qa-new-group" name="name" required maxlength="80" placeholder="${esc(t.groupName)}"><div class="row"><button class="btn pri"${disabled}>${esc(t.createFrom(state.selected.length))}</button></div></form>
<div class="row"><label class="sr" for="qa-assign-many">${esc(t.assignTo)}</label><select id="qa-assign-many" data-assign="many"${disabled}>${groupOptions(view, undefined, t)}</select></div>`;
  }
  const step = view.steps.find((entry) => entry.id === state.selected[0]);
  if (!step) return overviewPanel(state, view);
  const group = step.groupId ? view.groups.find((entry) => entry.id === step.groupId) : undefined;
  return `<h2>${esc(t.step)} ${String(step.position)}</h2>
<p class="nm">${esc(step.description)}</p>
<dl>
<dt>${esc(t.kind)}</dt><dd><code>${esc(step.kind)}</code></dd>
<dt>${esc(t.group)}</dt><dd>${group ? `<button class="lnk" data-select-group="${esc(group.id)}">${esc(group.name)}</button>` : `<span class="mu">${esc(t.noGroup)}</span>`}</dd>
<dt>${esc(t.produces)}</dt><dd>${list(step.produces, t)}</dd>
<dt>${esc(t.consumes)}</dt><dd>${list(step.consumes, t)}</dd>
<dt>${esc(t.replay)}</dt><dd><span class="pill ${replayClass(step)}">${esc(t.outcome(step.replay?.outcome))}</span>${step.replay?.reasons.length ? `<ul class="reasons">${step.replay.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}</dd>
</dl>
<div class="row"><button class="btn" data-cmd="move-step-up"${disabled}>${icon('arrowL')}${esc(t.moveUp)}</button><button class="btn" data-cmd="move-step-down"${disabled}>${esc(t.moveDown)}${icon('arrowR')}</button></div>
${group ? `<div class="row"><button class="btn" data-cmd="detach"${disabled}>${esc(t.detach)}</button></div>` : ''}
<div class="row"><label for="qa-assign-one">${esc(t.assignTo)}</label><select id="qa-assign-one" data-assign="one"${disabled}>${groupOptions(view, group?.id, t)}</select></div>
<form class="col" data-form="create"><label class="sr" for="qa-new-group">${esc(t.groupName)}</label><input id="qa-new-group" name="name" required maxlength="80" placeholder="${esc(t.groupName)}"><div class="row"><button class="btn pri"${disabled}>${esc(t.createGroup)}</button></div></form>`;
}

function groupPanel(state: StudioState, view: FlowStudioView, group: GroupViewDto): string {
  const t = state.t;
  const disabled = state.busy ? ' disabled' : '';
  const describe = (stepId: string | undefined): string =>
    view.steps.find((step) => step.id === stepId)?.description ?? stepId ?? '';
  const inputs = (group.data?.inputs ?? [])
    .map((input) => `<li><code>${esc(input.key)}</code> ← ${esc(describe(input.producerStepId))}</li>`)
    .join('');
  const outputs = (group.data?.outputs ?? [])
    .map(
      (output) =>
        `<li><code>${esc(output.key)}</code> → ${esc(output.consumerStepIds.map((id) => describe(id)).join(', '))}</li>`,
    )
    .join('');
  return `<h2>${esc(t.group)}</h2>
<form class="col" data-form="rename"><label for="qa-group-name">${esc(t.groupName)}</label><div class="row"><input id="qa-group-name" name="name" required maxlength="80" value="${esc(group.name)}"><button class="btn"${disabled}>${esc(t.rename)}</button></div></form>
<form class="col" data-form="describe"><label for="qa-group-desc">${esc(t.description)}</label><textarea id="qa-group-desc" name="description" maxlength="400" rows="3">${esc(group.description ?? '')}</textarea><div class="row"><button class="btn"${disabled}>${esc(t.save)}</button></div></form>
<div class="row"><button class="btn" data-cmd="move-group-up"${disabled}>${icon('arrowL')}${esc(t.moveUp)}</button><button class="btn" data-cmd="move-group-down"${disabled}>${esc(t.moveDown)}${icon('arrowR')}</button><button class="btn" data-collapse="${esc(group.id)}"${disabled}>${esc(group.collapsed ? t.expand : t.collapse)}</button></div>
<dl>
<dt>${esc(t.startAt)}</dt><dd><code>${esc(group.startAt)}</code></dd>
<dt>${esc(t.steps)}</dt><dd>${String(group.stepIds.length)}</dd>
<dt>${esc(t.checks)}</dt><dd>${String(group.checks.length + group.assertionIds.length)}</dd>
<dt>${esc(t.runnable)}</dt><dd class="${group.runnableAlone.ok ? 'ok' : 'warn'}">${esc(group.runnableAlone.ok ? t.runnableYes : t.runnableNo(group.runnableAlone.missing.join(', ')))}</dd>
</dl>
<p class="mu">${esc(t.runAloneLimit)}</p>
<h3>${esc(t.inputs)}</h3>${inputs ? `<ul class="io">${inputs}</ul>` : `<p class="mu">${esc(t.none)}</p>`}
<h3>${esc(t.outputs)}</h3>${outputs ? `<ul class="io">${outputs}</ul>` : `<p class="mu">${esc(t.none)}</p>`}
<div class="row"><button class="btn danger" data-cmd="delete-group"${disabled}>${esc(state.confirmDelete === group.id ? t.confirmDelete : t.deleteGroup)}</button></div>`;
}

export function renderPanel(state: StudioState): string {
  const view = state.view;
  if (!view) return '';
  const group = state.selectedGroup
    ? view.groups.find((entry) => entry.id === state.selectedGroup)
    : undefined;
  const body = group
    ? groupPanel(state, view, group)
    : state.selected.length > 0
      ? stepPanel(state, view)
      : overviewPanel(state, view);
  return `${noticeHtml(state)}${body}`;
}

/** La page complète du composant (le style est posé à côté par le composant). */
export function renderStudio(state: StudioState): string {
  const t = state.t;
  if (state.phase === 'idle') return `<div class="studio msg"><p>${esc(t.missing)}</p></div>`;
  if (state.phase === 'loading')
    return `<div class="studio msg" role="status" aria-busy="true"><span class="spin" aria-hidden="true"></span><p>${esc(t.loading)}</p></div>`;
  if (state.phase === 'error')
    return `<div class="studio msg" role="alert"><p>${esc(state.error ?? '')}</p><button class="btn" data-cmd="retry">${esc(t.retry)}</button></div>`;
  const view = state.view;
  const layout = state.layout;
  if (!view || !layout) return '';
  const total = state.matches.length;
  return `<div class="studio">
<header class="tb">
<b class="ttl">${esc(t.title)}</b><span class="mu nm">${esc(view.name)}</span>
<span class="sp"></span>
<div class="search"><label class="sr" for="qa-search">${esc(t.search)}</label>${icon('target')}<input id="qa-search" type="search" placeholder="${esc(t.search)}" value="${esc(state.query)}" autocomplete="off"><output class="mu" aria-live="polite">${state.query.trim() ? esc(t.matches(total === 0 ? 0 : state.matchIndex + 1, total)) : ''}</output></div>
<div class="zoom" role="group" aria-label="${esc(t.graph)}">
<button class="ib" data-cmd="zoom-out" aria-label="${esc(t.zoomOut)}" title="${esc(t.zoomOut)}">−</button>
<output class="zv" aria-live="off">${String(Math.round(state.viewport.k * 100))} %</output>
<button class="ib" data-cmd="zoom-in" aria-label="${esc(t.zoomIn)}" title="${esc(t.zoomIn)}">+</button>
<button class="btn" data-cmd="fit">${esc(t.fit)}</button>
${state.moved ? `<button class="btn" data-cmd="reset-positions">${esc(t.resetView)}</button>` : ''}
</div>
</header>
<div class="body">
<div class="canvas" tabindex="0" role="group" aria-label="${esc(t.graph)}" aria-roledescription="graph">
<svg class="g" xmlns="http://www.w3.org/2000/svg">
<defs>
<marker id="m-seq" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk-seq"/></marker>
<marker id="m-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk-data"/></marker>
<marker id="m-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk-bad"/></marker>
</defs>
<g class="vp" transform="${viewportTransform(state.viewport)}">${renderGraph(state)}</g>
</svg>
</div>
<aside class="side" aria-label="${esc(t.overview)}">${renderPanel(state)}</aside>
</div>
</div>`;
}
