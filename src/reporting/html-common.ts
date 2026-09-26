import type { Severity } from '../model/issue.js';
import type { FlowTreeNode } from './flow-tree.js';
import { displayName } from './flow-tree.js';
import { reportTexts, valueLabel, type ReportLanguage, type ReportTexts } from './i18n.js';

export const SEVERITY_COLORS: Record<Severity, string> = {
  INFO: '#2563eb',
  WARNING: '#b45309',
  ERROR: '#dc2626',
  CRITICAL: '#7f1d1d',
};

/** HTML-escapes text and attribute values. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function severityBadge(severity: Severity, language: ReportLanguage = 'en'): string {
  return `<span class="sev" style="background:${SEVERITY_COLORS[severity]}">${esc(valueLabel(language, severity))}</span>`;
}

/** Colored pill for a status or class; the CSS class stays the English value, the text follows the language. */
export function classPill(value: string, language: ReportLanguage = 'en'): string {
  return `<span class="pill ${esc(value)}">${esc(valueLabel(language, value))}</span>`;
}

export function card(label: string, value: number | string, color?: string): string {
  const style = color ? ` style="color:${color}"` : '';
  return `<div class="card"><div class="value"${style}>${esc(String(value))}</div><div class="label">${esc(label)}</div></div>`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export function formatDate(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Collapsible tree (nested <details>), with the action that led to each state. */
export function renderTreeHtml(
  tree: FlowTreeNode | undefined,
  issueCount: (stateId: string) => number,
  t: ReportTexts = reportTexts('en'),
): string {
  if (!tree) return `<p class="empty">${esc(t.noState)}</p>`;
  const item = (branch: FlowTreeNode): string => {
    const issues = issueCount(branch.node.id);
    const via = branch.via
      ? `<span class="via">${esc(valueLabel(t.lang, branch.via.action.type))} “${esc(branch.via.action.text ?? branch.via.action.label ?? '')}”</span> `
      : '';
    const title = `${via}<b>${esc(displayName(branch.node))}</b> <code>${esc(branch.node.route)}</code> <span class="muted">#${esc(branch.node.id)}</span>${issues > 0 ? ` <span class="sev" style="background:${SEVERITY_COLORS.ERROR}">${esc(t.issueCount(issues))}</span>` : ''}`;
    if (branch.children.length === 0) return `<li><span class="leaf">${title}</span></li>`;
    return `<li><details open><summary>${title}</summary><ul>${branch.children.map(item).join('')}</ul></details></li>`;
  };
  return `<ul class="tree">${item(tree)}</ul>`;
}

export const BASE_CSS = `
  :root { --bg:#f5f7fa; --card:#fff; --text:#1f2937; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:var(--bg); color:var(--text); }
  header { background:#0f172a; color:#fff; padding:24px 32px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  header .meta { color:#cbd5e1; font-size:13px; word-break:break-all; }
  header nav a { color:#93c5fd; margin-right:14px; font-size:13px; }
  main { max-width:1240px; margin:0 auto; padding:24px 16px 48px; }
  .status { display:inline-block; margin-top:10px; padding:3px 10px; border-radius:999px; font-weight:600; font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .value { font-size:24px; font-weight:700; }
  .card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin-bottom:20px; overflow-x:auto; }
  h2 { font-size:16px; margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  td.wrap { word-break:break-word; }
  .sev { display:inline-block; padding:1px 8px; border-radius:999px; color:#fff; font-size:11px; font-weight:700; }
  .pill { display:inline-block; padding:1px 7px; border-radius:6px; background:#eef2ff; font-size:11px; margin:1px; }
  .pill.PASSED, .pill.SUCCESS, .pill.HANDLED { background:#dcfce7; color:#166534; }
  .pill.DETECTED { background:#dbeafe; color:#1e40af; }
  .pill.UNSUPPORTED { background:#f1f5f9; color:#475569; }
  .pill.FAILED, .pill.DANGEROUS { background:#fee2e2; color:#991b1b; }
  .pill.BLOCKED, .pill.MUTATION { background:#fef3c7; color:#92400e; }
  .pill.SKIPPED, .pill.UNKNOWN { background:#f1f5f9; color:#475569; }
  .flow-run { margin-bottom:18px; }
  .flow-run h3 { margin:0 0 6px; font-size:15px; }
  .SAFE, .SUCCESS { background:#dcfce7; } .MUTATION { background:#fef3c7; } .DANGEROUS, .BLOCKED { background:#fee2e2; } .UNKNOWN { background:#e5e7eb; } .FAILED { background:#fde68a; }
  .muted { color:var(--muted); }
  .empty { color:var(--muted); font-style:italic; }
  .flow { font-size:12px; color:var(--muted); }
  .flow b { color:var(--text); font-weight:600; }
  details summary { cursor:pointer; }
  .tree, .tree ul { list-style:none; margin:0; padding-left:18px; }
  .tree { padding-left:0; }
  .tree li { position:relative; padding:3px 0 3px 14px; border-left:1px solid #cbd5e1; }
  .tree li:last-child { border-left-color:transparent; }
  .tree li::before { content:''; position:absolute; left:0; top:0; height:14px; width:12px; border-bottom:1px solid #cbd5e1; border-left:1px solid #cbd5e1; margin-left:-1px; }
  .tree > li { border-left:none; padding-left:0; } .tree > li::before { display:none; }
  .via { display:inline-block; font-size:11px; color:#1d4ed8; background:#eff6ff; border-radius:4px; padding:0 5px; }
  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; }
  .shots figure { margin:0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fff; }
  .shots img { width:100%; display:block; aspect-ratio:16/10; object-fit:cover; object-position:top; }
  .shots figcaption { padding:6px 8px; font-size:12px; word-break:break-all; }
  code { font-size:12px; }
`;
