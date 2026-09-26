import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CrawlResult } from '../model/crawl-result.js';
import { SEVERITIES, type Issue, type Severity } from '../model/issue.js';
import type { PageResult } from '../model/page-result.js';
import type { Reporter } from './reporter.js';

/** reports/index.html — a static, self-contained report (no JavaScript, no external assets). */
export class HtmlReporter implements Reporter {
  readonly format = 'html';

  constructor(
    private readonly directory: string,
    private readonly screenshotsDir: string,
    private readonly fileName = 'index.html',
  ) {}

  async write(result: CrawlResult): Promise<string> {
    const target = path.join(this.directory, this.fileName);
    await writeFile(
      target,
      renderHtml(result, (file) => this.relativeScreenshot(file)),
      'utf8',
    );
    return target;
  }

  /** Screenshot path relative to the report, so the report folder and screenshots can be published together. */
  private relativeScreenshot(file: string): string {
    const relative = path.relative(this.directory, path.resolve(file));
    return relative.split(path.sep).map(encodeURIComponent).join('/');
  }
}

const SEVERITY_COLORS: Record<Severity, string> = {
  INFO: '#2563eb',
  WARNING: '#b45309',
  ERROR: '#dc2626',
  CRITICAL: '#7f1d1d',
};

export function renderHtml(
  result: CrawlResult,
  screenshotHref: (file: string) => string = (file) => file,
): string {
  const bySeverity = [...result.issues].sort(
    (a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.id.localeCompare(b.id),
  );
  const httpIssues = bySeverity.filter((issue) =>
    ['HTTP', 'REQUEST_FAILED', 'BROKEN_LINK'].includes(issue.type),
  );
  const jsIssues = bySeverity.filter((issue) => ['CONSOLE', 'PAGE_ERROR', 'PAGE_CRASH'].includes(issue.type));
  const navigationIssues = bySeverity.filter((issue) => issue.type === 'NAVIGATION');
  const screenshots = result.pages.filter((page) => page.screenshot);
  const status = overallStatus(result);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA Crawler — ${esc(result.scenario)}</title>
<style>
  :root { --bg:#f5f7fa; --card:#fff; --text:#1f2937; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:var(--bg); color:var(--text); }
  header { background:#0f172a; color:#fff; padding:24px 32px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  header .meta { color:#cbd5e1; font-size:13px; word-break:break-all; }
  main { max-width:1200px; margin:0 auto; padding:24px 16px 48px; }
  .status { display:inline-block; margin-top:10px; padding:3px 10px; border-radius:999px; font-weight:600; font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .value { font-size:24px; font-weight:700; }
  .card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin-bottom:20px; }
  h2 { font-size:16px; margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  td.wrap { word-break:break-word; }
  .sev { display:inline-block; padding:1px 8px; border-radius:999px; color:#fff; font-size:11px; font-weight:700; }
  .pill { display:inline-block; padding:1px 7px; border-radius:6px; background:#eef2ff; font-size:11px; margin:1px; }
  .SAFE { background:#dcfce7; } .MUTATION { background:#fef3c7; } .DANGEROUS { background:#fee2e2; } .UNKNOWN { background:#e5e7eb; }
  .muted { color:var(--muted); }
  .empty { color:var(--muted); font-style:italic; }
  details summary { cursor:pointer; color:#1d4ed8; }
  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; }
  .shots figure { margin:0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fff; }
  .shots img { width:100%; display:block; aspect-ratio:16/10; object-fit:cover; object-position:top; }
  .shots figcaption { padding:6px 8px; font-size:12px; word-break:break-all; }
  code { font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>${esc(result.scenario)}</h1>
  <div class="meta">${esc(result.target.startUrl)} · ${esc(formatDate(result.startedAt))} · ${esc(formatDuration(result.durationMs))}</div>
  ${result.description ? `<div class="meta">${esc(result.description)}</div>` : ''}
  <span class="status" style="background:${status.color}">${esc(status.label)}</span>
</header>
<main>
  <div class="cards">
    ${card('Pages visited', result.pagesVisited)}
    ${card('Issues', result.issues.length)}
    ${SEVERITIES.slice()
      .reverse()
      .map((severity) => card(severity, result.stats.issuesBySeverity[severity], SEVERITY_COLORS[severity]))
      .join('')}
    ${card('HTTP errors', httpIssues.length)}
    ${card('JS errors', jsIssues.length)}
    ${card('Routes', result.routes.length)}
    ${card('Duration', formatDuration(result.durationMs))}
  </div>
  ${result.maxPagesReached ? `<section class="muted">maxPages reached: ${result.pendingUrls} URL(s) were still queued. Increase <code>exploration.maxPages</code> to explore further.</section>` : ''}

  ${issueSection('HTTP errors & broken links', httpIssues, true)}
  ${issueSection('JavaScript errors', jsIssues, false)}
  ${navigationIssues.length > 0 ? issueSection('Navigation problems', navigationIssues, true) : ''}

  <section>
    <h2>Pages (${result.pages.length})</h2>
    ${pagesTable(result.pages, result.issues, screenshotHref)}
  </section>

  <section>
    <h2>Discovered actions</h2>
    <p class="muted">Classified by the safety policy. Only ${esc(allowedClasses(result))} actions may be executed automatically;
    ${result.stats.actionsExecuted} action(s) were executed during this run.</p>
    <div>${Object.entries(result.stats.actionsByClassification)
      .map(
        ([classification, count]) =>
          `<span class="pill ${esc(classification)}">${esc(classification)}: ${count}</span>`,
      )
      .join(' ')}</div>
    ${result.pages
      .filter((page) => page.actions.length > 0 || page.forms.length > 0)
      .map((page) => actionDetails(page))
      .join('')}
  </section>

  <section>
    <h2>Screenshots (${screenshots.length})</h2>
    ${
      screenshots.length === 0
        ? '<p class="empty">No screenshots were captured.</p>'
        : `<div class="shots">${screenshots
            .map((page) => {
              const href = esc(screenshotHref(page.screenshot ?? ''));
              return `<figure><a href="${href}"><img loading="lazy" src="${href}" alt="${esc(page.url)}"></a><figcaption>#${page.sequence} ${esc(page.url)}</figcaption></figure>`;
            })
            .join('')}</div>`
    }
  </section>

  <section>
    <h2>Routes</h2>
    <table><thead><tr><th>Route pattern</th><th>URLs visited</th></tr></thead><tbody>
    ${result.routes.map((route) => `<tr><td class="wrap"><code>${esc(route.route)}</code></td><td>${route.visited}</td></tr>`).join('')}
    </tbody></table>
    ${
      Object.keys(result.stats.linksSkipped).length > 0
        ? `<p class="muted">Links not followed: ${Object.entries(result.stats.linksSkipped)
            .map(([reason, count]) => `${esc(reason)} (${count})`)
            .join(', ')}</p>`
        : ''
    }
  </section>
  <p class="muted">Generated by qa-crawler · ${esc(formatDate(result.finishedAt))}</p>
</main>
</body>
</html>
`;
}

function card(label: string, value: number | string, color?: string): string {
  const style = color ? ` style="color:${color}"` : '';
  return `<div class="card"><div class="value"${style}>${esc(String(value))}</div><div class="label">${esc(label)}</div></div>`;
}

function severityBadge(severity: Severity): string {
  return `<span class="sev" style="background:${SEVERITY_COLORS[severity]}">${severity}</span>`;
}

function issueSection(title: string, issues: Issue[], withRequest: boolean): string {
  if (issues.length === 0) {
    return `<section><h2>${esc(title)}</h2><p class="empty">None detected.</p></section>`;
  }
  const rows = issues
    .map(
      (issue) => `<tr>
        <td>${severityBadge(issue.severity)}</td>
        <td>${esc(issue.type)}</td>
        ${withRequest ? `<td>${issue.status ?? ''}</td><td class="wrap">${esc([issue.method, issue.requestUrl].filter(Boolean).join(' '))}</td>` : ''}
        <td class="wrap">${esc(issue.message)}</td>
        <td class="wrap">${issue.pages
          .slice(0, 5)
          .map((page) => esc(page))
          .join(
            '<br>',
          )}${issue.pages.length > 5 ? `<br><span class="muted">+${issue.pages.length - 5} more</span>` : ''}</td>
        <td>${issue.occurrences}</td>
      </tr>`,
    )
    .join('');
  return `<section><h2>${esc(title)} (${issues.length})</h2><table><thead><tr>
    <th>Severity</th><th>Type</th>${withRequest ? '<th>Status</th><th>Request</th>' : ''}<th>Message</th><th>Pages</th><th>Count</th>
  </tr></thead><tbody>${rows}</tbody></table></section>`;
}

function pagesTable(pages: PageResult[], issues: Issue[], screenshotHref: (file: string) => string): string {
  if (pages.length === 0) return '<p class="empty">No page was visited.</p>';
  const severityOf = new Map(issues.map((issue) => [issue.id, issue.severity]));
  const rows = pages
    .map((page) => {
      const worst = page.issueIds
        .map((id) => severityOf.get(id))
        .filter((severity): severity is Severity => severity !== undefined)
        .sort((a, b) => SEVERITIES.indexOf(b) - SEVERITIES.indexOf(a))[0];
      return `<tr>
        <td>${page.sequence}</td>
        <td class="wrap">${esc(page.url)}${page.finalUrl ? `<br><span class="muted">→ ${esc(page.finalUrl)}</span>` : ''}${page.error ? `<br><span class="muted">${esc(page.error)}</span>` : ''}</td>
        <td class="wrap"><code>${esc(page.route)}</code></td>
        <td>${page.status ?? (page.failed ? 'failed' : '')}</td>
        <td class="wrap">${esc(page.title ?? '')}</td>
        <td>${page.depth}</td>
        <td>${page.loadTimeMs} ms</td>
        <td>${page.issueIds.length > 0 && worst ? `${severityBadge(worst)} ${page.issueIds.length}` : '0'}</td>
        <td>${page.screenshot ? `<a href="${esc(screenshotHref(page.screenshot))}">view</a>` : ''}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr><th>#</th><th>URL</th><th>Route</th><th>Status</th><th>Title</th><th>Depth</th><th>Load</th><th>Issues</th><th>Screenshot</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function actionDetails(page: PageResult): string {
  const actions = page.actions
    .map(
      (action) =>
        `<tr><td><span class="pill ${esc(action.classification)}">${esc(action.classification)}</span></td><td>${esc(action.type)}</td><td class="wrap">${esc(action.text || '(no label)')}</td><td class="wrap">${esc(action.href ?? action.routerLink ?? action.selector)}</td><td class="wrap muted">${esc(action.reason)}</td></tr>`,
    )
    .join('');
  const forms = page.forms
    .map(
      (form) =>
        `<li>${form.index >= 0 ? `Form #${form.index + 1}` : 'Fields outside a form'} (${esc(form.method.toUpperCase())}${form.isSearchForm ? ', search' : ''}) — ${form.fields
          .map(
            (field) =>
              `<code>${esc(field.name ?? field.elementId ?? field.label ?? field.type)}</code> ${esc(field.type)}${field.required ? ' <b>required</b>' : ''}${constraints(field)}`,
          )
          .join(', ')}</li>`,
    )
    .join('');
  return `<details><summary>#${page.sequence} ${esc(page.url)} — ${page.actions.length} action(s), ${page.forms.length} form(s)</summary>
    ${actions ? `<table><thead><tr><th>Class</th><th>Type</th><th>Label</th><th>Target</th><th>Reason</th></tr></thead><tbody>${actions}</tbody></table>` : ''}
    ${forms ? `<ul>${forms}</ul>` : ''}
  </details>`;
}

function constraints(field: PageResult['forms'][number]['fields'][number]): string {
  const parts = [
    field.min !== undefined ? `min=${field.min}` : '',
    field.max !== undefined ? `max=${field.max}` : '',
    field.minLength !== undefined ? `minlength=${field.minLength}` : '',
    field.maxLength !== undefined ? `maxlength=${field.maxLength}` : '',
    field.pattern !== undefined ? `pattern` : '',
  ].filter(Boolean);
  return parts.length > 0 ? ` <span class="muted">(${esc(parts.join(', '))})</span>` : '';
}

function allowedClasses(result: CrawlResult): string {
  const safety = result.settings.safety as { allowedActionClasses?: string[] } | undefined;
  return (safety?.allowedActionClasses ?? ['SAFE']).join(', ');
}

function overallStatus(result: CrawlResult): { label: string; color: string } {
  const counts = result.stats.issuesBySeverity;
  if (counts.CRITICAL > 0) return { label: 'CRITICAL issues found', color: SEVERITY_COLORS.CRITICAL };
  if (counts.ERROR > 0) return { label: 'Errors found', color: SEVERITY_COLORS.ERROR };
  if (counts.WARNING > 0) return { label: 'Warnings only', color: SEVERITY_COLORS.WARNING };
  return { label: 'No issues', color: '#15803d' };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function formatDate(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** HTML-escapes text and attribute values. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
