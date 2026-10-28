import type { EnvironmentCheck, ExecutionRecord } from '../core/contracts.js';
import type { DashboardStrings } from './dashboard-i18n.js';
import { esc } from './view.js';

/**
 * LES PIÈCES COMMUNES DES ÉCRANS DU DASHBOARD : pastilles de statut, icônes, en-tête d'écran, dates,
 * tableau des exécutions. Des fonctions pures, de l'état vers le HTML échappé.
 */
const TONE: Record<string, string> = {
  PASSED: 'ok',
  PASS: 'ok',
  COMPLETED: 'ok',
  ACTIVE: 'ok',
  READY: 'ok',
  FAILED: 'ko',
  FAIL: 'ko',
  NOT_READY: 'ko',
  CANCELLED: 'mu',
  INCOMPLETE: 'warn',
  BLOCKED: 'warn',
  INCONCLUSIVE: 'warn',
  RUNNING: 'live',
  QUEUED: 'mu',
  SKIPPED: 'mu',
  NO_FLOW: 'mu',
  ARCHIVED: 'mu',
  UNKNOWN: 'mu',
  VALIDATION_REQUIRED: 'warn',
  PARTIAL: 'warn',
  COMPLETED_WITH_WARNINGS: 'warn',
  PENDING: 'mu',
  CONFIRMED: 'ok',
  PROPOSED: 'warn',
  REJECTED: 'mu',
  PAUSED: 'warn',
};

export const pill = (raw: string, text = raw): string =>
  `<span class="pill ${TONE[raw] ?? 'mu'}">${esc(text)}</span>`;

const ICONS: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  projects: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  executions: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  pause:
    '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  requirements: '<path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h11M9 8h6"/>',
  traceability:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.5 6.5l7 4.5M8.5 17.5l7-4.5"/>',
  sources: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3"/>',
  indicators: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  trends: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  recordings:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
  access: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1"/>',
  library: '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M16.5 4.5l3.5 1-4 15-3.5-1z"/>',
  scenarios:
    '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  explorations: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  environments:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export const icon = (name: string): string =>
  `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

/** L'heure seule, à la seconde : le fil d'une session en cours. */
export function formatTime(iso: string, locale: 'fr' | 'en'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(locale === 'fr' ? 'fr-FR' : 'en-GB', { timeStyle: 'medium' });
}

export function formatDate(iso: string, locale: 'fr' | 'en'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * L'en-tête d'un écran. `title` est déjà échappé (il porte des pastilles) ; `back` : le retour
 * (`data-to`) et son libellé.
 */
export function header(
  title: string,
  options: { sub?: string; actions?: string; back?: [string, string] } = {},
): string {
  const back = options.back
    ? `<button class="back" data-action="back" data-to="${esc(options.back[0])}">${icon('back')}<span>${esc(options.back[1])}</span></button>`
    : '';
  return `<header class="hd"><div class="hd-t">${back}<h1>${title}</h1>${options.sub ? `<p class="sub">${options.sub}</p>` : ''}</div><div class="acts">${options.actions ?? ''}</div></header>`;
}

export function executionTable(
  t: DashboardStrings,
  rows: (ExecutionRecord & { projectName?: string })[],
  withProject: boolean,
): string {
  const head = [
    ...(withProject ? [t.col.project] : []),
    t.col.kind,
    t.col.verdict,
    t.col.flows,
    t.col.issues,
    t.col.environment,
    t.col.date,
  ];
  return `<div class="tw"><table class="tbl"><thead><tr>${head.map((cell) => `<th scope="col">${esc(cell)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${withProject ? `<td>${esc(row.projectName ?? row.projectId)}</td>` : ''}<td>${esc(t.kinds[row.kind] ?? row.kind)}</td><td>${pill(row.verdict, t.verdicts[row.verdict] ?? row.verdict)}</td><td>${String(row.flows.passed)}/${String(row.flows.total)}</td><td>${String(row.issues)}</td><td>${esc(row.environment?.name ?? '—')}</td><td><button class="lnk" data-action="open-run" data-project="${esc(row.projectId)}" data-run="${esc(row.run)}">${esc(formatDate(row.createdAt, t.locale))}</button></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

/** Ce qu'un environnement dit de lui-même une fois vérifié : prêt ou non, et pourquoi. */
export function readiness(check: EnvironmentCheck | undefined): 'READY' | 'NOT_READY' | 'UNKNOWN' {
  if (!check) return 'UNKNOWN';
  const secrets = Object.values(check.secrets).every(Boolean);
  const url = check.url?.reachable ? check.url.reachable.ok : true;
  return check.ok && secrets && url ? 'READY' : 'NOT_READY';
}

export function readinessPill(t: DashboardStrings, check: EnvironmentCheck | undefined): string {
  const status = readiness(check);
  const text =
    status === 'READY'
      ? t.readiness.ready
      : status === 'NOT_READY'
        ? t.readiness.notReady
        : t.readiness.unknown;
  return pill(status, text);
}

export function checkLines(t: DashboardStrings, check: EnvironmentCheck | undefined): string {
  if (!check) return '';
  const lines = [
    ...check.issues.map((issue) => `<li class="ko">${icon('cross')}<span>${esc(issue.message)}</span></li>`),
    ...Object.entries(check.secrets).map(([name, present]) =>
      present
        ? `<li class="ok">${icon('check')}<span>${esc(t.secretPresent(name))}</span></li>`
        : `<li class="ko">${icon('cross')}<span>${esc(t.secretMissing(name))}</span></li>`,
    ),
    ...(check.url?.reachable
      ? [
          check.url.reachable.ok
            ? `<li class="ok">${icon('check')}<span>${esc(t.urlAnswers)}</span></li>`
            : `<li class="ko">${icon('cross')}<span>${esc(t.urlDown(check.url.reachable.message ?? String(check.url.reachable.status ?? '')))}</span></li>`,
        ]
      : []),
  ];
  return lines.length > 0 ? `<ul class="checks">${lines.join('')}</ul>` : '';
}
