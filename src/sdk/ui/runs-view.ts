import type {
  CoverageStatusName,
  FlowComparisonView,
  RequirementView,
  RunComparisonView,
  TraceabilityView,
} from '../core/contracts.js';
import { COVERAGE_STATUSES } from '../core/contracts.js';
import type { RunsStrings } from './runs-i18n.js';
import { esc } from './view.js';

/**
 * LE RENDU de <qa-crawler-run-compare>, en fonctions pures : un état → du HTML échappé. Tout ce qui
 * est affiché vient de l'API (écrit par le moteur) ; aucun statut ni pourcentage n'est déduit ici.
 */
export interface RunsState {
  t: RunsStrings;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  tab: 'compare' | 'traceability';
  /** Les explorations du projet, la plus récente d'abord. */
  runs: { name: string; createdAt: string }[];
  base?: string;
  head?: string;
  comparison?: RunComparisonView;
  comparisonError?: string;
  traceability?: TraceabilityView;
  traceabilityError?: string;
  /** Le statut de couverture montré dans l'onglet Traçabilité ('' : tous). */
  status: CoverageStatusName | '';
  /** Le flow dont les écarts sont dépliés. */
  open?: string;
}

const STATUS_TONE: Record<string, string> = {
  PASSED: 'ok',
  VERIFIED_PASS: 'ok',
  PASS: 'ok',
  FAILED: 'ko',
  VERIFIED_FAIL: 'ko',
  FAIL: 'ko',
  BLOCKED: 'warn',
  INCONCLUSIVE: 'warn',
  STALE_EVIDENCE: 'warn',
  UNVERIFIABLE: 'warn',
};

const pill = (text: string, raw: string): string =>
  `<span class="pill ${STATUS_TONE[raw] ?? 'mu'}">${esc(text)}</span>`;

const coverage = (t: RunsStrings, status: CoverageStatusName | undefined): string =>
  status ? pill(t.coverage[status], status) : `<span class="mu">${esc(t.absent)}</span>`;

const runLabel = (t: RunsStrings, run: { name: string; createdAt: string }): string => {
  const date = new Date(run.createdAt);
  return Number.isNaN(date.getTime())
    ? run.name
    : `${date.toLocaleString(t.dateLocale, { dateStyle: 'short', timeStyle: 'medium' })} — ${run.name}`;
};

function runSelect(state: RunsState, role: 'base' | 'head'): string {
  const t = state.t;
  const current = role === 'base' ? state.base : state.head;
  const options = state.runs
    .map(
      (run) =>
        `<option value="${esc(run.name)}"${run.name === current ? ' selected' : ''}>${esc(runLabel(t, run))}</option>`,
    )
    .join('');
  return `<label class="pick"><span>${esc(role === 'base' ? t.base : t.head)}</span><select data-run="${role}">${options}</select></label>`;
}

function flowRow(state: RunsState, flow: FlowComparisonView): string {
  const t = state.t;
  const open = state.open === flow.name;
  const verdict = flow.verdict
    ? pill(t.verdict[flow.verdict], flow.verdict === 'SAME' ? 'PASSED' : 'BLOCKED')
    : pill(t.presence[flow.presence], 'BLOCKED');
  const delta =
    flow.durationDeltaMs !== undefined
      ? `${flow.durationDeltaMs > 0 ? '+' : ''}${String(flow.durationDeltaMs)} ms`
      : t.absent;
  const changes =
    flow.changes.length === 0
      ? `<p class="mu">${esc(flow.presence === 'BOTH' ? t.noChange : t.presence[flow.presence])}</p>`
      : `<ul class="changes">${flow.changes
          .map(
            (change) =>
              `<li><b>${esc(t.changeKinds[change.kind] ?? change.kind)}</b>${change.step !== undefined ? ` <span class="mu">${esc(t.step)} ${String(change.step)}</span>` : ''} — ${esc(change.detail)}</li>`,
          )
          .join('')}</ul>`;
  return `<li class="flow${open ? ' open' : ''}">
<button type="button" class="row" data-flow="${esc(flow.name)}" aria-expanded="${String(open)}">
<span class="nm">${esc(flow.name)}</span>
<span class="st">${flow.baseStatus ? pill(flow.baseStatus, flow.baseStatus) : `<span class="mu">${esc(t.absent)}</span>`} → ${flow.headStatus ? pill(flow.headStatus, flow.headStatus) : `<span class="mu">${esc(t.absent)}</span>`}</span>
<span class="vd">${verdict}</span>
<span class="du mu" title="${esc(t.duration)}">${esc(delta)}</span>
</button>
${open ? `<div class="detail">${changes}</div>` : ''}
</li>`;
}

