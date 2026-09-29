import { BASE_CSS, card, esc, formatDuration } from '../reporting/html-common.js';
import { describeFlowIntent, type FlowIntentGraph } from './flow-intent-graph.js';
import type {
  ObservedFlowGraph,
  Reconciliation,
  ReconciliationEntry,
  ReconciliationStatus,
  SuggestedFlowGraph,
} from './reconciliation-model.js';

const STATUS_COLORS: Record<ReconciliationStatus, string> = {
  MATCHED: '#15803d',
  INSERTED: '#2563eb',
  MISSING: '#b45309',
  REORDERED: '#7c3aed',
  ALTERNATIVE: '#0891b2',
  AMBIGUOUS: '#b45309',
  UNREACHABLE: '#dc2626',
  POSSIBLY_OBSOLETE: '#b45309',
  ASSERTION_MISMATCH: '#dc2626',
  BLOCKED_BY_POLICY: '#7f1d1d',
  NOT_VERIFIED: '#64748b',
};

const SYMBOLS: Record<ReconciliationStatus, string> = {
  MATCHED: '✓',
  INSERTED: '+',
  MISSING: '?',
  REORDERED: '↕',
  ALTERNATIVE: '⇄',
  AMBIGUOUS: '≈',
  UNREACHABLE: '✗',
  POSSIBLY_OBSOLETE: '−',
  ASSERTION_MISMATCH: '≠',
  BLOCKED_BY_POLICY: '⛔',
  NOT_VERIFIED: '…',
};

const GLOBAL_COLORS: Record<Reconciliation['status'], string> = {
  FULLY_MATCHED: '#15803d',
  PARTIALLY_MATCHED: '#2563eb',
  DIVERGED: '#b45309',
  BLOCKED: '#7f1d1d',
  INCONCLUSIVE: '#64748b',
};

export interface DryRunReportInput {
  graph: FlowIntentGraph;
  observed: ObservedFlowGraph;
  reconciliation: Reconciliation;
  suggested: SuggestedFlowGraph;
  /** Fichiers produits, relatifs au rapport. */
  files: Record<string, string>;
  generatedAt: string;
}

/**
 * La vue Dry Run : ORIGINAL | statut | SUGGÉRÉ côte à côte, le résumé, et pour chaque
 * différence son explication (où, comment, pourquoi, avec quelle confiance). Seulement
 * des libellés : jamais une valeur saisie.
 */
