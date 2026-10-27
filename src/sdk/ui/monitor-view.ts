import type { ExplorationEvent, ExplorationSnapshot } from '../core/contracts.js';
import { applyEvent, emptyCounters, totalIssues } from '../core/lifecycle.js';
import type { MonitorStrings } from './monitor-i18n.js';
import { flowProgress, monitorFacets, selectEvents, type MonitorView } from './monitor-model.js';
import { enginePhase } from './engine-phases.js';
import { esc } from './view.js';

/** Le rendu du Run Monitor, en fonctions pures : un état → du HTML échappé. */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'lost';

export interface MonitorState {
  t: MonitorStrings;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  snapshot?: ExplorationSnapshot;
  events: ExplorationEvent[];
  connection: ConnectionState;
  attempt: number;
  view: MonitorView;
}

const TONE: Record<string, string> = {
  PASSED: 'ok',
  COMPLETED: 'ok',
  FAILED: 'ko',
  ERROR: 'ko',
  CRITICAL: 'ko',
  BLOCKED: 'warn',
  WARNING: 'warn',
  SKIPPED: 'mu',
  MANUAL: 'mu',
  INFO: 'mu',
};

const pill = (text: string, raw: string): string =>
  `<span class="pill ${TONE[raw] ?? 'mu'}">${esc(text)}</span>`;

function eventLine(t: MonitorStrings, event: ExplorationEvent): string {
  switch (event.type) {
    case 'flow-step':
      return `<b>${esc(event.flow)}</b> · ${esc(t.step)} ${String(event.index)} — ${esc(event.label)} ${pill(event.status, event.status)} <span class="mu">${String(event.durationMs)} ms</span>${event.reason ? `<div class="mu why">${esc(event.reason)}</div>` : ''}`;
    case 'flow':
      return event.phase === 'start'
        ? `<b>${esc(event.flow)}</b> ${esc(t.flowStart)}`
        : `<b>${esc(event.flow)}</b> ${esc(t.flowEnd)} ${event.status ? pill(event.status, event.status) : ''}${event.durationMs !== undefined ? ` <span class="mu">${String(event.durationMs)} ms</span>` : ''}`;
    case 'state':
      return `${esc(event.label || event.title || event.route)} <code>${esc(event.route)}</code>`;
    case 'transition':
      return esc(event.action);
    case 'blocked':
      return `${esc(event.action)} — <span class="mu">${esc(event.reason)}</span>`;
    case 'issue':
      return `${pill(event.severity, event.severity)} <code>${esc(event.issueType)}</code> ${esc(event.message)}${event.route ? ` <span class="mu">${esc(event.route)}</span>` : ''}`;
    case 'status':
      return `${esc(t.status[event.status] ?? event.status)}${event.message ? ` — ${esc(event.message)}` : ''}`;
    case 'authenticated':
      return esc(event.message);
    case 'phase':
      return esc(enginePhase(event.phase, t.locale));
    case 'completed':
      return esc(t.status.COMPLETED ?? 'COMPLETED');
    case 'failed':
      return esc(event.error);
  }
}

function choice(
  label: string,
  name: keyof MonitorView,
  values: readonly string[],
  current: string,
  all: string,
  text = (value: string): string => value,
): string {
  const options = [
    `<option value="">${esc(all)}</option>`,
    ...values.map(
      (value) =>
        `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text(value))}</option>`,
    ),
  ].join('');
  return `<label class="pick"><span>${esc(label)}</span><select data-view="${name}">${options}</select></label>`;
}

export function renderMonitor(state: MonitorState): string {
  const t = state.t;
  if (state.phase === 'idle') return `<section class="mon msg"><p class="mu">${esc(t.idle)}</p></section>`;
  if (state.phase === 'loading')
    return `<section class="mon msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p>${esc(t.loading)}</p></section>`;
  if (state.phase === 'error')
    return `<section class="mon msg"><p class="err" role="alert">${esc(t.failed + (state.error ?? ''))}</p></section>`;
  const status = state.snapshot?.status ?? 'RUNNING';
  const connection =
    state.connection === 'reconnecting'
      ? t.connection.reconnecting(state.attempt)
      : t.connection[state.connection];
  const counters = state.events.reduce(applyEvent, state.snapshot?.counters ?? emptyCounters());
  const steps = state.events.filter((event) => event.type === 'flow-step').length;
  const flows = flowProgress(state.events);
  const facets = monitorFacets(state.events);
  const { shown, matching } = selectEvents(state.events, state.view);
  const flowCards = flows.length
    ? `<ul class="flows">${flows
        .map(
          (flow) =>
            `<li><span class="nm">${esc(flow.name)}</span>${flow.status ? pill(flow.status, flow.status) : `<span class="pill mu">${esc(t.running)}</span>`}<span class="mu">${Object.entries(
              flow.byStatus,
            )
              .map(([key, count]) => `${String(count)} ${esc(key)}`)
              .join(' · ')}</span></li>`,
        )
        .join('')}</ul>`
    : `<p class="mu">${esc(t.noFlows)}</p>`;
  const list = shown.length
    ? `<ol class="events">${shown
        .map(
          (event) =>
            `<li class="ev ev-${esc(event.type)}"><time>${esc(new Date(event.at).toLocaleTimeString(t.dateLocale))}</time><span class="ty">${esc(t.types[event.type] ?? event.type)}</span><span class="tx">${eventLine(t, event)}</span></li>`,
        )
        .join('')}</ol>`
    : `<p class="mu">${esc(t.noEvents)}</p>`;
  return `<section class="mon">
<header class="tb"><h2 class="ttl">${esc(t.title)}</h2>${state.snapshot ? `<code>${esc(state.snapshot.id)}</code>` : ''}${pill(t.status[status] ?? status, status)}<span class="conn ${state.connection}" role="status" aria-live="polite">${esc(connection)}</span></header>
<ul class="counts">
<li><b>${String(counters.states)}</b> ${esc(t.counters.states)}</li>
<li><b>${String(counters.actions)}</b> ${esc(t.counters.actions)}</li>
<li><b>${String(counters.blocked)}</b> ${esc(t.counters.blocked)}</li>
<li><b>${String(totalIssues(counters.issues))}</b> ${esc(t.counters.issues)}</li>
<li><b>${String(steps)}</b> ${esc(t.counters.steps)}</li>
</ul>
<div class="body">
<h3>${esc(t.flowsTitle)}</h3>${flowCards}
<fieldset class="view"><legend>${esc(t.show)}</legend>
${choice(t.flow, 'flow', facets.flows, state.view.flow, t.all)}
${choice(t.stepStatus, 'stepStatus', facets.stepStatuses, state.view.stepStatus, t.all)}
${choice(t.type, 'type', facets.types, state.view.type, t.all, (value) => t.types[value] ?? value)}
${choice(t.issueType, 'issueType', facets.issueTypes, state.view.issueType, t.all)}
</fieldset>
<p class="mu cnt" aria-live="polite">${esc(t.shown(shown.length, matching, state.events.length))}</p>
${list}
<p class="mu note">${esc(t.groupsNote)}</p>
</div>
</section>`;
}