function comparePanel(state: RunsState): string {
  const t = state.t;
  if (state.runs.length < 2) return `<p class="note">${esc(t.oneRun)}</p>`;
  if (state.base === state.head) return `<p class="note">${esc(t.sameRun)}</p>`;
  if (state.comparisonError)
    return `<p class="note err" role="alert">${esc(t.failed + state.comparisonError)}</p>`;
  const view = state.comparison;
  if (!view) return `<p class="note mu">${esc(t.loading)}</p>`;
  const s = view.summary;
  const counts = `<ul class="counts" aria-label="${esc(t.flowsTitle)}">
<li><b>${String(s.flows)}</b> ${esc(t.summary.flows)}</li>
<li><b>${String(s.changed)}</b> ${esc(t.summary.changed)}</li>
<li><b>${String(s.same)}</b> ${esc(t.summary.same)}</li>
<li><b>${String(s.onlyBase)}</b> ${esc(t.summary.onlyBase)}</li>
<li><b>${String(s.onlyHead)}</b> ${esc(t.summary.onlyHead)}</li>
<li><b>${String(s.requirementsChanged)}</b> ${esc(t.summary.requirementsChanged)}</li>
</ul>`;
  const moves = [
    s.newlyFailing.length
      ? `<p class="move ko"><b>${esc(t.summary.newlyFailing)}</b> : ${s.newlyFailing.map(esc).join(', ')}</p>`
      : '',
    s.newlyPassing.length
      ? `<p class="move ok"><b>${esc(t.summary.newlyPassing)}</b> : ${s.newlyPassing.map(esc).join(', ')}</p>`
      : '',
  ].join('');
  const flows = view.flows.length
    ? `<ul class="flows">${view.flows.map((flow) => flowRow(state, flow)).join('')}</ul>`
    : `<p class="mu">${esc(t.noFlows)}</p>`;
  const requirements =
    view.requirements.length === 0
      ? `<p class="mu">${esc(t.noTraceability)}</p>`
      : `<table class="reqs"><thead><tr><th scope="col">${esc(t.requirementsTitle)}</th><th scope="col">${esc(t.base)}</th><th scope="col">${esc(t.head)}</th></tr></thead><tbody>${view.requirements
          .map(
            (requirement) =>
              `<tr${requirement.changed ? ' class="chg"' : ''}><th scope="row"><code>${esc(requirement.id)}</code> <span class="mu">${esc(requirement.description)}</span></th><td>${coverage(t, requirement.baseStatus)}</td><td>${coverage(t, requirement.headStatus)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return `${counts}${moves}<h3>${esc(t.flowsTitle)}</h3>${flows}<h3>${esc(t.requirementsTitle)}</h3>${requirements}`;
}

const list = (title: string, items: readonly string[]): string =>
  items.length
    ? `<div class="kv"><span class="mu">${esc(title)}</span> ${items.map(esc).join(', ')}</div>`
    : '';

function requirementCard(t: RunsStrings, requirement: RequirementView): string {
  const assertions = requirement.assertions.length
    ? `<div class="kv"><span class="mu">${esc(t.assertionsOf)}</span> ${requirement.assertions
        .map((assertion) => `<code>${esc(assertion.id)}</code> ${pill(assertion.status, assertion.status)}`)
        .join(' ')}</div>`
    : '';
  const last = requirement.lastVerified
    ? `<div class="kv"><span class="mu">${esc(t.lastVerified)}</span> ${coverage(t, requirement.lastVerified.status)} <span class="mu">${esc(requirement.lastVerified.runId)}</span></div>`
    : '';
  return `<li class="req"><div class="hd"><code>${esc(requirement.id)}</code><span class="crit">${esc(requirement.criticality)}</span>${coverage(t, requirement.status)}</div>
<p>${esc(requirement.description)}</p>
${list(t.flowsOf, requirement.flows)}${list(t.rulesOf, requirement.rules)}${assertions}${list(t.evidenceOf, requirement.evidence)}${list(t.reasonsOf, requirement.reasons)}${last}</li>`;
}

function traceabilityPanel(state: RunsState): string {
  const t = state.t;
  if (state.traceabilityError) return `<p class="note">${esc(state.traceabilityError)}</p>`;
  const view = state.traceability;
  if (!view) return `<p class="note mu">${esc(t.loading)}</p>`;
  const byStatus = COVERAGE_STATUSES.filter((status) => view.summary.byStatus[status] > 0)
    .map((status) => `<li>${coverage(t, status)} <b>${String(view.summary.byStatus[status])}</b></li>`)
    .join('');
  const options = [
    `<option value="">${esc(t.allStatuses)}</option>`,
    ...COVERAGE_STATUSES.map(
      (status) =>
        `<option value="${status}"${state.status === status ? ' selected' : ''}>${esc(t.coverage[status])} (${String(view.summary.byStatus[status])})</option>`,
    ),
  ].join('');
  const shown = view.requirements.filter(
    (requirement) => !state.status || requirement.status === state.status,
  );
  const critical = view.summary.criticalFailures.length
    ? `<p class="move ko"><b>${esc(t.criticalFailures)}</b> : ${view.summary.criticalFailures.map(esc).join(', ')}</p>`
    : '';
  return `<div class="trh"><span>${esc(t.verdictLabel)} ${pill(view.verdict, view.verdict)}</span><ul class="counts">${byStatus}</ul>
<label class="pick"><span>${esc(t.statusLabel)}</span><select data-status>${options}</select></label></div>
${critical}
${shown.length ? `<ul class="reqlist">${shown.map((requirement) => requirementCard(t, requirement)).join('')}</ul>` : `<p class="mu">${esc(t.noneMatching)}</p>`}
${view.warnings.length ? `<details><summary>${esc(t.warnings)} (${String(view.warnings.length)})</summary><ul>${view.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul></details>` : ''}
${view.limits.length ? `<details><summary>${esc(t.limits)}</summary><ul>${view.limits.map((limit) => `<li>${esc(limit)}</li>`).join('')}</ul></details>` : ''}`;
}

export function renderRuns(state: RunsState): string {
  const t = state.t;
  if (state.phase === 'idle') return `<section class="runs msg"><p class="mu">${esc(t.idle)}</p></section>`;
  if (state.phase === 'loading')
    return `<section class="runs msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p>${esc(t.loading)}</p></section>`;
  if (state.phase === 'error')
    return `<section class="runs msg"><p class="err" role="alert">${esc(t.failed + (state.error ?? ''))}</p></section>`;
  if (state.runs.length === 0)
    return `<section class="runs msg"><p class="mu">${esc(t.noRuns)}</p></section>`;
  const tab = (id: RunsState['tab']): string =>
    `<button type="button" role="tab" id="tab-${id}" aria-controls="panel" aria-selected="${String(state.tab === id)}" tabindex="${state.tab === id ? '0' : '-1'}" data-tab="${id}">${esc(t.tabs[id])}</button>`;
  return `<section class="runs">
<header class="tb"><h2 class="ttl">${esc(t.title)}</h2>${state.tab === 'compare' ? runSelect(state, 'base') : ''}${runSelect(state, 'head')}</header>
<div class="tabs" role="tablist">${tab('compare')}${tab('traceability')}</div>
<div class="panel" id="panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${state.tab === 'compare' ? comparePanel(state) : traceabilityPanel(state)}</div>
</section>`;
}
