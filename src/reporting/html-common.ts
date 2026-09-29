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
  // Un zéro reste neutre : seules les valeurs non nulles portent la couleur de leur gravité.
  const accent = color && value !== 0 ? color : undefined;
  const style = accent ? ` style="--accent:${accent}"` : '';
  return `<div class="card${color ? ' accent' : ''}${value === 0 ? ' zero' : ''}"${style}><div class="label">${esc(label)}</div><div class="value">${esc(String(value))}</div></div>`;
}

/** Carte du total des anomalies, avec leur répartition par gravité en barre (vide quand il n'y en a aucune). */
export function issuesCard(
  label: string,
  counts: Record<Severity, number>,
  severityLabel: (value: string) => string,
): string {
  const order: Severity[] = ['CRITICAL', 'ERROR', 'WARNING', 'INFO'];
  const total = order.reduce((sum, severity) => sum + counts[severity], 0);
  const segments = order
    .filter((severity) => counts[severity] > 0)
    .map(
      (severity) =>
        `<span style="flex:${counts[severity]};background:${SEVERITY_COLORS[severity]}" title="${esc(severityLabel(severity))} : ${counts[severity]}"></span>`,
    )
    .join('');
  return `<div class="card issues${total === 0 ? ' zero' : ''}"><div class="label">${esc(label)}</div><div class="value">${total}</div><div class="sevbar">${segments}</div></div>`;
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
  :root {
    color-scheme:light dark;
    --bg:#f4f6fb; --card:#fff; --text:#0f172a; --muted:#64748b; --line:#e6e9f0; --soft:#f8fafc; --soft-line:#e2e8f0;
    --link:#2563eb; --accent:#4f46e5; --ok:#15803d; --ok-bg:#f0fdf4; --ok-line:#bbf7d0;
    --shadow:0 1px 2px rgba(15,23,42,.04), 0 2px 8px rgba(15,23,42,.05); --radius:12px;
    --head-from:#0f172a; --head-to:#312e81;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0a0f1c; --card:#111827; --text:#e5e7eb; --muted:#94a3b8; --line:#1f2a3c; --soft:#172033; --soft-line:#2a3850;
      --link:#93c5fd; --accent:#a5b4fc; --ok:#4ade80; --ok-bg:#0f2a1c; --ok-line:#14532d;
      --shadow:0 1px 2px rgba(0,0,0,.3); --head-from:#020617; --head-to:#1e1b4b;
    }
    .card.accent:not(.zero) .value { filter:brightness(1.5); }
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; font:14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased; }
  a { color:var(--link); text-underline-offset:2px; }
  code, pre { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { font-size:12px; }

  header { background:linear-gradient(135deg, var(--head-from), var(--head-to)); color:#fff; }
  .hero { max-width:1500px; margin:0 auto; padding:28px 32px 26px; }
  .eyebrow { font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:#a5b4fc; }
  .hero-title { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin:4px 0 10px; }
  header h1 { margin:0; font-size:26px; font-weight:700; letter-spacing:-.01em; }
  .hero-desc { margin:0 0 10px; color:#cbd5e1; max-width:900px; }
  .status { display:inline-flex; align-items:center; gap:6px; padding:4px 12px 4px 10px; border-radius:999px; font-weight:700; font-size:12px; color:#fff; background:var(--status,#15803d); box-shadow:0 0 0 3px rgba(255,255,255,.12); }
  .status::before { content:''; width:8px; height:8px; border-radius:50%; background:#fff; opacity:.9; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { display:inline-flex; gap:5px; align-items:center; padding:3px 10px; border-radius:999px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.14); color:#e2e8f0; font-size:12px; max-width:100%; overflow-wrap:anywhere; }
  .chip > span { color:#a5b4fc; }
  .chip.url { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .links { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
  .links a { color:#e0e7ff; text-decoration:none; font-size:12px; font-weight:600; padding:6px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.18); }
  .links a:hover { background:rgba(255,255,255,.1); }
  .links a.primary { background:#fff; color:#1e1b4b; border-color:#fff; }
  header .meta { color:#cbd5e1; font-size:13px; word-break:break-all; }
  header nav:not(.links) a { color:#93c5fd; margin-right:14px; font-size:13px; }

  body > main { max-width:1240px; margin:0 auto; padding:24px 16px 48px; }
  .layout { display:grid; grid-template-columns:240px minmax(0,1fr); gap:24px; max-width:1500px; margin:0 auto; padding:24px 16px 48px; }
  .summary { grid-column:1 / -1; }
  main { min-width:0; }

  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:12px; }
  .card { position:relative; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:14px 16px; box-shadow:var(--shadow); overflow:hidden; }
  .card.accent:not(.zero)::before { content:''; position:absolute; inset:0 auto 0 0; width:4px; background:var(--accent); }
  .card.accent:not(.zero) .value { color:var(--accent); }
  .card .label { color:var(--muted); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
  .card .value { font-size:28px; font-weight:750; line-height:1.2; margin-top:4px; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
  .card.zero .value { color:var(--muted); opacity:.7; }
  .cards.secondary { grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); margin-bottom:0; }
  .cards.secondary .card { padding:10px 14px; box-shadow:none; background:transparent; }
  .cards.secondary .value { font-size:18px; margin-top:2px; }
  .cards.secondary .card.zero .value { opacity:1; }
  .sevbar { display:flex; gap:2px; height:6px; margin-top:8px; border-radius:999px; overflow:hidden; background:var(--soft); }

  .toc { position:sticky; top:16px; align-self:start; max-height:calc(100vh - 32px); overflow-y:auto; font-size:13px; padding:14px 12px; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); }
  .toc-title { font-weight:700; margin:0 6px 8px; }
  .toc ul { list-style:none; margin:0; padding:0; }
  .toc ul ul { margin:2px 0 10px; }
  .toc a { display:flex; justify-content:space-between; align-items:center; gap:8px; color:var(--text); text-decoration:none; padding:4px 8px; border-radius:6px; }
  .toc a:hover { background:var(--soft); color:var(--accent); }
  .toc a.toc-group { font-weight:700; color:var(--muted); text-transform:uppercase; font-size:10.5px; letter-spacing:.08em; margin-top:8px; }
  .toc li.alert > a { color:#dc2626; font-weight:600; }

  .count { display:inline-block; min-width:20px; padding:0 7px; border-radius:999px; background:var(--soft); border:1px solid var(--soft-line); color:var(--muted); font-size:11px; font-weight:700; line-height:18px; text-align:center; vertical-align:middle; font-variant-numeric:tabular-nums; }
  .count.alert { background:#dc2626; border-color:#dc2626; color:#fff; }
  .count.zero { opacity:.6; }

  .group { margin-bottom:12px; scroll-margin-top:16px; }
  .group-title { display:flex; align-items:center; gap:12px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin:10px 0 12px; }
  .group-title::after { content:''; flex:1; height:1px; background:var(--line); }
  .group-hint { margin:-6px 0 12px; font-size:13px; }

  section { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:18px 22px; margin-bottom:16px; overflow-x:auto; scroll-margin-top:16px; box-shadow:var(--shadow); }
  h2 { font-size:16px; font-weight:700; margin:0 0 14px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; letter-spacing:-.005em; }
  h3 { font-size:14px; font-weight:700; margin:18px 0 8px; }
  section > details > summary { list-style:none; display:flex; align-items:center; gap:10px; margin:-4px -8px; padding:4px 8px; border-radius:8px; }
  section > details > summary:hover { background:var(--soft); }
  section > details > summary::-webkit-details-marker { display:none; }
  section > details > summary::before { content:''; width:7px; height:7px; border-right:2px solid var(--muted); border-bottom:2px solid var(--muted); transform:rotate(-45deg); transition:transform .15s; flex:none; }
  section > details[open] > summary::before { transform:rotate(45deg); }
  section > details > summary h2 { margin:0; }
  section > details[open] > summary { margin-bottom:12px; }

  table { width:100%; border-collapse:separate; border-spacing:0; font-size:13px; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; background:var(--soft); position:sticky; top:0; white-space:nowrap; }
  thead th:first-child { border-top-left-radius:8px; } thead th:last-child { border-top-right-radius:8px; }
  tbody tr:last-child > td { border-bottom:none; }
  tbody tr:hover > td { background:var(--soft); }
  td.wrap { word-break:break-word; }

  .sev { display:inline-block; padding:1px 9px; border-radius:999px; color:#fff; font-size:11px; font-weight:700; letter-spacing:.02em; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; background:#eef2ff; color:#3730a3; font-size:11px; font-weight:600; margin:1px; letter-spacing:.02em; }
  .pill.PASSED, .pill.SUCCESS, .pill.HANDLED { background:#dcfce7; color:#166534; }
  .pill.DETECTED { background:#dbeafe; color:#1e40af; }
  .pill.UNSUPPORTED { background:#f1f5f9; color:#475569; }
  .pill.FAILED, .pill.DANGEROUS { background:#fee2e2; color:#991b1b; }
  .pill.BLOCKED, .pill.MUTATION { background:#fef3c7; color:#92400e; }
  .pill.MANUAL { background:#fef3c7; color:#92400e; }
  .pill.SKIPPED, .pill.UNKNOWN { background:#f1f5f9; color:#475569; }
  .pill.CHANGED, .pill.UNREACHABLE, .pill.ACTION_MISSING { background:#fde2e1; color:#9f1239; }
  .SAFE, .SUCCESS { background:#dcfce7; } .MUTATION { background:#fef3c7; } .DANGEROUS, .BLOCKED { background:#fee2e2; } .UNKNOWN { background:#e5e7eb; } .FAILED { background:#fde68a; }

  .flow-run { margin-bottom:18px; }
  .flow-run h3 { margin:0 0 6px; font-size:15px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .suggest { margin-top:6px; color:var(--text); }
  .suggest pre { margin:4px 0 0; padding:6px 8px; background:#fff7e6; color:#1f2937; border:1px solid #f0c36d; border-radius:6px; white-space:pre-wrap; word-break:break-all; font-size:12px; }
  pre.diff { margin:4px 0 10px; padding:10px 12px; background:var(--soft); border:1px solid var(--soft-line); border-radius:8px; font-size:12px; white-space:pre-wrap; }
  pre.network { margin:4px 0 0; padding:4px 6px; background:var(--soft); border-radius:4px; font-size:11px; white-space:pre-wrap; word-break:break-all; }
  .muted { color:var(--muted); }
  .empty { color:var(--muted); font-style:normal; margin:0; padding:10px 14px; border:1px dashed var(--soft-line); border-radius:8px; background:var(--soft); }
  .empty.ok { color:var(--ok); background:var(--ok-bg); border:1px solid var(--ok-line); font-weight:600; }
  .empty.ok::before { content:'✓'; margin-right:8px; }
  .flow { font-size:12px; color:var(--muted); }
  .flow b { color:var(--text); font-weight:600; }
  details summary { cursor:pointer; }

  .tree, .tree ul { list-style:none; margin:0; padding-left:18px; }
  .tree { padding-left:0; }
  .tree li { position:relative; padding:3px 0 3px 14px; border-left:1px solid var(--soft-line); }
  .tree li:last-child { border-left-color:transparent; }
  .tree li::before { content:''; position:absolute; left:0; top:0; height:14px; width:12px; border-bottom:1px solid var(--soft-line); border-left:1px solid var(--soft-line); margin-left:-1px; }
  .tree > li { border-left:none; padding-left:0; } .tree > li::before { display:none; }
  .via { display:inline-block; font-size:11px; color:#1d4ed8; background:#eff6ff; border-radius:999px; padding:0 8px; }

  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; }
  .shots figure { margin:0; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--card); transition:box-shadow .15s, transform .15s; }
  .shots figure:hover { box-shadow:0 6px 20px rgba(15,23,42,.12); transform:translateY(-2px); }
  .shots img { width:100%; display:block; aspect-ratio:16/10; object-fit:cover; object-position:top; background:#fff; border-bottom:1px solid var(--line); }
  .shots figcaption { padding:8px 10px; font-size:12px; word-break:break-all; color:var(--muted); }
  .shots figcaption b { color:var(--text); }
  .report-footer { margin-top:24px; font-size:12px; text-align:center; }

  @media (max-width: 900px) {
    .hero { padding:20px 16px; }
    header h1 { font-size:21px; }
    .layout { display:block; padding:16px 12px 40px; }
    .summary { margin-bottom:16px; }
    .toc { position:static; max-height:none; margin-bottom:16px; }
    .toc > ul { columns:2; column-gap:16px; }
    .toc > ul > li { break-inside:avoid; }
    section { padding:14px 12px; }
    th { position:static; }
    table { min-width:600px; }
    .card .value { font-size:24px; }
  }
  @media (max-width: 520px) { .toc > ul { columns:1; } }
  @media print {
    :root { --bg:#fff; --card:#fff; --text:#111; --muted:#555; --line:#ddd; --soft:#f5f5f5; --soft-line:#ddd; --shadow:none; }
    header { background:#fff; color:#111; border-bottom:2px solid #111; }
    .hero { padding:0 0 12px; }
    .chip { color:#111; border-color:#bbb; background:none; }
    .eyebrow, .chip > span { color:#555; }
    header nav, .links, .toc { display:none; }
    .layout { display:block; padding:0; }
    section { border:none; padding:8px 0; overflow:visible; box-shadow:none; }
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
      // « Titre (3) » : le nombre devient un badge, rouge quand la section signale des anomalies.
      const counted = /^([\s\S]*?)\s*\((\d+)\)\s*$/.exec(head[1] ?? '');
      const badge = counted
        ? ` <span class="count${alert ? ' alert' : counted[2] === '0' ? ' zero' : ''}">${counted[2]}</span>`
        : '';
      const title = (counted ? counted[1] : head[1]) ?? '';
      const rest = html.slice(head[0].length).replace(/<\/section>$/, '');
      blocks.push(
        group.collapsed
          ? `<section id="${id}"><details><summary><h2>${title}${badge}</h2></summary>${rest}</details></section>`
          : `<section id="${id}"><h2>${title}${badge}</h2>${rest}</section>`,
      );
      links.push(
        `<li${alert ? ' class="alert"' : ''}><a href="#${id}"><span>${title.replace(/<[^>]*>/g, '').trim()}</span>${badge}</a></li>`,
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
