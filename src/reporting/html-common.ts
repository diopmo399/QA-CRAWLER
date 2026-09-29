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

/** Échappe le texte et les valeurs d'attribut pour le HTML. */
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

/** Pastille colorée pour un statut ou une classe ; la classe CSS reste la valeur anglaise, le texte suit la langue. */
export function classPill(value: string, language: ReportLanguage = 'en'): string {
  return `<span class="pill ${esc(value)}">${esc(valueLabel(language, value))}</span>`;
}

export function card(label: string, value: number | string, color?: string): string {
  const style = color ? ` style="color:${color}"` : '';
  const accent = color ? ` style="border-top-color:${color}"` : '';
  return `<div class="card${color ? ' accent' : ''}"${accent}><div class="value"${style}>${esc(String(value))}</div><div class="label">${esc(label)}</div></div>`;
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

/** Arbre repliable (<details> imbriqués), avec l'action qui a mené à chaque état. */
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
  :root { color-scheme:light dark; --bg:#f5f7fa; --card:#fff; --text:#1f2937; --muted:#6b7280; --line:#e5e7eb; --soft:#f8fafc; --soft-line:#e2e8f0; --link:#1d4ed8; --head:#0f172a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b1120; --card:#111827; --text:#e5e7eb; --muted:#9ca3af; --line:#1f2937; --soft:#1e293b; --soft-line:#334155; --link:#93c5fd; --head:#020617; }
    .card .value[style] { filter:brightness(1.6); }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; font:14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:var(--bg); color:var(--text); }
  a { color:var(--link); }
  header { background:var(--head); color:#fff; padding:24px 32px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  header .meta { color:#cbd5e1; font-size:13px; word-break:break-all; }
  header nav a { color:#93c5fd; margin-right:14px; font-size:13px; }
  .layout { display:grid; grid-template-columns:230px minmax(0,1fr); gap:24px; max-width:1500px; margin:0 auto; padding:24px 16px 48px; }
  body > main { max-width:1240px; margin:0 auto; padding:24px 16px 48px; }
  .summary { grid-column:1 / -1; }
  main { min-width:0; }
  .toc { position:sticky; top:12px; align-self:start; max-height:calc(100vh - 24px); overflow-y:auto; font-size:13px; padding:12px 14px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  .toc-title { font-weight:700; margin-bottom:6px; }
  .toc ul { list-style:none; margin:0; padding:0; }
  .toc ul ul { margin:2px 0 8px; padding-left:10px; border-left:2px solid var(--line); }
  .toc li { margin:2px 0; }
  .toc a { color:var(--text); text-decoration:none; display:block; padding:1px 4px; border-radius:4px; }
  .toc a:hover { background:var(--soft); }
  .toc a.toc-group { font-weight:600; color:var(--muted); text-transform:uppercase; font-size:11px; letter-spacing:.05em; margin-top:6px; }
  .toc li.alert > a { color:#dc2626; font-weight:600; }
  .toc li.alert > a::before { content:'● '; }
  .group { margin-bottom:12px; scroll-margin-top:12px; }
  .group-title { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:8px 0 10px; }
  .group-hint { margin:-6px 0 10px; }
  .status { display:inline-block; margin-top:10px; padding:3px 10px; border-radius:999px; font-weight:600; font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-bottom:12px; }
  .cards.secondary { margin-bottom:24px; }
  .cards.secondary .card { padding:10px 14px; }
  .cards.secondary .value { font-size:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card.accent { border-top-width:3px; }
  .card .value { font-size:24px; font-weight:700; }
  .card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin-bottom:16px; overflow-x:auto; scroll-margin-top:12px; }
  h2 { font-size:16px; margin:0 0 12px; }
  section > details > summary { list-style:none; display:flex; align-items:center; gap:8px; }
  section > details > summary::-webkit-details-marker { display:none; }
  section > details > summary::before { content:'▸'; color:var(--muted); font-size:14px; transition:transform .15s; }
  section > details[open] > summary::before { transform:rotate(90deg); }
  section > details > summary h2 { margin:0; display:inline; }
  section > details[open] > summary { margin-bottom:12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; position:sticky; top:0; background:var(--card); }
  tbody tr:hover > td { background:var(--soft); }
  td.wrap { word-break:break-word; }
  .sev { display:inline-block; padding:1px 8px; border-radius:999px; color:#fff; font-size:11px; font-weight:700; }
  .pill { display:inline-block; padding:1px 7px; border-radius:6px; background:#eef2ff; color:#1e293b; font-size:11px; margin:1px; }
  .pill.PASSED, .pill.SUCCESS, .pill.HANDLED { background:#dcfce7; color:#166534; }
  .pill.DETECTED { background:#dbeafe; color:#1e40af; }
  .pill.UNSUPPORTED { background:#f1f5f9; color:#475569; }
  .pill.FAILED, .pill.DANGEROUS { background:#fee2e2; color:#991b1b; }
  .pill.BLOCKED, .pill.MUTATION { background:#fef3c7; color:#92400e; }
  .pill.MANUAL { background:#fef3c7; color:#92400e; }
  .pill.SKIPPED, .pill.UNKNOWN { background:#f1f5f9; color:#475569; }
  .flow-run { margin-bottom:18px; }
  .suggest { margin-top:6px; color:var(--text); }
  pre.diff { margin:4px 0 10px; padding:8px 10px; background:var(--soft); border:1px solid var(--soft-line); border-radius:6px; font-size:12px; white-space:pre-wrap; }
  .pill.CHANGED, .pill.UNREACHABLE, .pill.ACTION_MISSING { background:#fde2e1; color:#9f1239; }
  pre.network { margin:4px 0 0; padding:4px 6px; background:var(--soft); border-radius:4px; font-size:11px; white-space:pre-wrap; word-break:break-all; }
  .suggest pre { margin:4px 0 0; padding:6px 8px; background:#fff7e6; color:#1f2937; border:1px solid #f0c36d; border-radius:6px; white-space:pre-wrap; word-break:break-all; font-size:12px; }
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
  .shots figure { margin:0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--card); }
  .shots img { width:100%; display:block; aspect-ratio:16/10; object-fit:cover; object-position:top; background:#fff; }
  .shots figcaption { padding:6px 8px; font-size:12px; word-break:break-all; }
  code { font-size:12px; }
  @media (max-width: 900px) {
    header { padding:18px 16px; }
    .layout { display:block; padding:16px 12px 40px; }
    .toc { position:static; max-height:none; margin-bottom:16px; }
    .toc > ul { columns:2; column-gap:16px; }
    .toc > ul > li { break-inside:avoid; }
    section { padding:14px 12px; }
    th { position:static; }
    table { min-width:600px; }
  }
  @media (max-width: 520px) { .toc > ul { columns:1; } }
  @media print {
    :root { --bg:#fff; --card:#fff; --text:#111; --muted:#555; --line:#ddd; --soft:#f5f5f5; --soft-line:#ddd; }
    header { background:#fff; color:#111; border-bottom:2px solid #111; padding:0 0 12px; }
    header .meta { color:#333; }
    header nav, .toc { display:none; }
    .layout { display:block; padding:0; }
    section { border:none; padding:8px 0; overflow:visible; break-inside:auto; }
    section > details > summary::before { display:none; }
    details::details-content { content-visibility:visible; display:contents; }
    th { position:static; }
    a { color:inherit; text-decoration:none; }
  }
`;

/** Une section du rapport ; `alert` signale dans le sommaire qu'elle contient des anomalies. */
export type ReportSection = string | { html: string; alert: boolean };

export interface ReportGroup {
  title: string;
  hint?: string;
  /** Sections repliées (<details>) : le détail reste dans la page, sans l'allonger. */
  collapsed: boolean;
  sections: ReportSection[];
}

const SECTION_HEAD = /^<section>\s*<h2>([\s\S]*?)<\/h2>/;

/**
 * Numérote les sections (ancres), les replie au besoin et construit le sommaire.
 * Sans JavaScript : de simples liens et des <details>.
 */
export function layoutSections(groups: ReportGroup[], contents: string): { toc: string; body: string } {
  let index = 0;
  const tocGroups: string[] = [];
  const bodyGroups: string[] = [];
  for (const group of groups) {
    const links: string[] = [];
    const blocks: string[] = [];
    for (const section of group.sections) {
      const html = (typeof section === 'string' ? section : section.html).trim();
      if (!html) continue;
      const alert = typeof section !== 'string' && section.alert;
      const head = SECTION_HEAD.exec(html);
      if (!head) {
        blocks.push(html);
        continue;
      }
      const id = `section-${++index}`;
      const title = head[1] ?? '';
      const rest = html.slice(head[0].length).replace(/<\/section>$/, '');
      blocks.push(
        group.collapsed
          ? `<section id="${id}"><details><summary><h2>${title}</h2></summary>${rest}</details></section>`
          : `<section id="${id}"><h2>${title}</h2>${rest}</section>`,
      );
      links.push(
        `<li${alert ? ' class="alert"' : ''}><a href="#${id}">${title.replace(/<[^>]*>/g, '').trim()}</a></li>`,
      );
    }
    if (blocks.length === 0) continue;
    const groupId = `group-${bodyGroups.length + 1}`;
    tocGroups.push(
      `<li><a class="toc-group" href="#${groupId}">${esc(group.title)}</a>${links.length > 0 ? `<ul>${links.join('')}</ul>` : ''}</li>`,
    );
    bodyGroups.push(
      `<div class="group" id="${groupId}"><div class="group-title">${esc(group.title)}</div>${group.hint ? `<p class="muted group-hint">${esc(group.hint)}</p>` : ''}${blocks.join('\n')}</div>`,
    );
  }
  return {
    toc: `<nav class="toc" aria-label="${esc(contents)}"><div class="toc-title">${esc(contents)}</div><ul>${tocGroups.join('')}</ul></nav>`,
    body: bodyGroups.join('\n'),
  };
}