export function dryRunHtml(input: DryRunReportInput): string {
  const { graph, observed, reconciliation, suggested } = input;
  const s = reconciliation.summary;
  const cards = [
    card('Original intents', s.originalIntents),
    card('Matched', s.matched, '#15803d'),
    card('Inserted', s.inserted, '#2563eb'),
    card('Reordered', s.reordered, '#7c3aed'),
    card('Alternative', s.alternative, '#0891b2'),
    card('Possibly obsolete', s.possiblyObsolete, '#b45309'),
    card('Missing', s.missing, '#b45309'),
    card('Ambiguous', s.ambiguous, '#b45309'),
    card('Unreachable', s.unreachable, '#dc2626'),
    card('Assertion mismatch', s.assertionMismatch, '#dc2626'),
    card('Blocked', s.blocked, '#7f1d1d'),
    card('Not verified', s.notVerified, '#64748b'),
  ].join('');

  const rows = reconciliation.entries.map((entry, index) => row(entry, index)).join('');
  const budget = observed.budget;
  const files = Object.entries(input.files)
    .map(([label, file]) => `<li><a href="${esc(file)}">${esc(label)}</a></li>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(graph.name)} — dry run</title>
<style>${BASE_CSS}${CSS}</style></head>
<body>
<header class="dr-head"><div class="wrap">
  <div class="kicker">QA-CRAWLER · DRY RUN · ${esc(graph.source.type)}${graph.source.file ? ` · ${esc(graph.source.file)}` : ''}</div>
  <h1>${esc(graph.name)}</h1>
  <div class="status" style="--c:${GLOBAL_COLORS[reconciliation.status]}">${esc(reconciliation.status)}</div>
  <p class="sub">Expected (the scenario) + observed (the application) → one reconciliation → one suggested flow. The scenario file is never modified.</p>
</div></header>
<main class="wrap">
  <section><h2>Summary</h2><div class="cards">${cards}</div>
    <p class="muted">Stop: ${esc(observed.stopReason)} · guided actions ${String(budget.actions)}/${String(budget.maxActions)} · ${esc(formatDuration(budget.durationMs))} of ${esc(formatDuration(budget.maxDurationMs))}${budget.exhausted ? ` · budget exhausted (${esc(budget.exhausted)})` : ''}</p>
  </section>
  <section><h2>Original · Suggested</h2>
    <table class="dr"><thead><tr><th>#</th><th>Original (expected)</th><th></th><th>Suggested (observed)</th><th>Status</th><th>Confidence</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted">Click a row for its explanation: reasons and evidence. A step not found is kept for review in the suggested flow, never deleted automatically. A historical frequency is an observed frequency, never a probability of being right.</p>
  </section>
  <section><h2>Expected intents</h2><ol class="plain">${graph.intents
    .map(
      (intent) =>
        `<li><code>${esc(describeFlowIntent(intent))}</code> <span class="muted">${esc(intent.sourceReference.text)}${intent.sourceReference.line !== undefined ? ` · line ${String(intent.sourceReference.line)}` : ''}</span></li>`,
    )
    .join('')}</ol></section>
  <section><h2>Observed path</h2><ol class="plain">${observed.steps
    .map((step) => {
      const from = observed.states.find((state) => state.id === step.from)?.label ?? step.from;
      const to = observed.states.find((state) => state.id === step.to)?.label ?? step.to;
      return `<li>${esc(from)} → <b>${esc(step.label)}</b> → ${esc(to)} <span class="muted">(${esc(step.origin)}, ${esc(step.provenance)})</span></li>`;
    })
    .join('')}</ol></section>
  <section><h2>Suggested flow (${esc(suggested.status)})</h2><ol class="plain">${suggested.steps
    .map(
      (step) =>
        `<li${step.review ? ' class="review"' : ''}><b>${esc(step.label)}</b> <span class="muted">${esc(step.status)} · ${esc(step.provenance)}${step.fillFormBefore ? ' · form filled with test data first' : ''}${step.review ? ` · ${esc(step.review)}` : ''}</span></li>`,
    )
    .join('')}</ol></section>
  <section><h2>Files</h2><ul class="plain">${files}</ul></section>
  <p class="muted">Generated ${esc(input.generatedAt)}</p>
</main></body></html>
`;
}

function row(entry: ReconciliationEntry, index: number): string {
  const color = STATUS_COLORS[entry.status];
  const original = entry.expectedIntent
    ? `${esc(entry.expectedIntent.label)}<div class="muted">${esc(entry.expectedIntent.text)}${entry.expectedIntent.line !== undefined ? ` · line ${String(entry.expectedIntent.line)}` : ''}</div>`
    : '';
  const kept =
    entry.status === 'POSSIBLY_OBSOLETE' || entry.status === 'MISSING' || entry.status === 'UNREACHABLE';
  const suggested = entry.observedTarget
    ? `${esc(entry.observedTarget.label)}<div class="muted">on ${esc(entry.observedTarget.state)}</div>`
    : kept
      ? '<span class="muted">(kept for review)</span>'
      : entry.expectedIntent
        ? `${esc(entry.expectedIntent.label)}<div class="muted">kept as written</div>`
        : '';
  const explanation = [
    ...entry.reasons.map((reason) => `<li>${esc(reason)}</li>`),
    ...entry.evidence.map((evidence) => `<li class="evidence">${esc(evidence)}</li>`),
  ].join('');
  return `<tr class="dr-row" style="--c:${color}"><td>${String(index + 1)}</td><td>${original}</td><td class="sym">${esc(SYMBOLS[entry.status])}</td><td>${suggested}</td><td><span class="dr-pill">${esc(entry.status)}</span></td><td>${entry.confidence.toFixed(2)}</td></tr>
<tr class="dr-why"><td></td><td colspan="5"><details><summary>Why</summary><ul>${explanation}</ul></details></td></tr>`;
}

const CSS = `
  .wrap { max-width:1180px; margin:0 auto; padding:0 20px; }
  .dr-head { background:linear-gradient(135deg,var(--head-from),var(--head-to)); color:#fff; padding:28px 0 22px; margin-bottom:22px; }
  .dr-head h1 { margin:6px 0 10px; font-size:26px; }
  .dr-head .kicker { font-size:12px; letter-spacing:.08em; opacity:.8; }
  .dr-head .sub { opacity:.85; margin:10px 0 0; }
  .status { display:inline-block; background:var(--c); color:#fff; font-weight:700; padding:4px 12px; border-radius:999px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:16px 18px; margin-bottom:18px; }
  section h2 { margin:0 0 12px; font-size:17px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; }
  .muted { color:var(--muted); font-size:12px; }
  table.dr { width:100%; border-collapse:collapse; }
  table.dr th { text-align:left; font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); padding:6px 8px; }
  table.dr td { padding:7px 8px; border-bottom:1px solid var(--soft-line); vertical-align:top; }
  tr.dr-row td:first-child { border-left:3px solid var(--c); }
  td.sym { font-weight:700; color:var(--c); text-align:center; width:28px; }
  .dr-pill { background:var(--c); color:#fff; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:600; white-space:nowrap; }
  tr.dr-why td { border-bottom:1px solid var(--line); padding-top:0; }
  tr.dr-why summary { cursor:pointer; color:var(--muted); font-size:12px; }
  tr.dr-why ul { margin:6px 0 4px; font-size:12px; }
  tr.dr-why li.evidence { color:var(--muted); }
  ol.plain, ul.plain { margin:0; padding-left:22px; }
  ol.plain li { margin:3px 0; }
  li.review { opacity:.75; }
`;
